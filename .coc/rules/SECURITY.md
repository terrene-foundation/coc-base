---
id: "SECURITY"
---

# Security Rules

ALL code changes in the repository.

Depth for most sections below lives in `.claude/guides/rule-extracts/security.md`.

## No Hardcoded Secrets

All sensitive data MUST use environment variables.

**Why:** Hardcoded secrets persist in git history, CI logs, and error traces — permanently extractable even after deletion.

```
❌ api_key = "sk-..."
❌ password = "admin123"
❌ DATABASE_URL = "postgres://user:pass@..."

✅ api_key = os.environ.get("API_KEY")
✅ password = os.environ["DB_PASSWORD"]
✅ from dotenv import load_dotenv; load_dotenv()
```

## Parameterized Queries

All database queries MUST use parameterized queries or ORM.

**Why:** Without parameterization, user input becomes executable SQL — data theft, deletion, or privilege escalation.

```
❌ f"SELECT * FROM users WHERE id = {user_id}"
❌ "DELETE FROM users WHERE name = '" + name + "'"

✅ "SELECT * FROM users WHERE id = %s", (user_id,)
✅ cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
✅ User.query.filter_by(id=user_id)  # ORM
```

## Credential Decode Helpers

Connection strings carry credentials URL-encoded. **(1)** Every `urlparse(connection_string)` user/password extraction MUST route through ONE shared helper that rejects null bytes AFTER percent-decoding — a call-site `unquote(parsed.password)` is BLOCKED. **(2)** Password pre-encoding helpers (`quote_plus` of `#$@?` etc.) MUST live in that SAME module; per-adapter copies are BLOCKED.

```python
# DO — one helper owns both halves
user, password = decode_userinfo_or_raise(urlparse(preencode_password_special_chars(raw_url)))
# DO NOT — hand-rolled at the call site, no null-byte check
password = unquote(parsed.password or "")
```

**BLOCKED rationalizations:** "The existing site already has the check" / "This is a new dialect, the rule doesn't apply yet" / "We'll consolidate later" / "The URL comes from a trusted config file, null bytes can't happen".

**Why:** A crafted `mysql://user:%00bypass@host/db` truncates at the null byte to an EMPTY password on the MySQL C client; and encode/decode are dual halves of one contract, so splitting them across modules guarantees drift. Worked code, BLOCKED corpus, Origin: `skills/18-security-patterns/credential-decode-helpers.md`.

## Input Validation

All user input MUST be validated before use (type/length/format checks, whitelist when possible) across every attack surface — API, CLI, uploads, forms.

**Why:** Unvalidated input is the entry point for injection, buffer overflows, and type confusion.

## Output Encoding

All user-generated content MUST be encoded before display in HTML templates, JSON responses, and log output.

**Why:** Unencoded user content enables XSS — attackers execute arbitrary JavaScript in other users' browsers.

```
❌ element.innerHTML = userContent
❌ dangerouslySetInnerHTML={{ __html: userContent }}

✅ element.textContent = userContent
✅ DOMPurify.sanitize(userContent)
```

## MUST NOT

- **No eval() on user input**: `eval()`, `exec()`, `subprocess.call(cmd, shell=True)` — BLOCKED

**Why:** `eval()` on user input is arbitrary code execution — the attacker runs whatever they want.

- **No secrets in logs**: MUST NOT log passwords, tokens, or PII

**Why:** Log files are widely accessible and rarely encrypted, turning every logged secret into a breach.

- **No .env in Git**: .env in .gitignore, use .env.example for templates

**Why:** Once committed, secrets persist in git history even after removal, exposed to anyone with repo access.

## Sanitizer Contract — Display Hygiene

