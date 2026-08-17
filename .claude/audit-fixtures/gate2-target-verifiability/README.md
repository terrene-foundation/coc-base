# gate2-target-verifiability — loom#1745

Regression lock for the Gate-2 **target-verifiability** gate in
`.claude/bin/sync-gate2-worktree.mjs`.

## What it guards

Gate-2 asserts a distribution contract — "this tree landed, CI-gated" — that it never
checked the TARGET could honour. `commitPushPrMaybeMerge` opened a PR into any resolvable
target and `gatedMergeHint` told the operator to "merge after CI green", on repos where no
check will ever report. The operator's only options were merge-blind or hold.

The gate probes `repos/<owner>/<repo>/branches/main/protection` before any commit/push side
effect, classifies the target `verifiable` / `unverifiable` / `unknown`, SURFACES the verdict
loudly, records it in the receipt (`target_verifiability`), and — on the `--merge` path only —
REFUSES (exit 6) unless `--accept-unverified-target` is passed.

## Bipolar by construction

Every verdict case is paired. Pole A payloads MUST classify `verifiable` (gate silent); pole
B/C payloads MUST NOT (gate fires). A classifier hardwired to either pole reds on the other,
so nothing here is "shown only to pass".

The sharpest pair is `null-vs-absent-discriminated`. GitHub omits `required_status_checks`
entirely for one repo state and returns it `null` for another. `p.required_status_checks?.…`
collapses both to one falsy value; `hasKey` keeps them apart and gives each its own reason.

Two cases are SOURCE PINS. A perfect classifier that nothing calls is exactly the un-gated
shape this fixture exists to prevent, and it prints an identical green
(`instrument-discipline.md` MUST-1).

## Measured mutations (2026-08-16, `GATE2_DRIVER=<mutant>`)

Unmutated control: **19/19 PASS, exit 0**.

| # | Mutation | Result |
|---|----------|--------|
| M1 | `classifyTargetVerifiability` returns `verifiable` unconditionally | exit 1, 5/19 — reds all three poles + notice + receipt cases |
| M2 | `hasKey(p,"required_status_checks")` → `p?.required_status_checks` | exit 1, 18/19 — reds `null-vs-absent-discriminated` ONLY |
| M3 | `--merge` refusal predicate → `if (false)` | exit 1, 18/19 — reds `wiring/auto-merge-refuses-on-non-verifiable` ONLY |
| M4 | errored probe returns `status:"not-found"` (reads an auth failure as "unprotected") | exit 1, 18/19 — reds `probe/auth-failure-maps-to-error` ONLY |
| M5 | probe call replaced by a hardcoded `verifiable` verdict in `commitPushPrMaybeMerge` | exit 1, 18/19 — reds `wiring/probe-is-called-before-the-commit` ONLY |

M2–M5 each red exactly one case, which is what makes those cases readable as evidence about
their own proposition rather than as generic smoke.

## Running

```bash
node .claude/audit-fixtures/gate2-target-verifiability/run.mjs        # 19/19, exit 0
node .claude/bin/run-audit-fixtures.mjs --only gate2-target-verifiability
```

No network: the protection probe takes an injectable runner, so every `gh` outcome
(404 / auth failure / unparseable body) is exercised without a live repo.
