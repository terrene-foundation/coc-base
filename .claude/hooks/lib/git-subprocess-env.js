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
 * NULLING CONFIG HAS A SECOND EDGE, closed since loom#1915: with `user.*` unreadable,
 * git does not refuse to commit — it INVENTS an author from passwd + hostname and skips
 * signing, at exit 0. `gitEnv()` therefore also pins `user.useConfigOnly=true` so git
 * REFUSES instead of guessing. It does NOT forbid committing: a caller that DECLARES an
 * identity still commits. See § IDENTITY on `gitEnv()` for the measurement and for why
 * a blanket commit-refusal was rejected.
 *
 * WINDOWS RESIDUAL (recorded, not closed): `SystemRoot` is read from the AMBIENT env
 * because git.exe needs it to load system DLLs, and THREE values are DERIVED from it —
 * the `SystemRoot` handed to the child, `PATH`, and (since loom#1471) `COMSPEC`. An
 * earlier version of this note recorded only `PATH`, and was therefore out of date the
 * moment COMSPEC joined the derivation; `PATHEXT` is a literal constant and is NOT
 * derived. An attacker who can set `SystemRoot` influences all three.
 *
 * The ambient value is SHAPE-VALIDATED, not merely absoluteness-checked — see
 * `_normalizeSystemRoot` (this file, `:234-242`): drive-rooted, exactly one path
 * segment, no UNC, no traversal, no `%VAR%`. That is a real check, unlike the
 * `path.isAbsolute` it replaced, which admitted `C:\attacker\stage` and the UNC
 * `\\evil\share` alike (measured — see that function's comment). WHAT SURVIVES: an
 * attacker who can set `SystemRoot` AND create `X:\<one-segment>\System32\cmd.exe` still
 * chooses the child's `COMSPEC` and `PATH`. That is narrower than the inherited-env
 * status quo and narrower than the isAbsolute check, it does not affect the
 * absolute-path invocation of git itself, and the read-only git queries these guards run
 * against a local repository spawn no PATH-resolved helper and no shell. Narrowing a
 * hole is progress; pretending it is shut is not, so it is written down instead.
 *
 * SIBLING WIN32 ENV BUILDERS, recorded so the parity gap is not re-discovered rather
 * than claimed closed here. `lib/template-resolver.js::_shimEnv` (`:357-373`) and
 * `validate-bash-command.js::nodeChildEnv` (`:88-104`) build their own win32 env for a
 * NODE child and still FORWARD ambient `COMSPEC`/`PATHEXT` VERBATIM — the shape
 * loom#1471 removed from this function. They are outside this module and are NOT fixed
 * by this file; `rules/security.md` § Multi-Site Kwarg Plumbing says they should be
 * swept, and this note exists so the next reader does not infer from `gitEnv()` alone
 * that the class is closed repo-wide. It is not.
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
 * WHAT STAGE 2 DOES AND DOES NOT PRESERVE, stated precisely because an earlier
 * revision of this comment over-claimed it. That revision read: "PATH influences only
 * WHICH BINARY is discovered. The env handed to that binary is still built by
 * `gitEnv()` from constants, so the repository-steering class F1 closed stays closed
 * either way." The first sentence is true; the conclusion does not follow from it, and
 * is WITHDRAWN.
 *
 * It holds for a GENUINE git: a real git binary obeys the constants-built env, so
 * `GIT_DIR` cannot be re-pointed and F1's class stays closed no matter which real git
 * was found. It does NOT hold for a PLANTED one. An attacker-supplied executable is
 * not steered BY the environment — it IGNORES the env entirely and returns whatever
 * answer it likes. Against that binary `gitEnv()` is not a weakened defence, it is an
 * irrelevant one, and the guard consuming the output cannot tell the difference.
 *
 * So the honest scope is: stage 2 preserves the env contract, and the env contract is
 * only worth what the binary's obedience is worth. The real bound on the exposure is
 * the one stated above — stage 2 is reached ONLY when every absolute candidate misses,
 * which on a mainstream host it never does — plus the `PATH` denylist at the settings
 * layer. Both are conditional, and neither is the load-bearing claim that a
 * constants-built env keeps the class closed against a binary that was never git.
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
  const cands =
    opts && Array.isArray(opts.gitCandidates)
      ? opts.gitCandidates
      : _candidates;
  const pathVal =
    opts && typeof opts.gitPath === "string" ? opts.gitPath : process.env.PATH;
  const injected = Boolean(
    opts && (opts.gitCandidates || typeof opts.gitPath === "string"),
  );
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
  const exeNames =
    process.platform === "win32" ? ["git.exe", "git.cmd"] : ["git"];
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
 * Is `v` plausibly a Windows SYSTEM ROOT — as opposed to merely an absolute path?
 *
 * `path.isAbsolute` is NOT that predicate and never was, which is the whole reason this
 * function exists. MEASURED on this host with win32 semantics
 * (`node -e 'require("path").win32.isAbsolute(v)'`), it returns TRUE for every one of
 * `C:\Windows`, `C:\Temp`, `C:\attacker\stage`, `D:\Windows\`, and the UNC
 * `\\evil\share`. So an absoluteness check admits essentially every value an attacker
 * who can set `SystemRoot` would pick — including a REMOTE UNC path — and the values
 * derived from it below therefore needed a real shape check instead.
 *
 * ACCEPTS: a drive letter, a separator, and EXACTLY ONE path segment — `C:\Windows`,
 * `D:\Windows`, `C:\WINNT` — with trailing separators tolerated. REJECTS, each of these
 * being a value the previous check accepted: a nested path (`C:\attacker\stage`), a UNC
 * or device path (`\\evil\share`, `\\?\C:\x`), forward slashes, an unexpanded `%VAR%`,
 * control and wildcard characters, and anything over 64 chars.
 *
 * Returns the NORMALIZED root (no trailing separator), or null when the value does not
 * qualify and the caller must fall back to the constant. Normalizing HERE rather than at
 * the call site is what stops `C:\Windows\` from composing into `C:\Windows\\System32`.
 *
 * This is a NARROWING, not a closure. An attacker who can both set `SystemRoot` and
 * create `X:\<one-segment>\System32\cmd.exe` still wins; the § WINDOWS RESIDUAL header
 * states that residual rather than this comment claiming it away.
 */
function _normalizeSystemRoot(v) {
  if (typeof v !== "string" || v === "" || v.length > 64) return null;
  if (v.includes("/") || v.includes("%")) return null;
  if (/[\x00-\x1f"<>|*?]/.test(v)) return null;
  // Drive-rooted, then EXACTLY ONE segment. The segment class excludes `\`, so a nested
  // path cannot match, and it must OPEN with an alphanumeric, so `..` cannot either.
  const m = /^([A-Za-z]):\\([A-Za-z0-9][A-Za-z0-9._-]*)\\*$/.exec(v);
  return m ? `${m[1]}:\\${m[2]}` : null;
}

/**
 * The explicit minimal environment handed to every guard-spawned git.
 *
 * Every POSIX entry is a constant chosen here. On win32 three entries are DERIVED from
 * the ambient `SystemRoot` and are therefore not constants — stated plainly at the
 * branch below and in the § WINDOWS RESIDUAL header, because an earlier revision of this
 * docblock said "nothing is inherited except the Windows host variables … which cannot
 * redirect repository resolution", which is true of REPOSITORY resolution and silently
 * false of COMMAND resolution.
 *
 * ── § IDENTITY — why this profile REFUSES to let git invent an author (#1915) ─
 *
 * Nulling global and system config is correct for a repository QUESTION and was
 * silently wrong for a repository MUTATION. `user.name`, `user.email`,
 * `user.signingkey` and `commit.gpgsign` live in GLOBAL config on essentially every
 * developer host, so this profile makes all four unreadable. Git's response to a
 * missing identity is NOT an error: `user.useConfigOnly` defaults FALSE, so git
 * synthesises an author from the passwd database and the hostname. MEASURED on one
 * throwaway repo, one variable changed, both poles — genericized here because this file
 * SYNCS, so the raw capture lives in the never-synced
 * `test-harness/tests/git-env-regrowth-guard-1471.test.mjs`:
 *
 *   ambient      exit=0  author=<real name> <configured@address>   sig=G
 *   gitEnv()     exit=0  author=<real name> <$USER@$HOSTNAME.local>  sig=N
 *
 * The NAME survives — git reads it from the OS user record — while the ADDRESS is
 * fabricated and the commit is UNSIGNED. So `git log` reads as correctly attributed
 * to a real person, and a reader has no prompt to check `%G?`. That is the exact pair
 * `rules/multi-operator-coordination.md` §1 exists to keep apart: a `display_id`-shaped
 * surface with no `verified_id` under it.
 *
 * THE FIX IS TO CLOSE GIT'S AUTO-DETECTION, NOT TO BAN COMMITS. The three
 * `GIT_CONFIG_*` identity lines in the body set `user.useConfigOnly=true`, which makes
 * git REFUSE (`exit 128`, `Author identity unknown`) instead of guessing. A caller that
 * DECLARES an identity is unaffected — all three shapes live in this repo today were
 * measured to still succeed under the change:
 *
 *   explicit `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env   `lib/transport-git-ref.js` (commit-tree)
 *   explicit `-c user.name=` / `-c user.email=`     `bin/clean-instantiate.mjs`
 *   identity in the LOCAL repo config              `bin/burndown-build.mjs` (fixture repo)
 *
 * So the line this draws is IMPLICIT vs EXPLICIT, not read vs write. A blanket refusal
 * of committing under `gitEnv()` was considered and REJECTED: it would break all three
 * callers above, each of which commits deliberately, with a declared identity, and
 * deliberately unsigned (a deterministic coordination-log object cannot carry a
 * signature and stay deterministic; a fresh-root disclosure scrub must work on a client
 * with no signing key at all).
 *
 * OCCUPYING `GIT_CONFIG_COUNT` IS NOT A WIDENING, which is the one thing a reader
 * should check here. This module denies the `GIT_CONFIG_COUNT`/`_KEY_n`/`_VALUE_n`
 * injection family by building the child env from CONSTANTS — nothing is copied from
 * `process.env` — and that is unchanged. Pinning `GIT_CONFIG_COUNT` to `1` OURSELVES
 * additionally CAPS the channel: git reads exactly `KEY_0`/`VALUE_0`, both of which are
 * literals here, so an ambient `GIT_CONFIG_COUNT=5` with attacker `KEY_1..KEY_4` has
 * nowhere to land. The denial moved from "absent" to "pinned to our own constant",
 * which is strictly the stronger of the two and is asserted that way in
 * `git-env-net-profile-1471.test.mjs::1471-N2`.
 *
 * THE PIN IS A DEFAULT, NOT A FENCE — stated because the paragraph above could be read
 * as claiming more. `-c` is parsed AFTER the `GIT_CONFIG_COUNT` carrier and last-wins,
 * so a caller passing `-c user.useConfigOnly=false` defeats it. MEASURED: that
 * invocation commits at exit 0 under this profile. Nothing attacker-reachable follows —
 * argv is not an environment channel, every call site passes literal constants, and
 * `gitConfigInvocation()` refuses `-c` outright — but the pin stops an ACCIDENT, not a
 * determined caller, and is not load-bearing against one.
 *
 * WHAT THIS DOES NOT DO, stated rather than implied: it does not make a commit SIGNED.
 * `commit.gpgsign` stays unreadable, so a commit with an explicitly declared identity is
 * still unsigned under this profile — correctly, for the three callers above. An
 * OPERATOR-attributed, SIGNED commit needs the fourth profile the regrowth ledger names
 * (`git-env-regrowth-guard-1471.test.mjs`, the `sync-gate2-worktree.mjs` row); that
 * remains unbuilt, and this change deliberately does not pretend otherwise.
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
    // IDENTITY IS FAIL-CLOSED (loom#1915) — see § IDENTITY below for the whole
    // argument. The three `GIT_CONFIG_*` lines above make `user.name` /
    // `user.email` / `user.signingkey` / `commit.gpgsign` unreadable, and git's
    // `user.useConfigOnly` defaults FALSE, so git does not ERROR for want of an
    // identity — it GUESSES one from the passwd database and the hostname, does
    // not sign, and exits 0. These three lines flip that default.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "user.useConfigOnly",
    GIT_CONFIG_VALUE_0: "true",
  };
  return Object.assign(env, windowsHostEnv());
}

