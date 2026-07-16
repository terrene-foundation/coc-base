#!/usr/bin/env node
/*
 * ============================================================================
 *  Knowledge-Mesh Content-Commitment Helper + Scrub-at-Source Authoring Path
 *  — Wave-1 Shard 1c (loom knowledge-mesh identity registry)
 * ============================================================================
 *
 *  AUTHORITATIVE CONTRACT (this tool IMPLEMENTS it, never restates the
 *  derivation — `.claude/rules/specs-authority.md` Rule 9):
 *    workspaces/knowledge-mesh-2026-07-10/specs/02-knowledge-product-identity.md
 *      clause (f)  — the BLINDED JOIN: content_commitment = HMAC(k_eco, "kml/content/v1" ‖ bytes)
 *      clause (e)  — k_eco custody (per-trust-boundary, env/keychain, never committed)
 *      § "The UP-pull transport — and WHERE the fence sits"
 *    workspaces/knowledge-mesh-2026-07-10/specs/04-plane-split.md
 *      § "WHERE the fence runs — at the SOURCE, before the commit"
 *
 *  TWO OBLIGATIONS:
 *
 *  (A) content_commitment = HMAC(k_eco, "kml/content/v1" ‖ content_bytes) — the
 *      domain-separated form (specs/02 clause (f), RES-13). The UP pull publishes
 *      THIS in place of the raw content_hash (D-6). k_eco is PER-TRUST-BOUNDARY
 *      (held by one tenant's levels, NEVER by loom-command, NEVER shared across
 *      mutually-distrusting clients), ≥128-bit CSPRNG, env/keychain, never
 *      committed — sourced through lib/mesh-keys.mjs. loom-command sees EQUALITY
 *      (within-tenant merge detection survives) but holds no k_eco (the RES-8
 *      membership oracle is dead by construction).
 *
 *  (B) THE SCRUB-AT-SOURCE ENFORCEMENT POINT. The registry text is `git fetch`ed
 *      by loom-command, so a fence AFTER the fetch is structurally too late — the
 *      raw objects are already in loom-command's `.git`. Therefore the project
 *      AUTHORS its tuple ALREADY-SCRUBBED, pre-commit. `authorRegistryTuple`
 *      WIRES the S1 fence (mesh-registry-scrub.mjs::scrubTuple) into that
 *      authoring path: it runs the scrub and REFUSES to emit a committable tuple
 *      on any HARD violation (vault material or raw content_hash present). This
 *      is the point where the S1 fence actually BITES — an unwired fence ships a
 *      registry that authors raw values (the shard-1c value-anchor, brief REQ-12).
 *
 *  Usage:
 *    mesh-content-commitment --commit <content-file> [--key-env MESH_ECO_KEY]
 *        → print content_commitment (HMAC-SHA256 hex) for the file's bytes
 *    mesh-content-commitment --author <raw-tuple.json> [--out <path>]
 *        → run the S1 scrub over the tuple; write the SCRUBBED tuple (stdout or
 *          --out); exit 1 on any HARD violation (the pre-commit gate)
 *    mesh-content-commitment --mint-key   print a fresh ≥128-bit k_eco (for env)
 *    mesh-content-commitment --help
 *
 *  Exit: 0 ok · 1 hard violation / key error · 2 usage/parse error.
 * ============================================================================
 */

import fs from "node:fs";
import crypto from "node:crypto";

import { scrubTuple, formatReport } from "./mesh-registry-scrub.mjs";
import { loadKey, mintKeyHex, MeshKeyError } from "./lib/mesh-keys.mjs";

export class MeshCommitmentError extends Error {
  constructor(message) {
    super(message);
    this.name = "MeshCommitmentError";
  }
}

// ── (A) content_commitment = HMAC(k_eco, content_bytes) — clause (f) ─────────
/**
 * @param {Buffer} kEco  the per-trust-boundary key (≥128-bit, from lib/mesh-keys)
 * @param {Buffer|string} contentBytes  the payload bytes
 * @returns {string} the commitment (HMAC-SHA256 hex, 64 chars, opaque, UNTRUNCATED)
 */
// Domain-separation label — specs/02 clause (f): "DOMAIN SEPARATION IS A MUST on
// EVERY k_eco use (RES-13 hardening, 2026-07-13)". Every k_eco use prefixes a
// distinct, versioned label BEFORE the operand so a document's bytes can never
// alias the within-boundary co-keying challenge PRF(k_eco, "kml/cokeying/v1" ‖ nonce).
// The label rides the SAME digest; adding it changes zero other properties (still a
// 64-hex UNTRUNCATED HMAC-SHA256, deterministic, opaque). Migration cost is zero —
// no registry is published yet. The co-keying counterpart is the RES-23 BUILD seam
// (UNBUILT); this closes the ONE live k_eco use to the clause-(f) MUST now.
const CONTENT_COMMITMENT_LABEL = "kml/content/v1";

