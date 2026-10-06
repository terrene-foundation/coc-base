/**
 * identity-scrub.mjs — shared identity-EXTRACTION machinery for the two
 * disclosure fences that must agree on "what counts as canon identity":
 *
 *   1. scripts/publish-to-public.mjs  — the canon→PUBLIC-fork scrub+gate.
 *   2. .claude/bin/clean-instantiate.mjs — the CLIENT-clone CLEAR ceremony
 *      (MO-OPT W2): a client cloning/templating canon to instantiate its OWN
 *      ecosystem MUST carry ZERO canon operator/trust identity. Its fail-closed
 *      assert-zero gate is `deriveDynamicTokens(clientCloneRoot).gate` — the SAME
 *      runtime-extraction machinery the publish gate's DYNAMIC half uses, so the
 *      two fences' dynamic gate CANNOT DRIFT (one shared function).
 *
 * The dynamic gate covers the canon owner's name + email too: harvestPgpUid
 * base64-decodes the roster's PGP UID packet, and separator-variant derivation
 * (below) emits the dotted/hyphenated/concatenated forms — so the gate is
 * machine-complete for a GPG-rostered owner WITHOUT any literal canon token in
 * this file. The publish fence ADDITIONALLY unions a small hand-maintained
 * EXTRA_IDENTITY_TOKENS static list (in the LOOM-ONLY scripts/publish-to-public.mjs)
 * for any residual a future SSH-key roster cannot derive. That static list is
 * DELIBERATELY publish-only: relocating it INTO this module would ship literal
 * canon identity to every synced consumer + the public fork — the exact leak the
 * "ZERO identity" guarantee below prevents (MO-OPT holistic redteam MO-R1-H2 —
 * honesty over a false "exact token set" claim).
 *
 * This module contains ZERO identity itself — it is identity-free machinery that
 * EXTRACTS identity from a repo's `operators.roster.json` + tenant denylist at
 * RUNTIME. It is therefore safe to SYNC + PUBLISH (`.claude/bin/**`): a consumer
 * receiving it sees only the extraction logic, never a literal canon token.
 *
 * deriveDynamicTokens(repoDir) returns { scrub, gate, unhonoured }:
 *   - gate  : the flat token list the fail-closed disclosure gate greps for.
 *   - scrub : [from, to] genericization pairs (publish uses these to rewrite;
 *             the ceremony does not rewrite — it DELETES/RESETS the carriers —
 *             but the pairs are returned for parity with the publish fence).
 *
 * `assertNoSymlinkEscape` (moved here 2026-07-10, F7 redteam fix) is the
 * FAIL-CLOSED symlink-escape guard both fences share alongside `walkFiles` —
 * it was originally defined in scripts/publish-to-public.mjs, but
 * `.claude/bin/clean-instantiate.mjs::performClear` step (g) DELETES that file
 * from a client clone (canon-only publish tooling), so a static import of the
 * guard from there crashed every re-run after the first successful --apply
 * (ERR_MODULE_NOT_FOUND). identity-scrub.mjs is never deleted by the ceremony
 * (clean-instantiate imports `deriveDynamicTokens`/`walkFiles` from it to run
 * at all), so it is the guard's correct, survives-self-delete home.
 * publish-to-public.mjs now imports + re-exports it for backward-compatible
 * callers (edition-emit.mjs imports it from publish-to-public.mjs unchanged).
 *
 * Extracted from publish-to-public.mjs (the pre-W2 single source) per MO-OPT
 * W2-0 (workspaces/multi-operator-optional). The ADO `principal` (Entra UPN)
 * harvest is NEW here — the pre-W2 deriveDynamicTokens did NOT extract it, so an
 * azure-devops-provider roster's owner identity would have slipped both fences.
 *
 * Node ESM, zero dependencies.
 */
import {
  readdirSync, statSync, lstatSync, realpathSync, openSync, fstatSync, readSync, closeSync, constants as FS,
} from "node:fs";
import path from "node:path";

/**
 * The typed refusal of `readRegularFileNoFollow` / `readTextOrNull`. `code` is always
 * `ERR_UNSAFE_FILE_READ`; `kind` names WHAT was refused; `label` names the file by the
 * caller's ROLE label or its BASENAME — never by absolute path (which carries
 * `/Users/<operator>/`), and never with any of its bytes.
 *
 *   kind: "absent" | "symlink" | "fifo" | "socket" | "directory" | "char-device" |
 *         "block-device" | "not-regular" | "oversize" | "swapped" | "unreadable"
 */
export class UnsafeFileReadError extends Error {
  constructor(label, kind, detail) {
    super(`${label}: refusing to read — ${detail}`);
    this.name = "UnsafeFileReadError";
    this.code = "ERR_UNSAFE_FILE_READ";
    this.kind = kind;
    this.label = label;
  }
}

/** The file-type kind of a Stats object, for refusal text. */
function statKind(st) {
  if (st.isSymbolicLink()) return "symlink";
  if (st.isFIFO()) return "fifo";
  if (st.isSocket()) return "socket";
  if (st.isDirectory()) return "directory";
  if (st.isCharacterDevice()) return "char-device";
  if (st.isBlockDevice()) return "block-device";
  return st.isFile() ? "file" : "not-regular";
}

const O_NOFOLLOW = typeof FS.O_NOFOLLOW === "number" ? FS.O_NOFOLLOW : 0;
const O_NONBLOCK = typeof FS.O_NONBLOCK === "number" ? FS.O_NONBLOCK : 0;

/** Default size cap: far above any roster / denylist / trust root, far below a memory hazard. */
export const READ_REGULAR_FILE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Open `p` and read it ONLY IF it is a regular file, deciding that from the OPENED descriptor
 * rather than from a path lookup made before the open.
 *
 * WHY. `existsSync` + `readFileSync` follows a symlink (an attacker-shaped tree could point
 * `.claude/operators.roster.json` at any file on the operator's machine and have it parsed as
 * identity), blocks forever on a FIFO (measured: a FIFO roster hung the derive until killed), and
 * an `lstat`-then-read check is a RACE — the name can be re-pointed between the check and the read.
 * Here the kernel does the check at open time:
 *   - `O_NOFOLLOW` makes the open FAIL (ELOOP) when the final component is a symlink;
 *   - `O_NONBLOCK` makes opening a FIFO return at once instead of waiting for a writer;
 *   - `fstat` on the descriptor then reports what was ACTUALLY opened, so nothing can be swapped
 *     in afterwards — the bytes read are the bytes of the thing that was checked.
 *
 * PLATFORM. `O_NOFOLLOW` is defined on darwin and linux. Where it is absent (win32), the read is
 * made race-EVIDENT instead: `lstat` must report a regular file, and after `open` the descriptor's
 * `fstat` must name the SAME `dev`+`ino` — a swap between the two raises `kind:"swapped"`. It fails
 * closed on every mismatch; it does not silently degrade to a following read.
 *
 * Only the FINAL component is protected from links: a symlinked PARENT directory is resolved
 * normally (callers that must contain a whole path resolve it with `realpathSync` first).
 *
 * @param {string} p                     path to read
 * @param {object} [opts]
 * @param {number} [opts.maxBytes]       refuse (kind "oversize") above this many bytes
 * @param {string} [opts.label]          role name for messages; defaults to the basename
 * @param {boolean} [opts.allowAbsent]   return null instead of throwing when nothing is at `p`
 * @param {BufferEncoding|null} [opts.encoding]  "utf8" (default) → string; null → Buffer
 * @param {boolean} [opts.forceLstatFallback]  TEST SEAM: take the no-O_NOFOLLOW path on any OS
 * @returns {string|Buffer|null}
 * @throws {UnsafeFileReadError}
 */
export function readRegularFileNoFollow(p, {
  maxBytes = READ_REGULAR_FILE_MAX_BYTES, label, allowAbsent = false, encoding = "utf8", forceLstatFallback = false,
} = {}) {
  const name = label || path.basename(String(p));
  const noFollow = forceLstatFallback ? 0 : O_NOFOLLOW;
  let pre = null;
  if (!noFollow) {
    try { pre = lstatSync(p, { bigint: true }); } catch (e) {
      if (e && e.code === "ENOENT" && allowAbsent) return null;
      throw new UnsafeFileReadError(name, e && e.code === "ENOENT" ? "absent" : "unreadable", `cannot stat it (${(e && e.code) || "error"})`);
    }
    const k = statKind(pre);
    if (k !== "file") throw new UnsafeFileReadError(name, k, `it is a ${k}, not a regular file`);
  }
  let fd;
  try {
    fd = openSync(p, FS.O_RDONLY | noFollow | O_NONBLOCK);
  } catch (e) {
    const c = e && e.code;
    if (c === "ENOENT" && allowAbsent) return null;
    // ELOOP (linux, darwin) / EMLINK (some BSDs) is how O_NOFOLLOW reports a final-component link.
    if (noFollow && (c === "ELOOP" || c === "EMLINK")) throw new UnsafeFileReadError(name, "symlink", "it is a symlink, not a regular file");
    if (c === "EISDIR") throw new UnsafeFileReadError(name, "directory", "it is a directory, not a regular file");
    throw new UnsafeFileReadError(name, c === "ENOENT" ? "absent" : "unreadable", `cannot open it (${c || "error"})`);
  }
  try {
    const st = fstatSync(fd, { bigint: true });
    const k = statKind(st);
    if (k !== "file") throw new UnsafeFileReadError(name, k, `it is a ${k}, not a regular file`);
    if (pre && (pre.dev !== st.dev || pre.ino !== st.ino)) {
      throw new UnsafeFileReadError(name, "swapped", "the path was replaced between the check and the open");
    }
    if (st.size > BigInt(maxBytes)) {
      throw new UnsafeFileReadError(name, "oversize", `it is ${st.size} bytes, above the ${maxBytes}-byte cap`);
    }
    // Read to EOF from the descriptor, never past the cap: a file that GROWS after the fstat is
    // refused rather than read unbounded.
    const chunks = [];
    let total = 0;
    const buf = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) throw new UnsafeFileReadError(name, "oversize", `it grew above the ${maxBytes}-byte cap while being read`);
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    const out = Buffer.concat(chunks, total);
    return encoding ? out.toString(encoding) : out;
  } finally {
    closeSync(fd);
  }
}

/**
 * Read a file as UTF-8 text, or null when it is binary (NUL-byte sniff over the
 * first 8 KiB). Every NON-binary file is therefore scrubbed + gated by DEFAULT
 * (fail-safe: unknown text extensions — .py, .csv, extensionless — are covered).
 * Redteam PR#438 closed the prior isText() extension-allowlist blind spot.
 *
 * NON-REGULAR FILES THROW, they do NOT return null. Every caller reads `null` as "binary → skip",
 * and at the publish gate a skip is a silent pass, so a FIFO/socket/device returning null would
 * be fail-OPEN. It is refused with `UnsafeFileReadError` (it used to HANG: `readFileSync` on a FIFO
 * waits for a writer forever — measured). A read that FAILS (absent, permission) and a DIRECTORY
 * still return null, as before.
 *
 * SYMLINKS ARE STILL FOLLOWED here, deliberately: these callers walk a tree that
 * `assertNoSymlinkEscape` has already vetted, and an in-tree link's target IS tree content the
 * scrub and the gate must see. What is checked is the OPENED descriptor, so a link to a FIFO is
 * refused like a FIFO. Config reads that must never follow a link use `readRegularFileNoFollow`.
 * No size cap: tree files are unbounded by design (the previous read had none either).
 */
export function readTextOrNull(f) {
  let fd;
  try { fd = openSync(f, FS.O_RDONLY | O_NONBLOCK); } catch {
    // A SOCKET cannot be opened at all (ENXIO / EOPNOTSUPP), so its kind is only visible to a stat
    // of the name. Without this it read as a failed read → `null` → "binary, skip" — the silent
    // pass the refusal below exists to prevent (measured: a socket returned null). A genuinely
    // failed read (absent, permission) still returns null.
    let st = null;
    try { st = statSync(f); } catch { /* absent / unstattable: a failed read */ }
    const k = st ? statKind(st) : "file";
    if (k !== "file" && k !== "directory") throw new UnsafeFileReadError(path.basename(String(f)), k, `it is a ${k}, not a regular file`);
    return null;
  }
  let buf;
  try {
    const k = statKind(fstatSync(fd));
    // A directory is not content and never blocks; it keeps its former `null` (EISDIR) result.
    if (k === "directory") return null;
    if (k !== "file") throw new UnsafeFileReadError(path.basename(String(f)), k, `it is a ${k}, not a regular file`);
    const chunks = [];
    const b = Buffer.allocUnsafe(64 * 1024);
    for (let n; (n = readSync(fd, b, 0, b.length, null)) > 0; ) chunks.push(Buffer.from(b.subarray(0, n)));
    buf = Buffer.concat(chunks);
  } catch (e) {
    if (e instanceof UnsafeFileReadError) throw e;
    return null;
  } finally {
    closeSync(fd);
  }
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return null; // binary → skip
  return buf.toString("utf8");
}

/**
 * Synthesize a same-length, same-case-class hex placeholder for a real
 * fingerprint, so a scrubbed fingerprint keeps its shape without carrying the
 * real bytes. (e.g. "DEADBEEFDEADBEEF…" truncated to the real length.)
 */
export function synthHex(real) {
  const p = "DEADBEEF";
  let s = "";
  for (let i = 0; i < real.length; i++) s += p[i % p.length];
  return real === real.toLowerCase() ? s.toLowerCase() : s;
}

/**
 * The scrub's REPLACEMENT vocabulary — every literal `to` value a `scrub.push([from, to])` in
 * this module writes, declared ONCE. Every push site below uses these constants, so the set a
 * scrub WRITES and the set `isScrubPlaceholderToken` RECOGNIZES are one list and cannot drift.
 *
 * Why it has to be recognizable: a carrier scrubbed IN PLACE (a NEUTRALIZE'd
 * `.claude/trust-root.json` whose signer `person_id` now reads `maintainer`) is later READ BACK
 * as an identity source by `scan-synced-disclosure.mjs::loadOperatorIdentityShape` and by
 * `clean-instantiate.mjs::snapshotCanonTokens`. Without this list the scanner harvested the
 * scrubber's own placeholder as an operator identity and flagged every file containing the
 * English word (measured: 219 findings on the client-template edition, 79 on a
 * clean-instantiate'd copy), while clean-instantiate exempted `maintainer` by its own literal —
 * two filters disagreeing about one vocabulary.
 *
 * The other replacement the scrub writes is `synthHex(real)` (fingerprints, root commits), an
 * UNBOUNDED family rather than a literal — see `isSynthHexStream`. NOT listed, because no
 * identity field ever holds them as a whole value: the computed `SHA256:<synthHex>…` prose
 * form, the cross-repo-receipt filename `<target>` rewrite, and the home-path `<user>` segment
 * (a path shape with its own scanner shape, never a harvested token). Placeholders are, by
 * construction, nobody's identity; this module still carries ZERO real identity.
 */
export const SCRUB_PLACEHOLDER = Object.freeze({
  EMAIL: "maintainer@example.com",
  LOGIN: "maintainer",
  DISPLAY_NAME: "Example Maintainer",
  NAME_VARIANT: "example-maintainer",
  HOST: "example-host",
  DOMAIN: "example.com", // a WHOLE declared domain — RFC 2606 reserved, so it names nobody. Written
  // by `harvestDomain`'s whole-domain substitution (`.claude/bin/lib/identity-scrub.mjs:476`), which
  // rewrites the domain ALONE, bounded, rather than an address: `EMAIL` merely CONTAINS this domain.
  TENANT: "a downstream tenant",
  CANON_OWNER: "<canon-owner>",
  ADO_PROJECT: "<ado-project>",
});
const SCRUB_PLACEHOLDER_LOWER = new Set(Object.values(SCRUB_PLACEHOLDER).map((v) => v.toLowerCase()));

/**
 * True when `t` is a prefix of the infinite `deadbeef…` stream (case-insensitive) — exactly the
 * shape `synthHex` writes, at any length (a truncated, non-multiple-of-8 form included).
 */
export function isSynthHexStream(t) {
  const low = String(t).toLowerCase();
  if (low.length === 0) return false;
  for (let i = 0; i < low.length; i++) if (low[i] !== "deadbeef"[i % 8]) return false;
  return true;
}

/**
 * True when `t` IS one of the scrub's replacement values: an EXACT, case-insensitive member of
 * `SCRUB_PLACEHOLDER` (never a prefix or substring — `maintainers`, `example-hostname` and
 * `maintainer2` are NOT placeholders), or a `synthHex` stream at least `minSynthHexLength` long.
 * The floor is the caller's: a scanner reading a roster whose real login may be spelled like a
 * short hex word (`DeadBeef`) floors it; a gate filtering its OWN derive output need not.
 * DECLARED BOUND for every caller: a real identity spelled exactly like a placeholder
 * (a login `maintainer`) is indistinguishable from the placeholder and is not seen.
 */
