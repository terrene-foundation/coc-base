---
name: whoami
description: "Show operator identity or register a person via PR; includes enrollment ceremony subcommands."
---

# /whoami — Multi-Operator Identity

The identity-surface command for multi-operator COC ((loom-internal reference) §2.1 + §2.3). The `--register`, `--enroll-genesis`, `--owner-add`, `--owner-depart` ceremonies and the no-args read-only display all shipped under M0; `--add-key` closes the one §2.1 capability that had no producer — an append to an EXISTING `person_id`'s key list.

## Subcommands

### `/whoami` (no args) — print identity

Resolves the active operator via `resolveIdentity(cwd)` in `.claude/hooks/lib/operator-id.js` (architecture §2.1): signing-key fingerprint → roster `persons[]` lookup → identity tuple. A hint-only cache at `.claude/operator-id` (gitignored, per-clone) is re-derived on absence / corruption / fingerprint mismatch — tampering is harmless.

Three output shapes; each line is `<field>: <value>`:

- **Rostered key** — prints `display_id`, `person_id`, `verified_id`, `role`, `host_role`, `posture`. Posture is the operative result the C1 gate composes from `repo_floor` + per-operator state (architecture §6.1); on a fresh repo defaults to `L5_DELEGATED`.
- **Un-rostered key (signing key configured but not in `operators.roster.json`)** — `display_id` and `person_id` print as `(unregistered)`, `verified_id` shows the live fingerprint, `posture: L2_SUPERVISED`, plus `next: /whoami --register` (architecture §6.1 block-into).
- **No signing key configured** — `verified_id: (no signing key)`, `posture: L2_SUPERVISED`, `next: configure signing key, then run /whoami --register`. (The L2_SUPERVISED `next:` pointer is advisory display; gate-side block-into enforcement is C1's job, not this command's.)

### `/whoami --register` — propose a new person_id (PR-only)

Appends a new `person_id` entry to `.claude/operators.roster.json` via a feature-branch PR. **NEVER writes directly to `main`** — branch protection on `operators.roster.json` enforces the PR flow (architecture §2.3 + §6.4).

The flow:

1. **Collect inputs** (interactive prompts to the operator):
   - `display_id` — advisory human-readable handle (e.g. `bob`, `bob-laptop`).
   - `github_login` — the operator's GitHub collaborator login.
   - `host_role` — `human` (interactive workstation) or `ci` (deploy-key on a runner).
   - signing-key `type` — `ssh` (default) or `gpg`.
   - signing-key `fingerprint` — for SSH, the output of `ssh-keygen -lf <pubkey>` (the `SHA256:…` form); for GPG, the 40-hex long fingerprint from `gpg --list-keys --with-colons`.
   - signing-key `pubkey` — the armored public key body (the full `ssh-ed25519 AAAA…` line for SSH, or the `-----BEGIN PGP PUBLIC KEY BLOCK-----` block for GPG).

2. **Derive `person_id`** — `pid-<display_id>-<short-fingerprint>`, where `<short-fingerprint>` is the first 8 chars of the SHA-256 of the pubkey body. Immutable per architecture §2.1.

3. **Cut a feature branch** off the current `main`:

   ```bash
   today=$(date -u +%Y-%m-%d)
   branch="codify/${display_id}-${today}"
   git checkout -b "$branch" origin/main
   ```

   The `codify/` prefix matches existing convention; never write directly to main (this is the structural defense — branch protection on `operators.roster.json` rejects direct push).

4. **Edit the roster via the ceremony's canonical script, invoked by its own path** — validate against schema, then write to disk. The roster is a protected state-file owned by the `validate-bash-command.js` guard (`detectStateFileMutationSegmentAware`, Layer 3): only the canonical roster-write path may touch it. The roster ceremony IS that sanctioned canonical writer — it keeps the protected path inside the script body (off the run command line) and writes-then-runs as two separate Bash commands. This two-step canonical-writer shape is the form the guard sanctions; a single bundled write+run command is not (the canonical writer is the one path licensed to write the roster, so the guard recognizes the script-by-path run and lets it through). The lexical guard is defense-in-depth; the load-bearing protections are branch-protection + schema-validation + the PR gate. Full rationale + the sanctioned-canonical-writer contract: `.claude/skills/43-ecosystem-init/SKILL.md` § Operational runbook.

   The verbatim writer script, its `process.env` input contract, and the run-from-repo-root invocation live in `.claude/skills/44-enroll/SKILL.md` § "The `--register` canonical writer" (`cc-artifacts.md` Rule 3: reference material → skills). Supply every input ON the invocation — the script reads each from `process.env`, so without the env prefix the run writes `undefined` and the schema validator fails closed.

