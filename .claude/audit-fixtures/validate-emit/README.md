# Audit Fixtures — validate-emit

Structural probes (per `rules/probe-driven-verification.md` MUST-3 — exit-code,
count-of-elements, equality checks on pure-function outputs) for the F30
validator at `.claude/bin/validate-emit.mjs`.

These fixtures are NOT semantic; they verify the validator's mechanical
behavior — one fixture per scope-restriction predicate per `rules/cc-artifacts.md`
Rule 9, covering each of the 7 first-cycle checks plus the parsing helpers.

Note: checks 5 (`mirror-exclusion`) and 6 (`paths-annotation-consistency`) are
predicate-tested via their shared pure-function helpers (`parseEmitExclusions`
in fixture #10, `matchesGlob` in fixture #3); the check-level wrappers are thin
glue around those helpers + the standard live-tree I/O the other check fixtures
already exercise.

## Run

```bash
node .claude/audit-fixtures/validate-emit/run.mjs
```

Exit 0 = all fixtures pass. Exit 1 = ≥1 fixture failed.

## Fixture catalog

| #   | Predicate                                   | What it pins                                                                                                                                        |
| --- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | parseFrontmatter — leading `---` block      | extracts fields; correctly handles unterminated frontmatter                                                                                         |
| 2   | parseToolList — comma + array forms         | `"Read, Edit"` and `["Read","Edit"]` both → `["Read","Edit"]`                                                                                       |
| 3   | matchesGlob — exact + `/**` prefix          | `skills/foo` matches `skills/foo/**`; doesn't match unrelated paths                                                                                 |
| 4   | check 1 — command frontmatter               | H1-only command flagged; `---`-leading command passes; exempt list honored                                                                          |
| 5   | check 2 — command line cap                  | body > 150 (after stripping frontmatter) flagged; ≤150 passes                                                                                       |
| 6   | check 3 — read-only specialist tools        | agent declaring Edit/Write flagged; Read/Bash/Grep clean                                                                                            |
| 7   | check 4 — tool canonicality                 | `LS` flagged as non-canonical; canonical set clean                                                                                                  |
| 8   | check 7 — audit-fixture coverage            | detector with no fixture dir → fixture-needed; flag+clean fixture → pass                                                                            |
| 9   | parseReadonlySpecialists — agents.md parse  | extracts backtick-quoted names from "Read-only specialists (...)" sentence                                                                          |
| 10  | parseEmitExclusions — manifest sub-block    | parses `cli_emit_exclusions: codex/gemini` list under top-level YAML key                                                                            |
| 11  | classifyFixtures — flag vs clean naming     | `flag-X.txt` counts as flag; `clean-X.txt` counts as clean                                                                                          |
| 12  | check 6 multi-rule-per-row (R1 #1 lock)     | `matchAll` iterates EVERY rule on a Rules-Index row, not just the first                                                                             |
| 13  | classifyFixtures strict prefix (R1 #2 lock) | `clean-flag-X.txt` ambiguous name does NOT count as flag (strict `^flag-`)                                                                          |
| 14  | check 1 unterminated frontmatter (R1 #4)    | `---` open without close fails check 1 (parseFrontmatter would consume body)                                                                        |
| 15  | check 13 — validateGeminiCommandToml        | clean TOML → no errors; premature `'''` close in body → flagged (#408 AC#7)                                                                         |
| 16  | check 13 — extractRulesIndexCitations       | extracts EVERY `.claude/rules/<f>.md` row citation; empty index → `[]`                                                                              |
| 17  | check 14 — canonicalPolicies                | order-insensitive policies-table compare; detects a dropped gate (DF-AC6-2)                                                                         |
| 18  | check 15 — parseVariantsBlock               | `variants:` → non-null overlay VALUES (arm 1) + `null` cells (arm 4); variant_only path NOT swept in                                                |
| 19  | check 15 — parseVariantOnlyAll              | `variant_only:` → flat path set across langs (the 2nd union lane); next top-level block not swept in                                                |
| 20  | check 15 — classifyVariantFile              | one CLEAN per allowlist arm (overlay/variant_only/convention-rule+ternary+wrapper/null-ack/README+.example) + ORPHAN + unknown-axis-not-mis-flagged |
| 21  | check 15 — checkVariantOrphan e2e           | git-tracked enumeration over a synthetic tree: planted orphan → FAIL, declared → PASS, untracked operator-local companion → invisible               |
| 22  | findUnrecognizedAllowlistBullets — MARKER   | `fixture-allowlistMarker-a`–`n`; non-canonical bullet marker is LOUD, indented detail sub-bullets and out-of-span bullets stay silent (see below)    |

Note: check 13 (`consumer-efficacy`, #408 AC#7) is predicate-tested here via its
exported pure helpers (fixtures 15–16); the check-level wrapper + fault-injection
over synthetic emit trees (malformed TOML / unterminated frontmatter / missing
description / empty skill dir / dangling citation / lane-asymmetric + empty
index) is the Tier-2 regression
`test-harness/tests/consumer-efficacy-contract.test.mjs` (incl. the LIVE-corpus
clean-pass).

Check 14 (`codex-policies-fresh`, DF-AC6-2) is predicate-tested via
`canonicalPolicies` (fixture 17); the check-level wrapper + the stale-policies
FAIL teeth + the CC-only SKIP are the Tier-2 regression
`test-harness/tests/codex-policies-fresh.test.mjs` (incl. the LIVE-repo
committed==fresh regression-lock).

## `fixture-hookEvent-*` — check `hook-event-declaration` (hook-event-selection.md)

26 cases: `a`–`y`, plus `w0` (the anti-vacuity control paired with `w`). Count
predicate — one case = one `check("fixture-hookEvent-<id>-…", …)` call in
`run.mjs`; `grep -oE 'fixture-hookEvent-[A-Za-z0-9]+' run.mjs | sort -u` yields 26
distinct ids and a serial `node run.mjs` reports 26 `fixture-hookEvent-` rows.

FOUR are PURE-PREDICATE — they call an exported helper directly and stand up no
tree at all: `a` (well-formed multi-registration) and `b` (a `@hook-event:`-bearing
line that does not parse is MALFORMED and never silently dropped — a dropped line
is an undeclared registration that still reads as declared) exercise
`parseHookEventMarkers`; `w` and `w0` exercise `isMissingOwnSpecifier` over errors
GENERATED from real throws. The other 22 drive `checkHookEventDeclaration` over
synthetic `.claude/hooks/` + `settings.json` trees.

**The two controls are the load-bearing pair.** `c-control-lifecycleAtSessionStart`
and `e-control-telemetryStar` both expect **PASS**. A rule that condemned every
`SessionStart` hook, or every `matcher: "*"`, would be wrong — a session banner
belongs at SessionStart and a heartbeat belongs on every tool call. These two are
what force the check to discriminate by declared CLASS rather than blanket-flag by
event, so a later "tighten the detector" edit that drops the class distinction reds
here instead of shipping a false-positive storm.

| Case  | Predicate                                                     | Expect |
| ----- | ------------------------------------------------------------- | ------ |
| `c`   | CONTROL — `lifecycle` at `SessionStart`                        | PASS   |
| `d`   | MUST-2 — `verification` at `SessionStart`                      | FAIL   |
| `e`   | CONTROL — `telemetry` under `*`                                | PASS   |
| `f`   | MUST-3 — `guard` under `*`                                     | FAIL   |
| `g`   | MUST-4 — declared event ≠ registered event (re-homing drift)   | FAIL   |
| `h`   | MUST-4 scope — matcher ORDER normalized (`Write\|Edit`)         | PASS   |
| `i`   | MUST-1 — unrecognized CLASS token (typo must not disable `d`)  | FAIL   |
| `j`   | MUST-1 — unrecognized EVENT token (positive allowlist)         | FAIL   |
| `k`   | MUST-1 — empty rationale                                       | FAIL   |
| `l`   | GRANDFATHER — no marker ⇒ non-blocking `SKIP` + `WARN:` detail | SKIP   |
| `m`   | SCOPE — unregistered hook is NOT warned (git-hook class)       | SKIP   |
| `n`   | SCOPE — a NON-CANONICAL command is not a registration (S1)     | SKIP   |
| `o`   | a malformed line reports ONCE, not also as a MUST-4 mismatch   | FAIL   |
| `p`   | multi-registration hook declaring only one event               | FAIL   |
| `q`   | shared-recognizer seam is injectable (F1030d lazy-load)        | PASS   |
| `r`   | declaration BEYOND any header slice is still read              | FAIL   |
| `s`   | GRANDFATHER IS BOUNDED — hook not in the land-time snapshot    | FAIL   |
| `t`   | MUST-3 — ABSENT matcher is the WIDEST, not the narrowest       | FAIL   |
| `u`   | MUST-3 arm 2 — narrow class at an event with NO tool axis      | FAIL   |
| `v`   | registered `.mjs` produces a ROW (registration-driven enum)    | FAIL   |
| `w`   | lazy seam discriminates on the SPECIFIER, not the error CODE   | PASS   |
| `w0`  | ANTI-VACUITY CONTROL — generated errors DO carry the parent    | PASS   |
| `x`   | NEAR-MISS recall — misspelled keyword is MALFORMED, not silent | FAIL   |
| `y`   | NEAR-MISS precision — a `hookEvent:` payload key is NOT one    | SKIP   |

**`s`–`v` are the adversarial-round group (2026-08-01), and they share one
property: every one of them PASSED before its fix.** The check reported clean on
the very defects it exists to catch. `s` closes an UNBOUNDED grandfather (a
brand-new `verification`@`SessionStart` hook shipped with no marker took the same
non-blocking SKIP as a pre-existing one, and `/sync` stayed green). `t` closes the
write-LESS bypass: with the matcher OMITTED, a `guard` at `PreToolUse` cleared
MUST-3 (short-circuit on null) *and* MUST-4 (`normalizeMatcher(null) === ""` ===
the registered key) while firing on every tool call. `u` closes the day-one
disagreement between the rule's class table and the check. `v` is the
fail-open enumeration itself — a registered `.mjs` hook vanished with no row.

**`w`/`w0` and `x`/`y` are BIPOLAR PAIRS; neither half of either is optional.**
`w` asserts the lazy seam degrades to SKIP only when `reconcile-settings-hooks.mjs`
is itself absent, never when one of its own static imports is — the nested failure
raises an IDENTICAL `MODULE_NOT_FOUND`, and swallowing it would silently disarm a
blocking check AT LOOM, the one place it bites. `w0` exists because `w`'s first cut
hand-wrote the nested error WITHOUT the `Require stack:` / `imported from`
continuation that IS the leak mechanism, so it passed identically with the fix
reverted; `w0` asserts the generated messages actually carry the parent path, so
`w` goes red rather than inert if Node ever changes shape. `x` is RECALL (a
misspelled keyword must not fall into the grandfather branch); `y` is PRECISION and
is the one that cost a review round — a drafted detector accepting the bare keyword
matched the ordinary JS property `hookEvent:`, which sits in nearly every hook's
output payload, and failed 13 of 38 registered hooks.

**`r` is a regression lock on a real fail-open, not a hypothetical.** The check's
first cut read only the leading 4000 bytes of a hook, on the reasoning that "a
declaration belongs in the header". 37 of loom's 39 top-level hooks are larger than
that. A `@hook-event: SessionStart (verification)` marker planted at byte ~4500 was
INVISIBLE to the parse, so `markers.length === 0` and the hook fell into the
GRANDFATHER path — reported non-blocking as "carries no declaration". A hook that
genuinely opted in, carrying the exact defect the rule exists to block, waved
through by the clause meant to spare hooks that never opted in. The parse now reads
the whole file; `r` asserts BOTH arms (it FAILs on MUST-2 **and** is not the
grandfather SKIP), so reinstating any byte cap reds here.

**Discrimination table — the mutation that reds each fixture (2026-08-01).** Green
fixtures are not evidence on their own (`instrument-discipline.md` MUST-2). Each
row below was applied one at a time to `validate-emit.mjs` (restored from a `cp`
backup between runs) and the suite re-run SERIALLY; every mutation reddened exactly
the listed cases and left its control green. Each target reddening is also what
proves the mutation reached the code under test — the second live hypothesis
MUST-2(b) requires ruling out. Clean baseline: **55 passed, 0 failed, exit 0**.

| Mutation applied to `validate-emit.mjs`                                       | Reds        | Control stays green |
| ----------------------------------------------------------------------------- | ----------- | ------------------- |
| MUST-2 arm gated off (`cls === "verification" && event === "SessionStart"`)    | `d` `v` `r` | `c`                 |
| MUST-3 wide-matcher arm drops `*` (`parts.length === 0` only)                  | `f`         | `e`                 |
| MUST-3 wide-matcher arm drops ABSENT (`parts.includes("*")` only)              | `t`         | `f`                 |
| MUST-3 arm 2 (no-tool-axis) gated off                                          | `u`         | `c` `d`             |
| MUST-4 set-equality push gated off (`if (missing.length \|\| extra.length)`)    | `g` `p`     | `h`                 |
| grandfather unbounded (`grandfathered.has(h)` → `true`)                        | `s`         | `l`                 |
| grandfather advisory loses its `WARN:` prefix                                  | `l`         | `m`                 |
| registration loop restricted to `.js` (the discarded disk-walk direction)      | `v`         | all others          |
| `isMissingOwnSpecifier` → whole-message `includes()` (the pre-fix shape)       | `w`         | `w0`                |
| near-miss branch removed from `parseHookEventMarkers`                          | `x`         | `y`                 |
| near-miss over-broadened to match a bare keyword (`@?` prefix)                 | `y`         | `x`                 |

Two rows are worth reading twice. **The MUST-2 row reds THREE cases, not one** —
`v` and `r` each assert a MUST-2 verdict as their payload (that a registered `.mjs`
produces a row at all, and that a marker past any header slice is still seen), so
they inherit the MUST-2 predicate and are not independent of it. **The last two
rows are the bipolar pair in table form:** removing the near-miss detector reds
recall, over-broadening it reds precision, and only a corpus carrying BOTH poles
reds in both directions. A detector tightened in either direction alone stays green
on one half — which is exactly how the over-broad draft reached review.

## `fixture-allowlistMarker-*` — non-canonical allowlist bullet MARKER (2026-09-15)

14 cases — `a`–`k` (2026-09-15) plus `l`–`n` (2026-09-16) — over
`findUnrecognizedAllowlistBullets` + `parseSelfRefAllowlist`.

**The defect these pin was fail-open at TWO layers through ONE shared blind spot.**
`parseSelfRefAllowlist` recognizes a category bullet with `/^- \*\*/` — the literal
`- ` is load-bearing. `findUnrecognizedAllowlistBullets`, the detector whose entire
purpose is catching bullets the parser silently discards, used the **same anchor**.
So a bullet whose marker drifted to `*`, `+`, or an indent was invisible to both.

**Measured on the live corpus before the fix.** Rewriting one marker,
`- **Commands:**` → `* **Commands:**`, took the parsed allowlist from **220 entries
to 199**. Twenty-one load-bearing paths — `.claude/commands/codify.md` among them —
left the allowlist and stopped firing the Rule-1 self-referential redteam gate.
`validate-emit.mjs` **exited 0**, reported **0 fail**, and the only trace anywhere
in its output was a pass count that fell from 1844 to 1823. A pass count that DROPS
reads as "less to check", never as a defect. This is the `Rule-depth` precedent
("209 with this bullet present, 209 with its `paths:` line removed") in a second
dimension: there the LABEL was unrecognized, here the MARKER is.

**Why it matters now:** `npx prettier --write` has been disarmed for markdown in
`.claude/hooks/auto-format.js`. Prettier was normalizing list markers to `-` as an
**undeclared** side effect, and these line-oriented governance parsers silently
depended on it. `*` and `+` are valid CommonMark and render identically, so no
markdown tooling downstream would ever complain.

**The parser stays STRICT; the detector is what makes a violation LOUD.** Making
the parser marker-permissive instead would have absorbed the drift silently —
trading a fail-open for a fail-quiet — and left the other line-oriented sites
(`checkAllowlistBulletUniqueness`, `detection-binding-check.mjs::DETECTION_BULLET_RE`)
each deciding independently what a marker is. One canonical form, one loud detector.

| Case | Predicate                                                    | Expect  |
| ---- | ------------------------------------------------------------ | ------- |
| `a`  | CONTROL — canonical `- `, and the parser DOES read the path  | CLEAN   |
| `b`  | the measured live defect — `* `                               | FLAGGED |
| `c`  | `+ ` (third CommonMark marker)                                | FLAGGED |
| `d`  | INDENT drift — `  - `                                         | FLAGGED |
| `e`  | WIDTH drift — `-  ` (two spaces)                              | FLAGGED |
| `f`  | TAB indent — invisible in review, fatal to a line parse       | FLAGGED |
| `g`  | PRECISION CONTROL — indented backtick detail sub-bullets      | SILENT  |
| `h`  | SPAN SCOPING — non-canonical bullet OUTSIDE the span          | SILENT  |
| `i`  | marker drift and label drift are INDEPENDENT; both reported   | BOTH    |
| `j`  | ANTI-VACUITY — `nonCanonical` is a real populated array       | 2 rows  |
| `k`  | no span anchors ⇒ `spanOk:false`, never a silent clean        | SPAN-X  |
| `l`  | ORDERED-list marker — `1. `                                   | FLAGGED |
| `m`  | ORDERED-list marker — `1) `                                   | FLAGGED |
| `n`  | U+2011 NON-BREAKING HYPHEN lookalike                          | FLAGGED |

**`l`–`n` were the residual hole one keystroke wide (2026-09-16).** The `a`–`k`
fix widened the detector from `/^- \*\*/` to the marker class `[-*+]` — the three
CommonMark bullets. Three forms still matched **neither** the parser **nor** the
detector, so they were discarded in TOTAL silence, reproducing the very 220 → 199
disarm the `a`–`k` set was built to make loud. Measured against the live rule
file, each form independently: parsed allowlist **220 → 199**, `nonCanonical`
**`[]`**, `unrecognized` **`[]`**, `validate-emit.mjs` **exit 0 at 0 fail**.

`l`/`m` are ordinary CommonMark — a plausible edit when a reader decides to
number the categories. `n` is the one that matters most and is not a list marker
at all: CommonMark renders a U+2011-led line as a **paragraph**, so it silently
destroys the list, yet it is **indistinguishable from `-` in every editor, diff
and review surface**. It arrives by paste from a word processor or a rendered
doc, and it is the single form a human reviewer structurally cannot catch. Both
this fixture and the regex build it from its code point rather than pasting the
glyph — a literal U+2011 in either source would be unreviewable in exactly the
way the defect is.

**`g` is the load-bearing control.** The live corpus carries 31 indented detail
sub-bullets under the Rules category, each opening with a backtick rather than
`**`. A blanket `/^\s*[-*+]\s+/` draft would flag all 31 — a false-positive storm
that is exactly how an over-broad detector reaches review looking correct.

**Discrimination table.** Each mutation applied to `validate-emit.mjs` one at a
time (restored from a `cp` backup between runs), suite re-run. Clean baseline:
**69 passed, 0 failed, exit 0** (was 66 before `l`–`n` landed).

| Mutation applied to `ALLOWLIST_BULLET_ANY_MARKER`            | Reds                    | Controls stay green |
| ------------------------------------------------------------ | ----------------------- | ------------------- |
| reverted to the old blind `/^- \*\*/` shape                   | `b` `c` `d` `e` `f` `i` `j` | `a` `g` `h` `k`     |
| over-broadened — `\*\*` made optional                         | `g`                     | `a`–`f` `h`–`k`     |
| marker class narrowed back to `[-*+]` (the pre-`l`–`n` shape) | `l` `m` `n`             | `a`–`k`             |

The third row is the one to read twice: that mutation restores a detector which
**passes `a`–`k` in full** — every pole the previous round called sufficient —
and is still blind to three live forms. A fixture set is only ever evidence about
the forms it enumerates.

The two rows are the bipolar pair in table form: tightening the detector reds
recall (six markers go unseen again), loosening it reds precision (the 31 detail
sub-bullets flood). Only a corpus carrying **both** poles reds in both directions —
a detector tightened or loosened in either direction alone stays green on one half.

## Why structural probes

The validator's own output is structured (`{pass, fail, fixture-needed, skip}`
per artifact). The fixtures here exercise the predicates that produce those
statuses, not the validator's prose. Per `rules/probe-driven-verification.md`
MUST-3, this is the correct shape for a no-LLM CI verification path.
