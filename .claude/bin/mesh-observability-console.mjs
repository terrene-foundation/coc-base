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
 *  The verified path is hardened AHEAD of RES-23 (same discipline as the
 *  valid_until isFinite guard): a verifier that THROWS is NOT-LIVE, epoch
 *  alignment is MANDATORY once a verifier is present (BOTH sides must carry a
 *  finite epoch — absence is unverifiable freshness, not a pass), a PRESENT
 *  valid_until with NO injected clock is UNVERIFIABLE expiry and likewise
 *  NOT-LIVE (an absent clock must never silently disable the expiry check), a
 *  LIVE tenant whose tuples were only PARTIALLY observable (rejected /
 *  quarantined / redacted- or malformed-commitment) renders the QUALIFIED "no
 *  observable duplicates — N product(s) not examined" verdict, and a LIVE tenant
 *  that examined ZERO products renders "nothing-observed" — never the bare
 *  all-clear, which requires `observed > 0` AND a fully-observed tuple set.
 *  The RES-23 verifier's signed payload MUST cover `epoch` + `valid_until`
 *  (see § VERIFIER CONTRACT at the `opts.verifyAttestation` injection point),
 *  and `--epoch` MUST come from the keying authority, never the audited text.
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
// RES-16 post-fetch detection BACKSTOP consumption (spec §2 invariant 2). The
// console reads THROUGH the backstop: any ref the re-scan flags DISCLOSURE-
// QUARANTINED (a raw value SURVIVED the source fence, or a kept `<domain>` handle
// FAILS isOpaqueHandle) MUST NOT have its raw tuple rendered — the row is WITHHELD
// and a redacted quarantine ALERT is surfaced instead (ref + finding KINDS ONLY,
// NEVER a raw value or field key). `scanRegistry` yields the token-safe manifest,
// including the backstop's own disclosure-safe ref. DETECT-NOT-PREVENT: the
// console cannot unfetch the leaked object; it makes the source-fence
// misconfiguration VISIBLE + CONTAINS the ref from further loom-side use.
import { scanRegistry, FINDING_KINDS } from "./mesh-registry-backstop.mjs";

// ────────────────────────────────────────────────────────────────
// Banners / sentinels the render vocabulary is built from. The
// NOT-LIVE banner text is spec-verbatim (spec §3) and is the ONLY
// dedup string emitted for a not-live tenant.
// ────────────────────────────────────────────────────────────────
export const NOT_LIVE_BANNER = "duplicate detection is not yet live";
export const NO_DUPLICATES = "no duplicates found";
// The QUALIFIED live verdict (spec §3 one granularity down — see `dedupLiveness`).
// Deliberately does NOT contain the `NO_DUPLICATES` substring: a blind-spot verdict
// must never satisfy a "did the clean phrase render?" check, at any surface.
export const NO_OBSERVABLE_DUPLICATES = "no observable duplicates";
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
// Per-tuple classification every render surface consults (spec §2 invariant 2).
// THREE outcomes, in strict precedence:
//   (1) REJECTED — a HARD-violation tuple (`scrubTuple().ok === false`: vault
//       material / raw content_hash). Unchanged normative home (spec §2
//       invariant 2, sentence 1): a REJECTED row, never a quarantine alert.
//   (2) QUARANTINED — a tuple the RES-16 post-fetch backstop re-scan flags
//       DISCLOSURE-QUARANTINED (a raw value SURVIVED the source fence, or a kept
//       handle FAILS isOpaqueHandle). Its raw tuple is WITHHELD from every render
//       surface and a redacted ALERT is surfaced instead.
//   (3) CLEAN — a source-fenced fixed-point tuple renders normally.
// The quarantine verdict + the disclosure-safe ref are the backstop's OWN
// (`scanRegistry` → detectTuple → safeRef), NEVER re-derived here — so this
// consumer and the source fence can never drift. REJECTED is tested FIRST so a
// HARD violation keeps its REJECTED home rather than collapsing into the
// (stricter, superset) quarantine class.
// ────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────
// The project's tuple LIST, fail-closed to empty — and RECORDED when it was.
// Same discipline as `fenceTuple`'s non-array merged_from fail-close (which
// records itself in `result.flags`): the coercion is safe, but SILENT coercion
// is not, because an empty examined set is indistinguishable from a genuinely
// clean one at every downstream surface. `tuples: "…"` / `{}` / a number is a
// malformed project file, NOT a project with nothing to declare — and the RAW
// value is never echoed (name-blind: a free-text tuples could carry a client
// name). An ABSENT tuples is recorded too: "nothing was examined" is a fact the
// dedup verdict owes its reader either way.
// ────────────────────────────────────────────────────────────────
export function projectTuples(project) {
  const raw = project && typeof project === "object" ? project.tuples : undefined;
  if (Array.isArray(raw)) return { tuples: raw, flags: [] };
  return {
    tuples: [],
    flags: [
      raw === undefined
        ? "tuples ABSENT — fail-closed to an EMPTY examined set; ZERO products were examined (an empty set is NOT evidence of no duplicate)"
        : `tuples (type ${typeof raw}) is not an array — fail-closed to an EMPTY examined set; ZERO products were examined and the raw value is NEVER surfaced (name-blind)`,
    ],
  };
}

