# CI Runner Rules — Extended Evidence and Examples

Companion reference for `.claude/rules/ci-runners.md`. Holds post-mortems, extended YAML examples, enforcement-grep snippets, and session evidence that would exceed the 200-line rule budget.

For recovery protocols, service-management commands, and step-by-step troubleshooting, see `skills/10-deployment-git/ci-runner-troubleshooting.md`.

## Rule 5 — Release-Upload Permission: Full Examples

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

### Why — Extended

GitHub's default `GITHUB_TOKEN` permissions are repository-scoped AND trigger-scoped. A repo configured for "Read and write permissions" on its Actions tab behaves differently from a repo configured for "Read repository contents and packages permissions" — and the failure manifests as a `403` on the `gh release upload` HTTP call, not a clear "permission denied" error at workflow parse time. Operators debug the network layer for hours before checking the token scope. Explicit `permissions: contents: write` at workflow- or job-level is the single structural defense: `gh release upload` / `gh release create` need it, every runtime needs it, every repo setting needs it. Make it explicit in every release-capable workflow.

### Enforcement Grep

For every workflow invoking `gh release (upload|create)` or `actions/upload-release-asset`, assert a `permissions: contents: write` declaration appears at workflow- or job-level in the same file. Mechanical — no runtime needed.

```bash
for f in .github/workflows/*.yml; do
  if grep -q 'gh release \(upload\|create\)\|actions/upload-release-asset' "$f"; then
    grep -q 'contents: write' "$f" || echo "MISSING permissions in $f"
  fi
done
```

## Rule 6a — Binding-CI `paths-ignore`: Full Block

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

### Why — Extended

Bindings ship compiled wheels — none of the listed doc-only surfaces can affect what's built. Each non-excluded doc-only PR triggers ALL binding workflows (python + ruby + node), each billed at 1-minute minimum on `ubuntu-latest` even when they short-circuit. Compounded over 30-50 doc/codify PRs per month, this is ~150-200 min/month of pure overhead. Excluding `.claude/**`, `docs/**`, `specs/**`, `workspaces/**`, `memory/**` recovers all of that for zero correctness cost.

Origin: 2026-04-25 kailash-rs gh-manager CI burn audit — identified 66 of 580 GHA-billable minutes were doc-only PR triggers on binding workflows, mostly on `chore/codify-*`, `feat/rls-*-codify`, and similar non-code branches. Closing this gap eliminates that recurring class of waste.

## Rule 7 — Cron Cost-Footer: Full Comment Template

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

Origin: 2026-04-25 kailash-rs gh-manager audit — `ci-queue-monitor.yml` configured at `cron: "*/5 * * * *"` consumed 288 min/day (ground-truth, audited at 14:00Z). At month-end this approaches 8,640 min/month — alone exceeding 2× the entire 3,000-min free tier. Cadence MUST drop to `*/30` minimum until the runner-queue load profile is characterized; the rule prevents this class of unaudited cron from re-landing.

## Rule 8 — Release PR Skip: Enforcement Grep

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

### Contract

`release/v*` branches are reserved for release-cut commits — version bumps in `pyproject.toml` / `Cargo.toml` / `__init__.py` / lib.rs `pub const VERSION`, CHANGELOG entries, version-anchor updates in spec / doc index files, and lockfile regeneration side effects. Anything else on a `release/v*` branch is a process error.

### Why — Extended

Release PRs under the `release/v*` branch convention (see `git.md` § "Release-Prep PRs MUST Use `release/v*` Branch Convention") are by contract metadata-only. The source changes they bundle were each individually verified on their own PR — re-running the full suite a third time against a pure-metadata diff adds no coverage and wastes ~45 min of runner wall-clock per release cycle. The tag-triggered release workflow has its own gate that validates the actual published artifacts — THAT is the release gate, not PR CI. If a contributor smuggles a code change into a `release/v*` branch, the merge-commit push event will still fire integration jobs on main post-merge, which will catch integration-level regressions.

Origin: 2026-04-22 kailash-rs session — user observed release PR #531 (pure version bump, 6 files touched, zero code surface) running the full PR-gate suite for the third time on the same code. Codified as a MUST gate in the same session; savings are per-release cycle (~45 min). Cross-references `git.md` § "Release-Prep PRs MUST Use `release/v*` Branch Convention" (always-loaded baseline) for branch-naming-time visibility into the cost lever.

## kailash-rs CI Cascade Waves 6-18 — Full Origin Narrative

12 consecutive waves fixed pre-existing failures hidden by fmt short-circuit. After fmt finally turned green for the first time in months, Clippy lit up red (Wave 6), then Docs (Wave 7), then Deny (Wave 8), then Test (Wave 9), continuing through Wave 18. Each wave's fix was a dependency of the next wave's signal.

Wave 17 fixup to a shared crate didn't trigger Python/Node/Ruby binding CI because their paths filters excluded the shared-crates tree — exactly the failure mode Rule 6 prevents. Runner auto-update at a trivial commit orphaned one run and required a service restart — exactly the failure mode Rule 4 prevents.

Recovery protocols for each MUST rule live in `skills/10-deployment-git/ci-runner-troubleshooting.md`.

Commit range: `ecc50c4e..5429928c`, 2026-04-16/17.
