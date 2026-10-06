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
 * external deps. Signing, and GPG verification, spawn ssh-keygen / gpg as
 * subprocesses (the OS tools are the canonical implementation; reimplementing
 * the crypto in JS would invent a parallel implementation per
 * rules/dependencies.md "Own the Stack").
 *
 * SSH VERIFICATION IS THE ONE NARROWED CASE, and the sentence above is
 * narrowed rather than left standing because the code no longer matches it as
 * written. `_verifySsh` first attempts an in-process check. That is NOT a
 * parallel crypto implementation: the ed25519 primitive is `crypto.verify`,
 * i.e. the same OpenSSL ssh-keygen links. What is implemented in JS is the
 * SSHSIG ENVELOPE (PROTOCOL.sshsig) — armor, wire framing, key-binding and
 * namespace-binding — and it short-circuits ONLY on a positive verdict it
 * fully understands; everything else falls back to the subprocess. The reason
 * the exception is taken here and nowhere else is that verification, unlike
 * signing, runs once PER RECORD on every read-time fold: measured 2026-08-21,
 * 17-21s to fold loom's own 919-record log. See § SSHSIG envelope parsing.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
// loom#1891: in-process OpenPGP detached verify. Envelope parsing only — the
// RSA primitive is OpenSSL via crypto.verify (GnuPG's own primitive is
// libgcrypt; these are different implementations of the same standard, not
// the same library). See that module's safety model for why a bug in it costs
// a spawn rather than a wrong verdict.
const openpgpVerify = require(path.join(__dirname, "openpgp-verify.js"));
// #867: stamp each ephemeral GPG/SSH homedir with a pid-liveness ownership
// marker so the background reaper (coord-background.js::reapStaleGpgHomedirs)
// spares a LIVE fold's homedir mid-use instead of reaping by a time window.
// coord-background requires only node builtins → no require cycle.
// teardownGpgHomedir + writeEphemeralAgentConf live in coord-background.js (the
// module that also OWNS the leaked-homedir reaper) so there is exactly ONE
// bounded teardown path in the ecosystem — a second copy here would drift from
// the reaper's, which is how three independent unbounded call sites arose.
const {
  writeFoldPidFile,
  writeEphemeralAgentConf,
  teardownGpgHomedir,
} = require("./coord-background.js");

const SSH_NAMESPACE = "coc-multi-operator";

/**
 * THE CEILING ON EVERY SIGNING/VERIFYING SUBPROCESS THIS MODULE SPAWNS.
 *
 * `coord-background.js::teardownGpgHomedir` already bounds its `gpgconf --kill`
 * for exactly this reason and records the cause: "an unbounded one hangs here
 * forever and the rmSync never executes." Every `gpg` and `ssh-keygen` spawn in
 * THIS file was unbounded, which is the same defect one layer up — a `gpg` that
 * blocks (a wedged agent, a pinentry that cannot reach a tty, an NFS-stalled
 * homedir) hangs the READ GATE itself, and a gate that never returns is
 * indistinguishable from a gate that was switched off.
 *
 * A timeout is FAIL-CLOSED here, not fail-open, and that is what makes it safe
 * to add: on expiry `spawnSync` returns `{error: ETIMEDOUT, status: null}`, and
 * every call site below reads a present `r.error` as INDETERMINATE — verification
 * did not RUN — which every consumer refuses. No value of this constant can turn
 * a rejection into an acceptance.
 *
 * Deliberately NOT env-overridable. `COC_SIGN_INPROC_VERIFY` is one-directional
 * (its only effect is to make verification slower), but a settable timeout is not:
 * a very small value would convert every verify into an INDETERMINATE refusal,
 * which is a denial-of-service knob on the gate. 15 s is ~1800x the measured
 * 8.33 ms `gpg --version` floor, so it can only ever fire on a genuine hang.
 */
const SPAWN_TIMEOUT_MS = 15000;

/** Bounded-spawn options, merged into every gpg/ssh-keygen spawnSync below. */
const SPAWN_BOUND = Object.freeze({
  timeout: SPAWN_TIMEOUT_MS,
  killSignal: "SIGKILL",
});

/**
 * Did a spawn fail to produce a VERDICT at all?
 *
 * `spawnSync` reports a binary that could not be executed (ENOENT), a kill from
 * the timeout above (ETIMEDOUT), and a fork failure (EAGAIN) identically: `error`
 * set, `status` null. NONE of those is a statement about the signature — and the
 * pre-existing code read all of them as `status !== 0`, i.e. as "the signature is
 * bad". That is the misdiagnosis this predicate exists to prevent.
 *
 * ── EPIPE IS NOT ONE OF THOSE, AND CONFLATING IT COST A REAL VERDICT ────────
 *
 * Every case above leaves `status` NULL — that is what makes them "no verdict".
 * EPIPE does not. It means the child RAN, decided, and EXITED BEFORE CONSUMING
 * ALL OF STDIN; the unfinished parent-side write is what raises it. The child's
 * verdict is sitting right there in `status` / `stdout` / `stderr`, and the
 * blanket `r.error ||` above threw it away and reported an outage instead.
 *
 * MEASURED, and the reason this is a correctness bug rather than CI weather —
 * it is SIZE-DEPENDENT, flipping at the pipe buffer:
 *
 *     stdin      status   error    stderr
 *     64 B         2      none     "gpg: invalid armor header: ..."
 *     64 KB        2      none     "gpg: invalid armor header: ..."
 *     1 MB         2      EPIPE    "gpg: invalid armor header: ..."   <- same verdict, discarded
 *
 * So the SAME bad signature reports as a record fact on a small payload and as
 * a gpg outage on a large one. That sends the operator to repair a healthy gpg
 * when the truth is "this record did not verify" — the verifier-fault-versus-
 * record-fault misclassification this file has now fixed at six other sites.
 *
 * ── WHY A SUCCESS VERDICT IS STILL REFUSED UNDER EPIPE ─────────────────────
 *
 * The asymmetry is deliberate and is the security-bearing half. Under EPIPE the
 * child provably did NOT read all the input, so:
 *
 *   status !== 0  the child rejected what it DID read. Rejecting a prefix of the
 *                 data is still a rejection — fail-closed, and now informative.
 *   status === 0  a PASS over data the verifier never finished reading. That is
 *                 indistinguishable from "the first N bytes were fine", which is
 *                 exactly the fail-OPEN shape a signature check must never take.
 *                 It stays "no verdict", and the caller reports INDETERMINATE.
 *
 * @param {object} r a `spawnSync` result
 * @returns {boolean} true when NO verdict can be attributed to the child
 */
/**
 * @param {object} r a `spawnSync` result
 * @param {object} [opts]
 * @param {boolean} [opts.admitEpipeVerdict=false] may an EPIPE with a FAILING status be
 *   read as the child's verdict? **Defaults to NO, and the default is the safe one.**
 *
 * WHY THIS IS OPT-IN PER CALL SITE, which an earlier revision got wrong by making it
 * global. EPIPE has TWO causes that produce an IDENTICAL observable:
 *
 *   (a) the child read enough to DECIDE and rejected — a verdict exists;
 *   (b) the child failed at argument/config parse time and NEVER BEGAN READING stdin —
 *       no verdict about the subject exists at all.
 *
 * (b) is if anything MORE likely to raise EPIPE, because it exits earliest. Only a
 * caller with a MACHINE-READABLE status channel can tell them apart, and exactly one
 * site here has one: the gpg `--verify` site, via `_gpgNonZeroIsRecordVerdict`, which
 * reads `--status-fd` for BADSIG/NODATA and degrades to INDETERMINATE when the keyword
 * is absent — including when EPIPE truncated the stream.
 *
 * Admitting the verdict globally converted (b) into a definite "this record did not
 * verify" at the ssh verify site, whose `allowed_signers` file is built from
 * caller-supplied `pubkey` material — so a malformed pubkey became a targeted
 * false-forgery accusation against an innocent signer, size-gated on the payload. It
 * also flipped the `gpg --import` site from INDETERMINATE to a hard `verify failed`,
 * which downstream renders as the forgery-class refusal, even though an import failure
 * happens before any signature is examined. Both are the verifier-fault-versus-
 * record-fault misclassification this file exists to prevent, re-created by the fix
 * for it. Found by adversarial review; the fix is to let the sites that CAN
 * discriminate opt in, and leave the rest fail-closed.
 */
function _spawnDidNotRun(r, opts) {
  if (!r) return true;
  if (r.status === null || r.status === undefined) return true;
  if (r.error) {
    const admit = !!(opts && opts.admitEpipeVerdict);
    // A child that exited with a FAILING status after refusing further stdin gave a
    // verdict — but ONLY the caller knows whether it can read that verdict. A success
    // on a partial read is never a verdict at any site.
    return !(admit && r.error.code === "EPIPE" && r.status !== 0);
  }
  return false;
}

