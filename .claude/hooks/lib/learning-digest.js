#!/usr/bin/env node
/**
 * Digest Builder for Learning System
 *
 * Replaces the instinct-processor + instinct-evolver pipeline.
 * Reads observations.jsonl and produces learning-digest.json — a structured
 * summary consumed by /codify where the LLM does semantic analysis.
 *
 * Groups typed observations and computes counts without confidence scoring.
 * Source: buildDigest/getStats, .claude/hooks/lib/learning-digest.js:192-340.
 *
 * Canonical delivered library: .claude/hooks/lib/learning-digest.js.
 * CLI compatibility entrypoint: scripts/learning/digest-builder.js
 * (--help, --stats, or default aggregation; scripts/learning/digest-builder.js:7-50).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
// Shared state helpers are siblings (.claude/hooks/lib/learning-digest.js:20-26).
const {
  resolveLearningDir,
} = require("./learning-utils");
const {
  requireMainCheckout,
} = require("./state-resolver");
const MAX_OBSERVATION_BYTES = 16 * 1024 * 1024;

// Final-component type, size and link checks use the descriptor being read.
// Ancestor containment is checked separately; concurrent ancestor replacement
// remains outside this Node path-based API's guarantee (.claude/hooks/lib/learning-digest.js:32-63).
function readLearningFile(file) {
  if (
    ![fs.constants.O_NOFOLLOW, fs.constants.O_NONBLOCK].every(
      (flag) => Number.isInteger(flag) && flag > 0,
    )
  )
    return { ok: false, code: "UNSUPPORTED_SAFE_READ" };
  let fd;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_OBSERVATION_BYTES)
      return { ok: false, code: "UNSAFE_LEARNING_FILE" };
    const buffer = Buffer.alloc(MAX_OBSERVATION_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > MAX_OBSERVATION_BYTES || fs.fstatSync(fd).nlink !== 1)
      return { ok: false, code: "UNSAFE_LEARNING_FILE" };
    return { ok: true, value: buffer.subarray(0, size) };
  } catch (error) {
    return { ok: false, code: error.code || "READ_FAILED" };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Preserve the owner's aggregation schema while refusing redirected consumer
// state. Worktrees may legitimately resolve to their main checkout; explicitly
// declared learning directories remain supported. This is a static path check,
// not a guarantee against concurrent ancestor replacement (.claude/hooks/lib/learning-digest.js:69-106).
function checkedLearningDir(cwd, learningDir) {
  const candidate = path.resolve(learningDir);
  let stat;
  let existing = candidate;
  while (true) {
    try { stat = fs.lstatSync(existing); break; }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  const absent = existing !== candidate;
  if ((!absent && !stat.isDirectory()) || stat.isSymbolicLink())
    throw new Error("unsafe learning directory");
  const roots = [cwd].filter(Boolean);
  const main = requireMainCheckout(cwd);
  if (main.ok && main.repoDir) roots.push(main.repoDir);
  const declared =
    process.env.CSQ_LEARNING_DIR || process.env.KAILASH_LEARNING_DIR;
  if (declared && path.resolve(declared) === candidate)
    roots.push(path.dirname(candidate));
  for (const root of roots) {
    const relative = path.relative(path.resolve(root), candidate);
    if (
      relative === ".." ||
      relative.startsWith(".." + path.sep) ||
      path.isAbsolute(relative)
    )
      continue;
    if (
      fs.realpathSync(existing) === path.join(fs.realpathSync(root), path.relative(path.resolve(root), existing))
    )
      return absent ? null : candidate;
  }
  throw new Error("unsafe learning directory containment");
}

function writeDigest(dir, digest) {
  const target = path.join(dir, "learning-digest.json");
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error("unsafe digest destination");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = path.join(
    dir,
    ".learning-digest-" + crypto.randomBytes(12).toString("hex"),
  );
  try {
    const fd = fs.openSync(
      temporary,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    try {
      fs.writeFileSync(fd, JSON.stringify(digest, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, target);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

/**
 * Load all observations from JSONL file.
 * @param {string} learningDir
 * @returns {Array} Parsed observations
 */
function loadObservations(learningDir, cwd = process.cwd()) {
  learningDir = checkedLearningDir(cwd, learningDir);
  if (learningDir === null) return [];
  const observationsFile = path.join(learningDir, "observations.jsonl");
  const read = readLearningFile(observationsFile);
  if (!read.ok) {
    if (read.code === "ENOENT") return [];
    throw new Error("observations unavailable: " + read.code);
  }
  const content = read.value.toString("utf8");
  return content
    .trim()
    .split("\n")
    .filter((l) => l)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error("invalid observation JSON");
      }
    })
    .map((observation) => {
      if (
        !observation ||
        typeof observation !== "object" ||
        Array.isArray(observation) ||
        typeof observation.type !== "string"
      )
        throw new Error("invalid observation shape");
      return observation;
    });
}

/**
 * Build the learning digest from observations.
 * Pure aggregation — groups observations by type for /codify consumption.
 *
 * @param {string} cwd - Project working directory
 * @param {string} [learningDir] - Override learning directory
 * @returns {Object} The digest object
 */
