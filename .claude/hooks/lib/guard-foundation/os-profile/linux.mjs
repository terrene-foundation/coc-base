// Linux OS sandbox profile generator (guard foundation S2).
//
// Reads the CLI-neutral policy (policy/protected-paths.json) and emits the
// argv a LAUNCHER (csq at session launch, trestle at remote placement) puts in
// front of ANY CLI: `bwrap <argv> -- <cli> ...`. Nothing here depends on which
// CLI runs inside; the CLI-native sandboxes are extra layers, never this one.
//
// Mechanism: the whole filesystem stays writable as the invoking user sees it
// (`--bind / /`), and every protected path that EXISTS is re-mounted
// read-only on top (`--ro-bind P P`). Inside the namespace a write, truncate,
// unlink or rename of a protected file fails with EROFS/EBUSY, and the mount
// cannot be undone: bwrap drops every capability before exec, so the CLI has
// no CAP_SYS_ADMIN in its user namespace to umount with.
//
// What it CANNOT protect, stated rather than hidden (returned in `absent` and
// `gaps`, so a launcher can refuse or pre-create):
//   - a protected FILE that does not exist yet: there is no inode to mount
//     over, and creating one would write the real tree. A launcher that wants
//     it covered pre-creates it (`precreate`) before applying the profile.
//   - Landlock: Landlock rulesets are allow-lists of handled rights, so "all
//     writable except P" is not expressible without enumerating every other
//     writable root. It is declared as a gap, not approximated.
//   - network: policy.network is recorded but not enforced at this layer.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const { resolveGitBinary, gitEnv } = createRequire(import.meta.url)("../../git-subprocess-env.js");
// The shared non-blocking, fd-checked reader (O_NONBLOCK, O_NOFOLLOW on the final
// component, fstat on the opened fd). Imported, never copied: see `resolveGitDirs`.
const { readRegularFileBounded } = createRequire(import.meta.url)("../../landing-window-read.js");

export const PROFILE_KIND = "linux-bwrap";

// ---- DISABLED UNTIL RUN 9: the public builders refuse (fail closed, no override) ----
//
// Open HIGH finding, measured at 7e7685760: a write from a working directory
// inherited from before launch is not covered by the read-only binds. Until
// RUN 9 fixes it, every PUBLIC entry point that generates, renders or applies
// a Linux profile — generateLinuxProfile, renderProfileFile, unshareSetupScript,
// sandboxCommand — throws an Error with code RUN_DISABLED and this text, so a
// third-party launcher cannot build and apply a profile that is known to leak.
// The working builders stay reachable ONLY through `_internalLinuxProfile`,
// used by linux-launch.mjs (its `render` verb, and the disabled `run` path) and
// by this directory's tests. Lifting the refusal is a code change, not a switch.
export const RUN_DISABLED =
  "linux launcher disabled: open finding — writes from an inherited pre-launch cwd are not covered by the read-only binds (measured at 7e7685760); fix scheduled RUN 9";
export const RUN_DISABLED_CODE = "RUN_DISABLED";

function refuseDisabled(entryPoint) {
  const e = new Error(RUN_DISABLED);
  e.code = RUN_DISABLED_CODE;
  e.entryPoint = entryPoint;
  throw e;
}

/** Resolve one policy entry's anchor to an absolute base directory. */
function anchorBase(anchor, ctx) {
  if (anchor === "repo") return ctx.repoRoot;
  if (anchor === "home") return ctx.home;
  if (anchor === "config_dir") return ctx.configDir;
  if (anchor === "vault") return ctx.vault;
  if (anchor === "worktrees") return ctx.worktrees;
  if (anchor === "tmp") return ctx.tmp;
  throw new TypeError(`unknown anchor ${JSON.stringify(anchor)}`);
}

