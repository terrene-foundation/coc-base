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
 *             2 = --apply attempted a kill that failed (loud, never swallowed).
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const {
  KEEP,
  REAP,
  DEFAULT_MIN_AGE_HOURS,
  DEFAULT_MIN_CPU_PCT,
  isOrphanCandidate,
  resolveMinAgeHours,
  resolveMinCpuPct,
  classifyOrphans,
  censusProcesses,
  collectOpenFiles,
  hostLoad,
} = require(join(HERE, "..", "hooks", "lib", "orphan-forest.js"));

function usage() {
  return [
    "orphan-reap.mjs — report/reap orphaned CPU-burning harness shells",
    "",
    "usage: node .claude/bin/orphan-reap.mjs [options]",
    "",
    "  --apply               terminate ZERO-LOSS orphans (default: report only)",
    "  --json                machine-readable output",
    `  --min-age-hours <N>   idle floor before an orphan is reapable (default ${DEFAULT_MIN_AGE_HOURS})`,
    `  --min-cpu-pct <N>     CPU burn floor; below it an orphan is KEEP (default ${DEFAULT_MIN_CPU_PCT})`,
    "  --help, -h            this message",
    "",
    "A ZERO-LOSS verdict requires ALL of: past the idle floor, no child",
    "processes, an active CPU burn, and no held file/socket descriptors.",
    "Anything else is KEEP, with every reason reported.",
  ].join("\n");
}

function parseArgs(argv) {
  const o = {
    apply: false,
    json: false,
    minAgeHours: resolveMinAgeHours(process.env),
    minCpuPct: resolveMinCpuPct(process.env),
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") o.apply = true;
    else if (a === "--json") o.json = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--min-age-hours") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n >= 0) o.minAgeHours = n;
    } else if (a === "--min-cpu-pct") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n >= 0) o.minCpuPct = n;
    }
  }
  return o;
}

/**
 * Terminate the ZERO-LOSS set. SIGTERM first, then SIGKILL only for what
 * survives — seven of the 96 in the incident needed SIGKILL, so a TERM-only
 * pass would have reported success while leaving burners running.
 *
 * RE-VERIFIED BEFORE EACH KILL. Between the ps snapshot and this call a pid can
 * exit and be REUSED by an unrelated process, and killing a recycled pid is the
 * one way this tool could destroy something. So each pid is re-read from the
 * live table and must STILL satisfy the orphan predicate with the same start
 * time; anything that no longer matches is skipped and reported.
 */
function reap(records, opts = {}) {
  const kill = opts.kill || process.kill.bind(process);
  const recheck = opts.recheck || (() => censusProcesses());
  const sleep = opts.sleep || ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));

  const targets = records.filter((r) => r.verdict === REAP);
  const killed = [];
  const failed = [];
  if (!targets.length) return { killed, failed };

  const live = recheck();
  const byPid = new Map();
  for (const p of Array.isArray(live) ? live : []) byPid.set(p.pid, p);

  const termed = [];
  for (const r of targets) {
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
    try {
      kill(r.pid, "SIGTERM");
      termed.push(r.pid);
    } catch (e) {
      failed.push({ pid: r.pid, reason: `SIGTERM failed: ${e.code || e.message}` });
    }
  }

  if (termed.length) {
    sleep(500);
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

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(usage() + "\n");
    return 0;
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

  const { records, counts } = classifyOrphans({
    processes,
    openFiles,
    minAgeHours: opts.minAgeHours,
    minCpuPct: opts.minCpuPct,
  });

  let killed = [];
  let failed = [];
  if (opts.apply) ({ killed, failed } = reap(records));

  const load = hostLoad();
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

process.exitCode = main();

export { reap, parseArgs };
