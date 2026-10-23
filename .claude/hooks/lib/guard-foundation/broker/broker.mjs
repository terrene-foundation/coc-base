// Guard foundation S4 — the BROKER: performs sanctioned writes to protected paths
// from OUTSIDE the sandbox, after a policy check.
//
// Inside the sandbox no process can write a protected path (the OS profile and
// the CLI adapters deny it). The few legitimate writers — land-lane, the
// settings repin, the roster, posture and claim writers, the vault tools — are
// named in the policy's `trusted_writers`. The broker, started by the launcher
// OUTSIDE the sandbox for ONE repository, runs exactly those writers on request.
//
// A request names a writer id and its argv. It carries no path, no code, no env
// and no cwd: the broker decides all of them. A request is REFUSED unless:
//   1. it has exactly the shape {v:1, writer, args}, args being short strings;
//   2. the writer id is in the policy's trusted_writers;
//   3. the broker is bound to the PRIMARY checkout of its repository (git's common dir is
//      that checkout's own .git), and the writer's entry is a regular file (not a symlink)
//      whose real path lies inside the real primary — a lane worktree's copy of a writer is
//      lane work the sandbox may edit, so it never runs here (`entry-not-primary`);
//   4. the policy protects the entry;
//   5. the entry's FULL execution closure (closure.mjs: static and dynamic imports, requires,
//      spawned node scripts, executed repo files and the git hooks a git-spawning writer
//      triggers) resolves statically or through a reviewed declaration
//      (`closure-unresolved` otherwise), and every member is a protected regular file inside
//      the primary (`closure-unprotected` otherwise) — an unprotected member is code the
//      sandboxed agent can rewrite, which would turn the broker into an escape;
//   6. every protected path the writer may write resolves inside its anchor: no
//      symlinked parent or member points out of it (symlink escape).
// The writer then runs with `node <entry> <args>` (no node flags), cwd = the
// primary, and an environment reduced to an allowlist (NODE_OPTIONS and the
// like never pass, nor any variable a closure declaration names as moving a code root).
// Every protected path is digested before and after the run;
// a change to a protected path the writer is NOT licensed for, or a symlink that
// now escapes, fails the result and is reported — the broker never reverts.
//
// LANE WORKTREES: a broker started with --repo = a linked worktree refuses every writer
// (`entry-not-primary`). It does not silently swap in the primary's copy: the sandbox profile
// is rendered from the same --repo, so a lane-bound profile protects the worktree's rows and
// leaves the primary's writable — running the primary's copy there would run code the session
// can edit. Bind the launcher (profile and broker) to the primary; lane worktrees stay
// editable lane work, and their bin/ edits take effect only after land-lane lands them.
//
// HONEST LIMITS: see closure.mjs (PATH, programs named by git config, eval over data). A
// writer that writes outside its licence is reported after the fact, not prevented. The
// repository's own unprotected files are inputs the writer may read; protecting them is the
// policy's job, not the broker's.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { loadPolicy, POLICY_PATH, repoProtects } from "../policy/policy.mjs";
import { computeClosure, resolvePrimary, ROOT_ENV } from "./closure.mjs";

export const PROTOCOL_VERSION = 1;
const MAX_ARGS = 64;
const MAX_ARG_LEN = 4096;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_TAIL = 8192;
const ENV_ALLOW = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "SHELL", "TERM", "SSH_AUTH_SOCK"];

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

export class BrokerRefusal extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
  }
}

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return null;
    throw e;
  }
}

/**
 * Does `abs` resolve inside `rootReal`, at the same relative place? The deepest
 * existing ancestor (the path itself when it exists) is realpathed through the
 * same resolver as the root and must sit where the lexical path says it does —
 * so a symlinked parent or member pointing anywhere else fails.
 */
