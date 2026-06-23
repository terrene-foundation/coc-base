/*
 * ============================================================================
 *  fleet-freshness — read-only consumer-vs-CANON artifact-content DRIFT probe
 *                    (W1-T1, metric-corrected 2026-06-21)
 * ============================================================================
 *
 *  METRIC CORRECTION (co-owner-approved, 2026-06-21). The original probe
 *  measured git-commit-distance (`git rev-list consumer..canon`). That metric
 *  is STRUCTURALLY UNKNOWN for this fleet: loom and its ~30 consumers are
 *  DISJOINT GIT HISTORIES — consumers receive COC artifacts by file-copy
 *  /sync, NOT by git merges — so canon's commit objects are never present in a
 *  consumer checkout and the distance is UNKNOWN-for-everyone. Commit-distance
 *  is the wrong metric for a file-synced topology.
 *
 *  This probe measures ARTIFACT-CONTENT DRIFT instead: "does each consumer's
 *  on-disk `.claude/` artifact set match what loom would currently sync to
 *  it?" — the signal that is actually meaningful for file-synced consumers.
 *
 *  ──────────────────────────────────────────────────────────────────────────
 *  REUSE, NOT REIMPLEMENTATION (the critical constraint):
 *
 *  The authoritative expected-content baseline is produced by the EXISTING
 *  sync machinery — this probe does NOT hand-roll variant/overlay/strip
 *  composition (that would drift from real /sync semantics, the exact bug
 *  class). It drives `sync-tier-aware.mjs --target <variant> --dry-run --json`
 *  (the same per-target tier-subscription + compose machinery `/sync-to-use`
 *  Gate-2 uses) to get the authoritative file PLAN per consumer.
 *
 *  P0 SCOPE — CANONICAL-SUBSET sha256 divergence (explicit scoped deferral):
 *  the probe compares the CANONICAL subset of that plan — the
 *  `action: "copy", strip: false` entries: the GLOBAL, non-variant,
 *  non-stripped artifacts whose expected deployed bytes equal loom's SOURCE
 *  bytes VERBATIM. For those, drift = sha256(loom/<path>) != sha256(consumer/<path>).
 *  This is EXACTLY `sync-consumer-dryrun.mjs`'s canonical-divergence gate
 *  (sha256 consumer-vs-resolved-template), GENERALIZED across resolveAll().
 *
 *  VARIANT-OVERLAY + STRIP drift (the `action:"overlay"` and `strip:true`
 *  entries) is the **Wave-2 extension** — DEFERRED, not computed here. Driving
 *  full per-variant compose-to-tmp + strip across the whole fleet to derive
 *  the expected bytes for those entries is the heavier build; P0 ships the
 *  canonical-subset signal that is meaningful today.
 *
 *  Mirrors the read-only contract of `check-sync-freshness.mjs` /
 *  `sync-consumer-dryrun.mjs`: sha256 reads + a `--dry-run` plan ONLY — NO
 *  fetch, NO working-tree mutation of any consumer, NO state write. Resolver-
 *  driven (every target via loom-links::resolveAll; NEVER positional, per
 *  cross-repo.md MUST-1). execFile with arg arrays — no shell-string
 *  interpolation (security.md). FAIL-LOUD (evidence-first-claims.md MUST-3):
 *  an unresolvable/unreadable consumer is reported `reachable:false` + reason,
 *  NEVER silently counted in_sync.
 *
 *  ──────────────────────────────────────────────────────────────────────────
 *  --json output shape (consumer parsers MUST tolerate unknown keys; future
 *  fields are additive, per the check-sync-freshness header convention):
 *
 *    {
 *      "scope": "canonical-subset",            // P0 metric scope (Wave-2 widens)
 *      "results": [
 *        {
 *          "target":        "<logical-key>",   // consumer resolver key
 *          "repo":          "<absolute-path>" | null,
 *          "variant":       "py"|"rs"|"rb"|"base"|null, // derived sync target
 *          "drifted":       <int> | null,      // canonical files whose sha differs
 *          "in_sync":       <int> | null,      // canonical files matching loom
 *          "total":         <int> | null,      // canonical files compared
 *          "drifted_paths": ["<rel>", ...],    // up to a cap; full count in `drifted`
 *          "reachable":     true | false,      // plan produced AND consumer readable
 *          "reason":        null | "<diagnostic>"
 *        },
 *        ...
 *      ],
 *      "overall_reachable": true | false       // every result reachable
 *    }
 *
 *  `stale` (consumer needs a /sync) == `drifted > 0`.
 *  ──────────────────────────────────────────────────────────────────────────
 *
 *  Usage (scoped INTO /inspect health per repo-scope-discipline.md):
 *    node .claude/bin/lib/fleet-freshness.mjs --json
 *
 *  Node ESM, zero dependencies.
 * ============================================================================
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { realpathSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// lib/ → bin/ → .claude/ → loom root
const LOOM_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");
const SYNC_TIER_AWARE = path.join(LOOM_ROOT, ".claude", "bin", "sync-tier-aware.mjs");

export const SCOPE = "canonical-subset";
// Cap on how many drifted paths are enumerated per consumer in the result
// (the full count is always in `drifted`; the list is for legibility).
export const DRIFTED_PATHS_CAP = 25;

// Consumer logical keys PULL canon distribution; recognized by resolver-key
// namespace prefix — NEVER by a positional path. Everything else (canon,
// atelier, build repos, governance tooling) is skipped.
const CONSUMER_KEY_PREFIXES = ["use-template.", "downstream."];

// Consumer logical key → the sync-tier-aware variant TARGET whose expected
// content set is authoritative for that consumer. Derived from
// sync-manifest.yaml::repos.<target>.templates (py/rs templates, base, rb).
const KEY_TO_VARIANT = {
  "use-template.py": "py",
  "use-template.claude-py": "py",
  "use-template.rs": "rs",
  "use-template.claude-rs": "rs",
  "use-template.claude-rb": "rb",
  "use-template.base": "base",
  "use-template.claude-base": "base",
};

/**
 * Strip absolute filesystem paths out of a string before it lands in a durable
 * ledger reason (security.md § "No secrets in logs" + upstream-issue-hygiene.md
 * MUST-2). Byte-identical to the sibling probes' scrubPath (fleet-deps.mjs /
 * fleet-compliance-posture.mjs) — applied at the PROBE source so the raw `reason`
 * is path-free even before the dashboard's render-time scrubReason (the stacked
 * defense-in-depth contract the sibling probes' headers document; this probe was
 * the W1-era original and lacked the source layer until the Wave-2a holistic G1
 * gate surfaced the asymmetry). A `catch (err)` here interpolates an `err.message`
 * that — via `execFileSync("node", [<abs SYNC_TIER_AWARE>, ...])` — can carry
 * loom's absolute checkout path; scrub it FIRST. Returns "" for non-strings.
 */
