#!/usr/bin/env node
/**
 * emit-dispatch-ledger.js — the PRODUCER half of the dispatch↔delivery reconciliation stream (T1).
 *
 * Records three things nothing in the tree recorded before:
 *   (a) LAUNCH   — one row per subagent dispatch, carrying a UNIQUE launch id, the dispatch NAME,
 *                  the subagent type, the GENERATION the dispatch was issued from, and its LOCATION
 *                  — the session's `cwd` as received, the resolved `worktree` and `branch` — so a
 *                  dispatch can be attributed to a lane (`dispatch-ledger.js::resolveDispatchLocation`),
 *                  plus the EFFORT the launch declared and the ROLE its brief names (effort routing,
 *                  `lib/effort-routing.js`) — the launch effort a later re-task is checked against.
 *   (b) DELIVERY — one row per `SendMessage`, carrying the delivering agent's generation. ZERO
 *                  hooks observed this tool before; the moment is proven reachable because two
 *                  `*`-matcher PreToolUse hooks (adjacency-heartbeat, provenance-capture-tool)
 *                  already run on every tool call.
 *   (d) DECLARED — one row per user prompt, carrying the DECLARED sub-part COUNT and nothing else.
 *   (e) WORKFLOW-LAUNCH — one row per `Workflow` call: the `agent(` calls its script holds and how
 *                  many the effort check could not evaluate. A Workflow's agents fire no PreToolUse
 *                  of their own (finding ROOT-W1), so this row is the only trace they ran.
 *
 * The reconciler is the separate `reconcile-dispatch-delivery.js` at `SubagentStop`.
 *
 * @hook-event: PreToolUse:Task|Agent|SendMessage|Workflow (telemetry) — the dispatch and the message ARE the
 *   subject: each is a discrete tool call, present in `tool_input` at this moment and nowhere else.
 *   Records, never gates. The matcher is exactly `DELEGATION_TOOLS ∪ DELIVERY_TOOLS ∪ WORKFLOW_TOOLS`; a `*` matcher
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

/**
 * @hook-contract
 * {
 *   "side_effects": {
 *     "fs_writes": [".claude/learning/dispatch-reconcile/<session-id>-<sha8>.jsonl"],
 *     "network": false,
 *     "spawns": ["git","ps"]
 *   },
 *   "idempotent": false,
 *   "may_rewrite_input": false,
 *   "notes": "Appends one launch/delivery/declared row per invocation through lib/dispatch-ledger.js::appendRecord -> lib/append-sink.js, with no payload dedupe, so a repeat run appends another row (the reconciler then sees both). Spawns: git probes in lib/state-resolver.js::requireMainCheckout plus lib/dispatch-ledger.js::resolveDispatchLocation. A row is SKIPPED, with a stderr breadcrumb, when the main checkout cannot be confirmed; no prompt text is ever written."
 * }
 */

"use strict";

// Bounded timer per `cc-artifacts.md` Rule 7. Deliberately shorter than the registered 5s timeout
// so the hook's OWN fallback fires first and emits a well-formed passthrough.
const TIMEOUT_MS = 4000;
/**
 * Held back from `TIMEOUT_MS` so the append and the passthrough still fit after git answers — for
 * BOTH git consumers: the main-checkout resolution (`resolverOptsFor`) and the dispatch location.
 */
const LOCATION_SAFETY_MS = 600;
let fallback = null;

const path = require("path");
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

/**
 * The dispatching session's working directory, and WHICH source supplied it. Pure.
 *
 * `payload.cwd` FIRST: the harness reports it on every hook payload, which is why
 * `repo-dir-override.js::unoverriddenSeed` uses it as the un-spoofable baseline. This hook's OWN
 * process directory is not the session's — hooks execute from `CLAUDE_PROJECT_DIR`, the directory the
 * session STARTED in (`dispatch-ledger.js` header) — so each fallback is recorded BY NAME in
 * `cwd_source` rather than passed off as the payload's value.
 *
 * @returns {{cwd: string|null, source: string|null}}
 */
