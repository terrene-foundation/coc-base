---
priority: 10
scope: path-scoped
paths:
  - "**/MEMORY.md"
  - "**/memory/**/*.md"
  - "journal/**"
  - "**/.session-notes*"
  - ".claude/rules/**"
  - ".claude/.proposals/**"
---

# Knowledge-Cascade Routing — Cascade-Valuable Knowledge Lands In A Manifest-Registered COC Artifact, Never Agent Memory

When the agent captures a learning — a user correction, a discovered pattern, a failure-mode, a convention, a discipline — that learning carries a ROUTING decision: where does it live so the people and agents who need it actually receive it? The harness "# Memory" default biases every capture toward the agent's `MEMORY.md`. But `MEMORY.md` is **per-account, per-repo, and NON-cascading** — it reaches no downstream consumer. A COC artifact (rule / skill / agent), once **registered in `sync-manifest.yaml`**, cascades to every downstream consumer via `/sync`. Cascade-valuable knowledge written to memory is stranded at its point of capture; the 30+ consumers never see it.

This rule intercepts the routing decision: evaluate cascade-value FIRST, route accordingly, and — on the COC path — verify the artifact is manifest-registered so it PROVABLY cascades. Memory is a non-cascading surface and an unregistered on-disk artifact is a non-cascading surface; both fail the same way.

## MUST Rules

### 1. Evaluate Cascade-Value Before Capture; Cascade-Valuable Knowledge Routes To A COC Artifact, Not Memory