DataFlow's `sanitize_sql_input` is defense-in-depth DISPLAY HYGIENE, NOT the primary SQLi defense (parameter binding is). **(1)** Declared-string fields MUST be token-replaced with grep-able sentinels (`STATEMENT_BLOCKED`); quote-escaping (`'` → `''`) is BLOCKED. **(2)** A declared-string field receiving `dict`/`list`/`set`/`tuple` MUST raise `ValueError("parameter type mismatch: …")`; silent `str(value)` coercion is BLOCKED. **(3)** Declared-safe types (`int`, `float`, `bool`, `Decimal`, `datetime`, `date`, `time`) — and `dict`/`list` when THAT is the declared type (JSON/array columns) — MUST pass through unchanged.

```python
# DO — token-replace leaves a grep-able trail; type-confusion raises
"'; DROP TABLE users; --" → "'; STATEMENT_BLOCKED users; -- COMMENT_BLOCKED"
# DO NOT — quote-escape (payload survives as data) or silent str(value) coercion
"'; DROP TABLE users; --" → "''; DROP TABLE users; --"   # intact, invisible to any sweep
```

**BLOCKED rationalizations:** "Token-replace is weaker than quote-escape, we should switch" / "We should silently coerce dict to JSON for safety" / "Type-confusion is an upstream concern, not the sanitizer's job" / "The integration tests can catch these".

**Why:** Quote-escape preserves the attacker's payload intact so the attempt is invisible to any later sweep, and a nested `dict`/`list` for a str-declared field bypasses every string-only check. Worked code, BLOCKED corpus, Origin (#492/#493, Bug #515): `skills/18-security-patterns/sanitizer-contract.md`.

## Multi-Site Kwarg Plumbing

When a security-relevant kwarg (classification policy, tenant/clearance scope, audit ID) is plumbed through a helper, EVERY call site MUST be updated in the SAME PR (`grep` every caller); primary-site-only is BLOCKED.

```python
# DO — grep every caller; both sites get the kwarg in this PR
engine.validate_record(i) -> validate_model(i, policy=..., model_name=...)
express._validate_if_enabled(...) -> validate_model(i, policy=..., model_name=...)
# DO NOT — patch the primary site, leave the sibling on the unqualified signature
express._validate_if_enabled(...) -> validate_model(i)   # sibling still unqualified
```

**BLOCKED rationalizations:** "The primary call site is the one users hit 99% of the time" / "The sibling is rarely used; we'll patch it in a follow-up" / "The helper signature is backwards-compatible, sibling can stay as-is" / "Test coverage will catch divergence later" / "The kwarg has a safe default — siblings still get baseline behaviour".

**Why:** A sibling left unqualified ships the EXACT failure mode the kwarg fixes, and the "safe default" is the insecure default — it is what the vulnerable path already did. Worked example, BLOCKED corpus, Origin (PR #522/#529): `skills/18-security-patterns/multi-site-kwarg-plumbing.md`.

## Enforcement-Surface Parity — New Fail-Closed Dimension Lands At Every Surface

When a fix PROMOTES a field to a fail-closed authorization control at the eval surface, EVERY independent validation surface for it — especially a re-registration validator with no shared callee — MUST learn it in the SAME PR via ONE shared restrictiveness function ranking unrecognized values TIGHTEST (fail-closed); an unrecognized→recognized transition WIDENS and MUST raise. Depth: guide.

**Why:** A fail-closed gate the tightening validator never learned lets a re-registration lower the bar as "tightening" — a privilege escalation the fix itself introduced.

Origin: kailash-py #1456 → kailash-pact 0.14.3 (PR #1459). #1456 promoted `McpToolPolicy.clearance_required` to a fail-closed gate at `_check_clearance` (eval, Step 3.5) but left `_validate_monotonic_tightening` (re-registration) blind to it; a `secret`→None / `secret`→`public` re-registration was accepted as "tightening", silently stripping the gate (caught by an adversarial /redteam, NOT by the existing multi-site grep). Cross-SDK sibling: the Rust SDK binding (same shape).

**Identity-derivation parity (same-PR sibling sweep).** An approver / decider identity in ANY approval / distinctness check MUST be server-derived (authenticated session, NEVER a body field) on BOTH sides, and a self-approval identity pinned IMMUTABLY at create-time (never re-resolved from mutable role occupancy); a body-supplied or occupancy-re-resolved approver is BLOCKED, and fixing one endpoint MUST sweep ALL sibling decision endpoints same-PR. Depth + Origin (coc-rs #56 Lesson 2): `skills/18-security-patterns/secure-defaults-and-approver-identity.md`.

## Secure-Default For A New Security Feature — Fail-Closed Or Loud-WARN

A NEW security feature whose DEFAULT (config field / kwarg / injected dependency) makes it a SILENT NO-OP MUST instead default fail-CLOSED (feature ON, opt-OUT explicit), OR — when backward-compat forbids on-by-default — emit a LOUD one-time WARN at init/first-use naming the OFF protection + its wiring; a silent-no-op (fail-OPEN) default with neither is BLOCKED.

**Why:** The feature's own tests each wire it, so the un-wired default goes unexercised. Depth + evidence: `skills/18-security-patterns/secure-defaults-and-approver-identity.md`.

## Redactor Contract

Subject-keyed redactors (substring-matching a `subject_id`) MUST enforce a subject-id length floor (≥8 chars), failing closed with a typed error naming floor + received length. A scrubbed matching object KEY MUST scrub BOTH key and value — key → `[REDACTED_KEY_N]`, audit trail via the original-hash return.

**Why:** 1–7-char ids substring-match benign strings ("alice" → "malice"); a preserved matching key under `[REDACTED]` leaks the subject's identity. See guide.

## Path Containment — Resolve And Normalize Before The Trust Decision

A filesystem-path containment OR spawn/executable-allowlist decision MUST test the REAL canonical form — BOTH candidate AND boundary root resolved through the SAME resolver (`realpathSync` / `std::fs::canonicalize` / `os.path.realpath`) AND OS-normalized — never the lexical string; fail closed if the path will not resolve.

```text
# DO — resolve BOTH candidate and boundary root through the SAME resolver, then compare canonical forms; fail closed if resolution raises
# DO NOT — compare a realpath'd candidate against a RAW root, trust the lexical string, or claim the realpath re-check defeats TOCTOU
```

**Why:** A symlink at a lexically-contained path whose target escapes the boundary passes every string check and would read/exec out-of-tree content; resolving BOTH sides is the only sound comparison. Scoped **necessary-but-not-sufficient**: the resolve closes the lexical-bypass class but does NOT by itself defeat the check-to-use TOCTOU (a symlink swap between check and the exec/read sink) — that needs fd-based / `O_NOFOLLOW` enforcement AT the sink. Depth (TOCTOU-at-sink enforcement, the OS-normalization matrix, cross-language DO/DO-NOT): `skills/18-security-patterns/path-containment.md`.

Origin: BUILD `SECURITY-PATH-CONTAINMENT-2026-07-16` — a COC eval-harness manifest-scanner used a LEXICAL `resolve()` only; a symlink at a lexically-contained path whose target escaped the boundary passed the string check and would have `execFileSync`'d out-of-tree code (fixed by a `realpathSync` re-check resolving BOTH candidate and root); cross-language sibling kailash-mcp #1833 (resolved-path spawn-allowlist + OS-aware separators + platform-gated suffix + Windows drive-relative).

## Kailash-Specific Security

DataFlow — model-level access control, never expose internal IDs. Nexus — auth on protected routes, rate limiting, CORS. Kaizen — prompt-injection protection, output validation.

## Exceptions

Security exceptions require: written justification, security-reviewer approval, documentation, and a time-limited remediation plan.

## Trust Posture Wiring

Applies to the **Enforcement-Surface Parity** clause (added 2026-07-03, `/sync-from-build` py Shard B). Per `trust-posture.md` MUST-8 grandfather cutoff, this clause lands AT/AFTER the MUST-8 SHA and MUST ship canonical-8-field-compliant; the pre-existing grandfathered sections of this file remain exempt until each is itself `/codify`-touched (the clause-scoped precedent set by `rule-authoring.md`'s own Wiring section).

- **Severity:** `halt-and-report` at gate-review (security-reviewer + cc-architect run the eval-vs-registration surface-parity sweep at `/implement` + `/codify`); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 (no structural signal at tool-call time — the surface-parity property is judgment-bearing).
- **Grace period:** 7 days from clause landing (2026-07-03 → 2026-07-10).
- **Cumulative posture impact:** same-class violations (a fail-closed dimension promoted at the eval surface without the independent registration/tightening validator learning it in the same PR) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key (a review-layer-only judgment property does not warrant an instant-drop key, and minting one would drag `trust-posture.md`, a self-referential-codify allowlist file, into a self-ref edit; the universal `regression_within_grace` trigger already covers it). Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8.
- **Receipt requirement:** SessionStart soft-gate `[ack: security]` IFF `posture.json::pending_verification` includes the `security` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — for any field promoted to a fail-closed authorization control at an eval surface, enumerate ALL validators referencing the control's field/type, then grep each re-registration / monotonic-tightening validator for the field name (absence is a finding); run by security-reviewer at `/implement` + cc-architect at `/codify`. Probes `.claude/test-harness/probes/security.probes.json` — NOT YET AUTHORED, declared in `phase2-deferrals.json::probe_authorship_deferrals`. Phase 2 (deferred) — no hook detector; audit fixtures land with the Phase-2 detector at `.claude/audit-fixtures/enforcement-surface-parity/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** the Enforcement-Surface-Parity clause ONLY (clause-scoped); pre-existing grandfathered `security.md` sections stay exempt until each is itself `/codify`-touched.
- **Origin:** See the clause's Origin (kailash-py #1456 → kailash-pact 0.14.3 #1459). Landed at loom via `/sync-from-build` py Shard B (journal/0402).

