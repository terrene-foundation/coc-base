# R2 allowlist-anchor fixture (MUST flag, exit 1)

Locks must-fix #2 (issue #263 Round-2): the own-org / `<sdk>-enterprise`
allowlist entries are now anchored with a trailing non-word boundary so
the allowlist matches ONLY the exact own org. A typosquat that merely
PREFIXES the own org used to be SUPPRESSED (silent leak).

All tokens SYNTHETIC.

Typosquat of the own host org — MUST flag (no longer swallowed):
esperie-enterprise-evil/loom is a typosquat.
gh api repos/esperie-enterprise-evil/kailash-py/actions

Typosquat of an SDK enterprise-tier doc compound — MUST flag:
nexus-enterprise-evil/loom is a synthetic typosquat.

The EXACT own org + EXACT public SDK compound MUST stay clean (NOT in
this fixture's expected findings — they are allowlisted):
esperie-enterprise/loom, esperie-enterprise,
nexus-enterprise-features, dataflow-enterprise-migrations.
