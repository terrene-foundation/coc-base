/*
 * ============================================================================
 *  fleet-maintain — read-only ledger → MAINTENANCE-FINDINGS bucketing (W2b-1)
 * ============================================================================
 *
 *  Build #3, the read primitive of the `/maintain` cadence driver (analysis §5
 *  Build #3; §4.3 D4 — the self-DETECTING loop). It projects the loom-root fleet
 *  ledger (the Wave-2a observe-plane surface, written by `/inspect health`) into
 *  a structured per-consumer MAINTENANCE-FINDINGS model the `/maintain` command +
 *  maintenance-sweep skill consume.
 *
 *  ──────────────────────────────────────────────────────────────────────────
 *  WHAT THIS IS — AND IS NOT (the load-bearing self-DETECTING / never-heal
 *  contract, analysis §4.3 D4):
 *
 *  This is a DUMB read-only bucketer (agent-reasoning.md: the lib does the
 *  deterministic config-branching; the LLM does ALL judgment — which findings to
 *  draft, what severity, whether a finding warrants a BUILD issue). It:
 *
 *    - READS ONLY the loom-root ledger (reuses readLedger). It NEVER re-probes,
 *      NEVER reads a consumer repo, and — the load-bearing invariant — NEVER
 *      WRITES ANYTHING and NEVER produces an auto-APPLY action. Every finding's
 *      disposition is a HUMAN-GATED draft or informational-only; loom cannot push
 *      a fix across the pull boundary (self-DETECTING, NEVER self-healing).
 *
 *    - Buckets each consumer's ledger record into actionable findings by TYPE:
 *        drift-behind   : reachable + drifted > 0  → consumer is N artifacts
 *                         behind canon (the fix is the CONSUMER's own pull).
 *        deps-treadmill : reachable deps + capped/pinned > 0 → the consumer is on
 *                         a defensive-pinning treadmill (dependencies.md).
 *        posture-degraded: reachable posture + operative below L5 → the consumer's
 *                         COC is operating at reduced autonomy.
 *        *-unknown      : the corresponding probe was UNKNOWN (fail-loud) — surfaced
 *                         as INFORMATIONAL, NEVER as a fabricated "healthy".
 *
 *  EVERY ledger-derived finding's `draft` is "maintenance-report" (a human-gated
 *  report; the consumer pulls on its own cadence) or "none" (informational). The
 *  lib emits NO "build-issue" draft: a BUILD issue is for a CANON SDK defect, which
 *  is NOT derivable from the per-consumer ledger — that path is the LLM-judged
 *  reuse of gc-build-issue-draft.js documented in the maintenance-sweep skill, NOT
 *  a ledger projection. Inventing a build-issue from a consumer's own manifest
 *  state would be the false-signal the honest-gap contract forbids.
 *
 *  ──────────────────────────────────────────────────────────────────────────
 *  --json output shape (consumers MUST tolerate unknown keys; additive):
 *    {
 *      "generated_from_ledger_at": "<ISO>" | null,
 *      "scope": "fleet-maintenance-findings",
 *      "compliance": <ledger.compliance> | null,   // fleet baseline (roadmap today)
 *      "consumers": [
 *        { "target": "<key>", "actionable": true|false,
 *          "findings": [ { "kind": "...", "detail": "...", "draft": "maintenance-report"|"none" } ] },
 *        ...
 *      ],
 *      "summary": { "consumers": <int>, "actionable": <int>, "by_kind": {<kind>: <int>} }
 *    }
 *
 *  Usage (read-only; surfaced via the /maintain command):
 *    node .claude/bin/lib/fleet-maintain.mjs            # human-readable report
 *    node .claude/bin/lib/fleet-maintain.mjs --json     # machine-readable findings
 *
 *  Node ESM, zero dependencies (reuses the in-repo ledger reader). NO write/mutate
 *  import is present in this module — the never-write invariant is structural.
 * ============================================================================
 */

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { readLedger } from "./fleet-freshness-ledger.mjs";

export const SCOPE = "fleet-maintenance-findings";

// The autonomy ceiling: a consumer whose operative posture is below this is
// "degraded". L5 (the fresh-repo default) is healthy; anything lower is a signal.
const HEALTHY_POSTURE = "L5_DELEGATED";

/**
 * Bucket ONE consumer ledger record `c` into its actionable + informational
 * findings. Pure. Returns { target, actionable, findings[] }.
 */
export function bucketConsumer(target, c) {
  const findings = [];
  const rec = c && typeof c === "object" ? c : {};

  // 1. drift-behind (the fix is the consumer's own /sync-from-template pull).
  if (rec.reachable === true && typeof rec.drifted === "number" && rec.drifted > 0) {
    findings.push({
      kind: "drift-behind",
      detail: `${rec.drifted}/${rec.total ?? "?"} canonical artifacts behind canon`,
      draft: "maintenance-report",
    });
  } else if (rec.reachable !== true) {
    findings.push({
      kind: "drift-unknown",
      detail: rec.reason || "consumer drift UNKNOWN (probe unreachable)",
      draft: "none",
    });
  }

  // 2. deps-treadmill (defensive-pinning; dependencies.md). Consumer-side; report.
  const d = rec.deps;
  if (d && typeof d === "object") {
    if (d.reachable === true) {
      const flagged = (typeof d.capped === "number" ? d.capped : 0) + (typeof d.pinned === "number" ? d.pinned : 0);
      if (flagged > 0) {
        findings.push({
          kind: "deps-treadmill",
          detail: `${d.capped ?? 0} capped + ${d.pinned ?? 0} pinned of ${d.declared ?? "?"} declared deps`,
          draft: "maintenance-report",
        });
      }
    } else {
      findings.push({ kind: "deps-unknown", detail: d.reason || "deps currency UNKNOWN", draft: "none" });
    }
  }

  // 3. posture-degraded (consumer COC operating below full autonomy).
  const p = rec.posture;
  if (p && typeof p === "object") {
    if (p.reachable === true && typeof p.operative === "string") {
      if (p.operative !== HEALTHY_POSTURE) {
        findings.push({
          kind: "posture-degraded",
          detail: `operative trust-posture ${p.operative} (below ${HEALTHY_POSTURE})`,
          draft: "maintenance-report",
        });
      }
    } else if (p.reachable !== true) {
      findings.push({ kind: "posture-unknown", detail: p.reason || "posture UNKNOWN", draft: "none" });
    }
  }

  const actionable = findings.some((f) => f.draft !== "none");
  return { target, actionable, findings };
}

