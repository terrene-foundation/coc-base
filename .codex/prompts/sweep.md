---
name: sweep
description: "Comprehensive outstanding-work audit for the current project — workspaces, GH issues, redteam-vs-specs gaps, and process hygiene. End-of-cycle gate before /wrapup."
---

## Purpose

A `/sweep` is the structural defense against "I think we're done." Before declaring a session converged or starting fresh work, surface every class of outstanding item: in-flight todos, open GH issues (this repo), spec-vs-code redteam gaps, stale workspace state, and process-hygiene gaps.

Distinct from `/redteam` (scopes to ONE workspace's spec compliance) — `/sweep` is repo-wide and rolls every workspace's redteam status into one view.

**Project-scoped by default** — Sweeps 1-8 target the CURRENT repo only. They do NOT compare against sibling SDK repos, PyPI, or BUILD-only state. BUILD repos (kailash-py, kailash-rs) maintain a richer LOCAL `commands/sweep.md` with cross-SDK + sibling-package + source-protection sweeps; do not edit those from here. **Orchestration-root exception:** Sweep 9 (below) adds a cross-ecosystem roll-up that fires only where an operator has DECLARED an ecosystem resolver config and the clone is not a declared consumer role — canonically loom (`rules/repo-scope-discipline.md` § Exceptions). It self-detects and emits an N/A sentinel otherwise, so the distributed command stays byte-identical on the 30+ downstream consumers (which carry no resolver config).

## Execution Model

Autonomous — runs every sweep sequentially, accumulates findings into a single **management decision report** (`.codex/skills/sweep/` § 1). Every finding is CATEGORY-classified per `rules/product-completion-first.md` (BUG / INVEST-NOW ISSUE / INCREMENTAL IMPROVEMENT — severity ranks, never gates fix-vs-defer): BUG + INVEST-NOW → FIX-NOW (invest-now judgment calls surfaced at the report's Decision Points for co-owner direction); INCREMENTAL → the deferred-quality tracking list under the four generalized `zero-tolerance.md` Rule-1b conditions. The agent MAY fix trivial BUGs inline (per `rules/zero-tolerance.md` Rule 1: "if you found it, you own it") but MUST surface every finding with its category + disposition; a completion-blocking finding deferred as "incremental" is BLOCKED (`product-completion-first.md` MUST-2).

## Workflow

Run all 10 sweeps (Sweep 9 self-skips to N/A off the orchestration root). Aggregate findings into the management decision report (§ Output) — each finding carries CATEGORY (BUG / INVEST-NOW / INCREMENTAL per `rules/product-completion-first.md`), severity (CRIT / HIGH / MED / LOW — ranks only), disposition, and pointer (file:line, PR#, issue#).

### Sweep 1: Active todos across all workspaces

```bash
find workspaces/*/todos/active/ -name "*.md" -not -name "*-milestone-tracker.md" 2>/dev/null
```

Read frontmatter (`status`, `priority`, `wave`). Group by workspace. Per `rules/value-prioritization.md` MUST-3+4, classify each stale (>7d) item into one of THREE dispositions — never `Stale` alone, never auto-close: **(a) still-wanted** (re-validate value-anchor, re-queue with explicit value-rank citing brief / spec § / journal DECISION); **(b) abandon-with-user-gate** (recommend closure with value-decay rationale, surface to user — auto-close as `not_planned` is BLOCKED); **(c) queued-with-value-rank** (alive but lower-priority; explicit anchor required). Items lacking value-anchors entirely surface as a separate finding: "value-anchor absent — request from user before re-queuing."

### Sweep 2: Pending journal entries (auto-generated, awaiting promotion)

```bash
find workspaces/*/journal/.pending/ -name "*.md" 2>/dev/null
```

Per `rules/journal.md`: high-value commit body → promote, bare merge → discard, already-codified → discard with note.

### Sweep 3: GitHub open issues — current repo (auto-detected)

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)
gh issue list --repo "$REPO" --state open --limit 50 \
  --json number,title,labels,createdAt,updatedAt,comments
```

Categorize: **`deferred` label** (verify Rule 1b 4-condition body per `rules/zero-tolerance.md`), **Closeable** (delivered code per `rules/git.md` § Issue Closure Discipline), **Genuinely actionable**. Per `rules/value-prioritization.md` MUST-4, `Stale` is NOT a closure category — auto-closing stale issues as `not_planned` because of age is BLOCKED. Stale issues route through the same three-disposition classification as Sweep 1 (still-wanted re-validate / abandon-with-user-gate / queued-with-value-rank).

### Sweep 4: Open PRs and stale feature branches

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)
gh pr list --repo "$REPO" --state open --limit 50 \
  --json number,title,headRefName,isDraft,createdAt,statusCheckRollup
git branch -r --no-merged origin/main 2>&1 | grep -v "HEAD ->"
```

Surface: drafts >7d, PRs with red CI (never merge red — fix in same branch per `rules/git.md`), remote branches without PR (orphan work), local-only branches.

### Sweep 5: Redteam gaps against full specs (every workspace)

`/redteam` re-derived as a repo-wide sweep. Use `skills/spec-compliance/SKILL.md` protocol — AST/grep verification, never file existence.

**Pre-condition check (run FIRST):** Sweep 5 only applies in repos that have BOTH (a) at least one `workspaces/*/specs/` directory containing per-workspace specs AND (b) `tools/sweep-redteam.py` (or language equivalent under `tools/`). If EITHER is absent, the repo is in **orchestration mode** (loom, USE templates) — Sweep 5 logs the sentinel `<!-- sweep-redteam:v1:N/A reason=orchestration-mode no_specs=<bool> no_tool=<bool> -->` into the sweep report and Sweep 5 is complete. This is NOT a substitution decision (no proxy is run); it is a structural N/A, recorded explicitly so future readers can grep the sentinel.

When BOTH conditions hold (BUILD repos: kailash-py, kailash-rs), Sweep 5 MUST invoke `tools/sweep-redteam.py` (or the equivalent at `tools/` for the consumer project's language) and embed its sentinel comment + findings into the sweep report. Substituting `tools/spec-cite-check.py` or any other proxy for the mandated per-spec symbol + Tier 2 coverage verification is BLOCKED — see `rules/sweep-completeness.md` for the human-gate requirement when proxy substitution is genuinely warranted. The TOOL is BUILD-local (each repo owns `tools/`); the SKILL text mandates the invocation pattern.

```bash
# Pre-condition gate
spec_count=$(find workspaces/*/specs -type d -mindepth 1 2>/dev/null | wc -l | tr -d ' ')
tool_present=$([ -f tools/sweep-redteam.py ] && echo true || echo false)
if [ "$spec_count" = "0" ] || [ "$tool_present" = "false" ]; then
  echo "<!-- sweep-redteam:v1:N/A reason=orchestration-mode no_specs=$([ $spec_count = 0 ] && echo true || echo false) no_tool=$([ $tool_present = false ] && echo true || echo false) -->"
  exit 0  # Sweep 5 complete
fi

# BUILD-mode: run per-workspace
for ws in workspaces/*/; do
  [ -d "$ws/specs" ] && echo "WORKSPACE: $ws"
done
# Per workspace, per spec: invoke tools/sweep-redteam.py — single-pass
# walk + compiled regex per MUST symbol; verify the contract holds;
# verify Tier 2 coverage exists. Embed the tool's sentinel comment
# `<!-- sweep-redteam:v1:OK specs=N symbols=M orphans=O coverage_gaps=C stubs=S -->`
# into the sweep report so readers (and any future enforcement hook)
# can verify the mandated step actually ran.
```

Categorize findings:

- **Orphan** — spec promises symbol; source has none (`rules/orphan-detection.md` § 1)
- **Drift** — spec says X; source does Y (`rules/specs-authority.md` § 6)
- **Coverage gap** — symbol exists; no Tier 2 wiring test (`rules/facade-manager-detection.md` § 2)
- **Stub** — `NotImplementedError` / `TODO` / `pass` in production paths (`rules/zero-tolerance.md` Rule 2)

Roll up: per workspace, count findings by category. Workspaces with ≥3 unresolved gaps → flag as candidates for a follow-up `/redteam` round.

### Sweep 6: Workspace + worktree + forest-ledger hygiene

```bash
find workspaces/*/.session-notes -mtime +30 2>/dev/null            # stale session notes
git worktree list                                                  # orphan worktrees
find workspaces/*/journal/.pending/*.md -mtime +14 2>/dev/null     # stale .pending
node .claude/bin/validate-forest-ledger.mjs --aggregate            # forest rollup, workspace→root (#669)
```

Surface: workspaces with `.session-notes` >30d (archive), worktrees not at HEAD or zero-commit (cleanup per `rules/worktree-isolation.md`), `.pending` >14d (promote OR discard). The `--aggregate` step (issue #669) reads EVERY `workspaces/*/.session-notes` (and its M6-D split `.session-notes.shared.md`) forest ledger — regardless of MTIME or issue state — and flags any OPEN row whose ID is absent from the ROOT ledger (the cross-file no-vanish gate; closes the gap where this sweep `stat`-ed MTIME but never opened the file). Each `[AGG]` finding is a STRANDED forest workstream: roll it into the report with its value-anchor (`rules/value-prioritization.md` MUST-2) AND into the root ledger at `/wrapup`. The bare `find` MTIME check is retained for archival hygiene; it does NOT substitute for the ledger read.

### Sweep 7: Process hygiene (uncommitted, divergence, zero-tolerance)

```bash
git status --short
git rev-list --left-right --count origin/main...HEAD 2>/dev/null
grep -rEn 'TODO|FIXME|HACK|XXX|NotImplementedError' \
  --include='*.py' --include='*.ts' --include='*.tsx' --include='*.js' --include='*.rs' \
  --exclude-dir=node_modules --exclude-dir=target --exclude-dir=.venv \
  -l 2>/dev/null | head -20
```

Surface: uncommitted changes, branch ahead/behind origin/main, new stub markers in production code (BLOCKED per `rules/zero-tolerance.md` Rule 2).

### Sweep 8: Release readiness (publishing repos only)

For repos that publish version anchors (`pyproject.toml` + `__init__.py`, or language equivalent), determine what is GENUINELY unreleased. The diff base MUST be derived mechanically from the latest stable tag — hand-picking a base tag is BLOCKED (a stale base re-flags already-released fixes as "unreleased" on every sweep). Non-publishing repos: record "N/A — non-publishing" and move on.

```bash
# plain vX.Y.Z stable tags ONLY — `$`-anchor excludes prerelease (-rc1) and
# package-prefixed (pkg-v*) tags so a future v2.29.0-rc1 cannot sort above v2.29.0
LATEST=$(git tag --sort=-version:refname | grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
git log --oneline "$LATEST"..HEAD -- src/ packages/*/src 2>/dev/null   # shippable code ONLY
```

Flag "unreleased work" ONLY when the shippable-code diff is non-empty; docs / `.claude/` / workspace diffs do NOT ship → record "no shippable change since `$LATEST`". Before naming any merged PR as unreleased, confirm via `git merge-base --is-ancestor <sha> "$LATEST"` (ancestor = already released).

### Sweep 9: Cross-ecosystem outstanding work (loom orchestration-root ONLY)

The all-repo-surfaces roll-up (Directive 2) — the ONE sweep that reads across repos. It fires only where an operator has DECLARED an ecosystem resolver config AND the clone is not a declared consumer role — canonically loom (`rules/repo-scope-discipline.md` § Exceptions, "loom is the SOLE carve-out holder"); a clone declaring `role: build`/`use-consumer` is suppressed even if configured (`resolveRole()` alone is NOT the gate — it is `null` on a role-undeclared loom, so `isConfigured()` is the positive signal and the role check only SUBTRACTS declared consumers).

**Pre-condition gate (run FIRST)** — prints logical KEYS only (NEVER a resolved absolute path — the loom-links caller contract), or the N/A sentinel:

```bash
node --input-type=module -e 'import("./.claude/bin/lib/loom-links.mjs").then(m=>{const r=m.resolveRole();if(!m.isConfigured()||r==="build"||r==="use-consumer")return console.log("<!-- sweep-ecosystem:v1:N/A reason=not-orchestration-root -->");for(const[k,v]of m.resolveAll())if(/^(build|use-template)\./.test(k))console.log(v.kind==="path"?k:k+" ["+v.kind+(v.error?": "+v.error:"")+"]")}).catch(e=>console.log("<!-- sweep-ecosystem:v1:ERROR reason="+e.message+" -->"))'
```

Only the N/A sentinel → a downstream consumer (no config, or a declared build/use-consumer role): a **structural** N/A (no proxy run — `rules/sweep-completeness.md`), grep-able, keeping the distributed command byte-identical. Otherwise each printed line is a `build.*`/`use-template.*` KEY tagged by `resolveAll()` kind: a **bare key** is a local checkout — resolve its path at RUNTIME via `resolveRepo(key)` (returned, never logged into the report) and run the full roll-up; a `<key> [url]` is a remote-only target (no local checkout) — sweep its open PRs via the remote, skip local-divergence; a `<key> [error: …]` (or the ERROR sentinel) is itself a finding — surface it, never positional-guess a fallback (`rules/cross-repo.md` MUST-1). Roll up (local-checkout keys):

- **Open PRs** — `(cd "<path>" && gh pr list --state open)` (drafts >7d, red CI; #30-style `--no-merge` distribution PRs awaiting a gate surface here).
- **COC drift** — `node .claude/bin/check-sync-freshness.mjs --target "<key>"` (the printed key IS the target slug; flags a consumer behind loom's last `/sync-to-use`).
- **Local divergence** — `git -C "<path>" status --porcelain` + `git -C "<path>" rev-list --left-right --count origin/main...HEAD`.

Roll every finding into the report BY KEY + pointer, each carrying a value-anchor at `/wrapup` (`rules/value-prioritization.md` MUST-2). Emit `<!-- sweep-ecosystem:v1:targets=N prs=P drift=D -->`.

### Sweep 10: Deferred-quality product-visibility revisit (the anti-forgetting teeth)

The `deferred-quality` backlog is net-negative WITHOUT this revisit (`rules/value-prioritization.md` Origin: 7-of-7 deferred items decayed). Full procedure: `.codex/skills/sweep/` § 2. In brief:

```bash
gh issue list --label deferred-quality --state open \
  --json number,title,body,labels,createdAt --limit 100
```

Group by revisit trigger (`after-milestone:<name>` | `on-demand`). Surface a `value-prioritization.md` MUST-3 "still wanted?" gate for any item deferred ≥2 sweeps/sessions ago. At a product-visibility milestone (terminal wave converges / release tag), re-surface EVERY item whose `after-milestone:<name>` matches, re-value-rank, re-validate the value-anchor, and present the user-gated disposition per item — **implement / re-defer-with-fresh-anchor / close-with-gate** (`value-prioritization.md` MUST-4: no auto-close as `not_planned`, no OR-escape). The agent recommends; the human decides.

## Output

Write the report to `workspaces/<project>/04-validate/sweep-<date>.md` (workspace context active) OR `SWEEP-<date>.md` at root. `/sweep` is a **management decision report FOR DECISION-MAKING AT THIS JUNCTURE** — full contract at `.codex/skills/sweep/` § 1. It MUST carry, in order: **(1) Completion status** (which milestones are complete AND _visible_, each citing a durable receipt per `rules/verify-resource-existence.md` MUST-4); **(2) ETA to completion** (remaining BUG + INVEST-NOW work in autonomous cycles, never human-days — `rules/autonomous-execution.md`); **(3) Prioritized immediate queue** (open BUGs + INVEST-NOW, value-ranked per `rules/value-prioritization.md` MUST-1, each with implication); **(4) Deferred-quality backlog** (INCREMENTAL items grouped by revisit trigger, each with value-anchor + the four generalized-1b conditions); **(5) Decision points** (the INVEST-NOW-vs-defer judgment calls, each with implications + symmetric pros/cons + a recommended disposition per `rules/recommendation-quality.md` MUST-1/2/3 — never silently self-decided); **(6) Recommendation** (recommended next steps for ratification, never a bare menu). Per-finding rows carry `[CATEGORY][SEVERITY][Sweep N] <title>` + Location + Disposition + Evidence. **Scrub before committing (Sweep 9/10):** the report is committed (Closure step 4), so record by logical KEY + PR#/issue# — NEVER an operator-absolute path (`/Users/<operator>/…`) or a private-org `--repo` slug — per `rules/user-flow-validation.md` MUST-6.

## Closure

Before reporting `/sweep` complete:

1. ALL Sweep 1-10 outputs accumulated (Sweep 9 = the cross-ecosystem roll-up at the orchestration root, or its N/A sentinel elsewhere; Sweep 10 = the deferred-quality product-visibility revisit)
2. Trivial fixes applied inline (`rules/zero-tolerance.md` Rule 1); reclassified `FIXED` with commit SHA
3. Non-trivial fixes filed as workspace todos OR GH issues with delivered-code references
4. Report committed (`git add` + `git commit`)
5. Optional: human authorization for the recommended next-session scope

The report is the deliverable. The agent does NOT decide what to do next — that's a human call.
