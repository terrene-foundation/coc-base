#!/usr/bin/env node
/**
 * destructive-force-guard — the regression lock for loom s60, Orchestration
 * Integrity component 4.
 *
 * WHAT IS UNDER TEST. The PreToolUse Bash fence for the destructive ops whose
 * loss is IRRECOVERABLE — there is no reflog for an unstaged modification and
 * none for an untracked-not-ignored file:
 *
 *   git worktree remove --force <path>     (worktree-isolation.md Rule 8)
 *   rm -rf <path>                          (git.md § Destructive Working-Tree Ops)
 *
 * plus the shell-GROUPING normalization (`stripShellGroupDelimiters`) that the
 * ALREADY-SHIPPED `reset --hard` / `clean -f` fences turned out to need too.
 *
 * THE DEFECTS. Three, all MEASURED before the fix, all silent:
 *
 *  (1) `git worktree remove --force` reached NO fence at all. A bare
 *      `git worktree remove` REFUSES a dirty tree and that refusal IS the
 *      safety mechanism; `--force` exists to defeat it.
 *  (2) `rm -rf <dir>` reached no fence either. Only the LONG-flag spelling
 *      `rm --recursive --force` was matched, so the short form every operator
 *      actually types went straight through.
 *  (3) SHELL GROUPING disarmed the fences that DID ship. `splitShellSegments`
 *      never treats `(`/`{` as separators, so a grouped command stayed one
 *      segment whose leading token was `(git` — unrecognised by
 *      `parseGitInvocation`, invisible to every lane dispatching on `g.sub`.
 *
 * HOW IT DISCRIMINATES — BIPOLAR, PER ARM. Every arm carries BOTH poles, so a
 * fence that fires on everything fails just as loudly as one that fires on
 * nothing:
 *   - a FIRING pole asserting the failure IDENTITY (the rule marker AND the
 *     RESOLVED TARGET PATH AND the named lost file) — never a bare exit code,
 *     which a fence firing for an unrelated reason would satisfy;
 *   - a STAYING-SILENT pole for the safe form of the same verb;
 *   - a FAIL-OPEN pole asserting INDETERMINATE is REPORTED, never read as clean.
 *
 * THE TWO PROPERTIES THE CASES ARE BUILT AROUND, both prior MEASURED defects:
 *
 *   TARGET, NEVER `HEAD`. The fence assesses the COMMAND'S OPERAND. A prior
 *   instance swept `HEAD` while the command named another target and returned
 *   18 bytes of silence while 11 unlanded artifacts were destroyed. The
 *   `target-not-cwd` case pins this: the operand names a DIRTY tree while the
 *   session cwd is a CLEAN one, so a cwd-sweeping implementation reports clean
 *   and reds here.
 *
 *   EMPTY IS NOT DIRTY. A `--no-checkout` worktree has NO index, so
 *   `git status --porcelain` reports a STAGED DELETION for every path in HEAD.
 *   A predicate that reads porcelain-non-empty as "has work" calls an EMPTY
 *   tree DIRTY — it cannot separate the two states, and a predicate that cannot
 *   separate them is not evidence (instrument-discipline.md MUST-1). The
 *   `nocheckout` case is built on a real `--no-checkout` worktree.
 *
 * NOTHING DESTRUCTIVE EVER RUNS. Every case drives the hook as a DECISION
 * FUNCTION over a synthetic sandbox — the candidate command string is delivered
 * on stdin as data and is never executed.
 *
 * Each case names the mutation that reds it; see README.md for the measured
 * mutation run.
 */
import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// ARM 11 asserts on the SELECTOR directly, not only through the hook: the
// phantom-target defect it pins is in `selectRmForce`'s token list, and the
// hook's rendered text does not always name a target that resolved to nothing.
const require_ = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const HOOK =
  process.env.DESTRUCTIVE_FORCE_HOOK ||
  path.join(REPO_ROOT, ".claude", "hooks", "validate-bash-command.js");

const { selectRmForce } = require_(
  path.join(REPO_ROOT, ".claude", "hooks", "lib", "destructive-force-target.js"),
);

// ---------------------------------------------------------------- sandbox
// realpath'd because macOS resolves /tmp -> /private/tmp, and the fence reports
// the REAL path. Comparing against the unresolved form would fail for a reason
// that has nothing to do with the behaviour under test.
const TMP = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "s60-force-")),
);
const REPO = path.join(TMP, "repo");
const WT_DIRTY = path.join(TMP, "wt-dirty");
const WT_CLEAN = path.join(TMP, "wt-clean");
const WT_NOCHECKOUT = path.join(TMP, "wt-nocheckout");
const PLAIN = path.join(TMP, "plain-dir");

const git = (args, cwd) =>
  spawnSync("git", args, { cwd, encoding: "utf8", timeout: 20000 });

