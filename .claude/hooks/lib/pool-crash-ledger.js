/**
 * pool-crash-ledger — REPEAT-CRASH DEMOTION for the repo pool (lib/local-supervisor.js).
 *
 * WHY. A `mode:"legacy"` repo row runs in a worker thread of the repo pool's process, so
 * its ordinary failures are contained — but a row that ABORTS, OOMs or is signalled ends
 * the pool, and the rows of that event that never reported are then treated as unrun
 * (refused, when they can refuse). That is the correct disposition ONCE. A row that does it
 * repeatedly is a row that should not run in-process in this tree at all: after K faults
 * inside a window it is DEMOTED to `mode:"process"` — the standalone-process path it would
 * have had before the adapter existed — which contains it completely.
 *
 * RECORDED, NEVER SILENT. Every demotion is written to this ledger (the durable record a
 * session or an operator can read) AND appended as a line to
 * `.claude/learning/repo-pool-faults.jsonl` through the hooks' canonical append sink. The
 * operator surface is `node .claude/hooks/lib/pool-crash-ledger.js --status`, which prints
 * the counts, the window and every demoted row. A demotion is a PERFORMANCE disposition:
 * the row still runs, with the same input and the same verdict (pinned by a fixture), just
 * outside the dispatcher.
 *
 * FAIL-OPEN, AND LOUD ABOUT IT. The ledger is bookkeeping: if it cannot be read or written,
 * every answer is "not demoted" (the row runs the way it did a moment ago) and the caller
 * gets a reason to say out loud. A lost ledger must never cost a repo its detectors.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const LEDGER_VERSION = 1;
// K faults inside WINDOW demote a row. K=3 keeps a one-off crash (a repo mid-edit, a
// transient OOM under load) from changing anything, while a row that reliably kills its
// pool is out of it after three attempts in the same half hour.
const DEMOTE_AFTER = 3;
const WINDOW_MS = 30 * 60 * 1000;
const MAX_ROWS = 512;

const ledgerPath = (repoDir) => path.join(repoDir, ".claude", "learning", "repo-pool-faults.json");
const auditPath = (repoDir) => path.join(repoDir, ".claude", "learning", "repo-pool-faults.jsonl");

function readLedger(repoDir) {
  try {
    const text = fs.readFileSync(ledgerPath(repoDir), "utf8");
    const j = JSON.parse(text);
    if (!j || typeof j !== "object" || j.v !== LEDGER_VERSION || !j.rows || typeof j.rows !== "object") {
      return { v: LEDGER_VERSION, rows: {}, problem: "unreadable shape" };
    }
    return { v: LEDGER_VERSION, rows: j.rows };
  } catch (e) {
    return { v: LEDGER_VERSION, rows: {}, problem: e && e.code === "ENOENT" ? null : String((e && e.message) || e) };
  }
}

/** Is this row demoted in this tree? False on any ledger problem (the row runs as it did). */
function isDemoted(repoDir, hook) {
  const l = readLedger(repoDir);
  const row = l.rows && l.rows[hook];
  return !!(row && row.demoted_at);
}

/**
 * Record one pool fault for the rows that were selected when the pool ended. Returns
 * { demoted: [hook], counts: {hook: n}, problem } — `demoted` names the rows that crossed
 * the threshold ON THIS CALL, so the caller can say so once rather than every event.
 */
