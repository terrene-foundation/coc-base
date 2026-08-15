#!/usr/bin/env node
/**
 * emit-dispatch-ledger.js — the PRODUCER half of the dispatch↔delivery reconciliation stream (T1).
 *
 * Records three things nothing in the tree recorded before:
 *   (a) LAUNCH   — one row per subagent dispatch, carrying a UNIQUE launch id, the dispatch NAME,
 *                  the subagent type, and the GENERATION the dispatch was issued from.
 *   (b) DELIVERY — one row per `SendMessage`, carrying the delivering agent's generation. ZERO
 *                  hooks observed this tool before; the moment is proven reachable because two
 *                  `*`-matcher PreToolUse hooks (adjacency-heartbeat, provenance-capture-tool)
 *                  already run on every tool call.
 *   (d) DECLARED — one row per user prompt, carrying the DECLARED sub-part COUNT and nothing else.
 *
 * The reconciler is the separate `reconcile-dispatch-delivery.js` at `SubagentStop`.
 *
 * @hook-event: PreToolUse:Task|Agent|SendMessage (telemetry) — the dispatch and the message ARE the
 *   subject: each is a discrete tool call, present in `tool_input` at this moment and nowhere else.
 *   Records, never gates. The matcher is exactly `DELEGATION_TOOLS ∪ DELIVERY_TOOLS`; a `*` matcher
 *   would pay a node spawn on every Read/Bash/Grep to reach an immediate passthrough.
 * @hook-event: UserPromptSubmit (telemetry) — the incoming prompt is the subject and it exists only
 *   at this moment; the declared sub-part COUNT is recorded so a later reconcile can compare it
 *   against dispatches actually launched. Records, never gates.
 *
 * NEVER BLOCKS. `{continue:true}` on every path, exit 0 on every path including the timeout
 * fallback — an observability hook that can contribute a non-zero exit is a guard wearing telemetry
 * clothes (`hook-output-discipline.md`: fail-open). A capture failure leaves a stderr breadcrumb and
 * nothing else.
 *
 * NO PROMPT TEXT IS EVER WRITTEN. The `declared` row carries an integer. The sink holds session
 * ids, agent ids and dispatch names — the same operator-correlatable class as
 * `.claude/learning/artifact-activation/`, and gitignored on the same grounds.
 *
 * DEGRADES SAFELY WHERE THE LEDGER IS ABSENT. `.claude/hooks/**` is ALWAYS_INCLUDE, so this hook
 * ships to every consumer. On a consumer with no `.claude/learning/` the append fails closed inside
 * `append-sink.js`, this hook reports the drop on stderr and passes the tool through; the reconciler
 * then reports UNRESOLVED rather than a false clean.
 *
 * Origin: T1, runtime-enforcement-2026-08-14.
 */

"use strict";

// Bounded timer per `cc-artifacts.md` Rule 7. Deliberately shorter than the registered 5s timeout
// so the hook's OWN fallback fires first and emits a well-formed passthrough.
const TIMEOUT_MS = 4000;
let fallback = null;

const path = require("path");
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

function passthrough() {
  if (fallback) clearTimeout(fallback);
  try {
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  } catch {}
  process.exit(0);
}

/**
 * Resolve the main checkout FAIL-CLOSED, and SKIP the write when git cannot answer.
 *
 * NOT the legacy `resolveMainCheckout`, which silently returns `cwd` on an indeterminate
 * resolution. The allowlist in `tests/integration/multi-operator/trust-resolver-fail-closed-1471.
 * test.js` would have accepted this hook as telemetry, but that allowlist's own comment names the
 * correct remedy for a telemetry WRITE — "a WRITE to a directory we could not confirm … is a
 * different remedy (skip-and-breadcrumb)" — and its existing entries are grandfathered on "halting
 * them would be a larger behaviour change than the bug", which cannot apply to a hook landing now.
 *
 * Skipping is also the better answer for THIS stream specifically. A ledger written under an
 * unconfirmed cwd SPLITS: launch rows land in one file and delivery rows in another, which
 * manufactures orphan deliveries and degrades the reconciler's verdict to UNRESOLVED for a reason
 * that has nothing to do with delivery. Writing nothing yields a plainly ABSENT ledger, which the
 * reconciler already reports as UNRESOLVED-because-absent — the honest tri-state.
 *
 * @returns {{ok: true, repoDir: string} | {ok: false, reason: string}}
 */
