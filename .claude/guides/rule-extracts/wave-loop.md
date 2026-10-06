# Wave-Loop — Rule Extract

Depth for `.claude/rules/wave-loop.md`. Everything here is REFERENCE, loaded on demand;
the normative contract is the rule. Per `rules/rule-authoring.md` Rule 10 path (a) the
worked examples, BLOCKED-rationalization corpora, and the full G1→G5 gate-table cells were
moved here VERBATIM so the rule body holds its path-scoped injection budget
(`.claude/bin/check-rule-injection-budget.mjs`, `workspace-note` profile).

## MUST-1 — worked examples + BLOCKED corpus

```markdown
# DO — multi-group decomposed into value-ranked waves; invariant-split when needed

Wave 1 (HIGH, ~6 inv): auth service + session store
Wave 2a/2b (MED): "billing engine" unions 9 shards ≈ 48 inv, no live harness →
split at the invariant boundary EVEN THOUGH value-coherent

# DO NOT — value-coherent mega-wave that overflows the convergence pass

Wave 1 = entire "billing engine" milestone, 9 shards ≈ 48 inv, one /redteam
("it's all one feature, the invariants relate") → clean verdict on an unholdable surface
```

**BLOCKED rationalizations:** "redteam each todo to be safe" / "per-shard convergence is
more rigorous" (anti-per-todo) · "it's all one feature, one wave is fine" / "we'll redteam
at the end like always" (anti-whole-project) · "it's one milestone, the invariants all
relate" / "the convergence pass can hold all the shards' invariants" / "value-coherent
means one wave" (anti-overflow) · "I'll just write the flat todo list" / "wave declaration is
for big projects only" / "the plan is obvious, no need to declare waves" / "I'll decide waves
at `/implement` time" (anti-no-declaration — the gate cannot fire on an undeclared plan).

## MUST-2 — the G1→G5 gate table, full cells

The rule carries a compact form of this table. The full cells, with every cross-reference
each step reuses, are below; nothing here is additional obligation, it is the same five
steps stated at length.

| Step                                        | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Reuses                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **G1 — redteam to convergence**             | `/redteam` scoped to THIS wave's shards, to full Convergence Criteria (`commands/redteam.md` § Convergence Criteria) — which REQUIRE a ratified acceptance list to predate the wave's first round and treat the round cap as a circuit breaker, never a completion (`rules/completion-criterion.md` MUST-1/MUST-4) — posture-invariant — convergence is on **BUG + INVEST-NOW findings only** (`commands/redteam.md` § Category-Based Finding Triage / `rules/product-completion-first.md`); INCREMENTAL findings accrete to the deferred-quality backlog carried to the terminal `/sweep`, and do NOT reset the wave's clean-round counter                                                                                                                                     | `/redteam` + `agents.md` § Redteam Reviewer Dispatch (criterion-3 evidence gate) |
| **G2 — capture the learning (LIGHTWEIGHT)** | Record the delta between what the wave's todos CLAIMED and what its redteam FOUND (misunderstanding, plan-drift, spec-divergence) as a journal `DISCOVERY`/`GAP` + a first-instance spec update **+ a `.session-notes` refresh** (a wave boundary IS a close-out — the `/wrapup` contract runs WITH the wave-close, staged into the wave-close commit, NOT as a separate manual `/wrapup`), and the per-wave refresh MUST update the wave-tracker file (`commands/wrapup.md` § Wave tracker) so a `/clear`-resumed session does not re-launch a still-running agent or redo a merged wave. **Full `/codify` is RESERVED for genuinely cross-project learnings — NOT run every wave** (avoids N codify-lease/PR cycles per project per `rules/knowledge-convergence.md` MUST-3). | `commands/journal.md`; `commands/wrapup.md`; `rules/specs-authority.md` Rule 5   |
| **G3 — update specs + remaining todos**     | First-instance spec update + sibling re-derivation sweep; amend UNSTARTED later-wave todos for version/symbol/signature drift the wave caused                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `rules/specs-authority.md` Rule 5/5b/5c                                          |
| **G4 — re-value-rank**                      | Re-rank the remaining waves and re-validate every deferred value-anchor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `rules/value-prioritization.md` MUST-1 + MUST-3                                  |
| **G5 — launch next wave**                   | Only after G1–G4 are clean; decompose onto the parallel primitive when the wave has ≥2 independent shards (a genuinely-atomic single shard runs inline)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `rules/agents.md` § The Default Execution Mode Is The Triad                      |

## MUST-2 — worked examples + BLOCKED corpus

```markdown
# DO — gate fires, learning feeds forward, THEN next wave

Wave 1 complete → G1 /redteam converges (2 clean) → G2 journal GAP "plan assumed sync
API, service is async" → G3 spec + Wave-2 todos amended to async → G4 re-rank → G5 launch

# DO NOT — drain todos/active across the boundary with no gate

Wave 1 todos done → immediately start Wave 2 todos ("keep momentum") → Wave 1's
async-vs-sync drift silently propagates into Wave 2 and surfaces only at terminal redteam
```

