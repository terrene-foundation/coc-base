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
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

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
 * Search for the template as a local directory.
 * Used ONLY for the detection notice (step 1 nudge) and the offline fallback
 * (step 4). Never used as the default resolution path online.
 */
function findLocalSibling(cwd, templateName) {
  const candidates = [];

  candidates.push(path.join(path.dirname(cwd), templateName));

  const parent = path.dirname(cwd);
  candidates.push(path.join(parent, "loom", templateName));

  const home = process.env.HOME || process.env.USERPROFILE;
  candidates.push(path.join(home, "repos", "loom", templateName));
  candidates.push(path.join(home, "repos", templateName));

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, ".claude")) && candidate !== cwd) {
      return candidate;
    }
  }

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
