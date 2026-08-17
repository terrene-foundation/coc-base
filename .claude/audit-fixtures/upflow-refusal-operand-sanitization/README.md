# upflow-refusal-operand-sanitization — audit fixtures

Locks refusal-operand sanitization in the two VCS adapters
(`.claude/hooks/lib/vcs-github-adapter.js`, `vcs-azure-adapter.js`) for GH issue
**#83**.

Run:

```bash
node .claude/audit-fixtures/upflow-refusal-operand-sanitization/run.mjs
```

(exit 0 = pass). No CI runner invokes it — like its two siblings, this tier is
**committed-fixtures-manually-driven**, not a live gate. Stated plainly rather
than described as blocking.

Layout: inline-case runner — the variant `cc-artifacts.md` Rule 9 sanctions (see
`../codex-dispatcher/README.md` § "Fixture layout").

## What the suite locks

Every free-form operand interpolated into a `{ok:false, reason}` string in either
adapter now goes through one of three helpers, whose sanitization CLASS is the
one shared `upflow-self-repo.js::sanitizeForReason`:

| Helper                 | Replaces                                            | Adds                                        |
| ---------------------- | --------------------------------------------------- | ------------------------------------------- |
| `reasonOperand(x)`     | every former `JSON.stringify(x)` operand            | keeps the JSON shape, then sanitize + bound |
| `reasonText(x)`        | every bare `${x}` interpolation in refusal prose    | sanitize + bound                            |
| `reasonFromError(err)` | `${err && err.message ? err.message : String(err)}` | URL-userinfo scrub, then sanitize + bound   |

All three share `_scrubAndBound`: URL-userinfo scrub → 256-code-point bound →
`sanitizeForReason`.

## Why `JSON.stringify` was never a sanitizer for this class

`JSON.stringify` was the escaping mechanism at ~45 sites across the two files.
Per ECMA-262 `QuoteJSONString` it escapes `"`, `\`, and code units **below
0x20** (plus lone surrogates since ES2019) — and nothing else. It leaves
verbatim:

- `0x7f` DEL
- the whole C1 range `0x80`–`0x9f`, **including `U+009B` 8-bit CSI** — an ANSI
  control introducer that contains no `ESC`, so it passes every ESC-based check
- `U+2028` / `U+2029`
- every bidi control (`U+202A`–`U+202E`, `U+2066`–`U+2069`, `U+200E`/`U+200F`,
  `U+061C`)

So a `JSON.stringify`'d operand was escaped against the classes that were never
the threat and unescaped against the ones that were. Every hostile payload in
this suite is drawn from exactly that set (`JSON_BLIND`), plus the C0 members
(`RAW_ALL`) for the sites that had no `JSON.stringify` at all.

## RED before the fix — verbatim

Written and observed failing BEFORE any adapter change
(`instrument-discipline.md` MUST-1: a case green before the fix is not an
instrument for the fix). Full run: **29/35 FAILED**. Representative lines,
verbatim:

```
  ✗ gh/createUpflowPR/head-refusal-neutralizes-json-blind-classes
      gh head: U+007F survived verbatim in reason: "head must match /^[A-Za-z0-9._/-]+$/ with no '..' segment (git ref shape); got \"head  ‮⁦‏؜FORGED-SECOND-LINE\""
  ✗ gh/response-body-refusal-neutralizes-remote-controlled-bytes
      gh !ok body: U+007F survived verbatim in reason: "gh api repos/acme/widget → status 404 body {\"message\":\"head  ‮⁦‏؜FORGED-SECOND-LINE\",\"documentation_url\":\"x\"}"
  ✗ gh/transport-error-refusal-scrubs-url-userinfo
      credential survived in reason: "network unavailable or transport threw: fatal: unable to access 'https://oauth2:ghp_ZZZZ000011112222333344445555666677@github.com/acme/widget.git/': 403"
  ✗ gh+ado/response-body-refusals-are-bounded
      gh huge body: reason is 200057 chars (ceiling 1500) — operand not bounded
  ✗ gh/hostile-body-serializer-does-not-crash-the-refusal
      threw: Converting circular structure to JSON
  ✗ gh+ado/non-error-throwables-do-not-crash-the-refusal
      threw: hostile getter
  ✗ gh+ado/both-adapters-bound-and-sanitize-identically
      operand was not bounded: gh kept 50000, ado kept 50000
