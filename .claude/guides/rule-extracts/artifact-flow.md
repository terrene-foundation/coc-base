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

<!-- ── Depth extracted from `.claude/rules/artifact-flow.md` on 2026-08-16, paired
     with the Owned-Surface Bound clause (rule-authoring.md Rule 10 path (a)).
     Each block below is the VERBATIM text that stood in the rule; the rule now
     carries a compact contract sentence plus a pointer here. ── -->

## Canonical Sublayout Hint (F61)

**Canonical sublayout hint (recommended for fresh operators — F61).** The recommended on-disk realization of the logical namespace is `~/repos/kailash/{build,use}/<slug>` (BUILD under `.../build/{py,rs,prism}`, USE templates under `.../use/{py,rs,claude-py,claude-rs}`, peer roots `~/repos/loom` + `~/repos/atelier`). This is a HINT, NOT a MUST clause; pre-existing operators on any other layout (flat, nested, or a declared `loom-links.local.json` mapping) remain fully supported and the resolver/validators/sync tooling are unchanged. The hint stated above is the whole of it for a USE template or downstream consumer; the full hint + explicit non-enforcement disposition is loom/BUILD-side (`cross-repo.md` § "Canonical Sublayout (Recommended — F61)", NOT distributed to USE).

## Ecosystem Forks — Cross-Ecosystem Disclosure-Guard Implementation Status (moved 2026-08-16)

