---
name: gold-typescript-phantom-fields
description: "TypeScript phantom fields for type-parameter symmetry under noUnusedLocals / TS6133. Use when asking 'unused type parameter', 'TS6133', 'noUnusedLocals', 'phantom field', 'type parameter symmetry', 'paired interface generics', or when a reviewer is about to delete a field that looks like dead code but is type-system-only."
---

# Gold Standard: TypeScript Phantom Fields For Type-Parameter Symmetry

> **Skill Metadata**
> Category: `gold-standards`
> Priority: `MEDIUM`
> Language: **TypeScript only** — see § Scope

## The problem

TypeScript strict mode (`noUnusedLocals` / TS6133) rejects a type parameter that a declaration
never references in its body. That is usually correct. It is wrong for **paired interfaces kept
deliberately symmetric** — `Result<T, TFilters>` alongside `Input<T, TFilters>` — where one member
of the pair genuinely uses both parameters and the other uses only one. The symmetry is the
contract; deleting the parameter to satisfy the compiler breaks the pair, and callers then have to
remember which member takes which arity.

## The convention

Anchor the unused parameter with a **phantom field**: an optional, readonly, always-`undefined`
member that exists only in the type signature.

```ts
// DO — the parameter is anchored, the pair stays symmetric, the intent is legible
export interface DataTableResult<T, TFilters> {
  rows: T[];
  /** @phantom type-system-only; always `undefined` at runtime. Load-bearing: anchors
   *  TFilters so this stays arity-symmetric with DataTableInput<T, TFilters>. */
  readonly __filterShape?: TFilters;
}

// DO NOT — drop the parameter to silence TS6133 (breaks the pair)
export interface DataTableResult<T> {
  rows: T[];
}

// DO NOT — anchor with a runtime-visible field (it now serializes, and it is a lie)
export interface DataTableResult<T, TFilters> {
  rows: T[];
  filterShape: TFilters; // present at runtime; every construction site must now supply it
}
```

**Naming:** `__<concept>` — `__rowType: T`, `__inputShape: TInputs`, `__filterShape: TFilters`. The
double underscore is the signal that the member is not addressable.

**Tag it `@phantom`, and say it is load-bearing in the same comment.** A field that is `readonly`,
optional, never written, and never read is exactly what a cleanup pass deletes. The JSDoc tag is
what makes the next reader — human or agent — stop. Without it the convention actively invites the
regression it exists to prevent.

## Scope — TypeScript only, and the reason is mechanical

This is a TS convention, not a cross-language one, and the generalization was tried and dropped:

- **Rust** `PhantomData<T>` solves a different problem by a different mechanism — a zero-sized type
  for variance and drop-check, not an optional field dodging an unused-parameter diagnostic.
- **Dart / other sound-null-safety languages** have no analogous diagnostic, so there is nothing to
  anchor around.
- **Python** type parameters are not subject to an equivalent unused-parameter error.

Read a `PhantomData` field in Rust as an instance of this convention and you will reach for the
wrong tool; the surface rhyme is not a shared failure mode.

## Review checklist

- Is the field `readonly` AND optional? (If not, every construction site must supply it.)
- Is it named `__<concept>`?
- Does the comment carry `@phantom` AND state what it anchors?
- Is the pair it preserves actually declared? A phantom field with no symmetric sibling is not
  this convention — it is an unused field, and it should go.

Origin: 2026-08-10 — `/sync-from-build` `build.prism` Gate-1 ingest of proposal candidate
`phantom-field-noUnusedLocals` (stream pinned at blob `6309373`). Second observed instance of the
phantom-for-symmetry pattern in a frontend engine package. The proposal was RECLASSIFIED by its own
originating red-team from a cross-language rule to a TypeScript skill convention — the
"cross-language" framing did not survive contact with `PhantomData` or with sound null safety — and
Gate-1 placed it accordingly: skill channel, no rule, no language variant. It lands GLOBAL rather
than on a language overlay because TypeScript is the frontend language across every lane, not one
lane's language.
