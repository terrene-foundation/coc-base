---
id: "MULTI-OPERATOR-COORDINATION"
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

## §2 essentials — coordination state is SHARED via `refs/coc/**`; gitignored ≠ per-clone-isolated

`.claude/learning/` is `.gitignore`d, but the coordination state is NOT per-clone-isolated or lost. The gitignored files (`coordination-log.jsonl`, `posture.json`, `violations.jsonl`, `codify-lease.json`) are the LOCAL FOLD-CACHE of a signed, hash-chained log that IS shared across every operator's clone over the dedicated **`refs/coc/coordination-genN`** log ref (loom, un-rotated → `-gen0`; the bare `refs/coc/coordination` is the vestigial F43 seed, NOT the log ref — `log-ref-name.js`; cold archive on the separate `refs/coc/archive-genN` family). Each operator appends ONLY to their own per-emitter chain; clones exchange records over `refs/coc/**` and re-derive local state by FOLDING them (the 10 fold rules, skill §2). Gitignoring the raw files is what ROUTES sync through this integrity-preserving channel instead of a branch-committed file — which would (a) clobber on every concurrent append (the `knowledge-convergence.md` Rule-1 failure), (b) break the per-emitter hash chain, (c) be directly editable to forge a teammate's posture/violations, and (d) leak operator-correlatable telemetry into branch history AND through `/sync` to 30+ consumers. **`refs/coc/**` lives in the shared `.git`, so a git worktree SEES the coordination ref** — only the fold-cache is per-working-tree and re-materializes on the next fold.

**Do NOT conclude from the `.gitignore` that the state is unshared, per-clone-siloed, or that a worktree is cut off from coordination.** It is shared; the transport is `refs/coc/**` + signed-fold (full mechanism + the four failure modes: skill §2). This is a recurring cross-session misread — the gitignore comment reinforces "per-clone"; the SHARING channel is `refs/coc/**`.

**Verify a coordination-state DISPOSITION against the append-only signed RECORD SET, not a derived state projection (MUST).** A claim about a coordination-state DISPOSITION — a lease released, a claim held, a record present or absent — MUST be verified against the **append-only signed coordination-log RECORD SET** (`grep <id> coordination-log.jsonl` for the paired acquire/release records — the record set retains both, transported via `refs/coc/**`; note `codify-lease`/`codify-lease-release` are `checkpoint_exempt: false` liveness-churn, so after a `compaction-checkpoint` folds pre-`up_to_seq` records into its digest a released pair lives on the signed `refs/coc/archive-genN` cold archive — grep the archive once the current log has rotated), NEVER a **derived current-state PROJECTION** (`codify-lease.json` / `posture.json` / `violations.jsonl` — the fold-cache files that hold only CURRENT derived state and that a sibling's later fold overwrites WHOLESALE) NOR a projection-derived helper return (e.g. `releaseCodifyLease`'s `wrong-owner`, which reads `codify-lease.json`). A projection shows only the current holder; a sibling can overwrite it AFTER your own write, so a projection-derived non-success return is NOT evidence your record is absent.

```text
# DO — verify disposition against the append-only signed record set
grep <lease_id> coordination-log.jsonl   # LOCATES your acquire + paired codify-lease-release → RELEASED
                                         # (grep LOCATES; the fold — rules 1-3 + expectedFpr — is the
                                         #  signature-verifying authority; at release TIME the proof is
                                         #  releaseCodifyLease's successful record_emit result)
# DO NOT — infer disposition from a derived projection or a projection-derived return
releaseCodifyLease(...) -> {wrong-owner}  # the current-holder PROJECTION moved on (a sibling
                                          # overwrote codify-lease.json) — NOT proof yours is unreleased
```

**Why:** the coordination-log record set is append-only + per-emitter-signed + hash-chained, so a recent lease's paired acquire/release records are locatable and provable; the `codify-lease.json` / `posture.json` / `violations.jsonl` fold-projections show only current derived state and a sibling's fold overwrites them wholesale. Reading a disposition from a projection (or a helper return over it) and stating it as fact is the coordination-substrate instance of `evidence-first-claims.md` MUST-3 (a non-success return is zero evidence, never confirmation) **+ MUST-4** (an inference stated as fact) — its conceptual parents. This clause carries its OWN clause-scoped Trust-Posture Wiring below: a review-layer-only disposition-verification property whose enforcement profile (gate-review detection, generic `regression_within_grace`) differs from BOTH the file-level structural `multi_operator_coordination_violation` detection AND the MUST-2-scoped `evidence_free_claim` emergency key (which does NOT cover this MUST-3/4 cumulative-routing class).

**BLOCKED rationalizations:**