```

The six cases that were GREEN before the fix are all in § D/E (the preservation
polarity). That is expected and is stated rather than glossed: their job is to
catch **over-tightening introduced BY the fix**, so "green before, green after"
is the correct trajectory for them — and each one still has a measured
reddening mutation in the table below, which is what makes it an instrument
rather than a decoration.

The 36th case (`exported-validateRepoRef-reason-is-sanitized-at-source`) was
added after the first green, when the enforcement-surface sweep found the
adapters' own exported `validateRepoRef` still returned an un-sanitized reason
to any OTHER consumer. It was observed RED against that intermediate state
(mutation M13 below reproduces it).

## Mutation validity

`instrument-discipline.md` MUST-2(b): a mutation that does NOT red leaves TWO
live hypotheses — vacuous test OR inert mutation — so an un-run `mutation:`
field is a claim, not evidence. **All 17 mutations below were EXECUTED** against
the LIVE tree (apply → run the suite → revert, one at a time, scripted so no
mutation could be left behind).

M1–M13 all redded on the original pass. Of the three added later, M14–M16 redded;
**one earlier attempt at M14 came back INERT and was resolved rather than read as
a verdict** — it targeted `return _scrubAndBound(s);`, which does not match
`reasonFromError`'s call shape (`_scrubAndBound(typeof s === "string" ? …)`), so
the mutation never reached the path under test and the case stayed green for a
reason unrelated to the property. Per MUST-2(b) that left two live hypotheses
(vacuous case vs inert mutation); re-targeting the mutation correctly redded the
case, which resolves it as INERT. Recorded because reading that first green as
"the case is vacuous" would have retired a working instrument.

| #   | Mutation                                                                     | Cases redded                                                     |
| --- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| M1  | `reasonOperand` → return raw `JSON.stringify(value)` (no sanitize, no bound) | 18 — every § A descriptor-operand + § B body case + parity       |
| M2  | `reasonFromError` → return the raw `err.message`                             | 5 — both transport-error class cases, both PAT cases, bound case |
| M3  | `reasonText` → return raw `String(value)`                                    | 4 — both `repoRef` echo cases, both `principal` cases            |
| M4  | userinfo regex made unmatchable (drops the scrub ONLY)                       | 2 — `gh/…scrubs-url-userinfo`, `ado/…scrubs-url-userinfo`        |
| M5  | bound drift: gh `REASON_OPERAND_MAX` 256 → 4096, ado unchanged               | 3 — both bound cases + `both-adapters-bound-…-identically`       |
| M6  | over-tighten: ASCII-only class instead of the shared `sanitizeForReason`     | 2 — both `legitimate-non-ascii-operand-survives-readable`        |
| M7  | `reasonOperand` → drop the `try/catch` around `JSON.stringify`               | 1 — `gh/hostile-body-serializer-does-not-crash-the-refusal`      |
| M8  | `reasonFromError` → drop the `try/catch` around `err.message`                | 1 — `gh+ado/non-error-throwables-do-not-crash-the-refusal`       |
| M9  | over-scrub: widen the userinfo regex so it also masks scp-form `git@host`    | 1 — `gh/ordinary-transport-error-survives-verbatim`              |
| M10 | over-encode: `reasonOperand` uses `String(value)`, dropping the JSON shape   | 1 — `gh/small-error-body-survives-as-readable-json`              |
| M11 | over-quote: `reasonOperand` JSON-encodes a number as a string                | 2 — the small-body case + `numeric-status-still-renders-bare`    |
| M12 | misapplication: route a SUCCESS-path return value through the helper         | 1 — `gh+ado/successful-calls-are-unaffected`                     |
| M13 | `validateRepoRef` → interpolate `${o.reason}` / `${p.reason}` raw again      | 1 — `exported-validateRepoRef-reason-is-sanitized-at-source`     |

| M14 | text path (`reasonText`/`reasonFromError`) → the JSON pattern `[^\s"]` | 1 — `…-covers-a-credential-containing-a-double-quote` |
| M15 | JSON path (`reasonOperand`) → the text pattern `[^\s]` | 1 — `…-does-not-span-json-field-boundaries` |
| M16 | make the terminating `@` optional (`@?`) | 3 — `…-leaves-an-at-free-url-untouched` + 2 userinfo-scrub cases |

**The count was WRONG here for four revisions and is corrected rather than
quietly updated.** This section read "Every one of the 36 cases appears in at
least one row" while the suite grew to 43 — a false claim about coverage, in the
file whose entire subject is that claims about instruments must be measured. The
seven cases the M1–M13 table never covered are the userinfo-scrub cases added
across the adversarial rounds; M14–M16 above close three of them, and the
remaining four are covered by the RED-before-fix measurements recorded in
§ "RED before" (each was observed failing against the unfixed code, which is the
same evidence a mutation provides — the pre-fix source IS the mutation).

**M17** — `_URL_USERINFO_JSON_RE` → drop the `\\.` escape-pair alternative (back
to a plain `[^\s"]` run) → reds exactly 1,
`…-masks-a-quote-bearing-credential-inside-json`. Executed; an earlier attempt at
this mutation was INERT (a `perl` pattern that never matched, so the constant was
unchanged and the suite stayed green) — resolved by re-applying it as a literal
edit and confirming the constant actually changed before reading the result.

**Two cases are NOT mutation-validated and are recorded as such:**
`…-still-masks-a-credential-inside-a-json-field` (the paired polarity for M15) and
`…-masks-a-credential-in-double-encoded-json` (the nested-escape case). Both were
verified to PASS against the shipped code, and neither has had its own reddening
mutation executed. Per `instrument-discipline.md` MUST-2(b) that is stated, not
implied — each is a plausible instrument, not a measured one, until someone points
`reasonOperand` at a pattern that lets a JSON-embedded credential through and
observes it red.

So: **45 cases**. Re-derive rather than trusting this line —
`node .claude/audit-fixtures/upflow-refusal-operand-sanitization/run.mjs | tail -1`.

This count has now been wrong twice, in both directions, and both times the fix
for one round's stale number went stale inside the same session as new cases
landed. Re-derive it rather than trusting this line:
`node .claude/audit-fixtures/upflow-refusal-operand-sanitization/run.mjs | tail -1`.

**Provenance:** all 17 passes ran in the LIVE working tree (not a `cp -R`
sandbox); each pass restored the mutated file from a backup before the next, and
`git status --porcelain` was clean afterwards. M1–M13 mutated the two adapters
this change owns; M14–M17 mutated `upflow-self-repo.js`, which now holds the
shared bound+scrub helpers and both userinfo patterns.

This count said "13" through four revisions while mutations M14–M17 were added
above it — the same hand-asserted-number failure the case-count line two
paragraphs up records twice. Re-derive rather than trusting it:
`grep -c '^| M[0-9]' README.md` (table rows) plus the prose M17 entry.

## What a green run does and does NOT prove

**Does prove.** Every operand this suite drives — descriptor fields (`head`,
`base`, `title`, `workflow`, `ref`, `inputs`, `key`, `labels`, `pipeline`,
`workItemType`, `sha`), the validator echo, `principal`, remote-controlled
response bodies, transport error text, and the exported `validateRepoRef`
reason — is stripped of the `JSON.stringify`-blind classes, bounded, and (for
transport errors) userinfo-scrubbed; and that a legitimate operand still reads
back correctly.

**Does NOT prove.**

1. **It is not a completeness proof over the two files.** The suite drives the
   refusal sites it names. The claim that _every_ site is routed rests on a
   grep-and-account sweep recorded in the change, not on this suite — a NEW
   refusal site added later with a raw `${x}` would not red anything here.
2. **It is not a claim about log consumers.** Sanitization happens where the
   reason is BUILT. Anything that later re-renders, re-encodes, or concatenates
   these strings is out of scope.
3. **The userinfo scrub covers URL userinfo only.** A credential a transport
   surfaces some other way — an `Authorization: Basic <b64>` header echoed into
   an error string, a token in a query parameter — is NOT matched by the regex
   and would pass through (bounded and class-sanitized, but unmasked). Recorded
   as a residual, not fixed here.
4. **The scrub has a window.** It examines the first 8192 UTF-16 units of an
   operand. A URL whose userinfo is itself longer than that window has no
   terminating `@` inside it, so it does not match. Real PATs are under ~100
   chars; this is stated, not relied upon.
5. **The bound is per-OPERAND, not per-reason.** A reason interpolating several
   operands can reach a few hundred characters more than 256. The suite asserts
   a whole-reason ceiling of 1500 as the discriminating check, which is far
   below the 200 kB the unfixed code produced but is not a tight bound.
6. **`completeUpflowPR`'s fence refusals are only partly exercised here.** Their
   own branches are instrumented by `../upflow-open-never-complete/`, which
   drives real temp repos through a subprocess. This suite covers the operand
   rendering on the paths reachable in-process.

## Source-literal discipline

Payload characters are built with `String.fromCharCode`, never written as source
literals. A bidi override or raw C1 byte written literally into `run.mjs` would
be invisible to a reviewer — precisely the property these helpers exist to
remove from output. The one place a literal WOULD have been readable (the
non-ASCII preservation cases use `déploiement-café`) is deliberate: that string
must be legible, because the assertion is that it survives.

## Sibling suites

- `../upflow-open-never-complete/` — the `upstream-issue-hygiene.md` MUST-4
  structural fence on `completeUpflowPR` (47 cases; must stay green).
- `../upflow-self-repo-helpers/` — module-level guards including
  `sanitizeForReason` and `displayPrId` themselves (9 cases; must stay green).
  This suite depends on `sanitizeForReason`'s character class, so that suite is
  the instrument for the class and this one for its APPLICATION.