/**
 * Expand one gitignore-style policy glob into concrete absolute paths.
 * Supported shapes (the policy contract's): an exact path; `dir/**` (the
 * directory itself is mounted read-only, which covers everything under it,
 * including files created later); `*` within the LAST segment, expanded
 * against what exists now; `{a,b}` alternation in the last segment.
 * Any other wildcard is refused loudly rather than silently under-matched.
 */
export function expandEntry(entry, ctx) {
  let base = anchorBase(entry.anchor, ctx);
  // The vault anchor is optional by contract: no vault supplied renders nothing.
  if (!base && entry.anchor === "vault") return { paths: [], absent: [] };
  if (!base) return { paths: [], absent: [entry.path], gap: `anchor ${entry.anchor} unresolved` };
  let rel = String(entry.path).replace(/^\/+/, "");
  if (rel === "**") return { paths: [base], absent: [], base };
  if (rel.endsWith("/**")) rel = rel.slice(0, -3);
  // `.git/...` under the REPO anchor means the git dir of THAT root only. In
  // a linked worktree `.git` is a file, and hooks/config live in the common
  // dir it points at; the per-worktree `config.worktree` is protected too.
  let extra = [];
  if (entry.anchor === "repo" && (rel === ".git" || rel.startsWith(".git/")) && ctx.git) {
    base = ctx.git.commonDir;
    rel = rel === ".git" ? "" : rel.slice(".git/".length);
    if (rel === "config" && ctx.git.gitDir !== ctx.git.commonDir) {
      const wtConfig = path.join(ctx.git.gitDir, "config.worktree");
      if (fs.existsSync(wtConfig)) extra = [wtConfig];
    }
    if (!rel) return { paths: [base], absent: [], base };
  }
  const segs = rel.split("/");
  const last = segs.pop();
  if (segs.some((s) => /[*?[\]{}]/.test(s))) {
    throw new TypeError(`unsupported glob (wildcard before the last segment): ${entry.path}`);
  }
  const dir = path.join(base, ...segs);
  const brace = last.match(/\{([^}]*)\}/);
  const alternatives = brace ? brace[1].split(",").map((alt) => last.replace(brace[0], alt)) : [last];
  const paths = [...extra];
  const absent = [];
  for (const alt of alternatives) {
    if (/[?[\]]/.test(alt)) throw new TypeError(`unsupported glob character in ${entry.path}`);
    if (alt.includes("*")) {
      const re = new RegExp(`^${alt.split("*").map((p) => p.replace(/[.+^${}()|\\]/g, "\\$&")).join("[^/]*")}$`);
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        names = [];
      }
      const hits = names.filter((n) => re.test(n)).sort();
      if (hits.length === 0) absent.push(path.join(dir, alt));
      for (const n of hits) paths.push(path.join(dir, n));
    } else {
      const p = path.join(dir, alt);
      if (fs.existsSync(p)) paths.push(p);
      else absent.push(p);
    }
  }
  return { paths, absent, base };
}

/** The git dir and common dir of `root` (a linked worktree's `.git` is a file). */
export function resolveGitDirs(root) {
  const dotGit = path.join(root, ".git");
  let st;
  try {
    st = fs.statSync(dotGit);
  } catch {
    return null;
  }
  if (st.isDirectory()) return { gitDir: fs.realpathSync(dotGit), commonDir: fs.realpathSync(dotGit) };
  // Both reads go through `readRegularFileBounded` and are decided on the OPENED fd.
  // A plain readFileSync of a non-directory `.git` (a FIFO needs no race: statSync
  // reports it non-directory and the read then blocked) or of `commondir` parked the
  // launcher (seatbelt.mjs::resolveAnchors, for the primary and every checkout).
  // A refusal THROWS, as an unreadable or malformed pointer always did: returning
  // null here would drop that checkout's git dir from the profile's deny set.
  const dotGitRead = readRegularFileBounded(dotGit);
  if (!dotGitRead.ok) throw new Error(`${dotGit} could not be read as a regular file: ${dotGitRead.reason}`);
  const m = dotGitRead.text.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m) throw new Error(`${dotGit} is a file without a gitdir: line`);
  const gitDir = fs.realpathSync(path.resolve(root, m[1]));
  let commonDir = gitDir;
  const cd = path.join(gitDir, "commondir");
  const side = readRegularFileBounded(cd);
  if (side.ok) commonDir = fs.realpathSync(path.resolve(gitDir, side.text.trim()));
  else if (side.code !== "ENOENT") throw new Error(`${cd} could not be read as a regular file: ${side.reason}`);
  return { gitDir, commonDir };
}

