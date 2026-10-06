#!/usr/bin/env node
/**
 * decision-packet-guard.js — the Phase-2 detector for `recommendation-quality.md`
 * MUST-6 § "'The Human Decides' Means Ratify A Recommendation — Not Fill A Blank".
 *
 * @hook-event: PostToolUse:Write (guard) — THE WRITTEN PACKET IS THE SUBJECT, and
 *   it does not exist until the Write completes. A decision packet is assembled
 *   in one Write and handed to a human; at `/codify` gate-review it has usually
 *   already been read and the human has already paid the synthesis cost MUST-6
 *   exists to keep off them. `Write` and NOT `Edit|Write|NotebookEdit`: the
 *   deferral this graduates declared `PostToolUse(Write)`, and the predicate
 *   reads `tool_input.content`, which ONLY a Write carries — an Edit delivers a
 *   pair of strings from which no table can be parsed. See "WHAT THIS HOOK
 *   CANNOT SEE" below; the Edit blindness is a NAMED gap, not an oversight.
 *   The matcher is `Write` and not `*` — `hook-event-selection.md` MUST-3 FAILs a
 *   narrow class registered without a matcher, and a `*` matcher would pay a node
 *   spawn on every Read/Grep/Bash to reach an immediate passthrough.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SEVERITY — `halt-and-report`, NOT `block`, and the reason is the weakest half
 * ─────────────────────────────────────────────────────────────────────────────
 * The walk that finds the blank IS structural: a parsed GFM pipe table, a header
 * index, the cell at that index, a whitespace test. `hook-output-discipline.md`
 * MUST-2 would PERMIT `block` on a signal of that grade. This hook declines it,
 * because a detector is no stronger than its weakest half and two halves here
 * rest on matching prose:
 *
 *   1. deciding a header cell reading "Recommendation (spec basis)" or "→ ANSWER:"
 *      IS the agent's answer column — a lexical read of human-authored text;
 *   2. deciding a cell reading "depends on the vendor's SLA" is a PUNT rather
 *      than a genuine finding — also lexical, and the same string can be either.
 *
 * MUST-2 caps a finding resting on a prose match at `halt-and-report`, and
 * promoting this one would be a MUST-2 violation dressed in the structural half's
 * clothing. The register is honest at this event too: at PostToolUse the
 * `halt-and-report` head renders "the action ALREADY RAN", which is exactly true
 * of a Write — whereas `pre-action` would render "has NOT run yet" and be false.
 *
 * The `packet-row-indeterminate` finding the lib can also emit carries `advisory`
 * on its OWN line rather than inheriting this one: a ragged table row is a SHAPE
 * observation, not a determination that an answer is missing, and rendering it at
 * the same class as a confirmed blank would collapse the very distinction the
 * predicate was built to preserve.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS HOOK CANNOT SEE — read this before citing its silence
 * ─────────────────────────────────────────────────────────────────────────────
 *   - EDITS. A packet amended through Edit/NotebookEdit is invisible here, so a
 *     blank row introduced by an Edit into a previously-clean packet is NOT
 *     caught. This is the declared `PostToolUse(Write)` scope and the single
 *     largest gap in the detector.
 *   - PROSE PACKETS in a chat reply that never become a file. Those are the
 *     Stop-event `detectMenuWithoutPick`'s half, not this one.
 *   - AUTHORSHIP. MUST-6's second paragraph requires each row's pick to come from
 *     the relevant DOMAIN SPECIALIST. A single-threaded orchestrator guess and a
 *     specialist-produced pick are byte-identical in the file — the probe suite's
 *     own clean/violation pair is built to be identical except for provenance —
 *     so no file scan can ever decide it. That half is gate-review, permanently.
 *   - A FILLED-BUT-WRONG recommendation. This hook decides PRESENCE, never
 *     quality; a confidently wrong pick reads identically to a good one.
 *   - Any file this hook fails open on (below).
 * A silent run is therefore NOT evidence the packet is compliant — it is the
 * absence of an instrument over four of those five classes
 * (`instrument-discipline.md` MUST-3(a)).
 *
 * FAILS OPEN ON EVERY UNKNOWN (`cc-artifacts.md` Rule 7): unparseable payload, a
 * tool that is not Write, a missing path or content, a non-markdown path, a path
 * outside the project, content over the byte cap, a file that declares no packet
 * marker at all, a thrown require, the internal timer expiring — all return
 * `{continue:true}`.
 *
 * WRITES NOTHING, READS NOTHING FROM DISK. One bounded stdin read; the content
 * arrives in the payload. No file read, no subprocess, no ledger, no network.
 *
 * Origin: graduated 2026-09-15 from
 * `phase2-deferrals.json::deferrals["recommendation-quality.md#must6-decision-packets"]`,
 * whose registered graduation condition was "Delete this entry when the
 * decision-packet PostToolUse(Write) scanner ships with fixtures."
 */

"use strict";

// Bounded fallback per `cc-artifacts.md` Rule 7, deliberately under the registered
// 5s timeout so this hook's OWN fallback fires first and emits a well-formed
// passthrough. No subprocess and no disk read; the only I/O is the stdin read.
const TIMEOUT_MS = 4000;
let fallback = null;

