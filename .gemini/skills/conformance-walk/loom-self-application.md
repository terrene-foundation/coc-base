# Applying The Conformance Walk To loom's OWN Enforcement Surface

Depth for `rules/conformance-walk.md` § Origin (2026-09-19, `journal/0618` MOVE 1). The rule
carries the contract; this file carries the measurements, the probe method and the enqueued work,
so the rule's own injected body stays close to its clauses.

## The finding — the rule was path-scoped away from the surface it governs

`rules/conformance-walk.md` is `priority: 10`, `scope: path-scoped`. Its frontmatter `paths:`
carried six globs — `**/tools/conformance/**`, `**/e2e/**`, `**/eval-harness/**`,
`**/04-validate/**`, `**/*conformance*`, `**/suites/**` — all of which reach a BUILD/USE
consumer's conformance and e2e trees and NONE of which matches loom's own gates: `scripts/ci/**`,
`.github/workflows/**`, `.claude/bin/check-*.mjs`, `.claude/hooks/**`, `.claude/test-harness/**`.

So the rule mandating freeze-then-judge was structurally absent at the moment loom authored a
gate. This is the same reachability class `issue-triage-routing.md` and `agents.md`'s worktree
clause were each written to close: a correct instruction that never loads at the point of
decision. Measured with the repo's own `globToRegExp` over the tracked set AT `dev`/`0bb0d2bd5` (10,764
files; the same census at this branch's HEAD reads 10,768/139, which is the branch's own added
files and not drift — re-derive with `git ls-tree -r`, NOT `git ls-files --with-tree`, which
unions the index and misleads), the six original globs reached 138 files, of which 106 sat under
`**/04-validate/**` — all of them inside `workspaces/**`, and all of them 100 `.md` plus 6
`.gitkeep`: workspace sweep reports and directory placeholders, which this rule's predicates
structurally cannot read, since family (1) needs a recognized case-opening line and family (2)
needs a denominator assignment. So 77% of the original in-scope set was a surface the detector
could not act on.

**Three of the six original globs match ZERO tracked files at loom** — `**/tools/conformance/**`,
`**/e2e/**`, `**/eval-harness/**` — measured against a firing control returning 4 for
`**/suites/**`. They were KEPT, not pruned: that silence is the ABSENCE OF THE SURFACE HERE, not
an all-clear. They reach a consumer's trees, and they are the paths this rule's own audit fixtures
declare in their `@fixture-path:` markers.

## Why root-anchored, and why a leading `/` is refused

The six additions are declared root-anchored (`scripts/ci/**`, not `**/scripts/ci/**`) on corpus
precedent: `ci-job-budget.md` and `verification-gate-integrity.md` already declare `scripts/ci/**`
that way, and both forms are in live use across the corpus.

A leading `/` (`/scripts/ci/**`) is REFUSED. It would anchor `floor-only-assertion.js::globToRegExp`
— which otherwise prefixes `**/` and so floats every root-anchored glob — but it compiles to
`^/scripts/ci/.*$` in `check-rule-injection-budget.mjs::globToRegex`, which no repo-relative path
can match, and it appears in 0 of the corpus's declared globs. The failure mode is silent total
de-scoping, and there is no precedent to calibrate against.

## The premise was MEASURED against Claude Code's own loader

Three glob engines are in play and only one of them is CC. A Tier-1 redteam correctly refused to
accept the widening on the strength of the two in-repo matchers, because the change's whole value
rests on CC's path-scoped loader matching a ROOT-ANCHORED glob — and the prior in-corpus
measurement ((loom-internal reference))
answered only the LEADING-`**/` question. Its four test rules all carry a `**/` prefix, so it was
never evidence about this form.

**Method** — the `journal/0051` / S20 protocol: a `claude -p` subprocess rooted at a scaffold repo,
asked to enumerate injected marker tokens BY INTROSPECTION after reading one trigger file. The
scaffold was `git init`'d and clean (trigger files were scaffold-local stand-ins named after their real counterparts, not repo reads), and the ancestor-`.claude` survey was run and recorded: one
ancestor directory existed at `/private/tmp/.claude` and carries NO `rules/`, so no rule
contamination was possible.