**Cascade is scoped to the ecosystem.** WITHIN one ecosystem, every artifact/capability improvement reaches every member project — with no per-project re-decision — via Gate-1 human classification + each project pulling on its own sync cadence (NOT an instantaneous auto-push). ACROSS ecosystems there is NO automatic cascade: a fork SEES canon's latest and DECIDES whether to roll each change in (the gated upstream-pull), and never pushes its identity or work back to canon. Disclosure is isolated **bidirectionally** at the ecosystem boundary — no ceremony, sync, deploy, or publish may carry one ecosystem's identity into another's committed/shared/public surface. This invariant is held **TODAY** by the two PRESENT general-purpose fences: `repo-scope-discipline.md`'s cross-repo-write prohibition (an agent cannot self-authorize a fork↔canon write) + the `publish-to-public.mjs` positive-INCLUDE allowlist on the publish path. A dedicated canon↔fork-aware guard primitive (`.claude/hooks/lib/cross-ecosystem-disclosure-guard.js`) is **SHIPPED + REGISTERED** on the `Edit|Write|NotebookEdit` PreToolUse matcher but **DORMANT** (its BLOCK branch fires only on a write DECLARING a canon target; on canon every write passes through); the **LIVE autonomous fork→canon write-DETECTION** an always-on fence needs remains **DEFERRED** (it depends on the deferred ecosystem-remote resolver, `cross-repo.md` § "Ecosystem-Scoped Remote Links"). The gated cross-ecosystem upstream-pull (`sync-from-canon`, #576, 2026-06-30) is **SHIPPED**, and any cross-ecosystem pull MUST route its surface through the SAME Gate-1 Intake Disclosure Scrub (§ "Intake Disclosure Scrub" below) AND the dedicated guard primitive — a disclosure-scrubbed INTAKE, never a trusted merge (auto-merge is BLOCKED; every candidate is human-decided). The fork→canon direction is fenced as a MUST NOT (below). Full SHIPPED/REGISTERED/DORMANT/DEFERRED status walkthrough: see `.claude/guides/rule-extracts/artifact-flow.md` § Ecosystem Forks — Cross-Ecosystem Disclosure-Guard Implementation Status.

## Disclosure Fence (Scenario 8) — The Four Scrubs

**Disclosure fence (scenario 8) — QUADRUPLE on the public-fork axis.** A downstream-originated proposal is disclosure-scrubbed four times before any public-fork exposure: (i) consumer-side Step-7c scrub, (ii) template inbox-ingest scrub, (iii) loom Gate-1 scrub, (iv) `publish-to-public.mjs`'s positive INCLUDE allowlist. Hop-level-only provenance (`via: <template-slug>`, never consumer-identifying) means no consumer identity is carried even before the fences run.

## Consultant Dual-Route Classifier — Shipped Implementation (moved 2026-08-16)

**The dual-route classifier (artifact vs capability vs bug) is SHIPPED (ECO-IMPL W7b)** — wired at `commands/codify.md` Step 7c. The **Layer-2 capability-vs-bug judgment is the LLM's** — a dumb-lib / LLM-reasons split per `agent-reasoning.md`; the lib carries NO keyword classifier and the HUMAN gate (MUST-1) classifies+files. That LLM-judgment surface is correct by design, NOT a gap. Full wiring (the `gc-route-classifier.js` / `gc-build-issue-draft.js` / `gc-disposition-receipt.js` surfaces + the G-F gh-vs-ADO provider abstraction): see `.claude/guides/rule-extracts/artifact-flow.md` § Consultant Dual-Route Classifier — Shipped Implementation.

## The Origination Taxonomy O1 — Detection Mechanics (moved 2026-08-16)

- **Detection mechanism:** two complementary layers (mechanical SHAPE + LLM-judgment GOVERNANCE). **NO HOOK LAYER — this clause claims none.** An O1 origination is a `/codify`, so the standing cc-architect review every `/codify` deploys (per `cc-artifacts.md` Rule 6) gate-reviews it. A mechanical SHAPE check (SHIPPED, at CLI-ENTRYPOINT time — `checkO1Citation`, composed by the loom-only `/govern` origination path and by `.claude/bin/sync-from-canon-objects.mjs`'s O1 pre-screen; its module rides a distribution tier that is NOT an enforcement layer and no hook event loads it) asserts STRUCTURALLY that the receipt names a standard + version, cites a specific clause/§, and carries a one-sentence clause→artifact derivation — failing LOUD with a typed reason, surfacing as halt-and-report/advisory per `hook-output-discipline.md` MUST-2, NEVER `severity:block`. The SEMANTIC question — "does the cited clause ACTUALLY GOVERN this artifact's content?" — STAYS WITH THE HUMAN / LLM GATE (the cc-architect's judgment): a real standard whose clause does NOT govern the edit PASSES the SHAPE check and is BLOCKED only by that judgment. The SHAPE check COMPLEMENTS, never REPLACES, the LLM-judgment gate. Full two-layer mechanics (per-predicate SHAPE contract + the governance-gate boundary + fixtures): see `.claude/guides/rule-extracts/artifact-flow.md` § The Origination Taxonomy O1 — Detection Mechanics.

## Exact Gate-1/Gate-2 Tracking MUST-2 — Receipt Mechanics (moved 2026-08-16)

Every gate operation MUST emit a receipt recording EXACTLY what was done, through the same mechanism Shard-B's receipts use — a journal `DECISION` entry per gate op plus a signed coordination-log record via `coc-emit.js::emitSignedRecord` (`journal/0402`). The coordination-log record uses the `gate-op-receipt` fold type; `sync-gate2-worktree.mjs::emitTrackingRecord` emits it for every completed Gate-2 distribution and surfaces any emission failure on the receipt's `record_emit` field rather than failing the sync (the PR has already landed). The signed record carries every SCALAR provenance field plus a manifest FINGERPRINT (not the inline manifest ARRAYS, which overflow `coc-emit.js`'s 2KB `MAX_LINE_BYTES` cap for broad syncs and get REFUSED, #862); the FULL manifest survives uncapped on the STDOUT receipt AND the committed journal `DECISION` embed. ONLY the committed journal `DECISION` embed MUST be scrubbed — via `sync-gate2-worktree.mjs::scrubReceiptForJournal` — BEFORE embedding, per MUST-2 below. Declaring a gate op complete without its receipt is BLOCKED. Full receipt mechanics (the `manifest_fingerprint` bucket-structured sha256, the 2KB-cap-refusal #862 evidence, the per-field scrub set): see `.claude/guides/rule-extracts/artifact-flow.md` § Exact Gate-1/Gate-2 Tracking MUST-2 — Receipt Mechanics.

## Exact Gate-1/Gate-2 Tracking MUST-2 — Gate-2 Captured Fields

- **Gate 2** (`/sync-to-build`, `/sync-to-use` distribute): the fields `bin/sync-gate2-worktree.mjs::buildReceipt` captures — `loom_sha`, the worktree `base_sha`, `target`, `branch`, the per-file `manifest` (added / modified / deleted), `changed_count`, `pr_url`, and `merge_sha`; the full return additionally carries `gate`, `lane`, the absolute `worktree` path, and `timestamp` — per target. Before the receipt is embedded in the committed journal `DECISION`, it MUST be scrubbed per `user-flow-validation.md` MUST-6: the `pr_url` org/repo slug (private on a Rust BUILD lane) and the absolute `worktree` operator path are the scrub tokens. The per-target completeness table (`sync-completeness.md` MUST-2) is the Gate-2 receipt's verification companion.

## Authority Chain — Flow Diagram

```
issue routed by change TYPE
  ├─ COC-artifact (method/rules/skills/agents/COC-tooling)
  │     → USE-template repo (kailash-coc-*) → /codify → proposal ─┐
  ├─ bug/code/feature (SDK code)                                  │
  │     → BUILD repo → cross-SDK-FIRST → /codify → proposal ──────┤
  └─ CC/CO methodology → atelier/ → /sync-to-coc ─────────────────┤
                                                                  ▼
                              loom/ SPLITTER (Gate-1 human classify: global vs variant)
                                  ├─ /sync-to-build → BUILD repos (canonical pushed back)
                                  └─ /sync-to-use → USE templates → downstream USE/project repos pull (own /sync-from-template)
                                                                  │
                                                                  └──→ cycle repeats

❌ loom/ originates an artifact change itself (no upstream audit trail)
❌ loom/ edits CC/CO independently (drifts from atelier/)
❌ BUILD repos sync directly to templates (bypasses loom/)
❌ filing an SDK-code bug as a COC-artifact issue, or a COC-method fix as an SDK-code bug (wrong lane bypasses the Gate-1 split)
```

## Proposal Lifecycle — State Diagram

```
/codify creates proposal     /sync-from-* (Gate 1) classify   /sync-to-use (Gate 2) distributes
        │                                  │                                │
  pending_review ──────────────→ reviewed ──────────────────────→ distributed
        │                          ↑ │                                │
        │  /codify appends         │ │ /codify appends (resets       │ /codify archives
        └──────────────────────────┘ │ status to pending_review)     │ and creates fresh
                                     └───────────────────────────────┘
```

## Applies to All Originating Directions — Per-Direction Detail

- **BUILD → loom**: SDK BUILD-repo proposals, cross-SDK-first (`/codify` Step 7)
- **USE-template → loom**: COC-artifact proposals from `kailash-coc-*` (authoritative target flow; manifest contract in `guides/co-setup/09-proposal-protocol.md` Step 7b)
- **downstream → USE-template (relayed up to loom)**: a `coc-project` consumer's `/codify` Step 7c originates a push-only proposal offered to the template's `.claude/.proposals/inbox/`; the template's `/sync-from-downstream` relays accepted entries into its OWN USE-template→loom manifest with hop-level provenance (`origin: downstream, via: <template-slug>`), then they ride the row above (§ Downstream-Consumer Routing). The USE-template→loom ingest stream is PRE-EXISTING; Step 7c adds ONLY the consumer→template-inbox origination + relayed-provenance recognition, NOT a new loom-facing stream.
- **loom → atelier**: loom's CC/CO proposals (`/codify` Step 8)

## Repo Classes ↔ Resolver Logical Keys — Full Mapping

The four repo classes above bind one-to-one to `bin/lib/loom-links.mjs` logical keys: **BUILD** → `build.{py,rs,prism}`, **USE-template** → `use-template.{py,rs,claude-py,claude-rs}`, **atelier** → `atelier`, **downstream** → `downstream.<slug>`. The resolver is the canonical NAME→location binding (per `repo-scope-discipline.md` § MUST NOT — the resolver module and its full `cross-repo.md` contract are loom/BUILD-side and NOT distributed to USE); `sync-manifest.yaml::repos.<target>` still owns the logical NAME + tier membership. Cross-repo tooling (`/sync`, `/sync-to-build`, `/inspect`, `/repos`) resolves every target through the resolver — never a positional `~/repos/<name>` / `../<name>` guess — making the path side of every class declarative and operator-portable without changing the flow above.

## Intake Disclosure Scrub — Mechanics

Every proposal ingested at Gate-1 — the `.claude/.proposals/latest.yaml` body AND the referenced BUILD-repo / USE-template-repo artifact files — MUST be disclosure-scrubbed BEFORE placement into `loom/.claude/`. Gate-1 scrub is two mechanical actions, run first: (a) `node .claude/bin/scan-synced-disclosure.mjs --check --root <inbound-repo-path>` against the candidate artifact files, AND (b) a HUMAN scrub of the proposal body per `upstream-issue-hygiene.md` Rule 2 (the body is small and already human-classified at Gate-1; `.proposals/` is `isNeverSynced` so `--root` will not scan it — the human gate covers it). A non-zero scanner exit OR any finding = HALT until the disclosure is genericized + relocated (the #255 / #260 pattern); placement does not proceed. This is the symmetric twin of the Gate-2 output fence (#263).

## Owned-Surface Bound — Detection Mechanics

- **Detection mechanism:** structural + review, and the structural half SHIPS WITH THE CLAUSE. `.claude/bin/check-owned-surfaces.mjs` reds on four kinds — `undeclared-write-surface` (an engine-plan destination matching no declared surface, on either USE lane and every BUILD lane), `undeclared-enrichment-surface` (a `multi_cli_overlays` / `dev_container_ownership` destination matching none), `fail-open-default` (a non-`.claude` surface at `opt_in: false`), `election-missing`. Its `--selftest` flag is the positive control: three mutations of the LIVE manifest, each asserted to have APPLIED before its verdict is read, so a non-reddening result reports INERT rather than passing as a vacuity verdict. Bipolar poles are committed at `.claude/audit-fixtures/owned-surface-bound/{conformant,violating}.manifest.yaml`, differing by exactly three mutations; `.claude/test-harness/tests/check-owned-surfaces.test.mjs` pins that the conformant pole stays GREEN and the violating pole REDS on each planted defect, and asserts the poles still isolate one property. Both the gate and the suite are wired into `.github/workflows/coc-artifact-eval.yml`. Review: cc-architect at `/codify` inspects any diff touching `owned_surfaces:` for whether the surface should exist, which no mechanical check can answer.

## The Origination Taxonomy O1 — Why The Citation Must Govern

**Enforcement is load-bearing (`specs/06 §4` R1 LOW-2 / DECISION-7 honest-con) — the citation must GOVERN, not merely EXIST:** the journal `DECISION` receipt MUST (a) cite the external authority **down to the specific version + clause/§** (a bare standard name is the agent-producible degenerate case and is insufficient), AND (b) state in ONE sentence HOW that clause MANDATES the artifact's content (the derivation: "§A.8.24 requires cryptographic-controls policy → this rule mandates X"). Both MUST land **BEFORE the edit**. A citation that names a real standard whose clause does NOT govern the artifact is the loophole, not the fence — an uncited OR non-governing "compliance" edit is an unattributable loom origination and is BLOCKED. The other two carve-out conditions still apply (receipt-before-edit + COC-tooling scope: CC/CO methodology still routes to `atelier/`, SDK code to BUILD).

## Downstream-Consumer Routing — Step-7c Upflow Mechanics

- **Primary — Step 7c upflow (push-only, human-gated):** the consumer's OWN `/codify` Step 7c originates a COC-artifact proposal (schema in `skills/30-claude-code-patterns/sync-flow.md` § "Downstream Upflow Proposal Schema (Step 7c)") and offers it as a HUMAN-GATED PR to the template's `.claude/.proposals/inbox/<date>-<slug>.yaml` (per `upstream-issue-hygiene.md` MUST-1). The template's `/sync-from-downstream` (Template Inbox Ingest) scrubs + reviews-as-data + dedups + relays accepted entries into its OWN Step-7b manifest with hop-level provenance `origin: downstream, via: <template-slug>` (never consumer-identifying). The relayed proposal flows to loom Gate-1; loom distributes on the next `/sync-to-use`; consumers pull on their own cadence.

## Instantiation-Is-A-Publish — Source-Clean-At-Rest Mechanics

**The source of instantiation MUST be clean at rest.** Any repo a client or downstream operator instantiates FROM — canon itself, or a dedicated client-template edition — MUST carry no canon trust-identity (operator roster, coordination-log, journal, `ecosystem.json` org slugs) at rest, because a repo `git clone`d or generated FROM it inherits that identity in its initial commit and object history. Post-hoc cleanup (`.claude/bin/clean-instantiate.mjs`) is a detect-and-remediate backstop, NOT the fence — once a client has cloned and pushed, canon's objects may already be server-side and un-deletable. The structural fix is SOURCE-PREVENTION: instantiate from a pre-scrubbed client-template edition (`scripts/publish-to-private-template.mjs`), never from a live canon clone.

## Distribution-Durability Invariants — Where Classes B and C Live

**Class A is OWNED here; B and C are REFERENCED, not restated.** This section owns Class A (distribution mechanics). **Class B** lives in `rules/trust-posture.md` (the L1–L5 autonomy ladder; the `/release` distinct-person owner co-sign is `operator-gate.js`, `multi-operator-coordination.md` §6.4). **Class C** lives in `rules/multi-operator-coordination.md` §1 (the advisory `business_roles` array — `platform-engineer` / `capability-engineer` / `business-consultant`, NEVER quorum-eligible). Per `rules/specs-authority.md` Rule 9 they are cross-referenced, never duplicated — no parallel source of truth.

## Owned-Surface Bound + Target-Only Preservation — Origin (full narrative)

**§ The Owned-Surface Bound + § Target-Only Paths Are Preserved — 2026-08-16, co-owner-ratified D1/D2/D3/D4/D6** ((loom-internal reference) Item 2). The gap was an OMISSION WITH A MECHANISM: overwrite and preserve were each written down because an incident forced it, and add never had one, because until now every addition landed inside `.claude/`, which consumers read as loom-owned by convention. The retro-declaration is a MEASUREMENT, not a wish — surfaces were enumerated from the engine plan, the enrichment steps, and the dev-container emitter rather than from the referring analysis, which is how the declaration came to name TWELVE MORE than the six that analysis reported. Two of its claims are CORRECTED here rather than restated: `.codex-mcp-guard/**` and `bin/` were missing from its list, and `.github/` is NOT a hypothetical future surface — `emit-dev-container.mjs` already writes `.github/workflows/publish-dev-image.yml` on the py lane (21 substitutions, measured), so the "first executable, credentialed surface" framing is false and the entry is declared narrowly BY PATH so that any broader workflow distribution still reds. Per `rule-authoring.md` Rule 10 path (a) the clauses shipped PAIRED with extraction — twelve depth blocks moved verbatim to the companion; the path-scoped budget (`check-rule-injection-budget.mjs`) was measured over-ceiling on three profiles mid-change and green on all eight at landing. Rule 10's own trigger scope does not fire here (this rule is `scope: path-scoped`), so the extraction answers the loom#678 CI gate, not Rule 10.

## Ecosystem Forks vs Downstream Consumers — The Fork Definition (cont.) — Why Conflating Them Breaks

Conflating them routes a fork's independent-development decisions through downstream-consumer pull machinery that does not model the canon←→fork relationship.

## Target-Only Preservation — The Three Questions The Contract Answers

The PRESERVE half is the twin of the ADD bound above and of the OVERWRITE prohibition in § MUST NOT: together they are the three questions the distribution contract answers.

## Owned-Surface Bound — Regression-Within-Grace Disposition (full reasoning)

Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8: the structural gate already refuses the violating state at CI, so the residual review-layer judgment (whether a NEW surface should exist at all) does not warrant an instant-drop key, and minting one would drag `trust-posture.md` — a `self-referential-codify.md` allowlist file — into a self-referential edit. Same disposition `security.md` § Enforcement-Surface Parity and `git.md` § CI-check/merge took.

## Distribution-Durability Invariants — Composition

**Composition:** `write permitted-and-durable = role_scopes_it (C) AND posture_unlocks_it (B) AND pipeline_preserves_it (A)`. The three are **conjunctive AND independent** — a write blessed by role and posture still vanishes if it violates a Class-A invariant; a Class-A-clean write still needs the role to scope it (C) and the posture to unlock it (B). Naming which of the three blocked (or will silently revert) a write is the whole point of keeping them separate.

## Composition Order — Measured Over-Report

`loom_only` is tested at `classifyFile` step **2b**; tier inclusion is step **5**; `exclude` /
`use_exclude` fence again after that. So a derivation that asks only "does a shipped tier glob
match?" reports as distributed every file the earlier and later fences remove.

Measured on the base USE lane, 2026-08-16, from `sync-tier-aware.mjs --target base
--all-templates --dry-run --json` (the authoritative path — plan ACTIONS, not globs):

| skip reason      | files | what a tier-glob derivation would have said |
| ---------------- | ----- | ------------------------------------------- |
| `exclude`        |   842 | shipped (wrong)                             |
| `no_tier_match`  |   649 | not shipped on THIS lane — see the note below |
| `loom_only`      |    95 | shipped (wrong)                             |
| `use_exclude`    |    34 | shipped (wrong)                             |
| `reserved_local` |     2 | shipped (wrong)                             |

**973 files** would be wrongly reported as shipped. And `no_tier_match` is not a fourth over-report: it means "no tier THIS LANE subscribes to", NOT "undeclared" — most of those 649 ship on another lane (see § Positive Fate — The Invariant Is Held). Worked example, both poles on one tree:
`.claude/agents/management/coc-sync.md` matches a shipped tier and is `skip/loom_only`;
CONTROL `.claude/rules/git.md` is `copy/tier_match`. The instrument returns both answers, so the
`loom_only` verdict is discriminating and not an artifact of the query.

The owned-surface enumeration in `sync-manifest.yaml::owned_surfaces` was derived this way —
from plan actions across all six lanes — which is why it is sound. All six lanes' `copy`/`overlay`
destinations sit under `.claude/` and nowhere else (base 2,148 · py 2,520 · rs 2,520 · build-py
2,532 · build-rs 2,532 · build-prism 216); every other declared surface comes from the enrichment
steps and the dev-container emitter, which the engine plan does not see.

**Do not cross-check this list against `community-membership.mjs::INCLUDE`.** That module's own
docstring scopes it to `scripts/publish-to-public.mjs` — the public-fork snapshot of **loom
itself**. Its published roots (`scripts`, `tests`, `tools`, `.gitattributes`) are loom's own
repo-root paths, NOT surfaces written at a consumer; none of them appears as a copy destination on
any lane. Treating a disagreement between the two sets as a finding is the
`instrument-discipline.md` MUST-4 error — two instruments, two questions.

## Positive Fate — The Invariant Is Held

Every artifact should carry a POSITIVE fate: shipped on a named tier, `loom_only`, or explicitly
excluded. Undistributed-by-OMISSION would record no intent at all and could not be told apart from
an oversight.

**Measured 2026-08-16: there is no such artifact among the rules. The invariant is HELD.** Across
all three USE lanes, **0 of 96 rules** lack a declared tier. This clause is therefore
**PROPHYLACTIC — it exists to keep a held invariant held, not to describe a live defect.**

### The trap: `skip/no_tier_match` does NOT mean "undeclared"

It means "matches no tier **THIS LANE** subscribes to". A rule declared in the `kailash` tier is
`no_tier_match` on the language-agnostic base lane and `copy/tier_match` on py — declared the
whole time.

Measured, both poles on one tree: **all 19** base-lane `no_tier_match` rules — including
`framework-first.md`, `sync-completeness.md`, `connection-pool.md`, `dataflow-pool.md` — return
`copy/tier_match` on the py lane. Not one is undeclared, and none is missing from a consumer that
subscribes to its tier.

**An earlier revision of this section read the base-lane count as a live defect** ("649 files
undistributed by omission, 18 of them rules"). That was the SAME single-lane composition error this
rule's sibling MUST NOT warns about, made one axis over: a per-lane skip reason read as a
corpus-wide fate. The figure is withdrawn, and recorded here rather than quietly replaced.

### What the cross-lane residue actually is

265 paths are `no_tier_match` on all three USE lanes. **Zero are rules.** They are loom-side
source trees the enrichment steps copy FROM, not artifacts awaiting distribution:
`.claude/cross-repo-authz` 195 (operator receipts — `target_owned`, deliberately never shipped) ·
`.claude/bin` 21 · `.claude/dev-container-templates` 21 · `.claude/codex-mcp-guard` 9 ·
`.claude/gemini-templates` 6 · `.claude/codex-templates` 5 · the rest singletons.

Because the invariant is held, the clause ships as **contract only** — no corpus-wide gate is armed
and none is owed as a defect backlog. Arming one later is a clean extension; it is not remediation.

One instance WAS in budget and was fixed rather than filed
(`autonomous-execution.md` MUST-4): `.claude/bin/check-owned-surfaces.mjs` — the gate shipped with
this very clause — classified `skip/no_tier_match` on every lane while its sibling
`check-rule-injection-budget.mjs` classified `skip/loom_only`. It is now declared in `loom_only:`
and re-measured `skip/loom_only`. That is the clause working on its own author.

## E3 Reframe — The specs/01 §4 Mis-filing

The workspace spec `specs/01 §4` mis-filed "never edits the template directly" under the **business-consultant's** Class-C row — reading a distribution-mechanics fact as a role restriction. The fact is **Class A**: editing a template directly is non-durable for EVERYONE (a platform-engineer's direct edit is rebuilt away exactly as a consultant's is). The consultant is **NOT forbidden from improving templates** — they are forbidden a NON-DURABLE mechanism (direct edit) and granted a DURABLE one (the Step-7c PR to the inbox, § "Consultant Dual-Route Self-Serve (D4)"), which writes the proposal QUEUE, not the rebuilt artifacts.

## The Origination Taxonomy O1 — The Compliance-Origination Class

**O1 — the compliance-origination class.** An organization's regulations / standards / frameworks become COC artifacts (rules / skills / agents) when a **platform-engineer authors them DIRECTLY at loom against that EXTERNAL authority** — the ONE legitimate loom-direct origination lane for compliance content; the methodology home is `specs/methodology/` (`specs-authority.md`; platform-engineer owns it, `specs/06 §4`). It generalizes the Co-Owner-Directed carve-out by SUBSTITUTING the audit-trail source: the trail is the **external standard itself** plus the receipt that cites it, not a verbatim co-owner directive.

## Consultant Dual-Route Self-Serve (D4) — Role Framing And The Two Lanes

A **business-consultant** (the role that builds products on use-templates and SIGNALS capability gaps — `multi-operator-coordination.md` §1 `business_roles`) operates at a `coc-project` consumer and MUST be able to act on EVERY `/codify` finding WITHOUT talking to an engineer. Findings split into two TYPEs routing to two DIFFERENT lanes — the **dual-route**; both lanes already exist as the manual routes above, and the consultant-facing contract is that ONE `/codify` covers both, async and human-gated, with no synchronous engineer hand-off:

## Ecosystem Forks vs Downstream Consumers — The Fork Definition

The four repo classes above describe ONE ecosystem (canon). At scale, canon coexists with **client ecosystem forks**: a client copies the ENTIRE loom ↔ build ↔ use ecosystem, syncs **upstream-only** from canon, develops **independently**, and decides per-update whether to **roll a canon change in** — a gated upstream-pull, never an auto-merge. An ecosystem fork is NOT a **downstream consumer** (§ Downstream-Consumer Routing): a downstream consumer pulls COC artifacts FROM a USE template WITHIN one ecosystem, whereas a fork is a parallel MIRROR ecosystem with its own canon-relationship AND its own internal downstream consumers.

## Exact Gate-1/Gate-2 Tracking MUST-2 — Why The Receipt And Its Scrub

**Why:** Without a per-op receipt, a distribution's exact file-set and provenance live only in session memory and evaporate at the context boundary; the receipt is the durable, greppable record of what landed where — the same audit trail the proposal-lifecycle provenance provides for ingest. The scrub is required because the receipt is committed to loom's journal (a synced/publishable surface) while two of its fields — the `pr_url` slug and the absolute `worktree` path — carry a private-org identifier and an operator home path.

## Owned-Surface Bound — Wiring Scope Note (full)

Applies to the **two clauses immediately above** ONLY (added 2026-08-16). Per `trust-posture.md` MUST-8 grandfather cutoff they land AT/AFTER the MUST-8 SHA and ship canonical-8-field-compliant; the pre-existing grandfathered sections of this file, and the two clause-scoped Wiring blocks under § Exact Gate-1 / Gate-2 Tracking, stay on their own wiring until each is itself `/codify`-touched (clause-scoped precedent: `security.md` § Enforcement-Surface Parity, `git.md` § CI-check/merge).

## The Origination Taxonomy O1 — Ecosystem Scope

**Ecosystem scope:** in a client ecosystem fork, an O1 artifact citing a **tenant-specific (non-public) authority** is ecosystem-private — it MUST NOT ride a canon upstream-pull (the fork→canon MUST NOT, § Ecosystem Forks vs Downstream Consumers). Only public external authorities (ISO / SOC 2 / GDPR / etc.) are ecosystem-neutral.

## Co-Owner-Directed Origination — The Three Conditions, Elaborated

1. **Verbatim directive** — the co-owner's instruction is quoted verbatim in the journal `DECISION` entry (not paraphrased, not inferred from assent).
2. **Receipt-before-edit** — the journal entry is written and committed-or-staged BEFORE the first artifact edit; the entry is the provenance, not a post-hoc rationalization.
3. **COC-tooling scope only** — the artifact is COC tooling (a command / skill / agent / rule / `.claude/bin` validator under loom's own surface). CC/CO methodology changes still route to `atelier/` via `/sync-to-coc`; SDK code still routes to a BUILD repo. This exception does NOT widen those lanes.

## Canon Neutrality — Why (full)

**Why:** Canon is a multi-tenant-shared surface; coupling its roadmap to one tenant's internal governance both stalls every other tenant and silently imports tenant-specific concerns into the neutral substrate. The name-vs-coupling distinction is load-bearing because a disclosure scrub (the visible, tooled fence) can pass while the architectural coupling (the invisible one) ships unfixed.
