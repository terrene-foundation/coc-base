/**
 * instruct-and-wait — canonical hook output shape for the graduated-trust system.
 *
 * Delivery-channel contract (verified against the CC hook docs 2026-06-09 —
 * loom #466). The host injects agent-facing context ONLY via documented fields;
 * arbitrary sibling fields (`validation`, `message`, `suppressOutput`) are
 * SILENTLY DROPPED — the agent never sees them:
 *   Stop / SessionEnd / PreCompact         → top-level `systemMessage`
 *                                            (`hookSpecificOutput` dropped here)
 *   PreToolUse / PostToolUse /             → `hookSpecificOutput.additionalContext`
 *     UserPromptSubmit / SessionStart        (non-block)
 *   PreToolUse BLOCK                       → exit code 2; the host feeds stderr
 *                                            back to the agent (additionalContext
 *                                            is NOT read once the call is denied)
 *
 * History (CRIT-1 + #466): the prior shape emitted `hookSpecificOutput.validation`,
 * a custom field CC drops — so the structured body (`what_happened`/`why`/
 * `agent_must_report`) reached the agent on NO event; only the `user_summary`
 * stderr line survived. This file is the canonical shape `hook-output-discipline.md`
 * MUST-1 mandates for every halting hook, so the drop degraded the structured
 * handoff fleet-wide.
 *
 * Severities:
 *   - block            tool call BLOCKED. Only meaningful at PreToolUse.
 *   - halt-and-report  tool ran (or event already fired); agent must surface and wait.
 *   - advisory         soft warning; the tool RAN; agent acknowledges, may proceed.
 *   - pre-action       PreToolUse only: the call is NOT blocked and has NOT run yet.
 *   - post-mortem      forensic only (Stop-class events); surfaces at next SessionStart.
 */

const STOP_LIKE_EVENTS = new Set(["Stop", "SessionEnd", "PreCompact"]);

function buildValidationBody({
  hookEvent,
  severity,
  what_happened,
  why,
  agent_must_report,
  agent_must_wait,
}) {
  // loom#1590 — PROSE REGISTER IS LOAD-BEARING; the heads must be readable as
  // an outcome, not just a mood.
  //
  // Both `block` and `halt-and-report` used to open "STOP — ", so the only
  // thing separating "your call was denied" from "your call already ran" was
  // whether the tool result happened to carry an error. That is not a
  // distinction an agent can make from the TEXT, and the two guards are
  // otherwise identical in register. Observed consequence: an agent read an
  // advisory posture-gate halt as a block, and separately an agent committed
  // under one — the hook text arrived in the same tool result as the successful
  // exit code. Every non-block head now states the ACTION'S FATE in its first
  // words, so the outcome is legible without inspecting the transport.
  //
  // loom#1715 H-1 — THE FATE INVARIANT HAD NO PRE-ACTION REGISTER, and a
  // PreToolUse GUIDE-FIRST surface has no head that is TRUE. Measured on
  // `git push origin HEAD` against the T4 CI-cost delivery, a PreToolUse
  // non-block finding: the rendered head read "the action ALREADY RAN" while
  // the push had not run at all, and the delivery's own closing line is "no
  // check has judged your push. Read it and decide" — an agent told the action
  // already happened has no decision left to make. The `advisory` head is wrong
  // for the same reason ("the action proceeded" — it has not). So the register
  // is ADDED rather than an existing one reused: `pre-action` is the only head
  // that states a PreToolUse non-block fate truthfully.
  //
  // AND IT IS GATED ON THE LIFECYCLE MOMENT, not applied globally. This renderer
  // serves BOTH PreToolUse and PostToolUse, whose truth conditions are OPPOSITE:
  // at PostToolUse the action genuinely HAS run, so "ALREADY RAN" is CORRECT
  // there and rewriting it would trade one false head for a worse one — e.g.
  // `session-notes-guard.js`'s PostToolUse arm, which is `halt-and-report` and
  // is right to be. Measured before this clause: the head was selected by
  // SEVERITY ALONE and was identical across all seven hook events, so a bare
  // `pre-action` branch would have rendered "has NOT run yet" at PostToolUse
  // and at the Stop-class events too. Gating it on PreToolUse makes this whole
  // change a STRICT NO-OP at every other event — at those, `pre-action` falls
  // through to the same advisory head an unrecognized severity already got, so
  // the rendered bytes are identical to pre-fix. That is measured across the
  // full 7-event × 6-severity matrix in ci-cost-reach.test.mjs, not reasoned.
  const isPreAction = severity === "pre-action" && hookEvent === "PreToolUse";
  // loom FINDING-F — the SAME lifecycle-gating the `pre-action` clause above
  // establishes, applied to the opposite end of the register. A STOP_LIKE event
  // CANNOT block a tool call: the branch below returns `{continue:true}` and exit
  // 0 for EVERY severity including `block`. But the head was still selected by
  // SEVERITY ALONE at this point — it is computed BEFORE that branch — so a
  // block-class Stop finding was delivered to the agent reading
  // "STOP — Tool call blocked." while nothing whatsoever was blocked.
  //
  // Measured end-to-end on `burndown-quote-stop-guard.js` (the one production
  // emitter of block at a STOP_LIKE event): the payload was
  // `{"continue":true,"systemMessage":"STOP — Tool call blocked.\n\nWHAT
  // HAPPENED: The reply contains 1 INVALID burndown quote(s)…"}` at rc=0. That is
  // the OVERCLAIM class in the output of the very rule whose text
  // (`burndown-integrity.md` § Trust Posture Wiring) and whose guard header both
  // go to length insisting Stop severity must NOT be read as teeth.
  //
  // The severity stays `block` — it records the finding's CLASS honestly, which
  // is what that rule deliberately does. What changes is the head, which reports
  // the FATE. Class and fate are different facts and only the second was wrong.
  // Gated exactly like `isPreAction`, so this is a STRICT NO-OP at the four
  // non-STOP_LIKE events, where "Tool call blocked." remains true and remains
  // pinned verbatim by settings-deny-edit-guard.test.mjs and
  // posture-gate-mutation-fence.test.mjs (both PreToolUse denies).
  const isUnblockableBlock = severity === "block" && STOP_LIKE_EVENTS.has(hookEvent);
  const head = isUnblockableBlock
    ? "NOT BLOCKED — this event cannot block. Block-class finding; the output ALREADY STANDS. Correct it and report."
    : severity === "block"
      ? // Kept verbatim: it is the one head that means "did not run", and
        // settings-deny-edit-guard.test.mjs pins this exact string.
        "STOP — Tool call blocked."
      : severity === "halt-and-report"
        ? "NOT BLOCKED — the action ALREADY RAN. Report it and wait."
        : isPreAction
          ? "NOT BLOCKED — the action has NOT run yet. Read this, then decide."
          : severity === "post-mortem"
            ? "POST-MORTEM — already happened; recorded for next session."
            : "ADVISORY — the action proceeded. Acknowledge in next message.";
  const reportBlock =
    Array.isArray(agent_must_report) && agent_must_report.length
      ? "REPORT TO USER (do not skip any):\n" +
        agent_must_report.map((x) => "  - " + x).join("\n")
      : "";
  const waitBlock = agent_must_wait ? "THEN: " + agent_must_wait : "";
  return [
    head,
    "",
    "WHAT HAPPENED: " + what_happened,
    "WHY: " + why,
    "",
    reportBlock,
    "",
    waitBlock,
  ]
    .filter((l) => l !== null && l !== undefined)
    .join("\n");
}

