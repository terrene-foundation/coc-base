# framework-first — governance bookkeeping

**This file carries the Trust-Posture Wiring, the rule-graph cross-references and the
Origin record for `.claude/rules/framework-first.md`. It is NOT a rule and states no new
obligation — every MUST and MUST NOT token below RESTATES a clause that lives in the
rule, quoted so the Wiring fields can name what they bind.**

**Why it is here.** Claude Code injects every `.md` under `.claude/rules/` recursively at
launch; the skills tree is not injected. Governance bookkeeping is read by gate-review and
by the validators, never acted on mid-turn, so every session was paying for it. This tree
also SHIPS (`skills/32-trust-posture/**` is a distribution tier) and is already on the
self-referential allowlist, so consumers keep their Wiring and edits here still fire the
Tier-1 gate.

---

## Distinct From / Cross-References

**`rules/agents.md` § Specialist Delegation** — the specialist-consultation mandate is always-on there: consult the named specialist before any raw/primitive pattern (`zero-tolerance.md` Rule 4 otherwise). Moved here 2026-09-08 (headroom lane) out of § Raw Is Always Wrong. Obligation-NEUTRAL and MEASURED rather than assumed: `agents.md` § Specialist Delegation is a `priority: 0` baseline rule on the SAME lane, its consultation clause is present in that file's abridged emission, and its own opening line points BACK at this rule's domain table — so this line is rule-graph navigation, not a second copy of the obligation. The `framework-first` skill pointer deliberately STAYS in the body: `skills/…` pointers ship to consumers, and hiding one inside a stripped section to buy bytes is the same de-scoping the emitter refuses to do automatically. Same disposition `zero-tolerance.md` took 2026-09-02 and `agents.md` took 2026-09-07 for the `time-pressure-discipline.md` pointer.
