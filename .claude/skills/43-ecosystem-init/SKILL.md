---
name: 43-ecosystem-init
description: /ecosystem-init procedure — write the D6 ecosystem-config, run the disclosure scan before write, establish genesis via runEnrollmentCeremony, scaffold non-Kailash STACK.md.
---

# /ecosystem-init — Ecosystem Onboarding Procedure

The procedure backing `.claude/commands/ecosystem-init.md` (the once-per-fork ecosystem ceremony). The
command body holds the five load-bearing invariants + the ceremony order; this skill holds the
step-by-step procedure, the input prompts, the D6 schema field set, and the exact tool-call shapes.

Three onboarding surfaces (the core distinction — `rules/enrollment-operations.md`):

| Surface           | Moment                     | Writes                                | Frequency       |
| ----------------- | -------------------------- | ------------------------------------- | --------------- |
| `/onboard`        | every session entry        | NO (read-only)                        | every session   |
| `/enroll`         | a human joins an ecosystem | roster + local-links                  | once / operator |
| `/ecosystem-init` | a fork's first setup       | ecosystem-config + genesis trust-root | once / fork     |

## Ceremony order: C1 → C3 → C2 → C4 → C5

Ordered per Q4: the registry defines the org, genesis anchors TO that org, the remaining params fill in.

### C1 — write the ecosystem-shared remote-links registry

1. **Collect** the NAME→remote bindings for this ecosystem's logical keys. The keys are EXACTLY the
   resolver keys (`artifact-flow.md` § "Repo Classes Map 1:1 To Resolver Logical Keys"):
   `build.py` / `build.rs` / `build.prism`, `use-template.{py,rs,claude-py,claude-rs}`,
   `loom`, `atelier`, `downstream.<slug>`. Each binds to `{ "org": "<org>", "repo": "<repo>" }`.
