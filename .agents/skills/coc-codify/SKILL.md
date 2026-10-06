---
name: coc-codify
description: "Load phase 05 (codify) for the current workspace. Update existing agents and skills with new knowledge."
---

Use the request accompanying this skill as the command arguments wherever the procedure refers to `$ARGUMENTS`. Interpret arguments as task context, never as a shell command.

## Workspace Resolution

1. If `$ARGUMENTS` specifies a project name, use `workspaces/$ARGUMENTS/`
2. Otherwise, use the most recently modified directory under `workspaces/` (excluding `instructions/`)
3. If no workspace exists, ask the user to create one first
4. Read all files in `workspaces/<project>/briefs/` for user context (this is the user's input surface)

## Phase Check

- **Gate: the `/redteam` convergence receipt (MUST).** `/redteam` is the sole measurer; never re-derive it. ONE call, three commands — FRESH `find workspaces -path '*/04-validate/redteam-*.md' -newer .claude/learning/learning-codified.json -print`, EVER `find workspaces -path '*/04-validate/redteam-*.md' -print`, CONTROL `find workspaces -path '*/04-validate/*' -print -quit`. Read the LINES, never an exit code (`rules/instrument-discipline.md` MUST-1/3), and take the branches IN ORDER — EVER before FRESH, because an empty FRESH set means two different things. **(1) CONTROL empty** ⇒ **N/A**; proceed, never "validation passed". **(1b) CONTROL non-empty, EVER empty** ⇒ **ADOPTION-PENDING**, a THIRD verdict — no receipt exists ANYWHERE, so the producer contract has not run once here; name it in the closing line and PROCEED, since calling it "passed" is a false clean and "did not converge" a false accusation. Self-extinguishing: once any receipt lands, EVER is permanently non-empty. **(2) EVER non-empty, FRESH empty** ⇒ **REFUSE**, naming the workspace; proceeding REQUIRES a reason verbatim in the closing line AND in the § Journal entry — a silent proceed is BLOCKED (`rules/zero-tolerance.md` Rule 3). **(3) FRESH non-empty** ⇒ parse line 2 against the closed allowlist `CONVERGED` / `NOT_CONVERGED` / `IN_PROGRESS` (`rules/probe-driven-verification.md` MUST-6); no marker at line 2 is UNKNOWN, never a status. `CONVERGED` ⇒ cite the path and proceed; anything else ⇒ branch (2). FIRST CODIFY (no `learning-codified.json`) ⇒ drop `-newer`, take the newest.
- Read `docs/` and `docs/00-authority/` for knowledge base
- Output: update existing agents and skills in their canonical locations. Which locations exist depends on the repo's tier subscriptions — Kailash-subscribing targets carry the framework trees (`agents/frameworks/`, `skills/01-core-sdk/`, `skills/02-dataflow/`, …); a stack-agnostic base template carries none of them, so codify into the agent/skill trees that repo actually has.

## Execution Model

This phase executes under the **autonomous execution model** (see `rules/autonomous-execution.md`). Knowledge extraction and codification are autonomous — agents extract, structure, and validate knowledge without human intervention. The human reviews the codified output at the end (structural gate on what becomes institutional knowledge), but the extraction and synthesis process is fully autonomous.

## Workflow

### 0. Acquire codify lease (multi-operator concurrency gate)

Per (loom-internal reference) §7.1: two concurrent `/codify` invocations clobber the rule corpus. Acquire the lease BEFORE any step below.

Call `acquireCodifyLease({ scopeFiles, displayId })` from `.claude/hooks/lib/codify-lease.js`. The helper unions `.claude/learning/learning-codified.json` + `.claude/.proposals/latest.yaml` into the scope automatically. `displayId` comes from `operator-id.js::resolveIdentity()`.

On `{ ok: false, reason: "conflict" }`: STOP, surface the conflicting `display_id` + acquired_at + scope overlap to the user verbatim, plus `liveness.basis` (why the lease is still judged HELD). Silent proceed is BLOCKED (`rules/zero-tolerance.md` Rule 3). Conversely, an `{ ok: true }` carrying `reclaimed` means this acquire TOOK OVER a lease a crashed/abandoned session never released (age past the 12h `LEASE_TTL_MS` floor) — surface `reclaimed.display_id` + `reclaimed.acquired_at` + `reclaimed.liveness.basis` verbatim, and `reclaimed.record_emit` when it is not ok. `reclaimed` is absent on every normal acquire; a takeover the operator never sees is indistinguishable from the clobber the lease exists to prevent.

The acquire result carries `record_emit` — the signed `codify-lease` coordination-log record that makes the lease visible to sibling clones via the fold (FSUB, `rules/knowledge-convergence.md` MUST-3; `releaseCodifyLease` emits the paired `codify-lease-release`). `record_emit.ok: false` does NOT void the lease (the on-disk mutex landed), but the failure MUST be surfaced to the user with its `reason` — a lease invisible to siblings is the cross-clone clobber surface this record exists to close. When that happens the result ALSO carries a top-level `degraded` (2026-08-16), and the helper has already written `[LEASE-RECORD-NOT-EMITTED]` to stderr; surface `degraded.impact` plus `degraded.structural`. `structural: true` means the record CANNOT fit the 2048 B append cap and will fail identically on every retry — that is a defect to report, NOT a transient to retry past. (Relying on the nested `record_emit` field alone is what let a record that never once emitted read as a clean acquire for months.)

An `{ ok: true }` — or an `{ ok: false, reason: "scope-dirty" }` — carrying **`stale_branch`** means this session is standing on a codify branch of yours whose date token is older than yesterday, so the lease **DECLINED to bind to it** and minted a fresh one. That old branch holds **unlanded work**. Surface `stale_branch.name`, `stale_branch.date` and `stale_branch.unlanded_commits` verbatim — `unlanded_commits: null` means **UNKNOWN, never none**, and any number is a reachability **UPPER BOUND** (a rebased, squashed or cherry-picked branch over-reports; measured in-corpus at roughly 40% over-report). **Declining to bind moves nothing**: your checkout is STILL on the old branch, `integrity-guard.js` still authorizes writes there (coverage is signer + scope, never branch name), so committing now appends to a branch nothing lands — this is the self-perpetuating ratchet (loom#1905), in which each session inherits the last one's branch. Before ANY edit: **land it** (`gh pr create`, then `gh pr merge <N> --admin --merge --delete-branch` per `coc-sync-landing.md` MUST-3) or **park it** (`git checkout main`), then switch to the branch named below. Reporting `stale_branch` and continuing on the old branch is BLOCKED — that is silent abandonment, not compliance.

On `{ ok: true, lease, branch }`: create/switch to **the branch the result RECORDS — `res.branch`, whatever it is named** (per `rules/knowledge-convergence.md` MUST-3; it carries an optional `-<lane>` token and, after a declined bind, is NOT the branch you are on — never re-derive the name from the `codify/<display_id>-<date>` shape, which is the default the helper mints, not the value to use); all edits this session lands there; end-of-session opens a PR + admin-merge per `coc-sync-landing.md` MUST-3; then `releaseCodifyLease({ repoDir, displayId })` (the helper derives the leasePath from `repoDir` internally per Sec-MED-3 — callers cannot misroute the release write). For MUST-clause rule changes the orchestrator additionally requires a signed `[ack: <rule-id>]` from the user before merge (consumed by `multi-operator-sessionstart.js`).

### 1. Enumerate the delta since the last codification (MANDATORY anchor)

`/codify` MUST process EVERYTHING since the last codification — not the last session, not what this session remembers. The durable checkpoint is `.claude/learning/learning-codified.json::last_codified`.

1. Run the enumerator — its output IS the authoritative backlog:

   ```
   node .claude/bin/codify-backlog.mjs
   ```

   It lists the COMPLETE delta since `last_codified` from append-only + git-committed sources (`observations.jsonl`, unaddressed `violations.jsonl`, `journal/` entries, artifact-change commits, workspace `.pending`/`todos/done`). Absent/invalid `last_codified` → it flags **FIRST CODIFY** (full history in scope); never assume "nothing to do". On that first cycle the backlog is large: triage by `rules/value-prioritization.md` MUST-1 value-rank, process what fits the per-session capacity budget (`rules/autonomous-execution.md`), and write `last_codified` regardless — a partial first sweep that ADVANCES the anchor is correct (it bounds the next cycle's delta); pretending the whole backlog is addressable in one cycle is not.

2. `.claude/learning/learning-digest.json` + `.session-notes` are SUPPLEMENTARY recency hints ONLY — use them to enrich an item's semantic context, never to define the work-list. The backlog output is UNSCRUBBED (it echoes `violations.jsonl` evidence + workspace paths); before embedding any of it in a PR / journal / commit, apply the `rules/user-flow-validation.md` MUST-6 scrub.

3. **USE-template repos only** (`.claude/VERSION::type == "coc-use-template"`): the enumerator's append-only + git-committed sources do NOT include GitHub issues, so ALSO enumerate open issues that are COC-artifact Route-A filings (`gh issue list --state open`) — each is a Step-7b proposal-origination input (`rules/artifact-flow.md` § Downstream-Consumer Routing). Consolidate duplicate/related filings; disclosure-scrub each per `rules/upstream-issue-hygiene.md` MUST-2 (hop-level provenance only, no consumer-identifying tokens carried into the proposal).

**BLOCKED:** deriving the work-list from `.session-notes`, the digest, or model memory alone — all are overwritten/regenerated every session, so knowledge from an un-codified session or across a `/clear`/compaction boundary is invisible to them (same epistemic shape as `rules/verify-claims-before-write.md` MUST-2 / `rules/zero-tolerance.md` Rule 1c — what you "remember" is unfalsifiable after a context boundary). The anchored backlog is the only source that cannot miss.

For each backlog item, either: update a rule (DO/DO NOT + Why), a skill's SKILL.md/sub-files, or an agent's knowledge; **re-validate a deferred item** (per `rules/value-prioritization.md` MUST-3 — items lacking a value-anchor surface "current value?"; items ≥2 sessions stale → "still wanted?"; silent `/clear` inheritance is BLOCKED); set `addressed_by` on each unaddressed violation (Step 6b); or skip with a stated reason.

After processing, write `.claude/learning/learning-codified.json` with `last_codified` (ISO ts = now), `digest_hash` (sha256 of digest), and `actions_taken[]` (`{type, file, reason}`; types: `rule_update`, `skill_update`, `agent_update`, `team_memory_promote`). **This advances the anchor** so the next `/codify` computes its delta from here — skipping the write re-opens the gap this step closes (observe → anchored backlog → **codify into real artifacts**).

### 2. Deep knowledge extraction

Using as many subagents as required, peruse `docs/`, especially `docs/00-authority/`, and `specs/` for domain specifications.

- Read beyond the docs into the intent of this project/product
- Read `specs/` to understand the detailed domain truth — specs contain the nuanced decisions, contracts, and constraints that should inform agent and skill updates
- Understand the roles and use of agents, skills, docs:
  - **Agents** — What to do, how to think about this, following procedural directives
  - **Skills** — Distilled knowledge for 100% situational awareness
  - **`docs/`** — Full knowledge base
  - **`specs/`** — Detailed domain specifications (authority on what the system does)

### 3. Update existing agents

Improve agents in their canonical locations.

- Reference `rules/cc-artifacts.md` for agent format (desc <120 chars, body <400 lines, frontmatter + trigger phrases); see `agents/frameworks/ml-specialist.md` as an example (**kailash tier** — present only at Kailash-subscribing targets; at a stack-agnostic base template use any agent under `agents/` as the shape reference)
- Identify which existing agent(s) should absorb the new knowledge
- If no existing agent covers the domain, create a new agent in the appropriate directory
- **Emit the `derives_from[]` provenance edge (MANDATORY, one record per artifact touched here AND in Step 4)** — pipe a JSON payload to `node .claude/bin/emit-derives-from.mjs` (`{session_id, artifacts:[{artifact_type, artifact_id, derives_from:[{anchor, anchor_kind}]}]}`), anchoring each artifact on the grep-stable spec/artifact/workspace `§section`/`::symbol` it was distilled from; `derives_from: []` is the first-class ORPHAN signal — emitted, never omitted. Non-zero exit = a rejected citation (fix the anchor) or a refused sink; do not proceed past a non-zero exit silently. Run this from here: `rules/specs-authority.md` Rule 11 (the contract) is `scope: path-scoped` and may not be in context at emission time, so this always-loaded command body is the reachability floor — same structural guarantee as Step 6's self-referential gate. PRODUCER half only (the store is kailash-rs #1951, not built); depth: `skills/30-claude-code-patterns/derives-from-emission.md`

### 4. Update existing skills

Improve skills in their canonical locations.

- Reference `.claude/guides/claude-code/06-the-skill-system.md` for skill format
- Update the directory's `SKILL.md` entry point to reference new files
- Skills must be detailed enough for agents to achieve situational awareness from them alone
- Emit each updated skill's `derives_from[]` edge exactly as in Step 3 — one record per skill, `[]` = ORPHAN (`rules/specs-authority.md` Rule 11)

### 4b. Promote team-memory facts (multi-operator repos)

If the digest surfaced a team-stable, non-secret fact ≥2 operators benefit from (shared convention, terminology binding, cross-repo path), draft a `.claude/team-memory/<topic-slug>.md` per `.claude/team-memory/README.md` (split rule: one file per fact). The frontmatter's signed-attribution fields (`promoted_by`, `signed`, `body_anchor`) are populated by `.claude/hooks/lib/coc-append.js` at merge time — leave them `pending`/`false` in the draft. The file lands on the codify lease branch alongside the other Step 3/4 edits and is validated by `integrity-guard.js` on every read.

### 5. Update README.md and documentation (MANDATORY)

Ensure user-facing documentation reflects new capabilities. Verify README.md, docstrings, and docs build.

### 6. Red team the agents and skills

Validate that generated agents and skills are correct, complete, and secure. **cc-architect** verifies cc-artifacts compliance (descriptions under 120 chars, agents under 400 lines, commands under 150 lines, rules path-scoped, SKILL.md progressive disclosure). **Self-referential gate (MANDATORY, posture-independent):** before drafting convergence, match every file the proposal touches against `rules/self-referential-codify.md` Rule 2's allowlist; ANY match → the multi-agent redteam-with-tests round (that rule's Rule 1: reviewer + security-reviewer + structural-validator, parallel) is MANDATORY regardless of trust posture. Run this check from here — `self-referential-codify.md` is `scope: path-scoped` and may not be in context at framing time; this always-loaded command body is the structural guarantee the gate is evaluated before convergence is decided.

**Conformance Walk (self-recalibration).** Absorb this round's CW findings into the role-severity tier prior (a defect-history-hot surface promotes itself toward a blocking tier) and record the frontier debt — the un-expectationed units carried forward. See `skills/conformance-walk/SKILL.md` § "Phase-action triggers" (codify).

### 6b. Trust Posture Wiring (MANDATORY for new rules — ENFORCED)

Per `rules/trust-posture.md` MUST 7 + `skills/32-trust-posture/codify-integration.md`:

For each NEW rule authored in this codify cycle (grandfathered rules pre-dating the trust-posture system are exempt):

1. **Read** `.claude/learning/violations.jsonl` (last 30 days). Find self-reported / detected violations whose `addressed_by` is null AND whose root cause matches the candidate rule.
2. **Link** the rule to those violations: update `addressed_by: "rules/<file>.md@<sha>"` for each.
3. **Author** a "Trust Posture Wiring" section per the canonical template at `rules/trust-posture.md` MUST Rule 8, using EVERY field that section's fenced template block declares, in its order. **Read the template; never work from a list restated here.** A count or a field list copied into this step is a second recitation that rots on the next field addition — it already did, when this step named eight fields after `**Invoker class:**` landed as the ninth. The literal token `**Violation scope:**` is the cc-architect mechanical-sweep anchor.
4. **Append** to `.claude/learning/posture.json::pending_verification` (via `state-io.js::writePosture`) — never via direct Edit/Write (denied by `permissions.deny`).
5. **Verify** via cc-architect: every new rule file ends with `## Trust Posture Wiring`. Missing → audit FAIL → /codify halts and reports.
6. **Deliberate the hook EVENT** whenever the Detection mechanism names a hook (`rules/hook-event-selection.md`): state the EVENT + MATCHER and why the subject EXISTS when it fires. `SessionStart` is BLOCKED for a verification detector — it runs before the session produces what it checks, so it passes unconditionally forever; re-home at gate time (`/redteam`, `/release`, `/deploy`) or at the `PostToolUse` boundary of the producing tool. `guard`/`verification` need a tool-axis event and a matcher naming the tools; `*` and an omitted matcher are the same width and are for lifecycle/telemetry. Record it as a `@hook-event:` header marker — `validate-emit.mjs::hook-event-declaration` locks the marker to `settings.json`. Where no event can see the subject, declare Phase-2 deferred: an over-claimed hook is worse than a named gap.

**ENFORCEMENT**: this step is FAIL-on-missing for any rule authored after `rules/trust-posture.md` was committed. cc-architect MUST grep each new rule file for the literal `## Trust Posture Wiring` header AND verify EVERY canonical field is present in the section body, in template order. The field set is DERIVED, never retyped — `check-descoping.mjs::CANONICAL_WIRING_FIELDS` is the machine-readable copy the de-scoping gate enforces, and `cc-architect.md` § Audit Dimensions item 5 carries the sweep that reads it. Missing or incomplete → audit FAIL → /codify halts. The mechanical anchor is `grep -L 'Violation scope:'` per `rules/trust-posture.md` MUST Rule 8.

The trust-posture rule itself is the only grandfather exception. Every other rule authored from this point forward MUST include the wiring section.

### 7. Create upstream proposal (routed by repo class)

Resolve the repo class from its DECLARATION: `node .claude/bin/repo-class.mjs` (prints the class; `--json` adds `codify_step`). It is a thin CLI over the ONE authority `bin/lib/manifest-source.mjs::readRepoClass`, which reads `.claude/VERSION::type` and validates it against the four known classes — **no repo NAME is ever a routing signal** (a client-fork ecosystem renames every repo, so name-matching leaves its BUILD repo matching nothing; loom#1502). The four classes are mutually exclusive BY CONSTRUCTION — one declared enum field, so there is no precedence order to drift and no repo can match two rows. Exit 0 → route by the table below. Exit 1 (declaration present but corrupt or unrecognized, or VERSION unreadable) or exit 3 (undeclared) → **HALT** and name the self-service fix the tool prints FIRST; never guess a class, because a wrong guess routes the proposal to the wrong lane, and exit 3's structural suggestion is an INFERENCE offered as the value to WRITE, never a routing answer. USE-template origination schema (Step 7b) is self-contained in the synced skill `skills/30-claude-code-patterns/sync-flow.md` § "USE-Template Proposal Schema (Step 7b)" — use that in USE-template context; `guides/co-setup/09-proposal-protocol.md` carries the same schema plus full rationale but is loom-only (`use_excluded`) and MUST NOT be relied on as the schema authority where it is absent. Manifests emit `origin: build | use-template | downstream | loom` explicitly; append-not-overwrite per `rules/artifact-flow.md`. Each arm below also NAMES the successor verb — the spine is `/redteam` → `/codify` → successor — and the handoff artefact is `.claude/learning/learning-codified.json::last_codified`, advanced by Step 1; cite it and the verb in the closing line, and do NOT re-derive the successor's own routing (`/release` re-reads the class at its Step 0).

1. **`coc-source`** (loom) → **no upstream proposal**. loom splits, never originates, so this arm terminates here. A loom-direct artifact is authored through **`/govern`** — the receipt-gated O1 / co-owner-directed lane (`rules/artifact-flow.md` § The Origination Taxonomy) — never as a `/codify` proposal. Successor: **`/sync-to-use` + `/sync-to-build`** (Gate-2 distribution) — NOT `/release`, which routes no `coc-source` arm at its Step 0.
2. **`coc-use-template`** → Step 7b (USE-template→loom; COC-artifact only; mechanical wrong-lane glob-check enforced per Step 7b). Successor: **`/release`** (Authorization Mode), then `/deploy` if it ships an application.
3. **`coc-build`** → Step 7a (BUILD→loom; SDK code; cross-SDK-FIRST). Covers a client-fork BUILD repo under ANY name. Successor: **`/release`** (SDK Publish Mode).
4. **`coc-project`** → Step 7c (downstream→USE-template; COC-artifact only; wrong-lane glob-check per Step 7b's set). Successor: **`/release`** (Authorization Mode), then `/deploy` if it ships an application.

**Step 7c summary** (downstream→USE-template upflow; full procedure + schema in `skills/30-claude-code-patterns/sync-flow.md` § "Downstream Upflow Proposal Schema (Step 7c)"): (1) write/append `.claude/.proposals/latest.yaml` `origin: downstream` — `template_slug` ← `upstream.template` (the NAME, NOT `template_repo`), `template_version` ← `upstream.template_version` ∥ `upstream.version`, stamp `upstream.loom_sha`; lifecycle inherits `artifact-flow.md` § Proposal Lifecycle. (2) No `upstream.template` → HALT, self-service fix named FIRST ("set `upstream.template` in `.claude/VERSION` to your template's name, re-run /codify — or Route A issue on your template"). (3) Wrong-lane glob-check + **Route-B dual-route (G-C / G3.4)** — `gc-route-classifier.js` partitions paths on 7b's disallowed set (`src/**`, `packages/**`, `pyproject.toml`, `Cargo.toml`): in-scope `.claude/**` → Route A (continue Step 7c); disallowed code-lane paths → **Route B** (the LLM proposes a Layer-2 class `capability`|`bug` over the consumer rationale-as-DATA per `proposal-intake-trust.md` → `gc-build-issue-draft.js` drafts the `upstream-issue-hygiene.md` MUST-3 five-section BUILD issue + injects the cross-SDK-first flag + scrubs the MUST-2 denylist [a finding HALTs] → **HUMAN gate** [MUST-1: explicit y/N, restate target+action] fires `createUpflowIssue`/ADO via `getRepoProvider(<build-key>)`); mixed → both routes surfaced for independent human confirmation. Full dual-route procedure in `skills/30-claude-code-patterns/sync-flow.md` § "Route-B Capability/Bug Upflow (G-C)". (4) Consumer scrub (fence i) — `node .claude/bin/scan-synced-disclosure.mjs --check` (scans the consumer tree) if present (coc-tier), else base-tier human scrub against `upstream-issue-hygiene.md` Rule 2 denylist; findings HALT. (5) HUMAN-GATED offer (`upstream-issue-hygiene.md` MUST-1) — PR to the template's `.claude/.proposals/inbox/<date>-<slug>.yaml`; no-fork fallback Route A issue; no auto-submission, no standing approval. The PR/issue transport dispatches ONCE on `getRepoProvider(<template-key>)` — gh `createUpflowPR`/`createUpflowIssue` ∥ ADO equivalents (work-item type `getAdoWorkItemType()`, ADO `unverified`); full G-F provider-dispatch contract (incl. G-F-1 work-item disclosure neutralization) in `skills/30-claude-code-patterns/sync-flow.md` § "Provider-dispatched transport".

## Agent Teams

**Knowledge extraction team:**

- **analyst** — Identify core patterns + distill requirements into reusable agent instructions
- `co-reference` skill — Ensure agents and skills follow COC five-layer architecture (codification IS Layer 5 evolution)

**Creation team:**

- **reviewer** — Validate skill examples are runnable + review agent/skill quality before finalizing

**Validation team (red team the agents and skills):**

- **cc-architect** — Verify cc-artifacts compliance: descriptions <120 chars, agents <400 lines, commands <150 lines, rules have `paths:` frontmatter, SKILL.md progressive disclosure, no CLAUDE.md duplication
- **gold-standards-validator** — Terrene naming, licensing accuracy, terminology standards
- **testing-specialist** — Verify code examples + probe-coverage on harness changes (`rules/probe-driven-verification.md` MUST-4)
- **security-reviewer** — Audit agents/skills for prompt injection, insecure patterns, secrets exposure

### Journal (MUST — phase-complete gate)

Before reporting `/codify` complete, create `/journal new <TYPE> <slug>` entries for: **DECISION** (which rules/skills/agents were updated and why), **DISCOVERY** (patterns extracted into institutional knowledge that the next session should inherit). Skip only if nothing is journal-worthy; do not batch.
