#!/usr/bin/env node
// @ts-nocheck
/*
 * mesh-registry-backstop — the loom-side POST-FETCH detection backstop for the
 * C-1 metadata-scrub fence (S1, RES-16). loom#953 obligation 2, bullet 2.
 *
 * WHAT IT IS (and is NOT). The C-1 fence (`mesh-registry-scrub.mjs`, S1, PR
 * #959) runs at the SOURCE — each project authors its registry tuple
 * ALREADY-SCRUBBED pre-commit, so raw client-identifying values never enter a
 * git object loom-command fetches. This backstop is the SECOND line: a
 * DETECT-ONLY re-scan that runs at loom-command AFTER the `git fetch`, over the
 * UP-pulled registry text, to catch a MISCONFIGURED (non-malicious) project
 * that failed to scrub at source (RES-16).
 *
 * It is DETECT-NOT-PREVENT, and this is load-bearing (not a hedge). The re-scan
 * runs AFTER the fetch, so the offending git objects are ALREADY in
 * loom-command's `.git` and persist by SHA even with no ref — the same "a fence
 * AFTER the fetch is structurally too late" property the primary fence derives.
 * The backstop CANNOT unfetch them and CANNOT prevent the leak:
 * scrub-at-source remains the ONLY prevent-side fence. The backstop makes a
 * source-fence misconfiguration VISIBLE (alert) and CONTAINS the ref from
 * further loom-side use (quarantine). Do NOT read this as a licence to relax
 * scrub-at-source — it is a second line, not the line.
 *
 * Contract: workspaces/knowledge-mesh-2026-07-10/specs/04-plane-split.md
 * § "The loom-side post-fetch detection BACKSTOP (RES-16 — complements, does
 * NOT replace, scrub-at-source)". Register: specs/03 § Residual register RES-16.
 *
 * HOW IT DETECTS. A correctly-fenced tuple is a FIXED POINT of the source
 * predicate: re-applying `scrubTuple` to an already-scrubbed tuple yields an
 * IDENTICAL tuple. A tuple that was NOT scrubbed at source is NOT a fixed point
 * — re-scrubbing it CHANGES a value (a raw `<name>`/`provenance`/… → «REDACTED»),
 * raises a HARD violation (a raw `content_hash` / vault material survived), or
 * fail-closes a bad-grammar / non-opaque value. ANY divergence from the
 * correctly-fenced form is a finding. The predicate is the SHIPPED
 * `scrubTuple` + `isOpaqueHandle` (imported, never re-implemented) so the
 * backstop and the source fence can never drift — the same two-layer
 * structural-shape pattern `scan-synced-disclosure.mjs` runs as loom's other
 * post-hoc disclosure backstop (`--check` exit 1 on ≥1 finding; findings NEVER
 * print the raw token — rendered redacted).
 *
 * Run:  node .claude/bin/mesh-registry-backstop.mjs --check <fetched-registry.json>
 */

import fs from "node:fs";

import {
  scrubTuple,
  isOpaqueHandle,
  DISPOSITIONS,
  VAULT_FORBIDDEN,
} from "./mesh-registry-scrub.mjs";

// A finding NEVER carries a raw value or a raw (attacker-controlled) field key.
// Recognized field names are fixed structural tokens (safe); an unrecognized
// field is referenced ONLY by a positional sentinel — the same discipline
// `scrubTuple` itself uses so the untrusted key never reaches a report.
const FINDING_KINDS = {
  MALFORMED: "malformed-tuple", //   fetched value is not a JSON object
  HARD: "hard-violation", //         raw content_hash / vault material present
  UNSCRUBBED: "unscrubbed-value", // a scrub-disposition value survived un-redacted
  UNRECOGNIZED: "unrecognized-field", // a field the source fence would have dropped
  ABSENT_DEFAULT: "absent-fail-closed-default", // cascade_scope missing (fence never ran)
};

