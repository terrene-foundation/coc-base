#!/usr/bin/env node
/**
 * orphan-reap.mjs — report, and optionally reap, orphaned CPU-burning harness
 * shells left behind by a session that died without running its cleanup.
 *
 * THE INCIDENT. 2026-08-14: a CPU-saturation load test left 96 orphaned
 * `/bin/zsh` busy-loops on this host (two cohorts of 48, one per worktree),
 * PPID 1, 7–15% CPU each, for 22 hours, with the host load peaking at 577 on 16
 * cores. The script's `kill $BURNERS; echo "burners killed"` was the last
 * STATEMENT rather than a `trap`, so it never ran in any invocation. They
 * destroyed no work — what they did was silently corrupt every timing-sensitive
 * measurement taken on the host for a day and a half. Post-mortem:
 * `workspaces/runtime-enforcement-2026-08-14/01-analysis/03-burner-leak-postmortem.md`.
 *
 * DEFAULT IS REPORT-ONLY. `--apply` performs kills. There is deliberately no
 * `--force`: every safety gate lives in the classifier and none of them can be
 * waived from the command line.
 *
 * REAP ONLY THE PROVABLY-INERT; REPORT EVERYTHING ELSE. A deliberately-detached
 * long-running process — a dev server someone wanted to survive — also has
 * PPID 1. So ZERO-LOSS requires POSITIVE evidence of inertness (age past the
 * floor, no children, an active CPU burn, and no held file/socket descriptors);
 * everything else is a named KEEP carrying its reasons. Killing on the bare
 * orphan predicate is BLOCKED — it would eventually eat wanted work and then be
 * switched off, which is how a gate dies.
 *
 * SCOPED TO THE PROVABLY-INERT CLASS ONLY, which is what keeps it clear of
 * `orchestration-launch-ledger.md` MUST-4: killing a DISCOVERED LIVE WRITER is
 * a human gate, and a live writer is by construction not in this class — it
 * holds descriptors, or has children, or is not burning CPU. Each of those is
 * an independent KEEP.
 *
 * usage:
 *   node .claude/bin/orphan-reap.mjs                    # report
 *   node .claude/bin/orphan-reap.mjs --json             # machine-readable
 *   node .claude/bin/orphan-reap.mjs --apply            # terminate ZERO-LOSS
 *   node .claude/bin/orphan-reap.mjs --min-age-hours 6  # stricter idle floor
 *
 * exit codes: 0 = ran; 1 = could not measure (ps unavailable — NOT "no orphans");
 *             2 = --apply attempted a kill that failed (loud, never swallowed);
 *             64 = a floor was REFUSED (a non-numeric or below-minimum
 *                  --min-age-hours / --min-cpu-pct, or such a value in the
 *                  environment), returned BEFORE the process table is read;
 *             77 = --apply was REFUSED because this process runs as ROOT (there is
 *                  no pidfd here, so a re-read→kill race as root can signal any
 *                  process on the host); a report-only run as root is still allowed.
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isMainModule } from "./lib/entry-point.mjs";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const {
  KEEP,
  REAP,
  DEFAULT_MIN_AGE_HOURS,
  DEFAULT_MIN_CPU_PCT,
  MIN_AGE_HOURS_FLOOR,
  MIN_CPU_PCT_FLOOR,
  isOrphanCandidate,
  validateFloorValue,
  resolveMinAgeHoursStrict,
  resolveMinCpuPctStrict,
  signallablePidProblem,
  credentialsRefusalReason,
  readCredentials,
  rootRefusalReason,
  EXIT_NOPERM,
  classifyOrphans,
  censusProcesses,
  collectOpenFiles,
  hostLoad,
  hostMemory,
  memoryHealthLine,
} = require(join(HERE, "..", "hooks", "lib", "orphan-forest.js"));

// THE ONE hardened JSONL-append primitive (`hooks/lib/append-sink.js`): symlink- and
// hard-link-refusing, O_NOFOLLOW at open, mode-repairing — one implementation shared
// by every `.claude/` sink writer, per its own header. Imported here rather than
// re-implemented for the census-denial ledger below (rules/security.md §
// Enforcement-Surface Parity).
const { appendSinkLine } = require(join(HERE, "..", "hooks", "lib", "append-sink.js"));

// `sysexits.h`'s EX_USAGE. Distinct from BOTH existing non-zero codes because the
// three mean different things and a caller that only reads the status must not be
// able to confuse them: 1 is "ran but could not measure", 2 is "ran and a kill
// failed", 64 is "did not run at all — the arguments were refused".
const EXIT_USAGE = 64;

/**
 * BOUNDED census retry schedule for the SIGKILL re-check (orchestrator ruling,
 * 2026-10-01). On a census failure the DISPOSITION is a refusal — never a signal on
 * an identity and ownership that cannot be verified at that moment — because the
 * harms are ASYMMETRIC: killing a process that is not ours is irreversible and lands
 * on someone else's work (including the pid-reuse case the whole batch exists to
 * close), while a surviving hider is REPORTED, costs CPU, and can be retried or
 * handled by a human. The retry is what keeps the refusal from being the FIRST
 * resort; the bound is what keeps a hostile censor from stalling this loop forever.
 * Each entry is the wait BEFORE the next attempt; the schedule length is therefore
 * the number of RETRIES, and total attempts = 1 + length.
 */
