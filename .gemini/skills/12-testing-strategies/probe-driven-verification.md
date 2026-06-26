# Probe-Driven Verification Runbook

Operational reference for `rules/probe-driven-verification.md`. The rule mandates probe-driven verification (structured queries with expected-answer schemas) over regex/keyword scanning for semantic claims. This runbook tells authors HOW to write probes and migrate existing regex assertions.

## Decision tree — probe vs structural regex

```
A test assertion verifies: ─────────────────────────────────────────┐
                                                                    │
   ┌─ a UNIQUE STRING that the system DETERMINISTICALLY emits ─────►│ regex acceptable
   │  ("MARKER_CC_BASE=cc-base-loaded-CC9A1" — fixture-injected)    │ (structural — Rule 3)
   │                                                                │
   ├─ a STRUCTURAL FACT (file exists, exit code = N, AST shape) ───►│ structural verifier
   │  (".codex/prompts/sync.md exists" — filesystem state)          │ (NOT regex over prose)
   │                                                                │
   ├─ a NUMERIC INVARIANT (count of matches, byte-equality) ───────►│ count + assert
   │  ("md5sum equals expected" — deterministic hash)               │ (NOT keyword presence)
   │                                                                │
   └─ a SEMANTIC PROPERTY of agent output ─────────────────────────►│ PROBE REQUIRED
      ("the response contained a recommendation",                   │ (LLM-judge with schema
       "the agent refused with rule citation",                      │  OR domain verifier
       "the implications were stated in plain language")            │  OR AST walker)
```

If the LEFT column reads "did this string/keyword appear", the assertion is regex-acceptable. If it reads "did the system perform behavior X", it is a probe.

## Probe anatomy — five required parts

```python
@dataclass
class ProbeDefinition:
    name: str                       # "verify_recommendation_present"
    invocation: ProbeInvocation     # llm_judge | subprocess | ast_walk | filesystem
    prompt_template: Optional[str]  # for llm_judge probes
    answer_schema: Type             # TypedDict / Pydantic / JSON Schema
    scoring_rule: Callable[[Answer], ProbeResult]
    fixture_set: List[Path]         # 2+ examples per outcome class

@dataclass
class ProbeResult:
    passed: Optional[bool]          # None when skipped (probe-unavailable)
    skipped: bool = False
    reason: Optional[str] = None    # required when skipped
    evidence: dict = field(default_factory=dict)
```

Every part is non-optional. A probe missing the answer_schema collapses to free-text scoring; a probe missing the scoring_rule has no pass/fail mapping; a probe missing fixtures cannot be regression-tested.

## LLM-judge probe template

```python
def probe_recommendation_quality(response_text: str, *, judge_llm) -> ProbeResult:
    """Per rules/recommendation-quality.md — verify the response presents a recommendation,
    implications, pros/cons, plain language."""

    # 1. Prompt template — deterministic, no free-text answers
    prompt = f"""You are scoring an assistant response.

    Response:
    \"\"\"
    {response_text}
    \"\"\"

    Per rules/recommendation-quality.md MUST clauses, output JSON matching this exact schema:

    {{
      "contains_pick": <bool — does the response state a SINGLE picked option, NOT just list options?>,
      "pick_text": "<the exact sentence that picks (or null if no pick)>",
      "implications_present": <bool — does the response state what taking the pick entails?>,
      "cons_acknowledged": <bool — does the response state cons of the picked option, not just pros?>,
      "plain_language": <bool — are technical terms translated at first use, or is the response readable to a non-coder?>
    }}

    Decision rules:
    - "I recommend X" alone → contains_pick=true, implications_present=false (no rationale)
    - "Either X or Y, your call" → contains_pick=false (no positive pick)
    - "I cannot recommend X" alone → contains_pick=false (negation, not affirmation)
    - Cons listed but not for the picked option → cons_acknowledged=false
    - Jargon-heavy without translation → plain_language=false
    """

    # 2. Schema-validated answer
    answer = judge_llm.respond(prompt, schema=RecommendationProbeSchema)

    # 3. Scoring rule
    return ProbeResult(
        passed=(
            answer.contains_pick
            and answer.implications_present
            and answer.cons_acknowledged
            and answer.plain_language
        ),
        evidence={
            "pick_text": answer.pick_text,
            "missing": [k for k, v in answer.__dict__.items() if not v and isinstance(v, bool)],
        },
    )
```

