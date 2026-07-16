#!/usr/bin/env node
/*
 * ============================================================================
 *  Knowledge-Mesh `/distill` REGISTRAR ENGINE — Wave-3 Shard 3b
 *  (loom's UP-cascade ingestion verb — the `/codify` analog for KNOWLEDGE
 *   PRODUCTS; INERT AT LOOM: never runs an engine, never `db.start()`s)
 * ============================================================================
 *
 *  AUTHORITATIVE CONTRACT (this tool IMPLEMENTS it, never restates the
 *  derivation — `.claude/rules/specs-authority.md` Rule 9 + Rule 10):
 *    workspaces/knowledge-mesh-2026-07-10/01-analysis/07-ingestion-distill-engine.md
 *      § 2.2  — the inert outputs `/distill` PRODUCES (4 emitted surfaces here;
 *               the 5th contract output, the spec→product LINK, binds downstream)
 *      § 1.3  — routing by SOURCE-SHAPE (structured → DataFlow; unstructured → Kaizen)
 *    workspaces/knowledge-mesh-2026-07-10/02-plans/01-wave-roadmap.md § Wave 3
 *      the 3-shard plan + the ~5 invariants + the REGISTRAR MODEL (C7 B1=YES)
 *    .claude/rules/specs-authority.md Rule 10 invariant 5 — REGISTER-vs-BIND:
 *      `/distill` REGISTERS the `kp://` identity into loom's control-plane; the
 *      DOWNSTREAM domain-spec owner BINDS the `knowledge-product:` link in ITS
 *      OWN repo. loom NEVER authors the downstream link (repo-scope-discipline).
 *    workspaces/knowledge-mesh-2026-07-10/specs/02-knowledge-product-identity.md
 *      clause (f) — the raw `content_hash` NEVER leaves the project; publish
 *      `content_commitment` = HMAC(k_eco, "kml/content/v1" ‖ bytes) instead.
 *
 *  THIS ENGINE ORCHESTRATES THE WAVE-1 BINS — it does NOT reimplement them
 *  (`.claude/rules/zero-tolerance.md` Rule 4):
 *    mesh-urn.mjs               → mint/validate the `kp://` URN (Rule-10 shape)
 *    mesh-content-commitment.mjs→ contentCommitment(k_eco,·) + authorRegistryTuple
 *                                 (the S1 scrub-at-source pre-commit gate)
 *    mesh-registry-validate.mjs → validateTuple (13-field shape)
 *    mesh-node-record.mjs       → buildNodeRecord (handles-only lineage chain)
 *    lib/mesh-keys.mjs          → loadKey (k_eco custody, env/keychain only)
 *
 *  INERT-AT-LOOM (invariant 1, roadmap § Wave 3). Every output is DECLARATIVE
 *  text/data: identity tuple, a `db.source`/`@db.product` config MANIFEST, a
 *  content_commitment, a provenance index, a #757 claim descriptor. This engine
 *  NEVER calls `db.start()`, never queries, never resolves a `reservoir_locator`,
 *  never touches a sibling repo's working tree (loom's charter Directive 0).
 *
 *  DETERMINISTIC LIBRARY CORE (`.claude/rules/testing.md`). `distill()` calls
 *  NO `Date.now()` / `Math.random()`: the `<domain>` handle is MINTED LOCALLY at
 *  the project vault and passed IN (Rule 10); the clock + operator id are INJECTED
 *  via opts. Only the CLI wires the real clock.
 *
 *  Usage:
 *    mesh-distill --distill <input.json> [--key-env MESH_ECO_KEY] [--out <path>]
 *        → emit the 4 inert surfaces (registry · manifest · provenance · claim) as
 *          one JSON document — the content_commitment is carried INSIDE the
 *          registry tuple, and the 5th contract output (the spec→product LINK) is
 *          BOUND downstream by the domain owner, never by /distill (REGISTER-vs-BIND).
 *          exit 1 on any fail-closed refusal
 *    mesh-distill --route <source-shape>   → print the engine tier (db.source|kaizen.rag)
 *    mesh-distill --help
 *
 *  Exit: 0 ok · 1 fail-closed refusal / key error · 2 usage/parse error.
 * ============================================================================
 */

import fs from "node:fs";

