# upflow-open-never-complete — audit fixtures

Locks the structural fence on `completeUpflowPR` in BOTH VCS adapters
(`.claude/hooks/lib/vcs-github-adapter.js`, `vcs-azure-adapter.js`) for
`upstream-issue-hygiene.md` MUST-4 ("Open, Never Complete").

Run:

```bash
node .claude/audit-fixtures/upflow-open-never-complete/run.mjs
```

Layout: inline-case runner — the variant `cc-artifacts.md` Rule 9 sanctions
(see `.claude/audit-fixtures/codex-dispatcher/README.md` § "Fixture layout").

## Why the suite drives real temp repos through a subprocess

`completeUpflowPR` derives the self-identity from `process.cwd()` and takes no
identity, `cwd`, or deriver value off its DESCRIPTOR. (`deriveSelfRepoRef` does
take a `cwd` argument — both adapters hardcode it to `process.cwd()`; what was
removed is the caller's ability to supply one.) So the only place `cwd` can be
set is the PROCESS boundary.

**What that means for what this suite proves — stated here because the README is
read standalone.** A green run does NOT show the fence is an identity boundary.
`process.cwd()` is selected by whoever launches the process, so a scratch tree
whose `origin` points at the upstream derives that upstream and clears the fence.
What the fence does, and what these cases lock, is: it refuses any completion
whose target does not match the identity derived from the working tree the
process runs in — which CLOSES the accident class (an agent following stale prose
is refused before the transport fires, and that accident IS the originating
incident) and RAISES THE COST of a deliberate act. It is NOT a boundary against a
caller that can choose its own working directory, and it cannot be: a caller able
to run arbitrary in-process code can replace the module outright. Asserting
seam-freedom without this paragraph reads as a stronger control than exists. Each case therefore `mkdtemp`s a
directory, `git init`s it, configures the origin remote (and optionally a
`.claude/VERSION`) that case needs, and spawns a child `node` with `cwd` set
there.

This shape is deliberate. An earlier cut of this file drove the fence through a
`_deriveSelfFn` seam, which meant the suite was exercising an injection point
rather than the fence — and the caller-authored operand was MOVED TWICE before
it was removed: three shapes across two corrections (`selfRepoRef` →
`_deriveSelfFn` → `cwd`), each defeated in turn. Giving the test its real preconditions, rather than stubbing past
them, is what makes a green here mean anything.

Transport injection stays: that is the NETWORK seam, and it is what makes "did
the fence refuse BEFORE any call went out?" answerable. A fence that merged and
then returned `ok:false` would satisfy a naive `ok === false` assertion, so every
case asserts `fired === false` on the refusal paths.

Each case also asserts `error === null`. Deleting a fail-closed guard usually
makes the next line throw on `undefined`, and a bare `ok === false` assertion
accepts that crash as a refusal. Asserting the refusal is a TYPED refusal rather
than a crash is what gives those guards an instrument.

## Mutation validity

`instrument-discipline.md` MUST-2(b): a mutation that does NOT red the suite
leaves TWO live hypotheses — vacuous test OR inert mutation — so an un-run
`mutation:` field is a claim, not evidence.

The table below was MEASURED: each mutation was applied to the real source one at
a time, the suite run, the reddened cases recorded, and the file restored and
verified byte-identical to its original content.

| #   | Mutation                                                                                                                                   | Predicate it removes                                                        | Verdict | Cases reddened                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `deriveSelfRepoRef` — on `!url`, fall back to `_declaredSlug(cwd)` as an identity SOURCE instead of refusing                               | the no-dirname-fallback invariant (the CRIT-2 exploit path)                 | RED     | `gh/no-origin-remote-refuses`                                                                                                    |
| 2   | `deriveSelfRepoRef` — neuter the `declared !== slug` disagreement refusal                                                                  | `.claude/VERSION::repo` is refuse-only and can never SUPPLY the identity    | RED     | `gh/version-remote-disagreement-refuses-even-own-repo`                                                                           |
| 3   | `normalizeComponent` — drop `.toLowerCase()`                                                                                               | case-folding on both providers                                              | RED     | `gh/case-insensitive-own-repo-still-allowed`, `ado/case-insensitive-own-repo-still-allowed`                                      |
| 4   | `normalizeComponent` — drop the `/\.git$/i` strip                                                                                          | `.git`-suffix normalization                                                 | RED     | `gh/allow-maintainer-merging-own-repo`, `gh/case-insensitive-own-repo-still-allowed`, `gh/dot-git-suffix-own-repo-still-allowed` |
| 5   | `isSelfRepoAdo` — compare only `project`+`repo`, dropping `org`                                                                            | ADO cross-org discrimination                                                | RED     | `ado/cross-org-same-project-and-repo-refuses`                                                                                    |
| 6   | `vcs-github-adapter.js::completeUpflowPR` — delete the `isSelfRepo` refusal block                                                          | the GitHub cross-repo refusal                                               | RED     | `gh/refuse-downstream-merging-upstream`                                                                                          |
| 7   | `vcs-azure-adapter.js::completeUpflowPR` — replace the `!selfAdo` refusal with the self-compare fallback `if (!selfAdo) selfAdo = repoRef` | the ADO non-ADO-remote refusal (restores the historical self-comparing leg) | RED     | `ado/non-ado-remote-refuses`                                                                                                     |

Row 5 is the highest-value row. Before this change the ADO `org` leg compared
`repoRef.org` against itself — `deriveSelfRepoRef` never returned an `.org`, so
the leg could never fail. Row 7 restores that exact historical bug and confirms
the suite now catches it.

### Second pass — the rows the table above does not reach

The seven rows above leave 7 of the suite's 16 cases with no recorded mutation,
so a second, independent pass extended the set. Method differs in one respect,
stated because it changes what the result means: this pass applied each mutation
to a **byte-copy of `.claude/hooks/`** in a scratch sandbox (the suite run from a
mirrored path), NOT to the live tree — sibling agents were editing those adapters
concurrently, and an in-place mutate/restore cycle would have raced their work.
The sandbox reproduced the 16/16 baseline before the first mutation and again
after the last.

Every row below RED. On all seven mutations this pass shares with the table
above, the reddened-case sets agreed exactly.

| #   | Mutation                                                                           | Predicate it removes                                     | Verdict | Cases reddened                                                                                                                   |
| --- | ---------------------------------------------------------------------------------- | -------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 8   | `isSelfRepo` — `return false` at the top                                           | the GitHub self-match itself (fence unconditional)       | RED     | `gh/allow-maintainer-merging-own-repo`, `gh/case-insensitive-own-repo-still-allowed`, `gh/dot-git-suffix-own-repo-still-allowed` |
| 9   | `_parseRemoteUrl` — treat a bare filesystem path's last two segments as owner/name | "a bare path is not a hosting identity"                  | RED     | `gh/bare-path-remote-refuses`                                                                                                    |
| 10  | `deriveSelfRepoRef` — prefer `_declaredSlug` over the remote when present          | VERSION is refuse-only and can never SUPPLY the identity | RED     | `gh/forged-version-cannot-authorize-its-named-repo`                                                                              |
| 11  | `vcs-azure-adapter::completeUpflowPR` — disable the `isSelfRepoAdo` refusal        | the ADO cross-repo refusal                               | RED     | `ado/refuse-downstream-completing-upstream`, `ado/cross-org-same-project-and-repo-refuses`                                       |
| 12  | `_splitRemoteUrl` — drop the userinfo strip                                        | `https://<org>@dev.azure.com/…` host parsing             | RED     | `ado/allow-maintainer-completing-own-repo-userinfo-form`, `ado/allow-own-repo-ssh-v3-form`                                       |
| 13  | `_parseAdo` — drop the leading-`v3` segment strip                                  | the ssh v3 remote form                                   | RED     | `ado/allow-own-repo-ssh-v3-form`                                                                                                 |
| 14  | `_parseAdo` — drop the `isOrgSubdomain` branch                                     | `<org>.visualstudio.com` org-from-host derivation        | RED     | `ado/allow-own-repo-visualstudio-subdomain-form`                                                                                 |
| 15  | `vcs-azure-adapter::completeUpflowPR` — delete the `!d.ok` underivable refusal     | the ADO fail-closed underivable branch                   | RED     | `ado/no-origin-remote-refuses-typed-not-throws`                                                                                  |

### Fourth pass — the owner leg had no instrument until case 17

An adversarial security review reasoned that `isSelfRepo`'s OWNER comparison was
never the discriminator: every GitHub case expecting a refusal shared an owner
with self (`terrene-foundation/...` vs `terrene-foundation/...`) and differed
only in NAME, so the name leg carried all of them. Measured, and confirmed:

| #   | Mutation                                                           | Predicate it removes            | Before case 17                  | After case 17                            |
| --- | ------------------------------------------------------------------ | ------------------------------- | ------------------------------- | ---------------------------------------- |
| 16  | `isSelfRepo` — drop the `a === self.owner` leg, keep only the name | the GitHub owner discrimination | **GREEN 16/16 — NO INSTRUMENT** | RED — `gh/cross-owner-same-name-refuses` |

This is the same "leg that can never fail" defect README row 5 records for the
ADO `org` comparison, reproduced on the PRIMARY lane and missed by every earlier
pass. Row 8 (`isSelfRepo` → `return false`) does NOT cover it: that reds only the
permissive cases, proving the function is CALLED, not that the owner comparison
is load-bearing. A cross-owner completion was correctly refused before case 17
existed — nothing locked it.

The GREEN reading here is a genuine no-instrument verdict rather than an inert
mutation, because row 8 independently established that `isSelfRepo` executes.

### Fifth pass — a broad predicate sweep, and two more uninstrumented legs

The four passes above each mutated predicates someone had already thought of. The
fifth ran a 21-mutation sweep in a sandbox with a pristine-copy restore and a
per-run sha256 byte-identity check.

**CORRECTED — an earlier revision of this heading said "EXHAUSTIVE" and claimed
the sweep enumerated "EVERY comparison and guard in the fence". Both were wrong,
and wrong in the shape this file exists to reject.** The 21 mutations were never
listed here — only the five greens were — so no result the record could have
shown would have falsified the completeness claim. That is exactly the
`instrument-discipline.md` MUST-1 defect: a claim with no nameable falsifying
observation. It was also false on its own terms: `_readOriginRemote`'s two guards
(`resolveGitBinary()` returning null, and `env: gitEnv()`) sit inside the
"derivation refusals" the heading claimed as in-scope, and a later round found
BOTH uninstrumented — so either they were swept and their green went unrecorded,
or the sweep was not what the heading said.

The honest statement: this pass swept the predicates listed in the table below
plus the ones it reports as green. It is a BROAD sweep, not a proven-complete
one. Treat "no sixth uninstrumented predicate exists" as unproven — the sweep
after this one found two more.

It found **five** green predicates, and their dispositions are NOT the same. That
distinction is the whole point of MUST-2(b): a green leaves two live hypotheses,
and only establishing reachability tells you which.

| Sweep | Predicate                                         | Result | Disposition                                                                                                                                                                                                                           |
| ----- | ------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P5    | `isSelfRepoAdo` — drop `project` from the keys    | GREEN  | **GENUINE no-instrument → FIXED** (case `ado/cross-project-same-org-and-repo-refuses`; now REDs)                                                                                                                                      |
| P12   | GH adapter — drop the `GITHUB_HOSTS` check        | GREEN  | **GENUINE no-instrument → FIXED** (case `gh/non-github-host-remote-refuses`; now REDs)                                                                                                                                                |
| P3    | `isSelfRepo` — drop both null guards              | GREEN  | UNREACHABLE via the public API — `validateRepoRef` runs BEFORE the fence and `validateGithubLogin` rejects non-strings, so null components cannot reach `isSelfRepo` through `completeUpflowPR`. Defensive depth, not a vacuous test. |
| P7    | `isSelfRepoAdo` — drop null-component rejection   | GREEN  | Same as P3.                                                                                                                                                                                                                           |
| P19   | `_parseRemoteUrl` — accept a bare filesystem path | GREEN  | Reached, outcome unchanged — the case still refuses. The specific downstream guard responsible was NOT confirmed, so no cause is recorded here.                                                                                       |

Two mutations were INERT (pattern matched ≠1 time) and licensed no conclusion:
dropping `toLowerCase` (x2) and the GH `ado === null` requirement (x4).

**P5 is the THIRD instance of the same defect** — after the ADO `org` leg and the
GitHub `owner` leg. The existing ADO cases differ in ORG or in REPO, never in
PROJECT alone, so nothing could distinguish it. When a defect class recurs three
times, enumerating the whole predicate set beats mutating the ones you happen to
think of.

**P12 is the more uncomfortable one:** the host check was itself a fix from the
PREVIOUS round (a GitLab mirror of an upstream derived as that upstream, and the
GitHub adapter then merged against github.com). It shipped with no instrument at
all — a fix landing untested inside a change whose subject is untested claims.

### Sixth pass — two more Round-2/3 fixes that shipped with no instrument

A third adversarial round found that TWO more guards added by earlier rounds had
no case that could distinguish them, and that one existing case's mutation had
never been run at all. Both measured here.

| #   | Mutation                                                               | Predicate it removes                            | Verdict | Cases reddened                                                            |
| --- | ---------------------------------------------------------------------- | ----------------------------------------------- | ------- | ------------------------------------------------------------------------- |
| 17  | `_splitRemoteUrl` — drop the `authCut` truncation at the first `#`/`?` | authority termination (fail-OPEN on removal)    | RED     | `gh/fragment-authority-spoof-refuses`, `gh/query-authority-spoof-refuses` |
| 18  | `normalizeComponent` — delete the `/^[\x00-\x7f]*$/` ASCII pre-check   | non-ASCII case-folding collision (U+212A → `k`) | RED     | `gh/non-ascii-remote-component-refuses`                                   |

Row 17 is the **third** fix-with-no-instrument in this change (after the
`GITHUB_HOSTS` check and the ASCII guard), and the only one whose removal is
fail-OPEN rather than fail-closed: without the truncation,
`https://evil.com#@github.com/<self-path>` parses its host as `github.com`,
clears `GITHUB_HOSTS`, matches self on owner/name, and AUTHORIZES the merge —
while git, via curl, resolves `evil.com`. Before the two cases above existed,
**no fixture remote contained `#` or `?` at all**, so both truncation lines were
a no-op across the entire suite.

Row 18 was recorded as a `mutation:` on its case but had never been executed —
"a claim, not evidence" by this file's own standard, on the one row lacking
measurement.

**A live MUST-2(b) trap, recorded because it nearly produced a false verdict.**
The first attempt at row 18 used a mutation pattern naming the wrong variable.
It did not apply, the suite ran fully GREEN, and that green would have been
recorded as "the ASCII guard has no instrument" — a false finding against a
working test. Comparing the guard's occurrence count before (1) and after (0)
is what caught it; with the correct pattern the case REDs. **Verify a mutation
APPLIED before reading its result.** An unapplied mutation is not a verdict.

### Seventh pass — the downstream guards, and proof that `expectReason` is load-bearing

Three guards sit DOWNSTREAM of the fence and had no instrument: every case passed
`prId: 77` or `42` and none passed a `mergeMethod`, so deleting any of them left
the suite green. `prId` is interpolated into the request path, making it the last
caller-authored value on a path otherwise sourced entirely from the derivation.

| #   | Mutation                                  | Applied-check         | Verdict | Cases reddened                    |
| --- | ----------------------------------------- | --------------------- | ------- | --------------------------------- |
| 19  | delete GitHub's `PR_NUMBER_RE` prId guard | `PR_NUMBER_RE` 2→1    | RED     | `gh/non-numeric-pr-id-refuses`    |
| 20  | delete GitHub's `MERGE_METHOD_RE` guard   | `MERGE_METHOD_RE` 2→1 | RED     | `gh/invalid-merge-method-refuses` |
| 21  | delete ADO's `ADO_PR_ID_RE` prId guard    | `ADO_PR_ID_RE` 2→1    | RED     | `ado/non-numeric-pr-id-refuses`   |

**And three that prove `expectReason` is the only thing catching a branch shift.**
These mutations move a case to a DIFFERENT refusal branch rather than breaking the
refusal outright:

| #   | Mutation                                            | Applied-check | Verdict | Cases reddened                                           |
| --- | --------------------------------------------------- | ------------- | ------- | -------------------------------------------------------- |
| 22  | `_parseAdo` always returns null                     | 1→0           | RED     | 3 ADO cross-repo cases + `ado/non-numeric-pr-id-refuses` |
| 23  | `_parseRemoteUrl` `parts.length < 2` → `< 3`        | 1→0 / 0→1     | RED     | `ado/non-ado-remote-refuses`                             |
| 24  | `_readOriginRemote` catch returns a placeholder URL | 0→1           | RED     | `ado/no-origin-remote-refuses-typed-not-throws`          |

The load-bearing detail: on rows 22-24 every failure printed
`actual ok=false fired=false error=null`. **Every pre-existing assertion MATCHED
— the case reds ONLY on the reason.** Row 23 is the sharpest: same label,
identical `ok`/`fired`/`error`, the reason the sole difference. Before
`expectReason`, each of these cases would have stayed GREEN while refusing for a
reason its recorded mutation had nothing to do with.

That is the wrong-branch-pass hole in its measured form, on the ADO lane — the
provider where two branches share the label `completeUpflowPR: self-identity
underivable` and differ only in reason, so the label alone cannot discriminate.
FIVE ADO refusal cases carried no `expectReason`; every refusal case now does.

**The invariant asserted here is the PROPERTY, never a count.** The property is:
every refusal case carries an `expectReason`. Verify it as an EQUALITY, which
stays true at any suite size:

```
grep -c 'expectReason:' run.mjs   ==   grep -c 'expect: { ok: false' run.mjs
```

A bare count in this position has now decayed three times: an earlier draft
asserted "all 18", which was accurate when written, measured 21 by a later
reviewer, 22 one commit after that, and 24 by the time the sibling scp and
path-byte cases landed. A first attempt at this correction opened "the COUNT is
deliberately not stated here" and then stated three counts in its own next
clause — falsified by its own continuation, which is the same claim-shape
defect the eleventh-pass section below records. Hence the equality: it has no
number in it to go stale.

**Stated as an inference, not a measurement** (`instrument-discipline.md`
MUST-2(b)): rows 22-24 show the cases red WITH `expectReason` present. A paired
control — the same mutation with `expectReason` removed, confirming green — was
NOT executed. The matched `ok`/`fired`/`error` output makes the conclusion
direct, but it is read off the output shape rather than separately run.

Rows 19-24 were measured in a byte-copy sandbox (the adapters were being edited
in-flight), baseline reproduced before the first mutation and after the last.

### The U+212A case, re-measured after being made normalization-proof

Row 18's mutation was originally measured against a case whose remote carried a
RAW U+212A byte, while its own comment claimed the character was "written as an
escape so this file stays ASCII". The comment was false, and the consequence was
not cosmetic: any normalizing pass folding that byte to ASCII `K` turns the case
from an instrument into a no-op — it would derive successfully, match self, and
silently stop testing the ASCII guard. Nothing would red.

The string is now a genuine `K` escape, verified equivalent to the raw form
before being trusted (`escape === raw` true, `codePointAt` = U+212A, still folds
to `kailash-coc-rs`, not already an ASCII `K`). Re-measured, because changing the
input invalidates the prior measurement:

| #   | Mutation                                                                           | Applied-check | Verdict                    | Cases reddened                          |
| --- | ---------------------------------------------------------------------------------- | ------------- | -------------------------- | --------------------------------------- |
| 25  | `normalizeComponent` — delete the `/^[\x00-\x7f]*$/` ASCII pre-check (escape form) | guard 1 → 0   | RED (`ok:true fired:true`) | `gh/non-ascii-remote-component-refuses` |

The refuse→authorize flip confirms the case is still a live instrument.

**This character defeated three separate tools in one session, which is the whole
argument for the escape.** (1) A verification shell command typed a literal ASCII
`K` instead of the codepoint and derived `ok:true`, nearly producing a false
"this case does not test the guard" finding. (2) The Edit tool could not match
the raw character — the typed codepoint normalized to ASCII in transit. (3) The
edit that ADDED the comment explaining the escape silently re-introduced a raw
U+212A inside its own backticks, caught only by re-running the byte check rather
than assuming the earlier clean result still held.

Current state, measured by codepoint census rather than by grep (a `grep` for the
byte sequence returned empty on a file that was NOT pure ASCII, which is exactly
the non-discriminating instrument this suite exists to reject): **zero raw
U+212A**. Do not trust that sentence — re-derive it, because it has already been
falsified once:

```bash
python3 -c "import collections; \
print(collections.Counter(hex(ord(c)) for c in open('run.mjs',encoding='utf-8').read() if ord(c)>127))"
# 0x212a must be ABSENT. Everything else is prose/formatting, not test input.
```

**This claim was false for one commit, and the falsifying line was added by the
commit that left it standing.** A new case drove a U+212A authority written as a
RAW byte (`run.mjs`, the non-ASCII-authority case) while this paragraph still
asserted zero. Worse, it was the precise fragility the paragraph above warns
about: any normalizing pass folding that byte to ASCII `K` would have turned the
case into a no-op. Measured at the time, it would have redded loudly on
`expectReason` rather than passing silently — but the case is now written with a
`K` ESCAPE, which restores the claim, removes the fragility, and was
re-verified to still red when the ASCII guard is deleted. Escapes, not raw
bytes, for every non-ASCII test input in this file.

### Eighth pass — the last two guards that had no instrument

Both were fixes from EARLIER rounds that shipped untested — the fourth and fifth
instances of that pattern in this change. Neither was findable by mutating the
predicates someone had thought of; both were found by asking, of every guard
added in a prior round, "does a case red when it is removed?"

| #   | Mutation                                                               | Applied-check           | Verdict | Cases reddened                                                                           |
| --- | ---------------------------------------------------------------------- | ----------------------- | ------- | ---------------------------------------------------------------------------------------- |
| 26  | GitHub adapter — revert the path to interpolate the caller's `repoRef` | derived-path form 1 → 0 | RED     | `gh/case-insensitive-own-repo-still-allowed`, `gh/dot-git-suffix-own-repo-still-allowed` |
| 27  | `_readOriginRemote` — drop `env: gitEnv()`, inheriting the ambient env | `env: gitEnv()` 1 → 0   | RED     | `gh/ambient-git-dir-cannot-redirect-derivation`                                          |

**Row 26 is the second measured proof that a new assertion was load-bearing.**
Under that mutation the failing cases printed:

```
expected ok=true fired=true error=null
actual   ok=true fired=true error=null
WRONG ENDPOINT
```

Every pre-existing assertion MATCHED — `ok`, `fired`, and `error` all identical.
The case reds ONLY on the endpoint. So before `expectEndpoint` existed, reverting
"check and use are the same bytes" was invisible to the entire suite. Same shape
as the `expectReason` proof in the seventh pass, one layer down.

**Row 27 instruments a documented fence BYPASS.** `git-subprocess-env.js` exists
because `GIT_DIR` outranks repository discovery — neither `cwd:` nor `-C` pins
WHICH repo git resolves. The case runs in the self repo with the child's ambient
`GIT_DIR` pointed at a decoy whose origin is the upstream. With `gitEnv()`
removed the derivation resolves the DECOY, so the fence refuses a merge on the
repo it genuinely is (`ok:false fired:false`). The case is shaped to fail in the
LOUD direction — a self-targeted merge that must SUCCEED — because a refusal is
also what a merely-broken derivation produces, and that would not discriminate.

### Ninth pass — the regression guard for the ORIGINATING CRIT

An 88-mutation sweep found the most consequential gap in the whole change: **the
caller-authored identity seam could be RE-INTRODUCED with the suite fully
green.** The operand was removed three times over three rounds — `selfRepoRef`,
then `_deriveSelfFn`, then `cwd` — and nothing detected its return.

| #   | Mutation                                                                                  | Applied-check | Before                          | After                                            |
| --- | ----------------------------------------------------------------------------------------- | ------------- | ------------------------------- | ------------------------------------------------ |
| 28  | `completeUpflowPR` — restore `deriveSelfRepoRef((prRef && prRef.cwd) \|\| process.cwd())` | 1 → 0         | **GREEN 26/26 — NO INSTRUMENT** | RED — `gh/descriptor-identity-seams-are-ignored` |

Measured before the fix: the seam restored, a forged tree merged on the upstream,
and the suite reported 26/26 PASS. That is the originating incident — a
downstream completing a PR on its upstream — reintroducible with zero test
signal, in the change built to prevent it.

The new case injects ALL THREE historically-removed seams at once (`cwd`,
`selfRepoRef`, `_deriveSelfFn`) pointed at a decoy tree whose origin IS the
upstream, then targets the upstream. The fence must ignore every one and refuse,
because the real `process.cwd()` is the self repo. With the seam restored it
flips to `ok=true fired=true` — refuse→authorize — and reds.

This is the case to keep if any case is ever dropped. It does not test a
normalization or a parse; it tests that the fix itself has not been undone.

### The paired control — now MEASURED, not inferred

The seventh pass recorded an inference: mutations that red only on `reason`
looked like proof that `expectReason` was load-bearing, but the paired control
(same mutation, assertion removed, confirming green) had not been run. **It has
now been executed** — a control runner with `reasonMatches()` forced to `true`,
verified 25/25 on pristine, re-run across all 88 mutations:

- `_parseRemoteUrl`'s owner/name null guard reds **only** via `expectReason` —
  entirely invisible without it.
- Ten further mutations lose at least one case without it, including
  `gh/forged-version-cannot-authorize-its-named-repo` under three separate
  derivation mutations.

The seventh pass's caveat is therefore discharged: `expectReason` is load-bearing
by measurement, not by reading the output shape.

### Tenth pass — the sixth fix-with-no-instrument was in the fix for that class

A `..`-rejection was added to `normalizeComponent` after a review found that
`"...git"` survives the `.git` strip as `".."`, clears the fence (both sides
normalize identically), and reaches an interpolated request path — on ADO a
repo-scope escape, since the path collapses to the PROJECT-scoped PR address.

**That guard shipped with no instrument.** No fixture case used a dot-heavy
component, so deleting the guard changed nothing the suite read — the SIXTH
occurrence of this class in this change, committed while fixing a finding
_about_ this class.

| #   | Mutation                                                       | Applied-check              | Before                    | After                                |
| --- | -------------------------------------------------------------- | -------------------------- | ------------------------- | ------------------------------------ |
| 29  | `normalizeComponent` — delete the `.`/`..`/separator rejection | guard line found + removed | **GREEN — NO INSTRUMENT** | RED — `gh/dot-dot-component-refuses` |

**A live MUST-2(b) trap on the way there, recorded because it nearly ended the
check.** The first attempt at row 29 used a mutation pattern whose escaping did
not match the source. It reported `APPLIED: NO (pattern x0)` — INERT — and had
that been read as a green, it would have become "the guard has no instrument"
for the wrong reason, or worse, "the guard is fine" for no reason at all. The
occurrence-count check is what forced a second attempt. **This is the third time
in this change an unapplied mutation produced a result that looked like a
verdict.**

The same run re-confirmed the `.git` strip is still instrumented (reds 6 cases)
after the guard was inserted into that function — a regression check on the
instrument itself, not just the code.

### Eleventh pass — a fail-OPEN guard without a case

A 96-mutation sweep (0 INERT, every pattern occurrence-verified) found one
remaining guard whose removal the suite could not see.

**This section's original claim was FALSIFIED, and the falsification is left
in place rather than quietly edited away.** It read "the last fail-OPEN guard
without a case … the only fail-OPEN one left". A TWELFTH pass then found
another: `_splitRemoteUrl` tested `s.includes("://")` and cut at
`s.indexOf("://")` — unanchored — so a `://` sitting in the PATH of an
scp-style remote supplied the authority (`evil.com:x/https://github.com/o/r`
→ `github.com`, measured `indexOf` = 16). No case drove a remote whose path
contained `://`, so that predicate had NO instrument, exactly like row 30
below. It is now `gh/unanchored-scheme-authority-spoof-refuses`.

The lesson is about the CLAIM SHAPE, not the miss. "The only one left" is
unfalsifiable from the record: the 96 mutations are not listed, so no result
this document could show would contradict it — `instrument-discipline.md`
MUST-1. Passes 9, 10, and 11 each opened with a "the last one" framing and
each was followed by another pass; the standing caveat at
§ "BROAD, not EXHAUSTIVE" (~250 lines up) says exactly this and was written
before three of those passes. Scope every such sentence to the sweep that
produced it — "this sweep found one more" — never to the space of defects
that remain, which no sweep can measure.

| #   | Mutation                                            | Applied-check | Before                    | After                                            |
| --- | --------------------------------------------------- | ------------- | ------------------------- | ------------------------------------------------ |
| 30  | `_parseAdo` — delete `if (!isAdoHost) return null;` | 1 → 0         | **GREEN — NO INSTRUMENT** | RED — `ado/three-segment-non-ado-remote-refuses` |

`isAdoHost` IS the ADO adapter's host fence — unlike GitHub there is no
`GITHUB_HOSTS`-style allowlist at the adapter level. Without it, any
3-or-more-segment non-ADO remote (an internal GitLab/Gitea mirror) parses as
org/project/repo and AUTHORIZES a completion against a repo the remote does not
name. Measured on the un-instrumented build:

```
remote https://gitlab.internal.example/contoso/platform/coc-rs.git
pristine: ok=false fired=false  "not an Azure DevOps remote"
mutated : ok=true  fired=true   ep=contoso/platform/_apis/git/repositories/coc-rs/pullrequests/42
```

The pre-existing `ado/non-ado-remote-refuses` cannot cover it: that case drives a
2-segment GitHub remote, which `segs.length < 3` refuses FIRST, so the host
predicate is never the discriminator there. Three segments is what reaches it.

### The whole control set, now measured rather than inferred

The same sweep ran the paired controls this file previously recorded as
inferences, first verifying that neutering each assertion alone reds nothing
(so the control is itself a valid instrument):

- Neutering `expectReason` alone → all green. Neutering `expectEndpoint` alone → all green.
- The bare-path fallback mutation, with `expectReason` removed → **GREEN**. Its
  red is carried entirely by the reason assertion.
- All four derived-path mutations, with `expectEndpoint` removed → **all GREEN**.
  That assertion is the only thing separating a `d.self`-sourced path from a
  `repoRef`-sourced one.
- Cross-checks that must NOT go green did not: mutations reddening on
  `ok`/`fired`/`error` stayed red with the reason assertion removed.

Every "this assertion is load-bearing" claim in this file is now a measurement.

**Coverage is stated as an EQUALITY, not a count** — the remedy this file
prescribes for itself at § "enumeration decay", applied here after the previous
revision of this sentence was found false.

> Every case name in `run.mjs` appears in at least one recorded mutation result
> in this file.

Re-derive it; do not trust the sentence:

```bash
comm -23 \
  <(grep -oE '^    name: "[^"]+"' run.mjs | sed -E 's/.*"(.*)"/\1/' | sort -u) \
  <(grep -oE '\b(gh|ado)/[a-z0-9-]+' README.md | sort -u)
# empty output = the equality holds. Any line = a case with no recorded mutation.
```

**What the previous revision got wrong, recorded rather than overwritten.** It
claimed "every case in the suite is reddened by at least one recorded mutation,
so no case is currently known to be vacuous." That was false **at the commit
that wrote it** — the same commit added two cases it did not table — and three
later commits each added cases without extending the tables. Six cases were
uncovered. They carried only a bare `mutation:` field, which this file rules out
as evidence at § "an un-run `mutation:` field is a claim, not evidence" — so the
universal claim rested on exactly the thing the file says is not evidence. This
is the third instance of the enumeration-decay class documented here; the
equality above has no number in it to decay.

The six were then measured rather than assumed. **All six are sound — none
vacuous**; they were UNDOCUMENTED, not uncovered:

| Case                                                    | Predicate mutated                                                    | Cases redded                                     |
| ------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------ |
| `ado/allow-own-repo-legacy-collection-form`             | `_parseAdo` subdomain `!==2 && !==3` → `!==2`                        | **4 as of the quad** (see § Twelfth pass row 38) |
| `ado/discarded-collection-slot-rejects-dirty-segment`   | `_parseAdo` validate-before-drop `segs.some(...)` deleted            | exactly 1 — itself                               |
| `gh/scp-userinfo-fragment-spoof-refuses`                | `_splitRemoteUrl` drop the `isSchemeForm` guard on the authority cut | exactly 1 — itself                               |
| `ado/collection-form-does-not-admit-fragment-injection` | `normalizeComponent` allowlist removed                               | 3, including itself                              |
| `ado/path-terminator-byte-in-remote-refuses`            | allowlist reverted to a `?`/`#` denylist                             | 3, including itself                              |
| `gh/fragment-injected-path-segments-refuse`             | `_parseRemoteUrl` `parts.length !== 2` → `< 2` + last-two            | 4, including itself                              |

Cases that co-red siblings share a predicate with them; that is expected, not
dilution. Three isolate to exactly one case.

**Two cases added after the above, each measured the same way:**

| Case                                                       | Predicate mutated                                                                           | Cases redded       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------ |
| `ado/descriptor-identity-seams-are-ignored`                | `vcs-azure-adapter.js` restore `deriveSelfRepoRef((prRef && prRef.cwd) \|\| process.cwd())` | exactly 1 — itself |
| `ado/exact-segment-count-rejects-all-clean-extra-segments` | `_parseAdo` the PAIR: `!== 3`→`< 3` AND `!== 2`→`< 2`                                       | exactly 1 — itself |

**Four more added after an adversarial round measured that three guards shipped
with NO instrument** — deleting any of them left the suite fully green, because
every host in the corpus was pure ASCII, every `prId` was plain digits or a
plain-ASCII traversal string, and no case configured a push url:

| Case                                                        | Predicate mutated                                                                                 | Cases redded       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------ |
| `gh/non-ascii-authority-refuses-at-derivation`              | `_splitRemoteUrl` delete the `[\x00-\x7f]` authority guard                                        | exactly 1 — itself |
| `gh/control-byte-pr-id-neutralized-in-refusal`              | `displayPrId` → `String(value)` (drop the `[^0-9]` allowlist)                                     | exactly 1 — itself |
| `gh/triangular-remote-refuses-when-fetch-and-push-disagree` | `deriveSelfRepoRef` delete the `_readPushRemote` disagreement block                               | exactly 1 — itself |
| `gh/triangular-same-identity-different-transport-allows`    | `deriveSelfRepoRef` compare the raw pushUrl string instead of derived slugs                       | exactly 1 — itself |
| `gh/triangular-same-slug-different-host-refuses`            | `_sameDerivedIdentity` drop the host equality test                                                | exactly 1 — itself |
| `ado/triangular-cross-org-same-project-repo-refuses`        | `_sameDerivedIdentity` compare the owner/name slug instead of routing ADO through `isSelfRepoAdo` | exactly 1 — itself |
| `gh/triangular-push-default-remote-refuses`                 | `_readPushRemote` resolve only origin's own pushurl                                               | exactly 1 — itself |
| `ado/triangular-same-identity-different-transport-allows`   | `_sameDerivedIdentity` compare the raw host on the ADO branch too                                 | exactly 1 — itself |
| `ado/unparseable-legacy-ssh-push-url-does-not-lock-out`     | `deriveSelfRepoRef` refuse when `pushParsed` is null                                              | exactly 1 — itself |

The last is the **permissive polarity** of the triangular guard and is not
optional: that guard's obvious failure mode is locking out a legitimate
maintainer whose push url differs only in transport (ssh vs https), and a
refusal-only pair cannot detect over-tightening.

### Twelfth pass — the ADO identity became a QUAD (issue #82, cross-collection)

The ADO identity was `{org, project, repo}` and `_parseAdo` DISCARDED the
collection segment at `segs.slice(1)`. In legacy TFS/VSTS a collection is a
NAMESPACE, so these two remotes name two DIFFERENT repositories and yet derived
an identical triple:

```
https://<org>.visualstudio.com/DefaultCollection/<proj>/_git/<repo>
https://<org>.visualstudio.com/OtherCollection/<proj>/_git/<repo>
```

**No comparison key could close it** — the component was absent from the model
entirely, so the fix retains the collection through the parse and widens the
identity to `{org, collection, project, repo}`. `collection` is `null` on the
three collection-less forms (`dev.azure.com`, `ssh.dev.azure.com:v3`, the
2-segment `<org>.visualstudio.com`) and set only on the legacy 3-segment form;
an absent collection normalizes to the org's DEFAULT collection and is then
COMPARED, which leaves every modern-form case unaffected (all compare
default-to-default) while keeping a NON-default collection distinct in both
directions. An earlier revision of this line said "null matches ONLY null"; that
rule shipped a maintainer lockout and was reverted — see § "CORRECTED" below.

**All five new cases were observed RED against the unfixed source first**, and
all five failed the same way — `ok=true fired=true`, i.e. the completion was
AUTHORIZED and the transport FIRED. That is the reported defect measured, not
inferred.

| #   | Mutation                                                                                                                                                            | Applied-check | Verdict | Cases reddened                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 31  | `_parseAdo` — drop the collection CAPTURE (exactly the pre-fix behavior: quad → triple)                                                                             | 1 → 0         | RED     | `ado/allow-own-repo-legacy-collection-form`, `ado/triangular-cross-collection-same-org-project-repo-refuses`, `ado/unstated-collection-does-not-match-a-nondefault-collection-form`                                                                                    |
| 32  | `isSelfRepoAdo` — delete the collection comparison entirely                                                                                                         | 1 → 0         | RED     | `ado/triangular-cross-collection-same-org-project-repo-refuses`, `ado/cross-collection-same-org-project-repo-refuses`, `ado/unstated-collection-does-not-match-a-nondefault-collection-form`, `ado/stated-nondefault-collection-does-not-match-a-collection-free-form` |
| 33  | `isSelfRepoAdo` — an ABSENT `repoRef.collection` matches ANY derived one (caller wildcard — distinct from normalizing it to the default, which is the shipped rule) | 1 → 0         | RED     | `ado/unstated-collection-does-not-match-a-nondefault-collection-form`                                                                                                                                                                                                  |
| 34  | `isSelfRepoAdo` — an ABSENT derived collection matches ANY stated one (derived wildcard — distinct from normalizing it to the default, which is the shipped rule)   | 1 → 0         | RED     | `ado/stated-nondefault-collection-does-not-match-a-collection-free-form`                                                                                                                                                                                               |
| 35  | `vcs-azure-adapter::validateRepoRef` — delete the `ref.collection` validation branch                                                                                | 1 → 0         | RED     | `ado/invalid-collection-in-repo-ref-refuses`                                                                                                                                                                                                                           |

Rows 33 and 34 are a deliberate PAIR. A nullable comparison is asymmetric by
construction — one side can be made a wildcard without the other — so a single
case cannot show the rule holds in both directions. Each row reds exactly its
own polarity, which is what shows the two are independently instrumented.

Row 31 reddening the PERMISSIVE case (`allow-own-repo-legacy-collection-form`)
is the retention's over-tightening guard: that case's `repoRef` now STATES the
collection, so dropping the capture makes it absent-vs-present and it refuses.
A refusal-only set could not have caught that.

**A first attempt at row 35 was INERT** — the pattern named an indentation the
formatter had changed, `occurrences=0`, and the harness refused to read the
resulting run as a verdict. Recorded because this file's own § "A live MUST-2(b)
trap" says an unapplied mutation is not a verdict, and it applied here.

#### Row 36 — a green RESOLVED by its control, not left as two hypotheses

Retaining the collection put a SECOND guard on the same byte: the
present-but-unnormalizable check at the end of `_parseAdo`, alongside the
pre-existing validate-before-use check. Deleting either ALONE now leaves the
suite green, which is exactly the shape MUST-2(b) forbids reading as a verdict.
The pair was measured instead:

| #   | Mutation                                                    | Applied-check | Verdict | Reddened                                              |
| --- | ----------------------------------------------------------- | ------------- | ------- | ----------------------------------------------------- |
| 36a | delete the trailing collection guard ALONE                  | 1 → 0         | GREEN   | (none)                                                |
| 36b | delete the validate-before-use `segs.some(...)` check ALONE | 1 → 0         | GREEN   | (none)                                                |
| 36c | delete BOTH                                                 | 1 → 0, 1 → 0  | RED     | `ado/discarded-collection-slot-rejects-dirty-segment` |

36c is the control that collapses 36a and 36b: each guard is SUBSUMED by its
sibling, not vacuous — the byte is still guarded, by either one. Both are kept,
because the trailing guard is what still holds if a future refactor moves or
drops the early check, which is what happened to the collection slot itself
once already.

**This invalidated a previously-recorded mutation, and it is corrected rather
than left standing.** `ado/discarded-collection-slot-rejects-dirty-segment`
recorded the validate-before-use check ALONE, which was accurate until this
change and is now 36b — a green. Its `mutation:` field now names the PAIR.

#### Row 38 — the permissive case's OWN mutation, re-measured after its input changed

`ado/allow-own-repo-legacy-collection-form`'s `repoRef` gained a `collection`
field in this pass. Changing a case's INPUT invalidates every prior measurement
against it (the same reason the U+212A case above was re-measured after being
made normalization-proof), so its own recorded mutation was re-run rather than
assumed to still hold:

| #   | Mutation                                           | Applied-check | Verdict | Cases reddened                                                                                                                                                                                                                            |
| --- | -------------------------------------------------- | ------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 38  | `_parseAdo` — subdomain `!== 2 && !== 3` → `!== 2` | 1 → 0         | RED     | `ado/allow-own-repo-legacy-collection-form`, `ado/triangular-cross-collection-same-org-project-repo-refuses`, `ado/cross-collection-same-org-project-repo-refuses`, `ado/unstated-collection-does-not-match-a-nondefault-collection-form` |

Still a valid instrument. It now co-reds three siblings because all four drive
the 3-segment form; the § "Two cases added after the above" table's
"exactly 1 — itself" entry for this case is corrected to point here.

#### Row 37 — a PRE-EXISTING equality violation, found by re-running the check

The § "Coverage is stated as an EQUALITY" check below was run after adding this
pass's cases and reported THREE uncovered cases. Two were this pass's own (fixed
by writing the full case names into row 32, and by renaming
`ado/invalid-collection-in-repoRef-refuses` → `…-in-repo-ref-refuses`, since the
check's `[a-z0-9-]+` pattern cannot see a camelCase segment — a case name that
the equality check is structurally blind to is a case that silently leaves the
denominator).

The third was already violating at HEAD, before this pass touched anything
(verified by running the same check against `git show HEAD:` for both files), so
it is recorded here rather than attributed to this change. Measured now:

| #   | Mutation                                                                                 | Applied-check | Verdict | Cases reddened                                     |
| --- | ---------------------------------------------------------------------------------------- | ------------- | ------- | -------------------------------------------------- |
| 37  | `_splitRemoteUrl` — widen the host guard back to `/^[\x00-\x7f]*$/` (from `[\x20-\x7e]`) | 1 → 0         | RED     | `ado/control-byte-authority-refuses-at-derivation` |

The case was SOUND, not vacuous — undocumented, the same disposition the six
cases in § "What the previous revision got wrong" took. This is the fourth
instance of the enumeration-decay class this file records: the equality holds
only when someone RE-RUNS it, which is why it is written as a command and not as
a sentence.

#### The contract change this pass ships, stated plainly

An unstated `repoRef.collection` no longer matches a present derived one. A
caller on a legacy collection remote that completed with a bare
`{org, project, repo}` must now name the collection **when that collection is
not the default**. The refusal names both sides' collection (absence renders as
`<default-collection>`) so the fix is one field. Observed:

