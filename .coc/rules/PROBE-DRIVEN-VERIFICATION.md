---
id: "PROBE-DRIVEN-VERIFICATION"
paths: ["**/test-harness/**", "**/audit-fixtures/**", ".claude/hooks/**", "tests/**", "**/*test*", "**/*spec*", "**/04-validate/**", "**/suites/**"]
---

# Probe-Driven Verification — No Regex/Keyword NLP For Semantic Claims

Full worked examples: `.claude/guides/rule-extracts/probe-driven-verification-examples.md`.

Tests, harnesses, audit fixtures, and detection hooks verify behavior. Regex and keyword scanning answer "did this string appear in the output?" — NOT the question we need answered: "did the system perform the behavior we required?" That's naive bag-of-words NLP, and it inverts: a scan for `recommend` passes on "I cannot recommend".

Depth — the orchestration status-question instrument table, why those surfaces sit outside this rule's `paths:`, and why its presence is not coverage — lives in the examples extract § Lookup Reference (Not A Governed Surface).

Probes ask the question directly. A probe is a structured query against the system-under-test with a defined expected-answer schema and a deterministic scoring rule. The probe MAY be: an LLM-as-judge with JSON-schema output, a subprocess verifier, an AST walker, a structural file/exit-code check, or a domain-specific oracle. The probe MUST NOT be: a regex over assistant prose, a keyword presence/absence check, or a bag-of-words intersection score.

Operational runbook: `skills/12-testing-strategies/probe-driven-verification.md` (probe templates, decision tree, migration translation table).

## MUST Rules

### 1. Semantic Verification MUST Be Probe-Driven, Not Regex/Keyword

Any test or harness assertion that verifies a SEMANTIC property of system output — "the response contained a recommendation", "the agent refused with a rule citation", "the response explained implications" — MUST be a probe (structured query + expected-answer schema + scoring rule). Regex matching, keyword presence, or substring search against semantic claims is BLOCKED.

```text
DO: validate llm_probe output against RecommendationProbeSchema, then score contains_pick and implications_present.
DO NOT: re.search('I recommend', response); it also matches a refusal.
```

**BLOCKED rationalizations:** "Regex is faster" / "Keywords are deterministic" / "The regex catches 95% of cases" / "We can make the regex tighter" / "LLM-as-judge is also fallible" / "Probe schemas are ceremony for a one-line check" / "We don't have LLM access in this CI environment".

**Why:** Regex answers the **wrong** question. The harness exists to verify the system performed a behavior; the regex verifies a string appeared. LLM probes are non-deterministic but their failure mode (occasional misclassification) is recoverable; regex's failure mode (systematic semantic blindness) is not. The 2026-04-24 canary-turn evidence: extract § MUST-1 Evidence.

### 2. Every Probe MUST Have An Expected-Answer Schema

A probe definition MUST include: (a) prompt template / verifier invocation, (b) expected-answer schema (JSON Schema, Pydantic, dataclass), (c) scoring rule converting schema-valid answer to pass/fail. Free-text probe answers without a schema are BLOCKED.

```text
DO: schema {refused: bool, rule_id_cited: optional string, citation_format_valid: bool}; score all three fields.
DO NOT: ask for free text and score whether 'yes' appears.
```

**BLOCKED rationalizations:** "Free-text exposes more nuance" / "Schemas constrain the LLM unfairly" / "Schema authoring is overhead for a binary question" / "We can post-process prose later".

**Why:** Free-text answers reintroduce the regex problem at one layer of remove. The schema is the contract: defined question, defined shape, mechanical scoring. Schema-violation = probe failure (re-run or escalate); schema-conformant = scoring is one expression.

### 3. Probes With No LLM Access MUST Be Structural, Not Lexical

When the verification environment has no LLM available (offline CI, deterministic-only), the probe MUST be structural: file existence, exit code, AST shape, schema validation, byte-equality, count-of-elements. Lexical-fallback regex is BLOCKED — the test is either probe-driven (structural here) or marked SKIP with `reason: probe-unavailable-in-this-environment`.

```text
DO: compare expected_files <= actual_files; if an LLM judge is required but absent, return an explicit probe-unavailable skip.
DO NOT: fall back to re.search('recommend', response) and report a semantic pass.
```

