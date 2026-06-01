# signing-mutation-guard audit fixtures

Per `cc-artifacts.md` Rule 9 + `hook-output-discipline.md` MUST-4. One
fixture per scope-restriction predicate the hook
(`.claude/hooks/signing-mutation-guard.js`, B3a) relies on.

## Predicates covered

| Fixture                            | Predicate exercised                                                     | Expected disposition |
| ---------------------------------- | ----------------------------------------------------------------------- | -------------------- |
| `01-block-sibling-porcelain/`      | Sibling worktree porcelain shows EXACT target path uncommitted-modified | block                |
| `02-pass-no-sibling/`              | No sibling worktrees → empty match-set                                  | silent passthrough   |
| `03-block-degraded-mode-mutation/` | No signing key + Edit on tracked path                                   | block                |
| `04-pass-degraded-mode-read/`      | No signing key + Read on tracked path (non-mutating)                    | silent passthrough   |
| `05-pass-signing-key-present/`     | Signing key resolved + no sibling contention + Edit                     | silent passthrough   |
| `06-block-git-commit-degraded/`    | No signing key + `git commit` Bash (git-mut command)                    | block                |

## Why these and only these

The hook's scope-restriction predicates are (per `cc-artifacts.md`
Rule 9 + architecture v11 §2.3 + §4.3 + R4-S-02 + R5-S-03):

1. **Operation classification** (`classifyOperation`): Edit | Write |
   Bash-with-mutation. Fixtures 04 (Read) and 02 (Edit + no sibling)
   cover the non-mutating + non-contended branches.
2. **§4.2 sibling-worktree porcelain predicate**
   (`detectSiblingContention` → `lib/sibling-porcelain.js`): the
   first of TWO branches that ships `severity: "block"`, grounded
   in the process-local structural primitive (`git status
--porcelain` against enumerated sibling worktrees per
   `hook-output-discipline.md` MUST-2). Fixture 01 covers the
   positive via `COC_PORCELAIN_OVERRIDE`; the override-precedence
   contract matches B1's adjacency-leasecheck convention.
3. **Degraded-mode working-tree-mutation predicate**
   (`wouldMutateWorkingTree`): the second `severity: "block"`
   branch, grounded in `git ls-files --error-unmatch <path>`
   structural signal. Per R5-S-03, degraded mode is a working-tree-
   mutation predicate, NOT an Edit/Write tool-name allowlist —
   fixtures 03 (Edit on tracked path) and 06 (`git commit` Bash
   command) cover both the Edit-form and the git-mut-form of the
   mutation predicate.
4. **Signing-key resolution** (operator-id 3-tier + override env
   vars): fixture 05 covers the happy-path where the key is
   present.