import { mintUrn, MeshUrnError } from "./mesh-urn.mjs";
import { contentCommitment, authorRegistryTuple, MeshCommitmentError } from "./mesh-content-commitment.mjs";
import { validateTuple } from "./mesh-registry-validate.mjs";
import { buildNodeRecord, MeshNodeRecordError } from "./mesh-node-record.mjs";
import { loadKey, MeshKeyError } from "./lib/mesh-keys.mjs";
import { scrubMergedFrom } from "./mesh-registry-scrub.mjs";

export const FABRIC_MANIFEST_SCHEMA = "mesh-distill-fabric-manifest/1";
export const PROVENANCE_SCHEMA = "mesh-distill-provenance/1";
export const CLAIM_SCHEMA = "mesh-distill-claim/1";
export const REGISTRY_ENTRY_SCHEMA = "mesh-distill-registry-entry/1";

export class MeshDistillError extends Error {
  constructor(message) {
    super(message);
    this.name = "MeshDistillError";
  }
}

// ────────────────────────────────────────────────────────────────
// Name-blind a `kp://` URN for any surface loom-command UP-pulls (the registry
// entry + the #757 claim path). The readable <name> segment MUST NOT reach
// loom-command (M3 name-blindness, specs/04) — exactly as the fence already
// redacts every merged_from[] URN. Reuses the fence's OWN scrubMergedFrom so the
// redaction + segment-validation are byte-identical: a conforming URN becomes
// kp://<owning_level>/<domain>/«REDACTED_NAME»@<version>; a malformed one
// fail-closes to «REDACTED». The full readable URN stays LOCAL in the project
// handle vault (mesh-urn.mjs) — it is NEVER surfaced by this engine. Uniqueness
// on the UP surface is carried by the opaque <domain> handle, not the <name>.
// ────────────────────────────────────────────────────────────────
export function nameBlindUrn(fullUrn) {
  const { value } = scrubMergedFrom([fullUrn], "urn", []);
  return value[0];
}

// ── Routing by SOURCE-SHAPE (analysis § 1.3) ─────────────────────────────────
// structured (db/rest/file/cloud/stream/tabular) → DataFlow `db.source`;
// unstructured (pdf/docx/image/text) → Kaizen RAG (decode → extraction → embed).
// The discriminator mirrors Aether's classify_record_type() collapse.
const STRUCTURED_SHAPES = new Set([
  "db", "database", "sql", "warehouse", "table", "rest", "api",
  "file", "cloud", "stream", "csv", "tsv", "xlsx", "xls",
]);
const UNSTRUCTURED_SHAPES = new Set([
  "pdf", "docx", "doc", "txt", "text", "md", "markdown",
  "html", "image", "png", "jpg", "jpeg", "ocr", "scan",
]);

/**
 * Map a source shape to its engine tier. Fail-closed: an UNKNOWN shape RAISES
 * (no silent default — zero-tolerance.md Rule 3), because an unrouted shape has
 * no correct manifest to emit.
 * @param {string} sourceShape
 * @returns {"db.source"|"kaizen.rag"}
 */
export function routeBySourceShape(sourceShape) {
  const s = String(sourceShape || "").toLowerCase();
  if (STRUCTURED_SHAPES.has(s)) return "db.source";
  if (UNSTRUCTURED_SHAPES.has(s)) return "kaizen.rag";
  throw new MeshDistillError(
    `routeBySourceShape: unknown source shape '${sourceShape}' — cannot emit a manifest (fail-closed; ` +
      `structured→db.source | unstructured→kaizen.rag, analysis § 1.3)`,
  );
}

// ── The declarative fabric MANIFEST (output 2) — NEVER `db.start()` ──────────
/**
 * Build the DECLARATIVE `db.source`/`@db.product` (or Kaizen RAG) fabric manifest
 * for `/sync-to-build`. It is CONFIG TEXT — no engine call, no `db.start()`
 * (running it is code-at-loom, a charter Directive-0 violation). The engine
 * (kailash-rs/py) resolves it; loom only AUTHORS it.
 * @returns {{schema,engine,runs_engine:false,emitted_for,directives:string[]}}
 */
