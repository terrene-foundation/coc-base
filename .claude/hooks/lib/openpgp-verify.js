/**
 * In-process OpenPGP detached-signature verification — the NARROW fast path
 * for the read-time fold's rule-1 signature gate.
 *
 * WHY THIS EXISTS
 * ---------------
 * `foldLog` verifies EVERY record's signature on every read-time fold (the
 * trust gate). Each verify is a `gpg` subprocess. Measured on loom's real
 * 919-record log: fold 16.4 s, of which `gpg` spawns are 894 calls / 14.8 s
 * (90% of the fold). Decomposed further, a full shared-homedir detached
 * verify costs 7.71 ms while a bare `gpg --version` — which performs no
 * verification at all — costs 8.33 ms on the same host. The cryptographic
 * work is therefore ~0 and essentially ALL of the cost is process creation
 * plus gpg startup. Removing the spawn IS the fix; making the crypto faster
 * is not, because the crypto was never the cost.
 *
 * Options that were measured and REFUTED before this module was written:
 *   - Batching: `gpg --multifile --verify` exits 2 ("no signed data") on
 *     detached signatures. A single-file control in the same homedir exits 0
 *     with one VALIDSIG, so that is gpg's behaviour, not a broken keyring.
 *   - Intra-fold memoisation: all 919 records hash distinct, so a
 *     content-keyed memo inside one fold saves exactly 0 verifies.
 *   - A persistent agent: the fold ALREADY shares one homedir and one
 *     gpg-agent (F17), and the 7.71 ms above was measured THROUGH it.
 *
 * SAFETY MODEL — why a parser bug here cannot forge an acceptance
 * ---------------------------------------------------------------
 * This module does NOT reimplement a cryptographic primitive. The RSA
 * PKCS#1 v1.5 verification is `crypto.verify`, i.e. OpenSSL. That is NOT the
 * same library gpg uses — GnuPG's primitive is libgcrypt — so this is two
 * independent implementations of one standard, not one implementation reused.
 * The claim being made is only that the primitive is a mature, widely-audited
 * library rather than hand-rolled here. What IS implemented here is envelope
 * parsing (ASCII armor, OpenPGP packet framing), the RFC 4880 §5.2.4 digest
 * BINDING, and the §5.2.3.1 critical-subpacket fence.
 *
 * The contract is deliberately asymmetric:
 *
 *   supported:true, valid:true   ONLY when every field was recognised, the
 *                                key fingerprint bound, and OpenSSL returned
 *                                true. The caller may short-circuit.
 *   supported:false              EVERYTHING else — unparseable, unsupported
 *                                algorithm, fingerprint mismatch, AND a
 *                                `crypto.verify` that returned false.
 *
 * A `false` from OpenSSL is reported as UNSUPPORTED, never as INVALID. So a
 * bug in this parser that computes the wrong digest costs one `gpg` spawn and
 * yields gpg's verdict; it can never deny an honest write. The only way to
 * wrongly ACCEPT is to verify a genuine signature over the WRONG bytes — the
 * single invariant the mutation tests pin directly.
 *
 * SCOPE — what a green from this module covers, and what it EXCLUDES
 * ------------------------------------------------------------------
 * Short-circuits ONLY: v4 signature packet, type 0x00 (binary), pubkey
 * algorithm 1 (RSA), hash algorithm 8 (SHA-256), over a v4 RSA public-key
 * packet. Measured against loom's log, 892/892 gpg-signed records are
 * exactly that shape. Every other shape — Ed25519, ECDSA, SHA-512, v3, v6,
 * multiple signature packets, cleartext framing — returns supported:false
 * and is answered by gpg, unchanged.
 *
 * SIGNATURE-level policy IS enforced, via `subpacketSkipBlocker`: any
 * critical subpacket, and any signature carrying an expiration time, routes
 * to gpg rather than being silently ignored.
 *
 * It does NOT evaluate key expiry, revocation, or the web of trust. Those
 * are KEY-level policy facts this module cannot see. The caller pairs it
 * with a per-process, per-fingerprint CANARY: the fast path is armed for a
 * fingerprint only after `gpg` itself returned valid for that fingerprint in
 * this process (see coc-sign.js).
 *
 * WHAT THE CANARY ACTUALLY BUYS — measured, because the first version of this
 * comment asserted a fail-closed property that turned out not to exist.
 * The claim was "a key gpg refuses never arms the canary". Measured 2026-08-21
 * against gpg on this host, with purpose-built revoked and expired test keys:
 *
 *   revoked key  → status `REVKEYSIG`, VALIDSIG present, **exit 0**
 *   expired key  → status `EXPKEYSIG`, VALIDSIG present, **exit 0**
 *
 * and `_verifyGpgViaSubprocess` — which gates on exit status plus an equality
 * match on a VALIDSIG fingerprint field — returns `{ok:true, valid:true}` for
 * BOTH. So gpg does not refuse those keys here, and the canary arms for them
 * exactly as it would for a healthy key.
 *
 * The honest statement is therefore PARITY, not fail-closed: the canary
 * reproduces whatever verdict the existing slow path reaches, and this change
 * neither tightens nor loosens key-level policy. That the slow path accepts
 * revoked and expired keys at all is a PRE-EXISTING gap in the substrate,
 * unchanged by this module and out of its scope to fix — closing it would
 * alter which records fold-accept and needs its own design.
 */

