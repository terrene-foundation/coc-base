---
name: multi-operator-coordination
description: Multi-operator coordination substrate — operator identity, signed append-only coordination log, claim/lease primitives, per-operator posture + gate authority; the always-on agent-facing behavioral contract. Full §1–§8 architecture + MUST-4/5/6/7 substrate-integrity contracts live in the paired skill. Fires whenever a session edits shared repo state in a repo with ≥2 enrolled operators.
priority: 10
scope: path-scoped
paths: ["**/*"]
---

# Multi-Operator Coordination Substrate

N humans run concurrent sessions against ONE shared repo (N clones of ONE remote), editing the same or adjacent code. The substrate uses native COC primitives only — git-native cryptography (commit-signing keys, `gh api`), no coordination service. The threat model is **bounded-trust** (the adversary is a legitimate team member with repo write access seeking privilege escalation, impersonation, attribution evasion, or teammate sabotage): the substrate **prevents** where an immutable git-native or GitHub-server anchor exists, **detects-eventually** elsewhere.

**Opt-in, OFF by default.** Every gate below FIRST consults `isCoordinationEnabled(repoDir)` (`.claude/hooks/lib/coordination-mode.js`) and early-returns to passthrough when OFF — a solo / un-enrolled repo pays nothing and gets no `/whoami` nag (W1, journal/0330/0331). ON = explicit `ecosystem.json::coordination.enabled` / local override, OR the implicit fallback (roster present AND genesis anchored — the ~12 already-enrolled repos). When ON, every gate's behavior is byte-unchanged from the pre-W1 substrate.

**Enforcement is in the hooks + fold rules, not this prose.** The structural defenses — `adjacency-leasecheck.js`, `operator-gate.js`, `integrity-guard.js`, the 10 fold rules, `fold-rule-9c.js`, `archive-ref.js::verifyArchiveTipPin`, the codex-mcp-guard validator-13 — fire regardless of whether this body is in context. This rule is the always-on **agent-facing behavioral contract** (§1 + MUST-1/2/3 + the state-write MUST-NOTs); the full substrate architecture — the complete §1–§8, the 10 fold rules, the MUST-4/5/6/7 substrate-integrity contracts, the full Trust-Posture Wiring + detection mechanisms, and the F-series forest registry — lives in **`.claude/skills/30-claude-code-patterns/multi-operator-coordination-substrate.md`**. Every `§N` / `MUST-N` anchor cited below resolves there. **Read the skill before authoring or auditing any substrate code** (a hook, a fold rule, `genesis-ceremony.js`, the roster, the coordination log).

## §1 Identity + roster (always-on essentials)

Operator identity is a triple resolved by `lib/operator-id.js::resolveIdentity(cwd)`:

- **`display_id`** — advisory, human-readable signage. Collisions are harmless. Tooling MUST attribute via `verified_id`, NEVER `display_id`.
- **`verified_id`** — fingerprint of a commit-signing key; authenticates a _record_.
- **`person_id`** — the unit of authority (one `person_id` → one human → `role` + enrolled keys). Immutable; keys append-only; adding a key/`person_id` is a 2-of-N quorum roster edit.
- **`host_role: ci`** — CI / deploy-key identities are **audit-only**: NEVER eligible to co-sign owner-quorum, distinctness, gate-approval, or genesis/migration records.
- **`business_roles`** (OPTIONAL, advisory array ∈ {`platform-engineer`, `capability-engineer`, `business-consultant`}) — the role-first operating-model classification. **Advisory + capability-scoping ONLY:** NEVER quorum-eligible, NEVER consulted by any distinctness or gate predicate, **orthogonal** to BOTH the authority `role` (owner/senior/contributor) AND the trust-posture (L1–L5). It is the **Class-C role-scoped-capability** axis (`artifact-flow.md` § Distribution-Durability Invariants) — scopes WHICH capability an operator may exercise, never WHETHER a write survives the pipeline. `product-owner` is NOT a roster value. Full derivation: skill §1.

Un-rostered keys run at `L2_SUPERVISED` (`trust-posture.md`); the session-start surface routes them into `/whoami --register` (the only path that lands a roster edit).

```bash
# DO — attribute via verified_id; display_id is presentation only
verified_id=$(git config user.signingkey)
# DO NOT — attribute by display_id (collisions harmless = unsafe for authority)
gate_authority_check "$(git config user.name)"     # WRONG axis
```

