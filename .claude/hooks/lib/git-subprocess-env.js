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
    for (const k of ["COMSPEC", "PATHEXT", "TEMP", "TMP"]) {
      if (typeof process.env[k] === "string") env[k] = process.env[k];
    }
  }
  return env;
}

module.exports = {
  resolveGitBinary,
  resetGitBinaryCache,
  gitEnv,
  // Test-only — NOT part of the supported API.
  _test_setCandidates,
  _test_isExecutableFile: isExecutableFile,
  _test_resolveViaPath: _resolveViaPath,
  _test_GIT_CANDIDATES: GIT_CANDIDATES,
};
