"use strict";
/*
 * state-file-write-guard.js — parameterized verdict tier classifier.
 *
 * Loom-canonical implementation of the deploy-state-file write-guard
 * pattern documented in rules/state-file-write-guard.md. Pure logic,
 * CLI-agnostic, parameterized for project-specific surface (state-file
 * shape, smoke-report paths, override env-var name, contract-scan
 * verdict shape). Composes with hooks/lib/violation-patterns.js
 * (three-layer Bash mutation detection — already shipped) for the
 * Bash-side coverage.
 *
 * Project consumers wire a thin PreToolUse hook on top of this lib +
 * a project-supplied validator binary that performs the contract scan
 * and emits the inputs this lib classifies.
 *
 * API surface (all pure functions):
 *
 *   tierClassify(input)         → { tier, diagnostic }
 *   emitContentDigest(input)    → hex string   (INTEGRITY only — see below)
 *   verifyContentDigest(input)  → boolean      (INTEGRITY only — see below)
 *   emitSignature(input)        → DEPRECATED alias of emitContentDigest
 *   verifySignature(input)      → DEPRECATED alias of verifyContentDigest
 *   checkOverride(envVar)       → boolean
 *   validateHonestYellow(...)   → { valid, reason }
 *
 * The lib itself never reads files, never invokes subprocesses, never
 * checks env (other than the named override var). Consumer hooks pass
 * file contents + contract-scan verdicts in; lib classifies.
 *
 * ── WHICH PROPERTY EACH SURFACE PROVIDES (zero-tolerance.md Rule 3e) ──
 *
 * `emitContentDigest` / `verifyContentDigest` provide **INTEGRITY ONLY**.
 * They compute and constant-time-compare a keyless sha256 over
 * (state-file-with-BOTH-attestation-fields-removed || smoke-report ||
 * interactions-report) — see composeSignedBytes for the canonical body.
 * They prove the bytes were not ACCIDENTALLY corrupted and that the three
 * artifacts are mutually consistent.
 *
 * They do **NOT** provide AUTHENTICITY. There is no key, no signer, and no
 * secret in the computation, so ANY actor who can write the state file can
 * also compute a matching digest. A digest match is therefore NOT evidence
 * that the wrapper ran, and NOT evidence of who produced the file. Under
 * the bounded-trust threat model (`multi-operator-coordination.md` §1 — the
 * adversary is a legitimate team member with repo write access), a keyless
 * digest is not a control against the adversary the model names.
 *
 * AUTHENTICITY is provided ONLY by the injected trust-root verifier
 * (`input.trustRoot`, see tierClassify): a DETACHED SIGNATURE over the
 * state-file bytes, verified against a public key and BOUND to a signer
 * fingerprint the consumer resolved from the roster/anchor — never from
 * the file under verification. T1 (verified GREEN) requires that
 * signature; the digest is retained only as a cheap pre-filter.
 *
 * Historical note: before loom#1427 the digest functions were named
 * `emitSignature` / `verifySignature` and the T1 gate accepted a digest
 * match as the trust root. That made a GREEN claim only as trustworthy as
 * write-access to the file it attested. The old names are retained as
 * deprecated aliases (zero-tolerance.md Rule 6a) but they no longer
 * satisfy the T1 gate on their own.
 */

const crypto = require("crypto");

// State-file length cap. JSON.parse is synchronous and blocks the hook
// event loop; an unbounded state-file lets a malicious or buggy producer
// drive the hook past its CC timeout (~5s default per cc-artifacts.md
// Rule 7), at which point the hook returns {continue: true} — fail-OPEN
// for state-file writes. 1 MiB is well above any realistic deploy state
// file (typical: < 10 KiB) while bounded enough to parse in single-digit
// milliseconds. Caller may pass `maxBytes` in input to override.
const DEFAULT_MAX_STATE_FILE_BYTES = 1 * 1024 * 1024;

// Reserved field names that must never be accepted as signatureField.
// JSON.parse does not produce real `__proto__` keys on parsed objects,
// but a malicious state-file containing literal `__proto__` (as a
// string-keyed property) survives JSON.parse + JSON.stringify and would
// pass through the signature-stripping path undetected if the consumer
// passes signatureField="__proto__". `constructor` / `prototype` are
// blocked symmetrically — none of these are valid public field names
// for a verdict signature anyway.
const RESERVED_FIELD_NAMES = Object.freeze([
  "__proto__",
  "constructor",
  "prototype",
]);
const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateFieldName(name, label) {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError(`${label} is required`);
  }
  if (!FIELD_NAME_PATTERN.test(name)) {
    throw new TypeError(
      `${label} must match /^[A-Za-z_][A-Za-z0-9_]*$/ (got: ${JSON.stringify(name)})`,
    );
  }
  if (RESERVED_FIELD_NAMES.includes(name)) {
    throw new TypeError(`${label} must not be a reserved name (${name})`);
  }
}

