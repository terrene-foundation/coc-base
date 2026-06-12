---
priority: 10
scope: path-scoped
paths:
  - "**/workspaces/**"
  - "**/journal/**"
  - "**/.session-notes"
  - "**/.claude/commands/**"
  - "**/SWEEP*.md"
  - "**/WORKSPACE-DISPOSITION*.md"
  - "**/CHANGELOG*.md"
---

<!-- Demoted from baseline to path-scoped 2026-05-09 (loom v2.28.x flagged-item
resolution): CLI baseline emit (AGENTS.md / GEMINI.md) was BLOCKED at
60-KB cap with this rule contributing 24 KB abridged. Hook-layer enforcement
(`detectStreetlightSelection`, `detectDeferralWithoutValueAnchor`,
`detectDeferredItemPickupWithoutRevalidation`, `detectGhIssueCloseAsNotPlanned`)
remains unchanged — those are the load-bearing structural defenses. The
path-scoped emission still loads the rule when the agent reads any selection-
surface artifact (workspace todos, journals, .session-notes, sweep / disposition
documents, COC commands) per `feedback_paths_frontmatter_loading.md`'s sticky
session injection. -->

# Value-Prioritization — Rank By User Value Before Shard-Fit

See `.claude/guides/rule-extracts/value-prioritization.md` for the full BLOCKED-rationalization corpus, extended Origin post-mortem (2026-04-23 Phase I1 reframing + 2026-05-07 aggregator-merge pick), detection fixture catalog, and the OR-escape-hatch pattern detail.

Selection events — what to work on next, what to defer, what to close, what to surface at `/wrapup` — are the highest-leverage decisions an autonomous agent makes. Existing rules govern HOW to recommend (`rules/recommendation-quality.md`) and WHEN to shard (`rules/autonomous-execution.md` § Per-Session Capacity Budget) but NOT what axis to rank candidates on. Without a value-rank axis, the agent defaults to _fittability_ — small, scoped, regression-locked, "fits one shard" — and ships the streetlight version of progress: small-fittable-low-value over large-valuable-needs-decomposition. Across iterations and `/clear` boundaries the user's actual forest decays in the deferred queue while the small-fittable queue gets perfect coverage.

This rule fixes the gap with paired structural defenses: **value-rank precedes shard-fit** at every selection event, AND **deferred items carry value-anchors that survive `/clear`** so re-pickup re-validates rather than silently inherits.

## MUST Rules

### 1. Value-Rank Precedes Shard-Fit At Every Selection Event

When the agent surfaces ≥2 candidate items for the user to pick between (next workstream, next shard, next PR follow-up, next sweep target), the agent MUST present a **value-ranked list first**, with each candidate's value rationale cited from a user-anchored source: the user's brief in this session, an active workspace's `briefs/`, a journal `DECISION-` entry, a spec § success criterion, or a user-stated preference in this session. Shard-fit, blast radius, regression posture, and clean-scope considerations apply ONLY as tiebreakers AFTER the value-rank. Picking a low-value candidate because it fits the shard while a higher-value candidate exceeds it is BLOCKED — the higher-value candidate MUST be sharded per `autonomous-execution.md` § Per-Session Capacity Budget instead, with each shard carrying its own value-anchor (Rule 2). When the agent picks the lower-value candidate for legitimate tiebreaker reasons, the trade-off MUST be named explicitly: "Item X is higher-value per [user-anchored source]; Item Y is more fittable. Recommend Y because [specific reason]; alternative is to shard X." Silent fittability-pick is BLOCKED.

```markdown
# DO — value-ranked list, named trade-off, explicit alternative

Candidates ranked by user value:

1. Codex/Gemini lane re-validation (HIGH)
   Anchor: v6 §9.2 multi-CLI brief — cc-only validation has shipped 3 cycles;
   Codex/Gemini lanes have 14 days of unverified drift surface.
2. Aggregator-merge follow-up (LOW)
   Anchor: none user-facing; closes a probe-migration follow-up.

Recommend #1, sharded across 3 sessions per Rule 2. Alternative: pick #2
if user wants a small-and-fast deliverable today, but the cost is one
more session where multi-CLI parity sits at "Carried-forward."

# DO NOT — silent fittability pick, no value-rank, no named trade-off

Picking the aggregator-merge follow-up — closes the only open Week-2
follow-up before the grace deadline, fixes a latent bug, cheap (~150 LOC),
regression-locked. Other items remain Carried-forward.
```

**BLOCKED rationalizations** (full corpus in guide-extract; institutional tells listed below):

