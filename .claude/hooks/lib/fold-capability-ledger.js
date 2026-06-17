/**
 * fold-capability-ledger — capability-lifecycle ledger fold predicates
 * (the §4.2 record types + dual code/artifact lineage projection + the W4
 * structural invariants).
 *
 * ECO-IMPL Wave 4, Shard W4-S1 (A2-T1). Companion to capability-ledger.js
 * (the record-namespace SSOT + signed-emit wrapper). Implements
 * `workspaces/ecosystem-operating-model/02-plans/08-capability-lifecycle.md`
 * §4.1 (substrate) + §4.2 (record types + dual lineage) + §7 (substrate
 * reuse); normative `specs/06 §5`.
 *
 * The capability ledger is a NEW record NAMESPACE on the SAME signed-append
 * + per-emitter-hash-chain substrate as the multi-operator coordination-log
 * (`multi-operator-coordination.md` §2) — sibling to the W2 member-registry
 * namespace. The inherited fold rules 1–3 (signature gate, per-emitter chain
 * integrity, fork detection) run in coordination-log.js::_foldLog BEFORE
 * these predicates dispatch, so a record reaching a predicate here has
 * already verified its signature + per-emitter chain. These predicates add
 * the CAPABILITY-LIFECYCLE-specific structural rules:
 *
 *   (i)   every emit type-checks against the registered fold dispatch — an
 *         unknown type is refused by coc-emit.js::emitSignedRecord BEFORE it
 *         reaches a predicate (the registration in coordination-log.js::
 *         _registerM0Defaults is what makes the dispatch exist). Enforced at
 *         the EMIT boundary, structurally surfaced here by the type→predicate
 *         registration map.
 *   (ii)  `rails-provisioned` precedes any `workaround-registered` for a
 *         project (§6 onboard-anchor) — a T0 `workaround-registered` with no
 *         prior folded `rails-provisioned` for that project is REJECTED at
 *         fold.
 *   (iii) `supersedes_when` two-stage binding SHAPE validated, never
 *         auto-bound (§4.2 F3-b): T1 stage `{ class, need_fingerprint }` OR
 *         terminal `external`; post-T3 `supersedes-rebind` →
 *         `{ capability_id, min_satisfying_version }`. The fold validates the
 *         SHAPE; it does NOT itself perform the binding/rebinding decision.
 *   (iv)  dual lineage tracked SEPARATELY — a `cascade-fired` names exactly
 *         ONE of `code|artifact`; the fold projects per-lineage so a
 *         code-only cascade never marks the artifact lineage cascaded (§4.2
 *         dual lineage).
 *   (v)   disclosure isolation (§6) — no record may carry another
 *         ecosystem's id; enforced structurally by a POSITIVE field allowlist
 *         per record type (mirror of fold-member-registry.js's allowlist
 *         shape, `cc-artifacts.md` Rule 10), so a smuggled foreign-ecosystem
 *         field is REJECTED at fold rather than stored.
 *
 * SCOPE BOUNDARY (load-bearing — NOT W4; these are W5):
 *   - NO retirement-FIRING fold (§4.4). The `retired` record TYPE + its shape
 *     are DEFINED and VALIDATED here, but a predicate here NEVER auto-fires a
 *     `retired`. A predicate accepts/rejects a record and updates lineage
 *     state; it never fires a retirement consequence.
 *   - The `dependency-edge` predicate IS the AUTHORITATIVE fold-side
 *     acyclicity backstop (HIGH-1): it shape-validates a `dependency-edge`
 *     AND rejects any edge that closes a cycle (deterministic fold-order
 *     forward-reachability), so the folded DAG is acyclic on every clone. The
 *     `capability-dag.js` registration gate (A2-T3a, W4-S4) is the OPTIMISTIC
 *     clone-local fast-path (rejects early to avoid lease churn + a bad emit)
 *     — NOT the authoritative defense; the cross-clone cycle (each side
 *     passing its clone-LOCAL gate against a stale fold) is caught HERE.
 *   - NO graduation transitive-closure multi-lease (§4.3 F4/closure loop) —
 *     the closure-ordered multi-lease is W5 A2-T3b, NOT built here.
 *   - NO §4.5 liveness/aging-query.
 *
 * Named residual (per `spec-accuracy.md` Rule 3 — surfaced, not silently
 * "handled"): the need-fingerprint COLLISION risk (§8 NEW-3) is a genuinely
 * OPEN residual of the fingerprint SCHEME, NOT caught at fold. Two distinct
 * needs that fingerprint alike mis-bind a `supersedes_when`; the fold treats
 * the fingerprint as opaque and cannot detect a collision. This file does
 * NOT claim to detect it.
 *
 * Style: CommonJS, zero-dep beyond coc-sign + node:crypto, matches sibling
 * fold-member-registry.js shape. Each predicate consumes the engine dispatch
 * ctx ({ foldState, roster, acceptedSoFar }) and returns
 * { accepted, foldState, reason? } per coordination-log.js::_foldLog. Per
 * zero-tolerance.md Rule 3: every rejection returns a typed reason; no silent
 * fallback.
 */

"use strict";

const crypto = require("crypto");
const { canonicalSerialize } = require("./coc-sign.js");

// ---------------------------------------------------------------------------
// Record-type names (the capability-ledger namespace, §4.2). Re-exported by
// capability-ledger.js as CAPABILITY_LEDGER_TYPES — single source here so the
// fold predicates and the emit/registration sites cannot drift.
// ---------------------------------------------------------------------------
const TYPE_RAILS_PROVISIONED = "rails-provisioned";
const TYPE_WORKAROUND_REGISTERED = "workaround-registered";
const TYPE_NEED_CLASSIFIED = "need-classified";
const TYPE_SUPERSEDES_REBIND = "supersedes-rebind";
const TYPE_NEED_ROUTED = "need-routed";
const TYPE_CAPABILITY_REGISTERED = "capability-registered";
const TYPE_DEPENDENCY_EDGE = "dependency-edge";
const TYPE_APPROVAL = "approval";
const TYPE_CASCADE_FIRED = "cascade-fired";
const TYPE_MIGRATED = "migrated";
const TYPE_RETIRED = "retired";
// §4.2 names the S3 sever record `membership-severed` conceptually. The W2
// member-registry namespace (fold-member-registry.js) ALREADY owns the wire
// type string `"membership-severed"` in the SHARED default fold engine, with
// a DIFFERENT content shape (project_id / reason / supersedes_ref). Two
// predicates cannot share one registry key, so the capability-ledger's S3
// sever record uses the namespaced wire type `"ledger-membership-severed"` —
// the conceptual §4.2 name is preserved in this constant + the predicate
// docstrings; only the on-the-wire dispatch key is disambiguated. (Per
// framework-first.md §7: shared substrate, distinct namespaces — the
// namespacing is at the type-string level, exactly as the separate .jsonl
// logs are namespaced at the file level.)
const TYPE_MEMBERSHIP_SEVERED = "ledger-membership-severed";

