/**
 * target-repo-git — THE envelope for every hook git call against a TARGET repository.
 *
 * A TARGET is a repository the JUDGED command names (`rm -rf <repo>`, `git -C <repo> …`,
 * `GIT_DIR=<d> git reset --hard`) or the payload cwd a session chose. The agent writes its
 * `.git/config`, `.git/info/attributes` and any file those include, so anything the
 * target's config can make git EXECUTE would run inside the hook. `gitEnv()` closes
 * global and system config only; nothing in the environment can close the target's own.
 *
 * ── THE API (stable; route every new target-repo git call through it) ─────────────────
 *
 *   resolveTargetRepo(selector)                -> {ok:true, repo} | {ok:false, ran, status, reason}
 *       selector = {dir}                        discovery from a directory, exactly as git
 *                                               would discover it from there
 *                | {cwd, gitDir?, workTree?}     a judged command's own selectors
 *       repo = {gitDir, workTree|null, insideWorkTree, names:{filters, hooks}}
 *       Resolved ONCE: the git dir and work tree are canonicalized (realpath) and every
 *       later call passes BOTH explicitly, so no later read can discover a different
 *       repository (core.worktree, a gitfile, a selector) than the one this resolved.
 *   targetGitInvocation(repo, args)            -> {file, argv, cwd, env}   (throws, see below)
 *   targetGit(repo, args, {timeout, spawn})    -> {ok, ran, status, stdout, stderr}
 *   targetGitAt(dir, args)                     -> same shape; DISCOVERY form, `rev-parse` only
 *   targetRepoEnv()                            -> the env every call gets
 *   TARGET_SUBCOMMANDS, TARGET_EXTRA_NEUTRALIZERS, TARGET_ENV_OVERRIDES  (frozen policy)
 *
 * A refusal THROWS with code `GIT_TARGET_REPO_REFUSED` from `targetGitInvocation`, and is
 * `{ok:false, ran:false}` from `targetGit`: a subcommand outside the allowlist, a mutating
 * form of an allowed one, or a name `-c` cannot express. Callers already rank "git did not
 * answer" as their not-measured state; a refusal lands there, never as a clean answer.
 *
 * ── HOW EVERY PROGRAM-EXECUTING KEY IS CLOSED ──────────────────────────────────────────
 *
 * SOURCE: the running git's own key list, `git help --config`, filtered for keys whose
 * documented role is to name something git runs (program, command, cmd, helper, hook,
 * editor, pager, driver, textconv, proxy, askpass, uploadpack, receivepack, external,
 * fsmonitor, filter, tool, browser, ssh). Read on git 2.55.0 (Linux, 1005 keys) and
 * 2.54.0 (Apple Git-157, 995 keys); the exec-relevant subsets are the same keys. Each is
 * closed by ONE of five mechanisms:
 *
 *  (1) `-c` constant (git-subprocess-env.js::TARGET_REPO_NEUTRALIZERS + the extras here;
 *      `-c` outranks every config file and every GIT_CONFIG_* env pair):
 *        core.fsmonitor, core.hooksPath (also silences $GIT_DIR/hooks), core.pager,
 *        credential.helper, log.showSignature, gpg.program, gpg.openpgp.program,
 *        gpg.ssh.program, gpg.x509.program, gpg.ssh.defaultKeyCommand, core.sshCommand,
 *        core.editor, sequence.editor, protocol.allow + protocol.<file|git|ssh|http|https|ext>.allow,
 *        status.submoduleSummary, gc.auto, maintenance.auto; and, for OUTPUT integrity
 *        rather than execution, color.ui / color.diff / color.status = never
 *  (2) NAME-KEYED, enumerated from the target's config (and every populated submodule's,
 *      for `status`) and emptied/disabled by name — no wildcard exists for these:
 *        filter.<d>.clean / .smudge / .process  -> emptied
 *        hook.<name>.enabled                    -> false (config-defined hooks, which
 *                                                  core.hooksPath does NOT reach)
 *  (3) SUBCOMMAND FLAGS injected by the policy table (no `-c` can close them: the key is
 *      name-keyed, or an empty value NAMES a program): diff.external,
 *      diff.<d>.command, diff.<d>.textconv  -> `--no-ext-diff --no-textconv` on diff/log;
 *      signature verification -> `--no-show-signature` on log and `stash list`.
 *  (4) ENVIRONMENT (TARGET_ENV_OVERRIDES): every TRANSPORT is refused — GIT_ALLOW_PROTOCOL
 *      names no real protocol, which overrides ANY protocol.* config — and partial-clone
 *      lazy fetch is off (GIT_NO_LAZY_FETCH, which gitEnv() itself now sets for EVERY
 *      hook git call: a read in a partial clone otherwise fetches a missing object).
 *      That closes what only a transport reaches:
 *      remote.<n>.uploadpack / receivepack / proxy, core.gitProxy (also GIT_PROXY_COMMAND),
 *      core.sshCommand (also GIT_SSH_COMMAND / GIT_SSH), core.alternateRefsCommand,
 *      http.proxy*, credential.<url>.helper. GIT_ASKPASS="" / SSH_ASKPASS="" leave
 *      core.askPass nothing to run; GIT_EDITOR / GIT_SEQUENCE_EDITOR are ":" (git's no-op).
 *      Every GIT_* the base profile did not set is DELETED, so no relocating variable
 *      (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_COMMON_DIR, GIT_OBJECT_DIRECTORY, …)
 *      can reach the child even if a future base profile let one through.
 *  (5) UNREACHABLE by the subcommand allowlist (TARGET_SUBCOMMANDS: read-only plumbing
 *      and porcelain reads only): alias.* (a builtin name never expands an alias),
 *      merge.<d>.driver, merge.tool / mergetool.*, diff.tool / difftool.*, guitool.*,
 *      browser.* / web.browser / help.browser / instaweb.browser, man.*,
 *      sendemail.*Cmd, trailer.*.cmd, gc.recentObjectsHook, notes.rewrite.*,
 *      gitcvs.dbDriver, rebase.*. uploadpack.packObjectsHook is read from protected
 *      config only, and trace2.* from system/global only (both closed by gitEnv()).
 *
 * RESIDUALS, stated: (a) the name-keyed set (2) is read BEFORE the call that relies on
 * it; a writer racing the target's config in that window can add a name the call was not
 * told about. (b) A NEW git release can add a program-executing key; the allowlist (5)
 * and the transport refusal (4) bound what a new key can reach, and the enumeration
 * above must be re-run against `git help --config` when the fleet's git moves.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { resolveGitBinary, gitEnv, targetRepoArgs } = require("./git-subprocess-env.js");

const DEV_NULL = os.devNull;

const TARGET_EXTRA_NEUTRALIZERS = Object.freeze([
  "-c", `gpg.openpgp.program=${DEV_NULL}`,
  "-c", `gpg.ssh.defaultKeyCommand=${DEV_NULL}`,
  "-c", `core.sshCommand=${DEV_NULL}`,
  "-c", "core.editor=:",
  "-c", "sequence.editor=:",
  "-c", "protocol.allow=never",
  "-c", "protocol.file.allow=never",
  "-c", "protocol.git.allow=never",
  "-c", "protocol.ssh.allow=never",
  "-c", "protocol.http.allow=never",
  "-c", "protocol.https.allow=never",
  "-c", "status.submoduleSummary=false",
  "-c", "status.showUntrackedFiles=all",
  "-c", "gc.auto=0",
  "-c", "maintenance.auto=false",
  // Not an exec key: OUTPUT integrity. A target `color.diff=always` wraps every patch
  // line in escape bytes, so a caller reading `+`/`-` prefixes reads nothing.
  "-c", "color.ui=never",
  "-c", "color.diff=never",
  "-c", "color.status=never",
]);

// GIT_ALLOW_PROTOCOL: "behave as if protocol.allow is set to never, and each of the listed
// protocols has protocol.<name>.allow set to always (overriding any existing
// configuration)" — the listed name is no protocol any transport has.
const TARGET_ENV_OVERRIDES = Object.freeze({
  GIT_NO_LAZY_FETCH: "1",
  GIT_ALLOW_PROTOCOL: "coc-target-repo-transport-refused",
  GIT_SSH_COMMAND: DEV_NULL,
  GIT_SSH: DEV_NULL,
  GIT_PROXY_COMMAND: DEV_NULL,
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  GIT_EDITOR: ":",
  GIT_SEQUENCE_EDITOR: ":",
});

/** GIT_* keys the base profile sets on purpose; any other GIT_* is deleted. */
const BASE_GIT_KEYS = new Set([
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_TERMINAL_PROMPT",
  "GIT_OPTIONAL_LOCKS",
  "GIT_PAGER",
  "GIT_CONFIG_COUNT",
  "GIT_NO_LAZY_FETCH",
]);

