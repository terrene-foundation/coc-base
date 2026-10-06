#!/usr/bin/env node
/**
 * dispatch-contract-guard.js — the ENFORCING half of the dispatch contract.
 *
 * Complements, and deliberately does NOT duplicate, the T1 telemetry pair
 * (`emit-dispatch-ledger.js` + `reconcile-dispatch-delivery.js`). Those RECORD what happened and
 * reconcile it at `SubagentStop` — after the lane has already run. This one inspects the dispatch
 * BEFORE it is issued, at the only moment the brief and the requested agent type are both present
 * and the dispatch is still cheap to fix. The T1 reconciler tells you a lane went idle; this tells
 * you the brief was going to make it go idle.
 *
 * @hook-event: PreToolUse:Task|Agent (guard) — the dispatch IS the subject: the brief, the
 *   dispatch NAME and the requested subagent type live in `tool_input` at this moment and nowhere
 *   else, and this is the last instant before a mis-briefed lane consumes a full agent turn. The
 *   matcher is exactly the delegation-tool set; a `*` matcher would pay a node spawn on every
 *   Read/Bash/Grep to reach an immediate passthrough, and `hook-event-selection.md` MUST-3 FAILs a
 *   narrow class registered without a matcher.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THREE SEVERITY TIERS, AND WHY THE LINES FALL WHERE THEY DO
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * `hook-output-discipline.md` MUST-2 reserves `block` for a structural signal a surface rewrite
 * cannot evade, and FORBIDS it for a lexical match over prose. This hook carries both kinds, so it
 * carries graded tiers — stated explicitly rather than left implied, per MUST-5(b):
 *
 *   ADVISORY (never blocks; never spends or offers a receipt) — `wip-discipline` MUST-9.
 *     `detectLaneBriefWithoutPartition` reads a lane-orchestrator brief for the fan-out /
 *     partition instruction (`journal/0607` decisions 1–2, delivered at dispatch time per
 *     `journal/0608` item 6). Every half is prose, and the miss costs throughput rather than a
 *     wasted turn, so it sits BELOW halt-and-report.
 *
 * All non-block findings render in ONE response through `lib/instruct-and-wait.js::emit` at the
 * `pre-action` register (see `emitNonBlocking`), so two predicates on one brief never double-fire.
 *
 *   HALT-AND-REPORT (never blocks; never spends or offers a receipt) —
 *     `orchestrator-context-economy` MUST-5 + MUST-6.
 *     MUST-6 reads the brief for a push-delivery instruction; MUST-5 reads it for write intent.
 *     MUST-5's OTHER half (the target agent's declared `tools:` frontmatter) is a parsed document
 *     field and would be fencing-grade alone, but a detector is no stronger than its weakest half,
 *     so the composed finding is CAPPED. This tier can annotate a bad dispatch; it can never stop
 *     one. Promoting it would be a MUST-2 violation.
 *
 *   BLOCK — `agents/worktree-orchestration-absolute-path-pin`.
 *     The verdict is `fs.existsSync` on an absolute path the brief names as the lane's working
 *     directory: a filesystem FACT, the exact class MUST-2 names as block-grade. The prose half
 *     here is only a SCOPE GATE (which token to test), not the verdict — so the "weakest half"
 *     reasoning that caps the tier above does not transfer. Full argument in
 *     `lib/dispatch-contract.js` § (c).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE OVERRIDE — why this hook grew one, and what it is actually fixing
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * DETECTION WAS NEVER THE GAP. On the originating incident the MUST-5 finding FIRED, correctly, on
 * a brief that demanded file mutation from a read-only agent. The orchestrator answered "right as
 * issued — the brief is read-only", which was FALSE (the brief also demanded a bipolar control
 * requiring a mutation). The lane ran ~119k tokens and delivered nothing. Overriding a correct
 * finding cost NOTHING and left NO RECORD.
 *
 * So the BLOCK tier routes through the shared audited-override gate in `lib/override-receipt.js`:
 * a non-empty REASON written to a one-shot receipt (agent-reachable), or an operator/CI env var.
 * The receipt is CONSUMED as it is honoured, so one override cannot disarm the gate for later
 * calls, and the stated reason is ECHOED into agent-visible context. A BLOCK response renders EVERY
 * finding on the brief, each under its own class (`renderFindingLines`), so a MUST-6 or MUST-9 line
 * riding on a blocked brief is not hidden behind the block.
 *
 * THE NON-BLOCK TIERS NEVER TOUCH THE RECEIPT, neither consuming nor offering it (2026-09-12). An
 * earlier revision resolved the override for `halt-and-report` findings too and offered the receipt
 * there, reasoning that the originating incident was a waved-past halt-and-report and a receipt
 * RECORDS the wave. That was a misbinding, because the receipt names no call: a dispatch this hook
 * cannot stop SPENT a receipt an operator had written for a blocked call, echoed that reason against
 * the wrong dispatch, and left the blocked call with no override; and a receipt written for a
 * non-block call was never consumed by it, so it sat until it lifted the NEXT, unrelated block. The
 * record for a halt-and-report is now the one-line reason its response requires in the agent's next
 * message — weaker than a receipt, and the accepted price of never spending one on the wrong call.
 * The receipt is still unbound AMONG block-class calls (one written for one blocked dispatch lifts
 * whichever blocked dispatch arrives first); closing that needs a call-bound receipt in the shared
 * lib, which all three consuming guards would have to adopt together.
 *
 * FAILS OPEN ON EVERY UNKNOWN (`cc-artifacts.md` Rule 7). Unparseable payload, unreadable agents
 * dir, agent type with no file (`general-purpose`, `Explore`, every other built-in), missing
 * `tools:` line, no absolute path named, an `existsSync` that throws, the internal timer blowing —
 * all return `{continue:true}`. A guard that cannot measure must not block, and a guard that
 * guesses when it cannot see is one the orchestrator learns to ignore.
 *
 * WRITES NOTHING except CONSUMING a receipt it was handed, and only on a dispatch carrying a
 * block-class finding. No sink, no ledger, no prompt text
 * retained; findings go to the advisory surface with bounded, sanitized evidence. The
 * dispatch-ledger sink is T1's job and this hook does not touch it.
 *
 * DEGRADES SAFELY WHERE THE AGENT CORPUS IS ABSENT. `.claude/hooks/**` is ALWAYS_INCLUDE so this
 * ships to every consumer; a consumer with no `.claude/agents/` yields an empty inventory, every
 * MUST-5 lookup is UNKNOWN, and the MUST-6 + workdir arms stay live. That is degradation to a
 * smaller true answer, never to a false clean.
 *
 * Origin: co-owner-directed origination 2026-08-16 (`orchestrator-context-economy.md` § Origin);
 * the blocking tier + the audited override added 2026-08-23 after the override-costs-nothing
 * incident above and a sibling incident in the same session — an agent dispatched at a worktree
 * path that did not exist, which no guard checked.
 */

