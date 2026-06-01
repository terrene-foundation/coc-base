# validate-workflow.js — Self-Detection False-Positive Record

`.claude/hooks/validate-workflow.js` IS the stub-marker detector for Kailash
Rust SDK patterns. The hook enforces `rules/zero-tolerance.md` Rule 2 by
scanning code files for `TODO`, `FIXME`, `HACK`, `XXX`, and
`raise NotImplementedError`. Because the hook contains those markers as literal
detection strings (regex patterns and error messages), any SWEEP that greps for
these markers against the hook file itself will produce false-positive hits.

## Classification evidence (SWEEP-2026-05-26 F34)

`grep -nE 'TODO|FIXME|HACK|XXX|NotImplementedError' .claude/hooks/validate-workflow.js`
produced 12 matches. All 12 are false-positives:

Line numbers below reflect the file state AFTER the `SWEEP-EXEMPT-STUB-MARKERS:`
comment block was inserted (commit `5d2338c`, +3 lines from file head). The original
classification was authored against the pre-comment file state (line numbers off by
-3); this table is the canonical post-comment lookup surface.

| Line | Category       | Content summary                                             |
| ---- | -------------- | ----------------------------------------------------------- |
| 170  | comment-header | `// -- Stub/TODO/simulation detection (code files only)`    |
| 327  | comment-header | `// BLOCKING: raise NotImplementedError in production code` |
| 328  | regex-pattern  | `/\braise\s+NotImplementedError\b/.test(line)`              |
| 330  | error-string   | `` `BLOCKED: raise NotImplementedError at ...` ``           |
| 738  | comment-header | `// Stub / TODO / Simulation detection`                     |
| 742  | comment-header | `* Detect stubs, TODOs, placeholders...`                    |
| 770  | regex-pattern  | `/\braise\s+NotImplementedError\b/`                         |
| 771  | error-string   | `"raise NotImplementedError — IMPLEMENT fully"`             |
| 781  | regex-pattern  | `[/\bTODO\b/, ...]`                                         |
| 782  | regex-pattern  | `[/\bFIXME\b/, ...]`                                        |
| 783  | regex-pattern  | `[/\bHACK\b/, ...]`                                         |
| 785  | regex-pattern  | `[/\bXXX\b/, ...]`                                          |

TRUE positives: **0**

## Disposition

The file carries a `// SWEEP-EXEMPT-STUB-MARKERS:` comment block immediately
after its file header (before the first `require` statement) per the convention
documented in `README.md`. Future SWEEP runs MUST treat any `TODO|FIXME|HACK|
XXX|NotImplementedError` match in this file as an acknowledged false-positive
unless a line number outside the detection function body is flagged.
