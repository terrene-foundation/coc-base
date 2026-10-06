#!/usr/bin/env node
/**
 * register-regression-guard.js — runs AT THE MOMENT THE WRONG ROW IS WRITTEN.
 *
 * @hook-event: PreToolUse:Edit|NotebookEdit|Write (guard) — the subject is the CONTENT ABOUT TO BE WRITTEN to a declared register, and PreToolUse is the only event that can refuse it before the wrong row exists; the incoming content is reconstructible here because the subject is ONE declared JSON file.
 *
 * WHY PreToolUse, when the sibling `burndown-quote-write-guard.js` deliberately
 * chose PostToolUse. That guard scans FREE PROSE on any durable surface, where the
 * written artefact is the only honest subject — an `Edit` result is a merge and
 * cannot be reconstructed from `tool_input` in general. This guard's subject is a
 * SINGLE DECLARED JSON FILE, so the incoming content IS reconstructible: `Write`
 * carries it whole, and an `Edit` is one deterministic string replacement over a
 * file already on disk. That difference is what makes PreToolUse available here,
 * and where it is available it is the correct event: the failure this exists to
 * stop is a wrong row being WRITTEN, so a post-mortem arrives one step too late.
 * `hook-event-selection.md` prefers the earliest event that can actually decide.
 *
 * WHY GUARD A-2 MAY CARRY `block`. `hook-output-discipline.md` MUST-2 reserves
 * `block` for facts a regex cannot misread, needing a structural signal that
 * surface rewrite cannot evade. A-2 is exactly two such facts and no prose at all:
 *   (i)  an INTEGER COMPARISON over a CLOSED status enum — did this row fall out
 *        of the delivered band? The lookup normalises case, spacing and hyphens,
 *        so rewriting `Signed off` as `signed-off` changes nothing.
 *   (ii) a JSON KEY-PRESENCE test — is there a `regression_rebuttal` at all?
 * Neither reads a word of the rebuttal. The moment the verdict depends on WHAT the
 * rebuttal SAYS (A-1) it is lexical, and it is capped at `halt-and-report`. So are
 * B-0/B-1/B-2. Do not "tidy" these onto one severity: the split is the finding.
 *
 * FAILS OPEN ON EVERY UNKNOWN per `cc-artifacts.md` Rule 7 — no manifest, a path
 * that is not a declared register, no HEAD blob, unparseable JSON on either side,
 * an unreconstructible edit, a spawn failure, a timeout. A repo with no burndown
 * manifest pays one `existsSync` and sees nothing. An UNKNOWN is SURFACED as
 * UNKNOWN and never rendered as clean.
 */

"use strict";

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
      out.hookSpecificOutput = { hookEventName: "PreToolUse", additionalContext: context };
    }
    process.stdout.write(JSON.stringify(out) + "\n");
  } catch {}
  process.exit(0);
}

/**
 * Reconstruct the content this call is about to write.
 *
 * Returns null for anything not reconstructible EXACTLY. A guessed reconstruction
 * would grade a document that is not the one being written, which is worse than
 * not grading at all.
 */
