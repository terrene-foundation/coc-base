"use strict";

/**
 * posture-v2 — per-operator postures + repo_floor + corrupt-state
 * discrimination + trust-root surfacing + partition adjustment.
 *
 * Per workspaces/multi-operator-coc/02-plans/01-architecture.md §6.1.
 *
 * Schema:
 *   {
 *     schema_version: 2,
 *     repo_floor: { posture, since, set_by },
 *     operators: { <person_id>: { posture, since, set_by, violation_window_30d? } },
 *     trust_root?: { verified_id, anchor_record_seq, anchor_record_ts, genesis_generation },
 *     _initialized: true,
 *     transition_history: [ ... ]
 *   }
 *
 * Operative posture = min(operator_posture, repo_floor_posture).
 * New operators default L2_SUPERVISED (per architecture §6.1).
 * Fresh repo defaults repo_floor L5_DELEGATED (per trust-posture.md MUST-2).
 *
 * This module is read/compute-only at the schema layer. WRITE happens through
 * the posture-event fold predicate (lib/fold-posture-event.js). The live
 * persona-local `.claude/learning/posture.json` is NOT modified directly here
 * — downstream consumers (C2 gate matrix) apply transitions through the
 * coordination log + folded state.
 */

// ---- ladder + min helpers ---------------------------------------------------

/**
 * Posture ladder in ascending trust order. Index N = trust level N+1.
 * Used for ordering comparisons in min/max operations and validation.
 */
const POSTURE_LADDER = [
  "L1_PSEUDO_AGENT",
  "L2_SUPERVISED",
  "L3_SHARED_PLANNING",
  "L4_CONTINUOUS_INSIGHT",
  "L5_DELEGATED",
];

const POSTURE_INDEX = Object.create(null);
for (let i = 0; i < POSTURE_LADDER.length; i++) {
  POSTURE_INDEX[POSTURE_LADDER[i]] = i;
}

function _isValidPosture(p) {
  return (
    typeof p === "string" &&
    Object.prototype.hasOwnProperty.call(POSTURE_INDEX, p)
  );
}

/**
 * Return true iff posture a is at most posture b in ladder order (a ≤ b).
 * Throws on unknown postures — callers MUST validate upstream.
 */
function posturesAreOrdered(a, b) {
  if (!_isValidPosture(a)) {
    throw new Error(`posturesAreOrdered: unknown posture '${a}'`);
  }
  if (!_isValidPosture(b)) {
    throw new Error(`posturesAreOrdered: unknown posture '${b}'`);
  }
  return POSTURE_INDEX[a] <= POSTURE_INDEX[b];
}

/**
 * Return the more-restrictive (lower-trust) of two postures.
 * min(L1, L5) = L1 — L1 is the lowest trust.
 */
function minPosture(a, b) {
  if (!_isValidPosture(a)) {
    throw new Error(`minPosture: unknown posture '${a}'`);
  }
  if (!_isValidPosture(b)) {
    throw new Error(`minPosture: unknown posture '${b}'`);
  }
  return POSTURE_INDEX[a] <= POSTURE_INDEX[b] ? a : b;
}

// ---- schema validation ------------------------------------------------------

/**
 * Validate a v2 posture object structurally. Returns {valid, errors}.
 * Returns valid:false with an actionable error list — never throws.
 */
