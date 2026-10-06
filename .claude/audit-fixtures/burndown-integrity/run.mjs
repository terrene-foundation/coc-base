#!/usr/bin/env node
/**
 * burndown-integrity — fixtures for `rules/burndown-integrity.md` and its
 * generator `.claude/bin/burndown-build.mjs`.
 *
 * BIPOLAR BY CONSTRUCTION. A generator shown only to REFUSE proves it can say
 * "no"; it does not prove it can say anything else. Half the cases below are
 * builds that MUST SUCCEED — a clean register, a manifest whose source array has
 * been REORDERED, an owner refresh correctly outranking a same-day agent one. If
 * the generator refuses those, it is a rubber stamp pointed the other way and is
 * just as useless as one that never refuses at all.
 *
 * HOW EACH CASE DISCRIMINATES. Every case builds a REAL temporary git repository
 * on disk — real committed source files, real manifest — and invokes the REAL
 * binary as a subprocess, reading its EXIT CODE and its stdout/stderr. Nothing is
 * mocked and no internal is reached around, so a case cannot pass against an
 * implementation the command line would not.
 *
 * THE LEVER IS THE SOURCE STATE, not a flag: same binary, same arguments,
 * different committed content. That is what makes each pair meaningful — the two
 * poles differ ONLY in the thing the clause is about.
 *
 * EXIT CODES ARE ASSERTED EXACTLY, never as "non-zero". `exit 2` (UNRUNNABLE,
 * refused, no block) and `exit 1` (stale block) mean different things, and a case
 * that accepts either cannot tell a refusal from a stale-block report.
 */
import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// The acceptance-channel arms at the foot of this file need the REAL event library, the
// REAL signer and the REAL chain hasher: the anchor advances only on a folded owner
// `activation`, and the generator verifies every record before it folds one. A fixture
// signing with a placeholder could only ever show that the gate refuses placeholders.
const _require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const TOOL = process.env.BURNDOWN_TOOL || path.join(REPO_ROOT, ".claude", "bin", "burndown-build.mjs");

let pass = 0;
const failures = [];

// `PASS <name>` at column 0 is the shape run-audit-fixtures.mjs::CASE_PASS counts.
// An indented or symbol-prefixed line is invisible to it.
function check(name, fn) {
  let ok;
  try {
    ok = fn();
  } catch (e) {
    ok = `threw: ${e && e.message}`;
  }
  if (ok === true) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name}${typeof ok === "string" ? ` — ${ok}` : ""}`);
  }
}

// ── fixture repo construction ───────────────────────────────────────────────
const REGISTER = {
  _note: "fixture",
  _generated: "2026-08-01",
  _authority: "owner",
  _id_convention: "REG-NN-SLUG",
  items: [
    { id: "REG-01-A", page: "Alpha", status: "Signed off" },
    { id: "REG-02-A", page: "Alpha", status: "Signed off" },
    { id: "REG-03-A", page: "Alpha", status: "Signed off" },
    { id: "REG-04-B", page: "Beta", status: "In progress" },
    { id: "REG-05-B", page: "Beta", status: "Not started" },
  ],
};
const GROWTH = {
  _note: "fixture",
  _generated: "2026-08-10",
  _authority: "agent",
  _id_convention: "CONV-NN-SLUG",
  items: [
    { id: "CONV-01-EXTRA", page: "Beta", status: "Not started" },
    { id: "CONV-02-EXTRA", page: "Beta", status: "Not started" },
  ],
};
const REFRESH = {
  _note: "fixture",
  _generated: "2026-08-12",
  _authority: "owner",
  _id_convention: "existing ids only",
  items: [{ id: "REG-01-A", status: "Blocked on you" }],
};
const MANIFEST = {
  _schema: "burndown-manifest/v1",
  target: "REGISTER.md",
  pages: ["Alpha", "Beta"],
  sources: [{ path: "burndown/register.json", kind: "register", precedence: 0 }],
};

function j(o) {
  return JSON.stringify(o, null, 2) + "\n";
}

/**
 * THIS FIXTURE CLEANS UP AFTER ITSELF, and it did not used to.
 *
 * Every case builds a REAL git repo and none were ever removed. MEASURED on the
 * workstation where this landed: 34,987 leaked `burndown-fx-*` trees and 141
 * `burndown-fx-key-*` directories, each holding an unencrypted ed25519 private
 * key — one per historical run. The sibling suite `failing-set-baseline` has
 * balanced `mkdtempSync`/`rmSync` in a `finally` and leaks ZERO, so this was a
 * gap in this file, not a limitation of the pattern.
 *
 * IT STOPPED BEING HYGIENE AND BECAME A GATE FAILURE. Repo creation in a TMPDIR
 * holding ~153k entries costs 1.73x its cost in a clean one (min 180ms vs 104ms
 * over 12 samples; the MINIMUM is the load-robust statistic, since background
 * load can only inflate a sample). At 272 repos per run that is ~17s of drag
 * that grows monotonically, and this suite runs ~237s against a 300s ceiling —
 * it TIMED OUT at 228/261 cases during the verification that found this.
 *
 * `BURNDOWN_FX_KEEP=1` preserves the trees for debugging, which is the reason
 * they were worth keeping in the first place.
 */
const FIXTURE_DIRS = [];
/**
 * Generous, and it ANNOUNCES truncation rather than hiding it.
 *
 * A first attempt used 5000ms. MEASURED: that silently truncated the cleanup it was
 * guarding — a full run creates 272 real git repos and cannot remove them in 5s in a
 * crowded TMPDIR, so the suite reported 261p/0f while leaking hundreds of trees. A
 * bound that quietly does half its job is the same "looks complete, measured nothing"
 * shape this whole suite exists to catch, so a truncation is now reported on stderr
 * with the count left behind.
 *
 * THE SECOND ATTEMPT OVERCORRECTED TO 120000ms, AND THAT WAS ALSO WRONG. A Tier-1 arm
 * measured what the first two revisions both missed: `spawnSync` sends SIGTERM at its
 * deadline and then WAITS for the child, so time spent in `process.on("exit")` counts
 * against the PARENT's `run-audit-fixtures.mjs::RUNNER_TIMEOUT_MS` (300000ms). Proven
 * directly — a child that had finished all its work and printed its output was still
 * SIGTERMed purely for time spent in its exit handler (`status=null signal=SIGTERM
 * errcode=ETIMEDOUT`). A 120s cleanup budget therefore makes 40% of the runner's
 * ceiling consumable by teardown, on a suite whose own header records it running
 * 240-300s. Composed worst case: SIGTERM lands mid-cleanup, the default action takes
 * over, and EVERY tree leaks while the run hard-fails as timed out with every case
 * passing. 30s is above the measured need (~9.3ms/repo, ~2.5s for 272 in a quiet dir,
 * with headroom for a crowded one) and small enough that teardown cannot dominate the
 * ceiling. This is the third value for this constant; each previous one was chosen by
 * reasoning and corrected by measurement.
 */
/**
 * REFUSES a non-positive value rather than silently disarming.
 *
 * `Number(process.env.X) || 30000` looks safe and is not: `Number("-1")` is `-1`,
 * which is TRUTHY, so the `||` default never fires, the deadline is already in the
 * past, and the loop below breaks BEFORE ITS FIRST `pop()` — every tree survives,
 * silently. What is not reaped includes the `burndown-fx-key-*` directories, each
 * holding an unencrypted ed25519 private key.
 *
 * The correct implementation already existed in a sibling file in the same commit
 * (`.claude/audit-fixtures/auto-format/auto-format-cases.mjs:43-54`,
 * `boundedMs`), and was not applied here: a fail-closed dimension landed at one
 * surface and not its sibling, which is `security.md` § Enforcement-Surface
 * Parity at the fixture layer.
 *
 * CORRECTED: this sentence read "NINE LINES into a sibling file", which was false
 * and uncited — the function opens at :43, and line 9 of that file is a docblock
 * comment. Caught by the Tier-1 round on `883c9230a`. `zero-tolerance.md` Rule 3e
 * was widened 2026-09-08 to cover CODE COMMENTS precisely so a claim like this
 * carries a `<path>:<start>-<end>` a reader can resolve; the range above is that
 * citation, and it holds the fact.
 */
function cleanupBudgetMs() {
  const raw = process.env.BURNDOWN_FX_CLEANUP_MS;
  if (raw === undefined || raw === "") return 30000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `BURNDOWN_FX_CLEANUP_MS="${raw}" is not a positive number of milliseconds; refusing rather than silently leaving fixture trees (and key material) behind`,
    );
  }
  return n;
}
const CLEANUP_BUDGET_MS = cleanupBudgetMs();

/**
 * `BURNDOWN_FX_KEEP` is a FLAG, and "0"/"false" mean OFF.
 *
 * A bare `if (process.env.BURNDOWN_FX_KEEP)` treats the STRINGS "0" and "false" as
 * truthy, so an operator writing `BURNDOWN_FX_KEEP=0` to turn retention off turns
 * it ON — the same silent-disarm shape, one line over.
 */
function keepRequested() {
  const raw = process.env.BURNDOWN_FX_KEEP;
  if (raw === undefined || raw === "") return false;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

function cleanupFixtureDirs() {
  if (keepRequested()) return;
  // KEY MATERIAL FIRST, EXPLICITLY. `FIXTURE_DIRS` is drained LIFO and the signer
  // directory happens to be registered late, so under a truncated budget it was
  // reaped early BY ACCIDENT — nothing asserted it. Moving the signer's construction
  // earlier, or switching this drain to FIFO, would silently make the unencrypted
  // private key the LAST thing removed. It is now removed before the deadline loop
  // can expire, regardless of registration order.
  for (let i = FIXTURE_DIRS.length - 1; i >= 0; i--) {
    if (!FIXTURE_DIRS[i].includes("burndown-fx-key-")) continue;
    try {
      fs.rmSync(FIXTURE_DIRS[i], { recursive: true, force: true });
    } catch {
      /* cleanup: a tree already gone is not this suite's finding */
    }
    FIXTURE_DIRS.splice(i, 1);
  }
  const deadline = Date.now() + CLEANUP_BUDGET_MS;
  while (FIXTURE_DIRS.length) {
    if (Date.now() > deadline) {
      process.stderr.write(
        `  burndown-integrity: cleanup TRUNCATED at ${CLEANUP_BUDGET_MS}ms with ` +
          `${FIXTURE_DIRS.length} tree(s) left under the system temp dir. They are safe to delete. ` +
          `Raise BURNDOWN_FX_CLEANUP_MS if this recurs.\n`,
      );
      break;
    }
    const d = FIXTURE_DIRS.pop();
    // Best-effort by design: this is cleanup, where failure is expected and must
    // not mask the run's own verdict — the carve-out `zero-tolerance.md` Rule 3
    // names explicitly ("hooks/cleanup where failure is expected").
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* a tree already gone, or held open, is not this suite's finding */
    }
  }
}
process.on("exit", cleanupFixtureDirs);
// `exit` does NOT fire on a signal, and the timeout path SIGTERMs this process —
// which is exactly the run that leaked most, since it had built the most trees.
//
// NO SIGNAL HANDLER IS REGISTERED, DELIBERATELY, AND THAT IS THE FIX.
//
// An earlier revision of this file registered SIGINT/SIGTERM/SIGHUP handlers to
// reap the trees on a kill. Two Tier-1 arms then measured that the handler
// LAUNDERED the kill — `process.exit(1)` made `status` a number and `signal` null,
// so `run-audit-fixtures.mjs` reclassified an external kill from `[runner-error]`
// to `[opaque-failure]` with an EMPTY cause, the exact collapse its own comment
// forbids ("A killed process is NOT a non-zero exit").
//
// Re-raising instead of exiting fixes the laundering and does NOT fix the real
// problem, which testing the fix surfaced: registering ANY JS handler REPLACES the
// default terminate action, and this suite is dominated by SYNCHRONOUS
// `execFileSync` git calls, so the handler only runs when the event loop gets
// control — which is late or never. MEASURED: with handlers installed, this
// process was still ALIVE 2m30s after a SIGTERM delivered at the 4s mark, and had
// to be SIGKILLed. An unkillable gate is strictly worse than a leaked tree: the
// tree is recoverable, the hung runner blocks the pre-push gate and the operator.
//
// So kills are left to the DEFAULT action: the process dies promptly, the parent
// observes `signal: "SIGTERM"` and classifies it correctly as a kill, and the
// trees from that run leak. The `exit` handler above still covers every normal and
// error exit, which is the common case and the one that was growing without bound.
// The `spawnSync`-timeout path never depended on any of this (`error.code` is
// ETIMEDOUT regardless of how the child dies).

/** Build a real git repo. `files` is a {relpath: contents} map, all committed. */
function mkRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "burndown-fx-"));
  FIXTURE_DIRS.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  for (const a of [
    ["init", "-q"],
    ["config", "user.email", "fx@example.invalid"],
    ["config", "user.name", "fx"],
    // A fixture repo MUST NOT inherit the operator's signing config. `git init` picks up
    // global `commit.gpgsign`, this machine sets it true, and so EVERY fixture commit
    // spawned gpg — under concurrent runners, gpg-agent contention made `git commit` fail
    // with exit 128 AT RANDOM. The failures then scattered across unrelated cases and read
    // exactly like flaky assertions: four parallel runs of this suite failed 8, 2, 2 and 2
    // cases, a different set each time, including cases that had nothing to do with the
    // change under test.
    //
    // ISOLATED, not inferred: a bare 6-process × 60-iteration `init`/`add`/`commit` loop
    // carrying NO fixture logic at all reproduces the same exit 128, and a single
    // sequential commit succeeds — so the variable is contention, not this suite.
    // Pinning it false makes the fixture depend on nothing outside itself, which is what a
    // fixture is for. ~20 sibling runners already pin it; this is the established pattern,
    // not a new one.
    ["config", "commit.gpgsign", "false"],
    ["add", "-A"],
    ["commit", "-q", "-m", "fixture"],
  ]) {
    execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  }
  return dir;
}

function baseFiles(extra = {}) {
  return {
    "REGISTER.md": "# Register\n",
    "burndown/register.json": j(REGISTER),
    "burndown-manifest.json": j(MANIFEST),
    ...extra,
  };
}

function run(dir, args = []) {
  const r = spawnSync("node", [TOOL, "--repo", dir, ...args], { cwd: dir, encoding: "utf8" });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

// ── COMPLIANT POLE — these MUST succeed ─────────────────────────────────────

check("compliant/clean-register-builds", () => {
  const d = mkRepo(baseFiles());
  const r = run(d);
  return r.code === 0 && /ALL PAGES/.test(r.out) ? true : `exit ${r.code}, out=${r.out.slice(0, 200)}`;
});

check("compliant/binding-clause-is-verbatim-in-block", () => {
  const d = mkRepo(baseFiles());
  const r = run(d);
  return r.out.includes(
    "These are the only counts. Any figure quoted anywhere is this block verbatim, or it is wrong.",
  )
    ? true
    : "binding clause missing from the generated block";
});

check("compliant/closed-vocabulary-carried-inside-block", () => {
  const d = mkRepo(baseFiles());
  const r = run(d);
  const need = ["Signed off", "Built-not-walked", "In progress", "Not started", "Blocked on you", "Open"];
  const missing = need.filter((n) => !r.out.includes(n));
  return missing.length === 0 ? true : `block omits ${missing.join(", ")}`;
});

check("compliant/blocked-count-labels-named-in-block", () => {
  const d = mkRepo(baseFiles());
  const r = run(d);
  return ["done", "complete", "closed", "finished", "remaining"].every((w) => r.out.includes(w))
    ? true
    : "the block does not name the BLOCKED count labels";
});

check("compliant/growth-split-columns-present", () => {
  const d = mkRepo(baseFiles());
  const r = run(d);
  return r.out.includes("Open: from original register") && r.out.includes("Open: arrived since")
    ? true
    : "growth-split columns absent";
});

check("compliant/manifest-source-REORDER-yields-identical-block", () => {
  // Precedence is (date, authority, precedence, filename) — NEVER list position.
  const fwd = { ...MANIFEST, sources: [
    { path: "burndown/register.json", kind: "register", precedence: 0 },
    { path: "burndown/growth.json", kind: "growth", precedence: 0 },
    { path: "burndown/refresh.json", kind: "status-refresh", precedence: 0 },
  ] };
  const rev = { ...MANIFEST, sources: [...fwd.sources].reverse() };
  const extra = { "burndown/growth.json": j(GROWTH), "burndown/refresh.json": j(REFRESH) };
  const a = run(mkRepo(baseFiles({ ...extra, "burndown-manifest.json": j(fwd) })));
  const b = run(mkRepo(baseFiles({ ...extra, "burndown-manifest.json": j(rev) })));
  if (a.code !== 0 || b.code !== 0) return `exit ${a.code}/${b.code}`;
  const strip = (s) => s.replace(/^(generated_from_sha|sources_digest): .*$/gm, "$1: X");
  return strip(a.out) === strip(b.out) ? true : "reordering the manifest changed the counts";
});

check("compliant/owner-refresh-outranks-same-day-agent-refresh", () => {
  // THE FILENAMES ARE LOAD-BEARING AND DELIBERATELY INVERTED. This case read
  // `a-agent.json` / `z-owner.json` before, and the LAST precedence key is the
  // path — so the owner file sorted last, and won, BY ALPHABET. Measured: with
  // the `_authority` comparison DELETED from byPrecedence the case still PASSED,
  // while a filename-swapped repo flipped from blockedOnYou=1 to inProgress=1.
  // It could not falsify the claim in its name. Naming the owner file FIRST
  // alphabetically leaves the authority key as the ONLY thing that can produce
  // the owner-wins result, so deleting that key now reds this case.
  const agentSameDay = { ..._clone(REFRESH), _authority: "agent", items: [{ id: "REG-02-A", status: "In progress" }] };
  const ownerSameDay = { ..._clone(REFRESH), _authority: "owner", items: [{ id: "REG-02-A", status: "Blocked on you" }] };
  const m = { ...MANIFEST, sources: [
    { path: "burndown/register.json", kind: "register", precedence: 0 },
    { path: "burndown/a-owner.json", kind: "status-refresh", precedence: 0 },
    { path: "burndown/z-agent.json", kind: "status-refresh", precedence: 0 },
  ] };
  const d = mkRepo(baseFiles({
    "burndown/a-owner.json": j(ownerSameDay),
    "burndown/z-agent.json": j(agentSameDay),
    "burndown-manifest.json": j(m),
  }));
  const r = run(d, ["--json"]);
  if (r.code !== 0) return `exit ${r.code}: ${r.err.slice(0, 200)}`;
  const all = JSON.parse(r.out).all;
  // Owner said 'Blocked on you'; agent said 'In progress'. Same date. Owner wins.
  return all.blockedOnYou === 1 && all.inProgress === 1
    ? true
    : `owner refresh did not win: blocked=${all.blockedOnYou} inprog=${all.inProgress}`;
});

check("compliant/rows-partition-and-all-pages-is-the-sum", () => {
  const d = mkRepo(baseFiles({
    "burndown/growth.json": j(GROWTH),
    "burndown-manifest.json": j({ ...MANIFEST, sources: [
      { path: "burndown/register.json", kind: "register", precedence: 0 },
      { path: "burndown/growth.json", kind: "growth", precedence: 0 },
    ] }),
  }));
  const r = run(d, ["--json"]);
  if (r.code !== 0) return `exit ${r.code}`;
  const { pages, all } = JSON.parse(r.out);
  // THE ADJUDICATION BUCKETS PARTITION `adjudicated`, NOT the board. Under one
  // denominator this assertion was against `total`, and that is precisely what made
  // completion unreachable once projected items entered it: the five buckets could
  // never sum to a total containing items barred from every one of them.
  const keys = ["board", "adjudicated", "signedOff", "builtNotWalked", "inProgress", "notStarted", "blockedOnYou", "open", "projected", "openBoth", "openFromRegister", "openArrivedSince"];
  for (const p of [...pages, all]) {
    const parts = p.signedOff + p.builtNotWalked + p.inProgress + p.notStarted + p.blockedOnYou;
    if (parts !== p.adjudicated) return `row ${p.name} does not partition (${parts} vs adjudicated ${p.adjudicated})`;
    if (p.board !== p.adjudicated + p.projected) return `row ${p.name} board is not adjudicated + projected`;
    if (p.open !== p.adjudicated - p.signedOff) return `row ${p.name} open wrong`;
    if (p.openBoth !== p.open + p.projected) return `row ${p.name} openBoth wrong`;
    if (p.openFromRegister + p.openArrivedSince !== p.openBoth) return `row ${p.name} split wrong`;
  }
  for (const k of keys) {
    if (pages.reduce((a, x) => a + x[k], 0) !== all[k]) return `ALL PAGES ${k} is not the sum`;
  }
  return true;
});

check("compliant/check-passes-on-a-freshly-written-block", () => {
  const d = mkRepo(baseFiles());
  const w = run(d, ["--write"]);
  if (w.code !== 0) return `write exit ${w.code}`;
  const c = run(d, ["--check"]);
  return c.code === 0 ? true : `check exit ${c.code}: ${c.err.slice(0, 200)}`;
});

// R-STRUCT-1 (2026-08-18 redteam): `--quote` is the affordance the rule calls "the
// correct path is the cheap one", and for `Open` it emitted a BARE count — exactly
// the shape MUST-3 blocks. Neither hook arm could catch it: the token is VALID so
// the structural arm passes it, and the lexical arm fires only on UNtokened counts.
// Bipolar on the lever, so a fix that appended the split to EVERY bucket also reds.
check("compliant/quote-of-Open-carries-the-growth-split", () => {
  const d = mkRepo(baseFiles({
    "burndown/growth.json": j(GROWTH),
    "burndown-manifest.json": j({ ...MANIFEST, sources: [
      { path: "burndown/register.json", kind: "register", precedence: 0 },
      { path: "burndown/growth.json", kind: "growth", precedence: 0 },
    ] }),
  }));
  const r = run(d, ["--quote", "ALL PAGES/Open"]);
  if (r.code !== 0) return `exit ${r.code}: ${r.err.slice(0, 200)}`;
  if (!/Open: from original register/.test(r.out) || !/Open: arrived since/.test(r.out)) {
    return `MUST-3: the Open quote carries no growth split: ${r.out.trim()}`;
  }
  // All three figures must be TOKENISED, or the split is prose the reader cannot check.
  const toks = r.out.match(/\d+⟨[0-9a-f]{6}⟩/g) || [];
  if (toks.length !== 3) return `expected 3 tokenised counts in the Open quote, got ${toks.length}`;
  // BUG-C shape (2026-08-18 security redteam): this revalidation step read
  // `run(d, ["--verify-quote","-"])` — stdin, with NOTHING piped in. Measured, that
  // returns exit 0 and "no tokenised counts found; nothing to validate", so
  // `v.code === 0` passed WITHOUT the quote ever being looked at, the `|| /all
  // valid/` disjunct was dead, and the failure message below could never print. The
  // quote is now fed in as a FILE and the outcome asserted positively: all three
  // figures, all valid. Reds if any split figure stops revalidating.
  const v = verifyText(d, r.out);
  if (v.code !== 0) return `the split figures do not revalidate: exit ${v.code} ${v.err.slice(0, 200)}`;
  return /3 tokenised count\(s\) all valid/.test(v.out)
    ? true
    : `expected all 3 split figures validated, got: ${v.out.trim().slice(0, 160)}`;
});

check("compliant/quote-of-a-non-Open-bucket-carries-NO-split", () => {
  const d = mkRepo(baseFiles());
  const r = run(d, ["--quote", "ALL PAGES/Signed off"]);
  if (r.code !== 0) return `exit ${r.code}`;
  if (/Open: from original register|Open: arrived since/.test(r.out)) {
    return `the split was appended to a non-Open bucket: ${r.out.trim()}`;
  }
  return /\d+⟨[0-9a-f]{6}⟩ of \d+ `Signed off`/.test(r.out) ? true : `unexpected shape: ${r.out.trim()}`;
});

check("compliant/selftest-exits-zero", () => {
  const r = spawnSync("node", [TOOL, "--selftest"], { cwd: REPO_ROOT, encoding: "utf8" });
  return r.status === 0 && /SELFTEST OK/.test(r.stdout) ? true : `exit ${r.status}`;
});

check("compliant/selftest-prints-both-poles-of-the-growth-split", () => {
  const r = spawnSync("node", [TOOL, "--selftest"], { cwd: REPO_ROOT, encoding: "utf8" });
  return /'Open: arrived since' = 0/.test(r.stdout) && /'Open: arrived since' = 2/.test(r.stdout)
    ? true
    : "selftest does not state both poles of the discriminating column";
});

// ── THE SECURITY LANE'S EXPLOITS, ported as bipolar pairs ───────────────────
// Each of these PASSED before the fix. The compliant pole of every pair is the
// honest form of the same sentence, so a fix that simply rejected everything
// would fail here too.

