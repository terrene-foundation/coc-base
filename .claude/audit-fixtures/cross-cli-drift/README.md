# cli-drift-audit fixtures

Acceptance fixtures for `tools/cli-drift-audit.mjs`. Each fixture is a
mini rules tree containing one or more rule files with optional
per-CLI overlays.

## Layout

```
<fixture-name>/
  <rule>.md             ← global / CC emission body
  <rule>.codex.md       ← (optional) Codex emission body
  <rule>.gemini.md      ← (optional) Gemini emission body
  expected.json         ← expected drift-audit summary fields
```

A rule file missing a per-CLI variant inherits the global file for
that CLI. Each rule MUST carry `priority:` and `scope:` frontmatter
per `rules/rule-authoring.md` Rule 7 — the audit treats every file
named `<a>.md` (matching `/^[a-z][a-z0-9-]*\.md$/`) as a CRIT-class
candidate when run with `--fixtures`.

## Running

```bash
node tools/cli-drift-audit.mjs --fixtures .claude/audit-fixtures/cross-cli-drift/fixture-clean
node tools/cli-drift-audit.mjs --fixtures .claude/audit-fixtures/cross-cli-drift/fixture-neutral-body-drift
```

Exit code 0 on `summary.critical == 0`; exit code 1 on any CRITICAL.

## Fixtures

| Fixture                              | Expected           | Purpose                                                                                                                         |
| ------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `fixture-clean`                      | 0 CRITICAL, 0 WARN | Three CLIs share byte-identical neutral-body; delegation syntax differs in examples slot (scrubbed)                             |
| `fixture-neutral-body-drift`         | 1 CRITICAL         | Codex variant smuggles CLI-specific prose into `slot:neutral-body` — the failure mode `rules/cross-cli-parity.md` MUST-1 blocks |
| `fixture-frontmatter-priority-drift` | 1 CRITICAL         | Gemini variant changes `priority: 0` → `priority: 10` — silent rule-tier downgrade                                              |
| `fixture-examples-only-drift`        | 0 CRITICAL, 1 WARN | Examples slot differs across CLIs (expected delegation-syntax divergence) — soft-warns per spec                                 |