function validatePostureV2Schema(posture) {
  const errors = [];
  if (!posture || typeof posture !== "object") {
    return { valid: false, errors: ["posture: must be an object"] };
  }
  if (posture.schema_version !== 2) {
    errors.push(
      "schema_version: must be 2 (got " + posture.schema_version + ")",
    );
  }
  if (!posture.repo_floor || typeof posture.repo_floor !== "object") {
    errors.push("repo_floor: must be an object");
  } else {
    if (!_isValidPosture(posture.repo_floor.posture)) {
      errors.push(
        "repo_floor.posture: unknown posture '" +
          posture.repo_floor.posture +
          "'",
      );
    }
    if (typeof posture.repo_floor.since !== "string") {
      errors.push("repo_floor.since: must be ISO string");
    }
    if (typeof posture.repo_floor.set_by !== "string") {
      errors.push("repo_floor.set_by: must be person_id string");
    }
  }
  if (
    posture.operators !== undefined &&
    typeof posture.operators !== "object"
  ) {
    errors.push("operators: must be an object (person_id → operator state)");
  } else if (posture.operators) {
    for (const [pid, op] of Object.entries(posture.operators)) {
      if (!op || typeof op !== "object") {
        errors.push(`operators.${pid}: must be an object`);
        continue;
      }
      if (!_isValidPosture(op.posture)) {
        errors.push(
          `operators.${pid}.posture: unknown posture '${op.posture}'`,
        );
      }
    }
  }
  if (posture.trust_root !== undefined && posture.trust_root !== null) {
    if (typeof posture.trust_root !== "object") {
      errors.push("trust_root: must be object | null when present");
    }
  }
  return { valid: errors.length === 0, errors };
}

// ---- V1 → V2 migration ------------------------------------------------------

/**
 * Migrate a v1 posture.json shape to v2. The v1 posture (single repo-wide
 * value) becomes the v2 repo_floor. The operators map starts empty — each
 * operator seeds their own posture when they first emit a posture-event.
 *
 * Caller is responsible for persisting the result; this is a pure transform.
 */
function migrateV1ToV2(v1) {
  if (!v1 || typeof v1 !== "object") {
    throw new Error("migrateV1ToV2: input must be a v1 posture object");
  }
  const floorPosture = _isValidPosture(v1.posture)
    ? v1.posture
    : "L5_DELEGATED";
  const since =
    typeof v1.since === "string" ? v1.since : new Date().toISOString();
  return {
    schema_version: 2,
    repo_floor: {
      posture: floorPosture,
      since,
      // Migration source unknown at v1 — record marker for audit.
      set_by: "system-migration-v1-to-v2",
    },
    operators: {},
    _initialized: v1._initialized === true,
    transition_history: Array.isArray(v1.transition_history)
      ? v1.transition_history.slice()
      : [],
  };
}

// ---- operative posture ------------------------------------------------------

/**
 * Compute the operative posture for a given person_id.
 *
 * Operative = min(operator_posture, repo_floor_posture).
 * New operator default: L2_SUPERVISED.
 * Missing repo_floor default: L5_DELEGATED.
 *
 * Returns { posture, source } where source is "operator" | "floor" | "min".
 * "min" indicates the values were equal; "operator"/"floor" indicates which
 * one was more restrictive.
 */
function computeOperativePosture(posture, personId) {
  if (!posture || typeof posture !== "object") {
    throw new Error("computeOperativePosture: posture must be an object");
  }
  if (typeof personId !== "string" || !personId) {
    throw new Error(
      "computeOperativePosture: personId must be a non-empty string",
    );
  }
  const opEntry =
    posture.operators && posture.operators[personId]
      ? posture.operators[personId]
      : null;
  const operatorPosture =
    opEntry && _isValidPosture(opEntry.posture)
      ? opEntry.posture
      : "L2_SUPERVISED";
  const floorPosture =
    posture.repo_floor && _isValidPosture(posture.repo_floor.posture)
      ? posture.repo_floor.posture
      : "L5_DELEGATED";
  const opIdx = POSTURE_INDEX[operatorPosture];
  const fIdx = POSTURE_INDEX[floorPosture];
  let chosen;
  let source;
  if (opIdx < fIdx) {
    chosen = operatorPosture;
    source = "operator";
  } else if (fIdx < opIdx) {
    chosen = floorPosture;
    source = "floor";
  } else {
    chosen = operatorPosture; // equal — either works
    source = "min";
  }
  return { posture: chosen, source };
}

