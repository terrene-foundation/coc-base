#!/usr/bin/env node
/**
 * Hook: cross-ecosystem-disclosure-guard
 * Event: PreToolUse on Edit | Write (mutation tools)
 *
 * The STANDALONE canon<->fork disclosure-isolation pre-write guard ENTRY POINT
 * (issue #584 AC-1). It wires lib/cross-ecosystem-disclosure-guard.js into the
 * canonical instruct-and-wait emit shape (hook-output-discipline.md MUST-1).
 *
 * REGISTERED (F3 Level-1, 2026-06-25, journal/0335) BUT DORMANT-UNTIL-#576:
 *   This file IS registered in settings.json on the Edit|Write|NotebookEdit
 *   PreToolUse matcher, so it RUNS live on every mutation — but its BLOCK branch
 *   is DORMANT until a write DECLARES a target ecosystem. Two gates send every
 *   ordinary edit to passthrough (defense-in-depth):
 *     (1) ENTRY-POINT short-circuit — fires FIRST, the overwhelming common case:
 *         absent a declared target (COC_XECO_TARGET_ECOSYSTEM env OR
 *         payload.tool_input.target_ecosystem) `!targetEcosystem` passthroughs
 *         BEFORE any ecosystem-config load, so an ordinary in-repo edit (and even
 *         a corrupt ecosystem.json) never blocks.
 *     (2) LIB boundary — fires when a target IS declared: on canon (loom has no
 *         ecosystem.json) getUpstreamCanon() is null → recognizeBoundary returns
 *         intra-ecosystem → passthrough. The BLOCK branch only fires in a FORK
 *         (upstream_canon set) whose write DECLARES the canon target.
 *   The ONLY consumer that declares a target is the DEFERRED sync-from-canon
 *   driver (#576 / AC-2, UNBUILT). Separately, the AUTONOMOUS cross-ecosystem
 *   write-DETECTION an always-on fence needs (catching an ad-hoc fork->canon
 *   push) is Level-2, depending on the deferred ecosystem-remote resolver
 *   (cross-repo.md § "Ecosystem-Scoped Remote Links (design contract)" — not yet
 *   built). Until #576/Level-2 the canon<->fork disclosure-isolation invariant is
 *   ALSO held by the two general-purpose fences (repo-scope-discipline.md's
 *   cross-repo-write prohibition + the publish-to-public.mjs INCLUDE allowlist);
 *   see artifact-flow.md § "Ecosystem Forks vs Downstream Consumers". This header
 *   stays consistent with the lib header's SCOPE note.
 *
 * WHAT IT GUARDS (once activated):
 *   A fork->canon write of fork-IDENTIFYING content — refused even under a
 *   repo-scope-discipline.md:30 User-Authorized Exception grant — closing the
 *   envelope-expansion gap artifact-flow.md names (the bidirectional
 *   disclosure-isolation invariant rests on two general-purpose fences, neither
 *   canon<->fork-aware; this guard IS the canon<->fork-aware fence).
 *
 * GATING (deliberately narrow — the boundary is a declared fact):
 *   A generic Edit/Write payload does NOT carry a fork->canon write intent; the
 *   overwhelming common case is a fork (or canon) editing its OWN surface, which
 *   recognizeBoundary() classifies "intra-ecosystem" → silent passthrough. The
 *   guard's BLOCK branch fires ONLY when the session has DECLARED a fork->canon
 *   target via the COC_XECO_TARGET_ECOSYSTEM env (the destination ecosystem of
 *   the write — e.g. a cross-repo grant naming canon, or the future
 *   sync-from-canon reverse direction once #576 lands). Absent that declaration
 *   the hook is a no-op, so it never blocks ordinary in-fork edits.
 *
 * SEVERITY (once activated): `block`. The boundary is computed STRUCTURALLY from
 *   the SHIPPED ecosystem.json upstream_canon pointer + the declared target
 *   ecosystem — a deterministic process-local fact the agent cannot rationalize
 *   away — so it qualifies as a block-grade structural primitive per
 *   hook-output-discipline.md MUST-2. (The disclosure scan half is structural
 *   too: a finding-count from the SHIPPED scanner, not a lexical match on agent
 *   prose.)
 *
 * ≤5s budget per cc-artifacts.md Rule 7; setTimeout fallback returns
 * {continue: true} (fail-OPEN on hook-internal hang — the fail-CLOSED behavior
 * applies to the disclosure check inside the lib, not the timeout safety net).
 *
 * ENV OVERRIDES (test injection only):
 *   COC_XECO_TARGET_ECOSYSTEM  — the declared write-target ecosystem ("canon",
 *                                a remote, or a {remote}/{url} JSON). Absence =
 *                                intra-ecosystem (no-op).
 *   COC_XECO_UPSTREAM_CANON    — JSON of the upstream_canon pointer (test inject
 *                                of the fork-vs-canon discriminator); absent =
 *                                read the SHIPPED ecosystem-config loader.
 *   COC_XECO_O1_AUTHORITY      — declared O1 public authority (carve-out probe).
 *   COC_XECO_FINDINGS_JSON     — JSON array of injected disclosure findings.
 */