/**
 * The ONE rendering of WHY a spawn produced no verdict.
 *
 * Five call sites built this string by hand from `r.error.code`, which reads
 * correctly for ENOENT/ETIMEDOUT/EAGAIN and MISLEADINGLY for the one case
 * `_spawnDidNotRun` now admits is different: an EPIPE that reached here did so
 * with a SUCCESS status, meaning the child ran and passed data it never finished
 * reading. Rendering that as "did not run: EPIPE" tells the operator to repair a
 * process that worked. One function so the two cannot drift, per
 * `security.md` § Multi-Site Kwarg Plumbing.
 */
function _noVerdictReason(r) {
  // `r.status === 0` IS REQUIRED, and its absence was a factually false operator
  // message. `_spawnDidNotRun` short-circuits on a null status BEFORE it looks at
  // EPIPE, so an EPIPE whose status is null — a child killed by a signal while the
  // parent was mid-write — also reaches here. Review reproduced it with a real
  // subprocess (`kill -TERM $$` under an 8 MiB stdin): status null, signal SIGTERM,
  // error EPIPE, and this function announced "EPIPE with a SUCCESS status". There was
  // no success and there was no status, and the reader was sent to investigate a
  // partial-read pass when the truth was a killed child. Not reachable via the
  // SPAWN_BOUND timeout (that yields ETIMEDOUT), so it needs an external signal —
  // narrow, real, and it renders the wrong sentence with total confidence.
  if (r && r.error && r.error.code === "EPIPE" && r.status === 0) {
    return (
      "EPIPE with a SUCCESS status — the child exited before reading all of stdin, " +
      "so its pass covers only the prefix it consumed and is NOT a verdict over the " +
      "whole input. Treated as INDETERMINATE rather than accepted (fail-closed)"
    );
  }
  return (
    (r && r.error && r.error.code) ||
    (r && r.error && r.error.message) ||
    "no exit status"
  );
}

/**
 * THE ONE normalization of an expected fingerprint, and the reason it is one
 * function rather than an expression repeated at each use.
 *
 * A floor added upstream in `signed-log.js` measured `key.fingerprint.trim()` —
 * leading/trailing whitespace only — while the bind below compares
 * `.replace(/\s+/g, "")`, which strips INTERIOR whitespace too. Measured, the two
 * disagree by an unbounded amount:
 *
 *   "1  2  3  4  5  6"  →  trim()          length 16  → clears a 16-char floor
 *                       →  strip-all-ws    length  6  → what the bind compares
 *
 * So a padded roster entry passed the floor and arrived at the bind as SIX
 * characters, with every surface still reporting the floor as enforced. That is
 * nastier than an ordinary off-by-one because OpenPGP fingerprints are
 * CONVENTIONALLY WRITTEN WITH SPACES (`ABCD 1234 …`), so a shortened-and-padded
 * entry looks entirely normal to a human reviewer.
 *
 * Two values that must agree can only be guaranteed to agree by being ONE value.
 * Every producer and consumer of an expected fingerprint in this file now routes
 * through here.
 */
function _normalizeExpectedFpr(value) {
  // DELEGATED, not re-implemented. This was the third of FOUR copies of one rule
  // (here, `_canaryKey`, the subprocess bind, and `openpgp-verify.js`), and they
  // agreed for every live input — which is the condition under which the next
  // copy is the one that drifts, not a reason to keep them. The canonical
  // implementation lives in `openpgp-verify.js`, which this module already
  // requires; the reverse direction would be a cycle.
  return openpgpVerify.normalizeFpr(value);
}

/**
 * The shortest NORMALIZED expected fingerprint the identity bind will accept.
 *
 * Enforced HERE rather than at a caller because the bind lives here and five
 * independent call sites feed it (`signed-log.js`, `coordination-log.js`,
 * `fold-verification-checkpoint.js`, `presence-proof-verify.js`,
 * `state-file-write-guard.js`), of which only one carried a floor of its own.
 * `security.md` § Multi-Site Kwarg Plumbing: a control promoted at one call site
 * and not the shared callee ships the exact failure mode it exists to fix, at
 * every site that did not learn it. 16 is gpg's own short-key-id width; every
 * credential this ecosystem issues (40-hex OpenPGP, `SHA256:`-prefixed ssh
 * digests) clears it by a wide margin, so it cannot fire on an honest roster.
 */
const MIN_EXPECTED_FPR_CHARS = 16;

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
    if (value.indexOf("\uFEFF") !== -1) {
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
      // INJECTIVITY (s50 security review). `JSON.parse` creates `__proto__` as
      // an OWN data property, so it survives `Object.keys` — but `out[k] = …`
      // with k === "__proto__" invokes the INHERITED `Object.prototype`
      // setter instead of defining an own property. The key then vanishes from
      // the output: measured, `canonicalSerialize({a:1})` and
      // `canonicalSerialize(JSON.parse('{"a":1,"__proto__":"x"}'))` both
      // produce `{"a":1}`, byte-identical, while a control key (`zz`) changes
      // the bytes. Canonicalization was therefore NOT injective, which means a
      // signed record could carry an arbitrary `__proto__`-keyed subtree at any
      // nesting depth WITHOUT invalidating its signature — and any digest built
      // on these bytes inherits the same blindness.
      //
      // Rejected LOUDLY rather than silently defined, matching this module's
      // existing contract for NaN / BOM / control characters: a `__proto__` key
      // in a coordination record has no legitimate producer (measured: 0
      // occurrences across the 919-record live log and the roster, against 919
      // for a control key), so refusing to represent it is strictly safer than
      // choosing a representation for it.
      if (k === "__proto__") {
        throw new Error(
          "canonicalSerialize: '__proto__' key is not representable — " +
            "assigning it invokes the Object.prototype setter and silently " +
            "drops the key, making canonicalization non-injective",
        );
      }
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

// ---- SSHSIG envelope parsing (in-process verify fast path) ------------------
//
// WHY THIS EXISTS. `_verifySsh` below spawns `ssh-keygen -Y verify` ONCE PER
// RECORD, and every read-time fold verifies every record. Measured on loom's
// own 919-record coordination log (2026-08-21, load avg ~8-14): foldLog cost
// 17-21s, ~18ms per record, of which ~80% is the spawn itself and ~20% is the
// mkdtemp + 3 writes + rm -r around it. That is the whole of the multi-second
// stall on every Edit/Write of an integrity-critical path, and it is also what
// makes integrity-guard.js's documented AUTH_BUDGET_MS arm unreachable: a
// synchronous fold cannot be preempted by a timer.
//
// WHAT THIS IS AND IS NOT. The module header used to state that reimplementing
// the crypto in JS would invent a parallel implementation. That reasoning is
// KEPT and this code does not violate it: the ed25519 primitive is NOT
// reimplemented — `crypto.verify` is OpenSSL, the same library `ssh-keygen`
// links. What is implemented here is the SSHSIG ENVELOPE (PROTOCOL.sshsig):
// base64 armor, SSH wire framing, and the two bindings that give the signature
// its meaning (which PUBLIC KEY signed it, and under which NAMESPACE). Parsing
// a documented container format is not inventing a cryptographic primitive.
//
// FAIL DIRECTION, WHICH IS THE LOAD-BEARING PART. This path may only ever
// return a VALID verdict on a signature it fully understands. Every deviation —
// a version other than 1, a key type other than ssh-ed25519, a hash algorithm
// outside {sha256, sha512}, a trailing byte, a length that does not add up —
// returns `null` meaning UNSUPPORTED, and the caller falls back to
// `ssh-keygen`. An INVALID verdict also falls back, so a bug in this parser
// that wrongly REJECTS costs a subprocess and cannot deny an honest write. The
// only residual is a bug that wrongly ACCEPTS, which is why strictness here is
// free and is taken everywhere, and why the differential pins in
// tests/integration/multi-operator/sshsig-inproc-verify.test.js assert
// agreement with ssh-keygen on BOTH poles rather than on the accept pole alone.

const crypto = require("crypto");

const SSHSIG_MAGIC = Buffer.from("SSHSIG", "utf8");
// SPKI DER prefix for an Ed25519 subjectPublicKeyInfo (RFC 8410 §4). The 32
// raw key bytes are appended verbatim. Node cannot parse an OpenSSH public-key
// blob directly, so the raw point is re-framed into the one encoding
// `crypto.createPublicKey` accepts.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Read one SSH wire `string` (uint32 big-endian length, then that many bytes).
 * Returns null on any framing error rather than throwing, so a malformed blob
 * degrades to UNSUPPORTED (fallback) instead of to an exception.
 */
function _sshReadString(buf, offset) {
  if (offset + 4 > buf.length) return null;
  const len = buf.readUInt32BE(offset);
  // Bound the claimed length against the buffer BEFORE slicing: a forged
  // length field must not be able to produce a short read that silently
  // compares equal to a short expected value.
  if (len > buf.length - offset - 4) return null;
  return {
    value: buf.subarray(offset + 4, offset + 4 + len),
    next: offset + 4 + len,
  };
}

/** Encode a Buffer as an SSH wire `string`. */
function _sshWriteString(b) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length, 0);
  return Buffer.concat([len, b]);
}

