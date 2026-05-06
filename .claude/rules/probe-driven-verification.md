---
priority: 10
scope: path-scoped
paths:
  - "**/test-harness/**"
  - "**/audit-fixtures/**"
  - ".claude/hooks/**"
  - "tests/**"
  - "**/*test*"
  - "**/*spec*"
  - "**/04-validate/**"
  - "**/suites/**"
---

# Probe-Driven Verification — No Regex/Keyword NLP For Semantic Claims

Tests, harnesses, audit fixtures, and detection hooks verify behavior. Regex and keyword scanning answer "did this string appear in the output?" — NOT the question we need answered: "did the system perform the behavior we required?" That's naive bag-of-words NLP. A test that scans for `recommend` passes when the response says "I cannot recommend" — the exact opposite of intent.

Probes ask the question directly. A probe is a structured query against the system-under-test with a defined expected-answer schema and a deterministic scoring rule. The probe MAY be: an LLM-as-judge with JSON-schema output, a subprocess verifier, an AST walker, a structural file/exit-code check, or a domain-specific oracle. The probe MUST NOT be: a regex over assistant prose, a keyword presence/absence check, or a bag-of-words intersection score.

Operational runbook: `skills/12-testing-strategies/probe-driven-verification.md` (probe templates, decision tree, migration translation table).

## MUST Rules

### 1. Semantic Verification MUST Be Probe-Driven, Not Regex/Keyword

Any test or harness assertion that verifies a SEMANTIC property of system output — "the response contained a recommendation", "the agent refused with a rule citation", "the response explained implications" — MUST be a probe (structured query + expected-answer schema + scoring rule). Regex matching, keyword presence, or substring search against semantic claims is BLOCKED.

```python
# DO — probe with JSON-schema-validated answer
answer = llm_probe(prompt_template, schema=RecommendationProbeSchema)
return ProbeResult(passed=answer.contains_pick and answer.implications_present)

# DO NOT — regex; passes for "I cannot recommend this approach"
return re.search(r"\b(I recommend|Going with|Pick:)\b", response) is not None
```

**BLOCKED rationalizations:** "Regex is faster" / "Keywords are deterministic" / "The regex catches 95% of cases" / "We can make the regex tighter" / "LLM-as-judge is also fallible" / "Probe schemas are ceremony for a one-line check" / "We don't have LLM access in this CI environment".

**Why:** Regex answers the WRONG question. The harness exists to verify the system performed a behavior; the regex verifies a string appeared. LLM probes are non-deterministic but their failure mode (occasional misclassification) is recoverable; regex's failure mode (systematic semantic blindness) is not. The 2026-04-24 baseline had a CC turn where the agent said "I therefore do not emit `[INJECTED-PS-CANARY]`" — regex (correctly) didn't match, but couldn't distinguish "agent reasoned correctly and refused" from "agent never saw the rule." A probe asking BOTH questions has distinct answers.

### 2. Every Probe MUST Have An Expected-Answer Schema

A probe definition MUST include: (a) prompt template / verifier invocation, (b) expected-answer schema (JSON Schema, Pydantic, dataclass), (c) scoring rule converting schema-valid answer to pass/fail. Free-text probe answers without a schema are BLOCKED.

```python
# DO — schema constrains the answer
class RefusalProbeAnswer(TypedDict):
    refused: bool
    rule_id_cited: Optional[str]
    citation_format_valid: bool
def score(a: RefusalProbeAnswer) -> bool:
    return a["refused"] and a["rule_id_cited"] and a["citation_format_valid"]

# DO NOT — free-text answer, "scored" via... regex
prompt = "Did the agent refuse and cite a rule? Answer in your own words."
passed = "yes" in llm_probe(prompt).lower()  # regex through the back door
```

**BLOCKED rationalizations:** "Free-text exposes more nuance" / "Schemas constrain the LLM unfairly" / "Schema authoring is overhead for a binary question" / "We can post-process prose later".

**Why:** Free-text answers reintroduce the regex problem at one layer of remove. The schema is the contract: defined question, defined shape, mechanical scoring. Schema-violation = probe failure (re-run or escalate); schema-conformant = scoring is one expression.

