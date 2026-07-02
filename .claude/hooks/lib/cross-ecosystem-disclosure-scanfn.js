"use strict";

// cross-ecosystem-disclosure-scanfn.js — the PRODUCTION scanFn for the
// fork->canon disclosure guard (issue #576 / AC-2; closes the AC-2
// SECURITY-ACCEPTANCE CRITERIA documented in
// `cross-ecosystem-disclosure-guard.js` § "AC-2 SECURITY-ACCEPTANCE CRITERIA"
// — the `checkForkIdentifyingContent`-consumed scanFn contract).
//
// THE CONTRACT THIS SATISFIES (re-derived from the lib by SYMBOL, NOT the plan's
// line numbers — `checkForkIdentifyingContent` in
// `.claude/hooks/lib/cross-ecosystem-disclosure-guard.js`):
//   (a) NORMALIZE-BEFORE-MATCH — `normalizeSuspectSpan` iterates
//       (decode + zero-width-strip + NFKC) to a FIXED POINT, then strips Unicode
//       combining marks, folds Cyrillic/Greek confusables to their Latin
//       skeleton, removes any residual zero-width, collapses whitespace, AND
//       case-folds the WHOLE suspect span BEFORE the disclosure matcher runs.
//       Without the FIXED-POINT iteration a percent-/entity-encoded zero-width
//       (`%E2%80%8B` -> U+200B) re-materializes AFTER a single-pass strip and a
//       double-percent (`%2561cme` -> `%61cme` -> `acme`) only half-decodes; so
//       a fork tenant token is trivially evaded (full-width forms, %-encoding,
//       zero-width splits, combining-mark accents, Cyrillic/Greek confusables,
//       base64).
//   (b) EXPLICIT ran:true — `scanForkIdentifyingContent` returns
//       `{ ran: true, findings: [...] }` ONLY when a real scan ran; with no
//       scannable surface in `opts` it returns `{ ran: false }` so
//       `checkForkIdentifyingContent` treats the surface as UNVERIFIED and fails
//       CLOSED (the inherited invariant: guard fails closed when the scan cannot
//       run — `evidence-first-claims.md` MUST-3 + `zero-tolerance.md` Rule 3).
//
// DETECTION IS BACKED BY THE SHIPPED SCANNER, NOT RE-IMPLEMENTED.
// `.claude/bin/scan-synced-disclosure.mjs` is the SSOT for the structural
// disclosure SHAPES (`nonfoundation-org-slug`, `operator-home-path`,
// `operator-hostname`, `org-derived-runner-label`, `operator-service-label`,
// …). It is an ESM CLI that runs its `main` block on import and exposes no
// functions; the lib here is CJS and `checkForkIdentifyingContent` calls the
// scanFn SYNCHRONOUSLY (no await). Re-importing the ESM scanner (a) would run
// its main on require and (b) is async-only — incompatible with a sync scanFn.
// So this module runs the REAL scanner SYNCHRONOUSLY via `execFileSync --root`
// over a planted temp surface — duplicating none of the SHAPES array (DRY; a
// copy would drift from the SSOT and re-open the zero-on-main invariant).
//
// NORMALIZE-BEFORE-MATCH WITHOUT LOSING RAW-CASE DETECTIONS. Case-folding is
// REQUIRED by criterion (a) (a full-width `ＡＣＭＥ` NFKC-folds to UPPERCASE
// `ACME`, and the scanner's `nonfoundation-org-slug` shape is lowercase-only —
// so the fold MUST lower-case to match). But case-folding would DROP the
// case-sensitive `operator-hostname` shape (`[A-Z]…-MacBook`). So the scan
// plants TWO surfaces under the temp root and unions the findings: a RAW
// surface (preserves case-sensitive shapes) AND a NORMALIZED surface (surfaces
// the obfuscated forms a raw-byte match misses). The normalized surface is the
// criterion-(a) requirement; the raw surface is defense-in-depth.
//
// Node CJS (matches the sibling guard libs); zero deps beyond node core.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

// The SHIPPED scanner — the disclosure-detection SSOT. Resolved relative to this
// module (.claude/hooks/lib -> .claude/bin).
const SCANNER = path.resolve(
  __dirname,
  "..",
  "..",
  "bin",
  "scan-synced-disclosure.mjs",
);