function incomingContent(toolName, input, abs) {
  if (toolName === "Write") {
    return typeof input.content === "string" ? input.content : null;
  }
  if (toolName !== "Edit") return null;
  const oldS = input.old_string;
  const newS = input.new_string;
  if (typeof oldS !== "string" || typeof newS !== "string") return null;
  let cur;
  try {
    cur = fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  if (oldS === "") return null;
  const first = cur.indexOf(oldS);
  if (first === -1) return null; // the Edit will fail on its own terms
  if (input.replace_all === true) return cur.split(oldS).join(newS);
  // A non-unique `old_string` without `replace_all` is an error the Edit tool
  // itself rejects; reconstructing one arbitrary resolution would grade a
  // document that will never exist.
  if (cur.indexOf(oldS, first + oldS.length) !== -1) return null;
  return cur.slice(0, first) + newS + cur.slice(first + oldS.length);
}

async function main() {
  let payload;
  try {
    payload = await readStdinBounded();
  } catch {
    return passthrough(null);
  }
  const p = payload && typeof payload === "object" ? payload : {};
  const toolName = p.tool_name;
  if (toolName !== "Edit" && toolName !== "Write") return passthrough(null);

  const input = (p.tool_input && typeof p.tool_input === "object" && p.tool_input) || {};
  const filePath = input.file_path;
  if (typeof filePath !== "string" || !filePath) return passthrough(null);

  // CHEAPEST POSSIBLE BAIL. Every declared source is JSON (`burndown-build.mjs`
  // reads all of them through `readJson`), so this one test drops effectively
  // every edit in the repo before any file is opened.
  if (!/\.json$/i.test(filePath)) return passthrough(null);

  const rel = (path.isAbsolute(filePath) ? path.relative(PROJECT_DIR, filePath) : filePath).replace(/\\/g, "/");
  if (rel.startsWith("..")) return passthrough(null); // outside the project — not ours

  let lib;
  try {
    lib = require(path.join(__dirname, "lib", "register-regression.js"));
  } catch (e) {
    // Past this point every bail is on a path we have NOT yet shown to be
    // unrelated, so a bare passthrough would be indistinguishable from
    // "checked, clean" — the exact non-discriminating result
    // `instrument-discipline.md` MUST-1 forbids reading as a verdict.
    return passthrough(
      `register-regression: UNKNOWN, not clean — the predicate library failed to load (${e && e.code}). ` +
        `Delivery-claim retractions and owed-row checks did NOT run for this write.`,
    );
  }

  const manifest = lib.findManifest(PROJECT_DIR);
  if (!manifest) return passthrough(null); // no tracker-source convention to key on
  if (!lib.isDeclaredRegister(manifest, rel, PROJECT_DIR)) return passthrough(null);

  // FROM HERE the file IS a declared register, so silence is never neutral.
  const abs = path.isAbsolute(filePath) ? filePath : path.join(PROJECT_DIR, filePath);
  const next = incomingContent(toolName, input, abs);
  if (next === null) {
    return passthrough(
      `register-regression: UNKNOWN, not clean — could not reconstruct the incoming content for the declared ` +
        `register '${rel}' (a non-unique \`old_string\` without \`replace_all\`, an unreadable file, or an ` +
        `unsupported tool shape). Delivery-claim retractions and owed-row checks did NOT run for this write.`,
    );
  }

  let res;
  try {
    res = lib.evaluate(PROJECT_DIR, rel, next);
  } catch (e) {
    return passthrough(
      `register-regression: UNKNOWN, not clean — the check threw on '${rel}' (${e && e.message}). ` +
        `Delivery-claim retractions and owed-row checks did NOT run for this write.`,
    );
  }

  // "could not check" and "checked, clean" are OPPOSITE facts. Surfacing the
  // first as advisory context keeps them distinguishable without blocking.
  if (res.unknown) {
    return passthrough(
      `register-regression: UNKNOWN, not clean — ${res.unknown}. ` +
        `Delivery-claim retractions and owed-row checks did NOT run for this write.`,
    );
  }
  if (!res.ran || res.findings.length === 0) return passthrough(null);

  const blocking = res.findings.filter((f) => f.severity === "block");
  // `pre-action`, NOT `halt-and-report`, for the non-blocking arms.
  //
  // The CLASSIFICATION stays `halt-and-report` on the finding itself — that is the
  // MUST-2 ceiling and it is what the fixtures assert. But at PreToolUse the
  // RENDERED head for `halt-and-report` reads "the action ALREADY RAN. Report it
  // and wait", and the action has NOT run: this hook fires BEFORE the write. That
  // is verbatim the loom#1715 H-1 bug `pre-action` was minted to fix, and passing
  // `halt-and-report` here re-introduced it on every non-block finding. `pre-action`
  // renders "the action has NOT run yet" and still exits 0.
  const severity = blocking.length ? "block" : "pre-action";
  const lead = blocking.length ? blocking : res.findings;
  const body = lib.renderFindings(res.findings, rel);

  if (fallback) clearTimeout(fallback);
  try {
    // `instructAndWait` RETURNS `{json, exitCode}` and does NOT write stdout.
    // Returning it without emitting computes the whole finding and then discards
    // it, and every surface reports success — the result-not-delivered class the
    // sibling guard shipped once before its fixtures caught it.
    const { instructAndWait } = require("./lib/instruct-and-wait.js");
    const emitted = instructAndWait({
      hookEvent: "PreToolUse",
      severity,
      rule_id: blocking.length ? "state-regression-integrity/MUST-1" : "state-regression-integrity",
      what_happened:
        `This write to the declared burndown register '${rel}' carries ${res.findings.length} ` +
        `state-regression finding(s) against the COMMITTED record at HEAD.`,
      why: body,
      agent_must_report: [
        `Register: ${rel}`,
        ...lead.slice(0, 5).map((f) => `[${f.guard}] ${f.id}: ${f.reason}`),
        "Do NOT demote a delivered row because THIS session did not verify it.",
      ],
    });
    process.stdout.write(JSON.stringify(emitted.json) + "\n");
    process.exit(emitted.exitCode);
  } catch {
    return passthrough(body); // even the emit path fails open
  }
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
