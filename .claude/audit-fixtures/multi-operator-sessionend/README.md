# multi-operator-sessionend audit fixtures

Mechanical regression locks for `.claude/hooks/multi-operator-sessionend.js`.

| Fixture                             | Scope-restriction predicate                                                | Expected                                              |
| ----------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------- |
| 01-release-claims                   | Own active claims exist → append release records                          | continue:true; release record(s) in log              |
| 02-checkpoint-cosigner              | derived-N≥2 + cosigner reachable → self-sign SKIPPED, skip recorded         | continue:true; `checkpoint-skipped` record (reason=cosigner-coordination-required, cosigner_person_id) and NO compaction-checkpoint |
| 03-degenerate-genuine-genesis       | derived-N=1 + NO attestation history → degenerate self-sign permitted      | continue:true; compaction-checkpoint with degenerate marker |
| 04-blocked-R9-S-02                  | derived-N=1 + attestation history present → fence BLOCKS self-sign         | continue:true; NO new checkpoint record in log       |

Hook MUST NEVER block — all four cases emit `{continue: true}`.
Eligibility routes through `lib/eligibility.js::isEligibleSigner` and
`lib/r9s02-fence.js::gateEligibleForSelfSignedCheckpointOrRotation`.

Row 02 was CORRECTED 2026-08-30 (loom#2044 Group A) on this directory's first
ever execution: it had pinned the placeholder cosig emission that M5 iter-6
removed (Sec-MED-A1 / R7). See `02-checkpoint-cosigner/expected.txt` § note.

Executed by `run.mjs` (registered in `.claude/test-harness/ci-audit-fixtures.json`).
