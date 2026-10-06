#!/usr/bin/env node
/**
 * kp-prefix-guard.js — the Phase-2 detector of `specs-authority.md` Rule 10
 * INVARIANT 1 (a `knowledge-product:` field carries a `kp://` URN), GRADUATED
 * 2026-09-15 from `phase2-deferrals.json::deferrals`
 * ["specs-authority.md#rule-10-kp-prefix"], whose registered graduation
 * condition was "the knowledge-product prefix tripwire ships with fixtures".
 *
 * @hook-event: PostToolUse:Edit|Write (guard) — the written SPEC is the subject,
 *   and PostToolUse is the only event at which the RESULTING document exists to
 *   be read. A PreToolUse variant could inspect `tool_input.content` for a Write
 *   but not for an Edit, whose result is a merge, so the durable artifact is the
 *   honest surface (the same argument `bare-line-citation-guard.js` and
 *   `burndown-quote-write-guard.js` each record). The matcher is exactly the
 *   write-tool pair the deferral names — `Edit|Write` — and not `*`, which would
 *   pay a node spawn on every Read/Grep to reach an immediate passthrough and
 *   which `hook-event-selection.md` MUST-3 fails.
 *
 * NO REGISTRATION MARKER, DELIBERATELY — and the marker's token is not spelled
 * out anywhere in this file, not even inside backticks. Every value in
 * `reconcile-hook-surfaces.mjs::MARKER_VOCABULARY` asserts NON-registration
 * (`impliesRegistered: false` on all three), so a REGISTERED hook carries no
 * marker at all. This hook IS registered — `.claude/settings.json` PostToolUse,
 * matcher `Edit|Write` — and a marker here would state the opposite of the
 * surface it describes.
 *
 * WHY THE TOKEN ITSELF IS UNWRITTEN. MEASURED, not anticipated: an earlier
 * revision of this very comment spelled the token out inside backticks while
 * saying the hook carries none, and `reconcile-hook-surfaces.mjs` read the
 * MENTION as a DECLARATION — reporting `marker-value-unknown` with a backtick as
 * the parsed value. The scanner keys on the literal and cannot tell a sentence
 * ABOUT the marker from the marker itself, so the only way to say "this hook has
 * no marker" in a comment is to say it without quoting the token. That
 * over-inclusiveness is NOT a defect to be fixed by teaching the scanner to skip
 * backticked mentions: doing so would let a real marker hide inside backticks,
 * trading a loud false positive for a silent false negative.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SEVERITY — `advisory`, and the rule fixed it before this detector existed
 * ─────────────────────────────────────────────────────────────────────────────
 * `specs-authority.md` § Trust Posture Wiring — Rule 10: "`advisory` at the hook
 * layer (a `knowledge-product:` value's `kp://` prefix MAY be lexically checked,
 * but the inert-at-loom / no-in-session-resolution / no-cross-write property is
 * judgment-bearing per `hook-output-discipline.md` MUST-2 and MUST NOT carry
 * `block`)". This guard honours that verbatim rather than re-deriving it, and
 * two independent grounds hold it there on inspection:
 *
 *   1. The detector reaches ONE of Rule 10's FIVE invariants. A refusal would
 *      assert a Rule-10 verdict the predicate never reached — and the four it
 *      cannot see are the ones a reviewer is there for.
 *   2. `PostToolUse` fires after the write has LANDED. There is nothing left to
 *      block, so a refusal register would be false on its face; the finding is
 *      surfaced as `additionalContext` on a `continue: true` response.
 *
 * Do NOT promote it. The FIELD LOCATION is a parsed-document fact (column-0 key,
 * outside every code fence) and would permit `block` on its own under MUST-2 —
 * but a detector is no stronger than its weakest half, and the half that decides
 * whether a well-formed URN actually SATISFIES Rule 10 is judgment-bearing and
 * is not attempted here.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS HOOK CANNOT SEE — read before citing its silence
 * ─────────────────────────────────────────────────────────────────────────────
 * Invariants 2 (ecosystem-relative), 3 (opaque `<domain>`), 4 (no readable
 * client name) and 5 (inert at loom / REGISTER-not-BIND) are UNEXAMINED, and the
 * per-invariant argument is in `lib/kp-prefix.js` § "WHAT THIS DECIDES". Its
 * silence on a well-formed URN is therefore a verdict on invariant 1 ALONE and
 * NOT a Rule-10 all-clear (`instrument-discipline.md` MUST-3(a)).
 *
 * Its scope is `specs-authority.md`'s OWN `paths:` globs, read through the lib
 * rather than restated here. `.claude/rules/**` is NOT among them, so this guard
 * does not fire on the rule that defines the field nor on its deliberate DO-NOT
 * examples — which is also why, MEASURED on this tree, it has no true-positive
 * population at loom at all: all ten `knowledge-product:` field lines in the
 * repo are fenced teaching examples inside two rule files, and no file under any
 * `specs/` directory carries the field. The fixtures at
 * `.claude/audit-fixtures/kp-prefix/` are the only place its firing is
 * demonstrated.
 *
 * FAILS OPEN ON EVERY UNKNOWN (`cc-artifacts.md` Rule 7): unparseable payload,
 * missing `file_path`, a path outside the project, a surface outside the rule's
 * globs, an unreadable file, a missing lib, a thrown require, the internal timer
 * expiring — all return `{continue:true}`.
 *
 * WRITES NOTHING. One bounded stdin read and one file read. No sink, no ledger,
 * no receipt, no network, no subprocess.
 */

"use strict";

// Bounded timer per `cc-artifacts.md` Rule 7, deliberately under the registered
// 5s timeout so this hook's OWN fallback fires first and emits a well-formed
// passthrough. There is no subprocess; the only I/O is one file read.
const TIMEOUT_MS = 4000;
let fallback = null;

const fs = require("node:fs");
const path = require("node:path");
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

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

async function main() {
  // `readStdinBounded()` resolves the PARSED payload, NOT raw text — do not
  // JSON.parse its result (the seam that made a sibling hook silently inert).
  let payload;
  try {
    payload = await readStdinBounded();
  } catch {
    return passthrough(null); // Unreadable payload is an UNKNOWN, not a finding.
  }
  const p = payload && typeof payload === "object" ? payload : {};

  const filePath = (p.tool_input && p.tool_input.file_path) || "";
  if (!filePath) return passthrough(null);

  const rel = path.isAbsolute(filePath)
    ? path.relative(PROJECT_DIR, filePath)
    : filePath;
  if (rel.startsWith("..")) return passthrough(null); // outside the project — not ours

  let lib;
  try {
    lib = require(path.join(__dirname, "lib", "kp-prefix.js"));
  } catch {
    return passthrough(null);
  }

  // Cheap scope gate BEFORE the file read: the overwhelming majority of writes
  // are not to a surface `specs-authority.md` governs and must cost nothing.
  if (!lib.isGovernedSpecSurface(rel)) return passthrough(null);

  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return passthrough(null);
  }

  let findings;
  try {
    findings = lib.findKnowledgeProductFindings(text);
  } catch {
    return passthrough(null);
  }
  if (!findings.length) return passthrough(null);

  // ADVISORY surfacing: `additionalContext` on a `continue: true` response. The
  // write has already landed and this class never stops one, so a refusal
  // register would be false on its face.
  return passthrough(lib.renderFindings(findings, rel));
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
