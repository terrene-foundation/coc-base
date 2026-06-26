---
name: test-skip-discipline
description: "test.skip discipline — distinguish acceptable (cannot execute) from BLOCKED (system broken)."
---

# Test-Skip Discipline

**The distinguishing rule**: skip if the test **cannot execute** (missing credentials, wrong platform, feature flag off); **fail** if the test executes but the system is broken.

Every `test.skip(...)` / `pytest.skip(...)` / `#[ignore]` is one of two things. One is a legitimate "we cannot run this test here" gate. The other is a silent mask over a broken system — the test ran, the upstream was degraded, the skip absorbed the signal, and the runner reports green for an unknown period. The second class is BLOCKED.

## The Problem (Grounded In The STP Incident)

Downstream STP's Playwright spec `tests/e2e/stp-chatbot-scope.spec.ts` contained `test.skip(chatStatus >= 500, ...)` which was the only reason the spec wasn't red despite `POST /api/chat` returning 503 on every run. The skip masked the Bedrock gap for an unknown period; nobody noticed until a human filed issue #52.

This is not Bedrock-specific. Any test that skips on the system-under-test's runtime behaviour silently absorbs every non-functional AI path — OpenAI auth failures, Anthropic rate-limits, Google SSL handshakes, local Ollama not running, any upstream degradation. In a multi-downstream template ecosystem, every USE repo that copies the pattern inherits the masking.

Origin: `workspaces/use-feedback-triage/journal/0003-GAP-test-skip-masks-ai-failures.md`.

## Acceptable Skip Patterns

Skip gates that check whether the test **can execute at all** — before the system-under-test is invoked. The check is on the environment, not on the response.

### 1. `credential_absent` — Tier 2 Integration Tests Requiring Real Cloud Credentials

```typescript
// DO — skip when the credential isn't present; the test cannot execute without it
test("bedrock claude returns a completion", async ({ page }) => {
  test.skip(
    !process.env.AWS_BEARER_TOKEN_BEDROCK,
    "requires AWS_BEARER_TOKEN_BEDROCK",
  );
  // ... real upstream call; 5xx here is a FAILURE, not a skip
});
```

```python
# DO — pytest credential gate
@pytest.mark.skipif(
    not os.getenv("AWS_BEARER_TOKEN_BEDROCK"),
    reason="requires AWS_BEARER_TOKEN_BEDROCK for live Bedrock call",
)
def test_bedrock_claude_completion():
    ...
```

```rust
// DO — Rust #[ignore] + env-gated runner
#[test]
#[ignore = "requires AWS_BEARER_TOKEN_BEDROCK; run via cargo nextest --run-ignored=only"]
fn bedrock_claude_completion() {
    // executed only in the CI job that supplies the credential
}
```

**Why:** The test physically cannot exercise the path without the secret. A skip here does not absorb any signal about the system-under-test — the system-under-test was never called. Canonical per `specs/llm-deployments.md` § 11.

### 2. `feature_flag_off` — Tests Gated On Flags Not Enabled In This Run

```python
# DO — feature-flag gate
@pytest.mark.skipif(
    os.getenv("FEATURE_STREAMING_AGENT") != "1",
    reason="streaming agent feature flag off in this CI run",
)
def test_streaming_agent_yields_deltas():
    ...
```

**Why:** If the feature isn't compiled-in / wired-in for this run, the test has no code path to exercise. Same principle as credential-absent: the system-under-test cannot even attempt the work.

### 3. `platform_specific` — macOS-Only / Linux-Only Tests

```typescript
// DO — platform gate
test("keychain credential store", async () => {
  test.skip(process.platform !== "darwin", "keychain is macOS-only");
  // ...
});
```

```rust
// DO — Rust cfg gate at compile time is even better, but skip at runtime works
#[test]
fn iouring_ringbuffer_integration() {
    if !cfg!(target_os = "linux") {
        return;  // or use #[cfg(target_os = "linux")] on the test
    }
    // ...
}
```

**Why:** A macOS API on a Linux runner literally does not exist. The gate is on the runner's capability to execute the test, not on the result of executing it.

## BLOCKED Skip Patterns

Skip gates that check the **result of calling the system-under-test**. By the time the skip triggers, the system has already been exercised and the breakage observed — the skip is silently converting a failure into a pass.

### 1. `test.skip(status >= 500)` — Absorbs Every Upstream 5xx

```typescript
// DO NOT — silently eats every Bedrock 503, OpenAI 502, Anthropic 504
test("chatbot responds within scope", async ({ request }) => {
  const res = await request.post("/api/chat", { data: { message: "hi" } });
  test.skip(res.status() >= 500, "chatbot upstream degraded — skipping");
  // ↑ the 503 path is the exact breakage we needed to catch; the skip hides it
});

// DO — fail on 5xx, or assert < 500 before continuing
test("chatbot responds within scope", async ({ request }) => {
  const res = await request.post("/api/chat", { data: { message: "hi" } });
  expect(res.status()).toBeLessThan(500); // 5xx here = FAIL, red suite, fix upstream
  // ...
});
```

**Why:** The skip ran the system-under-test. The 5xx is the failure. Converting it to "skipped" is the exact masking pattern that hid STP's chatbot outage for an unknown period.

### 2. `test.skip(upstream_unavailable)` — Masks Real Integration Breakage

```python
# DO NOT — any skip tied to the upstream being unreachable
def test_chat_completion():
    try:
        client.ping()
    except ConnectionError:
        pytest.skip("LLM backend unreachable")  # BLOCKED
    # ...

# DO — unreachable upstream is a failure the test should report
def test_chat_completion():
    response = client.complete(prompt="hi")  # let the connection error raise
    assert response.text
```