**BLOCKED rationalizations:** "keep the momentum, gate at the end" / "the wave converged,
the next wave is independent" / "G2/G3/G4 are overhead between waves" / "we'll feed the
learning forward when we hit a problem".

## MUST-6 — worked examples + BLOCKED corpus

```markdown
# DO — waiting on Wave-2's agents → launch the independent Wave-3 read-only audit NOW

# DO NOT — sit idle watching Wave-2 finish while an independent in-budget shard is launchable
```

**BLOCKED rationalizations:** "keep-executing means I override the gate" (NO — it fills IDLE
time ONLY; a gate still holds) / "I'll manufacture a shard so I don't have to stop at the clean
gate" (BLOCKED — the MUST-3 clean-gate-stop IS complete) / "waiting is simpler than tracking
another wave" / "the main agent's job is to watch the background agents".

## MUST-7 — worked examples + BLOCKED corpus

```markdown
# DO — #NNN open → grep the target file (already fixed) + BOTH halves of the issue + journal

gh issue view <N> --json body,comments # neither `view` alone nor `--comments` alone
grep (governing DEFER) → close with receipt, do NOT re-implement

# DO NOT — implement #NNN because it is still open → discover at redteam it landed two sessions ago

# DO NOT — reconcile on `gh issue view <N>` alone (the comments, where the item accreted, are absent)
```

**BLOCKED rationalizations:** "it is still open so it must be undone" (open ≠ undone) / "reconciling
is slower than just doing it" / "the issue is the source of truth" / "a governing DEFER would have
closed the issue already" / "`gh issue view` shows the issue" (it shows the BODY; the comment count
it prints is a tally, not the comments) / "`--comments` is the complete-read flag" (it is
comments-ONLY — the mirror-image truncation).

## MUST-8 — corpus pinning, the divergence ledger, and the freeze lease

### Worked example + BLOCKED corpus

```markdown
# DO — ledger pins each surface; divergence is a reported, accepted fact

surfaces: py cut_sha 959a2524… merged · rs cut_sha 7c1e9a3b… blocked
divergence_accepted_by: "<named human>" · freeze: {release_condition: "rs PR #412
merged or abandoned", expires: 2026-08-18}

# DO NOT — freeze main "so the wave ships one corpus", record nothing

(the one-corpus invariant broke at the first divergent cut; the freeze protects a
property already lost, blocks every unrelated lane, and lifts only when someone remembers)
```

**BLOCKED rationalizations:** "the PR body already says which loom SHA it came from" (prose
is not a field — nothing can read it) / "freeze main so the wave stays atomic" (atomicity
across N independently-merging PRs is not restorable by a branch lock) / "I'll lift the
freeze when the last surface merges" (that is a release CONDITION — write it down) / "a
short abbreviated SHA is enough to compare" (it compares unequal to its own full form) /
"everyone knows the freeze is on" / "logging the divergence is bookkeeping, the surfaces
will converge next wave" / "the ledger duplicates what the PRs already say".

### The failure this clause exists to stop

A nine-surface Gate-2 wave was cut at loom `959a2524`. Six surfaces were cut, five merged,
four blocked. `main` was then frozen by hand "so the wave ships one corpus". Three things
were true at once and none of them were recorded anywhere a later session could read:

1. **The one-corpus goal was already lost.** It was lost the moment the first surface was
   cut at a SHA the next surface would not be cut at. The freeze was declared to protect an
   invariant that had already broken — it bought nothing, because atomicity across N
   independently-merging PRs is not a property a branch lock can restore.
2. **The freeze blocked unrelated work for a full session.** A global lock is the widest
   possible instrument for a per-surface problem; its blast radius is every other operator
   and every other lane, none of whom were party to the wave.
3. **Nothing recorded when it could lift.** The freeze lived in one operator's memory. It
   had no declared author, no reason on disk, no release condition, and no expiry — so the
   only way to discover it was to be blocked by it, and the only way to lift it was to ask
   the person holding it.

The root cause is upstream of all three: **the wave model assumed all surfaces land
together, so the only lever available when they did not was a manual global freeze.** And
because the corpus SHA a surface synced from was invisible after the fact — stated in PR
prose as "from loom <sha>", never as a field anything could read — divergence was
UNDETECTABLE rather than merely inconvenient. A wave could ship two corpora and report
success.

### Why a machine-readable pin, not better prose

The Gate-2 PR body already said "from loom <sha>". Prose is not the problem's opposite;
a field is. The `corpus-sha: <40-hex>` trailer is greppable off
`gh pr view <N> --json body`, so "which corpus did this surface actually receive?" becomes
a question with a mechanical answer instead of a reading exercise. FULL forty hex digits,
never abbreviated: an abbreviated SHA compares unequal to its own full form, which turns
the divergence check into an instrument that reports divergence where none exists
(`rules/instrument-discipline.md` MUST-1 — name the falsifying result first).

