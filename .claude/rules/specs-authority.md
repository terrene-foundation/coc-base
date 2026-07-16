---
priority: 10
scope: path-scoped
paths:
  - "**/specs/**"
  - "**/specs/_index.md"
  - "**/workspaces/**"
  - "**/briefs/**"
  - "**/02-plans/**"
  - "**/todos/**"
---

# Specs Authority Rules

See `.claude/guides/rule-extracts/specs-authority.md` for Rule 5b/5c evidence (two-session reproducibility + W32/W33 amend-at-launch post-mortem) and extended examples.

The `specs/` directory is the single source of domain truth for a project. Detailed spec files organized by the project's own ontology — components, modules, user needs, domains. Phase commands read targeted spec files before acting and update them when domain truth changes.

`specs/` is NOT a process artifact (that's `workspaces/`). It is the detailed record of WHAT the system is and does, not HOW we are building it. Plans, todos, and journals continue to serve their existing roles.

Origin: Analysis of 6 alignment-drift failure modes across COC phase system.

## MUST Rules

### 1. Every Project Has A `specs/` Directory With `_index.md`

`/analyze` MUST create `specs/` at project root with an `_index.md` manifest listing every spec file + one-line description. Phases read `_index.md` to find relevant files, then read only those.

```markdown
# DO — lean lookup table

| File              | Domain | Description                              |
| ----------------- | ------ | ---------------------------------------- |
| authentication.md | Auth   | Login/register flows, JWT, session mgmt  |
| data-model.md     | Data   | All entities, relationships, constraints |

# DO NOT — actual specifications inline in \_index.md
```

**Why:** Without an index, phases must read every spec file to find relevant content, defeating token efficiency. Without specs/, alignment drifts as phases work from stale memory.

### 2. Spec Files Are Organized By Domain Ontology, Not Process

```
# DO — domain-organized
specs/authentication.md / billing.md / data-model.md / notifications.md / tenant-isolation.md

# DO NOT — process-organized (duplicates workspaces/)
specs/intent.md / decisions.md / progress.md / boundaries.md
```

**Why:** Process-organized specs duplicate the workspace directory structure. Domain-organized specs capture WHAT the system does — exactly what drifts during implementation.

### 3. Spec Files Are Detailed, Not Summaries

Each spec file MUST be comprehensive enough to be the authority on its topic. Every nuance, constraint, edge case, contract, decision.

```markdown
# DO — detailed authority

## Login Flow

1. User submits email + password to POST /api/v1/auth/login
2. Server validates credentials against bcrypt hash
3. On success: generate JWT (RS256, 24h expiry), set HttpOnly cookie
4. On failure: increment failed_attempts
5. If failed_attempts >= 5: lock account, require email verification
6. Rate limit: 10 attempts per IP per minute (429)

# DO NOT — thin summary

## Login Flow

Users can log in with email and password. JWT is used. Failed logins tracked.
```

**Why:** Thin summaries lose the exact details agents need. "JWT tokens are used" doesn't tell the agent RS256 vs HS256, expiry, cookie strategy — these omissions become the bugs.

### 4. Phase Commands Read Specs Before Acting

Each phase MUST read `specs/_index.md` at start, identify relevant files, read those before taking action. MUST NOT read the entire `specs/` directory — only files relevant to current work.

**Why:** Working from memory instead of specs is the root cause of incremental mutation divergence (FM-5). Agents recall 3 of 15 details; the other 12 become bugs.

### 5. Spec Files Are Updated At First Instance

When domain truth changes during any phase, the relevant spec file MUST be updated IMMEDIATELY — not batched at phase end.

```
# DO — update when the truth changes
1. Implement todo changing UserService.create_user() signature
2. Immediately update specs/user-management.md with new signature
3. Continue

# DO NOT — batch for later
```

**Why:** Batched updates create a staleness window where other agents or the next session read outdated specs. First-instance updates keep specs current within one action.

### 5b. Spec Edits MUST Trigger Full Sibling-Spec Re-Derivation

Every spec edit MUST trigger a re-derivation sweep against the FULL sibling-spec set in the same domain (editing `specs/ml-engines.md` triggers all `specs/ml-*.md`). Scoping to "specs I just edited" is BLOCKED — three categories of finding ONLY emerge from full-sibling sweep:

1. **Field-shape divergence** — sibling specs reference changed dataclass differently
2. **Downstream consumer drift** — specs whose mandates depend on changed surface are now stale
3. **Cross-spec terminology drift** — same concept named two ways across files

```bash
# DO — edit one spec, grep ALL siblings for references, re-derive assertions
ls specs/ml-*.md                          # enumerate full sibling set
grep -l "TrainingResult" specs/ml-*.md    # find downstream consumers
# Re-derive for EACH matching sibling, not just the edited file

# DO NOT — narrow scope
# (ml-backends.md references TrainingResult.backend/.devices as top-level fields
#  after ml-engines.md moved them — drift invisible to narrow scope)
```

**BLOCKED rationalizations:** "I only edited one spec, others are out of scope" / "/redteam scoped to diff is faster" / "siblings re-derive when THEY are edited" / "cross-spec drift is codify's concern" / "round 3 was green on edited specs, re-run is redundant".

**Why:** Spec domains share vocabulary, dataclasses, invariants; editing one dataclass without re-deriving the full sibling set lets narrow-scope APPROVE verdicts ship with silent cross-spec drift. Two-session reproducibility (journal 0007 / 0008) confirmed: narrow-scope sweep produced "14/14 green" APPROVE; full-sibling sweep found 9 HIGH cross-spec drift findings in specs the edit never touched.

### 5c. Orchestrator MUST Amend Todo Text At Launch When Spec Has Moved

Before launching any `/implement` shard agent, orchestrator MUST cross-check todo claims (version bumps, `__all__` counts, public-surface symbol lists, spec section refs) against current canonical spec AND current package state (`pyproject.toml`, `__init__.py`, prior merged shards). Discrepancies MUST be resolved IN THE TODO TEXT before launch — not left for the agent to discover mid-implementation. Launching with a known-stale todo is BLOCKED.

```markdown
# DO — amend at launch time, note inline

Todo W32b says: "bump kailash-align 0.4.0 → 0.5.0"
Current state: W30.3 already shipped align 0.5.0 (commit 41a217dc).
→ AMEND AT LAUNCH: "bump kailash-align 0.5.0 → 0.6.0"

Todo W33 says: "`__all__` exports 34 symbols"
Spec §15.9 says: "`__all__` exports 41 symbols (40 + erase_subject)"
→ AMEND AT LAUNCH: prefer spec per §5b, prompt agent with 41.

# DO NOT — launch with stale todo, let agent hit the conflict mid-flight
```

**BLOCKED rationalizations:** "agent is smart enough to read current state" / "todo was approved, amending is scope creep" / "let the agent hit the conflict and learn" / "spec will be re-read at implement time anyway".

**Why:** Todos are written at `/todos` time against state-of-repo-then; by `/implement` time the state has moved — prior shards have shipped, specs have been edited during `/redteam` convergence. An orchestrator that launches a stale todo burns the agent's budget on re-derivation AND risks shard failure (version-tag collision, symbol-count mismatch). 2-minute launch-time amendment < ANY shard re-run. Evidence: kailash-ml-audit 2026-04-23 W32-32b (0.5→0.6 amend) + W33 (34→41 symbol count) — both saved failed shards.

### 6. Deviations From Spec Require Explicit Acknowledgment

When implementation deviates from a spec, agent MUST: (a) update the spec with new truth, (b) log deviation with rationale, (c) flag user-visible changes for approval.

```markdown
# DO

## Notifications

~~Real-time via WebSocket~~ → Polling every 5s (changed 2026-04-11)
**Reason:** WebSocket requires dedicated server; polling achievable with current infra
**User impact:** 5s delay. User notified: YES

# DO NOT — silent divergence (spec says WebSocket, code does polling, nobody knows)
```

**Why:** Silent deviations are #1 cause of "it works but it's not what I asked for." The spec is the contract.

**BLOCKED responses:** "the spec said X, and X is implemented" (when approach differs) / "implementation detail, not a spec change" / "spec is aspirational, code is what matters" / "I'll update after implementation stabilizes".

### 7. Agent Delegation Includes Relevant Spec Files

When delegating to a specialist, orchestrator MUST read `_index.md`, select relevant spec files, include content in the delegation prompt. For specs over 200 lines, include only the relevant section with a pointer to the full file.

```
# DO — include spec content
Agent(prompt: "Build user schema.\n\nFrom specs/data-model.md:\n[content]\n\nFrom specs/tenant-isolation.md:\n[content]")
# DO NOT — delegate without specs context
Agent(prompt: "Build user schema.")
```

**Why:** Specialists without spec context produce intent-misaligned output — e.g., schemas without tenant_id because multi-tenancy wasn't communicated (FM-4).

### 8. Large Spec Files Are Split

When a spec file exceeds 300 lines, it MUST be split into sub-domain files and `_index.md` updated. Each sub-file must be self-contained for its sub-domain.

**Why:** Oversized spec files crowd out implementation reasoning when loaded into context, and make delegation prompts enormous.

### 9. Workspace Specs Reference Canonical Artifacts (Not Restate)

When a workspace spec describes the mechanism of a canonical artifact (a command, rule, skill, hook, or agent under `.claude/`), the spec MUST cite the artifact by a grep-stable anchor (`<path> §<section>` or a named symbol) rather than restating the artifact's verbatim content. Prefer the grep-stable form per `symbol-anchored-citations.md` — a bare `<path>:<line>` is the paired-hint case only (it MUST accompany a symbol, never stand alone), because line numbers drift the moment the cited file is edited.

```text
# DO — workspace spec references canonical source by a grep-stable anchor

The frontmatter-lint in `.claude/commands/cc-audit.md` — its `awk` frontmatter-block
guard, keyed on the `i==1` predicate (grep-stable; `~line 35` as a paired hint) —
flags any non-`paths:` key in opening rule frontmatter. The `i==1` predicate is what
preserves block-scoping.

# DO NOT — workspace spec restates the implementation

awk 'FNR==1{i=0} /^---$/{i++; next} i==1 && ...' .claude/rules/*.md

(verbatim copy of the `awk` line that already lives in the `cc-audit.md`
frontmatter-block guard — updating one without the other creates silent drift)
```

**BLOCKED responses:**

- "Restating makes the spec self-contained, which is more readable"
- "The reader shouldn't have to open the canonical artifact to understand the spec"
- "Specs and canonical artifacts will stay in sync; nothing to worry about"
- "Both versions are short — duplication is fine"

**Why:** Workspace specs describe semantics while canonical artifacts encode implementation; restating implementation in specs creates parallel sources of truth that drift silently. The reference style forces the canonical artifact to be the single source of truth and forces specs to focus on what they uniquely contribute — semantics, invariants, and rationale.

**Exception:** Educational specs in `.claude/rules/` that show DO / DO NOT implementations per `rules/cc-artifacts.md` MUST §3 are explicitly NOT covered by this rule — those examples teach by restating. The exception applies only to _workspace_ specs (under `workspaces/<project>/specs/`), not canonical rule files.

Origin: atelier `cc-audit-lint-generalize` 2026-05-03 (test fixtures and spec canonicalization deferred to /codify; /vet adversarial round L1). Inbound from atelier `/sync-to-coc`.

### 10. Knowledge-Product Links Use A `knowledge-product:` Field Carrying A Runtime-Resolved `kp://` URN, Inert At Loom

A spec section MAY bind its domain truth to a queryable knowledge product via a **`knowledge-product:` field** whose value is a `kp://<owning_level>/<domain>/<name>@<version>` URN. The field-type is **governed**: it is the ONLY sanctioned way a spec names a data/knowledge product. Five invariants are DECIDED and are stated here in this rule's own voice, so the rule is self-sufficient in every repo it lands in:

1. **`kp://`-scheme URN required.** A value that is not a `kp://` URN — a bare table name, an identifier, a path — is BLOCKED.
2. **Ecosystem-relative.** The URN MUST NOT embed the ecosystem/tenant slug (embedding leaks the ecosystem downstream AND makes the product un-cascadeable).
3. **`<domain>` is an OPAQUE handle.** It carries no readable semantics AND MUST NOT be derivable from the readable name by any party holding the URN.
4. **No readable client / engagement / tenant name in ANY segment** — `<domain>` and `<name>` alike. A readable PRODUCT name in `<name>` is legitimate (`churn-features`); a client-qualified one (`acme-churn-features`) is BLOCKED.
5. **Inert at loom — loom REGISTERS the identity, never BINDS the downstream link.** loom WRITES (**REGISTERS**) the identity string — the `kp://` URN — into its own control-plane registry, and MUST NOT resolve the URN to a physical reservoir, query it, or materialize its bytes inside a loom session (resolution happens at runtime, in the engine). loom MUST NOT author the downstream `knowledge-product:` **LINK** either: a spec section's `knowledge-product:` binding is authored (**BOUND**) by the DOWNSTREAM domain-spec OWNER, in its OWN repo, resolving against the cascaded registry identity — never cross-written from a loom session (`/distill` REGISTERS the identity; the domain-spec owner owns the link's write-act). This preserves `repo-scope-discipline.md` (loom never cross-writes a sibling repo) while keeping the identity's mint/registration at loom.

