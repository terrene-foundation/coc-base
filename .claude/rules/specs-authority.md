---
priority: 10
scope: path-scoped
paths:
  - "**/specs/**"
  - "**/workspaces/**"
  - "**/briefs/**"
  - "**/02-plans/**"
  - "**/todos/**"
---

# Specs Authority Rules

Depth companion — cited below as **guide** — is `.claude/guides/rule-extracts/specs-authority.md`, where every `guide § "…"` pointer below resolves.

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

**Why:** Spec domains share vocabulary, dataclasses, invariants; editing one dataclass without re-deriving the full sibling set lets narrow-scope APPROVE verdicts ship with silent cross-spec drift. Two-session reproducibility (journal 0007 / 0008): guide § "Rule 5b / 5c evidence tails".

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

**Why:** Todos are written at `/todos` time against state-of-repo-then; by `/implement` time the state has moved — prior shards have shipped, specs have been edited during `/redteam` convergence. An orchestrator that launches a stale todo burns the agent's budget on re-derivation AND risks shard failure. Cost accounting + evidence (W32-32b + W33): guide § "Rule 5c — Amend-At-Launch: W32 + W33 Evidence".

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

Origin: guide § "Rule 9 Origin".

### 10. Knowledge-Product Links Use A `knowledge-product:` Field Carrying A Runtime-Resolved `kp://` URN, Inert At Loom

A spec section MAY bind its domain truth to a queryable knowledge product via a **`knowledge-product:` field** whose value is a `kp://<owning_level>/<domain>/<name>@<version>` URN. The field-type is **governed**: it is the ONLY sanctioned way a spec names a data/knowledge product. Five invariants are DECIDED, stated here in this rule's own voice:

1. **`kp://`-scheme URN required.** A value that is not a `kp://` URN — a bare table name, an identifier, a path — is BLOCKED.
2. **Ecosystem-relative.** The URN MUST NOT embed the ecosystem/tenant slug (embedding leaks the ecosystem downstream AND makes the product un-cascadeable).
3. **`<domain>` is an OPAQUE handle.** It carries no readable semantics AND MUST NOT be derivable from the readable name by any party holding the URN.
4. **No readable client / engagement / tenant name in ANY segment** — `<domain>` and `<name>` alike. A readable PRODUCT name in `<name>` is legitimate (`churn-features`); a client-qualified one (`acme-churn-features`) is BLOCKED.
5. **Inert at loom — loom REGISTERS the identity, never BINDS the downstream link.** loom WRITES (**REGISTERS**) the `kp://` URN into its own control-plane registry, and MUST NOT resolve it to a physical reservoir, query it, or materialize its bytes inside a loom session (resolution is the engine's, at runtime). loom MUST NOT author the downstream `knowledge-product:` **LINK** either: that binding is authored (**BOUND**) by the DOWNSTREAM domain-spec OWNER, in its OWN repo, against the cascaded registry identity — never cross-written from a loom session (`/distill` REGISTERS; the domain-spec owner owns the link's write-act).

**Derivation is REFERENCED, never restated (Rule 9).** HOW an opaque handle is CONSTRUCTED is OWNED by the mesh knowledge-product identity spec and is NOT restated here; the five invariants above ARE the complete contract for AUTHORING or AUDITING a `knowledge-product:` field.

Depth — Rule-10 body depth — lives in `.claude/guides/rule-extracts/specs-authority.md` § "Relocated 2026-09-13 — Rule 10 / Rule 11 body depth".

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

**Why:** The link makes `specs/` an authority on WHAT + WHERE-to-query, but a loom session that RESOLVES it would run engine code inside the splitter (a "no coding here" violation), and a readable or name-derivable segment would leak the client downstream to 30+ consumers and make the product un-cascadeable. The REGISTER-vs-BIND split is that same guard on the WRITE side: loom REGISTERS the identity (its control-plane), but a downstream `knowledge-product:` link is BOUND by the domain-spec owner in its own repo — a loom session authoring that link would be exactly the sibling-repo cross-write `repo-scope-discipline.md` blocks.

