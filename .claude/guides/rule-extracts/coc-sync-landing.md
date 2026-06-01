# COC Sync Landing — Extended Evidence and Examples

Companion reference for `.claude/rules/coc-sync-landing.md`. Holds BLOCKED-rationalization enumerations, extended bash examples, the 2026-05-02 origin post-mortem, the MUST NOT clauses, and the cross-rule relationship list — material that would exceed the slim rule's cap-headroom budget under the rs-axis baseline emit.

## MUST Rule 1 — Extended Context

### Full bash sequence

```bash
# DO — branch, stage explicit paths, commit, push, PR, admin-merge
git checkout -b chore/coc-sync-<date-or-version>
git add .claude/ scripts/hooks/   # explicit paths only — see Rule 2
git commit -m "chore(coc): land /sync-to-build delivery <version>"
git push -u origin <branch>
gh pr create --title "..." --body "..."
gh pr merge <N> --admin --merge --delete-branch
git checkout main && git pull --ff-only

# DO NOT — work around the drift on an unrelated PR
git checkout -b feat/some-other-thing
git add path/to/feature/file   # leaves the COC drift floating
# (the drift sits uncommitted across this PR and the next and the next...)
```

### BLOCKED rationalizations

- "I'll land it after this other PR"
- "It's been sitting there for days, one more session is fine"
- "The user didn't explicitly ask me to land it"
- "Staging only the files I touched is safer"
- "Loom keeps re-syncing anyway, no rush"
- "The current session goal is something else"
- "It's a chore PR, low priority"

### Why expanded

When loom's `/sync-to-build` delivers artifacts and they sit uncommitted, every session sees them on disk and assumes they're "available" — but the moment any commit moves them to a feature branch, switching to main silently removes them. New commands like `/autonomize` disappear; new agents like `cli-orchestrator` become invisible. The drift IS the failure mode. Multi-session deferral compounds the surprise — by the time someone notices, three teammates are on three different "this command should exist" workarounds. Landing as PR #1 is cheap (the SessionStart hook already gave the agent the file list and the command sequence); deferral is expensive.

## MUST Rule 2 — Extended Context

### Full bash examples

```bash
# DO — explicit, sweeping only the COC delivery
git add .claude/ scripts/hooks/

# DO NOT — bulk staging
git add -u                             # sweeps any other modifications
git add -A                             # also includes untracked non-COC content
git add . && git commit                # same problem
```

### BLOCKED rationalizations

- "I checked `git status`, there's nothing else"
- "The other modifications are mine, they can ride along"
- "Workspace artifacts are part of the same logical change"
- "It's faster than typing the explicit paths"

### Why expanded

PR #753's force-push recovery (2026-05-01) wasted ~15 minutes after `git add -u` swept workspace artifacts and unrelated drift into a COC-sync PR. Explicit paths are the structural defense — they make the PR's scope match the PR's title. Workspace artifacts and active workstream files belong with their workstream's PR, not with the COC delivery.

## MUST Rule 3 — Extended Context

### Full bash examples

```bash
# DO — admin-merge as soon as CI is green (or auto-skip confirmed)
gh pr merge <N> --admin --merge --delete-branch

# DO NOT — leave open "for review", let the next session inherit it
gh pr view <N>     # "OPEN, REVIEW_REQUIRED" — and the session ends with it still open
```

### BLOCKED rationalizations

- "Review-required is a process for a reason"
- "I'll merge after the user confirms"
- "Other PRs are waiting for it; let's batch-merge"
- "The session is ending; next session can finish"

### Why expanded

The owner workflow established across PR #748 / #749 / #750 / #751 / #752 / #753 / #754 / #808 / #809 is admin-merge for chore-class PRs that pass CI. The branch protection's `REVIEW_REQUIRED` state is the mechanical gate; `--admin` is the human bypass for owner-class operations. Without admin-merge the PR sits open, the drift returns to "carried across sessions", and the failure mode resumes.

## MUST NOT Clauses

The slim rule cuts the MUST NOT block to bullets only. Full text:

