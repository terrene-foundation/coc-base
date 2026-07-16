---
id: "S45-GENESIS-BOOTSTRAP"
name: 45-genesis-bootstrap
description: MANDATORY for fresh-repo first-owner genesis bootstrap (no roster yet). Signing-first, codify-branch roster write, script-by-path ceremony, fold-clean verify, org-admin relaxation.
---

# /genesis-bootstrap — Fresh-Repo First-Owner Genesis Bootstrap Runbook

The operational runbook for establishing the multi-operator trust root in a repo that has
the substrate installed but is **NOT yet enrolled** — no `operators.roster.json` with a
genesis owner, no folded `genesis-anchor`. This is the step that PRECEDES `/enroll` and
`/ecosystem-init`'s genesis step on a truly fresh BUILD/USE repo.

**The gap this fills.** The authoritative end-to-end runbook
(`guides/co-setup/11-genesis-ceremony.md`) lives at **loom and cascades to BUILD repos, but is
deliberately excluded from USE templates** (`use_exclude` / `use_obsoleted`). The shipped commands
(`/whoami --enroll-genesis`, `/ecosystem-init`, `/enroll`) and the sibling skills (`41-onboard`,
`43-ecosystem-init`, `44-enroll`) reference that guide for the operational depth. This skill
reconstructs that depth IN the repo — the reconstruction USE consumers rely on in place of the
excluded guide — plus the five hard-won guard traps that block a naive first run.

## Where bootstrap sits among the onboarding surfaces

Reference the sibling skills — do NOT re-run their procedures here:

| Surface           | Moment                                       | Skill               |
| ----------------- | -------------------------------------------- | ------------------- |
| genesis bootstrap | a fresh repo's FIRST owner (NO roster yet)   | **this skill**      |
| `/ecosystem-init` | a fork's first ecosystem-config + trust-root | `43-ecosystem-init` |
| `/enroll`         | a human JOINING an enrolled ecosystem        | `44-enroll`         |
| `/onboard`        | every session entry (read-only)              | `41-onboard`        |

Bootstrap is the ONE case where there is no roster to register into. Once the genesis owner is
anchored, every TEAMMATE self-enrolls from their OWN machine via `/enroll` (never bootstrapped
for them) and starts each session with `/onboard`.

## Pre-flight — five gates, in this order (order is load-bearing)

1. **Signing key FIRST.** Configure commit-signing BEFORE any tracked-file write. **Coordination-opt-in
   caveat (W1, 2026-06-25):** on a genuinely fresh bootstrap repo coordination resolves OFF, so
   `signing-mutation-guard.js` **passes through** (it early-returns when `!isCoordinationEnabled`) —
   the degraded-read-only trap does NOT fire during this first run. Here the signing-key-first
   discipline is enforced instead by (a) the **unconditional** `validate-bash-command.js`
   `STATE_PATH_RX` block on Bash state-file mutation, and (b) fold-clean verification — an **unsigned**
   genesis-anchor never folds into a trust root, so enrollment cannot COMPLETE without the key.
   (`genesis-anchor-guard.js` itself advisory-passes-through on the genuinely-fresh state per F72 so
   the first commits can land; its fail-closed block engages only after a real non-scaffold roster
   exists without a folded anchor.) Once the owner enrolls and
   coordination turns ON, `signing-mutation-guard.js` puts the session in **degraded read-only** mode
   (a `git status --porcelain` before/after working-tree-mutation delta on tracked paths, NOT a
   tool-name allowlist) so no later file-mutation path escapes it. Configure repo-local:
   ```bash
   git config --local gpg.format ssh
   git config --local user.signingkey "$HOME/.ssh/id_ed25519.pub"
   git config --local commit.gpgsign true
   ```
   (`COC_OPERATOR_KEY_PATH=""` or `COC_SIGNING_MUTATION_GUARD_FORCE_DEGRADED=1` force degraded —
   never set these during a ceremony.)
2. **On a codify branch.** `integrity-guard.js` permits writes to watched paths
   (`operators.roster.json`, `operators.roster.schema.json`, `coordination-log.jsonl`,
   `posture.json`, `violations.jsonl`, `observations.jsonl`, `team-memory/**`, `journal/**`)
   ONLY on a branch matching `^codify/<display_id>-YYYY-MM-DD$` (the date-terminal predicate at
   `.claude/hooks/integrity-guard.js`; suffixed names like `…-b` are rejected). Cut it from
   `main` (branch protection rejects a direct roster push to `main`):
   ```bash
   git checkout -b "codify/<display_id>-$(date -u +%Y-%m-%d)" main
   ```
3. **Ceremony steps run script-by-path, never `node -e` / `python -c`.** See § The
   script-by-path pattern below — this is the trap that most often blocks a first run.
