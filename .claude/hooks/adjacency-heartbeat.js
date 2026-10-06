#!/usr/bin/env node
/**
 * adjacency-heartbeat.js — F14 M5 B2 heartbeat hook.
 *
 * Architecture ref: §4.3 hook table row "adjacency-heartbeat.js"
 *
 * @hook-event: PreToolUse:* (telemetry) — records liveness, never gates; "any
 *   tool call" genuinely IS the subject, which is what licenses the `*` matcher
 *   (hook-event-selection.md MUST-3 reserves it for lifecycle/telemetry).
 * @hook-event: Stop (telemetry) — the turn boundary is the subject: fold the log
 *   and write a final heartbeat once the turn's work is done.
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
let fallback = null;

const fs = require("fs");
const path = require("path");

const COALESCE_WINDOW_MS = 60_000;
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const { readStdinBounded } = require("./lib/read-stdin-bounded.js");
// loom#1349 — the ONE hardened append primitive; see lib/append-sink.js for the six defenses.
const { appendSinkLine } = require("./lib/append-sink.js");
// perf/hook-cost — per-session pre-check that needs no git and no identity.
const { throttleCheck, throttleMark } = require("./lib/session-throttle.js");
// The stamp lives beside the shared cache under the SAME fence: the
// `.heartbeat-cache` guard row (guard-path-scope.js, suffix [A-Za-z0-9_.-]*),
// the settings deny `Edit(.claude/learning/.heartbeat-cache*)` (settings.json
// carries no `Write(` deny rules; per reconcile-settings-deny.mjs, `Edit(<path>)`
// is the form that covers Edit, Write and NotebookEdit) and the
// .gitignore line all cover `.heartbeat-cache.s-<hash>.json`. A stamp outside
// that fence would be an unguarded file able to silence this session's liveness.
const THROTTLE_KEY = {
  dir: path.join(PROJECT_DIR, ".claude", "learning"),
  prefix: ".heartbeat-cache.s-",
  name: "adjacency-heartbeat",
  projectDir: PROJECT_DIR,
};
// Stamps of ended sessions are pruned after a day (best-effort, on mark only).
const STAMP_PRUNE_MS = 24 * 60 * 60 * 1000;

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
      // loom#1349 — hardened append. Best-effort for the HALTING path (a refusal never throws into
      // the hook), but NOT silent: a security refusal is reported on stderr per R1 F5. Dropping it
      // silently would let an attacker who plants a symlink/FIFO/hard-link at the sink suppress
      // every heartbeat with no signal — trading a leak for an undetectable denial-of-observability.
      // stderr only: stdout is the hook's protocol channel.
      const w = appendSinkLine({ repoDir, sinkPath: logPath, line: JSON.stringify(record) });
      if (!w.ok) console.error(`[adjacency-heartbeat] sink append refused: ${w.error} — ${w.reason}`);
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
    // loom#1349 — hardened append. This is the PRODUCTION signed row: it carries verified_id +
    // person_id, so a symlinked sink escaping the gitignore fence leaks operator-correlatable
    // identity. Best-effort for the halting path, loud on stderr for a refusal (R1 F5), as above.
    const w = appendSinkLine({ repoDir, sinkPath: logPath, line: JSON.stringify(signed) });
    if (!w.ok) console.error(`[adjacency-heartbeat] sink append refused: ${w.error} — ${w.reason}`);
  } catch {
    // best-effort
  }
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js).
function hookMain() {
  fallback = setTimeout(() => {
    try {
      process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    } catch {}
    process.exit(1);
  }, TIMEOUT_MS);
  return main();
}

async function main() {
  try {
    const payload = await readStdinBounded();
    const hookEvent = payload.hook_event_name || "PreToolUse";
    const isStop = hookEvent === "Stop" || hookEvent === "SessionEnd";
    const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";

    // perf/hook-cost — FAST PATH. Before this, every PreToolUse paid a git spawn
    // (main checkout) + git config + ssh-keygen (identity) only to reach the
    // 60 s coalesce below and do nothing. The session stamp records when THIS
    // session last saw a heartbeat land (its own, or a sibling's via the shared
    // cache), so a call inside that window returns here with no subprocess.
    // Emission cadence is unchanged: at most one heartbeat per
    // COALESCE_WINDOW_MS, ≪ LIVENESS_TTL_MS (20 min, coordination-log.js).
    // Stop/SessionEnd never take the fast path — the final heartbeat always runs.
    if (!isStop && sessionId) {
      const t = throttleCheck({ ...THROTTLE_KEY, sessionId, windowMs: COALESCE_WINDOW_MS });
      if (t.skip) {
        passthrough();
        return;
      }
    }
    const stamp = (ts) => {
      if (sessionId) {
        throttleMark({ ...THROTTLE_KEY, sessionId, nowMs: ts, pruneOlderThanMs: STAMP_PRUNE_MS });
      }
    };

    const mainCheckout = resolveMainCheckoutSafely(PROJECT_DIR);
    const cachePath = path.join(
      mainCheckout,
      ".claude",
      "learning",
      ".heartbeat-cache",
    );

    const identity = resolveIdentitySafely(mainCheckout);
    if (!identity || !identity.verified_id) {
      // No identity → cannot sign a heartbeat; passthrough. Stamped so the
      // session does not re-resolve a missing identity on every call; a key
      // configured mid-session is picked up within one window.
      stamp(Date.now());
      passthrough();
      return;
    }

    const nowMs = Date.now();
    const cached = readCache(cachePath, identity);

    // Coalesce: PreToolUse-style invocations within 60s of last heartbeat
    // skip emission. Stop event ALWAYS proceeds (final heartbeat).
    if (!isStop && cached && typeof cached.last_heartbeat_ms === "number") {
      const age = nowMs - cached.last_heartbeat_ms;
      // age < 0 is a FUTURE-dated cache (clock skew or a planted file). Before
      // perf/hook-cost it satisfied `age < WINDOW` forever and silenced this
      // operator's heartbeats indefinitely; it now counts as absent.
      if (age >= 0 && age < COALESCE_WINDOW_MS) {
        // Coalesced — do not append. Stamp with the LAST EMISSION time, not
        // now, so this session's window ends when that heartbeat's does.
        stamp(cached.last_heartbeat_ms);
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
    stamp(nowMs);

    passthrough();
  } catch (_) {
    // Never block, never re-throw.
    passthrough();
  }
}

module.exports = { hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
