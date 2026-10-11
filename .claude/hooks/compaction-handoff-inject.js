#!/usr/bin/env node
/**
 * @hook-event: SessionStart:compact (lifecycle) — `source` is the documented
 *   matcher payload, and `compact` is precisely the moment the model-written
 *   summary has replaced the window: the injected block lands in context before
 *   the first post-compaction prompt, which is the only point at which a
 *   snapshot can repair the summary's blind spots. Registered with the
 *   `compact` matcher so it does NOT fire on startup/resume/clear, where there
 *   is nothing to hand over and a banner would be noise.
 *
 * Hook: compaction-handoff-inject
 * Event: SessionStart (matcher: compact)
 * Purpose: Deliver the mechanical pre-compaction snapshot plus the ledger's
 *   tail into context after a compaction, with a LOUD banner when the snapshot
 *   is missing, corrupt, stale or incomplete, or when the ledger predates the
 *   snapshot beyond the stated threshold.
 *
 * ABSENCE IS LOUD (`conservation-gate.md` MUST-4). A missing snapshot is the
 * one outcome the reader cannot detect: a silent injector and an injector with
 * nothing to say produce byte-identical output. This hook therefore ALWAYS
 * emits a block on `compact` — when there is no snapshot, the block says so,
 * with the finding identity, rather than staying quiet.
 *
 * WHAT IT INJECTS IS FACTS. The rendering (`lib/compaction-handoff.js::
 * renderHandoff`) never summarises and never infers; the judgment half stays in
 * the model-maintained ledger, which this hook READS (age + last_reconciled_sha
 * + open rows) and never writes.
 *
 * Exit Codes:
 *   0 = success (always — SessionStart cannot block; its exit 2 is a
 *       user-facing error only)
 *   1 = the timeout fallback fired
 */

/**
 * @hook-contract
 * {
 *   "side_effects": {
 *     "fs_writes": [],
 *     "network": false,
 *     "spawns": ["git"]
 *   },
 *   "idempotent": true,
 *   "may_rewrite_input": false,
 *   "notes": "Read-only: it reads the snapshot file, the ledger files and the receipt directory, and writes nothing. spawns: `git` through lib/git-subprocess-env.js (the ledger's main-checkout resolution runs git probes inside lib/state-resolver.js). Idempotent: repeating with the same payload reads the same files and emits the same block."
 * }
 */

const path = require("path");
const {
  readSnapshotFile,
  readLedger,
  renderHandoff,
  resolveHandoffDir,
  resolveLedgerRoots,
} = require("./lib/compaction-handoff.js");
const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

const TIMEOUT_MS = 10000;
let _timeout = null;

function hookMain() {
  _timeout = setTimeout(() => {
    // Fail-open: a stall must not cost the session its context. Emit only
    // `continue` — never a half-rendered handoff, which would read as complete.
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    process.exit(1);
  }, TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    readStdinBounded({ timeoutMs: 2000 })
      .then((payload) => {
        try {
          onPayload(payload);
        } catch (e) {
          return reject(e);
        }
        resolve();
      })
      .catch(reject);
  });
}

function onPayload(payload) {
  const source = payload && payload.source;
  // FAIL-CLOSED (a security round measured the previous `if (source && source !==
  // "compact")` injecting 644 chars for a payload that carried NO source at all —
  // and `lib/dispatch-main.js` runs every group when the match field is absent).
  // Only an explicit `compact` may inject; anything else, missing included, stays
  // silent. The suppression is ANNOUNCED on stderr rather than silent, so a
  // runtime that stops sending `source` is visible instead of quietly losing the
  // handoff (`conservation-gate.md` MUST-4).
  if (source !== "compact") {
    if (source === undefined) {
      process.stderr.write(
        "[compaction-handoff] SessionStart payload carried no `source`; NOT injecting (only an explicit source=compact injects). If this runtime stopped sending `source`, the handoff is being lost here.\n",
      );
    }
    finish(true);
    return;
  }
  const cwd = (payload && payload.cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const sessionId = (payload && payload.session_id) || null;

  const dirInfo = resolveHandoffDir(cwd);
  const snapshotRead = dirInfo.ok
    ? readSnapshotFile(dirInfo.dir, { sessionId })
    : { ok: false, finding: "compaction-handoff/snapshot-missing", reason: dirInfo.reason };

  let ledger = { dirs: [], files: [] };
  try {
    ledger = readLedger({ roots: resolveLedgerRoots(cwd) });
  } catch {
    // A ledger read failure must not cost the rest of the handoff; the
    // renderer reports the empty ledger as ABSENT, which is the honest reading
    // of "could not read" in the same shape as "no such file".
  }

  let rendered;
  try {
    rendered = renderHandoff({ snapshotRead, ledger });
  } catch (e) {
    rendered = {
      text: `**compaction-handoff/render-failed — the handoff block could not be rendered (${(e && e.message) || e}). Treat the mechanical half as ABSENT, not as clean.**`,
      banners: [{ finding: "compaction-handoff/render-failed", text: "" }],
    };
  }

  const out = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: rendered.text,
    },
  };
  process.stdout.write(JSON.stringify(out) + "\n");
  if (rendered.banners && rendered.banners.length) {
    process.stderr.write(
      `[compaction-handoff] injected with ${rendered.banners.length} banner(s): ${rendered.banners.map((b) => b.finding).join(", ")}\n`,
    );
  }
  finish(false);
}

function finish(emitContinue) {
  if (_timeout) clearTimeout(_timeout);
  if (emitContinue) process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

module.exports = { hookMain };

if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") {
    require("./lib/hook-engine.js").runCli(hookMain, __filename);
  } else {
    hookMain();
  }
}