/**
 * Every checkout of the repository `root` belongs to: the primary plus every
 * `git worktree list --porcelain` entry (prunable and bare entries skipped).
 * git runs through the shared helper (absolute binary, constants-built env).
 * A failure to list THROWS: rendering for fewer checkouts than exist would
 * leave a sibling's guard set writable from inside the profile.
 */
export function listCheckouts(root) {
  const r = spawnSync(resolveGitBinary(), ["-C", root, "worktree", "list", "--porcelain"], {
    env: gitEnv(),
    encoding: "utf8",
  });
  if (r.error || r.status !== 0) {
    throw new Error(`git worktree list failed for ${root}: ${r.error ? r.error.message : (r.stderr || "").trim()}`);
  }
  const out = [];
  for (const block of r.stdout.split(/\n\n+/)) {
    const lines = block.split("\n");
    const wt = lines.find((l) => l.startsWith("worktree "));
    if (!wt || lines.some((l) => l === "bare" || l.startsWith("prunable"))) continue;
    const p = wt.slice("worktree ".length);
    if (fs.existsSync(p)) out.push(fs.realpathSync(p));
  }
  const self = fs.realpathSync(root);
  if (!out.includes(self)) out.push(self);
  return [...new Set(out)].sort();
}

/** Regular files at or under `p` (symlinks not followed) whose link count exceeds 1. */
function hardLinked(p) {
  const hits = [];
  const walk = (q) => {
    let st;
    try {
      st = fs.lstatSync(q);
    } catch {
      return;
    }
    if (st.isDirectory()) for (const n of fs.readdirSync(q)) walk(path.join(q, n));
    else if (st.isFile() && st.nlink > 1) hits.push(q);
  };
  walk(p);
  return hits;
}

/**
 * Generate the bwrap argv for `policy`, rendered from ONE repo root:
 * `{ repoRoot, home, configDir, vault, worktrees, tmp, precreate }`.
 *
 * - EVERY checkout of that repo is covered (listCheckouts): a session in one
 *   lane cannot write the primary's or a sibling lane's guard set. `.git/...`
 *   entries resolve to the shared common dir once; each linked checkout's
 *   `.git` FILE (its gitdir pointer) is protected too, or rewriting it would
 *   point the checkout at a git dir with hooks of the writer's choosing.
 * - ANCESTORS are pinned: every directory from a protected path up to its
 *   anchor is bound onto itself (still WRITABLE) so it is a mount point that
 *   cannot be renamed or removed (EBUSY). Without that, `mv` of a parent
 *   carries the read-only mounts away and the tree is re-created unprotected.
 * - HARD LINKS: a protected file with a second name outside the mount is
 *   writable through it, so such files are reported in `hardlinked` and the
 *   launcher refuses. New hard links into a read-only mount fail (EXDEV/EROFS).
 *
 * Returns { kind, repo_root, checkouts, argv, protected, absent, hardlinked,
 * trusted_writers, gaps, policy_sha256 }. Output order is deterministic.
 */
