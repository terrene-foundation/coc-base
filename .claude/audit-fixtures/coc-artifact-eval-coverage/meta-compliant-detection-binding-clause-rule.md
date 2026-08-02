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

### 1. A Detection Block MUST Name Its Scanner, Fixtures, And Probes, Every Path Resolving

Every enforcement artifact MUST carry a Detection block naming the concrete artifact-to-harness
binding: the scanner (or the named gate-review that stands in for one), the fixtures directory,
AND the probe file. Every path asserted in the PRESENT tense MUST resolve against the current
tree. A block that names a reviewer and nothing else, or that references a path which does not
resolve, is BLOCKED. A binding that does NOT yet exist MUST be declared in the FUTURE tense with
its landing condition; a declared-future path is not an unresolving present-tense claim.

```text
# DO — every present-tense path resolves; the future one says so
- **Detection mechanism:** Phase 1 — scanner `.claude/bin/foo-readiness-check.mjs`;
  fixtures `.claude/audit-fixtures/foo/`; probes `.claude/test-harness/probes/foo.probes.json`
  (all three registered in eval-manifest.json). Phase 2 (deferred) — no hook detector exists
  yet; its fixtures land WITH it at `.claude/audit-fixtures/foo/hook/`.

# DO NOT — a reviewer named as the whole mechanism, no binding at all
- **Detection mechanism:** cc-architect reviews it at /codify.
```

**BLOCKED rationalizations:**

- "The Detection field already names the gate reviewer; that's the mechanism"
- "The fixtures directory will exist once someone writes the fixtures"
- "Present tense reads better than 'will land'"
- "The path is the one it would live at, so naming it is accurate enough"
- "A cross-reference sweep would catch it if the path were wrong"
- "Nobody follows these paths anyway; the block is documentation"

**Why:** A Detection block naming no resolving harness is institutional prose the reader cannot
follow to the eval that verifies the rule. Naming scanner, fixtures, and probes makes the
binding greppable, so the next cross-reference sweep can confirm it.

## MUST NOT

- Assert a scanner, fixtures directory, or probe file in the present tense when it does not
  resolve against the current tree.

**Why:** A present-tense claim about a path that does not exist is indistinguishable from a
working binding at read time, so it survives every review that does not run the path.

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