/**
 * Extract the base64 key blob from an OpenSSH public-key line
 * (`ssh-ed25519 AAAAC3... optional-comment`). Returns a Buffer or null.
 */
function _parseOpenSshPubKeyBlob(pubKey) {
  if (typeof pubKey !== "string") return null;
  const parts = pubKey.trim().split(/\s+/);
  if (parts.length < 2) return null;
  if (parts[0] !== "ssh-ed25519") return null;
  let blob;
  try {
    blob = Buffer.from(parts[1], "base64");
  } catch {
    return null;
  }
  if (!blob || blob.length === 0) return null;
  // Re-encoding must round-trip: Buffer.from(..., "base64") silently DISCARDS
  // characters outside the alphabet, so a corrupt field would otherwise decode
  // to a short-but-plausible blob instead of being rejected.
  if (
    blob.toString("base64").replace(/=+$/, "") !== parts[1].replace(/=+$/, "")
  ) {
    return null;
  }
  return blob;
}

/** De-armor `-----BEGIN SSH SIGNATURE-----` … to the raw SSHSIG blob. */
function _dearmorSshSig(sig) {
  if (typeof sig !== "string") return null;
  const m = sig.match(
    /-----BEGIN SSH SIGNATURE-----\r?\n([\s\S]*?)-----END SSH SIGNATURE-----/,
  );
  if (!m) return null;
  const b64 = m[1].replace(/\s+/g, "");
  if (!b64) return null;
  let blob;
  try {
    blob = Buffer.from(b64, "base64");
  } catch {
    return null;
  }
  if (blob.toString("base64").replace(/=+$/, "") !== b64.replace(/=+$/, "")) {
    return null;
  }
  return blob;
}

/**
 * Verify an SSHSIG-armoured ed25519 signature in-process.
 *
 * @returns {{valid: boolean, reason?: string} | null} — null means UNSUPPORTED:
 *   the caller MUST fall back to `ssh-keygen`. `valid: false` is likewise
 *   treated as inconclusive by the caller (see `_verifySsh`); only
 *   `valid: true` short-circuits the subprocess.
 */
