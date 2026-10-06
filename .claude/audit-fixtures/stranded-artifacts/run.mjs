#!/usr/bin/env node
/**
 * Bipolar fixtures for `hooks/lib/stranded-artifacts.js`.
 *
 * Per `instrument-bipolarity.md`: every gating arm ships a RED pole it MUST
 * reject and a GREEN pole it MUST accept, the harness asserts the two verdicts
 * DIFFER (MUST-1), and each RED pole declares the expected failure IDENTITY —
 * the rule_id, the artifact kind, the path — never merely "something fired"
 * (MUST-2). A pair whose poles agree is VACUOUS and fails here.
 *
 * Fixtures build REAL git repositories. The reachability predicate under test
 * IS git's own `merge-base --is-ancestor`; a mocked git would test the mock.
 * No state files are copied and no `rm -rf` touches a `.git` path — three
 * sibling lanes lost their runs to the trust-posture state-file guard doing
 * exactly that, and the guard was right every time.
 */

import "../_lib/no-ambient-git.cjs";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, devNull } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const LIB = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../hooks/lib/stranded-artifacts.js",
);
const {
  classifyArtifactPath,
  findStrandedArtifacts,
  detectStrandingDestructiveCommand,
  resolveDestructiveTargets,
  explainSweepFailure,
  assessStranding,
  reportLines,
} = require(LIB);
// The GUARD BINARY, not just the predicate. Pairs 11-15 drive this end to end,
// and that is deliberate: the E1 defect was never IN the predicate — the
// predicate's `ref` parameter was correct and complete, the parse was correct
// and complete, and the guard simply never passed one to the other. A
// predicate-only fixture is GREEN against that defect, so it could not be the
// instrument (`instrument-discipline.md` MUST-2(a) — a check that cannot red in
// the defect's presence is not evidence). The wiring is the subject, so the
// process boundary has to be inside the fixture.
const GUARD = path.resolve(path.dirname(LIB), "../stranded-artifact-guard.js");
// The real emitter, not a copy of its head table. Pair 6's rendered-head cases
// assert what the AGENT receives; re-implementing the ternary here would test the
// re-implementation.
const { instructAndWait } = require(
  path.resolve(path.dirname(LIB), "instruct-and-wait.js"),
);

let pass = 0;
let fail = 0;
const failures = [];

/**
 * Emit ONE case line per assertion in the grammar `run-audit-fixtures.mjs`
 * parses (`PASS <name>` / `FAIL <name>`, trailing `\S` required so a summary
 * line is never miscounted as a case). A summary alone is NOT coverage: the
 * harness reported `observed 0 case(s)` against a `min_cases: 30` registry
 * declaration when this printed only a total, which is
 * `coc-artifact-eval-coverage.md` MUST-3 — an exit code over zero executed
 * cases is not evidence.
 */
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    failures.push(`${name}: ${detail}`);
    console.log(`FAIL ${name}`);
  }
}

/**
 * A MONOTONIC fixture clock, and it is load-bearing rather than tidiness.
 *
 * git commit identity is a hash over tree + parents + message + author and
 * committer TIMESTAMPS, and those timestamps have one-second granularity. A
 * `cherry-pick` replaying a commit onto a base that shares its parent, inside
 * the same wall-clock second, therefore reproduces a BYTE-IDENTICAL commit
 * object — `base` and `feature` collapse onto one sha and the branch genuinely
 * becomes an ancestor. The replay poles below then measure nothing, and they do
 * it INTERMITTENTLY: this fixture was observed both ways on the same tree
 * minutes apart, passing its ancestry assertions for the wrong reason.
 *
 * Stamping every commit-producing call with a distinct increasing second makes
 * the replayed object distinct BY CONSTRUCTION, and makes the whole fixture
 * reproducible run to run instead of dependent on how fast the host is.
 */
let fixtureClock = 1600000000;

/**
 * These repos MUST be hermetic, and until now they were not: `git init` gives a
 * repo with no local config, so every commit here ran under the OPERATOR'S
 * global config — including `commit.gpgsign=true`. MEASURED over 40 iterations
 * of the replay shape: 4 failed, each because `gpg failed to sign the data`
 * (pinentry contention) aborted a commit mid-build, leaving a repo whose `base`
 * ref did not exist or whose cherry-pick never landed. The fixture then
 * reported a verdict about a repository that was not the one it meant to build,
 * intermittently, at roughly 1 run in 6.
 *
 * `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` pointed at the null device is the
 * same neutralization `hooks/lib/git-subprocess-env.js::gitEnv()` performs for
 * the production spawns, used here for the same reason: what the fixture
 * measures must not depend on the machine it runs on. `user.email` / `user.name`
 * are set per-repo below, which is repo-LOCAL config and survives this.
 */
function git(dir, args) {
  fixtureClock += 1;
  const stamp = `${fixtureClock} +0000`;
  try {
    return {
      code: 0,
      stdout: execFileSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: devNull,
          GIT_CONFIG_SYSTEM: devNull,
          GIT_TERMINAL_PROMPT: "0",
          GIT_AUTHOR_DATE: stamp,
          GIT_COMMITTER_DATE: stamp,
        },
      }),
    };
  } catch (e) {
    return {
      code: typeof e.status === "number" ? e.status : -1,
      stdout: e.stdout || "",
    };
  }
}

/**
 * Build a repo with a `base` branch standing in for origin/main, plus a feature
 * branch. `files` land on the feature branch only.
 *
 * `replayOntoBase` is the mode the ancestry predicate cannot see: the feature's
 * CONTENT is put on base under DIFFERENT commit objects, so `merge-base
 * --is-ancestor` answers "not reachable" about a branch whose every byte is
 * already in force. `"cherry-pick"` replays commit-by-commit; `"squash"` folds
 * ALL of them into one, which is the shape a patch-id comparison is blind to
 * beyond a single commit and which a TREE comparison sees regardless of count.
 */
