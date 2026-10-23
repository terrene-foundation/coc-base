#!/usr/bin/env node
/**
 * no-verify-position — the regression lock for the `--no-verify` fence's
 * ARGV-POSITION predicate.
 *
 * WHAT IS UNDER TEST. The PreToolUse Bash fence that halts on a pre-commit-hook
 * bypass:
 *
 *   .claude/hooks/validate-bash-command.js  — the fence + `carriesNoVerifyFlag`
 *   .claude/hooks/lib/git-command-parse.js  — `parseGitInvocation`'s `argv`
 *
 * THE DEFECT, as MEASURED before the fix. The predicate was pure TOKEN PRESENCE
 * against the raw segment text, quotes and all:
 *
 *   segments.some((s) => /(?:^|\s)--no-verify\b/.test(s.trim()))
 *
 * so it fired on the CHARACTERS wherever they sat. Every row below returned
 * `exit=0 HALT-AND-REPORT` and every row is a FALSE POSITIVE — none of them can
 * bypass any hook, because none of them is a git invocation that takes the flag:
 *
 *   echo "we used --no-verify once"          -> HALT-AND-REPORT   (quoted prose)
 *   echo --no-verify                         -> HALT-AND-REPORT   (operand)
 *   grep -rn -- --no-verify .claude/hooks    -> HALT-AND-REPORT   (search pattern)
 *   git log --grep 'skip --no-verify here'   -> HALT-AND-REPORT   (--grep argument)
 *   cat /tmp/m.txt | grep -c ' --no-verify ' -> HALT-AND-REPORT   (grepping a body)
 *
 * The control proving those silences are real and not an inert instrument:
 * `git commit --no-verify -m x` reached the SAME fence with the SAME severity on
 * the SAME tree, and `gh pr comment 5 --body "the commit used --no-verify"` was
 * already SILENT — so the fence could both speak and stay quiet, and the five
 * rows above are genuine over-fires (instrument-discipline.md MUST-3(a)).
 *
 * This is loom#1714 MEDIUM-1's class, and the file already records it for a
 * sibling verb: `findPushInvocation`'s docstring says a raw `/git\s+push/` match
 * "fired on `git push` appearing as DATA — inside a JS string, a quoted
 * argument, a heredoc body or a comment". The remedy is the same one, not a
 * wider regex: key on the parsed ARGV POSITION.
 *
 * HOW IT DISCRIMINATES — BIPOLAR, PER ARM. Every arm carries both poles, so a
 * fence that went quiet everywhere fails exactly as loudly as one that fires on
 * everything. A fixture set proving only that the guard got quieter would have
 * proved the guard was disabled; the FIRING poles are the load-bearing half.
 *
 *   - FIRING poles assert the failure IDENTITY — the fence's own
 *     `Bash command uses --no-verify` text AND its `git.md` rationale — never a
 *     bare exit code, which any unrelated fence firing would satisfy. This is
 *     not pedantry here: `git push --no-verify` ALSO trips the CI-spend
 *     advisory, and `git commit …` trips a code-review reminder, so "the hook
 *     said something" cannot separate this fence from its neighbours.
 *   - QUIET poles assert the ABSENCE of that identity rather than global
 *     silence, for the same reason: the neighbours legitimately speak.
 *
 * THE TWO PROPERTIES THE CASES ARE BUILT AROUND:
 *
 *   POSITION, NEVER PRESENCE. `git commit -m "--no-verify"` carries the exact
 *   token in argv and bypasses NOTHING — it is the commit MESSAGE. So does
 *   `git commit -m x -- --no-verify`, where the token is a pathspec. A predicate
 *   that cannot separate a flag slot from a value slot is not evidence.
 *
 *   A VALUE-FLAG TABLE FAILS DANGEROUSLY WHEN WRONG. Skipping the word after a
 *   flag is what makes the message case quiet — but listing a BOOLEAN flag as
 *   value-taking makes the walk skip a REAL `--no-verify` sitting right after
 *   it. `posture-gate.js::VALUE_FLAGS` lists `push --force-with-lease`,
 *   `push --signed` and `commit -S`, all three of which consume NOTHING in their
 *   separated form (measured). The `POS/boolean-*-fires` cases pin exactly that:
 *   they red for an implementation that copied that table instead of measuring.
 *
 * NOTHING DESTRUCTIVE EVER RUNS. Every case drives the hook as a DECISION
 * FUNCTION — the candidate command is delivered on stdin as DATA and is never
 * executed. The sandbox is a throwaway repo, and no case touches the checkout
 * this runner lives in.
 *
 * Each arm names the mutation that reds it; see README.md for the measured
 * mutation run.
 */
import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const HOOK =
  process.env.NO_VERIFY_POSITION_HOOK ||
  path.join(REPO_ROOT, ".claude", "hooks", "validate-bash-command.js");

// ---------------------------------------------------------------- sandbox
// realpath'd because macOS resolves /tmp -> /private/tmp; a cwd the hook
// re-resolves differently would move the failures off the behaviour under test.
const TMP = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "no-verify-pos-")),
);
const REPO = path.join(TMP, "repo");
const git = (args, cwd) =>
  spawnSync("git", args, { cwd, encoding: "utf8", timeout: 20000 });

fs.mkdirSync(REPO, { recursive: true });
git(["init", "-q", "-b", "main", "."], REPO);
git(["config", "user.email", "fixture@example.invalid"], REPO);
git(["config", "user.name", "fixture"], REPO);
fs.writeFileSync(path.join(REPO, "tracked.txt"), "a\n");
git(["add", "tracked.txt"], REPO);
git(["commit", "-qm", "init"], REPO);

// ---------------------------------------------------------------- driver
/** Drive the hook as a decision function. Executes nothing. */
function runHook(command, cwd = REPO) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      tool_name: "Bash",
      tool_input: { command },
      cwd,
    }),
    encoding: "utf8",
    timeout: 30000,
  });
  const raw = (r.stdout || "") + (r.stderr || "");
  let envelope = null;
  let text = "";
  try {
    const line = (r.stdout || "")
      .trim()
      .split("\n")
      .find((l) => l.startsWith("{"));
    envelope = JSON.parse(line);
    const h = envelope.hookSpecificOutput || {};
    text = h.permissionDecisionReason || h.additionalContext || "";
  } catch {
    envelope = null;
    text = "PARSE-FAIL:" + raw;
  }
  return { exit: r.status, text, envelope, raw };
}