**BLOCKED rationalizations:** "Some verification is better than none" / "Partial coverage is real coverage" / "We can document the regex as a 'best-effort signal'" / "CI environment is fixed, can't add LLM".

**Why:** A regex fallback is anti-coverage. It says PASS when the regex matches and broadcasts "this verifies the recommendation property" → green → ship, while the actual signal ("a string matched a pattern") is buried in the framing. Skipping with explicit reason is honest; running regex and reporting green is not.

### 4. Hook Detectors MAY Use Lexical Patterns BUT MUST NOT Block

Hooks are the runtime tripwire layer. Per `rules/hook-output-discipline.md` MUST-2, lexical regex matches MUST NOT carry `severity: "block"`. Hook authors MAY use regex for advisory detection (`severity: "advisory"` / `"halt-and-report"`) AS LONG AS (a) the hook output cites lexical detection in `evidence`, AND (b) the same property has a probe-driven gate-review counterpart (reviewer / cc-architect at `/codify` validation runs the probe). Hooks-only verification of a semantic property is BLOCKED — every lexical hook detector MUST have a probe-driven counterpart.

```text
DO: return lexical evidence with severity: advisory; run the paired semantic probe at gate review.
DO NOT: return severity: block from a regex match, or omit the probe counterpart.
```

**BLOCKED rationalizations:** "The hook IS the verification" / "Adding a probe doubles the cost" / "Hooks fire on every turn, that's coverage" / "Probes are slow, hooks are fast — keep just the hook".

**Why:** Hooks have the latency budget but not semantic resolution; probes have the resolution but not the latency. A two-layer system (hook = advisory tripwire, probe = authoritative verdict) covers both — hooks alone produce false positives at scale, probes alone miss the cumulative-violation count.

### 5. Migrating Existing Regex Harnesses MUST Document A Probe Plan

Existing test harnesses currently using regex/keyword scoring — across every surface this rule's `paths:` reaches, `tests/**` included, and NOT only the illustrative `.claude/test-harness/` + `audit-fixtures/` matchers — MUST land a probe-driven migration plan in their owning skill or README within 14 days of this rule landing (2026-05-06 → 2026-05-20). The plan identifies: (a) which assertions are semantic (need probes), (b) which are structural (regex acceptable), (c) the migration order, (d) the LLM-judge or verifier infrastructure required. Regex harnesses that ship NEW assertions after the 14-day grace without a probe plan trigger emergency downgrade per `trust-posture.md` MUST Rule 4.

Plan template + audit table at `skills/12-testing-strategies/probe-driven-verification.md` § "Migrating existing harnesses".

**BLOCKED rationalizations:** "The harness works fine, migration is overhead" / "We'll migrate when we have time" / "The grace is too short" / "Some assertions are 'mostly structural' so regex stays".

**Why:** Without a documented plan + deadline, regex harnesses persist forever — every author looks at the existing pattern and copies it, compounding naive-NLP surface area. Grace-window scope + the post-grace accountability rationale: extract § MUST-5 Grace.

### 6. PRODUCTION Code MUST NOT Infer A Semantic Value From Free-Form Content — Emit It Structurally At The Source

MUST-1 scopes its mandate to "any test or harness assertion"; this clause covers the identical naive-NLP anti-pattern one surface over, in **PRODUCTION / runtime code**. Extracting a semantic value (a verdict, status, classification, decision, or disposition) from free-form content a human wrote — markdown prose, a report narrative, a commit body, an issue description — by regex, keyword, or heuristic matching is BLOCKED in production code exactly as it is in a harness.

