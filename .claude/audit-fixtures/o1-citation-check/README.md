# o1-citation-check audit fixtures

Per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4.
Each fixture pins ONE scope-restriction predicate the
`.claude/hooks/lib/o1-citation-check.js::checkO1Citation` SHAPE check relies on
(issue #577). The `.txt` carries a candidate O1-origination journal `DECISION`
receipt; the `.expected` sibling names `ok` / `reason` / `failed` + the predicate
locked.

The end-to-end behavioral coverage lives in
`.claude/test-harness/tests/o1-citation-check.test.mjs` — those tests call
`checkO1Citation` directly and assert `ok` + `reason` + per-check booleans
(behavioral regression per `testing.md`, NOT source-grep). The fixtures below
are the structural-payload snapshots that future `/redteam` mechanical sweeps
(and the cc-architect `/codify` gate) can diff against without re-deriving
receipt shapes.

## What this check decides — and what it does NOT

The check is **SHAPE-mechanical only**. It answers three structural questions a
parse CAN answer deterministically:

| Predicate | Question                                                             | Fail reason                                                |
| --------- | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| **(a)**   | Names a standard AND carries a VERSION token?                        | `no-standard-named` / `no-version-token` / `empty-receipt` |
| **(b)**   | Cites a specific clause/§ identifier (NOT a bare standard name)?     | `no-clause-identifier`                                     |
| **(c)**   | Carries a one-sentence derivation linking clause → artifact content? | `no-derivation-sentence`                                   |

The **SEMANTIC** question — "does the cited clause ACTUALLY GOVERN this
artifact's content?" — **STAYS WITH THE HUMAN / LLM GATE** (the cc-architect
`/codify` review per `artifact-flow.md` § "The Origination Taxonomy" Detection
layer 2 + `cc-artifacts.md` Rule 6). A real standard whose clause does NOT
govern the edit passes this SHAPE check (a, b, c all present) and is BLOCKED
**only** by the human gate. The check COMPLEMENTS,
never REPLACES, the judgment gate. Per `hook-output-discipline.md` MUST-2 the
consuming surface emits this as `halt-and-report` / advisory, never
`severity:block` (a judgment-bearing review signal, not a structural tool-call
primitive).

## Fixtures

| Fixture                            | ok    | reason                   | Predicate locked                                                                                                                                                                                                              |
| ---------------------------------- | ----- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pass-full-arrow-derivation`       | true  | `ok`                     | (a)+(b)+(c) all pass; the canonical DO receipt (`artifact-flow.md` § "The Origination Taxonomy" DO example)                                                                                                                   |
| `pass-prose-connective-derivation` | true  | `ok`                     | (c) prose-connective shape ("requires … therefore … mandates") is accepted alongside the explicit-arrow shape                                                                                                                 |
| `pass-name-adjacent-year`          | true  | `ok`                     | (a) version via NAME-ADJACENT year ("ISO 27001 2022") — the ONLY bare-year form that counts; contrast `fail-a-stray-year`                                                                                                     |
| `fail-a-empty`                     | false | `empty-receipt`          | (a) — no citation at all; uncited compliance edit = unattributable origination                                                                                                                                                |
| `fail-a-no-standard`               | false | `no-standard-named`      | (a) — "standard best practice" is not a named authority (the "best practice" DO-NOT in that §)                                                                                                                                |
| `fail-a-no-version`                | false | `no-version-token`       | (a) — standard + clause + derivation present but no version; (a) surfaces FIRST; clause-id dotted nums (`8.24`) are NOT mis-read as versions                                                                                  |
| `fail-a-stray-year`                | false | `no-version-token`       | (a) — a free-floating year in prose ("in 2019") is NOT name-adjacent → does NOT count as a version (R1-redteam boundary)                                                                                                      |
| `fail-b-bare-name-loophole`        | false | `no-clause-identifier`   | (b) — bare standard name WITH version, NO clause = THE loophole (the "per ISO 27001:2022" DO-NOT in that §)                                                                                                                   |
| `fail-c-no-derivation`             | false | `no-derivation-sentence` | (c) — citation EXISTS but no clause → artifact bridge; the SHAPE half of "must GOVERN"                                                                                                                                        |
| `pass-statute-with-year`           | true  | `ok`                     | (a) statute version contract: a version-less-LOOKING statute (GDPR) cited WITH its enactment year NAME-ADJACENT ("GDPR 2016 Article 32") satisfies (a) — the year is the version proxy (R2-redteam authoring-contract pin)    |
| `fail-a-statute-no-year`           | false | `no-version-token`       | (a) statute version contract NEGATIVE: a statute cited WITHOUT its year ("GDPR Article 32") fails (a) by design — NOT an over-block; the uniform version gate requires the enactment year (contrast `pass-statute-with-year`) |

## Notes

- The check NEVER carries `severity: "block"` — it is a SHAPE-mechanical
  review signal that complements the LLM-judgment governance gate. The
  surfacing hook routes it `halt-and-report` / advisory per
  `hook-output-discipline.md` MUST-2.
- (a) is evaluated before (b), and (b) before (c), so the most fundamental
  gap surfaces first (the `fail-a-no-version` fixture pins this ordering: it
  carries a valid clause + derivation but still fails on (a)).
- The version detector deliberately EXCLUDES a bare dotted decimal
  (`\d+\.\d+`) so a clause id such as `§A.8.24` is not spuriously read as a
  version token — the `fail-a-no-version` fixture locks that boundary.
- A bare standalone 4-digit year counts as a VERSION token ONLY when it is
  NAME-ADJACENT — riding the standard name through an optional catalog number
  within a small window ("SOC 2 2017", "ISO 27001 2022"). A free-floating year
  anywhere else in prose (an audit date, a ship deadline) does NOT satisfy the
  version sub-gate. The `pass-name-adjacent-year` + `fail-a-stray-year` pair
  locks both halves of that boundary (R1-redteam MED — the prior
  match-anywhere year branch let a versionless bare citation pass the (a) gate).
  The self-identifying forms (`:2022`, `vN`, `Rev. N`, NIST pub-id `800-53`)
  still match anywhere — they are intrinsically name-riding.