function buildRepo({
  files,
  mergeIntoBase = false,
  behindBase = false,
  extraCommits = null,
  replayOntoBase = null,
  supersedeOnBase = null,
}) {
  const dir = mkdtempSync(path.join(tmpdir(), "stranded-"));
  git(dir, ["init", "-q", "."]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(path.join(dir, "README.md"), "seed\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "seed"]);
  git(dir, ["branch", "-f", "base", "HEAD"]);

  git(dir, ["checkout", "-q", "-b", "feature"]);
  for (const [rel, body] of Object.entries(files || {})) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  if (Object.keys(files || {}).length) {
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "author artifacts"]);
  }

  // Further commits on feature, each its own commit. Used to build the
  // MULTI-commit squash pole: a single-commit squash is detectable by patch-id,
  // a two-commit squash is not, so the pole must carry more than one.
  for (const group of extraCommits || []) {
    for (const [rel, body] of Object.entries(group)) {
      const abs = path.join(dir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "further authoring"]);
  }

  if (mergeIntoBase) {
    git(dir, ["checkout", "-q", "base"]);
    git(dir, ["merge", "-q", "--no-edit", "feature"]);
    git(dir, ["checkout", "-q", "feature"]);
  }

  if (replayOntoBase === "cherry-pick") {
    // Same content, different commit objects. `..` enumerates every feature
    // commit not on base, replayed in order.
    git(dir, ["checkout", "-q", "base"]);
    git(dir, ["cherry-pick", "base..feature"]);
    git(dir, ["checkout", "-q", "feature"]);
  }

  if (replayOntoBase === "squash") {
    // N feature commits folded into ONE on base. The tree at base's tip now
    // matches feature's tip byte for byte; no single base commit's patch-id
    // matches any single feature commit's when N > 1.
    git(dir, ["checkout", "-q", "base"]);
    git(dir, ["merge", "-q", "--squash", "feature"]);
    git(dir, ["commit", "-qm", "squashed feature"]);
    git(dir, ["checkout", "-q", "feature"]);
  }

  // Land the feature's content on base and then EVOLVE it there. This is the
  // KNOWN LIMIT the fix does not close, pinned as a case so it is a recorded
  // property rather than a surprise in the field.
  if (supersedeOnBase) {
    git(dir, ["checkout", "-q", "base"]);
    git(dir, ["cherry-pick", "base..feature"]);
    for (const [rel, body] of Object.entries(supersedeOnBase)) {
      writeFileSync(path.join(dir, rel), body);
    }
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "base evolves the artifact further"]);
    git(dir, ["checkout", "-q", "feature"]);
  }

  if (behindBase) {
    // Advance base past feature WITHOUT merging feature, using an ARTIFACT
    // file. The artifact is the whole point: two-dot and three-dot diverge only
    // where base moved, and the divergence is only VISIBLE to this detector
    // when the file base moved with is one the classifier recognizes.
    //
    // An earlier version of this pole advanced base with `unrelated.txt`. It
    // passed under a deliberate two-dot mutation — the pole could not tell the
    // two ranges apart, so it was VACUOUS for the trap it was written to catch.
    git(dir, ["checkout", "-q", "base"]);
    const abs = path.join(dir, BASE_ONLY_ARTIFACT);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, "# landed on base, NOT authored on feature\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "base advances with its own artifact"]);
    git(dir, ["checkout", "-q", "feature"]);
  }

  return { dir, exec: (args) => git(dir, args) };
}

function sweep(repo) {
  return findStrandedArtifacts({ exec: repo.exec, baseRef: "base" });
}

