---
priority: 0
scope: baseline
---

# Git Workflow Rules

See `.claude/guides/rule-extracts/git.md` for extended bash examples, full BLOCKED rationalization lists, repository protection table, and Origin evidence.

<!-- slot:neutral-body -->

## Conventional Commits

Format: `type(scope): description`. Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`.

```
feat(auth): add OAuth2 support
fix(api): resolve rate limiting issue
```

**Why:** Non-conventional commits break automated changelog generation and make `git log --oneline` useless for release notes.

## Branch Naming

Format: `type/description` (e.g., `feat/add-auth`, `fix/api-timeout`).

**Why:** Inconsistent branch names prevent CI pattern-matching rules and make `git branch --list` unreadable.

### Release-Prep PRs MUST Use `release/v*` Branch Convention (MUST)

Any PR whose diff is metadata-only — version anchors (`pyproject.toml` / `Cargo.toml`, `__init__.py::__version__` / lib.rs `pub const VERSION`), `CHANGELOG.md`, spec/doc version-line updates — MUST be opened from a branch named `release/v<X.Y.Z>`. Using `feat/`, `fix/`, `chore/` on a release-prep PR is BLOCKED.

```bash
# DO — release-prep branch auto-skips PR-gate matrix
git checkout -b release/v3.23.0 && git push -u origin release/v3.23.0
# DO NOT — feat/ branch fires the full PR-gate matrix on metadata-only diff
git checkout -b feat/v3.23.0-release-prep
```

**Why:** PR-gate workflows check `if: !startsWith(github.head_ref, 'release/')`. Branching from `release/v*` triggers the auto-skip and saves ~45 min × matrix-size of CI minutes per release-prep PR. If the work IS NOT metadata-only, split: keep code fix on `feat/`/`fix/` branch, cut release-prep on a separate `release/v*` branch. Evidence: a recent BUILD release-prep PR opened from `feat/...-release-prep` instead of `release/v*` consumed ~120 min of avoidable PR-gate CI on a metadata-only diff.

### Pre-FIRST-Push CI Parity Discipline (MUST)

Before the FIRST `git push` that creates a remote branch, the agent MUST run the project's local CI parity command set (Rust: `cargo +nightly fmt --all --check` + `cargo clippy -- -D warnings` + `cargo nextest run` + `RUSTDOCFLAGS="-Dwarnings" cargo doc`. Python: `pre-commit run --all-files` + `pytest` + `mypy --strict`). All MUST exit 0 → push.

```bash
# DO — pre-flight all local CI commands before first push
cargo +nightly fmt --all --check && cargo clippy -- -D warnings && cargo nextest run
git push -u origin feat/<branch>
# DO NOT — push, watch CI, fix-up commit, push again, repeat
git push -u origin feat/<branch>; git commit -am "style: fmt"; git push  # CI run #2 still bills run #1's wall-clock
```

**Why:** With `concurrency: cancel-in-progress: true` on the workflow, prior in-flight runs are cancelled — but **the cancelled runs are still billed for the wall-clock minutes already consumed before cancellation**. A recent BUILD release had a 71-minute Workspace Tests run cancelled mid-flight; those 71 min were charged. Pre-flighting takes ~5-10 min; the alternative is N × 45 min of billed CI per fix-up cycle.

## Branch Protection

All protected repos require PRs to main. Direct push is rejected by GitHub. Owner workflow: branch → commit → push → PR → `gh pr merge <N> --admin --merge --delete-branch`. See extract for the full repository × protection table.

**Why:** Direct pushes bypass CI checks and code review, allowing broken or unreviewed code to reach the release branch.

## PR Description

CC system prompt provides the template. Always include a `## Related issues` section (e.g., `Fixes #123`).

**Why:** Without issue links, PRs become disconnected from their motivation, breaking traceability and preventing automatic issue closure on merge.

## `git reset --hard` MUST Verify Clean Working Tree (MUST)

`git reset --hard <ref>` SILENTLY discards every unstaged modification AND every untracked file in the affected paths. Recovery is impossible — unstaged content has no reflog entry. Running `git reset --hard` without first verifying `git status --porcelain` is empty is BLOCKED. Prefer `git reset --keep <ref>`, which performs the same commit-graph operation BUT aborts if it would lose local changes.

```bash
# DO — --keep aborts loudly when working tree has changes
git reset --keep origin/main
# DO — verify clean first if --hard is genuinely needed
[ -z "$(git status --porcelain)" ] || { echo "stash or commit first"; exit 1; }
git reset --hard origin/main
# DO NOT — bare --hard with no working-tree check
git reset --hard origin/main         # silently wipes M files and untracked files; no reflog
```

**Why:** `git reset --hard` is the most destructive git operation that doesn't rewrite history — and unlike force-push, the destruction is unrecoverable. `git reset --keep` exists in git specifically to provide the same effect with structural safety. Sibling of `dataflow-identifier-safety.md` Rule 4 (DROP) and `schema-migration.md` Rule 7 (downgrade) — same structural-confirmation pattern. Origin: 2026-04-28 — a `git reset --hard` wiped uncommitted `.session-notes`; cross-language principle.

## Rules

- Atomic commits: one logical change per commit, tests + implementation together
- No direct push to main, no force push to main
- No secrets in commits (API keys, passwords, tokens, .env files)
- No large binaries (>10MB single file)
- Commit bodies MUST answer **why**, not **what** (the diff shows what)

```
# DO — explains why
feat(dataflow): add WARN log on bulk partial failure
# (BulkCreate silently swallowed per-row exceptions; alerting never fired.)
# DO NOT — restates the diff
feat(dataflow): add logging to bulk create
# (Added logger.warning call in _handle_batch_error method.)
```

**Why:** Mixed commits are impossible to revert cleanly. Leaked secrets require key rotation across all environments. Large binaries permanently bloat the repo. Commit bodies that explain "why" are the cheapest form of institutional documentation — co-located, versioned, `git log --grep`-searchable, never stale.

## Discipline

- **Issue closure**: `gh issue close <N>` MUST include a commit SHA / PR number / merged-PR link in the comment. Closing with no code reference is BLOCKED.
- **Pre-commit hook workarounds**: when pre-commit auto-stash fails despite hooks passing standalone, `git -c core.hooksPath=/dev/null commit ...` MUST be documented in the commit body + a follow-up todo filed. Silent `--no-verify` is BLOCKED.
- **Pre-commit comment-syntax matchers**: the `python-use-type-annotations` hook regex matches `# type` (NOT `# type:`) per `pre-commit-hooks/.pre-commit-hooks.yaml::pygrep`. Comments referencing the `types` module — `# types.UnionType for PEP 604` — trigger a false positive. Reword to avoid `# type` as a literal substring (e.g. "PEP 604 produces `types.UnionType`" → "PEP 604 produces a union type"). Same class for any future `pygrep` hook that matches comment fragments without the trailing punctuation.
- **Commit-message claim accuracy**: commit bodies MUST describe ONLY changes actually present in the diff. Over-claiming a refactor / deletion / side-effect is BLOCKED. If the claim was made in error, push a FOLLOW-UP commit that delivers what the prior message said — do NOT amend.

**Why:** Issues closed without code refs break traceability; undocumented workarounds force every session to re-discover the same fix; over-claiming commit bodies poison `git log --grep` (the cheapest institutional-knowledge search). See extract for full DO/DO NOT examples.

<!-- /slot:neutral-body -->
