/**
 * coordination-mode — the single OPT-IN switch for the multi-operator
 * coordination substrate (MO-OPT W1-a, the keystone).
 *
 * workspaces/multi-operator-optional (receipt journal/0330).
 *
 * THE PROBLEM (analysis §A):
 *   `multi-operator-coordination.md`'s claim that the guard hooks are
 *   "no-ops without an operators.roster.json" is FALSE. Four PreToolUse
 *   guards (integrity-guard, journal-write-guard, signing-mutation-guard,
 *   codify-lease) + the operator-id forced-L2 identity path block/halt a
 *   fresh SOLO repo — keyed NOT on roster presence but on independent
 *   preconditions a never-enrolled repo cannot satisfy. There is no shared
 *   on/off switch; engagement is implicit, scattered, mostly fail-open.
 *
 * THE FIX:
 *   ONE shared predicate every gate consults. When it returns OFF, each
 *   gate selects its already-present dormant passthrough/early-return; the
 *   substrate degrades to a true no-op. When it returns ON, every gate
 *   behaves EXACTLY as today (the S6 byte-unchanged invariant — the
 *   predicate adds a single early branch on the OFF path only).
 *
 * PRECEDENCE (highest → lowest; first decisive tier wins):
 *   1. opts.enabled (strict boolean)      — programmatic/test injection.
 *   2. local override file                 — `.claude/learning/coordination-mode.json`
 *      `{ "enabled": <bool> }`. Never-synced state-class file (the SAME
 *      visibility class as posture.json). The ONLY explicit switch a
 *      downstream CONSUMER has — a consumer never receives ecosystem.json.
 *   3. ecosystem.json                      — `coordination.enabled` (strict
 *      boolean) in `.claude/bin/ecosystem.json` (honoring $LOOM_ECOSYSTEM_CONFIG,
 *      the same override the ESM ecosystem-config loader uses). The explicit
 *      switch for loom + a client fork (both carry an ecosystem.json).
 *   4. implicit                            — roster present AND genesis
 *      anchored (a non-empty `genesis.root_commit`). Back-compat: the ~12
 *      already-enrolled repos stay ON with NO config change, because
 *      "genesis anchored" already means someone deliberately turned this on.
 *   5. default                             — OFF.
 *
 * WHY SYNCHRONOUS + fs-direct (NOT the ESM ecosystem-config.mjs loader):
 *   The four guards are PreToolUse hooks; a synchronous predicate is callable
 *   from ANY guard regardless of whether its decision path is sync or async,
 *   needs no await-refactor (which would risk the S6 byte-unchanged
 *   invariant), and avoids the CJS→ESM `await import()` boundary. The loader's
 *   only unique contribution for THIS predicate is tier-3 (a single optional
 *   boolean), which a sync `fs.readFileSync` + `JSON.parse` reads directly.
 *   We deliberately do NOT replicate the loader's schema_version-fails-loud
 *   gate: the `coordination.enabled` toggle is a shape-stable boolean, and a
 *   predicate consulted inside a guard MUST NEVER throw into the guard
 *   (zero-tolerance.md Rule 3) — every fs/parse failure is caught and the
 *   tier is treated as inconclusive (fall through), with the reason attached
 *   to the result's `warning` field.
 *
 * OBSERVABILITY (G1 R2): the `warning` field rides the RICH result of
 *   coordinationMode(); the ergonomic isCoordinationEnabled() accessor returns
 *   only the boolean and DISCARDS it. The operator-facing surface for a
 *   security-relevant warning (a refused enrolled-disable tamper, or an
 *   indeterminate-enrollment OFF) is multi-operator-sessionstart.js, which calls
 *   coordinationMode() and emits an advisory banner line when result.warning is
 *   present — so the disposition is observable, not silent.
 *
 * RETURN SHAPE (typed so callers/tests can assert WHY, not just WHETHER):
 *   {
 *     enabled: boolean,
 *     source:  "opts" | "local-override" | "ecosystem-config"
 *            | "implicit-roster-genesis" | "default-off",
 *     warning?: string   // present when a tier was skipped (read/parse error)
 *                        // OR a tier-2 enrolled-disable was refused; surfaced
 *                        // operator-side at session-start (see OBSERVABILITY).
 *   }
 *
 * Style: CommonJS to match sibling lib/* guard modules. Pure node:fs, no deps.
 */