const CAPABILITY_LEDGER_TYPES = new Set([
  TYPE_RAILS_PROVISIONED,
  TYPE_WORKAROUND_REGISTERED,
  TYPE_NEED_CLASSIFIED,
  TYPE_SUPERSEDES_REBIND,
  TYPE_NEED_ROUTED,
  TYPE_CAPABILITY_REGISTERED,
  TYPE_DEPENDENCY_EDGE,
  TYPE_APPROVAL,
  TYPE_CASCADE_FIRED,
  TYPE_MIGRATED,
  TYPE_RETIRED,
  TYPE_MEMBERSHIP_SEVERED,
]);

// §4.2 / §3.1 need classes — the closed set the classifier may resolve to.
const NEED_CLASS_CAPABILITY = "capability";
const NEED_CLASS_BUG = "bug";
const NEED_CLASS_PRODUCT_TWEAK = "product-tweak";
const NEED_CLASS_METHODOLOGY = "methodology";
const NEED_CLASSES = new Set([
  NEED_CLASS_CAPABILITY,
  NEED_CLASS_BUG,
  NEED_CLASS_PRODUCT_TWEAK,
  NEED_CLASS_METHODOLOGY,
]);

// §4.2 dual-lineage discriminator. A `cascade-fired` names EXACTLY ONE
// (invariant iv).
const LINEAGE_CODE = "code";
const LINEAGE_ARTIFACT = "artifact";
const LINEAGES = new Set([LINEAGE_CODE, LINEAGE_ARTIFACT]);

// §3.2 `supersedes_when` terminal stage marker (S1 build:null / external).
const SUPERSEDES_TERMINAL_EXTERNAL = "external";
// §3 / §3.1 T0 pre-classification placeholder.
const SUPERSEDES_PENDING_CLASSIFICATION = "pending-classification";

// Positive field allowlists per record type (invariant v, disclosure
// isolation via cc-artifacts.md Rule 10). A record whose content carries ANY
// key outside its allowlist is REJECTED at fold — this is the STRUCTURAL
// defense that a destination-ecosystem id (or any other smuggled field) can
// never be STORED in the ledger. The ledger is per-ECOSYSTEM (§4.1); NO
// record type carries an `ecosystem_id` field (unlike the member-registry's
// genesis-anchor, which roots ITS OWN ecosystem) — a ledger record naming any
// ecosystem id is a cross-ecosystem leak the allowlist rejects.
const CONTENT_FIELD_ALLOWLIST = {
  [TYPE_RAILS_PROVISIONED]: new Set([
    "project",
    "provider",
    "pipeline_ref",
    "genesis_anchor_ref",
  ]),
  [TYPE_WORKAROUND_REGISTERED]: new Set([
    "project",
    "need_fingerprint",
    "workaround_ref",
    "supersedes_when",
  ]),
  [TYPE_NEED_CLASSIFIED]: new Set([
    "need_fingerprint",
    "class",
    "confirmed_by",
  ]),
  [TYPE_SUPERSEDES_REBIND]: new Set([
    "need_fingerprint",
    "capability_id",
    "min_satisfying_version",
  ]),
  [TYPE_NEED_ROUTED]: new Set([
    "need_fingerprint",
    "route_target",
    "routed_class",
  ]),
  [TYPE_CAPABILITY_REGISTERED]: new Set([
    "capability_id",
    "code_lineage_id",
    "artifact_lineage_id",
    "depends_on",
  ]),
  [TYPE_DEPENDENCY_EDGE]: new Set(["from_capability", "to_capability"]),
  [TYPE_APPROVAL]: new Set([
    "capability_id",
    "operator_seat",
    "judge_seat",
    "self_attest_marker",
  ]),
  [TYPE_CASCADE_FIRED]: new Set([
    "capability_id",
    "member_project",
    "lineage",
    "version_or_sync_ref",
  ]),
  [TYPE_MIGRATED]: new Set(["member_project", "capability_id"]),
  [TYPE_RETIRED]: new Set([
    "member_project",
    "workaround_ref",
    "by_capability_id",
  ]),
  [TYPE_MEMBERSHIP_SEVERED]: new Set([
    "member_project",
    "severed_at",
    "pointer_flip_ref",
  ]),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Content hash of a record — byte-identical to coordination-log.js::
 * _canonicalHash (sha256 of canonicalSerialize(record minus sig)). Replicated
 * locally (not imported from coordination-log.js) to keep this module free of
 * a require cycle — coordination-log.js requires THIS file to register the
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
      return `disclosure-isolation (invariant v): '${recordType}' content carries disallowed field '${key}' (only ${[...allow].join(", ")} permitted; a foreign-ecosystem id or any unexpected field is structurally rejected, never stored)`;
    }
  }
  return null;
}

/**
 * Lazily clone-and-extend the foldState.capabilityLedger sub-tree. Mirrors
 * fold-member-registry.js::extendMemberRegistry. The sub-tree is namespaced
 * so it never collides with the coordination-log's own foldState or the
 * member-registry sub-tree.
 */
function extendCapabilityLedger(foldState, mutator) {
  const prev = (foldState && foldState.capabilityLedger) || {
    rails: {}, // project → { provider, pipeline_ref, genesis_anchor_ref }
    workarounds: {}, // workaround_ref → { project, need_fingerprint, supersedes_when, retired }
    needs: {}, // need_fingerprint → { class, confirmed_by, rebind? }
    capabilities: {}, // capability_id → { code_lineage_id, artifact_lineage_id, cascades }
    edges: [], // [{ from_capability, to_capability }]
  };
  const next = {
    rails: Object.assign({}, prev.rails),
    workarounds: Object.assign({}, prev.workarounds),
    needs: Object.assign({}, prev.needs),
    capabilities: Object.assign({}, prev.capabilities),
    edges: prev.edges.slice(),
  };
  mutator(next);
  return Object.assign({}, foldState, { capabilityLedger: next });
}

function reject(foldState, reason) {
  return { accepted: false, foldState, reason };
}

/**
 * Shape-validate a `supersedes_when` value (invariant iii). The fold
 * validates the SHAPE the record claims; it does NOT bind/rebind. Returns
 * null on a valid shape, or a typed reason string. Accepted shapes:
 *   - the T0 placeholder string "pending-classification" (§3 T0)
 *   - the terminal string "external" (§5 S1 build:null)
 *   - the T1 stage object { class ∈ NEED_CLASSES, need_fingerprint: string }
 *   - the post-T3 stage object { capability_id: string,
 *     min_satisfying_version: string }
 * Any other shape (e.g. a partial object, a class outside the closed set, a
 * mix of T1 + post-T3 fields) is rejected.
 */