### 11. Every Codified Artifact Is Bound To Its Origin By A `derives_from[]` Provenance Edge

Every artifact `/codify` generates or updates — agent / skill / rule / hook — MUST be bound to the spec + workspace rationale it was distilled from by a **`derives_from[]` PROV edge** emitted at the Step 3/4 artifact-emission point of `.claude/commands/codify.md`. The edge is a BYPRODUCT of the existing `/codify` pass, never a separate provenance-authoring step. Four invariants are load-bearing:

1. **One record per artifact, never omitted.** Emitting an artifact with no edge record is BLOCKED. `derives_from: []` (the empty array) IS the first-class **ORPHAN SIGNAL** the reverse-index sweep reads — it MUST be emitted, never suppressed to make the corpus look fully-backed.

   **The ONE sanctioned exception — a REJECTED citation (explicit, not implicit).** When an anchor fails invariant 2 (does not resolve, resolves ambiguously, is a bare line number), the emitter writes NO row and fails LOUD; that is sanctioned, and it is NOT the omission this invariant blocks. **Compensating control (load-bearing):** the rejection MUST surface as a non-zero exit from `.claude/bin/emit-derives-from.mjs` and the session MUST NOT proceed past it — an ignored rejection IS the BLOCKED omission. **Re-emission is idempotent by CONSUMER rule, not producer state:** the consumer MUST treat the LAST row per (`artifact_id`, `session_id`) as current and earlier rows as superseded — a v0 SEMANTIC rule, not a shape change. The v0-frozen-shape rationale, the `unresolved_anchors` v1 path, and the re-run/partial-batch mechanics: guide § "Rule 11 invariant-1 depth".

2. **Every anchor is grep-stable AND resolves TODAY — non-vacuously and UNIQUELY.** Each endpoint is a `<path>#§<section>` heading or a `<path>::<symbol>`, resolvable against the CURRENT tree (`symbol-anchored-citations.md` MUST-1). BLOCKED: a bare line number; an anchor that does not resolve; a locator so short it resolves by substring accident; and an AMBIGUOUS locator matching ≥2 headings — the citation must identify ONE origin, so ambiguity is UNRESOLVED, never first-match-wins.
3. **The mesh fence (Rule 10 invariants 3/4).** The readable accountability graph stays **LOCAL and readable**. A readable spec / artifact / workspace anchor MUST NOT be pushed up into the mesh `kp://` name-blind plane, and the edge record MUST NOT carry a `kp://` handle in either direction.
4. **No secrets — keys AND high-confidence value shapes.** A provenance edge is a durable record: BLOCKED anywhere in it are a credential-shaped KEY (`api_key`, `*_token`, `secret`, …), a prototype-pollution key, and a credential-shaped VALUE in a high-confidence form (provider-prefixed tokens, PEM-armored keys) — a secret can arrive under an innocuous key name (`security.md` "no secrets in logs").

```text
# DO — grep-stable anchors, closed anchor_kind, one record per artifact
{ "artifact_type": "rule", "artifact_id": "specs-authority",
  "derives_from": [ { "anchor": "specs/ontology/glossary.md#§topology-aware agentic distillation", "anchor_kind": "spec" },
                    { "anchor": ".claude/hooks/lib/derives-from-edge.js::classifyAnchor", "anchor_kind": "artifact" } ] }

# DO — an artifact with no resolvable origin emits the ORPHAN signal, it is not skipped
{ "artifact_type": "skill", "artifact_id": "some-skill", "derives_from": [] }

# DO NOT — bare line number (dead pointer the next edit invalidates)
{ "anchor": "specs/ontology/glossary.md:70", "anchor_kind": "spec" }

# DO NOT — a locator so short it "resolves" by substring accident (vacuous citation)
{ "anchor": "specs/ontology/glossary.md#§kp", "anchor_kind": "spec" }

# DO NOT — a locator matching two headings (ambiguous ⇒ UNRESOLVED, not first-wins)
{ "anchor": "specs/ontology/glossary.md#§RES-", "anchor_kind": "spec" }

# DO NOT — a `kp://` handle in place of a readable anchor (mesh-fence violation)
{ "anchor": "kp://use/<opaque-handle>/churn-features@3", "anchor_kind": "spec" }

