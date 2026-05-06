
# agents.md

---
priority: 0
scope: baseline
---

# Agent Orchestration Rules

See `.claude/guides/rule-extracts/agents.md` for full evidence, extended examples, post-mortems, recovery-protocol commands, the gate-review table, and CLI-syntax variants.


## Specialist Delegation (MUST)

When working with Kailash frameworks, MUST consult the relevant specialist: **dataflow-specialist** (DB/DataFlow), **nexus-specialist** (API/deployment), **kaizen-specialist** (AI agents), **mcp-specialist** (MCP integration), **mcp-platform-specialist** (FastMCP platform), **pact-specialist** (governance), **ml-specialist** (ML lifecycle), **align-specialist** (LLM fine-tuning). See `rules/framework-first.md` for the domain-to-framework binding.

**Why:** Framework specialists encode hard-won patterns and constraints generalist agents miss, leading to subtle misuse of DataFlow, Nexus, or Kaizen APIs.

## Specs Context in Delegation (MUST)

Every specialist delegation prompt MUST include relevant spec file content from `specs/`. Read `specs/_index.md`, select relevant files, include them inline. See `rules/specs-authority.md` MUST Rule 7 for the full protocol.

**Why:** Specialists without domain context produce technically correct but intent-misaligned output (e.g., schemas without tenant_id because multi-tenancy wasn't communicated).

## Analysis Chain (Complex Features)

1. **analyst** → Identify failure points
2. **analyst** → Break down requirements
3. **`decide-framework` skill** → Choose approach
4. Then appropriate specialist

## Parallel Execution

When multiple independent operations are needed, launch agents in parallel via Codex's native delegation primitive, wait for all, aggregate results. MUST NOT run sequentially when parallel is possible.

**Why:** Sequential execution of independent operations wastes the autonomous execution multiplier, turning a 1-session task into a multi-session bottleneck.

### MUST: Parallel Brief-Claim Verification When Issue Count ≥ 3

When `/analyze` runs against a brief covering ≥ 3 distinct issues / failure modes / workstreams, the orchestrator MUST launch parallel deep-dive verification agents — one per claim cluster — to independently re-grep / re-read every factual claim in the brief tagged with file:line citations. Inaccuracies surfaced by the deep-dive sweep MUST be recorded in the workspace journal AND in the architecture plan's "Brief corrections" section AS THE GATE before `/todos`. Single-agent analysis on a ≥3-issue brief is BLOCKED — the framing inherited from the brief is the failure mode this rule prevents.

**Why:** Briefs decay silently as the code evolves; a ≥3-issue brief carries ≥3× the surface area for stale citations and misframed root causes. Single-agent analysis cannot resist the brief's framing because the agent has no independent reading. Parallel deep-dive verification is the structural defense — three agents reading three claim-clusters independently produce three independent reports the orchestrator reconciles. Evidence: `kailash-ml-1.5.x-followup` brief had THREE distinct factual inaccuracies — all three caught only because three parallel deep-dive agents independently verified. Origin: 2026-04-29 — `workspaces/kailash-ml-1.5.x-followup/journal/0001-DISCOVERY-brief-root-cause-incorrect-on-three-issues.md`.

## Quality Gates (MUST — Gate-Level Review)

Reviews happen at COC phase boundaries, not per-edit. Skip only when explicitly told to. **MUST gates** are `/implement` and `/release`; reviewer + security-reviewer (and gold-standards-validator at `/release`) run as parallel background agents. RECOMMENDED gates run at `/analyze`, `/todos`, `/redteam`, `/codify`, and post-merge. See guide for the full gate table.

**Why:** Skipping gate reviews lets analysis gaps, security holes, and naming violations propagate to downstream repos where they are far more expensive to fix.

**BLOCKED responses when skipping MUST gates:** "Skipping review to save time" / "Reviews will happen in a follow-up session" / "The changes are straightforward, no review needed" / "Already reviewed informally during implementation".

### MUST: Reviewer Prompts Include Mechanical AST/Grep Sweep

Every gate-level reviewer prompt MUST include explicit mechanical sweeps that verify ABSOLUTE state (not only the diff). LLM-judgment review catches what's wrong with new code; mechanical sweeps catch what's missing from OLD code the spec also touched.

**Why:** Reviewers are constrained by the diff. The orphan failure mode in `orphan-detection.md` §1 is invisible at diff-level. A 4-second `grep -c` catches what 5 minutes of LLM judgment misses. See guide for full evidence.

## Zero-Tolerance

Pre-existing failures MUST be fixed (`rules/zero-tolerance.md` Rule 1). No workarounds for SDK bugs — deep-dive and fix directly (Rule 4).

**Why:** Workarounds create parallel implementations that diverge from the SDK, doubling maintenance cost.

## MUST: Verify Specialist Tool Inventory Before Implementation Delegation

When delegating IMPLEMENTATION work (file edits, commits, build/test invocation, version bumps), the orchestrator MUST select a specialist whose declared tool set includes `Edit` AND `Bash`. Read-only specialists (`security-reviewer`, `analyst`, `reviewer`, `gold-standards-validator`, `value-auditor`) MUST NOT be delegated implementation tasks. Pure-research / pure-review delegations are fine. See guide for the specialist tool-inventory table and CLI-specific delegation syntax.

**Why:** Read-only specialists halt mid-instruction at file-edit boundaries — the agent emits "Now let me wire X" then exits with zero tool calls because Edit is unavailable. Verifying tool inventory pre-launch is O(1); re-launch is O(N) on shard size. See guide for cross-SDK rediscovery evidence.

## MUST: Audit/Closure-Parity Verification Specialist Has Bash + Read

When delegating a /redteam round whose mission includes **closure-parity verification** (mapping prior-wave findings to delivered code via `gh pr view`, `pytest --collect-only`, `grep`, `ast.parse()`, `find`), the orchestrator MUST select a specialist whose tool set includes `Bash` AND `Read`. Read-only analyst (`Read, Grep, Glob`) MUST NOT be assigned closure-parity verification — its tool set silently FORWARDS verification rows the next round must redo. Extends § "Verify Specialist Tool Inventory" above from IMPLEMENTATION to AUDIT delegation.

**Why:** Tool-inventory mismatch costs one full audit round. Verifying pre-launch is O(1); re-launch is O(N) on row count. Origin: 2026-04-27 W6 /redteam Round 3 — analyst FORWARDED 16 of 22; pact-specialist (Bash) Round 3 converted all 16 to VERIFIED in one shard. The Rust audit toolkit substitutes `cargo expand` / `cargo doc --document-private-items` (JSON) / `syn::parse_file` for the Python introspection commands.

## MUST: Worktree Isolation for Compiling Agents

Agents that compile (Rust `cargo`, Python editable installs at scale) MUST use Codex's worktree-isolation primitive to avoid build-directory lock contention.

**Why:** Cargo holds an exclusive filesystem lock on `target/`. Worktrees give each agent its own `target/`. See `skills/30-claude-code-patterns/worktree-orchestration.md` for the full 5-layer protocol — worktree isolation is necessary but not sufficient.

## MUST: Worktree Prompts Use Relative Paths Only

When prompting an agent with worktree isolation, the orchestrator MUST reference files via paths RELATIVE to the repo root — never absolute paths starting with `/Users/` or `/home/`.

**Why:** Worktree isolation sets cwd to the worktree; absolute paths point back to the parent checkout, silently defeating isolation. See guide for 2026-04-19 post-mortem (300+ LOC lost).

## MUST: Recover Orphan Writes From Zero-Commit Worktree Agents

When a worktree-isolated agent reports completion but the branch has zero commits AND the worktree has been auto-cleaned, the parent MUST inspect the MAIN checkout for orphaned untracked files BEFORE concluding the work was lost. Absolute-path writes from the agent resolve to the MAIN checkout cwd — the files are NOT lost; they are orphaned, uncommitted, and reachable via `git status` on the parent.

**Why:** Re-launching abandons real work every time an absolute-path agent truncates. `git status` reveals the orphans; `recovery/` grep surfaces this class of rescue across history. See guide for full 4-step protocol + PR #574 evidence (1129 LOC of `alignment.py` recovered).

## MUST: Worktree Agents Commit Incremental Progress

Every worktree-isolated agent MUST receive an explicit instruction in its prompt to `git commit` after each milestone. The orchestrator MUST verify the branch has ≥1 commit before declaring the agent's work landed.

**Why:** Worktrees with zero commits are silently deleted. See guide for 2026-04-19 three-shard post-mortem.

## MUST: Verify Agent Deliverables Exist After Exit

When an agent reports completion of a file-writing task, the parent MUST `ls` or `Read` the claimed file before trusting the completion claim.

**Why:** Budget exhaustion truncates writes mid-message. The `ls` check is O(1) and converts silent no-op into loud retry.

## MUST: Parallel-Worktree Package Ownership Coordination

When launching ≥2 parallel agents whose worktrees touch the SAME sub-package, the orchestrator MUST designate ONE agent as **version owner** (pyproject.toml + `__init__.py::__version__` + CHANGELOG) AND tell every sibling explicitly: "do NOT edit those files". Integration belongs to the orchestrator.

**Why:** Parallel agents see the same base SHA; each independently bumps `version` and writes a CHANGELOG entry. Merge picks one — discarding the other's prose silently. See guide for kailash-ml 0.13.0 evidence (PRs #552, #553).

## MUST NOT

- **Framework work without specialist** — misuse violates invariants (pool sharing, session lifecycle, trust boundaries).
- **Sequential when parallel is possible** — wastes the autonomous execution multiplier.
- **Raw SQL / custom API / custom agents / custom governance** — see `rules/framework-first.md` and guide for per-framework rationale.


---

# autonomous-execution.md

---
priority: 0
scope: baseline
---

# Autonomous Execution Model


COC executes through **autonomous AI agent systems**, not human teams. All deliberation, analysis, recommendations, and effort estimates MUST assume autonomous execution unless the user explicitly states otherwise.

Human defines the operating envelope. AI executes within it. Human-on-the-Loop, not in-the-loop.

## MUST NOT (Deliberation)

- Estimate effort in "human-days" or "developer-weeks"
- Recommend approaches constrained by "team size" or "resource availability"
- Suggest phased rollouts motivated by "team bandwidth" or "hiring"
- Assume sequential execution where parallel autonomous execution is possible
- Frame trade-offs in terms of "developer experience" or "cognitive load on the team"

**Why:** Human-team framing causes the agent to recommend suboptimal approaches (phasing, sequencing, simplifying) that waste autonomous execution capacity.

## MUST (Deliberation)

- Estimate effort in **autonomous execution cycles** (sessions, not days)
- Recommend the **technically optimal approach** unconstrained by human resource limits
- Default to **maximum parallelization** across agent specializations
- Frame trade-offs in terms of **system complexity**, **validation rigor**, and **institutional knowledge capture**

**Why:** Without autonomous framing, effort estimates inflate 10x and plans are artificially sequenced to fit human-team constraints that don't exist.

## 10x Throughput Multiplier

Autonomous AI execution with mature COC institutional knowledge produces ~10x sustained throughput vs equivalent human team.

| Factor                                               | Multiplier |
| ---------------------------------------------------- | ---------- |
| Parallel agent execution                             | 3-5x       |
| Continuous operation (no fatigue, no context-switch) | 2-3x       |
| Knowledge compounding (zero onboarding)              | 1.5-2x     |
| Validation quality overhead                          | 0.7-0.8x   |
| **Net sustained**                                    | **~10x**   |

**Conversion**: "3-5 human-days" → 1 session. "2-3 weeks with 2 devs" → 2-3 sessions. "33-50 human-days" → 3-5 days parallel.

**Does NOT apply to**: Greenfield domains (first session ~2-3x), novel architecture decisions, external dependencies (API access, approvals), human-authority gates (calendar-bound).

## Structural vs Execution Gates

**Structural (human required):** Plan approval (/todos), release authorization (/release), envelope changes.

**Execution (autonomous convergence):** Analysis quality (/analyze), implementation correctness (/implement), validation rigor (/redteam), knowledge capture (/codify). Human observes but does NOT block.

## Per-Session Capacity Budget

Autonomous capacity is high but not infinite. It degrades along multiple axes simultaneously — LOC is only the proxy. Work that exceeds the budget below MUST be sharded at `/todos` time, before implementation begins.

### 1. Shard When Any Threshold Is Exceeded (MUST)

A single shard (one session, one worktree, one implementation pass) MUST stay within ALL of:

- **≤500 LOC of load-bearing logic** — state machines, schedulers, invariant-holding code. Does NOT count CRUD, DTOs, route registration, or generated boilerplate.
- **≤5–10 simultaneous invariants** the implementation must hold (tenant isolation + audit + redaction + cache key shape + error taxonomy = 5).
- **≤3–4 call-graph hops** of cross-file reasoning.
- **≤15k LOC of relevant surface area** in working context for correctness.
- Describable in **3 sentences or fewer**. If it takes more, the shard is too big.

**Why:** Beyond the budget the model stops tracking cross-file invariants and pattern-matches instead. Errors on line 400 poison everything after and surface only at `/redteam`. Evidence: the Phase 5.11 orphan (2,407 LOC of trust integration code with zero production call sites) was one conceptual change that exceeded the invariant budget — nothing caught it until the audit.

### 2. Size By Complexity, Not LOC Alone (MUST)

Todo sizing MUST distinguish boilerplate from load-bearing logic. Boilerplate scales ~5× further than logic before sharding triggers, because the model holds a single pattern and stamps it out.

**Why:** Uniform LOC caps fail on both ends. Sizing reflects what's held in attention (invariants, call-graph depth), not what's typed (line count).

### 3. Feedback Loops Multiply Capacity (MUST)

Shards with an executable feedback loop (unit tests, `cargo check`, type checker, integration harness that runs during the session) MAY use up to 3–5× the base budget. Shards without a live loop (spec drafting, config editing, refactors in untested modules) MUST use the base budget.

**Why:** Feedback loops convert "write 2000 LOC then discover it's wrong" into "write 200 LOC, test, continue." The multiplier is real but requires the loop to actually fire during the session — "redteam will catch it later" is not a feedback loop.

### 4. Fix-Immediately When Review Surfaces A Same-Class Gap Within Shard Budget (MUST)

When a gate-level review (reviewer, security-reviewer, gold-standards-validator) or self-verification surfaces a latent gap in the SAME BUG CLASS as the in-flight PR AND the gap fits within one remaining shard budget (≤500 LOC load-bearing logic / ≤5–10 invariants / ≤3–4 call-graph hops), the session MUST spawn the fix immediately rather than filing a follow-up issue. Filing the follow-up issue instead of fixing is BLOCKED.

**Why:** Same-bug-class gaps surfaced during review cost the least to fix while the context is loaded — the invariants, call graph, and domain model are all warm in attention. Filing a follow-up issue requires the next session to reload the entire context from scratch, typically 2–5× the marginal cost of continuing. Evidence: 2026-04-20 — a reviewer flagged 40+ sibling sites with the same hardcode pattern as the just-fixed PR. The agent filed a follow-up issue instead of fixing; the user pushed back ("why aren't you resolving it"); the fix shipped same session. Filing the follow-up wasted one user-turn of friction and one session-handoff context-reload that was unnecessary.

**Bounded by the shard budget.** This rule does NOT override MUST Rule 1 (shard threshold). If the surfaced gap exceeds ≤500 LOC load-bearing / ≤5–10 invariants / ≤3–4 call-graph hops, filing the follow-up issue IS the correct disposition — the gap is a new shard, not a continuation of the current one.

## MUST NOT (Sharding)

- Size shards by LOC alone, ignoring invariant count and call-graph depth

**Why:** LOC is a proxy that fragments trivial work and overflows complex work.

- Defer sharding decisions to `/implement`

**Why:** Sharding at `/todos` costs a plan rewrite; sharding mid-`/implement` abandons work in progress and leaves partial state the next session must untangle.

**Why:** Context window is not attention. Model capability claims are not evidence for a specific task. "One conceptual change" is exactly how Phase 5.11 shipped 2,407 LOC of orphaned code.


---

# coc-sync-landing.md

---
priority: 0
scope: baseline
---

# COC Sync Landing — BUILD-Side Discipline

See `.claude/guides/rule-extracts/coc-sync-landing.md` for BLOCKED-rationalizations, extended bash examples, origin post-mortem, MUST NOT clauses, and cross-rule relationships.


Loom's `/sync-to-build` delivery MUST land on `main` BEFORE any other session work. Pairs with `.claude/hooks/coc-drift-warn.js` (SessionStart).

## MUST Rules

### 1. COC Drift Lands as PR #1

When the SessionStart hook reports `🚨 COC ARTIFACT DRIFT DETECTED`, land it FIRST. Non-COC-PR workarounds BLOCKED. Cross-session carry BLOCKED.

**Why:** Uncommitted deliveries appear available on disk but vanish on first non-main commit — new commands disappear, new agents become invisible.

### 2. Stage Explicit Paths

Stage `.claude/` and `scripts/hooks/` explicitly. `git add -u` / `-A` / `.` BLOCKED for COC-sync PRs.

**Why:** Bulk staging sweeps unrelated workspace drift into the PR. PR #753 (2026-05-01) wasted ~15 min recovering from this exact failure.

### 3. Admin-Merge Per Owner Workflow

After CI green or path-filter auto-skip, run `gh pr merge <N> --admin --merge --delete-branch`. `REVIEW_REQUIRED` parking BLOCKED.

**Why:** `--admin` is the owner-class bypass for chore PRs; without it the PR drifts open across sessions and the failure mode resumes.


---

# communication.md

---
priority: 0
scope: baseline
---

# Communication Style


Many COC users are non-technical. Default to plain language; match the user's level if they speak technically.

## Report in Outcomes, Not Implementation

## Explain Choices in Business Terms

When presenting decisions, explain implications in terms the user can act on — not implementation details.

## Frame Decisions as Impact

Present: what each option does (plain language), what it means for users/business, the trade-off, your recommendation.

**Example**: "Two options for notifications. Option A: email only — simple, but users might miss messages. Option B: email plus in-app — takes longer but ensures users see important updates. I'd recommend B since your brief emphasizes real-time awareness."

## Approval Gates

At gates (end of `/todos`, before `/deploy`), ask:

- "Does this cover everything you described in your brief?"
- "Is anything here that you didn't ask for or don't want?"
- "Is anything missing that you expected to see?"

## MUST NOT

- Ask non-coders to read code — describe in plain language

**Why:** Non-technical users cannot act on code snippets, so they either ignore the information or make wrong assumptions.

- Use unexplained jargon — immediately explain technical terms

**Why:** Unexplained jargon forces the user to ask clarifying questions, doubling the turns needed to reach a decision.

- Present raw error messages — translate to impact

**Why:** Raw error messages are unintelligible to most users and create anxiety without enabling action.

- Repeat the same jargon if user says "I don't understand" — find new analogy

**Why:** Repeating failed explanations signals that the agent cannot adapt, eroding user trust in the entire session.


---

# git.md

---
priority: 0
scope: baseline
---

# Git Workflow Rules

See `.claude/guides/rule-extracts/git.md` for extended bash examples, full BLOCKED rationalization lists, repository protection table, and Origin evidence.


## Conventional Commits

Format: `type(scope): description`. Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`.

**Why:** Non-conventional commits break automated changelog generation and make `git log --oneline` useless for release notes.

## Branch Naming

Format: `type/description` (e.g., `feat/add-auth`, `fix/api-timeout`).

**Why:** Inconsistent branch names prevent CI pattern-matching rules and make `git branch --list` unreadable.

### Release-Prep PRs MUST Use `release/v*` Branch Convention (MUST)

Any PR whose diff is metadata-only — version anchors (`pyproject.toml` / `Cargo.toml`, `__init__.py::__version__` / lib.rs `pub const VERSION`), `CHANGELOG.md`, spec/doc version-line updates — MUST be opened from a branch named `release/v<X.Y.Z>`. Using `feat/`, `fix/`, `chore/` on a release-prep PR is BLOCKED.

**Why:** PR-gate workflows check `if: !startsWith(github.head_ref, 'release/')`. Branching from `release/v*` triggers the auto-skip and saves ~45 min × matrix-size of CI minutes per release-prep PR. If the work IS NOT metadata-only, split: keep code fix on `feat/`/`fix/` branch, cut release-prep on a separate `release/v*` branch. Evidence: a recent BUILD release-prep PR opened from `feat/...-release-prep` instead of `release/v*` consumed ~120 min of avoidable PR-gate CI on a metadata-only diff.

### Pre-FIRST-Push CI Parity Discipline (MUST)

Before the FIRST `git push` that creates a remote branch, the agent MUST run the project's local CI parity command set (Rust: `cargo +nightly fmt --all --check` + `cargo clippy -- -D warnings` + `cargo nextest run` + `RUSTDOCFLAGS="-Dwarnings" cargo doc`. Python: `pre-commit run --all-files` + `pytest` + `mypy --strict`). All MUST exit 0 → push.

**Why:** With `concurrency: cancel-in-progress: true` on the workflow, prior in-flight runs are cancelled — but **the cancelled runs are still billed for the wall-clock minutes already consumed before cancellation**. A recent BUILD release had a 71-minute Workspace Tests run cancelled mid-flight; those 71 min were charged. Pre-flighting takes ~5-10 min; the alternative is N × 45 min of billed CI per fix-up cycle.

## Branch Protection

All protected repos require PRs to main. Direct push is rejected by GitHub. Owner workflow: branch → commit → push → PR → `gh pr merge <N> --admin --merge --delete-branch`. See extract for the full repository × protection table.

**Why:** Direct pushes bypass CI checks and code review, allowing broken or unreviewed code to reach the release branch.

## PR Description

CC system prompt provides the template. Always include a `## Related issues` section (e.g., `Fixes #123`).

**Why:** Without issue links, PRs become disconnected from their motivation, breaking traceability and preventing automatic issue closure on merge.

## `git reset --hard` MUST Verify Clean Working Tree (MUST)

`git reset --hard <ref>` SILENTLY discards every unstaged modification AND every untracked file in the affected paths. Recovery is impossible — unstaged content has no reflog entry. Running `git reset --hard` without first verifying `git status --porcelain` is empty is BLOCKED. Prefer `git reset --keep <ref>`, which performs the same commit-graph operation BUT aborts if it would lose local changes.

**Why:** `git reset --hard` is the most destructive git operation that doesn't rewrite history — and unlike force-push, the destruction is unrecoverable. `git reset --keep` exists in git specifically to provide the same effect with structural safety. Sibling of `dataflow-identifier-safety.md` Rule 4 (DROP) and `schema-migration.md` Rule 7 (downgrade) — same structural-confirmation pattern. Origin: 2026-04-28 — a `git reset --hard` wiped uncommitted `.session-notes`; cross-language principle.

## Rules

- Atomic commits: one logical change per commit, tests + implementation together
- No direct push to main, no force push to main
- No secrets in commits (API keys, passwords, tokens, .env files)
- No large binaries (>10MB single file)
- Commit bodies MUST answer **why**, not **what** (the diff shows what)

**Why:** Mixed commits are impossible to revert cleanly. Leaked secrets require key rotation across all environments. Large binaries permanently bloat the repo. Commit bodies that explain "why" are the cheapest form of institutional documentation — co-located, versioned, `git log --grep`-searchable, never stale.

## Discipline

- **Issue closure**: `gh issue close <N>` MUST include a commit SHA / PR number / merged-PR link in the comment. Closing with no code reference is BLOCKED.
- **Pre-commit hook workarounds**: when pre-commit auto-stash fails despite hooks passing standalone, `git -c core.hooksPath=/dev/null commit ...` MUST be documented in the commit body + a follow-up todo filed. Silent `--no-verify` is BLOCKED.
- **Pre-commit comment-syntax matchers**: the `python-use-type-annotations` hook regex matches `# type` (NOT `# type:`) per `pre-commit-hooks/.pre-commit-hooks.yaml::pygrep`. Comments referencing the `types` module — `# types.UnionType for PEP 604` — trigger a false positive. Reword to avoid `# type` as a literal substring (e.g. "PEP 604 produces `types.UnionType`" → "PEP 604 produces a union type"). Same class for any future `pygrep` hook that matches comment fragments without the trailing punctuation.
- **Commit-message claim accuracy**: commit bodies MUST describe ONLY changes actually present in the diff. Over-claiming a refactor / deletion / side-effect is BLOCKED. If the claim was made in error, push a FOLLOW-UP commit that delivers what the prior message said — do NOT amend.

**Why:** Issues closed without code refs break traceability; undocumented workarounds force every session to re-discover the same fix; over-claiming commit bodies poison `git log --grep` (the cheapest institutional-knowledge search). See extract for full DO/DO NOT examples.


---

# repo-scope-discipline.md

---
priority: 0
scope: baseline
---

# Repo Scope Discipline — Stay In This Repo

See `.claude/guides/rule-extracts/repo-scope-discipline.md` for full BLOCKED-rationalization enumerations, extended DO/DO NOT examples, the orchestration-root exception detail, and origin post-mortem.

The repo whose root is the session's CWD defines the agent's entire scope of action. An agent operating in this repo MUST NOT touch, edit, push to, file issues against, comment on, read source from, or even propose work in any other repository — sibling SDKs, USE templates, upstream authorities (`loom/`, `atelier/`), downstream consumer projects, or any other GitHub repo — under any circumstance from this repo's session. Cross-repo work requires the user to context-switch (open Claude Code in the target repo); the agent does NOT make that switch on the user's behalf.

## MUST NOT

- Run `gh` commands against any repo other than this session's CWD repo, OR read source/specs/tests/session notes from any other repository under `~/repos/` to inform this session

**Why:** Cross-repo `gh` invocations and file reads contaminate the session's framing — recommendations cite paths and primitives that don't exist in the CWD repo, and the user has to mentally untangle which advice applies where.

- Suggest "context-switch to <other repo>", "next-turn pick: <other repo>", "the higher-priority workstream lives in <other repo>", or any equivalent framing that pushes the user toward a different repo. Sweep-style memories ("always check all three repos") are NOT license to cross repo boundaries inside an in-repo session

**Why:** The user opens the repo they want to work on; cross-repo prioritization is theirs to make, not the agent's to surface. Sweep memories apply at the orchestration root (`~/repos/`) ONLY — misapplying them inside a BUILD or USE repo is the originating failure mode this rule blocks.

- Write to, branch in, or modify the working tree of any sibling repository, OR file "upstream" issues against sibling SDKs unless the user is explicitly already filing and asks for body hygiene help

**Why:** Each repo has its own branch protection, ownership, release cadence, and rule set; cross-repo writes blur ownership and ship under rules the destination repo did not consent to. `upstream-issue-hygiene.md` describes BODY hygiene when filing IS happening; this rule blocks RECOMMENDING the filing one layer earlier.

## Exceptions

NONE for action. Descriptive sibling-repo mentions are OK when purely informational, not prescriptive. The rule does NOT apply at orchestration roots (`~/repos/`, `loom/`) where cross-repo coordination IS the legitimate purpose — `/sync`, `/sync-to-build`, `/inspect`, `/repos` cross repos by design.

---

# security.md

---
priority: 0
scope: baseline
---

# Security Rules

ALL code changes in the repository.

See `.claude/guides/rule-extracts/security.md` for extended examples, exhaustive sanitizer contract examples, and multi-site kwarg plumbing full post-mortem.

## No Hardcoded Secrets

All sensitive data MUST use environment variables.

**Why:** Hardcoded secrets end up in git history, CI logs, and error traces, making them permanently extractable even after deletion.

## Parameterized Queries

All database queries MUST use parameterized queries or ORM.

**Why:** Without parameterized queries, user input becomes executable SQL, enabling data theft, deletion, or privilege escalation.

## Credential Decode Helpers

Connection strings carry credentials in URL-encoded form. Decoding them at a call site with `unquote(parsed.password)` is BLOCKED — every decode site MUST route through a shared helper module so validation logic lives in one place.

### 1. Null-Byte Rejection At Every Credential Decode Site (MUST)

Every URL parsing site that extracts `user`/`password` from `urlparse(connection_string)` MUST route through a single shared helper that rejects null bytes after percent-decoding. Hand-rolled `unquote(parsed.password)` at a call site is BLOCKED.

**Why:** A crafted `mysql://user:%00bypass@host/db` decodes to `\x00bypass`; the MySQL C client truncates credentials at the first null byte and the driver sends an empty password. Drift between sites with/without the check is unauditable without a single helper. See guide for full evidence.

### 2. Pre-Encoder Consolidation (MUST)

Password pre-encoding helpers (`quote_plus` of `#$@?` etc.) MUST live in the same shared helper module as the decode path. Per-adapter copies are BLOCKED.

**Why:** Encode and decode are dual halves of one contract; splitting them across modules guarantees one half drifts. Round-trip tests are only meaningful when both ends share the helper.

## Input Validation

All user input MUST be validated before use: type checking, length limits, format validation, whitelist when possible. Applies to API endpoints, CLI inputs, file uploads, form submissions.

**Why:** Unvalidated input is the entry point for injection attacks, buffer overflows, and type confusion across every attack surface.

## Output Encoding

All user-generated content MUST be encoded before display in HTML templates, JSON responses, and log output.

**Why:** Unencoded user content enables cross-site scripting (XSS), allowing attackers to execute arbitrary JavaScript in other users' browsers.

## MUST NOT

- **No eval() on user input**: `eval()`, `exec()`, `subprocess.call(cmd, shell=True)` — BLOCKED

**Why:** `eval()` on user input is arbitrary code execution — the attacker runs whatever they want on the server.

- **No secrets in logs**: MUST NOT log passwords, tokens, or PII

**Why:** Log files are widely accessible (CI, monitoring, support staff) and rarely encrypted, turning every logged secret into a breach.

- **No .env in Git**: .env in .gitignore, use .env.example for templates

**Why:** Once committed, secrets persist in git history even after removal, and are exposed to anyone with repo access.

## Sanitizer Contract — DataFlow Display Hygiene

DataFlow's input sanitizer (`packages/kailash-dataflow/src/dataflow/core/nodes.py::sanitize_sql_input`) is a defense-in-depth display-path safety net, NOT the primary SQLi defense. Parameter binding (`$N` / `%s` / `?`) is the primary defense — see § Parameterized Queries above.

### 1. String Inputs MUST Be Token-Replaced, Not Quote-Escaped

For declared-string fields, the sanitizer MUST replace dangerous SQL keyword sequences with grep-able sentinel tokens (`STATEMENT_BLOCKED`, `DROP_TABLE`, `UNION_SELECT`, etc.). Quote-escaping (`'` → `''`) is BLOCKED.

**Why:** Token-replace makes attacker intent grep-able post-incident (`grep STATEMENT_BLOCKED audit.log`). Quote-escape preserves the payload as data, masking the attack. Sanitizer is the audit trail; parameter binding is the defense.

### 2. Type-Confusion MUST Raise, Not Silently Coerce

For declared-string fields receiving `dict` / `list` / `set` / `tuple` values, the sanitizer MUST raise `ValueError("parameter type mismatch: …")`. Silent coercion via `str(value)` is BLOCKED.

**Why:** A malicious upstream node passing `{"injection": "'; DROP TABLE …"}` for a str-declared field bypasses every string-only check. Raising at the type-confusion boundary closes the bypass; coercion-to-string converts a structural attack into an unaudited storage event.

### 3. Safe Types Are Returned As-Is

Values of declared-safe types (`int`, `float`, `bool`, `Decimal`, `datetime`, `date`, `time`) MUST pass through unchanged. `dict` and `list` MUST also pass through unchanged when the field's declared type is `dict` or `list` (JSON / array columns). Bug #515: premature `json.dumps()` on dict/list breaks parameter binding.

## Multi-Site Kwarg Plumbing

When a security-relevant kwarg (classification policy, tenant scope, clearance context, audit correlation ID) is plumbed through a helper, EVERY call site of that helper MUST be updated in the SAME PR. Updating the "primary" call site and deferring siblings is BLOCKED.

**Why:** A helper takes a security-relevant kwarg precisely because the unqualified call leaks or misbehaves. Leaving any sibling on the unqualified signature ships the exact failure mode the kwarg was introduced to fix; the "safe default" is by definition the insecure default. Fix is mechanical: `grep -rn 'helper_name(' .` + patch every hit.

## Kailash-Specific Security

- **DataFlow**: Access controls on models, validate at model level, never expose internal IDs
- **Nexus**: Authentication on protected routes, rate limiting, CORS configured
- **Kaizen**: Prompt injection protection, sensitive data filtering, output validation

## Exceptions

Security exceptions require: written justification, security-reviewer approval, documentation, and time-limited remediation plan.

---

# sweep-completeness.md

---
priority: 0
scope: baseline
---

# Sweep / Multi-Step Protocol Completeness

See `.claude/guides/rule-extracts/sweep-completeness.md` for the full BLOCKED-rationalization enumeration, extended DO/DO NOT examples, the cross-rule relationship list, the tool-backing pattern, and the 2026-05-04 origin post-mortem.

When a skill, command, or rule prescribes a multi-step protocol and the agent identifies any step as too expensive / "needs separate trigger" / "deferrable to /redteam" / "out of sweep tempo", the agent MUST stop and ask the human BEFORE substituting a cheaper proxy. Silent substitution is BLOCKED. Appeal to precedent ("yesterday's sweep skipped this step too") does NOT authorize today's substitution — yesterday's skip was its own failure.

The substitution decision is the trigger. The human is the gate.

## MUST Rules

### 1. Substitution Decision Triggers a Human Gate

When the agent identifies a mandated step as too expensive to run inline AND the skill/command/rule does not explicitly authorize the substitution, the agent MUST stop and surface to the human: WHICH step is being skipped, WHY (cost / time / "needs trigger"), WHAT proxy is being considered, WHAT coverage is lost, and ASK skip / substitute / run-full / different-approach.

**Why:** Substitution feels efficient and goes invisibly until someone asks "what did you actually check?" By then the report has shipped, the next session inherits the framing, and the gap silently widens.

### 2. Proxy Output MUST Be Labeled, Never Relabeled

If the agent substitutes a cheap proxy after human-gated approval, the proxy's output MUST be labeled with the proxy's own name in the report — never as the mandated step's result. `Sweep 5: 0/0/0 cite-check (substituted per user approval)` is fine. `Sweep 5: 0/0/0 (clean)` is BLOCKED.

**Why:** A reader of the sweep report cannot tell, from the second form, that the mandated step did not run. The agent's substitution becomes invisible institutional knowledge.

### 3. Skill / Command Text Tightening Is The Long-Term Fix

When a skill repeatedly produces substitution decisions, the skill text itself is the leverage point — propose a `/codify` upstream that either (a) tightens prose into a tool invocation (e.g., `commands/sweep.md` Sweep 5 → `tools/sweep-redteam.py` invocation), or (b) explicitly authorizes substitution with named bounds. This rule is run-time defense; tool-backed skill text is design-time defense. Both layers needed.

**Why:** A rule that fires every cycle is a signal that the structural defense is wrong. Recurring substitutions need design-time tooling so the gate stops firing.

## MUST NOT

- Silently substitute a cheaper tool for a mandated multi-step protocol step

**Why:** This is the originating failure mode — invisible to readers, propagates as institutional drift.

- Cite "yesterday's sweep did the same" as authorization

**Why:** Yesterday's substitution was its own failure; treating it as precedent compounds the gap.

- Label the proxy's output as the mandated step's result

**Why:** It removes the audit trail that allows the next reader to know the mandated step didn't run.

---

# verify-resource-existence.md

---
priority: 0
scope: baseline
---

# Verify Resource Existence Before Debugging Access

See `.claude/guides/rule-extracts/verify-resource-existence.md` for full DO/DO NOT examples, BLOCKED-rationalization enumerations, and origin post-mortem.

When a tool fails with a permission error (HTTP 403, "access denied", "insufficient scope") against a named external resource, the FIRST diagnostic action MUST be to verify the resource exists. Recursing on the permission axis against an absent resource produces unbounded credential-rotation cycles.

## MUST Rules

### 1. Existence Check Precedes Permission Debugging

Any session responding to a 403/401/permission-denied against a named external resource MUST run an existence check against that resource as the first diagnostic action. Recommending PAT provisioning, scope expansion, or credential rotation BEFORE the existence check is BLOCKED.

**Why:** A 403 says "you cannot access this thing" — it does NOT say the thing exists. APIs return 403 for both "missing permission to access" AND "missing permission to discover existence" — identical message, opposite root cause. The existence check (one read query, <1 second) resolves the recursion.

### 2. The Existence Check MUST Cite The Endpoint, Not The Documentation

The verification command MUST be a live read against the same API surface the failing operation targets — NOT a grep against documentation, source comments, spec files, or the script's own intent statements. Trusting documentation as a proxy for runtime existence is BLOCKED.

**Why:** Documentation, source comments, and operator memory all describe INTENT. None are evidence of CURRENT runtime state. A spec can mandate a runner that operations never provisioned; a script can target a table left undefined by a half-finished migration; a workflow can read a secret that was rotated out of existence. The live API query is the only evidence; everything else is hearsay.

### 3. When Existence Check Fails, Default Disposition Is Delete-Or-Stub, Not Provision

If the existence check returns empty AND there is no active user request to provision the resource, the default disposition MUST be to delete the dependent code OR convert it to a no-op with a documented removal path. Recommending provisioning ("create the missing resource") is BLOCKED unless the user explicitly asked for that capability.

**Why:** Code targeting a non-existent resource is dead by definition — it cannot have ever worked. Removal is cheap and reversible; provisioning is expensive and durable (server costs, secret rotation, monitoring). Until the user asks for the capability, dead code is dead.

## MUST NOT

- Recommend credential creation (PAT, service account, API key) BEFORE the existence check has run

**Why:** Credential creation is operator-time-expensive and error-prone. Spending it on a non-existent target is the worst-case waste — operator spends real time to obtain a credential that unlocks nothing.

- Loop more than once on permission-scope variations against the same 403 without re-verifying existence

**Why:** Two consecutive failed scope attempts against the same 403 is the loud signal that the permission axis is the wrong axis. Existence check MUST fire automatically at the second failure if not at the first.

## Three-Layer Defense

1. Existence check FIRST — `gh api`, `psql \dt`, `kubectl get`, `aws describe-*`, etc.
2. If exists — proceed with permission/scope debugging (`rules/security.md`, `rules/ci-runners.md`).
3. If absent — default to removal; provisioning ONLY on explicit user request.

---

# zero-tolerance.md

---
priority: 0
scope: baseline
---

# Zero-Tolerance Rules

See `.claude/guides/rule-extracts/zero-tolerance.md` for extended BLOCKED-pattern examples and Phase 5 audit evidence.

## Scope

ALL sessions, ALL agents, ALL code, ALL phases. ABSOLUTE and NON-NEGOTIABLE.

## Rule 1: Pre-Existing Failures, Warnings, And Notices MUST Be Resolved Immediately

If you found it, you own it. Fix it in THIS run — do not report, log, or defer.

**Applies to** ("found it" includes, with equal weight):

- Test failures, build errors, type errors
- Compiler / linter warnings, deprecation notices
- WARN/ERROR in workspace logs since previous gate
- Runtime warnings (`DeprecationWarning`, `ResourceWarning`, `RuntimeWarning`)
- Peer-dependency / missing-module / version-resolution warnings

A warning is not "less broken" than an error. It is an error the framework chose to keep running through.

**Process:** diagnose root cause → fix → regression test → verify (`pytest` or project test cmd) → commit.

**Why:** Deferring creates a ratchet — every session inherits more failures; codebase degrades faster than any single session can fix. Warnings are the leading indicator: today's `DeprecationWarning` is next quarter's "it stopped working when we upgraded".

**Mechanism:** The log-triage protocol in `rules/observability.md` Rule 5 has concrete scan commands. If `observability.md` isn't loaded (config-file edits), MUST still scan most recent test runner + build output for WARN+ entries before reporting any gate complete.

**Exceptions:** User explicitly says "skip this"; OR upstream third-party deprecation unresolvable in this session → pinned version + documented reason OR upstream issue link OR todo with explicit owner. Silent dismissal still BLOCKED.

### Rule 1a: Scanner-Surface Symmetry

Findings reported by a security scanner on a PR scan MUST be treated identically to findings on a main scan. "This also exists on main, therefore not introduced here" is BLOCKED.

**Why:** "Same on main" is the institutional ratchet that defers fixes forever. Rule 1 covers this in spirit; an explicit scanner-surface clause closes the rationalization gap. See guide for `__all__` / `__getattr__` second-instance variant (PR #506).

### Rule 1b: Scanner Deferral Requires Tracking Issue + Runtime-Safety Proof

Rule 1a mandates that scanner findings MUST be fixed, not dismissed. A LEGITIMATE deferral disposition exists for findings that are provably runtime-safe AND require architectural refactor out of release-scope — but ONLY if all four conditions are met. Missing any one of them, the "deferral" IS silent dismissal under a different name and is BLOCKED.

Required conditions (ALL four):

1. **Runtime-safety proof** — the finding is verified safe (e.g., every cyclic import is `TYPE_CHECKING`-guarded; the "unsafe" path is unreachable at runtime). Verification is a PR comment citing the guard lines.
2. **Tracking issue** — filed against the repo with title `codeql: defer <rule-id> — <short-context>`, body including acceptance criteria for the full fix.
3. **Release PR body link** — the tracking issue is linked from the release PR's body with explicit "deferred, safe per #<issue>" language.
4. **Release-specialist agreement** — release-specialist confirms the deferral in review OR user explicitly overrides with "full fix".

**Why:** Without written runtime-safety proof + tracking issue + release PR link + release-specialist signoff, a "deferred" finding is indistinguishable from a silent dismissal — nothing forces the follow-up and nothing surfaces the backlog. The four conditions are the structural defense: verification is the grep-able claim; the tracking issue is the workstream; the release PR link is the audit trail; the release-specialist signoff is the human gate. Rule 1a blocks dismissal; Rule 1b documents the ONLY legitimate path to defer.

### Rule 1c: "Pre-Existing" Is Unprovable After Context Boundary

Any disposition that classifies an issue as "pre-existing", "not introduced in this session", or "outside the session's blast radius" MUST cite a specific commit SHA AND demonstrate that the SHA pre-dates the session's first tool call. After `/clear`, auto-compaction, conversation resume, sub-agent handoff, or any other context boundary, the agent has no audit trail of its prior-turn edits — the "pre-existing" claim is structurally unfalsifiable and is BLOCKED. The disposition under uncertainty is: fix it.

**Why:** Wrapper-default scope discipline (CC's "a bug fix doesn't need surrounding code cleaned up", `~/repos/contrib/claude-code-source-code/src/constants/prompts.ts:201`) is sound for short-horizon coding assistants where the agent's edit log IS the session log. In COC's long-horizon institutional codebase, sessions cross `/clear`, auto-compaction, and resume boundaries that erase the edit log; the agent's recall is no longer evidence. `git blame` is also insufficient — the agent may have re-introduced an old bug via a same-session refactor that blame attributes to the original author. The structural defense is symmetric: either cite a SHA that proves pre-existence relative to session start, or fix it. "Pre-existing" without provenance grounding is BLOCKED regardless of how confident the claim feels.

## Rule 2: No Stubs, Placeholders, Or Deferred Implementation

Production code MUST NOT contain:

- `TODO`, `FIXME`, `HACK`, `STUB`, `XXX` markers
- `raise NotImplementedError`
- `pass # placeholder`, empty function bodies
- `return None # not implemented`

**No simulated/fake data:** `simulated_data`, `fake_response`, `dummy_value`, hardcoded mock responses, placeholder dicts. **Frontend mock is a stub too:** `MOCK_*`, `FAKE_*`, `DUMMY_*`, `SAMPLE_*` constants; `generate*()` / `mock*()` producing synthetic display data; `Math.random()` for UI.

**Why:** Frontend mock data is invisible to Python detection but has the same effect — users see fake data presented as real.

**Extended BLOCKED patterns** (Phase 5 audit + kailash-ml-audit W33b) — see guide for full code examples:

- **Fake encryption** — class stores `encryption_key` but `set()` writes plaintext. Audit trail shows "encrypted"; disk shows plaintext.
- **Fake transaction** — `@contextmanager` named `transaction` that commits after every statement (no BEGIN/COMMIT/rollback).
- **Fake health** — `/health` returns 200 without probing DB/Redis. Orchestrators make routing decisions on lies.
- **Fake classification / redaction** — `@classify(REDACT)` stored but never enforced on read. Documented security control ships as no-op.
- **Fake tenant isolation** — `multi_tenant=True` flag with cache key missing `tenant_id` dimension.
- **Fake integration via missing handoff field** — frozen dataclass on pipeline's critical path omits the field the NEXT primitive needs. Each primitive's unit tests pass (each constructs its own fixture); the advertised 3-line pipeline breaks on every fresh install. Fix: add missing field; populate at every return site; add Tier-2 E2E regression (see `rules/testing.md` § End-to-End Pipeline Regression). Evidence: kailash-ml W33b `TrainingResult(frozen=True)` without `trainable`; `km.register` raised `ValueError` on fresh install.
- **Fake metrics** — silent no-op counters because `prometheus_client` missing + no startup warning. Dashboards empty while operators believe they're reporting.
- **Fake dispatch** — accepted in a `Literal[...]` / `Enum` / declared-string-set dispatch parameter, but no branch in the dispatcher. Every accepted literal MUST have a corresponding branch in the function body. The validator gate (`if kind not in {"x", "y", "z"}: raise`) followed by a dispatcher that branches only on `"x"` and falls through to a default for `"y"` and `"z"` IS the same failure-mode class as fake encryption / fake transaction / fake health: the documented contract advertises a feature the code does not implement. Evidence: kailash-ml `_wrappers.py:474–485` accepted `kind="clustering"`, `"alignment"`, `"llm"`, `"agent"` as valid `Literal` values — none had a dispatch branch; every one fell through to `DLDiagnostics(subject)`. Documented in spec §3.1 as supported; silently broken in practice (#701 bonus finding). Detection: `/redteam` MUST AST-walk every `Literal[...]` / `Enum`-valued dispatch parameter and confirm every accepted literal has a `match` arm or `if`/`elif` branch. Rust's `match` exhaustiveness check structurally covers `enum DiagnosticKind`; `&str` dispatch in Rust does NOT — same gap if Rust adds a string-dispatch surface. Python lacks the structural check entirely; the rule is the only defense.

## Rule 3: No Silent Fallbacks Or Error Hiding

- `except: pass` (bare except + pass) — BLOCKED
- `catch(e) {}` (empty catch) — BLOCKED
- `except Exception: return None` without logging — BLOCKED

**Why:** Silent error swallowing hides bugs until they cascade into data corruption or production outages with no stack trace to diagnose.

**Acceptable:** `except: pass` in hooks/cleanup where failure is expected.

### Rule 3a: Typed Delegate Guards For None Backing Objects

Any delegate method forwarding to a lazily-assigned backing object MUST guard with a typed error before access. Allowing `AttributeError` to propagate from `None.method()` is BLOCKED.

**Why:** Opaque `AttributeError` blocks N tests at once with no actionable message; typed guard turns the failure into a one-line fix instruction.

### Rule 3c: Documented Kwargs Accepted But Unused

A documented kwarg accepted in the public signature but with zero effect on the function body IS the silent-fallback failure mode at API surface level. Every kwarg listed in the public signature AND documented in the spec MUST be consumed by at least one branch of the function body. Accepting a kwarg and dropping it on the floor is BLOCKED.

**Why:** A documented kwarg is a contract. A kwarg accepted into the signature, listed in the spec, and silently dropped IS a contract violation indistinguishable from a stub return — the user passes a real `DataLoader`, the function returns a result, the user's loader was never read. Same failure-mode class as `except: pass` (Rule 3) and fake encryption (Rule 2): the documented behavior advertises something the code does not perform. Detection: at every `def f(*, kw1, kw2, kw3)` boundary, confirm `kw1`, `kw2`, `kw3` each appear at least once in the function body OR are explicitly forwarded to a callee. If the parameter exists only to satisfy a type-checker or to defer implementation, raise `NotImplementedError` until the branch is wired — silent drop is BLOCKED.

### Rule 3d: Dual-Shape Return + Structural Guard = Silent Fallback

A property or method whose return type is a union of structurally-distinct shapes (e.g., `Union[ConfigWrapper(dict), KaizenConfig(dataclass)]`) MUST NOT be consumed via a structural existence guard (`hasattr(value, "method")`) that resolves True for one branch and False for the other. The guard silently flips False on the branch that lacks the attribute, and the documented behavior never fires for users on that branch. Either dispatch on a discriminator (`isinstance` / type check) OR collapse the API to a single return shape.

**Why:** A dual-shape API consumed via structural guard is the same failure-mode class as fake encryption / fake transaction / fake dispatch (Rule 2): the documented contract advertises a feature the code does not perform on every branch. Tests written against the structurally-richer branch (dict has `.get`) silently mask the gap; users on the typed branch get a no-op. Detection: at every `hasattr(x, "<method>")` callsite where `x` has a union return type, walk back to the declared type — if any branch lacks `<method>`, the guard is silently flipping for that branch's users. Either dispatch on a discriminator (the consumer KNOWS which shape it has) or collapse the API (one shape eliminates the ambiguity).

## Rule 4: No Workarounds For Core SDK Issues

This is a BUILD repo. You have the source. Fix bugs directly.

**Why:** Workarounds create parallel implementations that diverge from the SDK, doubling maintenance cost and masking the root bug.

**BLOCKED:** Naive re-implementations, post-processing, downgrading.

## Rule 5: Version Consistency On Release

ALL version locations updated atomically:

1. `pyproject.toml` → `version = "X.Y.Z"`
2. `src/{package}/__init__.py` → `__version__ = "X.Y.Z"`

**Why:** Split version states cause `pip install kailash==X.Y.Z` to install a package whose `__version__` reports a different number, breaking version-gated logic.

## Rule 6: Implement Fully

- ALL methods, not just the happy path
- If endpoint exists, it returns real data
- If service is referenced, it is functional
- Never leave "will implement later" comments
- If you cannot implement: ask the user what it should do, then do it. If user says "remove it," delete the function.

**Test files excluded:** `test_*`, `*_test.*`, `*.test.*`, `*.spec.*`, `__tests__/`

**Why:** Half-implemented features present working UI with broken backend — users trust outputs that are silently incomplete or wrong.

**Iterative TODOs:** Permitted when actively tracked (workspace todos, issue-linked).

### Rule 6a: Remove Fully — Public-API Removal Requires Deprecation Cycle

Public-API removal MUST land with a `DeprecationWarning` shim covering at least one minor cycle, plus a CHANGELOG migration section explicitly documenting the 1.x → next-1.x callsite change. Removal-without-shim is BLOCKED. The removal is "complete" only when the shim has lived through one minor release AND the CHANGELOG migration entry is in place.

**Why:** Public-API removal without a deprecation cycle hard-breaks every downstream callsite on first import after `pip upgrade` / `cargo update`. The user did nothing wrong; their code worked yesterday and stops working today with a TypeError or NameError that gives no migration path. The deprecation shim converts a hard break into a warning the user can act on; the CHANGELOG migration section converts "what do I do now?" into "follow these 3 steps." Same structural-completion principle as Rule 6 (Implement Fully): a removal that ships without shim + CHANGELOG entry is half-implemented — the new API works, but the migration path is missing.