fs.mkdirSync(REPO, { recursive: true });
git(["init", "-q", "-b", "main", "."], REPO);
git(["config", "user.email", "fixture@example.invalid"], REPO);
git(["config", "user.name", "fixture"], REPO);
fs.writeFileSync(path.join(REPO, "tracked.txt"), "a\n");
git(["add", "tracked.txt"], REPO);
git(["commit", "-qm", "init"], REPO);
git(["worktree", "add", "-q", WT_DIRTY, "-b", "b-dirty"], REPO);
git(["worktree", "add", "-q", WT_CLEAN, "-b", "b-clean"], REPO);
git(
  ["worktree", "add", "-q", "--no-checkout", WT_NOCHECKOUT, "-b", "b-nc"],
  REPO,
);
// The unlanded work the fence exists to name.
fs.writeFileSync(path.join(WT_DIRTY, "tracked.txt"), "MODIFIED\n");
fs.writeFileSync(path.join(WT_DIRTY, "untracked-work.txt"), "unlanded\n");
fs.mkdirSync(PLAIN, { recursive: true });
fs.writeFileSync(path.join(PLAIN, "f.txt"), "x\n");

// SANDBOX PRECONDITION. If the `--no-checkout` tree does not actually exhibit
// the empty-index-against-non-empty-HEAD signature, the `nocheckout` case below
// is vacuous — it would pass for a predicate that never implemented the
// separation at all. Asserted rather than assumed (instrument-discipline.md
// MUST-3(a): fire the instrument at a known-answer case first).
{
  const idx = git(["ls-files"], WT_NOCHECKOUT).stdout.split("\n").filter(Boolean);
  const head = git(["ls-tree", "-r", "--name-only", "HEAD"], WT_NOCHECKOUT)
    .stdout.split("\n")
    .filter(Boolean);
  const pc = git(
    ["status", "--porcelain", "--untracked-files=all"],
    WT_NOCHECKOUT,
  ).stdout;
  if (idx.length !== 0 || head.length === 0 || !/^D/m.test(pc)) {
    console.log(
      "destructive-force-guard: SANDBOX PRECONDITION FAILED — the --no-checkout " +
        `tree does not show the empty-index signature (idx=${idx.length} head=${head.length} porcelain=${JSON.stringify(pc)}). ` +
        "The empty-vs-dirty case would be vacuous; refusing to report a green.",
    );
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(1);
  }
}

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
  // "Validated" is the hook's generic PASS-THROUGH, not a finding. Reading
  // "context present" as "the fence spoke" cannot separate a finding from
  // silence — the non-discriminating instrument this suite must not become.
  const spoke = text.trim() !== "Validated" && text.trim() !== "";
  return { exit: r.status, text, spoke };
}

const RULE_MARKER = "worktree-isolation.md Rule 8";

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
  // `run-audit-fixtures.mjs` counts cases by matching `^\s*(PASS|ok)\s+\S` and
  // `^\s*(FAIL|not ok)\s+\S`, NOT by reading the summary below. A runner that
  // prints only a summary reports `0p/0f 0c` and trips the `min_cases`
  // anti-vacuity floor — measured here as `FAIL destructive-force-guard 0p/0f
  // 0c` while the same runner stood alone at 38/38.
  if (verdict === true) {
    pass += 1;
    console.log(`PASS ${id}`);
  } else {
    failures.push(`${id} (${verdict})`);
    console.log(`FAIL ${id}`);
    console.log(`     ${verdict}`);
  }
}

/** FIRING pole: assert the failure IDENTITY, never a bare exit code. */
function assertFires(res, { target, mentions = [] }) {
  if (!res.spoke) return "expected a finding, got SILENCE";
  if (!res.text.includes(RULE_MARKER)) {
    return `finding does not carry the rule marker ${JSON.stringify(RULE_MARKER)} — it may be an unrelated fence firing`;
  }
  if (target && !res.text.includes(target)) {
    return `finding does not name the RESOLVED TARGET ${target}`;
  }
  for (const m of mentions) {
    if (!res.text.includes(m)) return `finding does not mention ${m}`;
  }
  return true;
}
function assertSilent(res) {
  return res.spoke ? `expected SILENCE, got: ${res.text.slice(0, 200)}` : true;
}

// ======================================================= ARM 1: worktree --force
// Mutation that reds this arm: make selectWorktreeRemoveForce always return
// {force:false} (or drop the lane) -> every FIRING case below reds.

check("WT/force-dirty-fires", () =>
  assertFires(runHook(`git worktree remove --force ${WT_DIRTY}`), {
    target: WT_DIRTY,
    mentions: ["untracked-work.txt", "tracked.txt"],
  }),
);

check("WT/short-flag-fires", () =>
  assertFires(runHook(`git worktree remove -f ${WT_DIRTY}`), {
    target: WT_DIRTY,
    mentions: ["untracked-work.txt"],
  }),
);

