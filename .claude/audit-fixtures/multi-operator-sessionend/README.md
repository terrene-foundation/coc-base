# multi-operator-sessionend audit fixtures

Mechanical regression locks for `.claude/hooks/multi-operator-sessionend.js`.

| Fixture                             | Scope-restriction predicate                                                | Expected                                              |
| ----------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------- |
| 01-release-claims                   | Own active claims exist → append release records                          | continue:true; release record(s) in log              |
| 02-checkpoint-cosigner              | derived-N≥2 + cosigner reachable → checkpoint with co_signers              | continue:true; compaction-checkpoint with co_signers |
| 03-degenerate-genuine-genesis       | derived-N=1 + NO attestation history → degenerate self-sign permitted      | continue:true; compaction-checkpoint with degenerate marker |
| 04-blocked-R9-S-02                  | derived-N=1 + attestation history present → fence BLOCKS self-sign         | continue:true; NO new checkpoint record in log       |

Hook MUST NEVER block — all four cases emit `{continue: true}`.
Eligibility routes through `lib/eligibility.js::isEligibleSigner` and
`lib/r9s02-fence.js::gateEligibleForSelfSignedCheckpointOrRotation`.
