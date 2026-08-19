#!/usr/bin/env node
/**
 * burndown-quote.js — the shared verification seam for `burndown-integrity.md`.
 *
 * Both enforcement surfaces call THIS, so the two hooks stay thin and cannot
 * drift apart on what "valid" means:
 *   - PostToolUse (Edit|Write) — durable writes, where a bad count persists.
 *   - Stop — the chat reply, where the ORIGINAL failure actually happened.
 *
 * TWO ARMS, DELIBERATELY DIFFERENT SEVERITIES, and the difference is load-bearing:
 *
 *   (1) INVALID TOKEN → `block`. This is a STRUCTURAL signal, not a lexical one.
 *       Validation is a deterministic recomputation of sha256 over the count's own
 *       bucket, denominator, value and source digest — and a SURFACE REWRITE CANNOT
 *       EVADE IT, because rewriting the number is precisely what invalidates it.
 *       `hook-output-discipline.md` MUST-2 reserves `block` for "facts the regex
 *       cannot misread" and requires "a structural signal that the regex cannot
 *       evade by surface rewrite". Token validation is exactly that, so `block` is
 *       legitimate here. Do NOT "correct" this down to advisory: the regex only
 *       LOCATES the candidate; the VERDICT comes from the recomputation.
 *
 *   (2) COUNT-SHAPED CLAIM WITH NO TOKEN → `halt-and-report`, never `block`.
 *       That detection IS lexical, so MUST-2 caps it below `block`. But
 *       halt-and-report still forces the agent to SURFACE the claim, which breaks
 *       the silence that was the original failure — four numbers emitted silently
 *       and confidently.
 *
 * FAILS OPEN, BUT NEVER SILENTLY — the distinction is the whole of BUG-4/5.
 * `cc-artifacts.md` Rule 7 says a broken verifier must not block real work, and it
 * does not: nothing here ever returns `block` on an unknown. But an unknown is
 * REPORTED as an unknown (`out.unknown`), not rendered as an absence of findings.
 * The original two-state shape mapped "could not run" onto the same value as
 * "ran, found nothing", so ONE uncommitted source — the normal state while someone
 * edits the register — silently switched the entire layer off at exactly the
 * moment counts were moving. No-manifest is the ONE genuine no-op, because a repo
 * with no burndown truly has nothing to check.
 *
 * SCOPED BY MANIFEST PRESENCE, which is what keeps arm (2) from crying wolf. A
 * repo with no `burndown-manifest.json` has no burndown, so "3 open" there is
 * ordinary prose and this file returns nothing at all — including zero subprocess
 * cost. Both arms are live ONLY where a burndown actually exists.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MANIFEST_BASENAME = "burndown-manifest.json";
const GENERATOR_REL = path.join(".claude", "bin", "burndown-build.mjs");
const SPAWN_TIMEOUT_MS = 3000;
const MAX_TEXT_BYTES = 256 * 1024;

/** The closed vocabulary, plus the labels the rule BLOCKS as count labels. */
const BUCKET_WORDS = [
  "signed off",
  "built-not-walked",
  "in progress",
  "not started",
  "blocked on you",
  "open",
];
// The rule's OWN canonical violation is ``7 left`` (MUST-2), and this list did
// not contain "left" — so the archetype the clause is written around was the one
// shape arm (2) could not see. The additions are the words a close-out actually
// reaches for when it means "still open".
const BLOCKED_COUNT_LABELS = [
  "done",
  "complete",
  "closed",
  "finished",
  "remaining",
  "remains",
  "remain",
  "left",
  "outstanding",
  "pending",
  "unresolved",
  "to go",
];

// One Unicode-safe digit class, shared with the generator's scanner. ASCII `\d`
// was how a fullwidth digit walked past the whole layer.
const DIGIT = String.raw`\p{Nd}`;

/**
 * A number sitting next to a bucket word.
 *
 * The `(?!⟨)` excludes a count that already carries its token. It is redundant
 * with the masking below and kept as a cheap second fence, not as the primary
 * one — measured, deleting it alone changes nothing.
 */
const UNTOKENED_RX = new RegExp(
  String.raw`\b(${DIGIT}+)(?!⟨)\s*(?:of\s+${DIGIT}+\s+)?(` +
    [...BUCKET_WORDS, ...BLOCKED_COUNT_LABELS].map((w) => w.replace(/[-\s]/g, "[-\\s]")).join("|") +
    String.raw`)\b`,
  "giu",
);