export function classifyTuples(project) {
  const { tuples } = projectTuples(project);
  const scan = scanRegistry(tuples); // backstop: records index-aligned to `tuples`
  return tuples.map((tuple, i) => {
    const { row } = fenceTuple(tuple); // row is the SCRUBBED render row, never raw
    // FAIL-CLOSED: an absent backstop record (unreachable today — scanRegistry is
    // index-aligned 1:1 over the array — but a future scanRegistry change that
    // broke alignment MUST NOT silently render an un-scanned ref) quarantines,
    // never renders. Defense-in-depth on the RES-16 disclosure path.
    const rec = scan.records[i] || {
      ref: `«ref-#${i}»`,
      quarantined: true,
      findings: [{ field: "<root>", kind: FINDING_KINDS.MALFORMED }],
      findingCount: 1,
    };
    const rejected = row.rejected; // HARD violation → REJECTED (unchanged)
    const quarantined = !rejected && rec.quarantined === true; // RES-16 → WITHHELD + ALERT
    // The returned shape carries NO raw tuple — only the scrubbed row, the
    // disclosure-safe ref, and finding KINDS (fixed structural tokens).
    return {
      row,
      rejected,
      quarantined,
      ref: rec.ref, // disclosure-safe (opaque lineage_id or positional sentinel)
      findingCount: rec.findingCount,
      kinds: [...new Set((rec.findings || []).map((f) => f.kind))],
    };
  });
}

