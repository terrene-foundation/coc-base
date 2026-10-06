# Agent Orchestration — Extended Evidence and Examples

Companion reference for `.claude/rules/agents.md`. Holds post-mortems,
extended examples, session evidence, and protocol blocks that would
exceed the 200-line rule budget.

## Quality Gates — Extended Context

### BLOCKED responses when skipping MUST gates

- "Skipping review to save time"
- "Reviews will happen in a follow-up session"
- "The changes are straightforward, no review needed"
- "Already reviewed informally during implementation"

### Background agent pattern — extended rationale

Background agents (the `run_in_background: true` flag) are the structural defense that makes MUST gates near-free on parent context. The parent continues work while the reviewer operates in parallel; reviewer findings flush back at gate time or on the next parent turn.

Evidence: 0052-DISCOVERY §3.3 — six commits shipped without review because gates were classified "recommended." Background agents make MUST gates nearly free.

## Reviewer Mechanical AST/Grep Sweep — Full Example

Every gate-level reviewer prompt MUST include explicit mechanical sweeps that verify ABSOLUTE state (not only the diff). LLM-judgment review of the diff catches what's wrong with the new code; mechanical sweeps catch what's missing from the OLD code that the spec also touched.

```python
# DO — reviewer prompt enumerates mechanical sweeps
Agent(subagent_type="reviewer", prompt="""
... diff context ...
Mechanical sweeps (run BEFORE LLM judgment):
1. Parity grep — every `return TrainingResult(...)` call site must pass `device=...`
   grep -c 'return TrainingResult(' src/...trainable.py
   grep -cE 'device=DeviceReport' src/...trainable.py
   The two counts MUST be equal.
2. `pytest --collect-only -q` exit 0 across all test dirs
3. `pip check` — no new conflicts vs main
4. For every public symbol in __all__ added by this PR — verify eager import
""")

# DO NOT — reviewer prompt only includes diff context
Agent(subagent_type="reviewer", prompt="Review the diff between main and feat/X.")
```

Origin: 2026-04-19 codify cycle. See `skills/30-claude-code-patterns/worktree-orchestration.md` § "Reviewer Prompts — Mechanical AST/Grep Sweep" for full evidence.

## Worktree Isolation — Extended Post-Mortems

### The isolation flag is retired; a pre-made sibling worktree replaces it