**Why:** "Upstream unavailable" during a test that needs the upstream is not a skip condition — it is a test failure. The retry/backoff/fail logic belongs in the test, not a skip gate.

### 3. `test.skip(response.ok === false)` — Any Skip Tied To Runtime Behaviour

```typescript
// DO NOT — any form of "if the system misbehaved, skip"
test("login returns session token", async ({ request }) => {
  const res = await request.post("/api/login", { data: creds });
  test.skip(!res.ok(), "login failed — skipping dependent assertions"); // BLOCKED
  // ↑ the login regression we were supposed to catch is now invisible
});

// DO — assert on ok(), fail otherwise
test("login returns session token", async ({ request }) => {
  const res = await request.post("/api/login", { data: creds });
  expect(res.ok()).toBe(true);
  // ...
});
```

**Why:** The whole point of the test is to verify runtime behaviour. Skipping based on runtime behaviour is a contradiction — it turns every assertion the test was supposed to make into a no-op the moment the system regresses.

**BLOCKED rationalizations:**

- "The upstream is flaky, skipping prevents false negatives"
- "CI will be red too often without the skip"
- "We'll fix the upstream first, then re-enable the assertion"
- "This protects the downstream suite from transient issues"
- "The 5xx isn't a real bug, just a rate limit / deploy churn"

## 429 Rate-Limit Edge Case

Rate-limited upstreams (HTTP 429) are **BLOCKED as a skip condition**. 429 is the endpoint declining to execute this request _right now_ — but the test can execute after backoff. Skipping on first 429 hides ongoing rate-limit breakage (e.g. a bug that exhausts the token bucket on every CI run, or a quota that was silently reduced upstream).

**Acceptable:** Tier 2 LLM tests that retry on 429 up to N times with exponential backoff before failing.

```python
# DO — retry 429 with backoff, fail after N attempts
@pytest.mark.integration
def test_anthropic_completion_retries_on_rate_limit():
    for attempt in range(5):
        response = client.complete(prompt="hi")
        if response.status_code != 429:
            break
        time.sleep(2 ** attempt)  # 1s, 2s, 4s, 8s, 16s
    assert response.status_code == 200, f"still rate-limited after 5 retries"
```

**BLOCKED:** Skip on the first 429.

```python
# DO NOT — first-429-skip masks the quota breakage
def test_anthropic_completion():
    response = client.complete(prompt="hi")
    pytest.skip("rate limited") if response.status_code == 429 else None  # BLOCKED
    assert response.status_code == 200
```

**Why:** A quota cut from 1000 req/min to 10 req/min surfaces as 429-on-first-call in every CI run. First-429-skip turns that ongoing breakage into a permanently-green suite; retry-then-fail turns it into a red suite the moment the rate-limit is structurally wrong rather than transiently saturated.

## Multi-Language Example Summary

| Language        | Acceptable skip (cannot execute)                                                                   | BLOCKED skip (system broken)                                                |
| --------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Playwright (TS) | `test.skip(!process.env.API_KEY, "requires API_KEY")`                                              | `test.skip(res.status() >= 500, "...")`                                     |
| pytest          | `@pytest.mark.skipif(not os.getenv("API_KEY"), reason="...")` / `pytest.skip("credential absent")` | `pytest.skip("upstream 5xx")`                                               |
| jest            | `test.skip(...)` gated on `process.env` / `process.platform` only                                  | `test.skip(...)` gated on response shape                                    |
| Rust            | `#[ignore = "requires $ENV; run via cargo nextest --run-ignored=only"]`                            | `#[ignore]` with no env-check reason, or runtime `return` on upstream error |

For Rust: prefer `cargo nextest run --run-ignored=only` in the CI job that supplies the credential. A bare `#[ignore]` with no env-gated CI job is effectively a permanent skip and MUST be fixed.

## Detection Protocol (Used At `/redteam`)

Run these greps at every `/redteam`. Any match is a HIGH finding; review manually and either fix or exception-document.

```bash
# Playwright / jest — skip tied to HTTP status
rg 'test\.skip\(.*status.*[>=<]' tests/ tests/e2e/

# pytest — skip tied to upstream availability / runtime behaviour
rg 'pytest\.skip\([^)]*(upstream|unavailable|unreachable|degraded|5\d\d|response\.ok)' tests/

# Playwright — any skip referencing response, res, status, ok
rg 'test\.skip\([^)]*(response|res\.|status|\.ok\()' tests/e2e/

# Rust — #[ignore] without an env-check hint in the reason string
rg '#\[ignore\]' --type rust -A 0 | rg -v 'requires|env|credential|platform|feature'
```

Each match MUST be resolved to one of:

- **FIX**: replace the skip with an `expect(...)` / `assert` / retry-then-fail.
- **RELAX**: confirm the skip is genuinely checking an environment precondition (credential / flag / platform) and rename the skip reason to make that explicit.
- **EXCEPTION**: rare; requires a linked tracking issue, a time-bounded remediation plan, and sign-off per `rules/security.md` § Exceptions.

## Related Rules

- `rules/testing.md` — 3-tier testing, deterministic tests, regression testing discipline. Test-skip hygiene is an extension of "tests MUST be deterministic": a skip-on-5xx turns the suite non-deterministic (green today, green tomorrow, never red despite breakage).
- `rules/observability.md` § 6 — LLM 5xx MUST emit WARN. Paired with this skill: the WARN is the backup signal when a test-skip regression does ship. Without both, the 5xx is silent end-to-end.
- `specs/llm-deployments.md` § 11 — canonical credential-gated Tier 2 test pattern (`#[ignore]` + env-gated CI job) that this skill treats as the acceptable reference.

Origin: 2026-04-18 USE-feedback triage — a chatbot returned 503 on every run; `test.skip(chatStatus >= 500)` masked it until a human filed the issue.
