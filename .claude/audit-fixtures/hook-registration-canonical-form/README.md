# hook-registration-canonical-form audit fixtures

Per `rules/cc-artifacts.md` Rule 9. These pin the recognition contract for
`bin/reconcile-settings-hooks.mjs::classifyRegistration` — the predicate deciding whether a
`settings.json` hook registration GENUINELY runs a hook script.

Each fixture is a single hook `command` string, exactly as `settings.json` would carry it.

## Why these exist (S1, 2026-07-26)

The reconciler originally extracted the hook path with an UNANCHORED substring regex:

```js
/((?:\.claude|scripts)\/hooks\/[A-Za-z0-9._-]+\.(?:js|mjs|cjs))/
```

That reopened the exact class `hooks/lib/settings-deny-guard-shape.js::invokesGuard` closed over five
redteam rounds (its header at `:24-39` is the audit trail). It was the **F9** shape — arbitrary leading
path — implemented with a regex instead of `endsWith`, and strictly weaker, because the match did not
even have to be a suffix.

The consequence was not cosmetic. A masquerading command extracted an identical, canonical-looking
relpath, so:

1. `findDanglingRegistrations` asked `hookExists(<extracted rel>)` — the REAL file exists → not dangling;
2. `--verify` printed `all N registered hook path(s) resolve on disk` — a **false clean**, and
   `sync-gate2-worktree.mjs` fails CLOSED on that gate, so the certification is load-bearing;
3. `regKey` collided with loom's key, so `present.has(key)` fired and **PROPAGATE never re-added loom's
   real registration** — the strip became permanent and sync-certified.

`settings-deny-drift-guard.js` does not backstop this: it restores only its own two markers. For
`integrity-guard.js`, `operator-gate.js`, `adjacency-leasecheck.js`, `validate-bash-command.js` and the
two multi-operator hooks, this reconciler is the ONLY repair surface.

The `reject-f10-single-quoted` case needs no attacker at all — it is ordinary drift that reads as
healthy and never fires.

## The contract

Accept IFF the command is BYTE-IDENTICAL to the single canonical registration:

```
node "$CLAUDE_PROJECT_DIR/.claude/hooks/<name>"
```

verified by round-tripping the captured basename through the shared
`settings-deny-guard-shape.js::invokesGuard` SSOT — so this surface and the #1309 L1/L3 guards agree
byte-for-byte, per `rules/security.md` § Enforcement-Surface Parity. Anything unrecognized ranks
**tightest** (`non-canonical` → dangling), never "resolves".

| Fixture                        | Expects         | Shape locked                                                     |
| ------------------------------ | --------------- | ---------------------------------------------------------------- |
| `accept-canonical`             | `canonical`     | the one accepted form                                            |
| `reject-f5-substring-echo`     | `non-canonical` | F5 — marker as data in a command that never executes it          |
| `reject-f7-eval-flag`          | `non-canonical` | F7 — `-e` makes the path a string literal, not a script          |
| `reject-f8-disabled-suffix`    | `non-canonical` | F8 — `.js.disabled`; node runs a miss                            |
| `reject-f9-parent-escape`      | `non-canonical` | F9 — `../evil/` prefix escapes the project tree                  |
| `reject-f9-absolute-path`      | `non-canonical` | F9 — absolute `/tmp/evil/` path, no `$CLAUDE_PROJECT_DIR` at all |
| `reject-f10-single-quoted`     | `non-canonical` | F10 — single quotes suppress expansion (ordinary drift)          |
| `reject-f11-unquoted`          | `non-canonical` | F11 — unquoted expansion word-splits on a spaced project path    |
| `reject-compound-and`          | `non-canonical` | F1371-3 — second path hidden from a non-global match             |
| `reject-compound-or`           | `non-canonical` | F1371-3 — same, with the dead path first                         |
| `skip-true-inline-shell`       | `none`          | mentions no hook script; cannot masquerade, so it is preserved   |

`none` is NOT an accept. It means the command claims no hook at all, so there is nothing to certify
and nothing to repair — it is left strictly alone.

## Measured blast radius

Across all four real trees — loom (46 registrations), kailash-py (27), kailash-rs (48),
kailash-prism (12) — there are **133 registrations, of which zero are non-canonical and zero are
inline-shell**. The strict rule prunes nothing that exists today; it is a pure fail-closed tightening.
Re-measure before relaxing it.