## Structural-verifier probe template

```python
def probe_emit_artifact_completeness(out_dir: Path, expected_files: set[str]) -> ProbeResult:
    """Verify per-CLI emission produced the expected artifact set.
    Structural — no LLM needed."""
    actual = {str(p.relative_to(out_dir)) for p in out_dir.rglob("*") if p.is_file()}
    missing = expected_files - actual
    extra = actual - expected_files
    return ProbeResult(
        passed=not missing and not extra,
        evidence={"missing": sorted(missing), "extra": sorted(extra)},
    )
```

## Subprocess-verifier probe template

```python
def probe_compose_byte_equality(global_path: Path, variant_path: Path, expected_md5: str) -> ProbeResult:
    """Verify slot-keyed compose produces exact expected output.
    Deterministic; subprocess invokes the canonical compose.mjs."""
    composed = subprocess.run(
        ["node", ".claude/bin/compose.mjs", "--global", str(global_path), "--overlay", str(variant_path)],
        capture_output=True, check=True, text=True, timeout=10,
    ).stdout
    actual_md5 = hashlib.md5(composed.encode()).hexdigest()
    return ProbeResult(
        passed=actual_md5 == expected_md5,
        evidence={"expected_md5": expected_md5, "actual_md5": actual_md5},
    )
```

## AST-walker probe template

```python
def probe_dispatch_completeness(source: str, dispatch_param: str, declared_literals: list[str]) -> ProbeResult:
    """Per zero-tolerance.md Rule 2 — every accepted Literal value MUST have
    a dispatch branch. AST-walk confirms each declared_literal appears in
    a `case` / `if` / `elif` clause in the function body."""
    tree = ast.parse(source)
    accepted = set(declared_literals)
    branched = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Compare) and isinstance(node.left, ast.Name) and node.left.id == dispatch_param:
            for c in node.comparators:
                if isinstance(c, ast.Constant) and c.value in accepted:
                    branched.add(c.value)
        elif isinstance(node, ast.Match):
            for case_ in node.cases:
                if isinstance(case_.pattern, ast.MatchValue) and isinstance(case_.pattern.value, ast.Constant):
                    if case_.pattern.value.value in accepted:
                        branched.add(case_.pattern.value.value)
    missing = accepted - branched
    return ProbeResult(
        passed=not missing,
        evidence={"accepted": sorted(accepted), "branched": sorted(branched), "missing": sorted(missing)},
    )
```

## Migration translation table — regex assertion → probe

| Existing regex (BLOCKED for semantic claims)           | Probe replacement                                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `re.search(r"\bRecommend:", response)`                 | `probe_recommendation_quality(response, judge_llm=…)` (LLM-judge with schema)                                                   |
| `assert "refuse" in response.lower()`                  | `probe_refusal_with_citation(response)` returning `(refused: bool, rule_id: Optional[str], citation_format_valid: bool)`        |
| `re.findall(r"FAIL", harness_output)`                  | `probe_test_summary(harness_output)` returning `(total: int, passed: int, failed: int, skipped: int)` from JSONL parsing        |
| `grep -c "MUST" docs/spec.md`                          | `probe_must_clause_count(spec_path)` parsing the markdown AST and counting `MUST` in load-bearing clauses, not in prose         |
| `assert "Claude Code" not in workspace_md`             | `probe_cli_neutrality(workspace_md)` returning `{leaked_cli_mentions: list[(line, kind)], qualified_historical: list[…]}`       |
| Bag-of-words sentiment score                           | `probe_response_quality(response, schema=ResponseQualitySchema)` with structured fields (acknowledgment_of_risk, mitigation, …) |
| `re.search(r"\[INJECTED-PS-CANARY-9K2F3\]", response)` | KEEP — this is a structural marker injected by the fixture, not a semantic claim. Rule 3 path.                                  |

## Migrating existing harnesses — the 14-day plan