const CENSUS_RETRY_BACKOFF_MS = [100, 250, 500];

/**
 * THE PERSISTED COUNT OF CENSUS-DENIAL REFUSALS. A refusal nobody can count is
 * indistinguishable from a hider that got away, so every refusal this run records
 * through `logRefusal` lands here as one JSONL row (`.claude/learning/` is the
 * per-repo gitignored STATE sink; the append goes through the ONE hardened sink
 * primitive, `hooks/lib/append-sink.js`, so containment/mode/O_NOFOLLOW come with
 * it). It is written on a best-effort basis at the CLI layer only — the reaper
 * itself stays free of disk side effects.
 *
 * IDENTITY STAMPING: UNSIGNED BY NAMED CHOICE, NOT BY OMISSION (orchestrator
 * confirmation, 2026-10-01). `knowledge-convergence.md` MUST-6 requires the signed
 * identity triple (`verified_id` + `person_id` + detached `sig`) for appends to
 * `.claude/learning/observations.jsonl` and `.claude/learning/violations.jsonl` —
 * those two BY NAME — because those logs feed the cumulative-violation count behind
 * trust-posture downgrade math. THIS IS A THIRD FILE in the same directory: outside
 * that clause's literal scope, and its rows feed NO posture math — they are
 * unsigned operational counters (pid, last-known command/etime/uid, census error,
 * attempts). `appendSinkLine` writes each line verbatim; stamping is the PRODUCER's
 * job, and this producer deliberately does not. If a future consumer ever feeds
 * these rows into violation counting, the signature becomes mandatory FIRST.
 */
const ORPHAN_REFUSAL_SINK_REL = ".claude/learning/orphan-reap-refusals.jsonl";

function usage() {
  return [
    "orphan-reap.mjs — report/reap orphaned CPU-burning harness shells",
    "",
    "usage: node .claude/bin/orphan-reap.mjs [options]",
    "",
    "  --apply               terminate ZERO-LOSS orphans (default: report only)",
    "  --json                machine-readable output",
    `  --min-age-hours <N>   idle floor before an orphan is reapable (default ${DEFAULT_MIN_AGE_HOURS}, minimum ${MIN_AGE_HOURS_FLOOR})`,
    `  --min-cpu-pct <N>     CPU burn floor; below it an orphan is KEEP (default ${DEFAULT_MIN_CPU_PCT}, minimum ${MIN_CPU_PCT_FLOOR})`,
    "                        (either floor also takes the `--flag=<N>` spelling)",
    "  --<unknown>           REFUSED: an argument this parser does not recognise is a",
    "                        usage error, never silently ignored",
    "  --help, -h            this message",
    "",
    "Both floors are also read from the environment as COC_ORPHAN_MIN_AGE_HOURS",
    "and COC_ORPHAN_MIN_CPU_PCT.",
    "",
    "A floor that is not a plain decimal number, or that sits below its minimum, is",
    `REFUSED (exit ${EXIT_USAGE}) before the process table is read, so nothing is measured`,
    "and nothing is killed. It is NEVER silently replaced by the default: a floor",
    "the operator did not choose and was not told about is not a floor.",
    "",
    "A ZERO-LOSS verdict requires ALL of: past the idle floor, no child",
    "processes, an active CPU burn, and no held file/socket descriptors.",
    "Anything else is KEEP, with every reason reported.",
  ].join("\n");
}

/**
 * Parse argv into options, carrying any floor REFUSAL out rather than absorbing it.
 *
 * WHAT THIS REPLACES, and why it is not a tightening of the same idea. The previous
 * form was `const n = Number(argv[++i]); if (Number.isFinite(n) && n >= 0) o.minAgeHours = n;`
 * — a malformed flag was SILENTLY DROPPED, so the run proceeded on the default
 * floor and the operator's instruction vanished with no message. `Number()` also
 * accepts `""`, `"  "`, `"0x1f"` and `"Infinity"`. Both halves are refused now, and
 * the refusal is RETURNED so `main()` can stop before it reads anything.
 *
 * The environment is resolved FIRST and a refusal there refuses the run even when a
 * flag is also given: the guard resolves the same two variables on its own, so a
 * run whose floor disagreed with the guard's would be two answers to one question.
 */