function quoteOf(d, bucket) {
  const r = spawnSync("node", [TOOL, "--repo", d, "--quote", bucket], { cwd: d, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`--quote failed: ${r.stderr}`);
  return r.stdout.trim();
}
// THE SINGLE --verify-quote CHOKE POINT for this suite. Route every verification
// through here; a second local copy is how one case got missed (see the projected
// denominator case below, which now calls this rather than re-implementing it).
//
// `--write` FIRST, and it is a PRECONDITION rather than a convenience. Since
// 09fa92b06 the verifier reads `manifest.target` from disk and REFUSES (exit 2,
// UNRUNNABLE) when that target carries no generated block — the old form built the
// board inline, timed out on the 3s hook budget, and returned UNKNOWN for honest and
// forged quotes alike, which is a non-discriminating instrument. All three fixture-repo
// builders write a blockless `REGISTER.md` ("# Register\n"), so without this the seam
// refuses before it ever looks at the quote, and every pole of every pair — violation
// AND compliant — comes back exit 2. A certified block is what a quote is valid
// AGAINST; generating it is establishing the precondition, not weakening the check.
// If `--write` itself fails the verify below still refuses loudly with the same
// "carries NO generated block" message, so this cannot fail silently.
// Sibling precedent: `.claude/audit-fixtures/burndown-quote-hooks/run.mjs`, which
// builds the block the same way and for the same reason.
function verifyText(d, text) {
  run(d, ["--write"]);
  const f = path.join(d, "q.txt");
  fs.writeFileSync(f, text);
  return run(d, ["--verify-quote", f]);
}

check("BUG1/violation — a token lifted onto a DIFFERENT bucket+denominator is REJECTED", () => {
  // BUG-C (2026-08-18 security redteam): this case asserted `/denominator|bucket/`,
  // and the MISSING-CONTEXT refusal contains BOTH words — so the assertion could not
  // tell the recompute branch from the missing-context branch, and the case passed
  // on the wrong one. Proven by narrowing it to `/contradicts token/`, which RED-ed
  // and printed the missing-context message. Two changes, both needed: the sentence
  // now keeps the canonical `of <denom> \`<label>\`` slot INTACT (the old `**` broke
  // it, which is why it never reached the recompute), and the assertion pins the
  // branch the case NAMES. Distinct from the canonical-form case below by its lever:
  // there the contradiction is a bare canonical sentence, here it is EMBEDDED IN
  // PROSE, which is the shape a report actually ships.
  const d = mkRepo(baseFiles());
  const open = quoteOf(d, "ALL PAGES/Open").match(/\d+⟨[0-9a-f]{6}⟩/)[0];
  // Truth is 2 of 5 Signed off; this claims completion against a reused Open token.
  const r = verifyText(d, `We are done — ALL PAGES — ${open} of 2 \`Signed off\` across the board.`);
  if (r.code !== 1) return `expected exit 1, got ${r.code}`;
  if (/no verifiable /.test(r.err)) {
    return `rejected for MISSING context — this case must exercise the recompute branch: ${r.err.slice(0, 160)}`;
  }
  return /contradicts token/.test(r.err) && /denominator 2/.test(r.err) && /Signed off/.test(r.err)
    ? true
    : `no context contradiction named: ${r.err.slice(0, 200)}`;
});

check("BUG1/violation — a CANONICAL-FORM contradiction is caught by the RECOMPUTE, not by missing context", () => {
  // WHY THIS CASE EXISTS, measured during integration: the original exploit
  // (`**N⟨tok⟩ of 2** signed off`) stopped reaching the recompute branch once the
  // label parse became positional — the `**` breaks the canonical slot, so it is
  // now rejected for MISSING context instead. That fixture therefore passed for a
  // reason unrelated to the clause it names, the same shape M3 caught earlier.
  // This case states the contradiction in PERFECT canonical form, so the only
  // thing that can reject it is the digest recomputation.
  const d = mkRepo(baseFiles());
  const q = quoteOf(d, "ALL PAGES/Open");
  const pair = q.match(/\d+⟨[0-9a-f]{6}⟩/)[0];
  const r = verifyText(d, `ALL PAGES — ${pair} of 2 \`Signed off\``);
  if (r.code !== 1) return `expected exit 1, got ${r.code}`;
  if (/no verifiable /.test(r.err)) {
    return "rejected for MISSING context — this case must exercise the recompute branch";
  }
  return /contradicts token/.test(r.err) && /denominator 2/.test(r.err) && /Signed off/.test(r.err)
    ? true
    : `wrong rejection reason: ${r.err.slice(0, 200)}`;
});

check("BUG1/compliant — the honest canonical quote still VALIDATES", () => {
  const d = mkRepo(baseFiles());
  const r = verifyText(d, `Status: ${quoteOf(d, "ALL PAGES/Open")} and holding.`);
  return r.code === 0 ? true : `honest quote rejected: exit ${r.code} ${r.err.slice(0, 200)}`;
});

check("BUG1/violation — a BARE token with no bucket/denominator is REJECTED", () => {
  const d = mkRepo(baseFiles());
  const bare = quoteOf(d, "ALL PAGES/Open").match(/\d+⟨[0-9a-f]{6}⟩/)[0];
  const r = verifyText(d, `We are at ${bare} right now.`);
  return r.code === 1 && /no verifiable row\/denominator\/bucket/.test(r.err)
    ? true
    : `exit ${r.code}: ${r.err.slice(0, 200)}`;
});

// \u2500\u2500 ROW SUBSTITUTION (BUG-A, 2026-08-18 security redteam) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// The suite had ZERO row-substitution cases while `verifyQuotes`'s own refusal text
// ASSERTED row binding ("That token certifies N of D 'L' on ROW"). Measured, three
// of the four hashed fields were positionally bound and the ROW was not: it matched
// first-in-index-order ANYWHERE in the preceding 120 chars, with a silent
// `|| known.row` fallback that RE-INJECTED the certified row on a miss.
//
// The lever is a register where two pages share a total, so the DENOMINATOR cannot
// separate them and only the row can: Alpha is 1 of 3 Open, Gamma is 3 of 3.
const ROW_REGISTER = {
  _generated: "2026-08-01",
  _authority: "owner",
  items: [
    { id: "REG-01-A", page: "Alpha", status: "Signed off" },
    { id: "REG-02-A", page: "Alpha", status: "Signed off" },
    { id: "REG-03-A", page: "Alpha", status: "Not started" },
    { id: "REG-04-G", page: "Gamma", status: "In progress" },
    { id: "REG-05-G", page: "Gamma", status: "Not started" },
    { id: "REG-06-G", page: "Gamma", status: "Not started" },
  ],
};
function mkRowRepo() {
  return mkRepo({
    "REGISTER.md": "# Register\n",
    "burndown/register.json": j(ROW_REGISTER),
    "burndown-manifest.json": j({ ...MANIFEST, pages: ["Alpha", "Gamma"], sources: [
      { path: "burndown/register.json", kind: "register", precedence: 0 }] }),
  });
}
// Each entry lies about GAMMA (truly 3 of 3) while carrying ALPHA's token (1 of 3).
//
// EACH CASE PINS THE BRANCH IT ACTUALLY REACHES, BY IDENTITY. An earlier revision
// asserted the DISJUNCTION `row '...' (certified '...')` OR `no verifiable row` for
// all six, on the reasoning that either is a correct rejection. That reasoning is
// sound about CORRECTNESS and wrong about DISCRIMINATION, and the Tier-1 redteam
// measured the difference: with the row-slot matcher replaced by a never-matching
// pattern (reach proven, 39 hits), the red set named NONE of these six — every one
// fell through to the `no verifiable row` disjunct and stayed green. Six cases named
// for the ROW dimension survived that dimension being deleted outright.
//
// The layouts genuinely differ in which branch they reach, and that is the fact the
// split encodes: only `CONTROL-adjacent-row` puts the row in the slot adjacent to the
// count, so only it can name the row. The other five are NOT weaker — they pin that a
// token lifted onto a different row is still REFUSED when the row cannot be read at
// all, which is the fail-closed half — but they were MIS-NAMED, and a case whose name
// promises more than its body checks is what `instrument-bipolarity.md` MUST-2 forbids.
const ROW_DIM = {
  re: /row 'Gamma' \(certified 'Alpha'\)/,
  says: "NAMES the row it read against the row it was certified for",
};
const NO_ROW = {
  re: /no verifiable row/,
  says: "REFUSES for want of a readable row, rather than accepting the count",
};
for (const [why, render, branch] of [
  ["CONTROL-adjacent-row", (t) => `Gamma \u2014 1\u27E8${t}\u27E9 of 3 \`Open\``, ROW_DIM],
  ["heading-with-trailing-words", (t) => `### Gamma status as of today\n\n1\u27E8${t}\u27E9 of 3 \`Open\` \u2014 nearly clear`, NO_ROW],
  ["a-newline-between-row-and-count", (t) => `Now for Gamma. The page stands at\n1\u27E8${t}\u27E9 of 3 \`Open\``, NO_ROW],
  ["a-period-between-row-and-count", (t) => `Now for Gamma. The page stands at 1\u27E8${t}\u27E9 of 3 \`Open\``, NO_ROW],
  ["the-row-placed-AFTER-the-count", (t) => `1\u27E8${t}\u27E9 of 3 \`Open\` on Gamma`, NO_ROW],
  ["more-than-40-chars-of-prose", (t) => `Gamma, which the owner reviewed last Tuesday afternoon, is at 1\u27E8${t}\u27E9 of 3 \`Open\``, NO_ROW],
]) {
  check(`BUGA/violation \u2014 a token lifted onto a DIFFERENT ROW is REJECTED and ${branch.says} (${why})`, () => {
    const d = mkRowRepo();
    const tok = quoteOf(d, "Alpha/Open").match(/[0-9a-f]{6}/)[0];
    const r = verifyText(d, render(tok));
    if (r.code !== 1) return `expected exit 1, got ${r.code}: ${(r.out + r.err).slice(0, 200)}`;
    return branch.re.test(r.err)
      ? true
      : `rejected, but not on the branch this case pins (${branch.says}): ${r.err.slice(0, 200)}`;
  });
}

check("BUGA/violation \u2014 the row is matched POSITIONALLY, not first-in-index-order", () => {
  // `Alpha is fine; ALL PAGES \u2014 1\u27E8alpha-token\u27E9 of 3 \`Open\`` validated because
  // `Alpha` matched FIRST in index order and equalled the certified row, while the
  // sentence attributed the count to ALL PAGES. Reds if the row search goes back to
  // scanning the whole `before` window instead of the slot adjacent to the count.
  const d = mkRowRepo();
  const tok = quoteOf(d, "Alpha/Open").match(/[0-9a-f]{6}/)[0];
  const r = verifyText(d, `Alpha is fine; ALL PAGES \u2014 1\u27E8${tok}\u27E9 of 3 \`Open\``);
  if (r.code !== 1) return `expected exit 1, got ${r.code}`;
  return /row 'ALL PAGES' \(certified 'Alpha'\)/.test(r.err)
    ? true
    : `did not read the ADJACENT row: ${r.err.slice(0, 200)}`;
});

check("BUGA2/violation \u2014 EVERY token in the canonical --quote output is row-bound", () => {
  // The generator's OWN MUST-3 output was emitting a row-unbound token. Measured
  // before the fix: swapping the row on the canonical `Open` quote rejected 2 of 3
  // tokens and the THIRD \u2014 `arrived since`, the column MUST-3 calls the
  // highest-value one \u2014 still validated, 78 chars past the row name. This asserts
  // the count exactly, so 2-of-3 reds. Reds if the growth split goes back to
  // hanging off the first figure instead of repeating the full canonical triple.
  const d = mkRowRepo();
  const canon = quoteOf(d, "ALL PAGES/Open");
  const n = (canon.match(/\d+\u27E8[0-9a-f]{6}\u27E9/g) || []).length;
  if (n !== 3) return `expected 3 tokenised counts in the Open quote, got ${n}`;
  const r = verifyText(d, canon.split("ALL PAGES").join("Alpha"));
  if (r.code !== 1) return `expected exit 1, got ${r.code}`;
  return /3 of 3 tokenised count\(s\) FAILED/.test(r.err)
    ? true
    : `not every token was row-bound: ${(r.err.match(/\d+ of \d+ tokenised.*/) || ["?"])[0]}`;
});

check("BUGA/compliant \u2014 the canonical quote for EACH row still validates", () => {
  // The no-false-positive pole. A fix that simply refused everything reds here, and
  // so does one that binds the row so tightly the generator's own output fails it.
  const d = mkRowRepo();
  for (const row of ["Alpha", "Gamma", "ALL PAGES"]) {
    for (const bucket of ["Open", "Signed off"]) {
      const q = quoteOf(d, `${row}/${bucket}`);
      const r = verifyText(d, `Status: ${q} and holding.`);
      if (r.code !== 0) return `honest ${row}/${bucket} quote rejected: exit ${r.code} ${r.err.slice(0, 160)}`;
    }
  }
  return true;
});

for (const [label, digit] of [["FULLWIDTH", "\uFF15"], ["ARABIC-INDIC", "\u0665"]]) {
  check(`BUG2/violation — a ${label} digit beside a token is REJECTED, not skipped`, () => {
    const d = mkRepo(baseFiles());
    const q = quoteOf(d, "ALL PAGES/Open");
    const tok = q.match(/[0-9a-f]{6}/)[0];
    const denom = q.match(/of (\d+)/)[1];
    const r = verifyText(d, `We are at ${digit}⟨${tok}⟩ of ${denom} \`Open\`.`);
    return r.code === 1 && /non-ASCII digits/.test(r.err) ? true : `exit ${r.code}: ${r.err.slice(0, 200)}`;
  });
}

check("BUG2/compliant — the same sentence in ASCII digits VALIDATES", () => {
  const d = mkRepo(baseFiles());
  const r = verifyText(d, `We are at ${quoteOf(d, "ALL PAGES/Open")}.`);
  return r.code === 0 ? true : `exit ${r.code}: ${r.err.slice(0, 200)}`;
});

check("BUG3/violation — a SYMLINKED declared source REFUSES (exit 2)", () => {
  const d = mkRepo(baseFiles());
  fs.writeFileSync(path.join(d, "elsewhere.json"), j({ ..._clone(REGISTER), items: [] }));
  fs.rmSync(path.join(d, "burndown", "register.json"));
  fs.symlinkSync("../elsewhere.json", path.join(d, "burndown", "register.json"));
  execFileSync("git", ["add", "-A"], { cwd: d, stdio: "ignore" });
  execFileSync("git", ["commit", "-qm", "symlink"], { cwd: d, stdio: "ignore" });
  const r = run(d);
  return r.code === 2 && /SYMLINK/.test(r.err) ? true : `exit ${r.code}: ${r.err.slice(0, 200)}`;
});

check("BUG3/compliant — a REGULAR declared source still builds", () => {
  const r = run(mkRepo(baseFiles()));
  return r.code === 0 && /ALL PAGES/.test(r.out) ? true : `exit ${r.code}`;
});

check("disclosure/refusals name a REPO-RELATIVE path, never the operator's absolute tree", () => {
  const d = mkRepo(baseFiles({ "burndown/register.json": "{ not json" }));
  const r = run(d);
  if (r.code !== 2) return `expected exit 2, got ${r.code}`;
  if (r.err.includes(d)) return `refusal leaked the absolute path: ${r.err.slice(0, 160)}`;
  return /burndown\/register\.json/.test(r.err) ? true : "refusal does not name the relative path";
});

// ── VIOLATION POLE — these MUST refuse, with exit 2 exactly ─────────────────

/**
 * `reasonRx` is NOT decoration — it is what makes each case pin ITS OWN clause.
 *
 * Measured, and the reason this parameter exists: a mutation disabling the
 * closed-vocabulary check (`if (!ASSIGNABLE.includes(status))` → `if (0)`) left
 * this suite GREEN at 33/33. The unknown status flowed through to a `STATUS_KEY`
 * miss, produced NaN, and tripped the PARTITION assertion instead — so the case
 * still saw exit 2 and still saw the banner, and passed for a reason that had
 * nothing to do with the clause it was named for. Asserting the exit code alone
 * cannot tell one refusal from another. It asserts the refusal REASON now.
 */
function refuses(name, files, reasonRx, args = []) {
  check(name, () => {
    const d = mkRepo(baseFiles(files.commit || {}));
    if (files.mutate) files.mutate(d);
    const r = run(d, args);
    if (r.code !== 2) return `expected exit 2, got ${r.code}. err=${r.err.slice(0, 200)}`;
    if (!/^UNRUNNABLE — refusing because /m.test(r.err)) return "no UNRUNNABLE banner on stderr";
    if (!reasonRx.test(r.err)) {
      return `refused for the WRONG reason — wanted ${reasonRx}, got: ${r.err.split("\n")[0]}`;
    }
    return true;
  });
}

refuses("violation/uncommitted-source-refuses", {
  mutate: (d) => {
    fs.writeFileSync(path.join(d, "burndown", "growth.json"), j(GROWTH));
    fs.writeFileSync(path.join(d, "burndown-manifest.json"), j({ ...MANIFEST, sources: [
      { path: "burndown/register.json", kind: "register", precedence: 0 },
      { path: "burndown/growth.json", kind: "growth", precedence: 0 },
    ] }));
    execFileSync("git", ["add", "burndown-manifest.json"], { cwd: d, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "declare only"], { cwd: d, stdio: "ignore" });
    // growth.json is declared but NEVER committed.
  },
}, /is not committed/);

refuses("violation/modified-source-refuses", {
  mutate: (d) => {
    const p = path.join(d, "burndown", "register.json");
    const doc = JSON.parse(fs.readFileSync(p, "utf8"));
    doc.items[0].status = "Blocked on you";
    fs.writeFileSync(p, j(doc)); // modified vs HEAD, never committed
  },
}, /uncommitted modifications against HEAD/);

refuses("violation/status-outside-closed-vocabulary-refuses", {
  mutate: (d) => {
    const doc = _clone(REGISTER);
    doc.items[0].status = "Mostly there";
    _commitFile(d, "burndown/register.json", j(doc));
  },
}, /outside the closed vocabulary/);

for (const word of ["done", "complete", "closed", "finished", "remaining"]) {
  refuses(
    `violation/blocked-count-label-'${word}'-refuses`,
    {
      mutate: (d) => {
        const doc = _clone(REGISTER);
        doc.items[0].status = word;
        _commitFile(d, "burndown/register.json", j(doc));
      },
    },
    /is a BLOCKED label/,
  );
}

refuses("violation/status-refresh-introducing-unknown-id-refuses", {
  mutate: (d) => {
    _commitFile(d, "burndown/refresh.json", j({ ..._clone(REFRESH), items: [{ id: "GHOST-99", status: "In progress" }] }));
    _commitFile(d, "burndown-manifest.json", j({ ...MANIFEST, sources: [
      { path: "burndown/register.json", kind: "register", precedence: 0 },
      { path: "burndown/refresh.json", kind: "status-refresh", precedence: 0 },
    ] }));
  },
}, /introduced an id that no register or growth source declares/);

refuses("violation/item-on-undeclared-page-refuses", {
  mutate: (d) => {
    const doc = _clone(REGISTER);
    doc.items.push({ id: "REG-06-G", page: "Gamma", status: "Not started" });
    _commitFile(d, "burndown/register.json", j(doc));
  },
}, /is not declared in the manifest pages/);

refuses("violation/source-declared-twice-refuses", {
  mutate: (d) => _commitFile(d, "burndown-manifest.json", j({ ...MANIFEST, sources: [
    { path: "burndown/register.json", kind: "register", precedence: 0 },
    { path: "burndown/register.json", kind: "register", precedence: 1 },
  ] })),
}, /is declared twice in the manifest/);

refuses("violation/empty-source-list-refuses", {
  mutate: (d) => _commitFile(d, "burndown-manifest.json", j({ ...MANIFEST, sources: [] })),
}, /declares no sources/);

refuses("violation/wrong-schema-refuses", {
  mutate: (d) => _commitFile(d, "burndown-manifest.json", j({ ...MANIFEST, _schema: "burndown/v0" })),
}, /expected .burndown-manifest\/v1./);

refuses("violation/missing-authority-refuses", {
  mutate: (d) => {
    const doc = _clone(REGISTER);
    delete doc._authority;
    _commitFile(d, "burndown/register.json", j(doc));
  },
}, /declares _authority/);

refuses("violation/missing-generated-date-refuses", {
  mutate: (d) => {
    const doc = _clone(REGISTER);
    delete doc._generated;
    _commitFile(d, "burndown/register.json", j(doc));
  },
}, /no valid _generated date/);

refuses("violation/unknown-source-kind-refuses", {
  mutate: (d) => _commitFile(d, "burndown-manifest.json", j({ ...MANIFEST, sources: [
    { path: "burndown/register.json", kind: "notes", precedence: 0 },
  ] })),
}, /declares kind/);

// ── the refusal must not be mistakable for a pass ───────────────────────────

check("violation/refusal-prints-NOTHING-resembling-a-clean-summary", () => {
  const d = mkRepo(baseFiles());
  fs.writeFileSync(path.join(d, "burndown", "register.json"), j({ ..._clone(REGISTER), _authority: "nobody" }));
  const r = run(d);
  if (r.code !== 2) return `expected exit 2, got ${r.code}`;
  const all = r.out + r.err;
  // Every token a reader would scan for to conclude "it worked".
  for (const tok of ["ALL PAGES", "| page |", "Signed off |", "SELFTEST OK", "is current", "✓", "OK\n"]) {
    if (all.includes(tok)) return `refusal output contains clean-summary token ${JSON.stringify(tok)}`;
  }
  if (r.out.trim() !== "") return `refusal wrote to stdout: ${JSON.stringify(r.out.slice(0, 120))}`;
  return /This is exit 2\. It is NOT a pass\./.test(r.err) ? true : "refusal does not say it is not a pass";
});

check("violation/refusal-exit-is-2-not-1-so-it-is-distinguishable-from-stale", () => {
  const bad = mkRepo(baseFiles());
  fs.writeFileSync(path.join(bad, "burndown", "register.json"), j({ ..._clone(REGISTER), _authority: "nobody" }));
  const refusal = run(bad);
  const stale = mkRepo(baseFiles());
  run(stale, ["--write"]);
  const t = path.join(stale, "REGISTER.md");
  // Token-agnostic edit: bump the FIRST tokenised value in the table, leaving its
  // token behind. That is exactly the tamper the block is designed to expose, and
  // it does not depend on the table's column widths or rendering.
  fs.writeFileSync(
    t,
    fs.readFileSync(t, "utf8").replace(/\| Alpha \| (\d+)⟨/, (m, n) => `| Alpha | ${Number(n) + 6}⟨`),
  );
  const staleRun = run(stale, ["--check"]);
  return refusal.code === 2 && staleRun.code === 1
    ? true
    : `refusal=${refusal.code} (want 2), stale=${staleRun.code} (want 1)`;
});

check("violation/hand-edited-block-is-detected-by-check", () => {
  const d = mkRepo(baseFiles());
  run(d, ["--write"]);
  const t = path.join(d, "REGISTER.md");
  fs.writeFileSync(t, fs.readFileSync(t, "utf8").replace("**ALL PAGES**", "**ALL PAGES (hand-adjusted)**"));
  const r = run(d, ["--check"]);
  return r.code === 1 && /STALE/.test(r.err) ? true : `exit ${r.code}`;
});

check("violation/missing-block-is-detected-by-check", () => {
  const d = mkRepo(baseFiles());
  const r = run(d, ["--check"]);
  return r.code === 1 && /carries NO generated block/.test(r.err) ? true : `exit ${r.code}`;
});

check("compliant/sources-digest-changes-when-a-source-changes", () => {
  // (c) a block whose sources moved is STALE and detectable.
  const a = run(mkRepo(baseFiles()));
  const withGrowth = mkRepo(baseFiles({
    "burndown/growth.json": j(GROWTH),
    "burndown-manifest.json": j({ ...MANIFEST, sources: [
      { path: "burndown/register.json", kind: "register", precedence: 0 },
      { path: "burndown/growth.json", kind: "growth", precedence: 0 },
    ] }),
  }));
  const b = run(withGrowth);
  const dig = (s) => (s.match(/^sources_digest: (\S+)$/m) || [])[1];
  return dig(a.out) && dig(b.out) && dig(a.out) !== dig(b.out)
    ? true
    : "sources_digest did not change when the declared source set changed";
});

check("compliant/block-records-the-sha-it-was-generated-from", () => {
  const d = mkRepo(baseFiles());
  const r = run(d);
  const sha = (r.out.match(/^generated_from_sha: (\S+)$/m) || [])[1];
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: d, encoding: "utf8" }).trim();
  return sha === head ? true : `recorded ${sha}, HEAD is ${head}`;
});

// ── PRECEDENCE TOTALITY, AMBIGUITY, AND STALENESS ───────────────────────────
// Added 2026-08-18 after a correctness redteam. Each pins a defect that was LIVE
// and that the pre-existing cases could not see; each is named with the mutation
// that reds it.

check("compliant/manifest-source-REORDER-SAME-BASENAME-yields-identical-block", () => {
  // THE DISCRIMINATING FORM of the reorder case above. That one uses three
  // DISTINCT basenames (register/growth/refresh), so the comparator's filename key
  // resolved them whether or not the ordering was TOTAL — it passed against a
  // comparator that fell through to array position, which is exactly the property
  // it claims to test. Two sources sharing a basename in different directories is
  // the case that tells them apart: before the fix this returned Signed off 0 in
  // one order and 1 in the other. Reds if byPrecedence's last key is basename.
  const files = (order) => ({
    "REGISTER.md": "# Register\n",
    "burndown/x/reg.json": j({ _generated: "2026-08-01", _authority: "owner",
      items: [{ id: "R1", page: "Alpha", status: "Signed off" }] }),
    "burndown/y/reg.json": j({ _generated: "2026-08-01", _authority: "owner",
      items: [{ id: "R1", page: "Alpha", status: "Not started" }] }),
    "burndown-manifest.json": j({ ...MANIFEST, pages: ["Alpha"], sources: order }),
  });
  const fwd = [
    { path: "burndown/x/reg.json", kind: "register", precedence: 0 },
    { path: "burndown/y/reg.json", kind: "register", precedence: 0 },
  ];
  const a = run(mkRepo(files(fwd)), ["--json"]);
  const b = run(mkRepo(files([...fwd].reverse())), ["--json"]);
  if (a.code !== 0 || b.code !== 0) return `exit ${a.code}/${b.code}`;
  return a.out === b.out ? true : "reordering two same-basename sources CHANGED the counts";
});

check("refusal/non-integer-precedence-is-refused-not-read-as-zero", () => {
  // `precedence: "5"` was silently coerced to 0, flipping which source won and so
  // flipping the count, with no diagnostic. Reds if the coercion returns.
  const d = mkRepo(baseFiles({ "burndown-manifest.json": j({ ...MANIFEST,
    sources: [{ path: "burndown/register.json", kind: "register", precedence: "5" }] }) }));
  const r = run(d);
  return r.code === 2 && /not an integer/.test(r.err) ? true : `exit ${r.code}: ${r.err.slice(0, 160)}`;
});

check("compliant/integer-precedence-still-builds", () => {
  const d = mkRepo(baseFiles({ "burndown-manifest.json": j({ ...MANIFEST,
    sources: [{ path: "burndown/register.json", kind: "register", precedence: 5 }] }) }));
  return run(d).code === 0 ? true : "a numeric precedence must still build";
});

check("compliant/--check-stays-GREEN-across-commits", () => {
  // `generated_from_sha` is HEAD, and it was part of the equality comparison, so
  // --check reported STALE after the very commit that landed the block — and after
  // every commit thereafter. The fixed point was unreachable: regenerating carried
  // the new HEAD, committing it moved HEAD again. Reds if the sha is compared.
  const d = mkRepo(baseFiles());
  if (run(d, ["--write"]).code !== 0) return "write failed";
  execFileSync("git", ["add", "-A"], { cwd: d, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "land the block"], { cwd: d, stdio: "ignore" });
  if (run(d, ["--check"]).code !== 0) return "STALE immediately after committing the block";
  _commitFile(d, "unrelated.txt", "x\n");
  return run(d, ["--check"]).code === 0 ? true : "STALE after an unrelated commit";
});

check("refusal/--check-still-reds-on-a-hand-edited-block", () => {
  // The COMPLIANT POLE's opposite: excluding the sha must not blind --check. A
  // hand-edit and a moved source must both still exit 1.
  const d = mkRepo(baseFiles());
  run(d, ["--write"]);
  const t = path.join(d, "REGISTER.md");
  fs.writeFileSync(t, fs.readFileSync(t, "utf8").replace("**ALL PAGES**", "**ALL PAGES (edited)**"));
  if (run(d, ["--check"]).code !== 1) return "a hand-edited block was NOT reported stale";
  const d2 = mkRepo(baseFiles());
  run(d2, ["--write"]);
  const moved = _clone(REGISTER);
  moved.items[3].status = "Signed off";
  _commitFile(d2, "burndown/register.json", j(moved));
  const r = run(d2, ["--check"]);
  return r.code === 1 && /sources_digest/.test(r.err) ? true : `moved source: exit ${r.code}`;
});

check("refusal/ambiguous---quote-refuses-rather-than-answering-another-question", () => {
  // The normalizer folds spaces and hyphens, so pages `A B` and `A-B` collided and
  // `hits[0]` won: asking for one returned the OTHER page's count WITH A VALID
  // TOKEN. Reds if quoteFor goes back to taking the first hit.
  const reg = { _generated: "2026-08-01", _authority: "owner", items: [
    { id: "R1", page: "A B", status: "Signed off" },
    { id: "R2", page: "A-B", status: "Not started" },
  ] };
  const d = mkRepo({ "REGISTER.md": "# R\n", "burndown/register.json": j(reg),
    "burndown-manifest.json": j({ ...MANIFEST, pages: ["A B", "A-B"], sources: [
      { path: "burndown/register.json", kind: "register", precedence: 0 }] }) });
  const amb = run(d, ["--quote", "ab/open"]);
  if (amb.code !== 2 || !/AMBIGUOUS/.test(amb.err)) return `ambiguous quote: exit ${amb.code}`;
  // ...and the EXACT form must still answer, with the RIGHT page's number.
  const exact = run(d, ["--quote", "A-B/Open"]);
  return exact.code === 0 && /^A-B — 1/.test(exact.out.trim())
    ? true
    : `exact quote: exit ${exact.code}, out=${exact.out.trim().slice(0, 80)}`;
});

check("refusal/status-refresh-cannot-silently-move-an-item-between-pages", () => {
  // A refresh carrying a different `page` was accepted and the move DISCARDED: no
  // error, and counts that were plausible and wrong for the page being read.
  const refresh = { _generated: "2026-08-12", _authority: "owner",
    items: [{ id: "REG-04-B", page: "Alpha", status: "In progress" }] };
  const d = mkRepo(baseFiles({ "burndown/refresh.json": j(refresh),
    "burndown-manifest.json": j({ ...MANIFEST, sources: [
      { path: "burndown/register.json", kind: "register", precedence: 0 },
      { path: "burndown/refresh.json", kind: "status-refresh", precedence: 0 }] }) }));
  const r = run(d);
  return r.code === 2 && /cannot move an item between pages/.test(r.err)
    ? true : `exit ${r.code}: ${r.err.slice(0, 160)}`;
});

check("compliant/status-refresh-WITHOUT-a-page-still-refreshes", () => {
  const d = mkRepo(baseFiles({ "burndown/refresh.json": j(REFRESH),
    "burndown-manifest.json": j({ ...MANIFEST, sources: [
      { path: "burndown/register.json", kind: "register", precedence: 0 },
      { path: "burndown/refresh.json", kind: "status-refresh", precedence: 0 }] }) }));
  const r = run(d, ["--json"]);
  if (r.code !== 0) return `exit ${r.code}: ${r.err.slice(0, 160)}`;
  return JSON.parse(r.out).all.blockedOnYou === 1 ? true : "the refresh did not apply";
});

check("refusal/a-page-named-ALL-PAGES-is-refused", () => {
  // `ALL PAGES` is the DERIVED row; a declared page of that name would put two rows
  // under one name and make a quote naming it ambiguous.
  const reg = { _generated: "2026-08-01", _authority: "owner",
    items: [{ id: "R1", page: "ALL PAGES", status: "Signed off" }] };
  const d = mkRepo({ "REGISTER.md": "# R\n", "burndown/register.json": j(reg),
    "burndown-manifest.json": j({ ...MANIFEST, pages: ["ALL PAGES"], sources: [
      { path: "burndown/register.json", kind: "register", precedence: 0 }] }) });
  const r = run(d);
  return r.code === 2 && /reserved DERIVED row/.test(r.err) ? true : `exit ${r.code}`;
});

check("refusal/a-duplicated-page-declaration-is-refused", () => {
  const d = mkRepo(baseFiles({ "burndown-manifest.json":
    j({ ...MANIFEST, pages: ["Alpha", "Beta", "Alpha"] }) }));
  const r = run(d);
  return r.code === 2 && /more than once/.test(r.err) ? true : `exit ${r.code}`;
});

// ── THE TRACEABILITY CHAIN — id → tracker row → context artifact ────────────
//
// Poles for `burndown-build.mjs`'s LINK-1/2/3 checks. They live HERE and not in
// `.claude/bin/burndown-build.test.mjs` for one measured reason: that suite is
// enumerated by NO CI surface. `grep -rn 'burndown-build.test' ci-suites.json
// .github/` returns nothing, against a control (`probe-suite-integrity`) that
// the same grep DOES find on the same tree — so a pole added there would be a
// pole that never runs, which is the unwired-fixture defect this registry's own
// `_doc` was written about. This runner IS registered in `ci-audit-fixtures.json`.
//
// BIPOLAR PER LEG, and every firing pole asserts the LEG IDENTITY, never a bare
// exit code: `exit 2` is also what a bad status, an uncommitted source and a
// malformed manifest produce, so an exit-code-only assertion would pass against
// a checker that had stopped looking at links entirely.

const TRACE_REGISTER = {
  _generated: "2026-08-21",
  _authority: "agent",
  items: [{ id: "X1-alpha-item", page: "Alpha", status: "Not started" }],
};

/** `anchorCell` goes in the ledger's value_anchor column; `ctx` is the context file's body. */
function mkTraceRepo(anchorCell, ctx, { id = "X1-alpha-item", roots = ["workspaces/"] } = {}) {
  return mkRepo({
    "REGISTER.md": "# Register\n",
    "burndown/register.json": j(TRACE_REGISTER),
    "burndown-manifest.json": j({
      ...MANIFEST,
      pages: ["Alpha"],
      tracker: { path: "L.md", kind: "forest-ledger", anchor_roots: roots },
    }),
    "L.md":
      "| ID | owner | item | value_anchor | status |\n" +
      "| --- | --- | --- | --- | --- |\n" +
      `| ${id} | o | an item | ${anchorCell} | see burndown |\n`,
    "workspaces/ctx.md": ctx,
  });
}

// The SILENT pole. Without it every check below is consistent with a checker
// that refuses unconditionally, and a guard shown only to say "no" has not been
// shown to discriminate at all.
check("trace/compliant-intact-chain-builds-and-reports-what-it-checked", () => {
  const r = run(mkTraceRepo("`workspaces/ctx.md#X1-alpha-item`", "the ruling for X1-alpha-item\n"), ["--check-links"]);
  if (r.code !== 0) return `exit ${r.code}: ${r.err}`;
  // "no findings" and "nothing was checked" must not render alike.
  // The population is NAMED, not merely counted: with two item classes on one board,
  // `1 item(s)` could not say WHICH population LINK-1/2/3 examined. The count is still
  // pinned here — that is what keeps 'no findings' and 'nothing was checked' apart.
  return /chain INTACT — 1 ADJUDICATED item\(s\)/.test(r.out) ? true : `unexpected stdout: ${r.out}`;
});

check("trace/compliant-typography-does-not-break-a-link", () => {
  // Backticks, bold and [text](href) are RENDERING. A checker that rejected the
  // rendered form would train people to write bare paths into a markdown table.
  const r = run(mkTraceRepo("**`workspaces/ctx.md#X1-alpha-item`**", "the ruling for X1-alpha-item\n"), ["--check-links"]);
  return r.code === 0 && /chain INTACT/.test(r.out) ? true : `exit ${r.code}: ${r.err || r.out}`;
});

check("trace/violation-LINK-1-dangling-id-names-the-id-and-the-leg", () => {
  const r = run(mkTraceRepo("`workspaces/ctx.md#X1-alpha-item`", "the ruling for X1-alpha-item\n", { id: "SOMETHING-ELSE" }), [
    "--check-links",
  ]);
  if (r.code !== 2) return `exit ${r.code}, expected 2`;
  return /LINK-1\s+X1-alpha-item:/.test(r.err) ? true : `did not name LINK-1 + the id: ${r.err}`;
});

check("trace/violation-LINK-2-free-prose-is-not-a-pointer", () => {
  const r = run(mkTraceRepo("still being investigated", "the ruling for X1-alpha-item\n"), ["--check-links"]);
  if (r.code !== 2) return `exit ${r.code}, expected 2`;
  return /LINK-2\s+X1-alpha-item:.*free prose/.test(r.err) ? true : `wrong finding: ${r.err}`;
});

check("trace/violation-LINK-2-decoration-cell-is-not-a-pointer", () => {
  // An em-dash reads, to any scanner keyed on non-emptiness, exactly like a
  // filled-in link. That is the whole reason NON_ANCHORS exists.
  const r = run(mkTraceRepo("—", "the ruling for X1-alpha-item\n"), ["--check-links"]);
  if (r.code !== 2) return `exit ${r.code}, expected 2`;
  return /LINK-2\s+X1-alpha-item:.*decoration, not a pointer/.test(r.err) ? true : `wrong finding: ${r.err}`;
});

check("trace/violation-LINK-2-anchor-into-a-reconcilable-fragment-is-refused-BY-ROOT", () => {
  // The originating failure: `/reconcile-notes` pruned the rulings for eleven
  // register ids out of a `.session-notes.d/` fragment. An anchor there is a
  // link with an expiry date. Asserts it failed on the ROOT, not on some
  // incidental resolvability problem — otherwise this pole would pass against a
  // checker that had no notion of durable roots at all.
  const r = run(mkTraceRepo("`.session-notes.d/e.md#X1-alpha-item`", "the ruling for X1-alpha-item\n"), ["--check-links"]);
  if (r.code !== 2) return `exit ${r.code}, expected 2`;
  return /LINK-2\s+X1-alpha-item:.*outside every declared durable root/.test(r.err) ? true : `wrong finding: ${r.err}`;
});

check("trace/violation-LINK-2-untracked-anchor-is-not-durable", () => {
  const d = mkTraceRepo("`workspaces/ghost.md#X1-alpha-item`", "the ruling for X1-alpha-item\n");
  // Present on disk, deliberately NOT committed: it reaches no other operator.
  fs.writeFileSync(path.join(d, "workspaces", "ghost.md"), "X1-alpha-item lives here\n");
  const r = run(d, ["--check-links"]);
  if (r.code !== 2) return `exit ${r.code}, expected 2`;
  return /LINK-2\s+X1-alpha-item:.*not a tracked file/.test(r.err) ? true : `wrong finding: ${r.err}`;
});

check("trace/violation-LINK-2-a-SYMLINKED-anchor-escaping-the-tree-is-REFUSED", () => {
  // The lexical `startsWith(root)` + `..` checks are a SHAPE test, not a
  // containment decision (security.md § Path Containment). A symlink at a
  // lexically-contained, git-TRACKED path whose target sits outside the repo
  // passes every one of them, and `readFileSync` then verifies LINK-2 and LINK-3
  // against content no clone of this repo carries. Falsifying result named: were
  // the guard absent, this builds GREEN — the target contains the id, so LINK-3
  // is satisfied by out-of-tree bytes.
  // Registered: this site has an inline `rmSync` below, but it sits AFTER an early
  // `return` guard and outside any `finally`, so it leaks on that path, on any throw,
  // and on a signal. The commit that closed the other two sites said "Both leak
  // sites" while its own comment said "three" — this is the third.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "burndown-outside-"));
  FIXTURE_DIRS.push(outside);
  fs.writeFileSync(path.join(outside, "elsewhere.md"), "X1-alpha-item is described out here\n");
  const d = mkTraceRepo("`workspaces/link.md#X1-alpha-item`", "the ruling for X1-alpha-item\n");
  fs.symlinkSync(path.join(outside, "elsewhere.md"), path.join(d, "workspaces", "link.md"));
  execFileSync("git", ["add", "-A"], { cwd: d, stdio: "ignore" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "link"], { cwd: d, stdio: "ignore" });
  // Control: the symlink really is TRACKED, so this pole exercises the guard and
  // not an incidental "file missing" path.
  const staged = execFileSync("git", ["ls-files", "-s", "--", "workspaces/link.md"], { cwd: d, encoding: "utf8" });
  if (!/^120000 /.test(staged)) return `fixture did not stage a symlink: ${staged.trim()}`;
  const r = run(d, ["--check-links"]);
  fs.rmSync(outside, { recursive: true, force: true });
  if (r.code !== 2) return `exit ${r.code}, expected 2 — an out-of-tree symlink anchor was ACCEPTED`;
  return /LINK-2\s+X1-alpha-item:.*SYMLINK/.test(r.err) ? true : `wrong finding: ${r.err}`;
});

