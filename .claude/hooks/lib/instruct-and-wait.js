/**
 * instruct-and-wait — canonical hook output shape for the graduated-trust system.
 *
 * Delivery-channel contract (verified against the CC hook docs 2026-06-09 —
 * loom #466). The host injects agent-facing context ONLY via documented fields;
 * arbitrary sibling fields (`validation`, `message`, `suppressOutput`) are
 * SILENTLY DROPPED — the agent never sees them:
 *   Stop / SessionEnd / PreCompact         → top-level `systemMessage`
 *                                            (`hookSpecificOutput` dropped here)
 *   Stop, OPT-IN REFUSAL ONLY              → top-level `decision:"block"` + `reason`
 *                                            (see § Stop hand-back refusal below)
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
 * Delivery obligation: whenever a payload carries `agent_must_report`, the
 * rendered body also carries `DELIVERY_INSTRUCTION` — the channel the report
 * must travel on, stated separately for a subagent (SendMessage to its
 * orchestrator) and for a top-level session (its next message to the human).
 * See that constant for the measured failure it closes.
 *
 * Severities:
 *   - block            tool call BLOCKED. Only meaningful at PreToolUse.
 *   - halt-and-report  tool ran (or event already fired); agent must surface and wait.
 *   - advisory         soft warning; the tool RAN; agent acknowledges, may proceed.
 *   - pre-action       PreToolUse only: the call is NOT blocked and has NOT run yet.
 *   - post-mortem      forensic only (Stop-class events); surfaces at next SessionStart.
 *
 * § STOP HAND-BACK REFUSAL (opt-in, default OFF, added 2026-08-20)
 *
 * The STOP_LIKE branch below hardcoded `{continue:true}` under the comment "these events cannot
 * block tool calls". That sentence is TRUE and ANSWERS A DIFFERENT QUESTION: `Stop` is not a tool
 * call, so of course it cannot block one — it does NOT follow that `Stop` cannot refuse the
 * HAND-BACK. Measured 2026-08-20 (three arms, one tree — the table is in `stop-refusal.js`):
 * `{"decision":"block","reason":"…"}` at `Stop` refuses the hand-back, fires the hook a second
 * time with `stop_hook_active:true`, and delivers `reason` to the model AS INSTRUCTION;
 * `{"continue":false,"stopReason":"…"}` is byte-indistinguishable from the control and does
 * nothing at this event.
 *
 * THE CAPABILITY IS STRICTLY OPT-IN AND IS NEVER INFERRED FROM `severity`. `severity: "block"` at
 * a STOP_LIKE event MUST stay non-refusing: `burndown-quote-stop-guard.js` emits exactly that
 * shape on purpose, and both its header and `burndown-integrity.md` insist it is NOT teeth.
 * Refusal arrives only through the separate `refuseHandback` parameter, so it is a STRICT NO-OP
 * for every caller that does NOT pass it, pinned byte-for-byte across the full event × severity
 * matrix by `stop-refusal-contract.test.mjs`.
 *
 * SUPERSEDED 2026-08-27 — this paragraph read "which no shipped hook passes", and that was TRUE
 * from 2026-08-20 until the first producer landed. It is now FALSE and is corrected rather than
 * quietly rewritten, because the INERTNESS was the thing the sentence was cited for. The mechanism
 * shipped measured, fixture-covered and rule-documented with ZERO callers for seven days — which
 * is precisely `artifact-stranding.md` MUST-3 ("a shipped mechanism names its PRODUCER, or records
 * its inertness"), and the remedy for that class is to supply the producer, not to keep recording
 * the absence. The adopter set is now DECLARED and gated: `stop-refusal-contract.test.mjs`
 * ::REFUSAL_ADOPTERS is the allowlist, ::REFUSAL_BARRED names the hooks that must never adopt, and
 * an undeclared adoption REDS. See that file's `F-adoption-allowlist` test.
 *
 * LOOP SAFETY IS STRUCTURAL, NOT DOCUMENTED. `assertRefusalShape` THROWS unless the caller hands
 * over the RAW hook payload, because the library — not the caller — reads `stop_hook_active` off
 * it. A caller-derived boolean (`stopHookActive: false`) is refused by name. A hook that gets the
 * shape wrong therefore crashes at `Stop` WITHOUT emitting a refusal, which is itself fail-open:
 * no `decision:"block"` reaches the host, so the hand-back proceeds exactly as it does today.
 */

