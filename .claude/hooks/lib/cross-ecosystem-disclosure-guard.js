"use strict";

// cross-ecosystem-disclosure-guard.js — the STANDALONE canon<->fork
// disclosure-isolation pre-write guard (issue #584 AC-1).
//
// THE GAP IT CLOSES (grounded in source):
//   rules/artifact-flow.md:52 states the bidirectional-isolation invariant
//   ("no ceremony, sync, deploy, or publish may carry one ecosystem's
//   identity into another's committed/shared/public surface") rests on TWO
//   PRESENT, GENERAL-PURPOSE fences — NEITHER canon<->fork-AWARE:
//     (a) repo-scope-discipline.md's cross-repo-write prohibition, which
//         happens to block a fork->canon write only because canon + fork are
//         different repos — it does NOT model the canon<->fork relationship;
//     (b) the publish-to-public.mjs INCLUDE allowlist, which governs the
//         PUBLIC-fork publish path, NOT fork->canon writes within the private
//         ecosystem set.
//   The hole: repo-scope-discipline.md:30 (the five-condition User-Authorized
//   Exception) could authorize a fork->canon write WITHOUT the canon<->fork
//   isolation EVER being checked. This guard closes THAT envelope-expansion
//   gap for THIS boundary specifically.
//
// DESIGN (a WIRE over the SHIPPED ecosystem-config loader + disclosure scanner
// — it re-implements NEITHER):
//   - Boundary recognition: lib/ecosystem-config.mjs::getUpstreamCanon() is the
//     SHIPPED keystone. A fork's ecosystem.json carries `ecosystem.upstream_canon`
//     (the canon it syncs upstream FROM); canon's is null (canon is the root).
//     A write is fork->canon IFF (i) THIS repo is a fork (upstream_canon set)
//     AND (ii) the write TARGETS the named canon ecosystem. canon-side and
//     intra-ecosystem writes are NOT the boundary and pass through untouched.
//   - Disclosure check: the fork-IDENTIFYING-content predicate reuses the SAME
//     fork tenant-token surface (org slug, customer name, internal paths) the
//     intake/publish fences already scrub; injectable for tests so a
//     deterministic finding-set can be supplied.
//   - O1 carve-out: a PUBLIC-authority O1 artifact (artifact-flow.md:200 —
//     public ISO / SOC 2 / GDPR / etc. authorities are ecosystem-neutral) is
//     PERMITTED to cross even fork->canon, because it carries NO fork identity.
//
// SEVERITY: this is a STRUCTURAL boundary primitive (the boundary is computed
// from the ecosystem.json upstream_canon pointer + the target ecosystem id — a
// deterministic, process-local fact the agent cannot rationalize away), so the
// guard MAY carry `block` severity per hook-output-discipline.md MUST-2. It is
// fail-LOUD + TYPED: every refusal returns a typed result naming WHY.
//
// SCOPE (issue #584): this ships the standalone pre-write guard LIBRARY
// primitive. The sibling entry-point hook (../cross-ecosystem-disclosure-guard.js)
// IS registered in settings.json on the Edit|Write|NotebookEdit PreToolUse
// matcher (F3 Level-1, 2026-06-25, journal/0335) — it RUNS live but its BLOCK
// branch is DORMANT until a write DECLARES a target ecosystem (whose only consumer
// is the deferred sync-from-canon driver). Separately, the AUTONOMOUS
// cross-ecosystem write-DETECTION an always-on fence would need depends on the
// deferred ecosystem-remote resolver (cross-repo.md § "Ecosystem-Scoped Remote
// Links (design contract)" — not yet built). AC-2 (wire the guard onto the
// sync-from-canon INTAKE path) DEPENDS ON #576 (the sync-from-canon driver,
// UNBUILT) and is DEFERRED-with-note. See guardForkToCanonWrite's `intakePath`
// parameter doc + the strict-xfail test.
//
// AC-2 SECURITY-ACCEPTANCE CRITERIA (when #576/AC-2 wires the real production
// scanFn, it MUST hold BOTH):
//   (a) NORMALIZE-BEFORE-MATCH — before substring-matching org-slug / customer-
//       name / internal-path tokens, the scanFn MUST case-fold, NFKC unicode-
//       normalize, decode percent-/base64-/HTML-entity encodings, strip
//       zero-width codepoints, AND collapse whitespace. Without normalization,
//       substring matching of a fork tenant token is trivially evaded
//       (full-width forms, homoglyphs, %-encoding, zero-width splits).
//   (b) EXPLICIT ran:true — the scanFn MUST return `{ ran: true, findings: [...] }`
//       on a real scan and MUST NEVER rely on a bare `{}` to signal "clean". A
//       result that does not EXPLICITLY carry `ran === true` is treated as
//       UNVERIFIED / not-run and fails CLOSED (now enforced by
//       checkForkIdentifyingContent per fix #3 below).
//
// TODAY the canon<->fork disclosure-isolation invariant is
// held by the two general-purpose fences (repo-scope-discipline.md's
// cross-repo-write prohibition + the publish-to-public.mjs INCLUDE allowlist);
// see artifact-flow.md § "Ecosystem Forks vs Downstream Consumers".
//
// Node CJS (matches the sibling guard libs consumed by the hooks), zero deps.