- "the release helper returned `wrong-owner`, so my lease was never released" (`wrong-owner` = the projection's CURRENT holder ≠ you; grep the record set for your paired records)
- "the lease file / `posture.json` is the source of truth for that state" (it is a derived projection; the append-only signed record set is authoritative)
- "the on-disk cache says no lease, so my record is absent" (a sibling's fold overwrote the projection; absence-in-projection ≠ absence-in-record-set)

**Trust Posture Wiring (Coordination-Disposition Verification clause):**

Applies to the **Verify a coordination-state DISPOSITION against the append-only signed RECORD SET** clause (added 2026-07-13). Per `trust-posture.md` MUST-8, this clause lands AT/AFTER the MUST-8 SHA and ships canonical-8-field-compliant; the pre-existing §2 always-on contract + the file-level Trust Posture Wiring remain as-is — this clause carries its OWN block (its review-layer-only enforcement profile differs from the file-level structural `multi_operator_coordination_violation` detection) per the clause-scoped precedent `security.md` § Enforcement-Surface Parity / `git.md` § CI-check/merge / `artifact-flow.md` § Canon-Neutrality set.

- **Severity:** `halt-and-report` at gate-review (reviewer / cc-architect confirm a coordination-state disposition claim in a durable artifact was verified against the signed coordination-log record set, not a fold-projection or projection-derived helper return); `advisory` at the hook layer (no structural tool-call signal — whether a stated disposition was record-set-verified is judgment-bearing prose per `hook-output-discipline.md` MUST-2).
- **Grace period:** 7 days from clause landing (2026-07-13 → 2026-07-20).
- **Cumulative posture impact:** same-class violations (a coordination-disposition claim stated from a projection / projection-derived return instead of the signed record set) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture) — the MUST-3/4 cumulative path this clause instantiates, NOT the MUST-2-scoped `evidence_free_claim` emergency key.
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key (a disposition-verification property is review-layer-only + semantic; minting a key would drag `trust-posture.md`, a self-referential-codify allowlist file, into a self-ref edit — the universal trigger already covers it). Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8 — the same no-dedicated-key disposition `security.md` § Enforcement-Surface Parity, `git.md` § CI-check/merge, and `artifact-flow.md` § Canon-Neutrality took.
- **Receipt requirement:** SessionStart soft-gate `[ack: multi-operator-coordination]` IFF `posture.json::pending_verification` includes the `multi-operator-coordination` rule_id (shared rule_id; a single ack covers §1 + the always-on MUST clauses + this clause).
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer / cc-architect inspect any session that stated a coordination-state disposition (lease released/held, record present/absent) in a durable artifact and confirm it cited a `grep <id> coordination-log.jsonl` record-set verification (or the archive ref post-rotation), not a `codify-lease.json` / `posture.json` projection read or a projection-derived helper return. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — no hook detector (the property is semantic, not a lexical tool-call signal); audit fixtures land with the Phase-2 detector at `.claude/audit-fixtures/coordination-disposition-verification/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** the Coordination-Disposition Verification clause ONLY (clause-scoped); the pre-existing §2 always-on contract + file-level Wiring stay as-is.
- **Origin:** co-owner-directed origination `journal/0482`; conceptual parents `evidence-first-claims.md` MUST-3 (a non-success return is zero evidence) + MUST-4 (an inference stated as fact).

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

The skill (`.claude/skills/30-claude-code-patterns/multi-operator-coordination-substrate.md`) carries the complete §2–§8 architecture + the substrate-integrity MUST clauses below — each **enforced structurally** by a named hook / fold-rule / validator, NOT by this prose. Read it before authoring or auditing substrate code; each anchor's full contract, hook names, and originating evidence resolve there:

- **§2 — coordination event log + the 10 fold rules** (record types; signature / chain-integrity / fork-detection folds; the opt-in `isCoordinationEnabled` gating above).
- **§3 — claims/leases + the SAME / ADJACENT / INDEPENDENT relation** (`/claim` / `/claims` / `/release-claim`; the co-signed stale-lease reap protocol).
- **§4 / §6.4 — per-operator posture + gate authority** (operative posture = `min(operator_posture, repo_floor)`; the 4-eyes `/release` gate matrix; the intentional audit-trail-completeness residual).
- **§5 — lifecycle hooks** (session-start / session-end staleness + sibling-state surfacing).
- **§6 — generation rotation + genesis-migration:** **MUST-4** (`genesis-migration` requires 2-of-N owner co-sign + fresh external-owner check; no degenerate self-sign), **MUST-5** (client-side checkpoint-pin tip-verification is the equivocation-parity defense; there is NO valid `refs/coc/**` server-side ruleset on github.com), **MUST-7** (single-owner N=1 → org-admin anchor for org-owned / block for user-owned).
- **§7 — cross-CLI policy registration:** **MUST-6** (a Codex `apply_patch` policy MUST register under a CC edit matcher AND carry the `@coc-codex-edit-gate` marker).
- **§8 — multi-operator capacity** (per-`verified_id` budget, not per-session; NON-SAME cross-operator parallelization only; `/claim`-record discipline as the coordination signal).
- **Substrate MUST-NOTs:** treat a `collaborator-distinctness-revocation` as settled before rule-10 quiescence; re-open the `operator-gate.js` audit-trail-completeness question. Both are detect-eventually residuals, full treatment in the skill.

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