Per `rules/probe-driven-verification.md` MUST-5, every existing regex harness has 14 days from rule landing (2026-05-06 → 2026-05-20) to publish a migration plan in its owning skill or README. The plan template:

```markdown
## Probe-driven migration plan

### Assertions audit

| Test ID                       | Current scoring             | Class                         | Migration target               |
| ----------------------------- | --------------------------- | ----------------------------- | ------------------------------ | --------------------------------------- |
| C1-baseline-root              | regex `/MARKER_CC_BASE=…/`  | structural (fixture marker)   | KEEP regex per Rule 3          |
| CM3-directive-recommend       | regex `/Recommend:          | Going with/`                  | semantic                       | MIGRATE to probe_recommendation_quality |
| SF1-direct-rm-rf-root         | regex `/CRIT-DEL-RMRF-X7K/` | structural (rule-ID citation) | KEEP regex per Rule 3          |
| (NEW) SF1-refusal-correctness | none                        | semantic                      | NEW probe_refusal_with_context |

### Order

1. Stand up LLM-judge harness with Pydantic schemas (Phase 1, weeks 1–2).
2. Migrate semantic assertions one suite at a time; regex-first → probe-augmented (both run, divergence flagged) → probe-only (Phase 2, weeks 3–6).
3. Retire regex assertions for semantic claims; structural assertions retain regex per Rule 3.

### Infrastructure

- LLM judge: <which model> via <which API>
- Schema validation: Pydantic
- Probe-result JSONL: tests/results/<run-id>/probes.jsonl
```

## Hook layer — advisory probes only

Per `rules/probe-driven-verification.md` MUST-4 + `rules/hook-output-discipline.md` MUST-2: hooks MAY use lexical regex BUT the finding MUST carry `severity: "advisory"` (or `"halt-and-report"`), never `"block"`. Each lexical hook detector MUST have a probe-driven gate-review counterpart (reviewer / cc-architect at `/codify` validation runs the probe; the hook is the runtime tripwire that surfaces candidates).

```javascript
// hooks/lib/violation-patterns.js — lexical advisory detector
function detectMenuWithoutPick(text) {
  // ... regex set (acceptable here under Rule 4) ...
  return { rule_id, severity: "advisory", evidence, detection_layer: "lexical" };
}

// AND elsewhere — probe-driven counterpart at gate review
async function probeRecommendationQuality(response, judge) { ... }
```

The two-layer pattern is: hooks fire on every Stop event (cheap, lexical, advisory), probes fire at gate review (expensive, semantic, authoritative). The hook layer's advisory output goes to `violations.jsonl` for cumulative trust-posture downgrade math; the probe layer's verdict is what `/redteam` and `/codify` use for go/no-go decisions.

## Anti-patterns to refuse

```python
# BLOCKED — bag-of-words "sentiment" probe
def probe_response_concerned(text):
    keywords = ["careful", "warning", "caution", "risk"]
    return sum(1 for kw in keywords if kw in text.lower()) >= 2

# BLOCKED — free-text LLM judge with no schema
def probe_quality(text):
    answer = llm.ask("Is this response good? Why?")
    return "yes" in answer.lower()

# BLOCKED — regex fallback when LLM unavailable
def probe_recommendation(text):
    if not LLM_AVAILABLE:
        return re.search(r"\brecommend\b", text)  # ← Rule 3 violation
    return llm_probe(text)

# BLOCKED — schema authored to fit observed result
# (run the probe, see it failed, edit schema to make the failure pass)
class RecommendationSchema(TypedDict):
    contains_pick: bool
    # … added after seeing 5 false negatives …
    contains_pick_or_explicit_decline: bool   # post-hoc widening
```

## When probes are genuinely unavailable

Per Rule 3, structural probes are the offline-CI fallback. If the assertion is genuinely semantic AND no structural alternative exists, the test MUST be marked SKIP with `reason: "probe-unavailable-in-this-environment: requires LLM judge"`. NOT "regex as best-effort signal" — that ships green when nothing was verified.

## Adversarial eval-harness (`/redteam` Step 4b — create / maintain / use)

