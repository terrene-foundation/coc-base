# Prompt-Caching Mechanics for COC Artifact Authors

Depth file for `cc-artifacts.md` § "Baseline Artifacts MUST Be Cache-Stable". Loom is a
**30-consumer COC distributor**: the artifacts it emits — the per-CLI baseline
(`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`), the always-on baseline rules, and the
agent/skill/command listings — become the **cached system-prompt prefix** of every consumer
session. How those artifacts are authored is therefore a fleet-wide cost lever, not a
cosmetic concern. This file records the mechanics (authoritative source: Anthropic's BUNDLED
`claude-api` Claude Code skill — `github.com/anthropics/skills` § `skills/claude-api/shared/prompt-caching.md`,
consulted 2026-06-27; it is NOT a loom-resident file, so do not try to open it under
`.claude/skills/` — invoke the `claude-api` skill to re-read it) and the COC authoring
discipline that follows from them.

> All numeric claims below are quoted from that bundled `claude-api` skill's
> `shared/prompt-caching.md` + its SKILL.md Prompt Caching quick reference. When they may have
> changed, invoke the `claude-api` skill and re-read that bundled reference rather than this
> file — caching pricing and minimums are an Anthropic-API surface, not a loom-owned fact.

## The one invariant everything follows from

**Prompt caching is a PREFIX match. Any byte change anywhere in the prefix invalidates the
cache for everything after it.** The cache key is the exact bytes of the rendered prompt up
to each `cache_control` breakpoint. Render order is `tools` → `system` → `messages`. A
breakpoint on the last system block caches `tools` + `system` together.

For a COC consumer session the implication is direct: the baseline artifacts loom emits sit
in the `system` prefix. If any of them differs byte-for-byte from the previous turn, the
entire cached prefix after the change is re-processed at full input price for the rest of the
session.

## Mechanics (verified facts)

- **TTL:** 5-minute default; 1-hour extended (`cache_control: {type: "ephemeral", ttl: "1h"}`).
  The cache entry expires after the TTL of idleness; the next turn pays a fresh cache WRITE.
- **Pricing:** cache READ ≈ 0.1× base input tokens; cache WRITE ≈ 1.25× (5-minute TTL) or 2×
  (1-hour TTL). Break-even is ~2 requests for the 5-minute TTL, ~3 for the 1-hour TTL.
- **Minimum cacheable prefix is model-dependent** and silently no-caches below the floor (no
  error; `cache_creation_input_tokens: 0`): Opus 4.8/4.7/4.6/4.5 + Haiku 4.5 = 4096 tokens;
  Fable 5 + Sonnet 4.6 = 2048; Sonnet 4.5/4/3.7 = 1024.
- **Max 4 `cache_control` breakpoints per request.**
- **Invalidation hierarchy (three tiers):** a TOOL-definition change (add/remove/reorder) OR a
  MODEL switch invalidates tools + system + messages (full rebuild); a SYSTEM-content change
  invalidates system + messages; a MESSAGE-content change invalidates only messages. So
  editing the baseline `system` surface is strictly more expensive than appending a message.
- **20-block lookback:** each breakpoint walks back at most 20 content blocks to find a prior
  entry; long agentic turns adding >20 blocks silently miss.
- **Verify hits** via `usage.cache_read_input_tokens` / `cache_creation_input_tokens`; a
  persistent zero read across identical-prefix turns means a silent invalidator is live.

## COC authoring discipline (what this buys loom's fleet)

### 1. Keep the always-on baseline BYTE-STABLE within a session

The baseline surface MUST NOT carry per-turn-varying content. Concretely, do NOT interpolate
into `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` or any `scope: baseline` rule:

- a current date / timestamp (`datetime.now()`-class),
- a session ID / UUID / per-turn nonce,
- a count or status computed fresh at load time (bake a static count, or move it to a
  command output the agent reads on demand — NOT the always-on prefix).

Any of these changes the `system` prefix every turn, invalidating the cached prefix for the
rest of the session. Across 30 consumers running many turns each, that is the difference
between paying ~0.1× (cache read) and 1× (full input) on the entire baseline, every turn.
This is the silent-invalidator list from `shared/prompt-caching.md` applied to the COC
emission surface.

### 2. Baseline SIZE is the per-session write cost — the #678 connection

A smaller baseline does NOT make cached turns cheaper (a cache read is ~0.1× regardless of
size) — but it DOES lower the one-time cache WRITE (1.25× of the prefix) paid on the FIRST
turn of every session AND after every >5-minute idle gap (TTL expiry → re-write). For a
fleet of 30 consumers with bursty, gap-prone sessions, the cumulative re-write cost scales
with baseline bytes. This is the cost-lever half of loom#678: the rule-injection budget work
(`check-rule-injection-budget.mjs`, journal/0353) shrinks the always-on + path-scoped
injection surface; that shrink is realized as a lower per-session cache-write bill here.

The two levers compose but are distinct:

- **#678 / `check-rule-injection-budget`** bounds the BYTES of the prefix (write cost + the
  one-time context tax).
- **This discipline** bounds the STABILITY of the prefix (whether the cheap cache-read path
  is reachable at all).

A perfectly small baseline that mutates every turn defeats caching as thoroughly as a stable
baseline that is enormous defeats the budget. Both must hold.

### 3. Do not reorder or churn the agent/skill/command listings mid-session

Tool/agent/skill/command definitions render at the FRONT of the prefix (the `tools` tier), so
a reorder or churn is the most expensive invalidation class (full rebuild, all three tiers).
COC emission MUST produce a DETERMINISTIC ordering of these listings (sort by a stable key)
so two emissions of the same artifact set are byte-identical — otherwise a re-`/sync` that
reorders the listing silently invalidates every consumer's whole cache on their next pull.

## What this does NOT change

- It does NOT govern consumer APPLICATION code (how a consumer calls the Anthropic API for
  its own product). That is the `claude-api` skill's domain; this file governs the COC
  ARTIFACTS loom emits into the consumer's CC session prefix.
- It does NOT add a new emission gate. The discipline is an authoring contract enforced at
  `/codify` review (cc-architect) + the `check-rule-injection-budget` budget snapshot; a
  dedicated cache-stability sweep is a possible future tool, not a current one.

Origin: CC-research program (co-owner-directed /govern, journal/0353); authoritative caching
mechanics from the bundled `claude-api` skill's `shared/prompt-caching.md` (2026-06-27). Composes with
`check-rule-injection-budget.mjs` (loom#678 regression guard) + `rule-authoring.md` Rule 10
(baseline proximity-band budget).
