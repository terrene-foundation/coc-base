#!/usr/bin/env node
/**
 * unlanded-ratchet-axis — bipolar fixtures for the carry-span axis added to
 * `.claude/hooks/lib/unlanded-work-surface.js` for loom#1912.
 *
 * WHAT IS UNDER TEST, and why a one-sided fixture would have passed the DEFECT
 * ---------------------------------------------------------------------------
 * The pre-#1912 surface listed a branch iff `ageDays > RECENT_DAYS`. A fixture
 * asserting only "a 40-day-old branch is listed" passes against BOTH the broken
 * predicate and the fixed one, so it carries no information about the repair.
 * The defect lived entirely in the OTHER pole — a branch touched today.
 *
 * So the contract here is a POLE PAIR (`instrument-bipolarity.md` MUST-1/2) over
 * two fixtures that are IDENTICAL on the axis the old predicate could read:
 *
 *   RED   `feat/ratchet`  — tip committed NOW, oldest unlanded commit 3d old.
 *   GREEN `feat/inflight` — tip committed NOW, oldest unlanded commit 2h old.
 *
 * Both have `ageDays === 0`. Under the OLD predicate their verdicts are
 * IDENTICAL (both suppressed), which is the defect stated as a measurement
 * rather than as prose. Under the NEW predicate they DIFFER. The harness asserts
 * the difference explicitly (`pair:verdicts-differ`) rather than asserting each
 * pole in isolation, because two independently-passing assertions do not
 * establish that the instrument DISCRIMINATES — only comparing them does.
 *
 * The RED pole asserts a failure IDENTITY, never a count: the branch NAME must
 * appear in `summary.ratchets` and in the rendered block. A count-only assertion
 * ("ratchetCount === 1") is satisfiable by listing the WRONG branch, which is
 * the exact confusion that produced #1912 — a number that moved while the row
 * that mattered stayed hidden.
 *
 * REAL GIT, NOT A HAND-BUILT OBJECT. Every case builds an actual repository with
 * real commits at controlled author/committer dates and drives the shipped
 * `computeUnlandedState` end to end. A fixture that fed a synthetic `carry` map
 * would test this file's arithmetic and never test the `rev-list --parents
 * --format=%at` parse, which is where a git-version behaviour change would land.
 * The summary-level cases that DO inject a map are labelled `unit:` and exist
 * only for states real git cannot be made to produce on demand.
 *
 * GPG: every temp repo sets `commit.gpgsign=false`. Unpinned signing is the
 * loom#1903 flake ("gpg: signing failed: Cannot allocate memory" under
 * concurrency) and this runner must not import it.
 *
 * Output grammar is `PASS <name>` / `FAIL <name>` per
 * `.claude/bin/run-audit-fixtures.mjs`; the EXIT CODE is the gate.
 */

import "../_lib/no-ambient-git.cjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const SURFACE = join(
  REPO_ROOT,
  ".claude",
  "hooks",
  "lib",
  "unlanded-work-surface.js",
);

const require_ = createRequire(import.meta.url);
const surface = require_(SURFACE);
const {
  computeUnlandedState,
  computeUnlandedSummary,
  computeCarrySpans,
  resolveBaseRef,
  getUnmergedBranches,
  formatUnlandedBlock,
  RATCHET_SPAN_DAYS,
  RECENT_DAYS,
} = surface;

// ── harness ──────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const cleanups = [];