function buildFabricManifest(engine, handle, sourceShape) {
  // The manifest is INERT + NAME-BLIND + REGISTER-not-BIND: it carries only the
  // ROUTING (adapter / engine tier) keyed on the OPAQUE handle. The client
  // CONNECTION CONFIG (host / database / credentials — the SAME infra-disclosure
  // class the tuple's reservoir_locator is scrubbed for) is BOUND DOWNSTREAM at
  // the engine deployment (kailash-rs/py), where the client's real infra lives —
  // NEVER baked into this loom-retained, /sync-to-build-distributed artifact.
  // (Round-2 redteam: raw operator source_config interpolation was a leak sibling
  // of the round-1 URN name leak — a distributed surface carrying client tokens.)
  const cfg = JSON.stringify({ adapter: sourceShape, connection: "bind-at-engine-deployment" });
  const directives =
    engine === "db.source"
      ? [`db.source("${handle}", ${cfg})`, `@db.product(mode="virtual")  # fail-closed leash tier`]
      : [`kaizen.rag_source("${handle}", ${cfg})`, `@db.product(mode="virtual")  # decode→extract→embed`];
  // Fail-closed self-check: a manifest MUST NOT carry an engine-run directive.
  // `db.start()` is the run command — its presence would mean loom emitted
  // executable engine invocation, not declarative config (invariant 1).
  for (const d of directives) {
    if (d.includes("db.start(")) {
      throw new MeshDistillError("fabric manifest contains a db.start() run directive — the manifest is declarative-only (invariant 1)");
    }
  }
  return { schema: FABRIC_MANIFEST_SCHEMA, engine, runs_engine: false, emitted_for: "/sync-to-build", connection_bound: "downstream-engine-deployment", directives };
}

// ── The orchestrator — produces the 4 inert surfaces (analysis § 2.2; the
//    content_commitment rides inside registry.tuple, and the 5th contract output
//    — the spec→product LINK — is BOUND downstream, never by /distill) ──────────
/**
 * @param {object} input
 *   name, owning_level, version, domain_handle, source_shape, classification,
 *   product_class, cascade_scope, lineage_id, provenance, staleness_policy_ref,
 *   reservoir_locator, content_commitment?, merged_from?,
 *   ancestors? (opaque handle chain root..parent), deny_tokens?
 *   source_config? — ACCEPTED but IGNORED by design: client connection config
 *     binds DOWNSTREAM at the engine deployment, never in the loom-retained
 *     manifest (round-2 redteam — it was an infra-disclosure leak sibling).
 *   content_bytes? — bytes to COMMIT (→ content_commitment via the Wave-1 helper)
 *   content_hash?  — a PRESENT raw hash is a HARD violation (clause (f); refused)
 * @param {object} opts
 *   clock  : () => number (ms since epoch)      REQUIRED for the claim id
 *   verified_id : string                        REQUIRED for the claim id
 *   kEco   : Buffer                              REQUIRED when content_bytes given
 * @returns {{registry, manifest, provenance, claim}}
 */
