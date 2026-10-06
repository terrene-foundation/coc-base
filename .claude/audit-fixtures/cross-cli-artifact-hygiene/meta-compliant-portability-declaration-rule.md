---
name: workspace-portability-declaration
description: A workspace artifact whose acceptance criterion depends on a CLI-native primitive MUST carry a frontmatter portability declaration. Fires when a session marks an artifact runtime-bound in body prose, or binds it on its own judgement.
priority: 10
scope: path-scoped
paths:
  - "workspaces/**/*.md"
  - "briefs/**/*.md"
---

# Workspace Portability Declaration

## MUST Rules

### 1. A CLI-Dependent Criterion MUST Declare Its Binding In Frontmatter

An artifact carrying an acceptance criterion that cannot pass on another runtime MUST
declare the binding in its own frontmatter — `cli_bound`, a `cli_bound_reason` naming
the primitive, and a `cli_bound_scope` fixing how far it reaches. Asserting the binding
in body prose instead is BLOCKED, and so is declaring it at all without an explicit
operator instruction that the artifact IS bound.

```yaml
# DO — declared where a reader and a parser both find it, scoped, with a reason
cli_bound: claude-code
cli_bound_reason: the criterion asserts on the guard's returned object; no equivalent
cli_bound_scope: this file only

# DO NOT — asserted in prose, unscoped, and on the session's own judgement
This todo is CLI-bound. Run it under the runtime that wrote it.
```

**Why:** A binding stated in prose is invisible to every tool that selects artifacts by
frontmatter, so the next runtime discovers it by failing the criterion.

**BLOCKED rationalizations:**

- "The sentence in the body says it plainly and a reader hits that first"
- "A frontmatter key nobody reads is worse than a sentence everybody does"
- "The binding is true, so recording it is just accuracy"
- "The operator told me to write the shard, which covers how I write it"
- "I will add the declaration if someone asks for it"
- "Scoping it is premature — the whole workspace is bound in practice"

## MUST NOT

- Mark an artifact runtime-bound on the session's own judgement, however true the
  binding is in fact

**Why:** The designation narrows who can execute the artifact, and that narrowing is the
operator's to make rather than the session's.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms any
  runtime-bound artifact carries the frontmatter declaration and quotes the operator turn
  that instructed it); `advisory` at the hook layer per `hook-output-discipline.md`
  MUST-2 — whether a criterion is genuinely unportable is judgment-bearing.
- **Grace period:** 7 days from rule landing (2026-09-02 → 2026-09-09).
- **Cumulative posture impact:** same-class violations (a binding asserted in prose; a
  binding declared with no operator instruction; a declaration with no scope) contribute
  to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1
  posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace`
  trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated key; named
  deviation recorded per `trust-posture.md` Rule 8, since whether an instruction
  authorised the binding is a review-layer reading of the session's own turns.
- **Receipt requirement:** session-start soft-gate `[ack: workspace-portability-declaration]`
  IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer reads every artifact
  the shard touched and confirms each runtime-bound one carries the three frontmatter
  keys. Phase 2 (deferred) — a parser over artifact frontmatter, a STRUCTURAL signal: the
  keys are either present in the parsed document or they are not, so the detector reads a
  parsed field rather than prose. Fixtures land WITH it at
  `.claude/audit-fixtures/workspace-portability-declaration/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 + the MUST NOT clause; each row names the artifact and
  which of the three keys was absent.
- **Origin:** See § Origin.

## Origin

2026-09-02 — a shard whose acceptance test drove a runtime-native API was marked bound
in a body sentence, on the session's own judgement; the next runtime selected it by
frontmatter, found nothing, and failed the criterion three shards later.
