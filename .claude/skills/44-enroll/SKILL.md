---
name: 44-enroll
description: /enroll procedure — register an operator into an existing ecosystem via /whoami --register (roster, PR-gated) + seed per-operator gitignored local-links, then hand off to /onboard.
---

# /enroll — Operator Enrollment Procedure

The procedure backing `.claude/commands/enroll.md` (the once-per-operator ceremony for joining an
ecosystem already configured by `/ecosystem-init`). The command body holds the three load-bearing
invariants; this skill holds the step-by-step procedure and the exact tool-call shapes.

Three onboarding surfaces (`02-plans/02-ga-ecosystem-onboarding.md`): `/onboard` (read, every session),
`/enroll` (operator, once), `/ecosystem-init` (fork, once). They share ZERO write-authority.

## Ceremony steps: B1 → B2 → B3

### B1 — roster registration (wraps `/whoami --register`)

Invoke the EXISTING `/whoami --register` path (`.claude/commands/whoami.md`). It is the ONLY roster-write
path (`multi-operator-coordination.md` §1); `/enroll` does NOT re-implement it. The `/whoami --register`
flow:

1. **Collect inputs**: `display_id` (advisory handle), `github_login` (or `principal` Entra UPN on an ADO
   ecosystem), `host_role` (`human` | `ci`), signing-key `{type: ssh|gpg, fingerprint, pubkey}`.
2. **Derive `person_id`** = `pid-<display_id>-<short-fingerprint>` (first 8 chars of sha256 of the pubkey
   body); immutable.
3. **Cut a feature branch** off `main`: `git checkout -b "codify/${display_id}-$(date -u +%Y-%m-%d)" origin/main`
   — NEVER write `operators.roster.json` directly to `main` (branch protection rejects it).
4. **Schema-validate** the in-memory roster edit via `.claude/hooks/lib/roster-schema-validate.js`; a
   `valid: false` is a hard stop.
5. **Commit + push + open PR** — the PR enters the branch-protection + review chain. Merge is NEVER a
   direct push and NEVER an owner-self-attesting admin-merge (the §6.4 gate matrix's job).

New operators default to `role: contributor`. Promotion to `senior`/`owner` is a SEPARATE quorum gate
(`--owner-add` for owners, a 2-of-N roster edit for senior) — NOT part of `/enroll`.

**Business-role caveat (Q1).** The four business roles are the advisory `business_roles` enum at
`operators.roster.schema.json:94-105` (`platform-engineer` / `capability-engineer` / `business-consultant`),
ORTHOGONAL to the authority `role` and NEVER quorum-eligible (`multi-operator-coordination.md` §1).
`/enroll` places the operator into an AUTHORITY role; `business_roles` is an additive field the operator
or an owner may set later — it never touches the `display_id`/`verified_id`/`person_id` authority triple.
`product-owner` is NOT a roster value (the brief author sits outside the delivery substrate).

### B2 — local-links registration (per-operator, gitignored — invariant 2)

Write the operator's NAME→on-disk-path bindings to `loom-links.local.json`:

1. Copy the committed example `.claude/bin/loom-links.local.example.json` (it carries the canonical
   sublayout as synthetic tokens — `example/build/py`, `example/use/py`, peers `loom`/`atelier`).
2. Edit each binding to the operator's ACTUAL on-disk layout. The canonical sublayout hint
   (`cross-repo.md` § "Canonical Sublayout (Recommended — F61)") is `~/repos/kailash/{build,use}/<slug>`
   with `~/repos/{loom,atelier}` as peers — but the resolver is layout-agnostic, so any layout works as
   long as it is declared.
3. NO disclosure gate — the file is gitignored and per-machine; it never syncs and never reaches a
   committed/public surface (contrast the ecosystem-SHARED `remote_links` in `/ecosystem-init` C1, which
   IS disclosure-fenced). Precedence: `$LOOM_LINKS_CONFIG` > `loom-links.local.json` > fail-loud
   (`loom-links.mjs`).

Pre-existing operators on any other layout (flat `~/repos/<slug>`, nested) proceed unchanged.

### B3 — hand off (invariant 3)

Print: "Enrolled. Run `/onboard` at the start of every session." `/enroll` does NOT perform the
session-entry reads (roster + posture + team-memory + claims) — that is `/onboard`'s read-only job
(`knowledge-convergence.md` MUST-5).

## Why a separate command (not a `/whoami` flag)

`/enroll` is intentionally thin (B1 delegates to `/whoami --register`, B2 is a local-file seed) but is a
SEPARATE command because the three named surfaces (`/onboard`/`/enroll`/`/ecosystem-init`) are the
`02-ga` core distinction — each names a distinct lifecycle moment, and folding `/enroll` into a
`/whoami --register --with-links` flag would lose the operator-facing surface name. The `02-ga` Q5
fold-vs-keep deliberation was adjudicated KEEP-SEPARATE at W8a redteam.

## Distinction from the other two surfaces

| If the operator…                             | Run               |
| -------------------------------------------- | ----------------- |
| is setting up a NEW fork (no ecosystem yet)  | `/ecosystem-init` |
| is JOINING an existing, configured ecosystem | `/enroll`         |
| is starting any session in a repo they're in | `/onboard`        |
