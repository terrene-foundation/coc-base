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

Because of that rollout, two wiring details in the rule body read as history rather than as live mechanism, and are recorded here instead: Shard 1 wired the validator and Shard 2 wired the `coc-sync.md` invocation; cycle-2 dropped the explicit `--strict-headroom` opt-in from that invocation and cycle-3 removed the legacy no-op accepting, so the detection-mechanism (5b) grep no longer anchors on the flag name. The grace period likewise applies only to operators running `emit.mjs` directly — inside `/sync-to-use` the non-zero exit has propagated unconditionally for py/rs since Shard 2.

### Exact sweep commands for detection mechanisms (5) and (5b)

The rule body names both sweeps and their finding severities; these are the commands.

```bash
# (5) Manifest-axis sweep — both values MUST be >= 10 (Risk-0004 baseline); lower is CRIT
yq '.cli_variants."context/root.md".codex.headroom_floor_pct, .cli_variants."context/root.md".gemini.headroom_floor_pct' .claude/sync-manifest.yaml

# (5b) Exit-code-swallow sweep (loom-side) — MUST exit 0; exit 1 lists each HIGH finding
node .claude/bin/check-emit-exit-swallow.mjs            # default target: agents/management/coc-sync.md
```

The (5b) sweep is a script, not a grep, because the verdict turns on what sits to the RIGHT of
the `||`. The earlier one-line regex matched ANY `||` after `emit.mjs`, so the correct halt form
`|| exit 1` was itself a hit and the "0 hits" requirement could only be met by deleting the
guard. The script accepts `|| exit N` (N non-zero), `|| return N` and `|| { …; exit N; }`, and
reports `|| true`, `|| :`, `|| echo …`, `|| exit 0`, `; true`, `&& :`, `set +e`, `2>/dev/null`
with no exit check, a pipe with no `pipefail`, an `if` whose body never exits, and a
backgrounded invocation. Exit 3 means it evaluated NOTHING, which is not a clean sweep. It
prints what it did NOT evaluate: `# DO NOT` counter-examples, non-shell fences, and prose.
`test-harness/tests/check-emit-exit-swallow.test.mjs` imports the same module, so the sweep
and its test cannot drift apart. Like the grep before it, it does NOT anchor on
`--strict-headroom`: strict became the default in cycle-2, so the regression shape is an
exit-discard wrapper around the invocation, not a missing opt-in flag.

### The two-tier receipt band — derivation

