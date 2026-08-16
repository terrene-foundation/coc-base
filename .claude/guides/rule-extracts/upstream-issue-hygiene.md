# `upstream-issue-hygiene.md` — depth extract

Depth for `.claude/rules/upstream-issue-hygiene.md`. The rule carries the CONTRACT — the four MUST
clauses, their DO/DO-NOT blocks, the BLOCKED-rationalization corpora, the MUST NOT bullets with
their `**Why:**` lines, and the clause-scoped 8-field Trust-Posture Wiring block. This file carries
the DEPTH that was inlined in the rule body until 2026-08-16, relocated under `rule-authoring.md`
Rule 10 path (a) so the path-scoped injection surface stays inside the loom#678 budget.

Nothing here is new, and nothing here was weakened in the move. If a line in this file disagrees
with the rule, **the rule wins**.

Why the move was needed: the rule's `paths:` globs include `**/journal/**` and `**/workspaces/**`,
so its whole body injects in every workspace-note session. At 277 lines / ~33.7 KB it pushed the
`workspace-note` profile past its `check-rule-injection-budget.mjs` ceiling on its own. This
surface is not enumerated by that guard (it reads `.claude/rules/*.md` only), which is precisely
what makes it the correct home for depth.

---

## § Scope — the downstream-upflow inbox-PR surface (full text)

