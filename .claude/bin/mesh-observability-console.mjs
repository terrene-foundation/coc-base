#!/usr/bin/env node
/*
 * ============================================================================
 *  Knowledge-Mesh S2 Metadata-Observability Console — loom-command read-surface
 * ============================================================================
 *
 *  AUTHORITATIVE CONTRACT (this tool IMPLEMENTS it, never restates the
 *  derivation — `.claude/rules/specs-authority.md` Rule 9):
 *    workspaces/knowledge-mesh-2026-07-10/specs/06-metadata-observability-console.md
 *      (the console VIEW contract — every invariant below is FROM it)
 *    workspaces/knowledge-mesh-2026-07-10/specs/04-plane-split.md
 *      § "Metadata-observability console invariant — the RES-13 silent-failure guard"
 *      § "loom-command governance is NAME-BLIND (M3 …)"  · § "ENUM-BOUNDED PASS-THROUGH"
 *      § "DELIBERATELY NOT SCRUBBED"  · § "The scrub scope" item 5
 *
 *  WHAT IT IS. A loom-command FEDERATED READ-ONLY view over N registered
 *  projects' committed `kp://` registry tuples (spec §1). NO engine, NO data
 *  movement, NO server, NO reservoir dereference — it reads git-pulled registry
 *  TEXT and renders the union. It is the READ surface of the observe-UP /
 *  decide-DOWN cascade; the decide-DOWN WRITE (spec §5) is a separate Gate-2 act
 *  this console NEVER performs.
 *
 *  READS THROUGH THE S1 FENCE (spec §2 invariant 2). Every input tuple is
 *  defensively re-run through `mesh-registry-scrub.mjs::scrubTuple`; the console
 *  renders the SCRUBBED result. A raw pre-fence value the fence would redact
 *  renders as the sentinel («REDACTED» / «REDACTED_NAME»), never the raw bytes.
 *  A tuple with a HARD violation (vault material or raw content_hash present,
 *  `scrubTuple().ok === false`) is surfaced as a REJECTED row, never a normal one.
 *
 *  NAME-BLIND (spec §2 invariant 3 + §4). The console renders OPAQUE HANDLES
 *  ONLY — the readable name lives solely in the local handle vault, which never
 *  reaches loom-command. This extends to the per-PROJECT identity axis (§4): a
 *  project renders against its OPAQUE registration handle, never a readable
 *  project/client name; a non-opaque project_key renders as a positional
 *  sentinel, never the raw bytes.
 *
 *  THE RES-13 SILENT-FAILURE GUARD (spec §3 — most load-bearing). Dedup liveness
 *  is rendered PER-TENANT/per-project, gated on a signed per-tenant liveness
 *  attestation reporting `all_levels_keyed === true`. The console renders
 *  "duplicate detection is not yet live" and MUST NOT render "no duplicates
 *  found" for any tenant whose attestation is absent / invalid / stale / reports
 *  not-live. RES-23 (the co-keying + EP-signing-key build seam) is OPEN, so NO
 *  attestation VERIFIER exists — and the LIVE path is UNREACHABLE BY CONSTRUCTION
 *  without one (a structurally-present signature is a self-assertion from the same
 *  untrusted project-authored registry text, never proof). Every tenant therefore
 *  renders NOT-LIVE today. A "no duplicates found" render while RES-23 is open
 *  would be a FALSE ALL-CLEAR — the single most dangerous bug this surface ships.
 *
 *  Phase-1 INPUT. A directory (or a single file / a JSON file list) of per-
 *  project registry JSON. Each file is EITHER an array of that project's
 *  registry tuples, OR a project object:
 *    { project_key, freshness: { last_pulled, data_version }, reach,
 *      liveness_attestation: { all_levels_keyed, signature, epoch?, valid_until? },
 *      tuples: [ <registry tuple>, ... ] }
 *
 *  DETERMINISM. Library functions NEVER call Date.now(); the clock is injected
 *  as `now` (epoch ms). Only the CLI reads the wall clock (spec-honest: a
 *  freshness stamp is time-relative), and even then `--now` overrides it.
 *
 *  Usage:
 *    mesh-observability-console <dir|file> [--now <ms>] [--stale-ms <n>] [--epoch <n>]
 *    mesh-observability-console --json <dir|file>     structured model as JSON
 *    mesh-observability-console --help
 *
 *  Exit: 0 rendered · 2 usage/parse error.  (READ-ONLY: never writes an input.)
 * ============================================================================
 */

