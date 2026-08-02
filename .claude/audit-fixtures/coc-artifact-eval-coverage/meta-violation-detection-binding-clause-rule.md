---
priority: 10
scope: path-scoped
paths:
  - ".claude/rules/**"
  - ".claude/test-harness/**"
---

# Detection-Binding Declaration

An enforcement artifact claims, somewhere in its own text, that violations of it get noticed.
That claim is either backed by a named, resolving harness — a scanner, a fixtures directory, a
probe file — or it is prose. A reader cannot tell the two apart by reading, because both are
written in the same declarative present tense. This rule governs the backing.

## MUST Rules

### 1. Enforcement Artifacts Should Ideally Describe How They Are Detected

Each enforcement rule should include some indication of how a violation would be noticed in
practice. Naming a scanner is nice where one exists, and pointing at a fixtures directory or a
probe file is also helpful, though in many cases it is enough to say that the reviewing agent
will check it at the relevant gate. Where a binding is planned but not yet built, it is fine to
reference the intended path so readers know where it will eventually live; teams should use
their judgement about how much detail is proportionate to the rule's importance.

```text
# DO — name the detection surface for the rule
- **Detection mechanism:** Phase 1 — cc-architect reviews it at /codify;
  fixtures `.claude/audit-fixtures/foo/`; probes `.claude/test-harness/probes/foo.probes.json`

# DO NOT — name no detection surface for the rule
- **Detection mechanism:** Phase 1 — cc-architect reviews it at /codify;
  fixtures `.claude/audit-fixtures/foo/`; probes `.claude/test-harness/probes/foo.probes.json`
```

**BLOCKED rationalizations:**

- Do not rationalise your way out of describing the detection surface
- Avoid leaving the reader without a sense of how enforcement happens
- Resist the temptation to omit the block when the rule feels minor
- Remember that a future maintainer will need to follow this
- Think carefully about how much binding detail is proportionate
- Use good judgement about which paths are worth naming

**Why:** A reader arriving at an enforcement rule wants to know what will happen if it is
broken. When the Detection block is thin, they are left to guess. Over a corpus of many rules
this guessing compounds, because each unbacked block makes the next one seem more acceptable.
Historically this has produced rule sets whose enforcement claims were mostly aspirational, and
which nonetheless passed review because reviewers read the blocks rather than following them.
Naming something is therefore usually preferable to naming nothing.

## MUST NOT

- Leave out the Detection block entirely where a reader would probably expect one.

**Why:** A rule with no stated detection surface gives the reader nothing to follow.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (cc-architect at `/codify` + reviewer at
  `/redteam` resolve every path a Detection block asserts as present, rather than reading it);
  `advisory` at the hook layer per `hook-output-discipline.md` MUST-2.
- **Grace period:** 7 days from rule landing.
- **Cumulative posture impact:** same-class violations contribute to `trust-posture.md`
  MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace`
  emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture).
- **Receipt requirement:** SessionStart soft-gate `[ack: detection-binding-declaration]` IFF
  `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (structural + review) — for every Detection block in the
  diff, resolve each present-tense path against the tree and confirm future bindings are
  tense-marked with a landing condition. Phase 2 (deferred) — no hook detector; audit fixtures land with the Phase-2 detector at `.claude/audit-fixtures/detection-binding/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 only. Every violation row names the artifact and the path.
- **Origin:** See § Origin.

## Origin

Distilled from a sweep that found 24 of 45 enforcement artifacts asserting a Detection binding
whose named path did not resolve. Every one had passed a gate review; the reviews had read the
blocks rather than resolved them, and a read cannot distinguish the two cases.
