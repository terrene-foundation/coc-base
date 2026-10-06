"use strict";

/**
 * ssh-pubkey-fingerprint.js — compute what `ssh-keygen -lf <file.pub>` prints as
 * the SHA256 fingerprint, IN-PROCESS, for the key shapes where the answer is
 * provably identical; defer (return null) for everything else.
 *
 * WHY (perf/hook-cost). operator-id.js::resolveIdentity derives the operator's
 * verified_id by spawning `ssh-keygen -lf` on EVERY call, and resolveIdentity
 * runs in most PreToolUse hooks on every tool call (heartbeat, provenance,
 * posture-gate, operator-gate, ...). The fingerprint is a pure function of the
 * public-key BYTES: OpenSSH's SHA256 fingerprint is
 *     "SHA256:" + base64_nopad(sha256(decoded key blob))
 * (sshkey_fingerprint_raw + sshkey_fingerprint, SSH_FP_BASE64 with trailing '='
 * stripped). Nothing about the key material, the roster lookup or the authority
 * derivation changes — the same bytes produce the same verified_id, one process
 * earlier.
 *
 * EXACTNESS CONTRACT — answer ONLY when ssh-keygen would load the key and print
 * this fingerprint; otherwise return null and the caller spawns ssh-keygen as
 * before. Answered shapes:
 *   - every byte of the file is TAB, LF, CR or 0x20-0x7E (anything else defers);
 *   - the file holds exactly ONE non-blank, non-comment line `<type> <b64> [comment]`,
 *     blank meaning /^[ \t\r]*$/, with only a leading [ \t] run and a trailing CR
 *     stripped;
 *   - `<b64>` is canonical base64 (round-trips byte-exact);
 *   - `<type>` is `ssh-ed25519` (blob = string type ‖ string 32-byte key, nothing
 *     trailing) or `ssh-rsa` (blob = string type ‖ mpint e ‖ mpint n, nothing
 *     trailing, 1024 ≤ n ≤ 16384 bits — OpenSSH refuses shorter RSA keys on load and
 *     larger moduli exceed its SSHBUF_MAX_BIGNUM);
 *   - the type string inside the blob equals the leading `<type>` token.
 * ECDSA / SK / DSA / certificates defer: ssh-keygen validates the ECDSA point on
 * the curve and treats certificates differently, which this module does not
 * re-implement.
 *
 * NO TOP-LEVEL SIDE EFFECTS.
 */

const crypto = require("crypto");
const fs = require("fs");

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

function _reader(buf) {
  let off = 0;
  return {
    str() {
      if (off + 4 > buf.length) return null;
      const n = buf.readUInt32BE(off);
      off += 4;
      if (off + n > buf.length) return null;
      const s = buf.subarray(off, off + n);
      off += n;
      return s;
    },
    done() {
      return off === buf.length;
    },
  };
}

function _mpintBits(b) {
  // SSH mpint: two's complement, big-endian, minimal (a leading 0x00 only when
  // the next byte's high bit is set). Reject negative / non-minimal encodings.
  if (!b || b.length === 0) return 0;
  if (b[0] & 0x80) return -1;
  let i = 0;
  if (b[0] === 0) {
    if (b.length === 1 || !(b[1] & 0x80)) return -1;
    i = 1;
  }
  const lead = b[i];
  let bits = (b.length - i - 1) * 8;
  for (let v = lead; v; v >>= 1) bits++;
  return bits;
}

/**
 * Fingerprint an OpenSSH public-key line.
 * @param {string} text  file contents
 * @returns {string|null} "SHA256:<b64-nopad>" or null ⇒ defer to ssh-keygen
 */
function fingerprintFromPubText(text) {
  if (typeof text !== "string") return null;
  // F1 (security review): ssh-keygen's line reader is ASCII-strict. It refuses a
  // leading BOM, VT, FF, NBSP, CR or U+2028, a trailing NBSP or U+2028 after the
  // base64, and more. `.trim()` strips ALL Unicode whitespace, so the old code
  // answered for files ssh-keygen rejects, turning a fail-closed "identity
  // unresolved" into a verified_id. So: ANY byte outside TAB, LF, CR and
  // 0x20-0x7E defers the whole file to ssh-keygen. Only a leading [ \t] run and a
  // trailing \r are stripped, a line is blank only when it is /^[ \t\r]*$/, and a
  // CR anywhere else in a line defers.
  if (/[^\t\n\r\x20-\x7e]/.test(text)) return null;
  const lines = text
    .split("\n")
    .filter((l) => !/^[ \t\r]*$/.test(l))
    .map((l) => l.replace(/\r$/, "").replace(/^[ \t]+/, ""));
  if (lines.some((l) => l.includes("\r"))) return null;
  // Exactly one line and no comments: a multi-key or annotated file is a shape
  // ssh-keygen handles with its own rules, so it defers rather than guess.
  if (lines.length !== 1 || lines[0].startsWith("#")) return null;
  const parts = lines[0].split(/[ \t]+/);
  if (parts.length < 2) return null;
  const [type, b64] = parts;
  if (!B64.test(b64)) return null;
  const blob = Buffer.from(b64, "base64");
  if (blob.toString("base64") !== b64) return null;
  const r = _reader(blob);
  const t = r.str();
  if (!t || t.toString("latin1") !== type) return null;
  if (type === "ssh-ed25519") {
    const k = r.str();
    if (!k || k.length !== 32 || !r.done()) return null;
  } else if (type === "ssh-rsa") {
    const e = r.str();
    const n = r.str();
    if (!e || !n || !r.done()) return null;
    if (_mpintBits(e) <= 0) return null;
    if (_mpintBits(n) < 1024) return null;
    // F1: OpenSSH refuses RSA moduli above SSHBUF_MAX_BIGNUM (16384 bits).
    if (_mpintBits(n) > 16384) return null;
  } else {
    return null;
  }
  const digest = crypto.createHash("sha256").update(blob).digest("base64");
  return "SHA256:" + digest.replace(/=+$/, "");
}

/**
 * Fingerprint a public-key FILE. Reads only regular files; anything else defers.
 * @param {string} file
 * @returns {string|null}
 */
function fingerprintFromPubFile(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 64 * 1024) return null;
    return fingerprintFromPubText(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

module.exports = { fingerprintFromPubText, fingerprintFromPubFile };