import fs from "node:fs";
import path from "node:path";

import { scrubTuple, isOpaqueHandle, REDACTED, VERSION_GRAMMAR } from "./mesh-registry-scrub.mjs";

// ────────────────────────────────────────────────────────────────
// Banners / sentinels the render vocabulary is built from. The
// NOT-LIVE banner text is spec-verbatim (spec §3) and is the ONLY
// dedup string emitted for a not-live tenant.
// ────────────────────────────────────────────────────────────────
export const NOT_LIVE_BANNER = "duplicate detection is not yet live";
export const NO_DUPLICATES = "no duplicates found";
export const PROJECT_SENTINEL = (n) => `«project-#${n}»`;

// Default staleness threshold: 7 days in ms (§4 item 1 — a project older than
// the threshold is FLAGGED; the operator decides on a knowingly-bounded view).
export const DEFAULT_STALE_MS = 7 * 24 * 60 * 60 * 1000;

// The reach-attestation vocabulary (§4 item 2). "neither" is the fail-closed
// value — a project that has neither pulled nor declined is surfaced, never
// assumed converged.
const REACH_ENUM = new Set(["pulled", "declined", "neither"]);

// ────────────────────────────────────────────────────────────────
// Project-identity resolution — NAME-BLIND on the project axis (spec §4).
// Renders the opaque registration handle, or a POSITIONAL sentinel for a
// non-opaque project_key. The raw project_key NEVER reaches the output.
// ────────────────────────────────────────────────────────────────
export function resolveProjectHandle(project, index) {
  const key = project && typeof project === "object" ? project.project_key : undefined;
  if (isOpaqueHandle(key)) return { handle: key, opaque: true, flag: null };
  return {
    handle: PROJECT_SENTINEL(index + 1),
    opaque: false,
    flag:
      key === undefined
        ? "project_key ABSENT — rendered as a positional sentinel (name-blind, spec §4)"
        : "project_key is not an opaque registration handle — rendered as a positional sentinel; the raw key is NEVER surfaced (spec §4; specs/02 clause (h))",
  };
}

// ────────────────────────────────────────────────────────────────
// Fence a single tuple (spec §2 invariant 2). Returns the scrubTuple result
// PLUS a rendered row built ONLY from the scrubbed values — the raw tuple is
// never read into the row. A HARD violation is flagged `rejected: true`.
// ────────────────────────────────────────────────────────────────
export function fenceTuple(tuple) {
  const result = scrubTuple(tuple);
  const s = result.scrubbed;
  const row = {
    // Product identity is the OPAQUE lineage_id (name is always «REDACTED»).
    lineage_id: s.lineage_id ?? REDACTED,
    name: s.name ?? REDACTED, // rendered to make the blinding VISIBLE; always «REDACTED»
    classification: s.classification ?? REDACTED, // LEVEL/sentinel only (§2 invariant 4)
    owning_level: s.owning_level ?? REDACTED,
    product_class: s.product_class ?? REDACTED,
    cascade_scope: s.cascade_scope ?? REDACTED,
    version: s.version ?? REDACTED,
    content_commitment: s.content_commitment ?? REDACTED,
    // A non-array merged_from is fail-closed by the fence to the SCALAR sentinel
    // string; treat that as NO valid parents (never iterate the string char-by-
    // char, which would forge per-character phantom lineage edges). The fence's
    // own flag (carried in result.flags) records the fail-close.
    merged_from: Array.isArray(s.merged_from) ? s.merged_from : [],
    flags: result.flags,
    rejected: !result.ok,
    violations: result.violations,
  };
  return { result, row };
}

