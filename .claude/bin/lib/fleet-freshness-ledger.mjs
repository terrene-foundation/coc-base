/*
 * ============================================================================
 *  fleet-freshness-ledger — loom-ROOT freshness ledger writer (W1-T2)
 * ============================================================================
 *
 *  Records the T1 probe's per-consumer ARTIFACT-CONTENT-DRIFT results into a
 *  durable ledger at LOOM ROOT — the surface the P1 dashboard (Build #5)
 *  later reads. Append/update per run. (Metric corrected 2026-06-21 from
 *  git-commit-distance to canonical-subset artifact drift — see
 *  fleet-freshness.mjs header for the topology rationale.)
 *
 *  ──────────────────────────────────────────────────────────────────────────
 *  WHERE the ledger lives, and WHY (analysis §5 critic gap #5 — the no-sync
 *  self-collision to avoid):
 *
 *    Path:  <loom-root>/.fleet-freshness-ledger.json   (LEDGER_BASENAME)
 *
 *    - It is at LOOM ROOT — NOT in .claude/learning/ (which is gitignored
 *      per-clone coordination/posture state, MUST-NOT-sync per
 *      multi-operator-coordination.md) and NOT a synced per-consumer fold.
 *      A naive per-consumer health fold cannot feed a fleet view without
 *      breaking the no-sync rule; this is a loom-root AGGREGATE instead.
 *
 *    - It is OUTSIDE the .claude/ source tree entirely, so NO sync-manifest
 *      emit glob (every tier glob is .claude/-source-tree-relative) can match
 *      it — /sync-to-use and /sync-to-build structurally cannot carry it.
 *      This invariant is TESTED structurally in W1-T4a (the not-synced test),
 *      not merely asserted here (T2 LOW-3 coupling).
 *
 *  COMMITTED vs GITIGNORED decision (T2 open implement-time decision):
 *    => GITIGNORED (the file is added to .gitignore as `.fleet-freshness-ledger.json`).
 *    Rationale: the ledger is per-clone OBSERVATION scratch — loom observing
 *    the fleet from THIS checkout, regenerated on demand by `/inspect health`.
 *    A committed ledger would churn on every run (each run re-stamps the
 *    timestamp + tips) AND raise the not-synced stakes (a committed file is
 *    exactly what a stray sync glob could sweep). Gitignored avoids both: no
 *    per-run commit churn, and the not-synced invariant holds by construction
 *    (the file is never tracked, so even an over-broad glob has nothing to
 *    pick up). The not-synced T4a test passes either way (path is outside
 *    .claude/learning/ AND unmatched by any emit glob); gitignored is the
 *    lower-churn, lower-risk choice. (Note: distinct from the
 *    multi-operator-coordination.md MUST-NOT — that bars SYNCING state files;
 *    this ledger is neither synced nor in .claude/learning/.)
 *  ──────────────────────────────────────────────────────────────────────────
 *
 *  Ledger record shape (read-back asserts this shape, per testing.md
 *  state-persistence verification):
 *
 *    {
 *      "schema_version": 2,
 *      "updated_at":     "<ISO-8601>",          // last write timestamp
 *      "scope":          "canonical-subset",    // P0 metric scope (from probe)
 *      "deps_scope":     "declared-manifest-currency" | null,  // W2a-T4, additive
 *      "consumers": {
 *        "<logical-key>": {
 *          "variant":       "py"|"rs"|"rb"|"base"|null,
 *          "drifted":       <int> | null,        // canonical files whose sha differs
 *          "in_sync":       <int> | null,
 *          "total":         <int> | null,
 *          "stale":         true | false | null, // drifted > 0
 *          "drifted_paths": ["<rel>", ...],
 *          "reachable":     true | false,
 *          "reason":        null | "<diagnostic>",
 *          "observed_at":   "<ISO-8601>",
 *          "deps":          null | {             // W2a-T4 deps-currency, ADDITIVE
 *            "manifest":        "pyproject.toml"|"Cargo.toml"|"package.json"|null,
 *            "declared":        <int> | null,    // declared direct deps
 *            "capped":          <int> | null,    // deps with a `<` defensive cap
 *            "pinned":          <int> | null,    // deps pinned to an exact version
 *            "capped_examples": ["<name>", ...],
 *            "pinned_examples": ["<name>", ...],
 *            "reachable":       true | false,    // manifest read + parsed
 *            "reason":          null | "<diagnostic>"
 *          },
 *          "posture":       null | {             // W2a-T5 trust-posture, ADDITIVE
 *            "repo_floor":      "L1_…".."L5_…" | null,
 *            "operative":       "L1_…".."L5_…" | null,  // min(floor, …operators)
 *            "operators":       <int> | null,
 *            "reachable":       true | false,    // posture.json read + schema-valid
 *            "reason":          null | "<diagnostic>"
 *          }
 *        },
 *        ...
 *      }
 *    }
 *
 *  SCHEMA NOTE (W2a-T4/T5): the per-consumer `deps` / `posture` blocks + the
 *  top-level `deps_scope` / `posture_scope` / `compliance` fields are ALL
 *  ADDITIVE — `schema_version` stays 2 per this file's documented "future fields
 *  are additive; consumer parsers MUST tolerate unknown keys" contract. The
 *  drift fields are byte-for-byte unchanged; `deps` / `posture` are null when no
 *  corresponding report is supplied (the drift-only `/inspect health` path).
 *  The `deps` signal is DEPENDENCY-CURRENCY (declared-manifest analysis per
 *  dependencies.md), NOT a CVE/vuln scan — see fleet-deps.mjs header. The
 *  `posture` signal is the OBSERVED operative trust-posture, read per-repo and
 *  NEVER synced (trust-posture.md MUST-NOT). The top-level `compliance` is the
 *  honest canon O1-methodology-artifact baseline (0 today — roadmap, NOT a
 *  fabricated per-consumer signal) — see fleet-compliance-posture.mjs header.
 *
 *  Node ESM, zero dependencies.
 * ============================================================================
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// lib/ → bin/ → .claude/ → loom root
export const LOOM_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");

// The ledger basename — at loom ROOT, NOT under .claude/. This is the
// load-bearing not-synced invariant: a loom-root file is outside the .claude/
// source tree every sync-manifest emit glob is relative to.
export const LEDGER_BASENAME = ".fleet-freshness-ledger.json";
export const SCHEMA_VERSION = 2;

/** Resolve the ledger path. Defaults to loom root. */
export function ledgerPath(root = LOOM_ROOT) {
  return path.join(root, LEDGER_BASENAME);
}

