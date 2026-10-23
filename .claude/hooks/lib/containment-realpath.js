/**
 * containment-realpath.js — THE CommonJS resolver and IDENTITY module every hook-side
 * containment, occupancy and worktree-identity decision goes through (`security.md` § Path
 * Containment: BOTH sides through the SAME instrument).
 *
 * WHY ONE MODULE. The worktree occupancy check (`worktree-occupancy.js`), the rs worktree
 * reclaimer (`variants/rs/hooks/lib/worktree-reclaim.js`, which lands beside this file at an rs
 * consumer), the rs cache GC (`variants/rs/hooks/build-cache-gc.js`) and the codify
 * self-referential advisory (`codify-self-referential.js`) each carried their own resolver, and
 * each copy was a separate place for the same hole.
 *
 * WHY IDENTITY, NOT STRINGS (train-8 R2 security N1, HIGH). No realpath makes "one directory ⇒
 * one string" true. Train-8 R1 moved occupancy to `fs.realpathSync.native`, which folds CASE, and
 * claimed every spelling of one directory then resolved to one string. That claim was false: on
 * macOS a worktree registered through its firmlink spelling `/System/Volumes/Data/<path>` resolves
 * NATIVELY to that firmlink string, while `lsof` reports the process cwd as `<path>` — so an
 * OCCUPIED worktree read free, classified SAFE, passed both cache-GC allow-lists and the
 * point-of-deletion recheck (measured: `"v":"SAFE"`, `"cleared":true`). Firmlinks, bind mounts,
 * `/.vol/<dev>/<ino>` and any other alias are all the same class. So every decision here is made
 * on `(st_dev, st_ino)`:
 *   - a directory's IDENTITY is `stat(p)` → "dev:ino" (`idOf`);
 *   - its ANCESTRY is the identity of `p`, `p/..`, `p/../..`, … up to the filesystem root, each
 *     `..` resolved by the KERNEL (physically, after links), never by string (`ancestryOf`);
 *   - a process cwd is INSIDE worktree W iff W's identity is on the cwd's ancestry.
 * Measured on both fleet OS: the walk ends where `x/..` is `x`; a firmlink spelling, its canonical
 * twin and `/.vol/<dev>/<ino>` give the SAME chain on darwin; `/proc/<pid>/cwd/..` walks a linux
 * process's real ancestry even when its cwd is deleted or longer than PATH_MAX.
 *
 * WHERE A PROCESS'S ANCESTRY COMES FROM, in order (`cwdChainOf`):
 *   1. linux: `/proc/<pid>/cwd` — the kernel's own link to the cwd; no path text involved.
 *   2. a spelling of lsof's reported name (raw or escape-decoded) whose identity EQUALS lsof's
 *      reported `(D, i)` for that cwd — so a recreated or renamed directory never stands in.
 *   3. darwin: `/.vol/<dev>/<ino>` from lsof's `(D, i)` — reaches a cwd whose name lsof truncated.
 * With no complete ancestry the cwd is UNRESOLVED and is placed from its NAME, scoped to the
 * worktrees it could lie in (`placeByName`), never to every worktree on the host.
 *
 * SCOPE. Same-user processes only: a hook cannot read another user's cwd (`lsof -w` omits it and
 * `/proc/<pid>/cwd` refuses it), and worktrees here belong to the session's own user. A same-user
 * process the kernel will not let us read (non-dumpable: `/proc/<pid>/cwd` EACCES) is COUNTED in
 * the snapshot (`invisible`) and named in this header as a residual, not used to taint every
 * worktree — measured at 7 such processes on a linux fleet host, so tainting on them would refuse
 * every reclaim there (train-8 R2 N2 trade-off, reported).
 *
 * FAIL DIRECTIONS, per export:
 *   idOf / ancestryOf  null when anything will not stat, or the walk does not reach the root.
 *   realOrNull         canonical path for a containment decision, or null; refuses a `.` / `..`
 *                      segment in the ABSENT tail rather than collapsing it lexically (N6).
 *   exactRealOrNull    the OS realpath of the path ITSELF, or null. A DISPLAY / allow-list key
 *                      only — decisions compare identities.
 *   placeEntry         "inside" | "outside" | "unresolved"; the caller reads "unresolved" as
 *                      OCCUPIED for that worktree.
 *   occupancyOf        tri-state occupancy; an indeterminate snapshot or an unresolvable worktree
 *                      answers OCCUPIED.
 */

