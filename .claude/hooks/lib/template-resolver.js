/**
 * Resolve a COC USE template to a local path.
 *
 * Resolution order (changed v2.9.1 to fix the stale-local-clone footgun):
 *
 *   1. KAILASH_COC_TEMPLATE_PATH env var — explicit developer escape hatch.
 *      Use this when iterating on un-pushed local template changes.
 *      MUST point at a directory containing `.claude/`.
 *   2. Cache at `~/.cache/kailash-coc/<template>/` — auto-updated via
 *      `git fetch --depth 1 origin main && git reset --hard origin/main`.
 *      This is the default fast path on every sync after first.
 *   3. Shallow clone from GitHub to cache if no cache exists.
 *   4. Local sibling directory — OFFLINE FALLBACK ONLY. Used only when
 *      every network operation in steps 2-3 fails (no network, GitHub
 *      unreachable, repo private without auth).
 *
 * Why this order:
 *   Pre-v2.9.1 the local sibling was step 1 — a one-time clone of the
 *   template, kept locally for any reason, would silently shadow the
 *   auto-updating cache forever, forcing users to `git pull` two repos
 *   before every downstream sync. The sibling path had no freshness
 *   guarantee. Now origin/main is always authoritative; the sibling
 *   becomes a true offline fallback that never wins against fresh remote.
 *
 *   When a sibling is detected but bypassed (default online path), we
 *   emit a one-line stderr notice telling the user how to opt back in
 *   via KAILASH_COC_TEMPLATE_PATH if that's actually what they wanted.
 *
 *   Offline-sibling resolution (changed Phase-2): the local sibling is no
 *   longer guessed POSITIONALLY (`dirname(cwd)/<tmpl>`, `~/repos/<tmpl>`,
 *   etc.). The positional guess was the same fragility class loom removed
 *   everywhere else — it breaks the moment an operator lays repos out
 *   differently. The offline sibling is now resolved through the shared
 *   linkage resolver at `../../bin/lib/loom-links.mjs` (the canonical
 *   NAME→location binding) via the USE-template logical key
 *   `use-template.<key>`. If a linkage is declared → that path is the
 *   offline sibling. If NOT declared (or no config) → the function returns
 *   an explicit not-found with a clear reason, NEVER a silent positional
 *   guess. The XDG-conventional cache path (`~/.cache/kailash-coc/`,
 *   CACHE_DIR below) is unchanged — that is a cache location, not a
 *   linkage, and stays positional by convention.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
// loom#1471 shard 3. Two profiles, one module: `gitEnv()` for local work,
// `gitNetEnv()` for the fetch/clone that must reach a remote. The net profile is
// the base PLUS validated transport data, so the repo-redirect denials cannot
// drift apart between the two (rules/security.md § Enforcement-Surface Parity).
const { resolveGitBinary, gitEnv, gitNetEnv } = require("./git-subprocess-env.js");

// Canonical linkage resolver (ESM, zero-dependency) — relative to hooks/lib/.
// template-resolver.js is CommonJS and findLocalSibling is synchronous, so
// the ESM module cannot be `require()`d directly. We invoke it through a
// short `node -e` shim (execFileSync, already imported) so the resolver
// stays the SINGLE source of truth for NAME→path resolution — no positional
// logic is duplicated here.
const LOOM_LINKS_MJS = path.resolve(
  __dirname,
  "..",
  "..",
  "bin",
  "lib",
  "loom-links.mjs",
);

// Map a USE-template directory name to its loom-links logical key.
// The resolver vocabulary is `use-template.{py,rs,claude-py,claude-rs,
// claude-rb}` (see bin/loom-links.local.example.json). Anything not in this
// map has no linkage key and resolves to an explicit not-found.
const TEMPLATE_LINK_KEYS = {
  "kailash-coc-claude-py": "use-template.claude-py",
  "kailash-coc-claude-rs": "use-template.claude-rs",
  "kailash-coc-claude-rb": "use-template.claude-rb",
  "kailash-coc-py": "use-template.py",
  "kailash-coc-rs": "use-template.rs",
  "kailash-coc-claude-prism": "use-template.prism",
  // base family (stack-agnostic, NO kailash- prefix) — the /migrate --adopt base axis
  "coc-base": "use-template.base",
  "coc-claude-base": "use-template.claude-base",
};

/**
 * Resolve a USE-template path through the shared loom-links resolver.
 * Returns { path } on a declared linkage, or { notFound: reason } when no
 * linkage is declared / no config exists / the resolver errors. NEVER
 * falls back to a positional guess — that is the fragility this removes.
 *
 * @param {string} templateName e.g. "kailash-coc-claude-py"
 * @returns {{ path: string } | { notFound: string }}
 */