check("trace/violation-LINK-2-dead-fragment-points-at-the-files-silence", () => {
  const r = run(mkTraceRepo("`workspaces/ctx.md#NO-SUCH-SECTION`", "the ruling for X1-alpha-item\n"), ["--check-links"]);
  if (r.code !== 2) return `exit ${r.code}, expected 2`;
  return /LINK-2\s+X1-alpha-item:.*does not contain that string/.test(r.err) ? true : `wrong finding: ${r.err}`;
});

check("trace/violation-LINK-3-missing-back-reference-is-its-OWN-leg", () => {
  // The anchor resolves, the file is tracked, the chain still fails: without the
  // id in the target, `git grep -F <id>` never finds the ruling. Asserting the
  // leg is LINK-3 and not LINK-2 is what pins that this is a separate check.
  const r = run(mkTraceRepo("`workspaces/ctx.md`", "a ruling that never names the item\n"), ["--check-links"]);
  if (r.code !== 2) return `exit ${r.code}, expected 2`;
  return /LINK-3\s+X1-alpha-item:.*does not carry the id/.test(r.err) ? true : `wrong finding: ${r.err}`;
});

check("trace/violation-every-broken-item-is-reported-in-ONE-run", () => {
  // A checker that refused on the FIRST finding would turn a 26-row backfill
  // into 26 build cycles. Two items, both broken, both named.
  const d = mkRepo({
    "REGISTER.md": "# Register\n",
    "burndown/register.json": j({
      _generated: "2026-08-21",
      _authority: "agent",
      items: [
        { id: "X1-alpha-item", page: "Alpha", status: "Not started" },
        { id: "X2-alpha-item", page: "Alpha", status: "Not started" },
      ],
    }),
    "burndown-manifest.json": j({
      ...MANIFEST,
      pages: ["Alpha"],
      tracker: { path: "L.md", kind: "forest-ledger", anchor_roots: ["workspaces/"] },
    }),
    "L.md": "| ID | owner | item | value_anchor | status |\n| --- | --- | --- | --- | --- |\n| X1-alpha-item | o | i | prose |  |\n",
    "workspaces/ctx.md": "nothing\n",
  });
  const r = run(d, ["--check-links"]);
  if (r.code !== 2) return `exit ${r.code}, expected 2`;
  // Same reason as above: the denominator names the population the loop examined.
  if (!/BROKEN for 2 of 2 ADJUDICATED item\(s\)/.test(r.err)) return `did not count both: ${r.err}`;
  return /LINK-2\s+X1-alpha-item/.test(r.err) && /LINK-1\s+X2-alpha-item/.test(r.err) ? true : `missing a leg: ${r.err}`;
});

check("trace/violation-a-duplicated-ledger-row-is-refused-not-resolved-arbitrarily", () => {
  const d = mkRepo({
    "REGISTER.md": "# Register\n",
    "burndown/register.json": j(TRACE_REGISTER),
    "burndown-manifest.json": j({
      ...MANIFEST,
      pages: ["Alpha"],
      tracker: { path: "L.md", kind: "forest-ledger", anchor_roots: ["workspaces/"] },
    }),
    "L.md":
      "| ID | owner | item | value_anchor | status |\n| --- | --- | --- | --- | --- |\n" +
      "| X1-alpha-item | o | i | `workspaces/ctx.md#X1-alpha-item` |  |\n| X1-alpha-item | o | i | prose |  |\n",
    "workspaces/ctx.md": "the ruling for X1-alpha-item\n",
  });
  const r = run(d, ["--check-links"]);
  return r.code === 2 && /more than once/.test(r.err) ? true : `exit ${r.code}: ${r.err}`;
});

check("trace/violation-an-unparseable-tracker-table-refuses-rather-than-reporting-clean", () => {
  // A tracker whose table cannot be found reports NOTHING, which is byte-identical
  // to a tracker whose every row is present. Not-found must not read as clean.
  const d = mkRepo({
    "REGISTER.md": "# Register\n",
    "burndown/register.json": j(TRACE_REGISTER),
    "burndown-manifest.json": j({
      ...MANIFEST,
      pages: ["Alpha"],
      tracker: { path: "L.md", kind: "forest-ledger", anchor_roots: ["workspaces/"] },
    }),
    "L.md": "# Forest Ledger\n\nno table here at all\n",
    "workspaces/ctx.md": "the ruling for X1-alpha-item\n",
  });
  const r = run(d, ["--check-links"]);
  return r.code === 2 && /no parseable ledger table/.test(r.err) ? true : `exit ${r.code}: ${r.err}`;
});

check("trace/violation-a-tracker-missing-the-value_anchor-column-is-refused", () => {
  const d = mkRepo({
    "REGISTER.md": "# Register\n",
    "burndown/register.json": j(TRACE_REGISTER),
    "burndown-manifest.json": j({
      ...MANIFEST,
      pages: ["Alpha"],
      tracker: { path: "L.md", kind: "forest-ledger", anchor_roots: ["workspaces/"] },
    }),
    "L.md": "| ID | owner | item | status |\n| --- | --- | --- | --- |\n| X1-alpha-item | o | i |  |\n",
    "workspaces/ctx.md": "the ruling for X1-alpha-item\n",
  });
  const r = run(d, ["--check-links"]);
  return r.code === 2 && /no 'value_anchor' column/.test(r.err) ? true : `exit ${r.code}: ${r.err}`;
});

check("trace/violation-a-broken-chain-refuses-the-BLOCK-not-just---check-links", () => {
  // The gate is in `build()`, so EVERY mode is on it. If it only guarded
  // `--check-links`, `--write` would happily emit a block for items whose
  // context cannot be reached — and the block is the thing people quote.
  const d = mkTraceRepo("prose", "nothing\n");
  for (const mode of ["--write", "--check", "--json", "--quote", "ALL PAGES/Open"]) {
    if (mode === "ALL PAGES/Open") continue;
    const r = run(d, mode === "--quote" ? [mode, "ALL PAGES/Open"] : [mode]);
    if (r.code !== 2) return `${mode} exited ${r.code}, expected 2`;
    if (!/traceability chain is BROKEN/.test(r.err)) return `${mode} refused for another reason: ${r.err}`;
  }
  return true;
});

check("trace/scoping-a-manifest-with-NO-tracker-checks-nothing-and-SAYS-so", () => {
  // A BUILD or USE repo may carry a burndown and no Forest Ledger. It must not
  // break — but "absent" must not print as "clean".
  const r = run(mkRepo(baseFiles()), ["--check-links"]);
  if (r.code !== 0) return `exit ${r.code}: ${r.err}`;
  return /declares NO tracker, so NO link was checked/.test(r.out) && /not a clean result/.test(r.out)
    ? true
    : `absent rendered as clean: ${r.out}`;
});

check("trace/scoping-a-manifest-with-no-tracker-still-BUILDS-exactly-as-before", () => {
  const r = run(mkRepo(baseFiles()));
  return r.code === 0 && /BURNDOWN:BEGIN/.test(r.out) ? true : `exit ${r.code}: ${r.err}`;
});

check("trace/violation-a-tracker-modified-against-HEAD-is-refused-like-any-source", () => {
  // A chain verified against a working-tree edit is a chain claim about content
  // no reader has.
  const d = mkTraceRepo("`workspaces/ctx.md#X1-alpha-item`", "the ruling for X1-alpha-item\n");
  fs.appendFileSync(path.join(d, "L.md"), "| X9 | o | i | prose |  |\n");
  const r = run(d, ["--check-links"]);
  return r.code === 2 && /uncommitted modifications against HEAD/.test(r.err) ? true : `exit ${r.code}: ${r.err}`;
});

check("trace/violation-an-anchor_roots-of-the-wrong-shape-is-refused-never-defaulted", () => {
  // Silently falling back to the defaults would change WHICH anchors resolve —
  // the same class as the precedence coercion refused above.
  const d = mkRepo({
    "REGISTER.md": "# Register\n",
    "burndown/register.json": j(TRACE_REGISTER),
    "burndown-manifest.json": j({
      ...MANIFEST,
      pages: ["Alpha"],
      tracker: { path: "L.md", kind: "forest-ledger", anchor_roots: "workspaces/" },
    }),
    "L.md": "| ID | owner | item | value_anchor | status |\n| --- | --- | --- | --- | --- |\n| X1-alpha-item | o | i | `workspaces/ctx.md#X1-alpha-item` |  |\n",
    "workspaces/ctx.md": "the ruling for X1-alpha-item\n",
  });
  const r = run(d, ["--check-links"]);
  return r.code === 2 && /expected a non-empty array/.test(r.err) ? true : `exit ${r.code}: ${r.err}`;
});

check("trace/an-ORPHAN-ledger-row-is-NOT-a-finding", () => {
  // The ledger is broader than the burndown. LINK-1 runs from the ITEMS outward,
  // never from the ledger inward — a row that was never a register item is not
  // the burndown's business, and flagging it would make the ledger unusable for
  // anything else.
  const d = mkRepo({
    "REGISTER.md": "# Register\n",
    "burndown/register.json": j(TRACE_REGISTER),
    "burndown-manifest.json": j({
      ...MANIFEST,
      pages: ["Alpha"],
      tracker: { path: "L.md", kind: "forest-ledger", anchor_roots: ["workspaces/"] },
    }),
    "L.md":
      "| ID | owner | item | value_anchor | status |\n| --- | --- | --- | --- | --- |\n" +
      "| X1-alpha-item | o | i | `workspaces/ctx.md#X1-alpha-item` |  |\n" +
      "| NOT-A-BURNDOWN-ROW | o | i | who knows |  |\n",
    "workspaces/ctx.md": "the ruling for X1-alpha-item\n",
  });
  const r = run(d, ["--check-links"]);
  return r.code === 0 && /chain INTACT/.test(r.out) ? true : `exit ${r.code}: ${r.err || r.out}`;
});

// ── THE ADVERSARIAL SET — four confirmed bypasses, each MEASURED reporting
//    `chain INTACT` on a broken chain before the fix ──────────────────────────
//
// These are not hypotheticals. Every one was reproduced against the shipped
// checker and printed `chain INTACT — 1 item(s) …`. They are grouped because they
// share a property the leg poles above do not test: each defeats the gate WITHOUT
// breaking any individual leg, either by making the checker read something other
// than what a human reviewing the ledger reads, or by making a leg unfalsifiable.

check("adversarial/an-ESCAPED-PIPE-must-not-shift-which-cell-is-the-anchor", () => {
  // GFM renders `\|` as a literal pipe INSIDE a cell. A naive `.split("|")`
  // produced an extra cell and shifted every later index, so the reviewer
  // adjudicated one `value_anchor` and the checker verified a different one.
  //
  // The DISCRIMINATING shape, and the reason this pole is not just "does it still
  // pass": the reviewer-visible column holds a BROKEN anchor and the shift-target
  // column holds a VALID one. A parser reading the wrong cell reports INTACT; one
  // reading the reviewer's cell REFUSES and names the broken value. Asserting the
  // NAMED value is what makes this non-vacuous — a bare exit-2 assertion would
  // also pass against a parser that refused for some unrelated reason.
  const d = mkRepo({
    "REGISTER.md": "# Register\n",
    "burndown/register.json": j(TRACE_REGISTER),
    "burndown-manifest.json": j({
      ...MANIFEST,
      pages: ["Alpha"],
      tracker: { path: "L.md", kind: "forest-ledger", anchor_roots: ["workspaces/"] },
    }),
    "L.md":
      "| ID | owner | item | value_anchor | status |\n| --- | --- | --- | --- | --- |\n" +
      "| X1-alpha-item | o | note \\| workspaces/ctx.md | BROKEN-REVIEWER-SEES-THIS | s |\n",
    "workspaces/ctx.md": "the ruling for X1-alpha-item\n",
  });
  const r = run(d, ["--check-links"]);
  if (r.code !== 2) return `exit ${r.code} — the shifted cell was verified instead of the reviewer's`;
  return /BROKEN-REVIEWER-SEES-THIS/.test(r.err)
    ? true
    : `refused, but not for the reviewer-visible cell: ${r.err.slice(0, 200)}`;
});

check("adversarial/an-escaped-pipe-is-otherwise-TRANSPARENT-(no-false-positive)", () => {
  // The pole above proves the parser stops reading the wrong cell. This proves it
  // did not simply start rejecting escaped pipes — a legitimate row carrying one
  // must still resolve, or the fix would just be a new false positive.
  const d = mkRepo({
    "REGISTER.md": "# Register\n",
    "burndown/register.json": j(TRACE_REGISTER),
    "burndown-manifest.json": j({
      ...MANIFEST,
      pages: ["Alpha"],
      tracker: { path: "L.md", kind: "forest-ledger", anchor_roots: ["workspaces/"] },
    }),
    "L.md":
      "| ID | owner | item | value_anchor | status |\n| --- | --- | --- | --- | --- |\n" +
      "| X1-alpha-item | o | a \\| b | `workspaces/ctx.md#X1-alpha-item` | s |\n",
    "workspaces/ctx.md": "the ruling for X1-alpha-item\n",
  });
  const r = run(d, ["--check-links"]);
  return r.code === 0 && /chain INTACT/.test(r.out) ? true : `exit ${r.code}: ${r.err || r.out}`;
});

check("adversarial/an-extra-UNESCAPED-pipe-refuses-on-cell-count-rather-than-shifting", () => {
  const d = mkRepo({
    "REGISTER.md": "# Register\n",
    "burndown/register.json": j(TRACE_REGISTER),
    "burndown-manifest.json": j({
      ...MANIFEST,
      pages: ["Alpha"],
      tracker: { path: "L.md", kind: "forest-ledger", anchor_roots: ["workspaces/"] },
    }),
    "L.md":
      "| ID | owner | item | value_anchor | status |\n| --- | --- | --- | --- | --- |\n" +
      "| X1-alpha-item | o | a | b | `workspaces/ctx.md` | s |\n",
    "workspaces/ctx.md": "the ruling for X1-alpha-item\n",
  });
  const r = run(d, ["--check-links"]);
  return r.code === 2 && /has 6 cells but the header declares 5/.test(r.err) ? true : `exit ${r.code}: ${r.err}`;
});

check("adversarial/a-FENCED-CODE-decoy-table-must-not-become-THE-ledger", () => {
  // Measured before the fix: this exact tree reported `chain INTACT` while the
  // REAL ledger row was prose. The decoy renders to a human as a documentation
  // example; the parser took the first header-plus-separator pair in the file and
  // stopped. Asserting the refusal names the REAL row's broken value is what
  // proves the fence was skipped rather than the whole file rejected.
  const d = mkRepo({
    "REGISTER.md": "# Register\n",
    "burndown/register.json": j(TRACE_REGISTER),
    "burndown-manifest.json": j({
      ...MANIFEST,
      pages: ["Alpha"],
      tracker: { path: "L.md", kind: "forest-ledger", anchor_roots: ["workspaces/"] },
    }),
    "L.md":
      "# Forest Ledger\n\n```markdown\n| ID | value_anchor |\n| --- | --- |\n" +
      "| X1-alpha-item | `workspaces/ctx.md` |\n```\n\n" +
      "| ID | owner | item | value_anchor | status |\n| --- | --- | --- | --- | --- |\n" +
      "| X1-alpha-item | o | i | REAL-ROW-IS-BROKEN | s |\n",
    "workspaces/ctx.md": "the ruling for X1-alpha-item\n",
  });
  const r = run(d, ["--check-links"]);
  if (r.code !== 2) return `exit ${r.code} — the fenced decoy was accepted as the ledger`;
  return /REAL-ROW-IS-BROKEN/.test(r.err) ? true : `refused, but not on the real row: ${r.err.slice(0, 200)}`;
});

check("adversarial/TWO-candidate-ledger-tables-refuse-rather-than-position-deciding", () => {
  const d = mkRepo({
    "REGISTER.md": "# Register\n",
    "burndown/register.json": j(TRACE_REGISTER),
    "burndown-manifest.json": j({
      ...MANIFEST,
      pages: ["Alpha"],
      tracker: { path: "L.md", kind: "forest-ledger", anchor_roots: ["workspaces/"] },
    }),
    "L.md":
      "| ID | value_anchor |\n| --- | --- |\n| X1-alpha-item | `workspaces/ctx.md` |\n\n" +
      "some prose\n\n" +
      "| ID | owner | item | value_anchor | status |\n| --- | --- | --- | --- | --- |\n" +
      "| X1-alpha-item | o | i | `workspaces/ctx.md` | s |\n",
    "workspaces/ctx.md": "the ruling for X1-alpha-item\n",
  });
  const r = run(d, ["--check-links"]);
  return r.code === 2 && /candidate ledger tables/.test(r.err) ? true : `exit ${r.code}: ${r.err}`;
});

check("adversarial/a-SHORT-id-cannot-satisfy-LINK-3-by-substring-accident", () => {
  // LINK-3 is a substring test, so an id of `e` matched essentially every file —
  // measured reporting INTACT. The floor is the one security.md § Redactor
  // Contract sets for the identical class, and it also enforces the descriptive
  // suffix the bare F-NN namespace collision makes necessary.
  const d = mkRepo({
    "REGISTER.md": "# Register\n",
    "burndown/register.json": j({
      _generated: "2026-08-21",
      _authority: "agent",
      items: [{ id: "e", page: "Alpha", status: "Not started" }],
    }),
    "burndown-manifest.json": j({
      ...MANIFEST,
      pages: ["Alpha"],
      tracker: { path: "L.md", kind: "forest-ledger", anchor_roots: ["workspaces/"] },
    }),
    "L.md": "| ID | owner | item | value_anchor | status |\n| --- | --- | --- | --- | --- |\n| e | o | i | `workspaces/ctx.md` | s |\n",
    "workspaces/ctx.md": "prose that happens to contain the letter e\n",
  });
  const r = run(d, ["--check-links"]);
  if (r.code !== 2) return `exit ${r.code} — a 1-character id satisfied LINK-3`;
  return /LINK-3\s+e: the id is 1 character\(s\); the floor is 8/.test(r.err) ? true : `wrong finding: ${r.err}`;
});

check("adversarial/an-anchor_root-admitting-the-REGISTER-itself-is-refused", () => {
  // `"anchor_roots": ["burndown/"]` lets every row anchor at the register, which
  // contains every id BY CONSTRUCTION — so LINK-2 and LINK-3 pass for every item
  // at once and the tool prints INTACT. One manifest line, whole gate vacuous.
  const d = mkRepo({
    "REGISTER.md": "# Register\n",
    "burndown/register.json": j(TRACE_REGISTER),
    "burndown-manifest.json": j({
      ...MANIFEST,
      pages: ["Alpha"],
      tracker: { path: "L.md", kind: "forest-ledger", anchor_roots: ["burndown/"] },
    }),
    "L.md": "| ID | owner | item | value_anchor | status |\n| --- | --- | --- | --- | --- |\n| X1-alpha-item | o | i | `burndown/register.json` | s |\n",
    "workspaces/ctx.md": "unused\n",
  });
  const r = run(d, ["--check-links"]);
  return r.code === 2 && /admits the burndown's own input/.test(r.err) ? true : `exit ${r.code}: ${r.err}`;
});

check("adversarial/an-anchor_root-re-admitting-.session-notes.d-is-refused", () => {
  const d = mkRepo({
    "REGISTER.md": "# Register\n",
    "burndown/register.json": j(TRACE_REGISTER),
    "burndown-manifest.json": j({
      ...MANIFEST,
      pages: ["Alpha"],
      tracker: { path: "L.md", kind: "forest-ledger", anchor_roots: [".session-notes.d/"] },
    }),
    "L.md": "| ID | owner | item | value_anchor | status |\n| --- | --- | --- | --- | --- |\n| X1-alpha-item | o | i | `.session-notes.d/e.md` | s |\n",
    "workspaces/ctx.md": "unused\n",
  });
  const r = run(d, ["--check-links"]);
  return r.code === 2 && /is MEMORY/.test(r.err) ? true : `exit ${r.code}: ${r.err}`;
});

check("adversarial/an-UNCOMMITTED-worktree-edit-cannot-satisfy-LINK-3", () => {
  // The chain is verified against COMMITTED bytes. Before the fix an agent could
  // add the id to a file, get INTACT, and never commit it — the block would then
  // record a `generated_from_sha` whose chain does not hold at that SHA.
  const d = mkTraceRepo("`workspaces/ctx.md#X1-alpha-item`", "no id here yet\n");
  const before = run(d, ["--check-links"]);
  if (before.code !== 2) return `control failed: committed tree should be BROKEN, got exit ${before.code}`;
  // Add the id in the WORKING TREE ONLY.
  fs.writeFileSync(path.join(d, "workspaces", "ctx.md"), "the ruling for X1-alpha-item\n");
  const after = run(d, ["--check-links"]);
  if (after.code !== 2) return `exit ${after.code} — an uncommitted edit was accepted as the chain`;
  return /uncommitted modifications against HEAD|not present in HEAD/.test(after.err)
    ? true
    : `refused for the wrong reason: ${after.err.slice(0, 200)}`;
});

check("trace/compliant-a-REORDERED-header-still-resolves-(parse-by-NAME-not-position)", () => {
  // The load-bearing design claim: the `coc-ledger` merge driver reads this same
  // file and is entitled to reorder columns. Without this pole a POSITIONAL
  // implementation passes the entire suite — measured: hardcoding
  // `idAt=0, anchorAt=3` survived 84/84.
  const d = mkRepo({
    "REGISTER.md": "# Register\n",
    "burndown/register.json": j(TRACE_REGISTER),
    "burndown-manifest.json": j({
      ...MANIFEST,
      pages: ["Alpha"],
      tracker: { path: "L.md", kind: "forest-ledger", anchor_roots: ["workspaces/"] },
    }),
    "L.md":
      "| value_anchor | status | ID | owner | item |\n| --- | --- | --- | --- | --- |\n" +
      "| `workspaces/ctx.md#X1-alpha-item` | s | X1-alpha-item | o | i |\n",
    "workspaces/ctx.md": "the ruling for X1-alpha-item\n",
  });
  const r = run(d, ["--check-links"]);
  return r.code === 0 && /chain INTACT/.test(r.out) ? true : `exit ${r.code}: ${r.err || r.out}`;
});

// ── COVERAGE + UNEXPLAINED-DROP — the two gates that ground the denominator ──

function mkCoverageRepo({ inventory, tracker = {}, ledgerRows = null } = {}) {
  const files = {
    "REGISTER.md": "# Register\n",
    "burndown/register.json": j(TRACE_REGISTER),
    "burndown-manifest.json": j({
      ...MANIFEST,
      pages: ["Alpha"],
      tracker: { path: "L.md", kind: "forest-ledger", anchor_roots: ["workspaces/"], ...tracker },
      ...(inventory ? { inventory: { path: "burndown/inventory.json", ...inventory } } : {}),
    }),
    "L.md":
      "| ID | owner | item | value_anchor | status |\n| --- | --- | --- | --- | --- |\n" +
      (ledgerRows ?? [`| X1-alpha-item | o | i | \`workspaces/ctx.md#X1-alpha-item\` | s |`]).join("\n") +
      "\n",
    "workspaces/ctx.md": "the ruling for X1-alpha-item and X2-alpha-item\n",
  };
  if (inventory) files["burndown/inventory.json"] = j(inventory._doc);
  return mkRepo(files);
}

check("coverage/an-inventory-item-with-NO-tracker-row-REFUSES", () => {
  // The gate that makes the denominator a denominator OF something. Without it a
  // block is internally rigorous over whatever population happened to be indexed.
  const d = mkCoverageRepo({
    inventory: { _doc: { items: [{ id: "X1-alpha-item" }, { id: "GH-9001-orphan" }] } },
  });
  const r = run(d, ["--check-links"]);
  if (r.code !== 2) return `exit ${r.code} — an uncovered inventory item passed`;
  return /COVERAGE\s+GH-9001-orphan/.test(r.err) ? true : `wrong finding: ${r.err.slice(0, 200)}`;
});

check("coverage/compliant-full-coverage-passes-and-SAYS-coverage-was-checked", () => {
  const d = mkCoverageRepo({ inventory: { _doc: { items: [{ id: "X1-alpha-item" }] } } });
  const r = run(d, ["--check-links"]);
  if (r.code !== 0) return `exit ${r.code}: ${r.err}`;
  return /COVERAGE: every inventory item resolves/.test(r.out) ? true : `did not report coverage: ${r.out}`;
});

check("coverage/NO-inventory-reports-ABSENT-never-clean", () => {
  const d = mkCoverageRepo({});
  const r = run(d, ["--check-links"]);
  if (r.code !== 0) return `exit ${r.code}: ${r.err}`;
  return /COVERAGE: NOT CHECKED/.test(r.out) && /ABSENT result, not a clean one/.test(r.out)
    ? true
    : `absent rendered as clean: ${r.out}`;
});

check("coverage/a-dated-owner-accepted-migration_baseline-EXCUSES-a-named-id", () => {
  // The migration path. A pre-existing backlog must not red the gate on day one —
  // the first person blocked by an always-refusing assertion is the one who turns
  // it off.
  const d = mkCoverageRepo({
    inventory: {
      _doc: {
        items: [{ id: "X1-alpha-item" }, { id: "GH-9001-orphan" }],
      },
      migration_baseline: undefined,
    },
  });
  // Re-write the manifest with the baseline attached (the helper keeps _doc separate).
  const mf = JSON.parse(fs.readFileSync(path.join(d, "burndown-manifest.json"), "utf8"));
  mf.inventory.migration_baseline = {
    reason: "pre-existing backlog, queued for the migration lane",
    expires: "2099-01-01",
    accepted_by: "repo-owner",
    uncovered_ids: ["GH-9001-orphan"],
  };
  _commitFile(d, "burndown-manifest.json", j(mf));
  const r = run(d, ["--check-links"]);
  return r.code === 0 && /chain INTACT/.test(r.out) ? true : `exit ${r.code}: ${r.err || r.out}`;
});

check("coverage/an-AGENT-accepted-baseline-is-REFUSED-(cannot-accept-own-residual)", () => {
  const d = mkCoverageRepo({ inventory: { _doc: { items: [{ id: "X1-alpha-item" }, { id: "GH-9001-orphan" }] } } });
  const mf = JSON.parse(fs.readFileSync(path.join(d, "burndown-manifest.json"), "utf8"));
  mf.inventory.migration_baseline = {
    reason: "r",
    expires: "2099-01-01",
    accepted_by: "agent",
    uncovered_ids: ["GH-9001-orphan"],
  };
  _commitFile(d, "burndown-manifest.json", j(mf));
  const r = run(d, ["--check-links"]);
  return r.code === 2 && /cannot also accept it/.test(r.err) ? true : `exit ${r.code}: ${r.err}`;
});

check("coverage/an-EXPIRED-baseline-stops-excusing-anything", () => {
  const d = mkCoverageRepo({ inventory: { _doc: { items: [{ id: "X1-alpha-item" }, { id: "GH-9001-orphan" }] } } });
  const mf = JSON.parse(fs.readFileSync(path.join(d, "burndown-manifest.json"), "utf8"));
  mf.inventory.migration_baseline = {
    reason: "r",
    expires: "2000-01-01",
    accepted_by: "repo-owner",
    uncovered_ids: ["GH-9001-orphan"],
  };
  _commitFile(d, "burndown-manifest.json", j(mf));
  const r = run(d, ["--check-links"]);
  return r.code === 2 && /EXPIRED on 2000-01-01/.test(r.err) ? true : `exit ${r.code}: ${r.err}`;
});

check("coverage/a-baseline-with-no-expires-is-REFUSED-(permanent-by-default)", () => {
  const d = mkCoverageRepo({ inventory: { _doc: { items: [{ id: "X1-alpha-item" }, { id: "GH-9001-orphan" }] } } });
  const mf = JSON.parse(fs.readFileSync(path.join(d, "burndown-manifest.json"), "utf8"));
  mf.inventory.migration_baseline = { reason: "r", accepted_by: "repo-owner", uncovered_ids: ["GH-9001-orphan"] };
  _commitFile(d, "burndown-manifest.json", j(mf));
  const r = run(d, ["--check-links"]);
  return r.code === 2 && /no 'expires'/.test(r.err) ? true : `exit ${r.code}: ${r.err}`;
});

check("coverage/a-STALE-baseline-entry-is-REFUSED-(an-exemption-outliving-its-cause)", () => {
  // The named id IS now covered. Leaving it listed keeps an allowance open that
  // nobody rechecks, and the NEXT gap hides inside it.
  const d = mkCoverageRepo({ inventory: { _doc: { items: [{ id: "X1-alpha-item" }] } } });
  const mf = JSON.parse(fs.readFileSync(path.join(d, "burndown-manifest.json"), "utf8"));
  mf.inventory.migration_baseline = {
    reason: "r",
    expires: "2099-01-01",
    accepted_by: "repo-owner",
    uncovered_ids: ["X1-alpha-item"],
  };
  _commitFile(d, "burndown-manifest.json", j(mf));
  const r = run(d, ["--check-links"]);
  return r.code === 2 && /no longer\s+uncovered/.test(r.err) ? true : `exit ${r.code}: ${r.err}`;
});

check("coverage/the-baseline-is-ENUMERATED-not-a-count-so-a-NEW-gap-cannot-hide-in-it", () => {
  // Two uncovered ids, only one excused. A count-shaped allowance ("2 uncovered
  // permitted") would swallow the second silently; an enumeration cannot.
  const d = mkCoverageRepo({
    inventory: { _doc: { items: [{ id: "X1-alpha-item" }, { id: "GH-9001-orphan" }, { id: "GH-9002-newgap" }] } },
  });
  const mf = JSON.parse(fs.readFileSync(path.join(d, "burndown-manifest.json"), "utf8"));
  mf.inventory.migration_baseline = {
    reason: "r",
    expires: "2099-01-01",
    accepted_by: "repo-owner",
    uncovered_ids: ["GH-9001-orphan"],
  };
  _commitFile(d, "burndown-manifest.json", j(mf));
  const r = run(d, ["--check-links"]);
  if (r.code !== 2) return `exit ${r.code} — the un-named new gap was swallowed`;
  return /COVERAGE\s+GH-9002-newgap/.test(r.err) && !/GH-9001-orphan/.test(r.err)
    ? true
    : `wrong findings: ${r.err.slice(0, 250)}`;
});

check("drop/a-ledger-that-SHRANK-below-its-declared-reconciled-count-REFUSES", () => {
  // The failure this exists for, one layer up: an index that quietly empties makes
  // every consumer keyed on "how much open work is there?" report a clear board
  // rather than a starved one.
  const d = mkCoverageRepo({ tracker: { min_rows: 3 } });
  const r = run(d, ["--check-links"]);
  return r.code === 2 && /carries 1 row\(s\) but the manifest declares it was last\s+reconciled at 3/.test(r.err)
    ? true
    : `exit ${r.code}: ${r.err}`;
});

check("drop/GROWTH-is-free-and-needs-no-re-declaration", () => {
  // A floor that fights a bulk migration is a floor someone switches off. Only a
  // SHRINK is anomalous.
  const d = mkCoverageRepo({
    tracker: { min_rows: 1 },
    ledgerRows: [
      "| X1-alpha-item | o | i | `workspaces/ctx.md#X1-alpha-item` | s |",
      "| X9-extra-row-item | o | i | `workspaces/ctx.md` | s |",
    ],
  });
  const r = run(d, ["--check-links"]);
  // X9 is an ORPHAN ledger row (not a register item), so it is correctly not a
  // finding — and the row count grew, which must not refuse.
  return r.code === 0 && /chain INTACT/.test(r.out) ? true : `exit ${r.code}: ${r.err || r.out}`;
});

// ── LIVE SOURCES — membership is re-derived, and staleness is LOUD ──────────
//
// TWO BEHAVIOURS, EACH BIPOLAR. A suite that only shows a generator REFUSING proves it
// can say "no"; it does not prove the live query is READ. So the membership behaviour is
// pinned by a DISCRIMINATION triple — one frozen source, three different query outputs,
// three different ALL-PAGES totals. If the generator ignored the query (which IS the
// defect these cases exist for: a static snapshot declared `kind: growth`, counted
// forever) all three would print the SAME total and all three cases would fail together.
//
// THE LEVER IS THE QUERY'S OUTPUT, nothing else — same binary, same arguments, same
// frozen `original_ids`, same adjudication. That is what makes the pair meaningful.

