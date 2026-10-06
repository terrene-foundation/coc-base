---
id: "GIT"
---

# Git Workflow Rules

See `.claude/guides/rule-extracts/git.md` for extended examples, BLOCKED corpora, the protection table, and Origin evidence.

## Conventional Commits

Format: `type(scope): description`. Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`.

```
feat(auth): add OAuth2 support   ·   fix(api): resolve rate limiting issue
```

**Why:** Non-conventional commits break automated changelog generation and make `git log --oneline` useless for release notes.

## Branch Naming

Format: `type/description` (e.g., `feat/add-auth`, `fix/api-timeout`).

**Why:** Inconsistent branch names prevent CI pattern-matching rules and make `git branch --list` unreadable.

### Release-Prep PRs MUST Use `release/v*` Branch Convention (MUST)

Any PR whose diff is metadata-only — version anchors (`pyproject.toml` / `Cargo.toml`, `__init__.py::__version__` / lib.rs `pub const VERSION`), `CHANGELOG.md`, spec/doc version-line updates — MUST be opened from a branch named `release/v<X.Y.Z>`. Using `feat/`, `fix/`, `chore/` on a release-prep PR is BLOCKED.

```bash
# DO — git checkout -b release/v3.23.0 (auto-skips PR-gate matrix)
# DO NOT — git checkout -b feat/v3.23.0-release-prep (fires full matrix on metadata-only diff)
```

**Why:** PR-gate workflows skip on a `release/` head ref, saving ~45 min × matrix-size per release-prep PR. Split discipline for not-metadata-only work: guide.

### Pre-FIRST-Push CI Parity Discipline — SCOPED By Default (MUST)

Before the FIRST `git push` creating a remote branch, the agent MUST run the project's CI-parity set and ALL MUST exit 0 → push — **SCOPED TO THE DIFF by default**, the selection DERIVED from `git diff --name-only`, never from judgment about which tests look relevant. The UNSCOPED whole-repo run is an EARNED exception, NAMED at one of five junctures: release · security surface · cross-SDK/binding parity · infra or shared config · an untrustworthy selection (collection unclean, merge-base unresolved, or EMPTY derivation on a non-empty diff → fail closed to full).

```bash
# DO — scope the gate to the diff
pre-commit run --files $changed; cargo clippy $pkgs -- -D warnings; node .claude/bin/owed-suites.mjs
# DO NOT — unscoped on a diff that earned no juncture, or skip the gate to save the time
pre-commit run --all-files; pytest tests/; cargo nextest run --workspace
```

**Scoping the gate is EXPECTED; skipping it stays BLOCKED.** "This is unscoped for my diff, so I run it over what the diff touches" is the required move, not a rationalization — it narrows the gate's INPUT. "It takes too long, so I'll push and let CI answer" removes the OUTPUT: BLOCKED.

Depth — per-language sets, the five junctures in full, the SKIP carve-out (a SKIP is NOT a parity failure), the BLOCKED corpus, why every local duration here is UNMEASURED, the per-cycle arithmetic and the 71-min mid-flight cancel evidence — lives in `.claude/guides/rule-extracts/git.md`.

**Why:** Cancelled in-flight runs are still billed for the wall-clock consumed, so push → CI fail → fix-up → push costs multiples of pre-flighting — but an unscoped pre-flight prices the gate so high the session skips it, the same failure by another route. Scoping keeps the answer and drops the cost.

## Unlanded Work Is Inventory (MUST)

Finished work MUST land on the trunk **in the session that finished it**. A branch, worktree, stash
or remote ref holds it at ZERO value; no container is a resting state.

**Why:** a lane left open outlives the session's memory of it, so the work is re-derived. Depth:
`rules/wip-discipline.md`.

## Branch Protection

All protected repos require PRs to main; direct push is rejected by GitHub. Owner workflow + the per-repository protection table: guide.

**Why:** Direct pushes bypass CI checks and code review, allowing broken or unreviewed code to reach the release branch.

## PR Description

CC system prompt provides the template. Always include a `## Related issues` section (`Fixes #123`).