function generateProfile(policy, ctx) {
  if (!policy || policy.version !== 1 || !Array.isArray(policy.protected_write)) {
    throw new TypeError("policy must be version 1 with a protected_write array");
  }
  if (!ctx || !ctx.repoRoot) throw new TypeError("ctx.repoRoot is required");
  const real = (p) => (p ? fs.realpathSync(p) : p);
  const optDir = (p) => (p && fs.existsSync(p) ? real(p) : null);
  const base = {
    home: optDir(ctx.home),
    configDir: optDir(ctx.configDir),
    vault: optDir(ctx.vault),
    worktrees: optDir(ctx.worktrees),
    tmp: optDir(ctx.tmp),
  };
  const repoRoot = real(ctx.repoRoot);
  const checkouts = listCheckouts(repoRoot);

  const prot = [];
  const absent = [];
  const gaps = [];
  const seen = new Set();
  const ancestors = new Set();
  // From the protected path's parent up to AND INCLUDING its anchor: a renamed
  // repo root, common .git or config dir re-created unprotected is the same
  // escape as a renamed `.claude/learning`. Nothing above the anchor is pinned.
  const pinAncestors = (p, anchorBase) => {
    if (!anchorBase || p === anchorBase) return;
    const inside = (d) => d === anchorBase || d.startsWith(anchorBase + path.sep);
    for (let d = path.dirname(p); inside(d); d = path.dirname(d)) {
      ancestors.add(d);
      if (d === anchorBase) break;
    }
  };
  const add = (id, p, anchorBase) => {
    if (seen.has(p)) return;
    seen.add(p);
    // `target` is the RESOLVED path: when p is a symlink, binding only the
    // link would leave the real file writable through its other name.
    prot.push({ id, path: p, target: fs.realpathSync(p) });
    pinAncestors(p, anchorBase);
  };
  for (const root of checkouts) {
    const c = { ...base, repoRoot: root, git: resolveGitDirs(root) };
    for (const entry of policy.protected_write) {
      if (entry.anchor !== "repo" && root !== repoRoot) continue; // non-repo anchors once
      const r = expandEntry(entry, c);
      if (r.gap && root === repoRoot) gaps.push(`${entry.id}: ${r.gap}`);
      for (const p of r.absent) {
        // A glob with no match comes back as its PATTERN (`.gnupg/*.conf`): precreate would write a
        // file literally named `*.conf`, which covers no real option file. Such a row stays absent
        // (reported, not covered): binding a not-yet-created name is the RUN 9 Linux design question.
        if (ctx.precreate && !/[*]/.test(path.basename(p))) {
          // A `dir/**` entry is created as a private DIRECTORY (the broker's
          // socket dir is one); a file entry as an empty JSON object, not an
          // empty file, so a CLI that parses its settings reads "no settings".
          const isDir = entry.path === "**" || entry.path.endsWith("/**");
          if (isDir) fs.mkdirSync(p, { recursive: true, mode: 0o700 });
          else {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, p.endsWith(".json") ? "{}\n" : "", { flag: "wx" });
          }
          r.paths.push(p);
        } else if (!absent.some((a) => a.path === p)) {
          absent.push({ id: entry.id, path: p });
        }
      }
      for (const p of r.paths) add(entry.id, p, r.base);
    }
    if (c.git && c.git.gitDir !== path.join(root, ".git")) add("git-link", path.join(root, ".git"), root);
  }
  const hardlinked = prot.flatMap(({ path: p }) => hardLinked(p));

  const argv = ["--die-with-parent", "--bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
  // Ancestors first, shallowest first, so each later mount lands on top.
  const protectedSet = new Set(prot.map((p) => p.path));
  const pinned = [...ancestors].filter((d) => !protectedSet.has(d)).sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  for (const d of pinned) argv.push("--bind", d, d);
  for (const { path: p, target } of prot) {
    argv.push("--ro-bind", target, target);
    if (target !== p) argv.push("--ro-bind", target, p);
  }
  gaps.push("landlock: not emitted — an allow-list ruleset cannot express 'writable except P' without enumerating every other root");
  if (Array.isArray(policy.network) && policy.network.length) {
    gaps.push("network: policy.network is not enforced by this profile");
  }
  // Trusted writers (land-lane, the train) write protected paths by design:
  // they run OUTSIDE this profile or through the broker, never inside it.
  const trusted = (policy.trusted_writers || []).map((w) => ({ id: w.id, entry: w.entry, runs: "outside-profile" }));
  return {
    kind: PROFILE_KIND,
    repo_root: repoRoot,
    checkouts,
    argv,
    pinned,
    protected: prot,
    absent,
    hardlinked,
    trusted_writers: trusted,
    gaps,
    policy_sha256: policy.integrity && policy.integrity.sha256 ? policy.integrity.sha256 : null,
    // The anchors the profile was rendered for: the launcher binds the broker
    // to these, so the broker and the sandbox protect the same world.
    anchors: { home: base.home, config_dir: base.configDir, vault: base.vault },
  };
}

