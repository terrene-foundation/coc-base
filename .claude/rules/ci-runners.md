---
priority: 10
scope: path-scoped
paths:
  - ".github/workflows/**"
  - "**/ci/**"
  - "**/.github/**"
---

# CI Runner Rules

<!-- slot:neutral-body -->

Self-hosted CI runner hygiene. Language-agnostic — applies to every project using GitHub Actions self-hosted runners regardless of SDK language.

For recovery protocols, service-management commands, and step-by-step troubleshooting, see `skills/10-deployment-git/ci-runner-troubleshooting.md`.

## MUST Rules

### 1. Every Toolchain-Consuming Job Includes A Toolchain Setup Step

Every job that invokes a language toolchain (`cargo`, `maturin`, `rustc`, `npm`, `pnpm`, `bundle`, etc.) MUST include a dedicated toolchain setup step (e.g. `dtolnay/rust-toolchain@stable`, `actions/setup-node`, `ruby/setup-ruby`) as one of its earliest steps — even if a previous job in the same workflow already installed the toolchain.

```yaml
# DO — every job re-establishes its own toolchain
steps:
  - uses: actions/checkout@v4
  - uses: dtolnay/rust-toolchain@stable
  - name: Build
    run: cargo build --release

# DO NOT — relying on a sibling job's toolchain install
steps:
  - uses: actions/checkout@v4
  - name: Build
    run: cargo build --release   # fails if PATH was re-written by an earlier job
```

**Why:** Self-hosted runners do not reset `PATH` between jobs cleanly. A sibling job that reinstalled `rustup` or ran `nvm use` leaves the runner in a state where the proxy binary (`~/.cargo/bin/rustup`, `~/.nvm/...`) may be missing or points to the wrong version. Each job re-establishing its own toolchain is the only structural defense.

### 2. Restart The Runner After Changing Its Environment File

After editing the runner's `.env` file (e.g. `~/actions-runner-*/.env`), the runner MUST be restarted via `launchctl unload && launchctl load` (macOS) or `systemctl restart` (Linux). Running jobs MUST be allowed to complete under the old environment before the restart.

```bash
# DO — explicit unload, wait for in-flight jobs, reload
launchctl unload ~/Library/LaunchAgents/com.github.actions.runner.<name>.plist
# wait for any in-flight job to drain
launchctl load ~/Library/LaunchAgents/com.github.actions.runner.<name>.plist

# DO NOT — edit .env and expect new jobs to pick up changes
vim ~/actions-runner-<name>/.env  # save
# next queued job still reads the old env because the runner process cached it at startup
```

**Why:** The runner daemon reads its `.env` once at process startup. Silent drift between "what operators edited" and "what jobs actually ran with" is invisible until a job fails with a missing variable that the operator can see in the file.

### 3. Post-fmt Cascade Discovery Protocol

When `Format` (or any early short-circuiting gate) transitions from red to green for the first time in a long while, the session MUST expect multiple subsequent failures and budget for multi-wave triage. A red fmt gate short-circuits the pipeline — Clippy, Docs, Deny, Test, MSRV, and Integration Tests are SKIPPED, not failed. Pre-existing failures in those gates accumulate invisibly and surface one-wave-at-a-time once fmt is green.

```yaml
# DO — tight triage loop until all gates green
# push → inspect failing gate → fix root cause → push → repeat
# accept that wave N+1 may reveal a failure wave N masked

# DO NOT — declare victory after fmt goes green
# gh pr checks <N>  # fmt: pass, 6 others: skipped (NOT green)
# git push origin feat/cleanup  # "CI is fixed" — it isn't
```

**BLOCKED rationalizations:**

- "Fmt is green, CI is fixed"
- "The other gates were skipped, so they're passing"
- "We can triage the rest in parallel branches"
- "These failures are pre-existing, not our problem"

