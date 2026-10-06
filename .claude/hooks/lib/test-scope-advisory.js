"use strict";

/**
 * test-scope-advisory — say, at the moment a broad test run is dispatched, how many
 * paths this diff actually touches and that a scoped run is derivable from them.
 *
 * @hook-event: PreToolUse (Bash) — hosted by `.claude/hooks/validate-bash-command.js`.
 *
 * THE GAP. A local gate here runs tens of minutes to hours. A lane that has changed
 * four files routinely dispatches the whole corpus, because choosing a subset is a
 * JUDGMENT ABOUT RELEVANCE and that judgment is exactly what is unreliable right
 * after changing something you do not fully model. `.claude/bin/owed-suites.mjs`
 * already derives the subset FROM THE DIFF instead of from judgment — but nothing in
 * the loop makes anyone run it, which is the same "writing it down did not make me do
 * it" failure that tool's own header records about the practice it implements.
 *
 * THE SIGNAL ALREADY EXISTED AND WENT NOWHERE. `validate-bash-command.js` has parsed
 * `--cov`, `-k`, `-x` and `--workspace` off test commands for as long as
 * `extractTestFlags` has existed, and routed every one of them into a learning-
 * telemetry sink. This module reads the same parse and delivers it to the operator.
 *
 * SEVERITY: ADVISORY, and structurally so — this returns a STRING that the host
 * composes onto an ALLOW result. It cannot block, cannot halt, and never appears as a
 * `deferredFindings` entry, because that channel's merge rule promotes any non-
 * `pre-action` finding to `halt-and-report` and a halt on every broad `pytest` is the
 * mute-within-a-day shape `hook-output-discipline.md` § MUST NOT names. Whether a run
 * MUST be broad is judgment-bearing over intent, and the evidence here is lexical, so
 * MUST-2 caps this below `block` independently.
 *
 * PARALLELISM LEADS, SCOPING FOLLOWS — and that order is MEASURED, not preferred.
 * On a reference Python gate (16 CPUs, ~41.7k tests over four directories) the same
 * four directories cost 1115s (18m35s) serial and 271s (4m31s) at `-n 8 --dist
 * loadfile`; `tests/unit` alone went 324.10s -> 65.23s, a 4.97x speedup, with xdist
 * ALREADY INSTALLED. A ~5x that costs one flag dominates any subset a diff-derived
 * scope could pick, so the advisory names it FIRST and names narrowing second.
 *
 * THREE REFINEMENTS FROM THAT SAME MEASUREMENT, respected rather than smoothed:
 *   - `-n auto` (16 workers) was SLOWER than `-n 8` (39/45s vs 33/40s). This module
 *     never suggests `-n auto`, and says so where it names the flag.
 *   - `--cov` under `-n 8` cost only 1.48x (31s of 96s) — 2.2-2.8x on CPU-bound work,
 *     1.4-1.8x on I/O-bound. So NOTHING here tells anyone that dropping coverage is a
 *     large win; a coverage run stays a silence condition on its own terms (below).
 *   - MARKERS ARE NOT A BAND SELECTOR. 62.6% of that gate carried no tier marker, and
 *     `-m e2e`, `-m conformance` and `-m performance` each selected ZERO. This module
 *     therefore never suggests `-m`; it only RECOGNISES one as an already-narrowed run.
 *     Recognising a selector and recommending it are different acts.
 *
 * PER-RUNNER, OR SILENT. The parallelism line is pytest-only, deliberately. `cargo
 * test` already threads by default, `node --test` and jest/vitest already fan out
 * across files, and `go test` already parallelises across packages — so there is no
 * free multiple to offer any of them, and offering one anyway is worse than silence.
 * The one cargo remark that IS carried is a TRADE, not a recommendation: `cargo
 * nextest` measured up to 16.5x on one corpus and is deliberately NOT the gate runner
 * on another, because it process-isolates (so it is blind to exactly the cross-test
 * interaction class a shared-process `cargo test` exposes) and it does not run
 * doctests. Presenting it as a drop-in would be the wrong thing said confidently.
 *
 * THE SILENCE CONDITIONS ARE THE DESIGN. An advisory that fires on every test
 * invocation is muted within a day, so this stays silent unless ALL of these hold:
 *
 *   1. the command is a recognised TEST RUNNER invocation;
 *   2. it is UNSCOPED — no keyword filter, marker, path argument, package/crate/test
 *      selector, or `--` name filter;
 *   3. it is not DELIBERATELY broad — an explicit `--workspace` / `--all` /
 *      `--all-features`, a coverage run (which is whole-corpus BY DEFINITION; scoping
 *      it defeats it), or a `--release` gate, are all statements of intent and are
 *      left alone;
 *   4. it is not ALREADY PARALLEL — `-n` / `--numprocesses` / `--dist` / `-p xdist`,
 *      cargo's `--test-threads` / `-j`, node's `--test-concurrency` / `--maxWorkers`
 *      / `--pool`, go's `-parallel` / `-p`. This condition is what keeps the reordering
 *      honest: the advisory now LEADS with parallelism, so firing it at someone who has
 *      already parallelised is telling a reader who did the right thing to do it — the
 *      fastest way to train them past the whole surface. It costs the scoping half on
 *      those runs, and that is the accepted trade: one advisory, or none.
 *   5. the working tree HAS a diff — with nothing changed there is no scoped run to
 *      offer, and the broad run is the only run;
 *   6. this session has not already been told, in this repo.
 *
 * COST. One `git status --porcelain --untracked-files=no`, bounded by a 2s timeout,
 * fail-open on any error. `-uno` is deliberate: the untracked walk is the expensive
 * half of `git status`, and this is a PreToolUse hook on a developer's own command.
 * The bound is stated rather than hidden — a brand-new, never-added test file is not
 * counted in the path total. It costs an undercount in the advisory's headline
 * number, never a false one.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

/* Recognised runners. Each entry names the runner and the tokens that mean "I have
 * already narrowed this run".
 *
 * The trailing fence is `(?![\w.-])`, NOT `\b`. This is not a stylistic preference: a
 * `\b` after `pytest` puts a boundary before the hyphen, so `pytest-watch` — and, as
 * MEASURED live during this change, a shell command merely containing the string
 * `pytest-layout` — read as a pytest invocation. The pre-existing `isPytest` check in
 * the host hook carries exactly that `\b` and exactly that false positive; this module
 * does not inherit it. Firing on text that only MENTIONS a runner is the fastest route
 * to the advisory being muted. */
