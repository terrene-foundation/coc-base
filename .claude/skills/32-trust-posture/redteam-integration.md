# /redteam Integration — Posture-Scaled Audit Depth

/redteam audit DEPTH scales with posture: higher trust = lighter touch PER ROUND; lower trust = deeper checks per round. **Convergence is NOT posture-scaled** — every `/redteam` at L2–L5 runs to 2 consecutive clean rounds (per `commands/redteam.md` § Convergence Criteria). Posture sets how deep each round digs, never whether convergence is reached.

## Audit Depth By Posture

Depth is **cumulative down the ladder** (each lower posture's per-round floor includes every higher posture's). The convergence target — 2 consecutive clean rounds + Convergence Criteria 4–6 — is **invariant** at L2–L5.

| Posture               | Per-round audit DEPTH floor (cumulative)                                                             | Convergence target             |
| --------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------ |
| L5 DELEGATED          | Mechanical sweeps (grep, AST, pytest --collect-only, file-existence, marker scrub)                   | **2 consecutive clean rounds** |
| L4 CONTINUOUS_INSIGHT | **+ closure-parity** verification of every prior-round finding                                       | **2 consecutive clean rounds** |
| L3 SHARED_PLANNING    | **+ spec-compliance** audit (literal assertions AST/grep-verified per `specs-authority.md`)          | **2 consecutive clean rounds** |
| L2 SUPERVISED         | **+ full spec-compliance** grep against every pending_verification rule                              | **2 consecutive clean rounds** |
| L1 PSEUDO_AGENT       | **N/A** — no autonomous /implement to red-team; /redteam at L1 is advisory simulation only (no loop) | N/A (no convergence loop)      |

The round depth-sections below (Mechanical Sweeps / Closure-Parity / Spec Compliance) name the depth RUNGS, not a per-round count: at L5 every round applies ≥ the Mechanical-Sweeps rung and the loop runs until 2 are clean; at L2 every round applies all rungs. UNDER-applying the posture's depth floor (e.g., skipping closure-parity at L4) OR stopping before 2 consecutive clean rounds at L2–L5 is the violation logged via `appendViolation` against `redteam/posture-aware-depth`.

### Carve-out — Self-Referential /codify Surface

When a `/codify` proposal touches the self-referential surface allowlist enumerated in `rules/self-referential-codify.md` Rule 2 (codify-class commands, codify-discipline skills/rules, codify-class hooks/bin, audit fixtures, management agents), every round MUST dispatch the full multi-agent team in parallel — reviewer + security-reviewer + cc-architect (or analyst / gold-standards-validator per surface) — REGARDLESS of posture, rather than the posture-reduced per-round depth above. Convergence (2 consecutive clean rounds) is already invariant; this carve-out additionally raises the per-round DEPTH to full-multi-agent on the self-referential surface. See `rules/self-referential-codify.md` Rule 1 for the dispatch contract and Rule 3 for the one-time-per-rule bootstrap-circularity carve-out.

## Mechanical Sweeps (Round 1)

Per `rules/agents.md` "Reviewer Mechanical Sweeps":

- `grep -c` parity on critical call-site patterns
- `pytest --collect-only -q` exit 0 across all test dirs
- Every public symbol in `__all__` added by this PR has an eager import
- AST-walk every `Literal[...]` / `Enum`-valued dispatch parameter; confirm exhaustive branches
- Grep `.claude/learning/violations.jsonl` for unaddressed entries from current session

## Closure-Parity (Round 2)

Per `rules/agents.md` "Audit/Closure-Parity Verification Specialist":

- For every prior-round finding, run gh pr view / gh pr diff / pytest --collect-only
- Convert FORWARDED rows to VERIFIED with command output evidence
- Specialist MUST be Bash+Read equipped (pact-specialist or general-purpose, NOT analyst)

## Spec Compliance (Round 3)

Per `rules/specs-authority.md`:

- For every promise in `specs/`, extract literal assertions (class signatures, field names, test names)
- AST-parse / grep the actual code; compute compliance percentage
- < 100% = block; feed gaps back to /implement

## Patterns From Convergence Arcs (apply across rounds)

The three patterns below are codified from the forest-ledger arc
(journal/0089–0098 — 7-round convergence, mid-arc Option A→B redesign).
They apply at the round-verdict and gate-selection steps, complementing
the round-by-round depth above. Each pattern is a MUST clause; violations
are advisory at hook layer and `halt-and-report` at gate review.

### Round-1 — Canonical-Syntax Fixture Coverage (MUST, Pattern a)

When auditing any contract that DOCUMENTS more than one canonical syntax
form (template syntax, command-flag aliases, accepted prose shapes), the
Round-1 mechanical sweep MUST grep the documentation for every enumerated
canonical form AND confirm at least one green fixture exists per form under
`.claude/audit-fixtures/<tool>/`. Documented-but-unfixtured canonical forms
are HIGH findings regardless of "the tool passes its existing fixtures."

This is the redteam-side complement of `rules/cc-artifacts.md` Rule 9. Rule 9
mandates fixtures per scope-restriction predicate inside a tool; this pattern
mandates fixtures per canonical-form surface a tool's CONTRACT exposes to
users. Both halves required: predicate-level coverage prevents tool-internal
regression; canonical-form coverage prevents user-facing-contract regression.