export function contentCommitment(kEco, contentBytes) {
  if (!Buffer.isBuffer(kEco)) {
    throw new MeshCommitmentError(
      "contentCommitment: k_eco must be a ≥128-bit key Buffer (per-trust-boundary; load via lib/mesh-keys.mjs::loadKey, NEVER hardcode)",
    );
  }
  // HMAC(k_eco, "kml/content/v1" ‖ content_bytes) — domain-separated (specs/02 clause (f)).
  return crypto
    .createHmac("sha256", kEco)
    .update(CONTENT_COMMITMENT_LABEL)
    .update(contentBytes)
    .digest("hex");
}

// ── (B) Scrub-at-source authoring path — WIRE the S1 fence pre-commit ────────
/**
 * Author a registry tuple ALREADY-SCRUBBED. Runs the S1 fence (scrubTuple) and
 * REFUSES a committable tuple on any HARD violation — the scrub-at-source
 * enforcement point (specs/04 § "WHERE the fence runs — at the SOURCE").
 * @param {object} rawTuple
 * @returns {{ok:boolean, scrubbed:object, result:object}}  ok=false ⇒ do NOT commit
 */
export function authorRegistryTuple(rawTuple) {
  const result = scrubTuple(rawTuple);
  // ok===false ⇒ a HARD violation (vault material or raw content_hash present) —
  // the tuple MUST NOT be committed; the scrub already dropped the offending
  // material, but the AUTHORING is refused so the author re-derives at the source.
  return { ok: result.ok, scrubbed: result.scrubbed, result };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { mode: null, src: null, keyEnv: "MESH_ECO_KEY", out: null };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--commit") { a.mode = "commit"; a.src = argv[++i]; }
    else if (t === "--author") { a.mode = "author"; a.src = argv[++i]; }
    else if (t === "--mint-key") a.mode = "mint-key";
    else if (t === "--key-env") a.keyEnv = argv[++i];
    else if (t === "--out") a.out = argv[++i];
    else if (t === "--help" || t === "-h") a.mode = "help";
    else return { error: `unknown argument: ${t}` };
  }
  return a;
}

const HELP = `mesh-content-commitment — content_commitment helper + scrub-at-source authoring (Wave-1 1c)

  mesh-content-commitment --commit <content-file> [--key-env MESH_ECO_KEY]
       print content_commitment = HMAC(k_eco, file-bytes)
  mesh-content-commitment --author <raw-tuple.json> [--out <path>]
       run the S1 scrub over the tuple pre-commit; write the SCRUBBED tuple;
       exit 1 on any HARD violation (the scrub-at-source gate)
  mesh-content-commitment --mint-key   print a fresh ≥128-bit k_eco (paste into env)
  mesh-content-commitment --help

Contract: workspaces/knowledge-mesh-2026-07-10/specs/02-knowledge-product-identity.md
clause (f) + § "WHERE the fence runs — at the SOURCE, before the commit".
k_eco is PER-TRUST-BOUNDARY, ≥128-bit CSPRNG, env/keychain, NEVER committed.`;

function main() {
  const a = parseArgs(process.argv);
  if (a.error) { process.stderr.write(`${a.error}\n\n${HELP}\n`); return 2; }
  if (!a.mode || a.mode === "help") { process.stdout.write(`${HELP}\n`); return a.mode ? 0 : 2; }

  if (a.mode === "mint-key") { process.stdout.write(`${mintKeyHex()}\n`); return 0; }

  if (a.mode === "commit") {
    if (!a.src) { process.stderr.write("--commit requires a content file\n"); return 2; }
    let bytes;
    try { bytes = fs.readFileSync(a.src); } catch (e) { process.stderr.write(`error: cannot read ${a.src}: ${e.message}\n`); return 2; }
    let key;
    try { key = loadKey(a.keyEnv); } catch (e) {
      if (e instanceof MeshKeyError) { process.stderr.write(`mesh-content-commitment: ${e.message}\n`); return 1; }
      throw e;
    }
    process.stdout.write(`${contentCommitment(key, bytes)}\n`);
    return 0;
  }

  if (a.mode === "author") {
    if (!a.src) { process.stderr.write("--author requires a raw-tuple.json\n"); return 2; }
    let raw;
    try { raw = fs.readFileSync(a.src, "utf8"); } catch (e) { process.stderr.write(`error: cannot read ${a.src}: ${e.message}\n`); return 2; }
    let tuple;
    try { tuple = JSON.parse(raw); } catch (e) { process.stderr.write(`error: input is not valid JSON: ${e.message}\n`); return 2; }
    const { ok, scrubbed, result } = authorRegistryTuple(tuple);
    if (!ok) {
      // HARD violation: the scrub-at-source gate REFUSES the commit. Report is
      // safe (no raw values); the author re-derives at the source.
      process.stderr.write(`${formatReport(result)}\n`);
      process.stderr.write("mesh-content-commitment: AUTHORING REFUSED — re-author the tuple without vault material / raw content_hash (scrub-at-source, specs/04)\n");
      return 1;
    }
    const outText = JSON.stringify(scrubbed, null, 2) + "\n";
    if (a.out) { fs.writeFileSync(a.out, outText); process.stderr.write(`scrubbed tuple written to ${a.out}\n`); }
    else process.stdout.write(outText);
    return 0;
  }

  process.stderr.write(`${HELP}\n`);
  return 2;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) process.exit(main());