function validateSupersedesWhenShape(sw) {
  if (typeof sw === "string") {
    if (
      sw === SUPERSEDES_PENDING_CLASSIFICATION ||
      sw === SUPERSEDES_TERMINAL_EXTERNAL
    ) {
      return null;
    }
    return `supersedes_when string must be '${SUPERSEDES_PENDING_CLASSIFICATION}' (T0) or '${SUPERSEDES_TERMINAL_EXTERNAL}' (terminal, S1) — got '${sw}'`;
  }
  if (sw === null || typeof sw !== "object" || Array.isArray(sw)) {
    return "supersedes_when must be a string (pending-classification|external) or a stage object";
  }
  const keys = Object.keys(sw).sort();
  const isT1 =
    keys.length === 2 && keys[0] === "class" && keys[1] === "need_fingerprint";
  const isPostT3 =
    keys.length === 2 &&
    keys[0] === "capability_id" &&
    keys[1] === "min_satisfying_version";
  if (isT1) {
    if (!NEED_CLASSES.has(sw.class)) {
      return `supersedes_when T1 stage class must be one of ${[...NEED_CLASSES].join(" | ")} (got '${sw.class}')`;
    }
    if (typeof sw.need_fingerprint !== "string" || !sw.need_fingerprint) {
      return "supersedes_when T1 stage need_fingerprint must be a non-empty string";
    }
    return null;
  }
  if (isPostT3) {
    if (typeof sw.capability_id !== "string" || !sw.capability_id) {
      return "supersedes_when post-T3 stage capability_id must be a non-empty string";
    }
    if (
      typeof sw.min_satisfying_version !== "string" ||
      !sw.min_satisfying_version
    ) {
      return "supersedes_when post-T3 stage min_satisfying_version must be a non-empty string";
    }
    return null;
  }
  return `supersedes_when object must be EXACTLY the T1 stage {class, need_fingerprint} OR the post-T3 stage {capability_id, min_satisfying_version} — got keys [${keys.join(", ")}]`;
}

// ---------------------------------------------------------------------------
// Predicate: rails-provisioned (§4.2 T-onboard anchor)
// ---------------------------------------------------------------------------
/**
 * The T-onboard anchor (§3 / §6 INFRA). Records that a project's
 * provider+pipeline rails are provisioned. Every `workaround-registered`
 * (T0) presupposes a `rails-provisioned` for its project (invariant ii). The
 * deep owner-quorum genesis bind is the reused INFRA genesis-ceremony's job
 * (§4.1 / §7 reuse) — here we validate the field shape + idempotent record.
 */
function foldRailsProvisioned(record, ctx) {
  const foldState = ctx.foldState || { trustRoot: null };
  const content = record.content;
  if (!content || typeof content !== "object") {
    return reject(foldState, "rails-provisioned: content missing");
  }
  const allowErr = checkFieldAllowlist(TYPE_RAILS_PROVISIONED, content);
  if (allowErr) return reject(foldState, allowErr);

  if (typeof content.project !== "string" || !content.project) {
    return reject(
      foldState,
      "rails-provisioned: project must be a non-empty string",
    );
  }
  if (typeof content.provider !== "string" || !content.provider) {
    return reject(
      foldState,
      "rails-provisioned: provider must be a non-empty string",
    );
  }
  if (typeof content.pipeline_ref !== "string" || !content.pipeline_ref) {
    return reject(
      foldState,
      "rails-provisioned: pipeline_ref must be a non-empty string",
    );
  }
  if (
    typeof content.genesis_anchor_ref !== "string" ||
    !content.genesis_anchor_ref
  ) {
    return reject(
      foldState,
      "rails-provisioned: genesis_anchor_ref must be a non-empty string",
    );
  }

  const next = extendCapabilityLedger(foldState, (cl) => {
    cl.rails[content.project] = {
      provider: content.provider,
      pipeline_ref: content.pipeline_ref,
      genesis_anchor_ref: content.genesis_anchor_ref,
    };
  });
  return { accepted: true, foldState: next };
}

// ---------------------------------------------------------------------------
// Predicate: workaround-registered (T0, invariant ii + iii)
// ---------------------------------------------------------------------------
/**
 * The consultant's T0 signal (§3 T0). REJECTED when:
 *   (ii) no `rails-provisioned` has folded for content.project — the rails
 *        precede the lifecycle (§6 onboard-anchor); a T0 with no rails is a
 *        forgery/ordering surface and fails closed.
 *   (iii) supersedes_when shape is invalid (validateSupersedesWhenShape).
 * The fold validates the SHAPE; it does NOT itself bind the workaround to a
 * capability (that is the T1 need-classified / post-T3 supersedes-rebind
 * lifecycle, which the W5 retirement fold reads — out of scope here).
 */
function foldWorkaroundRegistered(record, ctx) {
  const foldState = ctx.foldState || { trustRoot: null };
  const content = record.content;
  if (!content || typeof content !== "object") {
    return reject(foldState, "workaround-registered: content missing");
  }
  const allowErr = checkFieldAllowlist(TYPE_WORKAROUND_REGISTERED, content);
  if (allowErr) return reject(foldState, allowErr);

  if (typeof content.project !== "string" || !content.project) {
    return reject(
      foldState,
      "workaround-registered: project must be a non-empty string",
    );
  }
  if (
    typeof content.need_fingerprint !== "string" ||
    !content.need_fingerprint
  ) {
    return reject(
      foldState,
      "workaround-registered: need_fingerprint must be a non-empty string",
    );
  }
  if (typeof content.workaround_ref !== "string" || !content.workaround_ref) {
    return reject(
      foldState,
      "workaround-registered: workaround_ref must be a non-empty string",
    );
  }
  const swErr = validateSupersedesWhenShape(content.supersedes_when);
  if (swErr) {
    return reject(foldState, `workaround-registered: ${swErr}`);
  }

  // Invariant (ii): rails MUST precede the workaround for this project.
  const cl = foldState.capabilityLedger || { rails: {} };
  if (!cl.rails || !cl.rails[content.project]) {
    return reject(
      foldState,
      `workaround-registered (invariant ii, §6 onboard-anchor): no rails-provisioned folded for project '${content.project}' — the INFRA rails precede the lifecycle; a T0 workaround with no prior rails is rejected`,
    );
  }

  const next = extendCapabilityLedger(foldState, (c) => {
    c.workarounds[content.workaround_ref] = {
      project: content.project,
      need_fingerprint: content.need_fingerprint,
      supersedes_when: content.supersedes_when,
      retired: false,
    };
  });
  return { accepted: true, foldState: next };
}