function parseArgs(argv) {
  const o = {
    apply: false,
    json: false,
    help: false,
    minAgeHours: null,
    minCpuPct: null,
    refusal: null,
  };
  const refuse = (reason) => {
    // FIRST refusal wins: it is the one nearest the cause and the one the operator
    // sees, and a later flag cannot overwrite the reason the run is being stopped.
    if (!o.refusal) o.refusal = reason;
  };

  const envAge = resolveMinAgeHoursStrict(process.env);
  const envCpu = resolveMinCpuPctStrict(process.env);
  if (!envAge.ok) {
    refuse(`the environment sets ${envAge.key}=${JSON.stringify(envAge.raw)} — ${envAge.reason}`);
  } else {
    o.minAgeHours = envAge.value;
  }
  if (!envCpu.ok) {
    refuse(`the environment sets ${envCpu.key}=${JSON.stringify(envCpu.raw)} — ${envCpu.reason}`);
  } else {
    o.minCpuPct = envCpu.value;
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // `--flag=value` IS ACCEPTED, and an unrecognised argument is REFUSED.
    //
    // MEASURED before this branch existed: `--min-age-hours=24` matched neither
    // arm below, fell through the loop unremarked, and the 2h default applied — so
    // an operator who explicitly asked for a 24h floor got a 2h one and a 3h
    // victim was KILLED. The unknown-argument DROP is the defect; the `=` spelling
    // was one instance of it, and any other unparsed token was the same hazard.
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq === -1 ? a : a.slice(0, eq);
    const inline = eq === -1 ? undefined : a.slice(eq + 1);

    if (name === "--apply" || name === "--json" || name === "--help" || name === "-h") {
      if (inline !== undefined) {
        refuse(`${name} takes no value — got ${JSON.stringify(a)}`);
        continue;
      }
      if (name === "--apply") o.apply = true;
      else if (name === "--json") o.json = true;
      else o.help = true;
      continue;
    }

    if (name === "--min-age-hours" || name === "--min-cpu-pct") {
      const isAge = name === "--min-age-hours";
      // `--flag=value` supplies the value inline; the space form takes the next
      // token. A missing value is REFUSED rather than defaulted, in both spellings.
      const raw = inline !== undefined ? inline : argv[i + 1];
      const v = validateFloorValue(raw === undefined ? "" : String(raw), {
        floor: isAge ? MIN_AGE_HOURS_FLOOR : MIN_CPU_PCT_FLOOR,
        label: name,
      });
      if (!v.ok) refuse(`${name} was refused — ${v.reason}`);
      else if (isAge) o.minAgeHours = v.value;
      else o.minCpuPct = v.value;
      // Consume the separate value slot only for the space form, so
      // `--min-age-hours --apply` cannot silently read `--apply` as a floor (it is
      // refused above instead).
      if (inline === undefined) i++;
      continue;
    }

    refuse(`unrecognised argument ${JSON.stringify(a)} — see --help for the accepted set`);
  }
  return o;
}

/**
 * PURE. Did this pid become a DIFFERENT process between the classification and
 * the kill? Returns a reason string when the identity moved, or null when the two
 * readings are the same process.
 *
 * WHY NOT A START TIME, since the header above used to promise one. The census
 * reads `pid,ppid,etime,pcpu,command` and no start-time column exists to compare:
 * macOS `ps` rejects GNU's `etimes` (see `orphan-forest.js`'s header), and the
 * keywords that DO carry a start time are locale-formatted strings ("Wed Jun 22
 * 12:00:00 2022"), which would make the identity check depend on the host's
 * locale. So the binding uses two fields the record already carries, and for the
 * stated threat — a RECYCLED pid — they are just as tight:
 *   - the COMMAND must be byte-identical: a recycled pid is a different process,
 *     and this tool only ever reaps harness shells, so an argv match is a strong
 *     identity claim rather than a weak one;
 *   - the AGE must not go BACKWARDS: `etime` is monotonic for one process, while a
 *     recycled pid is seconds old by construction and the classified one had
 *     already cleared the idle floor (≥ 1h, MEASURED at the floor resolver).
 * Together: a pid that is a fresh harness-shell orphan cannot pass, because its
 * age is near zero; a pid that is the same process cannot fail, because neither
 * its argv nor its age moves. The comment in `reap()` now states this instead of
 * the start-time claim it could not keep.
 */
function identityDrift(record, live) {
  if (!live) return "the pid is gone";
  if (live.command !== record.command) {
    return `the command line changed (${JSON.stringify(renderDriftCommand(record.command))} → ${JSON.stringify(renderDriftCommand(live.command))})`;
  }
  if (!Number.isFinite(live.etimeSec)) return "the live age is unreadable";
  if (!Number.isFinite(record.etimeSec)) return "the classified age is unreadable";
  if (live.etimeSec < record.etimeSec) {
    return `the age went BACKWARDS (${record.etimeSec}s → ${live.etimeSec}s)`;
  }
  return null;
}