function _verifySshInProcess(content, sig, pubKey, namespace) {
  const expectedKeyBlob = _parseOpenSshPubKeyBlob(pubKey);
  if (!expectedKeyBlob) return null;

  const blob = _dearmorSshSig(sig);
  if (!blob) return null;

  if (blob.length < SSHSIG_MAGIC.length + 4) return null;
  if (!blob.subarray(0, SSHSIG_MAGIC.length).equals(SSHSIG_MAGIC)) return null;
  let off = SSHSIG_MAGIC.length;
  if (off + 4 > blob.length) return null;
  const version = blob.readUInt32BE(off);
  off += 4;
  if (version !== 1) return null;

  const pk = _sshReadString(blob, off);
  if (!pk) return null;
  const ns = _sshReadString(blob, pk.next);
  if (!ns) return null;
  const reserved = _sshReadString(blob, ns.next);
  if (!reserved) return null;
  const hashAlgF = _sshReadString(blob, reserved.next);
  if (!hashAlgF) return null;
  const sigField = _sshReadString(blob, hashAlgF.next);
  if (!sigField) return null;
  // A trailing byte means the blob is not the shape this parser understands.
  // Ignoring it would let an attacker append material the verify never covers.
  if (sigField.next !== blob.length) return null;

  // ---- BINDING 1: the signature's embedded key IS the expected key ---------
  // `ssh-keygen -Y verify` enforces this binding via the allowed_signers
  // principal; this is that check.
  //
  // ITS ACTUAL STRENGTH, MEASURED, because the obvious claim for it is false.
  // An earlier revision of this comment said "without this the signature would
  // verify against whatever key it carries, which is a signature by ANYONE".
  // Mutating this comparison to `false` did NOT red the wrong-key pin, so that
  // claim is withdrawn: the identity binding is enforced TWICE, and this is the
  // weaker of the two. The decisive one is further down — the ed25519 verify
  // unwraps its key from `expectedKeyBlob`, the CALLER-supplied key, never from
  // `pk.value`, the key the signature carries. A signature by another key
  // therefore fails the crypto even with this check removed.
  //
  // The pin is not vacuous, which was confirmed rather than assumed: mutating
  // the key-unwrap source from `expectedKeyBlob` to `pk.value` — the real
  // impersonation shape — DOES red it. So this check is a cheap early reject
  // and defense-in-depth against a future edit that changes where the verify
  // key comes from; it is not the sole barrier, and is documented as what it is.
  if (
    pk.value.length !== expectedKeyBlob.length ||
    !crypto.timingSafeEqual(pk.value, expectedKeyBlob)
  ) {
    return {
      valid: false,
      reason: "signature key does not match expected pubkey",
    };
  }

  // ---- BINDING 2: the namespace matches -----------------------------------
  // The namespace is what stops a signature made for one protocol being
  // replayed into another. `_verifySsh` passes SSH_NAMESPACE via `-n`.
  if (ns.value.toString("utf8") !== namespace) {
    return { valid: false, reason: "signature namespace mismatch" };
  }
  if (reserved.value.length !== 0) return null;

  const hashAlg = hashAlgF.value.toString("utf8");
  if (hashAlg !== "sha256" && hashAlg !== "sha512") return null;

  // ---- unwrap the inner signature blob ------------------------------------
  const sigAlg = _sshReadString(sigField.value, 0);
  if (!sigAlg) return null;
  if (sigAlg.value.toString("utf8") !== "ssh-ed25519") return null;
  const sigRaw = _sshReadString(sigField.value, sigAlg.next);
  if (!sigRaw) return null;
  if (sigRaw.next !== sigField.value.length) return null;
  if (sigRaw.value.length !== 64) return null;

  // ---- unwrap the public key blob to its raw 32-byte point -----------------
  const keyAlg = _sshReadString(expectedKeyBlob, 0);
  if (!keyAlg) return null;
  if (keyAlg.value.toString("utf8") !== "ssh-ed25519") return null;
  const keyRaw = _sshReadString(expectedKeyBlob, keyAlg.next);
  if (!keyRaw) return null;
  if (keyRaw.next !== expectedKeyBlob.length) return null;
  if (keyRaw.value.length !== 32) return null;

  // ---- rebuild the signed blob (PROTOCOL.sshsig) --------------------------
  const mh = crypto.createHash(hashAlg).update(content).digest();
  const signedData = Buffer.concat([
    SSHSIG_MAGIC,
    _sshWriteString(ns.value),
    _sshWriteString(reserved.value),
    _sshWriteString(hashAlgF.value),
    _sshWriteString(mh),
  ]);

  let keyObj;
  try {
    keyObj = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, keyRaw.value]),
      format: "der",
      type: "spki",
    });
  } catch {
    return null;
  }

  let ok;
  try {
    ok = crypto.verify(null, signedData, keyObj, sigRaw.value);
  } catch {
    return null;
  }
  return ok
    ? { valid: true }
    : { valid: false, reason: "ed25519 signature did not verify" };
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
  writeFoldPidFile(tmpDir); // #867 pid-liveness ownership marker
  const inFile = path.join(tmpDir, "payload");
  // M9.1 R3 Sec-R3-S-06 — owner-only mode on temp files. Defense-in-depth
  // against same-uid co-tenant reading canonical bytes mid-sign.
  fs.writeFileSync(inFile, content, { mode: 0o600 });
  try {
    const r = spawnSync(
      "ssh-keygen",
      ["-Y", "sign", "-f", keyPath, "-n", SSH_NAMESPACE, inFile],
      { encoding: "utf8", ...SPAWN_BOUND },
    );
    if (_spawnDidNotRun(r)) {
      return {
        ok: false,
        error: "sign failed",
        reason: `ssh-keygen did not run: ${_noVerdictReason(r)}`,
      };
    }
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
  // FAST PATH (loom s49 P5). An ssh-ed25519 SSHSIG this process fully
  // understands is verified in-process via node:crypto — same OpenSSL
  // primitive ssh-keygen uses, without the per-record subprocess that made
  // every read-time fold cost ~18ms x N. Only a `valid: true` short-circuits.
  // `null` (UNSUPPORTED) and `valid: false` BOTH fall through to ssh-keygen
  // below, so this path can only ever remove a subprocess from the ACCEPT
  // case; it can never turn an ssh-keygen accept into a denial, and a parser
  // bug that wrongly rejects costs a spawn rather than refusing an honest
  // write. See the § SSHSIG envelope parsing header for the fail direction.
  //
  // COC_SIGN_INPROC_VERIFY=0 forces the subprocess path. The knob is
  // deliberately one-directional: its only reachable effect is to make
  // verification SLOWER by restoring the pre-existing behaviour exactly, so
  // unlike COC_INTEGRITY_GUARD_TIMEOUT_MS (loom#1855) it cannot be set to a
  // value that loosens a gate. There is no value of it that accepts anything
  // the subprocess path would reject.
  if (process.env.COC_SIGN_INPROC_VERIFY !== "0") {
    let fast = null;
    try {
      fast = _verifySshInProcess(content, sig, pubKey, SSH_NAMESPACE);
    } catch {
      // Any unexpected throw is UNSUPPORTED, not a verdict: fall through.
      fast = null;
    }
    if (fast && fast.valid === true) return { ok: true, valid: true };
  }

  // ssh-keygen -Y verify requires an allowed-signers file mapping a
  // principal → pubkey. We synthesize one with a placeholder principal,
  // then verify the signature was produced by THAT principal. If verify
  // exits non-zero the signature did not validate against the pubkey.
  const principal = "coc@signer";
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coc-sign-ssh-vfy-"));
  writeFoldPidFile(tmpDir); // #867 pid-liveness ownership marker
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
      { input: content, encoding: "utf8", ...SPAWN_BOUND },
    );
    // The verifier never RAN — ssh-keygen absent, killed by SPAWN_TIMEOUT_MS,
    // unforkable. Same discrimination the gpg path makes: fail-closed
    // (`valid:false`) but labelled INDETERMINATE, so a broken toolchain is not
    // reported to the operator as a forged record.
    if (_spawnDidNotRun(r)) {
      return {
        ok: true,
        valid: false,
        indeterminate: true,
        reason: `ssh-keygen verify did not run: ${_noVerdictReason(r)}`,
      };
    }
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
  const r = spawnSync("gpg", args, {
    input: content,
    encoding: "buffer",
    ...SPAWN_BOUND,
  });
  if (_spawnDidNotRun(r)) {
    return {
      ok: false,
      error: "sign failed",
      reason: `gpg did not run: ${_noVerdictReason(r)}`,
    };
  }
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
function _verifyGpg(
  content,
  sig,
  pubKeyArmored,
  gpgHome,
  expectedFpr,
  keyringIsTrustSet,
) {
  // NORMALIZED ONCE, HERE, and every consumer below reads THIS value.
  //
  // `verify()` normalized into a local for its length floor and then passed the
  // RAW `expectedFpr` down — so the floor measured one string and the bind
  // re-derived another. That is the same shape as the defect the floor was added
  // to fix, one layer up, and it is closed by there being a single value.
  const wantFpr = _normalizeExpectedFpr(expectedFpr);

  // A FINGERPRINT, OR NOTHING — the shape check the length floor cannot make.
  //
  // Both floors were sized for a SUBSTRING bind ("16 is gpg's own short-key-id
  // width"). Under FIELD EQUALITY that sizing is wrong in a way that accuses the
  // innocent: any value of length 16..39 — a gpg LONG KEY ID being the canonical
  // case, and a perfectly ordinary thing to paste into a roster — clears the
  // floor and can NEVER equal a 40-hex field. It fell through to the mismatch
  // branch, which returns `valid:false` WITHOUT `indeterminate`, and the operator
  // was told the record "was altered after signing, or never signed by the
  // emitter it names". A ROSTER-CONFIGURATION defect reported as a forgery — the
  // same misclassification class this file has now fixed twice.
  //
  // Fails CLOSED either way; what changes is WHO the diagnosis accuses. 40 hex is
  // the v4 fingerprint, 64 the v5 — both are accepted because both are real.
  if (
    expectedFpr !== undefined &&
    expectedFpr !== null &&
    !/^(?:[0-9A-F]{40}|[0-9A-F]{64})$/.test(wantFpr)
  ) {
    return {
      ok: true,
      valid: false,
      indeterminate: true,
      reason:
        `expectedFpr is ${wantFpr.length} character(s) and is not a full OpenPGP fingerprint (40 or 64 ` +
        `hex). The identity bind compares FIELDS BY EQUALITY, so a short or non-hex value — a long key ` +
        `id, a truncated paste — can never match and would otherwise read as a forged signature. This ` +
        `is a roster-configuration defect: no signature was checked.`,
    };
  }
  // ---- in-process fast path (loom#1891) --------------------------------
  // A read-time fold verifies every record, and each verify here is a `gpg`
  // subprocess. Measured on loom's 919-record log: 894 gpg spawns / 14.8 s,
  // 90% of a 16.4 s fold. Decomposed, `gpg --version` (no verification work
  // whatsoever) costs 8.33 ms against 7.71 ms for a full shared-homedir
  // verify — the crypto is free, the process is the whole bill.
  //
  // The fast path is armed per-fingerprint ONLY AFTER gpg itself has
  // accepted a signature from that key in THIS process (the canary below).
  // openpgp-verify.js sees only the signature and the key material, so
  // KEY-level facts — expiry, revocation, trust — are invisible to it, and
  // the canary makes the slow path adjudicate them first.
  //
  // What that buys is PARITY, not fail-closed. Measured 2026-08-21 with
  // purpose-built test keys: gpg reports REVKEYSIG for a revoked key and
  // EXPKEYSIG for an expired one, but emits VALIDSIG and exits 0 for BOTH,
  // so _verifyGpgViaSubprocess already returns valid:true for both and the
  // canary duly arms. This path therefore reproduces the existing verdict
  // rather than tightening or loosening it. The substrate's acceptance of
  // revoked/expired keys is pre-existing and out of scope here — see the
  // measured note in openpgp-verify.js.
  //
  // Cost of the canary: one gpg spawn per distinct signing key per process.
  const fprKey = _canaryKey(wantFpr);
  if (fprKey && _gpgAcceptedFingerprints.has(fprKey)) {
    const fast = openpgpVerify.tryVerifyDetached(
      content,
      sig,
      pubKeyArmored,
      wantFpr,
    );
    // Only a fully-recognised, OpenSSL-confirmed result short-circuits.
    // `supported:false` covers unparseable, unsupported-algorithm AND
    // did-not-verify alike, and all three fall through to gpg below — so a
    // parser bug costs a spawn and can never deny an honest write.
    if (fast.supported === true && fast.valid === true) {
      return { ok: true, valid: true };
    }
  }

  const _slow = _verifyGpgViaSubprocess(
    content,
    sig,
    pubKeyArmored,
    gpgHome,
    wantFpr,
    keyringIsTrustSet,
  );
  // Arm the canary only on gpg's own affirmative verdict.
  if (fprKey && _slow && _slow.ok === true && _slow.valid === true) {
    _gpgAcceptedFingerprints.add(fprKey);
  }
  return _slow;
}

// Fingerprints for which `gpg` has returned a valid verdict in THIS process.
// Process-local and in-memory by construction: it is a cache of a verdict
// this process itself observed, never a durable artefact another writer could
// pre-populate. A durable on-disk equivalent was considered and rejected —
// it would promote an unauthenticated file to a signature-verification
// oracle, which is a trust surface that does not exist today.
const _gpgAcceptedFingerprints = new Set();

/**
 * Canary key for a verify call: the caller's expectedFpr, or null.
 *
 * null DISABLES the fast path for that call, which is the intended answer
 * whenever no identity bind is available. An earlier revision fell back to
 * `key:sha256(pubKeyArmored)` here, and that was a real hole: the fallback
 * fires exactly when `expectedFpr` is absent, which is exactly when the
 * verifier skips the fingerprint compare — so the canary would have been
 * armed on key material gpg never examined. With a caller-supplied `gpgHome`
 * the slow path does NOT import `pubKeyArmored` at all (see the
 * `_verifyGpgViaSubprocess` contract), so a genuine record signed by a
 * ROSTERED key could arm a canary named after an ATTACKER-SUPPLIED blob, and
 * the next record would then be verified against that blob. No current caller
 * reaches it — all three pass a roster fingerprint — but it was a loaded
 * footgun for the next one, so the fallback is gone rather than documented.
 */
