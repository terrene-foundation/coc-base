/**
 * orphan-forest.js — the classifier behind `orphan-forest-guard.js` and
 * `.claude/bin/orphan-reap.mjs`.
 *
 * THE PROBLEM, measured. On 2026-08-14 a CPU-saturation load test left 96
 * orphaned `/bin/zsh` processes on this host — two cohorts of 48, one per
 * worktree — running busy-loops at 7–15% CPU each for 22 hours, PPID 1, load
 * average peaking at 577 on 16 cores. The script's cleanup line
 * (`kill $BURNERS; echo "burners killed"`) was the last STATEMENT rather than a
 * `trap`, so it never executed in any invocation: zero task-output files on the
 * host contain the string it would have printed. They were found and killed by
 * hand a day and a half later. Full post-mortem:
 * `workspaces/runtime-enforcement-2026-08-14/01-analysis/03-burner-leak-postmortem.md`.
 *
 * WHY A CLASSIFIER AND NOT A RULE. The corpus already carries
 * `instrument-discipline.md` MUST-1, and the leaked script still shipped
 * `echo "burners killed"` — an unconditional success claim with no nameable
 * falsifying result. Prose did not prevent it. The cascadeable contract still
 * ships (`skills/30-claude-code-patterns/background-process-discipline.md`),
 * but it is documentation; THIS is the fence.
 *
 * THE DESIGN IS A COPY, NOT AN INVENTION. `worktree-forest.js` already solves
 * the identical shape — a resource that leaks, detected at a lifecycle
 * boundary, auto-reaped only when provably safe, with an age floor, per-item
 * KEEP verdicts carrying reasons, and a default-ON kill switch. Every structural
 * choice here is taken from it deliberately.
 *
 * PURE CORE, THIN COLLECTORS. Everything that decides is a pure function over a
 * SNAPSHOT BUNDLE (process table + per-pid open files). Nothing in the decision
 * path reads the live host, so the fixtures are fabricated process tables and
 * the tests never spawn a burner. A fixture coupled to live host state is the
 * defect loom#1650 recorded; this module is built so that coupling is not
 * expressible.
 *
 * FAIL-CLOSED ON MISSING EVIDENCE. ZERO-LOSS requires POSITIVE evidence of
 * inertness. Absent evidence — an unreadable process, open files that could not
 * be listed, an unparseable age — is a KEEP with that reason recorded, never a
 * reap. Absence of evidence is not evidence of absence, and the direction of
 * that default is the whole safety argument.
 */

"use strict";

const os = require("os");
const { execFileSync } = require("child_process");

// ── verdicts ────────────────────────────────────────────────────────────────
//
// Two, not three. `worktree-forest.js` carries a middle TAG-FIRST verdict
// because a worktree can hold recoverable work that a tag would make durable.
// A process holds no such thing: it is either provably inert or it is somebody's.
const REAP = "ZERO-LOSS";
const KEEP = "KEEP";

// ── the orphan predicate ────────────────────────────────────────────────────
//
// PPID 1 AND a command line carrying the harness's own shell-snapshot preamble.
// Every leaked burner had it, because the harness sources a per-session snapshot
// into every shell it launches:
//
//   /bin/zsh -c source /Users/<u>/.claude/accounts/<acct>/shell-snapshots/\
//   snapshot-zsh-1786079788126-lk45dk.sh 2>/dev/null || true && …
//
// MEASURED AT BOTH POLES on the incident host (2026-08-14, re-measured in the
// implementing session rather than inherited):
//   - leak state:  96 matches — exactly the leak set, 48 per worktree.
//   - clean state:  0 matches, against 8 live harness shells (all with real
//                   parents) out of 1,358 processes.
// A predicate returning 96 in the leak state and 0 in the clean state, while
// never matching a live shell, is the opposite-verdict capability
// `evidence-first-claims.md` MUST-5 requires before a check is trusted.
//
// HOST-PORTABLE, WHICH IS WHY IT CASCADES. `shell-snapshots/snapshot-<shell>-`
// is a CLAUDE CODE convention, not a loom one — it contains no repo name, no
// user name and no absolute prefix. The leak bit other projects, so a
// loom-only predicate would not have closed it.
//
// The shell name is a character class rather than a literal `zsh` because the
// harness picks the operator's login shell; 13 of 13 snapshot shells on the
// incident host were zsh, but a bash operator gets `snapshot-bash-`.
const HARNESS_SNAPSHOT_RE = /shell-snapshots\/snapshot-[a-z]+-/;