// ────────────────────────────────────────────────────────────────
// S2a — Inventory grouped by owning_level (spec §2). OK rows group by their
// (pass-through) owning_level; HARD-violation tuples are surfaced separately as
// REJECTED (spec §2 invariant 2 — a violating tuple is never a normal row).
// ────────────────────────────────────────────────────────────────
export function renderInventory(projects) {
  const byLevel = Object.create(null);
  const rejected = [];
  projects.forEach((project, index) => {
    const { handle } = resolveProjectHandle(project, index);
    const tuples = Array.isArray(project?.tuples) ? project.tuples : [];
    for (const tuple of tuples) {
      const { row } = fenceTuple(tuple);
      const rendered = { project: handle, ...row };
      if (row.rejected) {
        rejected.push(rendered);
        continue;
      }
      const level = row.owning_level;
      (byLevel[level] ||= []).push(rendered);
    }
  });
  return { byLevel, rejected };
}

// ────────────────────────────────────────────────────────────────
// S2b — Lineage views (spec §3). lineage_id → the lineage DAG node; merged_from
// → the merge back-reference graph (structure preserved, every <name> already
// «REDACTED_NAME» at the fence). content_commitment is rendered ONLY as an
// OBSERVED within-tenant equality signal — never computed (the console holds no
// k_eco; spec §3 / specs/02 clause (f)).
// ────────────────────────────────────────────────────────────────
export function renderLineage(projects) {
  const nodes = [];
  const mergeEdges = [];
  projects.forEach((project, index) => {
    const { handle } = resolveProjectHandle(project, index);
    const tuples = Array.isArray(project?.tuples) ? project.tuples : [];
    for (const tuple of tuples) {
      const { row } = fenceTuple(tuple);
      if (row.rejected) continue; // a rejected tuple never contributes a lineage node
      nodes.push({ project: handle, lineage_id: row.lineage_id });
      for (const parent of row.merged_from) {
        // parent is a fence-scrubbed kp:// URN (its <name> is «REDACTED_NAME»)
        // OR the «REDACTED» sentinel for a fail-closed entry — either way name-blind.
        mergeEdges.push({ project: handle, into: row.lineage_id, from: parent });
      }
    }
  });
  return { nodes, mergeEdges };
}

// ────────────────────────────────────────────────────────────────
// The per-tenant liveness gate (spec §3 — the RES-13 guard). FAIL-CLOSED to
// NOT-LIVE on any absent / invalid / unsigned / epoch-stale attestation, or
// `all_levels_keyed !== true`. Returns { live, reason }.
// ────────────────────────────────────────────────────────────────
export function attestationLive(project, opts = {}) {
  const a = project ? project.liveness_attestation : undefined;
  if (!a || typeof a !== "object" || Array.isArray(a)) {
    return { live: false, reason: "liveness attestation ABSENT (RES-23 build seam OPEN — fail-closed NOT-LIVE)" };
  }
  if (a.all_levels_keyed !== true) {
    return { live: false, reason: "attestation reports all_levels_keyed != true — fail-closed NOT-LIVE" };
  }
  // A signed attestation is required (spec §3: loom verifies signature + epoch).
  if (typeof a.signature !== "string" || a.signature.length === 0) {
    return { live: false, reason: "attestation is unsigned — fail-closed NOT-LIVE" };
  }
  // RES-13 KILL-SWITCH — the false-all-clear guard (spec §3). The attestation is
  // pulled UP from the SAME untrusted, name-blind, project-authored registry text
  // as the tuples the fence exists to defend against, so a structurally-present
  // signature is a SELF-ASSERTION, not proof. While RES-23 (the EP-signing-key +
  // real signature verification) is OPEN, NO verifier exists → the LIVE path is
  // UNREACHABLE BY CONSTRUCTION. A caller reaches LIVE ONLY by injecting a real
  // signature verifier (opts.verifyAttestation) that authenticates the signature
  // against a trusted EP key; absent it, fail-closed NOT-LIVE regardless of the
  // attestation's contents. This makes "NOT-LIVE by construction" TRUE rather than
  // merely contingent on the attestation being absent. NOTE: no CLI flag supplies
  // a verifier — it is a programmatic injection reserved for when RES-23 lands, so
  // an untrusted CLI input can never flip the gate.
  const verify = typeof opts.verifyAttestation === "function" ? opts.verifyAttestation : null;
  if (!verify) {
    return {
      live: false,
      reason:
        "signature is a self-asserted claim and RES-23 verification is unavailable — fail-closed NOT-LIVE (the false-all-clear guard; spec §3)",
    };
  }
  if (verify(a, project) !== true) {
    return { live: false, reason: "attestation signature failed verification — fail-closed NOT-LIVE" };
  }
  // Epoch alignment (spec §3): a stale-epoch attestation is NOT-LIVE.
  if (opts.epoch !== undefined && a.epoch !== opts.epoch) {
    return { live: false, reason: "attestation epoch misaligned/stale — fail-closed NOT-LIVE" };
  }
  // Time-bounded validity: an expired attestation is stale ⇒ NOT-LIVE. A PRESENT
  // but malformed valid_until (NaN / non-finite / non-numeric) MUST fail closed —
  // silently skipping the expiry check on a malformed value is fail-OPEN (the
  // round-3 isFinite class). This path is behind the RES-13 verifier, so it hardens
  // the FUTURE critical path before RES-23 makes it reachable. Absent valid_until
  // is fine — epoch is the spec-mandated freshness key.
  if (a.valid_until !== undefined && a.valid_until !== null) {
    if (typeof a.valid_until !== "number" || !Number.isFinite(a.valid_until)) {
      return { live: false, reason: "attestation valid_until present but malformed (non-finite) — fail-closed NOT-LIVE" };
    }
    if (typeof opts.now === "number" && Number.isFinite(opts.now) && opts.now > a.valid_until) {
      return { live: false, reason: "attestation expired (stale) — fail-closed NOT-LIVE" };
    }
  }
  return { live: true, reason: "attestation verified (all levels keyed, signature authenticated, epoch-aligned)" };
}