const path = require("node:path");
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

// A write large enough to be a bundle or a fixture dump is not worth table-parsing
// inside a 4s budget. Skipping it is a SMALLER TRUE ANSWER, never a false clean —
// which is why the cap is generous relative to any real packet (the largest
// measured packet in this repo is under 30 KB).
const MAX_BYTES = 512 * 1024;

function passthrough(context) {
  if (fallback) clearTimeout(fallback);
  try {
    const out = { continue: true };
    if (context) {
      out.hookSpecificOutput = {
        hookEventName: "PostToolUse",
        additionalContext: context,
      };
    }
    process.stdout.write(JSON.stringify(out) + "\n");
  } catch {}
  process.exit(0);
}

/** One line per finding, each under its OWN severity class. */
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
  if ((p.tool_name || p.tool || "") !== "Write") return passthrough(null);

  const ti =
    p.tool_input && typeof p.tool_input === "object" ? p.tool_input : {};
  const filePath = typeof ti.file_path === "string" ? ti.file_path : "";
  const content = typeof ti.content === "string" ? ti.content : "";
  if (!filePath || !content) return passthrough(null);
  if (Buffer.byteLength(content, "utf8") > MAX_BYTES) return passthrough(null);

  // Cheapest gate BEFORE any module load: markdown only. A packet is a markdown
  // artifact in every measured instance, and this costs one regex.
  if (!/\.(?:md|markdown)$/i.test(filePath)) return passthrough(null);

  let rel;
  try {
    const abs = path.isAbsolute(filePath)
      ? filePath
      : path.join(PROJECT_DIR, filePath);
    rel = path.relative(PROJECT_DIR, abs);
  } catch {
    return passthrough(null);
  }
  if (!rel || rel.startsWith("..")) return passthrough(null); // outside the project — not ours

  let lib;
  try {
    lib = require(path.join(__dirname, "lib", "decision-packet.js"));
  } catch {
    return passthrough(null);
  }

  let findings = [];
  try {
    findings = lib.inspectPacketWrite({ path: rel, content });
  } catch {
    return passthrough(null);
  }
  if (!Array.isArray(findings) || findings.length === 0)
    return passthrough(null);

  let emit;
  try {
    ({ emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js")));
  } catch {
    // Cannot render through the shared shape ⇒ degrade to a plain report rather
    // than drop the findings. Fail-open, per Rule 7.
    return passthrough(
      [
        "⚠ recommendation-quality MUST-6 packet findings — NOT blocked (renderer unavailable).",
        "",
        renderFindingLines(findings),
      ].join("\n"),
    );
  }

  const ruleIds = [...new Set(findings.map((f) => f.rule_id))];
  if (fallback) clearTimeout(fallback);
  emit({
    hookEvent: "PostToolUse",
    severity: "halt-and-report",
    what_happened:
      `This Write ALREADY RAN and the file it produced drew ${findings.length} ` +
      `recommendation-quality MUST-6 finding(s):\n` +
      renderFindingLines(findings),
    why:
      "recommendation-quality.md MUST-6 — a decision packet's rows are RATIFIED, not FILLED. " +
      "The human exercises authority by ratifying or overriding the agent's recommendation, " +
      "NOT by answering a blank the agent left; a packet handed over with empty answer fields, " +
      "or with a recommendation cell reading 'TBD' / 'needs input' / 'depends', transfers the " +
      "whole synthesis cost back to the human, which is the MUST-1 failure one indirection " +
      "deeper. This finding is HALT-AND-REPORT rather than a block: the table walk is " +
      "structural, but deciding which column is the answer column and whether a cell is a punt " +
      "are both prose matches, and `hook-output-discipline.md` MUST-2 caps a detector at its " +
      "weakest half. It is also blind to Edits, to prose packets, and to whether each pick came " +
      "from the relevant domain specialist — so its silence is never an all-clear.",
    agent_must_report: [
      "Name the finding's rule_id and the specific rows it names.",
      "For each named row: produce the recommendation — the pick, its spec basis, and an honest " +
        "con — and leave ONLY the RATIFY / OVERRIDE slot blank. That blank is the ratify " +
        "affordance and is correct; the recommendation blank is not.",
      "If a row spans a specialist domain, the pick is the DOMAIN SPECIALIST's per MUST-6's " +
        "second paragraph — an orchestrator guess is not a spec-grounded recommendation, and " +
        "no file scan can tell the two apart, so say which you did.",
      "If this is a false positive — the column is not an answer column, or the cell is a real " +
        "finding that happens to start with 'depends' — say so in one line and proceed. That " +
        "stated line is the record for this tier.",
    ],
    agent_must_wait:
      "Fill the named recommendation rows or state your reason — this is not a block.",
    user_summary: `recommendation-quality MUST-6 — ${ruleIds.join(", ")} in ${rel} (not blocked)`,
  });
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). Everything a standalone run
// did at load time happens here instead, so a require() has no side effects.
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