function targetRepoEnv() {
  const env = gitEnv();
  for (const k of Object.keys(env)) {
    if (!k.startsWith("GIT_")) continue;
    if (BASE_GIT_KEYS.has(k) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) continue;
    delete env[k];
  }
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  if (typeof ceiling === "string") env.GIT_CEILING_DIRECTORIES = ceiling;
  const across = process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM;
  if (typeof across === "string" && /^(0|false|no|off)$/i.test(across)) {
    env.GIT_DISCOVERY_ACROSS_FILESYSTEM = across;
  }
  return Object.assign(env, TARGET_ENV_OVERRIDES);
}

/*
 * THE SUBCOMMAND ALLOWLIST. The key is the builtin; `second` (when present) is the ONLY
 * accepted first argument; `inject` goes right after the subcommand (and its `second`);
 * `refuse` names caller tokens that would undo an injected flag, write, or open an editor;
 * `requireOne` / `allowArgs` pin a subcommand to its read forms; `drivers` marks the one
 * subcommand that reaches filter drivers (status recurses into populated submodules, so
 * their names are enumerated too); `workTree` marks reads that need one (with only
 * `--git-dir`, git would take the cwd as the work tree, so they are refused on a repo
 * resolved without one).
 */
const UNDO_PATCH_FLAGS = ["--ext-diff", "--textconv", "--show-signature", "--output"];
const TARGET_SUBCOMMANDS = Object.freeze({
  "rev-parse": { inject: [] },
  status: { inject: [], drivers: true, workTree: true },
  "ls-files": { inject: [], workTree: true },
  "ls-tree": { inject: [] },
  "cat-file": { second: "blob", inject: [], blobPathOnly: true },
  "rev-list": { inject: [] },
  remote: { inject: [], allowArgs: ["-v", "--verbose"] },
  config: {
    inject: [],
    requireOne: ["--get", "--get-all", "--get-regexp", "--list", "-l"],
    refuse: ["--add", "--unset", "--unset-all", "--replace-all", "--rename-section", "--remove-section", "--edit", "-e", "set", "unset", "edit", "rename-section", "remove-section"],
  },
  log: { inject: ["--no-ext-diff", "--no-textconv", "--no-show-signature"], refuse: UNDO_PATCH_FLAGS },
  diff: { inject: ["--no-ext-diff", "--no-textconv"], refuse: UNDO_PATCH_FLAGS, workTree: true },
  stash: { second: "list", inject: ["--no-show-signature"], refuse: UNDO_PATCH_FLAGS },
  worktree: { second: "list", inject: [] },
  // A pure read of the exclude files and the INDEX: no object, filter, diff, hook,
  // signature or transport path. The index read is what reaches a program — it
  // refreshes `core.fsmonitor`, as `ls-files` does — and the `-c core.fsmonitor=false`
  // prefix closes it. MEASURED both poles (target-repo-git-routing.test.js case
  // S-ignore): a planted fsmonitor runs under a bare `check-ignore` and stays silent
  // through this envelope. NEED_WORK_TREE in git itself, hence `workTree`.
  "check-ignore": { inject: [], workTree: true },
});

