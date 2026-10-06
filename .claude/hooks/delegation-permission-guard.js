#!/usr/bin/env node
/**
 * delegation-permission-guard.js — the detector for the ASK arm of
 * `orchestrator-context-economy.md` MUST-3 ("Delegation Is The DEFAULT, Not An Escalation The
 * Human Requests"). It fires when a turn's substance was REQUESTING AUTHORIZATION to dispatch
 * subagents — permission `agents.md` § Triad already grants by default.
 *
 * @hook-event: Stop (lifecycle) — THE ONLY EVENT AT WHICH THE SUBJECT EXISTS.
 *
 *   WHY `PreToolUse` CANNOT WORK, and this is structural rather than a preference: the violation
 *   is the ABSENCE of a dispatch plus the PRESENCE of a request for one. `PreToolUse:Task|Agent`
 *   fires when a dispatch HAPPENS. No PreToolUse hook can fire on a call that is never made, and
 *   the whole failure mode is that the call was not made. `SubagentStop` is blind for the same
 *   reason — no subagent stops in a session that dispatched none. `UserPromptSubmit` sees the
 *   HUMAN's text, not the agent's. The request lives in the agent's own assistant message, which
 *   exists only once the turn has produced it, and `Stop` is the event that fires then.
 *
 *   The SIGNAL is reachable there: a `Stop` payload carries `transcript_path` (and sometimes an
 *   inline `last_assistant_text`), and `lib/transcript-read.js::readFinalAssistantText` recovers
 *   the newest text-bearing assistant message from a bounded tail read.
 *
 *   THE MEASUREMENT THAT AUTHORIZED THIS HOOK, recorded because an earlier reading said the class
 *   was undetectable. That reading measured that the harness constraint producing the ask ("do not
 *   call the delegation tool unless the user requested it") lives in the SYSTEM PROMPT and appears
 *   in NEITHER the hook payload NOR the transcript file. Both facts are TRUE. They answer the
 *   wrong question — the `instrument-discipline.md` MUST-4 shape. The violation is not the
 *   constraint's presence; it is the agent's own message asking for the lift, which is in the
 *   transcript by construction. The CAUSE is invisible; the cause was never the subject.
 *
 *   CLASS is `lifecycle`, not `guard`: `hook-event-selection.md` MUST-3 defines the narrow classes
 *   by the one action or artifact they act on, which requires a Pre/PostToolUse matcher. `Stop`
 *   carries no tool axis, so claiming `guard` would claim a matcher the event cannot carry.
 *
 *   THE COST OF `Stop`, stated rather than hidden: it is LATE. It fires after the ask has already
 *   been written, so it recovers the NEXT turn, not this one. A late advisory that reaches the
 *   agent still beats a `/codify` gate-review finding weeks later, which is the only coverage this
 *   arm had before.
 *
 * SEVERITY — `halt-and-report`, and the ceiling is `hook-output-discipline.md` MUST-2.
 *
 *   `block` is UNAVAILABLE and this is a CAP, not a preference. The entire signal is LEXICAL: a
 *   permission idiom found in the reply's own prose. MUST-2 reserves `block` for structural /
 *   behavioral / AST / process-state facts a surface rewrite cannot evade, and a rephrased ask
 *   evades this by construction. Shipping `block` here would be that rule's named failure shape.
 *
 *   `halt-and-report` rather than `advisory`, and the reason is CLEARABILITY. MUST-2 bars `block`
 *   on lexical evidence and NOTHING MORE — in-corpus precedent for `halt-and-report` on a lexical
 *   predicate is `skills/32-trust-posture/wiring/repo-scope-discipline.md` § Trust Posture Wiring and
 *   `dispatch-contract-guard.js`. The sibling `delegation-default-guard.js` ships `advisory`
 *   because its finding rests on an INFERENCE (are these declared sub-parts independent?) the
 *   agent often cannot adjudicate. This finding does not: the evidence is a sentence the agent
 *   itself wrote, quoted back verbatim, and the remedy is one action inside the existing envelope
 *   — dispatch the lanes, or say in one line why this particular ask was gated. That is the
 *   agent-clearable property that makes surfacing worth the turn.
 *
 *   AND IT IS STILL NON-BLOCKING IN FACT, which is the point of registering it at `Stop`:
 *   `instruct-and-wait.js` returns `{continue:true, systemMessage}` at exit 0 for EVERY severity
 *   at a STOP_LIKE event. So `halt-and-report` here SURFACES; it never enforces. This hook takes
 *   NO hand-back refusal parameter at all — the finding CAN false-positive (§ BLIND SPOTS 4), and
 *   a refusal the agent cannot clear spends the budget and hands back anyway. The literal
 *   parameter name is deliberately not written in this file: `stop-refusal-contract.test.mjs`
 *   greps for the token, and a matcher clever enough to tell a use from a mention would itself be
 *   the lexical-detector trap `hook-output-discipline.md` MUST-5 forbids.
 *
 * TRI-STATE — ADVISE / QUIET / UNKNOWN, never a boolean. An absent or unreadable transcript is
 *   UNKNOWN, NOT QUIET. Both render silence to the agent (a noise decision argued in the library
 *   header), but they are distinct in the data, pinned by fixtures, and the offered-but-unreadable
 *   case additionally emits the shared one-time `warnTranscriptRecovery` stderr line. A silently
 *   broken detector is otherwise indistinguishable from a well-behaved session.
 *
 * `{continue:true}` AND EXIT 0 ON EVERY PATH, including the timeout fallback and every throw. A
 *   Stop-family hook must never hold up shutdown. The bounded timer is 4000ms per
 *   `cc-artifacts.md` Rule 7, under the registered 5s timeout, so this hook's own fallback fires
 *   first; the stdin reader's internal timer sits under that in turn.
 *
 * FAILS OPEN ON EVERY UNKNOWN, and resolves the repo root FAIL-CLOSED — the dedupe marker is
 *   per-repo state, and writing it into some other tree would dedupe against a different session.
 *
 * WRITES ONE THING: the per-session dedupe marker under `.claude/learning/delegation-permission/`
 *   (gitignored by the `.claude/learning/**` fence), so a repeated ask surfaces once per distinct
 *   sentence rather than once per turn. Failing to write it costs a repeated line, never a
 *   suppressed finding.
 *
 * BLIND SPOTS are enumerated where the predicate is, in `lib/delegation-permission.js` § BLIND
 *   SPOTS — under-firing by design, paraphrase evasion, last-turn-only scope, inability to see
 *   whether the human asked to be consulted, and the fact that it detects the ASK and not the
 *   idleness (that is the sibling's arm).
 */

