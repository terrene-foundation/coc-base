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
// The resolver vocabulary is `use-template.{py,rs,rb,claude-py,claude-rs,
// claude-rb}` (see bin/loom-links.local.example.json). Anything not in this
// map has no linkage key and resolves to an explicit not-found.
const TEMPLATE_LINK_KEYS = {
  "kailash-coc-claude-py": "use-template.claude-py",
  "kailash-coc-claude-rs": "use-template.claude-rs",
  "kailash-coc-claude-rb": "use-template.claude-rb",
  "kailash-coc-py": "use-template.py",
  "kailash-coc-rs": "use-template.rs",
  "kailash-coc-claude-prism": "use-template.prism",
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
  try {
    execFileSync(
      "git",
      ["-C", cachePath, "fetch", "--depth", "1", "origin", "main"],
      { timeout: 15000, stdio: ["pipe", "pipe", "pipe"] },
    );
    execFileSync("git", ["-C", cachePath, "reset", "--hard", "origin/main"], {
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
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
function cloneToCache(repoSlug, cachePath) {
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

  try {
    execFileSync("git", [...cloneArgs, httpsUrl, cachePath], {
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch (httpsErr) {
    try {
      execFileSync("git", [...cloneArgs, sshUrl, cachePath], {
        timeout: 30000,
        stdio: ["pipe", "pipe", "pipe"],
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
  findLocalSibling,
  updateCachedClone,
  cloneToCache,
  KNOWN_TEMPLATES,
  CACHE_DIR,
};
