# worktree-session-placement audit fixtures

Per `rules/cc-artifacts.md` Rule 9. These pin the contract for the **Phase-2-deferred** detector
backing `rules/worktree-isolation.md` Rule 7 (a durable session/operator worktree lives in a
SIBLING outside the repo, never nested under `.claude/worktrees/` or anywhere below the repo root).
The detector does not exist yet; these fixtures are the acceptance criteria it must satisfy.

Inputs are the worktree-creation + session-rooting commands as a session would issue them. The
discriminating predicate is **whether the created path resolves inside the repo top-level**.

| Fixture                                   | Expects           | Predicate locked                                                                                                                                                                |
| ----------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flag-nested-claude-worktrees.txt`        | `halt-and-report` | Durable session worktree created under `.claude/worktrees/` and rooted into. The canonical nesting trap.                                                                          |
| `flag-enterworktree-name-durable.txt`     | `halt-and-report` | `EnterWorktree({name})` for durable session work — creates under `.claude/worktrees/` by construction, so the name form is itself the violation.                                  |
| `flag-nested-below-repo-root-not-claude.txt` | `halt-and-report` | Nested at `./wt/x` — BELOW the repo root but NOT under `.claude/worktrees/`. Locks that the predicate is "inside the repo top-level", not a literal `.claude/worktrees/` substring match. |
| `skip-sibling-outside-repo.txt`           | `null`            | The compliant shape: path derived location-independently via `git-common-dir`, placed in the MAIN repo's parent as `.<slug>-wt/<name>`. MUST NOT flag.                            |
| `skip-enterworktree-path-sibling.txt`     | `null`            | `EnterWorktree({path})` targeting an existing sibling worktree — the sanctioned first-entry re-root. MUST NOT flag.                                                               |

**Severity note.** Flag cases expect `halt-and-report`, never `block`, per
`rules/hook-output-discipline.md` MUST-2 — placement is judgment-bearing over session setup.

**Why `flag-nested-below-repo-root-not-claude.txt` matters.** A detector written as a substring
match on `.claude/worktrees/` passes the other two flag cases and silently misses this one, which
carries the identical cost: the measured path-scoped double-load (see
`skills/30-claude-code-patterns/worktree-orchestration.md` § Ancestor-Load Measurement) is a
function of the worktree being under the ANCESTOR REPO, not of the `.claude/` path segment. The
predicate must be a resolved-path containment test against the repo top-level
(`rules/security.md` § Path Containment — resolve both sides through the same resolver).

Origin: Rule 7 clause-scoped wiring (2026-07-11, `journal/0463`); fixture set added 2026-07-26
alongside the measured-placement amendment (loom#1368 part 1). Directory was cited by the wiring
block from 2026-07-11 but did not exist until now — it was one of the dangling refs
`validate-xref-integrity.mjs` reports.

## Tracking status — PHASE-2-DETECTOR-NOT-BUILT

`PHASE-2-DETECTOR-NOT-BUILT` — this fixture set has NO detector and NO
`eval-manifest.json` entry. The fixtures pin a contract nothing currently executes.

This marker exists because creating the directory REMOVED the previous tracking
signal: while the path was cited but absent, `validate-xref-integrity.mjs` reported
it as a dangling ref, which was the only mechanical record that the Phase-2 work was
outstanding. Materializing the fixtures resolved that dangling ref (40 → 39) and would
otherwise have made the unbuilt detector invisible. Grep
`PHASE-2-DETECTOR-NOT-BUILT` across `.claude/audit-fixtures/` to enumerate every
fixture set awaiting a detector. Remove this section when the detector lands.
