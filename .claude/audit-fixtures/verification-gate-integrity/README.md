# `verification-gate-integrity` — audit fixtures (DEFERRED, and this file says so out loud)

**There are no fixture cases here yet.** This directory is a flat HELPER dir, not a fixture-case
tree, and it is deliberately the weakest part of this rule's coverage. Recording that here rather
than letting a reader infer coverage from a directory that exists.

## What DOES cover this rule today

The SEMANTIC tier only: `.claude/test-harness/probes/verification-gate-integrity.probes.json`
— 8 rows in 4 bipolar pairs (`vgi-must1-wired-control`, `vgi-must2-absence-as-pass`,
`vgi-must4-deletion-blindness`, `vgi-meta-compliance`), registered in
`.claude/test-harness/eval-manifest.json` as a probe-only entry (`scanner: null`) and pinned in
`.claude/test-harness/tests/probe-suite-integrity.test.mjs::PINNED_SUITES`.

Those probes are **scenario-based, not fixture-based** — each row carries an inline `scenario`
rather than a `candidate_fixture` path. That is legal (the answer-key-strip sweep in
`probe-suite-integrity.test.mjs` skips rows with no `candidate_fixture`) but it is strictly
weaker than the fixture-backed form `instrument-discipline` uses, because an inline scenario is
authored in the same file as its `expect` and is therefore easier to drift into agreement with it.

## What does NOT cover it

**Nothing structural.** This rule's Phase-2 detectors are deferred and registered as such in
`.claude/test-harness/phase2-deferrals.json` under `verification-gate-integrity.md#gate-integrity`
and `verification-gate-integrity.md#deletion-blind`. Both Wiring blocks say audit fixtures land
WITH the Phase-2 detector, per `cc-artifacts.md` Rule 9 — so this directory stays a helper dir
until that detector exists. Do not read its presence as coverage.

## Graduation

Delete this README in the same change that lands the first real fixture case here, and wire the
cases to the probe rows via `candidate_fixture` (with the answer key in a `.expected` sidecar,
never in the candidate — the sweep bans HTML comments in candidates outright because a previous
suite kept its key in one).
