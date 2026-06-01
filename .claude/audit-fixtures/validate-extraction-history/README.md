# Audit Fixtures — validate-extraction-history

Structural probes per `rules/probe-driven-verification.md` MUST-3
(exit-code, AST shape, count-of-elements) for F25 at
`.claude/bin/validate-extraction-history.mjs`.

These fixtures are NOT semantic; they verify mechanical behavior:

- date arithmetic (TZ-naive parsing, calendar-day delta, ±1d boundary)
- frontmatter parsing
- anchor-text detection (Rule-10-disposition language)
- rule-citation detection (canonical/bare/basename forms)
- entry classification (full integration with temp journal + temp git repo)
- SM1 asOfDate binding (match + mismatch exit codes)
- SM2 rule-rename detect (temp git repo with `git mv`)
- window filter (in-window + out-of-window)

## Run

```bash
node .claude/audit-fixtures/validate-extraction-history/run.mjs
```

Exit 0 = all fixtures pass. Exit 1 = ≥1 fixture failed.

## Fixture catalog

| #   | Name                                 | What it pins                                                                |
| --- | ------------------------------------ | --------------------------------------------------------------------------- |
| 1   | fixture-01-parse-date-utc            | YYYY-MM-DD parsed as noon UTC; invalid date raises                          |
| 2   | fixture-02-days-between              | calendar-day delta; same-day=0; cross-month boundary                        |
| 3   | fixture-03-tz-naive-boundary         | LOW4: midnight wraparound across timezones still produces correct day-count |
| 4   | fixture-04-parse-frontmatter         | basic key/value extraction; stops at closing `---`                          |
| 5   | fixture-05-no-frontmatter            | text without `---` returns empty map                                        |
| 6   | fixture-06-has-rule10-anchor         | substring match (case-insensitive) on Rule-10-anchor corpus                 |
| 7   | fixture-07-cites-rule-canonical      | canonical path `<.claude/rules/foo.md>` form matches                        |
| 8   | fixture-08-cites-rule-bare           | bare path `<rules/foo.md>` form matches                                     |
| 9   | fixture-09-cites-rule-basename       | basename match accepts backtick/slash/bare-prose (Phase-1 favor-the-gate)   |
| 10  | fixture-10-sm1-asofdate-mismatch     | SM1: --as-of-date != --proposal-date → exit 2                               |
| 11  | fixture-11-sm2-rule-rename-git       | SM2: rule renamed via `git mv`; getScopeAtDate finds path-at-commit         |
| 12  | fixture-12-scope-at-date-baseline    | classifyEntry mandated=true when scope=baseline at entry date               |
| 13  | fixture-13-scope-at-date-path-scoped | classifyEntry mandated=false when scope=path-scoped at entry date           |
| 14  | fixture-14-window-filter             | entries outside window-days excluded from findings                          |
| 15  | fixture-15-multiple-rule10-anchors   | "Rule-10 disposition" / "Rule 10 fires" / "proximity-band sweep" all match  |