When a semantic value must be machine-read, the contract is **producer/consumer structured data, never prose inference**: the PRODUCER emits it as structured data at the source — a fixed-grammar marker, a frontmatter field, or a schema field the emitter controls, with a **CLOSED allowlist** of permitted values — and the CONSUMER reads it structurally (MUST-3's permitted structural parsing). Both halves MUST agree on **ONE canonical position** — a documentation EXAMPLE of the marker grammar is byte-identical to the authoritative marker. Absence of the marker at the canonical position MUST be reported as UNKNOWN, never defaulted to any status.

```text
DO: producer emits a closed-allowlist coc:convergence marker at line 2 under H1; consumer reads only that position or UNKNOWN.
DO NOT: search the prose or any arbitrary marker example for 'converged'.
```

**BLOCKED rationalizations:** "the regex handles the negation case now" / "nine rounds tightened it, it is solid" / "the prose format is stable in practice" / "the rule only covers tests, this is production" / "strip the code spans and it is unambiguous" / "position-independent is more robust to reformatting" / "if the marker is missing, assume the common case" / "an LLM could read the prose reliably" / "adding a marker means changing the producer, which is out of scope".

**Why:** The surface-form space of natural language is unbounded, so every regex over it is a finite net over an infinite space and a NEW misreading is mathematically guaranteed — and the failure is a silently FABRICATED value, reported with the grammar of a measurement. Emitting the value structurally closes the class BY CONSTRUCTION. The nine-round evidence + the exclusion-list chase: extract.

### 7. UNRUNNABLE Is Not A Verdict — And Its Caller Must Not Collapse It

MUST-6 governs a semantic value read out of prose; this governs a check's own VERDICT SPACE. Any
check, gate, probe or test helper whose result another party consumes MUST keep **"could not run"**
structurally distinct from every substantive verdict, on BOTH sides — the PRODUCER emits a
discriminable not-answered signal, the CONSUMER MUST NOT map it onto a substantive value. Coercing
an absent, errored, timed-out, killed or truncated result into a legitimate answer (`0`, empty,
`false`, a short list, an early return, a default status) is BLOCKED. The bar is DISCRIMINABILITY,
not an encoding: what fails is any representation a correct run could also produce.

```text
DO: return a parsed measurement only when present; a declared timeout returns a distinct UNKNOWN outcome the caller cannot score.
DO NOT: return m ? Number(m[1]) : 0; zero conflates 'none found' and 'never looked'.
```

**BLOCKED rationalizations:** "no match means none" / "it returns 0 either way" / "the timeout is
generous" / "a null status is close enough to a failure" / "it has never timed out in practice".

**Why:** once not-having-run is spelled the same as a substantive answer, part of a check's output
is a fact about the INSTRUMENT wearing the subject's grammar — silent by construction, because the
value returned is one the consumer already expected. Worse than a missing check, which is visibly
missing. Depth + the five measured instances: the skill § MUST-7.

## MUST NOT

- **Use regex/keyword/substring matching to verify a semantic claim about system output.**

**Why:** Originating failure mode. Verification is wrong by design — answering the wrong question with deterministic confidence.

- **Bag-of-words scoring** ("count safety-keywords in the response").

**Why:** Bag-of-words is the textbook naive-NLP approach this rule eradicates.

- **Sentiment / "did the response sound concerned" probes** with no schema.

**Why:** Free-text-judging-free-text is the regex problem in LLM clothing. Schemas convert "did it sound concerned" into structured fields.

- **Probes whose schemas are post-hoc-rationalized to pass.**

**Why:** Schema-after-result is scope creep — bar moves to where the work landed.

- **Machine-read a semantic value out of free-form content in PRODUCTION code, or read an emitted marker from anywhere other than its one canonical position.**

**Why:** MUST-6's originating failure mode — the prose surface is unbounded so the parser is guaranteed to fabricate a value eventually, and a position-independent read cannot distinguish a documentation example of the marker from the authoritative one.

## Trust Posture Wiring

- **Severity:** `halt-and-report` for new harness authoring after 2026-05-20 shipping regex-for-semantic without a probe plan; `advisory` during the 14-day migration grace; `block` for hook detectors shipping `severity: "block"` from a regex match (enforced by `hook-output-discipline.md` MUST-2).
- **Grace period:** 7 days from rule landing for the rule itself; 14 days for migration plan landing per MUST-5.
- **Cumulative posture impact:** same-class violations (a NEW regex/keyword/bag-of-words assertion authored against a semantic claim, or a schema-free free-text probe) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** authoring a NEW regex-based semantic assertion within the 7-day grace AND without a probe-plan reference in the same PR routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key; named deviation per `trust-posture.md` Rule 8.
- **Receipt requirement:** SessionStart MUST require `[ack: probe-driven-verification]` in the agent's first response IF `posture.json::pending_verification` includes this rule_id AND most recent journal entry references new harness authoring.
- **Detection (hook layer — IMPLEMENTED 2026-05-06):** `violation-patterns.js::detectRegexForSemanticAssertion`, Stop-event + PostToolUse(Edit|Write) on test-shaped paths, advisory; fixtures `.claude/audit-fixtures/violation-patterns/detectRegexForSemanticAssertion/`. **The orchestration status-check class has NO detector at either layer and is NOT governed by this rule** — a reader MUST NOT infer any detector fires on a `workspaces/**` or `journal/**` edit. Pattern, path filter + the probe-authorship deferral: the skill § Detection.

- **Detection (probe layer — gate-review):** at `/redteam` and `/codify`, run probe-coverage check: for every assertion in the harness, classify (structural | semantic | unknown); fail the gate if any `semantic` assertion lacks a probe definition.
- **Detection mechanism:** the canonical single-field roll-up of the two bullets above, per `trust-posture.md` MUST-8 (the split above predates that mandate and is retained because each half carries detail the roll-up cannot). Phase 1 — the hook-layer `detectRegexForSemanticAssertion` (advisory) plus the gate-review probe-coverage classification. Fixtures `.claude/audit-fixtures/probe-driven-verification/` (this rule's own MUST-1 bipolar set) + `.claude/audit-fixtures/violation-patterns/detectRegexForSemanticAssertion/`; probes `.claude/test-harness/probes/probe-driven-verification.probes.json`, registered probe-only (`scanner: null`) in `.claude/test-harness/eval-manifest.json`, dispatched at gate-review and NOT in CI; disarm-resistance floor `.claude/test-harness/tests/probe-suite-integrity.test.mjs`.
- **Violation scope:** MUST-1 (semantic verification MUST be probe-driven, not regex/keyword), MUST-2 (every probe MUST have an expected-answer schema), MUST-3 (probes with no LLM access MUST be structural, not lexical), MUST-4 (hook detectors MAY be lexical BUT MUST NOT block), MUST-5 (migrating an existing regex harness MUST document a probe plan). Each row names the harness/assertion + the semantic claim it scored lexically; the paired skill's canonical-instrument table carries NO violation scope.
- **Origin:** See § Origin.

## Trust Posture Wiring — MUST-6 (production semantic extraction)

Applies to the **MUST-6** clause ONLY (2026-08-11, `/sync-from-use` Gate-1 placement). Per `trust-posture.md` MUST-8 grandfather cutoff MUST-6 lands AT/AFTER that SHA and MUST ship canonical-8-field-compliant; the MUST-1..5 Wiring above stays grandfathered until itself `/codify`-touched.

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` + cc-architect at `/codify` confirm any production code machine-reading a semantic value reads an emitted structured field at its one canonical position, not a regex over free-form content, and that marker-absence reports UNKNOWN rather than defaulting); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — whether a given extraction target is free-form prose or a controlled grammar is judgment-bearing, so a lexical detector MUST NOT carry `block`.
- **Grace period:** 7 days from clause landing (2026-08-11 → 2026-08-18).
- **Cumulative posture impact:** same-class violations (a production semantic value inferred from free-form content; a marker read position-independently; a missing marker defaulted to a status instead of UNKNOWN) contribute per `trust-posture.md` MUST-4 (3×/5× in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key; MUST-6 does NOT reuse the MUST-1..5 block's disposition. Named deviation per `trust-posture.md` Rule 8.
- **Receipt requirement:** SessionStart soft-gate `[ack: probe-driven-verification]` IFF `posture.json::pending_verification` includes this rule_id (shared rule_id; a single ack covers MUST-1..6).
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer at `/implement` + cc-architect at `/codify` confirm (a) the value is emitted structurally at the source under a closed allowlist, (b) the consumer reads ONE canonical position, (c) absence reports UNKNOWN. Scanner: none (semantic). **The shipped `detectRegexForSemanticAssertion` hook does NOT cover this clause** — its path filter excludes production surfaces by construction, so a reader MUST NOT infer it fires on MUST-6. Fixtures `.claude/audit-fixtures/probe-driven-verification/`; probes `.claude/test-harness/probes/probe-driven-verification.probes.json`. **Phase 2 is RETIRED, not pending (2026-09-13): no hook detector will EVER be built for MUST-6, and no structural audit fixtures are owed** — the disposition MUST-7 below records: the candidate detector CANNOT SEPARATE ITS OWN POLES, since MUST-6's COMPLIANT form is also a matcher over a `.md`-sourced string on a production path. An instrument firing identically on both poles is not evidence (`instrument-discipline.md` MUST-1), `hook-output-discipline.md` MUST-2 bars a lexical signal from carrying `block`, and `rule-authoring.md` MUST NOT names booking such a detector as teeth that cannot arrive. **Gate-review IS the enforcement layer for MUST-6, permanently.** Depth: the examples extract § MUST-6 Detection Depth.
- **Violation scope:** MUST-6 ONLY (clause-scoped) — production semantic extraction from free-form content, position-independent marker reads, and marker-absence defaulted to a status. MUST-1..5 stay on the grandfathered block above; every `violations.jsonl` row names the extracting call site + the value it inferred.
- **Origin:** See § Origin (the downstream-relayed convergence-verdict parser).

**Eval-coverage note (plumbing carve-out, recorded not implied).** The paired `commands/redteam.md` § 5 marker-EMIT step ships NO probe suite and NO manifest entry: it adds no load-bearing MUST of its own — MUST-6 governs — so it falls under `coc-artifact-eval-coverage.md` MUST-1's plumbing carve-out. Graduation conditions: extract.

## Trust Posture Wiring — MUST-7 (unrunnable is not a verdict)

Applies to **MUST-7** ONLY (2026-09-06, co-owner-directed); canonical-8-field per `trust-posture.md` MUST-8. Per-field reasoning: the skill § MUST-7 Wiring.

- **Severity:** `halt-and-report` at gate-review; `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 (coerced-vs-measured is judgment over the check's contract; no tool-call-time signal).
- **Grace period:** 7 days from clause landing (2026-09-06 → 2026-09-13).
- **Cumulative posture impact:** same-class violations (an absent match coerced to a count; a killed or timed-out subprocess read as a substantive status; a gate short-circuiting on a deferred entry and reporting the same green) contribute per `trust-posture.md` MUST-4.
- **Regression-within-grace:** GENERIC `regression_within_grace` per `trust-posture.md` MUST-4 (1× = drop 1) — NO dedicated key; named deviation per Rule 8, reasoned in the skill.
- **Receipt requirement:** SessionStart soft-gate `[ack: probe-driven-verification]` IFF `posture.json::pending_verification` includes the rule_id (shared; covers MUST-1..7).
- **Detection mechanism:** Phase 1 gate-review — confirm the producer emits a not-answered signal a correct run could not also produce, and no caller collapsed it. The shipped `detectRegexForSemanticAssertion` does NOT cover this clause. **Phase 2 RETIRED, not deferred; no registry row is minted** — no argv token, AST node or git-object fact carries coerced-vs-measured at tool-call time, and booking teeth that cannot arrive is what `hook-output-discipline.md` MUST-5(b) forbids. **Probes: REGISTERED** — a `MUST-7-firing` bipolar pair; registration buys dispatchability, never execution.
- **Violation scope:** MUST-7 ONLY — a producer with no discriminable not-answered signal, and a consumer that collapses one.
- **Origin:** `journal/0590`; see § Origin.

## Relationship To Existing Rules

Extends `rules/cc-artifacts.md` Rule 7 (semantic analysis is agents' job, hooks check structure). Extends `rules/hook-output-discipline.md` MUST-2 (lexical signals MUST NOT carry severity:block) — paired by MUST-4 here (a lexical hook MUST have a probe-driven counterpart). Extends `rules/testing.md` (audit mode re-derives coverage from scratch). Distinct from `skills/test-skip-discipline/SKILL.md` — that governs WHEN tests skip; this governs HOW tests verify when they run.

## Origin

**MUST-7** — 2026-09-06, co-owner-directed origination; receipt-first `journal/0590` carries the verbatim directive, the five measured instances, the placement measurements, and the checked distinction from `evidence-first-claims.md` MUST-3, `conservation-gate.md` MUST-4 and `instrument-discipline.md` MUST-3. Rule 10 disposition: path (a) paired extraction into the paired skill.

2026-05-06 — user directive: "test harnesses and tests are written in codebases with naive NLP approaches like regex and keywords. This nonsense MUST BE ERADICATED, and test harnesses MUST be first probe-driven verification runbook." This rule lifts probe-driven verification from quality preference to structural MUST clause with grace-period migration discipline. The loom `.claude/test-harness/suites/*.mjs` + csq harness evidence behind it: extract § Origin Evidence.
