// Guard foundation — Claude Code adapter.
//
// Renders the `sandbox` block of .claude/settings.json from the CLI-neutral policy
// (policy/protected-paths.json). The CC sandbox is ONE adapter beside the OS
// launcher profiles; it is never the dependency. Key names verified against
// code.claude.com/docs/en/settings-reference (sandbox.*) and /sandboxing.
//
// What CC cannot express is returned in `gaps`, never dropped:
//   - config_dir rows: a project settings file cannot name $CLAUDE_CONFIG_DIR
//     (CC's built-in protected paths cover it; a launcher profile renders it);
//   - raw ssh: the CC sandbox reaches the network only through its HTTP/SOCKS
//     proxy, so an ssh host (git over ssh, trestle placement) has no key;
//   - config_dir rows on the file-tool lane: an Edit() rule for them needs the
//     operator's absolute config dir, so it is rendered per operator.
//
// permissions.deny is rendered too: the consumer floor (CANONICAL_STATE_DENY,
// unchanged, owner-gated for Gate-2 delivery) plus loom-local Edit() denies for
// every repo/home protected row (ROOT ruling, 2026-10-14).
//   - the repo's checkouts and the per-user temp tree: machine facts, rendered per
//     operator, never into the checked-in file.
//
// EVERY CHECKOUT IS PROTECTED, NOT ONLY THE ONE THE SESSION RUNS IN (round-1 H4).
// `--worktrees` names CHECKOUTS (the primary and every linked worktree, read from
// `git worktree list`), never a directory holding them: each checkout is made
// writable AND carries its own protected set in denyWrite and Edit(), so a session
// in one lane cannot rewrite another checkout's hooks, settings or state. A blanket
// allowWrite of the directory holding the lanes would have reopened all of them.
//
// CLI:  node cc.mjs render [--worktrees auto|<checkout>] [--tmp auto|<dir>]... [--broker-socket auto|<path>]  -> JSON
//       node cc.mjs check  [--settings <file>] [same params]               -> exit 1 on drift

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadPolicy } from "../policy/policy.mjs";
import { resolveGitDirs } from "../os-profile/linux.mjs";
import { isMainModule } from "../../../../bin/lib/entry-point.mjs";
import { CANONICAL_STATE_DENY } from "../../../../bin/reconcile-settings-deny.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..", "..", "..");
const { resolveGitBinary, gitEnv } = createRequire(import.meta.url)("../../git-subprocess-env.js");
const { readRegularFileBounded } = createRequire(import.meta.url)("../../landing-window-read.js");

// git's PER-WORKTREE files among the policy's `.git/` rows. Every other `.git/` row
// (hooks, config) lives in the COMMON git dir, shared by every checkout.
const PER_WORKTREE_GIT = Object.freeze(["config.worktree"]);

// The checked-in settings.json is rendered with NO machine parameters: a tracked
// file must name no operator path. The worktree root and the per-user temp tree
// are machine facts, so they are rendered per operator (csq's per-terminal
// settings, via `render --worktrees auto --tmp auto`) and are declared gaps here.
export const CHECKED_IN_PARAMS = Object.freeze({ worktrees: [], tmp: [] });

// Every CHECKOUT of this repo — the primary and each linked worktree — read from
// git, never assumed, realpath'd (the sandbox matches resolved paths). A registered
// checkout that is gone from disk is skipped: it is not writable, so nothing to fence.
export function deriveCheckouts(repoDir = REPO) {
  const out = execFileSync(resolveGitBinary(), ["-C", repoDir, "worktree", "list", "--porcelain"], { encoding: "utf8", env: gitEnv() });
  const trees = out.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
  return [...new Set(trees.filter((t) => fs.existsSync(t)).map((t) => fs.realpathSync(t)))].sort();
}

