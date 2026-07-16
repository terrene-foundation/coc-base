/**
 * operator-id — identity resolver for multi-operator COC (shard A1).
 *
 * Architecture refs (workspaces/multi-operator-coc/02-plans/01-architecture.md):
 *   §2.1 — `display_id` / `verified_id` / `person_id`; resolveIdentity(cwd)
 *          returns all three.
 *   §6.1 — un-rostered key runs at L2_SUPERVISED, blocked into
 *          /whoami --register.
 *
 * The 3 invariants this module holds:
 *   1. resolveIdentity(cwd) 3-tier resolution
 *        (a) signing-key fingerprint (verified_id) discovery — from explicit
 *            opts.signingKeyPath, `git -C <repo> config user.signingkey`,
 *            or null on absence;
 *        (b) roster lookup — load .claude/operators.roster.json, find the
 *            persons[] entry whose keys[] fingerprint matches;
 *        (c) identity tuple — { verified_id, person_id, display_id, role,
 *            host_role, posture, blocked_into? }.
 *   2. Un-rostered key  → posture: L2_SUPERVISED, blocked_into:
 *      "/whoami --register".
 *      No signing key   → posture: L2_SUPERVISED, blocked_into:
 *      "configure signing key, then run /whoami --register".
 *   3. Cache layer at .claude/operator-id is HINT-ONLY:
 *      - present + valid + verified_id matches current fingerprint → use it
 *      - absent / corrupt / mismatched verified_id → re-derive AND rewrite
 *      Cache tampering is harmless because every call re-validates against
 *      the live signing-key fingerprint.
 *
 * Style: CommonJS to match sibling .claude/hooks/lib/* modules. No external
 * deps. Spawns ssh-keygen / git as subprocesses (the OS tools are the
 * canonical implementation; see coc-sign.js's "Own the Stack" rationale).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { isCoordinationEnabled } = require("./coordination-mode.js");

const ROSTER_REL = path.join(".claude", "operators.roster.json");
const CACHE_REL = path.join(".claude", "operator-id");
const L2_SUPERVISED = "L2_SUPERVISED";
const UNROSTERED_BLOCKED_INTO = "/whoami --register";
const NO_KEY_BLOCKED_INTO =
  "configure signing key, then run /whoami --register";

// ---- test-only counter (resetable; used by integration test) ----------------
let _deriveCount = 0;

// ---- helpers ----------------------------------------------------------------

function _readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return { ok: false, reason: "absent" };
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return { ok: false, reason: `read failed: ${err.message}` };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, reason: `parse failed: ${err.message}` };
  }
}

/**
 * Resolve the SSH key fingerprint via `ssh-keygen -lf <pubkey>` (canonical
 * Tier-2 invocation). Returns the SHA256:base64 token or null on any failure.
 * Matches coc-sign.js's SSH-substrate convention; GPG path uses the supplied
 * key identifier directly (the gpg key id IS the verified_id).
 */
/**
 * #366: Parse the canonical 40-hex primary-key fingerprint out of
 * `gpg --list-keys --with-colons --fingerprint` output. The `fpr` record's
 * 10th colon-field (index 9) carries the fingerprint; the FIRST `fpr` after a
 * `pub` record is the primary key. Pure function (no spawn) so the parse is
 * unit-testable against a fixture without a live keyring. Returns the
 * uppercase 40-hex string or null when no valid primary `fpr` is present.
 */
