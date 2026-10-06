#!/usr/bin/env node
/**
 * Audit-fixture runner for `.claude/hooks/lib/dispatch-contract.js` — the dispatch-contract guard's
 * pure predicates (`orchestrator-context-economy.md` MUST-5 + MUST-6), shipped WITH the detector
 * per `cc-artifacts.md` Rule 9.
 *
 * Coverage shape is ONE CASE PER SCOPE-RESTRICTION PREDICATE — the predicates a wrong edit would
 * silently widen or narrow:
 *
 *   1  what counts as a NAMED dispatch (the MUST-6 gate)
 *   2  what counts as an explicit push-delivery instruction
 *   3  what counts as WRITE INTENT in a brief
 *   4  the READ-ONLY scope arm that WITHDRAWS a write-intent match
 *   5  which declared tool sets can write
 *   6  the UNKNOWN arm — an agent type with no file must fail OPEN, not closed
 *   7  frontmatter parsing: what makes a record usable at all
 *   8  which TOOLS are inspected at all
 *   9  the empty/absent-prompt fail-open arm
 *  10  evidence bounding
 *  11  the on-disk inventory actually resolves this repo's agents
 *  12  severity is capped below `block` (hook-output-discipline.md MUST-2)
 *
 * BIPOLAR BY CONSTRUCTION: every predicate carries BOTH an accept pole and a reject pole. A set
 * that only ever asserts firing passes identically against a detector that fires on everything —
 * and a set that only ever asserts silence passes identically against a detector that is inert.
 * Both are the shapes these cases exist to lock out, and both are live risks here because the
 * whole guard is capped at advisory: an inert advisory is indistinguishable from a clean session.
 *
 * ESTABLISHED RED (`instrument-discipline.md` MUST-2): each predicate's reddening mutation is named
 * in `reds_under`. The four load-bearing ones were RUN against this file before it landed —
 * MEASURED, not predicted — each set below is what the mutation ACTUALLY reddened:
 *   M-a  drop `if (!name) return null` in detectNamedDispatchWithoutDelivery → cases 02, 03
 *   M-b  delete the READ_ONLY_SCOPE_RX withdrawal in impliesWrite          → cases 12, 13
 *   M-c  collapse canWrite's UNKNOWN branch to `false`                     → cases 19, 20
 *   M-d  drop the DELEGATION_TOOLS filter in inspectDispatch               → case  27
 *   M-e  reinstate `JSON.parse(await readStdinBounded())` in the HOOK      → cases 43, 44, 48
 *        (the real inert-hook bug; see the § 13 block for why the 42 library cases missed it)
 * Each mutation exits 1; the restored file exits 0. Case 12 originally did NOT red under M-b — its
 * brief said "writing", which `\bwrite\b` cannot match, so it was vacuous — and it was rewritten
 * rather than left in. That is the value of running the mutation instead of predicting it: a
 * fixture never shown to red is not a regression guard, and a non-reddening case leaves two live
 * hypotheses (vacuous case OR inert mutation).
 *
 * ── CASES 39a–39l + 72a/72b: the 2026-09-14 additions (agent-definition shadowing) ──
 *
 * ESTABLISHED RED, MEASURED — five mutations, each (a) asserted to change the file's bytes, (b)
 * `node --check`-verified to still PARSE, (c) shown to REACH the code by a probe that read the
 * mutated value BEFORE the suite was run, and (d) restored to a sha256-identical file:
 *   M-dup-1  drop `_dupes.add(rec.name)` in readAgentInventory  → 39a 39b 39e 39h 39i 39j
 *   M-dup-2  unmarked map returns `new Set()` instead of null   → 39c
 *   M-dup-3  delete the predicate's `shadowed.has` firing arm   → 39e 39h 39i 39j
 *   M-dup-4  RE-ORPHAN: drop the inspectDispatch wiring only    → 39j
 *   M-dup-5  restore the blanket "reads the brief's PROSE" why  → 72b
 * M-dup-2 and M-dup-4 are the load-bearing pair, and each reds EXACTLY ONE case. M-dup-2 IS the
 * implementation this change replaced — a root-keyed registry in which "never scanned" and "scanned,
 * none found" were the same empty Set — and it passes every other case in this file, so 39c alone
 * separates a usable tri-state from the non-discriminating shape. M-dup-4 is the re-orphaning
 * mutation: the predicate was orphaned for real once, with the comment "zero callers and zero tests
 * today, so nothing will red to remind you". 39j is that reminder.
 *
 * ── CASES 49–81: the 2026-08-23 additions (workdir-existence arm + the override gate) ──
 *
 * ESTABLISHED RED, MEASURED. Every case below was RUN against the UNMODIFIED tree before the
 * implementation existed: cases 49–81 could not even load (`TypeError:
 * L.extractDeclaredWorkdirs is not a function`, exit 1). Each was then pinned by a mutation that
 * was (a) asserted to change the file's bytes, (b) `node --check`-verified to still PARSE — a
 * syntactically invalid mutation tests NOTHING and its "red" is a module-load error wearing a
 * detector failure's clothes — and (c) reverted to a byte-identical restore, re-verified at
 * 81/81 after every single run. The matrix, as OBSERVED (not predicted):
 *
 *   M-l   delete the workdir predicate          → 55 62 63 64 66 67 68 69 70 71 74 75 76 78
 *   M-m   invert the existsSync verdict         → +56 +72
 *   M-w   drop the `cd` anchor                  → +49
 *   M-x   drop the `worktree` anchor            → 50
 *   M-y   drop the punctuation trim             → 50 54
 *   M-j   drop the anchor SCOPE GATE            → 53
 *   M-o   creation-withdrawal unconditional     → (as M-l)
 *   M-o2  DELETE the creation-withdrawal        → 60 61
 *   M-n   a throwing existsSync ⇒ "missing"     → 59
 *   M-p   downgrade the block to halt-and-report→ 63 67 68 69 70 76
 *   M-r   ignore the receipt (hook)             → 73 74 75 77 78
 *   M-v   no escape offered on the lexical tier → 81
 *   M-t   remove the one-shot unlink (shared lib)→ 75 76
 *   M-d   delete the env channel   (shared lib) → 77 78
 *   M-i   drop the reason from the record       → 74
 *
 * TWO NON-REDDENING RESULTS WERE RESOLVED RATHER THAN READ AS VERDICTS
 * (`instrument-discipline.md` MUST-2(b) — a mutation that does not red leaves TWO live
 * hypotheses: vacuous case, or inert mutation):
 *
 *   1. Removing the URL/relative LOOKBEHIND fence alone reddened NOTHING. Cases 51 and 52 were
 *      NOT vacuous: removing the lookbehind AND the anchor scope gate TOGETHER reds 51 52 53.
 *      The two fences are INDEPENDENTLY SUFFICIENT for those inputs — genuine defense in depth —
 *      so no single-fence mutation can red them. Recorded here so a later reader does not delete
 *      one fence on the evidence that "no test covers it".
 *   2. An earlier M-n produced a SYNTAX ERROR; its exit 1 was a parse failure, not a detector
 *      result, and it was re-run correctly (→ case 59) rather than banked. This is why the
 *      matrix runs `node --check` before reading any result.
 *
 * Cases 63–66 dereference the finding with `f?.` DELIBERATELY: an earlier draft used `f.` and a
 * predicate-deleting mutation CRASHED the runner here, masking which other cases it reddened.
 *
 * ── CASES 82–126: wip-discipline MUST-9 (lane-orchestrator brief without partition) ──
 *
 * ESTABLISHED RED, MEASURED 2026-09-12 by a driver that, per mutation, asserted a single anchor,
 * `node --check`-verified the mutant, ran a REACH probe against BOTH the original and the mutant (a
 * differing output is the proof the mutated line executes), ran this runner, then restored the
 * original bytes — `cmp`-verified against a pre-run copy, and 134/134 re-verified after. Observed:
 *
 *   M-9l   lane gate always true                 → 88 100 101
 *   M-9b   drop the STEP-0 branch half           → 101
 *   M-9q   classify ROLE over the unstripped brief → 90 91 92 93 116
 *   M-9v   drop the leaf-denial veto             → 86 87 94 102 103 104 105 106 107
 *   M-9o   grant gate always true                → 68 89
 *   M-9c   drop the compliance gate              → 85 91 126
 *   M-9e/f/g drop ONE element test               → 14 / 17 / 16 cases, each including 82 83 84 99 120
 *   M-9w   unwire from inspectDispatch           → 117 118 120 121 123 124
 *   M-9s   raise severity to halt-and-report     → 15 cases, including 116 122 123
 *   M-9h   drop the hygiene lookahead            → 113 114
 *   M-9d1..d6 drop ONE leaf-denial arm           → exactly 102 / 103 / 104 / 105 / 106 / 107
 *   M-9a1..a5 drop ONE grant arm                 → 85 108 / 109 113 114 116 / 22 cases / 111 / 112
 *   M-G1   guard builds the gate on advisory-only findings → 123 (the pending receipt is consumed)
 *   M-G2   guard renders at `advisory`           → 121 ("the action proceeded" — false at PreToolUse)
 *
 * No mutation in the set was inert. M-9o also reds case 68, which is NOT a MUST-9 case: under "every
 * lane brief is an orchestrator", 68's `cd ${REPO}` prompt reads as a lane brief whenever REPO is
 * itself a `-wt` sibling. On an unmutated tree 68 carries no grant and stays silent. The detector
 * once carried an empty-prompt gate as well; it was DELETED rather than tested, because the lane
 * gate already classifies "" as `none` and no case could separate the two
 * (`instrument-discipline.md` MUST-5(b)).
 *
 * ── CASES 22i–22x (+ 22b re-briefed): MUST-10's PIN recognised as an INSTRUCTION ──
 *
 * ESTABLISHED RED, MEASURED 2026-09-12 against a SCRATCH COPY of the library (the live file was never
 * written; byte-equal to its pre-run snapshot at the end). Per mutation: anchor count asserted 1,
 * `node --check` on the mutant, a REACH probe (the 6c prompts classified by the mutant vs the
 * unmutated library — differing output is the proof the mutation changed behaviour), this runner,
 * then a byte-equal restore. Control 150/150. Observed:
 *
 *   M-10r   revert to the pre-fix literal `-C /abs` token test  → 22i 22j 22k 22l 22r 22t 22w
 *   M-10e   drop the in-unit assertion arm                      → 22b 22i 22t 22u 22w
 *   M-10b   drop the path-bound `-C <p> rev-parse` arm          → 22k
 *   M-10a   a universal pin needs no assertion                  → 22j 22l 22w
 *   M-10n   merge the missing-assertion finding into the generic → 22j 22l
 *   M-10q   drop the every/each/all-git-call quantifier         → 22r
 *   M-10u   drop the absolute requirement                       → 22x
 *   M-10v1  drop the preceding-negation veto                    → 22o
 *   M-10v2  drop the flag-as-negated-subject veto               → 22p
 *   M-10c   `-C` token case-insensitive                         → 22s
 *   M-10w   split units on every newline                        → 22t
 *   M-10g   drop `--git-dir` from the token                     → 22u
 *   M-10t   a bare `-C` token is a universal pin                → 22n 22o 22p 22q 22r 22x
 *   M-10f   drop the FORBID form                                → 22c 22v
 *
 * Two first-pass results were RESOLVED, not banked. M-10w first reddened NOTHING with an identical
 * reach probe — an INERT mutation, because 22t's wraps kept flag, quantifier and assertion on one
 * line; 22t was re-wrapped so each break separates a required element. And M-10r first left 22k
 * and 22t green while the probe showed both FIRING — those cases asserted only the classifier's
 * form, not the detector's silence; both now assert both. Both re-measured after the fix.
 *
 * ── CASES 127–138 (+ 81 and 124 INVERTED): override binding, full block render, runner isolation ──
 *
 * ESTABLISHED RED, MEASURED 2026-09-12. Each mutation was applied to a SCRATCH COPY of the checkout
 * (the live files were never written; byte-equal to a pre-run snapshot at the end), anchor count
 * asserted 1, `node --check` on the mutant, a REACH probe driving the mutant hook and the live hook
 * on the same input (differing output = the mutation executes), this runner run inside that copy,
 * then the copy's file restored byte-equal to the live one. Control 162/162. Observed:
 *
 *   M-B1  resolve (consume) the override on non-block findings   → 123 128 129 130 131
 *         (reach: receipt present → consumed. 131 reds too: the halt-and-report call spent the
 *         receipt, so the blocked call it was written for then had none — the defect itself)
 *   M-B2  re-offer the receipt on the non-block tier              → 81 122 124 130
 *   M-B3  render only the blocking findings in a block            → 134 135
 *         (reach: 3 finding lines → 1, still exit 2)
 *   M-S2  section 15 spawns the hook against the checkout again   → 69 70 73 74 75 138
 *         and the SENTINEL receipt placed in that copy was DELETED — the same run with the
 *         sandbox intact leaves it byte-identical, so the sentinel check discriminates
 *
 * Pure functions against in-memory inputs plus throwaway tmpdirs. No network, no live session, no
 * sink. The hook-boundary cases spawn the real hook as a child process, ONLY through `spawnHook`,
 * inside runner-created sandboxes that are removed on exit.
 */