**Why:** Short-circuit semantics hide months of accumulated failures behind a single red fmt. Declaring "fixed" after fmt green leaves the downstream backlog to surface on the next unrelated PR, where the failures look like new regressions. Parallel triage branches also break because each wave's fix depends on the previous wave's state.

### 4. Runner Auto-Update Disconnect Recovery

If `gh api repos/<org>/<repo>/actions/runners` returns 0 runners while the runner's stdout log tails show `Connected to GitHub` and `Listening for Jobs`, the runner auto-updated mid-session and its in-flight job is orphaned — the old worker process holds the job in GitHub's state machine but cannot report completion. The session MUST restart the runner service AND trigger a fresh run via an empty commit.

```bash
# DO — re-register the runner and trigger a fresh run
launchctl unload ~/Library/LaunchAgents/com.github.actions.runner.<name>.plist
launchctl load ~/Library/LaunchAgents/com.github.actions.runner.<name>.plist
git commit --allow-empty -m "chore(ci): trigger fresh run post-runner-update"
git push

# DO NOT — rerun the orphaned run; the dead worker still owns the job
gh run rerun <run-id> --failed  # the new worker can't claim the old worker's jobs
```

**BLOCKED rationalizations:**

- "The runner log says Connected, it must be fine"
- "Wait for the hung job to time out on its own"
- "Re-run the failed job, it'll get picked up"

**Why:** The GitHub Actions runner auto-update path renames and replaces the worker binary. Jobs assigned to the dead worker cannot be claimed by the new worker; GitHub's dispatcher needs a new trigger to assign the job. Without the service restart, the "Connected" log is from a fresh worker that never knew about the orphaned job, and the hung run blocks the PR for hours.

### 5. Release-Upload Jobs Declare `contents: write` Permission

Every workflow job that invokes `gh release upload`, `gh release create`, or the equivalent `actions/upload-release-asset` pattern MUST declare `permissions: contents: write` at workflow- or job-level. The default `GITHUB_TOKEN` scope varies by repository setting and trigger (tag push vs `workflow_dispatch` vs `release.published`), so relying on the default to "just work" is BLOCKED.

```yaml
# DO — explicit permission at workflow scope
name: release
on:
  push:
    tags: ["v*"]
permissions:
  contents: write        # MUST — gh release upload/create needs this
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Upload release asset
        run: gh release upload "${{ github.ref_name }}" dist/*.tgz

# DO — explicit permission at job scope (equivalent)
jobs:
  publish:
    permissions:
      contents: write
    runs-on: ubuntu-latest
    steps:
      - run: gh release create "${{ github.ref_name }}" dist/*.tgz

# DO NOT — rely on default GITHUB_TOKEN scope
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: gh release upload "${{ github.ref_name }}" dist/*.tgz
      # silent 403 on default-permissions repos; looks like a transport error
```

**BLOCKED rationalizations:**

- "The default token has always worked on this repo"
- "Adding the permission explicitly is noise"
- "We'll add it when we hit the 403"
- "The failure is a network issue, not a permission issue"
- "Tag-push triggers get contents: write automatically"

**Why:** GitHub's default `GITHUB_TOKEN` permissions are repository-scoped AND trigger-scoped. A repo configured for "Read and write permissions" on its Actions tab behaves differently from a repo configured for "Read repository contents and packages permissions" — and the failure manifests as a `403` on the `gh release upload` HTTP call, not a clear "permission denied" error at workflow parse time. Operators debug the network layer for hours before checking the token scope. Explicit `permissions: contents: write` at workflow- or job-level is the single structural defense: `gh release upload` / `gh release create` need it, every runtime needs it, every repo setting needs it. Make it explicit in every release-capable workflow.

**Enforcement grep:** For every workflow invoking `gh release (upload|create)` or `actions/upload-release-asset`, assert a `permissions: contents: write` declaration appears at workflow- or job-level in the same file. Mechanical — no runtime needed.

### 6. Binding-CI Paths Filter Matches The Core-Lang Pattern