function _parseGpgColonFingerprint(colonOutput) {
  if (!colonOutput || typeof colonOutput !== "string") return null;
  const lines = colonOutput.split("\n");
  // #366 security (redteam R1 MEDIUM): a COLLIDING short/long key-id can make
  // `gpg --list-keys <keyid>` emit MORE THAN ONE primary key (>1 `pub`/`sec`
  // record). Returning the first `fpr` would bind verified_id to an arbitrary
  // one of the colliding keys — a session-role-view escalation vector under
  // the bounded-trust model. Ambiguous keyring → return null → caller falls
  // back to the verbatim id → fails the 40-hex roster `===` → safe L2. We
  // never silently resolve a role from an ambiguous match.
  const primaryCount = lines.filter(
    (l) => l.startsWith("pub:") || l.startsWith("sec:"),
  ).length;
  // Require EXACTLY one primary key: `> 1` is the collision/ambiguity vector;
  // `=== 0` is a malformed / non-gpg stream with no owning `pub` record. Both
  // resolve to null → fallback → safe L2, and the single predicate removes any
  // need to reason about whether a 0-`pub` stream is gpg-authentic (redteam R2).
  if (primaryCount !== 1) return null;
  // Exactly one primary: the first valid `fpr` is the primary key's
  // fingerprint (gpg emits the primary `pub`+`fpr` before any subkey records).
  for (const line of lines) {
    if (line.startsWith("fpr:")) {
      const fpr = line.split(":")[9];
      if (fpr && /^[0-9A-Fa-f]{40}$/.test(fpr)) return fpr.toUpperCase();
    }
  }
  return null;
}

/**
 * #366: Normalize a GPG key identifier (short ID / long ID / 40-hex) to the
 * canonical 40-hex fingerprint via `gpg --list-keys --with-colons
 * --fingerprint <keyid>`. Returns null on any failure (gpg absent, key not in
 * keyring, ambiguous/empty output) so the caller falls back to the verbatim
 * identifier — preserving prior behavior with NO regression when gpg can't
 * resolve.
 */
function _gpgFingerprint(keyId) {
  if (!keyId || typeof keyId !== "string") return null;
  const r = spawnSync(
    "gpg",
    ["--list-keys", "--with-colons", "--fingerprint", keyId],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 2000 },
  );
  if (r.status !== 0) return null;
  return _parseGpgColonFingerprint(r.stdout.toString());
}

/**
 * Resolve the SSH key fingerprint via `ssh-keygen -lf <pubkey>` (canonical
 * Tier-2 invocation). Returns the SHA256:base64 token or null on any failure.
 * For GPG (#366): normalize the key identifier to the schema-canonical 40-hex
 * fingerprint so roster lookup (40-hex per operators.roster.schema.json) holds
 * regardless of whether git config stores a short/long key id. The `resolver`
 * (keyId → 40-hex | null) is injectable: `resolveIdentity` injects the
 * keyring-independent roster resolver (#371, `_makeRosterGpgResolver`); tests
 * inject deterministic stubs. It defaults to the legacy ambient-keyring
 * `_gpgFingerprint` (#366) only for the exported test seam / any direct caller
 * that passes no resolver.
 */
function _fingerprintFromKey(keyPath, keyType, resolver) {
  if (!keyPath || typeof keyPath !== "string") return null;
  if (keyType === "gpg") {
    // The git-config user.signingkey is commonly an 8/16-hex short/long key id,
    // but the roster schema mandates the 40-hex fingerprint. Normalize via the
    // injected resolver (roster suffix-match in production, #371); fall back to
    // the verbatim id only when the resolver cannot resolve — that verbatim id
    // then fails the strict-=== roster match → safe L2, with no regression.
    const resolve = typeof resolver === "function" ? resolver : _gpgFingerprint;
    return resolve(keyPath) || keyPath;
  }
  // SSH: derive fingerprint from the pubkey file. Accept either the
  // private-key path or the .pub path.
  const candidates = [];
  if (keyPath.endsWith(".pub")) {
    candidates.push(keyPath);
  } else {
    candidates.push(`${keyPath}.pub`, keyPath);
  }
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const r = spawnSync("ssh-keygen", ["-lf", candidate], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 2000,
    });
    if (r.status === 0) {
      const out = r.stdout.toString().trim();
      const parts = out.split(/\s+/);
      if (parts.length >= 2 && parts[1].startsWith("SHA256:")) {
        return parts[1];
      }
    }
  }
  return null;
}

/**
 * Discover the active signing key path. Order:
 *   1. Explicit opts.signingKeyPath (test-injected or caller-supplied).
 *   2. `git -C <repoDir> config user.signingkey` (unless opts.gitConfigSigningKey
 *      is explicitly null — test override to suppress ambient git config).
 * Returns { keyPath, keyType } or { keyPath: null }.
 */
