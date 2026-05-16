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
 *   tierClassify(input)       → { tier, diagnostic }
 *   emitSignature(input)      → hex string
 *   verifySignature(input)    → boolean
 *   checkOverride(envVar)     → boolean
 *   validateHonestYellow(...) → { valid, reason }
 *
 * The lib itself never reads files, never invokes subprocesses, never
 * checks env (other than the named override var). Consumer hooks pass
 * file contents + contract-scan verdicts in; lib classifies.
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
 * @returns {{tier: string, diagnostic: string}}
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

  const sigOk = verifySignature({
    stateFileContent,
    smokeReportContent,
    interactionsReportContent,
    signatureField,
    claimedSignature,
  });
  if (!sigOk) {
    return {
      tier: TIER.T3,
      diagnostic: `T3 BLOCK: ${signatureField} does not match sha256(state-file-without-signature || smoke-report || interactions-report). Trust root forged or wrapper not run.`,
    };
  }

  if (!contractScanResult || typeof contractScanResult !== "object") {
    return {
      tier: TIER.T3,
      diagnostic:
        "T3 BLOCK: contractScanResult is required for GREEN claims. Caller must invoke the consumer-supplied validator and pass its verdict.",
    };
  }

  if (!contractScanResult.passed) {
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
 * emitSignature — sha256(state-file-without-signature || smoke-report || interactions-report).
 *
 * The signature input is the state-file JSON with the signature field
 * stripped (so re-signing the same state-file is deterministic),
 * concatenated with the smoke report and interactions report. Order is
 * fixed: state || smoke || interactions. Wrapper-only computation
 * surface; the validator's signature attests "the wrapper ran and
 * produced these reports."
 *
 * @param {object} input
 * @param {string} input.stateFileContent
 * @param {string} input.smokeReportContent
 * @param {string} input.interactionsReportContent
 * @param {string} input.signatureField
 * @returns {string} hex sha256
 */
function emitSignature(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("emitSignature: input must be an object");
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
      throw new TypeError(`emitSignature: ${k} must be a non-empty string`);
    }
  }
  validateFieldName(signatureField, "emitSignature: signatureField");

  // Bound the parse cost on the SIGN path too. The wrapper isn't subject
  // to CC's hook timeout (no fail-OPEN here), but unbounded JSON.parse
  // on a 100MB state-file still blocks the wrapper synchronously and
  // wastes resources. Same DoS class as tierClassify's check; same
  // resolveMaxBytes helper. Closes the round-3 redteam carryover where
  // the BLOCK path was bounded but the SIGN path was not.
  const maxBytes = resolveMaxBytes(input);
  if (Buffer.byteLength(stateFileContent, "utf8") > maxBytes) {
    throw new RangeError(
      `emitSignature: stateFileContent exceeds maxBytes (${maxBytes})`,
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
    const parsed = JSON.parse(stateFileContent);
    delete parsed[signatureField];
    stateFileWithoutSig = JSON.stringify(parsed);
  } catch (e) {
    throw new SyntaxError(
      `emitSignature: stateFileContent must be valid JSON: ${e.message}`,
    );
  }

  const h = crypto.createHash("sha256");
  h.update(stateFileWithoutSig);
  h.update(smokeReportContent);
  h.update(interactionsReportContent);
  return h.digest("hex");
}

/**
 * verifySignature — wraps emitSignature and compares against claimed.
 * Constant-time comparison via crypto.timingSafeEqual.
 *
 * @param {object} input
 * @returns {boolean}
 */
function verifySignature(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("verifySignature: input must be an object");
  }
  const { claimedSignature } = input;
  if (typeof claimedSignature !== "string" || claimedSignature.length === 0) {
    return false;
  }
  let computed;
  try {
    computed = emitSignature(input);
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
  emitSignature,
  verifySignature,
  checkOverride,
  validateHonestYellow,
};
