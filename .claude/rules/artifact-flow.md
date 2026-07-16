---
priority: 10
scope: path-scoped
paths:
  - ".claude/**"
  - "sync-manifest.yaml"
  - "**/VERSION"
---

# Artifact Flow Rules

<!-- slot:neutral-body -->

## Authority Chain

- **atelier/** — CC + CO authority (methodology, base rules, guides)
- **loom/** — COC authority (SDK agents, specialists, variant system); central splitter/distributor, does NOT originate

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

USE-template `/codify` proposal origination is the authoritative target flow for COC-artifact improvements. See `guides/co-setup/09-proposal-protocol.md` Step 7b for the manifest contract.

### Repo Classes Map 1:1 To Resolver Logical Keys

The four repo classes above bind one-to-one to `bin/lib/loom-links.mjs` logical keys: **BUILD** → `build.{py,rs,prism}`, **USE-template** → `use-template.{py,rs,claude-py,claude-rs}`, **atelier** → `atelier`, **downstream** → `downstream.<slug>`. The resolver is the canonical NAME→location binding (per `cross-repo.md` MUST-1): `sync-manifest.yaml::repos.<target>` still owns the logical NAME and tier membership; the resolver owns NAME→on-disk-path. Cross-repo tooling (`/sync`, `/sync-to-build`, `/inspect`, `/repos`) resolves every target through the resolver — never a positional `~/repos/<name>` / `../<name>` guess. This does not change the flow above; it makes the path side of every class declarative and operator-portable.

**Canonical sublayout hint (recommended for fresh operators — F61).** The recommended on-disk realization of the logical namespace is `~/repos/kailash/{build,use}/<slug>` — BUILD repos under `~/repos/kailash/build/{py,rs,prism}`, USE templates under `~/repos/kailash/use/{py,rs,claude-py,claude-rs}`, peer roots `~/repos/loom` and `~/repos/atelier`. This is a HINT, NOT a MUST clause — see `cross-repo.md` § "Canonical Sublayout (Recommended — F61)" for the full hint and the explicit non-enforcement disposition. Pre-existing operators on any other layout (flat `~/repos/<slug>`, nested `~/repos/loom/<slug>`, or any declared `loom-links.local.json` mapping) remain fully supported. The hint encodes the BUILD-vs-USE class distinction in the path so fresh operators get a coherent default + sibling operators on the same machine find repos in a predictable place — without changing what the resolver, validators, or sync tooling actually do at runtime.

### Ecosystem Forks vs Downstream Consumers

The four repo classes above describe ONE ecosystem (canon). At scale, canon coexists with **client ecosystem forks**: a client copies the ENTIRE loom ↔ build ↔ use ecosystem, syncs **upstream-only** from canon (the fork's loom references canon loom; the fork's builds reference canon builds), develops **independently**, and decides per-update whether to **roll a canon change in** — a gated upstream-pull, never an auto-merge. An ecosystem fork is NOT a **downstream consumer** (§ Downstream-Consumer Routing): a downstream consumer pulls COC artifacts FROM a USE template WITHIN one ecosystem; an ecosystem fork is a parallel MIRROR ecosystem with its own canon-relationship AND its own internal downstream consumers. The two are distinct concepts — conflating them routes a fork's independent-development decisions through downstream-consumer pull machinery that does not model the canon←→fork relationship.

**Cascade is scoped to the ecosystem.** WITHIN one ecosystem, every artifact/capability improvement reaches every member project — with no per-project re-decision — via Gate-1 human classification + each project pulling on its own sync cadence (NOT an instantaneous auto-push). ACROSS ecosystems there is NO automatic cascade: a fork SEES canon's latest and DECIDES whether to roll each change in (the gated upstream-pull), and never pushes its identity or work back to canon. Disclosure is isolated **bidirectionally** at the ecosystem boundary — no ceremony, sync, deploy, or publish may carry one ecosystem's identity into another's committed/shared/public surface. This invariant is held **TODAY** by the two PRESENT general-purpose fences: `repo-scope-discipline.md`'s cross-repo-write prohibition (an agent cannot self-authorize a fork↔canon write) + the `publish-to-public.mjs` positive-INCLUDE allowlist on the publish path. A dedicated canon↔fork-aware guard **LIBRARY primitive** (`.claude/hooks/lib/cross-ecosystem-disclosure-guard.js`) is **SHIPPED** — a standalone fail-closed pre-write check that recognizes the boundary via the `ecosystem.json` `upstream_canon` pointer (`bin/lib/ecosystem-config.mjs::getUpstreamCanon` — null in canon, set in a fork) and refuses a fork→canon write of fork-identifying content (org slug, customer name, internal paths) **EVEN UNDER a `repo-scope-discipline.md:30` User-Authorized Exception grant** (the grant lifts the general cross-repo-write prohibition, NOT this distinct canon↔fork isolation invariant — the envelope-expansion gap the two general fences leave open), while PERMITTING a public-authority O1 artifact (ISO / SOC 2 / GDPR / etc.) as ecosystem-neutral (§ The Origination Taxonomy). Its entry-point hook is **REGISTERED** on the `Edit|Write|NotebookEdit` PreToolUse matcher (**F3 Level-1**, 2026-06-25, `journal/0335`) but **DORMANT**: it runs live, yet its BLOCK branch fires only on a write that DECLARES a canon target (a write #576's `sync-from-canon` driver does not itself emit — it is a canon→fork PULL, writing to the fork, not canon), and on canon (no `ecosystem.json`) every write passes through. The **LIVE autonomous cross-ecosystem write-DETECTION** an always-on fence needs (catching an ad-hoc fork→canon push) remains **DEFERRED** — it depends on the deferred ecosystem-remote resolver (`cross-repo.md` § "Ecosystem-Scoped Remote Links" — explicitly not yet built). The active cross-ecosystem upstream-pull — the gated **pull-merge** — is **SHIPPED**: the `sync-from-canon` driver landed (#576, 2026-06-30) and routes the pulled surface through the SAME Gate-1 Intake Disclosure Scrub (§ "Intake Disclosure Scrub" below) + `.claude/bin/scan-synced-disclosure.mjs` the intra-ecosystem intake uses (auto-merge is BLOCKED — every candidate is human-decided). Any cross-ecosystem pull MUST route its surface through that Gate-1 scrub AND the dedicated guard primitive above — a disclosure-scrubbed INTAKE, never a trusted merge. The driver resolves canon's tip via a live read-only `git ls-remote` over the `ecosystem.json` `upstream_canon` URL; the full **two-layer ecosystem-remote PATH resolver** (the `resolveRepo` NAME→remote-path join) remains DEFERRED (`cross-repo.md` § "Ecosystem-Scoped Remote Links"). The fork→canon direction is fenced as a MUST NOT (below).

**Why:** The unscoped "every improvement cascades to ALL projects" promise conflicts with fork-independence — a client that develops independently cannot also receive canon's every change automatically. Scoping cascade to the ecosystem (intra = reaches-all-via-classify+pull; cross = gated upstream-pull the fork controls) resolves the conflict and is the load-bearing distinction the multi-ecosystem model rests on.

**The source of instantiation MUST be clean at rest.** Any repo a client or downstream operator instantiates FROM — canon itself, or a dedicated client-template edition — MUST carry no canon trust-identity (operator roster, coordination-log, journal, `ecosystem.json` org slugs) at rest, because a repo `git clone`d or generated FROM it inherits that identity in its initial commit and object history. Post-hoc cleanup (`.claude/bin/clean-instantiate.mjs`'s working-tree CLEAR + § "The fail-closed assert-zero gate") is a detect-and-remediate backstop, NOT the fence — once a client has cloned and pushed, canon's objects may already be server-side and un-deletable (a published git object survives force-push/reset by SHA even with no ref). The structural fix is SOURCE-PREVENTION: instantiate from a pre-scrubbed client-template edition (`scripts/publish-to-private-template.mjs`), never from a live canon clone.

**Why:** Instantiation IS a publish — handing a client a template repo is the same disclosure event `publish-to-public.mjs` and the Gate-1/Gate-2 fences already gate for sync/deploy/publish; the template surface is a fourth publish path the same bidirectional-isolation invariant must cover, or a client's very first commit carries canon's identity forward.

### Canon Neutrality — A Tenant-Specific Gate Never Gates A Canon Build

A **canon** mechanism is tenant-neutral by construction (§ "Ecosystem Forks vs Downstream Consumers" above). A **tenant-specific decision or gate** — a works-council co-determination, a customer sign-off, a tenant legal/compliance approval — belongs to ONE tenant's internal governance. The two MUST NOT be coupled.

- **A tenant-specific decision/gate MUST NOT gate a tenant-neutral canon build.** Making a canon mechanism's roadmap wait on one tenant's works-council / legal / sign-off process couples canon to that tenant's internal governance — a canon-neutrality violation that also stalls every OTHER tenant. Canon builds proceed; the tenant gate lives at the fork.
- **Canon mechanisms are policy/granularity-AGNOSTIC.** Canon emits the maximally-accountable / most-general form and treats tenant-specific narrowing (coarsening, granularity, policy selection) as a CONFIGURABLE DOWNSTREAM operation. The tenant-specific policy + its legal gates live at the FORK / compliance lane (§ Ecosystem Forks + § The Origination Taxonomy O1 ecosystem-scope), NEVER baked into a canon build.
- **Scrubbing a tenant NAME does NOT fix a tenant-COUPLING.** DISTINCT failure modes: a leaked identifier is a DISCLOSURE leak (fixed by genericizing the token — the Intake / publish scrubs); a tenant-specific gate/decision embedded in a canon artifact is an ARCHITECTURAL coupling (fixed by RELOCATING the gate to the fork). A session may fix the first and silently propagate the second — the name-scrub reads as "handled" while the coupling ships.
- **Behavioral corollary (MUST):** when an external / human gate appears on a canon mechanism, the agent MUST question whether the gate belongs at canon AT ALL — not defer to it as a given. Treating a mis-placed tenant gate as an `autonomous-execution.md` "human-authority gate" and deferring to it is how the coupling propagates.

```text
# DO — the tenant gate lives at the fork; canon builds agnostic
Canon compiles the governance-envelope mechanism granularity-AGNOSTIC (emits
maximally-accountable; coarsening is a downstream knob). The tenant's attribution
granularity + its works-council co-determination are applied in the fork/compliance
lane. No canon wave waits on the works-council decision.

# DO NOT — a tenant gate blocks a canon build
"Canon Wave 1 is BLOCKED until the tenant's works-council confirms the attribution
granularity." (couples a tenant-neutral canon build to one tenant's internal
governance; scrubbing the tenant's NAME does not fix this — the GATE is the coupling)
```

**Why:** Canon is a multi-tenant-shared surface; coupling its roadmap to one tenant's internal governance both stalls every other tenant and silently imports tenant-specific concerns into the neutral substrate. The name-vs-coupling distinction is load-bearing because a disclosure scrub (the visible, tooled fence) can pass while the architectural coupling (the invisible one) ships unfixed.

**BLOCKED rationalizations:**

- "The tenant name is scrubbed, so the tenant concern is handled" (name ≠ coupling)
- "It's a legitimate human-authority gate, I should defer to it" (question whether it belongs at canon first)
- "The tenant's works-council decision is a real external gate" (real — but it gates the FORK's instance, not the canon mechanism)
- "Canon just needs to wait for the granularity to be settled" (canon builds agnostic; the granularity is a fork policy)
- "It's the first real customer, so the canon build follows their process" (canon is tenant-neutral; the first customer's process gates their fork, not canon)

Origin: 2026-07-13 co-owner-directed origination (`journal/0478`). #411 DECISION-1 was authored as a HARD GATE blocking canon Wave 1 on the tenant's works-council (BetrVG §87(1)6) confirmation; #1000 scrubbed the tenant NAME but propagated the gate; co-owner catch ("we are on canon loom … isn't that a leak?") → #1002 re-scope (canon builds granularity-agnostic; works-council gate → fork/csq lane). The shipped design (DECISION-2 + `provenance-ledger.js::_projectOperatorRef` canon-emits-max-accountable / csq-coarsens) already implied canon-agnostic — the gate contradicted it.

**Trust Posture Wiring (Canon-Neutrality — A Tenant Gate Never Gates A Canon Build):**

Applies to the **Canon Neutrality** clause (added 2026-07-13). Per `trust-posture.md` MUST-8 grandfather cutoff, this clause lands AT/AFTER the MUST-8 SHA and MUST ship canonical-8-field-compliant; the pre-existing grandfathered sections of this file remain exempt until each is itself `/codify`-touched (the clause-scoped precedent set by `security.md` § Enforcement-Surface Parity + `git.md` § CI-check/merge).

- **Severity:** `halt-and-report` at gate-review (reviewer / cc-architect confirm no tenant-specific gate blocks a canon build, and that any tenant-name scrub was NOT treated as fixing an architectural tenant-coupling); `advisory` at the hook layer (whether a gate is tenant-specific-gating-canon is judgment-bearing per `hook-output-discipline.md` MUST-2 — no structural tool-call signal).
- **Grace period:** 7 days from clause landing (2026-07-13 → 2026-07-20).
- **Cumulative posture impact:** same-class violations (a tenant-specific gate coupling a canon build, OR a tenant-name scrub treated as fixing a tenant-coupling) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key (a canon-neutrality property is review-layer-only + semantic; minting a key would drag `trust-posture.md`, a self-referential-codify allowlist file, into a self-ref edit; the universal trigger already covers it). Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8 — the same no-dedicated-key disposition `security.md` § Enforcement-Surface Parity and `git.md` § CI-check/merge took.
- **Receipt requirement:** SessionStart soft-gate `[ack: artifact-flow]` IFF `posture.json::pending_verification` includes the `artifact-flow` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer / cc-architect inspect any session authoring or editing a canon artifact for a tenant-specific gate (works-council / customer sign-off / tenant legal approval) framed as blocking a canon wave/build, and confirm any tenant-name scrub was paired with a check that the underlying gate is not architecturally coupling canon. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — no hook detector; audit fixtures land with the Phase-2 detector at `.claude/audit-fixtures/canon-neutrality/` per `cc-artifacts.md` Rule 9.
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

- **Primary — Step 7c upflow (push-only, human-gated):** the consumer's OWN `/codify` Step 7c originates a COC-artifact proposal (schema in `skills/30-claude-code-patterns/sync-flow.md` § "Downstream Upflow Proposal Schema (Step 7c)") and offers it as a HUMAN-GATED PR to the template's `.claude/.proposals/inbox/<date>-<slug>.yaml` (per `upstream-issue-hygiene.md` MUST-1). The template's `/sync-from-downstream` (Template Inbox Ingest) scrubs + reviews-as-data + dedups + relays accepted entries into its OWN Step-7b manifest with hop-level provenance `origin: downstream, via: <template-slug>` (never consumer-identifying). The relayed proposal flows to loom Gate-1; loom distributes on the next `/sync-to-use`; consumers pull on their own cadence.
- **Fallback — Route A (issue on the template):** for no-fork-permission consumers and stale (pre-7c) consumers, file a COC-method issue against the USE template; the template's `/codify` originates the proposal per Step 7b. Route A is RETAINED but is the fallback, not the default.

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

**Why:** Downstream-consumer issues filed against the consumer's own repo produce orphan proposals — the consumer's Step-7c manifest is push-only (offered to the template inbox via a human-gated PR, never pulled by loom or the template), so an issue filed on the consumer's own repo documents a problem nobody upstream sees. Issues filed directly against loom bypass the USE-template-side review that catches variant-vs-global misclassification BEFORE it reaches every OTHER consumer of the same template. The USE template is the only repo class that originates proposals to loom (per the manifest contract); routing every downstream-consumer change through it — by Step-7c PR or by Route-A issue — preserves the Gate-1 audit trail the splitter rule below depends on.

**BLOCKED rationalizations:**

- "But the issue surfaced in MY repo, so I file it here"
- "Loom is the central authority — filing directly against loom skips a hop"
- "Filing against own repo is informational; the team will route it later"
- "The USE template is a thin wrapper; the real fix is in loom anyway"
- "My project repo IS a USE template" (downstream-consumer projects are NOT USE templates — the canonical USE-template set is enumerated above; if your repo is not in that set, you are a downstream consumer)

**Disclosure fence (scenario 8) — QUADRUPLE on the public-fork axis.** A downstream-originated proposal is disclosure-scrubbed four times before any public-fork exposure: (i) consumer-side Step-7c scrub, (ii) template inbox-ingest scrub, (iii) loom Gate-1 scrub, (iv) `publish-to-public.mjs`'s positive INCLUDE allowlist (`.proposals/` is never publishable). Each fence is independent; hop-level-only provenance (`via: <template-slug>`, never consumer-identifying) means no consumer identity is carried even before the fences run.

#### Consultant Dual-Route Self-Serve (D4)

A **business-consultant** (the role that builds specific products on use-templates and SIGNALS capability gaps — `multi-operator-coordination.md` §1 `business_roles`) operates at a `coc-project` consumer and MUST be able to act on EVERY `/codify` finding WITHOUT talking to an engineer. The consultant's findings split into two TYPEs that route to two DIFFERENT lanes — the **dual-route**. Both lanes already exist as the manual routes above; the consultant-facing piece this contract names is that ONE `/codify` covers both, async and human-gated, with no synchronous engineer hand-off:

- **Artifact improvement** (method / rule / skill / agent / COC-tooling) → the **Step-7c upflow** (§ Downstream-Consumer Routing above): a LOCAL proposal manifest + a human-gated push-only PR to the template's `.claude/.proposals/inbox/`. **SHIPPED.**
- **Capability gap / bug** (a missing SDK capability the consultant worked around, or an SDK defect) → an **auto-drafted, human-gated BUILD issue** (§ Issue Routing By Change Type — cross-SDK-first), scrubbed per `upstream-issue-hygiene.md` MUST-1 (human gate before filing) + MUST-2/3 (downstream-context redaction + minimal-repro shape). BUILD turns the workaround into a real capability that cascades; the consumer migrates it on next start (the capability-gap lifecycle).

**Invariant (D4, RATIFIED — `decisions/00` DECISION-4):** the consultant **self-serves and NEVER talks to an engineer**; the PR / issue IS the async hand-off and the human gate at each lane (the consumer's own filing gate, the template-ingest review, BUILD's triage) is the trust gate. build/loom pick up async and cascade.

**Why:** Routing through an engineer for classification re-introduces the synchronous hand-off DECISION-4 removes — the consultant blocks on engineer availability and the engineer becomes a bottleneck for every product's signal. The dual-route lets ONE `/codify` cover both change-TYPEs async; the per-lane human gate (not an engineer conversation) is the trust boundary.

```
# DO — one /codify, dual-routed by change TYPE, no engineer conversation
consultant /codify finding:
  artifact improvement → Step 7c PR to template inbox      (SHIPPED)
  capability gap / bug → human-gated BUILD issue (scrubbed) (Route B auto-draft — G3.4 SHIPPED W7b)

# DO NOT — consultant pings an engineer to classify or hand off
"let me ask the build engineer whether this is a bug or a capability"   # BLOCKED by D4
```

**The dual-route classifier (artifact vs capability vs bug) is SHIPPED (ECO-IMPL W7b).** The Layer-1 mechanical glob + Layer-2-suggestion dispatch (`gc-route-classifier.js`), the `upstream-issue-hygiene.md` MUST-3 five-section BUILD-issue drafter + cross-SDK-first flag + MUST-2 scrub (`gc-build-issue-draft.js`), and the G3.5 disposition-visibility receipts (`gc-disposition-receipt.js`) are wired at `commands/codify.md` Step 7c (full procedure in `skills/30-claude-code-patterns/sync-flow.md` § "Route-B Capability/Bug Upflow (G-C)"). The **Layer-2 capability-vs-bug judgment is the LLM's** — a dumb-lib / LLM-reasons split per `agent-reasoning.md` + `probe-driven-verification.md`; the lib carries NO keyword classifier and the HUMAN gate (MUST-1) classifies+files. That LLM-judgment surface is correct by design, NOT a gap. The upflow's gh-vs-ADO provider abstraction for the PR/issue write-surface is **G-F, SHIPPED at W7a** (`specs/05 §3`).

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

1. **Verbatim directive** — the co-owner's instruction is quoted verbatim in the journal `DECISION` entry (not paraphrased, not inferred from assent).
2. **Receipt-before-edit** — the journal entry is written and committed-or-staged BEFORE the first artifact edit; the entry is the provenance, not a post-hoc rationalization.
3. **COC-tooling scope only** — the artifact is COC tooling (a command / skill / agent / rule / `.claude/bin` validator under loom's own surface). CC/CO methodology changes still route to `atelier/` via `/sync-to-coc`; SDK code still routes to a BUILD repo. This exception does NOT widen those lanes.

```
# DO — co-owner directs a /wrapup change in-session; journal DECISION
# entry (verbatim directive) lands first, THEN the edit
journal/00NN-DECISION-...md  (verbatim co-owner quote)  →  edit .claude/commands/wrapup.md

# DO NOT — loom edits a rule citing "the co-owner would want this"
# (no in-session directive, no verbatim quote, no receipt-first journal)
edit loom/.claude/rules/foo.md  "co-owner implied it last week"
```

**BLOCKED rationalizations:**

- "The co-owner approved the general direction, a verbatim quote is pedantic"
- "I'll write the journal entry after the edit, same thing"
- "It's CC methodology but close enough to COC tooling"
- "Re-routing a co-owner's direct in-session directive through the USE-template lane is just process"
- "Standing prior approval covers this new origination"

**Why:** Without the verbatim + receipt-first + scope conditions, "co-owner directed it" becomes a rubber-stamp that reopens the unattributable-origination failure mode the splitter rule closes. The three conditions keep the carve-out narrow: a real in-session directive with a durable, greppable provenance receipt is auditable at Gate-1 exactly as a `/codify` proposal is; anything weaker is not. CC/CO scope is fenced because methodology drift from `atelier/` is a different, wider failure mode this exception MUST NOT touch.

Origin: 2026-05-18 — co-owner-directed `/wrapup` forest-ledger codification; 6-entry precedent chain journal/0085, 0088, 0089–0094 each asserted this exception per-journal before it was named here. Receipt: journal/0095.

### The Origination Taxonomy — O1 (compliance), O2 (consultant upflow), O3 (BUILD)

Co-Owner-Directed Origination above is the FIRST loom-direct lane. It generalizes to a named **O1 compliance-origination class** (DECISION-7, RATIFIED — `decisions/00`; `specs/05 §1`, `specs/06 §4`). There are THREE legitimate origination paths, each carrying its own audit trail; `loom Splits, Never Originates` protects the AUDIT TRAIL, not the authorship location:

| #      | Origination path                                              | Who                 | Audit trail                                                                                                                       | Status                                   |
| ------ | ------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **O1** | Compliance/standard → artifact, authored **directly at loom** | platform-engineer   | receipt-first journal `DECISION` naming the **external authority** (regulation/standard/framework + version/clause) as provenance | named here (generalizes the carve-out)   |
| **O2** | Consultant artifact improvement → **upflow**                  | business-consultant | Step-7c proposal provenance (local manifest + inbox PR + relay), QUADRUPLE-fenced                                                 | SHIPPED (§ Downstream-Consumer Routing)  |
| **O3** | SDK capability / bug → **BUILD**                              | capability-engineer | BUILD `/codify` proposal, cross-SDK-first                                                                                         | SHIPPED (§ Issue Routing By Change Type) |

**O1 — the compliance-origination class.** An organization's regulations / standards / frameworks (at the global level) become COC artifacts (rules / skills / agents) when a **platform-engineer authors them DIRECTLY at loom against that EXTERNAL authority**. This is the ONE legitimate loom-direct origination lane for compliance content — the methodology home is `specs/methodology/` (per `specs-authority.md`; the platform-engineer owns it, `specs/06 §4`). It generalizes the Co-Owner-Directed carve-out by SUBSTITUTING the audit-trail source: where the carve-out's trail is a verbatim co-owner directive, O1's trail is the **external standard itself** plus the receipt that cites it.

**Enforcement is load-bearing (`specs/06 §4` R1 LOW-2 / DECISION-7 honest-con) — the citation must GOVERN, not merely EXIST:** the journal `DECISION` receipt MUST (a) cite the external authority **down to the specific version + clause/§** (a bare standard name is the agent-producible degenerate case and is insufficient), AND (b) state in ONE sentence HOW that clause MANDATES the artifact's content (the derivation: "§A.8.24 requires cryptographic-controls policy → this rule mandates X"). Both MUST land **BEFORE the edit**. A citation that names a real standard whose clause does NOT govern the artifact is the loophole, not the fence — an uncited OR non-governing "compliance" edit is an unattributable loom origination and is BLOCKED. The other two carve-out conditions still apply: receipt-before-edit (the citation is the provenance, not a post-hoc rationalization) and COC-tooling scope (O1 produces COC artifacts; CC/CO methodology still routes to `atelier/` via `/sync-to-coc`; SDK code still routes to BUILD).

**Detection — two complementary layers (mechanical SHAPE + LLM-judgment GOVERNANCE):** an O1 origination is a `/codify`, so the standing cc-architect review every `/codify` deploys (per `cc-artifacts.md` Rule 6) gate-reviews it. The two layers are:

1. **Mechanical SHAPE check (SHIPPED — `.claude/hooks/lib/o1-citation-check.js::checkO1Citation`).** Given an O1-origination journal `DECISION` receipt, it asserts STRUCTURALLY that the receipt (a) names a standard AND carries a VERSION token (a standalone year counts ONLY when NAME-ADJACENT, riding the standard name — a free-floating year in prose does NOT), (b) cites a specific clause/§ identifier (a BARE standard name with no clause is BLOCKED — the agent-producible degenerate case this § calls out in the "per ISO 27001:2022" DO-NOT below), and (c) carries a one-sentence derivation linking clause → artifact ("§X requires Y → this rule mandates Z"). It fails LOUD with a TYPED reason naming which of (a)/(b)/(c) failed. Per `hook-output-discipline.md` MUST-2 it surfaces as halt-and-report/advisory (a review signal), NEVER `severity:block`. Behavioral tests: `.claude/test-harness/tests/o1-citation-check.test.mjs`; one audit fixture per predicate: `.claude/audit-fixtures/o1-citation-check/`.
2. **LLM-judgment GOVERNANCE gate (the preserved human boundary).** The SHAPE check is mechanical; the SEMANTIC question — "does the cited clause ACTUALLY GOVERN this artifact's content?" — STAYS WITH THE HUMAN / LLM GATE. The check explicitly does NOT judge governance: a real standard whose clause does NOT govern the edit PASSES the SHAPE check and is BLOCKED only by the cc-architect's judgment reading the receipt (and halting on a non-governing edit). The SHAPE check COMPLEMENTS, never REPLACES, that judgment — it is the structural fence the LLM-judgment gate previously held alone (and not necessarily the `self-referential-codify.md` multi-agent gate, which fires only when the compliance artifact ITSELF is a codify-governing surface; a typical compliance rule governs code behavior, so it is outside that allowlist).

**Ecosystem scope:** in a client ecosystem fork, an O1 artifact citing a **tenant-specific (non-public) authority** is ecosystem-private — it MUST NOT ride a canon upstream-pull (the fork→canon MUST NOT, § Ecosystem Forks vs Downstream Consumers). Only public external authorities (ISO / SOC 2 / GDPR / etc.) are ecosystem-neutral.

```
# DO — O1: receipt cites version+clause AND states the derivation, BEFORE the edit
journal/00NN-DECISION-...md  ("per ISO/IEC 27001:2022 §A.8.24 — §A.8.24 requires a documented
  cryptographic-controls policy → this rule mandates env-var-only secret handling")
  →  edit .claude/rules/<compliance-rule>.md  +  specs/methodology/ entry

# DO NOT — uncited, OR a real standard whose clause does not govern the edit
edit .claude/rules/<compliance-rule>.md  "this is a standard best practice"   # BLOCKED — no cited authority
edit .claude/rules/<compliance-rule>.md  "per ISO 27001:2022"  # BLOCKED — versioned but bare name, no clause, no derivation = loophole
```

**Why:** O1 widens loom-direct origination beyond the co-owner-directed case to the compliance case. Unlike a live co-owner directive (which the agent cannot fabricate without the human present), a standard citation is agent-producible from training knowledge alone — so "a citation exists" is too weak a fence: it must cite a SPECIFIC clause AND show that clause GOVERNS the artifact, and that derivation is what the `/codify` gate reviewer (cc-architect) verifies by judgment. Drop the version/clause or the derivation and O1 collapses into the "to-save-a-round-trip" origination the splitter rule blocks. O2 and O3 keep their existing trails; the taxonomy names all three so an author picks the lane by WHO originates and WHAT the audit trail is, never by convenience.

Origin: 2026-06-15 — ECO-CANON W4 (O1, C6); DECISION-7 RATIFIED (`decisions/00`, `journal/0282` _"Methodology is at loom level… they enter at loom level"_); normative `specs/05 §1` + `specs/06 §4`. Co-owner-directed origination chain `journal/0280`/`0282`/`0284`.

## BUILD Repo Rules

- `/codify` writes to BUILD repo's `.claude/` for immediate local use + creates `.claude/.proposals/latest.yaml`
- BUILD repo does NOT sync to any other repo directly
- USE-TEMPLATE repos (`kailash-coc-*`) MAY originate proposals for COC-artifact improvements only (authoritative target flow; manifest contract in `guides/co-setup/09-proposal-protocol.md` Step 7b); their downstream USE/project repos remain pull-only (`/codify` local, no manifest)

## Proposal Lifecycle

Proposals track artifact changes through a three-state lifecycle. Each originating direction — BUILD→loom (SDK code, cross-SDK-first), USE-template→loom (COC-artifact), downstream→USE-template (relayed up, Step 7c), loom→atelier (CC/CO) — follows the same lifecycle independently.

```
/codify creates proposal     /sync-from-* (Gate 1) classify   /sync-to-use (Gate 2) distributes
        │                                  │                                │
  pending_review ──────────────→ reviewed ──────────────────────→ distributed
        │                          ↑ │                                │
        │  /codify appends         │ │ /codify appends (resets       │ /codify archives
        └──────────────────────────┘ │ status to pending_review)     │ and creates fresh
                                     └───────────────────────────────┘
```

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

- **BUILD → loom**: SDK BUILD-repo proposals, cross-SDK-first (`/codify` Step 7)
- **USE-template → loom**: COC-artifact proposals from `kailash-coc-*` (authoritative target flow; manifest contract in `guides/co-setup/09-proposal-protocol.md` Step 7b)
- **downstream → USE-template (relayed up to loom)**: a `coc-project` consumer's `/codify` Step 7c originates a push-only proposal offered to the template's `.claude/.proposals/inbox/`; the template's `/sync-from-downstream` (Template Inbox Ingest) relays accepted entries into its OWN USE-template→loom manifest with hop-level provenance (`origin: downstream, via: <template-slug>`), then they ride the row above. **Traceability:** the USE-template→loom ingest stream itself is PRE-EXISTING; Step 7c adds ONLY the consumer→template-inbox origination + relayed-provenance recognition, NOT a new loom-facing stream.
- **loom → atelier**: loom's CC/CO proposals (`/codify` Step 8)

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

Every proposal ingested at Gate-1 — the `.claude/.proposals/latest.yaml` body AND the referenced BUILD-repo / USE-template-repo artifact files — MUST be disclosure-scrubbed BEFORE placement into `loom/.claude/`. Gate-1 scrub is two mechanical actions, run first: (a) `node .claude/bin/scan-synced-disclosure.mjs --root <inbound-repo-path>` against the candidate artifact files, AND (b) a HUMAN scrub of the proposal body per `upstream-issue-hygiene.md` Rule 2 (the body is small and already human-classified at Gate-1; `.proposals/` is `isNeverSynced` so `--root` will not scan it — the human gate covers it). A non-zero scanner exit OR any finding = HALT until the disclosure is genericized + relocated (the #255 / #260 pattern); placement does not proceed. This is the symmetric twin of the Gate-2 output fence (#263).

```
# DO — scrub on intake, before placement
node .claude/bin/scan-synced-disclosure.mjs --root ../kailash-py   # artifact files
# + human reads .proposals/latest.yaml body for client/operator/3rd-party tokens
# → exit 0 AND body clean → classify + place into loom/.claude/

# DO NOT — place first, scrub at Gate-2
# (the disclosure is already in loom git history before Gate-2 ever runs)
```

**BLOCKED rationalizations:**

- "Gate 2 scans output, intake scrub is redundant"
- "It came from our own BUILD repo, there are no client tokens"
- "We'll catch it at Gate 2"

**Why:** Gate-1 placement enters loom git history BEFORE Gate-2 ever runs; a disclosure that lands at Gate-1 is already permanent and correlatable across 30+ downstream consumers — redaction-after is partial, the exact `upstream-issue-hygiene.md` Rule-1 failure mode.

Origin: 2026-05-17 — #263 forest-closure follow-up (symmetric intake twin of the Gate-2 output fence); receipts journal 0082 / 0083 / 0084.

**Trust Posture Wiring (Intake Disclosure Scrub):**

- **Severity:** `halt-and-report`. The scanner half is a structural exit-code signal, but the proposal-body half is a human-judgment gate — the composite clause carries `halt-and-report`, not `block` (per `hook-output-discipline.md` MUST-2: judgment-bearing gates do not carry block severity).
- **Grace period:** 7 days from this clause landing. During grace, a Gate-1 placement that proceeded without the two scrub actions logs to `violations.jsonl` for cumulative tracking; it does not auto-emergency-downgrade.
- **Regression-within-grace:** any same-class violation (Gate-1 placement of an un-scrubbed proposal) within 7 days = emergency downgrade per `trust-posture.md` MUST Rule 4 (`intake_scrub_bypass` added to the emergency-trigger list, 1× = drop 1 posture).
- **Receipt requirement:** SessionStart MUST require `[ack: intake-disclosure-scrub]` in the agent's first response IF `posture.json::pending_verification` includes this rule_id.
- **Detection:** the #263 `scan-synced-disclosure.mjs --root` invocation IS the mechanical detector for the artifact-file half; the sync-reviewer Gate-1 step-0 confirms the human body-scrub occurred. Final disposition is human. Enforcement activates with trust-posture Phase 2 (`/codify` wiring requirement); Phase 1 is observer + advisory.

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

**BLOCKED rationalizations:**

- "No one is working in that checkout right now"
- "The overlay is faster than a worktree + PR round-trip"
- "The BUILD team will land the uncommitted delta as PR #1 next session"
- "It is my own machine's clone, the working tree is mine to overlay"

**Why:** A developer may be live in the target's local checkout, and a Gate-2 overlay silently collides with their uncommitted work — the stranded-overlay class (the pile of uncommitted `.claude/` files a prior overlay-model sync left in a local BUILD checkout, `journal/0403`). A worktree from `origin/main` is clean by construction and lands the change as a PR the dev pulls, so no live-checkout state is ever overwritten.

### 2. Every Gate-1 And Gate-2 Operation Emits An Exact-Tracking Receipt (MUST)

Every gate operation MUST emit a receipt recording EXACTLY what was done, through the same mechanism Shard-B's receipts use — a journal `DECISION` entry per gate op plus a signed coordination-log record via `coc-emit.js::emitSignedRecord` (`journal/0402`). The coordination-log record uses the `gate-op-receipt` fold type (registered in `coordination-log.js::_registerM0Defaults` — a single-signer, `checkpoint_exempt` accountability record; NOT an actuation, so it bypasses the A+ presence gate); `sync-gate2-worktree.mjs::emitTrackingRecord` emits it for every completed Gate-2 distribution and surfaces any emission failure on the receipt's `record_emit` field rather than failing the sync (the PR has already landed). The signed record carries every SCALAR provenance field (`loom_sha`, `base_sha`, `target`, `branch`, `pr_url`, `merge_sha`, `timestamp`, `gate`, `lane`, `worktree`, `changed_count`) plus a manifest FINGERPRINT (`manifest_fingerprint` = per-bucket `added_count`/`modified_count`/`deleted_count` + a `sha256` over a bucket-structured canonical form — `JSON.stringify({added, modified, deleted})` with each bucket pre-sorted, binding bucket MEMBERSHIP so a compensating cross-bucket swap (add x/del y ↔ add y/del x) cannot forge a collision; produced by `sync-gate2-worktree.mjs::fingerprintManifest`) rather than the inline manifest ARRAYS — the arrays overflow `coc-emit.js::_defaultAppend`'s 2KB `MAX_LINE_BYTES` cap for broad Gate-2 syncs (100+ files), and an overflowed append is REFUSED so NO forensic record lands (#862); the fingerprint is produced by `sync-gate2-worktree.mjs::fingerprintReceiptForRecord`. The FULL manifest survives uncapped on the STDOUT receipt AND the committed journal `DECISION` embed (the local forensic source of truth the fingerprint recomputes from — the coordination log is local per-repo state, never synced per `trust-posture.md` MUST NOT). ONLY the committed journal `DECISION` embed MUST be scrubbed — via `sync-gate2-worktree.mjs::scrubReceiptForJournal` (the absolute `worktree` path, the `pr_url` org/repo slug, AND any absolute path in `record_emit.reason`) — BEFORE embedding, per MUST-2 below; the manifest arrays it keeps are `.claude/`-relative file paths, not disclosure tokens. Declaring a gate op complete without its receipt is BLOCKED.

- **Gate 1** (`/sync-from-build`, `/sync-from-use` ingest + classify): the source proposal, the per-change classification decision (global / variant / skip), the scrub result, and the per-file placement manifest.
- **Gate 2** (`/sync-to-build`, `/sync-to-use` distribute): the fields `bin/sync-gate2-worktree.mjs::buildReceipt` captures — `loom_sha`, the worktree `base_sha`, `target`, `branch`, the per-file `manifest` (added / modified / deleted), `changed_count`, `pr_url`, and `merge_sha`; the full return additionally carries `gate`, `lane`, the absolute `worktree` path, and `timestamp` — per target. Before the receipt is embedded in the committed journal `DECISION`, it MUST be scrubbed per `user-flow-validation.md` MUST-6: the `pr_url` org/repo slug (private on a Rust BUILD lane) and the absolute `worktree` operator path are the scrub tokens. The per-target completeness table (`sync-completeness.md` MUST-2) is the Gate-2 receipt's verification companion.

```
# DO — Gate-2 receipt records the exact manifest + provenance per target, scrubbed before embedding
# buildReceipt → {loom_sha, base_sha, target, branch, manifest{added,modified,deleted}, changed_count, pr_url, merge_sha, …gate, lane, worktree, timestamp}
# scrub pr_url slug + absolute worktree path before the journal DECISION embed (user-flow-validation.md MUST-6)

# DO NOT — "synced rs, looks good" with no per-file manifest or merge SHA; OR embed the raw worktree path / private pr_url slug unscrubbed
```

**Why:** Without a per-op receipt, a distribution's exact file-set and provenance live only in session memory and evaporate at the context boundary; the receipt is the durable, greppable record of what landed where — the same audit trail the proposal-lifecycle provenance provides for ingest. The scrub is required because the receipt is committed to loom's journal (a synced/publishable surface) while two of its fields — the `pr_url` slug and the absolute `worktree` path — carry a private-org identifier and an operator home path.

**Trust Posture Wiring (Exact Gate-1 / Gate-2 Tracking):**

- **Severity:** `halt-and-report` at gate-review (a worktree-vs-local-checkout landing and a receipt-presence property are judgment-bearing over the session's command history, not a single structural tool-call signal — per `hook-output-discipline.md` MUST-2 the hook layer stays `advisory`).
- **Grace period:** 7 days from this clause landing (2026-07-03 → 2026-07-10).
- **Cumulative posture impact:** same-class violations (a Gate-2 overlay into a live local checkout, OR a gate op declared complete without its exact-tracking receipt) contribute to `trust-posture.md` MUST Rule 4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** any same-class violation within 7 days routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST Rule 4 (1× = drop 1 posture) — no dedicated trigger key (a session-history judgment property does not warrant an instant-drop key, and minting one would drag `trust-posture.md`, a self-ref allowlist file, into a self-ref edit).
- **Receipt requirement:** SessionStart soft-gate `[ack: artifact-flow]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — cc-architect / reviewer inspects any session transcript that ran `/sync-to-build` or `/sync-to-use` and confirms (a) the distribution drove `bin/sync-gate2-worktree.mjs` (never a raw overlay into the target checkout) and (b) each gate op emitted its journal `DECISION` + coordination-log receipt. The `sync-reviewer` Gate-1 step confirms the ingest half. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — no hook detector; audit fixtures land with the Phase-2 detector at `.claude/audit-fixtures/exact-gate-tracking/` per `cc-artifacts.md` Rule 9.
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

**Composition:** `write permitted-and-durable = role_scopes_it (C) AND posture_unlocks_it (B) AND pipeline_preserves_it (A)`. The three are **conjunctive AND independent** — a write blessed by role and posture still vanishes if it violates a Class-A invariant; a Class-A-clean write still needs the role to scope it (C) and the posture to unlock it (B). Naming which of the three blocked (or will silently revert) a write is the whole point of keeping them separate.

**Class A is OWNED here; B and C are REFERENCED, not restated.** This section owns Class A (distribution mechanics — artifact-flow's domain). **Class B** lives in `rules/trust-posture.md` (the L1–L5 autonomy ladder); the `/release` distinct-person owner co-sign that operationalizes the release gate is `operator-gate.js`, owned by `rules/multi-operator-coordination.md` §6.4. **Class C** lives in `rules/multi-operator-coordination.md` §1 (the advisory `business_roles` array — `platform-engineer` / `capability-engineer` / `business-consultant`, NEVER quorum-eligible). Per `rules/specs-authority.md` Rule 9 they are cross-referenced, never duplicated — no parallel source of truth.

### The Class-A members (test: "does this write survive the pipeline, regardless of who wrote it?")

A Class-A invariant is a distribution-mechanics fact — **role-blind AND posture-blind**. No role scopes around it; no posture unlocks it. Each member is already a MUST / MUST-NOT clause elsewhere in this rule; collected here as the named cross-cutting class:

- **loom Splits, Never Originates** (§ "loom Splits, Never Originates") — a loom-direct origination without an audit trail does not survive Gate-1's provenance requirement. (The O1/O2/O3 taxonomy + the Co-Owner-Directed carve-out are the audit-trail-bearing exceptions, not violations of the invariant.)
- **`/sync-to-use` is the only outbound path to templates** (§ "/sync-to-use Is the Only Outbound Path to Templates") — any other write to a template is overwritten on the next rebuild.
- **Editing a template `.claude/` directly is overwritten by `/sync-to-use`** (§ MUST NOT "Edit template repos directly") — the durable surface is the proposal QUEUE (`.claude/.proposals/inbox/`), never the rebuilt artifact files.
- **BUILD→BUILD direct sync bypasses classification** (§ MUST NOT "Sync directly between BUILD repos") — every path routes through loom's Gate-1 split.
- **Human classifies every change; automated placement is BLOCKED** (§ "Human Classifies Every Change") — an auto-placed global-vs-variant write does not survive review.

### The consultant's edit-ban is Class A, NOT a consultant Class-C restriction (the E3 reframe)

The workspace spec `specs/01 §4` mis-filed "never edits the template directly" under the **business-consultant's** Class-C row — reading a distribution-mechanics fact as a role restriction. The fact is **Class A**: editing a template directly is non-durable for EVERYONE (a platform-engineer's direct edit is rebuilt away exactly as a consultant's is). The consultant is **NOT forbidden from improving templates** — they are forbidden a NON-DURABLE mechanism (direct edit) and granted a DURABLE one (the Step-7c PR to the inbox, § "Consultant Dual-Route Self-Serve (D4)"), which writes the proposal QUEUE, not the rebuilt artifacts.

|                                     | Surface                     | Durable?                      | Class                                |
| ----------------------------------- | --------------------------- | ----------------------------- | ------------------------------------ |
| Edit a template `.claude/` directly | template artifact files     | NO (`/sync-to-use` rebuilds)  | **A blocks it** (role-blind)         |
| Step-7c proposal PR to the inbox    | `.claude/.proposals/inbox/` | YES (ingested, never rebuilt) | **C** business-consultant capability |

This is **Class-A-routing of a Class-C capability** — the identical shape to the capability-engineer authoring at BUILD rather than direct-at-loom (also a Class-A `loom Splits, Never Originates` routing of a Class-C capability, § The Origination Taxonomy O3). The role HAS the capability (improve templates / author capabilities); Class A routes it onto the DURABLE mechanism.

**Why:** Filing a distribution-mechanics fact as a role restriction tells a consultant they may not improve templates — false, and it removes the most autonomous lane they have (D4 self-serve). Separating the three classes makes the real invariant role-blind (it binds the platform-engineer too) and the real capability role-scoped-but-durably-routed. A write that is role-scoped (C) and posture-unlocked (B) still MUST clear Class A; conflating the axes hides which of the three actually governs — the exact ambiguity the E3 error shipped.

## MUST NOT

- Sync directly between BUILD repos — all paths through loom/

**Why:** Direct BUILD-to-BUILD sync bypasses classification and variant overlay, silently introducing language-specific artifacts into the wrong repo.

- Edit template repos directly — rebuilt entirely by `/sync-to-use`

**Why:** Manual template edits are overwritten on the next `/sync-to-use` run, wasting effort and creating false confidence that the change is permanent.

- Auto-classify global vs variant without human approval

**Why:** Automated classification lacks the domain judgment to distinguish a language-specific pattern from a universal one, risking silent overwrites across all targets.

- Push a client ecosystem fork's identity or work back to canon — the canon←→fork relationship is upstream-pull-only (a fork SEES canon via the gated pull; it never writes back)

**Why:** Canon is a multi-tenant-shared surface; a fork pushing its tenant identity (org slug, customer name, internal paths) or work into canon's committed/shared/public surface is correlatable across every other client — the cross-ecosystem disclosure leak the bidirectional-isolation invariant (§ "Ecosystem Forks vs Downstream Consumers") exists to block. The fence is `repo-scope-discipline.md`'s cross-repo-write prohibition + the `publish-to-public.mjs` allowlist; a fork→canon contribution lane, if ever wanted, is a net-new design that MUST reconcile with this isolation, not a default.

## Origin

Pre-2026-05-28 baseline plus F63 (.session-notes step 3 / Q3c — Route A downstream-consumer routing clarification, receipt journal/0165) plus sync-upflow Wave 2a (2026-06-13, todo 09: Step 7c downstream-upflow promoted to the PRIMARY downstream path with Route A retained as fallback; downstream→USE-template origination direction added to § Proposal Lifecycle; QUADRUPLE disclosure-fence note in § Downstream-Consumer Routing; brief value-anchor (loom-internal reference)). Prior receipt-bearing additions: `Co-Owner-Directed Origination` subsection (2026-05-18, journal/0095); `Intake Disclosure Scrub` (2026-05-17, journal/0082-0084); `Repo Classes Map 1:1 To Resolver Logical Keys` (2026-05-17, journal/0086). Plus ECO-CANON W4 (2026-06-15, DECISION-4 + DECISION-7 RATIFIED per `journal/0280`/`0282`): `Consultant Dual-Route Self-Serve (D4)` subsection (C6) + `The Origination Taxonomy — O1/O2/O3` subsection (O1, generalizing the Co-Owner-Directed carve-out); receipt `journal/0289`. Plus ECO-IMPL W7c (2026-06-20, G-B consultant-permission prose): the `## Distribution-Durability Invariants` section (the three-way permission taxonomy A/B/C + the conjunctive composition + the Class-A member enumeration + the consultant Class-A/C reframe correcting the `specs/01 §4` E3 conflation); the paired Class-C↔Class-A orthogonality cross-ref lands in `multi-operator-coordination.md` §1. Value-anchor (loom-internal reference) + `decisions/00` DECISION-4; provenance the ECO-IMPL workstream (`journal/0281 §A2`). Plus Directive 1 (2026-07-03, co-owner-directed origination `journal/0403`): the `## Exact Gate-1 / Gate-2 Tracking` section (Gate-2 worktree-from-remote-main landing + the exact-tracking receipt requirement spanning both gates), superseding the working-tree-overlay handoff.

**Length rationale (per `rules/rule-authoring.md` MUST NOT § "Rules longer than 200 lines").** Rule body is ~511 lines (per `wc -l`), exceeding the 200-line guidance by ~311. Named rationale: **canonical-flow scope**. The rule codifies the complete artifact-distribution surface across 17 distinct sections (Authority Chain, Repo Classes ↔ Resolver, Ecosystem Forks vs Downstream Consumers, Canon Neutrality — A Tenant-Specific Gate Never Gates A Canon Build, Issue Routing By Change Type [+ Route A], Consultant Dual-Route Self-Serve, loom Splits Never Originates, Co-Owner-Directed Origination, The Origination Taxonomy O1/O2/O3, BUILD Repo Rules, Proposal Lifecycle, /sync-to-use as Only Outbound Path to Templates, Human Classifies Every Change, Intake Disclosure Scrub, Exact Gate-1 / Gate-2 Tracking [+ its paired Instantiation-Is-A-Publish / Source-Clean-At-Rest Trust Posture Wiring], Variant Overlay Semantics, Distribution-Durability Invariants) plus the trailing MUST NOT clause block. Each section carries non-overlapping invariants the artifact-flow contract requires holding simultaneously. Splitting into sub-rules would fragment the canonical-flow surface across files and force cross-rule lookups for every routing decision — exactly the load-failure mode `rules/cc-artifacts.md` Rule 6 warns against. Per `rules/rule-authoring.md` MUST NOT § "Rules longer than 200 lines": the cap is guidance; overage is permitted with named rationale anchored at the rule's Origin. Sibling precedent: `multi-operator-coordination.md` Origin + `user-flow-validation.md` Origin carry the same length-rationale shape for the same class of multi-clause structural rule.

<!-- /slot:neutral-body -->
