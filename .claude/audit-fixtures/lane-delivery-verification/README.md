# `lane-delivery-verification` — fixtures for `worktree-isolation.md` Rule 3b

Semantic-tier candidates for the Rule 3b probe suite
(`.claude/test-harness/probes/worktree-isolation.probes.json`, 4 rows in 2 bipolar pairs).
Every `.txt` / `.md` file here is handed to the judge VERBATIM; every `.expected` sidecar
carries that candidate's answer key and is never shown to the judge. `probe-suite-integrity.test.mjs`
enforces that separation mechanically, so do not move an answer key into a candidate.

| pair | pole | candidate | grades |
| --- | --- | --- | --- |
| `RULE-3b-firing` | violation | `flag-skeleton-counted-as-delivered.txt` | Rule 3b fires: 3 of 8 lanes left placeholder-only reports, all 8 passed an `ls` check, wave closed as covered |
| `RULE-3b-firing` | compliant | `clean-undelivered-recorded-and-recovered.txt` | Rule 3b stays quiet: same wave, placeholder sweep run with a control, 3 lanes recorded UNDELIVERED with dispositions |
| `RULE-3b-meta` | compliant | `meta-compliant-lane-delivery-clause-rule.md` | conforms to `rule-authoring.md` MUST-1..7 |
| `RULE-3b-meta` | violation | `meta-violation-lane-delivery-clause-rule.md` | breaches MUST-1 (hedged modal), MUST-2 (abstract BLOCKED corpus), MUST-3 (non-contrasting DO block), MUST-4 (over-long Why) |

## What each pair is designed to defeat

**The firing pair** is separable ONLY by verification METHOD. Both poles carry the same
eight lanes, the same honest finding arithmetic, the same register, and the same unusually
specific self-criticism (a red-main merge, a `tail`-truncated count corrected 4→17, an
over-claimed PR body). A judge scoring on tone, apparent rigor, or "did the wave go well"
gets it backwards — the compliant pole reports a WORSE wave (three lanes failed, coverage
6 of 8, wave not closed) precisely because it detected the failure the other pole missed.

**The meta pair** is surface-equalized by construction: identical title, identical four
level-2 headings, one numbered clause each, both carrying frontmatter, `## Origin`, a Trust
Posture Wiring block, a `**Why:**` line, a DO/DO-NOT block and a `**BLOCKED
rationalizations:**` heading, with byte sizes within 10%. The violation pole's defects are
in the CONTENT of that furniture, never its absence. The integrity test asserts the
equalization, so an edit that makes one pole structurally distinctive will red.

## Origin

loom session 22 (2026-08-10): four lanes exited leaving reports whose every section was
still a placeholder; three were committed in that state and their surfaces recorded as
covered. The skeleton-first brief adopted to make lane silence visible had made the
file-presence check non-discriminating.