**Derivation is REFERENCED, never restated (Rule 9).** HOW an opaque handle is CONSTRUCTED — random vs keyed-hash, entropy floors, key custody, truncation — is OWNED by the mesh knowledge-product identity spec ((loom-internal reference) § "`<domain>` is an OPAQUE HANDLE") and is NOT restated here, so a derivation refinement resolves through the reference without re-authoring this rule. **Stated plainly rather than cited as a phantom: that path is a loom-side workspace artifact that resolves in loom (the authoring/audit repo) but does NOT resolve in a consumer repo.** Consumers do not need it — a handle is MINTED LOCALLY at the project's handle vault (where the readable name and the minting key live); only the OPAQUE handle is registered at loom's control-plane, so loom never sees the readable name at registration. The five invariants above ARE the complete contract for AUTHORING or AUDITING a `knowledge-product:` field. Where a repo does carry a local mesh identity spec, that spec is authoritative on derivation; this rule is authoritative on the five invariants.

```text
# DO — governed field, opaque <domain>, readable PRODUCT name, inert at loom

## Churn-risk scoring
...domain truth about how churn risk is computed...
knowledge-product: kp://use/<opaque-handle>/churn-features@3
   (<opaque-handle> is minted LOCALLY at the project vault — this rule does not
    own its representation; the spec names the identity and never queries it)

# DO NOT — non-URN value

knowledge-product: churn_features_table
   (not a kp:// URN — invariant 1)

# DO NOT — readable client slug in <domain>

knowledge-product: kp://use/acme-corp/churn@3
   (readable client name — leaks + un-cascadeable; invariants 3 + 4)

# DO NOT — ANY readable <domain>, even one that names no client

knowledge-product: kp://use/logistics/churn-features@3
   ("logistics" names no client, but a readable <domain> is still BLOCKED — invariant 3)

# DO NOT — a <domain> derived FROM the readable name

knowledge-product: kp://use/7f3a9c21/churn-features@3
   (looks opaque, is NOT — a handle computable from the readable name is BLOCKED;
    invariant 3. The derivation contract is the mesh identity spec's, not this rule's.)

# DO NOT — readable CLIENT name in <name>, even when <domain> IS opaque

knowledge-product: kp://use/<opaque-handle>/acme-churn-features@3
   (invariant 4 — a client / engagement / tenant name is BLOCKED in EVERY segment;
    "churn-features" is a legitimate PRODUCT name, "acme-churn-features" is not)

# DO NOT — resolve the referent inside a loom session

db.product("kp://…").query()   # "just checking the link points somewhere"
   (invariant 5 — resolution is the engine's job at runtime, never loom's)

# DO — the DOWNSTREAM domain-spec owner BINDS the link in its OWN repo
#      (loom's /distill only REGISTERED the identity into loom's control-plane)

## (a build/use domain spec, authored by its OWNER in the consumer repo)
knowledge-product: kp://use/<opaque-handle>/churn-features@3
   (invariant 5 — /distill REGISTERED this identity at loom; the domain-spec
    owner writes THIS binding in its own repo — no loom cross-write)

# DO NOT — a loom session (/distill) cross-writes the link into a downstream spec

# loom session edits ../<consumer-repo>/specs/churn.md to add:
knowledge-product: kp://use/<opaque-handle>/churn-features@3
   (invariant 5 — loom REGISTERS the identity but MUST NOT author the downstream
    LINK; that write-act is the domain-spec owner's, in its own repo —
    repo-scope-discipline.md forbids the loom cross-write)
```

