/**
 * fold-member-registry — cascade-membership registry fold predicates
 * (M1–M4 + disclosure-isolation + genesis-precedes-admission).
 *
 * ECO-IMPL Wave 2, Shard S1 (A1-T1). Implements
 * `workspaces/ecosystem-operating-model/02-plans/07-cascade-membership.md`
 * §4.2 (record types) + §4.3 (M1–M4 fold rules) + §8 (cross-cutting
 * invariants); normative `specs/06 §7`.
 *
 * The member registry is a NEW record NAMESPACE on the SAME signed-append
 * + per-emitter-hash-chain substrate as the multi-operator
 * coordination-log (`multi-operator-coordination.md` §2). The inherited
 * fold rules 1–3 (signature gate, per-emitter chain integrity, fork
 * detection) run in coordination-log.js::_foldLog BEFORE these predicates
 * dispatch — so a record reaching a predicate here has already verified
 * its signature and per-emitter chain. These predicates add the
 * MEMBERSHIP-specific rules:
 *
 *   M1 — admission binds to project-side evidence (§4.3). A
 *        `member-admitted` confers ACTIVE membership only if it carries a
 *        signed-pointer binding naming THIS ecosystem; an admission with
 *        no agreeing binding folds INERT (accepted into the chain, confers
 *        no membership — half a handshake, §3.3).
 *   M2 — sever monotonicity over the per-PROJECT causal chain
 *        (`supersedes_ref`, NOT cross-emitter `seq`) (§4.3). Each
 *        state-change links to the state-head it supersedes; a fork of the
 *        membership chain (a second state-change citing an
 *        already-superseded head) is rejected.
 *   M3 — pointer-flip / withdrawn sever carries re-verifiable evidence
 *        (§4.3); a sever whose cited evidence STILL names E is REJECTED
 *        (anti-malicious-eviction). `evicted` is the single-sided
 *        owner-class exclusion (no P-evidence).
 *   M4 — proof-grade head (§5, fold-side). The per-project membership
 *        state computed here is the "registry tip fold-to" half of the
 *        on-demand head; the LIVE ref-fetch + P-pointer re-fetch is the
 *        consumer's job (W3 `membership-head.js::proveMembership`).
 *   (v)  disclosure isolation (§8). No admission / sever / attestation
 *        record may carry ANOTHER ecosystem's identity — enforced
 *        structurally by a positive field allowlist per record type
 *        (`cc-artifacts.md` Rule 10), so a smuggled destination field is
 *        rejected at fold rather than stored.
 *   (vi) genesis-precedes-admission (§8). No `member-admitted` confers
 *        membership without a preceding `registry-genesis-anchor` for THIS
 *        ecosystem (the INFRA-provisioned trust root); absent it, the
 *        admission folds INERT (fail-closed, same direction as M1).
 *
 * Out of scope for THIS shard (named, not silently handled — §10 + §9):
 *   - The LIVE on-demand registry-tip / P-pointer ref-fetch (§5 steps 1–2)
 *     is the W2-S2 pointer lib + W3 head consumer; this file folds a
 *     records array.
 *   - The registry GENERATION-ROTATION archive-tip-pin LIVE verification
 *     is the MUST-5 / F51 reuse (`archive-ref.js::verifyArchiveTipPin` (invoked from `fold-rule-9b.js`),
 *     §9) — the rotation predicate here validates monotonicity + pin
 *     PRESENCE; the live pin verify rides the already-shipped F51 path
 *     when a consumer wires it.
 *   - Pointer / registry equivocation are detection-eventually residuals
 *     caught by the inherited fold rule 3 fork-detection (§10), NOT
 *     prevented here.
 *
 * Style: CommonJS, zero-dep beyond coc-sign + node:crypto, matches sibling
 * fold-rule-9c.js shape. Each predicate consumes the engine dispatch ctx
 * ({ foldState, roster, acceptedSoFar }) and returns
 * { accepted, foldState, reason? } per coordination-log.js::_foldLog. Per
 * zero-tolerance.md Rule 3: every rejection returns a typed reason; no
 * silent fallback.
 */

"use strict";

const crypto = require("crypto");
const { canonicalSerialize } = require("./coc-sign.js");

