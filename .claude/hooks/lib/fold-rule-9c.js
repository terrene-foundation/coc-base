/**
 * fold-rule-9c — genesis-migration fold predicate.
 *
 * Shard A3 (workspaces/multi-operator-coc, design v11 §2.2 rule 9c +
 * R6-S-04 + R6-S-06).
 *
 * A `genesis-migration` record folds ONLY when ALL of the following
 * hold:
 *
 *   1. 2-of-N owner-co-signed — the primary signer plus at least one
 *      DISTINCT co-signer in content.co_signers, each resolving to an
 *      owner-role roster person. R6-S-04: degenerate self-sign is
 *      BLOCKED even under genuine genesis N=1 — a migration is the
 *      single most consequential event in the substrate's lifetime and
 *      MUST carry two distinct owner signatures. Genuine N=1 means the
 *      migration cannot proceed until a second owner is enrolled.
 *
 *   2. Carries a fresh `gh api repos/{owner}/{repo}` external-owner
 *      capture at content.gh_api_repo_owner_capture, validated via the
 *      gh-api-allowlist shape. The capture's owner.login MUST equal
 *      content.new_repo_owner — otherwise the capture is stale or
 *      forged and the migration is rejected.
 *
 *   3. Monotonically increments genesis_generation
 *      (content.to_genesis_generation > content.from_genesis_generation).
 *
 *   4. R6-S-06 latest-wins supersession — a verifying genesis-migration
 *      supersedes any prior trust root by rebasing foldState.trustRoot
 *      to the migration's post-migration anchor binding:
 *         repo_owner       = content.new_repo_owner
 *         repo_owner_kind  = content.new_repo_owner_kind
 *         genesis_generation = content.to_genesis_generation
 *
 * Style: CommonJS, zero-dep, matches sibling fold-genesis-anchor.js
 * shape. Consumes the engine dispatch ctx
 * ({ foldState, roster, acceptedSoFar }) and returns
 * { accepted, foldState, reason? } per coordination-log.js::_foldLog.
 */

"use strict";

const { canonicalSerialize, verify: cocVerify } = require("./coc-sign.js");
const {
  _allowlistRepoOwner,
  _allowlistOrgMembership,
  _isCaptureFresh,
  _verifyDistinctBoundCollaborators,
  MIGRATION_LIVENESS_TTL,
} = require("./gh-api-allowlist.js");
// F14 MED-3: route inline R5-S-04 (host_role:ci) + role checks through
// the single eligibility predicate so drift across rule 5 / 9b / 9c is
// closed structurally.
const { isEligibleSigner } = require("./eligibility.js");
// F14 C2 iter-3: case-insensitive owner-bind compare per GitHub server semantics.
const { loginsEqual } = require("./github-login.js");
// F86 / MUST-7: PLACEHOLDER- person_id detection shared with genesis-ceremony.
const { isUnenrolled } = require("./roster-schema-validate.js");

// F86 / MUST-7: the explicit discriminator value the N=1 org-admin path
// signs into the migration record. fold-rule-9c dispatches on this token
// before evaluating co_signers / capture surface so the N=1 path is
// resolve-by-construction, not infer-by-absence-of-co-signers.
const CO_SIGN_ANCHOR_KIND_ORG_ADMIN = "gh_api_org_membership_capture";

/**
 * Resolve a verified_id to its roster person (if any).
 */
function _resolveRosterPerson(roster, verifiedId) {
  if (!roster || !roster.persons) return null;
  for (const [pid, person] of Object.entries(roster.persons)) {
    const keys = (person && person.keys) || [];
    for (const k of keys) {
      if (k && k.fingerprint === verifiedId) {
        return { person_id: pid, person };
      }
    }
  }
  return null;
}

/**
 * Re-derive the canonical bytes a co-signer covered. Same convention as
 * fold-rule-9b._coSignedBytes: each cosig is over the record core with
 * content.co_signers REMOVED.
 */
function _coSignedBytes(record) {
  const { sig, ...core } = record;
  const c = core.content || {};
  const { co_signers, ...contentForCoSig } = c;
  const baseForCoSig = Object.assign({}, core, { content: contentForCoSig });
  return canonicalSerialize(baseForCoSig);
}