const STOP_LIKE_EVENTS = new Set(["Stop", "SessionEnd", "PreCompact"]);

/**
 * Validate an opt-in refusal request. PURE — no I/O, no `require` — so the gate cannot be
 * bypassed by a missing sibling module the way the BUDGET can (the budget's absence fails OPEN to
 * non-refusing, which is safe; a missing SHAPE gate would be a silent hole, which is not).
 *
 * THROWS `TypeError` on every unsafe shape. This is a static authoring error, caught by the
 * caller's own tests; `cc-artifacts.md` Rule 7's fail-open obligation is satisfied by the fact
 * that a throw at `Stop` produces no refusal at all.
 */
function assertRefusalShape(hookEvent, r) {
  const bad = (m) => {
    throw new TypeError(`instruct-and-wait: refuseHandback ${m}`);
  };
  if (hookEvent !== "Stop") {
    // SessionEnd and PreCompact were NOT probed. Claiming refusal works there would be the same
    // read-an-instrument-for-a-question-it-never-answered error this capability exists to repair.
    bad(
      `is only supported at hookEvent "Stop" (got ${JSON.stringify(hookEvent)}) — refusal at ` +
        "SessionEnd / PreCompact is UNMEASURED and MUST NOT be assumed",
    );
  }
  if (r === null || typeof r !== "object" || Array.isArray(r)) {
    bad(
      `MUST be a plain object (got ${Array.isArray(r) ? "array" : typeof r})`,
    );
  }
  // THE LOOP-SAFETY GATE. The caller may not pre-digest the host's re-invocation flag; it hands
  // over the payload and this library reads the flag itself. A caller that could pass a boolean
  // could pass `false` forever, which is precisely the wedge.
  if ("stopHookActive" in r || "stop_hook_active" in r) {
    bad(
      "MUST NOT carry a caller-derived `stopHookActive` / `stop_hook_active` — pass the raw " +
        "hook payload as `payload` and let this library read the flag",
    );
  }
  if (
    r.payload === null ||
    typeof r.payload !== "object" ||
    Array.isArray(r.payload)
  ) {
    bad(
      "MUST carry `payload` — the RAW parsed hook stdin object, which is where " +
        "`stop_hook_active` is read from",
    );
  }
  if (typeof r.repoDir !== "string" || r.repoDir.trim() === "") {
    bad(
      "MUST carry a non-empty string `repoDir` (the refusal-budget containment root)",
    );
  }
  if (
    typeof r.budgetKey !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(r.budgetKey)
  ) {
    bad(
      "MUST carry a `budgetKey` matching /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ — it scopes the " +
        "refusal budget to ONE guard, so two guards cannot spend each other's slots",
    );
  }
  if (r.maxRefusals !== undefined && !Number.isInteger(r.maxRefusals)) {
    bad(
      "`maxRefusals`, when supplied, MUST be an integer (it is clamped to 1..7, strictly " +
        "below the host's own 8-consecutive-block override)",
    );
  }
  return true;
}

