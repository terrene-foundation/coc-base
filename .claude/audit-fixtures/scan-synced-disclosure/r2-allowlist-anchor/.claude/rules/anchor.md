# R2 allowlist-anchor fixture (MUST flag, exit 1)

Locks must-fix #2 (issue #263 Round-2): the Foundation registry-org /
`<sdk>-enterprise` allowlist entries are anchored with a trailing non-word
boundary so the allowlist matches ONLY the exact org. A typosquat that merely
PREFIXES an allowlisted org used to be SUPPRESSED (silent leak).

All tokens SYNTHETIC.

Typosquat of the Foundation registry org — MUST flag (no longer swallowed):
terrenefoundation-evil/loom is a typosquat.
gh api repos/terrenefoundation-evil/kailash-py/actions

Typosquat of an SDK enterprise-tier doc compound — MUST flag:
nexus-enterprise-evil/loom is a synthetic typosquat.

The EXACT Foundation org + EXACT public SDK compound MUST stay clean (NOT in
this fixture's expected findings — they are allowlisted):
terrene-foundation/loom, terrenefoundation,
nexus-enterprise-features, dataflow-enterprise-migrations.
