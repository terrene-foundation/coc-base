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