# DO NOT — drop the record for an artifact whose origin you could not name
(no edge emitted at all — the orphan becomes invisible to the sweep)
```

**BLOCKED rationalizations:**

- "The artifact has no clean origin, so emitting no edge is more honest than emitting an empty one"
- "The anchor won't resolve, so I'll emit it as an orphan instead" (BLOCKED — `[]` asserts NO origin was claimed; using it to route around a rejection forges exactly the orphan claim the emitter refuses to manufacture, and buys exit 0 by lying)
- "I'll call the library directly so I get a result object instead of an exit code" (BLOCKED — the non-zero exit IS invariant 1's compensating control; bypassing it disables the control)
- "I'll skip the orphan rows so the provenance report looks complete"
- "The line number is more precise than the section heading"
- "The anchor will resolve once the other shard merges" (it MUST resolve against the CURRENT tree)
- "It resolves, so the citation is fine" (a 1-2 char locator resolves against almost anything — resolution must be non-vacuous AND unique)
- "Two headings match but the first one is the one I meant"
- "Nothing consumes the edges yet, so the anchors don't have to resolve"
- "Pushing the anchor into the `kp://` registry makes it queryable from the mesh"
- "Provenance is `/codify`'s reporting concern, not a per-artifact emission"

**Why:** loom's origin trace is forward-only and asymmetric — specs→artifacts is followable, artifact→origin is not — so "where did this artifact come from?" is unanswerable and an unbacked artifact is undetectable. A grep-stable anchor that resolves today is the only endpoint that survives later edits, which is what makes both the query and the orphan sweep sound; the empty array is what makes an orphan LOUD instead of absent.

**PRODUCER HALF ONLY — do not cite this as an end-to-end capability.** loom EMITS the edge to a local, gitignored, per-session staging sink; the CONSUMER (the local DataFlow accountability store) is **kailash-rs #1951 and is NOT built**. Nothing drains the sink today. The emitter is `.claude/hooks/lib/derives-from-edge.js` + `derives-from-ledger.js` — filed under `.claude/hooks/lib/` but loaded by no hook event.

Depth — the v0 emission contract — lives in `skills/30-claude-code-patterns/derives-from-emission.md` and `.claude/guides/rule-extracts/specs-authority.md` § "Relocated 2026-09-13 — Rule 10 / Rule 11 body depth".

## MUST NOT

- Organize specs by COC process stages (duplicates workspaces/)
- Read entire `specs/` at any phase gate (except `/redteam`, `/codify` audit)
- Treat specs as optional documentation

**BLOCKED:** "Specs can be written after implementation" / "The code is the spec" / "Plans already capture this" / "Updating specs for minor change is overkill"

Origin: 6 drift failure-mode analysis + journal 0007 / 0008 + kailash-ml-audit 2026-04-23. Depth — the dated provenance — lives in `.claude/guides/rule-extracts/specs-authority.md` § "Relocated 2026-09-13 — preamble + length-rationale tails".

## Trust Posture Wiring — Rule 10 (knowledge-product field-type)

Applies to the **Rule 10** clause ONLY (added 2026-07-11; the invariant-5 **REGISTER-vs-BIND** clarification of 2026-07-13 rides this same clause-scoped Wiring); canonical-8-field-compliant per `trust-posture.md` MUST-8. Grandfathered Rules 1–9 + § MUST NOT stay exempt until each is itself `/codify`-touched.