"use strict";

// Bounded timer per `cc-artifacts.md` Rule 7, under the registered 5s timeout so this hook's own
// fallback fires first and shutdown is never held up.
const TIMEOUT_MS = 4000;
let fallback = null;

const path = require("path");
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

function finish() {
  if (fallback) clearTimeout(fallback);
  try {
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  } catch {}
  process.exit(0);
}

/**
 * Resolve the main checkout FAIL-CLOSED, the same discipline `delegation-default-guard.js` and
 * `reconcile-dispatch-delivery.js` apply: an indeterminate resolution yields no marker read or
 * write rather than one against a tree we could not confirm.
 */
function requireMainCheckoutSafely(repoDir) {
  try {
    const { requireMainCheckout } = require(path.join(__dirname, "lib", "state-resolver.js"));
    return requireMainCheckout(repoDir);
  } catch (e) {
    return { ok: false, reason: `state-resolver unavailable: ${e && e.message ? e.message : String(e)}` };
  }
}

async function main() {
  fallback = setTimeout(() => {
    try {
      process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    } catch {}
    process.exit(0);
  }, TIMEOUT_MS);

  try {
    // `readStdinBounded()` resolves the PARSED payload — NOT raw text. Calling JSON.parse() on it
    // is the bug that made `dispatch-contract-guard.js` silently inert while its library fixtures
    // stayed green; the end-to-end cases in this detector's fixture set exist so the same seam
    // cannot regress here unobserved.
    const payload = await readStdinBounded();
    const lib = require(path.join(__dirname, "lib", "delegation-permission.js"));
    const { readFinalAssistantText, warnTranscriptRecovery } = require(
      path.join(__dirname, "lib", "transcript-read.js"),
    );

    const sessionId = (payload && payload.session_id) || "unknown-session";

    // Prefer the payload's inline text when present, else recover from the transcript. This
    // ordering is correct under BOTH payload shapes, so it needs no knowledge of which one the
    // host actually emits — the same reasoning `detect-violations.js` records.
    let text =
      (payload && typeof payload.last_assistant_text === "string" && payload.last_assistant_text) || "";
    let failure = null;
    if (!text) {
      const recovered = readFinalAssistantText(payload && payload.transcript_path);
      text = recovered.text;
      if (!recovered.text && recovered.reason) {
        // Offered but unusable — a detector blind spot, and it is LOUD. A payload carrying no
        // transcript at all is the ordinary no-op and is deliberately NOT warned about: warning
        // there would train readers to ignore the channel (the fixture-15 argument in
        // `transcript-read.js`). Both remain UNKNOWN in the data.
        warnTranscriptRecovery(recovered.reason);
        failure = { reason: recovered.reason };
      }
    }

    const verdict = lib.assessLiftRequest(text, failure);
    const advisory = lib.formatLiftAdvisory(verdict);

    if (advisory) {
      const resolved = requireMainCheckoutSafely(PROJECT_DIR);
      const sig = lib.signatureOf(verdict);
      const seen = resolved.ok ? lib.alreadySurfaced(resolved.repoDir, sessionId, sig) : false;
      if (!seen) {
        if (resolved.ok) lib.markSurfaced(resolved.repoDir, sessionId, sig, new Date().toISOString());
        // Routed through the SHARED emitter, which serves BOTH readers from one call: the
        // `user_summary` line to stderr for the human, and the structured body to stdout for the
        // agent. At `Stop` the agent-facing channel is top-level `systemMessage` — a bare stderr
        // write would put a finding about the agent's own behaviour where the agent can never
        // read it, which is the defect `delegation-default-guard.js` had to correct after landing.
        try {
          const { emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js"));
          emit({
            hookEvent: "Stop",
            severity: "halt-and-report",
            what_happened: advisory,
            why:
              "orchestrator-context-economy.md MUST-3 — delegation is the DEFAULT, not an escalation " +
              "the human requests; asking for authorization to dispatch spends a human turn on " +
              "permission agents.md § Triad already grants",
            agent_must_report: [
              "Quote the sentence that asked for the lift, and state whether the work is decomposable.",
              "Either dispatch the independent lanes now, or say in one line why this ask was genuinely gated (cross-repo write, destructive op, release authorization, plan approval).",
            ],
            agent_must_wait:
              "This is advisory-grade evidence (a lexical match on the reply's own prose) and it cannot see whether the human asked to be consulted in THIS session — adjudicate it explicitly rather than silently accepting or silently dismissing it.",
            user_summary: `delegation-permission — the turn asked permission to dispatch subagents: ${String(verdict.sentence || "").slice(0, 90)}`,
          });
          return; // emit() owns stdout and exits; never also call finish().
        } catch {
          // Fail OPEN rather than losing the finding entirely.
          try {
            process.stderr.write(advisory + "\n");
          } catch {}
        }
      }
    }

    finish();
  } catch {
    finish();
  }
}

/**
 * Detector entry — everything this script does when run. Exported so the hook engine can run it
 * in-process (`lib/hook-engine.js`); the CLI entry below calls the same function.
 *
 * ENGINE RESIDUAL, swept: in-engine `process.exit()` throws, so a catch enclosing an exit runs.
 * The two in `main()` that can — the one around `emit()` and the outer one — only write output
 * and call `finish()` (clearTimeout + output + exit). The dedupe marker is written BEFORE
 * `emit()`, outside any catch that an exit can reach, so it cannot run after an exit.
 */
function hookMain() {
  return main();
}

module.exports = { hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a tree that copies
// this hook without lib/hook-engine.js runs it unchanged. The selftest path replays the run
// through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
