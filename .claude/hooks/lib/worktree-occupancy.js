/**
 * worktree-occupancy.js — the NEUTRAL primitives the worktree forest lineage is
 * built on: enumeration, main-checkout resolution, process occupancy, and the
 * pressure bands.
 *
 * WHY THIS FILE EXISTS — ONE LINEAGE, NOT THREE.
 * `worktree-forest.js` already records the rule this file obeys: "DELEGATED, NOT
 * REIMPLEMENTED … A second classifier here would be a second lineage that drifts
 * — the `security.md` § Multi-Site Kwarg Plumbing failure mode, and the substance
 * of loom#1549." A 2026-08-19 rs-variant ingest arrived carrying a THIRD lineage:
 * four language-NEUTRAL modules under `.claude/variants/rs/hooks/` (1,773 lines,
 * zero rs tokens in executable code) that duplicated `worktree-forest.js`,
 * `worktree-reap.mjs` and `unlanded-work-surface.js` and imported none of them.
 * Because a variant hook lands at `.claude/hooks/<name>.js` on its lane, those
 * copies would have sat in THIS DIRECTORY beside the originals.
 *
 * The capability in them was real; the duplication was not. So the capability
 * was folded HERE (primitives), into `worktree-reap.mjs` (the one classifier),
 * into `worktree-forest.js` (the one hook library) and into
 * `unlanded-work-surface.js` (the one landedness surface), and the four variant
 * files were deleted. The rs-specific hooks now consume this global API across
 * the narrow neutral seam they already used.
 *
 * SCOPE — this file holds ONLY what has no verdict in it. It enumerates, it
 * resolves, it observes processes, it computes a band. It classifies NOTHING and
 * removes NOTHING. Every verdict lives in `worktree-reap.mjs`, which is the
 * authority `worktree-isolation.md` Rule 8 names and the one `worktree-reap.test.mjs`
 * holds a positive-control fixture per verdict for.
 *
 * HARDENINGS THAT ARE NOT OPTIONAL HERE (both were absent from the ingested copies):
 *
 *   RESOLVED GIT BINARY + CONSTANTS-BUILT ENV. Every git spawn routes through
 *     `resolveGitBinary()` + `gitEnv()`. `cwd:` picks a DIRECTORY, not a
 *     REPOSITORY — an ambient `GIT_DIR` outranks discovery, so a bare spawn lets
 *     one environment variable choose which repository answers "which worktrees
 *     exist", and the answer becomes a removal candidate list. The ingested copies
 *     used bare `execFileSync("git", …)` at every site.
 *
 *   NAME SANITIZATION AT THE OUTPUT BOUNDARY. Worktree paths and branch names
 *     reach `agent_must_report` verbatim, which the agent reads as authoritative.
 *     `sanitizeName` (owned by `unlanded-work-surface.js`, imported, not copied)
 *     strips control characters and neutralizes backticks before any name is
 *     interpolated. The ingested copies interpolated raw branch names.
 *
 * FAIL DIRECTIONS, stated per function rather than assumed:
 *   enumeration  — null on ANY git error. NULL IS NOT AN EMPTY FOREST.
 *   occupancy    — an indeterminate snapshot reports `determinate:false`, and
 *                  `occupantsOf` then answers OCCUPIED. Never "free".
 *
 * Style: CommonJS, matching the rest of `.claude/hooks/lib/`. Every exported
 * function is either pure or a single named subprocess, so each is testable
 * without a git fixture except the three that name git/ps/lsof explicitly.
 */

"use strict";

