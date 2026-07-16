---
id: "SPEC-COMPLIANCE"
name: spec-compliance
description: "Spec compliance — verify code matches plan via AST/grep, not file existence. /redteam Step 1."
---

# Spec Compliance Audit

**File existence is NOT compliance.** A file `wrapper_base.py` may exist while none of the spec-required classes inside it do. This skill defines how to verify spec compliance via direct code inspection — AST parsing and targeted greps — instead of trusting that a file at the right path means the right content is there.

## When to Use

- `/redteam` Step 1 — primary use, every round
- `/codify` validation gate before knowledge capture
- Any "is the plan implemented?" question

## The Failure Mode This Prevents

A previous BUILD repo run reported "39/39 PASS, 0 CRITICAL, 0 HIGH" via a `convergence-verify.py` script. A follow-up deep audit found 27+ CRITICAL findings:

- `StreamingAgent.run_stream()` was a fake stream — yielded one synthetic `TextDelta` from a single inner `run_async()` call
- `BaseAgentConfig.posture` field didn't exist (grep returned 0 hits in entire `kaizen/core/`)
- `@deprecated` decorator was defined in `deprecation.py` but never imported by `base_agent.py`
- `client.py` was COPIED, not MOVED — both source and destination existed at full size, drifting apart
- New wrapper modules had ZERO test coverage (`grep "from kaizen_agents.wrapper_base" tests/` returned empty)
- Spec § Security Threats subsections existed only in spec text — no `test_<threat>` functions

The convergence script existed but it was an existence checker (`(path / "__init__.py").exists()`), not a compliance checker. The audit must NOT rely on self-reports written by previous rounds.

## The Method: Spec → Acceptance Assertions → AST/Grep

For each spec section, write down a literal acceptance assertion table, then verify each row against the actual code. Re-derive every check from scratch each round.

### Step 1: Extract Acceptance Assertions From Spec

Read the spec text verbatim. For each promised artifact, write the literal assertion:

| Spec promise                                                            | Acceptance assertion                                                                                                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| "`StreamingAgent.run_stream()` yields `TextDelta` tokens incrementally" | grep `def run_stream` in src; AST: must yield ≥2 distinct values across the loop, NOT a single yield from a single `inner.run_async()` call |
| "`BaseAgentConfig` has frozen field `posture: Posture`"                 | grep `posture:` in `BaseAgentConfig` dataclass body                                                                                         |
| "`@deprecated` decorator applied to 7 extension points"                 | grep `@deprecated` in `base_agent.py` — must hit ≥7 distinct methods                                                                        |
| "MOVE `handler.py` from `app/legacy/` to `app/v2/`"                     | source must be deleted OR <50 LOC OR import-and-warn shim                                                                                   |

### Step 2: Run The 10 Verification Checks

For every spec section, MUST perform every applicable check:

#### 1. Class Signature Verification

Grep the class definition AND verify the constructor signature matches the spec (parameter names + defaults). Use `ast.parse` for precision.

```python
import ast
src = open("src/kaizen/streaming/agent.py").read()
tree = ast.parse(src)
for node in ast.walk(tree):
    if isinstance(node, ast.ClassDef) and node.name == "StreamingAgent":
        init = next((n for n in node.body if isinstance(n, ast.FunctionDef) and n.name == "__init__"), None)
        params = [a.arg for a in (init.args.args if init else [])]
        kwonly = [a.arg for a in (init.args.kwonlyargs if init else [])]
        # Spec: StreamingAgent(inner: BaseAgent, *, buffer_size: int = 64)
        assert params == ["self", "inner"], f"signature mismatch: {params}"
        assert "buffer_size" in kwonly, f"missing keyword-only arg buffer_size"
```

**Grep fallback (less precise):**

```bash
grep -A 5 "^class StreamingAgent" src/kaizen/streaming/agent.py | grep "def __init__"
```