import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const REPO = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const L = require(path.join(REPO, ".claude/hooks/lib/dispatch-contract.js"));
const HOOK = path.join(REPO, ".claude/hooks/dispatch-contract-guard.js");

/**
 * HOOK-SPAWN SANDBOX. Every child-process run of the real hook gets its cwd AND its
 * `CLAUDE_PROJECT_DIR` set to its OWN mkdtemp project directory, never the checkout this runner was
 * started from. Those two are the ONLY roots the hook's override gate searches for a receipt: the
 * invoking tree is the hook's cwd, and the one extra root is `CLAUDE_PROJECT_DIR`
 * (`hooks/dispatch-contract-guard.js` passes `extraRoots: () => [PROJECT_DIR]`; candidates are built
 * in `hooks/lib/override-receipt.js:281-305`). Pinning both keeps every receipt a case writes, and
 * every receipt the hook could consume, inside a directory this runner created.
 *
 * WHY (2026-09-12): the earlier revision drove the hook with `CLAUDE_PROJECT_DIR` = the checkout and
 * opened each receipt section with an unconditional delete of
 * `<checkout>/.claude/dispatch-authz/dispatch-contract-allow` — so running this fixture DELETED an
 * operator's real pending override. MEASURED: a sentinel receipt placed in a scratch copy of the
 * checkout was gone after a 150/150 run. Its comment argued a sandbox "would test a different
 * thing"; it does not, because the hook reads receipts from those two roots and nowhere else.
 *
 * The hook ALSO reads the project's `.claude/agents/` (the MUST-5 inventory), which is the one thing
 * copied in. The hook's CODE is still the checkout's, because that is what is under test.
 */
const TMP_REAL = fs.realpathSync(os.tmpdir());
const REPO_REAL = fs.realpathSync(REPO);
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const sandboxes = [];
function makeHookSandbox(label) {
  // Asserted BEFORE the first write: a temp root inside the checkout would put the sandbox, and
  // every receipt written to it, back inside the tree this exists to protect.
  if (within(TMP_REAL, REPO_REAL)) {
    throw new Error(`REFUSING hook sandbox: temp root ${TMP_REAL} lies inside the checkout ${REPO_REAL}`);
  }
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(TMP_REAL, `dispatch-contract-${label}-`)));
  const receipt = path.join(dir, L.OVERRIDE_RECEIPT_REL);
  if (dir === TMP_REAL || !within(dir, TMP_REAL) || within(dir, REPO_REAL) ||
      within(REPO_REAL, dir) || !within(receipt, dir)) {
    throw new Error(`REFUSING hook sandbox ${dir}: not a fresh temp dir disjoint from ${REPO_REAL}`);
  }
  fs.cpSync(path.join(REPO, ".claude", "agents"), path.join(dir, ".claude", "agents"), { recursive: true });
  const sb = { dir, receipt };
  sandboxes.push(sb);
  return sb;
}
/** The ONE call site that starts the hook. Refuses any project dir this runner did not create. */
function spawnHook(sb, input, extraEnv = {}) {
  if (!sandboxes.includes(sb)) throw new Error("REFUSING hook spawn: not a runner-created sandbox");
  const env = { ...process.env, ...extraEnv, CLAUDE_PROJECT_DIR: sb.dir };
  if (!Object.prototype.hasOwnProperty.call(extraEnv, L.OVERRIDE_ENV)) delete env[L.OVERRIDE_ENV];
  return spawnSync("node", [HOOK], { input, encoding: "utf8", env, cwd: sb.dir });
}
process.on("exit", () => {
  for (const sb of sandboxes) {
    if (within(sb.dir, TMP_REAL) && !within(sb.dir, REPO_REAL)) {
      try { fs.rmSync(sb.dir, { recursive: true, force: true }); } catch {}
    }
  }
});

const cases = [];
function check(id, name, cond, detail, redsUnder) {
  cases.push({ id, name, pass: !!cond, detail, redsUnder });
}

/** Small inventory used by the MUST-5 cases; mirrors the real frontmatter shape. */
const INV = new Map([
  ["analyst", ["Read", "Grep", "Glob"]],
  ["tdd-implementer", ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "Task"]],
  ["reviewer", ["Read", "Bash", "Grep", "Glob", "Task"]],
  ["wildcard-agent", ["*"]],
]);

// ── 1. what counts as a NAMED dispatch ──────────────────────────────────────
check("01", "named dispatch without delivery instruction FIRES",
  !!L.detectNamedDispatchWithoutDelivery({ name: "lane-a", prompt: "Investigate X and return your findings." }),
  "expected a finding", "M-a: drop the !name gate");
check("02", "UNNAMED dispatch with the same brief is SILENT",
  L.detectNamedDispatchWithoutDelivery({ prompt: "Investigate X and return your findings." }) === null,
  "unnamed auto-returns; contract does not apply", "M-a: drop the !name gate");
check("03", "whitespace-only name is NOT a named dispatch",
  L.detectNamedDispatchWithoutDelivery({ name: "   ", prompt: "Investigate X." }) === null,
  "blank name must not create a mailbox obligation");

// ── 2. what counts as a push-delivery instruction ───────────────────────────
check("04", "explicit SendMessage instruction SILENCES the MUST-6 arm",
  L.detectNamedDispatchWithoutDelivery({ name: "lane-a", prompt: "Do X, then SendMessage the orchestrator." }) === null,
  "explicit push named");
check("05", "prose 'message the main agent' also SILENCES",
  L.detectNamedDispatchWithoutDelivery({ name: "lane-a", prompt: "When done, message the main agent with results." }) === null,
  "prose variant recognised");
check("06", "'return your findings' alone does NOT count as a push instruction",
  L.hasPushDeliveryInstruction("Return your findings when complete.") === false,
  "pull contract must not read as push", "M-a");
check("07", "'push your findings' DOES count",
  L.hasPushDeliveryInstruction("push your findings to the orchestrator") === true,
  "push phrasing recognised");

// ── 3. what counts as WRITE INTENT ──────────────────────────────────────────
check("08", "'create the fixtures' is write intent",
  L.impliesWrite("Create the fixture files for the new detector.") === true, "verb+object");
check("09", "'implement the hook' is write intent",
  L.impliesWrite("Implement the hook and register it.") === true, "verb+object");
check("10", "pure analysis brief is NOT write intent",
  L.impliesWrite("Summarise how the scheduler resolves ties. Explain the trade-offs.") === false,
  "no production verb+object", "widen WRITE_INTENT_RX");
check("11", "the noun 'the write path' is NOT write intent",
  L.impliesWrite("Explain the write path through the buffer.") === false,
  "noun must not fire", "drop the verb anchor");

// ── 4. the READ-ONLY scope withdrawal ───────────────────────────────────────
// The brief here MUST contain a live WRITE_INTENT_RX match, or the case is vacuous for M-b: it
// would read false whether the withdrawal arm exists or not. An earlier draft used "the rule files
// I am writing" — `\bwrite\b` never matches "writing", so the case passed under the mutation and
// proved nothing. Caught by running M-b, not by reading the code.
check("12", "READ-ONLY marker WITHDRAWS an otherwise-matching write intent",
  L.impliesWrite("READ-ONLY investigation: describe how you would update the rule files.") === false &&
    L.impliesWrite("describe how you would update the rule files.") === true,
  "scope arm wins, and the same brief without the marker DOES match",
  "M-b: delete READ_ONLY_SCOPE_RX withdrawal");
check("13", "'do NOT edit any file' WITHDRAWS it too",
  L.impliesWrite("Investigate and do NOT edit any file. Update me on the rules.") === false,
  "negative-scope phrasing", "M-b");
check("14", "without the marker the same brief DOES imply write",
  L.impliesWrite("Update the rule files.") === true,
  "the withdrawal must be marker-driven, not unconditional", "M-b inverted");

// ── 5. which declared tool sets can write ───────────────────────────────────
check("15", "Read/Grep/Glob CANNOT write", L.canWrite("analyst", INV) === false, "read-only roster");
check("16", "Write/Edit-bearing set CAN write", L.canWrite("tdd-implementer", INV) === true, "write-capable");
check("17", "Bash-but-no-Write CANNOT write", L.canWrite("reviewer", INV) === false,
  "Bash is not a write tool for this predicate");
check("18", "wildcard '*' CAN write", L.canWrite("wildcard-agent", INV) === true, "built-in wildcard");

// ── 6. the UNKNOWN arm must fail OPEN ───────────────────────────────────────
check("19", "unknown agent type resolves UNKNOWN (null), not false",
  L.canWrite("general-purpose", INV) === null,
  "tri-state, never boolean", "M-c: collapse UNKNOWN to false");
check("20", "write brief to an UNKNOWN agent type is SILENT",
  L.detectWriteTaskToReadOnlyAgent({ subagent_type: "general-purpose", prompt: "Create the files." }, INV) === null,
  "fail open on unknown", "M-c");
check("21", "write brief to a READ-ONLY agent FIRES",
  !!L.detectWriteTaskToReadOnlyAgent({ subagent_type: "analyst", prompt: "Create the fixture files." }, INV),
  "the MUST-5 accept pole", "M-c inverted");
check("22", "write brief to a WRITE-CAPABLE agent is SILENT",
  L.detectWriteTaskToReadOnlyAgent({ subagent_type: "tdd-implementer", prompt: "Create the fixture files." }, INV) === null,
  "the MUST-5 reject pole");

// ── 5b. the REMEDY must be cheaper than the workaround ──────────────────────
// ORIGIN, measured: this detector fired correctly three times in one session against the same
// orchestrator and was worked around all three times. The finding was right and its remedy was
// right; what was wrong was the COST. "Re-target a write-capable agent" left the orchestrator to
// go and find which agents can write, while the incorrect remedy — message the already-running
// agent — was one call away. A halt-and-report whose correct remedy costs more than its incorrect
// one selects for the incorrect one. So the finding now CARRIES the answer, derived from the same
// inventory that decided the mismatch.
// ── 5c. MUST-10's FORBID form must not punish PRECISION ─────────────────────
// ORIGIN, measured: the forbid clause was recognised by ONE canonical sentence,
// `never run a git write`. A brief that forbade git writes MORE specifically — naming
// every destructive verb — was STRICTLY STRONGER and matched NOTHING, so MUST-10 fired on
// six consecutive dispatches whose briefs were safer than the one it would have accepted.
// Six findings correct about the FORM and wrong about the RISK is how an advisory teaches
// its reader to skim it.
// The TWO-VERB bound is the load-bearing half and 22h is its guard: widening a WITHDRAWAL
// predicate is where false NEGATIVES enter, because every accepted phrase can silence a
// real finding. One verb is reachable by ordinary scheduling prose; two distinct verbs in
// one negated sentence is not written by accident.
check("22g", "an ENUMERATED prohibition counts as MUST-10's forbid form",
  L.fixtureContainmentOf(
    "CONTAINMENT: this lane needs NO repository fixture. Do not create one. NEVER run " +
    "`git push`, `git reset --hard`, `git clean -f`, `git checkout --`, `git restore`, or " +
    "`git stash`. Read-only git is fine.",
  ).form === "forbid",
  "a brief stronger than the canonical sentence must not read as no containment", "M-10f: drop the enumerated arm");

check("22h", "ONE destructive verb in a scheduling remark is NOT a containment clause",
  L.fixtureContainmentOf("Never run `git push` until CI is green.").form !== "forbid",
  "the false-NEGATIVE bound — one verb must not silence MUST-10");

check("22i", "the CANONICAL sentence still counts (the remedy the finding text prescribes)",
  L.fixtureContainmentOf(
    "this lane needs no repository fixture; never run a git write command",
  ).form === "forbid",
  "narrowing the canonical form would break the remedy the message tells operators to write");

check("22j", "a brief that MANDATES a fixture still fires",
  L.fixtureContainmentOf(
    "Build a real git repository with backdated commits under the scratch root.",
  ).form !== "forbid",
  "the accept arm must not swallow the case MUST-10 exists for");

check("22b", "the finding NAMES write-capable alternatives, so re-targeting is mechanical",
  (() => {
    const e = L.detectWriteTaskToReadOnlyAgent(
      { subagent_type: "analyst", prompt: "Create the fixture files." }, INV).evidence;
    return e.includes("tdd-implementer") && e.includes("wildcard-agent");
  })(),
  "both write-capable members of INV must be named", "M-c2: drop the hint");

