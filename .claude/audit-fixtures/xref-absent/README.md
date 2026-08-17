# `xref-absent` structural fixtures

Structural (Contract C2) coverage for the ABSENT-BY-DESIGN cross-reference
declaration emitter, `.claude/bin/lib/xref-absent.mjs`. Registered in
`.claude/test-harness/eval-manifest.json` as `xref-absent` and run by
`.claude/bin/coc-eval-all.mjs`. Offline, deterministic, no LLM.

Each fixture is a hermetic scenario the scanner drives with
`--root <fixture> --json`:

```
<fixture>/scenario.json   inputs (plan rows, tier globs, owned surfaces) + the ANSWER KEY
<fixture>/loom/**         stands in for loom — the resolution authority
<fixture>/target/**       stands in for the materialized consumer tree — the scan source
```

## The two kinds of fixture

`clean-*` — the answer key states the CORRECT outcome. Exit 0.

`violation-*` — the answer key deliberately states an **amnesty-shaped** outcome:
a token that the plan says SHIPS, or that does not exist at loom at all, recorded
as `declared`. A correct emitter REFUSES to declare either, so the key does not
match and the scanner reds. Exit 1.

These are **not** mislabelled cases. They are tripwires: if a future edit loosens
`proveAbsent` into a blanket amnesty, those fixtures start MATCHING their key and
exit 0 — against a manifest that expects 1 — so the harness reds on the
regression. Each has a `clean-refuses-*` sibling pinning the same refusal from
the other pole, so the pair discriminates in both directions.

## What each case pins

| Fixture                                        | Pins                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| `clean-loom-only`                              | a `loom_only:` skip is a positive proof of absence                  |
| `clean-tier-not-subscribed`                    | `no_tier_match` + matches an UNSUBSCRIBED tier's glob is provable   |
| `clean-outside-owned-surface`                  | a path outside every `owned_surfaces:` surface (the `journal/` class) |
| `clean-directory-not-shipped`                  | a DIRECTORY token where nothing under it ships                      |
| `clean-refuses-shipping-token`                 | ANTI-AMNESTY — a path the plan SHIPS is never declared              |
| `clean-refuses-unresolvable-at-loom`           | ANTI-AMNESTY — a token that dangles at loom too is never declared   |
| `clean-refuses-no-tier-at-all`                 | "matches nothing" is UNDECLARED, not absent-by-design               |
| `clean-refuses-case-mismatch`                  | exact-case verification (macOS is case-insensitive; CI is not)      |
| `clean-refuses-root-token-without-surfaces`    | an unparseable/empty surface list fails CLOSED, never open          |
| `violation-key-expects-amnesty-for-shipping`   | the shipping-token refusal, from the tripwire pole                  |
| `violation-key-expects-amnesty-for-unresolvable` | the unresolvable-token refusal, from the tripwire pole            |
| `violation-key-expects-undeclared-tier-token`  | the "matches nothing" refusal, from the tripwire pole               |
| `violation-empty-scenario`                     | an empty scenario is INVALID, never a pass                          |

## Discrimination, measured

Two mutations of `xref-absent.mjs` were run against the whole set and each RED
every `clean-*` case:

- `existsExactCase` forced to `true` (case-blind) — 9/9 clean cases red.
- `proveAbsent` forced to return a reason unconditionally (blanket amnesty) —
  9/9 clean cases red.

Restoring the file returned all 13 to their expected dispositions. A fixture set
that cannot red on a regression is not coverage; this one was shown to.