// ---------------------------------------------------------------------------
// Record-type names (the member-registry namespace). Re-exported by
// member-registry.js as MEMBER_REGISTRY_TYPES — single source here so the
// fold predicates and the emit/registration sites cannot drift.
// ---------------------------------------------------------------------------
const TYPE_GENESIS_ANCHOR = "registry-genesis-anchor";
const TYPE_MEMBER_ADMITTED = "member-admitted";
const TYPE_RECONCILIATION = "reconciliation-attestation";
const TYPE_MEMBERSHIP_SEVERED = "membership-severed";
const TYPE_GENERATION_ROTATION = "registry-generation-rotation";

// §4.2 sever reasons. pointer-flip / withdrawn are P-initiated +
// evidence-bearing (M3); evicted is E-initiated + owner-class single-sided.
const SEVER_REASON_POINTER_FLIP = "pointer-flip";
const SEVER_REASON_WITHDRAWN = "withdrawn";
const SEVER_REASON_EVICTED = "evicted";
const SEVER_REASONS = new Set([
  SEVER_REASON_POINTER_FLIP,
  SEVER_REASON_WITHDRAWN,
  SEVER_REASON_EVICTED,
]);

// Positive field allowlists per record type (invariant v, disclosure
// isolation via cc-artifacts.md Rule 10). A record whose content carries
// ANY key outside its allowlist is rejected at fold — this is the
// STRUCTURAL defense that a destination-ecosystem id (or any other
// smuggled field) can never be STORED in the registry. Only
// registry-genesis-anchor may carry `ecosystem_id` (its OWN ecosystem,
// the trust root); admissions / severs / attestations carry project_id +
// boolean + pointer-tip hash, never any ecosystem id.
const CONTENT_FIELD_ALLOWLIST = {
  [TYPE_GENESIS_ANCHOR]: new Set([
    "ecosystem_id",
    "repo_owner",
    "genesis_generation",
  ]),
  [TYPE_MEMBER_ADMITTED]: new Set([
    "project_id",
    "observed_pointer_tip",
    "observed_pointer_names_this_ecosystem",
    "supersedes_ref",
  ]),
  [TYPE_RECONCILIATION]: new Set([
    "project_id",
    "observed_pointer_tip",
    "observed_names_this_ecosystem",
    "observed_at",
  ]),
  [TYPE_MEMBERSHIP_SEVERED]: new Set([
    "project_id",
    "reason",
    "observed_pointer_tip",
    "observed_names_this_ecosystem",
    "supersedes_ref",
  ]),
  [TYPE_GENERATION_ROTATION]: new Set([
    "from_generation",
    "to_generation",
    "archive_tip_pin",
    "co_signers",
  ]),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Content hash of a record — byte-identical to coordination-log.js::
 * _canonicalHash (sha256 of canonicalSerialize(record minus sig)). This is
 * the value the per-emitter chain uses for prev_hash AND the value
 * supersedes_ref links against, so the membership causal chain (M2) keys
 * on the SAME hash the substrate already commits to. Replicated locally
 * (not imported from coordination-log.js) to keep this module free of a
 * require cycle — coordination-log.js requires THIS file to register the
 * predicates.
 */
function recordContentHash(record) {
  const { sig: _sig, ...core } = record;
  return crypto
    .createHash("sha256")
    .update(canonicalSerialize(core))
    .digest("hex");
}

/**
 * Resolve the role of the roster person owning `verifiedId` (the signing-
 * key fingerprint). Returns the role string ("owner" / "senior" /
 * "contributor") or null when unresolved. Used for the owner-class gate on
 * the E-side trust-establishing/removing acts (admission + evicted-sever),
 * §3.2 / §4.2.
 */
function resolvePersonRole(roster, verifiedId) {
  if (!roster || !roster.persons || typeof roster.persons !== "object") {
    return null;
  }
  for (const person of Object.values(roster.persons)) {
    if (!person || !Array.isArray(person.keys)) continue;
    for (const k of person.keys) {
      if (k && k.fingerprint === verifiedId) return person.role || null;
    }
  }
  return null;
}

/**
 * Validate that record.content carries ONLY keys in the type's allowlist.
 * Returns null on pass, or a typed reason string on the first
 * out-of-allowlist key (the disclosure-isolation structural fence,
 * invariant v).
 */
function checkFieldAllowlist(recordType, content) {
  const allow = CONTENT_FIELD_ALLOWLIST[recordType];
  if (!allow) return `no field allowlist for type '${recordType}'`;
  for (const key of Object.keys(content)) {
    if (!allow.has(key)) {
      return `disclosure-isolation (invariant v): '${recordType}' content carries disallowed field '${key}' (only ${[...allow].join(", ")} permitted; a foreign-ecosystem destination field is structurally rejected, never stored)`;
    }
  }
  return null;
}

/** Lazily clone-and-extend the foldState.memberRegistry sub-tree. */
function extendMemberRegistry(foldState, mutator) {
  const prev = (foldState && foldState.memberRegistry) || {
    genesis: null,
    generation: null,
    projects: {},
  };
  const next = {
    genesis: prev.genesis,
    generation: prev.generation,
    projects: Object.assign({}, prev.projects),
  };
  mutator(next);
  return Object.assign({}, foldState, { memberRegistry: next });
}

function reject(foldState, reason) {
  return { accepted: false, foldState, reason };
}

// ---------------------------------------------------------------------------
// Predicate: registry-genesis-anchor (§4.2 / §8 trust root)
// ---------------------------------------------------------------------------
/**
 * First-wins genesis anchor for THIS ecosystem's member registry. Mirrors
 * the multi-operator genesis-anchor first-wins semantics
 * (`multi-operator-coordination.md` §6 fold rule 9): the FIRST verifying
 * registry-genesis-anchor establishes the registry trust root; a SECOND is
 * rejected (the trust root is immutable absent a co-signed rotation). The
 * deep owner-quorum binding is the reused INFRA genesis-ceremony's job
 * (§4.1 / §9 reuse); here we validate owner-class single-sig minimum +
 * required fields + first-wins.
 */
function foldRegistryGenesisAnchor(record, ctx) {
  const foldState = ctx.foldState || { trustRoot: null };
  const content = record.content;
  if (!content || typeof content !== "object") {
    return reject(foldState, "registry-genesis-anchor: content missing");
  }
  const allowErr = checkFieldAllowlist(TYPE_GENESIS_ANCHOR, content);
  if (allowErr) return reject(foldState, allowErr);

  if (typeof content.ecosystem_id !== "string" || !content.ecosystem_id) {
    return reject(
      foldState,
      "registry-genesis-anchor: ecosystem_id must be a non-empty string",
    );
  }
  if (typeof content.repo_owner !== "string" || !content.repo_owner) {
    return reject(
      foldState,
      "registry-genesis-anchor: repo_owner must be a non-empty string",
    );
  }
  if (
    typeof content.genesis_generation !== "number" ||
    !Number.isInteger(content.genesis_generation) ||
    content.genesis_generation < 0
  ) {
    return reject(
      foldState,
      "registry-genesis-anchor: genesis_generation must be a non-negative integer",
    );
  }

  // First-wins: a second genesis anchor cannot re-root the registry.
  const existing = foldState.memberRegistry && foldState.memberRegistry.genesis;
  if (existing) {
    return reject(
      foldState,
      `registry-genesis-anchor: trust root already established for ecosystem '${existing.ecosystem_id}' (first-wins; re-rooting requires a co-signed registry-generation-rotation)`,
    );
  }

  // Owner-class single-sig minimum (§3.2). The signature itself was
  // verified by the inherited rule 1; here we gate on the signer's role.
  const role = resolvePersonRole(ctx.roster, record.verified_id);
  if (role !== "owner") {
    return reject(
      foldState,
      `registry-genesis-anchor: signer role '${role || "unresolved"}' is not owner-class (the registry trust root requires an owner-class signature, §3.2)`,
    );
  }

  const next = extendMemberRegistry(foldState, (mr) => {
    mr.genesis = {
      ecosystem_id: content.ecosystem_id,
      repo_owner: content.repo_owner,
      genesis_generation: content.genesis_generation,
    };
    mr.generation = content.genesis_generation;
  });
  return { accepted: true, foldState: next };
}

// ---------------------------------------------------------------------------
// Predicate: member-admitted (M1 + genesis-precedes + owner-class)
// ---------------------------------------------------------------------------
/**
 * The loom-side half of the two-sided handshake (§3.2). Folds as ACTIVE
 * membership only when ALL hold:
 *   - genesis precedes (invariant vi): a registry-genesis-anchor exists;
 *     else the admission folds INERT (accepted, confers no membership).
 *   - M1 binding: carries observed_pointer_tip + observed_pointer_names_
 *     this_ecosystem === true; else INERT (half a handshake — the on-demand
 *     re-resolution of the pointer is the §5 head consumer's job, but a
 *     fold-time admission MUST at minimum carry the agreeing binding).
 *   - owner-class signer (§3.2): admission is a trust-establishing act.
 *   - M2 causal-chain: supersedes_ref null for a FIRST admission, else the
 *     prior membership-severed head's hash (a re-admission). A non-
 *     superseding second admission, or one citing a stale head, forks the
 *     membership chain and is rejected.
 *
 * INERT vs REJECTED: a structurally-valid admission lacking genesis or
 * binding folds INERT (accepted into the chain so per-emitter seq advances,
 * but no projects[] entry → computeMembershipState reports non-member). A
 * malformed admission (bad field shape, chain fork, non-owner signer) is
 * REJECTED.
 */
function foldMemberAdmitted(record, ctx) {
  const foldState = ctx.foldState || { trustRoot: null };
  const content = record.content;
  if (!content || typeof content !== "object") {
    return reject(foldState, "member-admitted: content missing");
  }
  const allowErr = checkFieldAllowlist(TYPE_MEMBER_ADMITTED, content);
  if (allowErr) return reject(foldState, allowErr);

  if (typeof content.project_id !== "string" || !content.project_id) {
    return reject(
      foldState,
      "member-admitted: project_id must be a non-empty string",
    );
  }
  // supersedes_ref: null (first admission) or a non-empty string (re-admit).
  if (
    content.supersedes_ref !== null &&
    (typeof content.supersedes_ref !== "string" || !content.supersedes_ref)
  ) {
    return reject(
      foldState,
      "member-admitted: supersedes_ref must be null (first admission) or a non-empty hash string (re-admission)",
    );
  }
  // Owner-class signer (§3.2) — REJECT (not inert): a non-owner cannot
  // establish membership.
  const role = resolvePersonRole(ctx.roster, record.verified_id);
  if (role !== "owner") {
    return reject(
      foldState,
      `member-admitted: signer role '${role || "unresolved"}' is not owner-class (admission is a trust-establishing act, §3.2)`,
    );
  }

  const projectId = content.project_id;
  const mr = foldState.memberRegistry || { genesis: null, projects: {} };
  const projects = mr.projects || {};
  const current = projects[projectId];

  // M2 causal-chain validation runs BEFORE the inert checks: a chain fork
  // is a forgery signal that must be rejected regardless of binding.
  const thisHash = recordContentHash(record);
  if (content.supersedes_ref === null) {
    // First admission: there MUST be no prior state-head for this project.
    if (current) {
      return reject(
        foldState,
        `member-admitted (M2): supersedes_ref null but project '${projectId}' already has a state-head (a non-superseding second admission forks the membership causal chain)`,
      );
    }
  } else {
    // Re-admission: supersedes_ref MUST equal the current head AND that
    // head MUST be a sever (re-admission supersedes a severed interval).
    if (!current) {
      return reject(
        foldState,
        `member-admitted (M2): supersedes_ref '${content.supersedes_ref}' cites a prior state-head but project '${projectId}' has none`,
      );
    }
    if (current.head_hash !== content.supersedes_ref) {
      return reject(
        foldState,
        `member-admitted (M2): supersedes_ref '${content.supersedes_ref}' does not match project '${projectId}' current head '${current.head_hash}' (membership-chain fork)`,
      );
    }
    if (current.state !== "severed") {
      return reject(
        foldState,
        `member-admitted (M2): re-admission must supersede a severed state, but project '${projectId}' head is '${current.state}'`,
      );
    }
  }

  // M1 + genesis-precedes: structurally valid but INERT when the handshake
  // binding or the trust root is absent. INERT = accepted into the chain,
  // no membership conferred (no projects[] mutation).
  const genesisPresent = !!(mr.genesis && mr.genesis.ecosystem_id);
  const bindingPresent =
    typeof content.observed_pointer_tip === "string" &&
    content.observed_pointer_tip.length > 0 &&
    content.observed_pointer_names_this_ecosystem === true;
  if (!genesisPresent || !bindingPresent) {
    // Accept the record (chain advances) but confer no membership.
    return { accepted: true, foldState };
  }

  const next = extendMemberRegistry(foldState, (m) => {
    m.projects[projectId] = {
      state: "member",
      head_hash: thisHash,
      head_type: TYPE_MEMBER_ADMITTED,
      last_observed_tip: content.observed_pointer_tip,
    };
  });
  return { accepted: true, foldState: next };
}

// ---------------------------------------------------------------------------
// Predicate: membership-severed (M2 + M3 + invariant v)
// ---------------------------------------------------------------------------
/**
 * The exclusion record (§4.2). Severs P's membership; exclusion is
 * single-sided (any one party breaks membership) and fails SAFE toward
 * non-membership.
 *
 *   M3 (pointer-flip / withdrawn): MUST carry observed_pointer_tip +
 *      observed_names_this_ecosystem === false as re-verifiable evidence.
 *      A sever whose cited evidence STILL names E (observed_names_this_
 *      ecosystem !== false) is REJECTED — anti-malicious-eviction.
 *   evicted: owner-class single-sided act, NO P-evidence required (and
 *      MUST NOT carry it — the field allowlist permits the fields, but the
 *      reason-specific check below forbids the evidence boolean being TRUE
 *      and requires an owner signer).
 *   M2: supersedes_ref MUST equal the current admitted head; severing a
 *      non-member / stale head forks the chain and is rejected.
 */
function foldMembershipSevered(record, ctx) {
  const foldState = ctx.foldState || { trustRoot: null };
  const content = record.content;
  if (!content || typeof content !== "object") {
    return reject(foldState, "membership-severed: content missing");
  }
  const allowErr = checkFieldAllowlist(TYPE_MEMBERSHIP_SEVERED, content);
  if (allowErr) return reject(foldState, allowErr);

  if (typeof content.project_id !== "string" || !content.project_id) {
    return reject(
      foldState,
      "membership-severed: project_id must be a non-empty string",
    );
  }
  if (!SEVER_REASONS.has(content.reason)) {
    return reject(
      foldState,
      `membership-severed: reason must be one of ${[...SEVER_REASONS].join(" | ")} (got '${content.reason}')`,
    );
  }
  if (typeof content.supersedes_ref !== "string" || !content.supersedes_ref) {
    return reject(
      foldState,
      "membership-severed: supersedes_ref must be the non-empty hash of the admitted state-head it severs",
    );
  }

  if (
    content.reason === SEVER_REASON_POINTER_FLIP ||
    content.reason === SEVER_REASON_WITHDRAWN
  ) {
    // M3 — re-verifiable evidence MUST be present AND MUST attest the tip
    // no longer names E. A sever whose evidence still names E (true) or
    // omits the boolean is rejected (anti-malicious-eviction).
    if (
      typeof content.observed_pointer_tip !== "string" ||
      !content.observed_pointer_tip
    ) {
      return reject(
        foldState,
        `membership-severed (M3): reason '${content.reason}' MUST carry observed_pointer_tip evidence`,
      );
    }
    if (content.observed_names_this_ecosystem !== false) {
      return reject(
        foldState,
        `membership-severed (M3, anti-malicious-eviction): reason '${content.reason}' evidence observed_names_this_ecosystem must be false (a sever whose cited evidence still names E is rejected)`,
      );
    }
  } else {
    // evicted — owner-class single-sided exclusion (§4.2). No P-evidence:
    // the evidence boolean MUST NOT assert a P-pointer state, and the
    // signer MUST be owner-class.
    if (Object.prototype.hasOwnProperty.call(content, "observed_pointer_tip")) {
      return reject(
        foldState,
        "membership-severed: reason 'evicted' is single-sided (owner act) and MUST NOT carry observed_pointer_tip P-evidence",
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(
        content,
        "observed_names_this_ecosystem",
      )
    ) {
      return reject(
        foldState,
        "membership-severed: reason 'evicted' MUST NOT carry observed_names_this_ecosystem (no P-evidence)",
      );
    }
    const role = resolvePersonRole(ctx.roster, record.verified_id);
    if (role !== "owner") {
      return reject(
        foldState,
        `membership-severed: reason 'evicted' requires an owner-class signer (got role '${role || "unresolved"}', §4.2)`,
      );
    }
  }

  // M2 — supersede the current admitted head.
  const mr = foldState.memberRegistry || { genesis: null, projects: {} };
  const current = (mr.projects || {})[content.project_id];
  if (!current) {
    return reject(
      foldState,
      `membership-severed (M2): project '${content.project_id}' has no membership state-head to sever`,
    );
  }
  if (current.head_hash !== content.supersedes_ref) {
    return reject(
      foldState,
      `membership-severed (M2): supersedes_ref '${content.supersedes_ref}' does not match project '${content.project_id}' current head '${current.head_hash}' (membership-chain fork)`,
    );
  }
  if (current.state !== "member") {
    return reject(
      foldState,
      `membership-severed (M2): cannot sever project '${content.project_id}' — head state is '${current.state}', not an active membership`,
    );
  }

  const thisHash = recordContentHash(record);
  const next = extendMemberRegistry(foldState, (m) => {
    m.projects[content.project_id] = {
      state: "severed",
      head_hash: thisHash,
      head_type: TYPE_MEMBERSHIP_SEVERED,
      reason: content.reason,
      last_observed_tip:
        content.reason === SEVER_REASON_EVICTED
          ? current.last_observed_tip || null
          : content.observed_pointer_tip,
    };
  });
  return { accepted: true, foldState: next };
}

// ---------------------------------------------------------------------------
// Predicate: reconciliation-attestation (§6.2 + invariant v)
// ---------------------------------------------------------------------------
/**
 * A fresh signed observation of P's pointer tip (§6.2). Evidence-bearing
 * (it cites P's signed pointer tip), NOT authority-bearing — so any signer
 * (including host_role: ci) may run reconciliation; the cited evidence is
 * the authority. The attestation does NOT itself change membership state
 * (the membership-severed record does); when observed_names_this_ecosystem
 * is false it is the TRIGGER for a sever, surfaced via an advisory the
 * E-loom sweep acts on. Here it updates the project's last-observed marker
 * (advisory) and never severs.
 */
function foldReconciliationAttestation(record, ctx) {
  const foldState = ctx.foldState || { trustRoot: null };
  const content = record.content;
  if (!content || typeof content !== "object") {
    return reject(foldState, "reconciliation-attestation: content missing");
  }
  const allowErr = checkFieldAllowlist(TYPE_RECONCILIATION, content);
  if (allowErr) return reject(foldState, allowErr);

  if (typeof content.project_id !== "string" || !content.project_id) {
    return reject(
      foldState,
      "reconciliation-attestation: project_id must be a non-empty string",
    );
  }
  if (
    typeof content.observed_pointer_tip !== "string" ||
    !content.observed_pointer_tip
  ) {
    return reject(
      foldState,
      "reconciliation-attestation: observed_pointer_tip must be a non-empty string",
    );
  }
  if (typeof content.observed_names_this_ecosystem !== "boolean") {
    return reject(
      foldState,
      "reconciliation-attestation: observed_names_this_ecosystem must be a boolean",
    );
  }
  if (typeof content.observed_at !== "string" || !content.observed_at) {
    return reject(
      foldState,
      "reconciliation-attestation: observed_at must be a non-empty timestamp string",
    );
  }

  const mr = foldState.memberRegistry || { genesis: null, projects: {} };
  const current = (mr.projects || {})[content.project_id];
  // An attestation for a project with no membership state is accepted but
  // inert (a bare observation); only a member's marker is updated.
  if (!current || current.state !== "member") {
    return { accepted: true, foldState };
  }
  const next = extendMemberRegistry(foldState, (m) => {
    m.projects[content.project_id] = Object.assign({}, current, {
      last_observed_tip: content.observed_pointer_tip,
      last_observed_at: content.observed_at,
      last_observed_names_this_ecosystem: content.observed_names_this_ecosystem,
    });
  });
  return { accepted: true, foldState: next };
}

// ---------------------------------------------------------------------------
// Predicate: registry-generation-rotation (§4.2 — monotonic + pin presence)
// ---------------------------------------------------------------------------
/**
 * Generation rotation (§4.2). Co-signed; carries the archive-tip pin the
 * §5 head verification reads. THIS predicate validates the STRUCTURAL
 * contract — monotonic generation increment, co-signers present,
 * archive_tip_pin present, owner-class primary signer. The LIVE archive-tip
 * verification is the MUST-5 / F51 reuse
 * (`archive-ref.js::verifyArchiveTipPin` (invoked from `fold-rule-9b.js`), §9) and is NOT re-implemented
 * here — a consumer wiring the rotation/archive path invokes that
 * already-shipped primitive against the observed archive ref.
 */
function foldRegistryGenerationRotation(record, ctx) {
  const foldState = ctx.foldState || { trustRoot: null };
  const content = record.content;
  if (!content || typeof content !== "object") {
    return reject(foldState, "registry-generation-rotation: content missing");
  }
  const allowErr = checkFieldAllowlist(TYPE_GENERATION_ROTATION, content);
  if (allowErr) return reject(foldState, allowErr);

  const mr = foldState.memberRegistry || { genesis: null, generation: null };
  if (!mr.genesis) {
    return reject(
      foldState,
      "registry-generation-rotation: no registry trust root established (genesis-anchor must precede rotation)",
    );
  }
  if (
    typeof content.from_generation !== "number" ||
    !Number.isInteger(content.from_generation)
  ) {
    return reject(
      foldState,
      "registry-generation-rotation: from_generation must be an integer",
    );
  }
  if (
    typeof content.to_generation !== "number" ||
    !Number.isInteger(content.to_generation)
  ) {
    return reject(
      foldState,
      "registry-generation-rotation: to_generation must be an integer",
    );
  }
  if (content.to_generation <= content.from_generation) {
    return reject(
      foldState,
      `registry-generation-rotation: to_generation (${content.to_generation}) must exceed from_generation (${content.from_generation}) — rotation is monotone`,
    );
  }
  if (content.from_generation !== mr.generation) {
    return reject(
      foldState,
      `registry-generation-rotation: from_generation (${content.from_generation}) does not match current generation (${mr.generation})`,
    );
  }
  if (typeof content.archive_tip_pin !== "string" || !content.archive_tip_pin) {
    return reject(
      foldState,
      "registry-generation-rotation: archive_tip_pin must be a non-empty string (the F51 archive-tip pin the §5 head verification reads)",
    );
  }
  if (!Array.isArray(content.co_signers) || content.co_signers.length === 0) {
    return reject(
      foldState,
      "registry-generation-rotation: co_signers must be a non-empty array (rotation is co-signed)",
    );
  }
  const role = resolvePersonRole(ctx.roster, record.verified_id);
  if (role !== "owner") {
    return reject(
      foldState,
      `registry-generation-rotation: primary signer role '${role || "unresolved"}' is not owner-class`,
    );
  }

  const next = extendMemberRegistry(foldState, (m) => {
    m.generation = content.to_generation;
  });
  return { accepted: true, foldState: next };
}

// ---------------------------------------------------------------------------
// M4 (fold-side): per-project membership state from a folded registry
// ---------------------------------------------------------------------------
/**
 * The "registry tip fold-to" half of the §5 proof-grade head (M4). Reads
 * the per-project membership state the predicates accreted into
 * folded.foldState.memberRegistry. Consumers (W3 `membership-head.js::
 * proveMembership`) call this AFTER fetching + folding the LIVE registry
 * ref tip, then cross-check P's CURRENT pointer tip (§5 step 2) before
 * firing. This function alone NEVER licenses a fire — it reports the
 * registry-side state only.
 *
 * @returns {{ member: boolean, state: string, head_hash?: string,
 *             head_type?: string, reason?: string|null,
 *             last_observed_tip?: string|null }}
 *   state ∈ "no-genesis" | "absent" | "member" | "severed".
 */
function computeMembershipState(folded, projectId) {
  const mr = folded && folded.foldState && folded.foldState.memberRegistry;
  if (!mr || !mr.genesis) {
    return { member: false, state: "no-genesis" };
  }
  const p = mr.projects && mr.projects[projectId];
  if (!p) {
    return { member: false, state: "absent" };
  }
  return {
    member: p.state === "member",
    state: p.state,
    head_hash: p.head_hash,
    head_type: p.head_type,
    reason: p.reason || null,
    last_observed_tip: p.last_observed_tip || null,
  };
}

module.exports = {
  // Predicates (registered in coordination-log.js::_registerM0Defaults).
  foldRegistryGenesisAnchor,
  foldMemberAdmitted,
  foldMembershipSevered,
  foldReconciliationAttestation,
  foldRegistryGenerationRotation,
  // M4 fold-side consumer query.
  computeMembershipState,
  // Record-type names + sever reasons (SSOT re-exported by member-registry.js).
  TYPE_GENESIS_ANCHOR,
  TYPE_MEMBER_ADMITTED,
  TYPE_RECONCILIATION,
  TYPE_MEMBERSHIP_SEVERED,
  TYPE_GENERATION_ROTATION,
  SEVER_REASON_POINTER_FLIP,
  SEVER_REASON_WITHDRAWN,
  SEVER_REASON_EVICTED,
  SEVER_REASONS,
  // Exposed for tests + the emit/registration sites.
  recordContentHash,
  resolvePersonRole,
  CONTENT_FIELD_ALLOWLIST,
};
