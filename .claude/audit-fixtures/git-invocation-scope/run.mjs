#!/usr/bin/env node
/**
 * git-invocation-scope — the regression lock for the git-verb SCOPE defect in
 * `parseGitInvocation` (loom#1594).
 *
 * WHAT IS UNDER TEST. One field: the `unresolvable` mark returned by
 * `hooks/lib/git-command-parse.js::parseGitInvocation`. That field is not
 * decoration — `"subcommand"` is a member of `UNRESOLVABLE_COMMAND_IDENTITY`,
 * the set every fail-closed lane ranks TIGHTEST, so a segment carrying it is
 * refused a clear verdict and the operator is handed a halt-and-report. This
 * suite pins WHICH segments may carry it.
 *
 * THE DEFECT, AS MEASURED BEFORE THE FIX. `parseGitInvocation` returned
 * `unresolvable: "subcommand"` for segments containing NO git token at all.
 * Measured verbatim through the probe, pre-fix:
 *
 *   subcommand | NO-GIT-TOKEN | sub=$(date)   | $(which foo) --bar $(date)
 *   subcommand | NO-GIT-TOKEN | sub=$(date)   | "$PWD/x.js" $(date)
 *   subcommand | NO-GIT-TOKEN | sub=$(cat f)  | "$PWD/.claude/hooks/auto-format.js" $(cat f)
 *   subcommand | NO-GIT-TOKEN | sub=$(echo y) | command -v "$1" $(echo y)
 *   subcommand | NO-GIT-TOKEN | sub=$(cat s)  | $(echo node) -e $(cat s)
 *
 * Each produced a LIVE halt-and-report reading "Bash invoked git with a
 * subcommand this hook cannot resolve" on a command that never mentions git.
 * The class is not hypothetical and not rare: the very act of running this
 * suite's own hook probe (`command node <script> "$PWD/..." "$PWD"`) tripped it.
 *
 * THE ROOT CAUSE. `gitFound` records whether a literal/fused git token was
 * actually seen. Two return sites decided the mark WITHOUT consulting it — the
 * `i >= toks.length` branch (gated only on `sawUnexpandable`) and the final
 * precedence ladder (`toks[i].unexpandable ? "subcommand" : …`). When no git
 * token was found, the function only got past its early `return null` because
 * the COMMAND NAME itself was opaque; the word sitting in the "subcommand slot"
 * is then just the second word of an UNKNOWN command, and calling it a hidden
 * git VERB asserts evidence that does not exist. The file already states the
 * correct disposition for exactly this state at its `UNRESOLVABLE_COMMAND_
 * IDENTITY` declaration — `"command"`, which is deliberately NOT a member of
 * that set, and whose comment names `command -v "$1"` as an instance.
 *
 * HOW IT DISCRIMINATES — BIPOLAR, PER ARM. A suite that only proved the guard
 * went quiet would have proved the guard was DISABLED, so the firing poles are
 * the load-bearing half:
 *   - SILENT poles assert the mark's exact VALUE (`"command"` / `"dir"` /
 *     `null`), never merely "did not throw" and never merely "not subcommand" —
 *     a parser returning garbage would satisfy the weaker form.
 *   - FIRING poles assert `"subcommand"` SURVIVES for every shape where git IS
 *     implicated: literal, path-qualified, backslash-escaped, the fused
 *     `git$IFS` form, and the no-subcommand-token branch.
 *   - The firing poles test membership through the EXPORTED
 *     `UNRESOLVABLE_COMMAND_IDENTITY` set rather than a local literal, per
 *     security.md § Enforcement-Surface Parity: a future edit that removed
 *     `"subcommand"` from the set would red here instead of silently
 *     disarming every consumer.
 *   - ARM 5 drives the real hook end-to-end, because the parse-level mark is
 *     the mechanism and the rendered halt-and-report is the HARM.
 *
 * ANTI-VACUITY. The exported set is asserted to actually contain "subcommand"
 * before any firing pole is read (instrument-discipline.md MUST-3(a)): if that
 * membership were ever dropped, every firing assertion below would pass for the
 * wrong reason.
 *
 * NOTHING IS EXECUTED. Every case is a pure parse, except ARM 5 which drives
 * the hook as a DECISION FUNCTION over stdin — the candidate command string is
 * delivered as data and never run.
 *
 * Each arm names the mutation that reds it; see README.md for the measured
 * mutation run.
 */