// ---------------------------------------------------------------------------
// Predicate: need-classified (T1, §3.1 / §4.2)
// ---------------------------------------------------------------------------
/**
 * The classifier's T1 resolution (§3.1). SHAPE-validated here: class ∈ the
 * closed NEED_CLASSES set, confirmed_by is `system-auto` OR a verified_id
 * string (the non-consultant ratifier). The F1 distinctness binding (ratifier
 * ≠ T0 signer, ratifier role ∈ {capability-engineer, platform-engineer}) is
 * the A2-T2 classifier's job (W4-S3) — this predicate records the resolution
 * shape, it does NOT itself decide the class.
 */
function foldNeedClassified(record, ctx) {
  const foldState = ctx.foldState || { trustRoot: null };
  const content = record.content;
  if (!content || typeof content !== "object") {
    return reject(foldState, "need-classified: content missing");
  }
  const allowErr = checkFieldAllowlist(TYPE_NEED_CLASSIFIED, content);
  if (allowErr) return reject(foldState, allowErr);

  if (
    typeof content.need_fingerprint !== "string" ||
    !content.need_fingerprint
  ) {
    return reject(
      foldState,
      "need-classified: need_fingerprint must be a non-empty string",
    );
  }
  if (!NEED_CLASSES.has(content.class)) {
    return reject(
      foldState,
      `need-classified: class must be one of ${[...NEED_CLASSES].join(" | ")} (got '${content.class}')`,
    );
  }
  if (typeof content.confirmed_by !== "string" || !content.confirmed_by) {
    return reject(
      foldState,
      "need-classified: confirmed_by must be 'system-auto' or a ratifier verified_id string",
    );
  }

  const next = extendCapabilityLedger(foldState, (cl) => {
    const prev = cl.needs[content.need_fingerprint] || {};
    cl.needs[content.need_fingerprint] = Object.assign({}, prev, {
      class: content.class,
      confirmed_by: content.confirmed_by,
    });
  });
  return { accepted: true, foldState: next };
}

// ---------------------------------------------------------------------------
// Predicate: supersedes-rebind (post-T3, §4.2 F3-b, invariant iii)
// ---------------------------------------------------------------------------
/**
 * The post-T3 rebind (§4.2 F3-b). SHAPE-validated: need_fingerprint +
 * capability_id + min_satisfying_version (a CODE-lineage version — the
 * artifact lineage has no monotonic version, F3-a). Records the rebind in
 * folded state for the W5 retirement gate to read; it does NOT itself fire
 * any retirement (scope boundary).
 */
function foldSupersedesRebind(record, ctx) {
  const foldState = ctx.foldState || { trustRoot: null };
  const content = record.content;
  if (!content || typeof content !== "object") {
    return reject(foldState, "supersedes-rebind: content missing");
  }
  const allowErr = checkFieldAllowlist(TYPE_SUPERSEDES_REBIND, content);
  if (allowErr) return reject(foldState, allowErr);

  if (
    typeof content.need_fingerprint !== "string" ||
    !content.need_fingerprint
  ) {
    return reject(
      foldState,
      "supersedes-rebind: need_fingerprint must be a non-empty string",
    );
  }
  if (typeof content.capability_id !== "string" || !content.capability_id) {
    return reject(
      foldState,
      "supersedes-rebind: capability_id must be a non-empty string",
    );
  }
  if (
    typeof content.min_satisfying_version !== "string" ||
    !content.min_satisfying_version
  ) {
    return reject(
      foldState,
      "supersedes-rebind: min_satisfying_version must be a non-empty string (a code-lineage version, F3-a)",
    );
  }

  const next = extendCapabilityLedger(foldState, (cl) => {
    const prev = cl.needs[content.need_fingerprint] || {};
    cl.needs[content.need_fingerprint] = Object.assign({}, prev, {
      rebind: {
        capability_id: content.capability_id,
        min_satisfying_version: content.min_satisfying_version,
      },
    });
  });
  return { accepted: true, foldState: next };
}

// ---------------------------------------------------------------------------
// Predicate: need-routed (T2, §4.2)
// ---------------------------------------------------------------------------
/**
 * The T2 routing commitment (§4.2). routed_class ∈ NEED_CLASSES; route_target
 * is a non-empty string. Routing commits, no OR-escape (`specs/06` §5.1) —
 * the no-OR discipline is the routing CALLER's job; here we shape-validate.
 */
function foldNeedRouted(record, ctx) {
  const foldState = ctx.foldState || { trustRoot: null };
  const content = record.content;
  if (!content || typeof content !== "object") {
    return reject(foldState, "need-routed: content missing");
  }
  const allowErr = checkFieldAllowlist(TYPE_NEED_ROUTED, content);
  if (allowErr) return reject(foldState, allowErr);

  if (
    typeof content.need_fingerprint !== "string" ||
    !content.need_fingerprint
  ) {
    return reject(
      foldState,
      "need-routed: need_fingerprint must be a non-empty string",
    );
  }
  if (typeof content.route_target !== "string" || !content.route_target) {
    return reject(
      foldState,
      "need-routed: route_target must be a non-empty string",
    );
  }
  if (!NEED_CLASSES.has(content.routed_class)) {
    return reject(
      foldState,
      `need-routed: routed_class must be one of ${[...NEED_CLASSES].join(" | ")} (got '${content.routed_class}')`,
    );
  }
  return { accepted: true, foldState };
}

// ---------------------------------------------------------------------------
// Predicate: capability-registered (T3, §4.2 — mints the dual lineage)
// ---------------------------------------------------------------------------
/**
 * The T3 capability registration (§4.2). MINTS both `code_lineage_id` and
 * `artifact_lineage_id` (the dual lineage, §4.2 / `specs/06` §5(b)) — the
 * fold projects per-lineage cascade state SEPARATELY from this point on
 * (invariant iv). `depends_on[]` is an array of capability_id strings
 * (build→build deps); the acyclicity gate over them is A2-T3a's job, NOT
 * here. A second registration of the same capability_id is REJECTED
 * (first-wins; a capability's lineage ids are immutable).
 */