const LIVE_ORIGINAL = ["LIVE-01-BETA-ORIGINAL", "LIVE-02-BETA-ORIGINAL", "LIVE-03-BETA-DRAINS"];
const LIVE_ARRIVAL = "LIVE-99-BETA-ARRIVED";

/** A date N days before today, UTC, as YYYY-MM-DD. Computed, never hard-coded: a fixture
 *  carrying a literal `as_of` is a time bomb that starts refusing on some future morning. */
function isoDaysAgo(n) {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - n))
    .toISOString()
    .slice(0, 10);
}

/** A committed node script whose whole job is to print a membership set. */
function queryScript(ids) {
  return `process.stdout.write(${JSON.stringify(ids.join("\n") + "\n")});\n`;
}
const FAILING_QUERY = `process.stderr.write("the registry is unreachable\\n");\nprocess.exit(1);\n`;

function liveDoc(over = {}) {
  const doc = {
    _note: "fixture",
    _generated: "2026-08-20",
    _authority: "agent",
    // NO `min_members`. It is SUPERSEDED by the manifest's derived `floors` node and a
    // source still carrying it now REFUSES — so leaving it here would make every case
    // below refuse for the legacy-key reason rather than the one it was written for.
    membership: {
      command: [process.execPath, "burndown/query.mjs"],
      as_of: isoDaysAgo(2),
      max_age_days: 7,
    },
    original_ids: LIVE_ORIGINAL.slice(),
    arrival_defaults: { page: "Beta", status: "Not started" },
    items: LIVE_ORIGINAL.map((id) => ({ id, page: "Beta", status: "Not started" })),
  };
  if (over.membership === null) delete doc.membership;
  else if (over.membership) Object.assign(doc.membership, over.membership);
  for (const k of ["original_ids", "arrival_defaults", "items", "_generated"]) {
    if (over[k] !== undefined) doc[k] = over[k];
  }
  if (over.dropMaxAge) delete doc.membership.max_age_days;
  return doc;
}

// ── THE DERIVED FLOOR'S FIXTURE SURFACE ─────────────────────────────────────
//
// A manifest declaring ANY live or projected source must also declare a `floors` node,
// and every such source needs a PRIOR OBSERVATION in the file it names — those are the
// generator's two refusals, so every live/projected fixture below carries both.
//
// The default observation is the DEFAULT MEMBER COUNT (3) at the permissive end of the
// tolerance (0.75 -> derived floor 1), chosen so the pre-existing cases keep testing the
// thing they were written for: they vary the live set between 1 and 4 members, and a
// tighter floor would make half of them refuse for a reason none of them is about.
// Cases that ARE about the floor declare their own observation and fraction.
const FLOORS_REL = "burndown/observed-floors.json";
const FLOORS_SCHEMA_ID = "burndown-observed-floors/v1";

/**
 * `{subject: members}` -> a committed floors document. `at` is COMPUTED, never literal.
 *
 * `by: "build"` with a NULL reason is the one shape an automatically-banked measurement
 * takes: the generator refuses an observation whose `by` is anything but `build` or
 * `reground`, requires a 24-character reason on a `reground` row, and requires the ABSENCE
 * of one on a `build` row. A row that does not say WHICH is a number of unknown
 * provenance, which is the whole thing this file exists to prevent.
 */
function floorsDoc(observations) {
  const obs = {};
  for (const [subject, members] of Object.entries(observations)) {
    obs[subject] = { members, at: isoDaysAgo(3), by: "build", reason: null };
  }
  return { _schema: FLOORS_SCHEMA_ID, observations: obs };
}

function floorsNode(frac = 0.75) {
  return { path: FLOORS_REL, max_drop_fraction: frac };
}

const LIVE_MANIFEST = {
  ...MANIFEST,
  floors: floorsNode(),
  sources: [
    { path: "burndown/register.json", kind: "register", precedence: 0 },
    { path: "burndown/live.json", kind: "live-growth", precedence: 0 },
  ],
};

function liveFiles({ ids = LIVE_ORIGINAL, doc, manifest, query, floors, observed = 3 } = {}) {
  return {
    "burndown/live.json": j(doc || liveDoc()),
    "burndown/query.mjs": query || queryScript(ids),
    [FLOORS_REL]: j(floors || floorsDoc({ "burndown/live.json": observed })),
    "burndown-manifest.json": j(manifest || LIVE_MANIFEST),
  };
}

/** The ALL PAGES row as numbers, token decoration stripped. Column order is COLUMNS:
 *  KEYED BY COLUMN, never positional. It was positional, and a positional reader is
 *  exactly what breaks silently when a column is inserted: every index after the new
 *  one shifts and each assertion starts checking a DIFFERENT column while still
 *  passing or failing for reasons that look plausible. It also could not represent the
 *  ABSENT cell — `Number("—")` is NaN, which compares false against everything and so
 *  turns "the question does not apply" into "the assertion failed" with no distinction
 *  from a real miscount. `null` is returned for an absent cell so a case can assert
 *  ABSENCE explicitly. */
const ALL_PAGES_KEYS = [
  "board", "adjudicated", "signedOff", "builtNotWalked", "inProgress", "notStarted",
  "blockedOnYou", "open", "projected", "openBoth", "openFromRegister", "openArrivedSince",
];
function allPagesRow(out) {
  const m = out.match(/^\| \*\*ALL PAGES\*\* \|(.*)$/m);
  if (!m) return null;
  const cells = m[1]
    .replace(/\*\*/g, "")
    .replace(/⟨[^⟩]*⟩/g, "")
    .split("|")
    .map((x) => x.trim())
    .filter((x) => x !== "");
  if (cells.length !== ALL_PAGES_KEYS.length) return null;
  const o = {};
  ALL_PAGES_KEYS.forEach((k, i) => (o[k] = cells[i] === "—" ? null : Number(cells[i])));
  return o;
}

// ── COMPLIANT POLE — a live source builds, and it counts the LIVE set ────────

check("compliant/live-source-builds-and-counts-the-LIVE-membership", () => {
  const d = mkRepo(baseFiles(liveFiles()));
  const r = run(d);
  if (r.code !== 0) return `expected exit 0, got ${r.code}: ${r.err.slice(0, 300)}`;
  const all = allPagesRow(r.out);
  // 5 register items (3 Alpha Signed off, 2 Beta open) + 3 live members, all on Beta.
  return all && all.board === 8 && all.signedOff === 3 && all.open === 5 && all.openFromRegister === 2 && all.openArrivedSince === 3
    ? true
    : `ALL PAGES = ${JSON.stringify(all)}, wanted board 8, signed off 3, open 5, from-register 2, arrived-since 3`;
});

check("compliant/the-growth-SPLIT-survives-liveness (MUST-3's column)", () => {
  const d = mkRepo(baseFiles(liveFiles()));
  const r = run(d);
  const all = allPagesRow(r.out);
  // The split must still PARTITION Open, and the live members must land on the
  // 'arrived since' side — a live source is not the original ask.
  // A `live-growth` source produces ADJUDICATED items, so its openBoth equals its
  // adjudicated Open; the split is asserted against openBoth because that is the
  // denominator it partitions once a projected source is also present.
  return all && all.openFromRegister + all.openArrivedSince === all.openBoth && all.openArrivedSince === 3
    ? true
    : `split ${all && all.openFromRegister}+${all && all.openArrivedSince} vs openBoth ${all && all.openBoth}`;
});

// THE DISCRIMINATION TRIPLE. One frozen source, three query outputs, three totals.
// A generator that ignored the query would print 8 for all three.
{
  const variants = [
    ["frozen — the live set equals the frozen set", LIVE_ORIGINAL, 8, 3],
    ["DRAINED — one original id is no longer live", LIVE_ORIGINAL.slice(0, 2), 7, 2],
    ["ARRIVED — a member the freeze never saw", [...LIVE_ORIGINAL, LIVE_ARRIVAL], 9, 4],
  ];
  const seen = [];
  for (const [label, ids, wantTotal, wantArrived] of variants) {
    check(`live/membership-is-RE-DERIVED — ${label}`, () => {
      const d = mkRepo(baseFiles(liveFiles({ ids })));
      const r = run(d);
      if (r.code !== 0) return `expected exit 0, got ${r.code}: ${r.err.slice(0, 300)}`;
      const all = allPagesRow(r.out);
      seen.push(all && all.board);
      return all && all.board === wantTotal && all.openArrivedSince === wantArrived
        ? true
        : `ALL PAGES board ${all && all.board} / arrived-since ${all && all.openArrivedSince}, wanted ${wantTotal} / ${wantArrived}`;
    });
  }
  check("live/the-three-query-outputs-produce-THREE-DIFFERENT-totals", () => {
    // The falsifying result, stated: if the live query were ignored — the defect —
    // this would read [8, 8, 8] and the whole mechanism would carry no information.
    return new Set(seen).size === 3 ? true : `totals were [${seen.join(", ")}] — not all distinct`;
  });
}

check("live/a-DRAINED-id-is-REPORTED-not-silently-absorbed (--json)", () => {
  const d = mkRepo(baseFiles(liveFiles({ ids: LIVE_ORIGINAL.slice(0, 2) })));
  const r = run(d, ["--json"]);
  if (r.code !== 0) return `exit ${r.code}: ${r.err.slice(0, 200)}`;
  let doc;
  try {
    doc = JSON.parse(r.out);
  } catch (e) {
    return `--json did not emit JSON: ${e.message}`;
  }
  const live = (doc.live || [])[0];
  return live && live.drained_since_freeze.join(",") === "LIVE-03-BETA-DRAINS" && live.live_members === 2
    ? true
    : `live report was ${JSON.stringify(live)}`;
});

check("compliant/a-live-source-INSIDE-its-staleness-bound-builds", () => {
  const d = mkRepo(
    baseFiles(liveFiles({ doc: liveDoc({ membership: { as_of: isoDaysAgo(7), max_age_days: 7 } }) })),
  );
  const r = run(d);
  return r.code === 0 ? true : `exit ${r.code}: ${r.err.slice(0, 300)}`;
});

check("compliant/a-NON-live-source-still-builds-unchanged (no false positive)", () => {
  // The liveness gates must not fire on the sources that carry no liveness at all.
  const d = mkRepo(baseFiles({ "burndown/growth.json": j(GROWTH), "burndown-manifest.json": j({
    ...MANIFEST,
    sources: [
      { path: "burndown/register.json", kind: "register", precedence: 0 },
      { path: "burndown/growth.json", kind: "growth", precedence: 0 },
    ],
  }) }));
  const r = run(d);
  const all = allPagesRow(r.out);
  return r.code === 0 && all && all.board === 7 && all.openArrivedSince === 2 ? true : `exit ${r.code}, ALL PAGES=${JSON.stringify(all)}`;
});

// ── VIOLATION POLE — each MUST refuse with exit 2 and emit NO block ──────────

/** `refuses()` with the extra half this rule turns on: a refusal emits NO block. */
function refusesLive(name, files, reasonRx) {
  check(name, () => {
    const d = mkRepo(baseFiles(files));
    const r = run(d);
    if (r.code !== 2) return `expected exit 2, got ${r.code}. err=${r.err.slice(0, 300)}`;
    if (!/^UNRUNNABLE — refusing because /m.test(r.err)) return "no UNRUNNABLE banner on stderr";
    if (!reasonRx.test(r.err)) return `refused for the WRONG reason — wanted ${reasonRx}, got: ${r.err.split("\n")[0]}`;
    if (/BURNDOWN:BEGIN/.test(r.out) || /ALL PAGES/.test(r.out)) return "a refusal EMITTED A BLOCK on stdout";
    return true;
  });
}

refusesLive(
  "violation/live-source-PAST-its-staleness-bound-REFUSES",
  liveFiles({ doc: liveDoc({ membership: { as_of: isoDaysAgo(30), max_age_days: 7 } }) }),
  /is STALE: its frozen adjudication was taken 30 day\(s\) ago/,
);

refusesLive(
  "violation/the-staleness-bound-DISCRIMINATES-at-its-own-edge (bound+1)",
  // The compliant pole above builds at EXACTLY the bound (7 of 7). One day further
  // refuses. Without this pair the bound could be off by any amount and still look green.
  liveFiles({ doc: liveDoc({ membership: { as_of: isoDaysAgo(8), max_age_days: 7 } }) }),
  /is STALE: its frozen adjudication was taken 8 day\(s\) ago/,
);

refusesLive(
  "violation/an-as_of-in-the-FUTURE-REFUSES (the one edit that switches the gate off)",
  liveFiles({ doc: liveDoc({ membership: { as_of: isoDaysAgo(-5) } }) }),
  /which is in the FUTURE/,
);

refusesLive(
  "violation/a-live-source-with-NO-staleness-bound-REFUSES",
  liveFiles({ doc: liveDoc({ dropMaxAge: true }) }),
  /max_age_days undefined; expected an integer >= 1/,
);

refusesLive(
  "violation/a-live-query-that-FAILS-refuses-and-does-NOT-fall-back-to-the-snapshot",
  liveFiles({ query: FAILING_QUERY }),
  /LIVE membership query and it exited 1[\s\S]*NO fallback to the/,
);

// RE-POINTED, not deleted. This case was written against `membership.min_members`, the
// HAND-TYPED floor — which is now SUPERSEDED and refused outright, so the old form could
// only ever have tested the legacy-key fence. The PROPERTY it existed for is unchanged
// and is asserted here against the mechanism that replaced it: a live query returning far
// fewer members than the last successful build measured must refuse rather than render as
// progress. Observation 3, tolerance 0.25 -> derived floor 3; the query returns 1.
refusesLive(
  "violation/a-live-query-far-below-its-DERIVED-floor-REFUSES",
  liveFiles({
    ids: ["LIVE-01-BETA-ORIGINAL"],
    manifest: { ...LIVE_MANIFEST, floors: floorsNode(0.25) },
  }),
  /the live membership query returned 1, below the DERIVED floor of 3/,
);

refusesLive(
  "violation/a-live-kind-with-NO-membership-block-REFUSES",
  liveFiles({ doc: liveDoc({ membership: null }) }),
  /carries no 'membership' object/,
);

refusesLive(
  "violation/a-membership-command-that-is-a-BARE-NAME-REFUSES (PATH shim)",
  liveFiles({ doc: liveDoc({ membership: { command: ["gh", "issue", "list"] } }) }),
  /a BARE NAME resolved through PATH/,
);

refusesLive(
  "violation/an-UNCOMMITTED-membership-script-REFUSES",
  // command[0] is repo-relative, so it is held to the same committed-and-unmodified
  // standard as a declared source. Here it is not committed at all.
  liveFiles({ doc: liveDoc({ membership: { command: ["burndown/never-committed.mjs"] } }) }),
  /is not committed/,
);

refusesLive(
  "violation/an-items-entry-OUTSIDE-original_ids-REFUSES",
  liveFiles({
    doc: liveDoc({
      items: [...LIVE_ORIGINAL.map((id) => ({ id, page: "Beta", status: "Not started" })),
        { id: "LIVE-77-SMUGGLED-IN", page: "Beta", status: "Signed off" }],
    }),
  }),
  /which is NOT in original_ids/,
);

refusesLive(
  "violation/a-STILL-LIVE-original-with-no-adjudication-REFUSES",
  liveFiles({
    doc: liveDoc({ items: LIVE_ORIGINAL.slice(0, 2).map((id) => ({ id, page: "Beta", status: "Not started" })) }),
  }),
  /is in original_ids and is STILL LIVE, but items\[\] carries no/,
);

refusesLive(
  "violation/arrival_defaults-naming-an-undeclared-page-REFUSES",
  liveFiles({ doc: liveDoc({ arrival_defaults: { page: "Gamma", status: "Not started" } }) }),
  /arrival_defaults\.page 'Gamma' is not declared/,
);

refusesLive(
  "violation/an-INERT-membership-block-on-a-NON-live-kind-REFUSES",
  // The silently-dropped declaration: it reads as live to every reader of the manifest
  // and nothing runs. Same failure shape as a status-refresh carrying a `page`.
  liveFiles({
    manifest: {
      ...MANIFEST,
      sources: [
        { path: "burndown/register.json", kind: "register", precedence: 0 },
        { path: "burndown/live.json", kind: "growth", precedence: 0 },
      ],
    },
  }),
  /declares 'membership' but its kind is 'growth', which is not live/,
);


// THE SPLIT'S OWN SEMANTICS, pinned at the system level. `origin` is assigned by the
// FIRST source to introduce an id, and liveness does not change that — so an id the
// REGISTER declares stays `from the original register` even when a live source also
// carries it, and a live source's drainage cannot remove it. The register is a FROZEN
// ASK, not a live subject; only the live source's own membership drains.
{
  const REG_WITH_LIVE = {
    ..._clone(REGISTER),
    items: [..._clone(REGISTER).items, { id: "LIVE-01-BETA-ORIGINAL", page: "Beta", status: "In progress" }],
  };
  const files = (ids) => ({
    ...liveFiles({ ids }),
    "burndown/register.json": j(REG_WITH_LIVE),
  });

  check("live/an-id-the-REGISTER-declares-counts-as-FROM-ORIGINAL-REGISTER, not arrived-since", () => {
    const d = mkRepo(baseFiles(files(LIVE_ORIGINAL)));
    const r = run(d);
    if (r.code !== 0) return `exit ${r.code}: ${r.err.slice(0, 300)}`;
    const all = allPagesRow(r.out);
    // 6 register items + 2 live-only members. Open 5 = 3 from register (REG-04, REG-05,
    // LIVE-01) + 2 arrived since. If liveness had flattened the split, from-register
    // would read 2 and arrived-since 3.
    return all && all.board === 8 && all.openFromRegister === 3 && all.openArrivedSince === 2
      ? true
      : `ALL PAGES=${JSON.stringify(all)}, wanted total 8, from-register 3, arrived-since 2`;
  });

  check("live/a-REGISTER-declared-id-is-NOT-drained-by-the-live-source", () => {
    // LIVE-01 is absent from the live set entirely. It must SURVIVE, on the register's
    // own adjudication — a frozen ask is not drained by a registry it never came from.
    const d = mkRepo(baseFiles(files(LIVE_ORIGINAL.slice(1))));
    const r = run(d);
    if (r.code !== 0) return `exit ${r.code}: ${r.err.slice(0, 300)}`;
    const all = allPagesRow(r.out);
    return all && all.board === 8 && all.openFromRegister === 3 && all.openArrivedSince === 2
      ? true
      : `ALL PAGES=${JSON.stringify(all)}, wanted total 8 (LIVE-01 survives on the register), from-register 3`;
  });

  check("live/…and WITHOUT that register declaration the same query DRAINS it (7, not 8)", () => {
    // The falsifying pole for the case above. Identical live query, identical live
    // source; the ONLY difference is whether the register also declares LIVE-01. If a
    // register declaration did not protect it, both would read 7; if drainage did not
    // work, both would read 8. They read 8 and 7.
    const d = mkRepo(baseFiles(liveFiles({ ids: LIVE_ORIGINAL.slice(1) })));
    const r = run(d);
    if (r.code !== 0) return `exit ${r.code}: ${r.err.slice(0, 300)}`;
    const all = allPagesRow(r.out);
    return all && all.board === 7 && all.openFromRegister === 2 && all.openArrivedSince === 2
      ? true
      : `ALL PAGES=${JSON.stringify(all)}, wanted total 7, from-register 2, arrived-since 2`;
  });
}

refusesLive(
  "violation/a-query-emitting-the-SAME-id-twice-REFUSES",
  liveFiles({ ids: [...LIVE_ORIGINAL, LIVE_ORIGINAL[0]] }),
  /emitted id 'LIVE-01-BETA-ORIGINAL' twice/,
);

refusesLive(
  "violation/a-query-emitting-an-id-below-the-join-key-floor-REFUSES",
  liveFiles({ ids: [...LIVE_ORIGINAL, "X1"] }),
  /below the 8-character join-key floor/,
);

refusesLive(
  "violation/a-well-SHAPED-but-unreal-as_of-REFUSES (2026-02-30 normalises silently)",
  liveFiles({ doc: liveDoc({ membership: { as_of: "2026-02-30" } }) }),
  /membership\.as_of '2026-02-30', which is not a real/,
);

check("live/a-live-source-moves-the-sources_digest-when-the-SUBJECT-moves", () => {
  // The freshness gate's own defect: `sources_digest` is a digest of committed BLOBS, so
  // a static file passes it forever and "has not moved" reads identically to "CANNOT
  // move". Two repos with BYTE-IDENTICAL committed sources and different live sets must
  // digest differently, or --check's fast path is blind to the only thing that changed.
  const dig = (ids) => {
    const d = mkRepo(baseFiles(liveFiles({ ids })));
    const r = run(d);
    return (r.out.match(/^sources_digest: (\S+)$/m) || [])[1];
  };
  const a = dig(LIVE_ORIGINAL);
  const b = dig(LIVE_ORIGINAL.slice(0, 2));
  return a && b && a !== b ? true : `digests were ${a} and ${b} — the live set is not in the digest`;
});

// ── PROJECTED SOURCES — the item class for a PROJECTION of an external registry ──
//
// WHAT THESE POLES ARE ABOUT, and why the `live/` block above does not cover it.
// `live-growth` fixed MEMBERSHIP drift: it re-derives who is in the population. It
// could not fix STATUS drift, because its status is FROZEN by construction — an
// `original_ids` set plus a per-item adjudication someone took on `as_of`. For the
// migrated 241, the ~107 live GitHub issues and the ~97 deferral rows, that per-item
// adjudication is a judgement nobody performs at that volume; it was performed once,
// in bulk, by an agent, and frozen. THE FREEZE IS THE SYMPTOM.
//
// A `projected` source derives status from the SOURCE RECORD on every build, can never
// reach `Signed off`, and resolves through LINK-S instead of LINK-1/2/3. Each of those
// four properties gets a firing pole AND a compliant pole below: a class shown only to
// refuse has not been shown to count anything.

const PROJ_REGISTER = {
  _note: "fixture",
  _generated: "2026-08-21",
  _authority: "owner",
  items: [
    { id: "X1-alpha-item", page: "Alpha", status: "Signed off" },
    { id: "X2-alpha-item", page: "Alpha", status: "In progress" },
  ],
};

/** Rows are `[id, state, record_ref]`; the query prints them TAB-separated. */
const PROJ_ROWS = [
  ["PJ-01-first", "open", "rec://pj-01"],
  ["PJ-02-second", "open", "rec://pj-02"],
  ["PJ-03-third", "open", "rec://pj-03"],
];

function projQuery(rows) {
  return `process.stdout.write(${JSON.stringify(rows.map((r) => r.join("\t")).join("\n") + "\n")});\n`;
}

function projDoc(over = {}) {
  return {
    _note: "fixture",
    _generated: "2026-08-25",
    _authority: "agent",
    page: "Beta",
    // NO `min_members` — superseded by the manifest's derived `floors` node, and a
    // source still carrying it REFUSES. See the note above `floorsDoc`.
    membership: { command: [process.execPath, "burndown/query.mjs"] },
    status_derivation: { map: { open: "Not started", working: "In progress", waiting: "Blocked on you" } },
    record_ref: { kind: "external", pattern: "^rec://[a-z0-9-]+$" },
    items: [],
    ...over,
  };
}

/**
 * A repo carrying BOTH classes at once, which is the configuration the real board
 * will have: the owner's register items keep the full three-leg chain while the
 * projected population resolves through LINK-S. A fixture with only one class could
 * not tell "the register legs still fire" from "the legs were switched off wholesale".
 */
function mkProjRepo({
  rows = PROJ_ROWS,
  doc,
  sources,
  extra = {},
  floors,
  observed = 3,
  frac = 0.75,
  anchor = "`workspaces/ctx.md#X1-alpha-item`",
  tracker = { path: "L.md", kind: "forest-ledger", anchor_roots: ["workspaces/"] },
} = {}) {
  const files = {
    "REGISTER.md": "# Register\n",
    "burndown/register.json": j(PROJ_REGISTER),
    "burndown/proj.json": j(doc || projDoc()),
    "burndown/query.mjs": projQuery(rows),
    [FLOORS_REL]: j(floors || floorsDoc({ "burndown/proj.json": observed })),
    "burndown-manifest.json": j({
      ...MANIFEST,
      pages: ["Alpha", "Beta"],
      floors: floorsNode(frac),
      sources: sources || [
        { path: "burndown/register.json", kind: "register", precedence: 0 },
        { path: "burndown/proj.json", kind: "projected", precedence: 0 },
      ],
      ...(tracker ? { tracker } : {}),
    }),
    "L.md":
      "| ID | owner | item | value_anchor | status |\n| --- | --- | --- | --- | --- |\n" +
      `| X1-alpha-item | o | i | ${anchor} | s |\n` +
      "| X2-alpha-item | o | i | `workspaces/ctx.md#X2-alpha-item` | s |\n",
    "workspaces/ctx.md": "the ruling for X1-alpha-item and X2-alpha-item\n",
    ...extra,
  };
  return mkRepo(files);
}

// ── COMPLIANT POLE — a projected source builds, and its buckets follow the registry ──

check("projected/compliant-a-projected-source-BUILDS-and-reports-MEMBERSHIP", () => {
  const r = run(mkProjRepo(), ["--json"]);
  if (r.code !== 0) return `expected exit 0, got ${r.code}: ${r.err.slice(0, 300)}`;
  const all = JSON.parse(r.out).all;
  // 2 ADJUDICATED register items (1 Signed off, 1 In progress) + 3 PROJECTED members.
  // The adjudication buckets count the register items and NOTHING ELSE: the three
  // projected members are in `projected` and `board`, and in no bucket at all.
  return all.board === 5 &&
    all.adjudicated === 2 &&
    all.projected === 3 &&
    all.signedOff === 1 &&
    all.inProgress === 1 &&
    all.notStarted === 0 &&
    all.open === 1 &&
    all.openBoth === 4
    ? true
    : `all = ${JSON.stringify(all)}`;
});

check("projected/a-projected-item-is-ABSENT-from-the-adjudication-buckets, not zero", () => {
  // THE POLE THE DASH EXISTS FOR. `Beta` carries only projected members, so its five
  // status cells and its `Open` cell render "—" and emit NO TOKEN. A "0" there would
  // be a CLAIM that none of them are in progress; the truth is that a projection
  // occupies no position on the owner-acceptance journey those buckets measure.
  const r = run(mkProjRepo());
  if (r.code !== 0) return `exit ${r.code}: ${r.err.slice(0, 240)}`;
  const beta = r.out.match(/^\| Beta \|(.*)$/m);
  if (!beta) return "no Beta row in the block";
  const cells = beta[1].split("|").map((x) => x.trim()).filter((x) => x !== "");
  // Column order: board, adjudicated, [5 status buckets], Open, projected, openBoth,
  // fromRegister, arrivedSince. The SIX absent cells are the five status buckets plus
  // `Open` — every column whose denominator is `adjudicated`. Membership columns are
  // real counts and must NOT be dashed: "0 projected" is a fact, "0 In progress" over
  // an empty adjudicated population is a category error.
  const dashed = cells.slice(2, 8);
  const rest = [cells[0], cells[1], ...cells.slice(8)];
  if (dashed.length !== 6) return `expected 6 adjudicated-denominated cells, got ${dashed.length}`;
  if (!dashed.every((c) => c === "—")) return `expected 6 absent cells, got [${dashed.join(", ")}]`;
  if (rest.some((c) => c === "—")) return `a membership cell was absent: [${rest.join(", ")}]`;
  // ABSENT means NO TOKEN, and that is not cosmetic: a rendered token with no index
  // entry would fail --verify-quote against the very block that printed it.
  if (/—⟨/.test(r.out)) return "an absent cell still carried a token";
  return true;
});

check("projected/…and --quote SAYS absent rather than 'no such bucket'", () => {
  // A bucket that is correctly named but carries no count must not be reported as a
  // typo. Answering "no bucket matches" would send an operator hunting for an error in
  // a name that is right, and would read as though the page were not tracked at all.
  const r = run(mkProjRepo(), ["--quote", "Beta/In progress"]);
  if (r.code !== 2) return `exit ${r.code} — expected a refusal naming the absence`;
  return /is ABSENT on that row, not zero/.test(r.err) && /3 projected/.test(r.err)
    ? true
    : `wrong refusal: ${r.err.slice(0, 300)}`;
});

check("projected/…while the SAME bucket on an ADJUDICATED page still quotes normally", () => {
  // The discrimination pole for the two cases above. Without it they are consistent
  // with a --quote that refuses every status bucket.
  const r = run(mkProjRepo(), ["--quote", "Alpha/In progress"]);
  if (r.code !== 0) return `exit ${r.code}: ${r.err.slice(0, 240)}`;
  return /^Alpha — 1⟨[0-9a-f]{6}⟩ of 2 `In progress`/.test(r.out.trim())
    ? true
    : `unexpected quote: ${r.out.trim().slice(0, 200)}`;
});

check("projected/a-registry-STATE-change-moves-NO-adjudication-bucket", () => {
  // THE ONLY LEVER IS THE QUERY'S STATE FIELD. Every committed byte is identical
  // between these two repositories: same register, same projected source, same ids,
  // same refs. If status were adjudicated locally — the frozen defect — both would
  // report the SAME buckets.
  const a = run(mkProjRepo(), ["--json"]);
  const b = run(
    mkProjRepo({
      rows: [
        ["PJ-01-first", "working", "rec://pj-01"],
        ["PJ-02-second", "waiting", "rec://pj-02"],
        ["PJ-03-third", "open", "rec://pj-03"],
      ],
    }),
    ["--json"],
  );
  if (a.code !== 0 || b.code !== 0) return `exit ${a.code}/${b.code}`;
  const A = JSON.parse(a.out).all;
  const B = JSON.parse(b.out).all;
  // The two repositories differ ONLY in the query's state field. Every adjudication
  // bucket must be byte-for-byte identical across them, and so must the ADJUDICATED
  // denominator — otherwise a projection is still steering the owner's completion
  // figure, which is the defect separate denominators exist to end.
  const buckets = (x) => [x.signedOff, x.builtNotWalked, x.inProgress, x.notStarted, x.blockedOnYou].join(",");
  return buckets(A) === buckets(B) &&
    buckets(A) === "1,0,1,0,0" &&
    A.adjudicated === B.adjudicated &&
    A.projected === B.projected &&
    A.board === B.board
    ? true
    : `buckets [${buckets(A)}] vs [${buckets(B)}]; adjudicated ${A.adjudicated}/${B.adjudicated}`;
});

check("projected/a-record-that-CLOSED-DROPS-OUT-of-the-population", () => {
  // A closed GitHub issue is not a member. It does not become `Signed off`, and it is
  // not carried as a stale row: it is absent from the query's output, so it is absent
  // from every count. The static snapshot could not express this at all.
  const full = run(mkProjRepo(), ["--json"]);
  const closed = run(mkProjRepo({ rows: PROJ_ROWS.slice(0, 2) }), ["--json"]);
  if (full.code !== 0 || closed.code !== 0) return `exit ${full.code}/${closed.code}`;
  const F = JSON.parse(full.out).all;
  const C = JSON.parse(closed.out).all;
  // The board and the projected population shrink; the ADJUDICATED denominator and
  // every adjudication bucket are untouched, because a closed registry record was
  // never in them.
  return F.board === 5 &&
    C.board === 4 &&
    F.projected === 3 &&
    C.projected === 2 &&
    F.adjudicated === C.adjudicated &&
    F.signedOff === C.signedOff
    ? true
    : `board ${F.board}/${C.board}, projected ${F.projected}/${C.projected}, adjudicated ${F.adjudicated}/${C.adjudicated}`;
});

check("projected/…and a DRAIN below the DERIVED floor REFUSES rather than reading as progress", () => {
  // The other half of the same fact. Drop-out is BY DESIGN, which is exactly why a
  // silently smaller number and a query that half-failed at exit 0 are indistinguishable
  // without a floor. RE-POINTED from `min_members` — the hand-typed floor this case was
  // written against is superseded — onto the DERIVED floor that replaced it: observation
  // 3, tolerance 0.25 -> floor 3, and the query returns 1.
  const d = mkProjRepo({ rows: PROJ_ROWS.slice(0, 1), frac: 0.25 });
  const r = run(d, ["--json"]);
  if (r.code !== 2) return `exit ${r.code} — a drained projection passed the floor`;
  return /returned 1, below the DERIVED floor of 3/.test(r.err) ? true : `wrong refusal: ${r.err.slice(0, 240)}`;
});

// ── `Signed off` IS UNREACHABLE — every path that could assign it ─────────────