export function distill(input, opts = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new MeshDistillError("distill: input must be an object");
  }
  const clock = opts.clock;
  if (typeof clock !== "function") {
    throw new MeshDistillError("distill: opts.clock (()=>ms) is REQUIRED — the library core never calls Date.now() (testing.md determinism)");
  }
  const verifiedId = opts.verified_id;
  if (typeof verifiedId !== "string" || verifiedId.length === 0) {
    throw new MeshDistillError("distill: opts.verified_id is REQUIRED for the #757 claim descriptor");
  }

  // (1) REGISTER — mint the Rule-10 `kp://` URN + author the scrubbed registry
  //     tuple. The <domain> handle is MINTED LOCALLY at the project vault and
  //     passed IN (Rule 10) — this engine NEVER derives it from the name.
  let urn;
  try {
    urn = mintUrn(
      { owning_level: input.owning_level, domain_handle: input.domain_handle, name: input.name, version: input.version },
      { denyTokens: input.deny_tokens || [] },
    );
  } catch (e) {
    if (e instanceof MeshUrnError) throw new MeshDistillError(`REGISTER refused: ${e.message}`);
    throw e;
  }

  // Name-blind the URN for every loom-command (UP-pulled) surface — the readable
  // <name> stays LOCAL in the project vault and MUST NOT reach loom-command (M3).
  // registry.urn + claim.path below use urnUp, NEVER the raw readable urn.
  const urnUp = nameBlindUrn(urn);

  // content_commitment: mint via the Wave-1 helper when raw bytes are supplied
  // (the raw content_hash NEVER leaves — clause (f)); otherwise accept a
  // precomputed commitment. A raw `content_hash` in the input is a HARD
  // violation the scrub-at-source gate refuses below (invariant: never emitted).
  let commitment = input.content_commitment;
  if (input.content_bytes !== undefined) {
    if (!Buffer.isBuffer(opts.kEco)) {
      throw new MeshDistillError("distill: opts.kEco (Buffer) is REQUIRED to mint content_commitment from content_bytes (clause (f) custody)");
    }
    try {
      commitment = contentCommitment(opts.kEco, input.content_bytes);
    } catch (e) {
      if (e instanceof MeshCommitmentError) throw new MeshDistillError(`content_commitment refused: ${e.message}`);
      throw e;
    }
  }

  // Build the raw 13-field tuple. content_hash is DELIBERATELY absent (excluded
  // by construction); if the caller smuggled one in, it rides through to the
  // scrub-at-source gate which HARD-violates (fail-closed refusal).
  const rawTuple = {
    name: input.name,
    version: input.version,
    lineage_id: input.lineage_id,
    ...(commitment !== undefined ? { content_commitment: commitment } : {}),
    classification: input.classification,
    owning_level: input.owning_level,
    product_class: input.product_class,
    cascade_scope: input.cascade_scope,
    provenance: input.provenance,
    staleness_policy_ref: input.staleness_policy_ref,
    reservoir_locator: input.reservoir_locator,
    ...(input.merged_from !== undefined ? { merged_from: input.merged_from } : {}),
    ...(input.content_hash !== undefined ? { content_hash: input.content_hash } : {}),
  };

  // Shape check (13-field identity) on the RAW tuple.
  const shape = validateTuple(rawTuple);
  if (!shape.ok) {
    throw new MeshDistillError(`REGISTER refused — tuple shape invalid: ${shape.errors.join("; ")}`);
  }

  // Scrub-at-source gate: produces the committable (name/provenance/locator-
  // redacted) tuple AND fails closed on any HARD violation (raw content_hash /
  // vault material present). This is where invariant "raw content_hash never
  // leaves" BITES.
  const authored = authorRegistryTuple(rawTuple);
  if (!authored.ok) {
    throw new MeshDistillError(
      "REGISTER refused — scrub-at-source HARD violation (raw content_hash or vault material present; clause (f)/(c)). " +
        "Publish content_commitment only; the raw hash stays home.",
    );
  }

  const registry = {
    schema: REGISTRY_ENTRY_SCHEMA,
    urn: urnUp, // NAME-BLIND (M3): the readable <name> stays in the vault, never UP-pulled
    tuple: authored.scrubbed, // already-scrubbed, safe to commit + UP-pull
    // REGISTER-vs-BIND (Rule 10 invariant 5): loom REGISTERS the identity; the
    // downstream domain-spec owner BINDS the `knowledge-product:` link in ITS
    // OWN repo. This engine authors NO downstream link.
    bind: "downstream-domain-spec-owner",
    registered_at: "loom-control-plane",
  };

  // (2) The declarative fabric MANIFEST — routed by source shape; NEVER db.start().
  const engine = routeBySourceShape(input.source_shape);
  // source_config is DELIBERATELY NOT passed: client connection config binds
  // downstream at the engine deployment, never in this loom-retained manifest.
  const manifest = buildFabricManifest(engine, input.domain_handle, String(input.source_shape).toLowerCase());

  // (4) Provenance index — O-taxonomy trail + the lineage DAG root, reusing the
  //     handles-only node record (no readable names, no sibling handles). No new crypto.
  let nodeRecord;
  try {
    nodeRecord = buildNodeRecord(input.domain_handle, Array.isArray(input.ancestors) ? input.ancestors : []);
  } catch (e) {
    if (e instanceof MeshNodeRecordError) throw new MeshDistillError(`provenance refused: ${e.message}`);
    throw e;
  }
  const provenance = {
    schema: PROVENANCE_SCHEMA,
    lineage_id: input.lineage_id, // the DAG root (opaque)
    origination: { taxonomy: "O-taxonomy", reuses: "PACT/EATP Provenance[T]" },
    node_record: nodeRecord,
  };

  // (5) The #757 domain-claim descriptor — keyed on the `kp://` URN, staked
  //     BEFORE classify writes. Reuses the multi-operator coordination claim
  //     shape (path-keyed). FP-4 reconciled: `/claim` is SINGLE-REPO; the
  //     cross-repo merge race is DETECT-EVENTUALLY, NOT prevented.
  const nowMs = clock();
  if (!Number.isFinite(nowMs)) {
    throw new MeshDistillError("distill: opts.clock() must return a finite ms timestamp");
  }
  const claim = {
    schema: CLAIM_SCHEMA,
    path: urnUp, // NAME-BLIND kp:// URN — loom's coordination substrate is name-blind (M3); the opaque <domain> carries uniqueness
    keyed_on_readable_name: false, // uniqueness is on the opaque <domain> handle, not the <name>
    keyed_on: "kp-urn",
    claim_id: `claim-${verifiedId}-${nowMs}`,
    substrate: "multi-operator-coordination", // reuses MUST-2 /claim substrate
    before: "classify-writes",
    scope: "single-repo", // FP-4: /claim covers ONE repo's coordination log
    cross_repo_merge: "detect-eventually", // FP-4: the two-repo race is detected, NOT prevented
    advisory: true,
  };

  return { registry, manifest, provenance, claim };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { mode: null, src: null, keyEnv: "MESH_ECO_KEY", out: null, shape: null, verifiedId: null };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--distill") { a.mode = "distill"; a.src = argv[++i]; }
    else if (t === "--route") { a.mode = "route"; a.shape = argv[++i]; }
    else if (t === "--key-env") a.keyEnv = argv[++i];
    else if (t === "--out") a.out = argv[++i];
    else if (t === "--verified-id") a.verifiedId = argv[++i];
    else if (t === "--help" || t === "-h") a.mode = "help";
    else return { error: `unknown argument: ${t}` };
  }
  return a;
}

