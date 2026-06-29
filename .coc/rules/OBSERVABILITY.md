---
id: "OBSERVABILITY"
paths: ["**/*.py", "**/*.rs", "**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"]
---

# Observability Rules

See `.claude/guides/rule-extracts/observability.md` for extended examples, post-mortems, and full triage protocol blocks.

If a code path is not logged, it does not exist. Post-deployment integration failures are almost always failures to observe what was already broken in dev. Logs are the contract that lets the next session know what happened.

## Mandatory Log Points

Every code change MUST emit a structured log line at each juncture. No exceptions.

### 1. Endpoints (HTTP, RPC, MCP, CLI)

Entry, exit, and error each log. Entry captures intent; exit captures outcome + latency; error captures stack + trace ID.

```python
# DO
logger.info("create_user.start", request_id=req.request_id)
try:
    user = await db.express.create("User", req.fields())
    logger.info("create_user.ok", user_id=user["id"], latency_ms=...)
except Exception as e:
    logger.exception("create_user.error", error=str(e))
    raise
# DO NOT — bare handler with zero observability
```

**Why:** Without entry+exit+error, every production failure becomes a guess about which step failed. First 30 minutes of any incident spent recreating what logs should have captured.

### 2. Integration Points (outbound HTTP, DB, queue, file IO, third-party SDK)

Every cross-boundary call MUST log intent (what + where) and result (status + duration). Applies whether call is real, mocked, or against a fake backend.

```python
# DO
logger.info("stripe.charge.start", customer_id=cid, amount_cents=amount)
resp = await stripe.charges.create(...)
logger.info("stripe.charge.ok", charge_id=resp.id, latency_ms=resp.elapsed_ms)
```

**Why:** Outbound calls are where 80% of post-deploy failures live (auth changes, schema drift, network policy). Without boundary logs, can't tell whether your code or the dependency failed.

### 3. Data Calls — Real, Fake, or Simulated

Every data fetch MUST log source mode in the log line. `mode` field lets `grep mode=fake` find every place a fake was left.

```python
# DO — real
logger.info("user.fetch", user_id=uid, source="postgres", mode="real")
# DO — fake (dev only; presence in prod is a violation)
logger.warning("user.fetch", user_id=uid, source="fixture", mode="fake")
# DO NOT — no mode tag, no way to audit
```

**Why:** "Mock data shipped to prod" is recurring; `mode=fake` turns silent disaster into single grep.

### 4. State Transitions, Auth Events, Config Loads

INFO level, once per transition. Auth MUST log subject+action+outcome. Config loads MUST log which file/env var was used.

**Why:** Auth failures and config drifts are 2nd-most-common production incidents; nearly impossible to diagnose without dedicated log lines.

## MUST Rules

### 1. Use The Framework Logger — Never `print`

`print()`, `console.log()`, `eprintln!`, `puts` are BLOCKED in production code. MUST use framework's structured logger.

**Why:** `print` writes unstructured strings to stdout with no level, no field tagging, no routing — cannot be filtered, aggregated, or shipped to an aggregator; disappears on restart.

### 2. Correlation ID On Every Log Line

Every log line in a request/handler/agent execution MUST carry a correlation ID (request_id, trace_id, run_id) bound for the entire scope. Use the framework's context propagation.

```python
# DO
logger = structlog.get_logger().bind(request_id=req.headers["x-request-id"])
# DO NOT — no request_id → cannot reconstruct request flow
```

**Why:** Without correlation IDs, multi-step requests interleave in logs and become impossible to trace. A log without a correlation ID is a sentence without a subject.

### 3. Log Levels Have Distinct Meanings

| Level | When                                                           |
| ----- | -------------------------------------------------------------- |
| ERROR | Operation failed and a user/caller will see it                 |
| WARN  | Operation succeeded but used fallback, retry, or degraded path |
| INFO  | Normal state transition operator should see in production      |
| DEBUG | Step-by-step detail for specific investigation; off by default |

**Why:** When everything is INFO (or ERROR), filters become useless and real incidents drown in noise.

### 4. Never Log Secrets, Tokens, Or PII

See `rules/security.md` § "No secrets in logs". Same rule applies to structured log fields — redact tokens, never log raw credentials.

### 5. Log Triage Gate — Read Before Reporting Done

