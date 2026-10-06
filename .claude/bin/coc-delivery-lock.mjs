#!/usr/bin/env node
/**
 * coc-delivery-lock.mjs — the DELIVERY LOCK: which files loom delivered, and are
 * they still the bytes loom delivered?
 *
 * WHY THIS EXISTS. A repo that receives loom's files could not tell which paths
 * under `.claude/` loom delivered and which it authored itself:
 *   - `.claude/.coc-sync-marker` is agent-written YAML with timestamps and counts,
 *     no delivered list — and the disclosure scanner never reads it;
 *   - `.claude/VERSION` holds versions only;
 *   - `.coc/COC.lock` (path + sha256) covers `.coc/` only.
 * A consumer was reduced to hand-maintaining a list of loom paths pinned to blob
 * ids. This file is the machine answer: loom's distribution engine
 * (`sync-tier-aware.mjs::executePlan`) writes `.claude/.coc-delivery.lock` into
 * every target it syncs, on BOTH lanes, and this tool reads it.
 *
 * SHAPE — deliberately the `.coc/COC.lock` shape (emit-coc.mjs::buildLock),
 * extended, never re-invented: canonical JSON, pretty-printed with 2 spaces, LF,
 * no BOM, exactly ONE trailing newline, `files` sorted by path (UTF-16 code-unit
 * order, the same comparator COC.lock uses), each entry `{path, sha256}`.
 *
 *   {
 *     "schema_version": 1,
 *     "kind": "coc-delivery-lock",
 *     "target": "py",                 // the lane target, e.g. py | rs | base
 *     "mode": "build",                // build | use
 *     "loom_sha": "<40-hex>",         // loom HEAD the bytes came from; null = unanchored
 *     "loom_source_clean": true,      // false ⇒ bytes came from an UNCOMMITTED loom tree
 *     "files": [{ "path": ".claude/rules/git.md", "sha256": "<64-hex>" }],
 *     "consumer_owned": [".claude/trust-root.json"],
 *     "retired": [{ "path": ".claude/rules/old.md", "sha256": "<64-hex>" }]
 *   }
 *
 *   files          every path THIS sync delivered, hashed over the DELIVERED bytes
 *                  (after strip / overlay / softening — read back from the target,
 *                  never the loom source). Includes the engine-generated contract
 *                  files (.coc-obsoleted, .coc-xref-absent.json, .coc-cli-emit.yaml).
 *   consumer_owned the manifest's `target_owned:` entries — exact paths, or
 *                  directory prefixes ending in `/` — that loom never writes,
 *                  overwrites or deletes. Listed, never hashed. A file loom
 *                  delivers INTO an owned directory is still in `files`, and
 *                  `files` wins when classifying.
 *   retired        paths an EARLIER delivery listed that this one no longer
 *                  delivers AND that are still on disk (loom could not justify
 *                  deleting them). Carried with the LAST delivered sha256, so a
 *                  consumer can tell "loom's stale bytes" from "edited since".
 *                  Carried forward across syncs until the file is gone, which
 *                  keeps a re-sync over an unchanged target a byte-identical
 *                  fixed point.
 *   The lock never lists itself.
 *
 * NOT IN SCOPE (named, so silence is not read as coverage) — everything written
 * AFTER the engine, by the Gate-2 driver or the enrichment steps:
 *   - derived multi-CLI trees: `.codex/`, `.gemini/`, `AGENTS.md`, `GEMINI.md`,
 *     `.codex-mcp-guard/` (loom-derived wholesale);
 *   - `.coc/` (it carries its own lock, `.coc/COC.lock`);
 *   - the dev-container distribution the USE py/rs enrichment writes at the repo
 *     root: `Dockerfile`, `.dockerignore`, `requirements-coc*.txt`,
 *     `docker-compose.yml`, `.devcontainer/*`, `bin/dev`, the `*.example`
 *     templates, and `.github/workflows/publish-dev-image.yml`;
 *   - the SDK-pin edits in `pyproject.toml`;
 *   - the agent-stamped `.claude/VERSION` and `.claude/.coc-sync-marker`;
 *   - the reconciled `.claude/settings.json`;
 *   - the managed block inside `.gitignore`;
 *   - the Gate-2 CI verifier under `.github/`.
 * These are either loom-owned whole trees or mixed-ownership files whose bytes are
 * per-target by design; a path absent from the lock is "not engine-delivered",
 * which for these is NOT the same as "authored by the consumer".
 *
 * DETERMINISM. No timestamp, no host, no operator, no absolute path — the lock is
 * a pure function of (loom sha + source cleanliness, the plan, the delivered
 * bytes, the target's previous lock and which retired paths still exist). Two
 * deliveries of the same loom tree into the same target state produce the same
 * bytes.
 *
 * CONSUMER USE (this file is shipped to every target; node built-ins only):
 *
 *   node .claude/bin/coc-delivery-lock.mjs --verify [--root <dir>] [--json]
 *       Recompute sha256 of every listed path and report DIFFERS / MISSING /
 *       UNREADABLE. RETIRED-PRESENT is reported, not counted.
 *       exit 0 clean · 1 mismatch · 2 usage · 3 lock absent or malformed (UNKNOWN)
 *
 *   node .claude/bin/coc-delivery-lock.mjs --classify [--root <dir>] <path>... [--json]
 *       Per path: delivered (bytes intact | modified | missing) · consumer-owned ·
 *       retired · not-delivered. Operands are normalized (path.posix.normalize) and
 *       matched case/NFC-folded. exit 0 · 2 usage or a path outside the root ·
 *       3 lock absent or malformed.
 *
 * --root defaults to the current directory.
 *
 * A MISSING LOCK IS "UNKNOWN", NEVER "CLEAN" (exit 3). Every target lacks one until
 * its first delivery after this tool shipped, so a consumer that gets exit 3 MUST
 * keep whatever it did before (e.g. its own hand-pinned list) until the lock
 * appears — exit 3 is "no evidence either way", not a failure of the tree and not
 * a pass.
 *
 * KNOWN LIMIT — DOWNSTREAM PULLS PASS THE LOCK THROUGH. loom writes the lock into a
 * USE TEMPLATE; a project that pulls from that template (`/sync-from-template`)
 * receives the TEMPLATE's lock unchanged. It then describes the template delivery:
 * paths the project deliberately diverged from report DIFFERS, and `target`/`mode`
 * name the template lane. A follow-up (the pull writing the project's own lock) is
 * queued and deliberately NOT built here.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isMainModule } from "./lib/entry-point.mjs";

export const DELIVERY_LOCK_PATH = ".claude/.coc-delivery.lock";
export const DELIVERY_LOCK_SCHEMA_VERSION = 1;
export const DELIVERY_LOCK_KIND = "coc-delivery-lock";

const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// The COC.lock comparator (emit-coc.mjs::buildLock) — code-unit order, locale-free.
function byPath(a, b) {
  const pa = typeof a === "string" ? a : a.path;
  const pb = typeof b === "string" ? b : b.path;
  return pa < pb ? -1 : pa > pb ? 1 : 0;
}

/**
 * A lock path is target-relative POSIX, in-tree, and names a FILE: no NUL, no
 * backslash, not absolute, no empty / `.` / `..` segment. Returns a defect or
 * null. Applied to every path the producer writes AND every path a reader
 * accepts, because a lock at a consumer is consumer-editable input.
 */
