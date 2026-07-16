# Audit fixtures — `signing-model-key-separation` (loom#411 GAP-5)

Backs validate-emit check `signing-model-key-separation`: the repo-wide,
emit-time lint that flags any capture-surface JS line binding a model / LLM key
token into a signing-key sink ("the shared model key signs nothing" — #411). It
is the REPO-WIDE companion to check-22 `operator-ref-credential-separation`
(the per-event operator_ref guard).

## Predicate

A source line (block + line comments stripped) that co-occurs BOTH:

- a signing-key SINK token — `signing[_-]?key` (incl. git-config
  `user.signingkey`), and
- a model / LLM key SOURCE token — `model[_-]?key`, `_MODEL_KEY`, or an
  enumerable LLM-provider API-key env name (env-models.md Model-Key-Pairings — a
  POSITIVE allowlist per `cc-artifacts.md` Rule 10).

is flagged. Severity is **advisory** — a lexical signal per
`hook-output-discipline.md` MUST-2, emitted as `SKIP + WARN:`, NEVER a `/sync`
block. The blocking defense stays the runtime guard in `provenance-event.js`.

## Fixtures (one per scope-restriction predicate — `cc-artifacts.md` Rule 9)

| Fixture                                     | Predicate exercised                               | Expected  |
| ------------------------------------------- | ------------------------------------------------- | --------- |
| `flag-envvar-model-key-bound-to-signing.js` | provider env-var key bound to a signing sink      | `flagged` |
| `flag-model-key-const-bound-to-signing.js`  | `_MODEL_KEY` constant bound to a signing sink     | `flagged` |
| `clean-distinct-keys-separate-lines.js`     | per-line predicate (sink + source on diff lines)  | `clean`   |
| `clean-resolve-identity-signing-only.js`    | invariant ii — the real `resolveIdentity` path    | `clean`   |
| `clean-comment-only-mention.js`             | comment-strip predicate (tokens only in comments) | `clean`   |

Each `<name>.js` has a sidecar `<name>.expected` (`flagged` / `clean`).

## Run

```bash
node .claude/audit-fixtures/signing-model-key-separation/run.mjs
```

The runner reads each fixture, runs the exported pure predicate
`flagsSigningModelKeyBindings()`, and asserts the flagged/clean verdict against
its `.expected`. Exit 0 = all pass, exit 1 = ≥1 mismatch.

Fixtures live OUTSIDE the check's scan roots (`.claude/hooks`, `.claude/bin`,
`.claude/codex-mcp-guard`), so the `flag-*` fixtures — which contain a real
model-key→signing binding — never trip the live `/sync` lint.
