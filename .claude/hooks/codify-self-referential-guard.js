#!/usr/bin/env node
/**
 * codify-self-referential-guard.js — the Phase-2 detector `self-referential-codify.md` promised.
 *
 * ARMED 2026-09-18 — registered in `.claude/settings.json` at `PostToolUse`, matcher
 *   `Edit|Write|NotebookEdit`, the event the hook-event declaration below argues for. NO registration-state marker is carried
 *   , deliberately: every value in
 *   `reconcile-hook-surfaces.mjs::MARKER_VOCABULARY` asserts NON-REGISTRATION, so a registered
 *   hook carries none. Co-owner-authorized. The `Origin:` line below records this hook as
 *   graduating a Phase-2 deferral row; that graduation is now COMPLETE — the authoring half landed
 *   then, the WIRING half lands here.
 *
 *   ⛔ THE SCOPE HYPOTHESIS THAT BLOCKED THIS WAS REFUTED, and the refutation is the finding.
 *   It was believed the guard collapsed LOAD_ONLY into FIRE — firing across `.claude/rules/*`,
 *   `.claude/hooks/**` and `.claude/audit-fixtures/**`, i.e. most of the working set. FALSE. The
 *   trichotomy is intact (`lib/codify-self-referential.js:232-238`, honored at `:236-240` here),
 *   and the controls prove it: `zero-tolerance.md` and `security.md` — the two files the rule NAMES
 *   as deliberately off-allowlist while sitting under the `.claude/rules/**` load glob — both
 *   classify LOAD_ONLY and stay SILENT. The gate is silent on the MAJORITY of every glob'd tree
 *   (rules 47 FIRE / 59 LOAD_ONLY; skills 59 / 407; bin 55 / 166; commands 21 / 41). It fires on
 *   44% of `.claude/rules`, which is exactly the enumerated subset.
 *
 *   THE BREADTH IS THE RULE'S OWN ALLOWLIST, NOT A CODE DEFECT. 4843 of the 5657 firing files
 *   (85.6%) come from ONE literal entry — `.claude/audit-fixtures/**` — declared in
 *   `self-referential-codify.md`'s own **Audit fixtures** bullet with explicit rationale.
 *   Narrowing it in code would HARDCODE a divergence from the rule, which is precisely what the
 *   derivation contract and fixtures D1/D2 forbid. If the breadth is unwanted, the edit belongs in
 *   the rule's allowlist and needs its own codify.
 *
 *   WHAT WAS ACTUALLY WRONG WAS VOLUME, NOT SCOPE. Dedupe keyed per-(session, path, entry), so a
 *   codify sweeping an allowlisted subtree emitted one advisory PER FILE, each asking the identical
 *   question — while Rule 1 asks for ONE Tier verdict per CODIFY. That is the "detector the
 *   orchestrator learns to skim" this header already warned about. Keying on the matched ENTRY
 *   instead of the path takes a full-tree session from 5657 advisories to 140. It is surgical:
 *   203 of 220 entries are exact paths where entry and path are 1:1, and those 124 firing files
 *   produce 124 distinct advisories before AND after, byte-identical. The whole reduction lands on
 *   the 16 GLOB entries that caused the volume, and derivation-liveness is preserved — a mid-session
 *   allowlist edit still changes the key and re-surfaces.
 *
 *   The KILL SWITCH below is no longer moot: "DEFAULT-ON" now describes a hook that runs.
 *   ARMED IS NOT PROVEN EFFECTIVE: registration is measured here, live firing is not. Recorded AT
 *   the mechanism per `artifact-stranding.md` MUST-3; the validate-emit
 *   `settings-hook-registration` check reads this marker (#771).
 *
 * @hook-event: PostToolUse:Edit|Write|NotebookEdit (verification) — the SUBJECT IS THE FILE THAT
 *   WAS JUST WRITTEN, and at this event it exists on disk. The property under test is membership
 *   of that path in the Rule-2 allowlist, which is a property of work ALREADY PRODUCED — the
 *   `verification` row of `hook-event-selection.md`'s table, whose stated home is "gate-time or
 *   `PostToolUse` scoped to the producing tool". The matcher names the three tools that can produce
 *   a file and no others, per MUST-3.
 *
 *   `PreToolUse` WAS CONSIDERED AND IS WORSE, for two reasons rather than one. (i) The allowlist is
 *   READ OUT OF `self-referential-codify.md` ITSELF, and the commonest self-referential edit is an
 *   edit TO THAT RULE adding a new allowlist entry — Rule 2 obliges the same codify to declare it.
 *   At `PreToolUse` the read returns the PRE-edit allowlist, so the very entry being added is
 *   invisible on the write that adds it. At `PostToolUse` the new entry is already on disk and the
 *   detector classifies against it. (ii) The finding is not a reason to refuse the write — the edit
 *   is legitimate; what is owed is REVIEW DEPTH before merge. `advisory` means "the tool RAN", which
 *   is only truthful after it has.
 *
 *   `Stop` WAS CONSIDERED AND IS WORSE: it carries no tool axis, so per MUST-3 a narrow class
 *   cannot live there, and it would have to RECONSTRUCT the session's touched-file set from a second
 *   instrument (transcript or `git status`) with its own blind spots, when `PostToolUse` is handed
 *   the path directly.
 *
 *   THE COST OF `PostToolUse` IS STATED RATHER THAN HIDDEN, the way `fleet-drain-guard.js` states
 *   the cost of `Stop`: it fires PER EDIT, and a codify session touches an allowlisted file many
 *   times. That is paid down with a per-(session, matched-ENTRY) dedupe marker, so the advisory
 *   surfaces once per governing SURFACE rather than once per keystroke, and re-surfaces if the
 *   matched entry changes. The key is the entry and NOT the path because Rule 1 asks for one Tier
 *   verdict per CODIFY, not per file: 16 of the 220 entries are subtree globs covering 5,533 of the
 *   5,657 firing files here, so a path-keyed marker restated one identical question thousands of
 *   times per sweep (MEASURED — see `signatureOf` in `lib/codify-self-referential.js`, which also
 *   records why this is observationally a no-op for the 203 exact entries). The residual cost is a
 *   ~35 ms authority import on each mutation whose path resolves inside the project (MEASURED; see
 *   `lib/codify-self-referential.js`).
 *
 * SEVERITY IS `advisory`, WHICH IS BOTH THE CEILING THE RULE SETS AND THE RIGHT LEVEL ON THE
 * MERITS. `self-referential-codify.md`'s own `**Severity:**` bullet reads "`advisory` at hook layer"
 * and cites `hook-output-discipline.md` MUST-2. The signal is structural (set membership over a
 * parsed document — NOT a regex over prose), so MUST-2's bar on `block`-from-lexical is not what
 * binds here; what binds is that the PROPOSITION is judgment-bearing. A hook cannot tell a `/codify`
 * from an ordinary implementation session, and the same edit occurs in both. Raising this to
 * `halt-and-report` would halt every routine edit to a governing artifact on a question the hook
 * cannot answer. So the hook reports the half it KNOWS (this path is on the allowlist) and hands the
 * half it cannot know (is a codify under way, and is the diff enforcement-bearing) to the
 * orchestrator, conditionally phrased.
 *
 * FAILS OPEN ON EVERY ERROR (`cc-artifacts.md` Rule 7) — an unreadable rule, an unimportable
 * authority, a zero-entry parse and an unresolvable project root all emit nothing. A wrong finding
 * would train the orchestrator to skim; a missing one costs the gate-review layer that already
 * owns Phase 1.
 *
 * KILL SWITCH: `COC_CODIFY_SELFREF=0|off|false|no`. DEFAULT-ON.
 *
 * Origin: `phase2-deferrals.json::deferrals["self-referential-codify.md#codify-self-referential-hook"]`,
 * whose `reason` named this as the one row with "a clear structural path ... deferred only for want
 * of the hook". Graduated by supplying it.
 */