check("22c", "the agent that was REFUSED is never offered back as its own alternative",
  !L.detectWriteTaskToReadOnlyAgent(
    { subagent_type: "analyst", prompt: "Create the fixture files." }, INV)
    .evidence.match(/Write-capable here:[^.]*\banalyst\b/),
  "self-suggestion would be a remedy that cannot work");

check("22d", "with NO write-capable agent in the inventory the hint is OMITTED, never guessed",
  !L.detectWriteTaskToReadOnlyAgent(
    { subagent_type: "analyst", prompt: "Create the fixture files." },
    new Map([["analyst", ["Read"]], ["reviewer", ["Read", "Bash"]]]),
  ).evidence.includes("Write-capable here"),
  "naming an agent that cannot write would spend the trust this advisory runs on");

check("22e", "an UNREADABLE inventory degrades to the un-hinted finding rather than throwing",
  (() => {
    const f = L.detectWriteTaskToReadOnlyAgent(
      { subagent_type: "analyst", prompt: "Create the fixture files." }, INV);
    // The hint is additive: the finding's identity and severity are unchanged by it.
    return f.rule_id === "orchestrator-context-economy/MUST-5" && f.severity === "halt-and-report";
  })(),
  "the hint must not alter the verdict it decorates");

// ── 6b. fixture-containment (worktree-isolation/MUST-10) ─────────
// The incident: a lens dispatched to build adversarial git fixtures ran unpinned commands that
// resolved to the ORCHESTRATOR'S checkout — nine commits landed, seven branches were pushed to the
// real remote. Every pole below is bipolar; the reject poles are what stop this becoming a detector
// that fires on any brief mentioning git.
check("22a", "a fixture-building brief with NO pin FIRES",
  !!L.detectUnpinnedFixtureDispatch({ prompt: "Build a git repository fixture and plant three adversarial commits." }),
  "the accept pole — the exact shape of the incident brief", "unpinned repo fixture");
check("22b", "the same brief with an ABSOLUTE -C pin on every call + its assertion is SILENT, as a PIN",
  L.detectUnpinnedFixtureDispatch({ prompt: "Build a git repository fixture. Pin every call: git -C /tmp/scratch/fx init, and assert its toplevel before the first write." }) === null &&
    L.fixtureContainmentOf("Build a git repository fixture. Pin every call: git -C /tmp/scratch/fx init, and assert its toplevel before the first write.").form === "pin",
  "the reject pole — pinning is the remedy the evidence names. Carried an assertion since 2026-09-12: MUST-10's PIN is both halves (see 22j)", "M-10e");
check("22c", "the same brief carrying the CONTAINMENT CLAUSE is SILENT",
  L.detectUnpinnedFixtureDispatch({ prompt: "Build a git repository fixture. Never run a git write command anywhere." }) === null,
  "a lane told to run no git write needs no pin — either closes the path");
check("22d", "a READ-ONLY git brief is SILENT",
  L.detectUnpinnedFixtureDispatch({ prompt: "Read the git log and summarise the last ten commits." }) === null,
  "no build verb, no repository noun — the over-match this bound exists to refuse");
check("22e", "a build brief with no REPOSITORY noun is SILENT",
  L.detectUnpinnedFixtureDispatch({ prompt: "Build a fixture set of ten prose transcripts." }) === null,
  "both halves are required, or every authoring brief trips it");
check("22f", "an absent or empty prompt is SILENT, never a throw",
  L.detectUnpinnedFixtureDispatch({}) === null && L.detectUnpinnedFixtureDispatch({ prompt: "" }) === null,
  "fail open on nothing to read");
check("22g", "the finding carries halt-and-report, NOT block",
  (L.detectUnpinnedFixtureDispatch({ prompt: "Create a scratch repository fixture." }) || {}).severity === "halt-and-report",
  "lexical evidence cannot carry block", "hook-output-discipline MUST-2");
check("22h", "inspectDispatch SURFACES the finding, so the guard consumes it",
  L.inspectDispatch("Task", { prompt: "Build a git repository fixture." }, INV).some((f) => f.rule_id === "worktree-isolation/MUST-10"),
  "a predicate no aggregator calls is inert", "wired, not merely written");

// ── 6c. MUST-10's PIN recognised as an INSTRUCTION (2026-09-12) ─────────
// The defect these close, measured: the pin test accepted only a literal `-C /abs`, so it FIRED on
// every brief carrying the canonical containment clause — a PIN instruction for a path the brief
// cannot know yet — and went SILENT on a bare `-C /tmp/x` pinning one call. Each silent pole asserts
// WHICH form silenced it; each firing pole asserts rule id, severity and which half is missing.
const FX_BUILD = "Build a git repository fixture with three commits and a side branch. ";
const CANON_1 = FX_BUILD + "CONTAINMENT: any fixture that builds a repo uses its own mkdtemp dir with an absolute `-C`/`cwd` on every git call.";
const CANON_2 = FX_BUILD + "CONTAINMENT: any fixture that builds a repo uses its own mkdtemp dir with an absolute `-C <scratch path>`/`cwd` on every git call, asserted before the first write.";
const m10 = (p) => {
  const f = L.detectUnpinnedFixtureDispatch({ prompt: p });
  return { f, form: L.fixtureContainmentOf(p).form };
};
const firesAs = (r, form, evidenceNeedle) =>
  !!r.f && r.f.rule_id === "worktree-isolation/MUST-10" && r.f.severity === "halt-and-report" &&
  r.form === form && r.f.evidence.includes(evidenceNeedle);

check("22i", "the canonical clause WITH its assertion is SILENT, as a PIN",
  (() => { const r = m10(CANON_2); return r.f === null && r.form === "pin"; })(),
  "the defect's own brief: placeholder path + every git call + asserted", "M-10r M-10e");
check("22j", "the canonical clause WITHOUT any assertion FIRES, naming the missing STEP-0 half",
  firesAs(m10(CANON_1), "pin-without-assertion", "mandates no STEP-0 assertion"),
  "MUST-10 PIN = absolute -C on every call WITH a STEP-0 assertion; -C at a non-repo dir walks UP", "M-10r M-10a M-10n");
check("22k", "a placeholder pin asserted by a PATH-BOUND `-C <p> rev-parse --show-toplevel` elsewhere is SILENT",
  (() => { const r = m10(FX_BUILD + "Every git call carries an absolute `-C <scratch path>`. STEP 0: `git -C <scratch path> rev-parse --show-toplevel` must equal it."); return r.f === null && r.form === "pin"; })(),
  "the assertion may sit in its own sentence when it is bound to the pinned path", "M-10r M-10b");
check("22l", "a BARE worktree STEP-0 `rev-parse --show-toplevel` does NOT satisfy the assertion half",
  firesAs(m10(FX_BUILD + "Every git call carries an absolute `-C <scratch path>`. STEP 0: [ \"$(git rev-parse --show-toplevel)\" = \"$(pwd -P)\" ]."),
    "pin-without-assertion", "mandates no STEP-0 assertion"),
  "the lane's own cwd assertion says nothing about the fixture target", "M-10r M-10a M-10n");
check("22m", "an unpinned fixture brief FIRES as `none`, naming no git target",
  firesAs(m10(FX_BUILD + "Merge the side branch back and tag the result."), "none", "pins no git target"),
  "the accept pole with identity");
check("22n", "`-C` mentioned only to REJECT it FIRES",
  firesAs(m10(FX_BUILD + "Do not use `-C`; `git -C` never establishes cwd."), "none", "pins no git target"),
  "the presence of -C is not a pin", "M-10t");
check("22o", "a universal absolute pin under a preceding NEGATION FIRES",
  firesAs(m10(FX_BUILD + "Do not put an absolute `-C` on every git call, asserted or not; cd into the mkdtemp dir instead."),
    "none", "pins no git target"),
  "quantifier + absolute + assertion word, all negated", "M-10v1");
check("22p", "MUST-10's own DO NOT (`git -C` never establishes cwd) under a quantifier FIRES",
  firesAs(m10(FX_BUILD + "An absolute `git -C <scratch path>` never establishes cwd for every git call, asserted or not."),
    "none", "pins no git target"),
  "the flag is the SUBJECT of a negated predicate", "M-10v2");
check("22q", "a PARTIAL pin (`use -C for the init`) FIRES",
  firesAs(m10(FX_BUILD + "Use -C for the init."), "none", "pins no git target"),
  "no quantifier, no absolute", "M-10t");
check("22r", "a CONCRETE absolute pin on ONE call, even asserted, FIRES",
  firesAs(m10(FX_BUILD + "Run `git -C /tmp/scratch/fx init`, asserted with `git -C /tmp/scratch/fx rev-parse --show-toplevel`, then make the commits."),
    "none", "pins no git target"),
  "the three commits run unpinned; a path-bound assertion does not make a partial pin universal", "M-10r M-10q");
check("22s", "lowercase `git -c` (config) is NOT a target flag",
  firesAs(m10(FX_BUILD + "Every git call carries an absolute `-c safe.directory=/tmp/fx` override, asserted before the first write."),
    "none", "pins no git target"),
  "-C is case-sensitive; the i-flag tests run only after the token is replaced", "M-10c");
check("22t", "the canonical clause HARD-WRAPPED across lines is still a PIN",
  (() => { const r = m10(FX_BUILD + "CONTAINMENT: any fixture that builds a repo uses its own mkdtemp dir with an absolute\n`-C <scratch path>`/`cwd` on every\ngit call, asserted before the first write."); return r.f === null && r.form === "pin"; })(),
  "a single newline joins a wrapped sentence; each wrap here separates a required element (absolute | flag | quantifier)", "M-10r M-10w");
check("22u", "a universal absolute `--git-dir` pin, asserted, is SILENT, as a PIN",
  m10(FX_BUILD + "Every git call carries `--git-dir=/tmp/scratch/fx/.git`, asserted against its toplevel before the first write.").form === "pin" &&
    m10(FX_BUILD + "Every git call carries `--git-dir=/tmp/scratch/fx/.git`, asserted against its toplevel before the first write.").f === null,
  "the rule's parenthetical alternative", "M-10g");
check("22v", "the FORBID form is SILENT and classified as FORBID",
  (() => { const r = m10(FX_BUILD + "This lane needs no repository fixture; never run a git write command anywhere."); return r.f === null && r.form === "forbid"; })(),
  "MUST-10's second compliant form, with identity", "M-10f");
check("22w", "inspectDispatch surfaces NO MUST-10 finding for the canonical clause WITH its assertion",
  !L.inspectDispatch("Task", { prompt: CANON_2 }, INV).some((f) => f.rule_id === "worktree-isolation/MUST-10") &&
    L.inspectDispatch("Task", { prompt: CANON_1 }, INV).some((f) => f.rule_id === "worktree-isolation/MUST-10"),
  "the wiring pole on BOTH sides — the guard reads what the predicate decides", "M-10r");
check("22x", "a universal pin on a RELATIVE `-C` path, asserted, FIRES",
  firesAs(m10(FX_BUILD + "Every git call carries `-C scratch/fx`, asserted before the first write."), "none", "pins no git target"),
  "a relative -C resolves against the ORCHESTRATOR's cwd — the incident's own target", "M-10u");

// ── 7. frontmatter parsing ──────────────────────────────────────────────────
check("23", "name + tools parse into a record",
  JSON.stringify(L.parseAgentFrontmatter("---\nname: x\ntools: Read, Write\n---\nbody")) ===
    JSON.stringify({ name: "x", tools: ["Read", "Write"] }),
  "canonical shape");
check("24", "a file with NO tools: line yields NO record",
  L.parseAgentFrontmatter("---\nname: x\nmodel: opus\n---\nbody") === null,
  "half-record must not read as 'declares no write tools'", "return a partial record");
check("25", "a file with no frontmatter fence yields NO record",
  L.parseAgentFrontmatter("# just a heading\n") === null, "unfenced");
check("26", "inline-array tools: parse too",
  JSON.stringify(L.parseAgentFrontmatter('---\nname: y\ntools: ["Read", "Edit"]\n---')?.tools) ===
    JSON.stringify(["Read", "Edit"]),
  "both YAML styles");

// ── 8. which TOOLS are inspected at all ─────────────────────────────────────
check("27", "a non-delegation tool yields NO findings",
  L.inspectDispatch("Bash", { name: "lane-a", prompt: "do it" }, INV).length === 0,
  "matcher belt-and-suspenders", "M-d: drop the DELEGATION_TOOLS filter");
check("28", "'Task' IS inspected",
  L.inspectDispatch("Task", { name: "lane-a", prompt: "Investigate." }, INV).length === 1, "Task arm", "M-d");