/**
 * Project a deps-currency probe report (fleet-deps.mjs) into a per-target map
 * of `deps` blocks. Pure. Returns an empty Map when depsReport is absent.
 */
function depsByTarget(depsReport) {
  const map = new Map();
  if (!depsReport || typeof depsReport !== "object" || !Array.isArray(depsReport.results)) {
    return map;
  }
  for (const d of depsReport.results) {
    map.set(d.target, {
      manifest: d.manifest ?? null,
      declared: typeof d.declared === "number" ? d.declared : null,
      capped: typeof d.capped === "number" ? d.capped : null,
      pinned: typeof d.pinned === "number" ? d.pinned : null,
      capped_examples: Array.isArray(d.capped_examples) ? d.capped_examples : [],
      pinned_examples: Array.isArray(d.pinned_examples) ? d.pinned_examples : [],
      reachable: d.reachable === true,
      reason: d.reason ?? null,
    });
  }
  return map;
}

/**
 * Project a compliance/posture probe report (fleet-compliance-posture.mjs) into
 * a per-target map of `posture` blocks. Pure. Returns an empty Map when the
 * report is absent.
 */
function postureByTarget(cpReport) {
  const map = new Map();
  if (!cpReport || typeof cpReport !== "object" || !Array.isArray(cpReport.results)) {
    return map;
  }
  for (const p of cpReport.results) {
    map.set(p.target, {
      repo_floor: p.repo_floor ?? null,
      operative: p.operative ?? null,
      operators: typeof p.operators === "number" ? p.operators : null,
      reachable: p.reachable === true,
      reason: p.reason ?? null,
    });
  }
  return map;
}