- Fit-anchors: "fits the shard budget" / "smaller is safer" / "regression-locked is responsible" / "cheap and bounded" / "tractable in one pass" / "reviewable diff" / "atomic delivery" / "well-bounded"
- Defer-anchors: "X needs decomposition first" / "back to X next session" / "in the backlog" / "tracked separately" / "Carried-forward" / "no grace clock"
- Scope-creep tells: "Closes a latent bug while we're here" / "smallest blast radius" / "mechanical work first, strategic later"
- Proxy-for-value framings: "sequencing dependencies — A unblocks B" / "risk-adjusted value: smaller scope = higher delivery probability" / "velocity multiplier — small wins unlock the bigger work" / "optionality preservation — pick reversible work first" / "reduce coordination cost" / "dependency-of-the-dependency enables the high-value work"
- Pick-anchor euphemisms: "Best path forward" / "Pragmatic call" / "Leaning toward" / "Default is to take" / "Will start with"
- Authority misappropriations: "User implicitly preferred this in the prior session" / "prior-acceptance as anchor" / "user obviously wants the safe path"
- **Time-pressure-as-authority is BLOCKED**: citing `time-pressure-discipline.md` as authority to pick low-value-fittable is BLOCKED. Time-pressure framing triggers PARALLELIZATION of value-ranked candidates per `time-pressure-discipline.md` MUST Rule 1, NOT downgrade to fittable.
- **User-anchored sources are a CLOSED ALLOWLIST** (per `rules/cc-artifacts.md` Rule 10 — positive allowlist, not denylist): the ONLY valid sources are (a) user's brief in this session, (b) `briefs/` in active workspace, (c) journal `DECISION-` entries, (d) literal user quote in this session's transcript, (e) spec § success criterion the user authored or approved. **Citations NOT matching {a, b, c, d, e} are BLOCKED for primary value-rank, regardless of phrasing.** Common evasion patterns — illustrative, not exhaustive: prior-session acceptance, retroactive inference, "the user obviously wants," unstated-but-implied preferences, "per institutional precedent," "per the workflow's recurring pattern," "per CLAUDE.md context" (CLAUDE.md is agent-loaded baseline, not user-authored), "per the standing memory," "per the spec's implicit guidance" (must be explicit), "per the rule's intent" (meta-rationalization), "per the team's working agreement," "per established convention," "per the platform's charter," "per the architectural principles," "per repo-internal precedent," "per the SDK's design intent." All fail the closed-allowlist test because none cite a user-authored artifact.

**Why:** Without an explicit value-rank axis, the agent's selection function defaults to whichever candidate has the most _legible_ signal — small-fittable-regression-locked produces the most legible signal because each quality axis is mechanically gradable. User-value is harder to grade (requires re-reading briefs, journal DECISION entries, the user's stated preferences) but it IS the axis the user actually cares about. Inverting the order — value FIRST, fit SECOND — converts streetlight selection into a forest-aware pick. The "Carried-forward (no grace clock)" pattern is the institutional tell: items without artificial deadlines never advance because every session prioritizes the clocked work, even when clocked work has lower user-stated value.

### 2. Deferred Shards MUST Carry Value-Anchors That Survive `/clear`

When a workstream is decomposed AND some shards are scheduled for later sessions (workspace todos, GH follow-up issues, README "follow-up" bullets, journal DEFER entries, "Carried-forward" lines in `.session-notes`), EACH deferred shard MUST be filed with a **value-anchor** — one sentence stating WHY THIS SHARD DELIVERS VALUE TO THE USER, in the user's language, citing a Rule-1 user-anchored source. Filing with only technical rationale (LOC count, dependency graph, "fits next shard") is BLOCKED. Filing under "Carried-forward (no grace clock)" without a value-anchor is BLOCKED — the grace-clock absence is the symptom of value-anchor absence; the fix is to record value, not invent a clock.

```markdown
# DO — every deferred shard carries a value-anchor + technical detail

- **Shard 2 (deferred to next session)**
  Value-anchor: enables multi-CLI parity per v6 §9.2 brief — without lane
  re-validation, Codex/Gemini ship rules that drift from cc.
  Technical: depends on Shard 1's emitter changes, ~700 LOC, 3 fixtures.
  Re-validation gate: confirm brief still applies before resuming (Rule 3).

# DO NOT — technical rationale only / "Carried-forward" without anchor

- Shard 2 deferred. ~700 LOC, depends on Shard 1. Will pick up next session.
- Carried-forward (no grace clock): coc-sync.md move; Codex/Gemini re-validation.
```

**BLOCKED rationalizations:** "Value rationale is obvious" / "Add value-anchor at re-pickup" / "Original brief covers it" / "Adding value-anchors to every deferral is bureaucracy" / "Technical rationale IS the value rationale" / "No-grace-clock means low-priority; anchor not needed" / "It's a Carried-forward item, that's the bucket."