**Result — all six root-anchored globs INJECT on their own trigger path.**

| glob | trigger read | verdict |
| --- | --- | --- |
| `scripts/ci/**` | `scripts/ci/dev-preflight.mjs` | PRESENT (2/2 runs) |
| `.claude/bin/check-*.mjs` | `.claude/bin/check-descoping.mjs` | PRESENT |
| `.claude/hooks/**` | `.claude/hooks/lib/floor-only-assertion.js` | PRESENT |
| `.claude/test-harness/**` | `.claude/test-harness/ci-suites.json` | PRESENT |
| `.claude/audit-fixtures/**` | a scaffold fixture-dir `run.mjs` | PRESENT |
| `.github/workflows/**` | `.github/workflows/coc-artifact-eval.yml` | PRESENT |

**The poles, and exactly what they cover — stated as an inference where it is one.** A
`no-such-dir/**` rule stayed ABSENT in every run and a `**/*.mjs` rule was PRESENT, which
establishes that the probe CAN return either verdict. The decisive control is sharper and is
scoped to ONE glob: `scripts/ci/**` was PRESENT in the two runs that read its trigger file and
ABSENT in the run that did not, so for that glob the probe discriminates "this glob matches" from
"this rule always fires" — the failure mode a positive-only probe cannot see. The other five rows
are controlled positives without their own withholding pole. So "all six inject" is one
CONTROLLED instance plus five uncontrolled positives, generalized across the one FORM under test
(a root-anchored `dir/**` or `dir/name-*.ext`); that generalization is reasonable and it is an
INFERENCE, not a measurement of each row. Adding a per-glob withholding pole is cheap and is the
obvious strengthening if this is ever re-run.

**Scope of the answer, stated.** CC only. Codex and Gemini have no path-glob loader; they receive
the emitted `rules-reference` index (`.agents/skills/rules-reference/SKILL.md` and its Gemini twin),
which `emit-cli-artifacts.mjs::emitRulesReferenceSkill` generates and which therefore goes STALE on
any `paths:` edit — `check-cli-emit-drift.mjs` catches it, and it did (rc=1, 2 drifted) on this
change before regeneration.

## The injection-budget gate is BLIND to this glob set

`check-rule-injection-budget.mjs` charges a path-scoped rule to eight canonical session PROFILES.
None of the eight lies under `scripts/`, `.github/`, `.claude/hooks/`, `.claude/test-harness/`,
`.claude/audit-fixtures/`, or matches `.claude/bin/check-*.mjs`. Measured with the tool's own
exported `matchingGlobs`: this rule fires in **0 of 8 profiles before AND after** the widening, so
the gate's byte-identical output across the change is the absence of an instrument, never a green
(`instrument-discipline.md` MUST-3(a)).

The rule is charged WHOLE — `Buffer.byteLength` over the full read, frontmatter included, with no
strip anywhere in that file — to every session touching one of the six paths. A `.claude/hooks/**`
session already carries one of the heaviest path-scoped loads in the corpus, and this change adds
the whole rule to it. Measure additions with `matchingGlobs` on the paths you are adding; do not
read the gate's silence as headroom.

**NOT BOOKED, and that is a gap rather than a plan: a session PROFILE for loom's gate surface.**
Calling this "enqueued" would name a queue that does not exist — there is no issue number, no
`phase2-deferrals.json` row, no named human acceptor and no calendar backstop, and a residual
declared in prose alone is the permanent-by-default shape `completion-criterion.md` MUST-6 and
`trust-posture.md` § "Every Phase-2 Deferral Carries A DATED Declaration" exist to prevent. The
reason below justifies DEFERRING the work; it does not justify not BOOKING it, and booking it needs
`.claude/test-harness/phase2-deferrals.json` plus an acceptor, both outside the lane that found it.
Owed to the orchestrator at merge. Adding
`"loom-hook-edit": [".claude/hooks/lib/floor-only-assertion.js"]` to `PROFILES` would flow through
every tier the tool already built — per-rule ledger, accepted level, ceiling backstop, contribution
ranking. It is deferred on ONE structural reason: `.claude/bin/` sat outside the codify lease
this work ran under, and a lease cannot be widened after the fact. **A second reason was claimed
and is WITHDRAWN as refuted**: that a new profile lands with no accepted level and so reports
`PROFILE_OVER_LEVEL_UNDECLARED`, making it a ceiling ratification rather than a one-line edit.
`levelBreaches` skips a profile whose level is not finite (`// PROFILE_MISSING owns this case`), so
the verdict is `PROFILE_MISSING` and the tool's named remedy is a snapshot refresh via `--update` —
not a ratification. Measured bipolar through the tool's own exported `compare()`: absent from the
snapshot yields exactly `PROFILE_MISSING` with `levelBreaches` and `undeclared` both empty, while a
control placing the same profile at a low level yields `PROFILE_OVER_CEILING`. Overstating the cost
of a deferred fix is how it stays deferred, so the mis-sizing is withdrawn rather than softened. The gap is the one the
tool's own ALWAYS_ON commentary already names one tier up — "Reported, never gated… the axis that
grew 212% in fourteen weeks was the unmeasured one."

