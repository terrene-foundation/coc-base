---
name: conformance-walk
description: Conformance Walk — freeze-then-judge verification: coverage vs pass-rate, discrete verdicts, the adapter-registry interface, the 5 surface adapters (BE/FE/API/CLI/MCP). Use for any testable surface.
---

# Conformance Walk (CW)

**One-liner.** ONE surface-neutral verification capability: enumerate every actionable unit of a surface → attach a FROZEN expectation → judge live/static state with a DETERMINISTIC oracle → report coverage HONESTLY (separate from pass-rate, machine-derived denominator) → RATCHET so a new unit without an expectation fails → TIER severity by surface-role. The core is built once; each surface supplies a small **adapter**. Users never choose "which method" — the matching adapter activates by the surface touched.

The four always-on MUST clauses are in `rules/conformance-walk.md`. This skill is the HOW: the methodology, the normative adapter-registry interface, the per-consumer adapter obligation, the 5-adapter table, the phase-action triggers, and the CW-vs-`/redteam` role split. Depth beyond the 80% here lives in three sub-files (loaded on demand): `adapter-registry-interface.md`, `coverage-honesty-contract.md`, `reference-adapters.md`.

## 1. The freeze-then-judge model (the heart)

- **Freeze BEFORE observe.** The expectation — the contract or transition a unit should hold — is pinned into a committed baseline BEFORE the unit is observed. An expectation back-fitted to whatever the code did is not an expectation.
- **Floor ≠ expectation.** "compiled / rendered / 200 / didn't crash" is the FLOOR. A different-than-expected effect is not a pass. (rule MUST-1.)
- **Two expectation tiers.** STRUCTURAL — machine-derived for every unit, zero hand-authoring cost, the mandatory floor of every unit. SEMANTIC — hand-authored or capture-then-human-freeze, only for the high-value units. Exact expected bytes (a toast string, an error message) are CAPTURED on first run and HUMAN-FROZEN before they assert — never invented from memory.

## 2. The expectation schema (the record every adapter emits)

One record per unit, four columns (surface-neutral):

- **ACTUAL** — what the surface exposes (signature/route/endpoint/flag/tool; observed state).
- **INTENDED** — the frozen expectation (contract / transition / status+schema+read-back).
- **CONFORMANCE** — the observed-vs-expected verdict + evidence.
- **LINKAGE** — edges to other units (a symbol exposed as an MCP tool surfaced in a FE route is ONE capability-record spanning symbol → endpoint → route; the integrated-linkage capture is the argument FOR unification).

## 3. Coverage vs pass-rate (the honesty contract)

- **Denominator is machine-derived** — enumerated from source/runtime, never hand-listed.
- **Coverage (nothing unmeasured) is reported SEPARATELY from pass-rate (verdict outcomes).** Two numbers, always. Coverage can be 100% while pass-rate is 80% — that is the honest state; the fails are the fix-list.
- **No-vacuous-eval guard** — a verdict counts toward coverage only if it carries ≥1 real assertion. Closes the `assert(true)` / `expect(true)` hole.
- **No fabricated 100%** by dropping non-pass rows or shrinking the denominator to the passing set.

Full machine-derived-denominator patterns per surface, the no-vacuous guard, the freshness+collision ratchet mechanics, and fail-closed integrity (empty-generation / mass-removal tripwires) are in `coverage-honesty-contract.md`.

## 4. The verdict taxonomy (discrete, closed)

`Pass | Fail | Blocked | Retest | Skipped | Not-Run`. `Blocked` (precondition down) ≠ Pass ≠ Fail. `Retest` (non-deterministic) ≠ Fail. `Skipped` (deliberately out of denominator). `Not-Run` (in denominator, never reached — a coverage gap, NOT a pass). (rule MUST-4.)

## 5. `pass^k` reliability

For a non-deterministic surface, a single Pass is weak evidence. Run the unit k times; report `pass^k` (k, passed, mean, std). A unit that passes 3/5 is `Retest`, not `Pass`. Reliability is a property of the verdict, not a separate gate.

## 6. The adapter-registry interface (NORMATIVE — design "A")

Each per-surface adapter supplies exactly three REQUIRED methods; the core owns everything else. This is the ratified freeze-line: the required interface is the INTERSECTION both shipped instances (SCM static-symbol, TOW route/interaction) already satisfy.

```
enumerate_units()            -> Iterable[Unit]     # machine-derived denominator; NEVER hand-listed
freeze_expectation(unit)     -> Expectation        # the frozen contract, pinned to the baseline BEFORE observation
oracle(unit, expectation)    -> Verdict            # deterministic; judges observed-vs-expected; from the discrete taxonomy

# Core-owned (surface-neutral): the {ACTUAL,INTENDED,CONFORMANCE,LINKAGE} record schema,
# coverage math (denominator + separate-from-pass-rate + no-vacuous guard), the freshness+
# collision ratchet over the committed baseline, the discrete verdict taxonomy, the two-tier
# oracle split (deterministic load-bearing / semantic advisory), the role-severity tier.
```

