# `burndown-integrity` fixtures

Backs `.claude/rules/burndown-integrity.md` and its generator `.claude/bin/burndown-build.mjs`.
Registered in `.claude/test-harness/ci-audit-fixtures.json` (`mode: run`, `min_cases: 64`).

Run: `node .claude/audit-fixtures/burndown-integrity/run.mjs`

## Shape

**Bipolar** — compliant poles that MUST stay green, violation poles that MUST
refuse. A one-sided set proves a check can fire and never that it can stay quiet, so the compliant
half is not padding: it is what distinguishes a working guard from a rubber stamp pointed the other
way.

The last compliant pair is the `R-STRUCT-1` regression (2026-08-18 redteam): `--quote` on the
`Open` bucket emitted a BARE count — the shape MUST-3 blocks — while the rule advertises `--quote`
as the cheap correct path. Neither hook arm could catch it, because the token was VALID (so the
structural arm passed it) and the lexical arm fires only on UNtokened counts. The pair is bipolar on
the LEVER, not just the outcome: a fix that appended the split to every bucket reds the second case.

This directory also holds the SEMANTIC-tier probe candidates (`flag-*.txt`, `clean-*.txt`,
`meta-*.md`) for `.claude/test-harness/probes/burndown-integrity.probes.json`, each with a
`.expected` answer-key sidecar that is never shown to a judge. Same split
`sweep-completeness` and `worktree-isolation` carry: the runner cases and the probe candidates
share a directory because they back the same rule at two tiers.

Every case builds a REAL temporary git repository and invokes the REAL binary as a subprocess,
reading its exit code and streams. Nothing is mocked.

## Two things this suite learned the hard way

**Violation cases assert the refusal REASON, not the exit code.** A mutation disabling the
closed-vocabulary check left this suite green at 33/33: the unknown status flowed through to a
`STATUS_KEY` miss, produced `NaN`, and tripped the PARTITION assertion instead — so the case still
saw `exit 2` and the banner, and passed for a reason unrelated to the clause it was named for.
Asserting the exit code alone cannot tell one refusal from another. Each violation case now pins its
own message.

**The partition assertion is a backstop and is NOT independently pinned.** With a validated
vocabulary every item increments exactly one bucket, so `sum(buckets) == total` holds by
construction and no valid input can red it — measured: disabling it leaves the suite green. It fires
only when a prior guard has already failed, which the vocabulary case demonstrates it does. Recorded
here rather than left for a future reader to rediscover as a gap.

## `selftest/`

`selftest/a/` and `selftest/b/` are the discrimination fixtures `burndown-build.mjs --selftest`
runs against. They share a **byte-identical** `register.json`; B adds one growth source and one
owner status-refresh, so every difference between the two blocks is attributable to those sources.

`EXPECTED.md` in each was **hand-computed and committed before the generator existed**. That is what
keeps them from being a self-derived oracle (`evidence-first-claims.md` MUST-5) — and it is not
ceremony: the hand-written expectation caught a real defect on the generator's first run, a table
header that omitted the `total` column while the data rows kept it.

Do NOT regenerate `EXPECTED.md` from the tool. If a change makes them disagree, one of the two is
wrong and the point of the fixture is to make you work out which.
