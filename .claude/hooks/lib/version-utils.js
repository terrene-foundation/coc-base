/**
 * Version tracking utilities for CO/COC artifact ecosystem.
 *
 * Each repo has a .claude/VERSION file (JSON) with type-specific fields:
 *   - coc-source:        version, no upstream (loom/)
 *   - coc-use-template:  upstream.build_version (coc-claude-py, coc-claude-rs)
 *   - coc-build:         upstream.build_version (kailash-py, kailash-rs)
 *   - coc-project:       upstream.template_version (downstream projects)
 *
 * The session-start hook calls checkVersion() to:
 *   1. Read local VERSION (auto-create if missing with detected type)
 *   2. Source repos: report source status
 *   3. Template/BUILD repos: display tracked build version info (no fetch)
 *   4. Downstream projects: display tracked template version info (no fetch)
 *   5. Legacy repos with version_url: fetch remote and compare
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

/**
 * Read the local .claude/VERSION file.
 * @param {string} cwd - project root
 * @returns {object|null} parsed VERSION or null if missing
 */
function readLocalVersion(cwd) {
  const versionPath = path.join(cwd, ".claude", "VERSION");
  try {
    const content = fs.readFileSync(versionPath, "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Fetch upstream VERSION from GitHub (via curl, no dependencies).
 * Times out after 3 seconds to avoid blocking session start.
 * @param {string} url - raw GitHub URL to VERSION file
 * @returns {object|null} parsed remote VERSION or null on failure
 */
function fetchUpstreamVersion(url) {
  if (!url) return null;
  try {
    const result = execFileSync("curl", ["-sf", "--max-time", "3", url], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(result);
  } catch {
    return null;
  }
}

/**
 * Compare local tracked upstream version vs actual remote version.
 * @param {object} local - local VERSION object
 * @param {object} remote - remote VERSION object (fetched from GitHub)
 * @returns {object} { status, message, localVersion, remoteVersion, changelog }
 *   status: "current" | "update-available" | "unknown"
 */
function compareVersions(local, remote) {
  if (!local || !local.upstream) {
    return { status: "source", message: "This is a source repo (no upstream)" };
  }

  if (!remote) {
    return {
      status: "unknown",
      message: `Could not reach upstream (${local.upstream.name}). Offline or repo not public.`,
      localVersion: local.version,
      trackedUpstream: local.upstream.version,
    };
  }

  const tracked = local.upstream.version;
  const actual = remote.version;

  if (tracked === actual) {
    return {
      status: "current",
      message: `Artifacts current with ${local.upstream.name} v${actual}`,
      localVersion: local.version,
      trackedUpstream: tracked,
    };
  }

  // Find changelog entries newer than what we track
  const newEntries = (remote.changelog || []).filter((entry) => {
    return entry.version !== tracked && isNewer(entry.version, tracked);
  });

  const changeSummary = newEntries
    .map((e) => `  v${e.version} (${e.date}): ${e.summary}`)
    .join("\n");

  return {
    status: "update-available",
    message: `Update available: ${local.upstream.name} v${tracked} → v${actual}`,
    localVersion: local.version,
    trackedUpstream: tracked,
    remoteVersion: actual,
    changelog: changeSummary || `  v${actual}: (no changelog details)`,
  };
}

/**
 * Simple semver comparison: is a newer than b?
 * Returns false for missing/malformed inputs (NaN guard).
 */
function isNewer(a, b) {
  if (!a || !b || typeof a !== "string" || typeof b !== "string") return false;
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const ai = pa[i];
    const bi = pb[i];
    if (Number.isNaN(ai) || Number.isNaN(bi)) return false;
    if ((ai || 0) > (bi || 0)) return true;
    if ((ai || 0) < (bi || 0)) return false;
  }
  return false;
}

/**
 * Detect repo type for bootstrap based on directory structure.
 * @param {string} cwd - project root
 * @returns {string} "coc-build" | "coc-project"
 */
function detectRepoType(cwd) {
  const hasPyproject = fs.existsSync(path.join(cwd, "pyproject.toml"));
  const hasCargo = fs.existsSync(path.join(cwd, "Cargo.toml"));
  const hasPackages = fs.existsSync(path.join(cwd, "packages"));
  const hasSrc = fs.existsSync(path.join(cwd, "src"));

  if ((hasPackages || hasSrc) && (hasPyproject || hasCargo)) {
    return "coc-build";
  }
  return "coc-project";
}

/**
 * Main entry point for session-start hook.
 * @param {string} cwd - project root
 * @returns {object} { status, messages[] } for stderr output
 */
function checkVersion(cwd) {
  let local = readLocalVersion(cwd);
  if (!local) {
    // Auto-create VERSION if .claude/ exists but VERSION doesn't (per 08-versioning.md)
    const claudeDir = path.join(cwd, ".claude");
    if (fs.existsSync(claudeDir)) {
      const detectedType = detectRepoType(cwd);
      const bootstrapped = {
        version: "0.0.0",
        type: detectedType,
        updated: new Date().toISOString().split("T")[0],
        description:
          "Auto-created — run /sync to pull latest template artifacts",
        upstream:
          detectedType === "coc-build"
            ? {
                source: "unknown",
                build_version: "0.0.0",
                synced_at: null,
              }
            : {
                template: "unknown",
                template_version: "0.0.0",
                synced_at: null,
              },
      };
      const versionPath = path.join(claudeDir, "VERSION");
      try {
        fs.writeFileSync(
          versionPath,
          JSON.stringify(bootstrapped, null, 2) + "\n",
        );
        local = bootstrapped;
        return {
          status: "bootstrapped",
          messages: [
            `[VERSION] Created initial VERSION file (v0.0.0, type: ${detectedType})`,
            "[VERSION] Run /sync to pull latest template artifacts",
          ],
        };
      } catch {
        return { status: "no-version", messages: [] };
      }
    }
    return { status: "no-version", messages: [] };
  }

  const messages = [
    `[VERSION] ${local.description || local.type} v${local.version}`,
  ];

  const repoType = local.type || "coc-project";
  const upstream = local.upstream || {};

  // --- Source repos: fetch remote, compare ---
  if (repoType === "coc-source" || !local.upstream) {
    if (!local.upstream) {
      messages.push("[VERSION] Source repo — no upstream to check");
    } else {
      messages.push("[VERSION] Source repo (coc-source)");
    }
    return { status: "source", messages };
  }

  // --- USE template / BUILD repos: display tracked version info ---
  // But first: detect if this is a template-derived repo that needs correction.
  // When a user creates a repo via "Use this template" on GitHub, they inherit
  // the template's VERSION with type "coc-use-template" — but their repo is
  // actually a downstream project (coc-project).
  if (repoType === "coc-use-template" || repoType === "coc-build") {
    if (repoType === "coc-use-template" && !isActualTemplateRepo(cwd)) {
      const corrected = correctTemplateDerivedVersion(cwd, local);
      if (corrected) {
        messages.push(
          `[VERSION] ⚠ Auto-corrected: this repo was created from a USE template but is a downstream project`,
        );
        messages.push(
          `[VERSION] Type changed to coc-project, template set to ${corrected.upstream.template}. Run /sync to update.`,
        );
        return { status: "corrected", messages };
      }
    }
    const buildVer = upstream.build_version || "unknown";
    const syncedAt = upstream.synced_at ? ` synced ${upstream.synced_at}` : "";
    messages.push(
      `[VERSION] COC artifacts from loom v${local.version}, build v${buildVer}${syncedAt}`,
    );
    return { status: "tracked", messages };
  }

  // --- Downstream projects: display template tracking info ---
  if (repoType === "coc-project") {
    const tmpl = upstream.template || "unknown";
    const tmplVer = upstream.template_version || "unknown";
    const syncedAt = upstream.synced_at ? `, synced ${upstream.synced_at}` : "";
    messages.push(
      `[VERSION] COC from template ${tmpl}, v${tmplVer}${syncedAt}`,
    );
    if (tmpl === "unknown") {
      messages.push(
        `[VERSION] ⚠ Template unknown — set upstream.template in .claude/VERSION (e.g., "kailash-coc-claude-py") then run /sync`,
      );
    }
    return { status: "tracked", messages };
  }

  // --- Fallback: legacy repos with upstream.version_url (source-style fetch) ---
  const remote = fetchUpstreamVersion(upstream.version_url);
  const result = compareVersions(local, remote);

  if (result.status === "current") {
    messages.push(`[VERSION] ${result.message}`);
  } else if (result.status === "update-available") {
    messages.push(`[VERSION] ⚠ ${result.message}`);
    messages.push("[VERSION] Changes:");
    messages.push(result.changelog);
    messages.push("[VERSION] Run /sync to update artifacts");
  } else {
    messages.push(`[VERSION] ${result.message}`);
  }

  return { status: result.status, messages };
}

/**
 * Known USE template repos — GitHub slugs that ARE actual templates.
 * If a repo's git remote matches one of these, it's the real template,
 * not a downstream project created from it.
 */
const KNOWN_TEMPLATE_REPOS = {
  "terrene-foundation/kailash-coc-claude-py": "kailash-coc-claude-py",
  "terrene-foundation/kailash-coc-claude-rs": "kailash-coc-claude-rs",
  "terrene-foundation/kailash-coc-claude-rb": "kailash-coc-claude-rb",
  "terrene-foundation/kailash-coc-claude-prism": "kailash-coc-claude-prism",
};

/**
 * Check if this repo is actually a USE template repo (not just derived from one).
 * Checks directory name (monorepo safeguard) and git remote origin.
 */
function isActualTemplateRepo(cwd) {
  const dirName = path.basename(cwd);
  if (Object.values(KNOWN_TEMPLATE_REPOS).includes(dirName)) {
    return true;
  }
  try {
    let remote = execFileSync(
      "git",
      ["-C", cwd, "remote", "get-url", "origin"],
      { encoding: "utf8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    // Normalize SSH URLs: git@github.com:owner/repo.git → owner/repo
    if (remote.startsWith("git@")) {
      remote = (remote.split(":")[1] || "").replace(/\.git$/, "");
    }
    for (const slug of Object.keys(KNOWN_TEMPLATE_REPOS)) {
      if (remote.includes(slug)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Auto-correct a VERSION file that was inherited from a USE template.
 * Converts coc-use-template → coc-project with proper upstream fields.
 * Returns the corrected version object, or null on failure.
 */
function correctTemplateDerivedVersion(cwd, original) {
  const templateName = guessTemplateName(cwd, original);
  const templateSlug = templateName
    ? Object.entries(KNOWN_TEMPLATE_REPOS).find(
        ([, name]) => name === templateName,
      )?.[0] || null
    : null;

  const corrected = {
    version: original.version || "0.0.0",
    type: "coc-project",
    description: original.description
      ? original.description.replace(/USE template/i, "downstream project")
      : "Downstream project (auto-corrected from template)",
    updated: new Date().toISOString().split("T")[0],
    upstream: {
      template: templateName || "unknown",
      template_repo: templateSlug || null,
      template_version: original.version || "0.0.0",
      synced_at: (original.upstream || {}).synced_at || null,
      sdk_packages: (original.upstream || {}).sdk_packages || {},
    },
  };

  const versionPath = path.join(cwd, ".claude", "VERSION");
  try {
    fs.writeFileSync(versionPath, JSON.stringify(corrected, null, 2) + "\n");
    return corrected;
  } catch (e) {
    console.error(`[VERSION] Failed to write corrected VERSION: ${e.message}`);
    return null;
  }
}

/**
 * Guess which template this repo was derived from.
 * Uses the variant field or upstream.name from the original VERSION.
 */
function guessTemplateName(cwd, original) {
  const variant = original.variant;
  if (variant) {
    return `kailash-coc-claude-${variant}`;
  }
  // Check git remote for template repo name hints
  try {
    const remote = execFileSync(
      "git",
      ["-C", cwd, "remote", "get-url", "origin"],
      { encoding: "utf8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    // Check if the repo was CREATED from a template — git initial commit
    // may reference the template. Also check first commit message.
  } catch {}
  // Check description — but "Rust-backed" bindings means rs template,
  // even though "Python/Ruby" appears first in the description.
  const desc = (original.description || "").toLowerCase();
  if (
    desc.includes("rust-backed") ||
    desc.includes("kailash-rs") ||
    desc.includes("rs bindings")
  ) {
    return "kailash-coc-claude-rs";
  }
  if (desc.includes("prism") || desc.includes("composable")) {
    return "kailash-coc-claude-prism";
  }
  if (desc.includes("ruby") && !desc.includes("rust")) {
    return "kailash-coc-claude-rb";
  }
  if (desc.includes("python") || desc.includes("-py")) {
    return "kailash-coc-claude-py";
  }
  // Check upstream.name or upstream.source
  const upstreamName = (original.upstream || {}).name || "";
  if (upstreamName) {
    return "kailash-coc-claude-py";
  }
  return null;
}

module.exports = {
  readLocalVersion,
  fetchUpstreamVersion,
  compareVersions,
  checkVersion,
  detectRepoType,
  isActualTemplateRepo,
  correctTemplateDerivedVersion,
};