"use strict";

// Bounded timer per `cc-artifacts.md` Rule 7, deliberately under the registered 5s timeout so this
// hook's OWN fallback fires first and emits a well-formed passthrough. This hook spawns no
// subprocess; the only I/O is a bounded stdin read, a shallow agents-dir walk, and at most a few
// `existsSync` calls, so 4000ms is generous.
const TIMEOUT_MS = 4000;
let fallback = null;

const path = require("node:path");
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

function passthrough(context) {
  if (fallback) clearTimeout(fallback);
  try {
    const out = { continue: true };
    if (context) {
      out.hookSpecificOutput = {
        hookEventName: "PreToolUse",
        additionalContext: context,
      };
    }
    process.stdout.write(JSON.stringify(out) + "\n");
  } catch {}
  process.exit(0);
}

/**
 * One line per finding, each under its OWN severity class. The single renderer every response in
 * this hook uses — block, override notice, non-block, and fallback — so no path can list a subset.
 */
function renderFindingLines(findings) {
  return findings.map((f) => `- [${f.severity}] ${f.rule_id}: ${f.evidence}`).join("\n");
}

/** Render the advisory emitted when an override was honoured. The RECORD. */
function renderOverrideNotice(override, findings, gate) {
  const lines = [
    "⚠ Dispatch-contract gate OVERRIDDEN — the override was honoured, not the gate.",
    "",
    gate.formatOverrideLine(override),
    "",
    "Findings present on the overridden dispatch (the override lifted the [block] line only):",
    renderFindingLines(findings),
  ];
  lines.push("");
  lines.push(
    "State in your next message that this gate was overridden and why. If the override was a " +
      "mistake, cancel the dispatch now — it has not been corrected, only permitted.",
  );
  return lines.join("\n");
}

