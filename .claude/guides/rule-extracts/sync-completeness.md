# sync-completeness.md — Rule Extract

Long-form Origin prose, full incident detail, and example JSON dialects for `.claude/rules/sync-completeness.md`. Extracted per `rules/rule-authoring.md` MUST NOT "Rules longer than 200 lines" to keep the canonical rule lean while preserving institutional evidence.

## Rule 1 — full incident detail (2026-05-06)

Hand-typed counts decay silently. The 2026-05-06 session-notes claim "all 4 USE templates at 2.19.0 and pushed" was wrong on TWO counts:

1. There are FIVE templates after prism's retirement (claude-py + unified py + claude-rs + unified rs + claude-rb), AND
2. `/sync rb` was not invoked in the 2.19.0 cycle so claude-rb landed at 2.18.0.

Both errors trace to the same root cause: the count was carried from prior session memory, not derived from the manifest at sync time. The manifest is the single source of truth precisely so this mode-of-failure is mechanical to prevent — `yq -r '.sync_targets[].templates[].repo'` is the structural defense; "I remember which templates need the sync" is not.

Origin: 2026-05-06 — kailash-coc-claude-rb missed the 2.19.0 sync; not surfaced until the user asked "only rs has this issue? what about the py?" during follow-up review.

## Rule 3 — full JSON-dialect examples (rs/rb/py family schema drift)

```json
// DO — canonical schema, every field populated, version is current
{
  "version": "3.10.0",
  "type": "coc-use-template",
  "upstream": {
    "name": "loom",
    "type": "coc-source",
    "version": "2.20.0",
    "loom_sha": "abc1234",
    "synced_at": "2026-05-06T14:22:00Z",
    "template_version": "2.20.0",
    "sdk_packages": { "kailash": "2.13.4", "...": "..." }
  }
}

// DO NOT — `upstream.version` lags `template_version` (rb 2.18.0 dialect)
{
  "upstream": {
    "version": "2.17.0",        // stale
    "template_version": "2.18.0" // current
  }
}

// DO NOT — `upstream.version` field missing entirely (rs dialect pre-2.20)
{
  "upstream": {
    "build_version": "2.19.0",
    "template_version": "2.19.0"
    // (no `version` field — `jq '.upstream.version'` returns null)
  }
}
```

## Rule 4 — verifying-command fanout sample

```bash
$ for t in $(yq -r '.sync_targets[].templates[].repo' .claude/sync-manifest.yaml); do
    v=$(jq -r '.upstream.version // .upstream.build_version // "?"' "../$t/.claude/VERSION")
    echo "$t: $v"
  done
kailash-coc-claude-py: 2.20.0
kailash-coc-py: 2.20.0
kailash-coc-claude-rs: 2.20.0
kailash-coc-rs: 2.20.0
kailash-coc-claude-rb: 2.20.0
```

## v6.2 Headroom-Floor BLOCK Condition — Design Context

PR #218 (merged 2026-05-15, commit `75352dd`) added a `headroom_pct` column to Rule 2's verification table AND wired the per-CLI `headroom_floor_pct` (from `sync-manifest.yaml::cli_variants.context/root.md.<cli>.headroom_floor_pct`) as a BLOCK condition: any cli×lang combo whose post-emit headroom falls below the per-CLI floor halts the sync.

