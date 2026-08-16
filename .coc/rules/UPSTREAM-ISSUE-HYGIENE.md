---
id: "UPSTREAM-ISSUE-HYGIENE"
paths: ["**/.github/**", "**/CONTRIBUTING.md", "**/SECURITY.md", "**/.session-notes", "**/journal/**", "**/workspaces/**"]
---

# Upstream Issue Hygiene

See `.claude/guides/rule-extracts/upstream-issue-hygiene.md` for worked bodies, the MUST-1/2/3 BLOCKED corpora, the MUST-4 fence analysis, the uncovered residuals, and the full Origin.

When a downstream consumer of `kailash` / `kailash_*` finds a defect in the SDK, filing an issue upstream MUST be human-gated, and the body MUST carry ONLY the SDK's public-API surface: never the consumer project's name, internal paths, workspace identifiers, finding tags, or session context.

The defect goes upstream. The story of HOW you found it stays at home.

## Scope

ALL sessions in a USE-template-derived consumer repo, and ANY `gh issue create` / `gh pr create` / `gh issue edit` or equivalent filing command targeting an SDK repo (`kailash-py`, the Rust SDK, `kailash-prism`, or any sibling shipped via PyPI / crates.io / gems).

It ALSO governs the **proposal-intake lane** (a COC-artifact issue or `/codify` proposal body reaching loom Gate-1 MUST scrub per Rule 2 BEFORE filing — it is split to 30+ consumers) and the **downstream-upflow inbox-PR surface** (a `coc-project` Step-7c offer: MUST-1's gate AND MUST-2's redaction apply to the inbox YAML's free-text AND every referenced artifact file, before the PR opens). Extract § Scope.

## MUST Rules

### 1. Human Gate Before Filing

The agent MUST NOT execute `gh issue create`, `gh pr create` referencing an upstream SDK issue, or any equivalent issue-filing command against an SDK repo without explicit user approval IN THE SAME SESSION. Drafting the body is permitted; submission is not.

```bash
# DO   — echo "$draft"; read -r ok; [ "$ok" = y ] && gh issue create --repo <owner>/<sdk> --body "$draft"
# DO NOT — gh issue create --repo <owner>/<sdk> --body "$draft"   # submitted; the user never saw it
```

**Why:** Public SDK issues are world-readable forever and "edit it later" is wrong (GitHub keeps body history), so the gate is the only pre-publication catch. BLOCKED corpus: extract § MUST-1.

### 2. Downstream Context Redaction

The issue body MUST NOT contain any of:

- The downstream project's name (consumer app, customer, or engagement names)
- Internal paths outside the SDK's import surface (`src/<consumer-app>/...`, `app/...`, `bindings/<consumer>/...`)
- Workspace identifiers (`workspaces/<name>/...`, `.session-notes`, `.proposals/...`, journal paths)
- Finding tags (`F-G1-HIGH`, `S-H3`, `BP-049`, internal redteam round IDs)
- Session timestamps tied to consumer work (`<date> <consumer-app> session`, `S07-reviewer-...`)
- "Origin: <consumer-app>" footers, "<consumer-app> workaround" sections, "Discovered during <consumer-name> red team" lines
- References to private SDK repos when filing on the public SDK repo

DO: SDK API surface only. DO NOT: `## Origin: F-G1-HIGH S-H3 finding (<consumer-app> repo) … live_oauth.py:192-237`.

**Why:** Each leaked identifier is a permanent, search-indexed breadcrumb to a project and its methodology. Worked bodies + the 7-phrase BLOCKED corpus: extract § MUST-2.

### 3. Minimal Repro Shape

The issue body MUST consist of ONLY:

1. **Affected SDK API surface** — one import path (`kailash.DataFlow.execute_raw`); no consumer wrappers or facade names.
2. **Minimal repro** — ONLY `kailash` / `kailash_*` imports + standard test scaffolding; no consumer modules, config, or consumer-named fixtures.
3. **Expected vs actual** — what the SDK contract promises (cite spec § or docstring) vs what it delivers.
4. **Severity** — `LOW` / `MEDIUM` / `HIGH` / `CRITICAL` on SDK-API-surface impact, NOT consumer-business impact.
5. **Acceptance criteria** — bulleted, testable, SDK-scoped: `[ ] <observable behavior on the SDK surface>`.

Nothing else — no "## Workaround", "## Workspace", "## <consumer-app> wired around it like this", "## Cross-references" to consumer journals, "## Cross-SDK alignment" (the DO-NOT shape).

**Why:** Every extra section is a leakage surface — workarounds belong in the consumer's own docs, cross-SDK alignment is the maintainer's own filing, and production traces carry consumer-side names. Worked body + the 5-phrase BLOCKED corpus: extract § MUST-3.

### 4. Open, Never Complete — A Downstream Upflow OPENS A PR And STOPS

A downstream consumer's `/codify` Step-7c upflow MUST **open** its inbox PR against the upstream (template / BUILD) repo and **STOP THERE**. Merging, completing, auto-merging, admin-merging, enabling auto-merge, or pushing directly to ANY branch of an upstream repo is BLOCKED — with **no exception, and no human-gate that unlocks it**. MUST-1's gate authorizes **submission** (`gh pr create` / `gh issue create`); it NEVER authorizes **completion** (`gh pr merge` / ADO complete / `completeUpflowPR`). The two are different acts with different owners: the consumer proposes, the **upstream maintainer disposes** — after `/sync-from-downstream` has scrubbed the offer, reviewed it as untrusted data, deduped it, and relayed it. A consumer that merges its own offer has executed the upstream's review gate on the upstream's behalf, and the upstream's `ingest_disposition` receipt then attests to a review that never happened.

Symmetrically, an upstream maintainer MAY complete a PR **only on its own repo**. That is the general invariant both halves reduce to: **you may only complete a PR on the repo you ARE** — and "the repo you are" is DERIVED from the environment (the live git remote, with `.claude/VERSION::repo` as a refuse-only cross-check), never asserted by the caller.

The `completeUpflowPR` identity fence is a BACKSTOP, not the enforcement: it reaches neither `gh pr merge` at the CLI, a merge from an upstream clone, `curl`, `--auto`, a direct `git push`, nor a caller choosing its own cwd. **MUST-4 binds the AGENT on all of them.** Extract § MUST-4.

```bash
# DO — downstream opens, and stops. The PR URL IS the handoff.
git push -u origin upflow/2026-08-03-<slug>
gh pr create --repo <upstream-owner>/<upstream-repo> --title "proposal(inbox): …" --body "$scrubbed"
echo "Offer open at <url>. The upstream merges it after /sync-from-downstream review."

# DO NOT — open then complete (the consumer just executed the upstream's gate)
gh pr create --repo <upstream>/… && gh pr merge --repo <upstream>/… --admin --merge
gh pr merge <N> --repo <upstream>/… --auto --squash   # auto-merge is completion, deferred
git push <upstream-remote> HEAD:main                   # direct push — same act, no PR at all
```

**BLOCKED rationalizations:**

- "I opened it, so I own it" / "it's my own PR, merging it is just housekeeping"
- "The human already approved the filing" (MUST-1 gates SUBMISSION, never COMPLETION)
- "The upstream is unattended / the maintainer is slow / it would sit for weeks"
- "CI is green and the scrub passed, so the review is a formality"
- "I have admin on the upstream, so I am _a_ maintainer"
- "`--auto` isn't merging, it's just queuing" (it completes without a maintainer act)
- "The template told me to cascade, and an unmerged PR hasn't cascaded"
- "I'll merge it and the upstream can revert if they disagree"
- "`completeUpflowPR` is exported, so it must be part of the upflow lane"

**Why:** The upstream's ingest is the ONLY place the offer is scrubbed against the upstream's denylist, reviewed as untrusted data, deduped against work already relayed, and lane-checked — and a self-merged offer skips **all four** while still producing an `ingest_disposition` receipt that reads as though they ran. That is worse than an unmerged PR: it is an unreviewed change wearing a reviewed change's provenance, cascading from the upstream to every sibling consumer that pulls.

## MUST NOT

- File any upstream SDK issue, PR, or PR-comment carrying a downstream project name, internal path, workspace ID, or finding tag — **Why:** public-record redaction is partial; edit history keeps the original.
- Treat "the user said yes once" as standing approval for future filings — **Why:** it erodes the per-issue gate that catches body-level leakage; every body is unique.
- Auto-cross-file: filing on one SDK repo, then auto-filing the sibling with no separate gate — **Why:** it replicates the first body's leakage; cross-SDK parity is a maintainer concern.
- File a `/codify` proposal or COC-artifact intake issue carrying a client / operator / 3rd-party identifier into loom Gate-1 — **Why:** it is split to 30+ consumers, so a leaked identifier is permanently correlatable.
- Merge, complete, admin-merge, auto-merge, or directly push to any branch of an UPSTREAM repo from a downstream upflow lane — **Why:** completion is the maintainer's act on their own repo; a self-merged offer bypasses the scrub, the untrusted-data review, the dedup and the lane check while producing a receipt attesting all four ran.
- Read MUST-1's human gate as authorization to COMPLETE a PR, rather than to SUBMIT one — **Why:** submission and completion are different acts with different owners; conflating them converts a per-filing approval into a standing merge right the user never granted.

## Trust Posture Wiring — MUST-4 (Open, Never Complete)

Applies to the **MUST-4** clause (2026-08-03); canonical-8-field-compliant per `trust-posture.md` MUST-8. MUST-1/2/3 stay grandfathered until each is itself `/codify`-touched.

- **Severity:** `halt-and-report` at gate-review — reviewer at `/implement` + cc-architect at `/codify` confirm the upflow opened its PR and stopped, and that any completion was on the repo the caller IS. **NO hook-layer severity: the adapter is NOT a hook** — it is a library function at no hook event, so that vocabulary does not apply; it is a **structural refusal at the library boundary**, failing CLOSED.
- **Grace period:** 7 days from clause landing (2026-08-03 → 2026-08-10).
- **Cumulative posture impact:** **N/A — emergency-only trigger**, stated per `trust-posture.md` MUST-8 and NOT inherited: the act is a cross-repo write outside scope, routed to `critical` → **L1 on the FIRST instance**, so a 3×/5× window is unreachable; counted ONCE. It leaves the second MUST-NOT bullet (a REASONING violation, no write) with NO posture path: gate-review-only. Extract § Cumulative-posture caveat.
- **Regression-within-grace:** the pre-existing `critical` trigger in `trust-posture.md` MUST-4 (**cross-repo write outside scope → L1**), NOT the generic `regression_within_grace`, and **grace-INDEPENDENT** — it carries no grace qualifier, so the act is critical before, during and after the window. No NEW key minted: named deviation per Rule 8.
- **Receipt requirement:** SessionStart soft-gate `[ack: upstream-issue-hygiene]` IFF `posture.json::pending_verification` includes this rule_id (one ack covers MUST-1..4).
- **Detection mechanism:** TWO tiers, neither over-claimed. **Structural (library-boundary refusal, NOT a hook):** the `completeUpflowPR` fence in the `vcs-github-adapter` + `vcs-azure-adapter` modules (module NAMES, never `hooks/lib/` PATHS — extract § Adapters: MODULE NAME) derives self-identity via `upflow-self-repo` and refuses, before the transport fires, on an underivable / contradicting / unrecognized-host / non-self identity; its fixtures are CI-run via `ci-audit-fixtures.json` (merge-blocking: mutable settings, re-measure). **Semantic (Phase 1, gate-review):** reviewer / cc-architect inspect any session that ran a Step-7c upflow. Probes `.claude/test-harness/probes/upstream-issue-hygiene.probes.json`; candidates + answer keys `.claude/audit-fixtures/upstream-issue-hygiene/`. **NO Phase-2 detector is committed, scheduled or promised, and this block declares no deferral** — an undated promise is permanent-by-default, which `deferral-registry-locality.md` BLOCKS; whoever builds one registers a dated entry in `.claude/test-harness/phase2-deferrals.json`, fixtures in the same change. Residuals + candidate surfaces: extract § Detection mechanism.
- **Violation scope:** MUST-4 ONLY (clause-scoped) + its two MUST-NOT bullets; MUST-1/2/3 stay grandfathered.
- **Origin:** See § Origin; narrative + the three Tier-1 redteam corrections at extract § Origin.

Origin: a 2026-04-29 public SDK issue leaked `F-G1-HIGH S-H3 finding (<consumer-app> repo): non-atomic store_tokens in live_oauth.py:192-237`; sibling leaks were confirmed across ~13 issues on two public SDK repos. Drafted after that leakage audit.

**MUST-4:** 2026-08-03, co-owner-directed origination at the `kailash-coc-rs` USE template, after a downstream `/codify` cascade merged its upflow PR into its upstream template's `main`. Root cause was an ABSENCE: no clause prohibited it, and `completeUpflowPR` sat exported and caller-less in both adapters. The struck claims + the open reachability gap: extract § Origin.

Depth extraction (2026-08-16, `rule-authoring.md` Rule 10 path (a)): extract § Extraction record.
