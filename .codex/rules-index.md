# Canonical Codex rule discovery

Read applicable canonical rules before changing files or performing their governed operations. Match path scopes, then consult unscoped rules by domain relevance. The installed, trusted native-policy hook can inject matching bodies for typed file operations using the emitted catalog; other operations still require this index (`.claude/hooks/lib/codex-rule-context.js:98-154`).

This complete discovery view is separate from the contracted rules-reference skill; unresolved metadata remains visible and does not pass Validator 18/14. The selected emission profile controls presentation; authoring-only excluded rows are references, not runtime policies. Rule bodies remain canonical source files.

| Canonical rule | Path scopes | Declared delivery |
| --- | --- | --- |
| [adversarial-coverage.md](../.claude/rules/adversarial-coverage.md) | `.claude/commands/redteam.md`, `.claude/commands/vet.md`, `**/04-validate/**`, `**/04-vet/**` | skill-channel |
| [agent-reasoning.md](../.claude/rules/agent-reasoning.md) | `**/kaizen/**`, `**/*agent*`, `**/agents/**`, `**/*classifier*`, `**/*extractor*`, `**/*delegate*`, `**/*router*`, `**/*dispatcher*`, `**/*intent*` | skill-channel |
| [agents.md](../.claude/rules/agents.md) | domain relevance / unscoped | baseline |
| [analyze-output-completeness.md](../.claude/rules/analyze-output-completeness.md) | `**/.claude/commands/analyze.md`, `**/.claude/commands/todos.md`, `**/.claude/commands/implement.md`, `**/.claude/hooks/analyze-completeness-guard.js`, `**/workspaces/**` | skill-channel |
| [artifact-flow.md](../.claude/rules/artifact-flow.md) | `.claude/**`, `sync-manifest.yaml`, `**/VERSION` | skill-channel |
| [artifact-stranding.md](../.claude/rules/artifact-stranding.md) | `**/.claude/rules/**`, `**/.claude/agents/**`, `**/.claude/skills/**`, `**/.claude/commands/**`, `**/.claude/hooks/**`, `**/specs/**`, `**/journal/**`, `**/.session-notes*` | skill-channel |
| [autonomous-execution.md](../.claude/rules/autonomous-execution.md) | domain relevance / unscoped | baseline |
| [burn-down-reporting.md](../.claude/rules/burn-down-reporting.md) | `**/workspaces/**`, `**/.session-notes*`, `**/.session-notes.d/**`, `**/.wave-tracker*`, `**/.wave-tracker.d/**`, `**/todos/**`, `journal/**` | skill-channel |
| [burndown-integrity.md](../.claude/rules/burndown-integrity.md) | `**/workspaces/**`, `**/.session-notes*`, `**/.session-notes.d/**`, `journal/**`, `**/*REGISTER*`, `**/*BURNDOWN*`, `**/burndown/**` | skill-channel |
| [burndown-traceability.md](../.claude/rules/burndown-traceability.md) | `**/burndown/**`, `**/*BURNDOWN*`, `**/*REGISTER*`, `**/.session-notes.shared.md` | skill-channel |
| [ci-cost-discipline.md](../.claude/rules/ci-cost-discipline.md) | `**/todos/**`, `**/.wave-tracker*`, `**/.wave-tracker.d/**`, `**/.github/workflows/**` | skill-channel |
| [ci-job-budget.md](../.claude/rules/ci-job-budget.md) | `.github/workflows/**`, `scripts/ci/**`, `.claude/hooks/ci-job-budget-guard.js`, `.claude/bin/ci-job-budget-audit.mjs`, `.github/job-budget.json`, `.github/scripts/job-budget-audit.py` | skill-channel |
| [ci-runners.md](../.claude/rules/ci-runners.md) | `.github/workflows/**`, `**/ci/**`, `**/.github/**` | skill-channel |
| [command-skill-parity.md](../.claude/rules/command-skill-parity.md) | `.claude/commands/**`, `.claude/skills/**` | skill-channel |
| [communication.md](../.claude/rules/communication.md) | domain relevance / unscoped | baseline |
| [completion-criterion.md](../.claude/rules/completion-criterion.md) | `**/todos/**`, `**/specs/**`, `**/briefs/**`, `**/.session-notes*`, `**/.session-notes.d/**` | skill-channel |
| [conformance-walk.md](../.claude/rules/conformance-walk.md) | `**/tools/conformance/**`, `**/e2e/**`, `**/eval-harness/**`, `**/04-validate/**`, `**/*conformance*`, `**/suites/**`, `scripts/ci/**`, `.github/workflows/**`, `.claude/bin/check-*.mjs`, `.claude/hooks/**`, `.claude/test-harness/**`, `.claude/audit-fixtures/**` | skill-channel |
| [conservation-gate.md](../.claude/rules/conservation-gate.md) | domain relevance / unscoped | baseline |
| [cross-cli-artifact-hygiene.md](../.claude/rules/cross-cli-artifact-hygiene.md) | `workspaces/**/*.md`, `briefs/**/*.md` | skill-channel |
| [deferral-registry-locality.md](../.claude/rules/deferral-registry-locality.md) | `.claude/rules/project/**`, `.claude/agents/project/**`, `.claude/commands/project/**`, `.claude/skills/project/**`, `**/deferrals.json`, `**/phase2-deferrals.json` | skill-channel |
| [dependencies.md](../.claude/rules/dependencies.md) | `pyproject.toml`, `Cargo.toml`, `package.json`, `**/*.py`, `**/*.rs`, `**/*.ts`, `**/*.tsx`, `**/*.js`, `**/*.jsx` | skill-channel |
| [deploy-hygiene.md](../.claude/rules/deploy-hygiene.md) | `**/Dockerfile`, `**/*.dockerfile`, `deploy/**`, `**/k8s/**`, `**/kubernetes/**`, `**/helm/**`, `**/.github/workflows/**`, `**/fly.toml`, `**/vercel.json`, `**/app.yaml`, `**/serverless.yml`, `**/wrangler.toml`, `**/Procfile`, `**/next.config.*`, `**/vite.config.*`, `**/package.json`, `deploy/deployment-config.md` | skill-channel |
| [deployment.md](../.claude/rules/deployment.md) | `deploy/**`, `.github/**`, `pyproject.toml`, `CHANGELOG.md` | skill-channel |
| [e2e-god-mode.md](../.claude/rules/e2e-god-mode.md) | `tests/e2e/**`, `**/*e2e*`, `**/*playwright*` | skill-channel |
| [enrollment-operations.md](../.claude/rules/enrollment-operations.md) | `.claude/operators.roster.json`, `.claude/commands/enroll.md`, `.claude/commands/whoami.md`, `.claude/commands/ecosystem-init.md`, `.claude/commands/onboard.md` | skill-channel |
| [env-models.md](../.claude/rules/env-models.md) | `**/*.py`, `**/*.ts`, `**/*.js`, `**/*.rs`, `**/*.rb`, `.env*` | skill-channel |
| [evidence-first-claims.md](../.claude/rules/evidence-first-claims.md) | domain relevance / unscoped | baseline |
| [facade-manager-detection.md](../.claude/rules/facade-manager-detection.md) | `packages/**`, `src/**`, `**/tests/**` | skill-channel |
| [git.md](../.claude/rules/git.md) | domain relevance / unscoped | baseline |
| [governed-throughput.md](../.claude/rules/governed-throughput.md) | `.claude/agents/**`, `.claude/commands/**`, `.claude/skills/**`, `**/*worktree*`, `**/workspaces/**` | skill-channel |
| [handoff-completion.md](../.claude/rules/handoff-completion.md) | `.claude/rules/**`, `.claude/commands/**`, `**/.session-notes*`, `journal/**` | skill-channel |
| [hook-event-selection.md](../.claude/rules/hook-event-selection.md) | `**/.claude/hooks/**`, `**/.claude/variants/**/hooks/**`, `**/.claude/settings.json` | skill-channel |
| [hook-output-discipline.md](../.claude/rules/hook-output-discipline.md) | `**/.claude/hooks/**`, `**/.claude/variants/**/hooks/**`, `**/.claude/test-harness/**` | skill-channel |
| [instrument-bipolarity.md](../.claude/rules/instrument-bipolarity.md) | `**/.claude/bin/**`, `**/.claude/hooks/**`, `**/.claude/audit-fixtures/**`, `**/.claude/test-harness/**`, `**/.github/workflows/**`, `**/tests/**`, `**/*.test.*`, `**/*_test.*`, `**/test_*.py` | skill-channel |
| [instrument-discipline.md](../.claude/rules/instrument-discipline.md) | domain relevance / unscoped | baseline |
| [issue-triage-routing.md](../.claude/rules/issue-triage-routing.md) | domain relevance / unscoped | baseline |
| [journal-author-discipline.md](../.claude/rules/journal-author-discipline.md) | `**/journal/**` | skill-channel |
| [journal.md](../.claude/rules/journal.md) | `**/journal/**` | skill-channel |
| [knowledge-cascade-routing.md](../.claude/rules/knowledge-cascade-routing.md) | `**/MEMORY.md`, `**/memory/**/*.md`, `journal/**`, `**/.session-notes*`, `.claude/rules/**`, `.claude/.proposals/**` | skill-channel |
| [knowledge-convergence.md](../.claude/rules/knowledge-convergence.md) | `.claude/team-memory/**`, `.claude/learning/**`, `**/journal/**`, `.claude/commands/codify.md`, `.session-notes*`, `.session-notes.d/**`, `.claude/.proposals/**` | skill-channel |
| [multi-operator-coordination.md](../.claude/rules/multi-operator-coordination.md) | `**/*` | skill-channel |
| [observability.md](../.claude/rules/observability.md) | `**/*.py`, `**/*.rs`, `**/*.ts`, `**/*.tsx`, `**/*.js`, `**/*.jsx` | skill-channel |
| [orchestration-launch-ledger.md](../.claude/rules/orchestration-launch-ledger.md) | `**/workspaces/**`, `**/.session-notes*`, `journal/**` | skill-channel |
| [orchestrator-context-economy.md](../.claude/rules/orchestrator-context-economy.md) | `.claude/agents/**`, `**/.claude/agents/**`, `**/.claude/hooks/**`, `**/.claude/settings.json` | skill-channel |
| [orphan-detection.md](../.claude/rules/orphan-detection.md) | `packages/**`, `src/**`, `**/tests/**`, `crates/**`, `**/src/**` | skill-channel |
| [probe-driven-verification.md](../.claude/rules/probe-driven-verification.md) | `**/test-harness/**`, `**/audit-fixtures/**`, `.claude/hooks/**`, `tests/**`, `**/*test*`, `**/*spec*`, `**/04-validate/**`, `**/suites/**` | skill-channel |
| [product-completion-first.md](../.claude/rules/product-completion-first.md) | `.claude/commands/**`, `.claude/rules/**` | skill-channel |
| [proposal-intake-trust.md](../.claude/rules/proposal-intake-trust.md) | `**/.proposals/**` | skill-channel |
| [python-environment.md](../.claude/rules/python-environment.md) | `**/*.py`, `pyproject.toml`, `conftest.py`, `tests/**` | skill-channel |
| [recommendation-quality.md](../.claude/rules/recommendation-quality.md) | `.claude/commands/**`, `workspaces/**`, `**/*.md`, `briefs/**`, `todos/**`, `journal/**` | skill-channel |
| [refactor-invariants.md](../.claude/rules/refactor-invariants.md) | `**/*.py`, `packages/**` | skill-channel |
| [repo-scope-discipline.md](../.claude/rules/repo-scope-discipline.md) | domain relevance / unscoped | baseline |
| [rule-authoring.md](../.claude/rules/rule-authoring.md) | `**/.claude/rules/**`, `**/.claude/variants/**/rules/**` | skill-channel |
| [schema-migration.md](../.claude/rules/schema-migration.md) | `**/migrations/**`, `**/db/**`, `**/*.sql`, `**/models.py`, `**/schema.py`, `**/dataflow/**`, `**/*.py`, `**/*.rb` | skill-channel |
| [script-tool-manifest-sanity.md](../.claude/rules/script-tool-manifest-sanity.md) | `**/package.json`, `**/pyproject.toml`, `**/Cargo.toml` | skill-channel |
| [security.md](../.claude/rules/security.md) | domain relevance / unscoped | baseline |
| [self-referential-codify.md](../.claude/rules/self-referential-codify.md) | `.claude/commands/**`, `.claude/rules/**`, `.claude/skills/**`, `.claude/hooks/**`, `.claude/bin/**`, `.claude/guides/rule-extracts/**`, `.claude/agents/management/**`, `.claude/audit-fixtures/**`, `.claude/test-harness/tests/**`, `.claude/test-harness/lib/**`, `.claude/sync-manifest.yaml`, `.claude/operators.roster.schema.json`, `.claude/disclosure-tenant-denylist.json`, `.claude/disclosure-benign-collisions.json`, `.claude/codex-mcp-guard/**`, `tools/verify-overlays.sh`, `scripts/publish-to-public.mjs`, `scripts/publish-to-private-template.mjs` | skill-channel |
| [session-notes-continuity.md](../.claude/rules/session-notes-continuity.md) | `**/.session-notes*`, `**/.session-notes.d/**` | skill-channel |
| [spec-accuracy.md](../.claude/rules/spec-accuracy.md) | `**/specs/**`, `**/specs/_index.md`, `**/workspaces/**/specs/**`, `**/02-plans/**`, `**/briefs/**`, `**/README*.md`, `**/docs/**`, `**/skills/**/*.md` | skill-channel |
| [specs-authority.md](../.claude/rules/specs-authority.md) | `**/specs/**`, `**/workspaces/**`, `**/briefs/**`, `**/02-plans/**`, `**/todos/**` | skill-channel |
| [stack-detection.md](../.claude/rules/stack-detection.md) | `**/STACK.md`, `**/.claude/agents/onboarding/**`, `**/.claude/commands/onboard-stack.md`, `**/.claude/skills/40-stack-onboarding/**` | skill-channel |
| [state-file-write-guard.md](../.claude/rules/state-file-write-guard.md) | `deploy/**`, `**/.last-deployed-*`, `**/.last-smoke-result-*`, `**/.last-interactions-smoke-result-*`, `**/state-file-write-guard.*`, `**/validate-state-file.*`, `**/post-deploy-smoke.*` | skill-channel |
| [state-regression-integrity.md](../.claude/rules/state-regression-integrity.md) | `**/*REGISTER*`, `**/*BURNDOWN*`, `**/burndown/**` | skill-channel |
| [sweep-completeness.md](../.claude/rules/sweep-completeness.md) | `.claude/commands/sweep.md`, `.claude/commands/redteam.md`, `.claude/commands/codify.md`, `.claude/commands/wrapup.md`, `.claude/commands/cc-audit.md`, `.claude/commands/cli-audit.md`, `.claude/commands/i-audit.md`, `.claude/commands/i-harden.md`, `.claude/commands/i-polish.md`, `.claude/skills/sweep/**`, `.claude/skills/spec-compliance/**`, `**/redteam-*.md`, `**/sweep-*.md`, `**/04-validate/**` | skill-channel |
| [symbol-anchored-citations.md](../.claude/rules/symbol-anchored-citations.md) | `**/specs/**`, `**/workspaces/**/specs/**`, `**/02-plans/**`, `**/01-analysis/**`, `**/briefs/**`, `**/todos/**`, `**/journal/**` | skill-channel |
| [testing.md](../.claude/rules/testing.md) | `tests/**`, `**/*test*`, `**/*spec*`, `conftest.py`, `**/.spec-coverage*`, `**/.test-results*`, `**/02-plans/**`, `**/04-validate/**`, `crates/**` | skill-channel |
| [time-pressure-discipline.md](../.claude/rules/time-pressure-discipline.md) | `**/workspaces/**`, `**/.claude/commands/**`, `**/.claude/agents/**`, `**/.session-notes`, `**/journal/**` | skill-channel |
| [trust-posture.md](../.claude/rules/trust-posture.md) | `**/.claude/rules/**`, `**/.claude/hooks/**`, `**/.claude/commands/**`, `**/.claude/learning/**`, `**/.claude/settings.json`, `**/.claude/sync-manifest.yaml` | skill-channel |
| [type-relaxation-sweep.md](../.claude/rules/type-relaxation-sweep.md) | `**/*.ts`, `**/*.tsx`, `**/*.py`, `**/*.rs` | skill-channel |
| [ui-backend-defense.md](../.claude/rules/ui-backend-defense.md) | `**/routes/**`, `**/handlers/**`, `**/api/**`, `**/*_endpoint*`, `**/*_handler*`, `**/*_route*` | skill-channel |
| [upstream-issue-hygiene.md](../.claude/rules/upstream-issue-hygiene.md) | `**/.github/**`, `**/CONTRIBUTING.md`, `**/SECURITY.md`, `**/.session-notes`, `**/journal/**`, `**/workspaces/**` | skill-channel |
| [user-flow-validation.md](../.claude/rules/user-flow-validation.md) | `.claude/**`, `**/.claude/**`, `specs/**`, `**/specs/**`, `briefs/**`, `**/briefs/**`, `todos/**`, `**/todos/**`, `**/.session-notes*`, `src/**`, `**/src/**`, `packages/**`, `crates/**`, `tests/**`, `**/tests/**`, `scripts/**`, `tools/**` | skill-channel |
| [value-prioritization.md](../.claude/rules/value-prioritization.md) | `**/workspaces/**`, `**/journal/**`, `**/.session-notes`, `**/.claude/commands/**`, `**/SWEEP*.md`, `**/WORKSPACE-DISPOSITION*.md`, `**/CHANGELOG*.md` | skill-channel |
| [verification-gate-integrity.md](../.claude/rules/verification-gate-integrity.md) | `.github/workflows/**`, `.github/actions/**`, `scripts/ci/**`, `tools/**`, `.claude/audit-fixtures/**`, `**/tests/**`, `**/*test*`, `.claude/bin/**`, `.claude/hooks/**` | skill-channel |
| [verify-claims-before-write.md](../.claude/rules/verify-claims-before-write.md) | `**/*.md`, `**/CHANGELOG*`, `**/.session-notes`, `**/journal/**` | skill-channel |
| [verify-resource-existence.md](../.claude/rules/verify-resource-existence.md) | `**/*.py`, `**/*.rs`, `**/*.mjs`, `**/*.js`, `**/*.sh`, `**/workspaces/**`, `.claude/{commands,skills}/**` | skill-channel |
| [wave-loop.md](../.claude/rules/wave-loop.md) | `**/workspaces/**`, `**/todos/**`, `**/.claude/commands/**`, `**/02-plans/**` | skill-channel |
| [wip-discipline.md](../.claude/rules/wip-discipline.md) | `**/workspaces/**`, `**/.session-notes*`, `**/.session-notes.d/**`, `.claude/hooks/**`, `.claude/bin/**` | skill-channel |
| [worktree-isolation.md](../.claude/rules/worktree-isolation.md) | `.claude/agents/**`, `.claude/commands/**`, `.claude/skills/**`, `**/*worktree*` | skill-channel |
| [zero-tolerance.md](../.claude/rules/zero-tolerance.md) | domain relevance / unscoped | baseline |