/**
 * Verify a single co-signer entry. Same shape as fold-rule-9b
 * (owner-role, host_role != "ci", pubkey-bound, signature verifies).
 */
function _verifyCoSigner(coSigner, record, roster) {
  if (!coSigner || typeof coSigner !== "object") {
    return { ok: false, reason: "co_signer entry not an object" };
  }
  if (typeof coSigner.verified_id !== "string" || !coSigner.verified_id) {
    return { ok: false, reason: "co_signer missing verified_id" };
  }
  if (typeof coSigner.sig !== "string" || !coSigner.sig) {
    return { ok: false, reason: "co_signer missing sig" };
  }
  const resolved = _resolveRosterPerson(roster, coSigner.verified_id);
  if (!resolved) {
    return {
      ok: false,
      reason: `co_signer verified_id ${coSigner.verified_id} not in roster`,
    };
  }
  // F14 MED-3: route through isEligibleSigner. genesis-migration is the
  // "migration" context per eligibility.js::CI_FOREVER_INELIGIBLE_CONTEXTS
  // — owner-role required AND host_role!=ci enforced with one audit
  // surface across rule 5 / 9b / 9c.
  const elig = isEligibleSigner(resolved.person, "migration");
  if (!elig.eligible) {
    return {
      ok: false,
      reason: `co_signer ${coSigner.verified_id} ineligible: ${elig.reason}`,
    };
  }
  const matchingKey = (resolved.person.keys || []).find(
    (k) => k.fingerprint === coSigner.verified_id,
  );
  if (!matchingKey) {
    return {
      ok: false,
      reason: `co_signer ${coSigner.verified_id} has no roster pubkey match`,
    };
  }
  const bytes = _coSignedBytes(record);
  let r;
  try {
    r = cocVerify(bytes, coSigner.sig, matchingKey.pubkey, {
      keyType: matchingKey.type,
    });
  } catch (err) {
    return {
      ok: false,
      reason: `co_signer verify threw: ${err && err.message ? err.message : String(err)}`,
    };
  }
  if (!r || !r.ok) {
    return {
      ok: false,
      reason: `co_signer verify failed: ${r && r.reason ? r.reason : "unknown"}`,
    };
  }
  if (!r.valid) {
    return {
      ok: false,
      reason: `co_signer signature did not verify: ${r.reason || "invalid"}`,
    };
  }
  return { ok: true };
}

/**
 * Fold a candidate genesis-migration record.
 */