/**
 * Blank out COMPLIANT tokenised quotes — including their `of <denominator>
 * <label>` tail — before the lexical scan.
 *
 * Without this, arm (2) flags the DENOMINATOR of a correct quote: `5⟨tok⟩ of 7
 * Open` trips on "7 Open". That is worse than a miss — on the BUG-1 and BUG-2
 * exploits the only thing that fired was arm (2) complaining about the truthful
 * half while arm (1) missed the lie entirely, which trains a reader to discount
 * the guard exactly when it is right.
 */
const TOKENISED_SPAN_RX = new RegExp(
  String.raw`${DIGIT}+⟨[0-9a-f]{6}⟩(?:\s*of\s+${DIGIT}+\s*\x60?[^\x60\n.]{0,40}\x60?)?`,
  "giu",
);
function maskTokenisedSpans(text) {
  return text.replace(TOKENISED_SPAN_RX, (m) => " ".repeat(m.length));
}

/** Locate the manifest. Returns null when this repo simply has no burndown. */
function findManifest(projectDir) {
  try {
    const p = path.join(projectDir, MANIFEST_BASENAME);
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

function hasGenerator(projectDir) {
  try {
    return fs.existsSync(path.join(projectDir, GENERATOR_REL));
  } catch {
    return false;
  }
}

/**
 * Revalidate every `N⟨token⟩` in `text` against the repo's current block.
 *
 * Returns `{ ran, invalid, checked }`. `ran:false` means the question was not
 * answered — NOT that the text is clean. Callers must not treat one as the other
 * (`instrument-discipline.md` MUST-1).
 */
function verifyText(projectDir, text) {
  // `unknown` is the THIRD state, and it exists because the two-state shape was
  // the bug: a scan that could not run returned `{ran:false, invalid:[]}`, which
  // the caller passed through silently — indistinguishable from "checked, clean".
  const out = { ran: false, invalid: [], checked: 0, unknown: null };
  if (typeof text !== "string" || text.length === 0) return out;
  if (!findManifest(projectDir) || !hasGenerator(projectDir)) return out; // no burndown ⇒ genuinely nothing to do

  // BUG-4: truncating at MAX_TEXT_BYTES and reporting the head as if it were the
  // whole was a silent partial scan — an invalid quote at 262,190 B passed while
  // the identical quote at 44 B blocked, and journal/ and workspaces/ reports
  // routinely exceed the cap. A truncated scan is UNKNOWN, never clean.
  //
  // THE CAP CHECK RUNS BEFORE THE TOKEN CHECK, and the order is the whole of the
  // fix. It used to sit AFTER `if (!tokenPresent) return out`, so it was
  // UNREACHABLE for over-cap text carrying no token — the only path arm (2) uses.
  // BUG-4's fix survived textually but not semantically: it covered only the path
  // that ALREADY had a token. Measured on the rule's own MUST-2 archetype:
  // `detectUntokenedCounts("We have 7 left and 3 open.")` returns two hits under the
  // cap; the SAME sentence at 262,194 B returned `{ran:false, unknown:null}` here
  // and `[]` there — a silent miss on both arms at once. Moving the check above the
  // token gate records the cap on BOTH paths, which is what the comment in
  // `detectUntokenedCounts` already (wrongly) claimed was happening.
  if (text.length > MAX_TEXT_BYTES) {
    out.unknown = `text is ${text.length} B, over the ${MAX_TEXT_BYTES} B scan cap — quotes and count-shaped claims past the cap were NOT checked`;
    return out;
  }

  const tokenPresent = /⟨[0-9a-f]{6}⟩/.test(text);
  if (!tokenPresent) return out;

  let r;
  try {
    r = spawnSync(process.execPath, [path.join(projectDir, GENERATOR_REL), "--verify-quote", "-"], {
      cwd: projectDir,
      input: text,
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (e) {
    out.unknown = `verifier could not be spawned (${e && e.code ? e.code : "unknown error"})`;
    return out;
  }
  if (!r || r.error || r.status === null) {
    out.unknown = `verifier did not complete (${r && r.error ? r.error.code || r.error.message : "no status"})`;
    return out;
  }
  // BUG-5: exit 2 means the GENERATOR refused — typically one declared source is
  // mid-edit, which is the NORMAL state while someone is moving the register.
  // Mapping that to a silent passthrough switched the whole layer off at exactly
  // the moment counts were changing. It is surfaced now, not swallowed.
  if (r.status === 2) {
    const first = (r.stderr || "").split("\n").find((l) => l.startsWith("UNRUNNABLE")) || "generator refused";
    out.unknown = `verification did not run — ${first.replace(/^UNRUNNABLE — refusing because /, "")}`;
    return out;
  }

  const stderr = r.stderr || "";
  for (const line of stderr.split("\n")) {
    const m = line.match(/^INVALID QUOTE (\S+) — (.*)$/);
    if (m) out.invalid.push({ raw: m[1], why: m[2] });
  }
  const c = (r.stdout || "").match(/(\d+) tokenised count\(s\)/);
  out.checked = c ? Number(c[1]) : out.invalid.length;

  // BUG-2 (second half): this function ALREADY established a token is present, so
  // "none found" from the verifier is a CONTRADICTION, not a clean result — it is
  // how a non-ASCII-digit evasion rendered as a pass. Detectable ⇒ UNKNOWN.
  if (out.checked === 0 && out.invalid.length === 0) {
    out.unknown =
      "a provenance token is present in the text but the verifier parsed ZERO counts — " +
      "the count beside it may use non-ASCII digits or a shape the scanner does not read";
    return out;
  }

  out.ran = true;
  return out;
}

/**
 * Arm (2): count-shaped claims carrying NO token.
 *
 * Deliberately conservative — it fires only where a burndown EXISTS, only on a
 * number adjacent to a closed-vocabulary bucket word, and never on a count that
 * already carries its token. Capped at `halt-and-report` because this is lexical.
 */
function detectUntokenedCounts(projectDir, text) {
  const hits = [];
  if (typeof text !== "string" || !text) return hits;
  if (!findManifest(projectDir)) return hits;
  // Truncation here is a MISS, not a false pass — arm (2) is halt-and-report and
  // over-reporting is its only real risk — but the cap is recorded by the caller via
  // `verifyText`'s `unknown`, so a partial lexical scan is never sold as a complete
  // one. That claim was FALSE when written: `verifyText` returned before its own cap
  // check whenever no token was present, which is precisely arm (2)'s path, so an
  // over-cap untokened count was dropped here and reported as clean there. It is
  // true now only because the cap check was moved ABOVE the token gate; do not move
  // it back, or this comment goes back to describing something that does not happen.
  const capped = text.length > MAX_TEXT_BYTES ? text.slice(0, MAX_TEXT_BYTES) : text;
  const body = maskTokenisedSpans(capped);
  let m;
  UNTOKENED_RX.lastIndex = 0;
  while ((m = UNTOKENED_RX.exec(body)) !== null) {
    hits.push({ phrase: m[0].trim(), value: m[1], bucket: m[2] });
    if (hits.length >= 20) break; // bounded evidence
  }
  return hits;
}

/** One bounded, readable advisory for either surface. */
function renderFindings({ invalid, untokened, unknown, surface }) {
  const L = [];
  if (unknown) {
    L.push(`⚠ Burndown quote verification DID NOT RUN — ${surface}.`);
    L.push("");
    L.push(`- ${unknown}`);
    L.push("");
    L.push(
      "This is an UNKNOWN, not a clean result: quotes in this text were NOT checked. " +
        "Do not read the absence of findings as a pass. Resolve the cause (commit the " +
        "declared sources, or re-quote below the scan cap) and re-run.",
    );
  }
  if (invalid && invalid.length) {
    L.push(`⛔ Burndown quote INVALID (burndown-integrity MUST-1) — ${surface}.`);
    L.push("");
    for (const f of invalid) L.push(`- ${f.raw} — ${f.why}`);
    L.push("");
    L.push(
      "This is a STRUCTURAL finding: the token is a recomputation over the count's own " +
        "bucket, denominator, value and source digest, and no rewording evades it. " +
        "Re-quote from the block: `node .claude/bin/burndown-build.mjs --quote <bucket>`.",
    );
  }
  if (untokened && untokened.length) {
    if (L.length) L.push("");
    L.push(`⚠ Count-shaped claim carrying NO provenance token — ${surface}. halt-and-report.`);
    L.push("");
    for (const h of untokened) L.push(`- "${h.phrase}"`);
    L.push("");
    L.push(
      "Quote the block instead of computing in prose: " +
        "`node .claude/bin/burndown-build.mjs --quote <bucket>`. " +
        "If this number is not a burndown count, say so explicitly — this arm is lexical " +
        "and cannot tell, which is why it reports rather than blocks.",
    );
  }
  return L.join("\n");
}

module.exports = {
  findManifest,
  hasGenerator,
  verifyText,
  detectUntokenedCounts,
  renderFindings,
  MANIFEST_BASENAME,
  GENERATOR_REL,
  UNTOKENED_RX,
};