import "../_lib/no-ambient-git.cjs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const LIB = path.join(REPO_ROOT, ".claude", "hooks", "lib", "git-command-parse.js");
const HOOK = path.join(REPO_ROOT, ".claude", "hooks", "validate-bash-command.js");

const { parseGitInvocation, UNRESOLVABLE_COMMAND_IDENTITY } = require_(LIB);

let pass = 0;
const failures = [];
function check(id, fn) {
  let verdict;
  try {
    verdict = fn();
  } catch (e) {
    verdict = `threw: ${e && e.message}`;
  }
  // Per-case lines are the AGGREGATE runner's unit of account:
  // `run-audit-fixtures.mjs` counts by matching `^\s*(PASS|ok)\s+\S` and
  // `^\s*(FAIL|not ok)\s+\S`, NOT by reading the summary below.
  if (verdict === true) {
    pass += 1;
    console.log(`PASS ${id}`);
  } else {
    failures.push(`${id} (${verdict})`);
    console.log(`FAIL ${id}`);
    console.log(`     ${verdict}`);
  }
}

const markOf = (seg) => {
  const g = parseGitInvocation(seg);
  return g ? g.unresolvable : "NO-INVOCATION";
};

// ============================================================ PRECONDITION
// If "subcommand" is not in the shared set, every FIRING pole below would pass
// while asserting nothing about fail-closed behaviour.
check("PRE/subcommand-is-a-fail-closed-member", () =>
  UNRESOLVABLE_COMMAND_IDENTITY.has("subcommand") ||
  `UNRESOLVABLE_COMMAND_IDENTITY does not contain "subcommand" — every firing ` +
    `pole in this suite is vacuous. Got ${JSON.stringify([...UNRESOLVABLE_COMMAND_IDENTITY])}`,
);
// The other half of the boundary: the mark the SILENT poles assert must NOT be
// a fail-closed member, or "silent" would not mean silent.
check("PRE/command-is-not-a-fail-closed-member", () =>
  !UNRESOLVABLE_COMMAND_IDENTITY.has("command") ||
  `"command" is a fail-closed member — the silent poles below assert a mark ` +
    `that still halts, so they do not test what they claim`,
);

// ===================================================== ARM 1: SILENT poles
// The five MEASURED defect segments, plus three of the same class the file's
// own UNRESOLVABLE_COMMAND_IDENTITY comment names (array append, `$VAR`-headed
// line, `command -v` probe). Git is NOWHERE in any of them.
//
// Each row is [id, seg, expected] and `expected` is compared EXACTLY — the row
// MUST still fail if it ever returns "subcommand" (the fail-closed mark this
// arm exists to forbid), which is mutation-proved in the commit that added the
// third element. The one row whose exact value CHANGED, and why it is not
// drift smoothed over: 0fb6e7f78 (the loom#1594 regression lock) made these
// rows return "command" — "a mark no consumer fences on" (README, § One
// recorded behaviour change); the codex redesign's rounds-4/5 semantics then
// made an unexpandable word AFTER the grammar-resolved command word sit in
// ARGUMENT position, inert, so `command node /tmp/x.mjs "$PWD/…" "$PWD"`
// (SILENT/self-referential-probe) returns NO-INVOCATION — a value the README's
// own bipolarity section already lists among the exact values a SILENT pole
// may assert. The pinned PROPERTY (this shape must never carry the fail-closed
// mark; it must never halt-and-report) is unchanged on every reader revision.
//
// Mutation that reds this arm: restore either skipped `gitFound` consult — drop
// the `commandSlotUnresolved` early return in the `i >= toks.length` branch, or
// drop the `&& !commandSlotUnresolved` conjunct from the precedence ladder.
// Each reds a DIFFERENT subset, which is why both are named.
for (const [id, seg, expected] of [
  ["which-foo", "$(which foo) --bar $(date)", "command"],
  ["pwd-script", '"$PWD/x.js" $(date)', "command"],
  ["auto-format", '"$PWD/.claude/hooks/auto-format.js" $(cat f)', "command"],
  ["command-v", 'command -v "$1" $(echo y)', "command"],
  ["echo-node", "$(echo node) -e $(cat s)", "command"],
  ["python-module", "$PYTHON -m pytest $(cat args)", "command"],
  ["array-append", 'files+=("$f") $(echo x)', "command"],
  // The suite's own hook probe. This exact shape produced a live
  // halt-and-report while the defect was present.
  ["self-referential-probe", 'command node /tmp/x.mjs "$PWD/.claude/hooks/v.js" "$PWD"', "NO-INVOCATION"],
]) {
  check(`SILENT/${id}`, () => {
    const got = markOf(seg);
    // Assert the VALUE. "not subcommand" alone would be satisfied by a parser
    // returning undefined, null, or any garbage.
    return (
      got === expected ||
      `expected mark ${JSON.stringify(expected)} (no git token is present anywhere in this ` +
        `segment), got ${JSON.stringify(got)} for: ${seg}`
    );
  });
}