// Order-stable structural equality for plain-JSON tuple values (string, or an
// array of strings for merged_from). A correctly-fenced field equals its own
// re-scrub; any inequality means the raw value was not pre-scrubbed at source.
function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/*
 * detectTuple(fetched) -> { ref?, quarantined, findings, findingCount }
 *
 * DETECT-ONLY: never mutates `fetched`; only reads it and the (fresh) scrubbed
 * form. Fail-closed on EVERY axis — a non-object, a HARD violation, a surviving
 * raw value, an unrecognized field, or an absent fail-closed marker all
 * QUARANTINE the tuple. Never throws (a malformed tuple is a finding, not a
 * crash — `.claude/rules/zero-tolerance.md` Rule 3).
 */
function detectTuple(fetched) {
  if (fetched === null || typeof fetched !== "object" || Array.isArray(fetched)) {
    return {
      quarantined: true,
      findings: [{ field: "<root>", kind: FINDING_KINDS.MALFORMED }],
      findingCount: 1,
    };
  }

  // The fixed-point reference: what a CORRECTLY-fenced tuple would look like.
  const result = scrubTuple(fetched);
  const findings = [];

  // Layer 1 — HARD violations: presence of raw content_hash / vault material
  // in the fetched surface. `scrubTuple` reasons carry NO raw value, and the
  // violating field names are fixed structural markers (content_hash / k_eco /
  // handle_map / …), safe to name.
  for (const v of result.violations) {
    findings.push({ field: v.field, kind: FINDING_KINDS.HARD });
  }

  // Layer 2 — fixed-point divergence: any recognized field whose fetched value
  // differs from its correctly-fenced form means a raw value SURVIVED a missing
  // or misconfigured source fence. The raw value is NEVER echoed.
  let unrecognizedCount = 0;
  for (const field of Object.keys(fetched)) {
    const fieldLC = field.toLowerCase();
    // content_hash / vault keys already counted as HARD violations above.
    if (fieldLC === "content_hash" || VAULT_FORBIDDEN.has(fieldLC)) continue;

    if (!Object.hasOwn(DISPOSITIONS, field)) {
      // Unrecognized field — the source fence would have DROPPED it. The key
      // is itself untrusted free text, so reference it by a positional
      // sentinel only (never echo the raw key).
      unrecognizedCount += 1;
      findings.push({
        field: `«unrecognized-field-#${unrecognizedCount}»`,
        kind: FINDING_KINDS.UNRECOGNIZED,
      });
      continue;
    }

    if (!sameValue(fetched[field], result.scrubbed[field])) {
      findings.push({ field, kind: FINDING_KINDS.UNSCRUBBED });
    }
  }

  // Layer 3 — absent fail-closed marker: a source-fenced tuple ALWAYS carries a
  // cascade_scope (scrubTuple injects the most-restrictive default when absent),
  // so a fetched tuple missing it proves the source fence never ran.
  if (!Object.hasOwn(fetched, "cascade_scope")) {
    findings.push({ field: "cascade_scope", kind: FINDING_KINDS.ABSENT_DEFAULT });
  }

  return {
    quarantined: findings.length > 0,
    findings,
    findingCount: findings.length,
  };
}

/*
 * safeRef(tuple, fallback) -> a DISCLOSURE-SAFE ref label.
 *
 * The `ref` labels a quarantined tuple so the console consumer can refuse to
 * render it — but it MUST NOT be derived from any UNTRUSTED, un-fenced input
 * (a map KEY is fetched free text `scrubTuple` never touches — a misconfigured
 * project keys its registry by a `kp://…/<name>@v` URN whose `<name>` is exactly
 * the client-identifying free text the fence exists to redact). So the ref is
 * the tuple's OWN opaque identity — `lineage_id` — but ONLY when it passes
 * `isOpaqueHandle` (opaque ≥128-bit, non-invertible, and the very value a
 * NAME-BLIND loom-command console already renders — specs/04 § "DELIBERATELY NOT
 * SCRUBBED", specs/04 § M3 name-blind). A non-opaque / absent lineage_id (itself
 * a finding) falls back to a positional sentinel — never the raw key.
 */
function safeRef(tuple, fallback) {
  if (tuple !== null && typeof tuple === "object" && !Array.isArray(tuple)) {
    if (isOpaqueHandle(tuple.lineage_id)) return tuple.lineage_id;
  }
  return fallback;
}

