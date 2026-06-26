# analyze-completeness-guard fixtures

Per `cc-artifacts.md` Rule 9 — one committed case per scope-restriction predicate the
gate relies on. Backs `hooks/analyze-completeness-guard.js` + `rules/analyze-output-completeness.md` (origin: loom#675).

## Run

```bash
node .claude/audit-fixtures/analyze-completeness-guard/run.cjs
```

Exits non-zero on any mismatch. The runner exercises the PURE decision function
`decideAnalyzeGate({repoDir, toolName, skillName, args})` against built temp
workspace trees — deterministic, no git, no stdin, no process spawn.

## Predicate ↔ case matrix

| Predicate                  | Setup                                                                                                 | Expected                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `block`                    | 01+03+specs populated, **02-plans empty**, `/todos`                                                   | block `[02-plans]` (gate fires on ANY tree)                  |
| `user-flows-missing`       | 01+02+specs populated, **03-user-flows empty**, `/todos`                                              | block `[03-user-flows]` (the originating loom#675 case)      |
| `pass`                     | all four trees populated, `/implement`                                                                | pass                                                         |
| `dual-location-specs`      | ws-local `specs/` empty but **repo-root `specs/` populated**, `/todos`                                | pass (specs OR satisfied)                                    |
| `fresh-workspace`          | every ws-local tree empty (root specs populated), `/todos`                                            | pass (analysis not started → never block a fresh start)      |
| `non-advance-skill`        | 03-user-flows empty BUT skill is `/redteam`                                                           | pass (only `/todos`+`/implement` are gated)                  |
| `documented-no-user-flows` | `03-user-flows/00-no-user-flows.md` rationale file present, `/todos`                                  | pass (documented rationale satisfies; silent-empty does not) |
| `explicit-arg-selection`   | two workspaces; `/todos target` where `target` is complete but a NEWER `newest` sibling is incomplete | pass (explicit arg overrides newest-mtime)                   |
| `newest-of-N-selection`    | two workspaces, no arg; `newest` (incomplete) has a higher mtime than a complete `target` sibling     | block on `newest` `[03-user-flows]`                          |

## Why these predicates

- **block / user-flows-missing** — the gate must fire on ANY empty compulsory tree, not
  only `03-user-flows/`; both flag a started-but-incomplete workspace.
- **pass / dual-location-specs** — `specs/` is satisfied by EITHER location
  (`specs-authority.md` Rule 1 says project root; Rule 9 says `workspaces/<project>/specs/`).
- **fresh-workspace** — `analysisStarted` is keyed on workspace-LOCAL trees only, so a
  populated repo-root `specs/` (always present at loom) does not make a fresh workspace
  look "started" and falsely block a legitimate first `/todos`.
- **non-advance-skill** — only phase-advancing skills (`/todos`, `/implement`) are gated.
- **documented-no-user-flows** — the back-end-only escape hatch: a documented rationale
  file is a real `.md` that satisfies the gate; a silent-empty tree does not.
- **explicit-arg-selection / newest-of-N-selection** — lock the workspace-SELECTION
  heuristic the block-severity question turns on (R1 redteam): an explicit `/todos <project>`
  arg overrides newest-mtime (the false-block recovery path), and a no-arg invocation gates
  the newest workspace. These exercise `resolveWorkspace`'s arg branch + `detectActiveWorkspace`'s
  newest-of-N sort, which the single-workspace cases above never reach.
