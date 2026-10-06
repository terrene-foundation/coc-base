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

<!-- Demoted baseline → path-scoped 2026-05-09; emit-budget record: guide-extract § "Demotion to path-scoped (2026-05-09)". -->

# Value-Prioritization — Rank By User Value Before Shard-Fit

Depth companion — cited below as the **guide-extract** — is `.claude/guides/rule-extracts/value-prioritization.md`: the full BLOCKED-rationalization corpus, the Origin post-mortem, the detection fixture catalog, the OR-escape-hatch detail and the `**Why:**` evidence tails.

This rule fixes the selection-axis gap with paired structural defenses: **value-rank precedes shard-fit** at every selection event, AND **deferred items carry value-anchors that survive `/clear`** so re-pickup re-validates rather than silently inherits.

## MUST Rules

### 1. Value-Rank Precedes Shard-Fit At Every Selection Event

When the agent surfaces ≥2 candidate items for the user to pick between (next workstream, next shard, next PR follow-up, next sweep target), the agent MUST present a **value-ranked list first**, with each candidate's value rationale cited from a user-anchored source (the CLOSED ALLOWLIST bullet below enumerates the five). Shard-fit, blast radius, regression posture, and clean-scope considerations apply ONLY as tiebreakers AFTER the value-rank. Picking a low-value candidate because it fits the shard while a higher-value candidate exceeds it is BLOCKED — the higher-value candidate MUST be sharded per `autonomous-execution.md` § Per-Session Capacity Budget instead, with each shard carrying its own value-anchor (Rule 2). When the agent picks the lower-value candidate for legitimate tiebreaker reasons, the trade-off MUST be named explicitly: "Item X is higher-value per [user-anchored source]; Item Y is more fittable. Recommend Y because [specific reason]; alternative is to shard X." Silent fittability-pick is BLOCKED.

**DO:** rank multi-CLI parity HIGH from the approved brief before internal cleanup LOW; shard parity, and name the value lost if recommending cleanup. **DO NOT:** pick the cheap follow-up silently because it fits.

**BLOCKED rationalizations** (full corpus in guide-extract; institutional tells listed below):

- Fit-anchors: "fits the shard budget" / "smaller is safer" / "regression-locked is responsible" / "cheap and bounded" / "tractable in one pass" / "reviewable diff" / "atomic delivery" / "well-bounded"
- Defer-anchors: "X needs decomposition first" / "back to X next session" / "in the backlog" / "tracked separately" / "Carried-forward" / "no grace clock"
- Scope-creep tells: "Closes a latent bug while we're here" / "smallest blast radius" / "mechanical work first, strategic later"
- Proxy-for-value framings: "sequencing dependencies — A unblocks B" / "risk-adjusted value: smaller scope = higher delivery probability" / "velocity multiplier — small wins unlock the bigger work" / "optionality preservation — pick reversible work first" / "reduce coordination cost" / "dependency-of-the-dependency enables the high-value work"
- Pick-anchor euphemisms: "Best path forward" / "Pragmatic call" / "Leaning toward" / "Default is to take" / "Will start with"
- Authority misappropriations: "User implicitly preferred this in the prior session" / "prior-acceptance as anchor" / "user obviously wants the safe path"
- **Time-pressure-as-authority is BLOCKED**: citing `time-pressure-discipline.md` as authority to pick low-value-fittable is BLOCKED. Time-pressure framing triggers PARALLELIZATION of value-ranked candidates per `time-pressure-discipline.md` MUST Rule 1, NOT downgrade to fittable.
- **User-anchored sources are a CLOSED ALLOWLIST** (per `rules/cc-artifacts.md` Rule 10 — positive allowlist, not denylist): the ONLY valid sources are (a) user's brief in this session, (b) `briefs/` in active workspace, (c) journal `DECISION-` entries, (d) literal user quote in this session's transcript, (e) spec § success criterion the user authored or approved. **Citations NOT matching {a, b, c, d, e} are BLOCKED for primary value-rank, regardless of phrasing.** Common evasion patterns — illustrative, not exhaustive: prior-session acceptance, retroactive inference, "the user obviously wants," unstated-but-implied preferences, "per institutional precedent," "per the workflow's recurring pattern," "per CLAUDE.md context," "per the standing memory," "per the spec's implicit guidance," "per the rule's intent," "per the team's working agreement," "per established convention," "per the platform's charter," "per the architectural principles," "per repo-internal precedent," "per the SDK's design intent."

