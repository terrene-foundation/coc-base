---
name: multi-operator-coordination
description: Multi-operator coordination substrate — operator identity, signed append-only coordination log, claim/lease primitives, per-operator posture + gate authority; the always-on agent-facing behavioral contract. Fires whenever a session edits shared repo state in a repo with ≥2 enrolled operators.
priority: 10
scope: path-scoped
paths: ["**/*"]
---

# Multi-Operator Coordination Substrate

N humans run concurrent sessions against ONE shared repo. Threat model: **bounded-trust** — the substrate **prevents** where an immutable anchor exists, **detects-eventually** elsewhere (skill § "Rule-body extract — preamble").

**Opt-in, OFF by default.** Every gate below FIRST consults `isCoordinationEnabled(repoDir)` and early-returns to passthrough when OFF. ON = explicit `ecosystem.json::coordination.enabled` / local override, OR the implicit fallback (roster present AND genesis anchored). 5-tier precedence + the asymmetric-precedence security fix: skill §2.

**Enforcement is in the hooks + fold rules, not this prose.** This rule is the always-on **agent-facing behavioral contract** (§1 + MUST-1/2/3 + the state-write MUST-NOTs); the §1–§8 architecture, the MUST-4/5/6/7 contracts, per-clause detection and the F-series registry live in **`.claude/skills/30-claude-code-patterns/multi-operator-coordination-substrate.md`**, where every `§N` / `MUST-N` anchor resolves. **Read it before authoring or auditing substrate code.**

## §1 Identity + roster (always-on essentials)

Operator identity is a triple resolved by `lib/operator-id.js::resolveIdentity(cwd)`:

- **`display_id`** — advisory signage. Collisions are harmless. Tooling MUST attribute via `verified_id`, NEVER `display_id`.
- **`verified_id`** — fingerprint of a commit-signing key; authenticates a _record_.
- **`person_id`** — the unit of authority (one `person_id` → one human → `role` + enrolled keys). Immutability, append-only keys, the 2-of-N quorum roster edit: skill § "Rule-body extract — §1 identity-triple detail".
- **`host_role: ci`** — CI / deploy-key identities are **audit-only**: NEVER eligible to co-sign owner-quorum, distinctness, gate-approval, or genesis/migration records.
- **`business_roles`** (OPTIONAL, advisory array ∈ {`platform-engineer`, `capability-engineer`, `business-consultant`}). **Advisory + capability-scoping ONLY:** NEVER quorum-eligible, NEVER an authority or distinctness gate, **orthogonal** to BOTH the authority `role` AND the trust-posture (L1–L5). `product-owner` is NOT a roster value. Derivation + Class-A/B/C placement: skill §1.

Un-rostered keys run at `L2_SUPERVISED` (`trust-posture.md`); the session-start surface routes them into `/whoami --register` (the only path that lands a roster edit).

```bash
# DO — attribute via verified_id (git config user.signingkey); display_id is presentation only
# DO NOT — gate_authority_check "$(git config user.name)"   # display_id = WRONG axis
```

**Why:** Two operators sharing a `display_id` ("Alex") collide harmlessly on a banner but catastrophically on a gate decision.

## §2 essentials — coordination state is SHARED via `refs/coc/**`; gitignored ≠ per-clone-isolated

`.claude/learning/` is `.gitignore`d, but coordination state is NOT per-clone-isolated or lost: `coordination-log.jsonl`, `posture.json`, `violations.jsonl` and `codify-lease.json` are the LOCAL FOLD-CACHE of a signed, hash-chained log shared across every clone over the dedicated `refs/coc/coordination-genN` ref in the shared `.git` — **so a git worktree SEES the coordination ref**; only the fold-cache is per-working-tree, re-materializing on the next fold. Mechanism depth: skill § "Rule-body extract — §2 essentials" + §2.