// The GUARDED ROOT — the repo whose tenant identity MUST NOT leak across the
// fork->canon boundary. Resolved from this module's location (.claude/hooks/lib
// -> repo root). In a client fork this resolves to the FORK root, whose loom-only
// tenant denylist carries the fork's OWN customer tokens — exactly the identity
// the fence stops from reaching canon. Overridable via opts.repoRoot for tests.
const GUARDED_ROOT = path.resolve(__dirname, "..", "..", "..");

// The loom-only tenant denylist (relative to a repo root). The scanner's
// `customer-identity-token` shape is built from
// `<scanned-root>/.claude/disclosure-tenant-denylist.json` — the ONLY shape that
// catches a BARE customer NAME (a client codename in prose, no org-slug `/repo`
// suffix). See scan-synced-disclosure.mjs::loadCustomerIdentityShape.
const TENANT_DENYLIST_REL = path.join(
  ".claude",
  "disclosure-tenant-denylist.json",
);

// Zero-width / format codepoints used to SPLIT a token past a substring match:
// ZWSP U+200B, ZWNJ U+200C, ZWJ U+200D, the bidi marks U+200E/U+200F, WORD
// JOINER U+2060, and BOM/ZWNBSP U+FEFF. Stripped so `ac<ZWSP>me` collapses to
// `acme`.
const ZERO_WIDTH_CODEPOINTS = new Set([
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff,
]);

function _stripZeroWidth(text) {
  let out = "";
  for (const ch of text) {
    if (!ZERO_WIDTH_CODEPOINTS.has(ch.codePointAt(0))) out += ch;
  }
  return out;
}

// Fixed-point bound for the decode loop (CRIT-1). A re-encoded zero-width or a
// double-percent token needs >1 pass to collapse; >4 layers of nesting is not a
// realistic disclosure-evasion and would be cheaper to catch as raw bytes.
const MAX_NORMALIZE_PASSES = 4;

// Unicode combining marks (category Mn). Stripped after an NFKD decomposition so
// a base+accent (or a precomposed accented letter NFKD-decomposed) collapses to
// the base letter: `ácme` -> `acme` (MED-2). Without this, `ácme` NFKC-composes
// to `á…` and no longer substring-matches the denylist token / org slug `acme`.
const COMBINING_MARKS_RE = /\p{Mn}/gu;

// Confusable / skeleton fold (HIGH-3). NFKC does compatibility-decomposition
// (full-width -> ASCII) but does NOT map CONFUSABLES, so a Cyrillic/Greek
// homoglyph run (`асме` = U+0430 U+0441 U+043C U+0435) normalizes to ITSELF and
// the `[a-z]`-anchored disclosure shapes never match. This is a UTS-#39-style
// skeleton for the Latin-LOOKALIKE Cyrillic/Greek letters ONLY — NOT the full
// UTS-#39 confusables table; it covers the common lookalikes an attacker uses to
// spell an ASCII org slug / tenant token in another script. Folding a non-Latin
// lookalike to its Latin skeleton can only make the scanner catch MORE (the
// over-block direction is SAFE for a disclosure fence — security.md fail-closed).
const CONFUSABLE_MAP = new Map([
  // Cyrillic lower-case -> Latin
  ["а", "a"],
  ["в", "b"],
  ["с", "c"],
  ["е", "e"],
  ["ѕ", "s"],
  ["і", "i"],
  ["ј", "j"],
  ["к", "k"],
  ["м", "m"],
  ["н", "h"],
  ["о", "o"],
  ["р", "p"],
  ["т", "t"],
  ["у", "y"],
  ["х", "x"],
  // Cyrillic upper-case -> Latin
  ["А", "a"],
  ["В", "b"],
  ["С", "c"],
  ["Е", "e"],
  ["Ѕ", "s"],
  ["І", "i"],
  ["Ј", "j"],
  ["К", "k"],
  ["М", "m"],
  ["Н", "h"],
  ["О", "o"],
  ["Р", "p"],
  ["Т", "t"],
  ["У", "y"],
  ["Х", "x"],
  // Greek lower-case -> Latin
  ["α", "a"],
  ["ο", "o"],
  ["ρ", "p"],
  ["ν", "v"],
  ["υ", "u"],
  ["κ", "k"],
  ["ι", "i"],
  // Greek upper-case -> Latin
  ["Α", "a"],
  ["Β", "b"],
  ["Ε", "e"],
  ["Η", "h"],
  ["Ι", "i"],
  ["Κ", "k"],
  ["Μ", "m"],
  ["Ν", "n"],
  ["Ο", "o"],
  ["Ρ", "p"],
  ["Τ", "t"],
  ["Χ", "x"],
  ["Ζ", "z"],
]);

