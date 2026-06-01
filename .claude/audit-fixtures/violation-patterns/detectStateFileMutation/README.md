# detectStateFileMutation audit fixtures

Per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4. Each fixture pins one scope-restriction predicate `detectStateFileMutation(command, pathRx)` relies on. Inputs are bash command strings (paired with a path regex the caller passes — typically `/posture\.json/` or `/operators\.roster\.json/`); expected outputs are the JSON returned by the detector — `null` (no flag) or a structural detection object naming the layer (1: redirect/tee/sed-i, 2: cp/mv/chmod, 3: interpreter -c body).

| Fixture                          | Pair w/ pathRx          | Expects        | Predicate locked                                                                  |
| -------------------------------- | ----------------------- | -------------- | --------------------------------------------------------------------------------- |
| `flag-redirect-to-posture.txt`   | `/posture\.json/`       | `layer:1`      | `> .claude/learning/posture.json` is a Layer-1 redirect to a protected state file. |
| `clean-read-only-posture.txt`    | `/posture\.json/`       | `null`         | `cat .claude/learning/posture.json` is a read — no mutation, no flag.              |

Detector source: `.claude/hooks/lib/violation-patterns.js::detectStateFileMutation`. Rule cross-reference: `rules/trust-posture.md` MUST NOT § "Edit `.claude/learning/posture.json` … directly via Edit/Write/Bash".