**BLOCKED reframings** — deferral euphemisms that route around "Carried-forward" / "tracked separately": "Phase II/N scope," "Beta milestone," any "v<N> scope" without value-anchor, "future iteration," "architectural follow-up," "out of MVP/v1," "post-launch," "wishlist," "stretch goal," "nice-to-have," "roadmap item," "Tier-2 / P2 priority," "below the cut-line," "beyond current scope." All carry the same effect as "Carried-forward (no grace clock)" — they remove the item from the agent's queue without recording user-stated value-decay. Each MUST carry an adjacent value-anchor citing a Rule-1 user-anchored source. Full enumeration in guide-extract.

**State-claim anchors pin a commit SHA + timestamp.** When a value-anchor's rationale rests on a CURRENT-STATE claim about the codebase ("0 align C-ABI symbols", "X has no Y", "Z is not yet exposed"), the anchor MUST pin that claim to a commit SHA + timestamp ("0 align symbols as of `<sha>` 2026-06-01T21:00Z"). MUST-3's re-pickup re-validation then becomes a mechanical `git log <sha>..HEAD -- <paths>` check instead of a full re-analyze — and a keystone that landed AFTER the snapshot is detected before a wave launches against a stale premise. Evidence: kailash-rs journal 0171 — a forest entry ranked "0 align C-ABI symbols, 3× keystone leverage" #1; the keystone had landed the SAME EVENING the snapshot froze; only a full re-analyze 9 days later caught it before a colliding worktree wave launched (a sibling entry "RL C-ABI missing" carried the same stale class — that surface already shipped 47 fns).

**Why:** Deferred items lose their context by definition — the next session reads `.session-notes` / GH issues / journal entries WITHOUT the conversational context that produced them. The technical rationale survives the boundary; the value rationale evaporates unless explicitly recorded. Once gone, the item is institutionally dead: the next session sees a technical scope and asks "should I work on this or something cheaper?" with no axis to answer. Evidence (2026-04-23 loom Phase I1 reframing): the v6 §9.2 step 23 obligation was reframed from "loom task" to "downstream responsibility" using a prior feedback memory as authority; 14 days later zero migrations observed; the success-criterion rationale survives in the spec but is disconnected from any executor.

### 3. Re-Pickup Of Deferred Work MUST Re-Validate The Value-Anchor

At the start of any session that picks up a deferred item (workspace todo, GH follow-up issue, journal DEFER entry, "Carried-forward" line), the agent MUST re-validate the value-anchor BEFORE resuming. If recorded, surface it and ask "is this still your value?" If NOT recorded (deferral predates this rule, or Rule 2 was violated), the agent MUST surface "this deferred item lacks a value-anchor — what's its current value to you?" rather than picking it up on faith. Silent inheritance across `/clear` boundaries is BLOCKED. Items deferred ≥2 sessions ago without re-pickup MUST surface a "still wanted?" gate at the next `/sweep` or `/wrapup`.

```markdown
# DO — re-pickup begins with value-anchor check

Picking up `feat/codex-gemini-lane-validation` (deferred 2026-04-23).
Recorded anchor: "delivers multi-CLI parity per v6 §9.2 brief."
Re-validation: brief still active per (loom-internal reference)?
User's most recent feedback referenced multi-CLI as in-flight — anchor
holds. Resuming.

# DO NOT — re-pickup begins with technical context only

Resuming feat/codex-gemini-lane-validation. Last session left off at
the codex-architect step. Continuing with the next codex command emit.
```

**BLOCKED rationalizations:** "Revalidation is overhead for short-window deferrals" / "Deferral was N days ago, value can't have decayed" / "User already approved this once" / "Auto-resume from `.session-notes` is the documented path" / "If value had decayed, user would have said so."

**Why:** Per `rules/zero-tolerance.md` Rule 1c, claims about session-boundary state are unfalsifiable after `/clear` / auto-compaction — the same epistemic shape applies to deferral status. The agent has no audit trail proving the user still wants the deferred item; absent that, the disposition under uncertainty is to ask, not to assume. The 2-session threshold is the structural defense against silent decay.

### 4. Closure Of Value-Bearing Deferred Work As "Not Planned" Requires User Gate