check("29", "'Agent' IS inspected",
  L.inspectDispatch("Agent", { name: "lane-a", prompt: "Investigate." }, INV).length === 1, "Agent arm", "M-d");
check("30", "one dispatch can carry BOTH findings",
  L.inspectDispatch("Agent", { name: "lane-a", subagent_type: "analyst", prompt: "Create the fixture files." }, INV).length === 2,
  "MUST-5 and MUST-6 are independent");
check("31", "a well-formed dispatch yields ZERO findings",
  L.inspectDispatch("Agent",
    { name: "lane-a", subagent_type: "tdd-implementer", prompt: "Create the fixture files, then SendMessage the orchestrator." },
    INV).length === 0,
  "the all-clear pole — without it an inert detector would pass every other case");

// ── 9. the empty/absent-prompt fail-open arm ────────────────────────────────
check("32", "named dispatch with an EMPTY prompt is SILENT",
  L.detectNamedDispatchWithoutDelivery({ name: "lane-a", prompt: "" }) === null, "nothing to read");
check("33", "malformed tool_input is SILENT, not a throw",
  L.detectNamedDispatchWithoutDelivery(null) === null && L.detectWriteTaskToReadOnlyAgent(undefined, INV) === null,
  "fail open on garbage");
check("34", "description alone is read as the brief",
  L.promptOf({ description: "Create the fixture files." }).includes("Create"), "both prose fields");

// ── 10. evidence bounding ───────────────────────────────────────────────────
check("35", "clip bounds long evidence and marks truncation",
  L.clip("x".repeat(500)).length <= L.EVIDENCE_MAX + 1 && L.clip("x".repeat(500)).endsWith("…"),
  "advisory stays bounded");
check("36", "clip flattens newlines",
  L.clip("a\n\nb") === "a b", "single-line evidence");

// ── 11. the on-disk inventory resolves THIS repo's agents ───────────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-contract-"));
  try {
    fs.mkdirSync(path.join(tmp, ".claude/agents/nested"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".claude/agents/a.md"), "---\nname: ro\ntools: Read, Grep\n---\n");
    fs.writeFileSync(path.join(tmp, ".claude/agents/nested/b.md"), "---\nname: rw\ntools: Read, Write\n---\n");
    const inv = L.readAgentInventory(tmp);
    check("37", "walker finds agents at depth", inv.size === 2 && L.canWrite("rw", inv) === true,
      `size=${inv.size}`, "break the recursive walk");
    check("38", "a missing agents dir yields an EMPTY inventory, not a throw",
      L.readAgentInventory(path.join(tmp, "nope")).size === 0, "fail open");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const live = L.readAgentInventory(REPO);
  check("39", "the LIVE repo inventory is non-empty and read-only agents are visible",
    live.size > 10 && L.canWrite("analyst", live) === false,
    `live agents=${live.size}`,
    "this is the positive control: it fires against a corpus already known to hold read-only agents");
}

// ── 11b. AGENT-DEFINITION SHADOWING: the tri-state, and the dispatch arm ────
//
// The predicate this section pins was ORPHANED (zero callers, zero cases) from 2026-09-14 until it
// was re-wired into `inspectDispatch`. Two poles per arm, because the failure it guards is
// silence: a shadowing check that never fires is byte-identical to a repo with no duplicates, and
// this repo HAS no duplicates today (MEASURED: 39 agents, 0 shadowed), so the live corpus can
// never distinguish a working predicate from an inert one. Every firing pole below is therefore
// built on a SYNTHETIC corpus with a planted duplicate.
//
// The UNKNOWN pole (case 39c) is the load-bearing one. The previous implementation kept the
// duplicate set in a module-level root-keyed registry and returned `new Set()` for a root it had
// never scanned — so "never looked" and "looked, found none" were the SAME value, and a fail-closed
// consumer had nothing to branch on. That is the non-discriminating instrument `instrument-
// discipline.md` MUST-1 blocks as evidence. A case asserting only the two Set poles would pass
// identically against that broken shape; 39c is what separates them.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-shadow-"));
  try {
    fs.mkdirSync(path.join(tmp, ".claude/agents/nested"), { recursive: true });
    // SAME `name:`, two files, DIFFERENT capability — the shape that defeats a tool-grant read.
    fs.writeFileSync(path.join(tmp, ".claude/agents/ro.md"), "---\nname: twin\ntools: Read, Grep\n---\n");
    fs.writeFileSync(path.join(tmp, ".claude/agents/nested/rw.md"), "---\nname: twin\ntools: Read, Write, Bash\n---\n");
    fs.writeFileSync(path.join(tmp, ".claude/agents/solo.md"), "---\nname: lone\ntools: Read\n---\n");
    const dupInv = L.readAgentInventory(tmp);
    const dupes = L.duplicateAgentNames(dupInv);

    check("39a", "SHADOWING firing pole: a name declared by two files is reported",
      dupes instanceof Set && dupes.has("twin"), `dupes=${dupes && [...dupes].join(",")}`,
      "M-dup-1: drop the `if (out.has(rec.name)) _dupes.add(...)` recording");
    check("39b", "SHADOWING clean pole: a singly-declared name in the SAME scanned inventory is NOT reported",
      dupes instanceof Set && !dupes.has("lone") && dupes.size === 1,
      `size=${dupes && dupes.size}`,
      "a recorder that marks every name, which would pass 39a alone");
    check("39c", "UNKNOWN is NOT clean: a map that was never directory-scanned answers null, not an empty Set",
      L.duplicateAgentNames(new Map([["twin", ["Read"]]])) === null &&
        L.duplicateAgentNames(undefined) === null &&
        L.duplicateAgentNames(L.readAgentInventory(path.join(tmp, "nope"))) instanceof Set,
      "hand-built ⇒ null; scanned-but-absent-dir ⇒ empty Set",
      "M-dup-2: return `new Set()` instead of null for an unmarked map — the ORIGINAL registry shape");
    check("39d", "the resolved tool set for a shadowed name is one of the two declared records — the ambiguity is real, not theoretical",
      JSON.stringify(dupInv.get("twin")) === JSON.stringify(["Read", "Grep"]) ||
        JSON.stringify(dupInv.get("twin")) === JSON.stringify(["Read", "Write", "Bash"]),
      `resolved=${JSON.stringify(dupInv.get("twin"))}`,
      "documents last-writer-wins: this is WHY the finding exists");

    const hit = L.detectShadowedAgentDispatch({ subagent_type: "twin", prompt: "Investigate." }, dupInv);
    const miss = L.detectShadowedAgentDispatch({ subagent_type: "lone", prompt: "Investigate." }, dupInv);
    const unk = L.detectShadowedAgentDispatch({ subagent_type: "twin", prompt: "Investigate." }, new Map([["twin", ["Read"]]]));
    check("39e", "DISPATCH firing pole: a dispatch to the shadowed name yields a finding",
      !!hit && hit.rule_id === "agents/agent-definition-shadowing",
      `rule_id=${hit && hit.rule_id}`,
      "M-dup-3: delete detectShadowedAgentDispatch's `shadowed.has(agentType)` arm");
    check("39f", "DISPATCH clean pole: a dispatch to a singly-declared name in the same inventory is silent",
      miss === null, `miss=${JSON.stringify(miss)}`,
      "a predicate that fires on every dispatch, which would pass 39e alone");
    check("39g", "DISPATCH fail-open on UNKNOWN: an unscanned map invents no finding",
      unk === null, `unk=${JSON.stringify(unk)}`,
      "reading UNKNOWN as shadowed — a claim about a corpus nobody read");
    // `?.` on purpose: under a mutation that silences the predicate these must report a FAIL row,
    // not throw. A TypeError exits 1 with an EMPTY red-set, which is indistinguishable from an
    // inert mutation and destroys the red-set as evidence (the runner header's M-l lesson).
    check("39h", "the finding is capped at halt-and-report, never block",
      hit?.severity === "halt-and-report", `severity=${hit?.severity}`,
      "raise severity to block");
    check("39i", "the evidence NAMES the resolved tool set, so the reader can see which record won",
      !!hit?.evidence?.includes("MORE THAN ONE file") &&
        (hit.evidence.includes("Read, Grep") || hit.evidence.includes("Read, Write, Bash")),
      "", "strip the resolved-set interpolation");

    // THE STANDING CONSUMER. This is the case that reds if the predicate is re-orphaned: it goes
    // through `inspectDispatch`, the single entry point `dispatch-contract-guard.js` calls, so a
    // future edit that keeps the predicate but drops the wiring cannot pass.
    const viaInspect = L.inspectDispatch("Task", { subagent_type: "twin", prompt: "Investigate." }, dupInv);
    const viaInspectClean = L.inspectDispatch("Task", { subagent_type: "lone", prompt: "Investigate." }, dupInv);
    check("39j", "STANDING CONSUMER: inspectDispatch — the guard's ONLY entry point — surfaces the shadowing finding",
      viaInspect.some((f) => f.rule_id === "agents/agent-definition-shadowing"),
      `ids=${viaInspect.map((f) => f.rule_id).join(",")}`,
      "M-dup-4: remove the detectShadowedAgentDispatch call from inspectDispatch (the re-orphaning mutation)");
    check("39k", "STANDING CONSUMER other pole: a clean dispatch through the same entry point carries NO shadowing finding",
      !viaInspectClean.some((f) => f.rule_id === "agents/agent-definition-shadowing"),
      `ids=${viaInspectClean.map((f) => f.rule_id).join(",")}`,
      "a wiring that pushes the finding unconditionally");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // NEGATIVE CONTROL on the LIVE corpus: the real repo must be shadow-FREE, and the answer must be
  // an empty Set (scanned) rather than null (unknown). This is the arm that would catch a real
  // duplicate landing in `.claude/agents/` — the hygiene defect the predicate exists for.
  const liveDupes = L.duplicateAgentNames(L.readAgentInventory(REPO));
  check("39l", "LIVE corpus is scanned AND shadow-free — an empty Set, never null",
    liveDupes instanceof Set && liveDupes.size === 0,
    `live shadowed=${liveDupes === null ? "UNKNOWN" : [...liveDupes].join(",") || "(none)"}`,
    "plant a second file declaring an existing agent name");
}

// ── 12. severity is capped below `block` ────────────────────────────────────
{
  const a = L.detectNamedDispatchWithoutDelivery({ name: "n", prompt: "Investigate." });
  const b = L.detectWriteTaskToReadOnlyAgent({ subagent_type: "analyst", prompt: "Create the files." }, INV);
  check("40", "MUST-6 finding is halt-and-report, never block",
    a.severity === "halt-and-report", `severity=${a.severity}`, "raise severity to block");
  check("41", "MUST-5 finding is halt-and-report, never block",
    b.severity === "halt-and-report", `severity=${b.severity}`, "raise severity to block");
  check("42", "rule_ids bind to the owning clauses",
    a.rule_id === "orchestrator-context-economy/MUST-6" && b.rule_id === "orchestrator-context-economy/MUST-5",
    `${a.rule_id} / ${b.rule_id}`);
}

// ── 13. the REAL hook boundary (regression lock for the inert-hook bug) ─────
// The 42 cases above exercise the pure library and ALL PASSED while the hook itself was inert:
// `dispatch-contract-guard.js` called JSON.parse() on `readStdinBounded()`'s already-PARSED return,
// threw on every well-formed payload, and fell through to a silent passthrough. A library-only
// fixture set cannot see that seam — it is exactly the `instrument-discipline.md` MUST-6 shape,
// a green whose scope excludes the class under review. These cases drive the hook as the runtime
// does: real child process, real stdin, real stdout contract.
{
  const sb = makeHookSandbox("boundary");
  const fire = (payload) => JSON.parse(spawnHook(sb, JSON.stringify(payload)).stdout);

  const violating = fire({
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { name: "lane-a", subagent_type: "analyst", prompt: "Create the fixture files. Return your findings." },
  });
  const compliant = fire({
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { name: "lane-a", subagent_type: "tdd-implementer", prompt: "Create the fixture files. When done, SendMessage the orchestrator." },
  });
  const offTool = fire({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });

  const adv = (o) => o?.hookSpecificOutput?.additionalContext || "";

  check("43", "END-TO-END: a violating dispatch produces a NON-EMPTY advisory at the hook boundary",
    adv(violating).length > 0,
    `advisory chars=${adv(violating).length}`,
    "JSON.parse the already-parsed payload (the original inert-hook bug) — this is the ONLY case that reds");
  check("44", "END-TO-END: the advisory names BOTH clauses",
    adv(violating).includes("MUST-6") && adv(violating).includes("MUST-5"),
    "both rule_ids surface");
  check("45", "END-TO-END: a compliant dispatch produces NO advisory",
    adv(compliant) === "", "the silent pole at the real boundary");
  check("46", "END-TO-END: an off-matcher tool produces NO advisory",
    adv(offTool) === "", "belt to the matcher's suspenders");
  check("47", "END-TO-END: every path emits continue:true and exits 0",
    violating.continue === true && compliant.continue === true && offTool.continue === true,
    "never blocks — hook-output-discipline.md MUST-2");
  check("48", "END-TO-END: the advisory states the halt-and-report cap, never 'block'",
    adv(violating).includes("halt-and-report") && !adv(violating).includes('"block"'),
    "severity cap is stated in the emitted text");
}

