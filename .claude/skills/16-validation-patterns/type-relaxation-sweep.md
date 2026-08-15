---
name: type-relaxation-sweep
description: "Depth for rules/type-relaxation-sweep.md MUST-1. Use when relaxing or widening a type constraint (keyof narrowing dropped, Optional widened, lifetime widened, union widened to its base), when reviewing such a change, or when asking 'is this extraction site guarded', 'type relaxation', 'ambient narrowing', 'was the type carrying a runtime guard'."
---

# Type-Relaxation Sweep — depth for `rules/type-relaxation-sweep.md`

The rule carries the MUST clause. This file carries the worked sites, the BLOCKED corpus, and the
evidence — read it before reviewing a relaxation, not after.

## Why a type change deletes a guard nobody wrote

A constraint can perform a runtime check without any check existing in the source. When an index is
typed `K extends keyof T`, every `obj[k]` is narrowed by construction: the compiler has proven the
key is present, so no author ever wrote a presence test. Relax `K` to `string` and the proof
evaporates — but there is no guard line to delete, no diff hunk to review, and no compiler error,
because the relaxation is precisely what stops the compiler objecting.

This is why the sweep must run **against the proposed type, at analysis time**. After
implementation, every affected site has already been read once and mentally marked safe; the second
read inherits the first read's verdict.

## The two inventories

**Extraction sites** — expressions that pull a value out under the relaxed type:

```ts
const cell = row[col.field];          // TS: was keyof-narrowed, now any string
```

```python
name = user.profile.display_name      # Py: profile was Optional[Profile] -> now may be None
```

```rust
let s = cache.get(&k).unwrap();       // Rust: lifetime/bound widened; entry may now be absent
```

**Render sites** — expressions that consume an already-extracted value:

```tsx
<td>{cell ?? "—"}</td>                {/* safe OUTPUT; says nothing about the extraction */}
```

The coalesce makes the rendered cell safe. It does not make `row[col.field]` safe: under the relaxed
type that expression can now be `undefined` where it previously could not, and every other consumer
of `cell` — a comparator, a sum, a key into a second map — inherits the unguarded value. The failure
then surfaces somewhere with no coalesce, as a value the type says is impossible.

## Worked failure

A data-table engine relaxed its column-field type from a `keyof`-constrained parameter to a bare
string, to allow computed columns. A review pass inventoried the seven `row[col.field]` sites and
classified all seven "already safe — coalesce", reasoning from the render-side `??` that followed
each one. All seven were in fact unguarded extractions whose safety had been supplied entirely by
the dropped `keyof` bound. The single-pass inventory could not have found them: it was looking for
missing guards, and there had never been any guards to be missing.

## BLOCKED rationalizations

- "the render coalesce protects it, so the extraction is fine" — opposite directions of dataflow
- "the type system narrows it everywhere, no runtime check needed" — it *did*; the change removes that
- "the relaxation is type-system-only, no runtime impact" — the runtime impact IS the removed narrowing
- "the compiler would have caught it" — the relaxation is what stops it objecting
- "all sites pattern-match as already-safe in the existing inventory" — the inventory predates the change
- "the surrounding code is well tested, the extraction is implicit" — tests exercise the OLD type
- "we'll catch it at implement time" — by then each site carries a prior safe verdict

## Cross-language applicability

| language | the ambient narrowing that is lost | typical unguarded extraction |
| --- | --- | --- |
| TypeScript | `K extends keyof T` proving key presence | `obj[k]` |
| Python | `Optional[X]` forcing a None check at the type boundary | `x.attr` after widening |
| Rust | a lifetime/trait bound guaranteeing the referent outlives use | `.unwrap()` on a widened lookup |

**Dart is excluded, deliberately.** The proposal's originating red-team dropped the Dart claim:
sound null safety has no analogous *ambient* narrowing to lose, because the nullability is always
explicit in the type and the compiler requires the check regardless. Reading Dart's null-safety
migration as an instance of this class would be a false cognate — the same reason the rule's `paths:`
carries no `.dart` glob.

Origin: 2026-08-10 — `/sync-from-build` `build.prism` Gate-1 ingest of proposal candidate
`type-relaxation-surface-sweep` (stream pinned at blob `6309373`), placed as a `rule-authoring.md`
Rule 10 path-(a) paired extraction: the rule holds the contract, this file holds the depth, under
measured path-scoped profile pressure where the full clause text would have breached the
`consumer-test` ceiling. The originating evidence is the data-table relaxation in § Worked failure;
BUILD-internal identifiers are genericized, the failure shape carries verbatim because it is the
evidence.
