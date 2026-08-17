---
id: "ARTIFACT-FLOW"
paths: [".claude/**", "sync-manifest.yaml", "**/VERSION"]
---

# Artifact Flow Rules

See `.claude/guides/rule-extracts/artifact-flow.md` for the full BLOCKED-rationalization corpora, per-clause Origin narratives, and implementation-depth walkthroughs.

## Authority Chain

- **atelier/** — CC + CO authority (methodology, base rules, guides)
- **loom/** — COC authority (SDK agents, specialists, variant system); central splitter/distributor, does NOT originate

Flow diagram (issue routed by change TYPE → the three origination lanes → loom SPLITTER → the two outbound paths → downstream pull), with the four ❌ anti-patterns it annotates: companion § Authority Chain — Flow Diagram. The same diagram heads `CLAUDE.md` § Architecture, which is always loaded.

USE-template `/codify` proposal origination is the authoritative target flow for COC-artifact improvements. See `guides/co-setup/09-proposal-protocol.md` Step 7b for the manifest contract.

### Repo Classes Map 1:1 To Resolver Logical Keys

The four repo classes bind one-to-one to `bin/lib/loom-links.mjs` logical keys, and cross-repo tooling resolves every target through that resolver — never a positional `~/repos/<name>` / `../<name>` guess (`repo-scope-discipline.md` § MUST NOT). `sync-manifest.yaml::repos.<target>` still owns the logical NAME + tier membership. Full key mapping: companion § Repo Classes ↔ Resolver Logical Keys — Full Mapping.

**Canonical sublayout hint (F61) — a HINT, never a MUST.** Any layout is supported; the recommended one and its explicit non-enforcement disposition: companion § Canonical Sublayout Hint (F61).

### Ecosystem Forks vs Downstream Consumers

The four repo classes above describe ONE ecosystem (canon). At scale canon coexists with **client ecosystem forks** — a client copies the ENTIRE loom ↔ build ↔ use ecosystem, syncs **upstream-only**, develops **independently**, and decides per-update whether to roll a canon change in (a gated pull, never an auto-merge). A fork is NOT a **downstream consumer**, which pulls artifacts from a USE template WITHIN one ecosystem. Full definition, and why conflating them is a routing error: companion § Ecosystem Forks vs Downstream Consumers — The Fork Definition.

**Cascade is scoped to the ecosystem.** WITHIN one ecosystem every improvement reaches every member project via Gate-1 classification + each project's own pull cadence (never an auto-push). ACROSS ecosystems there is NO automatic cascade: a fork SEES canon and DECIDES per change (the gated upstream-pull; auto-merge BLOCKED), and never pushes identity or work back. Disclosure is isolated **bidirectionally** at the boundary — no ceremony, sync, deploy or publish may carry one ecosystem's identity into another's committed/shared/public surface. Any cross-ecosystem pull MUST route its surface through the SAME Gate-1 Intake Disclosure Scrub (§ below) — a scrubbed INTAKE, never a trusted merge. The fork→canon direction is a MUST NOT (below). Which fences hold this TODAY vs which are DORMANT/DEFERRED, with the full status walkthrough: companion § Ecosystem Forks — Cross-Ecosystem Disclosure-Guard Implementation Status.

**Why:** The unscoped "every improvement cascades to ALL projects" promise conflicts with fork-independence — a client that develops independently cannot also receive canon's every change automatically. Scoping cascade to the ecosystem (intra = reaches-all-via-classify+pull; cross = gated upstream-pull the fork controls) resolves the conflict and is the load-bearing distinction the multi-ecosystem model rests on.

**The source of instantiation MUST be clean at rest.** Any repo a client or downstream operator instantiates FROM MUST carry no canon trust-identity at rest — a clone inherits it in its initial commit and object history. The structural fix is SOURCE-PREVENTION: instantiate from a pre-scrubbed client-template edition (`scripts/publish-to-private-template.mjs`), never from a live canon clone; `clean-instantiate.mjs` is a detect-and-remediate backstop, NOT the fence. Which identity surfaces, and why post-hoc cleanup cannot suffice: companion § Instantiation-Is-A-Publish — Source-Clean-At-Rest Mechanics.

**Why:** Instantiation IS a publish — handing a client a template repo is the same disclosure event `publish-to-public.mjs` and the Gate-1/Gate-2 fences already gate for sync/deploy/publish; the template surface is a fourth publish path the same bidirectional-isolation invariant must cover, or a client's very first commit carries canon's identity forward.

### Canon Neutrality — A Tenant-Specific Gate Never Gates A Canon Build

A **canon** mechanism is tenant-neutral by construction (§ "Ecosystem Forks vs Downstream Consumers" above). A **tenant-specific decision or gate** — a works-council co-determination, a customer sign-off, a tenant legal/compliance approval — belongs to ONE tenant's internal governance. The two MUST NOT be coupled.

- **A tenant-specific decision/gate MUST NOT gate a tenant-neutral canon build.** Making a canon mechanism's roadmap wait on one tenant's works-council / legal / sign-off process couples canon to that tenant's internal governance — a canon-neutrality violation that also stalls every OTHER tenant. Canon builds proceed; the tenant gate lives at the fork.
- **Canon mechanisms are policy/granularity-AGNOSTIC.** Canon emits the maximally-accountable / most-general form and treats tenant-specific narrowing (coarsening, granularity, policy selection) as a CONFIGURABLE DOWNSTREAM operation. The tenant-specific policy + its legal gates live at the FORK / compliance lane (§ Ecosystem Forks + § The Origination Taxonomy O1 ecosystem-scope), NEVER baked into a canon build.
- **Scrubbing a tenant NAME does NOT fix a tenant-COUPLING.** DISTINCT failure modes: a leaked identifier is a DISCLOSURE leak (fixed by genericizing the token — the Intake / publish scrubs); a tenant-specific gate/decision embedded in a canon artifact is an ARCHITECTURAL coupling (fixed by RELOCATING the gate to the fork). A session may fix the first and silently propagate the second — the name-scrub reads as "handled" while the coupling ships.
- **Behavioral corollary (MUST):** when an external / human gate appears on a canon mechanism, the agent MUST question whether the gate belongs at canon AT ALL — not defer to it as a given. Treating a mis-placed tenant gate as an `autonomous-execution.md` "human-authority gate" and deferring to it is how the coupling propagates.

```text
# DO — the tenant gate lives at the fork; canon builds agnostic
Canon compiles granularity-AGNOSTIC (emits maximally-accountable; coarsening is a
downstream knob); the tenant's works-council co-determination applies in the fork lane.
No canon wave waits on the works-council decision.

# DO NOT — a tenant gate blocks a canon build
"Canon Wave 1 is BLOCKED until the tenant's works-council confirms the granularity."
(couples a canon build to one tenant's governance; scrubbing the NAME does not fix it —
the GATE is the coupling)
```

**Why:** Canon is a multi-tenant-shared surface; coupling its roadmap to one tenant's governance stalls every other tenant and imports tenant-specific concerns into the neutral substrate. The name-vs-coupling distinction is load-bearing: the tooled disclosure scrub can PASS while the architectural coupling ships unfixed. Full reasoning: companion § Canon Neutrality — Why (full).

**BLOCKED rationalizations:** see `.claude/guides/rule-extracts/artifact-flow.md` § Canon Neutrality — BLOCKED Rationalizations.

Origin: 2026-07-13 — co-owner-directed origination (`journal/0478`); #411 DECISION-1's canon-Wave-1 works-council HARD GATE re-scoped to the fork/csq lane after #1000 scrubbed the NAME but propagated the gate. Full narrative in the companion § Canon Neutrality — Origin.

**Trust Posture Wiring (Canon-Neutrality — A Tenant Gate Never Gates A Canon Build):**

Applies to the **Canon Neutrality** clause (added 2026-07-13). Per `trust-posture.md` MUST-8 grandfather cutoff, this clause lands AT/AFTER the MUST-8 SHA and MUST ship canonical-8-field-compliant; the pre-existing grandfathered sections of this file remain exempt until each is itself `/codify`-touched (the clause-scoped precedent set by `security.md` § Enforcement-Surface Parity + `git.md` § CI-check/merge).

- **Severity:** `halt-and-report` at gate-review (reviewer / cc-architect confirm no tenant-specific gate blocks a canon build, and that any tenant-name scrub was NOT treated as fixing an architectural tenant-coupling); `advisory` at the hook layer (whether a gate is tenant-specific-gating-canon is judgment-bearing per `hook-output-discipline.md` MUST-2 — no structural tool-call signal).
- **Grace period:** 7 days from clause landing (2026-07-13 → 2026-07-20).
- **Cumulative posture impact:** same-class violations (a tenant-specific gate coupling a canon build, OR a tenant-name scrub treated as fixing a tenant-coupling) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key (a canon-neutrality property is review-layer-only + semantic; minting a key would drag `trust-posture.md`, a self-referential-codify allowlist file, into a self-ref edit; the universal trigger already covers it). Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8 — the same no-dedicated-key disposition `security.md` § Enforcement-Surface Parity and `git.md` § CI-check/merge took.
- **Receipt requirement:** SessionStart soft-gate `[ack: artifact-flow]` IFF `posture.json::pending_verification` includes the `artifact-flow` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer / cc-architect inspect any session authoring or editing a canon artifact for a tenant-specific gate (works-council / customer sign-off / tenant legal approval) framed as blocking a canon wave/build, and confirm any tenant-name scrub was paired with a check that the underlying gate is not architecturally coupling canon. Probes `.claude/test-harness/probes/artifact-flow.probes.json` — NOT YET AUTHORED, declared in `phase2-deferrals.json::probe_authorship_deferrals`. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — no hook detector; audit fixtures land with the Phase-2 detector at `.claude/audit-fixtures/canon-neutrality/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** the Canon-Neutrality clause ONLY (clause-scoped); pre-existing grandfathered `artifact-flow.md` sections stay exempt until each is itself `/codify`-touched.
- **Origin:** See the clause's Origin (`journal/0478` co-owner-directed origination) + the #411 DECISION-1 re-scope (#1002).

### Issue Routing By Change Type

Every artifact-or-code issue MUST be routed by the TYPE of change it requests, not by which repo is convenient:

- **COC-artifact improvement** (method, rules, skills, agents, COC-tooling) → file the issue against the **USE-template repo** (`kailash-coc-*`); it originates a proposal via `/codify` per `guides/co-setup/09-proposal-protocol.md` Step 7b.
- **Bug / code / feature / code-improvement** (SDK code) → file the issue against the **BUILD repo**; it considers **cross-SDK FIRST**, then originates a proposal via `/codify`.

```
# DO — route by change type
COC method/rule/skill/agent fix  → issue on kailash-coc-* → /codify proposal
SDK code bug/feature             → issue on BUILD repo → cross-SDK-first → /codify proposal

# DO NOT — route by repo convenience
COC-method fix filed on the BUILD repo (code-only lane; bypasses Gate-1 split)
SDK-code bug filed on the USE-template repo (artifact lane; never reaches the SDK fix)
```

**Why:** Routing by repo convenience puts a COC-method fix onto a code-only lane (it never becomes an artifact proposal) or an SDK bug onto the artifact lane (it never reaches the code fix); either way the Gate-1 global-vs-variant split is bypassed and the change loses its provenance.

#### Downstream-Consumer Routing (.session-notes shorthand: Route A)

A **downstream consumer** is any repo that pulled COC artifacts FROM a USE template — this includes: end-user project repos, kaizen-cli-py, kz-engage, and every consumer of the canonical USE-template set (`kailash-coc-claude-py`, `kailash-coc-claude-rs`, `kailash-coc-py`, `kailash-coc-rs`; canonical enumeration per `sync-manifest.yaml::repos` + `guides/co-setup/09-proposal-protocol.md` Step 7b). Downstream consumers route COC-method improvements UP to the **USE template they pulled from** — NOT to their own project repo AND NOT to `loom` directly — via one of two paths:

- **Primary — Step 7c upflow (push-only, human-gated):** the consumer's OWN `/codify` Step 7c originates a COC-artifact proposal and offers it as a HUMAN-GATED PR to the template's `.claude/.proposals/inbox/<date>-<slug>.yaml` (`upstream-issue-hygiene.md` MUST-1). The template's `/sync-from-downstream` scrubs, reviews-as-data, dedups, and relays accepted entries into its OWN Step-7b manifest with hop-level provenance (`origin: downstream, via: <template-slug>` — never consumer-identifying), whence loom Gate-1 and the next `/sync-to-use`. Schema + relay mechanics: companion § Downstream-Consumer Routing — Step-7c Upflow Mechanics.
- **Fallback — Route A (issue on the template):** for no-fork-permission consumers and stale (pre-7c) consumers, file a COC-method issue against the USE template; the template's `/codify` originates the proposal per Step 7b. Route A is RETAINED but is the fallback, not the default.

```
# DO — downstream consumer routes UP to the USE template (primary: Step 7c PR to inbox)
kaizen-cli-py operator → /codify Step 7c offers a HUMAN-GATED PR to
  kailash-coc-claude-py/.claude/.proposals/inbox/; template /sync-from-downstream relays
  into its Step-7b manifest (hop-level provenance) → loom Gate-1 → /sync-to-use

# DO NOT — file against own repo (orphan; never reaches loom) OR against loom directly
kaizen-cli-py operator files COC-rule issue on kaizen-cli-py (a downstream consumer; it
  does NOT originate to loom) — or on loom/ (skips USE-template review; loom only splits)
# (full four-example DO/DO-NOT set → companion § Downstream-Consumer Routing — Full DO / DO-NOT Examples)
```

**Why:** Downstream-consumer issues filed against the consumer's own repo produce orphan proposals — the consumer's Step-7c manifest is push-only (never pulled by loom or the template), so an own-repo issue documents a problem nobody upstream sees; issues filed directly against loom bypass the USE-template-side review that catches variant-vs-global misclassification before it reaches every OTHER consumer. The USE template is the only repo class that originates proposals to loom, so routing every downstream-consumer change through it — Step-7c PR or Route-A issue — preserves the Gate-1 audit trail the splitter rule depends on.

**BLOCKED rationalizations:** see `.claude/guides/rule-extracts/artifact-flow.md` § Downstream-Consumer Routing — BLOCKED Rationalizations.

**Disclosure fence (scenario 8) — QUADRUPLE on the public-fork axis.** Four scrubs run before any public-fork exposure, and hop-level-only provenance means no consumer identity is carried even before they do: companion § Disclosure Fence (Scenario 8) — The Four Scrubs.

#### Consultant Dual-Route Self-Serve (D4)

A **business-consultant** operating at a `coc-project` consumer MUST be able to act on EVERY `/codify` finding WITHOUT talking to an engineer. Findings split by TYPE onto two EXISTING lanes — the **dual-route** — and the consultant-facing contract is that ONE `/codify` covers both, async and human-gated:

- **Artifact improvement** (method / rule / skill / agent / COC-tooling) → the **Step-7c upflow** (§ Downstream-Consumer Routing above): a LOCAL proposal manifest + a human-gated push-only PR to the template's `.claude/.proposals/inbox/`. **SHIPPED.**
- **Capability gap / bug** (a missing SDK capability the consultant worked around, or an SDK defect) → an **auto-drafted, human-gated BUILD issue** (§ Issue Routing By Change Type — cross-SDK-first), scrubbed per `upstream-issue-hygiene.md` MUST-1 (human gate before filing) + MUST-2/3 (downstream-context redaction + minimal-repro shape). BUILD turns the workaround into a real capability that cascades; the consumer migrates it on next start (the capability-gap lifecycle).

**Invariant (D4, RATIFIED — `decisions/00` DECISION-4):** the consultant **self-serves and NEVER talks to an engineer**; the PR / issue IS the async hand-off and the human gate at each lane (the consumer's own filing gate, the template-ingest review, BUILD's triage) is the trust gate. build/loom pick up async and cascade.

**Why:** Routing through an engineer for classification re-introduces the synchronous hand-off DECISION-4 removes — the consultant blocks on engineer availability and the engineer becomes a bottleneck for every product's signal. The dual-route lets ONE `/codify` cover both change-TYPEs async, with the per-lane human gate (not an engineer conversation) as the trust boundary.

```
# DO — one /codify, dual-routed by change TYPE, no engineer conversation
consultant /codify finding:
  artifact improvement → Step 7c PR to template inbox      (SHIPPED)
  capability gap / bug → human-gated BUILD issue (scrubbed) (Route B auto-draft — G3.4 SHIPPED W7b)

# DO NOT — consultant pings an engineer to classify or hand off
"let me ask the build engineer whether this is a bug or a capability"   # BLOCKED by D4
```

**The dual-route classifier (artifact vs capability vs bug) is SHIPPED (ECO-IMPL W7b)**, wired at `commands/codify.md` Step 7c, with the Layer-2 capability-vs-bug judgment deliberately left to the LLM + human gate (a dumb-lib split per `agent-reasoning.md`) — correct by design, NOT a gap. Full wiring: companion § Consultant Dual-Route Classifier — Shipped Implementation.

### loom Splits, Never Originates

loom MUST act only as the central splitter/distributor. It ingests proposals from the BUILD and USE-template streams via `/sync-from-build` + `/sync-from-use` (Gate 1), splits global vs variant (human classify), and distributes via `/sync-to-use` + `/sync-to-build`. loom MUST NOT originate an artifact change itself.

```
# DO — loom ingests an externally-originated proposal, splits, distributes
BUILD/USE-template /codify → proposal → loom Gate-1 classify → /sync-to-build + /sync-to-use

# DO NOT — loom authors a rule/skill/agent change with no upstream proposal
edit loom/.claude/rules/foo.md directly "to save a round-trip"
```

**Why:** A distributor that also originates has no upstream audit trail — the BUILD-repo or USE-template `/codify` proposal provenance is the only record of why an artifact changed; a loom-originated edit is unattributable and un-reviewable at Gate-1.

### Co-Owner-Directed Origination (narrow, receipt-gated exception)

loom MAY originate a COC-tooling artifact change directly WHEN the change is directed by a co-owner in-session AND a journal `DECISION` entry recording the directive lands BEFORE the edit. The journal entry IS the upstream audit trail the splitter rule otherwise requires. ALL THREE conditions MUST hold; missing any one → the change is an unattributable loom origination and is BLOCKED:

1. **Verbatim directive** — quoted verbatim in the journal `DECISION` entry, never paraphrased or inferred from assent.
2. **Receipt-before-edit** — the entry is committed-or-staged BEFORE the first artifact edit; it is the provenance, not a post-hoc rationalization.
3. **COC-tooling scope only** — CC/CO methodology still routes to `atelier/`, SDK code to a BUILD repo; this exception widens neither. Per-condition elaboration: companion § Co-Owner-Directed Origination — The Three Conditions, Elaborated.

```
# DO — co-owner directs a /wrapup change in-session; journal DECISION
# entry (verbatim directive) lands first, THEN the edit
journal/00NN-DECISION-...md  (verbatim co-owner quote)  →  edit .claude/commands/wrapup.md

# DO NOT — loom edits a rule citing "the co-owner would want this"
# (no in-session directive, no verbatim quote, no receipt-first journal)
edit loom/.claude/rules/foo.md  "co-owner implied it last week"
```

**BLOCKED rationalizations:** see `.claude/guides/rule-extracts/artifact-flow.md` § Co-Owner-Directed Origination — BLOCKED Rationalizations.

**Why:** Without the verbatim + receipt-first + scope conditions, "co-owner directed it" becomes a rubber-stamp that reopens the unattributable-origination failure mode the splitter rule closes; the three conditions keep the carve-out narrow — a real in-session directive with a durable, greppable provenance receipt is auditable at Gate-1 exactly as a `/codify` proposal is, and anything weaker is not. CC/CO scope is fenced because methodology drift from `atelier/` is a different, wider failure mode this exception MUST NOT touch.

Origin: 2026-05-18 — co-owner-directed `/wrapup` forest-ledger codification; 6-entry precedent chain, receipt journal/0095. Full narrative in the companion § Co-Owner-Directed Origination — Origin.

### The Origination Taxonomy — O1 (compliance), O2 (consultant upflow), O3 (BUILD)

Co-Owner-Directed Origination above is the FIRST loom-direct lane. It generalizes to a named **O1 compliance-origination class** (DECISION-7, RATIFIED — `decisions/00`; `specs/05 §1`, `specs/06 §4`). There are THREE legitimate origination paths, each carrying its own audit trail; `loom Splits, Never Originates` protects the AUDIT TRAIL, not the authorship location:

| #      | Origination path                                              | Who                 | Audit trail                                                                                                                       | Status                                   |
| ------ | ------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **O1** | Compliance/standard → artifact, authored **directly at loom** | platform-engineer   | receipt-first journal `DECISION` naming the **external authority** (regulation/standard/framework + version/clause) as provenance | named here (generalizes the carve-out)   |
| **O2** | Consultant artifact improvement → **upflow**                  | business-consultant | Step-7c proposal provenance (local manifest + inbox PR + relay), QUADRUPLE-fenced                                                 | SHIPPED (§ Downstream-Consumer Routing)  |
| **O3** | SDK capability / bug → **BUILD**                              | capability-engineer | BUILD `/codify` proposal, cross-SDK-first                                                                                         | SHIPPED (§ Issue Routing By Change Type) |

**O1 — the compliance-origination class.** An organization's regulations / standards / frameworks become COC artifacts when a **platform-engineer authors them DIRECTLY at loom against that EXTERNAL authority** — the one legitimate loom-direct origination lane, with methodology home `specs/methodology/`. It generalizes the Co-Owner-Directed carve-out by SUBSTITUTING the audit-trail source: the external standard plus the receipt citing it, in place of a verbatim directive. Full framing: companion § The Origination Taxonomy O1 — The Compliance-Origination Class.

**Enforcement is load-bearing — the citation must GOVERN, not merely EXIST.** The journal `DECISION` receipt MUST (a) cite the external authority down to the specific **version + clause/§**, AND (b) state in ONE sentence HOW that clause MANDATES the artifact's content. Both land BEFORE the edit. An uncited OR non-governing "compliance" edit is an unattributable loom origination and is BLOCKED; the other two carve-out conditions (receipt-before-edit + COC-tooling scope) still apply. Why a bare standard name is the agent-producible degenerate case: companion § The Origination Taxonomy O1 — Why The Citation Must Govern.

- **Detection mechanism:** two complementary layers — a mechanical SHAPE check (SHIPPED, `checkO1Citation`, at CLI-entrypoint time; LOUD + typed, `halt-and-report`/advisory per `hook-output-discipline.md` MUST-2, NEVER `severity:block`) and the LLM-judgment GOVERNANCE gate (the standing cc-architect review every `/codify` deploys). **NO HOOK LAYER — this clause claims none.** The SHAPE check COMPLEMENTS, never REPLACES, the judgment gate: a real standard whose clause does NOT govern the edit PASSES the shape check. Full two-layer mechanics + the governance-gate boundary + fixtures: companion § The Origination Taxonomy O1 — Detection Mechanics.

**Ecosystem scope:** an O1 artifact citing a **tenant-specific (non-public) authority** is ecosystem-private and MUST NOT ride a canon upstream-pull. Detail: companion § The Origination Taxonomy O1 — Ecosystem Scope.

```
# DO — O1: receipt cites version+clause AND states the derivation, BEFORE the edit
journal DECISION ("per ISO/IEC 27001:2022 §A.8.24 → this rule mandates env-var-only secrets")
  →  edit .claude/rules/<compliance-rule>.md  +  specs/methodology/ entry

# DO NOT — uncited OR a bare name whose clause does not govern
edit ... "standard best practice" (no cited authority); "per ISO 27001:2022" (no clause/derivation = loophole)
```

**Why:** Unlike a live co-owner directive (unfabricatable without the human present), a standard citation is agent-producible from training knowledge alone — so "a citation exists" is too weak: O1 must cite a SPECIFIC clause AND show that clause GOVERNS the artifact, the derivation the `/codify` cc-architect verifies by judgment. Drop the version/clause or the derivation and O1 collapses into the "to-save-a-round-trip" origination the splitter rule blocks; the taxonomy names all three lanes so an author picks by WHO originates and WHAT the audit trail is, never by convenience.

Origin: 2026-06-15 — ECO-CANON W4 (O1, C6); DECISION-7 RATIFIED (`decisions/00`); normative `specs/05 §1` + `specs/06 §4`. Full narrative in the companion § The Origination Taxonomy — Origin.

## BUILD Repo Rules

- `/codify` writes to BUILD repo's `.claude/` for immediate local use + creates `.claude/.proposals/latest.yaml`
- BUILD repo does NOT sync to any other repo directly
- USE-TEMPLATE repos (`kailash-coc-*`) MAY originate proposals for COC-artifact improvements only (authoritative target flow; manifest contract in `guides/co-setup/09-proposal-protocol.md` Step 7b); their downstream USE/project repos remain pull-only (`/codify` local, no manifest)

## Proposal Lifecycle

Proposals track artifact changes through a three-state lifecycle. Each originating direction — BUILD→loom (SDK code, cross-SDK-first), USE-template→loom (COC-artifact), downstream→USE-template (relayed up, Step 7c), loom→atelier (CC/CO) — follows the same lifecycle independently.

State-transition diagram (pending_review → reviewed → distributed, with the `/codify` append/reset/archive arcs): companion § Proposal Lifecycle — State Diagram. The normative behaviour is the table below.

| Status           | Meaning                                      | `/codify` behavior             | sync-family behavior            |
| ---------------- | -------------------------------------------- | ------------------------------ | ------------------------------- |
| `pending_review` | New changes, not yet classified at loom/     | **Append** new changes         | Gate 1: review and classify     |
| `reviewed`       | Classified but not yet distributed           | **Append** (resets to pending) | Gate 2: distribute to templates |
| `distributed`    | Fully processed — classified AND distributed | **Archive** and create fresh   | Skip (already processed)        |

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

Four directions: **BUILD → loom** (`/codify` Step 7, cross-SDK-first) · **USE-template → loom** (Step 7b, the authoritative COC-artifact flow) · **downstream → USE-template → loom** (Step 7c push-only inbox proposal, relayed with hop-level provenance) · **loom → atelier** (Step 8, CC/CO). Per-direction detail: companion § Applies to All Originating Directions — Per-Direction Detail.

## /sync-to-use Is the Only Outbound Path to Templates

Only `/sync-to-use` at loom/ may write to template repos. No other command or manual process.

**Why:** Multiple outbound paths create untracked divergence between templates, making it impossible to know which version of an artifact is authoritative.

## Human Classifies Every Change

Inbound changes from BUILD repos classified by human as:

- **Global** → `.claude/{type}/{file}` (all targets)
- **Variant** → `.claude/variants/{lang}/{type}/{file}` (one target)
- **Skip** → not upstreamed

Automated suggestions permitted; automated placement is not.

**Why:** A misclassified variant artifact pushed as global overwrites every target repo's language-specific behavior in a single sync.

## Intake Disclosure Scrub (Gate-1, before placement)

Every proposal ingested at Gate-1 — the manifest body AND the referenced BUILD/USE-template artifact files — MUST be disclosure-scrubbed BEFORE placement into `loom/.claude/`. Two mechanical actions run first: (a) `scan-synced-disclosure.mjs --check --root <inbound-repo-path>` over the candidate artifact files, and (b) a HUMAN scrub of the proposal body per `upstream-issue-hygiene.md` Rule 2. A non-zero exit OR any finding = HALT until genericized + relocated; placement does not proceed. The symmetric twin of the Gate-2 output fence (#263). Why the body half is human-gated and why `--root` cannot reach it: companion § Intake Disclosure Scrub — Mechanics.

```
# DO — scrub on intake, before placement
node .claude/bin/scan-synced-disclosure.mjs --check --root ../kailash-py   # artifact files
# + human reads .proposals/latest.yaml body for client/operator/3rd-party tokens
# → exit 0 AND body clean → classify + place into loom/.claude/

# DO NOT — place first, scrub at Gate-2
# (the disclosure is already in loom git history before Gate-2 ever runs)
```

**BLOCKED rationalizations:** see `.claude/guides/rule-extracts/artifact-flow.md` § Intake Disclosure Scrub — BLOCKED Rationalizations.

**Why:** Gate-1 placement enters loom git history BEFORE Gate-2 ever runs; a disclosure that lands at Gate-1 is already permanent and correlatable across 30+ downstream consumers — redaction-after is partial, the exact `upstream-issue-hygiene.md` Rule-1 failure mode.

Origin: 2026-05-17 — #263 forest-closure follow-up (symmetric intake twin of the Gate-2 output fence); receipts journal 0082 / 0083 / 0084.

**Trust Posture Wiring (Intake Disclosure Scrub):**

- **Severity:** `halt-and-report`. The scanner half is a structural exit-code signal, but the proposal-body half is a human-judgment gate — the composite clause carries `halt-and-report`, not `block` (per `hook-output-discipline.md` MUST-2: judgment-bearing gates do not carry block severity).
- **Grace period:** 7 days from this clause landing. During grace, a Gate-1 placement that proceeded without the two scrub actions logs to `violations.jsonl` for cumulative tracking; it does not auto-emergency-downgrade.
- **Regression-within-grace:** any same-class violation (Gate-1 placement of an un-scrubbed proposal) within 7 days = emergency downgrade per `trust-posture.md` MUST Rule 4 (`intake_scrub_bypass` added to the emergency-trigger list, 1× = drop 1 posture).
- **Receipt requirement:** SessionStart MUST require `[ack: intake-disclosure-scrub]` in the agent's first response IF `posture.json::pending_verification` includes this rule_id.
- **Detection:** the #263 `scan-synced-disclosure.mjs --check --root` invocation IS the mechanical detector for the artifact-file half; the sync-reviewer Gate-1 step-0 confirms the human body-scrub occurred. Final disposition is human. Enforcement activates with trust-posture Phase 2 (`/codify` wiring requirement); Phase 1 is observer + advisory.

## Exact Gate-1 / Gate-2 Tracking

Gate-2 distribution (`/sync-to-build`, `/sync-to-use`) MUST land through an ISOLATED worktree from the target's REMOTE main — never a write into the target's live local checkout — AND every Gate-1 ingest AND Gate-2 distribution MUST emit an exact-tracking receipt recording precisely what was done. Both halves are the collision-free, auditable distribution model Directive 1 ratified (`journal/0403`), superseding the working-tree-overlay handoff (`feedback_never_commit_downstream_repos`, retired).

### 1. Gate-2 Lands Via An Isolated Worktree From Remote Main — Never The Target's Live Checkout (MUST)

`/sync-to-build` AND `/sync-to-use` MUST drive `bin/sync-gate2-worktree.mjs`, which `git fetch`es the target's REMOTE main, creates an ISOLATED worktree checked out at `origin/main`, applies Gate-2 THERE (the `sync-tier-aware.mjs` engine `--out <worktree>` + the USE-lane enrichment), commits explicit paths on a `sync/<date>-loom-<lane>-<target>` branch, opens a PR, and removes the worktree. Writing Gate-2 output into the target BUILD/USE repo's LOCAL working tree is BLOCKED.

```
# DO — worktree from remote main → PR → gated merge (the dev's checkout is untouched)
node .claude/bin/sync-gate2-worktree.mjs --lane build --target rs             # apply + --verify + PR
node .claude/bin/sync-gate2-worktree.mjs --lane use --target <slug> --stage-only  # USE two-phase (enrich in-worktree, then --finalize)

# DO NOT — overlay onto the target's live local working tree
cp -r loom/.claude/* ../<build-repo>/.claude/   # collides with the dev's uncommitted work
```

**BLOCKED rationalizations:** see `.claude/guides/rule-extracts/artifact-flow.md` § Exact Gate-2 Worktree Landing — BLOCKED Rationalizations.

**Why:** A developer may be live in the target's local checkout, and a Gate-2 overlay silently collides with their uncommitted work — the stranded-overlay class (the pile of uncommitted `.claude/` files a prior overlay-model sync left in a local BUILD checkout, `journal/0403`). A worktree from `origin/main` is clean by construction and lands the change as a PR the dev pulls, so no live-checkout state is ever overwritten.

### 2. Every Gate-1 And Gate-2 Operation Emits An Exact-Tracking Receipt (MUST)

Every gate operation MUST emit a receipt recording EXACTLY what was done, through the same mechanism Shard-B's receipts use — a journal `DECISION` entry per gate op plus a signed coordination-log record via `coc-emit.js::emitSignedRecord` (`journal/0402`), on the `gate-op-receipt` fold type. Declaring a gate op complete without its receipt is BLOCKED. ONLY the committed journal `DECISION` embed MUST be scrubbed — via `sync-gate2-worktree.mjs::scrubReceiptForJournal` — BEFORE embedding, per MUST-2 below. Full receipt mechanics (the manifest FINGERPRINT vs inline arrays, the 2KB-cap-refusal #862 evidence, the per-field scrub set): companion § Exact Gate-1/Gate-2 Tracking MUST-2 — Receipt Mechanics.

- **Gate 1** (`/sync-from-build`, `/sync-from-use` ingest + classify): the source proposal, the per-change classification decision (global / variant / skip), the scrub result, and the per-file placement manifest.
- **Gate 2** (`/sync-to-build`, `/sync-to-use` distribute): the fields `bin/sync-gate2-worktree.mjs::buildReceipt` captures, per target. Before the receipt is embedded in the committed journal `DECISION` it MUST be scrubbed per `user-flow-validation.md` MUST-6 — the `pr_url` org/repo slug (private on a Rust BUILD lane) and the absolute `worktree` operator path are the scrub tokens. The per-target completeness table (`sync-completeness.md` MUST-2) is the Gate-2 receipt's verification companion. Full captured-field list: companion § Exact Gate-1/Gate-2 Tracking MUST-2 — Receipt Mechanics.

```
# DO — Gate-2 receipt records the exact manifest + provenance per target, scrubbed before embedding
# buildReceipt → {loom_sha, base_sha, target, branch, manifest{added,modified,deleted}, changed_count, pr_url, merge_sha, …gate, lane, worktree, timestamp}
# scrub pr_url slug + absolute worktree path before the journal DECISION embed (user-flow-validation.md MUST-6)

# DO NOT — "synced rs, looks good" with no per-file manifest or merge SHA; OR embed the raw worktree path / private pr_url slug unscrubbed
```

**Why:** Without a per-op receipt a distribution's exact file-set and provenance live only in session memory and evaporate at the context boundary; the receipt is the durable, greppable record of what landed where. The scrub is required because the receipt is committed to loom's journal — a synced/publishable surface — while two of its fields carry a private-org identifier and an operator home path. Full reasoning: companion § Exact Gate-1/Gate-2 Tracking MUST-2 — Why The Receipt And Its Scrub.

**Trust Posture Wiring (Exact Gate-1 / Gate-2 Tracking):**

- **Severity:** `halt-and-report` at gate-review (a worktree-vs-local-checkout landing and a receipt-presence property are judgment-bearing over the session's command history, not a single structural tool-call signal — per `hook-output-discipline.md` MUST-2 the hook layer stays `advisory`).
- **Grace period:** 7 days from this clause landing (2026-07-03 → 2026-07-10).
- **Cumulative posture impact:** same-class violations (a Gate-2 overlay into a live local checkout, OR a gate op declared complete without its exact-tracking receipt) contribute to `trust-posture.md` MUST Rule 4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** any same-class violation within 7 days routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST Rule 4 (1× = drop 1 posture) — no dedicated trigger key (a session-history judgment property does not warrant an instant-drop key, and minting one would drag `trust-posture.md`, a self-ref allowlist file, into a self-ref edit).
- **Receipt requirement:** SessionStart soft-gate `[ack: artifact-flow]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — cc-architect / reviewer inspects any session transcript that ran `/sync-to-build` or `/sync-to-use` and confirms (a) the distribution drove `.claude/bin/sync-gate2-worktree.mjs` (never a raw overlay into the target checkout) and (b) each gate op emitted its journal `DECISION` + coordination-log receipt. The `sync-reviewer` Gate-1 step confirms the ingest half. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — no hook detector; audit fixtures land with the Phase-2 detector at `.claude/audit-fixtures/exact-gate-tracking/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST 1 (worktree-from-remote-main landing) + MUST 2 (exact-tracking receipt per gate op).
- **Origin:** Directive 1 co-owner-directed origination (`journal/0403`); see § Origin.

**Trust Posture Wiring (Instantiation-Is-A-Publish / Source-Clean-At-Rest):**

Applies to the **"The source of instantiation MUST be clean at rest"** clause (added 2026-07-10, F7 A1). Per `trust-posture.md` MUST-8 grandfather cutoff, this clause lands AT/AFTER the MUST-8 SHA and MUST ship canonical-8-field-compliant; the pre-existing grandfathered sections of this file remain exempt until each is itself `/codify`-touched (the clause-scoped precedent set by `rule-authoring.md`'s own Wiring section + `security.md` § Enforcement-Surface Parity + `git.md` § CI-check/merge).

- **Severity:** `halt-and-report` at gate-review (reviewer / cc-architect + security-reviewer confirm a client-template instantiation source is clean-at-rest — i.e. instantiated from the pre-scrubbed template edition, not a live canon clone); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 (the "clean at rest" property is judgment-bearing, no structural tool-call signal).
- **Grace period:** 7 days from clause landing (2026-07-10 → 2026-07-17).
- **Cumulative posture impact:** same-class violations (instantiating a client ecosystem from a source carrying canon trust-identity at rest) contribute to `trust-posture.md` MUST Rule 4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key (minting one would drag `trust-posture.md`, a self-referential-codify allowlist file, into a self-ref edit; the universal `regression_within_grace` trigger already covers it). Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8 — the same no-dedicated-key disposition `security.md` § Enforcement-Surface Parity and `git.md` § CI-check/merge took.
- **Receipt requirement:** SessionStart soft-gate `[ack: artifact-flow]` IFF `posture.json::pending_verification` includes the `artifact-flow` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — the ENFORCEMENT surface is ALREADY SHIPPED: `.claude/bin/clean-instantiate.mjs`'s fail-closed assert-zero gate (`assertZero`) + `scripts/publish-to-private-template.mjs`'s pre-push completeness gate; cc-architect/security-reviewer confirm a client-instantiation session used the pre-scrubbed template path (not a live canon clone) and that the assert-zero gate exited 0. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — no new hook detector; audit fixtures for the assert-zero gate already exist in the sibling shard's test file.
- **Violation scope:** the Instantiation-Is-A-Publish / source-clean-at-rest clause ONLY (clause-scoped); the pre-existing grandfathered `artifact-flow.md` sections stay exempt until each is itself `/codify`-touched.
- **Origin:** loom epic #895 (F7 A1); the clause reifies the "instantiation is a publish" principle from #886 with its enforcement in `clean-instantiate.mjs` / `publish-to-private-template.mjs`.

## Variant Overlay Semantics

- **Replacement**: variant exists + global exists → variant wins
- **Addition**: variant exists, no global → added
- **Global only**: no variant → global used as-is

## Distribution-Durability Invariants

Three orthogonal questions gate whether an artifact write is permitted AND survives to every consumer. Collapsing them into one "permission" axis is the **E3 conflation** — it invents posture values ("owner/senior posture" / "standard posture") that exist in neither the L1–L5 ladder (`rules/trust-posture.md`) nor the roster (`rules/multi-operator-coordination.md` §1). Keep the three classes distinct:

| Class                                     | Answers                                                   | Keyed on                                                     | Varies by role? | Varies by posture? |
| ----------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------ | --------------- | ------------------ |
| **A — Distribution-durability invariant** | "Will this write survive the pipeline?"                   | distribution mechanics (this section)                        | NO              | NO                 |
| **B — Posture-gated permission**          | "Has this operator earned the trust to act unilaterally?" | trust-posture L1–L5 (`rules/trust-posture.md`)               | NO              | YES                |
| **C — Role-scoped capability**            | "Is this within this operator's job?"                     | `business_roles` (`rules/multi-operator-coordination.md` §1) | YES             | NO                 |

**Composition:** `write permitted-and-durable = role_scopes_it (C) AND posture_unlocks_it (B) AND pipeline_preserves_it (A)` — **conjunctive AND independent**. Naming WHICH of the three blocked (or will silently revert) a write is the whole point of keeping them separate: companion § Distribution-Durability Invariants — Composition.

**Class A is OWNED here; B and C are REFERENCED, not restated** (`specs-authority.md` Rule 9 — no parallel source of truth). **Class B** lives in `rules/trust-posture.md`; **Class C** in `rules/multi-operator-coordination.md` §1. Which surfaces own which: companion § Distribution-Durability Invariants — Where Classes B and C Live.

### The Class-A members (test: "does this write survive the pipeline, regardless of who wrote it?")

A Class-A invariant is a distribution-mechanics fact — **role-blind AND posture-blind**. No role scopes around it; no posture unlocks it. The six members: loom Splits Never Originates · `/sync-to-use` is the only outbound path to templates · editing a template `.claude/` directly is rebuilt away · BUILD→BUILD direct sync bypasses classification · human classifies every change (automated placement BLOCKED) · loom writes only within a declared owned surface (§ The Owned-Surface Bound). Each is already a MUST / MUST-NOT clause elsewhere in this rule, collected here as the named cross-cutting class; per-member survival rationale: companion § Class-A Members — Full Enumeration.

### The consultant's edit-ban is Class A, NOT a consultant Class-C restriction (the E3 reframe)

The workspace spec `specs/01 §4` mis-filed the consultant's template edit-ban under **Class C** (a role restriction). It is **Class A**: a direct template edit is non-durable for EVERYONE. The consultant is NOT forbidden from improving templates — they are forbidden a NON-DURABLE mechanism and granted a DURABLE one (the Step-7c inbox PR). The mis-filing and its consequence: companion § E3 Reframe — The specs/01 §4 Mis-filing.

|                                     | Surface                     | Durable?                      | Class                                |
| ----------------------------------- | --------------------------- | ----------------------------- | ------------------------------------ |
| Edit a template `.claude/` directly | template artifact files     | NO (`/sync-to-use` rebuilds)  | **A blocks it** (role-blind)         |
| Step-7c proposal PR to the inbox    | `.claude/.proposals/inbox/` | YES (ingested, never rebuilt) | **C** business-consultant capability |

This is **Class-A-routing of a Class-C capability** (same shape as the capability-engineer authoring at BUILD, not direct-at-loom, § The Origination Taxonomy O3): the role HAS the capability; Class A routes it onto the DURABLE mechanism.

**Why:** Filing a distribution-mechanics fact as a role restriction falsely tells a consultant they may not improve templates and removes their most autonomous lane (D4 self-serve); a role-scoped (C) + posture-unlocked (B) write still MUST clear Class A. Full E3-reframe reasoning: see `.claude/guides/rule-extracts/artifact-flow.md` § E3 Reframe — Consultant Edit-Ban Is Class A.

### The Owned-Surface Bound — what a sync may ADD (Class-A member 6, MUST)

loom writes at a target ONLY within the surfaces declared at `sync-manifest.yaml::owned_surfaces` — the list lives THERE and is never restated here (`specs-authority.md` Rule 9). A write to an undeclared path is BLOCKED, and **adding a surface is a CONTRACT change, not a manifest edit**: the entry lands with this clause's review. Every surface outside `.claude/**` MUST carry `opt_in: true` plus an `election:` naming the key the target's opt-in is READ FROM — **default OFF**; `opt_in: false` is permitted for `.claude/**` alone.

```
# DO — declare the surface, default OFF, election named, THEN write it
owned_surfaces: - surface: <path>  opt_in: true  election: <the manifest key that gates it>
# DO NOT — widen by adding a glob and let the mechanism BE the contract
tiers: [..., ".github/workflows/**"]   # now ships to every consumer; nothing declared it
```

**BLOCKED rationalizations:** "it's just another glob in `tiers:`" / "consumers already treat everything loom sends as loom-owned" / "`.claude/**` set the precedent — same act, wider path" / "it's additive, nothing gets overwritten" / "the consumer can delete it if they don't want it" / "on-by-default is fine, the file is inert" / "declaring it is bureaucracy — the manifest already says what ships" / "we'll make it opt-in once someone objects" / "the surface is already there, so this one is grandfathered".

**Why:** OVERWRITE and PRESERVE were each written down because an incident forced it; ADD never had one, because until now every addition landed inside `.claude/`, which consumers read as loom-owned by convention. That left the bound purely MECHANICAL — whatever globs happened to sit in `tiers:` + ALWAYS_INCLUDE — so a surface widened by editing a data file rather than by changing a contract, and no reviewer was ever asked. The silence is survivable while the surface is inert and stops being survivable at the first EXECUTABLE one: a workflow file loom writes is credentialed CI running code the consumer did not author, so a default-ON widening makes it LOOM's act rather than the consumer's.

### Target-Only Paths Are Preserved (MUST)

A path declared at `sync-manifest.yaml::target_owned:` belongs to the TARGET. `/sync-to-use` and `/sync-to-build` MUST NOT overwrite it, purge it, or report it as a `--verify` residual; its `publish:` mode (`committed` / `local_only`) governs whether the target commits it, and there is NO default. `obsoleted:` OVERRIDES preservation — an obsoletion entry overlapping a preserved path MUST carve the exemption against THIS clause, explicitly.

**Why:** Preservation stated only in manifest comments is invisible to the rule corpus that governs distribution — the same silence that left ADD ungoverned, one key over. The manifest cited `cross-repo.md` MUST Rule 4 ("Preserve Target-Only Files") for this until 2026-08-16; that rule NEVER existed, and a dangling citation is worse than none because it reads as a governed obligation while pointing at nothing (`spec-accuracy.md`).

### Trust Posture Wiring — Owned-Surface Bound + Target-Only Preservation

Applies to the **two clauses immediately above** ONLY (added 2026-08-16); ships canonical-8-field-compliant per `trust-posture.md` MUST-8. Every other section of this file stays on its own wiring until itself `/codify`-touched: companion § Owned-Surface Bound — Wiring Scope Note (full).

- **Severity:** `halt-and-report` at gate-review (cc-architect at `/codify` + reviewer at `/implement` confirm any change widening loom's write surface declared it in `owned_surfaces:` with `opt_in: true` + a real `election:`, and that no `target_owned:` path was overwritten or purged); `block` at the structural layer is carried by `check-owned-surfaces.mjs`, which fails the CI job — not by a hook, because a surface widening is a manifest/plan property with no tool-call-time signal (`hook-output-discipline.md` MUST-2).
- **Grace period:** 7 days from clause landing (2026-08-16 → 2026-08-23).
- **Cumulative posture impact:** same-class violations (a write to an undeclared surface; a non-`.claude` surface declared `opt_in: false`; an `opt_in: true` entry with no election; a `target_owned:` path overwritten or purged without an explicit `obsoleted:` exemption) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key. Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8 — the structural gate already refuses the violating state at CI, so the residual review-layer judgment does not warrant an instant-drop key. Full reasoning: companion § Owned-Surface Bound — Regression-Within-Grace Disposition (full reasoning).
- **Receipt requirement:** SessionStart soft-gate `[ack: artifact-flow]` IFF `posture.json::pending_verification` includes the `artifact-flow` rule_id (shared rule_id; one ack covers every clause in this file).
- **Detection mechanism:** structural + review, and the structural half SHIPS WITH THE CLAUSE. `.claude/bin/check-owned-surfaces.mjs` reds on four kinds — `undeclared-write-surface`, `undeclared-enrichment-surface`, `fail-open-default`, `election-missing` — over both USE lanes and every BUILD lane; its `--selftest` flag is the positive control, and it reports INERT rather than green when a mutation fails to apply. Bipolar poles at `.claude/audit-fixtures/owned-surface-bound/`, pinned by `.claude/test-harness/tests/check-owned-surfaces.test.mjs`; gate + suite are both wired into `.github/workflows/coc-artifact-eval.yml`. Review: cc-architect at `/codify` judges whether a NEW surface should exist at all, which no mechanical check can answer. Per-kind mechanics + the pole diff: companion § Owned-Surface Bound — Detection Mechanics.
- **Violation scope:** the § Owned-Surface Bound clause + the § Target-Only Paths Are Preserved clause ONLY (clause-scoped). Every `violations.jsonl` row names the surface and the lane it was measured on.
- **Origin:** See § Origin — 2026-08-16, co-owner-ratified D1/D2/D3/D4/D6.

## MUST NOT

- Read a tier match as a statement that an artifact is DISTRIBUTED. `loom_only` is tested at `classifyFile` step 2b, BEFORE tier inclusion at step 5, and `exclude` / `use_exclude` fence again after it. Every claim about what loom writes MUST come from a real `sync-tier-aware.mjs --dry-run --json` PLAN ACTION (`copy`/`overlay` vs a `skip` and its reason), never from glob membership.

**Why:** any other composition order OVER-REPORTS the distributed surface, so a contract derived from it declares surfaces loom does not write — and the enforcement then either encodes a fiction or reds on correct behaviour. Measured, base lane: companion § Composition Order — Measured Over-Report.

- Leave an artifact with NO positive fate. Every file under `.claude/` MUST resolve to shipped-on-a-tier, `loom_only`, or an explicit exclusion; "matches nothing" is an oversight indistinguishable from a decision and MUST NOT be relied on as a fence.

**Why:** absence from the shipped set would record no intent, leaving a deliberate loom-side tool indistinguishable from a file someone forgot to declare. **This invariant is currently HELD, and the clause exists to KEEP it held — it is prophylactic, not a live defect.** Measured 2026-08-16: 0 of 96 rules lack a declared tier. Note `skip/no_tier_match` does NOT mean undeclared. Measurement + that trap: companion § Positive Fate — The Invariant Is Held.

- Sync directly between BUILD repos — all paths through loom/

**Why:** Direct BUILD-to-BUILD sync bypasses classification and variant overlay, silently introducing language-specific artifacts into the wrong repo.

- Edit template repos directly — rebuilt entirely by `/sync-to-use`

**Why:** Manual template edits are overwritten on the next `/sync-to-use` run, wasting effort and creating false confidence that the change is permanent.

- Auto-classify global vs variant without human approval

**Why:** Automated classification lacks the domain judgment to distinguish a language-specific pattern from a universal one, risking silent overwrites across all targets.

- Push a client ecosystem fork's identity or work back to canon — the canon←→fork relationship is upstream-pull-only (a fork SEES canon via the gated pull; it never writes back)

**Why:** Canon is a multi-tenant-shared surface; a fork pushing its tenant identity (org slug, customer name, internal paths) or work into canon's committed/shared/public surface is correlatable across every other client — the cross-ecosystem disclosure leak the bidirectional-isolation invariant (§ "Ecosystem Forks vs Downstream Consumers") exists to block. The fence is `repo-scope-discipline.md`'s cross-repo-write prohibition + the `publish-to-public.mjs` allowlist; a fork→canon contribution lane, if ever wanted, is a net-new design that MUST reconcile with this isolation, not a default.

## Origin

See `.claude/guides/rule-extracts/artifact-flow.md` § Origin (full narrative) for the complete provenance chain. In brief: pre-2026-05-28 baseline + F63 + sync-upflow Wave 2a + ECO-CANON W4 (`journal/0289`) + ECO-IMPL W7c + Directive 1 (`journal/0403`); each dated with its scope in the companion.

**§ The Owned-Surface Bound + § Target-Only Paths Are Preserved — 2026-08-16, co-owner-ratified D1/D2/D3/D4/D6** ((loom-internal reference) Item 2). An OMISSION WITH A MECHANISM: overwrite and preserve were each written down because an incident forced it; add never had one. The retro-declaration is a MEASUREMENT from real plan actions, and it names twelve more surfaces than the referring analysis reported, two of whose claims it corrects. The paired positive-fate clause is PROPHYLACTIC — the invariant it names was measured HELD at landing (0 of 96 rules undeclared). Full narrative: companion § Owned-Surface Bound + Target-Only Preservation — Origin (full narrative).

**Length rationale (per `rules/rule-authoring.md` MUST NOT § "Rules longer than 200 lines").** Named rationale: **canonical-flow scope** — the rule codifies the complete artifact-distribution surface across 17 non-overlapping sections (full enumeration in the companion § "Length Rationale — Full 17-Section Enumeration"), each carrying invariants the artifact-flow contract requires holding simultaneously; splitting into sub-rules would fragment the canonical-flow surface across files and force cross-rule lookups for every routing decision. Per that MUST NOT the 200-line cap is guidance and overage is permitted with a named rationale anchored at Origin; the per-clause BLOCKED corpora, Origin narratives, and implementation-depth walkthroughs are now EXTRACTED to `.claude/guides/rule-extracts/artifact-flow.md` (the EXTRACT-not-NARROW companion) to hold the rule near budget. Sibling precedent: `multi-operator-coordination.md` + `user-flow-validation.md` length rationales.