## A dangling citation the xref gate could not see

`rules/conformance-walk.md`'s Detection row cited the fixture runner as `floor-run.mjs` from the
rule's landing until 2026-09-19. That basename has NEVER existed in this repo: measured 0 hits over
tracked files, against a firing control returning 1 for `coverage-run.mjs`, which does exist. The
real runner is `.claude/audit-fixtures/conformance-walk/run.mjs`, and the runner's OWN docblock
carried the same wrong name, so the error was self-consistent across both sites — which is why
reading either one confirmed the other.

**`validate-xref-integrity.mjs` was green throughout, and its silence was a coverage gap rather
than a clean result.** The citation was a SLASH-LESS backtick token, which that gate skips: it
resolves paths, and a bare basename has no path to resolve. So the one instrument that exists for
dangling references is structurally unable to see a dangling reference written as a bare basename —
which is the form the corpus uses constantly. Both sites now name a path that resolves, and the
gate has something it can check.

Recorded HERE rather than in the rule for a mechanical reason worth stating, because it shapes
where such corrections belong. `check-descoping.mjs` works on the DIFF's removed lines, not on the
head inventory: rewriting the line that carried the citation registers as the citation LEAVING the
rule, even though the rule still names it. **The predicate an earlier revision of this paragraph
asserted was WRONG, and the correction is the useful part.** It claimed the gate credits a citation
that reappears as an added line in ANY other file. It does not: `check-descoping.mjs` uses
`addedElsewhereFor(addedCitationsByFile, r.path, isPairedDepthOf(r.path))`, and `isPairedDepthOf`
matches the destination's BASENAME against the rule STEM. Measured with a discriminating control —
a stem-matched `guides/rule-extracts/<stem>.md`
would be CREDITED (that file does not exist for this rule, and cc-architect advised against
creating a third depth home for one rule), while `skills/conformance-walk/SKILL.md` and this file
are NOT, and swapping in `isMoveDestination` credits them, so the predicate choice is what
decides it. Moving the token here therefore cleared nothing, and the gate said so.

The disposition actually taken is a declared entry in
`.claude/test-harness/descoping-exceptions.json`, class `citation_file`, disposition `superseded`.
Two things about it are worth recording because both cost a cycle to learn. Its `removed` field
must be the citation TOKEN, not the verbatim removed LINE the schema text describes — the
full-line form leaves the gate RED, and the token form clears it. And the registry's README states
that "empty is the correct steady state", which is stale: it holds 201 entries, so an entry here is
routine rather than exceptional. The waiver is narrow and was shown so: repointing it at a
different token, or at a different class, REDs the gate again.

## One edit, two effects — the frontmatter is also a hook's scope authority

`.claude/hooks/lib/floor-only-assertion.js::readScopeAuthority` READS this rule's frontmatter
`paths:` as one of its two declared scope authorities, so widening the rule also widens that
guard's inspection set. The hazards that creates — the hand-kept `FALLBACK_RULE_GLOBS` mirror, the
floating-versus-anchored matcher divergence, the fixture-tree withdrawal and its declared blind
class — are documented at the constants in that module, and pinned by fixture cases U5–U8 in
`.claude/audit-fixtures/conformance-walk/run.mjs`.