// ---- Profile FILE: format version + sha256 pin + detached-signature slot ----

export const PROFILE_FORMAT = "loom-guard-os-profile/linux-bwrap";
export const PROFILE_FORMAT_VERSION = 1;

/** Stable JSON: object keys sorted at every depth. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** sha256 over the profile body (everything except `sha256` and `signature`). */
export function profileDigest(file) {
  const { sha256: _s, signature: _g, ...body } = file;
  return crypto.createHash("sha256").update(stable(body)).digest("hex");
}

/** Render a generated profile as the file a launcher (csq, trestle, linux-launch.mjs) consumes. */
function renderFile(profile) {
  // `disabled` sits INSIDE the hashed body and is set last, so no input can
  // omit it: until RUN 9 every rendered Linux profile says it must not be applied.
  const body = { format: PROFILE_FORMAT, format_version: PROFILE_FORMAT_VERSION, ...profile, disabled: RUN_DISABLED };
  const file = { ...body, sha256: profileDigest(body), signature: null };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * INTERNAL verifier. Parse and verify a profile file. Refuses (throws) on a
 * wrong format, a version this code does not know, a sha256 that does not
 * match the body, or a pin (`expectSha256`) the caller supplied that the file
 * does not carry. The `signature` slot is carried for csq; verifying it is the
 * consumer's. Does NOT refuse the RUN 9 marker: reached only through
 * `_internalLinuxProfile` (the render verb's self-check and the tests).
 */
function verifyFile(text, { expectSha256 } = {}) {
  let file;
  try {
    file = JSON.parse(text);
  } catch (e) {
    throw new Error(`profile is not JSON: ${e.message}`);
  }
  if (file.format !== PROFILE_FORMAT) throw new Error(`profile format ${JSON.stringify(file.format)} is not ${PROFILE_FORMAT}`);
  if (file.format_version !== PROFILE_FORMAT_VERSION) {
    throw new Error(`profile format_version ${JSON.stringify(file.format_version)} is not ${PROFILE_FORMAT_VERSION}`);
  }
  const digest = profileDigest(file);
  if (file.sha256 !== digest) throw new Error("profile sha256 does not match its body (edited after rendering)");
  if (expectSha256 && expectSha256 !== digest) throw new Error("profile sha256 is not the pinned value");
  if (!Array.isArray(file.argv) || file.argv.some((a) => typeof a !== "string")) throw new Error("profile argv is malformed");
  return file;
}

/**
 * PUBLIC verifier, the one an external launcher (csq, trestle) calls before
 * applying a profile. The pin is MANDATORY. Until RUN 9 it accepts NO Linux
 * profile: one carrying the `disabled` marker refuses with code RUN_DISABLED,
 * and so does one WITHOUT it — that is a profile rendered before the marker
 * existed or built elsewhere, and it leaks the same way.
 */
export function verifyProfileFile(text, { expectSha256 } = {}) {
  if (!expectSha256) {
    const e = new Error("expectSha256 is required: a self-consistent profile is not evidence it is the one meant to be applied");
    e.code = "PIN_REQUIRED";
    throw e;
  }
  const file = verifyFile(text, { expectSha256 });
  if (file.disabled !== undefined) refuseDisabled("verifyProfileFile");
  refuseDisabled("verifyProfileFile(unmarked profile)");
}

// ---- Backends: the SAME profile applied by bwrap or by a managed unshare ----
//
// bwrap is one way to apply the profile; where unprivileged user namespaces
// are restricted (AppArmor), a host may instead grant the exception to ONE
// managed `unshare` binary. That binary's path is an operator/host fact: it is
// a PARAMETER (`unshareBin`, the launcher's --unshare or LOOM_GUARD_UNSHARE),
// supplied at placement, never written into this repo.
//
// The unshare backend reproduces exactly what the profile uses from bwrap:
//   1. a new user + mount namespace, root mapped to the caller (-U -r -m),
//      with mount propagation made private so nothing leaks to the host;
//   2. every pinned ancestor bound onto itself (writable mount point) and
//      every protected path bound read-only, in the same order as the argv;
//   3. EVERY capability dropped before the CLI runs (setpriv: bounding set,
//      inheritable and ambient cleared, no_new_privs, and securebits that
//      stop uid 0 regaining capabilities on exec), so the CLI cannot umount
//      or remount the protections; a nested user namespace cannot undo them
//      either, because mounts copied into a less-privileged namespace are
//      locked;
//   4. the CLI dies with the launcher (setpriv --pdeathsig KILL).

/** Single-quote one word for POSIX sh. */
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** The setpriv flags that leave the CLI with no capability it could use to undo a mount. */
export const SETPRIV_DROP = [
  "--no-new-privs",
  "--bounding-set", "-all",
  "--inh-caps", "-all",
  "--ambient-caps", "-all",
  "--securebits", "+noroot,+noroot_locked,+no_setuid_fixup,+no_setuid_fixup_locked,+keep_caps_locked",
  "--pdeathsig", "KILL",
];

/**
 * The sh script the unshare backend runs as root-in-namespace: apply the
 * profile's mounts, then exec the CLI ("$@") with every capability dropped.
 * Any mount failure aborts before the CLI runs (set -e): never a partial profile.
 */
function setupScript(profile) {
  const lines = [
    // A failed step refuses with the launcher's exit code before the CLI runs.
    'fail() { echo "REFUSING: profile setup failed: $1. Nothing was run." >&2; exit 3; }',
    // Read-only bind. Inside a user namespace the flags the source mount
    // carries (nosuid, nodev, noexec, atime) are LOCKED, and a remount that
    // drops any of them is refused with EPERM, so they are carried over.
    "ro_bind() {",
    '  mount --bind "$1" "$2" || fail "bind $2"',
    "  keep=$(findmnt -no OPTIONS -T \"$2\" | tr ',' '\\n' | grep -xE 'nosuid|nodev|noexec|noatime|nodiratime|relatime|strictatime' | paste -sd, -)",
    '  mount -o "remount,bind,ro${keep:+,$keep}" "$2" || fail "read-only remount of $2"',
    "}",
    'mount --make-rprivate / || fail "private propagation"',
  ];
  for (const d of profile.pinned || []) lines.push(`mount --bind ${shq(d)} ${shq(d)} || fail ${shq(`pin ${d}`)}`);
  for (const { path: p, target } of profile.protected) {
    lines.push(`ro_bind ${shq(target)} ${shq(target)}`);
    if (target !== p) lines.push(`ro_bind ${shq(target)} ${shq(p)}`);
  }
  lines.push(`exec setpriv ${SETPRIV_DROP.map(shq).join(" ")} -- "$@"`);
  return lines.join("\n");
}

/**
 * [binary, args] that run `argv` inside `profile` with the chosen backend:
 * `{ backend: "bwrap" | "unshare", unshareBin, chdir }`.
 */
function buildSandboxCommand(profile, { backend = "bwrap", unshareBin = "unshare", chdir } = {}, argv) {
  if (backend === "bwrap") return ["bwrap", [...profile.argv, ...(chdir ? ["--chdir", chdir] : []), "--", ...argv]];
  if (backend === "unshare") return [unshareBin, ["-U", "-r", "-m", "--", "sh", "-c", setupScript(profile), "sh", ...argv]];
  throw new TypeError(`unknown sandbox backend ${JSON.stringify(backend)}`);
}

// ---- PUBLIC builders: each refuses with RUN_DISABLED until RUN 9 (see the top of this file) ----

/** DISABLED until RUN 9: throws code RUN_DISABLED. */
export function generateLinuxProfile(_policy, _ctx) {
  refuseDisabled("generateLinuxProfile");
}

/** DISABLED until RUN 9: throws code RUN_DISABLED. */
export function renderProfileFile(_profile) {
  refuseDisabled("renderProfileFile");
}

/** DISABLED until RUN 9: throws code RUN_DISABLED. */
export function unshareSetupScript(_profile) {
  refuseDisabled("unshareSetupScript");
}

/** DISABLED until RUN 9: throws code RUN_DISABLED. */
export function sandboxCommand(_profile, _opts, _argv) {
  refuseDisabled("sandboxCommand");
}

/**
 * INTERNAL — not an API. The working builders, for linux-launch.mjs (its
 * `render` verb and the disabled `run` path) and this directory's tests ONLY.
 * Any other caller is building a profile the RUN_DISABLED finding says leaks.
 */
export const _internalLinuxProfile = Object.freeze({
  generateLinuxProfile: generateProfile,
  renderProfileFile: renderFile,
  unshareSetupScript: setupScript,
  sandboxCommand: buildSandboxCommand,
  verifyProfileFile: verifyFile,
});

// ---- Capability probe: the sandbox must demonstrably APPLY here ----

/**
 * Prove a backend can sandbox on this host. A scratch file is mounted
 * read-only by a one-file profile; inside, a write to it must FAIL with
 * EROFS, and an `umount` of it must fail too (the capability drop held).
 * Anything else — the backend missing, user namespaces blocked, the write or
 * the umount getting through — is a refusal: { ok: false, reason }. A
 * launcher MUST NOT run the CLI unsandboxed then.
 */
export function probeSandbox(spawnSyncFn, { backend = "bwrap", unshareBin = "unshare" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gf-probe-"));
  try {
    const f = fs.realpathSync(dir) + path.sep + "probe";
    fs.writeFileSync(f, "probe\n");
    const mini = {
      argv: ["--die-with-parent", "--bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--ro-bind", f, f],
      pinned: [],
      protected: [{ id: "probe", path: f, target: f }],
    };
    const inner = 'echo x >> "$1"; w=$?; if umount "$1" 2>/dev/null; then echo PROBE-UMOUNTED; fi; exit $w';
    const [bin, args] = buildSandboxCommand(mini, { backend, unshareBin }, ["sh", "-c", inner, "sh", f]);
    const r = spawnSyncFn(bin, args, { encoding: "utf8" });
    if (r.error) return { ok: false, reason: `${backend} not runnable: ${r.error.code || r.error.message}` };
    if (fs.readFileSync(f, "utf8") !== "probe\n") return { ok: false, reason: "a write to a read-only-bound file got through" };
    if (/PROBE-UMOUNTED/.test(r.stdout || "")) return { ok: false, reason: "the confined process could umount a protected path (capabilities not dropped)" };
    if (r.status === 0) return { ok: false, reason: "the probe write reported success" };
    // Only EROFS from INSIDE the sandbox proves the profile applied; a backend
    // that failed to start (e.g. "setting up uid map: Permission denied" where
    // unprivileged user namespaces are blocked) also leaves the file unchanged.
    if (!/Read-only file system/i.test(r.stderr || "")) {
      return { ok: false, reason: `${backend} cannot apply a sandbox here: ${(r.stderr || "").trim()}` };
    }
    return { ok: true };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Back-compat name used by the attack test: the bwrap backend's probe. */
export function bwrapAvailable(spawnSyncFn) {
  return probeSandbox(spawnSyncFn, { backend: "bwrap" });
}