**Why:** Without an explicit value-rank axis, the agent's selection function defaults to whichever candidate has the most _legible_ signal — small-fittable-regression-locked produces the most legible signal because each quality axis is mechanically gradable. User-value is harder to grade but it IS the axis the user actually cares about. The "Carried-forward (no grace clock)" institutional tell: guide-extract § "`**Why:**` evidence tails".

### 2. Deferred Shards MUST Carry Value-Anchors That Survive `/clear`

When a workstream is decomposed AND some shards are scheduled for later sessions (workspace todos, GH follow-up issues, README "follow-up" bullets, journal DEFER entries, "Carried-forward" lines in `.session-notes`), EACH deferred shard MUST be filed with a **value-anchor** — one sentence stating WHY THIS SHARD DELIVERS VALUE TO THE USER, in the user's language, citing a Rule-1 user-anchored source. Filing with only technical rationale (LOC count, dependency graph, "fits next shard") is BLOCKED. Filing under "Carried-forward (no grace clock)" without a value-anchor is BLOCKED.

**DO:** file Shard 2 with "delivers multi-CLI parity per brief §9.2", dependencies, and a re-validation gate. **DO NOT:** file only "~700 LOC, next session" or an unanchored "Carried-forward".

**BLOCKED rationalizations:** "Value rationale is obvious" / "Add value-anchor at re-pickup" / "Original brief covers it" / "Adding value-anchors to every deferral is bureaucracy" / "Technical rationale IS the value rationale" / "No-grace-clock means low-priority; anchor not needed" / "It's a Carried-forward item, that's the bucket."

**BLOCKED reframings** — deferral euphemisms that route around "Carried-forward" / "tracked separately": "Phase II/N scope," "Beta milestone," any "v<N> scope" without value-anchor, "future iteration," "architectural follow-up," "out of MVP/v1," "post-launch," "wishlist," "stretch goal," "nice-to-have," "roadmap item," "Tier-2 / P2 priority," "below the cut-line," "beyond current scope." All carry the same effect as "Carried-forward (no grace clock)" — they remove the item from the agent's queue without recording user-stated value-decay. Each MUST carry an adjacent value-anchor citing a MUST-1 user-anchored source. The list above IS the complete enumeration.

**State-claim anchors pin a commit SHA + timestamp.** When a value-anchor's rationale rests on a CURRENT-STATE claim about the codebase, the anchor MUST pin that claim to a commit SHA + timestamp. The `git log` re-validation mechanic and the journal-0171 stale-premise incident: guide-extract § "State-claim anchors".

**Why:** Deferred items lose their context by definition — the next session reads `.session-notes` / GH issues / journal entries WITHOUT the conversational context that produced them. The technical rationale survives the boundary; the value rationale evaporates unless explicitly recorded. Evidence (2026-04-23 loom Phase I1 reframing): guide-extract § "`**Why:**` evidence tails".

### 3. Re-Pickup Of Deferred Work MUST Re-Validate The Value-Anchor

At the start of any session that picks up a deferred item (workspace todo, GH follow-up issue, journal DEFER entry, "Carried-forward" line), the agent MUST re-validate the value-anchor BEFORE resuming. If recorded, surface it and ask "is this still your value?" If NOT recorded (deferral predates this rule, or Rule 2 was violated), the agent MUST surface "this deferred item lacks a value-anchor — what's its current value to you?" rather than picking it up on faith. Silent inheritance across `/clear` boundaries is BLOCKED. Items deferred ≥2 sessions ago without re-pickup MUST surface a "still wanted?" gate at the next `/sweep` or `/wrapup`.

**DO:** surface the recorded parity anchor and confirm it still applies before resuming. **DO NOT:** resume from only the previous technical step.

**BLOCKED rationalizations:** "Revalidation is overhead for short-window deferrals" / "Deferral was N days ago, value can't have decayed" / "User already approved this once" / "Auto-resume from `.session-notes` is the documented path" / "If value had decayed, user would have said so."

**Why:** Per `rules/zero-tolerance.md` Rule 1c, claims about session-boundary state are unfalsifiable after `/clear` / auto-compaction — the same epistemic shape applies to deferral status. The agent has no audit trail proving the user still wants the deferred item; absent that, the disposition under uncertainty is to ask, not to assume.

