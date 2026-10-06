# probe-driven-verification — Full Rule Examples

These examples are preserved from canonical `a19f76aa`; the governing clauses
remain in `.claude/rules/probe-driven-verification.md`. The rule carries compact examples and links here for the full forms.

## Example 1

```python
# DO — probe with JSON-schema-validated answer
answer = llm_probe(prompt_template, schema=RecommendationProbeSchema)
return ProbeResult(passed=answer.contains_pick and answer.implications_present)

# DO NOT — regex; passes for "I cannot recommend this approach"
return re.search(r"\b(I recommend|Going with|Pick:)\b", response) is not None
```

## Example 2

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

## Example 3

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

## Example 4

```javascript
// DO — hook lexical advisory + probe-driven gate-review counterpart elsewhere
return { rule_id, severity: "advisory", evidence, detection_layer: "lexical" };
// (gate-review elsewhere): await probeRecommendationQuality(response, judge);

// DO NOT — block-at-tool-call from regex; or hook with no probe layer
{ severity: "block", evidence: "<regex match>" }  // false-positive risk
```

## Example 5

```text
# DO — producer emits at the canonical position; consumer reads ONLY that line
# (line 2, first non-blank under the H1), status from a closed allowlist
<!-- coc:convergence status=CONVERGED rounds=6 crit=0 high=0 -->
verdict = parse_marker(line_2) if line_2.startswith("<!-- coc:convergence ") else UNKNOWN

# DO NOT — infer the verdict from the prose that happens to surround it
if re.search(r"converged", report_md, re.I): verdict = CONVERGED
# matches "NOT converged", "has not yet converged", a doc example of the marker,
# and the sentence "we should have converged" — every one a fabricated pass
```

## Example 6

```javascript
// DO — not-answered is its own outcome, and the caller refuses to score it
if (m) return Number(m[1]);
if (/budget \d+ms exceeded/.test(out)) return UNKNOWN;   // the producer already said so
// DO NOT — absence coerced into a value the caller then compares
return m ? Number(m[1]) : 0;              // "found none" and "never looked" are one number
```

## Rule-body extracts (2026-09-13 rule-injection-budget pass)

Moved out of `.claude/rules/probe-driven-verification.md` to hold that
path-scoped rule under the over-budget `consumer-sdk-src` / `consumer-test`
rule-injection profiles.

**ZERO de-scoping, measured.** The enforcement-token census of the rule body is
unchanged or higher before/after: `must_clause` 10, `must_token` 95 → 97,
`must_not_token` 12, `blocked_token` 13, `why_line` 12, and each of the eight
canonical `wiring:<Field>` bullet counts 3. Every `MUST`, `MUST NOT`, BLOCKED
entry, DO/DO-NOT fenced block and `**Why:**` failure-mode statement stayed in the
rule body; all three Wiring blocks keep all 8 canonical field labels with their
normative statements. STRUCTURAL CLEANUP, not a Rule-10 paired extraction — this
rule is `scope: path-scoped`, so Rule 10's proximity-band gate does not fire.

### Lookup Reference (Not A Governed Surface)

Moved verbatim from the rule body's opening section:

> **Lookup reference (not a governed surface).** The paired skill also tabulates the canonical instrument for recurring **orchestration** status questions — "is that lane still working?", "is CI green on this commit?", "is the path-scoped injection budget clear?" — together with the improvised check that cannot answer each. Those orchestration surfaces are deliberately **NOT** in this rule's `paths:` above, so this rule does not load when such a check is authored: the table is a reference to look up, and the enforcement shape for that class is a callable script, not this rule. Do not read the table's presence as coverage.

### MUST-1 Evidence

Moved verbatim from MUST-1's `**Why:**` line. The failure-mode statement (regex
answers the wrong question; its failure mode is systematic semantic blindness)
stayed in the rule:

