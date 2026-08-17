---
id: "SWEEP"
name: sweep
description: "/sweep management decision report contract + deferred-quality product-visibility revisit (Sweep-N). Depth for commands/sweep.md; classifier owned by product-completion-first.md."
---

# /sweep — Management Decision Report + Deferred-Quality Revisit (depth)

`commands/sweep.md` runs the outstanding-work sweeps; THIS skill carries the load-bearing
depth surfaces the command references: (1) the **management decision report** the sweeps
aggregate into, (2) the **Sweep-N product-visibility revisit** teeth for the deferred-quality
backlog, (3) § 5 **Sweep 4 branch-enumeration discipline**, and (4) § 6 **Sweep 5's three
pre-condition modes** (BUILD / repo-level-specs / orchestration-mode N/A) with the full gate
implementation + finding taxonomy. The finding CLASSIFIER (BUG / INVEST-NOW / INCREMENTAL, severity
decoupled, fail-closed) is OWNED by `rules/product-completion-first.md` — referenced here per
`rules/specs-authority.md` Rule 9, never restated.

## 1. The management decision report contract (the `/sweep` deliverable)

`/sweep` is the **decision gate**: a professional, high-quality management report FOR
DECISION-MAKING AT THAT JUNCTURE — invoked on demand, as the end-of-cycle gate before
`/wrapup`, and at product-visibility milestones (terminal wave converges / release tag). It
MUST produce, in this order:

1. **Completion status** — which product milestones are complete AND _visible_ (walking-skeleton
   stands vs not); what fraction of the committed scope is done. Cite the durable receipt
   (merged PR / journal DECISION / spec success-criterion) for each "complete" claim
   (`rules/verify-resource-existence.md` MUST-4 — no self-attested completion).
2. **ETA to completion** — remaining BUG + INVEST-NOW work to a complete/visible product, in
   **autonomous cycles** (sessions), NEVER human-days (`rules/autonomous-execution.md`). State
   the basis (which open items, at what per-item cycle estimate).
3. **Prioritized immediate queue** — the open BUGs + INVEST-NOW issues, value-ranked
   (`rules/value-prioritization.md` MUST-1, each anchored to a user-anchored source), each with
   its implication.
4. **Deferred-quality backlog** — the INCREMENTAL items, grouped by revisit trigger
   (`after-milestone:<name>` | `on-demand`), each with its value-anchor + why-deferred + the
   four generalized-1b conditions (blocking-safety note / value-anchor / acceptance criteria /
   revisit trigger).
5. **Decision points** — the INVEST-NOW-vs-defer JUDGMENT calls, each surfaced with
   prioritization + implications + **symmetric pros/cons** + a recommended disposition
   (`rules/recommendation-quality.md` MUST-1/2/3), for co-owner direction. The agent NEVER
   silently self-decides a judgment-bucket item (`rules/product-completion-first.md` MUST-4).
6. **Recommendation** — the agent's recommended next steps, for ratification (never a bare menu;
   `rules/recommendation-quality.md` MUST-1).

**Scrub before committing** (the report is committed at Closure): no operator-absolute path,
no private-org `--repo` slug — `rules/user-flow-validation.md` MUST-6.

## 2. Sweep-N — deferred-quality product-visibility revisit (the teeth)

The deferred-quality label is net-negative WITHOUT this revisit gate (`value-prioritization.md`
Origin: 7-of-7 deferred items decayed rather than picked up). Sweep-N MUST run:

- **At every `/sweep` invocation** — enumerate the deferred-quality backlog
  (`gh issue list --label deferred-quality --json number,title,body,labels,createdAt`); any item
  deferred ≥2 `/sweep` cycles OR ≥2 sessions ago surfaces a "still wanted?" gate
  (`value-prioritization.md` MUST-3).
- **At each product-visibility milestone** (terminal wave converges, release tag) — re-surface
  EVERY deferred-quality item whose revisit trigger matches (`after-milestone:<name>` fires when
  `<name>` lands), re-value-rank, re-validate the value-anchor (`value-prioritization.md` MUST-3
  "still wanted?"), and present the user-gated disposition per item: **implement** /
  **re-defer-with-fresh-anchor** / **close-with-gate** (`value-prioritization.md` MUST-4 — no
  auto-close as `not_planned`, no OR-escape-hatch).

Each revisit disposition is user-gated: the agent recommends, the human decides. A deferred-quality
item MUST NOT be closed as `not_planned`/`wontfix` without the user gate in the same session
(`value-prioritization.md` MUST-4).

## 3. The deferred-quality tracking surface