### 4. Closure Of Value-Bearing Deferred Work As "Not Planned" Requires User Gate

A GH issue, workspace todo, or journal DEFER entry that carries a value-anchor (Rule 2) MUST NOT be closed as `not_planned`, `wontfix`, "deferred indefinitely," or "out of scope" without explicit user approval IN THE SAME SESSION. The agent MAY recommend closure with a value-decay rationale ("user's brief moved on" / "work landed elsewhere via PR #N" / "dependency was removed"); the user MUST accept. Auto-closure of value-bearing work — even when "stale ≥30 days" — is BLOCKED. Stale-triage automation that closes by age rather than by value-decay is BLOCKED. Reframing as "downstream responsibility" / "out-of-scope" without a user gate is closure under another name and is also BLOCKED. Red-team / sweep OR-escape-hatch recommendations ("Add todos for X **OR** an explicit ADR statement that X is part of Y") are a special case. Recommendations MUST commit to one disposition: implement, ADR with user-gated value-decay, or close with user gate.

**DO:** explain that PR #271 delivered the anchored value and obtain same-session approval before closing. **DO NOT:** close by age, reframe as downstream responsibility, or offer an implement-OR-ADR escape.

**BLOCKED rationalizations:** "Open 30+ days, time to close" / "Value rationale is stale anyway" / "Cleaning up the backlog" / "User can re-open if they care" / "Closing as not-planned is a soft signal, not hard delete" / "Stale-triage policy says ≥30 days closes" / "Reframing isn't closure" / "OR gives the team flexibility" / "Both OR options resolve the finding."

**BLOCKED OR-escape-hatch variants** — the ONLY legitimate dispositions are (1) implement now with value-anchored shards, (2) ADR with user-gated value-decay, (3) close with user gate. ANY OR-disposition that introduces a fourth option is BLOCKED regardless of framing: "Add X OR file follow-up issue / OR document as known limitation / OR mark as deferred-with-rationale / OR capture in roadmap / OR create observability / OR add a smoke test asserting current behavior / OR add to /redteam checklist / Implement-OR-spec-only / Code-OR-doc / Fix-OR-monitor." Full enumeration in guide-extract.

**Why:** The user's value rationale is the load-bearing claim that the work matters. Closing without re-validating is the terminal step in deferral-as-forgetting. The user gate is the only mechanism that catches value-still-applies before closure becomes institutional fact. Evidence (Failure-A audit 2026-05-07, 7-of-7 decay-not-pickup): guide-extract § "`**Why:**` evidence tails".

### 5. Brief / User-Stated Value Is The Primary Anchor; Code-Health Is Secondary

Value-ranking MUST cite a primary source from Rule 1's user-anchored list. Code-health axes (test coverage, blast radius, regression posture, technical debt, audit findings) are SECONDARY anchors — they belong as cons under a primary-ranked option, not as primary-rank justification. Ranking by code-health alone with no user-anchored citation is BLOCKED. Citing a prior user-feedback memory (`feedback_*.md`) as standalone authority to drop work is BLOCKED — memories codify HOW preferences (`feedback_no_resource_planning.md`, `feedback_directive_recommendations.md`); they do NOT codify which workstreams the user wants delivered.

**DO:** rank parity from the user's "deliver multi-CLI codegen" brief; use drift and regression risk as secondary considerations. **DO NOT:** rank a small crash fix first solely on code health or a `feedback_*.md` memory.