/**
 * Render a command for the drift message so the two DIFFERING parts stay visible.
 * The previous form sliced both to 40 leading chars, and a harness shell's
 * per-session id lives LATE in the argv (`…/shell-snapshots/snapshot-zsh-…`) — so
 * two different shells whose ids differ after byte 40 rendered `"X" → "X"`, which
 * reads as NOTHING CHANGED in the one message whose whole job is to say it changed
 * (F6, adversarial review 2026-10-01). HEAD AND TAIL: the head names the
 * interpreter, the tail carries the varying id, and the middle elides with its size
 * stated — so a difference AFTER byte 22 lands in the printed tail instead of inside
 * a silent cut. The property is bounded and stated rather than absolute: two
 * commands differing ONLY inside the elided middle still render identically
 * (correctness review 2026-10-01 measured the collision for equal-length inputs
 * differing at the elision — an earlier revision of THIS comment claimed they never
 * could, which the render does not hold; the elided-size marker is what keeps the
 * residual honest).
 */
function renderDriftCommand(c) {
  const s = String(c);
  if (s.length <= 48) return s;
  return `${s.slice(0, 22)}…[${s.length - 42} chars elided]…${s.slice(-20)}`;
}

/**
 * Terminate the ZERO-LOSS set. SIGTERM first, then SIGKILL only for what
 * survives — seven of the 96 in the incident needed SIGKILL, so a TERM-only
 * pass would have reported success while leaving burners running.
 *
 * RE-VERIFIED BEFORE EACH KILL, AND THE RE-CHECK IS AN IDENTITY CHECK, not just a
 * predicate one. Between the ps snapshot and this call a pid can exit and be
 * REUSED, and killing a recycled pid is the one way this tool could destroy
 * something. So each pid is re-read from the live table and must STILL satisfy the
 * orphan predicate AND still be the SAME PROCESS it was classified as —
 * byte-identical command, age that has not gone backwards (see `identityDrift`;
 * the earlier comment here claimed "the same start time" while the code compared
 * nothing but the predicate, so a recycled pid that was ITSELF an orphaned harness
 * shell passed and was killed). Anything that no longer matches is skipped and
 * reported.
 */
// `signallablePidProblem` now lives in `orphan-forest.js` and is re-exported here:
// ONE predicate for every signalling site in the tree. It moved when a SECOND
// signalling site (`.claude/bin/hook-dispatch-equivalence.mjs`) needed the same
// refusal — a second inline copy is exactly how the two would drift.

/**
 * PURE. Did this pid stop being OUR process between the census and the kill?
 *
 * THE RE-CHECK IS THE POINT, and the ownership re-read is what the earlier identity
 * re-check could not cover: `identityDrift` proves the pid is the SAME process, but
 * "same process" is not "our process". A uid can change (a setuid binary, a
 * login-as-another-user shell) and the census-time owner is evidence only until the
 * next syscall. So the LIVE row's uid must equal our effective uid NOW.
 */
function ownershipDrift(record, live, euid) {
  if (!Number.isInteger(euid)) {
    return "our own uid could not be read, so ownership cannot be confirmed at kill time";
  }
  if (!Number.isInteger(live.uid)) return "the live uid is unreadable";
  if (live.uid !== euid) {
    return `it is now owned by uid ${live.uid}, not ours (${euid})`;
  }
  if (Number.isInteger(record.uid) && record.uid !== live.uid) {
    return `the owner changed since the census (uid ${record.uid} → ${live.uid})`;
  }
  return null;
}

