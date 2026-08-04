/**
 * git-subprocess-env — THE shared allowlist for every `git` a guard spawns (loom#1462).
 *
 * THE DEFECT THIS EXISTS FOR. A guard that shells out to `git` and passes no `env:`
 * option hands the child the AMBIENT environment. `GIT_DIR` outranks repository
 * DISCOVERY, and neither `-C <path>` nor `cwd:` pins which repository git resolves —
 * both only choose a DIRECTORY. So one ambient variable re-points the subprocess at an
 * attacker-controlled repository, and whatever the guard asked git is answered by that
 * repository instead. Measured at both call sites, not derived:
 *
 *   $ git -C victim show HEAD:.claude/bin/ecosystem.json
 *     {"schema_version":1,"coordination":{"enabled":true}}       # victim's own HEAD
 *   $ GIT_DIR=evil/.git git -C victim show HEAD:...
 *     {"schema_version":1,"coordination":{"enabled":false}}      # the ATTACKER's HEAD
 *
 *   $ (cd victim && git rev-parse --show-toplevel --git-common-dir)
 *     <...>/victim                                               # victim
 *     .git
 *   $ (cd victim && GIT_DIR=evil/.git GIT_WORK_TREE=evil git rev-parse --show-toplevel --git-common-dir)
 *     <...>/evil                                                 # the ATTACKER's tree
 *     <...>/evil/.git
 *
 * Delivery is the vehicle loom#1429 already documented: a `settings.local.json` `env`
 * block reaches every hook subprocess.
 *
 * WHY AN ALLOWLIST, NOT A DENYLIST ENTRY. Adding `GIT_DIR` to a dangerous-env denylist
 * treats the symptom. `LOOM_ECOSYSTEM_CONFIG` was ALREADY on that denylist — added for
 * #1429, with a comment naming this exact attack class — and the entire git family was
 * still missed. A denylist here is permanently one variable behind (`GIT_WORK_TREE`,
 * `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`,
 * `GIT_CONFIG_*`, `GIT_INDEX_FILE`, `GIT_CEILING_DIRECTORIES`, …). The child therefore
 * gets an EXPLICIT MINIMAL env built HERE from constants (`rules/cc-artifacts.md`
 * Rule 10's positive-allowlist preference): NOTHING is inherited, so the class is closed
 * by construction rather than enumerated.
 *
 * WHY THIS IS ONE MODULE AND NOT TWO COPIES. `rules/security.md` § Enforcement-Surface
 * Parity — a new fail-closed dimension lands at EVERY surface, through ONE shared
 * function, so the surfaces cannot drift into disagreeing. Two copies of an env
 * allowlist is exactly the shape that leaves one of them a variable behind.
 *
 * The `GIT_*` entries below ARE set by us. That is not a contradiction of the allowlist:
 * we CHOOSE their values, to neutralise config an attacker might otherwise reach. They
 * are never pass-throughs. `HOME` is deliberately ABSENT, so no `~/.gitconfig` is read.
 *
 * WINDOWS RESIDUAL (recorded, not closed): `SystemRoot` is read from the ambient env
 * because git.exe needs it to load system DLLs, and `PATH` is DERIVED from it. An
 * attacker who can set `SystemRoot` could therefore influence the child's `PATH`. That
 * is strictly narrower than the inherited-env status quo, does not affect the
 * absolute-path invocation of git itself, and the read-only git queries these guards run
 * against a local repository spawn no PATH-resolved helper.
 *
 * Style: CommonJS, pure node:fs/os/path, no deps — matches the sibling lib/* guards.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Absolute paths git is plausibly installed at. Resolving an absolute path removes the
 * PATH lookup entirely and makes "which binary ran" an answerable question rather than
 * an inference. The list is deliberately conservative; an unresolved git is reported so
 * the CALLER can fail closed, never silently treated as a clean negative.
 */
const GIT_CANDIDATES =
  process.platform === "win32"
    ? [
        "C:\\Program Files\\Git\\cmd\\git.exe",
        "C:\\Program Files\\Git\\bin\\git.exe",
        "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
        "C:\\Program Files (x86)\\Git\\bin\\git.exe",
      ]
    : [
        "/usr/bin/git",
        "/bin/git",
        "/usr/local/bin/git",
        "/opt/homebrew/bin/git",
        "/opt/local/bin/git",
        "/usr/local/git/bin/git",
      ];