export function validateLockPath(p) {
  if (typeof p !== "string" || p.length === 0) return "empty or non-string path";
  if (p.includes("\0")) return "path contains a NUL byte";
  if (p.includes("\\")) return `path '${p}' contains a backslash (non-POSIX)`;
  if (p.startsWith("/") || path.isAbsolute(p)) return `path '${p}' is absolute`;
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..")
      return `path '${p}' has an empty, '.' or '..' segment`;
  }
  return null;
}

/**
 * A `consumer_owned` entry is a lock path OR a directory prefix ending in ONE
 * `/` (the manifest's `target_owned:` admits both, e.g. `.claude/ci-authz/`).
 */
export function validateOwnedEntry(p) {
  if (typeof p === "string" && p.endsWith("/") && !p.endsWith("//")) return validateLockPath(p.slice(0, -1));
  return validateLockPath(p);
}

/**
 * Path IDENTITY for the ownership and self checks, folded the way a case-
 * insensitive, normalization-insensitive filesystem (APFS, NTFS) folds names —
 * otherwise `.claude/.COC-DELIVERY.LOCK` or an NFD spelling of an owned path is a
 * different string naming the same file. Over-folding on a case-SENSITIVE
 * filesystem only makes these checks stricter, which is the safe direction.
 */
function pathKey(p) {
  return p.normalize("NFC").toLowerCase();
}