function _refused(message) {
  const e = new Error(`target-repo-git: ${message}`);
  e.code = "GIT_TARGET_REPO_REFUSED";
  return e;
}

function _deadlineOpts(opts) {
  return opts && opts.deadline !== undefined ? opts : undefined;
}

function _deadlineError() {
  const e = new Error("target-repo-git: the shared deadline is exhausted");
  e.code = "GIT_TARGET_REPO_DEADLINE";
  e.timedOut = true;
  return e;
}

function _budgetMs(opts, timeout) {
  if (!_deadlineOpts(opts)) return timeout;
  if (typeof opts.deadline !== "number" || !Number.isFinite(opts.deadline)) {
    throw _refused("opts.deadline must be a finite absolute epoch in milliseconds");
  }
  const remaining = Math.floor(opts.deadline - Date.now());
  if (remaining < 1) throw _deadlineError();
  return Math.min(timeout, remaining);
}

function _deadlineMeta(value, opts) {
  if (!_deadlineOpts(opts) || !value) return {};
  const out = {};
  for (const key of ["code", "timedOut", "spawnErrorCode", "error", "signal"]) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  return out;
}

function _exceptionResult(error, opts, refused = false) {
  const base = { ok: false, ran: false, status: null, stdout: "", stderr: "" };
  if (refused) base.refused = String(error && error.message);
  if (!_deadlineOpts(opts)) return base;
  if (error && error.code === "GIT_TARGET_REPO_DEADLINE") {
    return { ...base, kind: "deadline", code: error.code, timedOut: true, reason: error.message };
  }
  return { ...base, ..._deadlineMeta(error, opts),
    ...(error && error.code !== "GIT_TARGET_REPO_REFUSED" ? {
      error, ...(error.code ? { spawnErrorCode: error.code } : {}),
    } : {}),
  };
}

