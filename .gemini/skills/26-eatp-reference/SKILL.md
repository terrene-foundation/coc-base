---
name: eatp-reference
description: "EATP SDK reference — TrustPlane, BudgetTracker, PostureStore, security, stores, enterprise. Use for implementing trust code (not concepts — use co-reference)."
tools:
  - Read
  - Glob
  - Grep
---

# EATP SDK Implementation Reference

Implementation reference for the EATP trust module in the Kailash SDK. For EATP spec/concepts (5 elements, verification gradient, trust postures), see [co-reference/eatp-spec.md](../co-reference/eatp-spec.md).

## TrustPlane Reference Implementation

Production-grade Python library implementing the full EATP trust chain.

- **3 store backends**: SQLite (default), Filesystem, PostgreSQL
- **Key managers**: LocalFileKeyManager (Ed25519), AWS KMS (ECDSA P-256), Azure Key Vault, HashiCorp Vault
- **11 hardened security patterns** validated through 14 rounds of red teaming
- **22-class exception hierarchy**, all tracing to `TrustPlaneError`
- **1473 tests**, zero CRITICAL/HIGH findings

### Entry Points

- **CLI**: `attest` command (Click-based)
- **MCP Server**: `trustplane-mcp` via FastMCP
- **Python API**: `from kailash.trust.plane.project import TrustProject`

### Enterprise Features

RBAC (4 roles), OIDC (JWKS auto-discovery), SIEM (CEF/OCSF/TLS syslog), Dashboard (bearer token auth), Archive (ZIP + SHA-256), Shadow mode (non-blocking evaluation)

## Implementation Reference (load on demand)

- **[eatp-sdk-quickstart.md](eatp-sdk-quickstart.md)** — Getting started, 4-operation lifecycle, store selection
- **[eatp-sdk-api-reference.md](eatp-sdk-api-reference.md)** — Complete API surface, module reference, type signatures
- **[eatp-sdk-patterns.md](eatp-sdk-patterns.md)** — Implementation patterns, critical gotchas, architecture
- **[eatp-sdk-reasoning-traces.md](eatp-sdk-reasoning-traces.md)** — Reasoning trace extension, confidentiality, knowledge bridge
- **[eatp-budget-tracking.md](eatp-budget-tracking.md)** — BudgetTracker API, SQLiteBudgetStore, integer microdollars, threshold callbacks
- **[eatp-posture-stores.md](eatp-posture-stores.md)** — PostureStore protocol, SQLitePostureStore, PostureEvidence
- **[eatp-security-patterns.md](eatp-security-patterns.md)** — Red team security patterns: lock ordering, integer arithmetic, symlink rejection
- **[eatp-store-backends.md](eatp-store-backends.md)** — Adding new TrustPlaneStore backends (6-requirement security contract)
- **[eatp-trust-plane-security.md](eatp-trust-plane-security.md)** — 11 hardened security patterns (TrustPlane-specific)
- **[eatp-trust-plane-enterprise.md](eatp-trust-plane-enterprise.md)** — RBAC, OIDC, SIEM, Dashboard, Archive, Shadow mode, Cloud KMS
