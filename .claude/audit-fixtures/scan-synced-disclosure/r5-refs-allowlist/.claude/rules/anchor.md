# R5 — `refs` Allowlist Anchor

Fixture locks the `refs(?=/)` slash-anchored allowlisting in
`scan-synced-disclosure.mjs::SHAPES::nonfoundation-org-slug`. Every token
in this fixture is SYNTHETIC.

## CLEAN cases (should NOT flag)

Substrate git ref names — `refs/<category>/<name>` is the canonical git-ref
namespace (parallel to `refs/heads/`, `refs/tags/`, `refs/notes/`). The
`refs(?=/)` slash-anchored allowlist suppresses these from the
`nonfoundation-org-slug` SHAPE:

- `refs/coc/coordination-gen0` — the F14 substrate's coordination-log ref.
- `refs/coc/archive-gen0` — the F14 substrate's cold-archive ref.
- `refs/coc/**` — the GitHub ruleset pattern from `multi-operator-coordination.md` MUST-5.
- `refs/heads/main` — standard git heads namespace.
- `refs/tags/v1.0` — standard git tags namespace.

## FLAG cases (smuggle regression tests — MUST flag)

The `refs(?=/)` allowlist is INTENTIONALLY slash-anchored so that
crafted org slugs starting with `refs-` do NOT evade detection. Without
the `(?=/)` constraint, `refs\b` would match `refs` followed by any
non-word char (including `-`), allowing `refs-acme-corp/loom` to bypass
the 4th alt. With the slash anchor, only literal `refs/` is allowed.

- `refs-acme-corp/loom` — bare smuggle attempt (4th alt).
- `chore/refs-customer-corp/coc-engagement` — branch-prefix smuggle (5th alt).
- `customer-acme/loom` — sanity-check bare org slug (4th alt).