function _canaryKey(expectedFpr) {
  // Routed through THE normalizer rather than repeating its expression. Two
  // copies of a normalization are how the two come to disagree, which is the
  // defect this module already paid for once (a floor measuring `.trim()` while
  // the bind measured a full whitespace strip).
  const n = _normalizeExpectedFpr(expectedFpr);
  return n ? `fpr:${n}` : null;
}

/**
 * GnuPG `--status-fd` lines that are UNCONDITIONALLY a statement about THE
 * SIGNATURE OR ITS BYTES — a genuine verdict about the record.
 *
 *   BADSIG      the signature is present, parses, and does NOT verify.
 *   NODATA      the supplied blob is not OpenPGP data (a forged/garbage `sig`).
 *   UNEXPECTED  the input was not the expected packet sequence.
 */
const _GPG_RECORD_VERDICT_KEYWORDS = new Set([
  "BADSIG",
  "NODATA",
  "UNEXPECTED",
]);

/**
 * "The issuing key is not in this keyring." Whether that is a fact about the
 * RECORD or about the VERIFIER depends entirely on WHO BUILT THE KEYRING, which
 * is why it cannot live in the unconditional set above.
 */
const _GPG_ISSUER_ABSENT_KEYWORDS = new Set(["NO_PUBKEY", "ERRSIG"]);

/**
 * The status KEYWORDS in a `--status-fd` stream, read POSITIONALLY.
 *
 * ── WHY NOT A REGEX OVER THE BLOB ────────────────────────────────────────────
 *
 * These keywords used to be matched with `\bTOKEN\b` against the WHOLE status
 * output. gpg emits UID-bearing lines (`GOODSIG`, `USERID_HINT`) whose trailing
 * field is FREE-FORM TEXT chosen by whoever generated the key, and gpg does NOT
 * escape spaces in it. So a user ID containing the word `BADSIG` flipped
 * `isRecordVerdict` true and stripped `indeterminate` — turning a toolchain
 * outage into a forgery accusation against a signer who did nothing wrong. The
 * same shape in the other direction is what let a crafted UID satisfy the
 * identity bind (see `_validsigNamesKey`).
 *
 * A status line's KEYWORD is token 1 of a line whose token 0 is exactly
 * `[GNUPG:]`. Reading it there means attacker-chosen text in a trailing field
 * cannot be mistaken for a protocol keyword, whatever it spells.
 */
function _statusKeywords(status) {
  const out = new Set();
  for (const raw of String(status == null ? "" : status).split("\n")) {
    const t = raw.trim().split(/\s+/);
    if (t[0] !== "[GNUPG:]") continue;
    if (t[1]) out.add(t[1].toUpperCase());
  }
  return out;
}

/** Does the stream carry any of `keywords` as a real status KEYWORD? */
function _statusHasKeyword(status, keywords) {
  for (const k of _statusKeywords(status)) {
    if (keywords.has(k)) return true;
  }
  return false;
}

/**
 * Does this `VALIDSIG` status line name `want` in a FINGERPRINT FIELD?
 *
 * ── WHY EXACT FIELDS AND NOT A SUBSTRING ─────────────────────────────────────
 *
 * The bind was `wholeLine.replace(/\s+/g,"").includes(want)`. GnuPG's VALIDSIG
 * line is `[GNUPG:] VALIDSIG <fpr> <sig_creation_date> <sig-timestamp>
 * <expire-timestamp> <sig-version> <reserved> <pubkey-algo> <hash-algo>
 * <sig-class> [<primary-key-fpr>]` — several DECIMAL fields sit between the two
 * fingerprints, and every decimal digit is also a hex digit. Concatenating the
 * line and substring-matching therefore lets a `want` composed only of digits
 * match a run spanning timestamps and algorithm ids WITHOUT ever touching a
 * signing key. A length floor makes that improbable; it does not make it
 * impossible. Comparing FIELDS by equality makes it impossible, which is the
 * difference between buying probability and holding a property — and it is why
 * this supersedes the floor rather than sitting beside it.
 *
 * ── BOTH FIELDS, AND THAT IS LOAD-BEARING, NOT LENIENCE ──────────────────────
 *
 * The roster stores the PRIMARY key fingerprint. When a key signs through a
 * signing SUBKEY, gpg puts the SUBKEY's fingerprint in the first field and the
 * PRIMARY's in the last — so a naive "tighten to field 1" refactor silently
 * rejects every subkey signer. `coc-sign-shared-homedir.test.mjs` exists to lock
 * exactly that decision and warns about this refactor by name. Both fields are
 * compared, each by EQUALITY, so subkey signers keep working and the
 * concatenation is gone.
 */
function _validsigNamesKey(validsigLine, want) {
  if (!want) return false;
  const t = String(validsigLine).trim().split(/\s+/);
  // THE LINE IS A VALIDSIG LINE, CHECKED — not assumed from the caller's choice.
  //
  // This function reads token 2 and token 11 POSITIONALLY, and those positions
  // only mean "signing fingerprint" and "primary-key fingerprint" on a real
  // VALIDSIG line. An earlier revision stated that assumption in a comment and
  // never tested it, while the caller selected the line with `/\bVALIDSIG\b/` —
  // the word ANYWHERE. gpg emits UID-bearing lines (`GOODSIG`, `USERID_HINT`)
  // BEFORE the verdict, whose trailing field is free-form text chosen by whoever
  // generated the key, and gpg does NOT escape spaces in it.
  //
  // MEASURED, end to end, against this module: a user ID of the form
  // `VALIDSIG a b c d e f g <victim-40-hex> <addr>` puts the VICTIM's fingerprint
  // at token 11 of a GOODSIG line; that line satisfied the caller's selector, and
  // this function returned true. `verify` returned `{ok:true, valid:true}` for a
  // record the victim's key never signed — the exact bounded-trust impersonation
  // (a ROSTERED operator forging a record attributed to another) this bind exists
  // to stop, and gpg exits 0 throughout because the ATTACKER's key really is in
  // the roster-built keyring.
  //
  // The guarantee therefore lives WITH the function that claims it. The caller is
  // anchored too, but a caller-side anchor alone leaves this function willing to
  // read positional fields out of any line it is handed, which is how the next
  // caller reintroduces the hole.
  if (t[0] !== "[GNUPG:]" || t[1] !== "VALIDSIG") return false;
  const f = _validsigFields(validsigLine);
  return want === f.signing || want === f.primary;
}

/**
 * The two fingerprint-bearing fields of a VALIDSIG line, normalized.
 *
 * Split out from `_validsigNamesKey` so the caller can ask a SECOND question of
 * the same line — whether a non-matching `want` failed because it names a
 * DIFFERENT KEY or because it is the wrong SHAPE for this key's version. Those
 * are different findings that send the operator to different places, and the
 * caller cannot tell them apart from a bare boolean.
 *
 * Token 2 is the signing key's fingerprint; token 11 the optional primary-key
 * fingerprint. Read defensively — a gpg build emitting a shorter line yields
 * `undefined`, which normalizes to "".
 */
function _validsigFields(validsigLine) {
  const t = String(validsigLine).trim().split(/\s+/);
  return {
    signing: _normalizeExpectedFpr(t[2]),
    primary: _normalizeExpectedFpr(t[11]),
  };
}

/**
 * Is a non-zero gpg exit a verdict about the RECORD, or a verifier failure?
 *
 * ── THE ROUTE THIS EXISTS FOR, AND THE CLAIM IT WITHDRAWS ────────────────────
 *
 * An earlier revision of this file asserted that `ERRSIG`/`NO_PUBKEY` "means the
 * VERIFIER failed, not the record", and treated them as INDETERMINATE. That half
 * was FALSE and is withdrawn rather than restated. MEASURED (GnuPG 2.5.21, after
 * a `gpg --version` exit-0 control):
 *
 *   gpg --homedir <empty> --batch --status-fd 1 --verify <real armored sig> <content>
 *   exit=2 · [GNUPG:] NEWSIG / ERRSIG <keyid> / NO_PUBKEY <keyid> / FAILURE
 *   matches /\b(BADSIG|NODATA|UNEXPECTED)\b/  =>  FALSE
 *
 * The forgery it admits is the NATURAL one, and it is not the unrostered-signer
 * case that route was confused with: set the record's `verified_id` to a ROSTERED
 * operator's fingerprint and sign with an UNROSTERED key. `resolveKey` then
 * SUCCEEDS with the victim's key, the record reaches the verify pass, and the
 * shared homedir — which `createVerifyHomedir` built from the ROSTER, and which
 * this function does NOT add to when `gpgHome` was supplied (see the `ownsHome`
 * guard) — definitively lacks the attacker's key. gpg emits ERRSIG/NO_PUBKEY and
 * no BADSIG, and the record used to land as INDETERMINATE: the operator is told
 * to repair gpg while a forgery sits on disk.
 *
 * ── THE DISCRIMINATOR IS WHO BUILT THE KEYRING ───────────────────────────────
 *
 * CALLER-SUPPLIED keyring (`ownsHome === false`): its contents are the roster.
 * An issuer absent from it is an issuer the ROSTER does not vouch for, while the
 * record NAMES a signer the roster does — so the record's bytes and the identity
 * it claims disagree. That is a positive fact about the RECORD: `bad-signature`.
 *
 * PER-CALL keyring (`ownsHome === true`): this function imported exactly the one
 * `pubKeyArmored` it was handed, so an absent issuer means that import did not
 * take — a fact about the VERIFIER: INDETERMINATE.
 *
 * @param {string} status  the `--status-fd` output
 * @param {boolean} ownsHome  did THIS call build the keyring?
 */
