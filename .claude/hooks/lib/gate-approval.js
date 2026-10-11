/**
 * gate-approval — canonical signed-bytes + verifier for the multi-operator
 * gate-approval payload consumed by operator-gate.js.
 *
 * F14 MED-1 + MED-2 (workspaces/multi-operator-coc — security review R1).
 * F14 iter-2 Sec-MED-2: canonical bytes extended to bind approver_verified_id.
 *
 * The 4 invariants this module holds:
 *
 *   (1) Canonical signed-bytes shape — the approver signs over exactly
 *       {target_tool, requester_person_id, requester_verified_id,
 *        approver_verified_id, consumed_nonce, ts} via
 *       cocSign.canonicalSerialize. The shape is fixed; both signer and
 *       verifier MUST agree byte-for-byte. approver_verified_id binding
 *       is iter-2 Sec-MED-2 defense-in-depth: the verifier already
 *       resolves the approver pubkey from this field (so a payload-
 *       level swap is structurally rejected by sig-verify), but binding
 *       it INTO the signed bytes makes the contract explicit and
 *       hardens against a future verifier-resolution-layer bug.
 *
 *   (2) cryptographic verification — the verifier resolves the approver's
 *       roster pubkey from the payload's approver_verified_id (NOT the
 *       attacker-controlled approver_role / approver_host_role fields)
 *       and calls cocSign.verify against the canonical bytes.
 *
 *   (3) nonce + target_tool + TTL binding — the verifier checks that
 *       (a) gate_approval.consumed_nonce equals the requester-supplied
 *           requester_nonce in the current invocation;
 *       (b) gate_approval.target_tool equals the canonical §6.4 row name
 *           derived from the current command surface (no cross-surface
 *           replay);
 *       (c) gate_approval.ts is within GATE_APPROVAL_TTL_MS (24h) of now.
 *
 *   (4) approver-role resolution from roster, NEVER from payload —
 *       the verifier returns the roster-resolved person record so the
 *       gate-matrix consumes a TRUSTED person, never the attacker claim.
 *
 *   (5) ACTION BINDING + EXPIRY (2026-10-09, replay closure). The signed bytes
 *       gained `command`, `target_sha` and `expires_at`, and the verifier
 *       compares the first two against values derived from the CURRENT request
 *       (the live command surface; the repo's HEAD), never from the payload:
 *
 *         - a signature that verifies for release X MUST NOT admit release Y.
 *           Before this, a valid in-payload approval was replayable within its
 *           24h window for ANY later release — measured: an approval naming
 *           commit 157fe4d9… was ACCEPTED while HEAD was df4de438….
 *         - `command` carries the ARGS, which `target_tool` cannot express (the
 *           same row can target L4 or L5); it is normalized by ONE exported
 *           helper so the minting side and the verifying side cannot drift.
 *         - `expires_at` is explicit and CAPPED at `ts + TTL`, so a signer may
 *           choose a shorter window but never a longer one; the pre-existing
 *           `ts`-vs-now check stays as the clock-skew guard.
 *
 *       COMPATIBILITY, stated rather than discovered: this changes the signed
 *       field set, so an approval signed under the pre-2026-10-09 six-field
 *       contract no longer verifies. That break is the intended consequence —
 *       and it invalidates no FOLDED record, because the fold signs a different
 *       shape (`coordination-log.js::_coSignedBytes`); this module's canonical
 *       bytes are used only by the in-payload path verified here.
 *
 * Cross-shard contracts consumed:
 *   - lib/coc-sign.js::canonicalSerialize / verify — same crypto layer
 *     fold-rule-9b / 9c / coordination-log Rule 1 use; bytes are
 *     deterministic across machines/sessions.
 *   - lib/eligibility.js::isEligibleSigner — single source of truth for
 *     R5-S-04 + role-floor. Same predicate B3b's reap ceremony +
 *     gate-matrix.js evaluateGate uses.
 *
 * Style: CommonJS, zero-dep beyond sibling lib/, matches sibling
 * .claude/hooks/lib/* modules. Pure function on injected `now` for testability.
 */

"use strict";

const path = require("path");
const cocSign = require(path.join(__dirname, "coc-sign.js"));
const { isEligibleSigner } = require(path.join(__dirname, "eligibility.js"));

/**
 * TTL clamp on gate-approval freshness (24h). After this window the signed
 * payload is rejected even if cryptographically valid — closes the long-tail
 * replay class where an attacker accumulates owner approvals and re-uses
 * them weeks later.
 */
