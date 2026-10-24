# session-notes-continuity — governance bookkeeping

**This file carries the Trust-Posture Wiring and the Origin record for
`.claude/rules/session-notes-continuity.md`. It is NOT a rule and states no new obligation — every
MUST and MUST NOT token below RESTATES a clause that lives in the rule, quoted so the Wiring
fields can name what they bind.** Moved verbatim from the rule body (context-budget workstream,
2026-10-10); the rule keeps every clause, BLOCKED corpus and `**Why:**` inline.

**Why it is here.** Claude Code injects every `.md` under `.claude/rules/` recursively at
launch; the skills tree is not injected. Governance bookkeeping is read by gate-review and
by the validators, never acted on mid-turn, so every session was paying for it. This tree
also SHIPS (`skills/32-trust-posture/**` is a distribution tier) and is already on the
self-referential allowlist, so consumers keep their Wiring and edits here still fire the
Tier-1 gate.

---

## Trust Posture Wiring

- **Severity:** `block` at the hook layer for MUST-2 ONLY — a `limit`/`offset` parameter on a
  Read of a continuity artifact is read directly off the tool call, an irrefutable STRUCTURAL
  fact and not a lexical or heuristic inference, which is the narrow class
  `hook-output-discipline.md` MUST-2 reserves `block` for. `halt-and-report` at the hook layer
  for MUST-1 (read ORDER is inferred from per-session state, not a structural property of the
  call) and `advisory` for MUST-3 (blocking a write would strand the content being organised).
  `halt-and-report` at gate-review: cc-architect at `/codify` + reviewer at `/implement` confirm
  a session that acted on continuity notes read a ROOT artifact first and read it whole.