async function main() {
  // `readStdinBounded()` resolves the PARSED payload (or its `{}` fallback) — NOT raw text. An
  // earlier revision called `JSON.parse()` on the result, which threw on every well-formed input
  // and made this hook silently inert; it was caught by driving the real stdin boundary, never by
  // the library fixtures, which do not exercise this seam.
  let payload;
  try {
    payload = await readStdinBounded();
  } catch {
    return passthrough(null); // Unreadable payload is an UNKNOWN, not a violation.
  }

  const p = payload && typeof payload === "object" ? payload : {};
  const tool = p.tool_name || p.tool || "";

  let lib, overrideLib;
  try {
    lib = require(path.join(__dirname, "lib", "dispatch-contract.js"));
    overrideLib = require(path.join(__dirname, "lib", "override-receipt.js"));
  } catch {
    return passthrough(null);
  }

  if (!lib.DELEGATION_TOOLS.includes(tool)) return passthrough(null);

  let findings = [];
  try {
    const inventory = lib.readAgentInventory(PROJECT_DIR);
    findings = lib.inspectDispatch(tool, p.tool_input, inventory);
  } catch {
    return passthrough(null);
  }

  if (findings.length === 0) return passthrough(null);

  const blocking = findings.filter((f) => f.severity === "block");

  // NO BLOCK-CLASS FINDING ⇒ NO OVERRIDE GATE, on EVERY non-block tier — `advisory` AND
  // `halt-and-report`. There is nothing to override on a call this hook does not stop, and the
  // receipt is one-shot but bound to NO call: `resolveOverride` is `envOverride(env) ||
  // consumeReceipt()` (`lib/override-receipt.js:406-408`), which unlinks the first non-empty
  // candidate it reads (`:342-399`). Resolving it here would SPEND a receipt an operator wrote for
  // a blocked call, echo that operator's reason against this different dispatch, and leave the
  // blocked call with no override when it is retried.
  if (blocking.length === 0) {
    return emitNonBlocking(tool, findings);
  }

  // The gate is constructed ONLY once a block-class finding exists — construction is cheap, but
  // `resolveOverride` CONSUMES a receipt, and a receipt must only ever be spent on the call it can lift.
  let gate;
  try {
    gate = overrideLib.createOverrideGate({
      receiptRel: lib.OVERRIDE_RECEIPT_REL,
      envVar: lib.OVERRIDE_ENV,
      // The MAIN project root as well as the invoking cwd, so an operator's receipt is found even
      // when the call is issued from inside a linked worktree. `CLAUDE_PROJECT_DIR` is already
      // resolved for us, so this needs no git subprocess and the hook's budget is untouched.
      extraRoots: () => [PROJECT_DIR],
    });
  } catch {
    // A misconfigured gate must not wedge the session. Without an override channel the safest
    // behavior is a non-blocking report only — never a block the agent has no way to lift.
    return passthrough(
      renderFallback(findings, "override channel unavailable, so the block degrades to this report"),
    );
  }

  // Reached ONLY with a block-class finding present (the `blocking.length === 0` return above). Env
  // is checked before the receipt inside the gate, so a CI run cannot silently spend the agent's
  // one-shot receipt.
  const override = gate.resolveOverride();
  if (override) {
    return passthrough(renderOverrideNotice(override, findings, gate));
  }

  {
    // Load `emit` lazily: it is needed on the rendering paths only, and the clean and off-matcher
    // paths in this hook must stay free of its module cost.
    let emit;
    try {
      ({ emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js")));
    } catch {
      // Cannot render a well-formed block ⇒ degrade to a plain report rather than emit a
      // malformed refusal. Fail-open, per Rule 7.
      return passthrough(renderFallback(findings, "renderer unavailable"));
    }
    const nonBlocking = findings.length - blocking.length;
    if (fallback) clearTimeout(fallback);
    emit({
      hookEvent: "PreToolUse",
      severity: "block",
      // EVERY finding, each on its own line under its OWN class. The response is a block because a
      // `[block]` line is present; a MUST-6 or MUST-9 line riding on the same brief keeps the class
      // it would have had alone. An earlier revision rendered only the blocking evidence here, so a
      // brief that was BOTH at a missing path AND, say, a serial lane-orchestrator brief lost the
      // second finding: the agent fixed the path, re-issued, and only then met the advisory.
      what_happened:
        `This ${tool} dispatch names a working directory that does not exist, and drew ` +
        `${findings.length} dispatch-contract finding(s). The [block] line(s) stop the call; ` +
        `every other line keeps its own class and would not have blocked on its own:\n` +
        renderFindingLines(findings),
      why:
        "agents.md § Worktree Orchestration — the ORCHESTRATOR creates the worktree and pins its " +
        "ABSOLUTE path in the prompt. A path that is absent at dispatch time cannot become present " +
        "for the lane: its STEP-0 assertion refuses, and the whole agent turn is spent discovering " +
        "that. Unlike this hook's other findings, this verdict is `fs.existsSync` — a filesystem " +
        "fact, which hook-output-discipline.md MUST-2 names as block-grade.",
      agent_must_report: [
        `Quote the blocked dispatch and the missing path(s): ${blocking
          .flatMap((f) => f.missing || [])
          .map((m) => overrideLib.safeField(m, "?"))
          .join(", ")}.`,
        "REMEDIATION (preferred) — create the worktree/directory FIRST, then re-issue with the " +
          "path that now exists:\n" +
          "      git worktree add -b <branch> <ABSOLUTE-sibling-path> <base-ref>\n" +
          "    and keep the STEP-0 assertion in the brief (cd first, then assert " +
          "`git rev-parse --show-toplevel` equals `pwd -P`, refusing on mismatch).",
        ...(nonBlocking > 0
          ? [
              "Name each NON-block finding's rule_id above and correct the brief for it as well, " +
                "or state in one line why it is right as issued — the override below lifts the " +
                "block only and answers none of them.",
            ]
          : []),
        gate.formatOverrideInstruction(),
      ],
      agent_must_wait:
        "Do not retry this dispatch unmodified. Either create the path first (preferred), or " +
        `write a one-line reason to ${lib.OVERRIDE_RECEIPT_REL} and retry.`,
      user_summary:
        `agents/worktree-orchestration-absolute-path-pin — blocked a ${tool} dispatch naming a ` +
        `non-existent working directory` +
        (nonBlocking > 0 ? ` (+${nonBlocking} non-block finding(s))` : ""),
    });
    return; // emit() exits; unreachable.
  }
}

/**
 * Render EVERY non-block finding in ONE response through the shared renderer
 * (`lib/instruct-and-wait.js::emit`), so two predicates firing on one brief — MUST-6 and
 * wip-discipline MUST-9 on a named lane-orchestrator brief, say — reach the orchestrator as one
 * report, never as two.
 *
 * `severity: "pre-action"` is the RENDER register, not a re-grading of any finding: each finding
 * keeps its own class on its `[severity]` line. It is the only head that is TRUE at PreToolUse —
 * `halt-and-report` renders "the action ALREADY RAN" and `advisory` renders "the action
 * proceeded", and the dispatch has done neither (`instruct-and-wait.js` § loom#1715 H-1; the same
 * correction `wip-discipline-guard.js` records for its own pending-dispatch report).
 *
 * NO OVERRIDE RECEIPT IS CONSUMED OR OFFERED on this path, at either class. The call is not
 * stopped, so there is nothing to lift; and a receipt written "to record why" would not be consumed
 * by THIS call, so it would sit until it silently lifted the NEXT, unrelated block under a reason
 * written for something else. The record for this tier is the one-line reason the report requires.
 */
function emitNonBlocking(tool, findings) {
  let emit;
  try {
    ({ emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js")));
  } catch {
    // Cannot render through the shared shape ⇒ degrade to the plain report rather than drop the
    // findings. Fail-open, per `cc-artifacts.md` Rule 7.
    return passthrough(renderFallback(findings, "renderer unavailable"));
  }
  const ruleIds = [...new Set(findings.map((f) => f.rule_id))];
  if (fallback) clearTimeout(fallback);
  emit({
    hookEvent: "PreToolUse",
    severity: "pre-action",
    what_happened:
      `This ${tool} dispatch has NOT been issued yet and drew ${findings.length} ` +
      `dispatch-contract finding(s):\n` +
      renderFindingLines(findings),
    why:
      "No finding on this tier carries teeth — this hook cannot stop the call. For the prose-reading " +
      "predicates that is a CAP: hook-output-discipline.md MUST-2 forbids `block` on a lexical " +
      "signal. For `agents/agent-definition-shadowing` it is a deliberate CHOICE, not a cap — its " +
      "evidence is two files on disk and would permit teeth, which are declined because the repo " +
      "defect it reports is not one this dispatch introduced. All findings are rendered in this one " +
      "response, so predicates firing on the same brief never double-fire. No override receipt " +
      "applies here: nothing is blocked, so there is nothing to lift.",
    agent_must_report: [
      "Name each finding's rule_id, then either correct the brief before issuing it or state in " +
        "one line, in your next message, why it is right as issued — that stated line is the " +
        "record for this tier.",
    ],
    agent_must_wait:
      "Correct the dispatch and re-issue it, or proceed with your stated reason — this is not a block.",
    user_summary: `dispatch-contract — ${ruleIds.join(", ")} on a ${tool} dispatch (not blocked)`,
  });
}

/**
 * Plain rendering for the degraded paths (no renderer, or no override channel). Keeps every finding
 * visible, each under its own class, without offering an escape that would not work.
 */
function renderFallback(findings, note) {
  return [
    `⚠ Dispatch-contract findings — NOT blocked (${note}).`,
    "",
    renderFindingLines(findings),
  ].join("\n");
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js).
function hookMain() {
  fallback = setTimeout(() => passthrough(null), TIMEOUT_MS);
  if (typeof fallback.unref === "function") fallback.unref();
  return main().catch(() => passthrough(null));
}

module.exports = { hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