**Capture-then-human-freeze is an OPTIONAL core-owned lifecycle (design "A").** The three methods above are the REQUIRED interface. For an adapter whose exact expected bytes are only knowable at runtime (a live surface: a toast string, an error message, a rendered post-state), the core ALSO offers an OPTIONAL `capture-then-human-freeze` lifecycle: on first run the semantic expectation is `CAPTURE`d, a human FREEZES it, and only then does it assert. A static adapter (SCM) whose expectations are statically knowable simply does not use it; a live adapter (TOW) does. Keeping it OPTIONAL and core-owned holds the required surface at three methods so a third adapter is never blocked by a two-instance-specific choice.

**Adapter obligations the core validates:** emits the core record schema; derives its coverage denominator machine-side; freezes before it observes; its deterministic oracle is the gate and any semantic output is advisory. Full method contracts, the Unit/Expectation/Verdict types, the capture-then-human-freeze lifecycle, and a worked adapter skeleton per surface are in `adapter-registry-interface.md`.

## 7. Per-consumer adapter obligation

For EACH surface your repo exposes, supply an adapter implementing the three methods, emitting the core record schema, deriving its coverage denominator machine-side. A BE-only repo supplies only the static-symbol adapter (no FE/browser cost). An integrated repo supplies several adapters and the CORE captures the LINKAGE across them. This is the TOW (#1137) "per-template instantiation" generalized to all five surfaces. The adapter is NOT a cascaded loom file — the skill specifies the obligation; each repo authors its own adapters for the surfaces it exposes.

## 8. The 5 adapters

| Adapter                                  | Surface       | UNIT                        | Oracle (freeze → judge)                                                                               |
| ---------------------------------------- | ------------- | --------------------------- | ----------------------------------------------------------------------------------------------------- |
| **static-symbol (BE)** = SCM             | SDK / library | public fn / struct / enum   | signature + spec-conformance + test-tier + AST-tamper, judged WITHOUT running                         |
| **route/interaction (FE)** = TOW (#1137) | FE / UX       | route + interactive element | endpoint-fired + DOM/a11y read-back + record read-back, judged AFTER freezing the expected transition |
| **endpoint (API)**                       | HTTP / REST   | endpoint                    | status + response-schema + persisted-effect read-back                                                 |
| **flag (CLI)**                           | CLI           | subcommand / flag           | exit code + output-shape + state-effect read-back                                                     |
| **tool (MCP)**                           | MCP           | tool call                   | result-schema + side-effect read-back                                                                 |

Auto-activation by touched surface; the reference adapters are SCM (BE) and TOW (FE) — the other three are thin unit-enumerator + oracle over the proven core. The two reference implementations, distilled to the interface as the worked examples a new adapter author copies, are in `reference-adapters.md`.

## 9. Phase-action triggers

CW is a STANDING capability (record + CI gate always-on) with phase-specific ACTIONS. Freeze-then-judge requires the expectation to precede the observation, so declaration is upstream:

- **analyze:** enumerator runs → surface INVENTORY + baseline coverage (the un-expectationed frontier).
- **todos:** each todo adding a unit DECLARES its frozen expectation — the freeze, BEFORE code.
- **implement:** records populate incrementally; the FRESHNESS GATE fires — no new unit without a declared expectation.
- **redteam:** THE PRIMARY GATE — judge every unit, structural-BLOCK failures, hand the human the semantic-ADVISORY worklist.
- **codify:** absorb this round's findings into the role-severity tier prior (self-recalibration); record the frontier debt.
- **deploy (+ every CI run):** the freshness gate + collision ratchet stand as the structural merge gate — no ship with a coverage regression or a new-unit-without-expectation.

One line: **freeze @ todos → generate + freshness-gate @ implement → PRIMARY adversarial walk @ redteam → absorb + recalibrate @ codify → ratchet merge-gate @ deploy/CI.**

## 10. CW vs /redteam (role split — not a replacement)

CW is the STANDING, mechanical, PRE-`/redteam` gate: it front-loads the deterministic half (structural BLOCK on irrefutable facts) and hands the human a PRE-COMPUTED per-unit semantic-ADVISORY worklist — the exact unit + the exact question — instead of making the human rediscover it. `/redteam` remains the ADVERSARIAL human/agent judgment layer that adjudicates the advisory worklist and hunts for what no oracle can enumerate. CW makes `/redteam`'s budget go to ADJUDICATION, not discovery; it does NOT replace the adversarial round.

## 11. The role-severity tier (self-recalibrating)

Severity = f(verdict-status, surface-role), NEVER unit count. The role/value prior is evidence-driven and self-recalibrating (a defect-history-hot surface promotes ITSELF toward a blocking tier; a value-ranked journey carries a user-anchored value-anchor) — never a frozen hand-ranking, never a hardcoded denylist. Only irrefutable structural facts on a role-relevant unit BLOCK; semantic statuses are the advisory worklist.