export function isScrubPlaceholderToken(t, { minSynthHexLength = 1 } = {}) {
  if (typeof t !== "string") return false;
  if (SCRUB_PLACEHOLDER_LOWER.has(t.toLowerCase())) return true;
  return t.length >= minSynthHexLength && isSynthHexStream(t);
}

/**
 * Harvest NAME + EMAIL from an armored PGP public-key block's UID packets. The
 * redteam proved the armored key base64-decodes to literal "Name <email>" bytes,
 * so a newly-rostered operator's identity is auto-gated without a hand edit.
 *
 * W2-0 fix: decode from the PARSED `keys[].pubkey` field (real newlines), NOT a
 * regex match over the raw roster TEXT. In the on-disk JSON the pubkey newlines
 * are `\n`-ESCAPED (backslash+n); `Buffer.from(s,"base64")` silently keeps the
 * stray `n`s and CORRUPTS the decode — so the pre-W2 raw-text scan recovered the
 * fingerprint (a separate field) but ZERO name/email from canon's real roster
 * (verified: emailish=0, nameish=0). Decoding the parsed field closes the gap.
 */
/**
 * Machine-derive the common separator-variants of a multi-part identity token:
 * "alex.kim" → ["alex-kim","alex_kim","alexkim"]. Used so the dynamic gate
 * covers every separator form WITHOUT a hand-maintained literal (MO-OPT holistic
 * redteam MO-R1-H2). Only emits forms >=5 chars distinct from the input — keeps
 * includes()-grep false-positives low while strengthening the fail-closed gate.
 */
function separatorVariants(token) {
  const parts = String(token).toLowerCase().split(/[.\-_ ]+/).filter(Boolean);
  if (parts.length < 2) return [];
  const out = new Set();
  for (const sep of [".", "-", "_", ""]) out.add(parts.join(sep));
  out.delete(String(token).toLowerCase());
  return [...out].filter((v) => v.length >= 5);
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Mail / identity-provider domains SHARED by unrelated people. Such a domain identifies nobody,
 * and gating it would halt every publish that mentions it, so it yields NO domain token — the
 * local-part still does. `onmicrosoft.com` is the Entra default suffix: the TENANT label to its
 * left (`<tenant>.onmicrosoft.com`) is the identity, never the suffix itself (see
 * DOMAIN_SUFFIXES_2 / publicSuffixLength). The RFC 2606 example domains are here so a fixture
 * address never derives `example` as a token.
 */
const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me",
  "protonmail.com", "pm.me", "gmx.com", "gmx.net", "gmx.de", "mail.com", "zoho.com",
  "fastmail.com", "hey.com", "qq.com", "163.com", "yandex.com", "yandex.ru",
  "github.com", "users.noreply.github.com", "noreply.github.com",
  "example.com", "example.org", "example.net",
]);

/**
 * Labels that are never an identity when they sit where a domain's owner label would: RFC 2606 /
 * RFC 6761 / RFC 8375 special-use names and the host names every machine has. `localhost` from
 * a `user@localhost` SSH comment, or `example` from `jdoe@example.test`, would otherwise become an
 * unbounded gate token that matches ordinary prose.
 */
const GENERIC_DOMAIN_LABELS = new Set([
  "example", "localhost", "localdomain", "local", "lan", "home", "internal", "intranet",
  "test", "invalid", "onion", "arpa", "corp", "mail", "email", "smtp", "www",
]);

/**
 * Labels that are generic TOP-LEVEL domains or ccTLD registry categories. Never an owner label: as
 * a gate token each matches ordinary text (`com` inside `command`).
 */
const TLD_LIKE_LABELS = new Set([
  "com", "net", "org", "edu", "gov", "mil", "int", "info", "biz", "io", "co", "ac", "app", "dev",
]);

/**
 * MULTI-LABEL PUBLIC SUFFIXES recognised by NAME: a small hand-picked set MODELLED ON the Public
 * Suffix List (https://publicsuffix.org/list/public_suffix_list.dat) plus Entra tenant suffixes and
 * `fritz.box` (a vendor-private home-router namespace the PSL does not carry). It is NOT a copy of
 * the PSL and was NOT verified entry-by-entry against the live list — an earlier revision of this
 * comment said "as read on 2026-09-27", which was false and is withdrawn. A domain these rules do
 * not size correctly yields NO owner label (harvestDomain's exact-structure rule), so a gap here
 * costs a missed tenant label, never a wrong one.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  "onmicrosoft.com", "mail.onmicrosoft.com", "onmicrosoft.us", "onmicrosoft.de", "onmicrosoft.cn", "sharepoint.com",
  "home.arpa", "fritz.box",
  "blogspot.com", "github.io", "gitlab.io", "herokuapp.com", "azurewebsites.net", "cloudapp.net",
  "appspot.com", "firebaseapp.com", "web.app", "netlify.app", "vercel.app", "pages.dev", "workers.dev",
  "s3.amazonaws.com",
  "gouv.fr", "asso.fr", "presse.fr", "govt.nz", "school.nz", "school.za", "gouv.qc.ca", "police.uk", "parliament.uk",
]);
/** Wildcard suffixes (`*.<x>`): the label directly left of `<x>` is PART of the suffix (cloud machine names). */
const WILDCARD_SUFFIXES = ["compute.amazonaws.com", "compute-1.amazonaws.com", "compute.amazonaws.com.cn"];

/**
 * How many trailing labels of a lower-cased, dot-split domain are its PUBLIC SUFFIX:
 *   1. a wildcard suffix (`*.compute-1.amazonaws.com` — the machine label belongs to the suffix);
 *   2. `k12.<state>.us`;
 *   3. a NAMED multi-label suffix (MULTI_LABEL_SUFFIXES), longest first;
 *   4. under a two-letter ccTLD, a second-level label of AT MOST 3 characters when a label sits to
 *      its left (`co.uk`, `sch.uk`, `ltd.uk`, `nhs.uk`, `per.sg`, `gen.in`, `id.au`, `ne.jp`, …);
 *   5. otherwise the one-label TLD.
 */
function publicSuffixLength(labels) {
  const n = labels.length;
  for (const w of WILDCARD_SUFFIXES) {
    const k = w.split(".").length;
    if (n >= k + 1 && labels.slice(-k).join(".") === w) return k + 1;
  }
  if (n >= 3 && labels[n - 1] === "us" && labels[n - 2].length === 2 && labels[n - 3] === "k12") return 3;
  for (const k of [3, 2]) if (n >= k && MULTI_LABEL_SUFFIXES.has(labels.slice(-k).join("."))) return k;
  if (n >= 3 && labels[n - 1].length === 2 && labels[n - 2].length <= 3) return 2;
  return 1;
}

/**
 * The scrub key for a WHOLE declared domain: bounded so it never rewrites inside a longer host name
 * or word. The left boundary excludes `.` and `-` as well as alphanumerics, so a declared
 * `amazonaws.com` does not turn `s3.amazonaws.com` into `s3.example.com`; the right boundary also
 * refuses a following `.label`. An occurrence the key declines is still seen by the unbounded GATE,
 * which HALTS — the failure direction is a halt, never a silent rewrite of someone else's host.
 */
function domainScrubRe(d) {
  return new RegExp("(?<![A-Za-z0-9.\\-])" + d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![A-Za-z0-9\\-]|\\.[A-Za-z0-9])", "gi");
}

/**
 * Push a DERIVED token — an exact PART of a declared value (a local-part, a machine name left
 * after stripping `.local`), never a guess. It is always a GATE token. It becomes a SCRUB key only
 * when it cannot be an ordinary word — it carries a digit, `.`, `-`, `_` or another non-letter —
 * and then WORD-BOUNDED. A letters-only derived token (`jdoe`, `mini`, `work`, `data`) is gate-only:
 * the scrubber rewrote such words inside ordinary text (`workflow` → `example-hostflow`, `database`
 * → `maintainerbase`, measured), a SILENT corruption no later gate can see. Gate-only makes the
 * failure a loud publish HALT that the adjudication registry can clear.
 */
function pushDerived(tok, to, gate, scrub) {
  const t = String(tok).trim();
  if (t.length < TENANT_TOKEN_MIN_LEN) return;
  gate.push(t);
  if (/[^\p{L}\p{M}]/u.test(t)) scrub.push([t, to, { bounded: true }]);
}

/**
 * Harvest the identity a DOMAIN carries.
 *
 *   WHOLE DOMAIN — the declared value itself: a GATE token and a bounded SCRUB key (domainScrubRe).
 *   OWNER LABEL  — a HEURISTIC guess at the tenant (`contoso` in `jdoe@contoso.com`): GATE ONLY,
 *                  never a scrub key and never given separator variants. A heuristic label used as
 *                  a silent-rewrite key was the root of a whole class (`amazonaws`, `us-west-2`,
 *                  `fritz`, `k12`, `com` became keys and rewrote `s3.amazonaws.com`, `github.com`,
 *                  `command` in published output — measured). As a gate token a wrong guess HALTS.
 *                  Taken only when the structure is fully accounted for: exactly `<owner>.<suffix>`,
 *                  with only special-use labels (`mail`, `corp`, `www`, …) to its left; anything
 *                  else yields no owner label. `ownerLabel:false` (SSH comment hosts, whose names
 *                  are machines, not tenants) never takes one.
 *   PRIVATE NAMESPACE — a special-use tail (`.local`, `.internal`, `.lan`, `.corp`, `.home.arpa`, …)
 *                  is stripped. If exactly ONE label remains, it is the machine / tenant name
 *                  exactly (`zqhost` in `zqhost.local`) and is pushed as a DERIVED token
 *                  (pushDerived). If more remain and they end in a TLD-shaped label
 *                  (`<org>.com.local`), the owner rule applies to them; otherwise
 *                  (`ip-….us-west-2.compute.internal`) there is no owner.
 *
 * Nothing is harvested for a shared mail domain (GENERIC_EMAIL_DOMAINS), a bare named suffix, or a
 * domain of special-use labels only (`localhost.localdomain`).
 */
function harvestDomain(domain, gate, scrub, { ownerLabel = true, hostTo = SCRUB_PLACEHOLDER.HOST } = {}) {
  const d = String(domain).trim().toLowerCase().replace(/\.$/, "");
  if (!d || GENERIC_EMAIL_DOMAINS.has(d) || MULTI_LABEL_SUFFIXES.has(d)) return;
  const all = d.split(".");
  if (all.some((l) => l === "")) return;
  let labels = all;
  while (labels.length && (GENERIC_DOMAIN_LABELS.has(labels[labels.length - 1]) ||
    (labels.length >= 2 && labels.slice(-2).join(".") === "home.arpa"))) {
    labels = labels.slice(0, labels.slice(-2).join(".") === "home.arpa" ? -2 : -1);
  }
  if (labels.every((l) => GENERIC_DOMAIN_LABELS.has(l))) return; // special-use labels only
  if (d.length >= TENANT_TOKEN_MIN_LEN) { gate.push(d); scrub.push([domainScrubRe(d), SCRUB_PLACEHOLDER.DOMAIN]); }
  const stripped = labels.length < all.length;
  if (stripped && labels.length === 1) { pushDerived(labels[0], hostTo, gate, scrub); return; }
  if (!ownerLabel) return;
  if (stripped && !TLD_LIKE_LABELS.has(labels[labels.length - 1]) && labels[labels.length - 1].length !== 2) return;
  const suffix = publicSuffixLength(labels);
  const oi = labels.length - suffix - 1;
  if (oi < 0) return;
  if (labels.slice(0, oi).some((l) => !GENERIC_DOMAIN_LABELS.has(l))) return; // unaccounted labels: no guess
  const owner = labels[oi];
  if (GENERIC_DOMAIN_LABELS.has(owner) || TLD_LIKE_LABELS.has(owner) || owner.length < TENANT_TOKEN_MIN_LEN) return;
  gate.push(owner); // GATE ONLY — see above
}

/**
 * Local-parts that name a ROLE or a SERVICE, not a person (`admin@<tenant>`, `build@<tenant>`,
 * `root@<host>`, `data@<tenant>`). None is emitted on its own; the whole address and its domain
 * still are. A closed list cannot be complete. What an UNLISTED dictionary-word local-part costs is
 * now bounded by pushDerived: a letters-only one is a GATE token only, so it can HALT a publish
 * (false positive, adjudicable) but is never a scrub key, so it cannot silently rewrite text; one
 * carrying a digit or punctuation is a word-bounded scrub key. That is what makes "errs toward a
 * false-positive halt, never a silent corruption" true — an earlier revision claimed it while the
 * key was an unbounded scrub pair (`data` rewrote `database`, measured).
 *
 * MEMBERSHIP IS PINNED BY A TEST, in BOTH directions. See
 * `L2 LOCAL-PART: the machine/role name set is PINNED in BOTH directions`.
 *
 * THIS LIST IS THE E-MAIL SURFACE ONLY, and it is NOT the operator-home exclusion. The two are
 * NOT derived from one another, and the reason is that their FAILURE DIRECTIONS ARE OPPOSITE: a
 * wrong skip here costs a FALSE-POSITIVE HALT (a legitimate token stops being extracted), while a
 * wrong exclusion on the home-path side costs a MISSED DISCLOSURE. A name safe to SKIP as a role
 * mailbox is therefore NOT thereby safe to EXCLUDE as a home — `build@tenant` is a role mailbox,
 * but a home directory named `build` may be a real operator.
 *
 * THE PATH IS DESCRIBED, NEVER WRITTEN, and that is a deliberate change: an earlier revision of
 * this paragraph spelled one out, and a literal `/home/<name>` IS the exact shape this fence scans
 * for — so the sentence explaining a MISSED DISCLOSURE was itself a disclosure finding in a file
 * that ships (`.claude/bin/lib/**`, measured: `scan-synced-disclosure --check` rc=1 on the tip that
 * carried it, rc=0 on the tip without it). Describing the shape keeps the point and costs nothing.
 * If you are about to restore a literal for readability: it is a finding, and the fence is right.
 *
 * The incident: the path-side exclusion was briefly DERIVED from this list, which imported
 * machine-account names into a disclosure fence whose failure direction is the unsafe one. The
 * derivation was reverted. Keep the two literal and keep them separate.
 *
 * (`ci` can never be emitted as a token on this surface — it is 2 characters and
 * `TENANT_TOKEN_MIN_LEN` is 3 — so adding it here is INERT for token extraction. Whether it
 * matters elsewhere in this module is unmeasured.)
 */
const GENERIC_LOCAL_PARTS = new Set([
  "admin", "administrator", "root", "user", "info", "contact", "support", "noreply", "no-reply",
  "donotreply", "do-not-reply", "test", "dev", "git", "mail", "webmaster", "postmaster", "hostmaster",
  "security", "sales", "office", "hello", "team", "ubuntu", "ec2-user", "runner", "maintainer", "owner",
  "operator", "build", "builder", "deploy", "deployer", "release", "bot", "service", "svc", "automation",
  "devops", "backup", "scanner", "monitor", "monitoring", "alert", "alerts", "notify", "notifications",
  "jenkins", "azure", "sync", "api", "app", "system", "sysadmin", "help", "helpdesk", "abuse",
  "billing", "accounts", "finance", "marketing", "news", "newsletter", "bounce", "mailer-daemon",
  "data", "work", "home", "mini", "studio",
]);

/**
 * Push the tokens a LOCAL-PART yields, each through pushDerived: the local-part as written
 * (surrounding `"` of an RFC 5321 quoted local-part removed) and, for a `+` sub-address, the BASE
 * before the first `+` — never the TAG after it (`jdoe+ado` → `ado` is a free label). Each is
 * floored at > 2 and skipped when it is a role word or all digits. Separator variants (MO-R1-H2:
 * `alex.kim` → `alex-kim`, `alexkim`) are variants of an EXACT declared part, not of a guess, and
 * go through pushDerived too.
 */
function harvestLocalPart(lp, gate, scrub) {
  const whole = String(lp).trim().replace(/^"(.*)"$/, "$1");
  const plus = whole.indexOf("+");
  for (const part of new Set(plus > 0 ? [whole, whole.slice(0, plus)] : [whole])) {
    const t = part.trim();
    if (t.length <= 2 || GENERIC_LOCAL_PARTS.has(t.toLowerCase()) || /^\d+$/.test(t)) continue;
    pushDerived(t, SCRUB_PLACEHOLDER.LOGIN, gate, scrub);
    for (const v of separatorVariants(t)) pushDerived(v, SCRUB_PLACEHOLDER.LOGIN, gate, scrub);
  }
}