// The fence's OWN identity. Both halves are asserted: the `what_happened` stem
// names this fence, and the `why` names the rule it enforces. A neighbouring
// lane firing on the same command satisfies neither.
const WHAT_MARKER = "Bash command uses --no-verify";
const BYPASS_MARKER = "Bash command overrides Git hooks";
const UNKNOWN_MARKER = "Bash command has unresolved Git hook controls";
const WHY_MARKER = "pre-commit hooks exist for a reason";

/** Did THIS fence speak (as opposed to some neighbour)? */
const fenceSpoke = (res) =>
  res.text.includes(WHAT_MARKER) && res.text.includes(WHY_MARKER);

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
  // `^\s*(FAIL|not ok)\s+\S`, not by reading the summary below. A runner that
  // printed only a summary would report `0p/0f 0c` and trip the `min_cases`
  // anti-vacuity floor while standing green on its own.
  if (verdict === true) {
    pass += 1;
    console.log(`PASS ${id}`);
  } else {
    failures.push(`${id} (${verdict})`);
    console.log(`FAIL ${id}`);
    console.log(`     ${verdict}`);
  }
}

/** FIRING pole: the fence's identity is present. */
function assertFires(res) {
  if (res.envelope === null) return `hook produced no parseable envelope: ${res.raw.slice(0, 200)}`;
  if (!res.text.includes(WHAT_MARKER)) {
    return `expected the --no-verify fence to fire; body does not carry ${JSON.stringify(WHAT_MARKER)}: ${res.text.slice(0, 200)}`;
  }
  if (!res.text.includes(WHY_MARKER)) {
    return `body names the command but not the rule ${JSON.stringify(WHY_MARKER)} — this may be a different lane quoting the argv`;
  }
  return true;
}

/**
 * QUIET pole: THIS fence did not fire. Deliberately not "the hook said
 * nothing" — neighbouring lanes legitimately speak on these same commands (the
 * code-review reminder on `git commit`, the CI-spend advisory on `git push`),
 * and asserting global silence would red for a reason unrelated to the
 * behaviour under test. The envelope check is what stops a CRASHED hook from
 * reading as quiet: no output also contains no marker.
 */
function assertQuiet(res) {
  if (res.envelope === null) return `hook produced no parseable envelope: ${res.raw.slice(0, 200)}`;
  if (res.exit !== 0) return `expected exit 0, got ${res.exit}`;
  if (res.text.includes(WHAT_MARKER) || res.text.includes(BYPASS_MARKER) || res.text.includes(UNKNOWN_MARKER)) {
    return `the --no-verify fence fired on a command that bypasses nothing: ${res.text.slice(0, 200)}`;
  }
  return true;
}

// ----------------------------------------------------- anti-vacuity precondition
// Fire the instrument at a known-answer case BEFORE reading any silence
// (instrument-discipline.md MUST-3(a)). If the driver cannot observe this fence
// firing at all, every QUIET pole below is vacuous — it would pass for a hook
// that was never invoked, for a renamed marker, or for a sandbox the hook
// refuses. Refusing to report a green is the only honest outcome there.
{
  const probe = runHook("git commit --no-verify -m x");
  if (!fenceSpoke(probe)) {
    console.log(
      "no-verify-position: PRECONDITION FAILED — the driver cannot observe the " +
        `--no-verify fence firing on its canonical case. exit=${probe.exit} ` +
        `body=${JSON.stringify(probe.text.slice(0, 300))}. Every QUIET pole would ` +
        "be vacuous; refusing to report a green.",
    );
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(1);
  }
}

// ===================================================== ARM 1: the measured FPs
// Mutation that reds this arm: restore the token-presence predicate
// (`segments.some((s) => /(?:^|\s)--no-verify\b/.test(s.trim()))`) -> all five
// measured rows fire again, plus both data-carrier rows.

check("FP/echo-prose-quoted-quiet", () =>
  assertQuiet(runHook('echo "we used --no-verify once"')),
);
check("FP/echo-bare-operand-quiet", () =>
  assertQuiet(runHook("echo --no-verify")),
);
check("FP/grep-search-pattern-quiet", () =>
  assertQuiet(runHook("grep -rn -- --no-verify .claude/hooks")),
);
// A git invocation, but on a verb that has no hooks and does not take the flag.
// The token is the VALUE of --grep. Both fences have to hold for this to pass.
check("FP/git-log-grep-argument-quiet", () =>
  assertQuiet(runHook("git log --grep 'skip --no-verify here'")),
);
check("FP/pipe-grep-count-quiet", () =>
  assertQuiet(runHook("cat /tmp/m.txt | grep -c ' --no-verify '")),
);
// Already correct before the fix — a do-not-regress pole, not a claimed win.
check("FP/gh-pr-comment-body-quiet", () =>
  assertQuiet(runHook('gh pr comment 5 --body "the commit used --no-verify"')),
);
// The shape that fired on this very workstream's own tooling: a JSON payload of
// candidate commands written to disk as DATA.
check("FP/printf-json-data-carrier-quiet", () =>
  assertQuiet(
    runHook(
      `printf '%s' '[{"cmd":"git push --no-verify origin dev"}]' > ${path.join(TMP, "cases.json")}`,
    ),
  ),
);
check("FP/heredoc-body-carrier-quiet", () =>
  assertQuiet(
    runHook(
      `cat > ${path.join(TMP, "note.txt")} <<'EOF'\nwe once ran git commit --no-verify -m x\nEOF`,
    ),
  ),
);

// ============================================ ARM 2: genuine bypasses still fire
// Mutation that reds this arm: make `carriesNoVerifyFlag` return false
// unconditionally -> every case below reds while ARM 1 stays green, which is
// precisely the "you disabled the guard" outcome a one-poled suite would miss.

