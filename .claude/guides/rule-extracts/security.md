# Security Rules — Extended Evidence and Examples

Companion reference for `.claude/rules/security.md`. Holds extended
examples, sanitizer contract exhaustive examples, and multi-site
kwarg plumbing full post-mortem that would exceed the 200-line rule
budget.

## Credential Decode Helpers — Extended Rationale

### Null-Byte Rejection — Why it matters

A crafted `mysql://user:%00bypass@host/db` decodes to `\x00bypass`; the MySQL C client truncates credentials at the first null byte and the driver sends an empty password, succeeding against any row in `mysql.user` with an empty `authentication_string`. Drift between sites that have the check and sites that don't is unauditable without a single helper.

Every URL parsing site that extracts `user`/`password` from `urlparse(connection_string)` MUST route through a single shared helper that rejects null bytes after percent-decoding. Hand-rolled `unquote(parsed.password)` at a call site is BLOCKED.

```python
# DO — route through the shared helper
from kailash.utils.url_credentials import decode_userinfo_or_raise

parsed = urlparse(connection_string)
user, password = decode_userinfo_or_raise(parsed)  # raises on \x00 after unquote

# DO NOT — hand-rolled at the call site
from urllib.parse import unquote
parsed = urlparse(connection_string)
user = unquote(parsed.username or "")
password = unquote(parsed.password or "")  # no null-byte check, drifts from other sites
```

**BLOCKED rationalizations:**

- "The existing site already has the check"
- "This is a new dialect, the rule doesn't apply yet"
- "We'll consolidate later"
- "The URL comes from a trusted config file, null bytes can't happen"

### Pre-Encoder Consolidation — Extended

Password pre-encoding helpers (`quote_plus` of `#$@?` etc.) MUST live in the same shared helper module as the decode path. Per-adapter copies are BLOCKED.

```python
# DO — single helper module owns both halves of the contract
from kailash.utils.url_credentials import (
    preencode_password_special_chars,
    decode_userinfo_or_raise,
)
url = preencode_password_special_chars(raw_url)
parsed = urlparse(url)
user, password = decode_userinfo_or_raise(parsed)

# DO NOT — inline pre-encode in each adapter
pwd = pwd.replace("@", "%40").replace(":", "%3A").replace("#", "%23")
url = f"postgresql://{user}:{pwd}@{host}/{db}"  # drifts from decode path silently
```

**Why (extended):** Encode and decode are dual halves of one contract; splitting them across modules guarantees one half drifts. Round-trip tests are only meaningful when both ends share the helper.

Origin: a BUILD-repo upstream-fixes session (2026-04-12).

## Sanitizer Contract — Exhaustive Examples

DataFlow's input sanitizer (the dataflow package (`src/dataflow/core/nodes.py::sanitize_sql_input`)) is a defense-in-depth display-path safety net, NOT the primary SQLi defense. Parameter binding (`$N` / `%s` / `?`) is the primary defense.

### 1. String Inputs Token-Replaced, Not Quote-Escaped

For declared-string fields, the sanitizer MUST replace dangerous SQL keyword sequences with grep-able sentinel tokens (`STATEMENT_BLOCKED`, `DROP_TABLE`, `UNION_SELECT`, etc.). Quote-escaping (`'` → `''`) is BLOCKED.

```python
# DO — token-replace produces grep-able audit trail
"'; DROP TABLE users; --" → "'; STATEMENT_BLOCKED users; -- COMMENT_BLOCKED"

# DO NOT — quote-escape: the payload survives in storage
"'; DROP TABLE users; --" → "''; DROP TABLE users; --"
```

**Why:** Token-replace makes attacker intent grep-able post-incident (`grep STATEMENT_BLOCKED audit.log`). Quote-escape preserves the payload as data, masking that an attack was attempted. The actual injection defense is parameter binding; the sanitizer is the audit trail.

### 2. Type-Confusion MUST Raise, Not Silently Coerce

For declared-string fields receiving `dict` / `list` / `set` / `tuple` values, the sanitizer MUST raise `ValueError("parameter type mismatch: …")`. Silent coercion via `str(value)` is BLOCKED — it lets a nested structure bypass the string-only sanitizer.

