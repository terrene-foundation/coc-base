---
id: "COMPLETION-CRITERION"
paths: ["**/todos/**", "**/specs/**", "**/briefs/**", "**/.session-notes*", "**/.session-notes.d/**"]
---

# Completion Criterion — Done Is A Stated List Reached, Never An Absence Of Findings

Verification that stops on "no findings this round" cannot stop: findings are inexhaustible and each round samples a different slice. What bounded review was HUMAN COST — reviewers tire and bill hours — so it self-limited and nobody designed a bound. Agent review has near-zero marginal cost and never tires, so the loop runs forever **on genuinely real findings**. Same mechanism explains surface-explosion: if done is an absence, every capability added moves done further away.

**ALL depth — evidence, citations, worked DO/DO-NOT blocks, full BLOCKED corpora, refuted approaches, § "Searched for and NOT found" — is in `.claude/skills/30-claude-code-patterns/completion-criterion-evidence.md`, where every `MUST-N` anchor resolves. Read it before proposing ANY change to a convergence criterion, round count, adaptive-review scheme, or "done" definition.** Method spec: `specs/methodology/bounded-verification.md`.

## MUST Rules

### 1. The Acceptance List Is Written BEFORE Verification, Ratified, Gated By CATEGORY

A durable acceptance list MUST exist before any verification effort: per-item criteria two readers evaluate identically, plus a fixed ≤10-item definition-of-done (obligations unmeetable every cycle move to a RELEASE gate). It **MUST NOT be self-authored by the party that will satisfy it** — a distinct party (human, or a gate-review agent with no stake) authors or ratifies it, proportionate to category. Gating is by **CATEGORY** (`product-completion-first.md` MUST-1's fail-closed `BUG`/`INVEST-NOW`/`INCREMENTAL` classifier) — never by user-visibility, never by severity (severity ranks; severity-as-gate is BLOCKED there and here). Deriving the acceptance surface per-round from what review surfaced is BLOCKED. **Fail-closed:** ambiguous membership resolves ON-LIST.

**Why:** a criterion derived from what review surfaces is a running total, not a criterion; a self-authored one is gamed at declaration time, after which every later check passes honestly.
### 2. Converge Only On The Gating Half; Everything Else Gets A Budget

**`BUG`/`INVEST-NOW`/on-list** → converge, iterate to clean, **uncapped**. **`INCREMENTAL` and off-list** → **budget, not convergence**, triaged with `product-completion-first.md` MUST-2's four defer conditions; does not gate. Applying convergence to the budgeted half, or relabelling a gating-half finding `INCREMENTAL` to escape it, is BLOCKED. **The adjudicator is not the authoring agent:** gate-review adjudicates disputed labels; the human owns escalation.

**IMMINENCE is a third axis and notifies WITHOUT gating.** A finding LIVE in production AND actively exploitable, losing data, or serving a wrong answer is surfaced IMMEDIATELY and IN PARALLEL, not held to round end — and still does not gate. It routes to an incident lane, never onto the list.

**Does NOT loosen `zero-tolerance.md`.** Its Rules 1/2/3 classes stay ABSOLUTE and **never defer-eligible REGARDLESS of assigned category** — stronger than category membership and not dependent on it (its BUG allowlist does not plainly cover a compiler warning or deprecation notice). They sit in the converge half because Rule 1d puts them there.

**Why:** a convergence criterion over an unbounded set is not a criterion; splitting the set lets one half terminate while the other stays bounded and owned.
### 3. A Finding NEVER Resets The Counter — A CHANGE To The Affected Surface Does

The counter is **monotone under observation, resettable only under mutation**. **Touched surface = the diff PLUS its transitive consumers**: a change to a shared callee, base class, hook, middleware, or config key resets every dependent surface, because evidence earned against the callee's OLD behaviour is void at every call site it reaches. **(a)** The deliverable counter is the **MINIMUM over surfaces**, never an aggregate. **(b)** A fix that REDS a previously-clean surface resets it. Resetting because a round produced a finding is BLOCKED.

**Why:** evidence is invalidated by a change to the configuration under test, never by an observation about it; a counter reset by findings measures reviewer productivity, so a better reviewer makes completion less reachable.
### 4. The Round Cap Is A CIRCUIT BREAKER, Never A Completion; The INSTRUMENT Rotates

The budgeted half is bounded by **effort** (sessions, tokens, wall-clock) allocated by risk — not a round count, which is a stop taken because it is customary. A **2–5 round cap** is a runaway guard: **hitting it is ABNORMAL TERMINATION, reported as such, never "done"** — escalate, naming open findings. **Iteration is non-monotone** (correctness 82.0%→67.3% rev 1→2; 16.0% of trajectories produce a correct patch then LOSE it by rev 3), so **a last-known-good state MUST survive every round**, recoverable when a later round degrades it. The **instrument MUST rotate** between rounds. The yield stop applies to the **budgeted half only**, measures NEW not open findings, and MUST name its falsifying result (`instrument-discipline.md` MUST-1).

**Why:** a round count encodes effort spent, never correctness reached; repeating one lens draws against the residue that lens already filtered.
### 5. Depth Conditions On ORACLE PRESENCE — Never On Model Capability

**Sound oracle** → primary verifier; review MAY shorten, **floored at one rotated round, never zero**. An oracle is sound FOR A PROPERTY only when the run was shown to RED in that property's absence (`instrument-discipline.md` MUST-2); "harness is green, so the oracle is sound" is BLOCKED. **No executable oracle** (prose rules, specs, config, governance artifacts) → adversarial review is the ONLY channel and runs the **full budget** — **MORE review than tested code, not less**. **Security / trust-bearing** (auth, signing, revocation, tenant-isolation, credentials, redaction, rate limiting, path containment, tenant-scoped cache keys, any fail-closed gate — illustrative, not exhaustive) → **full loop: converge per MUST-2, UNCAPPED by MUST-4**, never reduced; **ambiguous ⇒ trust-bearing**. **External signal ≠ human:** a **disjoint-context** reviewer (fresh session, no shared history) counts as external — a throughput tier, not an oracle. Conditioning on model identity, tier, or self-reported confidence is BLOCKED.

**Why:** a critic is redundant when it shares the generator's context and failure distribution — oracle presence tracks that, capability does not; and locating one's OWN errors is the capability that has not improved.
### 6. The Residual Is ACCEPTED By A Named Human, With A Revisit Trigger And Calendar Backstop

Anything in the budgeted half shipping unfixed is a **residual** and is not self-accepting. It MUST be accepted by a **named human distinct from the agent**, resolving to a **standing role**, carrying `product-completion-first.md` MUST-2's four defer conditions (cited, not restated — `specs-authority.md` Rule 9) **plus a calendar backstop**, so an event trigger that never fires cannot park it forever. **No human reachable ⇒ NOT accepted** ⇒ surface as a PENDING DECISION; the deliverable is not done. **An accepted finding is a BET — logged, owned, revisitable — never a claim of harmlessness.** Pentest vocabulary, not audit's: audit materiality works because misstatements share one unit against one total; findings share no denominator.

**Why:** a residual with no name against it is indistinguishable from a defect nobody noticed; the backstop stops the bet becoming permanent.

## MUST NOT

- Declare done on the ABSENCE of findings rather than a stated list reached — **Why:** unreachable by construction over an inexhaustible set.
- Derive the acceptance surface at verification time from the artifact under review — **Why:** it then grows with rounds spent, so more verification makes completion less reachable.
- Let the party that will satisfy a criterion author it unratified — **Why:** gamed at declaration time; every later check passes honestly.
- Reset a convergence counter because a round produced a finding — **Why:** it then measures reviewer productivity, not artifact state.
- Record a cap-stop as convergence — **Why:** a circuit breaker is abnormal termination; calling it done ships open gating-half findings under a converged banner.
- Reduce depth on model capability, identity, or self-reported confidence — **Why:** the least-supported discriminators available.
- Scope the list to user-visible behaviour, or gate on severity rank — **Why:** the least-visible classes most warrant gating, and severity-as-gate is independently BLOCKED by `product-completion-first.md` MUST-1.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/redteam` + cc-architect at `/codify` run the Detection checks below); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 (semantic judgment over session history; no structural tool-call signal).
- **Grace period:** 7 days from rule landing (2026-08-02 → 2026-08-09).
- **Cumulative posture impact:** same-class violations contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** GENERIC `regression_within_grace` trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated key (a review-layer semantic judgment; minting one would drag `trust-posture.md`, a `self-referential-codify.md` allowlist file, into a self-referential edit). Named deviation per `trust-posture.md` Rule 8 — same disposition `orchestration-launch-ledger.md` + `security.md` § Enforcement-Surface Parity took.
- **Receipt requirement:** SessionStart soft-gate `[ack: completion-criterion]` IFF `posture.json::pending_verification` includes the `completion-criterion` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — confirm **(a)** a ratified durable list predates round 1; **(b)** convergence covered every gating-half finding, only `INCREMENTAL` off-list budgeted, no ambiguous finding resolved out of the gating half; **(c)** no counter reset on an observation, touched-surface included transitive consumers; **(d)** depth cited oracle presence, not capability; **(e)** the reviewer INDEPENDENTLY derives an acceptance surface from the spec/brief and reports every item absent from the authored list — any absence is a finding (without (e) the check cannot discriminate a narrow list from an honest one); **(f)** every trust-bearing surface took the full uncapped loop; **(g)** no cap-stop recorded as convergence and a last-known-good survived. **Reachability residual, measured and recorded rather than papered over:** gate-review is the only detector, and the `paths:` set is NARROWER than this rule's subject warrants. `**/workspaces/**` and `**/journal/**` were authored, then REMOVED, for a measured reason: the `workspace-note` injection profile (probe path `workspaces/example/journal/0001-x.md`, matched by BOTH globs) sat at 218736 B against a 216904 B budget BEFORE this rule — already 100.8% — so adding a 14 KB rule there exceeded the +5% ceiling by ~5 KB even after full paired extraction to the skill. The honest consequence: a session that edits ONLY `workspaces/**` or writes ONLY a `journal/` close-out receipt does NOT load this rule. What remains covers the two moments that matter most — `**/todos/**` (where the acceptance list is authored) and `**/.session-notes*` + `**/.session-notes.d/**` (where the completion claim is written). This is a CORPUS-SATURATION residual, not a scoping judgment: the profile cannot absorb a new rule of normal size until an existing oversized one is extracted (the checker names `multi-operator-coordination.md` at 19022 B and `user-flow-validation.md` at 16714 B as broad-load #678-giant-class rules firing in EVERY profile). Restoring the two globs is the correct fix once that headroom exists, and is BLOCKED on it — not on a judgment about this rule's scope. Scanner: none (semantic). Fixtures `.claude/audit-fixtures/completion-criterion/` — 6 files in 3 bipolar pairs (MUST-1; MUST-3/4; meta-compliance) = `coc-artifact-eval-coverage.md` MUST-1's per-PROPERTY mandate, NOT one pair per MUST; MUST-2/5/6 ride gate-review plus the surfaces those pairs exercise. Probes `.claude/test-harness/probes/completion-criterion.probes.json` (6 rows, `scanner: null`) via `/test-harness-probe`, NOT in CI (the loom↔csq boundary keeps CI LLM-free); pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`. Phase 2 deferred — advisory `Stop` detector; fixtures land WITH it per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 (no list; visibility-scoped; severity-as-gate; self-authored unratified) + MUST-2 (convergence on the budgeted half; a live-incident finding held to round end) + MUST-3 (reset by a finding; touched-surface as diff alone; aggregate not minimum) + MUST-4 (round-count budget; non-rotating instrument; cap-stop as convergence; discarded last-known-good) + MUST-5 (depth on capability; a trust-bearing surface reduced, incl. via ambiguous classification; suite-level green as sound oracle) + MUST-6 (residual with no named acceptor, missing trigger or backstop, or accepted-by-absence).
- **Origin:** See § Origin.

## Distinct From / Cross-References

**Bounded by** `zero-tolerance.md` Rule 1d (enumerated classes never defer-eligible; this bounds only the residue Rule 1d scopes out). **Composes with** `product-completion-first.md` MUST-1/2/3 — its **MUST-1** owns the classifier AND the fail-closed resolution (MUST-2 = defer conditions, MUST-3 = warm-same-class lane); it feeds this rule, it does not bound the loop. **Distinct from** `wave-loop.md` MUST-1 bound B (bounds the invariant SURFACE; this bounds ITERATIONS over it). **Extends** `agents.md` § "Correctness-Review-Clean Is Not Security-Clean" as depth allocation. **Binds** `instrument-discipline.md` MUST-1/2 at the round boundary — rotation is worthless if the rotated instrument cannot discriminate.

## Origin

2026-08-02 — co-owner-directed origination (`artifact-flow.md` § Co-Owner-Directed Origination). A `/redteam` loop ran ~50 rounds without converging; the hypothesis that polish findings reset the counter was TESTED AND FALSIFIED — zero of seven headline findings were incremental, genuine bugs still at rounds 8/10/11. Convergent independent origination at **loom#1528**, adversarially reviewed downstream, contributed MUST-1's ratification clause, MUST-2's imminence axis, MUST-4's circuit-breaker + last-known-good, MUST-6, and the pentest-not-audit vocabulary. Evidence, the 20-surface corpus survey, refutations, and the three premises that did NOT survive (user-visibility scoping; capability-conditioning; severity-as-gate — the last would have contradicted `product-completion-first.md` MUST-1): the paired skill.

**Paired extraction performed at authoring time, not deferred** — the `workspace-note` injection profile measured 218736 B against a 216904 B budget BEFORE this rule (100.8%), so the un-extracted 39 KB draft exceeded the +5% ceiling by 30 KB. That the corpus grows monotonically while its relief valve is near-exhausted is the SAME unbounded-growth-without-a-designed-bound failure this rule names.
