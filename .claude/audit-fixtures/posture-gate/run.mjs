#!/usr/bin/env node
/**
 * posture-gate audit fixtures — executing consumer.
 *
 * Drives the SHIPPED `.claude/hooks/posture-gate.js` as a decision function over
 * a real PreToolUse payload. Nothing is stubbed and no trust state is planted:
 * every row is decided by the gate's own code.
 *
 * THREE arms, each BIPOLAR, and every RED pole asserts a failure IDENTITY rather
 * than a boolean (`instrument-bipolarity.md` MUST-2):
 *
 *   A. mutation-verb fence / VALUE_FLAGS — the arm that had no consumer at all,
 *      which is why six mis-listed boolean flags shipped AND four consuming ones
 *      were missing. Identity = the fence naming the VERB it refused
 *      ("git commit BLOCKED at L1_PSEUDO_AGENT"), so a row cannot go green on
 *      some other refusal that merely also blocked.
 *
 *   B. R6-C-02 protected-path fence across mutation TOOLS (the predicate the
 *      prose fixture `flag-multiedit-blocked.txt` states).
 *
 *   C. R6-C-02 realpath normalization vs. traversal (the predicate the prose
 *      fixture `flag-realpath-traversal.txt` states).
 *
 * WHY THE IDENTITY ASSERTION IS LOAD-BEARING, not ceremony. An earlier revision
 * of this file asserted only "did the hook say anything", and claimed in this
 * header that arms B/C were "posture-independent by construction". That claim
 * was FALSE for the CLEAN poles and is withdrawn. R6-C-02 is evaluated before
 * the posture read, so the FLAG poles are indeed posture-independent — but a
 * clean pole (an Edit on an UNPROTECTED path) is refused outright by the L1/L2
 * mutation-TOOL fence, so under a degraded posture both clean poles would RED
 * while both flag arms went green for the wrong cause. MEASURED: an Edit on an
 * unprotected path with an unresolvable cwd returns {"continue":false}, exit 2,
 * "Edit BLOCKED at L1_PSEUDO_AGENT".
 *
 * Asserting WHICH fence fired removes the dependency entirely: a posture refusal
 * carries `trust-posture/L<n>` + "BLOCKED at", R6-C-02 carries "Defense-in-depth"
 * + "(R6-C-02)". They are never confusable, so arms B/C are now genuinely
 * independent of the ambient posture WITHOUT planting a posture.json — which is
 * also why this runner touches no trust state at all.
 *
 * ARM A pins its posture deterministically the other way: a plain temp dir makes
 * `resolveStateDirDetailed()` report INDETERMINATE and `readPosture` fail-close
 * to L1, so the mutation-verb fence is reachable with nothing planted.
 *
 * CAVEAT, recorded rather than implied: `readPosture` calls
 * `migrateWitnessIfPresent(repoRoot)`, a best-effort legacy-witness RENAME. Arms
 * B/C pass `cwd: REPO`, so that path executes against the real repository. It is
 * a no-op today (no legacy witness exists) and is what every session already
 * does on every hook invocation — but it is a write path, so it is named here
 * rather than left under a blanket "nothing is planted".
 */
import "../_lib/no-ambient-git.cjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const HOOK = path.join(REPO, ".claude", "hooks", "posture-gate.js");
const TMP_CWD = mkdtempSync(path.join(tmpdir(), "posture-gate-fx-"));

let pass = 0;
let fail = 0;

function drive(payload) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 20000,
  });
  let ctx = "";
  let blocked = false;
  let denied = false;
  try {
    const j = JSON.parse((r.stdout || "").trim());
    // A refusal is the DENY decision at exit 2. `continue:false` is no longer emitted: it
    // ended the agent's turn instead of refusing the call.
    blocked = r.status === 2 && j?.hookSpecificOutput?.permissionDecision === "deny";
    const h = j?.hookSpecificOutput ?? {};
    denied = h.permissionDecision === "deny";
    // BOTH envelope fields, because the two severities do not share one.
    // MEASURED: `block` renders into `permissionDecisionReason` alongside
    // `permissionDecision: "deny"`; `halt-and-report` renders into
    // `additionalContext` with `continue: true` and no decision field. An
    // earlier revision read `additionalContext` alone, so every block-severity
    // row reported an EMPTY identity and 13 arm-A rows failed while the gate
    // was behaving correctly — the same one-field blindness that made the very
    // first version of this runner misread arms B/C in the other direction.
    ctx = h.additionalContext ?? h.permissionDecisionReason ?? "";
  } catch {
    /* non-JSON stdout => the gate passed the call through */
  }
  // The payload's own fields, parsed back out of the rendered body. These are
  // what carry the IDENTITY; `blocked` alone is a quantity.
  const what = (ctx.match(/^WHAT HAPPENED: (.*)$/m) || [, ""])[1];
  const why = (ctx.match(/^WHY: (.*)$/m) || [, ""])[1];
  return { blocked, denied, reported: blocked || ctx.length > 0, what, why, exit: r.status };
}