**BLOCKED rationalizations:**

- "Only one form needs a fixture, the others are obvious"
- "Documentation drift will catch the missing form before users hit it"
- "The canonical forms are equivalent under normalization, so fixturing one is enough"
- "Adding a fixture per form is overhead the contract doesn't warrant"
- "The form was canonical only in passing, not in the primary spec section"

**Why:** A canonical form documented but un-fixtured is a contract surface
the tool's tests do not exercise. Future tool edits silently regress that
form because no fixture flags the regression. Evidence: forest-ledger arc
R5 + R6 each surfaced findings on the `` `F1` → receipt `` backticked
canonical form that the validator's pre-Option-B contract documented as
canonical alongside the bare `F1 → receipt` form, but only the bare form
had fixture coverage. Adding the missing fixtures was a one-line change
per round; the cost was two rounds of agent-time discovering they were
missing.

### Round-N — Cross-Agent CRIT/HIGH Disagreement Resolution (MUST, Pattern b)

When two or more redteam agents return verdicts that disagree on a CRIT or
HIGH finding (one flags, another says clean; or both flag at different
severities), the orchestrator MUST resolve by CONSTRUCTION — re-deriving
the finding from the underlying contract, code, or spec — and NEVER by
averaging severities, taking the majority view, deferring to "the more
thorough agent," or running a third agent as tiebreaker.

The resolution procedure: read the contract section the flagger cited;
trace the failure mode end-to-end against the source; verify by inspection
whether the failure IS or IS NOT structurally possible under the current
implementation. The verdict that survives is the one consistent with the
constructed trace, regardless of which agent originally held it.

**BLOCKED rationalizations:**

- "Two MEDs average to a MED, ship as MED"
- "The reviewer is more thorough, default to its verdict"
- "Let a third agent vote and take majority"
- "The more recent verdict is more current, prefer it"
- "Agents are noisy; one CRIT against one clean rounds to MED"
- "Re-deriving by construction is slow; agents disagreeing on every round is the norm"

**Why:** Procedural tiebreakers (average, majority, recency) preserve the
disagreement as institutional residue — the verdict that ships does not
correspond to any actual structural state of the code. Construction-based
resolution forces the orchestrator back to the contract, which IS the only
falsifiable ground truth. Evidence: forest-ledger arc R5 — reviewer caught
cc-architect's "converged" verdict by re-deriving from the validator
contract; R6 — reviewer refuted cc-architect's CRITICAL by construction
(showed the cited failure mode was structurally impossible under the
post-Option-B contract). In both rounds the loser-by-construction was
correct procedurally and wrong on the contract; only construction
distinguished.

### Round-N — Delete-Heuristic-Tighten-Contract Inflection (MUST, Pattern c)

When a lexical, prose-parsing, or heuristic gate produces CRIT or HIGH
findings across N≥3 convergence rounds on the SAME gate — including
findings that are "regressions-from-fix" of prior rounds on the same gate
— the agent MUST consider that the gate's heuristic IS the failure mode,
not the latest input. Default disposition at N=3: DELETE the heuristic
and replace with a tighter structural contract that makes the failure
class impossible by construction. One more round of "tighten the regex,
re-fixture, re-run" at N≥3 on the same gate is BLOCKED.

"Tighten the contract" means: redesign the underlying input format so the
ambiguity the heuristic was trying to parse cannot occur (e.g., require an
explicit stable ID up-front instead of inferring identity from prose
substring matches). This is design-time defense; the deleted heuristic was
run-time defense against a contract the heuristic itself was the only
enforcement of.

**BLOCKED rationalizations:**

- "One more round will land it"
- "The latest fix is closer than the last, iteration is converging"
- "Deleting the heuristic is over-engineering — patch the edge case"
- "Tightening the contract breaks backward compatibility"
- "The heuristic almost works, we're rounding off the last 5%"
- "N=3 is arbitrary; let's set N=5 and re-evaluate"

**Why:** A heuristic that fails on round N+1 with a finding that is a
COUSIN of round N's finding is evidence the failure class is structurally
larger than the heuristic's domain of correctness. Iteration grows the
heuristic's surface area without closing the class. Evidence: forest-ledger
arc rounds R1–R4 were all on the prose-parser substring-mask class; each
fix surfaced a sibling variant the next round. The Option A→B inflection
(delete the prose-parser entirely, require explicit stable IDs per row)
closed the entire substring-mask + normalization-collision + arrow-split

- receipt-token-in-name family by construction; convergence followed in
  R7 (zero CRIT/HIGH from both soundness agents). One-time authoring cost
  of a short ID per forest row vs standing-residue-forever of a heuristic
  that fails on each new cousin class.

## Posture-aware /redteam invocation

```bash
# /redteam reads posture.json automatically; explicit posture override:
/redteam --posture L4   # forces L4 audit depth even if posture.json says L5
```

The invocation logs a violation if the agent attempts to UNDER-audit (e.g., skipping the spec-compliance depth floor at L3, or stopping before 2 consecutive clean rounds at L2–L5).
