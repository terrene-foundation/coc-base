# `governed-throughput` audit fixtures — two tiers, one directory

`rules/governed-throughput.md` § Trust Posture Wiring names this directory twice, for two
DIFFERENT things. Reading either as the other is the mistake this file exists to prevent.

**Tier 1 — SEMANTIC probe candidates (PRESENT, shipped).** The ten files paired as
`<name>.txt` / `<name>.expected` and `<name>.md` / `<name>.expected` are the candidate
fixtures for `.claude/test-harness/probes/governed-throughput.probes.json`, five bipolar
pairs: one per clause `check-clause-coverage.mjs::deriveClauses` derives (MUST-1, MUST-2,
MUST-3, `## MUST NOT`) plus a meta-compliance pair. The `.txt` files are SESSION
TRANSCRIPTS, not artifact snapshots, because every clause here turns on what the
orchestrator did around a delegation brief — whether a selector ran, what reached the
prompt, what scope the merge gate was given — and no static file carries any of that.

Each `.expected` sidecar is the ANSWER KEY and is never handed to a judge;
`probe-suite-integrity.test.mjs` enforces both halves of that (a sidecar must exist, and
the candidate must be free of answer-key markers and HTML comments).

**Genericized paths are load-bearing, not cosmetic.** The briefs render worktree roots as
`<operator-home>/repos/...`. `.claude/audit-fixtures/**` ships to consumers,
`scan-synced-disclosure.mjs` keys on the SHAPE rather than on whether a name is real, and
an invented username inside a `/Users/<name>/` span still flags. The same genericization
is also `governed-throughput.md` MUST-2's touched-path scrub, so it is a deliberately
SHARED property of both poles of every firing pair and is never the discriminator.

**Tier 2 — STRUCTURAL fixtures for the Phase-2 detector (ABSENT, still deferred).** The
`.claude/hooks/lib/violation-patterns.js` detector on delegation-prompt construction has
not been built; its deferral is live in
`phase2-deferrals.json::deferrals["governed-throughput.md#delegation-prompt-detector"]`.
Per `cc-artifacts.md` Rule 9 its fixtures land WITH it, in this directory, one per
scope-restriction predicate. Nothing here today serves that tier.

Phase 1 detection remains the review-layer sweep at `/codify` + `/implement`. Registering
the probe suite bought DISPATCHABILITY, never automatic execution — no workflow invokes
`coc-probe-dispatch.mjs`, so a green CI run is never evidence these probes passed.
