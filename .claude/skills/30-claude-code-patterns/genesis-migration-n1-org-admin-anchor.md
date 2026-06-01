# `genesis-migration` Under Single-Owner N=1 — Org-Admin Anchor Discipline

Procedural depth for the `multi-operator-coordination.md` MUST-7 clause "`genesis-migration` Under Single-Owner N=1 — Org-Admin Anchor (Org-Owned) Or Block (User-Owned); No Degenerate Self-Sign". The core structural assertion (under N=1 `genesis-migration` is BLOCKED outright EXCEPT the org-owned gh-api-bound org-admin-anchor path, user-owned blocks, no degenerate self-sign in any form) lives in the rule. This sub-file carries the enumerated record-shape sub-clauses (a)-(f), the fold-time verification contract (i)-(iii), the GitHub-instance-scope threat-model assumption, the canonical-shape DO / DO-NOT examples, the BLOCKED-rationalization corpus, the relationship to MUST-4's colluding-distinct-owner residual, the re-anchor sub-case, and the gate-review mechanical sweep query.

## Why this lives in a skill (not the rule)

The MUST-7 structural assertion is load-bearing baseline content — it MUST stay in the rule so every session loads it. The enumerated sub-clauses, fold-time verification steps, threat-model assumption, DO/DO-NOT JSON examples, BLOCKED corpus, and mechanical sweep query are the _implementer's reference contract_: needed when authoring or auditing the `genesis-ceremony.js::performMigration` helper, the `fold-rule-9c.js` amendment, or a `genesis-migration` record — NOT on every session start. Per `cc-artifacts.md` MUST NOT "No knowledge dumps … extract reference to skills" and the established `worktree-orchestration.md` / `closure-parity-specialist-discipline.md` precedent (F20, journal/0143), depth goes here; the load-bearing tripwire stays in the rule. Origin: F87 (forest registry in `multi-operator-coordination.md` § Origin; F60 R2 security-reviewer LOW-R2-1 prose-density advisory, journal/0168 → journal/0174). Extraction recovers the codex/gemini proximity-band headroom MUST-7's ~110-line density consumed.

## Enforcement state (F86 — LIVE 2026-05-29)

`fold-rule-9c.js` dispatches on `content.co_sign_anchor_kind === "gh_api_org_membership_capture"` (per the `CO_SIGN_ANCHOR_KIND_ORG_ADMIN` export at `fold-rule-9c.js:63`) and routes canonical N=1 records through the org-admin verification branch (lines 240-481); malformed variants (discriminator + populated co_signers, user-owned kind under discriminator, stale capture, mismatched login, non-admin role, suspended state) are rejected with the corresponding MUST-7 sub-clause citation. The 2-of-N path under `else` (`fold-rule-9c.js:483-519`) is unchanged. The paired-landing hook `fold-amendment-paired-with-helper.js` enforces SAME-COMMIT discipline structurally (PostToolUse Bash on `git commit`; flags F86-touch on either side without the sibling). Closure receipts: commits `6bbeb44` + `758ad13`; F86 forest entry CLOSED. The mechanical sweep query below remains a defensive gate-review cross-check for malformed records that bypass the helper.

## The two N=1 paths

When a roster has exactly ONE rostered `person_id` carrying `role: owner` (the structural N=1 case) — including the re-anchor case where an existing `genesis.root_commit` pointer is being corrected to track the actual repo root — the MUST-4 2-of-N path is structurally unavailable. Under N=1, `genesis-migration` is BLOCKED outright EXCEPT under the org-owned structural-equivalent path below.

### Org-owned + N=1 path (LIVE post-F86) — record-shape sub-clauses (a)-(f)

The migration record MUST carry:

- **(a)** the sole owner's signature at the record-level `verified_id`;
- **(b)** `content.co_signers: []` (the canonical fold-rule-9c array name, empty under N=1 + org-admin substitution);
- **(c)** a fresh `gh_api_org_membership_capture` field (canonical capture shape already in use by `genesis-ceremony.js` + `gh-api-allowlist.js::_allowlistOrgMembership`) signed at migration-ceremony time AND showing `role: admin` + `state: active` for the sole owner's bound GitHub-collaborator-login (`user.login` field) under the org (`organization.login` field);
- **(d)** the same fresh `gh_api_owner_capture` external-owner result + monotonic `genesis_generation` increment MUST-4 already requires;
- **(e)** `content.co_sign_anchor_kind: "gh_api_org_membership_capture"` — an EXPLICIT discriminator naming the structural-equivalent anchor, so fold rule 9c can dispatch on the discriminator instead of inferring relaxation by absence-of-co-signers;
- **(f)** the migration record's `sig` envelope MUST cover the entire `content` block including `co_signers`, `co_sign_anchor_kind`, `gh_api_org_membership_capture`, and `gh_api_owner_capture` canonical bytes (per `knowledge-convergence.md` MUST-6 "signed over canonical bytes with `sig` absent").

