---
name: oidc-offline-crypto-test-vectors
description: "Deterministic offline asymmetric-crypto test vectors (JWKS/JWT RS256/ES256/PS256) with zero key-gen dev-dependency, plus the alg-confusion fail-closed verification defense. Use when testing sign/verify, seal/unseal, or JWKS verification."
priority: HIGH
tags: [testing, security, oidc, jwt, jwks, crypto, test-vectors, alg-confusion]
paths:
  - "tests/**"
  - "**/*test*"
  - "**/*spec*"
---

# OIDC / Asymmetric-Crypto Offline Test Vectors

To test asymmetric-crypto verification — JWKS / JWT (`RS256` / `ES256` / `PS256`), sign/verify, seal/unseal — WITHOUT adding a key-generation dev-dependency and WITHOUT any network call, generate the keypair + JWK + signed token ONCE offline, COMMIT the DER/JWK material as test constants, then mint tokens in-test from those fixed constants. The result is zero new dev-dep, fully deterministic, and reproducible across every CI run and every contributor's machine.

This is the asymmetric-crypto sibling of `cross-sdk-inspection.md` Rule 4 (pin byte vectors from the canonical source): the same "generate-once-offline, then consume-committed-constants" discipline applied to keypairs + signed tokens instead of hash/fingerprint vectors.

## The pattern — generate once offline, consume committed constants

The discipline has two halves, and only the FIRST is language-specific:

1. **Generation (one-time, out-of-band — `python cryptography` is illustrative tooling).** Run a throwaway script ONCE — offline, never in the test run, never wired as a dev-dependency — to produce the keypair, its JWK representation, and a signed token. The reference tooling is a short `python cryptography` script because it is ubiquitous and dependency-light; this step is **python-tooling-illustrative even for rs / rb consumers** — any offline keypair generator (a `python cryptography` script, an `openssl` invocation, a one-off Rust/Ruby program) produces the same committed material. The generator never ships in the consumer's dependency graph.

2. **Consumption (every test run — LANGUAGE-NEUTRAL).** Commit the generated DER / JWK material + the signed token as fixed test constants. In-test, mint tokens from those committed constants and feed them to the verifier under test. No keypair is generated at test time; no network is touched. This half is identical in Python, Rust, Ruby, or any consumer — the test reads bytes it already owns.

```text
# DO — generate offline once; commit the material; consume committed consts in-test
# (one-time, offline) python cryptography script → RSA_A_DER, RSA_B_JWK, EC_P256_DER, SIGNED_TOKEN
# (committed)         test fixtures carry the DER/JWK consts + the signed token verbatim
# (every test run)    mint token from RSA_A_DER const → feed to verifier → assert verify/reject
#                     # zero new dev-dep, zero network, byte-deterministic

# DO NOT — generate a fresh keypair inside the test run
# adds a key-gen dev-dependency, is non-deterministic across runs/machines,
# and couples the test to the generator's version + entropy source
```

**Why:** A test that generates its keypair at run time pulls a key-generation library into the consumer's dependency graph, is non-deterministic (different bytes every run), and cannot be reproduced byte-for-byte by a reviewer. Committing the generated material once moves all non-determinism out of band: the test consumes fixed bytes it already owns, so the same vector verifies identically on every machine and every CI run. The generation step's language does not matter — only the committed bytes do.

## Secondary — alg-confusion fail-closed verification defense (LANGUAGE-NEUTRAL)

When the verifier under test accepts asymmetric tokens, the test surface MUST also cover the **alg-confusion** attack class — `RS256` → `HS256` substitution, and `alg: none`. The fail-closed defense is: pin the verification algorithm from the IdP discovery document (an asymmetric-only allow-list), NEVER trust the token header's `alg` field, and dispatch fail-closed on any non-allowlisted `alg`.

```text
# DO — alg pinned from the IdP discovery doc; fail-closed on non-allowlisted alg
allowed = asymmetric_algs_from(idp_discovery_document)   # e.g. {RS256, ES256, PS256}
if token.header.alg not in allowed: REJECT               # closed: alg:none / HS256 rejected
verify(token, using=allowed_alg, key=jwks_key)           # never the token-header alg

# DO NOT — trust the token header's alg
verify(token, using=token.header.alg, ...)               # RS256→HS256 / alg:none bypass
```

**Why:** A verifier that reads the algorithm from the token header lets an attacker downgrade an asymmetric (`RS256`) verification to a symmetric (`HS256`) one — signing the forged token with the PUBLIC key as the HMAC secret — or to `alg: none` (no signature at all). Pinning the algorithm from the IdP discovery document's asymmetric-only allow-list and dispatching fail-closed on any non-allowlisted `alg` is the structural defense; it is the SOC2-CC6 auth-gap class that surfaces when an HS256-only verifier advertises `RS256` / `jwks_uri`. This defense is language-neutral — the allow-list-from-discovery + fail-closed dispatch holds identically in every consumer.

## Cross-references

- **`cross-sdk-inspection.md` Rule 4** — pin byte vectors from the canonical source; this skill is the asymmetric-keypair sibling of that fingerprint-vector discipline.
- **`skills/18-security-patterns/`** — the security half (alg-confusion fail-closed defense) is cross-referenced from there.

Origin: OIDC issue #1438 / PR #1443 (origin: build, rs) — RS256+ES256 JWKS verification tests needed deterministic asymmetric vectors with no new dev-dependency; the offline-generate-then-commit-consts approach delivered RSA_A / RSA_B + EC P-256 vectors used by the JWKS happy-path / wrong-key-rejected tests. The alg-confusion fail-closed defense closed the originating SOC2-CC6 auth gap (an HS256-only verifier advertising RS256 / jwks_uri). Genericized at Gate-1 GLOBAL placement: the `python cryptography` generation step is noted as python-tooling-illustrative; the consume-committed-consts principle + the alg-confusion defense are language-neutral.
