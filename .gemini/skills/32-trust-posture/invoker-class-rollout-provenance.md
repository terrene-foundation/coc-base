# `**Invoker class:**` — The Ninth Canonical Wiring Field: Rollout Provenance

Paired depth for `rules/trust-posture.md` Rule 8 and for the six rules whose Trust-Posture
Wiring blocks adopted the ninth canonical field on 2026-09-18. **Nothing normative lives
here.** Every MUST, MUST NOT, BLOCKED entry and `**Why:**` line stays in the rule bodies;
what follows is the measurement narrative, the withdrawn-claim record, and the per-rule
detection archaeology those bodies used to carry inline.

Why it moved: the rule corpus is charged by RAW BYTES against a per-session injection budget
(`.claude/bin/check-rule-injection-budget.mjs`), and this rollout pushed six rules over it.
`abridgeV6` already strips every `## Trust Posture Wiring` section from the Codex/Gemini
consumer baseline, so this prose cost consumers ZERO and cost the CC raw-load surface
everything — which makes it the correct thing to extract rather than the cheapest.
Destination is `.gemini/skills/**` deliberately: `check-descoping.mjs::isMoveDestination`
treats it as a sanctioned MOVE, while `guides/**` reports `descoping_to_uninjected`, and
these paragraphs are dense with `MUST-N` citations that count as MUST tokens.

---

## `trust-posture.md` Rule 8 — why the field COUNT left the clause name

This section was headed "Canonical 8-Field Wiring Template" until `**Invoker class:**` landed
as the ninth field (2026-09-18). A count baked into the NAME is a figure restated outside the
turn that produced it — `instrument-discipline.md` MUST-6 — and it rotted on contact: at that
landing the corpus carried 320 occurrences of "8-field" across 207 files, none of which any
checker reads, so every one of them would have had to be re-typed to keep a number accurate
that the template block already states by construction.

A pre-existing "canonical-8-field-compliant" claim elsewhere in the corpus is NOT thereby
false; it is an accurate statement about the template as of that rule's landing SHA, and the
grandfather cutoff in the rule body is what migrates it.

## `trust-posture.md` Rule 8 — where the corpus stood on the NINTH field (2026-09-18)

Stated rather than assumed defensible. `**Invoker class:**` landed with SEVEN
`/codify`-touched rules, and all TEN of their real Wiring blocks adopted it in the same
change — `burn-down-reporting.md`, `ci-cost-discipline.md` (3 blocks),
`coc-artifact-eval-coverage.md` (2), `issue-triage-routing.md`,
`knowledge-cascade-routing.md`, `self-referential-codify.md` and `trust-posture.md`'s own
clause-scoped block — so the field had adopters from its first commit and the rule was not
exempting itself from an obligation it had just minted.

`self-referential-codify.md` was additionally brought to FULL canonical compliance, having
silently lacked `**Cumulative posture impact:**`, `**Violation scope:**` and `**Origin:**` —
which means the `grep -L 'Violation scope:'` sweep in the rule body had never once seen it.

Every OTHER rule in the corpus remains grandfathered until its own next `/codify`-touched
edit, and that residue is a DECLARED gap, not a clean sweep: a `grep -L 'Invoker class:'`
over `.claude/rules/*.md` lists it, and the count is deliberately not written here either,
because it is a figure that would rot on the next adoption (`instrument-discipline.md`
MUST-6). ALL TEN blocks declare a non-self-firing class alongside their self-firing one and
therefore do NOT discharge the role-blind question — MEASURED by parsing every
`**Invoker class:**` bullet in `.claude/rules/*.md`, not counted by hand. That is the correct
outcome, not a defect in the field: the honest value for a gate-review clause is
`agent-mid-procedure`.

## `trust-posture.md` Rule 8 — the census behind the separate-field decision