// Resolve the effective maxBytes from an input config, falling back to
// the default. Negative / zero / non-number values fall through to the
// default — caller cannot accidentally disable the cap by passing a
// falsy value.
function resolveMaxBytes(input) {
  return typeof input.maxBytes === "number" && input.maxBytes > 0
    ? input.maxBytes
    : DEFAULT_MAX_STATE_FILE_BYTES;
}

/**
 * Tier matrix per rules/state-file-write-guard.md MUST Rule 2:
 *
 *   T1 — Verified GREEN     signature valid + contract scan passes + zero prohibited stubs
 *   T2 — Honest YELLOW      verification_status YELLOW + every gap enumerated
 *   T3 — Unsupported claim  GREEN BUT signature missing/invalid OR contract scan fails
 *   T4 — Hook bypass        Edit/Write against structural defense, contract docs,
 *                           trust root, OR Bash mutation of any (caller's responsibility
 *                           — pass shouldT4Block=true to short-circuit the classifier)
 */
const TIER = Object.freeze({
  T1: "T1",
  T2: "T2",
  T3: "T3",
  T4: "T4",
  OVERRIDE: "OVERRIDE",
});

/**
 * tierClassify — primary verdict function. Pure: same input → same tier.
 *
 * @param {object} input
 * @param {string} input.envVarName              Override env-var name (e.g. "MYPROJ_HOOK_OVERRIDE_STATE_GUARD"). Required.
 * @param {boolean} [input.shouldT4Block=false]  Caller-determined T4 short-circuit (hook-self / contract-doc / trust-root edit detected by path match upstream).
 * @param {string|null} input.stateFileContent   Proposed state-file content (JSON string). Null on Bash mutation paths.
 * @param {string|null} input.smokeReportContent Smoke report content used for signature input. Null when not yet produced.
 * @param {string|null} input.interactionsReportContent Interactions report content used for signature input. Null when not yet produced.
 * @param {string} input.verificationStatusField Field name in the state-file JSON that holds GREEN/YELLOW/RED (e.g. "verification_status"). Required.
 * @param {string} input.signatureField          Field name holding the validator signature (e.g. "_validator_signature"). Required.
 * @param {string} input.gapListField            Field name holding the gap enumeration for YELLOW (e.g. "smoke_step_d_actions"). Required.
 * @param {object} [input.contractScanResult]    Consumer-supplied verdict. Shape: {passed: bool, prohibitedStubsFound: string[], gaps: string[]}. Required for T1/T3 disambiguation.
 * @param {string} [input.contentDigestField]    OPTIONAL field name holding the keyless integrity digest used as a cheap pre-filter (e.g. "_content_digest"). INTEGRITY ONLY — never authenticity. Omit to skip the pre-filter; T1 still requires the trust-root signature either way.
 * @param {object} input.trustRoot               REQUIRED for a GREEN claim (fail-closed). The authenticity decision.
 * @param {string} input.trustRoot.expectedFingerprint  Signer fingerprint the consumer resolved from the ROSTER/ANCHOR. MUST NOT be read from the state file under verification — a self-declared pin is refused (see findSelfDeclaredFingerprint).
 * @param {string} input.trustRoot.publicKey     Key material the pinned fingerprint identifies (armored GPG block, or single-line SSH key).
 * @param {function} input.trustRoot.verifyDetachedSignature  (content, sig, publicKey, {expectedFpr}) => {ok: boolean, valid: boolean, reason?: string}. Injected because this lib is pure and cannot invoke gpg/ssh-keygen. Wire it to hooks/lib/coc-sign.js::verify, which implements exactly this shape and honours expectedFpr on the GPG path.
 * @returns {{tier: string, diagnostic: string}}
 *
 * T1 requires ALL of: verification_status GREEN, both reports present, a
 * valid DETACHED SIGNATURE over the state-file bytes bound to the pinned
 * signer, and a passing contract scan. A content-digest match alone can
 * NEVER reach T1 (loom#1427) — it is integrity evidence, not authenticity.
 */
