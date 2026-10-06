# Specs Authority — Extended Evidence and Examples

Companion reference for `.claude/rules/specs-authority.md`.

## Rule 5b — Full Sibling Re-Derivation: Two-Session Post-Mortem

The narrow-scope failure mode is empirically recurrent across two sessions, validating the rule:

**Session 2026-04-19 (journal 0007-DISCOVERY-full-specs-sweep-round.md):**

- Edited 2 ML specs.
- `/redteam` ran narrow-scope sweep against the 2 edited specs only.
- Produced "14/14 green" APPROVE verdict.
- Files NOT re-derived: remaining 20+ `specs/ml-*.md` siblings.

**Session 2026-04-20 (journal 0008-GAP-full-specs-redteam-2026-04-20-findings.md):**

- Same edits as previous session (not re-run; audit-only).
- `/redteam` ran full-sibling sweep across all `specs/ml-*.md` (20+ files).
- Found 9 HIGH cross-spec drift findings in specs the prior edit never touched.

Root cause of the drift: `specs/ml-engines.md` had introduced a `TrainingResult` dataclass change (added `device` field). Sibling specs still referenced the pre-change shape (`TrainingResult.backend`, `TrainingResult.devices` as top-level fields) in their own MUST clauses. The narrow-scope sweep never loaded the siblings; the full-sibling sweep did.

Two sessions, same failure mode → full-sibling sweep is the only structural defense.

## Rule 5c — Amend-At-Launch: W32 + W33 Evidence

**W32-32b (2026-04-23 kailash-ml-audit):**

- Todo text: "bump kailash-align 0.4.0 → 0.5.0"
- Current state at launch: W30.3 had already shipped align 0.5.0 (commit `41a217dc`) days earlier.
- Launching the agent with the stale todo would have tried to create a tag `v0.5.0` → collision with existing tag → shard fails at commit time.
- Orchestrator amended the todo text inline: "bump kailash-align 0.5.0 → 0.6.0". Saved one failed shard.

**W33 (2026-04-23):**

- Todo text: "`__all__` exports 34 symbols"
- `specs/ml-engines.md` §15.9 at launch time: "`__all__` exports 41 symbols (40 + erase_subject)"
- Spec was newer than todo; per §5b full-sibling preference, the spec is the authority.
- Orchestrator amended the prompt: "prefer spec §15.9 per specs-authority §5b; export 41 symbols."
- Agent landed 41 correctly.

Without these two amendments, both shards would have failed at commit time — collision on W32, symbol-count mismatch on W33.

Cost accounting: 2-minute launch-time amendment vs. a failed shard that costs:

- Agent context already spent investigating the conflict (~10-50k tokens)
- Orchestrator context to recover + re-launch (~5-20k tokens)
- Calendar time for sibling agents waiting on the failed branch

## Rule 2 — Process-Organized Trap

```
# DO NOT — duplicates workspaces/ structure
specs/
  _index.md
  intent.md          ← workspaces/briefs/ already captures this
  decisions.md       ← workspaces/02-plans/ + journal already captures this
  progress.md        ← workspaces/todos/ + journal already captures this
  boundaries.md      ← ambiguous; partially in briefs, partially in plans
```

Process specs drift from the authoritative workspace artifacts, and the duplication guarantees one falls behind.

## Relationship To FM-1 Through FM-6

The 6 alignment-drift failure modes that motivated `specs/`:

1. **FM-1: Brief-to-plan lossy compression** — briefs lose detail when compressed to plans.
2. **FM-2: Phase transition context thinning** — `/analyze` → `/todos` → `/implement` each drop some context.
3. **FM-3: Multi-session amnesia** — next session re-derives what last session already knew.
4. **FM-4: Agent delegation context loss** — specialist agents lack domain context from briefs.
5. **FM-5: Incremental mutation divergence** — small changes accumulate into architectural drift.
6. **FM-6: Silent scope mutation** — implementation deviates without acknowledgment.

`specs/` addresses FM-1/2/3/4/6 directly. Rule 5a (first-instance update) addresses FM-5. Rule 5b (full sibling re-derivation) closes the narrow-scope loophole that FM-5 exploits. Rule 5c (amend-at-launch) prevents orchestrator-side FM-4 at the agent-dispatch boundary.

## Relocated 2026-08-19 — Rule 5b / 5c evidence tails

Both tails below were appended to their clause's `**Why:**` line in the rule body. Each is
reproduced VERBATIM; the failure-mode sentence each followed stays in the rule body unchanged.

**Rule 5b — the two-session reproducibility tail (verbatim):**

> Two-session reproducibility (journal 0007 / 0008) confirmed: narrow-scope sweep produced "14/14 green" APPROVE; full-sibling sweep found 9 HIGH cross-spec drift findings in specs the edit never touched.

