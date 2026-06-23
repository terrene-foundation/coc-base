/*
 * ============================================================================
 *  fleet-compliance-posture — read-only COMPLIANCE-currency + trust-POSTURE
 *                             observe-plane probe (W2a-T5)
 * ============================================================================
 *
 *  Build #2-completion, the compliance + posture half of the maintenance
 *  observe-plane signal enrichment (analysis §5 Build #2; §6 "buyer-credible
 *  only once it reports CVE/compliance drift, not just version distance"). It
 *  records two HONEST, EXISTING signals into the fleet ledger
 *  (`fleet-freshness-ledger.mjs`), the surface the buyer dashboard reads —
 *  WITHOUT fabricating a signal that does not exist (evidence-first-claims.md
 *  MUST-3 + recommendation-quality.md MUST-3 honest-gap).
 *
 *  ──────────────────────────────────────────────────────────────────────────
 *  SIGNAL 1 — POSTURE (per-consumer, REAL, read per-repo, NEVER synced):
 *
 *  Each consumer's TRUST-POSTURE — the L1–L5 autonomy state the COC operates
 *  at (`trust-posture.md`). Read from the consumer's per-clone
 *  `<repo>/.claude/learning/posture.json` (the folded posture cache). The
 *  reported figure is the FLEET-WORST operative posture present in the repo:
 *  `min(repo_floor, …all operators)` — the lowest trust level active — because
 *  a single degraded operator is the maintenance signal a buyer cares about.
 *  The canonical ladder + min are REUSED from `hooks/lib/posture-v2.js` (no
 *  parallel ladder → no drift).
 *
 *  NEVER-SYNCED invariant (trust-posture.md MUST-NOT / knowledge-convergence.md):
 *  posture STATE is per-repo and MUST NOT be SYNCED between repos. This probe
 *  only READS each consumer's posture.json (riding the /inspect
 *  artifact-distribution carve-out, repo-scope-discipline.md:42) and records the
 *  OBSERVED operative posture into the loom-ROOT ledger (itself never synced —
 *  outside the .claude/ source tree, fleet-freshness-ledger.mjs header). The
 *  probe NEVER writes to any consumer and NEVER copies a posture file anywhere.
 *
 *  FAIL-LOUD (evidence-first-claims.md MUST-3): a consumer with no posture.json,
 *  an unreadable/oversized one, malformed JSON, or a schema-invalid one is
 *  reported `reachable:false` + a logical-key-keyed reason — NEVER silently
 *  assumed L5/healthy. Most plain USE-template / downstream consumers do NOT run
 *  the multi-operator posture system, so UNKNOWN is the common, honest result.
 *
 *  ──────────────────────────────────────────────────────────────────────────
 *  SIGNAL 2 — COMPLIANCE (fleet baseline, HONEST existing signal, NOT fabricated):
 *
 *  "Compliance-currency" = currency vs canon's O1 compliance/methodology
 *  artifact set (`artifact-flow.md` § The Origination Taxonomy — O1; home
 *  `specs/methodology/`). The honest existing signal is the COUNT of O1
 *  methodology artifacts canon has authored. Today that count is ZERO
 *  (`specs/methodology/_index.md`: "there is currently no methodology artifact
 *  authored"), AND there is no per-consumer compliance-class marker to measure
 *  a consumer's compliance-currency against. So per-consumer compliance-currency
 *  is NOT YET A REAL SIGNAL — fabricating one would be the exact false-guarantee
 *  the honest-gap contract forbids.
 *
 *  Instead this probe records the honest fleet BASELINE: the canon authored
 *  count (`canon_authored`, 0 today) + `applicable:false` when the baseline is
 *  empty. T6 renders the compliance column DATA-DRIVEN from this baseline
 *  ("canon authors 0 compliance artifacts — roadmap") instead of a hardcoded
 *  label; the moment canon authors its first O1 artifact the baseline becomes
 *  non-empty without a code change, and a per-consumer compliance-currency
 *  measure becomes the next (honestly roadmap-labeled) enhancement. The
 *  buyer-facing FRAMING of this column is the co-owner's at T6 (mirrors T4's
 *  cve-vs-deps-currency framing deferral; journal/0313).
 *
 *  ──────────────────────────────────────────────────────────────────────────
 *  Read-only + resolver-driven, mirroring fleet-deps.mjs: enumerates consumers
 *  via the injected resolveAll (loom-links::resolveAll; NEVER positional,
 *  cross-repo.md MUST-1); reads ONLY each consumer's posture.json + loom's own
 *  specs/methodology/ dir; no fetch, no mutation, no state write. Every `reason`
 *  keys on the logical consumer key; any caught `err.message` interpolated into
 *  a reason is run through `scrubPath()` FIRST, so no absolute checkout path
 *  reaches the durable ledger reason (security.md § "No secrets in logs" +
 *  upstream-issue-hygiene.md MUST-2).
 *
 *  --json output shape (consumers MUST tolerate unknown keys; additive):
 *    {
 *      "scope":      "trust-posture-observation",
 *      "compliance": {                              // fleet baseline (signal 2)
 *        "scope":        "o1-methodology-currency",
 *        "canon_authored": <int>,                   // O1 artifacts authored at canon
 *        "applicable":   true | false,              // false when canon_authored == 0
 *        "note":         "<honest-gap diagnostic>"
 *      },
 *      "results": [                                 // per-consumer posture (signal 1)
 *        {
 *          "target":     "<logical-key>",
 *          "repo":       "<absolute-path>" | null,
 *          "repo_floor": "L1_…".."L5_…" | null,
 *          "operative":  "L1_…".."L5_…" | null,     // min(floor, …operators)
 *          "operators":  <int> | null,              // count of rostered operators
 *          "reachable":  true | false,
 *          "reason":     null | "<diagnostic>"
 *        },
 *        ...
 *      ],
 *      "overall_reachable": true | false
 *    }
 *
 *  Usage (scoped INTO /inspect health per repo-scope-discipline.md):
 *    node .claude/bin/lib/fleet-compliance-posture.mjs --json
 *
 *  Node ESM, zero dependencies (reuses the in-repo posture-v2 ladder).
 * ============================================================================
 */

