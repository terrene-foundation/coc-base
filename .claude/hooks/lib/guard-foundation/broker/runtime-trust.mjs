// Guard foundation S4 (R2a H-A(2)) — the RUNTIME a trusted writer runs on: node and the
// external programs its execution closure spawns, and whether a sandboxed process could
// replace any of them.
//
// The broker runs trusted writers OUTSIDE the sandbox. closure.mjs proves every REPOSITORY file
// such a run can execute is write-protected; this module covers what lies outside the
// repository: the node binary (process.execPath) and the programs the closure LISTS (git, gpg,
// ssh-keygen, ps, …). A program is found by its bare name in SYSTEM_DIRS, in that order —
// the inherited PATH is NEVER read, so a directory a sandboxed process can write (a PATH entry
// under $HOME) is never searched. `fixedPath` is NOT that search list: it holds only the `dirs` where an
// entry was found, in `dirs` order, then node's own directory (runtime-trust.mjs:170-172). And the broker
// does NOT run the writer on it: it passes the inherited PATH through (broker.mjs:58, broker.mjs:284-285),
// so the writer's spawn finds the file checked here only when that PATH resolves alike (closure.mjs:33-36).
//
// TRUSTED means a sandboxed process cannot change the file or what its name resolves to: every
// component of BOTH the path it was found at and its realpath — "/" down to the file itself —
// is owned by root (uid 0), is not group- or other-writable (mode & 0o022 === 0), and is not
// owned by the uid running this code (a broker running AS root therefore trusts nothing). A
// SYMLINK component is judged by its owner only: its mode bits grant nothing (it cannot be
// rewritten, only replaced through its parent, which is checked as a component in its own right).
//
// An UNTRUSTED entry carries PREFIXES: walking each chain from "/" downwards, the FIRST
// component that is not trusted (Homebrew: "/opt" is root's, "/opt/homebrew" is the operator's
// ⇒ "/opt/homebrew"), realpath'd, because Seatbelt matches canonical paths. A launcher whose
// profile write-denies every prefix (`(deny file-write* (subpath P))` for P or an ancestor)
// makes the entry unchangeable from inside the sandbox. seatbelt-launch.mjs renders every prefix
// into the profile and refuses to render without them (seatbelt-launch.mjs:22-30). broker.mjs
// makes no runtime check of its own and has no `runtime-untrusted` refusal (broker.mjs:178-316).
//
// HONEST LIMITS (named, not hidden):
//   - ownership and mode bits only: an ACL that grants the operator write on a root-owned
//     directory (macOS `chmod +a`, Linux setfacl) is NOT seen.
//   - a file inside a prefix that ALREADY has a second hard link outside it can be changed
//     through the other name; Seatbelt decides by path, so no profile covers that.
//   - programs that git config names (gpg.program, core.sshCommand, …) are not in the closure's
//     program list (closure.mjs HONEST LIMITS) and so are not checked here.
//
// Bare-name resolution falls back to dirname(execPath) after `dirs`, because fixedPath ends with
// that directory: a name found nowhere else would otherwise RUN from there unchecked.
//
// Exports:
//   SYSTEM_DIRS
//   runtimeTrustPaths({ programs, execPath = process.execPath, dirs = SYSTEM_DIRS })
//     → { entries: [{ name, resolved, real, trusted, prefixes, why }], prefixes, fixedPath, unresolved }
//   closurePrograms({ primary, policy }) → string[]   sorted union over every trusted writer

import fs from "node:fs";
import path from "node:path";
import { computeClosure } from "./closure.mjs";

/** Bare-name resolution order. The inherited PATH is never read. */
export const SYSTEM_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/local/bin", "/opt/homebrew/bin", "/opt/local/bin"];