Every binding-channel CI workflow (`python.yml`, `nodejs.yml`, `ruby.yml`, `wasm.yml`, etc.) MUST have a `paths:` filter that covers the transitive dependency graph of the core language, not just the binding directory. Narrow enumerations of specific packages or crates silently stop matching whenever a new transitive dependency is added.

```yaml
# DO — broad filter matches the core-language CI's pattern
on:
  pull_request:
    paths:
      - "bindings/python/**"
      - "crates/**"
      - "Cargo.toml"
      - "Cargo.lock"
      - ".github/workflows/python.yml"

# DO NOT — enumerate specific packages
on:
  pull_request:
    paths:
      - "bindings/python/**"
      - "crates/kailash-capi/**"
      - "crates/kailash-ml*/**"  # misses kailash-core, kailash-nexus, etc.
```

**BLOCKED rationalizations:**

- "The binding only depends on these packages today"
- "Broad filter triggers too many unnecessary builds"
- "We'll update the filter when we add new deps"

**Why:** Bindings transitively link most of a workspace. A narrow filter means a fix to a shared dependency triggers the core CI but skips the binding CI, letting the binding ship broken into the next release. When a shared crate change lands and the binding CI reports "no changes", that is the exact failure mode this rule prevents.

### 6a. Binding-CI `paths-ignore` Covers ALL Doc-Only Surfaces

Every binding-channel CI workflow (`python.yml`, `nodejs.yml`, `ruby.yml`) MUST include a `paths-ignore` filter that excludes ALL doc-only surfaces — not just `**/*.md`. The current `paths-ignore: ['**/*.md']` is necessary but NOT sufficient: edits to `.claude/skills/`, `.claude/agents/`, `.claude/rules/`, `docs/`, `specs/` (all CC artifacts and project docs) still trigger the full binding matrix even though they cannot affect compiled wheels.

```yaml
# DO — comprehensive doc-only exclusion
on:
  pull_request:
    paths:
      - "bindings/python/**"
      - "crates/**"
      - "Cargo.toml"
      - "Cargo.lock"
      - ".github/workflows/python.yml"
    paths-ignore:
      - "**/*.md"
      - ".claude/**"        # CC artifacts (agents, skills, rules, commands)
      - "docs/**"           # User-facing documentation
      - "specs/**"          # Domain specs (no code surface)
      - "workspaces/**"     # Session records (no code surface)
      - "memory/**"         # Auto-memory (no code surface)
      - ".github/ISSUE_TEMPLATE/**"
      - ".github/PULL_REQUEST_TEMPLATE.md"

# DO NOT — partial paths-ignore
on:
  pull_request:
    paths-ignore:
      - "**/*.md"          # misses .claude/agents/bar.json (no .md extension)
                           # which fires CI even though it cannot affect compiled binding
```

**BLOCKED rationalizations:**

- "`**/*.md` already covers most doc files"
- "Catch-all paths-ignore might mask real changes"
- "Adding more excludes is over-optimization"
- "The cost is small per PR"
- "Each doc-only PR only burns 1 minute per workflow"

**Why:** Bindings ship compiled wheels — none of the listed doc-only surfaces can affect what's built. Each non-excluded doc-only PR triggers ALL binding workflows (python + ruby + node), each billed at 1-minute minimum on `ubuntu-latest` even when they short-circuit. Compounded over 30-50 doc/codify PRs per month, this is ~150-200 min/month of pure overhead. Excluding `.claude/**`, `docs/**`, `specs/**`, `workspaces/**`, `memory/**` recovers all of that for zero correctness cost.

Origin: 2026-04-25 CI burn audit — identified 66 of 580 GHA-billable minutes were doc-only PR triggers on binding workflows, mostly on `chore/codify-*`, `feat/*-codify`, and similar non-code branches. Closing this gap eliminates that recurring class of waste.

### 7. Workflow Crons MUST Have Explicit Cost Footer