import { fileURLToPath } from "node:url";
import { realpathSync, readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// lib/ → bin/ → .claude/ → loom root
const LOOM_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");

// Reuse the CANONICAL trust-posture ladder + min + schema-validate from the
// hooks lib — never a parallel ladder (which would drift from trust-posture.md).
const require = createRequire(import.meta.url);
const postureV2 = require(path.join(SCRIPT_DIR, "..", "..", "hooks", "lib", "posture-v2.js"));
const { POSTURE_LADDER, minPosture, validatePostureV2Schema } = postureV2;
const POSTURE_INDEX = Object.create(null);
for (let i = 0; i < POSTURE_LADDER.length; i++) POSTURE_INDEX[POSTURE_LADDER[i]] = i;

export const SCOPE = "trust-posture-observation";
export const COMPLIANCE_SCOPE = "o1-methodology-currency";

// Consumer logical keys PULL canon distribution; recognized by resolver-key
// namespace prefix — NEVER by a positional path (mirrors fleet-deps.mjs).
const CONSUMER_KEY_PREFIXES = ["use-template.", "downstream."];

// Per-clone folded posture cache, relative to a consumer repo root. Per-repo
// state, NEVER synced (trust-posture.md MUST-NOT).
const POSTURE_REL = path.join(".claude", "learning", "posture.json");

// loom's O1 compliance-origination home (artifact-flow.md § The Origination
// Taxonomy). The honest compliance baseline = count of authored methodology
// artifacts here (excluding the convention docs).
const METHODOLOGY_REL = path.join("specs", "methodology");
const METHODOLOGY_NON_ARTIFACTS = new Set(["_index.md", "README.md", "readme.md"]);

// Cap on a single posture.json read (resource-exhaustion guard, mirrors the
// sibling fleet-deps.mjs size cap). A real posture cache is well under this.
const POSTURE_SIZE_CAP_BYTES = 4 * 1024 * 1024;

/**
 * Strip absolute filesystem paths out of a string before it lands in a durable
 * ledger reason (security.md § "No secrets in logs"). Same shape as
 * fleet-deps.mjs::scrubPath / fleet-dashboard.mjs::scrubReason, applied at the
 * PROBE source. Returns "" for non-strings.
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
 * Fold the FLEET-WORST operative posture from a valid v2 posture object:
 * min(repo_floor, …all operators). Pure + exported for unit tests.
 *
 * The per-operator operative is min(operator, floor); the fleet-worst is the
 * min over all of those, which equals min(floor, …all operator postures). A
 * missing/invalid operator posture defaults to L2_SUPERVISED (the trust-posture
 * default for a new operator, matching posture-v2.js::computeOperativePosture).
 *
 * @param {object} posture  a schema-valid v2 posture object.
 * @returns {{operative: string, repo_floor: string, operators: number}}
 */
export function foldWorstOperative(posture) {
  const floor = posture.repo_floor.posture;
  let worst = floor;
  let operators = 0;
  const ops = posture.operators && typeof posture.operators === "object" ? posture.operators : {};
  for (const op of Object.values(ops)) {
    operators += 1;
    const opPosture =
      op && typeof op === "object" && Object.prototype.hasOwnProperty.call(POSTURE_INDEX, op.posture)
        ? op.posture
        : "L2_SUPERVISED";
    worst = minPosture(worst, opPosture);
  }
  return { operative: worst, repo_floor: floor, operators };
}

/**
 * Default posture reader: reads `<repoDir>/.claude/learning/posture.json`,
 * returns `{text}` or `{text:null, note}` (present-but-unreadable / oversized)
 * or null (absent). INJECTED in tests.
 */
function defaultReadPosture(repoDir) {
  const abs = path.join(repoDir, POSTURE_REL);
  if (!existsSync(abs)) return null;
  try {
    const size = statSync(abs).size;
    if (size > POSTURE_SIZE_CAP_BYTES) {
      return { text: null, note: `exceeds the ${POSTURE_SIZE_CAP_BYTES}-byte size cap (${size} bytes)` };
    }
    return { text: readFileSync(abs, "utf8") };
  } catch {
    // Present but unreadable → read failure (fail-loud upstream). No err
    // interpolation — the path lives in `abs`, never in a reason.
    return { text: null, note: "unreadable" };
  }
}

/**
 * Probe ONE consumer's trust-posture. Read-only; NEVER writes to the consumer.
 * @returns {object} the per-consumer posture result row.
 */
export function probeConsumerPosture(key, repoDir, readPosture = defaultReadPosture) {
  const base = {
    target: key,
    repo: repoDir,
    repo_floor: null,
    operative: null,
    operators: null,
    reachable: false,
    reason: null,
  };

  let found;
  try {
    found = readPosture(repoDir);
  } catch (err) {
    return { ...base, reason: `consumer '${key}' posture read failed — posture UNKNOWN: ${scrubPath(err && err.message)}` };
  }
  if (!found) {
    return {
      ...base,
      reason: `consumer '${key}' has no trust-posture state (.claude/learning/posture.json absent) — posture UNKNOWN`,
    };
  }
  if (typeof found.text !== "string") {
    const note = scrubPath(found.note || "unreadable");
    return { ...base, reason: `consumer '${key}' posture state ${note} — posture UNKNOWN` };
  }

  let parsed;
  try {
    parsed = JSON.parse(found.text);
  } catch {
    return { ...base, reason: `consumer '${key}' posture state could not be parsed (malformed JSON) — posture UNKNOWN` };
  }

  const { valid, errors } = validatePostureV2Schema(parsed);
  if (!valid) {
    const first = Array.isArray(errors) && errors.length ? scrubPath(String(errors[0])) : "schema invalid";
    return { ...base, reason: `consumer '${key}' posture state is schema-invalid (${first}) — posture UNKNOWN` };
  }

  const { operative, repo_floor, operators } = foldWorstOperative(parsed);
  return { ...base, repo_floor, operative, operators, reachable: true, reason: null };
}

/**
 * Count canon's authored O1 compliance/methodology artifacts (the honest
 * compliance baseline). Reads loom's own specs/methodology/ dir, excluding the
 * convention docs (_index.md / README). Pure + exported for unit tests.
 *
 * @param {string} methodologyDir  absolute path to specs/methodology/.
 * @returns {{canon_authored: number, readable: boolean}}
 */
export function countComplianceArtifacts(methodologyDir) {
  let entries;
  try {
    entries = readdirSync(methodologyDir, { withFileTypes: true });
  } catch {
    return { canon_authored: 0, readable: false };
  }
  let n = 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (METHODOLOGY_NON_ARTIFACTS.has(e.name)) continue;
    if (!e.name.endsWith(".md")) continue;
    n += 1;
  }
  return { canon_authored: n, readable: true };
}