// ---- trust-root surfacing (R6-S-06 latest-wins) -----------------------------

/**
 * Resolve the trust root from the folded log. Per architecture §6.1 +
 * §2.2 fold rules 9a/9c, the trust root is the LATEST cached, owner-bound,
 * signed `genesis-anchor` OR `genesis-migration` record — the migration
 * supersedes the anchor.
 *
 * The fail-CLOSED hard-block on absent / unverifiable trust root lives in
 * `.claude/hooks/genesis-anchor-guard.js` (M0). This function SURFACES the
 * cached trust root for downstream consumers (C2 gate matrix; M5 SessionStart
 * banner). It does NOT verify signatures — the engine pre-verifies records
 * via rule-1 before they enter `acceptedRecords`.
 *
 * Returns the v2 trust_root object shape OR null when no anchor exists.
 */
function resolveTrustRoot(acceptedRecords, roster) {
  if (!Array.isArray(acceptedRecords)) return null;
  // Build the set of verified_ids bound to owner-role persons in the roster.
  //
  // F14 HIGH-1: skip persons with host_role === "ci". Per R5-S-04
  // (eligibility.js::CI_FOREVER_INELIGIBLE_CONTEXTS), CI hosts are
  // audit-only and NEVER eligible to bind the trust root — even if
  // their key is owner-role in the roster (e.g. a deploy key present
  // for audit-log signing). Without this filter, a CI-host owner key
  // could rebase the trust root just by signing a genesis-anchor or
  // genesis-migration record, because rule-1 verification would pass.
  // The same filter is enforced everywhere else: derive-n.js:86-90,
  // fold-rule-9b._verifyCoSigner, fold-rule-9c._verifyCoSigner, and
  // coordination-log._checkRule5 (all via eligibility.isEligibleSigner
  // post-MED-3 consolidation). This is the resolveTrustRoot-side
  // mirror — same predicate, applied at the trust-root surfacing step.
  const ownerVerifiedIds = new Set();
  // Track whether the roster declares ANY owner-role persons (regardless of
  // host_role) so we can distinguish the genuine empty-roster test-sandbox
  // case from the "all owners filtered to CI" case below.
  let rosterDeclaresOwners = false;
  if (roster && roster.persons && typeof roster.persons === "object") {
    for (const person of Object.values(roster.persons)) {
      if (!person || person.role !== "owner") continue;
      rosterDeclaresOwners = true;
      if (person.host_role === "ci") continue;
      const keys = Array.isArray(person.keys) ? person.keys : [];
      for (const k of keys) {
        if (k && typeof k.fingerprint === "string") {
          ownerVerifiedIds.add(k.fingerprint);
        }
      }
    }
  }
  let latest = null; // {seq, ts, verified_id, genesis_generation}
  for (const r of acceptedRecords) {
    if (!r || typeof r !== "object") continue;
    if (r.type !== "genesis-anchor" && r.type !== "genesis-migration") continue;
    // Owner-bind: when the roster declares owners, only eligible owner-
    // signed anchors qualify. When the roster declares NO owners (test
    // sandbox), accept any signed anchor — the engine has already done
    // rule-1 verification.
    //
    // F14 HIGH-1: a roster that declares owners but has all owner keys
    // filtered to host_role:ci yields rosterDeclaresOwners=true and
    // ownerVerifiedIds.size=0. In that case NO anchor can bind the
    // trust root — every owner key is audit-only per R5-S-04. The
    // pre-hardening fallback would have accepted any signed anchor.
    if (rosterDeclaresOwners) {
      if (!ownerVerifiedIds.has(r.verified_id || "")) continue;
    }
    // else: empty-roster sandbox path — accept any signed anchor.
    const seq = typeof r.seq === "number" ? r.seq : -1;
    const ts = typeof r.ts === "string" ? r.ts : "";
    let generation = 0;
    if (r.type === "genesis-anchor") {
      generation =
        typeof r.content?.genesis_generation === "number"
          ? r.content.genesis_generation
          : 0;
    } else {
      // genesis-migration — `to_genesis_generation` is authoritative
      generation =
        typeof r.content?.to_genesis_generation === "number"
          ? r.content.to_genesis_generation
          : 0;
    }
    // R6-S-06 latest-wins: highest seq wins; tiebreak on ts (lexicographic ISO).
    if (
      latest === null ||
      seq > latest.anchor_record_seq ||
      (seq === latest.anchor_record_seq && ts > latest.anchor_record_ts)
    ) {
      latest = {
        verified_id: r.verified_id || "",
        anchor_record_seq: seq,
        anchor_record_ts: ts,
        genesis_generation: generation,
      };
    }
  }
  return latest;
}