export function isSelfPath(p) {
  return pathKey(p) === pathKey(DELIVERY_LOCK_PATH);
}

/** Is `p` consumer-owned: an exact entry, or under a `/`-terminated prefix entry? */
export function isOwnedBy(p, ownedEntries) {
  const k = pathKey(p);
  for (const o of ownedEntries) {
    const ko = pathKey(o);
    if (ko === k) return true;
    if (ko.endsWith("/") && k.startsWith(ko)) return true;
  }
  return false;
}

/**
 * Compose the lock's exact bytes. THROWS on any contract violation rather than
 * emitting a lock a reader would have to second-guess: a bad path, a bad hash, a
 * duplicate, the lock listing itself, or a path that is both delivered and
 * EXACTLY consumer-owned (loom cannot both own and not-own one path). A delivered
 * file UNDER an owned directory prefix is legitimate — `.claude/ci-authz/` is
 * consumer-owned while loom ships `.claude/ci-authz/README.md` into it — so the
 * delivered-vs-owned check is exact-path, while retired-vs-owned is prefix-aware
 * (loom never claims a stale file inside a consumer's directory).
 */
export function composeDeliveryLock({
  target,
  mode,
  loomSha,
  loomSourceClean,
  files,
  consumerOwned = [],
  retired = [],
}) {
  if (typeof target !== "string" || target.length === 0) throw new Error("target is required");
  if (mode !== "build" && mode !== "use") throw new Error(`mode must be build|use, got '${mode}'`);
  if (typeof loomSourceClean !== "boolean") throw new Error("loom_source_clean must be boolean");
  if (loomSha === null) {
    if (loomSourceClean) throw new Error("an unanchored lock (loom_sha null) cannot claim a clean source");
  } else if (typeof loomSha !== "string" || !GIT_SHA_RE.test(loomSha))
    throw new Error(`loom_sha must be a full hex commit id or null, got '${loomSha}'`);
  const seen = new Set();
  const checkEntry = (e, where) => {
    const why = validateLockPath(e.path);
    if (why) throw new Error(`${where}: ${why}`);
    if (isSelfPath(e.path)) throw new Error(`${where}: the lock never lists itself`);
    if (!SHA256_RE.test(e.sha256 || "")) throw new Error(`${where}: '${e.path}' has no valid sha256`);
    if (seen.has(e.path)) throw new Error(`${where}: duplicate path '${e.path}'`);
    seen.add(e.path);
  };
  const fileRows = files.map((e) => ({ path: e.path, sha256: e.sha256 }));
  for (const e of fileRows) checkEntry(e, "files");
  const owned = [...new Set(consumerOwned)].sort(byPath);
  for (const p of owned) {
    const why = validateOwnedEntry(p);
    if (why) throw new Error(`consumer_owned: ${why}`);
    if (seen.has(p)) throw new Error(`'${p}' is both delivered and consumer-owned`);
  }
  const retiredRows = retired.map((e) => ({ path: e.path, sha256: e.sha256 }));
  for (const e of retiredRows) checkEntry(e, "retired");
  for (const e of retiredRows)
    if (isOwnedBy(e.path, owned)) throw new Error(`'${e.path}' is both retired and consumer-owned`);
  const lock = {
    schema_version: DELIVERY_LOCK_SCHEMA_VERSION,
    kind: DELIVERY_LOCK_KIND,
    target,
    mode,
    loom_sha: loomSha,
    loom_source_clean: loomSourceClean,
    files: fileRows.sort(byPath),
    consumer_owned: owned,
    retired: retiredRows.sort(byPath),
  };
  return JSON.stringify(lock, null, 2) + "\n";
}

/**
 * Parse + validate a lock's text. Returns `{ ok: true, lock }` or
 * `{ ok: false, reason }` — never throws, because a malformed lock is a VERDICT
 * (UNKNOWN), not a crash.
 */