function resolveSiblingViaLinks(templateName) {
  const logicalKey = TEMPLATE_LINK_KEYS[templateName];
  if (!logicalKey) {
    return {
      notFound:
        `no loom-links logical key for template "${templateName}" ` +
        `(known: ${Object.keys(TEMPLATE_LINK_KEYS).join(", ")})`,
    };
  }
  if (!fs.existsSync(LOOM_LINKS_MJS)) {
    return {
      notFound: `linkage resolver not found at ${LOOM_LINKS_MJS}`,
    };
  }
  // `require:false` → the resolver returns { skipped, reason } instead of
  // throwing when the key/config is absent. We print a single JSON line so
  // the sync CJS caller can parse one deterministic result.
  //
  // loom#1471 shard 5. THE GIT SUBPROCESSES IN THIS FILE WERE HARDENED AND THIS
  // NODE ONE WAS NOT — the same sibling-blindness that left the py overlay and
  // guard-path-scope behind. It is not a lesser site: the child evaluates
  // `resolveRepo`, and `loom-links.mjs:40` documents `$LOOM_LINKS_CONFIG` as the
  // HIGHEST-precedence config source, so one ambient variable chooses which
  // directory becomes the offline-fallback template. Chain: set
  // `LOOM_LINKS_CONFIG` + a dead `https_proxy` → the network clone fails →
  // `resolveTemplate` falls to the offline sibling → the sibling path comes from
  // the attacker's config → `/sync-from-template` adopts attacker-authored
  // `hooks/`, `agents/`, `rules/`. `LOOM_ECOSYSTEM_CONFIG` is fenced by exact
  // name at the settings layer; this direct sibling was not.
  //
  // A GREP WILL DISAGREE WITH THIS COMMENT. `grep -rn LOOM_LINKS_CONFIG
  // .claude/hooks/` returns no READ — every read is under `.claude/bin/`
  // (`lib/loom-links.mjs:140`). A review once concluded from exactly that scan
  // that the variable reaches the resolver only through the Bash lane and not
  // through this spawn. It does not follow, and it is wrong: the read executes
  // in `loom-links.mjs` INSIDE THE CHILD THIS LINE SPAWNS, and the child
  // inherits this process's environment. A scan scoped to `.claude/hooks/`
  // cannot see a read that happens in a spawned child executing a
  // `.claude/bin/` module — `rules/instrument-discipline.md` MUST NOT, a
  // lexical scan treated as a verdict on a semantic property.
  //
  // Measured in-process, no Bash lane anywhere in the call path — calling
  // `resolveSiblingViaLinks()` directly with the variable set in this process:
  //   unfixed:  {"path":"/…/ATTACKER-TEMPLATE"}      decoy reached: true
  //   fixed:    {"notFound":"loom-links: not-configured…"}   decoy reached: false
  // The only channel from this process to that child is the inherited env, so
  // the `env:` below is what closes it.
  //
  // `HOME` is deliberately ABSENT, and that costs nothing here — measured:
  //   $ env -i node -e 'console.log(os.homedir())'   ->  /Users/esperie
  // Node's `os.homedir()` falls back to the passwd database when `HOME` is
  // unset, so the LEGITIMATE `~/.claude/loom-links.local.json` is still found,
  // while a redirected `HOME` (which `os.homedir()` WOULD honour — measured:
  // `HOME=/tmp/evil` → `/tmp/evil`) can no longer relocate the config. Same
  // shape as the OpenSSH finding behind `gitNetEnv()`.
  //
  // An allowlist, not a denylist, for the reason the git helper gives: a
  // denylist here would be permanently one variable behind — `LOOM_LINKS_CONFIG`
  // and `LOOM_COC_ROLE_MARKER` (`loom-links.mjs:247`) are simply the two we know
  // about today.
  const shim =
    `import { resolveRepo } from ${JSON.stringify(LOOM_LINKS_MJS)};` +
    `const r = resolveRepo(${JSON.stringify(logicalKey)}, { require: false });` +
    `process.stdout.write(JSON.stringify(r));`;
  try {
    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", shim],
      {
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf8",
        env: _shimEnv(),
      },
    );
    const r = JSON.parse(out);
    if (r && r.skipped) {
      return { notFound: `loom-links: ${r.reason}` };
    }
    if (r && r.kind === "path" && typeof r.value === "string") {
      return { path: r.value };
    }
    if (r && r.kind === "url") {
      return {
        notFound:
          `loom-links key "${logicalKey}" is a git URL, not a local path ` +
          `(offline sibling needs a local checkout)`,
      };
    }
    return { notFound: `loom-links returned an unrecognized result` };
  } catch (e) {
    return { notFound: `loom-links resolver invocation failed: ${e.message}` };
  }
}

