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
 * Pure functions against in-memory inputs plus one throwaway tmpdir for the frontmatter walk. No
 * network, no live session, no sink.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const REPO = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const L = require(path.join(REPO, ".claude/hooks/lib/dispatch-contract.js"));

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
  const { execFileSync } = await import("node:child_process");
  const HOOK = path.join(REPO, ".claude/hooks/dispatch-contract-guard.js");
  const fire = (payload) => {
    const out = execFileSync("node", [HOOK], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
    });
    return JSON.parse(out);
  };

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

let failed = 0;
for (const c of cases) {
  const tag = c.pass ? "PASS" : "FAIL";
  if (!c.pass) failed++;
  process.stdout.write(`${tag}  ${c.id}  ${c.name}  [${c.detail}]\n`);
}
process.stdout.write(`\n${cases.length - failed}/${cases.length} cases pass\n`);
process.exit(failed === 0 ? 0 : 1);
