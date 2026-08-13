---
id: "MULTI-OPERATOR-COORDINATION"
paths: ["**/*"]
---

# Multi-Operator Coordination Substrate

N humans run concurrent sessions against ONE shared repo, editing the same or adjacent code. The threat model is **bounded-trust** — the adversary is a legitimate team member with repo write access: the substrate **prevents** where an immutable git-native or GitHub-server anchor exists, **detects-eventually** elsewhere. Primitives inventory + the full adversary model: skill.

**Opt-in, OFF by default.** Every gate below FIRST consults `isCoordinationEnabled(repoDir)` and early-returns to passthrough when OFF — a solo / un-enrolled repo pays nothing and gets no `/whoami` nag. ON = explicit `ecosystem.json::coordination.enabled` / local override, OR the implicit fallback (roster present AND genesis anchored). Full 5-tier precedence + the asymmetric-precedence security fix: skill §2.

**Enforcement is in the hooks + fold rules, not this prose.** The structural defenses fire regardless of whether this body is in context; each is named per-clause in § Trust Posture Wiring → Detection mechanism. This rule is the always-on **agent-facing behavioral contract** (§1 + MUST-1/2/3 + the state-write MUST-NOTs); the full §1–§8 architecture, the MUST-4/5/6/7 substrate-integrity contracts, per-clause detection, and the F-series registry live in **`.claude/skills/30-claude-code-patterns/multi-operator-coordination-substrate.md`**, where every `§N` / `MUST-N` anchor below resolves. **Read the skill before authoring or auditing any substrate code.**

## §1 Identity + roster (always-on essentials)

Operator identity is a triple resolved by `lib/operator-id.js::resolveIdentity(cwd)`:

- **`display_id`** — advisory, human-readable signage. Collisions are harmless. Tooling MUST attribute via `verified_id`, NEVER `display_id`.
- **`verified_id`** — fingerprint of a commit-signing key; authenticates a _record_.
- **`person_id`** — the unit of authority (one `person_id` → one human → `role` + enrolled keys). Immutable; keys append-only; adding a key/`person_id` is a 2-of-N quorum roster edit.
- **`host_role: ci`** — CI / deploy-key identities are **audit-only**: NEVER eligible to co-sign owner-quorum, distinctness, gate-approval, or genesis/migration records.
- **`business_roles`** (OPTIONAL, advisory array ∈ {`platform-engineer`, `capability-engineer`, `business-consultant`}) — the role-first operating-model classification. **Advisory + capability-scoping ONLY:** NEVER quorum-eligible, NEVER consulted by any distinctness or gate predicate, **orthogonal** to BOTH the authority `role` (owner/senior/contributor) AND the trust-posture (L1–L5). `product-owner` is NOT a roster value. Full derivation + the Class-A/B/C taxonomy placement: skill §1.

Un-rostered keys run at `L2_SUPERVISED` (`trust-posture.md`); the session-start surface routes them into `/whoami --register` (the only path that lands a roster edit).

```bash
# DO — attribute via verified_id (git config user.signingkey); display_id is presentation only
# DO NOT — gate_authority_check "$(git config user.name)"   # display_id = WRONG axis
```

**Why:** Two operators sharing a `display_id` ("Alex") collide harmlessly on a banner but catastrophically on a gate decision; `verified_id` is the cryptographic primitive, `person_id` the authority unit, `display_id` only signage.

## §2 essentials — coordination state is SHARED via `refs/coc/**`; gitignored ≠ per-clone-isolated

`.claude/learning/` is `.gitignore`d, but the coordination state is NOT per-clone-isolated or lost. The gitignored files (`coordination-log.jsonl`, `posture.json`, `violations.jsonl`, `codify-lease.json`) are the LOCAL FOLD-CACHE of a signed, hash-chained log that IS shared across every operator's clone over the dedicated **`refs/coc/coordination-genN`** log ref (cold archive on the separate `refs/coc/archive-genN` family). Each operator appends ONLY to their own per-emitter chain; clones exchange records over `refs/coc/**` and re-derive local state by FOLDING them. The gitignore ROUTES sync through this integrity-preserving channel instead of a branch-committed file, which would fail four ways (concurrent-append clobber, chain break, forgeable posture, telemetry leak to 30+ consumers). **`refs/coc/**` lives in the shared `.git`, so a git worktree SEES the coordination ref** — only the fold-cache is per-working-tree and re-materializes on the next fold. Ref naming, the 10 fold rules, and all four failure modes in full: skill §2.