function reap(records, opts = {}) {
  const kill = opts.kill || process.kill.bind(process);
  const recheck = opts.recheck || (() => censusProcesses());
  const sleep = opts.sleep || ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  // INJECTABLE SO THE CORE STAYS DISK-FREE: tests drive it with a collector and the
  // CLI wires it to the persisted sink (see `main` and `ORPHAN_REFUSAL_SINK_REL`).
  const logRefusal = typeof opts.logRefusal === "function" ? opts.logRefusal : null;
  // Injectable so a case can drive the root-refusal and the ownership arms without
  // changing the process's real privilege — which no test may do.
  //
  // ⛔ THE OWN UID IS DERIVED FROM THE GUARDED CREDENTIAL READ, NOT READ RAW. This line
  // used to call `process.geteuid()` directly, and that function DOES NOT EXIST on every
  // platform (win32 exposes neither `geteuid` nor `getuid`): the absence arrived as a
  // TypeError raised out of the kill path, escaping the very refusal arm below that
  // exists to say "the platform cannot tell us whether we are root". A throw at a
  // signalling site is the failure this file's guards are built to prevent, so the uid
  // now comes from the SAME read the root refusal uses — one source, so the uid the
  // ownership re-check compares against cannot disagree with the credential the refusal
  // judged. An absent function therefore becomes the STATED unknown, and an unknown uid
  // is refused at kill time by `ownershipDrift` rather than signalled on.
  const injected = opts.euid !== undefined;
  const selfPid = opts.selfPid === undefined ? process.pid : opts.selfPid;

  const targets = records.filter((r) => r.verdict === REAP);
  const killed = [];
  const failed = [];
  if (!targets.length) return { killed, failed };

  // A SEAM WITHOUT A KILL SEAM IS REFUSED, and this is a CORRECTNESS RULE rather than
  // hygiene: a caller that feeds a fabricated process table — via `parsePsTable` on
  // text it wrote, or a census with an injected exec — and then lets the REAL kill run
  // is a caller that signals a real pid on the strength of a fake reading. The
  // provenance is stamped by the collector, so this cannot be forgotten by a caller:
  // only the census that spawned the TRUSTED tool marks "live".
  const notLive = targets.filter((r) => r.provenance !== "live");
  if (notLive.length && opts.kill === undefined) {
    throw new Error(
      `refusing to reap: ${notLive.length} record(s) did not come from a trusted census (${notLive
        .slice(0, 3)
        .map((r) => `pid ${r.pid} provenance=${JSON.stringify(r.provenance)}`)
        .join(", ")}) and no kill seam was injected — a fabricated table with a real kill is how a test signals a real process`,
    );
  }

  // ROOT IS REFUSED HERE AS WELL AS IN `main()`, and the duplication is deliberate:
  // `main()` gates the CLI, this gates the KILL PATH. A future caller that reaches
  // `reap()` without going through `main()` — a new command, a test harness, a
  // consumer importing it — must not be able to signal as root either. Per-target
  // refusals rather than one whole-run refusal, so every record still carries its
  // own reason.
  // EVERY CREDENTIAL, not just the effective uid: an injected `euid` synthesizes a
  // credential set where the whole family is that value, which is what the existing
  // root cases drive; the real path reads the platform's own sources.
  const credentials =
    opts.credentials ||
    (injected
      ? { ok: true, real: opts.euid, effective: opts.euid, saved: opts.euid, fs: null, capEff: null }
      : readCredentials({ platform: opts.platform }));
  // THE SAME SET DECIDES BOTH, and that is the point of reading it here rather than at
  // the top: the uid `ownershipDrift` compares against is the one this refusal judged.
  // An unreadable credential yields `undefined`, which is NOT an integer and is refused
  // by that arm — never silently replaced by a value nobody read.
  const euid = injected ? opts.euid : credentials.ok ? credentials.effective : undefined;
  const rootReason = credentialsRefusalReason(credentials);
  if (rootReason) {
    for (const r of targets) {
      failed.push({ pid: r.pid, reason: `REFUSED as root — ${rootReason}` });
    }
    return { killed, failed };
  }

  const live = recheck();
  const byPid = new Map();
  for (const p of Array.isArray(live) ? live : []) byPid.set(p.pid, p);

  const termed = [];
  for (const r of targets) {
    // THE PID GUARD RUNS FIRST, BEFORE ANY OTHER CHECK, so no later arm can reach a
    // signal for a pid this refuses.
    const pidProblem = signallablePidProblem(r.pid, selfPid);
    if (pidProblem) {
      failed.push({ pid: r.pid, reason: `REFUSED by the pid guard — ${pidProblem}` });
      continue;
    }
    const now = byPid.get(r.pid);
    if (!now) {
      failed.push({ pid: r.pid, reason: "vanished before the kill — nothing to do" });
      continue;
    }
    if (!isOrphanCandidate(now)) {
      // The pid was recycled, or it acquired a real parent. Either way it is no
      // longer the process that was classified, and the verdict does not carry.
      failed.push({ pid: r.pid, reason: "no longer matches the orphan predicate — pid likely reused" });
      continue;
    }
    const drift = identityDrift(r, now);
    if (drift) {
      // It IS an orphaned harness shell — but not the SAME one. This is the arm
      // the old code did not have, and it is the one that matters: a recycled pid
      // that is itself an orphan passes a predicate-only re-check and gets killed.
      failed.push({ pid: r.pid, reason: `pid is a DIFFERENT process — ${drift} (recycled pid?)` });
      continue;
    }
    const owner = ownershipDrift(r, now, euid);
    if (owner) {
      failed.push({ pid: r.pid, reason: `REFUSED at kill time — ${owner}` });
      continue;
    }
    try {
      kill(r.pid, "SIGTERM");
      termed.push(r.pid);
    } catch (e) {
      failed.push({ pid: r.pid, reason: `SIGTERM failed: ${e.code || e.message}` });
    }
  }

  if (termed.length) {
    sleep(500);
    // ⛔ THE SIGKILL PASS RE-CONSULTS THE TABLE — IT USED NOT TO, AND THE GUARDS IT
    // CARRIED INSTEAD COULD NOT FIRE. The 500ms above is a REAL window in which a TERMed
    // pid can exit and be RECYCLED, and SIGKILL is the one signal here that cannot be
    // walked back. The two `signallablePidProblem(pid, selfPid)` calls this loop used to
    // carry were DEAD ARMS: the function is PURE over (pid, selfPid), and every pid in
    // `termed` already passed the IDENTICAL call on the way in (the entry guard above,
    // same const `selfPid`, same iterated pid) — identical arguments, identical result,
    // BY CONSTRUCTION. MEASURED, not argued: deleting both arms left the suite at
    // 77 tests / 77 pass, identical to baseline, and the adversarial refuter's
    // counterfactual confirms the ABSENCE behind them — `recheckCalls: 1`, and a second
    // census showing a foreign-owned different-argv process produced the IDENTICAL
    // report, because the second census was never taken. A dead guard standing under a
    // comment claiming it works is how the next reader stops looking, so the arms are
    // GONE and this comment says what actually runs.
    //
    // WHAT RUNS INSTEAD is the standard this tree's sibling already sets
    // (`run-harness-suites.mjs::killDescendantTree` takes a FRESH census immediately
    // before its kill loop and re-checks identity + ownership before every SIGKILL):
    // a fresh census here, and `identityDrift` + `ownershipDrift` against the row each
    // pid was CLASSIFIED as — because "the same process" is not "our process". The
    // liveness probe below still runs first and still delivers nothing (`kill(pid, 0)`
    // is a question, not a signal). MEASURED counterfactual: with this re-read in place,
    // a second census showing a recycled pid makes the arm REFUSE — `recheckCalls: 2`,
    // `killed: []`, reason "the command line changed".
    // BOUNDED RETRIES WITH BACKOFF, THEN THE REFUSAL — the ORDER is the safety
    // property. On a census failure the disposition is REFUSAL: never send a signal to
    // a process whose identity and ownership cannot be verified at that moment. The
    // harms are asymmetric — killing a process that is not ours is irreversible and
    // lands on someone else's work (the pid-reuse case this whole mechanism exists to
    // close), while a surviving hider is REPORTED, costs CPU, and can be retried or
    // handled by a human. The bounded retry schedule
    // (`CENSUS_RETRY_BACKOFF_MS`) is what keeps the refusal from being the FIRST
    // resort; the bound keeps a hostile censor from stalling the loop forever. Every
    // failed attempt is captured with its error so the refusal can NAME why.
    const censusErrors = [];
    let liveAgain = null;
    let censusAttempts = 0;
    for (let attempt = 0; attempt <= CENSUS_RETRY_BACKOFF_MS.length; attempt++) {
      if (attempt > 0) sleep(CENSUS_RETRY_BACKOFF_MS[attempt - 1]);
      censusAttempts++;
      try {
        const got = recheck();
        if (Array.isArray(got)) {
          liveAgain = got;
          break;
        }
        censusErrors.push(
          got === null
            ? "the census returned no table (null)"
            : `the census returned a NON-ARRAY (${typeof got})`,
        );
      } catch (e) {
        censusErrors.push((e && e.code) || (e && e.message) || "unknown error");
      }
    }
    const censusErrorSummary = censusErrors.length
      ? [...new Set(censusErrors)].join("; ")
      : "none";
    const byPidAgain = Array.isArray(liveAgain)
      ? new Map(liveAgain.map((p) => [p.pid, p]))
      : null;
    const recordByPid = new Map(targets.map((r) => [r.pid, r]));
    for (const pid of termed) {
      let alive = true;
      try {
        kill(pid, 0);
      } catch {
        alive = false;
      }
      if (!alive) {
        killed.push(pid);
        continue;
      }
      if (byPidAgain === null) {
        // LOUD, NAMED, AND COUNTABLE. The refusal names the pid, its LAST-KNOWN
        // identity, and the census error — and the CLI layer persists each one as a
        // JSONL row (`ORPHAN_REFUSAL_SINK_REL`), because a refusal nobody can count
        // is indistinguishable from a hider that got away.
        const rec = recordByPid.get(pid);
        const identity = rec
          ? `last-known identity: ${JSON.stringify(renderDriftCommand(rec.command))} ` +
            `(etime ${rec.etimeSec}s, uid ${rec.uid})`
          : "last-known identity: unavailable";
        failed.push({
          pid,
          reason:
            `the census is unavailable before SIGKILL after ${censusAttempts} attempt(s) ` +
            `(${censusErrorSummary}) — ${identity}; refusing to signal blind`,
        });
        if (typeof logRefusal === "function") {
          logRefusal({
            ts: new Date().toISOString(),
            kind: "census-unavailable-before-SIGKILL",
            pid,
            last_known: rec
              ? { command: String(rec.command), etime_sec: rec.etimeSec, uid: rec.uid }
              : null,
            attempts: censusAttempts,
            census_error: censusErrorSummary,
          });
        }
        continue;
      }
      const nowAgain = byPidAgain.get(pid);
      if (!nowAgain) {
        failed.push({ pid, reason: "vanished before SIGKILL — nothing to do" });
        continue;
      }
      const drift = identityDrift(recordByPid.get(pid), nowAgain);
      if (drift) {
        failed.push({ pid, reason: `pid is a DIFFERENT process — ${drift} (recycled pid?)` });
        continue;
      }
      const owner = ownershipDrift(recordByPid.get(pid), nowAgain, euid);
      if (owner) {
        failed.push({ pid, reason: `REFUSED before SIGKILL — ${owner}` });
        continue;
      }
      try {
        kill(pid, "SIGKILL");
        killed.push(pid);
      } catch (e) {
        failed.push({ pid, reason: `survived SIGTERM and SIGKILL failed: ${e.code || e.message}` });
      }
    }
  }
  return { killed, failed };
}