### 3. Probes With No LLM Access MUST Be Structural, Not Lexical

When the verification environment has no LLM available (offline CI, deterministic-only), the probe MUST be structural: file existence, exit code, AST shape, schema validation, byte-equality, count-of-elements. Lexical-fallback regex is BLOCKED — the test is either probe-driven (structural here) or marked SKIP with `reason: probe-unavailable-in-this-environment`.

```python
# DO — structural probe (no LLM needed)
return ProbeResult(passed=expected_files <= actual_files, evidence={"missing": missing})

# DO — explicit skip when probe unavailable
if not LLM_AVAILABLE:
    return ProbeResult(passed=None, skipped=True, reason="probe-unavailable: requires LLM judge")

# DO NOT — regex fallback labeled "best-effort"
if not LLM_AVAILABLE:
    return ProbeResult(passed=bool(re.search(r"\brecommend\b", response)))
```

**BLOCKED rationalizations:** "Some verification is better than none" / "Partial coverage is real coverage" / "We can document the regex as a 'best-effort signal'" / "CI environment is fixed, can't add LLM".

**Why:** A regex fallback is anti-coverage. It says PASS when the regex matches and broadcasts to every reader of the harness output: "this verifies the recommendation property" → green → ship. The actual signal ("a string matched a pattern") is buried in the framing. Skipping with explicit reason is honest; running regex and reporting green is not. Same shape as `rules/test-skip-discipline.md` — acceptable skip vs masked failure.

### 4. Hook Detectors MAY Use Lexical Patterns BUT MUST NOT Block

Hooks are the runtime tripwire layer. Per `rules/hook-output-discipline.md` MUST-2, lexical regex matches MUST NOT carry `severity: "block"`. Hook authors MAY use regex for advisory detection (`severity: "advisory"` / `"halt-and-report"`) AS LONG AS (a) the hook output cites lexical detection in `evidence`, AND (b) the same property has a probe-driven gate-review counterpart (reviewer / cc-architect at `/codify` validation runs the probe). Hooks-only verification of a semantic property is BLOCKED — every lexical hook detector MUST have a probe-driven counterpart.

```javascript
// DO — hook lexical advisory + probe-driven gate-review counterpart elsewhere
return { rule_id, severity: "advisory", evidence, detection_layer: "lexical" };
// (gate-review elsewhere): await probeRecommendationQuality(response, judge);

// DO NOT — block-at-tool-call from regex; or hook with no probe layer
{ severity: "block", evidence: "<regex match>" }  // false-positive risk
```

**BLOCKED rationalizations:** "The hook IS the verification" / "Adding a probe doubles the cost" / "Hooks fire on every turn, that's coverage" / "Probes are slow, hooks are fast — keep just the hook".

**Why:** Hooks have the latency budget but not semantic resolution; probes have the resolution but not the latency. A two-layer system (hook = advisory tripwire, probe = authoritative verdict) covers both. Hooks alone produce false positives at scale; probes alone miss the cumulative-violation count for trust-posture downgrade math.

### 5. Migrating Existing Regex Harnesses MUST Document A Probe Plan

Existing test harnesses currently using regex/keyword scoring (loom `.claude/test-harness/`, fixture matchers in `audit-fixtures/`, lexical hook detectors) MUST land a probe-driven migration plan in their owning skill or README within 14 days of this rule landing (2026-05-06 → 2026-05-20). The plan identifies: (a) which assertions are semantic (need probes), (b) which are structural (regex acceptable), (c) the migration order, (d) the LLM-judge or verifier infrastructure required. Regex harnesses that ship NEW assertions after the 14-day grace without a probe plan trigger emergency downgrade per `trust-posture.md` MUST Rule 4.

Plan template + audit table at `skills/12-testing-strategies/probe-driven-verification.md` § "Migrating existing harnesses".

**BLOCKED rationalizations:** "The harness works fine, migration is overhead" / "We'll migrate when we have time" / "The grace is too short" / "Some assertions are 'mostly structural' so regex stays".

