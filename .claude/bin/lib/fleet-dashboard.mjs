/*
 * ============================================================================
 *  fleet-dashboard — buyer-visible fleet freshness / SLA view (W2a-T2, Build #5)
 * ============================================================================
 *
 *  The first BUYER-VISIBLE artifact of the maintenance observe-plane
 *  (analysis §7 P1). A READ-ONLY render over the loom-ROOT freshness ledger
 *  (`.fleet-freshness-ledger.json`, written by `/inspect health` via
 *  fleet-freshness-ledger.mjs). It renders an SLA table — "N consumers,
 *  M artifacts behind canon" — with per-consumer drift + reachability.
 *
 *  ──────────────────────────────────────────────────────────────────────────
 *  FIVE load-bearing invariants (W2a-shards.md T2):
 *
 *   1. reads-root-ledger (NOT re-probe). The dashboard NEVER runs the probe and
 *      NEVER reads any consumer repo — it projects the already-recorded ledger.
 *      Cross-fleet reads are `/inspect health`'s job (it rides the /inspect
 *      artifact-distribution carve-out, repo-scope-discipline.md:42). An absent
 *      ledger renders a "run /inspect health first" notice, NOT a re-probe.
 *   2. drift-not-distance. The metric is canonical-subset artifact-content DRIFT
 *      (`drifted`/`in_sync`/`total`), NEVER git-commit distance — loom and its
 *      consumers are disjoint histories (fleet-freshness.mjs header).
 *   3. honest-gap-roadmap-disclosure. CVE / compliance / posture columns are
 *      PRESENT but ROADMAP-LABELED — not yet wired (T4/T5/T6). An enterprise
 *      buyer reading a FALSE maintenance guarantee is worse than a disclosed
 *      roadmap (analysis §6; recommendation-quality.md MUST-3).
 *   4. no-new-consumer-reads. Zero filesystem/network reach into any consumer;
 *      the only input is the loom-root ledger file.
 *   5. buyer-visible-format. A plain-language SLA summary + aligned table a
 *      non-technical buyer can act on (communication.md).
 *  ──────────────────────────────────────────────────────────────────────────
 *
 *  ALL-GREEN semantics (T3 test contract): the fleet is "all green" ONLY when
 *  every consumer is reachable AND zero canonical artifacts are drifted. An
 *  UNKNOWN (unreachable) consumer is NEVER green — drift there is undetermined,
 *  not zero (fail-loud, evidence-first-claims.md MUST-3).
 *
 *  --json output shape (consumers MUST tolerate unknown keys; additive):
 *    {
 *      "generated_from_ledger_at": "<ISO>" | null,  // ledger.updated_at
 *      "scope":  "canonical-subset" | null,
 *      "summary": {
 *        "consumers": <int>, "reachable": <int>, "unreachable": <int>,
 *        "in_sync": <int>, "stale": <int>,
 *        "artifacts_behind": <int>,                 // Σ drifted over reachable
 *        "all_green": true | false
 *      },
 *      "rows": [ { target, variant, drifted, in_sync, total, stale,
 *                  reachable, reason,
 *                  deps:    null | {capped,pinned,declared,reachable,reason},  // T6 LIVE
 *                  posture: null | {operative,repo_floor,operators,reachable,reason} },// T6 LIVE
 *              ],
 *      "compliance": null | {scope,canon_authored,applicable,note},  // T5 baseline (data-driven)
 *      "roadmap_columns": ["compliance"]   // ONLY still-unbuilt: per-consumer compliance
 *    }
 *
 *  T6 WIRE (Build #5 second half): the deps-currency + posture columns now render
 *  LIVE from the ledger (T4/T5 fill, T6 wires). The "cve" column is RELABELED
 *  "deps-curr" — loom has NO vulnerability DB, so the honest signal is dependency-
 *  CURRENCY (capped/pinned counts per dependencies.md), NOT a CVE/vuln verdict
 *  (evidence-first-claims.md; co-owner framing 2026-06-22). Per-consumer compliance
 *  stays honest-gap-labeled (genuinely still-unbuilt: canon authors 0 O1 artifacts +
 *  no per-consumer compliance marker); its canon BASELINE is surfaced data-driven.
 *
 *  Usage (surfaced via /inspect health --dashboard):
 *    node .claude/bin/lib/fleet-dashboard.mjs            # render the table
 *    node .claude/bin/lib/fleet-dashboard.mjs --json     # machine-readable model
 *
 *  Node ESM, zero dependencies.
 * ============================================================================
 */

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { readLedger } from "./fleet-freshness-ledger.mjs";

