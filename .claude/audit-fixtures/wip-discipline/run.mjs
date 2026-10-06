#!/usr/bin/env node
/**
 * Bipolar fixtures for `rules/wip-discipline.md`'s STRUCTURAL surface —
 * `hooks/lib/wip-lanes.js` (the lane model) and `hooks/wip-discipline-guard.js`
 * (the two arms: a WIP limit at `PreToolUse:Task|Agent`, an aged-lane report at
 * `SessionStart`).
 *
 * Per `instrument-bipolarity.md`: every gating arm ships a RED pole it MUST fire
 * on and a GREEN pole it MUST stay silent on, the harness ASSERTS THE TWO
 * VERDICTS DIFFER (MUST-1) — a pair whose poles agree is VACUOUS and fails here
 * — and each RED pole declares the expected failure IDENTITY (MUST-2): the
 * rule_id and clause, the lane or tree it fired on, and the severity register
 * the agent actually receives. A non-zero exit, a non-empty string or a case
 * count is NOT an identity and is never accepted as one.
 *
 * REAL GIT, NOT A MOCK. The predicates under test ARE git's own answers:
 * `for-each-ref --no-merged`, `cherry`'s patch-ids, remote-tip set membership,
 * the presence of a `--no-checkout` worktree's index file. A mocked git would
 * test the mock — and MUST-6 exists precisely because the SHAPE of git's real
 * answer (every path in HEAD reported as a staged deletion when no index file
 * exists) is what the previous predicate misread. That shape is reproduced here
 * by building the tree git actually builds.
 *
 * THE GUARD IS EXERCISED END-TO-END, over stdin, as the harness runs it. The
 * severity register is the reason: `pre-action` vs `halt-and-report` is a
 * CONSTANT in the guard, but the DEFECT it fixes is the rendered head the agent
 * reads ("the action ALREADY RAN" against a dispatch that has not run). Pinning
 * the constant alone would stay green if `instruct-and-wait.js` stopped gating
 * `pre-action` on PreToolUse. So the assertion is on the rendered text.
 *
 * NO STATE FILE IS TOUCHED and no `rm -rf` reaches a `.git` path inside this
 * repository: every repo built here lives under `os.tmpdir()`.
 */

import "../_lib/no-ambient-git.cjs";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  existsSync,
  symlinkSync,
  realpathSync,
  readFileSync,
  statSync,
  readdirSync,
} from "node:fs";
import { tmpdir, devNull } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { assertArmsFire, selfProof } from "../_lib/arm-coverage.mjs";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, "../../hooks/lib/wip-lanes.js");
const GUARD = path.resolve(HERE, "../../hooks/wip-discipline-guard.js");

const {
  WIP_LIMIT,
  AGE_BOUND_HOURS,
  classifyTree,
  agedLanes,
  ageDistribution,
  laneCountFast,
  confirmAtLimit,
  confirmAgedLane,
  wipVerdict,
  hasNoIndex,
} = require(LIB);

/**
 * The operator running this suite is, by construction, the person most likely
 * to have set the escape hatch after hitting the block — and inheriting it
 * would make every teeth fixture below pass through, leaving the suite green
 * while testing nothing. Stripped from the base env; only the explicit
 * `<escape>` rows opt back in. Same reasoning `nested-worktree-guard/run.mjs`
 * records for `COC_ALLOW_NESTED_WORKTREE`.
 */
const ESCAPE_ENV = "COC_ALLOW_WIP_OVERRUN";
const RECEIPT_REL = path.join(".claude", "wip-authz", "wip-limit-allow");
const BASE_ENV = { ...process.env };
delete BASE_ENV[ESCAPE_ENV];

let pass = 0;
let fail = 0;
const failures = [];

/**
 * One case line per assertion, in the grammar `run-audit-fixtures.mjs` parses
 * (`PASS <name>` / `FAIL <name>`, trailing `\S` required so the summary line is
 * never miscounted as a case). A summary alone is NOT coverage
 * (`coc-artifact-eval-coverage.md` MUST-3: an exit code over zero executed cases
 * is not evidence), which is what `min_cases` in `ci-audit-fixtures.json`
 * enforces against this output.
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
 * MUST-1 in one call: the two poles must produce DIFFERENT verdicts. Passing
 * both poles separately does not establish this — a predicate that never fires
 * passes every silent pole, and one that always fires passes every loud one.
 */
function polesDiffer(name, redVerdict, greenVerdict) {
  check(
    name,
    redVerdict !== greenVerdict,
    `VACUOUS PAIR — both poles produced the same verdict (${JSON.stringify(redVerdict)})`,
  );
}

// ── hermetic git ────────────────────────────────────────────────────────────
//
// `git init` inherits the OPERATOR'S global config, including `commit.gpgsign`.
// A sibling fixture measured 4 failures in 40 runs from pinentry contention
// aborting a commit mid-build, after which the fixture reported a verdict about
// a repository that was not the one it meant to build. The null-device config
// pins is the same neutralization `hooks/lib/git-subprocess-env.js::gitEnv()`
// performs for the production spawns, for the same reason.
function git(dir, args, { date } = {}) {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_TERMINAL_PROMPT: "0",
  };
  if (date) {
    env.GIT_AUTHOR_DATE = date;
    env.GIT_COMMITTER_DATE = date;
  }
  try {
    return {
      code: 0,
      stdout: execFileSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env,
      }),
    };
  } catch (e) {
    return { code: typeof e.status === "number" ? e.status : -1, stdout: e.stdout || "" };
  }
}

const cleanup = [];
const NOW = Date.now();
const stampHoursAgo = (h) => `${Math.floor((NOW - h * 3_600_000) / 1000)} +0000`;

/**
 * Build a repo whose `origin/main` is a REAL remote-tracking ref.
 *
 * The base ref matters: `laneCountFast` and `laneSurvey` both resolve
 * `origin/main`, and when it does not resolve they return `ok:false`. That is
 * the UNKNOWN pole (`withRemote:false` below) and it is a DIFFERENT state from
 * "no lanes" — the distinction `instrument-discipline.md` MUST-1 names and the
 * module's own header commits to.
 *
 * `lanes` is a list of `{ name, ageHours, push }`. Each gets ONE commit
 * carrying a unique file, stamped at `ageHours` before now so the age the
 * survey reads is the one this fixture chose, never the wall clock.
 */
function buildRepo({ lanes = [], withRemote = true, landContent = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "wip-disc-"));
  cleanup.push(root);
  const work = path.join(root, "work");
  mkdirSync(work, { recursive: true });

  git(root, ["init", "-q", "--bare", "origin.git"]);
  git(work, ["init", "-q", "."]);
  git(work, ["config", "user.email", "t@t"]);
  git(work, ["config", "user.name", "t"]);
  writeFileSync(path.join(work, "README.md"), "seed\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-qm", "seed"], { date: stampHoursAgo(500) });
  git(work, ["branch", "-M", "main"]);

  if (withRemote) {
    git(work, ["remote", "add", "origin", path.join(root, "origin.git")]);
    git(work, ["push", "-q", "-u", "origin", "main"]);
  }

  for (const lane of lanes) {
    git(work, ["checkout", "-q", "-b", lane.name, "main"]);
    writeFileSync(path.join(work, `${lane.name.replace(/\//g, "_")}.txt`), `${lane.name}\n`);
    git(work, ["add", "-A"]);
    git(work, ["commit", "-qm", `work on ${lane.name}`], {
      date: stampHoursAgo(lane.ageHours ?? 1),
    });
    if (withRemote && lane.push) git(work, ["push", "-q", "-u", "origin", lane.name]);
  }
  git(work, ["checkout", "-q", "main"]);

  // THE ANCESTRY-VS-CONTENT GAP, BUILT RATHER THAN ASSERTED.
  //
  // Cherry-picking each lane's commit onto main gives main a PATCH-EQUIVALENT
  // commit under a DIFFERENT sha. `for-each-ref --no-merged origin/main` still
  // lists every lane (none is an ancestor of the new main), so the FAST count
  // reads at the limit — while `git cherry origin/main <lane>` emits `-` for
  // each, so the CONTENT count is zero. This is the exact population loom#1885
  // measured at 16 of 99, and the only shape that can tell a guard blocking on
  // the upper bound apart from one blocking on the lower bound.
  if (landContent) {
    for (const lane of lanes) {
      const sha = git(work, ["rev-parse", lane.name]).stdout.trim();
      git(work, ["cherry-pick", "-x", sha], { date: stampHoursAgo(1) });
    }
    if (withRemote) git(work, ["push", "-q", "origin", "main"]);
  }

  return { root, work };
}

/**
 * Run the SHIPPED guard exactly as the harness does: a JSON payload on stdin,
 * one JSON object on stdout. Returns the parsed object plus the rendered
 * advisory (or `null` when the guard stayed silent), so every assertion below
 * reads what the AGENT receives rather than an internal constant.
 */
function runGuard(payload, env = {}) {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 20000,
    env: { ...BASE_ENV, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, ...env },
  });
  let json = null;
  try {
    json = JSON.parse((r.stdout || "").trim().split("\n").filter(Boolean).pop() || "");
  } catch {
    json = null;
  }
  // A BLOCK does not travel on `additionalContext`. Once the call is denied the
  // host stops reading that field, so `instruct-and-wait.js` puts the body on
  // `permissionDecisionReason` (and stderr) instead. Reading only the first
  // channel would score every block as "the guard stayed silent" — an
  // instrument that reports the opposite of what happened.
  const hso = (json && json.hookSpecificOutput) || null;
  const ctx =
    (hso && hso.additionalContext) ||
    (hso && hso.permissionDecisionReason) ||
    (json && json.systemMessage) ||
    null;
  const blocked =
    r.status === 2 || Boolean(json && json.continue === false);
  return { status: r.status, json, advisory: ctx, blocked, stderr: r.stderr || "" };
}

/** Did the guard produce a finding at all? The single verdict the pair-differ
 *  assertions compare, so a "fired" pole and a "silent" pole cannot collapse. */
const fired = (g) => g.advisory !== null;

/**
 * THE PAYLOAD A LANE-OPENING CALL ARRIVES AS — and there is now exactly ONE.
 *
 * Every case below that needs the guard to reach `runSpawnGuard` builds its
 * payload here instead of hand-rolling a `tool_name: "Task"` one. That arm was
 * DEREGISTERED on 2026-08-29 by `b77a71603` ("the ceiling counts INVENTORY, not
 * WORKERS") and its code was removed from the guard in the same lane that wrote
 * this helper, because a branch on a tool name no registered matcher delivers
 * reads as enforcement and cannot fire.
 *
 * The cases that used `Task` as a VEHICLE — the receipt economics, the env
 * channel, the severity registers, the fail-open paths, the override ledger —
 * lose nothing by moving: they were never about dispatch, they were about what
 * `runSpawnGuard` does once a door asks it. The cases that were genuinely ABOUT
 * the dispatch arm (the capability predicate, the shadowed-name fail-closed, the
 * `Agent` tool name) are DELETED with the arm rather than re-pointed, because
 * re-pointing them would assert a contract that no longer exists.
 */
const laneOpenPayload = (cwd, extra = {}) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "git worktree add ../new-lane -b feat/another" },
  cwd,
  ...extra,
});

// ── the one-shot override receipt (agent-reachable channel) ─────────────────
//
// Written INSIDE the hermetic fixture repo, never in this checkout: the guard
// resolves candidates against the payload's `cwd` and that repo's own
// `--git-common-dir`, both of which are the tmp repo here. Nothing under
// `.claude/` in the real tree is read or written by these rows.
function writeReceipt(repoWork, reason) {
  const p = path.join(repoWork, RECEIPT_REL);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, reason);
  return p;
}
function receiptExists(repoWork) {
  return existsSync(path.join(repoWork, RECEIPT_REL));
}

// ═══════════════════════════════════════════════════════════════════════════
// CONTRACT PINS — the two thresholds are stated in the RULE BODY, so a change
// here without a change there is the prose-vs-code drift `zero-tolerance.md`
// Rule 3e blocks. Pinned as cases so the drift is loud rather than discovered.
// ═══════════════════════════════════════════════════════════════════════════
check("contract-wip-limit-is-5", WIP_LIMIT === 5, `rules/wip-discipline.md MUST-2 states 5; module exports ${WIP_LIMIT}`);
check("contract-age-bound-is-24h", AGE_BOUND_HOURS === 24, `rules/wip-discipline.md MUST-3 states 24; module exports ${AGE_BOUND_HOURS}`);

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 1 — MUST-2, the WIP LIMIT AT SPAWN.
// RED: a dispatch at the limit. GREEN: a dispatch under it.
// ═══════════════════════════════════════════════════════════════════════════
const overLimit = buildRepo({
  lanes: Array.from({ length: WIP_LIMIT }, (_, i) => ({
    name: `feat/lane-${String(i + 1).padStart(2, "0")}`,
    ageHours: 2 + i,
  })),
});
const underLimit = buildRepo({
  lanes: [{ name: "feat/only-one", ageHours: 2 }],
});

const redLimit = runGuard(laneOpenPayload(overLimit.work));
const greenLimit = runGuard(laneOpenPayload(underLimit.work));

// MUST-2 of instrument-bipolarity: the RED pole names an IDENTITY.
check(
  "pair1-red-cites-clause-identity",
  Boolean(redLimit.advisory) && redLimit.advisory.includes("wip-discipline/MUST-2"),
  `expected the advisory to cite wip-discipline/MUST-2; got ${JSON.stringify(redLimit.advisory)}`,
);
check(
  "pair1-red-states-count-and-limit",
  Boolean(redLimit.advisory) &&
    redLimit.advisory.includes(`${WIP_LIMIT} open lanes against a limit of ${WIP_LIMIT}`),
  `expected the count stated against the limit; got ${JSON.stringify(redLimit.advisory)}`,
);
check(
  "pair1-red-names-a-specific-lane",
  Boolean(redLimit.advisory) && /feat\/lane-0\d/.test(redLimit.advisory),
  `MUST-3 forbids a bare count — the advisory must NAME lanes; got ${JSON.stringify(redLimit.advisory)}`,
);
check(
  "pair1-red-declares-the-upper-bound",
  Boolean(redLimit.advisory) && redLimit.advisory.includes("UPPER BOUND"),
  `the count is ancestry-unmerged and must say so; got ${JSON.stringify(redLimit.advisory)}`,
);
// TEETH. This assertion was `pair1-red-never-blocks` until 2026-08-23, when the
// surface was measured NOTIFYING while an orchestrator took the forest 109 →
// 112 past the limit. `laneCountFast` is an upper bound, but these five lanes
// each carry a real unlanded commit, so `confirmAtLimit` confirms all five and
// the refusal is taken on a MEASURED lower bound.
check(
  "pair1-red-BLOCKS-the-dispatch",
  redLimit.blocked === true &&
    redLimit.status === 2 &&
    redLimit.json &&
    redLimit.json?.hookSpecificOutput?.permissionDecision === "deny" &&
    redLimit.json.continue !== false,
  `MUST-2 is the only clause that stops inventory being created — it must refuse, not notify; got continue=${redLimit.json && redLimit.json.continue} status=${redLimit.status}`,
);
check(
  "pair1-red-block-carries-the-deny-decision",
  Boolean(
    redLimit.json &&
      redLimit.json.hookSpecificOutput &&
      redLimit.json.hookSpecificOutput.permissionDecision === "deny",
  ),
  `the canonical PreToolUse deny field must carry the decision; got ${JSON.stringify(redLimit.json)}`,
);
check(
  "pair1-red-block-head-says-the-call-was-blocked",
  Boolean(redLimit.advisory) && redLimit.advisory.split("\n")[0].includes("STOP — Tool call blocked."),
  `the agent must be able to read the FATE off the head; got ${JSON.stringify(redLimit.advisory && redLimit.advisory.split("\n")[0])}`,
);
check(
  "pair1-red-block-names-the-confirmed-lanes",
  Boolean(redLimit.advisory) &&
    /feat\/lane-0\d/.test(redLimit.advisory) &&
    redLimit.advisory.includes("MEASURED unlanded content"),
  `a refusal must name the lanes it counted and say the count was measured, not inferred; got ${JSON.stringify(redLimit.advisory)}`,
);
check(
  "pair1-red-block-states-the-lower-bound-and-the-upper-bound",
  Boolean(redLimit.advisory) &&
    redLimit.advisory.includes("LOWER BOUND") &&
    redLimit.advisory.includes("UPPER BOUND"),
  `the refusal rests on the lower bound and must say so alongside the upper one; got ${JSON.stringify(redLimit.advisory)}`,
);
check(
  "pair1-red-block-names-its-own-escape",
  Boolean(redLimit.advisory) &&
    /wip-authz[/\\]wip-limit-allow/.test(redLimit.advisory) &&
    redLimit.advisory.includes(ESCAPE_ENV),
  `a block that does not name its override is the dead-end hook-output-discipline.md MUST NOT forbids; got ${JSON.stringify(redLimit.advisory)}`,
);
check(
  "pair1-green-under-limit-silent",
  !fired(greenLimit) && greenLimit.json && greenLimit.json.continue === true,
  `a dispatch under the limit must be silent; got ${JSON.stringify(greenLimit.json)}`,
);
polesDiffer("pair1-poles-differ", fired(redLimit), fired(greenLimit));

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 1b — MUST-2 AT THE **BASH** DOOR, which is the door lanes actually
// come through.
//
// THE DEFECT THIS PINS. MUST-2 reads "Opening at the limit is REFUSED",
// unqualified, and the guard implemented it for `Task|Agent` ALONE. So the
// ceiling was consulted when an AGENT opened a lane and never when anyone
// opened one with git directly. Measured on this repo at the time of the fix:
// 33 worktrees and 43 branches against a limit of 5, with the guard refusing
// nothing — not because it was lenient, but because it was never asked. A
// ceiling that guards one of several doors is not a ceiling, and PAIR 1 above
// stayed fully green throughout.
// ═══════════════════════════════════════════════════════════════════════════
const bashRed = runGuard({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "git worktree add ../new-lane -b feat/another" },
  cwd: overLimit.work,
});
const bashGreen = runGuard({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "git status --porcelain" },
  cwd: overLimit.work,
});

check(
  "pair1b-red-BLOCKS-a-bash-lane-creation",
  bashRed.blocked === true && bashRed.json && bashRed.json?.hookSpecificOutput?.permissionDecision === "deny" && bashRed.json.continue !== false,
  `a lane-creating git command at the limit must be refused, not notified; got continue=${bashRed.json && bashRed.json.continue}`,
);
check(
  "pair1b-red-cites-clause-identity",
  Boolean(bashRed.advisory) && bashRed.advisory.includes("wip-discipline/MUST-2"),
  `expected the advisory to cite wip-discipline/MUST-2; got ${JSON.stringify(bashRed.advisory)}`,
);
check(
  "pair1b-red-names-the-CONSTRUCT-not-a-dispatch",
  Boolean(bashRed.advisory) && bashRed.advisory.includes("git worktree add"),
  `the operator typed a command, not a dispatch — the refusal must name the construct that opens the lane; got ${JSON.stringify(bashRed.advisory)}`,
);
check(
  "pair1b-red-still-rests-on-the-MEASURED-count",
  Boolean(bashRed.advisory) && bashRed.advisory.includes("MEASURED unlanded content"),
  `the lexical match only selects the QUESTION; the answer must still come from measured git state; got ${JSON.stringify(bashRed.advisory)}`,
);
check(
  "pair1b-green-non-lane-command-silent-AT-THE-SAME-LIMIT",
  !fired(bashGreen) && bashGreen.json && bashGreen.json.continue === true,
  `an over-limit repo must not refuse a command that opens no lane — otherwise the arm is a blanket Bash block; got ${JSON.stringify(bashGreen.json)}`,
);
polesDiffer("pair1b-poles-differ", fired(bashRed), fired(bashGreen));

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 1c — A PARENTHESIS IS NOT A BYPASS, AND A MENTION IS NOT A CREATION.
//
// Both poles are over the limit and both CONTAIN the text `git worktree add`.
// They differ only in whether that text is a COMMAND or a STRING, which is
// exactly the discrimination a private regex cannot make in either direction:
// it would clear the grouped form and refuse the echoed one.
//
// The grouped form is not hypothetical. A sibling repo measured a pair of
// parentheses defeating 15 of 15 destructive-op guards, and MEASURED here:
// `parseGitInvocations` alone returns ZERO invocations for `(git worktree add
// ../y)`, so the predicate applies the shared parser's own
// `stripShellGroupDelimiters` first.
//
// The echoed pole is what keeps `block` legitimate under
// `hook-output-discipline.md` MUST-2 — the match selects WHICH question to ask
// and never decides the answer.
// ═══════════════════════════════════════════════════════════════════════════
const groupedRed = runGuard({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "(git worktree add ../sneaky -b feat/sneaky)" },
  cwd: overLimit.work,
});
const echoedGreen = runGuard({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: 'echo "git worktree add ../sneaky"' },
  cwd: overLimit.work,
});

check(
  "pair1c-red-subshell-grouped-creation-is-REFUSED",
  groupedRed.blocked === true,
  `a subshell-grouped lane creation must not bypass the ceiling — this is the 15-of-15 parenthesis class; got continue=${groupedRed.json && groupedRed.json.continue}`,
);
check(
  "pair1c-green-a-MENTION-in-a-string-does-not-fire",
  !fired(echoedGreen) && echoedGreen.json && echoedGreen.json.continue === true,
  `a command that merely MENTIONS the construct opens no lane and must pass; got ${JSON.stringify(echoedGreen.json)}`,
);
polesDiffer("pair1c-poles-differ", fired(groupedRed), fired(echoedGreen));

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 1d — THE CEILING MUST NOT BLOCK ITS OWN REMEDY.
//
// The refusal tells the operator to LAND or KILL a lane. Killing means
// `git branch -D` and `git worktree remove`. If the Bash arm matched on the
// subcommand alone it would refuse those too — and a ceiling that blocks the
// only action that can clear it is not a pull signal, it is a deadlock, and it
// would be disabled the same day. Both poles are over the limit and both are
// `git branch`; they differ only in DIRECTION.
// ═══════════════════════════════════════════════════════════════════════════
const createRed = runGuard({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "git branch feat/yet-another" },
  cwd: overLimit.work,
});
const drainGreen = runGuard({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "git branch -D feat/lane-01" },
  cwd: overLimit.work,
});

check(
  "pair1d-red-branch-creation-is-REFUSED",
  createRed.blocked === true,
  `\`git branch <name>\` at the limit opens a lane and must be refused; got continue=${createRed.json && createRed.json.continue}`,
);
check(
  "pair1d-green-branch-DELETION-is-allowed-at-the-same-limit",
  !fired(drainGreen) && drainGreen.json && drainGreen.json.continue === true,
  `killing a lane is the REMEDY the refusal recommends; blocking it would deadlock the ceiling; got ${JSON.stringify(drainGreen.json)}`,
);
polesDiffer("pair1d-poles-differ", fired(createRed), fired(drainGreen));

const removeGreen = runGuard({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "git worktree remove ../feat-lane-01" },
  cwd: overLimit.work,
});
check(
  "pair1d-green-worktree-REMOVE-is-allowed-at-the-same-limit",
  !fired(removeGreen) && removeGreen.json && removeGreen.json.continue === true,
  `\`git worktree remove\` closes a lane; the same subcommand as \`add\` must not be refused for it; got ${JSON.stringify(removeGreen.json)}`,
);

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 2 — MUST-2, UNKNOWN IS NOT A VIOLATION.
// The SAME over-limit branch set, with `origin/main` unresolvable. `ok:false`
// means the lane set could not be established; reading that as "over the limit"
// would fire on every repo whose base ref is missing, and reading it as "under"
// would be the silent-clean-zero `instrument-discipline.md` MUST-1 names.
// ═══════════════════════════════════════════════════════════════════════════
const unknownBase = buildRepo({
  withRemote: false,
  lanes: Array.from({ length: WIP_LIMIT + 1 }, (_, i) => ({
    name: `feat/unknown-${i + 1}`,
    ageHours: 3,
  })),
});
const greenUnknown = runGuard(laneOpenPayload(unknownBase.work));
check(
  "pair2-unknown-lane-set-is-silent",
  !fired(greenUnknown) && greenUnknown.json && greenUnknown.json.continue === true,
  `an unresolvable base ref is UNKNOWN, not a violation; got ${JSON.stringify(greenUnknown.json)}`,
);
check(
  "pair2-unknown-is-reported-as-unanswerable-not-zero",
  laneCountFast({ repoDir: unknownBase.work }).ok === false &&
    laneCountFast({ repoDir: unknownBase.work }).count === undefined,
  `laneCountFast must return ok:false with NO count — a 0 would be indistinguishable from "no lanes"; got ${JSON.stringify(laneCountFast({ repoDir: unknownBase.work }))}`,
);
check(
  "pair2-red-same-branches-with-a-resolvable-base-DOES-fire",
  fired(redLimit),
  "the RED partner must fire, or the silent pole above would pass against a guard that never fires at all",
);
polesDiffer("pair2-poles-differ", fired(redLimit), fired(greenUnknown));