/**
 * The win32 host variables ANY child spawned from a hook needs — `{}` off win32.
 *
 * WHY THIS IS A SHARED FUNCTION AND NOT THREE COPIES (loom#1471 s49). This block
 * used to live inline in `gitEnv()`, and TWO other shims grew their own copies:
 * `lib/template-resolver.js::_shimEnv` and `validate-bash-command.js::nodeChildEnv`.
 * Then `gitEnv()`'s copy was hardened — shape-validated `SystemRoot`, DERIVED
 * `COMSPEC`, constant `PATHEXT` — and the other two were not. Measured on this tree
 * before the extraction: three sites read the ambient `SystemRoot`, ONE validated it
 * with `_normalizeSystemRoot` and the other two still used bare `path.isAbsolute`,
 * AND both still FORWARDED `COMSPEC`/`PATHEXT` verbatim from the ambient environment.
 *
 * That is `rules/security.md` § Enforcement-Surface Parity in its literal form: a
 * control promoted at one surface that the independent surfaces never learned. The
 * module's own header already said two copies of an env allowlist is the shape that
 * leaves one a variable behind — this is that, observed. So the fix is ONE function
 * all three call, not three corrected copies that can drift again.
 *
 * THE LINE, same as the net profile draws it: DATA MAY PASS, COMMANDS MAY NOT.
 * `COMSPEC` names the command INTERPRETER and `PATHEXT` decides which extensions are
 * executable at all, so both are COMMANDS and are derived here rather than forwarded.
 * On Windows a forwarded `COMSPEC` is a command-execution vector: anything that shells
 * out — `child_process` with `shell: true`, or any child that itself invokes `cmd` —
 * runs the attacker's binary as the interpreter.
 *
 * BE EXACT ABOUT WHAT "DERIVED" BUYS. `PATHEXT` is a literal constant and IS closed.
 * `COMSPEC`, `PATH` and `SystemRoot` are DERIVED from a shape-validated ambient
 * anchor — not constants — so an attacker who can set `SystemRoot` must now land a
 * DRIVE-ROOTED, SINGLE-SEGMENT directory AND plant `System32\cmd.exe` under it.
 * Narrower, and NOT shut; § WINDOWS RESIDUAL owns the statement of what survives.
 * An earlier revision of this text claimed the anchor was "already-validated" when
 * the validation was `path.isAbsolute` alone — which admits `C:\attacker\stage` and
 * the UNC `\\evil\share` (measured; see `_normalizeSystemRoot`). That claim is
 * withdrawn rather than restated.
 */