// ────────────────────────────────────────────────────────────────
// Per-tenant dedup liveness render (spec §3). Detects OBSERVED within-tenant
// content_commitment equality (never computes it). The "no duplicates found"
// verdict is CONSTRUCTED ONLY on the live-and-empty branch — it can NEVER be
// emitted for a not-live tenant (the false-all-clear guard).
// ────────────────────────────────────────────────────────────────
export function dedupLiveness(project, opts = {}, index = 0) {
  const { handle } = resolveProjectHandle(project, index);
  const gate = attestationLive(project, opts);

  // Observed within-tenant equality: group opaque (kept, non-redacted)
  // commitments across THIS project's tuples only (never cross-tenant).
  const groups = new Map();
  const tuples = Array.isArray(project?.tuples) ? project.tuples : [];
  for (const tuple of tuples) {
    const { row } = fenceTuple(tuple);
    if (row.rejected) continue;
    const c = row.content_commitment;
    if (typeof c !== "string" || c === REDACTED) continue; // only observe opaque, kept values
    const bucket = groups.get(c) || [];
    bucket.push(row.lineage_id);
    groups.set(c, bucket);
  }
  const observedEqualities = [...groups.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([commitment, members]) => ({ commitment, members: [...members].sort() }));

  if (!gate.live) {
    // FAIL-CLOSED: render the not-live banner. NEVER a "no duplicates" verdict.
    // Any observed equalities are surfaced as an incomplete signal, explicitly
    // NOT a complete verdict (detection is not yet live).
    return {
      project: handle,
      live: false,
      verdict: "not-live",
      banner: NOT_LIVE_BANNER,
      message: null,
      reason: gate.reason,
      observedEqualities,
    };
  }
  if (observedEqualities.length > 0) {
    return {
      project: handle,
      live: true,
      verdict: "duplicates",
      banner: null,
      message: `${observedEqualities.length} duplicate group(s) found`,
      reason: gate.reason,
      observedEqualities,
    };
  }
  return {
    project: handle,
    live: true,
    verdict: "no-duplicates",
    banner: null,
    message: NO_DUPLICATES, // ONLY constructed here — the live-and-empty branch
    reason: gate.reason,
    observedEqualities,
  };
}

// ────────────────────────────────────────────────────────────────
// The three serverless-honesty surfaces (spec §4). Per-project freshness stamp
// + reach-attestation column + non-converged flag. FLAGS absent/stale rather
// than hiding it — a decide-DOWN decision must never rest on silently-stale
// metadata. Deterministic: `now` is injected, never read from the wall clock.
// ────────────────────────────────────────────────────────────────
function parseTimestamp(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return null; // unparseable ⇒ treated as absent (fail-closed to stale)
}