// The git dirs of each checkout passed as `--worktrees`, so `.git/` rows bind where git
// READS them (H-5, linked worktrees). A linked checkout's `.git` is a pointer FILE: the
// literal `<checkout>/.git/config.worktree` names nothing, and its real per-worktree
// config is `<common>/worktrees/<name>/config.worktree`.
//
// Resolved with the SAME resolver the Seatbelt launcher uses
// (os-profile/linux.mjs::resolveGitDirs, which realpaths both dirs), and every result is
// held to the REPOSITORY's common dir, itself resolved from `repoDir`. The per-worktree
// dir is accepted only when it is a direct child of `<common>/worktrees/` AND the common
// dir's own record of it (its `gitdir` file) points back at this checkout. Anything else
// throws: a render that protects fewer checkouts than were named, or a git dir the
// checkout's pointer was re-aimed at, is refused rather than emitted.
export function resolveCheckoutGitDirs(checkouts, repoDir = REPO) {
  const repoDirs = resolveGitDirs(fs.realpathSync(repoDir));
  if (!repoDirs) throw new Error(`renderCC: ${repoDir} is not a git checkout`);
  const common = repoDirs.commonDir;
  const linkedParent = path.join(common, "worktrees");
  return checkouts.map((dir) => {
    let root;
    try {
      root = fs.realpathSync(dir);
    } catch (e) {
      throw new Error(`renderCC: checkout ${dir} does not resolve: ${e.code || e.message}`);
    }
    const d = resolveGitDirs(root);
    if (!d) throw new Error(`renderCC: ${dir} is not a checkout (no .git)`);
    if (d.commonDir !== common) {
      throw new Error(`renderCC: checkout ${dir} belongs to another repository (common dir ${d.commonDir}, expected ${common})`);
    }
    const linked = d.gitDir !== d.commonDir;
    if (linked) {
      if (path.dirname(d.gitDir) !== linkedParent) {
        throw new Error(`renderCC: checkout ${dir} points at ${d.gitDir}, outside ${linkedParent}`);
      }
      const back = readRegularFileBounded(path.join(d.gitDir, "gitdir"));
      if (!back.ok) throw new Error(`renderCC: ${path.join(d.gitDir, "gitdir")} could not be read: ${back.reason}`);
      let backRoot = null;
      try {
        backRoot = fs.realpathSync(path.dirname(path.resolve(d.gitDir, back.text.trim())));
      } catch {
        backRoot = null;
      }
      if (backRoot !== root) {
        throw new Error(`renderCC: ${d.gitDir} is recorded for ${backRoot || "a missing checkout"}, not ${root}`);
      }
    }
    return { root, gitDir: d.gitDir, commonDir: common, linked };
  });
}

// THIS user's temp root only. On macOS BSD `mktemp -d` writes under the
// per-user DARWIN_USER_TEMP_DIR whatever TMPDIR says (measured under the CC
// sandbox: "mkdtemp failed on /var/folders/…/T/…: Operation not permitted").
export function deriveUserTmp() {
  if (process.platform === "darwin") {
    return [fs.realpathSync(execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim())];
  }
  return [fs.realpathSync(os.tmpdir())];
}

function dirOf(glob) {
  return glob.replace(/\/\*\*$/, "");
}

function hostOnly(h) {
  return h.replace(/:[0-9]+$/, "");
}