/*
 * normalizeEntries(input) -> [{ ref, tuple }]
 *
 * A fetched registry is per-project committed registry text. Accept the three
 * natural shapes: an ARRAY of tuples, an OBJECT map of key → tuple (every value
 * a non-array object), or a SINGLE tuple. Every ref is a DISCLOSURE-SAFE label
 * (safeRef) — the raw map KEY is NEVER used as a ref (it is untrusted free
 * text). A malformed member survives here and fail-closes downstream in
 * detectTuple — normalization never rejects, so nothing is silently skipped.
 */
function normalizeEntries(input) {
  if (Array.isArray(input)) {
    return input.map((tuple, i) => ({ ref: safeRef(tuple, `#${i}`), tuple }));
  }
  if (input !== null && typeof input === "object") {
    const values = Object.values(input);
    const isMap =
      values.length > 0 &&
      values.every((v) => v !== null && typeof v === "object" && !Array.isArray(v));
    if (isMap) {
      // Positional index (NOT the raw key) as the fallback — the key is untrusted.
      return Object.keys(input).map((key, i) => ({
        ref: safeRef(input[key], `«ref-#${i}»`),
        tuple: input[key],
      }));
    }
    return [{ ref: safeRef(input, "<tuple>"), tuple: input }];
  }
  // A scalar / null whole-registry payload is itself malformed — one entry that
  // fail-closes in detectTuple rather than a silent empty scan.
  return [{ ref: "<root>", tuple: input }];
}

/*
 * scanRegistry(parsed, sourceLabel) -> { source, records, quarantined, clean }
 * Pure over a parsed registry payload — the unit-testable core.
 */
function scanRegistry(parsed, sourceLabel = "<input>") {
  const records = normalizeEntries(parsed).map(({ ref, tuple }) => ({
    ref,
    ...detectTuple(tuple),
  }));
  const quarantined = records.filter((r) => r.quarantined);
  return {
    source: sourceLabel,
    records,
    quarantined,
    clean: quarantined.length === 0,
  };
}

// ────────────────────────────────────────────────────────────────
// Reporting — redacted, safe to paste anywhere (no raw values ever).
// ────────────────────────────────────────────────────────────────
function formatScan(scan) {
  const lines = [];
  lines.push(`mesh-registry-backstop — RES-16 post-fetch detection over ${scan.source}`);
  if (scan.clean) {
    lines.push(`  clean — ${scan.records.length} tuple(s) match the correctly-fenced form`);
    return lines.join("\n");
  }
  lines.push(
    `  QUARANTINED ${scan.quarantined.length} of ${scan.records.length} tuple(s) — source-fence misconfiguration detected`,
  );
  for (const r of scan.quarantined) {
    lines.push(`  ref ${r.ref}: ${r.findingCount} finding(s)`);
    for (const f of r.findings) {
      lines.push(`    ${String(f.field).padEnd(26)} ${f.kind}`);
    }
  }
  lines.push("");
  lines.push(
    "  ALERT: quarantined refs MUST NOT be rendered by the console and MUST NOT be",
  );
  lines.push(
    "  consumed by the merge driver / decide-DOWN (specs/06 § 2 invariant 2).",
  );
  lines.push(
    "  DETECT-NOT-PREVENT: the raw objects are already fetched; re-author at SOURCE.",
  );
  return lines.join("\n");
}

// The machine-readable quarantine record the console consumer reads to enforce
// "MUST NOT render a quarantined ref" — carries refs + finding KINDS only, no
// raw values.
function quarantineManifest(scans) {
  const refs = [];
  for (const scan of scans) {
    for (const r of scan.quarantined) {
      refs.push({
        source: scan.source,
        ref: r.ref,
        findingCount: r.findingCount,
        kinds: [...new Set(r.findings.map((f) => f.kind))],
      });
    }
  }
  return { quarantined_refs: refs, quarantine_count: refs.length };
}

// ────────────────────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { mode: "report", sources: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") args.mode = "check";
    else if (a === "--json") args.mode = "json";
    else if (a === "--help" || a === "-h") args.mode = "help";
    else if (a === "-") args.sources.push("-");
    else if (!a.startsWith("--")) args.sources.push(a);
    else return { error: `unknown flag: ${a}` };
  }
  return args;
}