function _policyArgs(args) {
  if (!Array.isArray(args) || args.length === 0 || args.some((a) => typeof a !== "string")) {
    throw _refused("args must be a non-empty array of strings, subcommand first");
  }
  const [sub, ...rest] = args;
  const policy = Object.prototype.hasOwnProperty.call(TARGET_SUBCOMMANDS, sub) ? TARGET_SUBCOMMANDS[sub] : null;
  if (!policy) throw _refused(`subcommand ${JSON.stringify(sub)} is not in the target-repo allowlist`);
  if (policy.blobPathOnly && (rest.length !== 2 || rest[0] !== "blob" ||
      !/^[^:\s-][^:\s]*:[^\0\r\n]+$/.test(rest[1]) || /[\0\r\n]/.test(rest[1]))) {
    throw _refused("only `cat-file blob <ref>:<path>` with one non-option object path is allowed against a target");
  }
  let head = [sub];
  let tail = rest;
  if (policy.second) {
    if (rest[0] !== policy.second) throw _refused(`only \`${sub} ${policy.second}\` is allowed against a target`);
    head = [sub, policy.second];
    tail = rest.slice(1);
  }
  if (policy.allowArgs && tail.some((a) => !policy.allowArgs.includes(a))) {
    throw _refused(`\`${sub}\` accepts only ${policy.allowArgs.join(", ")} against a target`);
  }
  if (policy.requireOne && !tail.some((a) => policy.requireOne.includes(a))) {
    throw _refused(`\`${sub}\` must be a read (${policy.requireOne.join(" | ")}) against a target`);
  }
  if (policy.refuse) {
    const bad = tail.find((a) => policy.refuse.some((r) => a === r || a.startsWith(r + "=")));
    if (bad !== undefined) throw _refused(`\`${sub}\` refuses ${JSON.stringify(bad)} against a target`);
  }
  // A caller's own `-c`/`--config-env` would come AFTER the prefix and override it.
  if (tail.some((a) => a === "-c" || a === "--config-env" || a.startsWith("--config-env="))) {
    throw _refused("a caller -c/--config-env would override the envelope");
  }
  return { head, tail, policy };
}

