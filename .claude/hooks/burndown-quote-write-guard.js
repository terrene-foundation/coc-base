#!/usr/bin/env node
/**
 * burndown-quote-write-guard.js — arm (1) of `burndown-integrity.md`, on DURABLE writes.
 *
 * @hook-event: PostToolUse:Edit|Write|NotebookEdit (guard) — the write is the subject, and
 *   PostToolUse is the only event where the WRITTEN CONTENT exists to be checked.
 *   A PreToolUse variant would inspect `tool_input` before the file is on disk; that
 *   works for Write but not for Edit (whose result is a merge), so the durable
 *   artefact is the honest surface. The matcher is exactly the write-tool set — a
 *   `*` matcher would pay a node spawn on every Read/Grep to reach a passthrough,
 *   which `hook-event-selection.md` MUST-3 fails.
 *
 * WHY THIS ONE CAN BLOCK, stated so nobody downgrades it by reflex:
 * `hook-output-discipline.md` MUST-2 reserves `block` for "facts the regex cannot
 * misread" and demands "a structural signal that the regex cannot evade by surface
 * rewrite". An invalid provenance token is exactly that — the regex merely LOCATES
 * a `N⟨token⟩` candidate; the VERDICT is a deterministic sha256 recomputation over
 * the count's own bucket, denominator, value and source digest. Rewriting the
 * number is precisely what invalidates the token, so surface rewrite cannot evade
 * it. The lexical arm (a count with NO token) is capped at halt-and-report and is
 * carried by the Stop hook, not here.
 *
 * SILENT where there is nothing to police — no manifest, a path outside the
 * project, a non-durable surface — so a repo without a burndown pays nothing and
 * sees nothing; and a verification UNKNOWN (an unrunnable generator) rides the
 * advisory channel, never a silent pass (BUG-5). A run that does NOT reach a
 * verdict — an unreadable payload, a written file it cannot read, a throw in the
 * verifier or the emit path, a run past its budget — FAILS CLOSED through
 * `lib/guard-runner.js::runGuard` (`cc-artifacts.md` Rule 7): this row is
 * `on_incomplete: "deny"`, and a guard that cannot finish cannot clear the write.
 */

/**
 * @hook-contract
 * {
 *   "side_effects": {
 *     "fs_writes": [],
 *     "network": false,
 *     "spawns": ["node"]
 *   },
 *   "idempotent": true,
 *   "may_rewrite_input": false,
 *   "notes": "Reads the written file and, when it carries a token, spawns `node .claude/bin/burndown-build.mjs --verify-quote -` (read-only; writes nothing). Emission goes to stdout; no state retained."
 * }
 */

"use strict";

// The standalone run budget guard-runner.js::runGuard enforces; in the engine the
// registry row's own timeout bounds the run.
const BUDGET_MS = 4000;

const fs = require("node:fs");
const path = require("node:path");
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const { runGuard } = require("./lib/guard-runner.js");