const HELP = `mesh-registry-backstop — loom-side POST-FETCH detection backstop (RES-16)

DETECT-ONLY re-scan of the UP-pulled registry text at loom-command. Re-applies
the shipped scrub-at-source predicate (mesh-registry-scrub.mjs::scrubTuple) to
each fetched tuple and QUARANTINES any tuple that is NOT a fixed point of the
fence — a raw value survived, a HARD violation is present, or the fetched value
differs from its correctly-fenced form. It CANNOT unfetch the objects
(detect-not-prevent); scrub-at-source remains the only prevent-side fence.

Contract: workspaces/knowledge-mesh-2026-07-10/specs/04-plane-split.md
§ "The loom-side post-fetch detection BACKSTOP (RES-16)".

Usage:
  mesh-registry-backstop <registry.json>...   scan; print redacted report
  mesh-registry-backstop --check <reg.json>   exit 1 if any ref quarantined
  mesh-registry-backstop --json <reg.json>    emit the quarantine manifest (JSON)
  cat registry.json | mesh-registry-backstop -   read from stdin
  mesh-registry-backstop --help

A fetched registry is one project's committed registry text — an array of
tuples, a { ref: tuple } map, or a single tuple.

Findings NEVER print a raw value or an untrusted field key (rendered redacted).
Exit: 0 clean · 1 ≥1 quarantined ref (--check) · 2 usage/read error`;

function readSource(src) {
  if (src === "-") return fs.readFileSync(0, "utf8");
  return fs.readFileSync(src, "utf8");
}

// A whole-registry JSON parse failure is a fail-closed QUARANTINE of that
// source (a malformed fetched registry is unusable), NOT a silent skip.
function scanOneSource(src) {
  let raw;
  try {
    raw = readSource(src);
  } catch (e) {
    // Read/IO failure is operational, not a disclosure finding — surface it.
    return { readError: `cannot read ${src}: ${e.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed registry text ⇒ quarantine the whole source, fail-closed.
    return {
      source: src,
      records: [{ ref: "<source>", quarantined: true, findings: [{ field: "<source>", kind: FINDING_KINDS.MALFORMED }], findingCount: 1 }],
      quarantined: [{ ref: "<source>", quarantined: true, findings: [{ field: "<source>", kind: FINDING_KINDS.MALFORMED }], findingCount: 1 }],
      clean: false,
    };
  }
  return scanRegistry(parsed, src);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.error) {
    process.stderr.write(`${args.error}\n\n${HELP}\n`);
    process.exit(2);
  }
  if (args.mode === "help") {
    process.stdout.write(`${HELP}\n`);
    process.exit(0);
  }
  if (args.sources.length === 0) {
    process.stderr.write(`error: no registry source given\n\n${HELP}\n`);
    process.exit(2);
  }

  const scans = [];
  for (const src of args.sources) {
    const scan = scanOneSource(src);
    if (scan.readError) {
      process.stderr.write(`error: ${scan.readError}\n`);
      process.exit(2);
    }
    scans.push(scan);
  }

  const anyQuarantined = scans.some((s) => !s.clean);

  if (args.mode === "json") {
    process.stdout.write(`${JSON.stringify(quarantineManifest(scans), null, 2)}\n`);
    process.exit(anyQuarantined ? 1 : 0);
  }
  if (args.mode === "check") {
    if (anyQuarantined) {
      for (const scan of scans) if (!scan.clean) process.stderr.write(`${formatScan(scan)}\n`);
      process.exit(1);
    }
    process.stdout.write("mesh-registry-backstop: clean (no quarantined refs)\n");
    process.exit(0);
  }
  // report mode
  for (const scan of scans) process.stdout.write(`${formatScan(scan)}\n\n`);
  process.exit(anyQuarantined ? 1 : 0);
}

// ESM: run main() only when invoked as a script, not when imported by tests.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();

export {
  detectTuple,
  scanRegistry,
  normalizeEntries,
  quarantineManifest,
  formatScan,
  parseArgs,
  FINDING_KINDS,
};
