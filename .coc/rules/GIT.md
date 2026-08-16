---
id: "GIT"
---

# Git Workflow Rules

See `.claude/guides/rule-extracts/git.md` for extended bash examples, full BLOCKED rationalization lists, repository protection table, and Origin evidence.

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
# DO — git checkout -b release/v3.23.0 (auto-skips PR-gate matrix)
# DO NOT — git checkout -b feat/v3.23.0-release-prep (fires full matrix on metadata-only diff)
```

**Why:** PR-gate workflows skip on a `release/` head ref, saving ~45 min × matrix-size per release-prep PR. Work that is NOT metadata-only splits — code onto `feat/`/`fix/`, release-prep on its own `release/v*`. See guide.

### Pre-FIRST-Push CI Parity Discipline (MUST)

Before the FIRST `git push` that creates a remote branch, the agent MUST run the project's local CI-parity command set and ALL MUST exit 0 → push. Per-language command sets (Rust, Python) and the no-root-`.pre-commit-config.yaml` SKIP carve-out — a SKIP is NOT a parity failure: guide.

**Why:** With `concurrency: cancel-in-progress: true`, cancelled in-flight runs are still billed for the wall-clock consumed, so push → CI fail → fix-up → push costs multiples of pre-flighting. Per-cycle arithmetic + the 71-minute mid-flight cancel evidence: guide.

## Branch Protection

All protected repos require PRs to main. Direct push is rejected by GitHub. Owner workflow (branch → commit → push → PR → admin-merge) + the per-repository protection table: guide.

**Why:** Direct pushes bypass CI checks and code review, allowing broken or unreviewed code to reach the release branch.

## PR Description

CC system prompt provides the template. Always include a `## Related issues` section (e.g., `Fixes #123`).

**Why:** Without issue links, PRs become disconnected from their motivation, breaking traceability and preventing automatic issue closure on merge.

## Destructive Working-Tree Ops MUST Verify Clean Working Tree (MUST)

`git reset --hard <ref>`, `git clean -f[d]`, and `rm -rf` of untracked paths all SILENTLY and IRRECOVERABLY destroy uncommitted work — unstaged modifications AND untracked-not-ignored files have NO reflog. Running any without first verifying `git status --porcelain` is empty is BLOCKED. Prefer `git reset --keep <ref>` (aborts on a dirty tree) and `git clean -n` (preview). NOT `git stash -u` — capture to a patch instead. Why the stash is unsafe here (`.git`-scoped stack, poppable from any linked worktree per `worktree-isolation.md` Rule 9) + the `validate-bash-command.js` tripwire that enforces this at the Bash boundary: guide.

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

- **CI-check and merge are SEPARATE steps under duplicate-run races**: checking CI and merging MUST be separate commands — (1) READ: pin the head SHA (`gh pr view <N> --json headRefOid`) and confirm every REQUIRED check is `SUCCESS` on THAT SHA; (2) MERGE: only then `gh pr merge <N>`. Bundling them (`gh pr checks <N> && gh pr merge <N>`, or `--watch` then merge) is BLOCKED.

```bash
# DO — READ pinned to head, THEN merge as a separate command
head=$(gh pr view <N> --json headRefOid -q .headRefOid)
gh pr checks <N>   # every REQUIRED check SUCCESS on $head?
gh pr merge <N> --admin --merge
# DO NOT — bundle (watch may be green on the prior commit)
gh pr checks <N> --watch && gh pr merge <N> --admin --merge
```

  **Why:** A `--watch` returning green may have resolved against the prior commit's run while a newer duplicate on the current head is still pending or flaked red; separating the read (pinned to the head SHA) from the merge makes the gate verifiable. See guide.

## Trust Posture Wiring

Applies to the **CI-check-and-merge-are-separate-steps** § Discipline bullet (added 2026-07-03, `/sync-from-build` py Shard B). Per `trust-posture.md` MUST-8 grandfather cutoff, this bullet lands AT/AFTER the MUST-8 SHA and MUST ship canonical-8-field-compliant; the pre-existing grandfathered sections of this file remain exempt until each is itself `/codify`-touched (the clause-scoped precedent set by `rule-authoring.md`'s own Wiring section).

- **Severity:** `halt-and-report` at gate-review (reviewer confirms check-then-merge separation in a session transcript that admin-merges a PR); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 (no structural tool-call-time signal — the watch/merge-ordering property is judgment-bearing over the session's command history).
- **Grace period:** 7 days from clause landing (2026-07-03 → 2026-07-10).
- **Cumulative posture impact:** same-class violations (bundling watch + merge, or merging over a stale-green / red duplicate run) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key (a transcript-history judgment property does not warrant an instant-drop key; the universal `regression_within_grace` trigger already covers it). Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8.
- **Receipt requirement:** SessionStart soft-gate `[ack: git]` IFF `posture.json::pending_verification` includes the `git` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer inspects any session that admin-merges a PR for a pinned-head-SHA READ step (`gh pr view <N> --json headRefOid`) issued as a command separate from the `gh pr merge`. Probes `.claude/test-harness/probes/git.probes.json` — NOT YET AUTHORED, declared in `phase2-deferrals.json::probe_authorship_deferrals`. Phase 2 (deferred) — no hook detector; audit fixtures land with the Phase-2 detector at `.claude/audit-fixtures/ci-check-merge-separation/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** the CI-check/merge § Discipline bullet ONLY (clause-scoped); pre-existing grandfathered `git.md` sections stay exempt until each is itself `/codify`-touched.
- **Origin:** See § Origin (kailash-py PR #1465 Trap-1). Landed at loom via `/sync-from-build` py Shard B (journal/0402).

Origin: 2026-04-28 (`git reset --hard` discarded uncommitted `.session-notes` in a kailash-py session, PR #691) + cumulative CI-billing evidence on release-prep branch convention + 2026-07-03 (`/sync-from-build` py Shard B: CI-check/merge separation, kailash-py PR #1465 Trap-1). See `.claude/guides/rule-extracts/git.md` for full post-mortems.
