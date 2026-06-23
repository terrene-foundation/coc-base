/**
 * coc-sign — cryptographic signing substrate for multi-operator COC.
 *
 * Shard A0a (workspaces/multi-operator-coc, design v11 §2.3).
 *
 * The 4 invariants this module holds:
 *   1. canonical-serialize record content deterministically (key order,
 *      no NaN / Infinity / undefined-value / BOM / non-printable control).
 *   2. sign via SSH key (default) OR GPG key.
 *   3. verify a signature against a caller-supplied public key.
 *   4. refuse to sign if no key configured — return explicit error object
 *      `{ok: false, error: "no signing key", reason: "<details>"}`,
 *      NEVER throw uncaught, NEVER silent-fallback to unsigned
 *      (rules/zero-tolerance.md Rule 3).
 *
 * Roster lookup / public-key resolution is NOT this module's job — that
 * lives in shard A1 (operator-id.js). This module is the cryptographic
 * primitive; callers pass the key material.
 *
 * Style: CommonJS to match sibling .claude/hooks/lib/* modules. No
 * external deps. Spawns ssh-keygen / gpg as subprocesses (the OS tools
 * are the canonical implementation; reimplementing the crypto in
 * JS would invent a parallel implementation per rules/dependencies.md
 * "Own the Stack").
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const SSH_NAMESPACE = "coc-multi-operator";

// ---- canonical-serialize ----------------------------------------------------

/**
 * Recursively validate that a value contains no unserializable / unsafe
 * content per invariant 1. Throws a typed Error on first violation so
 * the caller (which IS this module's sign() path) surfaces the cause.
 *
 * BOM (U+FEFF) and any control char (0x00-0x1F, 0x7F) other than \t \n \r
 * are rejected because they survive JSON.stringify but break grep, awk,
 * shell pipelines, and editor invariants — exactly the audit surface a
 * signed record must remain readable through.
 */
function _validateForCanonical(value, pathBreadcrumb) {
  if (value === undefined) {
    throw new Error(
      `canonicalSerialize: undefined value at '${pathBreadcrumb}' — undefined is not JSON-serializable`,
    );
  }
  if (value === null) return;
  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        `canonicalSerialize: non-finite number (NaN or Infinity) at '${pathBreadcrumb}'`,
      );
    }
    return;
  }
  if (t === "boolean") return;
  if (t === "string") {
    if (value.indexOf("﻿") !== -1) {
      throw new Error(
        `canonicalSerialize: BOM (U+FEFF) in string at '${pathBreadcrumb}' — non-printable`,
      );
    }
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      // Allow \t (0x09), \n (0x0A), \r (0x0D); reject every other control.
      if (
        (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
        code === 0x7f
      ) {
        throw new Error(
          `canonicalSerialize: non-printable control character U+${code
            .toString(16)
            .padStart(4, "0")
            .toUpperCase()} in string at '${pathBreadcrumb}'`,
        );
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      _validateForCanonical(value[i], `${pathBreadcrumb}[${i}]`);
    }
    return;
  }
  if (t === "object") {
    const keys = Object.keys(value);
    for (const k of keys) {
      _validateForCanonical(value[k], `${pathBreadcrumb}.${k}`);
    }
    return;
  }
  throw new Error(
    `canonicalSerialize: unsupported type '${t}' at '${pathBreadcrumb}'`,
  );
}

/**
 * Re-emit a JSON value with object keys sorted recursively. Arrays preserve
 * insertion order (semantic ordering is the caller's contract). Output is
 * a plain JS structure ready to feed JSON.stringify.
 */
function _withSortedKeys(value) {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(_withSortedKeys);
  if (typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = _withSortedKeys(value[k]);
    }
    return out;
  }
  return value;
}

/**
 * Canonical-serialize a value to UTF-8 bytes. Returns Buffer.
 *
 * Determinism contract: identical inputs MUST produce byte-identical output
 * regardless of key insertion order or process state. Same input on two
 * different machines / two different sessions → same bytes.
 *
 * Throws on NaN, Infinity, undefined values, BOM, non-printable control
 * characters, or unsupported types.
 *
 * @param {*} value
 * @returns {Buffer}
 */
