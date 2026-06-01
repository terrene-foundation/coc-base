# scan-synced-disclosure audit fixtures

Per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md`
MUST-4. Mechanical regression locks for `.claude/bin/scan-synced-disclosure.mjs`
(issue #263). Runner: `node .claude/audit-fixtures/scan-synced-disclosure/run.mjs`
(exit 0 = all pass, 1 = regression).

**Every token in every fixture is SYNTHETIC and invented for this
fixture.** There are NO real operator hostnames, org slugs, runner
labels, home paths, or service labels anywhere under this directory —
the fixtures themselves are committed/synced artifacts and embedding a
real token here would be the #264 leak the scanner exists to prevent.
The flagging fixture uses `Fakename-MacStudio`, `Buildbot-Mini`,
`acme-fixture`, `acme-enterprise`, `acme-linux-arm`, `/Users/fakeuser/`,
`com.fakeco.runner.alpha` — all invented. The Option-1 own-coordinates
fixtures reference loom's OWN public host org and the maintainer's OWN
dev-checkout root (per the co-owner Option-1 ruling 2026-05-17, #263);
these are project self-coordinates, not client/3rd-party secrets, and
the `nonown-still-flagged` fixture's `acme-corp` / `/Users/notesperie/`
tokens are invented synthetics.

| Fixture                         | Scans (`--root`)                                                                                  | Expects             | Predicate locked                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `flag-each-shape/`              | a synced tree planting all 5 structural shapes                                                    | exit 1              | each of the 5 shapes (hostname, org-slug, runner-label, home-path, service-label) flags ≥1                         |
| `clean-foundation-placeholder/` | Foundation-public + ratified placeholder vocab                                                    | exit 0              | the positive allowlist suppresses every Foundation/placeholder token (zero findings)                               |
| `excluded-accepted-history/`    | `SWEEP-*.md` + `journal/**` with planted shapes                                                   | exit 0              | accepted-history paths are excluded — a planted real-shape token there MUST NOT flag                               |
| `own-org-allowed/`              | loom's own host org + own dev-home-path tokens                                                    | exit 0              | Option-1 allowlist suppresses `esperie-enterprise` + `/Users/esperie/` self-coordinates                            |
| `nonown-still-flagged/`         | non-own `acme-corp/loom` + different-operator home, alongside own coords                          | exit 1              | own-org allowlist did NOT neuter detection — non-own org slug + foreign home path still flag                       |
| `r2-org-forms/`                 | SSH-clone / `gh api orgs/` / bare / issue-ref / kailash- / coc- org forms                         | exit 1 + 6 findings | R2 must-fix #1 — every org-slug FORM flags; Foundation/own on same surface stays clean                             |
| `r2-allowlist-anchor/`          | typosquats `esperie-enterprise-evil/loom` + `nexus-enterprise-evil/loom`                          | exit 1 + 3 findings | R2 must-fix #2 — anchored allowlist no longer swallows a prefix-typosquat                                          |
| `r2-hostname-runner/`           | `*-linux-arm64/aarch64/x86_64`, lowercase `bar-mini`, Mac products, `Proc-Macro`, `X-MacBook-Pro` | exit 1 + 8 findings | R2 #3+#4 + R3 #A — arch suffixes + lowercase mini + single-uppercase stem flag; `Proc-Macro` does NOT (count lock) |
| `r2-exclusion-scoping/`         | `rules/journaling-guide.md` (synthetic leak) + genuine `journal/0001-note.md`                     | exit 1 + 2 findings | R2 must-fix #5 — `journaling-guide.md` IS scanned; `journal/` dir stays excluded (both halves)                     |
| `r3-variant-surface/`           | committed `variants/rs/rules/leakrule.md` + `*.operator.local.md` companion                       | exit 1 + 2 findings | R3 #B — variants/ ARE synced (overlay leak flags); operator.local stays excluded via suffix                        |
| `r3-smuggle-closed/`            | `chore/<org>/loom` + `<scheme>://<org>/loom` smuggle + 9 flood vectors                            | exit 1 + 4 findings | R3 #D — branch/scheme-prefixed org smuggle CLOSED; closed-set anchor does NOT flood prose                          |
| `f77-settings-good/`            | synced `.claude/settings.json` w/ `$CLAUDE_PROJECT_DIR`-rooted matchers only                       | exit 0              | F77 (#386) — clean settings.json passes (settings.json is now in walk surface; relative-path matchers are clean)   |
| `f77-settings-bad/`             | synced `.claude/settings.json` w/ `Edit/Write/Read(/Users/fakeuser/...)` + `Bash(/home/...)`        | exit 1              | F77 (#386) — new settings-permission-absolute-path SHAPE fires on every tool-call matcher with an absolute path    |
| `f77-settings-own-coords-still-flagged/` | synced `.claude/settings.json` w/ `Edit(/Users/esperie/...)` (own dev path)              | exit 1              | F77 (#386) — new SHAPE skips Option-1 allowlist for tool-call matchers (own/foreign distinction does not apply)    |

## Per-fixture detail

- **`flag-each-shape/.claude/rules/planted.md`** — one synthetic
  instance of each shape. Proves the 5 structural SHAPE regexes fire.
  Expected: `--check` exits 1; all 5 `[SHAPE:<id>]` ids appear.
- **`clean-foundation-placeholder/.claude/rules/clean.md`** — the full
  positive allowlist vocabulary (Foundation slugs, framework names,
  ratified `<...>` placeholders, public-doc `/Users/runner/` etc.,
  public-SDK enterprise-tier doc compounds). Proves the allowlist does
  not false-positive. Expected: `--check` exits 0; zero findings.
- **`excluded-accepted-history/.claude/SWEEP-2026-05-17.md`** and
  **`…/.claude/journal/0001-note.md`** — planted synthetic shapes inside
  accepted-history paths. Proves `SWEEP-*.md` and `journal/**` are
  excluded from the walk. Expected: `--check` exits 0 (the planted
  tokens are never scanned).
- **`own-org-allowed/.claude/rules/owncoords.md`** — loom's own GitHub
  host org (`esperie-enterprise`, `esperie-enterprise/loom`,
  `github.com/esperie-enterprise/loom.git`) + the maintainer's own
  dev-home-path (`/Users/esperie/...`, `/home/esperie/...`). Per the
  co-owner Option-1 ruling 2026-05-17 (#263) these are project
  self-coordinates, not a client/3rd-party disclosure. Proves the
  Option-1 allowlist suppresses own coordinates. Expected: exit 0.
- **`nonown-still-flagged/.claude/rules/nonown.md`** — a non-own /
  3rd-party org slug (`acme-corp/loom`), a synthetic `acme-enterprise`,
  and a _different_ operator's home path (`/Users/notesperie/...`),
  placed on the SAME surface as own coordinates. Proves the Option-1
  own-org allowlist did NOT neuter genuine detection — the non-own
  tokens still flag while the adjacent own coords do not. Expected:
  `--check` exits 1; `nonfoundation-org-slug` + `operator-home-path`
  shapes appear.

### R2 detection-completeness locks (issue #263 Round-2)

The Round-1 redteam found the disclosure axis converged but the
completeness axis missed 6 HIGH false-negative classes. These four
fixtures lock the R2 hardening. Each carries an exact `expectFindingCount`
— a count delta is a false-positive (extra finding) OR false-negative
(missing form) regression even when the shape-SET still matches, so the
count lock is stricter than shape-presence alone.

- **`r2-org-forms/.claude/rules/orgforms.md`** — six org-slug FORMS the
  Round-1 shape missed: SSH-clone (`git@github.com:acme-corp/loom.git`),
  `gh api orgs/<org>`, bare `<org>/<repo>` in prose, issue-ref
  `<org>/<repo>#N`, `<org>/kailash-*`, `<org>/coc-*`. Foundation + own
  coordinates on the SAME surface MUST NOT flag. Expected: exit 1,
  exactly 6 `nonfoundation-org-slug` findings (the clean Foundation/own
  lines are the count lock — a 7th finding = own-coord regression).
- **`r2-allowlist-anchor/.claude/rules/anchor.md`** — prefix-typosquats
  of the own host org + an SDK enterprise compound
  (`esperie-enterprise-evil/loom`,
  `gh api repos/esperie-enterprise-evil/kailash-py`,
  `nexus-enterprise-evil/loom`). The R1 unanchored allowlist swallowed
  these (silent leak). Expected: exit 1, exactly 3 findings; the EXACT
  own org + EXACT public SDK doc compounds stay clean.
- **`r2-hostname-runner/.claude/rules/hostrunner.md`** — runner-label
  arch suffixes (`-linux-arm64`/`-aarch64`/`-x86_64`), lowercase
  `<op>-mini`, real Mac products (`Foo-MacStudio`, `Bar-MacBookPro`,
  `Baz-Mac.local`), the R3 single-uppercase-stem `X-MacBook-Pro`, and a
  `Proc-Macro` NEGATIVE. Expected: exit 1, exactly 8 findings (was 7;
  +1 for the R3 `X-MacBook-Pro` case) — the count is the `Proc-Macro`
  lock (a 9th finding = the `-Mac` arm regressed to swallow
  `Proc-Macro`).
- **`r2-exclusion-scoping/`** — `rules/journaling-guide.md` (basename
  STARTS with `journal` but is NOT accepted-history) carries a synthetic
  leak that MUST be scanned + flagged; the sibling genuine
  `journal/0001-note.md` (a real `journal/` directory entry) MUST stay
  excluded. Expected: exit 1, exactly 2 findings — both halves locked
  (over-exclusion gone AND accepted-history `journal/` intact; a 3rd
  finding = the journal-dir exclusion over-corrected).

### R3 composed-variant-surface + smuggle locks (issue #263 Round-3)

The Round-2 redteam found both axes still ITERATE: the
operator-hostname shape evaded a single-uppercase stem (#A), the
scanner blanket-excluded the `variants/**` overlay tree that ACTUALLY
composes into the synced surface (#B/#C), and a 3rd-party org could
smuggle past the anti-flood lookbehind on a branch/scheme prefix (#D).

- **`r3-variant-surface/.claude/variants/rs/rules/leakrule.md`** — a
  committed variant overlay (NOT a `*.operator.local.md` companion)
  carrying a synthetic runner-label + org-slug leak. Proves Fix B:
  `variants/**` is NO LONGER blanket-excluded, so a real operator
  token in a committed overlay (which composes into every consumer of
  that language template) IS flagged. The sibling
  `ci-runners.operator.local.md` carries synthetic real-operator-style
  values and MUST stay excluded — via the `*.operator.local.md`
  SUFFIX rule (runs before `isNeverSynced`), NOT a blanket variants/
  exclusion. Expected: exit 1, exactly 2 findings — a 3rd finding =
  the operator.local companion regressed into scope.
- **`r3-smuggle-closed/`** — `smuggle.md` plants 4 branch/scheme-prefix
  smuggle forms (`chore/<org>/loom`, `postgres://<org>/loom`,
  `feat/<org>/kailash-rs`, `fix/<org>/coc-sync`) that the R2 4th-alt
  lookbehind let evade; the 5th alternative CLOSES them.
  `cleanlocks.md` plants 9 flood vectors (real branch names,
  internal FS paths, public SDK URLs, DB connection strings, own-org)
  that MUST stay clean. Expected: exit 1, exactly 4 findings — both
  halves locked (close fires AND does not flood; a 5th finding = the
  close over-extended into a prose-path flood). Disposition: CLOSED.

A change to the scanner that weakens a shape, over-extends the
allowlist to swallow a real token, breaks an exclusion predicate,
re-introduces any of the 6 R2 false-negative classes, re-blankets the
composed variant surface, or floods the smuggle-close will flip one of
these fixtures and the runner exits 1.