// git's own getopt accepts bundled short flags, so a guard matching only a bare
// `-f` is disarmed by ONE extra character.
check("WT/bundled-flag-fires", () =>
  assertFires(runHook(`git worktree remove -fq ${WT_DIRTY}`), {
    target: WT_DIRTY,
  }),
);

// A guard matching only the LEADING flag position is disarmed by moving it.
check("WT/force-after-path-fires", () =>
  assertFires(runHook(`git worktree remove ${WT_DIRTY} --force`), {
    target: WT_DIRTY,
  }),
);

check("WT/double-dash-terminator-fires", () =>
  assertFires(runHook(`git worktree remove --force -- ${WT_DIRTY}`), {
    target: WT_DIRTY,
  }),
);

// SILENT POLE — the bare form is the SAFE one: git itself refuses a dirty tree,
// and that refusal is the mechanism. A fence firing here would be telling the
// operator not to use the safe spelling.
check("WT/bare-remove-silent", () =>
  assertSilent(runHook(`git worktree remove ${WT_DIRTY}`)),
);

// SILENT POLE — force-removing a tree with nothing unlanded costs nothing.
check("WT/force-clean-silent", () =>
  assertSilent(runHook(`git worktree remove --force ${WT_CLEAN}`)),
);

// SILENT POLE — EMPTY IS NOT DIRTY. Reds for any predicate that reads
// porcelain-non-empty as "has work": this tree's porcelain is NON-EMPTY
// (`D  tracked.txt`) while the tree holds nothing.
check("WT/nocheckout-empty-silent", () =>
  assertSilent(runHook(`git worktree remove --force ${WT_NOCHECKOUT}`)),
);

check("WT/nonexistent-silent", () =>
  assertSilent(
    runHook(`git worktree remove --force ${path.join(TMP, "no-such-tree")}`),
  ),
);

// FAIL-OPEN POLE — "I could not look" is REPORTED, never rendered as clean.
check("WT/unresolvable-target-reports-indeterminate", () => {
  const res = runHook(`git worktree remove --force $(cat ${TMP}/x)`);
  if (!res.spoke) return "expected an INDETERMINATE finding, got SILENCE";
  if (!/could NOT assess/.test(res.text)) {
    return `expected the finding to say the target could not be assessed, got: ${res.text.slice(0, 200)}`;
  }
  return true;
});

// The substitution must be reported INTACT. Pins the balanced-closer rule in
// stripShellGroupDelimiters: an unconditional trailing-`)` strip rewrote this
// to `$(cat …/x`, silently editing the inside of a command substitution.
check("WT/substitution-rendered-intact", () => {
  const res = runHook(`git worktree remove --force $(cat ${TMP}/x)`);
  return (
    res.text.includes(`$(cat ${TMP}/x)`) ||
    `the substitution was mangled in the report: ${res.text.slice(0, 220)}`
  );
});

// TARGET, NEVER CWD. cwd is the CLEAN worktree; the operand is the DIRTY one.
// A cwd-sweeping or HEAD-sweeping implementation reports clean and reds here.
check("WT/target-not-cwd", () =>
  assertFires(runHook(`git worktree remove --force ${WT_DIRTY}`, WT_CLEAN), {
    target: WT_DIRTY,
    mentions: ["untracked-work.txt"],
  }),
);

// `git -C <dir>` chdirs first, so a RELATIVE operand resolves against it.
check("WT/relative-operand-resolves-against-C", () =>
  assertFires(runHook(`git -C ${REPO} worktree remove --force ../wt-dirty`), {
    target: WT_DIRTY,
  }),
);

// ======================================================= ARM 2: rm -rf
// Mutation that reds this arm: make selectRmForce always return null -> every
// FIRING case below reds.

check("RM/rf-dirty-fires", () =>
  assertFires(runHook(`rm -rf ${WT_DIRTY}`), {
    target: WT_DIRTY,
    mentions: ["untracked-work.txt"],
  }),
);

check("RM/bundled-fr-fires", () =>
  assertFires(runHook(`rm -fr ${WT_DIRTY}`), { target: WT_DIRTY }),
);

// The LONG-flag spelling is caught EARLIER, by the pre-existing
// dangerous-pattern BLOCK arm ("Blocked: rm recursive/force with long flags"),
// which RETURNS before this lane runs. So the assertion here is BLOCKED, not
// this lane's identity — asserting the rule marker would red for a reason that
// has nothing to do with a regression. That asymmetry is the whole point of the
// short-flag cases above: the long form was the ONLY `rm` spelling fenced, and
// `rm -rf` — the form operators actually type — reached nothing.
check("RM/long-flags-blocked-by-preexisting-arm", () => {
  const res = runHook(`rm --recursive --force ${WT_DIRTY}`);
  if (res.exit !== 2) return `expected exit 2 BLOCK, got exit ${res.exit}`;
  return (
    /recursive\/force with long flags/.test(res.text) ||
    `blocked, but not by the long-flag arm: ${res.text.slice(0, 200)}`
  );
});