const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const { resolveGitBinary, gitEnv } = require("./git-subprocess-env");
// sanitizeName — DEFINED HERE, not imported (2026-08-27 merge resolution).
// It previously came from `unlanded-work-surface.js`, but that export exists only
// on this branch: main's copy of that file evolved 8 other exports and never
// carried this one, so importing it across the merge yielded `undefined` and
// silently propagated an undefined re-export through worktree-forest.js.
// This module is the only real consumer, so the function lives with its consumer
// rather than reaching into a file another lane owns.
const NAME_MAX = 100;
function sanitizeName(raw) {
  let s = String(raw == null ? "" : raw);
  s = s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  s = s.replace(/`/g, "'").replace(/\s+/g, " ").trim();
  if (s.length > NAME_MAX) s = s.slice(0, NAME_MAX) + "…";
  return s || "(unnamed)";
}

const GIT_TIMEOUT_MS = 3000;
// MEASURED, not picked. On this clone (43 worktrees, ~2,300 open cwds, a host
// running many concurrent agents) `snapshotProcesses` took 10.98 / 5.72 / 5.87 s
// across three runs, and a run at the previous 20 s ceiling was killed mid-`lsof`
// and reported UNDETERMINED for the whole forest. A ceiling is not a cost — the
// common case still returns in ~6 s — so it is set well clear of the measured
// tail rather than close to the measured mean. Callers pay it AT MOST ONCE per
// process (every caller memoizes), and `worktree-reap.mjs` additionally defers
// the call until a tree has cleared every cheaper gate, so a healthy forest pays
// nothing at all.
const SNAPSHOT_TIMEOUT_MS = 45000;

/**
 * Run a git subprocess through the resolved binary and the constants-built env.
 * Returns { ok, out, status, err }. NEVER throws.
 *
 * `status` is the exit code when the process RAN and exited non-zero; it is null
 * when it never ran (ENOENT) or was killed (timeout). Callers that must tell
 * "ran and found nothing" from "did not run" — `lsof` notably — read it directly.
 */
function runTool(bin, args, opts = {}) {
  try {
    return {
      ok: true,
      status: 0,
      out: execFileSync(bin, args, {
        cwd: opts.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: opts.timeout || GIT_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: opts.maxBuffer || 32 * 1024 * 1024,
        ...(opts.env ? { env: opts.env } : {}),
      }),
      err: "",
    };
  } catch (e) {
    return {
      ok: false,
      status: typeof e.status === "number" ? e.status : null,
      out: typeof e.stdout === "string" ? e.stdout : "",
      err: (typeof e.stderr === "string" ? e.stderr : "") || e.message || "",
    };
  }
}

/** git, resolved + env-fenced. Returns the same shape as `runTool`. */
function runGit(args, opts = {}) {
  const gitBin = resolveGitBinary();
  if (!gitBin) return { ok: false, status: null, out: "", err: "no executable git resolved" };
  return runTool(gitBin, args, { ...opts, env: gitEnv() });
}

/** realpath when it resolves, else the lexical resolve. Never throws. */
function realOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// ── enumeration ─────────────────────────────────────────────────────────────

/**
 * The shared `.git` common directory, absolute, or null.
 *
 * THE single place this lookup happens, so the property "this lineage never uses
 * `--show-toplevel` to find the main checkout" has ONE mutation point and is
 * therefore testable by mutation rather than being an unfalsifiable claim about
 * two identical call sites.
 */
function gitCommonDir(cwd) {
  const r = runGit(["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!r.ok) return null;
  return r.out.trim() || null;
}

/**
 * The repo's MAIN working tree — the parent of the shared `.git` common dir.
 *
 * NEVER `--show-toplevel`: run from inside a LINKED worktree, which is where a
 * wave session almost always runs, `--show-toplevel` returns THAT worktree's own
 * top, so a main-checkout exclusion keyed on it MISSES and the checkout itself
 * becomes a removal candidate. Returns null on any git error, and callers MUST
 * fail closed on null — without the main top nothing can prove a path is not the
 * checkout, and naming the checkout removable is the one verdict that must never
 * be emitted.
 */
function resolveMainWorktreeRoot(cwd) {
  const common = gitCommonDir(cwd);
  if (!common) return null;
  return realOr(path.dirname(common));
}

/**
 * Every worktree git knows about, parsed from NUL-delimited porcelain.
 *
 * `-z`, never plain `--porcelain` split on newlines. Git does not quote or escape
 * paths in porcelain output (its own docs flag this), so a worktree path
 * containing a literal newline forges an extra `worktree <path>` record mid-parse
 * — a fabricated tree in a list that feeds a removal decision.
 *
 * Returns an array of records, or NULL on any git error. NULL IS NOT AN EMPTY
 * FOREST: an errored command is zero evidence (`evidence-first-claims.md` MUST-3),
 * and an empty forest is the disposition under which a caller would report "nothing
 * to reap" — the two must not print the same.
 */
function listWorktrees(cwd) {
  const r = runGit(["-C", cwd, "worktree", "list", "--porcelain", "-z"]);
  if (!r.ok) return null;
  const rows = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.path) rows.push(cur);
    cur = null;
  };
  for (const field of r.out.split("\0")) {
    if (field === "") {
      flush();
      continue;
    }
    const m = field.match(/^worktree (.+)$/s);
    if (m) {
      flush();
      cur = {
        path: m[1],
        head: null,
        branch: null,
        detached: false,
        locked: false,
        prunable: false,
        bare: false,
      };
      continue;
    }
    if (!cur) continue;
    if (field.startsWith("HEAD ")) cur.head = field.slice(5).trim();
    else if (field.startsWith("branch ")) cur.branch = field.slice(7).trim().replace(/^refs\/heads\//, "");
    else if (field === "detached") cur.detached = true;
    else if (field === "bare") cur.bare = true;
    else if (field === "locked" || field.startsWith("locked ")) cur.locked = true;
    else if (field === "prunable" || field.startsWith("prunable ")) cur.prunable = true;
  }
  flush();
  return rows;
}

/**
 * Absolute paths of every worktree EXCEPT the main checkout and the one this
 * process is standing in.
 *
 * Both exclusions compare REALPATHS, symmetrically on each side. A session
 * running from a LINKED worktree sees the main checkout as an ordinary entry in
 * `git worktree list`, so excluding only `cwd` would leave the MAIN checkout
 * reachable as a "sibling" candidate — the exact shape a `cwd`-keyed guard misses.
 *
 * Returns [] on a git error rather than null, because every caller of THIS
 * function treats it as "nothing to scan" and none of them report a count from
 * it; callers needing the null/empty distinction use `listWorktrees`.
 */
function listGitWorktreePaths(cwd) {
  const rows = listWorktrees(cwd);
  if (rows === null) return [];
  const excluded = new Set([realOr(cwd)]);
  const mainRoot = resolveMainWorktreeRoot(cwd);
  if (mainRoot) excluded.add(mainRoot);
  return rows.map((r) => r.path).filter((p) => !excluded.has(realOr(p)));
}

/**
 * A linked worktree's git ADMIN id — the directory name under
 * `<common>/worktrees/`, READ from the `gitdir:` pointer in the worktree's own
 * `.git` file.
 *
 * NOT `path.basename(worktreePath)`. Git does not guarantee they match: add two
 * worktrees whose directories share a basename and the second gets `<name>1`. The
 * failure is silent and its direction is bad — a wrong id makes every admin-dir
 * stat miss, so a recency measure falls back to the worktree top's own mtime,
 * which is BUILD-OUTPUT recency, precisely the proxy that measure exists to avoid.
 *
 * Returns null when the pointer cannot be read (a bare or main worktree has no
 * `.git` FILE), which callers treat as "no admin dir to stat", never as an id.
 */
function worktreeAdminId(wtPath) {
  let raw;
  try {
    const st = fs.statSync(path.join(wtPath, ".git"));
    if (!st.isFile()) return null; // a directory ⇒ this is the main worktree
    raw = fs.readFileSync(path.join(wtPath, ".git"), "utf8");
  } catch {
    return null;
  }
  const m = raw.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m) return null;
  const id = path.basename(m[1].replace(/[/\\]+$/, ""));
  return id || null;
}

/**
 * Minutes since this worktree was last USED — the newest of the worktree top's
 * own mtime and its per-worktree admin `HEAD`. Null when neither can be stat'ed,
 * which callers MUST treat as unknown (⇒ hold), never as "quiet forever".
 *
 * ONLY `HEAD` from the admin dir. NOT `index`, and NOT the admin DIRECTORY.
 * `git status` REWRITES the index and creates/removes `index.lock` there, so both
 * stamps track "git looked at this tree" rather than "someone worked here" — and
 * every classifier runs `git status` on each worktree BEFORE reading this value,
 * which makes the instrument perturb its own input. Measured on a throwaway repo
 * with all four stamps backdated 30 days: still reported 0 minutes, so a recency
 * gate keyed on it could never be satisfied and the reclaimer was INERT at its
 * own default. `HEAD` is rewritten on checkout, commit and branch switch — the
 * signal actually wanted — and `git status` does not touch it.
 */
function minutesSinceTouch(cwd, wtPath, wtId = null) {
  const stamps = [];
  const push = (p) => {
    try {
      stamps.push(fs.statSync(p).mtimeMs);
    } catch {
      /* absent — contributes nothing */
    }
  };
  push(wtPath);
  const id = wtId || worktreeAdminId(wtPath);
  const common = gitCommonDir(cwd);
  if (common && id) push(path.join(common, "worktrees", id, "HEAD"));
  if (stamps.length === 0) return null;
  // Clamped at zero. `statSync().mtimeMs` is a float with sub-millisecond
  // precision while `Date.now()` is a floored integer, so a tree touched at
  // 1000.7 ms read back at 1000 ms yields a NEGATIVE age — and a negative age is
  // unconditionally below any floor, which silently holds a tree ~50% of the time
  // under a waived floor. A future mtime from clock skew lands here too and reads
  // as "touched now", which every floor above zero still holds.
  return Math.max(0, (Date.now() - Math.max(...stamps)) / 60000);
}

// ── occupancy: ONE snapshot for the whole fleet ─────────────────────────────

/**
 * A single cwd + argv snapshot of every process.
 *
 * COST is why it is one snapshot rather than one probe per tree: the per-worktree
 * recipe (`lsof +D <wt>`) WALKS the tree and measured ~9 s on a 12 GB worktree —
 * thirty of those is 4.5 minutes, which guarantees the check gets skipped. This
 * form answers the same question (is any process's cwd inside this path?) at one
 * fixed cost for the whole forest.
 *
 * PER-TOOL EXIT CONVENTIONS, which are NOT the same and must not be unified:
 *   ps   — non-zero exit IS failure. A failed ps is ZERO EVIDENCE, never an
 *          all-clear.
 *   lsof — exit 1 means "found nothing", NOT failure (`man lsof`: returns one if
 *          any error was detected, INCLUDING the failure to locate files). So
 *          rc ∈ {0,1} both mean it RAN; discriminate on CONTENT, never on rc.
 *
 * POSITIVE CONTROL, and it is the load-bearing part. An empty cwd table is
 * byte-identical whether every worktree is genuinely free or lsof was confined,
 * sandboxed or denied — and the disposition on "free" is REMOVE. So the snapshot
 * is trusted only when it contains THIS process's own cwd, which lsof can
 * certainly see. Control fails ⇒ `determinate:false` ⇒ every tree reads OCCUPIED.
 *
 * @returns {{determinate:boolean, why:string|null, cwds:Array, argv:Array, selfPids:Set}}
 */
function snapshotProcesses({ timeout = SNAPSHOT_TIMEOUT_MS } = {}) {
  const snap = {
    determinate: false,
    why: null,
    cwds: [],
    argv: [],
    selfPids: new Set([process.pid, process.ppid]),
  };

  const ps = runTool("ps", ["-eo", "pid=,command="], { timeout });
  if (!ps.ok) {
    snap.why = `ps DID NOT RUN (${ps.err.trim().slice(0, 120) || `exit ${ps.status}`}) — treating every worktree as occupied`;
    return snap;
  }
  for (const line of ps.out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (m) snap.argv.push({ pid: Number(m[1]), command: m[2] });
  }

  // `-F pn` ⇒ machine-readable: `p<pid>` then `n<path>`, one field per line.
  const ls = runTool("lsof", ["-d", "cwd", "-w", "-F", "pn"], { timeout });
  if (ls.status === null && !ls.ok) {
    snap.why = `lsof DID NOT RUN (${ls.err.trim().slice(0, 120)}) — treating every worktree as occupied`;
    return snap;
  }
  let pid = null;
  for (const line of (ls.out || "").split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid != null) snap.cwds.push({ pid, cwd: line.slice(1) });
  }

  if (!snap.cwds.some((e) => e.pid === process.pid)) {
    snap.why =
      "lsof cannot report even THIS process's own cwd — the instrument is suspect, " +
      "so its empty result is not an all-clear; treating every worktree as occupied";
    return snap;
  }

  snap.determinate = true;
  return snap;
}

/**
 * Processes whose cwd is inside `wtPath`, excluding this process and its parent.
 *
 * An INDETERMINATE snapshot answers OCCUPIED. That is the whole point of the
 * tri-state: "the instrument did not work" and "nobody is here" have opposite
 * consequences and must never collapse.
 */
function occupantsOf(snapshot, wtPath) {
  if (!snapshot || !snapshot.determinate) {
    return {
      determinate: false,
      occupied: true,
      pids: [],
      why: (snapshot && snapshot.why) || "no process snapshot",
    };
  }
  const real = realOr(wtPath);
  const inside = (p) => {
    const r = realOr(p);
    return r === real || r.startsWith(real + path.sep);
  };
  const pids = new Set();
  for (const e of snapshot.cwds) {
    if (snapshot.selfPids.has(e.pid)) continue;
    if (inside(e.cwd)) pids.add(e.pid);
  }
  // argv is CORROBORATION ONLY. A build started INSIDE the worktree with relative
  // paths carries no path in its command line, which is why cwd is primary.
  for (const e of snapshot.argv) {
    if (snapshot.selfPids.has(e.pid)) continue;
    if (e.command.includes(real) || e.command.includes(wtPath)) pids.add(e.pid);
  }
  return { determinate: true, occupied: pids.size > 0, pids: [...pids].sort((a, b) => a - b), why: null };
}

// ── pressure bands (PURE) ───────────────────────────────────────────────────

/**
 * Warn ONCE PER BAND, not once per session and not once per tree.
 *
 * A once-per-session informational fired at 8 worktrees and stayed silent while
 * the count went 8 → 31; a per-tree warning is noise nobody reads. Banding
 * re-fires on each upward crossing and RESETS downward, so a reclaim restores the
 * surface's ability to warn again rather than permanently silencing it at the
 * high-water mark.
 */
const COUNT_BANDS = [4, 8, 12, 16, 24, 32, 48, 64, 96, 128];

/** The highest band at or below `value` — where the ratchet resets to. */
function bandFor(value, bands = COUNT_BANDS) {
  let b = 0;
  for (const t of bands) if (value >= t) b = t;
  return b;
}

/** The band to warn at, or null when this value has already been warned for. */
function crossedBand(value, lastWarnedBand, bands = COUNT_BANDS) {
  const now = bandFor(value, bands);
  if (now === 0) return null;
  if (lastWarnedBand != null && now <= lastWarnedBand) return null;
  return now;
}

module.exports = {
  COUNT_BANDS,
  GIT_TIMEOUT_MS,
  SNAPSHOT_TIMEOUT_MS,
  runGit,
  realOr,
  gitCommonDir,
  resolveMainWorktreeRoot,
  listWorktrees,
  listGitWorktreePaths,
  worktreeAdminId,
  minutesSinceTouch,
  snapshotProcesses,
  occupantsOf,
  bandFor,
  crossedBand,
  // Re-exported so a consumer of THIS module never has to reach for a second
  // import to make a name safe for `agent_must_report`. One owner
  // (`unlanded-work-surface.js`), one implementation, two reachable names.
  sanitizeName,
};