- **Treat COC drift as "background" while doing other work.** Background drift is the literal failure mode. Foreground it as PR #1.
- **Defer the merge to "after CI" if CI doesn't fire on the diff.** `.claude/**`-only and `scripts/hooks/**`-only diffs auto-skip the matrix per the workflows' path filters. CI green is instantaneous (zero checks reported). Waiting for "CI to settle" is waiting for nothing.
- **Skip the admin-merge step because the user "will get to it".** This rule exists because that disposition repeatedly produced the failure mode. The agent owns the merge unless explicitly told otherwise.

## Origin Post-Mortem (2026-05-02)

A kailash-rs session opened with `/autonomize` unknown despite the command having been delivered to the working tree by the prior `/sync-to-build` cycle. The user response was emphatic: **"ALWAYS get the updated coc artifacts INTO MAIN BRANCH!!! Never leave them out! memory IS NOT ENOUGH"**.

The phrase "memory IS NOT ENOUGH" pinpoints the structural failure: an earlier attempt to enforce sync-landing via cross-session memory feedback was insufficient. Cross-session memories are loaded on session start, but they are passive — they describe a desired behavior without forcing the agent to act on it before doing other work. The agent reads the memory, acknowledges it, and proceeds with whatever the user asked next.

Three-layer defense was authored at commit `91c81ac4`:

1. **Hook layer** (`.claude/hooks/coc-drift-warn.js`) — SessionStart hook that scans for working-tree drift under `.claude/**` and `scripts/hooks/**`, emits a loud "🚨 COC ARTIFACT DRIFT DETECTED" warning to the session's additional context. The hook is the structural enforcement: the warning fires every session start regardless of whether the agent reads any rule.
2. **Rule layer** (`.claude/rules/coc-sync-landing.md`) — this rule. Linguistic complement; prescribes the exact action sequence the agent MUST take when the hook fires. Three MUST clauses cover: drift lands as PR #1; explicit-path staging; admin-merge per owner workflow.
3. **Memory layer** (cross-session feedback memory) — third backstop. Captures the user's directive in language the agent can recall in any subsequent session even if the rule and hook are accidentally disabled.

The three layers are intentionally redundant. Each has a different failure mode: hook can be removed from settings.json; rule can be skipped under time pressure; memory can be ignored. Together they are loud enough that the agent has no plausible "I didn't see it" rationalization.

## Cross-Rule Relationships

- **`.claude/hooks/coc-drift-warn.js`** — structural enforcement (SessionStart loud warning). Pairing constraint: rule and hook MUST land in same /sync cycle. Distributing the rule without the hook leaves the rule as linguistic-only (no structural enforcement). Distributing the hook without the rule leaves the hook uncited (the warning text references rules/coc-sync-landing.md MUST Rule 1).
- **`rules/artifact-flow.md`** — upstream contract. BUILD repos receive deliveries via /sync-to-build but do NOT sync directly to anywhere. This rule prescribes the LANDING discipline on the BUILD side after the inbound delivery completes.
- **`rules/git.md` § Branch Protection** — admin-merge workflow precedent. The `gh pr merge --admin --merge --delete-branch` pattern in MUST Rule 3 is the same owner-bypass pattern documented there for chore-class PRs.
- **`rules/git.md` § Pre-FIRST-Push CI Parity Discipline** — does NOT apply to `.claude/**`-only diffs. The Rust pre-flight (`cargo +nightly fmt --all --check + cargo clippy + cargo nextest run + cargo doc`) and Python pre-flight (`pre-commit run --all-files + pytest + mypy`) are required for source-touching PRs. COC-sync PRs auto-skip the matrix per workflow path filters; CI green is instantaneous; pre-flighting is unnecessary.

## Note on Rule Ordering Across Sessions

A session that runs `/codify` AHEAD of landing the sync delivery is in technical violation of MUST Rule 1 ("COC Drift Lands as PR #1 of the Session"). The 2026-05-05 codify cycle (PR #808) was such an override — the user explicitly directed `/codify` first to close an audit-trail gap, then directed the sync landing (PR #809). Per MUST Rule 1's prose, the override was correct; the agent owns the merge unless told otherwise. When user direction explicitly inverts the default ordering, the override is honest and traceable; it is NOT a rationalization to skip Rule 1.

This pattern — user-directed inversion — is the only legitimate way to land a non-COC PR ahead of an outstanding COC drift. Agent-initiated inversions (the agent decides the codify is more important) remain BLOCKED.
