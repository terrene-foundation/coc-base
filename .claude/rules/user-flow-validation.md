---
name: user-flow-validation
description: Walk the actual user-facing flow before declaring any deliverable done. Tests passing is necessary but NOT sufficient. Receipts (verbatim command + verbatim output + user's next-step disposition) are mandatory and MUST be scrubbed before any public-surface embedding. Full DO/DO-NOT corpora + per-MUST detail in the paired skill.
priority: 10
scope: path-scoped
paths: ["**/*"]
---

# User-Flow Validation Rules

A deliverable MUST be exercised through the actual user-facing path before being declared "done". Passing tests (unit / integration / Tier-1/2/3) is **necessary but INSUFFICIENT** — the user's literal walk MUST be performed: invoke the command the user would invoke, observe the output the user would see, follow the next step the user would take. Declaring "done" before the walk is BLOCKED.

The full per-MUST treatment — extended DO/DO-NOT receipt examples, the BLOCKED corpora, MUST-3/5 in full, MUST-8's worked release-gate example — lives in **`.claude/skills/30-claude-code-patterns/user-flow-validation-walk-discipline.md`**, where every `MUST-N` anchor below resolves. Read it before declaring any deliverable done, or when auditing a done/complete/shipped claim.

## MUST Rules

### 1. Walk The User Flow Before Declaring Complete

Before declaring ANY deliverable "done" / "complete" / "shipped" / "landed" / "ready": invoke the command / load the rule / run the script the way the user will; observe the actual output the user will see; follow the next step the user would take. Tests passing is INSUFFICIENT — every gate-level test result is the author's BELIEF about the user's experience, not the user's literal experience. A reviewer agent reviewing the diff is reviewing the diff, not invoking the deliverable; CI is running the author's test suite, not the user's path.

```text
# DO — walk the literal user path, evidenced (verbatim command + output + disposition)
# DO NOT — "tests passed, reviewer approved, CI green → done" (none of the three is the walk)
```

**BLOCKED rationalizations** (full corpus in skill): "the unit/integration tests ARE the user flow" / "the reviewer agent confirmed it" / "CI passed" / "I traced the code path" / "it compiled / it parses / it loaded" / "the user can verify if it doesn't work".

**Why:** Primitives that pass every test in isolation still fail when composed with argument parsing, output rendering, session state, hook ordering, and next-step legibility — only the literal user walk catches these.

### 2. Receipts For The Walk Are Mandatory

The walk MUST produce a **receipt**: verbatim command + verbatim output + the inferred user disposition (proceed / blocked / confused), embedded in the deliverable's commit message OR PR description OR session notes. "Walked it, looks good" without a receipt is BLOCKED — the receipt is the only evidence the walk happened.

```text
# DO — receipt: `$ /onboard` → <verbatim output> → Disposition: next-step clear
# DO NOT — "Walked it; it works." / "Tested end-to-end. Looks good." (unfalsifiable)
```

**Why:** "Walked it, looks good" is unfalsifiable — the next reader cannot verify the walk happened, what the output was, or whether the disposition was correct; the receipt converts an institutional claim into institutional evidence.

### 4. Prose Deliverables (Rules, Commands, Skills) Have A Walk Too

For rule / command / skill files distributed to consumer repos, the walk is: the file loads under the actual CLI runtime; frontmatter parses; paths resolve; the rule's claims about its own behavior are verified end-to-end; the DO/DO-NOT examples render in the real CLI surface; the BLOCKED patterns fire when matched against fixture scenarios.

```text
# DO — prose walk: rule loaded under CC, frontmatter parsed, fixture's BLOCKED pattern fired as expected
# DO NOT — "Wrote the rule. All sections present. Done." (authoring ≠ the user's experience)
```

**Why:** Rules and commands are deliverables the user invokes; "the file exists and the prose looks right" is not the user's experience — the rule firing at a real gate / the command rendering real output is.

### 6. Receipts MUST Be Scrubbed Before Embedding In Public-Surface Artifacts

Verbatim receipts (MUST-2) MUST be **scrubbed** before embedding in PR descriptions, commit messages, journal entries, or session notes — anything that may sync to public surfaces or downstream consumer repos. The scrub is the conjunction of (1) secrets/credentials/PII per `security.md` § "No secrets in logs" and (2) downstream-context tokens per `upstream-issue-hygiene.md` MUST-2 (consumer project names, internal paths, workspace identifiers, finding tags). The receipt's evidential value is the **structural shape** (sections present, errors absent, next-step legible), NOT the raw bytes — a scrubbed receipt preserving shape IS valid; a verbatim-everything dump surfacing secrets or downstream identifiers is BLOCKED.

```text
# DO — scrubbed receipt: Identity: <operator-display-id>; GitHub login: <operator-gh-login>
# DO NOT — verbatim: jane.doe@acme-consumer.com / sk-prod-XXXXXX / workspaces/acme-cust-engagement-q3/
```

**Why:** Receipts in PR descriptions / commit bodies / session notes enter loom's git history and propagate to 30+ downstream consumer repos via `/sync`; once on the public record, redaction is partial. Scrubbing specific substrings does not reduce evidential value but blocks the disclosure-class failure mode.

### 7. Write / Side-Effecting Surfaces Need Boundary-Injected Fixtures Per Failure-Mode Class

When a deliverable WRITES or causes a side effect (mutates state, emits to an external target, takes a consequential action beyond its return value), the walk (MUST-1) MUST include automated fixtures that INJECT that boundary and exercise each failure-mode class — **(a)** refusal at the boundary, **(b)** exception mid-operation, **(c)** corrupt / partial persisted state on re-entry, **(d)** unauthorized / out-of-envelope action — not only the pure-function core. A green unit suite over the pure core is NOT convergence evidence for the write surface; a fixture green while asserting the WRONG invariant is a covered failure, not a pass.

```text
# DO — one injected-boundary fixture per class (a)-(d): refused → no partial land; mid-run exception → full rollback; corrupt state → refuse-to-start; unauthorized → blocked before the boundary
# DO NOT — "unit fixtures pass over the pure core → converged" (every fixture sat on the safe side of the boundary)
```

**Why:** Defects concentrate at the I/O boundary while a pure-core suite reports green on the safe side of it — boundary-injection per failure-mode class is the only fixture shape that makes write-surface regressions mechanically detectable. Full DO/DO-NOT + BLOCKED corpus + Origin in the walk-discipline skill; the fixture-existence half is `cc-artifacts.md` Rule 9.

**MUST-3 (walk distinguishes failure modes tests cannot) + MUST-5 (the walk caps every deliverable — it is the LAST gate before "done" applies, even when all prior gates are green)** — full clauses + DO/DO-NOT in the skill. A passing test next to a broken user walk is institutional theatre; fix the failure mode the walk surfaces, do not declare done because the test passed.

### 8. A Release / Verification Gate Drives The Un-Pre-Configured Real-Consumer Path

When a gate VERIFIES a deliverable by DRIVING it — a release FIRST-ACT gate, an install-and-invoke check, an integration walk — the walk MUST drive the path a REAL, UN-PRE-CONFIGURED consumer hits: the consumer arrives WITHOUT the system pre-seeded into the happy state. A gate that manually seeds the config / keys / fixtures / JWKS the real consumer supplies at runtime, drives only that happy path, and reports PASS is walking a SUBSTITUTE path (the MUST NOT "Walk a substitute path" mode), NOT the literal user path. The gate MUST additionally drive **(a)** the un-pre-configured COLD entry, **(b)** the real provider / format / dialect VARIANTS the consumer uses, **(c)** the ERROR / boundary paths (MUST-7's failure-mode classes). Declaring the deliverable verified on a pre-configured happy walk alone is BLOCKED. Cross-ref `conformance-walk.md` MUST-3 — a happy-only PASS over a pre-configured path is a fabricated pass over a shrunk denominator, one surface over.

```text
# DO — install the published artifact, do NOT pre-seed the consumer's runtime state, drive
#      cold-entry + a real RS256 provider + the boundary paths → receipt
# DO NOT — pre-seed the exact config the callback needs, drive good-vs-bad state, report PASS
#      (a real un-seeded consumer then hits every defect that walk sat on the safe side of)
```

**BLOCKED rationalizations** (full corpus in skill §8): "the gate installed the real artifact, so it's a real walk" / "seeding the config is just test setup" / "the happy path IS the user path" / "the consumer's provider is the same as my fixture" / "the error paths are MUST-7's job, not this gate's" / "a pre-configured pass IS a pass".

**Why:** A gate that seeds the exact runtime state the real consumer supplies drives a path no consumer ever walks — the pre-configured happy walk sits on the safe side of every defect a cold, real-provider consumer hits. The literal user arrives un-seeded; only the un-pre-configured walk crosses the boundary where the consumer-facing defects live.

## MUST NOT

- Declare a deliverable "done" / "complete" / "shipped" / "landed" / "ready" without the walk. **Why:** the originating failure mode this rule blocks.
- Substitute "the reviewer agent approved" or "CI passed" for the walk. **Why:** review agents check the diff for known failure modes; CI runs the author's test suite — neither invokes the deliverable through the user's literal path.
- Submit a PR description that says "tested" without verbatim command + output receipts. **Why:** "tested" without a receipt is unfalsifiable.
- Walk a substitute path (a similar command, a previous version, a fixture) instead of the actual user-facing path. **Why:** substitutes verify the substitute; the failure modes the user hits live on the actual path.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement`; cc-architect at `/codify`; security-reviewer when the walked path is security-sensitive). `advisory` at the hook layer (lexical "done"-without-receipt detection per `hook-output-discipline.md` MUST-2).
- **Grace period:** 7 days from rule landing (2026-05-22 → 2026-05-29).
- **Cumulative posture impact:** none for a single instance; 3× across 30 days cumulates per `trust-posture.md` MUST-4.
- **Regression-within-grace:** same-class violation within 7 days = emergency downgrade L5→L4; trigger key `user_flow_walk_omitted` (1× = drop 1 posture).
- **Receipt requirement:** SessionStart MUST require `[ack: user-flow-validation]` in the agent's first response IF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** semantic gate-level reviewer is load-bearing — reviewer at `/implement` confirms every "done"/"complete"/"shipped" claim in PR descriptions, session notes, and commit messages carries verbatim walk receipts. Lexical `detectDoneWithoutReceipt` (Stop event) is advisory-only. Fixtures + the full detection contract: skill.
- **Violation scope:** rule-corpus-wide; every deliverable, every session, every operator. No project-scoped carve-outs.
- **Origin:** See § Origin.

## Trust Posture Wiring — MUST-8 (Release / Verification Gate Drives The Un-Pre-Configured Real-Consumer Path)

Applies to the **MUST-8** clause (added 2026-07-21 kailash-rs BUILD proposal; landed at loom 2026-07-22 via `/sync-from-build` Gate-1). Ships canonical-8-field-compliant per `trust-posture.md` MUST-8; the pre-existing MUST-1/2/4/6/7 Wiring above stays grandfathered until each is itself `/codify`-touched. Clause-scoped precedent + the no-dedicated-key rationale: skill § "MUST-8 clause-scoped Wiring — depth".

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + release-specialist at `/release` + cc-architect at `/codify` confirm a release/verification gate drove the un-pre-configured real-consumer path — cold entry + real provider/format variants + error/boundary paths — not a pre-seeded happy fixture); `advisory` at the hook layer (judgment-bearing per `hook-output-discipline.md` MUST-2 — no structural tool-call signal).
- **Grace period:** 7 days from clause landing at loom (2026-07-22 → 2026-07-29).
- **Cumulative posture impact:** same-class violations (a gate that manually seeds the config/keys/JWKS the real consumer supplies at runtime, drives only the happy path, and reports PASS) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key (`user_flow_walk_omitted` is walk-OMISSION-scoped, not walk-SUBSTITUTION). Named deviation per `trust-posture.md` Rule 8.
- **Receipt requirement:** SessionStart soft-gate `[ack: user-flow-validation]` IFF `posture.json::pending_verification` includes this rule_id (shared rule_id; a single ack covers MUST-1..8).
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer at `/implement` + release-specialist at `/release` + cc-architect at `/codify` confirm any gate that VERIFIED a deliverable BY DRIVING it drove the un-pre-configured cold path + the real provider/format variants + the error/boundary paths, not a manually-seeded happy fixture. Scanner: none (semantic). Fixtures `.claude/audit-fixtures/user-flow-validation/`; probes REGISTERED — `.claude/test-harness/probes/user-flow-validation.probes.json`, a probe-only entry pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`; `_deferred_probes` discharged (loom#1302). Registration buys DISPATCHABILITY at gate-review, NOT CI execution — a green CI run is never evidence these probes passed. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — no hook detector; the property is semantic, no structural signal to key one on. Depth (row shape, the dispatch measurement, what CI does gate): skill § "MUST-8 clause-scoped Wiring".
- **Violation scope:** MUST-8 (a release/verification gate walking a pre-configured substitute path) ONLY (clause-scoped); the pre-existing MUST-1/2/4/6/7 Wiring stays grandfathered until each is itself `/codify`-touched.
- **Origin:** See § Origin (kailash-rs proposal `USER-FLOW-VALIDATION-MUST8-RELEASE-GATE-REAL-CONSUMER-2026-07-21`).

## Origin

2026-05-22 — verbatim co-owner directive (journal/0134), originated at loom under `artifact-flow.md` § Co-Owner-Directed Origination; distributes to 30+ downstream consumer repos via `/sync`. **MUST-8** — 2026-07-21 kailash-rs BUILD proposal `USER-FLOW-VALIDATION-MUST8-RELEASE-GATE-REAL-CONSUMER-2026-07-21`, landed at loom 2026-07-22 via `/sync-from-build` Gate-1 (GLOBAL, not rs-specific). The verbatim directive, the v4.37.0 OIDC-SSO trigger narrative, the design note on why walk- and scrub-discipline stay in ONE rule, and the Distinct-From / Cross-References map all live in the walk-discipline skill § Origin.

**Extraction record** (each ZERO de-scoping): skill § Origin.