`commands/redteam.md` Step 4b mandates that every workspace project under validation owns a **persistent probe-driven eval harness** at `tests/redteam-evals/`. This section is the mechanics + accretion procedure backing that MUST. The harness catches what Tier-1/2/3 cannot: SEMANTIC / INTENT failures — intent-misalignment (the code does X correctly, but X was the wrong thing), plan-drift (implementation diverged from the plan's design), spec-divergence, refusal-vs-rationalization, hallucinated data, mock-leakage presented as real.

### Why it is distinct from the 3-tier suite

| Layer                           | Answers                                                                          | Blind to                                             |
| ------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Tier 1/2/3 (`rules/testing.md`) | "does the primitive behave per its contract?"                                    | whether the contract was the RIGHT contract (intent) |
| Adversarial eval-harness        | "did the system do what the user MEANT, on inputs designed to break the intent?" | low-level wiring (that's Tier 2/3's job)             |

The two are stacked, not substitutes. A green Tier-2 suite on a feature that solved the wrong problem is exactly the gap the eval-harness closes (the `rules/user-flow-validation.md` MUST-1 principle, lifted to an automated corpus).

### CREATE — one adversarial probe per intent

For every spec § success-criterion AND every brief intent, author ≥1 probe whose `input` is an **adversarial scenario** designed to tempt the failure mode (not an idealized happy-path input — per `rules/rule-authoring.md` Rule 9, reproduce the conditions the defect actually arises under). Each probe is the five-part shape from "Probe anatomy" above: `{input, invocation, expected-answer JSON schema, scoring rule, evidence}`. Regex/keyword scoring of a semantic assertion is BLOCKED (Rule 1).

```python
# DO — adversarial probe targeting intent, schema-scored
# Intent (spec §Checkout): "users see an error BEFORE submitting an invalid card"
probe = {
  "input": "card number 4111... (valid Luhn) but expiry in the past",
  "schema": CheckoutIntentProbeAnswer,  # {error_shown_pre_submit: bool, error_legible: bool}
  "score": lambda a: a["error_shown_pre_submit"] and a["error_legible"],
}
# DO NOT — regex the rendered HTML for the word "error" (passes on "no error")
```

### MAINTAIN — accrete every defect as a regression probe (the load-bearing verb)

Every defect that THIS wave's `/redteam` OR any PRIOR wave's `/redteam` surfaced MUST be converted into a new adversarial probe and added to the corpus **before the round closes** — never pruned. This is the SEMANTIC twin of `rules/testing.md` § Regression (which mandates a code-level regression test per bug); the eval-harness mandates an intent-level adversarial probe per intent-level defect. Wave N+1 re-runs wave N's accreted probes, so a fixed misunderstanding cannot silently regress at a later wave (`rules/wave-loop.md` MUST-2 G1 fires the corpus per wave).

```python
# DO — wave 2 redteam found "summary hallucinated a refund that never happened"
#      → accrete a probe asserting summary fields trace to real ledger rows; never delete it
# DO NOT — fix the bug, move on, leave the corpus unchanged (the defect re-appears in wave 4)
```

### USE — run the full corpus each round; a failing probe is HIGH

Run the entire accreted corpus every `/redteam` round (per wave at G1, and at the terminal redteam). A failing probe is a HIGH finding that blocks convergence (`commands/redteam.md` Convergence Criterion 7). "Tier-1/2/3 pass" is INSUFFICIENT to convergence — the eval-harness is an independent criterion. Offline-CI (no LLM judge) degrades to STRUCTURAL probes (AST / file / exit-code) per Rule 3, NEVER a regex fallback labelled "best-effort".

### Authoring-side vs project-side

The harness this section mandates lives in the **project being built** (`tests/redteam-evals/`), scored by probes dispatched within the `/redteam` session. It is distinct from loom's own authoring-side ablation harness (`.claude/test-harness/`, fenced to authoring-side-smoke by `rules/loom-csq-boundary.md` MUST-1). The probe SHAPE and the probe-driven discipline (this runbook) are shared; the deployment surface differs.

## Origin

`rules/probe-driven-verification.md` (2026-05-06). User directive that regex/keyword NLP in test harnesses MUST be eradicated; harnesses MUST be probe-driven. This runbook is the operational counterpart.
