/**
 * engine-double.mjs — a CONTROLLED STAND-IN for the job-budget audit engine.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT.
 *
 * The hook under test (`.claude/hooks/ci-job-budget-guard.js`) is a PRESENTER over
 * the audit engine's exported classifier. Two things can be wrong with it, and they
 * need different instruments:
 *
 *   (1) the CLASSIFIER decides wrongly which jobs freeload  → NOT tested here.
 *       That belongs with the engine (`.claude/bin/ci-job-budget-audit.mjs`) and
 *       its own fixtures. This file deliberately makes NO claim about it.
 *   (2) the PRESENTER mishandles a correct classification — drops offenders,
 *       truncates without saying so, swallows a degraded declaration, forges lines
 *       out of a hostile filename, emits the wrong severity, or falls silent when
 *       it cannot check at all → THAT is what this battery tests.
 *
 * To test (2) the classifier's answers must be KNOWN, so this module returns
 * exactly what the case declares in `CJB_FIXTURE_SPEC` and computes nothing. Reading
 * a green from this battery as evidence about the classifier would be reading an
 * instrument for a question it was not built for (`instrument-discipline.md` MUST-4).
 *
 * It is a test double in a fixture directory, never production code, and it is not
 * reachable from any shipped path: the hook resolves its engine at
 * `.claude/bin/ci-job-budget-audit.mjs`, and this file is copied into a synthetic
 * temp tree under that name only for the duration of a case.
 */

function spec() {
  return JSON.parse(process.env.CJB_FIXTURE_SPEC || "{}");
}

export function triggersOnPullRequest(_src) {
  const s = spec();
  return s.triggersOnPullRequest !== false;
}

export function workflowHasPathsFilter(_src) {
  return Boolean(spec().pathsFiltered);
}

// The declaration surface MIRRORS the real engine's two-call shape
// (`resolveDeclarationPath()` then `loadDeclaration(path)`) rather than the
// single no-arg `loadDecl()` this double previously exposed. That divergence was
// not cosmetic: a double whose signature differs from the engine's CANNOT detect
// an interface break, so the guard imported a symbol the engine does not export
// and every fixture arm still passed. The double must fail the same way the real
// engine would, or its green is a statement about the double alone.
export function resolveDeclarationPath(_opts) {
  return spec().declPath || "/nonexistent/ci-job-budget.local.json";
}

export function loadDeclaration(_p) {
  const s = spec();
  if (s.declThrows) throw new Error(s.declThrows);
  return s.decl || { budgeted: {}, pools: {} };
}

export function loadRequiredContexts(_decl) {
  const s = spec();
  if (s.requiredThrows) throw new Error(s.requiredThrows);
  return new Set(s.requiredContexts || []);
}

/** Returns the case-declared job rows verbatim; it never parses `src`. */
export function jobBlocks(_src) {
  return spec().jobs || [];
}

/**
 * Returns the row it was handed, or null when the case declared the job
 * unreachable from a pull request. `ctx` is accepted and asserted-on by the
 * caller-visibility case rather than used, so a presenter that stopped passing
 * the shared context is still detectable.
 */
export function classifyJob(block, ctx) {
  if (!block || block.isNull) return null;
  return {
    key: block.key,
    pool: block.pool,
    required: Boolean(block.required),
    gated: Boolean(block.gated),
    budgeted: Boolean(block.budgeted),
    _ctxSeen: {
      pathsFiltered: Boolean(ctx && ctx.pathsFiltered),
      requiredSize: ctx && ctx.requiredContexts ? ctx.requiredContexts.size : -1,
      budgetedSize: ctx && ctx.budgeted ? ctx.budgeted.size : -1,
      file: ctx ? ctx.file : null,
    },
  };
}
