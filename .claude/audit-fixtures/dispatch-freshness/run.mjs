#!/usr/bin/env node
/**
 * Audit-fixture runner for the DISPATCH-FRESHNESS PRECONDITION —
 * `.claude/hooks/lib/dispatch-freshness.js` + `.claude/hooks/dispatch-freshness-guard.js`,
 * shipped WITH the detector per `cc-artifacts.md` Rule 9.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REAL GIT, NOT A MOCK — and that is the load-bearing choice here
 * ─────────────────────────────────────────────────────────────────────────────
 * The predicate IS git process state: `git log -1 --format=%ct refs/remotes/origin/<trunk>`. A
 * mocked git would test the mock — it would pass identically against a detector that never runs
 * git at all, which is precisely the non-discriminating instrument `instrument-discipline.md`
 * MUST-1 forbids. Every repository below is a REAL `git init` with REAL commits whose dates are
 * set through `GIT_COMMITTER_DATE`/`GIT_AUTHOR_DATE`, and every remote-tracking ref is a real
 * `update-ref` — never a network call, so the suite is hermetic and offline exactly as the
 * predicate is.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTAINMENT (worktree-isolation.md MUST-10)
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY git invocation in this file is pinned with an ABSOLUTE `-C <dir>` AND an absolute `cwd`,
 * against a directory this runner created with `mkdtemp` under the OS temp root. `assertContained`
 * runs BEFORE the first write in each repo and refuses on mismatch: it compares the repo's own
 * RESOLVED `git -C <dir> rev-parse --show-toplevel` to the realpath of `<dir>`, so a `-C` that
 * walked UP into an enclosing repository is caught rather than silently measured. The temp root is
 * additionally asserted to lie OUTSIDE the checkout before any directory is made. Nothing here
 * ever writes to, commits in, or pushes from the checkout.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BIPOLAR BY CONSTRUCTION
 * ─────────────────────────────────────────────────────────────────────────────
 * Every arm carries BOTH poles. A set that only ever asserts FIRING passes identically against a
 * detector that fires on everything; a set that only ever asserts SILENCE passes identically
 * against one that is inert. Both are live risks for an advisory guard, because an inert advisory
 * is byte-identical to a clean session. The threshold poles (5d tip vs 3d ⇒ fires, 5d tip vs 10d
 * ⇒ silent) run against the SAME repository, so the COMPARISON is what is under test rather than
 * the fixture.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ESTABLISHED RED — the mutations these cases are pinned by
 * ─────────────────────────────────────────────────────────────────────────────
 * `reds_under` on each case names the mutation that reddens it. The three named mutations are
 * driven against a SCRATCH COPY of `.claude/hooks/**` (the live files are never written), each
 * asserted to (a) change the file's bytes, (b) still PARSE under `node --check` — a syntactically
 * invalid mutant tests nothing and its "red" is a module-load error wearing a detector failure's
 * clothes — and (c) EXECUTE, proven by an output fingerprint that differs from the unmutated
 * library's on the same input. Reach is NOT proven with `console.error`: this harness captures
 * subprocess stderr into the case result, so a stderr marker would be indistinguishable from the
 * detector's own output.
 *
 * The matrix below is what the mutations ACTUALLY reddened — OBSERVED 2026-09-13, not predicted:
 *
 *   M-0  CONTROL: the UNMUTATED scratch copy, run first. 46/46, rc=0, and its output fingerprint
 *        was byte-identical to the live checkout's
 *        (`{"stale_state":"stale","norepo_state":"undetermined","task_findings":1,"bash_findings":0}`).
 *        Without this control a mutant that merely dies on a missing import reads as a successful
 *        mutation, and every red below would be unreadable.
 *
 *   M-1  invert the age comparison (`>=` → `<`)   → 32/46. RED: L-01 L-02 L-03 L-04 L-05 L-07
 *        L-16 L-17 E-01 E-02 E-06 E-07 E-08 E-09. Both poles red, which is the point: the firing
 *        cases go silent AND the silent cases start firing, so neither a fires-on-everything nor
 *        an inert detector survives.
 *        reach: `stale_state` stale → fresh, `task_findings` 1 → 0.
 *
 *   M-2  collapse UNDETERMINED into "fresh"       → 39/46. RED: L-11 L-13 L-14 L-15 L-32 E-10
 *        E-11. This is the mutation that matters most — it is the single change that would make
 *        the guard stop guarding invisibly, and seven cases stand between it and a green suite.
 *        reach: `norepo_state` undetermined → fresh. NOTE the ABSENT cases (L-08/09/10) correctly
 *        do NOT red: `absent` overrides the base verdict explicitly, so it is not collapsed.
 *
 *   M-3a remove the dispatch-tool gate, LIBRARY only → 45/46. RED: L-06 ONLY.
 *   M-3b remove it in the library AND the hook       → 44/46. RED: L-06, E-03.
 *        THE DOUBLE MUTATION IS DELIBERATE, per `instrument-discipline.md` MUST-5(b). M-3a left
 *        E-03 GREEN, and an empty-or-partial red set has TWO live hypotheses — a vacuous case, or
 *        an INERT mutation. It is the second: the hook carries its OWN gate, which ABSORBED the
 *        library mutation, so E-03 could not red until both were dropped. That is genuine defense
 *        in depth and is recorded here so a later reader does not delete one gate on the evidence
 *        that "no test covers it".
 *        reach (both): `bash_findings` 0 → 1.
 *
 * Every mutation ran against a FRESH scratch copy of `.claude/hooks/**` + this directory; the live
 * files were never written and were sha-256-identical before and after the whole campaign.
 *
 * A case may red under MORE than one mutation — a case asserting a stale finding's evidence also
 * reds when M-1 removes the finding entirely. The matrix above is the AUTHORITATIVE record of what
 * was observed; each case's `reds_under` names the mutation it was WRITTEN to guard.
 */

