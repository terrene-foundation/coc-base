# Audit Fixtures — validate-xref-integrity

Structural probes (per `rules/probe-driven-verification.md` MUST-3 — exit-code, AST shape, count-of-elements) for the F22 validator at `.claude/bin/validate-xref-integrity.mjs`.

These fixtures are NOT semantic; they verify mechanical behavior:

- token extraction (regex extractors return the right token shape from a fixed input)
- journal-token resolution (NNNN-prefix match against a fixed dir listing)
- relative-path resolution (md-link tokens resolved against source-file dir)
- fence-block stripping (xrefs inside ` ``` ` blocks ignored)
- placeholder rejection (tokens with `<>`/`{}` skipped)

## Run

```bash
node .claude/audit-fixtures/validate-xref-integrity/run.mjs
```

Exit 0 = all fixtures pass. Exit 1 = ≥1 fixture failed.

## Fixture catalog

| #   | Name                                             | What it pins                                                                         |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 1   | fixture-01-backtick-extract                      | backtick xrefs extracted; placeholder `<id>` rejected                                |
| 2   | fixture-02-md-link-extract                       | `[text](path.md)` extracted; http(s) skipped; fragment-only skipped                  |
| 3   | fixture-03-journal-backtick                      | `journal/NNNN` + `journal/.pending/NNNN` tokens classified as `kind: journal`        |
| 4   | fixture-04-fence-strip                           | tokens INSIDE fenced ` ``` ` blocks IGNORED                                          |
| 5   | fixture-05-md-link-relative-resolve              | `../../skill-x/file.md` resolves against source-file dir, not repo root              |
| 6   | fixture-06-placeholder-reject                    | `<NN>`, `<file>`, `{topic}` tokens rejected                                          |
| 7   | fixture-07-dir-token-vs-file                     | tokens ending `/` resolved as directory; without trailing `/` resolved as file       |
| 8   | fixture-08-claude-prefix                         | `.claude/<token>` resolves to `<repo>/.claude/<token>`                               |
| 9   | fixture-09-bare-prefix-tries-claude-first        | bare `rules/foo.md` tries `.claude/rules/foo.md` first, then `<repo>/rules/foo.md`   |
| 10  | fixture-10-journal-resolve-prefix                | `journal/0150-foo` matches `0150-*.md` in actual journal/ dir                        |
| 11  | fixture-11-anchor-stripping                      | `[text](file.md#section)` resolves on the file, anchor stripped                      |
| 12  | fixture-12-crlf-line-endings                     | CRLF-terminated lines extract tokens identically to LF                               |
| 13  | fixture-13-tilde-fence                           | tokens inside `~~~` fenced blocks IGNORED (same as ` ``` `)                          |
| 14  | fixture-14-path-traversal-guard                  | `../../../../etc/passwd` md-link clamped to repoRoot, returns not-found              |
| 15  | fixture-15-extended-placeholders                 | `${VAR}`, `%(var)s` placeholder forms rejected                                       |
| 16  | fixture-16-cross-cli-dispatcher                  | `bin/coc` / `bin/coc-<phase>` skipped; `bin/cocktail.mjs` / `bin/codex.mjs` NOT (FC) |
| 17  | fixture-17-default-scope-excludes-audit-fixtures | `audit-fixtures/` absent from default scan scope; other four trees present (FC)      |

Each fixture is a self-contained unit:

- pure-function call against the validator's exported helpers
- structural expected-value (exact match against array length, kind, status)
- no probe-driven semantic judgment needed (per `probe-driven-verification.md` MUST-3 — structural primitives only)
