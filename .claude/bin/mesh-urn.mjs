#!/usr/bin/env node
/*
 * ============================================================================
 *  Knowledge-Mesh Opaque-Handle URN Minter/Validator + LOCAL HANDLE VAULT
 *  — Wave-1 Shard 1b (loom knowledge-mesh identity registry)
 * ============================================================================
 *
 *  AUTHORITATIVE CONTRACT (this tool IMPLEMENTS it, never restates the
 *  derivation — `.claude/rules/specs-authority.md` Rule 9):
 *    workspaces/knowledge-mesh-2026-07-10/specs/02-knowledge-product-identity.md
 *      § "The URN"                            (the `<version>` numeric grammar)
 *      § "`<domain>` is an OPAQUE HANDLE"     clauses (a)/(b)/(c)/(e)
 *      § "KEY + VAULT CUSTODY"                clause (e) — key custody
 *    workspaces/knowledge-mesh-2026-07-10/specs/04-plane-split.md
 *      § "EXCLUDED FROM THE INPUT SET BY CONSTRUCTION" (the vault)
 *
 *  WHAT THIS TOOL DOES
 *    1. MINT an opaque `<domain>` handle for a readable name, per clause (a):
 *       EITHER (i) a random ≥128-bit id (16 CSPRNG bytes → 32 hex, UNTRUNCATED)
 *       OR     (ii) HMAC(k, name) under a ≥128-bit CSPRNG key k, output
 *                    UNTRUNCATED (64 hex). An unkeyed / truncated hash is
 *                    BLOCKED — it is dictionary-invertible by any URN holder.
 *    2. ASSEMBLE + VALIDATE the full `kp://<owning_level>/<domain>/<name>@<version>`
 *       URN — ecosystem-relative (no ecosystem/tenant slug in ANY segment),
 *       opaque `<domain>`, numeric `<version>`, enum `<owning_level>`.
 *    3. MANAGE the LOCAL HANDLE VAULT — the readable client↔handle MAP. The
 *       vault is a LOCAL control-plane store that NEVER cascades, is NEVER
 *       pulled UP, and (map) is GITIGNORED / NEVER committed. Keys (k) live in
 *       env/keychain via lib/mesh-keys.mjs — the vault FILE holds the MAP ONLY,
 *       NEVER a key.
 *
 *  THE VAULT IS NOT THE REGISTRY (clause (c)). The vault is the client↔handle
 *  DEANONYMIZATION table; the registry is the UP-pulled product catalog. This
 *  tool writes the vault OUTSIDE any registry pull path and refuses to write a
 *  key into it. See § "self-audit" in the Wave-1 report for the leak-path walk.
 *
 *  Usage:
 *    mesh-urn --mint --name <readable> --level <use|build|platform> --version <n>
 *             [--mode random|hmac] [--key-env MESH_HANDLE_VAULT_KEY] [--root DIR]
 *    mesh-urn --validate <kp://…>            exit 1 if the URN is not conforming
 *    mesh-urn --mint-key                     print a fresh ≥128-bit key (for env)
 *    mesh-urn --resolve <handle> [--root DIR]  LOCAL vault lookup (legibility)
 *    mesh-urn --help
 *
 *  Exit: 0 ok · 1 validation failure / hard violation · 2 usage error.
 * ============================================================================
 */

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isOpaqueHandle, ENUMS, VERSION_GRAMMAR } from "./mesh-registry-scrub.mjs";
import { loadKey, mintKey, mintKeyHex, MeshKeyError, findCommittedKeyFiles } from "./lib/mesh-keys.mjs";

const OWNING_LEVELS = ENUMS.owning_level; // {platform, build, use} — single source.

// Full kp:// URN grammar: kp://<owning_level>/<domain>/<name>@<version>
const KP_URN = /^kp:\/\/([^/]+)\/([^/]+)\/([^@/]+)@([^/]+)$/;

