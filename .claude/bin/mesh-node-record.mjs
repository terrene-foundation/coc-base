#!/usr/bin/env node
/*
 * ============================================================================
 *  Knowledge-Mesh Ancestor-Chain NODE RECORD — Wave-1 Shard 1d
 *  (closes RES-14(ii): the net-new node-record artifact class + its
 *   sync-manifest distribution-fate declaration)
 * ============================================================================
 *
 *  AUTHORITATIVE CONTRACT (this tool IMPLEMENTS it, never restates the
 *  derivation — `.claude/rules/specs-authority.md` Rule 9):
 *    workspaces/knowledge-mesh-2026-07-10/specs/02-knowledge-product-identity.md
 *      clause (g)  — the ANCESTOR-CHAIN NODE RECORD (handles only; own handle +
 *                    ancestor chain to root; NO readable names, NO sibling handles)
 *    workspaces/knowledge-mesh-2026-07-10/specs/04-plane-split.md
 *      § "Seam contracts" A→B  (the record named as the crossing artifact; the
 *                               DOWN-fence-recognition requirement)
 *
 *  WHAT THE RECORD CARRIES — HANDLES ONLY.
 *    { schema, own_handle, ancestor_chain: [root_handle … parent_handle] }
 *  It supplies the SOURCE for a runtime's positional address in HANDLE SPACE
 *  (clause (d)/(g)): the runtime reads its OWN record and concatenates the chain.
 *
 *  WHAT THE RECORD MUST NOT CARRY (the disclosure fence around this class):
 *    - NO readable names (it is NOT the handle↔name map — it cannot deanonymize).
 *    - NO sibling handles (a project learns only its OWN path to the root; a
 *      sibling handle turns the record into a tenant-enumeration surface).
 *    - NO unknown fields (fail-closed on any field outside the 3-field shape).
 *  Every value is fail-closed-checked as an opaque ≥128-bit handle (isOpaqueHandle,
 *  imported from the S1 engine — single source, no drift).
 *
 *  DISTRIBUTION FATE (RES-14(ii)). Wave-1 delivers the node-record CLASS +
 *  validator + its DECLARED down-cascade fate in `.claude/sync-manifest.yaml`
 *  § "mesh_artifact_classes" (the RES-14(ii) class/source obligation). That
 *  stanza is DOCUMENTED fate, NOT a live sync input — no emit/sync consumer
 *  reads it — so the DOWN-tier cascade is DECLARED intent, and the actual
 *  wiring (adding `.claude/mesh/node-records/**` to a real sync-tier-aware DOWN
 *  tier) is a NAMED future obligation that lands WITH node-record generation in
 *  a later wave (redteam #965 R1 F1 — accuracy: loom holds zero node-record
 *  data today, so nothing cascades yet). The class is fail-closed-safe either
 *  way (handles only — nothing to scrub); see specs/04 § "Seam contracts".
 *
 *  Usage:
 *    mesh-node-record --check <record.json>   exit 1 if not a valid node record
 *    mesh-node-record --build --own <handle> --chain <h1,h2,…>
 *    cat record.json | mesh-node-record --check -
 *    mesh-node-record --help
 *
 *  Exit: 0 valid · 1 invalid (--check) · 2 usage/parse error.
 * ============================================================================
 */

import fs from "node:fs";

import { isOpaqueHandle } from "./mesh-registry-scrub.mjs";

export const NODE_RECORD_SCHEMA = "mesh-node-record/1";
const ALLOWED_KEYS = new Set(["schema", "own_handle", "ancestor_chain"]);

export class MeshNodeRecordError extends Error {
  constructor(message) {
    super(message);
    this.name = "MeshNodeRecordError";
  }
}