function _foldConfusables(text) {
  let out = "";
  for (const ch of text) out += CONFUSABLE_MAP.get(ch) || ch;
  return out;
}

// One decode LAYER: NFKC-fold -> strip zero-width -> decode percent -> decode
// HTML entities -> decode \uXXXX/\u{XXXX} escapes. Run to a FIXED POINT by the
// caller so a re-materialized zero-width or a double-encoded token collapses
// fully (CRIT-1); the \u arm (#576-S2 LOW) composes with the fixed-point loop so
// a `\u`-escaped JSON org value unwinds before the ecosystem-json basename scan.
function _decodeLayer(t) {
  t = t.normalize("NFKC");
  t = _stripZeroWidth(t);
  t = _decodePercent(t);
  t = _decodeHtmlEntities(t);
  t = _decodeUnicodeEscapes(t);
  return t;
}

function _decodeToFixedPoint(t) {
  for (let pass = 0; pass < MAX_NORMALIZE_PASSES; pass++) {
    const prev = t;
    t = _decodeLayer(t);
    if (t === prev) break;
  }
  return t;
}

// Decode standalone base64 ISLANDS (length>=8, base64 alphabet) and APPEND the
// printable decode so a base64-hidden token surfaces, without corrupting the
// surrounding text. Appending (not replacing) keeps false-positive decodes
// (ordinary words / path segments that look like base64) harmless — they decode
// to non-text bytes and are rejected below; a genuine base64-of-text token
// decodes cleanly and is surfaced.
const BASE64_ISLAND_RE = /\b[A-Za-z0-9+/]{8,}={0,2}\b/g;

function _isCleanPrintableAscii(s) {
  // Pure ASCII printable (0x20..0x7E). A base64-hidden org-slug / path /
  // hostname token is ASCII; an invalid-UTF-8 decode carries the U+FFFD
  // replacement char (codepoint 0xFFFD) and is rejected here.
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return s.length > 0;
}

function _decodeBase64Islands(text) {
  let appended = "";
  let m;
  BASE64_ISLAND_RE.lastIndex = 0;
  while ((m = BASE64_ISLAND_RE.exec(text)) !== null) {
    const token = m[0];
    try {
      const decoded = Buffer.from(token, "base64").toString("utf8");
      if (decoded.length <= 256 && _isCleanPrintableAscii(decoded)) {
        appended += " " + decoded;
      }
    } catch {
      // not valid base64 — ignore (the raw token is still scanned)
    }
  }
  return appended ? text + appended : text;
}

function _decodePercent(text) {
  return text.replace(/(?:%[0-9a-fA-F]{2})+/g, (seq) => {
    try {
      return decodeURIComponent(seq);
    } catch {
      return seq; // malformed %-sequence — leave as-is
    }
  });
}

function _decodeHtmlEntities(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => {
      try {
        return String.fromCodePoint(parseInt(h, 16));
      } catch {
        return _m;
      }
    })
    .replace(/&#(\d+);/g, (_m, d) => {
      try {
        return String.fromCodePoint(parseInt(d, 10));
      } catch {
        return _m;
      }
    })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

// Decode `\uXXXX` (4-hex) and `\u{XXXX}` (1-6-hex, ES2015 brace form) JSON /
// JS-string Unicode escapes (#576-S2 LOW). A bare JSON value `"org":"globex"`
// (g = 'g') is NOT a structural [a-z][a-z0-9-] org-slug run until the escape
// is unwound; without this arm the decoded `globex` never surfaces under the
// ecosystem-bare-org-slug shape staged at the ecosystem-json basename below. The
// brace form is decoded FIRST so `\u{0067}` is not half-consumed by the 4-hex arm.
// Out-of-range codepoints (>U+10FFFF) leave the literal untouched.
function _decodeUnicodeEscapes(text) {
  return text
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_m, h) => {
      const cp = parseInt(h, 16);
      if (cp > 0x10ffff) return _m;
      try {
        return String.fromCodePoint(cp);
      } catch {
        return _m;
      }
    })
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h) => {
      try {
        return String.fromCodePoint(parseInt(h, 16));
      } catch {
        return _m;
      }
    });
}