Falsifying context for both figures — the instrument that produced them and what it would have
printed had the claim been false — is § "Rule 5b — Full Sibling Re-Derivation: Two-Session
Post-Mortem" above: the SAME edit set was swept twice, once narrow-scope (2 edited specs only →
"14/14 green" APPROVE) and once full-sibling (all 20+ `specs/ml-*.md` → 9 HIGH). Had the
narrow-scope sweep been sufficient, the full-sibling sweep would have returned 0 additional
findings on the identical edit set; it returned 9, in files the narrow sweep never loaded.

**Rule 5c — the amend-at-launch tail (verbatim):**

> Evidence: kailash-ml-audit 2026-04-23 W32-32b (0.5→0.6 amend) + W33 (34→41 symbol count) — both saved failed shards.

Falsifying context for both figures is § "Rule 5c — Amend-At-Launch: W32 + W33 Evidence" above:
each amendment was made at launch against a todo whose claim was checkable against the then-current
package state and spec, and the un-amended launch had a NAMED failure the amendment averted (W32:
tag `v0.5.0` already existed from commit `41a217dc`, so the shard fails at commit time; W33: spec
§15.9 read 41 symbols against the todo's 34, so the shard lands the wrong `__all__` count). Had the
todos been current, the cross-check would have found no discrepancy and no amendment would have
been made.

## Relocated 2026-08-19 — Rule 9 Origin

Rule 9 ("Workspace Specs Reference Canonical Artifacts (Not Restate)") carried its own Origin line
in the rule body. Verbatim:

> Origin: atelier `cc-audit-lint-generalize` 2026-05-03 (test fixtures and spec canonicalization deferred to /codify; /vet adversarial round L1). Inbound from atelier `/sync-to-coc`.

## Relocated 2026-08-19 — Rule 10 derivation depth

The rule body's "**Derivation is REFERENCED, never restated (Rule 9)**" paragraph keeps its
normative statement (derivation is owned by the mesh identity spec and is NOT restated in the rule;
the five invariants ARE the complete authoring/auditing contract). The path citation, the
does-not-resolve-downstream caveat and the mint-locally consumer narrative are relocated here
verbatim:

> HOW an opaque handle is CONSTRUCTED — random vs keyed-hash, entropy floors, key custody, truncation — is OWNED by the mesh knowledge-product identity spec ((loom-internal reference) § "`<domain>` is an OPAQUE HANDLE") and is NOT restated here, so a derivation refinement resolves through the reference without re-authoring this rule. **Stated plainly rather than cited as a phantom: that path is a loom-side workspace artifact that resolves in loom (the authoring/audit repo) but does NOT resolve in a consumer repo.** Consumers do not need it — a handle is MINTED LOCALLY at the project's handle vault (where the readable name and the minting key live); only the OPAQUE handle is registered at loom's control-plane, so loom never sees the readable name at registration.

## Relocated 2026-08-19 — Rule 11 invariant-1 depth

Invariant 1's sanctioned-exception clause keeps in the rule body: the exception itself (a REJECTED
citation → no row, fail LOUD), the forged-orphan failure-mode sentence, the load-bearing
compensating control (non-zero exit from `.claude/bin/emit-derives-from.mjs`; an ignored rejection
IS the BLOCKED omission), and the consumer-side LAST-ROW-WINS MUST. The supporting rationale,
roadmap and mechanism narrative are relocated here verbatim:

> Rationale: v0's frozen shape has no field distinguishing a **genuine orphan** (no origin exists) from an **unresolved citation** (an origin was claimed, the anchor is broken), so degrading a rejection to a `derives_from: []` row would assert "this artifact has no origin" when the author DID name one — forging the orphan claim the emitter deliberately refuses to manufacture, and pointing the sweep at the wrong remediation (go find an origin, instead of fix the anchor). A missing row that was loudly reported is recoverable; a false orphan row is a silent data-integrity defect in a provenance store.

> **v1 path:** distinguishing the two states honestly needs a new `unresolved_anchors` field, which widens the frozen shape and therefore waits on the coordinated v0→v1 bump with kailash-rs #1951.

> Because this exception mandates "fix the anchor, re-run", a re-run can append a second row for an artifact whose first attempt already staged. The batch is validated in FULL before any append, so a REJECTION cannot leave a partial batch — but a crash mid-batch still can, and a JSONL append is never fully atomic. […] A v0 SEMANTIC rule, not a shape change: no supersession field, no widening.

## Relocated 2026-08-19 — Rule 11 producer-half depth