// ── 14. the WORKDIR-EXISTENCE predicate (the STRUCTURAL, block-grade arm) ───
// Distinct in KIND from cases 01–48 above, and the distinction is the whole reason
// this arm may carry teeth. MUST-5/MUST-6 rest on a lexical read of prose, so
// `hook-output-discipline.md` MUST-2 caps them at halt-and-report. This one rests on
// `fs.existsSync` — a filesystem FACT, the exact class MUST-2 names as block-grade.
//
// The lexical half here is a SCOPE GATE (which token to test), not the VERDICT. It
// cannot produce a block by itself: an over-matched token must ALSO be an absolute
// path AND that path must not exist. That composition is why "no stronger than its
// weakest half" — the reasoning that caps MUST-5 — does not transfer.
{
  const EXISTS = () => true;
  const MISSING = () => false;

  // -- extraction: which tokens are even considered --
  check("49", "an absolute path after `cd` is extracted",
    L.extractDeclaredWorkdirs("STEP 0: cd /Users/x/repos/.wt/lane-a then assert").includes("/Users/x/repos/.wt/lane-a"),
    "the STEP-0 shape", "M-f: drop the `cd` anchor");
  check("50", "an absolute path after a `worktree ... at` phrase is extracted",
    L.extractDeclaredWorkdirs("The worktree is ALREADY CREATED and verified at /tmp/wt/lane-b.").includes("/tmp/wt/lane-b"),
    "the prose shape that produced the real incident", "M-g: drop the worktree anchor");
  check("51", "a RELATIVE path is NOT extracted",
    L.extractDeclaredWorkdirs("cd ./scratch/lane-a and work there").length === 0,
    "relative paths resolve against the hook's cwd, not the agent's — undecidable, so fail open",
    "M-h: accept relative paths");
  check("52", "a URL is NOT extracted as a path",
    L.extractDeclaredWorkdirs("see https://example.com/repos/thing for context").length === 0,
    "the `//` after a scheme must not read as a root path", "M-i: drop the URL guard");
  check("53", "an absolute path with NO workdir anchor is NOT extracted",
    L.extractDeclaredWorkdirs("Read /etc/hosts and summarise it.").length === 0,
    "a path merely MENTIONED is not a declared working directory — the scope gate",
    "M-j: extract every absolute path regardless of anchor");
  check("54", "trailing sentence punctuation is stripped from the extracted path",
    L.extractDeclaredWorkdirs("Work only in /tmp/wt/lane-c.").includes("/tmp/wt/lane-c"),
    "a trailing period is prose, not a path component", "M-k: drop the punctuation trim");

  // -- NEGATIVE FENCES: a path the brief tells the lane to AVOID is not a root pin.
  // Both poles run the SAME brief shape and separate ONLY on whether the anchored path
  // sits in a pin or a prohibition, so a check keying on "an absolute path is present"
  // scores them identically and is the instrument these cases exist to refuse.
  // MEASURED live 2026-09-15: both classes emitted `block` on CORRECT briefs, five
  // dispatches refused. `block` is this module's only teeth, so a false positive here is
  // the register operators disable.
  check("54a", "a brace-expanded SIBLING SET is not extracted as a root pin",
    L.extractDeclaredWorkdirs(
      "STEP 0: cd /tmp/wt/lane-f. NEVER cd to /tmp/wt/lane-{a,b,c}"
    ).join("|") === "/tmp/wt/lane-f",
    "ABS_PATH_RX stops at `{`, so the token is the PREFIX `/tmp/wt/lane-` — not a path, " +
      "never existed, and testing it fabricates a missing-path verdict",
    "M-k2: drop the `prompt[start + raw.length] === '{'` guard");
  check("54b", "an anchored path inside a PROHIBITION is not extracted",
    L.extractDeclaredWorkdirs(
      "STEP 0: cd /tmp/wt/lane-f. Never cd to /tmp/wt/lane-zzz"
    ).join("|") === "/tmp/wt/lane-f",
    "`cd` anchors identically in 'cd X' and 'never cd to X'; without a negation arm the " +
      "guard reads a fence as a root pin — independent of braces",
    "M-k3: drop the WORKDIR_PROHIBITION_RX guard");
  // 54a's brief carries BOTH a brace expansion and a prohibition, so the prohibition arm
  // ABSORBS it: dropping the brace guard alone leaves 54a GREEN. MEASURED — M-k2 in
  // isolation produced an EMPTY red-set with the mutation proven to reach the code, and
  // the double mutation reds 54a+54b. Per `instrument-discipline.md` MUST-5(b) an empty
  // red-set resolves nothing, so this case ISOLATES the brace guard: a positive anchor,
  // a brace-expanded SET, and no negation anywhere.
  check("54e", "ISOLATING the brace guard: a brace set under a POSITIVE anchor is not extracted",
    L.extractDeclaredWorkdirs(
      "Work only in /tmp/wt/lane-f, with per-shard build dirs at /tmp/wt/shard-{1,2,3}"
    ).join("|") === "/tmp/wt/lane-f",
    "without this case the brace guard has NO case that reds when it alone is removed — " +
      "54a passes through the prohibition arm instead",
    "M-k2: drop the `prompt[start + raw.length] === '{'` guard");
  check("54c", "OTHER POLE — a genuinely absent root pin STILL fires (the fix is not a mute)",
    !!L.detectMissingWorkdirPath(
      { prompt: "STEP 0: cd /tmp/wt/definitely-not-here and assert toplevel." },
      { existsSync: MISSING }
    ),
    "the two guards above must narrow the extractor, never disarm the arm — this is the " +
      "case that fails if a future 'fix' suppresses the finding wholesale",
    "M-k4: make extractDeclaredWorkdirs return [] unconditionally");
  check("54d", "OTHER POLE — an absent pin fires even when the brief ALSO carries a prohibition",
    !!L.detectMissingWorkdirPath(
      {
        prompt:
          "STEP 0: cd /tmp/wt/definitely-not-here and assert. Separately: never touch sibling lanes.",
      },
      { existsSync: MISSING }
    ),
    "the prohibition arm is windowed to the anchor, so an unrelated negation elsewhere in " +
      "the brief must not launder a genuinely dead pin",
    "M-k5: apply WORKDIR_PROHIBITION_RX globally instead of to the anchor window");

  // -- the verdict, with an INJECTED existsSync so the case is hermetic --
  const brief = { prompt: "STEP 0: cd /tmp/definitely-not-here/lane and assert toplevel." };
  check("55", "a NON-EXISTENT declared workdir FIRES",
    !!L.detectMissingWorkdirPath(brief, { existsSync: MISSING }),
    "the accept pole — this is incident #2", "M-l: delete the predicate");
  check("56", "an EXISTING declared workdir is SILENT",
    L.detectMissingWorkdirPath(brief, { existsSync: EXISTS }) === null,
    "the no-false-positive pole — without it, a detector that fires on everything passes case 55",
    "M-m: invert the existsSync test");
  check("57", "a brief naming NO workdir is SILENT (fail open)",
    L.detectMissingWorkdirPath({ prompt: "Summarise the scheduler." }, { existsSync: MISSING }) === null,
    "nothing measured ⇒ nothing claimed", "M-j");
  check("58", "an unparseable/absent brief is SILENT, not a throw",
    L.detectMissingWorkdirPath(null, { existsSync: MISSING }) === null &&
      L.detectMissingWorkdirPath({ prompt: 123 }, { existsSync: MISSING }) === null,
    "fail open on garbage (cc-artifacts.md Rule 7)", "let the throw escape");
  check("59", "an existsSync that THROWS fails OPEN",
    L.detectMissingWorkdirPath(brief, { existsSync: () => { throw new Error("EACCES"); } }) === null,
    "a guard that cannot measure must not block", "M-n: let the fs throw escape");

  // -- the creation-withdrawal arm: a path the brief says will be CREATED --
  check("60", "`git worktree add` in the brief WITHDRAWS the finding",
    L.detectMissingWorkdirPath(
      { prompt: "git worktree add -b b /tmp/new/lane origin/main, then cd /tmp/new/lane" },
      { existsSync: MISSING }) === null,
    "the brief creates it before entering it — not a dead spawn",
    "M-o: delete the creation-withdrawal arm");
  check("61", "`mkdir -p` in the brief WITHDRAWS the finding",
    L.detectMissingWorkdirPath(
      { prompt: "mkdir -p /tmp/new/out then cd /tmp/new/out" },
      { existsSync: MISSING }) === null,
    "same class", "M-o");
  check("62", "without a creation phrase the SAME brief DOES fire",
    !!L.detectMissingWorkdirPath({ prompt: "then cd /tmp/new/lane" }, { existsSync: MISSING }),
    "the withdrawal must be phrase-driven, not unconditional — M-o inverted",
    "M-o inverted: make the withdrawal unconditional");

  // -- severity + attribution --
  // NULL-SAFE by construction (`f?.`). An earlier draft dereferenced `f` directly, so a mutation
  // that deleted the predicate CRASHED the runner at this line instead of failing cases 63–66 —
  // still a red, but an uninformative one that masked which OTHER cases the mutation reddened.
  // Measured, not predicted: M-l / M-m / M-o each produced `<runner crashed before reporting>`
  // in the mutation matrix until this was hardened.
  {
    const f = L.detectMissingWorkdirPath(brief, { existsSync: MISSING });
    check("63", "the workdir finding is severity `block` (structural, not lexical)",
      f?.severity === "block", `severity=${f?.severity}`,
      "M-p: downgrade to halt-and-report — would make the teeth unreachable");
    check("64", "the workdir finding attributes to agents.md § Worktree Orchestration",
      f?.rule_id === "agents/worktree-orchestration-absolute-path-pin",
      `rule_id=${f?.rule_id}`,
      "re-homing the attribution silently");
    check("65", "the pre-existing findings KEEP their orchestrator-context-economy attribution",
      L.detectNamedDispatchWithoutDelivery({ name: "n", prompt: "Investigate." })?.rule_id ===
        "orchestrator-context-economy/MUST-6",
      "the new arm must not re-home the old ones", "re-home MUST-6");
    check("66", "the finding NAMES the missing path so the report is actionable",
      (f?.evidence || "").includes("/tmp/definitely-not-here/lane"),
      "evidence carries the measured fact", "blank the path from the evidence");
  }

  // -- inspectDispatch composition --
  check("67", "inspectDispatch surfaces the workdir finding alongside the lexical ones",
    L.inspectDispatch("Agent",
      { name: "lane-a", prompt: "cd /tmp/definitely-not-here/lane and investigate." },
      INV, { existsSync: MISSING }).some((f) => f.severity === "block"),
    "composition", "M-l");
  // BIPOLAR ON THE REAL FS, deliberately. An earlier draft asserted only
  // `.every(f => f.severity !== "block")` against an EXISTING path — which an EMPTY findings
  // array satisfies vacuously, so it would have passed against a deleted predicate. Both poles
  // are driven through the DEFAULT resolver: one path that exists, one that cannot.
  check("68", "inspectDispatch defaults to the REAL fs (bipolar: existing→silent, missing→block)",
    L.inspectDispatch("Agent", { prompt: `cd ${REPO} and read the rules.` }, INV).length === 0 &&
      L.inspectDispatch("Agent",
        { prompt: `cd /nonexistent-loom-probe-${process.pid}/x and read the rules.` }, INV)
        .some((f) => f.severity === "block"),
    "the positive control: the default resolver is live AND returns both answers",
    "M-q: default existsSync to a constant — either constant fails one pole");
}