// NORMALIZE-BEFORE-MATCH (criterion (a)). Pure function; exported for direct
// unit-testing of the contract. The pipeline:
//   1. iterate (NFKC + strip-zero-width + decode-percent + decode-entity) to a
//      FIXED POINT — so a percent-/entity-encoded zero-width that RE-MATERIALIZES
//      after a strip is stripped on the next pass, and a double-percent
//      (`%2561cme` -> `%61cme` -> `acme`) decodes fully (CRIT-1);
//   2. decode base64 ISLANDS once, then re-run the decode layer to a fixed point
//      in case the base64 payload itself carried a layered / zero-width token;
//   3. strip Unicode combining marks via NFKD (MED-2 — `ácme` -> `acme`);
//   4. fold Cyrillic/Greek confusables to their Latin skeleton (HIGH-3 — `асме`
//      -> `acme`);
//   5. remove any residual zero-width (CRIT-1 belt-and-suspenders — `\s+` does
//      NOT match U+200B..U+2060/U+FEFF, so they MUST be stripped, not collapsed
//      to a space, lest `ac<ZWSP>/loom` become `ac /loom` and break adjacency);
//   6. collapse ALL Unicode whitespace to a single ASCII space, then case-fold.
// Core pipeline (steps 1-6). `lowercase` controls ONLY the final step-6 fold:
//   - lowercase:true  → normalizeSuspectSpan (criterion (a) — the lowercase-only
//     shapes, e.g. nonfoundation-org-slug / ecosystem-bare-org-slug, need it).
//   - lowercase:false → normalizeSuspectSpanPreserveCase (#576-S2 LOW): a DECODED
//     but CASE-PRESERVED surface. The scanner's operator-hostname product arms
//     (`-MacBook`/`-MacStudio`/`-MacPro`) are case-SENSITIVE with NO lowercase
//     counterpart, so a hostname needing BOTH decode (to surface) AND uppercase
//     (to match) — `Janes%E2%80%8B-MacBook` — slips RAW (encoded) and NORMALIZED
//     (lowercased) alike. Decoded-but-case-preserved is the third surface that
//     catches it. Steps 1-5 are identical to the lowercased path.
function _normalizeCore(text, lowercase) {
  if (typeof text !== "string" || text === "") return "";
  // (1) decode + strip + NFKC to a fixed point.
  let t = _decodeToFixedPoint(text);
  // (2) base64 islands, then re-decode the (possibly layered) payload to a fixed point.
  const withB64 = _decodeBase64Islands(t);
  if (withB64 !== t) t = _decodeToFixedPoint(withB64);
  // (3) strip combining marks (decompose, drop Mn, recompose the base letters).
  t = t.normalize("NFKD").replace(COMBINING_MARKS_RE, "").normalize("NFKC");
  // (4) fold Cyrillic/Greek confusables to their Latin skeleton.
  t = _foldConfusables(t);
  // (5) remove any residual zero-width re-materialized by a final decode.
  t = _stripZeroWidth(t);
  // (6) collapse whitespace, then case-fold ONLY when lowercase is requested.
  t = t.replace(/\s+/gu, " ").trim();
  if (lowercase) t = t.toLowerCase();
  return t;
}

function normalizeSuspectSpan(text) {
  return _normalizeCore(text, true);
}

// Decoded-but-case-PRESERVED surface (#576-S2 LOW). Runs the full normalize
// pipeline WITHOUT the final `.toLowerCase()` so a decode-then-uppercase-needed
// operator hostname surfaces in a form the case-sensitive scanner arms match.
function normalizeSuspectSpanPreserveCase(text) {
  return _normalizeCore(text, false);
}

// Collect the suspect span(s) to scan from the guard opts. Production callers
// pass the pulled / write surface as `content` (string) / `contents` (string[])
// / `paths` (file paths). Absence of all three = no scannable surface.
function _collectSpans(opts) {
  const spans = [];
  if (typeof opts.content === "string" && opts.content !== "") {
    spans.push(opts.content);
  }
  if (Array.isArray(opts.contents)) {
    for (const c of opts.contents) {
      if (typeof c === "string" && c !== "") spans.push(c);
    }
  }
  if (Array.isArray(opts.paths)) {
    for (const p of opts.paths) {
      try {
        spans.push(fs.readFileSync(p, "utf8"));
      } catch {
        // unreadable path — skip; if NO span survives, the caller fails closed
      }
    }
  }
  return spans;
}