function windowsHostEnv() {
  if (process.platform !== "win32") return {};
  // AMBIENT INPUT. Shape-validated, NOT merely absoluteness-checked — the fallback
  // to the constant fires whenever the value does not look like a system root.
  const amb = process.env.SystemRoot || process.env.SYSTEMROOT;
  const sysRoot = _normalizeSystemRoot(amb) || "C:\\Windows";
  const env = {
    SystemRoot: sysRoot,
    PATH: `${sysRoot}\\System32;${sysRoot}`,
    COMSPEC: `${sysRoot}\\System32\\cmd.exe`,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
  };
  // TEMP/TMP are genuinely DATA — a scratch directory the child writes into — so
  // they pass, but only as an absolute path, so neither can smuggle a
  // relative or empty value that lands writes somewhere unintended.
  for (const k of ["TEMP", "TMP"]) {
    const v = process.env[k];
    if (typeof v === "string" && path.isAbsolute(v)) env[k] = v;
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
 *     uid=501(<operator>) gid=20(staff) …       # PWNED.txt — arbitrary execution
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
 *      `identity file /Users/<operator>/.ssh/id_rsa` — the REAL user's key — and
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
const PROXY_SCHEMES = new Set([
  "http:",
  "https:",
  "socks5:",
  "socks5h:",
  "socks4:",
  "socks:",
]);

/** `user:pass@` — optional, and deliberately excludes `/`, `[`, `]`, and whitespace. */
const _PROXY_USERINFO = "(?:[^\\s:@/\\[\\]]+(?::[^\\s@/\\[\\]]*)?@)?";
/** A bracketed IPv6 literal, or a dotted hostname/IPv4. No path, no query, no space. */
const _PROXY_HOST =
  "(?:\\[[0-9A-Fa-f:.]+\\]|[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*)";
const _SCHEMELESS_PROXY = new RegExp(
  `^${_PROXY_USERINFO}${_PROXY_HOST}:(\\d{1,5})$`,
);

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
  return (
    typeof v === "string" &&
    v !== "" &&
    v.length <= 2048 &&
    /^[A-Za-z0-9.,:*\-_/[\]\s]+$/.test(v)
  );
}

/** An absolute path that exists and is of the required kind. Never a command. */
function _validPathOfKind(v, kind) {
  if (typeof v !== "string" || v === "" || !path.isAbsolute(v)) return false;
  try {
    const st = fs.statSync(v); // follows symlinks: the target is what git opens
    return kind === "file"
      ? st.isFile()
      : kind === "dir"
        ? st.isDirectory()
        : st.isSocket();
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

/**
 * Subcommands that OPEN A CONNECTION. Anything absent from this set is local and
 * gets the tighter `gitEnv()`.
 *
 * Deliberately a set of NAMES, not a substring match: `git remote get-url` reads
 * `.git/config` and opens nothing, so matching on the word "remote" would hand a
 * purely local read the egress-carrying profile — a widening dressed as caution.
 */
const NET_SUBCOMMANDS = new Set([
  "fetch",
  "push",
  "pull",
  "clone",
  "ls-remote",
  "submodule",
  "archive",
]);

/**
 * Pick the profile for a MIXED wrapper — one `_defaultGit`-style function whose
 * caller decides at runtime whether this invocation reaches a remote.
 *
 * WHY THIS EXISTS RATHER THAN THREE COPIES (loom#1471 s49). Three files
 * (`lib/genesis-materializer.js`, `lib/trust-root-backfill.js`,
 * `lib/log-ref-name.js`) funnel BOTH local and remote subcommands through a
 * single wrapper. Hand-copying "is this a net call?" into each is precisely the
 * shape `rules/security.md` § Enforcement-Surface Parity forbids: three
 * enumerations that drift, and the one that falls behind silently hands egress
 * variables to a local read or starves a fetch of its proxy.
 *
 * LEAST PRIVILEGE IS THE DEFAULT: an unrecognized or missing subcommand gets
 * `gitEnv()`, the TIGHTER profile. A caller that genuinely needs the network and
 * is not in the set above fails to reach it — loudly, at its own call site —
 * rather than quietly receiving more environment than it was granted.
 *
 * @param {string[]} args — the invocation WITHOUT the `git` binary.
 * @returns {object} `gitNetEnv()` for a remote-reaching subcommand, else `gitEnv()`.
 */
function gitEnvForArgs(args) {
  if (!Array.isArray(args)) return gitEnv();
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (typeof tok !== "string") continue;
    // `-C <dir>` and `-c <name>=<value>` are the ONLY git global options taking a
    // SEPARATE value (every other one — `--git-dir=`, `--work-tree=`,
    // `--namespace=`, `--config-env=` — attaches its value with `=`). Both must
    // consume it, so neither a directory NAMED "fetch" nor a config VALUE can be
    // read as the subcommand.
    //
    // `-c` was missing, and the failure was DIRECTIONAL. `git -c http.proxy=x
    // fetch` returned after testing `NET_SUBCOMMANDS.has("http.proxy=x")` — it
    // never saw `fetch` — so a remote-reaching invocation received the OFFLINE
    // profile. This module names that outcome itself: a net subcommand handed the
    // offline env "falls through to the offline sibling, so a stale template
    // quietly becomes authoritative", which it calls "not fail-closed, it is
    // fail-BROKEN".
    //
    // MEASURED before the fix, discriminator SSH_AUTH_SOCK (the only key that
    // differs between the two profiles): `-c http.proxy=x fetch` -> OFFLINE,
    // against controls where `fetch` -> NET and `-C dir fetch` -> NET. Pinned by
    // `git-env-regrowth-guard-1471.test.mjs::1471-G8`, which reds when this `-c`
    // arm is removed.
    if (tok === "-C" || tok === "-c") {
      i++;
      continue;
    }
    if (tok.startsWith("-")) continue; // a global flag, not the subcommand
    return NET_SUBCOMMANDS.has(tok) ? gitNetEnv() : gitEnv();
  }
  return gitEnv();
}

/* ────────────────────── the CONFIG profile (loom#1471 shard F1) ─────────────
 *
 * WHY A THIRD PROFILE EXISTS. `gitEnv()` closes repository steering by building
 * the child env from constants, and it ALSO sets `GIT_CONFIG_NOSYSTEM=1` +
 * `GIT_CONFIG_GLOBAL=/dev/null` + `GIT_CONFIG_SYSTEM=/dev/null`. That second
 * half is correct for a guard asking git a REPOSITORY question, and fatal for a
 * guard asking git a CONFIG question. `lib/operator-id.js` is the pointed case:
 * it reads `user.signingkey` and `user.name`, which live in GLOBAL config on
 * essentially every developer host. MEASURED on this host, both poles, one tree:
 *
 *   $ git -C <repo> config --get user.signingkey            # ambient
 *     /Users/<operator>/.ssh/id_ed25519                     # exit 0
 *   $ env -i PATH=/usr/bin:/bin GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
 *       git -C <repo> config --get user.signingkey
 *     (empty)                                               # exit 1
 *
 * So routing operator-id through `gitEnv()` would not harden it, it would BREAK
 * it — and break it UPWARDS: a null `display_id` makes `integrity-guard`'s
 * `isCodifyBranch` accept ANY `codify/*-<date>` shape, so the "hardening" would
 * WIDEN the fence it was meant to protect. That is why those two sites sat on
 * the debt ledger with a comment saying DO NOT mechanically sweep, waiting for
 * this profile.
 *
 * WHAT THIS IS. A steering-closed, config-PRESERVING invocation. Like
 * `gitNetEnv()` it CALLS `gitEnv()` and edits the result, so the repo-redirect
 * family (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`,
 * `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`,
 * `GIT_CEILING_DIRECTORIES`, `GIT_DISCOVERY_ACROSS_FILESYSTEM`, `GIT_NAMESPACE`,
 * and the `GIT_CONFIG_COUNT`/`_KEY_n`/`_VALUE_n` injection family) stays denied
 * BY ABSENCE rather than by a third enumeration that could drift from the other
 * two — `rules/security.md` § Enforcement-Surface Parity, one shared function.
 * The execution family (`GIT_SSH_COMMAND`, `GIT_SSH`, `GIT_ASKPASS`,
 * `SSH_ASKPASS`, `GIT_PROXY_COMMAND`, `GIT_EXTERNAL_DIFF`, `GIT_EDITOR`,
 * `GIT_SEQUENCE_EDITOR`, `GIT_PAGER`) is denied the same way, and unlike
 * `gitNetEnv()` this profile re-admits NOTHING from the ambient environment.
 * Exactly THREE things change relative to `gitEnv()`:
 *
 *   1. `GIT_CONFIG_NOSYSTEM` / `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` are
 *      REMOVED, so `/etc/gitconfig` and `~/.gitconfig` are read normally.
 *   2. `HOME` is SET — but DERIVED, never forwarded (see § HOME below).
 *   3. The INVOCATION gains a neutralizer prefix and a subcommand allowlist
 *      (see § THE HARD PART below), which is why the entry point returns an
 *      `{args, env}` pair instead of an env alone.
 *
 * The `user.useConfigOnly` identity fail-closed `gitEnv()` injects via
 * `GIT_CONFIG_COUNT`/`_KEY_0`/`_VALUE_0` (§ IDENTITY, loom#1915) is NOT among them —
 * it is INHERITED here, because `var` is in the allowlist and resolves an identity
 * under `IDENT_STRICT` without writing any object (measured at `_gitConfigEnv`).
 * Consequently the "denied BY ABSENCE" sentence below is true of the STEERING family
 * it names and NOT of that trio, which this profile carries as OUR OWN constants —
 * pinned by value, never forwarded, and asserted that way in
 * `git-env-config-profile-f1-1471.test.mjs`.
 *
 * ── § HOME — the vector that admitting config re-opens, and how it is shut ──
 *
 * `HOME` is not data. A `~/.gitconfig` can carry `core.pager`,
 * `credential.helper`, `core.fsmonitor`, `alias.*`, `core.sshCommand`,
 * `diff.<d>.command`, `gpg.program` — every one of which is a PROGRAM git will
 * run. `gitNetEnv()`'s header already measured this: with `HOME` pointed at a
 * directory holding a planted `.gitconfig` carrying `core.sshCommand`, the
 * command ran (uid=501). So a profile that admits global config by forwarding
 * ambient `HOME` has traded a repository redirect for a config-mediated
 * execution channel, which is not an improvement.
 *
 * THE RESOLUTION IS NOT TO FORWARD IT. `HOME` here is DERIVED from the passwd
 * database via `os.userInfo().homedir`, which does NOT consult `$HOME`.
 * MEASURED on this host, and the discriminating pole is the second line — had
 * `userInfo()` consulted the environment it would have printed the decoy:
 *
 *   $ HOME=/tmp/decoy-home node -e '…'
 *     env.HOME             /tmp/decoy-home
 *     os.homedir()         /tmp/decoy-home     ← consults $HOME, therefore UNUSABLE here
 *     os.userInfo().homedir /Users/<operator>  ← passwd-derived, ignores $HOME
 *
 * That is the same asymmetry `gitNetEnv()` recorded for OpenSSH (`getpwuid()` in
 * `ssh.c`, not `$HOME`), applied deliberately instead of discovered. An attacker
 * who can set environment variables therefore cannot choose which `.gitconfig`
 * git reads: the profile reads the REAL operator's, or none.
 *
 * WIN32 IS REASONED, NOT OBSERVED. libuv's `uv_os_get_passwd` on Windows takes
 * the profile directory from the process token rather than from `USERPROFILE`,
 * so the same property should hold; it was NOT executed here and is written down
 * as reasoning rather than as a measurement.
 *
 * FAIL-CLOSED, NEVER AMBIENT. When the passwd lookup yields nothing usable
 * (throws, or is not an existing absolute directory) `HOME` is simply ABSENT and
 * `homeSource` is reported `null`. It does NOT fall back to `process.env.HOME` —
 * that is the one fallback that would silently reintroduce the whole vector
 * (`rules/zero-tolerance.md` Rule 3). Absent `HOME` means global config is not
 * found, which surfaces as a MISSING signing key — the tight ranking every
 * caller in this module already applies to an indeterminate git.
 *
 * ── § THE HARD PART — admitting config re-opens execution THROUGH config ────
 *
 * Denying `GIT_PAGER` in the env buys nothing if `core.pager` in a config file
 * can name the same program. So the residual is closed on TWO axes, and the
 * split is deliberate: axis 1 covers knobs reachable from ANY git command, axis
 * 2 makes the remainder structurally unreachable.
 *
 * AXIS 1 — NEUTRALIZE, at the highest precedence git offers. `-c` beats every
 * config FILE, so these cannot be overridden by a planted or a genuine config:
 *
 *   --no-pager               kills pagination outright, above `core.pager` AND
 *                            `pager.<cmd>` (which `GIT_PAGER` alone does not).
 *   -c core.pager=cat        belt to that brace, for any path that re-derives it.
 *   -c credential.helper=    an EMPTY value RESETS the helper list to empty —
 *                            documented git behaviour, not an accident of parsing.
 *   -c core.fsmonitor=false  the boolean form disables the hook program.
 *                            SCOPE, because this one is version-dependent and
 *                            the flat claim would be an over-claim: the boolean
 *                            reading is modern git (MEASURED accepted, exit 0,
 *                            on git 2.50.1 here). Older git read this key as a
 *                            HOOK PATH, where `false` would name a program
 *                            rather than disable one. That residual is carried
 *                            by axis 2 rather than argued away — fsmonitor is
 *                            consulted when git REFRESHES THE INDEX, which no
 *                            allowlisted subcommand does.
 *
 * AXIS 2 — SCOPE, enforced in code rather than promised in prose. The knobs that
 * axis 1 cannot wildcard away — `filter.<d>.clean/smudge/process`,
 * `diff.<d>.command`, `gpg.program`, `core.hooksPath` + the hooks themselves,
 * `core.sshCommand`, `core.gitProxy`, `remote.<n>.uploadpack`,
 * `trailer.<t>.command`, `init.templateDir`, `core.editor` — are each reachable
 * only from commands that transfer, mutate the index/worktree, diff, sign, or
 * prompt. `gitConfigInvocation()` therefore REFUSES any subcommand outside
 * `CONFIG_PROFILE_SUBCOMMANDS`, so those knobs are unreachable BY CONSTRUCTION
 * and not by a reviewer remembering to check. The refusal is a thrown, typed
 * error — loud, and never a downgrade to a looser profile.
 *
 * `alias.*` deserves its own sentence because it is the one that looks like it
 * escapes both axes. It does not: git ignores an alias that shadows a built-in
 * command, and every name in the allowlist is a built-in. MEASURED, with the
 * control that makes the negative readable — an alias on a NON-built-in name in
 * the same config file DID execute, so the config was live and the mechanism was
 * reachable; the built-in name was ignored anyway. See the probe recorded in
 * `.claude/test-harness/tests/git-env-config-profile-f1-1471.test.mjs`.
 *
 * ARGV IS A STEERING SURFACE TOO, and closing only the env would have been half
 * a fix: `--git-dir`, `--work-tree`, `--namespace` and `-c` re-point git from the
 * ARGUMENT vector, where no env allowlist can see them. They are refused with the
 * same typed error. Callers may pass `-C <dir>` — which chooses a DIRECTORY, not
 * a repository, and is what every existing site already uses.
 *
 * ── § RESIDUAL, STATED PLAINLY ─────────────────────────────────────────────
 *
 * This profile reads the operator's REAL global and system config. An attacker
 * who can WRITE `~/.gitconfig` or `/etc/gitconfig` can therefore still choose
 * `user.signingkey`, and so still steer `verified_id`. That is not closed here
 * and cannot be: reading that file IS the feature. It is the same class, and the
 * same disposition, as `gitNetEnv()`'s note that ssh reads the operator's real
 * `~/.ssh/config` regardless — the operator's own file is a different threat
 * model from an attacker-controlled environment channel, and an attacker who can
 * write it already owns the account. What IS closed is the environment channel:
 * `GIT_DIR`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_COUNT` and `HOME` can no longer
 * point git at a decoy.
 */

/**
 * The ONLY subcommands this profile may run. Each is a git BUILT-IN (so no
 * `alias.*` can shadow it) that reads or writes config and refs WITHOUT
 * transferring, diffing, signing, prompting, running a hook, or applying a
 * filter driver to the index or worktree. Widening this set is a security
 * decision: it must re-check § THE HARD PART axis 2 for the added command.
 */
const CONFIG_PROFILE_SUBCOMMANDS = new Set([
  "config",
  "rev-parse",
  "symbolic-ref",
  "var",
]);

/** Global options a caller MAY pass. `-C` chooses a DIRECTORY, not a repository. */
const _ARGV_ALLOWED_GLOBAL_WITH_VALUE = new Set(["-C"]);

/**
 * Global options a caller MUST NOT pass: each re-points git from the ARGUMENT
 * vector, which no environment allowlist can see. `-c` is refused because the
 * neutralizer prefix below is the only sanctioned config injection here.
 */
const _ARGV_REFUSED_GLOBAL = new Set([
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
]);

/** § THE HARD PART axis 1 — highest-precedence overrides for the always-reachable knobs. */
const CONFIG_NEUTRALIZERS = Object.freeze([
  "--no-pager",
  "-c",
  "core.pager=cat",
  "-c",
  "credential.helper=",
  "-c",
  "core.fsmonitor=false",
]);

/** Thrown when a call site asks this profile for something outside its scope. */
class GitConfigProfileError extends Error {
  constructor(message) {
    super(`gitConfigInvocation: ${message}`);
    this.name = "GitConfigProfileError";
  }
}

/**
 * The passwd-database home directory, or null. Deliberately NOT `os.homedir()`,
 * which consults `$HOME` and is therefore attacker-choosable — see § HOME.
 */
function _passwdHome() {
  try {
    const h = os.userInfo().homedir;
    if (typeof h !== "string" || !path.isAbsolute(h)) return null;
    return fs.statSync(h).isDirectory() ? h : null;
  } catch {
    return null;
  }
}

/**
 * The environment half of the config profile. Exported for tests and for the
 * assertion suites; PRODUCTION CALLERS MUST USE `gitConfigInvocation()`, because
 * the env alone is only two thirds of the contract — the neutralizer prefix and
 * the subcommand refusal are the other third, and handing out the env by itself
 * is how a call site ends up with global config admitted and `core.pager` live.
 *
 * @returns {{env: object, homeSource: "passwd"|null}}
 */
function _gitConfigEnv() {
  const env = gitEnv();
  // The three lines that make this profile config-PRESERVING. Removing them is
  // the whole point; everything above and below exists to pay for them.
  delete env.GIT_CONFIG_NOSYSTEM;
  delete env.GIT_CONFIG_GLOBAL;
  delete env.GIT_CONFIG_SYSTEM;
  // The § IDENTITY pin is deliberately KEPT here. An earlier revision DELETED it, on
  // the argument that `CONFIG_PROFILE_SUBCOMMANDS` admits no verb that writes a commit
  // object so auto-detection was unreachable. That argument is FALSE and is withdrawn
  // rather than restated: writing an object is not the trigger — `IDENT_STRICT` is, and
  // `var` IS in the allowlist. MEASURED, config unreadable, one tree, both poles:
  //
  //   git var GIT_AUTHOR_IDENT, no pin   -> exit 0, <$USER@$HOSTNAME.local>  (FABRICATED)
  //   git var GIT_AUTHOR_IDENT, with pin -> exit 128, Author identity unknown
  //
  // So the pin has real work to do here: it closes the same fabrication at the
  // IDENTITY-RESOLUTION surface that it closes at the commit surface. It is latent
  // today — no production caller invokes `var`, and where config IS readable `var`
  // returns the operator's real identity — but a fail-closed control is not withheld
  // on the strength of no caller having arrived yet.
  //
  // The earlier revision also cited a `config --get` measurement (`user.signingkey`,
  // `user.name`, `user.email` byte-identical with and without the key) as evidence for
  // the whole profile. That instrument was built for the `config --get` question and
  // cannot answer the profile-wide one — it never invoked `var`. That is
  // `rules/instrument-discipline.md` MUST-4, and the reading is withdrawn with it.
  const home = _passwdHome();
  if (home) env.HOME = home; // DERIVED, never forwarded (§ HOME)
  return { env, homeSource: home ? "passwd" : null };
}

/**
 * Build a steering-closed, config-PRESERVING git invocation.
 *
 * Returns BOTH halves as one object on purpose: a caller cannot obtain the
 * config-admitting env without also taking the neutralizer prefix and passing
 * the subcommand refusal. That is `rules/security.md` § Enforcement-Surface
 * Parity expressed as a type rather than as a convention — there is no shape of
 * this call that admits global config with the pager knob left live.
 *
 * @param {string[]} gitArgs — the invocation WITHOUT the `git` binary, e.g.
 *   `["-C", repoDir, "config", "--get", "user.signingkey"]`.
 * @returns {{args: string[], env: object, homeSource: "passwd"|null}}
 * @throws {GitConfigProfileError} on a refused global option, a missing
 *   subcommand, or a subcommand outside `CONFIG_PROFILE_SUBCOMMANDS`. It THROWS
 *   rather than degrading to a looser profile: an unresolvable profile must fail
 *   loudly (`rules/zero-tolerance.md` Rule 3). Every call site passes literal
 *   constants, so a refusal is a programming error surfaced on first run.
 */
function gitConfigInvocation(gitArgs) {
  if (!Array.isArray(gitArgs) || gitArgs.some((a) => typeof a !== "string")) {
    throw new GitConfigProfileError("args must be an array of strings");
  }
  let sub = null;
  for (let i = 0; i < gitArgs.length; i++) {
    const tok = gitArgs[i];
    if (
      _ARGV_REFUSED_GLOBAL.has(tok) ||
      tok.startsWith("--git-dir=") ||
      tok.startsWith("--work-tree=") ||
      tok.startsWith("--namespace=") ||
      tok.startsWith("--config-env=")
    ) {
      throw new GitConfigProfileError(
        `global option ${tok} re-points git from the ARGUMENT vector, which the ` +
          `env allowlist cannot see — refused`,
      );
    }
    if (_ARGV_ALLOWED_GLOBAL_WITH_VALUE.has(tok)) {
      i++; // consume its value
      continue;
    }
    if (tok.startsWith("-")) continue; // a benign global flag, e.g. --no-optional-locks
    sub = tok;
    break;
  }
  if (sub === null) {
    throw new GitConfigProfileError("no subcommand found in args");
  }
  if (!CONFIG_PROFILE_SUBCOMMANDS.has(sub)) {
    throw new GitConfigProfileError(
      `subcommand "${sub}" is outside the config profile's scope. This profile ` +
        `admits global/system config, so it is restricted to built-ins that cannot ` +
        `reach filter/diff/hook/sign/transport config knobs. Use gitEnv() (local, ` +
        `config-closed) or gitNetEnv() (remote) instead`,
    );
  }
  const { env, homeSource } = _gitConfigEnv();
  return { args: [...CONFIG_NEUTRALIZERS, ...gitArgs], env, homeSource };
}

module.exports = {
  resolveGitBinary,
  resetGitBinaryCache,
  gitEnv,
  gitNetEnv,
  gitEnvForArgs,
  windowsHostEnv,
  gitConfigInvocation,
  GitConfigProfileError,
  // Test-only — NOT part of the supported API.
  _test_setCandidates,
  _test_isExecutableFile: isExecutableFile,
  _test_resolveViaPath: _resolveViaPath,
  // Exported so the win32 shape check is pinnable from a POSIX host: it is pure string
  // logic, so it is the ONE half of the win32 branch that can be measured off-platform.
  _test_normalizeSystemRoot: _normalizeSystemRoot,
  _test_GIT_CANDIDATES: GIT_CANDIDATES,
  _test_gitConfigEnv: _gitConfigEnv,
  _test_passwdHome: _passwdHome,
  _test_CONFIG_NEUTRALIZERS: CONFIG_NEUTRALIZERS,
  _test_CONFIG_PROFILE_SUBCOMMANDS: [...CONFIG_PROFILE_SUBCOMMANDS],
  _test_NET_PASSTHROUGH_NAMES: NET_PASSTHROUGH.map(([n]) => n),
  _test_NET_SUBCOMMANDS: [...NET_SUBCOMMANDS],
};
