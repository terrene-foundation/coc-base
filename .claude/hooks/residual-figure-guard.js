#!/usr/bin/env node
/**
 * residual-figure-guard.js — the Phase-2 detector for `burn-down-reporting.md`
 * § MUST-1's REMAINS quantity, read on the surface MUST-3 fixes it to: the
 * agent's close-out REPORT.
 *
 * @hook-event: Stop (lifecycle) — the close-out report IS the subject, and it
 *   does not exist until the turn completes. A session close touches no file, so
 *   no PreToolUse/PostToolUse matcher can reach it and no path-scoped rule loads
 *   for it; the rule's own Detection block already records that reachability
 *   residual ("a session touching no `paths:` surface can close without this rule
 *   loading"). Stop fires on every reply regardless of files touched, which is
 *   exactly why it closes that gap. `hook-event-selection.md` MUST-3 FAILs a
 *   narrow class registered WITHOUT a matcher — stated explicitly: `Stop` takes no
 *   matcher in this repo (the `Stop` array in `.claude/settings.json` carries
 *   eleven entries and not one `matcher` key, `burndown-quote-stop-guard.js`
 *   among them), because the event has no tool axis to match on. The class is
 *   `lifecycle`, NOT `guard`, and that is the same fact as the ceiling below.
 *
 * ARMED 2026-09-18 — registered in `.claude/settings.json` at `Stop`, in the matcher-less form
 *   every `Stop` entry in this repo uses. NO registration-state marker is carried,
 *   deliberately: every value in `reconcile-hook-surfaces.mjs::MARKER_VOCABULARY` asserts
 *   NON-REGISTRATION, so a registered hook carries none, and `detection-dispatch-check.mjs` reds
 *   `authored-unwired-marker-contradicted` on one that does. Co-owner-authorized.
 *
 *   ⛔ IT WAS ARMED ONLY AFTER THREE INDEPENDENT DEFECTS WERE FIXED, and the prior revision of
 *   this header did not know about any of them. The predicate was INVERTED end to end — it FIRED
 *   on a compliant reply and was SILENT on the canonical violation — through three unrelated
 *   mechanisms, each sufficient alone:
 *     (a) the cue gate matched a bare token inside a FILENAME (`burndown-build.mjs` satisfied the
 *         scope gate, because `\b` sits between `n` and `-`);
 *     (b) the count gate required digit and unit ADJACENT, so ordinary English with a partitive
 *         ("Cleared 12 of the open items") missed;
 *     (c) THE STRUCTURAL ONE — the residual clause SELF-SATISFIED off CLEARED prose, because the
 *         residual keywords saturate cleared-work sentences and the window was read over the full
 *         text with no positional constraint. "closed 9 issues that were open" read its own
 *         CLEARED sentence as the residual figure.
 *   Fixing (a) alone would not have helped: the canonical violation still went silent on (c).
 *
 *   THE BASELINE SUITE WAS 9/9 GREEN OVER ALL THREE. It asserted polarity but had no case where a
 *   residual keyword appeared inside cleared prose, and none where a cue token appeared in an
 *   artefact name — so it measured the case set's age, not the predicate. It is now 17/17, with
 *   seven mutants each REDDING and each shown to REACH the code before its result was read. One
 *   case required a DOUBLE mutation (path-masking and the report-noun requirement are
 *   defence-in-depth siblings, and either alone left it green); that was resolved per
 *   `instrument-discipline.md` MUST-5(b) and explicitly NOT recorded as a vacuity verdict.
 *
 *   A CLAIM THIS HEADER'S LIBRARY USED TO MAKE IS WITHDRAWN AS FALSE, because it is the reasoning
 *   that shipped the defect: "a broad residual matcher makes the detector quieter, never louder,
 *   which is the correct side to be wrong on." Over CLEARED prose, breadth produces a FALSE
 *   NEGATIVE — the loudest possible failure for this guard, and exactly what (c) was.
 *
 *   BOUNDS THAT MOVED: a cue token inside an artefact name or an inline code span is now
 *   deliberately NOT a cue, and bare "burn-down" no longer cues without a report noun — both
 *   NARROW the population. UNCHANGED: only the FINAL reply is read; an explicit zero counts as the
 *   figure; MUST-2's measured-figure clause and MUST-3's `.session-notes` prohibition stay
 *   gate-review-covered. The predicate is lexical end to end, so `advisory` remains the honest
 *   ceiling and its SILENCE is weaker evidence than its FIRING.
 *
 *   ARMED IS NOT PROVEN EFFECTIVE: registration is measured here, live firing is not.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SEVERITY — `advisory`, and the cap is forced, not chosen
 * ─────────────────────────────────────────────────────────────────────────────
 * `burn-down-reporting.md` § Trust Posture Wiring fixed this tier before any
 * detector existed: "`advisory` at the hook layer per `hook-output-discipline.md`
 * MUST-2 — a lexical detector MUST NOT carry `block`". This hook honours that
 * verbatim, and the reasoning holds on inspection: EVERY half of the predicate is
 * a lexical read of the agent's own prose. Whether a message is a close-out
 * report, whether a number is a cleared count, and whether a phrase names a
 * residual are all judgments over English, with no structural signal — no argv
 * token, no parsed field, no git object — anywhere in the payload. MUST-2
 * reserves `block` for a structural signal a surface rewrite cannot evade; a
 * detector keyed on phrasing is evaded by rephrasing, so `block` is forbidden and
 * `halt-and-report` would overstate a finding the agent may legitimately dismiss
 * in one line. Advisory is the honest ceiling.
 *
 * Measured ceiling, recorded so nobody reads the severity as enforcement: `Stop`
 * is a STOP_LIKE event, so `instructAndWait` returns `{continue:true,
 * systemMessage}` and exitCode 0 for EVERY severity. At this surface the finding
 * is SURFACED, never enforced. This hook does not opt into the `stop-refusal.js`
 * hand-back refusal: a missing residual figure is a reporting defect that costs a
 * sentence to repair, and holding a session open over it would spend the
 * refusal budget on the weakest finding in the corpus.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS HOOK CANNOT SEE — read this before citing its silence
 * ─────────────────────────────────────────────────────────────────────────────
 * Its SILENCE is materially weaker evidence than its FIRING:
 *
 *   - Only the FINAL assistant reply is read. A residual named in an EARLIER
 *     message of the same turn is INVISIBLE, so a compliant session can be
 *     flagged — which is precisely why the finding is advisory and asks the agent
 *     to STATE, not to fix.
 *   - The close-out cue set is lexical and CLOSED. A close-out report phrased
 *     without any of its phrases is silently out of scope; that is the absence of
 *     an instrument, not a clean verdict (`instrument-discipline.md` MUST-3(a)).
 *     A cue token appearing inside an artefact NAME — a filename, a path, an
 *     inline code span — is deliberately NOT a cue, and bare "burn-down" no
 *     longer cues without a report noun. Both narrow the population this hook
 *     speaks to; both were added because `burndown-build.mjs` cued it.
 *   - The RESIDUAL clause reads its keyword-proximity shape ONLY from clauses
 *     making no CLEARING claim, so "cleared 12 of the open items" no longer
 *     counts its own "open" as the residual. An arrow delta and an explicit zero
 *     are still read from the whole reply.
 *   - Nothing here checks MUST-2 (was the figure MEASURED), MUST-1's DELTA, or
 *     MUST-3's `.session-notes` prohibition. Those stay gate-review-covered.
 *
 * FAILS OPEN ON EVERY UNKNOWN (`cc-artifacts.md` Rule 7): unparseable payload,
 * absent or unreadable transcript, a reply with no text, a thrown require, a
 * thrown predicate, or the internal timer expiring all return `{continue:true}`.
 * An UNREADABLE transcript is reported on the advisory channel rather than
 * swallowed, so a blind run cannot render as a clean one.
 *
 * WRITES NOTHING. One bounded stdin read and one bounded transcript tail read
 * (through the shared `lib/transcript-read.js`, so this guard cannot drift from
 * the measured tail window). No sink, no ledger, no receipt, no subprocess, no
 * network. Evidence strings are bounded and control-stripped in the lib.
 *
 * Origin: graduated 2026-09-13 from
 * `phase2-deferrals.json::deferrals["burn-down-reporting.md#residual-figure-advisory"]`,
 * whose registered graduation condition was "the close-out residual-figure
 * advisory ships with its fixtures". The row's own adjacency note directed the
 * author to REUSE `burndown-quote-stop-guard.js`'s reply-parsing APPROACH and to
 * build a separate module, because that hook attributes to
 * `burndown-integrity/MUST-1|MUST-2` and checks QUOTE FIDELITY, a different rule
 * and a different property. That instruction is followed here: same event, same
 * shared reader, own module, own finding identity.
 */

