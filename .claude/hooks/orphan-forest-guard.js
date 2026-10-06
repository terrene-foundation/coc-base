#!/usr/bin/env node
/**
 * orphan-forest-guard.js — the boundary detector and ACTOR for orphaned
 * CPU-burning harness shells.
 *
 * SessionStart REPORTS (and surfaces host load). SessionEnd REAPS the
 * provably-inert and reports what it did.
 *
 * @hook-event: SessionStart (lifecycle) — the subject is a leak that is LIVE
 *   RIGHT NOW, left by some earlier session. A boundary reaper at session END
 *   structurally cannot see it: the leak outlives the session that made it, and
 *   the next session is the first moment anyone is present to be told. The
 *   incident ran 22 hours precisely because nothing occupied this slot. It also
 *   carries the host-load line, which is the only surface that catches a leak
 *   nobody has classified yet.
 * @hook-event: SessionEnd (lifecycle) — the subject is what THIS session leaves
 *   behind, which is only final once no further tool call can spawn. Fires
 *   exactly once, so it is free.
 *
 * NOT PreToolUse(Bash), and that is a REJECTION rather than an omission. The
 * obvious detector is a regex on `&`-without-`trap`, and it was deliberately not
 * built as the fence: `&` is ubiquitous so the false-positive surface is large,
 * a noisy advisory gets ignored, and per `hook-output-discipline.md` MUST-2 a
 * LEXICAL signal MUST NOT carry `block` — so it could not stop anything even
 * when it was right. It would be a control ADJACENT to the one needed, which is
 * the exact failure shape this program exists to eliminate.
 *
 * SEVERITY — `advisory` at both events, never `block`, per
 * `hook-output-discipline.md` MUST-2.
 *
 *   The signal here IS structural, not lexical: it is read from `ps` and `lsof`,
 *   and no rewording of any command can evade it. By MUST-2's letter a
 *   structural signal MAY carry `block`. It does not, for two reasons. At
 *   SessionStart the finding concerns a leak some OTHER session left, so
 *   blocking this session's first turn would punish the wrong party. At
 *   SessionEnd there is nothing left to block. The structural signal therefore
 *   buys CONFIDENCE IN THE NUMBER — the report states counts as fact — and the
 *   teeth live in the reap, not in a refusal.
 *
 * IT KILLS AT SessionEnd ONLY, AND ONLY WHAT CANNOT LOSE WORK. This file
 * contains no kill code: it spawns `orphan-reap.mjs --apply`, and that script
 * owns every gate — the idle floor, the CPU-burn floor, the no-children
 * requirement, the no-held-descriptors requirement, and a re-verification of
 * the orphan predicate immediately before each signal so a RECYCLED pid is
 * never killed. `--force` does not exist to pass. A deliberately-detached
 * process (a dev server someone wanted to survive) is PPID 1 too, and is held
 * out by at least one of those gates — usually all of them.
 *
 * KILL SWITCH: `COC_ORPHAN_AUTOREAP=0` (also `off`/`false`/`no`/`disabled`)
 * disables the unattended reap and falls back to report-only, which then says
 * it is disabled. DEFAULT ON; an unrecognised value stays ON rather than
 * silently shipping the feature inert.
 *
 * AS ROOT, THE REAP DOES NOT RUN AT ALL — and the refusal is reported HERE, before
 * the reaper is spawned, because a child that refuses itself and a host with nothing
 * to reap produce the same silence. Without an fd-pinned pid there is no way to bind
 * "the pid I checked" to "the pid I signal", so as root a lost race can signal ANY
 * process on the host; an unattended reaper has no need for that privilege. The
 * predicate is SHARED with the reaper (`orphan-forest.js::rootRefusalReason`), so
 * the child's refusal and this one cannot drift apart.
 *
 * A REFUSED FLOOR ALSO SKIPS THE REAP — and REPORTS that it did, at BOTH events.
 * `COC_ORPHAN_MIN_AGE_HOURS` / `COC_ORPHAN_MIN_CPU_PCT` are resolved strictly
 * before anything is measured: an unusable value (`0`, `0.5`, a typo) stops the
 * reap rather than being replaced by the default, because a substituted floor is
 * one the operator believes is in force and is not. The refusal is NOT silent, and
 * that is the deliberate asymmetry with an unreadable process table — `null` means
 * UNMEASURED and stays quiet, a refusal means the operator has a variable to fix
 * and is never folded into that silence. Advisory, never `block`.
 *
 * SHIPS EVERYWHERE, DELIBERATELY. `.claude/hooks/**` and `.claude/hooks/lib/**`
 * are on `sync-tier-aware.mjs::ALWAYS_INCLUDE`, and `.claude/bin/orphan-reap.mjs`
 * is added to that list's bin allowlist in the same change — so the tool this
 * hook names resolves at every consumer rather than being a dangling reference.
 * The predicate is portable because the shell-snapshot signature is a CLAUDE
 * CODE convention, not a loom one: it carries no repo name and no user name.
 * The leak bit other projects, so a loom-only reaper would not have closed it.
 *
 * FAIL-OPEN. Every error path emits `{continue:true}` and exits 0/1. A detector
 * that can wedge a session is worse than the leak it reports.
 */