// T6 WIRE: deps-currency (T4) + posture (T5) now render LIVE from the ledger.
// ONLY per-consumer compliance stays roadmap-labeled — it is genuinely still-unbuilt
// (canon authors 0 O1 methodology artifacts AND there is no per-consumer compliance-
// class marker; fleet-compliance-posture.mjs header). honest-gap-ONLY-for-still-unbuilt.
export const ROADMAP_COLUMNS = ["compliance"];
const ROADMAP_CELL = "—(roadmap)";

/**
 * Scrub absolute filesystem paths out of a consumer `reason` string before it
 * reaches the buyer-visible surface (rendered table AND --json model).
 *
 * Most probe `reason` strings are keyed on the logical consumer key (safe), but
 * the sync-tier-aware-plan-failure / canonical-derivation reasons interpolate a
 * caught `err.message`, which can embed an absolute checkout path. Per
 * security.md § "No secrets in logs" + upstream-issue-hygiene.md MUST-2, an
 * absolute path is a disclosure class on a buyer-visible surface — replace any
 * 2+-segment absolute path token with `<path>`. Logical keys (`use-template.py`)
 * and relative artifact paths (`.claude/x.md`) have no leading slash, so they
 * are never matched. Returns null unchanged (no reason → no scrub).
 */
export function scrubReason(reason) {
  if (typeof reason !== "string" || reason.length === 0) return reason ?? null;
  // Match absolute paths: a leading "/" followed by ≥2 path segments.
  return reason.replace(/\/[\w.\-]+(?:\/[\w.\-]+)+\/?/g, "<path>");
}

/**
 * Load the ledger, converting a corrupt/unreadable ledger (a JSON.parse throw
 * or a non-ENOENT read error from readLedger) into a typed signal instead of an
 * uncaught stack trace. A missing ledger (ENOENT) returns {ledger:null} —
 * readLedger already maps ENOENT → null, so corrupt:false there.
 * @param {Function} reader  injectable for tests; defaults to readLedger.
 */
export function loadLedgerSafe(reader = readLedger) {
  try {
    return { ledger: reader(), corrupt: false, error: null };
  } catch (err) {
    return { ledger: null, corrupt: true, error: err };
  }
}

/** Buyer-legible notice for a corrupt/unreadable ledger (fail-loud, not a stack dump). */
export function renderCorruptNotice() {
  return (
    "Fleet maintenance — freshness / SLA dashboard\n\n" +
    "  The fleet-freshness ledger could not be read (corrupt or unreadable).\n" +
    "  Re-run `/inspect health` to regenerate it, then re-run this dashboard.\n" +
    "  (This view never probes — it only reads the ledger.)\n\n"
  );
}

/**
 * Project a freshness-ledger record into the pure dashboard model.
 * Pure (no I/O) so it is independently testable. Accepts the ledger record
 * (from readLedger) or null/absent → an empty, not-green model.
 *
 * @param {object|null} ledger  the parsed ledger record, or null when absent.
 * @returns {object} the dashboard model (see --json shape above).
 */
export function buildDashboard(ledger) {
  const consumersObj =
    ledger && typeof ledger === "object" && ledger.consumers && typeof ledger.consumers === "object"
      ? ledger.consumers
      : {};

  const rows = [];
  let reachable = 0;
  let unreachable = 0;
  let inSyncCount = 0;
  let staleCount = 0;
  let artifactsBehind = 0;

  // Stable ordering: stale-and-reachable first (the rows a buyer must act on),
  // then unreachable (UNKNOWN), then in-sync; ties broken by target key.
  const keys = Object.keys(consumersObj).sort();
  for (const target of keys) {
    const c = consumersObj[target] || {};
    const row = {
      target,
      variant: c.variant ?? null,
      drifted: typeof c.drifted === "number" ? c.drifted : null,
      in_sync: typeof c.in_sync === "number" ? c.in_sync : null,
      total: typeof c.total === "number" ? c.total : null,
      stale: typeof c.stale === "boolean" ? c.stale : null,
      reachable: c.reachable === true,
      reason: scrubReason(c.reason),
      // T6 LIVE: project the additive deps (T4) + posture (T5) blocks. Each
      // reason is RE-scrubbed at render-time (defense-in-depth — the probe
      // already scrubs at source; security MED-1). null when not in the ledger.
      deps: projectDeps(c.deps),
      posture: projectPosture(c.posture),
    };
    rows.push(row);

    if (row.reachable) {
      reachable += 1;
      if (typeof row.drifted === "number") artifactsBehind += row.drifted;
      if (row.stale === true) staleCount += 1;
      else if (row.stale === false) inSyncCount += 1;
    } else {
      unreachable += 1;
    }
  }

  rows.sort((a, b) => rank(a) - rank(b) || a.target.localeCompare(b.target));

  const consumers = keys.length;
  // all_green ONLY when every consumer is reachable AND nothing is drifted.
  // Zero consumers is NOT green (nothing observed ≠ everything healthy).
  const all_green = consumers > 0 && unreachable === 0 && artifactsBehind === 0;

  return {
    generated_from_ledger_at: ledger && ledger.updated_at ? ledger.updated_at : null,
    scope: ledger && ledger.scope ? ledger.scope : null,
    summary: {
      consumers,
      reachable,
      unreachable,
      in_sync: inSyncCount,
      stale: staleCount,
      artifacts_behind: artifactsBehind,
      all_green,
    },
    rows,
    // T5 baseline (data-driven): the honest canon O1-methodology compliance
    // baseline. Surfaced as a summary line; per-consumer compliance stays roadmap.
    compliance: ledger && ledger.compliance ? ledger.compliance : null,
    roadmap_columns: [...ROADMAP_COLUMNS],
  };
}