- **Grace period:** 7 days from rule landing (2026-08-12 → 2026-08-19).
- **Cumulative posture impact:** same-class violations (acting on a workspace narrative before
  any root continuity artifact was read; a truncated continuity read; a continuity artifact
  written past the 300-line ceiling with no named overflow pointer; a DERIVED PROJECTION
  hand-trimmed to fit a ceiling; a projection emitted past a declared ceiling instead of refused;
  an append-only log placed on a `.session-notes*` path) contribute to
  `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5×
  total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the grace window routes through the
  GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1
  posture) — NO dedicated per-clause trigger key. Named deviation from the canonical
  key-per-clause shape, recorded here per `trust-posture.md` Rule 8: MUST-2 already carries a
  structural `block`, so a per-clause instant-drop key would double-count the one clause that
  cannot silently pass, while MUST-1 and MUST-3 are judgment-bearing and do not warrant one.
  Minting a key would additionally drag `trust-posture.md` — a `self-referential-codify.md`
  allowlist file — into a self-referential edit. Same disposition `security.md`
  § Enforcement-Surface Parity and `git.md` § CI-check/merge took.
- **Receipt requirement:** SessionStart soft-gate `[ack: session-notes-continuity]` IFF
  `posture.json::pending_verification` includes the `session-notes-continuity` rule_id.
- **Detection mechanism:** structural at loom; consumer delivery remains incomplete. The detector is
  `.claude/hooks/session-notes-guard.js`, registered at `PreToolUse:Read` (MUST-1 + MUST-2) and
  `PostToolUse:Edit|Write` (MUST-3); every branch fails OPEN and a `cc-artifacts.md` Rule 7
  timer bounds it. Its fixtures ship WITH it per `cc-artifacts.md` Rule 9 at
  `.claude/audit-fixtures/session-notes-continuity/`, one case per scope-restriction predicate,
  registered in `.claude/test-harness/ci-audit-fixtures.json` so they RUN in CI rather than sit
  unwired. **What that detector does NOT cover, stated as gaps rather than implied covered:**
  `decideCeilingAdvisory` (`session-notes-guard.js`, PostToolUse `Edit|Write`) does not exempt or
  specially handle a projection, and it ADVISES rather than refuses; and nothing structurally
  prevents a log being created on a `.session-notes*` path — the placement is held by this rule and
  by `.claude/hooks/lib/burndown-events.js::EVENTS_REL` being a constant, not by a check. Both are
  gate-review-only at cc-architect `/codify`.
  MUST-3's projection ceiling is DECLARED at `burndown-manifest.json::tracker.max_rows`, resolved by
  `session-notes-layout.js::_resolveProjectionCeiling`, which reports whether the value was declared
  or fell back. And the generator REFUSES past it: `regenerateForestLedger` returns
  `{ok:false, error:"projection ceiling exceeded", …}` when rendered rows or lines exceed their ceilings,
  leaving the projection on disk UNCHANGED and truncating nothing, with the refusal citing this
  rule's MUST-3 by name in the source. It refuses in **BOTH** modes — the check arm is gated on the
  same branch, because an `in_sync: true` over an over-ceiling projection would certify the breach as
  healthy (`.claude/hooks/lib/session-notes-layout.js::regenerateForestLedger`). So MUST-3's projection ceiling has
  a structural tier at loom through `forest-ledger-project`. At consumer targets awaiting delivery
  of that command, enforcement remains
  gate-review. What remains gate-review-only even where the command is present
  is the hand-trim half and the log-placement MUST NOT named above. **Semantic tier: REGISTERED —
  `.claude/test-harness/probes/session-notes-continuity.probes.json`**, 10 rows in 5 bipolar
  `pair_id` pairs: one firing pair per derived clause (MUST-1, MUST-2, MUST-3, MUST NOT), each
  carrying BOTH a violation and a compliant pole, plus a surface-equalized meta-compliance pair.
  Candidates + answer-key sidecars sit at `.claude/audit-fixtures/session-notes-continuity/`,
  beside the structural runner already there. This is the tier `session-notes-guard.js` cannot
  reach: the guard decides ONE tool call, whereas a judge reads whether the SESSION carried the
  directive forward — whether a narrative was acted on before any root artifact was opened, and
  whether a standing directive was written off against a narrative's silence. MUST-2 is the
  exception and its pair is built to respect it: the truncation parameter is a structural fact
  off the call, so the violation pole IS the windowed read, not a judgment about one.
  Registration buys DISPATCHABILITY, never automatic execution: no workflow invokes
  `coc-probe-dispatch.mjs`, and the loom↔csq boundary keeps CI LLM-free, so a green CI run is
  NEVER evidence these probes passed — they execute only when an orchestrator dispatches
  `/test-harness-probe --artifacts` at gate-review.
- **Violation scope:** rule-corpus-wide (MUST-1 + MUST-2 + MUST-3, including MUST-3's
  derived-projection bound, and the three MUST NOTs, including the log-placement one). Each
  `violations.jsonl` row names the artifact path and which clause it breached, and for a
  projection row whether the failure was a hand-trim or an unrefused ceiling overrun.
- **Origin:** See § Origin.

Origin: 2026-08-12 — `/sync-from-use` Rust-template ingest of a downstream-relayed proposal.
First-hand read-order and truncation evidence: full examples companion § Initial Origin Evidence.
Prose alone was known-insufficient before this rule was written: the directive the offer protects
already existed at the relaying template and was still not read, which is the argument for the
paired structural hook rather than a fourth MUST clause.

**MUST-3 derived-projection bound + the log-placement MUST NOT — 2026-08-23**, per the
operator-ratified (loom-internal reference)
(C4, T5). MEASURED at ratification and re-measured here: `.session-notes.shared.md` is 291 lines /
269 rows against MUST-3's 300-line ceiling — 97% consumed, ~9 rows from breach — and
`decideCeilingAdvisory` does NOT exempt the ledger kind. MUST-2's `block` teeth are UNCHANGED and
deliberately not weakened; the log was placed off this namespace precisely so neither MUST-2 nor
MUST-3 fires on it, and the new MUST NOT is what keeps that placement a rule rather than a habit.
This rule is MEASURED OFF the `self-referential-codify.md` allowlist (zero hits for
`session-notes-continuity` there against a control that returned hits for `knowledge-convergence`
on the same tree), so it is Tier-2. `rule-authoring.md` Rule 10 does not fire — this rule is
`priority: 10` / `scope: path-scoped`, and Rule 10 § "Trigger scope" binds `priority: 0` +
`scope: baseline` only.