const GATE_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Closed allowlist of target_tool values accepted in canonical signed
 * bytes. Mirrors the §6.4 row vocabulary the gate-matrix recognizes for
 * signing-context="gate-approval". Per cc-artifacts.md Rule 10 — positive
 * allowlist closes the bug class instead of enumerating denied values.
 */
const TARGET_TOOL_ALLOWLIST = Object.freeze({
  release: true,
  "posture-upgrade": true,
  "posture-override": true,
  "roster-edit-add-contributor": true,
  "new-rule-codify": true,
  // 2026-10-09 (hold-security round-2 R-1, run-verified): the owner-departure
  // HOLD wires signing_context 'owner-quorum' so operator-gate REQUIRES a signed
  // gate-approval for this row — but with the row absent here NO approval could
  // ever verify (the allowlist rejects it before the signature check), i.e. the
  // co-signer route the owner ruling approved was unreachable at a SECOND layer
  // the matrix tests never touch. The row is added to BOTH this list and the
  // fold mirror (coordination-log.js::_GATE_APPROVAL_TARGET_TOOL_ALLOWLIST);
  // gate-matrix.test.js asserts the two stay equal and name this row.
  "owner-departure-roster-removal": true,
});

/**
 * Re-derive the canonical bytes the approver covered. Both signer and
 * verifier MUST construct this object identically; field order is fixed
 * by canonicalSerialize's sort-keys-recursively contract.
 *
 * iter-2 Sec-MED-2: approver_verified_id is bound into the canonical
 * bytes. The verifier already resolves the approver pubkey from this
 * field, so a payload-level swap is structurally rejected by sig-verify.
 * Binding it into the signed bytes is defense-in-depth: it makes the
 * contract explicit AND hardens against a future verifier-resolution-
 * layer bug that might somehow accept a mismatched approver_verified_id.
 *
 * @param {object} fields
 * @param {string} fields.target_tool
 * @param {string} fields.requester_person_id
 * @param {string} fields.requester_verified_id
 * @param {string} fields.approver_verified_id  iter-2 Sec-MED-2
 * @param {string} fields.consumed_nonce
 * @param {string} fields.ts          ISO-8601 timestamp
 * @returns {Buffer} canonical bytes ready for cocSign.sign / verify
 */
function canonicalGateApprovalBytes(fields) {
  const f = fields || {};
  const obj = {
    target_tool: f.target_tool,
    // 2026-10-09 (replay closure) — `command` and `target_sha` bind the
    // approval to ONE exact action, and `expires_at` to one explicit window.
    // See invariant (5) in this file's header.
    command: f.command,
    target_sha: f.target_sha,
    requester_person_id: f.requester_person_id,
    requester_verified_id: f.requester_verified_id,
    approver_verified_id: f.approver_verified_id,
    consumed_nonce: f.consumed_nonce,
    ts: f.ts,
    expires_at: f.expires_at,
  };
  // canonicalSerialize validates undefined/NaN/Infinity and sorts keys;
  // it throws on shape violation. Caller's catch path surfaces as
  // {ok:false, reason:"canonicalSerialize failed: ..."} via verifyGateApproval.
  return cocSign.canonicalSerialize(obj);
}

/**
 * THE canonical form of a gated command surface — ONE normalizer, exported, so
 * the minting side (what an approver signs over) and the verifying side (what
 * the gate derives from the live invocation) cannot drift.
 *
 * Rules: the command NAME is stripped of a leading `/`, trimmed, lowercased and
 * reduced to its first token; the ARGS are trimmed with internal whitespace runs
 * collapsed to single spaces, case preserved. The two are joined by one space
 * when args are present.
 *
 *   ("release", "")                     -> "release"
 *   ("posture", "upgrade  --to L5")     -> "posture upgrade --to L5"
 *   ("/whoami", "--register")           -> "whoami --register"
 *
 * Why args are bound at all: `target_tool` names the §6.4 ROW, and one row can
 * carry materially different actions (posture upgrade --to L4 vs --to L5). A
 * signature over the row alone would admit either.
 *
 * @param {string} name
 * @param {string} [args]
 * @returns {string}
 */
