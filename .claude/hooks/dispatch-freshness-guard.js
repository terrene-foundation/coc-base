#!/usr/bin/env node
/**
 * dispatch-freshness-guard.js — the DISPATCH-FRESHNESS PRECONDITION.
 *
 * Is the base every lane in this wave is about to be cut from still CURRENT? Decided ONCE, in the
 * orchestrator, before the first lane exists. The measurement and the whole argument for it live
 * in `lib/dispatch-freshness.js`; this file is the event binding, the render, and nothing else.
 *
 * @hook-event: PreToolUse:Task|Agent (guard) — the DISPATCH is the only moment this question can
 *   be asked. Staleness is not a property of any lane: in the incident this exists for, every one
 *   of 32 lanes measured its own tree CORRECTLY — clean `git status`, real `git log`, files
 *   present — and all of it was superseded, because the defect was in THE BASE they were all cut
 *   from. The agent is therefore the WRONG OBSERVER and a per-agent reminder cannot work. The
 *   matcher is exactly the delegation-tool set, the same event+matcher shape
 *   `dispatch-contract-guard.js` uses: a `*` matcher would pay a node spawn on every
 *   Read/Bash/Grep to reach an immediate passthrough, and `hook-event-selection.md` MUST-3 FAILs
 *   a narrow class registered without a matcher.
 *
 * ARMED 2026-09-18 — registered in `.claude/settings.json` at `PreToolUse`, matcher `Task|Agent`,
 *   the event this file's own `@hook-event` declares. It now fires on every dispatch. NO registration-state marker is carried
 *   , deliberately: every value in
 *   `reconcile-hook-surfaces.mjs::MARKER_VOCABULARY` asserts NON-registration, so a registered
 *   hook carries none, and `detection-dispatch-check.mjs` reds
 *   `authored-unwired-marker-contradicted` on one that does.
 *
 *   THE ARMING WAS CO-OWNER-AUTHORIZED, which is what this guard's prior marker required and is
 *   the ONLY thing it was ever blocked on — it carried no defect, and its bipolar fixtures over
 *   REAL backdated git repositories (`.claude/audit-fixtures/dispatch-freshness/`) were re-run at
 *   arming time on this tree: 46/46, rc read directly. Predicates live in
 *   `lib/dispatch-freshness.js`; trunk resolution and the git child environment are IMPORTED from
 *   the shared lineages (`lib/trunk-ref.js`, `lib/git-subprocess-env.js`) rather than
 *   re-implemented.
 *
 *   REGISTERED AS ITS OWN ENTRY, NOT MERGED into the incumbent `dispatch-contract-guard.js` that
 *   shares this matcher — a deliberate choice with a MEASURED cost and an UNMEASURED risk on the
 *   other side. Cost: one additional process per matching call (~81 ms, measured on this class,
 *   NOT re-measured for this guard — re-derive before citing it). Risk avoided: a merged predicate
 *   shares the HOST's timeout budget, and a host that times out loses ALL its predicates, not just
 *   the guest — with `dispatch-contract-guard` at a 5 s timeout and this guard's own
 *   `DEFAULT_BUDGET_MS` at 2500, a merge would spend up to half the host's budget on git work.
 *   That composition was never measured, and neither was whether an `advisory` guest inherits a
 *   block-capable host's refusal semantics. A separate registration carries its own timeout and
 *   its own severity, so both risks are structurally absent rather than assumed away.
 *
 *   ARMED IS NOT PROVEN EFFECTIVE: registration is measured here, live firing is not.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SEVERITY — `advisory`, and never `block`
 * ─────────────────────────────────────────────────────────────────────────────
 * The inputs are pure git PROCESS STATE — an integer from `git log -1 --format=%ct` and a ref
 * probe — which `hook-output-discipline.md` MUST-2 would ordinarily permit to carry teeth. They
 * are NOT taken. An old tip is genuinely AMBIGUOUS: a quiet trunk and an unfetched ref produce the
 * same reading, and only a human can tell which. Advisory suffices BECAUSE it fires before the
 * decision — being right costs one `git fetch`; being wrong and REFUSING a dispatch against a
 * legitimately quiet trunk costs the guard its life, because that is the guard an operator
 * disables. At PreToolUse the finding RENDERS under the `pre-action` register, the only head that
 * is true at this instant (`advisory` renders "the action proceeded" and `halt-and-report` renders
 * "the action ALREADY RAN" — the dispatch has done neither); each finding still carries its OWN
 * class on its rendered line, the correction `dispatch-contract-guard.js` records.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES NOT DO — read before citing its silence
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. It does NOT detect a stale ISSUE LIST or tracker snapshot, only a stale TREE. The message's
 *      point (d) tells the operator to re-derive; nothing here enforces it.
 *   2. It UNDER-REPORTS BY CONSTRUCTION: a quiet trunk looks stale, and a just-fetched trunk looks
 *      fresh even if the remote moved a second later. Offline is the trade — a `git fetch` in a
 *      dispatch hook can hang every dispatch.
 *   3. It measures the ORCHESTRATOR'S box, not the base each lane actually receives.
 *   4. It cannot tell "quiet" from "unfetched" — which is why it advises.
 *
 * THREE STATES REACH THE OPERATOR, NEVER TWO. `stale` and `undetermined` both SPEAK; `fresh` and
 * `absent` are both silent. Collapsing UNDETERMINED into "fresh" is the single change that would
 * make this hook stop guarding without anyone noticing, because an unanswerable probe and a
 * current trunk are byte-identical in a "proceed" response.
 *
 * FAILS OPEN ON EVERY UNKNOWN (`cc-artifacts.md` Rule 7) IN THE SENSE THAT IT NEVER BLOCKS — but
 * an unknown is REPORTED rather than swallowed. An unparseable payload, an off-matcher tool, a
 * thrown require or the internal timer expiring all return a bare `{continue:true}`; an
 * unanswerable git probe returns `{continue:true}` WITH the UNDETERMINED advisory attached.
 *
 * WRITES NOTHING. One bounded stdin read and at most three local git calls (`rev-parse --verify`
 * via the shared trunk resolver, `log -1 --format=%ct`, and a disambiguating ref probe only when
 * the tip read fails). No network, no sink, no ledger, no receipt, no prompt text retained.
 *
 * Origin: co-owner-authorized, 2026-09-13 — a 32-lane wave run against a tree 25 days and 3,850
 * commits stale, in which 53 of 134 triaged issues had already closed (53 after the snapshot date,
 * 0 before) and ~40% of the output was unactionable.
 */