const CACHE_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE,
  ".cache",
  "kailash-coc",
);

const KNOWN_TEMPLATES = {
  "kailash-coc-claude-py": "terrene-foundation/kailash-coc-claude-py",
  "kailash-coc-claude-rs": "terrene-foundation/kailash-coc-claude-rs",
  "kailash-coc-claude-rb": "terrene-foundation/kailash-coc-claude-rb",
  "kailash-coc-claude-prism": "terrene-foundation/kailash-coc-claude-prism",
  "kailash-coc-py": "terrene-foundation/kailash-coc-py",
  "kailash-coc-rs": "terrene-foundation/kailash-coc-rs",
  // base family (stack-agnostic Foundation templates, NO kailash- prefix)
  "coc-base": "terrene-foundation/coc-base",
  "coc-claude-base": "terrene-foundation/coc-claude-base",
};

/**
 * Resolve the USE template for a downstream project.
 * @param {string} cwd - project root directory
 * @returns {{ path: string, source: string, fresh: boolean } | { error: string }}
 */
function resolveTemplate(cwd) {
  const versionPath = path.join(cwd, ".claude", "VERSION");
  if (!fs.existsSync(versionPath)) {
    return {
      error:
        "No .claude/VERSION file found. Run a session first to auto-create it.",
    };
  }

  let version;
  try {
    version = JSON.parse(fs.readFileSync(versionPath, "utf8"));
  } catch (e) {
    return { error: `Failed to parse .claude/VERSION: ${e.message}` };
  }

  const upstream = version.upstream || {};
  const templateName = upstream.template;
  const templateRepo = upstream.template_repo;

  if (!templateName || templateName === "unknown") {
    return {
      error:
        'No upstream.template in .claude/VERSION (or set to "unknown"). ' +
        "Set it to the template name, e.g.: " +
        '"template": "kailash-coc-claude-py"',
    };
  }

  return resolveTemplateByName(templateName, templateRepo, cwd);
}

/**
 * Resolve a template BY NAME through the full chain (env override → cache →
 * clone → offline sibling), independent of any project's .claude/VERSION.
 * This is the lane `/migrate` needs: resolve a SPECIFIC named sister template
 * (the multi-CLI sister, or the CC-only sister under --cc-only), NOT the
 * template the current repo's VERSION points at (which for a cc-only-legacy
 * repo is the wrong template, and for a bare --adopt repo does not exist yet).
 * @param {string} templateName
 * @param {string} [templateRepo] owner/repo slug; falls back to KNOWN_TEMPLATES
 * @param {string} [cwd] caller cwd; only used to avoid returning cwd as its own sibling
 * @returns {{ path: string, source: string, fresh: boolean } | { error: string }}
 */
