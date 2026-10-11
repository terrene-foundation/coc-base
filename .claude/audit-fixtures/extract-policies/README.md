# extract-policies audit fixtures

Fixture set for `.claude/codex-mcp-guard/extract-policies.mjs` — the
validator-13 hook-predicate extractor that emits `policies.json`
(consumed by `server.js` to decide which CC hooks gate each Codex
tool). These fixtures lock the **FF-AC6-1** scope-restriction
predicates added when Codex `apply_patch` (file-edit) gating landed.

## Predicates under test (27)

| ID  | Predicate                             | Asserts                                                                         |
| --- | ------------------------------------- | ------------------------------------------------------------------------------- |
| 01  | Bash matcher fan-out                  | `Bash` → shell + unified_exec, **never** apply_patch                            |
| 02  | edit matcher + `@coc-codex-edit-gate` | marked stateless gate → apply_patch (AC#1)                                      |
| 03  | edit matcher, **no** marker           | unmarked coordination guard → **excluded** from apply_patch (AC#2)              |
| 04  | multi-tool matcher resolution         | `Edit\|Write\|MultiEdit\|NotebookEdit` resolves — **DF-AC6-1 regression guard** |
| 05  | dual registration + marker            | Bash + edit + marker → all three tools; marker gates ONLY the apply_patch half  |
| 06  | settings.json **absent**              | RED — typed refusal `matcher-map-settings-missing`                              |
| 07  | settings.json **unparseable**         | RED — typed refusal `matcher-map-settings-unparseable`                          |
| 08  | settings.json parses, **zero** entries | RED — typed refusal `matcher-map-empty`                                        |
| 09  | settings.json is a **symlink**        | RED — typed refusal `matcher-map-settings-unreadable` (O_NOFOLLOW → ELOOP)      |
| 10  | well-formed settings.json             | GREEN — still builds a **populated** table; fence spares the happy path         |
| 11  | explicit `requireMatcherMap: false`   | GREEN — the narrow opt-out validator-13 depends on still returns cleanly        |
| 12  | single-hook dispatcher group          | GREEN — the live consolidated shape: registry groups injected, dispatcher consumed |
| 13  | dispatcher + co-resident hook, ONE group | GREEN pole — registry groups STILL injected AND the co-resident hook keeps its own policy |
| 14  | two dispatcher commands, one group    | registry groups injected ONCE — one `onIncomplete` declaration, not two         |
| 15  | mixed group + **absent** registry     | RED pole — typed refusal `matcher-map-registry-unreadable`                      |
| 16  | edit guard, undeclared exclusions     | RED — typed refusal `policy-coverage-gap` naming the guard (2026-10-09 ruling)  |
| 17  | dual-registered marker-less (PARTIAL) | RED — `policy-coverage-gap` on ZERO **apply_patch** entries, shell coverage kept |
| 18  | same partial shape, declared row      | GREEN — silent; shell coverage retained, apply_patch omission recorded          |
| 19  | exclusions file not valid JSON        | RED — typed `policy-exclusions-malformed` (row validation, R3-security F1)      |
| 20  | 19-char `reason`                      | RED — typed `policy-exclusions-malformed` (length floor)                        |
| 21  | empty `compensating_control`          | RED — typed `policy-exclusions-malformed`                                       |
| 22  | exactly-20-char `reason`              | GREEN boundary — row accepted; declared edit-only guard stays out of apply_patch |
| 23  | whitespace-only `reason` (27 pre-trim)| RED — trim pole for the length floor (silent-direction residual)                |
| 24  | whitespace-only `compensating_control`| RED — trim pole for the empty-control arm                                       |
| 25  | empty `hook` in a row                 | RED — pole for the hook arm of the row conjunct                                 |
| 26  | exclusions file with NO `exclusions` key | RED — typed `policy-exclusions-malformed` (non-array file)                   |
| 27  | `exclusions: null`                    | RED — non-array pole for the same `Array.isArray` guard                         |

Cases 06–11 are the **bipolar pole pair** for the matcher-map fail-closed
fence (loom#S73-M5). The RED poles assert the **refusal identity** — the
typed `HookMatcherMapError` and its `code` — never merely that something
threw, so an unrelated `TypeError` cannot score as the fence firing.
Cases 12–15 are the pole pair for the dispatcher-expansion class (below),
with 13/15 the GREEN/RED poles run by this same runner. Cases 16–18 lock the
**policy-coverage refusal**: an edit-matcher hook whose predicate can refuse
must either reach the Codex `apply_patch` lane or be declared in
`codex-mcp-guard/policy-exclusions.json`; 17/18 are the RED/GREEN poles for
the PARTIAL shape (a Bash+edit dual registration whose apply_patch entry is
marker-gated away), which the union-over-all-tools check could not see.
The synthetic roots therefore declare their marker-less edit-capable fixtures
— the declaration is the accepted-omission record, not a weakening.
Cases 19–27 lock the **exclusions-file row validation** behind that
declaration (`readPolicyExclusions`): every refusal arm has a RED pole and
the exactly-20-char row is the GREEN boundary. Each of 19–27 asserts the
typed `code`, which discriminates even when a mutant falls through to the
NEXT refusal class (an accepted bad row leaves the guard undeclared, so the
run then throws `policy-coverage-gap` — a different typed code).

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
- **Cases 06–09 guard the fail-closed fence**: `buildHookMatcherMap`
  previously degraded to an EMPTY `Map` when settings.json was absent,
  unreadable, or unparseable. That map is the sole input to the
  file-level `policies` table, so the degradation propagated a
  silently-empty policy table through `wireMcpPolicies()` into the
  `policies.json` written for every distribution target — and an empty
  table is indistinguishable from a populated one at every surface in
  between. Case 09 is the sharpest: `safeReadFileSync` opens
  `O_NOFOLLOW` specifically so a swapped symlink raises `ELOOP`, and the
  former `catch { return map; }` swallowed that ELOOP into an empty
  table, defeating the guard it was paired with.

## Dispatcher expansion — the multi-hook collapse (P12–P15)

`extract-policies.mjs::expandDispatcherEntries` recognizes a settings group
as the CONSOLIDATED dispatcher registration — its hooks live behind
`<settings dir>/hooks/dispatch-registry.json` — when a command in the group
invokes `dispatch.js <Event>`. The pre-fix gate required that command to be
the group's SOLE hook (`hs.length === 1`): a group that ALSO carried a
directly-registered hook fell to the pass-through arm, injected zero
registry groups, and the extraction still exited 0 — collapsing the whole
registry cohort out of the Codex policy table (shell/unified_exec down to
the non-registry entries, apply_patch to zero) with no refusal anywhere.
Latent, not active, while every live dispatch group holds exactly one hook;
the `matcher-map-empty` fence cannot see it, because a SHORT table is not an
empty one.

- **P12** is the UNCHANGED control — the live single-hook shape; it must
  stay green before and after the fix.
- **P13** is the GREEN pole — dispatcher + co-resident hook in ONE group:
  the registry groups ARE injected and the co-resident hook keeps its own
  policy (a residual group carrying the original matcher).
- **P14** locks the dedupe contract — multiple dispatcher commands in one
  group inject the registry groups ONCE; `onIncomplete` is the observable,
  since `buildHookMatcherMap` appends one declaration per registered
  occurrence, so a double injection would list `["deny","deny"]`.
- **P15** is the RED pole — the same mixed shape with an ABSENT registry
  MUST refuse with the typed `matcher-map-registry-unreadable` identity
  rather than pass the collapsed table through silently.

Both poles failed against the pre-fix gate when this pair was added (12 of
the then-15 cases passed; the runner has since grown to 27 cases), which is
the pair this set exists to keep closed.

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