A Detection field can be complete, accurate and fully cited while its gate is un-openable at a
bound audience, and that is not a hypothetical. A five-lane census (2026-09-18) measured 308
gate-invoker mentions across `.claude/rules/*.md`, of which 296 name a command the `platform`
role does not surface, and `check-invoker-audience.mjs` had to INFER every one of them because
no field declared it. The inference is sound and it is also the wrong place for the fact to
live: the rule author knows who fires their gate, the checker is guessing.

Writing the value you wish were true is the failure the field exists to prevent.

## `trust-posture.md` — Phase-2-deferral block, `ci` backing detail

The `ci` half of that block's `**Invoker class:**` rests on
`.claude/bin/phase2-deferral-integrity.mjs`, whose `run:` step in
`.github/workflows/coc-artifact-eval.yml` fires on `pull_request` + `merge_group` + `push` +
`workflow_dispatch` + the weekly `schedule:` arm. Declaring that self-firing class ALONE would
have bought a discharge by omitting the half that needs a command, which is the failure the
field exists to prevent.

---

## `self-referential-codify.md` — the structural detector's arming record

`.claude/hooks/codify-self-referential-guard.js`, with its derivation + classification core at
`.claude/hooks/lib/codify-self-referential.js`, was ARMED 2026-09-18 at `PostToolUse` with
matcher `Edit|Write|NotebookEdit`.

**The VOLUME defect arming also fixed.** Dedupe keyed per PATH rather than per matched
allowlist ENTRY, so a sweep emitted one advisory per file where the rule asks for one verdict
per codify. Keying on the entry takes a full-tree session from 5657 advisories to 140 with the
exact entries byte-identical.

**Three prior revisions of that Detection field are withdrawn rather than overwritten.** The
first read "SHIPS" and claimed registration at `PostToolUse` on the `Edit|Write|NotebookEdit`
matcher; both halves were false when written. The second read "AUTHORED, UNWIRED, enforces
NOTHING … registered in NO hook-configuration surface", backed by a MEASURED five-surface
zero-occurrence sweep with `integration-hygiene` as a firing control in all five; that
measurement was sound when taken and was falsified by the arming. It survived six commits
because the rule prose is a THIRD coupled arming surface that no checker read — the gap
`detection-dispatch-check::rule-asserts-unwired-for-registered-hook` now closes, and which
this rule, of all of them, is the one that should have caught. A third sentence closed the
bullet with "Registration in `.claude/settings.json` is what would arm the hook in a live
session, and NO such registration exists" while the SAME bullet opened by stating the
registration DOES exist — a self-contradiction inside one paragraph, shipped by the rule that
mandates the round convened to catch exactly this.

**The five-surface measurement, with its control.** `integration-hygiene` returns 1 in all
five surfaces, so a zero is a readable true negative rather than a dead matcher:
`.claude/settings.json` 1, and ZERO in `.claude/codex-templates/hooks.json`,
`.claude/gemini-templates/settings.json`, `.codex/hooks.json` and `.gemini/settings.json`. So
the hook is armed at CC and reaches NO Codex or Gemini audience, where this rule's enforcement
is the review layer alone and the hook's silence is the absence of an instrument, never a
clean result.

**Why that matcher, as a design note.** The subject is the file that was just written, which
exists at that event; and — load-bearing for this rule specifically — the commonest
self-referential edit is an edit to `self-referential-codify.md` itself ADDING an allowlist
entry, which `PreToolUse` would classify against the PRE-edit allowlist and so miss on the
write that adds it.