function requireMainCheckoutSafely(repoDir) {
  try {
    const { requireMainCheckout } = require(path.join(__dirname, "lib", "state-resolver.js"));
    return requireMainCheckout(repoDir);
  } catch (e) {
    // The resolver itself being unloadable is equally "could not confirm" — fail closed, and NEVER
    // fall back to the raw cwd, which is precisely the legacy behaviour this avoids.
    return { ok: false, reason: `state-resolver unavailable: ${e && e.message ? e.message : String(e)}` };
  }
}

/**
 * Classify a hook payload into the record it should produce, or null.
 *
 * Pure function of (event, tool name, tool_input, prompt, agent_id) — no IO, so every branch is
 * fixture-testable without a repo on disk. Exported for exactly that reason.
 *
 * @returns {{kind, dispatchName?, subagentType?, declaredSubparts?, generation} | null}
 */
function classifyDispatchEvent(payload, lib) {
  const p = payload && typeof payload === "object" ? payload : {};
  const generation = lib.generationOf(p);
  const event = p.hook_event_name || p.hookEventName || "";
  const tool = p.tool_name || p.tool || "";

  // UserPromptSubmit carries no tool. Identify it by the prompt field OR the event name, so a
  // harness that omits either still produces the row.
  if (event === "UserPromptSubmit" || (!tool && typeof p.prompt === "string")) {
    return {
      kind: "declared",
      declaredSubparts: lib.countDeclaredSubparts(typeof p.prompt === "string" ? p.prompt : ""),
      generation,
    };
  }

  if (lib.DELEGATION_TOOLS.includes(tool)) {
    return {
      kind: "launch",
      dispatchName: lib.dispatchNameOf(p.tool_input),
      subagentType: lib.subagentTypeOf(p.tool_input),
      generation,
    };
  }

  if (lib.DELIVERY_TOOLS.includes(tool)) {
    return { kind: "delivery", generation };
  }

  // Any other tool is neither a dispatch nor a delivery. The registered matcher already excludes
  // them; this branch is the belt to that suspenders, so a widened matcher cannot write junk rows.
  return null;
}

async function main() {
  fallback = setTimeout(() => {
    try {
      process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    } catch {}
    // Exit 0, not 1: this hook must never contribute a non-zero exit to a tool call.
    process.exit(0);
  }, TIMEOUT_MS);

  try {
    const payload = await readStdinBounded();
    const lib = require(path.join(__dirname, "lib", "dispatch-ledger.js"));
    const classified = classifyDispatchEvent(payload, lib);
    if (!classified) {
      passthrough();
      return;
    }

    const sessionId = payload.session_id || "unknown-session";
    const nowIso = new Date().toISOString();
    // SKIP-AND-BREADCRUMB on an indeterminate resolution — never write under an unconfirmed root.
    const resolved = requireMainCheckoutSafely(PROJECT_DIR);
    if (!resolved.ok) {
      try {
        process.stderr.write(
          `dispatch-ledger.emit.skipped kind=${classified.kind} reason=${String(resolved.reason).slice(0, 160)}\n`,
        );
      } catch {}
      passthrough();
      return;
    }
    const repoDir = resolved.repoDir;

    let record = null;
    if (classified.kind === "launch")
      record = lib.buildLaunchRecord({
        sessionId,
        generation: classified.generation,
        dispatchName: classified.dispatchName,
        subagentType: classified.subagentType,
        nowIso,
      });
    else if (classified.kind === "delivery")
      record = lib.buildDeliveryRecord({ sessionId, generation: classified.generation, nowIso });
    else if (classified.kind === "declared")
      record = lib.buildDeclaredRecord({
        sessionId,
        generation: classified.generation,
        declaredSubparts: classified.declaredSubparts,
        nowIso,
      });

    const r = lib.appendRecord({ repoDir, record });
    if (r && r.ok === false) {
      // A dropped row degrades observability; it never blocks. stderr only — stdout is the
      // protocol channel and must carry the passthrough payload alone.
      try {
        process.stderr.write(
          `dispatch-ledger.emit.dropped kind=${classified.kind} reason=${String(r.error).slice(0, 160)}\n`,
        );
      } catch {}
    }
    passthrough();
  } catch {
    passthrough();
  }
}

if (require.main === module) {
  main();
}

module.exports = { classifyDispatchEvent };