// A readable <name> is a PRODUCT name; a client-qualified one is BLOCKED
// (clause (b) — a POLICY gate). Structurally we accept a bounded product-name
// charset and reject any token the local ecosystem denylist marks as a
// client/tenant slug (ecosystem-relativity, invariant 1/2).
const NAME_GRAMMAR = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i;

export class MeshUrnError extends Error {
  constructor(message) {
    super(message);
    this.name = "MeshUrnError";
  }
}

// ── Minting the opaque <domain> handle (clause (a)) ──────────────────────────
/**
 * Mint an opaque, NON-DERIVABLE `<domain>` handle for a readable name.
 * @param {string} readableName  the client/engagement/domain readable meaning
 * @param {object} [opts]
 * @param {"random"|"hmac"} [opts.mode="random"]
 * @param {Buffer} [opts.key]  REQUIRED for mode "hmac" — a ≥128-bit CSPRNG key
 * @returns {string} the opaque handle (32 hex for random, 64 hex for hmac)
 */
export function mintHandle(readableName, opts = {}) {
  const mode = opts.mode || "random";
  if (typeof readableName !== "string" || readableName.length === 0) {
    throw new MeshUrnError("mintHandle: a readable name is required");
  }
  if (mode === "random") {
    // 16 CSPRNG bytes = 128 bits, UNTRUNCATED (clause (a)(i)).
    return crypto.randomBytes(16).toString("hex");
  }
  if (mode === "hmac") {
    if (!Buffer.isBuffer(opts.key)) {
      throw new MeshUrnError(
        "mintHandle(mode=hmac): a ≥128-bit CSPRNG key Buffer is required (clause (a)(ii)); " +
          "load it via lib/mesh-keys.mjs::loadKey, NEVER hardcode it",
      );
    }
    // HMAC-SHA256(k, name) = 64 hex, UNTRUNCATED (clause (a)(ii) — truncation
    // shrinks the digest, not the attacker's candidate list, AND collides).
    return crypto.createHmac("sha256", opts.key).update(readableName, "utf8").digest("hex");
  }
  throw new MeshUrnError(`mintHandle: unknown mode '${mode}' (expected random|hmac)`);
}

// ── URN validation (all four segments, ecosystem-relativity) ─────────────────
/**
 * Validate a full kp:// URN. Fail-closed: returns {ok:false, errors:[…]} rather
 * than throwing, so a --check caller can render every finding.
 * @param {string} urn
 * @param {object} [opts]
 * @param {string[]} [opts.denyTokens=[]]  ecosystem/tenant slugs that MUST NOT
 *   appear in ANY segment (ecosystem-relativity guard, invariant 1/2).
 * @returns {{ok:boolean, errors:string[], parts?:object}}
 */
export function validateUrn(urn, opts = {}) {
  const denyTokens = (opts.denyTokens || []).map((t) => String(t).toLowerCase()).filter(Boolean);
  const errors = [];
  if (typeof urn !== "string") return { ok: false, errors: ["URN is not a string"] };
  const m = KP_URN.exec(urn);
  if (!m) {
    return { ok: false, errors: ["not a kp://<owning_level>/<domain>/<name>@<version> URN"] };
  }
  const [, owningLevel, domain, name, version] = m;

  if (!OWNING_LEVELS.has(owningLevel)) {
    errors.push(`<owning_level> '${owningLevel}' outside {${[...OWNING_LEVELS].join(", ")}}`);
  }
  // <domain> MUST be an opaque, non-derivable handle (clause (a)).
  if (!isOpaqueHandle(domain)) {
    errors.push("<domain> is not an opaque ≥128-bit handle (a readable name / truncated / unkeyed digest is BLOCKED — clause (a))");
  }
  // <name> is a product name; reject a client-qualified one via the denylist +
  // a bounded grammar (clause (b) policy gate).
  if (!NAME_GRAMMAR.test(name)) {
    errors.push(`<name> '${name}' is not a bounded product name`);
  }
  if (!VERSION_GRAMMAR.test(version)) {
    errors.push(`<version> '${version}' does not match ^[0-9]+(\\.[0-9]+)*$ (clause "The URN")`);
  }
  // Ecosystem-relativity (invariant 1/2): NO ecosystem/tenant slug in ANY segment.
  const whole = urn.toLowerCase();
  for (const tok of denyTokens) {
    if (whole.includes(tok)) {
      errors.push(`ecosystem/tenant slug present in the URN — ecosystem-relativity violation (URN MUST NOT embed the ecosystem/tenant slug)`);
      break;
    }
  }
  return { ok: errors.length === 0, errors, parts: { owningLevel, domain, name, version } };
}