/**
 * Project a T1 probe report into a ledger record.
 * Pure (no I/O) so it is independently testable.
 *
 * @param {object}   report          the freshness (drift) probe report.
 * @param {object}   [opts]
 * @param {object}   [opts.depsReport]  OPTIONAL fleet-deps.mjs report (W2a-T4).
 *                                      When present, each consumer gains an
 *                                      ADDITIVE `deps` block (null when the
 *                                      target is absent from depsReport).
 * @param {object}   [opts.compliancePostureReport]  OPTIONAL
 *                                      fleet-compliance-posture.mjs report (W2a-T5).
 *                                      When present, each consumer gains an
 *                                      ADDITIVE `posture` block (null when the
 *                                      target is absent), and the record gains a
 *                                      top-level honest `compliance` baseline.
 * @param {Function} [opts.now]       ISO timestamp source (injected in tests).
 */
export function buildLedgerRecord(
  report,
  { now = () => new Date().toISOString(), depsReport = null, compliancePostureReport = null } = {},
) {
  if (!report || typeof report !== "object" || !Array.isArray(report.results)) {
    throw new TypeError("buildLedgerRecord: report must be a probe report with a results[] array");
  }
  const ts = now();
  const deps = depsByTarget(depsReport);
  const posture = postureByTarget(compliancePostureReport);
  const consumers = {};
  for (const r of report.results) {
    consumers[r.target] = {
      variant: r.variant,
      drifted: r.drifted,
      in_sync: r.in_sync,
      total: r.total,
      stale: typeof r.drifted === "number" ? r.drifted > 0 : null,
      drifted_paths: r.drifted_paths || [],
      reachable: r.reachable,
      reason: r.reason,
      observed_at: ts,
      // ADDITIVE (W2a-T4): null when no deps report, or the target was not
      // probed for deps — never silently "current". Drift fields above unchanged.
      deps: deps.has(r.target) ? deps.get(r.target) : null,
      // ADDITIVE (W2a-T5): null when no compliance/posture report, or the target
      // was not probed — never silently "L5/healthy". Drift+deps above unchanged.
      posture: posture.has(r.target) ? posture.get(r.target) : null,
    };
  }
  return {
    schema_version: SCHEMA_VERSION,
    updated_at: ts,
    scope: report.scope || null,
    deps_scope: depsReport && depsReport.scope ? depsReport.scope : null,
    // ADDITIVE (W2a-T5): the posture observation scope + the honest fleet
    // compliance baseline (canon O1-methodology count; null when no report).
    posture_scope: compliancePostureReport && compliancePostureReport.scope ? compliancePostureReport.scope : null,
    compliance:
      compliancePostureReport && compliancePostureReport.compliance ? compliancePostureReport.compliance : null,
    consumers,
  };
}

/**
 * Write a ledger record to disk (atomic: tmp + rename). Returns the path
 * written. The write is the ONLY mutation this module performs; the T1 probe
 * itself is read-only. `depsReport` (W2a-T4) and `compliancePostureReport`
 * (W2a-T5) are OPTIONAL additive merges, forwarded to buildLedgerRecord.
 */
export function writeLedger(report, { root = LOOM_ROOT, now, depsReport = null, compliancePostureReport = null } = {}) {
  const record = buildLedgerRecord(report, { ...(now ? { now } : {}), depsReport, compliancePostureReport });
  const dest = ledgerPath(root);
  const tmp = `${dest}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, dest);
  return dest;
}

/**
 * Read the ledger back. Returns the parsed record, or null when absent.
 * (Read-back verification per testing.md state-persistence.)
 */
export function readLedger({ root = LOOM_ROOT } = {}) {
  const dest = ledgerPath(root);
  let raw;
  try {
    raw = fs.readFileSync(dest, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  return JSON.parse(raw);
}
