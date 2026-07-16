# Reference Adapters — The Two Worked Examples

The adapter-registry interface (`adapter-registry-interface.md`) was not designed forward from zero — it was EXTRACTED as the intersection of two independently-built, independently-running conformance instances. This file distills those two REFERENCE adapters to the interface, as the worked examples a new adapter author copies. Each implements the three required methods (`enumerate_units`, `freeze_expectation`, `oracle`) plus the adapter obligations the core validates; they differ ONLY on the two predicted axes — the UNIT enumerated, and whether the oracle judges STATIC or against a LIVE post-state.

The two are named by the METHOD they encode, not by any repo: **SCM** (the static-symbol / BE adapter) and **TOW** (the route/interaction / FE adapter).

## 1. SCM — the static-symbol (BE) reference adapter

**Surface.** A code library / SDK. **Unit.** A public symbol — a function, struct, or enum on the exported surface. **Oracle stance.** STATIC: judges the symbol's conformance WITHOUT running the code.

### enumerate_units — every public symbol is the denominator

The BE adapter enumerates the complete public-symbol set from a doc/AST extraction pass over the crate/module — every exported function, type, and variant id. That full set IS the coverage denominator (machine-derived, never hand-listed): the honesty metric is the "un-expectationed frontier" — a public symbol that no spec anchor names — reported SEPARATELY from the pass/conformance counts, so a growing surface with no matching contract is visible as a coverage gap, not hidden in a pass-rate.

### freeze_expectation — pin the signature-hash + spec anchors into a committed baseline

For each symbol the BE adapter derives the cited-contract set (the spec anchors that name the symbol) and pins `{signature_hash, spec_anchors}` into a COMMITTED per-symbol baseline. That baseline is the frozen INTENDED column. Because a static symbol's expectation is knowable at extraction time, the freeze is a pure derivation — **the BE adapter does NOT use the capture-then-human-freeze lifecycle** (§3); its expectations never require observing a runtime to become knowable.

### oracle — judge signature + spec-conformance + test-tier + AST-tamper, without running

The BE oracle is pure-static. It judges, per symbol: signature match against the frozen hash, spec-conformance against the cited anchors, test-tier presence (is the symbol exercised?), and AST-level tamper (has the shipped shape drifted from the baseline?). All four are irrefutable structural facts derived from the tree — no process is launched.

**Verdict disposition.** The BE adapter partitions verdicts by whether the fact is STRUCTURAL or SEMANTIC. Structural statuses (a symbol with no test, no spec anchor, a drifted signature, a tampered AST) are load-bearing facts that MAY BLOCK the gate. The two SEMANTIC statuses (is the cited contract actually honored? is a boundary guarded?) are NOT machine-derivable — they route to an advisory pre-computed worklist for the adversarial round, never blocking.

**Self-recalibrating role-severity tier.** Severity = f(status, surface-role), never unit count. The BE adapter's role prior is evidence-driven and PROMOTION-ONLY: a surface with a hot defect history promotes ITSELF toward a blocking tier (from journals + a fix-history log + a curated cache), with no hardcoded denylist. A quiet surface stays advisory; a repeatedly-broken one earns blocking severity from its own record.

## 2. TOW — the route/interaction (FE) reference adapter

**Surface.** A rendered UI / interaction layer. **Unit.** A route plus its interactive elements. **Oracle stance.** LIVE: drives the running surface and judges the observed post-state AFTER freezing the expectation.

### enumerate_units — routes from the router AST + the interactive-element inventory

The FE adapter enumerates routes statically from the router definition (an AST walk) and flows/wire-contracts from the spec + a grep pass, then augments with a runtime inventory of interactive elements (the accessibility/DOM inventory of what a user can actuate on each route). The union is the machine-derived denominator; coverage is reported separately from pass/fail, and a verdict counts toward coverage only if it carries ≥1 real assertion (the no-vacuous guard).

### freeze_expectation — structural auto-derived, semantic captured-then-human-frozen

The FE adapter freezes in two tiers. The STRUCTURAL expectation (the mandatory floor: the route renders, the wired endpoint fires, a record reads back) is machine-derived automatically for every unit at zero authoring cost. The SEMANTIC expectation — the exact user-visible bytes a high-value journey must produce (a toast string, an error message, a rendered post-state) — is knowable ONLY at runtime, so **the FE adapter USES the capture-then-human-freeze lifecycle** (§3): on first run the exact bytes are CAPTURED, a human FREEZES them into the baseline, and only then do they assert. Exact expected bytes are never invented from memory.

### oracle — drive the live surface, read live post-state, judge after the freeze

The FE oracle is live. Its runners drive the running application through each frozen journey and read the LIVE post-state: which endpoint actually fired (network attribution), the post-action health of the surface, the accessibility/DOM fingerprint of the result. Each is judged AFTER the freeze — the expectation was pinned before the observation, so a different-than-expected live effect is a FAIL, never back-fitted to whatever the surface did.

**Value-ranked journey selection.** The FE adapter's severity emphasis is the VALUE-rank of the journey, not a defect-history tier: each critical journey carries a `rank` (1 = highest value) and a `value-anchor` citing a user-anchored source. This is the same "severity = f(status, surface-role), evidence-driven" abstraction as the BE tier — a different evidence source (user-anchored value vs defect history), same shape.

### static FE→backend wire-contract gate — the deterministic pre-check the live oracle cannot reach

The live oracle (above) judges the observed post-state of the journeys it can DRIVE — but a live walk only reaches what it can actuate at runtime: a route behind a modal it never opened, a call behind a feature flag it did not toggle, an action behind an auth state it did not enter. A **phantom wire** — an FE call to a backend route that does not exist — sitting behind an unopened dialog is invisible to the live oracle, because the walk never fired the call. The FE adapter closes that gap with a SECOND, STATIC oracle layered under the live one: a deterministic FE→backend wire-contract diff over EVERY call site, run without launching the surface.