The structural defense is `emit.mjs` (in default strict mode) returning non-zero on breach (Shard 1); the coc-sync agent's emit step 6.5 (Shard 2) invokes `node …/emit.mjs --all --lang <py|rs>` for every py/rs distribution. F5's Trust Posture Wiring binds this structural defense to the graduated-trust posture system: severity is `block` (structural — the emitter's exit code IS the signal, not a prose match), grace is 7 days from PR #218 merge, regression-within-grace fires on flag-bypass / manifest-edit-that-breaches / explicit override prose.

Strict mode was opt-in at PR #218 merge (cycle-1 design per plan §5.1 invariant 5); cycle-2 flipped the default to opt-out (PR #230, 2026-05-15) after the v2.31.0 /sync cycle confirmed zero false-positive blocks. Cycle-3 (a) removed the legacy `--strict-headroom` accepting after a callsite sweep confirmed zero executable references. The opt-out escape `--no-strict-headroom` is reserved for test-harness intentional-breach exercises and BLOCKED in production `/sync-to-use` per Trust Posture Wiring regression class (a).

## Origin — full prose

2026-05-06 — user follow-up review revealed (a) kailash-coc-claude-rb missed the 2.19.0 sync entirely (one cycle stale); (b) the 2026-05-06 session-notes claim "all 4 USE templates at 2.19.0" was wrong on enumeration (5 templates post-prism) AND on currency (rb at 2.18.0); (c) VERSION schema diverged in three dialects across py / rs / rb families. Pre-rule, every defense was implicit in the Gate 2 prose of the then-single `/sync` command (since split by direction and lane — Gate 2 is now `commands/sync-to-use.md` + `commands/sync-to-build.md`) and in `sync-manifest.yaml` declarations; nothing forced the enumeration to be mechanical at invocation time, and nothing forced post-sync verification beyond `git push` exit code. Rule lifts the implicit invariants into explicit MUST clauses and pins them with Trust Posture Wiring so regression triggers downgrade.

v6.2 extension (2026-05-15) — F5 cc-architect R1 LOW from `journal/0073-DECISION-v6.2-shards-1-2-3-converged-2026-05-15.md`: the new headroom-floor BLOCK condition added to Rule 2 by Shard 2 lacked Trust Posture Wiring; F5 closes the structural-defense gap with severity tag, grace period, regression policy, receipt requirement, and detection mechanism.

## Rule 9 — target verifiability (depth)

### The incident

A Gate-2 distribution PR was opened into a target whose `main` had **no required status
check**. Four sibling targets in the same fanout ran a `validate` workflow; this one ran
nothing. `gh pr checks` printed `no checks reported on the branch` — a string that is
neither green nor red — and the PR sat unmergeable-or-unverifiable for a full session.

The symptom was the target's missing workflow. The **root cause was upstream of it**: loom
asserts a distribution contract ("this tree landed, CI-gated") and had no gate on whether
the target could honour it. `sync-gate2-worktree.mjs` would open a PR into any repo the
resolver named, and `gatedMergeHint` would then instruct the operator to "merge after CI
green" on a repo where green is not a reachable state. The operator's only options were
merge-blind or hold — and neither was a decision they had been given the facts to make.

### Why "no checks reported" is the dangerous string

It is the ABSENCE of an instrument rendered in the same field where a verdict would appear.
Read as green it merges unverified; read as red it stalls distribution. Neither reading is
supported, because no result the command could have produced would have falsified either
proposition — `instrument-discipline.md` MUST-1 in its purest form. The remedy is not a
better reading of that output; it is a DIFFERENT instrument (the protection endpoint) asked
a question it can actually answer.

### Why the probe uses key checks, not object construction

`gh api repos/<o>/<r>/branches/main/protection` has three distinguishable no-gate shapes:

| Shape | Meaning | Remedy |
|-------|---------|--------|
| HTTP 404 | branch has NO protection at all | add a protection rule |
| `required_status_checks` key ABSENT | protected, but no status-check rule | add the status-check rule |
| `required_status_checks: null` or `contexts: []` + `checks: []` | rule present, names nothing | populate the contexts |

`p.required_status_checks?.contexts?.length` collapses all three to one falsy value. A
missing key yields `null`, which cannot be told from PRESENT-AND-NULL, so the operator
receives one undifferentiated "no" for three states with three different fixes.
`classifyTargetVerifiability` uses `Object.prototype.hasOwnProperty` and returns a distinct
`reason` per shape. The `null-vs-absent-discriminated` fixture case is the regression lock:
mutating `hasKey` back to `?.` reds that case and ONLY that case (measured).

Both context carriers are unioned. The endpoint returns the legacy `contexts: []` and the
newer `checks: [{context, app_id}]`; either may be the populated one depending on how the
rule was created, so reading only one under-reports and yields a false `unverifiable`.

### Why 404 is a determinate answer, not a probe failure

On this endpoint 404 means "not protected". Classifying it as `error` would produce
`unknown` — which refuses the auto-merge — and would make every unprotected target look
like an infrastructure problem. It is mapped to `not-found` and classified `unverifiable`
with reason `no-branch-protection`. Anything the 404 matcher does not recognize stays
`error` → `unknown`, so the fail-closed direction is preserved for genuine probe failures.

### Why advisory at PR-open and refusing at auto-merge

The asymmetry is load-bearing and was chosen, not defaulted to:

- **PR-open advisory.** loom does not own the target's branch protection and MUST NOT edit
  it (`repo-scope-discipline.md` — a cross-repo write). Refusing the PR would convert a gap
  loom cannot fix into a distribution outage, leaving the target silently behind canon.
  Silence is the failure this rule exists to end; the operator DECIDING to merge unverified,
  on the record, is not.
- **Auto-merge refusing (exit 6).** On `--merge` there is no human between the verdict and
  the merge: the script runs `gh pr checks` (which prints its non-verdict) and then
  `gh pr merge --admin`. An advisory line scrolling past an unattended merge is not a
  surface anyone reads, so the exit code is the only carrier. The PR is left OPEN, so the
  distribution is not lost — only the unattended merge is withheld.
- **`--accept-unverified-target`** waives only the auto-merge refusal, and is rejected LOUD
  on any path where it would waive nothing. A flag that silently does nothing is how an
  operator comes to believe a gate was cleared when it never fired.
- **`unknown` refuses on the same footing as `unverifiable`.** An errored probe is zero
  evidence, never an all-clear (`evidence-first-claims.md` MUST-3).

### What the fixtures prove, and how they were shown to red

`.claude/audit-fixtures/gate2-target-verifiability/` — 19 bipolar cases, `min_cases: 19` in
`ci-audit-fixtures.json`. Pole A payloads MUST classify `verifiable`; pole B/C MUST NOT, so
a classifier hardwired to either pole reds on the other. Two SOURCE PINS assert the probe is
called before `stageBranchCommit` and that the merge refusal sits inside the `--merge`
branch before `gh pr merge` — because a correct classifier that nothing calls prints an
identical green. Five mutations were measured (table in the fixture README); M2–M5 each red
exactly one case, which is what makes those cases readable as evidence rather than smoke.

## Rule 3a — provenance stamp freshness (loom#1756)

Depth for the Rule 3a clause, extracted per `rule-authoring.md` Rule 10 path (a): the
inline form pushed the emitted `rules/sync-completeness.md` to 64158 B against the 60 KiB
producer budget, so the BLOCKED corpus and the Wiring block live here.

**BLOCKED rationalizations:**

- "the version string is unchanged, so the stamp is still accurate"
- "`stamp-template-version.mjs --check` passed"
- "the next sync will restamp it"
- "the PR body records the real SHA"
- "the git history is the real provenance"
- "an absent stamp would be worse than a stale one"

The last is the inversion worth naming: a stale stamp is STRICTLY worse than an absent
one, because it reads as a successful, dated delivery and every downstream freshness
check built on `loom_sha` then returns a confident wrong answer.

### Trust Posture Wiring — Rule 3a

Applies to the **Rule 3a** clause ONLY (added 2026-08-16, loom#1756); ships
canonical-8-field-compliant per `trust-posture.md` MUST-8. Rules 1–9 keep their existing
wiring until each is itself `/codify`-touched (clause-scoped precedent: `security.md`
§ Enforcement-Surface Parity).

- **Severity:** `block` at the structural layer — `sync-gate2-worktree.mjs --finalize`
  exits 4 on a stamp naming another commit; an exit code, not a regex, so it MAY carry
  `block` per `hook-output-discipline.md` MUST-2. `halt-and-report` at gate-review
  (cc-architect at `/codify` confirms each distributed target's stamp names the
  distributing SHA).
- **Grace period:** 7 days from clause landing (2026-08-16 → 2026-08-23).
- **Cumulative posture impact:** same-class violations (a target distributed with a stamp
  naming a prior run, or a `--finalize` whose provenance gate reported UNVERIFIED and the
  operator proceeded anyway) contribute to `trust-posture.md` MUST-4 cumulative-window
  math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` trigger per
  `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key; the
  structural exit already carries the enforcement, and minting a key would drag
  `trust-posture.md`, a `self-referential-codify.md` allowlist file, into a
  self-referential edit. Named deviation recorded per `trust-posture.md` Rule 8, the same
  disposition Rule 8's USE-lane addendum took.
- **Receipt requirement:** SessionStart soft-gate `[ack: sync-completeness]` IFF
  `posture.json::pending_verification` includes the `sync-completeness` rule_id (shared
  rule_id; one ack covers every clause in the file).
- **Detection mechanism:** structural — `provenanceStampVerdict` at `--finalize` (exit 4).
  Fixtures: the bipolar cases in `.claude/test-harness/tests/sync-gate2-worktree.test.mjs`
  fire the gate at BOTH poles — a stale stamp refuses; run-pinned AND abbreviated stamps
  pass (the abbreviation case exists so the gate cannot be satisfied by a matcher that
  refuses everything); an absent anchor yields `skip` with named reasons, never `ok`.
  Probes: NOT authored — `sync-completeness.md` has no probe suite and no
  `eval-manifest.json` entry. Stated rather than naming a phantom path: the semantic tier
  is UNCOVERED and owed at gate-review via `/test-harness-probe`.
- **Violation scope:** Rule 3a ONLY (clause-scoped).
- **Origin:** loom#1756 — the 2026-08-15 nine-surface distribution restamped nothing; four
  templates now assert 2026-08-02 provenance over 2026-08-15 content, and the open
  2026-08-13 PRs assert a THIRD SHA, so merging them would have made provenance less
  accurate rather than more. Recorded in
  (loom-internal reference).

## Rule 8 BUILD-lane clause — why `emit-coc.mjs` needs an explicit `--lane build` (loom#1764)

Depth for the compact inline parenthetical in `rules/sync-completeness.md` § BUILD-lane
clause (#181), extracted per `rule-authoring.md` Rule 10 path (a): the full form pushed
the emitted `rules/sync-completeness.md` past the 60 KiB producer budget, the same
constraint Rule 3a's extraction records.

**Why the flag is not optional.** `--lane` selects the DISTRIBUTION-FATE axis; `--target`
selects the TIER + VARIANT axis and says nothing about lane. The SAME `--target py` names
both a USE template and a `build_multi_cli` BUILD repo, and the two lanes carry OPPOSITE
exclusion sets — `use_exclude` names artifacts a USE consumer must never receive,
`build_exclude` the mirror image. `emit-coc.mjs` defaults to `--lane use` (fail-closed
toward the third-party audience, per `security.md` § Secure-Default), so a BUILD emit that
omits the flag silently withholds the BUILD-bound `use_exclude` artifacts.

Measured on this branch, `emit-coc.mjs --target py`, build lane vs the default:

| Invocation | files | withheld by lane fate |
|---|---|---|
| `--lane build` | 203 | 4 |
| (no flag ⇒ `--lane use`) | 202 | 7 |

The five the default withholds from a BUILD target: `commands/test-harness-probe.md`,
`rules/coc-artifact-eval-coverage.md`, `rules/cross-sdk-inspection.md`,
`rules/documentation.md`, `skills/test-harness-probe/`. The four `--lane build`
withholds from USE: `commands/deploy.md`, `commands/sync-from-downstream.md`,
`commands/sync-from-template.md`, `rules/deploy-hygiene.md`.

**The hint is lane-CONDITIONAL, and that is the point.** After loom#1756 generalized
`assertDerivedTreesPresent` to both lanes, its remediation message reaches USE finalizes
too. Printing `--lane build` unconditionally would hand a USE operator the instruction
that leaks BUILD-internal artifacts to a third-party consumer — the mirror of the defect
the flag exists to fix, and strictly the worse direction. `sync-gate2-worktree.mjs`
therefore branches the hint on `lane`, and each lane's refusal names only its own flag.

**Correction record.** Before loom#1756 this clause asserted that the BUILD-lane check was
STRONGER than the USE-lane manual sweep. That held only until the driver began enforcing
presence + corpus co-change at `--finalize` on BOTH lanes; the claim was falsified and is
withdrawn, not merely softened.
