# Role-Conditioned Attackers — Running A Derived Coverage Round

Depth file for `commands/redteam.md` §§ C1–C4 + § Agent Teams + § Convergence Criteria, and for
`commands/vet.md`. The command bodies own every load-bearing contract — the cell dispositions and
their citation floor, the pre-registered `n/a` set and its never-`n/a` core, the cell-history and
re-open rules, the concurrency bound, the incentive-check register template, and all ten convergence
criteria. This file carries only ELABORATION that a
consumer can reach on demand: worked attacker frames derived from the rule, the roster-vs-derivation
reconciliation, and the code-target warrant substitution. Nothing here is the sole home of a MUST.

The normative source is `rules/adversarial-coverage.md` — MUST 1–6, MUST NOT 1–2, the §3 R×P
derivation, the §4 specialisation argument, and the §5 evidence base. Nothing here overrides it.

## Why a roster is not a derivation

An attack round inherits the blind spot of its question. A roster of named reviewers converges when
its members run out of findings — a fact about the roster. A derived surface converges when every
cell is discharged — a fact about the artefact. `rules/adversarial-coverage.md` MUST-1 therefore
forbids substituting a hand-listed set of agents, checks, or "perspectives" for the derivation.

## Reconciling MUST-1 with the named specialist roster

`commands/redteam.md` still names specialists (analyst, testing-specialist, security-reviewer,
value-auditor, reviewer, gold-standards-validator, uiux-designer). That is **not** a MUST-1
violation, and the distinction is load-bearing:

| Instrument                     | What it is                                                        | Governs                        |
| ------------------------------ | ----------------------------------------------------------------- | ------------------------------ |
| The derived R×P table          | The **coverage** obligation — what must be attacked               | Convergence condition 1        |
| The seven role-conditioned attackers | The **attack** instrument — one per derived role             | How each cell is attacked      |
| The named specialists          | **Evidence producers** — spec tables, test re-derivation, log triage, security depth | Warrants (MUST-4), never coverage |

A specialist supplies a WARRANT for a finding; it never defines the surface. Reporting "all named
specialists found nothing" as convergence is the MUST NOT-1 violation, whatever the roster's size.
A specialist finding is still placed in a cell — if it will not place, the decomposition is wrong
and is re-derived, not patched with an extra axis.

## Worked attacker frames — derived from the rule, not defined here

The SOURCE of each frame is the `rules/adversarial-coverage.md` §3 role table's question column, which
reaches every CLI. The command derives the frame from it; the table below is a WORKED RENDERING of
that derivation, useful when authoring a round and never a substitute for §3. One attacker per role,
each given ONLY its own role's question, each blind to the others until aggregation, each framed to
REFUTE rather than assess, and none told the work under attack was produced by this session (MUST-5).

| Role | Worked frame (derived from §3)                                                                    |
| ---- | ----------------------------------------------------------------------------------------------- |
| R1   | "Comply with this clause using only what it gives you. Where can you not?"                      |
| R2   | "This clause is wrong. Show where, against the artefacts it cites."                             |
| R3   | "You are a third party holding the artefact and nothing else. Prove compliance. Where can't you?" |
| R4   | "You received this artefact. List everything it tells you that you were not meant to learn."    |
| R5   | "This artefact is *about* you. What does it do to you?"                                         |
| R6   | "Only half of this change set landed. Which half breaks, and which half alarms falsely?"         |
| R7   | "You are paid to minimise cost while staying conformant. Find the cheapest compliant path."      |

Phrase every dispatch in CLI-neutral prose (`rules/cross-cli-artifact-hygiene.md`); the frames above
are prompt CONTENT, not a delegation primitive.

**Blindness is an ORDERING property, not a simultaneity one.** Every wave is LAUNCHED before ANY
result is read; feeding attacker N's findings into attacker N+1's prompt collapses the specialisation
and reproduces the single-attacker failure (`adversarial-coverage.md` §4). Wave SIZE is governed by
`rules/worktree-isolation.md` Rule 4 — ≤3 on a cold start, widened only on a clean return signal —
because a synchronized-burst death sends every cell in the burst to OPEN, and the only zero-cost exit
from OPEN is the `n/a` that Criterion 8 exists to price. Each returned result still passes the evidence gate in
`rules/agents.md` § "Redteam Reviewer Dispatch" and § "Agent-Result-Delivery" — an errored, empty,
throttled, or status-fragment return is ZERO evidence, must be re-run or resumed, and leaves its
cell OPEN rather than attacked.

## The coverage table, carried forward — rules live in the command

Every `attacked` cell carries two things: the `ledger:<track>` token (machine-readable, joins to the
launch ledger's own `track` column so nothing is minted) and the prose warrant (the role, and its
finding or explicit CLEAN verdict). The token is for the checker; the prose is what a reviewer reads
and is the half that survives if the checker is unavailable.