> **Note**: This skill's examples are Python-only because Python is the majority language across USE templates. Compiled-language SDKs maintain their own equivalent verification protocol locally; do NOT add non-Python examples to this skill.

#### 2. Field Presence Verification

For each spec-promised dataclass field, grep the file. Empty grep = FAIL.

```bash
# Spec: BaseAgentConfig has frozen field `posture: Posture`
grep -n "posture:" src/kaizen/agents/base_agent.py | grep -v "^#"
# Zero hits → CRITICAL: BaseAgentConfig.posture missing
```

`ast.parse` is more reliable than grep when fields span multiple lines or have inline comments.

#### 3. Decorator Application Verification

A `@deprecated` decorator existing in `deprecation.py` is NOT enough. Grep the actual call site:

```bash
grep -c "@deprecated\|deprecated(" src/kaizen/agents/base_agent.py
# Spec requires 7 application sites → grep returns 0 → CRITICAL
```

The count must match the spec count, NOT just be ≥ 1. "7 methods marked deprecated" means exactly 7 `@deprecated` lines, not "at least one".

#### 4. MOVE Shim Verification

For every "MOVE A → B" task, the source path A MUST satisfy ONE of:

- (a) deleted entirely
- (b) <50 LOC (a thin shim)
- (c) imports from B AND emits `DeprecationWarning`

```bash
wc -l app/legacy/handler.py app/v2/handler.py
# Both 1088 lines → CRITICAL: copied not moved (drift risk)

# If source is a thin shim, verify it imports from new path AND warns:
grep -E "from app.v2.handler import|warnings.warn.*Deprecat" app/legacy/handler.py
```

#### 5. New Test Coverage Verification

For every new module the spec creates, grep the test directory for an import of that module. Zero importing tests = HIGH finding regardless of "tests pass".

```bash
grep -rln "from kaizen_agents.wrapper_base\|import wrapper_base" the kaizen-agents package directory tests/
# Empty → HIGH: new module has zero test coverage
```

Use `pytest --collect-only -q` to enumerate the test suite when spot-checking is insufficient.

#### 6. Security Mitigation Test Verification

For every § Security Threats subsection in any spec, grep for a corresponding `test_<threat>` function. Missing = HIGH.

```bash
# Spec § Threat: prompt injection via tool description
grep -rln "test.*prompt.*injection\|test.*tool.*description.*injection" tests/
# Empty → HIGH: documented threat has no test
```

#### 7. Import Migration Verification