function _discoverSigningKey(repoDir, opts) {
  // Explicit null in opts disables a tier (test determinism).
  if (Object.prototype.hasOwnProperty.call(opts, "signingKeyPath")) {
    if (opts.signingKeyPath === null) {
      // Caller explicitly disabled the explicit-path tier. Fall through to
      // git config unless that too is disabled.
    } else if (typeof opts.signingKeyPath === "string" && opts.signingKeyPath) {
      return { keyPath: opts.signingKeyPath, keyType: opts.keyType || "ssh" };
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(opts, "gitConfigSigningKey") &&
    opts.gitConfigSigningKey === null
  ) {
    return { keyPath: null };
  }
  // git -C <repoDir> config user.signingkey
  const r = spawnSync(
    "git",
    ["-C", repoDir, "config", "--get", "user.signingkey"],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 2000 },
  );
  if (r.status === 0) {
    const val = r.stdout.toString().trim();
    if (val) {
      // git's user.signingkey can be an SSH key path OR a GPG key id.
      // Heuristic: existence as a file → SSH; otherwise GPG.
      const exists = fs.existsSync(val) || fs.existsSync(`${val}.pub`);
      return { keyPath: val, keyType: exists ? "ssh" : "gpg" };
    }
  }
  return { keyPath: null };
}

/**
 * Search the roster for a persons[] entry whose keys[] include the given
 * fingerprint. Returns the person record + person_id, or null on miss.
 */
function _findPersonByFingerprint(roster, fingerprint) {
  if (!roster || typeof roster !== "object") return null;
  const persons = roster.persons || {};
  for (const personId of Object.keys(persons)) {
    const person = persons[personId];
    if (!person || !Array.isArray(person.keys)) continue;
    for (const key of person.keys) {
      if (key && key.fingerprint === fingerprint) {
        return { personId, person };
      }
    }
  }
  return null;
}

/**
 * #371: Collect every GPG signing-key fingerprint declared in the roster
 * (uppercase 40-hex; the schema enforces the case at load, #372). Deduped so a
 * benign duplicate entry does not read as an ambiguity. Pure — no spawn.
 */
function _rosterGpgFingerprints(roster) {
  const out = new Set();
  if (!roster || typeof roster !== "object") return [];
  const persons = roster.persons || {};
  for (const pid of Object.keys(persons)) {
    const keys = persons[pid] && persons[pid].keys;
    if (!Array.isArray(keys)) continue;
    for (const k of keys) {
      if (k && k.type === "gpg" && typeof k.fingerprint === "string") {
        out.add(k.fingerprint.toUpperCase());
      }
    }
  }
  return [...out];
}

/**
 * #371: Build a KEYRING-INDEPENDENT GPG key-id → 40-hex resolver bound to the
 * roster's own stored fingerprints. A git-config `user.signingkey` GPG id is a
 * SUFFIX of the 40-hex fingerprint (8-hex short id / 16-hex long id / 40-hex
 * full); the roster already stores every person's uppercase-40-hex `fingerprint`
 * (schema-enforced at load, #372), so normalization is a pure suffix-match
 * against that trusted set — NO ambient keyring, NO gpg spawn, NO homedir.
 *
 * This is ROBUSTNESS, not a security fix: `resolveIdentity` is view-only (record
 * authority is gated at SIGNING time by `coc-sign.js`'s expectedFpr/VALIDSIG
 * bind, F17). The win is that resolution no longer depends on whether the
 * operator's personal ambient keyring happens to hold the key, so a rostered
 * operator on a fresh machine no longer drops spuriously to L2, and the resolved
 * fingerprint is reproducible from the roster alone.
 *
 * This is the roster-FIRST component: `resolveIdentity` composes it with the
 * legacy ambient `_gpgFingerprint` (#366) as a FALLBACK (`rosterResolver(id) ||
 * _gpgFingerprint(id)`) for selectors this suffix-match structurally cannot
 * resolve — a signing-SUBKEY id or an email/name user-id — so those keep their
 * pre-#371 behavior (no regression).
 *
 * Ambiguity guard (mirrors the #366 exactly-one contract): a keyId that
 * suffix-matches MORE THAN ONE roster fingerprint, NONE, or is malformed
 * (non-hex, or outside the 8..40-hex modern-key-id range) returns null → the
 * caller's next step (the ambient fallback, then the verbatim id → strict
 * 40-hex roster `===` miss) resolves to safe L2. A NO-OP for a null/empty
 * roster (returns null every time).
 */
