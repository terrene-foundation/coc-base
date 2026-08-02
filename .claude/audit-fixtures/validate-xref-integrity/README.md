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
| 18  | fixture-18-slashless-token-naming-directory-resolves-labelled | bare token naming a real DIRECTORY resolves, and carries the `looseDirMatch` label  |
| 19  | fixture-19-file-wins-over-directory-no-loose-label | a FILE at a later candidate beats a DIRECTORY at an earlier one, UNlabelled — the fallback is a second pass, not a relaxed predicate |
| 20  | fixture-20-trailing-slash-token-resolves-strictly-unlabelled | explicit-directory token skips a FILE candidate, resolves at the DIRECTORY, UNlabelled |
| 21  | fixture-21-absent-by-design-skipped-only-in-declared-source | absent-by-design allowlist is SOURCE-SCOPED — sanctioned in the declaring file, dangling elsewhere |
| 22  | fixture-22-absent-by-design-unknown-token-not-sanctioned | a token absent from the allowlist is never sanctioned, even from a carve-out-bearing file |
| 23  | fixture-23-extension-bearing-token-not-satisfied-by-directory | `ghost.md` stays dangling when only a DIRECTORY named `ghost.md` exists; extension-less arm still resolves |
| 24  | fixture-24-file-extension-classifier             | dot past position 0 in the LAST segment is an extension; leading dot and dotless are not |

Each fixture is a self-contained unit:

- pure-function call against the validator's exported helpers
- structural expected-value (exact match against array length, kind, status)
- no probe-driven semantic judgment needed (per `probe-driven-verification.md` MUST-3 — structural primitives only)

## Discrimination

Per `rules/instrument-discipline.md` MUST-2, a fixture that cannot RED is not
coverage. Each fixture added for the slash-less directory fallback names the
mutation that REDs it, verified rather than asserted:

| Fixture | Mutation that REDs it                                                    |
| ------- | ------------------------------------------------------------------------ |
| 18      | disable the second pass                                                  |
| 19      | loosen pass 1 to `isFile() \|\| isDirectory()`                           |
| 20      | pass-1 predicate → `st.isFile()`; or `isDir` inference → `false`         |
| 23      | drop the `!hasFileExtension(token)` bound from the second pass           |
| 24      | any widening of the last-segment dot test                               |

The second pass's `!isDir` conjunct is deliberately NOT claimed as covered: it
is provably inert (that pass's predicate is a subset of pass 1's over the same
candidate list, so it can never fire where pass 1 did not), measured at 0 of 486
disk-config × token-shape × kind rows on a harness that reports 32 differing
rows when the pass is disabled. It is kept as documented defense-in-depth.