function canonicalSerialize(value) {
  _validateForCanonical(value, "$");
  const sorted = _withSortedKeys(value);
  // JSON.stringify is deterministic on sorted-key objects + finite primitives.
  const text = JSON.stringify(sorted);
  return Buffer.from(text, "utf8");
}

// ---- sign / verify (SSH) ----------------------------------------------------

function _signSsh(content, keyPath) {
  // Require the private key to exist; otherwise invariant 4 fires.
  if (!keyPath || typeof keyPath !== "string") {
    return {
      ok: false,
      error: "no signing key",
      reason: "keyType:ssh requires non-empty opts.keyPath",
    };
  }
  if (!fs.existsSync(keyPath)) {
    return {
      ok: false,
      error: "no signing key",
      reason: `ssh key not found at ${keyPath}`,
    };
  }
  // ssh-keygen -Y sign reads the file to sign from stdin via -; writes
  // the armored signature to stdout when -O write-stdout is set, or to
  // <file>.sig otherwise. Use a temp file because ssh-keygen on macOS
  // does not accept stdin reliably across versions.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coc-sign-ssh-in-"));
  const inFile = path.join(tmpDir, "payload");
  // M9.1 R3 Sec-R3-S-06 — owner-only mode on temp files. Defense-in-depth
  // against same-uid co-tenant reading canonical bytes mid-sign.
  fs.writeFileSync(inFile, content, { mode: 0o600 });
  try {
    const r = spawnSync(
      "ssh-keygen",
      ["-Y", "sign", "-f", keyPath, "-n", SSH_NAMESPACE, inFile],
      { encoding: "utf8" },
    );
    if (r.status !== 0) {
      return {
        ok: false,
        error: "sign failed",
        // LOW-6 (M0 security review): cap stderr substring to bound the
        // returned error reason. Unbounded stderr can carry arbitrary
        // user-controlled key paths / hostnames into log lines.
        reason: `ssh-keygen exit ${r.status}: ${(r.stderr || "").trim().slice(0, 256)}`,
      };
    }
    const sigPath = `${inFile}.sig`;
    if (!fs.existsSync(sigPath)) {
      return {
        ok: false,
        error: "sign failed",
        reason: "ssh-keygen did not produce a signature file",
      };
    }
    const sig = fs.readFileSync(sigPath, "utf8");
    return { ok: true, sig };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
}

function _verifySsh(content, sig, pubKey) {
  // ssh-keygen -Y verify requires an allowed-signers file mapping a
  // principal → pubkey. We synthesize one with a placeholder principal,
  // then verify the signature was produced by THAT principal. If verify
  // exits non-zero the signature did not validate against the pubkey.
  const principal = "coc@signer";
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coc-sign-ssh-vfy-"));
  const inFile = path.join(tmpDir, "payload");
  const sigFile = path.join(tmpDir, "payload.sig");
  const allowedSigners = path.join(tmpDir, "allowed_signers");
  // M9.1 R3 Sec-R3-S-06 — owner-only mode on temp files. Defense-in-depth.
  fs.writeFileSync(inFile, content, { mode: 0o600 });
  fs.writeFileSync(sigFile, sig, { mode: 0o600 });
  // Format: "<principal> <pubkey-blob>"
  fs.writeFileSync(allowedSigners, `${principal} ${pubKey.trim()}\n`, {
    mode: 0o600,
  });
  try {
    const r = spawnSync(
      "ssh-keygen",
      [
        "-Y",
        "verify",
        "-f",
        allowedSigners,
        "-I",
        principal,
        "-n",
        SSH_NAMESPACE,
        "-s",
        sigFile,
      ],
      { input: content, encoding: "utf8" },
    );
    if (r.status === 0) return { ok: true, valid: true };
    // status non-zero = signature did not verify. This is a normal result,
    // not a tool error; ok:true, valid:false (the verify call succeeded
    // in answering the question).
    return {
      ok: true,
      valid: false,
      reason: `ssh-keygen verify exit ${r.status}: ${(r.stderr || "").trim().slice(0, 256)}`,
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
}

// ---- sign / verify (GPG) ----------------------------------------------------

function _signGpg(content, keyId, gpgHome) {
  if (!keyId || typeof keyId !== "string") {
    return {
      ok: false,
      error: "no signing key",
      reason:
        "keyType:gpg requires opts.keyPath set to a gpg key identifier (email/fingerprint)",
    };
  }
  const args = [
    "--armor",
    "--detach-sign",
    "--local-user",
    keyId,
    "--batch",
    "--yes",
  ];
  if (gpgHome) args.unshift("--homedir", gpgHome);
  const r = spawnSync("gpg", args, { input: content, encoding: "buffer" });
  if (r.status !== 0) {
    return {
      ok: false,
      error: "sign failed",
      reason: `gpg exit ${r.status}: ${(r.stderr || Buffer.alloc(0)).toString().trim().slice(0, 256)}`,
    };
  }
  return { ok: true, sig: r.stdout.toString("utf8") };
}

/**
 * Verify a GPG-signed content against an armored pubkey.
 *
 * GPG-agent cleanup contract (MED-3, M0 security review):
 *   When `opts.gpgHome` is OMITTED, this function creates an ephemeral
 *   homedir AND runs `gpgconf --homedir <h> --kill all` + rmSync on the
 *   homedir at exit — full lifecycle owned by the library.
 *   When `opts.gpgHome` IS PROVIDED, the caller is asserting ownership
 *   of the homedir's lifecycle. The library does NOT spawn `gpgconf
 *   --kill` or rmSync on the caller-provided path. Callers MUST run
 *   `gpgconf --homedir <gpgHome> --kill all` after the verify call to
 *   release the gpg-agent process the verify spawned implicitly; not
 *   doing so leaks one gpg-agent per call.
 *
 * Expected-fingerprint binding (F17 — load-bearing for a SHARED homedir):
 *   In the per-call path the keyring holds exactly ONE key (the imported
 *   pubKeyArmored), so `gpg --verify` structurally accepts only a signature
 *   made by THAT key. A shared homedir (F17) holds EVERY roster key, so a
 *   bare `gpg --verify` would accept a signature made by ANY rostered key —
 *   letting operator B forge a record attributed to operator A (the §1
 *   bounded-trust impersonation adversary). When `expectedFpr` is supplied,
 *   this function parses `--status-fd` and requires the GnuPG `VALIDSIG`
 *   line to name `expectedFpr`, re-instating the single-key binding even in
 *   a multi-key keyring. Absent `expectedFpr`, behavior is unchanged
 *   (back-compat for callers relying on the single-key keyring).
 */
function _verifyGpg(content, sig, pubKeyArmored, gpgHome, expectedFpr) {
  // Build a transient keyring containing the supplied pubkey, then verify.
  const home =
    gpgHome || fs.mkdtempSync(path.join(os.tmpdir(), "coc-sign-gpg-vfy-"));
  const ownsHome = !gpgHome;
  try {
    if (ownsHome) {
      const r1 = spawnSync("gpg", ["--homedir", home, "--import", "--batch"], {
        input: pubKeyArmored,
        encoding: "utf8",
      });
      if (r1.status !== 0) {
        return {
          ok: false,
          error: "verify failed",
          reason: `gpg --import exit ${r1.status}: ${(r1.stderr || "").trim().slice(0, 256)}`,
        };
      }
    }
    const sigFile = path.join(home, "coc-sig.asc");
    // M9.1 R3 Sec-R3-S-06 — owner-only mode on temp files.
    fs.writeFileSync(sigFile, sig, { mode: 0o600 });
    // --status-fd 1 → machine-readable GNUPG status (incl. VALIDSIG <fpr>)
    // on stdout; human messages stay on stderr. Used for the expectedFpr bind.
    const r = spawnSync(
      "gpg",
      [
        "--homedir",
        home,
        "--batch",
        "--status-fd",
        "1",
        "--verify",
        sigFile,
        "-",
      ],
      { input: content, encoding: "utf8" },
    );
    if (r.status !== 0) {
      return {
        ok: true,
        valid: false,
        reason: `gpg --verify exit ${r.status}: ${(r.stderr || "").trim().slice(0, 256)}`,
      };
    }
    // Identity binding: when the caller names the expected signer key, the
    // signature MUST have been made by THAT key — not merely by SOME key in
    // the (possibly shared, multi-key) keyring. Fail-closed: a missing or
    // mismatched VALIDSIG fingerprint is NOT valid.
    if (expectedFpr) {
      const want = String(expectedFpr).toUpperCase().replace(/\s+/g, "");
      const validsig = String(r.stdout || "")
        .split("\n")
        .find((l) => /\bVALIDSIG\b/.test(l));
      if (!validsig) {
        return {
          ok: true,
          valid: false,
          reason: `gpg --verify exited 0 but emitted no VALIDSIG status; cannot bind signer to expected key ${want.slice(0, 16)}`,
        };
      }
      const present = validsig.toUpperCase().replace(/\s+/g, "").includes(want);
      if (!present) {
        return {
          ok: true,
          valid: false,
          reason: `signature verified against a DIFFERENT key than expected (${want.slice(0, 16)}…); VALIDSIG: ${validsig.trim().slice(0, 120)}`,
        };
      }
    }
    return { ok: true, valid: true };
  } finally {
    if (ownsHome) {
      try {
        execFileSync("gpgconf", ["--homedir", home, "--kill", "all"], {
          stdio: "ignore",
        });
      } catch {
        // gpgconf may be absent; rmSync still proceeds
      }
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {
        // best-effort temp cleanup
      }
    }
  }
}

/**
 * Create ONE shared GPG homedir for a batch of verifies (F17 — read-time
 * fold latency). Imports every supplied armored pubkey once and spawns a
 * single gpg-agent (the first import brings it up); the returned `home` is
 * then passed as `opts.gpgHome` to every `verify({keyType:"gpg"})` call in
 * the batch, so the per-record ephemeral-homedir + agent-spawn cost
 * (journal/0311 Issue B) is paid ONCE per fold instead of once per record.
 *
 * Caller owns the lifecycle per the `_verifyGpg` contract (gpgHome provided
 * ⇒ the lib neither imports nor tears down): the caller MUST call
 * `destroyVerifyHomedir(home)` when the batch completes (a `finally`).
 *
 * Fail-to-slow-path: returns `{ok:false, reason}` (NEVER throws) when gpg is
 * absent or any import fails — and tears down the partial homedir itself, so
 * a false return leaks nothing. The caller's correct disposition on `ok:false`
 * is to OMIT `gpgHome` and let each verify fall back to its own ephemeral
 * homedir (today's behavior — correct, just slow). This is fail-OPEN to the
 * existing-correct slow path, NOT fail-closed-to-broken.
 *
 * @param {string[]} pubKeys - distinct armored GPG public-key blocks. Only
 *   GPG keys belong here; SSH verifies use no homedir.
 * @returns {{ok:true, home:string} | {ok:false, reason:string}}
 */
function createVerifyHomedir(pubKeys) {
  if (!Array.isArray(pubKeys) || pubKeys.length === 0) {
    return { ok: false, reason: "no gpg pubkeys to pre-import" };
  }
  let home;
  try {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "coc-sign-gpg-fold-"));
  } catch (err) {
    return {
      ok: false,
      reason: `mkdtemp failed: ${err && err.message ? err.message : String(err)}`,
    };
  }
  for (const pub of pubKeys) {
    if (typeof pub !== "string" || !pub) {
      destroyVerifyHomedir(home);
      return {
        ok: false,
        reason: "pubKeys contained a non-string / empty entry",
      };
    }
    const r = spawnSync("gpg", ["--homedir", home, "--import", "--batch"], {
      input: pub,
      encoding: "utf8",
    });
    if (r.error || r.status !== 0) {
      // gpg absent (ENOENT) or an import failed — tear down and signal the
      // caller to fall back to the per-call ephemeral path.
      destroyVerifyHomedir(home);
      return {
        ok: false,
        reason: r.error
          ? `gpg unavailable: ${r.error.message}`
          : `gpg --import exit ${r.status}: ${(r.stderr || "").trim().slice(0, 256)}`,
      };
    }
  }
  return { ok: true, home };
}

/**
 * Tear down a shared verify homedir created by `createVerifyHomedir`:
 * kill the gpg-agent the imports/verifies spawned, then remove the homedir.
 * Best-effort + idempotent — safe to call on a null/undefined home (no-op)
 * and on an already-removed path. Mirrors the owned-home `finally` block in
 * `_verifyGpg`.
 *
 * @param {string} home - the homedir returned by createVerifyHomedir.
 */
function destroyVerifyHomedir(home) {
  if (!home || typeof home !== "string") return;
  try {
    execFileSync("gpgconf", ["--homedir", home, "--kill", "all"], {
      stdio: "ignore",
    });
  } catch {
    // gpgconf may be absent; rmSync still proceeds.
  }
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    // best-effort temp cleanup
  }
}