/**
 * Validate an ancestor-chain node record. Fail-closed: returns findings, never
 * throws on bad input.
 * @param {any} rec
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateNodeRecord(rec) {
  const errors = [];
  if (rec === null || typeof rec !== "object" || Array.isArray(rec)) {
    return { ok: false, errors: ["input is not a node-record object"] };
  }

  // (1) Fail-closed on ANY field outside the 3-field shape — a readable-name /
  //     sibling / children field is exactly what this rejects (clause (g)).
  for (const k of Object.keys(rec)) {
    if (!ALLOWED_KEYS.has(k)) {
      errors.push(`unknown field '${k}' — the node record carries ONLY {schema, own_handle, ancestor_chain}; a name / sibling / children field is BLOCKED (clause (g))`);
    }
  }

  // (2) schema tag.
  if (rec.schema !== NODE_RECORD_SCHEMA) {
    errors.push(`schema must be '${NODE_RECORD_SCHEMA}'`);
  }

  // (3) own_handle is an opaque ≥128-bit handle (never a readable name).
  if (!isOpaqueHandle(rec.own_handle)) {
    errors.push("`own_handle` is not an opaque ≥128-bit handle (a readable name is BLOCKED — the record cannot deanonymize)");
  }

  // (4) ancestor_chain is an array of opaque handles (root → parent). NO readable
  //     name survives the opacity check; NO sibling handle can appear because the
  //     chain is the linear path to the root, not a neighbourhood.
  if (!Array.isArray(rec.ancestor_chain)) {
    errors.push("`ancestor_chain` must be an array (root_handle … parent_handle)");
  } else {
    rec.ancestor_chain.forEach((h, i) => {
      if (!isOpaqueHandle(h)) {
        errors.push(`ancestor_chain[${i}] is not an opaque ≥128-bit handle (a readable name / sibling label is BLOCKED)`);
      }
    });
    // (5) own_handle MUST NOT appear in its own ancestor chain (it is the tip;
    //     the chain is ANCESTORS only — a self-reference is a malformed tree).
    if (isOpaqueHandle(rec.own_handle) && rec.ancestor_chain.includes(rec.own_handle)) {
      errors.push("`own_handle` appears in its own `ancestor_chain` — the record is the tip; the chain carries ancestors only");
    }
    // (6) No duplicate handles in the chain (a duplicate is a malformed/looped tree).
    const seen = new Set();
    for (const h of rec.ancestor_chain) {
      if (seen.has(h)) { errors.push("duplicate handle in `ancestor_chain` — the chain is a simple path to the root"); break; }
      seen.add(h);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Build a node record from an own handle + an ancestor chain. Validates; throws
 * MeshNodeRecordError on any invalid input (fail-closed, no stub).
 * @param {string} ownHandle
 * @param {string[]} ancestorChain  [root_handle … parent_handle]
 * @returns {{schema:string, own_handle:string, ancestor_chain:string[]}}
 */
export function buildNodeRecord(ownHandle, ancestorChain) {
  const rec = { schema: NODE_RECORD_SCHEMA, own_handle: ownHandle, ancestor_chain: ancestorChain };
  const r = validateNodeRecord(rec);
  if (!r.ok) throw new MeshNodeRecordError(`refusing to build an invalid node record: ${r.errors.join("; ")}`);
  return rec;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { mode: null, src: null, own: null, chain: null };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--check") { a.mode = "check"; a.src = argv[++i]; }
    else if (t === "--build") a.mode = "build";
    else if (t === "--own") a.own = argv[++i];
    else if (t === "--chain") a.chain = argv[++i];
    else if (t === "--help" || t === "-h") a.mode = "help";
    else if (t === "-" && a.mode === "check") a.src = "-";
    else return { error: `unknown argument: ${t}` };
  }
  return a;
}

const HELP = `mesh-node-record — ancestor-chain node record (handles only) — Wave-1 1d

  mesh-node-record --check <record.json>   exit 1 if not a valid node record
  mesh-node-record --build --own <handle> --chain <h1,h2,…>
  cat record.json | mesh-node-record --check -
  mesh-node-record --help

Contract: workspaces/knowledge-mesh-2026-07-10/specs/02-knowledge-product-identity.md
clause (g). HANDLES ONLY — no readable names, no sibling handles. DOWN-cascades
via Gate-2 (declared in sync-manifest.yaml § mesh_artifact_classes).
Exit: 0 valid · 1 invalid (--check) · 2 usage/parse error.`;

function main() {
  const a = parseArgs(process.argv);
  if (a.error) { process.stderr.write(`${a.error}\n\n${HELP}\n`); return 2; }
  if (!a.mode || a.mode === "help") { process.stdout.write(`${HELP}\n`); return a.mode ? 0 : 2; }

  if (a.mode === "build") {
    if (!a.own) { process.stderr.write("--build requires --own <handle>\n"); return 2; }
    const chain = a.chain ? a.chain.split(",").map((s) => s.trim()).filter(Boolean) : [];
    let rec;
    try { rec = buildNodeRecord(a.own, chain); } catch (e) { process.stderr.write(`mesh-node-record: ${e.message}\n`); return 1; }
    process.stdout.write(`${JSON.stringify(rec, null, 2)}\n`);
    return 0;
  }

  if (a.mode === "check") {
    if (!a.src) { process.stderr.write("--check requires a record.json (or -)\n"); return 2; }
    let raw;
    try { raw = a.src === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(a.src, "utf8"); }
    catch (e) { process.stderr.write(`error: cannot read ${a.src}: ${e.message}\n`); return 2; }
    let rec;
    try { rec = JSON.parse(raw); } catch (e) { process.stderr.write(`error: input is not valid JSON: ${e.message}\n`); return 2; }
    const r = validateNodeRecord(rec);
    if (!r.ok) { process.stderr.write(`mesh-node-record: INVALID\n  - ${r.errors.join("\n  - ")}\n`); return 1; }
    process.stdout.write("mesh-node-record: valid ancestor-chain node record (handles only)\n");
    return 0;
  }

  process.stderr.write(`${HELP}\n`);
  return 2;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) process.exit(main());
