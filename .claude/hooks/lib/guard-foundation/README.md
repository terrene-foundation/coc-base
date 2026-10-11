# `guard-foundation/` — L1 provider skeletons

**L1 = facts.** Providers report what an operation WOULD do, before it runs.
No policy lives here; the L3 decision chain is owned elsewhere and ordered:

```
deny > undetermined-on-protected > halt > advisory > allow
```

**One result shape, no exceptions** (`contract.js`):

```js
{ verdict: "determined" | "undetermined",
  facts: {...} | effects: [...],
  reason: string|null,              // non-empty REQUIRED when undetermined
  unresolved?: [{ span, reason }] } // undetermined only: what could not be resolved
```

Non-negotiable rules, enforced in the shape and covered by
`tests/undetermined-contract.test.js`:

- a **missing required fact ⇒ `undetermined`** — never `false`, never an
  empty result, never an allow. An unmapped tool/command is undetermined,
  NOT assumed effect-free.
- **dynamic expansion / scripts / executors ⇒ BOUNDED undetermined**: the
  partial effects that ARE established travel with the verdict, and
  `unresolved` names the span that could not be resolved.
- an effect endpoint of `{kind: "unknown"}` **forces** undetermined
  (`contract.js::isProviderResult`), so a half-described move cannot be
  presented as determined.

## Modules

| module               | providers                                               | notes                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract.js`        | —                                                       | verdict constructors + `isProviderResult` shape guard                                                                                                                     |
| `effects.js`         | —                                                       | THE effect model: `read-bytes` / `write-bytes` / `load-and-execute` / `delete`; every move carries BOTH endpoints; `seq` assigned only by `effectList()`                   |
| `shell-effects.js`   | `effectsForShellCommand(rawCommand)`                    | ordered effects; read-bytes split from load-and-execute; narrow plain grammar, safe-fails to undetermined otherwise                                                        |
| `tool-effects.js`    | `effectsForToolCall(toolName, toolInput)`               | same model; `Bash` delegates to `shell-effects`; unknown tool ⇒ undetermined                                                                                              |
| `target-identity.js` | `targetIdentity(path, ctx)`                             | canonical target vs REGISTERED external-handler alias as separate facts; registry unavailable ⇒ `registered: null` + undetermined (never `false`)                         |
| `repo-facts.js`      | `repoIdentity(ctx)`, `consumerTree(ctx)`                | exports **THE one `gitEnv`** (re-exported from `lib/git-subprocess-env.js`, loom#1462 — no second env builder); consumer-tree is the walker-replacement boundary (below)   |
| `identity.js`        | `operatorIdentity(ctx)`, `operatorRepoBinding(ctx)`     | operator/repo identity facts; both halves required for the binding                                                                                                        |

## Boundaries other lanes depend on

- **`repo-facts.consumerTree` replaces the registry lane's hand-rolled
  walker.** The future implementation uses Node's own parser + resolvers
  (package.json / `require.resolve` / `node:module`) instead of a bespoke
  directory walk, so the consumer set agrees with what Node actually loads.
  Until that lands the provider returns undetermined when no consumer set is
  supplied — it does NOT silently fall back to the walker.
- **`target-identity` keeps canonical target and alias separate** because a
  universal symlink refusal false-blocks registered external-handler aliases
  (they ARE symlinks by design). L3 denies unregistered out-of-tree links and
  allows registered aliases — the two are indistinguishable to an instrument
  that only asks "is it a symlink?".
- **Every git child process in this tree gets its env from
  `repo-facts.gitEnv`** (the house allowlist). No local env construction.

## Skeleton scope

Interfaces + the Undetermined contract, no behaviour beyond it. The tests
cover exactly that contract: per provider one case where a present fact
yields `determined`, one where an absent fact yields `undetermined`.
