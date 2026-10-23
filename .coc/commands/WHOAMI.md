---
id: "WHOAMI"
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

**Gate (2026-10-09):** the MODEL-invoked `/whoami --owner-add` is intercepted by `.claude/hooks/operator-gate.js` as §6.4 row `roster-edit-add-contributor` — the SAME row `/whoami --register` uses — whose landed conditions are `signing_context: gate-approval`, `self_approvable: no`, `required_signers: one owner`. An invocation without a VERIFIED `gate_approval` signed by a DISTINCT owner is REFUSED. This closes a measured hole, not a policy change: before this wiring the promotion of a contributor to `owner` reached NO gate at all (the trigger recognised `--register` and the departure spellings only), so the most privileged roster edit on the surface was the least gated. No row and no condition is new — the hook line is the missing registration — and on a solo repo there is no second owner to sign, so the invocation refuses.

**The ceremony** (`.claude/hooks/lib/owner-add-ceremony.js::runAttestationCeremony`):

1. **`gh api repos/{owner}/{repo}/collaborators`** — the named login MUST appear in the capture.
2. **Canonical-serialize + sign** record core `{type: "collaborator-distinctness-attestation", verified_id, person_id, seq, prev_hash, ts, content: {github_login, gh_api_collaborators_capture: [...raw...], captured_at_ts}}` via `coc-sign.canonicalSerialize` + `coc-sign.sign` (default `keyType: ssh`).
3. **Append** the signed record to `.claude/learning/coordination-log.jsonl` via A2a transport.
4. **Fold consequence:** the attestation is input to `derive-n.js::computeDerivedN` — `R9-A-02` latest-by-`seq` per login. Subsequent verifying revocation suppresses; later verifying re-attestation re-admits.

**Honest scope (R7-S-02):** the attestation proves the login IS _a repo collaborator_, NOT human-distinctness — a sock-puppet satisfies it. Named inside the §4.5 distinct-owner-collusion residual.

### `/whoami --owner-depart <login>` — distinctness revocation (network-permitted, fail-CLOSED)

Mark an `owner` as departed by appending a signed `collaborator-distinctness-revocation` capturing FRESH `gh api repos/{owner}/{repo}/collaborators` showing the named login is **no longer** a collaborator (architecture §2.1).

**Pre-conditions:** target `github_login` corresponds to an `owner`-role person; `gh` is reachable. A revocation requires fresh gh-api absence proof; genuine offline departure requires `halt-and-report`. Revoker-supplied evidence is audit material, never authorization. Fresh capture and validation: `.claude/hooks/lib/owner-depart-ceremony.js:239-281`.

**The ceremony** (`.claude/hooks/lib/owner-depart-ceremony.js:189-335`, `runRevocationCeremony`):

1. **Fresh `gh api .../collaborators`** — login MUST NOT appear; still-present → fail-CLOSED.
2. **Record the R10-A-02 evidence window for audit:** `{opens_at, closes_at, victim_chain_high_water_seq}`. The contest window is derived from the clone-observed victim chain and revocation `ts`, not this supplied window. A future revocation timestamp is refused; activity at or after the revocation timestamp contests. The observed maximum from the same entry list supplies the numeric sequence bound, not independent backdating evidence (`.claude/hooks/lib/coordination-log.js:465-507`; `.claude/hooks/lib/fold-rule-10.js:117-134`).
3. **Canonical-serialize + sign** record core `{type: "collaborator-distinctness-revocation", verified_id, person_id, seq, prev_hash, ts, content: {github_login, gh_api_collaborators_capture: [...login absent...], captured_at_ts, evidence_window}}`; append to log.

**Fold consequence — §4.5 owner-departure residual (journal/0120):** a self-produced gh-api fact can be forged. Contradicting victim activity contests the revocation; the fold retains it in `accepted` with `rule10_contested: true` and separately reports the contest, enabling derived-N to retain the victim. Acceptance alone is never an uncontested verdict: settlement requires the preserved victim-bound explicit `rule10_contested === false`, not an absent flag (`.claude/hooks/lib/coordination-log.js:2695-2714`; `.claude/hooks/lib/derive-n.js:184-203`; `.claude/hooks/operator-gate.js:579-632,864-873`).