check("RM/sudo-wrapper-fires", () =>
  assertFires(runHook(`sudo rm -rf ${WT_DIRTY}`), { target: WT_DIRTY }),
);

// SILENT POLE — a non-recursive `rm -f <file>` deletes one named file the
// operator typed; it is not the whole-tree hazard git.md names.
check("RM/single-file-force-silent", () =>
  assertSilent(runHook(`rm -f ${path.join(PLAIN, "f.txt")}`)),
);

// SILENT POLE — outside any repo there is no unlanded work at stake. This is
// the anti-noise pole: a fence that halts on every build-directory cleanup gets
// switched off. Reds for an implementation that collapses "git said no" into
// "git did not answer" and reports INDETERMINATE here.
check("RM/non-repo-dir-silent", () => assertSilent(runHook(`rm -rf ${PLAIN}`)));

// FAIL-OPEN POLE.
check("RM/unresolvable-target-reports-indeterminate", () => {
  const res = runHook("rm -rf $TARGET_DIR");
  if (!res.spoke) return "expected an INDETERMINATE finding, got SILENCE";
  return (
    /could NOT assess/.test(res.text) ||
    `expected an unassessable-target finding, got: ${res.text.slice(0, 200)}`
  );
});

// ======================================================= ARM 3: embedded forms
// A guard matching only the LEADING token of a command is disarmed by trivial
// rewriting. Each of these was MEASURED SILENT before the fix.

check("EMB/after-and-and-fires", () =>
  assertFires(runHook(`git status && git worktree remove --force ${WT_DIRTY}`), {
    target: WT_DIRTY,
  }),
);

check("EMB/semicolon-fires", () =>
  assertFires(runHook(`cd /tmp ; git worktree remove --force ${WT_DIRTY}`), {
    target: WT_DIRTY,
  }),
);

check("EMB/newline-fires", () =>
  assertFires(runHook(`git status\ngit worktree remove --force ${WT_DIRTY}`), {
    target: WT_DIRTY,
  }),
);

check("EMB/bash-c-fires", () =>
  assertFires(runHook(`bash -c "git worktree remove --force ${WT_DIRTY}"`), {
    target: WT_DIRTY,
  }),
);

check("EMB/rm-after-and-and-fires", () =>
  assertFires(runHook(`git status && rm -rf ${WT_DIRTY}`), {
    target: WT_DIRTY,
  }),
);

check("EMB/rm-bash-c-fires", () =>
  assertFires(runHook(`bash -c "rm -rf ${WT_DIRTY}"`), { target: WT_DIRTY }),
);

// ======================================================= ARM 4: shell grouping
// The pre-existing bypass. These four reds pin `stripShellGroupDelimiters`, and
// the two `reset --hard` / `clean -fd` cases are the PARITY locks: those fences
// were ALREADY SHIPPED and were disarmed by one added keystroke.
// Mutation that reds this arm: make stripShellGroupDelimiters the identity fn.

check("GRP/subshell-worktree-force-fires", () =>
  assertFires(runHook(`(git worktree remove --force ${WT_DIRTY})`), {
    target: WT_DIRTY,
  }),
);

check("GRP/subshell-spaced-fires", () =>
  assertFires(runHook(`( git worktree remove --force ${WT_DIRTY} )`), {
    target: WT_DIRTY,
  }),
);

check("GRP/brace-group-worktree-force-fires", () =>
  assertFires(runHook(`{ git worktree remove --force ${WT_DIRTY}; }`), {
    target: WT_DIRTY,
  }),
);

check("GRP/subshell-rm-fires", () =>
  assertFires(runHook(`(rm -rf ${WT_DIRTY})`), { target: WT_DIRTY }),
);

// PARITY LOCK — the shipped `reset --hard` fence, grouped. It BLOCKS (exit 2)
// unwrapped; before the fix the grouped form exited 0 SILENT.
check("GRP/subshell-reset-hard-still-blocks", () => {
  const res = runHook(`(git -C ${WT_DIRTY} reset --hard HEAD)`);
  if (res.exit !== 2) return `expected exit 2 BLOCK, got exit ${res.exit}`;
  return (
    res.text.includes("reset --hard") ||
    `blocked, but not by the reset fence: ${res.text.slice(0, 200)}`
  );
});

// PARITY LOCK — the shipped `clean -f` fence, grouped.
check("GRP/subshell-clean-still-blocks", () => {
  const res = runHook(`(git -C ${WT_DIRTY} clean -fd)`);
  if (res.exit !== 2) return `expected exit 2 BLOCK, got exit ${res.exit}`;
  return (
    res.text.includes("clean") ||
    `blocked, but not by the clean fence: ${res.text.slice(0, 200)}`
  );
});