function normalizeGateCommand(name, args) {
  const n = String(name == null ? "" : name)
    .trim()
    .replace(/^\//, "")
    .split(/[\s/]+/)[0]
    .toLowerCase();
  const a = String(args == null ? "" : args)
    .trim()
    .replace(/\s+/g, " ");
  return a ? `${n} ${a}` : n;
}

/**
 * Resolve the roster person whose key.fingerprint == verified_id.
 * Returns {person_id, person, pubkey, keyType} or null.
 */
function _resolveRosterPersonByVerifiedId(roster, verifiedId) {
  if (!roster || !roster.persons || !verifiedId) return null;
  for (const [pid, person] of Object.entries(roster.persons)) {
    // S61 — shape-guard the key list: a non-array `keys` SKIPS this person
    // (refuse), never THROWS. Same root cause as coordination-log.js
    // ::_resolveRosterPerson, which carries the full comment. Sharper here:
    // this resolver backs `verifyGateApproval`, so a throw escaping to the
    // caller's catch-all converts "this approval could not be verified" into
    // whatever that catch decides — the fail-open shape S60 was fixed for.
    // SKIP IS SAFE HERE ONLY BECAUSE non-resolution is wired to REFUSE.
    // Where non-resolution PERMITS, this shape inverts and becomes the bug —
    // see the condition + the two recorded exceptions (add-key-ceremony.js
    // ::findKeyHolder@:402, identity-scrub.mjs::deriveDynamicTokens) in the
    // canonical comment on coordination-log.js::_resolveRosterPerson.
    const keys = Array.isArray(person && person.keys) ? person.keys : [];
    for (const k of keys) {
      if (k && k.fingerprint === verifiedId) {
        return {
          person_id: pid,
          person,
          pubkey: k.pubkey,
          keyType: k.type || "ssh",
        };
      }
    }
  }
  return null;
}

/**
 * Verify a gate_approval payload against the current invocation context.
 *
 * @param {object} payload       — the tool_input.gate_approval object
 * @param {object} ctx
 * @param {string} ctx.gate                    canonical §6.4 row name
 *                                             derived from current command
 * @param {string} ctx.requester_person_id     current invocation operator
 * @param {string} ctx.requester_verified_id   current invocation operator key
 * @param {string} ctx.requester_nonce         requester-minted nonce
 * @param {object} ctx.roster                  operators roster
 * @param {number} [ctx.now=Date.now()]        wall clock for TTL check
 *
 * @returns {{
 *   ok: boolean,
 *   reason?: string,                          present when ok=false
 *   approverPerson?: object,                  roster-resolved person record
 *   approverVerifiedId?: string,              for downstream audit
 * }}
 *
 * Defense-in-depth ordering: cheap shape checks first, then cryptographic
 * verify (most expensive), then policy checks. The verify-then-binding
 * order is intentional — a forged sig is rejected before nonce/ttl tests
 * even run, so an attacker cannot probe nonce uniqueness by submitting
 * unsigned/forged payloads.
 */
function verifyGateApproval(payload, ctx) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "gate_approval payload missing" };
  }
  if (!ctx || typeof ctx !== "object") {
    return { ok: false, reason: "verify ctx missing" };
  }

  // ---- shape checks ---------------------------------------------------------

  if (typeof payload.sig !== "string" || !payload.sig) {
    return { ok: false, reason: "gate_approval.sig required (MED-1)" };
  }
  if (
    typeof payload.approver_verified_id !== "string" ||
    !payload.approver_verified_id
  ) {
    return {
      ok: false,
      reason: "gate_approval.approver_verified_id required (MED-1)",
    };
  }
  if (typeof payload.target_tool !== "string" || !payload.target_tool) {
    return { ok: false, reason: "gate_approval.target_tool required (MED-2)" };
  }
  if (typeof payload.consumed_nonce !== "string" || !payload.consumed_nonce) {
    return {
      ok: false,
      reason: "gate_approval.consumed_nonce required (MED-2)",
    };
  }
  if (typeof payload.ts !== "string" || !payload.ts) {
    return { ok: false, reason: "gate_approval.ts required (MED-2)" };
  }
  // 2026-10-09 (replay closure) — the action-binding + expiry fields.
  if (typeof payload.command !== "string" || !payload.command) {
    return {
      ok: false,
      reason:
        "gate_approval.command required (replay closure): the approval must be bound to the exact command it authorizes",
    };
  }
  if (
    typeof payload.target_sha !== "string" ||
    !/^[0-9a-f]{40}$/.test(payload.target_sha)
  ) {
    return {
      ok: false,
      reason:
        "gate_approval.target_sha required as a full 40-hex commit sha (replay closure): the approval must be bound to the commit it authorizes",
    };
  }
  if (typeof payload.expires_at !== "string" || !payload.expires_at) {
    return {
      ok: false,
      reason: "gate_approval.expires_at required (replay closure)",
    };
  }
  if (typeof ctx.gate !== "string" || !ctx.gate) {
    return { ok: false, reason: "ctx.gate required" };
  }
  if (typeof ctx.command !== "string" || !ctx.command) {
    return {
      ok: false,
      reason:
        "ctx.command required (replay closure): the gate must derive the live command surface for the approval to be bound against",
    };
  }
  if (
    typeof ctx.target_sha !== "string" ||
    !/^[0-9a-f]{40}$/.test(ctx.target_sha)
  ) {
    return {
      ok: false,
      reason:
        "ctx.target_sha required as a full 40-hex commit sha (replay closure): the gate must derive the CURRENT commit for the approval to be bound against",
    };
  }
  if (typeof ctx.requester_person_id !== "string" || !ctx.requester_person_id) {
    return { ok: false, reason: "ctx.requester_person_id required" };
  }
  if (
    typeof ctx.requester_verified_id !== "string" ||
    !ctx.requester_verified_id
  ) {
    return { ok: false, reason: "ctx.requester_verified_id required" };
  }
  if (typeof ctx.requester_nonce !== "string" || !ctx.requester_nonce) {
    return { ok: false, reason: "ctx.requester_nonce required (MED-2)" };
  }

  // ---- target_tool allowlist (MED-2 + MED-3) -------------------------------

  if (!TARGET_TOOL_ALLOWLIST[payload.target_tool]) {
    return {
      ok: false,
      reason: `gate_approval.target_tool '${payload.target_tool}' not in allowlist (MED-2)`,
    };
  }

  // ---- target_tool matches current invocation (MED-2 cross-surface replay) -

  if (payload.target_tool !== ctx.gate) {
    return {
      ok: false,
      reason: `target_tool mismatch: gate_approval signed for '${payload.target_tool}'; current invocation is '${ctx.gate}' (MED-2 cross-surface replay defense)`,
    };
  }

  // ---- ACTION BINDING (2026-10-09 replay closure) --------------------------
  // A signature that verifies for release X MUST NOT admit release Y. BOTH
  // sides are compared against values the GATE derived from the current
  // request (ctx), never against anything the payload supplies twice: the
  // command from the live Skill invocation, the sha from the repo's HEAD.
  // This is the check the pre-fix gate lacked — measured, an approval naming
  // commit 157fe4d9… was ACCEPTED while HEAD was df4de438….

  if (payload.command !== ctx.command) {
    return {
      ok: false,
      reason: `command mismatch: gate_approval is bound to '${payload.command}'; the current invocation is '${ctx.command}' (replay closure — the approval authorizes a different action)`,
    };
  }

  if (payload.target_sha !== ctx.target_sha) {
    return {
      ok: false,
      reason: `target_sha mismatch: gate_approval is bound to commit '${payload.target_sha}'; the repo is at '${ctx.target_sha}' (replay closure — the approval authorizes a different commit)`,
    };
  }

  // ---- nonce binding (MED-2) -----------------------------------------------

  if (payload.consumed_nonce !== ctx.requester_nonce) {
    return {
      ok: false,
      reason: `consumed_nonce mismatch: gate_approval covers '${payload.consumed_nonce}'; requester minted '${ctx.requester_nonce}' for this invocation (MED-2)`,
    };
  }

  // ---- TTL (MED-2) ---------------------------------------------------------

  const now = typeof ctx.now === "number" ? ctx.now : Date.now();
  const tsMs = Date.parse(payload.ts);
  if (!Number.isFinite(tsMs)) {
    return {
      ok: false,
      reason: `gate_approval.ts '${payload.ts}' not a parseable timestamp (MED-2)`,
    };
  }
  const ageMs = now - tsMs;
  if (ageMs > GATE_APPROVAL_TTL_MS) {
    return {
      ok: false,
      reason: `gate_approval expired: ts is ${Math.floor(ageMs / 1000)}s old (TTL ${GATE_APPROVAL_TTL_MS / 1000}s, ~24h) (MED-2)`,
    };
  }
  // Allow small clock skew but reject clearly-future ts (5min tolerance).
  if (ageMs < -5 * 60 * 1000) {
    return {
      ok: false,
      reason: `gate_approval.ts is in the future by ${Math.floor(-ageMs / 1000)}s (MED-2)`,
    };
  }

  // ---- EXPLICIT EXPIRY (2026-10-09 replay closure) -------------------------
  // `expires_at` is the signer's declared end of validity. It may be SHORTER
  // than the TTL but never longer: an approver must not be able to mint a
  // window wider than the policy the TTL check above already enforces.
  const expiresMs = Date.parse(payload.expires_at);
  if (!Number.isFinite(expiresMs)) {
    return {
      ok: false,
      reason: `gate_approval.expires_at '${payload.expires_at}' not a parseable timestamp (replay closure)`,
    };
  }
  if (expiresMs < now) {
    return {
      ok: false,
      reason: `gate_approval expired at ${payload.expires_at} (${Math.floor((now - expiresMs) / 1000)}s ago) (replay closure)`,
    };
  }
  if (expiresMs - tsMs > GATE_APPROVAL_TTL_MS) {
    return {
      ok: false,
      reason: `gate_approval.expires_at is ${Math.floor((expiresMs - tsMs) / 1000)}s after ts, beyond the ${GATE_APPROVAL_TTL_MS / 1000}s TTL (replay closure — a signer may choose a SHORTER window, never a longer one)`,
    };
  }

  // ---- roster resolution (MED-1 + MED-4) -----------------------------------

  const resolved = _resolveRosterPersonByVerifiedId(
    ctx.roster,
    payload.approver_verified_id,
  );
  if (!resolved) {
    return {
      ok: false,
      reason: `approver_verified_id '${payload.approver_verified_id}' not in roster (MED-1)`,
    };
  }

  // R5-S-04 + role-floor check via the single eligibility predicate. The
  // gate matrix re-runs this check downstream; doing it here too is
  // defense-in-depth + provides a clearer rejection reason at the
  // verify boundary.
  const elig = isEligibleSigner(resolved.person, "gate-approval");
  if (!elig.eligible) {
    return {
      ok: false,
      reason: `approver role ineligible: ${elig.reason} (MED-1)`,
    };
  }

  // ---- cryptographic verify (MED-1) ----------------------------------------
  // Re-derive canonical bytes from the payload's claimed signed-payload
  // fields. If the attacker omitted any field, this shape check + verify
  // fails. The verify call is against the roster-resolved pubkey, NOT
  // any pubkey hint in the payload.

  let canonicalBytes;
  try {
    canonicalBytes = canonicalGateApprovalBytes({
      target_tool: payload.target_tool,
      // Re-derived from the PAYLOAD's own fields (never from ctx): the signature
      // must be checked against what the APPROVER signed, and the ctx-vs-payload
      // comparison above is what binds that to the current request.
      command: payload.command,
      target_sha: payload.target_sha,
      requester_person_id: ctx.requester_person_id,
      requester_verified_id: ctx.requester_verified_id,
      approver_verified_id: payload.approver_verified_id, // iter-2 Sec-MED-2
      consumed_nonce: payload.consumed_nonce,
      ts: payload.ts,
      expires_at: payload.expires_at,
    });
  } catch (err) {
    return {
      ok: false,
      reason: `canonicalSerialize failed: ${err && err.message ? err.message : String(err)}`,
    };
  }
  let verifyResult;
  try {
    verifyResult = cocSign.verify(
      canonicalBytes,
      payload.sig,
      resolved.pubkey,
      {
        keyType: resolved.keyType,
      },
    );
  } catch (err) {
    return {
      ok: false,
      reason: `verify threw: ${err && err.message ? err.message : String(err)}`,
    };
  }
  if (!verifyResult || !verifyResult.ok) {
    return {
      ok: false,
      reason: `verify call failed: ${verifyResult && verifyResult.reason ? verifyResult.reason : "unknown"}`,
    };
  }
  if (!verifyResult.valid) {
    return {
      ok: false,
      reason: `signature did not verify: ${verifyResult.reason || "invalid"}`,
    };
  }

  return {
    ok: true,
    approverPerson: resolved.person,
    approverPersonId: resolved.person_id,
    approverVerifiedId: payload.approver_verified_id,
  };
}