"use strict";

const crypto = require("crypto");

// Algorithm identifiers this module is willing to short-circuit. Anything
// outside these constants falls through to gpg — the allowlist is the fence.
const SIG_VERSION_V4 = 4;
const SIG_TYPE_BINARY = 0x00;
const PUBKEY_ALGO_RSA = 1;
const HASH_ALGO_SHA256 = 8;
const PACKET_TAG_SIGNATURE = 2;
const PACKET_TAG_PUBLIC_KEY = 6;

/** Uniform "gpg answers this one" result. Never carries valid:false. */
function unsupported(reason) {
  return { supported: false, reason };
}

/**
 * Strip ASCII armor to the raw packet bytes.
 *
 * Armor layout (RFC 4880 §6.2): a BEGIN line, optional `Key: value` headers,
 * ONE blank line, the base64 body, an optional `=CRC` line, an END line. The
 * blank line is what separates headers from body; without honouring it the
 * headers would be fed to the base64 decoder.
 *
 * The CRC24 is NOT checked: it is a transmission checksum, not an integrity
 * control, and a corrupted body simply fails to parse or fails to verify —
 * both of which route to gpg.
 */
function dearmor(text) {
  if (typeof text !== "string" || text.indexOf("-----BEGIN") === -1) return null;
  const lines = text.split(/\r?\n/);
  const body = [];
  let inArmor = false;
  let pastHeaders = false;
  for (const line of lines) {
    if (!inArmor) {
      if (line.startsWith("-----BEGIN")) inArmor = true;
      continue;
    }
    if (line.startsWith("-----END")) break;
    if (!pastHeaders) {
      // headers run until the first blank line
      if (line.trim() === "") pastHeaders = true;
      continue;
    }
    if (line.startsWith("=")) break; // CRC24 trailer
    const t = line.trim();
    if (t) body.push(t);
  }
  if (!inArmor || body.length === 0) return null;
  try {
    return Buffer.from(body.join(""), "base64");
  } catch {
    return null;
  }
}

/**
 * Split a packet stream into {tag, body} records (RFC 4880 §4.2).
 *
 * Supports both the old-format and new-format headers with definite lengths.
 * Partial/indeterminate lengths return null (→ gpg): they do not occur in
 * detached signatures or transferable public keys, and guessing at them is
 * exactly the kind of parser surface this module refuses to grow.
 */