check("projected/violation-Signed-off-as-a-status_derivation-TARGET-refuses", () => {
  const r = run(mkProjRepo({ doc: projDoc({ status_derivation: { map: { open: "Signed off" } } }) }));
  if (r.code !== 2) return `exit ${r.code} — a projection was allowed to derive 'Signed off'`;
  return /'Signed off' is UNREACHABLE for a projected item/.test(r.err)
    ? true
    : `wrong refusal: ${r.err.slice(0, 240)}`;
});

check("projected/compliant-every-OTHER-vocabulary-value-IS-an-allowed-target", () => {
  // The discrimination pole. Without it the case above is consistent with a check that
  // refuses every map target, which would make the class unusable rather than safe.
  const r = run(
    mkProjRepo({
      rows: [["PJ-01-first", "b", "rec://pj-01"]],
      doc: projDoc({ status_derivation: { map: { b: "Built-not-walked" } } }),
    }),
    ["--json"],
  );
  if (r.code !== 0) return `exit ${r.code}: ${r.err.slice(0, 240)}`;
  const all = JSON.parse(r.out).all;
  // It BUILDS — the map accepts every vocabulary value except `Signed off` — and the
  // derived value still enters NO bucket: `Built-not-walked` counts the register's
  // items only. The map's remaining work is the `Signed off` refusal and the
  // unmapped-state guard, not a count.
  return all.builtNotWalked === 0 && all.projected === 1 && all.adjudicated === 2
    ? true
    : `builtNotWalked ${all.builtNotWalked}, projected ${all.projected}, adjudicated ${all.adjudicated}`;
});

check("projected/violation-a-status-refresh-aiming-Signed-off-at-a-PROJECTED-id-refuses", () => {
  // The second path to the same assignment. `validateProjectedStatus` closes the
  // derivation; this closes the refresh. Without both, two lines in a refresh source
  // mark the owner's work accepted on their behalf.
  const r = run(
    mkProjRepo({
      sources: [
        { path: "burndown/register.json", kind: "register", precedence: 0 },
        { path: "burndown/proj.json", kind: "projected", precedence: 0 },
        { path: "burndown/refresh.json", kind: "status-refresh", precedence: 0 },
      ],
      extra: {
        "burndown/refresh.json": j({
          _note: "fixture",
          _generated: "2026-08-26",
          _authority: "owner",
          items: [{ id: "PJ-01-first", status: "Signed off" }],
        }),
      },
    }),
  );
  if (r.code !== 2) return `exit ${r.code} — a refresh signed off a projected item`;
  return /is in exactly ONE class/.test(r.err) ? true : `wrong refusal: ${r.err.slice(0, 240)}`;
});

check("projected/compliant-…the SAME refresh aimed at a REGISTER id still WORKS", () => {
  // The class fence must not have switched refreshes off. Same source file, same
  // status, different target id — and this one must land.
  const r = run(
    mkProjRepo({
      sources: [
        { path: "burndown/register.json", kind: "register", precedence: 0 },
        { path: "burndown/proj.json", kind: "projected", precedence: 0 },
        { path: "burndown/refresh.json", kind: "status-refresh", precedence: 0 },
      ],
      extra: {
        "burndown/refresh.json": j({
          _note: "fixture",
          _generated: "2026-08-26",
          _authority: "owner",
          items: [{ id: "X2-alpha-item", status: "Signed off" }],
        }),
      },
    }),
    ["--json"],
  );
  if (r.code !== 0) return `exit ${r.code}: ${r.err.slice(0, 240)}`;
  return JSON.parse(r.out).all.signedOff === 2 ? true : `signedOff was not 2: ${r.out.slice(0, 200)}`;
});

check("projected/violation-a-GROWTH-source-declaring-a-projected-id-refuses", () => {
  // The third path: re-declare the id in a source whose statuses ARE local. Refused as
  // a COLLISION rather than by precedence, so no `_generated` date can decide it.
  const r = run(
    mkProjRepo({
      sources: [
        { path: "burndown/register.json", kind: "register", precedence: 0 },
        { path: "burndown/proj.json", kind: "projected", precedence: 0 },
        { path: "burndown/growth.json", kind: "growth", precedence: 0 },
      ],
      extra: {
        "burndown/growth.json": j({
          _note: "fixture",
          _generated: "2026-08-27",
          _authority: "owner",
          items: [{ id: "PJ-01-first", page: "Beta", status: "Signed off" }],
        }),
      },
    }),
  );
  if (r.code !== 2) return `exit ${r.code} — a growth source signed off a projected item`;
  return /is in exactly ONE class/.test(r.err) ? true : `wrong refusal: ${r.err.slice(0, 240)}`;
});

// ── LINK-S — REPLACED, never waived ──────────────────────────────────────────

check("projected/violation-a-member-that-resolves-to-NO-source-record-refuses", () => {
  // The ref does not match the source's DECLARED pattern, so LINK-S is unresolved.
  // This is the leg that makes the class non-tautological: "the id is in the query's
  // output" is true by construction for every member and could never fail.
  const r = run(mkProjRepo({ rows: [["PJ-01-first", "open", "not-a-record-ref"], ...PROJ_ROWS.slice(1)] }));
  if (r.code !== 2) return `exit ${r.code} — an unlinked projected member was counted`;
  return /does not match the declared record_ref\.pattern/.test(r.err) ? true : `wrong refusal: ${r.err.slice(0, 240)}`;
});

check("projected/violation-a-member-emitting-NO-record_ref-field-refuses", () => {
  const r = run(mkProjRepo({ rows: [["PJ-01-first", "open"]] }));
  if (r.code !== 2) return `exit ${r.code} — a member with no reference at all was counted`;
  return /expected exactly 3 \(id, state, record_ref\)/.test(r.err) ? true : `wrong refusal: ${r.err.slice(0, 240)}`;
});

check("projected/violation-TWO-members-resolving-to-the-SAME-record-refuses", () => {
  const r = run(mkProjRepo({ rows: [["PJ-01-first", "open", "rec://same"], ["PJ-02-second", "open", "rec://same"]] }));
  if (r.code !== 2) return `exit ${r.code} — one registry row was counted twice`;
  return /both resolve to record_ref/.test(r.err) ? true : `wrong refusal: ${r.err.slice(0, 240)}`;
});

check("projected/compliant-a-repo-path-ref-is-DEREFERENCED-and-builds", () => {
  // For an IN-REPO registry LINK-S is a full resolution, offline: tracked at HEAD AND
  // carrying the id verbatim. Strictly stronger than a hand-written value_anchor,
  // which is typed once and then rots while still passing.
  const r = run(
    mkProjRepo({
      rows: [["PJ-01-first", "open", "registry/deferrals.json"]],
      doc: projDoc({ record_ref: { kind: "repo-path", pattern: "^registry/[a-z.]+$" } }),
      extra: { "registry/deferrals.json": '{"PJ-01-first": {"expires": "2026-12-01"}}\n' },
    }),
    ["--json"],
  );
  if (r.code !== 0) return `exit ${r.code}: ${r.err.slice(0, 300)}`;
  const all = JSON.parse(r.out).all;
  return all.board === 3 && all.adjudicated === 2 && all.projected === 1
    ? true
    : `board ${all.board}, adjudicated ${all.adjudicated}, projected ${all.projected}`;
});

check("projected/violation-a-repo-path-ref-NOT-carrying-the-id-refuses", () => {
  // Resolves to a FILE but not to a RECORD. That is exactly the stale-pointer failure
  // a hand-written anchor has, and the pole proves the deref is not decorative.
  const r = run(
    mkProjRepo({
      rows: [["PJ-01-first", "open", "registry/deferrals.json"]],
      doc: projDoc({ record_ref: { kind: "repo-path", pattern: "^registry/[a-z.]+$" } }),
      extra: { "registry/deferrals.json": '{"SOMETHING-else": {}}\n' },
    }),
  );
  if (r.code !== 2) return `exit ${r.code} — a reference to a file that never names the id passed`;
  return /does not carry\s+that id verbatim/.test(r.err) ? true : `wrong refusal: ${r.err.slice(0, 240)}`;
});

check("projected/violation-a-repo-path-ref-that-is-a-SYMLINK-refuses", () => {
  // The FILESYSTEM half of the same gate. `assertRepoRelative` is a STRING check: it
  // closes `..` and an absolute path and sees nothing at all about a symlink. git
  // stores the LINK TEXT as the blob while the reader FOLLOWS it, so a tracked link
  // pointing out of the tree lets an out-of-tree file satisfy LINK-S and gets its bytes
  // read. Measured as a real pole, not reasoned about: the link resolves to a file that
  // DOES carry the id, so without the mode check this case BUILDS.
  const d = mkProjRepo({
    rows: [["PJ-01-first", "open", "registry/link.json"]],
    doc: projDoc({ record_ref: { kind: "repo-path", pattern: "^registry/[a-z.]+$" } }),
    extra: { "registry/real.json": '{"PJ-01-first": {}}\n' },
  });
  fs.symlinkSync("real.json", path.join(d, "registry/link.json"));
  execFileSync("git", ["add", "-A"], { cwd: d, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "link"], { cwd: d, stdio: "ignore" });
  const r = run(d, ["--json"]);
  if (r.code !== 2) return `exit ${r.code} — a symlinked record reference was dereferenced`;
  return /which is a SYMLINK/.test(r.err) ? true : `wrong refusal: ${r.err.slice(0, 240)}`;
});

check("projected/violation-a-repo-path-ref-to-an-UNTRACKED-file-refuses", () => {
  const r = run(
    mkProjRepo({
      rows: [["PJ-01-first", "open", "registry/missing.json"]],
      doc: projDoc({ record_ref: { kind: "repo-path", pattern: "^registry/[a-z.]+$" } }),
      extra: { "registry/deferrals.json": '{"PJ-01-first": {}}\n' },
    }),
  );
  if (r.code !== 2) return `exit ${r.code} — a reference to an untracked file passed`;
  return /is NOT TRACKED at HEAD/.test(r.err) ? true : `wrong refusal: ${r.err.slice(0, 240)}`;
});

// ── LINK-S over a SINGLE-FILE registry — the JSON-pointer half ───────────────
//
// WHY THIS EXISTS AT ALL. Ref uniqueness is checked over the WHOLE ref, before the
// kind branch. So a registry that keeps MANY records in ONE FILE — which is exactly
// the case the class documentation names, "a deferral registry" — could not be
// expressed: every row would carry the same path and the second one would refuse as a
// double-count. The only shape available without a pointer was to declare such a
// source `external`, which is choosing the WEAKER check (shape and uniqueness, no
// dereference) for the one case where the STRONGER one runs offline. The pointer is
// RESOLVED against the parsed document, so a record that was deleted from the registry
// cannot leave a stale-but-passing reference behind.

const PTR_REGISTRY = JSON.stringify(
  {
    deferrals: { "alpha.md#one": { risk: "process" }, "beta.md#two": { risk: "trust" } },
    rollout: { note: "the root deferral" },
    nulled: null,
  },
  null,
  2,
) + "\n";

const PTR_DOC = () =>
  projDoc({
    record_ref: { kind: "repo-path", pattern: "^registry/reg\\.json#/.+$" },
  });

check("projected/compliant-a-repo-path-ref-with-a-JSON-POINTER-resolves-and-builds", () => {
  const r = run(
    mkProjRepo({
      rows: [["PJ-01-first", "open", "registry/reg.json#/deferrals/alpha.md#one"]],
      doc: PTR_DOC(),
      extra: { "registry/reg.json": PTR_REGISTRY },
    }),
    ["--json"],
  );
  if (r.code !== 0) return `exit ${r.code}: ${r.err.slice(0, 300)}`;
  const all = JSON.parse(r.out).all;
  return all.board === 3 && all.projected === 1 ? true : `board ${all.board}, projected ${all.projected}`;
});

check("projected/compliant-TWO-members-in-ONE-registry-file-via-DIFFERENT-pointers-build", () => {
  // THE LOAD-BEARING POLE. Without the pointer these two rows carry the same ref and
  // the build refuses as a double-count, so this case is the one that fails if the
  // extension is removed — and it is the whole reason a single-file registry can be a
  // projected source at all.
  const r = run(
    mkProjRepo({
      rows: [
        ["PJ-01-first", "open", "registry/reg.json#/deferrals/alpha.md#one"],
        ["PJ-02-second", "open", "registry/reg.json#/deferrals/beta.md#two"],
      ],
      doc: PTR_DOC(),
      extra: { "registry/reg.json": PTR_REGISTRY },
    }),
    ["--json"],
  );
  if (r.code !== 0) return `exit ${r.code}: ${r.err.slice(0, 300)}`;
  const all = JSON.parse(r.out).all;
  return all.projected === 2 ? true : `projected was ${all.projected}, expected 2`;
});

check("projected/violation-a-JSON-POINTER-addressing-NO-value-refuses", () => {
  // The pole that makes the deref non-decorative: the FILE is tracked and readable and
  // the ref matches the pattern; only the RECORD is gone. That is precisely the
  // stale-pointer failure a hand-written value_anchor has and never reports.
  const r = run(
    mkProjRepo({
      rows: [["PJ-01-first", "open", "registry/reg.json#/deferrals/gamma.md#three"]],
      doc: PTR_DOC(),
      extra: { "registry/reg.json": PTR_REGISTRY },
    }),
  );
  if (r.code !== 2) return `exit ${r.code} — a pointer addressing nothing was counted`;
  return /addresses NO value in that document/.test(r.err) ? true : `wrong refusal: ${r.err.slice(0, 240)}`;
});

check("projected/violation-a-JSON-POINTER-into-a-file-that-is-NOT-JSON-refuses", () => {
  const r = run(
    mkProjRepo({
      rows: [["PJ-01-first", "open", "registry/reg.json#/deferrals/alpha.md#one"]],
      doc: PTR_DOC(),
      extra: { "registry/reg.json": "PJ-01-first is in here as prose, not as a record\n" },
    }),
  );
  if (r.code !== 2) return `exit ${r.code} — a pointer into a non-JSON file passed`;
  return /does not parse as JSON/.test(r.err) ? true : `wrong refusal: ${r.err.slice(0, 240)}`;
});

check("projected/violation-an-EMPTY-fragment-after-the-hash-refuses", () => {
  // An empty pointer addresses the WHOLE document, which every member of a single-file
  // registry satisfies identically — LINK-S would pass for all of them and discriminate
  // none. Refused rather than resolved.
  const r = run(
    mkProjRepo({
      rows: [["PJ-01-first", "open", "registry/reg.json#"]],
      doc: projDoc({ record_ref: { kind: "repo-path", pattern: "^registry/reg\\.json#$" } }),
      extra: { "registry/reg.json": PTR_REGISTRY },
    }),
  );
  if (r.code !== 2) return `exit ${r.code} — an empty fragment resolved to the whole document`;
  return /introduces an EMPTY pointer/.test(r.err) ? true : `wrong refusal: ${r.err.slice(0, 240)}`;
});

check("projected/violation-a-pointer-resolving-through-the-PROTOTYPE-chain-refuses", () => {
  // `in` and a bare index BOTH resolve `/__proto__/constructor` on every plain object,
  // so a ref naming a record nobody wrote would resolve against the LANGUAGE rather
  // than against the registry. Measured as a real pole: with `hasOwnProperty` removed
  // this case BUILDS.
  const r = run(
    mkProjRepo({
      rows: [["PJ-01-first", "open", "registry/reg.json#/__proto__/constructor"]],
      doc: PTR_DOC(),
      extra: { "registry/reg.json": PTR_REGISTRY },
    }),
  );
  if (r.code !== 2) return `exit ${r.code} — a prototype-chain pointer satisfied LINK-S`;
  return /addresses NO value in that document/.test(r.err) ? true : `wrong refusal: ${r.err.slice(0, 240)}`;
});

check("projected/compliant-a-pointer-addressing-a-NULL-value-still-RESOLVES", () => {
  // Why the miss is a SENTINEL and not `undefined`. A JSON value may legitimately be
  // `null`; reading a miss as `null` — or a `null` as a miss — collapses "the record
  // exists and is empty" into "there is no record", which are opposite verdicts.
  const r = run(
    mkProjRepo({
      rows: [["PJ-01-first", "open", "registry/reg.json#/nulled"]],
      doc: PTR_DOC(),
      extra: { "registry/reg.json": PTR_REGISTRY },
    }),
    ["--json"],
  );
  if (r.code !== 0) return `exit ${r.code}: ${r.err.slice(0, 300)}`;
  return JSON.parse(r.out).all.projected === 1 ? true : `projected was not 1`;
});

// ── THE QUERY BINARY — a committed SHEBANG script is runnable as command[0] ──
//
// `resolveMembershipBinary` validates `command[0]` ONLY. So the two ways to run a node
// query differ in what is held to `assertCommittedAndUnmodified`: naming an absolute
// interpreter puts the SCRIPT in `command[1]`, where nothing checks it, while a shebang
// script IS `command[0]` and is checked on every build. The shebang form only works if
// the child's PATH can resolve an interpreter, and `gitNetEnv()` pins PATH to
// `/usr/bin:/bin` — where no package manager installs one. `MEMBERSHIP_PATH_DIRS` is
// the declared constant that closes that.

check("projected/compliant-a-committed-SHEBANG-script-runs-as-command-0", () => {
  const rows = [["PJ-01-first", "open", "rec://pj-01"]];
  const body = rows.map((r) => r.join("\t")).join("\n") + "\n";
  const d = mkProjRepo({
    doc: projDoc({ membership: { command: ["burndown/q.sh.mjs"] } }),
    extra: {
      // The script ASSERTS the PATH it was handed rather than merely running under it,
      // so this pole fails for a NAMED reason and not only because a shebang could not
      // resolve — an interpreter that happened to sit in /usr/bin would otherwise make
      // the case vacuous on some host.
      "burndown/q.sh.mjs":
        "#!/usr/bin/env node\n" +
        'const want = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/home/linuxbrew/.linuxbrew/bin", "/snap/bin"];\n' +
        'const got = String(process.env.PATH || "").split(":");\n' +
        "if (want.some((w, i) => got[i] !== w)) {\n" +
        '  process.stderr.write("PATH was " + process.env.PATH + ", expected the declared list\\n");\n' +
        "  process.exit(1);\n" +
        "}\n" +
        `process.stdout.write(${JSON.stringify(body)});\n`,
    },
  });
  fs.chmodSync(path.join(d, "burndown/q.sh.mjs"), 0o755);
  execFileSync("git", ["add", "-A"], { cwd: d, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "exec bit"], { cwd: d, stdio: "ignore" });
  const r = run(d, ["--json"]);
  if (r.code !== 0) return `exit ${r.code}: ${r.err.slice(0, 300)}`;
  return JSON.parse(r.out).all.projected === 1 ? true : `projected was not 1`;
});

// ── THE REGISTER'S OWN CONTRACT IS UNCHANGED ─────────────────────────────────

check("projected/a-REGISTER-item-STILL-enforces-all-THREE-LINK-legs", () => {
  // The load-bearing pole of this whole change. LINK-1/2/3 are replaced FOR THE
  // PROJECTED CLASS ONLY; if introducing the class had switched them off wholesale, a
  // register item with a broken anchor would now build. It must still refuse — with a
  // LINK-2 finding, not a bare exit 2, because exit 2 is also what a bad status and an
  // uncommitted source produce.
  const r = run(mkProjRepo({ anchor: "`workspaces/nonexistent.md#X1-alpha-item`" }), ["--check-links"]);
  if (r.code !== 2) return `exit ${r.code} — a register item with an unresolvable anchor built`;
  return /LINK-2\s+X1-alpha-item/.test(r.err) ? true : `wrong finding: ${r.err.slice(0, 300)}`;
});

check("projected/…and a MISSING tracker row for a REGISTER item still fires LINK-1", () => {
  const r = run(
    mkProjRepo({
      extra: {
        "L.md":
          "| ID | owner | item | value_anchor | status |\n| --- | --- | --- | --- | --- |\n" +
          "| X1-alpha-item | o | i | `workspaces/ctx.md#X1-alpha-item` | s |\n",
      },
    }),
    ["--check-links"],
  );
  if (r.code !== 2) return `exit ${r.code} — a register item with no tracker row built`;
  return /LINK-1\s+X2-alpha-item/.test(r.err) ? true : `wrong finding: ${r.err.slice(0, 300)}`;
});

check("projected/compliant-check-links-REPORTS-both-populations-and-STATES-the-LINK-S-bound", () => {
  // "no findings" and "nothing was checked" must not render alike — and with two
  // classes on one board there are now two populations that can be confused. The
  // adjudicated denominator must exclude the projected items (or the green over-claims
  // what LINK-1/2/3 examined), and the external-ref bound must be printed rather than
  // implied by a green.
  const r = run(mkProjRepo(), ["--check-links"]);
  if (r.code !== 0) return `exit ${r.code}: ${r.err.slice(0, 300)}`;
  const okAdjudicated = /chain INTACT — 2 ADJUDICATED item\(s\)/.test(r.out);
  const okProjected = /LINK-S: 3 projected item\(s\)/.test(r.out);
  const okBound = /were NOT FETCHED/.test(r.out) && /ADDRESSABILITY, never\s+existence/.test(r.out);
  return okAdjudicated && okProjected && okBound
    ? true
    : `adjudicated=${okAdjudicated} projected=${okProjected} bound=${okBound} :: ${r.out.slice(0, 500)}`;
});

check("projected/a-board-with-NO-projected-source-says-LINK-S-checked-NOTHING", () => {
  // ABSENT is not CLEAN. Zero projected items and "there are projected items nobody
  // reported on" would otherwise render identically — the failure class this whole
  // surface exists around.
  const r = run(
    mkProjRepo({ sources: [{ path: "burndown/register.json", kind: "register", precedence: 0 }] }),
    ["--check-links"],
  );
  if (r.code !== 0) return `exit ${r.code}: ${r.err.slice(0, 300)}`;
  return /LINK-S: 0 projected item\(s\)/.test(r.out) && /ABSENT result, not a clean one/.test(r.out)
    ? true
    : `unexpected stdout: ${r.out.slice(0, 400)}`;
});

// ── MUST-3's COLUMN ──────────────────────────────────────────────────────────

check("projected/the-GROWTH-SPLIT-survives — projected items land on 'arrived since'", () => {
  const r = run(mkProjRepo(), ["--json"]);
  if (r.code !== 0) return `exit ${r.code}: ${r.err.slice(0, 240)}`;
  const all = JSON.parse(r.out).all;
  // The split partitions `Open: both populations`, because arrival is a fact about
  // WHEN an item reached the board and is orthogonal to which class it is in.
  return all.openFromRegister + all.openArrivedSince === all.openBoth &&
    all.openFromRegister === 1 &&
    all.openArrivedSince === 3 &&
    all.openBoth === all.open + all.projected
    ? true
    : `split ${all.openFromRegister}+${all.openArrivedSince} against openBoth ${all.openBoth}`;
});

check("projected/…and the split DISCRIMINATES — the same board without the projection", () => {
  // The falsifying result, stated: a generator that had flattened the split would
  // report the same `arrived since` for both, and the column would carry no
  // information. It reads 3 then 0.
  const withProj = JSON.parse(run(mkProjRepo(), ["--json"]).out).all;
  const without = JSON.parse(
    run(mkProjRepo({ sources: [{ path: "burndown/register.json", kind: "register", precedence: 0 }] }), ["--json"]).out,
  ).all;
  return withProj.openArrivedSince === 3 && without.openArrivedSince === 0 && without.openFromRegister === 1
    ? true
    : `arrived-since ${withProj.openArrivedSince} then ${without.openArrivedSince}`;
});

// ── SEPARATE DENOMINATORS — the defect one total created ─────────────────────
//
// A single `total` over two populations broke TWO figures at once, and the second was
// worse than the staleness the projected class was built to fix. `Signed off` was
// compared against a total containing 221 items STRUCTURALLY BARRED from ever being
// `Signed off` — so completion became unreachable by construction, and the register
// could never again be reported complete no matter what the owner accepted.

/** An `Alpha` register whose every item is Signed off, beside a live projection. */
const DONE_REGISTER = {
  _note: "fixture",
  _generated: "2026-08-21",
  _authority: "owner",
  items: [
    { id: "X1-alpha-item", page: "Alpha", status: "Signed off" },
    { id: "X2-alpha-item", page: "Alpha", status: "Signed off" },
  ],
};

check("projected/COMPLETION-is-REACHABLE while projected items sit on the board", () => {
  // THE LOAD-BEARING POLE. Every adjudicated item is accepted; three projected members
  // are present. The block must say COMPLETE. Under one denominator this read "2 of 5"
  // and could never complete — that is the defect being repaired, and this case is the
  // only thing that can tell the repair from its absence.
  const d = mkProjRepo({ extra: { "burndown/register.json": j(DONE_REGISTER) } });
  const r = run(d);
  if (r.code !== 0) return `exit ${r.code}: ${r.err.slice(0, 300)}`;
  const complete = /Every page carrying adjudicated work is complete: Alpha 2 of 2\./.test(r.out);
  // COMPLETE AND STILL COUNTING THEM. Completion must not have been bought by dropping
  // the projection from the board — that would be a different defect with the same
  // reassuring output.
  const all = allPagesRow(r.out);
  const stillCounted = all && all.board === 5 && all.projected === 3 && all.adjudicated === 2;
  return complete && stillCounted
    ? true
    : `complete=${complete} row=${JSON.stringify(all)} :: ${(r.out.match(/A page is complete.*/) || [""])[0].slice(0, 260)}`;
});

check("projected/…and the completion sentence is measured against ADJUDICATED, not board", () => {
  // The discrimination pole. Same repo, one register item NOT accepted: the sentence
  // must flip to incomplete AND must quote the adjudicated denominator (2), never the
  // board (5). A sentence reading "1 of 5" is the old defect wearing new column names.
  const d = mkProjRepo();
  const r = run(d);
  if (r.code !== 0) return `exit ${r.code}: ${r.err.slice(0, 300)}`;
  const line = (r.out.match(/A page is complete only when.*/) || [""])[0];
  return /Alpha is 1 of 2/.test(line) && !/of 5/.test(line)
    ? true
    : `completion sentence was: ${line.slice(0, 300)}`;
});

check("projected/a-page-with-NO-adjudicated-items-is-NOT-reported-complete", () => {
  // `0 of 0` renders as complete under any naive test, which would report an entirely
  // untouched projection as finished work — over-reporting, the costliest direction
  // and the one MUST-4's own rationale singles out. It must be named as NOT DEFINED.
  const r = run(mkProjRepo());
  if (r.code !== 0) return `exit ${r.code}: ${r.err.slice(0, 240)}`;
  const line = (r.out.match(/A page is complete only when.*/) || [""])[0];
  return /Beta carries no adjudicated items \(3 projected\), so completion is not defined there/.test(line) &&
    /ABSENT result, not a complete one/.test(line)
    ? true
    : `completion sentence was: ${line.slice(0, 320)}`;
});

// ── THE MIXED PAGE — the configuration the whole change is about ─────────────
//
// ADDED BECAUSE A MUTATION CAME BACK EMPTY, and an empty red-set is unresolved, never
// a vacuity verdict. Swapping the completion test from `adjudicated` to `board`
// changed NOTHING across the suite: every page carrying adjudicated items carried no
// projected ones, so the two denominators coincided everywhere it was measured. The
// mutation was REACHED and INERT ON THE DATA — which is a hole in the fixtures, not a
// property of the code. A page holding BOTH classes is the only shape that can tell
// the two denominators apart, and it is also the realistic one.

/** DONE_REGISTER on Alpha, and the projection ALSO on Alpha. */
function mkMixedPageRepo(over = {}) {
  return mkProjRepo({
    doc: projDoc({ page: "Alpha" }),
    extra: { "burndown/register.json": j(DONE_REGISTER) },
    ...over,
  });
}

check("projected/a-MIXED-page is COMPLETE on its adjudicated work while projected items sit on it", () => {
  // Alpha: 2 adjudicated, BOTH Signed off, PLUS 3 projected members on the same page.
  //   against `adjudicated` (2) -> COMPLETE
  //   against `board`        (5) -> not complete
  // The two answers differ, which is exactly what no other fixture could show.
  const r = run(mkMixedPageRepo());
  if (r.code !== 0) return `exit ${r.code}: ${r.err.slice(0, 300)}`;
  const line = (r.out.match(/A page is complete only when.*/) || [""])[0];
  const all = allPagesRow(r.out);
  if (!all || all.adjudicated !== 2 || all.projected !== 3 || all.board !== 5) {
    return `row was ${JSON.stringify(all)}, wanted adjudicated 2 / projected 3 / board 5`;
  }
  return /Alpha 2 of 2/.test(line) && /complete/.test(line) && !/2 of 5/.test(line)
    ? true
    : `completion sentence was: ${line.slice(0, 300)}`;
});

check("projected/…and the MIXED page's status buckets count ONLY its adjudicated items", () => {
  // The buckets are NOT absent here — the page has adjudicated work — and they must
  // still exclude the three projected members sharing the page. This is the case a
  // projected-only page cannot make: absence is easy, exclusion is the hard part.
  const r = run(mkMixedPageRepo(), ["--json"]);
  if (r.code !== 0) return `exit ${r.code}: ${r.err.slice(0, 240)}`;
  const alpha = JSON.parse(r.out).pages.find((x) => x.name === "Alpha");
  const parts = alpha.signedOff + alpha.builtNotWalked + alpha.inProgress + alpha.notStarted + alpha.blockedOnYou;
  return alpha.board === 5 && alpha.adjudicated === 2 && alpha.projected === 3 && parts === 2 && alpha.signedOff === 2
    ? true
    : `Alpha = ${JSON.stringify(alpha)} (buckets summed to ${parts})`;
});

check("projected/…and the MIXED page renders its buckets rather than dashing them", () => {
  // The mirror of the absent-cell pole. A page with adjudicated work must NOT dash its
  // status cells — a rule that dashed whenever ANY projected item was present would
  // pass the absence case and silently erase the owner's own figures.
  const r = run(mkMixedPageRepo());
  const alpha = r.out.match(/^\| Alpha \|(.*)$/m);
  if (!alpha) return "no Alpha row";
  const cells = alpha[1].split("|").map((x) => x.trim()).filter((x) => x !== "");
  return cells.every((c) => c !== "—") && /^2⟨/.test(cells[2])
    ? true
    : `Alpha cells: [${cells.join(", ")}]`;
});

check("projected/the-GROWTH-SPLIT-quote names 'Open: both populations' as its denominator", () => {
  // ALSO ADDED FOR AN EMPTY RED-SET. Re-pointing the split columns' denominator from
  // `openBoth` to the adjudicated `Open` changed no fixture: the denominator is not in
  // any --json value and not in assertInvariants, so it was observable ONLY through a
  // quote. MUST-2 says every count names its denominator; nothing was checking which
  // one the split named.
  const d = mkProjRepo();
  const r = run(d, ["--quote", "ALL PAGES/Open: from original register"]);
  if (r.code !== 0) return `exit ${r.code}: ${r.err.slice(0, 240)}`;
  // 1 register item open + 3 projected = 'Open: both populations' 4; adjudicated Open is 1.
  return /^ALL PAGES — 1⟨[0-9a-f]{6}⟩ of 4 `Open: from original register`/.test(r.out.trim())
    ? true
    : `quote was: ${r.out.trim().slice(0, 200)}`;
});

check("projected/…and BOTH open figures carry the split, not just the adjudicated one", () => {
  // MUST-3 blocks a bare OPEN count and there are now two of them. The cheapest path
  // must not hand over a ready-to-paste sentence that breaches the rule the tool
  // enforces — and neither hook arm would catch it, because the token is VALID.
  const d = mkProjRepo();
  const a = run(d, ["--quote", "ALL PAGES/Open"]);
  const b = run(d, ["--quote", "ALL PAGES/Open: both populations"]);
  if (a.code !== 0 || b.code !== 0) return `exit ${a.code}/${b.code}`;
  const carries = (t) => /Open: from original register/.test(t) && /Open: arrived since/.test(t);
  return carries(a.out) && carries(b.out) ? true : `adjudicated-Open split=${carries(a.out)}, both-populations split=${carries(b.out)}`;
});