"use strict";

// Bounded timer per `cc-artifacts.md` Rule 7, under the registered 5s timeout so this hook's own
// fallback fires first and the tool boundary is never held up.
const TIMEOUT_MS = 4000;
let fallback = null;

const path = require("path");
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

// The SSOT classifier, NOT a local set. `cc-artifacts.md` Rule 8 and `tool-classes.js`'s own
// header make per-site `tool === "Edit" || tool === "Write"` sets BLOCKED outside that file, and a
// structural sweep test enforces it — the per-site pattern is the bug-class generator that needed
// three iterations to close. A future mutation tool is picked up here with no edit.
const { isMutationTool } = require("./lib/tool-classes.js");

/** The unconditional safe exit. Every path in this file ends here or at `emitFinding`. */
function finish() {
  if (fallback) clearTimeout(fallback);
  try {
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  } catch {}
  process.exit(0);
}

function enabled(env) {
  const v = String(env.COC_CODIFY_SELFREF ?? "")
    .trim()
    .toLowerCase();
  return !(v === "0" || v === "off" || v === "false" || v === "no");
}

/**
 * Emit in the canonical shape (`hook-output-discipline.md` MUST-1), THEN mark — and only if the
 * write REPORTED THE BYTES FLUSHED. Order is the one `fleet-drain-guard.js` argues for: marking
 * before emitting makes the marker lie whenever the renderer fails, permanently suppressing a
 * finding that was never delivered. A lost marker costs a repeated line; a false marker costs the
 * finding.
 */