"use strict";

const fs = require("fs");
const path = require("path");

// Wrapped rather than aliased, so the receiver is never detached.
const realpathNative = (p) => fs.realpathSync.native(p);

// ── identity ────────────────────────────────────────────────────────────────

/** "dev:ino" of what `p` names (links followed), or null when it will not stat. */
function idOf(p) {
  try {
    const s = fs.statSync(p, { bigint: true });
    return `${s.dev}:${s.ino}`;
  } catch {
    return null;
  }
}

const MAX_ANCESTRY = 1024;

/**
 * The identities of `p` and every physical ancestor up to the filesystem root, deepest first —
 * each step is `<previous>/..`, resolved by the kernel, so no string normalization ever decides an
 * ancestor. Null when any step will not stat or the walk does not terminate (`x/..` is `x`).
 */
function ancestryOf(p) {
  if (typeof p !== "string" || p === "") return null;
  const ids = [];
  let cur = p;
  for (let i = 0; i < MAX_ANCESTRY; i++) {
    const id = idOf(cur);
    if (id === null) return null;
    if (ids.length && ids[ids.length - 1] === id) return ids;
    ids.push(id);
    cur = cur.endsWith("/") ? `${cur}..` : `${cur}/..`;
  }
  return null;
}

/** `p` is `root` or beneath it, by identity. Null when either side cannot be established. */
function isWithinById(p, root) {
  const rid = idOf(root);
  const chain = ancestryOf(p);
  if (rid === null || chain === null) return null;
  return chain.includes(rid);
}

// ── canonical paths (display, allow-list keys, codify classification) ───────

/**
 * The canonical form of `p` for a containment decision: the OS realpath of its nearest EXISTING
 * ancestor with the genuinely-absent tail re-appended, or **null** when a component that exists
 * will not resolve (EACCES, ELOOP, a dangling link), nothing resolves at all, or the absent tail
 * carries a `.` / `..` segment. Climbs ONLY on ENOENT with `lstat` confirming the entry is absent.
 * Never the raw path, and never a LEXICAL collapse of `..`: `tree/lnk/../x` with `lnk` a link
 * escaping the tree is resolved by the kernel (to the link target's parent), not folded to
 * `tree/x` (train-8 R2 security N6).
 */
function realOrNull(p) {
  if (typeof p !== "string" || p === "") return null;
  let cur = path.isAbsolute(p) ? p : `${process.cwd()}${path.sep}${p}`;
  const tail = [];
  for (let i = 0; i < MAX_ANCESTRY; i++) {
    try {
      return tail.length ? path.join(realpathNative(cur), ...tail) : realpathNative(cur);
    } catch (e) {
      if (!e || e.code !== "ENOENT") return null;
      let entryExists = true;
      try {
        fs.lstatSync(cur);
      } catch {
        entryExists = false; // genuinely absent: climb
      }
      if (entryExists) return null; // the entry exists but will not resolve: a dangling link
      const base = path.basename(cur);
      if (base === "." || base === "..") return null; // never collapse a dot segment lexically
      const up = path.dirname(cur);
      if (up === cur) return null;
      if (base !== "") tail.unshift(base);
      cur = up;
    }
  }
  return null;
}

/** The OS realpath of `p` itself, or null when `p` does not resolve EXACTLY (no tail climb). */
function exactRealOrNull(p) {
  try {
    return realpathNative(p);
  } catch {
    return null;
  }
}

// ── lsof names ──────────────────────────────────────────────────────────────

const C_ESCAPES = { b: 0x08, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09 };

/**
 * Decode the escapes `lsof` applies to an `n` (name) field: `\b \f \n \r \t`, `\xNN`, and
 * `^X` for the remaining control characters (`^?` is DEL). lsof does NOT escape a literal
 * backslash or caret, so the decode is AMBIGUOUS for a name that genuinely contains one — which
 * is why `cwdCandidates` keeps the raw form beside the decoded one and the caller tests both.
 */