The rule body keeps the PRODUCER-HALF-ONLY warning, the not-built consumer (kailash-rs #1951), the
"nothing drains the sink today" statement, and the depth/emitter pointers. The
why-freeze-loom-side narrative is relocated here verbatim:

> The v0 field shape is frozen loom-side FIRST so the store ratifies against a greppable tripwire rather than loom reverse-engineering whatever ships (`derives_from_schema_version: 0` = proposed, not agreed).

**The CONSUMER's responsibilities, relocated 2026-08-29.** The rule body names the consumer as "the
local DataFlow accountability store"; what that store is responsible for is: it **persists edges,
serves the query, and runs the orphan sweep**. It is kailash-rs #1951 and is NOT built, so nothing
drains the sink today — the statement the rule body keeps.

## Extraction record — what moved on each pass

**Pass 1 — 2026-08-19 (structural cleanup).** Moved VERBATIM to the guide §§ headed "Relocated
2026-08-19 —": the Rule 5b/5c evidence tails, the Rule 9 Origin line, Rule 10's derivation
path-citation + mint-locally narrative, Rule 11's invariant-1 v0-shape / v1-path / re-emission
mechanics and its producer-half freeze narrative, both Wiring blocks' grandfather-precedent /
no-dedicated-key / detection-walkthrough / eval-omission / Origin narratives, and the
length-rationale enumeration — each measured figure carried across with the falsifying context that
makes it readable.

**Pass 2 — 2026-08-29 (loom#1895 rule-injection-budget pressure).** The `workspace-note` profile was
2,998 B over its ceiling. Moved here: this extraction-record recital itself (pure provenance,
already duplicated in this file), the Rule 5c `**Why:**` cost-accounting tail (§ "Rule 5c —
Amend-At-Launch: W32 + W33 Evidence" carries it), the Rule 11 consumer-responsibility enumeration
(above), and the length-rationale per-clause exposition (§ "Relocated 2026-08-19 — Length rationale
depth" carries it). Additionally, three redundant `paths:` globs were deleted from rule frontmatter
across the corpus — each strictly SUBSUMED by a sibling glob in the same rule's own `paths:` list,
so every rule stays admitted to exactly the profiles it was admitted to before; only the
frontmatter line's own bytes went. For THIS rule that was `**/specs/_index.md`, subsumed by
`**/specs/**`.

**The field-level ZERO-de-scoping assertion, relocated 2026-08-29 (it held on BOTH passes).** Every
MUST, MUST NOT, BLOCKED-rationalization entry, DO/DO-NOT block and failure-mode `**Why:**` sentence
stayed in the rule body verbatim; both Wiring blocks keep all eight canonical field labels with
their normative statements, `**Violation scope:**` included. On pass 2 the length-rationale clause
"each carrying the DO/DO-NOT + `**Why:**` the meta-rule mandates, plus the canonical 8-field
Trust-Posture Wiring each post-cutoff rule (10 and 11) requires in its own clause-scoped block"
moved out of the rule body — it is an ENUMERATION of what the rule contains, not a normative
obligation, and § "Relocated 2026-08-19 — Length rationale depth" below already carried it verbatim.

**Both passes are ZERO de-scoping and neither fires `rule-authoring.md` Rule 10 / Rule 11.** Rule 10
§ "Trigger scope" binds `priority: 0` + `scope: baseline` rules ONLY and this rule is
`scope: path-scoped`, so both are STRUCTURAL CLEANUP, not Rule-10 paired extractions and therefore
not Rule-11 recurrence input (the disposition `journal/0148` recorded).

## Relocated 2026-08-19 — Rule 10 Wiring depth

Every canonical field keeps its LABEL and its normative statement in the rule body. The measured /
narrative content inside three fields, plus the Wiring header's precedent enumeration, is relocated
here verbatim.

**Wiring-header grandfather + clause-scoped precedent (verbatim):**

> Applies to the **Rule 10** clause (added 2026-07-11, Mesh S0 `/govern` co-owner-directed origination; the invariant-5 **REGISTER-vs-BIND** clarification added 2026-07-13, Mesh C7 `/govern` co-owner-directed origination — `journal/0480` — is covered by this same clause-scoped Wiring). Per `trust-posture.md` MUST-8 grandfather cutoff, Rule 10 lands AT/AFTER the MUST-8 SHA and MUST ship canonical-8-field-compliant; the pre-existing grandfathered Rules 1–9 + § MUST NOT remain exempt until each is itself `/codify`-touched (the clause-scoped precedent set by `rule-authoring.md`'s own Wiring section + `security.md` § Enforcement-Surface Parity + `git.md` § CI-check/merge).

**Regression-within-grace — the no-dedicated-key reasoning (verbatim):**

> a spec-field-convention property is review-layer-only + semantic; minting a key would drag `trust-posture.md`, a self-referential-codify allowlist file, into a self-ref edit; the universal `regression_within_grace` trigger already covers it […] the same no-dedicated-key disposition `security.md` § Enforcement-Surface Parity and `git.md` § CI-check/merge took.

**Severity — the per-invariant gate-review enumeration (verbatim).** The rule body's Severity field
kept its normative statement (`halt-and-report` at gate-review; `advisory` at the hook layer per
`hook-output-discipline.md` MUST-2) and now cites this walkthrough ONCE instead of carrying the same
enumeration twice inside one Wiring block:

> cc-architect at `/codify` + reviewer at `/redteam` confirm a `knowledge-product:` field carries a `kp://`-scheme runtime-resolved URN, that the URN is ecosystem-relative, that no loom session resolves/queries the referent, AND — register-vs-bind — that no loom session AUTHORS/cross-writes a downstream `knowledge-product:` LINK: `/distill` REGISTERS the identity, the downstream domain-spec owner BINDS the link in its own repo.

**Rule 10 `**Why:**` — the design-rationale sentence (verbatim).** The failure-mode sentences of that
`**Why:**` line (engine-code-inside-the-splitter; readable/derivable segment leaks the client to 30+
consumers; the REGISTER-vs-BIND cross-write) all stayed in the rule body. The one non-failure-mode
sentence between them is relocated here:

> Keeping the field governed + inert is the guard that must precede any cataloging of products.

**Detection mechanism — the full Phase-1 inspection walkthrough (verbatim):**

> Phase 1 (manual, gate-review) — cc-architect at `/codify` + reviewer at `/redteam` inspect any spec edit adding or altering a `knowledge-product:` field: confirm the value is a `kp://`-scheme URN, ecosystem-relative (no tenant/ecosystem slug embedded), the grammar is referenced not restated (Rule 9), the session did NOT resolve/query the referent, AND (register-vs-bind) the session did NOT author/cross-write a downstream `knowledge-product:` link from loom — `/distill` REGISTERS the identity at loom's control-plane; the downstream domain-spec owner BINDS the link in its own repo (a loom edit adding a `knowledge-product:` line to a sibling/consumer repo's spec is the violation).

**Origin — the full provenance chain (verbatim):**

> journal/0466 (Mesh S0 `/govern` co-owner-directed origination) + the mesh identity spec `02-knowledge-product-identity.md` § "The URN"; ratified roadmap `01-wave-roadmap.md` § S0. Invariant-5 REGISTER-vs-BIND clarification: `journal/0480` (Mesh C7 `/govern` co-owner-directed origination, ratified B2 — the registrar model resolving the C7 downstream-link authoring path; roadmap `01-wave-roadmap.md` § Wave-3 "ONE remaining governance step").

## Relocated 2026-08-19 — Rule 11 Wiring depth

Every canonical field keeps its LABEL and its normative statement in the rule body — including the
non-canonical **Eval-coverage omission (RECORDED)** field, whose normative statement (no probe set
ships; the omission stands on its own merits; structural coverage DOES ship) stays inline.

**Wiring-header grandfather + clause-scoped precedent (verbatim):**

> Applies to the **Rule 11** clause ONLY (added 2026-07-25, loom#1228 W1 item B1). Per `trust-posture.md` MUST-8 grandfather cutoff, Rule 11 lands AT/AFTER the MUST-8 SHA and MUST ship canonical-8-field-compliant; the pre-existing grandfathered Rules 1–9 + § MUST NOT remain exempt until each is itself `/codify`-touched, and Rule 10 stays on its own clause-scoped Wiring above (the clause-scoped precedent set by `rule-authoring.md`'s own Wiring section + `security.md` § Enforcement-Surface Parity + `git.md` § CI-check/merge).

**Regression-within-grace — the no-dedicated-key reasoning (verbatim):**

> an origin-anchor-correctness property is review-layer-plus-advisory-emitter; minting a key would drag `trust-posture.md`, a self-referential-codify allowlist file, into a self-ref edit; the universal trigger already covers it […] the same no-dedicated-key disposition Rule 10 above and `security.md` § Enforcement-Surface Parity took.

**Severity — the per-invariant gate-review enumeration (verbatim).** The rule body's Severity field
kept its normative statement (`halt-and-report` at gate-review; `advisory` at the emitter layer,
fail-LOUD-on-malformed / fail-OPEN-on-capture-failure per `hook-output-discipline.md` MUST-2) and
now cites this walkthrough ONCE instead of carrying the same enumeration twice inside one Wiring
block; each item restates one of Rule 11's four invariants, which stay enumerated in the rule body:

> cc-architect at `/codify` + reviewer at `/redteam` confirm every artifact touched in Steps 3/4 carries an edge record, that every anchor is grep-stable AND resolves against the current tree, that `derives_from: []` orphan rows were emitted rather than suppressed, and that no `kp://` handle appears in the record.

**Detection mechanism — the composition detail, the filing-artifact correction, and the Phase-2 blocker (verbatim):**

> STRUCTURAL (shipped, at emit time, via a CLI ENTRYPOINT): the enforcement surface is `.claude/bin/emit-derives-from.mjs`, which `/codify` Step 3 invokes directly (`commands/codify.md`, the artifact-emission step; Step 4 re-invokes it per skill); it composes `validateDerivesFromEdge` (closed sets + no-secrets + mesh fence), `classifyAnchor` (rejects the bare-line and `kp://` anchor shapes), and `validateEdgeAnchorsResolve` (rejects an anchor that does not resolve against the current tree) — all fail-loud, so a malformed edge never reaches the sink; a non-zero exit is the gate. Contract tests `.claude/test-harness/tests/derives-from-edge.test.mjs`. Those three validators are library functions the entrypoint composes; their module currently sits under `.claude/hooks/lib/` for distribution-tier reasons, which is a filing artifact and NOT an enforcement layer — **no hook event loads them**, and the entrypoint above is the only surface that runs them. REVIEW (Phase 1, manual): cc-architect at `/codify` cross-checks the session's `actions_taken[]` artifact list against the staged edge records — one record per artifact, orphan rows present not suppressed. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — a per-artifact completeness detector must wait on the CONSUMER (kailash-rs #1951), since "every artifact has an edge" is a reverse-index query no loom-local hook can answer.

**Eval-coverage omission — the superseded-reason record (verbatim):**

> The reason recorded here was that `coc-manifest-integrity.mjs` check (e) reds CI on any unreferenced `*.probes.json` against loom's empty-manifest steady-state, making registration "currently unsatisfiable" — BOTH halves are now stale (loom#1368 part 2): a staged probe is registrable via the declared `_deferred_probes` deferral, and the steady state is a declared, expiring `_declared_empty` rather than a bare empty file. […] This is recorded HERE rather than leaning on `coc-artifact-eval-coverage.md` § Origin's grace-bootstrap seam, which is scoped to THAT rule's OWN prose/probe self-coverage and is NOT a blanket exemption for other rules. Structural coverage DOES ship: the committed self-tests at `.claude/test-harness/tests/derives-from-edge.test.mjs` (the `type:tool` disposition the empty manifest's `_doc` names for the engine bins).

**Origin — the full provenance chain (verbatim):**

> loom#1228 item B1 (design (loom-internal reference) § 3.2 item 1 + § 1.6 acceptance criteria; `01-analysis/A-distillation-methodology.md` § 5 item 1 — closing gap #1, loom's forward-only asymmetric trace). Frozen v0 emit contract: (loom-internal reference) (item B2, landed by PR #1305).

## Relocated 2026-08-19 — Length rationale depth

The rule body keeps the named rationale (**specs-authority-contract scope**), the
`priority: 10` + `scope: path-scoped` no-baseline-cost statement, and the extraction pointers. The
per-rule enumeration and the splitting-cost argument are relocated here verbatim:

> Rule body is ~378 lines (per `wc -l`), over the 200-line guidance. Named rationale: **specs-authority-contract scope** — the rule codifies the complete specs-as-domain-truth contract across its numbered rules (1–11 plus the 5b/5c sub-rules): the `specs/` + `_index.md` requirement, domain-ontology organization, detail-not-summaries, phase-command read-before-act, first-instance update + sibling re-derivation + at-launch todo amendment, deviation acknowledgment, delegation spec-inclusion, large-file split, workspace-specs-reference-not-restate, the Rule 10 `knowledge-product:` field-type, and the Rule 11 `derives_from[]` provenance binding (whose DEPTH — record shape, hygiene invariants, transport, v0→v1 protocol — is EXTRACTED to `skills/30-claude-code-patterns/derives-from-emission.md`, leaving only the four load-bearing invariants inline) — each carrying the DO/DO-NOT + `**Why:**` the meta-rule mandates, plus the canonical 8-field Trust-Posture Wiring each post-cutoff rule (10 and 11) requires in its own clause-scoped block. The rule is `priority: 10` + `scope: path-scoped`, so it pays NO baseline-emission cost (loaded only in sessions matching its `paths:` globs) and `rule-authoring.md` Rule 10's proximity-band gate does NOT fire. Splitting the domain-truth rules into siblings would fragment the one contract every spec edit consults and force cross-rule lookups. Sibling precedent: `artifact-flow.md` + `cc-artifacts.md` + `sync-completeness.md` length rationales.

The ~378-line figure was measured by `wc -l` on the rule body BEFORE the 2026-08-19 structural
cleanup; it is preserved here as the measurement that justified the overage at the time, and is NOT
a current reading — re-measure rather than citing it.

## Relocated 2026-08-29 — rule-body Extraction record + Length rationale (verbatim)

Both paragraphs below were moved VERBATIM out of `.claude/rules/specs-authority.md` by the
2026-08-29 band-recovery extraction. They are meta-text — provenance and a length rationale —
and the literal `MUST` / `MUST NOT` / `BLOCKED` tokens they contain are mentions, not clauses.
They are preserved here in full so the move is a paired extraction rather than a removal.

**Extraction record** (2026-08-19, ZERO de-scoping — every MUST, MUST NOT, BLOCKED-rationalization entry, DO/DO-NOT block and failure-mode `**Why:**` sentence stayed here verbatim; both Wiring blocks keep all eight canonical field labels with their normative statements, `**Violation scope:**` included): the Rule 5b/5c evidence tails, the Rule 9 Origin line, Rule 10's derivation path-citation + mint-locally narrative, Rule 11's invariant-1 v0-shape/v1-path/re-emission mechanics and producer-half freeze narrative, both Wiring blocks' grandfather-precedent / no-dedicated-key / detection-walkthrough / eval-omission / Origin narratives, and the length-rationale enumeration moved VERBATIM to the guide §§ headed "Relocated 2026-08-19 —", each measured figure with the falsifying context that makes it readable. **`rule-authoring.md` Rule 10 / Rule 11 do NOT fire** — Rule 10 § "Trigger scope" binds `priority: 0` + `scope: baseline` rules ONLY and this rule is `scope: path-scoped`, so this is STRUCTURAL CLEANUP, not a Rule-10 paired extraction and therefore not Rule-11 recurrence input (the disposition `journal/0148` recorded).
**Length rationale (per `rules/rule-authoring.md` MUST NOT § "Rules longer than 200 lines").** Named rationale: **specs-authority-contract scope** — the rule codifies the complete specs-as-domain-truth contract across Rules 1–11 (plus the 5b/5c sub-rules), each carrying the DO/DO-NOT + `**Why:**` the meta-rule mandates, plus the canonical 8-field Trust-Posture Wiring each post-cutoff rule (10 and 11) requires in its own clause-scoped block. The rule is `priority: 10` + `scope: path-scoped`, so it pays NO baseline-emission cost (loaded only in sessions matching its `paths:` globs) and `rule-authoring.md` Rule 10's proximity-band gate does NOT fire; per-clause depth is EXTRACTED to `skills/30-claude-code-patterns/derives-from-emission.md` + `.claude/guides/rule-extracts/specs-authority.md`. Full per-rule enumeration, the splitting-cost argument and the sibling precedents: guide § "Length rationale depth".

## Extraction record

Moved from the rule body 2026-09-07 (loom budget-residual lane).

**Extraction record** — two passes (2026-08-19 + 2026-08-29), each ZERO de-scoping, neither firing `rule-authoring.md` Rule 10 / Rule 11 (this rule is `scope: path-scoped`, so both are STRUCTURAL CLEANUP). What moved on each pass, the field-level zero-de-scoping assertion, and where each span landed: guide § "Extraction record — what moved on each pass".

## Relocated 2026-09-13 — Rule 10 / Rule 11 body depth

Moved VERBATIM out of `.claude/rules/specs-authority.md` by the 2026-09-13 paired-extraction lane
(`rule-authoring.md` Rule 10 path (a)). Every `MUST` / `MUST NOT` / `BLOCKED` token and every
`**Why:**` line stayed in the rule body; what moved is narrative, provenance and mechanism detail.

**Rule 10 invariant 5 — the preservation rationale (moved from the invariant body).**

> This preserves `repo-scope-discipline.md` (loom never cross-writes a sibling repo) while keeping
> the identity's mint/registration at loom.

The same guard is stated normatively in Rule 10's own `**Why:**` line, which is why the sentence is
navigation here rather than a second copy of the obligation.

**Rule 10 — the derivation-reference tail (moved from § "Derivation is REFERENCED, never restated").**

> HOW an opaque handle is CONSTRUCTED — random vs keyed-hash, entropy floors, key custody,
> truncation — is OWNED by the mesh knowledge-product identity spec and is NOT restated here, so a
> derivation refinement resolves through the reference without re-authoring this rule. The five
> invariants above ARE the complete contract for AUTHORING or AUDITING a `knowledge-product:` field.
> Where a repo does carry a local mesh identity spec, that spec is authoritative on derivation; this
> rule is authoritative on the five invariants. The spec's path, the stated-plainly-not-a-phantom
> caveat (it resolves in loom, NOT in a consumer repo) and the mint-locally-at-the-project-vault
> narrative: guide § "Rule 10 derivation depth".

**Rule 11 invariant 1 — the forged-orphan rationale (moved from the sanctioned-exception paragraph).**

> Degrading a rejection to a `derives_from: []` row would forge the orphan claim the emitter
> deliberately refuses to manufacture and point the sweep at the wrong remediation (go find an
> origin, instead of fix the anchor).

The same reasoning is carried normatively by Rule 11's BLOCKED corpus entry _"The anchor won't
resolve, so I'll emit it as an orphan instead"_, which stayed in the rule body.

**Rule 11 — the producer-half tail (moved from the PRODUCER HALF ONLY paragraph).**

> Why the v0 shape is frozen loom-side FIRST: guide § "Rule 11 producer-half depth". Depth — the
> frozen v0 record shape, the hygiene invariants, the transport decision, and the v0→v1 ratification
> protocol — is `skills/30-claude-code-patterns/derives-from-emission.md`; the emitter is
> `.claude/hooks/lib/derives-from-edge.js` + `derives-from-ledger.js`.

**Rule 11 — the Step-3/4 emission-point citation (moved from the clause opening).**

> (`.claude/commands/codify.md` § "3. Update existing agents" + § "4. Update existing skills")

## Relocated 2026-09-13 — Rule 10 Wiring depth (detection + provenance)

Moved VERBATIM out of the § "Trust Posture Wiring — Rule 10" block. All eight canonical field
labels and their normative statements stayed in the rule.

**Applies-to tail.**

> Landing provenance, grandfather cutoff + clause-scoped precedent: guide § "Rule 10 Wiring depth".

**Severity — the cited-once parenthetical.**

> the per-invariant confirmation walkthrough is guide § "Rule 10 Wiring depth", cited once rather
> than twice

**Regression-within-grace — the precedent tail.**

> Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md`
> Rule 8; the reasoning + the `security.md` / `git.md` precedent it follows: guide § "Rule 10
> Wiring depth".

**Detection mechanism — the probe-registration narrative.**

> the full per-invariant inspection walkthrough is guide § "Rule 10 Wiring depth". Registered in
> `eval-manifest.json` as a probe-only entry (`scanner: null`) and pinned in
> `probe-suite-integrity.test.mjs::PINNED_SUITES`. An earlier revision of this row said the suite
> was NOT YET AUTHORED and pointed at a `probe_authorship_deferrals` entry; that was true when
> written and is now FALSE, corrected here rather than left standing, and the dated row is deleted
> in the same change. Registration buys DISPATCHABILITY, never automatic execution: no workflow
> invokes `coc-probe-dispatch.mjs`, and the loom↔csq boundary keeps CI LLM-free, so a green CI run
> is NEVER evidence these probes passed — they execute only when an orchestrator dispatches
> `/test-harness-probe --artifacts` at gate-review. Consumer note: `.claude/test-harness/**` is
> never-synced, so no consumer receives this suite and enforcement at those targets is gate-review.
> Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — an advisory
> `PostToolUse(Edit|Write)` lexical tripwire flagging a `knowledge-product:` value that lacks a
> `kp://` prefix MAY pair with the review layer per `probe-driven-verification.md` MUST-4; audit
> fixtures land with the Phase-2 detector at [the knowledge-product-field-type slug under the
> audit-fixtures tree — SUPERSEDED, and the path form is deliberately not reproduced in this
> quotation; see the note below] per `cc-artifacts.md` Rule 9.

**SUPERSEDED 2026-09-15 — the Phase-2 sentence quoted immediately above.** It is kept as the
relocated record of what the rule said, and is now FALSE as a statement about this tree: the
deferral GRADUATED, `.claude/hooks/kp-prefix-guard.js` ships over `.claude/hooks/lib/kp-prefix.js`
with fixtures at `.claude/audit-fixtures/kp-prefix/`, and the never-created
knowledge-product-field-type slug — named in prose, never as a backticked path, since a
withdrawal must not cite what it withdraws — is withdrawn along with its
`validate-xref-integrity.mjs::SANCTIONED_DEFERRED_FIXTURES` carve-out. That is also why the
quoted Phase-2 sentence above carries a bracketed editorial redaction in place of the path.
A relocated quotation that
still reads as a live claim is the absence-reads-as-clean shape this corpus governs, which is why
the correction is recorded here rather than left for a reader to discover against the rule. The
live Detection row in `.claude/rules/specs-authority.md` § "Trust Posture Wiring — Rule 10" is
authoritative, including its measured limits: the detector reaches INVARIANT 1 ALONE, and loom's
hook REGISTRATION does not ship even though the hook FILE does.

**Origin — the full provenance chain.**

> `journal/0466` (Mesh S0 `/govern` co-owner-directed origination) + `journal/0480` (Mesh C7, the
> invariant-5 REGISTER-vs-BIND clarification). Full provenance chain — the mesh identity spec § and
> the ratified roadmap §§: guide § "Rule 10 Wiring depth".

## Relocated 2026-09-13 — Rule 11 Wiring depth (detection + eval-coverage)

Moved VERBATIM out of the § "Trust Posture Wiring — Rule 11" block.

**Applies-to tail.**

> The pre-existing grandfathered Rules 1–9 + § MUST NOT remain exempt until each is itself
> `/codify`-touched, and Rule 10 stays on its own clause-scoped Wiring above. Grandfather cutoff +
> clause-scoped precedent: guide § "Rule 11 Wiring depth".

**Severity — the emitter-layer exposition.**

> `advisory` at the emitter layer — the emit path fails LOUD on a malformed edge
> (`buildDerivesFromEdge` throws) but the staging-sink wrapper fails OPEN so a capture failure never
> blocks `/codify`, per `hook-output-discipline.md` MUST-2 (whether the anchor the agent CHOSE is
> the RIGHT origin is judgment-bearing and MUST NOT carry `block`).

**Regression-within-grace — the precedent tail.**

> Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md`
> Rule 8; the reasoning + the Rule-10 / `security.md` precedent it follows: guide § "Rule 11 Wiring
> depth".

**Detection mechanism — the composition + Phase-2 narrative.**

> STRUCTURAL (shipped, at emit time, via a CLI ENTRYPOINT): the enforcement surface is
> `.claude/bin/emit-derives-from.mjs`, which `/codify` Step 3 invokes directly and which composes
> `validateDerivesFromEdge`, `classifyAnchor` and `validateEdgeAnchorsResolve` — all fail-loud, so a
> malformed edge never reaches the sink; a non-zero exit is the gate. Contract tests
> `.claude/test-harness/tests/derives-from-edge.test.mjs`. REVIEW (Phase 1, manual): cc-architect at
> `/codify` cross-checks the session's `actions_taken[]` artifact list against the staged edge
> records — one record per artifact, orphan rows present not suppressed. Phase 2 (deferred per
> `trust-posture.md` § Two-Phase Rollout) — a per-artifact completeness detector must wait on the
> CONSUMER (kailash-rs #1951); audit fixtures land with that detector at
> `.claude/audit-fixtures/derives-from-provenance/` per `cc-artifacts.md` Rule 9. Per-validator
> composition detail, the `.claude/hooks/lib/` filing-artifact correction (no hook event loads them)
> and the reverse-index-query blocker: guide § "Rule 11 Wiring depth".

**Eval-coverage omission — the discharge narrative.**

> A probe set NOW SHIPS: `.claude/test-harness/probes/specs-authority.probes.json` carries a
> `MUST-11-firing` bipolar pair among fifteen, so the omission this bullet recorded no longer exists
> and the bullet is corrected in place rather than left standing — a Wiring row asserting an absent
> tier is the same absence-reads-as-clean shape Rule 11 itself governs. The superseded text read "NO
> probe set ships — the suite is unwritten ... The probe set lands when loom's harness graduates from
> the empty-manifest steady-state"; that condition was never the blocker, and the suite was authored
> without it changing. Structural coverage continues to ship alongside:
> `.claude/test-harness/tests/derives-from-edge.test.mjs`. Full record, incl. the earlier superseded
> "currently unsatisfiable" reason: guide § "Rule 11 Wiring depth".

**Origin — the design/acceptance-criteria tail.**

> Design + acceptance-criteria references and the frozen v0 emit contract (item B2, PR #1305): guide
> § "Rule 11 Wiring depth".

## Relocated 2026-09-13 — preamble + length-rationale tails

**Preamble depth-companion enumeration (moved from the rule's H1 pointer line).**

> Rule 5b/5c evidence (two-session reproducibility + W32/W33 amend-at-launch post-mortem), extended
> examples, and the 2026-08-19 relocated-depth §§ every `guide § "…"` pointer below resolves into.

**Length-rationale body (moved from the rule footer).**

> Named rationale: **specs-authority-contract scope** — the complete specs-as-domain-truth contract
> across Rules 1–11 (plus the 5b/5c sub-rules). `priority: 10` + `scope: path-scoped`, so it pays NO
> baseline-emission cost and Rule 10's proximity-band gate does NOT fire; per-clause depth is
> EXTRACTED to `skills/30-claude-code-patterns/derives-from-emission.md` + the guide. Full per-rule
> enumeration, the splitting-cost argument and the sibling precedents: guide § "Length rationale
> depth".

**§ MUST NOT Origin tail (moved from the rule footer).**

> Origin: 6 drift failure-mode analysis + journal 0007 / 0008 (full-sibling re-derivation,
> 2026-04-19/20) + kailash-ml-audit 2026-04-23 (amend-at-launch W32/W33). See guide for full
> two-session post-mortem.