function _nameOverrides(names) {
  const out = [];
  for (const h of (names && names.hooks) || []) out.push("-c", `hook.${h}.enabled=false`);
  return out;
}

/**
 * The argv/cwd/env for one call against a RESOLVED repo. Throws GIT_TARGET_REPO_REFUSED.
 * `opts.cwd` (absolute) sets the spawn cwd, which git reads ONLY as the path prefix for
 * cwd-scoped reads (`ls-files`, `ls-tree`): the repository is fixed by the explicit
 * `--git-dir`/`--work-tree` pair, so no cwd can select a different one.
 */
function targetGitInvocation(repo, args, opts) {
  const o = opts || {};
  _budgetMs(o, o.timeout || 2500);
  if (!repo || typeof repo.gitDir !== "string" || !path.isAbsolute(repo.gitDir)) {
    throw _refused("a resolved repo (from resolveTargetRepo) is required");
  }
  const cwdOpt = opts && opts.cwd;
  if (cwdOpt !== undefined && cwdOpt !== null && (typeof cwdOpt !== "string" || !path.isAbsolute(cwdOpt))) {
    throw _refused("opts.cwd must be an absolute path");
  }
  const file = resolveGitBinary();
  if (!file) throw _refused("no git binary resolves");
  const { head, tail, policy } = _policyArgs(args);
  if (policy.workTree && !repo.workTree) {
    throw _refused(`\`${head[0]}\` needs a work tree and the resolved repository has none`);
  }
  let filters = (repo.names && repo.names.filters) || [];
  let hooks = (repo.names && repo.names.hooks) || [];
  if (policy.drivers) {
    const walked = _submoduleNames(repo, _deadlineOpts(o));
    if (!walked.ok) {
      if (walked.code === "GIT_TARGET_REPO_DEADLINE") throw _deadlineError();
      throw Object.assign(_refused(walked.detail), _deadlineMeta(walked, o));
    }
    filters = walked.filters;
    hooks = walked.hooks;
  }
  for (const n of hooks) {
    if (typeof n !== "string" || n === "" || /[=\n\0]/.test(n)) {
      throw _refused(`hook name ${JSON.stringify(String(n))} cannot be disabled through -c`);
    }
  }
  const prefix = targetRepoArgs([], { filterDrivers: filters }); // throws on an inexpressible name
  const selectors = ["--git-dir=" + repo.gitDir];
  if (repo.workTree) selectors.push("--work-tree=" + repo.workTree);
  const argv = [
    ...prefix,
    ...TARGET_EXTRA_NEUTRALIZERS,
    ..._nameOverrides({ hooks }),
    ...selectors,
    ...head,
    ...policy.inject,
    ...tail,
  ];
  const inv = { file, argv, cwd: cwdOpt || repo.workTree || repo.gitDir, env: targetRepoEnv() };
  _budgetMs(o, o.timeout || 2500);
  if (_deadlineOpts(o)) {
    Object.defineProperty(inv, "timeout", { enumerable: true, get: () => _budgetMs(o, o.timeout || 2500) });
    inv.killSignal = "SIGKILL";
  }
  return inv;
}

/**
 * THE one spawn site of every target-repo git call. `inject` is a test seam with
 * spawnSync's signature; it receives exactly what spawnSync would.
 */
function _spawn(gitBin, argv, opts, inject) {
  const timeout = _budgetMs(opts, opts.timeout);
  const deadlineKill = _deadlineOpts(opts) ? { killSignal: "SIGKILL" } : {};
  if (typeof inject === "function") {
    return inject(gitBin, argv, {
      cwd: opts.cwd,
      encoding: "utf8",
      timeout,
      ...deadlineKill,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env,
    });
  }
  return spawnSync(gitBin, argv, {
    cwd: opts.cwd,
    encoding: "utf8",
    timeout,
    ...deadlineKill,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: opts.env,
  });
}