function isHarnessShell(command) {
  if (typeof command !== "string" || command === "") return false;
  return HARNESS_SNAPSHOT_RE.test(command);
}

/**
 * An orphan CANDIDATE — the cheap predicate that selects who gets examined.
 * Being a candidate is NOT a licence to reap: it only decides who pays for the
 * expensive inertness evidence below.
 */
function isOrphanCandidate(proc) {
  return !!proc && proc.ppid === 1 && isHarnessShell(proc.command);
}

// ── the knobs ───────────────────────────────────────────────────────────────

// Why 2 hours. The incident ran 22 hours, so any floor under a day would have
// caught it. The floor exists for the opposite error: a session that is ALIVE
// and mid-wave has shells whose parent has legitimately exited moments ago
// (a finished orchestrator whose children are still draining). Two hours is far
// longer than any such drain and far shorter than the 22-hour window that made
// this expensive. It is deliberately NOT waivable to 0 by the unattended path.
const DEFAULT_MIN_AGE_HOURS = 2;

// Why a CPU floor at all, and why it makes the reaper SAFER rather than weaker.
// E10's acceptance sentence is scoped to "orphaned CPU-BURNING descendants",
// and that scope is a gift: a detached process sitting at 0% CPU is the exact
// shape of something a human parked on purpose (a dev server, a tunnel, a
// watcher). Requiring a live CPU burn before reaping excludes that entire class
// on a signal that is cheap and unambiguous. 5% is well above the noise floor
// of an idle process and far below the 7–15% each leaked burner sustained.
const DEFAULT_MIN_CPU_PCT = 5;

// ── the kill switch ─────────────────────────────────────────────────────────
//
// `COC_ORPHAN_AUTOREAP` turns the unattended SessionEnd reap OFF. Readable from
// the shell AND from `.claude/settings.json::env`, so an operator has both
// affordances without a second mechanism.
//
// DEFAULT ON, and the fail-direction is deliberate — the reasoning is
// `worktree-forest.js`'s verbatim and it applies unchanged. Only an explicitly
// RECOGNISED off-token disables the reap; every other value, including a typo,
// leaves it ENABLED and is REPORTED via `source: "default-unrecognized"`. The
// inverse (unrecognised ⇒ off) is how a safety feature ships inert: a
// `COC_ORPHAN_AUTOREAP=flase` in someone's profile would silently restore the
// exact leak this closes, and nothing would ever say so.
const AUTOREAP_OFF_TOKENS = new Set(["0", "off", "false", "no", "disabled"]);
const AUTOREAP_ON_TOKENS = new Set(["1", "on", "true", "yes", "enabled"]);

function resolveAutoReap(env) {
  const raw = (env || process.env).COC_ORPHAN_AUTOREAP;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { enabled: true, source: "default", raw: null };
  }
  const v = String(raw).trim().toLowerCase();
  if (AUTOREAP_OFF_TOKENS.has(v)) return { enabled: false, source: "env", raw: String(raw) };
  if (AUTOREAP_ON_TOKENS.has(v)) return { enabled: true, source: "env", raw: String(raw) };
  return { enabled: true, source: "default-unrecognized", raw: String(raw) };
}

/**
 * A numeric override that falls back to the DOCUMENTED DEFAULT on anything
 * malformed — never to 0 and never to NaN. Falling back to 0 would reap
 * everything (an age floor of zero, a CPU floor of zero); NaN would make every
 * comparison false and silently disarm the reaper. Both are the "cannot fail" /
 * "always fires" pair this module exists to avoid.
 */