// `wipVerdict` is the module-level expression of the same rule.
check(
  "pair2-wipVerdict-null-on-unanswerable",
  wipVerdict({ ok: false, lanes: [] }) === null,
  `an unanswerable lane set must yield null, never {atLimit:false}; got ${JSON.stringify(wipVerdict({ ok: false, lanes: [] }))}`,
);
check(
  "pair2-wipVerdict-atLimit-on-answerable",
  wipVerdict({ ok: true, lanes: new Array(WIP_LIMIT).fill({}) }).atLimit === true,
  "the answerable pole must reach atLimit, or the null pole above is vacuous",
);

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 3 — MUST-3, THE AGE BOUND AT SessionStart.
// RED: a lane past 24h. GREEN: the same shape, every lane fresh.
// ═══════════════════════════════════════════════════════════════════════════
const agedRepo = buildRepo({
  lanes: [
    { name: "fix/rotting", ageHours: 300 },
    { name: "feat/also-old", ageHours: 40 },
  ],
});
const freshRepo = buildRepo({
  lanes: [
    { name: "fix/fresh-a", ageHours: 1 },
    { name: "feat/fresh-b", ageHours: 2 },
  ],
});
const redAged = runGuard({ hook_event_name: "SessionStart", cwd: agedRepo.work });
const greenFresh = runGuard({ hook_event_name: "SessionStart", cwd: freshRepo.work });

check(
  "pair3-red-cites-clause-identity",
  Boolean(redAged.advisory) && redAged.advisory.includes("wip-discipline/MUST-3"),
  `expected wip-discipline/MUST-3; got ${JSON.stringify(redAged.advisory)}`,
);
check(
  "pair3-red-names-the-aged-lane",
  Boolean(redAged.advisory) && redAged.advisory.includes("fix/rotting"),
  `the oldest lane must be NAMED, not counted; got ${JSON.stringify(redAged.advisory)}`,
);
check(
  "pair3-red-reports-a-distribution-not-a-bare-count",
  Boolean(redAged.advisory) && /p50 .*p90 .*max /.test(redAged.advisory),
  `MUST-3 requires an age DISTRIBUTION; got ${JSON.stringify(redAged.advisory)}`,
);
check(
  "pair3-red-states-both-terminal-states",
  Boolean(redAged.advisory) &&
    redAged.advisory.includes("LAND it") &&
    redAged.advisory.includes("KILL it"),
  `the disposition half is the point: a finding without LAND-or-KILL produced the backlog; got ${JSON.stringify(redAged.advisory)}`,
);
// The SessionStart arm now delivers the lane contract to EVERY session
// (journal/0608 item 6), so "did it emit anything" no longer separates these
// poles. The MUST-3 FINDING does, and that is what this pair was always about.
const ageFinding = (g) =>
  Boolean(g.advisory) && g.advisory.includes("wip-discipline/MUST-3");
check(
  "pair3-green-no-aged-lane-carries-no-MUST-3-finding",
  !ageFinding(greenFresh) &&
    greenFresh.json &&
    greenFresh.json.continue === true &&
    greenFresh.blocked === false,
  `two lanes under the bound must carry no age finding; got ${JSON.stringify(greenFresh.json)}`,
);
polesDiffer("pair3-poles-differ", ageFinding(redAged), ageFinding(greenFresh));
check(
  "pair3-red-aged-report-keeps-halt-and-report-and-carries-the-lane-contract",
  Boolean(redAged.advisory) &&
    redAged.advisory.split("\n")[0].includes("ALREADY RAN") &&
    redAged.advisory.includes("wip-discipline/MUST-9") &&
    /LANE DEPTH/.test(redAged.advisory),
  `the MUST-3 report keeps its severity and the contract rides inside it; got ${JSON.stringify((redAged.advisory || "").slice(0, 300))}`,
);

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 4 — MUST-3, AN UNMEASURABLE AGE IS NOT EVIDENCE OF YOUTH.
// A lane whose age could not be derived is INCLUDED in the past-bound set. The
// opposite disposition (drop it) is the error direction an ageing metric must
// not have — it can only ever make rot look fresh.
// ═══════════════════════════════════════════════════════════════════════════
const withUnknownAge = agedLanes([
  { name: "lane-unknown-age", ageHours: null },
  { name: "lane-young", ageHours: 1 },
]);
const youngOnly = agedLanes([{ name: "lane-young", ageHours: 1 }]);
check(
  "pair4-unknown-age-is-included-by-name",
  withUnknownAge.length === 1 && withUnknownAge[0].name === "lane-unknown-age",
  `expected exactly lane-unknown-age; got ${JSON.stringify(withUnknownAge)}`,
);
check(
  "pair4-young-lane-is-excluded",
  youngOnly.length === 0,
  `a 1h lane is not past a ${AGE_BOUND_HOURS}h bound; got ${JSON.stringify(youngOnly)}`,
);
polesDiffer("pair4-poles-differ", withUnknownAge.length > 0, youngOnly.length > 0);
check(
  "pair4-unknown-age-sorts-first",
  agedLanes([
    { name: "old", ageHours: 100 },
    { name: "unknown", ageHours: null },
  ])[0].name === "unknown",
  "an unmeasurable age must sort to the top of the report, not be buried under measured ones",
);
check(
  "pair4-distribution-is-null-when-nothing-is-measurable",
  ageDistribution([{ name: "x", ageHours: null }]) === null,
  "a distribution over zero measurable ages must be null, never a fabricated zero",
);
check(
  "pair4-distribution-is-populated-when-ages-exist",
  ageDistribution([{ ageHours: 10 }, { ageHours: 300 }]).over24h === 1,
  "the populated pole must move, or the null pole above is vacuous",
);

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 5 — MUST-6, EMPTY IS NOT DIRTY.
// RED-for-removal / GREEN-for-removal are inverted here: the DEFECT is a tree
// pinned KEEP forever, so ZERO-LOSS on a provably-empty tree is the pole that
// was previously impossible to reach.
// ═══════════════════════════════════════════════════════════════════════════
const treeRepo = buildRepo({ lanes: [{ name: "feat/empty-tree", ageHours: 5, push: true }] });
git(treeRepo.work, ["worktree", "add", "-q", "--no-checkout", path.join(treeRepo.root, "wt-empty"), "feat/empty-tree"]);
const emptyAdmin = path.join(treeRepo.work, ".git", "worktrees", "wt-empty");
const emptyTree = path.join(treeRepo.root, "wt-empty");

check(
  "pair5-precondition-no-checkout-tree-has-no-index",
  hasNoIndex(emptyAdmin) === true,
  `the whole MUST-6 case rests on this measured git behaviour; if it changed, every verdict below is about a different tree. admin=${emptyAdmin}`,
);
const emptyVerdict = classifyTree({ treePath: emptyTree, adminDir: emptyAdmin, cwd: treeRepo.work });
check(
  "pair5-empty-tree-is-ZERO-LOSS",
  emptyVerdict.verdict === "ZERO-LOSS" && emptyVerdict.noIndex === true,
  `a --no-checkout tree with 0 unpushed commits holds nothing; got ${JSON.stringify(emptyVerdict)}`,
);
check(
  "pair5-empty-tree-names-the-phantom-deletion-reason",
  emptyVerdict.reasons.some((r) => /no index file/.test(r) && /phantom/.test(r)),
  `the verdict must name WHY the porcelain deletions are not work; got ${JSON.stringify(emptyVerdict.reasons)}`,
);