/**
 * Project the fleet ledger into the maintenance-findings model. Pure (no I/O when
 * a ledger object is injected). Accepts the parsed ledger record (or null/absent
 * → an empty model — NEVER a fabricated "all healthy"; nothing observed ≠ healthy).
 *
 * @param {object|null} ledger
 * @returns {object} the findings model (see --json shape above).
 */
export function buildMaintenanceModel(ledger) {
  const consumersObj =
    ledger && typeof ledger === "object" && ledger.consumers && typeof ledger.consumers === "object"
      ? ledger.consumers
      : {};
  const consumers = [];
  const byKind = {};
  let actionableCount = 0;

  for (const target of Object.keys(consumersObj).sort()) {
    const bucketed = bucketConsumer(target, consumersObj[target]);
    consumers.push(bucketed);
    if (bucketed.actionable) actionableCount += 1;
    for (const f of bucketed.findings) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  }

  return {
    generated_from_ledger_at: ledger && ledger.updated_at ? ledger.updated_at : null,
    scope: SCOPE,
    compliance: ledger && ledger.compliance ? ledger.compliance : null,
    consumers,
    summary: { consumers: consumers.length, actionable: actionableCount, by_kind: byKind },
  };
}

/**
 * Render the maintenance model as a plain-language report (read-only; never an
 * apply action). The actionable consumers come first; each finding names its
 * human-gated draft disposition. NO finding is ever auto-applied.
 */
export function renderMaintenance(model) {
  const lines = [];
  lines.push("Fleet maintenance — cadence findings (DETECT; nothing auto-applied)");
  if (model.generated_from_ledger_at) {
    lines.push(`  ledger observed: ${model.generated_from_ledger_at}`);
  }
  lines.push("");

  if (model.summary.consumers === 0) {
    lines.push("  No fleet ledger found. Run `/inspect health` first, then re-run `/maintain`.");
    lines.push("  (This view never probes — it reads the ledger /inspect health wrote.)");
    lines.push("");
    return lines.join("\n") + "\n";
  }

  lines.push(
    `  ${model.summary.consumers} consumers · ${model.summary.actionable} with actionable maintenance findings`,
  );
  if (model.compliance) {
    lines.push(
      `  compliance baseline: canon authors ${model.compliance.canon_authored} O1 artifact(s) — ` +
        `${model.compliance.applicable ? "live" : "roadmap (not yet a per-consumer signal)"}`,
    );
  }
  lines.push("");

  // Actionable consumers first, then informational-only, then clean.
  const ranked = [...model.consumers].sort(
    (a, b) => Number(b.actionable) - Number(a.actionable) || a.target.localeCompare(b.target),
  );
  for (const c of ranked) {
    if (c.findings.length === 0) {
      lines.push(`  ✓ ${c.target}: no findings`);
      continue;
    }
    lines.push(`  ${c.actionable ? "▲" : "·"} ${c.target}:`);
    for (const f of c.findings) {
      const disp = f.draft === "maintenance-report" ? "→ draft human-gated maintenance report" : "(informational)";
      lines.push(`      [${f.kind}] ${f.detail}  ${disp}`);
    }
  }
  lines.push("");
  lines.push(
    "  NOTE: `/maintain` is self-DETECTING, NEVER self-healing. It drafts HUMAN-GATED proposals only;",
  );
  lines.push(
    "  the consumer pulls fixes on its own cadence (loom cannot push). NOTHING here is auto-applied.",
  );
  lines.push("");
  return lines.join("\n") + "\n";
}

// ────────────────────────────────────────────────────────────────
// CLI entry — read-only; surfaced via the /maintain command.
// ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { json: false };
  for (const a of argv) {
    if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else {
      process.stderr.write(`fleet-maintain: unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      "Usage: fleet-maintain.mjs [--json]\n" +
        "  Read-only ledger → maintenance-findings bucketer (the /maintain read\n" +
        "  primitive). Reads the loom-root .fleet-freshness-ledger.json (written by\n" +
        "  /inspect health); NEVER probes, NEVER writes, NEVER auto-applies. Findings\n" +
        "  are drafted as HUMAN-GATED reports only (self-DETECTING, never self-healing).\n" +
        "  --json   emit the machine-readable findings model\n",
    );
    process.exit(0);
  }

  const model = buildMaintenanceModel(readLedger());
  if (args.json) {
    process.stdout.write(JSON.stringify(model, null, 2) + "\n");
  } else {
    process.stdout.write(renderMaintenance(model));
  }
  // Exit 1 when there is actionable maintenance work (cadence/CI can gate on it);
  // 0 when clean or no ledger (informational).
  process.exit(model.summary.actionable > 0 ? 1 : 0);
}

const isMainModule = (() => {
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMainModule) main();
