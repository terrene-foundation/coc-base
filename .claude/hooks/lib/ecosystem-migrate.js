"use strict";

// ecosystem-migrate.js — the cross-ecosystem product MOVE source-side discipline
// (ECO-IMPL W8b / S3-T1). A WIRE over SHIPPED primitives — it does NOT re-implement
// genesis, the disclosure scanner, or the sever ledger.
//
// S3 (specs/02 §S3; A3 disposition journal/0281): a full product build MOVES from canon's
// ecosystem into a client's. The A3 RATIFIED disposition is FRESH GENESIS in the client —
// canon roster/posture/coordination-log DISCARDED, the product re-anchors fresh; NO canon
// identity/operators carry over. This is DISTINCT from `genesis-migration` (MUST-7, trust-root
// RELOCATION): using performMigration here would CARRY canon's trust root across the ecosystem
// boundary — the exact S3 disclosure breach. The dest's fresh anchor is established by
// /ecosystem-init (W8a C3 runEnrollmentCeremony); this lib enforces the source-side discipline
// that MUST accompany the move, as injectable guards (deterministic + testable):
//
//   inv 1 — NO canon state carryover: the dest MUST NOT inherit canon's coordination-log /
//           posture / roster (A3 "DISCARDED"). A dest genesis-anchor whose owner == the
//           source's (canon's) IS the breach.
//   inv 2 — FRESH genesis, NOT genesis-migration: the dest re-anchors via runEnrollmentCeremony
//           (fresh), never performMigration (relocation). A relocation disposition is REJECTED.
//   inv 3 — SOURCE sever: projectSeverToLedger records the product's departure in canon's OWN
//           ledger, so canon cascades no longer fire into the migrated product (the A1 keystone).
//   inv 4 — disclosure scrub: the moved surface MUST pass scan-synced-disclosure with NO
//           canon-identity finding before the move finalizes (any carried canon org slug = breach).

const path = require("path");

const MIGRATION_KIND_FRESH = "fresh-genesis";
const MIGRATION_KIND_RELOCATION = "genesis-migration";

// ── inv 2 — fresh genesis, never genesis-migration ─────────────────────────────
function assertFreshGenesisDisposition(kind) {
  if (kind === MIGRATION_KIND_RELOCATION) {
    return {
      ok: false,
      status: "rejected-relocation",
      error:
        "S3 cross-ecosystem move MUST use a FRESH genesis-anchor (A3: canon identity DISCARDED), NOT genesis-migration — performMigration would carry canon's trust root across the ecosystem boundary (the S3 disclosure breach).",
    };
  }
  if (kind !== MIGRATION_KIND_FRESH) {
    return {
      ok: false,
      status: "unknown-kind",
      error: `unknown migration kind "${kind}" — only "${MIGRATION_KIND_FRESH}" is permitted for the S3 cross-ecosystem move.`,
    };
  }
  return { ok: true, status: "fresh-genesis" };
}

// ── inv 1 — no canon state carryover (dest owner DISTINCT from source/canon owner) ──
function assertNoCanonStateCarryover(opts) {
  const o = opts || {};
  if (!o.destGenesisOwner) {
    return {
      ok: false,
      status: "no-fresh-genesis",
      error:
        "dest has no fresh genesis-anchor — run /ecosystem-init in the client BEFORE finalizing the move (A3 fresh re-anchor).",
    };
  }
  if (o.sourceGenesisOwner && o.destGenesisOwner === o.sourceGenesisOwner) {
    return {
      ok: false,
      status: "canon-carryover",
      error: `dest genesis owner "${o.destGenesisOwner}" == source (canon) owner — canon trust root CARRIED OVER (the S3 disclosure breach). A3 requires canon roster/posture/coordination-log DISCARDED + a fresh anchor.`,
    };
  }
  return { ok: true, status: "fresh-distinct-owner" };
}