function resolveTemplateByName(templateName, templateRepo, cwd) {
  if (!templateName || templateName === "unknown") {
    return { error: "resolveTemplateByName requires a concrete template name" };
  }
  // Path-traversal guard: templateName is joined into the cache path
  // (`path.join(CACHE_DIR, templateName)`) which updateCachedClone() then
  // `git reset --hard`s. A crafted `../../repo` could escape the cache dir onto
  // an arbitrary local checkout — reject separators / `..` (template names are
  // bare slugs like `kailash-coc-py` / `coc-base`).
  if (/[/\\]/.test(templateName) || templateName.includes("..")) {
    return {
      error: `invalid template name (path separators / ".." not allowed): ${templateName}`,
    };
  }
  cwd = cwd || process.cwd();

  // 1. Explicit developer escape hatch via env var.
  const envOverride = process.env.KAILASH_COC_TEMPLATE_PATH;
  if (envOverride) {
    if (fs.existsSync(path.join(envOverride, ".claude"))) {
      return { path: envOverride, source: "env-override", fresh: true };
    }
    console.error(
      `[TEMPLATE] KAILASH_COC_TEMPLATE_PATH=${envOverride} does not contain .claude/ — ignoring.`,
    );
  }

  // Detect (but do NOT use) any local sibling so we can emit a one-line
  // notice if the user has a stale clone they may not realize is being
  // bypassed. This is a UX nudge, not a fallback.
  const sibling = findLocalSibling(cwd, templateName);
  if (sibling && !envOverride) {
    console.error(
      `[TEMPLATE] Found local clone at ${sibling} but using GitHub-backed cache for freshness. ` +
        `To use the local clone instead, set KAILASH_COC_TEMPLATE_PATH=${sibling}.`,
    );
  }

  // 2. Cache hit — refresh from origin/main and use.
  const cachePath = path.join(CACHE_DIR, templateName);
  if (fs.existsSync(path.join(cachePath, ".claude"))) {
    const updated = updateCachedClone(cachePath);
    if (updated) {
      return { path: cachePath, source: "cache", fresh: true };
    }
    // Cache exists but fetch failed (offline). Fall through to clone retry,
    // and ultimately to the offline-sibling fallback if the network really is down.
    console.error(
      `[TEMPLATE] Cache fetch failed; trying fresh clone, then offline fallback.`,
    );
  }

  // 3. Shallow clone to cache.
  const repoSlug = templateRepo || KNOWN_TEMPLATES[templateName];
  // loom#1471 F-3. A VERSION-supplied slug that is not one of the templates we
  // ship is legitimate (client forks re-point it), so this WARNS rather than
  // refuses — but it must not pass silently: this is the value that decides
  // which repository becomes the authoritative template for this consumer.
  // Well-formedness is enforced fail-closed at the sink (isValidRepoSlug).
  if (repoSlug && templateRepo && !Object.values(KNOWN_TEMPLATES).includes(repoSlug)) {
    console.error(
      `[TEMPLATE] NOTE: cloning '${repoSlug}', which is NOT a known Foundation template. ` +
        `It comes from upstream.template_repo in .claude/VERSION. If you did not set it, ` +
        `stop and check that file (loom#1471 F-3).`,
    );
  }
  if (repoSlug) {
    const cloned = cloneToCache(repoSlug, cachePath);
    if (cloned) {
      return { path: cachePath, source: "cloned", fresh: true };
    }
  }

  // 4. Last-resort offline fallback: use the local sibling if one exists.
  // This is reached ONLY if every network path above failed.
  if (sibling) {
    console.error(
      `[TEMPLATE] Network unreachable. Falling back to local sibling at ${sibling} ` +
        `— freshness NOT guaranteed. Run \`git -C ${sibling} pull\` if you suspect it's stale.`,
    );
    return { path: sibling, source: "sibling-offline-fallback", fresh: false };
  }

  return {
    error:
      `Failed to resolve template "${templateName}". Tried env override (KAILASH_COC_TEMPLATE_PATH), ` +
      `GitHub-backed cache at ${cachePath}, ` +
      (repoSlug
        ? `shallow clone from github.com/${repoSlug}, `
        : `(no template_repo in VERSION and no known slug for "${templateName}"), `) +
      `and offline sibling lookup. Check network connectivity, repo access, and that ` +
      `upstream.template_repo is set in .claude/VERSION.`,
  };
}

/**
 * The explicit minimal environment for the `loom-links` node shim.
 *
 * Built from constants like `gitEnv()`, and for the same reason: nothing is
 * inherited, so the config-steering class is closed by construction rather
 * than enumerated. See the call site for the measured `HOME` rationale.
 */
