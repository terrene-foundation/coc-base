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

2026-05-06 — user follow-up review revealed (a) kailash-coc-claude-rb missed the 2.19.0 sync entirely (one cycle stale); (b) the 2026-05-06 session-notes claim "all 4 USE templates at 2.19.0" was wrong on enumeration (5 templates post-prism) AND on currency (rb at 2.18.0); (c) VERSION schema diverged in three dialects across py / rs / rb families. Pre-rule, every defense was implicit in `commands/sync.md` Gate 2 prose and `sync-manifest.yaml` declarations; nothing forced the enumeration to be mechanical at invocation time, and nothing forced post-sync verification beyond `git push` exit code. Rule lifts the implicit invariants into explicit MUST clauses and pins them with Trust Posture Wiring so regression triggers downgrade.

v6.2 extension (2026-05-15) — F5 cc-architect R1 LOW from `journal/0073-DECISION-v6.2-shards-1-2-3-converged-2026-05-15.md`: the new headroom-floor BLOCK condition added to Rule 2 by Shard 2 lacked Trust Posture Wiring; F5 closes the structural-defense gap with severity tag, grace period, regression policy, receipt requirement, and detection mechanism.