const path = require("path");
const { execFileSync } = require("child_process");
const { emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js"));
const {
  isOrphanCandidate,
  resolveAutoReap,
  resolveMinAgeHoursStrict,
  resolveMinCpuPctStrict,
  MIN_AGE_HOURS_FLOOR,
  MIN_CPU_PCT_FLOOR,
  censusProcesses,
  collectOpenFiles,
  classifyOrphans,
  hostLoad,
  loadIsNotable,
  hostHealthLine,
  hostHealthReportLines,
  credentialsRefusalReason,
  readCredentials,
  rootRefusalReason,
  hostMemory,
  memoryIsNotable,
  reportLines,
  reapReportLines,
  summarize,
} = require(path.join(__dirname, "lib", "orphan-forest.js"));

// cc-artifacts.md Rule 7 — a stdin-stall fallback that never hangs the session.
// Exit 1 (not 0) so a fired timeout is distinguishable from a normal passthrough
// in exit-code logs.
//
// WHAT THIS DOES AND DOES NOT BOUND. It is cleared on stdin `end`, BEFORE
// `run()` is called, and `run()` is synchronous — a `setTimeout` cannot
// interrupt an `execFileSync`, because the timer callback is only delivered once
// the stack unwinds. So this bounds the WAIT FOR STDIN and nothing else. The
// real ceilings are the per-subprocess timeouts in `orphan-forest.js`
// (ps 3s, lsof 5s) and the reap subprocess budget below, sized against the
// `timeout` on each settings.json registration.
//
// Armed inside hookMain() (never at load), so require() of this file schedules
// nothing — the engine requires it once per worker and runs hookMain per event.
const TIMEOUT_MS = 10000;

// The reap spawns one `ps`, at most one `lsof`, and then signals. Measured on
// the incident host: `ps -axo` over 1,358 processes and a single-pid `lsof` at
// 0.048s. 20s is a hang ceiling, not an expected cost.
const REAP_TIMEOUT_MS = 20000;

function passthrough() {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

/**
 * Spawn the reaper with `--apply`. DELEGATED, NOT REIMPLEMENTED: a second kill
 * path here would be a second lineage that drifts from the classifier's gates —
 * the `security.md` § Multi-Site Kwarg Plumbing failure mode. This module can
 * only ever be as dangerous as the flags it passes, and it passes no floor
 * override and no `--force`.
 *
 * Spawned WITHOUT a shell and with an argv array, so nothing in the environment
 * can inject a flag.
 */
function runReaper(repoDir) {
  const script = path.join(repoDir, ".claude", "bin", "orphan-reap.mjs");
  let out;
  try {
    out = execFileSync(process.execPath, [script, "--json", "--apply"], {
      cwd: repoDir,
      encoding: "utf8",
      timeout: REAP_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e) {
    // Exit 2 means a kill FAILED but the run completed and its JSON is on
    // stdout; that is a real result and must not be discarded as "never ran".
    out = e && typeof e.stdout === "string" && e.stdout ? e.stdout : null;
    if (!out)
      return {
        ok: false,
        reason:
          e && e.message
            ? String(e.message).slice(0, 120)
            : "reaper did not run",
      };
  }
  try {
    const parsed = JSON.parse(out);
    if (!parsed || parsed.ok !== true || !parsed.counts) {
      return {
        ok: false,
        reason: (parsed && parsed.reason) || "reaper output missing counts",
      };
    }
    return {
      ok: true,
      counts: parsed.counts,
      killed: Array.isArray(parsed.killed) ? parsed.killed : [],
      failed: Array.isArray(parsed.failed) ? parsed.failed : [],
      records: Array.isArray(parsed.orphans) ? parsed.orphans : [],
      load: parsed.load || null,
      // CARRIED, not dropped: the reaper measures the memory axis and the reap
      // report renders it. Without this the axis was silently lost in the child's
      // JSON → parent hop, which is the same "measured then discarded" shape as
      // the rest of this batch.
      mem: parsed.mem || null,
    };
  } catch {
    return { ok: false, reason: "reaper output was not JSON" };
  }
}

/**
 * Resolve both floors, or report the FIRST refusal.
 *
 * RETURNED RATHER THAN THROWN, and returned in a shape `measure()` can hand back
 * without ambiguity: a REFUSAL and an UNMEASURED host are different facts and are
 * never collapsed into one return. `null` stays what it always was — the process
 * table could not be read — and a refusal is `{refused: true, refusal}`. Collapsing
 * them would make the refusal unreadable at exactly the moment the operator needs
 * to be told which variable is wrong.
 */
function resolveFloors(env) {
  const age = resolveMinAgeHoursStrict(env);
  const cpu = resolveMinCpuPctStrict(env);
  const refusal = !age.ok ? age : !cpu.ok ? cpu : null;
  if (refusal) return { refused: true, refusal };
  return { refused: false, minAgeHours: age.value, minCpuPct: cpu.value };
}

/**
 * Measure in-process (SessionStart, and SessionEnd with the reap disabled).
 *
 * Returns `null` when the process table could not be read (UNMEASURED, never "no
 * orphans"), `{refused: true, refusal}` when a floor was refused, and a finding
 * otherwise.
 */
function measure(env) {
  const floors = resolveFloors(env);
  if (floors.refused) return floors;
  const processes = censusProcesses();
  if (processes === null) return null;
  const candidatePids = processes.filter(isOrphanCandidate).map((p) => p.pid);
  // The cheap short-circuit: on a healthy host there are zero candidates, so
  // lsof is never spawned and the whole surface costs one `ps`.
  const openFiles = candidatePids.length ? collectOpenFiles(candidatePids) : {};
  return classifyOrphans({
    processes,
    openFiles,
    minAgeHours: floors.minAgeHours,
    minCpuPct: floors.minCpuPct,
  });
}

/**
 * A refused floor: SKIP WHAT THE FLOORS GOVERN — the census and the reap — and
 * say so, while STILL reporting what the floors do not govern.
 *
 * WHY THIS IS LOUD EVEN WHEN NOTHING IS WRONG ON THE HOST. The failure this closes
 * is silent, and it is silent in the OPERATOR's direction: a typo in a profile
 * leaves the reaper either disarmed (floor 0 — the unattended reap runs at any age)
 * or running on a floor nobody chose (the old resolver substituted the default).
 * Neither is visible in a run that reports "0 orphans", and the second is invisible
 * in EVERY run. So the refusal is reported rather than swallowed — the same
 * fail-direction `resolveAutoReap` takes for `COC_ORPHAN_AUTOREAP=flase`.
 *
 * WHAT IT MUST NOT DO, and this was measured: the refusal used to return BEFORE
 * the host-health block, so a bad floor ALSO suppressed the swap-exhaustion
 * warning — a report that reads neither the census nor the floors, silenced by a
 * refusal about something else. `hostHealthReportLines` exists so this path can
 * carry the load and swap lines WITHOUT the census claim `reportLines` opens with.
 * The refusal is on the FLOORS' jurisdiction (the census and the reap); the host's
 * health is not its jurisdiction and is still reported.
 *
 * AND THE WORDING IS CONDITIONAL, because "reap skipped" is a claim about a thing
 * that only exists when a reap would have run: at SessionStart no reap runs at
 * all, and with `COC_ORPHAN_AUTOREAP` off the reap is disabled — reporting a
 * "skipped" reap in either case would be a message that reads as a fact about the
 * world and is a fact about nothing.
 *
 * Advisory, never `block`, per `hook-output-discipline.md` MUST-2: the signal here
 * is a config value, and the finding is that the operator has to fix it, not that
 * this session did anything wrong.
 */
function emitFloorRefusal(event, refusal, ctx = {}) {
  const { reapWouldRun = false, reapDisabledBy = null, load = null, mem = null } = ctx;
  const skippedClause = reapWouldRun
    ? "the unattended reap was SKIPPED, so nothing was killed and the process census was not even run"
    : event === "SessionEnd"
      ? `the reap is already DISABLED (COC_ORPHAN_AUTOREAP=${reapDisabledBy}), so the refused floor changed nothing this run and nothing was killed`
      : `no reap runs at ${event}, so the refused floor changed nothing this session and nothing was killed`;

  const lines = [
    `State that ${refusal.key}=${JSON.stringify(refusal.raw)} was REFUSED — ${refusal.reason}`,
    `State that ${skippedClause}.`,
    // F3: INTERPOLATED, never hand-typed — the reaper derives these from the
    // exported floors, and a hand-typed "1h … 1%" here would be a durable claim
    // true of one file and false of its sibling.
    `State what the minimum is: ${MIN_AGE_HOURS_FLOOR}h for COC_ORPHAN_MIN_AGE_HOURS, ${MIN_CPU_PCT_FLOOR}% for COC_ORPHAN_MIN_CPU_PCT.`,
    "Report that the operator must unset the variable or raise it to at least its minimum; until then the session-end reap does NOT run.",
  ];
  // F1: the axis the refusal does NOT govern. Reported even here — a suppressed
  // swap warning is the failure this branch was creating.
  lines.push(...hostHealthReportLines(load, mem));

  return emit({
    hookEvent: event,
    severity: "advisory",
    what_happened: `${refusal.key}=${JSON.stringify(refusal.raw)} was refused, so ${skippedClause}.`,
    why: "a floor that is silently substituted or lowered is not a floor: the value the operator believes is in force stops being the value in force, and no later reading can tell the two apart",
    agent_must_report: lines,
    agent_must_wait:
      "No action required in this session; the report is for the operator. Run `node .claude/bin/orphan-reap.mjs` to inspect the host, and see `--help` for the accepted values.",
    user_summary: `${reapWouldRun ? "Unattended orphan reap SKIPPED" : `No reap ran at ${event}`} — ${refusal.key}=${JSON.stringify(refusal.raw)} was refused (${refusal.reason}). Nothing was killed.`,
  });
}

function run(payload) {
  const event = payload.hook_event_name || "";
  if (event !== "SessionStart" && event !== "SessionEnd") {
    // Registered only on those two events; anything else is a mis-registration
    // and passes through rather than guessing what the caller meant.
    return passthrough();
  }
  const repoDir =
    payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const autoReap = resolveAutoReap(process.env);

  // A REFUSED FLOOR SKIPS WHAT THE FLOORS GOVERN — the census and the reap — and
  // NOTHING ELSE. This gate is placed before the reap branch on purpose: the
  // reaper would refuse the same value and exit 64, but reaching it costs a spawned
  // process that has already read the process table, and `--force` does not exist
  // to pass — so the reap is SKIPPED here rather than attempted and failed.
  //
  // The host-health read is NOT under the floors' jurisdiction and is taken BEFORE
  // the gate, so a refused floor cannot silence the swap warning. Both are cheap:
  // `os.loadavg()` is a libuv call and the memory read is one `sysctl`.
  const floors = resolveFloors(process.env);
  const refusalLoad = hostLoad();
  const refusalMem = hostMemory();
  if (floors.refused) {
    return emitFloorRefusal(event, floors.refusal, {
      reapWouldRun: event === "SessionEnd" && autoReap.enabled,
      reapDisabledBy: autoReap.raw,
      load: refusalLoad,
      mem: refusalMem,
    });
  }

  // ── SessionEnd: ACT, then report what was done ──
  if (event === "SessionEnd" && autoReap.enabled) {
    // ROOT IS REFUSED BEFORE THE SPAWN, and it has to be checked HERE rather than
    // left to the child: the reaper would refuse itself and exit 77, but a
    // `runReaper` that could not run and a host with nothing to reap produce the
    // SAME silence (`if (!m || m.counts.candidates === 0) return passthrough()`), so
    // the operator would never learn that the unattended reap had stopped working.
    // One shared predicate, so this cannot drift from what the child enforces.
    const rootReason = credentialsRefusalReason(readCredentials());
    if (rootReason) {
      return emit({
        hookEvent: event,
        severity: "advisory",
        what_happened: `The unattended reap was SKIPPED: ${rootReason}.`,
        why: "a reaper that signals processes as root can hit any process on the host when a re-read→kill race is lost, and an unattended reap has no need for that privilege",
        agent_must_report: [
          `State that the unattended reap was SKIPPED because this session runs as ROOT.`,
          "State the reason: without an fd-pinned pid there is no way to close the re-read→kill window, so root must not signal.",
          "Report that the operator should run the reap as the OWNER of the processes it reaps (`node .claude/bin/orphan-reap.mjs --apply` from that account), or that a report-only run remains available as root.",
          ...hostHealthReportLines(refusalLoad, refusalMem),
        ],
        agent_must_wait:
          "No action required in this session; the report is for the operator. A report-only run (`node .claude/bin/orphan-reap.mjs`) is still allowed as root.",
        user_summary: `Unattended orphan reap SKIPPED — this session runs as root. Nothing was killed.`,
      });
    }
    const result = runReaper(repoDir);
    if (!result.ok) {
      // The reap could not run. Say so rather than reporting a clean pass —
      // "the reaper failed" and "there was nothing to reap" are opposite facts
      // and must not share an output.
      const m = measure(process.env);
      if (m && m.refused) {
        return emitFloorRefusal(event, m.refusal, {
          reapWouldRun: true,
          load: refusalLoad,
          mem: refusalMem,
        });
      }
      if (!m || m.counts.candidates === 0) return passthrough();
      return emit({
        hookEvent: event,
        severity: "advisory",
        what_happened: `${m.counts.candidates} orphaned harness shell(s) are present and the unattended reap could not run (${result.reason}).`,
        why: "a leaked CPU-burning orphan silently corrupts every timing-sensitive measurement on the host until someone notices",
        agent_must_report: reportLines({
          ...m,
          load: hostLoad(),
          mem: hostMemory(),
        }),
        agent_must_wait:
          "No action required in this session; the report is for the operator. Run `node .claude/bin/orphan-reap.mjs` to inspect.",
        user_summary: summarize(m),
      });
    }
    if (result.counts.candidates === 0) return passthrough();
    return emit({
      hookEvent: event,
      severity: "advisory",
      what_happened: `An unattended reap ran at session end: ${result.killed.length} orphaned CPU-burning shell(s) terminated, ${result.counts.keep} KEEP untouched.`,
      why: "creation owns teardown; a burner whose cleanup never ran survives every session boundary until someone kills it by hand",
      agent_must_report: reapReportLines(result),
      agent_must_wait:
        "No action required in this session; the report is for the operator. Set COC_ORPHAN_AUTOREAP=0 to disable the unattended reap.",
      user_summary: summarize(result),
    });
  }

  // ── SessionStart (always), and SessionEnd with the reap disabled: REPORT ──
  //
  // SessionStart never reaps, and that is a deliberate asymmetry. A process
  // orphaned moments ago may belong to a wave that is still winding down, and
  // the operator is PRESENT — so the report reaches someone who can act. The
  // idle floor would hold such a process anyway; not reaping here means the
  // safety does not rest on the floor alone.
  const m = measure(process.env);
  const load = hostLoad();
  const mem = hostMemory();

  if (m && m.refused) {
    // Reported, never silent. The gate above already refused this same value and
    // returned before the reap branch; this arm exists so that a caller reaching
    // `measure()` by any other route cannot DROP a refusal — an unreported refusal
    // is the whole defect being closed.
    return emitFloorRefusal(event, m.refusal, {
      reapWouldRun: event === "SessionEnd" && autoReap.enabled,
      reapDisabledBy: autoReap.raw,
      load,
      mem,
    });
  }
  if (m === null) {
    // Unmeasured. Silent — a session-start warning that the process table was
    // briefly unreadable is noise, and reporting "0 orphans" would be worse.
    return passthrough();
  }

  const notableLoad = loadIsNotable(load);
  // Swap exhaustion is reported even when load is calm and nothing leaked: the
  // two axes are independent, and it is the one that kills rather than slows.
  const notableMem = memoryIsNotable(mem);
  if (m.counts.candidates === 0 && !notableLoad && !notableMem)
    return passthrough();

  const lines = reportLines({ ...m, load, mem });
  const reapOff = event === "SessionEnd" && !autoReap.enabled;
  if (reapOff) {
    lines.push(
      `State that the unattended session-end reap is DISABLED by COC_ORPHAN_AUTOREAP=${autoReap.raw}, so nothing was removed automatically. It is ON by default; unset the variable to restore it.`,
    );
  }
  if (m.counts.candidates === 0 && notableLoad) {
    // Load is high but NOTHING here explains it. Saying so is the point: the
    // incident's real cost was that "the machine was loaded" was never a live
    // hypothesis for the timing anomalies it caused.
    lines.push(
      "State that no orphaned harness shells were found, so this load is NOT explained by a leaked burner — treat any timing-sensitive measurement taken now as suspect and re-run it on an idle host before drawing a structural conclusion.",
    );
  }

  return emit({
    hookEvent: event,
    severity: "advisory",
    what_happened:
      hostHealthLine(load, m.counts, mem) ||
      `${m.counts.candidates} orphaned harness shell(s) found.`,
    why: "a leaked CPU-burning orphan has no owner, no log and no failing check, and it degrades every subsequent measurement on the host without appearing in any of them",
    agent_must_report: lines,
    agent_must_wait:
      event === "SessionStart"
        ? "Report the counts. This is a report, not a block — proceed with the session."
        : "No action required in this session; the report is for the operator.",
    user_summary: summarize(m),
  });
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). Everything a standalone run
// did at load time happens here instead, so a require() has no side effects.
// The returned promise settles only when the stdin handlers have run, so the
// engine never reads the detector as finished before its work.
//
// Engine residual (hook-engine.js § process.exit): the `catch` below encloses
// run(), whose every path ends in process.exit (passthrough / emit). In-engine
// that exit throws a sentinel the catch receives; the catch does output and exit
// ONLY, both of which the engine discards once the detector has exited.
function hookMain() {
  const _timeout = setTimeout(() => {
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    process.exit(1);
  }, TIMEOUT_MS);
  _timeout.unref?.();
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.on("error", () => {
      try {
        passthrough();
      } catch (e) {
        return reject(e);
      }
      resolve();
    });
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (input += d));
    process.stdin.on("end", () => {
      clearTimeout(_timeout);
      try {
        run(JSON.parse(input || "{}"));
      } catch (e) {
        try {
          process.stderr.write(
            `[orphan-forest-guard] HOOK ERROR: ${e.message}\n`,
          );
          process.stdout.write(JSON.stringify({ continue: true }) + "\n");
          process.exit(1);
        } catch (e2) {
          return reject(e2);
        }
      }
      resolve();
    });
  });
}

module.exports = { hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1")
    require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