> The 2026-04-24 baseline had a CC turn where the agent said "I therefore do not emit `[INJECTED-PS-CANARY]`" — regex (correctly) didn't match, but couldn't distinguish "agent reasoned correctly and refused" from "agent never saw the rule." A probe asking BOTH questions has distinct answers.

Also moved, from the rule's opening paragraph, the canonical illustration in its
original wording (the rule retains the same example in compressed form):

> A test that scans for `recommend` passes when the response says "I cannot recommend" — the exact opposite of intent.

### MUST-3 — the skip-discipline sibling

Moved verbatim from MUST-3's `**Why:**` line:

> Same shape as `skills/test-skip-discipline/SKILL.md` — acceptable skip vs masked failure.

### MUST-5 Grace

Moved verbatim from MUST-5's clause body and `**Why:**` line. The 14-day deadline,
the four plan elements and the post-grace emergency-downgrade consequence all
stayed in the rule:

> (loom `.claude/test-harness/`, fixture matchers in `audit-fixtures/`, lexical hook detectors)

> The grace is enough to draft the plan; actual migration follows the plan's own timeline. A regex assertion of a SEMANTIC property authored AFTER the grace is a regression with traceable accountability.

### MUST-6 — clause-body rationale

Moved verbatim from the MUST-6 clause body. The obligation (producer emits
structured data under a CLOSED allowlist at ONE canonical position; consumer reads
it structurally; absence reports UNKNOWN) stayed in the rule:

> The identical naive-NLP anti-pattern one surface over — **PRODUCTION / runtime code** that machine-reads a semantic property out of content a human wrote in free form (markdown prose, a report narrative, a commit body, an issue description) — was therefore ungoverned, so neither author nor reviewer flagged it.

> because a documentation EXAMPLE of the marker grammar is byte-identical to the authoritative marker: a position-independent read cannot tell the example from the verdict and fabricates a status out of prose. An ever-growing exclusion list (strip code spans, then indented blocks, then block quotes…) is NOT the fix — it is the same infinite-surface chase one layer over.

### MUST-6 Detection Depth

Moved verbatim from the MUST-6 Wiring block's `**Detection mechanism:**` bullet.
The retirement verdict, the three cited rules and the permanent gate-review
disposition stayed in the rule; the pole-separation argument in full moved here:

> The detector this field used to book — an advisory flag on a regex/keyword match applied to a `.md`-sourced string in a non-test path — CANNOT SEPARATE ITS OWN POLES, which is why it was never buildable rather than merely unscheduled: MUST-6's COMPLIANT form is also a match against a `.md`-sourced string on a production path, because reading an emitted marker at its one canonical position is done with a matcher too. What distinguishes the poles is whether the value was EMITTED structurally at the source under a closed allowlist — a fact about a DIFFERENT file, the producer — and whether the extraction target is free-form prose or a controlled grammar, which this block's own `**Severity:**` field already declares judgment-bearing. No argv token, AST node, parsed-document field or git-object fact at tool-call time carries either.

Reachability residual and why the `paths:` globs are NOT widened: see the paired
skill § Detection.

### Origin Evidence

Moved verbatim from the rule's `## Origin` section. The verbatim user directive
and the rule's own framing stayed there:

> Loom's existing `.claude/test-harness/suites/*.mjs` use regex `kind: "contains"` scoring against semantic assertions (e.g., CM3-directive-recommend regex-matches `/Recommend:/`); cumulative effect is a pass-rate disconnected from whether the system performed the required behaviors. csq's `coc-eval` is the canonical full harness and similarly inherits the regex pattern.

Also moved, from the MUST-7 Origin paragraph and the MUST-1..5 Wiring's
`Regression-within-grace` and `Violation scope` bullets:

> the corpus-ceiling and lane-headroom measurements behind placing it here

> Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8 — the same no-dedicated-key disposition `security.md` § Enforcement-Surface Parity and `git.md` § CI-check/merge took.

> Every violation row names the harness/assertion + the semantic claim it scored lexically. The paired skill's canonical-instrument table is reference material and carries NO violation scope.