/**
 * Build the JSON output for a hook. The caller decides exit code separately
 * (severity=block → exit 2 at PreToolUse; everything else → exit 0).
 */
function instructAndWait({
  hookEvent,
  severity, // "block" | "halt-and-report" | "advisory" | "post-mortem"
  what_happened,
  why,
  agent_must_report,
  agent_must_wait,
  user_summary,
}) {
  const validation = buildValidationBody({
    // loom#1715 — the RENDERER needs the lifecycle moment, because `pre-action`
    // is only true at PreToolUse. `buildValidationBody` is module-private (the
    // exports below are `instructAndWait` / `emit` / `STOP_LIKE_EVENTS`), so
    // this is an internal parameter, NOT a public signature change; every
    // caller already passes `hookEvent` to `instructAndWait`.
    hookEvent,
    severity,
    what_happened,
    why,
    agent_must_report,
    agent_must_wait,
  });

  // 1. User-facing stderr line (mitigates user-visibility hole)
  if (user_summary) {
    const tag = severity.toUpperCase();
    process.stderr.write(`[${tag}] ${user_summary}\n`);
    process.stderr.write(
      `        See agent message for required report. (${why})\n`,
    );
  }

  // 2. Event-aware JSON shape (mitigates CRIT-1 + #466 dropped-channel bug).
  if (STOP_LIKE_EVENTS.has(hookEvent)) {
    // Stop / SessionEnd / PreCompact — hookSpecificOutput is dropped; use systemMessage
    // `continue: true` always — these events cannot block tool calls
    return {
      json: { continue: true, systemMessage: validation },
      exitCode: 0,
    };
  }

  if (severity === "block") {
    // PreToolUse block ONLY. Exit code 2 is the proven, UNCHANGED block trigger
    // (the structural teeth at L2/L3 per trust-posture.md); on exit 2 the host
    // feeds stderr back to the agent, so the FULL instruction body goes to
    // stderr — that is the agent's delivery channel for a denied call
    // (additionalContext is NOT read once the call is blocked). The
    // permissionDecision/Reason pair carries the same body via the canonical
    // structured PreToolUse field for hosts that parse it; exit 2 remains
    // authoritative so the block teeth do not depend on it.
    process.stderr.write("\n" + validation + "\n");
    return {
      json: {
        continue: false,
        hookSpecificOutput: {
          hookEventName: hookEvent,
          permissionDecision: "deny",
          permissionDecisionReason: validation,
        },
      },
      exitCode: 2,
    };
  }

  // Non-block (halt-and-report / advisory / post-mortem) at
  // PreToolUse / PostToolUse / UserPromptSubmit / SessionStart — the body
  // reaches the agent ONLY via additionalContext.
  return {
    json: {
      continue: true,
      hookSpecificOutput: {
        hookEventName: hookEvent,
        additionalContext: validation,
      },
    },
    exitCode: 0,
  };
}

/**
 * Helper: emit + exit. For use at hook script bottom.
 */
function emit(payload) {
  const out = instructAndWait(payload);
  process.stdout.write(JSON.stringify(out.json) + "\n");
  process.exit(out.exitCode);
}

module.exports = { instructAndWait, emit, STOP_LIKE_EVENTS };