/**
 * Project a ledger `deps` block (T4) into the dashboard row shape, re-scrubbing
 * the reason at render-time (defense-in-depth). null → null.
 */
function projectDeps(d) {
  if (!d || typeof d !== "object") return null;
  return {
    capped: typeof d.capped === "number" ? d.capped : null,
    pinned: typeof d.pinned === "number" ? d.pinned : null,
    declared: typeof d.declared === "number" ? d.declared : null,
    reachable: d.reachable === true,
    reason: scrubReason(d.reason),
  };
}

/**
 * Project a ledger `posture` block (T5) into the dashboard row shape, re-scrubbing
 * the reason at render-time (defense-in-depth). null → null.
 */
function projectPosture(p) {
  if (!p || typeof p !== "object") return null;
  return {
    operative: p.operative ?? null,
    repo_floor: p.repo_floor ?? null,
    operators: typeof p.operators === "number" ? p.operators : null,
    reachable: p.reachable === true,
    reason: scrubReason(p.reason),
  };
}

/** Sort rank: stale-reachable (0) < unreachable (1) < in-sync/other (2). */
function rank(r) {
  if (!r.reachable) return 1;
  if (r.stale === true) return 0;
  return 2;
}

/** Right-pad a string to width (display helper; ASCII-only columns). */
function pad(s, width) {
  s = String(s);
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/**
 * Render the dashboard model as buyer-visible plain text.
 * @param {object} model  the buildDashboard() output.
 * @returns {string} the rendered table (newline-terminated).
 */
export function renderDashboard(model) {
  const lines = [];
  const s = model.summary;

  lines.push("Fleet maintenance — freshness / SLA dashboard");
  if (model.generated_from_ledger_at) {
    lines.push(`  ledger observed: ${model.generated_from_ledger_at}  (scope: ${model.scope})`);
  }
  lines.push("");

  if (s.consumers === 0) {
    lines.push("  No fleet-freshness ledger found (no consumers recorded).");
    lines.push("  Run `/inspect health` to probe the fleet and write the ledger,");
    lines.push("  then re-run this dashboard. (This view never probes — it only reads.)");
    lines.push("");
    return lines.join("\n") + "\n";
  }

  // Buyer-visible SLA headline (plain language).
  const status = s.all_green ? "ALL GREEN" : s.unreachable > 0 ? "ATTENTION (gaps UNKNOWN)" : "ATTENTION";
  lines.push(`  STATUS: ${status}`);
  lines.push(
    `  ${s.consumers} consumers · ${s.in_sync} in sync · ${s.stale} stale ` +
      `(${s.artifacts_behind} artifacts behind canon) · ${s.unreachable} unreachable (UNKNOWN)`,
  );
  // Compliance baseline — DATA-DRIVEN from the ledger (T5), not a hardcoded label.
  if (model.compliance) {
    const cb = model.compliance;
    lines.push(
      `  compliance baseline: canon authors ${cb.canon_authored} O1 artifact(s) — ` +
        `${cb.applicable ? "per-consumer compliance-currency live" : "per-consumer compliance-currency ROADMAP (not yet a live signal)"}`,
    );
  }
  lines.push("");

  // Column widths. The "cve" slot is RELABELED "deps-curr" (honest: dependency-
  // currency, not a vuln verdict — loom has no CVE DB).
  const W = { target: Math.max(8, ...model.rows.map((r) => r.target.length)), variant: 7, drift: 16, deps: 12, comp: 12, post: 9 };
  const header =
    "  " +
    pad("consumer", W.target) +
    "  " +
    pad("variant", W.variant) +
    "  " +
    pad("drift", W.drift) +
    "  " +
    pad("deps-curr", W.deps) +
    "  " +
    pad("compliance", W.comp) +
    "  " +
    pad("posture", W.post);
  lines.push(header);
  lines.push("  " + "-".repeat(header.length - 2));

  for (const r of model.rows) {
    let drift;
    if (!r.reachable) {
      drift = "UNKNOWN";
    } else if (r.stale === true) {
      drift = `STALE ${r.drifted}/${r.total}`;
    } else {
      drift = `in sync ${r.in_sync}/${r.total}`;
    }
    lines.push(
      "  " +
        pad(r.target, W.target) +
        "  " +
        pad(r.variant ?? "—", W.variant) +
        "  " +
        pad(drift, W.drift) +
        "  " +
        pad(depsCell(r.deps), W.deps) +
        "  " +
        pad(ROADMAP_CELL, W.comp) + // per-consumer compliance still-unbuilt (honest-gap)
        "  " +
        pad(postureCell(r.posture), W.post),
    );
    if (!r.reachable && r.reason) {
      lines.push("  " + pad("", W.target) + "    ↳ " + r.reason);
    }
  }

  lines.push("");
  // Honest-gap disclosure — now NARROWED: deps-curr + posture are LIVE; only
  // per-consumer compliance remains ROADMAP (honest-gap-ONLY-for-still-unbuilt).
  lines.push(
    "  NOTE: deps-curr + posture columns are LIVE. deps-curr is dependency-CURRENCY " +
      "(capped/pinned counts), NOT a CVE/vuln scan — loom has no vulnerability DB.",
  );
  lines.push(
    "  Per-consumer compliance stays ROADMAP (canon authors 0 O1 artifacts; no per-consumer " +
      "compliance marker yet). Posture is the OBSERVED operative trust-level, read per-repo.",
  );
  lines.push("");

  return lines.join("\n") + "\n";
}

/** Render the deps-currency cell (T6 LIVE). null → "—"; UNKNOWN; else cap/pin count. */
function depsCell(d) {
  if (!d) return "—";
  if (!d.reachable) return "UNKNOWN";
  const flagged = (d.capped || 0) + (d.pinned || 0);
  return flagged > 0 ? `${flagged} cap/pin` : "current";
}

/** Render the posture cell (T6 LIVE). null → "—"; UNKNOWN; else short level (L2). */
function postureCell(p) {
  if (!p) return "—";
  if (!p.reachable || !p.operative) return "UNKNOWN";
  // Short level token for a compact buyer column (e.g. "L2" from "L2_SUPERVISED").
  return String(p.operative).split("_")[0];
}

// ────────────────────────────────────────────────────────────────
// CLI entry — surfaced via /inspect health --dashboard.
// ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { json: false };
  for (const a of argv) {
    if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else {
      process.stderr.write(`fleet-dashboard: unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      "Usage: fleet-dashboard.mjs [--json]\n" +
        "  Buyer-visible fleet freshness / SLA view. READ-ONLY render over the\n" +
        "  loom-root .fleet-freshness-ledger.json (written by /inspect health).\n" +
        "  Never probes; never reads any consumer repo. drift + deps-curr +\n" +
        "  posture columns are LIVE; deps-curr is dependency-currency (capped/\n" +
        "  pinned counts), NOT a CVE/vuln scan (loom has no vulnerability DB).\n" +
        "  Per-consumer compliance stays roadmap-labeled (still unbuilt).\n" +
        "  --json   emit the machine-readable dashboard model\n",
    );
    process.exit(0);
  }

  const { ledger, corrupt } = loadLedgerSafe();
  if (corrupt) {
    // Fail-loud-but-legible: a corrupt ledger renders a typed notice, never a
    // raw stack trace (evidence-first-claims.md MUST-3). Exit 2 (operator must
    // regenerate) distinguishes it from actionable-drift exit 1.
    if (args.json) {
      process.stdout.write(
        JSON.stringify({ error: "corrupt-or-unreadable-ledger", hint: "run /inspect health" }, null, 2) + "\n",
      );
    } else {
      process.stdout.write(renderCorruptNotice());
    }
    process.exit(2);
  }

  const model = buildDashboard(ledger);

  if (args.json) {
    process.stdout.write(JSON.stringify(model, null, 2) + "\n");
  } else {
    process.stdout.write(renderDashboard(model));
  }
  // Exit 0 when all-green OR no ledger (informational); 1 when there is
  // actionable drift or an UNKNOWN consumer (CI/cadence can gate on it).
  process.exit(model.summary.consumers > 0 && !model.summary.all_green ? 1 : 0);
}

const isMainModule = (() => {
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMainModule) main();
