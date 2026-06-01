# Proximity-Band Named-Rationale Exception Template

Procedural depth-file for `.claude/rules/rule-authoring.md` MUST Rule 10 path (b) — named-rationale budget exception in the proposal's receipt journal. Extracted from Rule 10's body (F23b paired extraction, 2026-05-23, `journal/0147`) so Rule 10's neutral-body stays compact; the template detail lives here.

## When Path (b) Is Available

Rule 10 fires when a baseline-priority rule (`priority: 0` + `scope: baseline`) gains NEW load-bearing content while a CLI lane is within 15% of its headroom floor. The proposal MUST take one of two paths:

- **Path (a) paired extraction** — recovers ≥ the bytes added on the lane-of-concern's emission. Requires only verifiable byte recovery.
- **Path (b) named-rationale budget exception** — adds net bytes to a near-breach lane. Requires the structured rationale enumerated below.

Path (a) is preferred; path (b) is the escape valve when no decomposable sub-content exists.

## Mandatory Sub-Fields For Path (b)

When the proposal uses path (b), the receipt journal's exception section MUST contain ALL FIVE of:

| #     | Sub-field                                     | Required content                                                                                                                                                        |
| ----- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (i)   | Bytes added on lane-of-concern                | The exact byte count from `emit.mjs --dry-run` output, cited verbatim.                                                                                                  |
| (ii)  | Lane-of-concern headroom_pct                  | Both pre-proposal AND post-proposal, both numeric (e.g., "10.64% → 9.99%").                                                                                             |
| (iii) | Calendar/horizon constraint                   | The next baseline-MUST addition's expected timeline (e.g., "no other CRIT-class rule additions planned within 14 days").                                                |
| (iv)  | F23b escalation surface                       | What WILL fire if the same (rule, CLI) lane needs another extraction or exception within 30 days (cite `rule-authoring.md` MUST Rule 11).                               |
| (v)   | Absence-of-skill-extension-host justification | Why the addition CANNOT be extracted to ANY existing or new skill sub-file — name the candidate hosts that were considered and the structural reason each was rejected. |

Missing any of (i)–(v) is BLOCKED. The cc-architect mechanical sweep at `/codify` validates field presence per Rule 10 Trust Posture Wiring.

## Example Exception Section (Path (b))

```markdown
## F23 proximity-band exception (path (b) — named-rationale budget exception)

(i) Bytes added on lane-of-concern: 412B added to codex rs (verbatim from `emit.mjs --all --dry-run --lang rs`).
(ii) Lane-of-concern headroom_pct: codex rs 10.64% → 9.99%.
(iii) Calendar/horizon constraint: no other CRIT-class rule additions are
planned within 14 days; v6.2 spec freeze is in effect through 2026-06-15.
(iv) F23b escalation surface: if codex rs needs another extraction within
30 days, `rule-authoring.md` MUST Rule 11 fires and escalates to
corpus-level pruning review per F23b.
(v) Absence-of-skill-extension-host: this MUST clause codifies a CVE-class
vulnerability in a single load-bearing prohibition; no decomposable
sub-content. Considered hosts: - `.claude/skills/18-security-patterns/` — rejected because the skill
is reference-style guidance, not authoring discipline. - `.claude/skills/skill-authoring/` — rejected because the clause
codifies a security boundary, not skill-authoring discipline. - new skill — rejected because a single-clause skill has worse
progressive-disclosure shape than an inline rule clause.
```

## Why Path (b) Requires The Structured Rationale (Where Path (a) Does Not)

Path (a) trades bytes for bytes — the audit trail is the dry-run byte delta itself, verifiable mechanically. Path (b) adds net bytes to a near-breach lane on the strength of a structural-necessity claim. Without the 5-sub-field structure, "named rationale" becomes a rubber stamp that any future addition can cite. The sub-fields convert the claim into auditable contract:

- **(i)+(ii)** make the cost explicit and measurable post-hoc.
- **(iii)** binds the exception to a finite calendar window — an exception "for the foreseeable future" defeats the gate.
- **(iv)** ensures the next near-breach event has a structural fallback (F23b) rather than another open-ended exception.
- **(v)** forces the author to demonstrate they searched for a decomposition; "we couldn't think of one" without enumerating candidates is BLOCKED.

## BLOCKED Rationalizations For Path (b)

- "The addition is small (~100B), the sub-fields are bureaucratic"
- "Sub-field (v) is overcomprehensive; nobody enumerates rejected hosts"
- "The 14-day horizon is arbitrary; the exception should be open-ended"
- "Path (b) is for genuine emergencies; standard structure doesn't apply"
- "We'll add the sub-fields if the cc-architect sweep flags it"