function resolveNumericFloor(env, key, def, { min = 0, integer = false } = {}) {
  const raw = (env || process.env)[key];
  if (raw === undefined || raw === null || String(raw).trim() === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return def;
  if (integer && !Number.isInteger(n)) return def;
  return n;
}

const resolveMinAgeHours = (env) =>
  resolveNumericFloor(env, "COC_ORPHAN_MIN_AGE_HOURS", DEFAULT_MIN_AGE_HOURS, { min: 0 });
const resolveMinCpuPct = (env) =>
  resolveNumericFloor(env, "COC_ORPHAN_MIN_CPU_PCT", DEFAULT_MIN_CPU_PCT, { min: 0 });

// ── ps parsing ──────────────────────────────────────────────────────────────

/**
 * Parse BSD `ps` elapsed time into seconds.
 *
 * MEASURED, NOT ASSUMED: macOS `ps` REJECTS the `etimes` keyword that GNU ps
 * provides ("ps: etimes: keyword not found" — the error lists the valid set,
 * which contains `etime` and not `etimes`). So the age floor must parse the
 * FORMATTED BSD field. Observed formats on the incident host:
 *   `00:00`         mm:ss           (a just-spawned process)
 *   `22:10:33`      hh:mm:ss
 *   `06-22:59:39`   dd-hh:mm:ss     (launchd, i.e. host uptime)
 *
 * Returns null — never 0 — for anything unparseable. A 0 here would read as
 * "brand new" and hold a genuine orphan out of the reap, which is the safe
 * direction, but null is honest and the caller records it as a KEEP reason.
 */
function parseEtime(s) {
  if (typeof s !== "string") return null;
  const t = s.trim();
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(t);
  if (!m) return null;
  const [, dd, hh, mm, ss] = m;
  const d = dd ? Number(dd) : 0;
  const h = hh ? Number(hh) : 0;
  const secs = d * 86400 + h * 3600 + Number(mm) * 60 + Number(ss);
  return Number.isFinite(secs) ? secs : null;
}

/**
 * Parse the output of `ps -axo pid=,ppid=,etime=,pcpu=,command=`.
 *
 * The command field is last and unquoted precisely because it contains spaces;
 * the four fixed-width numerics are taken from the front and the remainder is
 * the command verbatim. A row whose leading fields do not parse is DROPPED
 * rather than guessed at — a half-read row could otherwise become a reap
 * target with a mis-attributed pid.
 */
function parsePsTable(stdout) {
  if (typeof stdout !== "string") return [];
  const rows = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const etimeSec = parseEtime(m[3]);
    const pcpu = Number(m[4]);
    const command = m[5];
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    rows.push({
      pid,
      ppid,
      etimeSec,
      pcpu: Number.isFinite(pcpu) ? pcpu : null,
      command,
    });
  }
  return rows;
}

// ── open-file parsing ───────────────────────────────────────────────────────

/**
 * Parse `lsof -p <pids> -Fpftn` field output into { pid: [{fd,type,name}] }.
 *
 * lsof field output is a stream of one-letter-tagged lines; `p` opens a new
 * process block and `f` opens a new file block within it.
 */
function parseLsof(stdout) {
  const out = {};
  if (typeof stdout !== "string") return out;
  let pid = null;
  let cur = null;
  const flush = () => {
    if (pid !== null && cur && cur.fd !== undefined) out[pid].push(cur);
    cur = null;
  };
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === "p") {
      flush();
      pid = Number(val);
      if (!Number.isInteger(pid)) {
        pid = null;
        continue;
      }
      if (!out[pid]) out[pid] = [];
    } else if (tag === "f") {
      flush();
      cur = { fd: val, type: null, name: null };
    } else if (tag === "t" && cur) {
      cur.type = val;
    } else if (tag === "n" && cur) {
      cur.name = val;
    }
  }
  flush();
  return out;
}