/**
 * THE CLI'S ONE DISK SIDE EFFECT, WIRED SO ITS FAILURE REPORT SURVIVES.
 *
 * `reap()` stays disk-free; this wrapper is the only place the census-denial ledger is
 * appended to. THE MERGE IS THE WHOLE POINT, and it repairs a real defect BOTH review
 * lenses found independently on 2026-10-02 (correctness by executing an A/B, security by
 * reading): the first wiring destructured `({ killed, failed } = reap(records, {
 * logRefusal }))` WHILE the callback closed over the `failed` binding — the RHS, and
 * every callback run inside it, completes BEFORE the destructuring rebinds `failed` to
 * reap()'s returned array, so every "NOT persisted" push landed in the pre-call array
 * and never reached a consumer. MEASURED by the correctness reviewer with the real
 * `reap()` and real `appendSinkLine` (seams injected, no real signal): as-written
 * warning-surfaces=false, corrected=true. The wrapper therefore collects sink failures
 * into ITS OWN array and merges them into the array it RETURNS — the one the JSON
 * envelope, the human report and the exit code all read.
 *
 * `reapFn` and `appendFn` are seams so the WIRING ITSELF is testable: the block this
 * replaces was unreachable by the suite by design (it signals real pids), which is how
 * the defect survived 77/77 — a fix without a pole for the plumbing is the same state
 * one commit later. The pole lives in the guard suite and was mutation-verified.
 */