**Do NOT conclude from the `.gitignore` that the state is unshared, per-clone-siloed, or that a worktree is cut off from coordination.**

**Verify a coordination-state DISPOSITION against the signed RECORD SET, never a projection (MUST).** A disposition claim — a lease released, a claim held, a record present or absent — MUST be verified against the **signed RECORD SET** (`grep <id> coordination-log.jsonl`; the `refs/coc/archive-genN` cold archive once rotated), NEVER a **derived current-state PROJECTION** (`codify-lease.json` / `posture.json` / `violations.jsonl`) NOR a projection-derived helper return (`releaseCodifyLease`'s `wrong-owner`). Retrieval mechanics + BLOCKED corpus: skill § "Verifying a coordination-state DISPOSITION".

```text
# DO — grep the signed record set   # DO NOT — read a projection or a projection-derived return
grep <lease_id> coordination-log.jsonl     ·     releaseCodifyLease(...) -> {wrong-owner}
```

**Why:** the record set is append-only + per-emitter-signed + hash-chained, so a paired acquire/release is locatable and provable; the fold-projections hold only current derived state and a sibling's fold overwrites them wholesale. Reading a disposition from a projection and stating it as fact is this substrate's instance of `evidence-first-claims.md` MUST-3 **+ MUST-4**.

**BLOCKED rationalizations:** "the helper returned `wrong-owner`, so my lease was never released" / "the lease file / `posture.json` is the source of truth for that state" / "the on-disk cache says no lease, so my record is absent" / "the current log has no such record, so it never existed". Full corpus: skill § "Verifying a coordination-state DISPOSITION".

Clause-scoped Wiring for this disposition clause: `.claude/skills/32-trust-posture/wiring/multi-operator-coordination.md` § "§2 Coordination-Disposition Verification clause".

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

- **Positional cross-repo path construction in coordination tooling.** Any hook/agent/command/helper needing another repo's location MUST NOT guess it positionally — `~/repos/<name>` / `../<name>` / `path.join(HOME, "repos", <name>)` is BLOCKED. **The binding is tier-dependent:** at **loom / BUILD**, resolve via `bin/lib/loom-links.mjs::resolveRepo`; at a **USE template or downstream consumer** that resolver is NOT distributed, and neither is its contract, so there the whole obligation is **ask, never guess**. Same tier split `repo-scope-discipline.md` § MUST NOT states; tier-binding mechanics: skill § "Rule-body extract — MUST NOT positional: tier-binding mechanics".

  **Why:** Positional guessing makes the NAME→location binding silently operator-dependent — one operator's tooling resolves the right directory and a sibling's resolves nothing. Why both tier halves are stated rather than naming a `loom_only` module half its readers never receive: skill § MUST NOT Positional.

## Substrate reference map — full contract in the skill

Per-anchor glosses: skill § "Rule-body extract — substrate reference map glosses".

- **§2** event log + fold rules · **§3** claims/leases + SAME / ADJACENT / INDEPENDENT · **§4 / §6.4** posture + gate authority · **§5** lifecycle hooks · **§6** rotation + genesis-migration (**MUST-4**, **MUST-5**, **MUST-7**) · **§7** cross-CLI policy registration (**MUST-6**: a Codex `apply_patch` policy MUST register under a CC edit matcher AND carry the `@coc-codex-edit-gate` marker) · **§8** multi-operator capacity.
- **Substrate MUST-NOTs:** treat a `collaborator-distinctness-revocation` as settled before rule-10 quiescence; re-open the `operator-gate.js` audit-trail-completeness question. Both detect-eventually residuals; full treatment in the skill.

Depth — the Trust-Posture Wiring (file-level and the §2 clause-scoped block) and the Origin record — lives in `.claude/skills/32-trust-posture/wiring/multi-operator-coordination.md`, which every validator reads as part of this rule; worked depth and the extraction record live in `.claude/guides/rule-extracts/multi-operator-coordination.md`.