function parsePackets(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 2) return null;
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const c = buf[i];
    if ((c & 0x80) === 0) return null; // not a packet header
    let tag;
    let headerLen;
    let bodyLen;
    if (c & 0x40) {
      // new format
      tag = c & 0x3f;
      if (i + 1 >= buf.length) return null;
      const o = buf[i + 1];
      if (o < 192) {
        bodyLen = o;
        headerLen = 2;
      } else if (o < 224) {
        if (i + 2 >= buf.length) return null;
        bodyLen = ((o - 192) << 8) + buf[i + 2] + 192;
        headerLen = 3;
      } else if (o === 255) {
        if (i + 5 >= buf.length) return null;
        bodyLen = buf.readUInt32BE(i + 2);
        headerLen = 6;
      } else {
        return null; // partial body length
      }
    } else {
      // old format
      tag = (c & 0x3c) >> 2;
      const lenType = c & 0x03;
      if (lenType === 0) {
        if (i + 1 >= buf.length) return null;
        bodyLen = buf[i + 1];
        headerLen = 2;
      } else if (lenType === 1) {
        if (i + 2 >= buf.length) return null;
        bodyLen = buf.readUInt16BE(i + 1);
        headerLen = 3;
      } else if (lenType === 2) {
        if (i + 4 >= buf.length) return null;
        bodyLen = buf.readUInt32BE(i + 1);
        headerLen = 5;
      } else {
        return null; // indeterminate length
      }
    }
    const start = i + headerLen;
    const end = start + bodyLen;
    if (end > buf.length) return null; // truncated — refuse rather than guess
    out.push({ tag, body: buf.subarray(start, end), bodyLen });
    i = end;
  }
  return out.length > 0 ? out : null;
}

/** DER length prefix for a payload of `n` bytes. */
function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTLV(tag, payload) {
  return Buffer.concat([Buffer.from([tag]), derLen(payload.length), payload]);
}

/** DER INTEGER from an unsigned big-endian buffer (adds the 0x00 sign pad). */
function derInteger(be) {
  let b = be;
  let k = 0;
  while (k < b.length - 1 && b[k] === 0) k++; // strip leading zeros
  b = b.subarray(k);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]);
  return derTLV(0x02, b);
}

// AlgorithmIdentifier for rsaEncryption (1.2.840.113549.1.1.1) + NULL params.
const RSA_ALG_ID = Buffer.from([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  0x05, 0x00,
]);

// Signature subpacket types this module understands well enough to ignore
// safely. Type 2 = signature creation time, 20 = notation data, 33 = issuer
// fingerprint. Measured over loom's 892 gpg-signed records: exactly these
// three appear in the hashed area, and NONE carries the critical bit.
const SUBPKT_SIG_EXPIRATION_TIME = 3;

/**
 * Walk the hashed subpacket area and decide whether this module is entitled
 * to skip gpg for this signature.
 *
 * This exists because a signature carries POLICY, not just a digest, and a
 * verifier that reads only the digest silently drops that policy. Two cases
 * matter and neither is visible to `crypto.verify`:
 *
 *   - **Signature expiration time** (type 3). GnuPG treats an EXPIRED
 *     SIGNATURE as an error — unlike an expired KEY. Ignoring it would let a
 *     rostered key-holder emit a record that peers fold-accept while an
 *     auditor running `gpg --verify` calls it invalid: a repudiation
 *     primitive against exactly the non-repudiation property a signed
 *     coordination log exists to provide.
 *   - **The critical bit** (RFC 4880 §5.2.3.1). A critical subpacket the
 *     implementation does not recognise MUST cause rejection. This module
 *     recognises none of them, so ANY critical subpacket routes to gpg.
 *
 * Returns null when the area is fine to skip, or a reason string otherwise.
 * A malformed walk also returns a reason — the fence is "understood or gpg",
 * never "unparsed therefore fine".
 */