function foldCapabilityRegistered(record, ctx) {
  const foldState = ctx.foldState || { trustRoot: null };
  const content = record.content;
  if (!content || typeof content !== "object") {
    return reject(foldState, "capability-registered: content missing");
  }
  const allowErr = checkFieldAllowlist(TYPE_CAPABILITY_REGISTERED, content);
  if (allowErr) return reject(foldState, allowErr);

  if (typeof content.capability_id !== "string" || !content.capability_id) {
    return reject(
      foldState,
      "capability-registered: capability_id must be a non-empty string",
    );
  }
  if (typeof content.code_lineage_id !== "string" || !content.code_lineage_id) {
    return reject(
      foldState,
      "capability-registered: code_lineage_id must be a non-empty string",
    );
  }
  if (
    typeof content.artifact_lineage_id !== "string" ||
    !content.artifact_lineage_id
  ) {
    return reject(
      foldState,
      "capability-registered: artifact_lineage_id must be a non-empty string",
    );
  }
  if (!Array.isArray(content.depends_on)) {
    return reject(
      foldState,
      "capability-registered: depends_on must be an array of capability_id strings",
    );
  }
  for (const dep of content.depends_on) {
    if (typeof dep !== "string" || !dep) {
      return reject(
        foldState,
        "capability-registered: every depends_on entry must be a non-empty capability_id string",
      );
    }
  }

  const cl = foldState.capabilityLedger || { capabilities: {} };
  if (cl.capabilities && cl.capabilities[content.capability_id]) {
    return reject(
      foldState,
      `capability-registered: capability '${content.capability_id}' already registered (first-wins; lineage ids are immutable)`,
    );
  }

  const next = extendCapabilityLedger(foldState, (c) => {
    c.capabilities[content.capability_id] = {
      code_lineage_id: content.code_lineage_id,
      artifact_lineage_id: content.artifact_lineage_id,
      depends_on: content.depends_on.slice(),
      // Dual-lineage projection, tracked SEPARATELY (invariant iv).
      // cascades[member_project] = { code: <ref|null>, artifact: <ref|null> }
      cascades: {},
    };
  });
  return { accepted: true, foldState: next };
}

// ---------------------------------------------------------------------------
// Predicate: dependency-edge (§4.3 — SHAPE + AUTHORITATIVE acyclicity backstop)
// ---------------------------------------------------------------------------
/**
 * A build→build dependency edge (§4.3). SHAPE-validated AND acyclicity-checked.
 * This predicate is the AUTHORITATIVE fold-side acyclicity backstop (HIGH-1):
 * before appending `from→to` to the accepted DAG, it computes whether
 * `to_capability` can ALREADY reach `from_capability` over the existing
 * `cl.edges` (deterministic forward-reachability / BFS). If yes, adding the
 * edge would close a cycle, so the edge is REJECTED at fold and never enters
 * the accepted DAG (it stays in the coordination log as history).
 *
 * Determinism is the whole point: the coordination-log fold processes records
 * in one deterministic total order, so ALL clones folding the same record set
 * reject the SAME cycle-closing edge (whichever closes a cycle in fold order).
 * This makes the cross-clone case detection-eventually-SOUND and
 * cross-clone-CONSISTENT — the cross-clone cycle (operator A on clone-1 emits
 * A→B; operator B on clone-2 emits B→A, each passing its clone-LOCAL
 * registration gate against a stale fold) is caught HERE, where nothing else
 * catches it: the on-disk lease is clone-local, and the `capability-dag.js`
 * registration gate is the OPTIMISTIC clone-local fast-path (rejects early,
 * avoids lease churn + a bad emit) — NOT the authoritative defense.
 *
 * The self-loop (from===to) reject below is a distinct malformed-SHAPE check
 * (a one-edge cycle is a malformed edge), kept separate from the multi-edge
 * reachability backstop.
 *
 * Out of W4 scope: the graduation transitive-closure MULTI-lease (W5 A2-T3b)
 * is NOT built here — this backstop is the single-edge fold-time acyclicity
 * guarantee, not the closure-ordered multi-lease.
 */
function foldDependencyEdge(record, ctx) {
  const foldState = ctx.foldState || { trustRoot: null };
  const content = record.content;
  if (!content || typeof content !== "object") {
    return reject(foldState, "dependency-edge: content missing");
  }
  const allowErr = checkFieldAllowlist(TYPE_DEPENDENCY_EDGE, content);
  if (allowErr) return reject(foldState, allowErr);

  if (typeof content.from_capability !== "string" || !content.from_capability) {
    return reject(
      foldState,
      "dependency-edge: from_capability must be a non-empty string",
    );
  }
  if (typeof content.to_capability !== "string" || !content.to_capability) {
    return reject(
      foldState,
      "dependency-edge: to_capability must be a non-empty string",
    );
  }
  if (content.from_capability === content.to_capability) {
    return reject(
      foldState,
      "dependency-edge: from_capability === to_capability (a self-loop is a malformed edge; the multi-edge acyclicity gate is A2-T3a's job)",
    );
  }

  // Authoritative acyclicity backstop (HIGH-1). Adding `from→to` closes a
  // cycle iff `to` can ALREADY reach `from` over the existing accepted edges.
  // Deterministic forward-reachability BFS from `to`.
  const existingEdges =
    (foldState.capabilityLedger && foldState.capabilityLedger.edges) || [];
  if (
    edgeClosesCycle(
      existingEdges,
      content.from_capability,
      content.to_capability,
    )
  ) {
    return reject(
      foldState,
      `dependency-edge: closes a cycle ('${content.to_capability}' already reaches '${content.from_capability}') — fold-time acyclicity backstop; the edge is recorded in the log as history but never enters the accepted DAG`,
    );
  }

  const next = extendCapabilityLedger(foldState, (cl) => {
    cl.edges.push({
      from_capability: content.from_capability,
      to_capability: content.to_capability,
    });
  });
  return { accepted: true, foldState: next };
}

/**
 * Forward-reachability test for the acyclicity backstop. Returns true iff
 * adding the edge `from→to` would close a cycle — i.e. `to` can ALREADY reach
 * `from` over `edges` (so the new edge completes a path back to `to`).
 * Deterministic BFS over the adjacency list built from `edges` in array order;
 * the same `edges` set yields the same verdict on every clone.
 */
function edgeClosesCycle(edges, from, to) {
  // BFS from `to`; if we reach `from`, the new edge from→to closes a cycle.
  const adjacency = new Map();
  for (const e of edges) {
    if (!adjacency.has(e.from_capability)) {
      adjacency.set(e.from_capability, []);
    }
    adjacency.get(e.from_capability).push(e.to_capability);
  }
  const visited = new Set();
  const queue = [to];
  visited.add(to);
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === from) return true;
    const neighbors = adjacency.get(node) || [];
    for (const next of neighbors) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Predicate: approval (T4, §4.2 two-seat — SHAPE only)
// ---------------------------------------------------------------------------
/**
 * The T4 two-seat checkpoint (§4.2 / §6). SHAPE-validated: capability_id +
 * operator_seat, AND EXACTLY ONE of { judge_seat (N≥2) | self_attest_marker
 * (N=1) }. The distinctness check (judge_seat.person_id ≠ author at N≥2) is
 * the approval CALLER's job (mirroring multi-operator MUST-7's N=1 handling)
 * — here we validate the structural exclusivity.
 */