function emitFinding(advisory, summary, mark) {
  let delivered = false;
  try {
    const { instructAndWait } = require(
      path.join(__dirname, "lib", "instruct-and-wait.js"),
    );
    const out = instructAndWait({
      hookEvent: "PostToolUse",
      severity: "advisory",
      what_happened: advisory,
      why:
        "`self-referential-codify.md` Rule 1 — a `/codify` touching the allowlisted surface that " +
        "governs codification itself owes a redteam depth set by the diff's enforcement-class, " +
        "not by trust posture. Rule 2 makes that surface a positive allowlist; this path is on it.",
      agent_must_report: [
        "whether this edit is part of a `/codify` proposal (if not, say so and proceed)",
        "if it is: the Tier verdict for the diff — Tier 1 (enforcement-bearing) or Tier 2 " +
          "(unambiguously prose-only, non-enforcement) — and which Rule-1 criterion decided it",
        "if Tier 1: the multi-agent parallel redteam team dispatched before merge, at minimum " +
          "reviewer + security-reviewer + a structural-validator specialist",
      ],
      agent_must_wait: false,
      user_summary: summary,
    });
    delivered = process.stdout.write(JSON.stringify(out.json) + "\n") === true;
  } catch {
    // The renderer is the only thing that can fail here; a finding must never cost the tool
    // boundary. `delivered` stays false, so NOTHING is marked and the next edit re-evaluates.
    try {
      process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    } catch {}
  }
  if (delivered && typeof mark === "function") {
    try {
      mark();
    } catch {}
  }
  // LAST, not first: the marker append above ran inside this hook's own 4s bound.
  if (fallback) clearTimeout(fallback);
  process.exit(0);
}

/**
 * Per-session dedupe sink. Written through the shared `append-sink.js` so the containment,
 * symlink and mode fences are the ones every other sink in this repo uses rather than a second
 * implementation. Every failure is fail-OPEN: an unreadable marker file means the finding is
 * emitted again, never suppressed.
 */
function markerPathOf(repoDir, sessionId) {
  const crypto = require("crypto");
  const raw =
    typeof sessionId === "string" && sessionId.trim()
      ? sessionId.trim()
      : "unknown-session";
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, "_");
  const suffix = crypto
    .createHash("sha256")
    .update(raw, "utf8")
    .digest("hex")
    .slice(0, 8);
  return path.join(
    repoDir,
    ".claude",
    "learning",
    "codify-selfref",
    `${safe}-${suffix}.jsonl`,
  );
}