// A tree genuinely holding work: same repo shape, real uncommitted content.
git(treeRepo.work, ["worktree", "add", "-q", path.join(treeRepo.root, "wt-dirty"), "-b", "feat/dirty-tree"]);
const dirtyTree = path.join(treeRepo.root, "wt-dirty");
const dirtyAdmin = path.join(treeRepo.work, ".git", "worktrees", "wt-dirty");
writeFileSync(path.join(dirtyTree, "in-progress.txt"), "unstaged, untracked, no reflog\n");
const dirtyVerdict = classifyTree({ treePath: dirtyTree, adminDir: dirtyAdmin, cwd: treeRepo.work });
check(
  "pair5-tree-holding-work-is-KEEP",
  dirtyVerdict.verdict === "KEEP",
  `a tree with untracked content must not be removable; got ${JSON.stringify(dirtyVerdict)}`,
);
check(
  "pair5-KEEP-names-the-work-it-found",
  dirtyVerdict.reasons.some((r) => /dirty tree \(\d+ path\(s\)/.test(r)),
  `the KEEP must name the count of paths it found, not merely refuse; got ${JSON.stringify(dirtyVerdict.reasons)}`,
);
polesDiffer("pair5-poles-differ", emptyVerdict.verdict, dirtyVerdict.verdict);

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 6 — MUST-6, UNKNOWN IS KEEP, AND CLEAN IS NOT UNKNOWN.
// An unreadable status is not a clean tree. The admin dir carries an index, so
// the no-index arm cannot answer and the porcelain read is the only path — and
// it fails. That must land on KEEP with the reason NAMED as unknown.
// ═══════════════════════════════════════════════════════════════════════════
const brokenAdmin = mkdtempSync(path.join(tmpdir(), "wip-admin-"));
cleanup.push(brokenAdmin);
writeFileSync(path.join(brokenAdmin, "index"), "not really an index, but present\n");
const unreadable = classifyTree({
  treePath: path.join(brokenAdmin, "no-such-worktree"),
  adminDir: brokenAdmin,
  cwd: treeRepo.work,
});
check(
  "pair6-unreadable-status-is-KEEP",
  unreadable.verdict === "KEEP",
  `an unanswerable status must fail CLOSED for a removal gate; got ${JSON.stringify(unreadable)}`,
);
check(
  "pair6-unreadable-names-UNKNOWN-not-clean",
  unreadable.reasons.some((r) => /UNKNOWN, not clean/.test(r)),
  `the reason must distinguish unreadable from clean; got ${JSON.stringify(unreadable.reasons)}`,
);

// The partner: a real, clean, fully-pushed checked-out tree IS removable. Without
// it, a classifier that answered KEEP to everything would pass the pole above —
// which is the E2 inertia the clause exists to end.
git(treeRepo.work, ["worktree", "add", "-q", path.join(treeRepo.root, "wt-clean"), "feat/empty-tree", "--force"]);
const cleanTree = path.join(treeRepo.root, "wt-clean");
const cleanAdmin = path.join(treeRepo.work, ".git", "worktrees", "wt-clean");
const cleanVerdict = classifyTree({ treePath: cleanTree, adminDir: cleanAdmin, cwd: treeRepo.work });
check(
  "pair6-clean-pushed-tree-is-ZERO-LOSS",
  cleanVerdict.verdict === "ZERO-LOSS",
  `a clean tree whose every commit is pushed holds nothing to lose; got ${JSON.stringify(cleanVerdict)}`,
);
polesDiffer("pair6-poles-differ", unreadable.verdict, cleanVerdict.verdict);

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 7 — WRONG-EVENT FALL-THROUGH.
// A MEASURED DEFECT, caught by the stay-silent pole: before the explicit event
// gate, every non-SessionStart payload fell through to the tool test, so a
// PostToolUse payload fired the spawn guard — announcing that a lane "is about to
// open" AFTER it had opened. Same repo, same tool, ONLY the event differs.
// ═══════════════════════════════════════════════════════════════════════════
const wrongEvent = runGuard(
  laneOpenPayload(overLimit.work, { hook_event_name: "PostToolUse" }),
);
check(
  "pair7-post-tool-use-produces-no-spawn-guard-finding",
  !fired(wrongEvent) && wrongEvent.json && wrongEvent.json.continue === true,
  `PostToolUse must fall through silently — the lane has already opened; got ${JSON.stringify(wrongEvent.json)}`,
);
check(
  "pair7-red-partner-same-repo-same-tool-DOES-fire",
  fired(redLimit) && redLimit.advisory.includes("wip-discipline/MUST-2"),
  "the PreToolUse partner on the SAME repo must fire, or the silent pole is vacuous",
);
polesDiffer("pair7-poles-differ", fired(redLimit), fired(wrongEvent));

// A tool the matcher never delivers is silent at the right event too. `Bash` is
// the ONLY registered matcher, so an `Edit` payload reaching this guard — which
// only happens in a fixture — must fall through rather than be treated as a
// lane opener. The pole it is compared against is the Bash red above: a silent
// pole is informative only while its partner on the SAME repo fires.
const wrongTool = runGuard({ hook_event_name: "PreToolUse", tool_name: "Edit", cwd: overLimit.work });
check(
  "pair7b-non-lane-opening-tool-is-silent",
  !fired(wrongTool),
  `an Edit at the limit opens no lane; got ${JSON.stringify(wrongTool.json)}`,
);
polesDiffer("pair7b-poles-differ", fired(redLimit), fired(wrongTool));

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 10 — MUST-2 TEETH: THE UPPER BOUND ALONE NEVER REFUSES.
//
// The load-bearing negative control for the whole teeth change. Every lane here
// is ancestry-unmerged (so `laneCountFast` reads AT the limit) and every one is
// content-LANDED (cherry-picked onto main, so `git cherry` confirms zero). A
// guard that blocks on `laneCountFast` refuses this dispatch; a guard that
// blocks on `confirmAtLimit` reports and lets it through. Without this row the
// teeth would be indistinguishable from an over-blocking gate.
// ═══════════════════════════════════════════════════════════════════════════
const boundOnly = buildRepo({
  landContent: true,
  lanes: Array.from({ length: WIP_LIMIT + 1 }, (_, i) => ({
    name: `feat/rebased-${i + 1}`,
    ageHours: 4 + i,
  })),
});
const reportOnly = runGuard(laneOpenPayload(boundOnly.work));
check(
  "pair10-precondition-fast-count-is-AT-the-limit",
  laneCountFast({ repoDir: boundOnly.work }).count >= WIP_LIMIT,
  `the whole row rests on the ancestry bound reading at the limit; got ${JSON.stringify(laneCountFast({ repoDir: boundOnly.work }))}`,
);
check(
  "pair10-precondition-content-count-is-ZERO",
  confirmAtLimit({
    repoDir: boundOnly.work,
    names: laneCountFast({ repoDir: boundOnly.work }).names,
  }).confirmed === 0,
  `cherry-picked lanes must confirm nothing, or this is not the ancestry-vs-content gap; got ${JSON.stringify(confirmAtLimit({ repoDir: boundOnly.work, names: laneCountFast({ repoDir: boundOnly.work }).names }))}`,
);
check(
  "pair10-upper-bound-alone-does-NOT-block",
  reportOnly.blocked === false && reportOnly.json && reportOnly.json.continue === true,
  `an ancestry-only count is an UPPER bound; refusing on it would refuse work on lanes that already landed; got continue=${reportOnly.json && reportOnly.json.continue} status=${reportOnly.status}`,
);
check(
  "pair10-upper-bound-still-REPORTS",
  fired(reportOnly) && reportOnly.advisory.includes("wip-discipline/MUST-2"),
  `over-reporting a REPORT costs one glance and is the right error direction — the report must still fire; got ${JSON.stringify(reportOnly.advisory)}`,
);
// The property under test is that the gate NAMES why it withheld the teeth — not
// WHICH of its reasons applied. MEASURED (loom, 2026-09-01): this row read
// `includes("MEASURED unlanded content")` and went RED on a correct guard while
// five sibling lanes loaded the machine, because `confirmAtLimit` bounds itself
// on WALL CLOCK (`wip-lanes.js::budgetMs = 2500`) and under contention the guard
// legitimately took its OTHER withhold branch — "ran out of budget after 2 of 6
// candidate(s)". Run alone it passed 3/3. Pinning one of three legitimate reasons
// makes the fixture red on machine load rather than on defect, which trains the
// operator to discount its reds; and both branches satisfy the actual claim.
//
// Discrimination is PRESERVED, not traded away: the disjunction is closed over
// the guard's three withhold reasons, so a gate that goes quiet, or that invents
// an unnamed fourth, still reds here. The row below asserts that closure holds.
const WITHHOLD_REASONS = [
  "MEASURED unlanded content",
  "ran out of budget after",
  "the confirmation pass did not run",
  // `confirmAtLimit` resolves the trunk STRICTLY (wip-discipline MUST-4) and reports
  // an unresolvable one as undecided; "ran out of budget" would misname that.
  "could not resolve the integration trunk",
];
check(
  "pair10-report-says-WHY-it-withheld-the-teeth",
  Boolean(reportOnly.advisory) &&
    reportOnly.advisory.includes("NOT BLOCKED because") &&
    WITHHOLD_REASONS.some((r) => reportOnly.advisory.includes(r)),
  `a gate that declines to bite must name the reason, or the silence is indistinguishable from a broken gate; got ${JSON.stringify(reportOnly.advisory)}`,
);
// The disjunction above is only as honest as its closure over the guard's real
// branches: if the guard grows a fourth withhold reason, `some()` would accept a
// report that names it while this suite believed it had enumerated them all.
// So the guard's source is read for the reason strings themselves.
check(
  "pair10-withhold-reason-SET-is-closed-over-the-guard-source",
  (() => {
    const src = readFileSync(GUARD, "utf8");
    const branch = src.slice(src.indexOf("const why = !confirm"));
    const arm = branch.slice(0, branch.indexOf(";"));
    const literals = (arm.match(/[`"'][^`"']*[`"']/g) || [])
      .map((x) => x.slice(1, -1))
      .filter((x) => x.trim().length > 8);
    return (
      literals.length >= 3 &&
      literals.every((lit) => WITHHOLD_REASONS.some((r) => lit.includes(r)))
    );
  })(),
  `every withhold reason the guard can emit must be in WITHHOLD_REASONS, or the disjunction above silently accepts a branch this suite never enumerated`,
);
polesDiffer("pair10-poles-differ", redLimit.blocked, reportOnly.blocked);

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 11 — THE ONE-SHOT RECEIPT: HONOURED EXACTLY ONCE, THEN RE-BLOCKS.
//
// This channel is what answers `hook-output-discipline.md` MUST NOT
// § "detectors that block work the agent has been instructed to perform". A
// receipt that survived its use would silently disarm the gate for every later
// dispatch — the same always-on shape that let 112 lanes accumulate behind an
// acknowledged banner. So "honoured" and "consumed" are asserted separately.
// ═══════════════════════════════════════════════════════════════════════════
const receiptRepo = buildRepo({
  lanes: Array.from({ length: WIP_LIMIT }, (_, i) => ({
    name: `feat/receipt-lane-${i + 1}`,
    ageHours: 3 + i,
  })),
});
const receiptPayload = laneOpenPayload(receiptRepo.work);
// Baseline: with no receipt this repo BLOCKS. Without this the rows below would
// pass against a guard that never blocks at all.
const receiptBaseline = runGuard(receiptPayload);
check(
  "pair11-baseline-no-receipt-BLOCKS",
  receiptBaseline.blocked === true,
  `the receipt rows are meaningless unless the un-receipted call is refused; got ${JSON.stringify(receiptBaseline.json)}`,
);
writeReceipt(
  receiptRepo.work,
  // `land-first:` added s96: naming a lane is now part of the price (PAIR 26).
  // This pair tests CONSUMPTION and ECHO, not the price, so it carries the token
  // rather than incidentally re-testing its absence.
  "landing the s58 fix needs one more lane — approved\nland-first: feat/receipt-lane-1",
);
const receiptFirst = runGuard(receiptPayload);
check(
  "pair11-valid-receipt-lets-the-dispatch-through",
  receiptFirst.blocked === false && receiptFirst.json && receiptFirst.json.continue === true,
  `the documented override must actually work, or the block dead-ends legitimate work; got ${JSON.stringify(receiptFirst.json)}`,
);
check(
  "pair11-override-is-AUDITED-on-the-agent-visible-channel",
  Boolean(
    receiptFirst.json &&
      receiptFirst.json.hookSpecificOutput &&
      receiptFirst.json.hookSpecificOutput.additionalContext,
  ) && receiptFirst.advisory.includes("OVERRIDDEN"),
  `an override must never be silent; additionalContext is the only agent-visible channel at a non-blocking PreToolUse; got ${JSON.stringify(receiptFirst.json)}`,
);
check(
  "pair11-override-echoes-the-stated-reason",
  Boolean(receiptFirst.advisory) && receiptFirst.advisory.includes("approved"),
  `the reason the operator wrote must come back, or the receipt is a rubber stamp; got ${JSON.stringify(receiptFirst.advisory)}`,
);
check(
  "pair11-receipt-is-CONSUMED-from-disk",
  receiptExists(receiptRepo.work) === false,
  `a surviving receipt disarms the gate for every later dispatch; the file must be deleted as it is honoured`,
);
const receiptSecond = runGuard(receiptPayload);
check(
  "pair11-second-dispatch-BLOCKS-again",
  receiptSecond.blocked === true && receiptSecond.status === 2,
  `ONE-SHOT means one: the next dispatch past the limit must be refused; got ${JSON.stringify(receiptSecond.json)}`,
);
polesDiffer("pair11-poles-differ", receiptFirst.blocked, receiptSecond.blocked);
// An EMPTY receipt is not an override. A zero-byte file is what a failed write
// leaves behind, and reading it as consent would turn a disk error into a
// disarmed gate.
writeReceipt(receiptRepo.work, "   \n\t \n");
const receiptEmpty = runGuard(receiptPayload);
check(
  "pair11-empty-receipt-is-NOT-an-override",
  receiptEmpty.blocked === true,
  `a whitespace-only receipt states no reason and must not be honoured; got ${JSON.stringify(receiptEmpty.json)}`,
);
// AND IT IS NOT SPENT EITHER. Found by mutation M4: dropping the empty-receipt
// guard leaves the call blocked (the caller's own truthiness check catches it)
// while the file is DELETED on the way past. The dispatch still refuses, so a
// blocked-verdict assertion alone stays green — and the operator's file is gone
// with no override granted and no notice given. Only the on-disk pole sees it.
check(
  "pair11-empty-receipt-is-not-CONSUMED-either",
  receiptExists(receiptRepo.work) === true,
  `an empty receipt grants nothing, so it must also cost nothing — silently deleting it destroys an operator file while refusing the call`,
);
rmSync(path.join(receiptRepo.work, RECEIPT_REL), { force: true });
// A receipt reason is untrusted text interpolated into the body the agent reads
// back as authoritative. It must not be able to forge a status marker or smuggle
// control bytes.
// The injection payload is UNCHANGED, BEL byte and all — it is the control-byte
// smuggling case. `land-first:` only pays the s96 price (PAIR 26), and the
// ledger is cleared first so this tests the INJECTION rather than the debt an
// earlier case in this shared repo armed.
rmSync(path.join(receiptRepo.work, ".claude", "wip-authz", "override-ledger.jsonl"), { force: true });
writeReceipt(receiptRepo.work, "[BLOCK] forgedmarker attempt\nland-first: feat/receipt-lane-1");
const receiptInjection = runGuard(receiptPayload);
check(
  "pair11-receipt-reason-cannot-forge-a-status-marker",
  receiptInjection.blocked === false &&
    Boolean(receiptInjection.advisory) &&
    !receiptInjection.advisory.includes("[BLOCK]"),
  `a receipt reason must be bracket-stripped before it reaches the agent-visible body; got ${JSON.stringify(receiptInjection.advisory)}`,
);
check(
  "pair11-receipt-reason-cannot-smuggle-control-bytes",
  Boolean(receiptInjection.advisory) &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(receiptInjection.advisory),
  `control bytes must be stripped from the emitted body; got ${JSON.stringify(receiptInjection.advisory)}`,
);

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 12 — THE ENV CHANNEL (operator / CI).
// Not settable mid-session, so it is NOT the channel that answers the MUST NOT
// — but it must work, and it must be as loudly audited as the receipt.
// ═══════════════════════════════════════════════════════════════════════════
const envRepo = buildRepo({
  lanes: Array.from({ length: WIP_LIMIT }, (_, i) => ({
    name: `feat/env-lane-${i + 1}`,
    ageHours: 6 + i,
  })),
});
const envPayload = laneOpenPayload(envRepo.work);
const envOff = runGuard(envPayload);
const envOn = runGuard(envPayload, { [ESCAPE_ENV]: "1" });
check(
  "pair12-env-off-BLOCKS",
  envOff.blocked === true,
  `the env pole is vacuous unless the un-overridden call is refused; got ${JSON.stringify(envOff.json)}`,
);
check(
  "pair12-env-on-lets-the-dispatch-through",
  envOn.blocked === false && envOn.json && envOn.json.continue === true,
  `${ESCAPE_ENV}=1 must let the call through; got ${JSON.stringify(envOn.json)}`,
);
check(
  "pair12-env-override-is-AUDITED-and-names-the-channel",
  Boolean(envOn.advisory) &&
    envOn.advisory.includes("OVERRIDDEN") &&
    envOn.advisory.includes(`${ESCAPE_ENV}=1`),
  `the agent must be told WHICH channel opened the gate; got ${JSON.stringify(envOn.advisory)}`,
);
check(
  "pair12-env-override-does-not-spend-the-receipt",
  (() => {
    writeReceipt(
      envRepo.work,
      "should survive an env-overridden call\nland-first: feat/env-lane-1",
    );
    runGuard(envPayload, { [ESCAPE_ENV]: "1" });
    const survived = receiptExists(envRepo.work);
    rmSync(path.join(envRepo.work, RECEIPT_REL), { force: true });
    return survived;
  })(),
  `a call the env already waved through must not burn the operator's one-shot receipt`,
);
polesDiffer("pair12-poles-differ", envOff.blocked, envOn.blocked);

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 13 — FAIL OPEN ON AN UNDERIVABLE COUNT. A guard that cannot count must
// not block (`cc-artifacts.md` Rule 7). Three underivable shapes, each asserted
// against the BLOCK specifically — PAIR 2 already covers their silence.
// ═══════════════════════════════════════════════════════════════════════════
check(
  "pair13-unresolvable-base-ref-does-NOT-block",
  runGuard(laneOpenPayload(unknownBase.work)).blocked === false,
  `${WIP_LIMIT + 1} branches with no resolvable origin/main is UNKNOWN, not a refusal`,
);
check(
  "pair13-non-repo-cwd-does-NOT-block",
  runGuard(laneOpenPayload(path.join(tmpdir(), "wip-disc-no-such-dir-ever"))).blocked === false,
  `an unreadable repo is UNKNOWN, not a refusal`,
);
check(
  "pair13-red-partner-with-a-derivable-count-DOES-block",
  redLimit.blocked === true,
  `the fail-open poles above are vacuous unless the derivable pole refuses`,
);
polesDiffer(
  "pair13-poles-differ",
  redLimit.blocked,
  runGuard(laneOpenPayload(unknownBase.work)).blocked,
);

// The confirmation predicate's own poles, at the unit level — the guard rows
// above cannot separate "budget exhausted" from "genuinely under the limit",
// and only one of those two is allowed to look like the other.
const overNames = laneCountFast({ repoDir: overLimit.work }).names;
check(
  "pair13-confirmAtLimit-decides-at-the-limit",
  (() => {
    const c = confirmAtLimit({ repoDir: overLimit.work, names: overNames });
    return c.decided === true && c.atLeastLimit === true && c.confirmed === WIP_LIMIT;
  })(),
  `${WIP_LIMIT} genuinely-unlanded lanes must confirm; got ${JSON.stringify(confirmAtLimit({ repoDir: overLimit.work, names: overNames }))}`,
);
check(
  "pair13-confirmAtLimit-zero-budget-is-UNDECIDED-not-under",
  (() => {
    const c = confirmAtLimit({ repoDir: overLimit.work, names: overNames, budgetMs: -1 });
    return c.decided === false && c.reason === "budget-exhausted" && c.atLeastLimit === undefined;
  })(),
  `an exhausted budget must yield decided:false with NO verdict — a false here would be indistinguishable from "under the limit"; got ${JSON.stringify(confirmAtLimit({ repoDir: overLimit.work, names: overNames, budgetMs: -1 }))}`,
);
check(
  "pair13-confirmAtLimit-unanswerable-branch-is-skipped-not-counted",
  (() => {
    const c = confirmAtLimit({
      repoDir: overLimit.work,
      names: [...overNames, "refs/heads/no-such-branch-anywhere"],
    });
    // The limit is reached by the REAL lanes, so the bogus name is never even
    // scanned; scan a set that cannot reach the limit to force the skip.
    const forced = confirmAtLimit({
      repoDir: overLimit.work,
      names: ["no-such-branch-anywhere", overNames[0]],
      limit: WIP_LIMIT,
    });
    return c.decided === true && forced.unanswerable === 1 && forced.confirmed === 1;
  })(),
  `an unanswerable branch must be tallied and skipped, never read as 0 and never as content; got ${JSON.stringify(confirmAtLimit({ repoDir: overLimit.work, names: ["no-such-branch-anywhere", overNames[0]] }))}`,
);
check(
  "pair13-confirmAtLimit-early-exits-at-the-limit",
  (() => {
    const many = [...overNames, ...overNames, ...overNames];
    const c = confirmAtLimit({ repoDir: overLimit.work, names: many });
    return c.scanned === WIP_LIMIT && c.candidates === many.length;
  })(),
  `the loop must stop at the limit-th confirmation, or the cost scales with the forest instead of the limit; got ${JSON.stringify(confirmAtLimit({ repoDir: overLimit.work, names: [...overNames, ...overNames, ...overNames] }))}`,
);

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 8 — THE SEVERITY REGISTER, READ AS THE AGENT RECEIVES IT.
// A previous defect on this hook rendered "the action ALREADY RAN" against a
// PENDING dispatch — a head that is FALSE and that contradicts the
// agent_must_wait asking the agent to decide whether to proceed. The two arms
// carry DIFFERENT registers and the pair asserts they render differently.
// ═══════════════════════════════════════════════════════════════════════════
// The PRE-ACTION register survives the teeth change, but it moved: it is now
// the head of the arm that reports WITHOUT refusing — the upper-bound-only
// case built in PAIR 11 below. Reading it off the blocking arm would assert the
// wrong register against the wrong arm and pass for the wrong reason.
const preHead = reportOnly.advisory ? reportOnly.advisory.split("\n")[0] : "";
const blockHead = redLimit.advisory ? redLimit.advisory.split("\n")[0] : "";
const sessionHead = redAged.advisory ? redAged.advisory.split("\n")[0] : "";
check(
  "pair8-preToolUse-report-head-says-the-action-has-NOT-run",
  preHead.includes("has NOT run yet"),
  `the non-refusing spawn report is pre-action; got head: ${JSON.stringify(preHead)}`,
);
check(
  "pair8-preToolUse-report-head-never-claims-it-already-ran",
  !preHead.includes("ALREADY RAN"),
  `the dispatch is pending — this head would be false; got: ${JSON.stringify(preHead)}`,
);
check(
  "pair8-sessionStart-head-is-halt-and-report",
  sessionHead.includes("ALREADY RAN"),
  `the standing forest exists BEFORE the session's first tool call; got head: ${JSON.stringify(sessionHead)}`,
);
check(
  "pair8-sessionStart-arm-still-never-blocks",
  redAged.json.continue === true && redAged.blocked === false,
  `the SessionStart subject is the standing forest, not a pending action — there is nothing there to refuse; got ${JSON.stringify(redAged.json)}`,
);
check(
  "pair8-the-three-registers-are-distinct",
  new Set([preHead, blockHead, sessionHead]).size === 3,
  `block / pre-action / halt-and-report must render differently or an agent cannot read the fate off the text; got ${JSON.stringify([preHead, blockHead, sessionHead])}`,
);
polesDiffer("pair8-poles-differ", preHead, sessionHead);
polesDiffer("pair8b-block-head-differs-from-report-head", blockHead, preHead);

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 9 — FAIL-OPEN. Every error path yields {continue:true}.
// A detector that can wedge a session is worse than the inventory it reports.
// ═══════════════════════════════════════════════════════════════════════════
const malformed = spawnSync(process.execPath, [GUARD], {
  input: "{not json at all",
  encoding: "utf8",
  timeout: 20000,
});
let malformedJson = null;
try {
  malformedJson = JSON.parse((malformed.stdout || "").trim().split("\n").filter(Boolean).pop() || "");
} catch {
  malformedJson = null;
}
check(
  "pair9-malformed-payload-fails-open",
  malformedJson && malformedJson.continue === true,
  `unparseable stdin must still emit {continue:true}; got stdout=${JSON.stringify(malformed.stdout)}`,
);
check(
  "pair9-malformed-payload-is-LOUD-on-stderr",
  /HOOK ERROR/.test(malformed.stderr || ""),
  `fail-open must not be fail-silent — the error belongs on stderr; got ${JSON.stringify(malformed.stderr)}`,
);
const nonRepo = runGuard({
  hook_event_name: "SessionStart",
  cwd: path.join(tmpdir(), "wip-disc-no-such-dir-ever"),
});
// The contract is still owed to a session whose lane set cannot be read, so this
// pole now emits — as an ADVISORY carrying a TYPED unknown, never a finding.
check(
  "pair9-non-repo-cwd-fails-open-with-a-TYPED-unknown",
  !ageFinding(nonRepo) &&
    nonRepo.blocked === false &&
    nonRepo.json &&
    nonRepo.json.continue === true &&
    nonRepo.status === 0 &&
    /LANE DEPTH UNKNOWN — lane survey failed/.test(nonRepo.advisory || ""),
  `an unreadable repo is UNKNOWN, not a finding; got ${JSON.stringify(nonRepo)}`,
);
check(
  "pair9-empty-payload-fails-open",
  (() => {
    const g = runGuard({});
    return !fired(g) && g.json && g.json.continue === true;
  })(),
  "an empty payload names no event and must pass through",
);
// The partner pole: the SAME guard, given a well-formed payload it should act
// on, emits a finding at exit 0. Without it every assertion above would pass
// against a guard that does nothing but print {continue:true}.
check(
  "pair9-well-formed-payload-still-produces-a-finding-at-exit-0",
  fired(redAged) && redAged.status === 0,
  `the acting pole must fire; got status=${redAged.status} advisory=${JSON.stringify(redAged.advisory)}`,
);
polesDiffer("pair9-poles-differ", ageFinding(nonRepo), ageFinding(redAged));

// ═══════════════════════════════════════════════════════════════════════════
// THE LANE-OPENING CAPABILITY PREDICATE IS GONE, WITH THE ARM IT SERVED.
//
// PAIR 14 lived here (loom s69/s70, G2). It drove
// `hooks/lib/lane-opening-capability.js` both as a pure predicate and end to end
// through the `PreToolUse:Task|Agent` arm, asking "can THIS DISPATCH open a
// lane?" so a read-only `security-reviewer` would not spend a one-shot override
// on a call that could never open one.
//
// That arm was DEREGISTERED on 2026-08-29 (`b77a71603` — "the ceiling counts
// INVENTORY, not WORKERS"), a commit that touched `settings.json` and the rule
// and NOT the hook. From that date the predicate decided nothing: no registered
// matcher delivered a `Task` or `Agent` event to this guard, so the arm read as
// enforcement and could not fire. The arm is deleted from the guard and the
// predicate deleted with it, so the cases that asserted its verdicts are DELETED
// rather than re-pointed — re-pointing them would pin a contract that no longer
// exists, which is how a dead branch acquires live-looking coverage.
//
// WHAT IS KEPT, because the HARM was real and was never arm-specific: a call
// that opens NO lane must not burn the one-shot receipt. Re-asserted below at
// the only door there is.
// ═══════════════════════════════════════════════════════════════════════════

const capRepo = buildRepo({
  lanes: Array.from({ length: WIP_LIMIT + 1 }, (_, i) => ({ name: `lane/cap-${i}`, ageHours: 2 })),
});

// Asserted on the FILE, not on the advisory text — the receipt's disappearance
// is the harm. Six were spent in one session by calls that could not open a lane.
writeReceipt(
  capRepo.work,
  "fixture: a non-lane-opening command must not consume this\nland-first: lane/cap-0",
);
const nonOpenerAfter =
  (runGuard({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git status --porcelain" },
    cwd: capRepo.work,
  }),
  receiptExists(capRepo.work));
check(
  "pair14-receipt-SURVIVES-a-non-lane-opening-command",
  nonOpenerAfter === true,
  "a command that opens no lane consumed a one-shot override receipt — the measured defect, re-pinned at the surviving door",
);
const openerAfter = (runGuard(laneOpenPayload(capRepo.work)), receiptExists(capRepo.work));
check(
  "pair14-receipt-IS-consumed-by-a-lane-opener",
  openerAfter === false,
  "a lane-opening call at the limit must still consume the receipt — the override channel was broken",
);
polesDiffer("pair14-receipt-poles-differ", nonOpenerAfter, openerAfter);

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 14b — AN UNDECIDED DOOR NEVER LEAVES A ONE-SHOT RECEIPT SILENTLY LIVE
//
// `pair14-receipt-IS-consumed-by-a-lane-opener` failed beside a CPU-heavy
// validator and passed alone. The cause was the guard, not the fixture:
// `confirmAtLimit` is bounded by a WALL-CLOCK budget, and an expired budget sent
// the call down the report exit with the receipt still on disk and unmentioned —
// so a LATER over-limit call spent it (one receipt, two lanes past the ceiling).
// Real load cannot pin that, and generating load is not an instrument this suite
// may use, so every undecided state below is INJECTED: a `--require` preload
// patches the SAME cached `wip-lanes.js` object the guard requires. Each injected
// pole carries a REACH assertion — an injection that never loaded would read as
// an ordinary decided call.
//
// One pole per exit the change touched: the count door's undecided report exit
// (spend a priced receipt; withhold on a debt; withhold on an unpaid price), the
// MEASURED-under report exit, the unreadable count, and an age scan that did not
// finish under the limit.
// ═══════════════════════════════════════════════════════════════════════════
{
  const preloadDir = mkdtempSync(path.join(tmpdir(), "wip-disc-preload-"));
  cleanup.push(preloadDir);
  const preload = (name, body) => {
    const p = path.join(preloadDir, `${name}.cjs`);
    writeFileSync(p, `"use strict";\nconst L = require(${JSON.stringify(LIB)});\n${body}\n`);
    return { NODE_OPTIONS: `--require ${JSON.stringify(p)}` };
  };
  const expiredConfirm = preload(
    "expire-confirm-budget",
    "const o = L.confirmAtLimit;\nL.confirmAtLimit = (a) => o({ ...a, budgetMs: -1 });",
  );
  const ampleConfirm = preload(
    "ample-confirm-budget",
    "const o = L.confirmAtLimit;\nL.confirmAtLimit = (a) => o({ ...a, budgetMs: 600000, perCallTimeoutMs: 60000 });",
  );
  const unreadableCount = preload(
    "unreadable-lane-count",
    'L.laneCountFast = () => ({ ok: false, reason: "injected-unreadable-count" });',
  );
  const expiredAge = preload(
    "expire-age-budget",
    "const o = L.confirmAgedLane;\nL.confirmAgedLane = (a) => o({ ...a, budgetMs: -1 });",
  );
  const LEDGER = path.join(capRepo.work, ".claude", "wip-authz", "override-ledger.jsonl");
  const ledgerRows = () =>
    existsSync(LEDGER)
      ? readFileSync(LEDGER, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  const opener = laneOpenPayload(capRepo.work);
  const said = (g, re) => re.test(g.advisory || "");
  rmSync(LEDGER, { force: true });
  rmSync(path.join(capRepo.work, RECEIPT_REL), { force: true });

  // (a) the count door UNDECIDED with NO receipt: the report, and nothing named.
  const undecidedBare = runGuard(opener, expiredConfirm);
  check(
    "pair14b-undecided-count-REACHED-the-expired-budget",
    said(undecidedBare, /NOT BLOCKED because the confirmation pass ran out of budget after 0 of 6 candidate/) &&
      !said(undecidedBare, /still LIVE|OVERRIDDEN/),
    `the injected expiry never reached confirmAtLimit, so every row below proves nothing; got ${JSON.stringify(undecidedBare.advisory)}`,
  );

  // (i) W5e — a trunk the confirmation pass could NOT resolve is named as that, never
  // as "ran out of budget": `confirmAtLimit` resolves the trunk STRICTLY (MUST-4).
  const trunkUnresolvedConfirm = preload(
    "confirm-trunk-undetermined",
    'L.confirmAtLimit = (a) => ({ decided: false, reason: "trunk-undetermined", trunk: "refs/heads/no-such-trunk", trunkReason: "COC_TRUNK_REF=refs/heads/no-such-trunk does not resolve in this repository", confirmed: 0, confirmedNames: [], scanned: 0, unanswerable: 0, candidates: a.names.length, elapsedMs: 0 });',
  );
  const trunkBare = runGuard(opener, trunkUnresolvedConfirm);
  check(
    "pair14c-unresolved-trunk-is-the-NAMED-withhold-reason-not-a-budget",
    said(
      trunkBare,
      /NOT BLOCKED because the confirmation pass could not resolve the integration trunk \(COC_TRUNK_REF=refs\/heads\/no-such-trunk does not resolve/,
    ) && !said(trunkBare, /ran out of budget/),
    `got ${JSON.stringify(trunkBare.advisory)}`,
  );
  polesDiffer(
    "pair14c-trunk-and-budget-withhold-reasons-differ",
    said(trunkBare, /could not resolve the integration trunk/),
    said(undecidedBare, /could not resolve the integration trunk/),
  );

  // (b) the SAME call with a PRICED receipt: spent on the upper bound, and the debt armed.
  writeReceipt(capRepo.work, "fixture: an undecided count must still spend this\nland-first: lane/cap-0");
  const spent = runGuard(opener, expiredConfirm);
  const spentAfter = receiptExists(capRepo.work);
  check(
    "pair14b-undecided-count-CONSUMES-a-priced-receipt",
    spentAfter === false,
    "an expired TIME budget left a lane-opener's receipt live at the limit — its fate rode on host load",
  );
  check(
    "pair14b-undecided-spend-is-REPORTED-as-an-OVERRIDE",
    spent.blocked === false &&
      said(spent, /WIP gate OVERRIDDEN by the one-shot receipt/) &&
      said(spent, /confirmation UNDECIDED because the confirmation pass ran out of budget/),
    `an honoured receipt must be named on the agent-visible channel with its undecided basis; got ${JSON.stringify(spent.advisory)}`,
  );
  check(
    "pair14b-undecided-spend-ARMS-the-debt-it-promised",
    ledgerRows().some((r) => r.channel === "receipt" && r.land_first === "lane/cap-0"),
    `a spent receipt must record its land-first promise, or the next override is free; got ${JSON.stringify(ledgerRows())}`,
  );
  polesDiffer(
    "pair14b-a-receipt-flips-the-undecided-exit",
    said(undecidedBare, /OVERRIDDEN/),
    said(spent, /OVERRIDDEN/),
  );

  // (c) the debt (b) armed is still OPEN: a new priced receipt is WITHHELD and NAMED.
  writeReceipt(capRepo.work, "fixture: a second override while the first promise is open\nland-first: lane/cap-1");
  const owed = runGuard(opener, expiredConfirm);
  check(
    "pair14b-undecided-count-with-an-unpaid-DEBT-names-the-receipt-LIVE",
    receiptExists(capRepo.work) === true &&
      owed.blocked === false &&
      !said(owed, /OVERRIDDEN/) &&
      said(owed, /still LIVE/) &&
      said(owed, /unpaid override debt on 'lane\/cap-0' withholds the spend/),
    `a debt withholds the spend; an unspent receipt on a proceeding call must be named; got ${JSON.stringify(owed.advisory)}`,
  );

  // (d) no debt, an UNPRICED receipt: withheld by the price, and NAMED.
  rmSync(LEDGER, { force: true });
  writeReceipt(capRepo.work, "fixture: names no lane");
  const unpriced = runGuard(opener, expiredConfirm);
  const unpricedAfter = receiptExists(capRepo.work);
  check(
    "pair14b-undecided-count-with-an-UNPRICED-receipt-names-it-LIVE",
    unpricedAfter === true &&
      unpriced.blocked === false &&
      said(unpriced, /still LIVE/) &&
      said(unpriced, /does not pay the price \(no-token\)/),
    `got ${JSON.stringify(unpriced.advisory)}`,
  );
  polesDiffer("pair14b-the-price-flips-the-spend", spentAfter, unpricedAfter);

  // (h) a pass that "DECIDED" while starved: every lane unanswerable, so a per-call
  // git timeout — not the wall-clock budget — left the count undecided. The limit
  // is still reachable through the lanes it could not measure, so a priced
  // receipt is spent exactly as in (b).
  const starvedConfirm = preload(
    "starved-confirm",
    "L.confirmAtLimit = (a) => ({ decided: true, atLeastLimit: false, confirmed: 0, confirmedNames: [], scanned: a.names.length, unanswerable: a.names.length, candidates: a.names.length });",
  );
  writeReceipt(capRepo.work, "fixture: a starved decided pass must still spend this\nland-first: lane/cap-0");
  const starved = runGuard(opener, starvedConfirm);
  check(
    "pair14b-STARVED-decided-pass-CONSUMES-a-priced-receipt",
    receiptExists(capRepo.work) === false &&
      starved.blocked === false &&
      said(starved, /confirmation UNDECIDED because only 0 of 6 candidate/),
    `unanswerable lanes can still reach the limit; a pass that measured none of them decided nothing about the receipt; got ${JSON.stringify(starved.advisory)}`,
  );
  rmSync(LEDGER, { force: true });
  writeReceipt(capRepo.work, "fixture: names no lane");

  // (e) the UNREADABLE count: no upper bound to spend on, so a present receipt is NAMED.
  const unreadable = runGuard(opener, unreadableCount);
  check(
    "pair14b-unreadable-count-names-the-receipt-LIVE",
    receiptExists(capRepo.work) === true &&
      unreadable.blocked === false &&
      said(unreadable, /lane count could not be read \(injected-unreadable-count\)/) &&
      said(unreadable, /still LIVE/),
    `got ${JSON.stringify(unreadable.advisory)}`,
  );
  rmSync(path.join(capRepo.work, RECEIPT_REL), { force: true });
  const unreadableBare = runGuard(opener, unreadableCount);
  check(
    "pair14b-unreadable-count-with-NO-receipt-stays-silent",
    !fired(unreadableBare) && unreadableBare.blocked === false,
    `a guard that cannot count must not refuse, and with no receipt it has nothing to name; got ${JSON.stringify(unreadableBare.advisory)}`,
  );
  polesDiffer("pair14b-unreadable-count-poles-differ", fired(unreadable), fired(unreadableBare));

  // (f) MEASURED under the limit at the upper bound: nothing to spend, the receipt NAMED.
  // `boundOnly` (PAIR 10) sits AT the ancestry bound with every lane content-landed.
  // The confirmation budget is pinned AMPLE so host load cannot make this pole undecided.
  const boundPayload = laneOpenPayload(boundOnly.work);
  const measuredBare = runGuard(boundPayload, ampleConfirm);
  writeReceipt(boundOnly.work, "fixture: a measured under-limit call must not spend this\nland-first: feat/rebased-1");
  const measured = runGuard(boundPayload, ampleConfirm);
  check(
    "pair14b-MEASURED-under-limit-keeps-the-receipt-and-NAMES-it-LIVE",
    receiptExists(boundOnly.work) === true &&
      measured.blocked === false &&
      said(measured, /NOT BLOCKED because only 0 of 6 candidate/) &&
      said(measured, /still LIVE on disk \(the ceiling MEASURED only 0 of 6/),
    `got ${JSON.stringify(measured.advisory)}`,
  );
  check(
    "pair14b-MEASURED-under-limit-with-NO-receipt-names-nothing-LIVE",
    said(measuredBare, /NOT BLOCKED because only 0 of 6 candidate/) && !said(measuredBare, /still LIVE/),
    `got ${JSON.stringify(measuredBare.advisory)}`,
  );
  polesDiffer(
    "pair14b-measured-under-poles-differ",
    said(measured, /still LIVE/),
    said(measuredBare, /still LIVE/),
  );
  rmSync(path.join(boundOnly.work, RECEIPT_REL), { force: true });

  // (j) W5e END TO END — a REAL unresolvable `COC_TRUNK_REF`, no injection. Every
  // wip-lanes predicate now resolves the trunk strictly, so the guard sees an
  // UNMEASURED count naming the declaration (not `for-each-ref-failed`), names a
  // present receipt LIVE, and SessionStart's depth line names the same cause.
  writeReceipt(capRepo.work, "fixture: an unresolvable trunk must name this\nland-first: lane/cap-0");
  const badTrunk = { COC_TRUNK_REF: "refs/heads/no-such-trunk" };
  const trunkOpen = runGuard(opener, badTrunk);
  check(
    "pair14c-unresolvable-COC_TRUNK_REF-is-an-UNMEASURED-count-naming-it",
    receiptExists(capRepo.work) === true &&
      trunkOpen.blocked === false &&
      said(
        trunkOpen,
        /lane count could not be read \(trunk-undetermined: COC_TRUNK_REF=refs\/heads\/no-such-trunk does not resolve/,
      ) &&
      said(trunkOpen, /still LIVE/),
    `got ${JSON.stringify(trunkOpen.advisory)}`,
  );
  const trunkStart = runGuard({ hook_event_name: "SessionStart", cwd: capRepo.work }, badTrunk);
  check(
    "pair14c-SessionStart-names-the-unresolvable-trunk-in-LANE-DEPTH-UNKNOWN",
    said(
      trunkStart,
      /LANE DEPTH UNKNOWN — lane survey failed \(trunk-undetermined: COC_TRUNK_REF=refs\/heads\/no-such-trunk does not resolve/,
    ),
    `got ${JSON.stringify(trunkStart.advisory)}`,
  );
  const trunkStartOk = runGuard({ hook_event_name: "SessionStart", cwd: capRepo.work });
  polesDiffer(
    "pair14c-SessionStart-trunk-poles-differ",
    said(trunkStart, /LANE DEPTH UNKNOWN/),
    said(trunkStartOk, /LANE DEPTH UNKNOWN/),
  );
  rmSync(path.join(capRepo.work, RECEIPT_REL), { force: true });

  // (g) the age scan did not finish UNDER the limit: no upper bound, the receipt NAMED.
  const underRepo = buildRepo({
    lanes: [
      { name: "lane/u-0", ageHours: 2 },
      { name: "lane/u-1", ageHours: 3 },
    ],
  });
  const underOpen = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    cwd: underRepo.work,
    tool_input: { command: "git worktree add ../wt-under -b feat/under" },
  };
  writeReceipt(underRepo.work, "fixture: an undecided age scan must name this\nland-first: lane/u-0");
  const ageUndecided = runGuard(underOpen, expiredAge);
  const ageDecided = runGuard(underOpen);
  check(
    "pair14b-undecided-age-scan-under-limit-names-the-receipt-LIVE",
    receiptExists(underRepo.work) === true &&
      ageUndecided.blocked === false &&
      said(ageUndecided, /age scan did not finish \(budget-exhausted; 0 of 2 lane\(s\) measured\)/) &&
      said(ageUndecided, /still LIVE/),
    `got ${JSON.stringify(ageUndecided.advisory)}`,
  );
  check(
    "pair14b-DECIDED-young-age-scan-under-limit-is-silent-and-keeps-the-receipt",
    !fired(ageDecided) && receiptExists(underRepo.work) === true,
    `a measured, young, under-limit forest is the plain passthrough; got ${JSON.stringify(ageDecided.advisory)}`,
  );
  polesDiffer("pair14b-age-scan-poles-differ", fired(ageUndecided), fired(ageDecided));
}

// ═══════════════════════════════════════════════════════════════════════════
// PAIRS 15, 16, 17 AND THE s73 REGRESSION SET LIVED HERE — DELETED WITH THE ARM
//
// All of them drove `hooks/lib/lane-opening-capability.js`, the predicate for the
// `PreToolUse:Task|Agent` arm: the YAML-block-sequence fail-open, the scoped
// `Bash(git:*)` form, the shadowed-agent-name fail-closed, capability-is-not-
// intent, and the s73 adversarial findings (ref-creating forms, prose-without-git,
// existence-is-not-directory-ness, the isolation-flag shapes).
//
// The arm was deregistered on 2026-08-29 (`b77a71603`) and is now deleted from
// the guard, so the predicate has no consumer and is deleted too. A regression
// pin for a predicate that no longer runs is not coverage — it is a green suite
// asserting a contract nothing implements, which is the exact reading that let
// the dead arm price as a control for two weeks.
//
// THE ONE OBLIGATION IN THIS SET WITH A LIVE CONSEQUENCE IS OWNED ELSEWHERE, and
// this was MEASURED before deleting rather than assumed. A dispatch carrying
// `isolation: "worktree"` opens a worktree with no tool call at all, so it could
// evade a Bash-only ceiling. `.claude/hooks/nested-worktree-guard.js` is
// registered at `PreToolUse` on the `Task|Agent|EnterWorktree` matcher, reads
// `tool_input.isolation` structurally, and emits `severity: "block"` — it REFUSES
// the flag outright, so no lane opens through that door for any ceiling to count.
// Its own fixtures are `.claude/audit-fixtures/nested-worktree-guard/`.
// ═══════════════════════════════════════════════════════════════════════════

// ── teardown ────────────────────────────────────────────────────────────────
// Worktrees are pruned before the directories go, so no admin entry survives in
// a repo this fixture is about to delete.
try {
  git(treeRepo.work, ["worktree", "prune"]);
} catch {
  /* best effort */
}
for (const d of cleanup) {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 18 — `git worktree add <path> <EXISTING-branch>` attaches a WORKER to
// inventory that already exists, and MUST NOT be charged to the ceiling.
//
// THE DEFECT THIS PINS. `laneCreationIntent` returned `creates: true` for every
// `worktree add`, with no regard for whether the named ref already existed. The
// ceiling measures INVENTORY — branches carrying unlanded content — and
// attaching a worktree changes no branch's content, so the count is identical
// before and after. Measured: the guard refused
// `git worktree add <path> fix/s39-t1corr-gate2-correctness` while its OWN
// refusal text listed that same branch among the five counted lanes. The
// ceiling was blocking its own drain: the operator could not attach a worker to
// an aged lane in order to LAND it, which is the one action that reduces the
// count. Same inventory-vs-worker confusion that removed the `Task|Agent` arm.
//
// The three RED poles below are what keep this from becoming a blanket
// exemption: only a POSITIVE resolution to an existing local branch is spared.
// ═══════════════════════════════════════════════════════════════════════════
// DEDICATED repo, not the shared `overLimit`. Measured while authoring: reusing
// it made all three RED poles report `blocked=false` even though the parser
// verdicts were correct — including the `-b` form that PASSES identically in
// pair1b earlier in this file. These cases run last, so they inherit whatever
// state earlier fixtures left on the shared repo, and an order-dependent
// fixture is a non-discriminating instrument wearing a green tick.
const wtRepo = buildRepo({
  lanes: Array.from({ length: WIP_LIMIT }, (_, i) => ({
    name: `feat/wt-lane-${String(i + 1).padStart(2, "0")}`,
    ageHours: 2 + i,
  })),
});
const wtAttachGreen = runGuard({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "git worktree add ../wt-attach feat/wt-lane-01" },
  cwd: wtRepo.work,
});
const wtNewBranchRed = runGuard({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "git worktree add ../wt-new -b feat/brand-new" },
  cwd: wtRepo.work,
});
const wtMissingRefRed = runGuard({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "git worktree add ../wt-missing no/such/branch" },
  cwd: wtRepo.work,
});
const wtBareAddRed = runGuard({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "git worktree add ../wt-bare" },
  cwd: wtRepo.work,
});

check(
  "pair18-green-ATTACH-to-existing-lane-is-not-charged",
  wtAttachGreen.blocked !== true,
  `attaching a worktree to feat/lane-01 (already one of the counted lanes) adds a worker, not inventory — the count is unchanged, so it must not be refused; got blocked=${wtAttachGreen.blocked}`,
);
check(
  "pair18-red-DASH-B-mints-a-branch-and-IS-charged",
  wtNewBranchRed.blocked === true,
  `-b explicitly creates a NEW branch, which is genuine inventory; got blocked=${wtNewBranchRed.blocked}`,
);
check(
  "pair18-red-UNRESOLVABLE-ref-FAILS-CLOSED",
  wtMissingRefRed.blocked === true,
  `a ref that does not resolve to refs/heads/ must be treated as creating — only a POSITIVE resolution is spared; got blocked=${wtMissingRefRed.blocked}`,
);
check(
  "pair18-red-BARE-add-derives-a-new-branch-and-IS-charged",
  wtBareAddRed.blocked === true,
  `git worktree add <path> with no commit-ish makes git derive a NEW branch from the basename; got blocked=${wtBareAddRed.blocked}`,
);
polesDiffer("pair18-poles-differ", wtNewBranchRed, wtAttachGreen);

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 19 — a COMPOSED command cannot launder a lane past the ceiling.
//
// THE BYPASS THIS PINS, found by adversarial review and REPRODUCED before fixing.
// `parseGitInvocations` yields one invocation per shell segment, in order. The
// `worktree` arm RETURNED where every sibling arm BREAKs, so the first segment
// decided the whole command and a later creating segment was never examined:
//
//   git worktree add ../w <existing-branch> && git switch -c new-lane  -> passthrough
//   git worktree add --detach ../w          && git switch -c new-lane  -> passthrough
//
// Both opened a lane unrefused. Precondition: none — any Bash call. The second
// needs no ref at all, so it was the cheaper half. The "fails closed" claim was
// true of REF RESOLUTION and did not reach multi-segment composition — which is
// why PAIR 18's four single-invocation cases all passed throughout.
//
// These are parser-level assertions on purpose: the defect was in the verdict,
// not in the guard's use of it, and a parser case cannot be masked by repo state.
// ═══════════════════════════════════════════════════════════════════════════
{
  const LC = require("../../hooks/lib/wip-lanes.js").laneCreationIntent;
  const compoundAttach = LC(
    "git worktree add ../w feat/lane-01 && git switch -c new-lane",
  );
  const compoundDetach = LC(
    "git worktree add --detach ../w && git switch -c new-lane",
  );
  const attachAlone = LC("git worktree add ../w feat/lane-01");
  const detachAlone = LC("git worktree add --detach ../w");

  check(
    "pair19-red-COMPOSED-attach-then-create-is-CHARGED",
    compoundAttach.creates === true && !compoundAttach.attachTo,
    `a later 'switch -c' must outrank an earlier attach, and must NOT inherit its attachTo (which would let the guard resolve a ref and pass the whole command through); got ${JSON.stringify(compoundAttach)}`,
  );
  check(
    "pair19-red-COMPOSED-detach-then-create-is-CHARGED",
    compoundDetach.creates === true,
    `--detach contributes no inventory but must not END the scan; got ${JSON.stringify(compoundDetach)}`,
  );
  check(
    "pair19-green-attach-ALONE-still-spared",
    attachAlone.creates === true && attachAlone.attachTo === "feat/lane-01",
    `the fix must not re-break the over-count PAIR 18 exists for; got ${JSON.stringify(attachAlone)}`,
  );
  check(
    "pair19-green-detach-ALONE-still-uncharged",
    detachAlone.creates === false,
    `got ${JSON.stringify(detachAlone)}`,
  );
  polesDiffer(
    "pair19-poles-differ",
    String(compoundDetach.creates),
    String(detachAlone.creates),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 20 — THE OVERRIDE LEDGER IS A HARDENED SINK (loom#1349 § Scope).
//
// `recordOverride` wrote the override-receipt ledger with the exact pre-#1349
// idiom — `mkdirSync(…,{recursive:true})` then `appendFileSync` — with no
// symlink refusal, no `O_NOFOLLOW` and no explicit mode, while `append-sink.js`
// § Scope asserted that EVERY JSONL sink under `.claude/hooks/` routed through
// it. The claim was measurably broader than the code. These rows pin the claim
// TRUE, and pin the two properties that must survive the routing.
//
// The sink is operator-influenced in a way most sinks are not: the receipt
// `reason` is 400 chars of arbitrary text that reaches a JSONL file, so the
// injection pole below is not hypothetical.
// ═══════════════════════════════════════════════════════════════════════════
const LEDGER_REL = path.join(".claude", "wip-authz", "override-ledger.jsonl");

/** Rows currently in the ledger, parsed. `null` when the file is absent. */
function ledgerRows(repoWork) {
  const p = path.join(repoWork, LEDGER_REL);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { __unparseable: l };
      }
    });
}

// ── GREEN POLE: an honest tree. The row lands, and lands hardened. ──────────
const ledgerGreen = buildRepo({
  lanes: Array.from({ length: WIP_LIMIT }, (_, i) => ({
    name: `feat/led-${String(i + 1).padStart(2, "0")}`,
    ageHours: 3 + i,
  })),
});
const ledgerGreenPayload = laneOpenPayload(ledgerGreen.work);
// Baseline first: without it, every row below would pass against a guard that
// never blocks and therefore never records an override at all.
check(
  "pair20-baseline-no-receipt-BLOCKS",
  runGuard(ledgerGreenPayload).blocked === true,
  `the ledger rows are meaningless unless the un-receipted call is refused`,
);
writeReceipt(ledgerGreen.work, "land-first: feat/led-01 — approved for the s82 wrapup");
const ledgerGreenRun = runGuard(ledgerGreenPayload);
const greenRows = ledgerRows(ledgerGreen.work);

check(
  "pair20-green-override-HONOURED",
  ledgerGreenRun.blocked === false && Boolean(ledgerGreenRun.advisory),
  `got ${JSON.stringify(ledgerGreenRun.json)}`,
);
check(
  "pair20-green-row-LANDS-at-the-real-sink",
  Array.isArray(greenRows) && greenRows.length === 1,
  `the honest path must still write its audit row; got ${JSON.stringify(greenRows)}`,
);
check(
  "pair20-green-row-carries-reason-and-land-first",
  Array.isArray(greenRows) &&
    greenRows.length === 1 &&
    greenRows[0].land_first === "feat/led-01" &&
    String(greenRows[0].reason).includes("approved for the s82 wrapup"),
  `the routed row must be byte-equivalent to the one appendFileSync wrote; got ${JSON.stringify(greenRows)}`,
);
// Defense 4: `appendFileSync` created at `0o666 & ~umask` — typically 0o644.
// `appendSinkLine` fchmods every append, so the audit trail is not world-readable.
const greenMode = existsSync(path.join(ledgerGreen.work, LEDGER_REL))
  ? statSync(path.join(ledgerGreen.work, LEDGER_REL)).mode & 0o777
  : null;
check(
  "pair20-green-ledger-is-0600-not-world-readable",
  greenMode === 0o600,
  `the override ledger correlates an operator to a lane and a stated reason; appendFileSync left it ${greenMode === null ? "absent" : "0o" + greenMode.toString(8)}`,
);

// ── RED POLE: a symlink planted at the sink FILE. ──────────────────────────
// The pre-#1349 idiom FOLLOWS this and writes the operator-correlatable row to
// the attacker's target outside the repo. `O_NOFOLLOW` must refuse it.
const ledgerRed = buildRepo({
  lanes: Array.from({ length: WIP_LIMIT }, (_, i) => ({
    name: `feat/red-${String(i + 1).padStart(2, "0")}`,
    ageHours: 3 + i,
  })),
});
const escapeDir = mkdtempSync(path.join(tmpdir(), "wip-escape-"));
cleanup.push(escapeDir);
const escapeTarget = path.join(escapeDir, "stolen.jsonl");
writeFileSync(escapeTarget, "");
mkdirSync(path.join(ledgerRed.work, ".claude", "wip-authz"), { recursive: true });
symlinkSync(escapeTarget, path.join(ledgerRed.work, LEDGER_REL));

const ledgerRedPayload = laneOpenPayload(ledgerRed.work);
writeReceipt(ledgerRed.work, "land-first: feat/red-01 — approved");
const ledgerRedRun = runGuard(ledgerRedPayload);
const escapedBytes = readFileSync(escapeTarget, "utf8");

check(
  "pair20-red-symlinked-sink-is-NOT-followed",
  escapedBytes === "",
  `the row escaped the repo through a symlinked sink — this is the loom#1349 defect; target now holds ${JSON.stringify(escapedBytes)}`,
);
// THE FAILURE DIRECTION, PINNED. The override has already been HONOURED by the
// time the ledger is written, and the emit that follows is advisory. A refused
// ledger write must cost an audit row, NEVER the operator's override — otherwise
// anyone who can plant a symlink at the sink acquires a VETO over overrides.
check(
  "pair20-red-refused-write-does-NOT-block-the-override",
  ledgerRedRun.blocked === false && Boolean(ledgerRedRun.advisory),
  `a failed audit write must never become a gate; got ${JSON.stringify(ledgerRedRun.json)}`,
);
check(
  "pair20-red-override-still-AUDITED-on-the-agent-channel",
  Boolean(ledgerRedRun.advisory) && ledgerRedRun.advisory.includes("OVERRIDDEN"),
  `the advisory is a separate channel from the ledger and must survive the sink refusal; got ${JSON.stringify(ledgerRedRun.advisory)}`,
);
polesDiffer(
  "pair20-poles-differ",
  `escaped=${escapedBytes.length > 0}`,
  `escaped=${(greenRows || []).length > 0}`,
);

// ── RED POLE 2: a symlink planted at the sink DIRECTORY. ───────────────────
// Distinct from the file case: recursive `mkdirSync` NO-OPS when the path already
// resolves to a directory, so the pre-#1349 idiom created nothing, noticed
// nothing, and appended through the link (append-sink defense 1/6).
const ledgerDir = buildRepo({
  lanes: Array.from({ length: WIP_LIMIT }, (_, i) => ({
    name: `feat/dir-${String(i + 1).padStart(2, "0")}`,
    ageHours: 3 + i,
  })),
});
const escapeDir2 = mkdtempSync(path.join(tmpdir(), "wip-escape-dir-"));
cleanup.push(escapeDir2);
mkdirSync(path.join(ledgerDir.work, ".claude"), { recursive: true });
symlinkSync(escapeDir2, path.join(ledgerDir.work, ".claude", "wip-authz"));
// The receipt shares the symlinked directory, so it is written THROUGH the link
// on purpose — the gate must still find it, and only the LEDGER write is refused.
writeReceipt(ledgerDir.work, "land-first: feat/dir-01 — approved");
const ledgerDirRun = runGuard(laneOpenPayload(ledgerDir.work));
const escapedDirFiles = readdirSync(escapeDir2).filter((f) => f.endsWith(".jsonl"));
check(
  "pair20-red-symlinked-sink-DIRECTORY-is-NOT-followed",
  escapedDirFiles.length === 0,
  `mkdirSync no-ops on a symlinked dir and appendFileSync writes through it; escaped files: ${JSON.stringify(escapedDirFiles)}`,
);
// EXPECTATION CHANGED s96, and it is the FIXTURE that was wrong, not the contract.
//
// This case symlinks `.claude/wip-authz` to an OUT-OF-TREE escape dir and writes the
// receipt through it, so it could assert that a refused LEDGER write still lets the
// override stand. The receipt-read hardening now refuses a receipt whose path
// RESOLVES OUTSIDE every declared root — and measured, the predicate is ESCAPE, not
// symlink-ness: an in-repo symlink whose target stays inside the root is still
// honoured, silently. So this receipt is refused for the right reason, and the
// override correctly does not stand on it.
//
// The pair's ORIGINAL subject — a refused ledger write must not block an override —
// is NOT abandoned; it moves below to a case that makes only the LEDGER unwritable
// and leaves the receipt readable, which is what isolates the property.
check(
  "pair20-escaping-symlinked-authz-dir-REFUSES-the-receipt",
  ledgerDirRun.blocked === true,
  `a receipt resolving outside every root must not lift a gate; got ${JSON.stringify(ledgerDirRun.json)}`,
);

// ── THE ORIGINAL SUBJECT, ISOLATED ────────────────────────────────────────
// Ledger UNWRITABLE, receipt READABLE and in-tree. This is the property the case
// above used to carry: a failed audit write costs an audit row, never the
// operator's override (`recordOverride` swallows `{ok:false}` deliberately).
{
  const roLedger = buildRepo({
    lanes: Array.from({ length: WIP_LIMIT }, (_, i) => ({
      name: `feat/roled-${String(i + 1).padStart(2, "0")}`,
      ageHours: 3 + i,
    })),
  });
  writeReceipt(roLedger.work, "approved\nland-first: feat/roled-01");
  const roLedgerPath = path.join(roLedger.work, ".claude", "wip-authz", "override-ledger.jsonl");
  writeFileSync(roLedgerPath, "");
  chmodSync(roLedgerPath, 0o444); // the FILE, not the dir: the receipt stays deletable
  let roRun;
  try {
    roRun = runGuard(laneOpenPayload(roLedger.work));
  } finally {
    try { chmodSync(roLedgerPath, 0o644); } catch {}
  }
  check(
    "pair20-unwritable-LEDGER-does-not-block-the-override",
    roRun && roRun.blocked === false,
    `a failed audit write costs a row, never the override; got ${JSON.stringify(roRun && roRun.json)}`,
  );
}

// ── THE OPERATOR-SUPPLIED `reason` IS JSONL-SAFE. ──────────────────────────
// 400 chars of attacker-influenced text reach this sink. A RAW newline would
// split ONE row into TWO, letting a crafted reason forge a second ledger entry
// with a `land_first` of its choosing. `JSON.stringify` escapes every C0 control
// character, so the newline survives as data INSIDE one row rather than as a
// row terminator — measured identical to the bytes `appendFileSync` received.
const ledgerInj = buildRepo({
  lanes: Array.from({ length: WIP_LIMIT }, (_, i) => ({
    name: `feat/inj-${String(i + 1).padStart(2, "0")}`,
    ageHours: 3 + i,
  })),
});
const FORGED = '\n{"at":"2099-01-01T00:00:00Z","land_first":"forged-lane","reason":"injected"}';
writeReceipt(ledgerInj.work, `land-first: feat/inj-01 — approved${FORGED}`);
const ledgerInjRun = runGuard(laneOpenPayload(ledgerInj.work));
const injRows = ledgerRows(ledgerInj.work);

check(
  "pair20-injection-yields-exactly-ONE-row",
  Array.isArray(injRows) && injRows.length === 1,
  `a raw newline in the reason must not forge a second ledger row; got ${JSON.stringify(injRows)}`,
);
check(
  "pair20-injection-no-forged-land_first",
  Array.isArray(injRows) && injRows.every((r) => r.land_first !== "forged-lane"),
  `the forged row must not appear under any parse; got ${JSON.stringify(injRows)}`,
);
check(
  "pair20-injection-newline-survives-ESCAPED-as-data",
  Array.isArray(injRows) &&
    injRows.length === 1 &&
    String(injRows[0].reason).includes("\n"),
  `the reason must be preserved verbatim (escaped), not truncated at the newline — the audit record is the point; got ${JSON.stringify(injRows)}`,
);
check(
  "pair20-injection-override-still-HONOURED",
  ledgerInjRun.blocked === false,
  `got ${JSON.stringify(ledgerInjRun.json)}`,
);
// MUST-1: the two poles must DIFFER. A benign reason yields a row whose parsed
// `reason` holds no newline; the adversarial one yields a row that does — same
// row COUNT either way, which is exactly the invariant being protected.
polesDiffer(
  "pair20-injection-poles-differ",
  `hasNewline=${Array.isArray(injRows) && injRows.length === 1 && String(injRows[0].reason).includes("\n")}`,
  `hasNewline=${Array.isArray(greenRows) && greenRows.length === 1 && String(greenRows[0].reason).includes("\n")}`,
);

// ── THE § Scope CLAIM ITSELF, PINNED STRUCTURALLY. ─────────────────────────
// `append-sink.js` § Scope asserts every JSONL/append sink under `.claude/hooks/`
// routes through it, except `state-io.js::appendViolation`. That claim went FALSE
// once before by a sink being added without routing. This pin makes the next
// occurrence a failing case rather than a prose over-claim nobody re-measures.
const HOOKS_DIR = path.resolve(HERE, "../../hooks");

// WHY THE MATCHER IS SHAPE-BASED AND NOT ONE SPELLING (loom, 2026-09-01).
//
// The first version of this pin matched `/\bfs\.appendFileSync\s*\(/` and nothing else. It was
// green while the § Scope claim it exists to pin was FALSE: a SECOND live violator —
// `transport-filesystem.js::appendRecord`, `await fs.promises.appendFile(logPath, line + "\n")`,
// reached from five production hooks — sat inside the walked tree the whole time. MEASURED, both
// poles on one tree: the old regex returned `true` on `fs.appendFileSync(` and `false` on
// `await fs.promises.appendFile(`. The case asserted the claim HOLDS while the claim was false,
// and the single positive control below it proved only that the regex fires on the ONE spelling
// it already knew — the exact `evidence-first-claims.md` MUST-6 shape (a green generalised past
// the class its instrument could observe, with a control that makes it look verified).
//
// So the matcher keys on the APPEND SHAPE, in three families:
//   (1) BY NAME — `appendFileSync(` / `appendFile(` under ANY receiver, including a bare or
//       destructured binding (`const {appendFile} = fs.promises`). Deliberately not anchored to
//       `fs.`: the receiver is the part that varies and the part that hid the violator.
//   (2) BY FLAG — `writeFile(Sync)(…, {flag:"a"})`. A truncating `writeFileSync` is NOT a sink and
//       MUST NOT match (40 honest tmp/atomic writers under `.claude/hooks/` use it); only the
//       append flag makes it one.
//   (3) BY STREAM — `createWriteStream(…, {flags:"a"})`, same reasoning as (2).
// Families (2) and (3) read a bounded FORWARD WINDOW of `FLAG_WINDOW` lines, because the options
// object is routinely on the lines after the call. The window is a stated bound, not a guess: a
// flag pushed further than that is a miss, and the honest disposition is to widen the constant
// rather than to claim the matcher is exhaustive.
const APPEND_BY_NAME = /\b(?:appendFileSync|appendFile)\s*\(/;
const WRITE_CALL = /\b(?:writeFileSync|writeFile)\s*\(/;
const STREAM_CALL = /\bcreateWriteStream\s*\(/;
const APPEND_FLAG = /\bflags?\s*:\s*(["'`])a[+]?\1/;
const FLAG_WINDOW = 4;
function appendShapedSite(codeLines, i) {
  const line = codeLines[i];
  if (APPEND_BY_NAME.test(line)) return true;
  if (!WRITE_CALL.test(line) && !STREAM_CALL.test(line)) return false;
  return APPEND_FLAG.test(codeLines.slice(i, i + FLAG_WINDOW).join("\n"));
}
function bareAppendSites(dir) {
  const hits = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) {
        // `append-sink.js` IS the primitive; its own call is the sanctioned one.
        if (path.basename(p) === "append-sink.js") continue;
        const codeLines = readFileSync(p, "utf8")
          .split("\n")
          .map((line) => line.replace(/^\s*(\/\/|\*|\/\*).*$/, ""));
        for (let i = 0; i < codeLines.length; i++)
          if (appendShapedSite(codeLines, i)) hits.push(`${path.basename(p)}:${i + 1}`);
      }
    }
  };
  walk(dir);
  return hits;
}
const bareSites = bareAppendSites(HOOKS_DIR);
check(
  "pair20-scope-claim-holds-no-bare-append-sink-remains",
  bareSites.length === 0,
  `append-sink.js § Scope claims every sink routes through it; these do not: ${JSON.stringify(bareSites)} — route them, or amend § Scope to name the exception`,
);
// ── THE ARMS, DECLARED — NOT CONTROLLED BY HAND. ───────────────────────────
//
// An empty result from `bareAppendSites` is informative only if this instrument
// can produce a NON-empty one — and it is built from SIX arms, so it owes SIX
// firings, not one (`instrument-discipline.md` MUST-3(a)). The previous version
// of this block asserted that by hand, in four bundled rows, and the habit is
// exactly what failed the first time: the sole control fired on `appendFileSync`
// while the live violator wore `await fs.promises.appendFile(`, and the case
// above asserted the § Scope claim HELD while it was FALSE.
//
// `_lib/arm-coverage.mjs` makes it mechanical instead of remembered. Each arm is
// a DECLARED ROW with its own known-positive; a declared arm that cannot fire is
// a named FAIL, and an arm set that is empty is a named FAIL too. Bundling four
// arms into one `&&` row — what this block used to do — cannot say WHICH arm
// died, so a future narrowing of the regex reads as one anonymous red.
//
// The probe is the WHOLE per-line pipeline `bareAppendSites` runs (comment strip,
// then shape match), not `appendShapedSite` alone. Controlling a sub-component
// licenses nothing about the composite, which is this rule's own MUST-4.
const stripComment = (line) => line.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
const appendProbe = (sample) =>
  appendShapedSite((Array.isArray(sample) ? sample : [sample]).map(stripComment), 0);

assertArmsFire(check, {
  id: "pair20-scope-matcher",
  probe: appendProbe,
  arms: [
    {
      name: "appendFileSync",
      sample: '  fs.appendFileSync(abs, line + "\\n");',
      why: "the ONE spelling the original regex knew — kept so a narrowing back to it still reds elsewhere",
    },
    {
      name: "promises-appendFile",
      sample: '    await fs.promises.appendFile(logPath, line + "\\n");',
      why: "the live violator's exact spelling; its absence here is what let the § Scope claim stay green while false",
    },
    {
      name: "destructured-appendFile",
      sample: "  await appendFile(p, line);",
      why: "`const { appendFile } = fs.promises` — the receiver is the part that varies and the part that hid the violator",
    },
    {
      name: "writeFile-flag-a",
      sample: '  fs.writeFileSync(p, line, { flag: "a" });',
      why: "a write is a sink only by its flag; UNFIRED against the tree today, so assumed-sound is not available",
    },
    {
      name: "writeFile-flag-a-plus",
      sample: '  await fsp.writeFile(p, line, { flag: "a+" });',
      why: "the `a+` spelling of the same flag arm",
    },
    {
      name: "createWriteStream-flags-a-forward-window",
      sample: ["  fs.createWriteStream(p, {", '    flags: "a",', "  });"],
      why: "exercises the FLAG_WINDOW forward read as well as the stream arm — the options object is routinely on a later line",
    },
  ],
  blind: [
    {
      name: "commented-out-call",
      sample: "  // fs.appendFileSync(abs, line);",
      why: "the comment strip is part of the probe; a matcher that reads commented code reports phantoms",
    },
    {
      name: "truncating-writeFileSync",
      sample: "  fs.writeFileSync(tmp, body, { mode: 0o600 });",
      why: "~40 honest atomic writers under .claude/hooks/ take this shape",
    },
    {
      name: "exclusive-write-flag-wx",
      sample: '  fs.writeFileSync(marker, "1", { flag: "wx" });',
      why: "an exclusive create is not an append",
    },
    {
      name: "unflagged-createWriteStream",
      sample: "  fs.createWriteStream(p);",
      why: "a stream is a sink only by its flags",
    },
    {
      name: "plain-writeFileSync-newline",
      sample: '  fs.writeFileSync(p, JSON.stringify(d) + "\\n");',
      why: "a trailing newline is not an append flag; matching this would flag every JSON writer in the tree",
    },
  ],
});

// ── THE HELPER'S OWN FIRING, BOTH POLES. ───────────────────────────────────
//
// `assertArmsFire` is itself an instrument, and an instrument never shown to
// fire HERE is BLOCKED as evidence however sound its logic — including the one
// whose whole purpose is to enforce that. Shipping it on its own reasoning would
// be the defect it exists to prevent, one level up.
//
// `selfProof()` runs the SAME arm declaration against two probes that differ
// only in whether the `beta` arm can match, and returns the collected rows. The
// RED pole must name `beta` specifically; the GREEN pole must be clean. Both
// poles on ONE tree, in ONE process, so nothing about the environment separates
// them (`instrument-bipolarity.md` MUST-1).
const armProof = selfProof();
check(
  "pair20-armcoverage-SELFPROOF-red-reds-the-DEAD-arm-BY-NAME",
  armProof.red.row("arm-beta") !== undefined &&
    armProof.red.row("arm-beta").ok === false &&
    armProof.red.row("arm-alpha") !== undefined &&
    armProof.red.row("arm-alpha").ok === true,
  `the helper must fail the arm that cannot match its own sample and pass the one that can; got ${JSON.stringify(armProof.red.rows.map((r) => [r.name, r.ok]))}`,
);
check(
  "pair20-armcoverage-SELFPROOF-red-aggregate-NAMES-the-dead-arm",
  armProof.red.row("EVERY-ARM-FIRED") !== undefined &&
    armProof.red.row("EVERY-ARM-FIRED").ok === false &&
    armProof.red.row("EVERY-ARM-FIRED").detail.includes("beta") &&
    JSON.stringify(armProof.red.result.dead) === '["beta"]',
  `a dead arm must be named LOUDLY in the aggregate, not merely counted; got ${JSON.stringify(armProof.red.row("EVERY-ARM-FIRED"))}`,
);
check(
  "pair20-armcoverage-SELFPROOF-green-passes-EVERY-row",
  armProof.green.rows.length === armProof.red.rows.length &&
    armProof.green.rows.every((r) => r.ok === true) &&
    armProof.green.result.dead.length === 0 &&
    armProof.green.result.overreach.length === 0,
  `with the arm repaired the helper must go silent, or it reds on everything and its red carries no information; got ${JSON.stringify(armProof.green.rows.map((r) => [r.name, r.ok]))}`,
);
polesDiffer(
  "pair20-armcoverage-SELFPROOF-poles-differ",
  `aggregateOk=${armProof.red.row("EVERY-ARM-FIRED").ok}`,
  `aggregateOk=${armProof.green.row("EVERY-ARM-FIRED").ok}`,
);
check(
  "pair20-armcoverage-SELFPROOF-refuses-an-EMPTY-arm-set",
  (() => {
    const rows = [];
    const res = assertArmsFire((n, ok, d) => rows.push({ name: n, ok, detail: d }), {
      id: "empty",
      probe: () => true,
      arms: [],
    });
    return (
      rows.length === 1 &&
      rows[0].ok === false &&
      rows[0].detail.includes("NON-EMPTY") &&
      res.errors.length === 1
    );
  })(),
  "an instrument declaring NO arms has shown nothing; a zero-row silent pass is the vacuity this helper exists to refuse",
);

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 21 — MUST-3, THE AGE DOOR AT THE **BASH** ARM (2026-09-06).
//
// THE DEFECT THIS PINS. MUST-3 is titled "AGE Governs, Not COUNT — The Bound Is
// 24 Hours", and until this change AGE was the one axis with a REPORT and no
// DOOR: it was carried at `SessionStart` at `halt-and-report` while COUNT
// (MUST-2) and the override DEBT both refused at `PreToolUse:Bash`. MEASURED
// consequence on this repo: an aged lane was named in that SessionStart report
// at every session start for three days and dispositioned at none. The rule's
// own Wiring had already recorded twice that a ceiling which reports is not a
// ceiling.
//
// WHY THE POLES ARE BUILT UNDER THE COUNT LIMIT. A repo at 2 lanes and 3 days is
// under every count this ceiling measures and is exactly the state MUST-3 calls
// a defect — so a RED pole built at 5 lanes would be indistinguishable from the
// count door firing, and would pass identically with the age door deleted. Every
// firing row below therefore asserts the count is UNDER the limit and that the
// emitted body is NOT the count door's. Three doors sit on this one arm; a pole
// that cannot say WHICH one fired is not evidence about any of them.
// ═══════════════════════════════════════════════════════════════════════════
const { utimesSync: p21_utimesSync } = require("node:fs");
const p21_OLD = AGE_BOUND_HOURS * 3; // 72h — comfortably past bound, not borderline

// ── the RED tree: ONE past-bound lane, count far under the limit ────────────
const p21_agedRepo = buildRepo({
  lanes: [
    { name: "feat/aged-work", ageHours: p21_OLD },
    { name: "feat/fresh-work", ageHours: 1 },
  ],
});
// ── the GREEN tree: the SAME shape, every lane inside the bound ─────────────
const p21_youngRepo = buildRepo({
  lanes: [
    { name: "feat/young-a", ageHours: 2 },
    { name: "feat/young-b", ageHours: 1 },
  ],
});

const p21_bashOpen = (cwd) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  cwd,
  tool_input: { command: "git switch -c feat/one-more-lane" },
});

// ── unit tier: the predicate itself ────────────────────────────────────────
const p21_agedFast = laneCountFast({ repoDir: p21_agedRepo.work });
const p21_youngFast = laneCountFast({ repoDir: p21_youngRepo.work });

check(
  "pair21-laneCountFast-carries-tip-dates-ADDITIVELY",
  p21_agedFast.ok === true &&
    Array.isArray(p21_agedFast.lanes) &&
    p21_agedFast.lanes.length === p21_agedFast.count &&
    p21_agedFast.names.length === p21_agedFast.count &&
    p21_agedFast.lanes.every((l) => l.name && l.ageBasis === "tip-committerdate"),
  `the age door reads its scan order off this field; count/names must be unchanged for every existing caller. got ${JSON.stringify(p21_agedFast)}`,
);
check(
  "pair21-RED-tree-is-genuinely-UNDER-the-count-limit",
  p21_agedFast.count < WIP_LIMIT,
  `if this tree were at the limit the rows below could not tell the AGE door from the COUNT door; got count=${p21_agedFast.count} limit=${WIP_LIMIT}`,
);

const p21_agedVerdict = confirmAgedLane({
  repoDir: p21_agedRepo.work,
  lanes: p21_agedFast.lanes,
});
const p21_youngVerdict = confirmAgedLane({
  repoDir: p21_youngRepo.work,
  lanes: p21_youngFast.lanes,
});
check(
  "pair21-unit-confirmAgedLane-FIRES-on-a-past-bound-lane",
  p21_agedVerdict.decided === true &&
    p21_agedVerdict.aged === true &&
    p21_agedVerdict.name === "feat/aged-work" &&
    p21_agedVerdict.uniqueCommits > 0 &&
    p21_agedVerdict.ageHours > AGE_BOUND_HOURS &&
    p21_agedVerdict.ageBasis === "oldest-unlanded-commit",
  `a lane at ${p21_OLD}h with MEASURED unlanded content must be confirmed; got ${JSON.stringify(p21_agedVerdict)}`,
);
check(
  "pair21-unit-confirmAgedLane-SILENT-on-lanes-inside-the-bound",
  p21_youngVerdict.decided === true && p21_youngVerdict.aged === false,
  `lanes at 1-2h must not be confirmed, or the predicate fires on everything and its firing carries no information; got ${JSON.stringify(p21_youngVerdict)}`,
);
polesDiffer(
  "pair21-unit-poles-differ",
  `aged=${p21_agedVerdict.aged}`,
  `aged=${p21_youngVerdict.aged}`,
);

// ── THE KNOWN-ANSWER REGRESSION: a FRESH TIP over OLD CONTENT. ────────────
//
// The first draft of `confirmAgedLane` PREFILTERED candidates by tip date on the
// argument that "the tip is the newest commit, so a lane whose tip is inside the
// bound holds no unlanded commit outside it". The inequality runs the OTHER way.
// Fired at a known-answer case before it was trusted
// (`instrument-discipline.md` MUST-3(a)), the draft silently excluded the very
// lane the door exists for: MEASURED on the real tree, TIP age 0.025h,
// oldest-unlanded-commit age 73.19h. This row is that case, hermetic.
const p21_freshTip = buildRepo({ lanes: [{ name: "feat/old-content", ageHours: p21_OLD }] });
git(p21_freshTip.work, ["checkout", "-q", "feat/old-content"]);
writeFileSync(path.join(p21_freshTip.work, "second.txt"), "second\n");
git(p21_freshTip.work, ["add", "-A"]);
git(p21_freshTip.work, ["commit", "-qm", "touch the tip"], { date: stampHoursAgo(0) });
git(p21_freshTip.work, ["checkout", "-q", "main"]);
const p21_freshTipFast = laneCountFast({ repoDir: p21_freshTip.work });
const p21_freshTipLane = p21_freshTipFast.lanes.find((l) => l.name === "feat/old-content");
check(
  "pair21-regression-tree-really-HAS-a-fresh-tip",
  p21_freshTipLane && p21_freshTipLane.ageHours < AGE_BOUND_HOURS,
  `without a tip inside the bound this row proves nothing about the prefilter; got ${JSON.stringify(p21_freshTipLane)}`,
);
const p21_freshTipVerdict = confirmAgedLane({
  repoDir: p21_freshTip.work,
  lanes: p21_freshTipFast.lanes,
});
check(
  "pair21-TIP-date-is-ORDERING-not-a-FILTER",
  p21_freshTipVerdict.decided === true &&
    p21_freshTipVerdict.aged === true &&
    p21_freshTipVerdict.ageHours > AGE_BOUND_HOURS &&
    p21_freshTipVerdict.tipAgeHours < AGE_BOUND_HOURS,
  `a lane committed to minutes ago can carry days-old unlanded work; a tip prefilter drops exactly the lane the door exists for. got ${JSON.stringify(p21_freshTipVerdict)}`,
);

// ── AGE IS NOT MTIME. MUST-3 names the incident: a 44h tree read as 11.1h from
//    `stat().mtime`, the one error direction an ageing metric must not have.
//    Touching every path in the working tree must not move the verdict.
p21_utimesSync(p21_agedRepo.work, new Date(), new Date());
p21_utimesSync(path.join(p21_agedRepo.work, "README.md"), new Date(), new Date());
const p21_afterTouch = confirmAgedLane({
  repoDir: p21_agedRepo.work,
  lanes: laneCountFast({ repoDir: p21_agedRepo.work }).lanes,
});
check(
  "pair21-age-basis-survives-an-MTIME-TOUCH",
  p21_afterTouch.aged === true && p21_afterTouch.name === "feat/aged-work",
  `a re-implementation on directory mtime would read this tree as fresh and go silent — which is the 44h-as-11.1h defect MUST-3 was written from; got ${JSON.stringify(p21_afterTouch)}`,
);

// ── FAIL OPEN, three channels. Each lowers the chance of a refusal, which is
//    the only direction that cannot refuse work the operator is entitled to.
const p21_unanswerable = confirmAgedLane({
  repoDir: p21_agedRepo.work,
  lanes: [{ name: "no-such-branch-anywhere", ageHours: p21_OLD }],
});
check(
  "pair21-failopen-unanswerable-lane-is-SKIPPED-not-blocked",
  p21_unanswerable.decided === true &&
    p21_unanswerable.aged === false &&
    p21_unanswerable.unanswerable === 1,
  `git could not answer for this ref; reading that as an aged lane would manufacture a block out of a failed command. got ${JSON.stringify(p21_unanswerable)}`,
);
const p21_exhausted = confirmAgedLane({
  repoDir: p21_agedRepo.work,
  lanes: p21_agedFast.lanes,
  budgetMs: -1,
});
check(
  "pair21-failopen-p21_exhausted-budget-is-UNDECIDED-not-clean",
  p21_exhausted.decided === false && p21_exhausted.aged === undefined,
  `an exhausted budget must not report a verdict — an aged:false here would be indistinguishable from a measured all-clear; got ${JSON.stringify(p21_exhausted)}`,
);
const p21_landedOld = buildRepo({
  lanes: [{ name: "feat/rebased-away", ageHours: p21_OLD }],
  landContent: true,
});
const p21_landedOldFast = laneCountFast({ repoDir: p21_landedOld.work });
check(
  "pair21-landed-tree-still-reads-OPEN-by-ancestry",
  p21_landedOldFast.count >= 1,
  `the row below rests on the ancestry bound still listing this lane; got ${JSON.stringify(p21_landedOldFast)}`,
);
const p21_landedVerdict = confirmAgedLane({
  repoDir: p21_landedOld.work,
  lanes: p21_landedOldFast.lanes,
});
check(
  "pair21-failopen-LANDED-content-never-ages-into-a-block",
  p21_landedVerdict.decided === true && p21_landedVerdict.aged === false,
  `a cherry-picked-away branch has an OLD tip and ZERO unlanded commits; blocking on its date would refuse work over content already on main. got ${JSON.stringify(p21_landedVerdict)}`,
);
check(
  "pair21-NULL-tip-age-lane-is-still-MEASURED-not-dropped",
  (() => {
    const v = confirmAgedLane({
      repoDir: p21_agedRepo.work,
      lanes: [{ name: "feat/aged-work", ageHours: null }],
    });
    return v.decided === true && v.aged === true;
  })(),
  `an unreadable TIP date sorts a lane last; it must not DROP it, or an unparseable field silently hides inventory`,
);

// ── guard tier: the shipped hook, driven as the harness drives it ──────────
const p21_agedGuard = runGuard(p21_bashOpen(p21_agedRepo.work));
const p21_youngGuard = runGuard(p21_bashOpen(p21_youngRepo.work));
check(
  "pair21-age-door-BLOCKS-lane-creation-under-the-count-limit",
  p21_agedGuard.blocked === true && p21_agedGuard.status === 2,
  `MUST-3's bound is the rule's governing axis and had no door; got ${JSON.stringify(p21_agedGuard.json)}`,
);
check(
  "pair21-age-door-cites-MUST-3-and-names-the-past-bound-lane",
  Boolean(p21_agedGuard.advisory) &&
    p21_agedGuard.advisory.includes("MUST-3") &&
    p21_agedGuard.advisory.includes("feat/aged-work"),
  `a refusal that names neither its clause nor its lane cannot be dispositioned; got ${JSON.stringify(p21_agedGuard.advisory)}`,
);
check(
  "pair21-age-door-is-NOT-the-COUNT-door-wearing-a-different-hat",
  Boolean(p21_agedGuard.advisory) &&
    !p21_agedGuard.advisory.includes("WIP limit REACHED") &&
    p21_agedGuard.advisory.includes("not reached"),
  `three doors share this arm; a row that cannot separate them would stay green with the age door deleted. got ${JSON.stringify(p21_agedGuard.advisory)}`,
);
check(
  "pair21-age-door-STATES-ITS-BASIS-as-the-oldest-unlanded-commit",
  Boolean(p21_agedGuard.advisory) &&
    p21_agedGuard.advisory.includes("OLDEST commit") &&
    p21_agedGuard.advisory.includes("mtime"),
  `MUST-3 requires age from CREATION and forbids mtime; the body must say which it used, or the operator cannot audit the number. got ${JSON.stringify(p21_agedGuard.advisory)}`,
);
check(
  "pair21-age-door-NAMES-ITS-OWN-ESCAPE",
  Boolean(p21_agedGuard.advisory) &&
    p21_agedGuard.advisory.includes(RECEIPT_REL) &&
    p21_agedGuard.advisory.includes(ESCAPE_ENV),
  `a refusal that does not name its escape is the dead end hook-output-discipline.md MUST NOT warns about; got ${JSON.stringify(p21_agedGuard.advisory)}`,
);
check(
  "pair21-lanes-inside-the-bound-stay-SILENT",
  fired(p21_youngGuard) === false && p21_youngGuard.json && p21_youngGuard.json.continue === true,
  `a repo whose lanes are hours old is healthy flow, not rot; firing here would refuse every lane creation forever. got ${JSON.stringify(p21_youngGuard.json)}`,
);
polesDiffer("pair21-guard-poles-differ", fired(p21_agedGuard), fired(p21_youngGuard));

// A MENTION IS NOT A CREATION, on the age axis too. The lexical match selects
// only WHICH question to ask; a command that merely names the construct opens no
// lane and must pass even on the RED tree.
const p21_mentionOnAged = runGuard({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  cwd: p21_agedRepo.work,
  tool_input: { command: 'echo "run git switch -c feat/x to start"' },
});
check(
  "pair21-a-MENTION-is-not-a-creation-under-the-age-door",
  fired(p21_mentionOnAged) === false,
  `the age door must not widen the lexical surface the parser defines; got ${JSON.stringify(p21_mentionOnAged.advisory)}`,
);

// An UNDERIVABLE COUNT fails open even with a past-bound lane present: without
// `origin/main` the whole lane model is unresolved and the guard must not refuse
// on a forest it could not enumerate (`cc-artifacts.md` Rule 7).
const p21_noBaseAged = buildRepo({
  lanes: [{ name: "feat/aged-no-base", ageHours: p21_OLD }],
  withRemote: false,
});
const p21_noBaseGuard = runGuard(p21_bashOpen(p21_noBaseAged.work));
check(
  "pair21-failopen-underivable-lane-model-refuses-NOTHING",
  fired(p21_noBaseGuard) === false && p21_noBaseGuard.blocked === false,
  `a guard that cannot enumerate lanes must not manufacture an age block; got ${JSON.stringify(p21_noBaseGuard.json)}`,
);

// ── the EXISTING override channel, on the NEW door. No second channel. ─────
writeReceipt(
  p21_agedRepo.work,
  "landing the s91 fold needs this lane opened first\nland-first: feat/aged-work",
);
const p21_ageOverride = runGuard(p21_bashOpen(p21_agedRepo.work));
check(
  "pair21-age-door-honours-the-EXISTING-one-shot-receipt",
  p21_ageOverride.blocked === false &&
    Boolean(p21_ageOverride.advisory) &&
    p21_ageOverride.advisory.includes("OVERRIDDEN") &&
    p21_ageOverride.advisory.includes("s91 fold"),
  `the age door routes through the SAME audited channel as the count door; a second channel would split the audit trail. got ${JSON.stringify(p21_ageOverride.json)}`,
);
check(
  "pair21-age-override-SURFACES-the-age-finding-it-waived",
  Boolean(p21_ageOverride.advisory) && p21_ageOverride.advisory.includes("feat/aged-work"),
  `an override that does not name what it waived is a silent bypass wearing an advisory; got ${JSON.stringify(p21_ageOverride.advisory)}`,
);
check(
  "pair21-age-override-receipt-is-CONSUMED-from-disk",
  receiptExists(p21_agedRepo.work) === false,
  `a surviving receipt disarms the age door for every later call`,
);
const p21_ageAfterOverride = runGuard(p21_bashOpen(p21_agedRepo.work));
check(
  "pair21-age-door-RE-BLOCKS-after-the-one-shot-is-spent",
  p21_ageAfterOverride.blocked === true,
  `ONE-SHOT means one on this door too; got ${JSON.stringify(p21_ageAfterOverride.json)}`,
);
polesDiffer(
  "pair21-age-override-poles-differ",
  p21_ageOverride.blocked,
  p21_ageAfterOverride.blocked,
);
const p21_ageEnvOverride = runGuard(p21_bashOpen(p21_agedRepo.work), { [ESCAPE_ENV]: "1" });
check(
  "pair21-age-door-honours-the-EXISTING-env-channel",
  p21_ageEnvOverride.blocked === false &&
    Boolean(p21_ageEnvOverride.advisory) &&
    p21_ageEnvOverride.advisory.includes("OVERRIDDEN"),
  `the operator/CI channel must reach both doors, and must never be silent; got ${JSON.stringify(p21_ageEnvOverride.json)}`,
);
const p21_ageEnvZero = runGuard(p21_bashOpen(p21_agedRepo.work), { [ESCAPE_ENV]: "0" });
check(
  "pair21-age-door-env-channel-tests-the-LITERAL-1",
  p21_ageEnvZero.blocked === true,
  `an accidental VAR=0 must not disarm the age door; got ${JSON.stringify(p21_ageEnvZero.json)}`,
);
polesDiffer(
  "pair21-age-env-poles-differ",
  p21_ageEnvOverride.blocked,
  p21_ageEnvZero.blocked,
);

// ── INVENTORY, NEVER WORKERS. ─────────────────────────────────────────────
//
// The `PreToolUse:Task|Agent` arm was removed from this guard on 2026-08-29
// because an agent dispatch creates no branch, no worktree and no unlanded
// commit, so charging it throttled the delegate-first posture `agents.md`
// § Triad mandates. The age door must not re-open that surface by the back door,
// and the load-bearing half of that claim is the REGISTRATION, not the code —
// so it is asserted against `settings.json`, which is what the harness reads.
// Expanded: a `dispatch.js <Event>` entry stands for the registry's per-hook groups.
const p21_SETTINGS = require(path.resolve(HERE, "../../hooks/lib/dispatch-registry.js")).readExpandedSettings(path.resolve(HERE, "../../.."));
const p21_wipMatchers = [];
for (const [ev, matchers] of Object.entries(p21_SETTINGS.hooks || {})) {
  for (const m of matchers || []) {
    if ((m.hooks || []).some((h) => /wip-discipline-guard/.test(h.command || ""))) {
      p21_wipMatchers.push(`${ev}:${m.matcher === undefined ? "*" : m.matcher}`);
    }
  }
}
check(
  "pair21-guard-registers-NO-Task-or-Agent-arm",
  p21_wipMatchers.length > 0 &&
    p21_wipMatchers.every((k) => !/Task|Agent/.test(k)),
  `the ceiling bounds INVENTORY, never WORKERS; a Task|Agent registration charges a dispatch that opens no lane. registered at: ${JSON.stringify(p21_wipMatchers)}`,
);
check(
  "pair21-guard-IS-still-registered-at-the-Bash-arm",
  p21_wipMatchers.includes("PreToolUse:Bash"),
  `the row above is only informative if the guard is registered SOMEWHERE — an unregistered guard would pass it vacuously. registered at: ${JSON.stringify(p21_wipMatchers)}`,
);
// THE DISPATCH HALF OF THIS PAIR IS DELETED WITH THE ARM. It used to write two
// agent files into the fixture repo and drive the guard with a `Task` payload,
// asserting that a read-only agent passed the age door while a Bash-holding one
// was gated. Both poles ran through `PreToolUse:Task|Agent`, which no matcher has
// delivered since 2026-08-29 (`b77a71603`), so what they measured was a predicate
// no event reached. The registration rows ABOVE are what survive and they are the
// stronger statement: the ceiling registers NO dispatch arm and IS registered at
// Bash, read from `settings.json` rather than asserted about behaviour.

for (const d of [p21_agedRepo, p21_youngRepo, p21_freshTip, p21_landedOld, p21_noBaseAged]) {
  try {
    rmSync(d.root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 22 — THE REMOTE DOOR MUST NOT LEAK ITS RECEIPT (H2, loom s96).
//
// The guard's own comment at the `remoteHeld` declaration states the invariant:
// "the receipt is spent by whichever gate is the LAST to need it on this call —
// the local ceiling when it fires, `settleRemote()` below when nothing else
// does — and always exactly once."
//
// The s95 hand-merge composed main's AGE door with this branch's REMOTE-REF door
// and opened a THIRD exit between them: `if (!countBlocks && !ageBlocks)` emits a
// non-blocking `pre-action` report and returns DIRECTLY, past `settleRemote()`.
// On that path the remote door was held open on the receipt's strength, the call
// PROCEEDED, and the receipt was spent by NOBODY — so it held the door open again
// on the next call, and every call after. "Always exactly once" was false, and no
// ledger row was written, so the override was invisible to `unpaidOverrideDebt`.
//
// THE SHAPE THAT REACHES THAT EXIT — both halves are load-bearing:
//   (a) `landContent` cherry-picks each lane onto main, so every lane is
//       ancestry-UNMERGED (the FAST count reads at the limit) while its CONTENT
//       has landed (`confirm.confirmed` is 0) => countBlocks FALSE. Young lanes
//       keep ageBlocks FALSE. Together those are what select this exit over the
//       teeth below it.
//   (b) the remote door counts by ANCESTRY (`for-each-ref --merged`), which a
//       cherry-pick deliberately is not — so (a) alone leaves the door SILENT.
//       Pushing main under a second name creates a ref that IS an ancestor of
//       origin/main: landed, un-reaped, and counted. Without (b) the control
//       below does not fire and the whole pair proves nothing.
// ═══════════════════════════════════════════════════════════════════════════
{
  const leakRepo = buildRepo({
    lanes: Array.from({ length: WIP_LIMIT }, (_, i) => ({
      name: `feat/leak-lane-${i + 1}`,
      ageHours: 2 + i, // well under the 24h age bound
    })),
    withRemote: true,
    landContent: true,
  });
  // (b) a genuinely LANDED remote ref: origin/landed-ref-1 IS origin/main's commit,
  // so it is trivially an ancestor of the base and the door counts it.
  git(leakRepo.work, ["push", "-q", "origin", "main:refs/heads/landed-ref-1"]);

  const leakPayload = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git worktree add ../wt-leak -b feat/leak-next" },
    cwd: leakRepo.work,
  };

  // CONTROL: with NO receipt the remote door must REFUSE. Without this the rows
  // below would pass against a guard whose remote door never fires at all — the
  // vacuity that would make the whole pair meaningless. This control FAILED on
  // the first draft (wrong repo shape) and that is why (b) exists.
  const leakControl = runGuard(leakPayload);
  check(
    "pair22-control-remote-door-REFUSES-without-receipt",
    leakControl.blocked === true &&
      /remote ref/i.test(leakControl.advisory || ""),
    `the remote door must fire for this repo shape, else pair22 proves nothing; got ${JSON.stringify(leakControl.json)}`,
  );

  // ARM: one receipt, one lane-opening call. The remote door is held open on it
  // and the call PROCEEDS — which is what makes spending it mandatory.
  writeReceipt(
    leakRepo.work,
    "reaping blocked on this remote — approved\nland-first: feat/leak-lane-1",
  );
  const leakFirst = runGuard(leakPayload);
  check(
    "pair22-first-call-proceeds-on-the-receipt",
    leakFirst.blocked === false,
    `the receipt must hold the door open on the first call; got ${JSON.stringify(leakFirst.json)}`,
  );

  // THE ASSERTION. The receipt must be GONE. If it survives it holds the remote
  // door open for every later call in the session — a durable receipt, which
  // `override-receipt.js` calls "worse than no receipt at all".
  check(
    "pair22-receipt-CONSUMED-when-the-call-proceeds",
    receiptExists(leakRepo.work) === false,
    "the receipt survived a PROCEEDING call: the remote door leaks it (H2)",
  );

  // ... and the door must therefore RE-ARM on the next call.
  const leakSecond = runGuard(leakPayload);
  check(
    "pair22-remote-door-RE-ARMS-on-the-next-call",
    leakSecond.blocked === true,
    `the spent receipt must not hold the door open twice; got ${JSON.stringify(leakSecond.json)}`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 23 — THREE LANE-CREATING GIT FORMS THE CLASSIFIER CALLED NON-CREATING
// (M3, loom s96).
//
// `laneCreationIntent`'s `branch` arm uses a DENYLIST (`NON_CREATING`), which
// `cc-artifacts.md` Rule 10 warns against for exactly this reason: a denylist is
// only as good as what someone thought to enumerate, and three entries were
// enumerated WRONG rather than merely missed.
//
// VERIFIED BY EXECUTION, not by reading the man page, per the review's own
// instruction to check `git branch -c` empirically first:
//
//   $ git branch --format='%(refname:short)'   ->  main
//   $ git branch -c main copied                ->  rc=0
//   $ git branch --format='%(refname:short)'   ->  copied main
//
// A COPY CREATES A REF. `-c`/`-C`/`--copy` sat in NON_CREATING beside `-d`/`-m`,
// where a DELETE closes a lane and a MOVE leaves the count unchanged — but a copy
// adds one, so it belongs with `git branch <name>`, not with them.
//
// `--orphan` is the second half: `git switch --orphan x` sets HEAD to a new
// unborn branch (measured: `git symbolic-ref --short HEAD` -> `orph`), which is a
// lane opening on its first commit, and it was unhandled on BOTH `switch` and
// `checkout`.
// ═══════════════════════════════════════════════════════════════════════════
{
  const m3 = require("../../hooks/lib/wip-lanes.js").laneCreationIntent;

  // CONTROL: the forms the classifier already gets right, asserted first so a
  // classifier that called EVERYTHING creating could not pass this pair.
  check(
    "pair23-control-delete-is-NOT-creating",
    m3("git branch -D old-lane")?.creates !== true,
    "a delete CLOSES a lane; if this reads as creating the classifier is just saying yes",
  );
  check(
    "pair23-control-rename-is-NOT-creating",
    m3("git branch -m old new")?.creates !== true,
    "a rename leaves the lane COUNT unchanged",
  );
  check(
    "pair23-control-plain-create-IS-creating",
    m3("git branch feat/new-lane")?.creates === true,
    "positive control: the classifier must fire on the form it already handles",
  );

  // THE THREE THAT WERE WRONG.
  check(
    "pair23-branch-copy-short-IS-creating",
    m3("git branch -c main copied")?.creates === true,
    "MEASURED: `git branch -c` adds a ref (main -> copied main)",
  );
  check(
    "pair23-branch-copy-force-IS-creating",
    m3("git branch -C main copied")?.creates === true,
    "-C is -c with force; it still adds a ref",
  );
  check(
    "pair23-branch-copy-long-IS-creating",
    m3("git branch --copy main copied")?.creates === true,
    "the long spelling must not be a bypass of the short one",
  );
  check(
    "pair23-switch-orphan-IS-creating",
    m3("git switch --orphan feat/fresh")?.creates === true,
    "MEASURED: HEAD moves to a new unborn branch; the lane opens on first commit",
  );
  check(
    "pair23-checkout-orphan-IS-creating",
    m3("git checkout --orphan feat/fresh")?.creates === true,
    "the checkout spelling must not be a bypass of the switch one",
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 24 — THE ENV CHANNEL IS AUDITED TOO, OR THE HEADER IS WRONG (M4-env).
//
// The guard's header says: "OVERRIDE — two channels, both audited." Measured, it
// was one. `recordOverride` was reachable only from the two RECEIPT paths, so
// `COC_ALLOW_WIP_OVERRUN=1` honoured an override and wrote NO ledger row.
//
// Two consequences, and the second is the one that matters. The audit trail was
// simply absent for the operator/CI channel — that is the header's claim being
// false. And because `unpaidOverrideDebt` reads the ledger, the MUST-7 debt
// mechanism could not see env overrides at all: the receipt channel accrues a
// debt that refuses the NEXT override, while the env channel accrued nothing,
// forever. The cheaper bypass was the unaudited one.
//
// The row is AUDIT-ONLY and deliberately carries `land_first: null`, so it does
// NOT arm a debt against the next call — an env run is CI's channel and blocking
// it on a promise nobody can write into an env var would dead-end it. Making the
// header true is the whole claim here; pricing the env channel is not, and the
// control below pins that so a later change cannot quietly convert audit into
// enforcement.
// ═══════════════════════════════════════════════════════════════════════════
{
  const envRepo = buildRepo({
    lanes: Array.from({ length: WIP_LIMIT }, (_, i) => ({
      name: `feat/env-lane-${i + 1}`,
      ageHours: 3 + i,
    })),
  });
  const envPayload = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git switch -c feat/env-next" },
    cwd: envRepo.work,
  };

  // CONTROL: without the env var this repo BLOCKS, and the ledger is absent.
  const envBaseline = runGuard(envPayload);
  check(
    "pair24-control-blocks-without-env",
    envBaseline.blocked === true,
    `the env rows are meaningless unless the un-overridden call is refused; got ${JSON.stringify(envBaseline.json)}`,
  );
  check(
    "pair24-control-ledger-absent-before",
    ledgerRows(envRepo.work) === null,
    "a row asserted after must not have been there before",
  );

  const envRun = runGuard(envPayload, { COC_ALLOW_WIP_OVERRUN: "1" });
  check(
    "pair24-env-override-is-honoured",
    envRun.blocked === false,
    `the env channel must still honour the override; got ${JSON.stringify(envRun.json)}`,
  );

  const rows = ledgerRows(envRepo.work);
  check(
    "pair24-env-override-WRITES-a-ledger-row",
    Array.isArray(rows) && rows.length === 1,
    `the header claims both channels are audited; got ${rows === null ? "no ledger at all" : `${rows.length} row(s)`}`,
  );
  check(
    "pair24-env-row-NAMES-the-channel",
    rows?.[0]?.channel === "env",
    `an audit row that cannot say WHICH channel is a weaker record; got ${JSON.stringify(rows?.[0]?.channel)}`,
  );
  check(
    "pair24-env-row-carries-NO-land_first",
    rows?.[0]?.land_first === null,
    "the env row is AUDIT-ONLY: arming a debt here would dead-end CI, which cannot write a promise into an env var",
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 25 — AN ENV ROW MUST NOT PAY OFF A RECEIPT'S DEBT (H1, s96 regression).
//
// Found by an adversarial security review of this session's own diff, CONFIRMED
// by execution. `unpaidOverrideDebt` reads ONLY `rows[rows.length - 1]`. Before
// the M4-env change the env channel wrote NO row, so the last row stayed the
// receipt's and the debt stood. Making the env channel audited — correct in
// itself — appended a row carrying `land_first: null` BY CONSTRUCTION, and the
// last-row read then treats that as "no debt".
//
// Net effect of the regression: write a receipt naming `land-first: X`, take one
// env override, and the debt on X is gone. The MUST-7 property the debt exists to
// create — that the cheapest way to keep overriding is the same as the cheapest
// way to stop needing to — was payable with an env var.
//
// The fix SKIPS env-channel rows when locating the outstanding promise. It
// deliberately does NOT change how a RECEIPT row with no `land-first:` token
// behaves: that is a separate, pre-existing question (a receipt can still clear
// its own debt by omitting the token) and it is an operator-workflow decision,
// not this regression's to settle.
// ═══════════════════════════════════════════════════════════════════════════
{
  const debtRepo = buildRepo({
    lanes: Array.from({ length: WIP_LIMIT }, (_, i) => ({
      name: `feat/debt-lane-${i + 1}`,
      ageHours: 3 + i,
    })),
  });
  const debtPayload = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git switch -c feat/debt-next" },
    cwd: debtRepo.work,
  };

  // 1. A receipt naming a lane arms the debt.
  writeReceipt(debtRepo.work, "need one more lane\nland-first: feat/debt-lane-1");
  const armed = runGuard(debtPayload);
  check(
    "pair25-receipt-with-land-first-is-honoured",
    armed.blocked === false,
    `the receipt must be honoured to arm a debt; got ${JSON.stringify(armed.json)}`,
  );

  // CONTROL: the debt is REALLY armed — a second receipt must now be REFUSED,
  // because `feat/debt-lane-1` is still open. Without this the rows below would
  // pass against a guard that never arms a debt at all.
  writeReceipt(debtRepo.work, "second override\nland-first: feat/debt-lane-2");
  const refused = runGuard(debtPayload);
  check(
    "pair25-control-second-receipt-REFUSED-while-promise-open",
    refused.blocked === true && /land|debt|promised/i.test(refused.advisory || ""),
    `the debt must be armed, else pair25 proves nothing; got ${JSON.stringify(refused.json)}`,
  );

  // 2. THE ASSERTION. An env override appends an audit-only row. It must NOT pay
  //    the debt off: a receipt after it must STILL be refused.
  runGuard(debtPayload, { COC_ALLOW_WIP_OVERRUN: "1" });
  writeReceipt(debtRepo.work, "third override\nland-first: feat/debt-lane-3");
  const afterEnv = runGuard(debtPayload);
  check(
    "pair25-env-row-does-NOT-clear-the-receipt-debt",
    afterEnv.blocked === true,
    "an env override paid off a promise it never made: the debt is settleable with an env var (H1)",
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 26 — NAMING A LANE IS PART OF THE PRICE (M2, operator-ratified s96).
//
// `recordOverride` extracted `land-first:` by REGEX from operator free text, and
// a receipt omitting the token recorded `land_first: null`, which made
// `unpaidOverrideDebt` return null. So the MUST-7 debt priced only whoever
// VOLUNTEERED a promise: the cheapest way to override forever was to write one
// line less. A guard whose bypass is cheaper than its remediation is a suggestion,
// which is the exact sentence the debt mechanism was built on.
//
// The receipt now REFUSES without the token, and the refusal does NOT consume it —
// same discipline as the debt refusal above, which tells the operator their
// receipt is intact. Refusing while eating the receipt would destroy the very
// thing the message says is still available.
//
// This is a real workflow change, not a silent tightening: it refuses receipts
// that were previously honoured. Escape is one line, and the refusal names it, so
// it is not the dead-end `hook-output-discipline.md` MUST NOT forbids.
// ═══════════════════════════════════════════════════════════════════════════
{
  const priceRepo = buildRepo({
    lanes: Array.from({ length: WIP_LIMIT }, (_, i) => ({
      name: `feat/price-lane-${i + 1}`,
      ageHours: 3 + i,
    })),
  });
  const pricePayload = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git switch -c feat/price-next" },
    cwd: priceRepo.work,
  };

  // CONTROL: with no receipt at all this repo BLOCKS, so the rows below are not
  // passing against a guard that refuses everything for an unrelated reason.
  check(
    "pair26-control-blocks-without-any-receipt",
    runGuard(pricePayload).blocked === true,
    "the ceiling must be the thing refusing here",
  );

  // A receipt with a REASON but NO `land-first:` token — previously honoured.
  writeReceipt(priceRepo.work, "need one more lane for the s96 fix, approved");
  const noToken = runGuard(pricePayload);
  check(
    "pair26-receipt-without-land-first-is-REFUSED",
    noToken.blocked === true,
    `a receipt naming no lane must not buy an override; got ${JSON.stringify(noToken.json)}`,
  );
  check(
    "pair26-refusal-NAMES-the-one-line-remedy",
    /land-first:/i.test(noToken.advisory || ""),
    "a refusal whose remedy is one line MUST state that line, or it is a dead end",
  );
  check(
    "pair26-refusal-does-NOT-consume-the-receipt",
    receiptExists(priceRepo.work),
    "refusing while eating the receipt destroys what the message says is still available",
  );

  // The SAME receipt, plus the token — honoured.
  writeReceipt(
    priceRepo.work,
    "need one more lane for the s96 fix, approved\nland-first: feat/price-lane-1",
  );
  const withToken = runGuard(pricePayload);
  check(
    "pair26-receipt-WITH-land-first-is-honoured",
    withToken.blocked === false,
    `the token is the whole price; with it the override stands; got ${JSON.stringify(withToken.json)}`,
  );
  check(
    "pair26-honoured-receipt-IS-consumed",
    receiptExists(priceRepo.work) === false,
    "one-shot still holds on the honoured path",
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 27 — THE PRICE IS PAID AT EVERY DOOR, AND IT IS A REAL LANE (s96 HIGH-1/2).
//
// Both found by adversarial review OF the M2 commit, both confirmed by execution
// before the fix.
//
// HIGH-1: the price gate sat at ONE of FOUR receipt-consumption sites. On the
// landed-remote-ref path `spendRemoteHold()` consumed and recorded with no check,
// writing `{channel:"receipt", land_first:null}` — and `unpaidOverrideDebt` reads
// the LAST non-env row, so that row ERASED an armed promise. Byte-for-byte the
// regression PAIR 25 pins for the env channel, re-opened through the receipt
// channel by a gate guarding one door of four.
//
// HIGH-2: the gate checked the token's FORM, never that the lane EXISTS.
// `laneStillOpen` fails open on an unknown ref, so `land-first: no-such-lane`
// satisfied the price and armed ZERO debt — permanently. And the refusal message
// printed the literal `land-first: <ref>`, which matches `[^\s,;]+` and names no
// open lane, so an agent pasting the message VERBATIM defeated the gate. Measured:
// the regex captures "<ref>" and `laneStillOpen("<ref>")` is false. The refusal was
// teaching the bypass.
// ═══════════════════════════════════════════════════════════════════════════
{
  const priceRepo2 = buildRepo({
    lanes: Array.from({ length: WIP_LIMIT }, (_, i) => ({
      name: `feat/p27-lane-${i + 1}`,
      ageHours: 3 + i,
    })),
  });
  const p27 = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git switch -c feat/p27-next" },
    cwd: priceRepo2.work,
  };

  check(
    "pair27-control-blocks-with-no-receipt",
    runGuard(p27).blocked === true,
    "the ceiling must be what refuses here, or the rows below prove nothing",
  );

  // HIGH-2 (a): the placeholder the OLD refusal told agents to paste.
  writeReceipt(priceRepo2.work, "approved\nland-first: <ref>");
  check(
    "pair27-placeholder-ref-is-REFUSED",
    runGuard(p27).blocked === true,
    "an agent pasting the refusal message verbatim must not defeat the gate",
  );

  // HIGH-2 (b): a syntactically fine ref that names no open lane.
  writeReceipt(priceRepo2.work, "approved\nland-first: no-such-lane");
  const ghost = runGuard(p27);
  check(
    "pair27-nonexistent-lane-is-REFUSED",
    ghost.blocked === true,
    "a ref naming no open lane arms no debt, so it must not buy an override",
  );
  // Assert SOME real lane is offered, not a specific one: `laneSurvey` orders by age,
  // so which three appear is an ordering detail, while "a name that actually exists"
  // is the property. Asserting lane-1 specifically would fail on an ordering change
  // that breaks nothing — and would NOT fail if the remedy went back to `<ref>`.
  const namedReal = /feat\/p27-lane-[1-5]/.test(ghost.advisory || "");
  check(
    "pair27-refusal-names-a-REAL-open-lane",
    namedReal && !/land-first: <ref>/.test(ghost.advisory || ""),
    `the remedy must name a lane that EXISTS and must not print the placeholder that defeats the gate; advisory=${JSON.stringify((ghost.advisory || "").slice(0, 400))}`,
  );
  check(
    "pair27-nonexistent-refusal-does-NOT-consume",
    receiptExists(priceRepo2.work),
    "a refusal must not eat the receipt it tells the operator is still there",
  );

  // A REAL open lane is honoured — the price is payable, not merely a refusal.
  writeReceipt(priceRepo2.work, "approved\nland-first: feat/p27-lane-1");
  check(
    "pair27-real-open-lane-IS-honoured",
    runGuard(p27).blocked === false,
    "the gate must be satisfiable, or it is a dead end rather than a price",
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// PAIR 28 — DEMOTE IS NOT SUPPRESS: A PROTECTED LANDED REMOTE REF LEAVES THE
// DOOR'S COUNT AND STAYS VISIBLE IN THE REPORT (loom s103).
//
// `wip-lanes.js::landedRemoteRefs` partitions its landed set in `sortInto`: a
// name matching `isProtectedName` (prefixes `preserve/ backup/ salvage/ wip/`,
// plus the NEVER_REAP set) goes to `protectedFound`, everything else to `found`.
// Only `found` reaches `count`/`names`, which is what the third door blocks on.
//
// BOTH HALVES ARE THE CONTRACT, and each is a defect on its own:
//   DEMOTE — counting a protected ref toward the block threshold is an
//     UNCLEARABLE DEADLOCK: `remote-ref-reap.mjs` refuses these by design, so
//     the operator is told to run a remedy that cannot move the number.
//   NEVER SUPPRESS — dropping it from the candidate set instead hides
//     MAGNITUDE. That is the defect this repo already diagnosed once, in
//     `variants/rs/hooks/lib/unlanded-shards.js` ("a branch literally prefixed
//     `wip/` was exempt from the WIP surface"), and forbids in
//     `unlanded-work-surface.js` ("COUNT IS NEVER SUPPRESSED").
//
// MEASURED GAP THIS PAIR CLOSES: the partition was removed and this suite ran
// 277 pass / 0 fail under BOTH poles while the live door's verdict genuinely
// flipped — so the corpus was blind to the behaviour it was shipped to pin.
//
// WHY BOTH POLES ARE LOAD-BEARING. The RED pole is the anti-vacuity control: a
// door that has been disabled outright stays silent on BOTH refs, so the GREEN
// rows alone would pass against a guard that does nothing. The GREEN rows are
// the anti-suppression control: a partition COLLAPSED into `found` blocks the
// protected ref (green-blocks reds), and a partition that DROPS it reports
// `protectedCount` 0 (green-still-reported reds). No single mutation reds only
// one of the three.
//
// THE REPO SHAPE IS SQUASH-LANDED, not ancestry-landed, and that is asserted
// rather than assumed below: `landContent` cherry-picks the lane onto main, so
// the pushed ref carries a patch-id already at the base while remaining a
// NON-ancestor — the exact population the 2026-09-10 correction moved this door
// onto, and the one an `--merged` test cannot see. The two poles are otherwise
// byte-identical builds; they differ in the landed ref's NAME and nothing else.
// ═══════════════════════════════════════════════════════════════════════════
{
  const L28 = require(LIB);

  // ONE builder, called twice: any difference between the poles other than the
  // name would make the comparison a different experiment.
  const landedRepo = (laneName) =>
    buildRepo({
      lanes: [{ name: laneName, ageHours: 2, push: true }],
      withRemote: true,
      landContent: true,
    });
  // A lane-creating Bash call is what consults the third door (`remoteDoor:true`
  // is set on the Bash arm only — a WORKER is not inventory). The lane it opens
  // is UNPROTECTED in both poles, so the command itself never varies.
  const openLane = (repo) => ({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git switch -c feat/p28-next" },
    cwd: repo.work,
  });
  const ancestryRefs = (repo) =>
    git(repo.work, [
      "for-each-ref",
      "--merged",
      "origin/main",
      "refs/remotes/origin/",
      "--format=%(refname)",
    ]).stdout;

  // ── RED POLE — an ORDINARY squash-landed remote ref ──────────────────────
  const p28red = landedRepo("feat/p28-landed");
  const redScan = L28.landedRemoteRefs({ repoDir: p28red.work, budgetMs: 20000 });

  // SHAPE CONTROL. Without this the pair could be measuring ancestry-landedness,
  // which the protection partition also handles but which is NOT the population
  // this door was moved onto. `--merged` must NOT list the ref, and the content
  // scan must.
  check(
    "pair28-control-red-ref-is-landed-by-CONTENT-not-ancestry",
    !/refs\/remotes\/origin\/feat\/p28-landed$/m.test(ancestryRefs(p28red)) &&
      redScan.ok === true &&
      redScan.names.includes("feat/p28-landed"),
    `the fixture must build a SQUASH-landed (patch-id-present, non-ancestor) ref or it tests the wrong population; ancestry=${JSON.stringify(ancestryRefs(p28red))} scan=${JSON.stringify(redScan)}`,
  );
  check(
    "pair28-control-red-ref-is-NOT-protected",
    redScan.count === 1 && redScan.protectedCount === 0,
    `the red pole's ref must land in \`found\`, not \`protectedFound\`; got ${JSON.stringify(redScan)}`,
  );

  const redGuard = runGuard(openLane(p28red));
  check(
    "pair28-RED-ordinary-landed-remote-ref-BLOCKS-lane-creation",
    redGuard.blocked === true && /remote ref/i.test(redGuard.advisory || ""),
    `the third door must refuse creation while an un-reaped landed ref stands; got ${JSON.stringify(redGuard.json)}`,
  );
  // MUST-2 of `instrument-bipolarity.md`: the RED pole declares the failure
  // IDENTITY — the clause and the ref — not merely that something fired.
  check(
    "pair28-RED-refusal-declares-MUST-4-and-names-the-ref",
    /wip-discipline\/MUST-4/.test(redGuard.advisory || "") &&
      /feat\/p28-landed/.test(redGuard.advisory || ""),
    `a refusal that names neither the clause nor the ref is not an identity; advisory=${JSON.stringify((redGuard.advisory || "").slice(0, 600))}`,
  );

  // ── GREEN POLE — the SAME build, a PROTECTED name ────────────────────────
  const p28green = landedRepo("preserve/p28-landed");
  const greenScan = L28.landedRemoteRefs({ repoDir: p28green.work, budgetMs: 20000 });

  const greenGuard = runGuard(openLane(p28green));
  check(
    "pair28-GREEN-protected-landed-ref-does-NOT-block-lane-creation",
    greenGuard.blocked === false,
    `the reaper refuses protected refs by design, so a door keyed on them can never clear — this is the deadlock the demotion exists to prevent; got ${JSON.stringify(greenGuard.json)}`,
  );
  check(
    "pair28-GREEN-protected-ref-is-EXCLUDED-from-the-door-count",
    greenScan.ok === true && greenScan.count === 0 && greenScan.names.length === 0,
    `\`count\`/\`names\` are what the door blocks on and must not carry a protected ref; got ${JSON.stringify(greenScan)}`,
  );
  check(
    "pair28-GREEN-protected-ref-is-STILL-REPORTED-in-protectedNames",
    greenScan.protectedCount === 1 &&
      greenScan.protectedNames.includes("preserve/p28-landed"),
    `DEMOTED, NEVER SUPPRESSED — a demoted ref that vanishes from the report hides magnitude, the \`unlanded-shards.js\` defect; got ${JSON.stringify(greenScan)}`,
  );
  check(
    "pair28-GREEN-protected-ref-still-counts-as-a-CANDIDATE",
    greenScan.candidates === redScan.candidates && greenScan.candidates === 1,
    `the DENOMINATOR is the population the door could have looked at; demotion must not shrink it (red=${redScan.candidates}, green=${greenScan.candidates})`,
  );

  // MUST-1: the two poles must produce DIFFERENT verdicts. Asserted on the
  // BLOCK, not on `fired`, because a silent-but-advisory pole and a blocking one
  // are the distinction the door is for.
  polesDiffer(
    "pair28-poles-differ-on-the-landed-remote-ref-DOOR",
    redGuard.blocked,
    greenGuard.blocked,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 29 — LANE DEPTH (journal/0607 decision 3; wip-discipline MUST-9).
//
// A lane is a mini-orchestrator; the ledger must say how deep each lane is so an
// UNDER-PACKED one is visible. Items bind with a `lane: <branch>` frontmatter key
// (`todo-durable.js::parseLaneBinding`); `wip-lanes.js::laneDepth` joins them to
// `laneSurvey`'s open lanes. REAL git + REAL files — the join key is a branch name
// git reports, and one of them carries a `/`.
//
// The two poles are ONE builder called twice and differ ONLY in whether `q1` — an
// item bound to a lane that is not open — exists. RED: `codify/p29-under` carries
// one item while q1 is QUEUED ⇒ UNDER-PACKED. GREEN: nothing queued ⇒ not named.
// Every RED row asserts WHICH lane / WHICH item, and that the PACKED lane is not
// named — a verdict that named every lane would pass a count-only check.
// ═══════════════════════════════════════════════════════════════════════════
{
  const LD = require(LIB);
  // The CONSUMER of the attribution keys, loaded so the pin below compares two
  // live declarations rather than one declaration and a restated literal.
  const DD29 = require(path.resolve(HERE, "../../hooks/lib/delegation-default.js"));
  const T29 = "workspaces/ws/todos";
  const writeTodo = (work, rel, body) => {
    const abs = path.join(work, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };
  const fm = (lane) => `---\ntitle: fixture item\nlane: ${lane}\n---\n# item\n`;
  const depthRepo = ({ withQueued }) => {
    const r = buildRepo({
      lanes: [
        { name: "feat/p29-packed", ageHours: 2 },
        { name: "codify/p29-under", ageHours: 3 },
      ],
    });
    writeTodo(r.work, `${T29}/active/p1.md`, fm("feat/p29-packed"));
    writeTodo(r.work, `${T29}/active/p2.md`, fm("feat/p29-packed"));
    writeTodo(r.work, `${T29}/active/u1.md`, fm("codify/p29-under"));
    // A LANDED LANE, BUILT NOT ASSERTED: a ref at main's tip has no unique
    // commit, so `laneSurvey` drops it from the open set while the REF still
    // exists — the exact shape that separates ORPHANED from QUEUED.
    git(r.work, ["branch", "feat/p29-landed", "main"]);
    writeTodo(r.work, `${T29}/active/o1.md`, fm("feat/p29-landed"));
    if (withQueued) writeTodo(r.work, `${T29}/active/q1.md`, fm("feat/p29-not-open"));
    writeTodo(r.work, `${T29}/active/nb.md`, "# no frontmatter, so no lane\n");
    writeTodo(r.work, `${T29}/active/bad.md`, "---\nlane: feat/p29-packed\nlane: codify/p29-under\n---\n");
    // Bound to the under-packed lane but COMPLETED: carries no depth.
    writeTodo(r.work, `${T29}/completed/done.md`, fm("codify/p29-under"));
    git(r.work, ["add", "-A"]);
    git(r.work, ["commit", "-qm", "todos"], { date: stampHoursAgo(1) });
    return r;
  };
  const red = depthRepo({ withQueued: true });
  const green = depthRepo({ withQueued: false });
  // THE AGENT AXIS IS MEASURED, so the poles below read a lane's depth rather
  // than its item count alone. Rows carry `branch`, one of the four keys
  // `LANE_ATTRIBUTION_KEYS` declares and `attributeLaunchesToLanes` joins on.
  const launch = (branch, n) => ({
    kind: "launch",
    session_id: "p29",
    launch_id: `p29-${branch}-${n}`,
    branch,
  });
  const LEDGER = [
    launch("feat/p29-packed", 1),
    launch("feat/p29-packed", 2),
    launch("codify/p29-under", 1),
  ];
  const depthOf = (repo, rows) =>
    LD.laneDepth({ repoDir: repo.work, sessionId: "p29", ledgerRows: rows });
  const rd = depthOf(red, LEDGER);
  const gd = depthOf(green, LEDGER);
  const row = (d, lane) => (d.lanes || []).find((l) => l.lane === lane) || {};
  const ids = (xs) => JSON.stringify((xs || []).map((x) => x.id));

  check(
    "pair29-control-both-lanes-are-open-in-laneSurvey",
    JSON.stringify(
      LD.laneSurvey({ repoDir: red.work, census: false, depth: false })
        .lanes.map((l) => l.name)
        .sort(),
    ) === JSON.stringify(["codify/p29-under", "feat/p29-packed"]),
    "the join target must exist, or every depth row below measures nothing",
  );
  check(
    "pair29-RED-UNDER-PACKED-names-exactly-the-one-item-lane-and-its-slashed-name-round-trips",
    rd.ok === true &&
      JSON.stringify(rd.underPacked) === JSON.stringify(["codify/p29-under"]) &&
      JSON.stringify(row(rd, "codify/p29-under").items) === JSON.stringify(["ws/u1"]),
    `got ${JSON.stringify(rd).slice(0, 700)}`,
  );
  check(
    "pair29-RED-packed-lane-is-PACKED-and-NOT-named-under-packed",
    row(rd, "feat/p29-packed").verdict === "PACKED" &&
      JSON.stringify(row(rd, "feat/p29-packed").items) === JSON.stringify(["ws/p1", "ws/p2"]) &&
      !(rd.underPacked || []).includes("feat/p29-packed"),
    `got ${JSON.stringify(row(rd, "feat/p29-packed"))}`,
  );
  check(
    "pair29-RED-QUEUED-names-the-item-and-its-unopened-lane",
    (rd.queued || []).length === 1 &&
      rd.queued[0].id === "ws/q1" &&
      rd.queued[0].lane === "feat/p29-not-open",
    `got ${JSON.stringify(rd.queued)}`,
  );
  check(
    "pair29-RED-UNBOUND-names-the-item-and-no-lane-counts-it",
    ids(rd.unbound) === JSON.stringify(["ws/nb"]) &&
      rd.counts.bound === 3 &&
      !(rd.lanes || []).some((l) => l.items.includes("ws/nb")),
    `got unbound=${ids(rd.unbound)} counts=${JSON.stringify(rd.counts)}`,
  );
  check(
    "pair29-RED-malformed-binding-is-UNKNOWN-never-UNBOUND-or-bound",
    (rd.unknown || []).some(
      (u) => u.class === "binding-malformed" && u.items.length === 1 && u.items[0].id === "ws/bad",
    ) &&
      !ids(rd.unbound).includes("ws/bad") &&
      !(rd.lanes || []).some((l) => l.items.includes("ws/bad")),
    `got unknown=${JSON.stringify(rd.unknown)}`,
  );
  check(
    "pair29-RED-completed-item-carries-no-depth",
    row(rd, "codify/p29-under").itemCount === 1,
    `ws/done is bound to codify/p29-under but completed; got ${JSON.stringify(row(rd, "codify/p29-under"))}`,
  );
  // ── THE AGENT JOIN ────────────────────────────────────────────────────────
  //
  // REPAIRED, not deleted. This row used to assert `agents === null` for every
  // lane against a reason quoting `buildLaunchRecord`'s key list — a claim that
  // the PRODUCER writes no location key. `dispatch-ledger.js` now writes `cwd`,
  // `worktree` and `branch` on every launch row, so that assertion was made
  // stale BY DESIGN: it would have kept passing on the reason string alone while
  // the join it described became possible. What is pinned now is the join's
  // TRI-STATE — a MEASURED count where rows attribute, `null` where they do not,
  // and never a fabricated zero.
  check(
    "pair29-agents-are-MEASURED-per-lane-from-the-joined-location-keys",
    row(rd, "feat/p29-packed").agents === 2 &&
      row(rd, "codify/p29-under").agents === 1 &&
      /2 launch row\(s\) this session name this lane/.test(
        row(rd, "feat/p29-packed").agentsReason,
      ),
    `the join must COUNT the rows, not report them unattributed; got ${JSON.stringify(rd.lanes)}`,
  );
  {
    // NO LEDGER AT ALL — the fixture repo has no dispatch sink, so the read
    // FAILS and every lane is UNATTRIBUTED. `null`, never 0: a fabricated zero
    // would make a 2-item lane look serial and flip its verdict.
    const noLedger = LD.laneDepth({ repoDir: red.work, sessionId: "p29" });
    check(
      "pair29-agents-are-NULL-with-a-read-derived-reason-never-zero",
      (noLedger.lanes || []).length === 2 &&
        noLedger.lanes.every(
          (l) => l.agents === null && /UNATTRIBUTED, not zero/.test(l.agentsReason),
        ) &&
        (noLedger.unknown || []).some((u) => u.class === "agents-per-lane" && u.count === null),
      `got ${JSON.stringify(noLedger.lanes)}`,
    );
    check(
      "pair29-an-UNATTRIBUTED-multi-item-lane-is-UNDETERMINED-never-PACKED",
      row(noLedger, "feat/p29-packed").verdict === "UNDETERMINED" &&
        row(rd, "feat/p29-packed").verdict === "PACKED",
      `the SAME two items read PACKED only once the agent count is MEASURED at 2; got unattributed=${row(noLedger, "feat/p29-packed").verdict} attributed=${row(rd, "feat/p29-packed").verdict}`,
    );
    polesDiffer(
      "pair29-attributed-and-unattributed-poles-differ-on-the-multi-item-verdict",
      row(rd, "feat/p29-packed").verdict,
      row(noLedger, "feat/p29-packed").verdict,
    );
  }
  {
    // ONE SERIAL AGENT ON A MULTI-ITEM LANE. The item set is IDENTICAL to `rd`'s
    // and only the agent count moves, so a check reading items alone cannot tell
    // these apart — which is exactly how a 4-item serial lane read PACKED.
    const serial = depthOf(red, [launch("feat/p29-packed", 1), launch("codify/p29-under", 1)]);
    check(
      "pair29-a-multi-item-lane-worked-by-ONE-agent-is-UNDER-PACKED-not-PACKED",
      row(serial, "feat/p29-packed").agents === 1 &&
        row(serial, "feat/p29-packed").verdict === "UNDER-PACKED" &&
        (serial.underPacked || []).includes("feat/p29-packed"),
      `got ${JSON.stringify(row(serial, "feat/p29-packed"))}`,
    );
    polesDiffer(
      "pair29-poles-differ-on-the-agent-axis-alone",
      row(rd, "feat/p29-packed").verdict,
      row(serial, "feat/p29-packed").verdict,
    );
  }
  check(
    "pair29-LANE_ATTRIBUTION_KEYS-is-EXPORTED-and-equals-its-consumers-union",
    Array.isArray(LD.LANE_ATTRIBUTION_KEYS) &&
      JSON.stringify([...LD.LANE_ATTRIBUTION_KEYS].sort()) ===
        JSON.stringify([...DD29.LANE_NAME_KEYS, ...DD29.LANE_PATH_KEYS].sort()),
    `declared-but-unexported, the pin could only be written against a restated literal; got ${JSON.stringify(LD.LANE_ATTRIBUTION_KEYS)} vs ${JSON.stringify([...DD29.LANE_NAME_KEYS, ...DD29.LANE_PATH_KEYS])}`,
  );

  check(
    "pair29-LANE_PATH_KEYS_LOCAL-is-EXPORTED-and-equals-the-consumers-path-keys",
    Array.isArray(LD.LANE_PATH_KEYS_LOCAL) &&
      JSON.stringify([...LD.LANE_PATH_KEYS_LOCAL].sort()) ===
        JSON.stringify([...DD29.LANE_PATH_KEYS].sort()),
    `the map is BUILT against these keys and JOINED against those; a key added to one and not the other would be written by the ledger and silently never mapped; got ${JSON.stringify(LD.LANE_PATH_KEYS_LOCAL)} vs ${JSON.stringify(DD29.LANE_PATH_KEYS)}`,
  );

  // ── THE PATH→LANE JOIN ────────────────────────────────────────────────────
  //
  // `dispatch-ledger.js` writes `cwd` / `worktree` on every launch row, and the join reaches them
  // ONLY through a `worktreeLanes` map. `laneDepth` accepted the parameter and never built one, so
  // a path-key row was unidentified at BOTH lane-depth sites and every lane read UNMEASURED. Every
  // pole below asserts an IDENTITY — WHICH lane a path resolved to — never a count.
  {
    const pj = depthRepo({ withQueued: true });
    const wtUnder = path.join(pj.root, "wt-under");
    git(pj.work, ["worktree", "add", "-q", wtUnder, "codify/p29-under"]);
    const subdir = path.join(wtUnder, "workspaces", "ws");
    mkdirSync(subdir, { recursive: true });
    const outside = mkdtempSync(path.join(tmpdir(), "wip-disc-outside-"));
    cleanup.push(outside);

    const roots = LD._worktreeLaneRoots(pj.work);
    const rootFor = (b) => (roots.ok ? roots.roots.filter((r) => r.branch === b).map((r) => r.real) : []);
    check(
      "pathjoin-ROOTS-name-the-lane-worktree-by-its-REAL-path",
      roots.ok === true &&
        rootFor("codify/p29-under").length === 1 &&
        rootFor("codify/p29-under")[0] === realpathSync(wtUnder),
      `the worktree listing must answer WHICH branch lives at WHICH resolved path; got ${JSON.stringify(roots)}`,
    );

    const mapOf = (rows) => LD._pathLaneMapForRows(rows, roots.ok ? roots.roots : []);
    const prow = (k, v) => ({ kind: "launch", session_id: "pj", launch_id: `pj-${k}-${v}`, [k]: v });

    check(
      "pathjoin-a-row-naming-the-lane-WORKTREE-attributes-to-THAT-lane",
      mapOf([prow("worktree", wtUnder)])[wtUnder] === "codify/p29-under",
      `identity, not presence: the map must name codify/p29-under; got ${JSON.stringify(mapOf([prow("worktree", wtUnder)]))}`,
    );
    check(
      "pathjoin-a-cwd-INSIDE-the-lane-worktree-attributes-to-that-lane",
      mapOf([prow("cwd", subdir)])[subdir] === "codify/p29-under",
      `a dispatch issued from a SUBDIRECTORY of a lane worktree ran in that lane; got ${JSON.stringify(mapOf([prow("cwd", subdir)]))}`,
    );
    // THE SYMLINKED PREFIX. On macOS `os.tmpdir()` is itself under a symlinked prefix, so the
    // listed path and its real path differ; this pole drives an EXPLICIT symlink so the case holds
    // on a platform where they do not. Resolving only ONE side would miss it.
    const linked = path.join(pj.root, "wt-under-link");
    let linkOk = true;
    try {
      symlinkSync(wtUnder, linked);
    } catch {
      linkOk = false;
    }
    check(
      "pathjoin-a-SYMLINKED-prefix-still-attributes-to-the-same-lane",
      !linkOk || mapOf([prow("cwd", path.join(linked, "workspaces"))])[path.join(linked, "workspaces")] === "codify/p29-under",
      `both sides are resolved, so an aliased path is the SAME worktree; got ${JSON.stringify(mapOf([prow("cwd", path.join(linked, "workspaces"))]))}`,
    );
    check(
      "pathjoin-a-path-OUTSIDE-every-worktree-stays-UNATTRIBUTED",
      mapOf([prow("cwd", outside)])[outside] === undefined &&
        Object.keys(mapOf([prow("cwd", outside)])).length === 0,
      `containment must not over-match — an unrelated real directory is no lane; got ${JSON.stringify(mapOf([prow("cwd", outside)]))}`,
    );
    check(
      "pathjoin-an-UNRESOLVABLE-path-is-dropped-so-its-row-reads-UNMEASURED-never-zero",
      Object.keys(mapOf([prow("cwd", path.join(wtUnder, "no-such-dir-ever"))])).length === 0,
      "a worktree removed since the dispatch cannot be joined; the row must stay unidentified",
    );

    // END-TO-END, THROUGH `laneDepth` — the two poles differ ONLY in whether the path resolves
    // inside the lane worktree. RED (outside) UNMEASURED; GREEN (inside) a MEASURED 1.
    const depthWith = (p) =>
      LD.laneDepth({
        repoDir: pj.work,
        sessionId: "pj",
        ledgerRows: [{ ...prow("cwd", p), session_id: "pj" }],
      });
    const inLane = depthWith(subdir);
    const outLane = depthWith(outside);
    const agentsOf = (d, lane) => (d.ok ? (d.lanes.find((l) => l.lane === lane) || {}).agents : "not-ok");
    check(
      "pathjoin-E2E-laneDepth-BUILDS-the-map-a-cwd-inside-the-lane-is-a-MEASURED-1",
      agentsOf(inLane, "codify/p29-under") === 1,
      `laneDepth must build the map itself — neither caller passes one; got ${JSON.stringify(agentsOf(inLane, "codify/p29-under"))} reason=${inLane.reason || ""}`,
    );
    check(
      "pathjoin-E2E-a-path-outside-every-lane-reads-UNMEASURED-with-a-reason-never-0",
      agentsOf(outLane, "codify/p29-under") === null &&
        /UNMEASURED — not zero/.test(
          (outLane.ok && (outLane.lanes.find((l) => l.lane === "codify/p29-under") || {}).agentsReason) || "",
        ),
      `an unjoinable dispatch is UNMEASURED, never a measured zero; got ${JSON.stringify(outLane.lanes && outLane.lanes.find((l) => l.lane === "codify/p29-under"))}`,
    );
    polesDiffer(
      "pathjoin-E2E-poles-differ-on-the-path-join-alone",
      agentsOf(inLane, "codify/p29-under"),
      agentsOf(outLane, "codify/p29-under"),
    );

    // THE MAP-BUILD FAILURE POLE. A repository git cannot list yields a NAMED unmeasured, never
    // a silent zero — the third state this whole module exists to keep distinct.
    const broken = LD._worktreeLaneRoots(path.join(tmpdir(), "wip-disc-no-such-repo-ever"));
    check(
      "pathjoin-an-UNBUILDABLE-map-is-a-typed-failure-carrying-a-REASON",
      broken.ok === false && typeof broken.reason === "string" && broken.reason.length > 0,
      `a failure to build the map must be reported, never returned as an empty map; got ${JSON.stringify(broken)}`,
    );
  }

  // ── ORPHANED vs QUEUED ────────────────────────────────────────────────────
  check(
    "pair29-RED-ORPHANED-names-the-landed-lanes-item-and-QUEUED-does-NOT-hold-it",
    (rd.orphaned || []).length === 1 &&
      rd.orphaned[0].id === "ws/o1" &&
      rd.orphaned[0].lane === "feat/p29-landed" &&
      !(rd.queued || []).some((q) => q.id === "ws/o1") &&
      rd.counts.orphaned === 1,
    `an item bound to a LANDED lane is stale bookkeeping, not work a lane can absorb; got orphaned=${JSON.stringify(rd.orphaned)} queued=${JSON.stringify(rd.queued)}`,
  );
  check(
    "pair29-GREEN-an-ORPHANED-item-ALONE-drives-NO-UNDER-PACKED-lane",
    gd.ok === true &&
      (gd.orphaned || []).length === 1 &&
      gd.underPacked.length === 0 &&
      row(gd, "codify/p29-under").verdict !== "UNDER-PACKED",
    `before the split this landed lane's leftover item marked every serial lane UNDER-PACKED; got underPacked=${JSON.stringify(gd.underPacked)} orphaned=${JSON.stringify(gd.orphaned)}`,
  );
  {
    // THE REF ENUMERATION ITSELF FAILING IS A THIRD STATE: neither QUEUED nor
    // ORPHANED, and it drives nothing.
    const blind = LD.laneDepth({
      repoDir: red.work,
      sessionId: "p29",
      ledgerRows: LEDGER,
      listRefNames: () => null,
    });
    check(
      "pair29-an-UNREADABLE-ref-set-is-UNMEASURED-never-QUEUED-and-never-ORPHANED",
      blind.ok === true &&
        blind.queued.length === 0 &&
        blind.orphaned.length === 0 &&
        blind.underPacked.length === 0 &&
        (blind.unknown || []).some(
          (u) => u.class === "lane-existence-unmeasured" && u.count === 2,
        ),
      `got queued=${JSON.stringify(blind.queued)} orphaned=${JSON.stringify(blind.orphaned)} unknown=${JSON.stringify(blind.unknown)}`,
    );
  }
  check(
    "pair29-GREEN-no-queue-names-no-UNDER-PACKED-lane",
    gd.ok === true &&
      gd.underPacked.length === 0 &&
      row(gd, "codify/p29-under").verdict === "UNDETERMINED" &&
      row(gd, "feat/p29-packed").verdict === "PACKED",
    `got ${JSON.stringify(gd.lanes)}`,
  );
  polesDiffer(
    "pair29-poles-differ-on-UNDER-PACKED",
    (rd.underPacked || []).join(","),
    (gd.underPacked || []).join(","),
  );
  {
    // OPT-IN: the default call must not pay the extra spawn (the pinned budget).
    const s = LD.laneSurvey({ repoDir: red.work, census: false, depth: true });
    const s0 = LD.laneSurvey({ repoDir: red.work, census: false });
    check(
      "pair29-laneSurvey-reports-per-lane-depth-and-NULL-when-not-asked",
      s.ok === true &&
        s.depth &&
        JSON.stringify(s.depth.underPacked) === JSON.stringify(["codify/p29-under"]) &&
        s0.depth === null,
      `got depth=${JSON.stringify(s.depth && s.depth.underPacked)} notAsked=${JSON.stringify(s0.depth)}`,
    );
  }
  {
    const unreadable = LD.laneDepth({ repoDir: red.work, listTodoFiles: () => null });
    check(
      "pair29-an-unanswerable-ledger-is-ok-false-never-an-empty-report",
      unreadable.ok === false && unreadable.reason === "todo-listing-failed" && !("underPacked" in unreadable),
      `got ${JSON.stringify(unreadable)}`,
    );
    polesDiffer("pair29-unanswerable-poles-differ", unreadable.ok, rd.ok);
  }

  // ── END TO END: the SHIPPED guard at SessionStart ─────────────────────────
  const rg = runGuard({ hook_event_name: "SessionStart", cwd: red.work });
  const gg = runGuard({ hook_event_name: "SessionStart", cwd: green.work });
  const underLine = (g) => /UNDER-PACKED codify\/p29-under/.test(g.advisory || "");
  check(
    "pair29-sessionStart-delivers-the-lane-contract-citing-MUST-9",
    [rg, gg].every(
      (g) =>
        (g.advisory || "").includes("wip-discipline/MUST-9") &&
        (g.advisory || "").includes("MINI-ORCHESTRATOR") &&
        (g.advisory || "").includes("NEVER AGENTS"),
    ),
    `got ${JSON.stringify((gg.advisory || "").slice(0, 400))}`,
  );
  check(
    "pair29-sessionStart-RED-names-the-UNDER-PACKED-lane-the-QUEUED-and-the-UNBOUND-item",
    underLine(rg) &&
      /QUEUED \(1\)[^\n]*ws\/q1 -> feat\/p29-not-open/.test(rg.advisory || "") &&
      /UNBOUND \(1\)[^\n]*ws\/nb/.test(rg.advisory || ""),
    `got ${JSON.stringify(rg.advisory)}`,
  );
  check(
    "pair29-sessionStart-RED-renders-the-multi-item-lane-UNDETERMINED-never-UNDER-PACKED",
    // The SHIPPED guard reads the real per-session dispatch sink, and this
    // hermetic repo has none — so the agent axis is UNATTRIBUTED here and the
    // 2-item lane is UNDETERMINED, not PACKED. It is the ATTRIBUTED pole above
    // (`pair29-agents-are-MEASURED-…`) that earns PACKED; asserting PACKED here
    // would have been reading an unmeasured axis as a measured one.
    /UNDETERMINED feat\/p29-packed — 2 item\(s\)/.test(rg.advisory || "") &&
      /agents UNATTRIBUTED/.test(rg.advisory || "") &&
      !/UNDER-PACKED feat\/p29-packed/.test(rg.advisory || "") &&
      !/UNDER-PACKED:[^\n]*feat\/p29-packed/.test(rg.advisory || ""),
    `got ${JSON.stringify(rg.advisory)}`,
  );
  check(
    "pair29-sessionStart-RED-names-the-ORPHANED-item-and-does-NOT-count-it-QUEUED",
    /ORPHANED \(1\)[^\n]*ws\/o1 -> feat\/p29-landed/.test(rg.advisory || "") &&
      !/QUEUED \(1\)[^\n]*ws\/o1/.test(rg.advisory || ""),
    `got ${JSON.stringify(rg.advisory)}`,
  );
  check(
    "pair29-sessionStart-is-ADVISORY-and-never-blocks",
    rg.status === 0 &&
      rg.json &&
      rg.json.continue === true &&
      rg.blocked === false &&
      (rg.advisory || "").startsWith("ADVISORY") &&
      !ageFinding(rg),
    `got status=${rg.status} json=${JSON.stringify(rg.json).slice(0, 300)}`,
  );
  check(
    "pair29-sessionStart-GREEN-names-no-UNDER-PACKED-lane",
    !underLine(gg) && /UNDETERMINED codify\/p29-under/.test(gg.advisory || ""),
    `got ${JSON.stringify(gg.advisory)}`,
  );
  polesDiffer("pair29-sessionStart-poles-differ", underLine(rg), underLine(gg));

  // ── THE TIMEOUT POLE ──────────────────────────────────────────────────────
  //
  // The three contract lines are CONSTANTS and cost no git spawn, so an overrun
  // is no reason to drop them; only the DEPTH half is unmeasured. The branch is
  // otherwise unreachable from a fixture: `resolveGitBinary` prefers absolute
  // candidates over `PATH`, so no shim can make git hang, and the process-level
  // timer cannot fire once the synchronous decision starts (measured: bounds of
  // 300 / 900 / 1500 ms each ran 4–5 s to a FULL report).
  //
  // DRIVEN BY A FORCED-CONDITION SEAM, NOT BY A TINY BUDGET, and the change is
  // the point of this comment. This pole used to pass `COC_WIP_GUARD_TIMEOUT_MS:
  // "1"`, which the guard CLAMPS to a 50 ms floor — so the assertion was really
  // "the lane survey takes longer than 50 ms on this host". That is a claim
  // about the machine, which `testing.md` § "Never Assert An UPPER Bound On Real
  // Elapsed Time" blocks by name.
  //
  // It was not theoretical: the pole passed on darwin and FAILED in CI, whose
  // fresh shallow checkout has almost nothing to enumerate and finished inside
  // the floor, delivering the FULL report. Same code, same fixture, opposite
  // verdict, decided by host speed alone. `COC_WIP_GUARD_FORCE_DEPTH_TIMEOUT`
  // reaches the branch deterministically on any host.
  const tg = runGuard(
    { hook_event_name: "SessionStart", cwd: red.work },
    { COC_WIP_GUARD_FORCE_DEPTH_TIMEOUT: "1" },
  );
  const timedOut = (g) => /LANE DEPTH UNKNOWN — timed out/.test(g.advisory || "");
  const contract = (g) =>
    (g.advisory || "").includes("MINI-ORCHESTRATOR") &&
    (g.advisory || "").includes("PACK BEFORE OPENING") &&
    (g.advisory || "").includes("NEVER AGENTS");
  check(
    "pair29-timeout-RED-still-delivers-all-three-contract-lines",
    contract(tg) && timedOut(tg),
    `a timeout must cost the DEPTH report and nothing else; got ${JSON.stringify((tg.advisory || "").slice(0, 500))}`,
  );
  check(
    "pair29-timeout-RED-is-UNKNOWN-not-a-silent-clean-and-never-blocks",
    tg.status === 0 &&
      tg.json &&
      tg.json.continue === true &&
      tg.blocked === false &&
      // NAMES no lane. The standing `agent_must_wait` sentence carries the words
      // "lanes named UNDER-PACKED" on every pole, so the discriminating test is
      // whether a LANE NAME follows the verdict — not whether the token appears.
      !/UNDER-PACKED (codify|feat)\//.test(tg.advisory || "") &&
      !/UNDER-PACKED:/.test(tg.advisory || "") &&
      !/LANE DEPTH — /.test(tg.advisory || ""),
    `got status=${tg.status} advisory=${JSON.stringify((tg.advisory || "").slice(0, 400))}`,
  );
  check(
    "pair29-timeout-GREEN-same-repo-inside-the-bound-reports-the-DEPTH",
    contract(rg) && !timedOut(rg) && /LANE DEPTH — /.test(rg.advisory || "") && underLine(rg),
    `the two poles run the SAME repo and differ only in the bound; got ${JSON.stringify((rg.advisory || "").slice(0, 400))}`,
  );
  polesDiffer("pair29-timeout-poles-differ-on-the-depth-half", timedOut(tg), timedOut(rg));
  polesDiffer(
    "pair29-timeout-poles-do-NOT-differ-on-the-contract-half",
    contract(tg) && contract(rg) ? "both-carry-the-contract" : "one-dropped-it",
    "one-dropped-it",
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PAIR 30 — THE VERDICT ON THE AGENT AXIS (pure). Pair 29 drives the join end to
// end; this exercises the predicate directly at its three states: ONE attributed
// agent with queued work is a serial worker, TWO is genuinely parallel, and an
// UNATTRIBUTED count is neither — never read as zero, and never read as PACKED.
// ═══════════════════════════════════════════════════════════════════════════
{
  const { laneDepthVerdict: V } = require(LIB);
  const oneAgent = V({ itemCount: 3, agents: 1, queuedCount: 2 }).verdict;
  const twoAgents = V({ itemCount: 3, agents: 2, queuedCount: 2 }).verdict;
  const nullAgents = V({ itemCount: 3, agents: null, queuedCount: 2 }).verdict;
  check("pair30-one-attributed-agent-with-queued-work-is-UNDER-PACKED", oneAgent === "UNDER-PACKED", `got ${oneAgent}`);
  check("pair30-two-attributed-agents-same-items-is-PACKED", twoAgents === "PACKED", `got ${twoAgents}`);
  // REPAIRED: this row asserted PACKED, which read an UNMEASURED axis as a
  // measured parallel one — the same item set worked by one serial agent and by
  // three was scored identically. UNDETERMINED is the third state.
  check(
    "pair30-UNATTRIBUTED-agents-are-read-as-neither-zero-nor-parallel",
    nullAgents === "UNDETERMINED" && nullAgents !== twoAgents && nullAgents !== oneAgent,
    `got ${nullAgents}`,
  );
  polesDiffer("pair30-agent-axis-poles-differ", oneAgent, twoAgents);
  const clean = V({ itemCount: 1, queuedCount: 0, unmeasuredCount: 0 }).verdict;
  const unmeasured = V({ itemCount: 1, queuedCount: 0, unmeasuredCount: 2 }).verdict;
  check(
    "pair30-nothing-unmeasured-is-NOTHING-QUEUED-something-unmeasured-is-UNDETERMINED",
    clean === "NOTHING-QUEUED" && unmeasured === "UNDETERMINED",
    `got ${clean} / ${unmeasured}`,
  );
  polesDiffer("pair30-unmeasured-poles-differ", clean, unmeasured);
}

// ──────────────────────────────────────────────────────────── PAIR 31
// laneDepth SCOPES ITS POPULATION TO LIVE WORKSPACES — and DECLARES the narrowing.
//
// This census answers "what outstanding work needs a lane?". A `workspaces/_archive/`
// workspace has been CLOSED, and the archival convention deliberately leaves its
// ledger un-reconciled — items stay in `todos/active/` after the move. Before this
// scoping the session-start report read "20 UNBOUND outstanding items" and, MEASURED,
// 0 of the 20 were outstanding loom work.
//
// The pair's load-bearing property is NOT that the count fell. A census that reports
// zero because it stopped looking is worse than the noise it replaced. So the RED pole
// asserts the archived item is excluded AND the live item beside it is STILL COUNTED
// AND the exclusion is declared as a number — three facts that a "just filter it out"
// implementation gets only two of.
{
  const LD = require(LIB);
  const HEADS = {
    "workspaces/live/todos/active/nb.md": "# no frontmatter\n",
    "workspaces/live/todos/active/bd.md": "---\nlane: feat/p31\n---\n\n# bound\n",
    "workspaces/_archive/dead/todos/active/arch.md": "# no frontmatter\n",
    "workspaces/_template/todos/active/tpl.md": "# no frontmatter\n",
    "workspaces/live/todos/done/dn.md": "# closed via done/\n",
  };
  const depth = (files) =>
    LD.laneDepth({
      repoDir: HERE,
      openLanes: ["feat/p31"],
      listTodoFiles: () => files,
      readTodoHead: (rel) => {
        if (!(rel in HEADS)) throw new Error(`no fixture head for ${rel}`);
        return HEADS[rel];
      },
      listRefNames: () => new Set(["feat/p31"]),
      ledgerRows: [],
    });

  const all = depth(Object.keys(HEADS));
  const liveOnly = depth(["workspaces/live/todos/active/nb.md"]);
  const archOnly = depth(["workspaces/_archive/dead/todos/active/arch.md"]);

  check(
    "pair31-control-the-census-reads-the-injected-list-at-all",
    all.ok === true && liveOnly.ok === true && archOnly.ok === true,
    `every pole must return ok; got ${JSON.stringify({ a: all.reason, l: liveOnly.reason, r: archOnly.reason })}`,
  );
  check(
    "pair31-RED-an-archived-unbound-item-is-EXCLUDED-not-counted-UNBOUND",
    archOnly.counts.unbound === 0 && archOnly.counts.excludedMetaWorkspace === 1,
    `got ${JSON.stringify(archOnly.counts)}`,
  );
  check(
    "pair31-GREEN-a-LIVE-unbound-item-IS-counted-and-NAMED",
    liveOnly.counts.unbound === 1 &&
      liveOnly.unbound[0].id === "live/nb" &&
      liveOnly.counts.excludedMetaWorkspace === 0,
    `the narrowing must not silence live work; got ${JSON.stringify({ c: liveOnly.counts, u: liveOnly.unbound })}`,
  );
  polesDiffer(
    "pair31-exclusion-poles-differ",
    `${archOnly.counts.unbound}:${archOnly.counts.excludedMetaWorkspace}`,
    `${liveOnly.counts.unbound}:${liveOnly.counts.excludedMetaWorkspace}`,
  );
  check(
    "pair31-MIXED-the-exclusion-does-NOT-mask-the-live-item-beside-it",
    all.counts.unbound === 1 &&
      all.unbound[0].id === "live/nb" &&
      all.counts.bound === 1 &&
      all.counts.excludedMetaWorkspace === 2,
    `_archive AND _template must both be set aside while live/nb still reports; got ${JSON.stringify({ c: all.counts, u: all.unbound.map((u) => u.id) })}`,
  );
  check(
    "pair31-the-narrowing-is-DECLARED-in-basis-never-silent",
    typeof all.basis.items === "string" &&
      /META-directory/.test(all.basis.items) &&
      all.basis.items.includes("2"),
    `basis.items must name the blind class and its size; got ${JSON.stringify(all.basis.items)}`,
  );
  check(
    "pair31-a-done-item-is-CLOSED-not-outstanding-and-not-lifecycle-undeclared",
    all.counts.unbound === 1 &&
      !(all.unknown || []).some((u) => u.class === "lifecycle-undeclared"),
    `todos/done/ must read closed; got ${JSON.stringify(all.unknown)}`,
  );
}

// ──────────────────────────────────────────────────────────── PAIR 32
// THE NARROWING IS RENDERED, not merely RETURNED.
//
// PAIR 31 established that `laneDepth` sets meta-workspace items aside and carries
// the size of what it withheld in `counts.excludedMetaWorkspace`. That reached a
// reader of the OBJECT and no reader of the REPORT: the shipped guard rendered
// "0 UNBOUND" identically whether nothing was outstanding or a whole class had been
// narrowed away. MEASURED on this repository while the gap was open, the session
// start report read "0 UNBOUND" with 92 tracked items under `workspaces/_archive/`
// and no rendered trace of the exclusion — the absence-reads-as-clean shape
// `conservation-gate.md` MUST-3 names, one layer above the lib that already fixed it.
//
// The poles are ONE builder called twice and differ ONLY in whether an archived
// todo exists. RED asserts the number AND the class name reach BOTH rendered
// surfaces carrying the UNBOUND figure — the `LANE DEPTH` headline inside
// `agent_must_report`, and the one-line `what_happened` summary, which a reader
// may see on its own. GREEN asserts SILENCE: an exclusion that did not happen is
// not a blind spot, and a disclosure emitted every session is one the reader
// learns to skip. Asserting only the RED pole would pass an unconditional line.
{
  const T32 = "workspaces/live/todos";
  const A32 = "workspaces/_archive/dead/todos";
  const exclRepo = ({ withArchived }) => {
    const r = buildRepo({ lanes: [{ name: "feat/p32", ageHours: 2 }] });
    const put = (rel, body) => {
      const abs = path.join(r.work, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    };
    // A LIVE item on the open lane, present in BOTH poles: it is what proves the
    // census ran at all, so GREEN's silence is a measured zero and not a dead report.
    put(`${T32}/active/live1.md`, "---\ntitle: fixture item\nlane: feat/p32\n---\n# item\n");
    // The archived item carries NO lane binding, so before the scoping landed it
    // would have read UNBOUND. It must now be neither counted NOR silent.
    if (withArchived) put(`${A32}/active/arch1.md`, "# no frontmatter, so no lane\n");
    git(r.work, ["add", "-A"]);
    git(r.work, ["commit", "-qm", "todos"], { date: stampHoursAgo(1) });
    return r;
  };
  const redX = runGuard({
    hook_event_name: "SessionStart",
    cwd: exclRepo({ withArchived: true }).work,
  });
  const greenX = runGuard({
    hook_event_name: "SessionStart",
    cwd: exclRepo({ withArchived: false }).work,
  });
  const headline = (g) => ((g.advisory || "").match(/^.*LANE DEPTH — .*$/m) || [""])[0];
  const summary = (g) => ((g.advisory || "").match(/^.*Lane depth: .*$/m) || [""])[0];

  check(
    "pair32-control-both-poles-render-a-LANE-DEPTH-report-at-all",
    /LANE DEPTH — /.test(headline(redX)) &&
      /LANE DEPTH — /.test(headline(greenX)) &&
      /Lane depth: /.test(summary(redX)) &&
      /Lane depth: /.test(summary(greenX)) &&
      !/LANE DEPTH UNKNOWN/.test(redX.advisory || "") &&
      !/LANE DEPTH UNKNOWN/.test(greenX.advisory || ""),
    `neither pole may be UNKNOWN or timed out; got red=${JSON.stringify(headline(redX))} green=${JSON.stringify(headline(greenX))}`,
  );
  check(
    "pair32-control-the-live-item-IS-counted-in-BOTH-poles",
    // Without this the pair could pass on a census that read nothing at all.
    /LANE DEPTH — 1 open lane\(s\), 1 bound item\(s\)/.test(headline(redX)) &&
      /LANE DEPTH — 1 open lane\(s\), 1 bound item\(s\)/.test(headline(greenX)),
    `got red=${JSON.stringify(headline(redX))} green=${JSON.stringify(headline(greenX))}`,
  );
  check(
    "pair32-RED-the-LANE-DEPTH-headline-names-the-excluded-COUNT-and-the-CLASS",
    /0 UNBOUND, EXCLUDED 1 item\(s\) under a workspace META-directory/.test(
      headline(redX),
    ) && /`_archive`, `_template`, `_draft`/.test(headline(redX)),
    `the count alone is an alarm, not a disclosure — the class must be named beside it; got ${JSON.stringify(headline(redX))}`,
  );
  check(
    "pair32-RED-the-what_happened-summary-carries-it-too-never-only-the-report",
    /0 UNBOUND item\(s\), EXCLUDED 1 item\(s\) under a workspace META-directory/.test(
      summary(redX),
    ) && /counted in NO class here/.test(summary(redX)),
    `a reader seeing only the summary line must not miss the narrowing; got ${JSON.stringify(summary(redX))}`,
  );
  check(
    "pair32-RED-the-excluded-item-is-still-NOT-counted-UNBOUND",
    // DISCLOSURE, not reclassification: the fix renders the narrowing and must
    // leave every count `laneDepth` returns exactly as it was.
    /0 UNBOUND, EXCLUDED/.test(headline(redX)) &&
      !/UNBOUND \(1\)/.test(redX.advisory || ""),
    `got ${JSON.stringify(redX.advisory)}`,
  );
  check(
    "pair32-GREEN-nothing-excluded-emits-NO-exclusion-line-anywhere",
    !/EXCLUDED/.test(greenX.advisory || "") &&
      !/META-directory/.test(greenX.advisory || "") &&
      /0 UNBOUND:/.test(headline(greenX)) &&
      /0 UNBOUND item\(s\)\./.test(summary(greenX)),
    `a zero exclusion must leave the line untouched; got ${JSON.stringify(headline(greenX))} / ${JSON.stringify(summary(greenX))}`,
  );
  check(
    "pair32-both-poles-stay-ADVISORY-and-never-block",
    // The disclosure changes rendered TEXT only — no verdict, no severity, no threshold.
    [redX, greenX].every(
      (g) => g.status === 0 && g.json && g.json.continue === true,
    ),
    `got red=${JSON.stringify(redX.json)} green=${JSON.stringify(greenX.json)}`,
  );
  polesDiffer(
    "pair32-exclusion-disclosure-poles-differ",
    /EXCLUDED/.test(redX.advisory || ""),
    /EXCLUDED/.test(greenX.advisory || ""),
  );
}

console.log(`wip-discipline fixtures: ${pass} pass, ${fail} fail`);
if (fail) {
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
process.exit(0);