// ---- #583 Shard 4 — the L8/L10 co-sign EMIT path ----------------------------

/**
 * buildGateApprovalRecord(fields) — shape the `content` object for a
 * coordination-log `gate-approval` record from already-collected ceremony
 * pieces. This helper does NOT run the multi-party ceremony (the off-loom broker
 * issues the presence proofs, the approvers produce their co-sigs + presence
 * proofs, the approval UX orchestrates it — all the off-loom enterprise product's) — it ASSEMBLES
 * the collected pieces into the record content the emitter signs.
 *
 * @param {object} fields
 * @param {string} fields.targetTool         §6.4 gate row (release, posture-*, …)
 * @param {string} fields.requesterPersonId
 * @param {string} fields.requesterVerifiedId
 * @param {string} fields.consumedNonce       the requester-minted nonce
 * @param {Array}  [fields.coSigners]         [{verified_id, sig, presence_proof?}]
 *   — each distinct approver's 4-eyes co-sig (over _coSignedBytes) AND, per
 *   Shard 4, that approver's OWN broker-signed presence proof (co_signers[i]
 *   .presence_proof), so the fold can attribute the DISTINCT approver's presence.
 * @param {object} [fields.presenceProof]     the EMITTER's content.presence_proof
 *   (a broker-signed proof; REQUIRED for the emit to clear the actuation gate).
 * @returns {object} the gate-approval `content`.
 */
