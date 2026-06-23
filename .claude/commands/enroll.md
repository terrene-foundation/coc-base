---
description: Enroll an operator into an existing ecosystem (once per operator) — roster registration via /whoami --register + per-operator local-links. Writes roster (PR) + gitignored links.
---

# /enroll — Onboard an Operator (once per operator/ecosystem)

The once-per-operator ceremony a human runs when joining an EXISTING ecosystem (one already configured
by `/ecosystem-init`). One of the three onboarding surfaces — distinct from `/ecosystem-init` (once per
fork) and `/onboard` (read-only, every session); see `workspaces/ecosystem-operating-model/02-plans/02-ga-ecosystem-onboarding.md`.

**Usage**: `/enroll` (no args; runs in the operator's checkout of an already-configured ecosystem)

`/enroll` does TWO writes — the roster registration (shared, PR-gated) and the per-operator local-links
(gitignored, machine-local) — then hands off to `/onboard`. It does NOT re-implement either write: B1
delegates to the existing `/whoami --register` path (the ONLY roster-write path), B2 writes the existing
per-operator gitignored layer. Procedure detail lives in `.claude/skills/44-enroll/SKILL.md` per
`cc-artifacts.md` Rule 3; this command is the entry point.

## The three invariants (load-bearing — the redteam surface)

1. **B1 roster registration wraps the EXISTING `/whoami --register` path.** Roster registration is the
   2-of-N-quorum PR-gated write described in `multi-operator-coordination.md` §1 — the ONLY roster-write
   path. `/enroll` does NOT re-implement it; it invokes `/whoami --register` (derive `person_id`, cut the
   `codify/<id>-<date>` branch off `main`, schema-validate, commit, push, open PR). NEVER writes
   `operators.roster.json` directly to `main` (branch protection rejects it).
2. **B2 local-links is per-operator gitignored — NO disclosure gate.** The NAME→on-disk-path layer
   (`loom-links.local.json`, `loom-links.mjs` precedence `$LOOM_LINKS_CONFIG` > local > fail-loud) is
   per-operator/per-machine and gitignored — it NEVER syncs and NEVER reaches a committed/public surface,
   so the #255 disclosure gate that `/ecosystem-init` C1 runs does NOT apply here. (Contrast: the
   ecosystem-SHARED `remote_links` IS disclosure-fenced; the per-operator LOCAL layer is not, because it
   never leaves the machine.)
3. **B3 hands off to `/onboard` — `/enroll` does not do the session-entry reads itself.** Roster + posture
   - team-memory + claims reads are `/onboard`'s read-only job (`knowledge-convergence.md` MUST-5);
     `/enroll` writes identity once, then points the operator at `/onboard` for every subsequent session.

## Ceremony steps (B1 → B2 → B3)

### B1 — roster registration (place the operator in a role)

Invoke `/whoami --register` (`.claude/commands/whoami.md` § `/whoami --register`). It collects
`display_id` / `github_login` / `host_role` / signing-key `{type,fingerprint,pubkey}`, derives the
immutable `person_id` (`pid-<display_id>-<short-fp>`), cuts a `codify/<display_id>-<date>` branch off
`main`, schema-validates the roster edit (`roster-schema-validate.js`), commits, pushes, and opens a PR.
New operators default to `role: contributor`; promotion to `senior`/`owner` is a separate quorum gate
(`--owner-add`), NOT part of `/enroll`.

**Role caveat (Q1, `02-ga` B1).** The four business roles (`platform-engineer` / `capability-engineer`
/ `business-consultant`) are the advisory `business_roles` array (`operators.roster.schema.json:94-105`),
ORTHOGONAL to the authority `role` (owner/senior/contributor) and never quorum-eligible
(`multi-operator-coordination.md` §1). `/enroll` places the operator into an AUTHORITY role now;
populating `business_roles` is an additive roster-ceremony field the operator (or an owner) may set —
it does not change the authority triple.

### B2 — local-links registration (per-operator, gitignored)

Write the operator's NAME→on-disk-path bindings to `loom-links.local.json`, seeded from the canonical
sublayout hint (`cross-repo.md` § "Canonical Sublayout (Recommended — F61)":
`~/repos/kailash/{build,use}/<slug>`, peers `~/repos/{loom,atelier}`). Copy the committed example
`.claude/bin/loom-links.local.example.json` and edit to the operator's actual layout. No disclosure gate
(invariant 2). Pre-existing operators on any other layout proceed unchanged — the resolver is
layout-agnostic.

### B3 — hand off

Print: "Enrolled. Run `/onboard` at the start of every session." Does NOT perform the session-entry reads
(invariant 3).

## Why a separate command (not a `/whoami` flag)

`/enroll` is intentionally a thin wrapper — B1 delegates to `/whoami --register`, B2 is a local-file
seed. It is a SEPARATE command (not folded into `/whoami --register --with-links`) because the three
named onboarding surfaces (`/onboard` read, `/enroll` operator, `/ecosystem-init` fork) are the core
distinction `02-ga` is built on: each names a distinct lifecycle moment, and an operator joining an
ecosystem looks for `/enroll`, not a `/whoami` flag. The named-surface coherence is the load-bearing
reason; the thinness is acceptable because a thin wrapper that names a distinct lifecycle moment earns
its surface. (The `02-ga` Q5 fold-vs-keep deliberation was adjudicated KEEP-SEPARATE at W8a redteam.)

## Posture-bound restrictions

`/enroll` B1 writes the working tree + opens a PR — gated by the L2/L3 trust posture per
`rules/trust-posture.md` (PR creation requires the appropriate write authority); B2 writes only a
gitignored local file (no posture gate). The PR enters the existing branch-protection + review chain.

## Implementation notes

B1's roster-write path is `.claude/commands/whoami.md` (the `--register` subcommand) + the schema
validator `.claude/hooks/lib/roster-schema-validate.js` + the schema `.claude/operators.roster.schema.json`.
B2's local-links layer is `.claude/bin/lib/loom-links.mjs` (resolver) + `.claude/bin/loom-links.local.example.json`
(the committed example with the canonical-sublayout tokens). The canonical sublayout hint is
`rules/cross-repo.md` § "Canonical Sublayout (Recommended — F61)". Full enrollment procedure — the
`/whoami --register` input prompts, the local-links seeding shape, the `business_roles` advisory field —
lives in `.claude/skills/44-enroll/SKILL.md`.
