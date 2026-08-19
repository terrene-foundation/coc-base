#!/usr/bin/env node
/**
 * burndown-quote-stop-guard.js — arm (1)+(2) of `burndown-integrity.md`, on the CHAT REPLY.
 *
 * @hook-event: Stop (lifecycle) — this is where the ORIGINATING failure actually happened. The
 *   four irreconcilable counts (110 → 48 → 14/15/19 → 2/3/3) were emitted in
 *   conversation, touching no file, so no path-scoped rule and no write-time hook
 *   could ever have fired on them. Stop fires on every reply regardless of files
 *   touched, which is precisely why it is the surface that closes the class.
 *
 * TWO ARMS, TWO SEVERITIES:
 *   (1) INVALID TOKEN → `block`. STRUCTURAL: the verdict is a sha256 recomputation
 *       over the count's own bucket/denominator/value/source-digest, and a surface
 *       rewrite cannot evade it (rewriting the number is what invalidates it).
 *       `hook-output-discipline.md` MUST-2 reserves `block` for exactly this and
 *       forbids it only for LEXICAL evidence. Do not downgrade this by reflex.
 *   (2) COUNT-SHAPED CLAIM WITH NO TOKEN → `halt-and-report`. This detection IS
 *       lexical, so MUST-2 caps it below `block` — but halt-and-report still makes
 *       the agent SURFACE the claim, and surfacing is what breaks the silence.
 *
 * Every path out of the originating failure is therefore LOUD — but loud is not
 * the same as blocked, and the difference is MEASURED, not assumed. `Stop` is a
 * STOP_LIKE event: `instructAndWait` returns `{continue:true, systemMessage}`
 * and exitCode 0 for EVERY severity, because these events cannot block tool
 * calls. So at THIS surface both arms are SURFACED, never enforced; the
 * blocking teeth live on the PostToolUse write-guard (exitCode 2,
 * continue:false, same finding). The completeness claim is therefore: no path
 * out of the originating failure is SILENT. It is not "a wrong count in a chat
 * reply is blocked" — that would be false, and it is exactly the kind of
 * overclaim this rule exists to stop.
 *
 * CLASS IS `lifecycle`, NOT `guard`, and that is the SAME fact as the ceiling above.
 * `hook-event-selection.md` MUST-3: a guard is defined by the one action or artifact
 * it acts on, so it needs a Pre/PostToolUse matcher naming that tool. `Stop` has no
 * tool axis — which is precisely why it cannot block. The validator and the measured
 * STOP_LIKE behaviour agree; the blocking half of this rule lives on the PostToolUse
 * write-guard, which IS a `guard` because it names Edit|Write|NotebookEdit.
 *
 * FAILS OPEN ON EVERY UNKNOWN per `cc-artifacts.md` Rule 7, and is SCOPED BY
 * MANIFEST PRESENCE: a repo with no `burndown-manifest.json` has no burndown, so
 * this returns immediately — no transcript read, no spawn, no findings.
 */

"use strict";

const TIMEOUT_MS = 4000;
let fallback = null;

const fs = require("node:fs");
const path = require("node:path");
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

// Bounded tail + walk-back. These constants are NOT invented here: they are the
// figures `detect-violations.js` measured over 400 real transcripts (>20KB) —
// the last assistant entry carries no text block in 17.3% of sessions, walk-back
// reaches p99=5 / max=48 entries, and 512KB covered 396/396 samples.
// KNOWN RESIDUAL: that reader is a private function in `detect-violations.js`
// with no `module.exports`, so this is a second implementation of one measured
// behaviour and the two can drift. The correct fix is to extract it to
// `hooks/lib/`; it is deliberately NOT done here because that edits a live
// Stop detector every prose rule depends on.
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;
const MAX_ASSISTANT_ENTRIES = 60;

function passthrough(context) {
  if (fallback) clearTimeout(fallback);
  try {
    const out = { continue: true };
    if (context) {
      out.hookSpecificOutput = { hookEventName: "Stop", additionalContext: context };
    }
    process.stdout.write(JSON.stringify(out) + "\n");
  } catch {}
  process.exit(0);
}

fallback = setTimeout(() => passthrough(null), TIMEOUT_MS);
if (typeof fallback.unref === "function") fallback.unref();

/**
 * Newest text-bearing assistant message, as `{ text, unknown }`.
 *
 * THE THIRD STATE IS THE POINT. This returned a bare `""` for an ABSENT or
 * UNREADABLE transcript AND for "the reply genuinely had no text", and the caller
 * mapped both onto the same silent passthrough — so a transcript that could not be
 * read rendered identically to a reply with nothing to check. That is the exact
 * two-state defect `verifyText`'s `unknown` was introduced to fix one layer down;
 * the caller was left on the old shape. `unknown` non-null means THE REPLY WAS NOT
 * READ — never that it is clean.
 *
 * The distinction is drawn at "did we see ANY assistant entry": a parseable tail
 * with assistant entries but no text block is the measured-17.3% ordinary case (a
 * tool-only turn) and stays CLEAN, so this cannot cry wolf on every such reply.
 * Zero assistant entries in the whole 512KB tail is a READ problem, not a quiet
 * reply. No path here names the transcript path — a Stop advisory is rendered into
 * the session and an absolute operator path is disclosure the finding does not need.
 */
