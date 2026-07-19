# Artifact Flow — Rule Extract (depth companion)

Depth companion for `.claude/rules/artifact-flow.md`. Holds the full BLOCKED-rationalization corpora, per-clause Origin narratives, and implementation-depth walkthroughs extracted from the rule (EXTRACT-not-NARROW; the normative MUST/MUST-NOT clauses, section headers, and Trust-Posture-Wiring blocks remain inline in the rule). Section headings below match the inline `See … §` pointers in the rule.

## Ecosystem Forks — Cross-Ecosystem Disclosure-Guard Implementation Status

The detailed SHIPPED / REGISTERED / DORMANT / DEFERRED status walkthrough for the cross-ecosystem disclosure guard (the invariant summary + the load-bearing MUST — route any cross-ecosystem pull through the Gate-1 Intake Disclosure Scrub AND the dedicated guard primitive — stay inline in the rule's § "Ecosystem Forks vs Downstream Consumers"):

A dedicated canon↔fork-aware guard **LIBRARY primitive** (`.claude/hooks/lib/cross-ecosystem-disclosure-guard.js`) is **SHIPPED** — a standalone fail-closed pre-write check that recognizes the boundary via the `ecosystem.json` `upstream_canon` pointer (`bin/lib/ecosystem-config.mjs::getUpstreamCanon` — null in canon, set in a fork) and refuses a fork→canon write of fork-identifying content (org slug, customer name, internal paths) **EVEN UNDER a `repo-scope-discipline.md:30` User-Authorized Exception grant** (the grant lifts the general cross-repo-write prohibition, NOT this distinct canon↔fork isolation invariant — the envelope-expansion gap the two general fences leave open), while PERMITTING a public-authority O1 artifact (ISO / SOC 2 / GDPR / etc.) as ecosystem-neutral (§ The Origination Taxonomy). Its entry-point hook is **REGISTERED** on the `Edit|Write|NotebookEdit` PreToolUse matcher (**F3 Level-1**, 2026-06-25, `journal/0335`) but **DORMANT**: it runs live, yet its BLOCK branch fires only on a write that DECLARES a canon target (a write #576's `sync-from-canon` driver does not itself emit — it is a canon→fork PULL, writing to the fork, not canon), and on canon (no `ecosystem.json`) every write passes through. The **LIVE autonomous cross-ecosystem write-DETECTION** an always-on fence needs (catching an ad-hoc fork→canon push) remains **DEFERRED** — it depends on the deferred ecosystem-remote resolver (`cross-repo.md` § "Ecosystem-Scoped Remote Links" — explicitly not yet built). The active cross-ecosystem upstream-pull — the gated **pull-merge** — is **SHIPPED**: the `sync-from-canon` driver landed (#576, 2026-06-30) and routes the pulled surface through the SAME Gate-1 Intake Disclosure Scrub (§ "Intake Disclosure Scrub" below) + `.claude/bin/scan-synced-disclosure.mjs` the intra-ecosystem intake uses (auto-merge is BLOCKED — every candidate is human-decided). Any cross-ecosystem pull MUST route its surface through that Gate-1 scrub AND the dedicated guard primitive above — a disclosure-scrubbed INTAKE, never a trusted merge. The driver resolves canon's tip via a live read-only `git ls-remote` over the `ecosystem.json` `upstream_canon` URL; the full **two-layer ecosystem-remote PATH resolver** (the `resolveRepo` NAME→remote-path join) remains DEFERRED (`cross-repo.md` § "Ecosystem-Scoped Remote Links").

## Canon Neutrality — BLOCKED Rationalizations

- "The tenant name is scrubbed, so the tenant concern is handled" (name ≠ coupling)
- "It's a legitimate human-authority gate, I should defer to it" (question whether it belongs at canon first)
- "The tenant's works-council decision is a real external gate" (real — but it gates the FORK's instance, not the canon mechanism)
- "Canon just needs to wait for the granularity to be settled" (canon builds agnostic; the granularity is a fork policy)
- "It's the first real customer, so the canon build follows their process" (canon is tenant-neutral; the first customer's process gates their fork, not canon)

## Canon Neutrality — Origin

2026-07-13 co-owner-directed origination (`journal/0478`). #411 DECISION-1 was authored as a HARD GATE blocking canon Wave 1 on the tenant's works-council (BetrVG §87(1)6) confirmation; #1000 scrubbed the tenant NAME but propagated the gate; co-owner catch ("we are on canon loom … isn't that a leak?") → #1002 re-scope (canon builds granularity-agnostic; works-council gate → fork/csq lane). The shipped design (DECISION-2 + `provenance-ledger.js::_projectOperatorRef` canon-emits-max-accountable / csq-coarsens) already implied canon-agnostic — the gate contradicted it.

## Downstream-Consumer Routing — BLOCKED Rationalizations

- "But the issue surfaced in MY repo, so I file it here"
- "Loom is the central authority — filing directly against loom skips a hop"
- "Filing against own repo is informational; the team will route it later"
- "The USE template is a thin wrapper; the real fix is in loom anyway"
- "My project repo IS a USE template" (downstream-consumer projects are NOT USE templates — the canonical USE-template set is enumerated above; if your repo is not in that set, you are a downstream consumer)

## Co-Owner-Directed Origination — BLOCKED Rationalizations

- "The co-owner approved the general direction, a verbatim quote is pedantic"
- "I'll write the journal entry after the edit, same thing"
- "It's CC methodology but close enough to COC tooling"
- "Re-routing a co-owner's direct in-session directive through the USE-template lane is just process"
- "Standing prior approval covers this new origination"

## Co-Owner-Directed Origination — Origin

2026-05-18 — co-owner-directed `/wrapup` forest-ledger codification; 6-entry precedent chain journal/0085, 0088, 0089–0094 each asserted this exception per-journal before it was named here. Receipt: journal/0095.

## The Origination Taxonomy O1 — Detection Mechanics

Two complementary layers (mechanical SHAPE + LLM-judgment GOVERNANCE). The contract sentence + the SHAPE-vs-GOVERNANCE split summary stay inline in the rule's § "The Origination Taxonomy — O1"; the predicate-level mechanics live here:

1. **Mechanical SHAPE check (SHIPPED — `.claude/hooks/lib/o1-citation-check.js::checkO1Citation`).** Given an O1-origination journal `DECISION` receipt, it asserts STRUCTURALLY that the receipt (a) names a standard AND carries a VERSION token (a standalone year counts ONLY when NAME-ADJACENT, riding the standard name — a free-floating year in prose does NOT), (b) cites a specific clause/§ identifier (a BARE standard name with no clause is BLOCKED — the agent-producible degenerate case this § calls out in the "per ISO 27001:2022" DO-NOT below), and (c) carries a one-sentence derivation linking clause → artifact ("§X requires Y → this rule mandates Z"). It fails LOUD with a TYPED reason naming which of (a)/(b)/(c) failed. Per `hook-output-discipline.md` MUST-2 it surfaces as halt-and-report/advisory (a review signal), NEVER `severity:block`. Behavioral tests: `.claude/test-harness/tests/o1-citation-check.test.mjs`; one audit fixture per predicate: `.claude/audit-fixtures/o1-citation-check/`.
2. **LLM-judgment GOVERNANCE gate (the preserved human boundary).** The SHAPE check is mechanical; the SEMANTIC question — "does the cited clause ACTUALLY GOVERN this artifact's content?" — STAYS WITH THE HUMAN / LLM GATE. The check explicitly does NOT judge governance: a real standard whose clause does NOT govern the edit PASSES the SHAPE check and is BLOCKED only by the cc-architect's judgment reading the receipt (and halting on a non-governing edit). The SHAPE check COMPLEMENTS, never REPLACES, that judgment — it is the structural fence the LLM-judgment gate previously held alone (and not necessarily the `self-referential-codify.md` multi-agent gate, which fires only when the compliance artifact ITSELF is a codify-governing surface; a typical compliance rule governs code behavior, so it is outside that allowlist).

## The Origination Taxonomy — Origin

2026-06-15 — ECO-CANON W4 (O1, C6); DECISION-7 RATIFIED (`decisions/00`, `journal/0282` _"Methodology is at loom level… they enter at loom level"_); normative `specs/05 §1` + `specs/06 §4`. Co-owner-directed origination chain `journal/0280`/`0282`/`0284`.

## Intake Disclosure Scrub — BLOCKED Rationalizations

- "Gate 2 scans output, intake scrub is redundant"
- "It came from our own BUILD repo, there are no client tokens"
- "We'll catch it at Gate 2"

## Exact Gate-2 Worktree Landing — BLOCKED Rationalizations

- "No one is working in that checkout right now"
- "The overlay is faster than a worktree + PR round-trip"
- "The BUILD team will land the uncommitted delta as PR #1 next session"
- "It is my own machine's clone, the working tree is mine to overlay"

## Exact Gate-1/Gate-2 Tracking MUST-2 — Receipt Mechanics

The MUST contract sentence ("Every gate operation MUST emit a receipt … Declaring a gate op complete without its receipt is BLOCKED") stays inline in the rule's § "Exact Gate-1 / Gate-2 Tracking" MUST-2; the receipt mechanics live here:

Every gate operation MUST emit a receipt recording EXACTLY what was done, through the same mechanism Shard-B's receipts use — a journal `DECISION` entry per gate op plus a signed coordination-log record via `coc-emit.js::emitSignedRecord` (`journal/0402`). The coordination-log record uses the `gate-op-receipt` fold type (registered in `coordination-log.js::_registerM0Defaults` — a single-signer, `checkpoint_exempt` accountability record; NOT an actuation, so it bypasses the A+ presence gate); `sync-gate2-worktree.mjs::emitTrackingRecord` emits it for every completed Gate-2 distribution and surfaces any emission failure on the receipt's `record_emit` field rather than failing the sync (the PR has already landed). The signed record carries every SCALAR provenance field (`loom_sha`, `base_sha`, `target`, `branch`, `pr_url`, `merge_sha`, `timestamp`, `gate`, `lane`, `worktree`, `changed_count`) plus a manifest FINGERPRINT (`manifest_fingerprint` = per-bucket `added_count`/`modified_count`/`deleted_count` + a `sha256` over a bucket-structured canonical form — `JSON.stringify({added, modified, deleted})` with each bucket pre-sorted, binding bucket MEMBERSHIP so a compensating cross-bucket swap (add x/del y ↔ add y/del x) cannot forge a collision; produced by `sync-gate2-worktree.mjs::fingerprintManifest`) rather than the inline manifest ARRAYS — the arrays overflow `coc-emit.js::_defaultAppend`'s 2KB `MAX_LINE_BYTES` cap for broad Gate-2 syncs (100+ files), and an overflowed append is REFUSED so NO forensic record lands (#862); the fingerprint is produced by `sync-gate2-worktree.mjs::fingerprintReceiptForRecord`. The FULL manifest survives uncapped on the STDOUT receipt AND the committed journal `DECISION` embed (the local forensic source of truth the fingerprint recomputes from — the coordination log is local per-repo state, never synced per `trust-posture.md` MUST NOT). ONLY the committed journal `DECISION` embed MUST be scrubbed — via `sync-gate2-worktree.mjs::scrubReceiptForJournal` (the absolute `worktree` path, the `pr_url` org/repo slug, AND any absolute path in `record_emit.reason`) — BEFORE embedding, per MUST-2; the manifest arrays it keeps are `.claude/`-relative file paths, not disclosure tokens.

## Length Rationale — Full 17-Section Enumeration

The rule codifies the complete artifact-distribution surface across 17 distinct sections: Authority Chain, Repo Classes ↔ Resolver, Ecosystem Forks vs Downstream Consumers, Canon Neutrality — A Tenant-Specific Gate Never Gates A Canon Build, Issue Routing By Change Type [+ Route A], Consultant Dual-Route Self-Serve, loom Splits Never Originates, Co-Owner-Directed Origination, The Origination Taxonomy O1/O2/O3, BUILD Repo Rules, Proposal Lifecycle, /sync-to-use as Only Outbound Path to Templates, Human Classifies Every Change, Intake Disclosure Scrub, Exact Gate-1 / Gate-2 Tracking [+ its paired Instantiation-Is-A-Publish / Source-Clean-At-Rest Trust Posture Wiring], Variant Overlay Semantics, Distribution-Durability Invariants — plus the trailing MUST NOT clause block. Each section carries non-overlapping invariants the artifact-flow contract requires holding simultaneously. Splitting into sub-rules would fragment the canonical-flow surface across files and force cross-rule lookups for every routing decision — exactly the load-failure mode `rules/cc-artifacts.md` Rule 6 warns against. Per `rules/rule-authoring.md` MUST NOT § "Rules longer than 200 lines": the cap is guidance; overage is permitted with named rationale anchored at the rule's Origin. Sibling precedent: `multi-operator-coordination.md` Origin + `user-flow-validation.md` Origin carry the same length-rationale shape for the same class of multi-clause structural rule.

## Consultant Dual-Route Classifier — Shipped Implementation

The dual-route classifier (artifact vs capability vs bug) is SHIPPED (ECO-IMPL W7b). The Layer-1 mechanical glob + Layer-2-suggestion dispatch (`gc-route-classifier.js`), the `upstream-issue-hygiene.md` MUST-3 five-section BUILD-issue drafter + cross-SDK-first flag + MUST-2 scrub (`gc-build-issue-draft.js`), and the G3.5 disposition-visibility receipts (`gc-disposition-receipt.js`) are wired at `commands/codify.md` Step 7c (full procedure in `skills/30-claude-code-patterns/sync-flow.md` § "Route-B Capability/Bug Upflow (G-C)"). The **Layer-2 capability-vs-bug judgment is the LLM's** — a dumb-lib / LLM-reasons split per `agent-reasoning.md` + `probe-driven-verification.md`; the lib carries NO keyword classifier and the HUMAN gate (MUST-1) classifies+files. That LLM-judgment surface is correct by design, NOT a gap. The upflow's gh-vs-ADO provider abstraction for the PR/issue write-surface is **G-F, SHIPPED at W7a** (`specs/05 §3`).

## Downstream-Consumer Routing — Full DO / DO-NOT Examples

```
# DO — downstream consumer routes UP to the USE template (primary: Step 7c PR to inbox)
kaizen-cli-py operator hits a COC-rule issue
  → /codify Step 7c originates a proposal, offers a HUMAN-GATED PR to
    kailash-coc-claude-py/.claude/.proposals/inbox/ (the template it pulled from)
  → the template's /sync-from-downstream ingests the inbox, relays into its Step-7b manifest
    with hop-level provenance (origin: downstream, via: kailash-coc-claude-py)
  → proposal flows to loom Gate-1 → /sync-to-use redistributes

# DO — fallback when the consumer cannot fork the template (no PR permission)
kaizen-cli-py operator cannot open a PR against kailash-coc-claude-py
  → files a COC-rule issue on kailash-coc-claude-py (Route A) → template /codify originates

# DO NOT — file against own repo (orphan proposal; never reaches loom)
kaizen-cli-py operator files COC-rule issue on kaizen-cli-py
  → kaizen-cli-py is a downstream consumer; it does NOT originate proposals to loom

# DO NOT — file against loom directly (skips USE-template-side review)
kaizen-cli-py operator files COC-rule issue on loom/
  → bypasses USE-template /codify origination; loom is the splitter, not the originator
  → violates "loom Splits, Never Originates" below
```

## E3 Reframe — Consultant Edit-Ban Is Class A

The intro paragraph + the Surface/Durable/Class table stay inline in the rule's § "The consultant's edit-ban is Class A"; the extended reasoning lives here:

This is **Class-A-routing of a Class-C capability** — the identical shape to the capability-engineer authoring at BUILD rather than direct-at-loom (also a Class-A `loom Splits, Never Originates` routing of a Class-C capability, § The Origination Taxonomy O3). The role HAS the capability (improve templates / author capabilities); Class A routes it onto the DURABLE mechanism.

**Why:** Filing a distribution-mechanics fact as a role restriction tells a consultant they may not improve templates — false, and it removes the most autonomous lane they have (D4 self-serve). Separating the three classes makes the real invariant role-blind (it binds the platform-engineer too) and the real capability role-scoped-but-durably-routed. A write that is role-scoped (C) and posture-unlocked (B) still MUST clear Class A; conflating the axes hides which of the three actually governs — the exact ambiguity the E3 error shipped.

## Class-A Members — Full Enumeration

Each member is already a MUST / MUST-NOT clause elsewhere in the rule; collected here as the named cross-cutting class (the header + the role-blind/posture-blind invariant stay inline in the rule's § "The Class-A members"):

- **loom Splits, Never Originates** (§ "loom Splits, Never Originates") — a loom-direct origination without an audit trail does not survive Gate-1's provenance requirement. (The O1/O2/O3 taxonomy + the Co-Owner-Directed carve-out are the audit-trail-bearing exceptions, not violations of the invariant.)
- **`/sync-to-use` is the only outbound path to templates** (§ "/sync-to-use Is the Only Outbound Path to Templates") — any other write to a template is overwritten on the next rebuild.
- **Editing a template `.claude/` directly is overwritten by `/sync-to-use`** (§ MUST NOT "Edit template repos directly") — the durable surface is the proposal QUEUE (`.claude/.proposals/inbox/`), never the rebuilt artifact files.
- **BUILD→BUILD direct sync bypasses classification** (§ MUST NOT "Sync directly between BUILD repos") — every path routes through loom's Gate-1 split.
- **Human classifies every change; automated placement is BLOCKED** (§ "Human Classifies Every Change") — an auto-placed global-vs-variant write does not survive review.

## Origin (full narrative)

Pre-2026-05-28 baseline plus F63 (.session-notes step 3 / Q3c — Route A downstream-consumer routing clarification, receipt journal/0165) plus sync-upflow Wave 2a (2026-06-13, todo 09: Step 7c downstream-upflow promoted to the PRIMARY downstream path with Route A retained as fallback; downstream→USE-template origination direction added to § Proposal Lifecycle; QUADRUPLE disclosure-fence note in § Downstream-Consumer Routing; brief value-anchor (loom-internal reference)). Prior receipt-bearing additions: `Co-Owner-Directed Origination` subsection (2026-05-18, journal/0095); `Intake Disclosure Scrub` (2026-05-17, journal/0082-0084); `Repo Classes Map 1:1 To Resolver Logical Keys` (2026-05-17, journal/0086). Plus ECO-CANON W4 (2026-06-15, DECISION-4 + DECISION-7 RATIFIED per `journal/0280`/`0282`): `Consultant Dual-Route Self-Serve (D4)` subsection (C6) + `The Origination Taxonomy — O1/O2/O3` subsection (O1, generalizing the Co-Owner-Directed carve-out); receipt `journal/0289`. Plus ECO-IMPL W7c (2026-06-20, G-B consultant-permission prose): the `## Distribution-Durability Invariants` section (the three-way permission taxonomy A/B/C + the conjunctive composition + the Class-A member enumeration + the consultant Class-A/C reframe correcting the `specs/01 §4` E3 conflation); the paired Class-C↔Class-A orthogonality cross-ref lands in `multi-operator-coordination.md` §1. Value-anchor (loom-internal reference) + `decisions/00` DECISION-4; provenance the ECO-IMPL workstream (`journal/0281 §A2`). Plus Directive 1 (2026-07-03, co-owner-directed origination `journal/0403`): the `## Exact Gate-1 / Gate-2 Tracking` section (Gate-2 worktree-from-remote-main landing + the exact-tracking receipt requirement spanning both gates), superseding the working-tree-overlay handoff.
