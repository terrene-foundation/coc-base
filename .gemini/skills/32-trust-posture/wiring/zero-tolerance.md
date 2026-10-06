# zero-tolerance — governance bookkeeping

**This file carries the Trust-Posture Wiring, the rule-graph cross-references and the
Origin record for `.claude/rules/zero-tolerance.md`. It is NOT a rule and states no new
obligation — every MUST and MUST NOT token below RESTATES a clause that lives in the
rule, quoted so the Wiring fields can name what they bind.**

**Why it is here.** Claude Code injects every `.md` under `.claude/rules/` recursively at
launch; the skills tree is not injected. Governance bookkeeping is read by gate-review and
by the validators, never acted on mid-turn, so every session was paying for it. This tree
also SHIPS (`skills/32-trust-posture/**` is a distribution tier) and is already on the
self-referential allowlist, so consumers keep their Wiring and edits here still fire the
Tier-1 gate.

---

## Trust Posture Wiring — Rule 3e (claims about code surface)

Applies to **Rule 3e** ONLY, whose scope was widened 2026-09-08 from doc edits to code comments,
commit bodies and help text. That edit ends this section's grandfathered exemption per
`trust-posture.md` MUST-8, so it ships canonical-8-field-compliant here; every OTHER section of this
file stays exempt until itself `/codify`-touched (the clause-scoped precedent `security.md`
§ Enforcement-Surface Parity and `git.md` § CI-check/merge set).

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at
  `/codify` confirm that a code-surface claim written into a comment, commit body or help text
  carries its `<path>:<start>-<end>` citation, and that the cited range actually contains the claimed
  fact); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — whether a sentence
  ASSERTS a code-surface fact is a semantic judgment over prose, with no structural tool-call-time
  signal.
- **Grace period:** 7 days from clause landing (2026-09-08 → 2026-09-15).
- **Cumulative posture impact:** same-class violations (an uncited call-site enumeration, guard
  predicate or fence-set claim in a comment, commit body or help text; a citation whose range does
  not contain the claimed fact) contribute to `trust-posture.md` MUST-4 cumulative-window math
  (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through
  the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1
  posture) — NO dedicated per-clause trigger key. Named deviation from the canonical key-per-clause
  shape, recorded here per `trust-posture.md` Rule 8, on this clause's OWN reasoning: whether prose
  asserts a code-surface fact is resolvable only at the review layer, so it does not warrant an
  instant-drop key, and minting one would drag `trust-posture.md` — a `self-referential-codify.md`
  allowlist file — into a self-referential edit.
- **Receipt requirement:** SessionStart soft-gate `[ack: zero-tolerance]` IFF
  `posture.json::pending_verification` includes the `zero-tolerance` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer + cc-architect inspect any diff
  whose comments, commit body or help text enumerate call sites, consumers, floors, fence sets or
  guard predicates, and confirm each carries a citation whose range holds the fact. **Phase 2 is
  PARTIALLY MECHANIZABLE and that half is the point of this widening**: a checker can verify a cited
  `<path>:<start>-<end>` RESOLVES and that the claim's key tokens appear inside it, which is a
  structural test over a parsed citation rather than a lexical test over prose. What it can NEVER do
  is decide whether an UNCITED sentence was making a claim — that is the semantic half, and it stays
  gate-review permanently. No detector is booked here: booking the mechanizable half without building
  it is exactly the teeth-that-cannot-arrive shape `rule-authoring.md` names, and the generator
  landing alongside this change (move 2) is the first instance rather than a promise. **Probes:
  REGISTERED — `.claude/test-harness/probes/zero-tolerance.probes.json`**, bipolar `pair_id` pairs
  with candidate fixtures + answer-key sidecars at `.claude/audit-fixtures/zero-tolerance/`,
  registered in `eval-manifest.json` as a probe-only entry (`scanner: null`). Row and pair COUNTS are
  deliberately absent from this line: they were not measured when it was written, and this is the
  Detection block of the clause that just widened the citation obligation to comments and commit
  bodies — asserting an unmeasured figure HERE would instance the rule at the site of its own
  amendment. Read the suite for the counts. Registration buys DISPATCHABILITY, never automatic
  execution: no workflow invokes `coc-probe-dispatch.mjs`, and the loom↔csq boundary keeps CI
  LLM-free, so a green CI run is NEVER evidence these probes passed — they execute only when an
  orchestrator dispatches `/test-harness-probe --artifacts` at gate-review. **Consumer note:**
  `.claude/test-harness/probes/zero-tolerance.probes.json` does not ship to use/base, build/base,
  use/py, build/py, use/rs, build/rs (MEASURED with `buildLaneClassifier`: `skip` on 6 of this
  rule's 6 lanes), so no consumer on those lanes receives it; at those targets this tier is not a
  live gate and enforcement is gate-review at the consumer's end. The classifier is shown to
  DISCRIMINATE rather than blanket-skipping `.claude/`: the same call returns `copy/tier_match` on
  all six lanes for `.claude/audit-fixtures/zero-tolerance/`. `build/prism` is `skip/no_tier_match`
  for the RULE itself, which is why the lane set here is six and not seven.
- **Violation scope:** Rule 3e ONLY (clause-scoped) — its citation obligation across all four
  surfaces, and the binding-inheritance re-derivation requirement. Every `violations.jsonl` row names
  the surface (doc / comment / commit body / help text) and the uncited claim.
- **Origin:** See § Origin, and `journal/0604` for the widening's authorization and evidence base.

## Distinct From / Cross-References

**See also:** `rules/time-pressure-discipline.md` — pressure-framing is the common bypass; parallelize, don't defer. The same obligation ships always-on in `rules/autonomous-execution.md` § 10x Throughput Multiplier, which is why this pointer is navigation rather than a second copy of the mandate.