- **GH label `deferred-quality`** — distinct from the overloaded `deferred` label. Applied to an
  issue whose body carries the four generalized-1b conditions (below). Rides
  `value-prioritization.md`'s EXISTING anti-forgetting hooks (`detectDeferralWithoutValueAnchor`,
  `detectDeferredItemPickupWithoutRevalidation`, `detectGhIssueCloseAsNotPlanned`) — zero new
  enforcement code.
- **Issue template** (`.github/ISSUE_TEMPLATE/deferred-quality.md`) — its required body sections
  ARE the four generalized `zero-tolerance.md` Rule-1b conditions:
  1. **Blocking-safety note** — which shipped/success path this does NOT touch (proves it is
     genuinely off-path INCREMENTAL, not a mis-labelled BUG).
  2. **Value-anchor** — one sentence citing a user-anchored source (`value-prioritization.md`
     MUST-2 closed allowlist: user brief / `briefs/` / journal DECISION / literal user quote /
     user-authored spec § success-criterion).
  3. **Full-fix acceptance criteria** — the testable definition of done.
  4. **Revisit trigger** — `after-milestone:<name>` OR `on-demand`.

An item missing any section is NOT a valid deferred-quality defer — it is silent deferral
(`rules/product-completion-first.md` MUST-2, BLOCKED).

## 4. Convenience enumerator (deferred — dogfood)