**Do NOT conclude from the `.gitignore` that the state is unshared, per-clone-siloed, or that a worktree is cut off from coordination.** This is a recurring cross-session misread — the gitignore comment reinforces "per-clone"; the SHARING channel is `refs/coc/**` + signed-fold.

**Verify a coordination-state DISPOSITION against the append-only signed RECORD SET, not a derived state projection (MUST).** A claim about a coordination-state DISPOSITION — a lease released, a claim held, a record present or absent — MUST be verified against the **append-only signed coordination-log RECORD SET** (`grep <id> coordination-log.jsonl` for the paired acquire/release records; grep the signed `refs/coc/archive-genN` cold archive once the current log has rotated), NEVER a **derived current-state PROJECTION** (`codify-lease.json` / `posture.json` / `violations.jsonl` — fold-cache files holding only CURRENT derived state, which a sibling's later fold overwrites WHOLESALE) NOR a projection-derived helper return (e.g. `releaseCodifyLease`'s `wrong-owner`). Retrieval mechanics + full BLOCKED corpus: skill § "Verifying a coordination-state DISPOSITION".

```text
# DO — grep the signed record set   # DO NOT — read a projection or a projection-derived return
grep <lease_id> coordination-log.jsonl     ·     releaseCodifyLease(...) -> {wrong-owner}
```

**Why:** the record set is append-only + per-emitter-signed + hash-chained, so a paired acquire/release is locatable and provable; the fold-projections hold only current derived state and a sibling's fold overwrites them wholesale. Reading a disposition from a projection and stating it as fact is the coordination-substrate instance of `evidence-first-claims.md` MUST-3 (a non-success return is zero evidence) **+ MUST-4** (an inference stated as fact).

**BLOCKED rationalizations:** "the helper returned `wrong-owner`, so my lease was never released" / "the lease file / `posture.json` is the source of truth for that state" / "the on-disk cache says no lease, so my record is absent" / "the current log has no such record, so it never existed". Full corpus + why each fails: skill § "Verifying a coordination-state DISPOSITION".

**Trust Posture Wiring (Coordination-Disposition Verification clause).** Clause-scoped (added 2026-07-13); ships canonical-8-field-compliant per `trust-posture.md` MUST-8. The pre-existing §2 always-on contract + the file-level Wiring remain as-is. Why this clause carries its OWN block + the no-dedicated-key rationale: skill § "Verifying a coordination-state DISPOSITION".

