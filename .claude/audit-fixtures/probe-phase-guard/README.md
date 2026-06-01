# probe-phase-guard audit fixtures

Per `cc-artifacts.md` Rule 9 + `hook-output-discipline.md` MUST-4.
One fixture per scope-restriction predicate the hook
(`.claude/hooks/probe-phase-guard.js`) relies on. Each fixture is a
self-contained PreToolUse stdin payload + an expected disposition
(severity verdict + reasoning).

## Predicates covered

| Fixture                                | Predicate exercised                                        | Expected disposition |
| -------------------------------------- | ---------------------------------------------------------- | -------------------- |
| `01-block-retrieval-during-probe/`     | Lockfile present + retrieval tool (Read) → block           | block                |
| `02-pass-no-lockfile/`                 | No lockfile in `.claude/` → silent passthrough             | silent passthrough   |
| `03-pass-non-retrieval-tool/`          | Lockfile present + non-retrieval tool (Bash) → passthrough | silent passthrough   |
| `04-pass-lockfile-outside-claude-dir/` | Lockfile-shaped file outside `.claude/` → passthrough      | silent passthrough   |

## Why these and only these

The hook's scope-restriction predicates are (per `cc-artifacts.md`
Rule 9 + `hook-output-discipline.md` MUST-2 + MUST-4):

1. **Retrieval-tool predicate** (`RETRIEVAL_TOOLS.has(tool)`): only
   Read / Grep / Glob / WebFetch fire the hook. Bash MUST passthrough
   even when the lockfile is present, because the orchestrator needs
   Bash for lockfile creation/cleanup. Fixture 03 covers this.
2. **Lockfile-existence predicate** (`findProbeLockfile`): the ONLY
   branch that ships `severity: "block"`, grounded in the structural
   primitive per `hook-output-discipline.md` MUST-2 (fs.readdirSync
   - filename equality match — not a regex over prose). Fixtures 01
     (positive) and 02 (negative) cover both sides.
3. **Lockfile-location predicate** (path is `.claude/.certify-in-probe-*.lock`):
   only `.claude/` direct children match — subdirectories and other
   parent paths do NOT trigger the gate. Fixture 04 covers the
   location-scope negative (lockfile-shaped file outside `.claude/`).

## Hook severity discipline

Per `hook-output-discipline.md` MUST-2: block severity requires a
structural signal that cannot be evaded by surface rewrite. The
probe-phase guard's signal is two-element-conjunction structural:

- File existence is process-local deterministic (`fs.readdirSync`).
- Tool name is string-equality on the canonical CC tool set
  (Read/Grep/Glob/WebFetch).

Neither is a lexical regex over agent prose; both are structural
primitives. Block is the appropriate severity per MUST-2 examples
("`CLAUDE_WORKTREE_PATH` env set + absolute path outside it" is the
same conjunction shape).

## Probe-driven gate-review counterpart

Per `probe-driven-verification.md` MUST-4: every lexical hook
detector MUST have a probe-driven gate-review counterpart. This
hook is STRUCTURAL (not lexical), so MUST-4 does not strictly apply;
the gate-review counterpart is the pass-receipt's signed journal-body
anchor (`knowledge-convergence.md` MUST-2). A pass-receipt issued
during a probe where retrieval fired would still be cryptographically
signed, but the institutional-knowledge it claims to certify would
be false — the structural hook closes that gap at the tool-call layer
rather than after the fact.
