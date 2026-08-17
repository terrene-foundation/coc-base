---
id: "SWEEP"
name: sweep
description: "Comprehensive outstanding-work audit for the current project — workspaces, GH issues, redteam-vs-specs gaps, and process hygiene. End-of-cycle gate before /wrapup."
---

## Purpose

A `/sweep` is the structural defense against "I think we're done." Before declaring a session converged or starting fresh work, surface every class of outstanding item: in-flight todos, open GH issues (this repo), spec-vs-code redteam gaps, stale workspace state, and process-hygiene gaps.

Distinct from `/redteam` (scopes to ONE workspace's spec compliance) — `/sweep` is repo-wide and rolls every workspace's redteam status into one view.

**Project-scoped by default** — Sweeps 1-8 target the CURRENT repo only. They do NOT compare against sibling SDK repos, PyPI, or BUILD-only state. BUILD repos (kailash-py, kailash-rs) maintain a richer LOCAL `commands/sweep.md` with cross-SDK + sibling-package + source-protection sweeps; do not edit those from here. **Orchestration-root exception:** Sweep 9 (below) adds a cross-ecosystem roll-up that fires only where an operator has DECLARED an ecosystem resolver config and the clone is not a declared consumer role — canonically loom (`rules/repo-scope-discipline.md` § Exceptions). It self-detects and emits an N/A sentinel otherwise, so the distributed command stays byte-identical on the 30+ downstream consumers (which carry no resolver config).

## Execution Model

Autonomous — runs every sweep sequentially, accumulates findings into a single **management decision report** (`.claude/skills/sweep/` § 1). Every finding is CATEGORY-classified per `rules/product-completion-first.md` (BUG / INVEST-NOW ISSUE / INCREMENTAL IMPROVEMENT — severity ranks, never gates fix-vs-defer): BUG + INVEST-NOW → FIX-NOW (invest-now judgment calls surfaced at the report's Decision Points for co-owner direction); INCREMENTAL → the deferred-quality tracking list under the four generalized `zero-tolerance.md` Rule-1b conditions. The agent MAY fix trivial BUGs inline (per `rules/zero-tolerance.md` Rule 1: "if you found it, you own it") but MUST surface every finding with its category + disposition; a completion-blocking finding deferred as "incremental" is BLOCKED (`product-completion-first.md` MUST-2).

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
git branch -r --no-merged origin/main 2>&1 | grep -v "HEAD ->"   # NOT the sole source — see below
git branch --format='%(refname:short)'                            # unfiltered local enumeration
git for-each-ref --format='%(refname:short)' refs/remotes/origin  # unfiltered remote enumeration
```

Surface: drafts >7d, PRs with red CI (never merge red — fix in same branch per `rules/git.md`), remote branches without PR (orphan work), local-only branches.

**`--no-merged` is a RANKER, never the enumeration source.** It hides any ref tip-equal to `origin/main` — exactly what an ABANDONED mid-flight branch looks like once main catches up. Enumerate unfiltered FIRST, rank with `--no-merged`, and **read the hits, not the tally** (`rules/instrument-discipline.md` MUST-3(b)). Harness-default `worktree-agent-*` orphans are the class it hid: surface them here as REFS; their FOREST disposition is Sweep 6's reap audit (`worktree-isolation.md` Rule 8). Depth: `.claude/skills/sweep/` § 5.

### Sweep 5: Redteam gaps against full specs (every workspace)

`/redteam` re-derived as a repo-wide sweep. Use `skills/spec-compliance/SKILL.md` protocol — AST/grep verification, never file existence.

**Pre-condition check (run FIRST):** Sweep 5 only applies in repos that have BOTH (a) at least one `workspaces/*/specs/` directory containing per-workspace specs AND (b) `tools/sweep-redteam.py` (or language equivalent under `tools/`). If EITHER is absent, the repo is in **orchestration mode** (loom, USE templates) — Sweep 5 logs the sentinel `<!-- sweep-redteam:v1:N/A reason=orchestration-mode no_specs=<bool> no_tool=<bool> -->` into the sweep report and Sweep 5 is complete. This is NOT a substitution decision (no proxy is run); it is a structural N/A, recorded explicitly so future readers can grep the sentinel.

**Absent per-workspace specs does NOT imply absent spec AUTHORITY — check the repo level before claiming N/A.** When `spec_count=0` AND a repo-level spec tree exists (`docs/specs/`, `specs/`), the repo is in **repo-level-specs mode**: emitting the orchestration-mode sentinel there is the cheaper-proxy substitution `rules/sweep-completeness.md` Rule 1 blocks, wearing a structural-N/A costume, and is BLOCKED. Sweep 5 MUST instead either (a) run the equivalent spec-vs-source check against the repo-level tree, emitting `<!-- sweep-redteam:v1:REPO-LEVEL specs_root=<dir> -->`, OR (b) emit an explicit `manual-supplement-required` finding recording that the per-workspace assumption does not hold for this repo shape. **Where `.claude/bin/spec-corpus-conformance.mjs` is present (a repo whose specs govern the ARTIFACT CORPUS rather than application source), running it IS option (a)** — it verifies each spec's claims against `.claude/rules/**`, `agents/**`, `skills/**`, `commands/**`, `bin/**`, `hooks/**` and `sync-manifest.yaml`, categorises Orphan / Drift / Coverage-gap / Stub, and emits the sentinel itself, withholding it when its own anti-vacuity controls did not fire. It reports contradictions, never which side is wrong; its output is a triage list a human dispositions. Depth + the full three-mode gate implementation: `.claude/skills/sweep/` § 6.

When BOTH conditions hold (BUILD repos: kailash-py, kailash-rs), Sweep 5 MUST invoke `tools/sweep-redteam.py` (or the equivalent at `tools/` for the consumer project's language) and embed its sentinel comment + findings into the sweep report. Substituting `tools/spec-cite-check.py` or any other proxy for the mandated per-spec symbol + Tier 2 coverage verification is BLOCKED — see `rules/sweep-completeness.md` for the human-gate requirement when proxy substitution is genuinely warranted. The TOOL is BUILD-local (each repo owns `tools/`); the SKILL text mandates the invocation pattern.

```bash
# Pre-condition probe — three signals select one of three modes (full branching
# gate + BUILD-mode invocation loop: `.claude/skills/sweep/` § 6)
spec_count=$(find workspaces/*/specs -type d -mindepth 1 2>/dev/null | wc -l | tr -d ' ')
tool_present=$([ -f tools/sweep-redteam.py ] && echo true || echo false)
repo_specs=$(for d in docs/specs specs; do [ -d "$d" ] && echo "$d"; done | head -1)
# specs+tool -> BUILD mode (per-spec run, embed the tool's OK sentinel);
# spec_count=0 + repo_specs -> REPO-LEVEL mode; neither -> orchestration-mode N/A.
```

Categorize each finding **Orphan** / **Drift** / **Coverage gap** / **Stub** (definitions + owning rules: `.claude/skills/sweep/` § 6). **Option (b) is an honest label, NOT a standing exemption** — on the 3rd consecutive run carrying it, `rules/sweep-completeness.md` MUST-4 BLOCKS a 4th emission and the row becomes a Decision Point (Closure step 2).

Roll up: per workspace, count findings by category. Workspaces with ≥3 unresolved gaps → flag as candidates for a follow-up `/redteam` round.

### Sweep 6: Workspace + worktree + forest-ledger hygiene

```bash
find workspaces/*/.session-notes -mtime +30 2>/dev/null            # stale session notes
node .claude/bin/worktree-reap.mjs --json                           # forest reap audit + size (report-only)
find workspaces/*/journal/.pending/*.md -mtime +14 2>/dev/null     # stale .pending
node .claude/bin/validate-forest-ledger.mjs --aggregate            # forest rollup, workspace→root (#669)
```

Surface: workspaces with `.session-notes` >30d (archive), `.pending` >14d (promote OR discard). **The worktree forest is a REAP audit, not a listing** (`rules/worktree-isolation.md` Rule 8 — this sweep backstops the per-wave obligation, which fails silently whenever an orchestrator dies mid-wave). **ZERO-LOSS trees are now reaped automatically at SessionEnd** by `worktree-forest-guard.js` (`--apply --zero-loss-only`, kill switch `COC_WORKTREE_AUTOREAP=0`), so on a healthy repo this sweep should find few or none — a LARGE ZERO-LOSS backlog here means the unattended reap is disabled, erroring, or timing out, and THAT is the finding. What the unattended pass deliberately never does is TAG-FIRST (its durability would rest on a tag minted with nobody watching); reaping those with an operator present is this sweep's own job. Roll every `ZERO-LOSS` / `TAG-FIRST` verdict into the report as a finding with its evidence, and reap them (`--apply`, or `--apply --zero-loss-only` for the conservative pass); `KEEP` trees are never touched and need no disposition. **Report SIZE alongside the verdicts, always** — verdict counts do not predict the failure this audit exists to prevent (thirty KEEP trees and thirty KEEP trees at 60 MiB each are the same rollup and different amounts of remaining disk, and on exhaustion the shell commands needed to diagnose it fail too). Roll `size.total_kb`, `size.volume_free_kb`, and `size.headroom_trees` (free ÷ median LINKED tree — a derived measurement, not a tuned constant) into the report. A tree whose size could not be determined reads `unknown`, NEVER `0`; a `≥` prefix marks a total that is a lower bound because some tree was only partially walked — do not restate either as an exact figure (`rules/instrument-discipline.md` MUST-1). The size pass costs ~2s per 30 trees (measured: 5.6s with, 3.2s without); `--no-size` opts out when that matters, at the price of the axis that predicts exhaustion. Embed the `<!-- worktree-reap:v1:… -->` sentinel so a reader can verify the audit ran AND whether it was report-only (`applied=false`) — a run that changed nothing is the DEFAULT output, not a completion receipt. **Check `scope=` before reading the sentinel as a forest audit**: `scope=all` is a whole-forest pass, `scope=selected` (with `selected=<n>`) is a PATH-SCOPED `--only` run that classified the forest but was eligible to reap only `<n>` trees — it does NOT discharge this sweep, and accepting one as if it did would turn a real gate into a false one. The sentinel now also carries `size_kb` / `size_unknown` / `free_kb` / `headroom_trees`, so a reader can confirm size was measured rather than skipped. `--force` is BLOCKED: a bare `git worktree remove` refusing a dirty tree is the desired behavior. The `--aggregate` step (issue #669) reads EVERY `workspaces/*/.session-notes` (and its M6-D split `.session-notes.shared.md`) forest ledger — regardless of MTIME or issue state — and flags any OPEN row whose ID is absent from the ROOT ledger (the cross-file no-vanish gate; closes the gap where this sweep `stat`-ed MTIME but never opened the file). Each `[AGG]` finding is a STRANDED forest workstream: roll it into the report with its value-anchor (`rules/value-prioritization.md` MUST-2) AND into the root ledger at `/wrapup`. The bare `find` MTIME check is retained for archival hygiene; it does NOT substitute for the ledger read.

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
node --input-type=module -e 'const P="./.claude/bin/lib/loom-links.mjs";import("node:fs").then(async fs=>{if(!fs.existsSync(P))return console.log("<!-- sweep-ecosystem:v1:N/A reason=resolver-module-absent -->");const m=await import(P);const r=m.resolveRole();if(!m.isConfigured()||r==="build"||r==="use-consumer")return console.log("<!-- sweep-ecosystem:v1:N/A reason=not-orchestration-root -->");for(const[k,v]of m.resolveAll())if(/^(build|use-template)\./.test(k))console.log(v.kind==="path"?k:k+" ["+v.kind+(v.error?": "+v.error:"")+"]")}).catch(e=>console.log("<!-- sweep-ecosystem:v1:ERROR reason="+((e&&(e.subtype||e.code))||(e&&e.message)||String(e))+" -->"))'
```

Only the N/A sentinel → **read the `reason=`; there are three producers and they do NOT all mean "downstream consumer".** `not-orchestration-root` (no config, or a declared build/use-consumer role) — and `resolver-module-absent` **on a consumer**, where `bin/lib/loom-links.mjs` is `loom_only` and purged by design — are both a **structural** N/A (no proxy run — `rules/sweep-completeness.md`), grep-able, keeping the distributed command byte-identical. But `resolver-module-absent` **at an orchestration root is a FINDING, never an exemption**: the resolver MUST be present here, so its absence means a broken checkout — or that the gate was run outside the repo root, since `P` is cwd-relative. Sweep 9 is the ONLY cross-repo sweep, so reading that N/A as "not applicable" silently voids the entire Directive-2 roll-up. Surface it and fix the checkout. Otherwise each printed line is a `build.*`/`use-template.*` KEY tagged by `resolveAll()` kind: a **bare key** is a local checkout — resolve its path at RUNTIME via `resolveRepo(key)` (returned, never logged into the report) and run the full roll-up; a `<key> [url]` is a remote-only target (no local checkout) — sweep its open PRs via the remote, skip local-divergence; a `<key> [error: …]` (or the ERROR sentinel) is itself a finding — surface it, never positional-guess a fallback (`rules/cross-repo.md` MUST-1). Roll up (local-checkout keys):

- **Open PRs** — `(cd "<path>" && gh pr list --state open)` (drafts >7d, red CI; #30-style `--no-merge` distribution PRs awaiting a gate surface here).
- **COC drift** — `node .claude/bin/check-sync-freshness.mjs --target "<key>"` (the printed key IS the target slug; flags a consumer behind loom's last `/sync-to-use`). **Read the printed LINES, not the exit code** — a consumer that is merely behind is verdict `ADVISORY` at exit 0 (it cannot affect a distribution, which is cut from the target's remote main), while `ahead`/`diverged`/unestablished-ancestry is `FAIL` at exit 1. Both carry `pass:false` and BOTH are drift findings for this report; only the second is a halt anywhere else.
- **Local divergence** — `git -C "<path>" status --porcelain` + `git -C "<path>" rev-list --left-right --count origin/main...HEAD`.

Roll every finding into the report BY KEY + pointer, each carrying a value-anchor at `/wrapup` (`rules/value-prioritization.md` MUST-2). Emit `<!-- sweep-ecosystem:v1:targets=N prs=P drift=D -->`.

### Sweep 10: Deferred-quality product-visibility revisit (the anti-forgetting teeth)

The `deferred-quality` backlog is net-negative WITHOUT this revisit (`rules/value-prioritization.md` Origin: 7-of-7 deferred items decayed). Full procedure: `.claude/skills/sweep/` § 2. In brief:

```bash
gh issue list --label deferred-quality --state open \
  --json number,title,body,labels,createdAt --limit 100
```

Group by revisit trigger (`after-milestone:<name>` | `on-demand`). Surface a `value-prioritization.md` MUST-3 "still wanted?" gate for any item deferred ≥2 sweeps/sessions ago. At a product-visibility milestone (terminal wave converges / release tag), re-surface EVERY item whose `after-milestone:<name>` matches, re-value-rank, re-validate the value-anchor, and present the user-gated disposition per item — **implement / re-defer-with-fresh-anchor / close-with-gate** (`value-prioritization.md` MUST-4: no auto-close as `not_planned`, no OR-escape). The agent recommends; the human decides.

## Output

Write the report to `workspaces/<project>/04-validate/sweep-<date>.md` (workspace context active) OR `SWEEP-<date>.md` at root. `/sweep` is a **management decision report FOR DECISION-MAKING AT THIS JUNCTURE** — full contract at `.claude/skills/sweep/` § 1. It MUST carry, in order: **(1) Completion status** (which milestones are complete AND _visible_, each citing a durable receipt per `rules/verify-resource-existence.md` MUST-4); **(2) ETA to completion** (remaining BUG + INVEST-NOW work in autonomous cycles, never human-days — `rules/autonomous-execution.md`); **(3) Prioritized immediate queue** (open BUGs + INVEST-NOW, value-ranked per `rules/value-prioritization.md` MUST-1, each with implication); **(4) Deferred-quality backlog** (INCREMENTAL items grouped by revisit trigger, each with value-anchor + the four generalized-1b conditions); **(5) Decision points** (the INVEST-NOW-vs-defer judgment calls, each with implications + symmetric pros/cons + a recommended disposition per `rules/recommendation-quality.md` MUST-1/2/3 — never silently self-decided); **(6) Recommendation** (recommended next steps for ratification, never a bare menu). Per-finding rows carry `[CATEGORY][SEVERITY][Sweep N] <title>` + Location + Disposition + Evidence. **Scrub before committing (Sweep 9/10):** the report is committed (Closure step 4), so record by logical KEY + PR#/issue# — NEVER an operator-absolute path (`/Users/<operator>/…`) or a private-org `--repo` slug — per `rules/user-flow-validation.md` MUST-6.

## Closure

Before reporting `/sweep` complete:

1. ALL Sweep 1-10 outputs accumulated (Sweep 9 = the cross-ecosystem roll-up at the orchestration root, or its N/A sentinel elsewhere; Sweep 10 = the deferred-quality product-visibility revisit)
2. **Unadjudicated-verdict escalation (`rules/sweep-completeness.md` MUST-4).** Run `node .claude/bin/unadjudicated-escalation.mjs` (exit 0 = nothing owed, 1 = ESCALATION OWED) and embed its sentinel. It measures, from the COMMITTED reports, how many consecutive runs carried each unadjudicated verdict — there is no stored counter to reset. **Exit 1 is not a failure to route around:** every escalated key MUST appear in § Decision Points (report section 5) with a recommended disposition — author the missing check, OR record `<!-- unadjudicated-disposition:v1 key="Sweep 5/manual-supplement-required" issue=<N> owner=<handle> until=YYYY-MM-DD -->` in this report. All four fields required; a disposition SUPPRESSES until `until` passes and never resets the count, so expiry re-escalates. A 4th identical emission with neither an escalation nor a live disposition is BLOCKED. Capture the exit code (`cmd | tail` reports TAIL's). Depth: `.claude/skills/sweep/` § 6d.
3. Trivial fixes applied inline (`rules/zero-tolerance.md` Rule 1); reclassified `FIXED` with commit SHA — **the SHA goes in the row's Disposition column, not only in git log.** A bare `FIXED inline` row is incomplete and MUST be revised before the report ships:

   ```
   DO      [LOW → FIXED] [Sweep 1] <title> — Disposition: FIXED inline (commit `8e67ad3`) — <one-line reason>
   DO NOT  [LOW → FIXED] [Sweep 1] <title> — Disposition: FIXED inline
   ```

   **Why:** the SHA is the grep-able link from finding to fix; without it `/redteam` cannot verify closure parity in a later round, which is the audit trail the reclassification exists to create.
4. Non-trivial fixes filed as workspace todos OR GH issues with delivered-code references
5. Report committed (`git add` + `git commit`)
6. Optional: human authorization for the recommended next-session scope

The report is the deliverable. The agent does NOT decide what to do next — that's a human call.