// ------------------------------------- ARM 1b: the site-A discriminator
// THE CASES THAT MAKE ARM 1 NON-VACUOUS FOR THE FIRST OF THE TWO FIXED SITES.
//
// Measured, and the reason this block exists: mutating the `i >= toks.length`
// site ALONE left the whole suite GREEN at 34/34 even though the mutation was
// PROVEN to reach the code (a stderr marker fired on four inputs). Every case
// above routes through the precedence LADDER instead, because each still has a
// token left in the verb slot — so ARM 1 as first written covered site B twice
// and site A not at all. An empty red-set is not a vacuity verdict
// (instrument-discipline.md MUST-5(b)); resolving it is what surfaced this gap.
//
// The shape that reaches site A needs ALL THREE: no git token, an opaque
// COMMAND NAME, and an opaque construct consumed by the `-C`/`--work-tree`
// option loop so that NO subcommand token remains. Measured under the mutation,
// each of these read "subcommand"; under the fix each reads "command".
//
// Mutation that reds this arm: re-gate the `i >= toks.length` command return on
// `!sawUnexpandable` (i.e. `if (commandSlotUnresolved && !sawUnexpandable)`).
// Its PAIRED firing pole is FIRING/no-verb-token-left below — the identical
// branch reached with a real git token, which must keep marking "subcommand".
for (const [id, seg] of [
  ["opaque-name-opaque-C", "$(which foo) -C $(echo /tmp)"],
  ["var-name-opaque-C", '"$TOOL" -C $(echo /tmp)'],
  ["var-name-opaque-work-tree", "$PYTHON --work-tree $(echo /tmp)"],
]) {
  check(`SILENT/siteA/${id}`, () => {
    const got = markOf(seg);
    return (
      got === "command" ||
      `no git token is present and no verb token remains, so the mark may not ` +
        `claim a hidden git VERB; got ${JSON.stringify(got)} for: ${seg}`
    );
  });
}

// A git-less segment whose opaque word sits in a `-C` VALUE, not the verb slot.
// The ladder must still reach "dir" — dropping the subcommand leg must not
// collapse the rest of the ladder into a single answer.
check("SILENT/gitless-opaque-dir-still-reports-dir", () => {
  const got = markOf('"$TOOL" -C $(echo /tmp) run');
  return (
    got === "dir" ||
    `expected "dir" — the ladder below the removed leg must stay intact; got ${JSON.stringify(got)}`
  );
});

// Plain non-git commands with NO opaque command slot stay a non-invocation.
// This is the pole that reds if a fix over-reached and started manufacturing
// invocations for ordinary commands.
for (const [id, seg] of [
  ["echo", "echo hi"],
  ["ls", "ls -la"],
  ["node-test", "node --test x.js"],
]) {
  check(`SILENT/no-invocation-${id}`, () => {
    const got = markOf(seg);
    return (
      got === "NO-INVOCATION" ||
      `a plain non-git command must not parse as a git invocation at all; got ${JSON.stringify(got)} for: ${seg}`
    );
  });
}