check("GRP/brace-group-reset-hard-still-blocks", () => {
  const res = runHook(`{ git -C ${WT_DIRTY} reset --hard HEAD; }`);
  return res.exit === 2 || `expected exit 2 BLOCK, got exit ${res.exit}`;
});

// CONTROL — the same fence UNWRAPPED. If this ever stops blocking, the grouped
// cases above are measuring nothing and their green is meaningless
// (instrument-discipline.md MUST-3(a)).
check("GRP/control-plain-reset-hard-blocks", () => {
  const res = runHook(`git -C ${WT_DIRTY} reset --hard HEAD`);
  return res.exit === 2 || `CONTROL FAILED: expected exit 2, got ${res.exit}`;
});

// ======================================================= ARM 5: deferral contract
// The finding is DEFERRED, never RETURNED. A `halt-and-report` return would
// suppress every `block` fence below it — the loom#1606 defect class. Here the
// `block` must still win AND this fence's finding must still ride out.
check("DEFER/block-below-still-wins-and-finding-rides-out", () => {
  const res = runHook(`rm -rf ${WT_DIRTY} && git -C ${WT_DIRTY} reset --hard HEAD`);
  if (res.exit !== 2) {
    return `expected the block below to win (exit 2), got exit ${res.exit} — the finding was returned instead of deferred`;
  }
  if (!res.text.includes(RULE_MARKER)) {
    return "the block won but the destructive-force finding was DESTROYED rather than merged";
  }
  return true;
});

// ======================================================= ARM 6: no-false-positive
// Read-only worktree verbs must stay silent. A fence that promotes an
// INSPECTION into a destructive verdict is noise.
check("NFP/worktree-list-silent", () =>
  assertSilent(runHook("git worktree list --porcelain")),
);
check("NFP/worktree-prune-silent", () => assertSilent(runHook("git worktree prune")));
check("NFP/git-status-silent", () => assertSilent(runHook("git status")));

// ======================================================= ARM 7: PATH DANGER (loom s67)
//
// The dimension `assessTarget` cannot see. It answers "what unlanded GIT WORK
// is at this path?"; the fence read that as "is destroying this path safe?".
// MEASURED on main before this arm existed, with both poles controlled:
// `/`, `/usr`, `$HOME`, the orchestration root and the system temp root ALL
// assessed CLEAN — because a path with no repository in it has no unlanded
// work in it — while two dirty-tree controls fired. So the CLEAN verdicts were
// real answers to the WRONG QUESTION, and `clean` meant SILENCE at the call
// site. Origin: an agent ran `rm -rf /private/var/folders` past this fence.
//
// Mutation that reds this arm: make `classifyPathDanger` return
// `{tier:"ordinary"}` unconditionally -> every FIRING case below reds while
// ARMS 1-6 stay green, which is what makes this a SEPARATE dimension and not a
// restatement of the git-content one.
const DANGER_MARKER = "CATASTROPHIC target";

/** FIRING pole for the danger dimension: assert identity, never a bare exit. */
function assertCatastrophic(res, target) {
  if (!res.spoke) return "expected a CRITICAL finding, got SILENCE";
  if (!res.text.includes(DANGER_MARKER)) {
    return `finding does not carry ${JSON.stringify(DANGER_MARKER)} — another fence may be firing instead`;
  }
  if (target && !res.text.includes(target)) {
    return `finding does not name the RESOLVED TARGET ${target}`;
  }
  return true;
}

const FS_ROOT = path.parse(REPO).root;
const TMPROOT = fs.realpathSync(os.tmpdir());
const HOME = fs.realpathSync(os.homedir());

// --- CRITICAL: catastrophic targets that the git dimension calls CLEAN ------
// OWNERSHIP, measured rather than assumed: `rm -rf /` is caught by the hook's
// PRE-EXISTING "rm on root filesystem" pattern, which fires BEFORE this
// dimension is reached, so this case asserts the SAFETY PROPERTY (blocked) and
// deliberately does NOT assert the danger marker — that would assert the wrong
// owner and would red if the older fence were ever hardened further.
//
// That older pattern is also WHY this dimension was needed: measured, it
// matches the literal root and nothing else, so `$HOME`, the orchestration
// root and the system temp root all fell straight through it. A positive
// enumeration of dangerous paths cannot enumerate a filesystem — the same
// shape as the #1966 allowlist that opened 13 fail-open holes.
check("DANGER/filesystem-root-blocks", () => {
  const res = runHook(`rm -rf ${FS_ROOT}`, REPO);
  if (!res.spoke) return "expected root-filesystem removal to be REFUSED, got SILENCE";
  return /root filesystem|CATASTROPHIC target/.test(res.text)
    ? true
    : `refused, but by no recognised fence: ${res.text.slice(0, 160)}`;
});
check("DANGER/system-dir-blocks", () =>
  assertCatastrophic(runHook("rm -rf /usr", REPO), "/usr"),
);
// THE INCIDENT: the system scratch ROOT. Being INSIDE it is ordinary (below);
// BEING it is catastrophic. That distinction is the whole fix.
check("DANGER/tmpdir-root-blocks", () =>
  assertCatastrophic(runHook(`rm -rf ${TMPROOT}`, REPO), TMPROOT),
);
check("DANGER/home-blocks", () =>
  assertCatastrophic(runHook(`rm -rf ${HOME}`, REPO), HOME),
);
// Deleting the directory that CONTAINS your working tree takes every repo and
// worktree beneath it, and is catastrophic even inside a scratch area.
check("DANGER/parent-of-cwd-blocks", () =>
  assertCatastrophic(runHook(`rm -rf ${TMP}`, REPO), TMP),
);
// ENFORCEMENT-SURFACE PARITY (security.md): the OTHER destructive verb must
// learn the same dimension through the same shared function, or the two
// surfaces drift the next time one is hardened.
check("DANGER/parity-worktree-force-on-root-blocks", () =>
  assertCatastrophic(runHook(`git worktree remove --force ${FS_ROOT}`, REPO), FS_ROOT),
);