function alreadySurfaced(repoDir, sinkPath, signature) {
  try {
    const { readSinkFile } = require(
      path.join(__dirname, "lib", "append-sink.js"),
    );
    const r = readSinkFile({ repoDir, sinkPath, maxBytes: 256 * 1024 });
    if (!r.ok) return false;
    for (const line of String(r.text).split("\n")) {
      if (!line.trim()) continue;
      try {
        if (JSON.parse(line).sig === signature) return true;
      } catch {
        /* a malformed line suppresses nothing */
      }
    }
    return false;
  } catch {
    return false;
  }
}

function markSurfaced(repoDir, sinkPath, signature) {
  try {
    const fs = require("fs");
    fs.mkdirSync(path.dirname(sinkPath), { recursive: true });
    const { appendSinkLine } = require(
      path.join(__dirname, "lib", "append-sink.js"),
    );
    appendSinkLine({
      repoDir,
      sinkPath,
      line: JSON.stringify({ sig: signature, at: new Date().toISOString() }),
    });
  } catch {
    /* non-fatal by design: a lost marker costs one repeated advisory */
  }
}

async function main() {
  fallback = setTimeout(() => {
    // Reachable only while an await is pending; every emitting path exits synchronously after its
    // stdout write, so this can never overwrite a delivered finding.
    try {
      process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    } catch {}
    process.exit(0);
  }, TIMEOUT_MS);

  try {
    if (!enabled(process.env)) return finish();

    // `readStdinBounded()` resolves the PARSED payload, not raw text. Calling JSON.parse on it is
    // the bug that made `dispatch-contract-guard.js` silently inert with its library fixtures green.
    const payload = await readStdinBounded();
    if (!payload || typeof payload !== "object") return finish();
    if (!isMutationTool(payload.tool_name)) return finish();

    const filePath =
      (payload.tool_input &&
        (payload.tool_input.file_path || payload.tool_input.notebook_path)) ||
      null;
    if (!filePath) return finish();

    const repoDir = payload.cwd || PROJECT_DIR;
    const lib = require(
      path.join(__dirname, "lib", "codify-self-referential.js"),
    );

    const relPath = lib.toRelPath(filePath, repoDir);
    if (!relPath) return finish(); // outside the tree this allowlist governs

    const rule = lib.readRuleText(repoDir);
    if (!rule.ok) return finish();

    const authority = await lib.loadAuthority();
    if (!authority.ok) return finish();

    const surface = lib.deriveSurface(rule.text, authority);
    if (!surface.ok) return finish();

    const cls = lib.classifyPath(relPath, surface);
    // LOAD_ONLY is the compliant pole and is SILENT: the rule loads on a `paths:` glob far wider
    // than the firing allowlist, and treating the two as one is the conflation this detector exists
    // not to make.
    if (cls.verdict !== "FIRE") return finish();

    const result = {
      relPath,
      matchedEntry: cls.matchedEntry,
      entryCount: surface.entries.length,
      rulePath: rule.rulePath,
    };
    const advisory = lib.formatAdvisory(result);
    const summary = `self-referential surface touched — ${relPath} (Rule-1 redteam depth applies if this is a /codify)`;
    const sig = lib.signatureOf(result);

    const rawSessionId = payload.session_id;
    const hasSessionId =
      typeof rawSessionId === "string" && rawSessionId.trim().length > 0;
    // A session with no usable id never shares a marker file with another such session — one
    // session's marker silencing a different session's finding is the one direction the suffix
    // exists to prevent. It emits, and writes nothing.
    if (!hasSessionId) return emitFinding(advisory, summary, null);

    const sinkPath = markerPathOf(repoDir, rawSessionId);
    if (alreadySurfaced(repoDir, sinkPath, sig)) return finish();

    return emitFinding(advisory, summary, () =>
      markSurfaced(repoDir, sinkPath, sig),
    );
  } catch {
    return finish();
  }
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). main() already arms its own
// fallback timer, so this is exactly the old top-level `main()` call.
function hookMain() {
  return main();
}

module.exports = { hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
