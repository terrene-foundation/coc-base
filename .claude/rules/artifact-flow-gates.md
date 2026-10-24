---
priority: 10
scope: path-scoped
paths:
  - "**/.claude/.proposals/**"
  - "**/.claude/commands/codify.md"
  - "**/.claude/commands/sync*.md"
  - "**/.claude/agents/management/sync-reviewer.md"
  - "**/.claude/agents/management/coc-sync.md"
  - "**/.claude/bin/sync-gate2-worktree.mjs"
  - "**/.claude/bin/scan-synced-disclosure.mjs"
  - "**/.claude/bin/sync-from-canon*.mjs"
---

# Artifact Flow — Proposals And Gate-1 / Gate-2 Operations

<!-- slot:neutral-body -->

Pointer — **companion**, as cited below, is `.claude/guides/rule-extracts/artifact-flow.md`.

## BUILD Repo Rules

- `/codify` writes to BUILD repo's `.claude/` for immediate local use + creates `.claude/.proposals/latest.yaml`
- BUILD repo does NOT sync to any other repo directly
- USE-TEMPLATE repos (`kailash-coc-*`) MAY originate proposals for COC-artifact improvements only (manifest contract: `guides/co-setup/09-proposal-protocol.md` Step 7b); their downstream USE/project repos remain pull-only

## Proposal Lifecycle

Proposals track artifact changes through a three-state lifecycle; every originating direction (§ Applies to All Originating Directions) follows it independently. State-transition diagram: companion § Proposal Lifecycle — State Diagram.

- `pending_review` — new changes, not yet classified at loom/. `/codify`: **append** new changes. sync-family: Gate 1 reviews and classifies.
- `reviewed` — classified but not yet distributed. `/codify`: **append** (resets to pending). sync-family: Gate 2 distributes to templates.
- `distributed` — fully processed (classified AND distributed). `/codify`: **archive** and create fresh. sync-family: skip.

### MUST: Append, Never Overwrite Unprocessed Proposals

When `/codify` creates new artifact changes and a proposal already exists with `status: pending_review` or `status: reviewed`, `/codify` MUST append new entries to the existing `changes:` array, not replace the file.

**Why:** Overwriting a `pending_review` proposal destroys unreviewed changes from earlier `/codify` sessions. This is silent data loss — the earlier session's knowledge extraction is permanently gone with no trace.

**BLOCKED:**

- "Creating fresh proposal" when status is `pending_review`
- "Replacing existing proposal" when status is `reviewed`
- ANY write to `latest.yaml` that does not preserve prior `changes:` entries

### MUST: Reset Status on Append

When appending to a `reviewed` proposal, `/codify` MUST reset the status to `pending_review`. The new entries have not been classified.

**Why:** Without the reset, `/sync-from-build` / `/sync-from-use` Gate 1 sees `reviewed` and may skip classification of the newly appended changes.

### MUST: Archive Before Fresh

When creating a fresh proposal (status was `distributed` or file was missing), `/codify` MUST archive the old file to `.claude/.proposals/archive/{codify_date}-{source_repo}.yaml` before writing the new one.

**Why:** Archived proposals are the audit trail of what knowledge was extracted and when. Without the archive, there is no history of prior codification cycles.

### Applies to All Originating Directions

Four directions: **BUILD → loom** (Step 7) · **USE-template → loom** (Step 7b, the authoritative COC-artifact flow) · **downstream → USE-template → loom** (Step 7c push-only inbox proposal) · **loom → atelier** (Step 8). Per-direction detail: companion § Applies to All Originating Directions — Per-Direction Detail.

## Human Classifies Every Change

Inbound changes from BUILD repos classified by human as:

- **Global** → `.claude/{type}/{file}` (all targets)
- **Variant** → `.claude/variants/{lang}/{type}/{file}` (one target)
- **Skip** → not upstreamed

Automated suggestions permitted; automated placement is not.

**Why:** A misclassified variant artifact pushed as global overwrites every target repo's language-specific behavior in a single sync.

## Intake Disclosure Scrub (Gate-1, before placement)