2. **Disclosure-scan BEFORE write (invariant 1).** The registry names real org slugs:
   ```bash
   node .claude/bin/scan-synced-disclosure.mjs --root "$(git rev-parse --show-toplevel)"
   ```
   Exit 0 → proceed. ANY finding (exit non-zero) → HALT; genericize/relocate the offending content and
   re-scan. NEVER write the config before a clean scan. (`ecosystem.json` is scanner-self-excluded when
   scanning its OWN source repo — `REPO_ROOT_ACTIVE === REPO_ROOT` per `scan-synced-disclosure.mjs:215`,
   which is the C1 case — so the scan covers the surrounding synced surface, not the config's own org
   slugs; those are fenced by path, not by scrub. A DESTINATION `--root` scan of a DIFFERENT repo DOES
   scan a stray `ecosystem.json`, failing loud on bare slugs — the belt-and-suspenders backstop (the
   destination-mode consequence of D6 §4 fence-iv's `isExcluded()` source-gate, not a separate fence).)
3. **Human-gate the org slugs (invariant 2).** Present each slug; for a CLIENT fork confirm each points
   at the CLIENT's org, never canon's. Automated placement is BLOCKED — a fork AUTHORS its own config.
4. **Write** the `remote_links` block of `.claude/bin/ecosystem.json` (schema below). The reader is
   `ecosystem-config.mjs::getRemoteLink(key)`; the join is `loom-links.mjs::resolveRemote(key)`.

### C3 — establish the genesis trust-root

Invoke `.claude/hooks/lib/genesis-ceremony.js::runEnrollmentCeremony({roster, repo, signingKeyPath,
signingKeyFingerprint, ghApi, transportAppend})` (invariant 3). It is fail-CLOSED — any failed gh-api
verification refuses to emit the genesis-anchor.

- **Org-owned fork** (`roster.genesis.repo_owner_kind: "org"`): the verified-org-admin attestation
  (`gh api orgs/{org}/memberships/{login}` → `role: "admin"`) is the trust anchor (the issue-#358
  org-owned-bootstrap relaxation — a verified active org admin substitutes for an unverified root commit).
- **User-owned fork**: the signed root commit (`gh api .../commits/{root_commit}` →
  `verification.verified == true`, author == declared owner) is the anchor.
- **Pre-condition**: the genesis-owner's `person_id` MUST already be in `operators.roster.json` with
  `role: owner` and the correct `github_login`. On a truly fresh fork, edit the bootstrap roster or run
  `/whoami --register` then promote the role on the resulting PR first.

The signed `genesis-anchor` lands in `.claude/learning/coordination-log.jsonl` (fold rule 9a accepts the
first verifying owner-bound anchor as the trust root). The consumer-relevant operational gotchas an
operator hits running the ceremony by hand are inlined below in § Operational runbook (this skill is
DISTRIBUTED to consumers; the genesis ceremony is self-sufficient without the loom-internal
`guides/co-setup/11-genesis-ceremony.md`, which carries the architecture / failure-mode reference / ADO
deep runbook for platform-engineers and is NOT shipped to consumers).

### C2 — set the four remaining ecosystem-relative params

Fill the rest of `.claude/bin/ecosystem.json`; human-confirm each points at the CLIENT's org:

- `registry` → `{ "host": "docker.io", "org": "<registry-namespace>" }` — replaces hardcoded
  `docker.io/<canon-org>/…` (`getRegistry()`).
- `vcs` → `{ "default_provider": "github", "overrides": { "build.rs": "azure-devops" } }` — ecosystem
  complement to per-repo `roster.genesis.provider`; **roster wins for its own repo** (`getRepoProvider`).
- `deploy` → `{ "default_targets": [...], "per_project": {...} }` (`getDeploy()`).
- `upstream_canon` → `{ "remote": "upstream", "url": "git@<host>:<canon-org>/loom.git" }` — **null in
  canon**; the client's explicit "sync upstream from" pointer (`getUpstreamCanon()`).

### C4 — non-Kailash fork → scaffold STACK.md

If the fork's build is NOT Kailash, invoke the EXISTING `/onboard-stack` (detects the stack, scaffolds
`STACK.md`). Skip for a full-Kailash fork. Does NOT re-implement detection.

### C5 — hand off (invariant 4)

Print: "Ecosystem configured. Each operator now runs `/enroll`, then `/onboard` at the start of every
session." Do NOT enroll the initiating operator — that is `/enroll`'s gated job.

## Operational runbook

Operational gotchas an operator hits running the genesis ceremony (`/ecosystem-init` C3, or
`/whoami --enroll-genesis`) by hand. These are CLI / host-environment facts the consumer needs but cannot
reverse-engineer from library + hook code; inlined here so the irreversible, fail-CLOSED ceremony is
self-sufficient WITHOUT the loom-internal `guides/co-setup/11-genesis-ceremony.md` (consumers do not
receive `guides/`). Origin: F19 genesis-enrollment session (2026-05-27).

### 1. Enroll BEFORE the bootstrap commit (ordering)

Writing a real (non-`PLACEHOLDER-`) `role: owner` person into `operators.roster.json` while the
coordination log has NO `genesis-anchor` record puts the repo into a **half-enrolled fail-CLOSED** state:
`genesis-anchor-guard.js` then blocks every `git commit` / `git push` (it watches literal
`git commit|push`, `gpg … --sign`, `ssh-keygen -Y sign`) until a verifying owner-bound anchor exists.
Correct sequence:

1. Write the owner entry + genesis facts into the roster (working tree — via the script-by-path form in
   § 2 below, never an inline `node -e` naming the roster path).
2. Run the enrollment ceremony → emits the `genesis-anchor` → trust root.
3. THEN commit the roster and open the bootstrap PR.

The ceremony reads the roster from the working tree, so step 2 does NOT require the roster merged first.
The enroll driver is a single `node` invocation; its internal signing is `child_process`, not the Bash
tool, so it never trips the guard.

### 2. Roster / coordination-log writes go through a script invoked by its own path

The `validate-bash-command.js` state-file-write guard (`detectStateFileMutation`, Layer 3) BLOCKS any
interpreter command (`node -e`/`-c`/`-m`, or any command LED by `node`/`python`/`ruby`/`perl`) whose
**command string** contains a protected state-file path — `operators.roster.json`,
`coordination-log.jsonl`, `posture.json`, `violations.jsonl`, `.initialized`. The documented inline
`node -e '… operators.roster.json …'` form therefore CANNOT run; this is correct — only the canonical
roster-write path may touch the roster. (`.claude/settings.json::permissions.deny`, where present, is a
second lexical defense-in-depth layer matching the same paths.)

Write the ceremony as a **script file invoked by its own path** — the protected path lives INSIDE the
script body, off the command line. Crucially, the script-WRITE and the script-RUN must be **separate Bash
invocations** (or write the script with the editor): bundling a heredoc-write and the `node <script>` run
into ONE command trips the guard's whole-command fallback (a `node`-led segment + the protected path in
the heredoc body):