function tierClassify(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("tierClassify: input must be an object");
  }
  const {
    envVarName,
    shouldT4Block = false,
    stateFileContent,
    smokeReportContent,
    interactionsReportContent,
    verificationStatusField,
    signatureField,
    gapListField,
    contractScanResult,
    contentDigestField,
  } = input;

  // Required-field validation. Per MUST Rule 6 of state-file-write-guard.md
  // — override is checked FIRST, BEFORE any T4/T3/signature/contract check.
  // Required-field validation comes EVEN earlier so the override fast-path
  // still receives a structurally-valid input.
  if (typeof envVarName !== "string" || envVarName.length === 0) {
    throw new TypeError("tierClassify: envVarName is required");
  }
  validateFieldName(
    verificationStatusField,
    "tierClassify: verificationStatusField",
  );
  validateFieldName(signatureField, "tierClassify: signatureField");
  validateFieldName(gapListField, "tierClassify: gapListField");

  // Override check FIRST per MUST Rule 6. Covers every protected category
  // (T4 / T3 / signature / contract-doc) with a single env-var.
  if (checkOverride(envVarName)) {
    return {
      tier: TIER.OVERRIDE,
      diagnostic: `Override env-var ${envVarName}=1 active; classifier bypassed for atomic-update commit. MUST be paired with same-session commit covering all artifacts in lockstep per rule MUST Rule 7.`,
    };
  }

  // T4 — Hook bypass attempt. Caller computed this by matching the
  // proposed write against the consumer's protected-paths config.
  if (shouldT4Block) {
    return {
      tier: TIER.T4,
      diagnostic:
        "T4 BLOCK: write targets a protected category (hook-self / contract-doc / trust-root). Use the documented override env-var for atomic updates per rule MUST Rule 7.",
    };
  }

  // No state-file content → not a state-file write path; classifier
  // does not apply. Caller should route this through the Bash-mutation
  // helper (violation-patterns.js::detectStateFileMutation) instead.
  if (stateFileContent == null) {
    throw new TypeError(
      "tierClassify: stateFileContent is null/undefined — non-state-file paths route through detectStateFileMutation, not this classifier",
    );
  }

  // Bound the parse cost. JSON.parse blocks the hook event loop; an
  // unbounded state-file lets a malicious producer drive the hook past
  // its CC timeout (fail-OPEN). Caller may override via input.maxBytes.
  const maxBytes = resolveMaxBytes(input);
  if (Buffer.byteLength(stateFileContent, "utf8") > maxBytes) {
    return {
      tier: TIER.T3,
      diagnostic: `T3 BLOCK: state-file content exceeds maxBytes (${maxBytes}). Re-run the wrapper, or pass a higher maxBytes if the project genuinely produces larger state files.`,
    };
  }

  // Parse state-file content. Malformed JSON → T3 (unsupported claim
  // — agent shouldn't be writing JSON the validator can't read).
  let stateFile;
  try {
    stateFile = JSON.parse(stateFileContent);
  } catch (e) {
    return {
      tier: TIER.T3,
      diagnostic: `T3 BLOCK: state-file content is not valid JSON (${e.message}). Re-run the wrapper to produce a signed file.`,
    };
  }

  // JSON.parse("null") SUCCEEDS and yields null, so the read below would throw
  // an uncaught TypeError out of the classifier (loom#1428 LOW-2). Every other
  // non-object top level ("[1,2]", "123", "false") yields undefined and lands
  // on T3 correctly; only null crashes. A null state file is not a GREEN claim.
  if (!stateFile || typeof stateFile !== "object") {
    return {
      tier: TIER.T3,
      diagnostic:
        "T3 BLOCK: state-file content parsed to a non-object (null / array-of-scalars / primitive). Re-run the wrapper to produce a state-file object.",
    };
  }

  const verificationStatus = stateFile[verificationStatusField];

  // T2 — Honest YELLOW. verification_status is YELLOW AND every contract
  // gap is enumerated in the gap-list field.
  if (verificationStatus === "YELLOW") {
    const v = validateHonestYellow({
      stateFile,
      gapListField,
      contractScanResult,
    });
    if (v.valid) {
      return {
        tier: TIER.T2,
        diagnostic:
          "T2 ALLOW: honest YELLOW with enumerated gaps. Contract gaps recorded; next /redteam or /implement should address them.",
      };
    }
    return {
      tier: TIER.T3,
      diagnostic: `T3 BLOCK: claimed YELLOW but ${v.reason}. Either re-enumerate every contract gap (rule MUST Rule 3) or re-run the wrapper to produce a verified GREEN.`,
    };
  }

  // T1 vs T3 — depends on signature validity AND contract-scan verdict.
  if (verificationStatus !== "GREEN") {
    return {
      tier: TIER.T3,
      diagnostic: `T3 BLOCK: ${verificationStatusField}='${verificationStatus}' is neither GREEN nor YELLOW. Re-run the wrapper.`,
    };
  }

  if (smokeReportContent == null || interactionsReportContent == null) {
    return {
      tier: TIER.T3,
      diagnostic:
        "T3 BLOCK: GREEN claim missing smoke report OR interactions report content (signature input incomplete). Re-run the wrapper.",
    };
  }

  const claimedSignature = stateFile[signatureField];
  if (typeof claimedSignature !== "string" || claimedSignature.length === 0) {
    return {
      tier: TIER.T3,
      diagnostic: `T3 BLOCK: GREEN claim missing ${signatureField}. Re-run the wrapper to produce a signed file.`,
    };
  }

  // Cheap INTEGRITY pre-filter (optional). A digest match proves the three
  // artifacts are mutually consistent; it proves NOTHING about who produced
  // them (see the module header). It is never sufficient for T1 — it only
  // short-circuits an obviously-inconsistent file before the (more
  // expensive) signature verification runs.
  if (typeof contentDigestField === "string" && contentDigestField.length > 0) {
    validateFieldName(contentDigestField, "tierClassify: contentDigestField");
    const claimedDigest = stateFile[contentDigestField];
    if (typeof claimedDigest !== "string" || claimedDigest.length === 0) {
      return {
        tier: TIER.T3,
        diagnostic: `T3 BLOCK: GREEN claim declares ${contentDigestField} as its integrity pre-filter but the field is missing or empty. Re-run the wrapper.`,
      };
    }
    // Verify over the body stripped of BOTH the signature and digest fields
    // (loom#1428 HIGH-2). Passing the raw stateFileContent here would leave the
    // SIGNATURE inside the digested body while the signature path strips it —
    // the mutual-recursion fixed point documented on stripFields.
    let digestBody;
    try {
      digestBody = stripFields(stateFileContent, [
        signatureField,
        contentDigestField,
      ]);
    } catch (e) {
      return {
        tier: TIER.T3,
        diagnostic: `T3 BLOCK: cannot canonicalize state file for digest verification (${e.message}).`,
      };
    }
    const digestOk = verifyContentDigest({
      stateFileContent: digestBody,
      smokeReportContent,
      interactionsReportContent,
      signatureField: contentDigestField,
      claimedSignature: claimedDigest,
      maxBytes: resolveMaxBytes(input),
    });
    if (!digestOk) {
      return {
        tier: TIER.T3,
        // NOTE: deliberately does NOT say "trust root forged" — a digest
        // mismatch is an INTEGRITY failure the digest CAN detect; it cannot
        // detect forgery, because a forger recomputes the digest freely.
        diagnostic: `T3 BLOCK: ${contentDigestField} does not match sha256(state-file-with-BOTH-attestation-fields-removed || smoke-report || interactions-report). The state file and its reports are inconsistent (wrapper not run, or an artifact changed after signing). This is an INTEGRITY check only — it cannot detect forgery; authenticity is decided by the trust-root signature check.`,
      };
    }
  }

  // ── TRUST ROOT: detached signature bound to a pinned signer ──
  // Fail CLOSED. An unwired trust root means the GREEN claim carries no
  // authenticity evidence at all, which is exactly the loom#1427 defect.
  const tr = input.trustRoot;
  if (!tr || typeof tr !== "object") {
    return {
      tier: TIER.T3,
      diagnostic:
        "T3 BLOCK: GREEN claim has no trust root. tierClassify requires input.trustRoot = {expectedFingerprint, publicKey, verifyDetachedSignature} so the claim can be bound to a SIGNER. A content digest alone proves integrity, never authenticity — any actor who can write the state file can recompute it. Wire the verifier (e.g. hooks/lib/coc-sign.js::verify with {expectedFpr}) and resolve expectedFingerprint from the roster/anchor.",
    };
  }
  const { expectedFingerprint, publicKey, verifyDetachedSignature } = tr;
  if (
    typeof expectedFingerprint !== "string" ||
    expectedFingerprint.length === 0
  ) {
    return {
      tier: TIER.T3,
      diagnostic:
        "T3 BLOCK: trustRoot.expectedFingerprint is required and MUST be resolved from the roster/anchor (never from the state file under verification).",
    };
  }
  if (typeof publicKey !== "string" || publicKey.length === 0) {
    return {
      tier: TIER.T3,
      diagnostic:
        "T3 BLOCK: trustRoot.publicKey is required (the key material the pinned fingerprint identifies).",
    };
  }
  if (typeof verifyDetachedSignature !== "function") {
    return {
      tier: TIER.T3,
      diagnostic:
        "T3 BLOCK: trustRoot.verifyDetachedSignature must be a function (content, sig, publicKey, {expectedFpr}) => {ok, valid}. The lib is pure and cannot invoke gpg/ssh-keygen itself.",
    };
  }

  // AC2 — a SELF-DECLARED fingerprint is the same defect one level up: if
  // the expected fingerprint can be read off the very file being verified,
  // an attacker who rewrites the file also rewrites the expectation. Refuse
  // when any value in the state file equals the pinned fingerprint.
  // Guarded to match its neighbours (loom#1428 LOW-1): this recursive walk over
  // attacker-controlled JSON was the ONLY unguarded traversal on the GREEN path,
  // and it has no depth bound. A deeply-nested-but-under-cap file could throw a
  // RangeError out of the classifier; an uncaught throw in a hook degrades to
  // fail-OPEN at the harness. Fail closed instead.
  let selfDeclared;
  try {
    selfDeclared = findSelfDeclaredFingerprint(stateFile, expectedFingerprint);
  } catch (e) {
    return {
      tier: TIER.T3,
      diagnostic: `T3 BLOCK: could not scan the state file for a self-declared fingerprint (${e && e.message ? e.message : String(e)}). An incomplete scan is ZERO evidence the pin is roster-sourced.`,
    };
  }
  if (selfDeclared) {
    return {
      tier: TIER.T3,
      diagnostic: `T3 BLOCK: trustRoot.expectedFingerprint also appears inside the state file (at '${selfDeclared}'). A self-declared fingerprint is not a pin — an actor rewriting the file rewrites the expectation with it. Resolve the fingerprint from the roster/anchor instead.`,
    };
  }

  // The signed bytes cover ALL THREE artifacts — canonical-body (the state file
  // with BOTH attestation fields removed) || smoke-report || interactions-report
  // — the SAME body the digest hashes, so the signature inherits the digest's
  // binding scope AND adds a signer.
  //
  // Signing the state file ALONE would be a binding-scope REGRESSION against
  // the digest it replaces: an attacker holding a state file legitimately
  // signed for some EARLIER deploy could pair it with attacker-chosen smoke
  // and interactions reports and reach T1, because nothing would bind the
  // reports to the signature. The reports are the wrapper's evidence that it
  // actually ran; a trust root that does not cover them attests a claim
  // detached from the evidence for it.
  //
  // Length-prefixing each segment keeps the concatenation unambiguous — a
  // bare join lets an attacker shift bytes across the boundary (move a
  // suffix of the state file into the smoke report) and produce a different
  // triple with identical signed bytes.
  let signedBytes;
  try {
    signedBytes = composeSignedBytes({
      stateFileContent,
      smokeReportContent,
      interactionsReportContent,
      signatureField,
      contentDigestField,
    });
  } catch (e) {
    return {
      tier: TIER.T3,
      diagnostic: `T3 BLOCK: cannot canonicalize state file for signature verification (${e.message}).`,
    };
  }

  let verdict;
  try {
    verdict = verifyDetachedSignature(signedBytes, claimedSignature, publicKey, {
      expectedFpr: expectedFingerprint,
    });
  } catch (e) {
    // A THROWING verifier is zero evidence, never a pass.
    return {
      tier: TIER.T3,
      diagnostic: `T3 BLOCK: trust-root verifier threw (${e && e.message ? e.message : String(e)}). A verifier that did not complete is ZERO evidence of authenticity, never a pass.`,
    };
  }
  if (!verdict || typeof verdict !== "object") {
    return {
      tier: TIER.T3,
      diagnostic:
        "T3 BLOCK: trust-root verifier returned a non-object. Expected {ok, valid, reason?}.",
    };
  }
  if (verdict.ok !== true || verdict.valid !== true) {
    const reason = verdict.reason ? ` (${verdict.reason})` : "";
    return {
      tier: TIER.T3,
      diagnostic: `T3 BLOCK: ${signatureField} is not a valid detached signature over the state-file bytes for the pinned signer ${expectedFingerprint}${reason}. Trust root forged, signed by a DIFFERENT enrolled key, or wrapper not run.`,
    };
  }

  if (!contractScanResult || typeof contractScanResult !== "object") {
    return {
      tier: TIER.T3,
      diagnostic:
        "T3 BLOCK: contractScanResult is required for GREEN claims. Caller must invoke the consumer-supplied validator and pass its verdict.",
    };
  }

  // Strict identity, matching every other trust-root comparison in this module
  // (loom#1428 MED-3). Truthiness here let a shell-produced validator emitting
  // {"passed": "false"} — a truthy STRING — reach T1 with a FAILING scan.
  // A SHAPE error is not a scan failure. Reporting it as one sends the operator
  // to two dead ends (loom#1428 MEDIUM-1): "fix the contract gaps" is a no-op
  // when there are none, and "claim YELLOW with enumerated gaps" is refused by
  // validateHonestYellow for an EMPTY gap list. Both documented exits closed,
  // leaving only the override env var — a total, unlogged bypass. Name the real
  // cause instead.
  if (typeof contractScanResult.passed !== "boolean") {
    return {
      tier: TIER.T3,
      diagnostic: `T3 BLOCK: contractScanResult.passed must be a BOOLEAN, got ${typeof contractScanResult.passed} (${JSON.stringify(contractScanResult.passed)}). This is a validator WIRING error, not a contract failure — a shell-produced validator emitting {"passed": "$RESULT"} ships a JSON string. Emit a real boolean; do NOT reach for the override env-var.`,
    };
  }

  if (contractScanResult.passed !== true) {
    const stubs = (contractScanResult.prohibitedStubsFound || []).slice(0, 3);
    const gaps = (contractScanResult.gaps || []).slice(0, 3);
    return {
      tier: TIER.T3,
      diagnostic: `T3 BLOCK: GREEN claim but contract scan failed. Prohibited stubs: ${
        stubs.length ? stubs.join("; ") : "(none)"
      }. Gaps: ${gaps.length ? gaps.join("; ") : "(none)"}. Either fix the contract gaps and re-run, or claim YELLOW with enumerated gaps per rule MUST Rule 3.`,
    };
  }

  // T1 — all checks pass.
  return {
    tier: TIER.T1,
    diagnostic:
      "T1 ALLOW: signature valid, contract scan passes, no prohibited stubs.",
  };
}

