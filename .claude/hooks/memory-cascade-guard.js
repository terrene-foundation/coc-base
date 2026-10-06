#!/usr/bin/env node
/**
 * memory-cascade-guard.js — the Phase-2 detector for `knowledge-cascade-routing.md`
 * MUST-1 ("Evaluate Cascade-Value Before Capture; Cascade-Valuable Knowledge
 * Routes To A COC Artifact, Not Memory"), whose Detection mechanism read Phase 1
 * (manual, gate-review) plus a DEFERRED Phase 2 until this change.
 *
 * @hook-event: PostToolUse:Write (guard) — and BOTH halves of that are the rule's
 *   choice, not this file's. The rule's own Wiring names "a lexical
 *   `PostToolUse(Write)` tripwire on `MEMORY.md` writes", and the graduated
 *   registry row names "an advisory `PostToolUse(Write)` detector". PostToolUse
 *   is also the only honest event here: the finding is a PROMPT to put the
 *   cascade-value evaluation on the record, and at PreToolUse that prompt would
 *   arrive attached to a call the guard has no grounds to hold. The matcher is
 *   exactly `Write` — a `*` matcher would pay a node spawn on every Read/Grep/Bash
 *   to reach an immediate passthrough, which `hook-event-selection.md` MUST-3
 *   fails.
 *
 * REGISTERED AT LOOM, and carrying no registration marker for that reason — a
 * registered hook carries none in this corpus, and registration plus
 * marker-absence are ONE decision, not two. The marker token is deliberately NOT
 * written out anywhere in this file, even inside backticks: `reconcile-hook-surfaces.mjs`
 * scans for the literal and cannot tell a MENTION from a DECLARATION, so naming it
 * here would re-declare the very marker this change removed (measured — an earlier
 * revision of this comment did exactly that and the reconciler reported
 * `marker-value-unknown` with the backtick as the parsed value).
 * It is wired at `PostToolUse`, matcher
 * `Write`, in `.claude/settings.json`, with its delivery lane declared
 * `cc-only` in `sync-manifest.yaml::hook_delivery`.
 *
 * ARMED IS NOT PROVEN EFFECTIVE: no live session has been observed firing this
 * guard. Registration and distribution state are what has been measured, and
 * nothing more. At the Codex and Gemini audiences it is registered NOWHERE, so
 * its silence THERE is the absence of an instrument and never an all-clear
 * (`instrument-discipline.md` MUST-3(a)); that gap is declared in
 * `.claude/test-harness/in-force-baseline.json` rather than left to be inferred.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY `Edit` IS **NOT** IN THE MATCHER, AND WHY THAT IS A REPORTED GAP
 * ─────────────────────────────────────────────────────────────────────────────
 * The rule says Write and the registry row says Write, so Write is what this
 * ships with. But the gap is real and is named here rather than silently
 * widened away or silently left: A MEMORY FILE THAT ALREADY EXISTS IS APPENDED
 * TO WITH `Edit`, NOT `Write`, AND THAT IS THE COMMON CASE. `MEMORY.md` is
 * created once per account per repo and amended thereafter, so in steady state
 * the majority of memory captures never produce a `Write` event at all and this
 * detector is structurally silent on them.
 *
 * Widening the matcher to `Edit|Write` is a ONE-TOKEN change with no code
 * consequence — the predicate keys on `file_path`, which `Edit` also carries,
 * and `inspectMemoryWrite` would need its tool-name gate widened to match. It is
 * NOT done here because the obligation this detector graduates names `Write`,
 * and widening a detector past the rule that authorises it is the same defect in
 * the opposite direction. The decision belongs to whoever amends the rule.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SEVERITY — `advisory`, fixed by the rule before this detector existed
 * ─────────────────────────────────────────────────────────────────────────────
 * `knowledge-cascade-routing.md` § Trust Posture Wiring: "`advisory` at the hook
 * layer … a lexical `PostToolUse(Write)` tripwire on `MEMORY.md` writes MAY pair
 * as advisory but MUST NOT carry `block`". Honoured verbatim.
 *
 * Do NOT cite `hook-output-discipline.md` MUST-2 as the reason. MUST-2 bars
 * `block` on a LEXICAL signal, and this signal is not lexical — it is a parsed
 * `tool_input.file_path` compared component-wise, which is structural. The
 * actual ceiling comes from two other places, and both are stronger: the rule
 * DECLARES advisory, and the finding's decisive half (is the content
 * cascade-valuable?) is not weak but ABSENT — this detector never looks at
 * content at all. A composed verdict cannot exceed a half it does not have.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS HOOK CANNOT SEE — read before citing its silence
 * ─────────────────────────────────────────────────────────────────────────────
 *   - WHETHER THE CONTENT WAS CASCADE-VALUABLE. Never attempted. That is MUST-1's
 *     whole judgment and it stays at gate-review, exactly as the graduated
 *     registry row said it would.
 *   - `Edit` APPENDS to an existing memory file (see above) — the common case.
 *   - MUST-2 ENTIRELY (an on-disk COC artifact absent from the distribution
 *     manifest) and MUST-3 ENTIRELY (a sensitive specific carried into a
 *     cascading artifact). Neither has anything to do with a memory-path write.
 *   - CASCADE-VALUABLE KNOWLEDGE STRANDED ELSEWHERE — a chat reply, a scratch
 *     file, a workspace note. The trigger is one path shape, nothing more.
 *
 * A finding here is a PROMPT, not a violation verdict: MUST-1's evaluation is
 * owed on EVERY memory write, so a compliant write fires it too and answering in
 * one line discharges it.
 *
 * FAILS OPEN ON EVERY UNKNOWN (`cc-artifacts.md` Rule 7): unparseable payload,
 * missing/empty `file_path`, a tool other than `Write`, a thrown require, the
 * internal timer expiring — all return `{continue:true}`.
 *
 * WRITES NOTHING, READS NOTHING FROM DISK. One bounded stdin read and a pure
 * string comparison. No file read (the path alone decides), no subprocess, no
 * sink, no ledger, no network. This is why its timeout budget is the smallest in
 * the Write group.
 *
 * KILL SWITCH: `COC_MEMORY_CASCADE=0|off|false|no`. DEFAULT-ON, so a deployment
 * that never heard of this still gets the coverage.
 *
 * Origin: graduated 2026-09-15 from
 * `phase2-deferrals.json::deferrals["knowledge-cascade-routing.md#memory-write-detector"]`,
 * whose registered graduation condition was "Delete this entry when the
 * MEMORY.md write advisory ships with fixtures."
 */