```python
# DO — type-confusion is rejected at the validate_inputs gate
if declared_type is str and isinstance(value, (dict, list, set, tuple)):
    raise ValueError(
        f"parameter type mismatch: field '{field_name}' declared as 'str' "
        f"but received '{type(value).__name__}' — type confusion blocked"
    )

# DO NOT — silent str() coercion
value = str(value)  # {"x": "'; DROP TABLE"} becomes "{'x': \"'; DROP TABLE\"}"
# ↑ the dict's contents get sanitized as a string but the original
#   structure already left the validation boundary
```

**Why:** A malicious upstream node that passes `{"injection": "'; DROP TABLE …"}` for a field declared as `str` bypasses every string-only check. Raising at the type-confusion boundary closes the bypass; coercion-to-string converts a structural attack into an unaudited storage event.

### 3. Safe Types Are Returned As-Is

Values of declared-safe types (`int`, `float`, `bool`, `Decimal`, `datetime`, `date`, `time`) MUST pass through unchanged. `dict` and `list` MUST also pass through unchanged when the field's declared type is `dict` or `list` (JSON / array columns). Bug #515 documents this: premature `json.dumps()` on dict/list breaks parameter binding in `AsyncSQLDatabaseNode`.

**BLOCKED rationalizations:**

- "Token-replace is weaker than quote-escape, we should switch"
- "We should silently coerce dict to JSON for safety"
- "Type-confusion is an upstream concern, not the sanitizer's job"
- "The integration tests can catch these"

Origin: GitHub issues #492 (bulk_upsert SQLi via string-escape) + #493 (sanitizer contract drift, 3 pre-existing failing tests). The contract above pins the decision so a future refactor doesn't swing back to quote-escape.

## Multi-Site Kwarg Plumbing — Full Example

When a security-relevant kwarg (classification policy, tenant scope, clearance context, audit correlation ID) is plumbed through a helper, EVERY call site of that helper MUST be updated in the SAME PR. Updating the "primary" call site and deferring siblings is BLOCKED.

```python
# DO — grep every caller, update every sibling, same PR
# Helper added `policy` + `model_name` kwargs for classification sanitisation.
#
# $ grep -rn 'validate_model(' src/ packages/
# the dataflow package directory src/dataflow/features/express.py:_validate_if_enabled
# the dataflow package directory src/dataflow/engine.py::validate_record
# tests/...  (tests covered separately)
#
# Both production call sites get policy+model_name in this PR:
engine.validate_record(instance) -> validate_model(instance, policy=..., model_name=...)
express._validate_if_enabled(...) -> validate_model(instance, policy=..., model_name=...)

# DO NOT — update primary site, skip the sibling
express._validate_if_enabled(...) -> validate_model(instance, policy=..., model_name=...)
engine.validate_record(instance)  -> validate_model(instance)   # bypasses sanitiser
# ↑ The unpatched sibling surface still leaks classified field names / values in
#   error messages; the sanitisation contract is broken on one public entry point.
```

**BLOCKED rationalizations:**

- "The primary call site is the one users hit 99% of the time"
- "The sibling is rarely used; we'll patch it in a follow-up"
- "The helper signature is backwards-compatible, sibling can stay as-is"
- "Test coverage will catch divergence later"
- "The kwarg has a safe default — siblings still get baseline behaviour"

**Why (extended):** A helper that takes a security-relevant kwarg has the kwarg precisely because the unqualified call leaks or misbehaves. Leaving any sibling call site on the unqualified signature ships the exact failure mode the kwarg was introduced to fix; the "safe default" is by definition the insecure default (otherwise the kwarg would not exist). The fix is mechanical — `grep -rn 'helper_name(' .` and patch every hit in the same PR.

**Evidence:** BP-049 (2026-04-19) landed `validate_model(policy=..., model_name=...)` in PR #522 but left `DataFlowEngine.validate_record(instance)` unqualified; post-release reviewer caught it; fast-patched in PR #529 (kailash-dataflow 2.0.12).

Origin: PR #522 / PR #529 (2026-04-19) — BP-049 validation sanitiser plumbing missed one sibling.

## Enforcement-Surface Parity — Shared-Rank-Function Pattern + Detection

The eval-helper call-site grep (Multi-Site Kwarg Plumbing above) is structurally insufficient here: the registration / monotonic-tightening validator is a SEPARATE function with no shared callee, so a grep that follows one helper's call sites CANNOT reach it. The two surfaces MUST consume a SINGLE shared restrictiveness/ordering function so they cannot drift; a hand-synced second copy is a MED-severity finding that MUST carry a pinned parity test asserting byte-identical parse + ordering against the eval gate.

