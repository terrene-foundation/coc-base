---
priority: 10
scope: path-scoped
paths:
  - ".claude/**"
  - "sync-manifest.yaml"
  - "**/VERSION"
---

# Artifact Flow Rules

See `.claude/guides/rule-extracts/artifact-flow.md` for the full BLOCKED-rationalization corpora, per-clause Origin narratives, and implementation-depth walkthroughs.

<!-- slot:neutral-body -->

## Authority Chain

- **atelier/** — CC + CO authority (methodology, base rules, guides)
- **loom/** — COC authority (SDK agents, specialists, variant system); central splitter/distributor, does NOT originate

USE-template `/codify` proposal origination is the authoritative target flow for COC-artifact improvements. See `guides/co-setup/09-proposal-protocol.md` Step 7b for the manifest contract.

Depth — the flow diagram and the four ❌ anti-patterns it annotates — lives in `.claude/guides/rule-extracts/artifact-flow.md` § Authority Chain — Flow Diagram. The same diagram heads `CLAUDE.md` § Architecture, which is always loaded.

### Repo Classes Map 1:1 To Resolver Logical Keys

The four repo classes bind one-to-one to `bin/lib/loom-links.mjs` logical keys, and cross-repo tooling resolves every target through that resolver — never a positional `~/repos/<name>` / `../<name>` guess (`repo-scope-discipline.md` § MUST NOT). `sync-manifest.yaml::repos.<target>` still owns the logical NAME + tier membership. The canonical sublayout (F61) is a HINT, never a MUST — any layout is supported.

Depth — the full key mapping and the sublayout hint's non-enforcement disposition — lives in `.claude/guides/rule-extracts/artifact-flow.md` § Repo Classes ↔ Resolver Logical Keys — Full Mapping and § Canonical Sublayout Hint (F61).

### Ecosystem Forks vs Downstream Consumers

The four repo classes above describe ONE ecosystem (canon). At scale canon coexists with **client ecosystem forks** — a client copies the ENTIRE loom ↔ build ↔ use ecosystem, syncs **upstream-only**, develops **independently**, and decides per-update whether to roll a canon change in (a gated pull, never an auto-merge). A fork is NOT a **downstream consumer**, which pulls from a USE template WITHIN one ecosystem.

**Cascade is scoped to the ecosystem.** WITHIN one ecosystem every improvement reaches every member project via Gate-1 classification + each project's own pull cadence (never an auto-push). ACROSS ecosystems there is NO automatic cascade: a fork SEES canon and DECIDES per change (the gated upstream-pull; auto-merge BLOCKED), and never pushes identity or work back. Disclosure is isolated **bidirectionally** at the boundary — no ceremony, sync, deploy or publish may carry one ecosystem's identity into another's committed/shared/public surface. Any cross-ecosystem pull MUST route its surface through the SAME Gate-1 Intake Disclosure Scrub (§ below) — a scrubbed INTAKE, never a trusted merge. The fork→canon direction is a MUST NOT (below).

**Why:** The unscoped "every improvement cascades to ALL projects" promise conflicts with fork-independence — a client that develops independently cannot also receive canon's every change automatically. Scoping cascade to the ecosystem (intra = reaches-all-via-classify+pull; cross = gated upstream-pull the fork controls) resolves the conflict.

**The source of instantiation MUST be clean at rest.** Any repo a client or downstream operator instantiates FROM MUST carry no canon trust-identity at rest — a clone inherits it in its initial commit and object history. The structural fix is SOURCE-PREVENTION: instantiate from a pre-scrubbed client-template edition (`scripts/publish-to-private-template.mjs`), never from a live canon clone; `clean-instantiate.mjs` is a detect-and-remediate backstop, NOT the fence.

**Why:** Instantiation IS a publish — handing a client a template repo is the same disclosure event `publish-to-public.mjs` and the Gate-1/Gate-2 fences already gate for sync/deploy/publish; the template surface is a fourth publish path the same bidirectional-isolation invariant must cover, or a client's very first commit carries canon's identity forward.

Depth — the fork definition, the cross-ecosystem disclosure-fence status, and which identity surfaces make post-hoc cleanup insufficient — lives in `.claude/guides/rule-extracts/artifact-flow.md` § Ecosystem Forks vs Downstream Consumers — The Fork Definition and the two sections following.

### Canon Neutrality — A Tenant-Specific Gate Never Gates A Canon Build

A **canon** mechanism is tenant-neutral by construction (§ "Ecosystem Forks vs Downstream Consumers" above). A **tenant-specific decision or gate** — a works-council co-determination, a customer sign-off, a tenant legal/compliance approval — belongs to ONE tenant's internal governance. The two MUST NOT be coupled.

- **A tenant-specific decision/gate MUST NOT gate a tenant-neutral canon build.** Making a canon mechanism's roadmap wait on one tenant's works-council / legal / sign-off process couples canon to that tenant's internal governance — a canon-neutrality violation that also stalls every OTHER tenant. Canon builds proceed; the tenant gate lives at the fork.
- **Canon mechanisms are policy/granularity-AGNOSTIC.** Canon emits the maximally-accountable / most-general form and treats tenant-specific narrowing (coarsening, granularity, policy selection) as a CONFIGURABLE DOWNSTREAM operation. The tenant-specific policy + its legal gates live at the FORK / compliance lane (§ Ecosystem Forks + § The Origination Taxonomy O1 ecosystem-scope), NEVER baked into a canon build.
- **Scrubbing a tenant NAME does NOT fix a tenant-COUPLING.** DISTINCT failure modes: a leaked identifier is a DISCLOSURE leak (fixed by genericizing the token — the Intake / publish scrubs); a tenant-specific gate/decision embedded in a canon artifact is an ARCHITECTURAL coupling (fixed by RELOCATING the gate to the fork). A session may fix the first and silently propagate the second.
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

Origin: 2026-07-13 — co-owner-directed origination (`journal/0478`). Full narrative: companion § Canon Neutrality — Origin.

**Trust Posture Wiring (Canon-Neutrality — A Tenant Gate Never Gates A Canon Build):**

Applies to the **Canon Neutrality** clause (added 2026-07-13); per `trust-posture.md` MUST-8 grandfather cutoff it lands AT/AFTER the MUST-8 SHA and MUST ship canonical-8-field-compliant. Grandfather scope + the clause-scoped precedent: companion § Wiring Grandfather Scope And Clause-Scoped Precedent.

- **Severity:** `halt-and-report` at gate-review (reviewer / cc-architect confirm no tenant-specific gate blocks a canon build, and that any tenant-name scrub was NOT treated as fixing an architectural tenant-coupling); `advisory` at the hook layer (whether a gate is tenant-specific-gating-canon is judgment-bearing per `hook-output-discipline.md` MUST-2 — no structural tool-call signal).
- **Grace period:** 7 days from clause landing (2026-07-13 → 2026-07-20).
- **Cumulative posture impact:** same-class violations (a tenant-specific gate coupling a canon build, OR a tenant-name scrub treated as fixing a tenant-coupling) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key; named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8.
- **Receipt requirement:** SessionStart soft-gate `[ack: artifact-flow]` IFF `posture.json::pending_verification` includes the `artifact-flow` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer / cc-architect inspect any session authoring or editing a canon artifact for a tenant-specific gate (works-council / customer sign-off / tenant legal approval) framed as blocking a canon wave/build, and confirm any tenant-name scrub was paired with a check that the underlying gate is not architecturally coupling canon. **Probes: REGISTERED — `.claude/test-harness/probes/artifact-flow.probes.json`** — one bipolar `pair_id` pair per covered clause (MUST-1 + MUST-2 of § Exact Gate-1 / Gate-2 Tracking · the MUST NOT section · § Canon Neutrality · § Intake Disclosure Scrub) plus a meta pair; read the row/pair counts off the suite, never off this line. Fixtures + `.expected` sidecars at `.claude/audit-fixtures/artifact-flow/`. **Phase 2 is RETIRED, not pending (2026-09-11): no hook detector will EVER be built**, and no fixtures are owed. The only mechanical signal — the tenant NAME — is disqualified by this clause's own text (`instrument-discipline.md` MUST-1, `hook-output-discipline.md` MUST-2), so booking one is the shape `rule-authoring.md` MUST NOT names. Gate-review plus the registered `canon-neutrality-firing` pair ARE the enforcement layers, permanently; rationale `phase2-deferrals.json` key `artifact-flow.md#canon-neutrality`.
- **Violation scope:** the Canon-Neutrality clause ONLY (clause-scoped); pre-existing grandfathered `artifact-flow.md` sections stay exempt until each is itself `/codify`-touched.
- **Origin:** See the clause's Origin (`journal/0478` co-owner-directed origination) + the #411 DECISION-1 re-scope (#1002).

Depth — the probe-registration semantics, the consumer-lane measurement, the pole diff and the regression-key reasoning — lives in `.claude/guides/rule-extracts/artifact-flow.md` § Canon Neutrality — Wiring Depth.

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

A **downstream consumer** is any repo that pulled COC artifacts FROM a USE template (enumeration: `sync-manifest.yaml::repos` + `guides/co-setup/09-proposal-protocol.md` Step 7b). It routes COC-method improvements UP to the **USE template it pulled from** — NOT to its own project repo AND NOT to `loom` directly — via one of two paths:

- **Primary — Step 7c upflow (push-only, human-gated):** the consumer's OWN `/codify` Step 7c originates a COC-artifact proposal and offers it as a HUMAN-GATED PR to the template's `.claude/.proposals/inbox/<date>-<slug>.yaml` (`upstream-issue-hygiene.md` MUST-1). The template's `/sync-from-downstream` scrubs, dedups and relays accepted entries into its OWN Step-7b manifest with hop-level provenance, whence loom Gate-1 and the next `/sync-to-use`. Schema + relay mechanics: companion § Downstream-Consumer Routing — Step-7c Upflow Mechanics.
- **Fallback — Route A (issue on the template):** for no-fork-permission and stale (pre-7c) consumers, file a COC-method issue against the USE template; the template's `/codify` originates the proposal per Step 7b. RETAINED as the fallback, not the default.

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

**Why:** An own-repo issue produces an orphan proposal nobody upstream sees (the consumer's Step-7c manifest is push-only), and one filed directly against loom bypasses the USE-template-side review that catches variant-vs-global misclassification. The USE template is the only repo class that originates proposals to loom, so routing every downstream-consumer change through it preserves the Gate-1 audit trail the splitter rule depends on.

**BLOCKED rationalizations:** see `.claude/guides/rule-extracts/artifact-flow.md` § Downstream-Consumer Routing — BLOCKED Rationalizations.

**Disclosure fence (scenario 8) — QUADRUPLE on the public-fork axis.** Four scrubs run before any public-fork exposure, and hop-level-only provenance carries no consumer identity even before they do: companion § Disclosure Fence (Scenario 8) — The Four Scrubs.

#### Consultant Dual-Route Self-Serve (D4)

A **business-consultant** operating at a `coc-project` consumer MUST be able to act on EVERY `/codify` finding WITHOUT talking to an engineer. Findings split by TYPE onto two EXISTING lanes — the **dual-route** — and the consultant-facing contract is that ONE `/codify` covers both, async and human-gated:

- **Artifact improvement** (method / rule / skill / agent / COC-tooling) → the **Step-7c upflow** (§ Downstream-Consumer Routing above): a LOCAL proposal manifest + a human-gated push-only PR to the template's `.claude/.proposals/inbox/`. **SHIPPED.**
- **Capability gap / bug** (a missing SDK capability the consultant worked around, or an SDK defect) → an **auto-drafted, human-gated BUILD issue** (§ Issue Routing By Change Type — cross-SDK-first), scrubbed per `upstream-issue-hygiene.md` MUST-1 (human gate before filing) + MUST-2/3 (downstream-context redaction + minimal-repro shape).

**Invariant (D4, RATIFIED — `decisions/00` DECISION-4):** the consultant **self-serves and NEVER talks to an engineer**; the PR / issue IS the async hand-off, and the human gate at each lane is the trust gate.

**Why:** Routing through an engineer for classification re-introduces the synchronous hand-off DECISION-4 removes — the consultant blocks on engineer availability and the engineer becomes a bottleneck for every product's signal. The dual-route lets ONE `/codify` cover both change-TYPEs async, with the per-lane human gate as the trust boundary.

```
# DO — one /codify, dual-routed by change TYPE, no engineer conversation
consultant /codify finding:
  artifact improvement → Step 7c PR to template inbox      (SHIPPED)
  capability gap / bug → human-gated BUILD issue (scrubbed) (Route B auto-draft — G3.4 SHIPPED W7b)

# DO NOT — consultant pings an engineer to classify or hand off
"let me ask the build engineer whether this is a bug or a capability"   # BLOCKED by D4
```

**The dual-route classifier is SHIPPED**, wired at `commands/codify.md` Step 7c; the Layer-2 capability-vs-bug judgment is left to the LLM + human gate, by design. Full wiring: companion § Consultant Dual-Route Classifier — Shipped Implementation.

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

**Why:** Without the verbatim + receipt-first + scope conditions, "co-owner directed it" becomes a rubber-stamp that reopens the unattributable-origination failure mode the splitter rule closes; the three conditions keep the carve-out auditable at Gate-1 exactly as a `/codify` proposal is. CC/CO scope is fenced because methodology drift from `atelier/` is a different, wider failure mode this exception MUST NOT touch.

Origin: 2026-05-18 — co-owner-directed `/wrapup` forest-ledger codification. Full narrative: companion § Co-Owner-Directed Origination — Origin.

### The Origination Taxonomy — O1 (compliance), O2 (consultant upflow), O3 (BUILD)

Co-Owner-Directed Origination above is the FIRST loom-direct lane, generalized as the **O1 compliance-origination class** (DECISION-7). THREE legitimate origination paths, each with its own audit trail; `loom Splits, Never Originates` protects the AUDIT TRAIL, not the authorship location:

- **O1** — compliance/standard → artifact, authored **directly at loom** by a **platform-engineer**; audit trail = a receipt-first journal `DECISION` naming the **external authority** (regulation/standard/framework + version/clause) as provenance.
- **O2** — consultant artifact improvement → **upflow**, by a **business-consultant**; audit trail = Step-7c proposal provenance (local manifest + inbox PR + relay), QUADRUPLE-fenced. SHIPPED (§ Downstream-Consumer Routing).
- **O3** — SDK capability / bug → **BUILD**, by a **capability-engineer**; audit trail = a BUILD `/codify` proposal, cross-SDK-first. SHIPPED (§ Issue Routing By Change Type).

**O1 — the compliance-origination class.** The one legitimate loom-direct origination lane; methodology home `specs/methodology/`. Full framing: companion § The Origination Taxonomy O1 — The Compliance-Origination Class.

**Enforcement is load-bearing — the citation must GOVERN, not merely EXIST.** The journal `DECISION` receipt MUST (a) cite the external authority down to the specific **version + clause/§**, AND (b) state in ONE sentence HOW that clause MANDATES the artifact's content. Both land BEFORE the edit. An uncited OR non-governing "compliance" edit is an unattributable loom origination and is BLOCKED; the other two carve-out conditions (receipt-before-edit + COC-tooling scope) still apply. Why a bare standard name is the agent-producible degenerate case: companion § The Origination Taxonomy O1 — Why The Citation Must Govern.

- **Detection mechanism:** two complementary layers — a mechanical SHAPE check (SHIPPED, `checkO1Citation`, at CLI-entrypoint time; LOUD + typed, `halt-and-report`/advisory per `hook-output-discipline.md` MUST-2, NEVER `severity:block`) and the LLM-judgment GOVERNANCE gate (the standing cc-architect review every `/codify` deploys). **NO HOOK LAYER — this clause claims none.** The SHAPE check COMPLEMENTS, never REPLACES, the judgment gate: a real standard whose clause does NOT govern the edit PASSES the shape check. Two-layer mechanics + fixtures: companion § The Origination Taxonomy O1 — Detection Mechanics.

**Ecosystem scope:** an O1 artifact citing a **tenant-specific (non-public) authority** is ecosystem-private and MUST NOT ride a canon upstream-pull. Detail: companion § The Origination Taxonomy O1 — Ecosystem Scope.

```
# DO — O1: receipt cites version+clause AND states the derivation, BEFORE the edit
journal DECISION ("per ISO/IEC 27001:2022 §A.8.24 → this rule mandates env-var-only secrets")
  →  edit .claude/rules/<compliance-rule>.md  +  specs/methodology/ entry

# DO NOT — uncited OR a bare name whose clause does not govern
edit ... "standard best practice" (no cited authority); "per ISO 27001:2022" (no clause/derivation = loophole)
```

**Why:** Unlike a live co-owner directive (unfabricatable without the human present), a standard citation is agent-producible from training knowledge alone — so "a citation exists" is too weak: O1 must cite a SPECIFIC clause AND show that clause GOVERNS the artifact. Drop the version/clause or the derivation and O1 collapses into the "to-save-a-round-trip" origination the splitter rule blocks.

Origin: 2026-06-15 — ECO-CANON W4 (O1, C6); normative `specs/05 §1` + `specs/06 §4`. Full narrative: companion § The Origination Taxonomy — Origin.

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

Every proposal ingested at Gate-1 — the manifest body AND the referenced BUILD/USE-template artifact files — MUST be disclosure-scrubbed BEFORE placement into `loom/.claude/`. Two mechanical actions run first: (a) `scan-synced-disclosure.mjs --check --root <inbound-repo-path>`, and (b) a HUMAN scrub of the proposal body per `upstream-issue-hygiene.md` Rule 2. A non-zero exit OR any finding = HALT until genericized + relocated; placement does not proceed. Why the body half is human-gated and why `--root` cannot reach it: companion § Intake Disclosure Scrub — Mechanics.

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

Origin: 2026-05-17 — #263 forest-closure follow-up; receipts journal 0082 / 0083 / 0084.

**Trust Posture Wiring (Intake Disclosure Scrub):**

- **Severity:** `halt-and-report`. The scanner half is a structural exit-code signal, but the proposal-body half is a human-judgment gate — the composite clause carries `halt-and-report`, not `block` (per `hook-output-discipline.md` MUST-2: judgment-bearing gates do not carry block severity).
- **Grace period:** 7 days from this clause landing; during grace a Gate-1 placement made without the two scrub actions logs to `violations.jsonl` for cumulative tracking only.
- **Regression-within-grace:** any same-class violation (Gate-1 placement of an un-scrubbed proposal) within 7 days = emergency downgrade per `trust-posture.md` MUST Rule 4, routed through the GENERIC `regression_within_grace` trigger (1× = drop 1 posture) — no dedicated key.
- **Receipt requirement:** SessionStart MUST require `[ack: intake-disclosure-scrub]` in the agent's first response IF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** the #263 `scan-synced-disclosure.mjs --check --root` invocation IS the mechanical detector for the artifact-file half; the sync-reviewer Gate-1 step-0 confirms the human body-scrub occurred. Final disposition is human. **This clause NO LONGER CHAINS to trust-posture's § Two-Phase Rollout, and its Phase 2 is RETIRED rather than pending (2026-09-13); no structural audit fixtures are owed.** The MECHANICAL half is SHIPPED AND ENFORCING, not awaiting a rollout (`.claude/bin/scan-synced-disclosure.mjs`, fixtures at `.claude/audit-fixtures/scan-synced-disclosure/`, wired into the sync/codify commands and the Gate-1/Gate-2 agents), so a Gate-1 placement cannot reach a distribution without it having run. The HUMAN half will never gain a detector — its only mechanizable proxy is the tenant NAME, which § Canon Neutrality already disqualifies as non-discriminating, so deferring it to a rollout gated on a condition nothing measures was booking teeth that cannot arrive, which `hook-output-discipline.md` MUST-5(b) forbids. **Gate-review, plus the shipped scanner, ARE the enforcement layers here, permanently.**

Depth — the fixture/command inventory, the registry-row reasoning, and why the separate `rollout` entry keeps its own date — lives in `.claude/guides/rule-extracts/artifact-flow.md` § Intake Disclosure Scrub — Detection Depth.

## Exact Gate-1 / Gate-2 Tracking

Gate-2 distribution (`/sync-to-build`, `/sync-to-use`) MUST land through an ISOLATED worktree from the target's REMOTE main — never a write into the target's live local checkout — AND every Gate-1 ingest AND Gate-2 distribution MUST emit an exact-tracking receipt recording precisely what was done. Both halves are the collision-free, auditable distribution model Directive 1 ratified (`journal/0403`).

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

**Why:** A developer may be live in the target's local checkout, and a Gate-2 overlay silently collides with their uncommitted work — the stranded-overlay class. A worktree from `origin/main` is clean by construction and lands the change as a PR the dev pulls, so no live-checkout state is ever overwritten.

### 2. Every Gate-1 And Gate-2 Operation Emits An Exact-Tracking Receipt (MUST)

Every gate operation MUST emit a receipt recording EXACTLY what was done — a journal `DECISION` entry per gate op plus a signed coordination-log record via `coc-emit.js::emitSignedRecord`, on the `gate-op-receipt` fold type. Declaring a gate op complete without its receipt is BLOCKED. ONLY the committed journal `DECISION` embed MUST be scrubbed — via `sync-gate2-worktree.mjs::scrubReceiptForJournal` — BEFORE embedding, per MUST-2 below. Full receipt mechanics: companion § Exact Gate-1/Gate-2 Tracking MUST-2 — Receipt Mechanics.

- **Gate 1** (`/sync-from-build`, `/sync-from-use` ingest + classify): the source proposal, the per-change classification decision (global / variant / skip), the scrub result, and the per-file placement manifest.
- **Gate 2** (`/sync-to-build`, `/sync-to-use` distribute): the fields `bin/sync-gate2-worktree.mjs::buildReceipt` captures, per target. Before the receipt is embedded in the committed journal `DECISION` it MUST be scrubbed per `user-flow-validation.md` MUST-6 — the `pr_url` org/repo slug and the absolute `worktree` operator path are the scrub tokens. The per-target completeness table (`sync-completeness.md` MUST-2) is its verification companion. Full captured-field list: companion § Exact Gate-1/Gate-2 Tracking MUST-2 — Receipt Mechanics.

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
- **Regression-within-grace:** GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST Rule 4 (1× = drop 1 posture) — no dedicated trigger key; named deviation per Rule 8 (reasoning: companion § Regression-Key Dispositions).
- **Receipt requirement:** SessionStart soft-gate `[ack: artifact-flow]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — cc-architect / reviewer inspects any session transcript that ran `/sync-to-build` or `/sync-to-use` and confirms (a) the distribution drove `.claude/bin/sync-gate2-worktree.mjs` and (b) each gate op emitted its journal `DECISION` + coordination-log receipt; the `sync-reviewer` Gate-1 step confirms the ingest half. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — no hook detector; audit fixtures land with the Phase-2 detector at `.claude/audit-fixtures/exact-gate-tracking/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST 1 (worktree-from-remote-main landing) + MUST 2 (exact-tracking receipt per gate op).
- **Origin:** Directive 1 co-owner-directed origination (`journal/0403`); see § Origin.

**Trust Posture Wiring (Instantiation-Is-A-Publish / Source-Clean-At-Rest):**

Applies to the **"The source of instantiation MUST be clean at rest"** clause (added 2026-07-10, F7 A1); per `trust-posture.md` MUST-8 grandfather cutoff it lands AT/AFTER the MUST-8 SHA and MUST ship canonical-8-field-compliant. Grandfather scope + precedent: companion § Wiring Grandfather Scope And Clause-Scoped Precedent.

- **Severity:** `halt-and-report` at gate-review (reviewer / cc-architect + security-reviewer confirm a client-template instantiation source is clean-at-rest — i.e. instantiated from the pre-scrubbed template edition, not a live canon clone); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 (the "clean at rest" property is judgment-bearing, no structural tool-call signal).
- **Grace period:** 7 days from clause landing (2026-07-10 → 2026-07-17).
- **Cumulative posture impact:** same-class violations (instantiating a client ecosystem from a source carrying canon trust-identity at rest) contribute to `trust-posture.md` MUST Rule 4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key; named deviation per `trust-posture.md` Rule 8 (reasoning: companion § Regression-Key Dispositions).
- **Receipt requirement:** SessionStart soft-gate `[ack: artifact-flow]` IFF `posture.json::pending_verification` includes the `artifact-flow` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — the ENFORCEMENT surface is ALREADY SHIPPED: `.claude/bin/clean-instantiate.mjs`'s fail-closed assert-zero gate (`assertZero`) + `scripts/publish-to-private-template.mjs`'s pre-push completeness gate; cc-architect/security-reviewer confirm a client-instantiation session used the pre-scrubbed template path and that the assert-zero gate exited 0. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — no new hook detector; audit fixtures for the assert-zero gate already exist in the sibling shard's test file.
- **Violation scope:** the Instantiation-Is-A-Publish / source-clean-at-rest clause ONLY (clause-scoped); grandfathered sections stay exempt until each is itself `/codify`-touched.
- **Origin:** loom epic #895 (F7 A1); reifies the "instantiation is a publish" principle from #886, enforced in `clean-instantiate.mjs` / `publish-to-private-template.mjs`.

## Variant Overlay Semantics

- **Replacement**: variant exists + global exists → variant wins
- **Addition**: variant exists, no global → added
- **Global only**: no variant → global used as-is

## Distribution-Durability Invariants

Three orthogonal questions gate whether an artifact write is permitted AND survives to every consumer. Collapsing them into one "permission" axis is the **E3 conflation**. Keep the three classes distinct:

- **A — Distribution-durability invariant** — answers "will this write survive the pipeline?"; keyed on distribution mechanics (this section); varies by NEITHER role NOR posture.
- **B — Posture-gated permission** — answers "has this operator earned the trust to act unilaterally?"; keyed on trust-posture L1–L5 (`rules/trust-posture.md`); varies by posture, NOT role.
- **C — Role-scoped capability** — answers "is this within this operator's job?"; keyed on `business_roles` (`rules/multi-operator-coordination.md` §1); varies by role, NOT posture.

**Composition:** `write permitted-and-durable = role_scopes_it (C) AND posture_unlocks_it (B) AND pipeline_preserves_it (A)` — **conjunctive AND independent**. Companion § Distribution-Durability Invariants — Composition.

**Class A is OWNED here; B and C are REFERENCED, not restated** (`specs-authority.md` Rule 9). **Class B** lives in `rules/trust-posture.md`; **Class C** in `rules/multi-operator-coordination.md` §1. Companion § Distribution-Durability Invariants — Where Classes B and C Live.

### The Class-A members (test: "does this write survive the pipeline, regardless of who wrote it?")

A Class-A invariant is a distribution-mechanics fact — **role-blind AND posture-blind**. The six members are each already a MUST / MUST-NOT clause elsewhere in this rule (loom-splits-never-originates · the single outbound path · direct template edits rebuilt away · the BUILD→BUILD prohibition · human classification, automated placement BLOCKED · the Owned-Surface Bound), collected here as the named cross-cutting class. Depth — the six enumerated with their per-member survival rationale — lives in `.claude/guides/rule-extracts/artifact-flow.md` § Class-A Members — Full Enumeration.

### The consultant's edit-ban is Class A, NOT a Class-C restriction (the E3 reframe)

The workspace spec `specs/01 §4` mis-filed the consultant's template edit-ban under **Class C** (a role restriction). It is **Class A**: a direct template edit is non-durable for EVERYONE. Companion § E3 Reframe — The specs/01 §4 Mis-filing.

- Edit a template `.claude/` directly (surface: template artifact files) — NOT durable (`/sync-to-use` rebuilds); **Class A blocks it**, role-blind.
- Step-7c proposal PR to the inbox (surface: `.claude/.proposals/inbox/`) — durable (ingested, never rebuilt); **Class C** business-consultant capability.

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

**Why:** The bound was purely MECHANICAL — whatever globs happened to sit in `tiers:` + ALWAYS_INCLUDE — so a surface widened by editing a data file rather than by changing a contract, and no reviewer was ever asked. The silence is survivable while the surface is inert and stops being survivable at the first EXECUTABLE one: a workflow file loom writes is credentialed CI running code the consumer did not author, so a default-ON widening makes it LOOM's act rather than the consumer's.

### Target-Only Paths Are Preserved (MUST)

A path declared at `sync-manifest.yaml::target_owned:` belongs to the TARGET. `/sync-to-use` and `/sync-to-build` MUST NOT overwrite it, purge it, or report it as a `--verify` residual; its `publish:` mode (`committed` / `local_only`) governs whether the target commits it, and there is NO default. `obsoleted:` OVERRIDES preservation — an obsoletion entry overlapping a preserved path MUST carve the exemption against THIS clause, explicitly.

**Why:** Preservation stated only in manifest comments is invisible to the rule corpus that governs distribution — the same silence that left ADD ungoverned, one key over. The manifest cited a `cross-repo.md` MUST Rule 4 that never existed; a dangling citation reads as a governed obligation while pointing at nothing (`spec-accuracy.md`).

### Trust Posture Wiring — Owned-Surface Bound + Target-Only Preservation

Applies to the **two clauses immediately above** ONLY (added 2026-08-16); ships canonical-8-field-compliant per `trust-posture.md` MUST-8. Every other section of this file stays on its own wiring until itself `/codify`-touched: companion § Owned-Surface Bound — Wiring Scope Note (full).

- **Severity:** `halt-and-report` at gate-review (cc-architect at `/codify` + reviewer at `/implement` confirm any change widening loom's write surface declared it in `owned_surfaces:` with `opt_in: true` + a real `election:`, and that no `target_owned:` path was overwritten or purged); `block` at the structural layer is carried by `check-owned-surfaces.mjs`, which fails the CI job — not by a hook, because a surface widening is a manifest/plan property with no tool-call-time signal (`hook-output-discipline.md` MUST-2).
- **Grace period:** 7 days from clause landing (2026-08-16 → 2026-08-23).
- **Cumulative posture impact:** same-class violations (a write to an undeclared surface; a non-`.claude` surface declared `opt_in: false`; an `opt_in: true` entry with no election; a `target_owned:` path overwritten or purged without an explicit `obsoleted:` exemption) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key; named deviation per `trust-posture.md` Rule 8, the structural gate already refusing the violating state at CI. Full reasoning: companion § Owned-Surface Bound — Regression-Within-Grace Disposition (full reasoning).
- **Receipt requirement:** SessionStart soft-gate `[ack: artifact-flow]` IFF `posture.json::pending_verification` includes the `artifact-flow` rule_id (shared rule_id; one ack covers every clause in this file).
- **Detection mechanism:** structural + review, and the structural half SHIPS WITH THE CLAUSE. `.claude/bin/check-owned-surfaces.mjs` reds on four kinds over both USE lanes and every BUILD lane, with `--selftest` as its positive control; bipolar poles at `.claude/audit-fixtures/owned-surface-bound/`, pinned by `.claude/test-harness/tests/check-owned-surfaces.test.mjs`, gate + suite both wired into `.github/workflows/coc-artifact-eval.yml`. Review: cc-architect at `/codify` judges whether a NEW surface should exist at all, which no mechanical check can answer. The four kinds named, their per-kind mechanics and the pole diff: companion § Owned-Surface Bound — Detection Mechanics.
- **Violation scope:** the § Owned-Surface Bound clause + the § Target-Only Paths Are Preserved clause ONLY (clause-scoped). Every `violations.jsonl` row names the surface and the lane it was measured on.
- **Origin:** See § Origin — 2026-08-16, co-owner-ratified D1/D2/D3/D4/D6.

## MUST NOT

- Read a tier match as a statement that an artifact is DISTRIBUTED. `loom_only` is tested at `classifyFile` step 2b, BEFORE tier inclusion at step 5, and `exclude` / `use_exclude` fence again after it. Every claim about what loom writes MUST come from a real `sync-tier-aware.mjs --dry-run --json` PLAN ACTION (`copy`/`overlay` vs a `skip` and its reason), never from glob membership.

**Why:** any other composition order OVER-REPORTS the distributed surface, so a contract derived from it declares surfaces loom does not write — and the enforcement then either encodes a fiction or reds on correct behaviour. Measured, base lane: companion § Composition Order — Measured Over-Report.

- Leave an artifact with NO positive fate. Every file under `.claude/` MUST resolve to shipped-on-a-tier, `loom_only`, or an explicit exclusion; "matches nothing" is an oversight indistinguishable from a decision and MUST NOT be relied on as a fence.

**Why:** absence from the shipped set would record no intent, leaving a deliberate loom-side tool indistinguishable from a file someone forgot to declare. **This invariant is currently HELD, and the clause exists to KEEP it held — it is prophylactic, not a live defect.** The landing measurement, and the `skip/no_tier_match`-is-not-undeclared trap: companion § Positive Fate — The Invariant Is Held.

- Sync directly between BUILD repos — all paths through loom/

**Why:** Direct BUILD-to-BUILD sync bypasses classification and variant overlay, silently introducing language-specific artifacts into the wrong repo.

- Edit template repos directly — rebuilt entirely by `/sync-to-use`

**Why:** Manual template edits are overwritten on the next `/sync-to-use` run, wasting effort and creating false confidence that the change is permanent.

- Auto-classify global vs variant without human approval

**Why:** Automated classification lacks the domain judgment to distinguish a language-specific pattern from a universal one, risking silent overwrites across all targets.

- Push a client ecosystem fork's identity or work back to canon — the canon←→fork relationship is upstream-pull-only (a fork SEES canon via the gated pull; it never writes back)

**Why:** Canon is a multi-tenant-shared surface; a fork pushing its tenant identity (org slug, customer name, internal paths) or work into canon's committed/shared/public surface is correlatable across every other client — the cross-ecosystem disclosure leak the bidirectional-isolation invariant (§ "Ecosystem Forks vs Downstream Consumers") exists to block. The fence is `repo-scope-discipline.md`'s cross-repo-write prohibition + the `publish-to-public.mjs` allowlist; a fork→canon contribution lane, if ever wanted, is a net-new design that MUST reconcile with this isolation, not a default.

## Origin

In brief: pre-2026-05-28 baseline + F63 + sync-upflow Wave 2a + ECO-CANON W4 + ECO-IMPL W7c + Directive 1. Depth — the complete dated provenance chain — lives in `.claude/guides/rule-extracts/artifact-flow.md` § Origin (full narrative).

**§ The Owned-Surface Bound + § Target-Only Paths Are Preserved — 2026-08-16, co-owner-ratified D1/D2/D3/D4/D6.** Depth: companion § Owned-Surface Bound + Target-Only Preservation — Origin (full narrative).

**Length rationale (per `rules/rule-authoring.md` MUST NOT § "Rules longer than 200 lines").** Named rationale: **canonical-flow scope** — the rule codifies the complete artifact-distribution surface across 17 non-overlapping sections (enumeration: companion); splitting it would force cross-rule lookups for every routing decision. Per that MUST NOT the cap is guidance and overage is permitted with a named rationale anchored at Origin; the per-clause BLOCKED corpora, Origin narratives and implementation-depth walkthroughs are EXTRACTED to the companion (EXTRACT-not-NARROW). Sibling precedent: `multi-operator-coordination.md` + `user-flow-validation.md`.

<!-- /slot:neutral-body -->