**Why:** Without issue links, PRs become disconnected from their motivation, breaking traceability and preventing automatic issue closure on merge.

## Destructive Working-Tree Ops MUST Verify Clean Working Tree (MUST)

`git reset --hard <ref>`, `git clean -f[d]`, and `rm -rf` of untracked paths all SILENTLY and IRRECOVERABLY destroy uncommitted work — unstaged modifications AND untracked-not-ignored files have NO reflog. Running any without first verifying `git status --porcelain` is empty is BLOCKED. Prefer `git reset --keep <ref>` (aborts on a dirty tree) and `git clean -n` (preview). NOT `git stash -u` — capture to a patch instead.

Depth — why the stash is unsafe here, and the validate-bash-command.js tripwire enforcing this at the Bash boundary — lives in `.claude/guides/rule-extracts/git.md`.

```bash
# DO — git reset --keep origin/main; git clean -n (loud refusal / preview)
# DO NOT — git reset --hard origin/main; git clean -fd (wipes M + untracked; no reflog)
```

**Why:** Unlike force-push the loss is unrecoverable (no reflog); `--keep` / `clean -n` convert silent loss into a loud refusal/preview. #401 incident + sibling rules: guide.

## Rules

- Atomic commits: one logical change per commit, tests + implementation together
- No direct push to main, no force push to main
- No secrets in commits (API keys, passwords, tokens, .env files)
- No large binaries (>10MB single file)
- Commit bodies MUST answer **why**, not **what** (the diff shows what)

```
# DO — body explains why: "(BulkCreate silently swallowed per-row exceptions; alerting never fired.)"
# DO NOT — body restates the diff: "(Added logger.warning call in _handle_batch_error.)"
```

**Why:** Mixed commits are impossible to revert cleanly and leaked secrets require rotation everywhere; commit bodies explaining "why" are the cheapest institutional documentation.

## Discipline

- **Issue closure**: `gh issue close <N>` MUST include a commit SHA / PR number / merged-PR link in the comment. Closing with no code reference is BLOCKED.
- **Pre-commit hook workarounds**: any hook bypass MUST be documented in the commit body + a follow-up todo filed. Silent `--no-verify` is BLOCKED. The sanctioned bypass form + when auto-stash failure justifies it: guide.
- **Commit-message claim accuracy**: commit bodies MUST describe ONLY changes actually present in the diff. Over-claiming a refactor / deletion / side-effect is BLOCKED. If the claim was made in error, push a FOLLOW-UP commit that delivers what the prior message said — do NOT amend.

**Why:** Issues closed without code refs break traceability and undocumented workarounds force every session to re-discover the same fix; over-claiming commit bodies poison `git log --grep`. See extract.

- **CI-check and merge are SEPARATE steps under duplicate-run races**: (1) READ — pin the head SHA (`gh pr view <N> --json headRefOid`) and confirm every REQUIRED check is `SUCCESS` on THAT SHA; (2) MERGE — only then `gh pr merge <N>`. Bundling them (`&&`, or `--watch` then merge) is BLOCKED.

```bash
# DO   head=$(gh pr view <N> --json headRefOid -q .headRefOid); gh pr checks <N>; then gh pr merge <N> --admin --merge
# DO NOT  gh pr checks <N> --watch && gh pr merge <N> --admin --merge   # watch may be green on the prior commit
```

**Why:** A `--watch` returning green may have resolved against the PRIOR commit's run while a newer duplicate on the current head is still pending or flaked red; separating the pinned read from the merge makes the gate verifiable. See guide.

Depth — the Trust-Posture Wiring, the rule-graph cross-references and the Origin record — lives in `.claude/skills/32-trust-posture/wiring/git.md`, which every validator reads as part of this rule.