export function renderCC(policy, params = CHECKED_IN_PARAMS) {
  const gaps = [];
  const denyWrite = [];
  const loomLocalEditDeny = [];
  const floor = new Set(CANONICAL_STATE_DENY);
  for (const r of policy.protected_write) {
    if (r.anchor === "repo") {
      denyWrite.push(`./${dirOf(r.path)}`);
      // `/path` anchors at the project root, so a lane worktree (a sibling, not
      // under the root) and nested fixture trees keep their file-tool writes.
      if (!floor.has(`Edit(${r.path})`)) loomLocalEditDeny.push(`Edit(/${r.path})`);
    } else if (r.anchor === "home") {
      denyWrite.push(`~/${dirOf(r.path)}`);
      loomLocalEditDeny.push(`Edit(~/${r.path})`);
    } else {
      gaps.push({ id: r.id, gap: `anchor ${r.anchor} is not expressible in a project settings file` });
    }
  }

  const allowWrite = [];
  const fenced = new Set();
  const fence = (abs) => {
    if (fenced.has(abs)) return;
    fenced.add(abs);
    denyWrite.push(dirOf(abs));
    loomLocalEditDeny.push(`Edit(/${abs})`); // "//abs" = an absolute path
  };
  for (const w of policy.writable) {
    if (w.anchor === "worktrees" || w.anchor === "tmp") {
      const given = params[w.anchor] || [];
      if (given.length === 0) {
        gaps.push({ id: w.id, gap: `${w.anchor} root is a machine fact: render it per operator (--${w.anchor} auto)` });
        if (w.anchor === "worktrees") {
          // The checked-in `./.git/config.worktree` binds only where `.git` is a directory.
          gaps.push({
            id: "linked-worktree-git-dirs",
            gap: "a linked checkout's .git is a pointer file; its per-worktree config is <common>/worktrees/<name>/config.worktree, a machine path: render it per operator (--worktrees auto)",
          });
        }
      }
      for (const dir of given) {
        if (!path.isAbsolute(dir)) throw new Error(`renderCC: ${w.anchor} root must be absolute: ${dir}`);
      }
      if (w.anchor === "tmp") {
        allowWrite.push(...given);
        continue;
      }
      // A checkout is writable only together with its OWN protected set (H4), and its
      // `.git/` rows bind in the git dir git actually reads (H-5).
      for (const c of resolveCheckoutGitDirs(given, params.repo || REPO)) {
        allowWrite.push(c.root);
        for (const r of policy.protected_write) {
          if (r.anchor !== "repo") continue;
          const git = /^\.git(\/|$)/.test(r.path) ? r.path.replace(/^\.git\/?/, "") : null;
          if (git === "") throw new Error(`renderCC: '${r.id}' protects the whole git dir; commits must keep working`);
          if (git === null) fence(`${c.root}/${r.path}`);
          else if (PER_WORKTREE_GIT.includes(git)) fence(`${c.gitDir}/${git}`);
          else fence(`${c.commonDir}/${git}`);
        }
        // Rewriting a linked checkout's pointer re-aims it at a git dir of the writer's
        // choosing (parity: os-profile/seatbelt.mjs, "gitdir pointer of a linked checkout").
        if (c.linked) fence(`${c.root}/.git`);
      }
    }
    // repo is CC's working directory (writable by default); home caches and
    // config_dir memory are written by file tools or stay launcher-scoped.
  }

  const domains = [];
  for (const n of policy.network) {
    if (n.hosts === "any") {
      gaps.push({ purpose: n.purpose, gap: "an unbounded host set cannot be allow-listed in the CC proxy" });
      continue;
    }
    for (const h of n.hosts) {
      if (/:22$/.test(h)) {
        gaps.push({ purpose: n.purpose, host: h, gap: "raw ssh does not traverse the CC sandbox proxy" });
      } else if (!domains.includes(hostOnly(h))) {
        domains.push(hostOnly(h));
      }
    }
  }

  const sandbox = {
    enabled: true,
    failIfUnavailable: true,
    // gh and other Go CLIs verify TLS through com.apple.trustd.agent (measured:
    // "x509: OSStatus -26276" without it). Excluding gh instead would run it
    // unsandboxed, and gh can write files.
    enableWeakerNetworkIsolation: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: domains },
    filesystem: { allowWrite: [...new Set(allowWrite)], denyWrite },
  };
  // The S4 broker is reached over a unix socket, which the macOS CC sandbox blocks
  // unless listed. Its path hashes the checkout's realpath, so it is per operator.
  const sockets = params.brokerSocket || [];
  if (sockets.length === 0) {
    gaps.push({ id: "broker-socket", gap: "the broker socket path is per checkout: render it per operator (--broker-socket auto)" });
  } else {
    for (const s of sockets) if (!path.isAbsolute(s)) throw new Error(`renderCC: broker socket must be absolute: ${s}`);
    sandbox.network.allowUnixSockets = [...sockets];
  }
  // permissions.deny = the CONSUMER floor (CANONICAL_STATE_DENY, which Gate-2
  // delivers and which stays owner-gated) followed by the LOOM-LOCAL file-tool
  // denies. CC's file tools run outside every sandbox, so these rules are the
  // only file-tool fence for the protected set once the old edit guard retires.
  const permissionsDeny = [...CANONICAL_STATE_DENY, ...loomLocalEditDeny];
  return { sandbox, permissionsDeny, loomLocalEditDeny, gaps, policySha256: policy.integrity.sha256 };
}

// `--worktrees auto` / `--tmp auto` / `--broker-socket auto` derive the machine
// fact; a literal adds one. With no flag the render is the checked-in one: no
// machine paths.
async function parseArgs(argv) {
  const out = { worktrees: [], tmp: [], brokerSocket: [], settings: path.join(REPO, ".claude", "settings.json") };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--worktrees" || flag === "--tmp") {
      const v = argv[++i];
      const key = flag.slice(2);
      if (v === "auto") out[key].push(...(key === "worktrees" ? deriveCheckouts() : deriveUserTmp()));
      else out[key].push(v);
    } else if (flag === "--broker-socket") {
      const v = argv[++i];
      if (v === "auto") {
        const { defaultSocketPath } = await import("../broker/server.mjs");
        out.brokerSocket.push(defaultSocketPath(REPO));
      } else out.brokerSocket.push(v);
    } else if (flag === "--settings") out.settings = argv[++i];
    else throw new Error(`unknown argument ${flag}`);
  }
  return out;
}

if (isMainModule(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = await parseArgs(rest);
  const rendered = renderCC(loadPolicy(), args);
  if (cmd === "render") {
    process.stdout.write(`${JSON.stringify(rendered, null, 2)}\n`);
  } else if (cmd === "check") {
    const settings = JSON.parse(fs.readFileSync(args.settings, "utf8"));
    const live = { sandbox: settings.sandbox, deny: settings.permissions?.deny };
    const want = { sandbox: rendered.sandbox, deny: rendered.permissionsDeny };
    const same = JSON.stringify(live) === JSON.stringify(want);
    process.stdout.write(same ? "IN SYNC\n" : `DRIFT\n  settings: ${JSON.stringify(live)}\n  rendered: ${JSON.stringify(want)}\n`);
    process.exit(same ? 0 : 1);
  } else {
    process.stderr.write("usage: cc.mjs render|check [--worktrees auto|<checkout>] [--tmp auto|<dir>]... [--broker-socket auto|<path>] [--settings <file>]\n");
    process.exit(2);
  }
}