5. **New operators default to `role: contributor`.** Promotion to `senior` or `owner` is a separate quorum gate (architecture §6.4) NOT covered by `--register`; it requires `--owner-add` (A0b-2b) for owners and a 2-of-N roster edit for `senior`.

6. **Commit + push + open PR**:

   ```bash
   git add .claude/operators.roster.json
   git commit -m "feat(roster): register ${display_id} as contributor (person_id ${person_id})"
   git push -u origin "$branch"
   gh pr create --title "Register ${display_id} (${person_id})" --body "Adds ${display_id} as a contributor to operators.roster.json. Generated by /whoami --register. Schema-validated; signing key fingerprint ${fp}."
   ```

   The PR enters the existing branch-protection + review chain. **Merge is NEVER via direct push**, NEVER via admin-merge of an owner-self-attesting roster add (that is the C2 gate matrix's job to enforce; this command body produces the proposal, not the merge).

7. **`host_role: ci` recording.** When the operator selects `host_role: ci`, the value is RECORDED in the roster verbatim. **R5-S-04 advisory-ineligibility (no co-signing of owner-quorum, distinctness, gate-approval, or genesis/migration records) is enforced in shard A0b-2c — NOT in this command body.** A `host_role: ci` entry registered today is a valid roster entry; it simply cannot vote.

### `/whoami --add-key` — append a key to an EXISTING person_id (self-service, PR-only)

`persons.<person_id>.keys` is the append-only array `multi-operator-coordination.md` §1 and the schema both describe, and until this ceremony landed NOTHING wrote to it: `--register` MINTS a new `person_id` at `role: contributor`, and none of the other three adds a key to an existing one. The measured consequence was an owner holding one key while their other keys sat under separate contributor `person_id`s — so the owner could not sign with those keys without signing AS a contributor. It is also the precondition for binding `authority` to a signer ROLE at all.

**Self-service ONLY.** An operator adds a key to THEIR OWN `person_id`, proven by SIGNING the request with a key already enrolled under it (naming an enrolled fingerprint is free — the roster is committed). Adding a key to someone ELSE's `person_id` is a quorum-gated roster edit and is REFUSED here rather than half-implemented. `role`, `github_login`, `host_role`, `person_id` and `genesis` are never touched — promotion stays `--owner-add`'s separate quorum gate.

The ceremony is `.claude/hooks/lib/add-key-ceremony.js::runAddKeyCeremony`, run BY ITS OWN PATH as a separate command — the sanctioned canonical-writer shape, with the protected roster path inside the script body and off the run command line. Cut a `codify/` branch off `main` FIRST; the roster only ever lands by PR.

```bash
git checkout -b "codify/addkey-$(date -u +%Y-%m-%d)" origin/main
node .claude/hooks/lib/add-key-ceremony.js --person-id "$pid" --new-key ~/.ssh/id_ed25519.pub          # plan; writes nothing
node .claude/hooks/lib/add-key-ceremony.js --person-id "$pid" --new-key ~/.ssh/id_ed25519.pub --apply  # writes the WORKING TREE
```

Then `git add`/`commit`/`push`/`gh pr create` exactly as `--register` does; merge is the PR gate's job, never a direct push. Add `--new-key-type gpg --new-pubkey <armored-file>` for GPG (the armored export is REQUIRED — the ceremony never guesses at an ambient keyring); `--signing-key <path>` overrides the `git config user.signingkey` default.

**Every refusal is typed and fails CLOSED** (exit 1, code on stderr, nothing written): `roster-unreadable` · `roster-malformed` · `unknown-person` · `not-self-service` · `signer-unrostered` · `signer-unresolvable` · `proof-of-possession-failed` · `duplicate-fingerprint` (already enrolled under ANY person — one key never binds two identities) · `new-key-unresolvable` · `new-pubkey-unreadable` · `bad-key-type` · `append-only-violation` (removal, replacement OR reorder) · `identity-field-change` · `schema-invalid`.

Fingerprints come from `operator-id.js::_fingerprintFromKey` — the SAME resolver that computes `verified_id`; a second derivation that disagreed would enroll a key that never resolves. `--check-against <candidate.json>` runs the append-only + identity-invariant predicates over a roster diff the process did NOT construct, which is the reviewable form a PR gate can run. Fixtures: `.claude/audit-fixtures/roster-add-key/`; procedure depth: `.claude/skills/44-enroll/SKILL.md` § "Adding a key to an existing person_id".

### `/whoami --enroll-genesis` — establish the trust root (network-permitted, blocking, fail-CLOSED)

The one-time enrollment ceremony that establishes the trust root (architecture §2.3 R5-S-01 + R6-S-01; residual-bounded per journal/0117). Network-permitted; blocking; fail-CLOSED — ANY failed verification refuses to emit the genesis-anchor.

**Pre-condition:** the genesis-owner's `person_id` MUST already be in `.claude/operators.roster.json` with `role: owner` and the correct `github_login` (the verified external repo-owner). For a fresh repo this means editing the bootstrap roster OR running `--register` first and promoting the role on the resulting PR.

**The ceremony** (`.claude/hooks/lib/genesis-ceremony.js::runEnrollmentCeremony`):

1. **gh api repos/{owner}/{repo}** — external owner login MUST equal `roster.genesis.repo_owner` (R5-S-01 condition (a)).
2. **Org variant (R5-S-02):** when `repo_owner_kind: org`, ALSO `gh api orgs/{org}/memberships/{login}` MUST return `role == "admin"` for the signing person.
3. **gh api .../commits/{root_commit}** — `commit.verification.verified` MUST be `true`; for user-owned the verified author MUST be the declared owner (R5-S-01 condition (b)).
4. **Condition (c):** the roster MUST declare EXACTLY ONE `owner` `person_id` whose `github_login` resolves to the target login.
5. **Owner-bind:** the signing key's fingerprint MUST match one of that owner's roster keys.
6. **Sign + append (both surfaces):** the record is canonical-serialized (`coc-sign.canonicalSerialize`), signed (`coc-sign.sign`, `keyType: ssh` default), and appended via the composed enrollment-seed transport (`enrollment-seed-transport.js::createEnrollmentSeedTransport`) to the canonical FETCHABLE git ref `refs/coc/coordination-gen<N>` FIRST (`transport-git-ref.js`, uncapped; ref name via `log-ref-name.js::resolveLogRefName`) THEN to the local `.claude/learning/coordination-log.jsonl` cache. Seeding the ref lets a fresh clone fetch-then-fold its trust root (loom#879); a ref-append failure returns a typed error and writes NO local surface (no half-write).

**Captured-and-signed content:** the genesis-anchor record's `content` carries (a) the three pinned facts (`repo_owner`, `repo_owner_kind`, `root_commit`) + `genesis_generation`, (b) the raw `gh api repos/...` body, (c) the raw `gh api .../commits/{root_commit}` body, (d) for org variants the `gh api orgs/{org}/memberships/{login}` body. Fold rule 9a accepts the first verifying owner-bound anchor as the trust root; differing pinned facts on a second verifying anchor → trust-root fork (the §4.5 genesis residual per `journal/0117`).

**Enrollment marker (signed; M0 security review HIGH-2):** the ceremony writes a SIGNED marker file before doing the gh-api capture/sign work and removes it on completion or failure. The marker shape is `{ceremony_start_ts, candidate_signer_fingerprint, target_repo_owner, target_root_commit, sig}` where `sig` is a detached signature over the canonical-serialized marker without `sig`, produced by the candidate signer's key. Set `COC_GENESIS_GUARD_ENROLLMENT_MARKER` to that file's path. The `genesis-anchor-guard.js` hook verifies the signature against a pubkey in the roster (including PLACEHOLDER-prefixed entries for fresh-genesis cases); unsigned / tampered / wrong-key markers do NOT bypass the guard.

**Record-size note:** raw `gh api` bodies can push the record past the 2KB-per-line `MAX_LINE_BYTES` cap of the local filesystem transport (architecture §2.2) — which is exactly why the genesis chain was, pre-loom#879, un-recoverable by a fresh clone (the capped local append was the only writer and it never reached a fetchable ref). The composed enrollment-seed transport (step 6) seeds the enrollment record to the UNCAPPED git ref (`transport-git-ref.js`), so the >2KB genesis-anchor persists to the fetch-then-fold recovery surface in full. The migration ceremony (`performMigration`) wires the SAME composed transport for its own >2KB `genesis-migration` record (per `skills/30-claude-code-patterns/genesis-migration-n1-org-admin-anchor.md` § "Transport wiring"), so on a migrated repo the WHOLE chain (anchor + migration) is fetchable — not the anchor alone.

### `/whoami --owner-add <login>` — distinctness attestation (network-permitted, fail-CLOSED)

Promote an existing `contributor` (registered via `--register`) to `role: owner` by appending a signed `collaborator-distinctness-attestation` capturing `gh api repos/{owner}/{repo}/collaborators` showing the named login IS a distinct collaborator (architecture §2.1).

**Pre-conditions:** target `person_id` already in roster (registered); caller's signing key is an existing `owner` key; `gh` reachable + authenticated. The ceremony is the SECOND signature of a 2-of-N owner quorum roster edit — distinct-`person_id` + distinct-bound-collaborator-login per R5-S-07 (enforced by C2's gate matrix, NOT here).

**The ceremony** (`.claude/hooks/lib/owner-add-ceremony.js::runAttestationCeremony`):

1. **`gh api repos/{owner}/{repo}/collaborators`** — the named login MUST appear in the capture.
2. **Canonical-serialize + sign** record core `{type: "collaborator-distinctness-attestation", verified_id, person_id, seq, prev_hash, ts, content: {github_login, gh_api_collaborators_capture: [...raw...], captured_at_ts}}` via `coc-sign.canonicalSerialize` + `coc-sign.sign` (default `keyType: ssh`).
3. **Append** the signed record to `.claude/learning/coordination-log.jsonl` via A2a transport.
4. **Fold consequence:** the attestation is input to `derive-n.js::computeDerivedN` — `R9-A-02` latest-by-`seq` per login. Subsequent verifying revocation suppresses; later verifying re-attestation re-admits.

**Honest scope (R7-S-02):** the attestation proves the login IS _a repo collaborator_, NOT human-distinctness — a sock-puppet satisfies it. Named inside the §4.5 distinct-owner-collusion residual.

### `/whoami --owner-depart <login>` — distinctness revocation (network-permitted, fail-CLOSED)

Mark an `owner` as departed by appending a signed `collaborator-distinctness-revocation` capturing FRESH `gh api repos/{owner}/{repo}/collaborators` showing the named login is **no longer** a collaborator (architecture §2.1).

**Pre-conditions:** target `github_login` corresponds to an `owner`-role person; `gh` reachable. **A revocation without fresh gh-api proof is INVALID** (defeats _omission_); genuine offline departure → loud `halt-and-report`. Revoker has folded coordination-log up to a known recent point AND knows the most-recent X per-emitter chain entry (used to populate the R10-A-02 evidence window).

**The ceremony** (`.claude/hooks/lib/owner-depart-ceremony.js::runRevocationCeremony`):

1. **Fresh `gh api .../collaborators`** — login MUST NOT appear; still-present → fail-CLOSED.
2. **Build R10-A-02 evidence window:** `{opens_at: <ts of most recent X chain entry the revoker had folded>, closes_at: <this revocation's own ts>, victim_chain_high_water_seq: <seq of that most recent X chain entry>}`. Load-bearing for fold rule 10's contest predicate — the `victim_chain_high_water_seq` field structurally defeats backdated-ts forgery attacks per R10-A-01 (seq checked independently of ts).
3. **Canonical-serialize + sign** record core `{type: "collaborator-distinctness-revocation", verified_id, person_id, seq, prev_hash, ts, content: {github_login, gh_api_collaborators_capture: [...login absent...], captured_at_ts, evidence_window}}`; append to log.

**Fold consequence — §4.5 owner-departure residual (journal/0120):** the revocation IS a self-produced gh-api fact and IS forgeable (the §1.1 general law). `fold-rule-10.js::foldRevocation` detects the forgery eventually: any honest clone observing ANY X-signed record at `seq`/`ts` NOT strictly prior to the evidence window CONTESTS the revocation, rejects it, reverts derived-N to count X (via `derive-n.js`'s R10-A-03 contested-exclusion), and emits a `block`-grade advisory naming `forging_signer: <revoker's verified_id>` (owner-accountability).

**Settlement (R10-A-01 + R10-S-01):** revocation is _settled_ only when (a) `LIVENESS_TTL`-bounded (20 min) X-quiescence elapses by the folding clone's **wall-clock now** (NOT X's self-stamped ts), AND (b) the clone has fetched X's peer-observed per-emitter chain high-water (rule-9d). Evaluated by `fold-rule-10.js::isSettled` at gate-time (C2).

**Recovery (shard A0b-2c — landed):** when a SETTLED revocation drops `derived-live-N` to 1, `.claude/hooks/lib/recovery-fallback.js::eligibleForRecoveryFallback(roster, foldedState, peerHighWaterFor)` returns `{eligible: true, eligible_remover, departed_logins}`; the sole remaining owner self-signs a REMOVAL-ONLY roster edit (purge departed `person_id`s + keys; NO owner-add — R8-S-01) validated by `validateRemovalOnlyEdit(oldRoster, newRoster, eligibleRemover, departedLogins)`. The R9-S-02 fence (`.claude/hooks/lib/r9s02-fence.js::gateEligibleForSelfSignedCheckpointOrRotation`) ALSO fires during this window: while derived-N=1 traces to a revocation (any attestation in log = owner-add history), `compaction-checkpoint` and `generation-rotation` are NOT degenerate-self-signable — they require the N=1→N=2 network-permitted owner-add ceremony (`--owner-add`) first. `host_role: ci` is NEVER an eligible remover (R5-S-04, enforced via `.claude/hooks/lib/eligibility.js`). C2's §6.4 gate matrix consumes all three predicates.

## Posture-bound restrictions

- `/whoami --register` writes the working tree + opens a PR — gated by the L2/L3 trust posture per `rules/trust-posture.md` (PR creation requires the appropriate write authority).
- A0b-2c will add: `--register` of a `host_role: ci` person_id is permitted, but the resulting person_id is `block`-gated out of every distinctness/quorum/gate-approval surface in shard C2's gate matrix.

## Implementation notes

Reference material (key-fingerprint extraction commands, branch-naming examples, GPG vs SSH detection heuristics) lives in `.claude/skills/30-claude-code-patterns/` rather than inline here, per `cc-artifacts.md` Rule 3 (commands ≤150 lines; reference material → skills). The schema validator is `.claude/hooks/lib/roster-schema-validate.js`; the schema is `.claude/operators.roster.schema.json`; the live roster is `.claude/operators.roster.json`. See `.claude/operators.roster.README.md` for placeholder semantics. Operational ceremony gotchas — enroll-before-commit ordering, the state-file-guard ceremony-script-by-path constraint, and the admin-merge / push fallbacks — live in `.claude/skills/43-ecosystem-init/SKILL.md` § Operational runbook (the DISTRIBUTED skill consumers receive; the genesis-ceremony's load-bearing operational ordering is self-sufficient there, NOT in the loom-internal `guides/co-setup/11-genesis-ceremony.md`, which consumers do not get). The three ceremonies above also support Azure DevOps (`roster.genesis.provider: "azure-devops"`): operators bind via `principal` (Entra UPN) instead of `github_login`, capture goes through the `adoApi` transport, and the verified-identity anchor is the ADO Graph Project-Collection-Administrators attestation (ADO has no commit-signature API) — the consumer-relevant ADO essentials are in skill 43 § Operational runbook; the full ADO deep runbook + residuals is loom-internal platform-engineer material in `guides/co-setup/11-genesis-ceremony.md` § Azure DevOps provider.
