---
priority: 10
scope: path-scoped
paths:
  - "**/specs/**"
  - "**/specs/_index.md"
  - "**/workspaces/**"
  - "**/briefs/**"
  - "**/02-plans/**"
  - "**/todos/**"
---

# Specs Authority Rules

See `.claude/guides/rule-extracts/specs-authority.md` for Rule 5b/5c evidence (two-session reproducibility + W32/W33 amend-at-launch post-mortem) and extended examples.

The `specs/` directory is the single source of domain truth for a project. Detailed spec files organized by the project's own ontology — components, modules, user needs, domains. Phase commands read targeted spec files before acting and update them when domain truth changes.

`specs/` is NOT a process artifact (that's `workspaces/`). It is the detailed record of WHAT the system is and does, not HOW we are building it. Plans, todos, and journals continue to serve their existing roles.

Origin: Analysis of 6 alignment-drift failure modes across COC phase system.

## MUST Rules

### 1. Every Project Has A `specs/` Directory With `_index.md`

`/analyze` MUST create `specs/` at project root with an `_index.md` manifest listing every spec file + one-line description. Phases read `_index.md` to find relevant files, then read only those.

```markdown
# DO — lean lookup table

| File              | Domain | Description                              |
| ----------------- | ------ | ---------------------------------------- |
| authentication.md | Auth   | Login/register flows, JWT, session mgmt  |
| data-model.md     | Data   | All entities, relationships, constraints |

# DO NOT — actual specifications inline in \_index.md
```

**Why:** Without an index, phases must read every spec file to find relevant content, defeating token efficiency. Without specs/, alignment drifts as phases work from stale memory.

### 2. Spec Files Are Organized By Domain Ontology, Not Process

```
# DO — domain-organized
specs/authentication.md / billing.md / data-model.md / notifications.md / tenant-isolation.md

# DO NOT — process-organized (duplicates workspaces/)
specs/intent.md / decisions.md / progress.md / boundaries.md
```

**Why:** Process-organized specs duplicate the workspace directory structure. Domain-organized specs capture WHAT the system does — exactly what drifts during implementation.

### 3. Spec Files Are Detailed, Not Summaries

Each spec file MUST be comprehensive enough to be the authority on its topic. Every nuance, constraint, edge case, contract, decision.

```markdown
# DO — detailed authority

## Login Flow

1. User submits email + password to POST /api/v1/auth/login
2. Server validates credentials against bcrypt hash
3. On success: generate JWT (RS256, 24h expiry), set HttpOnly cookie
4. On failure: increment failed_attempts
5. If failed_attempts >= 5: lock account, require email verification
6. Rate limit: 10 attempts per IP per minute (429)

# DO NOT — thin summary

## Login Flow

Users can log in with email and password. JWT is used. Failed logins tracked.
```

**Why:** Thin summaries lose the exact details agents need. "JWT tokens are used" doesn't tell the agent RS256 vs HS256, expiry, cookie strategy — these omissions become the bugs.

### 4. Phase Commands Read Specs Before Acting

Each phase MUST read `specs/_index.md` at start, identify relevant files, read those before taking action. MUST NOT read the entire `specs/` directory — only files relevant to current work.

**Why:** Working from memory instead of specs is the root cause of incremental mutation divergence (FM-5). Agents recall 3 of 15 details; the other 12 become bugs.

### 5. Spec Files Are Updated At First Instance

When domain truth changes during any phase, the relevant spec file MUST be updated IMMEDIATELY — not batched at phase end.

```
# DO — update when the truth changes
1. Implement todo changing UserService.create_user() signature
2. Immediately update specs/user-management.md with new signature
3. Continue

# DO NOT — batch for later
```

**Why:** Batched updates create a staleness window where other agents or the next session read outdated specs. First-instance updates keep specs current within one action.

### 5b. Spec Edits MUST Trigger Full Sibling-Spec Re-Derivation

Every spec edit MUST trigger a re-derivation sweep against the FULL sibling-spec set in the same domain (editing `specs/ml-engines.md` triggers all `specs/ml-*.md`). Scoping to "specs I just edited" is BLOCKED — three categories of finding ONLY emerge from full-sibling sweep:

1. **Field-shape divergence** — sibling specs reference changed dataclass differently
2. **Downstream consumer drift** — specs whose mandates depend on changed surface are now stale
3. **Cross-spec terminology drift** — same concept named two ways across files

```bash
# DO — edit one spec, grep ALL siblings for references, re-derive assertions
ls specs/ml-*.md                          # enumerate full sibling set
grep -l "TrainingResult" specs/ml-*.md    # find downstream consumers
# Re-derive for EACH matching sibling, not just the edited file

# DO NOT — narrow scope
# (ml-backends.md references TrainingResult.backend/.devices as top-level fields
#  after ml-engines.md moved them — drift invisible to narrow scope)
```

**BLOCKED rationalizations:** "I only edited one spec, others are out of scope" / "/redteam scoped to diff is faster" / "siblings re-derive when THEY are edited" / "cross-spec drift is codify's concern" / "round 3 was green on edited specs, re-run is redundant".

**Why:** Spec domains share vocabulary, dataclasses, invariants; editing one dataclass without re-deriving the full sibling set lets narrow-scope APPROVE verdicts ship with silent cross-spec drift. Two-session reproducibility (journal 0007 / 0008) confirmed: narrow-scope sweep produced "14/14 green" APPROVE; full-sibling sweep found 9 HIGH cross-spec drift findings in specs the edit never touched.

### 5c. Orchestrator MUST Amend Todo Text At Launch When Spec Has Moved

Before launching any `/implement` shard agent, orchestrator MUST cross-check todo claims (version bumps, `__all__` counts, public-surface symbol lists, spec section refs) against current canonical spec AND current package state (`pyproject.toml`, `__init__.py`, prior merged shards). Discrepancies MUST be resolved IN THE TODO TEXT before launch — not left for the agent to discover mid-implementation. Launching with a known-stale todo is BLOCKED.

```markdown
# DO — amend at launch time, note inline

Todo W32b says: "bump kailash-align 0.4.0 → 0.5.0"
Current state: W30.3 already shipped align 0.5.0 (commit 41a217dc).
→ AMEND AT LAUNCH: "bump kailash-align 0.5.0 → 0.6.0"

Todo W33 says: "`__all__` exports 34 symbols"
Spec §15.9 says: "`__all__` exports 41 symbols (40 + erase_subject)"
→ AMEND AT LAUNCH: prefer spec per §5b, prompt agent with 41.

# DO NOT — launch with stale todo, let agent hit the conflict mid-flight
```

**BLOCKED rationalizations:** "agent is smart enough to read current state" / "todo was approved, amending is scope creep" / "let the agent hit the conflict and learn" / "spec will be re-read at implement time anyway".

**Why:** Todos are written at `/todos` time against state-of-repo-then; by `/implement` time the state has moved — prior shards have shipped, specs have been edited during `/redteam` convergence. An orchestrator that launches a stale todo burns the agent's budget on re-derivation AND risks shard failure (version-tag collision, symbol-count mismatch). 2-minute launch-time amendment < ANY shard re-run. Evidence: kailash-ml-audit 2026-04-23 W32-32b (0.5→0.6 amend) + W33 (34→41 symbol count) — both saved failed shards.

### 6. Deviations From Spec Require Explicit Acknowledgment

When implementation deviates from a spec, agent MUST: (a) update the spec with new truth, (b) log deviation with rationale, (c) flag user-visible changes for approval.

```markdown
# DO

## Notifications

~~Real-time via WebSocket~~ → Polling every 5s (changed 2026-04-11)
**Reason:** WebSocket requires dedicated server; polling achievable with current infra
**User impact:** 5s delay. User notified: YES

# DO NOT — silent divergence (spec says WebSocket, code does polling, nobody knows)
```

**Why:** Silent deviations are #1 cause of "it works but it's not what I asked for." The spec is the contract.

**BLOCKED responses:** "the spec said X, and X is implemented" (when approach differs) / "implementation detail, not a spec change" / "spec is aspirational, code is what matters" / "I'll update after implementation stabilizes".

### 7. Agent Delegation Includes Relevant Spec Files

When delegating to a specialist, orchestrator MUST read `_index.md`, select relevant spec files, include content in the delegation prompt. For specs over 200 lines, include only the relevant section with a pointer to the full file.

```
# DO — include spec content
Agent(prompt: "Build user schema.\n\nFrom specs/data-model.md:\n[content]\n\nFrom specs/tenant-isolation.md:\n[content]")
# DO NOT — delegate without specs context
Agent(prompt: "Build user schema.")
```

**Why:** Specialists without spec context produce intent-misaligned output — e.g., schemas without tenant_id because multi-tenancy wasn't communicated (FM-4).

### 8. Large Spec Files Are Split

When a spec file exceeds 300 lines, it MUST be split into sub-domain files and `_index.md` updated. Each sub-file must be self-contained for its sub-domain.

**Why:** Oversized spec files crowd out implementation reasoning when loaded into context, and make delegation prompts enormous.

### 9. Workspace Specs Reference Canonical Artifacts (Not Restate)

When a workspace spec describes the mechanism of a canonical artifact (a command, rule, skill, hook, or agent under `.claude/`), the spec MUST cite the artifact by `<path>:<line>` (or `<path> §<section>`) rather than restating the artifact's verbatim content.

```text
# DO — workspace spec references canonical source

The lint at `.claude/commands/cc-audit.md:35` flags any non-`paths:` key in
opening rule frontmatter. Block-scoping is preserved by the `i==1` predicate
(see line 35 of the canonical command).

# DO NOT — workspace spec restates the implementation

awk 'FNR==1{i=0} /^---$/{i++; next} i==1 && ...' .claude/rules/*.md

(verbatim copy of the awk line that already lives in
`.claude/commands/cc-audit.md:35` — update to one without
the other creates silent drift)
```

**BLOCKED responses:**

- "Restating makes the spec self-contained, which is more readable"
- "The reader shouldn't have to open the canonical artifact to understand the spec"
- "Specs and canonical artifacts will stay in sync; nothing to worry about"
- "Both versions are short — duplication is fine"

**Why:** Workspace specs describe semantics while canonical artifacts encode implementation; restating implementation in specs creates parallel sources of truth that drift silently. The reference style forces the canonical artifact to be the single source of truth and forces specs to focus on what they uniquely contribute — semantics, invariants, and rationale.

**Exception:** Educational specs in `.claude/rules/` that show DO / DO NOT implementations per `rules/cc-artifacts.md` MUST §3 are explicitly NOT covered by this rule — those examples teach by restating. The exception applies only to *workspace* specs (under `workspaces/<project>/specs/`), not canonical rule files.

Origin: atelier `cc-audit-lint-generalize` 2026-05-03 (test fixtures and spec canonicalization deferred to /codify; /vet adversarial round L1). Inbound from atelier `/sync-to-coc`.

## MUST NOT

- Organize specs by COC process stages (duplicates workspaces/)
- Read entire `specs/` at any phase gate (except `/redteam`, `/codify` audit)
- Treat specs as optional documentation

**BLOCKED:** "Specs can be written after implementation" / "The code is the spec" / "Plans already capture this" / "Updating specs for minor change is overkill"

Origin: 6 drift failure-mode analysis + journal 0007 / 0008 (full-sibling re-derivation, 2026-04-19/20) + kailash-ml-audit 2026-04-23 (amend-at-launch W32/W33). See guide for full two-session post-mortem.