- **Severity:** `halt-and-report` at gate-review (cc-architect at `/codify` + reviewer at `/redteam` confirm the five invariants held, register-vs-bind included); `advisory` at the hook layer (a `knowledge-product:` value's `kp://` prefix MAY be lexically checked, but the inert-at-loom / no-in-session-resolution / no-cross-write property is judgment-bearing per `hook-output-discipline.md` MUST-2 and MUST NOT carry `block`).
- **Grace period:** 7 days from clause landing (2026-07-11 → 2026-07-18).
- **Cumulative posture impact:** same-class violations (a breach of any of Rule 10's five invariants, enumerated in the clause above) contribute to `trust-posture.md` MUST Rule 4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key. Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8.
- **Receipt requirement:** SessionStart soft-gate `[ack: specs-authority]` IFF `posture.json::pending_verification` includes the `specs-authority` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — cc-architect at `/codify` + reviewer at `/redteam` inspect any spec edit adding or altering a `knowledge-product:` field and confirm the five invariants held, register-vs-bind included (a loom edit adding a `knowledge-product:` line to a sibling/consumer repo's spec is the violation). **Probes: REGISTERED — `.claude/test-harness/probes/specs-authority.probes.json`**, 30 rows in 15 bipolar `pair_id` pairs (one firing pair per clause `check-clause-coverage.mjs::deriveClauses` returns — MUST-1, MUST-2, MUST-3, MUST-4, MUST-5, MUST-5b, MUST-5c, MUST-6, MUST-7, MUST-8, MUST-9, MUST-10, MUST-11, MUST-NOT — plus a meta-compliance pair), fixtures at `.claude/audit-fixtures/specs-authority/`. Registered in `eval-manifest.json` (probe-only), pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`; no workflow invokes `coc-probe-dispatch.mjs`, and `.claude/test-harness/**` is never-synced. **Phase 2 SHIPPED 2026-09-15 — the deferral is GRADUATED, not renewed, and `phase2-deferrals.json::deferrals["specs-authority.md#rule-10-kp-prefix"]` is DELETED in the same change.** `.claude/hooks/kp-prefix-guard.js` runs the pure predicates at `.claude/hooks/lib/kp-prefix.js` over the written document, with bipolar structural fixtures at `.claude/audit-fixtures/kp-prefix/` driven by that directory's `run.mjs` per `cc-artifacts.md` Rule 9 (MEASURED 24/24 on this tree: 12 firing, 10 clean, 2 DECLARED-BLIND). Registered in `.claude/settings.json` at `PostToolUse`, matcher `Edit|Write` — the event its own `@hook-event` header declares — so AT LOOM it fires. It carries NO `@settings-registration:` marker, deliberately: all three values in `reconcile-hook-surfaces.mjs::MARKER_VOCABULARY` assert NON-registration, so a registered hook carries none. Its `hook_delivery` lane is `cc-only`, a DERIVED fact rather than a judgment — `codex-mcp-guard/extract-policies.mjs` builds the mirrored set from `settings.json::hooks.PreToolUse` ALONE, so a PostToolUse guard is absent from the fresh extraction and there is no Codex/Gemini lane to mirror onto. Severity is `advisory`, which § Severity above already fixed and this hook honours rather than re-deriving; `PostToolUse` additionally fires AFTER the write lands, so a refusal register would be false on its face. It pairs with the Phase-1 layer above per `probe-driven-verification.md` MUST-4 and replaces none of it. **WHAT IT SEES IS INVARIANT 1 ALONE** — a `knowledge-product:` value missing the `kp://` scheme, one carrying the scheme but not the `kp://<owning_level>/<domain>/<name>@<version>` shape the clause declares, or one the parser could not read at all (empty value, YAML block scalar) which it reports as UNCHECKED rather than as compliant. Its scope is THIS rule's own `paths:` globs, read from the lib rather than restated, so `.claude/rules/**` is out of scope and it is silent on this rule's own DO-NOT teaching examples. **WHAT IT CANNOT SEE IS NOT A SCHEDULING GAP.** Invariants 2 (ecosystem-relative), 3 (opaque `<domain>` — the clause itself assigns the derivation contract to the mesh identity spec, so no parser here can decide it), 4 (no readable client/engagement/tenant name) and 5 (inert at loom, REGISTER-not-BIND — a fact about WHO wrote the line and in WHICH repo) are carried by no token on the line; for those four the Phase-1 gate-review above is not a backstop but the WHOLE of the enforcement, and this hook's silence on them is the ABSENCE OF AN INSTRUMENT (`instrument-discipline.md` MUST-3(a)), never an all-clear. TWO further blind spots are DECLARED at the fixtures under a `blind-` prefix the runner reports as BLIND rather than PASS: an INDENTED field (the column-0 anchor is what stops a block-scalar body or a nested key from spoofing the parse, and it is bought at that cost) and a field below an UNCLOSED code fence. **ARMED IS NOT PROVEN EFFECTIVE, AND AT LOOM IT HAS NO POPULATION.** MEASURED on this tree: all ten `^knowledge-product:` field lines in the repo are fenced teaching examples inside `.claude/rules/specs-authority.md` or `.claude/rules/spec-accuracy.md`, and NO file under any `specs/` directory carries the field — which invariant 5 predicts, loom being the registrar and never the binder. Its silence here therefore measures the corpus, not compliance, and the fixtures are the only place its firing is demonstrated. **CONSUMER REACH, MEASURED PER LANE — and the REGISTRATION does not travel with the FILE.** `buildLaneClassifier` returns `copy/always_include` for both `.claude/hooks/kp-prefix-guard.js` and `.claude/hooks/lib/kp-prefix.js` on all seven lanes, while this RULE is `skip/no_tier_match` on `build/prism`, so the detector reaches every lane the obligation reaches; the classifier is shown to DISCRIMINATE rather than blanket-copying the hook tree because on the same call the `loom_only`-fenced `check-merge-separation-guard.js` returns `skip/loom_only` (cited by BASENAME deliberately — it is a discrimination CONTROL for the classifier, NOT a detector this rule claims, and `detection-dispatch-check.mjs` extracts a detector claim from every hook-tree-prefixed path in this block, so writing the prefix would manufacture a claim that is false). But `.claude/settings.json` is `skip/exclude` on EVERY lane, so the REGISTRATION does not ride the artifact sync, and `in-force-check.mjs` MEASURES the resulting gap — the obligation reaches audiences its registration does not — which is DECLARED in the in-force baseline registry under the test-harness tree rather than left silent (named without its path deliberately, on the same ground as the control above: every `.claude/`-prefixed path in this block is read as a claimed DETECTOR, and that registry is a DECLARATION SURFACE, not an instrument this rule claims). Two separate mechanisms bear on closing it and this row claims neither: on the CC lane `reconcile-settings-hooks.mjs` PROPAGATES loom's registrations to a target whose tree carries the resolving script, and this hook is in its scope (it is not `loom_only`); the Codex and Gemini surfaces are STATIC templates that nobody has added it to. So do NOT read this row as consumer coverage — until that reconciler has run against a given target, or its template gains the line, the guard is present-but-inert there and enforcement is gate-review at the consumer's end. **The former fixture slug is WITHDRAWN with the deferral** — the knowledge-product-field-type fixture slug, named here in prose and deliberately NOT in backticked-path form because a withdrawal cannot cite the path it withdraws (the xref gate reads a backticked path as a LIVE reference, so the announcement would re-create the dangle it exists to close), was never created, is no longer cited, and its carve-out in `validate-xref-integrity.mjs::SANCTIONED_DEFERRED_FIXTURES` is DELETED in the same change rather than left standing, so the next genuinely-dangling reference at that slug is flagged loudly instead of absorbed (the disposition `security.md` § Enforcement-Surface Parity records).
- **Violation scope:** the Rule 10 knowledge-product-field-type clause ONLY (clause-scoped); Rules 1–9 + § MUST NOT stay grandfathered per this block's header.
- **Origin:** `journal/0466` (Mesh S0 `/govern` co-owner-directed origination) + `journal/0480` (Mesh C7, the invariant-5 REGISTER-vs-BIND clarification).

Depth — this block's provenance and per-invariant walkthrough — lives in `.claude/guides/rule-extracts/specs-authority.md` § "Relocated 2026-09-13 — Rule 10 Wiring depth (detection + provenance)".

## Trust Posture Wiring — Rule 11 (`derives_from[]` provenance binding)

Applies to the **Rule 11** clause ONLY (added 2026-07-25, loom#1228 W1 item B1); canonical-8-field-compliant per `trust-posture.md` MUST-8. Grandfathered Rules 1–9 + § MUST NOT stay exempt until each is itself `/codify`-touched; Rule 10 stays on its own clause-scoped Wiring above.

- **Severity:** `halt-and-report` at gate-review (cc-architect at `/codify` + reviewer at `/redteam` confirm the four invariants held on every artifact touched in Steps 3/4); `advisory` at the emitter layer, whose staging-sink wrapper fails OPEN so a capture failure never blocks `/codify`, per `hook-output-discipline.md` MUST-2 (whether the anchor the agent CHOSE is the RIGHT origin is judgment-bearing and MUST NOT carry `block`).
- **Grace period:** 7 days from clause landing (2026-07-25 → 2026-08-01).
- **Cumulative posture impact:** same-class violations (a breach of any of Rule 11's four invariants, enumerated in the clause above) contribute to `trust-posture.md` MUST Rule 4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key. Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8.
- **Receipt requirement:** SessionStart soft-gate `[ack: specs-authority]` IFF `posture.json::pending_verification` includes the `specs-authority` rule_id (shared rule_id with the Rule 10 wiring; a single ack covers both).
- **Detection mechanism:** structural + review. **NO HOOK LAYER — this rule claims none.** STRUCTURAL (shipped, at emit time): `.claude/bin/emit-derives-from.mjs`, which `/codify` Step 3 invokes directly; it fails loud, so a malformed edge never reaches the sink and a non-zero exit is the gate. Contract tests `.claude/test-harness/tests/derives-from-edge.test.mjs`. REVIEW (Phase 1, manual): cc-architect at `/codify` cross-checks the session's `actions_taken[]` artifact list against the staged edge records — one record per artifact, orphan rows present not suppressed. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — a per-artifact completeness detector must wait on the CONSUMER (kailash-rs #1951); fixtures land with it at `.claude/audit-fixtures/derives-from-provenance/`.
- **Violation scope:** the Rule 11 `derives_from[]`-provenance-binding clause ONLY (clause-scoped); Rules 1–10 + § MUST NOT stay on their own dispositions. Every `violations.jsonl` row names the artifact id + which invariant fired.
- **Eval-coverage omission — DISCHARGED 2026-09-13, per `coc-artifact-eval-coverage.md` MUST-1.** Rule 11 adds a new load-bearing MUST + BLOCKED corpus and a paired prose artifact, so MUST-1's plumbing carve-out does NOT cover it and a probe set is owed. One NOW SHIPS — `.claude/test-harness/probes/specs-authority.probes.json` carries a `MUST-11-firing` bipolar pair — alongside the structural `.claude/test-harness/tests/derives-from-edge.test.mjs`.
- **Origin:** loom#1228 item B1 — closing gap #1, loom's forward-only asymmetric trace.

Depth — this block's grandfather scope and emitter-layer exposition — lives in `.claude/guides/rule-extracts/specs-authority.md` § "Relocated 2026-09-13 — Rule 11 Wiring depth (detection + eval-coverage)".

**Length rationale (per `rules/rule-authoring.md` MUST NOT § "Rules longer than 200 lines").** Named rationale: **specs-authority-contract scope**.

Depth — the rationale body — lives in `.claude/guides/rule-extracts/specs-authority.md` § "Relocated 2026-09-13 — preamble + length-rationale tails".
