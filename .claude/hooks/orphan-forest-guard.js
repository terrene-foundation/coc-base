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
  resolveMinAgeHours,
  resolveMinCpuPct,
  censusProcesses,
  collectOpenFiles,
  classifyOrphans,
  hostLoad,
  loadIsNotable,
  hostHealthLine,
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
const TIMEOUT_MS = 10000;
const _timeout = setTimeout(() => {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(1);
}, TIMEOUT_MS);
_timeout.unref?.();

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
    if (!out) return { ok: false, reason: e && e.message ? String(e.message).slice(0, 120) : "reaper did not run" };
  }
  try {
    const parsed = JSON.parse(out);
    if (!parsed || parsed.ok !== true || !parsed.counts) {
      return { ok: false, reason: (parsed && parsed.reason) || "reaper output missing counts" };
    }
    return {
      ok: true,
      counts: parsed.counts,
      killed: Array.isArray(parsed.killed) ? parsed.killed : [],
      failed: Array.isArray(parsed.failed) ? parsed.failed : [],
      records: Array.isArray(parsed.orphans) ? parsed.orphans : [],
      load: parsed.load || null,
    };
  } catch {
    return { ok: false, reason: "reaper output was not JSON" };
  }
}

/**
 * Measure in-process (SessionStart, and SessionEnd with the reap disabled).
 * Returns null when the process table could not be read — which is UNMEASURED,
 * never "no orphans".
 */
function measure(env) {
  const processes = censusProcesses();
  if (processes === null) return null;
  const candidatePids = processes.filter(isOrphanCandidate).map((p) => p.pid);
  // The cheap short-circuit: on a healthy host there are zero candidates, so
  // lsof is never spawned and the whole surface costs one `ps`.
  const openFiles = candidatePids.length ? collectOpenFiles(candidatePids) : {};
  return classifyOrphans({
    processes,
    openFiles,
    minAgeHours: resolveMinAgeHours(env),
    minCpuPct: resolveMinCpuPct(env),
  });
}

function run(payload) {
  const event = payload.hook_event_name || "";
  if (event !== "SessionStart" && event !== "SessionEnd") {
    // Registered only on those two events; anything else is a mis-registration
    // and passes through rather than guessing what the caller meant.
    return passthrough();
  }
  const repoDir = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const autoReap = resolveAutoReap(process.env);

  // ── SessionEnd: ACT, then report what was done ──
  if (event === "SessionEnd" && autoReap.enabled) {
    const result = runReaper(repoDir);
    if (!result.ok) {
      // The reap could not run. Say so rather than reporting a clean pass —
      // "the reaper failed" and "there was nothing to reap" are opposite facts
      // and must not share an output.
      const m = measure(process.env);
      if (!m || m.counts.candidates === 0) return passthrough();
      return emit({
        hookEvent: event,
        severity: "advisory",
        what_happened: `${m.counts.candidates} orphaned harness shell(s) are present and the unattended reap could not run (${result.reason}).`,
        why: "a leaked CPU-burning orphan silently corrupts every timing-sensitive measurement on the host until someone notices",
        agent_must_report: reportLines({ ...m, load: hostLoad() }),
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

  if (m === null) {
    // Unmeasured. Silent — a session-start warning that the process table was
    // briefly unreadable is noise, and reporting "0 orphans" would be worse.
    return passthrough();
  }

  const notableLoad = loadIsNotable(load);
  if (m.counts.candidates === 0 && !notableLoad) return passthrough();

  const lines = reportLines({ ...m, load });
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
      hostHealthLine(load, m.counts) || `${m.counts.candidates} orphaned harness shell(s) found.`,
    why: "a leaked CPU-burning orphan has no owner, no log and no failing check, and it degrades every subsequent measurement on the host without appearing in any of them",
    agent_must_report: lines,
    agent_must_wait:
      event === "SessionStart"
        ? "Report the counts. This is a report, not a block — proceed with the session."
        : "No action required in this session; the report is for the operator.",
    user_summary: summarize(m),
  });
}

let input = "";
process.stdin.on("error", passthrough);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  clearTimeout(_timeout);
  try {
    run(JSON.parse(input || "{}"));
  } catch (e) {
    process.stderr.write(`[orphan-forest-guard] HOOK ERROR: ${e.message}\n`);
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    process.exit(1);
  }
});