function subpacketSkipBlocker(sb, start, end) {
  let i = start;
  while (i < end) {
    const o = sb[i];
    let len;
    let hdr;
    if (o === undefined) return "subpacket area truncated";
    if (o < 192) {
      len = o;
      hdr = 1;
    } else if (o < 255) {
      if (i + 1 >= end) return "2-octet subpacket length truncated";
      len = ((o - 192) << 8) + sb[i + 1] + 192;
      hdr = 2;
    } else {
      if (i + 5 > end) return "5-octet subpacket length truncated";
      len = sb.readUInt32BE(i + 1);
      hdr = 5;
    }
    if (len < 1) return "zero-length subpacket";
    const typeOff = i + hdr;
    if (typeOff >= end) return "subpacket type byte past area";
    const typeByte = sb[typeOff];
    const critical = (typeByte & 0x80) !== 0;
    const type = typeByte & 0x7f;

    // RFC 4880 §5.2.3.1 — an unrecognised CRITICAL subpacket must reject.
    // This module recognises none, so every critical subpacket goes to gpg.
    if (critical) return `critical subpacket type ${type} not understood`;
    if (type === SUBPKT_SIG_EXPIRATION_TIME) {
      return "signature carries an expiration time; gpg must adjudicate it";
    }

    i = typeOff + len; // len counts the type byte + body
    if (i > end) return "subpacket overruns the hashed area";
  }
  return i === end ? null : "subpacket walk did not land on the area boundary";
}

/** Read one OpenPGP MPI at `off`; returns {value, next} or null. */
function readMPI(body, off) {
  if (off + 2 > body.length) return null;
  const bits = body.readUInt16BE(off);
  const nbytes = (bits + 7) >> 3;
  const start = off + 2;
  const end = start + nbytes;
  if (end > body.length) return null;
  return { value: body.subarray(start, end), next: end };
}

/**
 * Build an OpenSSL public KeyObject from a v4 RSA public-key packet.
 * Returns {keyObject, fingerprint} or null.
 *
 * The fingerprint is RFC 4880 §12.2: SHA-1 over 0x99 || uint16be(len) ||
 * packet body. It is computed here — not taken from the roster — so that the
 * identity bind below compares a fingerprint DERIVED FROM THE KEY MATERIAL
 * actually used for verification against the one the caller expected.
 */
function rsaKeyFromPublicKeyPacket(pkt) {
  const body = pkt.body;
  if (body.length < 6) return null;
  if (body[0] !== 4) return null; // v4 only
  if (body[5] !== PUBKEY_ALGO_RSA) return null;
  const n = readMPI(body, 6);
  if (!n) return null;
  const e = readMPI(body, n.next);
  if (!e) return null;

  const rsaPublicKey = derTLV(
    0x30,
    Buffer.concat([derInteger(n.value), derInteger(e.value)]),
  );
  const spki = derTLV(
    0x30,
    Buffer.concat([
      RSA_ALG_ID,
      derTLV(0x03, Buffer.concat([Buffer.from([0x00]), rsaPublicKey])),
    ]),
  );

  let keyObject;
  try {
    keyObject = crypto.createPublicKey({
      key: spki,
      format: "der",
      type: "spki",
    });
  } catch {
    return null;
  }

  const lenBE = Buffer.alloc(2);
  lenBE.writeUInt16BE(pkt.bodyLen);
  const fingerprint = crypto
    .createHash("sha1")
    .update(Buffer.concat([Buffer.from([0x99]), lenBE, body]))
    .digest("hex")
    .toUpperCase();

  // Modulus byte length. OpenPGP MPI encoding is minimal-length (leading zero
  // bytes are stripped), but OpenSSL's RSA verify requires a signature buffer
  // of EXACTLY modulus length, so the caller must re-pad. Measured on loom's
  // log: 2 of 892 signatures carry a 511-byte MPI against a 512-byte modulus
  // (~1/256 of signatures, as expected), and both failed to verify in-process
  // while gpg accepted them. Returning this length is what lets the caller
  // close that gap rather than fall through on it forever.
  const modulusBytes = n.value.length;

  return { keyObject, fingerprint, modulusBytes };
}