function foldGenesisMigration(record, ctx) {
  const state = (ctx && ctx.foldState) || { trustRoot: null };
  const roster = ctx && ctx.roster;

  // --- shape ---
  if (!record || typeof record !== "object") {
    return {
      accepted: false,
      foldState: state,
      reason: "record not an object",
    };
  }
  if (record.type !== "genesis-migration") {
    return {
      accepted: false,
      foldState: state,
      reason: `record.type != 'genesis-migration' (got: ${record.type})`,
    };
  }
  const c = record.content;
  if (!c || typeof c !== "object") {
    return { accepted: false, foldState: state, reason: "content missing" };
  }

  // --- field presence: new_repo_owner ---
  if (typeof c.new_repo_owner !== "string" || !c.new_repo_owner) {
    return {
      accepted: false,
      foldState: state,
      reason: "rule 9c: missing required field new_repo_owner",
    };
  }
  if (c.new_repo_owner_kind !== "user" && c.new_repo_owner_kind !== "org") {
    return {
      accepted: false,
      foldState: state,
      reason: `rule 9c: new_repo_owner_kind invalid: ${c.new_repo_owner_kind}`,
    };
  }

  // --- monotonic genesis_generation ---
  if (
    typeof c.from_genesis_generation !== "number" ||
    typeof c.to_genesis_generation !== "number" ||
    !Number.isInteger(c.from_genesis_generation) ||
    !Number.isInteger(c.to_genesis_generation)
  ) {
    return {
      accepted: false,
      foldState: state,
      reason: "rule 9c: from/to_genesis_generation must be integers",
    };
  }
  if (c.to_genesis_generation <= c.from_genesis_generation) {
    return {
      accepted: false,
      foldState: state,
      reason: `rule 9c: genesis_generation must increment monotonically (from=${c.from_genesis_generation}, to=${c.to_genesis_generation})`,
    };
  }

  // --- F86 / MUST-7 dispatch: N=1 org-admin path vs 2-of-N owner-co-sign ---
  //
  // The N=1 org-owned path is signaled by the EXPLICIT discriminator
  // `content.co_sign_anchor_kind === "gh_api_org_membership_capture"`. When
  // the discriminator is present the fold predicate dispatches to the N=1
  // branch which validates a gh-api-bound verified-active org-admin
  // attestation as the structural-equivalent anchor to a 2-of-N co-signer
  // quorum. Without the discriminator the predicate falls through to the
  // original 2-of-N path (R6-S-04 — degenerate self-sign BLOCKED).
  //
  // The dispatch is resolve-by-construction (presence of the discriminator
  // + presence of the capture) rather than infer-by-absence (no co_signers
  // → assume N=1) so a malformed record with empty co_signers + no
  // discriminator surfaces as the existing R6-S-04 rejection, NOT silent
  // acceptance via a relaxed path.
  const isN1OrgAdminPath =
    c.co_sign_anchor_kind === CO_SIGN_ANCHOR_KIND_ORG_ADMIN;

  if (isN1OrgAdminPath) {
    // F86 / MUST-7 N=1 org-owned path.
    //
    // (a) co_signers MUST be the empty array — the discriminator carries
    //     the substitution; populated co_signers + discriminator is a
    //     malformed record (caller built two paths simultaneously).
    if (!Array.isArray(c.co_signers) || c.co_signers.length !== 0) {
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9c: MUST-7 N=1 org-admin path requires content.co_signers === [] (empty array); discriminator co_sign_anchor_kind="${CO_SIGN_ANCHOR_KIND_ORG_ADMIN}" set but co_signers length=${Array.isArray(c.co_signers) ? c.co_signers.length : "non-array"}`,
      };
    }

    // (b) new_repo_owner_kind MUST be "org". User-owned N=1 has no
    //     structural-equivalent anchor (no gh api orgs/{org}/memberships/
    //     surface to bind admin attestation against) — MUST-7 explicitly
    //     blocks that path; falling through here under repo_owner_kind=user
    //     would silently substitute org-membership semantics for a user
    //     repo, exactly the failure mode MUST-7 closes.
    if (c.new_repo_owner_kind !== "org") {
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9c: MUST-7 N=1 org-admin path requires content.new_repo_owner_kind === "org"; got "${c.new_repo_owner_kind}". User-owned N=1 has no structural co-sign anchor; add a second owner via /whoami --register before migrating.`,
      };
    }

    // (c) gh_api_org_membership_capture MUST be present + valid + fresh.
    const rawOrgCapture = c.gh_api_org_membership_capture;
    if (!rawOrgCapture || typeof rawOrgCapture !== "object") {
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9c: MUST-7 N=1 path missing required field gh_api_org_membership_capture`,
      };
    }
    if (
      typeof rawOrgCapture.capture_ts !== "string" ||
      !rawOrgCapture.capture_ts
    ) {
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9c: MUST-7 N=1 path gh_api_org_membership_capture missing required field capture_ts (replay defense requires anchor)`,
      };
    }
    let orgCapture;
    try {
      orgCapture = _allowlistOrgMembership(rawOrgCapture, {
        capture_ts: rawOrgCapture.capture_ts,
      });
    } catch (err) {
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9c: MUST-7 N=1 path gh_api_org_membership_capture allowlist threw: ${err && err.message ? err.message : String(err)}`,
      };
    }
    if (!orgCapture || orgCapture.role !== "admin") {
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9c: MUST-7 N=1 path gh_api_org_membership_capture role must be "admin"; got "${orgCapture && orgCapture.role}"`,
      };
    }
    if (orgCapture.state !== "active") {
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9c: MUST-7 N=1 path gh_api_org_membership_capture state must be "active"; got "${orgCapture.state}" (a pending/suspended admin cannot stand in as the verified-identity anchor)`,
      };
    }
    if (
      !orgCapture.user ||
      typeof orgCapture.user.login !== "string" ||
      !orgCapture.user.login
    ) {
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9c: MUST-7 N=1 path gh_api_org_membership_capture missing user.login`,
      };
    }
    if (
      !orgCapture.organization ||
      typeof orgCapture.organization.login !== "string" ||
      !orgCapture.organization.login
    ) {
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9c: MUST-7 N=1 path gh_api_org_membership_capture missing organization.login`,
      };
    }
    if (!loginsEqual(orgCapture.organization.login, c.new_repo_owner)) {
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9c: MUST-7 N=1 path gh_api_org_membership_capture organization.login (${orgCapture.organization.login}) does not match new_repo_owner (${c.new_repo_owner})`,
      };
    }
    // Fold-time freshness re-check against MIGRATION_LIVENESS_TTL (15min)
    // — distinct from the routine-enrollment 5min default. Per MUST-7
    // (iii): the multi-step ceremony tolerance must apply at fold time so
    // a replay of a migration record signed months ago — even with a
    // ceremony-time-fresh capture — is caught.
    const orgFreshness = _isCaptureFresh(orgCapture.capture_ts, record.ts, {
      freshnessMs: MIGRATION_LIVENESS_TTL,
    });
    if (!orgFreshness.fresh) {
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9c: MUST-7 N=1 path stale gh_api_org_membership_capture per migration-ceremony freshness predicate: ${orgFreshness.reason}`,
      };
    }

    // (d) gh_api_owner_capture MUST be present + valid + fresh + match
    //     the migration's new_repo_owner.
    const rawOwnerCapture = c.gh_api_owner_capture;
    if (!rawOwnerCapture || typeof rawOwnerCapture !== "object") {
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9c: MUST-7 N=1 path missing required field gh_api_owner_capture (fresh external-owner read)`,
      };
    }
    if (
      typeof rawOwnerCapture.capture_ts !== "string" ||
      !rawOwnerCapture.capture_ts
    ) {
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9c: MUST-7 N=1 path gh_api_owner_capture missing required field capture_ts`,
      };
    }
    let ownerCapture;
    try {
      ownerCapture = _allowlistRepoOwner(rawOwnerCapture, {
        capture_ts: rawOwnerCapture.capture_ts,
      });
    } catch (err) {
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9c: MUST-7 N=1 path gh_api_owner_capture allowlist threw: ${err && err.message ? err.message : String(err)}`,
      };
    }
    if (
      !ownerCapture ||
      !ownerCapture.owner ||
      typeof ownerCapture.owner.login !== "string"
    ) {
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9c: MUST-7 N=1 path gh_api_owner_capture malformed (owner.login missing after allowlist)`,
      };
    }
    if (!loginsEqual(ownerCapture.owner.login, c.new_repo_owner)) {
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9c: MUST-7 N=1 path stale gh_api_owner_capture — owner.login (${ownerCapture.owner.login}) does not match new_repo_owner (${c.new_repo_owner})`,
      };
    }
    const ownerFreshness = _isCaptureFresh(ownerCapture.capture_ts, record.ts, {
      freshnessMs: MIGRATION_LIVENESS_TTL,
    });
    if (!ownerFreshness.fresh) {
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9c: MUST-7 N=1 path stale gh_api_owner_capture per migration-ceremony freshness predicate: ${ownerFreshness.reason}`,
      };
    }

    // (e) Roster MUST have exactly one rostered owner (the N=1 case).
    //     Counting > 1 means the 2-of-N path is structurally available and
    //     MUST-7 explicitly blocks routing around it via the N=1 branch
    //     (the sock-puppet bypass corpus entry).
    const ownerPersonIds = Object.entries((roster && roster.persons) || {})
      .filter(
        ([pid, person]) =>
          !isUnenrolled(pid) && person && person.role === "owner",
      )
      .map(([pid]) => pid);
    if (ownerPersonIds.length !== 1) {
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9c: MUST-7 N=1 path requires exactly one rostered owner person_id; roster declares ${ownerPersonIds.length}. (≥2 owners → 2-of-N path MUST be used.)`,
      };
    }
    const soleOwnerPersonId = ownerPersonIds[0];
    const soleOwner = roster.persons[soleOwnerPersonId];

    // (f) Primary signer (record.verified_id) MUST be the sole owner's
    //     enrolled key + MUST be eligible for "migration" context per
    //     R5-S-04 (host_role:ci forever ineligible).
    const matchingKey = (soleOwner.keys || []).find(
      (k) => k && k.fingerprint === record.verified_id,
    );
    if (!matchingKey) {
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9c: MUST-7 N=1 path primary signer verified_id ${record.verified_id} not enrolled under the sole owner person_id ${soleOwnerPersonId}`,
      };
    }
    const elig = isEligibleSigner(soleOwner, "migration");
    if (!elig.eligible) {
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9c: MUST-7 N=1 path primary signer ineligible: ${elig.reason}`,
      };
    }

    // (g) The org-admin attestation's user.login MUST match the sole
    //     owner's bound github_login (the gh-api-bound substitution
    //     anchor binds to a specific GitHub identity; mismatch means the
    //     attestation was captured for a different operator).
    if (
      typeof soleOwner.github_login !== "string" ||
      !soleOwner.github_login ||
      !loginsEqual(orgCapture.user.login, soleOwner.github_login)
    ) {
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9c: MUST-7 N=1 path gh_api_org_membership_capture user.login (${orgCapture.user.login}) does not match sole owner's bound github_login (${soleOwner.github_login})`,
      };
    }

    // N=1 org-admin path PASSED. Fall through to monotonic-generation +
    // R6-S-06 supersession below (shared with 2-of-N path).
  } else {
    // --- Existing 2-of-N path (R6-S-04: no degenerate self-sign) ---
    if (!Array.isArray(c.co_signers) || c.co_signers.length === 0) {
      return {
        accepted: false,
        foldState: state,
        reason:
          'rule 9c: R6-S-04 — degenerate self-sign BLOCKED; 2-of-N owner co-signature required even under genuine genesis N=1. Migration cannot proceed until a second distinct owner is enrolled. (For org-owned single-owner repos see MUST-7: emit content.co_sign_anchor_kind="gh_api_org_membership_capture" with the canonical capture shape.)',
      };
    }
    const distinctSigners = new Set([record.verified_id]);
    for (const co of c.co_signers) {
      const v = _verifyCoSigner(co, record, roster);
      if (!v.ok) {
        return {
          accepted: false,
          foldState: state,
          reason: `rule 9c: co-sign verification failed: ${v.reason}`,
        };
      }
      if (distinctSigners.has(co.verified_id)) {
        return {
          accepted: false,
          foldState: state,
          reason: `rule 9c: R6-S-04 — co_signer verified_id ${co.verified_id} not distinct from prior signer; degenerate self-sign rejected`,
        };
      }
      distinctSigners.add(co.verified_id);
    }
    if (distinctSigners.size < 2) {
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9c: R6-S-04 — 2-of-N owner co-signature required; only ${distinctSigners.size} distinct signer(s)`,
      };
    }
  }

  // --- fresh gh-api repo_owner capture (2-of-N path only) ---
  //
  // The N=1 org-admin path validated its own gh_api_owner_capture +
  // gh_api_org_membership_capture above (with the migration-class freshness
  // ceiling MIGRATION_LIVENESS_TTL); falling through here would attempt to
  // read c.gh_api_repo_owner_capture which the N=1 path does NOT carry,
  // producing a spurious rejection. Gate this block on the 2-of-N branch
  // so each path validates its own capture surface.
  //
  // Naming-drift acknowledgement: the 2-of-N path reads
  // `gh_api_repo_owner_capture` (legacy fold-rule-9c name) while the N=1
  // path reads `gh_api_owner_capture` (MUST-7 canonical + genesis-anchor
  // record convention). Both names refer to the same `_allowlistRepoOwner`
  // shape; the dual naming preserves backward compat with existing
  // genesis-migration fixtures (e.g. transport-git-ref.test.js) without
  // breaking-change to the 2-of-N path. A future codify cycle MAY align
  // the 2-of-N field to gh_api_owner_capture; this F86 wave intentionally
  // does NOT widen that surface.
  if (!isN1OrgAdminPath) {
    const rawCapture = c.gh_api_repo_owner_capture;
    if (!rawCapture || typeof rawCapture !== "object") {
      return {
        accepted: false,
        foldState: state,
        reason:
          "rule 9c: missing required field gh_api_repo_owner_capture (fresh external-owner read)",
      };
    }
    // M3 HIGH-4 / F-7: capture_ts MUST be present on the raw capture (the
    // ceremony writer populates it). The allowlist re-derives it on output
    // but we validate the INPUT has it so replays of capture-less captures
    // are caught loudly.
    if (typeof rawCapture.capture_ts !== "string" || !rawCapture.capture_ts) {
      return {
        accepted: false,
        foldState: state,
        reason:
          "rule 9c: gh_api_repo_owner_capture missing required field capture_ts (HIGH-4: replay defense requires anchor)",
      };
    }
    // Run through the allowlist to validate shape AND strip unsupported fields.
    // Pass the raw capture's capture_ts through so the allowlist re-emits it
    // (the allowlist defaults to now() if no capture_ts is supplied; for
    // verification we want the BYTES the signer covered).
    const capture = _allowlistRepoOwner(rawCapture, {
      capture_ts: rawCapture.capture_ts,
    });
    if (!capture || !capture.owner || typeof capture.owner.login !== "string") {
      return {
        accepted: false,
        foldState: state,
        reason:
          "rule 9c: gh_api_repo_owner_capture malformed (owner.login missing after allowlist)",
      };
    }
    if (!loginsEqual(capture.owner.login, c.new_repo_owner)) {
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9c: stale gh_api_repo_owner_capture — owner.login (${capture.owner.login}) does not match new_repo_owner (${c.new_repo_owner}); capture is stale or forged`,
      };
    }
    // M3 HIGH-4 / F-7: freshness predicate against record ts.
    const freshness = _isCaptureFresh(capture.capture_ts, record.ts);
    if (!freshness.fresh) {
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9c: stale capture per freshness predicate: ${freshness.reason}`,
      };
    }
  }

  // --- R6-S-06 latest-wins supersession — rebase trust root ---
  // F88 — root_commit resolution distinguishes the two migration kinds:
  //
  //   * owner-relocation migration (no gh_api_root_commit_capture): the root
  //     commit does NOT change; inherit it from the prior trust root.
  //   * re-anchor (carries content.gh_api_root_commit_capture, whose .sha IS
  //     the corrected root the ceremony verified at Step 7): the WHOLE PURPOSE
  //     is to re-point the trust root, so pin the NEW verified root.
  //
  // Pre-F88, this block unconditionally inherited the prior root_commit, so a
  // re-anchor folded clean but left the trust root pinned at the OLD SHA — a
  // generation bump that achieved nothing (journal/0172). Silently inheriting
  // on a malformed re-anchor would be the same silent-fallback failure mode
  // (zero-tolerance.md Rule 3), so a re-anchor whose capture lacks a usable
  // sha is REJECTED, not degraded to inherit.
  const inheritedRoot =
    state.trustRoot && state.trustRoot.pinnedFacts
      ? state.trustRoot.pinnedFacts.root_commit
      : null;
  const reanchorCapture = c.gh_api_root_commit_capture;
  let pinnedRootCommit;
  if (reanchorCapture !== undefined && reanchorCapture !== null) {
    // Re-anchor record. The capture's sha is the new root; validate it.
    if (
      typeof reanchorCapture !== "object" ||
      typeof reanchorCapture.sha !== "string" ||
      reanchorCapture.sha.length === 0
    ) {
      return {
        accepted: false,
        foldState: state,
        reason:
          "rule 9c: re-anchor gh_api_root_commit_capture missing a usable .sha (cannot re-point the trust root; refusing to silently inherit the prior root per zero-tolerance.md Rule 3)",
      };
    }
    // F88 R2 / security-reviewer LOW-1: bound the sha shape so a forged
    // capture (key-compromise) record fails loudly at fold rather than
    // pinning junk as the trust root. git SHA-1 = 40 hex, SHA-256 = 64;
    // ≥7 admits abbreviated forms.
    if (!/^[0-9a-f]{7,64}$/.test(reanchorCapture.sha)) {
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9c: re-anchor gh_api_root_commit_capture.sha is not a valid commit SHA shape (^[0-9a-f]{7,64}$): ${JSON.stringify(reanchorCapture.sha).slice(0, 80)}`,
      };
    }
    if (
      typeof c.pre_correction_root_commit !== "string" ||
      c.pre_correction_root_commit.length === 0
    ) {
      return {
        accepted: false,
        foldState: state,
        reason:
          "rule 9c: re-anchor missing content.pre_correction_root_commit (MUST-7 Re-anchor sub-case (iv): the old SHA being corrected MUST be surfaced in the signed content for audit)",
      };
    }
    // F88 R2 / security-reviewer MEDIUM-1: the re-anchor root capture MUST be
    // freshness-re-checked at fold time against MIGRATION_LIVENESS_TTL, exactly
    // like the org-membership (:351) and owner (:412) captures. Without this,
    // the F88-added block was the ONE path in fold-rule-9c that skipped the
    // replay-defense contract the function otherwise enforces uniformly —
    // relying transitively on the sibling captures' TTL gates rather than
    // enforcing its own (the multi-site-kwarg-plumbing drift class from
    // security.md). A re-anchor record signed when the owner was a verified
    // admin, replayed months later, is rejected here even if some future
    // refactor relaxes the sibling captures.
    if (
      typeof reanchorCapture.capture_ts !== "string" ||
      !reanchorCapture.capture_ts
    ) {
      return {
        accepted: false,
        foldState: state,
        reason:
          "rule 9c: re-anchor gh_api_root_commit_capture missing required field capture_ts (replay defense requires a fold-time freshness anchor)",
      };
    }
    const rootFreshness = _isCaptureFresh(
      reanchorCapture.capture_ts,
      record.ts,
      {
        freshnessMs: MIGRATION_LIVENESS_TTL,
      },
    );
    if (!rootFreshness.fresh) {
      return {
        accepted: false,
        foldState: state,
        reason: `rule 9c: re-anchor stale gh_api_root_commit_capture per migration-ceremony freshness predicate (MIGRATION_LIVENESS_TTL): ${rootFreshness.reason}`,
      };
    }
    pinnedRootCommit = reanchorCapture.sha;
  } else {
    // Owner-relocation migration — root commit unchanged.
    pinnedRootCommit = inheritedRoot;
  }

  const newTrustRoot = {
    verified_id: record.verified_id,
    person_id: record.person_id,
    seq: record.seq,
    ts: record.ts,
    pinnedFacts: {
      repo_owner: c.new_repo_owner,
      repo_owner_kind: c.new_repo_owner_kind,
      root_commit: pinnedRootCommit,
    },
    genesis_generation: c.to_genesis_generation,
  };

  const newState = Object.assign({}, state, {
    trustRoot: newTrustRoot,
    genesis_generation: c.to_genesis_generation,
  });

  return { accepted: true, foldState: newState };
}

module.exports = {
  foldGenesisMigration,
  // F86 / MUST-7: canonical discriminator the N=1 org-admin path uses on
  // the migration record's content.co_sign_anchor_kind. Exported so the
  // genesis-ceremony.js::performMigration helper + tests + fixtures
  // re-use the single token (no parallel string-literal drift).
  CO_SIGN_ANCHOR_KIND_ORG_ADMIN,
  _internal: {
    _resolveRosterPerson,
    _coSignedBytes,
    _verifyCoSigner,
  },
};