export function renderFreshness(projects, now, opts = {}) {
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new TypeError("renderFreshness requires an injected numeric `now` (epoch ms) — determinism (spec: no wall-clock in library fns)");
  }
  // Fail-closed: a non-finite threshold (NaN from a malformed flag) would make
  // `ageMs > NaN` always false — silently defeating the staleness honesty surface
  // (an abandoned project rendering "fresh converged" is the §4 false-all-clear,
  // one surface over from the §3 RES-13 one). NaN/±Infinity ⇒ the safe default.
  const threshold =
    typeof opts.staleThresholdMs === "number" && Number.isFinite(opts.staleThresholdMs)
      ? opts.staleThresholdMs
      : DEFAULT_STALE_MS;
  return projects.map((project, index) => {
    const { handle, opaque, flag: handleFlag } = resolveProjectHandle(project, index);
    const flags = [];
    if (handleFlag) flags.push(handleFlag);
    // Fail-closed visibility (§4): an unrecognized-shape file is surfaced LOUDLY,
    // not left to appear only as a silently-empty (→ stale) row.
    if (project && project._invalid) {
      flags.push("file shape UNRECOGNIZED — rendered as an empty fail-closed project (spec §4 fail-closed visibility; zero-tolerance Rule 3)");
    }

    const f = project && typeof project === "object" ? project.freshness : undefined;
    const lastPulledRaw = f && typeof f === "object" ? f.last_pulled : undefined;
    const lastPulled = parseTimestamp(lastPulledRaw);
    // NAME-BLIND (§4): data_version is a project-envelope field — it MUST obey the
    // same discipline as the fenced tuple fields. Accept ONLY a structurally-safe
    // shape (numeric version grammar OR an opaque handle); anything else is
    // fail-closed redacted and the RAW value is NEVER echoed (a free-text
    // data_version like "acme-corp-prod-2026" would otherwise leak a client name).
    const dataVersionRaw = f && typeof f === "object" ? f.data_version : undefined;
    let dataVersion = null;
    if (dataVersionRaw != null) {
      const dv = String(dataVersionRaw);
      if (VERSION_GRAMMAR.test(dv) || isOpaqueHandle(dv)) {
        dataVersion = dv;
      } else {
        dataVersion = REDACTED;
        flags.push(`data_version (type ${typeof dataVersionRaw}) is not a numeric-version/opaque token — fail-closed redacted; the raw value is NEVER surfaced (name-blind, spec §4 item 1)`);
      }
    }

    let ageMs = null;
    let stale;
    if (lastPulled === null) {
      stale = true; // absent/unparseable freshness ⇒ fail-closed FLAGGED (§4 item 1)
      flags.push("freshness stamp ABSENT or unparseable — fail-closed FLAGGED stale (spec §4 item 1)");
    } else if (now - lastPulled < 0) {
      // A future-dated last_pulled is DEFINITIONALLY impossible — and the stamp
      // comes from UNTRUSTED project-authored text. A negative age makes
      // `ageMs > threshold` false, silently rendering an abandoned project "fresh
      // converged" (the §4 false-all-clear, one trigger over from the round-3
      // NaN-threshold case). Fail-closed: an impossible-future stamp is an anomaly,
      // FLAGGED stale — never rendered as freshest-possible.
      ageMs = now - lastPulled;
      stale = true;
      flags.push("last_pulled is future-dated / clock-skewed (impossible negative age) — fail-closed FLAGGED stale (spec §4 item 1)");
    } else {
      ageMs = now - lastPulled;
      stale = ageMs > threshold;
      if (stale) flags.push(`last-pulled ${ageMs}ms ago exceeds the ${threshold}ms staleness threshold — FLAGGED (spec §4 item 1)`);
    }

    // Non-converged flag (§4 item 3): a project that stopped pulling stales
    // without bound and is FLAGGED non-converged. Explicit `converged: false`
    // forces it; otherwise staleness is the derived signal.
    const nonConverged = project?.converged === false || stale;
    if (project?.converged === false) flags.push("project explicitly marked non-converged (stopped pulling) — FLAGGED (spec §4 item 3)");
    else if (nonConverged) flags.push("project has not pulled within the freshness window — FLAGGED non-converged (spec §4 item 3)");

    // Reach-attestation column (§4 item 2): pulled / declined / neither.
    let reach = project && typeof project === "object" ? project.reach : undefined;
    if (!REACH_ENUM.has(reach)) {
      // NAME-BLIND (§4): reference an out-of-enum reach by TYPE only — never echo
      // the raw value (a free-text reach could carry a client/engagement name).
      if (reach !== undefined) flags.push(`reach value (type ${typeof reach}) outside {pulled, declined, neither} — fail-closed to 'neither'; the raw value is NEVER surfaced (name-blind, spec §4 item 2)`);
      reach = "neither"; // fail-closed: never assumed converged
    }

    return { project: handle, opaqueHandle: opaque, lastPulled, ageMs, dataVersion, stale, nonConverged, reach, flags };
  });
}