// ---- public API -------------------------------------------------------------

/**
 * Sign content with an SSH (default) or GPG key.
 *
 * @param {Buffer|string} content - bytes to sign (caller already canonical-serialized)
 * @param {Object} opts
 * @param {"ssh"|"gpg"} [opts.keyType="ssh"]
 * @param {string} opts.keyPath - SSH: filesystem path to private key.
 *                                GPG: key identifier (email/fingerprint/uid).
 * @param {string} [opts.gpgHome] - optional GPG homedir override
 * @returns {{ok: true, sig: string} | {ok: false, error: string, reason: string}}
 *
 * Invariant 4: no key configured → explicit error object. NEVER throws
 * to the caller. NEVER silent-fallback to an unsigned result.
 */
function sign(content, opts) {
  const o = opts || {};
  const keyType = o.keyType || "ssh";
  if (keyType !== "ssh" && keyType !== "gpg") {
    return {
      ok: false,
      error: "no signing key",
      reason: `unsupported keyType '${keyType}' (allowed: ssh, gpg)`,
    };
  }
  const buf = Buffer.isBuffer(content)
    ? content
    : Buffer.from(String(content), "utf8");
  try {
    if (keyType === "ssh") return _signSsh(buf, o.keyPath);
    return _signGpg(buf, o.keyPath, o.gpgHome);
  } catch (err) {
    // Defense-in-depth: any unexpected error becomes an explicit
    // error object, never an unhandled throw — invariant 4.
    return {
      ok: false,
      error: "sign failed",
      reason: `unexpected error: ${err && err.message ? err.message : String(err)}`,
    };
  }
}