function buildGateApprovalRecord(fields) {
  const f = fields || {};
  const content = {
    target_tool: f.targetTool,
    requester_person_id: f.requesterPersonId,
    requester_verified_id: f.requesterVerifiedId,
    consumed_nonce: f.consumedNonce,
    co_signers: Array.isArray(f.coSigners) ? f.coSigners : [],
  };
  if (f.presenceProof !== undefined && f.presenceProof !== null) {
    content.presence_proof = f.presenceProof;
  }
  return content;
}

/**
 * emitGateApproval(opts) — emit a `gate-approval` record through the SINGLE
 * signed emitter (`coc-emit.js::emitSignedRecord`), so the record INHERITS the
 * actuation presence gate (coc-emit.js requires `content.presence_proof` PROVEN
 * for `requiresPresenceAttestation` types, of which `gate-approval` is the one
 * member) BY CONSTRUCTION. This is the SOLE build+emit site for gate-approval
 * records: a bespoke hand-append is BLOCKED (`security.md` § Multi-Site Kwarg
 * Plumbing), so the presence-proof demand stays single-sourced at the emitter's
 * `:465` gate — no second, drift-prone proof check lives here.
 *
 * HONEST SHARD BOUNDARY (journal/0509, `zero-tolerance.md` Rule 2 carve-out): the
 * LIVE `/release` runtime cutover — making `/release` actually CALL this to emit
 * a folded gate-approval demanding a REAL broker proof — is the workstream
 * ENDPOINT and fires when the off-loom presence broker lands (always-on
 * ⇒ no advisory staging window). This shard ships the PLUMBING; `operator-gate.js`
 * keeps the live in-payload `/release` verify untouched until then.
 *
 * @param {object} opts — buildGateApprovalRecord fields PLUS the emitSignedRecord
 *   envelope: {repoDir, identity?, signingKeyPath?, keyType?, sign?,
 *   readChainHead?, append?, gitConfigSigningKey?}. The test-injectable seam
 *   (sign/readChainHead/append) is how the AC-L14 offline harness drives it with
 *   no coordination log present.
 * @returns {object} emitSignedRecord's result ({ok, record?, reason?, step?}).
 */