## Trust Posture Wiring — Path Containment

Applies to the **Path Containment** clause (added 2026-07-19, Wave-1 sync-from placement, journal/0550). Per `trust-posture.md` MUST-8 grandfather cutoff, this clause lands AT/AFTER the MUST-8 SHA and MUST ship canonical-8-field-compliant; the pre-existing grandfathered sections of this file remain exempt until each is itself `/codify`-touched (the clause-scoped precedent set by this file's own § Enforcement-Surface Parity).

- **Severity:** `halt-and-report` at gate-review (security-reviewer + cc-architect confirm both candidate and boundary root are resolved through the same resolver before a containment / spawn-allowlist decision, that resolution fails closed, and that no realpath check is over-claimed as TOCTOU-complete); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 (no structural signal at tool-call time — path-resolution correctness is judgment-bearing).
- **Grace period:** 7 days from clause landing (2026-07-19 → 2026-07-26).
- **Cumulative posture impact:** same-class violations (a lexical-only containment/allowlist check, a resolved-candidate-vs-raw-root comparison, OR a realpath check over-claimed as defeating TOCTOU) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key (a path-resolution property is review-layer-plus-advisory-hook and does not warrant an instant-drop key; minting one would drag `trust-posture.md`, a self-referential-codify allowlist file, into a self-ref edit; the universal trigger already covers it). Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8 — the same no-dedicated-key disposition § Enforcement-Surface Parity took.
- **Receipt requirement:** SessionStart soft-gate `[ack: security]` IFF `posture.json::pending_verification` includes the `security` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — for any filesystem-path containment or spawn/executable-allowlist decision, security-reviewer at `/implement` + cc-architect at `/codify` confirm BOTH candidate and boundary root are resolved through the same resolver (`realpathSync`/`canonicalize`/`realpath`) + OS-normalized before the comparison, the resolve fails closed, and the sink carries its own fd-based/`O_NOFOLLOW` enforcement rather than relying on the resolve for TOCTOU. Phase 2 (deferred) — no hook detector; audit fixtures land with the Phase-2 detector at `.claude/audit-fixtures/path-containment/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** the Path-Containment clause ONLY (clause-scoped); pre-existing grandfathered `security.md` sections stay exempt until each is itself `/codify`-touched.
- **Origin:** See the clause's Origin (BUILD `SECURITY-PATH-CONTAINMENT-2026-07-16` + kailash-mcp #1833).

## Trust Posture Wiring — Secure-Default For A New Security Feature

Applies to the **Secure-Default For A New Security Feature** clause (added 2026-07-22, `/sync-from-build` Wave-1 placement, loom-sweep-waves-2026-07-22). Per `trust-posture.md` MUST-8 grandfather cutoff, this clause lands AT/AFTER the MUST-8 SHA and MUST ship canonical-8-field-compliant; the pre-existing grandfathered sections of this file remain exempt until each is itself `/codify`-touched (the clause-scoped precedent set by this file's own § Enforcement-Surface Parity).

- **Severity:** `halt-and-report` at gate-review (security-reviewer at `/implement` + cc-architect at `/codify` confirm a new security feature's enabling default fails closed OR emits a loud one-time WARN, AND — for the WARN path — that on-by-default was genuinely infeasible for backward-compat, not merely assumed); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 (a default's fail-open/closed property is judgment-bearing, no structural signal at tool-call time).
- **Grace period:** 7 days from clause landing (2026-07-22 → 2026-07-29).
- **Cumulative posture impact:** same-class violations (a new security feature shipped with a silent-no-op default — neither fail-closed nor a loud one-time WARN) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key (a default-safety property is review-layer-plus-advisory-hook and does not warrant an instant-drop key; minting one would drag `trust-posture.md`, a self-referential-codify allowlist file, into a self-ref edit; the universal trigger already covers it). Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8 — the same no-dedicated-key disposition § Enforcement-Surface Parity took.
- **Receipt requirement:** SessionStart soft-gate `[ack: security]` IFF `posture.json::pending_verification` includes the `security` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — for any NEW security feature gated behind a config field / kwarg / injected dependency, security-reviewer at `/implement` + cc-architect at `/codify` confirm the enabling default either fails closed (feature ON, opt-out explicit) OR emits a loud one-time WARN at init/first-use naming the OFF protection + the exact wiring, AND for the WARN path that on-by-default was genuinely infeasible for backward-compat (not merely assumed). Phase 2 (deferred) — no hook detector; audit fixtures land with the Phase-2 detector at `.claude/audit-fixtures/secure-default-new-feature/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** the Secure-Default clause ONLY (clause-scoped); pre-existing grandfathered `security.md` sections stay exempt until each is itself `/codify`-touched.
- **Origin:** See the clause's Origin (kailash-py #1843 pact 0.16.0 + #1842-S3 kailash 2.58.0). Landed at loom via `/sync-from-build` Wave-1 placement (loom-sweep-waves-2026-07-22).

## Trust Posture Wiring — Approver / Decider Identity Server-Derived + Immutable

Applies to the **§ Enforcement-Surface Parity → "Identity-derivation parity (same-PR sibling sweep)"** extension clause (added 2026-07-22, `/sync-from-use` Wave-1 placement, loom-sweep-waves-2026-07-22; folded into § Enforcement-Surface Parity as an ESP instance at Gate-1 placement to hold the baseline-emission headroom floor). Per `trust-posture.md` MUST-8 grandfather cutoff, this clause lands AT/AFTER the MUST-8 SHA and MUST ship canonical-8-field-compliant; the pre-existing grandfathered sections of this file (including § Enforcement-Surface Parity's OWN prior clause + its own Wiring block above) remain exempt until each is itself `/codify`-touched (the clause-scoped precedent set by this file's own § Enforcement-Surface Parity).

- **Severity:** `halt-and-report` at gate-review (security-reviewer at `/implement` + cc-architect at `/codify` confirm BOTH sides of any distinct-principal / approval / decision / authorization check are server-derived from the authenticated session, that a self-approval identity is captured immutably at create-time rather than re-resolved from mutable role occupancy, AND that the fix swept all sibling decision endpoints for the same body-trust pattern in the same change); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 (no structural signal at tool-call time — identity-derivation provenance is judgment-bearing).
- **Grace period:** 7 days from clause landing (2026-07-22 → 2026-07-29).
- **Cumulative posture impact:** same-class violations (an approver/decider identity taken from a request-body field, only-one-side-server-derived distinctness, a self-approval identity re-resolved at decision-time from mutable role occupancy, OR a fixed approval endpoint whose sibling decision endpoints were not swept in the same change) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key (an identity-derivation / surface-parity property is review-layer-plus-advisory-hook and does not warrant an instant-drop key; minting one would drag `trust-posture.md`, a self-referential-codify allowlist file, into a self-ref edit; the universal trigger already covers it). Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8 — the same no-dedicated-key disposition § Enforcement-Surface Parity took.
- **Receipt requirement:** SessionStart soft-gate `[ack: security]` IFF `posture.json::pending_verification` includes the `security` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — for any approval / decision / authorization / self-approval-distinctness check, security-reviewer at `/implement` + cc-architect at `/codify` confirm BOTH compared principals are derived server-side from the authenticated session (grep the check for any request-body-sourced approver/requester id — a body-field source is a finding), that a self-approval identity is pinned immutably at create-time (not re-resolved from role occupancy at decision-time), and that fixing one endpoint triggered a sweep of ALL sibling decision endpoints for the same body-trust pattern. Phase 2 (deferred) — no hook detector; audit fixtures land with the Phase-2 detector at `.claude/audit-fixtures/approver-identity-server-derived/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** the § Enforcement-Surface Parity "Identity-derivation parity" extension clause ONLY (clause-scoped); pre-existing grandfathered `security.md` sections — including § Enforcement-Surface Parity's own prior clause — stay exempt until each is itself `/codify`-touched.
- **Origin:** See the clause's Origin (kailash-coc-rs #56 downstream upflow (Step-7c), governance-fix redteam — Lesson 2). Landed at loom via `/sync-from-use` Wave-1 placement (loom-sweep-waves-2026-07-22).

**Length rationale (per `rules/rule-authoring.md` MUST NOT § "Rules longer than 200 lines").** Rule body exceeds the 200-line guidance. Named rationale: **defense-surface scope** — security.md is a `priority: 0` baseline rule collecting the always-on security contract across independent surfaces (secrets, parameterized queries, credential-decode helpers, input validation, output encoding, the DataFlow sanitizer contract, multi-site kwarg plumbing, enforcement-surface parity, the redactor contract, path containment, secure-default for a new security feature, approver/decider identity server-derived + immutable), each carrying the DO/DO-NOT + `**Why:**` + clause-scoped Trust-Posture Wiring the meta-rule mandates. Depth for each clause is EXTRACTED to `.claude/skills/18-security-patterns/` + `.claude/guides/rule-extracts/security.md` to hold the baseline near budget. Per that MUST NOT the 200-line cap is guidance and overage is permitted with a named rationale anchored at Origin. Sibling precedent: `artifact-flow.md` + `recommendation-quality.md` length rationales.