/**
 * Build the honest fleet COMPLIANCE baseline (signal 2). Pure + exported.
 * @param {string} [methodologyDir]  injectable in tests; defaults to loom's.
 */
export function buildComplianceBaseline(methodologyDir = path.join(LOOM_ROOT, METHODOLOGY_REL)) {
  const { canon_authored, readable } = countComplianceArtifacts(methodologyDir);
  const applicable = readable && canon_authored > 0;
  const note = !readable
    ? "canon specs/methodology/ unreadable — compliance baseline UNKNOWN"
    : canon_authored === 0
      ? "canon authors 0 O1 compliance/methodology artifacts — per-consumer compliance-currency is roadmap (T6 framing); not yet a live signal"
      : `canon authors ${canon_authored} O1 compliance/methodology artifact(s) — per-consumer compliance-currency is the next honestly-roadmap-labeled enhancement`;
  return { scope: COMPLIANCE_SCOPE, canon_authored, applicable, note };
}

/**
 * The fleet compliance+posture probe. Enumerate consumers via the injected
 * resolver (resolveAll), compute each consumer's trust-posture observation +
 * the fleet compliance baseline.
 *
 * @param {object}   opts
 * @param {Function} opts.resolveAll      resolver enumeration fn (INJECTED in tests).
 * @param {Function} [opts.readPosture]   (repoDir)=>{text}|{text:null,note}|null; INJECTED in tests.
 * @param {string}   [opts.methodologyDir] compliance-baseline dir; INJECTED in tests.
 * @returns {object} { scope, compliance, results[], overall_reachable }
 */