// ── 15. the OVERRIDE GATE at the real hook boundary ─────────────────────────
// The root cause this change treats: detection was never the gap. The MUST-5 finding
// FIRED on the real incident and was waved past with "right as issued" — which cost
// nothing and left no record. These cases lock in that an override is now (a) possible,
// (b) ONE-SHOT, and (c) RECORDED.
{
  const G = L;
  const sb = makeHookSandbox("override");
  const RECEIPT = sb.receipt;

  // CONTAINMENT. Every spawn below runs in `sb`, a runner-created mkdtemp project dir (see the
  // HOOK-SPAWN SANDBOX block at the top), so the receipts these cases write and consume never touch
  // the checkout, and no `.claude/dispatch-authz/` directory is ever created there. That also retires
  // the earlier trace problem this block used to manage by hand: `putReceipt`'s recursive mkdir
  // created the DIRECTORY under the checkout, which `detection-binding-check.test.mjs` then red on
  // (`["dispatch-authz"] classified neither as a binding namespace nor as declared non-binding`).
  // The sandbox is removed on exit, so there is no pre-existed/rmdir bookkeeping left to get wrong.

  // A clean start: neither channel armed (`spawnHook` strips the env var), no receipt in the sandbox.
  const clearReceipt = () => { try { fs.rmSync(RECEIPT, { force: true }); } catch {} };
  const putReceipt = (reason) => {
    fs.mkdirSync(path.dirname(RECEIPT), { recursive: true });
    fs.writeFileSync(RECEIPT, reason);
  };

  /** Drive the hook as the runtime does, tolerating a NON-ZERO (blocking) exit. */
  const fireRaw = (payload, extraEnv = {}) => {
    const r = spawnHook(sb, JSON.stringify(payload), extraEnv);
    let json = null;
    try { json = JSON.parse(r.stdout); } catch {}
    return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
  };
  const ctx = (o) => o.json?.hookSpecificOutput?.additionalContext || "";

  const MISSING_PATH = "/tmp/loom-fixture-absent-" + process.pid + "/lane";
  const missingBrief = {
    hook_event_name: "PreToolUse", tool_name: "Agent",
    tool_input: { subagent_type: "general-purpose", prompt: `STEP 0: cd ${MISSING_PATH} then work there. Report back via SendMessage.` },
  };
  const presentBrief = {
    hook_event_name: "PreToolUse", tool_name: "Agent",
    tool_input: { subagent_type: "general-purpose", prompt: `STEP 0: cd ${sb.dir} then work there. Report back via SendMessage.` },
  };

  clearReceipt();
  const blocked = fireRaw(missingBrief);
  check("69", "END-TO-END: a non-existent declared workdir BLOCKS (exit 2)",
    blocked.status === 2, `exit=${blocked.status}`,
    "M-l / M-p — the teeth. This is the case that could not exist before this change.");
  check("70", "END-TO-END: the block payload denies the call",
    blocked.status === 2 && blocked.json?.continue !== false &&
      blocked.json?.hookSpecificOutput?.permissionDecision === "deny",
    `continue=${blocked.json?.continue}`, "M-p");
  check("71", "END-TO-END: the block names the missing path and the override escape",
    (blocked.stderr + JSON.stringify(blocked.json)).includes(MISSING_PATH) &&
      (blocked.stderr + JSON.stringify(blocked.json)).includes(G.OVERRIDE_RECEIPT_REL),
    "a block with an unreachable escape is the MUST NOT this answers",
    "drop the receipt path from the block body");

  const permitted = fireRaw(presentBrief);
  check("72", "END-TO-END: an EXISTING declared workdir is permitted, exit 0",
    permitted.status === 0 && permitted.json?.continue === true,
    `exit=${permitted.status}`,
    "M-m — the no-false-positive pole at the real boundary");

  // NON-BLOCKING RENDER RATIONALE. The tier's `why` explains to the agent WHY nothing was stopped,
  // and that explanation is a CLAIM ABOUT THIS GUARD's own severity model — `zero-tolerance.md`
  // Rule 3e territory, and untested until now. It read "Every finding on this tier reads the
  // brief's PROSE", which was true of all five original predicates and was FALSIFIED the moment a
  // STRUCTURAL predicate (agent-definition shadowing) joined the tier: that one could carry teeth
  // and declines them, which is a choice, not a MUST-2 cap. A rendered rationale that over-explains
  // is how an agent learns the wrong rule from a correct finding.
  const named = fireRaw({
    hook_event_name: "PreToolUse", tool_name: "Agent",
    tool_input: { name: "lane-x", subagent_type: "general-purpose", prompt: "Investigate the parser." },
  });
  check("72a", "NON-BLOCK RENDER: a halt-and-report-only dispatch is NOT stopped (exit 0, continue true)",
    named.status === 0 && named.json?.continue === true && ctx(named).includes("orchestrator-context-economy/MUST-6"),
    `exit=${named.status}`, "the precondition for 72b — without a finding the render never runs");
  check("72b", "NON-BLOCK RENDER: the rationale distinguishes the MUST-2 CAP from the declined-teeth CHOICE",
    ctx(named).includes("is a CAP") && ctx(named).includes("a deliberate CHOICE, not a cap") &&
      !ctx(named).includes("Every finding on this tier reads the brief's PROSE"),
    "", "M-dup-5: restore the blanket 'every finding reads PROSE' rationale, which the structural predicate falsifies");

  // ONE-SHOT: the receipt is honoured exactly once, then the gate re-arms.
  clearReceipt();
  putReceipt("worktree is created by the dispatched agent's own STEP-0 bootstrap");
  const overridden = fireRaw(missingBrief);
  const receiptGone = !fs.existsSync(RECEIPT);
  const reblocked = fireRaw(missingBrief);

  check("73", "END-TO-END: a valid receipt lets the blocked call through",
    overridden.status === 0 && overridden.json?.continue === true,
    `exit=${overridden.status}`, "M-r: ignore the receipt");
  check("74", "END-TO-END: the override is RECORDED with the stated reason",
    ctx(overridden).includes("STEP-0 bootstrap"),
    "the reason is echoed into agent-visible context — this is the 'recorded, not free' property",
    "M-s: honour the receipt without echoing the reason");
  check("75", "END-TO-END: the receipt is CONSUMED (deleted) as it is honoured",
    receiptGone, `gone=${receiptGone}`, "M-t: leave the receipt on disk");
  check("76", "END-TO-END: the very next identical call BLOCKS again",
    reblocked.status === 2, `exit=${reblocked.status}`,
    "the one-shot property at the real boundary — one override cannot disarm the gate", "M-t");

  // The operator/CI env channel.
  clearReceipt();
  const viaEnv = fireRaw(missingBrief, { [G.OVERRIDE_ENV]: "1" });
  check("77", "END-TO-END: the env channel lets the blocked call through",
    viaEnv.status === 0 && viaEnv.json?.continue === true,
    `exit=${viaEnv.status}`, "M-u: delete the env channel");
  check("78", "END-TO-END: the env override is RECORDED, never silent",
    ctx(viaEnv).includes(G.OVERRIDE_ENV),
    "an override that leaves no trace is the failure this change exists to fix", "M-u");

  // Fail-open arms at the real boundary.
  clearReceipt();
  const garbage = spawnHook(sb, "not json at all");
  check("79", "END-TO-END: an unparseable payload fails OPEN, exit 0",
    garbage.status === 0 && JSON.parse(garbage.stdout).continue === true,
    `exit=${garbage.status}`, "block on an unknown");

  // The LEXICAL arm must stay below block even when it fires.
  const lexicalOnly = fireRaw({
    hook_event_name: "PreToolUse", tool_name: "Agent",
    tool_input: { name: "lane-a", subagent_type: "analyst", prompt: "Create the fixture files. Return your findings." },
  });
  check("80", "END-TO-END: the LEXICAL arm fires but does NOT block (MUST-2 cap holds)",
    lexicalOnly.status === 0 && lexicalOnly.json?.continue === true && ctx(lexicalOnly).includes("MUST-5"),
    `exit=${lexicalOnly.status}`,
    "M-p inverted: promoting the lexical arm to block would violate hook-output-discipline.md MUST-2");
  // INVERTED 2026-09-12. This case used to assert the halt-and-report response OFFERED the receipt.
  // That offer was the misbinding: nothing on the non-block path consumes a receipt, so one written
  // "to record why" sat until it silently lifted the NEXT, unrelated block. Bipolar with case 71,
  // which pins that the BLOCK response still names the escape.
  check("81", "END-TO-END: the lexical (halt-and-report) response offers NO receipt; the block response still does",
    !ctx(lexicalOnly).includes(G.OVERRIDE_RECEIPT_REL) &&
      (blocked.stderr + JSON.stringify(blocked.json)).includes(G.OVERRIDE_RECEIPT_REL),
    "a receipt nothing on this path consumes would lift the NEXT block under the wrong reason",
    "M-B2: re-offer the receipt on the non-block tier");
  clearReceipt();
}