"use strict";

const fs = require("fs");
const path = require("path");

// Memoize per resolved repoDir for the common (no-injected-opts) call so a
// guard invoking the predicate once per process pays a single read. Injected
// opts ALWAYS recompute (test seam). One-shot hook processes barely benefit
// from the cache; it exists mostly for in-process test ergonomics + any future
// caller that consults the predicate more than once.
let _cache = new Map(); // repoDir -> result

/**
 * Test/CLI hook — drop the memoized results so changed fixtures re-read.
 *
 * Invalidation contract (G1 R1 reviewer LOW-2): the per-repoDir cache holds the
 * FIRST resolved result for the process lifetime. This is correct for the
 * one-shot PreToolUse hook model (each invocation is a fresh process). A
 * long-lived IN-PROCESS caller (a test runner, or a future in-process
 * orchestrator) that resolves a repoDir as OFF and then ENROLLS it mid-process
 * (writes roster+genesis / ecosystem.json / the local override) MUST call
 * _resetCache() after the mutation, or it will be served the stale OFF result.
 */
function _resetCache() {
  _cache = new Map();
}

function _readJsonSafe(p) {
  // Returns { ok:true, value } | { ok:false, absent:true } | { ok:false, error }.
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return { ok: false, absent: true };
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return {
      ok: false,
      error: `parse error: ${e && e.message ? e.message : String(e)}`,
    };
  }
}

function _ecosystemConfigPath(repoDir, opts) {
  if (
    opts &&
    typeof opts.ecosystemConfigPath === "string" &&
    opts.ecosystemConfigPath
  ) {
    return opts.ecosystemConfigPath;
  }
  const env = process.env.LOOM_ECOSYSTEM_CONFIG;
  if (env && env.trim() !== "" && path.isAbsolute(env)) return env;
  return path.join(repoDir, ".claude", "bin", "ecosystem.json");
}

function _localOverridePath(repoDir, opts) {
  if (
    opts &&
    typeof opts.localOverridePath === "string" &&
    opts.localOverridePath
  ) {
    return opts.localOverridePath;
  }
  return path.join(repoDir, ".claude", "learning", "coordination-mode.json");
}

function _rosterPath(repoDir, opts) {
  if (opts && typeof opts.rosterPath === "string" && opts.rosterPath) {
    return opts.rosterPath;
  }
  return path.join(repoDir, ".claude", "operators.roster.json");
}

/**
 * Is the multi-operator coordination substrate enabled for `repoDir`?
 *
 * @param {string} repoDir - absolute repo root (the MAIN checkout; callers
 *   inside a worktree resolve via state-resolver first, mirroring the other
 *   guards' main-checkout discipline).
 * @param {object} [opts]
 * @param {boolean} [opts.enabled] - programmatic override (tier 1).
 * @param {string} [opts.ecosystemConfigPath] / [opts.localOverridePath] /
 *   [opts.rosterPath] - path injection (tests).
 * @returns {{enabled: boolean, source: string, warning?: string}}
 */