### Divergence is REPORTED, never BLOCKED

The clause deliberately does not forbid a wave from shipping two corpora. Forbidding it
would recreate the freeze reflex under a new name — the wave would stall on an invariant
that real multi-surface delivery cannot hold, and the pressure to fake it would return.
What the clause forbids is shipping two corpora **silently**. Distinct `cut_sha` values
across surfaces is a REPORTED FACT with a NAMED human acceptor
(`divergence_accepted_by`), which is the same disposition `rules/completion-criterion.md`
takes on a residual: not "never", but "never without someone's name on it".

### The freeze contract, stated

A freeze is legitimate. A freeze held in memory is not. The three questions the incident
could not answer are exactly the three fields the lease requires:

| Question             | Field               | What its absence caused                                 |
| -------------------- | ------------------- | ------------------------------------------------------- |
| Who declared it?     | `declared_by`       | No one to ask; discovery only by being blocked          |
| Why is it warranted? | `reason`            | A freeze protecting an already-broken invariant         |
| What lifts it?       | `release_condition` | It lifted when someone remembered, not when it was done |
| When does it lapse?  | `expires`           | A full session of unrelated work blocked                |

`expires` is a BACKSTOP, not a permission window — the freeze should lift on its
`release_condition` long before the calendar date. The date exists so that a forgotten
freeze becomes a FINDING rather than a permanent condition, the same
declaration-with-expiry shape `.claude/test-harness/phase2-deferrals.json` and
`.claude/test-harness/descoping-exceptions.json` already use.

A freeze is warranted ONLY while ≥1 surface is genuinely un-landed (`open` or `blocked`).
Once every surface row reads `merged` the lease is STALE and the detector reds — this is
the "it lifted when someone remembered" failure, mechanized.

### Ledger schema

`workspaces/<wave>/corpus-ledger.json`:

```json
{
  "wave_id": "loom-sweep-waves-2026-08-14",
  "cut_from": "959a2524dd0b1e3f4a5c6d7e8f90a1b2c3d4e5f6",
  "divergence_accepted_by": null,
  "surfaces": [
    {
      "surface": "kailash-coc-claude-py",
      "cut_sha": "959a2524dd0b1e3f4a5c6d7e8f90a1b2c3d4e5f6",
      "pr": 412,
      "state": "merged",
      "merged_sha": "7c1e9a3b5d8f0246813579bdf02468ace1357913"
    }
  ],
  "freeze": null
}
```

`state` is one of `open` / `merged` / `blocked` / `abandoned`. A `merged` row MUST carry a
`merged_sha`; every other state MUST NOT — a merged SHA on an open PR is a claim the ledger
cannot support, and the detector treats it as a fabricated receipt rather than a typo.

### What the detector does and does not answer

`.claude/bin/check-wave-corpus-ledger.mjs` answers structural questions only: is the pin a
full SHA, is every surface pinned, do the state and `merged_sha` agree, is divergence
accepted by a named human, does a present freeze carry all four lease fields, has it
expired, is it stale. It does NOT judge whether a freeze was WARRANTED in the first place,
whether the named acceptor was the right person, or whether the surfaces listed are the
surfaces the wave actually touched — those are semantic and stay gate-review work
(`rules/instrument-discipline.md` MUST-4: the instrument is scoped to the question it was
built for). In particular a ledger that omits a surface entirely is INVISIBLE to it; the
enumeration is the author's obligation, checked at `/codify` against the wave's actual PR
set.

Exit codes: `0` clean · `1` findings · `2` usage/IO · `3` UNRUN (no ledger found — NOT a
pass; `coverage_asserted` in `--json` is the discriminator, per the
`.claude/bin/check-descoping.mjs` precedent).

---

# 2026-08-19 structural-cleanup extraction (rule body → here)

Everything below was moved VERBATIM out of `.claude/rules/wave-loop.md` on 2026-08-19 to hold
that rule's path-scoped injection budget (`.claude/bin/check-rule-injection-budget.mjs`,
`loom-command-edit` + `workspace-note` profiles). It is EVIDENCE, RUNNABLE DETAIL, MEASURED
NARRATIVE and PER-INSTANCE PROVENANCE only — no MUST, MUST NOT, BLOCKED entry, DO/DO-NOT block
or `**Why:**` line left the rule. `rule-authoring.md` Rule 10 / Rule 11 do NOT fire on it:
Rule 10 § "Trigger scope" limits both to `priority: 0` + `scope: baseline` rules and
`wave-loop.md` is `scope: path-scoped` (the disposition `journal/0148` recorded).

## Preamble — the terminal-verification design

The rule opens with a two-sentence framing. The full original framing, which names the handoff
chain the fidelity loss happens on:

> Autonomous coding today runs `analyze → plan → todos → implement → ONE terminal /redteam`:
> `/todos` writes every todo once, `/implement` drains `todos/active/` to empty, `/redteam`
> runs once at the end feeding gaps only back to `/implement`. Verification **deferred to the
> end** means a defect injected at any handoff (analysis→plan→todos→implement — each loses
> fidelity) is not caught until the terminal redteam, by which point fixing it re-touches many
> already-"completed" todos. That terminal-verification design IS the
> implement→redteam→QA→fix→repeat loop that runs countless times.

## MUST-1 — the bound-B and declaration rationale

Two rationale tails, moved out of the clause bodies (each clause keeps its bound, its BLOCKED
statement, and its own `**Why:**` line in the rule):

**Bound B (anti-overflow), why the aggregate ceiling is inherited:** "The wave gate thereby
inherits the shard gate's attention ceiling at the aggregate; without it a value-coherent
8-shard wave (~50 invariants) "converges clean" on a surface too large to hold —
`rules/sweep-completeness.md` theatre one layer up."

**Compulsory declaration, why an undeclared plan is the violation:** "an undeclared or
under-declared plan makes the MUST-2 inter-wave gate inert by construction (no boundary to
fire at), converting "no wave structure" from an invisible default into an explicit,
challengeable claim the `/todos` gate and detection sweep can test."

## MUST-3 — the binding note

Moved from the clause body (the clause keeps its BLOCKED statement and its wave-local
amplification in full): "This rule binds the criteria and adds only the wave-local
amplification below; it does not re-derive them."

## MUST-7(b) — the measured both-halves poles

The clause keeps the obligation (read BOTH halves; `--json body,comments`; a single partial flag
is not enough). The MEASUREMENT that establishes it, both poles, verbatim:

> Measured, both poles, on `gh` 2.x: bare `gh issue view <N>` prints the body and NOT the comment
> bodies (it prints `comments: 1`, a TALLY that reads as if they were surfaced —
> `instrument-discipline.md` MUST-3(b)); `--comments` prints the comments and NOT the body — the
> mirror-image defect, so prescribing it alone would install this same bug in the opposite
> direction.

The falsifying context for each pole is the pole itself: had `gh issue view <N>` surfaced the
comment bodies, the tally line would have been accompanied by them; had `--comments` carried the
body, the mirror-image defect would not exist and prescribing it alone would have been safe.

## Composes with — the per-clause cross-reference map

The rule's § Distinct From keeps the DISTINCT-FROM boundary and the list of composed rules. The
per-clause map naming WHICH section of each is reused where, verbatim:

- **Composes with (does not restate):** `commands/redteam.md` § Convergence Criteria (G1/
  MUST-3) — incl. criterion 3's errored-reviewer evidence-gate; `rules/agents.md` § "Redteam
  Reviewer Dispatch — Errored/Empty Is Zero Evidence" (the G1 evidence-gate MUST-3 binds) +
  § The Default Execution Mode Is The Triad (G5/serial carve-out);
  `rules/value-prioritization.md` MUST-1+3 (G4 + later-wave re-validation);
  `rules/specs-authority.md` Rule 5/5b/5c (G2/G3); `rules/autonomous-execution.md` §
  Per-Session Capacity Budget (the shard gate the wave gate sits above) + § Structural vs
  Execution Gates; `rules/verify-resource-existence.md` MUST-4 (MUST-5 rail);
  `rules/knowledge-convergence.md` MUST-3 (why G2 is lightweight).

## Trust Posture Wiring — the MUST-1/2/3/5 sweep checklist

The rule's Detection-mechanism field keeps the five checks in compact form. The full checklist,
with what each check discriminates, verbatim:

> **(0) Declaration check (the on-ramp): EVERY `/todos` plan MUST carry an explicit
> wave-sequence declaration; a multi-shard plan with no declared wave sequence, OR ≥2
> value-distinct milestone-groups / a bound-B-exceeding shard-union collapsed to one wave
> without a stated justification, is the violation** — this fires on the
> undeclared/under-declared case, NOT only on already-multi-wave workspaces. (1) Any multi-wave
> workspace MUST then show (a) a journal convergence receipt per non-final wave (MUST-5), (b) a
> re-value-rank receipt per boundary (G4), (c) no wave's shard-union exceeding the MUST-1
> bound-B ceiling, (d) each non-final wave's convergence receipt names the full reviewer wave
> AND confirms every dispatched reviewer returned a genuine ran-signal (no errored / empty /
> timed-out / throttled reviewer counted toward a clean round) per the MUST-3 evidence-gate — a
> receipt-present-but-false-converged wave passes (a) yet fails (d).

The (a)-vs-(d) discrimination is the load-bearing part: a receipt whose mere PRESENCE satisfies
(a) can still fail (d), which is why both checks exist.

The Violation-scope field was compressed in the same pass; the fragment it dropped, verbatim, is
the same discrimination stated once more: MUST 3 covers "G1 reaches GENUINE convergence — a clean
round counts only when every dispatched reviewer ran; a false-converged wave is a MUST-3
violation".