/**
 * Left-pad an OpenPGP MPI to a fixed byte width for OpenSSL.
 * Returns null when the value is LONGER than the modulus — that is a
 * malformed signature, not something to truncate into shape.
 */
function padToModulus(mpi, modulusBytes) {
  if (mpi.length === modulusBytes) return mpi;
  if (mpi.length > modulusBytes) return null;
  const out = Buffer.alloc(modulusBytes);
  mpi.copy(out, modulusBytes - mpi.length);
  return out;
}

/**
 * THE canonical fingerprint normalization for the whole signing stack.
 *
 * It lives HERE, and `coc-sign.js` delegates to it, because coc-sign already
 * requires this module — the reverse would be a cycle. There were FIVE
 * implementations of this rule; they agreed for every live input, which is
 * exactly the condition under which the next copy is the one that drifts — and
 * the fifth, in `lib/state-file-write-guard.js`, DID: it kept `String(v)` when
 * this one hardened to `""`, so the two disagreed for every non-string and
 * agreed for every string. Measured at 7 divergent cases out of 12, all of them
 * `typeof !== "string"`, and inert only because both of its call sites are
 * type-gated. It now delegates here. This module's own header argues the point
 * about key material; it applies to the identity string just as much.
 *
 * A NON-STRING NORMALIZES TO "", not to its `String()` form. `String(v || "")`
 * turned `12345678901234567890` into a twenty-character "fingerprint" that would
 * clear a length floor; a fingerprint that was never a string is absent, and
 * absent is "".
 */
function normalizeFpr(v) {
  if (typeof v !== "string") return "";
  return v.toUpperCase().replace(/\s+/g, "");
}

/**
 * The fingerprint of the FIRST public-key packet of the FIRST armor block,
 * derived from that packet's own bytes.
 *
 * THE PRECISION MATTERS because this result routes BLOCK versus EXCUSE. Given two
 * CONCATENATED armor blocks this reads only the first, while `gpg --import`
 * processes BOTH — so the two disagree about what "this key material" means. Not
 * reachable today: `signed-log.js` sources `pubkey` only from the injected
 * resolver, never from a record, so attacker-controlled armor cannot arrive here.
 * Stated because the docblock previously said "an armored public key", which
 * reads as though the whole input were considered.
 *
 * Exported because a caller needs to answer a question the status line alone
 * cannot: when a `VALIDSIG` names a fingerprint that is not the expected one,
 * is that a DIFFERENT KEY (impersonation) or the SAME key under a mis-transcribed
 * roster entry (a configuration defect)? Those two send an operator to opposite
 * places, and the only thing that separates them is what the supplied key
 * material ACTUALLY hashes to.
 *
 * Returns "" when the key is not a v4 RSA primary — this parser's scope — so a
 * caller MUST treat "" as "cannot tell" and never as "does not match".
 */
function fingerprintFromArmoredKey(pubKeyArmored) {
  try {
    const keyBytes = dearmor(pubKeyArmored);
    if (!keyBytes) return "";
    const pkts = parsePackets(keyBytes);
    if (!pkts) return "";
    const primary = pkts.find((p) => p.tag === PACKET_TAG_PUBLIC_KEY);
    if (!primary) return "";
    const parsed = rsaKeyFromPublicKeyPacket(primary);
    return parsed && parsed.fingerprint ? normalizeFpr(parsed.fingerprint) : "";
  } catch {
    // A key this parser cannot read is "cannot tell", never "does not match".
    return "";
  }
}