const path = require("path");

// The ESM ecosystem-config loader is the boundary-recognition keystone. It is
// loaded lazily + injectably (opts.getUpstreamCanonFn) so the CJS guard + its
// node:test suite never pay a top-level dynamic import. The DEFAULT path uses a
// memoized dynamic import of the SHIPPED loader.
let _ecoConfigModulePromise = null;
function _loadEcoConfig() {
  if (!_ecoConfigModulePromise) {
    const url = require("url");
    const ecoPath = path.resolve(
      __dirname,
      "..",
      "..",
      "bin",
      "lib",
      "ecosystem-config.mjs",
    );
    _ecoConfigModulePromise = import(url.pathToFileURL(ecoPath).href);
  }
  return _ecoConfigModulePromise;
}

// ── boundary recognition ───────────────────────────────────────────────────
// Returns one of:
//   { boundary: "fork->canon", canon: {remote, url|...} }  — THIS repo is a
//        fork (upstream_canon set) AND the write targets the named canon.
//   { boundary: "intra-ecosystem" }  — write stays inside this ecosystem
//        (or this repo is canon, which has no upstream to cross to).
// The async default reads the SHIPPED loader; opts.upstreamCanon (sync) lets a
// caller/test inject the pointer directly (null = canon/root; object = fork).
async function recognizeBoundary(opts = {}) {
  let upstreamCanon;
  if (Object.prototype.hasOwnProperty.call(opts, "upstreamCanon")) {
    upstreamCanon = opts.upstreamCanon; // injected (null = canon, object = fork)
  } else if (typeof opts.getUpstreamCanonFn === "function") {
    upstreamCanon = opts.getUpstreamCanonFn();
  } else {
    const mod = await _loadEcoConfig();
    upstreamCanon = mod.getUpstreamCanon();
  }

  // canon (or a back-compat consumer with no ecosystem.json) has no upstream to
  // cross to — every write it makes is, by definition, NOT a fork->canon write.
  if (!upstreamCanon) return { boundary: "intra-ecosystem" };

  // THIS repo is a fork. The write crosses the boundary IFF its declared target
  // ecosystem is the named canon. The caller supplies the target via
  // opts.targetEcosystem (the destination of the write — e.g. the sync-from-canon
  // reverse direction, or a user-authorized cross-repo grant naming canon).
  // ABSENT a declared canon-target, the write is intra-ecosystem (the fork
  // editing its OWN surface), which is the overwhelmingly common case.
  const target = opts.targetEcosystem;
  if (!target) return { boundary: "intra-ecosystem" };

  // Fail-CLOSED on a malformed/ambiguous upstream_canon pointer: a fork has
  // DECLARED a write-target, but the pointer carries NEITHER a usable `remote`
  // NOR a usable `url` to match against — so we cannot prove the target is NOT
  // canon. Treating that as intra-ecosystem-allow would let a fork->canon write
  // slip through whenever the ecosystem.json pointer is corrupt or partial.
  // Per security.md (fail CLOSED on ambiguity) + evidence-first-claims.md MUST-3
  // (an unverifiable predicate is not an all-clear), force the disclosure check.
  if (!_pointerIsUsable(upstreamCanon)) {
    return { boundary: "fork->canon", canon: upstreamCanon, ambiguous: true };
  }

  if (_namesCanon(target, upstreamCanon)) {
    return { boundary: "fork->canon", canon: upstreamCanon };
  }
  return { boundary: "intra-ecosystem" };
}

