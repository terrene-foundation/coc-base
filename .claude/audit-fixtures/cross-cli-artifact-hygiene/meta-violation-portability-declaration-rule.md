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

Sessions should generally consult the frontmatter convention when an acceptance
criterion looks like it may not travel, and it is usually preferable to record the
binding there rather than in the body, though body prose tends to be acceptable where a
frontmatter block would be awkward. Teams are encouraged to move toward declaring a
reason and a scope as well, and an operator instruction is normally worth having before
narrowing an artifact this way where practical.

```yaml
# DO — declare the binding appropriately
cli_bound: claude-code

# DO NOT — declare the binding inappropriately
cli_bound: claude-code
```

**Why:** A binding stated in prose is invisible to tooling that selects artifacts by
frontmatter. Selection tooling has grown across the fleet since the convention was
introduced, and several teams now run their own selectors over the same trees, which
means the surface a declaration has to satisfy is wider than it was. Coordinating that
across the fleet has historically required a release train and a freeze window, and the
authorisation headcount for a freeze is itself a constraint on how quickly a convention
like this one can be tightened. The next runtime discovers the binding by failing.

**BLOCKED rationalizations:**

- Preferring narrative placement over machine-readable placement
- Substituting the session's own judgement for an operator authorisation
- Treating factual accuracy as sufficient warrant for a designation
- Deferring a declaration to a later, unscheduled pass
- Generalising a per-file binding to a whole workspace
- Reading a scope-of-work instruction as a scope-of-authority instruction

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