/**
 * Assemble + validate a full URN from parts.
 * @returns {string} the URN (throws MeshUrnError on any invalid part)
 */
export function mintUrn({ owning_level, domain_handle, name, version }, opts = {}) {
  const urn = `kp://${owning_level}/${domain_handle}/${name}@${version}`;
  const r = validateUrn(urn, opts);
  if (!r.ok) throw new MeshUrnError(`assembled URN is invalid: ${r.errors.join("; ")}`);
  return urn;
}

// ── LOCAL HANDLE VAULT (the client↔handle MAP — clause (c)/(e)) ───────────────
const VAULT_SCHEMA = "mesh-handle-vault/1";

/** The canonical LOCAL vault path — deliberately OUTSIDE any registry pull path. */
export function defaultVaultPath(root) {
  return path.join(root, ".claude", "mesh", "handle-vault.json");
}

/** The mesh dir — where the committed-key tripwire (clause e.2) scans. */
export function meshDirPath(root) {
  return path.dirname(defaultVaultPath(root));
}

/**
 * Clause-e.2 committed-key tripwire, wired for a caller. Returns 0 (clean) or 1
 * (committed key material found / read error). SIDE-EFFECT: writes the finding
 * to stderr. This is the production caller `findCommittedKeyFiles` lacked
 * (redteam #965 R1 F3 — the detector existed but nothing invoked it).
 */
export function checkNoCommittedKeys(root) {
  let committed;
  try {
    committed = findCommittedKeyFiles(meshDirPath(root));
  } catch (e) {
    if (e instanceof MeshKeyError) { process.stderr.write(`mesh-urn: ${e.message}\n`); return 1; }
    throw e;
  }
  if (committed.length) {
    const names = committed.map((p) => path.basename(p)).join(", ");
    process.stderr.write(
      `mesh-urn: committed key-material file(s) under ${meshDirPath(root)}: ${names}. ` +
        `Keys MUST live in env/keychain, NEVER a file (clause e.2) — remove the file(s) and rotate the key.\n`,
    );
    return 1;
  }
  return 0;
}

/**
 * The registry pull pointer's path — the UP pull `git fetch`es THIS. The vault
 * MUST live OUTSIDE it (clause (c)); assertVaultOutsidePullPath enforces that.
 */
export function registryPullPath(root) {
  return path.join(root, ".claude", "mesh", "registry");
}

/**
 * Assert the vault path is NOT under the registry pull path (clause (c) — a
 * vault committed beside the registry is fetched UP into loom-command). Throws.
 */
export function assertVaultOutsidePullPath(vaultPath, root) {
  const pull = registryPullPath(root);
  const rel = path.relative(pull, vaultPath);
  const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (inside) {
    throw new MeshUrnError(
      `vault path ${vaultPath} is UNDER the registry pull path ${pull} — the vault would be ` +
        `git-fetched UP into loom-command as the deanonymization table (clause (c)). Move it out.`,
    );
  }
}

/** A key value NEVER belongs in the vault file (clause (e) — the map, not the key). */
const VAULT_KEY_TAINT = new Set(["k", "k_eco", "key", "keys", "secret"]);