function _result(r, opts) {
  if (!r || r.error || r.status === null || typeof r.stdout !== "string") {
    const base = { ok: false, ran: false, status: null, stdout: "", stderr: "" };
    if (!_deadlineOpts(opts) || !r) return base;
    return { ...base,
      timedOut: Boolean((r.error && r.error.code === "ETIMEDOUT") || (r.signal && r.status === null)),
      ...(r.error ? { error: r.error, ...(r.error.code ? { spawnErrorCode: r.error.code } : {}) } : {}),
      ...(r.signal ? { signal: r.signal } : {}),
    };
  }
  const stderr = typeof r.stderr === "string" ? r.stderr.slice(0, 2000) : "";
  if (r.status !== 0) return { ok: false, ran: true, status: r.status, stdout: r.stdout, stderr };
  return { ok: true, ran: true, status: 0, stdout: r.stdout, stderr };
}

/** Run one allowlisted call against a RESOLVED repo. Never throws. */
function targetGit(repo, args, opts) {
  const o = opts || {};
  let inv;
  try {
    inv = targetGitInvocation(repo, args, o);
  } catch (e) {
    return _exceptionResult(e, o, true);
  }
  try {
    return _result(_spawn(inv.file, inv.argv, { cwd: inv.cwd, env: inv.env, timeout: o.timeout || 2500, ...(_deadlineOpts(o) ? { deadline: o.deadline } : {}) }, o.spawn), o);
  } catch (e) {
    return _exceptionResult(e, o);
  }
}

/** DISCOVERY-form call (`git -C <dir> rev-parse …`), the only subcommand allowed unresolved. */
function targetGitAt(dir, args, opts) {
  const o = opts || {};
  try {
    _budgetMs(o, o.timeout || 2500);
    if (typeof dir !== "string" || !path.isAbsolute(dir)) throw _refused("an absolute directory is required");
    if (!Array.isArray(args) || args[0] !== "rev-parse") throw _refused("only rev-parse runs before a repo is resolved");
    _policyArgs(args);
    const file = resolveGitBinary();
    if (!file) throw _refused("no git binary resolves");
    const argv = [...targetRepoArgs([]), ...TARGET_EXTRA_NEUTRALIZERS, "-C", dir, ...args];
    return _result(_spawn(file, argv, { cwd: path.parse(dir).root, env: targetRepoEnv(), timeout: o.timeout || 2500, ...(_deadlineOpts(o) ? { deadline: o.deadline } : {}) }, o.spawn), o);
  } catch (e) {
    return _exceptionResult(e, o, true);
  }
}