/** Push one email (gate + scrub, whole declared value) + its local-part + its domain. */
function harvestEmail(email, gate, scrub, domainOpts) {
  gate.push(email); scrub.push([email, SCRUB_PLACEHOLDER.EMAIL]);
  const at = email.lastIndexOf("@");
  harvestLocalPart(email.slice(0, at), gate, scrub);
  harvestDomain(email.slice(at + 1), gate, scrub, domainOpts);
}

/**
 * Harvest the parts of an Entra userPrincipalName (`<local>@<domain>`, roster `principal`) that a
 * citation actually uses: the LOCAL-PART (harvestLocalPart) and the TENANT domain (harvestDomain:
 * whole domain gated + scrubbed, owner label gated only). The whole UPN is pushed by the caller as a
 * person-id token. An Entra B2B guest UPN (`<local>_<home-domain>#EXT#@<tenant>`) also yields its
 * HOME address, rebuilt from the `_` before `#EXT#`.
 */
function harvestPrincipalParts(upn, gate, scrub) {
  const at = upn.lastIndexOf("@");
  if (at <= 0 || at === upn.length - 1) return;
  let local = upn.slice(0, at);
  harvestDomain(upn.slice(at + 1), gate, scrub);
  const ext = /^(.+)#EXT#$/i.exec(local);
  if (ext) {
    local = ext[1];
    const us = local.lastIndexOf("_");
    if (us > 0 && us < local.length - 1) {
      const home = local.slice(0, us) + "@" + local.slice(us + 1);
      if (new RegExp("^" + EMAIL_RE.source + "$").test(home)) {
        harvestEmail(home, gate, scrub);
        local = local.slice(0, us);
      }
    }
  }
  harvestLocalPart(local, gate, scrub);
}

/** Push one display name (trimmed, floor > 2) + its separator variants. */
function harvestDisplayName(name, gate, scrub) {
  const n = String(name).trim();
  if (n.length <= 2) return;
  gate.push(n); scrub.push([n, SCRUB_PLACEHOLDER.DISPLAY_NAME]);
  for (const v of separatorVariants(n.toLowerCase())) { gate.push(v); scrub.push([v, SCRUB_PLACEHOLDER.NAME_VARIANT]); }
}

/**
 * Harvest a UID display name under the full rule set: the name as written; the name with every
 * parenthesised `( … )` segment removed, trimmed and whitespace-collapsed (so the standard
 * `Name (Comment) <email>` UID also yields the plain `Name` a citation actually uses); and each
 * comment's inner text (floor > 2). Used by BOTH the packet path and the text-scan fallback.
 */
function harvestUidName(display, gate, scrub) {
  const whole = String(display).trim();
  harvestDisplayName(whole, gate, scrub);
  const bare = whole.replace(/\([^()]*\)/g, " ").replace(/\s+/g, " ").trim();
  if (bare !== whole) harvestDisplayName(bare, gate, scrub);
  for (const m of whole.matchAll(/\(([^()]*)\)/g)) {
    const inner = m[1].trim();
    if (inner.length > 2) { gate.push(inner); scrub.push([inner, SCRUB_PLACEHOLDER.LOGIN]); }
  }
}

/**
 * Text-scan fallback for a key blob that does NOT parse as a packet stream: every UID-looking
 * segment directly followed by ` <x@y>` — the run of text back to the previous boundary (a
 * control character, U+FFFD from an undecodable byte, `<` or `>`), capped at the last 128
 * characters so a long run stays bounded and the result deterministic. Covers mononyms and
 * lower-case particles the Capitalised-words shape cannot see.
 */
const UID_SEGMENT_RE = /([^\p{Cc}\uFFFD<>]{1,128}) <[^<>\s@]+@[^<>\s]+>/gu;

/**
 * Walk an OpenPGP packet stream (RFC 4880 §4.2, old + new format headers) and return the bodies
 * of its User ID packets (tag 13), or null when the stream does not parse cleanly (truncated
 * length, partial-length body, indeterminate length) — the caller then falls back to a text scan.
 */
function pgpUidPackets(buf) {
  const uids = [];
  let i = 0;
  while (i < buf.length) {
    const h = buf[i++];
    if (!(h & 0x80)) return null;
    let tag, len;
    if (h & 0x40) { // new format
      tag = h & 0x3f;
      if (i >= buf.length) return null;
      const o1 = buf[i++];
      if (o1 < 192) len = o1;
      else if (o1 < 224) { if (i >= buf.length) return null; len = ((o1 - 192) << 8) + buf[i++] + 192; }
      else if (o1 === 255) { if (i + 4 > buf.length) return null; len = buf.readUInt32BE(i); i += 4; }
      else return null; // partial body length
    } else { // old format
      tag = (h >> 2) & 0x0f;
      const lt = h & 0x03;
      const n = lt === 0 ? 1 : lt === 1 ? 2 : lt === 2 ? 4 : 0;
      if (n === 0 || i + n > buf.length) return null; // indeterminate length / truncated
      len = n === 1 ? buf[i] : n === 2 ? buf.readUInt16BE(i) : buf.readUInt32BE(i);
      i += n;
    }
    if (i + len > buf.length) return null;
    if (tag === 13) uids.push(buf.subarray(i, i + len));
    i += len;
  }
  return uids;
}

/**
 * Every intact User ID packet (tag 13) inside a byte stream that does NOT parse as a whole, found
 * by scanning for a tag-13 header at every offset: old format `0xB4`/`0xB5` (1- or 2-octet
 * length) and new format `0xCD` (1- or 2-octet length). A candidate counts only when its declared
 * body fits the buffer, is valid UTF-8, and is WHOLLY a UID ending in an address —
 * `<name> <local@domain>` with no control character — so a stray header byte inside key material
 * does not produce one. A UID without an address is not recognisable here; the text fallback
 * covers what it can of that case.
 */
function salvageUidPackets(buf) {
  const out = [];
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  for (let i = 0; i + 1 < buf.length; i++) {
    const h = buf[i];
    let len, start;
    if (h === 0xb4) { len = buf[i + 1]; start = i + 2; }
    else if (h === 0xb5) { if (i + 3 > buf.length) continue; len = buf.readUInt16BE(i + 1); start = i + 3; }
    else if (h === 0xcd) {
      const o1 = buf[i + 1];
      if (o1 < 192) { len = o1; start = i + 2; }
      else if (o1 < 224 && i + 2 < buf.length) { len = ((o1 - 192) << 8) + buf[i + 2] + 192; start = i + 3; }
      else continue;
    } else continue;
    if (len < 1 || start + len > buf.length) continue;
    let text;
    try { text = utf8.decode(buf.subarray(start, start + len)); } catch { continue; }
    if (!/^[^\p{Cc}<>]+ <[^<>\s@]+@[^<>\s]+>$/u.test(text)) continue;
    out.push(Buffer.from(text, "utf8"));
  }
  return out;
}

/**
 * Harvest NAME + EMAIL from each armored PGP block in a pubkey field.
 *
 * UID packets are decoded as UTF-8 (RFC 4880 §5.11), not latin1: latin1 turned `José García`
 * into mojibake that matches no text. When the block parses as a packet stream, EVERY UID yields
 * its display name — the text before ` <`, trimmed, or the whole UID when it has no email — as
 * ONE token (floor > 2) with its separator variants. The previous ASCII-only regex demanded two
 * or more Capitalised words, so `Ludwig van Beethoven`, mononyms and non-Latin names yielded only
 * their email. When the stream does NOT parse (e.g. a hand-built fixture), the text-scan fallback
 * applies the old name shape with Unicode letter classes over the UTF-8 decode. Emails are always
 * harvested from the whole decode, as before.
 */
function harvestPgpUid(pubkeyText, gate, scrub) {
  if (typeof pubkeyText !== "string") return;
  for (const block of pubkeyText.match(/-----BEGIN PGP PUBLIC KEY BLOCK-----[\s\S]*?-----END PGP PUBLIC KEY BLOCK-----/g) || []) {
    let bytes;
    try {
      // Armor headers (RFC 4880 §6.2: `Version`, `Comment`, `Hash`, `Charset`, `MessageID`, and
      // any other `Key: value`) are dropped by SHAPE, not by name: a line holding `:` cannot be
      // base64 payload. Only `Comment`/`Version` used to be dropped, so a `Hash:` or `MessageID:`
      // header's letters were decoded AS payload, shifted every byte after them, and the block's
      // name and email left the gate (measured: 0 of 2 harvested).
      const b64 = block
        .replace(/-----(BEGIN|END) PGP PUBLIC KEY BLOCK-----/g, "")
        .replace(/^[^\n]*:[^\n]*$/gm, "")
        .replace(/\n=[^\n]{4}\s*$/, "")
        .replace(/\s+/g, "");
      bytes = Buffer.from(b64, "base64");
    } catch { continue; }
    const decoded = bytes.toString("utf8");
    for (const m of decoded.matchAll(EMAIL_RE)) harvestEmail(m[0], gate, scrub);
    const uids = pgpUidPackets(bytes);
    if (uids && uids.length) {
      for (const u of uids) {
        const text = u.toString("utf8");
        const lt = text.indexOf(" <");
        harvestUidName(lt >= 0 ? text.slice(0, lt) : text.replace(/<[^>]*>/g, ""), gate, scrub);
      }
    } else {
      // The stream does not parse as a whole (a truncated or partial-length packet anywhere), but
      // its UID packets usually still sit intact inside it. Located by HEADER and sliced by the
      // declared LENGTH (salvageUidPackets), a UID's name comes out exact. The text shapes below
      // cannot do that: the byte before a UID body is its packet LENGTH, which is often printable
      // and glues onto the segment — an uppercase glued letter defeated the Capitalised-words
      // shape too, so only `K<Name>` was harvested and `<Name>` itself read clean (measured).
      for (const u of salvageUidPackets(bytes)) {
        const text = u.toString("utf8");
        harvestUidName(text.slice(0, text.lastIndexOf(" <")), gate, scrub);
      }
      // Both text shapes, additively, for a blob that holds no locatable UID packet at all (e.g. a
      // hand-built fixture): the boundary segment (UID_SEGMENT_RE) catches mononyms and lower-case
      // particles; the Capitalised-words shape starts at a capital, so a LOWER-case glued length
      // byte still yields the clean name there.
      for (const m of decoded.matchAll(UID_SEGMENT_RE)) harvestUidName(m[1], gate, scrub);
      for (const m of decoded.matchAll(/(\p{Lu}[\p{L}\p{M}.'’-]+(?: \p{Lu}[\p{L}\p{M}.'’-]+)+) <[^>]+>/gu)) {
        harvestUidName(m[1], gate, scrub);
      }
    }
  }
}

/**
 * Harvest identity from an OpenSSH public-key line (`ssh-<alg> <base64> [comment]`, also
 * `ecdsa-…` and `sk-…`): the COMMENT (trimmed, floor > 2) and, when it contains an email, that
 * email + local-part exactly as the PGP email harvest does. The key BODY is deliberately NOT
 * harvested: it is a public key, not an identity, and its SHA256 fingerprint is already carried
 * by `keys[].fingerprint`. Before this, an SSH pubkey contributed nothing, so a `user@host`
 * comment — typically the operator's login and machine — was never gated.
 */
function harvestSshPubkey(pubkeyText, gate, scrub) {
  if (typeof pubkeyText !== "string") return;
  for (const line of pubkeyText.split(/\r?\n/)) {
    const m = /^\s*(?:ssh-[A-Za-z0-9.@-]+|ecdsa-[A-Za-z0-9.@-]+|sk-[A-Za-z0-9.@-]+)\s+[A-Za-z0-9+/=]+(?:\s+(.*))?$/.exec(line);
    if (!m || m[1] === undefined) continue;
    const comment = m[1].trim();
    if (comment.length <= 2) continue;
    gate.push(comment); scrub.push([comment, SCRUB_PLACEHOLDER.LOGIN]);
    // A comment `user@<machine>.local` (the macOS ssh-keygen default) IS an email to EMAIL_RE, so it
    // is harvested HERE and never reaches the no-dot branch below. The whole host is gated and
    // scrubbed; the machine name alone is derived ONLY by stripping a special-use tail
    // (`<machine>.local`), never guessed as an "owner" label (`ownerLabel:false`) — a cloud host
    // `ec2-….compute-1.amazonaws.com` made `amazonaws` a scrub key (measured).
    for (const e of comment.matchAll(EMAIL_RE)) harvestEmail(e[0], gate, scrub, { ownerLabel: false });
    // `user@host` with no dot-TLD (the ssh-keygen default comment) is not an email to EMAIL_RE,
    // so its parts are harvested here: the login and the machine name, each floored at > 2. A
    // special-use host (`localhost`) names no machine and is not a token.
    for (const word of comment.split(/\s+/)) {
      const uh = /^([^@\s]+)@([^@\s]+)$/.exec(word);
      if (!uh || new RegExp(EMAIL_RE.source).test(word)) continue;
      // Both parts through pushDerived: a letters-only login or host (`work`) is gate-only — as an
      // unbounded scrub key `work` rewrote `workflow` (measured).
      if (!GENERIC_LOCAL_PARTS.has(uh[1].toLowerCase())) pushDerived(uh[1], SCRUB_PLACEHOLDER.LOGIN, gate, scrub);
      if (!GENERIC_DOMAIN_LABELS.has(uh[2].toLowerCase())) pushDerived(uh[2], SCRUB_PLACEHOLDER.HOST, gate, scrub);
    }
  }
}

/** Every identity a `pubkey` field carries: PGP UIDs and OpenSSH comments. ONE entry point. */
function harvestPubkeyIdentity(pubkeyText, gate, scrub) {
  harvestPgpUid(pubkeyText, gate, scrub);
  harvestSshPubkey(pubkeyText, gate, scrub);
}

/** Depth-first walk of every file under `dir`, calling cb(absolutePath). */
export function walkFiles(dir, cb) {
  for (const e of readdirSync(dir)) {
    const full = path.join(dir, e);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walkFiles(full, cb);
    else cb(full);
  }
}

/**
 * FAIL-CLOSED symlink-escape assertion over a materialized/checked-out `tree` (#825
 * Wave-3 R-LOW-1 / 06c; relocated here 2026-07-10 per the F7 redteam MEDIUM fix — see
 * the file-level doc comment above for why this guard lives here and not in
 * scripts/publish-to-public.mjs).
 *
 * `walkFiles` (above) resolves entries with `statSync`, which FOLLOWS symlinks: a
 * symlink to an external FILE is `readFileSync`-followed by a scrub/identity-token
 * walk, and a symlink to an external DIRECTORY makes the walk RECURSE OUTSIDE the
 * scanned surface. A disclosure/token scan then only flags identity TOKENS, so a
 * symlink to a structurally-sensitive-but-token-free target escapes every fence —
 * and on the clean-instantiate CLEAR ceremony, `neutralizeWholeTree`'s
 * `writeFileSync(f, after)` would WRITE THROUGH such a symlink to an arbitrary path
 * on the operator's machine. This assertion closes that class for every caller that
 * runs a `walkFiles`-driven pass over a materialized tree.
 *
 * The assertion is `lstat`-based (SEES the link node — `walkFiles`'s `statSync`
 * cannot, it dereferences) and does NOT recurse through a symlinked directory. A
 * symlink whose `realpathSync` target stays INSIDE `tree` is benign (idempotent
 * re-scrub); a target that ESCAPES the tree root, OR is unresolvable (dangling →
 * the scan would error/fail-closed), is a finding. Callers assert BEFORE their
 * first destructive/tree-walking step so no escaping symlink is ever FOLLOWED.
 * Throws (fail-closed) naming every escaping link by its TREE-RELATIVE path; the resolved
 * target is withheld (`<outside the tree>`), because it is an absolute path on the operator's machine.
 *
 * @param {string} tree  absolute path to the materialized/checked-out tree
 * @returns {void}  throws on the FIRST walk that finds ≥1 escaping / unresolvable symlink
 */