Every proposal ingested at Gate-1 — the manifest body AND the referenced BUILD/USE-template artifact files — MUST be disclosure-scrubbed BEFORE placement into `loom/.claude/`. Two mechanical actions run first: (a) `scan-synced-disclosure.mjs --check --root <inbound-repo-path>`, and (b) a HUMAN scrub of the proposal body per `upstream-issue-hygiene.md` Rule 2. A non-zero exit OR any finding = HALT until genericized + relocated; placement does not proceed. Why the body half is human-gated and why `--root` cannot reach it: companion § Intake Disclosure Scrub — Mechanics.

**BLOCKED rationalizations:** see `.claude/guides/rule-extracts/artifact-flow.md` § Intake Disclosure Scrub — BLOCKED Rationalizations.

## Exact Gate-1 / Gate-2 Tracking

Gate-2 distribution (`/sync-to-build`, `/sync-to-use`) MUST land through an ISOLATED worktree from the target's REMOTE main — never a write into the target's live local checkout — AND every Gate-1 ingest AND Gate-2 distribution MUST emit an exact-tracking receipt recording precisely what was done. Both halves are the collision-free, auditable distribution model Directive 1 ratified (`journal/0403`).

### 1. Gate-2 Lands Via An Isolated Worktree From Remote Main — Never The Target's Live Checkout (MUST)

`/sync-to-build` AND `/sync-to-use` MUST drive `bin/sync-gate2-worktree.mjs`, which `git fetch`es the target's REMOTE main, creates an ISOLATED worktree checked out at `origin/main`, applies Gate-2 THERE (the `sync-tier-aware.mjs` engine `--out <worktree>` + the USE-lane enrichment), commits explicit paths on a `sync/<date>-loom-<lane>-<target>` branch, opens a PR, and removes the worktree. Writing Gate-2 output into the target BUILD/USE repo's LOCAL working tree is BLOCKED.

**BLOCKED rationalizations:** see `.claude/guides/rule-extracts/artifact-flow.md` § Exact Gate-2 Worktree Landing — BLOCKED Rationalizations.

### 2. Every Gate-1 And Gate-2 Operation Emits An Exact-Tracking Receipt (MUST)

Every gate operation MUST emit a receipt recording EXACTLY what was done — a journal `DECISION` entry per gate op plus a signed coordination-log record via `coc-emit.js::emitSignedRecord`, on the `gate-op-receipt` fold type. Declaring a gate op complete without its receipt is BLOCKED. ONLY the committed journal `DECISION` embed MUST be scrubbed — via `sync-gate2-worktree.mjs::scrubReceiptForJournal` — BEFORE embedding, per MUST-2 below. Full receipt mechanics: companion § Exact Gate-1/Gate-2 Tracking MUST-2 — Receipt Mechanics.

- **Gate 1** (`/sync-from-build`, `/sync-from-use` ingest + classify): the source proposal, the per-change classification decision (global / variant / skip), the scrub result, and the per-file placement manifest.
- **Gate 2** (`/sync-to-build`, `/sync-to-use` distribute): the fields `bin/sync-gate2-worktree.mjs::buildReceipt` captures, per target. Before the receipt is embedded in the committed journal `DECISION` it MUST be scrubbed per `user-flow-validation.md` MUST-6 — the `pr_url` org/repo slug and the absolute `worktree` operator path are the scrub tokens. The per-target completeness table (`sync-completeness.md` MUST-2) is its verification companion. Full captured-field list: companion § Exact Gate-1/Gate-2 Tracking MUST-2 — Receipt Mechanics.

## MUST NOT

- Sync directly between BUILD repos — all paths through loom/

**Why:** Direct BUILD-to-BUILD sync bypasses classification and variant overlay, silently introducing language-specific artifacts into the wrong repo.

- Auto-classify global vs variant without human approval

**Why:** Automated classification lacks the domain judgment to distinguish a language-specific pattern from a universal one, risking silent overwrites across all targets.

Depth — the Trust-Posture Wiring, the rule-graph cross-references and the Origin record — lives in `.claude/skills/32-trust-posture/wiring/artifact-flow-gates.md`, which every validator reads as part of this rule.

<!-- /slot:neutral-body -->