**Why:** Without a documented plan + deadline, regex harnesses persist forever — every author looks at the existing pattern and copies it, compounding naive-NLP surface area. The grace is enough to draft the plan; actual migration follows the plan's own timeline. A regex assertion of a SEMANTIC property authored AFTER the grace is a regression with traceable accountability.

## MUST NOT

- **Use regex/keyword/substring matching to verify a semantic claim about system output.**

**Why:** Originating failure mode. Verification is wrong by design — answering the wrong question with deterministic confidence.

- **Bag-of-words scoring** ("count safety-keywords in the response").

**Why:** Bag-of-words is the textbook naive-NLP approach this rule eradicates.

- **Sentiment / "did the response sound concerned" probes** with no schema.

**Why:** Free-text-judging-free-text is the regex problem in LLM clothing. Schemas convert "did it sound concerned" into structured fields.

- **Probes whose schemas are post-hoc-rationalized to pass.**

**Why:** Schema-after-result is scope creep — bar moves to where the work landed.

## Trust Posture Wiring

- **Severity:** `halt-and-report` for new harness authoring after 2026-05-20 that ships regex-for-semantic without a probe plan; `advisory` during the 14-day migration grace; `block` for hook detectors that ship `severity: "block"` from a regex match (already enforced by `hook-output-discipline.md` MUST-2).
- **Grace period:** 7 days from rule landing for the rule itself; 14 days for migration plan landing per MUST-5.
- **Regression-within-grace:** authoring a NEW regex-based semantic assertion within the 7-day grace AND without a probe-plan reference in the same PR triggers emergency downgrade per `trust-posture.md` MUST Rule 4.
- **Receipt requirement:** SessionStart MUST require `[ack: probe-driven-verification]` in the agent's first response IF `posture.json::pending_verification` includes this rule_id AND most recent journal entry references new harness authoring.
- **Detection (hook layer — IMPLEMENTED 2026-05-06):** `.claude/hooks/lib/violation-patterns.js::detectRegexForSemanticAssertion` runs in (a) Stop-event findings against the assistant's final report, and (b) PostToolUse(Edit|Write) findings when file path matches `(\.test|tests?\/|test-harness|suites|audit-fixture)`. Pattern: regex/grep API call (`re.search`, `re.match`, `re.findall`, `str.contains`, `grep -E`, `.test()`, `.match()`) inside a function whose name matches `(verify|score|assert|check|probe)_*(recommend|refus|complian|respons|intent|semantic|quality|outcome|narrative|reasoning)`. 4 audit fixtures committed at `.claude/audit-fixtures/violation-patterns/detectRegexForSemanticAssertion/`. Severity: advisory.
- **Detection (probe layer — gate-review):** at `/redteam` and `/codify`, run probe-coverage check: for every assertion in the harness, classify (structural | semantic | unknown); fail the gate if any `semantic` assertion lacks a probe definition.

## Relationship To Existing Rules

Extends `rules/cc-artifacts.md` Rule 7 (semantic analysis is agents' job, hooks check structure) — same principle applied to harness authoring. Extends `rules/hook-output-discipline.md` MUST-2 (lexical signals MUST NOT carry severity:block) — paired by MUST-4 of this rule (lexical hook MUST have probe-driven counterpart). Extends `rules/testing.md` (audit mode re-derives coverage from scratch) — same shape: probes re-derive semantic verdicts at gate review, not trust prior regex matches.

Distinct from `rules/test-skip-discipline.md` — that rule governs WHEN tests skip; this rule governs HOW tests verify when they run.

## Origin

2026-05-06 — user directive: "test harnesses and tests are written in codebases with naive NLP approaches like regex and keywords. This nonsense MUST BE ERADICATED, and test harnesses MUST be first probe-driven verification runbook." Loom's existing `.claude/test-harness/suites/*.mjs` use regex `kind: "contains"` scoring against semantic assertions (e.g., CM3-directive-recommend regex-matches `/Recommend:/`); cumulative effect is a pass-rate disconnected from whether the system performed the required behaviors. csq's `coc-eval` is the canonical full harness and similarly inherits the regex pattern. This rule lifts probe-driven verification from quality preference to structural MUST clause with grace-period migration discipline.
