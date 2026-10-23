---
priority: 10
scope: path-scoped
paths:
  - "**/.claude/commands/codify.md"
  - "**/.claude/commands/sync-from-downstream.md"
  - "**/.claude/commands/sync-from-template.md"
  - "**/.claude/.proposals/**"
  - "**/.claude/rules/issue-triage-routing.md"
  - "**/.claude/skills/issue-triage-routing/**"
  - "**/.claude/hooks/lib/gc-*.js"
  - "**/.claude/VERSION"
  - "**/02-plans/**"
---

# Artifact Flow — Routing: Issues, Upflow And Tenant Gates

<!-- slot:neutral-body -->

Pointer — **companion**, as cited below, is `.claude/guides/rule-extracts/artifact-flow.md`.

### Issue Routing By Change Type

Every artifact-or-code issue MUST be routed by the TYPE of change it requests, not by which repo is convenient:

- **COC-artifact improvement** (method, rules, skills, agents, COC-tooling) → file the issue against the **USE-template repo** (`kailash-coc-*`); it originates a proposal via `/codify` per `guides/co-setup/09-proposal-protocol.md` Step 7b.
- **Bug / code / feature / code-improvement** (SDK code) → file the issue against the **BUILD repo**; it considers **cross-SDK FIRST**, then originates a proposal via `/codify`.

**Why:** Routing by repo convenience puts a COC-method fix onto a code-only lane (it never becomes an artifact proposal) or an SDK bug onto the artifact lane (it never reaches the code fix); either way the Gate-1 global-vs-variant split is bypassed and the change loses its provenance.

#### Downstream-Consumer Routing (.session-notes shorthand: Route A)

A **downstream consumer** is any repo that pulled COC artifacts FROM a USE template (enumeration: `sync-manifest.yaml::repos` + `guides/co-setup/09-proposal-protocol.md` Step 7b). It routes COC-method improvements UP to the **USE template it pulled from** — NOT to its own project repo AND NOT to `loom` directly — via one of two paths:

- **Primary — Step 7c upflow (push-only, human-gated):** the consumer's OWN `/codify` Step 7c originates a COC-artifact proposal and offers it as a HUMAN-GATED PR to the template's `.claude/.proposals/inbox/<date>-<slug>.yaml` (`upstream-issue-hygiene.md` MUST-1). The template's `/sync-from-downstream` scrubs, dedups and relays accepted entries into its OWN Step-7b manifest with hop-level provenance, whence loom Gate-1 and the next `/sync-to-use`. Schema + relay mechanics: companion § Downstream-Consumer Routing — Step-7c Upflow Mechanics.
- **Fallback — Route A (issue on the template):** for no-fork-permission and stale (pre-7c) consumers, file a COC-method issue against the USE template; the template's `/codify` originates the proposal per Step 7b. RETAINED as the fallback, not the default.

**BLOCKED rationalizations:** see `.claude/guides/rule-extracts/artifact-flow.md` § Downstream-Consumer Routing — BLOCKED Rationalizations.

**Disclosure fence (scenario 8) — QUADRUPLE on the public-fork axis.** Four scrubs run before any public-fork exposure, and hop-level-only provenance carries no consumer identity even before they do: companion § Disclosure Fence (Scenario 8) — The Four Scrubs.

#### Consultant Dual-Route Self-Serve (D4)

A **business-consultant** operating at a `coc-project` consumer MUST be able to act on EVERY `/codify` finding WITHOUT talking to an engineer. Findings split by TYPE onto two EXISTING lanes — the **dual-route** — and the consultant-facing contract is that ONE `/codify` covers both, async and human-gated:

- **Artifact improvement** (method / rule / skill / agent / COC-tooling) → the **Step-7c upflow** (§ Downstream-Consumer Routing above): a LOCAL proposal manifest + a human-gated push-only PR to the template's `.claude/.proposals/inbox/`. **SHIPPED.**
- **Capability gap / bug** (a missing SDK capability the consultant worked around, or an SDK defect) → an **auto-drafted, human-gated BUILD issue** (§ Issue Routing By Change Type — cross-SDK-first), scrubbed per `upstream-issue-hygiene.md` MUST-1 (human gate before filing) + MUST-2/3 (downstream-context redaction + minimal-repro shape).

**Invariant (D4, RATIFIED — `decisions/00` DECISION-4):** the consultant **self-serves and NEVER talks to an engineer**; the PR / issue IS the async hand-off, and the human gate at each lane is the trust gate.

**The dual-route classifier is SHIPPED**, wired at `commands/codify.md` Step 7c; the Layer-2 capability-vs-bug judgment is left to the LLM + human gate, by design. Full wiring: companion § Consultant Dual-Route Classifier — Shipped Implementation.

### Canon Neutrality — A Tenant-Specific Gate Never Gates A Canon Build

A **canon** mechanism is tenant-neutral by construction (§ "Ecosystem Forks vs Downstream Consumers" above). A **tenant-specific decision or gate** — a works-council co-determination, a customer sign-off, a tenant legal/compliance approval — belongs to ONE tenant's internal governance. The two MUST NOT be coupled.

- **A tenant-specific decision/gate MUST NOT gate a tenant-neutral canon build.** Making a canon mechanism's roadmap wait on one tenant's works-council / legal / sign-off process couples canon to that tenant's internal governance — a canon-neutrality violation that also stalls every OTHER tenant. Canon builds proceed; the tenant gate lives at the fork.
- **Canon mechanisms are policy/granularity-AGNOSTIC.** Canon emits the maximally-accountable / most-general form and treats tenant-specific narrowing (coarsening, granularity, policy selection) as a CONFIGURABLE DOWNSTREAM operation. The tenant-specific policy + its legal gates live at the FORK / compliance lane (§ Ecosystem Forks + § The Origination Taxonomy O1 ecosystem-scope), NEVER baked into a canon build.
- **Scrubbing a tenant NAME does NOT fix a tenant-COUPLING.** DISTINCT failure modes: a leaked identifier is a DISCLOSURE leak (fixed by genericizing the token — the Intake / publish scrubs); a tenant-specific gate/decision embedded in a canon artifact is an ARCHITECTURAL coupling (fixed by RELOCATING the gate to the fork). A session may fix the first and silently propagate the second.
- **Behavioral corollary (MUST):** when an external / human gate appears on a canon mechanism, the agent MUST question whether the gate belongs at canon AT ALL — not defer to it as a given. Treating a mis-placed tenant gate as an `autonomous-execution.md` "human-authority gate" and deferring to it is how the coupling propagates.

Pointer — § Ecosystem Forks vs Downstream Consumers and § The Origination Taxonomy (its O1 ecosystem-scope paragraph), cited above, are in `artifact-flow.md`, a part that does not load on every path this one does.

**Why:** Canon is a multi-tenant-shared surface; coupling its roadmap to one tenant's governance stalls every other tenant and imports tenant-specific concerns into the neutral substrate. The name-vs-coupling distinction is load-bearing: the tooled disclosure scrub can PASS while the architectural coupling ships unfixed. Full reasoning: companion § Canon Neutrality — Why (full).

**BLOCKED rationalizations:** see `.claude/guides/rule-extracts/artifact-flow.md` § Canon Neutrality — BLOCKED Rationalizations.

Probes: `.claude/test-harness/probes/artifact-flow-routing.probes.json` (fixtures `.claude/audit-fixtures/artifact-flow/`).

Depth — the Trust-Posture Wiring, the rule-graph cross-references and the Origin record — lives in `.claude/skills/32-trust-posture/wiring/artifact-flow-routing.md`, which every validator reads as part of this rule.

<!-- /slot:neutral-body -->