For every "consumer X migrates to import from Y" task, grep the consumer file for the OLD import path. Hits = FAIL (migration didn't happen).

```bash
grep -rn "from kailash_mcp.client\|import kailash_mcp.client" the kaizen-agents package directory src/
# Any hits → FAIL: migration incomplete
```

#### 8. Fake-Implementation Pattern Scan

Scan for streaming/async methods that fake their contract — methods that promise incremental tokens but yield once:

```bash
# Find run_stream/stream_* methods
grep -rn "def run_stream\|async def stream_" src/

# For each match, count yields in the function body
grep -A 30 "def run_stream" src/kaizen/streaming/agent.py | grep -c "yield"
# Spec says incremental tokens → 1 yield per method → "fake stream" CRITICAL
```

Other fake patterns to scan for:

- `async def` methods that don't `await` anything (synchronous wearing async clothes)
- `__aiter__` returning `self` and `__anext__` raising `StopAsyncIteration` immediately
- Tool methods that return hardcoded responses regardless of input

#### 9. Self-Report Trust Ban

NEVER trust files written by previous rounds:

- `.spec-coverage` (file-existence checker output)
- `.test-results` (may report old-code coverage while new code has zero tests)
- `convergence-verify.py` (often written to make the red team pass, not to test compliance)

Re-derive every check from scratch on every audit round. Self-reports created during a previous /implement or /redteam are inputs to be verified, not evidence to be trusted.

#### 10. Operator-Action Verification

Doc-accuracy is usually indexed by FEATURE status, so a stale OPERATOR-SETUP instruction survives an otherwise-thorough reconciliation — the feature moved on, the setup paragraph did not. Sweep the operator-action surface as a DISTINCT dimension, independent of the feature under review. An operator who follows a stale instruction provisions a resource the live system never consumes (a wrong-instruction / wasted-provisioning outcome).

1. **Enumerate operator-action instructions.** Grep living docs (README, setup/onboarding guides, deploy runbooks, `.env.example`, CI docs) for imperative operator-setup verbs directed at a NAMED resource: "operator must provision / configure / add / set / enable / create / register `<X>`" where `<X>` is a secret, config key, runner, env var, credential, hook, or setting.
2. **Cross-check each against on-disk reality.** For every enumerated `<X>`, grep the live config the instruction TARGETS for the named token — a CI-workflow grep for a named secret, a settings-file grep for a named hook/key, a manifest grep for a named runner. Zero matches in the config the instruction targets = it points at something the live system does not consume = HIGH.
3. **Doc-claim vs git-history.** For every enumerated instruction, resolve the doc's last edit (`git log -1 --format=%cI -- <doc>`), then check whether a later commit invalidated it (`git log --since=<that-date> -- <the-config-it-targets>` shows a migration that removed/renamed `<X>`). An instruction whose last edit predates the commit that obsoleted its named resource = HIGH.

## Output Format

For every spec section produce an assertion table:

| Assertion                              | Method | Expected | Actual | Status   |
| -------------------------------------- | ------ | -------- | ------ | -------- |
| `BaseAgentConfig.posture` field exists | grep   | ≥1       | 0      | CRITICAL |
| `@deprecated` on 7 extension methods   | grep   | 7        | 0      | CRITICAL |
| `StreamingAgent.run_stream` yields ≥2  | AST    | ≥2       | 1      | CRITICAL |
| `client.py` source deleted or thin     | wc -l  | <50      | 1088   | CRITICAL |

Save to `workspaces/<project>/.spec-coverage-v2.md` (the `-v2` suffix prevents confusion with the legacy file-existence report). Include the literal grep/AST commands so the next round can re-run them.

## Convergence Requirement

`/redteam` cannot converge until:

1. Every spec section has its assertion table.
2. Every assertion shows a real verification method (`grep …`, `ast.parse(…)`, `wc -l …`, `pytest --collect-only …`).
3. No row says "exists: yes" — that is a banned phrase. Rows must show the literal command and its actual output count.
4. Every CRITICAL/HIGH row has been fixed and re-verified, not deferred.

## Spec Coverage Audit Cadence

A single R0 grep pass is insufficient. Experience has proven this:
R0 may find and fix a vulnerability at 2 call sites, but a follow-up
R1 grep audit can find the same unprotected pattern at 5 additional
sites that R0 missed because they used a slightly different variable
name (e.g., `parsed.password` vs `result.password`).

**Protocol after the first round of fixes:**

1. Run the original grep pattern against the full codebase, not
   just the files you touched in R0.
2. Expand the grep to cover variant spellings (e.g., `parsed.password`,
   `result.password`, `url_parts.password`, `unquote(.*password`).
3. For each new match, verify the fix is present. Zero-match on
   the expanded grep = confidence the pattern is fully addressed.
4. Document the grep commands in the spec-coverage table so the
   next round can re-run them.

This "grep-for-pattern after R0" step catches drift between call
sites that look different but share the same vulnerability. Without
it, the audit converges on the sites it found first and misses the
sites that use different variable names for the same concept.

## Anti-Patterns

**BLOCKED audit behaviors:**

- Reading `.spec-coverage` from a previous round and trusting it
- Running a script written by a previous round and trusting its output
- Reporting "39/39 PASS" without showing the 39 acceptance assertions
- Using `(path / "__init__.py").exists()` as a compliance check
- Trusting `.test-results` to verify new modules have tests
- Calling a row "exists: yes" without a grep or AST proof
- Skipping checks 5-7 because "the suite passes"
