---
name: ecosystem-init
description: "Initialize ecosystem config, genesis trust, and non-Kailash STACK.md; owner-gated and disclosure-fenced."
---

# /ecosystem-init — Onboard an Ecosystem (once per fork)

The once-per-fork ceremony that configures a NEW ecosystem (canon, or a client fork that copied the
loom↔build↔use ecosystem). One of the three onboarding surfaces — distinct from `/enroll` (once per
operator) and `/onboard` (read-only, every session); see (loom-internal reference).
The three share ZERO write-authority: `/onboard` writes nothing, `/enroll` writes roster + local-links,
`/ecosystem-init` writes the ecosystem-config + genesis trust-root + the ecosystem's OWN
`canon-identity-values.json` (C1b).

**Usage**: `/ecosystem-init` (no args; runs in the current fork's loom checkout)

**Strictly dependency-ordered BEFORE this command, for a client fork:** `/clean-instantiate` — the
once-per-clone CLEAR ceremony (`.codex/prompts/clean-instantiate.md`) — MUST have run to a `0`-exit
fail-closed assert-zero gate on any repo templated or cloned FROM canon. C3 below re-anchors genesis to
the CLIENT's owner; it MUST NOT run over a clone that still carries canon's trust-identity (roster,
journal, `ecosystem.json`) at rest — re-anchoring on top of un-cleared identity leaves canon's substrate
readable underneath the new root. Canon itself (never cloned FROM anything) has no such precursor and
runs `/ecosystem-init` directly. For a client whose clone is not yet clear, `/ecosystem-init` is NOT the
first command to run — `/clean-instantiate` is.

Strictly dependency-ordered after this command: an operator runs `/enroll` (identity), then `/onboard`
(reads each session). `/ecosystem-init` does NOT silently enroll the initiating operator — it hands off
to `/enroll` (C5). Procedure detail (input prompts, the D6 schema field set, the disclosure-scan
invocation shape, the genesis-ceremony call) lives in `.agents/skills/43-ecosystem-init/SKILL.md` per
`cc-artifacts.md` Rule 3; this command is the entry point.

## The five invariants (load-bearing — the redteam surface)

1. **C1 disclosure gate fires BEFORE the ecosystem-config write.** The config names real org slugs
   (the #255/#252 disclosure class). `node .claude/bin/scan-synced-disclosure.mjs --check --root <fork-checkout>`
   MUST run and exit 0 BEFORE `.claude/bin/ecosystem.json` is written; ANY finding → HALT, genericize +
   relocate, re-scan. Placement does not proceed on a non-zero exit (the `artifact-flow.md` Intake-Scrub
   shape, applied at ecosystem-config write time). The scan covers the SURROUNDING synced surface, NOT
   `ecosystem.json`'s own slugs (the scan runs BEFORE the config is written, and the scanner self-excludes
   the config at loom-source) — those slugs are fenced by PATH (invariant 5: loom-only never-synced +
   publish-excluded), not by this scrub (the SKILL § "Disclosure isolation" carries the full nuance).
2. **Human gate confirms the org slugs.** For a CLIENT fork, the human MUST confirm each slug points at
   the CLIENT's org, never canon's — a fork AUTHORS its OWN `ecosystem.json` (it never inherits canon's;
   the structural basis of cross-ecosystem isolation, D6 plan §A1). Automated org-slug placement is BLOCKED.
3. **Genesis trust-root is established via the EXISTING ceremony.** C3 invokes
   `.claude/hooks/lib/genesis-ceremony.js::runEnrollmentCeremony` (the org-owned-bootstrap path,
   `multi-operator-coordination.md` §6 + §1 issue-#358 relaxation) — it does NOT re-implement genesis.
   Owner-class gate; fail-CLOSED (any failed gh-api verification refuses to anchor). On a client fork,
   C3 MUST NOT run until `/clean-instantiate`'s fail-closed assert-zero gate has exited 0 (see above) —
   the CLEAR precedes the establish-new-root step it gates.
4. **C5 does NOT silently enroll the initiating operator.** The ceremony ends by handing off to
   `/enroll`; enrolling the operator is `/enroll`'s job, gated separately (`knowledge-convergence.md`
   MUST-5 forbids `/onboard`-class commands auto-running roster/genesis writes for an operator).
5. **`ecosystem.json` is ecosystem-private by path.** It is written to `.claude/bin/ecosystem.json` —
   committed-but-never-synced (`sync-manifest.yaml::loom_only`), never-published
   (`publish-to-public.mjs` EXCLUDE+KILL), and scanner-self-excluded ONLY at loom-source
   (`REPO_ROOT_ACTIVE === REPO_ROOT`); a DESTINATION `--root` scan of another repo DOES scan a stray
   copy, failing loud on bare org slugs — the belt-and-suspenders backstop. A fork carries its OWN file;
   no canon→client sync path exists, so canon org slugs cannot travel into a client (D6 plan §4 fence-i).

## Ceremony order (C1 → C1b → C3 → C2 → C4 → C5)

Ordered per Q4 (`02-ga` Open questions): the registry defines the org, the identity declaration
captures it (C1b), genesis anchors TO that org, then the remaining params fill in.

### C1 — write the ecosystem-shared remote-links registry (D6 data)

Collect the NAME→remote bindings for this ecosystem's logical keys (the EXACT resolver keys per
`artifact-flow.md` § "Repo Classes Map 1:1 To Resolver Logical Keys": `build.{py,rs,prism}`,
`use-template.{…}`, `loom`, `atelier`, `downstream.<slug>`). Run the disclosure scan (invariant 1).
Human-confirm the org slugs (invariant 2). Write the `remote_links` block of `.claude/bin/ecosystem.json`
per the D6 schema (`ecosystem-config.mjs` is the reader; `getRemoteLink(key)` / `resolveRemote(key)` are
the accessors). NEVER edit a synced artifact to carry the registry inline (`cross-repo.md` MUST NOT).