const HELP = `mesh-distill — /distill REGISTRAR engine (inert-at-loom) — Wave-3 3b

  mesh-distill --distill <input.json> [--key-env MESH_ECO_KEY] [--verified-id ID] [--out <path>]
       emit the 4 inert surfaces (registry · manifest · provenance · claim;
       content_commitment rides inside the registry tuple, the spec→product LINK
       is bound downstream) as one JSON document
  mesh-distill --route <source-shape>   print the engine tier (db.source | kaizen.rag)
  mesh-distill --help

INERT-AT-LOOM: never db.start(), never a query, never a sibling-repo write.
REGISTER-vs-BIND (specs-authority Rule 10 inv.5): loom REGISTERS the kp:// identity;
the downstream domain-spec owner BINDS the knowledge-product: link in its own repo.
Contract: workspaces/knowledge-mesh-2026-07-10/01-analysis/07-ingestion-distill-engine.md § 2.2.`;

function main() {
  const a = parseArgs(process.argv);
  if (a.error) { process.stderr.write(`${a.error}\n\n${HELP}\n`); return 2; }
  if (!a.mode || a.mode === "help") { process.stdout.write(`${HELP}\n`); return a.mode ? 0 : 2; }

  if (a.mode === "route") {
    if (!a.shape) { process.stderr.write("--route requires a <source-shape>\n"); return 2; }
    try { process.stdout.write(`${routeBySourceShape(a.shape)}\n`); return 0; }
    catch (e) { process.stderr.write(`mesh-distill: ${e.message}\n`); return 1; }
  }

  if (a.mode === "distill") {
    if (!a.src) { process.stderr.write("--distill requires an <input.json>\n"); return 2; }
    let raw;
    try { raw = fs.readFileSync(a.src, "utf8"); } catch (e) { process.stderr.write(`error: cannot read ${a.src}: ${e.message}\n`); return 2; }
    let input;
    try { input = JSON.parse(raw); } catch (e) { process.stderr.write(`error: input is not valid JSON: ${e.message}\n`); return 2; }

    const opts = { clock: () => Date.now(), verified_id: a.verifiedId || input.verified_id };
    // content_bytes may arrive as a UTF-8 string or a file ref; when present,
    // load k_eco from env/keychain via the shared custody helper (never a file).
    if (input.content_bytes !== undefined) {
      try { opts.kEco = loadKey(a.keyEnv); }
      catch (e) {
        if (e instanceof MeshKeyError) { process.stderr.write(`mesh-distill: ${e.message}\n`); return 1; }
        throw e;
      }
      if (typeof input.content_bytes === "string") input.content_bytes = Buffer.from(input.content_bytes, "utf8");
    }
    let out;
    try { out = distill(input, opts); }
    catch (e) {
      if (e instanceof MeshDistillError) { process.stderr.write(`mesh-distill: ${e.message}\n`); return 1; }
      throw e;
    }
    const text = JSON.stringify(out, null, 2) + "\n";
    if (a.out) { fs.writeFileSync(a.out, text); process.stderr.write(`distill outputs written to ${a.out}\n`); }
    else process.stdout.write(text);
    return 0;
  }

  process.stderr.write(`${HELP}\n`);
  return 2;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) process.exit(main());

export { buildFabricManifest };