/**
 * Verify a signature against caller-supplied public-key material.
 *
 * @param {Buffer|string} content - the original bytes that were signed
 * @param {string} sig - signature (SSH armored or GPG armored)
 * @param {string} pubKey - SSH: single-line "ssh-ed25519 AAA... [comment]".
 *                          GPG: armored ASCII public key block.
 * @param {Object} [opts]
 * @param {"ssh"|"gpg"} [opts.keyType="ssh"]
 * @param {string} [opts.gpgHome] - optional pre-loaded GPG homedir
 * @param {string} [opts.expectedFpr] - GPG only: when set, the signature MUST
 *   verify against THIS key fingerprint (VALIDSIG bind). Required when gpgHome
 *   is a shared multi-key keyring; ignored on the SSH path.
 * @returns {{ok: true, valid: boolean, reason?: string} | {ok: false, error: string, reason: string}}
 *
 * Caller is responsible for binding pubKey → operator identity. That
 * binding lives in shard A1 (operator-id.js).
 */
function verify(content, sig, pubKey, opts) {
  const o = opts || {};
  const keyType = o.keyType || "ssh";
  if (keyType !== "ssh" && keyType !== "gpg") {
    return {
      ok: false,
      error: "verify failed",
      reason: `unsupported keyType '${keyType}' (allowed: ssh, gpg)`,
    };
  }
  if (!sig || typeof sig !== "string") {
    return {
      ok: false,
      error: "verify failed",
      reason: "sig must be a non-empty string",
    };
  }
  if (!pubKey || typeof pubKey !== "string") {
    return {
      ok: false,
      error: "verify failed",
      reason: "pubKey must be a non-empty string",
    };
  }
  const buf = Buffer.isBuffer(content)
    ? content
    : Buffer.from(String(content), "utf8");
  try {
    if (keyType === "ssh") return _verifySsh(buf, sig, pubKey);
    return _verifyGpg(buf, sig, pubKey, o.gpgHome, o.expectedFpr);
  } catch (err) {
    return {
      ok: false,
      error: "verify failed",
      reason: `unexpected error: ${err && err.message ? err.message : String(err)}`,
    };
  }
}

module.exports = {
  canonicalSerialize,
  sign,
  verify,
  // Shared verify-homedir lifecycle (F17) — create ONE homedir per fold,
  // pass its `home` as opts.gpgHome to every verify, destroy once after.
  createVerifyHomedir,
  destroyVerifyHomedir,
  // Exposed for downstream shards that need to share the SSH namespace
  // when constructing allowed-signers files or audit records.
  SSH_NAMESPACE,
};