```
refusing to complete contoso/<default-collection>/platform/coc-rs!42 — this repo
derives as contoso/othercollection/platform/coc-rs. A PR may only be completed
on the repo you ARE. …
```

**CORRECTED — this section previously argued the opposite rule and that rule
shipped a lockout.** It read: "letting absent match present would make the
collection a leg that can never fail from the adapter … which is the exact
defect this README already records three times". That reasoning is sound about
WILDCARDS and wrong about DEFAULTS. Only the legacy 3-segment form carries a
collection, so under "absent matches only absent" an ordinary ADO clone
mid-URL-migration — legacy https fetch, modern ssh push, ONE repository —
compared present-vs-absent and REFUSED ITSELF, with a triangular-remote reason
whose two printed operands were identical. Absent is now normalized to
`defaultcollection` and COMPARED; normalizing is not wildcarding, so the
never-fails concern does not apply (absent resolves to one specific value and
matches nothing else), and cross-collection stays closed. The label changed with
it, which is why the quoted output above differs from the one this section
carried before. Recorded rather than silently rewritten — a README that argued
for a shipped lockout is exactly the kind of standing instruction-to-revert this
suite exists to catch.

#### What this pass does NOT fix

The ADO request path is `{org}/{project}/_apis/...` on every call in the
adapter — **it has no collection slot**. So a completion authorized on a
non-default collection is still ADDRESSED collection-free. The identity fix
makes the caller and the working tree agree on WHICH repo is meant; it does not
give the request a way to say so. Deliberately not guessed at: emitting
`{org}/{collection}/{project}/_apis/...` is a claim about ADO's legacy REST
routing this repo cannot verify, and acting on an incomplete enumeration of ADO
URL forms is what produced the collection-form lockout regression recorded
above. Same disposition, same reason, as the `_ssh` parse gap. Recorded at
`vcs-azure-adapter.js::completeUpflowPR`.

