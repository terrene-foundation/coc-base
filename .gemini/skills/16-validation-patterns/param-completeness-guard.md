---
name: param-completeness-guard
description: "Structural guard closing the documented-kwarg-drop class: assert every declared constructor parameter reaches a real consumer, not just storage."
---

# Parameter-Completeness Guard

`zero-tolerance.md` Rule 3c states the PRINCIPLE — a documented kwarg accepted in a public
signature but with zero effect on the body IS the silent-fallback mode at the API surface.
**A principle is not a tripwire.** Rule 3c is a review-time obligation; nothing fails when a
new parameter is added and quietly stored. This sub-file specifies the STRUCTURAL guard that
turns the principle into an authoring-time test.

Origin: the class recurred THREE times on ONE constructor before it was structurally closed —
each occurrence a newly-documented parameter that was stored and never read again. A guard
shipped with the first fix would have failed the moment the second parameter landed.

## The invariant (language-neutral)

> Every parameter a public constructor/initializer DECLARES must reach a real CONSUMER —
> passed to a callee, tested in a branch, or transformed — somewhere other than its own
> storage assignment.

This invariant is language-neutral and applies to any multi-parameter facade in any language.
The concrete implementation is NOT: it requires that language's own syntax tree. The
`examples` slot below carries the reference implementation for this axis; other language
axes overlay their own.

## The discriminator

Parse the constructor's source and, for each declared parameter, compare two counts:

| Count           | What it counts                                                                        |
| --------------- | ------------------------------------------------------------------------------------- |
| `loads[p]`      | every READ of `p` (any load/value position)                                           |
| `store_only[p]` | every assignment whose ENTIRE right-hand side is the bare identifier `p` (pure store) |

**Flag when `loads[p] == store_only[p]`.** A pure storage assignment increments BOTH counts —
the right-hand side is a read, and the statement is a pure store — so a parameter that is only
stored nets equal and is flagged. Any ADDITIONAL read (a callee argument, a branch test, a
transform) tips `loads` over `store_only` and clears it.

Three properties the guard MUST hold:

1. **Both storage forms.** Plain assignment AND type-annotated assignment are both pure stores.
   Handling only one form silently exempts every parameter written the other way.
2. **Transform-on-store is consumption, deliberately.** `self._x = x or default` /
   `self._x = normalize(x)` is NOT flagged — the transform IS a consumer, and the extra read
   tips the comparison naturally. No special-casing required.
3. **Storage-attribute name is irrelevant.** The test is on the SHAPE of the assignment
   (RHS is the bare parameter), never on a naming convention like a leading underscore.

## Verifying the guard has teeth

The guard is a structural probe (`probe-driven-verification.md` MUST-3 — no LLM, no regex over
prose; deterministic and CI-cheap). Its own correctness needs the NEGATIVE pole proved, not
assumed: add a synthetic stored-only parameter in EACH storage form and confirm the guard REDS
on each.

Per `instrument-discipline.md` MUST-2(b), a mutation that does NOT red the guard leaves two live
hypotheses — a vacuous guard OR an inert mutation. Show the synthetic parameter actually reached
the parsed constructor before reading a non-reddening result as "the guard passed".

## When to add it

Ship the guard in the SAME change as the documented-kwarg fix it generalizes. A fix that closes
one instance without landing the class guard leaves the next parameter free to reintroduce it —
the recurrence this sub-file exists to stop.

<!-- slot:examples -->

Reference implementation — language-neutral pseudocode. The per-language axis overlays this
slot with its own syntax-tree walk.

```text
guard(constructor):
    tree        = parse(source_of(constructor))
    params      = declared_parameters(constructor)      # excluding the receiver/self
    loads       = counter()
    store_only  = counter()

    for node in walk(tree):
        if is_read_of_identifier(node) and node.name in params:
            loads[node.name] += 1
        if is_assignment(node) and rhs_is_bare_identifier(node) and node.rhs in params:
            store_only[node.rhs] += 1        # covers plain AND annotated assignment

    offenders = [p for p in params if loads[p] == store_only[p]]
    assert offenders == [], f"declared but never consumed: {offenders}"
```

<!-- /slot:examples -->

## Cross-references

- `zero-tolerance.md` Rule 3c — the principle this guard enforces structurally.
- `probe-driven-verification.md` MUST-3 — why this is a structural probe, not a lexical scan.
- `instrument-discipline.md` MUST-2(b) — the mutation-validity bar for proving the negative pole.
