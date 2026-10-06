#!/usr/bin/env node
/**
 * @hook-event: UserPromptSubmit (telemetry) — the submitted human prompt exists for recording its hash commitment without storing raw text.
 *
 * provenance-capture-prompt.js — F101-2 (loom#411 governance-as-DNA, loom lane).
 *
 * Event: UserPromptSubmit (*)
 * Severity: NEVER blocks. {continue:true} on every path (capture is observational
 *           — the model cannot bypass it, but it never halts the human's turn).
 * Budget: 5s wall-clock.
 *
 * Behavior: record the human's turn as a `HumanInput` provenance event in the
 * local per-session ledger (provenance-ledger.js). This event is the SUBSTRATE
 * F101-3's author-discipline rule reads — "was there recorded human input THIS
 * session" — so a `co-authored`/`human` DECISION can be verified as BACKED.
 *
 * SECRETS FENCE (`security.md` "no secrets in logs"): the ledger is a permanent,
 * csq-anchored governance record — the worst place for a secret-bearing prompt.
 * We store a TAMPER-EVIDENT COMMITMENT (prompt_sha256 + char_count), NEVER the raw
 * text. The human proves their words by re-presenting them (the hash matches);
 * verbatim-words capture is a csq-lane evidence decision gated by the #411
 * attribution-granularity question, NOT loom's local artifact.
 *
 * Test env overrides:
 *   COC_TEST_FINGERPRINT, COC_TEST_PERSON_ID — identity short-circuit
 *
 * Origin: F101-2 (journal/0188 §D; F101-1 schema journal/0190; seam csq journal 0017).
 */

"use strict";

const TIMEOUT_MS = 5000;
// Armed by hookMain (FIRST, before the stdin read — the same point relative to the
// work it had as a load-time statement); reset per run because the engine requires
// this module once per worker.
let fallback = null;

const crypto = require("crypto");
const path = require("path");

const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

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

async function main() {
  // Resolved per run, not at load: the engine requires this module once per worker.
  const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // Engine residual (hook-engine.js header): in-process, an exit reached inside this
  // `try` (via passthrough) throws a sentinel, so the outer `catch` runs — it only
  // calls passthrough (clearTimeout + output + exit), the allowed set. The inner
  // try/catch around captureProvenance encloses no exit path.
  try {
    const payload = await readStdinBounded();
    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
    // An empty prompt carries no human input to commit to — nothing to record.
    if (prompt.length === 0) {
      passthrough();
      return;
    }

    const mainCheckout = resolveMainCheckoutSafely(PROJECT_DIR);
    const identity = resolveIdentitySafely(mainCheckout);
    const session = payload.session_id || "unknown-session";

    const promptSha256 = crypto
      .createHash("sha256")
      .update(prompt, "utf8")
      .digest("hex");

    try {
      const { captureProvenance } = require(
        path.join(__dirname, "lib", "provenance-ledger.js"),
      );
      const r = captureProvenance({
        repoDir: mainCheckout,
        session,
        kind: "HumanInput",
        identity,
        payload: { prompt_sha256: promptSha256, char_count: prompt.length },
        nowIso: new Date().toISOString(),
      });
      // Observability: a dropped HumanInput event must leave a breadcrumb (it is
      // the substrate F101-3 author-validation reads). stderr never blocks.
      if (r && r.ok === false) {
        try {
          process.stderr.write(
            `provenance.capture.dropped kind=HumanInput reason=${String(
              r.error,
            ).slice(0, 120)}\n`,
          );
        } catch {}
      }
    } catch {
      // Best-effort: capture failure degrades the ledger, never blocks the turn.
    }

    passthrough();
  } catch {
    // Never block, never re-throw.
    passthrough();
  }
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js. All load-time work lives here so `require()`
// of this file has no side effect.
function hookMain() {
  fallback = setTimeout(() => {
    try {
      process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    } catch {}
    process.exit(1);
  }, TIMEOUT_MS);
  return main();
}

module.exports = { hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