"use strict";

// Bounded timer per `cc-artifacts.md` Rule 7, deliberately under the registered
// 5s timeout so this hook's OWN fallback fires first and emits a well-formed
// passthrough. No subprocess is ever spawned.
const TIMEOUT_MS = 4000;
let fallback = null;

const path = require("node:path");
const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

function passthrough(context) {
  if (fallback) clearTimeout(fallback);
  try {
    const out = { continue: true };
    if (context) {
      out.hookSpecificOutput = {
        hookEventName: "Stop",
        additionalContext: context,
      };
    }
    process.stdout.write(JSON.stringify(out) + "\n");
  } catch {}
  process.exit(0);
}

/** One line per finding, each under its OWN class. */
function renderFindingLines(findings) {
  return findings
    .map((f) => `- [${f.severity}] ${f.rule_id}: ${f.evidence}`)
    .join("\n");
}

async function main() {
  // `readStdinBounded()` resolves the PARSED payload, NOT raw text — do not
  // JSON.parse its result (the seam that made a sibling hook silently inert).
  let payload;
  try {
    payload = await readStdinBounded();
  } catch {
    return passthrough(null);
  }
  const p = payload && typeof payload === "object" ? payload : {};

  let lib;
  try {
    lib = require(path.join(__dirname, "lib", "residual-figure.js"));
  } catch {
    return passthrough(null);
  }

  // The reply, preferring the INLINE field the host supplies when it has one and
  // falling back to the shared bounded tail reader. Both shapes are real: the
  // measured `Stop` key set carries `last_assistant_message`, and the transcript
  // path is the documented fallback.
  let text = "";
  if (
    typeof p.last_assistant_message === "string" &&
    p.last_assistant_message.trim()
  ) {
    text = p.last_assistant_message;
  } else {
    let read;
    try {
      const { readFinalAssistantText } = require(
        path.join(__dirname, "lib", "transcript-read.js"),
      );
      read = readFinalAssistantText(p.transcript_path);
    } catch {
      return passthrough(null);
    }
    // An unreadable transcript is an UNKNOWN and rides the advisory channel. It
    // must not look like a clean scan (`instrument-discipline.md` MUST-3(a)).
    if (read && read.reason) {
      return passthrough(
        "burn-down-reporting residual check did NOT run this turn: " +
          `${read.reason}. A clean result here is NOT evidence the close-out carried a residual.`,
      );
    }
    text = (read && read.text) || "";
  }
  if (!text.trim()) return passthrough(null);

  let findings = [];
  try {
    findings = lib.inspectCloseOutReport({ text });
  } catch {
    return passthrough(null);
  }
  if (findings.length === 0) return passthrough(null);

  let emit;
  try {
    ({ emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js")));
  } catch {
    return passthrough(
      [
        "⚠ burn-down-reporting finding — NOT blocked (renderer unavailable).",
        "",
        renderFindingLines(findings),
      ].join("\n"),
    );
  }

  if (fallback) clearTimeout(fallback);
  emit({
    hookEvent: "Stop",
    severity: "advisory",
    rule_id: lib.RULE_ID,
    what_happened:
      `This close-out reply reports progress counts with no residual figure:\n` +
      renderFindingLines(findings),
    why:
      "burn-down-reporting.md MUST-1 — a session close and a wave close each report THREE " +
      "quantities against a stated baseline: CLEARED (with counts), REMAINS (the full residual " +
      'surface, on the SAME axes), and the per-axis DELTA. "Reporting only what was done, or ' +
      'reporting CLEARED without REMAINS ... is BLOCKED": without the residual, a report of ' +
      "activity is unfalsifiable as progress — a session can merge fourteen PRs while the " +
      "outstanding surface grows, and nothing in the narrative reveals it. An explicit ZERO is a " +
      "residual figure and satisfies this; an omitted one does not. This finding is ADVISORY and " +
      "stops nothing: every half of the check is a lexical read of prose, and " +
      "`hook-output-discipline.md` MUST-2 forbids `block` on a lexical signal. It is also BLIND " +
      "to a residual you named in an EARLIER message this turn — if that is what happened, say so " +
      "in one line.",
    agent_must_report: [
      "State the residual: what REMAINS open, counted on the same axes as the cleared counts.",
      "State the per-axis DELTA against a stated baseline (`63 → 49 issues`), including any axis " +
        "that did not move.",
      'If the residual is genuinely zero, say so explicitly ("0 remaining", "nothing ' +
        'outstanding") — an honest zero IS the figure.',
      "If you already reported the residual earlier in this turn, say so in one line and proceed.",
    ],
    agent_must_wait:
      "Add the residual figure to your close-out, or state why it is absent — this is not a block.",
    user_summary: `burn-down-reporting — close-out report with counts but no residual figure (advisory, not blocked)`,
  });
}

/**
 * Detector entry — everything this script used to do at load time: arm the
 * fallback timer, then run. Exported so the hook engine can run it in-process
 * (`lib/hook-engine.js`); the CLI entry below calls the same function. The
 * `.catch` only writes output and exits (the engine's catch/finally residual).
 */
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