function dispatchCwdOf(payload, env, processCwd) {
  const p = payload && typeof payload === "object" ? payload : {};
  if (typeof p.cwd === "string" && p.cwd.length > 0) return { cwd: p.cwd, source: "payload.cwd" };
  const e = env && typeof env === "object" ? env : {};
  if (typeof e.CLAUDE_PROJECT_DIR === "string" && e.CLAUDE_PROJECT_DIR.length > 0)
    return { cwd: e.CLAUDE_PROJECT_DIR, source: "CLAUDE_PROJECT_DIR" };
  if (typeof processCwd === "string" && processCwd.length > 0) return { cwd: processCwd, source: "process.cwd()" };
  return { cwd: null, source: null };
}

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
 * BOUNDED BY THIS HOOK'S OWN BUDGET. `opts` is forwarded to the resolver, whose git probes then
 * run inside the deadline this hook's timer implies rather than under a per-probe cap (5000 ms)
 * that alone exceeded `TIMEOUT_MS`. A spent budget is the same skip-and-breadcrumb as any other
 * unconfirmed root (`code: "budget-exhausted"`).
 *
 * @param {string} repoDir
 * @param {{deadline?: number, budgetMs?: number}} [opts]
 * @returns {{ok: true, repoDir: string} | {ok: false, reason: string, code?: string}}
 */
function requireMainCheckoutSafely(repoDir, opts) {
  try {
    const { requireMainCheckout } = require(path.join(__dirname, "lib", "state-resolver.js"));
    return requireMainCheckout(repoDir, opts);
  } catch (e) {
    // The resolver itself being unloadable is equally "could not confirm" — fail closed, and NEVER
    // fall back to the raw cwd, which is precisely the legacy behaviour this avoids.
    return { ok: false, reason: `state-resolver unavailable: ${e && e.message ? e.message : String(e)}` };
  }
}

/**
 * The resolver's deadline for a hook run that started at `startedAt` (epoch ms): this hook's own
 * `TIMEOUT_MS`, less `LOCATION_SAFETY_MS`, so a resolution that uses its whole budget still returns
 * while the append and the passthrough fit before the fallback timer fires. Pure.
 */
function resolverOptsFor(startedAt) {
  return { deadline: startedAt + TIMEOUT_MS - LOCATION_SAFETY_MS };
}

/**
 * The effort a launch DECLARED and the ROLE its brief names (effort routing, 2026-10-12), read with
 * the SAME parser the dispatch-contract guard enforces with (`lib/effort-routing.js`), so the ledger
 * records exactly the pairing the guard judged. Both are null when absent — never a default. Pure;
 * the ROLE is the only thing read from the brief, and no brief text is returned.
 *
 * A `fork` records effort NULL whatever it declared: the harness runs a fork at its parent's effort,
 * so a recorded level would be a level that never ran, and every reader treats null as UNKNOWN.
 *
 * `effortRouted` is the routing verdict the guard will reach on this launch (`decideLaunch` against
 * the shipped table — no block-class finding). This producer runs BEFORE the guard, so a launch the
 * guard then BLOCKS is recorded too; the tag lets a re-task read the launch that actually went
 * through (`effort-routing.js::launchEffortFor`). It is null when the verdict cannot be computed.
 *
 * A library that will not load yields nulls: this producer is telemetry and must never fail a
 * dispatch, and a null effort reads downstream as UNKNOWN (advisory), never as a level.
 *
 * @returns {{effort: string|null, role: string|null, effortRouted: boolean|null}}
 */
function declaredEffortOf(toolInput) {
  try {
    const er = require(path.join(__dirname, "lib", "effort-routing.js"));
    const ti = toolInput && typeof toolInput === "object" ? toolInput : {};
    let effortRouted = null;
    try {
      effortRouted = !er.decideLaunch(ti, er.loadRoutingTable()).findings.some((f) => f.severity === "block");
    } catch {
      effortRouted = null;
    }
    return {
      effort: ti.subagent_type === er.FORK_SUBAGENT_TYPE ? null : er.effortOf(ti),
      role: er.parseBriefHeader(typeof ti.prompt === "string" ? ti.prompt : "").role,
      effortRouted,
    };
  } catch {
    return { effort: null, role: null, effortRouted: null };
  }
}

