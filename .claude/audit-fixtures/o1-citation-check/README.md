# o1-citation-check audit fixtures

Per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4.
Each fixture pins ONE scope-restriction predicate the
`.claude/hooks/lib/o1-citation-check.js` SHAPE check relies on (issue #577;
lane-aware since 2026-08-16). The `.txt` carries a candidate `/govern`
origination journal `DECISION` receipt; the `.expected` sibling names `ok` /
`lane` / `arm` / `reason` / `failed` + the predicate locked.

The fixtures are LOAD-BEARING, not snapshots: the
`FIXTURES: every fixture's .expected header matches checkGovernReceipt` test in
`.claude/test-harness/tests/o1-citation-check.test.mjs` re-derives every pair
from the live module, so a fixture cannot silently rot. The rest of that suite
is behavioral regression per `testing.md` (call the function, assert `ok` +
`reason` + per-check booleans — NOT source-grep), plus a live-corpus arm that
runs the checker against the REAL journal receipts (`0573`, `0574` co-owner;
`0432`, `0434`, `0436` O1) exactly as they sit on disk.

## Two lanes, two arms (2026-08-16)

`/govern` defines TWO origination lanes with DIFFERENT provenance requirements,
and this check now shape-checks BOTH. **The lane is resolved from the receipt's
own CONTENT — never a caller flag, never a frontmatter declaration.**

| Lane                | Evidence in the receipt                                                                                             | Arm applied         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `o1`                | a standard token in CITATION CONTEXT (version/clause adjacent, or a citation lead-in)                               | O1: (a)/(b)/(c)     |
| `co-owner-directed` | a directive-attribution marker (`co-owner-directed`, "verbatim directive", `Requester:`, "in-session directive")    | co-owner: (d)/(e)/(f) |
| `ambiguous`         | BOTH — the ordinary shape of a real O1 receipt that also quotes the directive that scheduled the work               | O1 (the STRICTER)   |
| `unrecognised`      | NEITHER                                                                                                             | O1, and ok FORCED false |

**Why the defect existed.** Step 2 of `/govern` prescribed this CLI
unconditionally for both lanes while the module knew only the O1 question.
Measured against the real co-owner-directed receipt
`journal/0577-someoperator-DECISION-conservation-gate-contract.md`: `exit=1`,
`no-standard-named`. The check was not wrong about what it measured — it was
read for a question it was not built for (`instrument-discipline.md` MUST-4).
The operator is then either blocked wrongly on a valid receipt, or learns to
ignore a red exit, which DISARMS the gate for the O1 lane where it IS
load-bearing.

**Why the `ambiguous` tie goes to the stricter ARM, not the union of both.**
Requiring BOTH arms was implemented first and MEASURED to fail the real O1
receipts `0432`/`0434`/`0436` on `(f)` — each cites SAFR v1.0 §2 AND quotes the
co-owner directive that scheduled the work. Requiring both would have re-created
the same over-block one lane over. A co-owner signal therefore never lowers the
O1 bar, and it never raises it either.

**Why a bare standard token is not O1 evidence.** Measured over the 540-entry
`journal/` corpus: `\bCIS\b` matches the plural "CIs" and `\bISO\b` matches a
lowercase "iso" mid-sentence — 14 co-owner-mentioning entries carry such a
token. A token-only discriminator would misroute those valid receipts into the
strict arm. `pass-co-owner-real` + the `0573` corpus test pin that boundary.

## What this check decides — and what it does NOT

The check is **SHAPE-mechanical only**. It answers three structural questions a
parse CAN answer deterministically:

| Predicate | Question                                                             | Fail reason                                                |
| --------- | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| **(a)**   | Names a standard AND carries a VERSION token?                        | `no-standard-named` / `no-version-token` / `empty-receipt` |
| **(b)**   | Cites a specific clause/§ identifier (NOT a bare standard name)?     | `no-clause-identifier`                                     |
| **(c)**   | Carries a one-sentence derivation linking clause → artifact content? | `no-derivation-sentence`                                   |
| **(d)**   | Quotes a directive VERBATIM (a quoted span, not a paraphrase)?       | `no-verbatim-directive`                                    |
| **(e)**   | Is that quote ATTRIBUTED to a named requester in its own context?    | `no-requester-attribution`                                 |
| **(f)**   | Does that SAME attribution context carry a timestamp?                | `no-directive-timestamp`                                   |
| **lane**  | Is either lane established at all?                                   | `unrecognised-lane` (fails CLOSED)                         |

(f) is deliberately scoped to the directive's ATTRIBUTION CONTEXT (the ±5/+3
line window around the quote) and NOT to the whole receipt: every journal entry
carries a frontmatter `date:`, so a receipt-wide date check would pass on every
input and could never fail — a check that cannot discriminate is not evidence
(`instrument-discipline.md` MUST-1). `fail-f-no-timestamp` pins that.

**Receipt-before-edit is NOT checked, and no claim is made that it is.** It is
an ORDERING property of the commit history, invisible to a parse of the receipt
text; the only textual proxy is the author's own assertion that they did it,
which is self-attestation, not evidence. It stays with the human / gate-review
layer — named honestly rather than faked with a keyword match.

The **SEMANTIC** questions — "does the cited clause ACTUALLY GOVERN this
artifact's content?" and "is this quote what the co-owner actually said?" —
**STAY WITH THE HUMAN / LLM GATE** (the cc-architect
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

### Lane-aware fixtures (2026-08-16)

| Fixture                          | ok    | lane / arm                | Predicate locked                                                                                                                                                                       |
| -------------------------------- | ----- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pass-co-owner-real`             | true  | co-owner / co-owner       | REAL receipt (`journal/0574` excerpt, operator identity replaced with synthetic values 2026-09-25). (d)+(e)+(f) pass. Before the lane split this exact receipt class failed `no-standard-named` — the over-block this change removes                  |
| `pass-o1-real-ambiguous`         | true  | ambiguous / o1            | REAL O1 receipt (`journal/0432` excerpt, de-identified 2026-09-25) that ALSO quotes the co-owner directive. The tie goes to the stricter ARM; requiring both arms was measured to fail this receipt on (f)        |
| `fail-d-paraphrased-directive`   | false | co-owner / co-owner       | (d) — a PARAPHRASED directive is not verbatim. The co-owner arm's efficacy pole: it is a real check, not a bypass                                                                       |
| `fail-e-unattributed-quote`      | false | co-owner / co-owner       | (e) — a quoted directive with a date but NO requester named in its attribution context                                                                                                 |
| `fail-f-no-timestamp`            | false | co-owner / co-owner       | (f) — attributed quote, no timestamp in its context. The frontmatter `date:` this fixture carries does NOT satisfy it                                                                   |
| `fail-lane-unrecognised`         | false | unrecognised / o1         | LANE fail-closed: neither lane's evidence. The O1 arm's own typed reason (`no-standard-named`) is preserved, identical to pre-lane behaviour                                            |
| `fail-lane-scattered-citation`   | false | unrecognised / o1         | LANE fail-closed on a receipt whose O1 arm PASSES — authority far from its citation machinery. `ok` is FORCED false; the forced-fail branch is the mutation-tested one                   |
| `fail-lane-mis-declared-co-owner`| false | ambiguous / o1            | ANTI-GAMING: declares `origination: co-owner-directed` AND carries a full directive, but cites a standard in citation context → still held to the O1 arm and caught on the bare-name (b) |

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