Before any of `/implement`, `/redteam`, `/deploy`, `/wrapup` reports complete, MUST scan for WARN+ entries and acknowledge each.

Scan commands (run all that apply):

```bash
pytest --tb=short 2>&1 | grep -iE 'warn|error|deprecat|fail' | sort -u
find . -name "*.log" -mmin -120 -exec grep -HnE 'WARN|ERROR|FAIL' {} +
npm run build 2>&1 | grep -iE 'warn|error' | sort -u
cargo build 2>&1 | grep -iE 'warning|error'
pip check 2>&1
```

Disposition per unique entry (not per occurrence):

1. Group identical WARN+ (same file + same pattern = one entry); state disposition once.
2. For each: **Fixed** (+ commit SHA) / **Deferred** (+ reason + todo + human ack) / **Upstream** (+ issue link or pin reason) / **False positive** (+ explanation).
3. Unacknowledged WARN+ BLOCK the gate.

**Exception:** Hooks/cleanup where failure is expected — pre-acknowledge via comment marker (same as `zero-tolerance.md` Rule 3).

**Why:** Logs nobody reads are worse than no logs — illusion of observability while the underlying problem festers. Dedup turns 200-warning run from 200 lines into 5-10 tractable entries.

#### Rule 5a: Audit-Log Files Are NOT Runtime Logs — Use An EXCLUDED_FILES Allowlist

A hook-layer or CI scanner that greps `*.log` for `WARN|ERROR|FAIL` MUST treat structured append-only AUDIT-log files (machine-readable records of classifier decisions, skipped events, redteam verdicts) as distinct from runtime stderr/stdout and exclude them by filename via an `EXCLUDED_FILES` allowlist constant. Per-finding suppression (regex tweaks, line-content filters, ad-hoc `grep -v`) is BLOCKED. Composes with the existing `EXCLUDED_DIRS` exclusion.

```bash
# DO — filename-keyed allowlist; composes with EXCLUDED_DIRS
EXCLUDED_FILES=".journal-skipped.log"; find . -name '*.log' ! -name "$EXCLUDED_FILES" ...
# DO NOT — per-finding regex suppression (every new audit log re-discovers the problem)
... | grep -v 'commit subject: fix.*ERROR'
```

**Why:** An audit log records commit subjects verbatim — `fix(nexus): return INTERNAL_ERROR on …` matches a WARN+ scanner as a guaranteed false positive. Filename-keyed exclusion is the only structural fix that closes the class; regex suppression is unbounded. Evidence + posture wiring: guide § Rule 5a.

### 6. Mask Helper Output Forms

#### 6.1 Mask Failure Sentinels Distinct From Masked Output

Masking helpers MUST return a sentinel distinguishable from successful-mask output on parse failure. Returning the masked-success template on failure is BLOCKED.

```python
# DO
def mask_url(url: str) -> str:
    try: parsed = urlparse(url)
    except Exception: return "<unparseable redis url>"  # grep-able
    if not parsed.scheme or not parsed.hostname: return "<unparseable redis url>"
    return f"{parsed.scheme}://***@{parsed.hostname}:{parsed.port or ''}{parsed.path}"

# DO NOT — "redis://***" looks masked; actually "helper bailed"
```

**Why:** Success-shape on failure makes triage believe the credential was masked when the helper bailed and the credential may have been written to a sibling log line.

#### 6.2 Mask Form Uniform Across Helpers

All URL-masking helpers MUST emit canonical `scheme://***@host[:port]/path`. Stripping userinfo or partial-masking is BLOCKED.

```python
# DO — grep-able via `***@`
return f"redis://***@cache:6379/0"
# DO NOT — strip userinfo (audit cannot find it) / partial mask (leaks username)
```

**Why:** Grep audit for credential leakage searches `***@`. Helpers that strip userinfo silently bypass that audit.

#### 6.3 Credential Redaction Covers Every Observable Surface

When a value that may embed credentials (connection string, pool key, DSN) is masked for one surface, the SAME redaction MUST apply at EVERY surface that interpolates it — log lines, metric label values, exception messages AND attributes, and any public diagnostic return (`get_pool_info`/`pool_keys`/health-report). Masking only the log line is BLOCKED. For composite keys reconstruct the credential segment from the middle fields so a literal delimiter inside a password cannot leak the tail.