/**
 * Did the MUTATION-VERB fence refuse this call, naming this verb?
 * Identity: severity `block` (continue:false) + a `trust-posture/L<n>` reason +
 * a what-happened naming the parsed verb. `git commit BLOCKED at L1_…`.
 */
function firedVerbFence(r, verb) {
  return (
    r.blocked &&
    r.denied &&
    /^trust-posture\/L\d/.test(r.why) &&
    new RegExp(`^${verb} BLOCKED at L\\d`).test(r.what)
  );
}

/**
 * Did the R6-C-02 protected-path fence fire?
 * Identity: the reason cites R6-C-02 AND the reserved-for-hooks contract, and
 * the what-happened is the defense-in-depth line. Deliberately does NOT look at
 * `blocked`: R6-C-02 is `halt-and-report` by an explicit decision recorded at
 * its emit site, so asserting a refusal here would pin the WRONG severity — the
 * one the hook's own comment says it declines to promote.
 */
function firedR6C02(r) {
  return (
    /R6-C-02/.test(r.why) &&
    /writes are reserved for hooks/.test(r.why) &&
    /^Defense-in-depth:/.test(r.what)
  );
}

function check(name, got, want, note) {
  if (got === want) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} — got ${got}, want ${want} (${note})`);
  }
}

const bash = (command) =>
  drive({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    cwd: TMP_CWD,
  });

const tool = (tool_name, file_path, extra = {}) =>
  drive({
    hook_event_name: "PreToolUse",
    tool_name,
    tool_input: { file_path, ...extra },
    cwd: REPO,
  });

// ---------------------------------------------------------------- arm A ----
console.log("arm A — mutation-verb fence / VALUE_FLAGS");

// CONTROLS FIRST, both directions, so a later silence is readable.
check("A-ctrl/plain-commit-dry-run-quiet", firedVerbFence(bash("git commit --dry-run"), "git commit"), false, "--dry-run is non-mutating");
check("A-ctrl/plain-push-dry-run-quiet", firedVerbFence(bash("git push --dry-run"), "git push"), false, "--dry-run is non-mutating");
check("A-ctrl/real-commit-fires", firedVerbFence(bash('git commit -m "real commit"'), "git commit"), true, "a real mutation must be refused BY THE VERB FENCE");
check("A-ctrl/real-push-fires", firedVerbFence(bash("git push origin main"), "git push"), true, "a real mutation must be refused BY THE VERB FENCE");
check("A-ctrl/message-is-not-a-flag", firedVerbFence(bash('git commit -m "fix the --dry-run bug"'), "git commit"), true, "-m must eat its message");
check("A-ctrl/non-git-quiet", firedVerbFence(bash("echo hello"), "git commit"), false, "not a fenced verb");

// THE SIX BOOLEAN FLAGS — separated form consumes nothing, so --dry-run must be
// SEEN and the command must NOT be refused.
for (const [cmd, verb] of [
  ["git commit -S --dry-run", "git commit"],
  ["git commit --gpg-sign --dry-run", "git commit"],
  ["git commit -u --dry-run", "git commit"],
  ["git commit --untracked-files --dry-run", "git commit"],
  ["git push --force-with-lease --dry-run", "git push"],
  ["git push --signed --dry-run", "git push"],
]) {
  check(`A-bool/${cmd.replace(/\s+/g, "_")}`, firedVerbFence(bash(cmd), verb), false, "separated form consumes nothing");
}

// THE DANGEROUS DIRECTION — the one the A-bool rows do NOT pin. Under the OLD
// table `-S` skipped `-m`, exposing the MESSAGE as a flag, so isNonMutating
// returned true and a REAL COMMIT was allowed at L3/L2/L1. This row reds if any
// boolean flag is ever re-added to VALUE_FLAGS.
for (const cmd of [
  'git commit -S -m "--dry-run"',
  'git commit --gpg-sign -m "--dry-run"',
  'git push --force-with-lease --repo "--dry-run" origin main',
]) {
  const verb = cmd.startsWith("git push") ? "git push" : "git commit";
  check(`A-bypass/${cmd.replace(/\s+/g, "_")}`, firedVerbFence(bash(cmd), verb), true, "a value must never be read as a flag");
}

// ATTACHED forms are single tokens and must stay unrefused.
for (const [cmd, verb] of [
  ["git commit -Skeyid --dry-run", "git commit"],
  ["git commit --gpg-sign=keyid --dry-run", "git commit"],
  ["git commit --untracked-files=all --dry-run", "git commit"],
  ["git push --force-with-lease=main:abc --dry-run", "git push"],
]) {
  check(`A-attached/${cmd.replace(/\s+/g, "_")}`, firedVerbFence(bash(cmd), verb), false, "attached value is one token");
}

// THE `-n` SPLIT the NON_MUTATING_FLAGS comment calls load-bearing: `-n` is
// --no-verify on commit (which COMMITS) and --dry-run on push (which does not).
// One shared marker list would get exactly one of these wrong.
check("A-nsplit/commit-n-is-no-verify", firedVerbFence(bash('git commit -n -m x'), "git commit"), true, "commit -n still commits");
check("A-nsplit/push-n-is-dry-run", firedVerbFence(bash("git push -n origin main"), "git push"), false, "push -n is a dry run");

// VALUE-CONSUMING entries must still eat their argument, or removing the six
// would have opened the hole the table exists to close.
for (const [cmd, verb] of [
  ["git commit -F --dry-run", "git commit"],
  ["git push -o --dry-run origin main", "git push"],
  // the four the closure census added
  ["git commit --unified --dry-run", "git commit"],
  ["git commit -U --dry-run", "git commit"],
  ["git commit --inter-hunk-context --dry-run", "git commit"],
  ["git push --recurse-submodules --dry-run origin main", "git push"],
]) {
  check(`A-value/${cmd.replace(/\s+/g, "_")}`, firedVerbFence(bash(cmd), verb), true, "the flag eats --dry-run, so this mutates");
}

// ---------------------------------------------------------------- arm B ----
// the predicate `flag-multiedit-blocked.txt` states: R6-C-02 covers MultiEdit
// and NotebookEdit as well as Edit/Write, at halt-and-report, citing the
// reserved-for-hooks reason. Asserted by IDENTITY, so the ambient posture of
// REPO cannot decide these rows.
console.log("arm B — R6-C-02 protected-path fence across mutation tools");
const PROT = path.join(REPO, ".claude", "learning", "posture.json");
const VIOL = path.join(REPO, ".claude", "learning", "violations.jsonl");
check("B-flag/MultiEdit-on-posture-json", firedR6C02(tool("MultiEdit", PROT, { edits: [{ old_string: "L1_PSEUDO_AGENT", new_string: "L5_DELEGATED" }] })), true, "MultiEdit must not bypass the secondary fence");
check("B-flag/NotebookEdit-on-posture-json", firedR6C02(drive({ hook_event_name: "PreToolUse", tool_name: "NotebookEdit", tool_input: { notebook_path: PROT }, cwd: REPO })), true, "notebook_path is the payload key here");
check("B-flag/Edit-on-posture-json", firedR6C02(tool("Edit", PROT)), true, "the original fenced tool");
check("B-flag/Write-on-violations-jsonl", firedR6C02(tool("Write", VIOL, { content: "{}" })), true, "violations.jsonl is protected too");
check("B-clean/Edit-on-unprotected-path", firedR6C02(tool("Edit", path.join(REPO, "README.md"))), false, "ordinary file — R6-C-02 must NOT fire (whatever the posture gate does)");

// ---------------------------------------------------------------- arm C ----
// the predicate `flag-realpath-traversal.txt` states: normalize BEFORE matching.
console.log("arm C — R6-C-02 realpath normalization vs. traversal");
check("C-flag/traversal-into-posture-json", firedR6C02(tool("Edit", path.join(REPO, ".claude", "foo", "..", "learning", "posture.json"))), true, "must normalize, not test the literal string");
check("C-flag/deep-traversal-into-posture-json", firedR6C02(tool("Edit", path.join(REPO, ".claude", "learning", "..", "..", ".claude", "learning", "posture.json"))), true, "normalization must survive multiple hops");
check("C-clean/traversal-landing-outside", firedR6C02(tool("Edit", path.join(REPO, ".claude", "learning", "..", "..", "README.md"))), false, "normalizes to an unprotected path");

console.log(`\nposture-gate fixtures: ${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