check("projected/the-DENOMINATOR-is-bound-into-the-token", () => {
  // With two populations in one table this stops being a nicety: if the token did not
  // bind the denominator, a figure computed against `projected` could validate a
  // sentence asserting it against `adjudicated` — the COMPLETION denominator. So a
  // projected count could certify a completion claim.
  //
  // MEASURED end to end through the CLI, not reasoned about: take a real cell, re-render
  // its sentence with a denominator drawn from a DIFFERENT column of the same row, and
  // feed both to --verify-quote.
  const d = mkProjRepo();
  const blk = run(d);
  if (blk.code !== 0) return `exit ${blk.code}: ${blk.err.slice(0, 240)}`;
  const all = blk.out.match(/^\| \*\*ALL PAGES\*\* \|(.*)$/m);
  if (!all) return "no ALL PAGES row";
  const cells = all[1].split("|").map((x) => x.trim().replace(/\*\*/g, "")).filter((x) => x !== "");
  const board = cells[0]; // "5⟨tok⟩"
  const adjudicated = cells[1]; // "2⟨tok⟩"
  const signedOff = cells[2]; // "1⟨tok⟩"
  const nOf = (c) => c.replace(/⟨[^⟩]*⟩/, "");
  const right = `ALL PAGES — ${signedOff} of ${nOf(adjudicated)} \`Signed off\``;
  const wrong = `ALL PAGES — ${signedOff} of ${nOf(board)} \`Signed off\``;
  // Routed through the `verifyText` choke point rather than re-implemented. This local
  // copy WAS the duplication, and the duplication was the defect: when `--verify-quote`
  // grew a generated-block precondition, the one-line fix at the choke point reached 17
  // cases and silently missed this one, because nothing here shared that seam. Deleting
  // the copy is the root fix; patching it in place would have left the next seam change
  // to miss it again. The trailing newline is preserved — it was in the original write.
  const verify = (text) => verifyText(d, text + "\n");
  const a = verify(right);
  const b = verify(wrong);
  // A verifier that rejected BOTH would prove nothing, so the correct sentence is
  // asserted to VALIDATE in the same breath.
  return a.code === 0 && b.code === 1
    ? true
    : `correct-denominator exit ${a.code} (want 0), swapped-denominator exit ${b.code} (want 1)`;
});

// ── NO SILENT ANYTHING — the declaration fences ──────────────────────────────

check("projected/violation-an-UNMAPPED-state-refuses — there is no default", () => {
  // A default is what let the bulk adjudication become invisible: every unrecognised
  // registry state would land in whichever bucket the code happened to pick.
  const r = run(mkProjRepo({ rows: [["PJ-01-first", "merged", "rec://pj-01"]] }));
  if (r.code !== 2) return `exit ${r.code} — an unmapped state was given a status anyway`;
  return /does not translate/.test(r.err) ? true : `wrong refusal: ${r.err.slice(0, 240)}`;
});

check("projected/violation-a-LOCAL-items[]-status-on-a-projected-source-refuses", () => {
  const r = run(mkProjRepo({ doc: projDoc({ items: [{ id: "PJ-01-first", page: "Beta", status: "In progress" }] }) }));
  if (r.code !== 2) return `exit ${r.code} — a projected source carried a local adjudication`;
  return /is a LOCAL ADJUDICATION/.test(r.err) ? true : `wrong refusal: ${r.err.slice(0, 240)}`;
});

check("projected/violation-membership.as_of-on-a-projected-source-refuses-rather-than-being-INERT", () => {
  // A bound that bounds nothing reads as freshness discipline while providing none —
  // the same disposition the generator already takes on a `membership` block attached
  // to a non-live kind.
  const r = run(
    mkProjRepo({
      doc: projDoc({
        membership: { command: [process.execPath, "burndown/query.mjs"], as_of: isoDaysAgo(2) },
      }),
    }),
  );
  if (r.code !== 2) return `exit ${r.code} — an inert staleness bound was accepted`;
  return /may not carry/.test(r.err) ? true : `wrong refusal: ${r.err.slice(0, 240)}`;
});

check("projected/violation-record_ref-on-a-GROWTH-source-refuses-rather-than-being-INERT", () => {
  // Pointed the other way: a projected-only field on a non-projected kind would never
  // run, while reading to any manifest reviewer as though LINK-S were being checked.
  const r = run(
    mkProjRepo({
      sources: [
        { path: "burndown/register.json", kind: "register", precedence: 0 },
        { path: "burndown/growth.json", kind: "growth", precedence: 0 },
      ],
      extra: {
        "burndown/growth.json": j({
          _note: "fixture",
          _generated: "2026-08-27",
          _authority: "agent",
          record_ref: { kind: "external", pattern: "^rec://.+$" },
          items: [{ id: "GR-01-item", page: "Beta", status: "Not started" }],
        }),
      },
    }),
  );
  if (r.code !== 2) return `exit ${r.code} — an inert record_ref declaration was accepted`;
  return /which is not projected/.test(r.err) ? true : `wrong refusal: ${r.err.slice(0, 240)}`;
});

check("projected/sources_digest tracks MEMBERSHIP, and ONLY membership", () => {
  // BIPOLAR, and the first pole REVERSES an earlier revision of this case which
  // asserted the opposite. That revision was written while a projected item's derived
  // status still fed an adjudication bucket, where it was correct. Under separate
  // denominators the status feeds NO count, and the digest is hashed into every token
  // AND rendered into the block — so a state flip that moves no count would rewrite
  // ~100 tokens and make `--check` report STALE against a block whose every figure is
  // unchanged, invalidating every outstanding quote for nothing. A gate that cries
  // stale when nothing observable moved is a gate people learn to ignore.
  const dig = (rows) => (run(mkProjRepo({ rows })).out.match(/^sources_digest: (\S+)$/m) || [])[1];
  const base = dig(PROJ_ROWS);
  const stateChanged = dig([
    ["PJ-01-first", "working", "rec://pj-01"],
    ["PJ-02-second", "open", "rec://pj-02"],
    ["PJ-03-third", "open", "rec://pj-03"],
  ]);
  const drained = dig(PROJ_ROWS.slice(0, 2));
  if (!base || !stateChanged || !drained) return "a build produced no sources_digest";
  // The SECOND pole is what keeps the first from being a licence to ignore the
  // registry: a digest over committed BLOBS alone would hold across both, and the
  // drainage — the one thing that DID change a count — would be invisible.
  if (base !== stateChanged) return "a state-only change moved the digest, rewriting every token for identical counts";
  if (base === drained) return "a DRAINED member did not move the digest, so --check cannot see it";
  return true;
});

check("projected/a-query-that-ERRORS-refuses — it never falls back to a smaller population", () => {
  // `probe-driven-verification.md` MUST-7 at this surface: a check's INABILITY TO RUN
  // must never be representable as one of its verdicts. A projection that silently
  // returned fewer members on an unreachable registry would be indistinguishable from
  // every item legitimately closing — drainage is this class's NORMAL outcome, which is
  // precisely why the unrunnable case must not be able to wear its shape.
  const d = mkProjRepo();
  _commitFile(d, "burndown/query.mjs", 'process.stderr.write("registry unreachable\\n");\nprocess.exit(1);\n');
  const r = run(d, ["--json"]);
  if (r.code !== 2) return `exit ${r.code} — an unanswered query produced counts`;
  return /UNRUNNABLE, never a pass/.test(r.err) ? true : `wrong refusal: ${r.err.slice(0, 240)}`;
});

// ── PROMOTION GAP — the counter for work that lands in the trunk and not on main ──
//
// WHY THESE CASES EXIST. The gap is the one figure on this board that is NOT derived
// from a committed declared source: it is a live reading of two remote-tracking refs.
// That makes it the one figure whose correctness no other case here can speak to, and
// it is exactly the figure the dev-trunk directive makes invisible everywhere else —
// work in `dev` and not on `main` stops reading as unlanded to every landedness
// surface. A rendering that could only ever print one thing would be a counter in
// name; PAIR A is what shows it can print the other answer.
//
// THE LEVER IS THE REF STATE, planted with `git update-ref` on a real temporary repo —
// the same discipline as every case above, one variable at a time.

/**
 * A fixture repo carrying real `refs/remotes/origin/{main,dev}`, with `dev` ahead by
 * `ahead` commits. `ahead: 0` leaves the two refs at the same commit, which is a
 * DIFFERENT state from having no `dev` at all and must render differently.
 */
function mkTrunkRepo({ ahead = 0, dev = true } = {}) {
  const d = mkRepo(baseFiles());
  const at = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: d, encoding: "utf8" }).trim();
  const base = at();
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", base], { cwd: d, stdio: "ignore" });
  for (let i = 0; i < ahead; i++) _commitFile(d, `lane-${i}.txt`, `lane ${i}\n`);
  if (dev) execFileSync("git", ["update-ref", "refs/remotes/origin/dev", at()], { cwd: d, stdio: "ignore" });
  return d;
}
function gapLine(out) {
  return (out.match(/^promotion_gap: .*$/m) || [""])[0];
}
function runEnv(dir, env, args = []) {
  const r = spawnSync("node", [TOOL, "--repo", dir, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

check("promotion-gap/a-trunk-AHEAD-of-main-is-COUNTED-with-bucket-and-denominator", () => {
  const r = run(mkTrunkRepo({ ahead: 3 }));
  if (r.code !== 0) return `exit ${r.code}`;
  const line = gapLine(r.out);
  // The identity asserted is the FIGURE and its two identifying halves, not merely
  // that some line exists: a count with no bucket and no denominator is the bare
  // quantity `burndown-integrity.md` MUST-2 blocks.
  if (!/^promotion_gap: 3 of 4 commit\(s\) reachable from origin\/dev are NOT yet on origin\/main\b/.test(line))
    return `wrong figure: ${line.slice(0, 160)}`;
  if (!line.includes("bucket `awaiting promotion`")) return "no bucket named";
  if (!line.includes("denominator `commits reachable from origin/dev`")) return "no denominator named";
  return true;
});

check("promotion-gap/a-LEVEL-trunk-counts-ZERO-on-the-same-instrument", () => {
  // The other pole of the SAME reading. Together with the case above this is the
  // discrimination proof (`instrument-discipline.md` MUST-1): the instrument returns
  // a different answer when the world is different, so its `0` carries information.
  const r = run(mkTrunkRepo({ ahead: 0 }));
  if (r.code !== 0) return `exit ${r.code}`;
  const line = gapLine(r.out);
  return /^promotion_gap: 0 of 1 commit\(s\) reachable from origin\/dev are NOT yet on origin\/main\b/.test(line)
    ? true
    : `wrong figure: ${line.slice(0, 160)}`;
});

check("promotion-gap/b-an-UNMEASURABLE-gap-renders-UNKNOWN-and-NEVER-zero", () => {
  // `COC_TRUNK_REF` names a trunk the resolver will hand back, but this repo carries
  // no `origin/main` to count against, so the count cannot run. The whole point is
  // that this is NOT rendered as a gap of zero (`probe-driven-verification.md`
  // MUST-7 — UNRUNNABLE is not a verdict).
  const d = mkRepo(baseFiles());
  const r = runEnv(d, { COC_TRUNK_REF: "HEAD" });
  if (r.code !== 0) return `exit ${r.code}`;
  const line = gapLine(r.out);
  if (!/^promotion_gap: UNKNOWN\b/.test(line)) return `not UNKNOWN: ${line.slice(0, 160)}`;
  if (!line.includes("ABSENT reading, NOT a gap of zero")) return "UNKNOWN does not disclaim zero";
  if (/^promotion_gap: 0\b/.test(line)) return "an unmeasurable gap rendered as zero";
  return true;
});

check("promotion-gap/b-NO-separate-trunk-is-NOT-APPLICABLE-and-not-UNKNOWN", () => {
  // Third state, and it is neither of the other two: with no `origin/dev` the
  // resolver falls back to `origin/main`, so there is no gap BY CONSTRUCTION. A
  // repo that has not adopted the trunk must not read as one whose gap could not be
  // measured, and must not read as one measured at zero.
  const r = run(mkTrunkRepo({ ahead: 2, dev: false }));
  if (r.code !== 0) return `exit ${r.code}`;
  const line = gapLine(r.out);
  if (!/^promotion_gap: NOT APPLICABLE\b/.test(line)) return `not NOT-APPLICABLE: ${line.slice(0, 160)}`;
  if (/UNKNOWN/.test(line)) return "no-trunk collapsed into UNKNOWN";
  if (/ 0 of /.test(line)) return "no-trunk rendered as a measured zero";
  return true;
});

check("promotion-gap/c-a-MOVED-gap-does-NOT-make-check-STALE", () => {
  // THE LOAD-BEARING CLAIM. The gap moves whenever anyone pushes to the trunk and it
  // is read from remote-tracking refs, whose state depends on when this clone last
  // fetched — so folding it into block identity would make `--check` red on every
  // unrelated push and would make two operators report each other's block as stale.
  // It is excluded, exactly as `generated_from_sha` is.
  //
  // NOT VACUOUS: the case asserts the gap ACTUALLY MOVED between the two runs before
  // reading the green. A `--check` that stayed green because nothing changed would
  // prove nothing at all.
  const d = mkTrunkRepo({ ahead: 1 });
  const w = run(d, ["--write"]);
  if (w.code !== 0) return `--write exit ${w.code}`;
  const before = gapLine(run(d).out);
  _commitFile(d, "lane-9.txt", "lane 9\n");
  const tip = execFileSync("git", ["rev-parse", "HEAD"], { cwd: d, encoding: "utf8" }).trim();
  execFileSync("git", ["update-ref", "refs/remotes/origin/dev", tip], { cwd: d, stdio: "ignore" });
  const after = gapLine(run(d).out);
  if (before === after) return `the gap did not move (${before.slice(0, 80)}) — the green below would be vacuous`;
  const c = run(d, ["--check"]);
  return c.code === 0 ? true : `--check went STALE on a moved gap: exit ${c.code} ${c.err.slice(0, 160)}`;
});

check("promotion-gap/c-CONTROL-a-hand-edited-COUNT-still-goes-STALE-on-the-same-repo", () => {
  // The control for the case above, on the SAME repo shape. Without it, that green
  // is consistent with a `--check` that has simply stopped looking at this file.
  const d = mkTrunkRepo({ ahead: 1 });
  const w = run(d, ["--write"]);
  if (w.code !== 0) return `--write exit ${w.code}`;
  const abs = path.join(d, "REGISTER.md");
  const text = fs.readFileSync(abs, "utf8");
  const edited = text.replace(/\| Alpha \| (\d+)⟨/, "| Alpha | 99⟨");
  if (edited === text) return "the fixture edit matched nothing — the control cannot fire";
  fs.writeFileSync(abs, edited);
  const c = run(d, ["--check"]);
  return c.code === 1 ? true : `hand-edited count did not report STALE: exit ${c.code}`;
});

// ════════════════════════════════════════════════════════════════════════════
// R2 — THE DERIVED FLOOR (replaces the hand-typed `membership.min_members`)
// ════════════════════════════════════════════════════════════════════════════
//
// WHAT REPLACED WHAT. A source used to declare an ABSOLUTE floor. That number is
// denominated in members of a population whose whole purpose is to DRAIN, so it goes
// stale by doing nothing — MEASURED 2026-09-13, when a floor of 70 refused a build whose
// live count of 37 was CORRECT. The floor is now DERIVED from the last successful
// build's own committed measurement, less a declared scale-free tolerance.
//
// WHAT THE POLES BELOW HAVE TO SHOW, and why a one-sided suite could not. A ratio-based
// floor is a WEAKER-LOOKING gate than an absolute one, so the burden here is to show it
// still REFUSES the failure mode the absolute floor existed for — a query that
// HALF-FAILS AT EXIT 0 and returns a fraction of the true population — while ADMITTING
// the ordinary drain it could not tell from that failure. Those are opposite verdicts on
// the same mechanism, so both are pinned, and the three-case discrimination proof below
// pins them against ONE observation with three different query outputs.
//
// EVERY FIRING CASE PINS ITS OWN MESSAGE. Exit 2 is what EVERY refusal in this binary
// exits with, and this suite's README records the measured consequence: a mutation once
// left the whole runner green because a refusal arrived from a DIFFERENT assertion at the
// same exit code. A bare `code === 2` here would assert almost nothing.

const FLOOR_REGISTER = {
  _note: "fixture",
  _generated: "2026-08-01",
  _authority: "owner",
  _id_convention: "REG-NN-SLUG",
  items: [
    { id: "REG-01-A", page: "Alpha", status: "Signed off" },
    { id: "REG-04-B", page: "Beta", status: "In progress" },
  ],
};

/** `n` distinct live members, each over the 8-character join-key floor. */
function floorIds(n) {
  return Array.from({ length: n }, (_, i) => `FLR-${String(i + 1).padStart(4, "0")}-member`);
}

/**
 * A repo with ONE live source whose query returns exactly `members` ids, against a
 * committed observation of `observed` and a declared tolerance of `frac`.
 *
 * `original_ids: []` on purpose: every returned id is an ARRIVAL, so the live set can be
 * driven to any size — including ZERO — without the frozen-adjudication fences (a
 * still-live original with no adjudication, an item outside original_ids) firing for a
 * reason that has nothing to do with the floor.
 */
function mkFloorRepo({
  members = 3,
  observed = 3,
  frac = 0.25,
  recordObservation = true,
  declareFloorsNode = true,
  minMembers,
  liveSource = true,
  observedAt = isoDaysAgo(3),
  // The PROVENANCE fields of the recorded observation. `build`/null is the shape an
  // automatic bank writes; the poles that drive them off that shape are the ones about
  // provenance.
  observedBy = "build",
  observedReason = null,
  // A SECOND live source, for the per-subject re-grounding poles. `{members, observed}`.
  second = null,
} = {}) {
  const live = {
    _note: "fixture",
    _generated: "2026-08-20",
    _authority: "agent",
    membership: {
      command: [process.execPath, "burndown/query.mjs"],
      as_of: isoDaysAgo(2),
      max_age_days: 7,
      ...(minMembers === undefined ? {} : { min_members: minMembers }),
    },
    original_ids: [],
    arrival_defaults: { page: "Beta", status: "Not started" },
    items: [],
  };
  const manifest = {
    _schema: "burndown-manifest/v1",
    target: "REGISTER.md",
    pages: ["Alpha", "Beta"],
    ...(declareFloorsNode ? { floors: { path: FLOORS_REL, max_drop_fraction: frac } } : {}),
    sources: [
      { path: "burndown/register.json", kind: "register", precedence: 0 },
      ...(liveSource ? [{ path: "burndown/live.json", kind: "live-growth", precedence: 0 }] : []),
      ...(second ? [{ path: "burndown/live2.json", kind: "live-growth", precedence: 0 }] : []),
    ],
  };
  const second2 = second
    ? {
        ...live,
        membership: { ...live.membership, command: [process.execPath, "burndown/query2.mjs"] },
        arrival_defaults: { page: "Alpha", status: "Not started" },
      }
    : null;
  return mkRepo({
    "REGISTER.md": "# Register\n",
    "burndown/register.json": j(FLOOR_REGISTER),
    "burndown/live.json": j(live),
    "burndown/query.mjs": queryScript(floorIds(members)),
    ...(second
      ? {
          "burndown/live2.json": j(second2),
          // A DISJOINT id space, so the two sources cannot drain each other and the
          // only thing separating their verdicts is which subject was re-grounded.
          "burndown/query2.mjs": queryScript(floorIds(second.members).map((x) => x.replace("FLR-", "SND-"))),
        }
      : {}),
    [FLOORS_REL]: j({
      _schema: FLOORS_SCHEMA_ID,
      observations: {
        ...(recordObservation
          ? { "burndown/live.json": { members: observed, at: observedAt, by: observedBy, reason: observedReason } }
          : {}),
        ...(second
          ? { "burndown/live2.json": { members: second.observed, at: observedAt, by: "build", reason: null } }
          : {}),
      },
    }),
    "burndown-manifest.json": j(manifest),
  });
}

/** A firing pole: exit 2, the UNRUNNABLE banner, THIS refusal's own wording, and no block. */
function floorRefuses(name, opts, reasonRx, args = []) {
  check(name, () => {
    const r = run(mkFloorRepo(opts), args);
    if (r.code !== 2) return `expected exit 2, got ${r.code}. err=${r.err.slice(0, 300)}`;
    if (!/^UNRUNNABLE — refusing because /m.test(r.err)) return "no UNRUNNABLE banner on stderr";
    if (!reasonRx.test(r.err)) return `refused for the WRONG reason — wanted ${reasonRx}, got: ${r.err.split("\n")[0]}`;
    if (/BURNDOWN:BEGIN/.test(r.out) || /ALL PAGES/.test(r.out)) return "a refusal EMITTED A BLOCK on stdout";
    return true;
  });
}

/** A silent pole: exit 0, and a block that actually counted the live members. */
function floorBuilds(name, opts, wantBoard) {
  check(name, () => {
    const r = run(mkFloorRepo(opts));
    if (r.code !== 0) return `expected exit 0, got ${r.code}: ${r.err.slice(0, 300)}`;
    const all = allPagesRow(r.out);
    return all && all.board === wantBoard ? true : `ALL PAGES=${JSON.stringify(all)}, wanted board ${wantBoard}`;
  });
}

// ── ARM 1 — the tolerance admits an ordinary drain and refuses a collapse ────

floorBuilds(
  "floors/compliant-a-drop-WITHIN-the-tolerance-builds (37 observed, 30 live, floor 28)",
  { observed: 37, members: 30, frac: 0.25 },
  32, // 2 register items + 30 live arrivals
);

floorRefuses(
  "floors/violation-a-drop-BELOW-the-derived-floor-REFUSES (37 observed, 20 live, floor 28)",
  { observed: 37, members: 20, frac: 0.25 },
  /the live membership query returned 20, below the DERIVED floor of 28/,
);

// ── ARM 2 — THE THREE-CASE DISCRIMINATION PROOF ─────────────────────────────
//
// ONE observation (37), ONE tolerance (0.25), ONE derived floor (28), THREE query
// outputs, and the three outcomes are NOT all the same. Named as three separate cases so
// the three verdicts are readable in the runner's own output rather than buried in a
// loop. The falsifying result, stated before the cases are cited as evidence: a floor
// that had stopped discriminating would produce the SAME verdict for all three — three
// builds if it never fires, three refusals if it always does — and the fourth case below
// is what fails in either of those worlds.
{
  const outcomes = [];
  const record = (label, code) => outcomes.push(`${label}=${code === 0 ? "BUILD" : `refuse(${code})`}`);

  check("floors/DISCRIMINATION-1-of-3 — a query returning 0 against an observation of 37 REFUSES", () => {
    const r = run(mkFloorRepo({ observed: 37, members: 0, frac: 0.25 }));
    record("0", r.code);
    if (r.code !== 2) return `expected exit 2, got ${r.code}: ${r.out.slice(0, 200)}`;
    return /the live membership query returned 0, below the DERIVED floor of 28/.test(r.err)
      ? true
      : `wrong refusal: ${r.err.split("\n")[0].slice(0, 240)}`;
  });

  check("floors/DISCRIMINATION-2-of-3 — a query returning 37 against an observation of 37 PASSES", () => {
    const r = run(mkFloorRepo({ observed: 37, members: 37, frac: 0.25 }));
    record("37", r.code);
    if (r.code !== 0) return `expected exit 0, got ${r.code}: ${r.err.slice(0, 300)}`;
    const all = allPagesRow(r.out);
    return all && all.board === 39 ? true : `ALL PAGES=${JSON.stringify(all)}, wanted board 39 (2 register + 37 live)`;
  });

  check("floors/DISCRIMINATION-3-of-3 — a query returning 4 against an observation of 37 REFUSES", () => {
    const r = run(mkFloorRepo({ observed: 37, members: 4, frac: 0.25 }));
    record("4", r.code);
    if (r.code !== 2) return `expected exit 2, got ${r.code}: ${r.out.slice(0, 200)}`;
    return /the live membership query returned 4, below the DERIVED floor of 28/.test(r.err)
      ? true
      : `wrong refusal: ${r.err.split("\n")[0].slice(0, 240)}`;
  });

  check("floors/the-THREE-outcomes-are-NOT-three-of-a-kind (refuse · build · refuse)", () => {
    if (outcomes.length !== 3) return `only ${outcomes.length} of the three cases produced an outcome`;
    // The SEQUENCE, not merely the variety: a floor that had inverted would also produce
    // two distinct verdicts, and "not all the same" would pass on it.
    const got = outcomes.join(" · ");
    return got === "0=refuse(2) · 37=BUILD · 4=refuse(2)"
      ? true
      : `the floor did not discriminate as specified — outcomes were [${got}]`;
  });
}

// ── ARM 3 — the superseded key is REFUSED, not ignored ──────────────────────
//
// A silently-dropped declaration is the worst outcome available: its PRESENCE is what a
// later reader cites as proof the source is floored, so a stale 70 sitting next to a
// derived floor of 28 is a number someone will believe.

floorRefuses(
  "floors/violation-a-source-STILL-carrying-membership.min_members-REFUSES (superseded, not ignored)",
  { observed: 37, members: 30, frac: 0.25, minMembers: 70 },
  /declares membership\.min_members 70, which is SUPERSEDED and no longer read/,
);

floorBuilds(
  "floors/compliant-the-SAME-source-WITHOUT-min_members-builds (the only difference is the key)",
  { observed: 37, members: 30, frac: 0.25 },
  32,
);

// ── ARM 4 — a missing observation refuses rather than adopting this run's reading ──

floorRefuses(
  "floors/violation-a-live-source-with-NO-RECORDED-OBSERVATION-REFUSES (no baseline to derive from)",
  { observed: 37, members: 30, recordObservation: false },
  /carries no usable observation for 'burndown\/live\.json'/,
);

floorBuilds(
  "floors/compliant-…and WITH the observation recorded the identical query builds",
  { observed: 37, members: 30, frac: 0.25, recordObservation: true },
  32,
);

// ── ARM 4b — a recorded observation carries its PROVENANCE ─────────────────
//
// The floors file's whole claim is that its numbers came from a QUERY rather than from a
// keyboard, and `by` is where a row says which. Two shapes are legitimate and they are not
// interchangeable: `build` is a measurement banked automatically INSIDE the declared
// tolerance and needs no justification, `reground` is an operator asserting that a LARGER
// drop is real and carries the sentence a reviewer disagrees with. A row that is neither,
// or that mixes them, is a number of unknown provenance.

floorRefuses(
  "floors/violation-an-observation-whose-'by'-names-NEITHER-channel-REFUSES (unknown provenance)",
  { observed: 37, members: 30, frac: 0.25, observedBy: "fixture" },
  /observation 'burndown\/live\.json' carries by "fixture"; expected/,
);

floorRefuses(
  "floors/violation-a-'reground'-observation-with-NO-adequate-reason-REFUSES",
  // The re-ground channel is the one that admits a large drop, so the sentence that
  // justified it is the only thing standing behind the number. A row claiming that
  // channel without one claims the exemption and skips its price.
  { observed: 37, members: 30, frac: 0.25, observedBy: "reground", observedReason: "ok" },
  /observation 'burndown\/live\.json' is by 'reground' but carries no usable reason/,
);

floorRefuses(
  "floors/violation-a-'build'-observation-CARRYING-a-reason-REFUSES (the channels are not interchangeable)",
  // Pointed the other way: an automatic bank stayed inside the tolerance, so a
  // justification sentence on it is a claim nobody made — and it would train a reader to
  // skim the field on exactly the rows where it is load-bearing.
  { observed: 37, members: 30, frac: 0.25, observedBy: "build", observedReason: "this drop was reviewed and approved" },
  /observation 'burndown\/live\.json' is by 'build' but carries a reason/,
);

// ── ARM 5 — the `floors` node is mandatory exactly where it governs something ──

floorRefuses(
  "floors/violation-a-manifest-declaring-a-LIVE-source-and-NO-floors-node-REFUSES",
  { observed: 37, members: 30, declareFloorsNode: false },
  /declares a live\/projected source but no 'floors' node/,
);

check("floors/compliant-a-manifest-with-NO-live-source-and-no-floors-node-builds (absent bounds nothing)", () => {
  // The scope pole. Demanding the node on a board that runs no membership query would be
  // a bound that bounds nothing — and it would break every downstream board on its next
  // pull of this binary, which is how a gate gets reverted rather than adopted.
  const r = run(mkFloorRepo({ liveSource: false, declareFloorsNode: false }));
  if (r.code !== 0) return `expected exit 0, got ${r.code}: ${r.err.slice(0, 300)}`;
  const all = allPagesRow(r.out);
  return all && all.board === 2 ? true : `ALL PAGES=${JSON.stringify(all)}, wanted board 2`;
});

// ── ARM 6 — the tolerance is bounded at BOTH ends ───────────────────────────
//
// Above the range a fraction approaches accepting a drop to zero — the gate switched off
// while every field still reads as populated. Below it, it refuses every drain including
// a correct one, which is the gate operators disable.

floorRefuses(
  "floors/violation-max_drop_fraction-ABOVE-the-declared-range-REFUSES (0.9 > 0.75)",
  { observed: 37, members: 30, frac: 0.9 },
  /declares floors\.max_drop_fraction 0\.9; expected a number in \[0\.01, 0\.75\]/,
);

floorRefuses(
  "floors/violation-max_drop_fraction-BELOW-the-declared-range-REFUSES (0.001 < 0.01)",
  { observed: 37, members: 37, frac: 0.001 },
  /declares floors\.max_drop_fraction 0\.001; expected a number in \[0\.01, 0\.75\]/,
);

floorRefuses(
  "floors/violation-a-NON-NUMERIC-max_drop_fraction-REFUSES",
  { observed: 37, members: 37, frac: "a quarter" },
  /declares floors\.max_drop_fraction "a quarter"; expected a number in \[0\.01, 0\.75\]/,
);

check("floors/compliant-max_drop_fraction-at-BOTH-range-ENDS-builds (0.01 and 0.75 are IN)", () => {
  // The bounds are INCLUSIVE, and without this pole the two refusals above are equally
  // consistent with a range that rejects its own endpoints.
  const tight = run(mkFloorRepo({ observed: 37, members: 37, frac: 0.01 }));
  const loose = run(mkFloorRepo({ observed: 37, members: 30, frac: 0.75 }));
  if (tight.code !== 0) return `frac 0.01 refused: ${tight.err.split("\n")[0].slice(0, 200)}`;
  if (loose.code !== 0) return `frac 0.75 refused: ${loose.err.split("\n")[0].slice(0, 200)}`;
  return true;
});

// ── ARM 7 — `--reground` banks a MEASURED value behind a deliberation bar ───

// The SUBJECT is positional and REQUIRED: `--reground <source-path> --reason "<why>"`.
// A re-ground is a claim about ONE population, so the safe form is the only form that
// parses.
const REGROUND_REASON_TEXT = "the registry genuinely drained to four rows this week";

floorRefuses(
  "floors/violation---reground-with-NO---reason-REFUSES",
  { observed: 37, members: 4, frac: 0.25 },
  /--reground requires --reason .* of at least 24 characters/,
  ["--reground", "--subject", "burndown/live.json"],
);

floorRefuses(
  "floors/violation---reground-with-a-TOO-SHORT---reason-REFUSES (a shrug is not a justification)",
  { observed: 37, members: 4, frac: 0.25 },
  /--reground requires --reason .* of at least 24 characters/,
  ["--reground", "--subject", "burndown/live.json", "--reason", "drained"],
);

floorRefuses(
  "floors/violation---reground-with-NO-SUBJECT-REFUSES (a re-ground is a claim about ONE population)",
  // The reason is placed FIRST so the subject slot is genuinely empty rather than
  // swallowing a flag — this pole is about the missing subject, not about parsing.
  { observed: 37, members: 4, frac: 0.25 },
  /--reground requires --subject <source-path>, naming the ONE source it re-grounds/,
  ["--reground", "--reason", REGROUND_REASON_TEXT],
);

check("floors/compliant---reground-with-a-real-reason-BANKS-the-MEASURED-value (4, not a typed number)", () => {
  // THE PROPERTY, stated as its falsifying result: if `--reground` banked anything other
  // than what the query RETURNED, the committed file would end up carrying a number the
  // operator chose. It writes 4 — the measurement — under a reason a reviewer can read.
  const d = mkFloorRepo({ observed: 37, members: 4, frac: 0.25 });
  const before = JSON.parse(fs.readFileSync(path.join(d, FLOORS_REL), "utf8"));
  if (before.observations["burndown/live.json"].members !== 37) return "the fixture did not start at 37";
  const reason = REGROUND_REASON_TEXT;
  const r = run(d, ["--reground", "--subject", "burndown/live.json", "--reason", reason]);
  if (r.code !== 0) return `--reground exit ${r.code}: ${r.err.slice(0, 300)}`;
  const after = JSON.parse(fs.readFileSync(path.join(d, FLOORS_REL), "utf8")).observations["burndown/live.json"];
  if (after.members !== 4) return `banked ${after.members}, wanted the MEASURED 4`;
  if (after.by !== "reground") return `banked by '${after.by}', wanted 'reground'`;
  if (after.reason !== reason) return `banked reason ${JSON.stringify(after.reason)}`;
  // And the same repo, re-run WITHOUT the suspension, would still refuse on the
  // now-uncommitted file — which is what makes the measurement a reviewable diff rather
  // than a working-tree edit nobody sees.
  return /--reground: wrote 1 measurement\(s\)/.test(r.out) ? true : `unexpected stdout: ${r.out.slice(0, 200)}`;
});

// ── ARM 7b — a re-ground is SCOPED TO ITS SUBJECT ──────────────────────────
//
// THE DEFECT THIS PAIR PINS, measured before the scoping existed: with two sources where
// A drains legitimately and B COLLAPSES — the half-failed-query-at-exit-0 case the whole
// mechanism exists to catch — one `--reground` banked BOTH, and stamped B's collapse with
// a reason sentence that talked only about A. The provenance was worse than useless
// because it was TRUE: a reviewer cannot disagree with an accurate sentence, and nothing
// in the record said it was about a different row.
//
// Both poles run the SAME two-source repo and the SAME command shape. The ONLY difference
// is WHICH subject is named.
{
  // A: observed 37, live 4 — a collapse the operator is asserting is real.
  // B: observed 95, live 2 — a collapse nobody has asserted anything about.
  const two = { observed: 37, members: 4, frac: 0.25, second: { observed: 95, members: 2 } };

  check("floors/violation-re-grounding-ONE-source-does-NOT-carry-a-SIBLING's-collapse-past-its-floor", () => {
    const d = mkFloorRepo(two);
    const r = run(d, ["--reground", "--subject", "burndown/live.json", "--reason", REGROUND_REASON_TEXT]);
    if (r.code !== 2) return `expected exit 2, got ${r.code} — the sibling's collapse was carried through`;
    if (!/source 'burndown\/live2\.json': the live membership query returned 2, below the DERIVED floor of 72/.test(r.err)) {
      return `refused, but not on the SIBLING's floor: ${r.err.split("\n")[0].slice(0, 280)}`;
    }
    // And it banked NOTHING — a refusal must not leave half a measurement behind.
    const obs = JSON.parse(fs.readFileSync(path.join(d, FLOORS_REL), "utf8")).observations;
    return obs["burndown/live.json"].members === 37 && obs["burndown/live2.json"].members === 95
      ? true
      : `the refusing run still wrote: ${JSON.stringify(obs)}`;
  });

  check("floors/compliant-…and with the SIBLING inside its own tolerance the SAME command banks ONLY the named subject", () => {
    // The discrimination pole. B now sits at 80 against 95 — inside its 0.25 tolerance,
    // so its floor does not fire — and the identical command succeeds. That isolates the
    // refusal above to the sibling's FLOOR rather than to the presence of a second source.
    const d = mkFloorRepo({ ...two, second: { observed: 95, members: 80 } });
    const r = run(d, ["--reground", "--subject", "burndown/live.json", "--reason", REGROUND_REASON_TEXT]);
    if (r.code !== 0) return `expected exit 0, got ${r.code}: ${r.err.split("\n")[0].slice(0, 280)}`;
    const obs = JSON.parse(fs.readFileSync(path.join(d, FLOORS_REL), "utf8")).observations;
    if (obs["burndown/live.json"].members !== 4) return `the named subject banked ${obs["burndown/live.json"].members}, wanted 4`;
    // THE LOAD-BEARING HALF: the UNNAMED source is untouched — not re-banked at its new
    // reading of 80, and not stamped with a reason sentence written about another row.
    const b = obs["burndown/live2.json"];
    return b.members === 95 && b.by === "build" && b.reason === null
      ? true
      : `the UNNAMED source was re-grounded too: ${JSON.stringify(b)}`;
  });
}

// ── ARM 8 — zero is reachable ONLY from an observation that is already zero ──

floorRefuses(
  "floors/violation-a-floor-derived-from-a-NON-ZERO-observation-NEVER-admits-0 (observed 1 -> floor 1)",
  // `Math.max(1, …)` is what stops the ratchet reaching zero on its own: from ANY
  // non-zero observation the floor stays at least 1, so a query returning nothing always
  // refuses however permissive the tolerance. Measured at the most permissive legal
  // tolerance there is, because that is where the ratchet would slip if it could.
  { observed: 1, members: 0, frac: 0.75 },
  /the live membership query returned 0, below the DERIVED floor of 1/,
);

check("floors/compliant-…and an observation of 0 is the ONLY state in which 0 is admitted", () => {
  // The other pole, and the reason the case above is not simply "the floor never reaches
  // zero": a genuine drain to zero IS this registry's success state. It is reachable, but
  // only from a zero a human already banked with --reground.
  //
  // RE-AUTHORED, and the reason is this suite's own discipline rather than a tidy-up.
  // This case used to build its zero observation with the DEFAULT provenance —
  // `by: "build"`, `reason: null` — while its own comment said "a zero a human already
  // banked with --reground". The prose described the reground path and the data
  // exercised the hand-edit path, so what the green actually pinned was that a
  // `by: "build"` zero is ADMITTED: the exact defect, cemented by the case written to
  // describe the protection. It now carries the provenance its sentence claims.
  const r = run(
    mkFloorRepo({ observed: 0, members: 0, frac: 0.75, observedBy: "reground", observedReason: REGROUND_REASON_TEXT }),
  );
  if (r.code !== 0) return `expected exit 0, got ${r.code}: ${r.err.split("\n")[0].slice(0, 240)}`;
  const all = allPagesRow(r.out);
  return all && all.board === 2 ? true : `ALL PAGES=${JSON.stringify(all)}, wanted board 2 (the register alone)`;
});

// The VIOLATION pole the case above was missing, and without which its green said
// nothing: a zero observation that nobody claimed. Every field is shaped exactly as an
// automatic bank writes one — integer members, a valid past `at`, `by: "build"`, and no
// reason, which is what a `build` record is REQUIRED to carry — so it passed every check
// in `checkAgainstDerivedFloor`, derived a floor of 0, and left `live < 0` unable to fire
// for ever. It is the CHEAPEST disarming edit on this file: strictly less ceremony than
// the `--reground` route the sanctioned path demands a 24-character sentence for.
floorRefuses(
  "floors/violation-a-ZERO-observation-by-BUILD-REFUSES (the floor-off edit that needed no sentence)",
  { observed: 0, members: 0, frac: 0.75, observedBy: "build", observedReason: null },
  /records 0 members by 'build'/,
);

// The DISCRIMINATION half: the refusal above must be about the ZERO, not about `build`
// provenance in general. Same `by: "build"`, same absent reason, one member instead of
// none — and it builds. Without this case the pole above would also be green if the
// implementation had simply refused every `build` record.
floorBuilds(
  "floors/compliant-…and a NON-ZERO observation by BUILD still needs no sentence (the refusal is about the 0)",
  { observed: 1, members: 1, frac: 0.75, observedBy: "build", observedReason: null },
  3, // 2 register items + 1 live arrival
);

// ════════════════════════════════════════════════════════════════════════════
// R1 — THE ACCEPTANCE CHANNEL
// ════════════════════════════════════════════════════════════════════════════
//
// WHAT THE GATE IS. `Signed off` is the only route to completion on this board, and it is
// set by ONE channel: an OWNER countersignature appended to the event log. That channel
// had a producer, a fence and a consumer, and no FORCING FUNCTION — so it silently never
// ran while the board reported "no page is complete" as PROSE. Nobody is paged by a
// description. This gate bounds how long the channel may stay SILENT while adjudicated
// work sits unaccepted, and it is an AGE bound rather than a count: a count gate would be
// the hand-typed-floor defect wearing a different hat.
//
// WHY EVERY REPO BELOW CARRIES A REAL SIGNED LOG. The anchor advances only on a folded
// `activation`, and the generator refuses an `acceptance` node on any tracker that is not
// an `event-log`. Every record here is therefore REALLY SIGNED by a real ed25519 key this
// process generates, against a real committed roster — a fixture signing with a
// placeholder could only ever show that the gate refuses placeholders.
//
// THE LOAD-BEARING PAIR IS ARM 11: an agent cannot disarm this gate. A `proposal` is the
// agent's channel and carries `proposed_status` — including, legitimately, `Signed off` —
// and it is INERT. Only an owner `activation` moves the anchor. The two logs in that pair
// differ by exactly ONE record.

const ACC_SIGNER = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "burndown-fx-key-"));
  // Registered for cleanup: this one holds an unencrypted PRIVATE KEY, so leaving
  // it behind is the worst of the three leak sites even though it is the smallest.
  FIXTURE_DIRS.push(dir);
  const keyPath = path.join(dir, "id_ed25519");
  execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "burndown-acceptance-fixture", "-f", keyPath], {
    stdio: "ignore",
  });
  return {
    keyPath,
    pubkey: fs.readFileSync(`${keyPath}.pub`, "utf8").trim(),
    fingerprint: execFileSync("ssh-keygen", ["-lf", `${keyPath}.pub`], { encoding: "utf8" }).split(/\s+/)[1],
    person_id: "pid-acceptance-fixture-owner",
    display_id: "acceptance-fixture",
  };
})();