const currentUid = () => (typeof process.getuid === "function" ? process.getuid() : -1);

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function realOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** Absolute, resolves (through symlinks) to a regular file, executable by this process. */
function isExecutableFile(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Why one path component is not trusted, or null when it is. */
function componentVerdict(st, uid) {
  if (!st) return "does not exist";
  if (st.uid !== 0) return `owned by uid ${st.uid}, not root`;
  if (st.uid === uid) return "owned by the uid this broker runs as";
  if (!st.isSymbolicLink() && (st.mode & 0o022) !== 0) return `group/other-writable (mode ${(st.mode & 0o7777).toString(8)})`;
  return null;
}

/** "/" and every ancestor of `abs`, then `abs` itself, top-down. */
function chainOf(abs) {
  const out = [];
  for (let p = abs; ; p = path.dirname(p)) {
    out.push(p);
    if (path.dirname(p) === p) break;
  }
  return out.reverse();
}

/** The first untrusted component of `abs`'s chain, top-down: { prefix, why } or null (trusted). */
function firstUntrusted(abs, uid) {
  for (const c of chainOf(abs)) {
    const v = componentVerdict(lstatOrNull(c), uid);
    if (v) return { prefix: c, why: `${c} ${v}` };
  }
  return null;
}

/** One program spec ("gpg", "/bin/ps|/usr/bin/ps") → the absolute path it runs from, or null. */
function resolveProgram(spec, dirs) {
  for (const alt of String(spec).split("|")) {
    if (!alt) continue;
    if (path.isAbsolute(alt)) {
      if (isExecutableFile(alt)) return path.normalize(alt);
      continue;
    }
    // A bare name only: anything holding a separator, or "." / "..", names no program.
    if (alt.includes("/") || alt.includes("\\") || alt === "." || alt === "..") continue;
    for (const d of dirs) {
      const c = path.join(d, alt);
      if (isExecutableFile(c)) return c;
    }
  }
  return null;
}

/** The trust record of the program found at `resolved` under `name`. */
function entryFor(name, resolved, uid) {
  const real = realOrNull(resolved);
  const why = [];
  const prefixes = new Set();
  for (const p of real ? [resolved, real] : [resolved]) {
    const u = firstUntrusted(p, uid);
    if (!u) continue;
    if (!why.includes(u.why)) why.push(u.why);
    const pr = realOrNull(u.prefix);
    if (pr) prefixes.add(pr);
    else why.push(`${u.prefix} does not resolve, so no prefix can cover it`);
  }
  if (!real) why.push(`${resolved} does not resolve`);
  return { name, resolved, real, trusted: why.length === 0, prefixes: [...prefixes].sort(), why };
}

/**
 * The runtime of a writer: node (`execPath`, always) and each of `programs`, resolved WITHOUT
 * the inherited PATH and judged trusted or not (see the header).
 */
export function runtimeTrustPaths({ programs = [], execPath = process.execPath, dirs = SYSTEM_DIRS } = {}) {
  const uid = currentUid();
  const sysDirs = dirs.filter((d) => typeof d === "string" && path.isAbsolute(d)).map((d) => path.normalize(d));
  const nodeResolved = path.resolve(execPath);
  const nodeDir = path.dirname(nodeResolved);
  const searchDirs = sysDirs.includes(nodeDir) ? sysDirs : [...sysDirs, nodeDir];
  const entries = [entryFor("node", nodeResolved, uid)];
  const seen = new Set([`node\0${nodeResolved}`]);
  const unresolved = [];
  for (const spec of [...new Set(programs)].sort()) {
    const resolved = resolveProgram(spec, searchDirs);
    if (!resolved) {
      unresolved.push(spec);
      continue;
    }
    if (seen.has(`${spec}\0${resolved}`)) continue;
    seen.add(`${spec}\0${resolved}`);
    entries.push(entryFor(spec, resolved, uid));
  }
  const prefixes = [...new Set(entries.flatMap((e) => e.prefixes))].sort();
  const used = new Set(entries.map((e) => path.dirname(e.resolved)));
  const fixed = sysDirs.filter((d, i) => used.has(d) && sysDirs.indexOf(d) === i);
  if (!fixed.includes(nodeDir)) fixed.push(nodeDir);
  return { entries, prefixes, fixedPath: fixed.join(path.delimiter), unresolved };
}

/** The sorted union of the external programs in the execution closure of every trusted writer. */
export function closurePrograms({ primary, policy }) {
  const primaryReal = fs.realpathSync(primary);
  const out = new Set();
  for (const w of policy.trusted_writers) {
    const entry = path.join(primaryReal, w.entry);
    const c = computeClosure({ primary: primaryReal, entry: realOrNull(entry) || entry });
    for (const p of c.programs) out.add(p.program);
  }
  return [...out].sort();
}
