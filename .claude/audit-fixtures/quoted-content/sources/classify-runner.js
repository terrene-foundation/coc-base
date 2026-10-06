/**
 * classify-runner — FIXTURE SOURCE, not a shipped module.
 *
 * A faithful-in-shape stand-in for `classifyRunner()` in
 * `.claude/bin/run-audit-fixtures.mjs`, so the seven-vs-eight regression can be
 * pinned without depending on a live file another lane may be editing.
 *
 * The property that matters is the one the real defect turned on: there are
 * EIGHT verdict kinds, they are emitted as `kind: "<name>"` literals spread
 * across the function rather than collected in one register, and the second one
 * — `env-abort` — sits in the INTERIOR of the run. Drop it and what is left
 * still reads as a complete, coherent, correctly-ordered ladder.
 */
export function classifyRunner(entry, result, cases) {
  const problems = [];

  // A killed process is NOT a non-zero exit. Returns immediately.
  if (result.spawnError || result.status === null) {
    problems.push({
      kind: "runner-error",
      detail: "the runner did not produce a readable result",
    });
    return problems;
  }

  // An ENVIRONMENT abort is not a test failure and must never be scored as one.
  // Carries a RESERVED EXIT CODE (78), which is the half a fork will miss.
  if (result.envAbort) {
    problems.push({
      kind: "env-abort",
      detail: "runner aborted on its ENVIRONMENT, not on its subject",
    });
    return problems;
  }

  // Anti-vacuity floor, checked BEFORE the pass/fail arms.
  if (Number.isInteger(entry.min_cases) && cases.total < entry.min_cases) {
    problems.push({
      kind: "under-cases",
      detail: "observed fewer cases than the registry declares",
    });
  }

  if (result.status !== 0 && cases.failed.length === 0) {
    problems.push({
      kind: "opaque-failure",
      detail: "non-zero exit with zero parseable FAIL lines",
    });
  }

  if (result.status === 0 && cases.failed.length > 0) {
    problems.push({
      kind: "under-reported-failure",
      detail: "exit 0 with printed FAIL lines",
    });
  }

  for (const f of cases.failed) {
    if (!entry.xfail?.includes(f)) {
      problems.push({ kind: "undeclared-failure", detail: f });
    }
  }

  for (const x of entry.xfail || []) {
    if (cases.passed.includes(x)) {
      problems.push({
        kind: "xfail-now-passes",
        detail: "the defect is FIXED; delete the row",
      });
    } else if (!cases.failed.includes(x)) {
      problems.push({
        kind: "xfail-not-found",
        detail:
          "renamed or deleted; a stale xfail row hides whatever replaced it",
      });
    }
  }

  return problems;
}