```python
# DO — one shared rank function; the registration validator consumes it, same PR
def _restrictiveness(v):              # the SINGLE ordering: None=widest, unrecognized=tightest
    if v is None: return -1
    try: return LEVELS.index(parse(v))
    except Exception: return len(LEVELS)           # ANY parse failure -> tightest (fail-closed)
def _check_clearance(caller, required): ...                    # eval gate (parse -> fail-closed)
def _validate_monotonic_tightening(old, new):                  # registration gate — SAME PR
    if _restrictiveness(new) < _restrictiveness(old):
        raise GovernanceError(...)                             # may only KEEP or RAISE the bar

# DO NOT — promote the gate at eval, leave the tightening validator blind
def _check_clearance(caller, required): ...                    # new fail-closed gate
def _validate_monotonic_tightening(old, new):
    ...   # never learned the new dimension -> a re-registration that DROPS (secret->None)
          # or LOWERS (secret->public) the bar is accepted as "tightening" -> gate silently stripped
```

**BLOCKED rationalizations:** "The eval gate is the enforcement point; the validator is secondary" / "grep of the eval helper's call sites found nothing" / "the validator has a safe default" / "the new dimension is rare; re-registration won't hit it" / "the eval check already fails closed, so the bypass is theoretical".

**Detection:** for any field promoted to a fail-closed authorization control at an eval surface, FIRST enumerate ALL validators that reference the control's field/type (the helper-following grep is precisely what cannot find the independent surfaces), THEN grep each re-registration / monotonic-tightening validator for that field name — absence is a finding.

Origin: see § Clause Origins — provenance relocated from the rule body,
§ Enforcement-Surface Parity. This paragraph previously carried its own copy of
that provenance, abridged — it omitted the "caught by an adversarial /redteam,
NOT by the existing multi-site grep" clause, which is the load-bearing half (the
multi-site grep this file's § Detection recommends is exactly the instrument that
MISSED it). The full text now lives once, verbatim, at § Clause Origins; the
abridged restatement is withdrawn rather than left to drift further from it.

## Redactor Contract — Extended

### 1. Minimum Subject-Id Length Floor (≥8 chars)

A substring-match redactor that scrubs every string containing a `subject_id` substring MUST reject ids shorter than 8 chars with a typed error citing the floor and the received length. Empty-id rejection alone is insufficient — single-char and 2-char ids substring-match catastrophically into benign role-knowledge strings.

```text
# DO — fail closed on a too-short id (typed error names floor + received length)
redact_subject_keyed(payload, subject_id="a")
→ Error: subject_id length 1 below MIN_SUBJECT_ID_CHARS=8 (over-redaction guard)

# DO NOT — empty-check only; 1–7-char ids over-redact benign strings
redact_subject_keyed(payload, subject_id="alice")
→ "malice aforethought" → "m[REDACTED] aforethought"   # role knowledge destroyed
```

Practical subject refs (sovereign_ref, role_id, agent_id, UUIDs, emails) are all ≥8 chars — the floor is the structural defense against the over-redaction class, which defeats the "successor inherits role knowledge" contract by scrubbing content the successor is entitled to.

### 2. Numbered-Sentinel Key Scrub (companion clause)

A subject-keyed redactor scrubbing object KEYS that match the subject id MUST scrub BOTH the key AND the value. Preserving the original matching key under a `"[REDACTED]"` value leaks the departed subject's identity as audit metadata — a downstream reader can enumerate which entries belonged to them.

```text
# DO — numbered sentinel preserves audit shape, scrubs identity
{"alice@example.com": "...", "bob@example.com": "..."} (subject = alice@example.com)
→ {"[REDACTED_KEY_1]": "[REDACTED]", "bob@example.com": "..."}
# count of scrubbed keys preserved via per-key counter; byte-level audit trail
# preserved via the original_hash return (hash-preserving redaction contract)

# DO NOT — preserve the matching key as "audit metadata"
→ {"alice@example.com": "[REDACTED]", ...}   # identity leaks as the key itself
```

The matching-key counter prevents map collapse across multiple matching keys; any residue predicate (`payload_mentions_subject`) MUST treat matching keys as residue, symmetric with the scrubber.

**Cross-SDK landing requirement:** when an equivalent subject-keyed redactor lands in a sibling SDK (Python, Ruby, Node), the min-length floor AND the numbered-sentinel key scrub MUST be part of the ORIGINAL landing — not a follow-up.