// ────────────────────────────────────────────────────────────────
// The composed console model (spec §§2–4) — all views over the project set.
// Pure: returns a structured model; writes NOTHING (spec §2 invariant 1).
// ────────────────────────────────────────────────────────────────
export function renderConsole(projects, opts = {}) {
  if (!Array.isArray(projects)) {
    throw new TypeError("renderConsole requires an array of project objects");
  }
  const now = typeof opts.now === "number" ? opts.now : null;
  const inventory = renderInventory(projects);
  const lineage = renderLineage(projects);
  const dedup = projects.map((p, i) => dedupLiveness(p, opts, i));
  const freshness = now === null ? null : renderFreshness(projects, now, opts);
  return { projectCount: projects.length, inventory, lineage, dedup, freshness };
}

// ────────────────────────────────────────────────────────────────
// Human-readable report (safe to paste — every value is fence-scrubbed or an
// opaque handle; NO raw client-identifying bytes, NO secrets, NO paths).
// ────────────────────────────────────────────────────────────────
export function formatConsole(model) {
  const L = [];
  L.push("mesh-observability-console — S2 federated read-only view");
  L.push(`Registered projects: ${model.projectCount}`);
  L.push("");

  // S2a inventory
  L.push("── Inventory (grouped by owning_level) ──");
  const levels = Object.keys(model.inventory.byLevel).sort();
  if (levels.length === 0) L.push("  (no renderable products)");
  for (const level of levels) {
    L.push(`  owning_level: ${level}`);
    for (const r of model.inventory.byLevel[level]) {
      L.push(
        `    project=${r.project} lineage=${r.lineage_id} name=${r.name} class=${r.classification} ` +
          `product_class=${r.product_class} cascade=${r.cascade_scope} version=${r.version}`,
      );
    }
  }
  if (model.inventory.rejected.length) {
    L.push("");
    L.push(`  REJECTED tuples (HARD violation — NOT rendered as normal rows): ${model.inventory.rejected.length}`);
    for (const r of model.inventory.rejected) {
      L.push(`    project=${r.project} — ${r.violations.map((v) => v.reason).join("; ")}`);
    }
  }

  // S2b lineage
  L.push("");
  L.push("── Lineage DAG + merge back-reference (names scrubbed) ──");
  for (const n of model.lineage.nodes) L.push(`  node project=${n.project} lineage=${n.lineage_id}`);
  for (const e of model.lineage.mergeEdges) L.push(`  merge project=${e.project} ${e.from} → ${e.into}`);

  // RES-13 dedup guard
  L.push("");
  L.push("── Dedup liveness (RES-13 per-tenant guard) ──");
  for (const d of model.dedup) {
    if (!d.live) {
      L.push(`  project=${d.project}: ${d.banner}  [${d.reason}]`);
      if (d.observedEqualities.length) {
        L.push(`    (observed equalities present but detection is NOT live — NOT a complete verdict)`);
      }
    } else {
      L.push(`  project=${d.project}: ${d.message}`);
    }
  }

  // Serverless-honesty surfaces
  if (model.freshness) {
    L.push("");
    L.push("── Serverless-honesty (freshness · reach · non-converged) ──");
    for (const p of model.freshness) {
      const staleTag = p.stale ? "STALE" : "fresh";
      const convTag = p.nonConverged ? "NON-CONVERGED" : "converged";
      L.push(`  project=${p.project} ${staleTag} ${convTag} reach=${p.reach} data_version=${p.dataVersion ?? "—"}`);
      for (const fl of p.flags) L.push(`    ⚑ ${fl}`);
    }
  }
  return L.join("\n");
}