// ===================================================== ARM 2: FIRING poles
// THE LOAD-BEARING HALF. Every shape where git IS implicated and the verb is
// hidden must still carry a fail-closed mark. A fix that silenced these would
// have disabled the fence rather than scoped it.
//
// Mutation that reds this arm: widen the fix — e.g. make the ladder's
// `"subcommand"` leg unconditional-false, or make `gitFound` always false.
for (const [id, seg] of [
  // literal git, verb behind a substitution
  ["literal-hidden-verb", "git $(echo status) --porcelain"],
  // backslash-escaped git (alias-bypass form)
  ["backslashed", "\\git $(cat verb)"],
  // path-qualified git, both spellings
  ["absolute-path", "/usr/bin/git $(echo log)"],
  ["relative-path", "./git $(echo diff)"],
  // FUSED token: `git$IFS clean` and `git${IFS}commit` word-split identically
  // but only one ever shows the verb as its own token, so both are refused.
  ["fused-ifs-separated", "git$IFS clean"],
  ["fused-ifs-joined", "git${IFS}commit"],
  // verb AND dir both opaque — the verb outranks the dir
  ["hidden-verb-and-dir", "git -C $(echo /tmp) $(echo reset)"],
  // the `i >= toks.length` branch: git found, an opaque construct consumed on
  // the way, NO subcommand token left. This is the branch the fix edited, so
  // its git-bearing pole is the one most at risk of over-silencing.
  ["no-verb-token-left", "git -C $(echo /tmp)"],
]) {
  check(`FIRING/${id}`, () => {
    const got = markOf(seg);
    if (got !== "subcommand") {
      return (
        `expected "subcommand" — git IS implicated here and the verb is hidden, ` +
        `so the fail-closed lane must refuse it; got ${JSON.stringify(got)} for: ${seg}`
      );
    }
    // Membership, not spelling (security.md § Enforcement-Surface Parity).
    return (
      UNRESOLVABLE_COMMAND_IDENTITY.has(got) ||
      `mark ${JSON.stringify(got)} is not in UNRESOLVABLE_COMMAND_IDENTITY, so no consumer fails closed on it`
    );
  });
}

// ============================================ ARM 3: the "command" boundary
// `$(echo git) commit` is the loom#1589 case: the command name is opaque but
// the VERB is visible, so the parser reports the verb ALONGSIDE a `"command"`
// mark and a consumer can fence on the precise verb. Not regressing this is an
// explicit requirement of the fix.
//
// Mutation that reds this arm: make the ladder return `"command"` without also
// populating `sub`, or route the opaque-command-name case back to `null`.
check("BOUNDARY/opaque-name-visible-verb-reports-the-verb", () => {
  const g = parseGitInvocation("$(echo git) commit");
  if (!g) return "expected an invocation, got null — this is the loom#1589 fail-OPEN path";
  if (g.unresolvable !== "command")
    return `expected mark "command", got ${JSON.stringify(g.unresolvable)}`;
  return (
    g.sub === "commit" ||
    `the visible verb must be reported so a fence can act on it precisely; got sub=${JSON.stringify(g.sub)}`
  );
});

// CONSISTENCY CASE, and a deliberate behaviour change this suite RECORDS rather
// than hides. Pre-fix, `$(echo git) commit` marked "command" while
// `$(echo git) $(echo commit)` marked "subcommand" — the same opaque command
// name answered two different ways depending only on whether the verb happened
// to be literal. Post-fix both are "command". This does NOT widen the accepted
// residual: `"command"` is already, by the ratified boundary at this file's
// UNRESOLVABLE_COMMAND_IDENTITY declaration, a mark no consumer fences on, and
// the literal-verb spelling has carried it since loom#1589.
check("BOUNDARY/opaque-name-opaque-verb-is-command-not-subcommand", () => {
  const got = markOf("$(echo git) $(echo commit)");
  return (
    got === "command" ||
    `an opaque command NAME is answered the same way whether or not the verb ` +
      `is also opaque; got ${JSON.stringify(got)}`
  );
});