// A usable upstream_canon pointer carries a non-empty string `remote` OR a
// non-empty string `url` — the two fields _namesCanon matches a target against.
// A pointer with neither is malformed/ambiguous and cannot be matched, so a
// fork that has declared a write-target against it fails CLOSED (above).
function _pointerIsUsable(upstreamCanon) {
  if (!upstreamCanon || typeof upstreamCanon !== "object") return false;
  const hasRemote =
    typeof upstreamCanon.remote === "string" && upstreamCanon.remote !== "";
  const hasUrl =
    typeof upstreamCanon.url === "string" && upstreamCanon.url !== "";
  return hasRemote || hasUrl;
}

// Does the declared write-target name the upstream canon? Match on remote
// identity (the upstream_canon pointer's `remote`/`url`) OR a literal "canon"
// sentinel the caller may pass when it knows the target IS canon.
function _namesCanon(target, upstreamCanon) {
  if (target === "canon") return true;
  if (typeof target === "string") {
    if (upstreamCanon.remote && target === upstreamCanon.remote) return true;
    if (upstreamCanon.url && target === upstreamCanon.url) return true;
    return false;
  }
  if (target && typeof target === "object") {
    if (
      upstreamCanon.remote &&
      target.remote &&
      target.remote === upstreamCanon.remote
    ) {
      return true;
    }
    if (upstreamCanon.url && target.url && target.url === upstreamCanon.url) {
      return true;
    }
  }
  return false;
}

// ── public-authority O1 carve-out (artifact-flow.md:200) ───────────────────
// A PUBLIC external-authority O1 artifact (ISO / SOC 2 / GDPR / NIST / PCI-DSS
// / etc.) is ecosystem-NEUTRAL: it carries no fork tenant identity, so it MAY
// cross the boundary. A TENANT-SPECIFIC (non-public) authority O1 artifact is
// ecosystem-PRIVATE and is NOT carved out (it falls through to the disclosure
// check exactly like any other fork-surface write).
//
// The carve-out fires ONLY when the caller asserts BOTH (a) the artifact is an
// O1 compliance artifact AND (b) its cited authority is on the PUBLIC
// allowlist. A bare "it's O1" claim is insufficient (a tenant-authority O1 is
// not neutral); a bare "it's public" claim without the O1 assertion is
// insufficient (only the O1 compliance lane is ecosystem-neutral by authority).
const PUBLIC_AUTHORITY_ALLOWLIST = new Set([
  "iso",
  "iso27001",
  "iso/iec 27001",
  "iso27017",
  "iso27018",
  "soc2",
  "soc 2",
  "gdpr",
  "hipaa",
  "pci-dss",
  "pci dss",
  "nist",
  "nist 800-53",
  "nist csf",
  "fedramp",
  "ccpa",
]);

// A prefix match against an allowlist token is admitted ONLY when the token is
// terminated by a WORD BOUNDARY — end-of-string, whitespace, or a standard
// version/clause delimiter (":" "§" ","). An identifier-continuation char (a
// letter, a digit, "-", "/", or ".") does NOT terminate the token. This closes
// the prefix-collision disclosure leak: an attacker-controlled authority string
// "iso-acme-internal-policy" / "isolated acme data" / "nist-internal" /
// "iso/acme" / "iso.acme" no longer prefix-collides "iso"/"nist" and smuggles
// fork-identifying content past the carve-out. The "/"-containing legit forms
// (e.g. "iso/iec 27001:2022") match the LONGER allowlist token "iso/iec 27001"
// (exact prefix + ":" boundary), so "/" need not — and MUST not — be a boundary.
function _tokenBoundaryOk(norm, allowed) {
  if (norm === allowed) return true;
  if (!norm.startsWith(allowed)) return false;
  const next = norm.charAt(allowed.length);
  return next === "" || /[\s:§,]/.test(next);
}