function coordinationMode(repoDir, opts) {
  const o = opts || {};
  const rd = repoDir || process.cwd();

  // G1 R1 reviewer LOW-1: the `enabled` clause requires a BOOLEAN, symmetric
  // with tier-1 below — a non-boolean `enabled` (e.g. {enabled:"yes"}) is NOT a
  // valid programmatic override, so it neither bypasses the cache here nor fires
  // tier-1; it is uniformly ignored and resolution falls through to the file
  // tiers. Path injections always bypass the cache (tests).
  const injected =
    (Object.prototype.hasOwnProperty.call(o, "enabled") &&
      typeof o.enabled === "boolean") ||
    o.ecosystemConfigPath ||
    o.localOverridePath ||
    o.rosterPath;

  if (!injected && _cache.has(rd)) return _cache.get(rd);

  const warnings = [];
  let result;

  // Tier 1 — programmatic override.
  if (
    Object.prototype.hasOwnProperty.call(o, "enabled") &&
    typeof o.enabled === "boolean"
  ) {
    result = { enabled: o.enabled, source: "opts" };
  }

  // Tier 2 — local override file (the consumer escape hatch; never-synced).
  //
  // SECURITY — ASYMMETRIC PRECEDENCE (G1 R1 security-reviewer HIGH). The local
  // override is gitignored state an operator can write with NO commit / audit
  // trail. If it could force OFF, a malicious operator on an ENROLLED repo could
  // write {enabled:false}, silently disable the WHOLE substrate (integrity-guard
  // codify-branch enforcement included), then edit operators.roster.json
  // off-codify to add themselves as owner — an escalation the pre-W1 substrate
  // did not permit. So the local override may:
  //   - FORCE ON (enabled:true) — always honored (harmless escalation of trust);
  //   - set the mode on a genuinely NON-enrolled repo — the consumer opt-in/out;
  // but a {enabled:false} is REFUSED when the repo is ENROLLED (roster + anchored
  // genesis) OR its enrollment is INDETERMINATE (roster present-but-unreadable —
  // fail-safe toward keeping the substrate ON; G1 R2 reviewer + cc-architect LOW).
  // The refusal attaches result.warning — the LOAD-BEARING guarantee is the ON
  // disposition; the warning is surfaced operator-side at session-start
  // (multi-operator-sessionstart.js, G1 R2) so a planted-override tamper is NOT
  // silent. Disabling an enrolled repo is possible ONLY via the COMMITTED,
  // auditable ecosystem.json (tier 3) or a genesis teardown ceremony.
  if (!result) {
    const lp = _localOverridePath(rd, o);
    const r = _readJsonSafe(lp);
    if (r.ok && r.value && typeof r.value.enabled === "boolean") {
      const refuseReason =
        r.value.enabled === false ? _refuseLocalDisable(rd, o) : null;
      if (refuseReason) {
        warnings.push(
          `local-override {enabled:false} REFUSED — ${refuseReason}; ` +
            "disable an enrolled repo via committed ecosystem.json instead",
        );
      } else {
        result = { enabled: r.value.enabled, source: "local-override" };
      }
    } else if (!r.ok && r.error) {
      warnings.push(`local-override unreadable (${lp}): ${r.error}`);
    }
  }

  // Tier 3 — ecosystem.json explicit switch.
  if (!result) {
    const ep = _ecosystemConfigPath(rd, o);
    const r = _readJsonSafe(ep);
    if (
      r.ok &&
      r.value &&
      r.value.coordination &&
      typeof r.value.coordination.enabled === "boolean"
    ) {
      result = {
        enabled: r.value.coordination.enabled,
        source: "ecosystem-config",
      };
    } else if (!r.ok && r.error) {
      warnings.push(`ecosystem-config unreadable (${ep}): ${r.error}`);
    }
  }

  // Tier 4 — implicit: roster present AND genesis anchored.
  if (!result) {
    const rp = _rosterPath(rd, o);
    const r = _readJsonSafe(rp);
    if (
      r.ok &&
      r.value &&
      r.value.genesis &&
      _isGenesisAnchored(r.value.genesis)
    ) {
      result = { enabled: true, source: "implicit-roster-genesis" };
    } else if (!r.ok && r.error) {
      // MO-OPT W2-c (raw-clone residual 2): a PRESENT-but-UNREADABLE roster is
      // an INDETERMINATE-enrollment repo — a roster file EXISTS (someone set this
      // up), it just cannot be parsed. Fail-closed toward ON (the substrate's
      // enforcement stays UP) rather than silently disabling every guard on a
      // possibly-enrolled repo whose roster got corrupted. Symmetric with the
      // tier-2 _refuseLocalDisable "indeterminate enrollment → keep ON" fence.
      // A genuinely fresh solo repo has NO roster (ENOENT → r.absent) and stays
      // OFF via tier-5; only a corrupt-but-present roster flips to fail-closed ON.
      warnings.push(
        `roster unreadable (${rp}): ${r.error} — fail-closed toward ON (indeterminate enrollment)`,
      );
      result = { enabled: true, source: "implicit-corrupt-roster-failclosed" };
    }
  }

  // Tier 5 — default OFF.
  if (!result) result = { enabled: false, source: "default-off" };

  if (warnings.length) result.warning = warnings.join("; ");

  if (!injected) _cache.set(rd, result);
  return result;
}