/**
 * Attempt in-process verification of a detached OpenPGP signature.
 *
 * @param {Buffer|string} content - the exact bytes that were signed
 * @param {string} sigArmored - armored detached signature
 * @param {string} pubKeyArmored - armored transferable public key
 * @param {string} [expectedFpr] - required signer fingerprint (identity bind)
 * @returns {{supported:true, valid:true} | {supported:false, reason:string}}
 *
 * NEVER throws. NEVER returns valid:false — see the safety model above.
 */
function tryVerifyDetached(content, sigArmored, pubKeyArmored, expectedFpr) {
  try {
    const data = Buffer.isBuffer(content)
      ? content
      : Buffer.from(String(content), "utf8");

    const sigBytes = dearmor(sigArmored);
    if (!sigBytes) return unsupported("signature is not ASCII-armored");
    const sigPackets = parsePackets(sigBytes);
    if (!sigPackets) return unsupported("signature packet stream unparseable");

    const sigPkts = sigPackets.filter((p) => p.tag === PACKET_TAG_SIGNATURE);
    // Exactly one signature. A multi-signature file has a per-signature
    // acceptance policy this module does not implement.
    if (sigPkts.length !== 1) {
      return unsupported(`expected 1 signature packet, got ${sigPkts.length}`);
    }
    const sb = sigPkts[0].body;
    if (sb.length < 8) return unsupported("signature packet truncated");

    if (sb[0] !== SIG_VERSION_V4) {
      return unsupported(`unsupported signature version ${sb[0]}`);
    }
    if (sb[1] !== SIG_TYPE_BINARY) {
      return unsupported(`unsupported signature type 0x${sb[1].toString(16)}`);
    }
    if (sb[2] !== PUBKEY_ALGO_RSA) {
      return unsupported(`unsupported pubkey algorithm ${sb[2]}`);
    }
    if (sb[3] !== HASH_ALGO_SHA256) {
      return unsupported(`unsupported hash algorithm ${sb[3]}`);
    }

    // Hashed subpacket area — this is the part of the signature's own
    // metadata that the digest covers, and therefore the part an attacker
    // cannot alter without invalidating the signature.
    const hashedLen = sb.readUInt16BE(4);
    const hashedEnd = 6 + hashedLen;
    if (hashedEnd > sb.length) return unsupported("hashed subpacket area overruns packet");

    // A signature carries POLICY as well as a digest. Skipping gpg is only
    // legitimate when this module has read that policy and found nothing it
    // does not understand.
    const blocker = subpacketSkipBlocker(sb, 6, hashedEnd);
    if (blocker) return unsupported(blocker);

    // Unhashed area follows; then the 2-byte left16 of the digest; then MPIs.
    if (hashedEnd + 2 > sb.length) return unsupported("unhashed length field missing");
    const unhashedLen = sb.readUInt16BE(hashedEnd);
    const afterUnhashed = hashedEnd + 2 + unhashedLen;
    if (afterUnhashed + 2 > sb.length) return unsupported("left16 field missing");
    const left16 = sb.subarray(afterUnhashed, afterUnhashed + 2);

    const sigMPI = readMPI(sb, afterUnhashed + 2);
    if (!sigMPI) return unsupported("signature MPI unreadable");

    // ---- RFC 4880 §5.2.4 digest construction ----
    // The digest covers: the signed DATA, then the signature packet's own
    // version/type/algorithms/hashed-subpacket area verbatim, then a trailer
    // of 0x04 0xff and the byte length of that second span. Omitting either
    // the data or the trailer yields a digest that verifies against nothing,
    // which routes to gpg rather than accepting.
    const sigTrailerSpan = sb.subarray(0, hashedEnd);
    const trailer = Buffer.alloc(6);
    trailer[0] = 0x04;
    trailer[1] = 0xff;
    trailer.writeUInt32BE(sigTrailerSpan.length, 2);

    // The exact byte span the signature was made over. `crypto.verify` below
    // hashes this span itself; `digest` is computed here only for the cheap
    // left16 pre-filter. Both read the SAME span, so they cannot disagree
    // about what was signed.
    const signedSpan = Buffer.concat([data, sigTrailerSpan, trailer]);
    const digest = crypto.createHash("sha256").update(signedSpan).digest();

    // Cheap pre-filter (RFC 4880 §5.2.3): the signature carries the top two
    // bytes of the digest. A mismatch means our digest is not the one that
    // was signed — hand it to gpg rather than calling it invalid.
    if (digest[0] !== left16[0] || digest[1] !== left16[1]) {
      return unsupported("digest left16 mismatch");
    }

    // ---- key material + identity bind ----
    const keyBytes = dearmor(pubKeyArmored);
    if (!keyBytes) return unsupported("public key is not ASCII-armored");
    const keyPackets = parsePackets(keyBytes);
    if (!keyPackets) return unsupported("public key packet stream unparseable");
    const primary = keyPackets.find((p) => p.tag === PACKET_TAG_PUBLIC_KEY);
    if (!primary) return unsupported("no primary public-key packet");

    const parsed = rsaKeyFromPublicKeyPacket(primary);
    if (!parsed) return unsupported("primary key is not a v4 RSA key");

    // Bind the verification to the EXPECTED signer. Without this a shared
    // multi-key keyring would accept a record signed by any rostered key.
    // Here the key material is supplied per-call, so the bind is structural;
    // the explicit compare additionally catches a roster whose recorded
    // fingerprint does not match the key bytes stored beside it.
    // MANDATORY, not conditional. An earlier revision guarded this with
    // `if (want && …)`, so a whitespace-only expectedFpr skipped the compare
    // entirely and the module verified against whatever key it was handed.
    // There is no correct reason to run this path without an identity bind:
    // absent one, the caller gets gpg.
    const want = normalizeFpr(expectedFpr);
    if (!want) {
      return unsupported("no expectedFpr supplied; identity bind unavailable");
    }
    if (want !== parsed.fingerprint) {
      return unsupported(
        `key fingerprint ${parsed.fingerprint.slice(0, 16)}… does not match expected ${want.slice(0, 16)}…`,
      );
    }

    // ---- the primitive: OpenSSL, not a reimplementation ----
    // RSA + SHA-256 PKCS#1 v1.5. `crypto.verify(alg, data, key, sig)` hashes
    // `data` with `alg` and performs the EMSA-PKCS1-v1_5 check OpenPGP
    // specifies. `signedSpan` — not `digest` — is the input: passing the
    // pre-computed digest here would hash it a second time and never verify.
    const sigBuf = padToModulus(sigMPI.value, parsed.modulusBytes);
    if (!sigBuf) {
      return unsupported(
        `signature MPI (${sigMPI.value.length} B) exceeds modulus (${parsed.modulusBytes} B)`,
      );
    }

    let ok;
    try {
      ok = crypto.verify(
        "sha256",
        signedSpan,
        {
          key: parsed.keyObject,
          padding: crypto.constants.RSA_PKCS1_PADDING,
        },
        sigBuf,
      );
    } catch (err) {
      return unsupported(
        `crypto.verify threw: ${err && err.message ? err.message : String(err)}`,
      );
    }

    if (ok !== true) {
      // NOT reported as invalid. gpg gets the final word — see safety model.
      return unsupported("in-process verify did not confirm; deferring to gpg");
    }
    return { supported: true, valid: true };
  } catch (err) {
    return unsupported(
      `unexpected error: ${err && err.message ? err.message : String(err)}`,
    );
  }
}

module.exports = {
  tryVerifyDetached,
  // THE shared normalizer — see its docblock for why it lives here.
  normalizeFpr,
  // Derives a fingerprint from key material, for callers that must separate
  // "a different key signed" from "the same key, mis-transcribed in the roster".
  fingerprintFromArmoredKey,
  // exported for tests
  _internals: {
    dearmor,
    parsePackets,
    rsaKeyFromPublicKeyPacket,
    padToModulus,
    subpacketSkipBlocker,
  },
};