export function assertNoSymlinkEscape(tree) {
  const root = realpathSync(tree);
  const escaped = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const full = path.join(dir, e);
      let lst;
      try { lst = lstatSync(full); } catch { continue; }
      if (lst.isSymbolicLink()) {
        let real;
        try { real = realpathSync(full); }
        catch { escaped.push(`${path.relative(tree, full)} -> <unresolvable/dangling>`); continue; }
        if (real !== root && !real.startsWith(root + path.sep)) {
          // The TARGET is never printed: it is an absolute path outside the tree — typically
          // `/Users/<operator>/…` — and this message reaches terminals and CI logs unscrubbed. Nor is
          // a root-relative form (`../../<operator>/.ssh/…`), which carries the same segments. The
          // in-tree link name is enough to find and fix it.
          // The link is named relative to `tree`, the base the walk joins onto — NOT to `root`,
          // its realpath: where the two differ (macOS `/var` → `/private/var`, a symlinked
          // checkout) `path.relative(root, full)` climbs out with `../../` and spells the whole
          // absolute path (measured).
          escaped.push(`${path.relative(tree, full)} -> <outside the tree>`);
        }
        // Do NOT recurse THROUGH a symlinked directory (even an in-tree one): the lstat
        // walk enumerates the tree's own structure, never a link's target subtree.
      } else if (lst.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(tree);
  if (escaped.length) {
    throw new Error(
      "tree contains symlink(s) that escape the scanned surface (disclosure-escape / " +
      "arbitrary-file-write, #825 06c): " + escaped.join("; ") + ". A tracked in-tree symlink " +
      "whose target leaves the tree is reproduced verbatim by a recursive copy's default " +
      "dereference:false, and then FOLLOWED by any statSync-based walk (identity-scrub.mjs's " +
      "walkFiles), so its target bypasses the token scan — or, on a write pass, is written " +
      "through to an arbitrary path outside the tree. Remove the symlink from the surface " +
      "or repoint it inside the tree.",
    );
  }
}

/**
 * A FRESH operator-home-path regex each call. The pattern matches any
 * /Users/<name>/ or /home/<name>/ that is NOT the placeholder or a CI runner →
 * structural scrub of operator paths the literal token list misses (e.g. a
 * test-fixture /Users/<name>/). Returned as a factory — NOT a shared module-level
 * const — because the `g` flag carries mutable `lastIndex` state; a shared
 * instance would race between the scrub `.replace()` and the gate `.exec()`.
 */
export function makeHomepathRe() {
  return new RegExp(HOMEPATH_RE_SOURCE, "gu");
}

// ── makeHomepathRe, piece by piece. Group 1 is the home ROOT, group 2 the USERNAME CHAIN, in every
// form — consumers read `m[2]`; homepathPlaceholder replaces exactly group 2.
//
// ROOTS. `/Users/` and `/home/` (case-sensitive), and `\Users\` after a backslash — a JSON-escaped
// `\\` is accepted wherever `\` is. Any OTHER casing (`users`, `USERS`) counts only after a DRIVE
// root (`C:\`, `C:/`, `C:\\`) or a UNC share (`\\server\c$\`), so `api\users\list` is not a home.
//
// WINDOWS vs POSIX is decided by what precedes the NAME (WIN_LB): a backslash, or `Users/` reached
// from a drive root or a backslash (`C:/Users/…`, mixed `C:\Users/…`). The separator AFTER the root
// does not decide it — a mixed-separator path used to fall to the POSIX one-word rule.
//
// NAME characters: Unicode letters, marks, digits, `_ . ~ -`, and an apostrophe only BETWEEN
// letters/digits (a trailing one is a closing quote). `~` covers 8.3 names (`JDOEZQ~1`).
//
// WINDOWS NAMES OVER-SCRUB, BY DESIGN. A Windows profile name may hold spaces, and the old rule took
// the spaced form only when it then hit `\ / " ' \x60 CR LF EOI` — every OTHER follower (`, ; : ) |
// # ! …`, `%20`, NBSP, ZWSP, a 5th word) left `<user> <surname>`, and the `<user>` exclusion then
// hid the surname from every later gate (measured). Now a Windows name is: a word, then any number
// of (in-name separator + word), where an in-name separator is a space, tab, any `\p{Zs}` (NBSP …),
// `%20`, or a zero-width character (ZWSP/ZWNJ/ZWJ/WJ/BOM). It stops at the first character that is
// neither. So the failure direction is SAFE: `see C:\Users\<name> then more prose` loses `then more
// prose` too (DECLARED over-scrub: every name-like word after a Windows home up to the first
// non-name character). No word cap. A POSIX name (macOS short name, Linux login) takes no space.
//
// TRAVERSAL. `<home>/<name>/<dot-segments>/<other>` where the dot segments hold at least one `..`
// (with any `.`, `..` or EMPTY segments around it — `/./../`, `//../`, `\.\..\`) names a home of
// `<other>`. The chain `<name>(<dot-segments><sep><name>)*` is the username group, so the whole
// chain is replaced. An excluded name followed by such a traversal is not excluded.
//
// EXCLUDED NAMES (never an operator), and the set is deliberately SHORT: `<user>`, `runner`,
// `runneradmin`, `example`, `Public`, `Default`, plus the two Windows BUILT-IN profile
// directories that are genuinely multi-word (`Default User`, `All Users`). Each is enumerated
// because it is provably not a person; the list is not a place to park every service-sounding
// word, since a name wrongly listed here is a missed disclosure, and the widened forms are
// reachable by a real person's surname (see HP_NB (b)).
//
// LINEAR TIME. No lookbehind has an unbounded quantifier (the UNC one is capped at 64 characters per
// label), and every repetition is disjoint from what follows it. The previous spaced-name lookbehind
// `(?:[^/\\\s]+/)*` made `"C:/Users/".repeat(64000)` take ~39 s (measured).
const HP_SEP = String.raw`(?:/|\\{1,2})`;
const HP_NC = String.raw`(?:[\p{L}\p{M}\p{N}_.~\-]|['’](?=[\p{L}\p{N}]))`;
const HP_START = String.raw`[\p{L}_]`;
const HP_WSTART = String.raw`[\p{L}\p{N}_]`;
const HP_INSEP = String.raw`(?:[\t\p{Zs}]|%20|[\u200B-\u200D\u2060\uFEFF])`;
// The NAME BOUNDARY an excluded name must be followed by, and it rules out TWO classes:
//
// (a) A NAME CHARACTER (`HP_NC`). The narrower `[\p{L}\p{M}\p{N}_]` it replaces is NOT the
//     complement of that class \u2014 `HP_NC` also admits `.`, `~`, `-` and an interior apostrophe \u2014 so
//     a name that merely STARTS with an excluded one was read as the excluded PREFIX: a
//     `<machine>.<surname>` / `<Machine>-<surname>` home was excluded whole (measured on the
//     pre-existing members: the `runner`-, `Public`- and `example`-prefixed dotted forms were each
//     read as just their first segment). That is a missed disclosure, the unsafe direction.
//
// (b) A WINDOWS IN-NAME SEPARATOR (`HP_INSEP`) \u2014 space, tab, `%20`, NBSP, zero-width. This closes a
//     PRE-EXISTING hole (present before and after the boundary above was corrected, FOUND BY
//     SECURITY REVIEW): a space is NOT a name character, so the old boundary passed at one and the
//     lookahead vetoed the WHOLE spaced Windows name \u2014 surname included. A spaced Windows home
//     beginning with the built-in `Public` profile directory name read as that directory, so a real
//     person whose profile was `Public` + a surname was never flagged; the same held for a `runner`
//     + surname profile. With (b) the exclusion applies only when the excluded name is the WHOLE
//     name, so both are flagged. The literals are deliberately NOT written here: they are MATCHING
//     homes now, and one spelled out in this file self-flags the scan (measured \u2014 an earlier
//     revision of this comment reddened the self-scan on two of its own columns).
//
// (b) makes a spaced continuation a NAME, so the built-ins that genuinely ARE multi-word are
// enumerated as whole alternatives in HP_EXCL rather than relying on a prefix (`All Users`,
// `Default User`). That is a SEMANTIC distinction no structural rule can draw, and it is drawn
// where the scanner's own allowlist draws its equivalents: one name at a time, with evidence.
const HP_NB = String.raw`(?!(?:${HP_NC})|(?:${HP_INSEP}))`;
const HP_USERS_ANYCASE = String.raw`[Uu][Ss][Ee][Rr][Ss]`;
const HP_DRIVE_LB = String.raw`(?<=(?:^|[^\p{L}\p{N}_])[A-Za-z]:(?:/|\\{1,2}))`;
const HP_UNC_LB = String.raw`(?<=\\{2,4}[^\\/\s"'<>]{1,64}\\{1,2}[^\\/\s"'<>]{1,64}\\{1,2})`;
const HP_KIND = String.raw`(Users|home|(?:${HP_DRIVE_LB}|${HP_UNC_LB})${HP_USERS_ANYCASE})`;
const HP_UPLOOK = String.raw`(?:${HP_SEP}\.?(?=${HP_SEP}))*${HP_SEP}\.\.(?=${HP_SEP})`;
const HP_DOTSEG = String.raw`${HP_SEP}\.{0,2}(?=${HP_SEP})`;
const HP_EXCL = String.raw`(?!<user>|(?:runner|runneradmin|example|[Pp]ublic|PUBLIC|[Dd]efault|DEFAULT|Default User|All Users)${HP_NB}(?!${HP_UPLOOK}))`;
const HP_WIN_LB = String.raw`(?<=\\|(?:\\|[A-Za-z]:/)${HP_USERS_ANYCASE}/)`;
const HP_WINNAME = String.raw`${HP_START}${HP_NC}*(?:${HP_INSEP}+${HP_WSTART}${HP_NC}*)*`;
const HP_POSIXNAME = String.raw`${HP_START}${HP_NC}*`;
const HP_CHAIN = (name) => String.raw`${name}(?:(?=${HP_UPLOOK})(?:${HP_DOTSEG})+${HP_SEP}${name})*`;
const HOMEPATH_RE_SOURCE = String.raw`${HP_SEP}${HP_KIND}${HP_SEP}${HP_EXCL}((?:${HP_WIN_LB}${HP_CHAIN(HP_WINNAME)}|${HP_CHAIN(HP_POSIXNAME)}))`;

/**
 * The replacement for a makeHomepathRe match: the match with its USERNAME replaced by `<user>`,
 * separators and root kept as written. For a POSIX match this is byte-identical to the former
 * `"/$1/<user>"`; for a Windows match it keeps the backslashes instead of forging a mixed path.
 */
function homepathPlaceholder(full, username) {
  return full.slice(0, full.length - String(username).length) + "<user>";
}

/**
 * SYNTHETIC operator-home usernames that disclosure-test FIXTURES legitimately
 * plant in `*.test.mjs` so the fork's OWN disclosure tests still fire the scanner
 * after clean-instantiate. Used ONLY by the `*.test.mjs` homepath carve-out
 * (`makeScrubber({ preserveSyntheticFixtureHomes: true })`): a `/Users/<name>/`
 * (or `/home/<name>/`) shape in a test file is PRESERVED iff `<name>`
 * (case-insensitive) is in this set; EVERY OTHER username — including a REAL
 * contributor's macOS home whose name is NOT a roster token — is STILL rewritten
 * to the `/Users/<user>/` placeholder.
 *
 * This is the leak-SAFE form of the #1141-7 fixture carve-out (the prior binary
 * "skip ALL homepath rewriting for *.test.mjs" let a non-token real operator home
 * survive into the client's new ecosystem — an operator-PII-across-ecosystem leak
 * the structural scanner also misses, because clean-instantiate runs it in SOURCE
 * mode where scan-synced-disclosure.mjs excludes *.test.mjs from ALL shapes). The
 * failure direction is SAFE both ways: an unknown username → rewritten (NO leak);
 * a genuinely-synthetic fixture name missing here → over-neutered (a test-QUALITY
 * issue, never a disclosure leak).
 *
 * Membership is derived from the usernames loom's own test files actually use
 * (grep the `/(Users|home)/<name>/` shape across the `.test.mjs` files) PLUS the
 * canonical synthetic placeholders. Deliberately EXCLUDED: the maintainer's own login
 * localpart (the REAL maintainer home — a
 * roster token the dynamic scrub already rewrites to `maintainer`, which this pass
 * then normalizes to `<user>`, defense-in-depth) and `realclient`/`realcontributor`
 * (the counter-example REAL homes the regression tests assert are rewritten).
 * `runner`/`example`/`<user>` are already excluded by makeHomepathRe's lookahead,
 * so they never reach this set.
 */
export const SYNTHETIC_FIXTURE_USERS = new Set([
  "jdoe",         // sync-from-canon.test.mjs disclosure fixture (the #1141-7 motivating case)
  "jane",         // "Jane Doe" placeholder (sibling of jdoe)
  "alice",        // canonical Alice/Bob placeholder pair
  "bob",          // canonical Alice/Bob placeholder pair
  "op",           // generic synthetic operator, widely used in coordination-substrate fixtures
  "someoperator", // explicitly-synthetic operator name
  "fakeuser",     // explicitly-synthetic ("fake" in the name)
  "acme",         // canonical ACME synthetic placeholder
  "x",            // single-char synthetic operator stub
  // NOTE (rt2-security R2 INCREMENTAL): `me` / `user` / `test` / `someone` were
  // DELIBERATELY REMOVED — they are the most plausibly-REAL macOS usernames (a real
  // contributor could literally be named `test`/`user`), are used by ZERO loom
  // *.test.mjs disclosure fixture (grep-verified), and `me` is moot anyway
  // (scan-synced-disclosure already treats the `me` placeholder home as benign).
  // Removing them shrinks the preserve-set to only distinctly-synthetic names,
  // minimizing the real-username-collision surface at zero fixture cost. A future
  // synthetic fixture username not in this set fails SAFE (rewritten, no leak) — add
  // it here with a comment only if a disclosure fixture genuinely needs it preserved.
]);

/**
 * The two disclosure-scrub APPLICATION modes. FAIL-CLOSED: makeScrubber throws on
 * any other value (an unknown/missing mode is never a silent passthrough).
 *
 *   NEUTRALIZE — apply the dynamic pairs (deriveDynamicTokens().scrub: org-slug →
 *                `<canon-owner>` neutralize sentinel, login/display_id → "maintainer",
 *                tenant → "a downstream tenant", fingerprint → synthetic hex) + the
 *                operator-home-path regex ONLY. NO caller-supplied static list. The
 *                mode a CLIENT-TEMPLATE edition uses — it emits generic placeholders,
 *                never a real substitute identity.
 *   SUBSTITUTE — the NEUTRALIZE pairs UNION a caller-passed static substitution list
 *                (the public-fork mode: the caller passes its own loom-only static
 *                list mapping the org slug to the public foundation name, etc.). On a
 *                colliding `from`-key whose DYNAMIC value is a neutralize SENTINEL
 *                (angle-bracket form, e.g. `<canon-owner>`), the static SUBSTITUTE
 *                supersedes it — so the org resolves to the real foundation name, not
 *                the template placeholder. Non-sentinel dynamic pairs keep precedence.
 */
export const SCRUB_MODES = Object.freeze({ NEUTRALIZE: "NEUTRALIZE", SUBSTITUTE: "SUBSTITUTE" });

/** A neutralize SENTINEL is the angle-bracket placeholder form (`<canon-owner>`). */
function isNeutralizeSentinel(value) {
  return typeof value === "string" && /^<[^>]*>$/.test(value);
}

/**
 * Build a text scrubber `(text) => scrubbedText` from a set of `[from, to]` dynamic
 * scrub pairs (deriveDynamicTokens().scrub) plus the structural operator-home-path
 * regex, mode-parameterized. This is the shared SCRUB-APPLICATION layer both disclosure
 * fences use; it is identity-FREE (the literal substitution tokens live only in the
 * caller's `staticScrub`, never in this module — so the module stays sync+publish-safe).
 *
 * Pairs are applied LONGEST-`from`-first (a specific multi-token rule runs before a
 * general catch-all) and deduped by `from`-key, FIRST-WINS.
 *
 *   - NEUTRALIZE: `pairs = dynScrubPairs` (staticScrub is never consulted), so the
 *     output can only carry placeholders — never a literal substitute identity.
 *   - SUBSTITUTE: the merge order is `[supersede, ...dynScrubPairs, ...staticScrub]`,
 *     where `supersede` is the subset of staticScrub whose `from`-key collides with a
 *     dynamic pair carrying a NEUTRALIZE SENTINEL value. Placing that subset first lets
 *     first-wins dedup pick the static SUBSTITUTE over the dynamic sentinel (the
 *     org-shadowing fix: the org slug → the real foundation name, not `<canon-owner>`),
 *     while every NON-sentinel dynamic pair (e.g. an identity → "maintainer") keeps its
 *     original precedence over a same-key static catch-all — so the SUBSTITUTE output
 *     is byte-identical to the pre-split scrubber EXCEPT the deliberate sentinel-key
 *     substitutions. Trailing `staticScrub` supplies every static-only key.
 *
 * A FRESH homepath regex is minted per scrubber (the `g` flag carries mutable
 * `lastIndex`; `.replace()` resets it, but a shared instance would still race a
 * concurrent gate `.exec()` — makeHomepathRe's contract).
 *
 * `preserveSyntheticFixtureHomes` (default false) switches the structural
 * operator-home-path rewrite from an UNCONDITIONAL rewrite to a SYNTHETIC-USERNAME
 * ALLOWLIST callback: a `/Users/<name>/` (or `/home/<name>/`) shape is PRESERVED
 * iff `<name>` ∈ `SYNTHETIC_FIXTURE_USERS`, and EVERY OTHER username — including a
 * REAL contributor's macOS home — is STILL rewritten to `/Users/<user>/`. It
 * exists for the clean-instantiate whole-tree neutralize's `*.test.mjs` carve-out:
 * disclosure-test fixtures LEGITIMATELY plant SYNTHETIC operator-home shapes (e.g.
 * a `/Users/<fixture-user>/...` path under a `SYNTHETIC_FIXTURE_USERS` name) the fork's
 * own disclosure tests must trip against — an
 * unconditional rewrite would neuter them into `/Users/<user>/` (a green test that
 * verifies nothing). The narrow allowlist keeps THOSE intact while still closing
 * the operator-PII-across-ecosystem leak a blanket `*.test.mjs` skip opens (a REAL
 * non-token contributor home surviving into the client's new ecosystem — #1141-7
 * rt1-security). The dynamic canon-IDENTITY scrub is NEVER skipped: a real canon
 * token in a test file is still neutralized (and clean-instantiate's assert-zero
 * canon-token grep still covers `*.test.mjs` as the fail-closed backstop). The
 * default path (unconditional rewrite) stays byte-identical, so publish-fence
 * callers are unaffected.
 *
 * @param {[string,string][]} dynScrubPairs  the dynamic pairs (deriveDynamicTokens().scrub)
 * @param {{ mode: string, staticScrub?: [string,string][], preserveSyntheticFixtureHomes?: boolean }} opts
 * @returns {(text: string) => string}
 */
/**
 * The ONE token word-boundary predicate. Boundaries are LETTERS AND DIGITS only, so
 * `<tenant>_backend` is a tenant reference (the `_` joins a slug, not a word) and MUST
 * scrub, while `httpclient` is one word and stays whole for the benign-collision
 * registry to adjudicate.
 *
 * ── DO NOT WIRE THIS INTO THE GATE. The gate is DELIBERATELY unbounded. ──────────────
 *
 * An earlier revision of this comment said the predicate is EXPORTED "because the scrubber
 * and the output GATE must decide 'is this a tenant reference?' identically", citing a
 * 4302536f drift where a bounded scrubber and an unbounded gate disagreed. That instruction
 * is WITHDRAWN, and following it now would CREATE A LEAK on a public surface.
 *
 * MEASURED on this tree: `tokenBoundedRe` is referenced NOWHERE outside this file, and
 * `edition-output-gate.mjs` imports `tokenIsUnadjudicatedHit` (an unbounded `indexOf` scan),
 * NOT this predicate. That asymmetry is LOAD-BEARING, not drift:
 *
 *   - the SCRUBBER is bounded, and additionally SKIPS a match inside an opaque base64 run
 *     (`isInsideOpaqueBase64Run` below);
 *   - the GATE is unbounded and has NO base64 skip, so anything the scrubber declines to
 *     rewrite is still SEEN and still HALTS the publish.
 *
 * The scrubber's narrowing is safe ONLY because the gate does not share it. Wiring this
 * predicate — or the base64 skip — into the gate would convert that fail-safe into a silent
 * leak: the token would be neither scrubbed nor flagged. `edition-output-gate.mjs` (§ LAYER 3)
 * independently records that a bounded predicate WAS tried there and REVERTED for this reason.
 * If the two ever look like they should agree, read both comments before changing either.
 *
 * Returns a fresh RegExp per call: the `g` flag carries `lastIndex` state, so a shared
 * instance would silently skip matches on its second use.
 */
export function tokenBoundedRe(from) {
  return new RegExp("(?<![A-Za-z0-9])" + String(from).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![A-Za-z0-9])", "gi");
}

/**
 * The unbounded sibling of `tokenBoundedRe` — a case-INSENSITIVE literal matcher, used where a
 * pair carries no `{bounded:true}` — most pairs, but NOT "the identity pairs", which this line
 * claimed until 2026-09-08: `root_commit` IS an identity pair and IS bounded. Do not read a
 * category here; read `deriveDynamicTokens` for the live set. Replaces the former
 * `txt.split(from).join(to)`, which was case-SENSITIVE.
 *
 * Returns a fresh RegExp per call, for the same `lastIndex` reason `tokenBoundedRe` documents.
 */
export function tokenUnboundedRe(from) {
  return new RegExp(String(from).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
}

/**
 * The ONE normalization every GATE consumer folds BOTH its haystack AND its token through.
 *
 * ── THE RULE THIS EXISTS TO ENFORCE ──────────────────────────────────────────────────
 * The SAME folding function on BOTH sides of ONE comparison inside ONE component fails
 * CLOSED. TWO DIFFERENT folding functions across TWO components that must AGREE fails OPEN.
 * `disclosure-adjudication.mjs::loadBenignAdjudications` is the first shape — it lowercases
 * `token` and `host` with the same call, and a mismatch merely declines to suppress. The
 * scrubber/gate seam was the second, and it leaked: the SCRUBBER matches with
 * `new RegExp(escape(from), "gi")` while the GATE lowercased and `indexOf`'d, and those two
 * disagree on Unicode. Hence ONE function, exported, called on both sides. Do not inline a
 * second `.toLowerCase()` at a gate call site (`security.md` § Enforcement-Surface Parity).
 *
 * ── WHAT DIVERGED, MEASURED 2026-09-07 ───────────────────────────────────────────────
 *   'İ' (U+0130) .toLowerCase() -> "i" + U+0307   (TWO code points)
 *   /i/i.test('İ')              -> false           (non-unicode `i` folding never maps it)
 *   'K' (U+212A) .toLowerCase() -> "k"             (ASCII k — ONE code point)
 *   /k/i.test('K'(U+212A))      -> false
 * So U+0130 in a NON-FINAL position inserted a combining mark that SPLIT the token in the
 * gate's haystack — token `kaixcorp` written `ka<U+0130>xcorp` lowered to `kai̇xcorp`, and
 * `indexOf("kaixcorp")` failed. Scrubber missed it, gate missed it, the token shipped.
 * U+212A was NEVER that case: it folds to ASCII `k`, so the gate already caught it. The
 * originating review paired the two; only the first evaded both.
 *
 * NFKD decomposes compatibility forms (U+212A -> "K", U+0130 -> "I" + U+0307); stripping
 * `\p{M}` removes the freed marks; `toLowerCase` finishes the fold. Applied to the GATE ONLY.
 *
 * ── DELIBERATELY HIGH-RECALL ─────────────────────────────────────────────────────────
 * Mark-stripping also folds `café` -> `cafe`, so a token `cafe` now HITS on `café`. That is
 * MORE recall on a fail-closed publish fence — a false positive HALTS a publish, the safe
 * direction, and the benign-collision registry exists precisely to adjudicate such pairs.
 * This function MUST NOT be used to rewrite content: it is not a scrub, and normalizing the
 * SCRUBBER would rewrite published bytes (the corruption class `a24b9016` fixed).
 *
 * @param {string} s
 * @returns {string} the folded form — for MATCHING only, never for emission
 */
export function foldForGate(s) {
  return String(s).normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
}

const BASE64_CH = /[A-Za-z0-9+/=]/;

/**
 * The ONE minimum length for a dynamic gate token, enforced at DERIVE time so no consumer has to
 * invent one. See the tenant-denylist push in `deriveDynamicTokens` for why it lives here and why
 * a shorter token is unusable rather than merely risky.
 */
export const TENANT_TOKEN_MIN_LEN = 3;

/**
 * True IFF the match at `[idx, idx+len)` sits STRICTLY INSIDE an opaque base64 payload.
 *
 * Why this exists: the word-boundary class is `[A-Za-z0-9]`, but base64's alphabet also contains
 * `+`, `/` and `=` — so those characters READ AS WORD BOUNDARIES, and a short tenant token
 * coincidentally occurring inside a base64 blob (`…Yd+<tok>+wbg30…`) satisfies the bounded matcher
 * and gets rewritten, CORRUPTING the payload. Boundedness offers base64 no protection at all.
 *
 * The three conditions are each load-bearing, and the alternative remedy was REJECTED ON
 * MEASUREMENT rather than on taste. Widening the boundary class to `[A-Za-z0-9+/=]` also stops the
 * base64 match, but `/` is a PATH separator: measured over the tracked tree it would stop scrubbing
 * 117 matches, and every one read was GENUINE identity in path position (`<org>/<tenant>`,
 * `<org>/<tenant>_backend`). That is a fence-weakening, so it is not the fix. This predicate stops
 * 4 matches out of 1963 across the whole working tree, and all 4 were read and are opaque blob.
 *
 *   run >= 40 chars   — a real path segment does not reach 40 unbroken base64-alphabet chars;
 *                       mirrors the `{40,}` run length the private-key gate already uses.
 *   run contains + or = — paths and slugs essentially never carry these; base64 payloads almost
 *                       always do. `/` alone is NOT sufficient evidence, precisely because paths
 *                       are full of it.
 *   STRICT interior   — `run.length > len` so a match that IS the whole run is never skipped.
 *                       A coincidence needs surrounding payload; a match with NOTHING around it
 *                       inside the run is the token itself, not an accident of neighbouring
 *                       base64. This protects a long, base64-alphabet, `+`/`=`-carrying TENANT
 *                       token (a denylist entry may be any shape) from being skipped whole.
 *
 * Applied to every `{skipBase64:true}` pair — see the call site, which keys on `opt.skipBase64`
 * and NOTHING ELSE. That is the WHOLE predicate: this function reaches exactly the skipBase64 set.
 *
 * **The flag is its own, and that is the fix.** Until 2026-09-08 the call site keyed this skipper
 * on `opt.bounded`, so the two INDEPENDENT narrowings — word-boundedness and the base64 skip —
 * were one key. A pair that needed only the first silently received the second. That is not a
 * hypothetical: the genesis `root_commit` pair gained `{bounded:true}` on 2026-09-07 to stop it
 * corrupting unrelated 40-hex SHAs, and thereby also became base64-skippable, which nobody
 * intended and no prose recorded. Separating the flags fixes the CAUSE; the earlier round only
 * corrected the prose to match the conflated behaviour, which is why the defect survived it.
 *
 * The live population, re-derivable and not restated as a list: every pair whose third element
 * sets `skipBase64` — today, the tenant-denylist pairs, which carry `{bounded:true, skipBase64:true}`.
 * Identity pairs carry `{bounded:true}` alone and DO reach this function's caller unskipped. Read
 * `deriveDynamicTokens` for the live set; do not trust a category name here.
 *
 * **Before adding `skipBase64` to a NEW pair, enumerate the lanes that apply this scrubber and
 * confirm each one's gate is an unbounded literal-token scan.** That premise is NOT universal —
 * see `deriveDynamicTokens` § 4, where a lane gated by the SHAPE scanner alone is recorded.
 *
 * A previous revision justified STRICT interior as "what keeps an SSH fingerprint safe". That
 * reason was FALSE and is corrected rather than dropped, for the same reason. Fingerprint
 * pairs push NO third element (`scrub.push([h, synthHex(h)])`), so `opt` is undefined, the
 * `opt && opt.bounded` guard at the call site is false, and they take the UNBOUNDED branch —
 * a fingerprint can never reach this function at all. The condition is right; the reason was not.
 */
export function isInsideOpaqueBase64Run(text, idx, len) {
  let s = idx, e = idx + len;
  while (s > 0 && BASE64_CH.test(text[s - 1])) s--;
  while (e < text.length && BASE64_CH.test(text[e])) e++;
  const run = text.slice(s, e);
  return run.length >= 40 && run.length > len && /[+=]/.test(run);
}

/**
 * A STATEFUL skipper with the same verdict as `isInsideOpaqueBase64Run`, memoizing the run bounds
 * across successive matches in ONE `String.replace` pass.
 *
 * Why: the stateless form re-expands the enclosing run on EVERY match, so a file with M matches
 * inside ONE long run costs O(M × runlength). MEASURED on that exact shape (a single contiguous
 * base64 run, the machine-generated `.jsonl` shape where this rule's only 4 real hits live), the
 * stateless form ran 2.8 / 7.8 / 17.7 / 75.9 / 307.8 ms for M = 50 / 100 / 200 / 400 / 800 — a
 * ×4 cost per doubling of M at scale, i.e. quadratic. A publish fence that hangs is a fence that
 * gets bypassed, so the growth is the defect regardless of today's file sizes.
 *
 * Correctness: runs are MAXIMAL, so any index inside a previously-computed `[s, e)` belongs to that
 * same run — the memo can be reused whenever the whole match lies within it, and is recomputed
 * otherwise. `String.replace` scans left-to-right over ONE immutable string, and a fresh skipper is
 * built per pair per text, so the memo can never outlive the string it was computed against.
 */
export function makeOpaqueBase64RunSkipper() {
  let cs = -1, ce = -1, runLen = 0, hasPlusEq = false;
  return function skip(text, idx, len) {
    if (!(idx >= cs && idx + len <= ce)) {
      let s = idx, e = idx + len;
      while (s > 0 && BASE64_CH.test(text[s - 1])) s--;
      while (e < text.length && BASE64_CH.test(text[e])) e++;
      cs = s; ce = e;
      runLen = e - s;
      hasPlusEq = /[+=]/.test(text.slice(s, e));
    }
    return runLen >= 40 && runLen > len && hasPlusEq;
  };
}

export function makeScrubber(dynScrubPairs, { mode, staticScrub = [], preserveSyntheticFixtureHomes = false } = {}) {
  if (mode !== SCRUB_MODES.NEUTRALIZE && mode !== SCRUB_MODES.SUBSTITUTE) {
    throw new Error(
      `identity-scrub makeScrubber: unknown/missing mode ${JSON.stringify(mode)} ` +
      `(expected ${SCRUB_MODES.NEUTRALIZE} or ${SCRUB_MODES.SUBSTITUTE})`,
    );
  }
  let merged;
  if (mode === SCRUB_MODES.NEUTRALIZE) {
    merged = [...dynScrubPairs]; // copy, not alias — the later .sort() must not mutate the caller's array (parity with the SUBSTITUTE branch)
  } else {
    // Static SUBSTITUTE supersedes ONLY a dynamic NEUTRALIZE-sentinel value for the
    // same key (the org-shadowing fix); every other dynamic pair keeps precedence.
    const sentinelKeys = new Set(
      dynScrubPairs.filter(([, v]) => isNeutralizeSentinel(v)).map(([f]) => f),
    );
    const supersede = staticScrub.filter(([f]) => sentinelKeys.has(f));
    merged = [...supersede, ...dynScrubPairs, ...staticScrub];
  }
  const _seen = new Set();
  const keyOf = (f) => (f instanceof RegExp ? f.source : f);
  const pairs = merged
    .sort((a, b) => keyOf(b[0]).length - keyOf(a[0]).length)
    .filter(([f]) => (_seen.has(keyOf(f)) ? false : (_seen.add(keyOf(f)), true)));
  // Boundaries are LETTERS AND DIGITS only: `<tenant>_backend` is a tenant reference
  // (the `_` joins a slug, not a word) and MUST scrub; `httpclient` is one word
  // and stays whole for the benign-collision registry to adjudicate.
  const boundedRe = tokenBoundedRe;
  const homepathRe = makeHomepathRe(); // fresh per scrubber (g-flag lastIndex state)
  // Default: UNCONDITIONAL rewrite (byte-identical to the pre-carve-out behavior).
  // *.test.mjs carve-out: a REPLACE-CALLBACK preserves a match ONLY when its
  // captured username (group 2) is a recognized SYNTHETIC fixture user; any other
  // home — incl. a REAL contributor's — is still rewritten to `/<kind>/<user>`,
  // closing the non-token-home leak (#1141-7 rt1-security).
  const homepathReplace = preserveSyntheticFixtureHomes
    ? (full, kind, username) =>
        SYNTHETIC_FIXTURE_USERS.has(String(username).toLowerCase()) ? full : homepathPlaceholder(full, username)
    : (full, kind, username) => homepathPlaceholder(full, username);
  return (text) => {
    let txt = text;
    for (const [from, to, opt] of pairs) {
      // A RegExp pair's `to` may legitimately BE a function (the cross-repo-receipt pair uses one to
      // rebuild the filename from its captures), so a function is passed through untouched. A
      // STRING `to`, however, went in as a string replacement, where `$&` / `$1` / `` $` `` are
      // INTERPRETED — the same hazard the literal-replacer guard closes on the non-RegExp branch
      // below. It was correct only by accident: today the sole string-valued RegExp pair is
      // synthHex-derived and carries no `$`. Wrapping makes it correct by CONSTRUCTION.
      if (from instanceof RegExp) { txt = txt.replace(from, typeof to === "function" ? to : () => to); continue; }
      // CASE-INSENSITIVE prefilter + replace. The three fences that DETECT a surviving token all
      // lowercase both sides (`edition-output-gate.mjs::assertDisclosureCleanNeutralize`,
      // `publish-to-public.mjs::runIdentityTokenGate`, `scan-synced-disclosure.mjs`'s
      // `customer-identity-token` shape at `new RegExp(alt,"gi")`), while THIS applicator — the
      // only one that NEUTRALIZES — matched case-SENSITIVELY. A token whose on-disk case differed
      // from the SSOT case was therefore detected and never removed: measured, a Title-case tenant
      // token reached a PUBLIC `is_template` repo through all three fences, and 1150 lowercase
      // occurrences of a denylist slug were surviving a differently-cased SSOT entry.
      //
      // Replacement is CANONICAL, never case-preserving: every `to` is a placeholder
      // (`maintainer` / `a downstream tenant` / `<canon-owner>` / synthetic hex) for which source
      // case carries no meaning, and a multi-word placeholder has no well-defined case to preserve.
      // This is also what `clean-instantiate.mjs::neutralizeWholeTree`'s former
      // `[from, lower, upper]` enumeration already produced, so canonical form keeps that
      // behaviour byte-identical while additionally covering Title case, which that enumeration
      // MISSED — and which was the form actually leaking.
      //
      // The replacer is a FUNCTION so `to` is inserted LITERALLY: `String.replace` interprets `$&`
      // / `$1` in a string replacement, whereas the `split(from).join(to)` this supersedes did not.
      // A `to` carrying a `$` would otherwise silently change meaning.
      //
      // MEASURED before landing: no replacement string case-insensitively contains any gate token
      // (0 collisions, checker shown to fire on a planted case), so no pair's output is ever
      // re-matched as another pair's input, and the applicator is IDEMPOTENT
      // (`scrub(scrub(x)) === scrub(x)` over the corpus: 1294 files changed, 0 non-idempotent).
      //
      // That measurement does NOT establish ORDER-INDEPENDENCE, and an earlier revision of this
      // comment claimed it did. The two are different propositions: idempotence asks whether a
      // `to` can become a later `from`; the base64 skip additionally reads the NEIGHBOURING
      // CHARACTERS of a partially-scrubbed `txt`. MEASURED, it IS order-dependent — pairs run
      // longest-`from`-first, and an identity replacement that removes a run-BREAKING character
      // (`pid-canon-owner`, whose `-` splits a run) with an all-base64-alphabet placeholder
      // (`maintainer`) MERGES two fragments into one longer run, flipping a LATER tenant token's
      // skip verdict from scrubbed to skipped.
      //
      // Recorded rather than fixed, because the direction is FAIL-SAFE and the fence is elsewhere:
      // the flip makes the SCRUBBER more permissive, and the GATE is unbounded with no base64 skip,
      // so the surviving token HALTS the publish instead of shipping. Ordering the pairs to remove
      // the coupling would trade a loud halt for a silent rewrite — strictly worse.
      if (!tokenUnboundedRe(from).test(txt)) continue;
      // TWO ORTHOGONAL NARROWINGS, each doing exactly what its name says and NOTHING to the other.
      //
      // `bounded`     chooses the MATCHER: word-bounded, so the token is not rewritten inside an
      //               unrelated identifier (a 40-hex SHA, a UUID). Without it, unbounded.
      // `skipBase64`  chooses whether a match sitting STRICTLY INSIDE an opaque base64 run is
      //               declined. Rewriting there is CONTENT CORRUPTION of a payload, not a leak.
      //
      // They are computed INDEPENDENTLY and composed, rather than nested. An earlier revision of
      // this fix nested the skipper inside the `bounded` branch, which made the real predicate
      // `bounded AND skipBase64` while the docblock claimed it was `skipBase64` alone — so a pair
      // written `{skipBase64:true}` would have silently received NEITHER narrowing. That is the
      // same prose-asserts-what-code-does-not class this whole change exists to close, and it was
      // caught by review of this commit's own diff. Composition makes the four combinations mean
      // what a reader would predict:
      //
      //   {}                             unbounded, no skip   — every identity pair by default
      //   {bounded:true}                 bounded,   no skip   — the genesis root_commit anchor
      //   {bounded:true,skipBase64:true} bounded,   skip      — the tenant-denylist pairs
      //   {skipBase64:true}              unbounded, skip      — no live pair, but it now WORKS
      //
      // `skip` is fresh per pair per text — the memo must never outlive its string.
      const skip = opt && opt.skipBase64 ? makeOpaqueBase64RunSkipper() : null;
      const re = opt && opt.bounded ? boundedRe(from) : tokenUnboundedRe(from);
      // The replacer is a FUNCTION so `to` is inserted LITERALLY: a `to` carrying `$&` or `$1`
      // would otherwise be interpreted as a substitution pattern.
      txt = txt.replace(re, (m, offset, whole) => (skip && skip(whole, offset, m.length) ? m : to));
    }
    return txt.replace(homepathRe, homepathReplace); // structural operator-home-path scrub
  };
}

/**
 * Derive the dynamic (per-repo) identity tokens from `repoDir`'s canonical
 * sources. FAIL-LOUD on a present-but-unparseable denylist/roster — a silently
 * empty gate is fail-OPEN on the exact axis it protects (mirrors the scanner's
 * loadCustomerIdentityShape "never silently disable the guard" contract).
 *
 * @param {string} repoDir absolute path to the repo root whose .claude/ holds
 *        disclosure-tenant-denylist.json + operators.roster.json.
 * @returns {{ scrub: [string,string][], gate: string[] }}
 */
export function deriveDynamicTokens(repoDir) {
  const scrub = [], gate = [];
  // Tokens the operator DECLARED but this function cannot honour — today, denylist entries below
  // TENANT_TOKEN_MIN_LEN. Carried out as a THIRD return key (purely additive; every consumer
  // destructures by name) so a PUBLISH FENCE can fail CLOSED on it. A `console.warn` alone is not
  // enough at a fence: the operator asked for a token to be protected, the system cannot protect
  // it, and publishing anyway ships exactly what they asked to withhold. LENGTHS ONLY, never
  // values — this array is surfaced in operator-visible error text that is not itself scrubbed.
  const unhonoured = [];

  // (1) customer/tenant tokens from the denylist SSOT — gate AND self-scrub (so
  // a NEW tenant token added to the denylist self-scrubs without a STATIC edit).
  const denyPath = path.join(repoDir, ".claude/disclosure-tenant-denylist.json");
  // readRegularFileNoFollow, not `existsSync` + `readFileSync`: those FOLLOWED a symlink (an
  // inbound tree could point this path at any file on the operator's machine), HUNG on a FIFO, and
  // read a DANGLING link as absent — a silently-disabled gate. Only "nothing at the path" is absent
  // now; anything else that is not a regular file is a typed refusal (UnsafeFileReadError).
  const denyTxt = readRegularFileNoFollow(denyPath, { label: "disclosure-tenant-denylist.json", allowAbsent: true });
  if (denyTxt !== null) {
    // jsonParseOrThrow, not JSON.parse + `e.message`: V8's syntax-error text quotes input bytes,
    // and in this file those bytes are the tenant names the gate exists to withhold.
    const parsed = jsonParseOrThrow(denyTxt, "disclosure-tenant-denylist.json");
    // Parseable is not the same as well-formed: the former `.tokens || []` iterated a STRING
    // `tokens` character by character (every char then dropped by the floor) and read `{}`, `[]`,
    // a mis-cased key or a non-string entry as an EMPTY gate. The validator refuses all of those.
    const toks = denylistTokensOrThrow(parsed, "disclosure-tenant-denylist.json");
    for (const t of toks) {
      // BOUNDED: a short tenant token inside an unrelated identifier (the shape
      // the benign-collision registry adjudicates) must NOT be cut out of the
      // word — the glued remainder hands a reader the token by subtraction,
      // which is the exact leak the scan's word-bounded shape and the benign-
      // collision registry exist to avoid (measured, docket round 7). The gate
      // still sees the token; the registry adjudicates the in-word host.
      // FLOOR AT DERIVE TIME (2026-09-08). This was the ONLY unfloored gate push in this
      // function — every roster-side push already floors at `> 2` (pid, per-key fields, genesis
      // values) or higher (root_commit `{7,64}`, fingerprints `>= 16`). Leaving this one open let
      // each CONSUMER invent its own answer, and measured on 2026-09-08 three of them had three
      // DIFFERENT ones: `edition-output-gate` no floor at all, `publish-to-public` `>= 2`,
      // `clean-instantiate` `>= 3` — the last fail-OPEN at the ceremony whose entire job is to
      // assert ZERO canon identity. A floor is a property of the TOKEN SET, not of a fence; the
      // producer states it once, here, and the consumers no longer disagree.
      //
      // Value `>= 3` is the LOWEST minimum any other push site already produces, not a value they
      // all "match" — an earlier revision said "matches what the other five push sites enforce" and
      // both the count and the verb were wrong. Measured: four sites guard `> 2` (pid, per-key
      // fields, genesis values, PGP localpart); separator-variants `>= 5`; `root_commit` `{7,64}`;
      // fingerprints `>= 16`; the `SHA256:` prefix is a fixed 13. Two more push from
      // `harvestPgpUid` with NO explicit guard at all — their minima (>=6, >=5) are implied by the
      // regexes that produced them, so the invariant holds but a reader auditing it will find no
      // floor there. That is why the producer invariant is PINNED by a test rather than argued here.
      //
      // It is also the only usable value: a 2-char token substring-matches nearly every file in a
      // tree, so admitting one would red `assertZero` on noise and make `/clean-instantiate`
      // unrunnable.
      //
      // The drop is LOUD, and that is load-bearing. Filtering silently would trade a LOCALIZED
      // fail-open (one fence) for a GLOBAL one (the token vanishes for every consumer at once,
      // with nothing to report it) — strictly worse. Lengths are named, never the token values:
      // the values are the secret this whole function exists to protect.
      const tt = typeof t === "string" ? t.trim() : "";
      if (tt && tt.length < TENANT_TOKEN_MIN_LEN) {
        unhonoured.push({ reason: "below-min-length", length: tt.length, floor: TENANT_TOKEN_MIN_LEN });
        console.warn(
          `[identity-scrub] DROPPED a disclosure-tenant-denylist token of length ${tt.length}: ` +
          `below the ${TENANT_TOKEN_MIN_LEN}-char floor, so it is NOT in the gate and NOT self-scrubbed. ` +
          `A token this short substring-matches ordinary text and would make assert-zero unrunnable. ` +
          `Lengthen the entry or scrub that surface another way — this token is currently protecting nothing.`,
        );
        continue;
      }
      // Push `tt`, NOT `t`. The floor above measures the TRIMMED value, so pushing the raw one
      // installs a token whose length was never the one checked. Measured before the fix: a
      // denylist entry `"  AcmeCorp  "` (a spreadsheet paste) passed the floor on its trimmed
      // length and then entered BOTH the gate and the scrub pair with its padding, so the gate
      // substring-scanned for `"  acmecorp  "` — which occurs in no ordinary prose — while
      // `AcmeCorp` in a README was neither gated nor scrubbed. The publish reported ok:true with a
      // non-zero token count, so the operator saw a green run with the token nominally covered.
      // Found independently by BOTH reviewers of this change's own diff.
      if (tt) { gate.push(tt); scrub.push([tt, SCRUB_PLACEHOLDER.TENANT, { bounded: true, skipBase64: true }]); }
    }
  }

  // (2) operator identity from the roster.
  const rosterPath = path.join(repoDir, ".claude/operators.roster.json");
  // Same reader, same reasons as the denylist above (a FIFO roster hung the derive; a symlinked one
  // was parsed from out of tree — both measured).
  const rosterTxt = readRegularFileNoFollow(rosterPath, { label: "operators.roster.json", allowAbsent: true });
  if (rosterTxt !== null) {
    const txt = rosterTxt;
    // Same reason as the denylist parse above: the roster's bytes are identity values.
    const r = jsonParseOrThrow(txt, "operators.roster.json");
    // Genesis and trust-anchor SHAPE is checked BEFORE any harvest, for the same reason person
    // shape is: a malformed value is otherwise skipped by a `typeof === "string"` guard and its
    // identity silently leaves the gate. Messages are type/index-only.
    const gProblem = genesisShapeProblem(r && typeof r === "object" ? r.genesis : undefined);
    if (gProblem) {
      throw new Error(
        `operators.roster.json has a malformed genesis: ${gProblem} — refusing to proceed ` +
          `with a silently-partial identity gate.`,
      );
    }
    const aProblem = trustAnchorsShapeProblem(r);
    if (aProblem) {
      throw new Error(
        `operators.roster.json has a malformed trust anchor: ${aProblem} — refusing to proceed ` +
          `with a silently-partial identity gate. Its fingerprint and PGP UIDs cannot be harvested.`,
      );
    }
    // The CANONICAL roster shape is a map (person_id → record, schema:59), so the
    // person_id is the KEY, not a field. The pre-W2 derive iterated VALUES only,
    // never gating the map-key person_id — the same latent-gap class as the
    // principal omission below (canon's publish passed only because the org-slug
    // catch-all incidentally covered it). Iterate ENTRIES so the key is harvested.
    // BOTH collections, merged — see rosterPersonEntries.
    const entries = rosterPersonEntries(r);
    const fps = new Set();
    for (const [entryIndex, [pid, p]] of entries.entries()) {
      const pidTok = personIdToken(pid);
      if (pidTok) { gate.push(pidTok); scrub.push([pidTok, SCRUB_PLACEHOLDER.LOGIN]); }
      if (!p || typeof p !== "object") continue;
      // S61 CORRECTION (HIGH-1) — this path REFUSES LOUDLY; it does NOT skip.
      //
      // An earlier S61 revision applied the same skip-never-throw fence used at
      // the fold resolvers. That was WRONG HERE, and inverted the safe
      // direction. The general rule holds only where non-resolution is wired to
      // REFUSE; on this path non-resolution is wired to PERMIT.
      //
      // MEASURED: `deriveDynamicTokens` feeds the disclosure scrub + token gate,
      // and `scripts/publish-to-public.mjs` calls it inside a try whose catch
      // (:273) does `rmSync(stage); throw e;` — it RE-THROWS. So a throw ABORTS
      // THE PUBLISH: nothing is written, therefore nothing leaks. Fail-CLOSED.
      // Skipping instead lets the publish PROCEED with a token set missing this
      // person's `keys[].fingerprint` and every PGP UID in `keys[].pubkey` —
      // real identity shipped unscrubbed and ungated. The `fps.size === 0`
      // fallback below does NOT cover it (it fires only when NO fingerprint was
      // harvested, so a MIXED roster slips through) and cannot match SSH
      // `SHA256:` fingerprints at all.
      //
      // Throwing IS the protection on this path, and it is this module's own
      // established idiom: the unparseable-roster and unparseable-denylist arms
      // above both throw "refusing to proceed with a silently-disabled gate",
      // and `test-harness/tests/identity-scrub.test.mjs` pins BOTH as contract.
      const shapeProblem = personShapeProblem(p);
      if (shapeProblem) {
        // The message embeds NO identity token. This function GATES and SCRUBS
        // person_id, display_id, github_login and principal ALIKE (see the
        // harvest below), so echoing ANY of them is the one place this module
        // would emit what it exists to suppress — and a refusal message is
        // exactly the string most likely to be pasted into an issue.
        //
        // An earlier revision used `display_id` on the stated ground that it
        // "carries no authority". That reason is WITHDRAWN: it is true but
        // irrelevant. The axis that makes echoing unsafe is DISCLOSURE, and on
        // that axis this module treats display_id and person_id identically.
        //
        // The ORDINAL position in the merged persons/operators list (persons
        // first, then operators — rosterPersonEntries) is not an identity token at
        // all, and it is what someone editing the roster actually needs to find
        // the entry. It is also well-defined on the array-roster branch, where
        // the map key is null and `pid` would have rendered the literal 'null'.
        const locator = `entry #${entryIndex} (0-based) in the merged persons/operators list`;
        // `shapeProblem` is TYPE-ONLY by construction (personShapeProblem never echoes a value),
        // and for the non-array-keys case it keeps the historical wording
        // "has a person with a non-array keys field".
        throw new Error(
          `operators.roster.json has a person with a ${shapeProblem} ` +
            `(${locator}) — refusing to proceed ` +
            `with a silently-partial identity gate. Its identity fields, key fingerprints ` +
            `and PGP UIDs cannot all be harvested, so continuing would scrub and gate an ` +
            `INCOMPLETE token set.`,
        );
      }
      for (const k of (Array.isArray(p.keys) ? p.keys : [])) {
        // verified_id = GPG 40-hex OR SSH "SHA256:base64" (roster schema:120-123).
        // The fingerprint IS the authenticating identity regardless of algorithm;
        // harvest any non-trivial value, not just hex (HIGH-1: the prior
        // ^[0-9A-Fa-f]{16,}$ regex silently dropped every SSH verified_id).
        // Every written form (literal + compact hex) goes through `fps`, so each gets the same
        // scrub pair and gate treatment — see fingerprintForms.
        if (k) for (const f of fingerprintForms(k.fingerprint)) fps.add(f);
        // (3) NAME + EMAIL from each parsed pubkey's PGP UID packets.
        if (k && typeof k.pubkey === "string") harvestPubkeyIdentity(k.pubkey, gate, scrub);
      }
      // display_id/github_login/person_id are the GitHub-provider bindings;
      // `principal` is the azure-devops Entra UPN binding (roster schema:84) —
      // NEW in W2: the pre-W2 derive omitted it, so an ADO-provider owner's UPN
      // slipped both the publish gate AND (absent this) the ceremony gate.
      harvestPersonIdFields(p, gate, scrub);
    }
    // Trust anchors (roster schema `trust_anchors[]`, a top-level sibling of `persons`) carry a
    // signing key exactly like a person key: the fingerprint goes through `fps` (same scrub pair,
    // gate, SSH-prefix handling) and the pubkey's PGP UIDs through harvestPgpUid. Neither the
    // harvest nor the scanner read them before, so an anchor's identity was never gated.
    for (const a of rosterTrustAnchors(r)) {
      for (const f of fingerprintForms(a.fingerprint)) fps.add(f);
      if (typeof a.pubkey === "string") harvestPubkeyIdentity(a.pubkey, gate, scrub);
    }
    if (fps.size === 0) for (const h of (txt.match(/[0-9A-F]{40}/g) || [])) fps.add(h); // fallback only
    for (const h of fps) {
      scrub.push([h, synthHex(h)]);
      gate.push(h);
      // The truncated prose form a maintainer writes in a comment
      // (`SHA256:<prefix>…`) carries a 36-bit correlation handle to the same key;
      // it is scrubbed by prefix and gated by the same prefix (measured, docket
      // round 7: one such comment survived the exact-string pair).
      // Prefix matched case-INSENSITIVELY: a roster value written `sha256:<body>` is the same key
      // and previously got no truncated form. The pushed gate token and scrub replacement keep
      // the canonical `SHA256:` spelling; the `gi` scrub regex below already covers any case.
      const ssh = h.match(/^SHA256:([A-Za-z0-9+/=]{6,})$/i);
      if (ssh) {
        const pre = ssh[1].slice(0, 6);
        // `gi`, not `g`: the GATE pushes the 13-char `SHA256:<pre>` string below and matches it
        // case-INSENSITIVELY, so a `g`-only scrub pair reproduced this file's own defect one level
        // down — a case variant of the truncated prose form was DETECTED and never NEUTRALIZED.
        // Measured at the time of the fix: no such variant exists in the corpus (delta 0 on every
        // surface), so this closes a LATENT gap rather than a live leak. The `[A-Za-z0-9+/=]` class
        // is already case-covering; `i` only widens the literal `SHA256:` prefix and `<pre>`.
        scrub.push([new RegExp("SHA256:" + pre.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[A-Za-z0-9+/=]*(?:…|\\.\\.\\.)?", "gi"), "SHA256:" + synthHex(h).slice(0, 8) + "…"]);
        gate.push("SHA256:" + pre);
      }
    }

    // (4) genesis trust-root identity — the brief's "genesis trust-root + owner
    // identity" axes (CRIT-1: the pre-fix derive harvested NEITHER, so the canon
    // owner login AND the trust-root root_commit SHA escaped both fences — the
    // publish fence only caught the owner via the hand-maintained EXTRA_IDENTITY
    // static list, and root_commit had NO coverage on either path). EXCLUDE the
    // placeholder sentinels (PLACEHOLDER- owner / all-zero root_commit) so a
    // re-derive over a cleared tree harvests nothing.
    const g = (r && r.genesis) || {};
    // CONVENTION: angle-bracket scrub replacements ("<...>") are RESERVED for neutralize
    // sentinels — makeScrubber's SUBSTITUTE mode lets a static substitute supersede a dynamic
    // pair ONLY when its value is angle-wrapped (isNeutralizeSentinel). A future dynamic pair
    // MUST NOT adopt angle-bracket form for a real (non-superseding) substitution target.
    for (const [val, repl] of [[g.repo_owner, SCRUB_PLACEHOLDER.CANON_OWNER], [g.ado_project, SCRUB_PLACEHOLDER.ADO_PROJECT]]) {
      // Trimmed BEFORE the floor and pushed trimmed, as person ids are (`personIdToken`): a
      // padded value would otherwise gate and scrub only text carrying the same padding.
      const v = typeof val === "string" ? val.trim() : "";
      if (v.length > 2 && !v.startsWith("PLACEHOLDER-")) { gate.push(v); scrub.push([v, repl]); }
    }
    // `{7,64}` MIRRORS the roster schema (`operators.roster.schema.json::genesis.root_commit`,
    // `pattern: "^[0-9a-f]{7,64}$"`), so a 7-char abbreviated anchor is a SCHEMA-VALID config and
    // reaches here without any malformed input. The floor stays at 7 DELIBERATELY: `gate.push`
    // and `scrub.push` are the same statement, so raising it to 12 would drop a schema-valid
    // 7..11-char anchor from the GATE as well as the scrub — fail-OPEN on the disclosure axis
    // this fence exists to hold, which is strictly worse than the corruption below.
    //
    // `{bounded:true}` is what fixes that corruption. A plain-string pair is applied with
    // `tokenUnboundedRe` — `new RegExp(escape(from),"gi")`, an UNBOUNDED case-INSENSITIVE
    // substring matcher — so the anchor was rewritten wherever it occurred, including STRICTLY
    // INSIDE an unrelated 40-hex SHA, digest, or UUID. That is CONTENT CORRUPTION of published
    // output, not a leak. MEASURED before landing: with `abc1234` configured,
    // `5f3abc1234e0e1e2e3e4e5e6e7e8e9eaebecedeeef` became `5f3deadbeee0e…`.
    //
    // A LENGTH FLOOR does NOT close this class, which is why one is not used: a 12-char anchor
    // embedded in a 40-hex SHA still corrupts (measured identically), so `{12,64}` would only
    // lower the collision PROBABILITY while paying the gate cost above. Boundedness closes it
    // structurally at EVERY length, because a hex neighbour is alphanumeric and so fails
    // `tokenBoundedRe`'s `(?<![A-Za-z0-9])…(?![A-Za-z0-9])`.
    //
    // `{bounded:true}` USED TO buy a SECOND narrowing — the opaque-base64 skip — because the call
    // site keyed the skipper on `bounded`. That conflation was the defect, and it is FIXED as of
    // 2026-09-08: the skipper now keys on its own `skipBase64` flag. `root_commit` carries
    // `{bounded:true}` ALONE, so it gets the SHA-corruption protection it needed and keeps full
    // base64-interior scrub coverage. The tenant-denylist pairs carry `{bounded:true,
    // skipBase64:true}` and are byte-unchanged. Pinned bipolar in `identity-scrub.test.mjs` § M8:
    // re-conflating the flags reds one pole, dropping the tenant skip reds the other.
    //
    // Narrowing the SCRUBBER is FAIL-SAFE **only on a lane whose GATE is an unbounded literal-
    // token scan.** WHICH LANES THOSE ARE is a query result, and it is therefore no longer
    // written here. The block below is GENERATED by `.claude/bin/census-build.mjs` from the
    // corpus and refuses to go stale (`--check` exits 1). This is not tidiness: the hand-written
    // census it replaces was WRONG TWICE — once naming four consumers under one floor where
    // there were three consumers under three DIFFERENT floors plus a dead-code entry, and once
    // written in the present tense while the SAME commit deleted two of the floors it named.
    // Both were caught only by adversarial review, and both were mechanically derivable. Read
    // the block for WHO consumes this function; read the prose around it for what that MEANS,
    // which no query answers.
    //
    // CENSUS:BEGIN CONSUMER-CENSUS — generated by .claude/bin/census-build.mjs — DO NOT EDIT BY HAND
    // Regenerate: node .claude/bin/census-build.mjs --write   ·   Verify: --check (exit 1 = STALE)
    //
    // SUBJECT `deriveDynamicTokens`, returning { scrub, gate, unhonoured } — the keys are READ OUT of the producer's own return statement, not typed.
    // INPUT SET — DISCOVERED, never declared: `git grep -l --untracked -F deriveDynamicTokens -- *.mjs *.js`
    // matched 18 file(s) carrying 49 call site(s). The manifest declares the SYMBOL,
    // the GLOBS and the TARGET; the FILES, the CALL SITES and every column below are found.
    //
    // RUNTIME CONSUMERS (6):
    //   .claude/bin/clean-instantiate.mjs:457 ::snapshotCanonTokens
    //       reads: gate (destructured)
    //       length compares in fn: none
    //       callers of snapshotCanonTokens: 0 — DEAD CODE on this tree
    //   .claude/bin/clean-instantiate.mjs:467 ::snapshotCanonIdentity
    //       reads: gate, scrub, unhonoured (destructured)
    //       length compares in fn: none
    //       callers of snapshotCanonIdentity: 1 (.claude/bin/clean-instantiate.mjs:964)
    //   .claude/bin/edition-emit.mjs:477 ::makeClientTemplateScrubber
    //       reads: scrub (destructured)
    //       length compares in fn: none
    //       callers of makeClientTemplateScrubber: 7 (.claude/bin/edition-emit.mjs:541, .claude/bin/edition-emit.mjs:542, .claude/bin/edition-emit.mjs:1065, .claude/bin/fork-conference-pack.mjs:11842, …)
    //   .claude/bin/lib/edition-output-gate.mjs:348 ::assertDisclosureCleanNeutralize
    //       reads: gate (destructured)
    //       length compares in fn: hits.length >= CAP
    //       callers of assertDisclosureCleanNeutralize: 9 (.claude/bin/lib/edition-output-gate.mjs:543, .claude/test-harness/tests/disclosure-adjudication.test.mjs:319, .claude/test-harness/tests/disclosure-adjudication.test.mjs:345, .claude/test-harness/tests/disclosure-adjudication.test.mjs:414, …)
    //   scripts/publish-to-public.mjs:137 ::makeScrubber
    //       reads: scrub (destructured)
    //       length compares in fn: none
    //       callers of makeScrubber: UNDETERMINED — the name is declared 2× in this corpus (.claude/bin/lib/identity-scrub.mjs:541, scripts/publish-to-public.mjs:136), so a name search cannot attribute a call to THIS one
    //   scripts/publish-to-public.mjs:300 ::runIdentityTokenGate
    //       reads: gate, unhonoured (destructured)
    //       length compares in fn: t.length < TENANT_TOKEN_MIN_LEN · t.length >= TENANT_TOKEN_MIN_LEN · hits.length === 0
    //       callers of runIdentityTokenGate: 10 (.claude/bin/edition-emit.mjs:613, .claude/bin/edition-emit.mjs:875, .claude/bin/edition-emit.mjs:964, .claude/test-harness/tests/disclosure-adjudication.test.mjs:330, …)
    //
    // NON-RUNTIME CALL SITES (43 across 5 file(s)) — a DERIVED predicate:
    // under a test-harness/ or audit-fixtures/ directory, or a basename ending .test.mjs/.test.js.
    //   .claude/audit-fixtures/consumer-census/run.mjs — 5 (5 UNDETERMINED)
    //   .claude/test-harness/tests/disclosure-adjudication.test.mjs — 1
    //   .claude/test-harness/tests/edition-emit.test.mjs — 2
    //   .claude/test-harness/tests/identity-scrub.test.mjs — 32
    //   .claude/test-harness/tests/roster-keys-shape-fence.test.mjs — 3
    //
    // UNDETERMINED OCCURRENCES (5) — reported, never dropped and never guessed:
    //   .claude/audit-fixtures/consumer-census/run.mjs:74 — two independent classifiers disagree on whether this occurrence is code (mask=prose, line-shape=code)
    //   .claude/audit-fixtures/consumer-census/run.mjs:91 — two independent classifiers disagree on whether this occurrence is code (mask=prose, line-shape=code)
    //   .claude/audit-fixtures/consumer-census/run.mjs:104 — two independent classifiers disagree on whether this occurrence is code (mask=prose, line-shape=code)
    //   .claude/audit-fixtures/consumer-census/run.mjs:284 — two independent classifiers disagree on whether this occurrence is code (mask=prose, line-shape=code)
    //   .claude/audit-fixtures/consumer-census/run.mjs:421 — two independent classifiers disagree on whether this occurrence is code (mask=prose, line-shape=code)
    //
    // WHAT THIS INSTRUMENT CANNOT SEE — name it, do not read silence as absence:
    //   · a length compare is reported wherever it sits in the enclosing function; this tool does
    //     NOT decide whether it constrains the token set. Read the hit, not the column.
    //   · a caller reached other than by a literal `NAME(` in code — a dynamic dispatch, a
    //     re-export under another name, a consumer outside this repo — counts as 0 here.
    //   · a consumer in a file the globs do not match (*.mjs, *.js).
    //   · a call site inside census-build.mjs itself — the instrument excludes itself from the
    //     population it measures, so it cannot report on its own use of the symbol.
    //   · INDIRECT reach: a file that imports a consumer inherits that lane's behaviour and is
    //     not a call site, so it does not appear as a row.
    //
    // input_digest: e1a5caf8dacc8c33
    // generated_from_sha: f460e38d2062e488fc97d5bc1602cb568020bed5
    // CENSUS:END CONSUMER-CENSUS
    //
    // The block does NOT answer the question this paragraph asks of every row in it: is that
    // lane's gate an unbounded literal-token scan? That is a judgment about a DIFFERENT file and
    // a comment here cannot vouch for it. What the block does settle is which lanes there are to
    // ask about, and whether one of them is reached by nobody at all.
    //
    // A floor is a property of the TOKEN SET, not of a fence — which is why the one floor,
    // `TENANT_TOKEN_MIN_LEN`, is applied ONCE at derive time above rather than reinvented per
    // consumer, and why a `length compares in fn` row in the block is evidence about that
    // function, never by itself a claim that the comparison constrains the token set.
    //
    // On every consumer an anchor embedded in-word still HALTS the publish rather than shipping —
    // consumers no longer each invent an answer. On all of them an anchor embedded in-word still
    // HALTS the publish rather than shipping — the deliberate gate/scrubber asymmetry the tenant
    // denylist pairs rely on, recorded from the gate's side in `edition-output-gate.mjs` LAYER 3.
    // Do not make the two agree.
    //
    // **That premise is NOT universal, and stating it unqualified was the defect.** A lane that
    // applies this NEUTRALIZE scrubber but gates with the SHAPE scanner alone
    // (`scan-synced-disclosure.mjs`) has NO unbounded literal-token fence: the scanner holds
    // zero secret tokens by design, so it carries no genesis-anchor shape in ANY position.
    // MEASURED: a planted file carrying the anchor both standalone AND base64-embedded produced
    // ZERO findings on the same invocation where an operator-home-path control fired.
    // `fork-conference-pack.mjs` IS such a lane. Do NOT read this paragraph as saying it is fixed:
    // whether it carries an unbounded literal-token gate is a claim about a DIFFERENT file, and a
    // comment here cannot vouch for it. Re-derive it — grep that file for `runIdentityTokenGate`
    // and read the hit in context — rather than trusting this line. What THIS commit changed is
    // narrower and is the whole of what it claims: the identity anchor no longer carries the
    // base64 skip, so the position that lane was most exposed on is scrubbed rather than shipped.
    // The in-word position is NOT closed by the scrubber and is not meant to be.
    // Before bounding a NEW pair, enumerate the lanes that apply the scrubber and confirm each
    // one's gate is unbounded — do not infer it from this file.
    // TRIMMED before the regex and pushed trimmed: a padded root was previously dropped outright
    // (the anchored regex failed on the padding), leaving the trust-root SHA ungated.
    const rc = typeof g.root_commit === "string" ? g.root_commit.trim() : "";
    if (/^[0-9a-fA-F]{7,64}$/.test(rc) && !/^0+$/.test(rc)) {
      gate.push(rc); scrub.push([rc, synthHex(rc), { bounded: true }]);
    }
  }
  // A cross-repo authorization receipt FILENAME is a loom process token: it names the
  // sibling repo (or its purpose) and the date the read was granted. The date and
  // mode survive; the target slug is replaced (measured: one shipped verbatim in a
  // hook comment while every docket page had already fenced the class).
  // `gi` for parity with every other pair in this function: a receipt filename written in any other
  // case is the same loom process token. The replacement is emitted in canonical lower case, and
  // `mode` is lower-cased so an `-READ.md` receipt does not round-trip its casing into the output.
  scrub.push([/\bcross-repo-authorized-(\d{4}-\d{2}-\d{2})-[A-Za-z0-9._-]*?-?(read|write)?\.md\b/gi, (_m, d, mode) => `cross-repo-authorized-${d}-<target>${mode ? "-" + String(mode).toLowerCase() : ""}.md`]);
  return { scrub, gate, unhonoured };
}

/**
 * The per-person identity fields the roster harvest reads. ONE list, used by
 * `deriveDynamicTokens` and `personIdentityTokens` alike, so the two cannot drift.
 */
export const PERSON_ID_FIELDS = Object.freeze(["display_id", "github_login", "person_id", "principal"]);

/** Type name for a JSON value, distinguishing null and array. Never the value itself. */
function jsonTypeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** A high surrogate not followed by a low one, or a low surrogate not preceded by a high one. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * JSON.parse that refuses WITHOUT echoing input. V8's syntax-error message quotes an excerpt of
 * the input (`Unexpected token 'q', ..."tok": qzsecret}" is not valid JSON`), and the files this
 * module parses hold exactly the identity and tenant values it exists to withhold — a reviewer
 * measured a denylist token printed on stderr through the old `${e.message}` interpolation. The
 * refusal carries only the label and, when V8 reports one, the numeric position (and the line
 * computed from it); otherwise `position unknown`. Keeps `present but unparseable` so existing
 * assertions match.
 *
 * @param {string} text
 * @param {string} label  file label for the message
 * @returns {unknown}
 */
export function jsonParseOrThrow(text, label) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const m = /\bposition (\d+)/.exec(String(e && e.message));
    let where = "position unknown";
    if (m) {
      const pos = Number(m[1]);
      const line = String(text).slice(0, pos).split("\n").length;
      where = `position ${pos}, line ${line}`;
    }
    throw new Error(
      `${label} present but unparseable (JSON syntax error at ${where}) — refusing to proceed ` +
        `with a silently-disabled gate.`,
    );
  }
}

/**
 * Shape problem of the roster's `genesis` block, or null. TYPE/LENGTH-only text, never a value.
 * undefined/null `g` is not a problem (a roster may carry no genesis). A problem is: `g` not a
 * plain object; `repo_owner` or `ado_project` present, non-null and not a string; `root_commit`
 * present, non-null and either not a string or, after trim, not 7–64 hex characters (the schema's
 * `^[0-9a-f]{7,64}$`, case-widened as the harvest is). Without this, each of those was skipped by
 * the harvest's `typeof === "string"` / regex guard and the trust-root identity left the gate.
 *
 * @param {unknown} g
 * @returns {string|null}
 */
export function genesisShapeProblem(g) {
  if (g === undefined || g === null) return null;
  if (jsonTypeOf(g) !== "object") return `genesis is ${jsonTypeOf(g)}, not an object`;
  for (const f of ["repo_owner", "ado_project"]) {
    const v = g[f];
    if (v !== undefined && v !== null && typeof v !== "string") return `non-string genesis.${f}, got ${jsonTypeOf(v)}`;
  }
  const rc = g.root_commit;
  if (rc !== undefined && rc !== null) {
    if (typeof rc !== "string") return `non-string genesis.root_commit, got ${jsonTypeOf(rc)}`;
    if (!/^[0-9a-fA-F]{7,64}$/.test(rc.trim())) return `genesis.root_commit is not 7-64 hex characters after trim (length ${rc.trim().length})`;
  }
  return null;
}

/**
 * Shape problem of ONE signing-key record (a person's `keys[i]` or a `trust_anchors[i]`), or
 * null. `where` locates it by INDEX only. A problem is: not a plain object; `fingerprint` present,
 * non-null and not a string or shorter than 16 after trim; `pubkey` present, non-null and not a
 * string (an array-of-lines armor was dropped silently by harvestPgpUid, so its UID never gated).
 */
function keyEntryShapeProblem(k, where) {
  if (jsonTypeOf(k) !== "object") return `non-object ${where} entry, got ${jsonTypeOf(k)}`;
  const fp = k.fingerprint;
  if (fp !== undefined && fp !== null) {
    if (typeof fp !== "string") return `non-string ${where}.fingerprint, got ${jsonTypeOf(fp)}`;
    if (fp.trim().length < 16) return `${where}.fingerprint shorter than 16 characters, got length ${fp.trim().length}`;
  }
  const pk = k.pubkey;
  if (pk !== undefined && pk !== null && typeof pk !== "string") return `non-string ${where}.pubkey, got ${jsonTypeOf(pk)}`;
  return null;
}

/** The roster's `trust_anchors[]` entries that are plain objects (shape is validated separately). */
function rosterTrustAnchors(r) {
  if (jsonTypeOf(r) !== "object" || !Array.isArray(r.trust_anchors)) return [];
  return r.trust_anchors.filter((a) => jsonTypeOf(a) === "object");
}

/**
 * Shape problem of the roster's top-level `trust_anchors` (schema: an array of objects with
 * `fingerprint` + `pubkey`), or null. Absent/null is fine (optional, pre-#583 rosters). Located by
 * index only.
 */
function trustAnchorsShapeProblem(r) {
  if (jsonTypeOf(r) !== "object") return null;
  const ta = r.trust_anchors;
  if (ta === undefined || ta === null) return null;
  if (!Array.isArray(ta)) return `non-array trust_anchors field, got ${jsonTypeOf(ta)}`;
  for (let i = 0; i < ta.length; i++) {
    const p = keyEntryShapeProblem(ta[i], `trust_anchors[${i}]`);
    if (p) return p;
  }
  return null;
}

/**
 * The gate tokens the roster's trust anchors yield, by exactly the rules deriveDynamicTokens
 * applies: each anchor fingerprint's forms (fingerprintForms) and its pubkey's PGP UID
 * names/emails (with separator variants). Like personIdentityTokens it returns the direct tokens
 * only — not the derived `SHA256:<prefix>` truncation, which deriveDynamicTokens adds for every
 * fingerprint. Malformed entries are skipped here; deriveDynamicTokens is where they are refused.
 * Exists so a caller (the scanner) can count anchor tokens as roster-derived.
 *
 * @param {unknown} r  the parsed roster
 * @returns {string[]}
 */
export function trustAnchorTokens(r) {
  const gate = [];
  const scrub = [];
  for (const a of rosterTrustAnchors(r)) {
    for (const f of fingerprintForms(a.fingerprint)) gate.push(f);
    if (typeof a.pubkey === "string") harvestPubkeyIdentity(a.pubkey, gate, scrub);
  }
  return gate;
}

/**
 * Validate a parsed tenant denylist and return its TRIMMED string tokens. Well-formed means: a
 * non-array object whose `tokens` is an array in which EVERY entry is a string that is non-empty
 * after trim. `{"tokens":[]}` is well-formed and returns [].
 *
 * Anything else THROWS. The former `.tokens || []` read a string `tokens` as its characters
 * (each dropped by the length floor), and `{}`, `[]`, a mis-cased `Tokens` key or a non-string
 * entry as an empty gate, so a malformed denylist silently disabled the tenant gate. The message
 * names what was found by TYPE or COUNT only — never a value, because the values are the tenant
 * names this file exists to withhold, and a refusal message is the string most likely to be pasted
 * into an issue. Sub-floor handling stays with the caller (deriveDynamicTokens' `unhonoured`).
 *
 * @param {unknown} parsed  the JSON.parse result
 * @param {string} label    file label for the message (should contain the file name)
 * @returns {string[]}
 */
export function denylistTokensOrThrow(parsed, label = "disclosure-tenant-denylist.json") {
  const refuse = (found) => {
    throw new Error(
      `${label} has the wrong shape: ${found}. Expected an object with a "tokens" array of ` +
        `non-empty strings (disclosure-tenant-denylist.json) — refusing to proceed with a ` +
        `silently-disabled tenant gate.`,
    );
  };
  if (jsonTypeOf(parsed) !== "object") refuse(`top level is ${jsonTypeOf(parsed)}, not an object`);
  if (!Array.isArray(parsed.tokens)) refuse(`"tokens" is ${parsed.tokens === undefined ? "missing" : jsonTypeOf(parsed.tokens)}, not an array`);
  // A LONE surrogate can never match text (no well-formed UTF-16 string contains one), so such a
  // token protects nothing while looking installed. Refused like any other unusable entry.
  // A line break INSIDE the (trimmed) token is refused too: every scan here is line-split, so a
  // multi-line token can never match. Leading/trailing breaks are removed by the trim and are fine.
  const bad = parsed.tokens.filter((t) => typeof t !== "string" || t.trim() === "" || LONE_SURROGATE_RE.test(t) || /[\r\n]/.test(t.trim()));
  if (bad.length) {
    const kind = (t) => (typeof t !== "string" ? jsonTypeOf(t)
      : t.trim() === "" ? "blank string"
        : LONE_SURROGATE_RE.test(t) ? "string with a lone surrogate"
          : "string with a line break");
    const types = [...new Set(bad.map(kind))].join(", ");
    refuse(`${bad.length} of ${parsed.tokens.length} "tokens" entries are not non-empty strings (found: ${types})`);
  }
  return parsed.tokens.map((t) => t.trim());
}

/**
 * The shape problem of ONE roster person record, or null when it is harvestable. TYPE-ONLY text,
 * never a value (the caller embeds it in a refusal). A problem is:
 *   - a PERSON_ID_FIELDS key present, non-null and not a string (e.g. an array `principal`),
 *     which the harvest would otherwise skip — silently dropping that identity;
 *   - `keys` present, non-null and not an array;
 *   - a `keys[]` entry that is not a plain object;
 *   - a key's `fingerprint` present, non-null and not a string, or shorter than 16 after trim;
 *   - a key's `pubkey` present, non-null and not a string (see keyEntryShapeProblem).
 * A null / non-object `p` is NOT a problem: a pid-only entry is legitimate.
 *
 * @param {unknown} p
 * @returns {string|null}
 */
export function personShapeProblem(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  for (const f of PERSON_ID_FIELDS) {
    const v = p[f];
    if (v !== undefined && v !== null && typeof v !== "string") return `non-string ${f} field, got ${jsonTypeOf(v)}`;
  }
  if (p.keys === undefined || p.keys === null) return null;
  if (!Array.isArray(p.keys)) return `non-array keys field, got ${jsonTypeOf(p.keys)}`;
  for (let i = 0; i < p.keys.length; i++) {
    const prob = keyEntryShapeProblem(p.keys[i], `keys[${i}]`);
    if (prob) return prob;
  }
  return null;
}

/**
 * Every `[pid|null, person]` entry a parsed roster carries, from `persons` FIRST and then
 * `operators`, MERGED. The previous `r.persons || r.operators` read only ONE collection, so a
 * roster carrying both silently dropped every `operators` person: none of their tokens were
 * gated or scrubbed (measured: rc=0 with an operators-only person planted).
 *
 * Per collection: an array maps each element to `[null, x]`; any other non-null object maps
 * via `Object.entries` (the canonical map form, pid → record); null/undefined is skipped. Any
 * other type (string, number, boolean) is SKIPPED without throwing — type validation, and the
 * refusal that goes with it, belongs to the caller (the scanner refuses with its own message),
 * so this helper does not duplicate it. A non-object `r` yields `[]`.
 *
 * @param {unknown} r  the parsed roster
 * @returns {Array<[string|null, unknown]>}
 */
export function rosterPersonEntries(r) {
  if (!r || typeof r !== "object") return [];
  const out = [];
  for (const coll of [r.persons, r.operators]) {
    if (coll === null || coll === undefined || typeof coll !== "object") continue;
    if (Array.isArray(coll)) for (const x of coll) out.push([null, x]);
    else for (const e of Object.entries(coll)) out.push(e);
  }
  return out;
}

/**
 * The identity tokens ONE roster person entry yields, using exactly the rules
 * `deriveDynamicTokens` applies to it: the map-key person id and each PERSON_ID_FIELDS value
 * (trimmed, then length > 2 — personIdToken), each key fingerprint (>= 16, literal plus its
 * compact hex form — fingerprintForms), and the PGP UID names/emails (with their
 * separator variants). Genesis values are NOT included — they belong to the repo, not to
 * the person.
 *
 * Exists so a caller can ask "does EVERY person yield an identity?" rather than "does the
 * roster as a whole yield anything?". The whole-set question is answered yes by the genesis
 * owner and root commit alone, which let a person with no harvestable field (an
 * array-form entry keyed only by an unknown field) pass as covered while the scanner could
 * never match them (measured: `{"persons":[{"nick":"carolxyz"}]}` plus a planted
 * `carolxyz wrote this` gave rc=0, 0 findings).
 *
 * @param {string|null} pid  the map key (null for an array-form entry)
 * @param {object} p         the person record
 * @returns {string[]}
 */
export function personIdentityTokens(pid, p) {
  const gate = [];
  const scrub = [];
  const pidTok = personIdToken(pid);
  if (pidTok) gate.push(pidTok);
  if (!p || typeof p !== "object") return gate;
  for (const k of Array.isArray(p.keys) ? p.keys : []) {
    if (k) for (const f of fingerprintForms(k.fingerprint)) gate.push(f);
    if (k && typeof k.pubkey === "string") harvestPubkeyIdentity(k.pubkey, gate, scrub);
  }
  harvestPersonIdFields(p, gate, scrub);
  return gate;
}

/**
 * Push every PERSON_ID_FIELDS token of person `p` (trimmed, floored — personIdToken) and, for the
 * ADO `principal`, its local-part and tenant (harvestPrincipalParts). ONE helper, used by
 * `deriveDynamicTokens` and `personIdentityTokens` alike, so the publish gate, the ceremony and
 * the scanner cannot drift on what a principal yields.
 */
function harvestPersonIdFields(p, gate, scrub) {
  for (const k of PERSON_ID_FIELDS) {
    const tok = personIdToken(p[k]);
    if (!tok) continue;
    gate.push(tok); scrub.push([tok, SCRUB_PLACEHOLDER.LOGIN]);
    if (k === "principal") harvestPrincipalParts(tok, gate, scrub);
  }
}

/**
 * The token a person-id value (the map-key pid or a PERSON_ID_FIELDS value) contributes, or
 * null. TRIM FIRST, then floor, then return the TRIMMED value — the same discipline the
 * tenant-denylist arm applies to `tt`. Flooring the raw value let `"   "` count as an identity
 * (the scanner's "person yields ZERO identity tokens" refusal was bypassed, then the scanner
 * trimmed it to "" and dropped it: measured rc=0, 0 findings) and let `" ab"` clear a floor its
 * content fails; pushing the raw value installed `"  bob  "` as a gate/scrub token that never
 * matches the unpadded name in prose. ONE helper, used by `deriveDynamicTokens` and
 * `personIdentityTokens` alike, so the two cannot drift.
 */
function personIdToken(v) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 2 ? t : null;
}

/**
 * Every form of a roster key fingerprint to harvest. The trimmed LITERAL (>= 16), plus — when it
 * differs and is all-hex of length >= 16 — the COMPACT form: whitespace removed, then a leading
 * `0x`/`0X` removed. A fingerprint written as `gpg --fingerprint` prints it (`0F1E 2D3C …`) or
 * with a `0x` prefix otherwise never yields the compact 40-hex citation, so neither that string
 * nor the prefix/key-ID forms consumers derive from a 40-hex token were ever matched. SSH
 * `SHA256:<base64>` values contain no whitespace and are not hex, so they yield the literal only.
 */
function fingerprintForms(fp) {
  if (typeof fp !== "string") return [];
  const lit = fp.trim();
  if (lit.length < 16) return [];
  const out = [lit];
  const compact = lit.replace(/\s+/g, "").replace(/^0x/i, "");
  if (compact !== lit && /^[0-9A-Fa-f]{16,}$/.test(compact)) out.push(compact);
  return out;
}
