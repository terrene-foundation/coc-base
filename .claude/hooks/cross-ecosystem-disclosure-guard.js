#!/usr/bin/env node
/**
 * @hook-event: PreToolUse:Edit|NotebookEdit|Write (guard) — the pending write can declare its target ecosystem before disclosure; ordinary writes without that declaration pass through.
 *
 * Hook: cross-ecosystem-disclosure-guard
 * Event: PreToolUse on Edit | Write (mutation tools)
 *
 * The STANDALONE canon<->fork disclosure-isolation pre-write guard ENTRY POINT
 * (issue #584 AC-1). It wires lib/cross-ecosystem-disclosure-guard.js into the
 * canonical instruct-and-wait emit shape (hook-output-discipline.md MUST-1).
 *
 * REGISTERED (F3 Level-1, 2026-06-25, journal/0335) — ITS BLOCK BRANCH DORMANT:
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
 *   The consumer that would declare a target is the sync-from-canon driver's
 *   AC-2 intake-path routing (#576's driver SHIPPED, but its AC-2 routing — which
 *   would invoke THIS guard on the pulled surface — is UNBUILT). Separately, the AUTONOMOUS cross-ecosystem
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
 *   the write — e.g. a cross-repo grant naming canon, or the sync-from-canon
 *   driver's AC-2 intake-path routing (driver shipped #576; that guard-routing
 *   UNBUILT)). Absent that declaration
 *   the hook is a no-op, so it never blocks ordinary in-fork edits.
 *
 * SEVERITY (once activated): `block`, under the DISCLOSURE-ISOLATION EXCEPTION in
 *   hook-output-discipline.md MUST-2 — NOT because the whole decision is structural.
 *   Two halves, and only one of them is: the BOUNDARY is computed structurally from
 *   the SHIPPED ecosystem.json upstream_canon pointer + the declared target ecosystem
 *   (a deterministic process-local fact), and that structural gate is what makes the
 *   block branch REACHABLE AT ALL — absent a declared target this hook passes through,
 *   so its false-positive surface is bounded to writes already declared as crossing
 *   the boundary. But the boundary alone does not BLOCK: a clean fork->canon write
 *   passes. The DISCRIMINATOR is the disclosure scan's findings, and a content scan is
 *   exactly what MUST-2's general rule bars from carrying `block`. An earlier revision
 *   of this header called the scan half "structural too"; that was FALSE and is
 *   retracted here. The exception, not a structurality claim, is the licence.
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

let fallback = null;

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

const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

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

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). Everything a standalone run
// did at load time happens here instead, so a require() has no side effects.
function hookMain() {
  fallback = setTimeout(() => {
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    process.exit(1);
  }, TIMEOUT_MS);
  return main();
}

async function main() {
  try {
    // `fallback: null` distinctly signals a FAILED/EMPTY read. readStdinBounded
    // NEVER throws (it resolves the fallback on empty/parse-error/timeout), so
    // after the #859 async swap a failed read can NO LONGER reach the catch
    // block's fail-CLOSED-when-declared branch below — an empty payload would fall
    // through `!isMutationTool(undefined)` → passthrough = fail-OPEN even with a
    // DECLARED fork->canon target (security redteam MED-1). Detect the sentinel
    // HERE and fail CLOSED when a target is declared, mirroring the catch branch.
    const payload = await readStdinBounded({ fallback: null });
    if (payload === null) {
      const declaredTargetOnEmpty = process.env.COC_XECO_TARGET_ECOSYSTEM;
      if (
        declaredTargetOnEmpty &&
        String(declaredTargetOnEmpty).trim() !== ""
      ) {
        clearTimeout(fallback);
        emit({
          hookEvent: "PreToolUse",
          severity: "block",
          what_happened: `cross-ecosystem-disclosure-guard could not read the tool payload for declared fork->canon target '${declaredTargetOnEmpty}' (empty/unparseable stdin).`,
          why: 'A fork->canon write-target is DECLARED (COC_XECO_TARGET_ECOSYSTEM set) but the tool payload could not be read, so the canon<->fork boundary + disclosure scan CANNOT run. Per security.md (fail CLOSED on ambiguity) + artifact-flow.md § "Ecosystem Forks vs Downstream Consumers": an unverifiable declared fork->canon write MUST NOT proceed. (readStdinBounded fails OPEN by contract for ordinary sessions; a DECLARED cross-ecosystem target overrides that to fail CLOSED — the same posture as the malformed-ecosystem.json catch branch.)',
          agent_must_report: [
            `Declared target ecosystem: ${declaredTargetOnEmpty}`,
            "The tool payload (stdin) was empty or unparseable — the disclosure scan and canon<->fork boundary check could not run.",
            "Retry the write with a well-formed payload, or unset COC_XECO_TARGET_ECOSYSTEM if no cross-ecosystem write is intended.",
          ],
          agent_must_wait:
            "Do not retry the declared fork->canon write until the payload is readable.",
          user_summary: `cross-ecosystem-disclosure-guard — BLOCK: unreadable payload on declared fork->canon target '${declaredTargetOnEmpty}'`,
        });
        // emit() exits.
      }
      // No declared target — ordinary session with an unreadable payload: fail
      // OPEN (the documented infra-failure posture; no cross-ecosystem write).
      passthrough();
    }
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

    // Injected disclosure findings (tests) take precedence over the scan: when
    // an explicit findings array is supplied, checkForkIdentifyingContent's
    // findings branch wins and the scanFn does not run.
    const injectedFindings = parseMaybeJson(process.env.COC_XECO_FINDINGS_JSON);
    if (Array.isArray(injectedFindings)) guardOpts.findings = injectedFindings;

    // The fork->canon write SURFACE to disclosure-scan (the AC-2 production path,
    // #576 Shard D). Supplied via the COC_XECO_SCAN_CONTENT env — the channel the
    // sync-from-canon driver (#576, shipped; its AC-2 guard-routing UNBUILT) would use to thread the pulled surface
    // through the guard, mirroring how every other guard opt is injected here
    // (see the hook header's ENV OVERRIDES note). ABSENT it, no scannable surface
    // reaches the guard and the lib's default scanFn returns ran:false ->
    // checkForkIdentifyingContent fails CLOSED (the inherited invariant), so an
    // ordinary declared-target write with no surface still blocks-as-unverified.
    // Deliberately NOT read from payload.tool_input.content: scanning every
    // declared-target Edit/Write body would change the fail-closed semantics of
    // the no-surface case; the driver/tests opt in explicitly via this env.
    const scanContent = process.env.COC_XECO_SCAN_CONTENT;
    if (typeof scanContent === "string" && scanContent !== "") {
      guardOpts.content = scanContent;
    }

    // A repo-scope-discipline.md:30 User-Authorized Exception grant, if present,
    // is surfaced to the lib so the audit trail records "grant present but NOT
    // honored" — the envelope-expansion close. The grant does NOT bypass the
    // guard (the lib enforces this regardless of the flag).
    if (process.env.COC_XECO_REPO_SCOPE_GRANT === "1") {
      guardOpts.repoScopeGrant = true;
    }

    const result = await guardLib.guardForkToCanonWrite(guardOpts);

    if (result.ok) passthrough();

    // BLOCK — under the DISCLOSURE-ISOLATION exception in `hook-output-discipline.md`
    // MUST-2, NOT as a structural signal. An earlier revision of this comment claimed
    // "structural boundary primitive", and that claim was FALSE: the fork->canon
    // BOUNDARY is structural, but the boundary alone does not block — a clean
    // fork->canon write passes. The DISCRIMINATOR is the content scan, and a content
    // scan is exactly what MUST-2's general rule bars from carrying `block`.
    //
    // The exception's conditions, each with the code that satisfies it (cited per
    // `zero-tolerance.md` Rule 3e, which binds code COMMENTS asserting guard
    // predicates):
    //   (a) STRUCTURAL PRECONDITION — the block branch is reachable only behind a
    //       declared cross-ecosystem target: `cross-ecosystem-disclosure-guard.js:172`
    //       (`if (!targetEcosystem) passthrough();`). This is what keeps a false
    //       positive off ordinary in-repo work, which is MUST-2's whole stated harm.
    //   (b) CONFIDENTIALITY across a tenancy boundary — canon is the shared upstream
    //       every fork pulls from (`rules/artifact-flow.md` § Ecosystem Forks).
    //   (c) IRREVERSIBLE — a leak onto canon is correlatable across every other client
    //       and cannot be recalled.
    //   (d) FAILS CLOSED WHENEVER A SCAN IS REQUIRED — an unverified scan refuses:
    //       `lib/cross-ecosystem-disclosure-guard.js:569-575` maps an unverified
    //       verdict to `reason: "disclosure-unverified"` on the `ok:false` path.
    //       NOT a claim that the guard never allows an unscanned write: the
    //       public-authority-O1 carve-out at `lib/cross-ecosystem-disclosure-guard.js:554-561`
    //       establishes neutrality by AUTHORITY rather than by scan. It is
    //       allowlist-gated and ANY finding overrides it, which is what keeps it
    //       inside condition (d) rather than an exception to it.
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
}

module.exports = { hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