function loadVault(vaultPath) {
  if (!fs.existsSync(vaultPath)) return { schema: VAULT_SCHEMA, entries: {} };
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(vaultPath, "utf8"));
  } catch (e) {
    throw new MeshUrnError(`vault at ${vaultPath} is not valid JSON: ${e.message}`);
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new MeshUrnError(`vault at ${vaultPath} is not a vault object`);
  }
  // Fail-closed: a key smuggled into the vault file is a HARD violation.
  for (const k of Object.keys(obj)) {
    if (VAULT_KEY_TAINT.has(k.toLowerCase())) {
      throw new MeshUrnError(`vault at ${vaultPath} carries a KEY field '${k}' — keys live in env/keychain ONLY (clause e.2), never the vault file`);
    }
  }
  const entries = obj.entries && typeof obj.entries === "object" && !Array.isArray(obj.entries) ? obj.entries : {};
  return { schema: VAULT_SCHEMA, entries };
}

/**
 * Store a handle↔name mapping in the LOCAL vault. Refuses to write a key, and
 * refuses a vault path inside the registry pull path.
 * @param {string} root
 * @param {string} handle  the opaque handle (validated opaque)
 * @param {string} readableName
 * @param {object} [opts] {vaultPath}
 */
export function vaultPut(root, handle, readableName, opts = {}) {
  const vaultPath = opts.vaultPath || defaultVaultPath(root);
  assertVaultOutsidePullPath(vaultPath, root);
  if (!isOpaqueHandle(handle)) {
    throw new MeshUrnError(`vaultPut: refusing to store a non-opaque handle '${handle}'`);
  }
  if (VAULT_KEY_TAINT.has(String(readableName).toLowerCase())) {
    throw new MeshUrnError("vaultPut: refusing to store a key-shaped value as a vault entry (clause e.2)");
  }
  const vault = loadVault(vaultPath);
  vault.entries[handle] = readableName;
  fs.mkdirSync(path.dirname(vaultPath), { recursive: true });
  fs.writeFileSync(vaultPath, JSON.stringify(vault, null, 2) + "\n");
  return vaultPath;
}

/** LOCAL vault resolution (legibility affordance ONLY — never an enforcement input, clause (d)). */
export function vaultResolve(root, handle, opts = {}) {
  const vaultPath = opts.vaultPath || defaultVaultPath(root);
  const vault = loadVault(vaultPath);
  return Object.hasOwn(vault.entries, handle) ? vault.entries[handle] : null;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { mode: null, name: null, level: null, version: null, mint: "random", keyEnv: "MESH_HANDLE_VAULT_KEY", root: null, urn: null, handle: null };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--mint") a.mode = "mint";
    else if (t === "--validate") { a.mode = "validate"; a.urn = argv[++i]; }
    else if (t === "--resolve") { a.mode = "resolve"; a.handle = argv[++i]; }
    else if (t === "--mint-key") a.mode = "mint-key";
    else if (t === "--check-keys") a.mode = "check-keys";
    else if (t === "--name") a.name = argv[++i];
    else if (t === "--level") a.level = argv[++i];
    else if (t === "--version") a.version = argv[++i];
    else if (t === "--mode") a.mint = argv[++i];
    else if (t === "--key-env") a.keyEnv = argv[++i];
    else if (t === "--root") a.root = argv[++i];
    else if (t === "--help" || t === "-h") a.mode = "help";
    else return { error: `unknown argument: ${t}` };
  }
  return a;
}

const HELP = `mesh-urn — opaque-handle kp:// URN minter/validator + local handle vault (Wave-1 1b)

  mesh-urn --mint --name <readable> --level <use|build|platform> --version <n>
           [--mode random|hmac] [--key-env MESH_HANDLE_VAULT_KEY] [--root DIR]
  mesh-urn --validate <kp://…>       exit 1 if not conforming
  mesh-urn --mint-key                print a fresh ≥128-bit key (paste into env)
  mesh-urn --resolve <handle>        LOCAL vault lookup (legibility only)
  mesh-urn --check-keys [--root DIR] fail (exit 1) if a key file is committed under the mesh dir (clause e.2)
  mesh-urn --help

Contract: workspaces/knowledge-mesh-2026-07-10/specs/02-knowledge-product-identity.md
§ "\`<domain>\` is an OPAQUE HANDLE". The vault MAP never cascades / is never pulled
UP / is never committed; keys live in env/keychain, NEVER a file.`;