function decodeLsofName(s) {
  const bytes = [];
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    const n = str[i + 1];
    if (c === "\\" && n !== undefined && Object.prototype.hasOwnProperty.call(C_ESCAPES, n)) {
      bytes.push(C_ESCAPES[n]);
      i++;
    } else if (c === "\\" && n === "x" && /^[0-9a-fA-F]{2}$/.test(str.slice(i + 2, i + 4))) {
      bytes.push(parseInt(str.slice(i + 2, i + 4), 16));
      i += 3;
    } else if (c === "^" && n !== undefined && /[@A-Z[\\\]^_?]/.test(n)) {
      bytes.push(n === "?" ? 0x7f : n.charCodeAt(0) - 64);
      i++;
    } else {
      for (const b of Buffer.from(c, "utf8")) bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** The spellings a reported cwd may stand for: the raw report and its decoded form, distinct. */
function cwdCandidates(raw) {
  const decoded = decodeLsofName(raw);
  return decoded === raw ? [raw] : [raw, decoded];
}

// linux lsof appends " (deleted)" to the name of an unlinked cwd; the rest is verbatim.
const DELETED_SUFFIX = " (deleted)";
// lsof annotations that mean "this is not a path" (readlink/stat failures on another user's pid).
const ANNOTATION = /\((readlink|stat|lstat|access|opendir):/;
// darwin lsof keeps only a TAIL of a cwd longer than MAXPATHLEN (measured: 1005 chars), which
// reads as an absolute path that is not one. A name this long is never trusted as a location.
const TRUNCATION_SUSPECT = 1000;

/**
 * Why `raw` cannot be used as a location at all, or null when it can: empty, relative (lsof would
 * otherwise be read against THIS hook's cwd), annotated, possibly truncated, or carrying a `.` /
 * `..` segment that only a lexical collapse could place (train-8 R2 security N4, N5).
 */
function unusableName(raw) {
  if (typeof raw !== "string" || raw === "") return "an empty name";
  if (!raw.startsWith("/")) return "a relative name";
  if (ANNOTATION.test(raw)) return "an lsof annotation, not a path";
  if (raw.length >= TRUNCATION_SUSPECT) return "a possibly TRUNCATED name (lsof keeps only the tail of a long cwd)";
  if (raw.split("/").some((s) => s === "." || s === "..")) return "a name with a dot segment";
  return null;
}

/** The deepest prefix of absolute `name` that stats, as a directory path — or null. */
function deepestExisting(name) {
  const parts = name.split("/");
  for (let n = parts.length; n >= 1; n--) {
    const p = parts.slice(0, n).join("/") || "/";
    if (idOf(p) !== null) return p;
  }
  return null;
}

// ── process placement ───────────────────────────────────────────────────────

/**
 * The complete physical ancestry of a snapshot entry's cwd (`{pid, cwd, dev, ino}`), or null.
 * `dev`/`ino` are lsof's `D`/`i` fields when it gave them. See the header for the order.
 */
function cwdChainOf(e, platform = process.platform) {
  // A /proc-sourced entry carries the ancestry read at snapshot time (augmentFromProc).
  if (Array.isArray(e.chain) && e.chain.length) return e.chain;
  const lsofId = e.dev != null && e.ino != null ? `${e.dev}:${e.ino}` : null;
  if (platform === "linux" && Number.isInteger(e.pid) && e.pid > 0) {
    const procCwd = `/proc/${e.pid}/cwd`;
    const head = idOf(procCwd);
    // Bound to THIS lsof record when lsof named it: a reused pid is not the reported process.
    if (head !== null && (lsofId === null || head === lsofId)) {
      const chain = ancestryOf(procCwd);
      if (chain) return chain;
    }
  }
  if (typeof e.cwd === "string" && unusableName(e.cwd) === null) {
    for (const sp of cwdCandidates(e.cwd.endsWith(DELETED_SUFFIX) ? e.cwd.slice(0, -DELETED_SUFFIX.length) : e.cwd)) {
      const sid = idOf(sp);
      if (sid !== null && (lsofId === null || sid === lsofId)) {
        const chain = ancestryOf(sp);
        if (chain) return chain;
      }
    }
  }
  if (platform === "darwin" && lsofId !== null) {
    const chain = ancestryOf(`/.vol/${e.dev}/${e.ino}`);
    if (chain) return chain;
  }
  return null;
}

/**
 * Place a cwd with NO ancestry by its name, scoped to the worktrees it could lie in:
 *   - a verbatim name (no lsof escape introducer): the cwd is `P/<absent tail>` for the deepest
 *     existing prefix P, so it can lie inside W only if W is on P's ancestry. A process left in a
 *     DELETED sibling therefore no longer taints every worktree under the shared parent (train-8
 *     R2 correctness R2-1);
 *   - an escaped name: the verbatim prefix before the first escaped segment is the only part known;
 *     W may hold the cwd if W is on that prefix's ancestry OR beneath it;
 *   - an unusable name (empty, relative, annotated, truncated, dot segments): nothing rules W out.
 */
function placeByName(raw, wtId, wtChain) {
  if (unusableName(raw) !== null) return "unresolved";
  const name = raw.endsWith(DELETED_SUFFIX) ? raw.slice(0, -DELETED_SUFFIX.length) : raw;
  const segs = name.split("/");
  const cut = segs.findIndex((s) => s.includes("\\") || s.includes("^"));
  const verbatim = cut === -1;
  const known = verbatim ? name : segs.slice(0, Math.max(cut, 1)).join("/") || "/";
  const P = deepestExisting(known);
  if (P === null) return "unresolved";
  const chainP = ancestryOf(P);
  if (chainP === null) return "unresolved";
  if (chainP.includes(wtId)) return "unresolved"; // P is inside W, so the cwd may be too
  if (verbatim) return "outside"; // every deeper component of the true cwd is absent: W is not there
  const pid = chainP[0];
  return wtChain.includes(pid) ? "unresolved" : "outside"; // W lies beneath the known prefix
}

/** Where entry `e` stands relative to the worktree with identity `wtId` and ancestry `wtChain`. */
function placeEntry(e, wtId, wtChain, platform = process.platform) {
  const chain = cwdChainOf(e, platform);
  if (chain) return chain.includes(wtId) ? "inside" : "outside";
  if (typeof e.cwd !== "string") return "unresolved";
  return placeByName(e.cwd, wtId, wtChain);
}

// ── snapshot helpers shared by both snapshot producers ──────────────────────

/** Parse `lsof -d cwd -F pDin` into `{pid, cwd, dev, ino}` records (dev/ino decimal strings). */
function parseLsofCwds(stdout) {
  const out = [];
  let cur = null;
  for (const line of String(stdout || "").split("\n")) {
    const tag = line[0];
    const val = line.slice(1);
    if (tag === "p") {
      cur = { pid: Number(val), cwd: null, dev: null, ino: null };
      out.push(cur);
    } else if (!cur) {
      continue;
    } else if (tag === "D") {
      try {
        cur.dev = BigInt(val).toString();
      } catch {
        cur.dev = null;
      }
    } else if (tag === "i") {
      cur.ino = /^\d+$/.test(val) ? val : null;
    } else if (tag === "n") {
      cur.cwd = val;
    }
  }
  return out.filter((e) => Number.isInteger(e.pid) && (e.cwd !== null || e.dev !== null));
}

/**
 * linux: add every same-user process lsof did not name (it omits a cwd longer than PATH_MAX —
 * measured, train-8 R2 N2), placed through `/proc/<pid>/cwd`. A same-user process whose cwd the
 * kernel refuses (non-dumpable) is COUNTED in `snap.invisible`, not added. No-op elsewhere.
 */
function augmentFromProc(snap, platform = process.platform) {
  if (platform !== "linux" || typeof process.getuid !== "function") return snap;
  const uid = process.getuid();
  const named = new Set(snap.cwds.map((e) => e.pid));
  let entries;
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return snap;
  }
  const invisible = [];
  for (const d of entries) {
    if (!/^\d+$/.test(d)) continue;
    const pid = Number(d);
    if (named.has(pid) || snap.selfPids.has(pid)) continue;
    let st;
    try {
      st = fs.statSync(`/proc/${d}`);
    } catch {
      continue; // exited
    }
    if (st.uid !== uid) continue; // another user's process: out of scope (see header)
    // The cwd's ancestry is read NOW, at snapshot time, and carried on the entry: a process that
    // exits before placement (a transient git / sh / lsof child of anything on the host) must not
    // turn into an UNRESOLVED entry that taints every worktree. Measured on the linux fleet host:
    // with the chain read at placement instead, the rs worktree-reclaim fixture classified every
    // worktree HOLD/live-process with "pids " empty.
    const chain = ancestryOf(`/proc/${d}/cwd`);
    if (chain === null) {
      if (fs.existsSync(`/proc/${d}`)) invisible.push(pid);
      continue; // otherwise it exited between the two reads
    }
    const [dev, ino] = chain[0].split(":");
    snap.cwds.push({ pid, cwd: null, dev, ino, chain, source: "proc" });
  }
  snap.invisible = invisible;
  return snap;
}

const NAME_MAX = 100;
/** Strip control characters and neutralize backticks before a name reaches agent-read text. */
function sanitizeName(raw) {
  let s = String(raw == null ? "" : raw);
  s = s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  s = s.replace(/`/g, "'").replace(/\s+/g, " ").trim();
  if (s.length > NAME_MAX) s = s.slice(0, NAME_MAX) + "…";
  return s || "(unnamed)";
}

/** The `why` for an occupancy that could not be decided: names each blocking pid and cwd. */
function unresolvedWhy(unresolved) {
  const shown = unresolved
    .slice(0, 3)
    .map((u) => {
      const why = typeof u.cwd === "string" ? unusableName(u.cwd) : "no readable name";
      return `pid ${u.pid} cwd ${sanitizeName(u.cwd)}${why ? ` (${why})` : ""}`;
    })
    .join("; ");
  const more = unresolved.length > 3 ? ` (+${unresolved.length - 3} more)` : "";
  return (
    `${unresolved.length} process cwd(s) cannot be placed and may lie inside the worktree — ` +
    `${shown}${more}; treating it as occupied (end or move that process to release it)`
  );
}

/**
 * Occupancy of `wtPath` from a snapshot — the ONE implementation both `worktree-occupancy.js`
 * and the rs reclaimer delegate to. Excludes this process and its parent (`selfPids`).
 */
function occupancyOf(snapshot, wtPath, platform = process.platform) {
  if (!snapshot || !snapshot.determinate) {
    return { determinate: false, occupied: true, pids: [], why: (snapshot && snapshot.why) || "no process snapshot" };
  }
  const wtId = idOf(wtPath);
  const wtChain = ancestryOf(wtPath);
  if (wtId === null || wtChain === null) {
    return { determinate: false, occupied: true, pids: [], why: `the worktree path ${sanitizeName(wtPath)} does not resolve — treating it as occupied` };
  }
  const unresolved = [];
  const pids = new Set();
  for (const e of snapshot.cwds) {
    if (snapshot.selfPids && snapshot.selfPids.has(e.pid)) continue;
    const rel = placeEntry(e, wtId, wtChain, platform);
    if (rel === "inside") pids.add(e.pid);
    else if (rel === "unresolved") unresolved.push(e);
  }
  if (unresolved.length) {
    return {
      determinate: false,
      occupied: true,
      pids: [...pids].sort((a, b) => a - b),
      unresolved: unresolved.map((u) => ({ pid: u.pid, cwd: sanitizeName(u.cwd) })),
      why: unresolvedWhy(unresolved),
    };
  }
  // argv is CORROBORATION ONLY. A build started INSIDE the worktree with relative paths carries no
  // path in its command line, which is why cwd identity is primary.
  const real = exactRealOrNull(wtPath);
  for (const e of snapshot.argv || []) {
    if (snapshot.selfPids && snapshot.selfPids.has(e.pid)) continue;
    if ((real && e.command.includes(real)) || e.command.includes(wtPath)) pids.add(e.pid);
  }
  return { determinate: true, occupied: pids.size > 0, pids: [...pids].sort((a, b) => a - b), why: null };
}

module.exports = {
  idOf,
  ancestryOf,
  isWithinById,
  realOrNull,
  exactRealOrNull,
  decodeLsofName,
  cwdCandidates,
  unusableName,
  cwdChainOf,
  placeByName,
  placeEntry,
  parseLsofCwds,
  augmentFromProc,
  occupancyOf,
  sanitizeName,
  unresolvedWhy,
};