function _gpgNonZeroIsRecordVerdict(status, trustSetKeyring) {
  if (_statusHasKeyword(status, _GPG_RECORD_VERDICT_KEYWORDS)) return true;
  if (trustSetKeyring && _statusHasKeyword(status, _GPG_ISSUER_ABSENT_KEYWORDS))
    return true;
  return false;
}

/**
 * Homedirs THIS process built with `createVerifyHomedir`, and enough about each
 * to notice it is no longer the thing it was.
 *
 * Process-local and in-memory by construction, for the same reason
 * `_gpgAcceptedFingerprints` is: it records what this process itself did, and a
 * durable equivalent would promote an unauthenticated file into an input to a
 * trust decision.
 */
const _verifyHomedirs = new Map(); // home → {keyCount, ringPath, ringSize}

/** The keyring file gpg wrote into `home`, or null. */
function _ringStat(home) {
  for (const name of ["pubring.kbx", "pubring.gpg"]) {
    const p = path.join(home, name);
    try {
      const st = fs.statSync(p);
      if (st.isFile()) return { ringPath: p, ringSize: st.size };
    } catch {
      // absent — try the next name; "no keyring here" is the answer, not an error.
    }
  }
  return null;
}

/**
 * May the ISSUER-ABSENT branch be trusted for this call?
 *
 * The inference "an issuer absent from this keyring is a forgery" rests on a
 * PRECONDITION — that the keyring IS the trust set. Two things can falsify it,
 * and both invert the verdict against an innocent operator, so both are checked
 * rather than assumed:
 *
 *   1. THE CALLER NEVER CLAIMED IT. `ownsHome === false` says only that a path
 *      was supplied, which is a fact about an argument, not about its contents.
 *      A caller that supplies a NARROW homedir — one anchor's key, a natural
 *      optimization — would have every other signer reported as forged. So the
 *      caller must ASSERT the precondition (`keyringIsTrustSet`), not have it
 *      inferred from a path being present.
 *   2. THE KEYRING IS NO LONGER WHAT WE BUILT. A shared homedir lives under
 *      `os.tmpdir()`; if it is removed mid-fold (a reaper, a cleanup script, an
 *      operator), gpg RECREATES it EMPTY on the next call and then reports every
 *      record's issuer absent — turning one filesystem event into a whole log
 *      accused of forgery. `fs.existsSync(home)` cannot see this, because gpg
 *      has just recreated the directory; the KEYRING FILE is what changes. Its
 *      recorded size is compared, and a shrink or a disappearance means the
 *      keyring is not the trust set any more.
 *
 * Either failing ⇒ INDETERMINATE, which is the honest verdict: we no longer know
 * what the keyring contains, so we cannot say the issuer is absent FROM THE
 * ROSTER rather than absent from a directory that got emptied.
 */
function _keyringIsStillTheTrustSet(home, claimed) {
  if (!claimed || !home) return false;
  const rec = _verifyHomedirs.get(home);
  if (!rec || !rec.keyCount || !rec.ringPath) return false;
  const now = _ringStat(home);
  if (!now) return false;
  return now.ringPath === rec.ringPath && now.ringSize >= rec.ringSize;
}

/**
 * The spawn-based verify.
 *
 * THREE outcomes, never two. `{ok:true, valid:true}` verified;
 * `{ok:true, valid:false}` the record FAILED; `{ok:true, valid:false,
 * indeterminate:true}` verification could not RUN and the record's status is
 * UNKNOWN. The third shape is new (2026-08-23) and is deliberately a REFINEMENT
 * rather than a contract change: it keeps `valid:false`, so every pre-existing
 * caller that reads `valid` still fails CLOSED exactly as before, and only a
 * caller that ASKS about `indeterminate` sees the finer verdict.
 */