function buildDigest(cwd, learningDir) {
  const dir = checkedLearningDir(cwd, learningDir || resolveLearningDir(cwd));
  if (dir === null) return null;
  const observations = loadObservations(dir, cwd);

  if (observations.length === 0) {
    return null;
  }

  // Determine the time period covered
  const timestamps = observations
    .map((o) => o.timestamp)
    .filter(Boolean)
    .sort();
  const period = {
    from: timestamps[0] || null,
    to: timestamps[timestamps.length - 1] || null,
    observation_count: observations.length,
  };

  // --- User corrections (most valuable signal) ---
  const corrections = observations
    .filter((o) => o.type === "user_correction")
    .map((o) => ({
      message: o.data?.message || "",
      session: o.context?.session_id || "unknown",
      timestamp: o.timestamp,
    }));

  // --- Rule violations (recurring = rule needs strengthening) ---
  const violationMap = Object.create(null);
  observations
    .filter((o) => o.type === "rule_violation")
    .forEach((o) => {
      const rule = o.data?.rule || "unknown";
      if (!violationMap[rule]) {
        violationMap[rule] = { rule, count: 0, files: new Set(), messages: [] };
      }
      violationMap[rule].count++;
      if (o.data?.file) violationMap[rule].files.add(o.data.file);
      if (o.data?.message && violationMap[rule].messages.length < 3) {
        violationMap[rule].messages.push(o.data.message);
      }
    });
  const errorPatterns = Object.values(violationMap).map((v) => ({
    rule: v.rule,
    count: v.count,
    files: [...v.files].slice(0, 5),
    sample_messages: v.messages,
  }));

  // --- Session accomplishments ---
  const accomplishments = observations
    .filter((o) => o.type === "session_accomplishment")
    .map((o) => ({
      workspace: o.data?.workspace || null,
      accomplishments: o.data?.accomplishments || "",
      timestamp: o.timestamp,
    }));

  // --- Decision references (from journals) ---
  const decisions = observations
    .filter((o) => o.type === "decision_reference")
    .map((o) => ({
      type: o.data?.type || "unknown",
      topic: o.data?.topic || "unknown",
      file: o.data?.file || null,
      timestamp: o.timestamp,
    }));

  // --- Active frameworks (what's being used) ---
  const frameworkCounts = Object.create(null);
  observations
    .filter((o) => o.type === "framework_selection")
    .forEach((o) => {
      const fw = o.data?.framework;
      if (fw) frameworkCounts[fw] = (frameworkCounts[fw] || 0) + 1;
    });

  // --- Workflow patterns (structural, for context) ---
  const workflowPatterns = observations
    .filter((o) => o.type === "workflow_pattern")
    .reduce((acc, o) => {
      const nodeTypes = o.data?.node_types || [];
      if (nodeTypes.length > 0) {
        const key = [...nodeTypes].sort().join("+");
        if (!acc[key]) acc[key] = { node_types: nodeTypes, count: 0 };
        acc[key].count++;
      }
      return acc;
    }, Object.create(null));

  const digest = {
    version: "2.0",
    built_at: new Date().toISOString(),
    period,
    corrections,
    error_patterns: errorPatterns,
    accomplishments,
    decisions,
    active_frameworks: frameworkCounts,
    workflow_patterns: Object.values(workflowPatterns),
  };

  // Write digest to file
  writeDigest(dir, digest);

  return digest;
}

/**
 * Get observation statistics.
 * @param {string} [learningDir]
 * @returns {Object} Stats breakdown
 */
function getStats(learningDir, cwd = process.cwd()) {
  const dir = checkedLearningDir(cwd, learningDir || resolveLearningDir(cwd));
  if (dir === null) return { total_observations: 0, type_breakdown: Object.create(null), last_digest: null, archive_count: 0 };
  const observations = loadObservations(dir, cwd);

  const typeBreakdown = Object.create(null);
  for (const obs of observations) {
    typeBreakdown[obs.type] = (typeBreakdown[obs.type] || 0) + 1;
  }

  // Check for existing digest
  const digestPath = path.join(dir, "learning-digest.json");
  let digestAge = null;
  const read = readLearningFile(digestPath);
  if (read.ok) {
    let digest;
    try {
      digest = JSON.parse(read.value.toString("utf8"));
    } catch {
      throw new Error("invalid digest JSON");
    }
    if (!digest || typeof digest !== "object" || Array.isArray(digest))
      throw new Error("invalid digest shape");
    digestAge = digest.built_at || null;
  } else if (read.code !== "ENOENT")
    throw new Error("digest unavailable: " + read.code);

  return {
    total_observations: observations.length,
    type_breakdown: typeBreakdown,
    last_digest: digestAge,
    archive_count: countArchives(dir),
  };
}

function countArchives(learningDir) {
  const archiveDir = path.join(learningDir, "observations.archive");
  try {
    const stat = fs.lstatSync(archiveDir);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("unsafe archive directory");
    return fs
      .readdirSync(archiveDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .length;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}


module.exports = {
  buildDigest,
  loadObservations,
  getStats,
  checkedLearningDir,
};