export function resolvesInside(rootReal, abs) {
  const rel = path.relative(rootReal, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  let probe = abs;
  while (!lstatOrNull(probe)) {
    if (probe === rootReal) return false;
    probe = path.dirname(probe);
  }
  try {
    return fs.realpathSync(probe) === path.join(rootReal, path.relative(rootReal, probe));
  } catch {
    return false; // a dangling symlink resolves nowhere
  }
}

/** Is `abs` (already real) inside the real directory `rootReal`? */
function within(rootReal, abs) {
  const rel = path.relative(rootReal, abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * COMPATIBILITY: the closure of `entry` as absolute member paths (entry included), now the
 * FULL execution closure of closure.mjs::computeClosure rather than the static relative-import
 * graph — so a caller asserting "every member is protected" sees every file a brokered run can
 * execute. Git hooks are excluded here (admission checks them from the primary); unresolved
 * sites are not reported here — use computeClosure for those.
 */
export function importClosure(entry, primary = path.dirname(entry)) {
  let root = fs.realpathSync(primary);
  // default: the checkout that holds the entry (walk up to the directory holding .git)
  if (primary === path.dirname(entry)) {
    for (let d = root; ; d = path.dirname(d)) {
      if (lstatOrNull(path.join(d, ".git"))) {
        root = d;
        break;
      }
      if (path.dirname(d) === d) break;
    }
  }
  let entryReal = entry;
  try {
    entryReal = fs.realpathSync(entry);
  } catch {} // a missing entry is a member that does not exist; the caller reports it
  return computeClosure({ primary: root, entry: entryReal, hooks: false }).members.map((m) => m.abs);
}

function rowRoot(anchors, row) {
  const a = anchors[row.anchor];
  return typeof a === "string" && a ? a : null;
}

// The policy row holding the brokers' own sockets. Every launch binds a per-launch socket in that
// directory and removes it on exit, so a CONCURRENT launch changes it during any writer's run.
// Its SOCKET entries are therefore left out of the before/after licence digest (they are not a
// writer's output, and counting them reported an honest writer as outside its licence); every
// other entry under the row — and the row's write-protection in the sandbox — is unchanged.
const BROKER_SOCKET_ROW = "broker-socket-dir";

// ROOT ruling (c), 2026-10-14: these writers load code relative to a requester-supplied --repo
// (land-lane's runLaneNode spawn, build-trust-root's <--repo> require) and stay REFUSED until
// the writer-side fix in RUN 9. Their refusal must say so, never stall silently.
export const OPERATOR_STEP_UNTIL_RUN9 = new Set(["land-lane", "build-trust-root"]);

/** Every file under a protected row, as { abs → digest }. Symlinks record their target. */
function digestRow(rootReal, row, out) {
  const skipSockets = row.id === BROKER_SOCKET_ROW;
  const glob = row.path.endsWith("/**") ? row.path.slice(0, -3) : row.path === "**" ? "" : null;
  const visit = (abs) => {
    const st = lstatOrNull(abs);
    if (!st) return;
    if (skipSockets && st.isSocket()) return;
    if (st.isSymbolicLink()) {
      let target = "";
      try {
        target = fs.readlinkSync(abs);
      } catch {
        target = "?";
      }
      out.set(abs, `link:${target}:${resolvesInside(rootReal, abs) ? "in" : "ESCAPES"}`);
    } else if (st.isDirectory()) {
      if (glob === null) out.set(abs, "dir");
      else for (const n of fs.readdirSync(abs)) visit(path.join(abs, n));
    } else if (st.isFile()) {
      out.set(abs, `file:${(st.mode & 0o7777).toString(8)}:${sha256(fs.readFileSync(abs))}`);
    } else {
      out.set(abs, `other:${st.mode}`);
    }
  };
  visit(glob === null ? path.join(rootReal, row.path) : path.join(rootReal, glob));
}

/** A broker bound to ONE repository and its anchors, holding a loaded, pin-checked policy. */
export function createBroker({ repo, anchors = {}, policyFile = POLICY_PATH, passEnv = [], timeoutMs = RUN_TIMEOUT_MS } = {}) {
  const policy = loadPolicy(policyFile); // throws on a schema error or a pin mismatch
  const repoReal = fs.realpathSync(repo);
  const roots = { repo: repoReal };
  for (const [k, v] of Object.entries(anchors)) {
    if (k === "repo" || typeof v !== "string" || !v) continue;
    try {
      roots[k] = fs.realpathSync(v);
    } catch {
      // An anchor that does not exist renders nothing (the vault on a machine with none).
    }
  }
  const rowsById = new Map(policy.protected_write.map((r) => [r.id, r]));
  const envAllow = [...ENV_ALLOW, ...passEnv.filter((n) => /^[A-Z_][A-Z0-9_]*$/.test(n) && !/^(NODE_|GIT_|LD_|DYLD_)/.test(n) && !ROOT_ENV.includes(n))];
  // The primary checkout, resolved once through the scrubbed git envelope. Unresolvable (not
  // a git checkout, a bare repository, a submodule) refuses every writer, never guesses.
  const pr = resolvePrimary(repoReal);
  const primaryReal = pr.primary || null;

  function snapshot() {
    const out = new Map();
    for (const row of policy.protected_write) {
      const root = rowRoot(roots, row);
      if (root) digestRow(root, row, out);
    }
    return out;
  }

  /** Every check before a run; returns { writer, entryReal, licensed:Set<abs-prefix> } or throws a refusal. */
  function admit(request) {
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new BrokerRefusal("bad-request", "not an object");
    const keys = Object.keys(request).sort().join(",");
    if (keys !== "args,v,writer") throw new BrokerRefusal("bad-request", `keys must be exactly {v, writer, args}, got {${keys}}`);
    if (request.v !== PROTOCOL_VERSION) throw new BrokerRefusal("bad-request", `protocol version ${request.v}`);
    const { writer: id, args } = request;
    if (!Array.isArray(args) || args.length > MAX_ARGS || !args.every((a) => typeof a === "string" && a.length <= MAX_ARG_LEN && !a.includes("\0"))) {
      throw new BrokerRefusal("bad-request", `args must be at most ${MAX_ARGS} strings of at most ${MAX_ARG_LEN} chars, no NUL`);
    }
    const writer = typeof id === "string" ? policy.trusted_writers.find((w) => w.id === id) : null;
    if (!writer) throw new BrokerRefusal("untrusted-writer", `${JSON.stringify(id)} is not a trusted writer in the policy`);

    if (!primaryReal) throw new BrokerRefusal("primary-unresolved", `the primary checkout of ${repoReal} could not be resolved (${pr.error}); no writer runs`);
    // Bound to the primary itself, not merely to a directory inside it: a worktree NESTED in the
    // primary (a scratch checkout under it) would otherwise pass the entry containment below.
    if (repoReal !== primaryReal) throw new BrokerRefusal("entry-not-primary", `the broker is bound to ${repoReal}, which is not the primary checkout ${primaryReal}: trusted writers run only from the primary (bind the broker and the profile to it)`);
    const entryAbs = path.join(repoReal, writer.entry);
    const est = lstatOrNull(entryAbs);
    if (!est || !est.isFile()) throw new BrokerRefusal("entry-not-a-file", `${writer.entry} is missing, or not a regular file (a symlink is refused)`);
    let entryReal = null;
    try {
      entryReal = fs.realpathSync(entryAbs);
    } catch {}
    if (!entryReal || !within(primaryReal, entryReal)) {
      throw new BrokerRefusal("entry-not-primary", `${writer.entry} resolves to ${entryReal || "nothing"}, outside the primary checkout ${primaryReal}: trusted writers run only from the primary (bind the broker and the profile to it)`);
    }
    if (!resolvesInside(repoReal, entryAbs)) throw new BrokerRefusal("symlink-escape", `${writer.entry} resolves outside the repository`);
    if (!repoProtects(policy, writer.entry)) throw new BrokerRefusal("entry-unprotected", `${writer.entry} is not in protected_write`);

    const closure = computeClosure({ primary: primaryReal, entry: entryReal });
    if (closure.unresolved.length) {
      // Every inadmissible load is NAMED — never truncated — so the refusal says exactly what the
      // writer must stop doing; a writer ROOT ruled an operator step (OPERATOR_STEP_UNTIL_RUN9)
      // says so, rather than leaving the caller with a bare refusal.
      const shown = closure.unresolved.map((u) => `${u.file}:${u.line} \`${u.site}\` (${u.reason})`);
      const step = OPERATOR_STEP_UNTIL_RUN9.has(writer.id)
        ? ` — ${writer.id} is an operator step until RUN 9: run it outside the guarded session; the broker will not run it until the writer stops loading code it cannot pin`
        : "";
      throw new BrokerRefusal("closure-unresolved", `${writer.id}'s execution closure has ${closure.unresolved.length} inadmissible load(s), each resolving neither statically nor by a reviewed declaration: ${shown.join("; ")}${step}`);
    }
    const unprotected = [];
    for (const m of closure.members) {
      const st = lstatOrNull(m.abs);
      if (!st || !st.isFile() || !within(primaryReal, m.abs) || !resolvesInside(primaryReal, m.abs) || !repoProtects(policy, m.rel)) unprotected.push(m.rel);
    }
    if (unprotected.length) {
      throw new BrokerRefusal("closure-unprotected", `${writer.id}'s execution closure reaches code the sandbox can rewrite: ${unprotected.join(", ")}`);
    }

    const licensed = [];
    for (const pid of writer.paths) {
      const row = rowsById.get(pid);
      const root = rowRoot(roots, row);
      if (!root) continue; // its anchor is absent on this machine: nothing to write
      const base = row.path === "**" ? root : row.path.endsWith("/**") ? path.join(root, row.path.slice(0, -3)) : path.join(root, row.path);
      if (!resolvesInside(root, base)) throw new BrokerRefusal("symlink-escape", `protected path ${pid} (${row.path}) resolves outside its ${row.anchor} anchor`);
      const inside = new Map();
      digestRow(root, row, inside);
      const out = [...inside].filter(([, d]) => d.endsWith(":ESCAPES")).map(([p]) => p);
      if (out.length) throw new BrokerRefusal("symlink-escape", `protected path ${pid} holds a symlink out of its anchor: ${out.join(", ")}`);
      licensed.push({ base, tree: row.path === "**" || row.path.endsWith("/**") });
    }
    return { writer, entryAbs: entryReal, licensed, closure };
  }

  const isLicensed = (licensed, abs) => licensed.some((l) => abs === l.base || (l.tree && abs.startsWith(l.base + path.sep)));

  /** Handle one request. Never throws: a refusal is a result. */
  function handle(request) {
    let ad;
    try {
      ad = admit(request);
    } catch (e) {
      if (e instanceof BrokerRefusal) return { ok: false, refused: true, code: e.code, detail: e.detail };
      return { ok: false, refused: true, code: "admit-failed", detail: String((e && e.message) || e).slice(0, 300) };
    }
    const before = snapshot();
    const env = {};
    for (const n of envAllow) if (process.env[n] !== undefined) env[n] = process.env[n];
    env.COC_GUARD_BROKER = "1";
    const r = spawnSync(process.execPath, [ad.entryAbs, ...request.args], {
      cwd: repoReal,
      env,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const after = snapshot();
    const changed = [];
    for (const p of new Set([...before.keys(), ...after.keys()])) if (before.get(p) !== after.get(p)) changed.push(p);
    const outside = changed.filter((p) => !isLicensed(ad.licensed, p));
    const escapes = [...after].filter(([, d]) => d.endsWith(":ESCAPES")).map(([p]) => p);
    const tail = (s) => (s || "").slice(-OUTPUT_TAIL);
    return {
      ok: r.status === 0 && outside.length === 0 && escapes.length === 0,
      refused: false,
      writer: ad.writer.id,
      rc: r.status,
      signal: r.signal || null,
      error: r.error ? String(r.error.code || r.error.message) : null,
      changed,
      outside_licence: outside,
      escapes,
      stdout: tail(r.stdout),
      stderr: tail(r.stderr),
    };
  }

  return { handle, admit, snapshot, policy, repo: repoReal, primary: primaryReal };
}
