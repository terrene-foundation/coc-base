---
id: "DEPLOY"
name: deploy
description: "Deploy application code to production. Onboard / execute / check modes driven by deploy/deployment-config.md."
---

# /deploy - Application Deployment

For applications that ship code to running environments (containers, edge functions, VMs, k8s, mobile stores). Driven by `deploy/deployment-config.md`.

**Relationship to `/release`** (USE application repos): `/release` is the **sixth COC phase** — the authorization gate confirming readiness (redteam convergence + codify complete + tests + security review + deployment-config readiness). `/deploy` is the **mechanism** that ships the application to its target environment AFTER `/release` authorizes. Sequence: `/redteam` → `/codify` → `/release` (authorize) → `/deploy` (ship).

**Different meaning on BUILD/SDK repos**: on a BUILD repo (`deploy/deployment-config.md::type: sdk`), `/release` is the **SDK publishing command** — bumps versions, tags, publishes to PyPI / crates.io / npm. `/deploy` is not applicable on SDK repos; if invoked, this command redirects to `/release`.

## Mode Detection

```
/deploy            → Execute mode
/deploy --check    → Check mode (drift detection only, no deploy)
/deploy --onboard  → Onboard mode (create deployment-config.md)
```

### If `deploy/deployment-config.md` does NOT exist → Onboard Mode

Run the application deployment onboarding process. See `skills/10-deployment-git/application-deployment.md`.

1. **Detect platform** — read repo for clues: `Dockerfile`, `vercel.json`, `fly.toml`, `app.yaml`, `kubernetes/`, `azure-pipelines.yml`, `containerapps/`, `Procfile`, native binaries
2. **Ask the human** — what platform, what deploy command, what counts as "production code", how to query current deployed state, staging required?
3. **Research current best practices** — web search for platform-specific deploy patterns (Container Apps revisions, Fly machines, Cloud Run revisions, etc.). Do NOT rely on encoded knowledge — cloud platform CLIs change frequently.
4. **Create `deploy/deployment-config.md`** — see schema in `skills/10-deployment-git/application-deployment.md`
5. **STOP — present to human for review**

### If `deploy/deployment-config.md` declares `type: sdk` → Redirect

This repo is an SDK. Run `/release` instead — it handles version bumping, PyPI/registry publishing, and artifact validation.

### If `deploy/deployment-config.md` declares `type: application` → Execute Mode

Read the config and execute. **Print the 6-step DEPLOY CHECKLIST (Step 0–5) at the start of the response and check off boxes as each step passes. Do NOT report deploy as complete until every box is checked.** The checklist IS the Step 0–5 sequence enumerated below (this command is its single source of truth); the print-and-follow mandate is `rules/deploy-hygiene.md` Rule 8, and deep per-step guidance lives in `skills/10-deployment-git/application-deployment.md`. If any step fails, say "DEPLOY FAILED AT STEP N: <reason>" — NOT "build succeeded, will redeploy soon".

#### Step 0: Ecosystem Resolution (ecosystem-relative deploy)

Resolve the effective deploy target FIRST, so every later step runs against the resolved ecosystem infra — never a canon-hardcoded default. Full model: `specs/07-deploy.md` in the ecosystem-operating-model workspace.

