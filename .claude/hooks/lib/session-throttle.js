"use strict";

/**
 * session-throttle.js — a per-session "did this already run within N ms?" stamp
 * that can be read WITHOUT git, identity resolution or any subprocess.
 *
 * WHY (perf/hook-cost). adjacency-heartbeat.js already coalesced heartbeats to
 * one per 60 s, but it decided to coalesce only AFTER resolving the main checkout
 * (git) and the operator identity (git config + ssh-keygen), because its cache
 * lives in the main checkout and is identity-guarded. So every tool call paid
 * ~3 subprocesses to learn it had nothing to do. This stamp answers that
 * question first, from one small file read.
 *
 * SCOPE — ADVISORY WORK ONLY. A stamp may only ever SKIP work whose absence is
 * harmless for up to `windowMs` (telemetry, liveness). It MUST NOT gate,
 * authorize or deny anything. Every failure path answers "do not skip", which
 * is the pre-throttle behaviour.
 *
 * WHERE — CALLER-CHOSEN, AND IT MUST BE A FENCED PATH. The stamp is a file
 * `<dir>/<prefix><hash>.json`. A forged stamp can suppress the advisory work, so
 * the caller MUST place it where the existing state-file fences already refuse
 * agent writes. adjacency-heartbeat uses `<project>/.claude/learning/` with the
 * prefix `.heartbeat-cache.s-`, which sits inside the SAME guard rows as the
 * shared `.heartbeat-cache` (guard-path-scope.js `.heartbeat-cache` row, suffix
 * `[A-Za-z0-9_.-]*`, Bash surface; settings deny `Edit(.claude/learning/
 * .heartbeat-cache*)` (there is no `Write(` deny rule; per
 * reconcile-settings-deny.mjs, `Edit(<path>)` covers Edit, Write and
 * NotebookEdit); .gitignore `.claude/learning/.heartbeat-cache*`). The
 * directory must be a real directory (not a symlink) owned by the effective uid,
 * and the stamp a regular file owned by it; otherwise ⇒ do not skip.
 *
 * KEY. sha256(name ‖ projectDir ‖ sessionId); the record repeats all three and
 * must match. No sessionId ⇒ never skip.
 *
 * TIME. A stamp in the FUTURE (now − ts < 0) is treated as absent, so a forged
 * or clock-skewed stamp cannot suppress work indefinitely.
 *
 * NO TOP-LEVEL SIDE EFFECTS — plain functions for standalone hooks and for an
 * in-process dispatcher alike.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PREFIX_RX = /^[A-Za-z0-9_.-]+$/;
const HASH_LEN = 40;

function _euid() {
  return typeof process.geteuid === "function" ? process.geteuid() : null;
}

function _valid(a) {
  return (
    a &&
    typeof a.dir === "string" && path.isAbsolute(a.dir) &&
    typeof a.prefix === "string" && PREFIX_RX.test(a.prefix) &&
    typeof a.name === "string" && a.name &&
    typeof a.projectDir === "string" && a.projectDir &&
    typeof a.sessionId === "string" && a.sessionId
  );
}

/**
 * Validate (optionally create) the stamp directory.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function _checkDir(dir, create) {
  const euid = _euid();
  if (euid === null) return { ok: false, reason: "no euid on this platform" };
  if (create) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (e) {
      return { ok: false, reason: `mkdir failed: ${e && e.code}` };
    }
  }
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (e) {
    return { ok: false, reason: `lstat failed: ${e && e.code}` };
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, reason: "not a real directory" };
  if (st.uid !== euid) return { ok: false, reason: "not owned by euid" };
  return { ok: true };
}

/**
 * The stamp file path for a key. Pure.
 * @param {{dir: string, prefix: string, name: string, projectDir: string, sessionId: string}} a
 * @returns {string|null}
 */
function throttleStampPath(a) {
  if (!_valid(a)) return null;
  const h = crypto
    .createHash("sha256")
    .update(`${a.name}\0${a.projectDir}\0${a.sessionId}`, "utf8")
    .digest("hex")
    .slice(0, HASH_LEN);
  return path.join(a.dir, `${a.prefix}${h}.json`);
}

/**
 * Should this advisory work be skipped?
 * @param {{dir, prefix, name, projectDir, sessionId, windowMs: number, nowMs?: number}} a
 * @returns {{skip: boolean, reason: string, ageMs?: number}}
 *   skip:true ONLY when a well-formed, owned stamp for exactly this key is
 *   0 ≤ age < windowMs old. Every other outcome is skip:false.
 */
function throttleCheck(a) {
  if (!_valid(a) || !(a.windowMs > 0)) return { skip: false, reason: "incomplete key" };
  const d = _checkDir(a.dir, false);
  if (!d.ok) return { skip: false, reason: d.reason };
  const p = throttleStampPath(a);
  let rec;
  try {
    const st = fs.lstatSync(p);
    if (!st.isFile() || st.uid !== _euid()) {
      return { skip: false, reason: "stamp not an owned regular file" };
    }
    rec = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return { skip: false, reason: "no stamp" };
  }
  if (
    !rec ||
    rec.name !== a.name ||
    rec.projectDir !== a.projectDir ||
    rec.sessionId !== a.sessionId ||
    typeof rec.ts !== "number" ||
    !Number.isFinite(rec.ts)
  ) {
    return { skip: false, reason: "stamp does not match key" };
  }
  const now = typeof a.nowMs === "number" ? a.nowMs : Date.now();
  const age = now - rec.ts;
  if (age < 0) return { skip: false, reason: "stamp in the future", ageMs: age };
  if (age >= a.windowMs) return { skip: false, reason: "stamp expired", ageMs: age };
  return { skip: true, reason: "within window", ageMs: age };
}

/**
 * Record that the advisory work ran at `nowMs` (default now). Atomic (exclusive
 * temp + rename). Creates `dir` if absent. When `pruneOlderThanMs` is given,
 * also removes OTHER stamps with the same prefix whose mtime is older than that
 * (ended sessions), best-effort.
 * @param {{dir, prefix, name, projectDir, sessionId, nowMs?: number, pruneOlderThanMs?: number}} a
 * @returns {{ok: boolean, reason?: string, pruned?: number}}
 */
function throttleMark(a) {
  if (!_valid(a)) return { ok: false, reason: "incomplete key" };
  const d = _checkDir(a.dir, true);
  if (!d.ok) return { ok: false, reason: d.reason };
  const p = throttleStampPath(a);
  const tmp = `${p}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    const body = JSON.stringify({
      name: a.name,
      projectDir: a.projectDir,
      sessionId: a.sessionId,
      ts: typeof a.nowMs === "number" ? a.nowMs : Date.now(),
    });
    fs.writeFileSync(tmp, body, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, p);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    return { ok: false, reason: `write failed: ${e && e.code}` };
  }
  let pruned = 0;
  if (a.pruneOlderThanMs > 0) {
    const cutoff = Date.now() - a.pruneOlderThanMs;
    const own = path.basename(p);
    const rx = new RegExp(`^${a.prefix.replace(/[.]/g, "\\.")}[0-9a-f]{${HASH_LEN}}\\.json$`);
    try {
      for (const n of fs.readdirSync(a.dir)) {
        if (n === own || !rx.test(n)) continue;
        const f = path.join(a.dir, n);
        try {
          const st = fs.lstatSync(f);
          if (st.isFile() && st.mtimeMs < cutoff) {
            fs.unlinkSync(f);
            pruned++;
          }
        } catch {}
      }
    } catch {}
  }
  return { ok: true, pruned };
}

module.exports = { throttleStampPath, throttleCheck, throttleMark };
