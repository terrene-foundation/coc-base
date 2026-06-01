---
name: multi-operator-coordination
description: Multi-operator coordination substrate — operator identity, append-only signed coordination event log, claim/lease primitives, per-operator trust posture + gate authority, lifecycle hooks; fires whenever a session edits shared repo state in a repo with ≥2 enrolled operators.
priority: 10
scope: path-scoped
paths: ["**/*"]
---

# Multi-Operator Coordination Substrate

N humans, each running their own session concurrently, against ONE shared repo distributed as N clones of ONE GitHub remote. They edit the same or adjacent code. The substrate uses native COC primitives only — git-native cryptography (commit-signing keys, `gh api`), no PACT, no coordination service. The threat model is **bounded-trust**: the adversary is a legitimate team member with repo write access seeking privilege escalation, impersonation, attribution evasion, or teammate sabotage. The substrate **prevents** where an immutable git-native or GitHub-server anchor exists; it **detects-eventually** elsewhere.

This rule codifies the runtime contract every session MUST honor. Every prescriptive reference here is CLI-neutral per `rules/cross-cli-artifact-hygiene.md`: hook lifecycle moments are named ("the session-start hook", "the pre-tool-use guard"), delegation is named ("delegate to reviewer"), baseline rules are cited by path (`rules/<name>.md`), not by per-CLI emission filename.

**Citation note for downstream consumers:** The rule body cites `workspaces/multi-operator-coc/02-plans/01-architecture.md` §X at multiple anchors below (§1.1 threat model, §2.2 fold rules, §4 adjacency/leases/hooks/residuals, §5 single-writer contention, §6 posture/gate authority, §11 shard map). That spec is **loom-internal** (project-local working state, not shipped via `/sync`); the citations are **pointers to original derivation** for loom-side auditors. The rule body's MUST clauses are **self-contained and authoritative**; downstream consumers act on the prose here, not on the cited spec. Committed durable receipts: journal entries (root `loom/journal/`) `0112` (architecture decision-record), `0122` (convergence receipt), `0124` (CONF-1 verdict), `0125` (CONF-2 verdict), `0132` (M6+M7 convergence), `0133` (Sec-MED-3 disposition).

## 1. Identity + roster

Operator identity is a triple — **`display_id`**, **`verified_id`**, **`person_id`** — backed by the in-repo signing substrate at `.claude/operators.roster.json` and resolved by `lib/operator-id.js::resolveIdentity(cwd)`.

- **`display_id`** — advisory only; human-readable surfacing. Collisions are harmless. Tooling MUST attribute via `verified_id`, never `display_id`.
- **`verified_id`** — fingerprint of a git commit-signing key; authenticates a _record_.
- **`person_id`** — the unit of authority. The roster maps one `person_id` → one human → `role` + enrolled keys. `person_id`s are immutable; keys are append-only under a `person_id`. Adding a key or a new `person_id` is a 2-of-N quorum roster edit. Every distinctness gate tests `person_id` inequality AND, for owner/senior gates, distinct bound-GitHub-collaborator-login inequality.
- **`host_role: ci`** — CI / deploy-key signing identities are **audit-only**: NEVER eligible to co-sign owner-quorum, distinctness, gate-approval, or genesis/migration records. Excluding `host_role: ci` from quorum is a structural integrity property, not a permission policy.

Un-rostered keys run at `L2_SUPERVISED` per `rules/trust-posture.md`; the session-start surface emits a `block`-grade prompt into `/whoami --register` (which is the only path that lands a roster edit).

```bash
# DO — attribute via verified_id; display_id is presentation only
verified_id=$(git config user.signingkey)        # the structural identity
display_id=$(jq -r --arg vid "$verified_id" '.persons[] | select(.keys[].fingerprint==$vid) | .display_id' .claude/operators.roster.json)

# DO NOT — attribute by display_id (collisions harmless = unsafe for authority)
display_id=$(git config user.name)                # advisory only; not load-bearing
gate_authority_check "$display_id"                # WRONG axis
```

**Why:** Two operators with the same `display_id` ("Alex") collide harmlessly on a banner but catastrophically on a gate decision. `verified_id` is the cryptographic primitive; `person_id` is the authority unit; `display_id` is signage.

## 2. The coordination event log

ONE file — `.claude/learning/coordination-log.jsonl` — is the single rendezvous primitive between operators. Append-only JSONL, ≤2KB per line so `O_APPEND` is atomic. Every record carries the emitter's `verified_id` + `person_id` (stamped), `seq` (strictly monotonic per-emitter), `prev_hash` (per-emitter hash-chain), and `sig` (detached signature over canonical content). Record types include `clone-init`, `collaborator-distinctness-attestation`/`-revocation`, `session-open`/`close`, `heartbeat`, `claim`/`release`/`reap`, `lease-override`, `gate-approval`, `posture-event`, `compaction-checkpoint`, `genesis-anchor`, `genesis-migration`, `generation-rotation`.

The 10 fold rules at `workspaces/multi-operator-coc/02-plans/01-architecture.md` §2.2 govern correctness:

1. **Signature gate** — a record folds only if `sig` verifies against a roster public key.
2. **Per-emitter chain integrity** — `seq` exactly +1, `prev_hash` matches.
3. **Fork detection** — two records at the same `(verified_id, seq)` with different content hashes = cryptographic equivocation proof; `block`-grade; names the equivocator.
4. **State-mutation scope** — a record may mutate only its own emitter's state; cross-operator release requires a co-signed `reap`.
5. **Checkpoint reconciliation** — a `compaction-checkpoint` skips pre-`up_to_seq` records only when 2-of-N owner-co-signed AND it carries retained chain-head + from-genesis transitive closure + folded-state digest + the pinned `refs/coc/archive-genN` tip hash.
6. **Checkpoint-exempt generic + two-tier retention** — every signed witness/accountability/trust-root record type is checkpoint-exempt by default.
7. **Liveness as a read-time fold predicate** — session live iff last heartbeat within `LIVENESS_TTL` (20 min, wall-clock) and unclosed.
8. **Partial-push gap advisory** — heartbeat-seq high-water cross-check.
9. **Genesis-anchor + rotation + migration anchoring** — first-wins genesis anchor; co-signed rotation + migration (NO degenerate self-sign for migration).
10. **Liveness-contradiction for revocations** — a `collaborator-distinctness-revocation` is honored only provisionally; observing ANY signed activity by the revoked operator post-revocation contests it and names the forging signer.

Boundary hooks enforce the substrate's writeability invariants:

- **`integrity-guard.js`** (pre-tool-use, `Edit`/`Write` on watched paths) — blocks writes off a `codify/<id>-<date>` branch.
- **`signing-mutation-guard.js`** — degraded-mode read-only via the working-tree-mutation predicate (`git status --porcelain` before/after on tracked paths), NOT an `Edit`/`Write` tool-name allowlist.
- **`journal-write-guard.js`** — blocks journal writes when the file is already on disk; halts when the slot is unreserved per log.

```text
# DO — append a signed record via the canonical helper
coc-append.js heartbeat                          # writes stamped + signed + chained record

# DO NOT — hand-write JSONL into coordination-log.jsonl
echo '{"type":"heartbeat", ...}' >> .claude/learning/coordination-log.jsonl
# (no signature; no per-emitter chain; rule-1 rejects on fold; sibling clones see nothing)
```

**Why:** Hand-written records are unverifiable, unattributable, and silently drop on the first fold. Every record MUST traverse `coc-append.js` so the stamp + chain + signature land atomically.

## 3. Claims, leases, and the SAME/ADJACENT/INDEPENDENT relation

Claims are advisory leases over a path / glob / workspace. Adjacency is evaluated at claim time per `workspaces/multi-operator-coc/02-plans/01-architecture.md` §4.1:

- **SAME** — exact path/glob match, active dir/glob/workspace claim contains the path, same-commit cohort, phase collision, or composed-invariant collision.
- **ADJACENT** — same dir / workspace / parent-child within 1 level / journal thread.
- **INDEPENDENT** — otherwise.

Lease severities are advisory per §4.2: **SAME → `halt-and-report`**; **ADJACENT → `advisory`**; **INDEPENDENT → silent + auto-claim**. The single `block` exception (filesystem transport only): cross-worktree contention where `git status --porcelain` shows the exact target file uncommitted-modified on a sibling worktree.

Commands:

- **`/claim`** — stake a SAME-class claim on a path/glob/workspace; halts on SAME-conflict (advisory on ADJACENT).
- **`/claims`** — list all active claims (own first, then siblings by `granted_at DESC`).
- **`/release-claim`** — self-release for own claims; cross-operator reap requires `--reap + --cosigner` per §4.4.

Stale-lease reap protocol (§4.4): a `reap` carries `reaper`, a distinct-`person_id` `cosigner` + co-signature, and the observed victim heartbeat `(verified_id, seq)`. Honored only if (a) no victim heartbeat with higher `seq`, AND (b) the pinned victim heartbeat's `ts` is older than `now - LIVENESS_TTL` (wall-clock). Self-reap of own stale claims needs no co-signature.

```text
# DO — stake a claim before editing a SAME-class scope
/claim packages/kailash/src/auth/**             # halts if a sibling holds the same scope
edit ...                                         # proceed only after claim succeeds

# DO NOT — edit then claim retroactively
edit packages/kailash/src/auth/login.py          # SAME-class with a sibling's active claim
/claim packages/kailash/src/auth/**              # claim now contested; F2-1 residual ships
```

**Why:** A SAME-class write without a prior claim is exactly the silent-concurrent-edit (F2-1) residual. The claim-then-edit ordering converts the residual into a deterministic gate; the reverse ordering converts every shard into a potential merge contest.

## 4. Per-operator posture + gate authority

`.claude/learning/posture.json` v2 is a folded cache of signed `posture-event` records: `{ schema_version: 2, repo_floor: {...}, operators: { <person_id>: {...} } }`. **Operative posture = `min(operator_posture, repo_floor)`.** New operators default `L2_SUPERVISED`. The corrupt-folded-cache + intact-verifying-log discrimination per §6.1: missing log + `.initialized` + no `clone-init` chain → fresh clone, fetch-then-fold, NO L1; missing/truncated log while a verifying checkpoint-surviving `clone-init` chain for this clone exists → fail-closed L1.

The gate matrix per §6.4 enforces 4-eyes on `person_id` PLUS distinct bound-GitHub-collaborator-login (R5-S-07): `operator-gate.js` resolves the signed `gate-approval` key → `person_id`, rejects iff approver `person_id` == requester OR (owner/senior gates) same bound GitHub-collaborator login. `host_role: ci` is NEVER an eligible approver.

```text
# DO — /release requires a distinct-person owner co-sign
/release v1.2.3                                  # operator-gate.js blocks until a distinct owner signs gate-approval

# DO NOT — self-approve a /release via a sibling key under the same person_id
/release v1.2.3 --approver <my-other-key>        # person_id collision detected; gate blocks
```

**Why:** A `gate-approval` from the requester's own `person_id` is structurally indistinguishable from no approval; the gate's only meaning is the distinctness check. Treating distinct `verified_id` as sufficient (a single human with two keys) would re-open the single-human-quorum-defeat path that GitHub-collaborator-login distinctness closes.

**Audit-trail completeness contract — by design (journal/0133).** The `operator-gate.js` pre-tool-use hook passes a gated invocation through when `verifyGateApproval` succeeds; it does **NOT** atomically append a `gate-approval-consumed` record at the moment of passthrough. Two distinct properties are separated:

- **Runtime replay-prevention** is enforced cryptographically by the nonce-binding on the signed `gate-approval` record. The approver's record IS in the log when issued (distinct from the consumer's later passthrough); the requester's `session-open`/`heartbeat` chain attributes consumption. No real-time discrete "consumed" row is required for replay-prevention.
- **Durable audit-row materialization** is the fold-time composition at the next `/codify` cycle (or any fold-touching operation that traverses past the consumed nonce). The audit row is implicit: signed `gate-approval` (from approver's chain) + signed `session-open`/`heartbeat` (from requester's chain) → the attributed consumption is derivable.

This separation matches the substrate's general runtime-vs-durable layering. The alternatives — atomic pre-tool-use fold-append (adds recursive-write surface + fail-mode ambiguity under the 5s latency budget) or a local nonce-seen cache (cache/log split-brain) — each introduce a NEW failure surface to deliver a property the bounded-trust threat model does not require. A sibling operator inspecting the log between `/codify` cycles sees no discrete `gate-approval-consumed` row, only the implicit composition; this is the §4.5 audit-trail-completeness residual (detection-eventually-at-fold-time per the §1.1 general law). Downstream consumers MUST NOT re-open this question — the disposition is co-owner-DECISIONed at journal/0133.

## 5. Lifecycle hooks

Two consolidated lifecycle hooks per §4.3 — both fail-open with a 10s budget; the session-start hook subsumes the prior standalone drift-warner:

- **`multi-operator-sessionstart.js`** (session-start, advisory) — zero-network. Surfaces: identity, sibling sessions + claims + override counts, operative posture, rules-changed (with staleness caveat), team-memory index, peer ref-regression + genesis-generation-regression check, rule-10 revocation-contest surface (any contested/forged revocation naming a live operator → loud advisory + names the forging signer), owner-action audit surface, degenerate-marker surface. Drift attribution own-WIP vs claimed-WIP. `operator-register` rows in a segregated "UNVERIFIED self-claims" section.
- **`multi-operator-sessionend.js`** (session-end, never blocks) — releases own claims; appends a `compaction-checkpoint` if size/age trigger met (owner with co-signer reachable, or genuine-genesis-degenerate self-sign — NOT migration, NOT owner-add, NOT revocation-induced-N=1); atomic `.session-notes` regen.

```text
# DO — let the session-start hook surface staleness + sibling state
session start → banner reads: "siblings: alice (claim packages/auth/**), bob (last hb 7m ago)"

# DO NOT — disable the session-start hook to skip the staleness advisory
disable multi-operator-sessionstart.js           # session enters with no peer-state view
edit packages/auth/login.py                       # silently SAME-class with alice's active claim
```

**Why:** The session-start hook is the only mechanism that gives a session a zero-network read of peer state before the first edit. Disabling it converts every SAME-class edit into a post-hoc merge-contest discovery instead of a pre-edit halt.

## 6. Generation rotation + genesis migration

`refs/coc/coordination(-genN)` carries the log; `refs/coc/archive-genN` carries the cold checkpoint-exempt-record archive. The PRIMARY defense for the equivocation-parity new-ref residual is server-side, per journal/0125 CONFIRMED-PREVENTION verdict: a GitHub ruleset declaration on `refs/coc/**` with **four** rule types — **`creation`** (restricts ref creation to bypass-allowlisted operator identities) + **`deletion`** (same; restricts ref deletion) + **`non_fast_forward`** (preserves existing protection) + **`required_signatures`** (every commit on these refs MUST be signature-verified at the server boundary; defense-in-depth pairing with fold rule 1 signature verification). Both `coordination-genN` and `archive-genN` shapes are covered by a single `fnmatch` pattern (`refs/coc/**`). The canonical ruleset payload (including required `name`, `target: "branch"`, `enforcement: "active"`, and `bypass_actors[]` with `actor_type: "RepositoryRole"` + `actor_id: 5` for the Admin role) is authored verbatim at `workspaces/multi-operator-coc/02-plans/ref-protection-spec.md` §"Ruleset configuration".

**Precondition (F48 — empirical 2026-05-26):** the GitHub ruleset API rejects a POST against `ref_name.include: ["refs/coc/**"]` when the namespace is empty (live evidence: F41 deploy attempt blocked-on-F43). The deploying operator MUST seed `refs/coc/coordination` BEFORE the ruleset POST — a signed empty-tree commit pushed to the remote satisfies the precondition (`git commit-tree -S` + `git update-ref refs/coc/coordination <sha>` + `git push origin refs/coc/coordination:refs/coc/coordination`). The seed is **namespace-occupation only** — NOT the `genesis-anchor` record; per fold rule 9a, the first signed `genesis-anchor` record landed AFTER the seed is the actual trust-root anchor (the seed lacks `type: genesis-anchor` and is structurally a no-op for the coordination-log fold). Skipping the seed → API rejection → ruleset never deployed → prevention layer absent. CONF-2's verdict (journal/0125) was documentation-based (`gh api … rulesets` GET returned `[]`); the live POST rejection mode was first surfaced by F41 retry and codified at F48 audit.