// WHICH OPEN FILES MEAN "SOMEBODY WANTS THIS ALIVE".
//
// MEASURED AT THREE POLES, because the obvious instrument does not discriminate.
// A raw count of non-standard descriptors returns 4 for a bare busy-loop
// subshell AND 4 for a process holding a listening socket — identical, so a
// count is a non-discriminating instrument in this rule's own sense and is NOT
// used. What separates them is the descriptor's TYPE and NUMBER:
//
//   burner subshell   f0 CHR /dev/null, f1/f2 REG (task output), f10 CHR /dev/null
//   listening socket  f0,f1,f2, and f3 IPv4                       ← a resource
//   open regular file f0,f1,f2, and f9 REG /tmp/…                 ← a resource
//
// So a HELD RESOURCE is a NUMERIC descriptor at 3 or above that is not simply
// pointing at a character device. `cwd` / `txt` / `mem` / `rtd` entries are
// mappings and the working directory — every process has them and they hold
// nothing — so they are excluded by requiring the descriptor to be numeric.
//
// /dev/null and tty character devices at fd ≥ 3 are benign: zsh dups its script
// descriptor to fd 10 on /dev/null, which every harness shell carries and which
// signifies nothing about intent.
function isHeldResource(f) {
  if (!f || typeof f.fd !== "string") return false;
  if (!/^\d+$/.test(f.fd)) return false; // cwd/txt/mem/rtd — not a held resource
  if (Number(f.fd) < 3) return false; // stdin/stdout/stderr
  if (f.type === "CHR") return false; // /dev/null, ttys — benign
  return true;
}

// ── classification (PURE) ───────────────────────────────────────────────────

/**
 * Classify a snapshot bundle. PURE — no host reads, no clock, no subprocess.
 *
 * @param {object} bundle
 * @param {Array}  bundle.processes  parsed `ps` rows (the WHOLE table; child
 *                                   detection needs every row, not just the
 *                                   candidates)
 * @param {object|null} bundle.openFiles  { pid: [{fd,type,name}] } for the
 *                                   candidates. `null` means the collector did
 *                                   not run; an ABSENT pid key inside a present
 *                                   object means lsof ran and returned nothing
 *                                   for it. Those are different facts and are
 *                                   treated differently below.
 * @param {number} bundle.minAgeHours
 * @param {number} bundle.minCpuPct
 *
 * @returns {{records: Array, counts: {candidates:number, zero_loss:number, keep:number}}}
 *
 * EVERY KEEP REASON IS RECORDED, not just the first. An operator reading the
 * report needs to know all of what is holding a process, because fixing one
 * reason and re-running only to hit the next is the loop that makes people
 * switch a gate off.
 */
function classifyOrphans(bundle) {
  const processes = Array.isArray(bundle && bundle.processes) ? bundle.processes : [];
  const openFiles = bundle && bundle.openFiles;
  const minAgeHours = Number.isFinite(bundle && bundle.minAgeHours)
    ? bundle.minAgeHours
    : DEFAULT_MIN_AGE_HOURS;
  const minCpuPct = Number.isFinite(bundle && bundle.minCpuPct)
    ? bundle.minCpuPct
    : DEFAULT_MIN_CPU_PCT;

  // Children are derived from the table itself — no extra syscall, and it stays
  // pure. A process with living children is never inert: killing the parent
  // orphans the children, which is the very failure being closed.
  const parents = new Set();
  for (const p of processes) parents.add(p.ppid);

  const records = [];
  for (const p of processes) {
    if (!isOrphanCandidate(p)) continue;

    const reasons = [];
    const ageHours = p.etimeSec === null || p.etimeSec === undefined ? null : p.etimeSec / 3600;

    if (ageHours === null) {
      reasons.push("elapsed time unparseable — age UNKNOWN, cannot clear the idle floor");
    } else if (ageHours < minAgeHours) {
      reasons.push(`age ${ageHours.toFixed(1)}h < floor ${minAgeHours}h`);
    }

    if (parents.has(p.pid)) {
      reasons.push("has living child processes — killing it would orphan them");
    }

    if (p.pcpu === null) {
      reasons.push("CPU% unreadable — cannot confirm it is a live burner");
    } else if (p.pcpu < minCpuPct) {
      // NOT a burner. This is the deliberately-detached class — a dev server, a
      // tunnel, a watcher someone parked. E10 is scoped to CPU-burning orphans
      // and this is where that scope is enforced.
      reasons.push(
        `CPU ${p.pcpu.toFixed(1)}% < burn floor ${minCpuPct}% — idle, so not the CPU-burner class (may be deliberately detached)`,
      );
    }

    if (!openFiles || typeof openFiles !== "object") {
      // The collector did not run at all. FAIL-CLOSED: no inertness evidence
      // means no reap, however burner-shaped the process looks.
      reasons.push("open files not collected — no positive evidence of inertness");
    } else if (!Object.prototype.hasOwnProperty.call(openFiles, p.pid)) {
      // `hasOwnProperty`, not a truthiness check: an empty array is a REAL
      // measurement ("holds nothing") and must not read the same as an absent
      // key ("never measured"). Conflating them is exactly the non-discriminating
      // read this whole program exists to eliminate.
      reasons.push("open files unreadable for this pid — no positive evidence of inertness");
    } else {
      const held = (openFiles[p.pid] || []).filter(isHeldResource);
      if (held.length) {
        const shown = held
          .slice(0, 3)
          .map((f) => `fd ${f.fd} ${f.type}${f.name ? ` ${f.name}` : ""}`)
          .join(", ");
        reasons.push(
          `holds ${held.length} open resource(s) — ${shown}${held.length > 3 ? ", …" : ""}`,
        );
      }
    }

    records.push({
      pid: p.pid,
      ppid: p.ppid,
      ageHours,
      pcpu: p.pcpu,
      command: p.command,
      verdict: reasons.length ? KEEP : REAP,
      reasons: reasons.length
        ? reasons
        : [
            `orphaned ${ageHours.toFixed(1)}h, burning ${p.pcpu.toFixed(1)}% CPU, no children, no open resources`,
          ],
    });
  }

  records.sort((a, b) => a.pid - b.pid);
  return {
    records,
    counts: {
      candidates: records.length,
      zero_loss: records.filter((r) => r.verdict === REAP).length,
      keep: records.filter((r) => r.verdict === KEEP).length,
    },
  };
}