A GH issue, workspace todo, or journal DEFER entry that carries a value-anchor (Rule 2) MUST NOT be closed as `not_planned`, `wontfix`, "deferred indefinitely," or "out of scope" without explicit user approval IN THE SAME SESSION. The agent MAY recommend closure with a value-decay rationale ("user's brief moved on" / "work landed elsewhere via PR #N" / "dependency was removed"); the user MUST accept. Auto-closure of value-bearing work — even when "stale ≥30 days" — is BLOCKED. Stale-triage automation that closes by age rather than by value-decay is BLOCKED. Reframing as "downstream responsibility" / "out-of-scope" without a user gate is closure under another name and is also BLOCKED. Red-team / sweep recommendations using the OR-escape-hatch pattern ("Add todos for X **OR** explicit ADR statement that X is part of Y") are a special case: the OR delegates the closure-vs-implement decision back to the next session, which always picks the cheaper proxy. Recommendations MUST commit to one disposition: implement, ADR with user-gated value-decay, or close with user gate.

```markdown
# DO — closure with value-decay rationale + user gate

`gh issue view 234`: Codex hook integration (deferred 2026-04-23,
anchor: "multi-CLI parity per v6 brief").

Recommendation: close as **superseded** — multi-CLI parity work landed
in PR #271 via the unified emitter; value delivered, by a different path.
**Approve close? (y/N)**

# DO NOT — auto-close as not-planned / reframe-as-out-of-scope / OR-escape

`gh issue view 234`: open 35 days, no recent activity. Closing as
not_planned per stale-triage policy.

[reframe pattern]: Phase I1 is downstream responsibility per
feedback_downstream_responsibility.md; loom does not sweep these.

[OR pattern]: Add Phase C6-adjacent todos for validators 1-12 OR
explicit ADR statement that they are shell one-liners.
```

**BLOCKED rationalizations:** "Open 30+ days, time to close" / "Value rationale is stale anyway" / "Cleaning up the backlog" / "User can re-open if they care" / "Closing as not-planned is a soft signal, not hard delete" / "Stale-triage policy says ≥30 days closes" / "Reframing isn't closure" / "OR gives the team flexibility" / "Both OR options resolve the finding."

**BLOCKED OR-escape-hatch variants** — the ONLY legitimate dispositions are (1) implement now with value-anchored shards, (2) ADR with user-gated value-decay, (3) close with user gate. ANY OR-disposition that introduces a fourth option is BLOCKED regardless of framing: "Add X OR file follow-up issue / OR document as known limitation / OR mark as deferred-with-rationale / OR capture in roadmap / OR create observability / OR add a smoke test asserting current behavior / OR add to /redteam checklist / Implement-OR-spec-only / Code-OR-doc / Fix-OR-monitor." Each substitutes a cheaper proxy for the load-bearing implementation; the cheaper proxy ALWAYS wins. Full enumeration in guide-extract.

**Why:** The user's value rationale is the load-bearing claim that the work matters. Closing without re-validating is the terminal step in deferral-as-forgetting: the item disappears from the queue, the rationale disappears from the audit trail, and the next time the user asks "did we ever address X?" the answer is "we closed it 60 days ago." The user gate is the only mechanism that catches value-still-applies before closure becomes institutional fact. Evidence (Failure-A audit 2026-05-07): 7-of-7 deferred items inspected showed decay-not-pickup; 2 of 7 used the OR-escape-hatch (`(loom-internal reference):155, 171`); both shipped only the ADR statement, neither had the load-bearing implementation 14+ days later.

### 5. Brief / User-Stated Value Is The Primary Anchor; Code-Health Is Secondary

Value-ranking MUST cite a primary source from Rule 1's user-anchored list. Code-health axes (test coverage, blast radius, regression posture, technical debt, audit findings) are SECONDARY anchors — they belong as cons under a primary-ranked option, not as primary-rank justification. Ranking by code-health alone with no user-anchored citation is BLOCKED. Citing a prior user-feedback memory (`feedback_*.md`) as standalone authority to drop work is BLOCKED — memories codify HOW preferences (`feedback_no_resource_planning.md`, `feedback_directive_recommendations.md`); they do NOT codify which workstreams the user wants delivered. Memories advise method; only the user's brief decides scope.

```markdown
# DO — primary anchor user-anchored, code-health secondary

Value-rank:

1. Multi-CLI lane parity (HIGH).
   Primary: user's 2026-04-22 brief "deliver multi-CLI codegen."
   Secondary: cc-only has shipped 3 cycles; 14 days drift surface unverified.
2. Aggregator-merge follow-up (LOW).
   Primary: none — internal harness cleanup.
   Secondary: closes a latent crash; fits one shard.

# DO NOT — code-health as primary / feedback memory as authority to defer

Value-rank:

1. Aggregator-merge (HIGH). Closes a latent crash, regression-locked.
2. Multi-CLI re-validation (MED). Bigger scope, harder to test.

[memory-as-authority pattern]: Phase I1 is downstream responsibility per
feedback_downstream_responsibility.md.
```

