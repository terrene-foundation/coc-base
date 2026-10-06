# Credential Decode Helpers — depth

Depth for `rules/security.md` § "Credential Decode Helpers". The rule carries the two MUST
clauses; this file carries the worked DO/DO-NOT code, the BLOCKED corpus, and the origin.

Connection strings carry credentials URL-encoded. Every decode site MUST route through ONE shared
helper module — a call-site `unquote(parsed.password)` is BLOCKED.

## 1. Null-Byte Rejection At Every Credential Decode Site (MUST)

Every `urlparse(connection_string)` user/password extraction MUST route through a single shared
helper that rejects null bytes AFTER percent-decoding.

```python
# DO — route through the shared helper
from kailash.utils.url_credentials import decode_userinfo_or_raise
parsed = urlparse(connection_string)
user, password = decode_userinfo_or_raise(parsed)  # raises on \x00 after unquote

# DO NOT — hand-rolled at the call site
from urllib.parse import unquote
user = unquote(parsed.username or "")
password = unquote(parsed.password or "")  # no null-byte check
```

**BLOCKED rationalizations:** "The existing site already has the check" / "This is a new dialect,
the rule doesn't apply yet" / "We'll consolidate later" / "The URL comes from a trusted config
file, null bytes can't happen".

**Why:** A crafted `mysql://user:%00bypass@host/db` truncates at the null byte to an EMPTY password
on the MySQL C client — authentication then succeeds against a credential the operator never set.
The check must run after percent-decoding, because before it the byte is the literal text `%00`.

## 2. Pre-Encoder Consolidation (MUST)

Password pre-encoding helpers (`quote_plus` of `#$@?` etc.) MUST live in the SAME shared helper
module as the decode path; per-adapter copies are BLOCKED.

```python
# DO — single helper module owns both halves
from kailash.utils.url_credentials import (
    preencode_password_special_chars, decode_userinfo_or_raise,
)
url = preencode_password_special_chars(raw_url)
user, password = decode_userinfo_or_raise(urlparse(url))

# DO NOT — inline pre-encode in each adapter
pwd = pwd.replace("@", "%40").replace(":", "%3A")  # drifts from decode path
```

**Why:** Encode and decode are dual halves of ONE contract. Splitting them across modules
guarantees drift — the encoder learns a new special character the decoder never hears about, and
the mismatch surfaces as an authentication failure whose cause is two files away.

Origin: a BUILD-repo upstream-fixes session (2026-04-12).