check("TP/commit-fires", () => assertFires(runHook("git commit --no-verify -m x")));
// The CI-spend advisory ALSO fires here and renders FIRST. Asserting the fence's
// own identity is what separates "this fence spoke" from "something spoke".
check("TP/push-fires", () =>
  assertFires(runHook("git push --no-verify origin dev")),
);
check("TP/merge-fires", () => assertFires(runHook("git merge --no-verify feature/x")));
check("TP/rebase-fires", () => assertFires(runHook("git rebase --no-verify --continue")));
check("TP/am-fires", () => assertFires(runHook("git am --no-verify /tmp/p.patch")));
check("TP/pull-fires", () => assertFires(runHook("git pull --no-verify origin main")));
// Quoting the flag does not change what git receives; the tokenizer dequotes.
check("TP/quoted-flag-fires", () =>
  assertFires(runHook('git commit "--no-verify" -m x')),
);
// A guard matching only the LEADING flag position is disarmed by moving it.
check("TP/flag-after-operands-fires", () =>
  assertFires(runHook("git commit -m x --no-verify")),
);
check("TP/retargeted-C-fires", () =>
  assertFires(runHook(`git -C ${REPO} commit --no-verify -m x`)),
);
check("TP/nested-sh-c-fires", () =>
  assertFires(runHook("sh -c 'git commit --no-verify -m x'")),
);
check("TP/eval-body-fires", () =>
  assertFires(runHook('eval "git commit --no-verify -m x"')),
);
check("TP/chained-after-safe-verb-fires", () =>
  assertFires(runHook("git status && git commit --no-verify -m x")),
);
check("TP/shell-grouped-fires", () =>
  assertFires(runHook("(git commit --no-verify -m x)")),
);

// ================================================ ARM 3: argv POSITION precision
// Mutation that reds the QUIET half: delete the value-flag skip
// (`if (valueFlags && valueFlags.has(t)) { i += 1; continue; }`) -> the three
// value-slot cases fire again.
// Mutation that reds the FIRING half: add `-S`/`--force-with-lease`/`--signed`
// to NO_VERIFY_VALUE_FLAGS (i.e. copy posture-gate's table) -> those three cases
// go silent. That mutation opens a BYPASS, which is why this half exists.

check("POS/value-of-m-quiet", () =>
  assertQuiet(runHook('git commit -m "--no-verify"')),
);
check("POS/value-of-F-quiet", () =>
  assertQuiet(runHook("git commit -F --no-verify")),
);
// After `--` every word is a pathspec. This stages a FILE of that name.
check("POS/after-double-dash-quiet", () =>
  assertQuiet(runHook("git commit -m x -- --no-verify")),
);
// `-S` / `--gpg-sign` take an OPTIONAL value, attached-form only: the separated
// form consumes NOTHING, so the next word is a real flag.
check("POS/boolean-gpgsign-does-not-swallow-fires", () =>
  assertFires(runHook("git commit -S --no-verify -m x")),
);
check("POS/boolean-force-with-lease-does-not-swallow-fires", () =>
  assertFires(runHook("git push --force-with-lease --no-verify origin dev")),
);
check("POS/boolean-signed-does-not-swallow-fires", () =>
  assertFires(runHook("git push --signed --no-verify origin dev")),
);
// A verb that does not take the flag at all: the characters are present, the
// bypass is not — git rejects the flag and the command fails on its own.
// Mutation that reds these: drop the NO_VERIFY_SUBCOMMANDS gate.
check("POS/non-fenced-verb-log-quiet", () =>
  assertQuiet(runHook("git log --no-verify -1")),
);
check("POS/non-fenced-verb-stash-quiet", () =>
  assertQuiet(runHook("git stash --no-verify")),
);
// `tag` measured NOT-TAKEN on git 2.54.0, the same verdict `stash` got from the
// same probe with the same control. It is therefore QUIET for the same reason,
// and this pole is what keeps the two from resting on opposite readings of one
// measurement. An earlier revision fired here on a version-skew argument no
// measurement supported; that is withdrawn, not silently reversed.
// Mutation that reds this: put "tag" back into NO_VERIFY_SUBCOMMANDS.
check("POS/non-fenced-verb-tag-quiet", () =>
  assertQuiet(runHook("git tag --no-verify -m msg v1.2.3")),
);

// ==================================================== ARM 4: fail CLOSED, no bypass
// Mutation that reds this arm: delete the `verbUnknown` leg of `fenced`, or the
// fail-closed raw-segment tail -> a hidden verb walks through silently, which is
// the one direction this precision fix was forbidden to move.

// Verb hidden in a substitution; argv SURVIVES, so the walk finds the flag.
check("FC/substituted-verb-fires", () =>
  assertFires(runHook("git $(echo commit) --no-verify -m x")),
);
// Verb fused to the git token; the parser returns argv [] here, so ONLY the
// raw-segment tail can still see the flag. This case reds if that tail is cut.
check("FC/fused-git-token-fires", () =>
  assertFires(runHook("git$IFS commit --no-verify -m x")),
);
// Command NAME opaque, verb resolved: the ordinary subcommand gate covers it.
check("FC/substituted-command-fires", () =>
  assertFires(runHook("$(echo git) commit --no-verify -m x")),
);

// ============================================= ARM 5: severity register is unchanged
// The signal moved from lexical to structural (a parsed argv slot), which makes
// it block-ELIGIBLE under hook-output-discipline.md MUST-2 — and it is
// deliberately NOT escalated. Mutation that reds this: change the fence's
// severity to "block".
check("SEV/fires-without-blocking", () => {
  const res = runHook("git commit --no-verify -m x");
  if (!fenceSpoke(res)) return "the fence did not fire, so severity is unreadable";
  if (res.envelope && (res.envelope.continue === false || res.envelope?.hookSpecificOutput?.permissionDecision === "deny")) {
    return "the fence BLOCKED; hook-output-discipline.md MUST-2 caps this lane at halt-and-report";
  }
  if (res.exit !== 0) return `expected a non-blocking exit 0, got ${res.exit}`;
  return true;
});