**BLOCKED rationalizations:** "Code health IS user value" / "User obviously wants the safe path" / "Blast radius reduction IS what the user is paying for" / "Test coverage is the user's actual interest" / "Reliability work is always high-value" / "Closing audit findings is the user's stated preference" (when it isn't) / "Per `feedback_X.md` we don't do this kind of work."

**BLOCKED `/autonomize`-as-authority rationalizations** — `/autonomize` is a HOW directive; it does NOT transmute a MUST-5-blocked pick into an authorized one, and it is NOT a user-anchored source per Rule 1's closed allowlist. Three phrases use it as authority-transmuter against MUST-5:

- "/autonomize covers technical picks within a disposition shape"
- "the WHAT was determined; only HOW remains (under /autonomize)"
- "structural axes plus /autonomize-authority equal a primary anchor"

The directive quoted in full: guide-extract § "`/autonomize` as authority-transmuter". For closure-class picks lacking an allowlist primary anchor, `/autonomize` MUST defer per MUST-5; surfacing the missing evidence + requesting specific confirmation IS the optimal pick under `/autonomize` itself.

**Why:** Code-health axes are LEGITIMATELY important — but they're the agent's professional concerns, not the user's. When code health becomes the primary rank, the agent has effectively re-briefed itself; the user's brief becomes secondary. The memory-conflation half, the `/autonomize`-as-authority half (a HOW-directive cited as a WHAT-anchor), and the 2026-05-09 W3-4 evidence: guide-extract § "`**Why:**` evidence tails".

### 6. Workspace-Survey + Verbatim Citation When User-Anchored Source Is Materialized

When the agent is operating in a workspace that MAY contain materialized closed-allowlist sources (any workspace with `briefs/`, `journal/`, `specs/`, or root-level `BRIEF.md`), the agent MUST (a) survey those locations for matching content BEFORE committing to a pick, AND (b) cite any matching source by **path + section + verbatim sentence**. "No user-anchored source exists" without a workspace survey is BLOCKED. Paraphrase, "described elsewhere in the workspace", or "weak anchor" admission is BLOCKED when the materialized source IS present and surface-able. The agent's failure to surface a materialized anchor structurally converts a rule-compliant pick into a citation-failure that downstream sessions (per MUST-3) cannot re-validate.

**DO:** survey `specs/v6-spec.md`, cite §9.2 step 23 and its verbatim sentence "Zero exceptions; partial sweeps explicitly rejected." **DO NOT:** claim "no anchor", paraphrase, or say "described elsewhere" when the source is materialized.

**BLOCKED rationalizations:**

- "The materialized source is implied — the user wouldn't need a verbatim cite"
- "Path + section is enough — quoting the sentence is redundant"
- "I read the spec but didn't quote it because the user already knows what's there"
- "No user-anchored source exists" (when source is materialized at a discoverable path)
- "The anchor is weak but the pick is correct"
- "Workspace survey is /redteam's job, not /implement's"
- "I'll add the verbatim cite at re-pickup time"

**Why:** Downstream re-pickup (MUST-3) requires the anchor to be _locatable_ by a future session — not just "structurally honored by this session's agent." A paraphrase or "described elsewhere" framing makes the anchor un-re-derivable. The two F-3.0 scenarios (S18 + S22) that reproduced this gap: guide-extract § "`**Why:**` evidence tails".

### 7. Deprioritising A Work CLASS On Throughput Grounds Requires Measuring Its Critical-Path Share First

MUST-1..6 rank WITHIN a work set; this governs the decision to EXCLUDE a whole class from it. Before deprioritising, holding, or deferring an entire CLASS of work on throughput grounds ("X takes too long"), the agent MUST measure that class's ACTUAL share of the critical path — its share of commits/LOC, and whether its lane runs in PARALLEL with the critical lane or serially ahead of it — and state that measurement inline BEFORE the disposition. **Felt cost is not measured cost.** A hold whose measured saving is ~0 is BLOCKED; so is one that breaks a release gate or leaves a known defect live to buy a ~0 saving, **regardless of who proposed it** — surfacing the measurement to the requester is the required response, not silent compliance. When the directive REVERSES a documented prior decision, surface that decision (date + location) BEFORE codifying over it.

**Why:** The intuition "X takes a long time" forms from the most recent painful instance, not the distribution. DO/DO-NOT + BLOCKED corpus + the measured cost split: guide-extract.

## MUST NOT

- Use "no grace clock" as a downgrade signal

**Why:** A grace clock is an artificial deadline tied to a recently-authored rule; its absence does NOT indicate low value.

- Treat decomposition pressure as a deferral signal

**Why:** When a high-value candidate exceeds the shard budget per `autonomous-execution.md` MUST Rule 1, the disposition is to DECOMPOSE (with value-anchored shards per Rule 2), not to DEFER and pick a smaller fittable item.

- Frame fittability-pick as the only candidate

**Why:** Hiding the candidate set inverts the user's structural ability to override (Rule 1 named-trade-off requirement).

Depth — the Trust-Posture Wiring, the rule-graph cross-references and the Origin record — lives in `.claude/skills/32-trust-posture/wiring/value-prioritization.md`, which every validator reads as part of this rule.