function foldApproval(record, ctx) {
  const foldState = ctx.foldState || { trustRoot: null };
  const content = record.content;
  if (!content || typeof content !== "object") {
    return reject(foldState, "approval: content missing");
  }
  const allowErr = checkFieldAllowlist(TYPE_APPROVAL, content);
  if (allowErr) return reject(foldState, allowErr);

  if (typeof content.capability_id !== "string" || !content.capability_id) {
    return reject(
      foldState,
      "approval: capability_id must be a non-empty string",
    );
  }
  if (content.operator_seat === undefined || content.operator_seat === null) {
    return reject(foldState, "approval: operator_seat must be present");
  }
  const hasJudge =
    content.judge_seat !== undefined && content.judge_seat !== null;
  const hasSelfAttest =
    content.self_attest_marker !== undefined &&
    content.self_attest_marker !== null;
  if (hasJudge === hasSelfAttest) {
    return reject(
      foldState,
      "approval: EXACTLY ONE of judge_seat (N≥2) or self_attest_marker (N=1) must be present (§4.2 two-seat)",
    );
  }
  return { accepted: true, foldState };
}

// ---------------------------------------------------------------------------
// Predicate: cascade-fired (T5, §4.2 — dual-lineage projection, invariant iv)
// ---------------------------------------------------------------------------
/**
 * The T5 cascade record (§4.2). The dual-lineage projection's WRITE site
 * (invariant iv): names EXACTLY ONE lineage ∈ {code, artifact}; the fold
 * advances ONLY that lineage's marker for (capability_id, member_project), so
 * a code-only cascade NEVER marks the artifact lineage cascaded. REJECTED
 * when the capability is not yet registered (a cascade-fired for an unknown
 * capability has no lineage to project onto).
 */
function foldCascadeFired(record, ctx) {
  const foldState = ctx.foldState || { trustRoot: null };
  const content = record.content;
  if (!content || typeof content !== "object") {
    return reject(foldState, "cascade-fired: content missing");
  }
  const allowErr = checkFieldAllowlist(TYPE_CASCADE_FIRED, content);
  if (allowErr) return reject(foldState, allowErr);

  if (typeof content.capability_id !== "string" || !content.capability_id) {
    return reject(
      foldState,
      "cascade-fired: capability_id must be a non-empty string",
    );
  }
  if (typeof content.member_project !== "string" || !content.member_project) {
    return reject(
      foldState,
      "cascade-fired: member_project must be a non-empty string",
    );
  }
  if (!LINEAGES.has(content.lineage)) {
    return reject(
      foldState,
      `cascade-fired (invariant iv): lineage must name EXACTLY ONE of ${[...LINEAGES].join(" | ")} (got '${content.lineage}')`,
    );
  }
  if (
    typeof content.version_or_sync_ref !== "string" ||
    !content.version_or_sync_ref
  ) {
    return reject(
      foldState,
      "cascade-fired: version_or_sync_ref must be a non-empty string (a semver pin for code, a /sync ref for artifact)",
    );
  }

  const cl = foldState.capabilityLedger || { capabilities: {} };
  const cap = cl.capabilities && cl.capabilities[content.capability_id];
  if (!cap) {
    return reject(
      foldState,
      `cascade-fired: capability '${content.capability_id}' is not registered (no dual lineage to project onto; a cascade-fired presupposes capability-registered)`,
    );
  }

  const next = extendCapabilityLedger(foldState, (c) => {
    const prevCap = c.capabilities[content.capability_id];
    const cascades = Object.assign({}, prevCap.cascades);
    const prevMember = cascades[content.member_project] || {
      code: null,
      artifact: null,
    };
    // Advance ONLY the named lineage — the SEPARATE-tracking invariant (iv).
    const nextMember = Object.assign({}, prevMember, {
      [content.lineage]: content.version_or_sync_ref,
    });
    cascades[content.member_project] = nextMember;
    c.capabilities[content.capability_id] = Object.assign({}, prevCap, {
      cascades,
    });
  });
  return { accepted: true, foldState: next };
}

// ---------------------------------------------------------------------------
// Predicate: migrated (T6, §4.2 — SHAPE only)
// ---------------------------------------------------------------------------
/**
 * The T6 migration record (§4.2). The project picked up the cascade on its
 * own cadence. SHAPE-validated + recorded for the W5 retirement gate (§4.4
 * condition 3) to read. Does NOT itself fire any retirement (scope boundary).
 */
function foldMigrated(record, ctx) {
  const foldState = ctx.foldState || { trustRoot: null };
  const content = record.content;
  if (!content || typeof content !== "object") {
    return reject(foldState, "migrated: content missing");
  }
  const allowErr = checkFieldAllowlist(TYPE_MIGRATED, content);
  if (allowErr) return reject(foldState, allowErr);

  if (typeof content.member_project !== "string" || !content.member_project) {
    return reject(
      foldState,
      "migrated: member_project must be a non-empty string",
    );
  }
  if (typeof content.capability_id !== "string" || !content.capability_id) {
    return reject(
      foldState,
      "migrated: capability_id must be a non-empty string",
    );
  }

  const next = extendCapabilityLedger(foldState, (cl) => {
    const cap = cl.capabilities[content.capability_id];
    if (cap) {
      const cascades = Object.assign({}, cap.cascades);
      const prevMember = cascades[content.member_project] || {
        code: null,
        artifact: null,
      };
      cascades[content.member_project] = Object.assign({}, prevMember, {
        migrated: true,
      });
      cl.capabilities[content.capability_id] = Object.assign({}, cap, {
        cascades,
      });
    }
  });
  return { accepted: true, foldState: next };
}

// ---------------------------------------------------------------------------
// Predicate: retired (§4.2 — TYPE + SHAPE DEFINED; fold NEVER auto-fires it)
// ---------------------------------------------------------------------------
/**
 * The retirement record (§4.2). SCOPE BOUNDARY (load-bearing): this predicate
 * ACCEPTS and projects a `retired` record that has ALREADY been emitted; it
 * NEVER itself FIRES a retirement (the §4.4 retirement-firing fold is W5). A
 * `retired` here marks the named workaround retired in folded state (a
 * monotone flip — re-folding a `retired` for an already-retired workaround is
 * a no-op, F-NEW-3) and validates the field shape. The fold does NOT decide
 * WHETHER to retire — it records that a retirement was emitted.
 */
function foldRetired(record, ctx) {
  const foldState = ctx.foldState || { trustRoot: null };
  const content = record.content;
  if (!content || typeof content !== "object") {
    return reject(foldState, "retired: content missing");
  }
  const allowErr = checkFieldAllowlist(TYPE_RETIRED, content);
  if (allowErr) return reject(foldState, allowErr);

  if (typeof content.member_project !== "string" || !content.member_project) {
    return reject(
      foldState,
      "retired: member_project must be a non-empty string",
    );
  }
  if (typeof content.workaround_ref !== "string" || !content.workaround_ref) {
    return reject(
      foldState,
      "retired: workaround_ref must be a non-empty string",
    );
  }
  if (
    typeof content.by_capability_id !== "string" ||
    !content.by_capability_id
  ) {
    return reject(
      foldState,
      "retired: by_capability_id must be a non-empty string",
    );
  }

  const next = extendCapabilityLedger(foldState, (cl) => {
    const wa = cl.workarounds[content.workaround_ref];
    if (wa) {
      // Monotone flip — idempotent (F-NEW-3).
      cl.workarounds[content.workaround_ref] = Object.assign({}, wa, {
        retired: true,
        retired_by_capability_id: content.by_capability_id,
      });
    }
  });
  return { accepted: true, foldState: next };
}

