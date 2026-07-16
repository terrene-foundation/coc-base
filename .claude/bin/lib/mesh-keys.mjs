/**
 * mesh-keys.mjs — SHARED key-custody helper for the knowledge-mesh identity
 * registry (Wave-1 Shard 1b `k` + Shard 1c `k_eco`).
 *
 * AUTHORITATIVE CONTRACT (this lib IMPLEMENTS it, never restates the derivation —
 * `.claude/rules/specs-authority.md` Rule 9):
 *   workspaces/knowledge-mesh-2026-07-10/specs/02-knowledge-product-identity.md
 *     § "KEY + VAULT CUSTODY" clause (e) — sub-clauses (e.1) generation,
 *       (e.2) storage NEVER committed, (e.3) mint-time-only ⇒ rotatable.
 *   .claude/rules/security.md § "No Hardcoded Secrets".
 *
 * WHY ONE SHARED LIB (security.md § "Pre-Encoder Consolidation" ethos): `k`
 * (the handle-HMAC key, clause (a)(ii)) and `k_eco` (the content-commitment key,
 * clause (f)) carry the IDENTICAL custody contract (e.1–e.3). Splitting the
 * contract across two modules guarantees one half drifts — so both keys source
 * through THIS module. It mints, loads, and validates key material; it NEVER
 * writes a key to disk and NEVER reads one from a committed file.
 *
 * THE CUSTODY INVARIANT (clause e.2 — THE most important mesh invariant):
 *   keys MUST be ≥128-bit CSPRNG, sourced from an ENV VAR / OS KEYCHAIN /
 *   secret manager, and NEVER from a committed file. A committed key is
 *   permanently extractable from git history and inherited by every clone.
 *   This module FAILS CLOSED with a typed MeshKeyError on any deviation
 *   (no stub, no silent fallback — zero-tolerance.md Rules 2/3).
 */

import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";

// `require` bridge for the lazily-loaded, platform-only surfaces below
// (keychain shell-out + sync readdir) — kept off the hot path.
const require = createRequire(import.meta.url);

// ── Floors (clause e.1 + clause (a)) ─────────────────────────────────────────
export const KEY_MIN_BYTES = 16; // 128 bits — the clause (a)/(e.1) floor.
export const KEY_MINT_BYTES = 32; // 256 bits — the mint default (≥ the floor).

/** Typed error so a custody failure names the floor + the received condition. */
export class MeshKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = "MeshKeyError";
  }
}

// ── (e.1) Generation — CSPRNG, ≥128-bit ──────────────────────────────────────
/**
 * Mint a fresh key as a Buffer of CSPRNG bytes. Default 256-bit (≥ the 128-bit
 * floor). The caller stores the RETURNED hex in an env var / keychain — this
 * function NEVER persists it (clause e.2).
 * @param {number} [bytes=KEY_MINT_BYTES]
 * @returns {Buffer}
 */
export function mintKey(bytes = KEY_MINT_BYTES) {
  if (!Number.isInteger(bytes) || bytes < KEY_MIN_BYTES) {
    throw new MeshKeyError(
      `mintKey: requested ${bytes} bytes but the floor is ${KEY_MIN_BYTES} bytes (128 bits) — clause (e.1)`,
    );
  }
  return crypto.randomBytes(bytes);
}

/** Mint a fresh key rendered as hex, ready to paste into an env var / keychain. */
export function mintKeyHex(bytes = KEY_MINT_BYTES) {
  return mintKey(bytes).toString("hex");
}

// ── Parse + validate raw key MATERIAL (rejects a path / a short key) ──────────
// Accepted renderings: HEX (≥32 hex chars, even length) OR base64url
// (`[A-Za-z0-9_-]`, decoding to ≥16 bytes). Standard base64 (`+`/`/`) and any
// value carrying a path separator are REJECTED — this is what makes "the value
// is a file path" fail closed (clause e.2): a path contains `/`, `\`, `.` or a
// leading `~`, none of which are in the hex or base64url charsets.
const HEX_KEY = /^[0-9a-fA-F]+$/;
const B64URL_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * @param {string} value  the raw env/keychain value
 * @param {string} label  the env-var / source name (for the error message)
 * @returns {Buffer}
 */
export function parseKeyMaterial(value, label = "<key>") {
  if (typeof value !== "string" || value.length === 0) {
    throw new MeshKeyError(`${label}: key material is empty — expected a ≥128-bit hex or base64url string`);
  }
  // Path-shaped value ⇒ a committed-file source attempt. Reject explicitly so the
  // failure NAMES the custody rule rather than producing a confusing decode error.
  if (/[/\\]/.test(value) || value.startsWith(".") || value.startsWith("~")) {
    throw new MeshKeyError(
      `${label}: key material looks like a FILE PATH — the key MUST be the key VALUE ` +
        `(≥128-bit hex/base64url) from an env var / keychain, NEVER a path to a committed file (clause e.2)`,
    );
  }
  let buf;
  if (HEX_KEY.test(value)) {
    if (value.length % 2 !== 0) throw new MeshKeyError(`${label}: hex key has an odd length`);
    buf = Buffer.from(value, "hex");
  } else if (B64URL_KEY.test(value)) {
    buf = Buffer.from(value, "base64url");
  } else {
    throw new MeshKeyError(
      `${label}: key material is not valid hex or base64url — expected a ≥128-bit key VALUE from an env var / keychain, not a file path or free-form text (clause e.2)`,
    );
  }
  // NOTE: the charset check above CANNOT reject a base64url-charset passphrase
  // (`[A-Za-z0-9_-]`); the ≥128-bit floor below is the only mechanical guard, and
  // it bounds LENGTH, not ENTROPY. Key STRENGTH (high-entropy CSPRNG material per
  // clause e.1) is the caller's responsibility — mint via `mintKeyHex`, never type
  // a passphrase. This is unverifiable from provided material and is NOT claimed here.
  if (buf.length < KEY_MIN_BYTES) {
    throw new MeshKeyError(
      `${label}: key is ${buf.length * 8} bits — below the 128-bit floor (clause (a)/(e.1)); ` +
        `a low-entropy key reproduces the offline dictionary attack the floor exists to block`,
    );
  }
  return buf;
}