```python
# DO — mask at every surface the value reaches
key = mask_pool_key(raw_key); logger.warning("pool.evict", key=key)
metric.labels(pool=key).inc(); return {"pool_key": key}  # return value masked too
# DO NOT — mask the log line only
logger.warning("pool.evict", key=mask_pool_key(raw_key))
return {"pool_key": raw_key}  # diagnostic return leaks the credential
```

**Why:** Metric labels ship to the same aggregators as logs and exception/return surfaces are read by callers; masking one surface leaves the credential on every other. Extends §6.2 (mask-helper form) with the multi-surface sweep. Evidence + posture wiring: guide § Rule 6.3.

### 7. Bulk Operations MUST Log Partial Failures At WARN

Any bulk op (BulkCreate/Update/Delete/Upsert) catching per-row exceptions MUST emit a WARN-level log when `failed > 0`, including op name, total rows, failure count, and sample error. `except Exception: continue` or `pass` without a WARN log is BLOCKED.

```python
# DO
if failed_count > 0:
    logger.warning("bulk_create.partial_failure",
        attempted=total, failed=failed_count,
        first_error=str(errors[0]) if errors else "unknown")
# DO NOT — silent swallow
except Exception: continue
```

**BLOCKED responses:** "caller sees the return value" / "we return a failure list" / "we log at DEBUG".

**Why:** A bulk op returning `failed: 10663` with no WARN line is invisible to alerting pipelines.

### 8. Schema-Revealing Field Names MUST Be DEBUG Or Hashed

Structured log lines emitting schema-level identifiers (model/column/field names from classification, masking, validation paths) MUST be DEBUG — not WARN or INFO. If operational WARN needed, emit a counter OR a hash (first 8 chars of sha256), not the raw field name.

```python
# DO — schema names at DEBUG; operational signal via counter
logger.debug("classification.default_applied", extra={"model": m, "field": f, "default": d})
metrics.classification_defaults.inc()

# DO — hash when WARN required
field_hash = hashlib.sha256(f"{m}.{f}".encode()).hexdigest()[:8]
logger.warning("classification.default_applied", extra={"field_hash": field_hash, "default": d})

# DO NOT — schema names at WARN bleed to aggregators
logger.warning("classification.default_applied", extra={"model": "users", "field": "ssn"})
```

**BLOCKED responses:** "field name isn't the value, just schema" / "operators need to see unclassified fields" / "log aggregator access = database access" / "DEBUG is off in prod, nobody sees it".

**Why:** Log aggregators (Datadog, Splunk, CloudWatch) typically have broader access than the production database — SREs, support, third-party vendors. WARN `field=ssn` reveals `users.ssn` schema to everyone with log read, even if VALUES never leak. Classification metadata is schema-level PII-adjacency.

## MUST NOT

- **Log-and-continue without action.** Catch → log → retry/fallback/re-raise. `logger.error(...); pass` is BLOCKED (same class as `except: pass` in `zero-tolerance.md` Rule 3). Exception: hooks/cleanup.

**Why:** Paper trail of failures that nothing acts on — worst of both worlds, noisy logs + broken behavior.

- **Log-spam in hot loops.** Per-iteration INFO floods aggregators. Use sample-rate or aggregate to one summary line per N items.

**Why:** 1M-row loop × 1 INFO/row = 1M log lines/run — costs money AND crowds out real signal.

- **Unstructured `f"..."` messages.** Pass fields as kwargs to the structured logger, never f-string-interpolate.

```python
# DO   logger.info("user.created", user_id=uid, plan=plan)
# DO NOT logger.info(f"User created: {uid} on {plan}")
```

**Why:** F-string-interpolated messages cannot be queried by field — defeats structured logging; operators must regex-match strings instead of filtering on `user_id`.

- **Silent log-level downgrades.** MUST NOT change WARN/ERROR to INFO to "clean up" CI output. Fix root cause or document suppression in the rule itself.

**Why:** Downgrading to silence noise is Zero-Tolerance Rule 1 violation in disguise — failure still happens, operator just stops seeing it.

Origin: PR #430 red team (2026-04-12) — Rule 8 field-name WARN downgrade to DEBUG (commit 62d64ac7). Rule 6 mask helpers + Rule 7 bulk-op WARN from a BUILD-repo upstream-fixes session (2026-04-12). See guide for full post-mortems.