// ---- 5-case corrupt-state discrimination ------------------------------------

/**
 * Read-only structural discrimination of repo state per architecture §6.1.
 * The 5 cases collapse to four dispositions:
 *
 *   "use-cache"     — cache valid, log valid, no recompute needed.
 *   "refold"        — corrupt cache + intact log → recompute from log.
 *   "fresh-repo-L5" — no log, no init marker → fresh-repo, repo_floor L5.
 *   "fresh-clone-L2"— init marker + empty log, no clone-init chain →
 *                     benign fresh clone, NO downgrade; new operators L2.
 *   "corrupt-L1"    — init marker + missing/truncated log WHILE
 *                     clone-init chain witness exists, OR fold integrity
 *                     failure, OR peer ref-regression → fail-closed L1.
 *
 * The 5 cases (per architecture §6.1) are: corrupt-cache, fresh-repo,
 * fresh-clone, post-init-state-damage, fold-integrity-failure. Cases 4–6
 * (post-init-damage / ref-regression / fold-integrity) collapse to
 * "corrupt-L1".
 *
 * Inputs are file paths — this function does NOT modify any file. Caller
 * decides what to do based on disposition.
 */
function discriminateState(input) {
  const o = input || {};
  const cachePath =
    typeof o.postureCachePath === "string" ? o.postureCachePath : null;
  const logPath = typeof o.logPath === "string" ? o.logPath : null;
  const initMarkerPath =
    typeof o.initializedMarkerPath === "string"
      ? o.initializedMarkerPath
      : null;
  const cloneInitWitnessPath =
    typeof o.cloneInitWitnessPath === "string" ? o.cloneInitWitnessPath : null;
  const peerRefRegression = o.peerRefRegression === true;
  const foldIntegrityFailed = o.foldIntegrityFailed === true;

  const fs = require("fs");

  const initMarkerExists = initMarkerPath && _fileExists(fs, initMarkerPath);
  const logExists = logPath && _fileExists(fs, logPath);
  const logNonEmpty = logExists && _fileNonEmpty(fs, logPath);
  const cacheExists = cachePath && _fileExists(fs, cachePath);
  const cacheParseable = cacheExists && _fileParseableJson(fs, cachePath);
  const cloneInitWitnessExists =
    cloneInitWitnessPath && _fileExists(fs, cloneInitWitnessPath);

  // Order matters: corruption signals trump benign-fresh signals.
  if (foldIntegrityFailed) {
    return {
      disposition: "corrupt-L1",
      reason:
        "fold integrity failure detected — fail-closed to L1 until repaired",
    };
  }
  if (peerRefRegression) {
    return {
      disposition: "corrupt-L1",
      reason: "peer ref-regression detected — fail-closed to L1",
    };
  }
  // Post-init state damage: init marker exists AND clone-init witness
  // exists for this clone AND log is missing/truncated.
  if (initMarkerExists && cloneInitWitnessExists && !logNonEmpty) {
    return {
      disposition: "corrupt-L1",
      reason:
        "log missing/truncated while clone-init witness survives — state damage detected",
    };
  }
  // Adversarial init-marker nuke (F50 Phase 2 security-reviewer HIGH-1, 2026-05-26):
  // init marker absent BUT clone-init witness survives. An adversary with file-write
  // access (bypassing the deny-matrix) could nuke posture.json + .bak + .initialized
  // to make the repo masquerade as fresh; the witness's separate-location existence
  // is the structural anchor that catches this — fail-closed to L1 regardless of
  // marker state when the witness has been recorded for this clone.
  if (!initMarkerExists && cloneInitWitnessExists) {
    return {
      disposition: "corrupt-L1",
      reason:
        "clone-init witness survives while .initialized marker is absent — adversarial init-marker nuke or coordinated state deletion detected",
    };
  }
  // Fresh repo: no init marker (and consequently nothing else to inspect).
  if (!initMarkerExists && !logNonEmpty) {
    return {
      disposition: "fresh-repo-L5",
      reason: "no .initialized marker and no log — fresh repo, floor L5",
    };
  }
  // Benign fresh clone: init marker exists, log is missing/empty,
  // and NO clone-init witness recorded for this clone yet.
  if (initMarkerExists && !logNonEmpty && !cloneInitWitnessExists) {
    return {
      disposition: "fresh-clone-L2",
      reason:
        "init marker + empty log + no clone-init chain — benign fresh clone; new operators L2",
    };
  }
  // Corrupt cache + intact log → recompute from log.
  if (cacheExists && !cacheParseable && logNonEmpty) {
    return {
      disposition: "refold",
      reason: "cache unparseable but log intact — recompute from log",
    };
  }
  // Cache valid, log valid → use cache.
  if (cacheParseable && logNonEmpty) {
    return {
      disposition: "use-cache",
      reason: "cache valid and log intact — use cached folded state",
    };
  }
  // Default disposition when nothing matched cleanly: re-fold if log present,
  // else treat as fresh clone. This is the safe path — never silently L5.
  if (logNonEmpty) {
    return { disposition: "refold", reason: "log present — recompute" };
  }
  return {
    disposition: "fresh-clone-L2",
    reason: "default-safe disposition — treat as fresh clone, new operators L2",
  };
}