function passthrough(context) {
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

/**
 * Surfaces where a wrong count does institutional damage.
 *
 * WIDENED deliberately: the original six globs missed owner-facing status files
 * that live at a repo root under names nobody standardised — STATUS.md,
 * PROGRESS.md, a weekly report, a `reports/` tree — which is exactly where an
 * owner reads a burndown.
 *
 * WHAT REMAINS UNCOVERED, stated rather than implied: any durable surface not
 * matching these names, and — structurally, not fixably here — every write that
 * does NOT go through Edit/Write/NotebookEdit. A heredoc or `>` redirect from
 * Bash writes the same file and this hook never sees it, because the matcher is
 * the tool set. That gap belongs to the Bash surface, not to this predicate.
 */
function isDurableSurface(rel) {
  if (!rel) return false;
  const p = rel.replace(/\\/g, "/");
  // TEST CORPORA ARE NOT REPORT SURFACES (fixed 2026-10-03). Every pattern
  // below is a NAME test, and the BURNDOWN one matched this guard's OWN
  // fixture: `.claude/audit-fixtures/burndown-quote-hooks/run.mjs` carries a
  // synthetic N⟨token⟩ pair (deliberately not reproduced here — this file is
  // itself name-matched by the BURNDOWN pattern, and quoting the invalid form
  // would re-trip the guard that owns it) as a `verifyText` INPUT, so every edit to the file
  // that pins this guard was refused as a durable write (MEASURED — the fix
  // for three stale fixture seeds was blocked by it). A corpus that CONSTRUCTS
  // an invalid token is asserting the scanner's behaviour, not publishing a
  // count. MEASURED, the same shape also lives under `.claude/test-harness/`
  // (the probes file, a budget suite, recovered catalog copies), so the
  // exclusion states the class rather than the one file: a report under either
  // test tree is not a report. Pole: `scope/write-guard is SILENT on a
  // TEST-CORPUS path` in this guard's own fixture, which fires pre-fix.
  if (/(^|\/)\.claude\/(audit-fixtures|test-harness)\//.test(p)) return false;
  return (
    /(^|\/)journal\//.test(p) ||
    /(^|\/)workspaces\//.test(p) ||
    /(^|\/)\.session-notes/.test(p) ||
    /(^|\/)reports?\//i.test(p) ||
    /REGISTER/i.test(p) ||
    /BURNDOWN/i.test(p) ||
    /(^|\/)burndown\//.test(p) ||
    /(^|\/)(STATUS|PROGRESS|SUMMARY|WEEKLY|UPDATE)[^/]*\.md$/i.test(p)
  );
}

async function main(payload) {
  // guard-runner.js::runGuard hands over a parsed JSON object, never a default.
  const p = payload;

  const filePath =
    (p.tool_input && (p.tool_input.file_path || p.tool_input.notebook_path)) ||
    "";
  if (!filePath) return passthrough(null);

  const rel = path.isAbsolute(filePath)
    ? path.relative(PROJECT_DIR, filePath)
    : filePath;
  if (rel.startsWith("..")) return passthrough(null); // outside the project — not ours
  if (!isDurableSurface(rel)) return passthrough(null);

  // A throw from any of these three — the verifier lib failing to load, the
  // written file unreadable, the verifier throwing — is no verdict, and the runner
  // refuses it: a durable write this guard could not check is not a clean one.
  const lib = require(path.join(__dirname, "lib", "burndown-quote.js"));
  if (!lib.findManifest(PROJECT_DIR)) return passthrough(null);

  const text = fs.readFileSync(filePath, "utf8");

  const res = lib.verifyText(PROJECT_DIR, text);
  // An UNKNOWN is surfaced, never swallowed (BUG-5): "could not verify" and
  // "verified, clean" are opposite facts and used to render identically.
  if (res.unknown) {
    const note = lib.renderFindings({
      invalid: [],
      untokened: [],
      unknown: res.unknown,
      surface: `durable write to ${rel}`,
    });
    return passthrough(note); // advisory context, continue:true — never blocks
  }
  if (!res.ran || res.invalid.length === 0) return passthrough(null);

  const body = lib.renderFindings({
    invalid: res.invalid,
    untokened: [],
    surface: `durable write to ${rel}`,
  });

  // `instructAndWait` RETURNS `{json, exitCode}` — it does NOT write stdout.
  // Returning it without emitting is a silent no-op: the finding is computed
  // in full and then discarded, and every surface reports success. That is
  // exactly the result-not-delivered failure class, and this hook shipped it
  // once before the fixtures caught it. An emit path that THROWS is not
  // softened into an advisory any more (it used to hand the body back as
  // continue:true context): the throw reaches the runner, which refuses.
  const { instructAndWait } = require("./lib/instruct-and-wait.js");
  const emitted = instructAndWait({
    hookEvent: "PostToolUse",
    severity: "block",
    rule_id: "burndown-integrity/MUST-1",
    what_happened: `A durable write to '${rel}' contains ${res.invalid.length} INVALID burndown quote(s).`,
    why: body,
    agent_must_report: [
      `File: ${rel}`,
      ...res.invalid.slice(0, 5).map((f) => `Invalid: ${f.raw} — ${f.why}`),
      "Re-quote from the generated block; do NOT hand-adjust the number.",
    ],
  });
  process.stdout.write(JSON.stringify(emitted.json) + "\n");
  process.exit(emitted.exitCode);
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). guard-runner.js::runGuard reads
// the payload (refusing an empty, stalled, unparseable or oversized stdin), runs
// main, and refuses a throw or a standalone run past BUDGET_MS — the endings the
// old fallback timer and `.catch` passed through as `{continue:true}`.
const hookMain = runGuard("burndown-quote-write-guard", main, { budgetMs: BUDGET_MS });

module.exports = { hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1")
    require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
