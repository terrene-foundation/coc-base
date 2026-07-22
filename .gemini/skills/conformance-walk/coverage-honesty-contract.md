# Coverage-Honesty Contract

Depth for SKILL.md §3 (coverage vs pass-rate) + §5 (`pass^k`), expanding the normative anchor `rules/conformance-walk.md` MUST-3. The core owns everything here; an adapter supplies only the machine-derived unit enumerator + the oracle. This file specifies how the core makes "nothing unmeasured" a checkable claim rather than a fabricated banner.

## 1. The machine-derived denominator, per surface

The denominator is the count of units `enumerate_units()` returns — enumerated from source or runtime, NEVER hand-listed. Each surface derives its total unit set mechanically; the count is `|enumerate_units()|` and it IS the coverage denominator. Synthetic patterns, one per reference surface:

- **SOURCE / BE (static-symbol adapter).** Enumerate every public symbol (fn / struct / enum / trait) from a symbol-enumeration source — an AST walk of the source tree, or a doc-JSON symbol dump (rustdoc-JSON / typedoc / a language's introspection export). The denominator is the count of public symbols the surface exposes; a private/un-exported symbol is out of the denominator by construction.
- **DELIVERED (shipped-artifact adapter).** Enumerate the capabilities the expected-capability manifest declares the artifact MUST deliver (`must_deliver`), rendered against the artifact's resolved feature set (ONE named profile token extracted from the wheel build tool). The denominator is the manifest's owed-capability count under that profile — machine-anchored to the COMMITTED manifest, NEVER inferred from whatever the build emitted (inferring makes the artifact its own spec, so a silently-dropped feature reads "conformant" because nothing declared it owed). Deliberately-optional capabilities carry a positive `allowlisted_optional` marker (owner + reaffirm-by) and land as `Skipped`, never dropped from the denominator.
- **FE (route/interaction adapter).** Enumerate routes from the router definition's AST (the route table the app registers) plus the interactive elements reachable on each route (a runtime DOM/a11y inventory). The denominator is `routes + interactive-elements-per-route`.
- **API (endpoint adapter).** Enumerate endpoints from the endpoint registry / router table (method + path pairs the server binds). The denominator is the count of registered endpoints.
- **CLI (flag adapter).** Enumerate the subcommand tree + each subcommand's declared flags from the parser definition (the command/flag registry the CLI builds). The denominator is `subcommands + flags`.
- **MCP (tool adapter).** Enumerate the registered tool set from the tool registry the server advertises. The denominator is the count of exposed tools.

The rule is identical across all five: read the total unit set from the surface's own authoritative registry, never from a maintained list a human edits. A hand-listed denominator silently shrinks to whatever the author remembered to include — the exact fabrication MUST-3 blocks.

## 1a. Enumerator completeness — read EVERY registration surface, or the gate is wrong

"Read from the surface's own authoritative registry" (§1) carries a correctness precondition that is easy to miss: the enumerator MUST parse EVERY way a unit can be registered on that surface. A framework almost always exposes MULTIPLE registration surfaces for the SAME unit kind. For HTTP routes, a single framework typically registers routes via (i) app-level decorators on the app object itself (`@app.route(path, methods=[...])` / `@app.get(...)`); (ii) mounted sub-router / router-object decorators (`@router.get(...)` on a SEPARATE router object later `include`d or mounted under a prefix — so the route's full path is the prefix + the decorator path, composed, not literal); and (iii) decorators whose receiver is an ARBITRARILY-NAMED variable (`@<var>.route(path, methods=[...])`) — the lesson here is that the enumerator MUST match on the decorator METHOD (`.route`/`.get`/…), NEVER on a hardcoded receiver name like `app`, or it misses every router bound to a differently-named variable. An enumerator that parses ONE of these surfaces silently omits every unit registered via the others — it reads a PARTIAL registry and reports it as the whole.

A one-surface parser fails in two distinct ways, and the second is worse than a coverage undercount:

- **Denominator undercount (the §1 failure, one surface over).** The missed units drop out of `enumerate_units()`, so they vanish from the coverage denominator — the same fabricated-by-omission "100%" §1 blocks, caused not by a hand-list but by an incomplete parser reading a real registry partially.
- **Diff over-report (a gate-CORRECTNESS defect).** When the incomplete enumerator feeds a DIFF — e.g. the FE→backend wire-contract gate (`reference-adapters.md` § "static FE→backend wire-contract gate": FE-calls − backend-routes → phantom set) — the routes it FAILED to enumerate look like they do not exist. An FE call to a real-but-unenumerated route is then falsely flagged a PHANTOM. The gate reports phantoms that are not phantoms.

A gate that flags real routes as phantoms is a gate-**correctness** defect, NOT noise to be tuned down. A false-positive gate trains operators to override it, and an overridden gate catches nothing — the same "override-noise" failure `conformance-walk.md` MUST-2 blocks for non-deterministic verdicts, here caused by an incomplete deterministic enumerator. "It over-reports a bit, filter the known-good ones" is the rationalization that converts a correctness bug into permanent suppression.

```text
# DO — enumerate over the UNION of every registration surface the framework supports
routes = parse(app-level decorators) ∪ parse(mounted-router decorators) ∪ parse(@<var>.route(...))
→ complete registry → the wire-contract diff's phantom set is trustworthy

# DO NOT — parse one surface, treat the rest as absent
routes = parse(app-level decorators only)
→ every @router.get(...) route is missing → an FE call to it is a FALSE phantom
→ the gate is WRONG (over-reports), not merely noisy
```

The discipline: enumerate over the UNION of every registration surface the framework offers for that unit kind, and treat a one-surface parser as a KNOWN-INCOMPLETE enumerator that FAILS the machine-derived-denominator contract (MUST-3) — an incomplete enumerator corrupts BOTH the denominator AND any diff built on it. Where the framework exposes its OWN resolved registry (a route-table dump like a resolved URL map, an OpenAPI/introspection export, a command/flag registry), that resolved registry is the completeness CROSS-CHECK (a ground-truth reference — NOT the reserved interface-method `oracle` of SKILL.md §6) for the static enumerator: cross-check the static enumeration against it, and a mismatch is an enumerator bug, not a surface finding. This cross-check is a SEPARATE validation step from the launch-free static diff — obtaining a resolved registry typically requires app-construction-time introspection (importing the app / instantiating the router), so it runs once in CI to VALIDATE the enumerator, not on every per-diff run.

## 2. Coverage is reported SEPARATELY from pass-rate — two numbers, always

Coverage answers "is every enumerated unit measured?" Pass-rate answers "how many measured units passed?" They are DIFFERENT numbers over the same denominator and MUST NEVER be collapsed into one figure.

```text
# DO — two separate numbers over a machine-derived denominator
Denominator = 214 units enumerated from the registry.
Coverage:  214/214 measured (100%)   — nothing unmeasured
Pass-rate: 190/214 pass, 24 fail     — the 24 fails ARE the fix-list
→ Coverage 100% while pass-rate 88.8% is the HONEST state, not a contradiction.

# DO NOT — collapse coverage into pass-rate, or shrink the denominator to the passing set
"We measured 190 units and they all pass → 100%."
(the 24 failing units vanished from the denominator; "100%" is fabricated by omission)
```

Coverage 100% with pass-rate 80% is the state to REPORT proudly — it means nothing is unmeasured and the failures are known. A single "100%" that conflates the two is the tell that the denominator was quietly narrowed to the units that pass.

## 3. The no-vacuous-eval guard

A verdict counts toward coverage ONLY if it carries ≥1 real assertion against observed state. A verdict with zero assertions — a test that runs and asserts nothing, an oracle that returns Pass without comparing anything — is NOT coverage; it is an un-measured unit wearing a green hat. This closes the `assert(true)` / `expect(true)` hole where a unit is "covered" by a check that can never fail.

```text
# DO — the unit's verdict rests on a real assertion
oracle(unit): fire the unit, read the observed effect, assert observed == frozen-expectation
→ counts toward coverage (a real comparison happened; it can fail)

# DO NOT — a verdict with no assertion counts as coverage
oracle(unit): call the unit, return Pass         # nothing compared
test_unit(): unit(); expect(true)                # asserts a tautology
→ MUST NOT count toward coverage — assertion_count == 0 → excluded from the covered set (a coverage gap), not Pass
```

The core enforces this by requiring each verdict to carry an assertion count; a verdict with `assertions < 1` is excluded from the covered set and surfaced as a coverage gap.

## 4. The freshness + collision ratchet

Coverage is only durable if it cannot silently decay. A committed **baseline** pins the frozen expectation set — the units that were expected as of the last accepted state. The ratchet runs at the merge gate:

- **Freshness (new-unit-without-expectation FAILS the gate).** A NEW unit present in `enumerate_units()` but ABSENT from the committed baseline is a freshness finding that FAILS the merge gate. Freeze-then-judge requires the expectation to PRECEDE the unit; a unit that appears with no frozen expectation has skipped the freeze, so it cannot be honestly judged and the gate refuses it. This is what makes "100%" durable — coverage cannot decay by adding un-expectationed units.
- **Coverage regression FAILS the gate.** If the covered fraction drops relative to the baseline — a previously-measured unit is no longer measured — the gate fails. Coverage ratchets up or holds; it never silently ratchets down.
- **Unit-id collisions are counted + surfaced.** Two distinct units resolving to the same grep-stable join id is a collision — it silently under-counts the denominator (two units collapse to one row). The core COUNTS collisions and surfaces the count as a finding; a collision is never silently merged.

```text
# DO — new unit carries a frozen baseline expectation before it merges
enumerate_units() yields unit X; baseline contains X's frozen expectation → judged, counts.

# DO NOT — a new unit slips in with no baseline entry
enumerate_units() yields unit Y; baseline has no Y → FRESHNESS FINDING → gate FAILS
(Y skipped the freeze; judging it now would back-fit the expectation to whatever Y did)
```

## 5. Fail-closed integrity tripwires

Two enumerator failure modes would let a dishonest 100% ship. Both fail CLOSED — refuse, do not report:

- **Empty-generation.** If `enumerate_units()` returns ZERO units, the core MUST REFUSE — it does NOT report "100% of nothing." Zero units almost always means the enumerator broke (wrong root, parse failure, empty registry read), not that the surface has no units. Reporting 100% coverage over an empty denominator is the most seductive fabrication; the tripwire treats an empty enumeration as an integrity failure, not a clean sweep.
- **Mass-removal.** If the enumerated set drops sharply relative to the committed baseline — a large fraction of previously-present units vanished from `enumerate_units()` — the core MUST REFUSE or FLAG, not silently shrink the denominator. A denominator that collapses lets pass-rate leap to 100% because the failing units are simply gone from the count. The tripwire compares the current unit set against the baseline size and halts on a mass drop until a human confirms the removal was intended.

```text
# DO — empty enumeration halts as an integrity failure
enumerate_units() → []  → REFUSE: "enumerator returned zero units; coverage UNKNOWN"

# DO NOT — report a clean sweep over nothing
enumerate_units() → []  → "coverage 0/0 = 100%"   # fabricated; the enumerator broke
```

## 6. `pass^k` — reliability for non-deterministic surfaces

On a non-deterministic surface (a live UI, a network-touching endpoint, a flaky integration), a single Pass is weak evidence — the unit may pass once and fail the next run. The core runs such a unit `k` times and reports `pass^k`: the tuple `(k, passed, mean, std)`. Reliability is a property OF the verdict, not a separate gate.

```text
# DO — run k times, report the reliability tuple; a partial pass is Retest
unit run k=5 → passed 5/5 (mean 1.0, std 0.0) → Pass
unit run k=5 → passed 3/5 (mean 0.6, std ...) → Retest   (NOT Pass — non-deterministic)

# DO NOT — one green run declared Pass on a non-deterministic surface
unit run once → Pass   # a re-run may flip it; the single sample hides the flakiness
```

A unit that passes 3/5 is `Retest`, never `Pass` — it is a distinct verdict in the discrete taxonomy (SKILL.md §4), so a flaky unit can never masquerade as a reliable one. Deterministic surfaces (static-symbol / endpoint-with-fixed-state) run `k=1` by construction; the `pass^k` machinery is inert for them and load-bearing only where re-runs can disagree.