It ALSO governs the **downstream-upflow inbox-PR surface**: a `coc-project` consumer's Step-7c
offer is a `gh pr create` adding `<template>/.claude/.proposals/inbox/<date>-<slug>.yaml` — a
filing subject to MUST-1's human gate AND MUST-2's redaction exactly as an SDK-repo issue is. The
inbox YAML body (its `codify_session` + per-change `reason:` free-text — the human-scrub-only
residual, NOT reached by the mechanical scanner) AND every referenced artifact file MUST be
scrubbed before the PR is opened (this is fence i of the scenario-8 QUADRUPLE disclosure fence; the
template's inbox-ingest scrub and loom Gate-1 are fences ii–iii). Step-7c provenance is hop-level
only (`origin: downstream`, no `source_repo` / consumer name), so the schema itself carries no
consumer identity — but the free-text fields are the surface this rule fences.

---

## MUST-1 — worked human-gate example (full bash)

```bash
# DO — draft, present, wait for approval, then submit
draft="$(cat <<'EOF'
... # see Rule 3 for the required shape
EOF
)"
echo "Proposed issue body:"; echo "$draft"
echo "Approve filing against terrene-foundation/kailash-py? (y/N)"
read -r approval
[ "$approval" = "y" ] && gh issue create --repo terrene-foundation/kailash-py --title "..." --body "$draft"

# DO NOT — auto-submit because the rule said "file an issue"
gh issue create --repo terrene-foundation/kailash-py --title "feat: ..." --body "$draft"
# (no human gate; submitted before the user could redact downstream context)
```

**BLOCKED rationalizations** (relocated from the rule 2026-08-16; they bind exactly as they did inline):

- "The cross-SDK parity rule said to file the issue"
- "The user already approved cross-SDK filing as a class"
- "Filing is a tool call, not a destructive action"
- "We can edit the body after if there's a problem"
- "The body is generic, no privacy concern"
- "Approval-per-issue is bureaucracy when the pattern is the same"

**Why, in full:** Issues filed against public SDK repos are world-readable forever. Auto-filing
without a per-issue gate ships downstream-context leaks (project names, internal file paths,
workspace IDs) to a surface the user cannot scrub after the fact. The human gate is the only
mechanism that catches a draft body's leakage BEFORE it becomes part of the public record. "We can
edit later" is wrong: GitHub preserves issue body history; redaction is partial.

---

## MUST-2 — worked issue-body examples (clean vs leaking)

````markdown
# DO — body is scoped to the SDK API surface, no consumer context

## Summary

`DataFlow.execute_raw(sql, params)` raises `invalid byte sequence for encoding "UTF8"`
on a NEXT query after a NULL bind on a TEXT-typed column. The bytes do not appear
in any caller-side parameter; corruption originates at the FFI boundary.

## Reproduction

```python
import kailash
df = kailash.DataFlow("postgresql://...")
df.execute_raw("INSERT INTO t (col) VALUES ($1)", [None])
df.execute_raw("INSERT INTO t (col) VALUES ($1)", ["ascii-only"])  # raises UTF-8 error
```

# DO NOT — body carries consumer-project name + internal paths + finding IDs

## Summary

[same technical content]

## Origin

F-G1-HIGH S-H3 finding (<consumer-app> repo, 2026-04-27): non-atomic store_tokens in
live_oauth.py:192-237 and pseudo-atomic in oauth.py:470-536.

## Workspace

workspaces/<consumer-app>/journal/0020-DISCOVERY-dataflow-execute-raw-utf8-corruption.md
````

**BLOCKED rationalizations** (relocated from the rule 2026-08-16; they bind exactly as they did inline):

- "Maintainers need the discovery context to triage"
- "The workspace path is internal to me, no leak"
- "The downstream name is just a tag, anyone could guess it"
- "Closed issues aren't really public"
- "The Origin footer is provenance, not context"
- "I'll keep the workspace path because it links back to the journal"
- "The finding tag is the most concise way to communicate severity"

**Why, in full:** A public SDK issue is indexed by GitHub, search engines, code-search tools, and
every downstream consumer's `gh issue list`. Every leaked downstream identifier becomes a permanent
breadcrumb to a consumer project, its file structure, and its development methodology. Maintainers
DO NOT need provenance to triage — they need a minimal repro and acceptance criteria (Rule 3).
Provenance belongs in the consumer's local journal, not the upstream issue.

---

## MUST-3 — worked five-section example vs the kitchen sink

````markdown
# DO — five required sections, nothing else

## Affected API

`kailash.DataFlow.execute_raw(sql: str, params: list)`

## Minimal repro

```python
import kailash
df = kailash.DataFlow("postgresql://localhost/test")
df.execute_raw("CREATE TABLE t (col TEXT)")
df.execute_raw("INSERT INTO t VALUES ($1)", [None])
df.execute_raw("INSERT INTO t VALUES ($1)", ["ascii-only"])
# Raises: psycopg.errors.CharacterNotInRepertoire: invalid byte sequence
```

## Expected vs actual

Expected: ASCII-only string parameter binds correctly.
Actual: UTF-8 decoding error on a parameter that contains zero non-ASCII bytes.

## Severity

HIGH — corrupts data path; non-deterministic; reproduces in CI.

## Acceptance criteria

- [ ] `execute_raw(sql, [None])` followed by `execute_raw(sql, [ascii_str])` succeeds.
- [ ] Tier 2 regression test added at `tests/integration/dataflow/test_execute_raw_null_bind.py`.

# DO NOT — the historical kitchen-sink shape

## Summary

[5 paragraphs of context including consumer name]

## Workspace

workspaces/<consumer-app>/journal/...

## Workaround

The consumer worked around it by ... [3 paragraphs of consumer-internal architecture]

## Cross-SDK alignment

This is the Python equivalent of <sibling-SDK>#NNN ...

## References

- <consumer-app> shard: S36d
- Tier 2 test suite: tests/integration/test*websocket*\_.py [in the consumer repo]
````

**BLOCKED rationalizations** (relocated from the rule 2026-08-16; they bind exactly as they did inline):

- "The 'Workaround' section helps users hitting the same bug"
- "Cross-SDK alignment links speed up triage"
- "The consumer's Tier 2 tests are the verification — they must be referenced"
- "Five sections is too rigid for a complex issue"
- "The minimal repro doesn't show the production stack trace"

**Why, in full:** Every section beyond the five required is a leakage surface. Workarounds belong in
the consumer's local docs (the consumer is the one who wrote them, the only one who can keep them
current). Cross-SDK alignment is a maintainer concern that the maintainer files separately on the
sibling repo with their own scoped repro. Production stack traces beyond the minimal repro often
contain consumer-side function names; the minimal repro is the structural defense.

---

## MUST-4 — what the structural fence does and does not cover (full text)

**Stated precisely, because successive cuts over-claimed it.** `completeUpflowPR` (both VCS
adapters) derives the self-identity from `process.cwd()` via `hooks/lib/upflow-self-repo.js` — the
live git remote is the SOLE authoritative source, `.claude/VERSION::repo` is a refuse-only
cross-check that can never SUPPLY the identity, and no identity, `cwd`, or deriver value is taken
off the caller's DESCRIPTOR (removing those seams eliminated a trivially-forgeable operand;
`deriveSelfRepoRef` does take a `cwd` argument, which both adapters hardcode to `process.cwd()`) —
and refuses BEFORE the transport fires when the remote is underivable, when `VERSION` contradicts
it, when the remote's HOST is not a recognized host for the provider being driven, or when the
derived identity ≠ the target.

