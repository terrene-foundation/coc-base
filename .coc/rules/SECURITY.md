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

**Why:** A crafted `mysql://user:%00bypass@host/db` truncates at the null byte to an EMPTY password on the MySQL C client; and encode/decode are dual halves of one contract, so splitting them across modules guarantees drift. Depth: `skills/18-security-patterns/credential-decode-helpers.md`. Origin: same skill (worked code, BLOCKED corpus).

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

**Why:** Quote-escape preserves the attacker's payload intact so the attempt is invisible to any later sweep, and a nested `dict`/`list` for a str-declared field bypasses every string-only check. Depth: `skills/18-security-patterns/sanitizer-contract.md`. Origin: #492/#493, Bug #515 (same skill: worked code, BLOCKED corpus).

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

**Why:** A sibling left unqualified ships the EXACT failure mode the kwarg fixes, and the "safe default" is the insecure default — it is what the vulnerable path already did. Depth: `skills/18-security-patterns/multi-site-kwarg-plumbing.md`. Origin: PR #522/#529 (same skill: worked example, BLOCKED corpus).

## Enforcement-Surface Parity — New Fail-Closed Dimension Lands At Every Surface

When a fix PROMOTES a field to a fail-closed authorization control at the eval surface, EVERY independent validation surface for it — especially a re-registration validator with no shared callee — MUST learn it in the SAME PR via ONE shared restrictiveness function ranking unrecognized values TIGHTEST (fail-closed); an unrecognized→recognized transition WIDENS and MUST raise. Depth: guide.

**Why:** A fail-closed gate the tightening validator never learned lets a re-registration lower the bar as "tightening" — a privilege escalation the fix itself introduced.

**Identity-derivation parity (same-PR sibling sweep).** An approver / decider identity in ANY approval / distinctness check MUST be server-derived (authenticated session, NEVER a body field) on BOTH sides, and a self-approval identity pinned IMMUTABLY at create-time (never re-resolved from mutable role occupancy); a body-supplied or occupancy-re-resolved approver is BLOCKED, and fixing one endpoint MUST sweep ALL sibling decision endpoints same-PR. Depth: `skills/18-security-patterns/secure-defaults-and-approver-identity.md`. Origin: coc-rs #56 Lesson 2.

## Secure-Default For A New Security Feature — Fail-Closed Or Loud-WARN

A NEW security feature whose DEFAULT (config field / kwarg / injected dependency) makes it a SILENT NO-OP MUST instead default fail-CLOSED (feature ON, opt-OUT explicit), OR — when backward-compat forbids on-by-default — emit a LOUD one-time WARN at init/first-use naming the OFF protection + its wiring; a silent-no-op (fail-OPEN) default with neither is BLOCKED.

**Why:** The feature's own tests each wire it, so the un-wired default goes unexercised. Depth: `skills/18-security-patterns/secure-defaults-and-approver-identity.md`.

## Redactor Contract

Subject-keyed redactors (substring-matching a `subject_id`) MUST enforce a subject-id length floor (≥8 chars), failing closed with a typed error naming floor + received length. A scrubbed matching object KEY MUST scrub BOTH key and value — key → `[REDACTED_KEY_N]`, audit trail via the original-hash return.

**Why:** 1–7-char ids substring-match benign strings ("alice" → "malice"); a preserved matching key under `[REDACTED]` leaks the subject's identity. See guide.

## Path Containment — Resolve And Normalize Before The Trust Decision

A filesystem-path containment OR spawn/executable-allowlist decision MUST test the REAL canonical form — BOTH candidate AND boundary root resolved through the SAME resolver (`realpathSync` / `std::fs::canonicalize` / `os.path.realpath`) AND OS-normalized — never the lexical string; fail closed if the path will not resolve.

```text
# DO — resolve BOTH candidate and boundary root through the SAME resolver, then compare canonical forms; fail closed if resolution raises
# DO NOT — compare a realpath'd candidate against a RAW root, trust the lexical string, or claim the realpath re-check defeats TOCTOU
```

**Why:** A symlink at a lexically-contained path whose target escapes the boundary passes every string check and would read/exec out-of-tree content; resolving BOTH sides is the only sound comparison. Scoped **necessary-but-not-sufficient**: the resolve closes the lexical-bypass class but does NOT by itself defeat the check-to-use TOCTOU — that needs fd-based / `O_NOFOLLOW` enforcement AT the sink. Depth: `skills/18-security-patterns/path-containment.md`.

#### Accepted residual — the three-phase TOCTOU is OPEN, not deferred

The normative contract is the `**Why:**` above: resolve BOTH candidate and boundary root through the SAME resolver, and do NOT over-claim the resolve as TOCTOU-complete. Depth — what IS closed, what is NOT and why, and the co-owner acceptance record — lives in `.claude/guides/rule-extracts/security.md` § "Accepted residual — the three-phase TOCTOU".
## Kailash-Specific Security

DataFlow — model-level access control, never expose internal IDs. Nexus — auth on protected routes, rate limiting, CORS. Kaizen — prompt-injection protection, output validation.

## Exceptions

Security exceptions require: written justification, security-reviewer approval, documentation, and a time-limited remediation plan.

Depth — the Trust-Posture Wiring, the rule-graph cross-references and the Origin record — lives in `.claude/skills/32-trust-posture/wiring/security.md`, which every validator reads as part of this rule.