function emitGateApproval(opts) {
  const o = opts || {};
  const content = buildGateApprovalRecord(o);
  try {
    const { emitSignedRecord } = require(path.join(__dirname, "coc-emit.js"));
    const emitOpts = {
      repoDir: o.repoDir,
      type: "gate-approval",
      content,
      identity: o.identity,
      signingKeyPath: o.signingKeyPath,
      keyType: o.keyType,
      sign: o.sign,
      readChainHead: o.readChainHead,
      append: o.append,
    };
    if (Object.prototype.hasOwnProperty.call(o, "gitConfigSigningKey")) {
      emitOpts.gitConfigSigningKey = o.gitConfigSigningKey;
    }
    return emitSignedRecord(emitOpts);
  } catch (err) {
    return {
      ok: false,
      error: "gate-approval emit threw",
      reason: err && err.message ? err.message : String(err),
      step: "emit",
    };
  }
}

module.exports = {
  GATE_APPROVAL_TTL_MS,
  TARGET_TOOL_ALLOWLIST,
  canonicalGateApprovalBytes,
  // ONE normalizer for the bound command surface, exported so the documenting
  // side (what an approver signs over) and the verifying side cannot drift.
  normalizeGateCommand,
  verifyGateApproval,
  buildGateApprovalRecord,
  emitGateApproval,
};