**BLOCKED rationalizations:**

- "I'll resolve the `kp://` link in-session just to confirm it points somewhere"
- "It's only a name lookup, not really running the engine inside loom"
- "The `<domain>` segment can carry the client name — the containment gate needs it" (the URN stays ecosystem-relative; the readable client↔handle mapping lives ONLY in the local non-cascading handle vault, never the URN — and "vault" not "registry": the loom-pulled catalog is a different store, and conflating them is what leaks the map)
- "The `<domain>` is a hash of the name, so it IS opaque" (invariant 3 — a handle DERIVABLE from the readable name is BLOCKED; what counts as non-derivable is the mesh identity spec's contract, not this rule's to restate)
- "A bare readable product name is fine in place of the URN; ecosystem-relative is pedantic" (invariant 1 — the URN is required; this is about substituting a bare name FOR the URN, not about the `<name>` segment, which is legitimately a readable PRODUCT name)
- "The client name is fine in `<name>` since only `<domain>` must be opaque" (invariant 4 — a readable client / engagement / tenant name is BLOCKED in EVERY segment; `kp://use/<opaque-handle>/acme-churn-features@3` is BLOCKED)
- "A plain table/identifier name is close enough to a `kp://` URN"
- "`/distill` is specified to WRITE the link, so a loom session authors it into the downstream spec" (invariant 5 — `/distill` REGISTERS the identity at loom's control-plane; the `knowledge-product:` LINK is BOUND by the downstream domain-spec owner in its OWN repo, never cross-written from a loom session — the register-vs-bind split is what holds `repo-scope-discipline.md`)

**Why:** The link makes `specs/` an authority on WHAT + WHERE-to-query, but a loom session that RESOLVES it would run engine code inside the splitter (a "no coding here" violation), and a readable or name-derivable segment would leak the client downstream to 30+ consumers and make the product un-cascadeable. Keeping the field governed + inert is the guard that must precede any cataloging of products. The REGISTER-vs-BIND split is that same guard on the WRITE side: loom REGISTERS the identity (its control-plane), but a downstream `knowledge-product:` link is BOUND by the domain-spec owner in its own repo — a loom session authoring that link would be exactly the sibling-repo cross-write `repo-scope-discipline.md` blocks.

## MUST NOT

- Organize specs by COC process stages (duplicates workspaces/)
- Read entire `specs/` at any phase gate (except `/redteam`, `/codify` audit)
- Treat specs as optional documentation

**BLOCKED:** "Specs can be written after implementation" / "The code is the spec" / "Plans already capture this" / "Updating specs for minor change is overkill"

Origin: 6 drift failure-mode analysis + journal 0007 / 0008 (full-sibling re-derivation, 2026-04-19/20) + kailash-ml-audit 2026-04-23 (amend-at-launch W32/W33). See guide for full two-session post-mortem.

## Trust Posture Wiring — Rule 10 (knowledge-product field-type)

Applies to the **Rule 10** clause (added 2026-07-11, Mesh S0 `/govern` co-owner-directed origination; the invariant-5 **REGISTER-vs-BIND** clarification added 2026-07-13, Mesh C7 `/govern` co-owner-directed origination — `journal/0480` — is covered by this same clause-scoped Wiring). Per `trust-posture.md` MUST-8 grandfather cutoff, Rule 10 lands AT/AFTER the MUST-8 SHA and MUST ship canonical-8-field-compliant; the pre-existing grandfathered Rules 1–9 + § MUST NOT remain exempt until each is itself `/codify`-touched (the clause-scoped precedent set by `rule-authoring.md`'s own Wiring section + `security.md` § Enforcement-Surface Parity + `git.md` § CI-check/merge).

- **Severity:** `halt-and-report` at gate-review (cc-architect at `/codify` + reviewer at `/redteam` confirm a `knowledge-product:` field carries a `kp://`-scheme runtime-resolved URN, that the URN is ecosystem-relative, that no loom session resolves/queries the referent, AND — register-vs-bind — that no loom session AUTHORS/cross-writes a downstream `knowledge-product:` LINK: `/distill` REGISTERS the identity, the downstream domain-spec owner BINDS the link in its own repo); `advisory` at the hook layer (a `knowledge-product:` value's `kp://` prefix MAY be lexically checked, but the inert-at-loom / no-in-session-resolution / no-cross-write property is judgment-bearing per `hook-output-discipline.md` MUST-2 and MUST NOT carry `block`).
- **Grace period:** 7 days from clause landing (2026-07-11 → 2026-07-18).
- **Cumulative posture impact:** same-class violations (a `knowledge-product:` field with a non-`kp://` value or an embedded ecosystem/tenant slug, a loom session resolving/querying the referent, OR a loom session authoring/cross-writing a downstream `knowledge-product:` LINK instead of only REGISTERING the identity) contribute to `trust-posture.md` MUST Rule 4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key (a spec-field-convention property is review-layer-only + semantic; minting a key would drag `trust-posture.md`, a self-referential-codify allowlist file, into a self-ref edit; the universal `regression_within_grace` trigger already covers it). Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8 — the same no-dedicated-key disposition `security.md` § Enforcement-Surface Parity and `git.md` § CI-check/merge took.
- **Receipt requirement:** SessionStart soft-gate `[ack: specs-authority]` IFF `posture.json::pending_verification` includes the `specs-authority` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — cc-architect at `/codify` + reviewer at `/redteam` inspect any spec edit adding or altering a `knowledge-product:` field: confirm the value is a `kp://`-scheme URN, ecosystem-relative (no tenant/ecosystem slug embedded), the grammar is referenced not restated (Rule 9), the session did NOT resolve/query the referent, AND (register-vs-bind) the session did NOT author/cross-write a downstream `knowledge-product:` link from loom — `/distill` REGISTERS the identity at loom's control-plane; the downstream domain-spec owner BINDS the link in its own repo (a loom edit adding a `knowledge-product:` line to a sibling/consumer repo's spec is the violation). Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — an advisory `PostToolUse(Edit|Write)` lexical tripwire flagging a `knowledge-product:` value that lacks a `kp://` prefix MAY pair with the review layer per `probe-driven-verification.md` MUST-4; audit fixtures land with the Phase-2 detector at `.claude/audit-fixtures/knowledge-product-field-type/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** the Rule 10 knowledge-product-field-type clause ONLY (clause-scoped); the pre-existing grandfathered Rules 1–9 + § MUST NOT stay exempt until each is itself `/codify`-touched.
- **Origin:** journal/0466 (Mesh S0 `/govern` co-owner-directed origination) + the mesh identity spec `02-knowledge-product-identity.md` § "The URN"; ratified roadmap `01-wave-roadmap.md` § S0. Invariant-5 REGISTER-vs-BIND clarification: `journal/0480` (Mesh C7 `/govern` co-owner-directed origination, ratified B2 — the registrar model resolving the C7 downstream-link authoring path; roadmap `01-wave-roadmap.md` § Wave-3 "ONE remaining governance step").

**Length rationale (per `rules/rule-authoring.md` MUST NOT § "Rules longer than 200 lines").** Rule body is ~323 lines (per `wc -l`), over the 200-line guidance. Named rationale: **specs-authority-contract scope** — the rule codifies the complete specs-as-domain-truth contract across its numbered rules (1–10 plus the 5b/5c sub-rules): the `specs/` + `_index.md` requirement, domain-ontology organization, detail-not-summaries, phase-command read-before-act, first-instance update + sibling re-derivation + at-launch todo amendment, deviation acknowledgment, delegation spec-inclusion, large-file split, workspace-specs-reference-not-restate, and the Rule 10 `knowledge-product:` field-type — each carrying the DO/DO-NOT + `**Why:**` the meta-rule mandates, plus the canonical 8-field Trust-Posture Wiring the post-cutoff Rule 10 requires. The rule is `priority: 10` + `scope: path-scoped`, so it pays NO baseline-emission cost (loaded only in sessions matching its `paths:` globs) and `rule-authoring.md` Rule 10's proximity-band gate does NOT fire. Splitting the domain-truth rules into siblings would fragment the one contract every spec edit consults and force cross-rule lookups. Sibling precedent: `artifact-flow.md` + `cc-artifacts.md` + `sync-completeness.md` length rationales.