### C1b — write THIS ecosystem's own canon-identity declaration (the private-slug guarantee)

Every distribution and publish gate reads `.claude/canon-identity-values.json`: the orgs THIS
ecosystem must NEVER ship. Write it FOR THIS FORK, from the SAME human-confirmed answers C1 just
collected — never copy canon's values, never leave it absent. An absent or empty private set makes
every distribution entrypoint REFUSE (`assertPrivateOrgConfig`: "refusing to distribute a tree whose
private-slug gate would be vacuous") and loudly SKIPS the private-armed selftest rows — correct for
a pre-init seed, and wrong the moment the fork is meant to distribute.

1. Author `.claude/canon-identity-values.json` — the seed ships `.claude/canon-identity-values.example.json`
   (the SHAPE, travelling with every client template); COPY it and replace every placeholder (keep
   `_schema`/`_doc`):

   `{ "private_org_slugs": ["<client-org>"], "retired_org_slugs": [], "public_org_slugs": ["<org the fork's templates live in>"] }`

2. Human-confirm EVERY private slug is the CLIENT's own org (invariant 2 extends here — a canon slug
   in this file would gate the wrong identity).
3. Validate BOTH ways: `node .claude/bin/lib/strip-build-internal.mjs --assert-private-org-config`
   exits 0 and prints the resolved COUNT only (never values); AND
   `node .claude/bin/lib/strip-build-internal.mjs --assert-fork-identity-derived` — a MANUAL
   SANITY CHECK, deliberately NOT a gate (no entrypoint calls it): it compares the org of this
   fork's git `origin` remote against the declaration's private set (no canon data involved; a
   local-path or unparseable origin is UNKNOWN, with a clear message; a missing origin or missing
   values refuses). It CANNOT detect a copied canon declaration — author the values from this
   fork's own answers and have the human confirm them (step 2); the check only helps when the
   clone's origin is a parseable hosted remote.
4. Verify the FENCES the seed ships for this file are intact: `loom_only` in
   `.claude/sync-manifest.yaml` AND a `CLIENT_TEMPLATE_REMOVE` projection entry — canon's file is
   double-fenced for a reason, and the fork's carries the same sensitivity.

### C3 — establish the genesis trust-root

Invoke `runEnrollmentCeremony` (invariant 3). For an org-owned fork the verified-org-admin attestation
is the trust anchor (issue #358 org-owned bootstrap); for a user-owned fork the signed root commit is.
Owner-class gate; the signed `genesis-anchor` record lands on BOTH surfaces via the composed
enrollment-seed transport (`enrollment-seed-transport.js::createEnrollmentSeedTransport`) — the
canonical FETCHABLE git ref `refs/coc/coordination-gen<N>` (uncapped; the fresh-clone recovery
surface, loom#879) FIRST, then the local coordination-log cache.

### C2 — set the four remaining ecosystem-relative params

`registry` (`{host,org}` — replaces hardcoded `docker.io/<canon-org>/…`), `vcs.default_provider`
(+ `overrides`), `deploy.default_targets`, `upstream_canon` (`{remote,url}` — null in canon, the
client's "sync upstream from" pointer otherwise). Human-confirm each points at the CLIENT's org for a
client fork (invariant 2 extends to all five params). These complete `.claude/bin/ecosystem.json`.

### C4 — non-Kailash fork → scaffold STACK.md

If the fork's build is NOT Kailash, invoke the EXISTING `/onboard-stack` (detects the stack, scaffolds
`STACK.md`; the generic `agents/generic/{ai,api,db}-specialist` bind to it). Does NOT re-implement
detection. Skip for a full-Kailash fork.

### C5 — hand off

Print: "Ecosystem configured. Each operator now runs `/enroll`, then `/onboard` at the start of every
session." Does NOT enroll the initiating operator (invariant 4).

## Posture-bound restrictions

`/ecosystem-init` writes the working tree (C1's `ecosystem.json` AND C1b's
`canon-identity-values.json` — the identity declaration this ceremony exists to establish) AND runs
the genesis ceremony (network-permitted, owner-class) — gated by the L2/L3 trust posture per
`rules/trust-posture.md` and the §6.4 owner gate for the genesis anchor. On a fresh fork the default
posture is `L5_DELEGATED`; the genesis ceremony's owner-class gate is independent of posture.

## Implementation notes

The client-fork precondition (the CLEAR ceremony `.codex/prompts/clean-instantiate.md`, engine `.claude/bin/clean-instantiate.mjs`) is a prerequisite gate, checked by the operator/orchestrator BEFORE running `/ecosystem-init` — a distinct command this one does NOT invoke.

Reader/engine/schema surfaces — `ecosystem-config.mjs` + the D6 schema, the loom-only `loom-links.mjs` resolver, the `ecosystem.example.json` companion, the disclosure scanner, and the genesis-ceremony operational runbook (enroll-before-commit ordering, the state-file-guard script-by-path constraint, admin-merge fallbacks) — live in `.agents/skills/43-ecosystem-init/SKILL.md` § "The D6 ecosystem-config schema" + § "Operational runbook". Full ceremony procedure (input prompts, the per-key `remote_links` shape, the scan-then-write ordering, the org-vs-user genesis branch) is that skill's body.