// Parsed bypass decisions are exercised at the hook entry point below.
// Literal no-verify poles above remain separate so their identity stays pinned.
function assertBypass(res) {
  if (!res.envelope) return "hook produced no parseable envelope";
  if (!res.text.includes(BYPASS_MARKER) || !res.text.includes(WHY_MARKER))
    return "expected parsed Git hooks bypass finding, got: " + res.text.slice(0, 200);
  if (!res.text.includes("git.md § Discipline")) return "rationale omitted named Discipline source";
  if (res.exit !== 0 || res.envelope.continue === false ||
      res.envelope.hookSpecificOutput?.permissionDecision === "deny")
    return "parsed bypass escalated beyond halt-and-report";
  return true;
}
const bypassCases = [
  ["husky-pipe-receiver", "printf 'git commit -m x' | env HUSKY=0 bash"],
  ["config-pipe-receiver", "printf 'git -c core.hooksPath=/hooks commit -m x' | env HUSKY=1 bash"],
  ["husky-pipe-nested-shell", "sh -c \"printf 'git commit -m x' | env HUSKY=0 bash\""],
  ["config-grouped", "(git -c core.hooksPath=/hooks commit -m x)"],
  ["husky-grouped-shell", "(HUSKY=0 sh -c 'git commit -m x')"],
  ["config-stdin-shell", "printf 'git -c core.hooksPath=/hooks commit -m x' | bash"],
  ["config-heredoc-shell", "bash <<'EOF'\ngit -c core.hooksPath=/hooks commit -m x\nEOF"],
  ["config-separated-commit", "git -c core.hooksPath=/dev/null commit -m x"],
  ["config-attached-push", "git -ccore.hooksPath=/other/hooks push origin dev"],
  ["config-quoted-case-merge", "git -c 'CORE.HOOKSPATH=/some/hooks' merge dev"],
  ["config-empty", "git -c core.hooksPath= commit -m x"],
  ["config-implicit-boolean", "git -c core.hooksPath commit -m x"],
  ["config-dynamic-value", 'git -c core.hooksPath="$HOOKS" commit -m x'],
  ["config-env-attached", "git --config-env=core.hooksPath=HOOKS commit -m x"],
  ["config-env-separated", "git --config-env 'CORE.HOOKSPATH=HOOKS' push origin dev"],
  ["config-shell-body", "sh -c 'git -c core.hooksPath=/dev/null commit -m x'"],
  ["config-substitution-body", 'printf "%s" "$(git -c core.hooksPath=/dev/null commit -m x)"'],
  ["husky-prefix-commit", "HUSKY=0 git commit -m x"],
  ["husky-unset-then-assignment", "env -u HUSKY HUSKY=0 git commit -m x"],
  ["husky-env-quoted-assignment", 'env "HUSKY=0" git commit -m x'],
  ["husky-env-push", "env HUSKY=0 git push origin dev"],
  ["husky-quoted-merge", "HUSKY='0' git merge dev"],
  ["husky-shell-prefix", "HUSKY=0 sh -c 'git commit -m x'"],
  ["husky-shell-body", "sh -c 'HUSKY=0 git commit -m x'"],
  ["husky-nested-shell", 'env HUSKY=0 sh -c "sh -c \'git commit -m x\'"'],
  ["husky-env-split-string", "env -S 'HUSKY=0 git commit -m x'"],
];
for (const [id, command] of bypassCases)
  check("BYPASS/" + id, () => assertBypass(runHook(command)));
const bypassQuietCases = [
  ["husky-pipe-quoted-data", "printf 'git commit -m x | env HUSKY=0 bash'"],
  ["config-pipe-wrapped-read", "printf 'git config --get core.hooksPath' | env HUSKY=0 bash"],
  ["husky-pipe-producer-cmd-body", "HUSKY=0 printf x | bash -c 'git commit -m x'"],
  ["config-wrapped-read", "sh -c 'git config --get core.hooksPath'"],
  ["husky-pipe-producer-only", "HUSKY=0 printf 'git commit -m x' | bash"],
  ["config-read", "git config --get core.hooksPath"],
  ["config-other-key", "git -c user.name=x commit -m x"],
  ["config-key-value-lookalike", "git -c user.name=core.hooksPath=/dev/null commit -m x"],
  ["config-after-verb-data", "git commit -m 'core.hooksPath=/dev/null'"],
  ["config-echo-data", "echo 'git -c core.hooksPath=/dev/null commit'"],
  ["config-grep-data", "grep -rn -- 'git -c core.hooksPath=/dev/null commit' ."],
  ["config-heredoc-data", "cat <<'EOF'\ngit -c core.hooksPath=/dev/null commit\nHUSKY=0 git commit\nEOF"],
  ["config-unfenced-log", "git -c core.hooksPath=/dev/null log -1"],
  ["husky-single-quoted-command-data", "'HUSKY=0' git commit -m x"],
  ["husky-quoted-command-data", '"HUSKY=0" git commit -m x'],
  ["husky-escaped-name-data", "HUSK\\Y=0 git commit -m x"],
  ["husky-enabled", "HUSKY=1 git commit -m x"],
  ["husky-other-name", "NOT_HUSKY=0 git commit -m x"],
  ["husky-message-data", "git commit -m 'HUSKY=0'"],
  ["husky-echo-data", "echo 'HUSKY=0 git commit'"],
  ["husky-last-assignment", "HUSKY=0 HUSKY=1 git commit -m x"],
  ["husky-clear-environment", "HUSKY=0 env -i git commit -m x"],
  ["husky-unset", "HUSKY=0 env -u HUSKY git commit -m x"],
  ["husky-unset-shell", "HUSKY=0 sh -c 'env -u HUSKY git commit -m x'"],
  ["husky-substitution-before-assignment", 'HUSKY=0 printf "%s" "$(git commit -m x)"'],
  ["husky-wrapper-operand-data", "sudo -u HUSKY=0 git commit -m x"],
  ["husky-no-cross-segment-leak", "HUSKY=0 true; git commit -m x"],
];
for (const [id, command] of bypassQuietCases)
  check("BYPASS-QUIET/" + id, () => assertQuiet(runHook(command)));