`gh/control-byte-pr-id-neutralized-in-refusal` required a new assertion form,
`expectReasonAbsent`. A sanitizer's contract is that something does NOT appear in
the output, so every positive assertion in this harness was blind to it —
`displayPrId` could be collapsed to `String(value)` and every ok/fired/
reason-contains check still passed.

Both closed measured gaps, not theoretical ones. Before the first, the ADO
adapter's caller-authored `cwd` seam could be restored with the suite fully
green while the adapter merged on the upstream. Before the second, the ADO
exact-count pair redded nothing and was VACUOUS — while the source comment
claimed the pair was the tested mutation. Each gate ALONE remains inert
(measured: `!== 3` → `< 3` alone leaves the suite green), so the pair is the
honest mutation and is now the recorded one.

**Known un-collapsed hypotheses** (`instrument-discipline.md` MUST-2(b)): the
individual `.`, `/`, and `\` legs of the path-shape rejection each leave the
suite green, and no discriminating input was constructible — a `.`-normalizing
remote refuses earlier, and `/`/`\` components are rejected by `validateRepoRef`
on one side and split away on the other. Two hypotheses remain live for each
(subsumed-by-a-later-guard vs genuinely unreachable) and are deliberately NOT
collapsed. The `..` leg IS instrumented (row 29).
(An earlier revision of this sentence said 19 while the suite held 20 — it was
accurate when written and went stale when cases were added without extending the
table. The count is now stated against the case list in `run.mjs` at the same
commit as the tables above.)

Row 15 is the one that justifies the `error === null` assertion. Deleting that
guard does NOT flip `ok` — measured:

```
expected ok=false fired=false error=null
actual   ok=false fired=false error=Cannot read properties of undefined (reading 'ado')
```

`ok` and `fired` are byte-identical to a genuine refusal. Only `error`
discriminates, so a suite asserting only `ok === false` would have read that
crash as the fence working.

### Case shapes chosen so a mutation cannot go inert

- **`gh/dot-git-suffix-own-repo-still-allowed`** — the remote deliberately carries **no** `.git` while
  the target does. Had both sides carried it, row 4 would mangle them identically
  and the case would stay green: an inert mutation, not a passing test.
- **`gh/no-origin-remote-refuses`** — the temp directory is named after the target repo
  _and_ a forged `.claude/VERSION` declares it. That is the original exploit
  reconstructed. Precisely: a last-two-path-segments dirname fallback DOES reach
  the predicate here, but resolves `owner` to the `mkdtemp` parent, so
  `isSelfRepo` rejects it anyway — the forged `VERSION` is what supplies a
  matching identity. That is why row 1 mutates the declared-slug path and not
  the dirname one (see § Third pass).
- **The two VERSION cases are a pair.** In
  `forged-version-cannot-authorize-its-named-repo` the target-mismatch refusal
  fires regardless, so that case cannot instrument the cross-check on its own;
  the sibling `version-remote-disagreement-refuses-even-own-repo` targets the
  repo the remote agrees with, leaving the disagreement refusal as the only thing
  between it and `ok:true`.

### Third pass — row 1 corrected under re-measurement

An independent review re-ran row 1 in the live tree and measured it **GREEN
(16/16)** as originally worded ("fall back to the directory basename"), while
instrumenting the mutated branch to prove it DID execute. That wording was
therefore reached-but-ineffective, not a valid instrument: a
last-two-path-segments fallback yields the `mkdtemp` parent as `owner`, which
`isSelfRepo` rejects regardless. Row 1 now records the mutation that IS an
instrument — `_declaredSlug(cwd)` as an identity SOURCE — measured RED against
`gh/no-origin-remote-refuses` by that same review. It is also the mutation
`run.mjs` records for the case, so the two files now agree.

The original RED verdict had been obtained from a differently-implemented
mutation (one that hardcoded the correct owner alongside the basename), which
is not what the row's text described. A recorded verdict must belong to the
mutation actually named, or the table misleads the future session it exists to
serve — the same over-claim class this suite's own subject is about.

### A note on inert mutations

Two mutations attempted during an earlier pass did not apply (their patterns
did not match the source) and one applied but did not red. None were recorded as
verdicts. A non-applying mutation is INERT and licenses no conclusion, and the
non-reddening one turned out to be a badly-chosen mutation — it nulled the ADO
components, which `isSelfRepoAdo`'s own null-rejection catches downstream, so the
case still refused via a different branch. The correct mutation for that
predicate is row 7. Recording either as "proven vacuous" would have been the
exact MUST-2(b) error this section exists to prevent.

## No CI runner

These fixtures have no CI runner in this repo: `.claude/test-harness/` is
never-synced here and no workflow invokes `audit-fixtures/**`. This tier is
COMMITTED-FIXTURES-MANUALLY-DRIVEN, not a live gate — stated plainly rather than
described as "blocking".