"use strict";

const TIMEOUT_MS = 5000;

const fallback = setTimeout(() => {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(1);
}, TIMEOUT_MS);

const fs = require("fs");
const path = require("path");

const { emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js"));
const guardLib = require(
  path.join(__dirname, "lib", "cross-ecosystem-disclosure-guard.js"),
);
const { isMutationTool } = require(
  path.join(__dirname, "lib", "tool-classes.js"),
);

function passthrough() {
  clearTimeout(fallback);
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

function readStdinSync() {
  try {
    const data = fs.readFileSync(0, "utf8");
    if (!data || !data.trim()) return {};
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function parseMaybeJson(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const t = raw.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t);
    } catch {
      return t; // not JSON — treat as a literal (e.g. a remote string)
    }
  }
  return t;
}

(async function main() {
  try {
    const payload = readStdinSync();
    const hookEvent = payload.hook_event_name || "PreToolUse";

    // Only mutation tools (Edit/Write/...) cross a write boundary.
    if (!isMutationTool(payload && payload.tool_name)) passthrough();

    // The fork->canon write target is a DECLARED fact (env or payload). Absent a
    // declared canon-target, recognizeBoundary() returns intra-ecosystem and the
    // guard is a no-op — so ordinary in-fork edits never block.
    const targetEcosystem =
      parseMaybeJson(process.env.COC_XECO_TARGET_ECOSYSTEM) ||
      (payload.tool_input && payload.tool_input.target_ecosystem) ||
      undefined;

    if (!targetEcosystem) passthrough();

    const guardOpts = { targetEcosystem };

    // upstream_canon discriminator: env-injected for tests; else the SHIPPED
    // ecosystem-config loader (getUpstreamCanonFn unset → recognizeBoundary
    // reads the loader).
    const injectedUpstream = parseMaybeJson(
      process.env.COC_XECO_UPSTREAM_CANON,
    );
    if (injectedUpstream !== undefined) {
      guardOpts.upstreamCanon =
        injectedUpstream === "null" ? null : injectedUpstream;
    }

    // O1 public-authority carve-out probe.
    const o1Authority = process.env.COC_XECO_O1_AUTHORITY;
    if (o1Authority && o1Authority.trim() !== "") {
      guardOpts.o1 = true;
      guardOpts.authority = o1Authority.trim();
    }

    // Injected disclosure findings (tests). Production wiring of the SHIPPED
    // scan-synced-disclosure surface lands with AC-2's intake path (#576).
    const injectedFindings = parseMaybeJson(process.env.COC_XECO_FINDINGS_JSON);
    if (Array.isArray(injectedFindings)) guardOpts.findings = injectedFindings;

    // A repo-scope-discipline.md:30 User-Authorized Exception grant, if present,
    // is surfaced to the lib so the audit trail records "grant present but NOT
    // honored" — the envelope-expansion close. The grant does NOT bypass the
    // guard (the lib enforces this regardless of the flag).
    if (process.env.COC_XECO_REPO_SCOPE_GRANT === "1") {
      guardOpts.repoScopeGrant = true;
    }

    const result = await guardLib.guardForkToCanonWrite(guardOpts);

    if (result.ok) passthrough();

    // BLOCK — structural boundary primitive (hook-output-discipline.md MUST-2).
    clearTimeout(fallback);
    emit({
      hookEvent,
      severity: "block",
      what_happened: `fork->canon write to '${typeof targetEcosystem === "string" ? targetEcosystem : JSON.stringify(targetEcosystem)}' refused: ${result.reason}.`,
      why: "cross-ecosystem-disclosure-guard (#584) — the canon<->fork bidirectional disclosure-isolation invariant (artifact-flow.md:52). A client ecosystem fork MUST NOT push its tenant identity or work back to canon; canon is a multi-tenant-shared surface and a fork leak is correlatable across every other client. This guard is canon<->fork-AWARE and fires EVEN UNDER a repo-scope-discipline.md:30 User-Authorized Exception grant (the grant lifts the general cross-repo-write prohibition, NOT this distinct isolation invariant).",
      agent_must_report: [
        `Target ecosystem (declared): ${typeof targetEcosystem === "string" ? targetEcosystem : JSON.stringify(targetEcosystem)}`,
        `Refusal reason: ${result.reason}`,
        result.findings && result.findings.length
          ? `Fork-identifying findings: ${result.findings.slice(0, 5).join("; ")}`
          : "Disclosure scan produced no clean verdict (UNVERIFIED — fails closed per evidence-first-claims.md MUST-3).",
        result.grant_present_but_not_honored
          ? "A repo-scope User-Authorized Exception grant was present but does NOT bypass this guard."
          : "No repo-scope grant present; the general cross-repo fence would also block this.",
        "Genericize + relocate the fork-identifying content, OR — for a PUBLIC ISO/SOC2/GDPR O1 artifact — declare it as O1 with its public authority (artifact-flow.md:200, ecosystem-neutral).",
      ],
      agent_must_wait:
        "Do not retry the fork->canon write until the surface is genericized + relocated (or proven to be a public-authority O1 artifact).",
      user_summary: `cross-ecosystem-disclosure-guard — BLOCK fork->canon (${result.reason})`,
    });
    // emit() exits.
  } catch (err) {
    const errMsg = err && err.message ? err.message : String(err);

    // FAIL-CLOSED when a fork->canon session is DECLARED. If the session set
    // COC_XECO_TARGET_ECOSYSTEM, the operator has declared a cross-ecosystem
    // write-target — so a boundary-recognition throw (e.g. EcosystemConfigError
    // on a malformed ecosystem.json) means we CANNOT verify the canon<->fork
    // boundary, and silently passing through would let a fork->canon write land
    // unchecked. Per security.md (fail CLOSED on ambiguity, never silently
    // fail-open) + zero-tolerance.md Rule 3 (a fail-closed emits a typed block,
    // not a passthrough): emit a block-grade halt naming the cause.
    const declaredTarget = process.env.COC_XECO_TARGET_ECOSYSTEM;
    if (declaredTarget && String(declaredTarget).trim() !== "") {
      try {
        clearTimeout(fallback);
        emit({
          hookEvent: "PreToolUse",
          severity: "block",
          what_happened: `cross-ecosystem-disclosure-guard could not verify the canon<->fork boundary for declared target '${declaredTarget}': ${errMsg}`,
          why: 'ecosystem.json malformed — cannot verify canon<->fork boundary. A fork->canon write-target is DECLARED (COC_XECO_TARGET_ECOSYSTEM set), so the canon<->fork disclosure-isolation invariant (artifact-flow.md § "Ecosystem Forks vs Downstream Consumers") fails CLOSED: a write whose boundary cannot be verified MUST NOT proceed (security.md — fail closed on ambiguity).',
          agent_must_report: [
            `Declared target ecosystem: ${declaredTarget}`,
            `Boundary-recognition error: ${errMsg}`,
            "The ecosystem.json upstream_canon pointer could not be read/parsed; the canon<->fork boundary is UNVERIFIABLE.",
            "Repair the ecosystem.json upstream_canon pointer (or unset COC_XECO_TARGET_ECOSYSTEM if no cross-ecosystem write is intended) before retrying.",
          ],
          agent_must_wait:
            "Do not retry the declared fork->canon write until the ecosystem.json boundary is verifiable.",
          user_summary: `cross-ecosystem-disclosure-guard — BLOCK: ecosystem.json malformed, cannot verify canon<->fork boundary (target '${declaredTarget}')`,
        });
        // emit() exits.
      } catch (emitErr) {
        // emit() itself failed — fall through to the structural-NULL fallback
        // below so a guard bug never permanently wedges the session.
        try {
          process.stderr.write(
            `[ADVISORY] cross-ecosystem-disclosure-guard fail-closed emit failed: ${emitErr && emitErr.message ? emitErr.message : String(emitErr)}\n`,
          );
        } catch {
          // best-effort
        }
      }
    }

    // Defense-in-depth: structural-NULL fallback (fail-OPEN on a GENERIC
    // hook-internal error with NO target declared, so a guard bug never wedges
    // an ordinary in-fork session; the fail-CLOSED branch above covers the
    // declared-fork->canon case + the disclosure check inside the lib fails
    // CLOSED independently).
    try {
      process.stderr.write(
        `[ADVISORY] cross-ecosystem-disclosure-guard internal error: ${errMsg}\n`,
      );
    } catch {
      // best-effort
    }
    try {
      clearTimeout(fallback);
      process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    } catch {
      // best-effort
    }
    process.exit(0);
  }
})();