const cleanup = [];
function withRepo(opts, fn) {
  const repo = buildRepo(opts);
  cleanup.push(repo.dir);
  try {
    return fn(repo);
  } finally {
    /* dirs removed at end */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PAIR 1 — reachability. RED: artifact on an unlanded branch. GREEN: merged.
// ─────────────────────────────────────────────────────────────────────────────
const RULE_PATH = ".claude/rules/example-governance.md";
// Authored on BASE only, never on feature. A three-dot range must never
// attribute it to feature; a two-dot range does, which is the trap pair 3 pins.
const BASE_ONLY_ARTIFACT = ".claude/rules/landed-on-base.md";

const redReach = withRepo({ files: { [RULE_PATH]: "# rule\n" } }, (r) =>
  assessStranding({ sweep: sweep(r), surface: "session-close" }),
);
const greenReach = withRepo(
  { files: { [RULE_PATH]: "# rule\n" }, mergeIntoBase: true },
  (r) => assessStranding({ sweep: sweep(r), surface: "session-close" }),
);

// MUST-2: the RED pole asserts an IDENTITY, not a truthy verdict.
check(
  "pair1-red-identity",
  redReach &&
    redReach.rule_id === "artifact-stranding/MUST-1" &&
    redReach.count === 1 &&
    redReach.groups.some(
      (g) => g.kind === "rule" && g.paths.includes(RULE_PATH),
    ),
  `expected rule_id=artifact-stranding/MUST-1 + kind=rule + path=${RULE_PATH}; got ${JSON.stringify(redReach)}`,
);
check("pair1-green-silent", greenReach === null, `expected null; got ${JSON.stringify(greenReach)}`);
// MUST-1: the pair must DIFFER, or it is vacuous.
check(
  "pair1-poles-differ",
  Boolean(redReach) !== Boolean(greenReach),
  "VACUOUS PAIR — both poles produced the same verdict",
);

// ─────────────────────────────────────────────────────────────────────────────
// PAIR 2 — no-false-positive on non-artifact churn.
// ─────────────────────────────────────────────────────────────────────────────
const redMixed = withRepo(
  { files: { "src/app.js": "//\n", [RULE_PATH]: "# rule\n" } },
  (r) => assessStranding({ sweep: sweep(r), surface: "session-close" }),
);
const greenNonArtifact = withRepo({ files: { "src/app.js": "//\n" } }, (r) =>
  assessStranding({ sweep: sweep(r), surface: "session-close" }),
);
check(
  "pair2-red-only-artifact-counted",
  redMixed && redMixed.count === 1 && redMixed.groups[0].kind === "rule",
  `expected exactly the rule counted, not src/app.js; got ${JSON.stringify(redMixed)}`,
);
check(
  "pair2-green-silent",
  greenNonArtifact === null,
  `non-artifact churn must not fire; got ${JSON.stringify(greenNonArtifact)}`,
);
check(
  "pair2-poles-differ",
  Boolean(redMixed) !== Boolean(greenNonArtifact),
  "VACUOUS PAIR",
);

// ─────────────────────────────────────────────────────────────────────────────
// PAIR 3 — the two-dot trap. A branch BEHIND base must not report base's own
// newer commits as stranded artifacts here.
// ─────────────────────────────────────────────────────────────────────────────
const greenBehind = withRepo(
  { files: { "src/app.js": "//\n" }, behindBase: true },
  (r) => assessStranding({ sweep: sweep(r), surface: "session-close" }),
);
const redBehindWithArtifact = withRepo(
  { files: { [RULE_PATH]: "# rule\n" }, behindBase: true },
  (r) => assessStranding({ sweep: sweep(r), surface: "session-close" }),
);
check(
  "pair3-green-behind-base-silent",
  greenBehind === null,
  `a branch behind base with no artifacts of its own must be silent — a two-dot range attributes base's OWN artifact (${BASE_ONLY_ARTIFACT}) to feature; got ${JSON.stringify(greenBehind)}`,
);
// The trap, named as an identity: whatever else it reports, feature must NEVER
// be blamed for the artifact that landed on base.
check(
  "pair3-base-artifact-never-attributed-to-feature",
  !redBehindWithArtifact ||
    !redBehindWithArtifact.groups.some((g) =>
      g.paths.includes(BASE_ONLY_ARTIFACT),
    ),
  `two-dot leak: ${BASE_ONLY_ARTIFACT} landed on base and was attributed to feature; got ${JSON.stringify(redBehindWithArtifact)}`,
);
check(
  "pair3-red-behind-base-still-detects",
  redBehindWithArtifact &&
    redBehindWithArtifact.groups.some((g) => g.paths.includes(RULE_PATH)),
  `three-dot must still see the branch's OWN artifact; got ${JSON.stringify(redBehindWithArtifact)}`,
);
check(
  "pair3-poles-differ",
  Boolean(greenBehind) !== Boolean(redBehindWithArtifact),
  "VACUOUS PAIR",
);

// ─────────────────────────────────────────────────────────────────────────────
// PAIR 4 — destructive-command recognition, parsed not lexical.
// ─────────────────────────────────────────────────────────────────────────────
const redDelete = detectStrandingDestructiveCommand("git branch -D feature");
const greenList = detectStrandingDestructiveCommand("git branch --list");
check(
  "pair4-red-identity",
  redDelete &&
    redDelete.kind === "branch-delete" &&
    redDelete.targets.includes("feature"),
  `expected kind=branch-delete target=feature; got ${JSON.stringify(redDelete)}`,
);
check("pair4-green-silent", greenList === null, `got ${JSON.stringify(greenList)}`);
check(
  "pair4-poles-differ",
  Boolean(redDelete) !== Boolean(greenList),
  "VACUOUS PAIR",
);

const redWorktree = detectStrandingDestructiveCommand(
  "git worktree remove /tmp/wt",
);
check(
  "pair4b-worktree-remove-identity",
  redWorktree &&
    redWorktree.kind === "worktree-remove" &&
    redWorktree.targets.includes("/tmp/wt"),
  `got ${JSON.stringify(redWorktree)}`,
);
check(
  "pair4c-worktree-list-silent",
  detectStrandingDestructiveCommand("git worktree list") === null,
  "worktree list must not fire",
);

// The parsed-signal claim, tested: a quoted mention is NOT an invocation.
check(
  "pair4d-quoted-mention-silent",
  detectStrandingDestructiveCommand('echo "git branch -D feature"') === null,
  "a quoted mention must not fire — this is what separates parsed from lexical",
);

// ─────────────────────────────────────────────────────────────────────────────
// PAIR 5 — classification allowlist.
// ─────────────────────────────────────────────────────────────────────────────
const CLASSIFY_RED = [
  [".claude/rules/x.md", "rule"],
  [".claude/agents/management/y.md", "agent"],
  [".claude/hooks/z.js", "hook"],
  ["specs/methodology/a.md", "spec"],
  ["BURNDOWN.md", "burndown"],
  [".session-notes.d/someoperator.md", "session-notes"],
  ["journal/0584-x.md", "journal"],
];
for (const [p, kind] of CLASSIFY_RED) {
  check(
    `pair5-classify-${kind}`,
    classifyArtifactPath(p) === kind,
    `expected ${kind}; got ${classifyArtifactPath(p)}`,
  );
}
const CLASSIFY_GREEN = ["src/app.js", "README.md", "package.json", "journal/.pending/draft.md"];
for (const p of CLASSIFY_GREEN) {
  check(
    `pair5-classify-null-${p}`,
    classifyArtifactPath(p) === null,
    `expected null for ${p}; got ${classifyArtifactPath(p)}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PAIR 6 — severity is fixed by SURFACE and never escalates to block.
// ─────────────────────────────────────────────────────────────────────────────
const destructiveFinding = withRepo(
  { files: { [RULE_PATH]: "# rule\n" } },
  (r) =>
    assessStranding({
      sweep: sweep(r),
      surface: "destructive",
      destructive: { kind: "branch-delete", targets: ["feature"] },
    }),
);
// The destructive surface is PreToolUse:Bash — the branch-ending command has NOT
// run when the finding is built. `pre-action` is the only register whose rendered
// head says so; `halt-and-report` renders "the action ALREADY RAN", which this
// surface shipped with and which was measured false against a pending
// `git branch -D`. The case is NAMED for the value it pins, so it cannot outlive
// the assertion it makes.
check(
  "pair6-destructive-pre-action",
  destructiveFinding && destructiveFinding.severity === "pre-action",
  `got ${destructiveFinding && destructiveFinding.severity}`,
);
check(
  "pair6-session-close-advisory",
  redReach && redReach.severity === "advisory",
  `got ${redReach && redReach.severity}`,
);
check(
  "pair6-never-block",
  destructiveFinding.severity !== "block" && redReach.severity !== "block",
  "hook-output-discipline.md MUST-2 — this detector must never carry block",
);
// The severity constant is a PROXY for the defect; the DEFECT is the rendered
// head. Pinning the constant alone would stay green if `instruct-and-wait.js`
// stopped gating `pre-action` on PreToolUse, or if `normalizeSeverity` coerced it
// back. So the assertion is driven end-to-end through the real emitter: the head
// the agent actually receives must state the action has NOT run, and must not
// claim it already did. `user_summary` is omitted so this writes no stderr.
const renderedDestructive = instructAndWait({
  hookEvent: "PreToolUse",
  severity: destructiveFinding.severity,
  what_happened: "a branch-delete is pending",
  why: "artifact-stranding/MUST-1",
  agent_must_report: ["name the artifacts"],
  agent_must_wait: "decide whether to land them first",
}).json.hookSpecificOutput.additionalContext;
check(
  "pair6-destructive-head-says-not-yet-run",
  renderedDestructive.includes("has NOT run yet"),
  `PreToolUse head must state the action has not run; got: ${renderedDestructive.split("\n")[0]}`,
);
check(
  "pair6-destructive-head-never-claims-already-ran",
  !renderedDestructive.includes("ALREADY RAN"),
  `PreToolUse head falsely claims the pending command ran; got: ${renderedDestructive.split("\n")[0]}`,
);

// ─────────────────────────────────────────────────────────────────────────────
// FAIL-OPEN — an unresolvable base ref reports nothing, never a finding.
// ─────────────────────────────────────────────────────────────────────────────
const failOpen = withRepo({ files: { [RULE_PATH]: "# rule\n" } }, (r) =>
  findStrandedArtifacts({ exec: r.exec, baseRef: "refs/heads/does-not-exist" }),
);
check(
  "fail-open-unresolvable-base",
  failOpen.ok === false && /base-ref-unresolvable/.test(failOpen.reason),
  `expected ok:false base-ref-unresolvable; got ${JSON.stringify(failOpen)}`,
);
check(
  "fail-open-yields-no-finding",
  assessStranding({ sweep: failOpen, surface: "session-close" }) === null,
  "an unanswerable sweep must produce NO finding in either direction",
);

// ─────────────────────────────────────────────────────────────────────────────
// PAIR 7 — THE ANCESTRY DEFECT. Content replayed onto base under different
// commit objects is IN FORCE; ancestry says it is not.
//
// Measured on this repository's real branches before the fix: 214 of 530
// reported paths (40.4%) were byte-identical at `origin/main`, i.e. the guard
// named them "authored but NOT IN FORCE anywhere else" while their exact bytes
// governed from the default branch. These poles are the fixture form of that.
// ─────────────────────────────────────────────────────────────────────────────
const greenCherry = withRepo(
  { files: { [RULE_PATH]: "# rule\n" }, replayOntoBase: "cherry-pick" },
  (r) => assessStranding({ sweep: sweep(r), surface: "session-close" }),
);
check(
  "pair7-green-cherry-picked-content-is-in-force",
  greenCherry === null,
  `a branch whose artifact content was cherry-picked onto base holds NOTHING stranded — the bytes govern from base. Ancestry cannot see this; got ${JSON.stringify(greenCherry)}`,
);
// The RED partner is `redReach` (same artifact, NOT replayed). Without it this
// pole would pass against a predicate that reports nothing at all.
check(
  "pair7-poles-differ",
  Boolean(redReach) !== Boolean(greenCherry),
  "VACUOUS PAIR — a predicate that never fires would pass the green pole alone",
);

// ─────────────────────────────────────────────────────────────────────────────
// PAIR 8 — MULTI-COMMIT SQUASH. Two feature commits folded into one on base.
// Named separately because it is the case a patch-id comparison is BLIND to:
// no single base commit's patch-id equals any single feature commit's. A TREE
// comparison is indifferent to how many commits carried the bytes.
// ─────────────────────────────────────────────────────────────────────────────
const SECOND_RULE = ".claude/rules/example-second.md";
const greenSquash2 = withRepo(
  {
    files: { [RULE_PATH]: "# rule\n" },
    extraCommits: [{ [SECOND_RULE]: "# second\n" }],
    replayOntoBase: "squash",
  },
  (r) => assessStranding({ sweep: sweep(r), surface: "session-close" }),
);
const redSquashNone = withRepo(
  {
    files: { [RULE_PATH]: "# rule\n" },
    extraCommits: [{ [SECOND_RULE]: "# second\n" }],
  },
  (r) => assessStranding({ sweep: sweep(r), surface: "session-close" }),
);
check(
  "pair8-green-two-commit-squash-silent",
  greenSquash2 === null,
  `TWO feature commits squashed into ONE on base: both artifacts are in force. This is the case patch-id cannot see; got ${JSON.stringify(greenSquash2)}`,
);
check(
  "pair8-red-unsquashed-identity",
  redSquashNone &&
    redSquashNone.count === 2 &&
    redSquashNone.groups.some(
      (g) =>
        g.kind === "rule" &&
        g.paths.includes(RULE_PATH) &&
        g.paths.includes(SECOND_RULE),
    ),
  `the same two artifacts NOT squashed onto base must both report; got ${JSON.stringify(redSquashNone)}`,
);
check(
  "pair8-poles-differ",
  Boolean(greenSquash2) !== Boolean(redSquashNone),
  "VACUOUS PAIR",
);

// ─────────────────────────────────────────────────────────────────────────────
// PAIR 9 — PARTIAL LANDING, asserted as an IDENTITY. A branch holding one
// landed artifact and one genuinely-new one must report EXACTLY the new one.
// A count-only assertion would pass on a predicate that reported the wrong one.
// ─────────────────────────────────────────────────────────────────────────────
const partial = withRepo(
  { files: { [RULE_PATH]: "# rule\n" }, replayOntoBase: "cherry-pick" },
  (r) => {
    // Author a SECOND artifact after the replay: never on base.
    const abs = path.join(r.dir, SECOND_RULE);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, "# genuinely new, never landed\n");
    git(r.dir, ["add", "-A"]);
    git(r.dir, ["commit", "-qm", "post-replay authoring"]);
    return assessStranding({ sweep: sweep(r), surface: "session-close" });
  },
);
check(
  "pair9-partial-reports-only-the-unlanded-one",
  partial &&
    partial.count === 1 &&
    partial.groups.some(
      (g) => g.kind === "rule" && g.paths.includes(SECOND_RULE),
    ),
  `expected exactly ${SECOND_RULE}; got ${JSON.stringify(partial)}`,
);
check(
  "pair9-partial-never-names-the-landed-one",
  partial && !partial.groups.some((g) => g.paths.includes(RULE_PATH)),
  `${RULE_PATH} is byte-identical on base and must NOT be named; got ${JSON.stringify(partial)}`,
);

// ─────────────────────────────────────────────────────────────────────────────
// PAIR 10 — TRI-STATE. When the content pass cannot run, the verdict is an
// explicit UPPER BOUND, never a silent partial set and never a clean zero.
// Driven by an exec that fails ONLY the content-equality call, so the ancestry
// arm still answers and the degradation is isolated to the refinement.
// ─────────────────────────────────────────────────────────────────────────────
const boundRepo = buildRepo({
  files: { [RULE_PATH]: "# rule\n" },
  replayOntoBase: "cherry-pick",
});
cleanup.push(boundRepo.dir);
const twoDotBlinded = (args) => {
  // Fail EXACTLY the content-equality call and nothing else: it is the only
  // `diff --name-only` that names its two endpoints as separate argv entries.
  // The authorship range is `base...HEAD`, a single fused argument, so the
  // ancestry arm keeps answering and the degradation stays isolated to the
  // refinement — which is what makes this a test of the tri-state and not of
  // the sweep failing wholesale.
  if (args[0] === "diff" && args.includes("--name-only") && args.length === 4) {
    return { code: 128, stdout: "" };
  }
  return boundRepo.exec(args);
};
const boundedSweep = findStrandedArtifacts({
  exec: twoDotBlinded,
  baseRef: "base",
});
check(
  "pair10-degraded-pass-is-not-a-clean-zero",
  boundedSweep.ok === true && boundedSweep.stranded.length === 1,
  `a failed content pass must fall back to the ancestry set, never to silence; got ${JSON.stringify(boundedSweep)}`,
);
check(
  "pair10-degraded-pass-is-labelled-an-upper-bound",
  boundedSweep.contentVerified === false,
  `the fallback must be MARKED as unverified so the report can say UPPER BOUND; got contentVerified=${boundedSweep.contentVerified}`,
);
check(
  "pair10-verified-pass-is-labelled-verified",
  sweep(boundRepo).contentVerified === true,
  `the same repo with a working content pass must report contentVerified=true; got ${JSON.stringify(sweep(boundRepo))}`,
);
check(
  "pair10-poles-differ",
  boundedSweep.contentVerified !== sweep(boundRepo).contentVerified,
  "VACUOUS PAIR — the tri-state flag must move between the two runs",
);
const boundedFinding = assessStranding({
  sweep: boundedSweep,
  surface: "session-close",
});
check(
  "pair10-upper-bound-is-stated-in-the-report",
  boundedFinding &&
    reportLines(boundedFinding).some((l) => /UPPER BOUND/.test(l)),
  `the operator must be told the number is an upper bound; got ${JSON.stringify(boundedFinding && reportLines(boundedFinding))}`,
);
// The caveat must be ABSENT on a verified finding, or it is boilerplate that
// carries no information — `redReach` is a genuine, content-verified finding.
check(
  "pair10-verified-report-carries-no-upper-bound-caveat",
  !reportLines(redReach).some((l) => /UPPER BOUND/.test(l)),
  "a content-verified finding must NOT carry the upper-bound caveat, or the caveat means nothing",
);
// An ABSENT flag is not a verified one. A sweep shape this module did not build
// has never been asked the content question, so the claim must degrade to the
// upper bound rather than default to "NOT IN FORCE" — the fail-safe direction
// for a claim, pinned so a later refactor cannot quietly invert it.
const absentFlag = assessStranding({
  sweep: {
    ok: true,
    stranded: [{ path: RULE_PATH, kind: "rule" }],
    branch: "hand-built",
    baseRef: "base",
  },
  surface: "session-close",
});
check(
  "pair10-absent-flag-degrades-to-upper-bound",
  absentFlag &&
    absentFlag.contentVerified === false &&
    reportLines(absentFlag).some((l) => /UPPER BOUND/.test(l)),
  `a sweep with no contentVerified field must NOT be reported as content-verified; got ${JSON.stringify(absentFlag)}`,
);

// ─────────────────────────────────────────────────────────────────────────────
// KNOWN LIMIT, pinned rather than described. Content that landed on base and
// was then EVOLVED there is still reported: its bytes are genuinely not in
// force. The finding is defensible but its wording ("authored but not in
// force") reads as though nothing landed at all. Recorded here so the boundary
// is asserted, and so a future fix changing it must change this case.
// ─────────────────────────────────────────────────────────────────────────────
const superseded = withRepo(
  {
    files: { [RULE_PATH]: "# rule v1\n" },
    supersedeOnBase: { [RULE_PATH]: "# rule v2, evolved on base\n" },
  },
  (r) => assessStranding({ sweep: sweep(r), surface: "session-close" }),
);
check(
  "known-limit-landed-then-superseded-still-reports",
  superseded && superseded.groups.some((g) => g.paths.includes(RULE_PATH)),
  `KNOWN LIMIT changed behaviour: a landed-then-evolved artifact now reports differently; got ${JSON.stringify(superseded)}`,
);

// ═════════════════════════════════════════════════════════════════════════════
// PAIRS 11-15 — THE COMMAND'S TARGET IS THE SUBJECT, NEVER `HEAD`
// (`wip-discipline.md` MUST-5).
//
// MEASURED DEFECT these pin: `git branch -D fix/s39-t1corr-gate2-correctness`,
// against a branch holding 11 unlanded governed artifacts, returned
// `{"continue":true}` — 18 bytes, exit 0, silent — because the destructive arm
// swept `HEAD` while the command named another branch. Every RED pole below is
// built so its stranding branch is NOT `HEAD` and `HEAD` itself strands
// NOTHING, which is exactly the configuration under which the old code was
// silent. `pair11-head-really-is-clean` asserts that precondition rather than
// assuming it — without it, a pole could pass because HEAD happened to be dirty.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A repo whose HEAD (`main`) is CLEAN with respect to `base`, plus arbitrary
 * side branches, worktrees, and an optional bare remote.
 *
 * `branches` maps branch name -> { files, land }. `land: true` merges it into
 * `base`, making it the GREEN pole's target. Everything else stays unlanded.
 */
function buildTargetRepo({ branches = {}, worktrees = [], remote = false }) {
  const dir = mkdtempSync(path.join(tmpdir(), "stranded-tgt-"));
  git(dir, ["init", "-q", "-b", "main", "."]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(path.join(dir, "README.md"), "seed\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "seed"]);
  git(dir, ["branch", "-f", "base", "HEAD"]);

  for (const [name, spec] of Object.entries(branches)) {
    git(dir, ["checkout", "-q", "-b", name, "base"]);
    for (const [rel, body] of Object.entries(spec.files || {})) {
      const abs = path.join(dir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", `author on ${name}`]);
    if (spec.land) {
      git(dir, ["checkout", "-q", "base"]);
      git(dir, ["merge", "-q", "--no-edit", name]);
    }
    git(dir, ["checkout", "-q", "main"]);
  }

  // `main` is reset onto base LAST so it reaches base even after landings. This
  // is the load-bearing precondition: HEAD must strand nothing, or the RED
  // poles below would pass for the wrong reason.
  git(dir, ["checkout", "-q", "main"]);
  git(dir, ["merge", "-q", "--ff-only", "base"]);

  const trees = {};
  const treeRoot = mkdtempSync(path.join(tmpdir(), "stranded-wt-"));
  for (const { name, branch } of worktrees) {
    const wtPath = path.join(treeRoot, name);
    git(dir, ["worktree", "add", "-q", wtPath, branch]);
    trees[name] = wtPath;
  }

  let remotePath = null;
  if (remote) {
    remotePath = mkdtempSync(path.join(tmpdir(), "stranded-remote-"));
    git(remotePath, ["init", "-q", "--bare", "."]);
    git(dir, ["remote", "add", "origin", remotePath]);
    git(dir, ["push", "-q", "origin", "--all"]);
  }

  return { dir, treeRoot, remotePath, trees, exec: (args) => git(dir, args) };
}

/**
 * Drive the guard BINARY with a real PreToolUse payload and read what the agent
 * would actually receive. Returns `{ exit, bytes, fired, ctx, stderr }`.
 *
 * `fired` is `hookSpecificOutput` PRESENCE, which is the honest silence test:
 * the defect's signature was a bare `{"continue":true}`, and `continue` is
 * `true` on EVERY path here (the guard never blocks), so reading `continue`
 * would be a non-discriminating instrument in this rule's own sense.
 */
function runGuard(dir, command, extraEnv = {}) {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      cwd: dir,
      tool_name: "Bash",
      tool_input: { command },
    }),
    encoding: "utf8",
    env: {
      ...process.env,
      COC_STRANDED_BASE_REF: "base",
      ...extraEnv,
    },
  });
  let out = {};
  try {
    out = JSON.parse(r.stdout || "{}");
  } catch {
    out = {};
  }
  const ctx =
    (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || "";
  return {
    exit: r.status,
    bytes: Buffer.byteLength(r.stdout || "", "utf8"),
    continued: out.continue,
    fired: Boolean(out.hookSpecificOutput),
    ctx,
    stderr: r.stderr || "",
  };
}

const VICTIM_RULE = ".claude/rules/victim-governance.md";
const SECOND_VICTIM_RULE = ".claude/agents/victim-agent.md";
const LANDED_RULE = ".claude/rules/landed-governance.md";

// ─────────────────────────────────────────────────────────────────────────────
// PAIR 11 — `git branch -D <non-HEAD branch>`. THE defect, end to end.
// ─────────────────────────────────────────────────────────────────────────────
const r11 = buildTargetRepo({
  branches: {
    victim: { files: { [VICTIM_RULE]: "# unlanded governance\n" } },
    landed: { files: { [LANDED_RULE]: "# landed\n" }, land: true },
  },
});
cleanup.push(r11.dir, r11.treeRoot);

// The PRECONDITION, asserted not assumed. If HEAD strands anything, the RED
// pole below could fire for a reason that has nothing to do with the target.
check(
  "pair11-head-really-is-clean",
  assessStranding({
    sweep: findStrandedArtifacts({ exec: r11.exec, baseRef: "base" }),
    surface: "session-close",
  }) === null,
  "PRECONDITION BROKEN: HEAD itself strands artifacts, so a firing guard proves nothing about the target",
);

const red11 = runGuard(r11.dir, "git branch -D victim");
check(
  "pair11-red-nonhead-target-identity",
  red11.fired &&
    red11.ctx.includes("artifact-stranding/MUST-1") &&
    red11.ctx.includes(VICTIM_RULE) &&
    red11.ctx.includes("'victim'") &&
    /Name the rule\(s\)/.test(red11.ctx),
  `expected rule_id + kind=rule + path=${VICTIM_RULE} + target=victim; got fired=${red11.fired} bytes=${red11.bytes} ctx=${JSON.stringify(red11.ctx)}`,
);
check(
  "pair11-red-head-branch-is-not-the-subject",
  red11.fired && !red11.ctx.includes("on 'main'"),
  `the report must name the TARGET, not HEAD; got ${JSON.stringify(red11.ctx)}`,
);
check(
  "pair11-red-is-pre-action-not-already-ran",
  red11.ctx.includes("has NOT run yet") && !red11.ctx.includes("ALREADY RAN"),
  `PreToolUse head must say the action has not run; got ${JSON.stringify(red11.ctx.split("\n")[0])}`,
);

// GREEN — STAY-SILENT pole. A target that genuinely strands nothing produces NO
// finding: the bare 18-byte passthrough, which here is the CORRECT answer.
const green11 = runGuard(r11.dir, "git branch -D landed");
check(
  "pair11-green-landed-target-stays-silent",
  green11.fired === false && green11.continued === true && green11.exit === 0,
  `a target that strands nothing must produce NO finding; got fired=${green11.fired} bytes=${green11.bytes} ctx=${JSON.stringify(green11.ctx)}`,
);
check(
  "pair11-poles-differ",
  red11.fired !== green11.fired,
  "VACUOUS PAIR — both poles produced the same verdict",
);

// ─────────────────────────────────────────────────────────────────────────────
// PAIR 12 — MULTIPLE names on one command. `git branch -D a b c` ends three
// lanes; assessing only the first is the same silence, two thirds smaller.
// ─────────────────────────────────────────────────────────────────────────────
const r12 = buildTargetRepo({
  branches: {
    victimA: { files: { [VICTIM_RULE]: "# A\n" } },
    victimB: { files: { [SECOND_VICTIM_RULE]: "# B\n" } },
    landed: { files: { [LANDED_RULE]: "# landed\n" }, land: true },
  },
});
cleanup.push(r12.dir, r12.treeRoot);

const red12 = runGuard(r12.dir, "git branch -D victimA victimB landed");
check(
  "pair12-red-names-first-target-with-its-own-artifact",
  red12.fired &&
    red12.ctx.includes("'victimA'") &&
    red12.ctx.includes(VICTIM_RULE),
  `victimA and ${VICTIM_RULE} must both appear; got ${JSON.stringify(red12.ctx)}`,
);
check(
  "pair12-red-names-second-target-with-its-own-artifact",
  red12.fired &&
    red12.ctx.includes("'victimB'") &&
    red12.ctx.includes(SECOND_VICTIM_RULE),
  `victimB and ${SECOND_VICTIM_RULE} must both appear — a guard assessing only the first target passes without this; got ${JSON.stringify(red12.ctx)}`,
);
check(
  "pair12-red-agent-kind-is-classified-not-lumped",
  red12.fired && /Name the agent\(s\): .*victim-agent\.md/.test(red12.ctx),
  `the second target's artifact is an AGENT and must be named as one; got ${JSON.stringify(red12.ctx)}`,
);
check(
  "pair12-red-landed-target-reported-clean-not-stranded",
  red12.fired &&
    !new RegExp(`on 'landed'[^\\n]*NOT IN FORCE`).test(red12.ctx) &&
    !red12.ctx.includes(LANDED_RULE),
  `the landed target must NOT be named as stranding; got ${JSON.stringify(red12.ctx)}`,
);
const green12 = runGuard(r12.dir, "git branch -D landed");
check(
  "pair12-green-all-landed-silent",
  green12.fired === false,
  `got ${JSON.stringify(green12.ctx)}`,
);
check(
  "pair12-poles-differ",
  red12.fired !== green12.fired,
  "VACUOUS PAIR",
);

// ─────────────────────────────────────────────────────────────────────────────
// PAIR 13 — `git worktree remove <path>`. The target is a PATH, so the subject
// is whichever branch is checked out there — a second resolution step the
// branch case does not need.
// ─────────────────────────────────────────────────────────────────────────────
const r13 = buildTargetRepo({
  branches: {
    victim: { files: { [VICTIM_RULE]: "# unlanded\n" } },
    landed: { files: { [LANDED_RULE]: "# landed\n" }, land: true },
  },
  worktrees: [
    { name: "wt-victim", branch: "victim" },
    { name: "wt-landed", branch: "landed" },
  ],
});
cleanup.push(r13.dir, r13.treeRoot);

const red13 = runGuard(r13.dir, `git worktree remove ${r13.trees["wt-victim"]}`);
check(
  "pair13-red-worktree-remove-identity",
  red13.fired &&
    red13.ctx.includes("artifact-stranding/MUST-1") &&
    red13.ctx.includes(VICTIM_RULE) &&
    red13.ctx.includes("'victim'"),
  `expected the branch checked out at the target PATH to be assessed; got fired=${red13.fired} ctx=${JSON.stringify(red13.ctx)}`,
);
check(
  "pair13-red-names-the-pending-path",
  red13.fired && red13.ctx.includes(r13.trees["wt-victim"]),
  `the report must name WHICH target path is pending; got ${JSON.stringify(red13.ctx)}`,
);
const green13 = runGuard(r13.dir, `git worktree remove ${r13.trees["wt-landed"]}`);
check(
  "pair13-green-worktree-on-landed-branch-silent",
  green13.fired === false,
  `got ${JSON.stringify(green13.ctx)}`,
);
check("pair13-poles-differ", red13.fired !== green13.fired, "VACUOUS PAIR");

// ─────────────────────────────────────────────────────────────────────────────
// PAIR 14 — `git push <remote> --delete <b>` AND the `:b` refspec form. Both
// shapes the parser already recognised, neither of which was ever assessed.
// ─────────────────────────────────────────────────────────────────────────────
const r14 = buildTargetRepo({
  branches: {
    victim: { files: { [VICTIM_RULE]: "# unlanded\n" } },
    landed: { files: { [LANDED_RULE]: "# landed\n" }, land: true },
  },
  remote: true,
});
cleanup.push(r14.dir, r14.treeRoot, r14.remotePath);

const red14flag = runGuard(r14.dir, "git push origin --delete victim");
check(
  "pair14-red-push-delete-flag-form-identity",
  red14flag.fired &&
    red14flag.ctx.includes("artifact-stranding/MUST-1") &&
    red14flag.ctx.includes(VICTIM_RULE) &&
    red14flag.ctx.includes("origin/victim"),
  `expected the remote-tracking ref origin/victim to be the assessed subject; got fired=${red14flag.fired} ctx=${JSON.stringify(red14flag.ctx)}`,
);
const red14refspec = runGuard(r14.dir, "git push origin :victim");
check(
  "pair14-red-push-delete-refspec-form-identity",
  red14refspec.fired &&
    red14refspec.ctx.includes(VICTIM_RULE) &&
    red14refspec.ctx.includes("origin/victim"),
  `the \`:branch\` refspec form must resolve the same subject as --delete; got fired=${red14refspec.fired} ctx=${JSON.stringify(red14refspec.ctx)}`,
);
const green14 = runGuard(r14.dir, "git push origin --delete landed");
check(
  "pair14-green-push-delete-landed-silent",
  green14.fired === false,
  `got ${JSON.stringify(green14.ctx)}`,
);
check(
  "pair14-poles-differ",
  red14flag.fired !== green14.fired && red14refspec.fired !== green14.fired,
  "VACUOUS PAIR",
);

// ─────────────────────────────────────────────────────────────────────────────
// PAIR 15 — UNRESOLVABLE TARGET. Fails OPEN (`cc-artifacts.md` Rule 7) and is
// NEVER reported as clean. This is the pole that separates "I looked and found
// nothing" from "I could not look" — the two states whose collapse into one
// 18-byte passthrough is the whole failure class.
// ─────────────────────────────────────────────────────────────────────────────
const unknown15 = runGuard(r11.dir, "git branch -D no-such-branch");
check(
  "pair15-unresolvable-target-is-reported-indeterminate",
  unknown15.fired &&
    unknown15.ctx.includes("no-such-branch") &&
    /INDETERMINATE/.test(unknown15.ctx) &&
    /NOT a report of zero stranded artifacts/.test(unknown15.ctx),
  `an unassessable target must be surfaced as UNKNOWN, never folded into silence; got fired=${unknown15.fired} ctx=${JSON.stringify(unknown15.ctx)}`,
);
check(
  "pair15-unresolvable-target-fails-open",
  unknown15.continued === true && unknown15.exit === 0,
  `fail-open: the command must still be allowed to proceed; got continue=${unknown15.continued} exit=${unknown15.exit}`,
);
check(
  "pair15-unresolvable-target-is-weaker-than-a-finding",
  unknown15.ctx.includes("advisory") ||
    !unknown15.ctx.includes("has NOT run yet"),
  `"could not look" must not present with the weight of "found work"; got ${JSON.stringify(unknown15.ctx.split("\n")[0])}`,
);
// A `-C <dir>` invocation names refs in ANOTHER repository. Answering from this
// one would be a confident verdict about the wrong repo.
const foreign15 = runGuard(r11.dir, "git -C /nonexistent-repo branch -D victim");
check(
  "pair15-foreign-repo-C-is-unknown-not-clean",
  foreign15.fired && /INDETERMINATE/.test(foreign15.ctx),
  `a -C invocation targets another repo and must NOT be silently assessed here; got fired=${foreign15.fired} ctx=${JSON.stringify(foreign15.ctx)}`,
);
check(
  "pair15-foreign-repo-C-is-not-assessed-against-this-repo",
  !foreign15.ctx.includes(VICTIM_RULE),
  `the local branch 'victim' must NOT be assessed for a -C command naming another repo; got ${JSON.stringify(foreign15.ctx)}`,
);
// GREEN partner: the same guard, same repo, a RESOLVABLE clean target — truly
// silent. Without it the three poles above would pass against a guard that
// reported INDETERMINATE for everything.
check(
  "pair15-poles-differ",
  unknown15.fired !== green11.fired && foreign15.fired !== green11.fired,
  "VACUOUS PAIR — a guard that reported UNKNOWN unconditionally would pass the red poles alone",
);

// ─────────────────────────────────────────────────────────────────────────────
// PAIR 16 — the resolver, at predicate level. Every parsed target yields
// EXACTLY ONE row, so a target can never vanish silently between parse and
// report, and every UNKNOWN carries a remedy-shaped reason rather than falling
// through to "Unrecognized sweep-failure reason".
// ─────────────────────────────────────────────────────────────────────────────
const rows16 = resolveDestructiveTargets({
  exec: r12.exec,
  destructive: detectStrandingDestructiveCommand(
    "git branch -D victimA victimB nope",
  ),
  cwd: r12.dir,
});
check(
  "pair16-every-target-yields-exactly-one-row",
  rows16.length === 3 &&
    rows16.map((r) => r.target).join(",") === "victimA,victimB,nope",
  `expected one row per target in order; got ${JSON.stringify(rows16.map((r) => r.target))}`,
);
check(
  "pair16-resolvable-targets-carry-a-ref",
  rows16[0].ref === "refs/heads/victimA" &&
    rows16[1].ref === "refs/heads/victimB",
  `got ${JSON.stringify(rows16.slice(0, 2))}`,
);
check(
  "pair16-unresolvable-target-carries-a-named-reason",
  rows16[2].ref === null && rows16[2].unresolved === "no-such-branch:nope",
  `got ${JSON.stringify(rows16[2])}`,
);
// A TAG must not be swept in a branch's place: `git branch -D` would never
// delete it, so a verdict about it is a verdict about the wrong object.
git(r12.dir, ["tag", "v-decoy", "victimA"]);
const tagRows = resolveDestructiveTargets({
  exec: r12.exec,
  destructive: detectStrandingDestructiveCommand("git branch -D v-decoy"),
  cwd: r12.dir,
});
check(
  "pair16-a-tag-is-not-resolved-as-a-branch",
  tagRows[0].ref === null && tagRows[0].unresolved === "no-such-branch:v-decoy",
  `a tag of that name must NOT be swept in the branch's place; got ${JSON.stringify(tagRows[0])}`,
);
for (const reason of [
  "no-such-branch:x",
  "foreign-repo:/other",
  "no-worktree-at:/tmp/x",
  "worktree-head-unknown:/tmp/x",
  "no-such-remote-branch:origin/x",
  "unrecognized-kind:z",
  "worktree-list-failed",
  "no-sweep-result",
]) {
  check(
    `pair16-remedy-exists-for-${reason.split(":")[0]}`,
    !/^Unrecognized sweep-failure reason/.test(explainSweepFailure(reason)) &&
      explainSweepFailure(reason).length > 40,
    `every minted reason needs a remedy-shaped row; '${reason}' fell through to: ${explainSweepFailure(reason)}`,
  );
}

// ---------------------------------------------------------------------------
// PAIR 17 — a SHELL REDIRECTION is not a command target.
//
// THE DEFECT, observed live five times in one session before it was fixed:
// `git worktree remove <path> 2>&1` parsed to targets `[<path>, "2>&1"]`, and
// the guard faithfully reported that the target `2>&1` "could NOT be assessed
// (no-worktree-at:2>&1) ... This is INDETERMINATE". Every clause of that
// sentence was true of a target that never existed. The cost is not noise: this
// is the one surface that names artifacts about to be stranded, and an
// INDETERMINATE line on every redirected command teaches the reader to skip it.
//
// The RED pole is the redirection; the GREEN pole is the QUOTED lookalike, and
// the pairing is the point. `git branch -D "2>&1"` names a (legal, absurd)
// branch, and after the tokenizer consumes the quotes both shapes carry the
// identical token VALUE. So a fix that filtered on the value would pass the red
// pole by deleting a real target — silently, and exactly where the operator
// most needs the target named. The two poles are what separate the fix from
// that near-miss; a pair carrying only the red one cannot tell them apart.
// A NULL detection is a legitimate verdict here ("no destructive command"), and
// under the near-miss fix below it is exactly what a deleted target produces —
// no positionals left, so no command is recognized at all. Normalizing it to an
// empty target list is what lets that case FAIL BY NAME instead of throwing:
// measured, an unguarded `.targets` aborted this file at the first green pole,
// and an abort names no identity, which is `instrument-bipolarity.md` MUST-2.
const rd = (cmd) => detectStrandingDestructiveCommand(cmd) || { targets: [] };

check(
  "pair17-red-redirection-token-is-not-a-target",
  JSON.stringify(rd("git branch -D victimA 2>&1").targets) ===
    JSON.stringify(["victimA"]),
  `'2>&1' is shell plumbing, never an argument; got ${JSON.stringify(rd("git branch -D victimA 2>&1").targets)}`,
);
check(
  "pair17-green-quoted-lookalike-is-still-a-real-target",
  JSON.stringify(rd('git branch -D "2>&1"').targets) ===
    JSON.stringify(["2>&1"]),
  `a QUOTED 2>&1 is a branch name and MUST survive — this is the pole a value-matching fix fails; got ${JSON.stringify(rd('git branch -D "2>&1"').targets)}`,
);
// Every redirection spelling the shell accepts at the head of a word, including
// the separated form whose OPERAND is its own word. Stripping the operator but
// leaving `/dev/null` behind would trade a `>` target for a `/dev/null` target
// — the same defect under a name plausible enough to pass review.
for (const [label, suffix] of [
  ["dup-fd", "2>&1"],
  ["truncate-separated", "> /dev/null"],
  ["truncate-attached", ">/dev/null"],
  ["append-separated", ">> log.txt"],
  ["append-attached", ">>log.txt"],
  ["fd2-separated", "2> err.txt"],
  ["fd2-append-attached", "2>>err.txt"],
  ["both-fds", "&> all.log"],
  ["stdin", "< in.txt"],
  ["clobber", ">| clobber.txt"],
  ["chained", "> /dev/null 2>&1"],
]) {
  const got = rd(`git branch -D victimA ${suffix}`).targets;
  check(
    `pair17-red-strips-${label}`,
    JSON.stringify(got) === JSON.stringify(["victimA"]),
    `'${suffix}' must leave exactly the real target; got ${JSON.stringify(got)}`,
  );
}
check(
  "pair17-red-worktree-remove-redirection-is-not-a-target",
  JSON.stringify(rd("git worktree remove /tmp/wt 2>&1").targets) ===
    JSON.stringify(["/tmp/wt"]),
  `the shape observed live; got ${JSON.stringify(rd("git worktree remove /tmp/wt 2>&1").targets)}`,
);
check(
  "pair17-red-push-delete-redirection-is-not-a-target",
  JSON.stringify(rd("git push origin --delete victimA 2>&1").targets) ===
    JSON.stringify(["victimA"]),
  `swept in the same change so no sibling arm keeps the defect; got ${JSON.stringify(rd("git push origin --delete victimA 2>&1").targets)}`,
);
// This case was authored to pin the recognizer's ORIGINAL word-start-only
// limit, asserting `["foo>out"]`. It RED when the adversarial review of that
// fix showed the limit was a fail-OPEN in the verb slot (see pair 18) and the
// scope was widened — which is precisely the job it was written to do: the
// widening had to be argued and measured rather than absorbed silently. It now
// pins the argued contract, which is bash's own: the word ends at the operator,
// and the prefix survives as a real target.
check(
  "pair17-midword-angle-bracket-splits-the-word-and-keeps-the-prefix",
  JSON.stringify(rd("git branch -D foo>out").targets) ===
    JSON.stringify(["foo"]),
  `bash deletes 'foo' and redirects to 'out'; got ${JSON.stringify(rd("git branch -D foo>out").targets)}`,
);
// The list/pipeline separators were ALREADY handled, by the segment splitter
// upstream of the tokenizer. Asserted rather than assumed, so that if a future
// change moves that responsibility the loss shows up here.
for (const [label, cmd] of [
  ["pipe", "git branch -D victimA | cat"],
  ["andand", "git branch -D victimA && echo done"],
  ["semi", "git branch -D victimA; echo done"],
]) {
  check(
    `pair17-separator-${label}-unchanged`,
    JSON.stringify(rd(cmd).targets) === JSON.stringify(["victimA"]),
    `got ${JSON.stringify(rd(cmd).targets)}`,
  );
}
// End to end through the GUARD BINARY, not the predicate alone: the report line
// is what the operator reads, and it is where the phantom target appeared.
const red17 = runGuard(r12.dir, "git branch -D victimA 2>&1");
check(
  "pair17-red-guard-still-names-the-real-target",
  red17.fired && red17.ctx.includes("'victimA'") && red17.ctx.includes(VICTIM_RULE),
  `stripping the redirect must not silence the real finding; got ${JSON.stringify(red17.ctx)}`,
);
check(
  "pair17-red-guard-emits-no-indeterminate-for-the-redirect",
  red17.fired && !red17.ctx.includes("2>&1"),
  `the phantom target must be absent from the report; got ${JSON.stringify(red17.ctx)}`,
);
const green17 = runGuard(r12.dir, "git branch -D landed 2>&1");
check(
  "pair17-green-all-landed-with-redirection-is-silent",
  !green17.fired,
  `a redirected command over a landed branch must stay silent; got ${JSON.stringify(green17.ctx)}`,
);
check(
  "pair17-poles-differ",
  red17.fired !== green17.fired,
  "poles agree — the pair measures nothing (instrument-bipolarity.md MUST-1)",
);

// ---------------------------------------------------------------------------
// PAIR 18 — a redirection MID-WORD, and the process-substitution exclusion.
//
// Pair 17 fixed redirections that OPEN a word. The adversarial review of that
// fix found the other half, PRE-EXISTING on `origin/main` and strictly worse:
// `<` and `>` are shell METACHARACTERS, so bash ends the current word at one
// wherever it appears. `git branch>/dev/null -D victimA` therefore runs a real
// branch delete, while the parser read the verb as `branch>/dev/null` — which
// matched no destructive shape at all, so this guard was SILENT on a delete
// that strands artifacts. That is a fail-OPEN, not the noisy fail-CLOSED pair 17
// removed, and the quoted spelling `git branch -D "victimA">out` reached it
// through a closing quote rather than a bare word.
//
// The third case is the exclusion that keeps the widening honest: process
// substitution `<(cmd)` expands to a `/dev/fd/N` ARGUMENT, so a recognizer that
// matched its leading bracket would DELETE half a real operand — the one
// outcome this recognizer must never produce, and the reason the mid-word
// widening is safe to make at all.
check(
  "pair18-red-midword-redirect-no-longer-hides-the-verb",
  JSON.stringify(rd("git branch>/dev/null -D victimA").targets) ===
    JSON.stringify(["victimA"]),
  `a mid-word redirect must not hide a real branch delete; got ${JSON.stringify(rd("git branch>/dev/null -D victimA").targets)}`,
);
check(
  "pair18-red-redirect-after-a-closing-quote-is-not-part-of-the-target",
  JSON.stringify(rd('git branch -D "victimA">out').targets) ===
    JSON.stringify(["victimA"]),
  `bash deletes 'victimA' and redirects to 'out'; got ${JSON.stringify(rd('git branch -D "victimA">out').targets)}`,
);
check(
  "pair18-red-midword-worktree-remove-is-still-assessed",
  JSON.stringify(rd("git worktree>/dev/null remove /tmp/wt").targets) ===
    JSON.stringify(["/tmp/wt"]),
  `got ${JSON.stringify(rd("git worktree>/dev/null remove /tmp/wt").targets)}`,
);
check(
  "pair18-green-process-substitution-operand-is-not-stripped",
  rd("git branch -D <(echo victimA)").targets.some((t) => t.includes("<(")),
  `process substitution is an ARGUMENT, not plumbing — stripping it deletes a real operand; got ${JSON.stringify(rd("git branch -D <(echo victimA)").targets)}`,
);
// End to end through the GUARD BINARY: the mid-word form previously produced
// NO report at all, which is the pole that separates this pair from pair 17.
const red18 = runGuard(r12.dir, "git branch>/dev/null -D victimA");
check(
  "pair18-red-guard-fires-on-the-midword-form",
  red18.fired && red18.ctx.includes("'victimA'") && red18.ctx.includes(VICTIM_RULE),
  `the guard was SILENT on this shape before the fix; got ${JSON.stringify(red18.ctx)}`,
);
const green18 = runGuard(r12.dir, "git branch>/dev/null -D landed");
check(
  "pair18-green-midword-form-over-a-landed-branch-is-silent",
  !green18.fired,
  `got ${JSON.stringify(green18.ctx)}`,
);
check(
  "pair18-poles-differ",
  red18.fired !== green18.fired,
  "poles agree — the pair measures nothing (instrument-bipolarity.md MUST-1)",
);

for (const d of cleanup) {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

console.log(`stranded-artifacts fixtures: ${pass} pass, ${fail} fail`);
if (fail) {
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
process.exit(0);