function _shimEnv() {
  const env = { PATH: "/usr/bin:/bin", LC_ALL: "C" };
  if (process.platform === "win32") {
    const amb = process.env.SystemRoot || process.env.SYSTEMROOT;
    const sysRoot =
      typeof amb === "string" && path.isAbsolute(amb) ? amb : "C:\\Windows";
    env.SystemRoot = sysRoot;
    env.PATH = `${sysRoot}\\System32;${sysRoot}`;
    // node resolves the user profile from these on Windows, where there is no
    // passwd-database fallback for `os.homedir()`. They cannot relocate the
    // linkage config the way `LOOM_LINKS_CONFIG` can, but record the residual.
    for (const k of ["COMSPEC", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"]) {
      if (typeof process.env[k] === "string") env[k] = process.env[k];
    }
  }
  return env;
}

/**
 * Resolve the template as a local sibling directory.
 * Used ONLY for the detection notice (step 1 nudge) and the offline fallback
 * (step 4). Never used as the default resolution path online.
 *
 * The path is resolved through the shared loom-links resolver
 * (`../../bin/lib/loom-links.mjs`) via the `use-template.<key>` logical key —
 * NOT by guessing positional layouts. When no linkage is declared (or no
 * config exists), this returns null with an explicit stderr reason rather
 * than silently guessing `~/repos/<tmpl>` / `../<tmpl>`: an undeclared
 * linkage is "not found", not "search harder".
 *
 * @returns {string|null} the linked sibling path, or null when no linkage
 *   is declared / the linked path is absent on disk.
 */
function findLocalSibling(cwd, templateName) {
  const r = resolveSiblingViaLinks(templateName);
  if (r.notFound) {
    // Explicit not-found. The resolver — not a positional guess — is the
    // canonical NAME→location binding; an absent linkage is a clear signal,
    // not a prompt to fall back to `~/repos/<tmpl>`.
    console.error(
      `[TEMPLATE] No offline sibling linkage for "${templateName}": ${r.notFound}. ` +
        `Declare it in loom-links.local.json under "${TEMPLATE_LINK_KEYS[templateName] || "use-template.<key>"}" ` +
        `(or set KAILASH_COC_TEMPLATE_PATH) — loom no longer guesses sibling paths positionally.`,
    );
    return null;
  }
  const candidate = r.path;
  // The linkage may point at a path that doesn't exist on this machine
  // (operator declared it but hasn't checked it out). That is still a
  // not-found for sibling purposes — but loud, not a positional retry.
  if (fs.existsSync(path.join(candidate, ".claude")) && candidate !== cwd) {
    return candidate;
  }
  console.error(
    `[TEMPLATE] loom-links resolved "${templateName}" → ${candidate} but no .claude/ ` +
      `exists there (linkage declared, checkout missing). Not used as offline sibling.`,
  );
  return null;
}

/**
 * Fetch latest from origin/main in an existing cached clone.
 */
function updateCachedClone(cachePath) {
  // loom#1471 shard 3. Both calls passed no `env:`, so the child inherited the
  // ambient environment and `GIT_DIR` outranks repository discovery — `-C` chose
  // a directory, not a repository. The `reset --hard` is the sharp end: steered,
  // it hard-resets a repository the attacker names, and `--hard` discards
  // unstaged work with no reflog.
  //
  // The two calls do NOT get the same profile, deliberately. `fetch` talks to a
  // remote and needs the host's egress config (gitNetEnv); `reset --hard` is
  // purely local and has no business seeing proxy or agent credentials, so it
  // stays on the strict base profile. Least privilege per CALL, not per file.
  const gitBin = resolveGitBinary();
  if (!gitBin) {
    // Unresolvable git is INDETERMINATE, never a silent success. Returning false
    // routes to the caller's existing fallback chain (clone, then offline
    // sibling) rather than reporting a cache that was never refreshed as fresh.
    console.error(
      "[TEMPLATE] No git binary resolved; cache update is INDETERMINATE, not successful.",
    );
    return false;
  }
  try {
    execFileSync(
      gitBin,
      ["-C", cachePath, "fetch", "--depth", "1", "origin", "main"],
      { timeout: 15000, stdio: ["pipe", "pipe", "pipe"], env: gitNetEnv() },
    );
    execFileSync(gitBin, ["-C", cachePath, "reset", "--hard", "origin/main"], {
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
      env: gitEnv(),
    });
    return true;
  } catch (e) {
    console.error(`[TEMPLATE] Cache update failed: ${e.message}`);
    return false;
  }
}

/**
 * Shallow clone a template repo to the cache directory.
 */
/**
 * `owner/repo`, and nothing else.
 *
 * loom#1471 round-3 F-3. `templateName` is path-traversal-guarded before it can
 * pick a cache directory, but `repoSlug` reached the clone URL with NO
 * validation at all — and it does not come from the environment, it comes from
 * `upstream.template_repo` in `.claude/VERSION`. That file's
 * `guard-path-scope.js` registry row carries `surfaces: {bash, layer3}` and no
 * `direct`, so the Bash lane is fenced and the Edit/Write tool lane is not: an
 * Edit to `.claude/VERSION` re-points the next `/sync-from-template` clone at
 * an attacker's repository, and `/sync-from-template` then adopts that cache as
 * the authoritative template. It is the same destination the
 * `KAILASH_COC_TEMPLATE_PATH` deny-set entry fences, reached through a FILE
 * rather than an env var — so the env fence never sees it.
 *
 * Checked HERE, at the sink, rather than at the one call site: `cloneToCache`
 * is also exported, so a caller outside this module reaches the same URL
 * construction (`rules/security.md` § Enforcement-Surface Parity — one shared
 * function, every surface).
 *
 * Both halves must START alphanumeric, which is GitHub's own rule and also
 * keeps a leading `-` out of the URL. `..` is rejected explicitly rather than
 * left to the character class, which permits `.`.
 *
 * NOT a claim that the slug is trustworthy — only that it is a well-formed
 * `owner/repo`. A syntactically valid slug naming an attacker's repository
 * still clones; the KNOWN_TEMPLATES warning at the selection site is what
 * surfaces that, and the durable fix is the `direct` surface on the registry
 * row (recorded, not closed here — it is a documented ergonomics decision that
 * predates `template_repo` becoming a clone target).
 */
const REPO_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function isValidRepoSlug(slug) {
  return (
    typeof slug === "string" &&
    slug.length <= 200 &&
    !slug.includes("..") &&
    REPO_SLUG_RE.test(slug)
  );
}

function cloneToCache(repoSlug, cachePath) {
  // Fail CLOSED: an unparseable slug is not cloned at all. The caller's next
  // step is the offline-sibling fallback, which is the correct degraded state.
  if (!isValidRepoSlug(repoSlug)) {
    console.error(
      `[TEMPLATE] REFUSING to clone: '${repoSlug}' is not a well-formed owner/repo slug. ` +
        `Check upstream.template_repo in .claude/VERSION (loom#1471 F-3).`,
    );
    return null;
  }
  const httpsUrl = `https://github.com/${repoSlug}.git`;
  const sshUrl = `git@github.com:${repoSlug}.git`;
  const cloneArgs = [
    "clone",
    "--depth",
    "1",
    "--single-branch",
    "--branch",
    "main",
  ];

  fs.mkdirSync(path.dirname(cachePath), { recursive: true });

  // loom#1471 shard 3. Both clones inherited the ambient environment. The
  // consequence here is not a mis-read: this function WRITES the cache that
  // `/sync-from-template` then treats as the authoritative template, so a
  // steered clone plants the artifacts a consumer repo goes on to adopt.
  // `gitNetEnv()` keeps every repo-redirect denial from the base profile and
  // adds only validated transport DATA (proxy, TLS anchors, agent socket) —
  // never the variables git EXECUTES (GIT_SSH_COMMAND et al).
  const gitBin = resolveGitBinary();
  if (!gitBin) {
    console.error(
      "[TEMPLATE] No git binary resolved; refusing to clone into the cache " +
        "(INDETERMINATE, never reported as a successful clone).",
    );
    return false;
  }

  try {
    execFileSync(gitBin, [...cloneArgs, httpsUrl, cachePath], {
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
      env: gitNetEnv(),
    });
    return true;
  } catch (httpsErr) {
    try {
      execFileSync(gitBin, [...cloneArgs, sshUrl, cachePath], {
        timeout: 30000,
        stdio: ["pipe", "pipe", "pipe"],
        env: gitNetEnv(),
      });
      return true;
    } catch (sshErr) {
      console.error(
        `[TEMPLATE] Clone failed — HTTPS: ${httpsErr.message}, SSH: ${sshErr.message}`,
      );
      return false;
    }
  }
}

module.exports = {
  resolveTemplate,
  resolveTemplateByName,
  resolveSiblingViaLinks,
  findLocalSibling,
  updateCachedClone,
  cloneToCache,
  isValidRepoSlug,
  KNOWN_TEMPLATES,
  CACHE_DIR,
};