// --- NO FALSE POSITIVES: the everyday cases MUST stay silent ---------------
// A fence that trips on `rm -rf` of a mktemp dir or a build directory is
// noise, and noise is how a guard gets switched off.
check("DANGER/NFP/inside-tmpdir-silent", () =>
  assertSilent(runHook(`rm -rf ${path.join(TMPROOT, "s67-scratch-example")}`, REPO)),
);
check("DANGER/NFP/build-dir-in-repo-silent", () =>
  assertSilent(runHook(`rm -rf ${path.join(REPO, "node_modules")}`, REPO)),
);
check("DANGER/NFP/plain-dir-in-sandbox-silent", () =>
  assertSilent(runHook(`rm -rf ${PLAIN}`, REPO)),
);

// --- The shallow-path rule and its GIT-REPO EXEMPTION (owner-ratified s67) --
// A target 1-2 levels below `/` is normally CRITICAL. A shallow path that IS a
// git repository DE-ESCALATES to ELEVATED, so a machine whose repos live at
// `/work/repo` is not left with a no-escape-hatch block — it must still SPEAK
// (deleting a whole repo is a hazard worth naming) but must not refuse.
//
// ARM 1 — the CRITICAL half, always runs. `/Users/Shared` (POSIX) is a real
// depth-2 path that is NOT a repo and NOT scratch, and asserting on it needs NO
// writes anywhere. This is the control proving the depth rule still bites.
const SHALLOW_NONREPO = process.platform === "darwin" ? "/Users/Shared" : "/srv";
if (fs.existsSync(SHALLOW_NONREPO)) {
  check("DANGER/shallow-non-repo-blocks", () =>
    assertCatastrophic(runHook(`rm -rf ${SHALLOW_NONREPO}`, REPO), SHALLOW_NONREPO),
  );
} else {
  console.log(`SKIP DANGER/shallow-non-repo-blocks (no ${SHALLOW_NONREPO} here)`);
}

// ARM 2 — the EXEMPTION half. Needs a real git repo AT a depth<=2 path, which
// requires a writable filesystem root. macOS ships a READ-ONLY root, so this
// SKIPS LOUDLY there rather than degrading to a deeper path — a fixture that
// silently substitutes a different path would assert a different branch and
// report green for coverage it never had. It SELF-ACTIVATES wherever the root
// is writable (most Linux CI containers), so the arm is not permanently dark.
const SHALLOW_REPO = "/s67fixture";
let shallowRepoReady = false;
try {
  fs.mkdirSync(SHALLOW_REPO, { recursive: true });
  git(["init", "-q", "."], SHALLOW_REPO);
  shallowRepoReady = fs.existsSync(path.join(SHALLOW_REPO, ".git"));
} catch {
  shallowRepoReady = false;
}

