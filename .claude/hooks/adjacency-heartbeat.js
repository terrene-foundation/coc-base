#!/usr/bin/env node
/**
 * adjacency-heartbeat.js — F14 M5 B2 heartbeat hook.
 *
 * Architecture ref: §4.3 hook table row "adjacency-heartbeat.js"
 *
 * Events: PreToolUse (*) + Stop
 * Severity: NEVER blocks. {continue:true} on every path.
 * Budget: 5s wall-clock.
 *
 * Behavior:
 *   - Sign a `heartbeat` record per architecture §2.2.
 *   - Coalesce: if last heartbeat <60s ago (per local cache), skip emission.
 *   - Stop event: fetch + fold log, then write a final heartbeat with
 *     session-end intent flag.
 *
 * State files (all under .claude/learning/ via state-resolver):
 *   .heartbeat-cache       — JSON {last_heartbeat_ms, seq}
 *   coordination-log.jsonl — append target
 *
 * Test env overrides:
 *   COC_TEST_FINGERPRINT, COC_TEST_PERSON_ID — identity short-circuit
 *   COC_TEST_SKIP_SIGN — write cache + (optionally) unsigned record stub
 */

"use strict";

const TIMEOUT_MS = 5000;
const fallback = setTimeout(() => {
  try {
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  } catch {}
  process.exit(1);
}, TIMEOUT_MS);

const fs = require("fs");
const path = require("path");

const COALESCE_WINDOW_MS = 60_000;
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function readStdinSyncSafe() {
  try {
    const data = fs.readFileSync(0, "utf8");
    if (!data || !data.trim()) return {};
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function passthrough() {
  clearTimeout(fallback);
  try {
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  } catch {}
  process.exit(0);
}

function resolveMainCheckoutSafely(repoDir) {
  try {
    const { resolveMainCheckout } = require(
      path.join(__dirname, "lib", "state-resolver.js"),
    );
    return resolveMainCheckout(repoDir);
  } catch {
    return repoDir;
  }
}

function readCache(cachePath, identity) {
  // M5 iter-6 Sec-MED-A2: identity-guard against cross-operator cache
  // poisoning. Pre-iter-6 readCache trusted any cache file on disk, so
  // an attacker (or stale sibling-operator state from a prior session
  // on the same machine) could pre-seed `.heartbeat-cache` with a
  // different verified_id + recent last_heartbeat_ms, causing THIS
  // operator's PreToolUse heartbeats to coalesce under the wrong
  // identity. The guard returns null when verified_id mismatches,
  // forcing a fresh heartbeat (and rewriting the cache under THIS
  // operator's verified_id).
  if (!fs.existsSync(cachePath)) return null;
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (
      identity &&
      identity.verified_id &&
      cached &&
      typeof cached.verified_id === "string" &&
      cached.verified_id !== identity.verified_id
    ) {
      // Cache belongs to a different operator → reject.
      return null;
    }
    return cached;
  } catch {
    return null;
  }
}

function writeCache(cachePath, data) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(data) + "\n");
  } catch {
    // best-effort
  }
}

function resolveIdentitySafely(repoDir) {
  const testFp = process.env.COC_TEST_FINGERPRINT;
  const testPid = process.env.COC_TEST_PERSON_ID;
  if (testFp && testPid) {
    return { verified_id: testFp, person_id: testPid };
  }
  try {
    const { resolveIdentity } = require(
      path.join(__dirname, "lib", "operator-id.js"),
    );
    return resolveIdentity(repoDir, {});
  } catch {
    return null;
  }
}

function appendHeartbeat(repoDir, identity, opts) {
  // Best-effort. With COC_TEST_SKIP_SIGN, write an unsigned stub for tests.
  const skipSign = process.env.COC_TEST_SKIP_SIGN === "1";
  const record = {
    type: "heartbeat",
    verified_id: identity.verified_id,
    person_id: identity.person_id,
    seq: opts.seq || 0,
    ts: new Date(opts.nowMs).toISOString(),
    content: {
      session_end_intent: opts.sessionEnd === true,
    },
  };
  if (skipSign) {
    record.sig = "test-stub";
    try {
      const logPath = path.join(
        repoDir,
        ".claude",
        "learning",
        "coordination-log.jsonl",
      );
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, JSON.stringify(record) + "\n");
    } catch {
      // best-effort
    }
    return;
  }
  // Production sign-and-append (uses canonical libs).
  try {
    const { canonicalSerialize, sign } = require(
      path.join(__dirname, "lib", "coc-sign.js"),
    );
    const keyPath = process.env.COC_OPERATOR_KEY_PATH;
    if (!keyPath) return;
    const bytes = canonicalSerialize(record);
    const r = sign(bytes, { keyType: "ssh", keyPath });
    if (!r.ok) return;
    const signed = Object.assign({}, record, { sig: r.sig });
    const logPath = path.join(
      repoDir,
      ".claude",
      "learning",
      "coordination-log.jsonl",
    );
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(signed) + "\n");
  } catch {
    // best-effort
  }
}

(function main() {
  try {
    const payload = readStdinSyncSafe();
    const hookEvent = payload.hook_event_name || "PreToolUse";
    const isStop = hookEvent === "Stop" || hookEvent === "SessionEnd";

    const mainCheckout = resolveMainCheckoutSafely(PROJECT_DIR);
    const cachePath = path.join(
      mainCheckout,
      ".claude",
      "learning",
      ".heartbeat-cache",
    );

    const identity = resolveIdentitySafely(mainCheckout);
    if (!identity || !identity.verified_id) {
      // No identity → cannot sign a heartbeat; passthrough.
      passthrough();
      return;
    }

    const nowMs = Date.now();
    const cached = readCache(cachePath, identity);

    // Coalesce: PreToolUse-style invocations within 60s of last heartbeat
    // skip emission. Stop event ALWAYS proceeds (final heartbeat).
    if (!isStop && cached && typeof cached.last_heartbeat_ms === "number") {
      if (nowMs - cached.last_heartbeat_ms < COALESCE_WINDOW_MS) {
        // Coalesced — touch cache mtime but do not append.
        writeCache(cachePath, cached);
        passthrough();
        return;
      }
    }

    const seq = cached && typeof cached.seq === "number" ? cached.seq + 1 : 0;
    appendHeartbeat(mainCheckout, identity, {
      nowMs,
      seq,
      sessionEnd: isStop,
    });
    writeCache(cachePath, {
      last_heartbeat_ms: nowMs,
      seq,
      verified_id: identity.verified_id,
    });

    passthrough();
  } catch (_) {
    // Never block, never re-throw.
    passthrough();
  }
})();