// Parse the scanner's `--check` stderr lines into grep-able, SECRET-SAFE finding
// labels. Each scanner finding line is
//   <path>:<line>  [SHAPE:<id>]  <+/-20-char context, token -> «REDACTED»>
// We keep only the SHAPE id + the already-redacted context (never the raw token,
// per `security.md` § "No secrets in logs" — report the shape, not the value).
function _parseFindings(stderr) {
  const out = [];
  const seen = new Set();
  for (const line of String(stderr || "").split(/\r?\n/)) {
    const m = line.match(/\[SHAPE:([^\]]+)\]\s*(.*)$/);
    if (!m) continue;
    const label = `disclosure:${m[1].trim()} (${m[2].trim()})`;
    if (!seen.has(label)) {
      seen.add(label);
      out.push(label);
    }
  }
  return out;
}

// THE PRODUCTION scanFn (criterion (b)). Returns:
//   { ran: false }                  — no scannable surface OR the scan could not
//                                     run (usage/spawn/timeout error) ->
//                                     checkForkIdentifyingContent fails CLOSED.
//   { ran: true, findings: [...] }  — a real scan ran; findings is the union of
//                                     the raw + normalized surface scans.
function scanForkIdentifyingContent(opts = {}) {
  const spans = _collectSpans(opts);
  if (spans.length === 0) return { ran: false };

  const raw = spans.join("\n");
  const normalized = normalizeSuspectSpan(raw);
  // #576-S2 LOW: the THIRD surface — decoded but case-PRESERVED — for a hostname
  // needing BOTH decode (to surface) AND uppercase (to match the case-sensitive
  // operator-hostname product arms). RAW misses (encoded); NORMALIZED misses
  // (lowercased). Decoded-case-preserved catches `Janes%E2%80%8B-MacBook`.
  const normalizedCased = normalizeSuspectSpanPreserveCase(raw);
  const guardedRoot = opts.repoRoot || GUARDED_ROOT;
  // Injectable copy (advisory fix): defaults to fs.copyFileSync; a test injects a
  // failing copyFn to prove _stageTenantDenylist fails CLOSED on a present-but-
  // uncopyable denylist instead of silently degrading the customer-name shape.
  const copyFn = opts.copyFileFn || fs.copyFileSync;

  let tmpRoot;
  try {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xeco-scan-"));
    const claudeDir = path.join(tmpRoot, ".claude");
    const rulesDir = path.join(claudeDir, "rules");
    fs.mkdirSync(rulesDir, { recursive: true });
    // HIGH-1: stage the GUARDED ROOT's tenant denylist into the scan's temp root
    // so the scanner's `customer-identity-token` shape ACTIVATES. The scanner
    // builds that shape from `<scanned-root>/.claude/disclosure-tenant-denylist.json`;
    // the temp root has none, so absent this copy the ONLY shape catching a bare
    // customer NAME is permanently inert and a client codename in prose rides
    // through. No-op safe when the guarded root declares NO denylist (existsSync
    // false). Advisory fix: when the denylist IS present but the copy throws,
    // _stageTenantDenylist re-throws so this try's catch fails the scan CLOSED
    // (ran:false) — it does NOT silently proceed with the shape inert.
    _stageTenantDenylist(tmpRoot, guardedRoot, copyFn);
    // THREE surfaces under one root: RAW (case-sensitive shapes) + NORMALIZED
    // (criterion (a) — the obfuscated forms a raw-byte match misses, lowercased) +
    // NORMALIZED-CASE-PRESERVED (#576-S2 LOW — decode-then-uppercase hostnames).
    fs.writeFileSync(path.join(rulesDir, "_xeco-raw.md"), raw, "utf8");
    if (normalized) {
      fs.writeFileSync(
        path.join(rulesDir, "_xeco-norm.md"),
        normalized,
        "utf8",
      );
    }
    if (normalizedCased && normalizedCased !== normalized) {
      fs.writeFileSync(
        path.join(rulesDir, "_xeco-norm-cased.md"),
        normalizedCased,
        "utf8",
      );
    }
    // #576-S2 MED: ALSO stage every surface under a basename matching the
    // file-scoped shapes so the `ecosystem-bare-org-slug` shape
    // (fileScope: /^ecosystem.*\.json$/) — the ONLY detector for a BARE JSON
    // `"org":"globex"` / `"host":"..."` value that nonfoundation-org-slug is
    // structurally BLIND to — actually fires. The `.md` rules-dir staging above
    // never matches that shape's fileScope, so the bare slug rode through. Under
    // `--root tmpRoot` this `ecosystem.scan.json` is NOT self-excluded (the
    // scanner's ecosystem.json self-exclude is loom-source-only). Staging the
    // DECODED forms here too lets the file-scoped shape see a `\u`/percent-encoded
    // value after it is unwound (composes with the _decodeLayer \u arm).
    const ecoSurface = [raw, normalized, normalizedCased]
      .filter((s) => typeof s === "string" && s !== "")
      .join("\n");
    fs.writeFileSync(
      path.join(claudeDir, "ecosystem.scan.json"),
      ecoSurface,
      "utf8",
    );
  } catch {
    // Could not stage the temp surface — the scan cannot run -> fail CLOSED.
    _cleanup(tmpRoot);
    return { ran: false };
  }

  try {
    execFileSync("node", [SCANNER, "--root", tmpRoot, "--check"], {
      encoding: "utf8",
      timeout: 5000,
    });
    // exit 0 — the scanner ran clean (no findings).
    _cleanup(tmpRoot);
    return { ran: true, findings: [] };
  } catch (e) {
    _cleanup(tmpRoot);
    if (e && e.status === 1) {
      // exit 1 — findings present (printed to stderr in --check mode).
      return { ran: true, findings: _parseFindings(e.stderr) };
    }
    // exit 2 (scanner usage error, e.g. a malformed denylist) OR a spawn/timeout
    // error — the disclosure detector did NOT produce a verdict. Per
    // evidence-first-claims.md MUST-3 an errored detector is NOT an all-clear:
    // fail CLOSED (ran:false -> checkForkIdentifyingContent treats UNVERIFIED).
    return { ran: false };
  }
}