/**
 * stripField — canonicalize the state-file JSON with one field removed.
 *
 * Shared by the digest path and the signature path so BOTH sign/verify the
 * SAME bytes. `fieldName` is allowlist-restricted by validateFieldName at
 * every caller, so `delete parsed[fieldName]` cannot reach __proto__ /
 * constructor / prototype.
 *
 * @param {string} stateFileContent
 * @param {string} fieldName
 * @returns {string} canonical JSON with fieldName removed
 */
function stripField(stateFileContent, fieldName) {
  return stripFields(stateFileContent, [fieldName]);
}

/**
 * stripFields — canonicalize the state-file JSON with SEVERAL fields removed.
 *
 * Both the digest and the signature MUST be computed over a body from which
 * BOTH the digest field and the signature field have been removed. Stripping
 * only one is a mutual-recursion trap (loom#1428 HIGH-2):
 *
 *   digest    = H(  body ∪ {signature} ‖ smoke ‖ interactions )
 *   signature = Sign( body ∪ {digest}  ‖ smoke ‖ interactions )
 *
 * Each input then requires the other to already be final, so NO production
 * order satisfies both — a hash/signature fixed point. It fails CLOSED (T3),
 * so it is not a bypass; the harm is that the belt-and-braces configuration a
 * careful consumer picks is the one that can never issue T1, pushing them
 * toward dropping the pre-filter or setting the override (a total bypass).
 *
 * Stripping both makes the two computations INDEPENDENT of each other.
 *
 * Callers MUST validate field names via validateFieldName before calling —
 * every in-module caller does, so `delete` cannot reach __proto__ / constructor /
 * prototype on any internal path. The function is EXPORTED, so it cannot enforce
 * that itself; in practice `delete` on a non-own property is a no-op and
 * JSON.parse never invokes the __proto__ setter.
 *
 * @param {string} stateFileContent
 * @param {string[]} fieldNames  falsy entries are ignored (digest field is optional)
 * @returns {string} canonical JSON with every named field removed
 */