function readFinalAssistantText(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath) {
    return { text: "", unknown: "no transcript path was supplied to the Stop hook, so the reply was NOT read" };
  }
  let buf;
  try {
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
      const len = size - start;
      buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    const code = e && e.code ? e.code : "unknown error";
    return { text: "", unknown: `the session transcript could not be read (${code}), so the reply was NOT checked` };
  }
  const lines = buf.toString("utf8").split("\n");
  let seen = 0;
  for (let i = lines.length - 1; i >= 0 && seen < MAX_ASSISTANT_ENTRIES; i--) {
    const raw = lines[i].trim();
    if (!raw || raw[0] !== "{") continue;
    let e;
    try {
      e = JSON.parse(raw);
    } catch {
      continue; // a truncated first line is expected in a tail read
    }
    const msg = e && e.message;
    if (!msg || msg.role !== "assistant") continue;
    seen++;
    const content = Array.isArray(msg.content) ? msg.content : [];
    const text = content
      .filter((c) => c && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
    if (text.trim()) return { text, unknown: null };
  }
  if (seen === 0) {
    return {
      text: "",
      unknown:
        "the session transcript tail carried no assistant message at all — the reply was NOT read " +
        "(a truncated, rotated or non-JSONL transcript renders this way)",
    };
  }
  return { text: "", unknown: null }; // saw assistant entries, none text-bearing: genuinely nothing to check
}

async function main() {
  let payload;
  try {
    payload = await readStdinBounded();
  } catch {
    return passthrough(null);
  }
  const p = payload && typeof payload === "object" ? payload : {};

  let lib;
  try {
    lib = require(path.join(__dirname, "lib", "burndown-quote.js"));
  } catch {
    return passthrough(null);
  }
  // No burndown in this repo ⇒ nothing to police, and zero cost. This is what
  // keeps the lexical arm from firing on ordinary prose everywhere else.
  if (!lib.findManifest(PROJECT_DIR)) return passthrough(null);

  // An unreadable transcript is an UNKNOWN and rides the advisory channel, exactly
  // as an unrunnable verifier does. It must not look like a clean scan.
  const read = readFinalAssistantText(p.transcript_path);
  if (read.unknown) {
    return passthrough(
      lib.renderFindings({ invalid: [], untokened: [], unknown: read.unknown, surface: "chat reply" }),
    );
  }
  const text = read.text;
  if (!text) return passthrough(null);

  let res = { ran: false, invalid: [] };
  let untokened = [];
  try {
    res = lib.verifyText(PROJECT_DIR, text);
    untokened = lib.detectUntokenedCounts(PROJECT_DIR, text);
  } catch {
    return passthrough(null);
  }

  const invalid = res.ran ? res.invalid : [];
  // BUG-5: an UNKNOWN is reported, never swallowed. It rides the advisory channel
  // (continue:true) because a verifier that could not run must not stop work —
  // but it must not look like a clean scan either.
  if (invalid.length === 0 && untokened.length === 0 && res.unknown) {
    return passthrough(
      lib.renderFindings({ invalid: [], untokened: [], unknown: res.unknown, surface: "chat reply" }),
    );
  }
  if (invalid.length === 0 && untokened.length === 0) return passthrough(null);

  const body = lib.renderFindings({ invalid, untokened, unknown: res.unknown, surface: "chat reply" });

  if (fallback) clearTimeout(fallback);
  try {
    // `instructAndWait` RETURNS `{json, exitCode}`; it does NOT write stdout.
    // Returning it without emitting computes the finding in full and discards it.
    const { instructAndWait } = require("./lib/instruct-and-wait.js");
    // SEVERITY is the finding's CLASS, and it is recorded honestly: an invalid
    // token is structural (block-class), an untokened count is lexical
    // (halt-and-report, capped by `hook-output-discipline.md` MUST-2).
    //
    // MEASURED CEILING, and it is NOT what the severity implies: `Stop` is a
    // STOP_LIKE event, so `instructAndWait` returns `{continue:true,
    // systemMessage}` and exitCode 0 for EVERY severity including `block` —
    // "these events cannot block tool calls". So at this surface even a
    // block-class finding is DELIVERED AS A SURFACED MESSAGE, not enforced.
    // The blocking teeth for this rule live on the PostToolUse write-guard,
    // where the same measurement returns exitCode 2 / continue:false. Recorded
    // here so nobody reads the severity field as evidence of enforcement.
    const structural = invalid.length > 0;
    const emitted = instructAndWait({
      hookEvent: "Stop",
      severity: structural ? "block" : "halt-and-report",
      rule_id: structural ? "burndown-integrity/MUST-1" : "burndown-integrity/MUST-2",
      what_happened: structural
        ? `The reply contains ${invalid.length} INVALID burndown quote(s).`
        : `The reply makes ${untokened.length} count-shaped claim(s) carrying no provenance token.`,
      why: body,
      agent_must_report: [
        ...invalid.slice(0, 5).map((f) => `Invalid: ${f.raw} — ${f.why}`),
        ...untokened.slice(0, 5).map((h) => `Untokened: "${h.phrase}"`),
        "Quote the generated block: node .claude/bin/burndown-build.mjs --quote <bucket>",
      ],
    });
    process.stdout.write(JSON.stringify(emitted.json) + "\n");
    process.exit(emitted.exitCode);
  } catch {
    return passthrough(body);
  }
}

main().catch(() => passthrough(null));