// Citation-tail vocabulary (#584 R3). After the matched allowlist token, a
// GENUINE public-authority citation carries ONLY version / clause / standard-
// continuation tokens ("§A.8.24", "Rev. 5", "Article 32", "/IEC 27001", "CSF
// 2.0", "Type II", "Moderate") — never arbitrary fork-identifying WORDS. The R2
// word-boundary fix closed the continuation-char class (iso-acme), but the
// authority string AFTER a whitespace/":"/","/"§" boundary was still admitted
// WHOLE and never disclosure-scanned, so "iso 27001 acme-corp-internal" rode
// past the carve-out. This positive allowlist (per cc-artifacts.md Rule 10) is
// the structural close: any ≥3-letter alphabetic run in the tail NOT in this
// set means the authority carries extra text → REFUSE the carve-out → the write
// FALLS to the disclosure scan (fail-closed: no scan possible → UNVERIFIED
// BLOCK). Over-blocking a prose-y authority is the SAFE direction; a
// fork-identifying authority crossing unscrubbed is not.
const CITATION_TAIL_WORDS = new Set([
  "rev",
  "revision",
  "version",
  "ver",
  "article",
  "annex",
  "clause",
  "section",
  "control",
  "controls",
  "requirement",
  "requirements",
  "req",
  "part",
  "principle",
  "criteria",
  "type",
  "trust",
  "services",
  "iec",
  "csf",
  "dss",
  "sp",
  "pub",
  "moderate",
  "high",
  "low",
  "baseline",
  "iso",
  "soc",
  "nist",
  "gdpr",
  "hipaa",
  "sox",
  "ccpa",
  "glba",
  "fisma",
  "pipeda",
  "dora",
  "fedramp",
  "pci",
]);