function assertUnknown(res, control) {
  assert.ok(res.envelope, "unresolved hook control must produce a parseable envelope");
  assert.equal(res.exit, 0);
  assert.ok(res.text.includes(UNKNOWN_MARKER), "unresolved hook control must halt-and-report UNKNOWN");
  assert.ok(res.text.includes("NOT RUN/UNKNOWN"));
  assert.ok(res.text.includes(control));
  assert.ok(res.text.includes(WHY_MARKER));
  assert.equal(res.text.includes(BYPASS_MARKER), false, "unknown must not claim a confirmed override");
  return true;
}
for (const verb of ["commit", "push", "merge"]) {
  for (const prefix of ["HUSKY=$(printf 0)", "env HUSKY=$(printf 0)"]) {
    check("UNRESOLVED/husky-" + verb + "-" + prefix.split(" ")[0], () => assertUnknown(runHook(prefix + " git " + verb + " -m x"), "HUSKY"));
  }
  for (const option of ['-c "$(printf core.hooksPath)=/dev/null"', '-c"$(printf core.hooksPath)=/dev/null"', '--config-env "$(printf core.hooksPath)=HOOKS"', '--config-env="$(printf core.hooksPath)=HOOKS"']) {
    check("UNRESOLVED/config-key-" + verb + "-" + option, () => assertUnknown(runHook("git " + option + " " + verb + " -m x"), "config key"));
  }
}
for (const [id, command] of [
  ["exec-clear", "HUSKY=0 exec -c git commit -m x"],
  ["command-operand", "command HUSKY=0 git commit -m x"],
  ["nice-operand", "nice HUSKY=0 git commit -m x"],
  ["command-lookup-v", "HUSKY=0 command -v git commit"],
  ["command-lookup-V", "HUSKY=0 command -V git commit"],
  ["unknown-clear", "HUSKY=$(printf 0) env -i git commit -m x"],
  ["unknown-unset", "HUSKY=$(printf 0) env -u HUSKY git commit -m x"],
  ["unknown-literal-overwrite", "HUSKY=$(printf 0) HUSKY=1 git commit -m x"],
  ["unknown-shell-unset", "HUSKY=$(printf 0) sh -c 'env -u HUSKY git commit -m x'"],
  ["unknown-producer-only", "HUSKY=$(printf 0) printf 'git commit -m x' | bash"],
  ["unknown-value-known-user-key", 'git -c user.name="$(printf core.hooksPath)" commit -m x'],
  ["quoted-computed-key-data", "git -c '$(printf core.hooksPath)=/dev/null' commit -m x"],
]) check("R1-QUIET/" + id, () => assertQuiet(runHook(command)));
for (const [id, command] of [
  ["command-real", "HUSKY=0 command git commit -m x"],
  ["exec-real", "HUSKY=0 exec git commit -m x"],
  ["unknown-literal-zero-overwrite", "HUSKY=$(printf 1) HUSKY=0 git commit -m x"],
]) check("R1-CONFIRMED/" + id, () => assertBypass(runHook(command)));


