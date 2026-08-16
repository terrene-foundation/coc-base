#!/usr/bin/env node
/**
 * dispatch-contract-guard.js — the ENFORCING half of the dispatch contract
 * (`orchestrator-context-economy.md` MUST-5 + MUST-6).
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
 * NEVER BLOCKS — `halt-and-report` is the ceiling, and that is a CAP, not a preference.
 * `hook-output-discipline.md` MUST-2 forbids `block` on a lexical signal. Both predicates carry a
 * lexical half: MUST-6 reads the brief for a push-delivery instruction, and MUST-5 reads it for
 * write intent. MUST-5's OTHER half — the target agent's declared `tools:` frontmatter — is a
 * parsed document field and would be fencing-grade on its own (MUST-5(a)), but a detector is no
 * stronger than its weakest half, so the composed finding is capped. Stated here rather than left
 * implied, per `hook-output-discipline.md` MUST-5(b): this hook can annotate a bad dispatch, and it
 * can never stop one. `{continue:true}` and exit 0 on EVERY path including the timeout fallback.
 *
 * FAILS OPEN ON EVERY UNKNOWN. Unparseable payload, unreadable agents dir, agent type with no file
 * (`general-purpose`, `Explore`, and every other built-in), missing `tools:` line — all return no
 * findings. A guard that guesses when it cannot see is a guard the orchestrator learns to ignore.
 *
 * WRITES NOTHING. No sink, no ledger, no prompt text retained; findings go to the advisory surface
 * with bounded evidence. The dispatch-ledger sink is T1's job and this hook does not touch it.
 *
 * DEGRADES SAFELY WHERE THE AGENT CORPUS IS ABSENT. `.claude/hooks/**` is ALWAYS_INCLUDE so this
 * ships to every consumer; a consumer with no `.claude/agents/` yields an empty inventory, every
 * MUST-5 lookup is UNKNOWN, and only the MUST-6 arm stays live. That is degradation to a smaller
 * true answer, never to a false clean.
 *
 * Origin: co-owner-directed origination 2026-08-16; see `orchestrator-context-economy.md` § Origin.
 */

"use strict";

// Bounded timer per `cc-artifacts.md` Rule 7, deliberately under the registered 5s timeout so this
// hook's OWN fallback fires first and emits a well-formed passthrough.
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

fallback = setTimeout(() => passthrough(null), TIMEOUT_MS);
if (typeof fallback.unref === "function") fallback.unref();

/** Render findings into one bounded advisory block. */
function renderAdvisory(findings) {
  const lines = [
    "⚠ Dispatch-contract advisory (orchestrator-context-economy) — halt-and-report, not a block.",
    "",
  ];
  for (const f of findings) {
    lines.push(`- [${f.severity}] ${f.rule_id}: ${f.evidence}`);
  }
  lines.push("");
  lines.push(
    "Surface this and correct the dispatch, or state why it is right as issued. " +
      "This hook cannot stop the call — both predicates read prose, and " +
      "`hook-output-discipline.md` MUST-2 caps a lexical signal below `block`.",
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

  let lib;
  try {
    lib = require(path.join(__dirname, "lib", "dispatch-contract.js"));
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
  return passthrough(renderAdvisory(findings));
}

main().catch(() => passthrough(null));