function _fileExists(fs, p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
function _fileNonEmpty(fs, p) {
  try {
    const stat = fs.statSync(p);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}
function _fileParseableJson(fs, p) {
  try {
    const content = fs.readFileSync(p, "utf8");
    if (!content || !content.trim()) return false;
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

// ---- partition-adjusted posture (consumes fold-rule-9d) ---------------------

/**
 * Adjust operative posture by the partition signal from fold-rule-9d.
 *
 * Per architecture §6.1 disposition for the post-migration partition case:
 * when the local clone's `genesis_generation` is below the peer-observed
 * high-water (a partition is detected), the operator is in "halt-and-report"
 * mode — operative posture degrades to at most L3_SHARED_PLANNING. This
 * is a cap, not an override: if the local operative posture is ALREADY
 * more restrictive than L3 (e.g. L1 or L2), the more-restrictive value
 * survives.
 *
 * When `partitioned: false`, the operative posture passes through unchanged.
 */
function partitionAdjustedPosture(operativePosture, partitionResult) {
  if (!_isValidPosture(operativePosture)) {
    throw new Error(
      "partitionAdjustedPosture: unknown operative posture '" +
        operativePosture +
        "'",
    );
  }
  const partitioned = partitionResult && partitionResult.partitioned === true;
  if (!partitioned) return operativePosture;
  // Cap at L3_SHARED_PLANNING; the architecture explicitly says
  // "halt-and-report", NOT a fail-closed L1.
  return minPosture(operativePosture, "L3_SHARED_PLANNING");
}

module.exports = {
  POSTURE_LADDER,
  posturesAreOrdered,
  minPosture,
  validatePostureV2Schema,
  migrateV1ToV2,
  computeOperativePosture,
  resolveTrustRoot,
  discriminateState,
  partitionAdjustedPosture,
};