"use strict";

// Bounded timer per `cc-artifacts.md` Rule 7, deliberately under the registered
// 5s timeout so this hook's OWN fallback fires first and emits a well-formed
// passthrough. There is no subprocess and no file read, so this should never fire.
const TIMEOUT_MS = 4000;
let fallback = null;

const path = require("node:path");
const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

/** The unconditional safe exit. Every path in this file ends here or at `emitFinding`. */
function passthrough() {
  if (fallback) clearTimeout(fallback);
  try {
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  } catch {}
  process.exit(0);
}

/** Default-ON; an explicit off-word disables. */
function enabled(env) {
  const raw = env && env.COC_MEMORY_CASCADE;
  if (raw === undefined || raw === null || raw === "") return true;
  return !/^(0|off|false|no)$/i.test(String(raw).trim());
}

function emitFinding(finding) {
  if (fallback) clearTimeout(fallback);
  try {
    // `instructAndWait` RETURNS `{json, exitCode}` — it does NOT write stdout.
    // Returning it without emitting computes the finding in full and discards it
    // while every surface reports success.
    const { instructAndWait } = require("./lib/instruct-and-wait.js");
    const out = instructAndWait({
      hookEvent: "PostToolUse",
      severity: "advisory",
      rule_id: finding.rule_id,
      // The rule_id is PREFIXED INTO the rendered text deliberately.
      // `instructAndWait` accepts `rule_id` as a field but does NOT render it
      // into `additionalContext`, so a finding that passed it and nothing else
      // reached the transcript ANONYMOUS — un-attributable by a reviewer and
      // un-greppable by any downstream check keying on the id. Measured, not
      // assumed: this suite's ARM 2 was SILENT on all seven known-positives for
      // exactly that reason while ARM 1 was 18/18 green. Rendering it here is
      // the fix; weakening the assertion to match the anonymous output would
      // have been the defect.
      what_happened: `[${finding.rule_id}] ${finding.evidence}`,
      why:
        "knowledge-cascade-routing.md MUST-1 — `MEMORY.md` and `memory/*.md` are " +
        "PER-ACCOUNT, PER-REPO and NON-CASCADING: they enter no `/sync` tier, so a " +
        "reusable principle written there reaches exactly one account in one repo " +
        "while the 30+ downstream consumers never see it. The harness '# Memory' " +
        "default biases every capture toward this surface, which is why the rule " +
        "requires the cascade-value evaluation to happen BEFORE the write. " +
        "This detector decided the SURFACE only — it read no content and makes NO " +
        "claim that this particular capture was cascade-valuable. It also cannot " +
        "see an `Edit` that appends to an existing memory file, so its silence is " +
        "never an all-clear.",
      agent_must_report: [
        "State in one line whether this capture is cascade-valuable: would a " +
          "downstream agent, operator, or consumer repo benefit from it?",
        "If NO — genuinely operator/session-local context — say so and proceed. " +
          "That stated line IS the record this tier wants; nothing further is owed.",
        "If YES — a reusable principle, pattern, failure-mode, convention or " +
          "discipline — route it to a COC artifact instead (`/codify` for a rule / " +
          "skill / agent, or `/govern` for an O1 / co-owner origination), and " +
          "register its distribution fate in `sync-manifest.yaml` per MUST-2. " +
          "An artifact on disk but absent from the manifest does not cascade either.",
        "If it cascades, scrub it first per MUST-3: the cascading copy carries the " +
          "GENERIC principle; the sensitive specific (tenant / customer / operator " +
          "name, internal path) stays in the non-cascading `/codify` journal receipt.",
      ],
      agent_must_wait: false,
      user_summary:
        "Write to a non-cascading memory surface — cascade-value evaluation owed.",
    });
    process.stdout.write(JSON.stringify(out.json) + "\n");
    process.exit(out.exitCode);
  } catch {
    return passthrough(); // even the emit path fails open
  }
}

async function main() {
  if (!enabled(process.env)) return passthrough();

  // `readStdinBounded()` resolves the PARSED payload, NOT raw text — do not
  // JSON.parse its result (the seam that made a sibling hook silently inert).
  let payload;
  try {
    payload = await readStdinBounded();
  } catch {
    return passthrough();
  }
  const p = payload && typeof payload === "object" ? payload : {};

  const toolName = p.tool_name || p.tool || "";
  const filePath = (p.tool_input && p.tool_input.file_path) || "";
  if (!filePath) return passthrough();

  let lib;
  try {
    lib = require(path.join(__dirname, "lib", "memory-cascade.js"));
  } catch {
    return passthrough();
  }

  let findings = [];
  try {
    findings = lib.inspectMemoryWrite({ toolName, filePath });
  } catch {
    return passthrough();
  }
  if (findings.length === 0) return passthrough();

  return emitFinding(findings[0]);
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). Everything a standalone run
// did at load time happens here instead, so a require() has no side effects.
function hookMain() {
  fallback = setTimeout(passthrough, TIMEOUT_MS);
  if (typeof fallback.unref === "function") fallback.unref();
  return main().catch(() => passthrough());
}

module.exports = { enabled, hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
