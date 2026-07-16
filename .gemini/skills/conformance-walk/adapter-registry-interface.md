# The Adapter-Registry Interface (NORMATIVE — design "A")

On-demand depth for SKILL.md §6. Each per-surface adapter supplies exactly **three
REQUIRED methods**; the core owns everything else (the record schema, coverage math,
the freshness+collision ratchet, the discrete verdict taxonomy, the two-tier oracle
split, the role-severity tier). This file is the full normative contract of those three
methods, the three core types they exchange, the OPTIONAL capture-then-human-freeze
lifecycle, and a worked skeleton per surface. The interface is language- and
surface-neutral — the pseudocode below is illustrative, not any one runtime.

## The three REQUIRED methods

```
enumerate_units()          -> Iterable[Unit]        # the machine-derived denominator
freeze_expectation(unit)   -> Expectation           # the frozen contract, BEFORE observation
oracle(unit, expectation)  -> Verdict               # deterministic; judges observed-vs-expected
```

### `enumerate_units() -> Iterable[Unit]`

- **Input:** none (the adapter reads its own surface — a source tree, a router, an OpenAPI
  doc, a CLI arg-spec, a tool manifest).
- **Output:** the COMPLETE set of actionable units on the surface. This set IS the coverage
  denominator.
- **Invariant:** the set MUST be derived from source or runtime, NEVER hand-listed. A unit
  omitted here is invisible to every downstream step — it cannot be measured, so it can never
  be a coverage gap the ratchet catches. Enumeration is total-or-nothing.
- **Core validates:** `|enumerate_units()|` is the denominator; the core refuses a
  hand-authored count and (via the ratchet) fails the gate when the committed baseline's unit
  set shrinks with no matching removal record.

### `freeze_expectation(unit) -> Expectation`

- **Input:** one `Unit`.
- **Output:** the frozen `Expectation` — the observable contract or transition the unit SHOULD
  hold — pinned into the committed baseline.
- **Invariant (freeze-then-judge):** the expectation MUST be committed BEFORE the unit is
  observed. An expectation back-fitted to whatever the surface did is not an expectation — it
  is a description. Every unit gets at minimum the machine-derived STRUCTURAL floor; only
  high-value units get a hand-authored/captured SEMANTIC expectation.
- **Core validates:** the expectation lives in the committed baseline; the ordering invariant
  (freeze precedes observe) is the property the ratchet enforces — a NEW unit with no frozen
  expectation fails the gate.

### `oracle(unit, expectation) -> Verdict`

- **Input:** one `Unit` and its frozen `Expectation`.
- **Output:** one `Verdict` from the discrete taxonomy, carrying evidence.
- **Invariant:** the DETERMINISTIC half yields the same verdict on every run with no model in
  the loop — it is the load-bearing gate. Any SEMANTIC/LLM judgment the oracle emits is
  ADVISORY-only (a pre-computed worklist row) and MUST NOT hard-fail the gate.
- **Core validates:** the deterministic verdict counts toward coverage only if it carries ≥1
  real assertion (no-vacuous guard); the semantic output routes to the advisory worklist, never
  the CI verdict.

## The three core types

- **`Unit`** — surface-neutral. A grep-stable **join-id** + the **surface** it belongs to +
  the **ACTUAL** fields the surface exposes (a signature, a route+element, an endpoint, a
  flag, a tool name — plus any observed state). The join-id is what lets the core carry a
  LINKAGE edge across surfaces (one capability spanning symbol → endpoint → route is ONE
  record keyed by a shared id).
- **`Expectation`** — the frozen INTENDED contract, carrying a **tier**:
  - `STRUCTURAL` — machine-derived for EVERY unit, zero hand-authoring cost, the mandatory
    floor. Deterministic; load-bearing.
  - `SEMANTIC` — hand-authored OR capture-then-human-freeze, only for high-value units. Its
    exact expected bytes (a message string, a rendered post-state) are advisory / worklist,
    never invented from memory.
- **`Verdict`** — one member of the discrete closed set
  `Pass | Fail | Blocked | Retest | Skipped | Not-Run`, plus **evidence** (the observed value,
  the assertion count, the linkage). `Blocked` (precondition down) ≠ Pass ≠ Fail; `Retest`
  (non-deterministic) ≠ Fail; `Not-Run` (in the denominator, never reached) is a coverage gap,
  NOT a Pass.

## The OPTIONAL capture-then-human-freeze lifecycle (core-owned)

The three methods above are the REQUIRED interface. For a **live-surface adapter** whose exact
expected bytes are only knowable at runtime, the core ALSO offers an OPTIONAL
`capture-then-human-freeze` lifecycle for SEMANTIC expectations:

```
first run:   observe the live value → CAPTURE it into the baseline as UNFROZEN
human step:  a person reviews the captured value → FREEZE it (marks it asserting)
later runs:  the frozen SEMANTIC expectation now asserts, deterministic thereafter
```