1. **Resolve the target** — pass the project's `deployment-config.md` deploy values (as JSON) through the resolver:
   `node .claude/bin/deploy-config.mjs --key <project-resolver-key> --config <deploy-values.json>`
   It composes `ecosystem.json::deploy` (`default_targets` ⊕ `per_project[<key>]`) under the project values and substitutes every `${ecosystem.deploy.<field>}` token. No `ecosystem.json` (canon / pre-fork / plain consumer) → the project values pass through unchanged (today's behavior). An unresolvable token fails CLOSED (exit 1, named field) — NEVER a silent canon fallback.
2. **Dispatch by provider** — ship via the resolved provider using the shipped VCS write-surface `applyDeployTarget(transport, descriptor)` (`.claude/hooks/lib/vcs-github-adapter.js` / `vcs-azure-adapter.js`): GitHub → `workflow_dispatch` the deploy workflow; Azure DevOps → run the Azure Pipelines deploy (`unverified`-flagged until a live ADO org). REUSE this actuator — do NOT author a second deploy path. Note: the resolver's output is a FLAT merged config, NOT the actuator's descriptor — map its fields (provider, registry org, env, workflow id) into the `applyDeployTarget` descriptor `{repoRef, workflow, ref?, inputs?}` before the call; do not pass the resolver JSON verbatim.
3. Carry the resolved target into Step 1+ — verification and gates run against the resolved ecosystem target.

#### Step 1: Pre-Deploy Verification

1. **Drift check** — run `deploy_check_command` from config. Compare current deployed commit/revision against `git rev-parse HEAD`.
2. **Production paths diff** — `git diff <last_deployed_commit> HEAD -- <production_paths>` to confirm what's actually being shipped.
3. **Present diff summary to human and STOP for approval** if any of: untested changes, schema migrations, secret/config changes, breaking API changes.

#### Step 2: Pre-Deploy Gates

Run the gate commands from config (typically: tests, lint, security scan). Block on failure unless `--skip-gates` is explicitly set with a documented reason.

**Why each gate exists is documented in `deployment-config.md`. Do not skip gates without reading why they're there.**

#### Step 3: Execute deploy_command

Run the `deploy_command` from config. Stream output. Capture exit status.

If deploy fails:

1. Read the error
2. Diagnose root cause
3. Fix the underlying issue (do NOT retry blindly)
4. Re-run from Step 1

#### Step 4: Post-Deploy Verification (THE MOST IMPORTANT STEP)

**"Deploy command exited 0" is NOT verification.** Users do not interact with your deploy command. They interact with whatever HTTP/CLI/binary surface is in front of the new revision. That is what MUST be verified.

Run ALL of these checks. Each one failing means deploy is NOT done.

1. **Revision check** — Run `deploy_check_command` again and confirm the deployed commit/revision is now `HEAD`. (Catches: deploy command succeeded but didn't actually publish the new artifact.)

2. **Traffic check** — Confirm the new revision is receiving 100% of traffic (or whatever the deploy strategy declares). For platforms with traffic splitting (Container Apps, Cloud Run, k8s): query the active traffic distribution, not just the "latest revision". (Catches: new revision exists but old revision still serves all traffic.)

3. **User-visible asset check** — Run `user_visible_check` from config. This MUST fetch the live URL with a fresh, uncached client and verify users see the new code (the live-bundle-hash-vs-expected comparison snippet + per-framework detection live in `skills/10-deployment-git/application-deployment.md` § deployment-config.md Schema (`user_visible_check`) + § Quick Reference: Bundle Hash Detection By Framework).

   Catches: CDN cache, browser cache headers wrong, service worker stale, traffic split misconfigured, wrong revision activated.

4. **Smoke test** — Run `smoke_test_command` if declared. This is functional verification of the live endpoint, not just asset hash matching.

5. **Cache invalidation** — If the user_visible_check fails on first attempt and cache is suspected, run `cache_invalidation_command` from config (e.g., `aws cloudfront create-invalidation`, `wrangler purge`, etc.) and re-run user_visible_check. If it STILL fails, do NOT mark deploy as complete — investigate routing.

6. **Only after ALL checks pass**: write the deployed commit SHA to `deploy_state_file` from config (typically `deploy/.last-deployed`)

7. **Document**: Update `deploy/deployments/YYYY-MM-DD-HHMMSS.md` with: commit, environment, gates run, all check results (revision/traffic/user-visible/smoke), cache invalidations performed if any.

If `user_visible_check` fails after cache invalidation, deploy is NOT done. See `skills/10-deployment-git/application-deployment.md` § Cache Layers To Check for the L1-L7 troubleshooting flow.

#### Step 5: Document

Add a `DEPLOY` journal entry: what was deployed, smoke test result, any cache invalidations performed.

#### Conformance Walk — structural merge gate (every deploy + CI run)

The Conformance Walk freshness gate + collision ratchet stand as a structural merge gate on every deploy and CI run: no ship with a coverage regression, and no new actionable UNIT that lacks a declared frozen expectation. See `skills/conformance-walk/SKILL.md` § "Phase-action triggers" (deploy).

### Check Mode (`/deploy --check`)

Drift detection only — no deployment side effects. Useful for /wrapup, before commits, or after pulling new changes.

1. Run `deploy_check_command` to get currently-deployed commit
2. Compare to `git rev-parse HEAD`
3. Run `git diff <deployed_commit> HEAD -- <production_paths>` to summarize drift
4. Output a clear status:
   - **`✓ in sync`** — deployed commit matches HEAD
   - **`⚠ drift: N production-touching commits behind`** — list the commits, list the production files changed
   - **`✗ unknown`** — config command failed; explain why

Used by `/wrapup` to detect "committed but not deployed" before allowing session end.

## Critical Rules — see `rules/deploy-hygiene.md`

The hygiene rule loads automatically when production code is touched. Key principles:

- **"Committed" is NOT "done."** Only "live in production" is done for production-touching changes.
- **NEVER** end a session with committed-but-not-deployed production code unless the human explicitly defers
- **NEVER** skip pre-deploy gates without a documented reason
- **ALWAYS** verify deploy state BEFORE committing further production changes (don't pile on top of un-deployed code)
- **ALWAYS** run `/deploy --check` as part of the commit ritual for production-touching changes
- **ALWAYS** update `deploy/.last-deployed` on successful deploy so the check mode works

## Agent Teams

- **release-specialist** — drives onboard mode, runs execute mode, writes deployment runbook
- **security-reviewer** — pre-deploy security audit if any deploy/, secrets, or auth code changed
- **testing-specialist** — verify smoke tests run and pass post-deploy

## Skill References

- `skills/10-deployment-git/application-deployment.md` — onboarding flow + deployment-config.md schema
- `skills/10-deployment-git/deployment-cloud.md` — cloud platform patterns (Container Apps, Cloud Run, Fly, Vercel, k8s)
- `rules/deploy-hygiene.md` — the "committed ≠ deployed" rule
- `.claude/bin/deploy-config.mjs` — the Step-0 ecosystem-relative deploy-target resolver (composes `ecosystem.json::deploy`; fail-closed on unresolvable `${ecosystem.deploy.*}` tokens)