Every `.github/workflows/*.yml` with `schedule: cron:` MUST include a comment block at the top of the file (or in the workflow `name:` description) stating: (a) the cron cadence in plain English, (b) the worst-case monthly billing footprint at `ubuntu-latest` rates, (c) the failure-mode behavior (does the job exit fast on no-op, or does it always run a full body?). Workflows with cadence ≥ once-per-hour AND no fast-exit short-circuit are BLOCKED.

```yaml
# DO — cost-footer documents budget impact upfront
name: CI Queue Monitor
# ─────────────────────────────────────────────────────────────────
# COST FOOTPRINT
#   Cadence:        every 30 minutes (cron: "*/30 * * * *")
#   Monthly worst:  48 runs/day × 30 days × 1 min = 1,440 min/month
#   Fast-exit:      YES — `gh api` no-op returns in <10s; only full
#                   body fires when stuck jobs detected (rare).
#   Effective:      ~720-1,000 min/month under typical load.
# ─────────────────────────────────────────────────────────────────
on:
  schedule:
    - cron: "*/30 * * * *"

# DO NOT — uncosted high-frequency cron
on:
  schedule:
    - cron: "*/5 * * * *"   # silently consumes ~8,640 min/month
                            # at 1-min minimum billing per run
```

**BLOCKED rationalizations:**

- "Cron is cheap, the workflow exits in seconds"
- "GitHub bills exact runtime, not minimum" (FALSE — billing is per-job, 1-min minimum)
- "We can audit cost later when usage pattern stabilizes"
- "The monitor is critical — frequency reflects priority"
- "Higher cadence catches issues faster"

**Why:** GitHub Actions bills a 1-minute minimum per job invocation regardless of actual runtime. A workflow on `*/5 * * * *` (every 5 min) consumes a minimum of 8,640 min/month even if every run exits in under 10 seconds. On a 3,000-min/month free tier, a single mis-cadenced cron can consume 280%+ of the budget BEFORE any productive CI runs. The cost footer makes the trade-off explicit at author time and forces an active decision about cadence vs cost.

Origin: 2026-04-25 CI cost audit — `ci-queue-monitor.yml` configured at `cron: "*/5 * * * *"` consumed 288 min/day (ground-truth, audited at 14:00Z). At month-end this approaches 8,640 min/month — alone exceeding 2× the entire 3,000-min free tier. Cadence MUST drop to `*/30` minimum until the runner-queue load profile is characterized; the rule prevents this class of unaudited cron from re-landing.

### 8. Release PRs MUST Skip The PR-Gate Suite

Pull requests from a `release/v*` branch contain ONLY version anchors + CHANGELOG updates — zero code surface. Running the full PR-gate suite on them re-exercises code that was already tested on the source-change PRs that the release bundles. Every PR-gate job in every workflow MUST gate its `if:` to also exclude `release/*` head refs.

```yaml
# DO — PR-gate jobs exclude release branches
jobs:
  fmt:
    if: github.event_name == 'pull_request' && !startsWith(github.head_ref, 'release/')
    ...

  # binding workflows (triggered on pull_request only — no push: block)
  build:
    if: ${{ !startsWith(github.head_ref, 'release/') }}
    ...

# DO NOT — PR-gate jobs fire on release/v* PRs
jobs:
  fmt:
    if: github.event_name == 'pull_request'
    # No head_ref exclusion — release/v3.20.2 re-runs the whole suite
    # against a diff that is ONLY version anchors + CHANGELOG.
    ...
```

**BLOCKED rationalizations:**

- "The version bump might have broken something; defense-in-depth"
- "Running CI on release PRs is the standard release gate"
- "We want to verify the lockfile regeneration didn't break compile"
- "Admin-merge with bypass is safer than baking skip into the workflow"
- "Next contributor might add real code changes to a release branch"
- "release.yml's source-protection-audit is a different gate; we still need PR CI"