if (shallowRepoReady) {
  check("DANGER/shallow-git-repo-de-escalates-to-elevated", () => {
    const res = runHook(`rm -rf ${SHALLOW_REPO}`, REPO);
    if (!res.spoke) return "expected ELEVATED (halt-and-report), got SILENCE";
    if (res.text.includes(DANGER_MARKER)) {
      return "expected ELEVATED, got the CRITICAL block — the git-repo exemption did not apply";
    }
    return /shallow enough to be a whole repository/.test(res.text)
      ? true
      : `spoke, but not with the shallow-repo reason: ${res.text.slice(0, 160)}`;
  });
  try {
    fs.rmSync(SHALLOW_REPO, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
} else {
  console.log(
    "SKIP DANGER/shallow-git-repo-de-escalates-to-elevated — needs a writable filesystem root " +
      "(macOS root is read-only). NOT evidence the exemption works; it is UNVERIFIED here.",
  );
}

// --- ARM 8: WRAPPER PARITY + FUSED COMMAND WORD (s68) ----------------------
// The #1975 adversarial security review found `selectRmForce` walking a PRIVATE
// 6-element wrapper set while the shared `GIT_WRAPPERS` carried 14, so every
// wrapper below made the fence return null and go SILENT on the exact
// catastrophic targets the arms above assert on. Those arms could not see it:
// none of them puts a wrapper in front of `rm`, so their green was identical
// before and after the defect (`instrument-discipline.md` MUST-2(a)).
//
// Mutation that reds this arm: restore the private WRAPPERS set in
// `selectRmForce`. Every FIRING case below reverts to SILENCE while the arms
// above stay green — which is what makes this a separate dimension rather than
// a restatement of the depth rule.
const WRAPPED = ["timeout 300", "nice -n 19", "setsid", "ionice -c3", "stdbuf -o0"];
for (const w of WRAPPED) {
  const tag = w.split(" ")[0];
  check(`DANGER/wrapper-${tag}-still-blocks`, () =>
    assertCatastrophic(runHook(`${w} rm -rf ${HOME}`, REPO), HOME),
  );
}

// `xargs` takes its operand on STDIN, so the segment carries NO readable
// target. Silence there is a live recursive force-delete the fence never named;
// the correct verdict is INDETERMINATE (it must SPEAK), not a target claim.
check("DANGER/xargs-stdin-fed-speaks", () => {
  const res = runHook("echo /Users | xargs rm -rf", REPO);
  return res.spoke ? true : "expected an INDETERMINATE finding for a stdin-fed rm, got SILENCE";
});

// A command word fused into an expansion (`rm$IFS-rf$IFS/path`) is ONE token:
// the flags and the operand never appear as tokens of their own. Positive
// evidence of rm + an unreadable operand list MUST speak.
check("DANGER/fused-command-word-speaks", () => {
  const res = runHook("rm$IFS-rf$IFS/Users/someoperator", REPO);
  return res.spoke ? true : "expected a finding for a fused `rm` command word, got SILENCE";
});

// NO FALSE POSITIVES for this arm. The match is equality-on-basename plus a
// negative lookahead, so none of these may fire — a wrapper-aware walk widened
// into substring matching would red here while the FIRING cases above stayed
// green, which is the mutation this pole exists to catch.
check("DANGER/NFP/fused-rmdir-silent", () =>
  assertSilent(runHook("rmdir$IFS/Users/someoperator", REPO)),
);
check("DANGER/NFP/substituted-non-rm-silent", () =>
  assertSilent(runHook("$(echo ls) -la /Users", REPO)),
);
check("DANGER/NFP/wrapper-then-non-rm-silent", () =>
  assertSilent(runHook(`timeout 300 ls -la ${HOME}`, REPO)),
);

// --- ARM 9: COMMITTED BUT ON NO REMOTE (F5 of the #1975 review) ------------
// `assessTarget` ran three probes — `status --porcelain`, `ls-files`,
// `ls-tree HEAD` — and every one asks only about UNCOMMITTED content. A tree
// whose work was COMMITTED but never pushed therefore reported CLEAN, the call
// site's `state !== DIRTY` short-circuit skipped it, and the fence said NOTHING
// while the operator destroyed the only copy. Measured on a live case before
// this arm was written: a worktree on a detached HEAD carrying 188 insertions,
// present on no remote and no branch, drew SILENCE.
//
// ARMS 1-8 could not have caught it: every one of their at-risk cases is DIRTY
// in the porcelain sense, so their green was identical before and after
// (`instrument-discipline.md` MUST-2(a)).
//
// The sandbox needs a REAL remote, because the probe's discrimination depends
// on one: see the no-remote pole below.
const BARE = path.join(TMP, "origin.git");
const CLONE = path.join(TMP, "clone");
git(["init", "-q", "--bare", BARE], TMP);
git(["clone", "-q", BARE, CLONE], TMP);
git(["config", "user.email", "t@t"], CLONE);
git(["config", "user.name", "t"], CLONE);
fs.writeFileSync(path.join(CLONE, "a.txt"), "one\n");
git(["add", "-A"], CLONE);
git(["commit", "-qm", "pushed"], CLONE);
git(["push", "-q", "origin", "HEAD"], CLONE);

// SANDBOX PRECONDITION, asserted not assumed (instrument-discipline.md
// MUST-3(a)). If the clone is not genuinely synced at this point the SILENT
// pole below is vacuous — it would pass for a predicate that never ran.
{
  const n = git(["rev-list", "--count", "HEAD", "--not", "--remotes"], CLONE)
    .stdout.trim();
  const tree = git(["status", "--porcelain"], CLONE).stdout.trim();
  if (n !== "0" || tree !== "") {
    console.log(
      "destructive-force-guard: SANDBOX PRECONDITION FAILED — the freshly-pushed " +
        `clone is not synced-and-clean (unpushed=${n} porcelain=${JSON.stringify(tree)}). ` +
        "The no-false-positive pole would be vacuous; refusing to report a green.",
    );
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(1);
  }
}

// POLE A — synced and clean: MUST stay silent. This is the pole that fails if
// the probe is written to count unmerged rather than unpushed commits.
check("DANGER/NFP/synced-clean-clone-silent", () =>
  assertSilent(runHook(`rm -rf ${CLONE}`, REPO)),
);

// POLE B — the finding. One commit made and NOT pushed; the working tree is
// left CLEAN on purpose, so the only thing at stake is the commit itself.
fs.writeFileSync(path.join(CLONE, "b.txt"), "two\n");
git(["add", "-A"], CLONE);
git(["commit", "-qm", "local only"], CLONE);
check("DANGER/unpushed-commit-on-clean-tree-speaks", () => {
  const res = runHook(`rm -rf ${CLONE}`, REPO);
  if (!res.spoke) return "expected a finding for a clean tree holding an unpushed commit, got SILENCE";
  return /on NO remote/.test(res.text)
    ? true
    : `spoke, but not with the unpushed-commit finding: ${res.text.slice(0, 160)}`;
});

// POLE C — the PRECONDITION pole. A repo with NO remote at all: `--not
// --remotes` subtracts nothing there and would count EVERY commit, reporting a
// pristine scratch repo as entirely unpushed. Measured: without the
// `git remote` guard this exact case fired, and it reds this pole while POLE B
// stays green — which is what makes the guard a separate property and not a
// restatement.
check("DANGER/NFP/no-remote-repo-silent", () =>
  assertSilent(runHook(`rm -rf ${WT_CLEAN}`, REPO)),
);

// --- ARM 11: SHELL REDIRECTIONS ARE NOT DELETION TARGETS -------------------
// `selectRmForce` called the SHARED `tokenize` but not the redirection filter,
// so `rm -rf /tmp/scratch >/dev/null 2>&1` reported THREE targets: the real
// path plus `>/dev/null` and `2>&1`. Both phantoms resolve to nothing, so the
// operator was handed two INDETERMINATE rows on every redirected `rm` — the
// same inflated-target-count symptom that produced this sweep in the sibling
// guard one module over. `tokenize` is EXPORTED, which is exactly how a call
// site outside the parser module was left on the unqualified signature
// (`security.md` § Multi-Site Kwarg Plumbing).
//
// Mutation that reds this arm: drop `stripRedirectionTokens` from
// `selectRmForce`. Every case below regains its phantom targets while ARMS 1-10
// stay green — none of them puts a redirection in the command, so their green
// was identical before and after the defect (`instrument-discipline.md`
// MUST-2(a)).
for (const [tag, suffix] of [
  ["dup-fd", "2>&1"],
  ["null-and-dup-fd", ">/dev/null 2>&1"],
  ["append", ">> /tmp/rm.log"],
  ["stdin", "< /dev/null"],
]) {
  check(`DANGER/redirect-${tag}-names-only-the-real-target`, () => {
    const got = selectRmForce(`rm -rf ${HOME} ${suffix}`);
    if (!got) return `expected a selection for a forced rm; got ${JSON.stringify(got)}`;
    return (
      (got.targets.length === 1 && got.targets[0] === HOME) ||
      `'${suffix}' is shell plumbing, never an operand; got ${JSON.stringify(got.targets)}`
    );
  });
}
// The NO-FALSE-STRIP pole, and it is the half a value-matching fix fails. A
// QUOTED operand that merely LOOKS like a redirection is a real path, and after
// the tokenizer consumes quotes it carries the identical token value — so a fix
// filtering on the value would delete it. Stripping a real deletion target is
// worse than naming a phantom: it is the fence going quiet about the thing it
// exists to name.
check("DANGER/NFP/quoted-redirect-lookalike-is-a-real-target", () => {
  const got = selectRmForce('rm -rf "2>&1"');
  if (!got) return "a quoted operand must still select; got null";
  return (
    (got.targets.length === 1 && got.targets[0] === "2>&1") ||
    `a QUOTED 2>&1 is a path and MUST survive; got ${JSON.stringify(got.targets)}`
  );
});
// Process substitution expands to a `/dev/fd/N` ARGUMENT, not a redirection.
// The recognizer excludes it explicitly; without that exclusion the leading
// bracket matched and half the operand vanished.
check("DANGER/NFP/process-substitution-operand-survives", () => {
  const got = selectRmForce("rm -rf <(echo x)");
  if (!got) return "expected a selection; got null";
  return (
    got.targets.some((t) => t.includes("<(")) ||
    `process substitution is an operand, not plumbing; got ${JSON.stringify(got.targets)}`
  );
});

fs.rmSync(TMP, { recursive: true, force: true });

const total = pass + failures.length;
console.log(`\ndestructive-force-guard: ${pass}/${total} PASS`);
if (failures.length > 0) {
  console.log(`FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