function resolveRoot(a) {
  return a.root ? path.resolve(a.root) : process.cwd();
}

function main() {
  const a = parseArgs(process.argv);
  if (a.error) { process.stderr.write(`${a.error}\n\n${HELP}\n`); return 2; }
  if (!a.mode || a.mode === "help") { process.stdout.write(`${HELP}\n`); return a.mode ? 0 : 2; }

  if (a.mode === "mint-key") {
    process.stdout.write(`${mintKeyHex()}\n`);
    return 0;
  }

  if (a.mode === "check-keys") {
    // Clause-e.2 committed-key tripwire, now a real CLI caller (redteam #965 R1 F3).
    const rc = checkNoCommittedKeys(resolveRoot(a));
    if (rc === 0) process.stdout.write(`mesh-urn: no committed key material under ${meshDirPath(resolveRoot(a))} (clause e.2 clean)\n`);
    return rc;
  }

  if (a.mode === "validate") {
    // DENYLIST-AGNOSTIC BY DESIGN (redteam #965 R1 ambiguity-(c), RATIFIED): the
    // CLI passes NO denyTokens, so ecosystem-relativity here is STRUCTURAL only
    // (no tenant segment, opaque <domain>, numeric <version>, bounded <name>).
    // The tenant/client denylist is a caller-supplied seam (opts.denyTokens) — it
    // stays with the ecosystem-side disclosure fence (scan-synced-disclosure.mjs),
    // NEVER co-located with this ecosystem-AGNOSTIC mesh tool. Do NOT "fix" the
    // empty denyTokens as a bug; the agnostic mesh must not carry a client list.
    const r = validateUrn(a.urn);
    if (r.ok) { process.stdout.write("mesh-urn: URN conforms (opaque domain, numeric version, enum level)\n"); return 0; }
    process.stderr.write(`mesh-urn: URN INVALID\n  - ${r.errors.join("\n  - ")}\n`);
    return 1;
  }

  if (a.mode === "resolve") {
    const name = vaultResolve(resolveRoot(a), a.handle);
    if (name === null) { process.stderr.write("mesh-urn: handle not in the local vault\n"); return 1; }
    process.stdout.write(`${name}\n`);
    return 0;
  }

  if (a.mode === "mint") {
    if (!a.name || !a.level || !a.version) {
      process.stderr.write("mesh-urn --mint requires --name, --level, and --version\n");
      return 2;
    }
    let handle;
    try {
      if (a.mint === "hmac") {
        const key = loadKey(a.keyEnv);
        handle = mintHandle(a.name, { mode: "hmac", key });
      } else {
        handle = mintHandle(a.name, { mode: "random" });
      }
    } catch (e) {
      if (e instanceof MeshKeyError || e instanceof MeshUrnError) {
        process.stderr.write(`mesh-urn: ${e.message}\n`);
        return 1;
      }
      throw e;
    }
    let urn;
    try {
      urn = mintUrn({ owning_level: a.level, domain_handle: handle, name: a.name, version: a.version });
    } catch (e) {
      process.stderr.write(`mesh-urn: ${e.message}\n`);
      return 1;
    }
    // Committed-key tripwire (clause e.2) — fail closed BEFORE writing the vault
    // if any key-material file was committed under the mesh dir (redteam #965 R1 F3).
    if (checkNoCommittedKeys(resolveRoot(a)) !== 0) return 1;
    const vaultPath = vaultPut(resolveRoot(a), handle, a.name);
    process.stdout.write(`${urn}\n`);
    process.stderr.write(`(handle↔name stored in the LOCAL vault: ${vaultPath} — never cascades, never pulled UP, gitignored)\n`);
    return 0;
  }

  process.stderr.write(`${HELP}\n`);
  return 2;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) process.exit(main());

export {
  mintKey,
  KP_URN,
  NAME_GRAMMAR,
  VAULT_SCHEMA,
  loadVault,
};