/**
 * What a Workflow call's script declares, for its `workflow-launch` row (finding ROOT-W1): the
 * number of `agent(` calls and how many the effort check cannot evaluate, from the SAME scanner and
 * decision the guard uses. Telemetry: a library that will not load, or a script that cannot be read,
 * yields nulls — never a thrown dispatch.
 *
 * @returns {{agentsFound: number|null, unresolved: number|null, scriptSource: string|null}}
 */
function workflowCountsOf(toolInput) {
  try {
    const ws = require(path.join(__dirname, "lib", "workflow-launch-scan.js"));
    const er = require(path.join(__dirname, "lib", "effort-routing.js"));
    const resolved = ws.resolveWorkflowScript(toolInput);
    const scan = resolved.ok ? ws.scanWorkflowScript(resolved.text) : null;
    const { summary } = er.decideWorkflowLaunch(resolved, scan, er.loadRoutingTable());
    return { agentsFound: summary.agents_found, unresolved: summary.unresolved, scriptSource: resolved.source };
  } catch {
    return { agentsFound: null, unresolved: null, scriptSource: null };
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
      ...declaredEffortOf(p.tool_input),
      generation,
    };
  }

  if (lib.DELIVERY_TOOLS.includes(tool)) {
    return { kind: "delivery", generation };
  }

  if (lib.WORKFLOW_TOOLS.includes(tool)) return { kind: "workflow-launch", ...workflowCountsOf(p.tool_input), generation };

  // Any other tool is neither a dispatch nor a delivery. The registered matcher already excludes
  // them; this branch is the belt to that suspenders, so a widened matcher cannot write junk rows.
  return null;
}

async function main() {
  const startedAt = Date.now();
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

    // ONE derivation, shared with the consumer and with both path mappers
    // (`dispatch-ledger.js::resolveSessionId`). The literal `"unknown-session"` that stood here
    // was a SHARED CONSTANT where a UNIQUE value is required: every id-less session wrote into
    // one sink, and the consumer's fence could never separate them. See that function's header.
    const sessionId = lib.resolveSessionId(payload.session_id);
    const nowIso = new Date().toISOString();
    // SKIP-AND-BREADCRUMB on an indeterminate resolution — never write under an unconfirmed root.
    const resolved = requireMainCheckoutSafely(PROJECT_DIR, resolverOptsFor(startedAt));
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
    if (classified.kind === "launch") {
      let processCwd = null;
      try {
        processCwd = process.cwd();
      } catch {}
      const where = dispatchCwdOf(payload, process.env, processCwd);
      // BOUNDED by what is left of this hook's own timeout. A location git cannot answer in time is
      // recorded null WITH A REASON — the row is still written, never dropped for it.
      const location = lib.resolveDispatchLocation({
        cwd: where.cwd,
        cwdSource: where.source,
        budgetMs: TIMEOUT_MS - (Date.now() - startedAt) - LOCATION_SAFETY_MS,
      });
      record = lib.buildLaunchRecord({
        sessionId,
        generation: classified.generation,
        dispatchName: classified.dispatchName,
        subagentType: classified.subagentType,
        effort: classified.effort,
        role: classified.role,
        effortRouted: classified.effortRouted,
        nowIso,
        location,
      });
    } else if (classified.kind === "delivery")
      record = lib.buildDeliveryRecord({ sessionId, generation: classified.generation, nowIso });
    else if (classified.kind === "workflow-launch")
      record = lib.buildWorkflowLaunchRecord({
        sessionId,
        generation: classified.generation,
        agentsFound: classified.agentsFound,
        unresolved: classified.unresolved,
        scriptSource: classified.scriptSource,
        nowIso,
      });
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

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js).
function hookMain() {
  return main();
}

module.exports = { classifyDispatchEvent, declaredEffortOf, workflowCountsOf, dispatchCwdOf, requireMainCheckoutSafely, resolverOptsFor, hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
