# Audit Fixtures — allowlist-paths-coverage (#443)

Structural probes (per `rules/probe-driven-verification.md` MUST-3 — set-membership

- equality on pure-function outputs + an end-to-end check over synthetic rule
  files) for `validate-emit.mjs` check 16, `allowlist-paths-coverage`.

The check enforces the invariant `self-referential-codify.md` Rule 2 states in
prose: **`paths:` frontmatter is the load-trigger SUPERSET; the named-file
allowlist is the firing-scope SUBSET.** Every allowlist file MUST be covered by
≥1 `paths:` glob — else editing that file does NOT load the rule, so the Rule-1
multi-agent-redteam gate silently does not fire (the #440 `.claude/codex-mcp-guard/**`
gap class). This check makes the prose invariant structural and BLOCKS `/sync`
on any uncovered allowlist entry.

These fixtures are NOT semantic; they verify the validator's mechanical behavior,
one fixture per scope-restriction predicate per `rules/cc-artifacts.md` Rule 9 +
`rules/hook-output-discipline.md` MUST-4. Each `check`-level fixture exercises
BOTH a COVERED (pass) AND an UNCOVERED (fail) entry.

## Run

```bash
node .claude/audit-fixtures/allowlist-paths-coverage/run.mjs
```

Exit 0 = all fixtures pass. Exit 1 = ≥1 fixture failed.

## Fixture catalog

| #   | Predicate                                         | What it pins                                                                                           |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | `braceExpandAllowlist` — `{a,b,c}` expansion      | `rules/{trust-posture,cc-artifacts}.md` → 2 entries; no-brace path → identity                          |
| 2   | `stripParentheticals` — depth-aware paren strip   | per-entry `(added per …)` prose refs (incl. nested) dropped; real entries kept                         |
| 3   | `allowlistGlobCovers` — exact + `/**` (COV + UNC) | exact-path + `/**`-prefix COVER; root-level file + sibling subtree UNCOVERED                           |
| 4   | `parseSelfRefAllowlist` — category bullets only   | parses Commands/Data/Audit bullets; EXCLUDES `Detection`/`Extends` Trust-Posture-Wiring + xref bullets |
| 5   | `parsePathsFrontmatter` — `paths:` list           | extracts the glob list; no-frontmatter → `null`                                                        |
| 6   | check 16 e2e — COVERED entry → PASS               | every allowlist entry under a `paths:` glob → 0 blocking                                               |
| 7   | check 16 e2e — UNCOVERED entry → FAIL             | a root-level data file under no glob → FAIL (the #443/#440 gap class)                                  |
| 8   | check 16 e2e — glob entry covered by parent `/**` | `validate-*.mjs` / `skills/sweep/**` covered by `bin/**` / `skills/**` → not mis-flagged               |
| 9   | check 16 e2e — absent rule → SKIP                 | rule unreadable/absent (consumer tree) → single SKIP, non-blocking                                     |
| 10  | `allowlistGlobCovers` — brace-set glob (COV + UNC) | `{commands,rules,bin}/**` covers an entry under ANY member; outside-all-members UNCOVERED; plain `/**` regression held |
| 11  | check 16 e2e — brace-set `paths:` frontmatter     | a `paths:` written as `.claude/{commands,bin}/**` covers allowlist entries across the brace members → 0 blocking (the future-frontmatter-collapse scenario #443 R1 flagged) |

Note: the real-corpus clean-pass (`self-referential-codify.md`'s live allowlist
fully covered after the #443 gap-closure that added the `operators.roster.schema.json`

- `disclosure-tenant-denylist.json` exact-path globs) is exercised by
  `node .claude/bin/validate-emit.mjs --check allowlist-paths-coverage`.
