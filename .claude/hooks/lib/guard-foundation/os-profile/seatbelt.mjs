/**
 * guard-foundation/os-profile/seatbelt — the macOS Seatbelt (`sandbox-exec -f`) profile
 * generated from the CLI-neutral policy (`../policy/protected-paths.json`).
 *
 * The profile is applied by a LAUNCHER around ANY CLI (csq at session launch, trestle at
 * placement), so it holds whatever the CLI or a script it runs does: the kernel refuses a
 * write to a protected path however the path was spelled — CDPATH, IFS games, eval,
 * `sh -c`, a symlink, `cd` failure — because Seatbelt matches the RESOLVED vnode path,
 * not the command text. No command parsing happens here.
 *
 * Shape: `(allow default)` then one `(deny file-write* …)` per protected entry, plus a
 * `(deny file-write-unlink …)` on every ANCESTOR of a protected entry inside its anchor, so
 * the protected tree cannot be renamed or removed away from under its name (`mv .claude x`)
 * and re-created empty. Trusted writers are NOT exempted: the broker runs OUTSIDE the
 * sandbox and is the only sanctioned path to a protected write.
 *
 * Anchors are resolved by the caller (`resolveAnchors`) and passed in REAL form — Seatbelt
 * compares the canonical path (`/private/var/…`, never `/var/…`), so a lexical anchor would
 * leave every protected path writable. An anchor the caller could not resolve is NOT
 * silently dropped: its entries are reported in `unanchored` and the generator refuses
 * unless the caller opts into `allowUnanchored` (e.g. no `$CLAUDE_CONFIG_DIR` on the host).
 *
 * Runtime trust: the trusted writers run OUTSIDE the profile, through the broker, using node
 * and external programs. A sandboxed process that could rewrite those files would run code
 * of its choosing unsandboxed the next time a writer runs, so the install PREFIX of each one
 * is write-denied too. The set is NOT derived here: the launcher passes the result of
 * `broker/runtime-trust.mjs::runtimeTrustPaths` as `runtime`, and a prefix that equals or
 * contains one of the session's own anchors is refused (it would deny the workspace itself).
 *
 * Network: the policy's `network` block is NOT enforced by this profile (network stays
 * `allow default`); `gaps` says so, so no reader takes the profile for a network fence.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
// The checkout enumeration and git-dir resolution are SHARED with the Linux generator, so
// both launchers protect the same set of checkouts (linux.mjs::listCheckouts throws when
// the listing fails: rendering for fewer checkouts than exist is never silent).
import { listCheckouts, resolveGitDirs } from "./linux.mjs";

// An anchor the policy itself declares OPTIONAL (`anchors.vault`: "absent on a machine with
// none, and then its rows render nothing"). Every other unresolved anchor is a refusal.
const OPTIONAL_ANCHORS = ["vault"];

export const PROFILE_FORMAT = "guard-foundation/seatbelt";
export const PROFILE_FORMAT_VERSION = 1;

// The `code` on every refusal caused by the runtime trust set (an invalid prefix, or one that
// covers a session anchor), so a launcher can refuse by that cause rather than by message text.
export const RUNTIME_REFUSED = "SEATBELT_RUNTIME_REFUSED";
const runtimeRefusal = (msg) => Object.assign(new Error(msg), { code: RUNTIME_REFUSED });

// The anchor bases a runtime prefix must never equal or contain, in the order they are named.
const RUNTIME_GUARDED_ANCHORS = ["home", "config_dir", "repo", "vault", "git"];

/** `a` equals `b`, or is an ancestor of it — separator-safe (`/h` does not contain `/hx`). */
function covers(a, b) {
  return a === b || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

/**
 * The runtime trust prefixes → sorted, deduped `[{prefix, names}]`. Each prefix must be an
 * absolute path with no '..' segment and must not equal or contain an anchor base; any
 * violation throws (code RUNTIME_REFUSED). Names come from the entries whose prefixes include it.
 */
function runtimeRules(runtime, anchors) {
  if (!runtime || typeof runtime !== "object" || !Array.isArray(runtime.prefixes)) {
    throw runtimeRefusal("seatbelt: runtime must be { prefixes: [...], entries?: [...] } (broker/runtime-trust.mjs::runtimeTrustPaths)");
  }
  if (runtime.entries !== undefined && !Array.isArray(runtime.entries)) throw runtimeRefusal("seatbelt: runtime.entries must be an array");
  const bases = [];
  for (const k of RUNTIME_GUARDED_ANCHORS) if (anchors[k]) bases.push({ name: k, p: anchors[k] });
  for (const c of anchors.checkouts || []) if (c && c.root) bases.push({ name: `checkout ${c.root}`, p: c.root });
  const canon = (p) => real(p) || p;
  const out = new Map();
  for (const raw of runtime.prefixes) {
    if (typeof raw !== "string" || !path.isAbsolute(raw) || raw.split(/[\\/]/).includes("..")) {
      throw runtimeRefusal(`seatbelt: runtime prefix must be an absolute path without '..': ${JSON.stringify(raw)}`);
    }
    const prefix = path.resolve(raw);
    const cp = canon(prefix);
    for (const b of bases) {
      const cb = canon(b.p);
      if (covers(prefix, b.p) || covers(cp, cb)) {
        throw runtimeRefusal(`seatbelt: runtime prefix ${prefix} covers the session's own ${b.name} (${b.p}); write-denying it would deny the session's workspace`);
      }
    }
    if (!out.has(prefix)) out.set(prefix, new Set());
  }
  for (const e of runtime.entries || []) {
    if (!e || typeof e !== "object" || !Array.isArray(e.prefixes)) continue;
    // A name is written into an SBPL comment: a newline in it would start a rule of its own.
    if (typeof e.name !== "string" || !e.name || /[\u0000-\u001f\u007f]/.test(e.name)) {
      throw runtimeRefusal(`seatbelt: runtime entry name must be a non-empty string without control characters: ${JSON.stringify(e.name)}`);
    }
    for (const p of e.prefixes) {
      if (typeof p !== "string" || !path.isAbsolute(p)) continue;
      const key = path.resolve(p);
      if (out.has(key)) out.get(key).add(e.name);
    }
  }
  return [...out.keys()].sort().map((prefix) => ({ prefix, names: [...out.get(prefix)].sort() }));
}

/** Seatbelt string literal: `"` and `\` escaped; control characters refused. */
function sbString(s) {
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new Error(`seatbelt: control character in path ${JSON.stringify(s)}`);
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** POSIX-regex escape for Seatbelt `(regex #"…")`. */
function reEscape(s) {
  return s.replace(/[.^$+?()[\]{}|\\]/g, "\\$&");
}

/**
 * One gitignore-style glob under an absolute base → a Seatbelt filter.
 *   `a/b`      → (literal "<base>/a/b")
 *   `a/**`     → (subpath "<base>/a")                 the dir itself and everything below
 *   otherwise  → (regex #"^<base>/…$")  with `**` = any depth, `*` = one segment, `?` = one char
 */
export function globFilter(base, glob) {
  if (typeof glob !== "string" || !glob || glob.startsWith("/") || glob.split("/").includes("..")) {
    throw new Error(`seatbelt: protected path must be a relative glob without '..': ${JSON.stringify(glob)}`);
  }
  const g = glob.replace(/\/+$/, "");
  if (g === "**") return `(subpath ${sbString(base)})`;
  if (!/[*?[]/.test(g)) return `(literal ${sbString(path.join(base, g))})`;
  if (g.endsWith("/**") && !/[*?[]/.test(g.slice(0, -3))) return `(subpath ${sbString(path.join(base, g.slice(0, -3)))})`;
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      // `**/` matches zero or more segments; a trailing `**` matches anything below.
      if (g[i + 2] === "/") { re += "(.*/)?"; i += 2; } else { re += ".*"; i += 1; }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "[") throw new Error(`seatbelt: bracket globs are not supported: ${JSON.stringify(glob)}`);
    else re += reEscape(c);
  }
  const head = reEscape(base.endsWith("/") ? base : base + "/");
  if (/"/.test(head + re)) throw new Error(`seatbelt: '"' in a regex path: ${JSON.stringify(glob)}`);
  return `(regex #"^${head}${re}$")`;
}

/** The literal directories between `base` (exclusive) and the glob's first wildcard segment. */
function ancestorsInside(base, glob) {
  const segs = glob.replace(/\/+$/, "").split("/");
  const out = [];
  for (let i = 0; i < segs.length - 1; i++) {
    if (/[*?[]/.test(segs[i])) break;
    out.push(path.join(base, ...segs.slice(0, i + 1)));
  }
  return out;
}

/** Canonical (realpath) form, or null when the path does not resolve. */
function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Resolve the three anchors to REAL paths. `repo` paths under `.git/` belong to the
 * repository's COMMON git dir (a linked worktree's `.git` is a file), returned as `git`.
 * Missing ⇒ null, never a guess.
 */
export function resolveAnchors({ repoDir, homeDir = process.env.HOME, configDir = process.env.CLAUDE_CONFIG_DIR, vaultDir = null } = {}) {
  const repo = repoDir ? real(repoDir) : null;
  // The COMMON git dir, read from the `.git` dir / `gitdir:` + `commondir` files by the shared
  // linux.mjs::resolveGitDirs — no git process here (every git spawn under .claude/hooks goes
  // through git-subprocess-env.js, and the checkout listing below does).
  const dirs = repo ? resolveGitDirs(repo) : null;
  const git = dirs ? dirs.commonDir : null;
  // EVERY checkout of the rendered repository — the primary and each linked worktree — not
  // just the one the profile is rendered for: a session in one lane must not be able to
  // rewrite another checkout's `.claude/hooks` or settings. Each entry carries its own git
  // dir, so a linked checkout's `.git` pointer and `config.worktree` are denied too.
  const checkouts = repo
    ? listCheckouts(repo).map((root) => {
        const d = resolveGitDirs(root);
        return { root, gitDir: d ? d.gitDir : null, linked: !!d && d.gitDir !== d.commonDir };
      })
    : null;
  return {
    repo,
    git,
    checkouts,
    home: homeDir ? real(homeDir) : null,
    config_dir: configDir ? real(configDir) : null,
    vault: vaultDir ? real(vaultDir) : null,
  };
}

/**
 * @param {{policy: object, anchors: {repo, git, home, config_dir, vault?, checkouts?}, allowUnanchored?: boolean,
 *   runtime?: {prefixes: string[], entries?: Array<{name: string, prefixes: string[]}>}}} a
 *   `runtime` is the result of `broker/runtime-trust.mjs::runtimeTrustPaths`: each prefix (sorted,
 *   deduped) becomes one `(deny file-write* (subpath …)) ; runtime: <names>` rule after the
 *   protected rules. A prefix that is not absolute, holds a '..' segment, or equals/contains an
 *   anchor base (home, config_dir, repo, vault, git, a checkout root) throws (code RUNTIME_REFUSED).
 *   Absent ⇒ no runtime rules, and `gaps` says the interpreter and programs are NOT write-denied.
 * @returns {{profile: string, denied: Array<{id, filter, base, glob}>, runtimeDenied: Array<{prefix: string, names: string[]}>,
 *   unanchored: string[], optionalAbsent: string[], gaps: string[], pinnedDirs: string[]}}
 *   `pinnedDirs` are the directories the profile pins against unlink (every anchor base and every
 *   directory between an anchor and a protected path); see preparePinnedDirs.
 *   `runtimeDenied` is kept OUT of `denied`: hardLinkedTargets walks `denied` and must not walk an
 *   install prefix.
 */
export function generateSeatbeltProfile({ policy, anchors, allowUnanchored = false, runtime = undefined }) {
  if (!policy || policy.version !== 1 || !Array.isArray(policy.protected_write)) {
    throw new Error("seatbelt: policy must be { version: 1, protected_write: [...] }");
  }
  if (!anchors || typeof anchors !== "object") throw new Error("seatbelt: anchors are required (resolveAnchors)");
  const rules = [];
  const ancestors = new Set();
  const denied = [];
  const unanchored = [];
  const optionalAbsent = [];
  for (const e of policy.protected_write) {
    if (!e || typeof e.id !== "string" || typeof e.anchor !== "string" || !e.anchor) {
      throw new Error(`seatbelt: protected_write entry needs an id and an anchor: ${JSON.stringify(e)}`);
    }
    if (OPTIONAL_ANCHORS.includes(e.anchor) && !anchors[e.anchor]) {
      optionalAbsent.push(e.id);
      continue;
    }
    let base = anchors[e.anchor];
    let glob = e.path;
    let bases = null;
    if (e.anchor === "repo" && /^\.git(\/|$)/.test(glob)) {
      base = anchors.git;
      glob = glob.replace(/^\.git\/?/, "") || null;
      if (!glob) throw new Error(`seatbelt: '${e.id}' protects the whole git dir; commits must keep working`);
    } else if (e.anchor === "repo" && Array.isArray(anchors.checkouts) && anchors.checkouts.length) {
      // A repo-anchored row binds in EVERY checkout (resolveAnchors::checkouts).
      bases = anchors.checkouts.map((c) => c.root);
    }
    if (!base || !path.isAbsolute(base)) {
      unanchored.push(e.id);
      continue;
    }
    for (base of bases || [base]) {
      const filter = globFilter(base, glob);
      rules.push(`(deny file-write* ${filter}) ; ${e.id}`);
      denied.push({ id: e.id, filter, base, glob });
      for (const a of ancestorsInside(base, glob)) ancestors.add(a);
      // The ANCHOR itself (a checkout root, the common git dir, the config dir, home, the
      // vault) is pinned too: renaming it carries its protected tree away from under its name.
      ancestors.add(base);
    }
  }
  for (const c of anchors.checkouts || []) {
    // The checkout root itself cannot be renamed away from under its guard set.
    ancestors.add(c.root);
    if (!c.gitDir) continue;
    // EVERY checkout's per-worktree config, the PRIMARY's included (R2a H-5): with
    // extensions.worktreeConfig set, a CREATED `<gitdir>/config.worktree` carrying core.hooksPath
    // or core.fsmonitor runs agent code in every unsandboxed git there (broker writers, land-lane,
    // the operator). A literal deny refuses creation as well as rewrite.
    rules.push(`(deny file-write* (literal ${sbString(path.join(c.gitDir, "config.worktree"))})) ; per-worktree git config`);
    if (!c.linked) continue;
    // A linked checkout's `.git` is a pointer file: rewriting it re-points the checkout at a
    // git dir with hooks of the writer's choosing.
    rules.push(`(deny file-write* (literal ${sbString(path.join(c.root, ".git"))})) ; gitdir pointer of a linked checkout`);
  }
  if (unanchored.length && !allowUnanchored) {
    throw new Error(`seatbelt: unresolved anchor for ${unanchored.join(", ")} — refusing to emit a profile that silently omits them`);
  }
  const runtimeDenied = runtime === undefined ? [] : runtimeRules(runtime, anchors);
  const runtimeLines =
    runtime === undefined
      ? []
      : [
          `;; runtime trust prefixes (broker/runtime-trust.mjs::runtimeTrustPaths): ${runtimeDenied.length}`,
          ...runtimeDenied.map((r) => `(deny file-write* (subpath ${sbString(r.prefix)})) ; runtime: ${r.names.join(",")}`),
        ];
  const gaps = [
    "network: the policy's network block is not enforced by the Seatbelt profile (network stays allowed)",
    "writable: the policy's writable allowlist is not enforced; this profile refuses the protected set only",
  ];
  if (unanchored.length) gaps.push(`unanchored (not protected on this host): ${unanchored.join(", ")}`);
  if (optionalAbsent.length) gaps.push(`optional anchor absent, rows render nothing: ${optionalAbsent.join(", ")}`);
  if (runtime === undefined) {
    gaps.push("runtime: no runtime trust prefixes supplied — the interpreter and programs trusted writers run are NOT write-denied");
  } else {
    gaps.push("runtime: a hard link made BEFORE launch from outside a runtime prefix to a file inside it is not covered (Seatbelt decides by path)");
  }
  const lines = [
    "(version 1)",
    ";; generated by guard-foundation/os-profile/seatbelt.mjs from policy/protected-paths.json — do not edit",
    "(allow default)",
    ...rules,
    ...runtimeLines,
    ...[...ancestors].sort().map((a) => `(deny file-write-unlink (literal ${sbString(a)})) ; ancestor of a protected path`),
    "",
  ];
  return { profile: lines.join("\n"), denied, runtimeDenied, unanchored, optionalAbsent, gaps, pinnedDirs: [...ancestors].sort() };
}

/**
 * Protected regular files that ALREADY carry a second hard link. Seatbelt decides by path, so a
 * write through the OTHER name (outside every protected path) changes the protected inode. Such a
 * file cannot be covered by a profile: a launcher MUST refuse to run while any exists. Walks each
 * denied target (a literal file, a subpath dir, or the files a regex row matches in its dir);
 * symlinks are not followed.
 * @returns {string[]} absolute paths, sorted
 */
export function hardLinkedTargets(result) {
  const hits = new Set();
  const walk = (p) => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) for (const n of fs.readdirSync(p)) walk(path.join(p, n));
    else if (st.isFile() && st.nlink > 1) hits.add(p);
  };
  for (const d of result.denied || []) {
    if (!d.base || !d.glob) continue;
    const g = d.glob.replace(/\/+$/, "");
    if (g === "**") walk(d.base);
    else if (!/[*?[]/.test(g)) walk(path.join(d.base, g));
    else if (g.endsWith("/**") && !/[*?[]/.test(g.slice(0, -3))) walk(path.join(d.base, g.slice(0, -3)));
    else {
      // A wildcard row: walk the deepest literal directory above the first wildcard, keeping the
      // files the row's own filter matches.
      const segs = g.split("/");
      const lit = [];
      for (const s of segs) {
        if (/[*?[]/.test(s)) break;
        lit.push(s);
      }
      const re = new RegExp(/#"(.*)"\)$/.exec(d.filter)[1]);
      const collect = (p) => {
        let st;
        try {
          st = fs.lstatSync(p);
        } catch {
          return;
        }
        if (st.isDirectory()) for (const n of fs.readdirSync(p)) collect(path.join(p, n));
        else if (st.isFile() && st.nlink > 1 && re.test(p)) hits.add(p);
      };
      collect(path.join(d.base, ...lit));
    }
  }
  return [...hits].sort();
}

/**
 * Make every pinned directory a REAL directory before the profile applies. The unlink pin on a
 * directory only holds while it EXISTS. An absent `~/.gnupg` or `~/.config` can be CREATED from
 * inside the sandbox, by renaming a staged directory into place or planting a symlink there, and
 * its `gpg.conf` / `curlrc` then sits outside every protected row. (Measured on Darwin: rc=0 for
 * both.) So each pinned directory that is absent is created (mode 0700, parents first). One that
 * exists as a symlink or a non-directory THROWS, naming the path: the launcher must refuse
 * rather than protect a name that points elsewhere. An existing real directory is left
 * untouched, mode included.
 * @returns {string[]} the directories created, in creation order
 */
export function preparePinnedDirs(result) {
  const created = [];
  const dirs = [...(result.pinnedDirs || [])].sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || (a < b ? -1 : a > b ? 1 : 0));
  for (const d of dirs) {
    let st = null;
    try {
      st = fs.lstatSync(d);
    } catch (e) {
      if (e.code !== "ENOENT") throw new Error(`pinned directory ${d} could not be checked: ${e.code || e.message}`);
    }
    if (!st) {
      fs.mkdirSync(d, { mode: 0o700 });
      created.push(d);
      st = fs.lstatSync(d);
    }
    if (st.isSymbolicLink()) throw new Error(`pinned directory ${d} is a symlink; the profile would protect the name, not what it points to`);
    if (!st.isDirectory()) throw new Error(`pinned directory ${d} exists but is not a directory`);
  }
  return created;
}

// ---- The profile FILE: one SBPL file `sandbox-exec -f` reads directly, whose header ----
// carries the format, its version, a sha256 pin over the body and a detached-signature
// slot (csq verifies the signature; trestle and the launcher verify the pin). The header
// lines are SBPL comments, so the same bytes are the pinned artifact AND the profile.

const HEADER_RE = /^;; (format|format_version|policy_sha256|sha256|signature): (.*)$/;

function bodyOf(text) {
  return text
    .split("\n")
    .filter((l) => !/^;; (sha256|signature): /.test(l))
    .join("\n");
}

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

/** Render the pinned profile file from a generateSeatbeltProfile result. */
export function renderProfileFile(result, { policySha256 = null } = {}) {
  const body = [
    `;; format: ${PROFILE_FORMAT}`,
    `;; format_version: ${PROFILE_FORMAT_VERSION}`,
    `;; policy_sha256: ${policySha256 || "none"}`,
    result.profile,
  ].join("\n");
  return [`;; sha256: ${sha256(body)}`, ";; signature: none", body].join("\n");
}

/**
 * Parse and verify a profile file: the format and version this code knows, a sha256 that
 * matches the body, and (when given) the caller's pin. Throws on any mismatch.
 */
export function verifyProfileFile(text, { expectSha256 } = {}) {
  if (typeof text !== "string") throw new Error("profile is not text");
  const head = {};
  for (const l of text.split("\n")) {
    const m = HEADER_RE.exec(l);
    if (m && !(m[1] in head)) head[m[1]] = m[2];
  }
  if (head.format !== PROFILE_FORMAT) throw new Error(`profile format ${JSON.stringify(head.format)} is not ${PROFILE_FORMAT}`);
  if (head.format_version !== String(PROFILE_FORMAT_VERSION)) {
    throw new Error(`profile format_version ${JSON.stringify(head.format_version)} is not ${PROFILE_FORMAT_VERSION}`);
  }
  const digest = sha256(bodyOf(text));
  if (head.sha256 !== digest) throw new Error("profile sha256 does not match its body (edited after rendering)");
  if (expectSha256 && expectSha256 !== digest) throw new Error("profile sha256 is not the pinned value");
  return { sha256: digest, signature: head.signature === "none" ? null : head.signature, policySha256: head.policy_sha256 };
}

/**
 * Prove Seatbelt APPLIES on this host: a scratch file denied by a one-line profile must be
 * unchanged after a write attempt under `sandbox-exec`. Anything else — sandbox-exec
 * missing, the profile rejected, the write getting through — is { ok: false, reason }, and a
 * launcher MUST NOT then run the CLI unsandboxed.
 */
export function probeSandbox(spawnSync) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gf-sb-probe-")));
  try {
    const f = path.join(dir, "probe");
    fs.writeFileSync(f, "probe\n");
    const prof = `(version 1)(allow default)(deny file-write* (literal ${sbString(f)}))`;
    const r = spawnSync("/usr/bin/sandbox-exec", ["-p", prof, "/bin/sh", "-c", 'echo x >> "$1"', "sh", f], { encoding: "utf8" });
    if (r.error) return { ok: false, reason: `sandbox-exec not runnable: ${r.error.code || r.error.message}` };
    if (fs.readFileSync(f, "utf8") !== "probe\n") return { ok: false, reason: "a write to a denied file got through" };
    if (r.status === 0) return { ok: false, reason: "the probe write reported success" };
    if (!/Operation not permitted/.test(r.stderr || "")) return { ok: false, reason: `the probe failed for another reason: ${(r.stderr || "").trim().slice(0, 200)}` };
    return { ok: true };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