## MUST-6/7 wiring — the fleet-drain detector, measured

The rule keeps the shipped-detector declaration, its severity, and a compact statement of its
three bounds. The MEASURED severity justification and the per-bound measurements, verbatim:

> The upgrade is justified and the justification is a MEASUREMENT, not a preference: both counts
> are STRUCTURAL, so `hook-output-discipline.md` MUST-2's bar on `block` from a LEXICAL signal is
> not what caps this; the EVENT is. `instruct-and-wait.js` tests `STOP_LIKE_EVENTS` before its
> `block` branch, so `Stop` + `block` returns `{continue:true}` exit 0 while the control
> `PreToolUse` + `block` returns `{continue:false}` exit 2 — no severity blocks here, and
> `halt-and-report` is the strongest available. THREE BOUNDS, stated so the rule does not
> over-claim what is armed: it detects the COUNT, never the independence judgment MUST-6 turns
> on; **it was ONCE scoped to lanes the MAIN agent named**, so a session carrying main-agent
> dispatches without a `name` reported UNKNOWN and stayed silent (measured: 2 of 9 ledgers on the
> authoring clone) — **that silence WAS the defect and is now CLOSED**: the ledger derives
> `dispatch_name` from `tool_input.name` alone and therefore undercounts (unnamed launches were
> present in 5 of 9 measured ledgers), while an unnamed subagent was MEASURED to appear in the
> harness `background_tasks` array anyway, making that array an upper bound over the ledger's
> blind spot. The detector now RECONCILES the two instruments, flags an unbounded ledger reading
> `boundedAbove: false` instead of refusing it, and reports UNKNOWN — naming both readings — when
> they disagree; and the under-capacity arm ships OBSERVING, not advising, because its lane floor is
> uncalibrated — only the zero-lane DRAINED boundary advises.

The falsifying context for the severity measurement is the CONTROL in it: had the event not been
what caps the severity, the `PreToolUse` control would have returned `{continue:true}` exit 0 too
instead of `{continue:false}` exit 2.

**Why the `Phase 2 (deferred …)` wording must not be reworded** (the rule keeps the one-line
caution; the matcher and the incident, verbatim):

> That `Phase 2 (deferred …)` form is load-bearing, not stylistic: `validate-xref-integrity.mjs`
> sanctions a forward-pointer to a not-yet-created fixture dir ONLY when the citing block matches
> `PHASE2_DEFERRED_RE` or `FIXTURES_LAND_WITH_RE`, so rewording this sentence de-sanctions the
> reference and reds the xref gate — which is exactly what happened when MUST-6's half was
> declared shipped and this clause was rephrased alongside it.

## MUST-8 wiring — the scanner's per-arm red conditions

The rule keeps the scanner name, its shipped-structural status, the exit-3 UNRUN semantics, the
fixture directory and its registration. The per-arm enumeration, verbatim:

> Scanner `.claude/bin/check-wave-corpus-ledger.mjs` reads every
> `workspaces/*/corpus-ledger.json` and reds on an abbreviated/absent `cut_sha`, a
> state/`merged_sha` contradiction, unaccepted divergence, an incomplete/expired/stale freeze
> lease, or a malformed ledger; it exits 3 (UNRUN, explicitly NOT a pass) when no ledger
> exists, so a silent no-op cannot read as clean. Bipolar fixtures — a violating pole that
> MUST red and a conformant pole that MUST stay green for every arm, plus a self-control
> proving the instrument discriminates before it reports — at
> `.claude/audit-fixtures/wave-corpus-ledger/`, registered `mode: run` in
> `.claude/test-harness/ci-audit-fixtures.json` and executed by
> `.claude/bin/run-audit-fixtures.mjs`.

Exit codes and the scope boundary (what the scanner does NOT answer): § "What the detector does
and does not answer" above.

## Origin — design provenance and the amendment records

The rule's § Origin keeps the dated origination line for every amendment. The design provenance
and the MUST-8 incident record, verbatim:

