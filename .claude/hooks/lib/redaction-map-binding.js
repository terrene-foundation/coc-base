"use strict";

const fs = require("node:fs");
const { lstatSync, openSync, fstatSync, readSync, closeSync, statSync, realpathSync, constants: FS } = fs;
const path = require("node:path");
const { spawnSync } = require("node:child_process");

/**
 * The typed refusal of `readRegularFileNoFollow` / `readTextOrNull`. `code` is always
 * `ERR_UNSAFE_FILE_READ`; `kind` names WHAT was refused; `label` names the file by the
 * caller's ROLE label or its BASENAME — never by absolute path (which carries
 * `/Users/<operator>/`), and never with any of its bytes.
 *
 *   kind: "absent" | "symlink" | "fifo" | "socket" | "directory" | "char-device" |
 *         "block-device" | "not-regular" | "oversize" | "swapped" | "unreadable"
 */
class UnsafeFileReadError extends Error {
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
const READ_REGULAR_FILE_MAX_BYTES = 8 * 1024 * 1024;

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
function readRegularFileNoFollow(p, {
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
 * The typed refusal of every map operation. The message NEVER carries the map path (it sits
 * under the operator's home) nor any value: entries are named by index only.
 *   kind: "no-path" | "absent" | "inside-work-tree" | "mode-too-open" | "malformed" | "bad-value" |
 *         "bad-category" | "full" | "locked" | "concurrent" | "reserved-chars" | "changed"
 */
class RedactionMapError extends Error {
  constructor(kind, detail) {
    super(`redaction map: ${detail}`);
    this.name = "RedactionMapError";
    this.code = "ERR_REDACTION_MAP";
    this.kind = kind;
  }
}

/**
 * The typed refusal of `spawnGitEnveloped`: the shared git envelope could not be loaded, or no
 * `git` resolved on a TRUSTED path. Its message carries no path and no value.
 */
class GitEnvelopeError extends Error {
  constructor(detail) {
    super(`git envelope: ${detail}`);
    this.name = "GitEnvelopeError";
    this.code = "ERR_GIT_ENVELOPE";
  }
}

let _gitEnvLib = null;
function gitEnvLib() {
  if (_gitEnvLib) return _gitEnvLib;
  let lib;
  try {
    lib = require("./git-subprocess-env.js");
  } catch {
    lib = null;
  }
  // ABSENT and INCOMPATIBLE are different facts; both refuse. There is no PATH / ambient-env
  // fallback: a silently downgraded envelope is worse than a loud stop.
  if (!lib || typeof lib.resolveGitBinary !== "function" || typeof lib.gitEnvForArgs !== "function") {
    throw new GitEnvelopeError("the shared git subprocess envelope could not be loaded, or is incompatible — refusing to spawn an un-enveloped git");
  }
  _gitEnvLib = lib;
  return lib;
}

/**
 * Run `git -C <dir> <args>` INSIDE the shared envelope (`.claude/hooks/lib/git-subprocess-env.js`,
 * loom#1462/#1471): the binary from `resolveGitBinary()` — never a PATH-resolved `git`, which a
 * planted shim would answer — and an env built from CONSTANTS by `gitEnvForArgs()`, so nothing is
 * inherited. `-C <dir>` only picks a DIRECTORY; an inherited GIT_DIR / GIT_WORK_TREE /
 * GIT_INDEX_FILE picks the REPOSITORY, so a git that inherits the caller's environment answers
 * about whatever repository that environment names. This is the ONE git spawn in this module and
 * in `redact.mjs`, which calls it rather than spawning its own.
 *
 * Both output streams are captured, never inherited (a git diagnostic can quote a path). Returns
 * the raw `spawnSync` result; the caller judges `status`. No trusted binary is NOT a clean answer —
 * it THROWS `GitEnvelopeError`, and each caller ranks that tightest.
 *
 * `literalPathspecs: true` adds GIT_LITERAL_PATHSPECS=1 (a constant, not a caller value).
 * `indexFile` is the ONE caller-chosen value the envelope will carry, and only as GIT_INDEX_FILE.
 * It is never read from the environment here: the caller passes an index it has ALREADY validated
 * (redact's `check --staged` hook-index path — a regular file strictly inside this repository's
 * own per-worktree git directory). Every other caller passes nothing and gets the plain envelope.
 * @param {string} dir
 * @param {string[]} args the invocation after `-C <dir>`
 * @param {{encoding?: string, maxBuffer?: number, indexFile?: string|null, literalPathspecs?: boolean}} [opts] `encoding: "buffer"` returns Buffers
 */
function spawnGitEnveloped(dir, args, { encoding = "utf8", maxBuffer = 64 * 1024 * 1024, indexFile = null, literalPathspecs = false } = {}) {
  const lib = gitEnvLib();
  const bin = lib.resolveGitBinary();
  if (!bin) throw new GitEnvelopeError("no 'git' resolved on a trusted path — the literal 'git' is not used as a fallback, because a PATH shim would answer");
  const argv = ["-C", dir, ...args];
  const env = lib.gitEnvForArgs(argv);
  if (indexFile !== null) {
    if (typeof indexFile !== "string" || !path.isAbsolute(indexFile)) throw new GitEnvelopeError("an index file handed to the envelope must be an absolute, already-validated path");
    env.GIT_INDEX_FILE = indexFile;
  }
  // A caller naming FILES BY NAME asks for literal pathspecs: without it `[A-Z]`, `*.md` or `d*`
  // is a wildmatch that answers about OTHER paths (M-W2.1 R2 S3). Per call, never envelope-wide:
  // the shared envelope also serves callers whose pathspecs ARE globs (`hooks/lib/codify-lease.js`
  // `WORKSPACE_JOURNAL_PATHSPEC` = `:(glob)…`, which GIT_LITERAL_PATHSPECS would turn literal).
  if (literalPathspecs === true) env.GIT_LITERAL_PATHSPECS = "1";
  return spawnSync(bin, argv, { encoding, maxBuffer, env, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * The canonical (OS, case-canonical) path of `p`'s nearest EXISTING ancestor (itself if it
 * exists), or null when not even the root resolves. Climbs ONLY past a genuinely ABSENT component
 * (ENOENT and `lstat` sees nothing) and THROWS on anything else: a dangling link or an EACCES /
 * ELOOP component is not "absent", and climbing past it answered about the link's PARENT while
 * the bytes go to the link's TARGET — so a map path through a link into a work tree read as
 * outside one. Both callers read a throw as a refusal. Same semantics as `canonicalPath`.
 */
function nearestRealAncestor(p) {
  const raw = String(p);
  let probe = path.isAbsolute(raw) ? raw : `${process.cwd()}${path.sep}${raw}`; // no lexical ".." (R2 N6)
  for (;;) {
    try {
      return realpathSync.native(probe);
    } catch (e) {
      if (!e || e.code !== "ENOENT") throw e;
      let entryExists = true;
      try { lstatSync(probe); } catch { entryExists = false; /* genuinely absent: climb */ }
      if (entryExists) throw new Error(`nearestRealAncestor: ${JSON.stringify(probe)} exists but does not resolve (a dangling link); refusing to answer past it`);
    }
    const base = path.basename(probe);
    if (base === "." || base === "..") throw new Error(`nearestRealAncestor: ${JSON.stringify(raw)} has a dot segment in its absent part; refusing to collapse it lexically`);
    const up = path.dirname(probe);
    if (up === probe) return null;
    probe = up;
  }
}

/** A `.git` directory or worktree file at canonical `real` or any ancestor, or `real` inside one. */
function markerAtOrAbove(real) {
  for (let d = real; ; d = path.dirname(d)) {
    if (path.basename(d) === ".git") return true;
    try { lstatSync(path.join(d, ".git")); return true; } catch { /* no marker here */ }
    if (path.dirname(d) === d) return false;
  }
}

/**
 * Git's own discovery for `dir`, inside the envelope: no caller GIT_* variable reaches it, so
 * discovery answers about the DIRECTORY, not the caller. With no trusted git the map's location
 * cannot be verified, so it is REFUSED (typed, `inside-work-tree`) — never read as "outside".
 */
function gitDiscover(dir, args) {
  try {
    return spawnGitEnveloped(dir, args);
  } catch (e) {
    if (e instanceof GitEnvelopeError) {
      throw new RedactionMapError("inside-work-tree", `the map's location could not be verified to lie outside a git work tree (${e.message})`);
    }
    throw e;
  }
}

/**
 * True when `p` (which need not exist) resolves INSIDE a git work tree. Three independent tests,
 * any one sufficing (C1 R1 M2):
 *   1. a `.git` entry (directory or worktree file) in any ancestor of the CANONICAL path — the
 *      nearest existing ancestor is resolved with `realpathSync` first (security.md § Path
 *      Containment), and a path that passes THROUGH a `.git` directory counts;
 *   2. `git rev-parse --is-inside-work-tree` run FROM that directory with every GIT_* variable
 *      stripped — git's own discovery;
 *   3. the caller's `GIT_WORK_TREE`, when set, contains the path (an announced external tree).
 * DECLARED BLIND: an external work tree that nothing announces (see DOCUMENTED LIMITS).
 */
function isInsideGitWorkTree(p) {
  let real;
  try {
    real = nearestRealAncestor(p);
  } catch (e) {
    throw new RedactionMapError("inside-work-tree", `the map's location could not be resolved (${(e && e.code) || "a component exists but will not resolve"}), so it cannot be shown to lie outside a git work tree`);
  }
  if (real === null) return false;
  if (markerAtOrAbove(real)) return true;
  let dir = real;
  try { if (!statSync(real).isDirectory()) dir = path.dirname(real); } catch { dir = path.dirname(real); }
  const r = gitDiscover(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (r.status === 0 && String(r.stdout).trim() === "true") return true;
  const gwt = process.env.GIT_WORK_TREE;
  if (typeof gwt === "string" && gwt.trim() !== "") {
    try {
      const root = realpathSync.native(gwt); // the SAME resolver family as `real`
      if (real === root || real.startsWith(root + path.sep)) return true;
    } catch { /* an unresolvable GIT_WORK_TREE contains nothing */ }
  }
  return false;
}

function assertMapPathUsable(p) {
  if (typeof p !== "string" || p.trim() === "") throw new RedactionMapError("no-path", "no map path was given");
  if (isInsideGitWorkTree(p)) {
    throw new RedactionMapError(
      "inside-work-tree",
      "refusing a map path inside a git work tree — the map holds the values it exists to withhold, " +
        "so it must live outside every repository (default ~/.config/coc/redaction-map.json)",
    );
  }
}

let accountHome;
let accountHomeError;
let accountHomeRead = false;
let ignoredMapWarned = false;
function resolveAccountHome() {
  if (accountHomeRead) {
    if (accountHomeError) throw accountHomeError;
    return accountHome;
  }
  accountHomeRead = true;
  let home;
  try { home = require("node:os").userInfo().homedir; }
  catch { accountHomeError = new RedactionMapError("account-home", "the account home could not be resolved"); throw accountHomeError; }
  if (typeof home !== "string" || !path.isAbsolute(home)) {
    accountHomeError = new RedactionMapError("account-home", "the account home is not an absolute path");
    throw accountHomeError;
  }
  return (accountHome = home);
}
function resolveRedactionMapPath() {
  if (!ignoredMapWarned && process.env.COC_REDACTION_MAP !== undefined) {
    ignoredMapWarned = true;
    process.stderr.write("redaction-map: COC_REDACTION_MAP is now ignored; enforcing commands use the account map\n");
  }
  const home = resolveAccountHome();
  const authorityPath = process.platform === "darwin" ? "/Library/Application Support/coc/redaction-authority.json"
    : process.platform === "linux" ? "/etc/coc/redaction-authority.json" : null;
  if (authorityPath) {
    try { lstatSync(authorityPath); }
    catch (e) {
      if (e && e.code === "ENOENT") return { path: path.join(home, ".config", "coc", "redaction-map.json"), explicit: false, mode: "UNPINNED", authorityPath };
      throw new RedactionMapError("authority-unreadable", "the fixed administrator authority could not be inspected");
    }
    throw new RedactionMapError("authority-provisioned", "the fixed administrator authority is present; its protected reader must be provisioned before enforcement can run");
  }
  return { path: path.join(home, ".config", "coc", "redaction-map.json"), explicit: false, mode: "UNPINNED", authorityPath };
}

module.exports = {
  resolveAccountHome,
  resolveRedactionMapPath,
  UnsafeFileReadError,
  statKind,
  O_NONBLOCK,
  READ_REGULAR_FILE_MAX_BYTES,
  readRegularFileNoFollow,
  RedactionMapError,
  GitEnvelopeError,
  spawnGitEnveloped,
  nearestRealAncestor,
  markerAtOrAbove,
  isInsideGitWorkTree,
  assertMapPathUsable,
};