/**
 * Genesis is "anchored" when the roster's genesis block carries a non-empty
 * root_commit — the trust root is established. A roster with NO genesis block
 * (or an empty root_commit) is NOT enrolled: it falls through to default-OFF,
 * the conservative disposition.
 */
function _isGenesisAnchored(genesis) {
  if (!genesis || typeof genesis !== "object") return false;
  const rc = genesis.root_commit;
  if (typeof rc !== "string" || rc.trim().length === 0) return false;
  // MO-OPT W2-c (raw-clone residual 1 / S2 explicit-enablement): a PLACEHOLDER-
  // genesis is RESERVED-but-unverified, NOT anchored. The clean-instantiate
  // ceremony resets a client clone to a placeholder roster (repo_owner
  // "PLACEHOLDER-…", all-zero root_commit sentinel) precisely so the cleared
  // client stays coordination-OFF until /ecosystem-init re-anchors with a REAL
  // owner + root_commit. Without this, the schema-required non-empty root_commit
  // ("0000000") would read as "anchored" and a freshly-cleared client would be
  // disruptively coordination-ON by inheritance. The ~12 real-enrolled repos
  // carry a real repo_owner + real root_commit, so they stay anchored (no
  // regression — the S6 enabled-path baseline holds).
  if (
    typeof genesis.repo_owner === "string" &&
    genesis.repo_owner.startsWith("PLACEHOLDER-")
  )
    return false;
  if (/^0+$/.test(rc.trim())) return false;
  return true;
}

/**
 * Should a tier-2 local-override {enabled:false} be REFUSED for `repoDir`?
 * Returns a human reason STRING when refusal is required, else null (honor).
 *
 * The roster read has THREE outcomes (G1 R2 reviewer + cc-architect LOW —
 * distinguish ABSENT from UNREADABLE so an ambiguous-enrollment OFF is never
 * silent):
 *   - ABSENT (ENOENT)                         → null (honor; genuinely no roster,
 *                                                a clearly non-enrolled consumer).
 *   - PRESENT + readable + anchored genesis   → "enrolled repo (...)" (REFUSE —
 *                                                the enrolled-disable escalation).
 *   - PRESENT + readable + NOT anchored       → null (honor; genuinely un-enrolled
 *                                                — a roster without a trust root).
 *   - PRESENT + UNREADABLE/corrupt            → "indeterminate enrollment (...)"
 *                                                (REFUSE — fail-safe toward ON; the
 *                                                returned reason becomes a surfaced
 *                                                warning, so the OFF disposition on
 *                                                an unknown-enrollment repo is loud).
 * Uses the SAME _isGenesisAnchored predicate as tier-4 so there is no
 * enrollment-classification drift between the refusal fence and the implicit tier.
 */
function _refuseLocalDisable(repoDir, opts) {
  const r = _readJsonSafe(_rosterPath(repoDir, opts));
  if (r.absent) return null;
  if (!r.ok) return "indeterminate enrollment (roster present but unreadable)";
  return r.value && r.value.genesis && _isGenesisAnchored(r.value.genesis)
    ? "enrolled repo (roster + anchored genesis)"
    : null;
}

/** Ergonomic boolean accessor for guard call sites: `if (!isCoordinationEnabled(repoDir)) passthrough();` */
function isCoordinationEnabled(repoDir, opts) {
  return coordinationMode(repoDir, opts).enabled;
}

module.exports = {
  coordinationMode,
  isCoordinationEnabled,
  _resetCache,
  // Test-only — NOT part of the supported API.
  _test_isGenesisAnchored: _isGenesisAnchored,
};