The bound GitHub-collaborator-login MUST resolve at migration time to a verified-active org admin DISTINCT from any other rostered `person_id`'s bound login (vacuously true under N=1, but the check is mandatory so the predicate doesn't silently relax if the roster grows mid-ceremony).

**Fold-time verification (i)-(iii)** — per fold-rule-9c (F86 amendment), the folding clone MUST: **(i)** re-canonicalize the record minus `sig` and re-verify the signature; **(ii)** re-invoke `_isCaptureFresh(gh_api_org_membership_capture.capture_ts, record.ts, {freshnessMs: MIGRATION_LIVENESS_TTL})` against `MIGRATION_LIVENESS_TTL = 15 * 60 * 1000` (15 minutes — distinct from the 5-minute routine-enrollment `GH_API_CAPTURE_FRESHNESS_MS` because migration ceremony is multi-step and may stall across worker boundaries); **(iii)** reject if either check fails.

### User-owned + N=1 path (blocked)

Under a `repo_owner_kind: "user"` roster, NO structural-equivalent anchor exists. `genesis-migration` MUST refuse with the typed error `genesis-migration: user-owned N=1 has no structural co-sign anchor; add a second owner via /whoami --register before migrating`. The only safe disposition is to enroll a second rostered `person_id` (raising N to 2) BEFORE attempting migration. Degenerate self-sign is BLOCKED in EVERY form: (i) same `person_id` with a second `verified_id` (cryptographically-distinct keys, same human); (ii) same `person_id` with two bound GitHub-collaborator-logins (the human happens to control two GitHub accounts both legitimately enrolled as keys under one `person_id`); (iii) enrolling a sock-puppet second `person_id` mid-ceremony via a separately-controlled second GitHub-collaborator-login (this raises N from 1 to 2 and would otherwise route through MUST-4's 2-of-N path, but MUST-3's bound-GitHub-collaborator-login distinctness check is the gate — if both `person_id`s map to one human via shared real-world identity, MUST-4 already accepts this as the §4.5 colluding-distinct-owner bounded-trust residual; MUST-7 does NOT add new defense beyond MUST-4 for this variant, AND escalating N from 1 to 2 specifically to route around MUST-7 IS the sock-puppet failure mode the BLOCKED corpus below names).