"use strict";

// Bounded timer per `cc-artifacts.md` Rule 7, deliberately under any registered timeout so this
// hook's OWN fallback fires first and emits a well-formed passthrough. The measurement carries its
// own tighter budget (`DEFAULT_BUDGET_MS`), so this is the outer belt, not the primary bound.
const TIMEOUT_MS = 5000;
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

/** One line per finding, each under its OWN severity class. */
function renderFindingLines(findings) {
  return findings
    .map((f) => `- [${f.severity}] ${f.rule_id}: ${f.evidence}`)
    .join("\n");
}

async function main() {
  // `readStdinBounded()` resolves the PARSED payload, NOT raw text — do not JSON.parse its result
  // (the seam that made a sibling hook silently inert for its whole first life).
  let payload;
  try {
    payload = await readStdinBounded();
  } catch {
    return passthrough(null);
  }
  const p = payload && typeof payload === "object" ? payload : {};
  const tool = p.tool_name || p.tool || "";

  let lib;
  try {
    lib = require(path.join(__dirname, "lib", "dispatch-freshness.js"));
  } catch {
    return passthrough(null);
  }

  // THE DISPATCH-TOOL GATE, checked BEFORE any git subprocess. A non-dispatch call must cost
  // nothing beyond the stdin read: this question is meaningless for a Read or a Bash, and a guard
  // that spawns git on every tool call is a guard the operator disables.
  if (!lib.DELEGATION_TOOLS.includes(tool)) return passthrough(null);

  let findings = [];
  let measurement = null;
  try {
    measurement = lib.measureTrunkFreshness({ repoDir: PROJECT_DIR });
    findings = lib.inspectDispatchFreshness(tool, measurement);
  } catch {
    return passthrough(null);
  }
  if (findings.length === 0) return passthrough(null);

  let emit;
  try {
    ({ emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js")));
  } catch {
    // Degrade to the plain report rather than drop the finding.
    return passthrough(
      [
        "⚠ dispatch-freshness findings — NOT blocked (renderer unavailable).",
        "",
        renderFindingLines(findings),
        "",
        ...findings.flatMap((f) => f.lines),
      ].join("\n"),
    );
  }

  const f = findings[0];
  const ruleIds = [...new Set(findings.map((x) => x.rule_id))];
  if (fallback) clearTimeout(fallback);
  emit({
    hookEvent: "PreToolUse",
    severity: "pre-action",
    what_happened:
      `This ${tool} dispatch has NOT been issued yet. The BASE it would be cut from drew ` +
      `${findings.length} dispatch-freshness finding(s):\n` +
      renderFindingLines(findings),
    why:
      "Staleness is a property of THE BASE, not of any lane — so it is decided ONCE, here, before " +
      "the first lane exists. In the incident this guard exists for, all 32 lanes measured their " +
      "own trees CORRECTLY and every one of those measurements was superseded; ~40% of the wave's " +
      "output was unactionable, and nothing inside the wave looked wrong because it was perfectly " +
      "consistent with its own stale snapshot. This finding is ADVISORY and cannot stop the call: " +
      "an old tip is genuinely ambiguous — a quiet trunk and an unfetched ref read identically " +
      "from here — and only you can tell which this is. The probe is deliberately OFFLINE (no " +
      "`git fetch`), so it under-reports and never over-reports.",
    agent_must_report: f.lines,
    agent_must_wait:
      "Fetch and re-check, or proceed with your stated reason — this is not a block. Re-derive any " +
      "issue list or tracker snapshot feeding this wave before you dispatch.",
    user_summary:
      `dispatch-freshness — ${ruleIds.join(", ")} on a ${tool} dispatch ` +
      `(state=${f.state}, not blocked)`,
  });
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