function _canon(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/** One rev-parse with exactly the selectors a caller (or the judged command) gave. */
function _revParse(selector, flags, timeout, opts) {
  const file = resolveGitBinary();
  if (!file) return { ok: false, ran: false, status: null, stdout: "", stderr: "" };
  const sel = [];
  let cwd;
  if (selector && typeof selector.dir === "string" && path.isAbsolute(selector.dir)) {
    sel.push("-C", selector.dir);
    cwd = path.parse(selector.dir).root; // `-C` (absolute) picks the directory; the spawn cwd is neutral
  } else {
    if (!selector || typeof selector.cwd !== "string" || !path.isAbsolute(selector.cwd)) return { ok: false, ran: false, status: null, stdout: "", stderr: "" };
    sel.push("-C", selector.cwd);
    if (selector.gitDir) sel.push("--git-dir=" + selector.gitDir);
    if (selector.workTree) sel.push("--work-tree=" + selector.workTree);
    cwd = path.parse(selector.cwd).root;
  }
  try {
    const argv = [...targetRepoArgs([]), ...TARGET_EXTRA_NEUTRALIZERS, ...sel, "rev-parse", ...flags];
    return _result(_spawn(file, argv, { cwd, env: targetRepoEnv(), timeout, ...(_deadlineOpts(opts) ? { deadline: opts.deadline } : {}) }, opts && opts.spawn), opts);
  } catch (e) {
    return _exceptionResult(e, opts);
  }
}

/** filter.<d>.* and hook.<name>.* names in ONE repo's config, read through its git dir. */
function _configNames(gitDir, workTree, opts) {
  const repo = { gitDir, workTree, names: { filters: [], hooks: [] } };
  const r = targetGit(repo, ["config", "-z", "--name-only", "--get-regexp", "^(filter|hook)\\."], opts);
  // Exit 1 is git ANSWERING "no such key": an empty set, not an unknown one.
  if (!r.ok && !(r.ran && r.status === 1)) return { ok: false, kind: r.kind === "deadline" ? "deadline" : r.ran ? "unreadable" : "unanswered", detail: "the repository's config could not be read for filter drivers and config hooks", ..._deadlineMeta(r, opts) };
  const filters = new Set();
  const hooks = new Set();
  for (const rec of String(r.stdout).split("\0")) {
    const m = /^(filter|hook)\.(.*)\.([^.]*)$/s.exec(rec);
    if (!m) continue; // `filter.<key>` / `hook.<key>`: no subsection, nothing named
    const name = m[2];
    if (name === "" || /[=\n\0]/.test(name)) {
      return { ok: false, kind: "unneutralizable", detail: `the config names a ${m[1]} ${JSON.stringify(name)} that cannot be neutralized on the command line` };
    }
    (m[1] === "filter" ? filters : hooks).add(name);
  }
  _budgetMs(opts, (opts && opts.timeout) || 2500);
  return { ok: true, filters: [...filters], hooks: [...hooks] };
}

/**
 * Resolve a target ONCE. Returns the canonical git dir + work tree (null when there is
 * none: a bare repository, or a selector inside the git dir) and the name-keyed config
 * names of THAT git dir.
 *
 * Failures carry a `kind`, because they mean different things to a fail-closed caller:
 *   "unanswered"      git never produced a verdict (no binary, spawn error, timeout) — ran:false
 *   "git-answered"    git EXITED non-zero on discovery: no repository there, OR one git
 *                     refuses to read (an unknown extension, a dubious-ownership refusal).
 *                     Only the caller can tell those apart, by looking for a repository
 *                     on disk; it is never by itself "no repository".
 *   "unneutralizable" the config names a filter/hook the envelope cannot disable
 *   "unreadable"      the repository's config could not be read for those names
 *   "inconsistent"    git's answers do not form a canonical git-dir/work-tree pair
 * `stderr` is git's own text, for diagnostics only: it is target-influenced bytes.
 */
function resolveTargetRepo(selector, opts) {
  const timeout = (opts && opts.timeout) || 2500;
  try { _budgetMs(opts, timeout); } catch (e) { return _exceptionResult(e, opts, true); }
  const prep = _deadlineOpts(opts);
  const fail = (kind, reason, extra) => ({ ok: false, ran: kind !== "unanswered" && kind !== "deadline", kind, reason, ...extra });
  let gitDir;
  let workTree = null;
  let inside = false;
  const full = _revParse(selector, ["--absolute-git-dir", "--show-toplevel"], timeout, prep);
  if (full.ok) {
    const [g, t] = String(full.stdout).split("\n");
    gitDir = g;
    workTree = t || null;
    inside = Boolean(t);
  } else {
    if (!full.ran) return fail(full.kind === "deadline" ? "deadline" : "unanswered", full.reason || "git did not answer (binary unresolvable, spawn failure, or timeout)", _deadlineMeta(full, opts));
    const bare = _revParse(selector, ["--absolute-git-dir", "--is-inside-work-tree"], timeout, prep);
    if (!bare.ok) {
      if (!bare.ran) return fail(bare.kind === "deadline" ? "deadline" : "unanswered", bare.reason || "git did not answer (binary unresolvable, spawn failure, or timeout)", _deadlineMeta(bare, opts));
      return fail("git-answered", "git answered the repository discovery with an error", { status: bare.status, stderr: bare.stderr || full.stderr });
    }
    const [g, inWt] = String(bare.stdout).split("\n");
    if (inWt !== "false") return fail("inconsistent", "git reported a work tree but not its top level");
    gitDir = g;
  }
  const g = gitDir && path.isAbsolute(gitDir) ? _canon(gitDir) : null;
  const w = workTree ? (path.isAbsolute(workTree) ? _canon(workTree) : null) : null;
  try { _budgetMs(opts, timeout); } catch (e) { return _exceptionResult(e, opts); }
  if (!g || (workTree && !w)) return fail("inconsistent", "the resolved git dir or work tree could not be canonicalized");
  let names;
  try { names = _configNames(g, w, prep); } catch (e) { return _exceptionResult(e, opts); }
  if (!names.ok) return fail(names.kind, names.detail, _deadlineMeta(names, opts));
  try { _budgetMs(opts, timeout); } catch (e) { return _exceptionResult(e, opts); }
  return { ok: true, repo: { gitDir: g, workTree: w, insideWorkTree: inside, names: { filters: names.filters, hooks: names.hooks } } };
}

const MAX_SUBMODULE_DEPTH = 8;
const MAX_REPOS_WALKED = 64;

/**
 * Names across the repo AND every populated submodule `status` would recurse into —
 * read through each repository's OWN resolved git dir (a submodule is resolved by
 * discovery from its path, exactly as git's recursing child discovers it). Cached on the
 * repo object: resolved once, walked once.
 */
function _submoduleNames(repo, opts) {
  _budgetMs(opts, (opts && opts.timeout) || 2500);
  if (repo._walked) return repo._walked;
  const issue = (detail, result) => ({ ok: false, detail, ..._deadlineMeta(result, opts) });
  const filters = new Set((repo.names && repo.names.filters) || []);
  const hooks = new Set((repo.names && repo.names.hooks) || []);
  const seen = new Set();
  let walked = 0;
  const visit = (r, depth) => {
    if (depth > MAX_SUBMODULE_DEPTH || ++walked > MAX_REPOS_WALKED) {
      return issue(`submodule nesting exceeds the walk bound (depth ${MAX_SUBMODULE_DEPTH}, ${MAX_REPOS_WALKED} repositories)`);
    }
    if (seen.has(r.gitDir)) return null;
    seen.add(r.gitDir);
    for (const f of r.names.filters) filters.add(f);
    for (const h of r.names.hooks) hooks.add(h);
    if (!r.workTree) return null;
    const ls = targetGit({ ...r, names: { filters: [], hooks: [] } }, ["ls-files", "-s", "-z"], opts);
    if (!ls.ok) return issue("the index could not be read to find submodules", ls);
    for (const rec of String(ls.stdout).split("\0")) {
      if (!rec.startsWith("160000 ")) continue;
      const tab = rec.indexOf("\t");
      if (tab < 0) continue;
      const sub = path.join(r.workTree, rec.slice(tab + 1));
      let populated;
      try {
        populated = fs.existsSync(path.join(sub, ".git"));
      } catch {
        return issue("a submodule path could not be inspected");
      }
      if (!populated) continue;
      const res = resolveTargetRepo({ dir: sub }, opts);
      if (!res.ok) return issue(`a populated submodule could not be resolved: ${res.reason}`, res);
      const err = visit(res.repo, depth + 1);
      if (err) return err;
    }
    return null;
  };
  const err = visit(repo, 0);
  _budgetMs(opts, (opts && opts.timeout) || 2500);
  const result = err || { ok: true, filters: [...filters], hooks: [...hooks] };
  if (!(_deadlineOpts(opts) && result.timedOut)) repo._walked = result;
  return result;
}

module.exports = {
  resolveTargetRepo,
  targetGitInvocation,
  targetGit,
  targetGitAt,
  targetRepoEnv,
  TARGET_SUBCOMMANDS,
  TARGET_EXTRA_NEUTRALIZERS,
  TARGET_ENV_OVERRIDES,
};