export function scrubPath(s) {
  if (typeof s !== "string" || s.length === 0) return "";
  return s.replace(/\/[\w.\-]+(?:\/[\w.\-]+)+\/?/g, "<path>");
}

/** Whether a resolver logical key denotes a canon-distribution consumer. */
export function isConsumerKey(key) {
  return CONSUMER_KEY_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Map a consumer logical key to its sync variant target. Returns the variant
 * string, or null when the key has no known variant mapping (a `downstream.*`
 * consumer whose variant is not statically known — fail-loud at the call site,
 * NEVER silently treated as in_sync).
 */
export function variantForKey(key) {
  return KEY_TO_VARIANT[key] || null;
}

/** sha256 of a file's bytes. */
function sha256File(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/**
 * Default runner for `sync-tier-aware.mjs --target <variant> --dry-run --json`.
 * execFile with an arg ARRAY (no shell). Returns the parsed plan object.
 * INJECTED in tests so the expected-content baseline is deterministic.
 */
function defaultPlanRunner(variant) {
  const out = execFileSync(
    "node",
    [SYNC_TIER_AWARE, "--target", variant, "--dry-run", "--json"],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  return JSON.parse(out);
}

/**
 * Extract the CANONICAL-subset entries from a sync-tier-aware plan: the
 * `action:"copy", strip:false` files whose deployed bytes equal loom's source
 * bytes verbatim. Returns an array of `.claude/`-relative paths.
 */
export function canonicalPathsFromPlan(plan) {
  const files = plan && plan.plan && Array.isArray(plan.plan.files) ? plan.plan.files : null;
  if (!files) {
    throw new Error("sync-tier-aware plan missing plan.files[] — cannot derive canonical set");
  }
  return files
    .filter((f) => f.action === "copy" && f.strip === false)
    .map((f) => f.path);
}

/**
 * Probe ONE consumer's canonical-subset artifact drift.
 *
 * @param {string}   key         consumer logical key.
 * @param {string}   repoDir     consumer on-disk path (resolved, never positional).
 * @param {string}   variant     sync variant target.
 * @param {Function} planRunner  (variant)=>plan; injected in tests.
 * @param {object}   [opts]
 * @param {string}   [opts.loomRoot]  loom source root (default LOOM_ROOT).
 * @returns {object} the per-consumer result row.
 */
export function probeConsumer(key, repoDir, variant, planRunner, { loomRoot = LOOM_ROOT } = {}) {
  const base = {
    target: key,
    repo: repoDir,
    variant,
    drifted: null,
    in_sync: null,
    total: null,
    drifted_paths: [],
    reachable: false,
    reason: null,
  };

  if (!variant) {
    return {
      ...base,
      reason: `consumer '${key}' has no known sync variant mapping — drift UNKNOWN (not in_sync)`,
    };
  }

  let plan;
  try {
    plan = planRunner(variant);
  } catch (err) {
    return {
      ...base,
      reason: `sync-tier-aware plan for variant '${variant}' failed — drift UNKNOWN: ${scrubPath(err && err.message)}`,
    };
  }

  let canonicalPaths;
  try {
    canonicalPaths = canonicalPathsFromPlan(plan);
  } catch (err) {
    return { ...base, reason: `cannot derive canonical set — drift UNKNOWN: ${scrubPath(err && err.message)}` };
  }

  let drifted = 0;
  let inSync = 0;
  let total = 0;
  const driftedPaths = [];
  for (const rel of canonicalPaths) {
    const loomFile = path.join(loomRoot, rel);
    const consumerFile = path.join(repoDir, rel);
    let loomSha;
    try {
      loomSha = sha256File(loomFile);
    } catch {
      // Loom source missing for a planned canonical entry is a loom-side
      // anomaly, not consumer drift — skip it rather than fabricate drift.
      continue;
    }
    total += 1;
    let consumerSha;
    try {
      consumerSha = sha256File(consumerFile);
    } catch {
      // Consumer is MISSING a canonical artifact loom would sync → drift
      // (the consumer is behind / never received it). Fail-loud as drift,
      // never silently in_sync.
      drifted += 1;
      if (driftedPaths.length < DRIFTED_PATHS_CAP) driftedPaths.push(rel);
      continue;
    }
    if (loomSha === consumerSha) {
      inSync += 1;
    } else {
      drifted += 1;
      if (driftedPaths.length < DRIFTED_PATHS_CAP) driftedPaths.push(rel);
    }
  }

  return {
    ...base,
    drifted,
    in_sync: inSync,
    total,
    drifted_paths: driftedPaths,
    reachable: true,
    reason: null,
  };
}

/**
 * The fleet probe. Enumerate consumers via the injected resolver (resolveAll),
 * compute each consumer's canonical-subset artifact drift, return structured.
 *
 * @param {object}   opts
 * @param {Function} opts.resolveAll  resolver enumeration fn (loom-links::resolveAll).
 *                                    INJECTED so tests pass a fake resolveAll
 *                                    (resolver-driven, never positional).
 * @param {Function} [opts.planRunner] (variant)=>plan; default drives
 *                                     sync-tier-aware.mjs (injected in tests).
 * @param {string}   [opts.loomRoot]  loom source root (default LOOM_ROOT).
 * @returns {object} { scope, results[], overall_reachable }
 */
export function probeFleetFreshness({
  resolveAll,
  planRunner = defaultPlanRunner,
  loomRoot = LOOM_ROOT,
} = {}) {
  if (typeof resolveAll !== "function") {
    throw new TypeError(
      "probeFleetFreshness: opts.resolveAll must be the resolver enumeration function (resolver-driven, never positional)",
    );
  }

  const resolved = resolveAll();
  const results = [];
  for (const [key, entry] of resolved) {
    if (!isConsumerKey(key)) continue;

    if (entry.kind === "error" || !entry.value) {
      results.push({
        target: key,
        repo: null,
        variant: variantForKey(key),
        drifted: null,
        in_sync: null,
        total: null,
        drifted_paths: [],
        reachable: false,
        reason: entry.error
          ? `consumer '${key}' unresolvable: ${entry.error}`
          : `consumer '${key}' not linked in resolver — drift UNKNOWN`,
      });
      continue;
    }

    if (entry.kind !== "path") {
      // A non-path resolver kind (e.g. kind:"url" — a remote-only consumer
      // declared by URL, not a local checkout) carries a truthy entry.value
      // that is NOT a local filesystem path. Fail loud as UNKNOWN — NEVER feed
      // it to probeConsumer, where path.join(<url>, rel) + readFileSync would
      // ENOENT on every artifact and fabricate a spurious 100%-drift row.
      results.push({
        target: key,
        repo: null,
        variant: variantForKey(key),
        drifted: null,
        in_sync: null,
        total: null,
        drifted_paths: [],
        reachable: false,
        reason: `consumer '${key}' is remote-only (kind:${entry.kind}) — local artifact drift UNKNOWN`,
      });
      continue;
    }

    results.push(probeConsumer(key, entry.value, variantForKey(key), planRunner, { loomRoot }));
  }

  const overall_reachable = results.every((r) => r.reachable);
  return { scope: SCOPE, results, overall_reachable };
}

// ────────────────────────────────────────────────────────────────
// CLI entry — scoped INTO /inspect health (repo-scope-discipline.md:42).
// ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else {
      process.stderr.write(`fleet-freshness: unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      "Usage: fleet-freshness.mjs [--json]\n" +
        "  Read-only consumer-vs-CANON artifact-content drift probe (canonical subset).\n" +
        "  Drives `sync-tier-aware.mjs --dry-run --json` for the expected-content baseline,\n" +
        "  then sha256-compares each canonical (copy, strip:false) artifact vs loom source.\n" +
        "  --json   emit machine-readable JSON\n",
    );
    process.exit(0);
  }

  const mod = await import(path.join(LOOM_ROOT, ".claude", "bin", "lib", "loom-links.mjs"));
  const report = probeFleetFreshness({ resolveAll: mod.resolveAll });

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(`[fleet-freshness] scope=${report.scope}\n`);
    for (const r of report.results) {
      if (r.reachable) {
        const tag = r.drifted > 0 ? `STALE (${r.drifted} drifted)` : "in-sync";
        process.stdout.write(
          `[fleet-freshness] ${r.target} (${r.variant}): ${tag} — ${r.in_sync}/${r.total} canonical artifacts match\n`,
        );
        for (const p of r.drifted_paths) process.stdout.write(`    drift: ${p}\n`);
      } else {
        process.stdout.write(`[fleet-freshness] ${r.target}: UNKNOWN\n`);
        process.stderr.write(`  reason: ${r.reason}\n`);
      }
    }
  }
  process.exit(report.overall_reachable ? 0 : 1);
}

// CLI-vs-import discriminator (mirrors check-sync-freshness.mjs).
const isMainModule = (() => {
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMainModule) {
  main().catch((err) => {
    process.stderr.write(`fleet-freshness: fatal: ${err.message}\n`);
    process.exit(2);
  });
}