// ────────────────────────────────────────────────────────────────
// Input loading (CLI only — READ-ONLY; opens files for read, never writes).
// Normalizes each file to a project object. A bare array is a project whose
// project_key is ABSENT (renders as a positional sentinel — name-blind).
// ────────────────────────────────────────────────────────────────
export function normalizeProject(raw, sourceLabel) {
  if (Array.isArray(raw)) return { project_key: undefined, tuples: raw, _source: sourceLabel };
  if (raw && typeof raw === "object" && Array.isArray(raw.tuples)) return { ...raw, _source: sourceLabel };
  // Fail-closed: an unrecognized file shape becomes an empty, flagged project —
  // never a crash (`.claude/rules/zero-tolerance.md` Rule 3, no silent fallback).
  return { project_key: undefined, tuples: [], _invalid: true, _source: sourceLabel };
}

function loadProjects(target) {
  const stat = fs.statSync(target);
  let files;
  if (stat.isDirectory()) {
    files = fs
      .readdirSync(target)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => path.join(target, f));
  } else {
    files = [target];
  }
  return files.map((file) => normalizeProject(JSON.parse(fs.readFileSync(file, "utf8")), path.basename(file)));
}

// ────────────────────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────────────────────
const HELP = `mesh-observability-console — S2 knowledge-mesh federated read-only view

A loom-command READ-ONLY view over N registered projects' committed kp://
registry tuples. NO engine, NO data movement, NO server, NO reservoir
dereference. Reads THROUGH the S1 fence; renders opaque handles ONLY; renders
the RES-13 per-tenant dedup-liveness guard. Contract:
workspaces/knowledge-mesh-2026-07-10/specs/06-metadata-observability-console.md

Usage:
  mesh-observability-console <dir|file>              render the report
  mesh-observability-console --json <dir|file>       structured model as JSON
  mesh-observability-console <dir|file> --now <ms>   inject the clock (epoch ms)
  mesh-observability-console <dir|file> --stale-ms <n>   freshness threshold (ms)
  mesh-observability-console <dir|file> --epoch <n>      current attestation epoch
  mesh-observability-console --help

Input: a directory of per-project JSON files (or one file). Each file is an
array of registry tuples OR { project_key, freshness, reach,
liveness_attestation, tuples: [...] }.

Exit: 0 rendered · 2 usage/parse error.  (READ-ONLY — never writes an input.)`;

function parseArgs(argv) {
  const args = { mode: "report", src: null, now: null, staleThresholdMs: undefined, epoch: undefined };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.mode = "json";
    else if (a === "--help" || a === "-h") args.mode = "help";
    else if (a === "--now") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v)) return { error: "--now requires a finite number (epoch ms)" };
      args.now = v;
    } else if (a === "--stale-ms") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v)) return { error: "--stale-ms requires a finite number (ms)" };
      args.staleThresholdMs = v;
    } else if (a === "--epoch") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v)) return { error: "--epoch requires a finite number" };
      args.epoch = v;
    } else if (!a.startsWith("--")) args.src = a;
    else return { error: `unknown flag: ${a}` };
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.error) {
    process.stderr.write(`${args.error}\n\n${HELP}\n`);
    return 2;
  }
  if (args.mode === "help") {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (!args.src) {
    process.stderr.write(`error: no input dir/file given\n\n${HELP}\n`);
    return 2;
  }
  let projects;
  try {
    projects = loadProjects(args.src);
  } catch (e) {
    process.stderr.write(`error: cannot load ${args.src}: ${e.message}\n`);
    return 2;
  }
  // The CLI is spec-honestly time-relative, so it MAY read the wall clock —
  // but --now overrides it for reproducible renders. Library fns never do this.
  const now = typeof args.now === "number" && Number.isFinite(args.now) ? args.now : Date.now();
  const model = renderConsole(projects, { now, staleThresholdMs: args.staleThresholdMs, epoch: args.epoch });
  if (args.mode === "json") {
    process.stdout.write(`${JSON.stringify(model, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${formatConsole(model)}\n`);
  return 0;
}

// ESM: run main() only when invoked as a script, not when imported by tests.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) process.exit(main());

export { parseArgs, loadProjects, main };