`isolation: "worktree"` is BLOCKED as of 2026-07-26 (loom#1370). The orchestrator creates the worktree itself as a SIBLING outside the repo, pins its absolute path in the prompt, AND mandates a STEP-0 assertion — the agent's first action is `cd <worktree>`, then asserting `git rev-parse --show-toplevel` equals `pwd -P` and is not the main checkout, refusing to proceed otherwise. Both halves are required: the flag was also what SET the agent's cwd, so retiring it without the assertion would trade a bounded quota burn for the unbounded write-to-main loss recorded below (2 of 3 shards; 300+ LOC). Two near-miss forms are BLOCKED: `git -C <worktree> …` never establishes cwd (everything after it still resolves to MAIN), and a bare first `rev-parse` resolves to MAIN and refuses on every dispatch. Compare resolved paths, never the passed string — `--show-toplevel` resolves symlinks. Measured; see the skill's form table. The flag placed every agent worktree at `<repo>/.claude/worktrees/agent-<id>` — under the repo's own `.claude/` — which #1370 reports costs a floor of 88,895 duplicate tokens per agent per wave (~35.6M per wave round at 40 terminals × 10 agents), re-loading a corpus already in context. It also created the worktree without pinning every tool call inside it, and chose the path itself so the orchestrator could not pin what it did not know. Since 2026-09-12 (`journal/0607`) that worktree is the LANE's: the agents a lane dispatches share it under `rules/wip-discipline.md` MUST-9, and none gets a worktree of its own. See `rules/worktree-isolation.md` Rule 1 + `skills/30-claude-code-patterns/worktree-orchestration.md` § Retiring `isolation: "worktree"` for the recipe and the full 6-layer protocol.

### Worktree prompt paths must resolve inside the worktree — 2026-04-19 post-mortem

Session 2026-04-19: Three parallel ml-specialist shards launched with `isolation: "worktree"` (the then-current flag). The orchestrator prompt contained absolute paths rooted in the parent checkout. 2 of 3 shards wrote to MAIN; one (Shard B) self-corrected mid-run. Shard A lost 300+ LOC of sklearn array-API implementation when its empty worktree auto-cleaned. The failure mode is not agent-detectable by default.

Under the flag the only available fix was relative paths, because the harness chose the worktree path. With a pre-made sibling the path is known before dispatch, so the preferred form is now absolute-rooted-at-the-sibling (self-checking, and it survives a cwd revert per `rules/worktree-isolation.md` Rule 2a); relative stays valid when cwd is pinned. What was always BLOCKED, and still is: an absolute path rooted at the ORCHESTRATOR's checkout.

See `skills/30-claude-code-patterns/worktree-orchestration.md` § Rule 2 for the full post-mortem.

### Recover orphan writes from zero-commit agents — 2026-04-20 Session 3b

Session 2026-04-20 Session 3b (issue #567): The parallel-worktree agent for PR #3 wrote absolute paths rooted in the parent and exited with zero commits on its branch. The worktree auto-cleaned. Initial disposition was to re-launch the agent; user pushback surfaced that `git status --short` revealed 1129 LOC of `alignment.py` sitting orphaned in MAIN. PR #574 `recovery/pr3-alignment-diagnostics` branch recovered the work.

The 4-step protocol:

```bash
git worktree list | grep <expected-branch>                  # empty if cleaned
git log <expected-branch> --oneline | head -5               # zero agent commits confirms truncation
git status --short                                          # "??" entries surface the orphans
find . -path .claude/worktrees -prune -o -name "<expected-file>" -print
# → git checkout -b recovery/<original-branch-name>
# → git add <orphaned files> && git -c core.hooksPath=/dev/null commit -m "feat(...): recovered from failed parallel worktree agent"
# → fill missing deliverables (tests, specs, pyproject bumps, CHANGELOG)
# → gh pr create with recovery/ prefix + body explicitly noting the recovery
```

### Worktree agents commit incremental progress — 2026-04-19 three-shard post-mortem

Session 2026-04-19 three-shard ml-specialist parallel session: 3 of 3 shards truncated at 250–370k tokens. 2 of 3 lost work entirely because their branches had zero commits at truncation-time. Only Shard B self-corrected because its prompt emphasized commit-before-exit.

```python
# DO — prompt: "after each file, git add <f> && git commit -m 'wip: <what>'"
Agent(                                  # worktree pre-made as a sibling (Rule 1)
    prompt="""...
**Commit discipline (MUST):**
- After each file is complete, run `git add <file> && git commit -m "wip(shard-X): <what>"`.
- Do NOT hold all work in the worktree's index until the final report.
- If you exit without committing (budget exhaustion / crash / interruption),
  the worktree is auto-cleaned and ALL work is lost.
""",
)

# DO NOT — "Implement feature X. Report when done."
# (agent writes 4 files, hits budget on file 5, never reaches commit, all 5 lost)
```

Under the lane unit the COMMITTER runs this discipline: in a multi-agent lane the writers hand back
their file sets and the lane's one committer commits each as it lands (`rules/wip-discipline.md`
MUST-9); a single-agent lane's agent is its own committer and uses the prompt above as written.

See `skills/30-claude-code-patterns/worktree-orchestration.md` § Rule 3 for compile-work evidence AND `rules/worktree-isolation.md` § Rule 5 for the 2026-04-21 non-compile post-mortem.

## Verify Agent Deliverables — Extended Evidence

```python
# DO — verify after agent returns
Read("/abs/path/src/feature.py")  # raises if missing → retry

# DO NOT — trust completion message
result = Agent(prompt="Write src/feature.py with ...")
# parent moves on; src/feature.py never existed
```

**Evidence:** kaizen round 6 and ml-specialist round 7 (session 2026-04-19) each reported successful completion of file-writing tasks with zero files on disk. Budget exhaustion truncated the write tool call; the completion message emitted "Now let me write X..." with no subsequent tool invocation. An `ls` / `Read` check is O(1) and converts silent no-op into loud retry.

## Parallel-Worktree Package Ownership — Full Example

```python
# DO — explicit ownership in prompts (two LANES, each worktree pre-made as a sibling, Rule 1;
#       inside ONE lane the same split is the rules/wip-discipline.md MUST-9 disjoint file set)
# Every prompt below opens with STEP 0 verbatim (shown once here, elided in the bodies
# for width) — without it nothing pins the agent's cwd once the flag is retired:
#   cd "{WT_PARENT}/<shard>" && [ "$(git rev-parse --show-toplevel)" = "$(pwd -P)" ] || exit 1
Agent(prompt=f"""Working directory: {WT_PARENT}/onnx
...resolve #546 ONNX matrix...
Version bump + CHANGELOG (you OWN these):
- the ml package directory pyproject.toml → 0.13.0
- the ml package directory src/kailash_ml/__init__.py::__version__
- the ml package directory CHANGELOG.md""")

Agent(prompt=f"""Working directory: {WT_PARENT}/doctor-track
...resolve #547+#548 km.doctor + km.track...
COORDINATION NOTE: A parallel agent is bumping this package to 0.13.0.
You MUST NOT edit the ml package directory pyproject.toml,
the ml package directory src/kailash_ml/__init__.py::__version__, or
the ml package directory CHANGELOG.md. Just deliver the functionality.""")

# DO NOT — silent parallel ownership
Agent(prompt="...resolve #546... bump to 0.13.0")
Agent(prompt="...resolve #547+#548... bump to 0.13.0")
# ↑ Both agents race; merge picks one version field arbitrarily, dropping the other's CHANGELOG prose
```

Origin: Session 2026-04-20 three-agent parallel-release cycle (kailash-ml 0.13.0 + kailash 2.8.10, PRs #552, #553). Both agents saw the same base SHA, both independently bumped `version = "0.12.1"` → `"0.13.0"` and wrote top-level `## [0.13.0]` CHANGELOG entries. Git's three-way merge picked one side arbitrarily, discarding the other agent's CHANGELOG prose. One-sentence exclusion clause in the sibling's prompt prevents the O(manual) reconciliation.

See `skills/30-claude-code-patterns/worktree-orchestration.md` § Rule 5 for the full evidence.

## MUST NOT — Framework Bypass Rationale

- **Raw SQL when DataFlow exists** — bypasses DataFlow's access controls, audit logging, and dialect portability
- **Custom API when Nexus exists** — misses Nexus's session management, rate limiting, multi-channel deployment
- **Custom agents when Kaizen exists** — bypasses Kaizen's signature validation, tool safety, structured reasoning
- **Custom governance when PACT exists** — lacks PACT's D/T/R accountability grammar and verification gradient

## Post-mortem 2026-05-16 — non-isolated shared-source editor vs concurrent readers

Origin for the shared-source editor clause, now `skills/30-claude-code-patterns/worktree-orchestration.md` § Rule 9 — "Partition Shared-Source Editors By Lane And File Set; Concurrent Readers Read Committed HEAD". The incident below predates the lane unit (`journal/0607`); its remedy is restated in lane terms under § Resolution.

### Incident

During a long session resolving template drift, three agents ran against the SAME loom checkout (not worktree-isolated):

- a background agent resolving issue #243 (consumer variant boundary) that EDITED `.claude/sync-manifest.yaml`, and
- two `/sync` catch-up agents (py, then rs) that READ loom source (`emit.mjs`, rules) to copy genuine-lag files into USE templates.

The #243 agent's mid-edit WIP left `sync-manifest.yaml` with a transient YAML syntax error (a list scalar with an embedded `: `). The py catch-up agent, reading the shared working tree, flagged "the manifest is broken repo-wide" — correct, but it was another workstream's in-flight WIP, not a real defect at HEAD. The rs catch-up agent hit the same confusion. Net: ~2 agents' analysis cycles spent reconciling a transient state that did not exist at committed HEAD.

### Root cause

`agents.md` had a worktree-isolation MUST, but its title + rationale scoped it to **compiling** agents (cargo `target/` lock contention). A non-compiling agent that edits shared source in a shared checkout is the SAME structural hazard — its uncommitted WIP is visible to every concurrent reader — but the rule's compiling-only framing left it uncovered. The orchestrator (this session) launched the #243 agent into the SHARED main checkout — outside any lane worktree — precisely because "it doesn't compile." (At the time the isolation mechanism was the `isolation: "worktree"` flag, since retired; the failure is about editing the shared main checkout that other workstreams were reading, not about which mechanism made a tree.)

### Resolution

Two structural halves, both now in the rule:

1. **Editor isolation**: any background/parallel agent that edits shared source MUST work inside its lane's worktree — never the shared main checkout — and inside its own disjoint file set there (`rules/wip-discipline.md` MUST-9), compiling or not. Stated per agent when it landed; restated per lane 2026-09-12 (`journal/0607`).
2. **Reader discipline**: concurrent readers MUST read committed HEAD (`git show HEAD:<path>`), never the working tree. This is the isolation that actually saved the cycle here — once the py/rs catch-up agents were explicitly instructed to read committed HEAD, they produced correct plans despite the broken WIP in the shared tree.

### Secondary lesson (behavioral, journaled not ruled)

The same session twice used `git -c core.hooksPath=/dev/null commit` reflexively (both times inert — the target repos had no pre-commit framework, nothing masked). `git.md` already blocks silent hook-bypass; the lesson is behavioral (don't reach for the bypass by reflex) and is recorded in the bundle's journal DECISION entry rather than as a new rule clause, since git.md already covers the structural case.

### Counterfactual

Had the #243 agent worked in its own lane's worktree (or had the catch-up agents been told to read committed HEAD from the start), zero reader cycles would have been spent on a phantom defect. The reader-reads-committed-HEAD instruction was added mid-session and worked — it is now the codified default, not an ad-hoc save.

## Holistic Post-Multi-Wave Redteam — Evidence

When a plan executes across N≥3 sharded waves and each shard carried its own per-shard `/redteam`, the orchestrator MUST run a HOLISTIC post-multi-wave `/redteam` across ALL merged shards on main BEFORE declaring the plan converged. Per-shard `/redteam` catches within-shard defects; the holistic round catches cross-shard invariant violations — each shard locally correct but two shards together break a global invariant (orphaned API surface, missing audit-chain link, doc↔merged-impl drift, workspace path leakage scrubbed from each shard but not the combined surface).

The holistic round dispatches ≥3 parallel agents (reviewer + security-reviewer + closure-parity verifier) per § Audit/Closure-Parity Specialist Discipline, scoped to "all merged PRs in this plan on main", NOT "the diff of the most recent shard". Same parallel-execution shape as Parallel Brief-Claim Verification (≥3-issue brief) but applied at the post-implementation convergence gate rather than at `/analyze`.

**BLOCKED rationalizations:** "Each shard was redteamed, the union is covered" / "The last shard's diff is the only new surface" / "Holistic redteam duplicates the per-shard rounds" / "Per-shard caught zero CRIT/HIGH, so the plan is clean" / "Cross-shard review is /codify's job".

Evidence: a multi-wave delegate arc — after the final wave merged, a holistic post-multi-wave `/redteam` across all 8 shards on main surfaced 1 L1 cleanup gap (workspace path leakage scrub that NO per-shard round caught, each being scoped to its own diff) + 5 cross-shard follow-up findings. Per-shard rounds caught zero CRIT/HIGH unfixed; the holistic round caught one L1 + 5 cross-shard.

**Trust Posture Wiring:** Severity `halt-and-report` at the orchestrator's "plan converged" claim (cc-architect mechanical sweep on session notes claiming multi-wave completion). Grace 7 days. Cumulative 3× same-rule/30d → drop 1 posture. Regression-within-grace: the GENERIC `regression_within_grace` trigger → 1 step (no dedicated key; a `multi_wave_plan_no_holistic_redteam` key was named here but never defined in `trust-posture.md`, loom#2102). Detection: cc-architect asserts a journal entry exists naming ≥3 parallel specialists scoped to the union of merged shards. Origin: kailash-py delegate arc (2026-05-22).

## Binding-Scoped Shard PRs Touch Only Their Own Package — Evidence

When ≥2 parallel LANES each ship a binding/package-scoped shard (e.g. a Go MCP wrapper + a Ruby MCP wrapper), each shard's PR MUST limit its diff to its OWN binding/package directory. Incidental fixes to sibling-package files (clippy lints, fmt drift, doc typos) discovered mid-shard MUST be filed as a separate PR or carried in a dedicated cross-package cleanup shard — NOT bundled into the binding-scoped shard. This is the file-overlap variant of § Parallel-Worktree Package Ownership Coordination: that clause forbids two agents editing the version anchor; this one forbids two agents editing the same sibling-package source.

**BLOCKED rationalizations:** "It's only a one-liner lint fix" / "Both bindings rebuild anyway" / "Filing a separate PR is overhead for trivial drift" / "I'm already touching the workspace anyway" / "The fix is in a different file from the sibling shard" / "Concurrent PRs on different files don't conflict".

**Why:** When two concurrent binding-scoped shards touch the SAME sibling-package file (one shard's incidental fix + a concurrent shard that owns that file), the second-to-merge hits a 3-way conflict the orchestrator resolves mid-flight. Evidence: F9 Wave 3c (2026-05-22) — PR #1084 (a Java MCP shard) bundled an incidental Ruby clippy fix on a Ruby binding source file; concurrent PR #1085 (a broader Ruby MCP shard) edited the same file; #1085's auto-merge hit a 3-way conflict resolved at merge commit `69bed4e0`, adding ~10 min of mid-flight churn that binding-scope discipline would have prevented. Same trap precedent: Wave 3b PR #1081 on the parity-matrix file.

**Detection sweep:** reviewer mechanical sweep at `/implement` — `git diff --name-only main...HEAD`, map each changed path to its top-2 directory components, flag any binding-scoped PR (title `feat(go|java|ruby|python|nodejs):`) whose changed-file roots span >1 binding directory WITHOUT a cross-package-cleanup title prefix (`chore(bindings):` / `fix(bindings):` are explicitly carved out — they MAY touch multiple binding dirs by design).

**Trust Posture Wiring:** Severity `halt-and-report` (gate-review) / `advisory` (hook). Grace 7 days. Cumulative 3× same-rule/30d → drop 1 posture. Regression-within-grace → emergency downgrade L5→L4. Receipt `[ack: agents-binding-scope]` if pending_verification includes the rule_id. Origin: F9 Wave 3c (2026-05-22), PR #1084/#1085 conflict on a Ruby binding source file.

## Inline-extracted BLOCKED corpora (2026-07-18, journal/0543 paired extraction)

Relocated from `rules/agents.md` under the co-owner-directed triad codification so the baseline rule stays net-neutral on the AGENTS.md/GEMINI.md emission budget (`rule-authoring.md` Rule 10). The MUST clauses remain in the rule; these are their full BLOCKED-rationalization corpora.

### § Quality Gates — BLOCKED responses when skipping MUST gates

- "Skipping review to save time"
- "Reviews will happen in a follow-up session"
- "The changes are straightforward, no review needed"
- "Already reviewed informally during implementation"

### § Reviewer Prompts Include Mechanical AST/Grep Sweep — BLOCKED rationalizations

- "The reviewer is smart enough to spot orphans"
- "Mechanical sweeps are /redteam's job"
- "Adding sweeps is repetitive"

### § Verify Specialist Tool Inventory Before Implementation Delegation — BLOCKED rationalizations

- "security-reviewer is the security domain, so security-relevant edits go there"
- "The agent will figure out its tool limitations"
- "I'll re-launch with a different specialist if it halts"
- "Read-only review IS implementation when the diff is trivial"
- "The agent has Write — that's enough for code edits"

## Verify Specialist Tool Inventory — read-only roster + materialization

Extracted from `rules/agents.md` § "MUST: Verify Specialist Tool Inventory Before Implementation Delegation" (paired extraction, 2026-08-11 Gate-1 placement of the BUILD stream, `rule-authoring.md` Rule 10 path (a)).

**Read-only specialists — MUST NOT be delegated implementation work:** `security-reviewer`, `analyst`, `reviewer`, `gold-standards-validator`, `value-auditor`. Each declares no `Edit` and (except `reviewer`) no `Bash`, so it halts mid-instruction at the first file-edit boundary and the shard must be re-launched against a different specialist.

**Read-only reviewer materialization (INCREMENTAL).** `security-reviewer` is read-only and has no `Bash`, so it cannot fetch a diff itself. Materialize the diff or the changed-file set to a scratchpad path and NAME that path in the prompt; it then reviews the change instead of halting for context it cannot reach. This is the standard workaround, not a reason to substitute a writing specialist into a review seat.

## Clause-Scoped Wiring Precedent (extracted from the rule body 2026-08-16)

`agents.md` carries FOUR clause-scoped Trust-Posture-Wiring blocks, now in
`skills/32-trust-posture/wiring/agents.md` (§ Triad,
§ Correctness-Review-Clean, § Wave Worktrees, § Agent-Result-Delivery). Each
states the same grandfather + precedent framing, so the framing lives here ONCE
rather than four times in a `priority: 0` baseline rule (`rule-authoring.md`
MUST NOT § "Rules longer than 200 lines" — baseline density is an
output-quality requirement, not only budget hygiene).

**The shared framing.** Per `trust-posture.md` MUST-8's grandfather cutoff, a
clause landing AT/AFTER the MUST-8 SHA MUST ship canonical-8-field-compliant,
while the pre-existing grandfathered sections of the same rule stay exempt until
each is itself `/codify`-touched. The clause-scoped shape — one wiring block per
clause rather than one per file — is the precedent set by `security.md`
§ Enforcement-Surface Parity and `git.md` § CI-check/merge.

**The shared no-dedicated-key rationale.** All four clauses route
regression-within-grace without minting a per-clause key. Two reasons recur:
(a) each property is review-layer / session-history judgment rather than a
structural instant-drop signal, and (b) minting a key would edit
`trust-posture.md`, which is a `self-referential-codify.md` Rule-2 allowlist
file — dragging an otherwise narrow codify into a self-referential edit. Same
disposition `security.md` § Enforcement-Surface Parity, `git.md`
§ CI-check/merge, `issue-triage-routing.md`, and `wave-loop.md` MUST-6/7 took.

**Per-clause deltas** (what each block does NOT share): § Correctness-Review-Clean
landed via `/sync-from-build` Wave-1 placement (loom-sweep-waves-2026-07-22) and
does NOT reuse the § Triad clause's key; § Wave Worktrees DELEGATES its
regression-within-grace routing to `worktree-isolation.md` Rule 7, which already
owns the nested-placement violation class, rather than relying on the generic
trigger alone; § Agent-Result-Delivery is the only one of the four with a
genuine structural tool-call-time signal available (the spawn parameters are
present in the `PreToolUse` input), and it is the only one whose hook layer
carries **`halt-and-report`** rather than `advisory` — which is what the SHIPPED
detector already emits (`hooks/lib/dispatch-contract.js::detectNamedDispatchWithoutDelivery`,
registered on the `PreToolUse` `Task|Agent` matcher). The ceiling is set by the
SEVERITY RULE, not by any limitation of the adjudicator:
`hook-output-discipline.md` MUST-2 bars **`block`** on lexical evidence and
NOTHING MORE, and the in-corpus precedent for `halt-and-report` on a lexical
predicate is `skills/32-trust-posture/wiring/repo-scope-discipline.md` § Trust Posture Wiring.

An earlier revision of this section gave the reason as "the detector cannot
adjudicate intent". That was WRONG and is withdrawn on two counts: it stated as
the RATIONALE precisely the inference the clause exists to kill (a better
adjudicator would not unlock `block`, so adjudicator quality was never the
operative constraint), and it contradicted the rule, the depth skill and the
registry entry, which all read `halt-and-report`. A reader following the rule's
own depth pointer would have landed on a documented argument for DOWNGRADING a
live trust-substrate guard.

§ Agent-Result-Delivery also states its OWN
no-dedicated-key reason rather than inheriting the shared one, because the
shared "no structural signal" leg does not hold for it.

## Specialist roster + the complex-feature analysis chain (extracted from the rule body 2026-09-01)

Extracted under `rule-authoring.md` Rule 10 path (a) to pay for the § Triad
posture bound + closed dispatch quantifier landing inline in the same change.
Both blocks below were EMITTED baseline text until 2026-09-01; nothing here is
new, and nothing was dropped.

### Specialist roster

The work-domain → framework binding is `rules/framework-first.md`'s domain
table; the specialist agent name is that framework's name plus `-specialist`:

**dataflow** / **nexus** / **kaizen** / **mcp** / **mcp-platform** / **pact** /
**ml** / **align**-specialist.

The generic stack-agnostic trio (**db** / **api** / **ai**-specialist, which
read `STACK.md`) serves non-Kailash stacks; the `base` variant overlay of
`rules/agents.md` names that trio inline instead of the roster above.

### Analysis chain (complex features)

**analyst** (failure points) → **analyst** (requirements breakdown) →
**`decide-framework` skill** (approach) → the domain specialist.

Run the chain before dispatching a specialist on a feature with more than one
failure mode; a specialist entered at step 4 with no failure-point pass
produces technically correct, intent-misaligned output.

## Origin — full provenance chain (extracted from the rule body 2026-08-16)

Sessions 2026-04-19/20/27 (worktree drift, parallel-release PRs #552/#553, W6
closure-parity); slot-partitioned 2026-05-14 (#200); F20 extraction 2026-05-22
(journal/0143); prose trim 2026-06-11 (Gate-1 paired extraction);
worktree-cluster extraction to skill Rules 1–10 + Examples 6–10 retired
2026-06-12 (#491, journal/0271); triad default-execution-mode clause + paired
extraction to `parallel-dispatch-default.md` 2026-07-18 (co-owner-directed
origination, `journal/0543`); agent-result-delivery clause + paired extraction
to `agent-result-delivery.md` 2026-08-13 (USE-template origination), landed at
loom 2026-08-16 via `/sync-from-use` Gate-1 placement.

Note the § Wave Worktrees clause (2026-08-11, BUILD stream) carries its own
Origin inside its wiring block rather than in this chain, because it records a
spawn-time reachability gap plus two claims its source proposal shipped that
were falsified by that proposal's own follow-up measurement.

## Examples — CLI delegation-syntax mapping (extracted 2026-08-16)

The MUST clauses reference numbered examples by their inline "(Example N = …)"
descriptors. The WORKED examples (Examples 1–5) — the concrete CC
`Agent(subagent_type=…)` delegation code for each clause — live in
`.claude/skills/30-claude-code-patterns/specialist-delegation-syntax.md`, which
also carries the Codex (`bin/coc` inline-cat injection) and Gemini
(`@specialist`) mappings. They are reference material loaded on-demand when
delegating; the MUST clauses in the rule body are the CLI-neutral contract.

## Analysis chain for complex features

Moved here from the `rules/agents.md` always-on body on 2026-08-16 (lane-level Rule-10 path (a)
funding for `rules/conservation-gate.md`; `journal/0577`). It carried no `MUST` and no `**Why:**`
line — a workflow recipe, which `rule-authoring.md` MUST-1 and the § Curation / Over-Density
dimension both put in a guide rather than in a `priority: 0` baseline rule. Nothing was de-scoped:
the sequence is preserved verbatim below and the specialists it names carry the same guidance in
their own descriptions.

**analyst** (failure points) → **analyst** (requirements breakdown) → **`decide-framework` skill**
(approach) → the domain specialist.

## Removals made in the same funding pass — recorded, not silent

Three further edits to `rules/agents.md` in that pass recovered emitted bytes at ZERO content loss.
Recorded here so a later reader can see what left the always-on lane and why.

1. **§ Zero-Tolerance (removed).** It read: _"Pre-existing failures MUST be fixed
   (`rules/zero-tolerance.md` Rule 1); no workarounds for SDK bugs — fix directly (Rule 4), since a
   workaround creates a parallel implementation that diverges from the SDK."_ Both cited rules are
   themselves `priority: 0` + `scope: baseline`, so they are loaded in EVERY session in which
   `agents.md` is loaded — the restatement could never reach a reader the original did not. Per
   `specs-authority.md` Rule 9 (reference the canonical source, never restate it) the section was
   pure duplication of an always-co-loaded surface. No MUST was weakened: both MUSTs remain live in
   `zero-tolerance.md` Rules 1 and 4.
2. **Duplicate depth pointer (removed once).** `skills/30-claude-code-patterns/redteam-dispatch-evidence-gate.md`
   was cited twice within six lines (§ Redteam Reviewer Dispatch and § Correctness-Review-Clean Is
   Not Security-Clean). The first citation is kept; the second was the duplicate.
3. **Four inline "…: guide." tails (removed).** Each pointed at THIS file, which the rule's own
   whole-line header pointer already names. The tails were navigation to an already-named
   destination, not content.

None of these touched a `MUST`, a `MUST NOT`, a `**Why:**` line, a DO/DO-NOT block, or a
BLOCKED-rationalization corpus. The measured recovery was 828 B on the codex/gemini abridged lane
(`agents.md` 8,679 B → 7,851 B).

## Removals made in the 2026-09-02 headroom pass — recorded, not silent

The `codex/rs` baseline lane sat 421 B over its granted floor and a further floor exception was
refused, so the bytes had to come out of the emitted baseline. Every edit below was measured in
isolation through the real pipeline (`composeRule → stripRuleFrontmatter → abridgeV6 →
stripSlotMarkers`); none touched a `MUST`, a `MUST NOT`, a `BLOCKED` token, a `**Why:**` line, a
DO/DO-NOT block, or a Wiring field.

1. **§ Quality Gates `**Why:**` — "(Example 2 = background-dispatch pattern.)" removed (−43 B).**
   A DANGLING reference. The rule's own `## Examples` section holds "Worked Examples 1–5
   (CC / Codex / Gemini delegation syntax per clause)" — there is no numbered Example 2 about
   background dispatch in either destination; the background-agent depth lives in this file under
   § "Background agent pattern — extended rationale", by name.
2. **Duplicate depth pointer removed, AGAIN (−75 B).**
   `skills/30-claude-code-patterns/redteam-dispatch-evidence-gate.md` was cited twice within twelve
   lines (§ Redteam Reviewer Dispatch and § Correctness-Review-Clean). The first citation is kept.
3. **§ Worktree Orchestration `**Why:**` — origin history trimmed (−156 B).** The tail read
   "— and the sibling requirement lived only behind globs a spawn decision never matches, so the
   guard blocked launches with nothing loaded saying what to do." That history is retained VERBATIM
   in the same file, in the clause-scoped Wiring `**Origin:**` field ("a spawn-time REACHABILITY
   gap… the nested-worktree guard correctly BLOCKED four parallel spawns and the orchestrator had no
   loaded instruction telling it what to do instead"). The rationale sentence itself is unchanged.
4. **`rules/communication.md` — whole-line depth pointer reshaped (−124 B).** The line
   "Worked ✅/❌ examples … : `.claude/guides/rule-extracts/communication.md`." matched NEITHER
   whole-line strip shape (it does not open with `See`/`Depth`) nor the inline-tail shape (nothing
   precedes it on the line). Reshaped to the canonical `Depth — … lives in \`…\`.` form that
   `abridgeV6` recognises, per the `git.md` 2026-09-01 precedent. Content identical.

Measured on the `codex/rs` lane: `agents.md` 9,844 B → 9,570 B (−274 B); `communication.md`
1,349 B → 1,225 B (−124 B); corpus TOTAL 61,822 B → 61,424 B (−398 B).

### Three further edits were measured, then REVERTED — and why they are not available

A first pass also took 247 B off three lines that each CARRY a `MUST`: the § Specialist Delegation
pointer (a `;` → `.` punctuation fix that lets `abridgeV6`'s inline-tail strip fire, −63 B), the
§ Reviewer-Prompts rationale clause already held verbatim in this file above (−126 B), and the
§ Correctness-Review-Clean parenthetical restated by its own `**Why:**` two lines below (−58 B).
None of the three removed a `MUST`; the token census was flat at 58 across all three.

`check-descoping.mjs` still failed them, and it is RIGHT to, given what it can see. That gate opens
its line-identity analysis for a class only when the class's COUNT falls. On this branch the
`must_token` count is ALREADY down one — the § Zero-Tolerance removal, cleared by a registry
declaration — so the class is permanently OPEN, and once open, any REWORDED `MUST`-bearing line
reads as a removal that "appears nowhere else in this diff". The gate's own documentation names this
bound: "A REWORDED extraction is NOT auto-detected… costs one registry entry."

The three edits were reverted rather than declared. A `descoping-exceptions.json` entry asserts that
an obligation was removed and says where it went; filing three of those for lines whose `MUST` never
moved would put a FALSE record in a governance registry to buy 247 B. The bytes are not worth it,
and the honest disposition is to leave the lines alone.

Consequence worth knowing before the next headroom pass: **while `agents.md` carries an open
`must_token` delta, no `MUST`-bearing line in it can be re-worded without a registry entry.** Shed
work on this file is confined to lines that carry no counted token. That is a real and narrowing
constraint, not a temporary one.

### Correction to the record above (§ "Removals made in the same funding pass")

That section reports its three removals as landed and measures 828 B. Checked against this tree on
2026-09-02, two of the three had REGRESSED: the removals landed in `8cb41d77`, were undone by the
merge-revert `b6675f8f` ("Revert 'merge(s62): land feat/conservation-contract-2026-08-16'"), and the
later re-merge `c979550f` did not restore them. Only item 1 (§ Zero-Tolerance) is still absent.
Item 2 (the duplicate pointer) was present again and is re-removed here as item 2. Item 3 (the four
inline "…: guide." tails) is still present in the source and is deliberately LEFT there: `abridgeV6`
gained the loom#2018 E1a inline-tail strip after that pass, so those four tails now emit ZERO bytes
and deleting them from the source would buy nothing while costing a CC reader the pointer. The
828 B figure describes a tree that no longer exists; do not cite it as current.

## Wave Worktrees — 2026-09-12 Lane-Unit Amendment

Receipt: `journal/0607` decision 5 (co-owner-directed: "The ceilings explicitly bind worktrees and
branches AND NOT AGENTS"). § Worktree Orchestration's lead sentence read "Parallel/compiling agents
MUST run isolated", which put a worktree under every parallel agent and so charged each added agent
against the WIP ceiling. It now reads "Each LANE MUST run isolated …; its agents share that worktree
(`rules/wip-discipline.md` MUST-9)". The orchestrator-creates-the-sibling, absolute-path pin and
STEP-0 assertion obligations are unchanged and now govern creating a LANE; "in the prompt" became
"in every brief" because each of a lane's agents needs the pin and the assertion.

**Rule 10 disposition — path (a) paired extraction, MEASURED.** Two fragments left the clause in the
same edit: the sibling-path template and the "(Rules 1–11)" range. Neither was an obligation of this
clause — the placement template is `rules/worktree-isolation.md` Rule 7's MUST, and the skill the
clause points at carries the recipe. Measured through `stripRuleFrontmatter → abridgeV6 →
stripSlotMarkers` on this file alone, at this change: 9,318 B → 9,304 B (−14 B). The Wiring-block
amendment text is stripped by the abridger and emits nothing. No counted class fell; `MUST` tokens
rose 60 → 64 from the added citations.

**Probes.** `MUST-Worktree-Orchestration-firing` was RE-AUTHORED rather than left standing: its
former compliant pole justified four worktrees by cargo-lock contention — the exact premise this
amendment BLOCKS — so a judge reading the amended clause could correctly flag the pole that must stay
quiet. Its replacement packs two agents into each of two lanes and still separates only on WHO
creates each lane's worktree and WHERE. `MUST-Worktree-Orchestration-lane-unit-firing` is new: both
poles create one lane tree identically and separate only on whether build contention is met with
further worktrees or with per-agent build directories. The superseded pre-amendment candidates and
their sidecars are no longer referenced by any probe row.

## Wiring-block provenance — extracted from the rule body 2026-09-24

`.claude/rules/agents.md` is `priority: 0`, so every byte of it is injected into every session on
every lane. Its four clause-scoped Trust-Posture-Wiring blocks had accumulated a provenance narrative
— retracted claims, withdrawn revisions, measurement ledgers, probe-pole descriptions — that the
emitter's `abridgeV6` already strips before any Codex/Gemini baseline, so only the CC lane was paying
for it. That narrative is recorded here VERBATIM; the obligations it accompanied, and every
`- **<Field>:**` bullet, MUST-token, BLOCKED-token, `**Why:**` line and code-span citation that
carried them, stay in the rule body unchanged. Nothing below is an obligation. Measured at the move:
rule 35,176 B → 29,497 B, with `MUST` 64 → 64, `MUST NOT` 4 → 4, `BLOCKED` 18 → 18, `**Why:**`
10 → 10, MUST-bearing headings 14 → 14, all eight canonical wiring-field counts flat, and ZERO
citation members dropped from the rule's referential set.

### § Triad — Detection mechanism

On the retraction of the never-detectable claim: *"Its measurement asked whether the CONSTRAINT text
appears in the transcript, and the constraint indeed does not — but the VIOLATION is the agent's OWN
assistant turn asking for the lift, which IS written to the transcript and IS reachable at `Stop` via
`transcript_path`. Banking an instrument built for one question as the answer to another is
`rules/instrument-discipline.md` MUST-4, and it is what that retirement did."*

On the registry disposition: the fold into
`phase2-deferrals.json::agents.md#triad-default-execution` widened that row's SCOPE and its
GRADUATION rather than minting a key. *"A NEW key is not in the digest-pinned grandfathered
population and `completion-criterion.md` MUST-6 forbids the agent proposing a residual from also
accepting it, so folding keeps the gap DATED under an acceptance that already exists instead of
undeclared"* — the same disposition the § Agent-Result-Delivery wiring records.

On the probe-pair count: the "at least one per clause" reading holds because § Worktree Orchestration
carries TWO pairs since 2026-09-12, not one.

On the graduation of the dated row: *"The dated `probe_authorship_deferrals` row that stood in for
this tier is DELETED in the same change — a graduation that leaves the row standing is not a
graduation, since the row's whole content is a claim the suite was never written. An earlier revision
of this line said the suite was NOT YET AUTHORED; that was true when written and is now FALSE,
corrected rather than left, because a Wiring row claiming an absent tier is the same
absence-reads-as-clean shape this file governs."*

On execution: the registered probes execute ONLY when an orchestrator dispatches
`/test-harness-probe --artifacts` at gate-review.

### § Correctness-Review-Clean Is Not Security-Clean — Regression-within-grace

Why no dedicated per-clause trigger key was minted: *a two-lens-dispatch property is review-layer +
session-history judgment; it does not reuse the § Triad clause's key.* It is the same no-dedicated-key
disposition the § Triad clause and `security.md` § Enforcement-Surface Parity took.

### § Wave Worktrees Are Orchestrator-Created Siblings

**Severity.** On why the structural `block` was not enough on its own: *"that guard refuses the
nested spawn outright, and this clause exists because the refusal previously arrived with no loaded
instruction telling the orchestrator what to do instead."*

**Detection mechanism.** `MUST-Worktree-Orchestration-firing`'s poles run the SAME two-lane,
four-agent spawn and separate only on WHO creates each lane's worktree and WHERE.
`MUST-Worktree-Orchestration-lane-unit-firing`'s poles create one lane tree identically and separate
only on whether build contention is met with further worktrees or per-agent build directories. *"The
first pair's candidates were RE-AUTHORED 2026-09-12: its former compliant pole justified four
worktrees by cargo-lock contention, the premise the lane-unit amendment now BLOCKS, so it could no
longer stay quiet."* An earlier revision of that Wiring row said no probe suite shipped for this
clause and that this rule had no manifest entry; both were true when written and are now FALSE,
corrected rather than left standing.

**Origin.** The reachability gap is the same class as `issue-triage-routing.md`'s own Origin (`skills/32-trust-posture/wiring/issue-triage-routing.md` § Origin). *"Two
claims the source proposal shipped were FALSIFIED by its own follow-up measurement and are
deliberately NOT restated in the clause: that a PreToolUse hook can only refuse a call and never
rewrite it (the harness carries an `updatedInput` schema and an implemented fallback path), and that
'no configuration avoids the block' (narrowed to the verified claim — no flag, setting or env var
RELOCATES the base directory). A reviewer-proposed `cwd`-based remedy was REJECTED as unusable: the
delegation tool's exposed input schema strips `cwd`, so an orchestrator cannot pass it."* The
emission ledger for the 2026-09-12 lane-unit amendment is § "Wave Worktrees — 2026-09-12 Lane-Unit
Amendment" above.

### § A Dispatched Agent's Result Is Not Received Until It Is DELIVERED

**Severity.** Why the hook-layer ceiling is `block` and not `advisory`: *"the addressable-spawn field
is structurally present in the input while the other half of the predicate — whether the prompt
instructs push-delivery — is decidable only lexically over prompt prose."*

**Grace period.** The originating template windows, recorded rather than folded: 2026-08-13 → 08-20
for the SPAWN CONTRACT; 2026-08-14 → 08-21 for the DELIVERY-GATE extension + RECOVERY half. *"The two
2026-08-14 instances occurred BEFORE those halves existed, so they are the rule's evidence, not
violations of it."*

**Regression-within-grace.** Why the recoverability leg does not carry to the fragment half: *"mode
1's report is on disk, but a STATUS-FRAGMENT lane never wrote one, so what survives is raw tool
output and the synthesis is genuinely gone (a resume re-derives it from a warm agent; nothing
recovers it from disk). The key stays generic because the loss is still non-corrupting and bounded to
re-work, but the argument is weaker for the fragment half, and re-using the mode-1 rationale
unexamined would be the `zero-tolerance.md` Rule 3e shape — a claim about a surface not re-derived
after the surface changed."*

**Detection mechanism.** On (c)'s structurally-correct home: `PostToolUse` on the delegation tools,
*"where the payload DOES exist"*. On the booking discipline: *"none has been accepted for this
clause, and booking an expiry nobody agreed to carry is the permanent-by-default shape
`trust-posture.md` § 'Every Phase-2 Deferral Carries A DATED Declaration' exists to prevent."* The
design constraints the shipped detector satisfies — the correct event, why `SessionStart` and `Stop`
are both wrong, and why the matcher must cover BOTH delegation-tool names — are recorded in
`skills/30-claude-code-patterns/agent-result-delivery.md` § "The detector that ships".

On the graduated row (`expires: 2026-11-17`): *"That row's graduation condition named this clause
explicitly — efficacy on a transcript scoring a STATUS FRAGMENT as a clean lane, no-false-positive on
a terse-but-complete verdict the clause declares IS a delivery — and the
`MUST-A-Dispatched-Agents-Result-Is-Not-Received-Until-firing` pair is built to exactly that shape,
so the paired depth skill's folded coverage graduates with it rather than being re-deferred under a
fresh key. The DELIVERY-GATE half is what the pair probes, because it is the half no shipped detector
reaches: the violation pole's payload is present, non-empty, error-free and the LONGEST of the four
returned, and is still a non-delivery, while three four-word verdicts alongside it ARE deliveries —
so a check keying on payload presence or length scores that pole backwards. An earlier revision of
this row said the suite was UNWRITTEN and that this rule had no `eval-manifest.json` entry; both were
true when written and are now FALSE."* The probes run when an orchestrator dispatches
`/test-harness-probe --artifacts` at gate-review.

### § Examples and § Distinct From — trimmed provenance

The Examples slot's Worked Examples 1–5 are also indexed by § "Examples — CLI delegation-syntax
mapping" above. The per-CLI spawn-parameter sentence previously spelled out what the skill holds —
*"which spawn parameter opens the return path, which one shadows the agent-type selector, and the
sanctioned addressable form"* — before deferring to
`.claude/skills/30-claude-code-patterns/agent-result-delivery.md`; the skill pointer itself stays in
the rule body, because `skills/…` pointers ship to consumers and re-targeting one at a guide would be
de-scoping by the back door.

The `rules/time-pressure-discipline.md` cross-reference was moved into § Distinct From from
§ Parallel Execution on 2026-09-07 (headroom lane). Its always-on twin in
`rules/autonomous-execution.md` § 10x Throughput Multiplier was MEASURED present in that file's
abridged emission, not assumed. Same disposition `zero-tolerance.md` took for the same pointer on
2026-09-02.

---

## Examples (CLI-specific delegation syntax) (extracted from rules/agents.md 2026-10-01)

## Examples (CLI-specific delegation syntax)

CLI dispatch syntax for the § Triad clause is delivered through this slot. Worked Examples 1–5 (CC / Codex / Gemini delegation syntax per clause) live in `.claude/skills/30-claude-code-patterns/specialist-delegation-syntax.md`. The MUST clauses above are the CLI-neutral contract.

**§ Agent-Result-Delivery — per-CLI spawn parameters.** The CC field names that realise parts (1) and (3) live once, with the measured 11-spawn separation table, in `.claude/skills/30-claude-code-patterns/agent-result-delivery.md` § "The mechanism — one field decides it". Codex and Gemini expose no equivalent named-teammate primitive, so part (1) reduces there to the neutral contract.

<!-- /slot:examples -->
