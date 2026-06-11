# Observability Rules — Extended Evidence and Examples

Companion reference for `.claude/rules/observability.md`.

## Full Endpoint Log Example

```python
# Full fleshed-out version of Mandatory Log Point §1
@router.post("/users")
async def create_user(req: CreateUserRequest):
    logger.info("create_user.start", route="/users", request_id=req.request_id)
    t0 = time.monotonic()
    try:
        user = await db.express.create("User", req.fields())
        logger.info(
            "create_user.ok",
            user_id=user["id"],
            latency_ms=(time.monotonic() - t0) * 1000,
        )
        return user
    except Exception as e:
        logger.exception(
            "create_user.error",
            error=str(e),
            latency_ms=(time.monotonic() - t0) * 1000,
        )
        raise
```

## Rule 7 — Bulk Op WARN: Evidence

Source audit: `BulkCreate._handle_batch_error()` had `except Exception: continue` with zero logging. `BulkUpsert` used `print()` instead of a structured logger. A bulk op returning `failed: 10663` produced no WARN line in the log pipeline; alerting never fired.

See 0052-DISCOVERY §2.1 and `guides/deterministic-quality/06-observability-primitives.md` §2.

## Rule 8 — Schema-Name Hygiene: Evidence

Origin: Red team review of PR #430 (2026-04-12) flagged the dataflow package (`src/dataflow/classification/policy.py::ClassificationPolicy.classify`) emitting field names at WARN level. Because log aggregators (Datadog, Splunk, CloudWatch) are typically accessible to a broader audience than the production database (SREs, on-call engineers, support staff, third-party observability vendors), a WARN containing `field=ssn` revealed that the `users` table has an `ssn` column to every log reader — even though the VALUES never leaked.

Downgraded to DEBUG-level in commit 62d64ac7. Operators who need to audit unclassified fields enable DEBUG for the audit window.

Threat model: classification metadata is itself schema-level PII-adjacency. A schema leak is a blast-radius multiplier — it reveals WHICH data needs the most protection.

## Rule 5 — Triage Gate: Full Origin

Disposition protocol exists because early iterations reported "200 WARN entries" per run with no action taken. Agents rationally skipped the gate (200 disposition lines per run). Adding dedup (group-by-source-file + message pattern) reduced typical runs to 5-10 unique entries — tractable for per-entry disposition.

Origin traces to multiple sessions where silent-WARN patterns re-surfaced: `workspaces/arbor-upstream-fixes/.session-notes` (2026-04-12) + PR #466 (63-warning sweep, 2026-04-14). The rule is now the structural defense against warning-creep.

## Rule 6.3 — Multi-Surface Credential Redaction: Evidence

Origin: a pool-key credential-masking fix (#1260, 2026-06-04, 4 security-review rounds). The first round masked only the WARN log line; subsequent rounds surfaced that the same pool key was also interpolated into Prometheus metric label values, exception attributes, and the `get_pool_info`/`get_pool_metrics`/`pool_keys` diagnostic return values — every one an un-masked leak.

For composite keys of shape `loop_id|db_type|connection_string|min|max`, reconstruct the credential segment from the middle fields (`"|".join(parts[2:-2])`) so a literal `|` inside a password cannot leak the tail.

**BLOCKED rationalizations:** "The log line is masked, that's the surface that matters" / "Metric labels are internal" / "The diagnostic return is debug-only" / "Exception attributes aren't logged".

Trust Posture Wiring: Severity `halt-and-report` (gate-review) / `advisory` (hook). Grace 7 days. Cumulative 3× same-rule/30d → drop 1 posture. Detection: reviewer/security-reviewer sweep at `/implement` greps every interpolation site of a masked value for the un-masked variable. Origin: #1260 (2026-06-04).

## Rule 5a — Audit-Log EXCLUDED_FILES Allowlist: Evidence

Origin: PR #1163 (commit 36b8ca3d, 2026-05-28) — a Stop-event log-triage scan surfaced `.journal-skipped.log` entries containing commit subjects with literal `ERROR`/`WARN`/`FAIL` substrings as a recurring "1 unique WARN+ log entries" advisory every session. The audit log is structured machine-readable history of SessionEnd journal-classifier decisions (commit subjects landed verbatim into an append-only audit trail), NOT runtime stderr/stdout — substring matches against WARN+ patterns are guaranteed false positives the moment any logged subject contains those substrings.

The `EXCLUDED_FILES` allowlist is the positive-allowlist shape (per `cc-artifacts.md` Rule 10): explicit enumeration of audit-log filenames the scanner MUST skip, rather than an ever-growing denylist of false-positive line patterns. Any future audit-log filename (`.violation-log`, `.proposal-log`) added to one repo's `EXCLUDED_FILES` propagates via `/sync`.

**BLOCKED rationalizations:** "Just tighten the WARN regex" / "Add a `grep -v` for this subject" / "The advisory is harmless, ignore it" / "Per-finding suppression is simpler than a constant".

Trust Posture Wiring: Severity `halt-and-report` (cc-architect `/codify` sweep against new scanners that grep `*.log` without an `EXCLUDED_FILES` constant) / `advisory` (runtime hook). Grace 7 days. Detection: cc-architect greps `.claude/hooks/**/*.js` for `find … -name '*.log' … grep -HnE 'WARN|ERROR|FAIL'` lacking an adjacent `EXCLUDED_FILES` constant; audit fixtures at `.claude/audit-fixtures/log-triage-gate/`. Origin: PR #1163 commit 36b8ca3d (2026-05-28).
