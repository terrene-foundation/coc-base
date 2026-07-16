#!/usr/bin/env node
/*
 * ============================================================================
 *  Knowledge-Mesh Registry Tuple-Shape Validator — Wave-1 Shard 1a
 * ============================================================================
 *
 *  AUTHORITATIVE CONTRACT (this tool IMPLEMENTS it, never restates the
 *  derivation — `.claude/rules/specs-authority.md` Rule 9):
 *    workspaces/knowledge-mesh-2026-07-10/specs/02-knowledge-product-identity.md
 *      § "The registry tuple (13 fields)"     (the 13-field shape + grammars)
 *      § "The object"                          (identity ≠ instance)
 *    .claude/rules/specs-authority.md Rule 10  (governed knowledge-product field,
 *                                               inert-at-loom)
 *
 *  THE REGISTRY ARTIFACT CLASS. A knowledge-product's IDENTITY (not its bytes)
 *  is the mesh-level object. It is authored AT THE PROJECT and UP-pulled to
 *  loom-command; it is INERT AT LOOM (loom writes identities, never resolves
 *  them). This validator checks the 13-field TUPLE SHAPE:
 *    name · version · lineage_id · content_hash · content_commitment ·
 *    classification · owning_level · product_class · cascade_scope ·
 *    provenance · staleness_policy_ref · reservoir_locator · merged_from[]
 *  The canonical 13-field set + the grammars are IMPORTED from the S1 scrub
 *  engine (mesh-registry-scrub.mjs::DISPOSITIONS/ENUMS/VERSION_GRAMMAR/
 *  isOpaqueHandle) so this validator and the fence can NEVER drift.
 *
 *  IDENTITY ≠ INSTANCE (invariant 5). `reservoir_locator` is OPAQUE at loom:
 *  this tool NEVER resolves it, `git fetch`es it, or materializes its bytes —
 *  it validates that it is a string and leaves it unresolved (inert-at-loom,
 *  Rule 10 invariant 5).
 *
 *  This is a SHAPE validator, NOT the disclosure fence. Disclosure scrubbing is
 *  mesh-registry-scrub.mjs (S1); commitment minting is mesh-content-commitment.mjs
 *  (1c). This tool answers "is this a well-formed 13-field registry tuple?".
 *
 *  Usage:
 *    mesh-registry-validate <tuple.json>          human report
 *    mesh-registry-validate --check <tuple.json>  exit 1 if not a valid tuple
 *    cat tuple.json | mesh-registry-validate -    read from stdin
 *    mesh-registry-validate --help
 *
 *  Exit: 0 valid · 1 invalid (--check) · 2 usage/parse error.
 * ============================================================================
 */

import fs from "node:fs";

import { DISPOSITIONS, ENUMS, VERSION_GRAMMAR, isOpaqueHandle } from "./mesh-registry-scrub.mjs";

// The canonical 13 field names — single source (the scrub engine's disposition
// table). Any drift between the fence and this validator is impossible.
export const TUPLE_FIELDS = Object.keys(DISPOSITIONS);

// The identity-defining CORE that every registry tuple MUST carry. (content_hash
// is LOCAL-ONLY and OPTIONAL in a published tuple; merged_from[] is present only
// after a dedup-merge; provenance/staleness/reservoir/classification are metadata.)
const REQUIRED_CORE = ["name", "version", "lineage_id", "owning_level", "product_class", "cascade_scope"];

// Fields carrying an opaque ≥128-bit value (clause (a) grammar).
const OPAQUE_FIELDS = ["lineage_id", "content_commitment"];

/**
 * Validate a registry tuple's SHAPE. Fail-closed: returns findings, never throws
 * on bad input.
 * @param {any} tuple
 * @returns {{ok:boolean, errors:string[], warnings:string[]}}
 */