/**
 * THE DELIVERY CLAUSE — `agent_must_report` says WHAT to report; until this
 * landed, nothing in the payload said HOW, and the omission had a measured cost.
 *
 * Measured three times in ONE session (2026-08-16), identical shape each time:
 * a guard correctly refused a lane's tool call, the lane therefore emitted no
 * payload, and the lane went idle WITH NO SUMMARY. A no-summary idle is
 * indistinguishable from completion, so the orchestrator had no signal at all —
 * all three were recovered only because it swept `git status --porcelain` across
 * every worktree on a hunch, finding 7 uncommitted files, then 286 insertions,
 * then a coherent reader+writer pair, none of which has a reflog. The guards
 * were RIGHT every time; the loss was entirely in the reporting step.
 *
 * The diagnosis, from one of the affected lanes: "the refusal arrives as a tool
 * error, and its instruction is 'report to user' — an agent that reads 'do not
 * retry the same form' and has no other channel open will re-plan silently."
 *
 * THE PAYLOAD IS NOT SILENT — IT IS MIS-ADDRESSED, and that is what this block
 * fixes. A fifth occurrence was REPORTED BY THE AFFECTED AGENT ITSELF, in real
 * time (relayed to this lane by the orchestrator; not measured here): "I had a
 * summary drafted and was about to re-plan the mutation harness silently";
 * "the refusal text told me to report to a 'user' it never identified, and a
 * subagent's user is you, reachable only by SendMessage." So the imperative is
 * READ and INTENDED to be obeyed — a well-behaved agent complies with an
 * instruction whose recipient resolves to nobody. The repair is therefore to
 * NAME THE RECIPIENT, not to shout the imperative louder; the head asks WHO
 * "user" means rather than exhorting the agent to try harder.
 *
 * WHY "REPORT TO USER" IS NOT ENOUGH, AND WHY THIS TEXT IS DUAL-AUDIENCE.
 * The one renderer serves two readers with DIFFERENT correct actions:
 *   - a SUBAGENT, whose "user" is its ORCHESTRATOR, reachable only by a
 *     SendMessage tool call — its reply text goes into a transcript nobody
 *     reads until the agent returns, which on a refusal it may never do;
 *   - the TOP-LEVEL session, whose user IS a human reading the terminal, for
 *     whom the reply text is exactly the right channel and a SendMessage would
 *     be wrong (there is no orchestrator to address).
 * So the instruction cannot simply be rewritten to name SendMessage — that
 * would be false for the top-level reader, trading one silent audience for
 * another. It is written as a SELF-CLASSIFYING pair: the agent always knows
 * whether another agent launched it, so exactly one branch applies and both
 * branches are literally true as written.
 *
 * WHY THE HOOK DOES NOT BRANCH ON THE CONTEXT ITSELF — measured, not assumed.
 * CC does carry a discriminator: `provenance-capture-tool.js` records that
 * top-level `agent_id` / `agent_type` are populated ONLY when a call originates
 * inside a subagent, absent for a main-agent call (empirically confirmed
 * 2026-06-30, receipt journal/0370). Branching on it is still REFUSED, for four
 * reasons, three of them structural:
 *   1. This renderer never receives it. `lib/runtime.js::parseHook` returns
 *      { runtime, event, toolName, toolInput, prompt, sessionId, cwd,
 *      projectDir } — `agent_id` is not in the canonical payload (measured: 0
 *      occurrences in runtime.js), and `instructAndWait` takes no such field.
 *   2. Getting it here means threading it through all 59 emitting call sites —
 *      the N-divergent-copies outcome the single-source constraint forbids.
 *   3. The signal is ABSENCE, and absence is not discrimination: "no agent_id"
 *      is equally consistent with a main agent, a non-CC runtime (Codex,
 *      Gemini), and an event that never carries the field. A subagent under
 *      Codex would be told it is top-level — the same silent failure, now with
 *      false confidence (`instrument-discipline.md` MUST-1/MUST-3).
 *   4. The attribution is documented for PreToolUse; this renderer serves all
 *      seven events, and the Stop-class ones are exactly where a lane goes
 *      idle. Reading a PreToolUse-scoped instrument at Stop is MUST-4.
 * A first-person check (this lane is itself a subagent) was ATTEMPTED and is
 * UNANSWERED, not confirming: no provenance ledger exists in this session's
 * `.claude/learning/`, so nothing could be read either way.
 * Cost of not branching: two lines of text. Cost of branching wrongly: the
 * whole failure back, addressed confidently to nobody. The "REPORT TO USER" heading in
 * `buildValidationBody` below is kept VERBATIM (it is pinned by four suites and
 * by the audit fixtures, and it is the correct heading for both readers) — this
 * block adds the missing channel, it does not restate or soften the obligation.
 *
 * Deliberately NOT weakening anything: no severity, exit code, threshold or
 * refusal condition is touched. This is additive text on a payload that was
 * already being emitted, and it renders exactly when the REPORT block renders —
 * one predicate, so "there is a report to make" and "here is how to deliver it"
 * can never diverge. `hook-output-discipline.md` MUST-1 requires every halting
 * hook to populate `agent_must_report` with >=1 entry, so on the refusal surface
 * that predicate is always true (measured: 59 of 59 emitting call sites across
 * .claude/hooks/ pass it, 58 literally and one by spread).
 *
 * Exported so tests pin the SOURCE constant rather than a re-typed copy, and so
 * any future surface composes it instead of hand-writing a 21st variant — 20
 * hooks can currently refuse or halt, and every one of them renders through this
 * function (`security.md` § Enforcement-Surface Parity — one shared source, not N
 * hand-written copies that drift).
 */
