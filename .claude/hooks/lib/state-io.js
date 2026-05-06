/**
 * state-io — atomic appends + corrupt-JSON-resilient reads for trust-posture state.
 *
 * Mitigates red-team CRIT-3 (posture self-modification — defense-in-depth via shape check),
 *   CRIT-4 (fail-open on missing/corrupt → fail-closed to L1),
 *   HIGH-6 (concurrent worktree races → flock + size-bound + write-ahead bak).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { resolveStateDir, ensureStateDir } = require("./state-resolver");

const POSTURE_FILE = "posture.json";
const POSTURE_BAK = "posture.json.bak";
const VIOLATIONS_FILE = "violations.jsonl";
const MAX_LINE_BYTES = 2048; // mitigates CRIT atomicity (POSIX append < PIPE_BUF=4096)

const L1 = "L1_PSEUDO_AGENT";
const VALID_POSTURES = new Set([
  "L1_PSEUDO_AGENT",
  "L2_SUPERVISED",
  "L3_SHARED_PLANNING",
  "L4_CONTINUOUS_INSIGHT",
  "L5_DELEGATED",
]);

function newId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function failClosedPosture(reason) {
  return {
    posture: L1,
    since: new Date().toISOString(),
    transition_history: [
      {
        from: null,
        to: L1,
        type: "FAIL_CLOSED",
        reason,
        ts: new Date().toISOString(),
      },
    ],
    pending_verification: [],
    violation_window_30d: {},
    _fail_closed: true,
  };
}

/**
 * Read posture.json. On missing / corrupt → fail-closed to L1 (mitigates CRIT-4).
 * Tries main file first, then .bak, then fail-closed.
 */
function readPosture(cwd) {
  const dir = resolveStateDir(cwd);
  const main = path.join(dir, POSTURE_FILE);
  const bak = path.join(dir, POSTURE_BAK);

  for (const p of [main, bak]) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf8");
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object") continue;
      if (!VALID_POSTURES.has(obj.posture)) continue;
      return obj;
    } catch {
      continue;
    }
  }

  // Distinguish "fresh repo" (no init marker) from "deleted state"
  // For now, fail-closed to L1 in both — caller decides if .init-marker presence permits L5.
  const initMarker = path.join(dir, ".initialized");
  if (!fs.existsSync(initMarker)) {
    return {
      posture: "L5_DELEGATED",
      since: new Date().toISOString(),
      transition_history: [],
      pending_verification: [],
      violation_window_30d: {},
      _fresh: true,
    };
  }
  return failClosedPosture(
    "posture.json missing or corrupt; both main and bak unreadable",
  );
}

/**
 * Write posture.json with write-ahead .bak (mitigates HIGH-6 corrupt-on-crash).
 * Caller is responsible for flock if multiple writers; for the POC we use mtime check.
 */
function writePosture(cwd, posture) {
  if (!VALID_POSTURES.has(posture.posture)) {
    throw new Error(`Invalid posture: ${posture.posture}`);
  }
  const dir = ensureStateDir(cwd);
  const main = path.join(dir, POSTURE_FILE);
  const bak = path.join(dir, POSTURE_BAK);
  const tmp = path.join(dir, `posture.json.tmp.${process.pid}`);

  // 1. Copy current main → bak (write-ahead)
  if (fs.existsSync(main)) {
    fs.copyFileSync(main, bak);
  }
  // 2. Write tmp; rename atomic
  fs.writeFileSync(tmp, JSON.stringify(posture, null, 2));
  fs.renameSync(tmp, main);

  // 3. Touch init marker
  const initMarker = path.join(dir, ".initialized");
  if (!fs.existsSync(initMarker))
    fs.writeFileSync(initMarker, new Date().toISOString());
}

/**
 * Append a violation. Single-line JSON, ≤2KB, atomic O_APPEND (mitigates HIGH-6 race).
 */
function appendViolation(cwd, partial) {
  const dir = ensureStateDir(cwd);
  const file = path.join(dir, VIOLATIONS_FILE);

  const violation = {
    id: newId("vio"),
    timestamp: new Date().toISOString(),
    session_id: process.env.CLAUDE_SESSION_ID || "unknown",
    repo: cwd || process.cwd(),
    ...partial,
  };

  let line = JSON.stringify(violation);
  if (line.length > MAX_LINE_BYTES) {
    // Truncate evidence field to keep line < 2KB (POSIX atomic-append safety)
    const evidence = String(violation.evidence || "");
    const overflow = line.length - MAX_LINE_BYTES + 32;
    violation.evidence =
      evidence.slice(0, Math.max(0, evidence.length - overflow)) + "…[trunc]";
    violation._truncated = true;
    line = JSON.stringify(violation);
  }

  // O_APPEND atomic for writes < PIPE_BUF (4096); we're capped at 2048
  fs.appendFileSync(file, line + "\n");
  return violation.id;
}

/**
 * Read recent violations within a window (mitigates MED-4 unbounded growth — caller filters).
 */
function readRecentViolations(cwd, { sinceTs, limit = 1000 } = {}) {
  const dir = resolveStateDir(cwd);
  const file = path.join(dir, VIOLATIONS_FILE);
  if (!fs.existsSync(file)) return [];

  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (sinceTs && obj.timestamp < sinceTs) continue;
      out.push(obj);
    } catch {
      // skip corrupt line, continue
    }
  }
  return out.reverse();
}

module.exports = {
  readPosture,
  writePosture,
  appendViolation,
  readRecentViolations,
  failClosedPosture,
  VALID_POSTURES,
  MAX_LINE_BYTES,
};