**Why:** The structured rationale IS the path (b) gate. Each missing sub-field is one closed audit surface. cc-architect's mechanical sweep is the load-bearing check; missing sub-fields are not "polish issues" but the rule's substance.

## Rule 11 Sub-Field (vi)

When `.claude/rules/rule-authoring.md` MUST Rule 11 fires AND the proposal takes disposition (b') — named-rationale exception on a 2nd Rule-10-mandated invocation on the same (rule, CLI) lane within 30 days — the exception MUST contain a 6th sub-field beyond (i)–(v) above:

| #    | Sub-field                                               | Required content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (vi) | Recurrence justification with anti-tautology constraint | Three elements ALL required: (vi.a) verbatim citation of the prior Rule-10-mandated invocation's journal entry (path + § marker + sentence quote — NOT just path), (vi.b) a structural-necessity claim that does NOT re-cite the prior invocation as its own authority (tautological self-reference is BLOCKED), and (vi.c) an explicit statement of why disposition (a') corpus-level review was REJECTED (split / demote / skill+pointer / per-CLI emission strategy change), naming at least one of the four corpus-level dispositions considered and why it was rejected. |

**BLOCKED rationalizations for (vi):**

- "The prior invocation proves this rule needs another exception" (tautological self-reference; violates (vi.b))
- "Rapid-iteration on this rule is itself the rationale" (recurrence IS the signal Rule 11 escalates; violates (vi.b))
- "The prior journal entry's named-rationale generalizes to this one" (named-rationale is per-invocation; violates (vi.b))
- "Path (a') is structurally heavier so (b') is the obvious pick" (violates (vi.c) — must name which corpus-level disposition was considered, not deflect)
- "Corpus-level review is for next session" (defers without naming the rejected disposition; violates (vi.c) + `value-prioritization.md` MUST-2)

**Why sub-field (vi) is structurally distinct from (i)–(v).** Sub-fields (i)–(v) gate path (b) on first-invocation correctness (sizing, scoping, alternative-host enumeration). Sub-field (vi) gates path (b') against the FM-A escape-valve-as-default pattern — every cycle that takes (b') without (vi.b) anti-tautology + (vi.c) corpus-disposition-rejection-named, the corpus normalizes "extraction-or-exception is the standard cycle" and Rule 11's escalation surface decays into wallpaper. The structural defense is forcing the author to engage the corpus-level alternative explicitly, not just re-anchor on the prior invocation.

## Cross-References

- `.claude/rules/rule-authoring.md` MUST Rule 10 — the proximity-band admission gate this template instantiates.
- `.claude/rules/rule-authoring.md` MUST Rule 11 — the 2nd-extraction escalation that fires when path (b') (or path (a')) is invoked on the same (rule, CLI) lane twice within 30 days.
- `.claude/rules/trust-posture.md` MUST Rule 8 — the canonical 8-field Trust Posture Wiring template; Rule 10's Wiring section anchors to this. MUST Rule 4's emergency-trigger list contains `proximity_band_admission_bypass` (Rule 10) AND `recurrent_extraction_escalation_bypass` (Rule 11).
- `.claude/rules/value-prioritization.md` MUST-2 + MUST-4 — Rule 11 disposition (a') corpus-review forest items MUST carry user-anchored value-anchor (Rule 11's "Forest-item composition" § sub-element (iv)).
- `journal/0146` — F23a closure receipt; first Rule-10 invocation cycle.
- `journal/0147` — F23b closure receipt; structural-cleanup extraction record.
- `journal/0148` — F23b mid-cycle amendment confirming `rule-authoring.md` is path-scoped (Rule 10 does NOT fire on F23b's own codify; the extraction is preserved as structural-cleanup improvement).

## Origin

Extracted 2026-05-23 from `rule-authoring.md` Rule 10's body (the verbose "Named-rationale exception — MANDATORY sub-fields" paragraph) as F23b's structural-cleanup improvement (initially framed as Rule 10 path (a) compliance — corrected mid-cycle by `journal/0148` after measurement showed `rule-authoring.md` is `priority: 10` + `scope: path-scoped` and does not contribute to baseline emission). The extraction is preserved as the right architectural shape regardless: `cc-artifacts.md` Rule 2 progressive disclosure + `agents.md` precedent (procedural depth in skill depth-files). Rule 11 sub-field (vi) added 2026-05-23 per multi-agent redteam R1 findings (security-reviewer S-M3 + analyst FM-A converged on tautology surface); see `journal/0149` § R1 disposition for the full review chain.