// ---------------------------------------------------------------------------
// Predicate: membership-severed (S3, §4.2 — SHAPE + monotone mark)
// ---------------------------------------------------------------------------
/**
 * The S3 sever record (§4.2). The append-only log cannot mutate rows, so the
 * "mark" is a record. SHAPE-validated; marks the project severed in folded
 * state (a monotone property the W5 retirement gate reads — §4.4 condition 4).
 * Does NOT itself fire or revoke any retirement (scope boundary; the
 * sever-aware retirement gate is W5).
 */
function foldMembershipSevered(record, ctx) {
  const foldState = ctx.foldState || { trustRoot: null };
  const content = record.content;
  if (!content || typeof content !== "object") {
    return reject(foldState, "membership-severed: content missing");
  }
  const allowErr = checkFieldAllowlist(TYPE_MEMBERSHIP_SEVERED, content);
  if (allowErr) return reject(foldState, allowErr);

  if (typeof content.member_project !== "string" || !content.member_project) {
    return reject(
      foldState,
      "membership-severed: member_project must be a non-empty string",
    );
  }
  if (typeof content.severed_at !== "string" || !content.severed_at) {
    return reject(
      foldState,
      "membership-severed: severed_at must be a non-empty timestamp string",
    );
  }
  if (
    typeof content.pointer_flip_ref !== "string" ||
    !content.pointer_flip_ref
  ) {
    return reject(
      foldState,
      "membership-severed: pointer_flip_ref must be a non-empty string",
    );
  }

  const next = extendCapabilityLedger(foldState, (cl) => {
    const prevSevered = cl.severedProjects || {};
    cl.severedProjects = Object.assign({}, prevSevered, {
      [content.member_project]: {
        severed_at: content.severed_at,
        pointer_flip_ref: content.pointer_flip_ref,
      },
    });
  });
  return { accepted: true, foldState: next };
}

// ---------------------------------------------------------------------------
// Dual-lineage projection query (the W4 read-side; consumed by tests + W5)
// ---------------------------------------------------------------------------
/**
 * Project a capability's per-member dual-lineage cascade state from a folded
 * ledger. This is the W4 read-side query the dual-lineage invariant (iv)
 * surfaces; the W5 retirement gate reads `fully_cascaded` (BOTH lineages) but
 * this file NEVER fires a retirement from it.
 *
 * @returns {{ registered: boolean, code_lineage_id?: string,
 *             artifact_lineage_id?: string,
 *             cascades: { [member_project]: {
 *               code: string|null, artifact: string|null,
 *               migrated: boolean, fully_cascaded: boolean } } }}
 */
function projectDualLineage(folded, capabilityId) {
  const cl = folded && folded.foldState && folded.foldState.capabilityLedger;
  const cap = cl && cl.capabilities && cl.capabilities[capabilityId];
  if (!cap) {
    return { registered: false, cascades: {} };
  }
  const cascades = {};
  for (const [member, m] of Object.entries(cap.cascades || {})) {
    const code = m.code || null;
    const artifact = m.artifact || null;
    cascades[member] = {
      code,
      artifact,
      migrated: m.migrated === true,
      // BOTH lineages cascaded (invariant iv — code-only is NOT fully
      // cascaded). This is the read the W5 retirement gate will consume; the
      // FIRE decision itself is W5, never here.
      fully_cascaded: code !== null && artifact !== null,
    };
  }
  return {
    registered: true,
    code_lineage_id: cap.code_lineage_id,
    artifact_lineage_id: cap.artifact_lineage_id,
    cascades,
  };
}

/**
 * Read a workaround's folded state (project / need_fingerprint /
 * supersedes_when stage / retired flag). The W5 retirement gate reads this;
 * here it is the read-side surface for tests asserting the shape-validation +
 * the rails-precedence (ii) outcomes.
 */
function readWorkaround(folded, workaroundRef) {
  const cl = folded && folded.foldState && folded.foldState.capabilityLedger;
  const wa = cl && cl.workarounds && cl.workarounds[workaroundRef];
  if (!wa) return null;
  return Object.assign({}, wa);
}

// ---------------------------------------------------------------------------
// Retirement re-fold integration point (the W5 A2-T4 surface — capability-
// retirement.js consumes this read; the FIRE itself is in that module)
// ---------------------------------------------------------------------------
/**
 * Enumerate every OPEN (not-yet-`retired`) `workaround-registered` in a folded
 * ledger, returning the condition INPUTS each open workaround needs for the
 * §4.4 monotonic-re-fold retirement predicate. This is the read-side
 * integration point the W5 retirement pass (`capability-retirement.js`)
 * recomputes the four conditions FRESH from each step (there is NO materialized
 * "deferred-conditions" index — MED-2; the inputs are projected on demand from
 * folded state, never cached). The retirement FIRE is NOT here (the scope
 * boundary at the head of this file holds: a predicate here never auto-fires a
 * `retired`); this function only SURFACES the inputs.
 *
 * For each open workaround `(project, need_fingerprint, workaround_ref)` it
 * resolves the bound capability via the `supersedes_when` post-T3 stage (the
 * `supersedes-rebind` landing): a workaround is BOUND to a capability only once
 * its `supersedes_when` is the stage-2 `{capability_id, min_satisfying_version}`
 * (NEVER on an absent bind — cond-2 DEFERs if not yet rebound). When bound, it
 * also projects the per-lineage cascade state + the `migrated` flag for
 * `(capability_id, project)` so the retirement pass can apply the both-lineages
 * gate (cond-1), the per-lineage landing gate (cond-2), and the migrated gate
 * (cond-3) without re-reading the capability sub-tree.
 *
 * @returns {Array<{
 *   workaround_ref: string,
 *   project: string,
 *   need_fingerprint: string,
 *   supersedes_when: object|string,
 *   rebound: boolean,                       // supersedes_when is the post-T3 stage
 *   bound_capability_id: string|null,       // the rebind target (cond-2 gate)
 *   min_satisfying_version: string|null,    // the cond-2 CODE-lineage floor
 *   cascade: { code: string|null, artifact: string|null,
 *              migrated: boolean, fully_cascaded: boolean } | null,
 * }>}
 */