The advisory band sits 3% above the floor and the halt-and-report band 1% above it. The 3% width was chosen to match the routine-CRIT-rule emission swing: a typical rule landing moves ~500–800 B, which against the 61,440 B cap is ~1% of headroom, so a 3% band covers roughly two cycles of routine drift and the receipt fires BEFORE the breach rather than after it. From the measured state at wiring time (`journal/0074` § For Discussion #2: gemini rs at 15.64%, the closest cli×lang combo to the floor), 3 typical landings reach the 13% advisory and 4–5 reach the 11% halt-and-report — a ~2-cycle / ~4-cycle lead time. Those figures are the 2026-05-15 measurement and are NOT current; re-measure from `emit-report-<cli>.json::headroom_pct` rather than citing them.

## Origin — full prose

2026-05-06 — user follow-up review revealed (a) kailash-coc-claude-rb missed the 2.19.0 sync entirely (one cycle stale); (b) the 2026-05-06 session-notes claim "all 4 USE templates at 2.19.0" was wrong on enumeration (5 templates post-prism) AND on currency (rb at 2.18.0); (c) VERSION schema diverged in three dialects across py / rs / rb families. Pre-rule, every defense was implicit in the Gate 2 prose of the then-single `/sync` command (since split by direction and lane — Gate 2 is now `commands/sync-to-use.md` + `commands/sync-to-build.md`) and in `sync-manifest.yaml` declarations; nothing forced the enumeration to be mechanical at invocation time, and nothing forced post-sync verification beyond `git push` exit code. Rule lifts the implicit invariants into explicit MUST clauses and pins them with Trust Posture Wiring so regression triggers downgrade.

v6.2 extension (2026-05-15) — F5 cc-architect R1 LOW from `journal/0073-DECISION-v6.2-shards-1-2-3-converged-2026-05-15.md`: the new headroom-floor BLOCK condition added to Rule 2 by Shard 2 lacked Trust Posture Wiring; F5 closes the structural-defense gap with severity tag, grace period, regression policy, receipt requirement, and detection mechanism. Cycle-2 (same-day) flipped `--strict-headroom` from opt-in to opt-out default per plan §5.1 invariant 5 (mirrors the v2.13.0 `--strict-budget` rollout) after the v2.31.0 `/sync-to-use` cycle confirmed zero false-positive blocks across all 5 USE templates.

### Per-rule origination entries

**Rule 5 (2026-06-27, `journal/0352`)** — co-owner-directed origination. A downstream `/sync-from-template` consumer reported `extract-policies.mjs` was a no-op after a `.claude/`-only sync left the external `../.codex-mcp-guard` target stale.

**Rule 7 (2026-07-03, `journal/0403`, Directive 1)** — co-owner-directed origination. The worktree-from-remote-main Gate-2 model requires capturing the engine's `buildReceipt` per-file manifest per enumerated target — the distribution-completeness companion to `artifact-flow.md` § "Exact Gate-1 / Gate-2 Tracking".

**Rule 8 (2026-07-11, `journal/0465`)** — co-owner-directed `/govern` origination; narrative in § "Rule 8 — derived-tree re-emit (depth)" below.

**Rule 9 (2026-08-16, loom#1745), and its same-day EXTENSION (loom#1750)** — a Gate-2 PR into a target with NO required status check on `main`, while four sibling targets ran a `validate` workflow: `gh pr checks` reported "no checks reported on the branch", which is neither green nor red, and the PR sat unmergeable-or-unverifiable for a session. The root cause was NOT the target's missing workflow but loom asserting a CI-gated distribution contract it never checked the target could honour; the fix determines and surfaces the verdict at handover and refuses only the auto-merge path.

The EXTENSION (loom#1750): #1745's refusal was correct and UNSATISFIABLE. loom distributed the artifact corpus and distributed nothing able to validate it (`sync-manifest.yaml` carried one workflow entry, py-only `publish-dev-image.yml`; the `coc-artifact-eval.yml` py and rs run is repo-local and never cascaded), so `terrene-foundation/kailash-prism` had zero required checks and every future target would repeat the gap. The extension makes verifiability satisfiable by construction — a distributed baseline validator plus the `unregistered` tier that separates "no verifier" from "verifier present, check unarmed" — while leaving registration where `repo-scope-discipline.md` puts it: with the target's owner. Its one-path-under-`.github/` ownership boundary is the `Dockerfile` / `Dockerfile.user` base-vs-overlay line recorded in `specs/04` §2.

## Companion defenses

The rule body's intro names three companions and states what each is FOR; this is what each actually checks.

**`bin/check-sync-freshness.mjs` (F62, `journal/0163` + `0164`)** — the symmetric **pre-sync** defense, wired at `commands/sync-to-use.md` Step 0b. It performs a local-vs-remote SHA-pair check BEFORE the distribution runs, mirroring this rule's verification-table check AFTER it. The pairing matters because the two failure modes are different: pre-sync catches distributing from a stale loom checkout, post-sync catches a distribution that did not land.

**`tools/verify-overlays.sh` (#427, `journal/0252`)** — the **file-set-completeness** companion to Rule 2's version/headroom table. Where the table answers "did the target reach the bumped version?", this answers "did every declared file arrive?" — verifying that every `variants:` overlay AND every `variant_only:<lang>` addition landed byte-equal at its destination. The load-bearing half is the in-tool gate, not the script: `sync-tier-aware.mjs::expandVariantOnly` exits 1 on a declared-but-undistributable `variant_only` entry, so the failure is loud at distribution time rather than discovered by a later sweep.

**`coc-sync-landing.md`** — the delivery-durability companion: bytes that land but are never committed vanish, which is the same invisible-delivery class Rule 6 closes from the `.gitignore` side.

## Rule 6 — swallowed-artifact tracked-ness (depth)

loom#676. A consumer carrying the conventional Python build-artifact block (`lib/`) silently untracked the entire `.claude/bin/lib/` directory — including `loom-links.mjs` (the canonical NAME→location resolver named in `repo-scope-discipline.md` § MUST NOT; the module itself is loom/BUILD-side), `slot-parser.mjs`, and `strip-build-internal.mjs`, all of which the TRACKED `sync-tier-aware.mjs` imports.

The failure is invisible locally and total remotely: it "worked" only because the files were present on disk from the local sync, so every check the syncing operator could run passed. A fresh clone tracks none of them and `sync-tier-aware.mjs` throws `Cannot find module './lib/loom-links.mjs'` on import.

That asymmetry is why the rule mandates BOTH halves. The `gitignore_reincludes` negation closes the known instance; only the post-sync `git check-ignore` gate closes the CLASS, because the next colliding basename (`build/`, `dist/`, `var/`, `parts/`) will be introduced by a consumer whose `.gitignore` loom never reads.

## Rule 8 — derived-tree re-emit (depth)

### The originating divergence (coc-rs #48)

Co-owner-directed `/govern` origination, `journal/0465`. The F2 divergence where two `coc-sync` agents split: the rs agent read the step-6 "scaffold" wording literally — as "symlinks + manifest only" — and skipped the derived-CLI-tree re-emit for a multi-cli target. 19 changed commands/skills shipped stale `.codex`/`.gemini` artifacts; the gap totalled 67 files. The rule is the USE-lane analogue of the F11 BUILD-lane `--verify` completeness gate.

The BUILD-lane completeness gate (F11, `journal/0339`) that the rule body's intro names was ABSENT when two `coc-sync` agents diverged into complementary partials: py landed content but skipped the purge; rs purged but skipped the codify-anchor. Neither partial was visible from its own side, which is why the gate is a read-only whole-tree assertion rather than a per-step check.

### Flag asymmetry across the three emitters

Verified against each tool's `parseArgs`, and easy to get wrong because the three are invoked together:

- `emit-cli-artifacts.mjs` and `emit-coc.mjs` take `--target`; `emit.mjs` takes `--lang`.
- `emit-cli-artifacts.mjs` and `emit-coc.mjs` REQUIRE `--out`; `emit.mjs` DEFAULTS `--out` to a throwaway tmp dir.

The second asymmetry is the dangerous one: an `emit.mjs` invocation that omits `--out` exits 0 having written the baselines nowhere the target will ever see, which is why the rule mandates passing `--out` on all three rather than relying on the default.

### The wired USE-lane gate (loom#1756) and its blind spot

`sync-gate2-worktree.mjs --finalize` exits non-zero on two conditions: (a) an owed derived tree is absent or empty; (b) the run changes a path under the derived-FROM corpus (`.claude/{rules,agents,skills,commands}/`, `CLAUDE.md`) while changing ZERO owed derived path. Clause (b) exists because a presence check cannot see the stale-but-present case — the exact shape the 2026-08-15 coc-base distribution took, where every derived tree existed and every one of them was a cycle old.

Clause (b) is a CO-CHANGE coupling test, not an idempotency check, and the difference bounds what a green from it licenses. Its blind spot is a corpus delta that projects into no CLI surface: there it refuses a correct run, which fails SAFE. Its ceiling is that it cannot distinguish a COMPLETE re-emit from a partial one that happened to touch at least one derived path — so the full-re-emit property stays gate-review-enforced, and the idempotency check remains owed.

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

| Shape                                                           | Meaning                             | Remedy                    |
| --------------------------------------------------------------- | ----------------------------------- | ------------------------- |
| HTTP 404                                                        | branch has NO protection at all     | add a protection rule     |
| `required_status_checks` key ABSENT                             | protected, but no status-check rule | add the status-check rule |
| `required_status_checks: null` or `contexts: []` + `checks: []` | rule present, names nothing         | populate the contexts     |

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

`.claude/audit-fixtures/gate2-target-verifiability/` — a bipolar suite whose CURRENT case
count and floor are deliberately NOT restated here: read them from the runner's own control
and from `ci-audit-fixtures.json`, which is authoritative by construction. This sentence
previously restated both the case count and the registry floor, and was still quoting the
original pair long after the suite had grown past them — a restated count is a second source
of truth that goes stale on the next fixture addition, which is the drift loom#1793 exists to
stop. (The stale figures are deliberately not re-quoted here: a number written even as an
example is still a number nothing reconciles, which is the same defect one layer down.) Pole
A payloads MUST classify
`verifiable`; pole B/C MUST NOT, so
a classifier hardwired to either pole reds on the other. Two SOURCE PINS assert the probe is
called before `stageBranchCommit` and that the merge refusal sits inside the `--merge`
branch before `gh pr merge` — because a correct classifier that nothing calls prints an
identical green.

**Mutations were measured in successive dated ROUNDS**, tabulated in the fixture README —
M1–M5 for the loom#1745 classifier/refusal half, M6–M10 + T1–T4 for the loom#1750
shipped-verifier half, C1–C6 for the correctness round, and the loom#1760 security round
(the F1 indent-anchoring poles, the F2 required-`elected` poles, the F3 USE-lane poles and
the F4 receipt-accuracy pole), whose evidence sits AT each case rather than in a table.

The TOTAL is deliberately not spelled out here. This sentence has now gone stale twice —
first as "Five", then as "Fourteen" — for the same structural reason each time: a count
restated in narrative is a second source of truth with nothing reconciling it, so it decays
on the next round while reading as current. The README's tables plus the per-case comments
are the ground truth; count them there if a total is needed.

Read them by what each DISCRIMINATES, not by the tally:

- **M1** — `classifyTargetVerifiability` returns `verifiable` unconditionally: reds all three
  poles plus the notice and receipt cases, so it only shows the suite is not inert.
- **M2** — `hasKey(p,"required_status_checks")` collapsed to `p?.required_status_checks`: reds
  the ABSENT-vs-PRESENT-AND-NULL discrimination case ONLY. This is the mutation that proves
  the probe distinguishes two repo states with two different remedies.
- **M3** — the `--merge` refusal predicate forced to `if (false)`: reds the auto-merge-refusal
  case ONLY.
- **M4** — an errored probe reported as `status:"not-found"` (an auth failure read as
  "unprotected"): reds the auth-failure case ONLY.
- **M5** — the probe call replaced by a hardcoded `verifiable` verdict: reds the
  probe-is-called-before-the-commit source pin ONLY.
- **M6** — `notVerifiable` ignores `present`, never upgrading to `unregistered`: reds both
  tier cases plus the notice case.
- **M7** — the `unknown` branch upgrades when the verifier is present: reds the
  `unknown`-does-not-upgrade pole ONLY.
- **M8** — `ciVerifierOnBase` reverts to `fs.existsSync`: reds both `onbase/` cases.
- **M9** — `emitCiVerifier` `rm -rf`s `.github/workflows/` before writing: reds the
  target-CI-preservation case ONLY.
- **M10** — the template context-name check becomes `if (false)`: reds the drifted-context-name
  refusal ONLY.
- **T1–T4** — the four distributed-workflow trigger pins: a `paths:` filter added back to the
  `pull_request` arm; the aggregator job renamed away from `COC required checks`; the
  aggregator's `*)` default branch exiting 0 instead of 1; and the "no validator ran" floor
  made unreachable. T1, T3 and T4 each red exactly one case; T2 reds the name pin plus every
  emit case, because the emitter refuses a drifted template — the intended fail-closed.

Every mutation was confirmed to have APPLIED (`cmp` against the original) before its result
was read: a mutation that does not change the file is a second non-discriminating instrument,
not a verdict (`instrument-discipline.md` MUST-2(b)). The unmutated control each table was
measured AGAINST was 19/19 for the first and 48/48 for the second — AS-OF figures, kept
because a mutation result is only readable against its own control, and NOT the current
count (which the runner prints and `ci-audit-fixtures.json` declares).

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

| Invocation               | files | withheld by lane fate |
| ------------------------ | ----- | --------------------- |
| `--lane build`           | 203   | 4                     |
| (no flag ⇒ `--lane use`) | 202   | 7                     |

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

## Structural-cleanup extraction — 2026-08-20 (per-file `.coc/` producer budget)

Index of the depth this file absorbed when `.claude/rules/sync-completeness.md` was brought
back under the per-file 60 KiB producer budget `emit-coc.mjs` enforces on the emitted
`.coc/rules/SYNC-COMPLETENESS.md`. Measured 63823 B (over by 2383 B) before, 60390 B after.
The rule body keeps every MUST, MUST NOT, BLOCKED-rationalization entry, DO/DO-NOT block,
`**Why:**` failure-mode statement, and all eight canonical Trust-Posture-Wiring field labels
with their normative statements; only depth moved.

| Depth topic (removed from the rule body) | Landed at |
| --- | --- |
| § Origin per-entry narrative (Rules 1–4, v6.2, 5, 7, 8, 9 + the loom#1750 extension) | § "Origin — full prose" |
| Companion defenses: F62 pre-sync check, #427 overlay verifier, `coc-sync-landing.md` | § "Companion defenses" |
| Rule 2 — the rb-at-2.18.0 `template_version` instance | § "Rule 1 — full incident detail" |
| Rule 3 — the 5-invocation two-field-path audit cost | § "Rule 3 — full JSON-dialect examples" |
| Rule 3a — the four-templates-stale 2026-08-15 measurement | § "Rule 3a — provenance stamp freshness" |
| Rule 4 — the "all 4 USE templates at 2.19.0" propagation | § "Rule 1 — full incident detail" |
| Rule 5 — the `extract-policies.mjs` no-op origin instance | § "Origin — full prose" |
| Rule 6 — the loom#676 `lib/` untracking instance | § "Rule 6 — swallowed-artifact tracked-ness (depth)" |
| Rule 8 — emitter flag asymmetry, loom#1756 gate mechanics, coc-rs #48, F11 complementary partials | § "Rule 8 — derived-tree re-emit (depth)" |
| Rule 9 — the unmergeable-target incident + the `.github/` ownership boundary | § "Rule 9 — target verifiability (depth)", § "Origin — full prose" |
| Rule 9 — the measured fixture mutation rounds | § "What the fixtures prove, and how they were shown to red" |
| v6.2 — cycle-by-cycle rollout history + two-tier receipt-band derivation | § "v6.2 Headroom-Floor BLOCK Condition — Design Context" |

**Rule-10 / Rule-11 disposition.** Neither fires. `rule-authoring.md` Rule 10 § "Trigger
scope" limits the proximity-band gate to `priority: 0` + `scope: baseline` rules, and
`sync-completeness.md` is `priority: 10` + `scope: path-scoped` — it pays no baseline-emission
cost. This extraction follows Rule 10 path (a)'s SHAPE (depth to the paired extract, normative
content untouched) because that shape is correct, not because Rule 10 compelled it, and it is
NOT Rule-11 recurrence input. The two budgets are independent: `priority: 10` waives the
baseline one and does nothing about the per-file `.coc/` one.