**Why:** Two operators sharing a `display_id` ("Alex") collide harmlessly on a banner but catastrophically on a gate decision; `verified_id` is the cryptographic primitive, `person_id` the authority unit, `display_id` only signage.

## Always-on behavioral MUST clauses

### MUST-1: Every Coordination-Log Record MUST Be Stamped, Chained, And Signed

Every append to `.claude/learning/coordination-log.jsonl` MUST traverse `coc-append.js` (or `lib/coordination-log.js`) so the record lands stamped with `verified_id` + `person_id`, hash-chained against the emitter's `prev_hash`, and signed over canonical content. Hand-written JSONL appends are BLOCKED.

```text
# DO — append via the canonical helper
coc-append.js heartbeat
# DO NOT — hand-write JSONL (no sig, no chain; fold rule 1/2 reject it; siblings see nothing)
echo '{"type":"heartbeat", ...}' >> .claude/learning/coordination-log.jsonl
```

**Why:** Fold rule 1 rejects unverified records and rule 2 rejects broken chains; a hand-written append silently drops on every sibling clone's fold and provides no audit trail.

### MUST-2: SAME-Class Edits Require A Prior `/claim`

Any edit to a path matching an active SAME-class claim OR adjacency relation (skill §3) MUST be preceded by a successful `/claim` of that scope. SAME-conflict halts (`halt-and-report`); ADJACENT surfaces a banner (`advisory`); INDEPENDENT silently auto-claims. Editing-then-claiming retroactively is BLOCKED.

```text
# DO — claim before editing a SAME-class scope
/claim packages/kailash/src/auth/**   # halts if a sibling holds the same scope
# DO NOT — edit then claim retroactively (the claim now documents a contest it cannot prevent)
```

**Why:** A retroactive claim cannot prevent the contest it documents; the F2-1 residual exists precisely because two operators can both adjudicate "proceed" if claim ordering is reversed.

### MUST-3: Gate Approvals Require Distinct `person_id` AND Distinct Bound-GitHub-Collaborator-Login

`operator-gate.js` MUST reject any `gate-approval` whose approver `person_id` matches the requester OR (owner/senior gates) whose approver's bound GitHub-collaborator-login matches the requester's. `host_role: ci` is NEVER an eligible approver. Self-approval via a second `verified_id` under the same `person_id` is BLOCKED.

```text
# DO — /release blocks until a DISTINCT-person owner co-signs gate-approval
# DO NOT — self-approve via a sibling key under the same person_id (person_id collision → gate blocks)
```

**Why:** A second `verified_id` under the same `person_id` is the same human; the distinctness check is the gate's only meaning, and GitHub-collaborator-login distinctness closes the single-human-two-accounts quorum-defeat.

## MUST NOT (always-on)

- **Edit `.claude/learning/coordination-log.jsonl`, `posture.json`, or `operators.roster.json` directly via the file-edit/shell tools.** Settings `permissions.deny` enforces this; the only legitimate writers are the canonical helpers (`coc-append.js`, the posture hook, the roster ceremony).

  **Why:** State self-modification is the rationalization loophole that defeats the substrate — a hand-edit can append unsigned records, downgrade posture without a signed event, or bind an arbitrary key to an owner `person_id`.

- **Sync `posture.json` / `coordination-log.jsonl` / `violations.jsonl` (or any `.claude/learning/` state) between repos via `/sync` / `/sync-to-build`.** State is per-repo per-clone; insight (rules/skills/hooks) syncs through `/codify`, state stays local.

  **Why:** A USE template inheriting a BUILD repo's degraded posture corrupts downstream; a shared log breaks the per-emitter chain (each clone has its own `clone-init` witness).

- **Positional cross-repo path construction in coordination tooling.** Any hook/agent/command/helper needing another repo's location MUST resolve via `bin/lib/loom-links.mjs::resolveRepo` (`cross-repo.md` MUST-1); `~/repos/<name>` / `../<name>` / `path.join(HOME, "repos", <name>)` is BLOCKED.

  **Why:** Positional guessing makes the NAME→location binding silently operator-dependent — one operator's tooling resolves the right directory and a sibling's resolves nothing.

## Substrate reference map — full contract in the skill

The skill (`.claude/skills/30-claude-code-patterns/multi-operator-coordination-substrate.md`) carries the complete §2–§8 architecture + the substrate-integrity MUST clauses below — each **enforced structurally** by the named hook / fold-rule / validator, NOT by this prose. Read it before authoring or auditing substrate code. Cited anchors resolve there:

- **§2 — coordination event log + the 10 fold rules** (record types; signature-gate / chain-integrity / fork-detection folds; boundary hooks `integrity-guard.js` / `signing-mutation-guard.js` / `journal-write-guard.js`; the opt-in `isCoordinationEnabled` gating above).
- **§3 — claims/leases + the SAME / ADJACENT / INDEPENDENT relation** (lease severities; `/claim`, `/claims`, `/release-claim`; the co-signed stale-lease reap protocol).
- **§4 / §6.4 — per-operator posture + gate authority** (operative posture = `min(operator_posture, repo_floor)`; the 4-eyes gate matrix in `operator-gate.js`; the audit-trail-completeness contract — Option C intentional-by-design per journal/0133).
- **§5 — lifecycle hooks** (`multi-operator-sessionstart.js` / `multi-operator-sessionend.js`).
- **§6 — generation rotation + genesis-migration:** **MUST-4** (`genesis-migration` requires 2-of-N owner co-sign + fresh external-owner check + `genesis_generation` increment; no degenerate self-sign), **MUST-5** (client-side checkpoint-pin tip-verification is the equivocation-parity defense — there is NO valid `refs/coc/**` server-side ruleset on github.com, live-verified `422 Invalid target patterns`, journal/0233 / GH #367), **MUST-7** (single-owner N=1 → org-admin anchor for org-owned / block for user-owned; depth in `genesis-migration-n1-org-admin-anchor.md`).
- **§7 — cross-CLI policy registration:** **MUST-6** (a Codex `apply_patch` policy MUST register under a CC edit matcher AND carry the `@coc-codex-edit-gate` marker; validator-13 bijection hard-blocks sync otherwise).
- **§8 — multi-operator capacity** (per-`verified_id` budget, not per-session; NON-SAME cross-operator parallelization only; `/claim`-record discipline as the coordination signal).
- **Substrate MUST-NOTs:** treat a `collaborator-distinctness-revocation` as settled before rule-10 quiescence; re-open the `operator-gate.js` audit-trail-completeness question (journal/0133 Option C). Both are detect-eventually residuals, full treatment in the skill.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/codify`); `block` at the pre-tool-use boundary for structural primitives (signature-verify failure, broken chain, missing claim on a SAME-class write); `advisory` at the session-start lifecycle banners (per `hook-output-discipline.md` MUST-2).
- **Grace period:** 14 days from rule landing; a coordination-OFF repo is exempt by construction (every guard passthrough-early-returns when `isCoordinationEnabled` is OFF). A repo that ENABLES coordination enters grace at enablement.
- **Cumulative posture impact:** any same-class violation contributes per `trust-posture.md` MUST-4 (5× in 30 days → drop posture).
- **Regression-within-grace:** any same-class violation within 14 days → emergency downgrade L5→L4; trigger key `multi_operator_coordination_violation` (1× = drop 1 posture).
- **Receipt requirement:** SessionStart MUST require `[ack: multi-operator-coordination]` in the agent's first response IF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** structural — fold rules 1–3 at every fold; `adjacency-leasecheck.js` (MUST-2), `operator-gate.js` (MUST-3), `genesis-anchor-guard.js` + `fold-rule-9c.js` (MUST-4/7), client-side checkpoint-pin verification (MUST-5), validator-13 (MUST-6). The full per-clause detection contract, gate-review sweeps, and audit-fixture directories are in the skill.
- **Violation scope:** `operator` — every `violations.jsonl` row carries the stamped `person_id` + `sig`; downgrades apply per-operator, not to `repo_floor`.
- **Origin:** See § Origin.

## Origin

Architecture v11 CONVERGED 2026-05-19; decision-record chain (root `loom/journal/`): `0112` (architecture), `0122` (convergence), `0124`/`0125` (CONF-1/2; CONF-2 REFUTED by `0233`), `0132` (M6+M7), `0133` (audit-trail Option C). Full Origin + the F-series forest registry (F51/F52/F53/F86/F87/F88/F122/…) live in the skill. **Extraction:** loom#678 Lever-C Shard-A (2026-06-26, journal/0346/0347) relocated the §1–§8 architecture + MUST-4/5/6/7 full contracts + Origin/F-registry to `.claude/skills/30-claude-code-patterns/multi-operator-coordination-substrate.md`, recovering ~20.7k tokens on every tool call with ZERO de-scoping (enforcement is in the hooks/fold-rules; the always-on agent-facing contract is preserved above). EXTRACT not NARROW — narrowing this synced coordination safety rule would de-scope it in BUILD repos where SAME-class collisions happen.