Client-side checkpoint-pin verification has BOTH halves wired: **field presence** by fold rules 5 + 9b (`coordination-log.js:1125-1128` checks `archive_genN_tip_hash` presence; `fold-rule-9b.js:243-256` checks `archive_genN_tip_pin` presence) AND **live tip verification** via `archive-ref.js::verifyArchiveTipPin` invoked from `fold-rule-9b.js:295-343` against the observed `refs/coc/archive-genN` tip (read through `transport-git-ref.js::readArchiveRefTip`, refname-allowlisted to `refs/coc/**`). Mismatch returns rule-9b folded-fail naming expected-vs-observed SHAs. The verifier is opt-in via `ctx.opts.archiveTipVerify` so fixtures can inject a deterministic reader; production fold paths wire the default. **F51 CLOSED** (see this rule's § Origin → "Open follow-up forest items"); the closure commit SHA on `feat/f51-archive-tip-verify` is the durable receipt.

The §4.5 new-ref-creation/deletion residual is **DROPPED** from this rule's residual list per journal/0125; the lower-severity residual that remains — **bypass-list rotation atomicity with gen-counter rotation** — is **operational hygiene, NOT a §4.5 architectural residual** (per `ref-protection-spec.md` §"Lower-severity residual"). The 2-of-N rotation ceremony is the structural defense; the residual is bounded-blast-radius (a compromised bypass identity persists into the new generation only until the next quarterly bypass-list audit). Client-side tip-verification (F51 CLOSED) is the second structural defense against bypass-compromise — both layers hold simultaneously.

`genesis-migration` (rule 9c) is the repo-transfer ceremony: 2-of-N owner-co-signed (NO degenerate self-sign — R6-S-04) AND carries a fresh `gh api repos/{owner}/{repo}` external-owner result == the new `repo_owner`, signed at migration-ceremony time, AND increments a monotonic `genesis_generation` counter. A single owner CANNOT migrate; the colluding-distinct-owner residual is named in §4.5.

```bash
# DO — provision the refs/coc/** ruleset as the primary equivocation-parity defense
# (precondition: refs/coc/coordination is already SEEDED + pushed per F48; ruleset POST against an empty namespace is rejected by the GitHub API)

# STEP 1 (MANDATORY, MANUAL) — resolve the Admin RepositoryRole actor_id for
# THIS org. The numeric role-ID varies between (a) default-schema orgs (where
# Admin is canonically 5) and (b) GitHub Enterprise Cloud orgs with custom
# repository roles (where actor_id integers may collide on the same value).
# The lookup IS NOT scriptable from a generic gh command — it requires reading
# the org's custom-roles configuration. Consult:
#   • workspaces/multi-operator-coc/02-plans/ref-protection-spec.md §"Provisioning procedure"
#   • GitHub Docs § "Available rules for rulesets" → "RepositoryRole bypass actors"
#   • For default orgs: actor_id 5 = Admin (confirm against your org first).
# DO NOT proceed to STEP 2 with a guessed actor_id — silent mis-binding grants
# bypass to the WRONG role (a Sec-MUST-5 prevention-layer-absent failure mode).

ADMIN_ACTOR_ID=<ADMIN-ROLE-ID-RESOLVED-BY-OPERATOR>   # NO default; STEP 1 is mandatory.

# STEP 2 — author the payload with the resolved actor_id substituted literally.
# (No bash :-default expansion — empty ADMIN_ACTOR_ID MUST fail the POST loudly,
#  not silently substitute a guess.)
cat > /tmp/coc-ref-protection.json <<EOF
{
  "name": "coc-ref-protection",
  "target": "branch",
  "enforcement": "active",
  "conditions": {"ref_name": {"include": ["refs/coc/**"], "exclude": []}},
  "rules": [
    {"type": "creation"},
    {"type": "deletion"},
    {"type": "non_fast_forward"},
    {"type": "required_signatures"}
  ],
  "bypass_actors": [
    {"actor_type": "RepositoryRole", "actor_id": ${ADMIN_ACTOR_ID}, "bypass_mode": "always"}
  ]
}
EOF
gh api -X POST "repos/<owner>/<repo>/rulesets" --input /tmp/coc-ref-protection.json

# DO NOT — `gh api -f` with rule-type flags only
gh api -X POST "repos/<owner>/<repo>/rulesets" \
  -f 'rules[].type=creation' -f 'rules[].type=deletion' -f 'rules[].type=non_fast_forward' \
  -f 'conditions.ref_name.include[]=refs/coc/**'
# (the -f form silently omits `name`, `target`, `enforcement`, `bypass_actors`, AND
#  `required_signatures` — POSTing this ships a malformed/under-specified ruleset
#  that does NOT match the canonical spec at ref-protection-spec.md §"Ruleset configuration")

# DO NOT — rely on client-side checkpoint-pin field-presence alone when the server-side surface is available
# (CONFIRMED-PREVENTION is the primary defense; client-side TIP-verification is the
#  second structural defense, wired per F51 — see § Origin "F51 (CLOSED)")
```

**Why:** Pre-CONF-2 the design had to name client-fold/checkpoint-pin AS THE defense because the server-side path was UNCONFIRMED. CONF-2 closed the question at the server (`type: "creation"` + `type: "deletion"` are first-class REST API rule types); the architecture changes from "detection-only" to "prevention-primary, detection-secondary". Deploying the ruleset is the operator's job; the rule body requires both layers because deployment lag would otherwise re-introduce the residual.

**Org-owned bootstrap path (issue #358 — informational).** Distinct from `genesis-migration` above (which relocates an existing trust root and is gated by MUST-4's 2-of-N quorum), the initial `genesis-anchor` ENROLLMENT ceremony has a narrow relaxation for org-owned bootstrap. When `repo_owner_kind === "org"` AND the root commit is unverified (the common case for pre-existing org-owned consumer repos whose root commit was authored by a contributor who didn't sign), the ceremony substitutes the verified-org-admin attestation captured at Step 3 (`role: admin` + `state: active`) as the verified-identity anchor — the gh-api-bound external admin claim is the structurally-equivalent anchor to a signed-root-commit in the user-owned case. The relaxation is captured in the signed `genesis-anchor` record (`gh_api_root_commit_capture` surfaces the unverified state + `gh_api_org_membership_capture` surfaces the admin attestation), so auditors can see WHY the ceremony succeeded under an unverified root commit. The relaxation does NOT apply to user-owned repos (the signed root commit IS the only anchor there) and does NOT apply to org-owned repos where the signer is NOT a verified active admin. The bounded-trust threat model is unchanged.

## 7. Cross-CLI policy registration

Per journal/0124 CONF-1 CONFIRMED verdict, the codex-mcp-guard intercepts `apply_patch` (the Codex per-CLI primitive for file edits) AND policy denials carry block-equivalent severity (MCP `isError: true` is equivalent to a pre-tool-use `process.exit(2)` halt). The validator-13 bijection is satisfied: every Codex `apply_patch` policy MUST be registered under the corresponding CC `Edit`/`Write` matcher set in `settings.json` — that registration IS the bijection driver per `.claude/codex-mcp-guard/extract-policies.mjs:291-296`.

A policy declared as direct-to-MCP-only (no `Edit|Write` matcher entry) NEVER emits to the Codex-side server because the extractor reads `CC_TO_CODEX_TOOLS["Edit|Write"] = ["apply_patch"]` as the propagation map. Validator-13 (the bijection check) hard-blocks sync when a policy is missing one half.

```text
# DO — register the policy under Edit|Write; the extractor fans out to apply_patch
# .claude/settings.json hooks block:
"PreToolUse": [
  { "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "node .claude/hooks/integrity-guard.js" }] }
]
# → extract-policies.mjs reads this; emits policy under apply_patch in policies.json

# DO NOT — declare a direct-to-MCP-only policy without an Edit|Write hook registration
# .claude/codex-mcp-guard/policies.json (hand-authored without settings.json source):
"apply_patch": [{ "source_file": "my-guard.js", "cc_matchers": [], "invocation": "subprocess" }]
# → validator-13 hard-blocks: no Edit|Write matcher → not in CC_TO_CODEX_TOOLS → never emitted
```

**Why:** The bijection driver is one-directional by construction: CC `Edit|Write` → Codex `apply_patch`. A direct-to-MCP policy authored without the CC-side registration ships nothing at sync (the extractor cannot infer it) and the Codex CLI silently lacks the guard — exactly the cross-CLI parity violation `rules/cross-cli-parity.md` MUST-1 blocks.

## 8. Multi-operator capacity considerations

When more than one operator is concurrently active on this repository, the per-session capacity budget at `rules/autonomous-execution.md` § Per-Session Capacity Budget remains the per-shard ceiling — but throughput and contention enter the math through the operator dimension. Capacity is bounded per-`verified_id`, NOT per-session: an operator running two simultaneous sessions still sees one shared budget against the shard-fit gates.

### 8.1 Per-operator capacity is per-`verified_id`, not per-session (MUST)

The shard-fit ceilings at `autonomous-execution.md` § Per-Session Capacity Budget MUST Rules 1–3 (≤500 LOC load-bearing, ≤5–10 invariants, ≤3–4 call-graph hops) apply to ONE operator's in-flight work, regardless of how many sessions that operator has open. An operator opening a second session does NOT double their capacity budget; the operator's `verified_id` is the budget key.

**Why:** Per-session capacity counting lets a single operator silently amplify load past the structural ceiling by opening parallel sessions — the cross-file invariant tracking the ceiling defends against degrades the same way whether load comes from one session or two from the same operator. Per-`verified_id` accounting closes that loophole. See §3 above for the adjacency-class definitions referenced below.

### 8.2 Cross-operator parallelization multiplies throughput only for NON-SAME adjacency (MUST)

The 10× throughput multiplier at `autonomous-execution.md` § 10x Throughput Multiplier (the 3–5× parallel-agent factor) applies to cross-operator parallel work ONLY when the operators' `/claim`-record scopes are NON-SAME-class (INDEPENDENT or ADJACENT per §3 above). SAME-class parallel work across operators is BLOCKED at the hook layer — the `/claim` record is the structural signal that prevents two operators from racing on the same path.

```markdown
# DO — INDEPENDENT/ADJACENT cross-operator parallel work multiplies throughput

Operator A: `/claim packages/auth/**` (INDEPENDENT)
Operator B: `/claim packages/billing/**` (INDEPENDENT)
→ Both proceed; 2× wall-clock multiplier holds within each operator's per-`verified_id` budget.

# DO NOT — SAME-class cross-operator parallel work

Operator A: `/claim packages/auth/auth.py` (SAME)
Operator B: `/claim packages/auth/auth.py` (SAME)
→ Hook-layer block; second operator MUST defer or re-scope.
```

**Why:** SAME-class concurrent edits produce merge conflicts that erase one operator's work or, worse, three-way-merge invariant violations the human reviewer cannot catch without re-reading both sessions' transcripts. The hook layer is the structural defense; "we'll be careful" is not. Throughput-multiplier claims that assume SAME-class concurrency are arithmetically wrong: the merge-loss factor dominates the parallel-execution factor.

### 8.3 `/claim`-record discipline is the coordination signal (MUST)

Sibling sessions discover each other through the multi-operator coordination log, NOT through inferring intent from journal entries or `.session-notes`. An operator opening a parallel session MUST issue a `/claim` for the path scope before editing; readers MUST consult `/claims` (or the equivalent read-only surface) before starting new work to verify the path is not under an active sibling claim.

**Why:** Without an explicit claim record, sibling sessions cannot detect each other in time to avoid SAME-class collision. The claim-record discipline converts "I noticed someone else was working here" (post-merge surprise) into "the hook refused my edit because another operator's claim was active" (pre-edit signal). Cited evidence: journal/0112 (multi-operator-coc architecture v11), journal/0122 (design convergence + claim semantics), journal/0132 (M6 single-writer contention + M7 codify-lease wiring — both depend on the claim record as the coordination substrate).

## MUST clauses

### MUST-1: Every Coordination-Log Record MUST Be Stamped, Chained, And Signed

Every append to `.claude/learning/coordination-log.jsonl` MUST traverse `coc-append.js` (or the equivalent helper in `lib/coordination-log.js`) so the record lands stamped with `verified_id` + `person_id`, hash-chained against the emitter's prior `prev_hash`, and signed over canonical content. Hand-written JSONL appends are BLOCKED.

**Why:** Fold rule 1 rejects unverified records and fold rule 2 rejects broken chains; a hand-written append silently drops on every sibling clone's fold and provides no audit trail. The stamp + chain + signature trio is the substrate's only mechanism for cross-clone authority.

### MUST-2: SAME-Class Edits Require A Prior `/claim`

Any edit to a path matching an active SAME-class claim OR adjacency relation per §4.1 MUST be preceded by a successful `/claim` of that scope. SAME-conflict (`halt-and-report`) halts the session; ADJACENT (`advisory`) surfaces a banner; INDEPENDENT silently auto-claims. Editing-then-claiming retroactively is BLOCKED.

**Why:** A retroactive claim cannot prevent the contest it documents; the F2-1 residual exists precisely because two operators can both adjudicate "proceed" if claim ordering is reversed. Pre-edit claim is the structural defense.

### MUST-3: Gate Approvals Require Distinct `person_id` AND Distinct Bound-GitHub-Collaborator-Login

`operator-gate.js` MUST reject any `gate-approval` whose approver `person_id` matches the requester OR (for owner/senior gates) whose approver's bound GitHub-collaborator-login matches the requester's. `host_role: ci` MUST NEVER be an eligible approver. Self-approval via a second `verified_id` under the same `person_id` is BLOCKED.

**Why:** A second `verified_id` under the same `person_id` is the same human; the distinctness check is the gate's only meaning. Without GitHub-collaborator-login distinctness, a single human with two independently-verified GitHub accounts defeats the 2-of-N quorum — the irreducible §4.5 residual the design accepts only because the gh-api-bound attestation closes every other vector.

### MUST-4: `genesis-migration` Requires 2-of-N Owner-Co-Signatures + Fresh External Check; No Degenerate Self-Sign

A `genesis-migration` record MUST carry 2-of-N owner co-signatures (each from a distinct `person_id`, each bound to a distinct GitHub-collaborator-login), AND a fresh `gh api repos/{owner}/{repo}` external-owner result signed at migration-ceremony time, AND an incremented monotonic `genesis_generation` counter. Degenerate self-sign for migration is BLOCKED, even under a derived N=1.

**Why:** Migration relocates the trust root; the 2-of-N quorum + fresh external check + generation increment is the only mechanism that anchors the new root with an immutable cross-check. A degenerate self-signed migration is structurally indistinguishable from a single owner forging the trust root — the colluding-distinct-owner residual is accepted only because this gate forces the forgery into a 2-of-N quorum of distinct humans.

### MUST-5: `refs/coc/**` Server-Side Ruleset AND Client-Side Checkpoint-Pin Verification

Every repo running the substrate MUST provision a GitHub ruleset on `refs/coc/**` with rule types `creation` + `deletion` + `non_fast_forward` + `required_signatures`, bypass-permission limited to operator-class identities (`actor_type: "RepositoryRole"` + Admin `actor_id`). The deploying operator MUST seed the namespace (signed empty-tree commit on `refs/coc/coordination`, pushed to remote) BEFORE the ruleset POST — the GitHub API rejects ruleset POSTs against empty `refs/coc/**` per F48-empirical (see §6 Generation rotation Precondition clause). Client-side checkpoint-pin verification has both halves wired: **field presence** by fold rules 5 + 9b (`coordination-log.js:1125-1128`, `fold-rule-9b.js:243-256`) AND **live tip verification** via `archive-ref.js::verifyArchiveTipPin` invoked from `fold-rule-9b.js:295-343` against the observed `refs/coc/archive-genN` tip read through `transport-git-ref.js::readArchiveRefTip` (lines 548-607). Mismatch returns rule-9b folded-fail naming expected-vs-observed SHAs. The verifier is opt-in via `ctx.opts.archiveTipVerify` so fixtures can inject a deterministic reader; production fold paths wire the default. Tests at `tests/integration/multi-operator/f51-fold-rule-9b-tip-verify.test.js` (12 tests across PASS / FAIL / live-read-error / R9-A-01 regression / opt-shape guard).

**Why:** CONF-2 (journal/0125) confirmed the server-side ruleset is the primary equivocation-parity defense; the architecture moved from "detection-only" to "prevention-primary, detection-secondary". Defense-in-depth is mandatory because a single operator with compromised bypass credentials still cannot equivocate without the client also accepting a divergent ref. Treating client-side field-presence as the ONLY second-line defense re-opens the residual on bypass compromise (a forged checkpoint with a forged pin field would pass the presence check but fail tip-verification); F51 closes this gap. Seed-first ordering is the F41 retry trap — POSTing a ruleset against an empty namespace returns a GitHub API rejection, and skipping seed means the prevention layer never deploys.

### MUST-6: Codex Policies MUST Register Under `Edit|Write` In `settings.json`

Any `codex-mcp-guard` policy intercepting `apply_patch` MUST have a corresponding pre-tool-use matcher entry of `Edit|Write` registered in the `.claude/settings.json` hook table — that entry IS the bijection driver per `.claude/codex-mcp-guard/extract-policies.mjs::CC_TO_CODEX_TOOLS`. Direct-to-MCP-only policy declarations (no `Edit|Write` registration in `.claude/settings.json`) are BLOCKED.

**Why:** Per CONF-1 (journal/0124), the validator-13 bijection check hard-blocks sync when one half is missing. The extractor is one-directional (CC → Codex); a policy without the CC-side registration is invisible to extraction and silently absent on Codex — exactly the per-CLI weakening `rules/cross-cli-parity.md` MUST-1 blocks.

### MUST-7: `genesis-migration` Under Single-Owner N=1 — Org-Admin Anchor (Org-Owned, F86-LIVE 2026-05-29) Or Block (User-Owned); No Degenerate Self-Sign

MUST-4 mandates 2-of-N owner co-signatures for `genesis-migration` AND blocks degenerate self-sign even under derived N=1. When a roster has exactly ONE rostered `person_id` carrying `role: owner` (the structural N=1 case — including the re-anchor case where an existing `genesis.root_commit` pointer is corrected to track the actual repo root), the 2-of-N path is structurally unavailable. **Structural assertion (load-bearing):** under N=1, `genesis-migration` is BLOCKED outright EXCEPT for ORG-OWNED repos, where it MAY proceed ONLY when the migration record carries a fresh gh-api-bound verified-active **org-admin attestation** (`content.co_sign_anchor_kind: "gh_api_org_membership_capture"`, `co_signers: []`, the canonical `gh_api_org_membership_capture` + `gh_api_owner_capture` shapes, `genesis_generation` increment, all inside the signed `content` envelope) — the only structural-equivalent anchor to the absent second human. For USER-OWNED repos under N=1 the migration MUST refuse with `genesis-migration: user-owned N=1 has no structural co-sign anchor; add a second owner via /whoami --register before migrating`. Degenerate self-sign is BLOCKED in EVERY form (second `verified_id` under one `person_id`; two GitHub-logins under one `person_id`; sock-puppet second `person_id` enrolled mid-ceremony to escape to MUST-4's 2-of-N path). The bound org-admin login MUST be distinct from any other rostered `person_id`'s login (vacuous under N=1, mandatory if the roster grows mid-ceremony). Fold-time, the folding clone re-verifies the signature AND re-checks `_isCaptureFresh(..., {freshnessMs: MIGRATION_LIVENESS_TTL})` (`MIGRATION_LIVENESS_TTL = 15 min`), rejecting on either failure.

**Enforcement state (F86 — LIVE 2026-05-29, commits `6bbeb44` + `758ad13`):** `fold-rule-9c.js` dispatches on the `co_sign_anchor_kind === "gh_api_org_membership_capture"` discriminator (`CO_SIGN_ANCHOR_KIND_ORG_ADMIN` export at `fold-rule-9c.js:63`), routing canonical N=1 records through the org-admin branch (lines 240-481) and rejecting malformed variants with the corresponding sub-clause citation; the 2-of-N path (`fold-rule-9c.js:483-519`) is unchanged. The paired-landing hook `fold-amendment-paired-with-helper.js` enforces SAME-COMMIT helper⇔fold discipline. The re-anchor sub-case re-points the trust root via fold rule **9c / latest-wins** (NOT 9a / first-wins — see the F88 forest entry below + `journal/0173`).

```text
# DO — org-owned + N=1: record carries the org-admin discriminator + fresh capture, signed into content
{ "type": "genesis-migration", "verified_id": "548F..",
  "content": { "co_signers": [], "co_sign_anchor_kind": "gh_api_org_membership_capture",
               "gh_api_org_membership_capture": { "role": "admin", "state": "active", ... },
               "genesis_generation": 1 }, "sig": "<over canonical(content)>" }

# DO NOT — degenerate self-sign (second verified_id under same person_id) OR user-owned org-anchor substitution
{ "type": "genesis-migration", "content": { "co_signers": [ { "person_id": "pid-esperie-.." } ] } }  # BLOCKED R6-S-04
```

**BLOCKED (summary):** "relax 2-of-N to 1-of-1 for solo founders" / "second `verified_id` is cryptographically distinct, that's enough" / "if MUST-7 blocks, enroll a second `person_id` and route through MUST-4" / "gh api unavailable — fall back to local-only attestation" / "org-admin capture is cacheable across migrations" / "fold-time freshness re-check is redundant". **Full enumerated sub-clauses (a)-(f), fold-time verification (i)-(iii), GitHub-instance threat-model assumption (GHES appliance-admin residual), canonical-shape DO/DO-NOT examples, the complete BLOCKED-rationalization corpus, the relationship to MUST-4's colluding-distinct-owner residual, the re-anchor sub-case, and the gate-review jq mechanical-sweep query live in `.claude/skills/30-claude-code-patterns/genesis-migration-n1-org-admin-anchor.md`** (extracted per F87; the depth-file is the implementer's primary reference for authoring/auditing the helper, the fold amendment, or a `genesis-migration` record).

**Why:** Under N=1 the 2-of-N quorum reduces to "one human signs both halves" — structurally indistinguishable from a single owner forging the trust root (MUST-4's `Why:`). The gh-api-bound org-admin attestation is the only structural-equivalent anchor: captured at ceremony wall-clock time, re-verified at fold time against `MIGRATION_LIVENESS_TTL`, signed into the canonical content envelope so it cannot be appended-after-sign, and tied to a GitHub-server-side admin role the operator cannot forge offline. User-owned repos lack this anchor entirely; the only safe path is enroll a second owner first.

## MUST NOT clauses

### MUST NOT: Edit `.claude/learning/coordination-log.jsonl`, `posture.json`, Or `operators.roster.json` Directly Via The File-Edit Tools

Direct edits to the coordination log, posture cache, or roster via the file-edit / file-write / shell tools are BLOCKED. Settings-level `permissions.deny` enforces this at the pre-tool-use boundary. The only legitimate writers are the canonical helpers (`coc-append.js`, the posture hook, the roster ceremony).

**Why:** State self-modification is the rationalization loophole that defeats the entire substrate — a hand-edit can append unsigned records, downgrade posture without a signed event, or bind an arbitrary key to an owner `person_id`. The hooks are the only legitimate writers, exactly as `rules/trust-posture.md` MUST NOT clause for posture state.

### MUST NOT: Treat A `collaborator-distinctness-revocation` As Settled Before Rule-10 Quiescence

A folded `collaborator-distinctness-revocation` naming operator X MUST NOT unlock the owner-departure removal-only roster edit until rule 10's quiescence predicate fires: the folding clone has observed no contradicting X-activity across a `LIVENESS_TTL`-bounded wall-clock quiescence of X AND has fetched the peer-observed high-water for X's per-emitter chain (the rule-9d mechanism). Treating an unsettled revocation as settled is BLOCKED.

**Why:** A would-be forger that withholds X's heartbeats from its own fold view has by construction NOT fetched X's current chain high-water, so it cannot reach "settled" and cannot unlock the gate. Treating unsettled-revocation as settled converts the §4.5 owner-departure detected-eventually residual into an undetected single-owner quorum-defeat — exactly the path the fetch-bounded settlement closes.

### MUST NOT: Sync `posture.json` Or `coordination-log.jsonl` Between Repos

State files (`posture.json`, `coordination-log.jsonl`, `violations.jsonl`, the `clone-init` chain) MUST NOT propagate through `/sync` or `/sync-to-build`. State is per-repo and per-clone. Insight (rule patterns, allowlist entries) syncs through `/codify`; state stays local.

**Why:** A USE template inheriting a BUILD repo's degraded posture would corrupt downstream. A coordination log shared across repos breaks the per-emitter chain (each clone has its own `clone-init` witness) and silently merges incompatible authority traces.

### MUST NOT: Re-Open The Audit-Trail Completeness Question For `operator-gate.js` Passthrough

The hook-pass-without-immediate-fold-append behavior of `operator-gate.js` IS the disposition per journal/0133 (Option C — intentional by design). The runtime replay-prevention property is the nonce-binding on the signed `gate-approval` record; the durable audit-row materialization is the fold-time composition at the next `/codify` cycle. Re-opening this question (proposing atomic pre-tool-use fold-append OR a local nonce-seen cache) without a forensic-review case proving the implicit composition was insufficient is BLOCKED.

**Why:** The alternatives each introduce a NEW failure surface (recursive-write into the log under a 5s latency budget; cache/log split-brain) to deliver a property the bounded-trust threat model does not require. The §4.5 audit-trail-completeness residual entry IS the placeholder for that future re-evaluation; until a real case surfaces, the disposition stands.

### MUST NOT: Positional Cross-Repo Path Construction In Coordination Tooling

Any coordination-substrate tool (hook, agent, command, lib helper) that needs another repo's on-disk location MUST resolve it through `bin/lib/loom-links.mjs::resolveRepo(<logical-key>)` per `rules/cross-repo.md` MUST-1. Positional construction (`~/repos/<name>`, `../<name>`, `path.join(HOME, "repos", <name>)`) is BLOCKED.

**Why:** Cross-repo positional guessing makes the substrate's NAME→location binding silently operator-dependent; one operator's tooling resolves the right directory and a sibling's resolves nothing — re-creating the same fragility the resolver design closes.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer surfaces violations at `/codify` validation); `block` at the pre-tool-use boundary for structural primitives (signature-verify failure, broken chain, missing claim on a SAME-class write); `advisory` at the session-start surface for lifecycle banners. Per `rules/hook-output-discipline.md` MUST-2, judgment-bearing gates do not carry `block`; structural primitives do.
- **Grace period:** 14 days from rule landing. Existing repos with no enrolled multi-operator substrate are exempt by construction (the rule's hooks are no-ops without an `operators.roster.json`); a repo enrolling its first second operator enters grace at enrollment.
- **Cumulative posture impact:** any same-class violation (hand-written log append, SAME-class edit without claim, gate self-approval via second key, direct posture/log/roster edit) contributes to the cumulative-downgrade math per `rules/trust-posture.md` MUST Rule 4 (5× in 30 days → drop posture).
- **Regression-within-grace:** any same-class violation within 14 days of rule landing triggers emergency downgrade L5→L4 per `rules/trust-posture.md` MUST Rule 4. Trigger key `multi_operator_coordination_violation` added to trust-posture.md emergency-trigger list (1× = drop 1 posture).
- **Receipt requirement:** SessionStart MUST require `[ack: multi-operator-coordination]` in the agent's first response IF `posture.json::pending_verification` includes this rule_id (set at land-time, cleared after grace).
- **Detection mechanism:** structural — fold rule 1 (sig verify) + rule 2 (chain integrity) + rule 3 (fork detection) execute at every fold; `adjacency-leasecheck.js` enforces MUST-2 at pre-tool-use; `operator-gate.js` enforces MUST-3; `genesis-anchor-guard.js` enforces MUST-4; the `refs/coc/**` ruleset enforces MUST-5 server-side; validator-13 (`tools/cli-drift-audit.mjs` + `.claude/codex-mcp-guard/extract-policies.mjs`) enforces MUST-6 at sync-time. MUST-7 enforcement LIVE post-F86 (2026-05-29, closure commits `6bbeb44` + `758ad13` on branch `codify/esperie-2026-05-29`): the paired `genesis-ceremony.js::performMigration` codepath + `fold-rule-9c.js:226-519` amendment ship as the structural defense — helper detects roster N=1 + `repo_owner_kind` + `host` config; on `org` requires `gh_api_org_membership_capture` canonical shape with `_isCaptureFresh(capture_ts, ceremony_ts, {freshnessMs: MIGRATION_LIVENESS_TTL=15min})` + `gh_api_owner_capture` + `genesis_generation` increment + `content.co_sign_anchor_kind: "gh_api_org_membership_capture"` discriminator + signature canonical bytes covering capture; on `user` OR on `host: "ghes-shared-appliance"` returns typed `genesis-migration: user-owned N=1 has no structural co-sign anchor` error; re-anchor sub-case requires local + `origin/<default-branch>` `git rev-list --max-parents=0` SHA agreement + `gh api commits/{root_commit}` verification + `content.pre_correction_root_commit` field; paired fold-rule-9c.js amendment dispatches on the discriminator at fold time and re-verifies capture freshness against `MIGRATION_LIVENESS_TTL`. Paired-landing hook `.claude/hooks/fold-amendment-paired-with-helper.js` (PostToolUse Bash on `git commit`) enforces the SAME-COMMIT discipline structurally so helper-without-fold or fold-without-helper amendments halt-and-report at commit time per `hook-output-discipline.md` MUST-1. The mechanical sweep query (extracted to the F87 depth-file `.claude/skills/30-claude-code-patterns/genesis-migration-n1-org-admin-anchor.md`; jq against `.claude/learning/coordination-log.jsonl`) remains as a defensive cross-check at gate-review for malformed records that have not yet been folded. The full MUST-7 procedural contract (enumerated sub-clauses (a)-(f), fold-time verification (i)-(iii), GitHub-instance threat-model assumption, canonical-shape examples, BLOCKED corpus, re-anchor sub-case, sweep query) lives in that depth-file per F87. Audit fixtures one-per-scope-restriction-predicate at the per-hook directory (e.g. `.claude/audit-fixtures/adjacency-leasecheck/`, `.claude/audit-fixtures/operator-gate/`, `.claude/audit-fixtures/genesis-anchor-guard/`) per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md` MUST-4; MUST-7 audit fixtures shipped with F86 at `.claude/audit-fixtures/genesis-anchor-guard/must-7-single-owner/` (8 fixtures + README predicate matrix covering canonical-pass + (b) co_signers, (c) freshness + role + state, (e) discriminator-absent, (g) login-bind, user-owned-block).
- **Violation scope:** `operator` — every `violations.jsonl` row carries the stamped emitting `person_id` + `sig`; downgrades apply to the operator's per-operator posture, not the `repo_floor`. A repo-floor downgrade requires an owner-class signed `posture-event` and the gate matrix's `repo_floor restore` gate (§6.4).
- **Origin:** See § Origin below.

## Origin

Architecture v11 CONVERGED 2026-05-19 (`workspaces/multi-operator-coc/02-plans/01-architecture.md`, Rounds 10+11 clean). Decision-record chain at the ROOT `loom/journal/`: `0112` (architecture), `0122` (CONVERGENCE receipt). CONF-1 + CONF-2 closure: `0124` (codex `apply_patch` enforceability + validator-13 bijection CONFIRMED), `0125` (GitHub ref-creation/deletion rulesets CONFIRMED-PREVENTION). M6 + M7 convergence receipt: `0132`. Sec-MED-3 disposition (audit-trail completeness — Option C intentional-by-design): `0133`. Originating user brief: 2026-05-19 multi-operator-coc scaling brief. Authored at F14 Shard F-1 (M8 of the multi-operator-coc workstream) per `workspaces/multi-operator-coc/02-plans/01-architecture.md` §11 row F.

**Open follow-up forest items (in-tree registry per `verify-resource-existence.md` MUST-4):**

The registry below is the in-tree receipt surface for forest items the rule depends on. Each entry MUST carry actionable acceptance criteria + a call-graph anchor that resolves via `grep` per `spec-accuracy.md` MUST-1. The receipt for a CLOSED item is the commit SHA itself (visible via `git log feat/f50-phase2-* --grep=<F-ID>` against the rule file's history); the receipt for an OPEN item is this entry plus its acceptance criteria. The M9.x deferred-enrollment carve-out structurally blocks signed `journal/NNNN` writes by unrostered operators, so this registry is the operator-portable receipt path until F19 enrollment lands.

- **F51 (CLOSED 2026-05-27) — wired `verifyArchiveTipPin` into the fold path.** Fold rule 9b at `fold-rule-9b.js:295-343` invokes `verifyArchiveTipPin` (`archive-ref.js:67-104`) against the observed `refs/coc/archive-genN` tip; live tip is read through `transport-git-ref.js::readArchiveRefTip` (lines 548-607), refname-allowlisted to `refs/coc/**`, `execFileSync` with arg-array form. Mismatch returns rule-9b folded-fail naming expected-vs-observed SHAs per `rules/observability.md` Rule 5. Verifier opt-in via `ctx.opts.archiveTipVerify` (production fold paths wire the default; fixtures inject a deterministic reader). Tests: `tests/integration/multi-operator/f51-fold-rule-9b-tip-verify.test.js` (12 tests, +532 lines). Rule 5 symmetric wiring is OUT OF SCOPE (rule-5 records carry a bare `archive_genN_tip_hash` string without a ref name); rule-9b's transitive re-anchor catches tampered rule-5 hashes at the next rotation — documented at `coordination-log.js:1131-1137`.
- **F52 (CLOSED 2026-05-27) — relocated the clone-init witness to a separate-location sentinel.** `CLONE_INIT_WITNESS_FILE` in `state-io.js:52` now resolves OUTSIDE `.claude/learning/` via `resolveWitnessPath(repoDir)` (lines 138-200): production uses `<git-common-dir>/coc-clone-init-witness` (sibling to `.claude/`, worktree-aware via `git rev-parse --git-common-dir`); test sandboxes use `<sandboxRoot>/.coc-clone-init-witness`; fallback is `<repoDir>/.git/coc-clone-init-witness`. A directory-sweep adversary (`rm -rf .claude/learning/*`) no longer defeats the witness — `discriminateState` (`posture-v2.js:404`) fires the `!initMarkerExists && cloneInitWitnessExists` branch and returns `corrupt-L1` (fail-closed). Migration helper `migrateWitnessIfPresent` (state-io.js:218-333) ports legacy witnesses from `<stateDir>/.coc-clone-init-witness` to the new location atomically (`.tmp` + `rename` + `fsync` + mode 0o600 per `knowledge-convergence.md` MUST-6); called from `readPosture` at line 460 (idempotent, best-effort). Tests: `.claude/test-harness/tests/posture-v2-migration.test.mjs` — prior HIGH-1 residual test 15 flipped L5 → L1 + 4 new tests (genuine-fresh-clone regression, migration helper, migration idempotence, `resolveWitnessPath` surface). All 20 tests pass.
- **F87 (CLOSED 2026-05-29) — extracted MUST-7's enumerated sub-clauses (a)-(f) + fold-time verification (i)-(iii) + Threat-model assumption + Re-anchor sub-case + mechanical sweep query) into a depth-file at `.claude/skills/30-claude-code-patterns/genesis-migration-n1-org-admin-anchor.md` per `agents.md` § Audit/Closure-Parity Specialist Discipline extraction pattern + `self-referential-codify.md` Rule 2 "Skills (codify-discipline)" allowlist coverage.** Acceptance criteria: (1) the depth-file lands under `.claude/skills/30-claude-code-patterns/` (per F20 / journal/0143 extraction precedent — `closure-parity-specialist-discipline.md` is the sibling); (2) MUST-7's rule body is reduced to its structural assertion + a one-paragraph pointer to the depth-file (the procedural contract lives in the depth-file); (3) the depth-file carries the canonical-shape DO/DO-NOT examples + BLOCKED rationalization corpus + jq mechanical sweep query + fold-time verification contract — keeping the rule body skim-readable while preserving institutional knowledge; (4) cross-references from F86 acceptance criteria + Detection-mechanism field updated to cite the depth-file; (5) F87 closure does NOT modify the rule's structural-invariant assertion (the rule body still holds MUST-7 as a load-bearing structural defense, the depth-file carries the procedural contract). Origin: F60 R2 security-reviewer LOW-R2-1 advisory finding (2026-05-28 R2 audit, this rule's `1e56668` commit) — prose-density at MUST-7 lines 310-422 nears skim-readability upper bound (~110 lines including 9-sub-clause sentence at line 314); extraction is polish, not correctness gap. Bounded by: F86 closure (the depth-file becomes the implementer's primary reference once the helper + fold amendment land; until F86, the rule body remains the structural contract). **CLOSED 2026-05-29 (F87 wave, journal/0174):** all 5 acceptance criteria satisfied — depth-file landed at `.claude/skills/30-claude-code-patterns/genesis-migration-n1-org-admin-anchor.md`; MUST-7 rule body reduced to its structural assertion + a minimal DO/DO-NOT example + BLOCKED-summary + depth-file pointer (criteria 2+3, following the `agents.md`→`closure-parity-specialist-discipline.md` extraction precedent); F86 criteria cross-ref + Detection-mechanism field updated to cite the depth-file (criterion 4); the structural-invariant assertion is preserved in the rule body (criterion 5). Receipt: this rule's compact MUST-7 body + journal/0168 § Outstanding-ledger + journal/0174.
- **F86 (CLOSED 2026-05-29) — shipped `genesis-ceremony.js::performMigration` codepath + paired `fold-rule-9c.js:226-519` amendment for MUST-7 (single-owner re-anchor + N=1 dispositions) + paired-landing hook `fold-amendment-paired-with-helper.js` + 10-scenario test suite + 8 audit fixtures.** Closure receipts: commits `6bbeb44` (helper + paired fold amendment in SAME COMMIT per criterion 6) + `758ad13` (hook + tests + fixtures) on branch `codify/esperie-2026-05-29`; receipt journal `journal/0170-esperie-DECISION-f86-f70-f71-parallel-wave-2026-05-29.md`. Acceptance criteria (1)-(8) plus paired-landing hook ALL satisfied per R1 multi-agent redteam: reviewer APPROVED (10/10 mechanical sweeps pass), security-reviewer APPROVED (18/18 threat-model surfaces verified, zero CRIT/HIGH/MED/LOW), cc-architect ACCEPT_WITH_FIXES (this very prose update resolves MED-1 + MED-2). Acceptance criteria preserved for audit trail: Acceptance criteria: (1) ceremony helper accepts `{ kind: "re-anchor" | "migration", new_root_commit?, pre_correction_root_commit?, repo_owner_kind, host?, owner_signature, gh_api_owner_capture, gh_api_org_membership_capture?, genesis_generation }`; emits a `genesis-migration` record with `verified_id` at record-level, `content.co_signers: []`, `content.co_sign_anchor_kind: "gh_api_org_membership_capture"` (the explicit discriminator fold-rule-9c dispatches on), and signs the entire `content` block including the capture into canonical bytes per `knowledge-convergence.md` MUST-6; (2) under N=1 + org-owned, validates `gh_api_org_membership_capture.role === "admin"` + `state === "active"` + `user.login` matches the sole owner's `person_id`'s bound GitHub-collaborator-login + `organization.login` matches `gh_api_owner_capture.owner_login` + `_isCaptureFresh(capture_ts, ceremony_ts, {freshnessMs: MIGRATION_LIVENESS_TTL})` returns true; the constant `MIGRATION_LIVENESS_TTL = 15 * 60 * 1000` MUST be exported from `.claude/hooks/lib/gh-api-allowlist.js` (distinct from the existing `GH_API_CAPTURE_FRESHNESS_MS = 5 * 60 * 1000` for routine enrollment); (3) under N=1 + user-owned OR under `host === "ghes-shared-appliance"` config flag, returns typed error `genesis-migration: user-owned N=1 has no structural co-sign anchor; add a second owner via /whoami --register before migrating`; (4) re-anchor sub-case verifies (a) `git rev-list --max-parents=0 HEAD` locally + (b) `gh api commits/{new_root_commit}` returns `verification.verified === true` + (c) the new SHA matches local root + (d) `git rev-list --max-parents=0 origin/<default-branch>` matches `new_root_commit` to close the mid-ceremony `git filter-repo` divergence residual; emits `content.pre_correction_root_commit: <old-SHA>` as a top-level field on the record's content block (distinct from `gh_api_root_commit_capture` which carries only the new SHA's gh-api verification) so fold rule 9a can re-anchor first-wins semantics with full audit-trail; (5) writes the migration record via `coc-append.js` so fold rule 9a (NOT 9c — re-anchor first-wins is rule 9a per MUST-7 `Re-anchor sub-case`; rule 9c is the migration-discipline gate) re-anchors first-wins semantics; (6) **paired `fold-rule-9c.js` amendment lands in the SAME COMMIT** — the predicate at lines 217-250 MUST be extended to accept records with `content.co_signers.length === 0` AND `content.co_sign_anchor_kind === "gh_api_org_membership_capture"` AND `content.gh_api_org_membership_capture` present-and-canonical AND `gh_api_org_membership_capture.capture_ts` fold-time-fresh per `_isCaptureFresh({freshnessMs: MIGRATION_LIVENESS_TTL})`; records lacking the discriminator OR with stale capture MUST still be rejected per current R6-S-04 semantics; the amendment MUST NOT silently relax the existing 2-of-N path for N≥2 (the amendment is N=1-specific dispatched on roster size at fold time); (7) tests at `tests/integration/multi-operator/f86-must-7-single-owner.test.js` covering PASS / org-admin-attestation-stale-ceremony-time / org-admin-attestation-stale-fold-time-replay / user-owned-N=1-block / ghes-shared-appliance-block / re-anchor-SHA-mismatch-local / re-anchor-SHA-mismatch-origin / sock-puppet-second-person_id-bypass-attempt / signature-canonical-bytes-tamper-after-sign / 2-of-N-bypass-attempt-N≥2-path-still-required-2-distinct-signers; (8) audit fixtures committed at `.claude/audit-fixtures/genesis-anchor-guard/must-7-single-owner/` covering one fixture per scope-restriction predicate per `cc-artifacts.md` Rule 9. Closure receipt: this rule's MUST-7 Detection-mechanism field updated with the SHA of the closure commit + the F86 forest-item entry retitled `(CLOSED <date>)` per `worktree-isolation.md`-style registry convention. Tracks the loom-internal re-anchor for `genesis.root_commit` (current pointer `398076d50733ab74ecba1526969cca8bded3d653`, actual root `d98da8b8088ad5afe1e1a0232c18aa41e2db99d9`) — that operator-level re-anchor proceeds only AFTER F86 lands the helper + paired fold amendment. Origin: F60 wave 2026-05-28 per journal/0168 + R1 redteam dispositions amended R2 per journal/0168 § R1+R2 receipt.
- **F53 (CLOSED 2026-05-27) — atomic-write defense-in-depth hardening for `migrateWitnessIfPresent`.** Both LOW findings from F52 security-reviewer Round 1 (`security-reviewer` task `a271c962`, "optional defense-in-depth; closure of Wave2-R2 NEW-3 achieved") are now wired. **(a) Symlink-redirect defense:** the tmp open builds `tmpFlags = O_WRONLY | O_CREAT | O_TRUNC | (O_NOFOLLOW || 0)` (`state-io.js:299-303`) and `fs.openSync(tmp, tmpFlags, 0o600)` (`state-io.js:312`) — `O_NOFOLLOW` raises `ELOOP` on a symlink pre-planted at `<git-common-dir>/coc-clone-init-witness.tmp.<pid>` instead of following it through to an attacker sink; the `|| 0` guard degrades to plain "w" semantics on platforms lacking `O_NOFOLLOW` (e.g. Windows), and that degradation is surfaced observably as `nofollow_supported` on the return shape (`state-io.js:309,381`) per `observability.md` rather than silently weakening the write. **(b) Crash-durability:** after `fs.renameSync(tmp, newPath)` (`state-io.js:331`) and BEFORE the legacy unlink, the parent dir of `newPath` is fsynced (`state-io.js:351-361`: `openSync(parent, "r")` → `fsyncSync` → `closeSync`), so the crash-window invariant holds — the witness is present at `legacy` OR durably at `newPath`, never neither (the `fsync(parent)` barrier makes newPath durable BEFORE legacy removal begins; a crash can at worst leave the witness at BOTH locations, a recoverable no-op the next idempotent migrate cleans up). Directory-fsync is best-effort (Windows raises `EISDIR`/`EPERM`); a failure surfaces structurally as `parent_dir_synced: false` on the return shape (`state-io.js:380`) per `zero-tolerance.md` Rule 3 (observable, not a silent swallow) and does NOT fail the functionally-complete migration. Tests: `.claude/test-harness/tests/posture-v2-migration.test.mjs` — F53 (a) pre-plants a symlink at the tmp path and asserts typed refusal (`migrate: write tmp:`) + attacker-sink untouched + legacy intact + newPath uncreated; F53 (b) intercepts `openSync`/`fsyncSync` to prove the parent-dir fd was opened AND passed to `fsyncSync`, and asserts `parent_dir_synced` + `nofollow_supported`. All 22 tests pass (20 prior + 2 F53). **Redteam convergence (per `self-referential-codify.md` MUST-1 — surface touches `state-io.js` + this rule):** reviewer + security-reviewer + cc-architect dispatched in parallel; Round 1 zero CRIT/HIGH (reviewer + cc-architect clean; security-reviewer 2 MEDIUM + 3 LOW, all bounded-trust residuals). Round 2 resolved by construction (security-reviewer task `ad7cc72b48f7be593`): MEDIUM-2 (cross-dir crash "neither") WITHDRAWN — the step-3 `fsync(parent)` barrier precedes step-4 legacy-unlink, so "neither" requires a post-fsync durability violation (outside any threat model). **Accepted residuals (bounded-trust, no clean Node fix — registered alongside the F51-LOW note):** (i) a directory-component symlink ABOVE the final tmp component is NOT covered by `O_NOFOLLOW` (which guards the final component only); Node exposes no `openat`/dirfd-relative open for atomic stepwise resolution, `realpathSync`-prefix breaks on macOS `/var`→`/private/var`, and `lstat`-then-open is TOCTOU-weaker than the atomic `O_NOFOLLOW` already shipped — bounded because the witness is per-clone-LOCAL and symlinking `.git`/ancestor breaks the clone; (ii) `O_EXCL` omitted — a regular-file pre-plant at the pid-suffixed tmp only truncates (no redirect; content non-secret), adding a stale-tmp-blocks-migration edge for zero security gain. The closure commit SHA on `feat/f53-atomic-write-defense-in-depth` is the durable receipt (visible via `git log --grep=F53` against this rule's history). **F51 LOW (TOCTOU race between live tip read and verify)** — accepted per bounded-trust threat model; documented inline at `fold-rule-9b.js:295-343`; NOT a separate F-item.
- **F88 (CLOSED 2026-05-29) — fixed two re-anchor defects F86's mock-transport tests hid + corrected the 9a→9c prose.** F86's `performMigration` re-anchor path was not safely executable: (1) it hard-stamped `seq:0/prev_hash:null`, forking under fold rule-3 against the existing genesis-anchor and falsely flagging the owner as an equivocator; (2) `foldGenesisMigration` inherited `root_commit` from the prior trust root, so a re-anchor folded clean but never re-pointed the root (generation bump only). Fix: `performMigration` derives `seq/prev_hash` from the emitter's chain head (injected `readChainHead`; default folds the live log via `computeOwnChainHead`); `foldGenesisMigration` re-points `trustRoot.pinnedFacts.root_commit` to `gh_api_root_commit_capture.sha` for re-anchor records (hex-shape + fold-time `_isCaptureFresh(MIGRATION_LIVENESS_TTL)` gated), inherits for owner-relocation migrations, rejects malformed. The paired-landing hook's helper-side trigger narrowed from the bare `performMigration` name to the dispatch-contract symbols (`co_sign_anchor_kind` / `CO_SIGN_ANCHOR_KIND_ORG_ADMIN` / `gh_api_org_membership_capture` + the re-anchor coupling `gh_api_root_commit_capture` / `pre_correction_root_commit`) so routine maintenance no longer false-positive-halts. **This entry SUPERSEDES the F86 criteria (4)+(5) "fold rule 9a / first-wins" attribution above: re-anchor supersession is fold rule 9c / latest-wins (9a never sees a migration record).** Tests: `tests/integration/multi-operator/f88-reanchor-chain-continuation.test.js` (5: fix + pre-fix-fork regression + malformed/stale/non-hex rejects) + `f88-paired-landing-hook-precision.test.js` (5). Multi-agent redteam R1→R2: reviewer APPROVED, security-reviewer + cc-architect findings (re-anchor capture freshness gate, sha hex-bound, 9a→9c prose, hook re-anchor coupling) all resolved-by-construction. Receipts: journal/0172 (DECISION) + journal/0173 (R1+R2 AMENDMENT).

**Length rationale (per `rules/rule-authoring.md` MUST NOT length cap, anchored at this Origin).** This rule body exceeds the 200-line guidance (current length grows with F-series follow-up registry entries below). Named rationale: **substrate scope**. The rule codifies a multi-stakeholder runtime substrate across 8 distinct sections (identity, log, claims/leases, posture/gate, lifecycle hooks, generation rotation, cross-CLI policy, multi-operator capacity) plus 7 MUST clauses + 5 MUST NOT clauses + full Trust Posture Wiring (MUST-7 added 2026-05-28 per F60 wave journal/0168 — single-owner N=1 `genesis-migration` discipline; LIVE post-F86 closure 2026-05-29 per F86 wave journal/0170 — helper + paired fold amendment + paired-landing hook shipped together). Each section carries non-overlapping invariants the bounded-trust threat model requires holding simultaneously. Splitting into sub-rules would fragment the threat model across files and force cross-rule lookups for every coordination decision — exactly the load-failure mode `rules/cc-artifacts.md` Rule 6 warns against. Per `rules/rule-authoring.md` MUST NOT § "Rules longer than 200 lines": the cap is guidance; overage is permitted with named rationale anchored at the rule's Origin. Sibling precedent: `user-flow-validation.md` Origin carries the same length-rationale shape (walk-discipline + scrub-discipline non-separable).