**Evidence:** the Rust SDK `eatp::redact_subject_keyed` shipped with only an empty-id check (PR #1123 commit `f2cd020e`); /redteam Round 1 flagged HIGH (1–7-char ids over-redact role knowledge) + MEDIUM (preserved matching key leaks predecessor identity). Same-shard fix (commit `6a332ef5`) added the `MIN_SUBJECT_ID_CHARS = 8` floor + regression test `redact_subject_keyed_short_subject_id_is_rejected` + the `[REDACTED_KEY_N]` sentinel + symmetric residue predicate.

## Kailash-Specific Security — Extended

- **DataFlow**: Access controls on models, validate at model level, never expose internal IDs
- **Nexus**: Authentication on protected routes, rate limiting, CORS configured
- **Kaizen**: Prompt injection protection, sensitive data filtering, output validation

## Structural surface enumeration — why the sweep is the backstop, not the control

Depth for `rules/security.md` § Enforcement-Surface Parity, reached via that
file's header pointer ("Depth for most sections below lives in
`.claude/guides/rule-extracts/security.md`").

NOTE ON PLACEMENT (loom#1422 AC-5, loom#1355). AC-5 asked § Enforcement-Surface
Parity to cross-reference the predicate IN THE RULE, so the clause points at
something structural rather than at human memory. That pointer is NOT in the rule
body, and the omission was deliberate and measured rather than an oversight.

THE ORIGINAL CONSTRAINT, as measured on 2026-07-26: the `rs` lane composed
`security.md` to 9545B against a granted per-rule ceiling of 9600B (itself an
exception under #1355, expiring 2026-10-31), leaving 55B. The shortest honest
form of the clause measured ~199B, which BLOCKED the lane. Raising the ceiling
was a co-owner decision, and displacing existing contract prose to make room
would have traded a live security contract for a cross-reference. So the depth
lives here, reachable from the rule's existing header pointer, at zero baseline
emission cost.

**THAT CONSTRAINT HAS LIFTED, and the numbers above are history — do not quote
them forward.** The #1355 per-rule grant was RETIRED on 2026-09-02 and no
per-rule exception is declared. The relief did not come from raising the ceiling,
which is the trigger this note originally named; it came from the rule SHRINKING
past it, which has the same effect on the decision. Measured on the retirement
tree: rs composes `security.md` to **8985B** against the **flat 9360B** ceiling,
leaving ~375B — comfortably more than the ~199B the clause needs.

So the stated precondition for restoring the one-line pointer to
§ Enforcement-Surface Parity is now SATISFIED IN SUBSTANCE. It was deliberately
NOT restored in the retirement change, whose mandate was removing a dead waiver:
adding normative prose to a `priority: 0` baseline rule is a separate decision
with its own emission cost and its own review, not a free rider on a cleanup.
Re-measure before acting on the figures above rather than trusting this
paragraph — that is the same instruction the retired stanza gave, for the same
reason.

### The clause asks for something a human does not reliably do

§ Enforcement-Surface Parity asks an author to find every independent validation
surface. Measured in this repo, that is not reliably achievable. The
case-sensitivity dimension had to land at ~10 protected-path sites across 4 hooks
and was missed — **by the orchestrator, while fixing a violation of this very
clause**. The Bash-lane half shipped and was declared complete; an adversarial
lens then found the Edit/Write lane fully bypassable: 9/9 canonical paths fenced,
10/10 case-variants passed. The variant set reached further than the Bash lane's,
covering the `journal/` and `.claude/team-memory/` subtrees.

That is the strongest available evidence that a rule asking a human to remember an
enumeration nobody produces is not sufficient on its own.

### The mechanism

Collapse the surfaces onto ONE shared function so a new dimension is one edit, then
add a test that ENUMERATES the surfaces and fails when a new one re-derives the
decision locally. The sweep becomes the backstop; the test is the control.

Worked reference:

- `.claude/hooks/lib/guard-path-scope.js` — the `PROTECTED_PATHS` registry. One row
  per protected path, per-row surface membership (`bash` / `layer3` / `direct` /
  `coordMode` / `postureGate`), every matcher BUILT from it. Membership is
  deliberately asymmetric because the surfaces genuinely differ.
- `tests/integration/multi-operator/protected-path-predicate-1422.test.js` — walks
  `.claude/hooks/**` and fails if any hook does its own protected-path matching.

### The enumeration test needs its own anti-vacuity control

A scanner that reports zero because it scanned nothing is the recurring instrument
failure in this corpus. The enumeration test therefore ships controls that run on
EVERY invocation, not once by hand: synthetic violation shapes that MUST flag,
legitimate non-decisions that MUST NOT, and a proof the scan reached production
text. Calibration is honest about reach — see loom#1455: it catches the plain shape
that real decay takes, not an author who wants to route around it.

### Where duplication is DELIBERATE, consolidation is BLOCKED

The discriminator is whether the copies are an accident or an independence property.
`CANONICAL_DENY_FLOOR` is hardcoded in `settings-deny-edit-guard.js`,
`settings-deny-drift-guard.js` and `.claude/bin/reconcile-settings-deny.mjs`
precisely so poisoning the mutable bin's `CANONICAL_STATE_DENY` cannot reduce the
enforced floor ("HARDCODED trust anchor (redteam F2)"). Consolidating those onto a
shared source would destroy the independence the triplication exists to provide;
`settings-deny-canon-parity.test.mjs` pinning them in lockstep is the correct
control there. An enumeration test MUST recognise that case structurally — the
#1422 test treats a permission-matcher string (`Tool(<path>)`) as a DECLARATION
rather than a path-matching decision — rather than carrying a per-file allowlist,
which is the shape that lets real fragmentation hide.

## Clause Origins — provenance relocated from the rule body

Relocated verbatim 2026-09-24 out of `.claude/rules/security.md`. Both are
line-initial `Origin:` paragraphs — the class `abridgeV6` already strips from the
Codex/Gemini baseline — so no consumer loses anything, while Claude Code stops
paying ~977 B of provenance on every session. The clause bodies, their `**Why:**`
lines, their `Depth:` pointers into `skills/18-security-patterns/**` and their
clause-scoped Trust-Posture Wiring `- **Origin:**` fields all stay in the rule.
Nothing else moved: the four `## Trust Posture Wiring` sections, the
`#### Accepted residual` H4 and the length-rationale paragraph were examined and
DELIBERATELY LEFT — see § Why the Wiring sections did not move, below.

### § Enforcement-Surface Parity

Origin: kailash-py #1456 → kailash-pact 0.14.3 (PR #1459). #1456 promoted `McpToolPolicy.clearance_required` to a fail-closed gate at `_check_clearance` (eval, Step 3.5) but left `_validate_monotonic_tightening` (re-registration) blind to it; a `secret`→None / `secret`→`public` re-registration was accepted as "tightening", silently stripping the gate (caught by an adversarial /redteam, NOT by the existing multi-site grep). Cross-SDK sibling: the Rust SDK binding (same shape).

### § Path Containment — Resolve And Normalize Before The Trust Decision

Origin: BUILD `SECURITY-PATH-CONTAINMENT-2026-07-16` — a COC eval-harness manifest-scanner used a LEXICAL `resolve()` only; a symlink at a lexically-contained path whose target escaped the boundary passed the string check and would have `execFileSync`'d out-of-tree code (fixed by a `realpathSync` re-check resolving BOTH candidate and root); cross-language sibling kailash-mcp #1833 (resolved-path spawn-allowlist + OS-aware separators + platform-gated suffix + Windows drive-relative).

## Why the Wiring sections did not move

The four `## Trust Posture Wiring — …` sections, the `#### Accepted residual`
H4 and the length-rationale paragraph were all candidates for this extraction and
were all LEFT IN THE RULE. The reason is measured, not stylistic, and is recorded
here so the next pass does not re-derive it.

**They carry counted enforcement tokens.** `check-descoping.mjs` censuses
`must_token`, `must_not_token`, `blocked_token`, `why_line` and `wiring:<field>`
over non-fence lines of each canon rule, and gates on a FALLING count against the
merge-base. Measured on the pre-edit tree: the four Wiring sections hold 31 `MUST`
and 3 `MUST NOT` occurrences; the `#### Accepted residual` H4 holds 3 `MUST`; the
length-rationale paragraph holds 2 `MUST` + 2 `MUST NOT`; the 2026-09-02 amendment
holds 4 `MUST`, 2 `MUST NOT` and 3 `BLOCKED`. Every one of those would DROP.

**And a drop into THIS file is a finding, not a free move.** The gate's constraint
6 was amended 2026-08-28: a moved line clears free only when it lands somewhere
that still LOADS. `.claude/rules/**` and `.claude/skills/**` do; `guides/**` is
read by following a pointer, so a counted line relocated here reports as
`descoping_to_uninjected` rather than as a verbatim move. Depth is uncounted, so
ordinary Rule-10 extraction of prose still costs nothing — which is exactly why
the two `Origin:` paragraphs above moved cleanly and the Wiring sections cannot.

**Four registry anchors additionally pin Wiring text into the rule.**
`phase2-deferrals.json` carries four rows whose `rule` is `.claude/rules/security.md`
and whose verbatim `quote` lives inside a Wiring block — `security.md#path-containment`,
`security.md#approver-identity-server-derived`, and the two `acknowledged_non_deferrals`
retirement rows `security.md#enforcement-surface-parity` and
`security.md#secure-default-new-feature`. `phase2-deferral-integrity.mjs` reconciles
registry ⇄ corpus in BOTH directions, so a quote that no longer appears in its rule
is a STALE entry and a hard fail. `check-clause-coverage.mjs` separately treats a
rule with no `Trust Posture Wiring` heading as NOT WIRED and skips it, which would
silently drop this rule out of clause-coverage rather than fail loudly.

Moving those sections is therefore a multi-file change spanning
`phase2-deferrals.json` and `descoping-exceptions.json`, not a two-file extraction.

**Superseded by `8e5bba6e3` (recorded 2026-09-27).** The Wiring sections did move, into
`.claude/skills/32-trust-posture/wiring/security.md`. `lib/rule-governance-surface.mjs` reads
each rule together with its wiring sibling, and the governance validators, `phase2-deferral-integrity.mjs`
among them, read through it. So the four anchors above now resolve through the sibling. The
analysis above is kept as the reasoning of its date.

---

## Accepted residual — the three-phase TOCTOU (extracted from rules/security.md 2026-10-01)

#### Accepted residual — the three-phase TOCTOU is OPEN, not deferred

Recorded at H4 deliberately: the `**Why:**` above already carries the whole normative contract for
every consumer (resolve both sides; do NOT over-claim the resolve as TOCTOU-complete). What follows
is loom-internal accounting of WHICH half is open and why — the same class `abridgeV6` already
strips for `Origin:` and Trust Posture Wiring, and it is therefore absent from the abridged
Codex/Gemini baseline by design, not by budget.

**MEASURED on this tree, not inferred.** A TWO-phase swap — repoint the name between the check and
the open — is REFUSED. A THREE-phase swap is not: swap, revert, re-swap, and the sink returns
out-of-band content as its text. The `lstat` and the `open` are separate syscalls over a name the
attacker still controls in between, so the third phase restores the honest target for exactly the
window the check looks at.

**What IS closed.** The LEXICAL-bypass class, completely, and that is what the resolve was for: a
symlink at a lexically-contained path whose target escapes the boundary no longer passes, because
both candidate and root go through the same resolver. `O_NOFOLLOW` at the sink additionally closes
the one-level symlink swap, which is why the two-phase attack is refused.

**What is NOT closed, and why.** Check-to-use, for the WHOLE path walk. The root cause is a platform
limit, not an oversight in the check: Node exposes no `openat` / fd-relative resolution, so "the path
I checked" cannot be atomically BOUND to "the fd I opened". `O_NOFOLLOW` binds the final component;
nothing available here binds the ancestors. Closing it needs fd-relative resolution AT the sink — a
dir-fd handle held across the walk, via a native binding or a runtime that exposes `openat`.

**Status: ACCEPTED, not deferred.** No Phase-2 row, no expiry, and none is owed. A dated debt here
would be booked against a RUNTIME CAPABILITY nobody in this repo can schedule, which is the
permanent-by-default shape `hook-output-discipline.md` MUST-5(b) forbids and `trust-posture.md`
§ "Every Phase-2 Deferral Carries A DATED Declaration" exists to prevent. Accepted by the co-owner —
the named human in a standing role `completion-criterion.md` MUST-6 requires — on the session that
measured it. The revisit TRIGGER is fd-relative resolution becoming available at the sink, an
observable event; the deviation from MUST-6's calendar backstop is recorded HERE rather than papered
over with a date nobody chose. The acceptance is a BET, logged and owned, never a claim that the
residual is harmless: an attacker who can win a three-phase race against a path this repo reads
still gets out-of-band content read as in-tree content.
