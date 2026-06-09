# extract-policies audit fixtures

Fixture set for `.claude/codex-mcp-guard/extract-policies.mjs` — the
validator-13 hook-predicate extractor that emits `policies.json`
(consumed by `server.js` to decide which CC hooks gate each Codex
tool). These fixtures lock the **FF-AC6-1** scope-restriction
predicates added when Codex `apply_patch` (file-edit) gating landed.

## Predicates under test (5)

| ID  | Predicate                             | Asserts                                                                         |
| --- | ------------------------------------- | ------------------------------------------------------------------------------- |
| 01  | Bash matcher fan-out                  | `Bash` → shell + unified_exec, **never** apply_patch                            |
| 02  | edit matcher + `@coc-codex-edit-gate` | marked stateless gate → apply_patch (AC#1)                                      |
| 03  | edit matcher, **no** marker           | unmarked coordination guard → **excluded** from apply_patch (AC#2)              |
| 04  | multi-tool matcher resolution         | `Edit\|Write\|MultiEdit\|NotebookEdit` resolves — **DF-AC6-1 regression guard** |
| 05  | dual registration + marker            | Bash + edit + marker → all three tools; marker gates ONLY the apply_patch half  |

## Why these predicates matter

- **The marker (`@coc-codex-edit-gate`) is the consumer-available
  selectivity signal** (FF-AC6-1 AC#3). It lives in the synced hook
  source — the projection of sync-manifest's `mcp-guard` lane into the
  hook itself, because `sync-manifest.yaml` is NOT synced to consumers
  where the extractor regenerates `policies.json`. Case 02/03 are the
  regression lock that keeps the stateless-trust-gate ⟺ coordination-
  guard split intact.
- **Case 04 guards the DF-AC6-1 root cause**: the extractor previously
  keyed `CC_TO_CODEX_TOOLS` by the WHOLE matcher string, so the real
  edit matcher `Edit|Write|MultiEdit|NotebookEdit` was not a literal
  key and the entire edit lane silently dropped. If the per-tool
  splitter (`matcherToCodexTools`) regresses, apply_patch goes empty
  and case 04 fails.

## Invocation

```bash
node .claude/audit-fixtures/extract-policies/run.mjs
```

Exit 0 = all cases pass; 1 = at least one regression.

## Fixture layout: inline-runner (per `cc-artifacts.md` Rule 9)

This set uses the **inline-runner** variant (synthetic hooks +
settings.json materialized in a temp dir by `run.mjs`, asserted against
the real `extractPolicies()` export) rather than sidecar input/expected
pairs. Selected because the predicate under test is a _function of two
inputs_ (hook source + settings.json matcher), which a single static
input file cannot express — the runner composes both and probes the
output structurally (set membership of `policies[tool]`, per
`probe-driven-verification.md` MUST-3). Sibling precedent:
`.claude/audit-fixtures/codex-dispatcher/run.mjs`.