// ── collectors (impure, deliberately thin) ──────────────────────────────────

// SUBPROCESS BUDGETS. `ps -axo` on the incident host enumerated 1,358 processes
// in well under a second; 3s is a hang ceiling, not a cost. The lsof call is
// scoped to the CANDIDATE pids only — measured 0.048s for one pid — and in the
// overwhelmingly common case there are ZERO candidates, so it is never spawned
// at all. That is the same cheap-short-circuit shape `worktree-forest.js` uses.
const PS_TIMEOUT_MS = 3000;
const LSOF_TIMEOUT_MS = 5000;

/**
 * Read the process table. Returns parsed rows, or null when ps could not be
 * consulted. NULL IS NOT AN EMPTY TABLE — callers must treat it as "unmeasured"
 * and must not report "0 orphans" from it.
 */
function censusProcesses(opts = {}) {
  const run = opts.exec || execFileSync;
  let out;
  try {
    out = run("ps", ["-axo", "pid=,ppid=,etime=,pcpu=,command="], {
      encoding: "utf8",
      timeout: opts.timeoutMs || PS_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  if (typeof out !== "string") return null;
  return parsePsTable(out);
}

/**
 * Collect open files for the given pids. Returns a map, or null when lsof could
 * not be consulted at all — which the classifier reads as "no evidence" and
 * therefore KEEP, never as "holds nothing".
 *
 * lsof exits non-zero when SOME pid has vanished between the ps snapshot and
 * this call, which is routine on a churning host; its stdout is still valid for
 * the pids that remain, so a non-zero exit with usable output is honoured
 * rather than discarded.
 */
function collectOpenFiles(pids, opts = {}) {
  if (!Array.isArray(pids) || pids.length === 0) return {};
  const run = opts.exec || execFileSync;
  const args = ["-p", pids.join(","), "-FpftnP", "-n"];
  let out;
  try {
    out = run("lsof", args, {
      encoding: "utf8",
      timeout: opts.timeoutMs || LSOF_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e) {
    out = e && typeof e.stdout === "string" ? e.stdout : null;
    if (out === null) return null;
  }
  if (typeof out !== "string") return null;
  return parseLsof(out);
}

/**
 * One-line host health. `os.loadavg()` is a libuv call — microseconds, no
 * subprocess — so this is free enough to run at every session start.
 *
 * A boundary reaper structurally CANNOT see a leak that is live right now; the
 * 22-hour invisibility is what made the incident expensive rather than the leak
 * itself. This is the half that closes that.
 */
function hostLoad() {
  try {
    const [one, five, fifteen] = os.loadavg();
    const cpus = os.cpus()?.length || null;
    if (!Number.isFinite(one)) return null;
    return { one, five, fifteen, cpus };
  } catch {
    return null;
  }
}

// ── reporting ───────────────────────────────────────────────────────────────

/**
 * Is the host load high enough to be worth a line? Expressed as a MULTIPLE of
 * core count so it means the same thing on a 4-core laptop and a 16-core
 * workstation. 2.0 is the conventional "meaningfully oversubscribed" mark; the
 * incident sat at roughly 36x.
 */
const LOAD_RATIO_FLOOR = 2.0;

function loadIsNotable(load) {
  if (!load || !Number.isFinite(load.one) || !load.cpus) return false;
  return load.one / load.cpus >= LOAD_RATIO_FLOOR;
}

function hostHealthLine(load, counts) {
  const parts = [];
  if (load && Number.isFinite(load.one)) {
    const ratio = load.cpus ? ` (${(load.one / load.cpus).toFixed(1)}x ${load.cpus} cores)` : "";
    parts.push(`load ${load.one.toFixed(2)}${ratio}`);
  }
  if (counts) {
    parts.push(
      `${counts.candidates} orphaned harness shell(s): ${counts.zero_loss} reapable, ${counts.keep} KEEP`,
    );
  }
  return parts.length ? parts.join(" · ") : null;
}

function reportLines(finding) {
  const lines = [];
  const { counts, records } = finding;
  lines.push(
    `State that ${counts.candidates} orphaned harness shell(s) were found (PPID 1, carrying the Claude Code shell-snapshot signature): ${counts.zero_loss} classified ZERO-LOSS, ${counts.keep} KEEP.`,
  );
  for (const r of records.slice(0, 8)) {
    lines.push(
      `Report pid ${r.pid} — ${r.verdict}: ${r.reasons.join("; ")}${r.command ? ` [${r.command.slice(0, 80)}]` : ""}`,
    );
  }
  if (records.length > 8) {
    lines.push(`Report that ${records.length - 8} further orphan(s) were omitted from this list.`);
  }
  if (finding.load) {
    lines.push(
      `State the host load: ${finding.load.one.toFixed(2)} over ${finding.load.cpus || "?"} cores.`,
    );
  }
  return lines;
}

function reapReportLines(finding) {
  const lines = [];
  lines.push(
    `State that an unattended reap ran at session end: ${finding.killed.length} orphaned CPU-burning shell(s) terminated, ${finding.counts.keep} KEEP left untouched.`,
  );
  if (finding.killed.length) {
    lines.push(`Report the terminated pids: ${finding.killed.join(", ")}.`);
  }
  if (finding.failed && finding.failed.length) {
    lines.push(
      `Report that ${finding.failed.length} pid(s) could NOT be terminated: ${finding.failed.map((f) => `${f.pid} (${f.reason})`).join(", ")}.`,
    );
  }
  for (const r of finding.records.filter((r) => r.verdict === KEEP).slice(0, 5)) {
    lines.push(`Report KEEP pid ${r.pid}: ${r.reasons.join("; ")}`);
  }
  return lines;
}

function summarize(finding) {
  if (finding.killed) {
    return `Reaped ${finding.killed.length} orphaned CPU-burning shell(s); ${finding.counts.keep} kept.`;
  }
  return `${finding.counts.candidates} orphaned harness shell(s): ${finding.counts.zero_loss} reapable, ${finding.counts.keep} kept.`;
}

module.exports = {
  REAP,
  KEEP,
  DEFAULT_MIN_AGE_HOURS,
  DEFAULT_MIN_CPU_PCT,
  LOAD_RATIO_FLOOR,
  HARNESS_SNAPSHOT_RE,
  isHarnessShell,
  isOrphanCandidate,
  isHeldResource,
  resolveAutoReap,
  resolveMinAgeHours,
  resolveMinCpuPct,
  parseEtime,
  parsePsTable,
  parseLsof,
  classifyOrphans,
  censusProcesses,
  collectOpenFiles,
  hostLoad,
  loadIsNotable,
  hostHealthLine,
  reportLines,
  reapReportLines,
  summarize,
};