// ── (e.2) Storage — load ONLY from env / keychain, NEVER a committed file ─────
/**
 * Load a key by name. Resolution order: env var → OS keychain (via the injected
 * lookup, or the platform default). A missing key FAILS CLOSED — there is no
 * "generate a default" fallback, because a silent default would be a committed
 * or predictable key (clause e.2 / zero-tolerance Rule 3).
 *
 * @param {string} envVar               the env-var name (e.g. "MESH_HANDLE_VAULT_KEY")
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env=process.env]
 * @param {string} [opts.keychainService]  keychain service name to try if env is unset
 * @param {(service:string)=>(string|null)} [opts.keychainLookup]  INJECTED (test seam)
 * @returns {Buffer}
 */
export function loadKey(envVar, opts = {}) {
  const env = opts.env || process.env;
  const raw = env[envVar];
  if (typeof raw === "string" && raw.length > 0) {
    return parseKeyMaterial(raw, `env:${envVar}`);
  }
  // Env unset → try the keychain (injected lookup in tests, platform default otherwise).
  if (opts.keychainService) {
    const lookup = opts.keychainLookup || defaultKeychainLookup;
    const fromChain = lookup(opts.keychainService);
    if (typeof fromChain === "string" && fromChain.length > 0) {
      return parseKeyMaterial(fromChain, `keychain:${opts.keychainService}`);
    }
  }
  throw new MeshKeyError(
    `${envVar}: no key found in env var or keychain. Mint one with mintKeyHex() and export it as ` +
      `${envVar} (or store it in the OS keychain). NEVER commit it to a file (clause e.2).`,
  );
}

/**
 * Platform keychain read. Best-effort, fail-CLOSED to null (never throws so the
 * caller's typed "not found" error is what surfaces). Not exercised in tests
 * (tests inject `keychainLookup`); shells out only when a service name is given.
 */
export function defaultKeychainLookup(service) {
  try {
    const { execFileSync } = require("node:child_process");
    if (process.platform === "darwin") {
      return execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null;
    }
    return execFileSync("secret-tool", ["lookup", "service", service], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null; // not found / no keychain tool → typed "not found" surfaces at the caller
  }
}

// ── Committed-key-file tripwire (clause e.2 — the adversarial "commit a key") ─
// The mesh vault dir holds ONLY the handle↔name MAP (never a key). If a key
// FILE materializes there, a key has been committed — fail closed.
// Exported so the commit-time PREVENTION fence (`.gitignore` + manifest gitignore_additions)
// can be pinned against this detection set — `mesh-vault-fences.test.mjs` asserts every
// basename/suffix here is gitignored under `.claude/mesh/`, so adding one here without the
// gitignore mirror fails the parity test (redteam #965 R2 F-KEY, Enforcement-Surface Parity).
export const FORBIDDEN_KEY_BASENAMES = new Set(["k", "k_eco", "keys", "keys.json", "vault-key", "mesh.key"]);
export const FORBIDDEN_KEY_SUFFIXES = [".key", ".pem", ".secret"];

/**
 * Assert no committed key-material file exists ANYWHERE under the mesh vault dir
 * (RECURSIVE — a key at .claude/mesh/sub/k.key must be found too). Returns the
 * list of offending paths (empty = clean); a caller in --check mode fails closed
 * when it is non-empty. This is the clause-e.2 committed-key tripwire — wired
 * into `mesh-urn --mint` (pre-write guard) and `mesh-urn --check-keys`.
 * @param {string} meshDir  absolute path to the mesh dir (e.g. <root>/.claude/mesh)
 * @param {(dir:string)=>string[]} [readdir]  INJECTED reader (test seam) → relative entry paths
 * @returns {string[]}
 * @throws {MeshKeyError} on any read error OTHER than ENOENT (fail-CLOSED — an
 *   unreadable mesh dir is "status UNKNOWN", never a silent "clean").
 */
export function findCommittedKeyFiles(meshDir, readdir) {
  const list = readdir || defaultReaddir;
  let entries;
  try {
    entries = list(meshDir);
  } catch (e) {
    // ENOENT (dir absent) → nothing committed there. Any OTHER error (EACCES /
    // EIO) means we COULD NOT VERIFY — fail-CLOSED by surfacing, never a silent
    // "clean" (redteam #965 R1 F2: the bare catch failed OPEN on a security check).
    if (e && e.code === "ENOENT") return [];
    throw new MeshKeyError(
      `findCommittedKeyFiles: cannot read ${meshDir}: ${e.message} — committed-key status UNKNOWN (fail-closed, clause e.2)`,
    );
  }
  const hits = [];
  for (const entry of entries) {
    const base = path.basename(entry).toLowerCase();
    if (FORBIDDEN_KEY_BASENAMES.has(base) || FORBIDDEN_KEY_SUFFIXES.some((s) => base.endsWith(s))) {
      hits.push(path.join(meshDir, entry));
    }
  }
  return hits;
}

function defaultReaddir(dir) {
  const { readdirSync } = require("node:fs");
  // RECURSIVE (redteam #965 R1 F2 — a flat readdir missed nested key material).
  // readdirSync(recursive:true) returns entry paths relative to `dir`; an absent
  // dir throws ENOENT, which findCommittedKeyFiles maps to [] (the fail-safe).
  return readdirSync(dir, { recursive: true });
}