**This lifecycle is OPTIONAL.** A **static adapter**, whose expectations are statically knowable
(a signature, a spec anchor), simply does NOT use it — `freeze_expectation` pins the value
directly. A **live adapter** (rendered strings, post-states) DOES use it, so its bytes are
human-frozen rather than guessed. Keeping capture OPTIONAL and core-owned holds the required
surface at exactly three methods, so a NEW adapter is never blocked by a choice specific to one
existing instance.

## What the core validates about every adapter

An adapter is conformant only if it: (1) emits the core record schema
`{ACTUAL, INTENDED, CONFORMANCE, LINKAGE}`; (2) derives its coverage denominator machine-side;
(3) freezes each expectation BEFORE it observes; (4) its deterministic oracle is the gate and
any semantic output is advisory. These are the four adapter obligations the core checks; the
core supplies the schema, the coverage math, the ratchet, the taxonomy, and the severity tier.

## Worked adapter skeletons (one per surface)

Each skeleton implements the same three methods over a different unit + oracle. Pseudocode is
compact and neutral.

### static-symbol (BE) — a library / SDK surface, judged WITHOUT running

```
adapter StaticSymbol:
  enumerate_units():
    for sym in load_public_api(source_tree):        # from a symbol-index, not hand-listed
      yield Unit(id=sym.path, surface="BE", actual=sym.signature)
  freeze_expectation(unit):
    return Expectation(STRUCTURAL, {sig_hash: hash(unit.actual),
                                    spec_anchors: cited_contract(unit)})   # pinned to baseline
  oracle(unit, exp):
    if hash(current_sig(unit)) != exp.sig_hash: return Verdict(Fail, drift=...)
    if not has_test(unit):                          return Verdict(Fail, untested=...)
    return Verdict(Pass, evidence=exp.spec_anchors) # judged statically, never executed
```

### route/interaction (FE) — judged AFTER freezing the expected transition

```
adapter RouteInteraction:
  enumerate_units():
    for r in derive_routes(app) + derive_interactions(app):   # static + runtime inventory
      yield Unit(id=r.interaction_id, surface="FE", actual=r.current_state)
  freeze_expectation(unit):
    struct = derive_structural(unit)                # the mandatory floor, machine-derived
    return Expectation(STRUCTURAL, struct)          # SEMANTIC bytes captured live (optional lifecycle)
  oracle(unit, exp):
    drive_ui(unit)                                  # live: fire the interaction
    if not endpoint_fired(unit):     return Verdict(Fail, no_effect=...)
    if not readback_matches(unit,exp): return Verdict(Fail, transition=...)
    return Verdict(Pass, evidence=post_state(unit))
```

### endpoint (API) — status + response-schema + persisted-effect read-back

```
adapter Endpoint:
  enumerate_units():
    for e in load_api_spec(surface):                # from the route/OpenAPI table
      yield Unit(id=e.method+" "+e.path, surface="API", actual=e.contract)
  freeze_expectation(unit):
    return Expectation(STRUCTURAL, {status: unit.actual.status,
                                    schema: unit.actual.response_schema,
                                    persists: unit.actual.write_effect})
  oracle(unit, exp):
    resp = call(unit)
    if resp.status != exp.status:            return Verdict(Fail, status=resp.status)
    if not schema_ok(resp, exp.schema):      return Verdict(Fail, schema=...)
    if exp.persists and not readback(unit):  return Verdict(Fail, not_persisted=...)
    return Verdict(Pass, evidence=resp)
```

### flag (CLI) — exit code + output-shape + state-effect read-back

```
adapter CliFlag:
  enumerate_units():
    for f in derive_flags(arg_spec):                # subcommands + flags, machine-derived
      yield Unit(id=f.subcommand+" "+f.flag, surface="CLI", actual=f.spec)
  freeze_expectation(unit):
    return Expectation(STRUCTURAL, {exit: unit.actual.exit_code,
                                    output: unit.actual.output_shape,
                                    effect: unit.actual.state_effect})
  oracle(unit, exp):
    run = invoke(unit)
    if run.exit != exp.exit:                  return Verdict(Fail, exit=run.exit)
    if not output_ok(run.out, exp.output):    return Verdict(Fail, output=...)
    if exp.effect and not readback(unit):     return Verdict(Fail, no_effect=...)
    return Verdict(Pass, evidence=run)
```

### tool (MCP) — result-schema + side-effect read-back

```
adapter McpTool:
  enumerate_units():
    for t in list_tools(server):                    # from the tool manifest
      yield Unit(id=t.name, surface="MCP", actual=t.result_schema)
  freeze_expectation(unit):
    return Expectation(STRUCTURAL, {schema: unit.actual,
                                    side_effect: side_effect_of(unit)})
  oracle(unit, exp):
    result = call_tool(unit)
    if not schema_ok(result, exp.schema):        return Verdict(Fail, schema=...)
    if exp.side_effect and not readback(unit):   return Verdict(Fail, no_effect=...)
    return Verdict(Pass, evidence=result)
```

Across all five: the METHODS are identical; only the UNIT enumerated and whether the oracle
judges statically or against a live post-state vary — the two adapter axes design "A" names. A
new surface supplies its unit-enumerator + oracle over the proven core, and inherits schema,
coverage math, ratchet, taxonomy, and severity for free.
