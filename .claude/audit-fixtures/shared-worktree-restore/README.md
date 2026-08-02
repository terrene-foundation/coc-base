# shared-worktree-restore audit fixtures

Per `rules/cc-artifacts.md` Rule 9. These pin the contract for the **Phase-2-deferred** detector
backing `skills/30-claude-code-patterns/worktree-orchestration.md` Rule 11 (shared-worktree
mutation agents restore via a `cp` backup, never `git checkout --` / `git restore`), which
`rules/agents.md` § Worktree Orchestration carries as a MUST. The detector does not exist yet;
these fixtures are the acceptance criteria it must satisfy when it lands.

Inputs are Bash command sequences as a session would issue them. The discriminating predicate is
**whether the restored path was MUTATED earlier in the same sequence** — not the mere presence of
`git checkout --`, which is an ordinary and legitimate discard.

| Fixture                                    | Expects           | Predicate locked                                                                                                                                                                                    |
| ------------------------------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flag-git-checkout-restore-after-edit.txt` | `halt-and-report` | A path is mutated (`sed -i`) then restored with `git checkout -- <same path>`. This is the mutate-and-restore shape: `checkout` restores from the INDEX, so any staged-then-edited content is destroyed. |
| `flag-git-restore-after-edit.txt`          | `halt-and-report` | Same class via the modern spelling `git restore <path>` and a different mutation vehicle (heredoc append). Locks that the detector keys on the OPERATION, not on the literal `checkout` token.        |
| `skip-cp-backup-restore.txt`               | `null`            | The compliant shape: `cp` backup taken BEFORE the mutation, restore from the backup, digest comparison after. MUST NOT flag.                                                                          |
| `skip-checkout-file-never-edited.txt`      | `null`            | `git checkout -- <path>` on a path the sequence never mutated — an ordinary discard of unrelated drift. MUST NOT flag; flagging every `checkout` would make the detector unusable.                     |

**Severity note.** The flag cases expect `halt-and-report`, never `block`, per
`rules/hook-output-discipline.md` MUST-2: whether a given `git checkout --` is a mutation-restore
or an ordinary discard is judgment-bearing and not structurally decidable at tool-call time. A
`block` verdict on this predicate would halt legitimate discards.

**Why these two skip cases are load-bearing.** The rule is deliberately UNCONDITIONAL for the
agent (`cp` always, because an agent cannot evaluate the file's index state from outside), but the
DETECTOR must still be conditional on prior mutation — otherwise it fires on
`skip-checkout-file-never-edited.txt` and gets disabled. The asymmetry is intentional: the agent's
rule is unconditional because the condition is unknowable to it; the detector's predicate is
conditional because the full command sequence IS available to it.

Origin: loom#1362.

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