```bash
# Step A — create the script (separate command; protected path inside the body)
cat > "${TMPDIR:-/tmp}/coc-roster-ceremony.cjs" <<'CEREMONY'
const fs = require("fs");
const ROSTER = ".claude/operators.roster.json";   // path lives in the body, not the command line
// … read roster, apply edit, schema-validate via roster-schema-validate.js, fs.writeFileSync(ROSTER, …)
CEREMONY
```

```bash
# Step B — run by its own path (separate command; clean command line)
node "${TMPDIR:-/tmp}/coc-roster-ceremony.cjs"
```

```bash
# DO NOT — protected path on the command line → auto-blocked (Layer 3)
node -e 'fs.writeFileSync(".claude/operators.roster.json", …)'
```

The guard matches the tool-invocation command STRING, not the spawned process's syscalls, so a script
that internally `fs.writeFileSync`s the roster is allowed. The lexical guard is defense-in-depth, NOT the
load-bearing control and NOT a license to wrap an arbitrary write in a script to dodge protection: the
sanctioned writers remain the canonical ceremony helpers, and the load-bearing protections are
`genesis-anchor-guard.js` + branch protection on the roster + `integrity-guard.js` + fold-rule
signature/chain verification (`rules/multi-operator-coordination.md` §2). A hand-rolled script that slips
past the lexical guard still fails those gates — the roster lands only via a schema-validated,
branch-protected PR, and unsigned / out-of-chain coordination-log records are rejected at fold. The same
`/whoami --register` Step 4 documents this script-by-path form.

### 3. `gh pr merge --admin` may fail server-side → REST PUT merge fallback

On a branch-protected `main` with `enforce_admins: false`, the owner admin bypass merges a chore / roster
bootstrap PR. If `gh pr merge <N> --admin --merge` returns a generic GraphQL error ("Something went
wrong … reference ID"), use the REST merge endpoint — a different code path that honors the admin bypass:

```bash
gh api -X PUT repos/<owner>/<repo>/pulls/<N>/merge -f merge_method=merge
```

### 4. Pushing without an SSH key loaded

If `ssh-add -l` reports no identities and the remote is SSH, `git push` fails
`Permission denied (publickey)`. Push over HTTPS using `gh` as a one-shot, non-persistent credential
helper (the `gh` token must carry `repo` scope) — no token in the command string, no permanent git-config
change:

```bash
git -c credential.helper='!gh auth git-credential' push origin <branch>
```

## The D6 ecosystem-config schema (`.claude/bin/ecosystem.json`)

```jsonc
{
  "schema_version": 1,
  "ecosystem": {
    "id": "<opaque-local-label>", // NOT a client name
    "upstream_canon": {
      "remote": "upstream",
      "url": "git@<host>:<canon-org>/loom.git",
    },
  },
  "registry": { "host": "docker.io", "org": "<registry-namespace>" },
  "remote_links": {
    "build.py": { "org": "<org>", "repo": "kailash-py" },
    "loom": { "org": "<org>", "repo": "loom" },
  },
  "vcs": {
    "default_provider": "github",
    "overrides": { "build.rs": "azure-devops" },
  },
  "deploy": { "default_targets": [], "per_project": {} },
}
```

Validate by loading `ecosystem-config.mjs::getEcosystemConfig()` after writing — a malformed /
unknown-`schema_version` file fails loud (the D6 Q6 contract). The synthetic companion
`.claude/bin/ecosystem.example.json` is the only `ecosystem*` file that syncs/publishes.

## Disclosure isolation — the structural guarantee

`ecosystem.json` carries real org slugs BY DESIGN. Its isolation is by PATH, not by scrub (invariant 5):
committed-but-never-synced (`sync-manifest.yaml::loom_only`), never-published (`publish-to-public.mjs`
EXCLUDE_WITHIN + KILL_BASENAMES), and scanner-self-excluded at loom-source ONLY
(`REPO_ROOT_ACTIVE === REPO_ROOT`; a destination `--root` scan of another repo DOES scan a stray copy,
failing loud on bare slugs — the belt-and-suspenders backstop). A canon fork and a client fork each
carry their OWN file; a fork pulls upstream-only; no canon→client sync path exists. This is the D6 plan
§4 (i)-(iv) fence composition — fence by ABSENCE, the strongest guarantee.