function _makeRosterGpgResolver(roster) {
  const fprs = _rosterGpgFingerprints(roster);
  return function rosterGpgResolver(keyId) {
    if (!keyId || typeof keyId !== "string") return null;
    // Normalize: drop a `0x` prefix + all whitespace, uppercase.
    const norm = keyId.replace(/\s+/g, "").replace(/^0x/i, "").toUpperCase();
    // Floor at the modern 8-hex short id (32-bit ids are deprecated; a shorter
    // id would broad-match); ceiling at the 40-hex fingerprint.
    if (!/^[0-9A-F]{8,40}$/.test(norm)) return null;
    const matches = fprs.filter((f) => f.endsWith(norm));
    // Exactly one resolves; zero or >1 (a suffix collision within the roster)
    // is ambiguous → null → verbatim fallback → safe L2 (the #366 shape).
    return matches.length === 1 ? matches[0] : null;
  };
}

/**
 * Write the cache file. Best-effort; cache write failures NEVER fail the
 * resolver (the cache is hint-only).
 */
function _writeCache(cachePath, identity) {
  try {
    // M9.1 R3 Sec-R3-S-05 — cache writeback reduced to `verified_id` only.
    // Per the M9.1 R1 Sec-ID-1 reframe, authority fields (person_id /
    // role / host_role / display_id) are ALWAYS re-derived from the live
    // roster on read; storing them in the cache is dead-data on disk and
    // a non-zero forensic surface (a reader could be misled into thinking
    // authority WAS cached). The cache's sole purpose is the ssh-keygen
    // trust-anchor short-circuit, which only needs `verified_id`.
    const payload =
      JSON.stringify({
        verified_id: identity.verified_id,
      }) + "\n";
    // MED-2 (M0 security review): cache contains the verified_id
    // (signing-key fingerprint) — sensitive identity material. Restrict
    // to the file owner only.
    fs.writeFileSync(cachePath, payload, { mode: 0o600 });
  } catch {
    // best-effort
  }
}

// M9.1 R4 Sec-R4-S-03 — `_readCache` was removed as dead code. The M9.1
// R1 Sec-ID-1 reframe removed the cache fast-path (roster is ALWAYS
// re-walked for authority); no caller invokes `_readCache` post-fix.
// Dead authentication-adjacent functions invite future caller wiring
// that re-introduces the cache-poisoning class M5 iter-6's
// `readCache identity-guard` (per `journal/0131`) was designed to close.
// If a future fingerprint-only short-circuit becomes necessary, it MUST
// be re-introduced with explicit forensic review and a fresh
// authority-binding contract — never as a silent re-wire of dead code.

/**
 * MO-OPT W1-d (workspaces/multi-operator-optional, journal/0330) — derive a
 * stable, valid display_id for SOLO mode (coordination OFF) from git user.name,
 * falling back to "solo". MUST satisfy codify-lease's _validateDisplayId
 * ([a-z0-9._-], 1..64 chars) so a solo /codify branch (codify/<display_id>-<date>)
 * is well-formed.
 */