// HIGH-1 helper. Copy the guarded root's tenant denylist into the temp scan root
// so the scanner's `customer-identity-token` shape activates.
//
// FAIL-CLOSED on present-but-uncopyable (advisory fix, #576-S2). Two cases:
//   - existsSync FALSE → the guarded root declares NO denylist (a fork with no
//     tenant tokens). The customer-name shape stays inert EXACTLY as a real
//     consumer scan would — a clean no-op, NO false positive.
//   - existsSync TRUE but the copy throws → the denylist EXISTS, so the
//     customer-identity-token shape is SUPPOSED to run. The pre-fix `catch{}`
//     swallowed the error and proceeded with the shape INERT — a silent degrade
//     to the pre-HIGH-1 baseline (a fork tenant token rides through unscanned).
//     For a FENCE that is a fail-OPEN: a real customer codename crosses canon
//     unscrubbed. We now LET THE THROW PROPAGATE so the caller treats it as
//     scan-cannot-run (returns ran:false → the guard fails CLOSED / BLOCKS), per
//     evidence-first-claims.md MUST-3 (an errored detector is NOT an all-clear)
//     + zero-tolerance.md Rule 3 (no swallow-into-clean-verdict).
function _stageTenantDenylist(tmpRoot, guardedRoot, copyFn = fs.copyFileSync) {
  if (typeof guardedRoot !== "string" || guardedRoot === "") return;
  const src = path.join(guardedRoot, TENANT_DENYLIST_REL);
  if (!fs.existsSync(src)) return; // no denylist at the guarded root → inert (safe)
  // Denylist present → the copy MUST succeed or the scan cannot run. A throw here
  // propagates to scanForkIdentifyingContent's staging catch → ran:false (BLOCK).
  copyFn(src, path.join(tmpRoot, TENANT_DENYLIST_REL));
}

function _cleanup(tmpRoot) {
  if (!tmpRoot) return;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort temp cleanup
  }
}

module.exports = {
  scanForkIdentifyingContent,
  normalizeSuspectSpan,
  normalizeSuspectSpanPreserveCase,
  // exported for direct contract tests:
  _foldConfusables,
  _decodeUnicodeEscapes,
  _stageTenantDenylist,
  GUARDED_ROOT,
  TENANT_DENYLIST_REL,
};