for (const verb of ["commit", "push", "merge"]) {
  for (const prefix of ["", "env "]) check("COUNT/confirmed-" + verb + "-" + (prefix ? "env" : "prefix"), () => assertBypass(runHook(prefix + "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git " + verb + " -m x")));
  check("COUNT/unknown-count-" + verb, () => assertUnknown(runHook("GIT_CONFIG_COUNT=$(printf 1) GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git " + verb + " -m x"), "GIT_CONFIG_COUNT"));
  check("COUNT/unknown-key-" + verb, () => assertUnknown(runHook("GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=$(printf core.hooksPath) GIT_CONFIG_VALUE_0=/dev/null git " + verb + " -m x"), "GIT_CONFIG_KEY_0"));
}
for (const [id, assignments] of [
  ["plus-one", "GIT_CONFIG_COUNT=+1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null"],
  ["leading-zero", "GIT_CONFIG_COUNT=01 GIT_CONFIG_KEY_0=CORE.HOOKSPATH GIT_CONFIG_VALUE_0=/dev/null"],
  ["second-key", "GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=safe GIT_CONFIG_KEY_1=core.hooksPath GIT_CONFIG_VALUE_1=/hooks"],
  ["unknown-value-known-key", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=$(printf /dev/null)"],
]) check("COUNT/confirmed-" + id, () => assertBypass(runHook(assignments + " git commit -m x")));
for (const [id, command] of [
  ["zero", "GIT_CONFIG_COUNT=0 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x"],
  ["empty", "GIT_CONFIG_COUNT= GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x"],
  ["unrelated-key-unknown-value", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=$(printf core.hooksPath) git commit -m x"],
  ["clear", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null env -i git commit -m x"],
  ["unset", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null env -u GIT_CONFIG_COUNT git commit -m x"],
  ["unknown-overwritten", "GIT_CONFIG_COUNT=$(printf 1) GIT_CONFIG_COUNT=0 git commit -m x"],
  ["producer-only", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null printf 'git commit -m x' | bash"],
  ["message-data", "git commit -m 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null'"],
]) check("COUNT-QUIET/" + id, () => assertQuiet(runHook(command)));
for (const [id, assignments, control] of [
  ["bounded-range", "GIT_CONFIG_COUNT=65", "GIT_CONFIG_COUNT"],
  ["missing-key", "GIT_CONFIG_COUNT=1 GIT_CONFIG_VALUE_0=/dev/null", "GIT_CONFIG_KEY_0"],
  ["missing-value", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath", "GIT_CONFIG_VALUE_0"],
]) check("COUNT-UNKNOWN/" + id, () => assertUnknown(runHook(assignments + " git commit -m x"), control));


for (const verb of ["commit", "push", "merge"]) {
  for (const [id, prefix] of [
    ["exec-attached-a", "HUSKY=0 exec -acustom"],
    ["exec-separated-a", "HUSKY=0 exec -a custom"],
    ["shell-append", "HUSKY= HUSKY+=0"],
    ["sudo-setter", "sudo HUSKY=0"],
  ]) check("R2-CONFIRMED/" + id + "-" + verb, () => assertBypass(runHook(prefix + " git " + verb + " -m x")));
  check("R2-UNKNOWN/empty-key-" + verb, () => assertUnknown(runHook("GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0= GIT_CONFIG_VALUE_0=x git " + verb + " -m x"), "GIT_CONFIG_KEY_0"));
}
for (const [id, command] of [
  ["exec-clear-before-a", "HUSKY=0 exec -cacustom git commit -m x"],
  ["exec-clear-after-a-operand", "HUSKY=0 exec -a custom -c git commit -m x"],
  ["append-known-nonzero", "HUSKY=1 HUSKY+=0 git commit -m x"],
  ["append-cleared", "HUSKY+=0 env -i git commit -m x"],
  ["append-overwritten", "HUSKY+=0 HUSKY=1 git commit -m x"],
  ["env-plus-name", "env HUSKY+=0 git commit -m x"],
  ["sudo-plus-name", "sudo HUSKY+=0 git commit -m x"],
  ["sudo-option-operand", "sudo -u HUSKY=0 git commit -m x"],
  ["append-count-zero", "GIT_CONFIG_COUNT=0 GIT_CONFIG_COUNT+=0 git commit -m x"],
]) check("R2-QUIET/" + id, () => assertQuiet(runHook(command)));
for (const [id, command] of [
  ["exec-pending-dash-operand", "HUSKY=0 exec -a -custom git commit -m x"],
  ["append-after-clear", "env -i sh -c 'HUSKY+=0 git commit -m x'"],
  ["append-after-unset", "HUSKY=1 env -u HUSKY sh -c 'HUSKY+=0 git commit -m x'"],
  ["append-indexed-key", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core. GIT_CONFIG_KEY_0+=hooksPath GIT_CONFIG_VALUE_0= GIT_CONFIG_VALUE_0+=/hooks git commit -m x"],
  ["append-count-one", "GIT_CONFIG_COUNT= GIT_CONFIG_COUNT+=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/hooks git commit -m x"],
]) check("R2-CONFIRMED/" + id, () => assertBypass(runHook(command)));
for (const [id, command, control] of [
  ["append-ambient", "HUSKY+=0 git commit -m x", "HUSKY"],
  ["append-opaque-prior", "HUSKY=$(printf 1) HUSKY+=0 git commit -m x", "HUSKY"],
  ["append-opaque-value", "HUSKY= HUSKY+=$(printf 0) git commit -m x", "HUSKY"],
  ["append-ambient-count", "GIT_CONFIG_COUNT+=1 git commit -m x", "GIT_CONFIG_COUNT"],
  ["append-ambient-key", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0+=hooksPath GIT_CONFIG_VALUE_0=x git commit -m x", "GIT_CONFIG_KEY_0"],
  ["sudo-ambiguous-optional-value", "sudo -h HUSKY=0 git commit -m x", "wrapper"],
  ["wrapper-ambiguous-transition", "nohup HUSKY=0 git commit -m x", "wrapper"],
]) check("R2-UNKNOWN/" + id, () => assertUnknown(runHook(command), control));

const require = createRequire(import.meta.url);
const parserPath = path.join(REPO_ROOT, ".claude/hooks/lib/git-command-parse.js");
const parser = require(parserPath);
check("PARSE/enumerable-invocation-shape", () => {
  // The FROZEN shape now carries `targetContext` (the destructive-Git target
  // context the guards read). Frozen from a measured parseGitInvocation at this
  // head, so any shape move reds here.
  assert.deepEqual(parser.parseGitInvocation("HUSKY=0 git -c core.hooksPath=/dev/null commit -m x"),
    { sub: "commit", dir: null,
      targetContext: { base: { kind: "payload-cwd" }, shellChdir: [], chdir: [], workTree: null, gitDir: null, unknown: [], segment: "HUSKY=0 git -c core.hooksPath=/dev/null commit -m x" },
      args: "-m x", argv: ["-m", "x"], unresolvable: null });
  return true;
});
check("PARSE/wrapper-route-neither-suppressed", () => {
  // A wrapped chain is enumerated through BOTH routes — the top-level walk sees
  // through the unknown launcher AND the extracted nested body reports again —
  // each carrying its OWN targetContext.unknown provenance ("wrapper-target-
  // context" vs "nested-prefix-target-context"). parseGitInvocations drops a
  // nested-derived record ONLY for an EQUAL invocation, and these two differ in
  // provenance, so neither is suppressed BY DESIGN (git-command-parse.js
  // § parseGitInvocations). The earlier `length === 1` predates the
  // target-context carry and demanded a suppression the final parser
  // deliberately does not perform.
  assert.equal(parser.parseGitInvocations("HUSKY=0 sudo chroot / setuidgid 0 git commit -m x").length, 2);
  return true;
});
function requiredBypass(subject, command, reason, id) {
  assert.equal(subject.findGitHookBypass(command)?.reason, reason, id + ": required bypass identity missing");
}
for (const [id, anchor, replacement, command, reason] of [
  ["BYPASS/config-separated-commit", 'if (context.config.some((value) => value.split("=", 1)[0].toLowerCase() === "core.hookspath"))',
    'if ((mutationHits++, false))', "git -c core.hooksPath=/dev/null commit -m x", "core.hooksPath override"],
  ["BYPASS/husky-prefix-commit", 'if (environment.get("HUSKY") === "0")',
    'if ((mutationHits++, false))', "HUSKY=0 git commit -m x", "HUSKY=0"],
  ["BYPASS/husky-pipe-receiver", 'if (wrappedReceivers) {',
    'if ((mutationHits++, false)) {', "printf 'git commit -m x' | env HUSKY=0 bash", "HUSKY=0"],
  ["BYPASS/config-grouped", 'parseGitInvocations(command, true)',
    '(mutationHits++, parseGitInvocations(command, false))', "(git -c core.hooksPath=/hooks commit -m x)", "core.hooksPath override"],
  ["BYPASS/husky-shell-prefix", 'context.environmentOps = expansionEnvironments.get(nested)[k].concat(context.environmentOps);',
    'mutationHits++; context.environmentOps = context.environmentOps;', "HUSKY=0 sh -c 'git commit -m x'", "HUSKY=0"],
]) {
  check("MUTATION/" + id, () => {
    requiredBypass(parser, command, reason, id);
    const source = fs.readFileSync(parserPath, "utf8");
    if (source.split(anchor).length !== 2) throw new Error("mutation anchor missing or ambiguous: " + id);
    const mutant = new Module(parserPath);
    mutant.filename = parserPath;
    mutant.paths = Module._nodeModulePaths(path.dirname(parserPath));
    mutant._compile("let mutationHits = 0;\n" + source.replace(anchor, replacement) +
      "\nmodule.exports.mutationHits = () => mutationHits;", parserPath);
    const observed = mutant.exports.findGitHookBypass(command);
    assert.ok(mutant.exports.mutationHits() > 0, id + ": mutation did not reach code");
    console.log("MUTATION-REACHED " + id);
    assert.equal(observed, null, id + ": mutation did not drop required finding");
    assert.throws(() => requiredBypass(mutant.exports, command, reason, id),
      (error) => error.name === "AssertionError" &&
        error.message.startsWith(id + ": required bypass identity missing"));
    console.log("EXPECTED-RED " + id + ": required bypass identity missing");
    return true;
  });
}


check("PARSE/distinct-config-contexts-retained", () => {
  const command = "git -c user.name=x commit -m x; git -c core.hooksPath=/hooks commit -m x";
  assert.equal(parser.parseGitInvocations(command).length, 2);
  requiredBypass(parser, command, "core.hooksPath override", "distinct config contexts");
  return true;
});
check("PARSE/distinct-environment-contexts-retained", () => {
  const command = "HUSKY=1 git commit -m x; HUSKY=0 git commit -m x";
  assert.equal(parser.parseGitInvocations(command).length, 2);
  requiredBypass(parser, command, "HUSKY=0", "distinct environment contexts");
  return true;
});

check("MUTATION/BYPASS-QUIET/husky-quoted-command-data", () => {
  const command = '"HUSKY=0" git commit -m x';
  const id = "BYPASS-QUIET/husky-quoted-command-data";
  assert.equal(parser.findGitHookBypass(command), null, id);
  const source = fs.readFileSync(parserPath, "utf8");
  const anchor = '(envWrapper || sudoSetter || (!sawWrapper && assignmentSyntax.get(toks[i])))';
  assert.equal(source.split(anchor).length, 2, "quote mutation anchor missing or ambiguous");
  const mutant = new Module(parserPath);
  mutant.filename = parserPath;
  mutant.paths = Module._nodeModulePaths(path.dirname(parserPath));
  mutant._compile("let mutationHits = 0;\n" + source.replace(anchor, "(mutationHits++, true)") +
    "\nmodule.exports.mutationHits = () => mutationHits;", parserPath);
  const observed = mutant.exports.findGitHookBypass(command);
  assert.ok(mutant.exports.mutationHits() > 0, id + ": mutation did not reach code");
  console.log("MUTATION-REACHED " + id);
  assert.equal(observed?.reason, "HUSKY=0", "quote mutant did not cause expected overfire");
  assert.throws(() => assert.equal(observed, null, id + ": unexpected bypass finding"),
    (error) => error.name === "AssertionError" && error.message.startsWith(id + ": unexpected bypass finding"));
  console.log("EXPECTED-RED " + id + ": unexpected bypass finding");
  return true;
});

for (const [id, command, edits, expectKind, expectedControl] of [
  ["r2-append-known-absence", "env -i sh -c 'HUSKY+=0 git commit -m x'", [['cleared || knownAbsent.has(op.name) ? "" : undefined;', '(mutationHits++, false) ? "" : undefined;']], "override"],
  ["r2-sudo-ambiguous-value", "sudo -h HUSKY=0 git commit -m x", [['const sudoSetter = controlWrapper === "sudo" && wrapperGrammar && operandsSeen >= wrapperGrammar.operands;', 'const sudoSetter = (mutationHits++, controlWrapper === "sudo");']], "unknown", "wrapper"],
  ["r2-exec-a-operand", "HUSKY=0 exec -acustom git commit -m x", [['return { pending: k === chars.length - 1, ambiguous: false };', 'mutationHits++; if (onFlag && chars.slice(k + 1).includes("c")) onFlag("c"); return { pending: k === chars.length - 1, ambiguous: false };']], "override"],
  ["r2-append-capture", "HUSKY= HUSKY+=0 git commit -m x", [['const append = !sawWrapper && t[at - 1] === "+";', 'const append = (mutationHits++, false);']], "override"],
  ["r2-append-effective-value", "HUSKY=1 HUSKY+=0 git commit -m x", [['else if (op.kind === "append") {', 'else if ((mutationHits++, false)) {']], null],
  ["r2-append-unknown-prior", "HUSKY+=0 git commit -m x", [['typeof prior === "string" && typeof op.value === "string" ?', '(mutationHits++, typeof op.value === "string") ?']], "unknown", "HUSKY"],
  ["r2-sudo-setter", "sudo HUSKY=0 git commit -m x", [['(envWrapper || sudoSetter || (!sawWrapper && assignmentSyntax.get(toks[i])))', '(mutationHits++, envWrapper || (!sawWrapper && assignmentSyntax.get(toks[i])))']], "override"],
  ["r2-empty-indexed-key", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0= GIT_CONFIG_VALUE_0=x git commit -m x", [['if (typeof key !== "string" || key === "") return unknown(keyName);', 'if ((mutationHits++, typeof key !== "string")) return unknown(keyName);']], "unknown", "GIT_CONFIG_KEY_0"],
  ["r2-ambiguous-wrapper", "nohup HUSKY=0 git commit -m x", [['if (context.environmentOps.some((op) => op.kind === "unresolved-wrapper"))', 'if ((mutationHits++, false))']], "unknown", "wrapper"],
  ["config-env-range-bound", "GIT_CONFIG_COUNT=65 git commit -m x", [['if (!Number.isSafeInteger(count) || count > 64)', 'if ((mutationHits++, false))']], "unknown", "GIT_CONFIG_COUNT bounded range"],
  ["config-env-missing-value", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath git commit -m x", [['if (!environment.has(valueName))', 'if ((mutationHits++, false))']], "unknown"],
  ["config-env-known-key", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x", [['if (key.toLowerCase() === "core.hookspath")', 'if ((mutationHits++, false))']], "override"],
  ["config-env-unknown-count", "GIT_CONFIG_COUNT=$(printf 1) git commit -m x", [[String.raw`if (typeof countValue !== "string" || !/^\+?\d+$/.test(countValue))`, 'if ((mutationHits++, false))'], ['if (!Number.isSafeInteger(count) || count > 64)', 'if ((mutationHits++, false))']], "unknown"],
  ["config-env-unknown-key", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=$(printf core.hooksPath) GIT_CONFIG_VALUE_0=/dev/null git commit -m x", [['if (typeof key !== "string" || key === "") return unknown(keyName);', 'if ((mutationHits++, false)) return unknown(keyName);'], ['if (key.toLowerCase() === "core.hookspath")', 'if ((mutationHits++, false))']], "unknown"],
  ["unresolved-husky-state", "HUSKY=$(printf 0) git commit -m x", [['if (environment.get("HUSKY")?.kind === "unresolved")', 'if ((mutationHits++, false))']], "unknown"],
  ["unresolved-husky-capture", "HUSKY=$(printf 0) git commit -m x", [['toks[i].unexpandable ? { kind: "unresolved" } : t.slice(at + 1)', 'toks[i].unexpandable ? (mutationHits++, null) : t.slice(at + 1)']], "unknown"],
  ["unresolved-config-state", 'git -c "$(printf core.hooksPath)=/dev/null" commit -m x', [['if (context.unresolvedConfigKey)', 'if ((mutationHits++, false))']], "unknown"],
  ["unresolved-config-capture", 'git -c "$(printf core.hooksPath)=/dev/null" commit -m x', [['if (expansion !== null && expansion < prefix + (equals === -1 ? value.length : equals))', 'if ((mutationHits++, false))']], "unknown"],
  ["exec-clears-env", "HUSKY=0 exec -c git commit -m x", [['if (controlWrapper === "exec" && flag === "c")', 'if ((mutationHits++, false))']], null],
  ["command-lookup-only", "HUSKY=0 command -v git commit", [['if (controlWrapper === "command" && /[vV]/.test(flag))', 'if ((mutationHits++, false))']], null],
  ["wrapper-assignment-operand", "command HUSKY=0 git commit -m x", [
    ['(envWrapper || sudoSetter || (!sawWrapper && assignmentSyntax.get(toks[i])))', '(mutationHits++, envWrapper || assignmentSyntax.get(toks[i]))'],
    ['if (environmentOps && sawWrapper && !envWrapper && !sudoSetter && !pendingValue &&', 'if ((mutationHits++, false) && environmentOps && sawWrapper && !envWrapper && !pendingValue &&'],
  ], null],
]) check("R1-MUTATION/" + id, () => {
  const expected = (result) => {
    assert.equal(result === null ? null : result.kind, expectKind, id + ": hook-control verdict changed");
    if (expectedControl) assert.ok(result.reason.includes(expectedControl), id + ": hook-control verdict changed: wrong control identity");
  };
  expected(parser.findGitHookBypass(command));
  let source = fs.readFileSync(parserPath, "utf8");
  for (const [index, [anchor, replacement]] of edits.entries()) {
    assert.equal(source.split(anchor).length, 2, id + ": mutation anchor missing or ambiguous");
    source = source.replace(anchor, replacement.replaceAll("mutationHits++", "mutationHits[" + index + "]++"));
  }
  const mutant = new Module(parserPath);
  mutant.filename = parserPath;
  mutant.paths = Module._nodeModulePaths(path.dirname(parserPath));
  mutant._compile("let mutationHits = Array(" + edits.length + ").fill(0);\n" + source + "\nmodule.exports.mutationHits = () => mutationHits;", parserPath);
  const observed = mutant.exports.findGitHookBypass(command);
  assert.ok(mutant.exports.mutationHits().every((hits) => hits > 0), id + ": mutation did not reach every edited branch");
  console.log("MUTATION-REACHED R1/" + id);
  assert.throws(() => expected(observed), (e) => e.name === "AssertionError" && e.message.startsWith(id + ": hook-control verdict changed"));
  console.log("EXPECTED-RED R1/" + id + ": hook-control verdict changed");
  return true;
});


check("R1-MUTATION/distinct-unknown-hook-identity", () => {
  const source = fs.readFileSync(HOOK, "utf8");
  const anchor = ': hookBypass.kind === "unknown"';
  assert.equal(source.split(anchor).length, 2, "unknown identity mutation must have a unique target");
  const load = (body) => {
    const subject = new Module(HOOK);
    subject.filename = HOOK;
    subject.paths = Module._nodeModulePaths(path.dirname(HOOK));
    subject._compile("let hookMutationHits = 0;\n" + body.replace(/^#![^\n]*\n/, "") + "\nmodule.exports.testDecision = validateBashCommand; module.exports.hits = () => hookMutationHits;", HOOK);
    return subject.exports;
  };
  const data = { tool_input: { command: "HUSKY=$(printf 0) git commit -m x" }, cwd: REPO };
  const expected = (result) => {
    assert.equal(result.severity, "halt-and-report");
    assert.ok(result.what_happened.startsWith(UNKNOWN_MARKER), "unresolved identity must not claim confirmed override");
  };
  expected(load(source).testDecision(data));
  const mutant = load(source.replace(anchor, ': (hookMutationHits++, false)'));
  const observed = mutant.testDecision(data);
  assert.ok(mutant.hits() > 0, "unknown identity mutation did not reach hook decision");
  console.log("MUTATION-REACHED R1/distinct-unknown-hook-identity");
  assert.throws(() => expected(observed), (e) => e.name === "AssertionError" && e.message.startsWith("unresolved identity must not claim confirmed override"));
  console.log("EXPECTED-RED R1/distinct-unknown-hook-identity: unresolved identity must not claim confirmed override");
  return true;
});

fs.rmSync(TMP, { recursive: true, force: true });

const total = pass + failures.length;
console.log(`\nno-verify-position: ${pass}/${total} PASS`);
if (failures.length > 0) {
  console.log(`FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