function ok(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(name, actual, expected) {
  ok(
    name,
    Object.is(actual, expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

// ── git scaffolding ──────────────────────────────────────────────────────────
const HOUR = 3600;
const DAY = 86400;

function git(cwd, args, extraEnv = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
}

function isoOf(epochSecs) {
  return new Date(epochSecs * 1000).toISOString();
}

/**
 * Init a repo with one base commit and a synthetic `refs/remotes/origin/main`
 * pointing at it. No network: the remote ref is written directly, which is what
 * `resolveBaseRef` reads. `main` is checked out and left AT the base, so every
 * branch below is genuinely unlanded relative to it.
 */
function mkRepo(label) {
  const dir = mkdtempSync(join(tmpdir(), `s54-ratchet-${label}-`));
  cleanups.push(dir);
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "fixture@example.invalid"]);
  git(dir, ["config", "user.name", "fixture"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["config", "tag.gpgsign", "false"]);
  commit(dir, "base.txt", "base", nowSecs() - 40 * DAY);
  const baseSha = git(dir, ["rev-parse", "HEAD"]).trim();
  git(dir, ["update-ref", "refs/remotes/origin/main", baseSha]);
  return { dir, baseSha };
}

function nowSecs() {
  return Math.floor(Date.now() / 1000);
}

/** Commit `file` with BOTH dates controlled, or author/committer split. */
function commit(dir, file, body, authorSecs, committerSecs = null) {
  writeFileSync(join(dir, file), `${body}\n`);
  git(dir, ["add", file]);
  git(dir, ["commit", "--quiet", "-m", body], {
    GIT_AUTHOR_DATE: isoOf(authorSecs),
    GIT_COMMITTER_DATE: isoOf(committerSecs == null ? authorSecs : committerSecs),
  });
}

function branchFrom(dir, base, name) {
  git(dir, ["checkout", "--quiet", "-b", name, base]);
}

/** Drive the SHIPPED end-to-end path against a real repo. */
function stateOf(dir) {
  return computeUnlandedState(dir, []);
}

/** The one verdict the surface publishes about a branch: listed, or not. */
function verdictFor(summary, name) {
  if (!summary) return "UNDETERMINED";
  if (summary.ratchets.some((r) => r.name === name)) return "LISTED_RATCHET";
  if (summary.listed.some((r) => r.name === name)) return "LISTED_AGED";
  return "SUPPRESSED";
}

// ─────────────────────────────────────────────────────────────────────────────
// THE POLE PAIR
// ─────────────────────────────────────────────────────────────────────────────
function polePair() {
  const now = nowSecs();
  const { dir, baseSha } = mkRepo("pair");

  // RED — a ratchet. Written to minutes ago, but carrying work first authored
  // three days back: 33 commits' worth of shape, compressed to three so the
  // fixture stays fast. Committer date of the TIP is now, so ageDays === 0 and
  // the age floor alone would suppress it. This is the measured shape of
  // codify/someoperator-2026-08-20.
  branchFrom(dir, baseSha, "feat/ratchet");
  commit(dir, "r1.txt", "ratchet first", now - 3 * DAY);
  commit(dir, "r2.txt", "ratchet second", now - 2 * DAY);
  commit(dir, "r3.txt", "ratchet tip", now - 120);

  // GREEN — genuine in-flight work. Same ageDays (tip minutes old), but all of
  // its unlanded work was authored within the last two hours.
  branchFrom(dir, baseSha, "feat/inflight");
  commit(dir, "i1.txt", "inflight first", now - 2 * HOUR);
  commit(dir, "i2.txt", "inflight second", now - 1 * HOUR);
  commit(dir, "i3.txt", "inflight tip", now - 120);

  git(dir, ["checkout", "--quiet", "main"]);

  const s = stateOf(dir);
  ok("pair:state-computed", Boolean(s), `computeUnlandedState returned ${s}`);
  if (!s) return;

  eq("pair:ratchet-axis-ran", s.ratchetKnown, true);

  // --- the two poles are IDENTICAL on the axis the old predicate could read ---
  const red = s.ratchets.find((r) => r.name === "feat/ratchet") || null;
  const greenAge = (
    getUnmergedBranches(dir, resolveBaseRef(dir)) || []
  ).find((b) => b.name === "feat/inflight");
  ok(
    "pair:both-poles-are-age-suppressed-equally",
    red !== null && red.ageDays === 0 && Boolean(greenAge),
    "the pair is only meaningful if the OLD axis cannot separate them",
  );

  // --- RED pole: LISTED, by IDENTITY ---
  ok(
    "pair:RED-ratchet-is-listed-by-name",
    red !== null,
    `feat/ratchet absent from ratchets: ${JSON.stringify(s.ratchets.map((r) => r.name))}`,
  );
  ok(
    "pair:RED-carries-span-at-or-over-threshold",
    red !== null && red.spanDays >= RATCHET_SPAN_DAYS,
    `spanDays=${red && red.spanDays} threshold=${RATCHET_SPAN_DAYS}`,
  );
  eq("pair:RED-commit-count-is-reachability-figure", red && red.commits, 3);

  const block = formatUnlandedBlock(s);
  ok(
    "pair:RED-name-reaches-the-rendered-block",
    typeof block === "string" && block.includes("feat/ratchet"),
    "a summary field the operator never sees is not a surfaced finding",
  );
  ok(
    "pair:RED-block-names-the-reason-not-just-the-row",
    typeof block === "string" &&
      /carrying unlanded work for \d+d/.test(block) &&
      /RATCHET/.test(block),
    "the row must carry WHY it is listed",
  );
  ok(
    "pair:RED-commit-figure-labelled-upper-bound",
    typeof block === "string" && /UPPER BOUND/.test(block),
    "reachability counts over-report on a rebased or squashed branch",
  );

  // --- GREEN pole: SUPPRESSED, and counted as in-flight ---
  eq("pair:GREEN-inflight-is-suppressed", verdictFor(s, "feat/inflight"), "SUPPRESSED");
  ok(
    "pair:GREEN-name-absent-from-rendered-block",
    typeof block === "string" && !block.includes("feat/inflight"),
    "the noise reduction the age floor buys must survive the fix",
  );
  ok(
    "pair:GREEN-still-counted-not-dropped",
    s.inFlightCount >= 1,
    `inFlightCount=${s.inFlightCount} — suppression must never reduce a COUNT`,
  );

  // --- THE DISCRIMINATION ASSERTION ---
  const vRed = verdictFor(s, "feat/ratchet");
  const vGreen = verdictFor(s, "feat/inflight");
  ok(
    "pair:verdicts-differ",
    vRed !== vGreen,
    `both poles returned ${vRed} — the instrument does not discriminate`,
  );
  eq("pair:RED-verdict-is-listed-ratchet", vRed, "LISTED_RATCHET");

  // --- THE NEGATIVE CONTROL: the OLD predicate cannot tell them apart ---
  // Same two fixtures, same repo, the carry axis withheld (which is exactly the
  // pre-#1912 predicate). If the poles still differed here, the pair would be
  // separable WITHOUT the fix and would prove nothing about it.
  const branches = getUnmergedBranches(dir, resolveBaseRef(dir));
  const old = computeUnlandedSummary(branches, [], Date.now(), null, null, null);
  const oRed = verdictFor(old, "feat/ratchet");
  const oGreen = verdictFor(old, "feat/inflight");
  eq("control:OLD-predicate-suppresses-the-ratchet", oRed, "SUPPRESSED");
  ok(
    "control:OLD-predicate-verdicts-are-IDENTICAL",
    oRed === oGreen,
    `old predicate separated them (${oRed} vs ${oGreen}) — the pair does not isolate the fix`,
  );

  return { dir, baseSha };
}

// ─────────────────────────────────────────────────────────────────────────────
// THRESHOLD BOUNDARY — the axis must not be satisfiable by rounding
// ─────────────────────────────────────────────────────────────────────────────
function thresholdBoundary() {
  const now = nowSecs();
  const { dir, baseSha } = mkRepo("bound");

  // 23h of carry — under a full day. Genuine same-day in-flight work.
  branchFrom(dir, baseSha, "feat/under");
  commit(dir, "u1.txt", "under first", now - 23 * HOUR);
  commit(dir, "u2.txt", "under tip", now - 60);

  // 25h of carry — across a full day boundary.
  branchFrom(dir, baseSha, "feat/over");
  commit(dir, "o1.txt", "over first", now - 25 * HOUR);
  commit(dir, "o2.txt", "over tip", now - 60);

  git(dir, ["checkout", "--quiet", "main"]);
  const s = stateOf(dir);
  if (!s) {
    ok("bound:state-computed", false, "computeUnlandedState returned falsy");
    return;
  }
  eq("bound:23h-carry-stays-suppressed", verdictFor(s, "feat/under"), "SUPPRESSED");
  eq("bound:25h-carry-is-listed", verdictFor(s, "feat/over"), "LISTED_RATCHET");
  ok(
    "bound:boundary-verdicts-differ",
    verdictFor(s, "feat/under") !== verdictFor(s, "feat/over"),
    "the threshold does not bite",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// WHY AUTHOR DATE — measured, not asserted from documentation
// ─────────────────────────────────────────────────────────────────────────────
function authorDateSurvivesRebase() {
  const now = nowSecs();
  const { dir, baseSha } = mkRepo("rebase");

  // A ratchet, then a base that moves, then a rebase onto it. An ordinary
  // rebase REWRITES committer dates to now while PRESERVING author dates. If
  // the span were read from committer dates, this rebase would zero it and the
  // ratchet would vanish — which is the whole reason `%at` is used.
  branchFrom(dir, baseSha, "feat/rebased");
  commit(dir, "b1.txt", "rebased first", now - 5 * DAY);
  commit(dir, "b2.txt", "rebased tip", now - 4 * DAY);

  git(dir, ["checkout", "--quiet", "main"]);
  commit(dir, "moved.txt", "base moved", now - 3 * DAY);
  const newBase = git(dir, ["rev-parse", "HEAD"]).trim();
  git(dir, ["update-ref", "refs/remotes/origin/main", newBase]);

  git(dir, ["checkout", "--quiet", "feat/rebased"]);
  git(dir, ["rebase", "--quiet", "main"], {
    GIT_COMMITTER_DATE: isoOf(now - 60),
  });
  git(dir, ["checkout", "--quiet", "main"]);

  const baseRef = resolveBaseRef(dir);
  const branches = getUnmergedBranches(dir, baseRef);
  const row = (branches || []).find((b) => b.name === "feat/rebased");

  // CONTROL: confirm the rebase actually moved committer dates, otherwise the
  // case below proves nothing about author-vs-committer.
  const dates = git(dir, [
    "log",
    "--format=%at %ct",
    "-2",
    "feat/rebased",
  ])
    .trim()
    .split("\n")
    .map((l) => l.trim().split(" ").map(Number));
  const committerMoved = dates.every(([at, ct]) => ct > at);
  ok(
    "rebase:control-committer-dates-were-rewritten",
    committerMoved,
    `author/committer pairs ${JSON.stringify(dates)} — rebase did not diverge them, so this case cannot discriminate`,
  );

  const carry = computeCarrySpans(dir, baseRef, branches || []);
  ok("rebase:carry-pass-ran", carry !== null, "computeCarrySpans returned null");
  if (!carry || !row) return;

  const span = carry.spans.get("feat/rebased");
  ok("rebase:span-entry-present", Boolean(span), "no span for feat/rebased");
  if (!span) return;

  const authorSpanDays = Math.floor((row.ts - span.firstTs) / 86400000);
  ok(
    "rebase:AUTHOR-date-span-survives-the-rebase",
    authorSpanDays >= RATCHET_SPAN_DAYS,
    `authorSpanDays=${authorSpanDays}`,
  );

  // The counterfactual, computed from the SAME repo: had the span been read
  // from committer dates it would now be 0 and the ratchet would be invisible.
  const committerFirst =
    Math.min(...dates.map(([, ct]) => ct)) * 1000;
  const committerSpanDays = Math.floor((row.ts - committerFirst) / 86400000);
  ok(
    "rebase:committer-date-span-would-have-been-erased",
    committerSpanDays < RATCHET_SPAN_DAYS,
    `committerSpanDays=${committerSpanDays} — the counterfactual does not hold, so the design rationale is unsupported`,
  );

  const s = stateOf(dir);
  eq(
    "rebase:rebased-ratchet-is-still-listed",
    verdictFor(s, "feat/rebased"),
    "LISTED_RATCHET",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FORGED / DEGENERATE DATES — polarity pinned, never a negative span
// ─────────────────────────────────────────────────────────────────────────────
function forgedFutureDate() {
  const now = nowSecs();
  const { dir, baseSha } = mkRepo("forged");
  branchFrom(dir, baseSha, "feat/future");
  // Author date in the future, committer date now: span would go NEGATIVE if
  // unfloored, and a negative number compares below the threshold either way —
  // but an unfloored negative would render as "carrying unlanded work for -3d",
  // which is a nonsense row an operator would learn to ignore.
  commit(dir, "f1.txt", "future authored", now + 3 * DAY, now - 60);
  git(dir, ["checkout", "--quiet", "main"]);

  const s = stateOf(dir);
  if (!s) {
    ok("forged:state-computed", false, "falsy state");
    return;
  }
  eq("forged:future-author-date-is-not-a-ratchet", verdictFor(s, "feat/future"), "SUPPRESSED");
  const block = formatUnlandedBlock(s);
  ok(
    "forged:no-negative-span-rendered",
    typeof block !== "string" || !/-\d+d/.test(block.replace(/\b\d+–\d+d\b/g, "")),
    "a negative span reached the rendered block",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SUPPRESSION POLICY STILL WINS — a declared no-land branch is not a ratchet
// ─────────────────────────────────────────────────────────────────────────────
function demotedRatchet() {
  const now = nowSecs();
  const { dir, baseSha } = mkRepo("demoted");
  branchFrom(dir, baseSha, "wip/scratch");
  commit(dir, "w1.txt", "wip first", now - 4 * DAY);
  commit(dir, "w2.txt", "wip tip", now - 60);
  git(dir, ["checkout", "--quiet", "main"]);

  const s = stateOf(dir);
  if (!s) {
    ok("demoted:state-computed", false, "falsy state");
    return;
  }
  eq("demoted:declared-no-land-branch-is-not-a-ratchet-row", verdictFor(s, "wip/scratch"), "SUPPRESSED");
  eq("demoted:still-counted-in-the-total", s.demotedCount >= 1, true);
}

// ─────────────────────────────────────────────────────────────────────────────
// TRI-STATE — a pass that did not run never renders as a verified claim
// ─────────────────────────────────────────────────────────────────────────────
function triState() {
  const now = nowSecs();
  const { dir, baseSha } = mkRepo("tri");
  branchFrom(dir, baseSha, "feat/ratchet2");
  commit(dir, "t1.txt", "first", now - 3 * DAY);
  commit(dir, "t2.txt", "tip", now - 60);
  git(dir, ["checkout", "--quiet", "main"]);

  const baseRef = resolveBaseRef(dir);
  const branches = getUnmergedBranches(dir, baseRef);

  // (a) opt-out
  const prev = process.env.COC_UNLANDED_RATCHET_CHECK;
  process.env.COC_UNLANDED_RATCHET_CHECK = "0";
  const optedOut = computeCarrySpans(dir, baseRef, branches);
  if (prev === undefined) delete process.env.COC_UNLANDED_RATCHET_CHECK;
  else process.env.COC_UNLANDED_RATCHET_CHECK = prev;
  eq("tri:opt-out-returns-null", optedOut, null);

  // (b) exhausted budget
  const starved = computeCarrySpans(dir, baseRef, branches, {
    ratchetBudgetMs: -1,
  });
  eq("tri:exhausted-budget-returns-null", starved, null);

  // (c) an unavailable pass renders UNCLASSIFIED, never "work in flight" alone
  const unknown = computeUnlandedSummary(branches, [], Date.now(), null, null, null);
  eq("tri:unknown-axis-flagged", unknown.ratchetKnown, false);
  const blockUnknown = formatUnlandedBlock(unknown);
  ok(
    "tri:unknown-axis-says-UNCLASSIFIED",
    /UNCLASSIFIED/.test(blockUnknown),
    "an unmeasured carry axis rendered as a verified in-flight claim",
  );
  ok(
    "tri:unknown-axis-does-not-claim-verification",
    !/carry span verified/.test(blockUnknown),
    "claimed verification from a pass that never ran",
  );

  // (d) a pass that DID run says so, and does not say UNCLASSIFIED
  const known = computeUnlandedSummary(
    branches,
    [],
    Date.now(),
    null,
    null,
    computeCarrySpans(dir, baseRef, branches),
  );
  eq("tri:known-axis-flagged", known.ratchetKnown, true);
  const blockKnown = formatUnlandedBlock(known);
  ok(
    "tri:known-and-unknown-blocks-differ",
    blockKnown !== blockUnknown,
    "the tri-state is not observable in the output",
  );

  // (e) unreadable author date is UNKNOWN, never banked as young. Real git will
  // not emit an unparsable %at on demand, so this state is injected — labelled
  // `unit:` for exactly that reason.
  const row = branches.find((b) => b.name === "feat/ratchet2");
  const injected = new Map([
    ["feat/ratchet2", { firstTs: NaN, commits: 2, tsComplete: false }],
  ]);
  const partial = computeUnlandedSummary(
    [row],
    [],
    Date.now(),
    null,
    null,
    { spans: injected, nodes: 2 },
  );
  eq("unit:unreadable-date-is-not-a-ratchet-row", partial.ratchetCount, 0);
  eq("unit:unreadable-date-counted-as-span-UNKNOWN", partial.ratchetSpanUnknownCount, 1);
  ok(
    "unit:unreadable-date-surfaces-as-UNKNOWN-in-the-block",
    /UNKNOWN — unmeasured, not verified young/.test(formatUnlandedBlock(partial)),
    "a branch whose carry could not be read was silently banked as in-flight",
  );

  // (f) a PARTIAL minimum that already crosses the threshold is positive
  // evidence and must still list — absence of one date is not absence of carry.
  const crossing = new Map([
    [
      "feat/ratchet2",
      { firstTs: row.ts - 3 * 86400000, commits: 2, tsComplete: false },
    ],
  ]);
  const partialCrossing = computeUnlandedSummary(
    [row],
    [],
    Date.now(),
    null,
    null,
    { spans: crossing, nodes: 2 },
  );
  eq("unit:partial-but-crossing-span-still-lists", partialCrossing.ratchetCount, 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNTING — suppression may never reduce a COUNT (design property 2)
// ─────────────────────────────────────────────────────────────────────────────
function accounting() {
  const now = nowSecs();
  const { dir, baseSha } = mkRepo("acct");
  branchFrom(dir, baseSha, "feat/ratchet3");
  commit(dir, "a1.txt", "first", now - 3 * DAY);
  commit(dir, "a2.txt", "tip", now - 60);
  branchFrom(dir, baseSha, "feat/inflight3");
  commit(dir, "c1.txt", "first", now - HOUR);
  commit(dir, "c2.txt", "tip", now - 60);
  branchFrom(dir, baseSha, "feat/old3");
  commit(dir, "d1.txt", "old", now - 40 * DAY);
  branchFrom(dir, baseSha, "wip/demoted3");
  commit(dir, "e1.txt", "wip", now - 40 * DAY);
  git(dir, ["checkout", "--quiet", "main"]);

  const s = stateOf(dir);
  if (!s) {
    ok("acct:state-computed", false, "falsy state");
    return;
  }
  eq(
    "acct:every-branch-accounted-exactly-once",
    s.listableCount + s.demotedCount + s.inFlightCount + s.ratchetCount,
    s.total,
  );
  eq("acct:ratchet-not-double-counted-as-inflight", s.inFlightCount, 1);
  eq("acct:ratchet-counted", s.ratchetCount, 1);
  eq("acct:aged-branch-still-listed-by-age", verdictFor(s, "feat/old3"), "LISTED_AGED");

  const block = formatUnlandedBlock(s);
  ok(
    "acct:ratchet-section-renders-above-the-aged-rows",
    block.indexOf("RATCHET") >= 0 &&
      block.indexOf("RATCHET") < block.indexOf("feat/old3"),
    "the more urgent class must not be buried under the age list",
  );
  ok(
    "acct:aged-list-and-ratchet-list-are-separate-sections",
    !/^- feat\/ratchet3 \(\d+d/m.test(block),
    "a ratchet leaked into the age-sorted list, where the heading reads 'you forgot this'",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION ANCHOR — the measured #1912 shape, stated as a case
// ─────────────────────────────────────────────────────────────────────────────
function issue1912Shape() {
  const now = nowSecs();
  const { dir, baseSha } = mkRepo("i1912");
  // 33 commits across three days, tip written moments ago — the measured shape
  // of codify/someoperator-2026-08-20, which was listed ZERO times across at least
  // three session starts with the pre-fix surface live.
  branchFrom(dir, baseSha, "codify/someoperator-2026-08-20");
  for (let i = 0; i < 33; i++) {
    const at = now - 3 * DAY + Math.floor((i * 3 * DAY) / 33);
    commit(dir, `n${i}.txt`, `commit ${i}`, at, i === 32 ? now - 60 : at);
  }
  git(dir, ["checkout", "--quiet", "main"]);

  const s = stateOf(dir);
  if (!s) {
    ok("i1912:state-computed", false, "falsy state");
    return;
  }
  const row = s.ratchets.find((r) => r.name === "codify/someoperator-2026-08-20");
  ok(
    "i1912:the-branch-that-produced-the-issue-is-LISTED",
    Boolean(row),
    `ratchets=${JSON.stringify(s.ratchets.map((r) => r.name))}`,
  );
  eq("i1912:age-is-still-zero", row && row.ageDays, 0);
  eq("i1912:unlanded-commit-count-surfaced", row && row.commits, 33);
  ok(
    "i1912:pre-fix-predicate-would-have-suppressed-it",
    verdictFor(
      computeUnlandedSummary(
        getUnmergedBranches(dir, resolveBaseRef(dir)),
        [],
        Date.now(),
        null,
        null,
        null,
      ),
      "codify/someoperator-2026-08-20",
    ) === "SUPPRESSED",
    "the regression anchor does not reproduce the defect it anchors",
  );
}

// ── run ──────────────────────────────────────────────────────────────────────
try {
  polePair();
  thresholdBoundary();
  authorDateSurvivesRebase();
  forgedFutureDate();
  demotedRatchet();
  triState();
  accounting();
  issue1912Shape();
} finally {
  for (const d of cleanups) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* temp dir cleanup is best-effort; never mask a real verdict */
    }
  }
}

console.log(
  `\nSUMMARY: ${passed} passed, ${failed} failed (RECENT_DAYS=${RECENT_DAYS}, RATCHET_SPAN_DAYS=${RATCHET_SPAN_DAYS})`,
);
process.exit(failed === 0 ? 0 : 1);