// ── inv 4 — disclosure scrub of the moved surface ──────────────────────────────
// scanFn contract: ({ root }) => { exitCode, findings:[] }. exitCode 0 + 0 findings = clean.
function scrubMigratedSurface(opts) {
  const o = opts || {};
  const scanFn = o.scanFn || defaultScanFn;
  const scan = scanFn({ root: o.movedRepoDir });
  const findings = (scan && scan.findings) || [];
  // Three outcomes, fail-closed on the two non-clean ones. Per evidence-first-claims.md MUST-3,
  // a disclosure-finding is ASSERTED ("canon identity carried over") ONLY with actual finding
  // EVIDENCE (parseable finding lines). A scan that did not run (spawn/timeout — `ran === false`)
  // OR ran-but-exited-non-zero with no parseable output is a verdict of UNKNOWN, not a finding —
  // both HALT, but the message must not assert a leak the detector never reported. (Injected
  // scanFns that omit `ran` keep the prior behavior: with findings present they hit the
  // disclosure-finding branch; clean ones fall through to scrubbed-clean.)
  if (findings.length > 0) {
    return {
      ok: false,
      status: "disclosure-finding",
      error: `moved surface FAILED disclosure scrub (${findings.length} finding(s)) — canon identity carried over. HALT; genericize before finalizing the move.`,
      findings,
    };
  }
  if (!scan || scan.ran === false || scan.exitCode !== 0) {
    const didNotRun = !scan || scan.ran === false;
    return {
      ok: false,
      status: "scan-unverified",
      error: `moved-surface disclosure scrub UNVERIFIED — scan-synced-disclosure produced no clean verdict (${didNotRun ? "scanner did not run; spawn/timeout failure" : "non-zero exit with no parseable findings"}); threat status UNKNOWN. HALT; the move cannot finalize until the scrub is proven clean.`,
      findings,
    };
  }
  return { ok: true, status: "scrubbed-clean", findings: [] };
}

// ── inv 3 — source sever (projectSeverToLedger) ────────────────────────────────
// severFn contract: (repoDir, roster, { project, pointer_flip_ref }) => { ok, severed, ... }.
// INTERNAL STEP — production callers MUST route through migrateProductToEcosystem, which
// runs the scrub + fresh-genesis-disposition + no-canon-carryover guards BEFORE this sever
// (the ORDER security property). Calling this directly bypasses that ordering; it stays
// exported only for unit-testing the step in isolation. (It is still independently safe
// against a fabricated sever — the pointer_flip_ref guard below + projectSeverToLedger's own
// guard — but it does NOT enforce that the dest was verified clean+fresh first.)
function severSourceFromCanon(opts) {
  const o = opts || {};
  if (!o.pointer_flip_ref) {
    // projectSeverToLedger also rejects this, but fail loud HERE — the pointer-flip
    // evidence ref is the proof the product DID withdraw; it is NEVER fabricated.
    return {
      ok: false,
      status: "no-pointer-flip-ref",
      error:
        "source sever requires pointer_flip_ref (the membership-reconcile sever-evidence ref proving the upstream_canon pointer-flip / withdrawal) — never fabricate it.",
    };
  }
  const severFn = o.severFn || defaultSeverFn;
  const res = severFn(o.sourceRepoDir, o.roster, {
    project: o.project,
    pointer_flip_ref: o.pointer_flip_ref,
  });
  if (!res || res.ok !== true) {
    return {
      ok: false,
      status: "sever-failed",
      error:
        (res && (res.error || res.reason)) || "projectSeverToLedger failed",
      sever: res,
    };
  }
  return {
    ok: true,
    status: res.severed ? "severed" : "already-severed",
    sever: res,
  };
}