// ── 16. LANE-ORCHESTRATOR BRIEF WITHOUT PARTITION (wip-discipline MUST-9, advisory) ─────────
// IDENTITY assertions throughout, per `cc-artifacts.md` Rule 9: a firing pole asserts the exact
// rule_id, severity AND missing-element list, and every SILENT pole also asserts its full
// classification record — so a leaf that is silent for the WRONG reason (say the lane gate never
// matched) reds here instead of passing as "silent".
{
  const FX = path.join(REPO, ".claude/audit-fixtures/dispatch-contract");
  const brief = (name) => fs.readFileSync(path.join(FX, `lane-brief-${name}.txt`), "utf8");
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const cls = (namesLane, grantsCommit, leafDenial, role, missing) =>
    ({ namesLane, grantsCommit, leafDenial, role, missing });
  const ALL3 = ["fan-out", "disjoint write sets", "single committer"];
  const NO_SPLIT = ["disjoint write sets", "single committer"];
  const is9 = (f, missing) =>
    !!f && f.rule_id === "wip-discipline/MUST-9" && f.severity === "advisory" && same(f.missing, missing);
  const D = (prompt) => L.detectLaneBriefWithoutPartition({ prompt });
  const C = (prompt) => L.classifyLaneBrief(prompt);
  const LANE = "STEP 0: cd /x/repos/.loom-wt/lane-a first.\n";

  const serial = brief("flag-orchestrator-serial");
  const partitioned = brief("clean-orchestrator-partitioned");
  const leaf = brief("clean-leaf-worker");
  const leafGrant = brief("clean-leaf-worker-grant-shaped");
  const noLane = brief("clean-no-lane");
  const quoted = brief("flag-orchestrator-quoted-leaf-subbrief");
  const quotedOk = brief("clean-orchestrator-quoted-leaf-subbrief-partitioned");

  check("82", "MUST-9: a serial lane-orchestrator brief FIRES with all three elements missing",
    is9(D(serial), ALL3), JSON.stringify(D(serial) && { ...D(serial), evidence: "…" }),
    "M-9e/M-9f/M-9g drop an element test; M-9w unwire");
  check("83", "MUST-9: the advisory NAMES each missing element and cites rules/wip-discipline.md MUST-9",
    ALL3.every((m) => (D(serial)?.evidence || "").includes(m)) &&
      (D(serial)?.evidence || "").includes("rules/wip-discipline.md MUST-9"),
    "evidence carries the finding, not just a rule id");
  check("84", "MUST-9: the serial brief classifies orchestrator (lane named, grant, no denial)",
    same(C(serial), cls(true, true, false, "orchestrator", ALL3)), JSON.stringify(C(serial)));
  check("85", "MUST-9: a PARTITIONED orchestrator brief is SILENT — on COMPLIANCE, not on role",
    D(partitioned) === null && same(C(partitioned), cls(true, true, false, "orchestrator", [])),
    JSON.stringify(C(partitioned)), "M-9c: drop the missing.length gate");
  check("86", "MUST-9: a LEAF worker brief (the shape of this detector's own authoring brief) is SILENT on ROLE",
    D(leaf) === null && same(C(leaf), cls(true, false, true, "leaf", [])),
    JSON.stringify(C(leaf)), "M-9v: drop the leaf-denial veto (role reads none, not leaf)");
  check("87", "MUST-9: a leaf brief carrying a GRANT-SHAPED phrase is still SILENT — the denial VETOES",
    D(leafGrant) === null && same(C(leafGrant), cls(true, true, true, "leaf", [])),
    JSON.stringify(C(leafGrant)), "M-9v");
  check("88", "MUST-9: a brief naming NO lane worktree is SILENT even with a grant and no partition",
    D(noLane) === null && same(C(noLane), cls(false, true, false, "none", [])),
    JSON.stringify(C(noLane)), "M-9l: the lane gate always true");
  {
    const bare = LANE + "Survey the open todos in this lane and list them by age.";
    check("89", "MUST-9: a lane brief with NEITHER grant NOR denial is SILENT (not an orchestrator)",
      D(bare) === null && same(C(bare), cls(true, false, false, "none", [])),
      JSON.stringify(C(bare)), "M-9o: the grant gate always true");
  }
  check("90", "MUST-9 NEAR-MISS: denials inside a QUOTED worker sub-brief do not demote the orchestrator",
    is9(D(quoted), NO_SPLIT) && C(quoted).role === "orchestrator",
    JSON.stringify(C(quoted)), "M-9q: classify the role over the UNSTRIPPED brief");
  check("91", "MUST-9 NEAR-MISS, other pole: the same quoted brief WITH the partition is SILENT",
    D(quotedOk) === null && same(C(quotedOk), cls(true, true, false, "orchestrator", [])),
    JSON.stringify(C(quotedOk)));
  {
    const fenced = quoted
      .replace(/^> (.*)$/gm, "$1")
      .replace("worker brief:\n\n", "worker brief:\n\n```\n")
      .replace("final message.\n\nCollect", "final message.\n```\n\nCollect");
    const dq = quoted.replace(/^> (You EDIT.*)\n> (.*)$/m, '"$1 $2"');
    check("92", "MUST-9: a FENCED worker sub-brief is stripped the same way",
      fenced !== quoted && is9(D(fenced), NO_SPLIT), JSON.stringify(C(fenced)), "M-9q");
    check("93", "MUST-9: a DOUBLE-QUOTED worker sub-brief is stripped the same way",
      dq !== quoted && is9(D(dq), NO_SPLIT), JSON.stringify(C(dq)), "M-9q");
    const unquoted = quoted.replace(/^> /gm, "");
    check("94", "MUST-9: UNQUOTING that sub-brief makes the SAME words the reader's own — a leaf, silent",
      unquoted !== quoted && D(unquoted) === null && C(unquoted).role === "leaf",
      "the stripping is what separates 90 from 94; without it both read leaf");
  }

  // -- the three partition elements, each alone --
  check("95", "element: fan-out alone leaves disjoint write sets + single committer missing",
    same(L.missingPartitionElements("Dispatch agents in parallel, one per item."), NO_SPLIT), "", "M-9e");
  check("96", "element: disjoint write sets alone leaves fan-out + single committer missing",
    same(L.missingPartitionElements("Writing agents take disjoint file sets."), ["fan-out", "single committer"]), "", "M-9f");
  check("97", "element: single committer alone leaves fan-out + disjoint write sets missing",
    same(L.missingPartitionElements("You are the sole committer."), ["fan-out", "disjoint write sets"]), "", "M-9g");
  check("98", "element: the partition contract cited by name + mini-orchestrator is complete",
    same(L.missingPartitionElements("Run as a mini-orchestrator under the partition contract."), []), "");
  check("99", "element: an empty brief is missing all three, in declared order",
    same(L.missingPartitionElements(""), ALL3) && same(L.PARTITION_ELEMENTS, ALL3), "");

  // -- the lane gate --
  check("100", "lane gate: a real sibling path matches (POSIX + Windows); a doc PLACEHOLDER does not",
    L.namesLaneWorktree("cd /x/repos/.loom-wt/lane-a") === true &&
      L.namesLaneWorktree("cd C:\\r\\.loom-wt\\lane-a") === true &&
      L.namesLaneWorktree("a sibling like <parent>/.<slug>-wt/<name>") === false,
    "", "M-9l");
  check("101", "lane gate: a STEP-0 toplevel assertion counts ONLY with its branch half",
    L.namesLaneWorktree("assert `git rev-parse --show-toplevel` equals `pwd -P`") === false &&
      L.namesLaneWorktree("assert `git rev-parse --show-toplevel` and `git rev-parse --abbrev-ref HEAD`") === true,
    "", "M-9b: drop the branch half");

  // -- each LEAF-DENIAL arm, alone, vetoes a granted lane brief --
  const GRANTED = LANE + "You may commit to the lane branch when done. ";
  [
    ["102", "Do not dispatch sub-agents.", "M-9d1"],
    ["103", "No sub-agents for this one.", "M-9d2"],
    ["104", "You edit only the files listed below.", "M-9d3"],
    ["105", "Edit files only.", "M-9d4"],
    ["106", "Do not commit.", "M-9d5"],
    ["107", "No commits from you.", "M-9d6"],
  ].forEach(([id, denial, m]) => {
    const t = GRANTED + denial;
    check(id, `denial arm vetoes on its own: "${denial}"`,
      D(t) === null && same(C(t), cls(true, true, true, "leaf", [])), JSON.stringify(C(t)), m);
  });

  // -- each COMMIT-GRANT arm, alone, makes a lane brief an orchestrator --
  [
    ["108", "You are the sole committer.", ["fan-out", "disjoint write sets"], "M-9a1"],
    ["109", "You are the lane orchestrator.", ALL3, "M-9a2"],
    ["110", "You may commit when each item is green.", ALL3, "M-9a3"],
    ["111", "You have commit authority here.", ALL3, "M-9a4"],
    ["112", "Commit each item on the lane branch.", ALL3, "M-9a5"],
  ].forEach(([id, grant, missing, m]) => {
    const t = LANE + grant;
    check(id, `grant arm on its own: "${grant}"`,
      is9(D(t), missing) && same(C(t), cls(true, true, false, "orchestrator", missing)), JSON.stringify(C(t)), m);
  });

  // -- orchestrator HYGIENE naming a different object must not read as a leaf's denial --
  check("113", "hygiene: \"Never commit to main.\" does NOT veto an orchestrator brief",
    is9(D(LANE + "You are the lane orchestrator. Never commit to main."), ALL3), "", "M-9h");
  check("114", "hygiene: \"Do not commit secrets\" does NOT veto an orchestrator brief",
    is9(D(LANE + "You are the lane orchestrator. Do not commit secrets or .env files."), ALL3), "", "M-9h");

  check("115", "MUST-9 fails OPEN on absent / malformed / empty input",
    L.detectLaneBriefWithoutPartition(null) === null &&
      L.detectLaneBriefWithoutPartition(undefined) === null &&
      L.detectLaneBriefWithoutPartition({ prompt: 123 }) === null &&
      L.detectLaneBriefWithoutPartition({ prompt: "" }) === null,
    "cc-artifacts.md Rule 7");
  check("116", "MUST-9 is capped at advisory: every firing pole in this section is `advisory`",
    [serial, quoted, LANE + "You are the lane orchestrator."].every((t) => D(t)?.severity === "advisory"),
    "prose signal — hook-output-discipline.md MUST-2", "M-9s: raise to halt-and-report");
  check("117", "inspectDispatch SURFACES the MUST-9 finding (wired, not merely written)",
    L.inspectDispatch("Agent", { prompt: serial }, INV, { existsSync: () => true })
      .filter((f) => f.rule_id === "wip-discipline/MUST-9").length === 1,
    "", "M-9w: unwire from inspectDispatch");
  {
    const named = L.inspectDispatch("Agent", { name: "lane-w6", prompt: serial }, INV, { existsSync: () => true })
      .map((f) => f.rule_id);
    check("118", "a NAMED serial lane brief carries MUST-6 and MUST-9 exactly once each",
      same(named, ["orchestrator-context-economy/MUST-6", "wip-discipline/MUST-9"]),
      JSON.stringify(named), "M-9w");
  }
}

// ── 17. MUST-9 at the REAL hook boundary ────────────────────────────────────
// The library cases above cannot see the guard's render path, which is exactly how this guard once
// shipped inert while 42 library cases stayed green (§ 13). The lane fixtures name a path that does
// not exist on this machine, which would route them into the BLOCK tier, so the path token is
// re-pointed at this section's sandbox dir, which exists; the lane gate then holds through the
// fixture's STEP-0 branch assertion (a sandbox dir is never a `-wt` sibling).
{
  const sb = makeHookSandbox("must9");
  const FX = path.join(REPO, ".claude/audit-fixtures/dispatch-contract");
  // ONE interpolation site. `dir` is a parameter rather than a second copy of the token: a
  // duplicated literal is the drift mechanism that lets a case keep asserting against a prompt
  // the substitution no longer reaches.
  const atRepo = (name, dir = sb.dir) =>
    fs.readFileSync(path.join(FX, `lane-brief-${name}.txt`), "utf8")
      .split("/Users/op/repos/.loom-wt/wip-ledger").join(dir);
  const RECEIPT = sb.receipt;
  const RECEIPT_DIR = path.dirname(RECEIPT);
  const clearReceipt = () => { try { fs.rmSync(RECEIPT, { force: true }); } catch {} };
  const fire = (tool_input) => {
    const r = spawnHook(sb, JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input }));
    let json = null;
    try { json = JSON.parse(r.stdout); } catch {}
    const lines = r.stdout.split("\n").filter((l) => l.trim() !== "").length;
    return { status: r.status, json, lines, ctx: json?.hookSpecificOutput?.additionalContext || "" };
  };

  try {
    clearReceipt();
    const serial = fire({ subagent_type: "general-purpose", prompt: atRepo("flag-orchestrator-serial") });
    check("119", "END-TO-END MUST-9: a serial lane-orchestrator brief is NOT blocked (exit 0, continue:true)",
      serial.status === 0 && serial.json?.continue === true, `exit=${serial.status}`, "M-9s inverted to block");
    check("120", "END-TO-END MUST-9: the advisory names the rule, all three missing elements, and its class",
      ["wip-discipline/MUST-9", "fan-out", "disjoint write sets", "single committer",
        "rules/wip-discipline.md MUST-9", "[advisory]"].every((t) => serial.ctx.includes(t)),
      `ctx chars=${serial.ctx.length}`, "M-9w");
    check("121", "END-TO-END MUST-9: rendered at the PRE-ACTION register — the dispatch has NOT run",
      serial.ctx.startsWith("NOT BLOCKED — the action has NOT run yet."),
      JSON.stringify(serial.ctx.slice(0, 60)), "M-G2: render at `advisory` (\"the action proceeded\" — false here)");
    check("122", "END-TO-END MUST-9: an advisory-only dispatch offers NO override receipt",
      !serial.ctx.includes(L.OVERRIDE_RECEIPT_REL), "nothing to override", "M-G1");

    fs.mkdirSync(RECEIPT_DIR, { recursive: true });
    const REASON = "operator reason written for a blocked call, not for this advisory";
    fs.writeFileSync(RECEIPT, REASON);
    const withReceipt = fire({ subagent_type: "general-purpose", prompt: atRepo("flag-orchestrator-serial") });
    const kept = fs.existsSync(RECEIPT) && fs.readFileSync(RECEIPT, "utf8") === REASON;
    clearReceipt();
    check("123", "END-TO-END MUST-9: an advisory-only dispatch does NOT CONSUME a pending receipt",
      kept && withReceipt.ctx.includes("wip-discipline/MUST-9"), `kept=${kept}`,
      "M-G1: construct the gate on advisory-only findings (the receipt is spent and the notice replaces the advisory)");

    const named = fire({ name: "lane-w6", subagent_type: "general-purpose", prompt: atRepo("flag-orchestrator-serial") });
    // INVERTED 2026-09-12 (see case 81): a non-block response no longer offers the receipt.
    check("124", "END-TO-END: MUST-6 + MUST-9 arrive in ONE response, and that non-block response offers NO receipt",
      named.status === 0 && named.lines === 1 &&
        named.ctx.includes("orchestrator-context-economy/MUST-6") &&
        named.ctx.includes("wip-discipline/MUST-9") &&
        !named.ctx.includes(L.OVERRIDE_RECEIPT_REL),
      `exit=${named.status} lines=${named.lines}`, "never double-fire; M-B2");

    const leaf = fire({ subagent_type: "general-purpose", prompt: atRepo("clean-leaf-worker") });
    // ASSERTS THE ABSENCE IT CLAIMS. Until 2026-09-14 this case tested only
    // `!ctx.includes("wip-discipline/MUST-9")`, so a fixture named CLEAN drew a
    // `worktree-isolation/MUST-10` advisory on EVERY host and the suite still reported green
    // — the brief's containment line carried MUST-10's PIN half with no ASSERTION half, which
    // `fixtureContainmentOf` scores `pin-without-assertion`. MUST-10 is halt-and-report, so
    // exit stayed 0 and nothing surfaced it. A clean pole that cannot detect its own
    // contamination is not a control, so the assertion is now TOTAL silence.
    check("125", "END-TO-END MUST-9: a leaf worker brief draws NO finding AT ALL",
      leaf.status === 0 && leaf.ctx === "" && leaf.json?.continue === true,
      `exit=${leaf.status} continue=${leaf.json?.continue} ctx chars=${leaf.ctx.length}${
        leaf.ctx ? ` ctx=${JSON.stringify(leaf.ctx.slice(0, 400))}` : ""
      }`, "M-9v; drop the brief's STEP-0 assertion half and MUST-10 reappears");
    const ok = fire({ subagent_type: "general-purpose", prompt: atRepo("clean-orchestrator-partitioned") });
    // The detail QUOTES the context rather than counting it. `ctx chars=1904`
    // is a TALLY, and a tally cannot say WHICH predicate spoke — this case
    // failed exactly once, on a CI host, and the log carried only the number,
    // so the finding was undiagnosable from the evidence it produced
    // (`instrument-discipline.md` MUST-3(b): read the hits, not the tally).
    check("126", "END-TO-END MUST-9: a partitioned orchestrator brief is fully SILENT",
      ok.status === 0 && ok.ctx === "" && ok.json?.continue === true,
      `exit=${ok.status} continue=${ok.json?.continue} ctx chars=${ok.ctx.length}${
        ok.ctx ? ` ctx=${JSON.stringify(ok.ctx.slice(0, 400))}` : ""
      }`, "M-9c");

    // ── REGRESSION PIN: the verdict must be a property of the BRIEF, never of the HOST ──
    // `atRepo` interpolates `sb.dir` into the brief, so every word in the runner's TMPDIR
    // reaches predicates that match PROSE. MEASURED: this fleet's self-hosted runner roots
    // TMPDIR under a home directory whose leading segment ENDS IN A BUILD VERB — the literal
    // path is recorded once, on the never-synced surface, at
    // `.claude/test-harness/tests/helpers/sun-path.mjs:13`, and is deliberately NOT reproduced
    // here: this file SHIPS (`audit-fixtures/**` is tier-matched) and an operator-home-shaped
    // path on a synced surface is exactly what the #263 disclosure gate exists to refuse.
    // That segment supplies
    // `\bbuild\b` — `-` and `/` are non-word characters, so both boundaries land — which is the
    // ONE token `detectUnpinnedFixtureDispatch`'s `buildsRepo` conjunction lacked: the NOUN half
    // was ALREADY satisfied on every host by the brief's own `"STOP: not a git repo"`. Case 126
    // therefore drew a `worktree-isolation/MUST-10` advisory on CI and nowhere else, and had sat
    // one token from firing since it landed. The briefs now carry MUST-10's PIN form, so the
    // finding is suppressed on COMPLIANCE rather than on the accident of which words the ambient
    // path happens to contain.
    //
    // The path CANNOT simply be dropped: a brief naming a directory that does not exist routes
    // into the BLOCK tier (see this section's header), which is why it is re-pointed at a real
    // sandbox in the first place. So immunity is asserted instead of assumed — this case rebuilds
    // the CI condition on EVERY host from a real directory whose own name carries the verb as a
    // bounded word. It REDS if any brief loses its containment clause.
    //
    // The `/\bbuild\b/` precondition is load-bearing per `cc-artifacts.md` Rule 9: without it a
    // silent pole would pass when the verb FAILED to reach the prompt, i.e. for the wrong reason.
    // It MUST test the DELIVERED PROMPT, never the directory string it was built from:
    // `path.join(x, "ci-build-home")` always contains `build`, so a precondition reading `verbDir`
    // is a TAUTOLOGY — it cannot return false, and a check that cannot fail is not a control
    // (`instrument-discipline.md` MUST-1). Measured: with the interpolation token drifted, the
    // prompt falls back to the RAW brief (whose "builds" does not match `\bbuild\b`), the detector
    // returns null, ctx is "" — and a verbDir-reading precondition still reports true, passing the
    // case vacuously for exactly the reason this comment claims it prevents.
    const verbDir = path.join(sb.dir, "ci-build-home");
    fs.mkdirSync(verbDir, { recursive: true });
    const verbPrompt = atRepo("clean-orchestrator-partitioned", verbDir);
    const hostShaped = fire({ subagent_type: "general-purpose", prompt: verbPrompt });
    const verbReached = /\bbuild\b/i.test(verbPrompt);
    check("139", "ENV-INDEPENDENCE: a partitioned brief stays SILENT when the sandbox path ITSELF carries a build verb — the verdict is the brief's property, not the host's TMPDIR naming",
      verbReached && hostShaped.status === 0 && hostShaped.ctx === "" &&
        hostShaped.json?.continue === true,
      `verb-in-path=${verbReached} exit=${hostShaped.status} continue=${hostShaped.json?.continue} ctx chars=${hostShaped.ctx.length}${
        hostShaped.ctx ? ` ctx=${JSON.stringify(hostShaped.ctx.slice(0, 400))}` : ""
      }`, "M-10h: drop the brief's CONTAINMENT clause and the ambient path decides the verdict");
  } finally {
    clearReceipt();
  }
}