import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const REPO = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const L = require(path.join(REPO, ".claude/hooks/lib/dispatch-freshness.js"));
const HOOK = path.join(REPO, ".claude/hooks/dispatch-freshness-guard.js");

const DAY = 86400;
const HOUR = 3600;
const now = () => Math.floor(Date.now() / 1000);

// ── containment scaffolding ──────────────────────────────────────────────────
const TMP_REAL = fs.realpathSync(os.tmpdir());
const REPO_REAL = fs.realpathSync(REPO);
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);
if (within(TMP_REAL, REPO_REAL)) {
  throw new Error(`REFUSING: temp root ${TMP_REAL} lies inside the checkout ${REPO_REAL}`);
}
const scratch = [];
process.on("exit", () => {
  for (const d of scratch) {
    if (within(d, TMP_REAL) && !within(d, REPO_REAL)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
  }
});

/** Every git call: absolute `-C`, absolute `cwd`, no shell. */
function git(dir, args, extraEnv = {}) {
  return execFileSync("git", ["-C", dir, ...args], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
}

/** STEP 0 for each fixture repo — refuses if `-C` resolved anywhere but this directory. */
function assertContained(dir) {
  const top = fs.realpathSync(git(dir, ["rev-parse", "--show-toplevel"]).trim());
  const real = fs.realpathSync(dir);
  if (top !== real) throw new Error(`REFUSING fixture repo ${dir}: toplevel resolved to ${top}`);
  if (!within(real, TMP_REAL) || within(real, REPO_REAL)) {
    throw new Error(`REFUSING fixture repo ${dir}: outside the temp root or inside the checkout`);
  }
}

const isoOf = (secs) => new Date(secs * 1000).toISOString();

/**
 * A repository whose `refs/remotes/origin/dev` tip is EXACTLY `tipAgeSecs` old.
 *
 * `trunkRef: null` builds a repo with NO remote-tracking ref at all — the ABSENT case. Identity is
 * declared in LOCAL config so the commit succeeds under any ambient profile, and signing is off so
 * the fixture does not depend on the host operator's key.
 */
function mkRepo(label, { tipAgeSecs = DAY, trunkRef = "refs/remotes/origin/dev" } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(TMP_REAL, `dispatch-freshness-${label}-`)));
  scratch.push(dir);
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  assertContained(dir); // BEFORE the first write of content
  git(dir, ["config", "user.email", "fixture@example.invalid"]);
  git(dir, ["config", "user.name", "fixture"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  const when = isoOf(now() - tipAgeSecs);
  fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
  git(dir, ["add", "base.txt"]);
  git(dir, ["commit", "--quiet", "-m", "base"], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
  const sha = git(dir, ["rev-parse", "HEAD"]).trim();
  if (trunkRef) git(dir, ["update-ref", trunkRef, sha]);
  return { dir, sha };
}

// ── case bookkeeping ─────────────────────────────────────────────────────────
const cases = [];
function check(id, name, cond, detail, redsUnder) {
  cases.push({ id, name, pass: !!cond, detail, redsUnder });
}

/**
 * Drive the LIBRARY the way the hook does. `COC_TRUNK_REF` is stripped from the resolver's view
 * by measuring in a child-free path — the resolver reads `process.env`, so an operator override
 * leaking in would silently re-point every case. Asserted, not assumed, by case L-00.
 */
const measure = (dir, extra = {}) => L.measureTrunkFreshness({ repoDir: dir, ...extra });
const fireLib = (tool, m) => L.inspectDispatchFreshness(tool, m);

check("L-00", "ENV HYGIENE: no COC_TRUNK_REF override is in scope for this run",
  !process.env.COC_TRUNK_REF,
  `COC_TRUNK_REF=${process.env.COC_TRUNK_REF ?? "(unset)"}`,
  "an override would re-point every case's trunk and silently invalidate the suite");

// ── 1. the REQUIRED case list ────────────────────────────────────────────────
{
  // (1) 30d tip → FIRES
  const stale = mkRepo("stale30d", { tipAgeSecs: 30 * DAY });
  const mStale = measure(stale.dir);
  check("L-01", "30-DAY tip on origin/dev measures STALE",
    mStale.state === "stale" && mStale.ageDays >= 29.5 && mStale.ageDays <= 30.5,
    `state=${mStale.state} ageDays=${mStale.ageDays} ref=${mStale.ref}`,
    "M-1: invert the age comparison");
  const fStale = fireLib("Task", mStale);
  check("L-02", "a STALE base FIRES on a Task dispatch, advisory, with the stale rule_id",
    fStale.length === 1 && fStale[0].severity === "advisory" &&
      fStale[0].rule_id === L.RULE_ID_STALE && fStale[0].state === "stale",
    `${fStale.length} finding(s) rule_id=${fStale[0]?.rule_id} sev=${fStale[0]?.severity}`,
    "M-1");
  check("L-03", "the finding NAMES the measured ref and is never `block`",
    (fStale[0]?.evidence || "").includes("refs/remotes/origin/dev") && fStale[0]?.severity !== "block",
    fStale[0]?.evidence,
    "hook-output-discipline.md MUST-2 — an ambiguous reading may not carry teeth");

  // (2) fresh tip → SILENT
  const fresh = mkRepo("fresh1h", { tipAgeSecs: 1 * HOUR });
  const mFresh = measure(fresh.dir);
  check("L-04", "a 1-HOUR-old tip measures FRESH",
    mFresh.state === "fresh" && mFresh.ref === "refs/remotes/origin/dev",
    `state=${mFresh.state} ageDays=${mFresh.ageDays}`,
    "M-1 inverted: without this pole a detector that fires on everything passes L-01");
  check("L-05", "a FRESH base is SILENT on a Task dispatch",
    fireLib("Task", mFresh).length === 0,
    "the no-false-positive pole",
    "M-1");

  // (3) non-dispatch tool → SILENT even on a stale base
  check("L-06", "a NON-dispatch tool is SILENT on the SAME stale measurement",
    fireLib("Bash", mStale).length === 0 && fireLib("Read", mStale).length === 0,
    "the dispatch-tool gate — belt to the matcher's suspenders",
    "M-3a and M-3b (measured): this is the ONLY case the library-only gate removal reds");
  check("L-07", "both delegation tools ARE inspected",
    fireLib("Task", mStale).length === 1 && fireLib("Agent", mStale).length === 1,
    "Task and Agent arms — a gate that admits nothing is as inert as one that admits everything",
    "M-1 (measured). It does NOT red under M-3: dropping the gate WIDENS what is admitted, so the two tools it already admits keep firing");

  // (4) no origin/<trunk> ref at all → SILENT (and it is ABSENT, not fresh, not stale)
  const bare = mkRepo("noremote", { tipAgeSecs: 400 * DAY, trunkRef: null });
  const mBare = measure(bare.dir);
  check("L-08", "a repo with NO remote-tracking trunk measures ABSENT — not fresh, not stale",
    mBare.state === "absent",
    `state=${mBare.state} ref=${mBare.ref} reason=${mBare.reason}`,
    "collapse absent into fresh (loses the distinction) or into undetermined (makes it speak)");
  check("L-09", "an ABSENT trunk is SILENT, deliberately",
    fireLib("Task", mBare).length === 0,
    "a guard that speaks on every dispatch trains the operator to skim past it",
    "make absent fire");
  check("L-10", "ABSENT is reached even though the local HEAD is 400 DAYS old",
    mBare.state === "absent" && mBare.tipEpoch === null,
    "the predicate reads the REMOTE-TRACKING ref, never HEAD — the positive control for that scope",
    "read HEAD instead of the trunk ref");

  // (5) probe times out → UNDETERMINED (never silent, never stale)
  // A STUB BINARY that sleeps — never a busy loop, and never synthetic CPU load. The trunk is
  // resolved by the REAL git first (the shared resolver spawns its own), then the tip probe is
  // pointed at the stub and killed by the bounded budget.
  const stubDir = fs.realpathSync(fs.mkdtempSync(path.join(TMP_REAL, "dispatch-freshness-stub-")));
  scratch.push(stubDir);
  const stub = path.join(stubDir, "git-slow");
  fs.writeFileSync(stub, "#!/bin/sh\nsleep 30\n");
  fs.chmodSync(stub, 0o755);
  const mTimeout = measure(stale.dir, { gitBin: stub, budgetMs: 400 });
  check("L-11", "a TIMED-OUT tip probe is UNDETERMINED — never fresh, never stale",
    mTimeout.state === "undetermined",
    `state=${mTimeout.state} reason=${mTimeout.reason}`,
    "M-2: collapse UNDETERMINED into fresh");
  check("L-12", "the UNDETERMINED probe still NAMES the ref it failed to read",
    mTimeout.ref === "refs/remotes/origin/dev" && mTimeout.tipEpoch === null,
    `ref=${mTimeout.ref}`,
    "report a bare failure with no subject");
  const fUnd = fireLib("Agent", mTimeout);
  check("L-13", "an UNDETERMINED probe SPEAKS — the third state is never silent",
    fUnd.length === 1 && fUnd[0].rule_id === L.RULE_ID_UNDETERMINED && fUnd[0].severity === "advisory",
    `${fUnd.length} finding(s) rule_id=${fUnd[0]?.rule_id}`,
    "M-2");
  // The only sentence in an UNDETERMINED report that may speak of the base being current is point
  // (c)'s CONDITIONAL out ("if you have just fetched and know…"). Any UNCONDITIONAL claim of
  // freshness is the exact collapse M-2 performs, so the case tests for that shape rather than for
  // the substring — an earlier draft banned the phrase outright and reddened on (c)'s own wording.
  const undLines = fUnd[0]?.lines || [];
  const unconditional = undLines.filter(
    (l) => /\bis (fresh|current)\b/i.test(l) && !/^\(c\) THE OUT: if /.test(l),
  );
  check("L-14", "an UNDETERMINED report declares the third state and never asserts freshness unconditionally",
    fUnd[0]?.state === "undetermined" &&
      (undLines[0] || "").includes("UNDETERMINED, not fresh") &&
      unconditional.length === 0,
    `state=${fUnd[0]?.state} unconditional-freshness-claims=${unconditional.length}`,
    "M-2 — an unanswerable probe and a current trunk are byte-identical in a proceed response");
  check("L-15", "a SPENT budget (0ms) is ALSO undetermined, not absent",
    measure(stale.dir, { budgetMs: 0 }).state === "undetermined",
    "no probe ran, so nothing was measured",
    "treat a spent budget as a ref-absence verdict");

  // (6) + (7) the SAME 5-day repo under two thresholds — the comparison is what is under test
  const five = mkRepo("fivedays", { tipAgeSecs: 5 * DAY });
  const m3d = measure(five.dir, { thresholdHours: 72 });
  const m10d = measure(five.dir, { thresholdHours: 240 });
  check("L-16", "5-day tip vs a 3-DAY threshold FIRES",
    m3d.state === "stale" && fireLib("Task", m3d).length === 1,
    `state=${m3d.state} threshold=${m3d.thresholdHours}h`,
    "M-1");
  check("L-17", "5-day tip vs a 10-DAY threshold is SILENT — same repo, same tip, same commit",
    m10d.state === "fresh" && fireLib("Task", m10d).length === 0,
    `state=${m10d.state} threshold=${m10d.thresholdHours}h`,
    "M-1 inverted, and the threshold-injection pole: a bound no test can cross is a bound nobody has checked");
  check("L-18", "both readings came from the SAME tip — the threshold, not the fixture, decided",
    m3d.tipEpoch === m10d.tipEpoch && m3d.tipEpoch !== null,
    `tip=${m3d.tipEpoch}`,
    "if the two poles used different repos the comparison would prove nothing about the threshold");
}

// ── 2. the threshold RESOLVER (the injection seam itself) ────────────────────
{
  check("L-19", "absent env yields the 72h default",
    L.resolveThresholdHours({}).hours === L.DEFAULT_THRESHOLD_HOURS &&
      L.resolveThresholdHours({}).source === "default",
    `${L.resolveThresholdHours({}).hours}h`);
  check("L-20", "a valid env value is honoured and its source recorded",
    L.resolveThresholdHours({ [L.THRESHOLD_ENV]: "6" }).hours === 6 &&
      L.resolveThresholdHours({ [L.THRESHOLD_ENV]: "6" }).source === "env",
    "injectable",
    "hard-code the threshold — then the firing arm can only be exercised by waiting three days");
  check("L-21", "zero / negative / garbage fall back to the default rather than disarming the guard",
    L.resolveThresholdHours({ [L.THRESHOLD_ENV]: "0" }).hours === 72 &&
      L.resolveThresholdHours({ [L.THRESHOLD_ENV]: "-1" }).hours === 72 &&
      L.resolveThresholdHours({ [L.THRESHOLD_ENV]: "soon" }).hours === 72,
    "0 would make every dispatch stale; -1 would make none of them stale",
    "honour any parseable value");
}

// ── 3. the four-point MESSAGE (point (d) is the droppable one) ───────────────
{
  const m = { ref: "refs/remotes/origin/dev", tipEpoch: now() - 30 * DAY, ageDays: 30, thresholdHours: 72 };
  const lines = L.remediationLines(m);
  const blob = lines.join("\n");
  check("L-22", "(a) the message names the REF, the tip DATE and the AGE IN DAYS",
    blob.includes("refs/remotes/origin/dev") && /\d{4}-\d{2}-\d{2}/.test(blob) && blob.includes("30 days old"),
    "point (a)",
    "drop the measured facts and the operator cannot check the claim");
  check("L-23", "(b) the message names `git fetch origin` and a re-check before dispatching",
    blob.includes("git fetch origin") && /re-?check/i.test(blob),
    "point (b)");
  check("L-24", "(c) the message offers an explicit OUT for a genuinely quiet trunk",
    /quiet/i.test(blob) && /proceed/i.test(blob),
    "point (c) — an old tip and an unfetched ref look identical from here");
  check("L-25", "(d) the message tells the operator to RE-DERIVE the issue list / tracker snapshot",
    /re-?derive/i.test(blob) && /(issue list|tracker)/i.test(blob) && blob.includes("⚠️"),
    "point (d) — the most droppable, and the one that cost the most",
    "drop (d): the tree and the tracker go stale TOGETHER, which is what made 0/53 read as consistency");
  check("L-26", "(d) survives on the UNDETERMINED branch too",
    /re-?derive/i.test(L.undeterminedLines({ ref: "refs/remotes/origin/dev", reason: "x" }).join("\n")),
    "an unanswerable probe leaves the inputs unverified, not checked",
    "M-2 sibling: an undetermined report that omits (d)");
  check("L-27", "evidence is BOUNDED",
    L.clip("x".repeat(900)).length <= L.EVIDENCE_MAX + 1 && L.clip("a\n\nb") === "a b",
    "advisory stays single-line and bounded");
}

// ── 4. ref expansion + fail-open shapes ──────────────────────────────────────
{
  check("L-28", "a short trunk name expands to the FULL remote-tracking refname",
    L.fullRefName("origin/dev") === "refs/remotes/origin/dev",
    "a LOCAL branch literally named `origin/dev` would otherwise win git's DWIM order");
  check("L-29", "an already-qualified ref passes through untouched",
    L.fullRefName("refs/remotes/origin/main") === "refs/remotes/origin/main",
    "no double-prefixing");
  check("L-30", "garbage input yields null rather than a throw",
    L.fullRefName(null) === null && L.fullRefName("") === null,
    "fail open (cc-artifacts.md Rule 7)");
  check("L-31", "a null/garbage measurement yields NO findings rather than a throw",
    fireLib("Task", null).length === 0 && fireLib("Task", { state: "banana" }).length === 0,
    "fail open on garbage");
  check("L-32", "a non-repository directory is UNDETERMINED, not fresh and not absent",
    (() => {
      const d = fs.realpathSync(fs.mkdtempSync(path.join(TMP_REAL, "dispatch-freshness-norepo-")));
      scratch.push(d);
      return measure(d).state === "undetermined";
    })(),
    "cannot measure ⇒ say so",
    "M-2");
}

// ── 5. THE REAL HOOK BOUNDARY ────────────────────────────────────────────────
// The library cases above can ALL pass while the hook itself is inert — a sibling guard in this
// repo lived its whole first life that way, calling JSON.parse() on an already-parsed payload and
// falling through to a silent passthrough on every well-formed input. These cases drive the hook
// as the runtime does: real child process, real stdin, real stdout contract, with the fixture repo
// as BOTH cwd and CLAUDE_PROJECT_DIR.
{
  const staleRepo = mkRepo("e2e-stale", { tipAgeSecs: 25 * DAY });
  const freshRepo = mkRepo("e2e-fresh", { tipAgeSecs: 2 * HOUR });
  const bareRepo = mkRepo("e2e-bare", { tipAgeSecs: 40 * DAY, trunkRef: null });

  /** The ONE call site that starts the hook. cwd and CLAUDE_PROJECT_DIR are both the fixture. */
  function spawnHook(repoDir, payload, extraEnv = {}) {
    const env = { ...process.env, ...extraEnv, CLAUDE_PROJECT_DIR: repoDir };
    delete env.COC_TRUNK_REF; // an operator override must not re-point the fixture's trunk
    const r = spawnSync("node", [HOOK], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env,
      cwd: repoDir,
    });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch {}
    return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
  }
  const ctx = (o) => o.json?.hookSpecificOutput?.additionalContext || "";
  const dispatch = (prompt = "Investigate the wave.") => ({
    hook_event_name: "PreToolUse",
    tool_name: "Task",
    tool_input: { subagent_type: "general-purpose", prompt },
  });

  const eStale = spawnHook(staleRepo.dir, dispatch());
  const eFresh = spawnHook(freshRepo.dir, dispatch());
  const eBare = spawnHook(bareRepo.dir, dispatch());
  const eOffTool = spawnHook(staleRepo.dir, {
    hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" },
  });

  check("E-01", "END-TO-END: a STALE base produces a NON-EMPTY advisory at the hook boundary",
    ctx(eStale).length > 0,
    `advisory chars=${ctx(eStale).length} exit=${eStale.status}`,
    "M-1 / an inert hook (JSON.parse on the already-parsed payload)");
  check("E-02", "END-TO-END: a FRESH base produces NO advisory",
    ctx(eFresh) === "",
    `exit=${eFresh.status}`,
    "M-1 inverted — the no-false-positive pole at the real boundary");
  check("E-03", "END-TO-END: a NON-dispatch tool produces NO advisory on the SAME stale repo",
    ctx(eOffTool) === "",
    `exit=${eOffTool.status}`,
    "M-3b ONLY (measured): the hook carries its own gate, which ABSORBED the library-only M-3a — the double mutation is what reds this");
  check("E-04", "END-TO-END: a repo with NO remote trunk produces NO advisory",
    ctx(eBare) === "",
    `exit=${eBare.status}`,
    "make absent speak");
  check("E-05", "END-TO-END: EVERY path emits continue:true and exits 0 — this guard never blocks",
    [eStale, eFresh, eBare, eOffTool].every((r) => r.status === 0 && r.json?.continue === true),
    [eStale, eFresh, eBare, eOffTool].map((r) => `exit=${r.status}`).join(" "),
    "raise the severity to block — hook-output-discipline.md MUST-2 forbids it for an ambiguous reading");
  check("E-06", "END-TO-END: the advisory carries all FOUR message points, (d) included",
    /refs\/remotes\/origin\/dev/.test(ctx(eStale)) &&
      ctx(eStale).includes("git fetch origin") &&
      /quiet/i.test(ctx(eStale)) &&
      /re-?derive/i.test(ctx(eStale)),
    "(a)(b)(c)(d) at the real boundary",
    "drop point (d) from the rendered message");
  check("E-07", "END-TO-END: the advisory names the rule_id and the advisory class, never `\"block\"`",
    ctx(eStale).includes(L.RULE_ID_STALE) && ctx(eStale).includes("advisory") &&
      !ctx(eStale).includes('"block"'),
    "severity cap is stated in the emitted text");

  // The THIRD STATE at the real boundary, via the injectable threshold: the fresh repo re-read
  // against a 1-hour bound. Same repo, same commit — only the injected bound moves.
  const eThresholdFires = spawnHook(freshRepo.dir, dispatch(), { [L.THRESHOLD_ENV]: "1" });
  check("E-08", "END-TO-END: the env threshold is LIVE — the same fresh repo fires under a 1h bound",
    ctx(eThresholdFires).length > 0 && ctx(eThresholdFires).includes("1h threshold"),
    `advisory chars=${ctx(eThresholdFires).length}`,
    "ignore the env threshold — then the bound is unreachable from any test");
  check("E-09", "END-TO-END: and is SILENT again under the default bound (bipolar on one repo)",
    ctx(eFresh) === "" && ctx(eThresholdFires) !== "",
    "the env var, not the repo, decided",
    "M-1");

  // UNDETERMINED at the real boundary. The timeout stub used at L-11 is injected THROUGH the
  // library's `gitBin` seam, which a child process cannot reach — and a PATH-planted `git` cannot
  // displace one either, because `resolveGitBinary` tries its ABSOLUTE candidate list first and
  // only falls back to PATH when every candidate misses. So the end-to-end third-state pole is
  // driven through the channel a child process CAN control: a `CLAUDE_PROJECT_DIR` that is not a
  // repository at all, which the shared trunk resolver reports as undetermined, never as absent.
  const noRepoDir = fs.realpathSync(fs.mkdtempSync(path.join(TMP_REAL, "dispatch-freshness-e2e-norepo-")));
  scratch.push(noRepoDir);
  const eUnd = spawnHook(noRepoDir, dispatch());
  check("E-10", "END-TO-END: an UNMEASURABLE base SPEAKS — the third state reaches the operator",
    ctx(eUnd).length > 0 && ctx(eUnd).includes(L.RULE_ID_UNDETERMINED),
    `advisory chars=${ctx(eUnd).length} exit=${eUnd.status}`,
    "M-2: collapse UNDETERMINED into fresh — this is the ONLY case that reds");
  check("E-11", "END-TO-END: the UNDETERMINED advisory says so and does not claim freshness",
    /UNDETERMINED/.test(ctx(eUnd)) && !/\bis fresh\b/i.test(ctx(eUnd)),
    "an unanswerable probe is not an all-clear",
    "M-2");
  check("E-12", "END-TO-END: the UNDETERMINED path still exits 0 with continue:true",
    eUnd.status === 0 && eUnd.json?.continue === true,
    `exit=${eUnd.status}`,
    "never blocks, even when it cannot measure");

  // ISOLATION: the hook is started from exactly ONE place, and every scratch dir is outside the
  // checkout. Without this, a later edit could add a second, unpinned spawn site.
  const SRC = fs.readFileSync(new URL(import.meta.url), "utf8");
  const STARTS = (SRC.match(/\bspawnSync\(/g) || []).length;
  check("E-13", "ISOLATION: exactly ONE hook-spawn site, and every scratch dir sits outside the checkout",
    STARTS === 1 && scratch.every((d) => within(d, TMP_REAL) && !within(d, REPO_REAL)),
    `spawn sites=${STARTS} scratch dirs=${scratch.length}`,
    "a second spawn site that is not pinned to a runner-created directory");
}

let failed = 0;
for (const c of cases) {
  const tag = c.pass ? "PASS" : "FAIL";
  if (!c.pass) failed++;
  process.stdout.write(`${tag}  ${c.id}  ${c.name}  [${c.detail}]\n`);
}
process.stdout.write(`\n${cases.length - failed}/${cases.length} cases pass\n`);
process.exit(failed === 0 ? 0 : 1);