function stripFields(stateFileContent, fieldNames) {
  // A STRING is iterable, so `for (const name of fieldNames)` would walk its
  // CHARACTERS — silently leaving the named field in place AND deleting every
  // single-character key whose name appears in the string (loom#1428 LOW-1).
  // `stripFields(s, "_content_digest")` keeps `_content_digest` and deletes a
  // key named `c`. That is body CORRUPTION, not a no-op: the wrapper then signs
  // the wrong bytes and its honest file lands at T3 with no diagnostic pointing
  // back at the call. This helper is EXPORTED and sits one character from
  // `stripField(content, name)`, which takes a bare string — so reaching for
  // the plural by muscle memory is the expected mistake. Make it LOUD.
  if (!Array.isArray(fieldNames)) {
    throw new TypeError(
      `stripFields: fieldNames must be an ARRAY of field names, got ${typeof fieldNames}` +
        (typeof fieldNames === "string"
          ? ` (${JSON.stringify(fieldNames)}) — did you mean stripField() (singular), or [${JSON.stringify(fieldNames)}]?`
          : ""),
    );
  }
  const parsed = JSON.parse(stateFileContent);
  for (const name of fieldNames) {
    if (typeof name === "string" && name.length > 0) delete parsed[name];
  }
  return JSON.stringify(parsed);
}