// ── 18. OVERRIDE BINDING + FULL BLOCK RENDER + RUNNER ISOLATION (2026-09-12) ─
// Two guard defects, each pinned by a bipolar pair with IDENTITY preconditions (each precondition
// asserts the exact severity + rule_id set the library produces for the brief, so a case cannot pass
// because its brief silently stopped drawing the finding it is about):
//   (a) a dispatch whose findings were all non-block RESOLVED the override, consuming a receipt an
//       operator wrote for a blocked call; the blocked call then had none.
//   (b) a BLOCK response rendered only the blocking evidence, dropping every other finding.
// Plus the lock for the HOOK-SPAWN SANDBOX at the top of this file.
{
  const sb = makeHookSandbox("binding");
  const inv = L.readAgentInventory(sb.dir);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const classes = (list) => list.map((f) => `${f.severity} ${f.rule_id}`).sort();
  const fire = (tool_input) => {
    const r = spawnHook(sb, JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input }));
    let json = null;
    try { json = JSON.parse(r.stdout); } catch {}
    return {
      status: r.status, json, stderr: r.stderr || "",
      ctx: json?.hookSpecificOutput?.additionalContext || "",
      reason: json?.hookSpecificOutput?.permissionDecisionReason || "",
    };
  };
  const REASON = "operator override written for the BLOCKED lane-b dispatch only";
  const readReceipt = () => { try { return fs.readFileSync(sb.receipt); } catch { return null; } };
  const putReceipt = () => {
    fs.mkdirSync(path.dirname(sb.receipt), { recursive: true });
    fs.writeFileSync(sb.receipt, REASON + "\n");
  };
  const findingLines = (s) => s.split("\n").filter((l) => l.startsWith("- ["));

  // -- (a) pole 1: halt-and-report ONLY, with a receipt pending --
  const HALT = { name: "lane-a", subagent_type: "analyst", prompt: "Create the fixture files. Return your findings." };
  const haltF = L.inspectDispatch("Agent", HALT, inv);
  check("127", "BINDING precondition: the brief under test carries halt-and-report findings ONLY (identity)",
    same(classes(haltF), ["halt-and-report orchestrator-context-economy/MUST-5", "halt-and-report orchestrator-context-economy/MUST-6"]),
    JSON.stringify(classes(haltF)));
  putReceipt();
  const pending = readReceipt();
  const halt = fire(HALT);
  const afterHalt = readReceipt();
  check("128", "BINDING: a halt-and-report-only dispatch leaves a pending receipt PRESENT and BYTE-IDENTICAL",
    pending !== null && afterHalt !== null && Buffer.compare(pending, afterHalt) === 0,
    `after=${afterHalt === null ? "DELETED" : "present"}`, "M-B1: resolve the override on non-block findings");
  check("129", "BINDING: ...records NO override: a NOT-BLOCKED pre-action report of both findings, no reason echoed",
    halt.status === 0 && halt.json?.continue === true &&
      halt.ctx.startsWith("NOT BLOCKED — the action has NOT run yet.") &&
      halt.ctx.includes("- [halt-and-report] orchestrator-context-economy/MUST-5: ") &&
      halt.ctx.includes("- [halt-and-report] orchestrator-context-economy/MUST-6: ") &&
      !halt.ctx.includes("OVERRIDDEN") && !halt.ctx.includes("Override HONOURED") && !halt.ctx.includes(REASON),
    JSON.stringify(halt.ctx.slice(0, 60)), "M-B1");
  check("130", "BINDING: ...and OFFERS no receipt",
    !halt.ctx.includes(L.OVERRIDE_RECEIPT_REL), "", "M-B2: re-offer the receipt on the non-block tier");

  // -- (a) pole 2: the SAME pending receipt meets the blocked call it was written for --
  const BLOCK = {
    subagent_type: "general-purpose",
    prompt: `STEP 0: cd /tmp/loom-fixture-absent-${process.pid}-binding/lane then work there. Report back via SendMessage.`,
  };
  const blockF = L.inspectDispatch("Agent", BLOCK, inv);
  const overridden = fire(BLOCK);
  const afterBlock = readReceipt();
  check("131", "BINDING other pole: that SAME receipt is CONSUMED by the block dispatch, its reason recorded",
    same(classes(blockF), ["block agents/worktree-orchestration-absolute-path-pin"]) &&
      afterBlock === null && overridden.status === 0 && overridden.json?.continue === true &&
      overridden.ctx.includes("Override HONOURED via one-shot receipt") && overridden.ctx.includes(REASON),
    `exit=${overridden.status} receipt=${afterBlock === null ? "consumed" : "present"}`,
    "without this pole a guard that never honours a receipt passes 128-130");

  // -- (b) block + halt-and-report + advisory on ONE brief, no receipt --
  const MIXED = {
    name: "lane-w6", subagent_type: "general-purpose",
    prompt: fs.readFileSync(path.join(REPO, ".claude/audit-fixtures/dispatch-contract/lane-brief-flag-orchestrator-serial.txt"), "utf8")
      .split("/Users/op/repos/.loom-wt/wip-ledger").join(`/nonexistent-loom-probe-${process.pid}/repos/.loom-wt/lane-mixed`),
  };
  const mixedF = L.inspectDispatch("Agent", MIXED, inv);
  const mixed = fire(MIXED);
  check("132", "BLOCK RENDER precondition: ONE brief carrying block + halt-and-report + advisory (identity)",
    same(classes(mixedF), [
      "advisory wip-discipline/MUST-9",
      "block agents/worktree-orchestration-absolute-path-pin",
      "halt-and-report orchestrator-context-economy/MUST-6",
    ]),
    JSON.stringify(classes(mixedF)));
  check("133", "BLOCK RENDER: the response is still a BLOCK (exit 2, deny, STOP head — and no halt)",
    mixed.status === 2 && mixed.json?.continue !== false &&
      mixed.json?.hookSpecificOutput?.permissionDecision === "deny" &&
      mixed.reason.startsWith("STOP — Tool call blocked."),
    `exit=${mixed.status}`, "the non-block findings must not soften the block");
  check("134", "BLOCK RENDER: EVERY finding is rendered, one line each, each under its OWN class",
    same(findingLines(mixed.reason).map((l) => l.slice(0, l.indexOf(": "))).sort(),
      mixedF.map((f) => `- [${f.severity}] ${f.rule_id}`).sort()),
    JSON.stringify(findingLines(mixed.reason).map((l) => l.slice(0, 70))),
    "M-B3: drop the non-blocking findings from the block render");
  check("135", "BLOCK RENDER: the stderr delivery channel of a denied call carries the same full list",
    mixedF.length === 3 && mixedF.every((f) => mixed.stderr.includes(`- [${f.severity}] ${f.rule_id}: `)),
    "", "M-B3");
  check("136", "BLOCK RENDER: the report asks for the NON-block findings to be answered, not only the path",
    mixed.reason.includes("Name each NON-block finding's rule_id"), "", "drop the non-block report line");
  const solo = fire(BLOCK);
  check("137", "BLOCK RENDER other pole: a BLOCK-ONLY brief renders exactly its one finding and asks nothing about non-block ones",
    solo.status === 2 && findingLines(solo.reason).length === 1 && blockF.length === 1 &&
      !solo.reason.includes("Name each NON-block finding's rule_id"),
    `exit=${solo.status} lines=${findingLines(solo.reason).length}`,
    "a render that adds phantom lines, or asks about findings that are not there");

  // -- runner isolation: the hook is started from ONE place, and every sandbox is outside the checkout --
  const SRC = fs.readFileSync(new URL(import.meta.url), "utf8");
  const START_RX = new RegExp("\\b(?:spawnSync|execFileSync|execSync|spawn|execFile|exec|fork)\\(", "g");
  const starts = SRC.match(START_RX) || [];
  check("138", "ISOLATION: the hook is started from exactly ONE call site (the sandbox-pinned spawnHook), and all 4 sandboxes sit outside the checkout",
    starts.length === 1 && sandboxes.length === 4 &&
      sandboxes.every((s) => within(s.dir, TMP_REAL) && !within(s.dir, REPO_REAL)),
    `start sites=${starts.length} sandboxes=${sandboxes.length}`,
    "M-S2: a section that starts the hook directly again");
}

let failed = 0;
for (const c of cases) {
  const tag = c.pass ? "PASS" : "FAIL";
  if (!c.pass) failed++;
  process.stdout.write(`${tag}  ${c.id}  ${c.name}  [${c.detail}]\n`);
}
process.stdout.write(`\n${cases.length - failed}/${cases.length} cases pass\n`);
process.exit(failed === 0 ? 0 : 1);
