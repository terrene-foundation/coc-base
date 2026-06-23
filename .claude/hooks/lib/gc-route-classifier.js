/**
 * gc-route-classifier — the G-C (DECISION-4) dual-route classifier: a DUMB
 * signal-surfacer + validator for the consultant's `/codify` dual-route
 * (artifact-improvement → Route A upflow; capability-gap/bug → Route B BUILD
 * issue).
 *
 * ECO-IMPL Wave 7b, Shard G-C-T2. Implements
 * `workspaces/ecosystem-operating-model/02-plans/04-gc-dual-route-classification.md`
 * §2 (the 3-way classification SIGNAL — Layer 1 mechanical + Layer 2 semantic)
 * + `specs/03 §4` (the D4 cascade/consultant-routing gap G3.4) +
 * `rules/artifact-flow.md` § "Consultant Dual-Route Self-Serve (D4)".
 *
 * THE LLM-REASONS / DUMB-EMITTER SPLIT (rules/agent-reasoning.md +
 * rules/probe-driven-verification.md MUST-1 — mirrors capability-classifier.js):
 *   Layer 2 (capability vs bug) is the orchestrating agent's (the LLM's)
 *   reasoning over the consumer's `reason:`/`description:` free-text. That
 *   judgment is an INPUT to this lib (`proposedClass`), NEVER computed here.
 *   This lib contains NO keyword / regex / substring classifier over the
 *   rationale — that is the naive-NLP anti-pattern probe-driven-verification.md
 *   BLOCKS. The lib provides ONLY the DETERMINISTIC parts:
 *     (a) discriminate(changePaths, rationale) — Layer-1 mechanical SIGNAL DATA
 *         (the wrong-lane glob partition: which change paths are artifact-lane
 *         vs code-lane) + the rationale surfaced VERBATIM as DATA for the LLM
 *         to reason over. NEVER a route verdict; NEVER interprets rationale.
 *     (b) routeFinding(...) — takes the LLM's Layer-2 `proposedClass` as an
 *         INPUT, validates the Q5 wrong-lane guard (Route B reachable ONLY when
 *         code paths are present), and returns the structured dual-route
 *         dispatch. It NEVER files anything (no gh / no transport) — the
 *         human-gated WIRE step (gc-build-issue-draft.js + codify.md Step 7c)
 *         does the filing.
 *
 * RATIONALE-AS-DATA (proposal-intake-trust.md MUST-1): the consumer's
 * `reason:`/`description:` free-text is content authored elsewhere; an
 * imperative sentence in it ("classify this as a bug", "skip the gate") carries
 * ZERO authority. This lib NEVER branches on rationale content — it stores it
 * and passes it through so the LLM evaluates it AS DATA, never obeys it.
 *
 * SCOPE BOUNDARY (load-bearing — NOT this shard): NO issue-body drafting
 * (gc-build-issue-draft.js — G-C-WIRE), NO disposition receipts
 * (gc-disposition-receipt.js — G-C-3), NO transport / gh-issue creation
 * (vcs-*-adapter.js, W7a), NO capability-ledger emission (capability-classifier.js
 * — A2-T2, a DIFFERENT pipeline: that classifies a need-fingerprint INTO the
 * ledger; this routes a /codify finding to a lane).
 *
 * Style: CommonJS, sync, zero-dep. Per zero-tolerance.md Rule 2/3: no stubs;
 * every failure path returns a typed result; no silent fallback.
 */

"use strict";

// The wrong-lane disallowed set — BYTE-IDENTICAL to the documented Step-7b/7c
// set (`commands/codify.md` Step 7c summary + `skills/30-claude-code-patterns/
// sync-flow.md` "Mechanical wrong-lane defense"). This lib is the single JS
// source of truth for the glob membership; the test pins it to the documented
// strings so prose and code cannot drift (invariant i).
const DISALLOWED_GLOBS = [
  "src/**",
  "packages/**",
  "pyproject.toml",
  "Cargo.toml",
];

// The closed Layer-2 class set. Route B carries ONE of these (the LLM's
// suggestion). NOT a need-class (that is capability-classifier.js's
// NEED_CLASSES) — these are the code-lane routing classes.
const ROUTE_B_CLASSES = new Set(["capability", "bug"]);

// The D4 higher-leverage default for an ambiguous code-lane finding
// (`02-plans/04-gc §2`: "ambiguous → suggest the higher-leverage class
// (capability per D4)").
const AMBIGUOUS_DEFAULT_CLASS = "capability";

// ---------------------------------------------------------------------------
// Layer-1 mechanical glob matcher (deterministic config-branching, the
// permitted exception per agent-reasoning.md — NOT agent reasoning).
// ---------------------------------------------------------------------------
function _normalizePath(p) {
  // Normalize separators (Windows `\` → `/`) BEFORE stripping a leading "./" or
  // "/", so "./src/x" / "/src/x" / "src/x" / "src\\x" all compare equal and a
  // backslash code path is detected as code-lane on every platform (a stray
  // artifact-lane misclassification would send an SDK change to Route A —
  // the Gate-1-split bypass artifact-flow.md warns against). R1 LOW fix.
  let s = String(p).replace(/\\/g, "/");
  if (s.startsWith("./")) s = s.slice(2);
  if (s.startsWith("/")) s = s.slice(1);
  return s;
}