/**
 * composeSignedBytes — THE canonical signed-bytes composition. Producers and
 * the verifier MUST both go through this; it is exported for exactly that
 * reason (loom#1428 MEDIUM-3).
 *
 * Returns the length-prefixed concatenation of
 *   state-file-WITHOUT-signature-and-digest || smoke-report || interactions-report
 *
 * Two properties are load-bearing and neither is obvious enough to
 * re-implement safely:
 *
 * 1. BOTH attestation fields are stripped, not just the signature. Stripping
 *    only one makes the digest and signature mutually recursive (see
 *    stripFields) and T1 becomes unreachable for an honest file.
 * 2. Each segment is LENGTH-PREFIXED. The decimal prefix contains no ':', so
 *    the first ':' is unambiguously the first delimiter, and byte-length over
 *    prefixes is strictly increasing — so the encoding is injective and a byte
 *    shifted across a segment boundary cannot yield the same signed bytes. A
 *    bare join is NOT injective.
 *
 * Before this was exported, the only other implementation lived in the test
 * suite, under a comment naming the hazard ("kept in ONE place so a test never
 * signs a different composition than the lib verifies") — and that one place
 * was the TEST, not the library. A wrapper author had to hand-reimplement it
 * from prose. That is the drift this export removes.
 *
 * @param {object} input — same field names tierClassify takes
 * @returns {string} the exact bytes to sign / verify
 */
function composeSignedBytes(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("composeSignedBytes: input must be an object");
  }
  const {
    stateFileContent,
    smokeReportContent,
    interactionsReportContent,
    signatureField,
    contentDigestField,
  } = input;
  validateFieldName(signatureField, "composeSignedBytes: signatureField");
  for (const [k, v] of [
    ["stateFileContent", stateFileContent],
    ["smokeReportContent", smokeReportContent],
    ["interactionsReportContent", interactionsReportContent],
  ]) {
    if (typeof v !== "string") {
      throw new TypeError(`composeSignedBytes: ${k} must be a string`);
    }
  }
  const body = stripFields(stateFileContent, [
    signatureField,
    contentDigestField,
  ]);
  return [body, smokeReportContent, interactionsReportContent]
    .map((seg) => `${Buffer.byteLength(seg, "utf8")}:${seg}`)
    .join("");
}