const DELIVERY_INSTRUCTION = [
  'WHO "USER" MEANS HERE — resolve it before you comply:',
  "  - Launched by another agent? Your user IS that orchestrator, reachable ONLY",
  "    by a SendMessage tool call. Your reply text does not reach them, so",
  "    writing the report is not sending it.",
  "  - Top-level session? Your user is the human reading this terminal; the",
  "    report goes in your next message.",
  "  Either way the report is owed BEFORE you re-plan or retry a different form.",
  "  Reporting is not a retry and needs no permission.",
].join("\n");

function buildValidationBody({
  hookEvent,
  severity,
  what_happened,
  why,
  agent_must_report,
  agent_must_wait,
  refusal,
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
  const isUnblockableBlock =
    severity === "block" && STOP_LIKE_EVENTS.has(hookEvent);
  // 2026-08-20 — the THIRD application of the same lifecycle-gating discipline the `pre-action`
  // and `isUnblockableBlock` clauses above establish. When an opt-in refusal actually FIRES, BOTH
  // of those heads are false: the hand-back was refused, so "this event cannot block" understates
  // it and every "NOT BLOCKED" head misreports the fate. This branch is reached ONLY when
  // `refusal.refuse === true`, which requires the caller to have passed `refuseHandback` — so it
  // is a STRICT NO-OP for every caller that does not pass `refuseHandback`, at every event, at
  // every severity. (It read "every current caller" until 2026-08-27, when the first producer
  // landed; see the correction at the header's § STOP HAND-BACK REFUSAL.) The head also
  // STATES ITS OWN BOUND, because an agent told it cannot hand back needs to know that this
  // terminates: the next hand-back proceeds regardless.
  const isRefusing = !!(refusal && refusal.refuse);
  const head = isRefusing
    ? "HAND-BACK REFUSED — you are NOT done; this turn CONTINUES. Act on this now, then stop. " +
      `(Refusal ${refusal.count}/${refusal.max} this session; after that the hand-back proceeds regardless.)`
    : isUnblockableBlock
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
  const hasReport =
    Array.isArray(agent_must_report) && agent_must_report.length > 0;
  const reportBlock = hasReport
    ? "REPORT TO USER (do not skip any):\n" +
      agent_must_report.map((x) => "  - " + x).join("\n")
    : "";
  // Bound to the SAME predicate as the report block (see DELIVERY_INSTRUCTION
  // above): a channel with nothing to send would be noise, and a report with no
  // channel is the defect this closes. Sequenced report -> channel -> THEN so it
  // reads as WHAT, then HOW, then NEXT.
  const deliveryBlock = hasReport ? DELIVERY_INSTRUCTION : "";
  const waitBlock = agent_must_wait ? "THEN: " + agent_must_wait : "";
  return [
    head,
    "",
    "WHAT HAPPENED: " + what_happened,
    "WHY: " + why,
    "",
    reportBlock,
    // Spread rather than a fixed slot: when there is no report block there is no
    // delivery block either, and the array is then EXACTLY the pre-change one —
    // so a payload that renders no report renders byte-identical output. The
    // change is provably additive, not a reflow.
    ...(deliveryBlock ? ["", deliveryBlock] : []),
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
  refuseHandback, // OPT-IN Stop hand-back refusal; see § STOP HAND-BACK REFUSAL. Default OFF.
}) {
  // Resolved BEFORE the body is rendered, because the HEAD depends on the verdict. `refusal`
  // stays `null` unless the caller opted in, and `null` is what every pre-existing code path
  // below sees — which is why this whole capability is byte-invisible to current callers.
  let refusal = null;
  if (refuseHandback !== undefined && refuseHandback !== null) {
    // The SHAPE gate is pure and local — it cannot be skipped. It THROWS.
    assertRefusalShape(hookEvent, refuseHandback);
    try {
      // The BUDGET is a sibling module and is loaded LAZILY, so a non-refusing caller pays no
      // module load. If it cannot be loaded at all we CANNOT bound a refusal, so we do not make
      // one — the finding still reaches the agent through the ordinary `systemMessage` channel.
      // That is `cc-artifacts.md` Rule 7's fail-open, degrading to TODAY'S behaviour.
      refusal = require("./stop-refusal.js").refusalVerdict(
        hookEvent,
        refuseHandback,
      );
    } catch (e) {
      refusal = {
        refuse: false,
        reason: `budget-unavailable: ${e && e.message ? e.message : String(e)}`,
        count: 0,
        max: 0,
      };
    }
  }

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
    refusal,
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
    if (refusal && refusal.refuse) {
      // MEASURED SHAPE, not inferred. The probe's refusing arm emitted exactly these two keys and
      // exit 0; `continue` is deliberately ABSENT because the third arm measured `continue:false`
      // as byte-indistinguishable from the control at this event, and adding an unmeasured key to
      // a measured payload is how a verified contract quietly becomes an assumed one.
      return {
        json: { decision: "block", reason: validation },
        exitCode: 0,
      };
    }
    // Stop / SessionEnd / PreCompact — hookSpecificOutput is dropped; use systemMessage.
    // `continue: true` — the DEFAULT, and unchanged. NOTE the prior comment here read "these
    // events cannot block tool calls", which is true and is not the reason: these events cannot
    // block a tool call because they are not tool calls, but `Stop` CAN refuse the hand-back (see
    // § STOP HAND-BACK REFUSAL). Non-refusal here is a DEFAULT, not a limitation.
    return {
      json: { continue: true, systemMessage: validation },
      exitCode: 0,
    };
  }

  if (severity === "block") {
    // A block at PreToolUse / PostToolUse / UserPromptSubmit / SessionStart (the STOP_LIKE
    // events returned above). Exit code 2 is the proven, UNCHANGED block trigger
    // (the structural teeth at L2/L3 per trust-posture.md); on exit 2 the host
    // feeds stderr back to the agent, so the FULL instruction body goes to
    // stderr — that is the agent's delivery channel for a denied call
    // (additionalContext is NOT read once the call is blocked). The
    // permissionDecision/Reason pair carries the same body via the canonical
    // structured PreToolUse field for hosts that parse it; exit 2 remains
    // authoritative so the block teeth do not depend on it.
    process.stderr.write("\n" + validation + "\n");
    // NO `continue: false`. That field does not mean "deny this call" — it ENDS THE AGENT'S
    // TURN ("hook stopped continuation"), so every block also silenced the agent that was
    // meant to read the reason and re-plan: the operator had to type a message to resume a
    // session the hook had already fully answered. The deny is complete without it:
    // `permissionDecision: "deny"` refuses the call, exit 2 is the authoritative teeth, and
    // both hand the body back to the agent, which is the whole point of this helper's
    // report-then-resolve contract. Codex parity is unaffected: codex-mcp-guard/server.js
    // denies on exit 2 OR permissionDecision "deny" as well as continue:false.
    return {
      json: {
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

module.exports = {
  instructAndWait,
  emit,
  STOP_LIKE_EVENTS,
  assertRefusalShape,
  DELIVERY_INSTRUCTION,
};