// ================================================ ARM 4: untouched regressions
// Marks the fix must leave exactly as they were. These reds if the ladder was
// rewritten rather than having one leg narrowed.
for (const [id, seg, wantMark, wantSub] of [
  // loom#1549 F3 lock 9 — the empty `-C ""` is git's documented no-op, so the
  // verb is `reset`, NOT the directory, and nothing is unresolvable.
  ["empty-C-noop", 'git -C "" reset --hard HEAD', null, "reset"],
  ["plain-status", "git status", null, "status"],
  // The 1905-vs-19 decision: an ARG-slot substitution needs no mark at all.
  ["arg-slot-substitution", "git log $(git merge-base a b)", null, "log"],
  ["quoted-flag-lookalike", 'git commit -m "fix --dry-run"', null, "commit"],
  // Only the dir is unknown; the verb is fully known.
  ["worktree-attached-opaque", "git --work-tree=$(echo /tmp) clean", "dir", "clean"],
]) {
  check(`REGRESS/${id}`, () => {
    const g = parseGitInvocation(seg);
    if (!g) return `expected an invocation, got null for: ${seg}`;
    if (g.unresolvable !== wantMark)
      return `expected mark ${JSON.stringify(wantMark)}, got ${JSON.stringify(g.unresolvable)} for: ${seg}`;
    return (
      g.sub === wantSub ||
      `expected sub ${JSON.stringify(wantSub)}, got ${JSON.stringify(g.sub)} for: ${seg}`
    );
  });
}

// A bare `git` names no verb and is not an invocation to act on.
for (const [id, seg] of [
  ["bare-git", "git"],
  ["git-global-flag-only", "git --paginate"],
]) {
  check(`REGRESS/${id}-is-not-an-invocation`, () => {
    const got = markOf(seg);
    return (
      got === "NO-INVOCATION" ||
      `expected no invocation for a verbless git; got ${JSON.stringify(got)}`
    );
  });
}

// ================================================= ARM 5: END-TO-END (harm)
// The parse-level mark is the MECHANISM; the rendered halt-and-report is the
// HARM. This arm drives the real hook so the suite cannot go green on a parser
// that is right while the operator still gets the wrong message.
//
// Deliberately only THREE hook invocations, and none of them on a segment whose
// lane calls the working-tree status helper: that helper spawns `git status`
// under a hard time budget and flaps under machine load, which would make this
// arm non-deterministic for a reason unrelated to the behaviour under test.
//
// Mutation that reds this arm: the same two mutations as ARM 1/ARM 2 — it reads
// the same predicate through the consumer instead of directly.
const HALT_TEXT = "invoked git with a subcommand this hook cannot resolve";

function runHook(command) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      tool_name: "Bash",
      tool_input: { command },
      cwd: REPO_ROOT,
    }),
    encoding: "utf8",
    timeout: 30000,
  });
  let text = "";
  try {
    const j = JSON.parse((r.stdout || "").trim().split("\n").pop() || "{}");
    text =
      (j.hookSpecificOutput && j.hookSpecificOutput.permissionDecisionReason) ||
      (j.hookSpecificOutput && j.hookSpecificOutput.additionalContext) ||
      "";
  } catch {
    text = "PARSE-FAIL:" + (r.stdout || "");
  }
  return { exit: r.status, text, timedOut: r.error != null };
}

check("E2E/FIRING/hidden-git-verb-still-halts", () => {
  const res = runHook("git $(echo status) --porcelain");
  if (res.timedOut) return "hook did not return — result INDETERMINATE, not clean";
  return (
    res.text.includes(HALT_TEXT) ||
    `the fail-closed lane must still speak for a hidden git verb; got ${JSON.stringify(res.text.slice(0, 200))}`
  );
});

check("E2E/FIRING/fused-git-token-still-halts", () => {
  const res = runHook("git$IFS clean");
  if (res.timedOut) return "hook did not return — result INDETERMINATE, not clean";
  return (
    res.text.includes(HALT_TEXT) ||
    `the fused git token is positive evidence of git and must still halt; got ${JSON.stringify(res.text.slice(0, 200))}`
  );
});

check("E2E/SILENT/gitless-command-does-not-claim-git", () => {
  const res = runHook('command -v "$1" $(echo y)');
  if (res.timedOut) return "hook did not return — result INDETERMINATE, not clean";
  return (
    !res.text.includes(HALT_TEXT) ||
    `the hook told the operator git was invoked by a command that never ` +
      `mentions git: ${JSON.stringify(res.text.slice(0, 300))}`
  );
});

const total = pass + failures.length;
console.log(`\ngit-invocation-scope: ${pass}/${total} PASS`);
if (failures.length > 0) {
  console.log(`FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