function _verifyGpgViaSubprocess(
  content,
  sig,
  pubKeyArmored,
  gpgHome,
  expectedFpr,
  keyringIsTrustSet,
) {
  // Build a transient keyring containing the supplied pubkey, then verify.
  const home =
    gpgHome || fs.mkdtempSync(path.join(os.tmpdir(), "coc-sign-gpg-vfy-"));
  const ownsHome = !gpgHome;
  if (ownsHome) {
    writeFoldPidFile(home); // #867 pid-liveness ownership marker
    writeEphemeralAgentConf(home); // before the first gpg call starts the agent
  }
  try {
    if (ownsHome) {
      const r1 = spawnSync("gpg", ["--homedir", home, "--import", "--batch"], {
        input: pubKeyArmored,
        encoding: "utf8",
        ...SPAWN_BOUND,
      });
      if (_spawnDidNotRun(r1)) {
        // gpg absent, killed by the timeout, or unforkable. NOT a fact about
        // the signature — reported as INDETERMINATE so a caller cannot read a
        // broken toolchain as a forgery.
        return {
          ok: true,
          valid: false,
          indeterminate: true,
          reason: `gpg --import did not run: ${_noVerdictReason(r1)}`,
        };
      }
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
    // ── THE SIGNED DATA GOES BY FILE, NOT BY PIPE ───────────────────────────
    //
    // This site used to pass the data on stdin (`"-"` + `input: content`), and
    // that pipe was a SIZE-DEPENDENT RACE. gpg decides as soon as it has read
    // enough — on a malformed or unverifiable signature it decides almost
    // immediately — and exits while the parent is still writing. The unfinished
    // write then raises EPIPE, and because a SUCCESS status under EPIPE covers
    // only the prefix gpg actually consumed, `_noVerdictReason` correctly refuses
    // to bank it and the caller reports INDETERMINATE. A correct verdict was
    // being converted into "verification could not run" by the transport.
    //
    // MEASURED against the real gpg on one tree, malformed-signature case,
    // holding everything but the transport constant:
    //
    //     stdin   1 KB → status 2, error none      file    1 KB → status 2, none
    //     stdin  64 KB → status 2, error none      file 1024 KB → status 2, none
    //     stdin 1024 KB → status 2, error EPIPE    file 8192 KB → status 2, none
    //     stdin 8192 KB → status 2, error EPIPE    file 65536 KB → status 2, none
    //
    // The two forms agree on the VERDICT axis (status 2 throughout) and differ
    // ONLY on the EPIPE axis, which is what makes this a fix to the transport
    // rather than a change to what counts as verified. The failure was invisible
    // below the pipe buffer and certain above it, so it presented as CI-only
    // flakiness that varied case-to-case with payload size — 2 failures on one
    // run and 3 on the next, from the same defect.
    //
    // WHY NOT "classify EPIPE better": the EPIPE classification below is CORRECT
    // and stays. A success-status pass over a prefix the verifier never finished
    // reading must never be banked, so no amount of downstream classification
    // could recover the verdict — the only fix that yields a verdict over the
    // WHOLE input is to stop truncating the input.
    //
    // NOT swept to the two sibling stdin sites, and each for a stated reason:
    // the `ssh-keygen -Y verify` site has NO file interface for the signed data
    // (it reads the message from stdin by construction), so its pipe is
    // unavoidable and its EPIPE classification is the correct handling; the
    // `gpg --detach-sign` site is SIGNING, where an EPIPE means no signature was
    // produced rather than a verdict misread as an outage.
    const dataFile = path.join(home, "coc-data.bin");
    fs.writeFileSync(dataFile, content, { mode: 0o600 });
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
        dataFile,
      ],
      { encoding: "utf8", ...SPAWN_BOUND },
    );
    // (a) THE VERIFIER NEVER RAN. ENOENT mid-batch (gpg removed while a fold is
    // in flight), the SPAWN_TIMEOUT_MS kill, an unforkable process. `status` is
    // null on all three, which the pre-existing `r.status !== 0` read as a
    // signature failure — telling the operator to investigate a FORGERY when the
    // fix is "repair gpg".
    // THE ONE SITE THAT OPTS IN. It is the only caller here holding a machine-readable
    // status channel: below, `_gpgNonZeroIsRecordVerdict(status, trustSet)` reads
    // `--status-fd` for BADSIG/NODATA and re-adds `indeterminate` when the keyword is
    // ABSENT — which is exactly what a stream truncated by EPIPE looks like. So an
    // EPIPE that reaches the nonzero branch here is still classified by gpg's own
    // words, never by the exit code alone, and truncation degrades toward
    // INDETERMINATE rather than toward a forgery accusation.
    if (_spawnDidNotRun(r, { admitEpipeVerdict: true })) {
      return {
        ok: true,
        valid: false,
        indeterminate: true,
        reason: `gpg --verify did not run: ${_noVerdictReason(r)}`,
      };
    }
    const status = String(r.stdout || "");
    if (r.status !== 0) {
      // (b) A NON-ZERO EXIT IS ONLY A SIGNATURE VERDICT WHEN GPG SAYS SO.
      // GnuPG exits non-zero for a bad signature (BADSIG, exit 1) AND for every
      // operational failure (exit 2: missing key, unreadable homedir, broken
      // keyring, wedged agent). Only the machine-readable status line can tell
      // those apart, so it is what is read — not the exit code alone.
      // The precondition is CHECKED, not inferred from a path being present.
      const trustSet =
        !ownsHome &&
        _keyringIsStillTheTrustSet(home, keyringIsTrustSet === true);
      const isRecordVerdict = _gpgNonZeroIsRecordVerdict(status, trustSet);
      const issuerAbsent =
        trustSet && _statusHasKeyword(status, _GPG_ISSUER_ABSENT_KEYWORDS);
      return {
        ok: true,
        valid: false,
        ...(isRecordVerdict ? {} : { indeterminate: true }),
        reason: issuerAbsent
          ? `gpg --verify exit ${r.status}: the ISSUING KEY is absent from the caller-supplied keyring, ` +
            `which was built from the roster — so this record was signed by a key the roster does not ` +
            `carry, while naming a signer it does. That is a fact about the RECORD, not the verifier: ` +
            `${(r.stderr || "").trim().slice(0, 256)}`
          : isRecordVerdict
            ? `gpg --verify exit ${r.status}: ${(r.stderr || "").trim().slice(0, 256)}`
            : `gpg --verify exit ${r.status} with no BADSIG/NODATA status line and no issuer-absent ` +
              `status on a caller-supplied keyring, so gpg reached no verdict about this signature: ` +
              `${(r.stderr || "").trim().slice(0, 256)}`,
      };
    }
    // Identity binding: when the caller names the expected signer key, the
    // signature MUST have been made by THAT key — not merely by SOME key in
    // the (possibly shared, multi-key) keyring. Fail-closed: a missing or
    // mismatched VALIDSIG fingerprint is NOT valid.
    if (expectedFpr) {
      // THE normalizer, not a fourth copy of its expression. `_verifyGpg` already
      // normalized, so this is idempotent — but a second spelling of the same
      // rule is how the two drift, and this module has already paid for that.
      const want = _normalizeExpectedFpr(expectedFpr);
      // ANCHORED. `/\bVALIDSIG\b/` matched the word ANYWHERE on ANY line, so a
      // crafted user ID riding a GOODSIG line was selected as though it were the
      // verdict. The keyword is token 1 of a line whose token 0 is `[GNUPG:]`,
      // and that is where it is now read.
      //
      // WHAT THIS ANCHOR BUYS, precisely — because it is NOT the security half.
      // Given `_validsigNamesKey`'s own keyword assert, a mis-selected line is
      // already rejected, so the anchor cannot be what stops the impersonation.
      // What it stops is the OTHER failure: under the old regex `.find()` could
      // settle on an earlier non-verdict line, the assert would reject it, and
      // this function would report "a DIFFERENT key" WITHOUT EVER READING the
      // real VALIDSIG — refusing an HONEST record. The assert holds the security
      // property; the anchor holds AVAILABILITY. Both are wanted, and neither
      // substitutes for the other.
      const validsig = status
        .split("\n")
        .map((l) => l.trim())
        .find((l) => /^\[GNUPG:\]\s+VALIDSIG(?:\s|$)/.test(l));
      if (!validsig) {
        // (c) EXIT 0 AND NO VALIDSIG. gpg reported success and then failed to
        // say WHICH key it verified against, so the identity bind cannot be
        // evaluated. That is a fact about the STATUS CHANNEL — a `--status-fd`
        // that did not reach us, an unexpected gpg build — never about the
        // record. Still `valid:false` (fail-closed, unchanged), now correctly
        // labelled INDETERMINATE so the refusal points at gpg and not at a
        // signer who did nothing wrong.
        return {
          ok: true,
          valid: false,
          indeterminate: true,
          reason: `gpg --verify exited 0 but emitted no VALIDSIG status; cannot bind signer to expected key ${want.slice(0, 16)}`,
        };
      }
      const present = _validsigNamesKey(validsig, want);
      if (!present) {
        // WHY IT DID NOT MATCH, and the two answers are not interchangeable.
        //
        // The form check upstream accepts 40-hex (v4) AND 64-hex (v5), because
        // both are real fingerprints. But a 64-hex roster entry against a v4 key
        // — or the reverse — is WELL-FORMED and can NEVER equal either field,
        // because equality is length-sensitive. Folding that into the mismatch
        // branch tells the operator the record "was altered after signing, or
        // never signed by the emitter it names", which is a forgery accusation
        // over a ROSTER-VERSION mismatch. That is the same misclassification the
        // form check itself was added to fix, re-created by widening it.
        //
        // A length class the line does not carry at all ⇒ roster/form defect ⇒
        // INDETERMINATE. A length class it DOES carry, with different bytes ⇒
        // genuinely a different key ⇒ the mismatch verdict stands.
        const f = _validsigFields(validsig);
        const lengths = [f.signing, f.primary]
          .filter(Boolean)
          .map((x) => x.length);

        // A VALIDSIG CARRYING NO FINGERPRINT AT ALL is not a mismatch — there is
        // nothing to have mismatched. It is the same fact as no VALIDSIG line,
        // which is already INDETERMINATE a few lines up, and accusing a record on
        // it would be an accusation drawn from an absent field.
        if (lengths.length === 0) {
          return {
            ok: true,
            valid: false,
            indeterminate: true,
            reason:
              `gpg emitted a VALIDSIG line carrying NO fingerprint field, so there is nothing to bind ` +
              `the signer to. Verification could not reach a verdict about this record.`,
          };
        }

        // WHICH OF TWO CAUSES PRODUCED IDENTICAL EVIDENCE.
        //
        // A length-class difference has two possible causes and they are NOT
        // interchangeable:
        //   (a) a ROSTER-VERSION defect — the roster's fingerprint field is a
        //       mis-transcription of the SAME key (v5 text for a v4 key). The
        //       operator fixes the roster. INDETERMINATE.
        //   (b) bounded-trust IMPERSONATION — a rostered operator whose key is a
        //       DIFFERENT VERSION signs a record naming another rostered
        //       operator. Their key is in the shared ring because their own
        //       legitimate records put it there, gpg exits 0, and the two
        //       fingerprints differ in length purely because the two PEOPLE use
        //       different key versions. That is a forgery and must BLOCK.
        //
        // Keying on length alone cannot tell them apart and silently resolved
        // every case to (a) — relabelling (b) from blocking to advisory. Not
        // reachable on today's roster (one gpg key, so there is no second gpg
        // operator to be the attacker), but it ARMS the moment a second gpg
        // operator is rostered at a different key version, and nobody making that
        // roster edit would connect it to this file.
        //
        // What separates them EXACTLY is what the supplied key material hashes
        // to. `pubKeyArmored` is the roster's key material for the signer the
        // record NAMES; with a caller-supplied ring this function never imported
        // it, so it is untouched roster data.
        const rosterKeyFpr =
          openpgpVerify.fingerprintFromArmoredKey(pubKeyArmored);
        let formMismatch;
        if (rosterKeyFpr) {
          // The named signer's OWN key signed this ⇒ `want` is merely a
          // mis-transcription of it ⇒ (a). Anything else ⇒ another key signed ⇒ (b).
          formMismatch =
            rosterKeyFpr === f.signing || rosterKeyFpr === f.primary;
        } else {
          // CANNOT TELL — the key is not one this parser reads (it handles v4 RSA
          // primaries). Fall back to the length heuristic, but ONLY where (b) is
          // impossible: on a keyring this process built from the roster, every key
          // present is rostered, so a VALIDSIG naming a different fingerprint IS a
          // rostered-but-different signer and the version excuse cannot apply.
          //
          // RESIDUAL, stated rather than hidden: for a non-v4-RSA key on a
          // trust-set ring, a genuine roster-version defect is still reported as a
          // forgery. That is the safer of the two errors — accusing a
          // misconfiguration is noisy and wrong-party, relabelling an
          // impersonation as advisory is a posture hole — and it shrinks to
          // nothing as soon as the parser learns that key version.
          formMismatch =
            !keyringIsTrustSet &&
            lengths.length > 0 &&
            !lengths.includes(want.length);
        }
        if (formMismatch) {
          return {
            ok: true,
            valid: false,
            indeterminate: true,
            reason:
              `expectedFpr is ${want.length} hex character(s) but this key's VALIDSIG fields are ` +
              `${lengths.join("/")} — a different fingerprint VERSION, so the two can never be equal ` +
              `whatever the key. The roster entry does not match the key's format; no forgery is implied ` +
              `and no signature was judged.`,
          };
        }
        return {
          ok: true,
          valid: false,
          reason: `signature verified against a DIFFERENT key than expected (${want.slice(0, 16)}…); VALIDSIG: ${validsig.trim().slice(0, 120)}`,
        };
      }
    }
    return { ok: true, valid: true };
  } finally {
    // The signed-data file is removed on BOTH paths and REGARDLESS of ownership,
    // which is deliberately stricter than the sibling `coc-sig.asc` beside it.
    // A signature is bounded and small; this file is a copy of whatever was
    // verified and is MB-scale by the time the EPIPE it removes would have
    // fired, so leaving it in a CALLER-SUPPLIED homedir (`ownsHome === false`,
    // where the teardown below does not run) would park the largest artifact
    // this function creates in a directory it does not own. Best-effort: a
    // failure to unlink a temp file must never mask the verification verdict.
    try {
      fs.unlinkSync(path.join(home, "coc-data.bin"));
    } catch {
      /* already gone, or never written because the import failed first */
    }
    // Runs on BOTH the success and the failure path (it is a `finally`), and
    // teardownGpgHomedir's bounded gpgconf call is what keeps that true — an
    // unbounded one hangs here forever and the rmSync never executes.
    if (ownsHome) teardownGpgHomedir(home);
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
  writeFoldPidFile(home); // #867 pid-liveness ownership marker (shared-fold homedir)
  writeEphemeralAgentConf(home); // before the first import starts the agent
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
      ...SPAWN_BOUND,
    });
    if (_spawnDidNotRun(r) || r.status !== 0) {
      // gpg absent (ENOENT) or an import failed — tear down and signal the
      // caller to fall back to the per-call ephemeral path.
      destroyVerifyHomedir(home);
      return {
        ok: false,
        reason: _spawnDidNotRun(r)
          ? `gpg unavailable: ${_noVerdictReason(r)}`
          : `gpg --import exit ${r.status}: ${(r.stderr || "").trim().slice(0, 256)}`,
      };
    }
  }
  // RECORD WHAT WE BUILT, so a later call can tell this keyring is still the
  // thing it was. Without it the issuer-absent branch has no way to distinguish
  // "absent from the roster" (a forgery) from "absent because the homedir was
  // removed mid-fold and gpg recreated it empty" (a filesystem event that would
  // otherwise accuse every record in the log).
  const ring = _ringStat(home);
  _verifyHomedirs.set(home, {
    keyCount: pubKeys.length,
    ringPath: ring ? ring.ringPath : null,
    ringSize: ring ? ring.ringSize : 0,
  });
  return { ok: true, home, keyCount: pubKeys.length };
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
  // Forget the recording FIRST. If teardown throws, the entry must already be
  // gone: a stale record would let a later call treat a destroyed keyring as a
  // live trust set, which is the exact inversion `_keyringIsStillTheTrustSet`
  // exists to prevent.
  _verifyHomedirs.delete(home);
  teardownGpgHomedir(home);
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
 * @param {string} [opts.gpgHome] - optional pre-loaded GPG homedir. Supplying it
 *   means the CALLER owns its lifecycle (this module neither imports into it nor
 *   tears it down).
 * @param {true} [opts.keyringIsTrustSet] - the caller ASSERTS that the keyring at
 *   `gpgHome` contains the COMPLETE set of keys this verification is allowed to
 *   accept — i.e. it IS the trust set (built from the roster), not a narrowed or
 *   convenience subset. REQUIRED to unlock the issuer-absent verdict: without it,
 *   a signature whose issuing key is not in the keyring is reported INDETERMINATE
 *   rather than as a forgery. Set it ONLY if that is true. A caller supplying a
 *   NARROW homedir (one anchor's key, a natural optimization) and setting this
 *   flag would have every other signer reported as forged — which is why the flag
 *   is an assertion the caller makes, not something inferred from a path being
 *   present. The claim is additionally CHECKED at use: if the keyring file this
 *   module recorded at `createVerifyHomedir` time is gone or has shrunk, the
 *   assertion is disregarded and the verdict falls back to INDETERMINATE.
 * @param {string} [opts.expectedFpr] - GPG only: when set, the signature MUST
 *   verify against THIS key fingerprint (VALIDSIG bind). Required when gpgHome
 *   is a shared multi-key keyring; ignored on the SSH path.
 * @returns {{ok: true, valid: boolean, indeterminate?: true, reason?: string}
 *          | {ok: false, error: string, reason: string}}
 *
 * `indeterminate: true` accompanies `valid: false` when the VERIFIER could not
 * reach a verdict (binary absent, killed by SPAWN_TIMEOUT_MS, exit 0 with no
 * VALIDSIG, a non-zero exit carrying no BADSIG/NODATA status). It is additive:
 * `valid` is still `false`, so a caller that reads only `valid` fails closed
 * exactly as before, and a caller that reads `indeterminate` can tell "this
 * record is forged" from "go and repair gpg" — two findings that send the
 * operator to opposite places.
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
  // THE IDENTITY-BIND FLOOR, AT THE SHARED CALLEE.
  //
  // It lived at ONE of the five call sites that reach this bind, which is
  // `security.md` § Multi-Site Kwarg Plumbing exactly: the four that did not
  // learn it kept shipping the failure mode it exists to fix. Enforced here, so
  // no caller can omit it and none has to remember it.
  //
  // A short `expectedFpr` is a BROKEN INPUT, not a bad signature: it is refused
  // with `ok:false` so `signed-log.js` classifies it INDETERMINATE and points
  // the operator at the roster, rather than at a signer who did nothing wrong.
  if (o.expectedFpr !== undefined && o.expectedFpr !== null) {
    const want = _normalizeExpectedFpr(o.expectedFpr);
    if (want.length < MIN_EXPECTED_FPR_CHARS) {
      return {
        ok: false,
        error: "invalid expected fingerprint",
        reason:
          `expectedFpr normalizes to ${want.length} character(s); the floor is ${MIN_EXPECTED_FPR_CHARS}. ` +
          `Whitespace is stripped before measuring because it is stripped before COMPARING — an entry ` +
          `padded to look long ("1  2  3  4  5  6") clears a naive trim()-based floor and arrives at the ` +
          `bind as 6 characters. Fix the roster entry; no signature was checked.`,
      };
    }
  }
  const buf = Buffer.isBuffer(content)
    ? content
    : Buffer.from(String(content), "utf8");
  try {
    if (keyType === "ssh") return _verifySsh(buf, sig, pubKey);
    return _verifyGpg(
      buf,
      sig,
      pubKey,
      o.gpgHome,
      o.expectedFpr,
      o.keyringIsTrustSet,
    );
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
  // Exported for the audit fixtures ONLY. The spawn-verdict classification is
  // the difference between "this record did not verify" and "repair your gpg",
  // and it is SIZE-DEPENDENT at the pipe buffer — so it needs cases that hand it
  // exact `spawnSync` shapes, which no public entry point can express. Same
  // underscore test-export convention as `wip-lanes.js::_git`.
  _spawnDidNotRun,
  _noVerdictReason,
  // Shared verify-homedir lifecycle (F17) — create ONE homedir per fold,
  // pass its `home` as opts.gpgHome to every verify, destroy once after.
  createVerifyHomedir,
  destroyVerifyHomedir,
  // Exposed for downstream shards that need to share the SSH namespace
  // when constructing allowed-signers files or audit records.
  SSH_NAMESPACE,
  // The ceiling every gpg/ssh-keygen spawn here runs under. Exported so a
  // fixture can assert the bound EXISTS rather than re-declaring its own copy
  // of the number — two copies of a timeout is how one of them drifts.
  SPAWN_TIMEOUT_MS,
};