/** Absolute path, resolves (through symlinks) to a regular file, and is executable. */
function isExecutableFile(p) {
  try {
    if (typeof p !== "string" || !path.isAbsolute(p)) return false;
    // statSync FOLLOWS symlinks deliberately: /usr/bin/git is a symlink on many
    // distros, and the target is what actually executes.
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

let _gitBinCache; // undefined = unprobed; string = resolved; null = unavailable
let _candidates = GIT_CANDIDATES;

/**
 * First absolute git that exists, or null when none resolves.
 *
 * TWO STAGES, AND THE SECOND IS NOT OPTIONAL (loom#1462 H2-a / H5).
 *
 *   1. The fixed candidate list above — fully trusted, no lookup.
 *   2. A PATH SEARCH, when no candidate resolves.
 *
 * Stage 2 was missing in the first cut of this module and that was a real defect, not
 * a hardening choice. The candidate list CANNOT enumerate where git actually lives:
 * nix uses a content-addressed store (`/nix/store/<hash>-git-<ver>/bin/git`), asdf and
 * conda use per-user prefixes, Homebrew-on-Linux uses its own `linuxbrew` prefix, Scoop and
 * GitHub Desktop ship their own. On every such host stage 1 returns null for EVERY
 * query — which silently disabled the loom#1462 F2 fence (H2-a) and simultaneously
 * OVER-fenced guard-path-scope's family resolution (H5). Neither needed an attacker;
 * the host layout supplied the condition.
 *
 * THE TRADE-OFF, STATED PLAINLY. Stage 2 consults `PATH`, so an attacker who controls
 * `PATH` can point discovery at a planted binary. That is a real weakening of stage 1
 * — and it is still strictly better than omitting stage 2, because WITHOUT it those
 * hosts get a GUARANTEED fence-off with NO attacker at all. A conditional weakness
 * beats an unconditional hole. `PATH` is additionally denylisted at the settings layer
 * (`settings-deny-guard-shape.js::DANGEROUS_ENV_EXACT`), which is defence in depth and
 * NOT the load-bearing part of this argument.
 *
 * Note the asymmetry that keeps stage 2 honest: PATH influences only WHICH BINARY is
 * discovered. The env handed to that binary is still built by `gitEnv()` from
 * constants, so the repository-steering class F1 closed stays closed either way.
 *
 * NULL IS A REAL ANSWER, NOT AN ERROR TO SWALLOW. This MUST NOT throw into a guard
 * (`zero-tolerance.md` Rule 3) — but a caller MUST NOT read null as "no finding"
 * either. Every caller ranks it TIGHTEST per `rules/security.md` § Enforcement-Surface
 * Parity: git that cannot answer is INDETERMINATE, never a clean negative.
 *
 * `opts.gitBin` / `opts.gitCandidates` / `opts.gitPath` are injection seams for tests
 * (tier-1-class: reachable only by code already executing inside the guard process,
 * never from the environment or a config).
 */
function resolveGitBinary(opts) {
  if (opts && typeof opts.gitBin === "string" && opts.gitBin) {
    return isExecutableFile(opts.gitBin) ? opts.gitBin : null;
  }
  const cands = opts && Array.isArray(opts.gitCandidates) ? opts.gitCandidates : _candidates;
  const pathVal =
    opts && typeof opts.gitPath === "string" ? opts.gitPath : process.env.PATH;
  const injected = Boolean(opts && (opts.gitCandidates || typeof opts.gitPath === "string"));
  if (!injected && _gitBinCache !== undefined) return _gitBinCache;

  let found = null;
  for (const cand of cands) {
    if (isExecutableFile(cand)) {
      found = cand;
      break;
    }
  }
  if (!found) found = _resolveViaPath(pathVal);
  if (!injected) _gitBinCache = found;
  return found;
}

/** Stage 2: first `git` on PATH that is an absolute, executable regular file. */
function _resolveViaPath(pathVal) {
  if (typeof pathVal !== "string" || pathVal === "") return null;
  const exeNames = process.platform === "win32" ? ["git.exe", "git.cmd"] : ["git"];
  for (const dir of pathVal.split(path.delimiter)) {
    // Only ABSOLUTE entries. A relative (or empty) PATH entry resolves against the
    // hook's cwd, which is attacker-influencable in a way an absolute entry is not.
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const exe of exeNames) {
      const cand = path.join(dir, exe);
      if (isExecutableFile(cand)) return cand;
    }
  }
  return null;
}

/** Test/CLI hook — re-probe the candidates (a fixture may have moved git). */
function resetGitBinaryCache() {
  _gitBinCache = undefined;
}

/** Test-only seam: replace the candidate list, e.g. to force the PATH fallback. */
function _test_setCandidates(list) {
  _candidates = Array.isArray(list) ? list : GIT_CANDIDATES;
  _gitBinCache = undefined;
}

/**
 * The explicit minimal environment handed to every guard-spawned git.
 *
 * Every entry is a constant chosen here. Nothing is inherited except the Windows
 * host variables noted in the header, which cannot redirect repository resolution.
 */
function gitEnv() {
  const env = {
    PATH: "/usr/bin:/bin",
    // OURS, not inherited — these neutralise config an attacker might otherwise reach.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    LC_ALL: "C",
  };
  if (process.platform === "win32") {
    const amb = process.env.SystemRoot || process.env.SYSTEMROOT;
    const sysRoot = typeof amb === "string" && path.isAbsolute(amb) ? amb : "C:\\Windows";
    env.SystemRoot = sysRoot;
    env.PATH = `${sysRoot}\\System32;${sysRoot}`;
    // COMSPEC and PATHEXT are DERIVED, not forwarded (loom#1471). This branch
    // validated SystemRoot for absoluteness and then passed both of these
    // through verbatim — but COMSPEC names the command INTERPRETER and PATHEXT
    // decides which extensions are executable at all, so both are commands in
    // the sense this module's own § network-profile header draws the line:
    // DATA MAY PASS, COMMANDS MAY NOT. A forwarded COMSPEC pointed at an
    // attacker binary is the win32 twin of the PATH defect the whole module
    // exists to close, and a PATHEXT naming an attacker-registered extension
    // changes what a bare name resolves to. Both now come from the same
    // constants as PATH, anchored on the already-validated sysRoot.
    env.COMSPEC = `${sysRoot}\\System32\\cmd.exe`;
    env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
    // TEMP/TMP are genuinely DATA — a scratch directory git writes into — so
    // they pass, but only as an absolute path, so neither can smuggle a
    // relative or empty value that lands writes somewhere unintended.
    for (const k of ["TEMP", "TMP"]) {
      const v = process.env[k];
      if (typeof v === "string" && path.isAbsolute(v)) env[k] = v;
    }
  }
  return env;
}

/* ────────────────────────── the NETWORK profile (loom#1471 shard 3) ─────────
 *
 * WHY A SECOND PROFILE EXISTS AT ALL. `gitEnv()` above is built for a LOCAL,
 * read-only query against a repository already on disk, and it is correct to
 * inherit nothing there. `lib/template-resolver.js` is different in kind: it
 * runs `fetch` and `clone` against a REMOTE, so it needs the host's egress
 * configuration — proxy, TLS trust anchors, SSH-agent handle — or it simply
 * cannot reach the network on a corporate host. Handing it `gitEnv()` would not
 * harden it, it would BREAK it, and the failure is silent in the worst way:
 * `resolveTemplate` falls through to the offline sibling, so a stale template
 * quietly becomes authoritative.
 *
 * WHAT THIS IS NOT. It is NOT "gitEnv() minus the strictness". `gitNetEnv()`
 * CALLS `gitEnv()` and adds to it, so the repo-redirect family (`GIT_DIR`,
 * `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`,
 * `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`, `GIT_COMMON_DIR`,
 * `GIT_CONFIG_*`, …) stays denied BY CONSTRUCTION rather than by a second
 * enumeration that could drift from the first — `rules/security.md`
 * § Enforcement-Surface Parity, one shared function, in its literal form.
 *
 * THE LINE THIS DRAWS: DATA MAY PASS, COMMANDS MAY NOT. Every variable added
 * below is data git CONNECTS TO or VERIFIES AGAINST. The variables git EXECUTES
 * are permanently excluded — `GIT_SSH_COMMAND`, `GIT_SSH`, `GIT_ASKPASS`,
 * `SSH_ASKPASS`, `GIT_PROXY_COMMAND`, `GIT_EXTERNAL_DIFF`, `GIT_EDITOR`,
 * `GIT_SEQUENCE_EDITOR`. That is not a stylistic preference. Measured on this
 * host, not derived:
 *
 *   $ env -i PATH=/usr/bin:/bin HOME=/nonexistent \
 *       GIT_SSH_COMMAND='sh -c "id > PWNED.txt"; false' git clone git@github.com:…
 *     uid=501(esperie) gid=20(staff) …          # PWNED.txt — arbitrary execution
 *
 * A "net profile" that passed those through would trade a repository-redirect
 * for remote code execution. That is a strictly worse position than the
 * inherit-everything status quo it claims to fix.
 *
 * WHY `HOME` IS ABSENT, WHICH IS THE NON-OBVIOUS PART. The intuitive design
 * passes `HOME` so ssh can find `~/.ssh/` and git can find credential helpers.
 * Both halves of that intuition are wrong here, and both were measured:
 *
 *   1. `HOME` is an EXECUTION vector. With `HOME` pointed at a directory holding
 *      a planted `.gitconfig` carrying `core.sshCommand`, the command ran
 *      (uid=501). Retaining `GIT_CONFIG_GLOBAL=/dev/null` — which `gitEnv()`
 *      does — closes that specific path, but the variable still buys an
 *      attacker a foothold that has to be argued away rather than not existing.
 *   2. `HOME` is NOT NEEDED for ssh. OpenSSH resolves `~/.ssh` from the passwd
 *      database (`getpwuid()` in `ssh.c`), not from `$HOME`. Measured: under a
 *      redirected `HOME`, `ssh -v` still read `/etc/ssh/ssh_config` and
 *      `identity file /Users/esperie/.ssh/id_rsa` — the REAL user's key — and
 *      the clone authenticated and exited 0. A planted `$HOME/.ssh/config` was
 *      never read at all (`ssh -G` showed neither its `ProxyCommand` nor its
 *      `StrictHostKeyChecking no`).
 *
 * So `HOME` costs a vector and buys nothing: SSH auth keeps working without it.
 * It is excluded. (Note the corollary, recorded not closed: because ssh reads
 * the REAL `~/.ssh/config` regardless, an operator's own legitimate
 * `ProxyCommand` there is always in play. That is the operator's file, not an
 * attacker-controlled environment channel, and no value of these variables can
 * change it.)
 *
 * RESIDUAL, STATED PLAINLY. An attacker who can already set environment
 * variables can, through the proxy and CA entries below, attempt to MITM the
 * template clone. That is real and it is NOT closed here. It is nonetheless
 * strictly narrower than the status quo this replaces, which additionally hands
 * that same attacker `GIT_SSH_COMMAND` (measured above) and the whole
 * repo-redirect family. Narrowing a hole is progress; pretending it is shut is
 * not, so it is written down instead.
 */

/**
 * Proxy values are URLs git CONNECTS to. Anything not a plain proxy URL is dropped.
 *
 * TWO accepted shapes, because git honours two. git delegates http(s) transport
 * to libcurl, which accepts a SCHEME-LESS `host:port` and defaults it to
 * `http://`. A scheme-REQUIRED allowlist therefore drops proxies git would use:
 * `new URL("proxy.corp:8080")` parses `proxy.corp:` AS the protocol, and
 * `new URL("192.168.1.5:3128")` throws outright. Dropping those is not
 * fail-closed, it is fail-BROKEN — the clone silently bypasses the operator's
 * mandated egress proxy, or fails with nothing pointing at the cause.
 *
 * The scheme-less form is matched by a STRICT positive pattern rather than by
 * prefixing `http://` and re-parsing. Prefix-and-retry would admit whatever URL
 * parsing happens to tolerate; the pattern admits only what it names. A value
 * that DOES carry a scheme still must carry an ALLOWED one, so `file:` and
 * `javascript:` stay rejected on the branch they arrive by.
 *
 * A port is REQUIRED on the scheme-less branch. curl would also accept a bare
 * hostname (defaulting the port), but admitting that would make every bare token
 * — `not-a-url` included — a valid proxy, which is a real widening of a
 * security fence for a form almost nobody configures. Requiring the port admits
 * exactly the documented gap and nothing adjacent to it.
 */
const PROXY_SCHEMES = new Set(["http:", "https:", "socks5:", "socks5h:", "socks4:", "socks:"]);

/** `user:pass@` — optional, and deliberately excludes `/`, `[`, `]`, and whitespace. */
const _PROXY_USERINFO = "(?:[^\\s:@/\\[\\]]+(?::[^\\s@/\\[\\]]*)?@)?";
/** A bracketed IPv6 literal, or a dotted hostname/IPv4. No path, no query, no space. */
const _PROXY_HOST =
  "(?:\\[[0-9A-Fa-f:.]+\\]|[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*)";
const _SCHEMELESS_PROXY = new RegExp(`^${_PROXY_USERINFO}${_PROXY_HOST}:(\\d{1,5})$`);

function _validProxyUrl(v) {
  if (typeof v !== "string" || v === "" || v.length > 2048) return false;
  // Reject control characters outright: they are how a value smuggles a second
  // header/line into whatever consumes it.
  if (/[\x00-\x1f\x7f]/.test(v)) return false;
  // Carries a scheme: it must be an allowed one. Checked FIRST so a disallowed
  // scheme can never fall through to the scheme-less branch and be re-read there.
  if (v.includes("://")) {
    try {
      return PROXY_SCHEMES.has(new URL(v).protocol);
    } catch {
      return false;
    }
  }
  const m = _SCHEMELESS_PROXY.exec(v);
  if (!m) return false;
  const port = Number(m[1]);
  return port >= 1 && port <= 65535;
}

/** `no_proxy` is a comma-separated host/domain/CIDR list — data, but keep it boring. */
function _validNoProxy(v) {
  return typeof v === "string" && v !== "" && v.length <= 2048 && /^[A-Za-z0-9.,:*\-_/[\]\s]+$/.test(v);
}

/** An absolute path that exists and is of the required kind. Never a command. */
function _validPathOfKind(v, kind) {
  if (typeof v !== "string" || v === "" || !path.isAbsolute(v)) return false;
  try {
    const st = fs.statSync(v); // follows symlinks: the target is what git opens
    return kind === "file" ? st.isFile() : kind === "dir" ? st.isDirectory() : st.isSocket();
  } catch {
    return false;
  }
}

/**
 * The transport allowlist. Each entry names WHY it is necessary and WHAT
 * validator gates it. A variable absent from this table is never forwarded,
 * whatever its value.
 */
const NET_PASSTHROUGH = [
  // Egress routing. Without these a corporate host cannot reach the remote at
  // all, and the resolver degrades silently to a stale offline sibling.
  ["http_proxy", _validProxyUrl],
  ["https_proxy", _validProxyUrl],
  ["HTTP_PROXY", _validProxyUrl],
  ["HTTPS_PROXY", _validProxyUrl],
  ["ALL_PROXY", _validProxyUrl],
  ["all_proxy", _validProxyUrl],
  // The complement: without it an INTERNAL template host is forced out through
  // an external proxy and fails.
  ["no_proxy", _validNoProxy],
  ["NO_PROXY", _validNoProxy],
  // TLS trust anchors. A host behind TLS interception has a private root; with
  // no bundle every HTTPS clone fails certificate verification.
  ["GIT_SSL_CAINFO", (v) => _validPathOfKind(v, "file")],
  ["SSL_CERT_FILE", (v) => _validPathOfKind(v, "file")],
  ["CURL_CA_BUNDLE", (v) => _validPathOfKind(v, "file")],
  ["GIT_SSL_CAPATH", (v) => _validPathOfKind(v, "dir")],
  ["SSL_CERT_DIR", (v) => _validPathOfKind(v, "dir")],
  // SSH-agent auth for a private template repo. This is a capability HANDLE,
  // not a command: the agent is a signing oracle and executes nothing the
  // client supplies. Gated on actually being a socket, so pointing it at a
  // regular file or directory is dropped rather than handed to ssh.
  ["SSH_AUTH_SOCK", (v) => _validPathOfKind(v, "sock")],
];

/**
 * Environment for a git subprocess that must reach the NETWORK.
 *
 * Use ONLY for invocations that genuinely talk to a remote (`fetch`, `clone`,
 * `ls-remote`, `push`). Anything local — including a `reset --hard` on an
 * already-fetched cache — MUST stay on `gitEnv()`, least privilege.
 */
function gitNetEnv() {
  const env = gitEnv(); // base allowlist first: every denial above is inherited
  for (const [name, isValid] of NET_PASSTHROUGH) {
    const v = process.env[name];
    if (typeof v === "string" && isValid(v)) env[name] = v;
  }
  // Non-negotiable even here: a hook has no terminal, so an auth prompt would
  // hang the guard rather than fail it. `gitEnv()` already sets this; it is
  // restated because the net profile is exactly where something would be
  // tempted to relax it.
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

module.exports = {
  resolveGitBinary,
  resetGitBinaryCache,
  gitEnv,
  gitNetEnv,
  // Test-only — NOT part of the supported API.
  _test_setCandidates,
  _test_isExecutableFile: isExecutableFile,
  _test_resolveViaPath: _resolveViaPath,
  _test_GIT_CANDIDATES: GIT_CANDIDATES,
  _test_NET_PASSTHROUGH_NAMES: NET_PASSTHROUGH.map(([n]) => n),
};
