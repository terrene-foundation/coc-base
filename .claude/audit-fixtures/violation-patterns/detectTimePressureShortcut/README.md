# detectTimePressureShortcut audit fixtures

Per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4. The detector has TWO modes — `mode: "input"` (UserPromptSubmit framing detection) and `mode: "response"` (Stop-event procedure-drop detection). Both modes return `null` (no flag) or a violation object with `severity: "advisory"` (lexical-only, per `hook-output-discipline.md` MUST-2).

| Fixture                                 | Mode       | Expects    | Predicate locked                                                                                                                                                                          |
| --------------------------------------- | ---------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flag-input-speed-up.txt`               | `input`    | `advisory` | "speed it up" in user prompt → flag (MUST-1)                                                                                                                                              |
| `flag-input-deadline-looming.txt`       | `input`    | `advisory` | "deadline is looming" in user prompt → flag (MUST-1)                                                                                                                                      |
| `flag-input-skip-validation.txt`        | `input`    | `advisory` | "skip the validation" in user prompt → flag (MUST-1)                                                                                                                                      |
| `clean-input-speed-up-tests.txt`        | `input`    | `null`     | "speed up the test suite" — regex anchor `\bspeed (this\|it\|things) up\b` is intentionally tight; "speed up THE/A/N" form is clean. Locks the predicate against future regex relaxation. |
| `clean-input-disk-space.txt`            | `input`    | `null`     | "running out of disk space" (resource framing, not time framing)                                                                                                                          |
| `clean-input-calendar-deadline.txt`     | `input`    | `null`     | "the customer demo deadline is March 15" (calendar reference w/o pressure tone)                                                                                                           |
| `flag-response-skipping-redteam.txt`    | `response` | `advisory` | "skipping /redteam this cycle" without parallelization anchor → flag (MUST-2)                                                                                                             |
| `flag-response-no-verify.txt`           | `response` | `advisory` | "Committing with --no-verify to bypass" without anchor → flag (MUST-2)                                                                                                                    |
| `flag-response-defer-the-fix.txt`       | `response` | `advisory` | "defer the fix to a follow-up issue" without anchor → flag (MUST-2)                                                                                                                       |
| `clean-response-parallelize-anchor.txt` | `response` | `null`     | "instead I propose to parallelize the work" cancels procedure-drop language                                                                                                               |
| `clean-response-prioritize-anchor.txt`  | `response` | `null`     | "Recommend a prioritized list for your gate" cancels procedure-drop language                                                                                                              |
| `clean-response-no-drops.txt`           | `response` | `null`     | "Tests pass, regression added, /redteam complete" — no procedure-drop language                                                                                                            |

Severity is always `advisory` for flagged inputs — lexical regex match, per `hook-output-discipline.md` MUST-2 (severity:block requires structural signal). Mode-specific behavior:

- `mode: "input"` findings PRIME the agent (additionalContext injected on UserPromptSubmit) — they do NOT log a violation. The framing is the trigger; the violation is the agent's procedure-drop response.
- `mode: "response"` findings ARE logged to `violations.jsonl` as advisory. Cumulative tracking; trust-posture downgrade per `rules/trust-posture.md` MUST Rule 4 (5× total in 30d, OR 1× emergency-trigger `time_pressure_procedure_drop` → drop 1 posture).

Origin: 2026-05-07 — `rules/time-pressure-discipline.md` wired into UserPromptSubmit (input framings) and Stop (response procedure-drop) per user directive: when pressure framings surface, agent rashly drops procedures (skip /redteam, --no-verify, defer fixes). Structural defense: parallelize, don't shortcut.