**The `@settings-registration` marker.** Removed at arming — measured, `@settings-registration`
now returns ZERO occurrences in `.claude/hooks/codify-self-referential-guard.js`, against a
firing control that returns 1: the marker-bearing sibling `pre-commit-branch-scope.js`, named
by BASENAME deliberately, because a `.claude/hooks/` path written into a Detection bullet is
extracted by `detection-dispatch-check` as a claim that the file ENFORCES this rule, and a
measurement control is not that claim (citing it in path form REDs `undispatched-hook-claim`,
measured). That is the coupling
`detection-dispatch-check::authored-unwired-marker-contradicted` enforces. A further sentence
is withdrawn with it: it read that the marker "records this AT the mechanism" and was
"necessary and NOT sufficient", which described the UNWIRED state and went false the moment
the marker was deleted. Its surviving point does hold — hook source is shipped but never
loaded, while the RULE is loaded into every session touching its `paths:` globs, so a
correction has to be where the reader is, which is why a stale claim in the rule outlives one
in a header.

**The derivation is live, not restated.** The module imports `parseSelfRefAllowlist` +
`parsePathsFrontmatter` from `.claude/bin/validate-emit.mjs` — the same parser the
`allowlist-paths-coverage` check (#443) runs at `/sync` — and applies them to the rule's text
at call time, so an entry added there fires the detector with no code change and an entry
removed stops firing it. A hardcoded copy would be the same drift the SUPERSET paragraph in
Rule 2 records one layer down.

**Fixture note.** `.claude/audit-fixtures/codify-self-referential/run.mjs` carries 20 cases,
including the `trust-posture.md`-fires / `zero-tolerance.md`-silent pair that pins the
superset/subset distinction, and two derivation-liveness cases that MUTATE the rule's
allowlist and require the hook's verdict to move with it. CI runs them through
`.claude/test-harness/ci-audit-fixtures.json::runners["codify-self-referential"]` — that
runner IS registered and DOES execute, which is exactly why its green must not be misread: it
exercises the pure predicates against synthetic payloads and says nothing about whether the
hook is wired, so a passing fixture suite is compatible with the hook never running in any
session.

**The review layer's withdrawn clauses.** Its heading read "currently the ONLY layer" and one
sentence read "were it registered; it never answers it, and as things stand it does not ask it
either". Both were true while the detector sat registered nowhere and were falsified by the
2026-09-18 arming; MEASURED now, `.claude/hooks/codify-self-referential-guard.js` returns 1
occurrence in `.claude/settings.json` against a control (`integration-hygiene`) that returns 1
there too.

**Why the probe registration sits under the canonical field name** rather than inside the
rule's variant-labelled `Detection (review layer …)` / `Detection (structural …)` bullets: the
declaration-anchor round-trip addresses a Detection bullet by exact field name and cannot reach
a variant label — measured, it red-ed on exactly that. Those two bullets carried different
variant labels before the structural detector landed; the labels changed, the reason the
canonical-name bullet exists did not.

---

## `coc-artifact-eval-coverage.md` — the coverage detector's arming record

`.claude/hooks/artifact-coverage-guard.js`, over `.claude/hooks/lib/artifact-coverage.js`, was
ARMED 2026-09-18 and IS registered in `.claude/settings.json` at `PostToolUse` with matcher
`Edit|Write`, so it fires at loom and its silence on a covered edit is a reading rather than
an absence.

RE-MEASURED across all five hook-configuration surfaces that exist in this tree, each grep
fired first at the known-registered control `integration-hygiene` (1 in ALL five, so a zero is
a readable true negative rather than a dead matcher): `.claude/settings.json` 1, and ZERO in
`.claude/codex-templates/hooks.json`, `.claude/gemini-templates/settings.json`,
`.codex/hooks.json` and `.gemini/settings.json` — so it is ARMED AT CC ONLY and reaches NO
Codex or Gemini audience, where its silence is the ABSENCE OF AN INSTRUMENT and enforcement
stays the gate-review layer.

**Why the matcher is `Edit|Write` and deliberately NOT the adjacent
`Edit|Write|NotebookEdit` group:** a dead `MultiEdit` arm was REMOVED from the predicate at
arming because no matcher group in this repo delivers that tool, and a predicate wider than
its matcher answers a question nobody asked (`instrument-discipline.md` MUST-4).

**The prior revision is withdrawn rather than overwritten.** It read "AUTHORED BUT UNWIRED,
enforcing NOTHING … registered in NO hook surface (RE-MEASURED 2026-09-15: zero in
`.claude/settings.json` …)" — that measurement was true on 2026-09-15 and was falsified by the
arming. It is withdrawn here rather than left standing, since its own point was that silence
must not be mistaken for coverage, and a stale unwired claim makes exactly that mistake in
reverse.

ARMED IS NOT PROVEN EFFECTIVE: registration is measured, no live firing has been observed.
Enforcement of record remains the Phase-1 GATE-REVIEW sweep plus the CI scanners named in the
rule; this hook narrows the gap rather than closing it. Severity `advisory` when armed — a
TIMING cap (MUST-1 binds the `/codify`, not the keystroke), NOT the MUST-2 lexical cap.

**MUST-6's `ci` backing.** `.claude/bin/registration-preflight.mjs` carries a real `run:` step
in `.github/workflows/coc-artifact-eval.yml`, read in context rather than tallied, so MUST-6's
declaration-closure half fires on push with no command typed. The residual half — gate-review
confirming the pre-push run and that no harness green was read as CI-equivalent — is
`agent-mid-procedure`, so that block does not discharge.

---

## `burn-down-reporting.md` / `issue-triage-routing.md` / `knowledge-cascade-routing.md` — shared invoker archaeology

All three declare `runtime` AND `agent-mid-procedure` — BOTH — so none discharges the
role-blind question. The pattern is the same in each case and is recorded once here rather
than three times in the bodies:

- The `runtime` half is a registered CC hook that decides a STRUCTURAL sub-question only (a
  path membership, a command shape, a ledger row's presence).
- The whole obligation bottoms out in a named agent at a named step inside a command whose
  `surface_roles:` in `.claude/sync-manifest.yaml` is `[build, use-consumer]` — so at the
  `platform` role that command is not surfaced and the rule is
  REACHABLE-BUT-UNINVOKABLE there. That role-blind finding correctly STANDS and MUST NOT be
  written away by declaring a self-firing class the block does not have.
- Every one of these hooks is registered in `.claude/settings.json` ONLY. The four
  Codex/Gemini surfaces (`.claude/codex-templates/hooks.json`,
  `.claude/gemini-templates/settings.json`, `.codex/hooks.json`, `.gemini/settings.json`)
  carry ZERO occurrences, measured against the `integration-hygiene` control that returns 1 in
  all five. At those audiences the hook's silence is the absence of an instrument, never a
  clean result, and enforcement is gate-review at the consumer's end.

**`issue-triage-routing.md` — the reach bound, stated because it is easy to over-read.**
`.claude/hooks/triage-routing-guard.js` reaches ONE of the four repo classes. The
`coc-use-template` (Step-7b proposal), `coc-build` (cross-SDK-first) and `coc-source`
(never-originate) dispositions are procedure-shaped — sequencing and authorship properties
carried by no token in any command — so the detector is structurally silent on them,
INCLUDING at loom itself, and that silence is the absence of an instrument rather than an
all-clear (`instrument-discipline.md` MUST-3(a)). Those three stay with the gate-review layer,
and the off-lane verdict is likewise WITHHELD where no upstream is declared — a smaller true
answer, never a false clean.

**`issue-triage-routing.md` — two withdrawn revisions.** The Detection field first read
"SHIPPED" while the guard was registered nowhere; that was corrected to "AUTHORED but UNWIRED
… registered in NO hook-configuration surface", backed by a MEASURED zero-occurrence sweep
across three surfaces with a firing control. That second reading was true when written and was
falsified by the 2026-09-18 arming, and it survived because the rule prose is a THIRD coupled
arming surface that no checker read — now closed by
`detection-dispatch-check::rule-asserts-unwired-for-registered-hook`.