const RUNNERS = [
  {
    id: "pytest",
    invoke: /(^|[;&|\s(])(pytest|py\.test)(?![\w.-])|(^|[;&|\s(])python3?\s+-m\s+pytest(?![\w.-])/,
    scoped: [
      /\s-k(\s|=)/, // keyword filter
      /\s-m(\s|=)/, // marker filter
      /\s--deselect(\s|=)/,
      /\s--last-failed\b|\s--lf\b|\s--failed-first\b|\s--ff\b|\s--stepwise\b/,
      /\s(?:[\w./-]*\/)?(?:test_[\w.-]+\.py|[\w.-]+_test\.py)(::|\b)/, // an explicit test file
      /\s(?:tests?|test)\/[\w./-]+/, // an explicit path under tests/
    ],
    broadByIntent: [/--cov\b/, /--cov=/, /--coverage\b/],
    // `-n auto` moved OUT of broadByIntent and in here: it is not a statement that the
    // corpus must be whole, it is xdist already running. Same silence, correct reason —
    // and the reason is now load-bearing, because the advisory this gates LEADS with
    // xdist and would otherwise be recommending a flag the operator already passed.
    alreadyParallel: [
      /\s-n(\s|=)/,
      /\s--numprocesses(\s|=)/,
      /\s--dist(\s|=)/,
      /\s-p\s+xdist\b/,
      /\s--forked\b/,
    ],
  },
  {
    id: "cargo",
    invoke: /(^|[;&|\s(])cargo\s+(\+\S+\s+)?(test|nextest)(?![\w-])/,
    scoped: [
      /\s--test(\s|=)/,
      /\s--bin(\s|=)/,
      /\s--lib\b/,
      /\s--doc\b/,
      /\s-p(\s|=)/,
      /\s--package(\s|=)/,
      /\s-E(\s|=)/, // nextest filter expression
      /\s--filter-expr(\s|=)/,
      /\s--\s+\S/, // a trailing test-name filter
    ],
    broadByIntent: [/--workspace\b/, /--all\b/, /--all-features\b/, /--all-targets\b/, /--release\b/],
    // An EXPLICIT thread/job count. `cargo test` threads by DEFAULT, which is why this
    // runner is offered no parallelism line at all; these flags say the operator has
    // already tuned it, which is a further reason not to speak.
    alreadyParallel: [/\s--test-threads(\s|=)/, /\s-j(\s|=)/, /\s--jobs(\s|=)/],
  },
  {
    id: "node",
    invoke: /(^|[;&|\s(])node\s+(--\S+\s+)*--test(?![\w-])|(^|[;&|\s(])(npx\s+)?(jest|vitest|mocha)(?![\w.-])|(^|[;&|\s(])npm\s+(run\s+)?test(?![\w-])/,
    scoped: [
      /\s-t(\s|=)/,
      /\s--test-name-pattern(\s|=)/,
      /\s--testNamePattern(\s|=)/,
      /\s--test-only\b/,
      /\s[\w./-]*\.(test|spec)\.(mjs|cjs|js|jsx|ts|tsx)\b/, // an explicit suite file
      /\s(?:tests?|test|__tests__)\/[\w./-]+/,
    ],
    broadByIntent: [/--coverage\b/, /--experimental-test-coverage\b/, /--cov\b/],
    alreadyParallel: [
      /\s--test-concurrency(\s|=)/,
      /\s--concurrency(\s|=)/,
      /\s(?:-w|--maxWorkers|--max-workers)(\s|=)/,
      /\s--pool(\s|=)/,
      /\s--threads\b/,
    ],
  },
  {
    id: "go",
    invoke: /(^|[;&|\s(])go\s+test(?![\w-])/,
    scoped: [/\s-run(\s|=)/, /\s\.\/[\w./-]+/, /\s-tags(\s|=)/],
    broadByIntent: [/\s\.\/\.\.\.(\s|$)/, /-cover\b/],
    alreadyParallel: [/\s-parallel(\s|=)/, /\s-p(\s|=)/],
  },
];

/**
 * Which runner (if any) this command invokes, and whether it was narrowed.
 *
 * Returns null — SILENT — for anything that is not an unscoped run of a recognised
 * runner. Pure over the command string; no filesystem, no subprocess.
 *
 * @returns {{runner: string} | null}
 */
function classifyUnscopedTestRun(command) {
  const raw = String(command || "");
  if (!raw.trim()) return null;
  // `python -m pytest` carries a `-m` that is the INTERPRETER's module flag, not
  // pytest's marker filter. Without this normalisation the most common CI spelling of
  // an unscoped pytest run classified itself as already-scoped and went permanently
  // silent — the inert-detector failure, arriving as a clean pass. MEASURED during
  // authoring: `python3 -m pytest` returned null before this line and fires after it,
  // while `python3 -m pytest -m slow` stays silent, which is correct.
  const cmd = raw.replace(/(^|[;&|\s(])python3?\s+-m\s+pytest(?![\w.-])/g, "$1pytest");
  for (const r of RUNNERS) {
    if (!r.invoke.test(cmd)) continue;
    if (r.broadByIntent.some((rx) => rx.test(cmd))) return null; // deliberate — leave it alone
    if ((r.alreadyParallel || []).some((rx) => rx.test(cmd))) return null; // already optimal on the lead axis
    if (r.scoped.some((rx) => rx.test(cmd))) return null; // already narrowed
    return { runner: r.id };
  }
  return null;
}

/**
 * How many paths the working tree has changed.
 *
 * Returns null on ANY failure — not zero. Zero means "clean tree, nothing to scope
 * to" and is a real answer that silences the advisory; a failed probe is not that
 * answer, and collapsing the two would let a broken `git` masquerade as a clean tree
 * (`instrument-discipline.md` MUST-1 — the result must differ when the proposition is
 * false).
 *
 * @returns {{count: number, sample: string[]} | null}
 */
function changedPathCount(cwd, opts = {}) {
  const gitBin = opts.gitBin || "git";
  const env = opts.env || process.env;
  try {
    const out = execFileSync(
      gitBin,
      ["-C", cwd, "status", "--porcelain=1", "-z", "--untracked-files=no"],
      { encoding: "utf8", env, timeout: 2000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
    const paths = out
      .split("\0")
      .filter(Boolean)
      .map((rec) => rec.slice(3))
      .filter(Boolean);
    return { count: paths.length, sample: paths.slice(0, 4) };
  } catch {
    return null;
  }
}

/** Per-session, per-repo delivery marker. Same class and same directory family as
 *  `ci-cost-reach.js`'s: per-clone, gitignored, never committed. The session id is
 *  sanitized to ONE path segment — it is caller-supplied and must not traverse out. */
function _markerPath(repoRoot, sessionId) {
  const safe = String(sessionId || "no-session")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .slice(0, 64);
  return path.join(repoRoot, ".claude", "learning", "test-scope-advisory", `${safe}.marker`);
}

/** True IFF this session has already been told, in this repo. Never throws: an unresolvable
 *  marker path yields NOT-delivered, so the cost of the failure is one extra line
 *  rather than permanent silence. */
function alreadyAdvised(repoRoot, sessionId) {
  try {
    return fs.existsSync(_markerPath(repoRoot, sessionId));
  } catch {
    return false;
  }
}

/** Record delivery. Never throws; a failure costs at most one repeat line. */
function recordAdvised(repoRoot, sessionId) {
  try {
    const p = _markerPath(repoRoot, sessionId);
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, "", { mode: 0o600, flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/* THE LEAD LINE, per runner. `null` means this runner is offered no parallelism
 * advice at all, which is the correct answer for three of the four: `cargo test`
 * threads by default, `node --test` / jest / vitest fan out across files by default,
 * and `go test` parallelises across packages by default. There is no free multiple to
 * name, and naming one anyway is the failure mode this whole surface is trying to
 * avoid. Only pytest ships serial by default with a one-flag ~5x sitting next to it.
 *
 * The figure is quoted WITH its provenance ("one 41.7k-test gate") rather than as a
 * general property of pytest, because it is one measurement on one corpus — the
 * reader's own may differ, and a number offered without its origin cannot be checked. */
const LEAD_LINE = {
  pytest:
    "Parallelism first — the larger and cheaper of the two, if pytest-xdist is installed:\n" +
    "  pytest -n 8 --dist loadfile   # MEASURED 4.97x on one 41.7k-test gate (324s serial -> 65s at -n 8);\n" +
    "                                # `-n auto` (16 workers) measured SLOWER there than `-n 8`.",
  cargo: null,
  node: null,
  go: null,
};

/* A per-runner TRADE — never a recommendation. Only cargo carries one, and only
 * because `cargo nextest` is the thing a reader reaches for next and it is NOT a
 * drop-in: it process-isolates, so it cannot observe the cross-test interaction class
 * a shared-process `cargo test` exposes, and it does not run doctests. Saying that
 * once is cheaper than the reader swapping runners and losing a test class silently. */
const RUNNER_NOTE = {
  cargo:
    "No parallelism line: `cargo test` already threads. `cargo nextest` is faster (up to 16.5x on one corpus)\n" +
    "  but is NOT a drop-in — it process-isolates, so it cannot see the cross-test interaction class a\n" +
    "  shared-process `cargo test` exposes, and it does not run doctests.",
};

/**
 * The advisory text, or null for silence.
 *
 * ORDER IS THE POINT. The first cut led with scoping; a reference measurement then put
 * a ~5x one-flag parallelism win next to a second-order subset choice, so the larger,
 * cheaper win leads and narrowing follows. Both still fit ONE short advisory, because a
 * long one is muted and a muted advisory is worth exactly nothing
 * (`hook-output-discipline.md` § MUST NOT).
 *
 * `.claude/bin/owed-suites.mjs` is named because it SHIPS: it is on the fail-closed
 * `sync-tier-aware.mjs::ALWAYS_INCLUDE` bin allowlist, so every repo that receives
 * this hook receives that tool too. Naming an instrument a consumer does not have is
 * the dangling-obligation defect the allowlist's own entries record repeatedly. That
 * tool derives its own fan-out bound from the consumer's corpus rather than inheriting
 * loom's, so the narrowing half is calibrated where it lands.
 */
function formatScopeAdvisory({ runner, changed }) {
  if (!changed || changed.count <= 0) return null;
  const shown = changed.sample.join(", ");
  const lead = LEAD_LINE[runner] || null;
  const lines = [
    `SCOPE: this ${runner} run is UNSCOPED${lead ? " and SERIAL" : ""}, and your working tree has ` +
      `${changed.count} changed path(s)` +
      (shown ? ` (${shown}${changed.count > changed.sample.length ? ", …" : ""})` : "") +
      ".",
  ];
  if (lead) lines.push(lead);
  lines.push(
    (lead
      ? "Narrowing second — second-order next to the above, but derivable from the diff rather than from a judgment about relevance:"
      : "A scoped run is derivable from that diff rather than from a judgment about relevance:") +
      "\n  node .claude/bin/owed-suites.mjs   # names the suites that OWN what you changed",
  );
  if (RUNNER_NOTE[runner]) lines.push(RUNNER_NOTE[runner]);
  lines.push(
    "This is a note, not a verdict — it has judged nothing about your run, and a broad run" +
      " is often right (a release gate, a coverage pass, a whole-tree scanner). Said once per session.",
  );
  return lines.join("\n");
}

/**
 * One call for the host. Returns the advisory string or null.
 *
 * Writes the delivery marker ONLY when it actually returns text, so a silenced
 * invocation never consumes the session's one delivery.
 */
function buildTestScopeAdvisory(command, cwd, opts = {}) {
  const hit = classifyUnscopedTestRun(command);
  if (!hit) return null;
  const sessionId = opts.sessionId || "no-session";
  if (alreadyAdvised(cwd, sessionId)) return null;
  const changed = opts.changed !== undefined ? opts.changed : changedPathCount(cwd, opts);
  const text = formatScopeAdvisory({ runner: hit.runner, changed });
  if (!text) return null;
  recordAdvised(cwd, sessionId);
  return text;
}

module.exports = {
  classifyUnscopedTestRun,
  changedPathCount,
  formatScopeAdvisory,
  buildTestScopeAdvisory,
  alreadyAdvised,
  recordAdvised,
  RUNNERS,
};