4. **gh CLI reachable + authenticated.** The ceremony makes live `gh api` calls
   (`repos/{owner}/{repo}`, `commits/{root_commit}`, and for org repos
   `orgs/{org}/memberships/{login}`); it is fail-CLOSED — any failed verification refuses to
   emit the anchor.
5. **Verify the fold is clean before declaring "enrolled."** A signed-and-appended anchor that
   does not FOLD clean is not a trust root. See § Verify below.

## The bootstrap sequence

1. **Hand-author the bootstrap roster** on the codify branch. The `/whoami --register` path
   assumes an EXISTING roster; on a fresh repo the first roster is authored by hand. The genesis
   owner's entry MUST carry `role: owner`, the correct `github_login` (the verified external
   repo owner), and the signing key's `{type, fingerprint, pubkey}`. `person_id` is
   `pid-<display_id>-<short-fingerprint>` (first 8 chars of sha256 of the pubkey body),
   immutable, and is the roster MAP KEY — `resolveIdentity` matches by `keys[].fingerprint`, so
   the map key need only be consistent, not re-derived. Set `roster.genesis`:
   `{ provider, repo_owner, repo_owner_kind: "user"|"org", root_commit }`.
2. **Schema-validate** the roster BEFORE committing — `valid: false` is a hard stop:
   `.claude/hooks/lib/roster-schema-validate.js::validate(roster)` returns `{valid, errors[]}`.