**Why:** Release PRs under the `release/v*` branch convention (see `git.md` § "Release-Prep PRs MUST Use `release/v*` Branch Convention") are by contract metadata-only. The source changes they bundle were each individually verified on their own PR — re-running the full suite a third time against a pure-metadata diff adds no coverage and wastes ~45 min of runner wall-clock per release cycle. The tag-triggered release workflow has its own gate that validates the actual published artifacts — THAT is the release gate, not PR CI. If a contributor smuggles a code change into a `release/v*` branch, the merge-commit push event will still fire integration jobs on main post-merge, which will catch integration-level regressions.

**Contract:** `release/v*` branches are reserved for release-cut commits — version bumps in `pyproject.toml` / `Cargo.toml` / `__init__.py` / lib.rs `pub const VERSION`, CHANGELOG entries, version-anchor updates in spec / doc index files, and lockfile regeneration side effects. Anything else on a `release/v*` branch is a process error.

**Enforcement:** `/redteam` MUST verify every PR-gate job in every workflow includes `!startsWith(github.head_ref, 'release/')` in its `if:` clause:

```bash
# Every non-main-only job in every workflow MUST have the release-skip clause
for f in .github/workflows/*.yml; do
  pr_gated=$(grep -c "if:.*pull_request\|if:.*!startsWith.*release" "$f")
  jobs_count=$(grep -c "^  [a-z][a-z_-]*:$" "$f")
  real_jobs=$((jobs_count - 1))  # subtract trigger block
  echo "$f: $real_jobs jobs, $pr_gated have release-skip clause"
  # Any discrepancy is a HIGH finding
done
```

Origin: 2026-04-22 — user observed a release PR (pure version bump, 6 files touched, zero code surface) running the full PR-gate suite for the third time on the same code. Codified as a MUST gate in the same session; savings are per-release cycle (~45 min). Cross-references `git.md` § "Release-Prep PRs MUST Use `release/v*` Branch Convention" (always-loaded baseline) for branch-naming-time visibility into the cost lever.

## MUST NOT Rules

### 1. Never Commit Registration Tokens

Runner registration tokens expire after 1 hour and become credentials once committed. MUST NOT commit hardcoded tokens to version control. Always use placeholder `RUNNER_TOKEN="REPLACE_WITH_FRESH_TOKEN"` in setup scripts.

**Why:** A token committed to a public branch is harvested by token scanners within minutes and used to register unauthorized runners into the repository's job queue.

### 2. Every `upload-artifact` Step MUST Use `continue-on-error: true`

GitHub Actions artifact storage has a per-account quota that recalculates every 6-12 hours. When exhausted, `upload-artifact` returns `Failed to CreateArtifact: Artifact storage quota has been hit` and fails the job even though the underlying build succeeded. This masks real build success with an infrastructure billing problem.

Every `actions/upload-artifact@v*` step across ALL workflows MUST include `continue-on-error: true`:

```yaml
# DO
- uses: actions/upload-artifact@v7
  continue-on-error: true
  with:
    name: wheel-${{ matrix.python-version.label }}
    path: target/wheels/*.whl

# DO NOT
- uses: actions/upload-artifact@v7
  with:
    name: wheel-${{ matrix.python-version.label }}
    path: target/wheels/*.whl
```

**BLOCKED rationalizations:**

- "The upload failure is a legitimate build failure"
- "Adding continue-on-error hides real problems"
- "We'll fix it when the quota resets"
- "This only affects release.yml"

**Why:** The failure mode re-surfaces every ~12h on PR CI until someone re-discovers the fix. Codify once, apply everywhere.

Origin: 2026-04-16/17 CI cascade — 12 consecutive waves fixed pre-existing failures hidden by fmt short-circuit. Wave 17 fixup to a shared crate didn't trigger Python/Node/Ruby binding CI because their paths filters excluded the shared-crates tree. Runner auto-update at a trivial commit orphaned one run and required a service restart. Recovery protocols for each MUST rule live in `skills/10-deployment-git/ci-runner-troubleshooting.md`.

<!-- /slot:neutral-body -->