The normative disposition rules — the ledger-citation floor on `attacked`, the PRE-REGISTERED `n/a`
set with its eight-cell never-`n/a` core and its acceptor-at-any-level residual, the cell-history
requirement, and the RE-OPEN-on-landed-fix rule — are in `commands/redteam.md` § C1 and Criterion 8.
There is deliberately NO permitted `n/a` fraction; a count-based bar prices excuses in bulk. This
section is the reporting SHAPE only.

```
Coverage: 42 cells — 28 attacked (each with ledger:<track> + prose warrant), 9 n/a (pre-registered at C1), 5 OPEN
  of which re-opened by this round's landed fixes: 3
Convergence: BLOCKED — 5 cells open (R3×P5, R5×P6, R2×P2, R2×P3, R6×P2)
Incentive register: 14 rows — 12 REQUIREMENT, 2 PREFERENCE (1 ROUTED, 1 OPEN)
```

- A round that rebuilds the table from scratch loses the disposition history Criteria 8–9 read.
- Cells added mid-round are recorded with the round that added them — Criterion 9 reads that history.
- A cell whose attacker return failed the evidence gate is OPEN, and MUST NOT be downgraded to `n/a`.

## The incentive-check register — template lives in the command

The register row template is in `commands/redteam.md` § C3, which reaches every CLI; it is repeated
here only as context for the routing guidance below. `rules/adversarial-coverage.md` MUST-3 runs on
EVERY clause offering an alternative, an exemption, a default, or a state meaning "not done" — not the
ones someone suspects. One register row per clause:

```
Clause:             <id>
Escape branch:      <what a payoff-maximising deployment does instead>
Cost of escape:     <…>
Cost of compliance: <…>
Verdict:            REQUIREMENT | PREFERENCE (escape ≤ compliance)
Fix if PREFERENCE:  route, don't excuse — declared, counted, and it forfeits something
```

"Route, don't excuse" means the escape stays available but becomes a DECLARED, COUNTED departure
that costs the matching conformance claim — so choosing it is visible and priced, rather than free.

## Warrants, and the code-target substitution

A finding cites the artefact that establishes it. A finding warranted only by an argument is a
HYPOTHESIS, is labelled one, and does not discharge a cell (`adversarial-coverage.md` MUST-4).

| Target class      | What counts as a warrant                                                     |
| ----------------- | ----------------------------------------------------------------------------- |
| Prose / normative | `file:line` opened and read; a command and its output; a parsed field list     |
| Code              | A failing test, a reproduction, a parsed AST result — from the project harness |

The R×P derivation is UNCHANGED for code targets; only the warrant class changes. Do not re-run a
suite that already ran this round — read its results and run only the new tests this round writes
(`rules/testing.md` § Audit Mode Rules).

## How the coverage conditions compose with the pre-existing criteria

`commands/redteam.md` § Convergence Criteria carries ten numbered criteria. Criteria 1–7 are the
pre-existing gating contract (severity floors, the evidence-gated clean-round counter, spec
compliance, new-code-has-new-tests, zero mock data, eval-harness green). Criteria 8–10 are the
coverage half this method adds. They COMPOSE — none replaces another:

- Criterion 3 is the YIELD condition. On its own it is exactly the false-convergence signal
  `adversarial-coverage.md` MUST-2 was written against; it gates only in conjunction with 8 and 9.
- Criterion 8 (coverage closed, every closure warranted) is the derivation's proof obligation, and it
  carries Criterion 4's anti-attestation floor: a cell warranted only by its own table row is OPEN.
- Criterion 10 (incentive register closed) is what makes a PREFERENCE verdict consequential — without
  it the most valuable attacker's output is published and gates nothing.
- Criterion 9 (questions stable) catches falling yield under an EXPANDING question set — the shape
  where old questions are exhausted while new ones are still producing on first pass.

A round reports all ten and names which failed. "Two clean rounds" alone is never a convergence
claim (MUST NOT-1: no convergence claim without a published coverage table).

## Ordering with /vet

Run `/vet` on a new draft BEFORE `/redteam`: a false premise makes every downstream adversarial
finding unreliable. Re-run `/vet` on anything `/redteam` fixes — a fix is a new draft, and fixes
introduce claim defects at the same rate drafts do.

## Related

- `rules/adversarial-coverage.md` — the normative contract (MUST 1–6, §3 derivation, §5 evidence)
- `commands/redteam.md` · `commands/vet.md` — the two commands this file backs
- `redteam-dispatch-evidence-gate.md` — errored/empty-is-zero-evidence + concurrency back-off
- `agent-result-delivery.md` — a result is not received until it is DELIVERED
- `dual-surface-redteam.md` — the fork seat classification consumed at `/redteam` Step 0.5