export function probeFleetCompliancePosture({ resolveAll, readPosture = defaultReadPosture, methodologyDir } = {}) {
  if (typeof resolveAll !== "function") {
    throw new TypeError(
      "probeFleetCompliancePosture: opts.resolveAll must be the resolver enumeration function (resolver-driven, never positional)",
    );
  }
  const resolved = resolveAll();
  const results = [];
  for (const [key, entry] of resolved) {
    if (!isConsumerKey(key)) continue;

    if (entry.kind === "error" || (entry.kind === "path" && !entry.value)) {
      results.push({
        target: key,
        repo: null,
        repo_floor: null,
        operative: null,
        operators: null,
        reachable: false,
        reason: entry.error
          ? `consumer '${key}' unresolvable: ${entry.error}`
          : `consumer '${key}' not linked in resolver — posture UNKNOWN`,
      });
      continue;
    }

    if (entry.kind !== "path") {
      // Any non-path kind (url / remote-only) — no local posture state to read.
      // This dispatch precedes the value-guard above so a value-less remote-only
      // entry renders the precise remote-only reason, NOT "not linked" (LOW-1).
      // Fail loud as UNKNOWN, NEVER feed a non-local ref to a filesystem read.
      results.push({
        target: key,
        repo: null,
        repo_floor: null,
        operative: null,
        operators: null,
        reachable: false,
        reason: `consumer '${key}' is remote-only (kind:${entry.kind}) — local posture UNKNOWN`,
      });
      continue;
    }

    results.push(probeConsumerPosture(key, entry.value, readPosture));
  }

  const overall_reachable = results.every((r) => r.reachable);
  return {
    scope: SCOPE,
    compliance: buildComplianceBaseline(methodologyDir),
    results,
    overall_reachable,
  };
}

// ────────────────────────────────────────────────────────────────
// CLI entry — scoped INTO /inspect health (repo-scope-discipline.md:42).
// ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { json: false };
  for (const a of argv) {
    if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else {
      process.stderr.write(`fleet-compliance-posture: unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      "Usage: fleet-compliance-posture.mjs [--json]\n" +
        "  Read-only per-consumer TRUST-POSTURE observation + fleet COMPLIANCE\n" +
        "  baseline. Posture is read per-repo (.claude/learning/posture.json),\n" +
        "  NEVER synced; absent/corrupt → fail-loud UNKNOWN. Compliance is the\n" +
        "  honest canon O1-methodology-artifact baseline (0 today — roadmap).\n" +
        "  --json   emit machine-readable JSON\n",
    );
    process.exit(0);
  }

  const mod = await import(path.join(LOOM_ROOT, ".claude", "bin", "lib", "loom-links.mjs"));
  const report = probeFleetCompliancePosture({ resolveAll: mod.resolveAll });

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    const c = report.compliance;
    process.stdout.write(`[fleet-compliance-posture] scope=${report.scope}\n`);
    process.stdout.write(
      `[compliance] canon_authored=${c.canon_authored} applicable=${c.applicable} — ${c.note}\n`,
    );
    for (const r of report.results) {
      if (r.reachable) {
        process.stdout.write(
          `[posture] ${r.target}: operative=${r.operative} (floor=${r.repo_floor}, ${r.operators} operators)\n`,
        );
      } else {
        process.stdout.write(`[posture] ${r.target}: UNKNOWN\n`);
        process.stderr.write(`  reason: ${r.reason}\n`);
      }
    }
  }
  process.exit(report.overall_reachable ? 0 : 1);
}

// CLI-vs-import discriminator (mirrors fleet-deps.mjs).
const isMainModule = (() => {
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMainModule) {
  main().catch((err) => {
    process.stderr.write(`fleet-compliance-posture: fatal: ${err.message}\n`);
    process.exit(2);
  });
}