// ────────────────────────────────────────────────────────────────
// S2a — Inventory grouped by owning_level (spec §2). OK rows group by their
// (pass-through) owning_level; HARD-violation tuples are surfaced separately as
// REJECTED (spec §2 invariant 2 — a violating tuple is never a normal row).
// ────────────────────────────────────────────────────────────────
export function renderInventory(projects) {
  const byLevel = Object.create(null);
  const rejected = [];
  const quarantined = [];
  projects.forEach((project, index) => {
    const { handle } = resolveProjectHandle(project, index);
    for (const c of classifyTuples(project)) {
      if (c.rejected) {
        rejected.push({ project: handle, ...c.row });
        continue;
      }
      // A DISCLOSURE-QUARANTINED ref is WITHHELD (spec §2 invariant 2): its raw
      // tuple is NEVER a normal row — only a redacted alert carrying the ref +
      // finding KINDS (no raw value/key) is surfaced, until the source re-authors
      // it scrubbed and re-commits.
      if (c.quarantined) {
        quarantined.push({ project: handle, ref: c.ref, findingCount: c.findingCount, kinds: c.kinds });
        continue;
      }
      (byLevel[c.row.owning_level] ||= []).push({ project: handle, ...c.row });
    }
  });
  return { byLevel, rejected, quarantined };
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
    for (const c of classifyTuples(project)) {
      // A REJECTED (HARD) OR QUARANTINED (RES-16) tuple contributes NO lineage
      // node and NO merge edge — its raw tuple is never rendered (spec §2
      // invariant 2); the ref is contained from the lineage DAG.
      if (c.rejected || c.quarantined) continue;
      nodes.push({ project: handle, lineage_id: c.row.lineage_id });
      for (const parent of c.row.merged_from) {
        // parent is a fence-scrubbed kp:// URN (its <name> is «REDACTED_NAME»)
        // OR the «REDACTED» sentinel for a fail-closed entry — either way name-blind.
        mergeEdges.push({ project: handle, into: c.row.lineage_id, from: parent });
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
  //
  // VERIFIER CONTRACT (binding on the future RES-23 implementation). The signed
  // payload `verifyAttestation` authenticates MUST COVER `epoch` and `valid_until`,
  // not merely `all_levels_keyed`. Everything below re-reads those two fields off
  // `a` — the SAME untrusted project-authored registry text the fence exists to
  // defend against — so a verifier that signs only `all_levels_keyed` leaves both
  // the epoch gate and the expiry gate DECORATIVE: an attacker keeps the authentic
  // signature and rewrites `epoch`/`valid_until` freely, and the success `reason`
  // string then asserts "epoch-aligned" over an unauthenticated field. A verifier
  // whose payload does not cover both MUST return false rather than true.
  const verify = typeof opts.verifyAttestation === "function" ? opts.verifyAttestation : null;
  if (!verify) {
    return {
      live: false,
      reason:
        "signature is a self-asserted claim and RES-23 verification is unavailable — fail-closed NOT-LIVE (the false-all-clear guard; spec §3)",
    };
  }
  // A verifier that THROWS is fail-closed NOT-LIVE — NEVER a crash (which would
  // take down the whole console render) AND NEVER a bypass (a throw is NOT
  // "verified"). The RES-23 verifier is injected untrusted-adjacent code; its
  // failure MUST degrade to NOT-LIVE exactly as a `!== true` return does.
  let verified;
  try {
    verified = verify(a, project);
  } catch {
    return { live: false, reason: "attestation verifier threw — fail-closed NOT-LIVE" };
  }
  if (verified !== true) {
    return { live: false, reason: "attestation signature failed verification — fail-closed NOT-LIVE" };
  }
  // Epoch alignment (spec §3: "loom verifies the signature + epoch alignment") is
  // MANDATORY on the verified path. Reaching here means a verifier IS present (the
  // RES-13 kill-switch returned above for every unverified caller), so this is the
  // FUTURE RES-23 critical path — hardened before RES-23 makes it reachable, exactly
  // as the valid_until isFinite guard below is. THREE fail-closed cases, because
  // skipping the check is fail-OPEN (a stale-epoch attestation reading LIVE is the
  // same silent-skip class as the round-3 isFinite one):
  //   (a) opts.epoch absent / non-finite — there is NO current epoch to align
  //       AGAINST, so freshness is UNVERIFIABLE, not "fine". The old
  //       `opts.epoch !== undefined &&` short-circuit skipped alignment entirely
  //       whenever the caller omitted it. Consequence for the CLI: `--epoch` is
  //       MANDATORY once a verifier is wired (RES-23) — without it every tenant
  //       stays NOT-LIVE, which is the correct fail-closed default, never a silent
  //       pass. (No CLI change is needed today: the CLI supplies no verifier, so it
  //       fails closed one branch earlier at the kill-switch.)
  //   (b) a.epoch absent / non-finite — DECIDED fail-closed: epoch is the
  //       spec-mandated freshness key (spec §3 — detection is epoch-aligned
  //       commitment equality), so an attestation carrying no usable epoch is not
  //       verifiably fresh. Fail-closing here also removes the `undefined ===
  //       undefined` trap, where two ABSENCES would have "aligned" into a pass.
  //   (c) a.epoch !== opts.epoch — misaligned/stale (pre-existing behavior).
  if (typeof opts.epoch !== "number" || !Number.isFinite(opts.epoch)) {
    return {
      live: false,
      reason:
        "epoch alignment UNVERIFIABLE — no current epoch supplied against a verified attestation (--epoch is MANDATORY once a verifier is wired) — fail-closed NOT-LIVE",
    };
  }
  if (typeof a.epoch !== "number" || !Number.isFinite(a.epoch)) {
    return {
      live: false,
      reason: "attestation carries no usable epoch (the spec-mandated freshness key) — fail-closed NOT-LIVE",
    };
  }
  if (a.epoch !== opts.epoch) {
    return { live: false, reason: "attestation epoch misaligned/stale — fail-closed NOT-LIVE" };
  }
  // Time-bounded validity: an expired attestation is stale ⇒ NOT-LIVE. This path is
  // behind the RES-13 verifier, so it hardens the FUTURE critical path before RES-23
  // makes it reachable. Absent valid_until is fine — epoch is the spec-mandated
  // freshness key, so NOTHING below fires when the field is absent/null. But once
  // valid_until IS present, THREE fail-closed cases, exactly mirroring the epoch
  // gate above (skipping any of them is fail-OPEN):
  //   (a) a.valid_until malformed (NaN / non-finite / non-numeric) — silently
  //       skipping the expiry check on a malformed value is the round-3 isFinite class.
  //   (b) opts.now absent / non-finite — there is NO current clock to compare the
  //       expiry AGAINST, so expiry is UNVERIFIABLE, not "fine". The old guard read
  //       `typeof opts.now === "number" && … && opts.now > a.valid_until`, so an
  //       absent clock made the WHOLE conjunction false and control fell through to
  //       live:true — a PRESENT, FINITE, PAST valid_until read LIVE while a MALFORMED
  //       one failed closed one branch above (the internal inconsistency was the tell).
  //       It is reachable through the natural RES-23 wiring shape, not just a
  //       hand-crafted call: `renderConsole(projects, { epoch, verifyAttestation })`
  //       passes opts straight through to `dedupLiveness`, so omitting `now` silently
  //       disabled expiry. Consequence for the CLI: `--now` is MANDATORY once a
  //       verifier is wired (RES-23) — without it a tenant carrying a valid_until
  //       stays NOT-LIVE, which is the correct fail-closed default, never a silent
  //       pass. (No CLI change is needed today: the CLI always supplies a clock, and
  //       supplies no verifier, so it fails closed at the kill-switch regardless.)
  //   (c) opts.now > a.valid_until — expired/stale (pre-existing behavior).
  if (a.valid_until !== undefined && a.valid_until !== null) {
    if (typeof a.valid_until !== "number" || !Number.isFinite(a.valid_until)) {
      return { live: false, reason: "attestation valid_until present but malformed (non-finite) — fail-closed NOT-LIVE" };
    }
    if (typeof opts.now !== "number" || !Number.isFinite(opts.now)) {
      return {
        live: false,
        reason:
          "attestation expiry UNVERIFIABLE — a valid_until is present but no current clock was supplied to compare it against (--now is MANDATORY once a verifier is wired) — fail-closed NOT-LIVE",
      };
    }
    if (opts.now > a.valid_until) {
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
//
// NEVER-CLEAN-WHEN-BLIND, ONE GRANULARITY DOWN (spec §3: the guard exists to
// "distinguish 'not-keyed' from 'no-duplicate'"). RES-13 applies that at the
// TENANT granularity. The same blindness exists WITHIN a live tenant: a REJECTED
// (HARD-violation), a QUARANTINED (RES-16 withheld) or a REDACTED-commitment tuple
// is excluded from observation — so a tenant whose duplicates all sit among those
// tuples would otherwise render the bare clean bill. Every excluded tuple is
// therefore COUNTED, and a live tenant with any non-observable tuple gets the
// QUALIFIED verdict + `partialObservation: true`, never the bare all-clear.
// The counts are returned on EVERY branch (incl. not-live) so the field contract
// is uniform and no consumer has to branch to find them.
// ────────────────────────────────────────────────────────────────
export function dedupLiveness(project, opts = {}, index = 0) {
  const { handle } = resolveProjectHandle(project, index);
  const gate = attestationLive(project, opts);

  // The tuple LIST's own fail-close is RECORDED, never silent (see projectTuples):
  // a non-array / absent `tuples` yields ZERO examined products, which must never
  // read as a clean bill.
  const { tuples, flags: tuplesFlags } = projectTuples(project);
  const tuplesTotal = tuples.length;

  // Observed within-tenant equality: group opaque (kept, non-redacted)
  // commitments across THIS project's tuples only (never cross-tenant).
  const groups = new Map();
  // The blind-spot census: WHY each excluded tuple was not examined. Kinds only —
  // structural tokens, never a raw value (name-blind, spec §2 invariant 2).
  // CENSUS-LABEL HONESTY (#1610 MEDIUM-4-adjacent). This class counts every tuple
  // whose commitment carried NO usable equality signal. The old `redacted-commitment`
  // label implied the count was purely "deliberately blinded", but the predicate also
  // admits a non-string commitment. SPLITTING the two was MEASURED to be wrong: the
  // S1 fence normalizes EVERY non-string content_commitment (number / bool / object /
  // null / absent) to the «REDACTED» sentinel before this code sees it, so the
  // non-string arm is UNREACHABLE-BY-CONSTRUCTION defense-in-depth and a separate
  // class would be permanently zero. It follows that "blinded" and "absent" are
  // genuinely INDISTINGUISHABLE at this surface — the information was destroyed
  // upstream at the fence, not by the label. So the label is REWORDED to state
  // exactly what the number means rather than fabricate a distinction the data
  // cannot support. The field NAME is kept for contract continuity.
  const nonObservable = { rejected: 0, quarantined: 0, redactedCommitment: 0 };
  let observed = 0; // products that actually yielded an equality observation
  for (const cls of classifyTuples(project)) {
    // A REJECTED (HARD) OR QUARANTINED (RES-16) tuple is NEVER observed — its raw
    // tuple is withheld from the dedup signal too (spec §2 invariant 2), so a
    // quarantined ref cannot forge or mask a within-tenant equality. It is COUNTED
    // as a blind spot: excluded-from-observation is NOT evidence-of-no-duplicate.
    if (cls.rejected) {
      nonObservable.rejected += 1;
      continue;
    }
    if (cls.quarantined) {
      nonObservable.quarantined += 1;
      continue;
    }
    const c = cls.row.content_commitment;
    if (typeof c !== "string" || c === REDACTED) {
      // NO usable equality signal either way — the product is un-examined, not
      // duplicate-free. The non-string arm is unreachable through `classifyTuples`
      // today (the fence normalizes every non-string to the sentinel) and is kept
      // as fail-closed defense-in-depth: if that normalization ever changes, a
      // non-string MUST NOT become an equality-grouping key.
      nonObservable.redactedCommitment += 1;
      continue; // only observe opaque, kept values
    }
    observed += 1;
    const bucket = groups.get(c) || [];
    bucket.push(cls.row.lineage_id);
    groups.set(c, bucket);
  }
  const observedEqualities = [...groups.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([commitment, members]) => ({ commitment, members: [...members].sort() }));

  const notExamined = nonObservable.rejected + nonObservable.quarantined + nonObservable.redactedCommitment;
  const partialObservation = notExamined > 0;
  // The label states what the number MEANS: a commitment that is blinded and one
  // that was absent are indistinguishable here (the fence maps both to the
  // sentinel), so the label says so instead of implying only "deliberately blinded".
  const census =
    `rejected=${nonObservable.rejected} quarantined=${nonObservable.quarantined} ` +
    `no-usable-commitment=${nonObservable.redactedCommitment} [blinded or absent — indistinguishable post-fence]`;
  // `observed` + `tuplesTotal` are the DENOMINATOR the verdict was previously
  // missing: without them `{notExamined: 0, partialObservation: false, verdict:
  // "no-duplicates"}` was emitted identically for "100 products examined, genuinely
  // clean" and "nothing was examined at all". They ship on EVERY branch alongside
  // the census so no consumer has to branch to find them.
  const counts = { notExamined, nonObservable, partialObservation, observed, tuplesTotal, tuplesFlags };

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
      ...counts,
    };
  }
  if (observedEqualities.length > 0) {
    return {
      project: handle,
      live: true,
      verdict: "duplicates",
      banner: null,
      // A duplicate COUNT taken over a partially-observed tuple set is a FLOOR,
      // never a total — saying so is the same honesty the qualified branch owes.
      message:
        `${observedEqualities.length} duplicate group(s) found` +
        (partialObservation ? ` — FLOOR, not a total: ${notExamined} product(s) NOT examined (${census})` : ""),
      reason: gate.reason,
      observedEqualities,
      ...counts,
    };
  }
  if (observed === 0) {
    // LIVE but ZERO products actually examined ⇒ the observation is EMPTY, so no
    // duplicate-related verdict of any kind is earned. This fires for an empty /
    // absent / non-array `tuples` (which previously rendered the BARE all-clear —
    // indistinguishable from a genuinely-clean 100-product tenant) AND for a tenant
    // whose every tuple was excluded. `NO_DUPLICATES` is deliberately NOT
    // constructed here, and neither is `NO_OBSERVABLE_DUPLICATES`: even the
    // qualified phrase asserts a negative finding over an empty observation.
    return {
      project: handle,
      live: true,
      verdict: "nothing-observed",
      banner: null,
      message:
        `ZERO products examined — dedup observation was EMPTY (${tuplesTotal} tuple(s) in this project's registry, ` +
        `${notExamined} excluded: ${census}); NOT a clean bill of health`,
      reason: gate.reason,
      observedEqualities,
      ...counts,
    };
  }
  if (partialObservation) {
    // LIVE + no observed equality + a blind spot ⇒ QUALIFIED, never the bare
    // all-clear. `NO_DUPLICATES` is deliberately NOT constructed on this branch.
    return {
      project: handle,
      live: true,
      verdict: "no-observable-duplicates",
      banner: null,
      message: `${NO_OBSERVABLE_DUPLICATES} — ${notExamined} product(s) NOT examined (${census}); NOT a clean bill of health`,
      reason: gate.reason,
      observedEqualities,
      ...counts,
    };
  }
  return {
    project: handle,
    live: true,
    verdict: "no-duplicates",
    banner: null,
    message: NO_DUPLICATES, // ONLY here — live, no equality, fully observed AND observed > 0
    reason: gate.reason,
    observedEqualities,
    ...counts,
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

  // RES-16 post-fetch backstop quarantine alerts (spec §2 invariant 2). WITHHELD,
  // never rendered; the alert carries the disclosure-safe ref + finding KINDS
  // ONLY — no raw value or field key ever reaches this surface.
  if (model.inventory.quarantined.length) {
    L.push("");
    L.push(`  QUARANTINED refs (RES-16 post-fetch backstop — WITHHELD, NOT rendered): ${model.inventory.quarantined.length}`);
    for (const q of model.inventory.quarantined) {
      L.push(`    project=${q.project} ref=${q.ref} — ${q.findingCount} finding(s) [${q.kinds.join(", ")}]`);
    }
    L.push("    (DETECT-NOT-PREVENT: re-author the tuple scrubbed AT SOURCE + re-commit to clear.)");
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
      // NEVER-CLEAN-WHEN-BLIND (one granularity down): a live tenant whose tuple
      // set was only PARTIALLY observable carries its blind-spot census into the
      // human report too — the qualification must not survive only in the
      // structured model (a consumer reading the text would otherwise see a
      // verdict it cannot tell apart from a fully-observed one).
      if (d.partialObservation) {
        L.push(
          `    (INCOMPLETE OBSERVATION: ${d.observed} of ${d.tuplesTotal} product(s) examined, ${d.notExamined} NOT examined — ` +
            `rejected=${d.nonObservable.rejected} quarantined=${d.nonObservable.quarantined} ` +
            `no-usable-commitment=${d.nonObservable.redactedCommitment} [blinded or absent — indistinguishable post-fence]; ` +
            `excluded-from-observation is NOT evidence of no duplicate)`,
        );
      }
    }
    // The tuple-LIST fail-close (absent / non-array `tuples`) is surfaced on EVERY
    // branch — live or not. A silently-coerced empty examined set is exactly the
    // condition under which a clean-looking verdict means nothing, so it must not
    // survive only in the structured model.
    for (const fl of d.tuplesFlags || []) L.push(`    ⚑ ${fl}`);
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
      (MANDATORY once a RES-23 verifier is wired: on the verified path an absent
       --epoch makes freshness UNVERIFIABLE and every tenant stays NOT-LIVE.
       TRUSTED-ORIGIN ONLY: the value MUST come from the keying authority, NEVER
       read out of the pulled registry text being audited — sourcing it from the
       file under audit degenerates the alignment check to comparing the
       attestation's own epoch against itself, which is ALWAYS aligned and
       silently defeats the freshness gate.)
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