The org-owned relaxation is the migration-ceremony counterpart to the `multi-operator-coordination.md` §6 `genesis-anchor` enrollment relaxation for `repo_owner_kind: "org"` + unverified root commit. Both rely on the same structural anchor — gh-api-bound verified-active org-admin attestation captured at ceremony time, canonical capture shape `gh_api_org_membership_capture` — and both preserve the bounded-trust threat model by binding authority to a GitHub-server-side immutable fact (admin membership at the ceremony's wall-clock instant) the operator cannot forge offline.

## Threat-model assumption (GitHub-instance scope)

The structural-equivalence claim assumes (i) the GitHub instance's admin-role mutation API is restricted to OTHER current admins (true on GitHub.com where role changes require an existing admin's action), AND (ii) admin role at ceremony wall-clock instant is not under the migrating operator's control via channels other than the gh-api surface. On self-hosted GitHub Enterprise Server (GHES) with privileged appliance access, a single operator with shell access to the appliance can mutate admin role via `ghe-config` / `ghe-set-password` / direct DB manipulation — the gh-api capture at ceremony time returns `role: admin, state: active` structurally identical to the legitimate case, with no external check to disambiguate. Deployments running GHES with shared-appliance-admin posture MUST treat MUST-7's org-owned relaxation as carrying an additional bounded-trust residual (the operator's appliance-admin role as an out-of-band mutation channel); the conservative disposition for GHES is to refuse the org-owned-N=1 path AS IF user-owned and require enrolling a second `person_id` first. F86 implementation MAY surface a `host: "ghes-shared-appliance"` config flag forcing the user-owned-style refusal; the assumption is named explicitly so deployments can make the trade-off consciously.

## Canonical-shape examples

```text
# DO — org-owned + N=1: migration record carries canonical-shape capture + explicit anchor discriminator
{
  "type": "genesis-migration",
  "verified_id": "548F..",                            # sole owner's record-level signature key
  "ts": "2026-05-28T13:00:00Z",
  "content": {
    "co_signers": [],                                 # canonical fold-rule-9c field name, empty under N=1
    "co_sign_anchor_kind": "gh_api_org_membership_capture",  # explicit discriminator F86 fold dispatches on
    "gh_api_org_membership_capture": {
      "role": "admin",
      "state": "active",
      "user": { "login": "<owner-login>" },
      "organization": { "login": "<org-login>" },
      "capture_ts": "2026-05-28T13:00:00Z"            # _isCaptureFresh predicate field
    },
    "gh_api_owner_capture": {
      "owner_login": "<org-login>",
      "owner_kind": "org",
      "capture_ts": "2026-05-28T13:00:00Z"
    },
    "genesis_generation": 1
  },
  "sig": "<detached-sig-over-canonical(content) excluding this sig field>"
}

# DO NOT — degenerate-self-sign variant (a): same person_id + second verified_id
{
  "type": "genesis-migration",
  "content": {
    "co_signers": [
      { "verified_id": "ABCD..", "person_id": "pid-esperie-.." }  # ← same person_id; BLOCKED at fold by R6-S-04
    ]
  }
}

# DO NOT — degenerate-self-sign variant (b): same person_id + two bound github-logins
# (both legitimately enrolled as keys under one person_id — distinct github_login is NOT sufficient under N=1)
{
  "type": "genesis-migration",
  "content": {
    "co_signers": [
      { "verified_id": "ABCD..", "person_id": "pid-esperie-..", "github_login": "esperie-secondary" }  # ← same person_id; BLOCKED
    ]
  }
}

# DO NOT — sock-puppet variant (c): enroll second person_id mid-ceremony to escape MUST-7
# (this routes around MUST-7 by raising N from 1 to 2; MUST-3 + MUST-4 then accept it as §4.5 bounded-trust
#  residual IFF the two person_ids map to distinct humans, but MUST-7 names this rationalization explicitly
#  as the escape vector the corpus below blocks)
{
  "type": "roster-edit-then-genesis-migration",       # enroll-then-migrate burst pattern
  "intent": "escape-MUST-7-via-sock-puppet"
}

# DO NOT — user-owned + N=1: substituting org-membership anchor when no org exists
{
  "type": "genesis-migration",
  "content": {
    "co_sign_anchor_kind": "gh_api_org_membership_capture",  # ← user-owned has no org; BLOCKED
    "repo_owner_kind": "user"
  }
}
```

## BLOCKED rationalizations

- "MUST-4 says 2-of-N; relax it to 1-of-1 for solo founders"
- "The sole owner is provably trustworthy; degenerate self-sign is fine for them"
- "A second `verified_id` under the same `person_id` is cryptographically distinct, that's enough"
- "Two distinct GitHub-collaborator-logins under one `person_id` satisfy MUST-3's distinctness check, so they satisfy MUST-7"
- "If MUST-7 blocks, enroll a second `person_id` first and route through MUST-4 instead"
- "Org-admin attestation is overkill; the owner has commit-signing keys, that's the trust root"
- "User-owned repos should follow the same path as org-owned (just substitute owner-attestation)"
- "Re-anchoring an existing root_commit isn't really a migration"
- "The re-anchor is a one-time correction; the rule fires only on future migrations"
- "If gh api is unavailable at migration time, fall back to local-only attestation"
- "The org-admin capture is cacheable across migrations; one capture covers N"
- "The gh api call failed transiently — fall back to local-only attestation"
- "Admin status is enforced by branch protection at PR-merge — ceremony-time check is redundant"
- "For self-hosted GitHub Enterprise the admin role is operator-controlled — relax the check there"
- "Fold-time freshness re-check is redundant when ceremony-time was already fresh"
- "Signature canonical bytes excluding the capture is fine — `_allowlistOrgMembership` re-validates"

**Why:** Under N=1 the 2-of-N quorum reduces to "one human signs both halves" — structurally indistinguishable from a single owner forging the trust root. MUST-4's `Why:` calls this out: _"A degenerate self-signed migration is structurally indistinguishable from a single owner forging the trust root — the colluding-distinct-owner residual is accepted only because this gate forces the forgery into a 2-of-N quorum of distinct humans."_ Under N=1 there is no second distinct human; the gh-api-bound org-admin attestation is the only structural-equivalent anchor — captured at migration-ceremony wall-clock time, RE-verified at fold time against `MIGRATION_LIVENESS_TTL`, signed into the canonical content envelope so the anchor cannot be appended-after-sign, and tied to a GitHub-server-side admin role the operator cannot forge offline. User-owned repos lack this anchor entirely; the only safe path is enroll a second owner first. Caching the org-admin capture across migrations is BLOCKED for the same reason MUST-4 mandates a FRESH external check — a cached capture defeats the wall-clock binding. Fold-time re-verification of capture freshness is mandatory (not redundant): without it, a migration record signed in 2026 with a stale ceremony-time-fresh capture could be replayed at fold time months later when the operator has been demoted from admin role.

## Relationship to MUST-4's colluding-distinct-owner residual

(Architecture §4.5, inlined per the rule's "downstream consumers act on the prose here" contract.) MUST-4 accepts the colluding-distinct-owner residual under N≥2 because two distinct humans colluding is the failure mode the substrate explicitly defers to bounded-trust. Under N=1 the same residual disappears (no second human exists to collude) but is REPLACED by single-owner-forges-both-halves — a worse failure mode because no second party exists to observe the collusion. MUST-7 closes that worse failure mode by requiring an EXTERNAL anchor (gh api) for the org-owned path AND refusing entirely for the user-owned path. MUST-7's sock-puppet BLOCKED rationalization closes the obvious bypass — escalating N=1 to N=2 via a second `person_id` the same human controls — by naming the pattern as explicit institutional theatre rather than letting it route through MUST-4 unchallenged.

## Re-anchor sub-case

When an existing `genesis.root_commit` pointer is being corrected (e.g., the roster carries SHA `398076d...` but the actual repo root per `git rev-list --max-parents=0 HEAD` is `d98da8b...` — typically the artifact of a prior `git filter-repo` / `git rebase --root` rewrite), the correction MUST be performed AS a `genesis-migration` ceremony with `genesis_generation` increment (NOT a silent roster JSON edit, which `permissions.deny` blocks at the pre-tool-use boundary anyway). Re-anchor is migration's strictest sub-case:

- **(i)** the new `root_commit` MUST verify via `gh api repos/{owner}/{repo}/commits/{root_commit}` at ceremony time;
- **(ii)** MUST match `git rev-list --max-parents=0 HEAD` locally;
- **(iii)** F86 helper SHOULD additionally fetch + verify `git rev-list --max-parents=0 origin/<default-branch>` against the new `root_commit` so a mid-ceremony local `git filter-repo` cannot diverge local-vs-remote root (residual: an operator running `git filter-repo` between Step 3 capture and Step 4 helper invocation could produce a local checkout matching their chosen SHA while remote root diverges — caught at next `git push --force` to main but not at ceremony time);
- **(iv)** the migration record's `content.gh_api_root_commit_capture` MUST surface BOTH SHAs via a `content.pre_correction_root_commit` field (top-level on `content`, signed into canonical bytes, distinct from the capture shape which only carries the new post-correction SHA) so fold rule 9c (`foldGenesisMigration`'s R6-S-06 latest-wins supersession) re-points the trust root to the corrected root with full audit-trail of what was corrected.

**(F88 correction — 2026-05-29):** re-anchor root supersession is implemented in fold rule **9c** (`fold-rule-9c.js::foldGenesisMigration` re-points `trustRoot.pinnedFacts.root_commit` to `gh_api_root_commit_capture.sha` — gated by a hex-shape check + fold-time `_isCaptureFresh` freshness re-check against `MIGRATION_LIVENESS_TTL`), NOT fold rule 9a. Rule 9a (`fold-genesis-anchor.js`) hard-rejects any `record.type !== "genesis-anchor"`, so a `genesis-migration` record never reaches it; 9a is first-wins, 9c is latest-wins (semantically opposite). The "9a / first-wins" attribution in the F86 forest-entry criteria (4)+(5) was a `journal/0171` § For-Discussion #2 misread (it resolved only the dispatch question, never the supersession-mechanism prose). See the F88 forest entry in `multi-operator-coordination.md` § Origin + `journal/0173` for the verbatim correction; the closed F86 entry's criteria (4)+(5) are preserved as historical intent and are SUPERSEDED by the F88 entry on this attribution.

## Mechanical sweep query (gate-review)

Reviewer / security-reviewer MUST run the following query at `/codify` and at any commit touching `.claude/learning/coordination-log.jsonl`, and flag any match as a MUST-7 concern requiring investigation before merge:

```bash
jq 'select(.type == "genesis-migration") |
    select((.content.co_signers == null or (.content.co_signers | length) == 0) and
           (.content.co_sign_anchor_kind != "gh_api_org_membership_capture"
            or .content.gh_api_org_membership_capture == null))' \
   .claude/learning/coordination-log.jsonl
```

A non-empty result means a `genesis-migration` record has been proposed under N=1 without the structural-equivalent anchor MUST-7 specifies. Post-F86 (LIVE 2026-05-29) disposition is "investigate as a malformed-record incident — the canonical helper at `genesis-ceremony.js::performMigration` emits the required discriminator + captures by construction, so a record matching this query implies either (a) a hand-crafted record that bypassed the helper, OR (b) a roster mid-edit window where N briefly fell to 1 with the discriminator present but other invariants stale; investigate before merge". The fold predicate rejects every malformed variant at fold time; this sweep is a defensive cross-check at gate-review for records that have not yet been folded.