function recordPoolFault(repoDir, hooks, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const out = { demoted: [], counts: {}, problem: null };
  const list = (Array.isArray(hooks) ? hooks : []).filter((h) => typeof h === "string" && h);
  if (!list.length) return out;
  const l = readLedger(repoDir);
  if (l.problem) {
    out.problem = `the crash ledger could not be read (${l.problem}); nothing was demoted`;
    return out;
  }
  const rows = { ...l.rows };
  for (const h of list) {
    const prev = rows[h] && Array.isArray(rows[h].t) ? rows[h].t : [];
    const t = prev.filter((x) => Number.isFinite(x) && now - x < WINDOW_MS).concat(now).slice(-DEMOTE_AFTER * 4);
    const row = { t, ...(rows[h] && rows[h].demoted_at ? { demoted_at: rows[h].demoted_at } : {}) };
    out.counts[h] = t.length;
    if (t.length >= DEMOTE_AFTER && !row.demoted_at) {
      row.demoted_at = new Date(now).toISOString();
      out.demoted.push(h);
    }
    rows[h] = row;
  }
  // Bounded: the ledger holds the rows of THIS tree's registry, but a stale entry from a
  // removed row must not accumulate forever.
  const keys = Object.keys(rows);
  if (keys.length > MAX_ROWS) for (const k of keys.slice(0, keys.length - MAX_ROWS)) delete rows[k];
  try {
    const dir = path.dirname(ledgerPath(repoDir));
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(os.tmpdir(), `pool-faults.${process.pid}.${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(tmp, JSON.stringify({ v: LEDGER_VERSION, written_at: new Date(now).toISOString(), rows }, null, 1));
    fs.renameSync(tmp, ledgerPath(repoDir));
  } catch (e) {
    out.problem = `the crash ledger could not be written (${(e && e.message) || e}); nothing was demoted`;
    return out;
  }
  try {
    const { appendSinkLine, mainCheckoutBoundaryRoots } = require("./append-sink.js");
    const dir = path.dirname(auditPath(repoDir));
    appendSinkLine({
      repoDir,
      additionalRoots: mainCheckoutBoundaryRoots(dir),
      sinkPath: auditPath(repoDir),
      line: JSON.stringify({
        event: out.demoted.length ? "repo-pool-row-demoted" : "repo-pool-fault",
        at: new Date(now).toISOString(),
        rows: list,
        counts: out.counts,
        demoted: out.demoted,
      }),
    });
  } catch (e) {
    // The ledger (the state the demotion decision reads) is already written; the audit
    // line is the second record and its loss is reported, never silent.
    out.problem = `${out.problem ? `${out.problem}; ` : ""}the audit line could not be appended (${(e && e.message) || e})`;
  }
  return out;
}

/** The operator/doctor surface: what this tree has recorded, and which rows are demoted. */
function statusReport(repoDir) {
  const l = readLedger(repoDir);
  const now = Date.now();
  const rows = Object.entries(l.rows || {}).map(([hook, r]) => ({
    hook,
    recent_faults: (Array.isArray(r.t) ? r.t : []).filter((x) => now - x < WINDOW_MS).length,
    demoted: !!r.demoted_at,
    demoted_at: r.demoted_at || null,
  }));
  return {
    repo: repoDir,
    ledger: ledgerPath(repoDir),
    audit: auditPath(repoDir),
    window_minutes: Math.round(WINDOW_MS / 60000),
    demote_after: DEMOTE_AFTER,
    problem: l.problem || null,
    rows: rows.sort((a, b) => b.recent_faults - a.recent_faults),
  };
}

if (require.main === module) {
  const repoDir = process.argv.includes("--repo") ? process.argv[process.argv.indexOf("--repo") + 1] : path.resolve(__dirname, "..", "..");
  const r = statusReport(repoDir);
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  } else {
    process.stdout.write(
      `repo-pool crash ledger — ${r.ledger}\n` +
        `demote after ${r.demote_after} faults in ${r.window_minutes} min; ${r.rows.length} row(s) recorded\n` +
        (r.rows.length ? r.rows.map((x) => `  ${x.demoted ? "DEMOTED" : "       "} ${x.hook} — ${x.recent_faults} fault(s) in window${x.demoted_at ? ` (demoted ${x.demoted_at})` : ""}`).join("\n") + "\n" : "  (no faults recorded)\n") +
        (r.problem ? `  PROBLEM: ${r.problem}\n` : ""),
    );
  }
}

module.exports = { DEMOTE_AFTER, WINDOW_MS, ledgerPath, auditPath, readLedger, isDemoted, recordPoolFault, statusReport };