function reapWithSinkLogging(
  records,
  { reapFn = reap, appendFn = appendSinkLine, repoDir = join(HERE, "..", "..") } = {},
) {
  const sinkRefusals = [];
  const result = reapFn(records, {
    logRefusal: (record) => {
      let res = null;
      try {
        res = appendFn({
          repoDir,
          sinkPath: join(repoDir, ORPHAN_REFUSAL_SINK_REL),
          line: JSON.stringify(record),
        });
      } catch (e) {
        res = { ok: false, error: (e && e.code) || (e && e.message) || "unknown error" };
      }
      if (!res || res.ok !== true) {
        sinkRefusals.push({
          pid: record.pid,
          reason:
            `the census-denial refusal was NOT persisted (${(res && (res.error || res.reason)) || "unknown"}) — ` +
            "this refusal will be missing from the accountability log; fix the sink before relying on the count",
        });
      }
    },
  });
  return { killed: result.killed, failed: [...(result.failed || []), ...sinkRefusals] };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(usage() + "\n");
    return 0;
  }

  // A refused floor stops the run HERE — before `ps`, before the classifier, and
  // therefore before any signal can be sent. The order is the safety property, not
  // an accident of layout: a run that measured first and refused second would have
  // already paid for a process table it is not allowed to act on, and any future
  // edit that moves the kill path above this line reintroduces a reap at a floor
  // nobody chose. `--apply` is deliberately NOT special-cased: the refusal is the
  // same refusal whether or not a kill was requested, so `--json` callers (the
  // SessionEnd guard among them) get one shape to branch on.
  if (opts.refusal) {
    const msg = `orphan-reap: ${opts.refusal}. Refused rather than substituting a floor: nothing was measured and nothing was killed.`;
    if (opts.json) process.stdout.write(JSON.stringify({ ok: false, reason: msg }) + "\n");
    else process.stderr.write(msg + "\n");
    return EXIT_USAGE;
  }

  // ROOT IS REFUSED BEFORE ANYTHING IS READ, and only when a kill is requested: a
  // report-only run signals nothing, so it stays available as root (that is how an
  // operator inspects a host they own). The refusal is a PRIVILEGE refusal, not a
  // usage error, so it carries its own exit code — a caller that branches on the
  // status must be able to tell "your floor is bad" from "you are root".
  if (opts.apply) {
    const rootReason = credentialsRefusalReason(readCredentials());
    if (rootReason) {
      const msg = `orphan-reap: ${rootReason}.`;
      if (opts.json) process.stdout.write(JSON.stringify({ ok: false, reason: msg }) + "\n");
      else process.stderr.write(msg + "\n");
      return EXIT_NOPERM;
    }
  }

  const processes = censusProcesses();
  if (processes === null) {
    // NULL IS NOT AN EMPTY TABLE. Reporting "0 orphans" from an unreadable
    // process table would be a non-discriminating instrument returning the
    // all-clear — the exact failure this program exists to eliminate.
    const msg = "orphan-reap: could not read the process table; orphan status UNKNOWN (not zero)";
    if (opts.json) process.stdout.write(JSON.stringify({ ok: false, reason: msg }) + "\n");
    else process.stderr.write(msg + "\n");
    return 1;
  }

  // The cheap short-circuit: lsof is only spawned for CANDIDATES, and on a
  // healthy host there are none, so the common case costs exactly one `ps`.
  const candidatePids = processes.filter(isOrphanCandidate).map((p) => p.pid);
  const openFiles = candidatePids.length ? collectOpenFiles(candidatePids) : {};

  // ⛔ THE GATE'S ARMING UID COMES FROM THE GUARDED CREDENTIAL READ, for the reason the
  // kill path gives at length: `process.geteuid` is absent on win32, and the raw call
  // that stood here raised a TypeError out of `main()` — before the classifier could
  // report anything — on the one platform where the operator would most want the report.
  //
  // AN UNREADABLE CREDENTIAL ARRIVES HERE AS **ABSENT**, NOT AS A SUBSTITUTE, and that is
  // the classifier's own fail-closed arming test rather than a convention invented here:
  // a non-integer `selfUid` leaves the ownership gate UN-ARMED, which KEEPs every
  // candidate and says so on the record. It is deliberately NOT "carry on with no gate" —
  // `security.md` § Secure-Default forbids a silent no-op default for exactly this shape.
  // `--apply` never reaches this line on such a host: it is refused earlier by the root
  // check, which reads the same credentials.
  const ownCred = readCredentials();
  const selfUid = ownCred.ok && Number.isInteger(ownCred.effective) ? ownCred.effective : undefined;

  const { records, counts } = classifyOrphans({
    processes,
    openFiles,
    minAgeHours: opts.minAgeHours,
    minCpuPct: opts.minCpuPct,
    // THE OWNERSHIP GATE IS ARMED FROM HERE. The classifier is pure and takes the
    // uid as a parameter; the CLI supplies the process's real effective uid, so a
    // candidate belonging to another user can never reach ZERO-LOSS.
    selfUid,
  });

  let killed = [];
  let failed = [];
  if (opts.apply) {
    // THE ONE DISK SIDE EFFECT, WIRED AT THE CLI LAYER ONLY (`reap()` itself stays
    // disk-free). The wrapper exists because the straightforward inline wiring was
    // WRONG — see `reapWithSinkLogging` for the defect and the merge that repairs it.
    ({ killed, failed } = reapWithSinkLogging(records));
  }

  const load = hostLoad();
  const mem = hostMemory();
  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          applied: opts.apply,
          counts,
          killed,
          failed,
          load,
          mem,
          min_age_hours: opts.minAgeHours,
          min_cpu_pct: opts.minCpuPct,
          orphans: records,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    const out = [];
    out.push(
      `Orphaned harness shells: ${counts.candidates} candidate(s) — ${counts.zero_loss} ZERO-LOSS, ${counts.keep} KEEP` +
        ` (floors: age ${opts.minAgeHours}h, CPU ${opts.minCpuPct}%)`,
    );
    if (load) {
      out.push(`Host load: ${load.one.toFixed(2)} / ${load.five.toFixed(2)} / ${load.fifteen.toFixed(2)} over ${load.cpus || "?"} cores`);
    }
    const memLine = memoryHealthLine(mem);
    if (memLine) out.push(`Host memory: ${memLine}`);
    for (const r of records) {
      out.push(
        `  [${r.verdict}] pid ${r.pid}  age ${r.ageHours === null ? "?" : r.ageHours.toFixed(1) + "h"}  cpu ${r.pcpu === null ? "?" : r.pcpu.toFixed(1) + "%"}`,
      );
      for (const why of r.reasons) out.push(`      ${why}`);
    }
    if (opts.apply) {
      out.push(`Terminated: ${killed.length ? killed.join(", ") : "none"}`);
      for (const f of failed) out.push(`  FAILED pid ${f.pid}: ${f.reason}`);
    } else if (counts.zero_loss) {
      out.push(`Re-run with --apply to terminate the ${counts.zero_loss} ZERO-LOSS orphan(s).`);
    }
    process.stdout.write(out.join("\n") + "\n");
  }

  // A failed kill on an --apply run is LOUD. Exit 2 rather than 0 so a caller
  // that only checks the status code cannot read a partial pass as a clean one.
  return opts.apply && failed.length ? 2 : 0;
}

// ENTRY-POINT CHECK, and it is a FIX rather than plumbing. MEASURED before it
// existed: importing this module RAN the reaper — it read the live process table,
// printed the whole human report to STDOUT (so a consumer importing `reap` for its
// own use got a report it never asked for on a stream it may be piping), and set
// `process.exitCode`. `isMainModule` is the ONE check the shipped bin tools use
// (`.claude/bin/lib/entry-point.mjs`, on `ALWAYS_INCLUDE`), and every shipped CLI
// here is meant to carry it; this one did not.
if (isMainModule(import.meta.url)) {
  process.exitCode = main();
}

export { reap, reapWithSinkLogging, parseArgs, identityDrift, ownershipDrift, signallablePidProblem, rootRefusalReason, EXIT_NOPERM };
