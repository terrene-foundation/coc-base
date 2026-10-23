---
name: release
description: "COC authorization gate + optional SDK publish. Runs after /codify, before /deploy or PyPI publish."
---

# /release — COC Authorization + Optional SDK Publish

Final COC authorization gate. Runs after `/codify` and before `/deploy` (USE apps) or PyPI publish (BUILD/SDK repos). Not a workspace phase — runs independently after any number of implement/redteam cycles.

`/release` behavior is **repo-type-aware**. Step 0 below detects the repo type and routes to the right path; the COC authorization shape and the SDK publish shape are different commands sharing one entry point.

## Step 0: Repo Type Detection

1. Read `.claude/VERSION::type` (case-sensitive). Valid values: `coc-source`, `coc-build`, `coc-use-template`, `coc-project`.
2. Read `deploy/deployment-config.md` first-line frontmatter `type:` field (if file exists). Valid: `application`, `sdk`, `library`.
3. Route:
   - **USE application repo** = `.claude/VERSION::type ∈ {coc-project, coc-use-template}` AND `deploy/deployment-config.md::type == application` → **Authorization Mode** (this command's USE-app branch).
   - **BUILD/SDK repo** = `.claude/VERSION::type == coc-build` OR `deploy/deployment-config.md::type ∈ {sdk, library}` OR `.claude/VERSION` missing AND `pyproject.toml`/`Cargo.toml` declares a published package → **SDK Publish Mode** (the legacy /release flow below).
   - **Unknown** → STOP and surface to the user: "repo type undetected; specify whether this is a USE application or an SDK/BUILD repo."

The detection MUST happen before any release-specific work begins. Misrouting a USE app through SDK Publish (or vice versa) is the failure mode this rule prevents.

---

## Authorization Mode (USE application repos)

`/release` here is the **sixth COC phase** — the authorization gate confirming the application is ready to deploy. It does NOT publish packages. `/deploy` performs the actual application deployment after `/release` authorizes.

### Multi-operator gate (C2)

In an enrolled multi-operator repo (the substrate's own switch — `lib/coordination-mode.js::isCoordinationEnabled`, on when ≥2 DISTINCT humans are bound; it is NOT "more than one `person_id`", since several person_ids can bind one human), `/release` is intercepted by `.claude/hooks/operator-gate.js` per §6.4 row 'release'. The gate:

**Scope of the interception, stated because the two differ.** The gate fires on the MODEL-INVOKED surface — a `/release` the agent runs arrives as a `Skill` tool call, which the row `PreToolUse:Skill` gates and REFUSES with a block (exit 2 / `permissionDecision: deny`). A `/release` the USER TYPES produces no tool call at all: the host expands it and runs the body, and the only event that sees that expansion (`UserPromptExpansion`) is not in this tree's hook-registry event vocabulary yet. A typed invocation is therefore NOT gated today; do not read this section as covering it.

1. Resolves the requester's own identity SERVER-SIDE — `lib/operator-id.js::resolveIdentity` (the key this machine signs with), cross-checked against the COMMITTED roster at `HEAD`. A `requester_person_id` / `requester_verified_id` in the payload that disagrees with it is refused outright; the approval's canonical bytes bind the server-derived values, so the requester half cannot be chosen by the caller.
2. Cryptographically verifies the signed `gate-approval` payload via `lib/gate-approval.js::verifyGateApproval` (F14 MED-1): payload sig MUST verify against the approver's pubkey as resolved from the COMMITTED roster — a roster supplied in the payload is IGNORED (it was the whole hole until 2026-10-09: the caller chose the root the derivation was anchored to); approver_role / host_role are read from the ROSTER, never from the payload.
3. Verifies nonce + target_tool + TTL binding (F14 MED-2): `gate_approval.consumed_nonce == requester_nonce`, `gate_approval.target_tool == "release"`, `gate_approval.ts` within 24h of now. `consumed_nonce` is a BINDING token, NOT a consumed one-shot: nothing at this surface retires the nonce, and the one-shot semantics the name suggests live only in the fold's replay predicate, which (below) has no production caller. Runs only AFTER the signature verified — a forged probe is refused on the signature, never told the live nonce.
4. Rejects iff (a) approver `person_id` == requester (4-eyes); (b) approver and requester share the same bound GitHub-collaborator login under case-insensitive comparison (R5-S-07, F14 MED-4); (c) approver `host_role: ci` (R5-S-04).
5. Degenerate self-sign IS permitted ONLY when derived-N=1 traces to genuine genesis (NOT revocation-induced, R9-S-02 fence); audit marker `degenerate-self-sign-genuine-genesis-N1` recorded in stderr.

**Submission flow** (the multi-operator gate-approval + nonce protocol):

1. Requester runs `/release`. Command mints a fresh `requester_nonce` (16 random bytes hex) for THIS invocation and surfaces it alongside "Authorization required from distinct owner/senior (not <requester_gh_login>; not host_role:ci). Approver MUST sign over **all nine fields**: `{target_tool:'release', command:'release', target_sha:<the commit being released — the repo's current `git rev-parse HEAD`, 40-hex>, requester_person_id, requester_verified_id, consumed_nonce:<this-nonce>, ts, expires_at:<end of validity, at most 24h after ts>}`."

   **The approval is bound to ONE action** (2026-10-09 replay closure): the gate compares `command` and `target_sha` against values it derives itself — the live command surface and the repository's HEAD at gate time. So a signature obtained for one commit does NOT authorize another: if HEAD moves between signing and the gated invocation, the approval is REFUSED and must be re-requested. `command` is the normalized surface (`release`; for `/posture` it includes the args, e.g. `posture upgrade --to L5`) — ONLY the surface prefix is normalized (leading `/` stripped, command name lowercased, ends trimmed); the ARGS are bound EXACTLY, inner whitespace included, so `--tag "a  b"` and `--tag "a b"` are different authorizations. The ONE normalizer is `lib/gate-approval.js::normalizeGateCommand`.
2. Second operator signs the canonical bytes via `lib/coc-sign.js::sign`. The signed approval reaches the gate as the `gate_approval` field of the requester's invocation; a FOLDED `gate-approval` record is NOT what the gate reads today — `gate-approval.js::emitGateApproval` has no production caller and `coc-emit.js` refuses an actuation record without a PROVEN broker presence proof, so the folded-record path (and the log's `consumed_nonce` replay predicate with it) is owed, not live.
3. Requester re-runs `/release --approval <approval-ref>` with the SAME `requester_nonce`. `operator-gate.js` runs `verifyGateApproval` (sig + nonce + target_tool + ttl) against the committed roster; if any check fails the hook BLOCKS the invocation (exit 2 + `permissionDecision: "deny"`), and the command does not run.

In a solo repo the substrate is OFF and the gate passes the invocation through — there is nothing to gate. (A repo that ENABLES coordination explicitly while carrying one human keeps the degenerate path: a self-sign is permitted only when derived-N=1 traces to genuine genesis, and is recorded with the audit marker `degenerate-self-sign-genuine-genesis-N1`.)

### Authorization checklist

Run these checks; halt on any failure:

1. **`/redteam` convergence**: most recent redteam round in the active workspace reports zero CRITICAL + zero HIGH under the round mechanism (**Round 1 clean = review ends**; otherwise a fix-scoped Round 2, a Round-2 finding gets its fix plus its A5 check(s) (D237, `commands/redteam.md` Criterion 3) — **never a Round 3 or 4**) per the D237 review ruling 2026-10-08 (supersedes the former per-spec-v6 two-round convention).
2. **`/codify` complete**: most recent codify cycle landed; no pending knowledge proposals (`.claude/.proposals/latest.yaml::status != distributed` is BLOCKED).
3. **Test suite green**: `pytest` / `cargo test` / `npm test` per the project's test runner exits 0; no skipped tests without explicit `xfail` rationale.
4. **Security review green**: `security-reviewer` agent confirms no unaddressed CRITICAL/HIGH findings against the current diff vs deploy baseline.
5. **Deployment-config readiness**: `deploy/deployment-config.md` exists, target environment + rollback procedure documented.
6. **Branch / tag hygiene**: no uncommitted changes; current `main` matches `origin/main`.
7. **Version + changelog updated**: project version anchor (`pyproject.toml::version`, `Cargo.toml::version`, `package.json::version`, or whichever the project's `deploy/deployment-config.md` declares as canonical) has been incremented since the last `/deploy`; `CHANGELOG.md` (or the project's equivalent release-note file) carries an entry for the new deploy. Traceability requirement — deploy-time runbooks and rollback procedures depend on the version anchor matching the deployed artifact.

### On success

Surface the authorization summary to the user:

```
## /release Authorization — <project> ready for /deploy

✓ redteam: <round-history>
✓ codify: <proposal-sha>
✓ tests: <pass-count> / <skip-count>
✓ security: <last-audit-sha>
✓ deploy-config: <target-environment>
✓ branch: <branch>@<sha>

→ Next: run `/deploy` to ship to <target-environment>.
```

The user authorizes by running `/deploy`. `/release` itself does not deploy.

### Agent teams (USE app authorization)

- **release-specialist** — run the authorization checklist
- **security-reviewer** — MANDATORY pre-authorization audit (any unaddressed CRITICAL/HIGH blocks)
- **testing-specialist** — verify test posture
- **reviewer** — verify documentation references, code examples

---

## SDK Publish Mode (BUILD / SDK repos: kailash-py, kailash-rs, etc.)

`/release` here is the **SDK publishing command** — bumps versions, tags, publishes to PyPI / crates.io. Inapplicable to USE app repos.

### Deployment Config

Read `deploy/deployment-config.md` at the project root. This is the single source of truth for how this SDK publishes releases.

### If `deploy/deployment-config.md` does NOT exist → Onboard Mode

Run the SDK release onboarding process:

1. **Analyze the codebase** — packages, build system, CI workflows, docs setup, test infrastructure, multi-package structure
2. **Ask the human** — PyPI strategy, token setup, docs hosting, CI system, versioning strategy, changelog format, release cadence
3. **Research current best practices** — web search for current PyPI/CI/build tool guidance. Do NOT rely on encoded knowledge.
4. **Create `deploy/deployment-config.md`** — document all decisions with rationale, step-by-step runbook, rollback procedure, release checklist
5. **STOP — present to human for review**

### If `deploy/deployment-config.md` EXISTS → Execute Mode

Read the config and execute:

#### Step 0: Release Scope Detection

1. **Diff analysis** — compare `main` against last release tag per package:
   ```
   git log <last-tag>..HEAD -- kailash/           # Core SDK changes?
   git log <last-tag>..HEAD -- kailash-dataflow/   # DataFlow changes?
   git log <last-tag>..HEAD -- kailash-kaizen/     # Kaizen changes?
   git log <last-tag>..HEAD -- kailash-nexus/      # Nexus changes?
   ```
2. **Present release plan** — which packages, version bump type, dependency updates. **STOP and wait for human approval.**

#### Steps 1-7

Version bump → consistency verification → pre-release prep → build/validate on TestPyPI → git workflow → publish to PyPI → post-release. See `skills/10-deployment-git/release-runbook.md` for the full step-by-step procedure, version locations, and verification commands.

### Agent teams (SDK publish)

- **release-specialist** — codebase analysis, onboarding, SDK release execution
- **release-specialist** — Git workflow, PR creation, version management
- **security-reviewer** — Pre-release security audit (MANDATORY)
- **testing-specialist** — Verify test coverage before release
- **reviewer** — Verify documentation builds and code examples

### Critical Rules (SDK publish)

- NEVER publish without the full test suite passing AND a pre-publish security review; NEVER skip TestPyPI for major/minor releases.
- NEVER commit PyPI tokens — use `~/.pypirc` or CI secrets.
- ALWAYS update version in BOTH `pyproject.toml` AND `__init__.py`; verify the published package installs in a clean venv.
- ALWAYS publish in dependency order (core SDK first, then frameworks); document each release in `deploy/deployments/`.
- ALWAYS update the framework's `kailash>=` dependency AND the downstream COC template pins after publishing; verify current tool syntax (don't assume stale knowledge).

**Automated enforcement**: `validate-deployment.js` hook blocks commits containing credentials in deployment files.

## Final step (MUST — both modes): refresh `.session-notes`

A release IS a close-out event. After the authorization sign-off (or the SDK publish completes), refresh `.session-notes` per the `/wrapup` contract (`commands/wrapup.md`) AS PART OF this flow — do NOT leave it as a separate manual `/wrapup` the operator has to remember to type. Stage the refreshed notes into the release/close-out commit so the notes and the landing are atomic. (The `wrapup-after-landing.js` PostToolUse hook is the backstop on `gh pr merge`; this step is the deterministic primary so the notes update in-flow.) Skip ONLY if `.session-notes` already reflects this release.

## Skill References

- `skills/10-deployment-git/release-runbook.md` — Version tables, step-by-step procedures, verification commands (SDK publish)
- `skills/10-deployment-git/deployment-packages.md` — Package release patterns
- `skills/10-deployment-git/deployment-ci.md` — CI/CD infrastructure