/**
 * findSelfDeclaredFingerprint — walk the parsed state file and report the
 * path of any value equal to the pinned fingerprint.
 *
 * Enforces loom#1427 AC2: the expected fingerprint MUST come from the
 * roster/anchor, never from the file under verification. If the pin is also
 * present inside the file, an actor rewriting the file rewrites the
 * expectation with it, which is the original defect one level up.
 *
 * Comparison is case-insensitive with whitespace removed, matching the
 * fingerprint normalization coc-sign.js::_verifyGpg applies.
 *
 * @param {*} node        parsed state-file value (walked recursively)
 * @param {string} fingerprint
 * @param {string} [breadcrumb]
 * @returns {string|null} dotted path of the offending value, or null
 */
function findSelfDeclaredFingerprint(node, fingerprint, breadcrumb) {
  const want = String(fingerprint).toUpperCase().replace(/\s+/g, "");
  const trail = breadcrumb || "$";
  if (typeof node === "string") {
    return String(node).toUpperCase().replace(/\s+/g, "") === want
      ? trail
      : null;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const hit = findSelfDeclaredFingerprint(
        node[i],
        fingerprint,
        `${trail}[${i}]`,
      );
      if (hit) return hit;
    }
    return null;
  }
  if (node && typeof node === "object") {
    for (const k of Object.keys(node)) {
      const hit = findSelfDeclaredFingerprint(
        node[k],
        fingerprint,
        `${trail}.${k}`,
      );
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * emitContentDigest — sha256(body || smoke-report || interactions-report),
 * where `body` is the state-file JSON with the caller's named field stripped.
 *
 * PROVIDES INTEGRITY ONLY, NEVER AUTHENTICITY (zero-tolerance.md Rule 3e).
 * The computation is keyless: no key, no signer, no secret. It proves the
 * three artifacts are mutually consistent and were not accidentally
 * corrupted. It does NOT prove who produced them — any actor able to write
 * the state file can recompute a matching digest. Authenticity is decided
 * solely by tierClassify's injected trust-root signature check.
 *
 * WHICH BODY TO PASS. This is a LOW-LEVEL primitive: it strips exactly the
 * ONE field you name. tierClassify does NOT call it with the raw state file —
 * it pre-strips BOTH attestation fields first, so the digest and the signature
 * cover the SAME canonical body and are independent of each other (loom#1428
 * HIGH-2). A wrapper computing the digest itself MUST do the same: derive the
 * canonical body once (see composeSignedBytes, which is the exported single
 * implementation), then digest and sign over it. Passing the raw state file
 * here re-creates the mutual recursion and the file will never reach T1.
 *
 * Order is fixed: body || smoke || interactions. Note this is a bare
 * concatenation, NOT the length-prefixed framing composeSignedBytes uses for
 * the SIGNATURE — the digest is keyless, so boundary ambiguity confers no
 * forgery advantage (tracked in loom#1434).
 *
 * @param {object} input
 * @param {string} input.stateFileContent
 * @param {string} input.smokeReportContent
 * @param {string} input.interactionsReportContent
 * @param {string} input.signatureField
 * @returns {string} hex sha256
 */
function emitContentDigest(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("emitContentDigest: input must be an object");
  }
  const {
    stateFileContent,
    smokeReportContent,
    interactionsReportContent,
    signatureField,
  } = input;
  for (const [k, v] of [
    ["stateFileContent", stateFileContent],
    ["smokeReportContent", smokeReportContent],
    ["interactionsReportContent", interactionsReportContent],
  ]) {
    if (typeof v !== "string" || v.length === 0) {
      throw new TypeError(`emitContentDigest: ${k} must be a non-empty string`);
    }
  }
  validateFieldName(signatureField, "emitContentDigest: signatureField");

  // Bound the parse cost on the SIGN path too. The wrapper isn't subject
  // to CC's hook timeout (no fail-OPEN here), but unbounded JSON.parse
  // on a 100MB state-file still blocks the wrapper synchronously and
  // wastes resources. Same DoS class as tierClassify's check; same
  // resolveMaxBytes helper. Closes the round-3 redteam carryover where
  // the BLOCK path was bounded but the SIGN path was not.
  const maxBytes = resolveMaxBytes(input);
  if (Buffer.byteLength(stateFileContent, "utf8") > maxBytes) {
    throw new RangeError(
      `emitContentDigest: stateFileContent exceeds maxBytes (${maxBytes})`,
    );
  }

  // Strip the signature field from the state-file JSON. Determinism
  // depends on stable key ordering — Node JSON.stringify uses insertion
  // order, which mirrors the input file's key order when the producer
  // is deterministic (e.g. python json.dumps(sort_keys=True) or jq -S).
  // signatureField is allowlist-restricted (validateFieldName above) so
  // `delete parsed[signatureField]` cannot reach __proto__ / constructor
  // / prototype — closes the prototype-pollution surface MED-S1.
  let stateFileWithoutSig;
  try {
    stateFileWithoutSig = stripField(stateFileContent, signatureField);
  } catch (e) {
    throw new SyntaxError(
      `emitContentDigest: stateFileContent must be valid JSON: ${e.message}`,
    );
  }

  const h = crypto.createHash("sha256");
  h.update(stateFileWithoutSig);
  h.update(smokeReportContent);
  h.update(interactionsReportContent);
  return h.digest("hex");
}

/**
 * verifyContentDigest — wraps emitContentDigest and compares against claimed.
 * Constant-time comparison via crypto.timingSafeEqual.
 *
 * @param {object} input
 * @returns {boolean}
 */
function verifyContentDigest(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("verifyContentDigest: input must be an object");
  }
  const { claimedSignature } = input;
  if (typeof claimedSignature !== "string" || claimedSignature.length === 0) {
    return false;
  }
  let computed;
  try {
    computed = emitContentDigest(input);
  } catch {
    return false;
  }
  if (computed.length !== claimedSignature.length) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(computed, "utf8"),
      Buffer.from(claimedSignature, "utf8"),
    );
  } catch {
    return false;
  }
}