Before writing any learning to `MEMORY.md` (or any per-account memory surface), the agent MUST evaluate its cascade-value: would a downstream agent, operator, or consumer repo benefit from it? If YES — a reusable principle, pattern, failure-mode, convention, or discipline that applies beyond this session / operator / repo — it MUST be codified into a COC artifact (a rule / skill / agent via `/codify`, or an O1 / co-owner origination via `/govern`), NEVER left in memory. Memory is reserved for genuinely NON-cascading, operator/session-local context (this operator's stated preference, an ephemeral session pointer, a fact meaningful only to this account). This OVERRIDES the harness "# Memory" default, which biases every capture toward memory.

```text
# DO — cascade-valuable → COC artifact (cascades to every consumer)
A user correction on HOW to communicate ("no manufactured cons at gate-stops")
applies to every agent → codify into recommendation-quality.md (coc-core tier),
NOT MEMORY.md.

# DO NOT — cascade-valuable knowledge stranded in non-cascading memory
Write "no manufactured cons at gate-stops" to MEMORY.md → the 30+ downstream
consumers never receive it; the harness default was followed with no
cascade-value evaluation.
```

**BLOCKED rationalizations:**

- "Memory is where feedback goes" (the harness default — overridden here for cascade-valuable knowledge)
- "I'll codify it later; memory captures it for now" (memory is the WRONG surface — there is no later-cascade from it)
- "It's just a preference" (a preference about how the agent works, that every agent should follow, IS cascade-valuable)
- "The memory write is faster than a codify"

**Why:** `MEMORY.md` is per-account and never enters the `/sync` distribution model; a cascade-valuable learning written there benefits exactly one account in one repo, while the same learning as a COC artifact reaches every consumer. The harness memory default is correct for local context and wrong for cascade-valuable knowledge — the evaluation is the discriminator.

### 2. A COC Artifact Is Not "Codified" Until Its Distribution Fate Is Declared In The Manifest

Codifying cascade-valuable knowledge into an on-disk COC artifact is NOT complete until the artifact's distribution fate is declared in `sync-manifest.yaml` — a tier membership (cascades to subscribers), OR a conscious `loom_only` / `use_exclude` / `use_obsoleted` state. An artifact on disk but absent from the manifest silently falls out of the subscription-based `/sync` model and never cascades — the same non-cascading failure as memory, one surface over. For rules, agents, skill directories, and commands, `emit.mjs::validateTierCompleteness` (Validator 15) is the structural backstop — an unregistered one FAILS `/sync` loud; for the remaining tier-gated type V15 does not yet cover (guides — hooks and bin scripts are `sync-tier-aware.mjs::ALWAYS_INCLUDE`, so they auto-ship and cannot silently orphan), the author MUST declare the fate consciously, because the backstop will not catch the omission.

**Scope — the manifest gate is LOOM-side, NOT the originator's.** `sync-manifest.yaml` lives ONLY at loom (the splitter/distributor). A **BUILD/canon repo** and a **USE-template repo** ORIGINATE cascade-valuable knowledge via `/codify` → `.claude/.proposals/latest.yaml` → loom Gate-1/2 (`artifact-flow.md` § "BUILD Repo Rules" + § "The Origination Taxonomy" O2/O3); their distribution fate is declared in **loom's** manifest when loom CLASSIFIES the proposal — NOT in a local manifest the originating repo does not have. The ABSENCE of a local `sync-manifest.yaml` in an originator is EXPECTED; it is NOT evidence the repo is a pull-only consumer, NOR that it is the wrong place to author. MUST-2 binds the loom Gate-1 classifier's completeness obligation, NOT a syntactic "does THIS repo hold a manifest?" test at the originator. Concluding "no local manifest here + unregistered artifacts don't cascade → this repo isn't a distribution source" is the misread this scope clause blocks: a BUILD/canon repo IS a distribution source — it cascades through the proposal path, not a local manifest.

```text
# DO — author AND register in the SAME codify
Add rules/knowledge-cascade-routing.md AND its coc-core tier entry in
sync-manifest.yaml; Validator 15 then confirms the fate is declared.

# DO NOT — author on disk, leave unregistered
Write the rule file, skip the manifest → V15 FAILS the next /sync (rules /
agents / skill-dirs / commands), OR (a net-new guides dir) it silently orphans
with no structural catch.
```

**BLOCKED rationalizations:**

- "It's on disk at loom, it'll cascade" (the manifest, not the filesystem, is the distribution membership)
- "I'll register it at /sync time" (V15 blocks the sync until you do — register upfront)
- "The tier is obvious, the emitter will infer it" (there is no inference; tiers are an explicit list)

**Why:** loom distributes by an explicit manifest membership list, not a directory glob; before Validator 15, 16 loom-authored rules were frozen out of templates for exactly this reason. Declaring the distribution fate at authoring time is what makes "codified" mean "will actually reach consumers."

### 3. The Cascading Copy Carries The Scrubbed Generic Principle; The Sensitive Specific Stays In The Local Receipt

Routing a learning to a cascading COC artifact (MUST-1) RAISES its exposure — from a low-exposure surface (`MEMORY.md` or a local journal) to a maximal-exposure one (every downstream consumer). That is a sensitivity/audience escalation in the exact sense of `rules/recommendation-quality.md` MUST-8. A learning is frequently cascade-valuable in its GENERIC principle while the SPECIFIC that surfaced it is sensitive — a tenant / customer / operator identifier, an internal path, or downstream-context. The cascading artifact MUST carry ONLY the disclosure-scrubbed generic principle; the sensitive PROVENANCE specific (the tenant / customer / operator name, the internal path) MUST stay in the NON-cascading local receipt (the `/codify` journal entry — it preserves provenance without cascading). A raw SECRET or credential is NOT a provenance item to relocate — it is omitted entirely per `rules/security.md` § "No secrets in logs" (never written to the cascading artifact NOR to the journal). Before the artifact lands, its content MUST be scrubbed per `rules/upstream-issue-hygiene.md` MUST-2 and sensitivity-checked per `rules/recommendation-quality.md` MUST-8. Routing to a cascading surface is NEVER a disclosure bypass.

```text
# DO — generic principle cascades; the specific stays in the receipt
Rule Origin: "a client ecosystem fork's Gate-1 observation." The specific
fork / tenant name lives ONLY in the /codify journal (non-cascading provenance).

# DO NOT — carry the sensitive specific into the cascading artifact
Rule Origin names the actual tenant/customer → it cascades to 30+ consumers
AND trips the Gate-2 disclosure scanner (so the rule fails to cascade at all).
```

**BLOCKED rationalizations:**

- "The provenance needs the specific name" (provenance lives in the non-cascading receipt; the cascading copy needs only the generic)
- "It's just one identifier" (one tenant token is the disclosure class the fence exists to block)
- "Codify-value outweighs the scrub" (routing to a cascading surface is NEVER a disclosure bypass)

**Why:** the cascade-routing MUST-1 mandates is itself a sensitivity escalation (local → every consumer); without the scrub, "codify it" silently cascades whatever sensitive specific surfaced the learning — and if that specific is a denylisted token, the Gate-2 scanner HALTS the whole artifact, so it fails to cascade at all. The generic principle is what carries cascade-value; the specific is provenance that belongs in the local receipt.

## MUST NOT

- Write a reusable principle / pattern / failure-mode / convention / discipline to `MEMORY.md` without first evaluating cascade-value

**Why:** the evaluation is the only step that distinguishes cascade-valuable knowledge (→ COC) from local context (→ memory); skipping it defaults every capture to the non-cascading surface.

- Treat an on-disk COC artifact as "codified" while it is absent from the distribution manifest

**Why:** an unregistered artifact is non-cascading exactly like memory; "on disk" is not "distributed."

- Carry a sensitive specific (tenant / customer / operator identifier, internal path, downstream-context) into a cascading COC artifact instead of scrubbing it to the generic principle and keeping the specific in the non-cascading local receipt (a raw secret / credential is NOT relocated at all — it is omitted entirely, never written to the cascading artifact NOR the receipt, per MUST-3 + `rules/security.md`)

**Why:** the cascade routing this rule mandates raises exposure to every consumer; an unscrubbed specific either leaks to all of them or trips the Gate-2 disclosure scanner and blocks the whole artifact from cascading.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (cc-architect at `/codify` + reviewer at `/wrapup` confirm cascade-valuable learnings routed to a COC artifact — not memory — and that every authored artifact is manifest-registered); `advisory` at the hook layer (whether a learning is cascade-valuable is a semantic judgment per `hook-output-discipline.md` MUST-2 — a lexical `PostToolUse(Write)` tripwire on `MEMORY.md` writes MAY pair as advisory but MUST NOT carry `block`).
- **Grace period:** 7 days from rule landing (2026-07-05 → 2026-07-12).
- **Cumulative posture impact:** same-class violations (cascade-valuable knowledge written to memory without a cascade-value evaluation, OR an on-disk artifact left unregistered in the manifest) contribute to `trust-posture.md` MUST Rule 4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key (a cascade-value assessment is review-layer-only and semantic; minting a key would drag `trust-posture.md`, a self-referential-codify allowlist file, into a self-ref edit; the universal `regression_within_grace` trigger already covers it).
- **Receipt requirement:** SessionStart soft-gate `[ack: knowledge-cascade-routing]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — cc-architect at `/codify` + reviewer at `/wrapup` inspect any session that wrote to `MEMORY.md` and confirm the content was genuinely non-cascading local context (not a cascade-valuable principle that belonged in a COC artifact); AND for every COC artifact authored, confirm its manifest distribution-fate is declared (Validator 15 covers rules, agents, skill directories, and commands structurally; the remaining tier-gated type — guides — is verified manually until V15 is extended; hooks + bin auto-ship via `sync-tier-aware.mjs::ALWAYS_INCLUDE` and cannot orphan). Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout, after ≥3 real sessions exercise Phase 1) — an advisory `PostToolUse(Write)` detector matching `MEMORY.md` / `*/memory/*.md` writes, paired with the review layer per `probe-driven-verification.md` MUST-4; audit fixtures at `.claude/audit-fixtures/knowledge-cascade-routing/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 (cascade-valuable knowledge mis-routed to memory) + MUST-2 (on-disk COC artifact absent from the distribution manifest) + MUST-3 (a sensitive specific carried into a cascading artifact rather than scrubbed to its generic principle).
- **Origin:** See § Origin.

## Origin

2026-07-05 — co-owner-directed origination (`artifact-flow.md` § Co-Owner-Directed Origination); receipt-first `journal/0440` carries the verbatim directives. Triggered by the agent mis-routing the "no manufactured cons at gate-stops" principle into `MEMORY.md` (a non-cascading surface). MUST-2 unifies the same-class gap surfaced in the co-owner's client-ecosystem-fork Gate-1 observation (a loom-direct-authored artifact missing from the manifest does not cascade) with the Validator-15 rules-completeness backstop (`journal/0078`, 2026-05-16). Both halves are one failure class: cascade-valuable knowledge captured in a surface that does not actually cascade downstream. Distinct from `artifact-flow.md` (which owns the proposal-distribution mechanics this rule cross-references) — this rule owns the agent-facing knowledge-CAPTURE routing decision.