3. **Configure signing** (pre-flight gate 1) if not already done.
4. **Run the ceremony** via `.claude/hooks/lib/genesis-ceremony.js::runEnrollmentCeremony(opts)`
   (signature at `genesis-ceremony.js`). `opts` keys:
   `{ roster, repo: {owner, name}, signingKeyPath, signingKeyFingerprint, ghApi,
transportAppend, keyType }`. `signingKeyPath` is the PRIVATE key; `ghApi` is a subprocess
   wrapper around `gh api`; `transportAppend` is the **`.transportAppend` FUNCTION destructured
   from** the composed enrollment-seed transport — the factory
   `.claude/hooks/lib/enrollment-seed-transport.js::createEnrollmentSeedTransport(
{ repoDir, remote, localAppend })` RETURNS `{ transportAppend, refName, refSource }`, so
   destructure and pass its `.transportAppend` (a function) as the ceremony opt:
   `const { transportAppend } = createEnrollmentSeedTransport({ repoDir, remote, localAppend });
runEnrollmentCeremony({ ..., transportAppend })`. Passing the factory-return OBJECT itself
   trips the ceremony's fail-CLOSED `transportAppend callable missing` guard. It seeds the signed record to the canonical FETCHABLE
   git ref FIRST (`transport-git-ref.js`, uncapped; the ref name resolves via
   `log-ref-name.js::resolveLogRefName`, network-permitted at enrollment), THEN to the local
   `.claude/learning/coordination-log.jsonl` cache (`localAppend`). Seeding the ref is what lets
   a FRESH CLONE fetch-then-fold its trust root instead of fail-CLOSED-blocking at its first
   commit (loom#879). A ref-append failure returns a typed error and does NOT write the local
   surface (no half-write). Returns `{ ok, error?, reason?, step? }`, fail-CLOSED. (The same path
   `/whoami --enroll-genesis` drives — see `commands/whoami.md`.)
5. **Verify** (next section).

The `genesis-anchor` lands on BOTH surfaces (via the composed enrollment-seed transport, step 4):
the canonical fetchable git ref `refs/coc/coordination-gen<N>` (durable, uncapped — the
recovery surface a fresh clone fetch-then-folds, loom#879) AND the local
`.claude/learning/coordination-log.jsonl` cache (gitignored, per-clone local state — NO commit,
NO PR for the local anchor itself). Appending it through a `node <file>`
script does NOT trip `genesis-anchor-guard.js` (that guard fires on Bash `git commit` /
`git push` and on edit-tool mutations of the roster, not on a plain `node` subprocess). The
ceremony writes its OWN signed enrollment marker (`COC_GENESIS_GUARD_ENROLLMENT_MARKER`) that
the guard verifies — an unsigned marker is not a bypass.

## org-owned vs user-owned (the #358 relaxation)

The verified-identity ANCHOR differs by `repo_owner_kind`:

- **user-owned** — the SIGNED ROOT COMMIT is the anchor:
  `gh api repos/{owner}/{repo}/commits/{root_commit}` → `verification.verified == true` AND the
  verified author == the declared owner.
- **org-owned** — many org repos have an UNVERIFIED root commit (authored by a contributor who
  did not sign). The issue-#358 relaxation substitutes a **verified active org-admin
  attestation**: `gh api orgs/{org}/memberships/{login}` → `role: "admin"` + `state: "active"`
  for the signing person. This is the structurally-equivalent anchor to a signed root commit.
  It applies ONLY to org-owned repos AND only when the signer is a verified active admin; it
  does NOT apply to user-owned repos.

The ceremony also requires the external owner to match: `gh api repos/{owner}/{repo}` →
`owner.login == roster.genesis.repo_owner`, and the roster to declare exactly ONE `owner`
person whose `github_login` resolves to that login, bound to the signing key's fingerprint.

## The script-by-path pattern (the central trap)

`validate-bash-command.js` runs `detectStateFileMutation(command, STATE_PATH_RX)` on every
Bash command — a three-layer detector (its docstring at `validate-bash-command.js`:
"redirects, file utilities, **interpreter -c/-e/-m bodies**") that BLOCKS (severity: block) any
command whose body MUTATES a watched state file. `STATE_PATH_RX` matches `posture.json`,
`violations.jsonl`, `coordination-log.jsonl`, `.initialized`, the heartbeat/session-end caches,
and `operators.roster.json`. So a `node -e '…fs.writeFileSync(".claude/operators.roster.json"…)'`
roster write is blocked — the state-file path is on the command line the detector scans. (This
is why the illustrative `node -e` in `commands/whoami.md` § `--register` is blocked in practice;
that command's "Implementation notes" name the "ceremony-script-by-path constraint.")

The fix is NOT to weaken the guard. Route every state-mutating ceremony step through a script:

```bash
# DO — author a script file, run it as a BARE `node <file>`.
#   The watched path lives in the script BODY, off the scanned command line.
#   (Write the script to a scratch path, then:)
node /path/to/ceremony-step.js

# DO NOT — inline interpreter body that writes a watched state file
node -e 'require("fs").writeFileSync(".claude/operators.roster.json", x)'   # BLOCKED
```

Keep `node <file>` a BARE command — bundling it with `gh …` or a heredoc in one compound
command can re-introduce a scanned mutation token. Read-only `node -e` (no watched-state path)
is NOT blocked; only state-file mutation is.

## Verify (before declaring "enrolled")

1. **Fold clean** — `.claude/hooks/lib/coordination-log.js::foldLog(records, roster, opts)`
   (public export) returns `{ foldState, accepted, rejected, forks, advisories,
contestedRevocations, derivedN }`. A healthy genesis: `accepted` includes the anchor,
   `rejected: []`, `forks: []`. Run it script-by-path (it reads the gitignored log).
2. **Identity resolves to owner** —
   `.claude/hooks/lib/operator-id.js::resolveIdentity(repoDir)` returns
   `{ verified_id, person_id, display_id, role, host_role, posture, blocked_into }`; confirm
   `role: "owner"` and a non-null `person_id`.
3. **allowed_signers** (optional, for local commit-signature verification): point
   `git config --local gpg.ssh.allowedSignersFile` at a file listing the roster's keys; generate
   it FROM the roster so it stays in sync.

## Troubleshooting matrix

| Symptom (what you see)                                   | Cause                                                          | Fix                                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Every tracked-file write silently refused                | degraded read-only — no signing key (`signing-mutation-guard`) | Configure `gpg.format ssh` + `user.signingkey` (pre-flight gate 1)                    |
| Bash `node -e`/redirect to a state file → severity:block | `validate-bash-command` `detectStateFileMutation`              | Route the mutation through a bare `node <file>` script (§ script-by-path)             |
| Roster/journal write blocked off the codify branch       | `integrity-guard` (watched path, wrong branch)                 | Be on `codify/<display_id>-YYYY-MM-DD` (date-terminal) cut from `main`                |
| Roster/journal write blocked ON the codify branch        | `integrity-guard` — branch matches but no covering lease       | Acquire the codify lease (`codify-lease.js::acquireCodifyLease`) bound to the branch  |
| Journal write halts "slot unreserved"                    | `journal-write-guard` — slot not reserved per log              | `journal-reserve.js::reserveJournalSlotSigned(repoDir, {dir, identity, type, topic})` |
| Ceremony refuses to emit anchor                          | fail-CLOSED gh-api verification failed                         | Check the returned `step`/`reason`; verify `repo_owner`, `root_commit`, org-admin     |
| `genesis-anchor-guard` blocks a `git commit`/`git push`  | no verifying cached signed owner-bound anchor yet              | Complete the ceremony (fold clean) before the first signed commit                     |

## Cross-references

- `commands/whoami.md` — the `/whoami --enroll-genesis` ceremony this skill operationalizes.
- `rules/enrollment-operations.md` — the MUST-clause discipline (signing-first, codify-branch,
  script-by-path, fold-clean, self-enroll, org-admin relaxation).
- `rules/multi-operator-coordination.md` §1/§6 + `rules/knowledge-convergence.md` — the trust
  substrate the anchor establishes.
- `agents/onboarding/coc-onboarding-specialist.md` — the operator-lifecycle expert that drives
  this runbook end-to-end.