**Settlement (R10-A-01 + R10-S-01):** `_revocationSettlement` compares each provider-bound victim fingerprint's locally folded sequence with that SAME fingerprint's peer sequence through `transport-git-ref.js::peerObservedHighWaterSync`; a different key's larger sequence cannot cover a lagging chain. Every peer-held chain requires a present local high-water; missing, malformed, unknown or failed peer observations refuse settlement. Confirmed absent chains may be skipped, but no peer-held chains means unknown. All key comparisons share the victim's GLOBAL latest activity and one clone wall-clock `now` for the 20-minute `LIVENESS_TTL`; no key-local TTL reset (`.claude/hooks/operator-gate.js:639-692,697-772`; `.claude/hooks/lib/fold-rule-10.js:239-324`; `.claude/hooks/lib/transport-git-ref.js:571-597`). **Signed-peer precondition:** derive the canonical peer identity from the effective VERIFIED fold trust-root witness's signed ceremony capture, NEVER from mutable `origin`. Missing, ambiguous or mismatched signed identity/configured peer binding refuses settlement; URL rewrites, include/TLS routing overrides and HTTP redirects cannot redirect the bound read. Generation discovery and strict per-fingerprint fetching use that signed endpoint (`.claude/hooks/lib/signed-peer-binding.js:7-56,58-72`; `.claude/hooks/lib/transport-git-ref.js:347-388`; `.claude/hooks/lib/log-ref-name.js:183-186`; `.claude/hooks/operator-gate.js:639-658,870-873`).

**Recovery — fail-CLOSED HOLD:** self-approved owner-departure roster recovery is **DISABLED**. A removal-only edit requires a DISTINCT owner-eligible **SIGNED** co-signer; requester/approver checks and signature verification still apply. Settlement is additional evidence, NEVER authorization to self-approve. The row also requires settled, victim-bound explicit-FALSE revocation evidence and the requester to be the sole remaining live owner; no owner-add is authorized by this row (`.claude/hooks/lib/gate-matrix.js:328-415`; `.claude/hooks/operator-gate.js:1412-1456,864-909`).

**Production wiring:** `_revocationSettlement` is reached only after preserved victim-bound explicit `rule10_contested === false` corroboration and latest-owner validation. `_peerHighWaterReader` queries the actual `peerObservedHighWaterSync` for every victim fingerprint; neither injected helper results nor caller-supplied settlement claims replace these facts or the signed co-signer requirement (`.claude/hooks/operator-gate.js:579-632,639-692,697-772,864-909,1412-1456`). This gate row does NOT invoke `recovery-fallback.js::eligibleForRecoveryFallback` or `validateRemovalOnlyEdit`; actual roster-delta removal-only validation belongs to the editing ceremony, rather than this authorization row (`.claude/hooks/lib/gate-matrix.js:328-415`; `.claude/hooks/lib/recovery-fallback.js:256-264,460-505`).

The R9-S-02 fence (`.claude/hooks/lib/r9s02-fence.js::gateEligibleForSelfSignedCheckpointOrRotation`) DOES fire within the same window: while derived-N=1 traces to a revocation (any attestation in log = owner-add history), `compaction-checkpoint` and `generation-rotation` are NOT degenerate-self-signable — they require the N=1→N=2 network-permitted owner-add ceremony (`--owner-add`) first. `host_role: ci` is NEVER an eligible remover (R5-S-04, enforced via `.claude/hooks/lib/eligibility.js`).

## Posture-bound restrictions

- `/whoami --register` writes the working tree + opens a PR — gated by the L2/L3 trust posture per `rules/trust-posture.md` (PR creation requires the appropriate write authority).
- A0b-2c will add: `--register` of a `host_role: ci` person_id is permitted, but the resulting person_id is `block`-gated out of every distinctness/quorum/gate-approval surface in shard C2's gate matrix.

## Implementation notes

Reference material (key-fingerprint extraction commands, branch-naming examples, GPG vs SSH detection heuristics) lives in `.claude/skills/30-claude-code-patterns/` rather than inline here, per `cc-artifacts.md` Rule 3 (commands ≤150 lines; reference material → skills). The schema validator is `.claude/hooks/lib/roster-schema-validate.js`; the schema is `.claude/operators.roster.schema.json`; the live roster is `.claude/operators.roster.json`. See `.claude/operators.roster.README.md` for placeholder semantics. Operational ceremony gotchas — enroll-before-commit ordering, the state-file-guard ceremony-script-by-path constraint, and the admin-merge / push fallbacks — live in `.claude/skills/43-ecosystem-init/SKILL.md` § Operational runbook (the DISTRIBUTED skill consumers receive; the genesis-ceremony's load-bearing operational ordering is self-sufficient there, NOT in the loom-internal `guides/co-setup/11-genesis-ceremony.md`, which consumers do not get). The three ceremonies above also support Azure DevOps (`roster.genesis.provider: "azure-devops"`): operators bind via `principal` (Entra UPN) instead of `github_login`, capture goes through the `adoApi` transport, and the verified-identity anchor is the ADO Graph Project-Collection-Administrators attestation (ADO has no commit-signature API) — the consumer-relevant ADO essentials are in skill 43 § Operational runbook; the full ADO deep runbook + residuals is loom-internal platform-engineer material in `guides/co-setup/11-genesis-ceremony.md` § Azure DevOps provider.