`deferred-quality-backlog.mjs` (a read-only `gh issue list --label deferred-quality --json`
enumerator grouped by revisit trigger, cloning `codify-backlog.mjs`'s exit-0 shape) is itself an
INCREMENTAL improvement by this rule's own definition — it is tracked as a `deferred-quality`
item, not shipped in the landing cycle. Until it lands, Sweep-N runs the `gh issue list`
invocation directly.

## 5. Sweep 4 — branch enumeration discipline (`--no-merged` is a RANKER)

`git branch -r --no-merged origin/main` MUST NOT be the sole enumeration source. The filter
excludes any ref whose tip is tip-equal to `origin/main` — which is exactly what an ABANDONED
mid-flight branch looks like once main catches up to it. Enumerate unfiltered
(`git branch --format='%(refname:short)'` / `git for-each-ref … refs/remotes/origin`) and use
`--no-merged` only to RANK what the unfiltered pass found; a branch present in the unfiltered
list and absent from the filtered one is a **candidate, not a non-finding**.

**Read the hits, not the tally** (`rules/instrument-discipline.md` MUST-3(b)): a filtered count
that shrank tells you nothing about WHICH refs left the list, so the tally cannot discriminate
"merged and reapable" from "abandoned and tip-equal". Harness-default `worktree-agent-*` orphans
are the class this filter historically hid. Surface them in the Sweep-4 report as REFS and do
NOT re-adjudicate the trees — their FOREST disposition is Sweep 6's reap audit
(`rules/worktree-isolation.md` Rule 8).

## 6. Sweep 5 — the three pre-condition modes, the gate, and the finding taxonomy

### 6a. Repo-level-specs mode (absent per-workspace specs ≠ absent spec AUTHORITY)

A repo whose specs live at the ROOT (`docs/specs/`, `specs/`) rather than per-workspace returns
`spec_count=0` and would otherwise be classified orchestration-mode — so Sweep 5 would report
N/A on a repo that has real, substantive spec authority to check. That is the cheaper-proxy
substitution `rules/sweep-completeness.md` Rule 1 blocks, wearing a structural-N/A costume, and
it is WORSE than a skipped step because the sentinel makes it look adjudicated.

When `spec_count=0` AND a repo-level spec tree exists, the repo is in **repo-level-specs mode**:
Sweep 5 MUST NOT emit the orchestration-mode sentinel, and MUST instead either (a) run the
equivalent spec-vs-source compliance check against the repo-level tree at the level that repo
uses, OR (b) emit an explicit `manual-supplement-required` finding recording that the
per-workspace assumption does not hold for this repo shape. Reporting Sweep 5 "clean" or "N/A"
on this shape without doing one of the two is BLOCKED.

**Option (a) is TOOLED at loom (loom#1722): `node .claude/bin/spec-corpus-conformance.mjs`.**
At a repo whose specs govern an ARTIFACT CORPUS rather than application source, the equivalent
check is per-spec CLAIM verification against `.claude/rules/**`, `agents/**`, `skills/**`,
`commands/**`, `bin/**`, `hooks/**` and `sync-manifest.yaml` — reported in § 6c's four
categories (ORPHAN = cited artifact absent; DRIFT = artifact present, cited `::symbol` / `#key`
/ `§ Heading` absent; COVERAGE GAP = artifact class no spec governs; STUB = section asserting
nothing checkable). It emits the § 6a option-(a) sentinel with its counts inline, and WITHHOLDS
the sentinel when its own anti-vacuity self-controls did not fire. Where that tool is present,
running it IS option (a) and `manual-supplement-required` no longer applies to the mechanical
half. **Its bound, which the report must carry:** it reports that a spec claim is CONTRADICTED
by an artifact and cannot adjudicate which side is wrong, and it checks CITATION-shaped claims
only — free-prose semantic claims stay outside it, so a clean run is not evidence they hold.

### 6b. The full pre-condition gate (reference implementation)

```bash
# Pre-condition gate
spec_count=$(find workspaces/*/specs -type d -mindepth 1 2>/dev/null | wc -l | tr -d ' ')
tool_present=$([ -f tools/sweep-redteam.py ] && echo true || echo false)
# Repo-level spec authority: absent per-workspace specs != absent specs.
repo_specs=$(for d in docs/specs specs; do [ -d "$d" ] && echo "$d"; done | head -1)
if [ "$spec_count" = "0" ] && [ -n "$repo_specs" ]; then
  # (a) TOOLED where the artifact-corpus checker exists (loom#1722). It emits the
  #     REPO-LEVEL sentinel itself, with its counts inline, and WITHHOLDS it when
  #     its own anti-vacuity controls did not fire — so a green here cannot come
  #     from an instrument that failed to parse the corpus.
  if [ -f .claude/bin/spec-corpus-conformance.mjs ]; then
    node .claude/bin/spec-corpus-conformance.mjs   # exit 1 = findings to disposition
    exit 0  # Sweep 5 complete via the repo-level branch, option (a)
  fi
  # (b) Otherwise the honest exit, unchanged:
  echo "<!-- sweep-redteam:v1:REPO-LEVEL specs_root=$repo_specs -->"
  echo "FINDING [Sweep 5] manual-supplement-required — spec authority is at $repo_specs;"
  echo "  the per-workspace assumption does not hold. Sweep 5 cannot ship 'clean' unadjudicated."
  exit 0  # Sweep 5 complete via the repo-level branch — NOT via orchestration-mode N/A
fi
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

### 6c. Finding taxonomy (Sweep 5 categorization)

- **Orphan** — spec promises symbol; source has none (`rules/orphan-detection.md` § 1)
- **Drift** — spec says X; source does Y (`rules/specs-authority.md` § 6)
- **Coverage gap** — symbol exists; no Tier 2 wiring test (`rules/facade-manager-detection.md` § 2)
- **Stub** — `NotImplementedError` / `TODO` / `pass` in production paths (`rules/zero-tolerance.md` Rule 2)

### 6d. `manual-supplement-required` is adjudicated ONCE, not indefinitely

Option (b) above is the honest output the FIRST time. It is not a standing exemption. Per `rules/sweep-completeness.md` MUST-4, the same unadjudicated verdict on **3 consecutive runs** MUST NOT be emitted a 4th time: the 3rd occurrence becomes a Decision Point in the management report (§ 1 item 5) — author the equivalent check, OR record a dated disposition sentinel.

This is the sibling of MUST-1. MUST-1 blocks a CHEAP PROXY standing in for a mandated step; MUST-4 blocks a NON-ANSWER standing in for one, run after run. The second is harder to see precisely because every individual emission is honest — it claims nothing it cannot support, so no reviewer objects, and it quietly occupies a report slot forever. loom#1722 reached five consecutive emissions; the fifth report itself observed that "three sweeps recording the same unadjudicated finding is itself the signal" and nothing consumed the observation.

```bash
node .claude/bin/unadjudicated-escalation.mjs   # Closure step 2; exit 1 = ESCALATION OWED
```

The count is a MEASUREMENT over the committed reports — there is no stored counter, so there is nothing a session can reset. A disposition SUPPRESSES until `until` passes and never resets the streak, so expiry re-escalates on its own:

```
<!-- unadjudicated-disposition:v1 key="manual-supplement-required" issue=<N> owner=<handle> until=YYYY-MM-DD -->
```

All four fields are required; an incomplete sentinel is MALFORMED and is not honoured. `key` is the VERDICT token alone — step attribution (`Sweep 5`) is reported but never keyed, so re-labelling the section a verdict sits under cannot reset its streak; a legacy `<step>/<verdict>` key still resolves. Depth (N=3 derivation, why the state lives in the reports, the verdict-key fix, the detector's lexical bounds): `guides/rule-extracts/sweep-completeness.md` § MUST Rule 4.