**What that buys, stated at its true strength:** it refuses any completion whose target does not
match the identity derived from the working tree the process runs in, which CLOSES the accident
class — an agent following stale prose that calls `completeUpflowPR` against its upstream is
refused before the transport fires, and that accident IS the originating incident — and RAISES THE
COST of a deliberate act. It is NOT a boundary against a caller that can choose its own working
directory: `process.cwd()` is selected by whoever launches the process (or calls `process.chdir`),
so a scratch tree whose `origin` is the upstream derives the upstream identity and clears the fence
with no API misuse. It cannot be that boundary — a caller able to run arbitrary code in-process can
replace the module outright.

**It does NOT cover:** `gh pr merge` typed at the CLI, a merge run from a clone of the upstream
itself, `curl` against the merge endpoint, `--auto`/merge-queue completion, a direct `git push` to
an upstream branch, **the DESTINATION host of the request** (the fence verifies the host the
identity was derived FROM — the working tree's origin remote — and never where the injected
transport actually sends the call; an ambient `GH_HOST` / `gh config` / ADO-instance redirect
delivers the derived-and-verified `owner/name` path to a DIFFERENT host that merely shares that
path, which is the mirror-image of the source-host confusion the host check closes. The adapter
cannot assert this: the transport is injected and opaque to it, so the fix belongs on the
transport's own env construction, not here), or the OTHER cross-repo write primitives in the same
adapters (`pushImage`/`applyDeployTarget`/`invalidateCache` — present on BOTH lanes; the shared
dispatch helper underneath them is `_dispatchWorkflow` on GitHub and `_runPipeline` on ADO, which
are DIFFERENT symbols, so do not grep for one on the other's adapter) — a `workflow_dispatch` on an
upstream's default branch is a strictly WIDER capability than the merge this fences.

Those residuals are named here and in the rule's Detection field rather than implied away; MUST-4
binds the AGENT on every path, and the adapter fence is one structural backstop among them, not the
whole enforcement.

---

## Wiring § Detection mechanism — the structural tier, in full

**Structural (library-boundary refusal, NOT a hook):** the `completeUpflowPR` fence in BOTH VCS
adapters (`.claude/hooks/lib/vcs-github-adapter.js` + `vcs-azure-adapter.js`), which DERIVES the
self-identity from `process.cwd()` via `hooks/lib/upflow-self-repo.js` (live git remote the SOLE
authoritative source, no dirname fallback; `.claude/VERSION::repo` refuse-only, so a forged
`VERSION` is powerless; one shared `normalizeComponent`), and refuses before the transport fires on
an underivable remote, a contradicting `VERSION`, a remote whose HOST is not recognized for the
provider being driven (GitHub: not in `GITHUB_HOSTS`; ADO: not ADO-shaped, so `self.ado` is null),
or a non-self identity — and both adapters build the request path from the DERIVED identity rather
than the caller's `repoRef`, so the value compared and the value used are the same bytes. The ADO
adapter derives `org` by parsing the ADO remote — REFUSING when the remote is not ADO-shaped — so
org/project/repo are each compared against a derived value, never against themselves. Both
providers landed in the SAME change per `security.md` § Enforcement-Surface Parity.

What this fence covers and what it provably does not is stated ONCE, in § MUST-4 above
(`specs-authority.md` Rule 9: the restated copies are precisely what drifted into over-claim).

Audit fixtures: `.claude/audit-fixtures/upflow-open-never-complete/run.mjs` — per-provider cases
driving REAL temporary git repositories through a subprocess with no injected identity, covering
refusal against a cross-repo target, fail-closed on an underivable identity, the permitted own-repo
case, and case / `.git`-suffix normalization. Per `instrument-discipline.md` MUST-2(b) each case
MUST name the mutation that reds it; **the case count and the per-case mutation results are
deliberately NOT restated in prose — read them from `run.mjs`** (an earlier cut restated a count and
the copies drifted). **The fixtures ARE CI-run as of 2026-08-16**, superseding this section's former
"no CI runner in this repo / manually-driven, not a live gate" claim: `upflow-open-never-complete`,
`upflow-refusal-operand-sanitization` and `upflow-self-repo-helpers` are declared in
`.claude/test-harness/ci-audit-fixtures.json` with `"mode": "run"` and an anti-vacuity `min_cases`
floor taken from an actual run, and `.claude/bin/run-audit-fixtures.mjs` executes every declared
runner as a `run:` step in `.github/workflows/coc-artifact-eval.yml`. Two bounds, so this is not
re-inflated into an over-claim: whether a red run PREVENTS a merge is a claim about MUTABLE branch
protection and must be re-measured, not cited; and the runners were adapted to the aggregate's
`ok` / `not ok` case-line grammar, without which the parser observes zero cases and the `min_cases`
floor is declared against nothing.

### Adapters: MODULE NAME, never `.claude/hooks/lib/` PATH

The Wiring § Detection mechanism field names `vcs-github-adapter`, `vcs-azure-adapter` and
`upflow-self-repo` as modules and deliberately withholds their `.claude/hooks/lib/` paths. This is
not stylistic and MUST NOT be "tidied up" by a later editor.

These three files are LIBRARIES that merely live under `hooks/lib/`. No registered hook event loads
any of them — they are imported by the upflow lane, not dispatched by the harness. A rule that
cites them in `.claude/hooks/lib/<name>.js` PATH form is parsed as asserting a dispatchable HOOK,
so `registration-preflight.mjs` extracts a hook claim it cannot match to any registered dispatch
and reds `undispatched-hook-claim`. The rule would then be failing a gate for describing its own
enforcement accurately.

Module-name form states exactly the same fact and is what the field carries. The full paths are
safe HERE because this extract is a guide, not a rule, and the claim extractor reads
`.claude/rules/**` only. If a future edit "restores" the paths to the rule, expect
`registration-preflight` to red — restore the module-name form rather than registering a hook that
does not exist.

### The uncovered residuals, enumerated

`gh pr merge` typed at the CLI — only PARTIALLY covered, and the partial is thinner than "flags a
non-origin target". `violation-patterns.js::detectRepoScopeDriftBash` fires `halt-and-report` only
on a `--repo` target that survives FOUR exits:

1. an `origin`-remote match;
2. an `upstream`-remote match — a consumer that FORKED its template has `upstream` set to that
   template, so `gh pr merge --repo <template>` from the standard fork layout is never flagged at
   all;
3. `hasCrossRepoAuthorizationReceipt`, which is tiered read/write but NOT scoped by ACTION — a WRITE
   receipt legitimately obtained to OPEN the PR then clears `gh pr merge` on the same slug,
   re-creating at the hook layer the exact submission-vs-completion conflation this MUST and its
   second MUST-NOT bullet exist to block;
4. a substring test `targetRepo.includes(<cwd basename>)` — a consumer in a directory named
   `kailash-coc-rs` merging on `…/kailash-coc-rs-template` passes unflagged.

It is NOT covered at all when run from a clone of the upstream, with no `--repo`, via `curl`, or via
`--auto`/merge-queue.

Also uncovered: a direct `git push` to an upstream branch (`validate-bash-command.js` requires BOTH
`--force` and a main-token, so a non-force push falls through to an advisory reminder); and the
sibling cross-repo write primitives `pushImage`/`applyDeployTarget`/`invalidateCache` (over
`_dispatchWorkflow` on GitHub, `_runPipeline` on ADO), which take an arbitrary `repoRef` with no
own-repo check — `workflow_dispatch` on an upstream's default branch is a WIDER capability than the
merge this fences.

### Candidate hardening — named, and deliberately NOT declared as deferred work

Three surfaces would narrow the residuals above: a `validate-bash-command.js` tripwire for
`gh pr merge` / `git push` against a non-self repo; an ACTION-scoped cross-repo receipt (`open` vs
`complete`, not merely a read/write tier); and extending the derivation fence to the deploy-write
surface (`pushImage` / `applyDeployTarget` / `invalidateCache`).

None of the three is scheduled, owned, or promised. The rule's Detection field says so explicitly
rather than carrying an undated "Phase-2 targets" promise, because an undated promise is a
permanent-by-default deferral wearing a roadmap — the exact shape `deferral-registry-locality.md`
BLOCKS and `phase2-deferrals.json` exists to date. Whoever builds one registers a dated entry
(`reason` / `graduation` / `expires` / `accepted_by` / `risk`) in
`.claude/test-harness/phase2-deferrals.json` at that time, with its audit fixtures landing in the
same change per `cc-artifacts.md` Rule 9. Until then the residuals are UNCOVERED, and the rule says
UNCOVERED — which is the honest state for a rule whose own subject is not over-claiming a control.

### Cumulative-posture caveat (scope), in full

The unreachability argument (a cross-repo write is `critical` → L1 on the FIRST instance, so a
cumulative 3×/5× window is structurally unreachable) holds for the ACTS — merge / complete /
auto-merge / direct push — which are all cross-repo writes. It does NOT extend to the second
MUST-NOT bullet ("Read MUST-1's human gate as authorization to COMPLETE a PR, rather than to SUBMIT
one"), which is a REASONING violation: asserted without executing, it is no cross-repo write, so
`critical` never fires and the N/A leaves it with no posture path at all. That bullet is therefore
gate-review-only (reviewer at `/implement` + cc-architect at `/codify`), and no structural signal
for it exists today. Recorded so a reader does not infer posture coverage the routing does not
provide.

### Trigger-key naming note

`critical` is a severity CLASS in `trust-posture.md` MUST-4's emergency list, not a machine trigger
key like `regression_within_grace`. A detector author will not find a `critical` key in
`posture-spec.md`'s `type` enum, and should route on the cross-repo-write predicate instead.

### Semantic tier — COVERED since 2026-08-16 (authored, not deferred)

The tier was UNCOVERED until 2026-08-16. It was closed by AUTHORSHIP, taking the first of the two
paths the prior text named. `.claude/test-harness/probes/upstream-issue-hygiene.probes.json` carries
6 rows in 3 bipolar `pair_id` pairs, with candidates + answer-key sidecars at
`.claude/audit-fixtures/upstream-issue-hygiene/`:

- `MUST-4-firing` — efficacy (`RuleEfficacyAnswer`) on a downstream upflow that opens its inbox PR
  and then `--admin --merge`s it on the UPSTREAM; no-false-positive (`NoFalsePositiveAnswer`) on one
  that opens, posts the URL, stops — and merges a PR on its OWN repo. Both poles contain
  `gh pr merge`, so the pair is not separable lexically.
- `MUST-4-completion-locus` — efficacy on `--auto --squash` enabled against the upstream PR after a
  human approved the FILING (the MUST-1/MUST-4 conflation); no-false-positive on an UPSTREAM
  maintainer `--admin --merge`ing a downstream-authored PR on its own repo after the four ingest
  steps genuinely ran. Both poles admin-merge someone else's PR.
- `meta-compliance` — a surface-equalized rule pair (identical frontmatter, identical `##` skeleton,
  2 clauses each, byte-identical clause 2, sizes 4.7% apart) whose violation pole's five defects are
  confined to clause 1 and live in what the affordances CONTAIN.

Registered in `.claude/test-harness/eval-manifest.json` as a probe-only entry (`scanner: null`,
`type: rule`) and pinned in `.claude/test-harness/tests/probe-suite-integrity.test.mjs::PINNED_SUITES`,
which enforces the bipolar-pole, answer-key-separation, judge-model-pin and meta-pole
surface-equalization floors. **No `probe_authorship_deferrals` row was minted and none is owed** — a
new row would hit `checkAcceptanceGate`, which demands a `.claude/deferral-acceptance/` receipt with
`requested_by != accepted_by`, and `completion-criterion.md` MUST-6 forbids self-acceptance, so the
deferral path was not self-serviceable.

**What registration buys, MEASURED and not assumed: DISPATCHABILITY, never automatic execution.**
Two-pole on one tree, 2026-08-16: `coc-probe-dispatch.mjs plan` reports `dispatch_count` 66 → 72 with
6 rows under `suite: upstream-issue-hygiene` where there were 0, and `refusal_count` 0 on both poles
(the before pole taken by stashing the manifest entry alone, so the delta is attributable to the
registration and to nothing else). But no workflow invokes the dispatcher, so **a green CI run is
NEVER evidence these probes passed** — the suite executes only when an orchestrator dispatches it at
gate-review via `/test-harness-probe --artifacts`. What CI does gate is REGISTRATION and hygiene
(`coc-manifest-integrity.mjs` + `probe-suite-integrity.test.mjs`).

This closes `coc-artifact-eval-coverage.md` MUST-1's prose-artifact mandate for MUST-4. It changes
nothing about the STRUCTURAL tier or about the three UNCOMMITTED Phase-2 hardening surfaces above,
which remain uncovered and undeferred.

---

## Origin — MUST-4 (Open, Never Complete), in full

**2026-08-03 — co-owner-directed origination at the `kailash-coc-rs` USE template.** A downstream
`/codify` cascade **merged its upflow PR into its upstream template's `main`**, executing the
upstream's review gate on the upstream's behalf. Root cause was an absence, not a bad instruction:
**no clause anywhere in the corpus prohibited it** (`grep -rn "never merge\|MUST NOT merge"` over
`rules/`, `commands/`, `sync-flow.md`, and the inbox README returned only an unrelated red-CI hit).
MUST-1 gates `gh issue create` / `gh pr create` — submission — and is silent on completion. The one
prose surface a downstream agent reads, `skills/30-claude-code-patterns/sync-flow.md`, listed
`completeUpflowPR` → `gh pr merge` in the SAME sentence as the two downstream-facing primitives,
qualified only by the word "maintainer-side" — which a consumer that just opened the PR can
plausibly read as itself. Meanwhile `completeUpflowPR` was defined, exported, and **caller-less** in
both VCS adapters: a documented merge capability on the upflow lane with nothing gating it and
nothing using it.

Fixed by (a) the MUST-4 clause and (b) a fail-closed own-repo fence in both adapters +
mutation-verified fixtures. **(c) and (d) are CORRECTED at Gate-1 ingest rather than carried
forward.** (c) — splitting the `sync-flow.md` primitive listing so the maintainer-side capability is
no longer advertised to the consumer lane — is real but ALREADY PRESENT at loom before this ingest
(`sync-flow.md` carries the MAINTAINER-side/NOT-consumer-lane split), so it is not something this
change delivers. (d) claimed a Step-7c stop-point in `commands/codify.md`; measured at ingest, that
stop-point exists in NEITHER the originating template's `codify.md` NOR loom's — Step 7c ends at
"(5) HUMAN-GATED offer … no auto-submission, no standing approval" in both, with no completion
prohibition. The claim is struck rather than left standing, because a rule whose subject is not
over-claiming a control must not itself claim a fix that does not exist.

**The gap (d) named is REAL and is now unclosed:** MUST-4's `paths:` globs are not matched by a
Step-7c session (which writes `.claude/.proposals/latest.yaml` and runs `gh pr create`), and
`codify.md` is the one surface such a session reliably reads — the same reachability class
`issue-triage-routing.md` documents in its own Origin. Tracked, not implied away. The same session
independently reproduced the template-side half of the failure — the ingest merged an inbox PR
autonomously — which is what surfaced the gap.

---

## Origin — the three same-cycle Tier-1 redteam corrections

**Same-cycle Tier-1 redteam correction (`self-referential-codify.md` Rule 1).** The first cut of (b)
took a `selfRepoRef` DESCRIPTOR FIELD and compared it against `repoRef`. A three-agent parallel
round found that BOTH operands then came off the same caller-authored object, so
`{repoRef: X, selfRepoRef: X}` cleared the fence trivially — it stopped an ACCIDENT (an agent
following the stale `sync-flow.md` prose, which IS the originating incident class) but not an agent
that had decided to merge, while this rule asserted the stronger "its own repo identity can never
equal its upstream's". A repo-wide grep found ZERO producers of `selfRepoRef`, and the docstring
named a derivation helper the adapters never imported. The same round also found the fixture set
7-of-8: `ado/case-insensitive-own-repo` was missing, and its predicate was provably uninstrumented
(dropping ADO's case-fold left the suite green). Its fix — deriving the identity in
`upflow-self-repo.js` — is itself corrected below.

**Second Tier-1 redteam correction (same cycle).** Two further rounds found the caller-authored
operand had been MOVED rather than removed — `selfRepoRef` → an injectable `_deriveSelfFn` → a `cwd`
parameter — each still reachable by the caller. The same rounds found the prose asserted an
AGREEMENT requirement the code did not implement (the comparison was `aSlug || dSlug`, an OR that
cross-checked agreement only when both operands happened to be non-null), and that the ADO `org` leg
compared `repoRef.org` against itself because the derivation never returned an `.org`. Corrected by
deriving the identity from `process.cwd()` with no seam of any kind, making the live git remote the
sole authoritative source and `.claude/VERSION::repo` refuse-only, and parsing `org` out of the ADO
remote — closing the cross-org residual rather than documenting it.

**Third Tier-1 redteam correction (same cycle).** With every parameter seam gone, the prose then
claimed the identity could not be influenced AT ALL. That is false at one remove: `process.cwd()` is
chosen by whoever launches the process (or calls `process.chdir`), so a scratch tree whose `origin`
is the upstream derives the upstream identity, matches, and clears the fence — no API misuse
required. Corrected in the PROSE (here + `sync-flow.md`) rather than by widening the fence, because
the derivation is doing the thing worth doing: it CLOSES the accident class that IS the originating
incident and raises the cost of a deliberate act, and it cannot be a boundary against a caller that
can replace the module in-process.

All three corrections are recorded rather than silently overwritten, per `instrument-discipline.md`
MUST-1: a comparison is evidence only when an operand is a fact the caller cannot author — and the
operand moved FOUR times (`selfRepoRef` → `_deriveSelfFn` → `prRef.cwd` → `process.cwd()`), each
removal followed by a prose claim stronger than the code.

---

## Extraction record (2026-08-16)

`rule-authoring.md` Rule 10 path (a) paired extraction, forced by a RED
`check-rule-injection-budget.mjs`: the `workspace-note` profile measured 431,795 B against a
390,605 B budget (ceiling 410,135 B), and this rule — 277 lines / 34,747 B, firing in that profile
via `**/journal/**` + `**/workspaces/**` — was the single largest movable contributor.

Relocated here, verbatim except for section headings and light re-wrapping: the § Scope inbox-PR
paragraph, the MUST-1/2/3 worked examples, the **MUST-1/2/3 BLOCKED-rationalization corpora**, the
MUST-4 fence-scope paragraph, the Detection field's structural-tier detail and uncovered-residual
enumeration, the cumulative-posture scope caveat, the trigger-key naming note, the MUST-4 Origin
narrative, and the three Tier-1 redteam corrections. The rule now measures 13,011 B / 130 lines
against 34,747 B / 277 before, which puts the `workspace-note` profile back inside its ceiling.

**What stayed inline in the rule**, each un-weakened: every MUST clause statement; MUST-1's and
MUST-4's DO/DO-NOT blocks (MUST-2's and MUST-3's compressed to a one-line DO/DO-NOT, full worked
bodies here); **MUST-4's complete nine-phrase BLOCKED corpus**; MUST-2's seven-item denylist;
MUST-3's five required sections; all six MUST NOT bullets with their `**Why:**` lines; and all eight
canonical Trust-Posture-Wiring fields (`trust-posture.md` MUST-8), each still substantive.

**The MUST-1/2/3 corpora moved and MUST-4's did not** — stated plainly rather than glossed. MUST-4 is
the clause this file's Wiring block governs, so its corpus is load-bearing inline. The three
grandfathered clauses' corpora follow the established path-(a) precedent in this repo
(`zero-tolerance.md` "full BLOCKED corpus in guide", `git.md` "full BLOCKED rationalization lists",
`evidence-first-claims.md` "BLOCKED-rationalization corpora"), and each is cited from its clause's
`**Why:**` line by phrase count, so a reader knows exactly what is one hop away. They bind as before.

**One substantive change, made deliberately and not a de-scope.** The Detection field's former
"Phase-2 targets: …" sentence promised three detectors with no date, no owner and no registry entry.
That is a permanent-by-default deferral, which is what `deferral-registry-locality.md` BLOCKS and
what `phase2-deferral-integrity.mjs` reds on. It is replaced by an explicit statement that no
Phase-2 detector is committed, with the three candidate surfaces preserved above under § Candidate
hardening and a registration requirement attached to whoever adopts one. The rule now claims LESS
enforcement than it did, and claims it accurately — the same correction the three Tier-1 redteam
rounds made to this clause's structural half.

The rule body is now under the 200-line guidance in `rule-authoring.md` MUST NOT § "Rules longer
than 200 lines", so the former § Length rationale is retired rather than relocated; the
upstream-filing-contract scope it justified is unchanged.