> 2026-06-06 — co-owner-directed origination (`rules/artifact-flow.md` § Co-Owner-Directed
> Origination); verbatim directive + receipt-first journal `journal/0226`. Designed by a
> 9-agent analysis workflow (5 analysts → synthesis → 3 adversarial reviewers, workspace
> (loom-internal reference)), validated by the authoring-side meta-ablation at
> `.claude/test-harness/tests/wave-loop-ablation.test.mjs`. MUST-1 bound B (invariant-surface)
> originates from the ceremony-axis review; the MUST-3/4/5 reference-binding collapse from the
> duplication review. MUST-1 + MUST-2 are the genuinely-new load-bearing content; MUST-3/4/5
> are reference-bindings to the rules they compose with. Amended 2026-07-18 — co-owner-directed
> origination (`journal/0543`) added MUST-6 (never-idle-wait) + MUST-7 (reconcile-first) + the G2
> wave-tracker refresh line + their clause-scoped 8-field wiring; the default execution mode is the
> triad parallelize + `/autonomize` + `/redteam`-to-convergence (`rules/agents.md` § The Default Execution Mode Is The Triad).
>
> Amended 2026-08-16 — MUST-8 (corpus pinning + divergence ledger + freeze lease). A
> nine-surface Gate-2 wave was cut at loom `959a2524`: six surfaces cut, five merged, four
> blocked, after which `main` was frozen by hand "so the wave ships one corpus". The freeze
> blocked unrelated work for a full session; the one-corpus goal had already been lost at the
> first divergent cut; and nothing on disk recorded who declared the freeze, what would
> release it, or when it lapsed. Root cause: the wave model assumed all surfaces land
> together, so the only lever when they could not was a manual global freeze — and because the
> corpus SHA a surface synced from lived in PR prose, divergence was undetectable rather than
> merely inconvenient. Paired extraction (`rules/rule-authoring.md` Rule 10 path (a)) moved
> this file's worked examples, BLOCKED corpora, and full G1→G5 cells to
> `.claude/guides/rule-extracts/wave-loop.md`, funding the clause within the `workspace-note`
> injection budget rather than raising it. Full incident, ledger schema, and lease-field table:
> extract § MUST-8.

## Length rationale — the full enumeration