const ACC_EVENTS = _require(path.join(REPO_ROOT, ".claude", "hooks", "lib", "burndown-events.js"));
const ACC_SIGN = _require(path.join(REPO_ROOT, ".claude", "hooks", "lib", "coc-sign.js"));
const { canonicalRecordHash: _accHash } = _require(path.join(REPO_ROOT, ".claude", "hooks", "lib", "signed-log.js"));

const ACC_ITEM = "R1-alpha-item";
const ACC_ITEM_2 = "R2-alpha-item";
const ACC_ANCHOR_FILE = "journal/0001-alpha.md";

let _accRecN = 0;

/** Sign a record for real over the canonical bytes MINUS `sig` — the scope the reader re-derives. */
function accSign(rec) {
  const copy = { ...rec };
  delete copy.sig;
  const r = ACC_SIGN.sign(ACC_SIGN.canonicalSerialize(copy), { keyType: "ssh", keyPath: ACC_SIGNER.keyPath });
  if (!r.ok) throw new Error(`the fixture signer failed: ${r.error}: ${r.reason}`);
  return { ...copy, sig: r.sig };
}

/**
 * A whole log whose per-emitter chain is CORRECT — `seq` from 1, each `prev_hash` the
 * canonical hash of the previous record. A chain is a property of the LOG, so
 * concatenating independently built lines would red the chain check for a reason that has
 * nothing to do with the arm under test.
 *
 * A spec may be a function, which receives the records built so far — that is how an
 * `activation` names the record id of the `proposal` it countersigns.
 */
function accLog(specs) {
  let seq = 0;
  let prev = null;
  const built = [];
  const out = [];
  for (const spec of specs) {
    const fields = typeof spec === "function" ? spec(built) : spec;
    const rec = accSign({
      id: `rec_acceptance_${String(++_accRecN).padStart(6, "0")}`,
      timestamp: new Date().toISOString(),
      session_id: "fixture",
      repo: "fixture",
      verified_id: ACC_SIGNER.fingerprint,
      person_id: ACC_SIGNER.person_id,
      display_id: ACC_SIGNER.display_id,
      ...ACC_EVENTS.buildEvent(fields),
      sig_alg: "ssh-ed25519",
      seq: seq + 1,
      prev_hash: prev,
    });
    seq += 1;
    const h = _accHash(rec);
    if (!h.ok) throw new Error(`the fixture chain could not hash a record it just built: ${h.reason}`);
    prev = h.hash;
    built.push(rec);
    out.push(JSON.stringify(rec) + "\n");
  }
  return out.join("");
}

const accGenesis = (id) => ({
  kind: "genesis",
  item_id: id,
  item: "an alpha item",
  value_anchor: `${ACC_ANCHOR_FILE}#${id}`,
  status: "In progress",
  authority: "agent",
  source: "fixture",
});

/** The AGENT's channel: fully formed, signed, dated — and INERT until countersigned. */
const ACC_PROPOSAL = {
  kind: "proposal",
  item_id: ACC_ITEM,
  item: "an alpha item",
  value_anchor: `${ACC_ANCHOR_FILE}#${ACC_ITEM}`,
  status: ACC_EVENTS.PROPOSAL_STATUS,
  authority: "agent",
  source: "fixture",
  reason: "the owner approved this out loud in session and nothing carried it",
  proposed_status: "Signed off",
};

/** The OWNER's countersignature, naming the proposal's RECORD id. */
const accActivation = (built) => ({
  kind: "activation",
  item_id: ACC_ITEM,
  item: "an alpha item",
  value_anchor: `${ACC_ANCHOR_FILE}#${ACC_ITEM}`,
  status: "Signed off",
  authority: "owner",
  source: "fixture",
  activates: built[built.length - 1].id,
  accepted_by: "Ada Lovelace",
});

/** Two adjudicated items, BOTH outstanding, so the channel always has something to accept. */
const ACC_REGISTER_OUTSTANDING = {
  _note: "fixture",
  _generated: "2026-08-01",
  _authority: "owner",
  _id_convention: "RN-SLUG",
  items: [
    { id: ACC_ITEM, page: "Alpha", status: "In progress" },
    { id: ACC_ITEM_2, page: "Alpha", status: "Not started" },
  ],
};

/** The same two items, BOTH accepted — the state in which the channel has nothing to do. */
const ACC_REGISTER_DONE = {
  ...ACC_REGISTER_OUTSTANDING,
  items: ACC_REGISTER_OUTSTANDING.items.map((i) => ({ ...i, status: "Signed off" })),
};

/** The declared acceptance bound. Dates are COMPUTED — a literal `armed_on` is a time bomb. */
function accNode(over = {}) {
  return {
    armed_on: isoDaysAgo(90),
    warn_after_days: 30,
    refuse_after_days: 60,
    accepted_by: "Ada Lovelace",
    ...over,
  };
}

function mkAcceptanceRepo({ acceptance = accNode(), register = ACC_REGISTER_OUTSTANDING, events, role = "owner" } = {}) {
  const manifest = {
    _schema: "burndown-manifest/v1",
    target: "REGISTER.md",
    pages: ["Alpha"],
    sources: [{ path: "burndown/register.json", kind: "register", precedence: 0 }],
    tracker: { path: ACC_EVENTS.EVENTS_REL, kind: "event-log", anchor_roots: ["journal/"] },
    signature_suite: {
      generation: ACC_EVENTS.SCHEMAS[ACC_EVENTS.SCHEMA].generation,
      schema: ACC_EVENTS.SCHEMA,
      suite: "ssh-ed25519",
      prior_generations: [{ generation: 0, schema: "burndown-event/v1", suite: "ssh-ed25519" }],
    },
    ...(acceptance === null ? {} : { acceptance }),
  };
  return mkRepo({
    "REGISTER.md": "# Register\n",
    "burndown/register.json": j(register),
    "burndown-manifest.json": j(manifest),
    [ACC_ANCHOR_FILE]: `# Alpha\n\nThe ruling for ${ACC_ITEM} and ${ACC_ITEM_2} is recorded here.\n`,
    [ACC_EVENTS.ROSTER_REL]: j({
      genesis: { established_at: "2026-08-01T00:00:00.000Z" },
      persons: {
        [ACC_SIGNER.person_id]: {
          display_id: ACC_SIGNER.display_id,
          // The signer's ROSTERED role. `owner` everywhere except the one pole that
          // demotes it — `authority` is a self-declared field inside the signed bytes,
          // and this is the committed fact that decides whether the claim is backed.
          role,
          host_role: "human",
          keys: [{ type: "ssh", fingerprint: ACC_SIGNER.fingerprint, pubkey: ACC_SIGNER.pubkey }],
        },
      },
    }),
    [ACC_EVENTS.EVENTS_REL]: events || accLog([accGenesis(ACC_ITEM), accGenesis(ACC_ITEM_2)]),
  });
}

function accRefuses(name, opts, reasonRx) {
  check(name, () => {
    const r = run(mkAcceptanceRepo(opts));
    if (r.code !== 2) return `expected exit 2, got ${r.code}. err=${r.err.slice(0, 300)}`;
    if (!/^UNRUNNABLE — refusing because /m.test(r.err)) return "no UNRUNNABLE banner on stderr";
    if (!reasonRx.test(r.err)) return `refused for the WRONG reason — wanted ${reasonRx}, got: ${r.err.split("\n")[0]}`;
    if (/BURNDOWN:BEGIN/.test(r.out) || /ALL PAGES/.test(r.out)) return "a refusal EMITTED A BLOCK on stdout";
    return true;
  });
}

/** The acceptance verdict the build actually reached, read off `--json`. */
function accVerdict(opts, args = ["--json"]) {
  const r = run(mkAcceptanceRepo(opts), args);
  if (r.code !== 0) return { code: r.code, err: r.err };
  return { code: 0, err: r.err, out: r.out, acceptance: JSON.parse(r.out).acceptance };
}

// ── ARM 9 — silence past the refusal bound refuses; under it, builds ────────

accRefuses(
  "acceptance/violation-silence-PAST-refuse_after_days-REFUSES (90 days silent, bound 60)",
  { acceptance: accNode() },
  /the ACCEPTANCE CHANNEL has been silent for 90 day\(s\), past the declared bound of 60/,
);

check("acceptance/compliant-silence-UNDER-refuse_after_days-builds (10 days silent, bound 60)", () => {
  const v = accVerdict({ acceptance: accNode({ armed_on: isoDaysAgo(10) }) });
  if (v.code !== 0) return `expected exit 0, got ${v.code}: ${v.err.slice(0, 300)}`;
  // POSITIVE, not merely non-refusing: the channel was evaluated, it had outstanding work
  // to evaluate against, and it came back quiet. A green with `outstanding: 0` would be
  // this gate reporting "nothing to do", which is a different fact.
  return v.acceptance.state === "quiet" && v.acceptance.silentDays === 10 && v.acceptance.outstanding === 2
    ? true
    : `acceptance = ${JSON.stringify(v.acceptance)}`;
});

// ── ARM 10 — the WARNING rung: exit 0 AND a loud line on stderr ─────────────
//
// A ladder with one rung reading as two is the shape this pair exists to refuse. The
// warning is asserted on BOTH axes — the exit code AND the stderr text — because either
// alone is consistent with the rung not existing: a silent exit 0 is indistinguishable
// from the quiet case, and a warning that came with a refusal is just the refusal.

check("acceptance/compliant-silence-past-warn-but-UNDER-refuse-EXITS-0-AND-WARNS-on-stderr", () => {
  const v = accVerdict({ acceptance: accNode({ armed_on: isoDaysAgo(40) }) });
  if (v.code !== 0) return `expected exit 0, got ${v.code}: ${v.err.slice(0, 300)}`;
  if (v.acceptance.state !== "warning") return `state was '${v.acceptance.state}', wanted 'warning'`;
  if (!/ACCEPTANCE CHANNEL WARNING — silent 40 day\(s\); this build REFUSES past 60/.test(v.err)) {
    return `no warning on stderr; stderr was ${JSON.stringify(v.err.slice(0, 240))}`;
  }
  // It says how long is left, which is what makes it actionable rather than decorative.
  return /in 20 day\(s\)/.test(v.err) ? true : `the warning did not state the remaining budget: ${v.err.slice(0, 240)}`;
});

check("acceptance/compliant-silence-UNDER-warn-exits-0-and-writes-NO-warning-to-stderr", () => {
  // The falsifying pole for the case above. Without it, that green is equally consistent
  // with a build that warns on EVERY run, which would train the reader to ignore it.
  const v = accVerdict({ acceptance: accNode({ armed_on: isoDaysAgo(10) }) });
  if (v.code !== 0) return `expected exit 0, got ${v.code}: ${v.err.slice(0, 300)}`;
  if (v.acceptance.state !== "quiet") return `state was '${v.acceptance.state}', wanted 'quiet'`;
  return /ACCEPTANCE CHANNEL WARNING/.test(v.err) ? `a quiet build still warned: ${v.err.slice(0, 240)}` : true;
});

// ── ARM 11 — THE LOAD-BEARING PAIR: an agent cannot disarm this gate ────────
//
// The two logs are built from the SAME list of records and differ by exactly ONE: the
// green pole appends an OWNER `activation`. Both carry a `proposal` whose
// `proposed_status` is the literal string `Signed off` — so a gate that keyed on that
// string appearing in the log, or on a record merely MENTIONING an owner status, would
// go quiet on the red pole. It does not: a proposal is the agent's channel, it is INERT,
// and only a countersignature the AGENT CANNOT AUTHOR moves the anchor.
{
  const base = [accGenesis(ACC_ITEM), accGenesis(ACC_ITEM_2), ACC_PROPOSAL];
  const redEvents = accLog(base);
  const greenEvents = accLog([...base, accActivation]);
  let redCode = null;
  let greenCode = null;

  check("acceptance/violation-a-PROPOSAL-proposing-'Signed off'-does-NOT-move-the-anchor (still REFUSES)", () => {
    const r = run(mkAcceptanceRepo({ events: redEvents }));
    redCode = r.code;
    if (r.code !== 2) return `expected exit 2, got ${r.code}: ${r.out.slice(0, 200)}`;
    if (!/the ACCEPTANCE CHANNEL has been silent for 90 day\(s\)/.test(r.err)) {
      return `wrong refusal: ${r.err.split("\n")[0].slice(0, 240)}`;
    }
    // And it says so explicitly, which is what stops a reader concluding the proposal
    // counted for something: NONE EVER, clock still running from the arming date.
    return /Last owner acceptance: NONE EVER/.test(r.err)
      ? true
      : `the refusal did not report the anchor as never-advanced: ${r.err.slice(0, 300)}`;
  });

  check("acceptance/compliant-an-OWNER-ACTIVATION-DOES-move-the-anchor-and-the-build-passes", () => {
    const r = run(mkAcceptanceRepo({ events: greenEvents }), ["--json"]);
    greenCode = r.code;
    if (r.code !== 0) return `expected exit 0, got ${r.code}: ${r.err.slice(0, 400)}`;
    const a = JSON.parse(r.out).acceptance;
    if (a.lastAccepted === null) return "the activation did not register as an owner acceptance";
    if (a.anchor !== a.lastAccepted) return `anchor ${a.anchor} did not follow lastAccepted ${a.lastAccepted}`;
    // THE POLE IS NOT CONTAMINATED, and this is the assertion that shows it. If the
    // activation had emptied the outstanding set, this build would pass as
    // `not-applicable` — "nothing to accept" — which is a DIFFERENT fact from "the
    // channel was exercised". Two items are still outstanding and the state is `quiet`.
    return a.state === "quiet" && a.outstanding === 2 && a.silentDays === 0
      ? true
      : `acceptance = ${JSON.stringify(a)}`;
  });

  // AN ORPHAN ACTIVATION MUST NOT BUY SILENCE. Same owner, same roster, same signature,
  // same status, same `accepted_by` — the ONE changed field is `activates`, which here
  // names a proposal record id that does not exist in the log. The fold declines to
  // honour it (SKIP_KINDS.ACTIVATION_ORPHAN): it sets no cell, lands no status, and
  // leaves `signedOff` at 0. A record that adjudicates nothing must not disarm the gate
  // that watches for adjudication, or the cheapest way to purchase another window is to
  // countersign a counterparty that was never written.
  //
  // THIS CASE PINS THE FIX, NOT THE DEFECT. Before it, `foldLedgerEvents` destructured
  // `skipped` and never RETURNED it, so the consumer's exclusion read `undefined`, fell
  // back to an empty set, and excluded nothing: the orphan and the genuine log produced
  // BYTE-IDENTICAL verdicts, both `quiet`, where both should have refused. The falsifying
  // result is therefore named and reachable — with the exclusion inert this case reports
  // `lastAccepted` non-null and exit 0, which is exactly what it refuses to accept.
  check("acceptance/violation-an-ORPHAN-activation-(activates-a-proposal-that-does-not-exist)-does-NOT-move-the-anchor", () => {
    const orphan = (built) => ({ ...accActivation(built), activates: "rec_does_not_exist_000001" });
    const r = run(mkAcceptanceRepo({ events: accLog([...base, orphan]) }));
    if (r.code !== 2) {
      return `expected exit 2, got ${r.code} — a fold-SKIPPED activation bought a window of silence`;
    }
    if (!/the ACCEPTANCE CHANNEL has been silent for 90 day\(s\)/.test(r.err)) {
      return `refused for the WRONG reason: ${r.err.split("\n")[0].slice(0, 240)}`;
    }
    return /Last owner acceptance: NONE EVER/.test(r.err)
      ? true
      : `the refusal did not report the anchor as never-advanced: ${r.err.slice(0, 300)}`;
  });

  // THE DISARM SWITCH IS CLOSED BY THE SIGNATURE+ROSTER LAYER, NOT BY THE FIXTURE'S
  // CHOICE OF RECORDS. Without the two poles below, the pair above shows only that a
  // record THIS SUITE declined to write would have quieted the gate — which is a fact
  // about the fixture, not about the gate. Each of these takes the green pole's log and
  // changes ONE field of its activation.

  check("acceptance/violation-an-activation-claiming-AGENT-authority-is-REFUSED-by-the-log-itself", () => {
    // `validateEvent` refuses it, so it never reaches the fold and never reaches the
    // anchor — the build reports it as an unreadable line rather than folding around it.
    const events = accLog([...base, (built) => ({ ...accActivation(built), authority: "agent" })]);
    const r = run(mkAcceptanceRepo({ events }));
    if (r.code !== 2) return `expected exit 2, got ${r.code} — an agent-authored activation was accepted`;
    return /activation requires owner authority/.test(r.err)
      ? true
      : `wrong refusal: ${r.err.split("\n").slice(0, 2).join(" ").slice(0, 280)}`;
  });

  check("acceptance/violation-an-OWNER-activation-whose-signer-is-rostered-CONTRIBUTOR-is-REFUSED", () => {
    // The same bytes, the same real signature, one changed field IN THE ROSTER. This is
    // the pole that shows `authority` is not self-declared: the signature proves WHO
    // wrote it, and the committed roster is what proves they were entitled to.
    const r = run(mkAcceptanceRepo({ events: greenEvents, role: "contributor" }));
    if (r.code !== 2) return `expected exit 2, got ${r.code} — a contributor's owner claim was accepted`;
    return /authority not backed by role/.test(r.err) && /requires one of: owner/.test(r.err)
      ? true
      : `wrong refusal: ${r.err.split("\n").slice(0, 2).join(" ").slice(0, 280)}`;
  });

  check("acceptance/the-two-logs-differ-by-ONE-record-and-produce-OPPOSITE-verdicts", () => {
    // The non-vacuity check for the pair. If both poles agreed, the arm would carry no
    // information whichever way they agreed.
    if (redCode === null || greenCode === null) return "a pole did not run";
    const redLines = redEvents.trim().split("\n").length;
    const greenLines = greenEvents.trim().split("\n").length;
    if (greenLines !== redLines + 1) return `the logs differ by ${greenLines - redLines} records, not 1`;
    return redCode === 2 && greenCode === 0
      ? true
      : `verdicts were red=${redCode} green=${greenCode} — the extra record changed nothing`;
  });
}

// ── ARM 12 — nothing outstanding is NOT a stall ────────────────────────────

check("acceptance/compliant-NOTHING-OUTSTANDING-is-not-applicable-even-on-an-ANCIENT-armed_on", () => {
  // Same 90-day silence that refuses in arm 9. With every adjudicated item accepted the
  // channel has nothing to do, so its silence carries no information and must not be
  // scored as a stall — a gate that fires on a finished board is one that gets removed.
  const v = accVerdict({ acceptance: accNode(), register: ACC_REGISTER_DONE });
  if (v.code !== 0) return `expected exit 0, got ${v.code}: ${v.err.slice(0, 300)}`;
  return v.acceptance.state === "not-applicable" && v.acceptance.outstanding === 0
    ? true
    : `acceptance = ${JSON.stringify(v.acceptance)}`;
});

// ── ARM 13 — an ABSENT node is a THIRD verdict, printed, never clean ───────

check("acceptance/compliant-an-ABSENT-acceptance-node-BUILDS (this binary ships ahead of its manifests)", () => {
  const v = accVerdict({ acceptance: null });
  if (v.code !== 0) return `expected exit 0, got ${v.code}: ${v.err.slice(0, 300)}`;
  return v.acceptance.state === "absent" && v.acceptance.silentDays === null
    ? true
    : `acceptance = ${JSON.stringify(v.acceptance)}`;
});

check("acceptance/…and---check-links-PRINTS-that-absence-as-ABSENT-rather-than-staying-silent", () => {
  // The half that makes absence a verdict rather than a gap: a board running without the
  // gate SAYS SO on every run. Silence here would be indistinguishable from a checked and
  // quiet channel, which is how a dead block sits unnoticed for weeks.
  const r = run(mkAcceptanceRepo({ acceptance: null }), ["--check-links"]);
  if (r.code !== 0) return `--check-links exit ${r.code}: ${r.err.slice(0, 300)}`;
  const line = (r.out.match(/^ {2}ACCEPTANCE CHANNEL:.*$/m) || [""])[0];
  if (!/ACCEPTANCE CHANNEL: ABSENT/.test(line)) return `the ABSENT line was not printed; got ${JSON.stringify(line.slice(0, 200))}`;
  return /is an ABSENT result, not a clean one/.test(line)
    ? true
    : `the line did not distinguish absent from clean: ${line.slice(0, 240)}`;
});

// ── ARM 14 — a future arming date is the one edit that switches it off ─────