function _soloDisplayId(repoDir) {
  let name = "";
  try {
    const r = spawnSync(
      "git",
      ["-C", repoDir, "config", "--get", "user.name"],
      { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", timeout: 2000 },
    );
    if (r.status === 0) name = (r.stdout || "").trim();
  } catch {
    // fall through to "solo"
  }
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "solo";
}

/**
 * MO-OPT W1-d — the synthetic SOLO identity returned in place of the forced
 * L2_SUPERVISED disposition when the coordination substrate is DISABLED. It
 * carries NO `posture` and NO `blocked_into`: omitting posture lets the gate
 * layer apply the existing fresh-repo L5 default (trust-posture.md MUST-2), and
 * omitting blocked_into removes the "/whoami --register" nag — together fixing
 * the ROOT disruption (an un-rostered / unsigned key forced to L2 on every
 * Edit/Write/commit, analysis row "root"). `verified_id` carries the discovered
 * fingerprint when one exists (un-rostered-but-signed), else null. The
 * `solo`/`source` markers make the disposition introspectable + testable.
 */
function _soloIdentity(repoDir, fingerprint) {
  return {
    verified_id: fingerprint || null,
    person_id: null,
    display_id: _soloDisplayId(repoDir),
    role: null,
    host_role: null,
    solo: true,
    source: "coordination-disabled",
  };
}

// ---- public API -------------------------------------------------------------

/**
 * Resolve the active operator's identity at `cwd`.
 *
 * Returns an identity object:
 *   { verified_id, person_id, display_id, role, host_role, posture?, blocked_into? }
 *
 * On the happy path (rostered key) posture is omitted (the caller / gate
 * layer applies repo_floor + per-operator posture — that's C1's job).
 * On the L2_SUPERVISED branches (un-rostered key, or no key configured)
 * posture: "L2_SUPERVISED" + blocked_into: <next action> are populated.
 *
 * @param {string} repoDir — repo root containing .claude/operators.roster.json
 * @param {object} [opts]
 *   - signingKeyPath {string|null}  explicit key path; null disables this tier
 *   - keyType {"ssh"|"gpg"}         default "ssh"
 *   - gitConfigSigningKey {null}    pass null to suppress ambient git config
 *
 * @returns {object}
 */
function resolveIdentity(repoDir, opts) {
  const o = opts || {};
  const cachePath = path.join(repoDir, CACHE_REL);
  const rosterPath = path.join(repoDir, ROSTER_REL);

  // ---- Tier 1: signing-key fingerprint discovery --------------------------
  const { keyPath, keyType } = _discoverSigningKey(repoDir, o);
  if (!keyPath) {
    // No signing key configured anywhere. MO-OPT W1-d: when coordination is
    // OFF this is NOT a degraded state — it is an un-enrolled solo repo;
    // return the synthetic solo identity (L5 via gate default) instead of the
    // forced L2 nag. When ON, L2_SUPERVISED + setup action (unchanged).
    if (!isCoordinationEnabled(repoDir)) return _soloIdentity(repoDir, null);
    return {
      verified_id: null,
      person_id: null,
      display_id: null,
      role: null,
      host_role: null,
      posture: L2_SUPERVISED,
      blocked_into: NO_KEY_BLOCKED_INTO,
    };
  }
  // ---- Roster read (moved ahead of fingerprint normalization, #371) -------
  // The roster is the TRUSTED fingerprint set used to normalize a git-config
  // GPG key-id keyring-independently (see _makeRosterGpgResolver). Read ONCE
  // here and reused for the authority lookup below. Absent/malformed roster =>
  // the resolver is a no-op (null) and the lookup misses => un-rostered by
  // definition => safe L2 / solo (no regression on that path).
  const rosterRead = _readJsonSafe(rosterPath);
  const roster = rosterRead.ok ? rosterRead.value : null;

  // ---- Tier 1 (cont.): key-id -> 40-hex fingerprint -----------------------
  // #371: for GPG, resolve the key-id roster-FIRST (a pure suffix-match against
  // the roster's stored fingerprints — keyring-independent, so a rostered
  // operator on a fresh machine resolves without a keyring), with the legacy
  // ambient _gpgFingerprint (#366) as FALLBACK. The fallback covers selectors
  // the roster suffix-match structurally CANNOT resolve — a signing-SUBKEY id
  // (roster stores the PRIMARY 40-hex, schema #372, and a subkey id is not its
  // suffix) or an email/name user-id — which inherently need the key material
  // to map to the primary fingerprint. The fallback exactly reproduces pre-#371
  // behavior for those, so there is NO regression; on a fresh/keyring-absent
  // machine it returns null -> verbatim -> safe L2, same as before. The common
  // primary-key case short-circuits on the roster and never spawns gpg. SSH is
  // unchanged (derives from the pubkey file; the resolver is ignored there).
  const rosterResolver = _makeRosterGpgResolver(roster);
  const gpgResolver = (keyId) =>
    rosterResolver(keyId) || _gpgFingerprint(keyId);
  const fingerprint = _fingerprintFromKey(keyPath, keyType, gpgResolver);
  if (!fingerprint) {
    // Key was nominally configured but we could not derive a fingerprint
    // (file missing, ssh-keygen failed). MO-OPT W1-d: OFF → solo (same as
    // no-key); ON → L2_SUPERVISED + setup action (unchanged).
    if (!isCoordinationEnabled(repoDir)) return _soloIdentity(repoDir, null);
    return {
      verified_id: null,
      person_id: null,
      display_id: null,
      role: null,
      host_role: null,
      posture: L2_SUPERVISED,
      blocked_into: NO_KEY_BLOCKED_INTO,
    };
  }

  // ---- Tier 2: roster lookup (authority; full re-derivation, ALWAYS) ------
  // M9.1 R1 Sec-ID-1 — authority (person_id / role / host_role) is ALWAYS
  // re-derived from the live roster (read above), NEVER trusted from the
  // cache. The roster IS the authoritative binding per architecture §2.1; a
  // cached person_id/role binding can be stale (key revoked-then-rotated,
  // roster --depart removed the binding) and MUST NOT be restored on the next
  // session. A roster that is absent OR malformed (roster === null above)
  // counts as "no rostered persons" — the key is un-rostered by definition,
  // surfacing L2_SUPERVISED so the operator runs --register.
  _deriveCount += 1;
  const match = roster ? _findPersonByFingerprint(roster, fingerprint) : null;

  let identity;
  if (match) {
    identity = {
      verified_id: fingerprint,
      person_id: match.personId,
      display_id: match.person.display_id || null,
      role: match.person.role || null,
      host_role: match.person.host_role || null,
    };
  } else if (!isCoordinationEnabled(repoDir)) {
    // MO-OPT W1-d — un-rostered key on a coordination-OFF repo is a solo
    // operator, NOT a supervised one. Return the synthetic solo identity
    // (carrying the discovered fingerprint as verified_id) so no /whoami
    // --register nag fires and the gate layer applies the fresh-repo L5
    // default. When ON, the forced-L2 disposition below is unchanged (S6).
    identity = _soloIdentity(repoDir, fingerprint);
  } else {
    identity = {
      verified_id: fingerprint,
      person_id: null,
      display_id: null,
      role: null,
      host_role: null,
      posture: L2_SUPERVISED,
      blocked_into: UNROSTERED_BLOCKED_INTO,
    };
  }

  // ---- Cache write-back (best-effort; failure does NOT fail the resolve) -
  _writeCache(cachePath, identity);

  return identity;
}

module.exports = {
  resolveIdentity,
  // Constants exposed for callers (e.g. whoami no-args command body that
  // reproduces the blocked_into text) and for downstream shards.
  L2_SUPERVISED,
  UNROSTERED_BLOCKED_INTO,
  NO_KEY_BLOCKED_INTO,
  // #366: GPG fingerprint normalization internals — exported for regression
  // tests (the parser is pure + deterministic; the resolver is injectable into
  // _fingerprintFromKey for keyring-free tests).
  _parseGpgColonFingerprint,
  _gpgFingerprint,
  _fingerprintFromKey,
  // #371: keyring-independent roster-bound GPG key-id → 40-hex resolver
  // (pure suffix-match over the roster's stored fingerprints; unit-testable
  // with no keyring). resolveIdentity injects this for the GPG path.
  _makeRosterGpgResolver,
  _rosterGpgFingerprints,
  // FSUB (2026-06-11): signing-key discovery shared with coc-emit.js —
  // the signed-record emitter needs the SAME explicit-path → git-config
  // discovery order resolveIdentity uses, so emission signs with the key
  // whose fingerprint IS the resolved verified_id (single SSOT; a
  // divergent discovery order could sign with a key that does not match
  // the stamped identity, and fold rule 1 would reject every record).
  _discoverSigningKey,
  // Test-only counters. NOT part of the supported API.
  _test_getDeriveCount: () => _deriveCount,
  _test_resetDeriveCount: () => {
    _deriveCount = 0;
  },
};
