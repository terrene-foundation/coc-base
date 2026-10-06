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
  if (res.text.includes(WHAT_MARKER)) {
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

fs.rmSync(TMP, { recursive: true, force: true });

const total = pass + failures.length;
console.log(`\nno-verify-position: ${pass}/${total} PASS`);
if (failures.length > 0) {
  console.log(`FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