The rule keeps a compact named rationale (required by `rule-authoring.md` MUST NOT § "Rules
longer than 200 lines"). The full enumeration it was compressed from, verbatim:

> **Length rationale (per `rules/rule-authoring.md` MUST NOT length cap).** ~300 lines after the
> 2026-07-18 co-owner-directed addition of MUST-6 (never-idle-wait) + MUST-7 (reconcile-first) +
> their clause-scoped 8-field wiring, over the 200 guidance. Named rationale: the body is already
> minimized — MUST-3/4/5 are collapsed to reference-bindings, the duplicative `agents.md` clause
> was dropped per the duplication review, and MUST-6/7 cross-ref their bounding gates rather than
> restating them — and the residual is structural: the mandatory 8-field Trust Posture Wiring
> (`trust-posture.md` MUST-8, now two clause-scoped blocks) + the 5-step G1→G5 gate table + the
> 3-bound wave definition + the **compulsory-declaration clause** (the gate's on-ramp — without it
> the rule is inert, per the 2026-06-07 co-owner review) + MUST-6/7 (each with DO/DO-NOT + BLOCKED
> corpus + Why per `rule-authoring.md` MUST 3/4) are each load-bearing and non-decomposable. The
> orchestration-hygiene pair is the co-owner-directed core of `journal/0543`; splitting it into a
> separate rule would fracture the wave-loop's own "always-executing" contract across two files.
> Sibling precedent: `user-flow-validation.md` + `multi-operator-coordination.md` Origins.

Since that text was written the rule gained MUST-8 (2026-08-16) and MUST-9 (2026-08-19), so the
Wiring count is now FOUR clause-scoped blocks and the G1→G5 gate table is carried as a list.

## Note — the MUST-2 gate table is a LIST in the rule body

The rule body renders G1–G5 as a bulleted list rather than a markdown table. That is a
whitespace reflow only (markdown table padding), taken in the same 2026-08-19 extraction: every
cell's text, including the `Reuses` column (rendered `_Reuses:_`), is preserved verbatim in the
rule. The full-detail cells remain in § "MUST-2 — the G1→G5 gate table, full cells" above.

---

# Structural-cleanup extraction — 2026-09-13 (rule-injection budget)

A second structural-cleanup pass over `rules/wave-loop.md`, taken to hold the rule's
path-scoped injection budget. ZERO de-scoping: every MUST clause, MUST NOT bullet, BLOCKED
entry, DO/DO-NOT block, `**Why:**` opener and canonical Trust-Posture-Wiring field stayed in
the rule body. What moved here is narrative, measurement history, probe-registration
boilerplate and per-instance provenance — none of it carrying a governance token. The
sections below are addressed by the `Depth — … lives in …` pointers the rule body now carries.

## Trust Posture Wiring — probe-registration depth

Relocated verbatim from the rule's rule-wide `- **Detection mechanism:**` bullet (2026-09-13):

> Registered in `eval-manifest.json` as a probe-only entry (`scanner: null`) and pinned in
> `probe-suite-integrity.test.mjs::PINNED_SUITES`; ZERO deferred clauses. The MUST-5 pair is the
> load-bearing one: its violating pole's convergence receipt is PRESENT, well-formed, committed
> and quoted inline, and is STILL a violation, because the transcript shows the session wrote the
> disposition document in the same turn it then cited back. A check keying on receipt presence
> scores that pole CLEAN — which is the gap the pair exists to close, and why the
> `phase2-deferrals.json` objection that "presence-checking is known-insufficient by
> construction" argues against a STRUCTURAL presence check and not against an LLM judge over a
> transcript. An earlier revision of this line said the suite was NOT YET AUTHORED; that was true
> when written and is now FALSE, corrected rather than left standing. Registration buys
> DISPATCHABILITY, never automatic execution: no workflow invokes `coc-probe-dispatch.mjs`, and
> the loom↔csq boundary keeps CI LLM-free, so a green CI run is NEVER evidence these probes
> passed — they execute only when an orchestrator dispatches `/test-harness-probe --artifacts` at
> gate-review. Consumer note: `.claude/test-harness/**` is never-synced, so no consumer receives
> the suite and enforcement at those targets is gate-review.

Also relocated from the same bullet's Phase-1 sentence: the sweep's check (0) fires on a
single-wave plan, not only on already-multi-wave workspaces.

## MUST-9 wiring — probe-registration depth

Relocated verbatim from the MUST-9 clause-scoped `- **Detection mechanism:**` bullet (2026-09-13):

> A probe suite NOW SHIPS: `.claude/test-harness/probes/wave-loop.probes.json` carries a
> `MUST-9-firing` bipolar pair among eleven, and `wave-loop.md` now carries an
> `eval-manifest.json` probe-only entry (`scanner: null`), so the semantic tier is COVERED. The
> superseded text said the opposite; it was true when written and is FALSE as of 2026-09-13,
> corrected rather than left and is owed at gate-review via `/test-harness-probe` — stated
> explicitly rather than naming a phantom path.

And from the same block's `- **Regression-within-grace:**` bullet, the reasoning behind the
no-dedicated-key disposition:

> the violation is a bounded CI-spend overrun, not a corrupting or trust-bearing failure, so it
> does not warrant an instant-drop key, and minting one would drag `trust-posture.md` — a
> `self-referential-codify.md` allowlist file — into a self-referential edit.

And from `- **Origin:**`: the trigger-topology measurement is explicitly marked per-repo and
must be re-derived at each destination.

Detection-side wording relocated from the same bullet: wave membership is not derivable from
any tool-call-time signal because a `gh pr create` is indistinguishable from a legitimate
single-shard PR without knowing the wave plan, so booking a Phase-2 detector would promise
teeth that cannot arrive.

## MUST-8 wiring — probe and fixture depth (2026-09-13)

Relocated verbatim from the MUST-8 clause-scoped `- **Detection mechanism:**` bullet:

> Bipolar fixtures (violating + conformant pole per arm, plus a self-control proving the
> instrument discriminates before it reports) at `.claude/audit-fixtures/wave-corpus-ledger/`,
> registered `mode: run` in `.claude/test-harness/ci-audit-fixtures.json` and executed by
> `.claude/bin/run-audit-fixtures.mjs`. … **A probe suite NOW SHIPS for this clause** —
> `.claude/test-harness/probes/wave-loop.probes.json` carries a `MUST-8-firing` bipolar pair
> among eleven, registered in `eval-manifest.json` as a probe-only entry (`scanner: null`) and
> pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`, with candidates + answer-key
> sidecars at `.claude/audit-fixtures/wave-loop/`. The superseded text read "**No probe suite
> ships for this clause** — … the semantic tier is UNCOVERED"; that was true when written and is
> FALSE as of 2026-09-13, corrected in place rather than left standing.

And from the same block's `- **Regression-within-grace:**` bullet: a ledger/lease property is
mechanically checkable at gate-review and does not warrant an instant-drop key.

## MUST-6/7 wiring — the un-named-dispatch measurement (2026-09-13)

Relocated verbatim from the MUST-6/7 clause-scoped `- **Detection mechanism:**` bullet. It
belongs with § "MUST-6/7 wiring — the fleet-drain detector, measured" above:

> it RECONCILES TWO instruments — the harness-provided `background_tasks` array from the `Stop`
> payload, and the per-session dispatch ledger — against dispatchable
> `## Outstanding ledger (forest)` rows, and emits `halt-and-report` — NOT the `advisory` this
> block previously booked. … **it is NO LONGER silent on un-named dispatches** — that silence
> WAS the defect, because the ledger derives `dispatch_name` from `tool_input.name` alone and so
> undercounts (unnamed launches were present in 5 of 9 measured ledgers), and an unnamed subagent
> was MEASURED to appear in `background_tasks` anyway, which is what makes that instrument an
> upper bound over the ledger's blind spot; an unbounded ledger reading is now flagged
> `boundedAbove: false` rather than refused, and the two instruments DISAGREEING yields UNKNOWN
> naming both readings. Its under-capacity arm ships OBSERVING, not advising.

The `Phase 2 (deferred …)` matcher note kept its compressed form in the rule body; the incident
that proved the wording load-bearing is § "MUST-6/7 wiring — the fleet-drain detector, measured".

## Preamble — what the gate REUSES unchanged (2026-09-13)

Relocated verbatim from the rule's preamble. It belongs with § "Preamble — the
terminal-verification design" above:

> and it REUSES convergence (`commands/redteam.md` § Convergence Criteria) and parallel-decompose
> (`rules/agents.md` § The Default Execution Mode Is The Triad) unchanged, scoped to the wave —
> it does not restate them.

## MUST-1 — two relocated rationale sentences (2026-09-13)

Belongs with § "MUST-1 — the bound-B and declaration rationale" above. Relocated verbatim:

> [Per-shard convergence] overflows the verification-attention budget the other way and degrades
> into ritual.

> The wave gate thereby inherits the shard gate's attention ceiling at the aggregate.

## MUST-3 — the throttle-exposure rationale (2026-09-13)

Belongs with § "MUST-3 — the binding note" above. Relocated verbatim from the rule body:

> The per-wave design runs N boundary redteam rounds vs the terminal design's one — multiplying
> throttle exposure — so …

> … a false-converged wave feeds an un-reviewed base into G5's next wave.

## MUST-7(b) — the partial-read framing (2026-09-13)

Belongs with § "MUST-7(b) — the measured both-halves poles" above. Relocated verbatim:

> An issue's substance splits across its BODY and its COMMENTS — an item that accreted findings
> after filing carries most of itself in comments — so a partial read makes the item look SHORTER
> than it is, which is precisely the mis-reconciliation this clause exists to block.

## Composes with — the roster, and the G1/G2/G3/G5 `_Reuses:_` tails (2026-09-13)

Belongs with § "Composes with — the per-clause cross-reference map" above. The roster relocated
verbatim from the rule's § Distinct From / Cross-References bullet:

> `commands/redteam.md`, `rules/agents.md`, `rules/value-prioritization.md`,
> `rules/specs-authority.md`, `rules/autonomous-execution.md`,
> `rules/verify-resource-existence.md`, `rules/knowledge-convergence.md`,
> `rules/product-completion-first.md`.

The four non-MUST-bearing `_Reuses:_` tails relocated from the MUST-2 gate list (G4's is kept
inline in the rule because it carries the `value-prioritization.md` MUST-1 + MUST-3 binding):

- **G1** — _Reuses:_ `/redteam` + `agents.md` § Redteam Reviewer Dispatch.
- **G2** — _Reuses:_ `commands/journal.md`; `commands/wrapup.md`; `rules/specs-authority.md` Rule 5.
- **G3** — _Reuses:_ `rules/specs-authority.md` Rule 5/5b/5c.
- **G5** — _Reuses:_ `rules/agents.md` § The Default Execution Mode Is The Triad.

## Other sentences relocated in the 2026-09-13 pass

Each is narrative that carried no governance token; the obligation it sat beside stayed in the
rule body.

- MUST-2 preamble: "the gate adds no new phase" (the same fact is stated in the rule's opening
  framing).
- MUST-2 `**Why:**` tail: "G1–G4 apply it at the boundary; G5 only proceeds on a clean,
  fed-forward base."
- MUST-4: "The wave boundary IS the re-validation trigger."
- MUST-5: "Binds the existing rail; invents none."
- MUST-6 body: the structural-human-gate gloss "— plan-approval, release".
- MUST-6 `**Why:**` tail: "— the two failure modes this clause holds apart."
- MUST-7 `**Why:**`: "(caught already-done work repeatedly in the origin session)".
- MUST-8 `**Why:**`: "Making the delivered corpus SHA a machine-readable per-surface field
  converts divergence from an undetectable state into a reported one, which removes the reason to
  fake atomicity at all."
- MUST-9 body: "Where every workflow triggers on `pull_request` (or on `push` restricted to the
  default branch, or on tag pushes for release lanes), a `git push` of a feature branch with no PR
  created costs **zero** runs." and the gloss "— durable, backed up, visible to a teammate —" and
  "(no per-shard PR, so no per-shard CI)".
- MUST-9 `**Why:**` tail: "Converging locally and pushing once collapses both."
- The three Wiring `**Severity:**` judgment-restatements ("whether N open PRs belong to ONE wave
  is a session-history judgment with no structural tool-call-time signal"; "whether a branch lock
  was a freeze is a session-history judgment with no tool-call-time signal"; "both properties are
  session-history judgments, not tool-call-time structural signals") — the `advisory` carrier and
  its `hook-output-discipline.md` MUST-2 anchor stayed in the rule.
- MUST NOT bullet 4 `**Why:**` tail: "Human-on-the-Loop, not in-the-loop."
- § Distinct From bullet 1 tail: "Both guard verification theatre, different triggers."
- § Origin: the amendment glosses "(never-idle-wait)", "(reconcile-first)", "(corpus pinning +
  divergence ledger + freeze lease)", "(one integration PR per wave)", "verbatim directive +",
  and the design-provenance parenthetical "(the 9-agent authoring workflow, the meta-ablation
  test, which MUSTs are load-bearing vs reference-bindings)" — all of which the § Origin and
  § Length-rationale sections above already carry in full.
