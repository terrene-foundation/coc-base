/**
 * Release drift detection for BUILD repos with Python packages.
 *
 * Scans pyproject.toml files in the repo root and packages/, finds the
 * latest matching git tag per package, and reports packages with commits
 * since that tag. Used by session-start and /wrapup to surface release
 * backlogs before the next session or before ending the current session.
 *
 * Tag patterns tried (in order):
 *   - 'v*' (root package only, e.g. v2.8.5)
 *   - '<shortname>-v*' (e.g. dataflow-v2.0.7)
 *   - '<full-name>-v*' (e.g. kailash-dataflow-v2.0.7)
 * Shortname = package name with leading "kailash-" stripped.
 *
 * Silent when no packages OR no matching tags exist — does not flag
 * downstream projects or non-package repos.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function readPyproject(pyprojectPath) {
  try {
    const content = fs.readFileSync(pyprojectPath, "utf8");
    const nameMatch = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
    const versionMatch = content.match(/^\s*version\s*=\s*"([^"]+)"/m);
    if (!nameMatch || !versionMatch) return null;
    return { name: nameMatch[1], version: versionMatch[1] };
  } catch {
    return null;
  }
}

function findPackages(cwd) {
  const packages = [];

  const rootPyproject = path.join(cwd, "pyproject.toml");
  if (fs.existsSync(rootPyproject)) {
    const info = readPyproject(rootPyproject);
    if (info) packages.push({ ...info, path: "." });
  }

  const packagesDir = path.join(cwd, "packages");
  if (fs.existsSync(packagesDir)) {
    try {
      for (const sub of fs.readdirSync(packagesDir)) {
        const subPyproject = path.join(packagesDir, sub, "pyproject.toml");
        if (fs.existsSync(subPyproject)) {
          const info = readPyproject(subPyproject);
          if (info) packages.push({ ...info, path: `packages/${sub}` });
        }
      }
    } catch {}
  }

  return packages;
}

function git(cwd, args, timeoutMs = 2000) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function latestTagMatching(cwd, patterns) {
  for (const pattern of patterns) {
    try {
      const tag = git(cwd, [
        "describe",
        "--tags",
        "--abbrev=0",
        "--match",
        pattern,
        "HEAD",
      ]);
      if (tag) return tag;
    } catch {}
  }
  return null;
}

function commitsSince(cwd, tag, pkgPath) {
  try {
    const args =
      pkgPath === "."
        ? ["rev-list", "--count", `${tag}..HEAD`]
        : ["rev-list", "--count", `${tag}..HEAD`, "--", pkgPath];
    const count = git(cwd, args);
    return parseInt(count, 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * @param {string} cwd - project root
 * @returns {Array<{name, current_version, last_tag, commits_since_tag, path}>}
 *   Empty array when no packages, no tags, or nothing to release.
 */
function detectUnreleasedPackages(cwd) {
  const packages = findPackages(cwd);
  if (packages.length === 0) return [];

  const unreleased = [];

  for (const pkg of packages) {
    const shortname = pkg.name.replace(/^kailash-/, "");
    const patterns = [
      pkg.path === "." ? "v*" : null,
      `${shortname}-v*`,
      `${pkg.name}-v*`,
    ].filter(Boolean);

    const latestTag = latestTagMatching(cwd, patterns);
    if (!latestTag) continue; // repo doesn't tag this package — silent

    const commits = commitsSince(cwd, latestTag, pkg.path);
    if (commits > 0) {
      unreleased.push({
        name: pkg.name,
        current_version: pkg.version,
        last_tag: latestTag,
        commits_since_tag: commits,
        path: pkg.path,
      });
    }
  }

  return unreleased;
}

module.exports = { detectUnreleasedPackages, findPackages };
