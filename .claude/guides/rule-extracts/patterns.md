# Kailash Pattern Rules — Extended Evidence and Examples

Companion reference for `.claude/rules/patterns.md`. Holds the runnable detail,
worked examples, measured incident narratives, and per-instance provenance moved
out of the rule body so the rule stays inside its path-scoped injection budget.
Everything here is EVIDENCE — every MUST, MUST NOT, BLOCKED-rationalization
entry, DO/DO-NOT block, and failure-mode `**Why:**` statement stayed in the rule.

## contextvars thread-boundary

Moved verbatim from the rule's § "Propagate Caller Context Across Every Thread-Boundary Dispatch (MUST)" `**Why:**` line:

> Snapshotting `copy_context()` in the caller frame and running via `ctx.run(...)` matches the `asyncio.to_thread` convention.

That convention is why the rule's DO example snapshots in the CALLER frame rather
than inside the callable: by the time the executor thread runs, the caller's
context is already gone, so a snapshot taken there captures the default context
and reproduces the exact de-scoping the rule blocks. The fresh `ctx.copy()` per
dispatch is the second half of the contract — one `Context` cannot be entered
concurrently, so a fan-out sharing a single snapshot raises instead of silently
de-scoping.

## Async-pair evidence

Depth for the rule's § "Paired Public Surface — Consistent Async-ness (MUST)".

### The async contexts that carry a running loop

Moved verbatim from the rule's MUST paragraph:

> Agents, Nexus handlers, pytest-asyncio tests, and Jupyter kernels all run inside an active event loop; a sync function that internally calls `asyncio.run()` raises `RuntimeError: This event loop is already running` in every async caller.

Moved verbatim from the rule's `**Why:**` line:

> Every modern Python async context — `pytest.mark.asyncio`, Nexus's async HTTP handlers, Jupyter's IPKernel, any Kaizen agent loop — has a running loop.

### The "both shapes" trap

Moved verbatim from the rule's `**Why:**` line:

> The "both shapes" trap (offering `km.register` sync AND `km.register_async`) doubles the public API surface, forces every caller to remember which variant their context permits, and ships two implementations of the same primitive that drift.

The corresponding linguistic tripwire stays in the rule body as the first BLOCKED
rationalization ("Notebook users want sync; agent users want async; we'll offer
both shapes").

### Evidence — kailash-ml 1.0.0 W33 / W33c

Moved verbatim from the rule's `**Why:**` line:

> Evidence: kailash-ml 1.0.0 W33/W33c — `km.train` was async (W33), `km.register` landed sync (W33c) with internal `asyncio.run()`; the canonical 3-line Quick Start `result = await km.train(...); registered = km.register(result, ...)` crashed in every async context. Fix commit `fdd3040e` converted `km.register` to `async def`, matching `km.train`.

Origin, moved verbatim: kailash-ml-audit session 2026-04-23 — W33c async/sync inconsistency caught by end-to-end README regression test.

## Callable-module evidence

Depth for the rule's § "Callable Module + Subpackage Coexistence (MUST — PEP 562)".

### How the shadowing surfaces

Moved verbatim from the rule's opening paragraph:

> In test-collection order, this surfaces as `AssertionError: pkg.foo MUST be callable (got module)` after an unrelated test imports the subpackage.

### Why test-collection order is not a defense

Moved verbatim from the rule's `**Why:**` line:

> Test collection order is NOT stable across Python versions (3.13 → 3.14 re-ordered `pytest` discovery) and unrelated modules importing the subpackage counts as a trigger.

That measured reordering is the falsifying context for the rule's BLOCKED
rationalization "Test order is stable": the same suite that passed on 3.13
surfaced the shadowing on 3.14 with no source change.

Origin, moved verbatim: kailash-ml 1.1.0 release cycle (2026-04-23) — `km.dashboard` shadowed by `kailash_ml/dashboard/` subpackage after Python 3.14 test-collection reordering; fix commit `8914de3b` installed `_CallableDashboardModule`.

## Express CRUD surface

Worked example moved verbatim from the rule's § "DataFlow Express (Default for
CRUD)"; the rule keeps the `create` line and the
`# ❌ Don't use WorkflowBuilder for simple CRUD — 23x slower` contrast.

```python
result = await db.express.create("User", {"name": "Alice", "email": "alice@example.com"})
user = await db.express.read("User", result["id"])  # accepts both str and int IDs
users = await db.express.list("User", {"active": True})
await db.express.update("User", result["id"], {"name": "Bob"})
await db.express.delete("User", result["id"])
```

## Async-cleanup evidence

Depth for the rule's § "Async Resource Cleanup".

### Why `close()` from `__del__` is worse than leaking — the deadlock chain

Moved verbatim from the rule's first `**Why:**` line:

> Calling `close()` from `__del__` on an async resource is worse than leaking: the finalizer fires from inside Python's logging machinery during GC, `close()` spawns a new event loop whose selector init calls `logger.debug()`, and that acquires the root logging lock already held by the finalizer thread — deadlocking the process.

Origin, moved verbatim: 2026-04-16 plus prior "DataFlow unit suite hangs" reports across multiple sessions. `DataFlow.__del__` called `self.close()` → `async_safe_run()` → `asyncio.new_event_loop()` → selector init → `logger.debug()` → deadlock on root logging lock held by GC finalizer.

## Extraction record

2026-08-19 structural cleanup, ZERO de-scoping. `rule-authoring.md` Rule 10 /
Rule 11 do NOT fire — Rule 10 § "Trigger scope" binds `priority: 0` +
`scope: baseline` rules ONLY and `patterns.md` is `scope: path-scoped`, so this
is STRUCTURAL CLEANUP, not a Rule-10 paired extraction and not Rule-11 recurrence
input (the `journal/0148` disposition). Sibling precedent:
`.claude/guides/rule-extracts/recommendation-quality.md` § "Extraction record".
