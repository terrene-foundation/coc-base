# recommendation-quality-packets — governance bookkeeping

**This file carries the Trust-Posture Wiring and the full-length rationale for
`.claude/rules/recommendation-quality-packets.md` (MUST-6). It is NOT a rule and states no new
obligation — every MUST and MUST NOT token below RESTATES a clause that lives in the rule.** The Why
paragraph moved verbatim from `.gemini/skills/32-trust-posture/wiring/recommendation-quality.md`
(context-budget workstream, 2026-10-10); the Wiring block below is new, clause-scoped to MUST-6, and its
facts are read from the rule-wide block in that file. The rule_id stays shared with
`rules/recommendation-quality.md`.

---

## Full Why paragraph

### MUST-6 (now in `rules/recommendation-quality-packets.md`)

**Why:** Withholding the recommendation under the banner of "the human decides" transfers the entire synthesis cost to the human — the exact MUST-1 failure, one indirection deeper. The human's decision authority is over the recommendation, not over a vacuum; even a deep question has a spec-closest answer the agent MUST recommend, naming the residual judgment (per MUST-1's "state which context would change the recommendation, not punt"). A decision packet remains an internal artifact — if escalated to a public/cross-repo surface it stays bound by `upstream-issue-hygiene.md` Rule 2 redaction.

## Trust Posture Wiring — MUST-6 (Decision Packets)

- **Severity:** `halt-and-report` — `.claude/hooks/decision-packet-guard.js` walks the written table structurally, but deciding which column is the answer column and whether a cell is a punt are prose matches, so the detector is capped at its weaker half (`hook-output-discipline.md` MUST-2); its `packet-row-indeterminate` state reports `advisory`. Gate-review by reviewer / cc-architect carries `halt-and-report`.
- **Grace period:** 7 days from 2026-05-18 (→ 2026-05-25).
- **Cumulative posture impact:** same-class violations (a decision packet presented with a blank or punted recommendation cell) contribute to `trust-posture.md` MUST Rule 4 cumulative-window math (5× total in 30d → drop posture), as the rule-wide block states for the family.
- **Regression-within-grace:** a blank-field decision packet authored within the grace window → emergency downgrade per `trust-posture.md` MUST Rule 4 through the GENERIC `regression_within_grace` trigger (1× = drop 1 posture) — no dedicated per-clause key.
- **Receipt requirement:** SessionStart `[ack: recommendation-quality]` (shared rule_id) IFF `posture.json::pending_verification` includes this rule_id — hard-gate, as the rule-wide block requires it.
- **Detection mechanism:** structural + review. `.claude/hooks/decision-packet-guard.js` (registered at `PostToolUse`/`Write` in `.claude/hooks/dispatch-registry.json`) runs the predicates at `.claude/hooks/lib/decision-packet.js` over the written markdown and reports `packet-answer-empty`, `packet-answer-punt` and `packet-row-indeterminate`; fixtures `.claude/audit-fixtures/decision-packet/`. It cannot see an Edit, a packet that stays prose in a chat reply, or the AUTHORSHIP half (a specialist-produced pick and an orchestrator guess are byte-identical in the file) — those remain gate-review by reviewer at `/implement` and cc-architect at `/codify`. **Probes: REGISTERED — `.claude/test-harness/probes/recommendation-quality-packets.probes.json`** (registered under the `recommendation-quality-packets` key in `.claude/test-harness/eval-manifest.json`); read the row/pair counts off the suite, never off this line.
- **Invoker class:** `runtime` AND `agent-mid-procedure`. `runtime` is backed by `.claude/hooks/decision-packet-guard.js`, registered at `PostToolUse`/`Write`, firing on every written packet with no command typed. `agent-mid-procedure` is the gate-review half — reviewer at `/implement` and cc-architect at `/codify` — and the probe pair, which executes only when an orchestrator dispatches `/test-harness-probe`; at an audience that surfaces neither command that half is REACHABLE-BUT-UNINVOKABLE.
- **Violation scope:** MUST-6 ("the human decides" means ratify a recommendation, not fill a blank) ONLY (clause-scoped).
- **Origin:** 2026-05-18 — a Rust SDK blank founder packet; self-referential `/codify` per `self-referential-codify.md` Rule 2 (the family Origin line in `.gemini/skills/32-trust-posture/wiring/recommendation-quality.md`; incident narrative in `.claude/guides/rule-extracts/recommendation-quality.md` § MUST-6).