export function parseDeliveryLock(text) {
  let lock;
  try {
    lock = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `not valid JSON (${e.message})` };
  }
  if (lock === null || typeof lock !== "object" || Array.isArray(lock))
    return { ok: false, reason: "not a JSON object" };
  if (lock.kind !== DELIVERY_LOCK_KIND) return { ok: false, reason: `kind is not '${DELIVERY_LOCK_KIND}'` };
  if (lock.schema_version !== DELIVERY_LOCK_SCHEMA_VERSION)
    return { ok: false, reason: `unsupported schema_version ${JSON.stringify(lock.schema_version)}` };
  // Header fields are validated too: a report prints them, and a truthy STRING in
  // `loom_source_clean` would silently suppress the uncommitted-source warning.
  if (typeof lock.target !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(lock.target))
    return { ok: false, reason: "'target' is not a plain lane name" };
  if (lock.mode !== "build" && lock.mode !== "use") return { ok: false, reason: "'mode' is not build|use" };
  if (typeof lock.loom_source_clean !== "boolean") return { ok: false, reason: "'loom_source_clean' is not boolean" };
  if (lock.loom_sha === null) {
    if (lock.loom_source_clean) return { ok: false, reason: "an unanchored lock claims a clean source" };
  } else if (typeof lock.loom_sha !== "string" || !GIT_SHA_RE.test(lock.loom_sha))
    return { ok: false, reason: "'loom_sha' is not a full hex commit id or null" };
  for (const key of ["files", "consumer_owned", "retired"]) {
    if (!Array.isArray(lock[key])) return { ok: false, reason: `'${key}' is not an array` };
  }
  const seen = new Set();
  for (const key of ["files", "retired"]) {
    for (const e of lock[key]) {
      if (e === null || typeof e !== "object") return { ok: false, reason: `${key}: entry is not an object` };
      const why = validateLockPath(e.path);
      if (why) return { ok: false, reason: `${key}: ${why}` };
      if (!SHA256_RE.test(e.sha256 || "")) return { ok: false, reason: `${key}: '${e.path}' has no valid sha256` };
      if (seen.has(e.path)) return { ok: false, reason: `duplicate path '${e.path}'` };
      seen.add(e.path);
    }
  }
  for (const p of lock.consumer_owned) {
    const why = validateOwnedEntry(p);
    if (why) return { ok: false, reason: `consumer_owned: ${why}` };
  }
  return { ok: true, lock };
}

function realOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Resolve `<root>/<rel>` CONTAINED: BOTH the root and the candidate's parent go
 * through the SAME resolver before the containment decision (security.md § Path
 * Containment). Returns `{ leaf }` or a `{ state, detail }` verdict.
 */
function containedLeaf(root, rel) {
  const why = validateLockPath(rel);
  if (why) return { state: "unreadable", detail: why };
  const rootReal = realOrNull(root);
  if (rootReal === null) return { state: "unreadable", detail: "target root does not resolve" };
  const candidate = path.join(rootReal, ...rel.split("/"));
  const parentReal = realOrNull(path.dirname(candidate));
  if (parentReal === null) return { state: "missing" };
  if (parentReal !== rootReal && !parentReal.startsWith(rootReal + path.sep))
    return { state: "unreadable", detail: "resolves outside the target root" };
  return { leaf: path.join(parentReal, path.basename(candidate)) };
}

/**
 * Read `<root>/<rel>`, contained, through ONE file descriptor: the leaf is opened
 * O_NOFOLLOW (a symlink leaf is refused) and O_NONBLOCK (a FIFO cannot hang the
 * open), and must fstat as a regular file before any read. Never throws.
 * Returns `{ state: "ok", bytes }` | `{ state: "missing" }` |
 * `{ state: "unreadable", detail }`.
 */
