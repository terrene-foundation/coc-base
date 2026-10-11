---
priority: 10
scope: path-scoped
cli_delivery: skill-channel
paths:
  - "**/todos/**"
  - "**/specs/**"
  - "**/briefs/**"
  - "**/.session-notes*"
  - "**/.session-notes.d/**"
---

# Completion Criterion — Done Is A Stated List Reached, Never An Absence Of Findings

Verification that stops on "no findings this round" ALONE cannot bound itself: findings are inexhaustible and each round samples a different slice — so the stop is a DESIGNED bound (D237-aligned: Round 1 is a full review and **Round 1 clean = review ends**; not clean → fix, then Round 2 reviews ONLY the fixes plus their blast radius, then review ends; one extra Round 3 only for a small security-critical fix's delta; never a Round 4). What bounded review was HUMAN COST — reviewers tire and bill hours — so it self-limited and nobody designed a bound. Agent review has near-zero marginal cost and never tires, so an unbounded loop runs forever **on genuinely real findings**. Same mechanism explains surface-explosion: if done is an absence, every capability added moves done further away.

**TWO AXES — do not conflate them.** The termination half of this rule (WHEN REVIEW ENDS) is D237-aligned 2026-10-08. A clean round ends the REVIEW; it never closes items. ITEM completion is a different axis: done is a stated list reached, each item evidenced as walked, never the absence of findings — so "Round 1 clean" must never be read as "the work is done".

**ALL depth — evidence, citations, worked DO/DO-NOT blocks, full BLOCKED corpora, refuted approaches, § "Searched for and NOT found" — is in `.claude/skills/30-claude-code-patterns/completion-criterion-evidence.md`, where every `MUST-N` anchor resolves. Read it before proposing ANY change to a convergence criterion, round count, adaptive-review scheme, or "done" definition.** Method spec: `specs/methodology/bounded-verification.md`.

## MUST Rules

### 1. The Acceptance List Is Written BEFORE Verification, Ratified, Gated By CATEGORY

A durable acceptance list MUST exist before any verification effort: per-item criteria two readers evaluate identically, plus a fixed ≤10-item definition-of-done (obligations unmeetable every cycle move to a RELEASE gate). It **MUST NOT be self-authored by the party that will satisfy it** — a distinct party (human, or a gate-review agent with no stake) authors or ratifies it, proportionate to category. Gating is by **CATEGORY** (`product-completion-first.md` MUST-1's fail-closed `BUG`/`INVEST-NOW`/`INCREMENTAL` classifier) — never by user-visibility, never by severity (severity ranks; severity-as-gate is BLOCKED there and here). Deriving the acceptance surface per-round from what review surfaced is BLOCKED. **Fail-closed:** ambiguous membership resolves ON-LIST.

**Why:** a criterion derived from what review surfaces is a running total, not a criterion; a self-authored one is gamed at declaration time, after which every later check passes honestly.
### 2. Converge Only On The Gating Half; Everything Else Gets A Budget

**`BUG`/`INVEST-NOW`/on-list** → converge under D237's stop rule (D237-aligned, 2026-10-08): Round 1 is a full review, and **Round 1 clean = review ends**; not clean → fix, then Round 2 reviews ONLY the fixes plus their blast radius (callers of changed code, same-class sibling sites — a change to a shared callee voids evidence at every call site it reaches), with the SAME reviewer composition as Round 1, then review ends; one extra Round 3 only for a small security-critical fix's delta (same composition) — never a Round 4. **WHEN REVIEW ENDS, at any round, every remaining finding of ANY severity goes into the durable LEDGER** (tracked todos or issue tracker) per D237 rule 5 — none is dropped. **`INCREMENTAL` and off-list** → **budget, not convergence**, triaged with `product-completion-first.md` MUST-2's four defer conditions; does not gate. Applying convergence to the budgeted half, or relabelling a gating-half finding `INCREMENTAL` to escape it, is BLOCKED. **The adjudicator is not the authoring agent:** gate-review adjudicates disputed labels; the human owns escalation.

**Scope note (D237 rule 5(b) vs the category gate):** 5(b) does NOT override the gating half — a finding in the `BUG`/`INVEST-NOW` category is fixed in-cycle per `product-completion-first.md` MUST-2, and 5(b) covers non-gating classes only; an unfixed shipped-path bug labelled "does not affect landing" is a misclassification, never a landing authority. When the category is unclear it resolves INTO the gating half — the same fail-closed posture MUST-1 sets above.

**IMMINENCE is a third axis and notifies WITHOUT gating.** A finding LIVE in production AND actively exploitable, losing data, or serving a wrong answer is surfaced IMMEDIATELY and IN PARALLEL, not held to round end — and still does not gate. It routes to an incident lane, never onto the list.

**Does NOT loosen `zero-tolerance.md`.** Its Rules 1/2/3 classes stay ABSOLUTE and **never defer-eligible REGARDLESS of assigned category** — stronger than category membership and not dependent on it (its BUG allowlist does not plainly cover a compiler warning or deprecation notice). They sit in the converge half because Rule 1d puts them there.

**Why:** a convergence criterion over an unbounded set is not a criterion; splitting the set lets one half terminate while the other stays bounded and owned.
### 3. "Clean" = No CRITICAL/HIGH AND Every Reviewer Genuinely Ran — Round 1 Clean Ends The Review (D237-Aligned)

A round is **"clean"** when it has **no CRITICAL/HIGH finding**. **The evidence gate applies EVERY round: a reviewer counts only if it genuinely ran** — an errored, empty or timed-out review is **NO evidence: re-run it, never count it**. **Round 1 clean = review ends**, and there is no second clean round.

**Why:** "clean" is a claim about the artifact only when every counted reviewer genuinely ran; an errored or timed-out round counted as clean converts missing evidence into a pass.
### 4. Bounded Rounds Are The NORMAL Termination; A Residual CRITICAL/HIGH Goes To The Owner; The INSTRUMENT Rotates (D237-Aligned)

The rounds are BOUNDED and **review ends by design**: Round 1 is a full review; not clean → fix, then Round 2 reviews ONLY the fixes plus their blast radius, with the SAME reviewer composition as Round 1; then review ends. One extra Round 3 only for a small security-critical fix's delta (same composition); **there is never a Round 4**. **Bounded rounds are the NORMAL terminal state**; a residual CRITICAL/HIGH when review ends — after Round 2, or after Round 3 under 4a — is the abnormal case and goes to the OWNER, named with its open findings — never to another round. The budgeted half is bounded by **effort** (sessions, tokens, wall-clock) allocated by risk. **Iteration is non-monotone** (correctness 82.0%→67.3% rev 1→2; 16.0% of trajectories produce a correct patch then LOSE it by rev 3), so **a last-known-good state MUST survive every round**, recoverable when a later round degrades it. The **instrument MUST rotate** between rounds. The yield stop applies to the **budgeted half only**, measures NEW not open findings, and MUST name its falsifying result (`instrument-discipline.md` MUST-1).

**Why:** a designed bound makes termination a known condition rather than drift; and repeating one lens draws against the residue that lens already filtered.
### 5. Depth Conditions On ORACLE PRESENCE — Never On Model Capability

**Sound oracle** → primary verifier; review MAY shorten, **floored at one rotated round, never zero**. An oracle is sound FOR A PROPERTY only when the run was shown to RED in that property's absence (`instrument-discipline.md` MUST-2); "harness is green, so the oracle is sound" is BLOCKED. **No executable oracle** (prose rules, specs, config, governance artifacts) → adversarial review is the ONLY channel and runs at FULL depth — **MORE review than tested code, not less**. **Security / trust-bearing** (auth, signing, revocation, tenant isolation, fail-closed gates, kill paths, destructive ops, disclosure, and ANY trust boundary — including credentials, redaction, rate limiting, path containment and tenant-scoped cache keys; illustrative, not exhaustive; **when unclear, treat it as security-critical**) → **paired round 1: correctness + adversarial security, in parallel**, with 4a's delta-scoped Round 3 at most — **never reduced, never a Round 4**. **External signal ≠ human:** a **disjoint-context** reviewer (fresh session, no shared history) counts as external — a throughput tier, not an oracle. Conditioning on model identity, tier, or self-reported confidence is BLOCKED.

**Why:** a critic is redundant when it shares the generator's context and failure distribution — oracle presence tracks that, capability does not; and locating one's OWN errors is the capability that has not improved.
### 6. The Residual Is ACCEPTED By A Named Human, With A Revisit Trigger And Calendar Backstop

Anything in the budgeted half shipping unfixed is a **residual** and is not self-accepting. It MUST be accepted by a **named human distinct from the agent**, resolving to a **standing role**, carrying `product-completion-first.md` MUST-2's four defer conditions (cited, not restated — `specs-authority.md` Rule 9) **plus a calendar backstop**, so an event trigger that never fires cannot park it forever. **No human reachable ⇒ NOT accepted** ⇒ surface as a PENDING DECISION; the deliverable is not done. **D237 rule 5(c) carve-out:** a small KNOWN RISK on a shipped path that is NOT security-critical (rule 1's class, including ANY trust boundary) and NOT HIGH/CRITICAL may be **PROVISIONALLY accepted by the agent, so the change can land** — it goes to the ledger as OPEN, with the risk stated plainly, and **STAYS OPEN** until a human either accepts it (named acceptor) or asks for the fix; the agent's acceptance never closes it. A **security-critical or HIGH/CRITICAL residual risk is NEVER provisionally accepted**: it follows (d), and needs the owner's acceptance BEFORE landing. **Landing is NOT the item being done** — the carve-out permits the landing, never a completion claim. **An accepted finding is a BET — logged, owned, revisitable — never a claim of harmlessness.** Pentest vocabulary, not audit's: audit materiality works because misstatements share one unit against one total; findings share no denominator.

**Why:** a residual with no name against it is indistinguishable from a defect nobody noticed; the backstop stops the bet becoming permanent.

**A DECLARED OMISSION IS A RESIDUAL, AND PROSE DISCHARGES NOTHING.** A gap named in prose — a code
comment recording what was deliberately NOT done, a `**Detection mechanism:**` row naming an unbuilt
detector, a header stating a known consequence — is a residual under this clause and carries its full
weight. SHIPPING it unbound is BLOCKED; three bindings discharge it, and **none substitutes for this
clause's named-human acceptance — each makes that acceptance OBSERVABLE**:

1. a dated row in `.claude/test-harness/phase2-deferrals.json` (the registry
   `phase2-deferral-integrity.mjs` reconciles) — **available ONLY for a residual attached to a RULE
   CLAUSE.** That registry is keyed `<rule-file>.md#<clause-slug>` and validates that `rule` resolves
   under `.claude/rules/` and that `quote` carries a Phase-2 token, so a declared omission in `bin/`,
   `hooks/lib/` or a test — where most of them will be — CANNOT use it and must take (2) or (3).
   MEASURED: a lane attempted exactly this row and the gate went PASS → FAIL on four counts. Note
   also that the registry REFUSES `accepted_by: null` in its own words — "a present-but-empty
   acceptor is accepted-by-absence ... strictly worse than an absent field because it reads as
   compliant" — so leaving the acceptor blank is not the owed-acceptance form; an unaccepted
   residual is a PENDING DECISION, not a row with a hole in it;
2. a test that REDS when the named consequence's PRECONDITION is reached; or
3. an acceptance recorded IN PLACE carrying what this clause already requires above — a named human
   resolving to a standing role, a revisit trigger, and a calendar backstop (or a RECORDED deviation
   from the backstop, as `security.md` § "Accepted residual" does).

This is a POSITIVE ALLOWLIST (`cc-artifacts.md` Rule 10): a discharge not on it is not one.

**THE BLOCK IS ON SHIPPING, NEVER ON WRITING — AND DELETING THE NOTE HIDES THE RESIDUAL RATHER THAN
DISCHARGING IT.** The obligation attaches to the GAP, not to the sentence describing it. Declining to
write, or removing, a comment that names a live consequence leaves the residual in force AND adds a
second violation: an undeclared gap no later reader can find. Where no human is reachable to accept,
MUST-6's existing exit applies unchanged — surface it as a PENDING DECISION and the deliverable is not
done. Silence is never the compliant path.

**OUT OF SCOPE — EPISTEMIC DISCLOSURE.** A statement about the CURRENT report's REACH — an instrument's
blind class, a STALE or UNANSWERED verdict, a named scope limit — is NOT a residual and binds nothing.
It is mandated elsewhere (`conservation-gate.md` MUST-3 requires naming what an instrument cannot see;
`instrument-discipline.md` MUST-1 and MUST-6(b) require reporting UNANSWERED and STALE), and reading it
as a declared omission would put this clause in direct conflict with rules it must compose with. The
discriminator is not phrasing: something DELIBERATELY NOT DONE that STILL BITES is a residual and is IN
scope; a statement about what this report could not see is not.

**GRANDFATHERED.** Residuals already recorded when this clause landed are NOT retroactively in
violation; each binds at its next `/codify`-touch — the cutoff shape `trust-posture.md` MUST-8 uses.
Enumerated at landing rather than implied: this rule's own § Detection-mechanism reachability residual,
and `security.md` § "Accepted residual — the three-phase TOCTOU is OPEN, not deferred". The latter
already satisfies binding (3) and is named because it explicitly argues a registry row is NOT owed,
which this clause must not silently overrule.

```markdown
# DO — the omission is named AND bound, in the same change.
# ILLUSTRATIVE: the binding forms are deliberately GENERIC. A concrete key or case name
# here would be a citation this rule's own mandate requires to resolve, and an exemplar
# resolving to nothing teaches the defect it forbids.
// <consequence, in one line>.
// Bound: phase2-deferrals.json::<key> (expires <YYYY-MM-DD>, accepted_by <named human>)
//   OR  <suite>.test.mjs::"<case that REDS when the precondition is reached>"
//   OR  an in-place acceptance naming acceptor + revisit trigger + backstop.

# DO NOT — the consequence named, nothing bound, shipped
// We deliberately do NOT copy stranded-artifact-guard's {unavailable:true} discrimination,
// so a claim about the HOST is read as a claim about the REPOSITORY.
```

**BLOCKED rationalizations:**

- "It is documented, so the next reader will know"
- "The comment names the consequence precisely; that is the record"
- "Writing it down is better than saying nothing"
- "A registry row for a comment is bureaucracy"
- "The header already explains why we did not do it"
- "It is a known limitation, not a defect"
- "Whoever touches this next will see the note"
- "Better to say nothing than to book an obligation I cannot pay"
- "Removing the comment removes the residual"
- "If I don't write it down, it isn't a declared omission"
- "I'll leave it undocumented and fix it properly later"

**Why:** a documented omission is worth full credit at review time and ZERO at runtime, so it is the cheapest possible substitute for a fix and the one least likely to be challenged. The in-class instance measured at landing: the `WHAT THIS DOES NOT COPY FROM stranded-artifact-guard.js` block in `wip-lanes.js` (`:450-456`) recorded a missing discrimination AND its consequence, shipped, and that consequence then silently disabled a MUST-7 enforcement — per-instance detail, the three NEIGHBOURING false-compliance-claim cases this clause does NOT reach, and why write-time binding is the load-bearing moment: the paired evidence skill § "MUST-6 — declared omissions".

## MUST NOT

- Declare done on the ABSENCE of findings rather than a stated list reached — **Why:** unreachable by construction over an inexhaustible set.
- Derive the acceptance surface at verification time from the artifact under review — **Why:** it then grows with rounds spent, so more verification makes completion less reachable.
- Let the party that will satisfy a criterion author it unratified — **Why:** gamed at declaration time; every later check passes honestly.
- Count a round "clean" without the evidence gate — **Why:** an errored, empty or timed-out review then reads as a pass — missing evidence converted into a clean end.
- Record review ending with residual CRITICAL/HIGH as clean — **Why:** bounded rounds are NORMAL, but a residual CRITICAL/HIGH goes to the owner; calling it clean ships it under a converged banner.
- Reduce depth on model capability, identity, or self-reported confidence — **Why:** the least-supported discriminators available.
- Scope the list to user-visible behaviour, or gate on severity rank — **Why:** the least-visible classes most warrant gating, and severity-as-gate is independently BLOCKED by `product-completion-first.md` MUST-1.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/redteam` + cc-architect at `/codify` run the Detection checks below); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 (semantic judgment over session history; no structural tool-call signal).
- **Grace period:** 7 days from rule landing (2026-08-02 → 2026-08-09). The MUST-6 DECLARED-OMISSION half added 2026-09-11 opens its OWN 7-day window (2026-09-11 → 2026-09-18), per the clause-scoped-extension shape `security.md`, `agents.md`, `instrument-discipline.md` and `zero-tolerance.md` § Rule 3e all use; without it the new obligation would be live with zero grace and `regression_within_grace` would have no window to key on.
- **Cumulative posture impact:** same-class violations contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated key (a review-layer semantic judgment; minting one would drag `trust-posture.md`, a `self-referential-codify.md` allowlist file, into a self-referential edit). Named deviation per `trust-posture.md` Rule 8 — same disposition `orchestration-launch-ledger.md` + `security.md` § Enforcement-Surface Parity took.
- **Receipt requirement:** SessionStart soft-gate `[ack: completion-criterion]` IFF `posture.json::pending_verification` includes the `completion-criterion` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — confirm **(a)** a ratified durable list predates round 1; **(b)** when review ended, every remaining finding was LEDGERED per D237 rule 5 — none dropped, no ambiguous finding resolved out of the gating half; **(c)** the evidence gate was met every round — every counted reviewer genuinely ran, and no errored / empty / timed-out return was counted clean; **(d)** depth cited oracle presence, not capability; **(e)** the reviewer INDEPENDENTLY derives an acceptance surface from the spec/brief and reports every item absent from the authored list — any absence is a finding (without (e) the check cannot discriminate a narrow list from an honest one); **(f)** every trust-bearing surface took the paired round 1 (correctness + adversarial security), never reduced; **(g)** no review end with residual CRITICAL/HIGH recorded as clean, and a last-known-good survived. **Reachability residual, measured and recorded rather than papered over:** gate-review is the only detector, and the `paths:` set is NARROWER than this rule's subject warrants. `**/workspaces/**` and `**/journal/**` were authored, then REMOVED, for a measured reason: the `workspace-note` injection profile (probe path `workspaces/example/journal/0001-x.md`, matched by BOTH globs) sat at 218736 B against a 216904 B budget BEFORE this rule — already 100.8% — so adding a 14 KB rule there exceeded the +5% ceiling by ~5 KB even after full paired extraction to the skill. The honest consequence: a session that edits ONLY `workspaces/**` or writes ONLY a `journal/` close-out receipt does NOT load this rule. What remains covers the two moments that matter most — `**/todos/**` (where the acceptance list is authored) and `**/.session-notes*` + `**/.session-notes.d/**` (where the completion claim is written). This is a CORPUS-SATURATION residual, not a scoping judgment: the profile cannot absorb a new rule of normal size until an existing oversized one is extracted (the checker names `multi-operator-coordination.md` at 19022 B and `user-flow-validation.md` at 16107 B as broad-load #678-giant-class rules firing in EVERY profile). Restoring the two globs is the correct fix once that headroom exists, and is BLOCKED on it — not on a judgment about this rule's scope. Scanner: none (semantic). Fixtures `.claude/audit-fixtures/completion-criterion/` — 6 files in 3 bipolar pairs (MUST-1; MUST-3/4; meta-compliance) = `coc-artifact-eval-coverage.md` MUST-1's per-PROPERTY mandate, NOT one pair per MUST; MUST-2/5/6 ride gate-review plus the surfaces those pairs exercise. Probes `.claude/test-harness/probes/completion-criterion.probes.json` (6 rows, `scanner: null`) via `/test-harness-probe`, NOT in CI (the loom↔csq boundary keeps CI LLM-free); pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`. **Deferred probe authorship — requests PENDING, NOT accepted (expire 2027-01-06; no registry row lands until a human drains them):** `.claude/test-harness/probes/completion-criterion-evidence.probes.json`, `.claude/test-harness/probes/cc-architect.probes.json`, `.claude/test-harness/probes/release.probes.json`, `.claude/test-harness/probes/reviewer-agent.probes.json` — the D237-mirror artifacts these would cover (paired extract, cc-architect, release, reviewer agent) have no per-artifact suite yet. **Phase 2 is RETIRED, not pending (2026-09-11): no `Stop` detector will EVER be built**, and no fixtures are owed for one. Every check (a)–(g) above turns on semantic adequacy, not on any observable event: whether a list was RATIFIED and PREDATES round 1 is a claim about authority and ordering that no tool call records; whether convergence covered every GATING-half finding requires classifying each finding; (e) requires a reviewer to INDEPENDENTLY derive an acceptance surface from the spec and diff it against the authored one, which is the generation of a second judgment, not the reading of a signal; and (g) turns on whether review ended with residual CRITICAL/HIGH or clean. The block already says `Scanner: none (semantic)` for the same reason. `hook-output-discipline.md` MUST-2 forbids `block` on a lexical signal and `rule-authoring.md` MUST NOT § "`**Detection mechanism:**` row filing `Phase 2 (deferred)`" names booking such a detector as teeth that cannot arrive. Gate-review plus the registered probe suite ARE the enforcement layers here, permanently. The REACHABILITY residual recorded above is NOT retired and is unaffected: it is a `paths:`-budget problem with a named unblocking condition, not an undecidable property.
- **Violation scope:** MUST-1 (no list; visibility-scoped; severity-as-gate; self-authored unratified) + MUST-2 (review run past its end; a live-incident finding held to round end) + MUST-3 (a reviewer counted without the evidence gate; a second clean round demanded) + MUST-4 (rounds run past review end — never a Round 4; non-rotating instrument; review ending with residual CRITICAL/HIGH reported as clean; discarded last-known-good) + MUST-5 (depth on capability; a trust-bearing surface reduced, incl. via ambiguous classification; suite-level green as sound oracle) + MUST-6 (residual with no named acceptor, missing trigger or backstop, or accepted-by-absence; AND a gap declared in prose — a code comment, a Wiring row, a header — that resolves to no dated registry row, no test that reds on the named consequence, SHIPPED with none of the three bindings; OR a known gap left UNDECLARED, or a note deleted, to avoid this clause. Epistemic disclosure is out of scope, and residuals recorded before the clause landed are grandfathered until next touched).
- **Origin:** See § Origin.

## Distinct From / Cross-References

**Bounded by** `zero-tolerance.md` Rule 1d (enumerated classes never defer-eligible; this bounds only the residue Rule 1d scopes out). **Composes with** `product-completion-first.md` MUST-1/2/3 — its **MUST-1** owns the classifier AND the fail-closed resolution (MUST-2 = defer conditions, MUST-3 = warm-same-class lane); it feeds this rule, it does not bound the loop. **Distinct from** `wave-loop.md` MUST-1 bound B (bounds the invariant SURFACE; this bounds ITERATIONS over it). **Extends** `agents.md` § "Correctness-Review-Clean Is Not Security-Clean" as depth allocation. **Binds** `instrument-discipline.md` MUST-1/2 at the round boundary — rotation is worthless if the rotated instrument cannot discriminate.

## Origin

2026-08-02 — co-owner-directed origination (`artifact-flow.md` § Co-Owner-Directed Origination). A `/redteam` loop ran ~50 rounds without converging; the hypothesis that polish findings reset the counter was TESTED AND FALSIFIED — zero of seven headline findings were incremental, genuine bugs still at rounds 8/10/11. Convergent independent origination at **loom#1528**, adversarially reviewed downstream, contributed MUST-1's ratification clause, MUST-2's imminence axis, MUST-4's last-known-good + instrument rotation (its circuit-breaker stop framing was superseded by D237, 2026-10-08), MUST-6, and the pentest-not-audit vocabulary. Evidence, the 20-surface corpus survey, refutations, and the three premises that did NOT survive (user-visibility scoping; capability-conditioning; severity-as-gate — the last would have contradicted `product-completion-first.md` MUST-1): the paired skill.

**Paired extraction performed at authoring time, not deferred** — the `workspace-note` injection profile measured 218736 B against a 216904 B budget BEFORE this rule (100.8%), so the un-extracted 39 KB draft exceeded the +5% ceiling by 30 KB. That the corpus grows monotonically while its relief valve is near-exhausted is the SAME unbounded-growth-without-a-designed-bound failure this rule names.