- **Enumerate both sides mechanically (MUST-3 denominator discipline, applied to BOTH sides).** (a) the FE→backend **call set** — every site where the FE invokes a backend route (a `fetch`/client/generated-stub call), each reduced to a `(method, path)` pair; (b) the backend **route set** — every route the server registers, each a `(method, path)` pair. Both machine-derived from source, NEVER hand-listed. The BACKEND route set's completeness precondition is the route-registration completeness lesson in `coverage-honesty-contract.md` § "Enumerator completeness" (parse every registration surface). The FE call set is a BEST-EFFORT static extraction, NOT symmetric with the backend: an FE call whose path is DYNAMICALLY constructed (`fetch(\`${base}/users/${id}\`)`, a computed helper, a method held in a variable) may not be reducible to a static `(method, path)` — such a call site lands as a COVERAGE GAP per MUST-3 (reported, never silently counted clean), not force-fit into the diff.
- **Normalize to route-template form BEFORE diffing.** An FE call carries a CONCRETE path (`/users/123`); a backend route is a TEMPLATE (`/users/{id}`). Concrete FE paths MUST be normalized to the route-template form and matched by route-template PATTERN match, NOT `(method, path)` string/pair equality — plus method-case and trailing-slash canonicalization. A naive pair-equality diff flags `/users/123` a phantom against `/users/{id}` — a false phantom for EVERY parametrized route: the exact `coverage-honesty-contract.md` § "Enumerator completeness" gate-correctness defect arriving by a different mechanism (path-param normalization, not missed registration surfaces). Skip the normalization and the recipe below builds a false-positive machine.
- **Diff → the phantom set.** An FE call whose normalized `(method, route-template)` matches NO backend route is a **phantom** — it 404s at runtime (or 405s on a method mismatch — the path exists, the method is unregistered), whether or not any journey ever reaches it. The phantom set is a DETERMINISTIC finding and MAY hard-block the gate (`conformance-walk.md` MUST-2: the deterministic oracle is load-bearing; no model is in the loop, the same verdict every run — deterministic here means REPRODUCIBLE, not automatically correct, which is why the normalization step above is load-bearing).
- **Report coverage SEPARATELY from the phantom set (MUST-3).** Coverage = how many enumerated FE call sites were checked against the route set (denominator = all enumerated FE calls; a non-reducible dynamic call site is a coverage gap, not a silent pass); the phantom set is its OWN number — the fix-list — never collapsed into a single pass-rate. The mirror gap — a backend route with NO FE caller — is a DIFFERENT finding (a dead/uncovered route), surfaced separately, never counted as a phantom.
- **Complements, never replaces, the live walk.** Two layers, complementary (OVERLAPPING) reach — neither subsumes the other. The STATIC wire-contract gate uniquely catches an UNREACHABLE phantom (a call site the live walk never fires) with no runtime; the LIVE oracle uniquely catches a wrong-post-state a static diff cannot see (a route that EXISTS but returns the wrong body passes the wire gate and fails the live oracle). A REACHABLE phantom is caught by BOTH (statically: call site with no matching route; live: the fired call 404s). The residue neither layer catches — a DYNAMICALLY-constructed FE call to a nonexistent route behind an unopened dialog (static cannot enumerate the dynamic path; live never reaches it) — is exactly why the FE call set is reported as best-effort coverage, never a completeness claim.

## 3. Capture-then-human-freeze — the split the two adapters prove

The capture-then-human-freeze lifecycle is an OPTIONAL, core-owned protocol (`adapter-registry-interface.md`), and the two reference adapters land on opposite sides of it — which is exactly why it is OPTIONAL rather than part of the required three-method interface:

- **The BE adapter SKIPS it.** A static symbol's expectation (signature hash + spec anchors) is knowable at freeze time from the tree alone; there is nothing to observe at runtime, so capture-then-freeze would be dead ceremony. The BE oracle needs only the unit + the committed baseline.
- **The FE adapter USES it.** A live surface's exact expected bytes are knowable only once the surface runs; the semantic expectation MUST be captured on first run and human-frozen before it can assert. The structural floor is still auto-derived; only the semantic tier rides the capture lifecycle.

Keeping the lifecycle OPTIONAL and core-owned holds the required interface at three methods, so a THIRD adapter (endpoint / CLI / tool) is never forced to adopt a choice specific to one of the two founding instances.

## What the two prove

Two teams, two languages, two surfaces, no shared code — and both independently grew the SAME six-element core (the per-unit record schema, the coverage-honesty frontier, the freshness+collision ratchet, the two-tier oracle split, the discrete verdict taxonomy, the role-severity tier). They diverge on EXACTLY the two axes the adapter interface predicts, and nothing else:

1. **The unit enumerated** — a statically-extracted symbol (BE) vs a live route+interaction (FE).
2. **The oracle stance** — judged WITHOUT running (BE, static) vs judged AFTER freezing against a LIVE post-state (FE).

Every other element is shared; where the two differ WITHIN an element it is depth-of-maturity on the SAME abstraction, not a different one (the FE adapter ships the verdict set as a literal enum; the BE adapter ships the same partition as a disposition split — same taxonomy, different surface expression). That is the signature of a REAL core with adapter-specific realizations: the boundary was DISCOVERED by extracting the intersection of two running instances, not INVENTED forward. A new adapter copies these two — supplying its own unit-enumerator and oracle over the proven core — and inherits the record schema, coverage math, ratchet, verdict taxonomy, two-tier split, and role-severity tier unchanged.