function readContained(root, rel) {
  const c = containedLeaf(root, rel);
  if (!c.leaf) return c;
  let fd;
  try {
    fd = fs.openSync(
      c.leaf,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK || 0),
    );
  } catch (e) {
    if (e.code === "ENOENT") return { state: "missing" };
    if (e.code === "ELOOP") return { state: "unreadable", detail: "is a symlink" };
    return { state: "unreadable", detail: e.code || String(e.message) };
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return { state: "unreadable", detail: "is not a regular file" };
    return { state: "ok", bytes: fs.readFileSync(fd) };
  } catch (e) {
    return { state: "unreadable", detail: e.code || String(e.message) };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Hash the bytes at `<root>/<rel>`, contained (see readContained).
 * Returns `{ state: "ok", sha256 }` | `{ state: "missing" }` |
 * `{ state: "unreadable", detail }`.
 */
export function hashTargetPath(root, rel) {
  const r = readContained(root, rel);
  return r.state === "ok" ? { state: "ok", sha256: sha256Hex(r.bytes) } : r;
}

/**
 * Is `<root>/<rel>` a regular file right now? Contained and lstat-based: nothing
 * is opened or read, so a FIFO or a huge file costs nothing and a symlink is "no".
 */
export function isRegularFileAt(root, rel) {
  const c = containedLeaf(root, rel);
  if (!c.leaf) return false;
  try {
    return fs.lstatSync(c.leaf).isFile();
  } catch {
    return false;
  }
}

/**
 * Read `<root>/.claude/.coc-delivery.lock` through one contained descriptor.
 * Returns `{ state: "absent" }`, `{ state: "malformed", reason }` or
 * `{ state: "ok", lock, bytes }`.
 */
export function readDeliveryLock(root) {
  const r = readContained(root, DELIVERY_LOCK_PATH);
  if (r.state === "missing") return { state: "absent" };
  if (r.state !== "ok") return { state: "malformed", reason: r.detail };
  const parsed = parseDeliveryLock(r.bytes.toString("utf8"));
  if (!parsed.ok) return { state: "malformed", reason: parsed.reason };
  return { state: "ok", lock: parsed.lock, bytes: r.bytes };
}

/**
 * The `retired` set for a NEW lock: every path the PREVIOUS lock listed (as
 * delivered or already retired) that this delivery does not deliver, is not
 * consumer-owned, and is STILL a regular file on disk (contained lstat). Carries the previous sha256.
 * `previous` is the parsed previous lock or null.
 */
export function deriveRetired(root, previous, deliveredPaths, consumerOwned = []) {
  if (!previous) return [];
  const delivered = new Set(deliveredPaths.map(pathKey));
  const out = new Map();
  for (const e of [...previous.files, ...previous.retired]) {
    const k = pathKey(e.path);
    if (delivered.has(k) || isOwnedBy(e.path, consumerOwned) || isSelfPath(e.path)) continue;
    if (out.has(k)) continue;
    // ONLY a regular in-tree file is carried. Anything else — absent, a directory,
    // a symlink, a path THROUGH a file (ENOTDIR), one resolving outside the root —
    // is not "still on disk" in the sense the lock asserts, and carrying it would
    // let a crafted previous lock launder an arbitrary string into loom's output.
    if (!isRegularFileAt(root, e.path)) continue;
    out.set(k, { path: e.path, sha256: e.sha256 });
  }
  return [...out.values()].sort(byPath);
}

/**
 * Verify a target against its lock. `status`: "clean" | "mismatch" | "unknown".
 */
export function verifyDeliveryLock(root) {
  const read = readDeliveryLock(root);
  if (read.state !== "ok") {
    return {
      status: "unknown",
      reason: read.state === "absent" ? `${DELIVERY_LOCK_PATH} is absent` : `${DELIVERY_LOCK_PATH} is malformed: ${read.reason}`,
      checked: 0,
      differs: [],
      missing: [],
      unreadable: [],
      retired_present: [],
    };
  }
  const { lock } = read;
  const differs = [];
  const missing = [];
  const unreadable = [];
  for (const e of lock.files) {
    const h = hashTargetPath(root, e.path);
    if (h.state === "missing") missing.push(e.path);
    else if (h.state === "unreadable") unreadable.push({ path: e.path, detail: h.detail });
    else if (h.sha256 !== e.sha256) differs.push({ path: e.path, expected: e.sha256, actual: h.sha256 });
  }
  const retired_present = lock.retired
    .filter((e) => isRegularFileAt(root, e.path))
    .map((e) => e.path);
  const n = differs.length + missing.length + unreadable.length;
  return {
    status: n === 0 ? "clean" : "mismatch",
    loom_sha: lock.loom_sha,
    loom_source_clean: lock.loom_source_clean,
    target: lock.target,
    mode: lock.mode,
    checked: lock.files.length,
    differs,
    missing,
    unreadable,
    retired_present,
  };
}

/**
 * Normalize a user-supplied path operand to a target-relative POSIX path, or null
 * when it does not name something inside the root. OS separators are folded to
 * `/`, then `path.posix.normalize` collapses `./`, `//` and interior `..`; an
 * absolute result or one that still climbs out (`..`) is refused.
 */
export function normalizeOperand(p) {
  if (typeof p !== "string" || p.length === 0 || p.includes("\0")) return null;
  const n = path.posix.normalize(p.split(path.sep).join("/"));
  if (n.startsWith("/") || n === ".." || n.startsWith("../") || n === ".") return null;
  return n;
}

/**
 * Classify target-relative paths against a parsed lock. Operands are matched on the
 * SAME folded identity the ownership and self checks use (case + NFC), so on a
 * case-insensitive filesystem `.CLAUDE/Rules/A.md` classifies as the file it opens;
 * an exact-string match still wins when the lock has one. The row reports the
 * LOCK's spelling of a matched path.
 */
export function classifyPaths(root, lock, paths) {
  const byExact = new Map(lock.files.map((e) => [e.path, e]));
  const byKey = new Map(lock.files.map((e) => [pathKey(e.path), e]));
  const retiredExact = new Set(lock.retired.map((e) => e.path));
  const retiredKey = new Set(lock.retired.map((e) => pathKey(e.path)));
  const owned = lock.consumer_owned;
  return paths.map((p) => {
    const norm = normalizeOperand(p) ?? p;
    if (isSelfPath(norm)) return { path: norm, class: "delivery-lock" };
    const hit = byExact.get(norm) || byKey.get(pathKey(norm));
    if (hit) {
      const h = hashTargetPath(root, hit.path);
      const state = h.state === "ok" ? (h.sha256 === hit.sha256 ? "intact" : "modified") : h.state;
      return { path: hit.path, class: "delivered", state };
    }
    if (isOwnedBy(norm, owned)) return { path: norm, class: "consumer-owned" };
    if (retiredExact.has(norm) || retiredKey.has(pathKey(norm))) return { path: norm, class: "retired" };
    return { path: norm, class: "not-delivered" };
  });
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const USAGE =
  "usage: coc-delivery-lock.mjs --verify [--root <dir>] [--json]\n" +
  "       coc-delivery-lock.mjs --classify [--root <dir>] <path>... [--json]\n" +
  "  --verify    exit 0 clean | 1 mismatch | 3 lock absent/malformed (UNKNOWN) | 2 usage\n" +
  "  --classify  exit 0 | 3 lock absent/malformed | 2 usage (incl. a path outside the root)\n" +
  "  --root defaults to the current directory. Path operands are target-relative;\n" +
  "  they are normalized and matched case-insensitively.\n";

// Every string a report prints came from a consumer-editable lock or tree, so C0,
// DEL, C1 and bidi controls are escaped before they reach a terminal.
// Escapes the backslash too (a lock path never contains one), so a printed
// literal backslash-u sequence can never be mistaken for one this produced.
// Built from NUMERIC code points so the source carries no invisible characters.
const hex4 = (n) => n.toString(16).padStart(4, "0");
const charClass = (ranges) =>
  new RegExp("[" + ranges.map(([a, b]) => `\\u${hex4(a)}-\\u${hex4(b)}`).join("") + "]", "g");
const BIDI = [[0x061c, 0x061c], [0x200e, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069]];
const TERMINAL_UNSAFE = charClass([[0x5c, 0x5c], [0x00, 0x1f], [0x7f, 0x9f], ...BIDI]);
const JSON_UNSAFE = charClass([[0x7f, 0x9f], ...BIDI]);
const hexEscape = (c) => "\\u" + hex4(c.charCodeAt(0));

export function escapeForTerminal(s) {
  return String(s).replace(TERMINAL_UNSAFE, hexEscape);
}
const esc = escapeForTerminal;

// JSON.stringify escapes C0 but leaves C1 and bidi controls raw; re-escape them so
// --json output is terminal-safe and still valid JSON.
function safeJson(v) {
  return JSON.stringify(v, null, 2).replace(JSON_UNSAFE, hexEscape);
}

function main(argv) {
  const args = argv.slice(2);
  const json = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");
  if (rest[0] === "--help" || rest[0] === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  const mode = rest[0];
  if (mode !== "--verify" && mode !== "--classify") {
    process.stderr.write(USAGE);
    return 2;
  }
  // The root is ONLY ever given by `--root <dir>`. It used to be "the first
  // operand, if it is a directory", which made the meaning of an operand depend on
  // the filesystem: `--classify .claude/rules x.md` silently took `.claude/rules`
  // as the ROOT instead of classifying it.
  let root = ".";
  const operands = [];
  const tail = rest.slice(1);
  for (let i = 0; i < tail.length; i++) {
    if (tail[i] === "--root") {
      if (i + 1 >= tail.length || root !== ".") {
        process.stderr.write(USAGE);
        return 2;
      }
      root = tail[++i];
    } else if (tail[i].startsWith("--")) {
      process.stderr.write(USAGE);
      return 2;
    } else operands.push(tail[i]);
  }
  if (mode === "--verify" && operands.length > 0) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (realOrNull(root) === null) {
    process.stderr.write(`coc-delivery-lock: target root does not exist: ${esc(root)}\n`);
    return 2;
  }

  if (mode === "--verify") {
    const v = verifyDeliveryLock(root);
    if (json) process.stdout.write(safeJson(v) + "\n");
    else {
      const lines = [];
      if (v.status === "unknown") lines.push(`UNKNOWN — ${esc(v.reason)}; nothing was verified`);
      else {
        lines.push(
          `delivery lock: ${esc(v.mode)}/${esc(v.target)} from loom ` +
            (v.loom_sha === null ? "(UNANCHORED: source commit unknown)" : esc(v.loom_sha)) +
            (v.loom_source_clean ? "" : " (UNCOMMITTED or unknown loom source)") +
            ` — ${v.checked} path(s) checked`,
        );
        for (const d of v.differs) lines.push(`  DIFFERS     ${esc(d.path)}`);
        for (const m of v.missing) lines.push(`  MISSING     ${esc(m)}`);
        for (const u of v.unreadable) lines.push(`  UNREADABLE  ${esc(u.path)} (${esc(u.detail)})`);
        for (const r of v.retired_present)
          lines.push(`  RETIRED     ${esc(r)} (no longer delivered by loom; still present)`);
        lines.push(
          v.status === "clean"
            ? "RESULT: every delivered path matches the lock"
            : `RESULT: ${v.differs.length + v.missing.length + v.unreadable.length} path(s) differ from the lock`,
        );
      }
      process.stdout.write(lines.join("\n") + "\n");
    }
    return v.status === "clean" ? 0 : v.status === "mismatch" ? 1 : 3;
  }

  // --classify
  if (operands.length === 0) {
    process.stderr.write(USAGE);
    return 2;
  }
  const normalized = [];
  for (const op of operands) {
    const n = normalizeOperand(op);
    if (n === null) {
      process.stderr.write(
        `coc-delivery-lock: '${esc(op)}' is not a path inside the target root\n` + USAGE,
      );
      return 2;
    }
    normalized.push(n);
  }
  const read = readDeliveryLock(root);
  if (read.state !== "ok") {
    const reason = read.state === "absent" ? "absent" : `malformed: ${read.reason}`;
    process.stderr.write(`coc-delivery-lock: UNKNOWN — ${DELIVERY_LOCK_PATH} is ${esc(reason)}\n`);
    return 3;
  }
  const rows = classifyPaths(root, read.lock, normalized);
  if (json) process.stdout.write(safeJson(rows) + "\n");
  else
    process.stdout.write(
      rows.map((r) => `${esc(r.class)}${r.state ? ` (${esc(r.state)})` : ""}\t${esc(r.path)}`).join("\n") + "\n",
    );
  return 0;
}

// Entry-point check: .claude/bin/lib/entry-point.mjs (symlink-safe; a lexical compare exits 0 silently).
if (isMainModule(import.meta.url)) process.exitCode = main(process.argv);
