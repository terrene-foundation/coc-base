# Headroom-Floor Exception Audit Fixtures (loom#1355)

Audit fixtures for the per-lane, time-bounded headroom-floor exception mechanism in `.claude/bin/emit.mjs` — `resolveHeadroomException`, `effectiveHeadroomFloorPct`, `parseHeadroomExceptions`.

## What the mechanism is

`sync-manifest.yaml::cli_variants."context/root.md".headroom_floor_pct` sets a **10% policy reserve** under `block_cap_bytes` (61,440 B) for every emission lane. The `rs` lane measured **8.73%** on 2026-07-26 — 783 B under that reserve, but still 5,361 B under the hard cap. Per the co-owner decision recorded in `workspaces/loom-followups-2026-07-25/02-convergence-ledger.md`, the excess is **accepted** rather than paid for by demoting a baseline rule (reachability loss) or shedding Rust security MUST clauses (coverage loss).

The binding condition on that decision was that the acceptance be **ENCODED**, not left as a standing-red gate: a permanently-red gate is exactly the ratchet `zero-tolerance.md` Rule 1 forbids, and is how the original breach survived 11 days unnoticed (loom#1348).

So the exception is declared in `sync-manifest.yaml::cli_variants."context/root.md".headroom_floor_exceptions` and enforced by the three predicates below.

## The three properties these fixtures pin

| Property      | Meaning                                                                                             | Fixtures                   |
| ------------- | --------------------------------------------------------------------------------------------------- | -------------------------- |
| **NARROW**    | The grant covers only its declared lane and its declared CLIs. Nothing else inherits it.            | 03, 04, 05, 15, 17, 18     |
| **TEMPORARY** | Expiry is inclusive, and the day after expiry the lane reverts to the full floor — the gate re-reds. | 06, 07, 08, 09             |
| **FAIL-CLOSED** | Every "cannot establish the grant applies" path denies it, and a malformed declaration THROWS.    | 10–14, 23–33, 40           |

## Predicates covered (one fixture set per scope-restriction predicate per `cc-artifacts.md` Rule 9)

### `resolveHeadroomException` — the scope-restriction predicate

| Fixture                                        | Predicate exercised                                                              | Expected           |
| ---------------------------------------------- | -------------------------------------------------------------------------------- | ------------------ |
| `fixture-01-declared-lane-declared-cli-in-force` | Lane + CLI match, date before expiry → the one granted case                      | the rs exception   |
| `fixture-02-second-declared-cli-also-covered`   | One entry naming both CLIs covers both (no per-CLI duplication → no parity drift) | the rs exception   |
| `fixture-03-undeclared-lane-not-covered`        | A sibling lane never inherits another lane's grant                               | `null`             |
| `fixture-04-base-lane-not-covered`              | `lang=null` normalizes to lane `base`, which holds no grant                      | `null`             |
| `fixture-05-undeclared-cli-not-covered`         | A CLI absent from `clis:` gets nothing even on the granted lane                  | `null`             |
| `fixture-06-day-before-expiry-in-force`         | In force before expiry                                                           | the rs exception   |
| `fixture-07-expiry-day-inclusive`               | Expiry is INCLUSIVE — in force through the end of the declared date              | the rs exception   |
| `fixture-08-day-after-expiry-lapsed`            | **The load-bearing case** — expiry turns the gate RED, never into permission     | `null`             |
| `fixture-09-long-after-expiry-still-lapsed`     | No re-grant by the passage of time                                               | `null`             |
| `fixture-10-invalid-clock-fails-closed`         | Unparseable `now` → cannot prove unexpired → deny                                | `null`             |
| `fixture-11-missing-clock-fails-closed`         | Absent `now` → deny                                                              | `null`             |
| `fixture-12-calendar-invalid-clock-fails-closed` | Shape-valid non-date (`2026-13-45`) → deny                                      | `null`             |
| `fixture-13-empty-corpus`                       | No declarations → no grants                                                      | `null`             |
| `fixture-14-non-array-corpus-fails-closed`      | Malformed-input defense                                                          | `null`             |
| `fixture-15-first-matching-entry-wins-over-nonmatching` | Non-matching entries are skipped, not read as a match                    | the rs exception   |

### `effectiveHeadroomFloorPct` — floor composition

| Fixture                                        | Predicate exercised                                                     | Expected |
| ---------------------------------------------- | ----------------------------------------------------------------------- | -------- |
| `fixture-16-no-exception-keeps-declared-floor` | No grant → the declared manifest floor                                  | `10`     |
| `fixture-17-grant-lowers-floor-for-this-lane`  | A grant applies to its own lane only                                    | `8.5`    |
| `fixture-18-grant-above-declared-floor-is-ignored` | `min()` — a nonsense grant above the floor cannot silently tighten   | `10`     |
| `fixture-19-grant-at-min-clamp`                | The `HEADROOM_EXCEPTION_MIN_FLOOR_PCT` boundary is legal, not banned    | `5`      |

### `parseHeadroomExceptions` — fail-closed declaration parsing

| Fixture                                       | Predicate exercised                                                | Expected |
| --------------------------------------------- | ------------------------------------------------------------------ | -------- |
| `fixture-20-well-formed-declaration-parses`   | Happy path incl. measured-provenance fields                        | 1 entry  |
| `fixture-21-absent-stanza-yields-no-exceptions` | No stanza → full floor everywhere                                | `[]`     |
| `fixture-22-block-ends-at-dedent-not-at-eof`  | The next manifest stanza is not swallowed into the list            | 1 entry  |
| `fixture-23-missing-granted_floor_pct-throws` | Under-specified waiver rejected                                    | THROW    |
| `fixture-24-missing-expires-throws`           | An exception with no expiry is a permanent waiver → rejected       | THROW    |
| `fixture-25-missing-issue-throws`             | No tracking issue → not auditable → rejected                       | THROW    |
| `fixture-26-missing-clis-throws`              | Unscoped grant rejected                                            | THROW    |
| `fixture-27-grant-below-min-floor-throws`     | An exception may not disable the reserve outright                  | THROW    |
| `fixture-28-non-numeric-grant-throws`         | `granted_floor_pct: soon` is not a floor                           | THROW    |
| `fixture-29-calendar-invalid-expiry-throws`   | `2026-02-30` matches the regex but is not a date                   | THROW    |
| `fixture-30-misshaped-expiry-throws`          | `31-10-2026` rejected                                              | THROW    |
| `fixture-31-unknown-cli-throws`               | A typo'd CLI (`gemeni`) would cover nothing silently               | THROW    |
| `fixture-32-empty-clis-throws`                | `clis: []` covers nothing silently                                 | THROW    |
| `fixture-33-duplicate-lane-cli-throws`        | Two entries on one lane make the applied floor ambiguous           | THROW    |
| `fixture-34-two-distinct-lanes-both-parse`    | Distinct lanes are independent, not a duplicate                    | 2 entries |
| `fixture-35-comment-lines-inside-block-ignored` | `#` rationale comments inside the list do not corrupt parsing     | 1 entry  |
| `fixture-36-bare-dash-item-with-fields-on-following-lines` | A bare `-` opens an item (regression: this silently parsed to ZERO entries) | 1 entry |
| `fixture-37-stray-scalar-before-first-list-item-ignored` | A scalar before the first `-` is not folded into an entry     | 1 entry  |
| `fixture-38-non-key-value-line-inside-block-ignored` | An unreadable line is skipped, not assigned under a garbage key      | 1 entry  |
| `fixture-39-trailing-comment-stripped-from-unquoted-value` | Inline `#` annotation does not land in the parsed number     | 1 entry  |
| `fixture-40-grant-at-or-above-100-throws`     | Upper bound of the permitted range                                 | THROW    |
| `fixture-41-absent-optional-provenance-fields-are-null` | Optional provenance fields resolve to `null`, not NaN            | 1 entry  |

## Running the fixture suite

```bash
node .claude/audit-fixtures/headroom-floor-exception/run.mjs
```

Exit 0 = all 41 predicates pass. The runner is also invoked from `.claude/test-harness/tests/emit-shape.test.mjs`, so it cannot rot unnoticed.

## Why these fixtures matter

The failure mode this mechanism guards against is not "a lane is 783 B over a reserve" — that is survivable, and measured. It is **an accepted breach that nobody can see, and that never expires**. The three throw-classes above (missing `expires`, missing `issue`, unparseable declaration) are each a way a waiver could become permanent and invisible; the expiry fixtures are the ones that keep the acceptance time-bounded.

Every fixture is hermetic — none reads the live `sync-manifest.yaml`. A manifest edit changes the live gate but can never silently rewrite what these predicates are asserted to do.

Companion tests in `emit-shape.test.mjs` cover the same predicates against the LIVE manifest (including the expired-declaration end-to-end path, exercised on an in-memory copy — no tracked file is ever mutated).
