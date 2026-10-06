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
const { resolveGitBinary, gitEnv } = require("./git-subprocess-env.js");

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

// loom#1471 (s49). LOCAL profile — `describe` and `rev-list` against a
// repository already on disk. `-C cwd` chose a DIRECTORY, so an ambient
// `GIT_DIR` decided which repository's tags answered the drift question, and a
// decoy repo's tag makes a drifted release look current.
//
// THROWS on an unresolved binary rather than returning a value: this wrapper's
// existing contract is to throw (callers wrap it in try/catch and treat a throw
// as "no answer"), so a `null` return would be read as a real tag by code that
// never expected one.
function git(cwd, args, timeoutMs = 2000) {
  const gitBin = resolveGitBinary();
  if (!gitBin) {
    throw new Error(
      "release-drift: no git binary resolved; version drift is INDETERMINATE",
    );
  }
  return execFileSync(gitBin, ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["pipe", "pipe", "pipe"],
    env: gitEnv(),
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

/**
 * Count commits between `tag` and HEAD for a package path.
 *
 * Returns `null` — NEVER 0 — when git could not answer (non-zero exit, timeout,
 * unparseable output). 0 is a real measurement meaning "nothing since the tag";
 * `null` means "no measurement was obtained". Collapsing the second into the
 * first is what made a failed `git rev-list` render as no drift at all: the
 * caller drops any package at 0, so an unanswerable count disappeared from the
 * report entirely, and no output of this module could have falsified "clean"
 * (instrument-discipline.md MUST-1).
 *
 * @returns {number|null}
 */
function commitsSince(cwd, tag, pkgPath) {
  try {
    const args =
      pkgPath === "."
        ? ["rev-list", "--count", `${tag}..HEAD`]
        : ["rev-list", "--count", `${tag}..HEAD`, "--", pkgPath];
    const count = git(cwd, args);
    const parsed = parseInt(count, 10);
    // Unparseable output is not a count — it is the absence of one.
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null; // git could not answer — UNKNOWN, never "zero commits"
  }
}

/**
 * @param {string} cwd - project root
 * @returns {Array<{name, current_version, last_tag, commits_since_tag, path,
 *   count_unavailable?: boolean}>}
 *   Empty array when no packages, no tags, or nothing to release.
 *   A row with `count_unavailable: true` carries `commits_since_tag: null` —
 *   git could not answer for that package, so its release status is UNKNOWN
 *   and the row is reported rather than dropped. Consumers MUST render it as
 *   unknown, never as a numeric count and never as clean
 *   (see hooks/session-start.js::checkReleaseDrift).
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
    if (commits === null) {
      // git could not answer. Report the package as UNKNOWN rather than
      // dropping it — a dropped package is indistinguishable from a released
      // one in the rendered output, which is the fail-open this branch exists
      // to close. The consumer renders the unknown explicitly.
      unreleased.push({
        name: pkg.name,
        current_version: pkg.version,
        last_tag: latestTag,
        commits_since_tag: null,
        count_unavailable: true,
        path: pkg.path,
      });
      continue;
    }
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