export function validateTuple(tuple) {
  const errors = [];
  const warnings = [];
  if (tuple === null || typeof tuple !== "object" || Array.isArray(tuple)) {
    return { ok: false, errors: ["input is not a registry-tuple object"], warnings };
  }

  // (1) Unknown fields → fail-closed (the tuple is a bounded 13-field shape).
  for (const field of Object.keys(tuple)) {
    if (!Object.hasOwn(DISPOSITIONS, field)) {
      errors.push(`unknown field '${field}' — the registry tuple is a bounded 13-field shape (specs/02 § "The registry tuple")`);
    }
  }

  // (2) Required identity-core present.
  for (const f of REQUIRED_CORE) {
    if (!Object.hasOwn(tuple, f)) errors.push(`missing required core field '${f}'`);
  }

  // (3) version grammar.
  if (Object.hasOwn(tuple, "version") && !(typeof tuple.version === "string" && VERSION_GRAMMAR.test(tuple.version))) {
    errors.push("`version` does not match ^[0-9]+(\\.[0-9]+)*$ (specs/02 § The URN)");
  }

  // (4) opaque fields carry an opaque ≥128-bit value (a name-derived / readable
  //     value is invertible; clause (a) grammar).
  for (const f of OPAQUE_FIELDS) {
    if (Object.hasOwn(tuple, f) && !isOpaqueHandle(tuple[f])) {
      errors.push(`\`${f}\` is not an opaque ≥128-bit value (a readable / truncated / name-derived value is BLOCKED — clause (a))`);
    }
  }

  // (5) enum-bounded fields.
  for (const f of Object.keys(ENUMS)) {
    if (Object.hasOwn(tuple, f) && !(typeof tuple[f] === "string" && ENUMS[f].has(tuple[f]))) {
      errors.push(`\`${f}\` '${tuple[f]}' outside {${[...ENUMS[f]].join(", ")}}`);
    }
  }

  // (6) identity ≠ instance / inert-at-loom: reservoir_locator, if present, is a
  //     STRING that this tool NEVER resolves. A non-string is a shape error; a
  //     string is left OPAQUE (never fetched — Rule 10 invariant 5).
  if (Object.hasOwn(tuple, "reservoir_locator") && typeof tuple.reservoir_locator !== "string") {
    errors.push("`reservoir_locator` must be a string (opaque at loom — never resolved)");
  }

  // (7) merged_from[] is an array of strings when present.
  if (Object.hasOwn(tuple, "merged_from")) {
    if (!Array.isArray(tuple.merged_from)) errors.push("`merged_from` must be an array");
    else if (!tuple.merged_from.every((e) => typeof e === "string")) errors.push("`merged_from` entries must be strings (kp:// URNs)");
  }

  // (8) content_hash is LOCAL-ONLY: legal in a local tuple, but a WARNING that it
  //     MUST be excluded before the UP pull (the S1 fence enforces this).
  if (Object.hasOwn(tuple, "content_hash")) {
    warnings.push("`content_hash` is LOCAL-ONLY — it MUST be excluded from the UP-pull input set (the S1 scrub fails-closed on it; specs/02 clause (f))");
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { mode: "report", src: null };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--check") a.mode = "check";
    else if (t === "--help" || t === "-h") a.mode = "help";
    else if (t === "-") a.src = "-";
    else if (!t.startsWith("--")) a.src = t;
    else return { error: `unknown flag: ${t}` };
  }
  return a;
}

const HELP = `mesh-registry-validate — 13-field registry tuple-shape validator (Wave-1 1a)

  mesh-registry-validate <tuple.json>          human report
  mesh-registry-validate --check <tuple.json>  exit 1 if not a valid tuple
  cat tuple.json | mesh-registry-validate -    read from stdin
  mesh-registry-validate --help

Contract: workspaces/knowledge-mesh-2026-07-10/specs/02-knowledge-product-identity.md
§ "The registry tuple (13 fields)". SHAPE only — scrubbing is mesh-registry-scrub.mjs.
Exit: 0 valid · 1 invalid (--check) · 2 usage/parse error.`;

function main() {
  const a = parseArgs(process.argv);
  if (a.error) { process.stderr.write(`${a.error}\n\n${HELP}\n`); return 2; }
  if (a.mode === "help") { process.stdout.write(`${HELP}\n`); return 0; }
  if (!a.src) { process.stderr.write(`error: no tuple source given\n\n${HELP}\n`); return 2; }
  let raw;
  try {
    raw = a.src === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(a.src, "utf8");
  } catch (e) { process.stderr.write(`error: cannot read ${a.src}: ${e.message}\n`); return 2; }
  let tuple;
  try { tuple = JSON.parse(raw); } catch (e) { process.stderr.write(`error: input is not valid JSON: ${e.message}\n`); return 2; }

  const r = validateTuple(tuple);
  if (a.mode === "check") {
    if (!r.ok) { process.stderr.write(`mesh-registry-validate: INVALID\n  - ${r.errors.join("\n  - ")}\n`); return 1; }
    process.stdout.write("mesh-registry-validate: valid 13-field registry tuple\n");
    return 0;
  }
  const lines = [`mesh-registry-validate — ${r.ok ? "VALID" : "INVALID"}`];
  if (r.errors.length) { lines.push("Errors:"); for (const e of r.errors) lines.push(`  - ${e}`); }
  if (r.warnings.length) { lines.push("Warnings:"); for (const w of r.warnings) lines.push(`  - ${w}`); }
  process.stdout.write(`${lines.join("\n")}\n`);
  return r.ok ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) process.exit(main());

export { REQUIRED_CORE, OPAQUE_FIELDS };