// Canonical normalization for the authority string + its tail (#584 F584):
// NFKC-fold (so full-width / compatibility forms collapse to ASCII), then
// collapse EVERY run of Unicode whitespace — incl. U+00A0/U+2007/U+2009 and the
// ideographic space — to a single ASCII space, trim, and lowercase. Applied
// uniformly to the whole authority (isPublicAuthorityO1) AND the post-token tail
// (_authorityTailIsCitationOnly) so a smuggled non-ASCII separator cannot slip a
// fork-identifying token past the allowlist / citation-tail checks.
function _normalizeAuthority(s) {
  return s.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

// True iff the authority tail after the matched allowlist token (matchedLen)
// is PURE ASCII citation content. The tail MUST consist SOLELY of ASCII citation
// characters — digits, ASCII letters forming CITATION_TAIL_WORDS, `§`, `.`, `:`,
// `/`, `-`, whitespace, commas, parens. Two checks, both fail-closed:
//   1. Any codepoint outside the ASCII citation-character class (a non-Latin /
//      homoglyph letter, CJK, em-dash, any other non-ASCII byte) → NOT
//      citation-only. A fork-identifying tail expressed entirely in Cyrillic
//      homoglyphs or CJK no longer passes VACUOUSLY (the old ASCII-only
//      `[a-z]{3,}` scan matched nothing there and returned true).
//   2. Any Unicode letter run (\p{L}, length>=3) not in CITATION_TAIL_WORDS →
//      NOT citation-only (the original arbitrary-fork-word guard, now
//      Unicode-aware rather than ASCII-only).
// The tail is normalized identically before checking.
function _authorityTailIsCitationOnly(norm, matchedLen) {
  const tail = _normalizeAuthority(norm.slice(matchedLen));
  // (1) Allowed ASCII citation characters only — § is the sole permitted
  // non-ASCII codepoint (U+00A7, a citation glyph). Anything else → reject.
  if (/[^a-z0-9 .:/\-,()§]/.test(tail)) return false;
  // (2) Every ≥3-char letter run (Unicode-aware) MUST be a known citation word.
  const words = tail.match(/\p{L}{3,}/gu) || [];
  return words.every((w) => CITATION_TAIL_WORDS.has(w));
}

function isPublicAuthorityO1(opts = {}) {
  if (opts.o1 !== true) return false;
  const auth = opts.authority;
  if (typeof auth !== "string" || auth.trim() === "") return false;
  const norm = _normalizeAuthority(auth);
  // Admit ONLY when (1) an allowlist family matches at a WORD BOUNDARY (closes
  // the "iso-acme" continuation-char collision — #584 R2) AND (2) the tail is a
  // clean citation, no arbitrary fork words (closes the "iso 27001 acme-corp"
  // whitespace-boundary authority-string channel — #584 R3).
  for (const allowed of PUBLIC_AUTHORITY_ALLOWLIST) {
    if (
      _tokenBoundaryOk(norm, allowed) &&
      _authorityTailIsCitationOnly(norm, allowed.length)
    ) {
      return true;
    }
  }
  return false;
}

// ── fork-identifying-content predicate ─────────────────────────────────────
// Returns { identifying: true, findings: [...] } when the write surface carries
// fork tenant-identifying content (org slug, customer name, internal paths) —
// the exact disclosure class the bidirectional-isolation invariant blocks. The
// scan is injectable (opts.scanFn) so a test supplies a deterministic finding
// set; the production default would route through the SHIPPED
// scan-synced-disclosure surface (wired when AC-2's intake path lands — see the
// deferred-with-note below). The default here is STRUCTURAL-NULL fail-closed:
// with no scanFn AND no explicit findings, the guard treats the surface as
// UNVERIFIED (threat status UNKNOWN per evidence-first-claims.md MUST-3) and
// returns identifying:true so a fork->canon write never finalizes on an
// unproven-clean surface.
function checkForkIdentifyingContent(opts = {}) {
  if (Object.prototype.hasOwnProperty.call(opts, "findings")) {
    const findings = Array.isArray(opts.findings) ? opts.findings : [];
    return { identifying: findings.length > 0, findings, verified: true };
  }
  if (typeof opts.scanFn === "function") {
    const res = opts.scanFn(opts);
    // A scanFn result is honored as "scan ran" ONLY when it EXPLICITLY returns
    // `ran === true` (#584 F584 fix #3 — closes the `{}`-returns-clean footgun).
    // Any other shape — a missing `ran`, a falsy `ran`, a bare `{}`, a non-object
    // (null/undefined/string) — is treated as UNVERIFIED / not-run and fails
    // CLOSED (evidence-first-claims.md MUST-3: an errored / verdict-less detector
    // is NOT an all-clear). A bare `{}` no longer reads as `ran !== false → clean`.
    const ran = res !== null && typeof res === "object" && res.ran === true;
    if (!ran) {
      return { identifying: true, findings: [], verified: false, ran: false };
    }
    const findings = Array.isArray(res.findings) ? res.findings : [];
    return { identifying: findings.length > 0, findings, verified: true };
  }
  // No injected findings AND no scanFn: UNVERIFIED → fail closed.
  return { identifying: true, findings: [], verified: false, ran: false };
}

// ── the guard orchestrator ─────────────────────────────────────────────────
// guardForkToCanonWrite — the standalone pre-write check (#584 AC-1).
//
// Decision order (security-load-bearing):
//   1. Recognize the boundary. NOT fork->canon → ALLOW (the guard scopes to the
//      ONE boundary it exists for; intra-ecosystem + canon-side writes are
//      governed by the existing fences, untouched).
//   2. fork->canon: public-authority O1 carve-out → ALLOW (ecosystem-neutral,
//      artifact-flow.md:200). This is checked BEFORE the disclosure scan
//      because a public ISO/SOC2/GDPR artifact is neutral BY AUTHORITY and need
//      not be scrubbed.
//   3. fork->canon, NOT public-O1: run the fork-identifying-content check.
//      identifying (or UNVERIFIED) → BLOCK. clean → ALLOW.
//
// THE ENVELOPE-EXPANSION CLOSE (the #584 keystone): step 1+2+3 fire
// REGARDLESS of opts.repoScopeGrant. A repo-scope-discipline.md:30 five-condition
// User-Authorized Exception grant (opts.repoScopeGrant === true) does NOT bypass
// this guard — the grant lifts the GENERAL cross-repo-write prohibition, but the
// canon<->fork disclosure isolation is a DISTINCT invariant the grant was never
// scoped to authorize. A granted fork->canon fork-identifying write is STILL
// BLOCKED.
//
// AC-2 DEFERRED-WITH-NOTE: opts.intakePath (the sync-from-canon INTAKE wiring)
// is NOT consumed here — the sync-from-canon driver (#576) is UNBUILT, so there
// is no intake path to wire onto. When #576 lands, the intake path MUST invoke
// this same guard on the pulled surface (the disclosure-scrubbed-INTAKE-not-
// trusted-merge enforcement named in artifact-flow.md:52). The deferred contract
// is pinned by a strict-xfail test.
async function guardForkToCanonWrite(opts = {}) {
  const boundary = await recognizeBoundary(opts);
  if (boundary.boundary !== "fork->canon") {
    return {
      ok: true,
      decision: "allow",
      reason: "not-fork-to-canon",
      boundary: boundary.boundary,
    };
  }

  // fork->canon boundary crossing. The repo-scope grant does NOT short-circuit.
  if (isPublicAuthorityO1(opts)) {
    // Defense-in-depth (#584 R2): a public-authority O1 artifact is
    // ecosystem-neutral BY AUTHORITY, but the carve-out MUST NOT smuggle
    // fork-identifying content. If the caller supplies a fork-identifying scan
    // (explicit `findings` or a `scanFn`) AND it flags content, do NOT carve
    // out — fall through to BLOCK. When no scan is possible (authority asserted,
    // no findings), the carve-out stands: a public ISO/SOC2/GDPR artifact is
    // neutral and need not be scrubbed (artifact-flow.md § O1 carve-out).
    const scanPossible =
      Object.prototype.hasOwnProperty.call(opts, "findings") ||
      typeof opts.scanFn === "function";
    if (!scanPossible || !checkForkIdentifyingContent(opts).identifying) {
      return {
        ok: true,
        decision: "allow",
        reason: "public-authority-o1",
        boundary: "fork->canon",
        authority: opts.authority,
      };
    }
    // public-O1 authority BUT the supplied scan flags fork-identifying
    // content → fall through to the disclosure BLOCK below.
  }

  const disclosure = checkForkIdentifyingContent(opts);
  if (disclosure.identifying) {
    const why = disclosure.verified
      ? `fork->canon write carries fork-IDENTIFYING content (${disclosure.findings.length} finding(s)): ${disclosure.findings
          .slice(0, 5)
          .join("; ")}`
      : "fork->canon write surface is UNVERIFIED — the fork-identifying-content scan produced no clean verdict; threat status UNKNOWN (evidence-first-claims.md MUST-3). The disclosure-isolation invariant fails CLOSED.";
    return {
      ok: false,
      decision: "block",
      reason: disclosure.verified
        ? "fork-identifying-content"
        : "disclosure-unverified",
      boundary: "fork->canon",
      findings: disclosure.findings,
      // The envelope-expansion close, surfaced for the audit trail: name that
      // the grant was present-but-not-honored, so a reader sees the guard is
      // canon<->fork-aware (the #584 fix), not a re-statement of the general
      // cross-repo fence.
      grant_present_but_not_honored: opts.repoScopeGrant === true,
      error:
        "BLOCKED: canon<->fork disclosure isolation (artifact-flow.md:52 bidirectional-isolation invariant). " +
        why +
        " A client ecosystem fork MUST NOT push its tenant identity or work back to canon (artifact-flow.md fork->canon MUST NOT). " +
        (opts.repoScopeGrant === true
          ? "A repo-scope-discipline.md:30 User-Authorized Exception grant does NOT bypass this guard — the grant lifts the general cross-repo-write prohibition, NOT the distinct canon<->fork disclosure-isolation invariant. "
          : "") +
        "Genericize + relocate the fork-identifying content (or, for a public ISO/SOC2/GDPR O1 artifact, assert {o1:true, authority:<public-standard>}) before this write can proceed.",
    };
  }

  return {
    ok: true,
    decision: "allow",
    reason: "fork-to-canon-clean",
    boundary: "fork->canon",
  };
}

module.exports = {
  recognizeBoundary,
  isPublicAuthorityO1,
  checkForkIdentifyingContent,
  guardForkToCanonWrite,
  PUBLIC_AUTHORITY_ALLOWLIST,
  _loadEcoConfig,
};