accRefuses(
  "acceptance/violation-an-armed_on-in-the-FUTURE-REFUSES (every field reads as populated)",
  { acceptance: accNode({ armed_on: isoDaysAgo(-5) }) },
  /which is in the FUTURE \(today is/,
);

check("acceptance/compliant-an-armed_on-of-TODAY-builds (the bound starts, it is not disabled)", () => {
  // The discrimination pole. Without it the refusal above is consistent with a check that
  // rejects any arming date at or after today, which would make the gate unarmable.
  const v = accVerdict({ acceptance: accNode({ armed_on: isoDaysAgo(0) }) });
  if (v.code !== 0) return `expected exit 0, got ${v.code}: ${v.err.slice(0, 300)}`;
  return v.acceptance.state === "quiet" && v.acceptance.silentDays === 0
    ? true
    : `acceptance = ${JSON.stringify(v.acceptance)}`;
});

// ── ARM 15 — the warning must PRECEDE the refusal it exists to precede ─────

accRefuses(
  "acceptance/violation-warn_after_days-EQUAL-to-refuse_after_days-REFUSES (a one-rung ladder)",
  { acceptance: accNode({ warn_after_days: 60, refuse_after_days: 60 }) },
  /declares acceptance\.warn_after_days 60 at or above refuse_after_days 60/,
);

accRefuses(
  "acceptance/violation-warn_after_days-ABOVE-refuse_after_days-REFUSES (the warning would arrive after)",
  { acceptance: accNode({ warn_after_days: 90, refuse_after_days: 60 }) },
  /declares acceptance\.warn_after_days 90 at or above refuse_after_days 60/,
);

// ── ARM 16 — the party a gate constrains cannot be the party that waives it ─

accRefuses(
  "acceptance/violation-accepted_by-naming-an-AGENT-REFUSES",
  { acceptance: accNode({ accepted_by: "the release agent" }) },
  /declares acceptance\.accepted_by "the release agent"/,
);

check("acceptance/compliant-accepted_by-naming-a-HUMAN-builds (the same field, a different party)", () => {
  const v = accVerdict({ acceptance: accNode({ armed_on: isoDaysAgo(10), accepted_by: "Ada Lovelace" }) });
  return v.code === 0 && v.acceptance.state === "quiet" ? true : `exit ${v.code}: ${(v.err || "").slice(0, 240)}`;
});

accRefuses(
  "acceptance/violation-a-NON-STRING-accepted_by-REFUSES (an unnamed party is not a named one)",
  { acceptance: accNode({ accepted_by: 42 }) },
  /declares acceptance\.accepted_by 42/,
);

accRefuses(
  "acceptance/violation-a-day-bound-BELOW-1-REFUSES (a bound of 0 refuses on the day it lands)",
  { acceptance: accNode({ warn_after_days: 0 }) },
  /declares acceptance\.warn_after_days 0; expected an integer in \[1, 365\]/,
);

accRefuses(
  "acceptance/violation-a-day-bound-ABOVE-365-REFUSES (a bound that bounds nothing, fully populated)",
  // The subtler end, and the reason the range is closed at both: every field stays
  // populated and a state still prints, while the silence the gate exists to catch can
  // never reach the bound. Same edit as a future `armed_on`, in the grammar of a
  // configured gate.
  { acceptance: accNode({ warn_after_days: 400, refuse_after_days: 500 }) },
  /declares acceptance\.warn_after_days 400; expected an integer in \[1, 365\]/,
);

accRefuses(
  "acceptance/violation-a-NON-INTEGER-day-bound-REFUSES",
  { acceptance: accNode({ refuse_after_days: 1.5 }) },
  /declares acceptance\.refuse_after_days 1\.5; expected an integer in \[1, 365\]/,
);

check("acceptance/compliant-day-bounds-at-BOTH-range-ENDS-build (1 and 365 are IN)", () => {
  // The inclusive-endpoint pole. Without it the three refusals above are equally
  // consistent with a range that rejects its own ends, which would make the tightest and
  // the loosest legal ladder both undeclarable.
  const v = accVerdict({ acceptance: accNode({ armed_on: isoDaysAgo(0), warn_after_days: 1, refuse_after_days: 365 }) });
  return v.code === 0 && v.acceptance.state === "quiet"
    ? true
    : `exit ${v.code}, acceptance=${JSON.stringify(v.acceptance)} ${(v.err || "").slice(0, 200)}`;
});

// ── ARM 17 — `armed_on` MAY NOT ADVANCE ON ITS OWN ──────────────────────────
//
// THE DEFECT THESE PIN. ARM 16's range bound closed a `refuse_after_days` above a year,
// and the comment on it claimed that closed "the one manifest edit that could disarm
// this gate while leaving it looking armed". It did not. `armed_on` was fenced only
// against being in the FUTURE, and nothing compared it to what it had been — so moving
// it FORWARD to today reset `silentDays` to 0, on a board one day from refusing, as many
// times as anyone cared to. Measured before the fix: the violation pole below exited 0.
// It is also the strictly CHEAPER edit of the two, and the quieter one: `refuse_after_days:
// 400` is conspicuous and answers to a range, while a date moving forward is
// indistinguishable in a diff from the legitimate first arming of a new board.
//
// EVERY POLE HERE NEEDS A REAL TWO-COMMIT HISTORY, because the value being defended is
// the PREVIOUS one and `loadManifest` holds the manifest to `assertCommittedAndUnmodified`
// — working tree and HEAD are byte-identical by construction, so the prior value exists
// nowhere but in git history. A fixture that re-armed in a single commit would be testing
// nothing.
{
  /** Re-arm the manifest in a SECOND commit, which is the only place a prior value lives. */
  const reArm = (dir, mutate) => {
    const mf = JSON.parse(fs.readFileSync(path.join(dir, "burndown-manifest.json"), "utf8"));
    mutate(mf);
    _commitFile(dir, "burndown-manifest.json", j(mf));
    return dir;
  };

  check("acceptance/violation-armed_on-ADVANCED-with-no-acceptance-REFUSES (the 59th-day reset)", () => {
    // Armed 90 days ago with nothing accepted: this board is 30 days past its own
    // refusal bound. The second commit moves the date to today, which takes `silentDays`
    // to 0 and every other check on this path back to quiet.
    const d = reArm(mkAcceptanceRepo({ acceptance: accNode({ armed_on: isoDaysAgo(90) }) }), (mf) => {
      mf.acceptance.armed_on = isoDaysAgo(0);
    });
    const r = run(d);
    if (r.code !== 2) return `expected exit 2, got ${r.code} — the re-arming bought another full budget`;
    if (!/ADVANCED acceptance\.armed_on from .* to /.test(r.err)) {
      return `refused for the WRONG reason: ${r.err.split("\n")[0].slice(0, 240)}`;
    }
    return /BURNDOWN:BEGIN/.test(r.out) ? "a refusal EMITTED A BLOCK on stdout" : true;
  });

  check("acceptance/compliant-…and the SAME advance after an OWNER ACTIVATION builds", () => {
    // THE DISCRIMINATION POLE. Byte-identical manifest history to the case above — same
    // two commits, same two dates — and the ONLY difference is that the log carries an
    // owner activation. That isolates the refusal to the UNJUSTIFIED advance rather than
    // to the manifest having been edited twice, and it demonstrates that the escape is
    // USING the channel rather than re-tuning a bound.
    const d = reArm(
      mkAcceptanceRepo({
        acceptance: accNode({ armed_on: isoDaysAgo(90) }),
        // An activation countersigns a PROPOSAL, so the proposal has to be there for the
        // anchor to move — an orphan activation folds to nothing (ARM 11's own poles).
        events: accLog([accGenesis(ACC_ITEM), accGenesis(ACC_ITEM_2), ACC_PROPOSAL, accActivation]),
      }),
      (mf) => {
        mf.acceptance.armed_on = isoDaysAgo(0);
      },
    );
    const r = run(d, ["--json"]);
    if (r.code !== 0) return `expected exit 0, got ${r.code}: ${r.err.split("\n")[0].slice(0, 240)}`;
    return JSON.parse(r.out).acceptance.state === "quiet" ? true : `acceptance=${r.out.slice(0, 200)}`;
  });

  check("acceptance/compliant-a-FIRST-arming-is-not-an-advance (the node did not exist before)", () => {
    // The live shape of every board adopting this gate, and the case that decides whether
    // "no prior value" is read as a violation. A manifest that carried NO acceptance node
    // and gains one must build — otherwise the fix bricks adoption on day one.
    const d = reArm(mkAcceptanceRepo({ acceptance: null }), (mf) => {
      mf.acceptance = accNode({ armed_on: isoDaysAgo(0) });
    });
    const r = run(d, ["--json"]);
    if (r.code !== 0) return `expected exit 0, got ${r.code}: ${r.err.split("\n")[0].slice(0, 240)}`;
    const a = JSON.parse(r.out).acceptance;
    // POSITIVE: the history WAS read and found no predecessor — not skipped, not failed.
    return a.state === "quiet" && a.armedOnCheck === "none" && a.armedOnPrior === null
      ? true
      : `acceptance=${JSON.stringify(a)}`;
  });

  check("acceptance/violation-DELETING-the-node-and-RE-ADDING-it-does-not-launder-the-advance", () => {
    // The two-commit bypass, and the reason the history walk does not stop at the first
    // revision with no acceptance node. Remove the node, commit; re-add it with today's
    // date, commit — and the re-arming wears the grammar of a first arming. It is refused
    // on the value it replaced THREE revisions back.
    const d = mkAcceptanceRepo({ acceptance: accNode({ armed_on: isoDaysAgo(90) }) });
    reArm(d, (mf) => {
      delete mf.acceptance;
    });
    reArm(d, (mf) => {
      mf.acceptance = accNode({ armed_on: isoDaysAgo(0) });
    });
    const r = run(d);
    if (r.code !== 2) return `expected exit 2, got ${r.code} — a delete-and-re-add laundered the re-arming`;
    return /ADVANCED acceptance\.armed_on from .* to /.test(r.err)
      ? true
      : `refused for the WRONG reason: ${r.err.split("\n")[0].slice(0, 240)}`;
  });

  check("acceptance/compliant-moving-armed_on-BACKWARD-is-not-refused-by-this-gate (it fires SOONER)", () => {
    // DIRECTIONAL, and this pole is what says so. A date moved backward lengthens the
    // measured silence, so it can only make the channel refuse earlier — there is nothing
    // to defend against. This repo DOES refuse, and the assertion is that it refuses for
    // the SILENCE it now measures and not for the edit, which is the difference between a
    // monotonicity gate and a no-edits-allowed gate.
    const d = reArm(mkAcceptanceRepo({ acceptance: accNode({ armed_on: isoDaysAgo(10) }) }), (mf) => {
      mf.acceptance.armed_on = isoDaysAgo(90);
    });
    const r = run(d);
    if (r.code !== 2) return `expected exit 2 (90 days silent, bound 60), got ${r.code}`;
    if (/ADVANCED acceptance\.armed_on/.test(r.err)) return "refused as an ADVANCE — the gate is not directional";
    return /the ACCEPTANCE CHANNEL has been silent for 90 day\(s\)/.test(r.err)
      ? true
      : `refused for a third reason: ${r.err.split("\n")[0].slice(0, 240)}`;
  });
}

// ── ARM 18 — ONE predicate decides whether an `accepted_by` names an agent ──
//
// THE DEFECT THESE PIN. Three sites asked that question and no two agreed: the log
// validator matched its four-word vocabulary EXACTLY, `migration_baseline` compared
// CASE-SENSITIVELY against two of the four, and the acceptance channel tested
// `/\bagent\b/i` under a comment claiming it held "the same standard" as
// `migration_baseline`. Measured, that claim was false in BOTH directions — and these two
// cases are the two directions. Both exited 0 before the consolidation.

accRefuses(
  "acceptance/violation-accepted_by-'assistant'-REFUSES (accepted here, refused by the log validator)",
  { acceptance: accNode({ accepted_by: "assistant" }) },
  /declares acceptance\.accepted_by "assistant"/,
);

check("coverage/a-migration_baseline-accepted-by-'the agent'-is-REFUSED (the other direction)", () => {
  // The mirror of the case above: `=== "agent"` admitted anything with a word beside it,
  // so the phrase the acceptance channel already refused sailed through here.
  const d = mkCoverageRepo({ inventory: { _doc: { items: [{ id: "X1-alpha-item" }, { id: "GH-9001-orphan" }] } } });
  const mf = JSON.parse(fs.readFileSync(path.join(d, "burndown-manifest.json"), "utf8"));
  mf.inventory.migration_baseline = {
    reason: "r",
    expires: "2099-01-01",
    accepted_by: "the agent",
    uncovered_ids: ["GH-9001-orphan"],
  };
  _commitFile(d, "burndown-manifest.json", j(mf));
  const r = run(d, ["--check-links"]);
  return r.code === 2 && /cannot also accept it/.test(r.err) ? true : `exit ${r.code}: ${r.err.slice(0, 240)}`;
});

check("acceptance/compliant-a-HUMAN-name-CONTAINING-a-refused-word-as-a-substring-builds", () => {
  // THE NO-FALSE-POSITIVE POLE, and the one that bounds the widening. The shared
  // predicate matches WORDS, not substrings: "Kai" contains "ai" and "Aisha" contains
  // "ai", and neither names an agent. Without this case the arm above is equally
  // consistent with a substring match that would refuse a real person's name — the
  // failure that gets a gate switched off rather than fixed.
  const v = accVerdict({ acceptance: accNode({ armed_on: isoDaysAgo(10), accepted_by: "Kai Aisha Nakamura" }) });
  return v.code === 0 && v.acceptance.state === "quiet" ? true : `exit ${v.code}: ${(v.err || "").slice(0, 240)}`;
});

// ── ARM 18b — AN OWNER ACTIVATION LANDS AND THE RENDERED BOARD IS BYTE-IDENTICAL ──
//
// THE DEFECT THESE PIN, measured 2026-09-15 in the operator's MAIN checkout
// (`~/repos/loom`) and NOT in the tree that ships these cases — this branch forked from
// `dev` before the activation, so `grep -c '"kind":"activation"' burndown/events.jsonl`
// returns 0 here. The cases below do NOT depend on that record: each builds its own
// signed fixture log, so they are the re-derivable form of the same state. The owner
// countersigned
// `F91-remove-nested-worktrees` to `Signed off`. The activation was honoured — the fold
// took it and `--check-links` dropped PENDING COUNTERSIGNATURE to 0 — and the `Signed
// off` cell was BYTE-IDENTICAL afterwards, still 0 of 26 AS MEASURED ON 2026-09-15.
//
// THAT FIGURE IS DELIBERATELY NOT A QUOTE TOKEN, and the de-quoting is the fix rather
// than an evasion of the guard that found it. It carried a live quote token until
// 2026-09-17, when `burndown-quote-write-guard.js` red-ed a durable write to this file
// with "token ... is not produced by the current block". The guard was RIGHT and its remedy —
// "re-quote from the block" — was written for a LIVE figure. This is not one: it is a
// HISTORICAL measurement in a narrative about what was observed on a named date, so
// re-quoting it against today's block would have replaced a true statement about
// 2026-09-15 with today's digest attached to a past observation. A live-quote token on a
// past measurement re-validates forever and is guaranteed to go stale, which is the
// false RED that gets a guard switched off. The figure now carries its STATE instead
// (`instrument-discipline.md` MUST-6), which is what a restated measurement owes.
//
// ⛔ DO NOT REPRODUCE THE OLD TOKEN LITERALLY ANYWHERE IN THIS FILE, INCLUDING HERE.
// The guard scans the WHOLE file for the `<count>⟨<hex>⟩` shape; it does not care that
// an occurrence sits inside a comment explaining why the token was removed. The first
// attempt at this very note quoted it verbatim and red-ed the guard a second time on
// the edit that was removing it — the defensive addition being the defect, which is the
// pattern this fixture tree has now measured six times. Describe the token; never spell
// it. (The bare hex without the ⟨⟩ wrapper does NOT match, but do not rely on that.)
//
// In the SAME output
// the channel dated an owner acceptance to that day while reporting `26 of 26
// adjudicated item(s) unaccepted`.
//
// Neither sentence was wrong. They are two reads of two different FILES: `lastAccepted`
// counts activation RECORDS in the tracker log, `signedOff` counts BOARD ITEMS whose
// status came from a declared `sources[]` file, and nothing joins them. So no output
// either surface could produce would have revealed the divergence — the whole suite was
// green while an owner's signature reached nothing. That is an ABSENT instrument
// (`instrument-discipline.md` MUST-3(a)), and the only way to close it is to build the
// join and prove it FIRES.
//
// WHY THE EXISTING ARM-18 CASES DO NOT COVER THIS. They stop at `--json .acceptance`
// and never read a rendered row; the one that comes closest
// (`…an OWNER ACTIVATION DOES move the anchor…`) asserts `outstanding === 2`, which is
// this very defect pinned as correct — incidentally, as pole hygiene, never as a
// decision. These cases read the RENDERED board and the LANDING line together.

/** The live shape: an owner activation for ACC_ITEM, whose register row still says otherwise. */
const ACC_LOG_ACTIVATED = () =>
  accLog([accGenesis(ACC_ITEM), accGenesis(ACC_ITEM_2), ACC_PROPOSAL, accActivation]);

check("acceptance/violation-an-OWNER-ACTIVATION-that-never-reached-the-board-is-NAMED (the F91 state)", () => {
  // THE RED POLE. Everything the ceremony can do has been done: proposal appended,
  // owner countersignature appended under a rostered owner role, log signed and
  // committed. The register still carries `In progress`. Before the join existed this
  // state rendered as a clean board plus a dated acceptance.
  const d = mkAcceptanceRepo({ events: ACC_LOG_ACTIVATED() });
  const r = run(d, ["--check-links"]);
  if (r.code !== 0) return `expected exit 0, got ${r.code}: ${r.err.split("\n")[0].slice(0, 240)}`;
  if (!/ACCEPTANCE LANDING: 1 of 1 owner acceptance\(s\) DID NOT REACH THE BOARD/.test(r.out)) {
    return `the landing join did not fire: ${(r.out.match(/ACCEPTANCE LANDING:.*/) || ["(absent)"])[0].slice(0, 300)}`;
  }
  // It must name all four facts an operator needs to act: the item, what was accepted,
  // what is rendered instead, and the FILE whose bytes decide the cell. A finding that
  // reports only "they disagree" sends the reader back to the search this closes.
  for (const [what, rx] of [
    ["the item", new RegExp(ACC_ITEM)],
    ["the accepted status", /accepted 'Signed off'/],
    ["the acceptor", /by Ada Lovelace/],
    ["the rendered status", /renders 'In progress'/],
    ["the source file to edit", /from burndown\/register\.json/],
  ]) {
    if (!rx.test(r.out)) return `the finding does not name ${what} (${rx})`;
  }
  return true;
});

check("acceptance/violation-…and the RENDERED board is BYTE-IDENTICAL to the un-activated one", () => {
  // THE CONSERVATION HALF, and the reason this arm exists at all. The assertion is on
  // the RENDERED bytes, not on a JSON field: the two boards are built from logs that
  // differ by an owner countersignature, and every cell comes out the same. Reading
  // `--json .acceptance` — which is all ARM 18 ever did — cannot see this, because the
  // field that moves is not the field that renders.
  // BOTH poles take a RECENT arming, so the only difference between the two repos is
  // the owner countersignature. Under the default 90-day arming the un-activated pole
  // REFUSES and the activated one builds — a real finding, but a different one, pinned
  // by the disarm case above; letting it land here would make this case about the clock.
  const recent = { acceptance: accNode({ armed_on: isoDaysAgo(10) }) };
  const withAct = run(mkAcceptanceRepo({ ...recent, events: ACC_LOG_ACTIVATED() }));
  const without = run(mkAcceptanceRepo(recent));
  if (withAct.code !== 0 || without.code !== 0) {
    return `a build refused (activated=${withAct.code}, plain=${without.code}): ${(withAct.err || without.err).split("\n")[0].slice(0, 240)}`;
  }
  const a = allPagesRow(withAct.out);
  const b = allPagesRow(without.out);
  if (a === null || b === null) return `could not read an ALL PAGES row (activated=${a !== null}, plain=${b !== null})`;
  if (a.signedOff !== b.signedOff) {
    // If this ever fires, the board has GAINED a status channel from the event log and
    // this whole arm needs re-deciding — loudly, not by a quiet green.
    return `the board MOVED on an activation (signedOff ${b.signedOff} → ${a.signedOff}). The event log has become a status source; ARM 18b and burndown-traceability.md MUST-4 both need re-deciding.`;
  }
  return JSON.stringify(a) === JSON.stringify(b)
    ? true
    : `the rendered rows differ in some OTHER column, which this case did not predict: ${JSON.stringify(b)} → ${JSON.stringify(a)}`;
});

check("acceptance/compliant-an-acceptance-the-register-DOES-carry-is-reported-as-LANDED", () => {
  // THE GREEN POLE. The SAME activation against a register that carries `Signed off`.
  // Without it the red pole above is equally consistent with a join that fires on every
  // activation whatever the board says — an instrument that cannot return the other
  // verdict (`instrument-discipline.md` MUST-1).
  const d = mkAcceptanceRepo({ register: ACC_REGISTER_DONE, events: ACC_LOG_ACTIVATED() });
  const r = run(d, ["--check-links"]);
  if (r.code !== 0) return `expected exit 0, got ${r.code}: ${r.err.split("\n")[0].slice(0, 240)}`;
  if (/DID NOT REACH THE BOARD/.test(r.out)) return "the join fired on an acceptance the board DOES carry";
  return /ACCEPTANCE LANDING: all 1 owner acceptance\(s\)/.test(r.out)
    ? true
    : `wanted the landed verdict, got: ${(r.out.match(/ACCEPTANCE LANDING:.*/) || ["(absent)"])[0].slice(0, 300)}`;
});

check("acceptance/compliant-ZERO-acceptances-reports-ABSENT-and-NOT-the-landed-verdict", () => {
  // THE VACUITY POLE. "Every acceptance landed" is TRUE of an empty set, so a board
  // where the channel has NEVER fired would otherwise render identically to one where
  // every signature reached its cell — the same output for opposite facts, which is the
  // failure this whole file is about. The denominator is what separates them.
  // A RECENT arming, because the default 90-day one REFUSES before any of this renders
  // — and the refusal is a DIFFERENT finding (see the disarm case below), not this one.
  const r = run(mkAcceptanceRepo({ acceptance: accNode({ armed_on: isoDaysAgo(10) }) }), ["--check-links"]);
  if (r.code !== 0) return `expected exit 0, got ${r.code}: ${r.err.split("\n")[0].slice(0, 240)}`;
  if (/all \d+ owner acceptance\(s\)/.test(r.out)) return "an EMPTY acceptance set rendered as the LANDED verdict";
  return /ACCEPTANCE LANDING: 0 owner acceptance\(s\).*examined NOTHING.*ABSENT result, not a clean one/s.test(r.out)
    ? true
    : `wanted the ABSENT verdict, got: ${(r.out.match(/ACCEPTANCE LANDING:.*/) || ["(absent)"])[0].slice(0, 300)}`;
});

check("acceptance/violation-an-activation-DISARMS-the-refusal-without-draining-the-count", () => {
  // THE FORCING FUNCTION, DEFEATED BY THE ACTION IT DEMANDS — and this is the case that
  // makes the divergence undeniable, because the two repos differ by NOTHING except the
  // owner countersignature. `burndown-manifest.json::_acceptance_note` claims "the
  // channel is cleared by USING it"; MEASURED, using it clears the CLOCK and not the
  // COUNT. The gate exists to force `signedOff` upward and can be silenced for a fresh
  // 60 days without moving it at all.
  const staleArming = { acceptance: accNode({ armed_on: isoDaysAgo(90) }) };
  const without = run(mkAcceptanceRepo(staleArming));
  const withAct = run(mkAcceptanceRepo({ ...staleArming, events: ACC_LOG_ACTIVATED() }));
  if (without.code !== 2) return `the un-activated board should REFUSE at 90 days silent, got exit ${without.code}`;
  if (!/ACCEPTANCE CHANNEL has been silent/.test(without.err)) {
    return `it refused for the wrong reason: ${without.err.split("\n")[0].slice(0, 240)}`;
  }
  if (withAct.code !== 0) {
    // If this ever fires the disarm has been closed — re-decide this case, loudly.
    return `the activation no longer disarms the refusal (exit ${withAct.code}). That is the FIX landing; re-decide ARM 18b.`;
  }
  const all = allPagesRow(withAct.out);
  if (all === null) return "could not read an ALL PAGES row from the activated build";
  if (all.signedOff !== 0) {
    return `the activation DRAINED the count (signedOff ${all.signedOff}). The event log has become a status source; ARM 18b needs re-deciding.`;
  }
  // The refusal is gone, the count has not moved, and the LANDING line is what now says so.
  return /DID NOT REACH THE BOARD/.test(run(mkAcceptanceRepo({ ...staleArming, events: ACC_LOG_ACTIVATED() }), ["--check-links"]).out)
    ? true
    : "the disarm is silent — nothing named the acceptance that did not reach the board";
});

check("acceptance/compliant-a-fold-REFUSED-activation-is-NOT-counted-as-an-owner-acceptance", () => {
  // THE `honouredSkips` GUARD, which no case asserted until now — found by an
  // adversarial review, whose mutation (dropping the guard) came back with an EMPTY
  // red-set. An empty red-set is UNRESOLVED, never a vacuity verdict
  // (`instrument-discipline.md` MUST-5(b)), and the resolution was that the guard was
  // simply unasserted: dropping it DID change observable output, it was just that
  // nothing looked. This is the security-relevant line — without it, an activation the
  // fold REFUSED would be reported as a genuine owner acceptance that failed to land,
  // which is an un-countersigned decision entering the operator's remediation list.
  const orphan = {
    kind: "activation",
    item_id: ACC_ITEM,
    item: "an alpha item",
    value_anchor: `${ACC_ANCHOR_FILE}#${ACC_ITEM}`,
    status: "Signed off",
    authority: "owner",
    source: "fixture",
    activates: "rec_no_such_proposal_000000",
    accepted_by: "Ada Lovelace",
  };
  const d = mkAcceptanceRepo({
    acceptance: accNode({ armed_on: isoDaysAgo(10) }),
    events: accLog([accGenesis(ACC_ITEM), accGenesis(ACC_ITEM_2), orphan]),
  });
  const r = run(d, ["--check-links"]);
  if (r.code !== 0) return `expected exit 0, got ${r.code}: ${r.err.split("\n")[0].slice(0, 240)}`;
  if (/DID NOT REACH THE BOARD/.test(r.out)) {
    return "a fold-REFUSED (orphan) activation was reported as a real owner acceptance that did not land";
  }
  return /ACCEPTANCE LANDING: 0 owner acceptance\(s\)/.test(r.out)
    ? true
    : `wanted the refused activation excluded, got: ${(r.out.match(/ACCEPTANCE LANDING:.*/) || ["(absent)"])[0].slice(0, 300)}`;
});

check("acceptance/violation-a-SUPERSEDED-acceptance-does-NOT-contradict-the-owner's-later-one", () => {
  // Found by adversarial review. Supersession is recorded in `folded.superseded[]`, NOT
  // in `skipped[]`, so a join over EVERY activation compares an OLD acceptance against
  // the CURRENT cell. The remedy it printed would have REVERSED the owner's own later
  // decision — worse than noise. Two owner adjudications for one item is ordinary:
  // `OWNER_STATUSES` has five members.
  const first = (built) => ({
    kind: "activation",
    item_id: ACC_ITEM,
    item: "an alpha item",
    value_anchor: `${ACC_ANCHOR_FILE}#${ACC_ITEM}`,
    status: "In progress",
    authority: "owner",
    source: "fixture",
    activates: built[built.length - 1].id,
    accepted_by: "Ada Lovelace",
  });
  const secondProposal = { ...ACC_PROPOSAL, reason: "the owner walked it and accepted it outright" };
  const d = mkAcceptanceRepo({
    register: ACC_REGISTER_DONE,
    acceptance: accNode({ armed_on: isoDaysAgo(10) }),
    events: accLog([accGenesis(ACC_ITEM), accGenesis(ACC_ITEM_2), ACC_PROPOSAL, first, secondProposal, accActivation]),
  });
  const r = run(d, ["--check-links"]);
  if (r.code !== 0) return `expected exit 0, got ${r.code}: ${r.err.split("\n")[0].slice(0, 240)}`;
  if (/accepted 'In progress'/.test(r.out)) {
    return "the SUPERSEDED acceptance was reported as unlanded — acting on it would reverse the owner's later decision";
  }
  // One item, two acceptances, one winner: the denominator counts ITEMS joined, not records.
  return /ACCEPTANCE LANDING: all 1 owner acceptance\(s\)/.test(r.out)
    ? true
    : `wanted the LAST acceptance to win, got: ${(r.out.match(/ACCEPTANCE LANDING:.*/) || ["(absent)"])[0].slice(0, 300)}`;
});

check("acceptance/violation-a-CASE-VARIANT-status-is-NOT-a-divergence (one shared statusKey)", () => {
  // Found by adversarial review. The two sides are validated under DIFFERENT
  // equalities: a board status is checked case-SENSITIVELY, an activation's through
  // `statusKey` (NFKC + whitespace-collapse + case-fold). So 'signed off' is a VALID
  // activation status that raw `===` reports as diverging from a board cell reading
  // 'Signed off' — a false finding naming a file that already carries the right value.
  // Producer-reachable: `propose` passes `--status` to `buildEvent` verbatim.
  const lower = (built) => ({ ...accActivation(built), status: "signed off" });
  const prop = { ...ACC_PROPOSAL, proposed_status: "signed off" };
  const d = mkAcceptanceRepo({
    register: ACC_REGISTER_DONE,
    acceptance: accNode({ armed_on: isoDaysAgo(10) }),
    events: accLog([accGenesis(ACC_ITEM), accGenesis(ACC_ITEM_2), prop, lower]),
  });
  const r = run(d, ["--check-links"]);
  if (r.code !== 0) return `expected exit 0, got ${r.code}: ${r.err.split("\n")[0].slice(0, 240)}`;
  return /DID NOT REACH THE BOARD/.test(r.out)
    ? `a case-variant of the SAME status was reported as a divergence: ${(r.out.match(/ {4}R1.*/) || [""])[0].slice(0, 240)}`
    : true;
});

check("acceptance/violation-an-acceptance-for-an-id-NO-source-declares-is-NAMED-not-dropped", () => {
  // Found by adversarial review, and it was the original defect one step over. An
  // earlier revision DROPPED these before the denominator on the stated ground that
  // LINK-1 already reported them "with a better diagnosis" — MEASURED FALSE: LINK-1
  // walks BOARD ITEMS → events, so nothing walks the reverse direction and no finding
  // fired anywhere, while the anchor still advanced and bought a fresh silence window.
  // The join then returned its most REASSURING state on the input most needing a
  // finding. Reachable through the sanctioned producer, which gates `propose` on the
  // EVENT LOG rather than the board.
  const ghost = "R9-not-on-any-board";
  const ghostProp = {
    kind: "proposal",
    item_id: ghost,
    item: "an item no source declares",
    value_anchor: `${ACC_ANCHOR_FILE}#${ghost}`,
    status: ACC_EVENTS.PROPOSAL_STATUS,
    authority: "agent",
    source: "fixture",
    reason: "proposable because propose() gates on the log, not the board",
    proposed_status: "Signed off",
  };
  const ghostAct = (built) => ({
    kind: "activation",
    item_id: ghost,
    item: "an item no source declares",
    value_anchor: `${ACC_ANCHOR_FILE}#${ghost}`,
    status: "Signed off",
    authority: "owner",
    source: "fixture",
    activates: built[built.length - 1].id,
    accepted_by: "Ada Lovelace",
  });
  const d = mkAcceptanceRepo({
    acceptance: accNode({ armed_on: isoDaysAgo(10) }),
    events: accLog([accGenesis(ACC_ITEM), accGenesis(ACC_ITEM_2), accGenesis(ghost), ghostProp, ghostAct]),
  });
  const r = run(d, ["--check-links"]);
  if (r.code !== 0) return `expected exit 0, got ${r.code}: ${r.err.split("\n")[0].slice(0, 240)}`;
  if (/examined NOTHING/.test(r.out)) return "an off-board acceptance rendered as the ABSENT verdict — dropped, not reported";
  if (!/ACCEPTANCE LANDING: 1 of 1 owner acceptance\(s\) DID NOT REACH THE BOARD/.test(r.out)) {
    return `the off-board acceptance was not counted: ${(r.out.match(/ACCEPTANCE LANDING:.*/) || ["(absent)"])[0].slice(0, 300)}`;
  }
  // It must NOT offer an edit target, because there is no file to edit.
  return /NO source\[\] file declares this id, so this board carries no cell for it/.test(r.out)
    ? true
    : `the finding did not name the off-board cause: ${(r.out.match(/ {4}R9.*/) || [""])[0].slice(0, 300)}`;
});

check("acceptance/compliant-the-two-quantities-NAME-their-sources-in-the-same-sentence", () => {
  // The reporting half. `26 of 26 unaccepted` and `Last owner acceptance <date>` were
  // printed adjacently with no marker that they read different files, and an operator
  // correctly read that as self-contradictory. Each must now carry its source.
  const r = run(mkAcceptanceRepo({ events: ACC_LOG_ACTIVATED() }), ["--check-links"]);
  if (r.code !== 0) return `expected exit 0, got ${r.code}: ${r.err.split("\n")[0].slice(0, 240)}`;
  const line = (r.out.match(/ {2}ACCEPTANCE CHANNEL:.*/) || [""])[0];
  if (!/unaccepted \(board items, from the declared sources\[\]\)/.test(line)) {
    return `the unaccepted count does not name its population: ${line.slice(0, 300)}`;
  }
  return /Last owner acceptance \d{4}-\d{2}-\d{2} \(a record in burndown\/events\.jsonl\)/.test(line)
    ? true
    : `the acceptance date does not name its source: ${line.slice(0, 300)}`;
});

// ── ARM 19 — an empty `--reground` write has TWO causes, and they are opposite ──
//
// THE DEFECT THESE PIN. `bankMeasurements` filters to the named subject, so an empty
// result was returned BOTH when that subject already matched the record and when the
// subject was never measured at all — and the caller printed "every measurement already
// matches the committed record" for both. A typo in the path therefore read as a clean
// bill of health for the WHOLE board, which is an empty outcome in the grammar of a
// completed one (`conservation-gate.md` MUST-4). It is the same failure the argument
// parser already refuses for a BARE `--reground`, one branch over.

floorRefuses(
  "floors/violation---reground-naming-an-UNMEASURED-subject-REFUSES (a typo is not 'already current')",
  { observed: 37, members: 37, frac: 0.25 },
  /--reground --subject burndown\/typo\.json measured NOTHING/,
  ["--reground", "--subject", "burndown/typo.json", "--reason", REGROUND_REASON_TEXT],
);

check("floors/compliant-…and a MEASURED subject that already matches reports ITSELF, not the board", () => {
  // The discrimination pole, and the assertion is on the SCOPE of the claim rather than
  // on the exit code: the same empty write, from a subject that really was measured,
  // must say which subject it is talking about and must NOT generalise to "every
  // measurement". A second source sits at a DIFFERENT reading in the same repo, so the
  // over-broad sentence would be false on this very tree.
  const d = mkFloorRepo({ observed: 37, members: 37, frac: 0.25, second: { observed: 95, members: 80 } });
  const r = run(d, ["--reground", "--subject", "burndown/live.json", "--reason", REGROUND_REASON_TEXT]);
  if (r.code !== 0) return `expected exit 0, got ${r.code}: ${r.err.split("\n")[0].slice(0, 240)}`;
  if (!/burndown\/live\.json was measured and its count already matches/.test(r.out)) {
    return `the report did not name the subject: ${r.out.slice(0, 240)}`;
  }
  return /every measurement already matches/.test(r.out)
    ? "the report still generalises to EVERY measurement while a sibling reads 80 against 95"
    : true;
});

// ── helpers ─────────────────────────────────────────────────────────────────
function _clone(o) {
  return JSON.parse(JSON.stringify(o));
}
function _commitFile(dir, rel, body) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "mutate"], { cwd: dir, stdio: "ignore" });
}

console.log("");
console.log(`burndown-integrity fixtures: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failing: ${failures.join(", ")}`);
  process.exit(1);
}