function projectOpenWorkarounds(folded) {
  const cl = folded && folded.foldState && folded.foldState.capabilityLedger;
  if (!cl || !cl.workarounds) return [];
  const out = [];
  for (const [ref, wa] of Object.entries(cl.workarounds)) {
    if (wa.retired === true) continue; // idempotent: already retired → skip
    const sw = wa.supersedes_when;
    const rebound =
      sw &&
      typeof sw === "object" &&
      !Array.isArray(sw) &&
      typeof sw.capability_id === "string" &&
      typeof sw.min_satisfying_version === "string";
    const boundCapId = rebound ? sw.capability_id : null;
    const minVer = rebound ? sw.min_satisfying_version : null;

    let cascade = null;
    if (boundCapId) {
      const cap = cl.capabilities && cl.capabilities[boundCapId];
      const member = cap && cap.cascades && cap.cascades[wa.project];
      if (member) {
        const code = member.code || null;
        const artifact = member.artifact || null;
        cascade = {
          code,
          artifact,
          migrated: member.migrated === true,
          fully_cascaded: code !== null && artifact !== null,
        };
      } else {
        cascade = {
          code: null,
          artifact: null,
          migrated: false,
          fully_cascaded: false,
        };
      }
    }

    out.push({
      workaround_ref: ref,
      project: wa.project,
      need_fingerprint: wa.need_fingerprint,
      supersedes_when: sw,
      rebound: !!rebound,
      bound_capability_id: boundCapId,
      min_satisfying_version: minVer,
      cascade,
    });
  }
  return out;
}

/**
 * Read whether a `migrated` record has landed for `(member_project,
 * capability_id)` — the §4.4 condition-3 gate. The `migrated` predicate marks
 * the per-member cascade entry `migrated: true`; this surfaces it for the
 * retirement pass. Returns false when the capability/member/cascade is absent.
 */
function readMigrated(folded, capabilityId, memberProject) {
  const cl = folded && folded.foldState && folded.foldState.capabilityLedger;
  const cap = cl && cl.capabilities && cl.capabilities[capabilityId];
  const member = cap && cap.cascades && cap.cascades[memberProject];
  return !!(member && member.migrated === true);
}

/**
 * Read whether a project has a folded `membership-severed` mark (the §4.4
 * condition-4 monotone suppression input AND the F-NEW-3 monotone-`retired`
 * boundary). Surfaces the `severedProjects` sub-tree the membership-severed
 * predicate writes.
 */
function readLedgerSevered(folded, memberProject) {
  const cl = folded && folded.foldState && folded.foldState.capabilityLedger;
  return !!(cl && cl.severedProjects && cl.severedProjects[memberProject]);
}

// ---------------------------------------------------------------------------
// Registration helper — the type→predicate map (SSOT for invariant i)
// ---------------------------------------------------------------------------
/**
 * The full §4.2 type→predicate dispatch map. coordination-log.js::
 * _registerM0Defaults iterates this to register the A2 namespace into the
 * default fold engine, so emitSignedRecord's type-check passes for every
 * §4.2 type (invariant i) AND every record folds in every default engine.
 * Exported as the single source so the registration site and the predicates
 * cannot drift.
 */
const LEDGER_PREDICATES = [
  [TYPE_RAILS_PROVISIONED, foldRailsProvisioned],
  [TYPE_WORKAROUND_REGISTERED, foldWorkaroundRegistered],
  [TYPE_NEED_CLASSIFIED, foldNeedClassified],
  [TYPE_SUPERSEDES_REBIND, foldSupersedesRebind],
  [TYPE_NEED_ROUTED, foldNeedRouted],
  [TYPE_CAPABILITY_REGISTERED, foldCapabilityRegistered],
  [TYPE_DEPENDENCY_EDGE, foldDependencyEdge],
  [TYPE_APPROVAL, foldApproval],
  [TYPE_CASCADE_FIRED, foldCascadeFired],
  [TYPE_MIGRATED, foldMigrated],
  [TYPE_RETIRED, foldRetired],
  [TYPE_MEMBERSHIP_SEVERED, foldMembershipSevered],
];

module.exports = {
  // Predicates (registered in coordination-log.js::_registerM0Defaults via
  // LEDGER_PREDICATES).
  foldRailsProvisioned,
  foldWorkaroundRegistered,
  foldNeedClassified,
  foldSupersedesRebind,
  foldNeedRouted,
  foldCapabilityRegistered,
  foldDependencyEdge,
  // The authoritative fold-time acyclicity predicate. Exported so the
  // registration-gate's cycle check (capability-dag.js::wouldCloseCycle) can be
  // conformance-tested against it — the two are independent BFS implementations
  // of the same reachability check (registration fast-path vs fold backstop);
  // the conformance test locks them against silent drift (MED-2, eco-w5 R1).
  edgeClosesCycle,
  foldApproval,
  foldCascadeFired,
  foldMigrated,
  foldRetired,
  foldMembershipSevered,
  // The full type→predicate dispatch map (SSOT for the registration site).
  LEDGER_PREDICATES,
  // Read-side projection queries (the dual-lineage convenience + workaround
  // read; consumed by tests + the W5 retirement gate).
  projectDualLineage,
  readWorkaround,
  // Retirement re-fold integration point (W5 A2-T4 — consumed by
  // capability-retirement.js; the FIRE lives there, never here).
  projectOpenWorkarounds,
  readMigrated,
  readLedgerSevered,
  // Record-type names (SSOT re-exported by capability-ledger.js as
  // CAPABILITY_LEDGER_TYPES).
  TYPE_RAILS_PROVISIONED,
  TYPE_WORKAROUND_REGISTERED,
  TYPE_NEED_CLASSIFIED,
  TYPE_SUPERSEDES_REBIND,
  TYPE_NEED_ROUTED,
  TYPE_CAPABILITY_REGISTERED,
  TYPE_DEPENDENCY_EDGE,
  TYPE_APPROVAL,
  TYPE_CASCADE_FIRED,
  TYPE_MIGRATED,
  TYPE_RETIRED,
  TYPE_MEMBERSHIP_SEVERED,
  CAPABILITY_LEDGER_TYPES,
  // Closed-set constants (need classes, lineage discriminator, supersedes_when
  // markers).
  NEED_CLASS_CAPABILITY,
  NEED_CLASS_BUG,
  NEED_CLASS_PRODUCT_TWEAK,
  NEED_CLASS_METHODOLOGY,
  NEED_CLASSES,
  LINEAGE_CODE,
  LINEAGE_ARTIFACT,
  LINEAGES,
  SUPERSEDES_TERMINAL_EXTERNAL,
  SUPERSEDES_PENDING_CLASSIFICATION,
  // Exposed for tests + the emit/registration sites.
  recordContentHash,
  validateSupersedesWhenShape,
  CONTENT_FIELD_ALLOWLIST,
};