/**
 * checkOverride — read the named env-var. Truthy on '1', case-insensitive
 * 'true', or 'yes'. Anything else (including unset / empty) is false.
 *
 * @param {string} envVarName
 * @returns {boolean}
 */
function checkOverride(envVarName) {
  if (typeof envVarName !== "string" || envVarName.length === 0) {
    throw new TypeError("checkOverride: envVarName is required");
  }
  const v = process.env[envVarName];
  if (v == null) return false;
  const norm = String(v).trim().toLowerCase();
  return norm === "1" || norm === "true" || norm === "yes";
}

/**
 * validateHonestYellow — confirms YELLOW claim has enumerated gaps.
 *
 * Acceptance criteria per rule MUST Rule 3:
 *   1. gap-list field is non-empty
 *   2. every contract gap surfaced by the scan is enumerated
 *   3. each entry references the failing identifier (substring match)
 *
 * Each gap MUST be matched by a DISTINCT entry — a single entry cannot
 * cover multiple gaps. Without this, an attacker could ship one entry
 * "panel-a panel-b panel-c" and "satisfy" all three gaps, defeating
 * the per-gap-rationale audit trail. The matching is a greedy
 * bipartite-assignment: each entry is consumed by at most one gap. To
 * give the matcher the best chance, we sort gaps by descending id
 * length first (longer ids are more specific; matching them first
 * avoids consuming a generic entry that could ONLY match a long id).
 * Closes MED-S2 from the 2026-05-10 redteam round.
 *
 * @param {object} input
 * @param {object} input.stateFile         Parsed state-file JSON.
 * @param {string} input.gapListField      Field name in state-file holding gap enumeration.
 * @param {object} input.contractScanResult Required: {gaps: string[]}.
 * @returns {{valid: boolean, reason: string|null}}
 */
function validateHonestYellow(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("validateHonestYellow: input must be an object");
  }
  const { stateFile, gapListField, contractScanResult } = input;
  if (!stateFile || typeof stateFile !== "object") {
    return { valid: false, reason: "stateFile is missing or not an object" };
  }
  const gapList = stateFile[gapListField];
  if (!Array.isArray(gapList) || gapList.length === 0) {
    return {
      valid: false,
      reason: `${gapListField} is missing, not an array, or empty`,
    };
  }
  if (!contractScanResult || !Array.isArray(contractScanResult.gaps)) {
    return {
      valid: false,
      reason: "contractScanResult.gaps is required (array of gap identifiers)",
    };
  }
  const gapEntries = gapList.map((e) => String(e));
  const consumed = new Array(gapEntries.length).fill(false);
  // Sort gaps longest-first so specific ids consume their entries
  // before generic ids; preserves original order for the missing-list.
  const orderedGaps = contractScanResult.gaps
    .map((g, idx) => ({ id: String(g), idx }))
    .sort((a, b) => b.id.length - a.id.length);
  const matched = new Array(contractScanResult.gaps.length).fill(false);
  for (const { id, idx } of orderedGaps) {
    const entryIdx = gapEntries.findIndex(
      (entry, i) => !consumed[i] && entry.includes(id),
    );
    if (entryIdx === -1) continue;
    consumed[entryIdx] = true;
    matched[idx] = true;
  }
  const missing = contractScanResult.gaps.filter((_, i) => !matched[i]);
  if (missing.length > 0) {
    return {
      valid: false,
      reason: `gap-list missing identifiers (each gap requires a distinct entry): ${missing.slice(0, 5).join(", ")}`,
    };
  }
  return { valid: true, reason: null };
}

module.exports = {
  TIER,
  tierClassify,
  emitContentDigest,
  verifyContentDigest,
  // DEPRECATED (loom#1427) — retained one minor cycle per zero-tolerance.md
  // Rule 6a. These names implied AUTHENTICITY the computation never provided
  // (a keyless sha256). Behaviour is unchanged and INTEGRITY-only; they no
  // longer satisfy tierClassify's T1 trust-root gate on their own. Migrate to
  // emitContentDigest / verifyContentDigest.
  emitSignature: emitContentDigest,
  verifySignature: verifyContentDigest,
  checkOverride,
  validateHonestYellow,
  // Exported for consumer-side wiring + regression tests.
  stripField,
  stripFields,
  composeSignedBytes,
  findSelfDeclaredFingerprint,
};