**BLOCKED rationalizations:** "Code health IS user value" / "User obviously wants the safe path" / "Blast radius reduction IS what the user is paying for" / "Test coverage is the user's actual interest" / "Reliability work is always high-value" / "Closing audit findings is the user's stated preference" (when it isn't) / "Per `feedback_X.md` we don't do this kind of work."

**BLOCKED `/autonomize`-as-authority rationalizations** — `/autonomize` is a HOW directive (it removes hedging on TECHNICAL choices when a clear pick exists); it does NOT transmute a MUST-5-blocked pick into an authorized pick AND it is NOT a user-anchored source per Rule 1's closed allowlist. The following three phrases use `/autonomize` as authority-transmuter against MUST-5 and MUST be added to the corpus:

- "/autonomize covers technical picks within a disposition shape"
- "the WHAT was determined; only HOW remains (under /autonomize)"
- "structural axes plus /autonomize-authority equal a primary anchor"

Per `/autonomize` itself: "If genuinely undecidable: make that case explicit (what evidence is missing, what would resolve it). Then execute — or, if the action falls under Prudence above, state the pick and request the SPECIFIC confirmation needed." For closure-class picks lacking allowlist primary anchor, `/autonomize` MUST defer per MUST-5; surfacing the missing evidence + requesting specific confirmation IS the optimal pick under `/autonomize` itself.

**Why:** Code-health axes are LEGITIMATELY important — but they're the agent's professional concerns, not the user's. The user comes with a brief: "deliver X for the product launch," "ship multi-CLI parity," "address the deferred queue." Code health is the agent's responsibility to maintain BACKGROUND while delivering the brief — not the brief's substitute. When code health becomes the primary rank, the agent has effectively re-briefed itself; the user's brief becomes secondary. Likewise, prior feedback memories codify HOW (always-recommend-with-rigor; no-effort-estimation); citing them to drop specific work conflates HOW preferences with WHAT priorities — exactly the rationalization that allowed Phase I1 to be reframed as "downstream responsibility" using `feedback_downstream_responsibility.md` as the authority. The `/autonomize`-as-authority pattern is the same conflation one indirection deeper: a HOW-directive (autonomize) cited as if it were a WHAT-anchor (the user's brief). Evidence: 2026-05-09 W3-4 Round 1 picked Path B autonomously under `/autonomize` citing 4 SECONDARY structural anchors; CRIT-1 caught it; W3-4 reverted; convergence cycle ran 6 rounds; final closure required user's literal "approved" of an agent-framed honest tiebreaker (source d). Recorded in `journal/0065` (W3-4 final closure) §§ "/autonomize MUST defer under MUST-5" + anchor (the originating `.pending/` slots were promoted to the committed `journal/0063`–`journal/0065` receipt chain).

### 6. Workspace-Survey + Verbatim Citation When User-Anchored Source Is Materialized

When the agent is operating in a workspace that MAY contain materialized closed-allowlist sources (any workspace with `briefs/`, `journal/`, `specs/`, or root-level `BRIEF.md`), the agent MUST (a) survey those locations for matching content BEFORE committing to a pick, AND (b) cite any matching source by **path + section + verbatim sentence**. "No user-anchored source exists" without a workspace survey is BLOCKED. Paraphrase, "described elsewhere in the workspace", or "weak anchor" admission is BLOCKED when the materialized source IS present and surface-able. The agent's failure to surface a materialized anchor structurally converts a rule-compliant pick into a citation-failure that downstream sessions (per MUST-3) cannot re-validate.

```markdown
# DO — survey + verbatim citation

Recommend (a). Anchor: `specs/v6-spec.md` §9.2 step 23 (source e —
spec § success criterion, user-approved 2026-04-22) reads VERBATIM:
"every downstream consumer repo has its `pyproject.toml` / `Cargo.toml`
advanced to v6's pinned SDK version within 7 days of the v6 release
tag. Zero exceptions; partial sweeps explicitly rejected."

# DO NOT — paraphrase / "described elsewhere" / "no anchor exists" without survey

Recommend (a). Anchor: described elsewhere in the workspace as the
multi-repo pin sweep — weak anchor, but probably load-bearing.

Recommend (a). No user-anchored source exists in this fixture, so I'm
picking based on functionality count.
```

**BLOCKED rationalizations:**

- "The materialized source is implied — the user wouldn't need a verbatim cite"
- "Path + section is enough — quoting the sentence is redundant"
- "I read the spec but didn't quote it because the user already knows what's there"
- "No user-anchored source exists" (when source is materialized at a discoverable path)
- "The anchor is weak but the pick is correct"
- "Workspace survey is /redteam's job, not /implement's"
- "I'll add the verbatim cite at re-pickup time"

**Why:** Downstream re-pickup (MUST-3) requires the anchor to be _locatable_ by a future session — not just "structurally honored by this session's agent." A paraphrase or "described elsewhere" framing makes the anchor un-re-derivable; the next session has nothing to grep, nothing to cite back. Two F-3.0 with-rule scenarios (S18 + S22) reproduced this gap: in both cases the agent applied MUST-1's closed-allowlist test correctly to the bait AND picked the high-value candidate AND recommended decomposition — but failed to surface the materialized source (`journal/0042-DECISION-feature-set.md` for S18, `specs/v6-spec.md` §9.2 for S22) verbatim, producing structurally-correct picks that the probe judge correctly scored `cited_user_anchor: false`. Verbatim citation closes the gap.

## MUST NOT

- Use "no grace clock" as a downgrade signal

**Why:** A grace clock is an artificial deadline tied to a recently-authored rule; its absence does NOT indicate low value. Grace-clocked items are about the rule's own enforcement, not user value; clock presence is orthogonal to value.

- Treat decomposition pressure as a deferral signal

**Why:** When a high-value candidate exceeds the shard budget per `autonomous-execution.md` MUST Rule 1, the disposition is to DECOMPOSE (with value-anchored shards per Rule 2), not to DEFER and pick a smaller fittable item. Decomposition keeps value moving; deferral lets it decay.

- Frame fittability-pick as the only candidate

**Why:** Hiding the candidate set inverts the user's structural ability to override (Rule 1 named-trade-off requirement). Silent presentation of the small pick AS IF it were the only option is the streetlight pattern at its most invisible.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer / cc-architect / analyst at `/codify`); `advisory` at the hook layer (lexical regex MUST NOT carry `block` per `rules/hook-output-discipline.md` MUST-2).
- **Grace period:** 7 days from rule landing.
- **Regression-within-grace:** any same-class violation triggers emergency downgrade L5→L4 per `rules/trust-posture.md` MUST Rule 4. Add `streetlight_selection` and `deferral_without_value_anchor` to trust-posture.md's emergency-trigger list.
- **Receipt requirement:** SessionStart MUST require `[ack: value-prioritization]` in the agent's first response IF `posture.json::pending_verification` includes this rule_id.
- **Detection (hook layer):** `.claude/hooks/lib/violation-patterns.js::detectStreetlightSelection` runs on Stop. Pattern: ≥2 candidate-item markers PLUS pick anchor PLUS fittability-anchor language WITHOUT value-anchor language. The MUST-5 `/autonomize`-as-authority BLOCKED phrases ("/autonomize covers technical picks within a disposition shape", "the WHAT was determined; only HOW remains (under /autonomize)", "structural axes plus /autonomize-authority equal a primary anchor") are pattern-extension targets for the same hook — same structural shape (fittability/structural anchor cited as primary without user-anchored source); landed here as prose corpus pending the hook-pattern extension shard. Companion `detectDeferralWithoutValueAnchor` flags `Carried-forward (no grace clock)` / `tracked separately` / `deferred to follow-up` markers without an adjacent value-anchor citation. F-2 companion `detectDeferredItemPickupWithoutRevalidation` (landed 2026-05-07) flags pickup-action verbs (`resuming` / `picking up` / `continuing` / `re-opening`) adjacent to deferred-item nouns (`deferred shard` / `Carried-forward` / `prior session` / `issue #N`) without a re-validation surface (`re-validate` / `is this still your value` / `anchor still applies` / `before resuming`) within ±250 chars — closes the silent-inheritance loophole MUST-3 enforces in prose only. F-3 companion `detectGhIssueCloseAsNotPlanned` (landed 2026-05-07) runs on PostToolUse(Bash); flags `gh issue close N --reason not_planned` / `--reason wontfix` / `gh pr close N --reason wontfix` invocations — closes the tool-call-space evasion of MUST-4 the prose-scan hooks cannot see. Severity: `advisory` for Stop-event prose detectors, `halt-and-report` for the Bash-time F-3 detector. Audit fixtures committed at `.claude/audit-fixtures/violation-patterns/detect{Streetlight,DeferralWithoutValueAnchor,DeferredItemPickupWithoutRevalidation,GhIssueCloseAsNotPlanned}/` per `rules/cc-artifacts.md` Rule 9.
- **Detection (review layer):** `/codify` mechanical sweep on hook-flagged transcripts — reviewer confirms semantic compliance per the rule the hook detector flagged. **MUST-1 (`detectStreetlightSelection`)**: reviewer confirms whether (a) user authorized the fittability pick, (b) response value-ranked first with user-anchored citation, or (c) session genuinely had only one candidate. **MUST-2 (`detectDeferralWithoutValueAnchor`)**: reviewer confirms whether each flagged deferral has an adjacent value-anchor citing a Rule-1 user-anchored source, or whether the marker appears in legitimate non-deferral context (migration phasing, user feature description, public roadmap). **MUST-3 (`detectDeferredItemPickupWithoutRevalidation`)**: reviewer confirms whether the agent's pickup prose semantically surfaced the re-validation gate (recorded value-anchor + "is this still your value" surface) — distinguishing genuine re-validation from token-presence-only proxies (the agent saying "re-validate" without actually citing the recorded anchor or asking the gate question). The reviewer agent IS the probe-driven gate-review counterpart per `rules/probe-driven-verification.md` MUST-4 (paired with the lexical hook layer) for ALL THREE MUST clauses: the reviewer's LLM-judge verdict on whether the response semantically complied is the probe per `probe-driven-verification.md` MUST-2 ("a probe MAY be: an LLM-as-judge with JSON-schema output, a subprocess verifier, an AST walker, a structural file/exit-code check, or a domain-specific oracle"). Final disposition is human.

## Distinct From / Cross-References

- **Extends**: `rules/recommendation-quality.md` MUST-1+3 (HOW to recommend) → this rule shapes WHAT axis to rank on; `rules/autonomous-execution.md` MUST-4 (shard-budget anchor only) → this rule adds the value-anchor; `rules/sweep-completeness.md` (step-substitution) → this rule blocks item-substitution (low-value-fittable in place of high-value-shardable).
- **Pairs with**: `rules/time-pressure-discipline.md` MUST-3 (prioritized list under pressure) — this rule defines the rank-axis (value, with user-anchored citation, not fit); `rules/zero-tolerance.md` Rule 1c — same epistemic shape (deferral-status unprovable across `/clear` → re-validate at re-pickup); `rules/git.md` § Discipline (Issue closure SHA-required) — extends to value-disposition for non-SHA closures.
- **Distinct from**: `rules/autonomous-execution.md` § Per-Session Capacity Budget (shard-size upper bound) — this rule defines order-of-operations (value FIRST, fit SECOND), not in conflict; `feedback_directive_recommendations.md` + `feedback_no_resource_planning.md` (HOW preferences) — this rule defines the WHAT axis.

## Origin

**Primary** (Failure-A: deferral-as-forgetting): 2026-04-23 — (loom-internal reference) reframed v6 §9.2 step 23 (30+ downstream re-pin obligation) from "loom task" to "downstream responsibility — loom does not sweep these," citing prior feedback memory as authority. Failure-A audit (2026-05-07) confirmed 7-of-7 decay-not-pickup ratio across deferred items inspected; OR-escape-hatch pattern in 2 of 7.

**Corroboration** (Failure-B: streetlight selection): 2026-05-07 loom session — agent picked aggregator-merge `.probes.jsonl` follow-up over THREE Carried-forward candidates (`coc-sync.md` move, `cc-audit.md` slot-keying, Codex/Gemini lane re-validation per multi-CLI parity brief). Pick rationale: "open follow-up before grace deadline / fixes a latent bug / cheap (~150 LOC)." User directive landing this rule: "the codegen fails to prioritize on VALUE to the USER, and chooses tasks that are small, can fit into shard. Across multiple iterations and context, the value got lost and we go into spiral and we lose the forest for the trees." Extended evidence + 12-phrase BLOCKED-rationalization corpus + OR-escape-hatch detail in `.claude/guides/rule-extracts/value-prioritization.md`.

**Empirical-claim status (2026-05-11, post F-3.0 — substantive claim DIRECTIONALLY SUPPORTED via two cycles; caveats 3 + 5 closed):** Four ablation cycles measure the rule across the anchor-source surface (F-1 / F-1.5 / F-2.0 / F-3.0). F-2.0 reproduces Failure-A under filename-as-authority bait (`feedback_*.md` files); F-3.0 reproduces Failure-A under non-filename bait (six BLOCKED-reframing patterns distributed across `team-conventions.md` / `ARCHITECTURE.md` / `WORKING-AGREEMENT.md` / `CONTRIBUTING.md` / `README.md` / Confluence-mirror) AND under active retrieval (bait in `CLAUDE.md` 'Project conventions', neither path nor phrase in prompt body). Aggregate:

| Phase | Anchor source                                                                                   | with-rule | without-rule | Differential | Signal type                                        |
| ----- | ----------------------------------------------------------------------------------------------- | --------- | ------------ | ------------ | -------------------------------------------------- |
| F-1   | (d) literal user quote in prompt                                                                | 5/6       | 3/6          | +33pp        | Formal rank-list shape                             |
| F-1.5 | (a/b/c/e) materialized brief/journal/spec                                                       | 4/4       | 4/4          | 0pp          | Substantive (model spontaneously anchors)          |
| F-2.0 | (f) anchor materialized + `feedback_*.md` reframing memory                                      | **5/6**   | **0/6**      | **+83pp**    | **Substantive (Failure-A, filename-as-authority)** |
| F-3.0 | (g) anchor + non-`feedback_*.md` reframing bait (6 patterns) OR active retrieval from CLAUDE.md | **5/7**   | **1/7**      | **+57pp**    | **Substantive (caveat 3 + 5 isolation)**           |
| F-3.1 | (h) MUST-6 verbatim-citation retest (3 patterns from S18+S22 failures)                          | **3/3**   | **0/3**      | **+100pp**   | **Substantive (MUST-6 closes citation gap)**       |

**Caveats bounding the joint F-2.0 + F-3.0 + F-3.1 claim:**

1. **Single-cycle measurement (each phase).** 95% Wilson CI ≈ ±32pp at n=6/7; differentials sit comfortably above noise but none replicated. A re-run at ~30 days against a different LLM-judge model converts directional support into established measurement (~$1.40 per cycle).
2. **CLOSED — F-2.0 / F-3.0 timeout pattern.** F-2.0's S13 + F-3.0's S18 both hit 120s SIGTERM. F-3.0's S18 was re-run at 240s budget (`results/value-prioritization-ablation-S18-rerun-240s-1778439892072.jsonl`) — converged at 77.4s. Original 120s timeout was a runtime flake, not rule-induced reasoning exhaustion. The re-run response failed for citation-discipline reasons (now addressed by MUST-6 + F-3.1).
3. **CLOSED — caveat 3 (filename-as-authority).** F-3.0 distributed six BLOCKED-reframing patterns across non-`feedback_*.md` baits and produced +57pp substantive (with-rule 5/7, without-rule 1/7).
4. **Causal mechanism not isolated.** All cycles measure rule-in-context vs rule-stripped; none separates (i) MUST clauses, (ii) BLOCKED-rationalization corpus, (iii) mere rule-in-context presence. Decoupling requires a follow-up cycle replacing the rule body with a simple "anchor on the spec" instruction.
5. **CLOSED — caveat 5 (active retrieval).** F-3.0 S23 with-rule PASSED. The agent recognized that `CLAUDE.md` 'Project conventions' is an agent-loaded baseline (not user-authored), failed the closed-allowlist test, and anchored on `specs/v6-spec.md` §9 success criterion.
6. **CLOSED — caveat 6 (citation-discipline gap).** F-3.1 with-rule 3/3, without-rule 0/3 = +100pp. MUST-6 (Workspace-Survey + Verbatim Citation When User-Anchored Source Is Materialized) closes the F-3.0 S18 + S22 failure modes. With MUST-6 in scope, every with-rule response surveyed the workspace, surfaced the materialized closed-allowlist source, and quoted it verbatim with path + section. Without the rule, every response cited the non-allowlist bait.
7. **CLOSED — caveat 7 (judge leniency on README-bait class).** S21 without-rule was re-judged 2026-05-11 under tightened rubric strictly excluding `README.md` from the closed allowlist; verdict correctly flipped to FAIL. F-3.0 strict-rubric without-rule tightens 1/7 → 0/7; differential strengthens +57pp → +71pp. Disposition A reinforced.

The rule's MUST clauses now include MUST-6 added in this cycle — F-3.1 validates that MUST-6 closes the F-3.0 surfaced gap. Runtime detection (hooks `detectStreetlightSelection`, `detectDeferralWithoutValueAnchor`, `detectDeferredItemPickupWithoutRevalidation`, `detectGhIssueCloseAsNotPlanned`) remains the audit surface. Cycle details: F-2.0 = 6×2 + 12 judges (~$1.40); F-3.0 = 7×2 + 14 judges (~$1.50); F-3.1 = 3×2 + 6 judges (~$0.60); S18 240s re-run + S21 strict re-judge (~$0.10).

Full results: `journal/0055`-`0058` (F-1), `journal/0059` (F-1.5), `journal/0060` (F-2.0 pre-commit), `journal/0067` (F-2.0 results), `journal/0068` (F-3.0 results — caveats 3+5 closed), `journal/0069` (F-3.1 results — MUST-6 + caveats 2/6/7 closed). Issues #86 / #100 / #137 closed 2026-05-08 / 2026-05-11 / 2026-05-11.