// ── orchestrator — the S3 move source-side discipline, in invariant order ──────
// Order is security-load-bearing: the dest is fully verified (scrub clean + fresh-genesis
// disposition + no canon carryover) BEFORE the source sever fires. A failure at any guard
// HALTS and the sever NEVER runs — so a half-verified move never records a sever it can't honor.
function migrateProductToEcosystem(opts) {
  const o = opts || {};
  const steps = [];

  const scrub = scrubMigratedSurface({
    movedRepoDir: o.movedRepoDir,
    scanFn: o.scanFn,
  });
  steps.push({ step: "scrub", ...scrub });
  if (!scrub.ok) return { ok: false, halted_at: "scrub", steps };

  const disp = assertFreshGenesisDisposition(o.migrationKind);
  steps.push({ step: "fresh-genesis-disposition", ...disp });
  if (!disp.ok)
    return { ok: false, halted_at: "fresh-genesis-disposition", steps };

  const carry = assertNoCanonStateCarryover({
    sourceGenesisOwner: o.sourceGenesisOwner,
    destGenesisOwner: o.destGenesisOwner,
  });
  steps.push({ step: "no-canon-carryover", ...carry });
  if (!carry.ok) return { ok: false, halted_at: "no-canon-carryover", steps };

  const sever = severSourceFromCanon({
    sourceRepoDir: o.sourceRepoDir,
    roster: o.roster,
    project: o.project,
    pointer_flip_ref: o.pointer_flip_ref,
    severFn: o.severFn,
  });
  steps.push({ step: "source-sever", ...sever });
  if (!sever.ok) return { ok: false, halted_at: "source-sever", steps };

  return { ok: true, halted_at: null, steps, sever: sever.sever };
}

// ── production defaults (injectable for tests) ─────────────────────────────────
function defaultSeverFn(repoDir, roster, opts) {
  // capability-retirement.js is CJS — the SHIPPED §5 S3 sever-projection entry point.
  return require("./capability-retirement.js").projectSeverToLedger(
    repoDir,
    roster,
    opts,
  );
}

function defaultScanFn(opts) {
  // scan-synced-disclosure.mjs is the ESM CLI — spawn it --check (exit 0 = clean).
  const { execFileSync } = require("child_process");
  const scanner = path.resolve(
    __dirname,
    "..",
    "..",
    "bin",
    "scan-synced-disclosure.mjs",
  );
  try {
    execFileSync("node", [scanner, "--root", opts.root, "--check"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
    return { exitCode: 0, ran: true, findings: [] };
  } catch (e) {
    // `ran` distinguishes the two failure shapes execFileSync collapses into one throw:
    //   - the scanner RAN and exited non-zero (`e.status != null`) → a genuine --check finding;
    //   - the scanner NEVER produced a verdict (spawn failure ENOENT / timeout SIGTERM, no
    //     `e.status`) → the scrub is UNVERIFIED, not a finding.
    // scrubMigratedSurface reads `ran` to pick the correct HALT message (evidence-first-claims.md
    // MUST-3 — an errored detector is neither a finding asserted as fact nor an all-clear).
    const ran = !!(e && e.status != null);
    // Surface the scanner's ACTUAL finding lines so a genuine HALT names which canon tokens leaked
    // (observability.md). scan-synced-disclosure.mjs writes per-finding lines to STDERR via
    // console.error in --check mode (the stdout banner is human-summary only), so we capture
    // `e.stderr` with an `e.stdout` fallback for robustness.
    const raw = (
      e && (e.stderr || e.stdout) ? String(e.stderr || e.stdout) : ""
    ).trim();
    const lines = raw
      ? raw
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
      : [];
    // Return the RAW signal (exit code + ran + whatever finding lines were captured) — never a
    // SYNTHETIC "reported findings" placeholder. scrubMigratedSurface derives the verdict:
    // findings present → disclosure-finding (asserted with evidence); ran-but-no-lines OR
    // did-not-run → scan-unverified / threat UNKNOWN (evidence-first-claims.md MUST-3 — a finding
    // is never synthesized from a bare non-zero exit). Both non-clean verdicts HALT fail-closed.
    return { exitCode: ran ? e.status : 1, ran, findings: lines };
  }
}

module.exports = {
  migrateProductToEcosystem,
  severSourceFromCanon,
  scrubMigratedSurface,
  assertNoCanonStateCarryover,
  assertFreshGenesisDisposition,
  defaultSeverFn,
  defaultScanFn,
  MIGRATION_KIND_FRESH,
  MIGRATION_KIND_RELOCATION,
};