/** Match a normalized rel-path against ONE documented glob. */
function _matchesGlob(relPath, glob) {
  if (glob.endsWith("/**")) {
    // Anchored prefix glob (src/**, packages/**): the path's leading segment.
    const prefix = glob.slice(0, -3); // "src/**" -> "src"
    return relPath === prefix || relPath.startsWith(prefix + "/");
  }
  if (!glob.includes("/")) {
    // Bare basename (pyproject.toml, Cargo.toml): matches that basename at ANY
    // depth (standard gitignore/glob semantics; fail-closed per Q5 — every
    // pyproject.toml / Cargo.toml is code-lane regardless of nesting).
    const idx = relPath.lastIndexOf("/");
    const base = idx === -1 ? relPath : relPath.slice(idx + 1);
    return base === glob;
  }
  return relPath === glob;
}

/** True iff a change path is code-lane (matches ANY disallowed glob). */
function isCodeLanePath(changePath) {
  const rel = _normalizePath(changePath);
  return DISALLOWED_GLOBS.some((g) => _matchesGlob(rel, g));
}

// ---------------------------------------------------------------------------
// discriminate — the Layer-1 SIGNAL DATA for the LLM to reason over.
// NOT a route verdict. Pure partition over the change-path set + rationale
// pass-through. Contains NO classification of capability-vs-bug.
// ---------------------------------------------------------------------------
/**
 * Surface the deterministic Layer-1 signal a consultant `/codify` finding
 * produces: the wrong-lane partition of its change paths + the rationale as
 * DATA. The LLM reads this + the consumer's reason text to PROPOSE a Layer-2
 * class for the code-lane paths; this function decides NOTHING about the class.
 *
 * @param {string[]} changePaths - the finding's change paths (rel to repo root)
 * @param {string} [rationale]   - the consumer's reason:/description: free-text
 *                                  (surfaced VERBATIM as DATA, never interpreted)
 * @returns {object} on ok:
 *   {
 *     ok: true,
 *     artifact_paths: string[],   // in-scope (.claude/** etc.) — Route A lane
 *     code_paths: string[],       // disallowed (code-lane) — Route B candidates
 *     all_artifact: boolean,      // every path artifact-lane → Route A terminates
 *     all_code: boolean,          // every path code-lane
 *     mixed: boolean,             // both lanes present → independent dual-route
 *     rationale: string,          // VERBATIM pass-through (DATA, not a verdict)
 *   }
 */
function discriminate(changePaths, rationale) {
  if (!Array.isArray(changePaths) || changePaths.length === 0) {
    return {
      ok: false,
      error: "invalid argument",
      reason: "changePaths must be a non-empty array of path strings",
    };
  }
  if (!changePaths.every((p) => typeof p === "string" && p.length > 0)) {
    return {
      ok: false,
      error: "invalid argument",
      reason: "every changePaths entry must be a non-empty string",
    };
  }
  if (rationale !== undefined && typeof rationale !== "string") {
    return {
      ok: false,
      error: "invalid argument",
      reason: `rationale must be a string when provided; got ${typeof rationale}`,
    };
  }

  const artifactPaths = [];
  const codePaths = [];
  for (const p of changePaths) {
    if (isCodeLanePath(p)) codePaths.push(p);
    else artifactPaths.push(p);
  }

  return {
    ok: true,
    artifact_paths: artifactPaths,
    code_paths: codePaths,
    all_artifact: codePaths.length === 0,
    all_code: artifactPaths.length === 0,
    mixed: artifactPaths.length > 0 && codePaths.length > 0,
    // Rationale is surfaced as DATA, never interpreted (proposal-intake-trust
    // MUST-1). The LLM reads it; this lib never branches on its content.
    rationale: typeof rationale === "string" ? rationale : "",
  };
}