- **Severity:** `halt-and-report` at gate-review (reviewer / cc-architect confirm a coordination-state disposition claim in a durable artifact was verified against the signed record set, not a fold-projection or projection-derived helper return); `advisory` at the hook layer (judgment-bearing prose, no structural tool-call signal, per `hook-output-discipline.md` MUST-2).
- **Grace period:** 7 days from clause landing (2026-07-13 → 2026-07-20).
- **Cumulative posture impact:** same-class violations (a disposition claim stated from a projection / projection-derived return instead of the signed record set) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture) — the MUST-3/4 cumulative path, NOT the MUST-2-scoped `evidence_free_claim` emergency key.
- **Regression-within-grace:** GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause key; named deviation from the key-per-clause shape per `trust-posture.md` Rule 8.
- **Receipt requirement:** SessionStart soft-gate `[ack: multi-operator-coordination]` IFF `posture.json::pending_verification` includes the `multi-operator-coordination` rule_id (shared rule_id; a single ack covers §1 + the always-on MUST clauses + this clause).
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer / cc-architect confirm any durable-artifact disposition claim (lease released/held, record present/absent) cited a `grep <id> coordination-log.jsonl` record-set verification (or the archive ref post-rotation), not a projection read or projection-derived return. Probes `.claude/test-harness/probes/multi-operator-coordination.probes.json` — NOT YET AUTHORED, declared in `phase2-deferrals.json::probe_authorship_deferrals`. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — no hook detector (semantic, not lexical); audit fixtures land with the Phase-2 detector at `.claude/audit-fixtures/coordination-disposition-verification/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** the Coordination-Disposition Verification clause ONLY (clause-scoped); the pre-existing §2 always-on contract + file-level Wiring stay as-is.
- **Origin:** co-owner-directed origination `journal/0482`; conceptual parents `evidence-first-claims.md` MUST-3 + MUST-4.

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

- **Positional cross-repo path construction in coordination tooling.** Any hook/agent/command/helper needing another repo's location MUST NOT guess it positionally — `~/repos/<name>` / `../<name>` / `path.join(HOME, "repos", <name>)` is BLOCKED. **WHERE the binding comes from is tier-dependent, so both halves are stated here.** At **loom / BUILD**, resolve via `bin/lib/loom-links.mjs::resolveRepo` — the canonical NAME→location binding (`cross-repo.md` MUST-1). At a **USE template or downstream consumer**, that resolver is deliberately NOT distributed (`sync-manifest.yaml` fences it `loom_only`: "a consumer resolves nothing cross-repo"), and neither is its contract — so there the whole obligation is: **ask, never guess.** Same tier split `repo-scope-discipline.md` § MUST NOT already states for the identical binding.

  **Why:** Positional guessing makes the NAME→location binding silently operator-dependent — one operator's tooling resolves the right directory and a sibling's resolves nothing. Why the clause states both tier halves rather than naming a `loom_only` module half its readers never receive: skill § MUST NOT Positional.

## Substrate reference map — full contract in the skill

Each anchor below is enforced structurally by a named hook / fold-rule / validator; its full contract, hook names, and originating evidence resolve in the skill:

- **§2** coordination event log + the 10 fold rules · **§3** claims/leases + the SAME / ADJACENT / INDEPENDENT relation · **§4 / §6.4** per-operator posture + gate authority (operative posture = `min(operator_posture, repo_floor)`; the 4-eyes `/release` matrix) · **§5** lifecycle hooks · **§8** multi-operator capacity (per-`verified_id` budget, not per-session; NON-SAME cross-operator parallelization only).
- **§6 — rotation + genesis-migration:** **MUST-4** (2-of-N owner co-sign + fresh external-owner check; no degenerate self-sign), **MUST-5** (client-side checkpoint-pin tip-verification is the equivocation-parity defense; NO valid `refs/coc/**` server-side ruleset on github.com), **MUST-7** (single-owner N=1 → org-admin anchor for org-owned / block for user-owned).
- **§7 — cross-CLI policy registration:** **MUST-6** (a Codex `apply_patch` policy MUST register under a CC edit matcher AND carry the `@coc-codex-edit-gate` marker).
- **Substrate MUST-NOTs:** treat a `collaborator-distinctness-revocation` as settled before rule-10 quiescence; re-open the `operator-gate.js` audit-trail-completeness question. Both detect-eventually residuals; full treatment in the skill.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/codify`); `block` at the pre-tool-use boundary only where a structural primitive backs an IRRECOVERABLE outcome (`integrity-guard.js` off-codify-branch write; `signing-mutation-guard.js` degraded-mode unsigned mutation); `halt-and-report` for a missing claim on a SAME-class write (registry-class) AND for §4.2 cross-worktree contention in BOTH guards detecting it — `adjacency-leasecheck.js` + `signing-mutation-guard.js` (structurally `block`-eligible, downgraded on proportionality per loom#1323: recoverable merge conflict); `advisory` at the session-start lifecycle banners (per `hook-output-discipline.md` MUST-2).
- **Grace period:** 14 days from rule landing; a coordination-OFF repo is exempt by construction (every guard passthrough-early-returns when `isCoordinationEnabled` is OFF). A repo that ENABLES coordination enters grace at enablement.
- **Cumulative posture impact:** any same-class violation contributes per `trust-posture.md` MUST-4 (5× in 30 days → drop posture).
- **Regression-within-grace:** any same-class violation within 14 days → emergency downgrade L5→L4; trigger key `multi_operator_coordination_violation` (1× = drop 1 posture).
- **Receipt requirement:** SessionStart MUST require `[ack: multi-operator-coordination]` in the agent's first response IF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** structural — fold rules 1–3 at every fold; `adjacency-leasecheck.js` (MUST-2), `operator-gate.js` (MUST-3), `genesis-anchor-guard.js` + `fold-rule-9c.js` (MUST-4/7), client-side checkpoint-pin verification (MUST-5), validator-13 (MUST-6). The full per-clause detection contract, gate-review sweeps, and audit-fixture directories are in the skill.
- **Violation scope:** `operator` — every `violations.jsonl` row carries the stamped `person_id` + `sig`; downgrades apply per-operator, not to `repo_floor`.
- **Origin:** See § Origin.

## Origin

Architecture v11 CONVERGED 2026-05-19. Full decision-record chain, the F-series forest registry, and the per-extraction record (all ZERO de-scoping): skill § Origin — note CONF-2 is REFUTED by `journal/0233`, so MUST-5 is client-side-detection-primary. EXTRACT not NARROW — narrowing this synced coordination safety rule would de-scope it in BUILD repos where SAME-class collisions happen.