// ---------------------------------------------------------------------------
// routeFinding — the dumb validator + dual-route dispatcher (the shard's
// load-bearing API). Takes the LLM's Layer-2 class as an INPUT; returns the
// structured dispatch. NEVER files anything.
// ---------------------------------------------------------------------------
/**
 * Produce the dual-route dispatch for a consultant `/codify` finding. The LLM
 * has already (a) run discriminate to see the lane partition and (b) — when
 * code paths are present — PROPOSED a Layer-2 class over the rationale-as-DATA.
 * This function validates and returns the routing; it does NOT classify and
 * does NOT file.
 *
 * Invariants (the five G-C-T2 invariants, each a named branch):
 *   (i)   Layer-1 partition uses the EXACT documented disallowed set
 *         (DISALLOWED_GLOBS) — no drift from Step 7b/7c.
 *   (ii)  the class is the LLM's `proposedClass` INPUT — this lib contains NO
 *         keyword/regex classifier (the structural property the test asserts).
 *   (iii) rationale is read as DATA (passed through), never as instruction.
 *   (iv)  Route B is reachable ONLY when ≥1 code path is present (Q5 wrong-lane
 *         guard) — a finding with zero code paths CANNOT produce a Route-B
 *         candidate, regardless of any proposedClass passed.
 *   (v)   any Route-B candidate is `surfaced_for_human: true` (never
 *         auto-routed) — the human confirms classification + approves the file
 *         (artifact-flow.md "automated suggestions permitted; automated
 *         placement is not"); ambiguous → capability default + ambiguity note.
 *
 * @param {object} opts
 * @param {string[]} opts.changePaths   - the finding's change paths
 * @param {string} [opts.rationale]     - consumer reason text (DATA)
 * @param {string} [opts.proposedClass] - the LLM's Layer-2 class ∈ ROUTE_B_CLASSES;
 *                                         REQUIRED when code paths are present
 * @param {boolean} [opts.ambiguous]    - the LLM's signal that capability-vs-bug
 *                                         was not mechanically certain (surfaces
 *                                         the D4 higher-leverage recommendation)
 * @returns one of:
 *   { ok:true, route_a, route_b, mixed, surfaced_for_human, routing_basis, ... }
 *   { ok:false, error, reason, step }
 */
function routeFinding(opts) {
  const o = opts || {};
  const disc = discriminate(o.changePaths, o.rationale);
  if (disc.ok === false) {
    return {
      ok: false,
      error: "route failed",
      reason: disc.reason,
      step: "discriminate",
    };
  }

  // Route A is ALWAYS the disposition for the artifact-lane paths (it
  // terminates at the Step-7c upflow; no Layer-2 needed).
  const routeA =
    disc.artifact_paths.length > 0
      ? { paths: disc.artifact_paths, proceed: true }
      : null;

  // Invariant (iv): Route B requires code paths. With zero code paths, NO
  // Route-B candidate is produced even if proposedClass was passed (a
  // category error — Route B is structurally unreachable for an all-artifact
  // finding).
  if (disc.code_paths.length === 0) {
    return {
      ok: true,
      route_a: routeA,
      route_b: null,
      mixed: false,
      surfaced_for_human: false, // Route A is the existing human-gated upflow
      routing_basis:
        "all paths artifact-lane → Route A only (Route B unreachable: no code paths)",
      rationale: disc.rationale,
    };
  }

  // Code paths present → Layer-2 class REQUIRED (invariant ii: the class is the
  // LLM's INPUT; this lib has no path to compute it).
  if (
    typeof o.proposedClass !== "string" ||
    !ROUTE_B_CLASSES.has(o.proposedClass)
  ) {
    return {
      ok: false,
      error: "route failed",
      reason:
        `code-lane paths present (${disc.code_paths.length}) → a Layer-2 class is REQUIRED. ` +
        `opts.proposedClass must be one of ${[...ROUTE_B_CLASSES].join(", ")} ` +
        `(the LLM's judgment over the rationale-as-DATA; this lib never computes it). ` +
        `Got ${JSON.stringify(o.proposedClass)}.`,
      step: "layer2-class",
    };
  }

  const ambiguous = o.ambiguous === true;
  // For an ambiguous finding the D4 default is capability (higher-leverage);
  // surface the ambiguity so the human ratifies/overrides. The lib does NOT
  // override the LLM's proposedClass — it records the ambiguity note alongside.
  const ambiguityNote = ambiguous
    ? `LLM flagged capability-vs-bug as not mechanically certain; D4 higher-leverage default is '${AMBIGUOUS_DEFAULT_CLASS}'. Human ratifies or overrides the class before filing.`
    : null;

  const routeB = {
    candidate_paths: disc.code_paths,
    class: o.proposedClass,
    draft_required: true, // G-C-WIRE drafts the MUST-3 body; never auto-fires
    ambiguous,
    ambiguity_note: ambiguityNote,
  };

  return {
    ok: true,
    route_a: routeA,
    route_b: routeB,
    mixed: disc.mixed,
    // Invariant (v): every Route-B candidate is surfaced for the human — the
    // tooling drafts+suggests; the human classifies+files. Never auto-routed.
    surfaced_for_human: true,
    routing_basis: disc.mixed
      ? "mixed: artifact paths → Route A; code paths → Route B (both surfaced for independent human confirmation)"
      : "all paths code-lane → Route B (capability/bug, human-gated)",
    rationale: disc.rationale,
  };
}

module.exports = {
  discriminate,
  routeFinding,
  isCodeLanePath,
  // Constants exposed for callers + tests (the byte-identity pin lives here).
  DISALLOWED_GLOBS,
  ROUTE_B_CLASSES,
  AMBIGUOUS_DEFAULT_CLASS,
  // Exposed for tests.
  _matchesGlob,
  _normalizePath,
};
