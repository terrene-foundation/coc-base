---
description: "Pull and merge the latest COC artifacts from the upstream USE template into this consumer repo (preserving project-local artifacts)"
---

Pull the latest CO/COC artifacts from the upstream USE template and merge them INBOUND into this consumer repo, preserving project-specific artifacts. `/sync-from-template` is the downstream-consumer half of the inbound sync family (mirroring loom's `/sync-from-build` + `/sync-from-use` and the template's `/sync-from-downstream`).

```
loom (source) → USE template → THIS REPO
                                   ↑ you are here
```

Detailed protocol: `skills/30-claude-code-patterns/sync-flow.md` § Downstream Sync.

**Usage**: `/sync-from-template` — no target.

## Step 0: Verify Repo Class (this verb is for downstream consumers)

Read `.claude/VERSION` → `type`. `/sync-from-template` is valid at a downstream consumer (`type: coc-project`). This repo inherits its `.claude/` from a USE template (recorded in `.claude/.coc-sync-marker`; auto-detected at first run).

**Evaluate these in order and take the FIRST match — the credibility arms are deliberately ahead of the plain-`type` arms.** A template-derived repo carries `type: coc-use-template` verbatim (it is a byte copy), so a plain-`type` arm placed first would match it and route to `/sync-from-downstream` — the wrong verb, on a declaration this step is about to disbelieve.

- `coc-project` → proceed below.
- `coc-use-template` / `coc-build` whose declaration is NOT credible (`.claude/VERSION::repo` names a different repo than this one's `git remote get-url origin` — the "Use this template" byte-copy case) → **STOP and report**; do NOT proceed on a class you just decided to disbelieve. Correcting it is an EXPLICIT, reviewable edit the operator approves: set `type: coc-project` and populate `upstream.template` / `upstream.template_repo` (`.claude/hooks/lib/version-utils.js::computeTemplateDerivedCorrection` returns the suggested object — it is PURE and writes nothing). Re-run `/sync-from-template` after the edit lands. **NEVER rewrite `.claude/VERSION` silently or as a side effect**: it is the repo-CLASS root of trust (`bin/lib/manifest-source.mjs::readRepoClass` trusts `type` verbatim), which is exactly why `validate-bash-command.js` BLOCKS agent writes to it at the Bash boundary.
- `coc-use-template` / `coc-build` whose declaration is UNDETERMINED (no `.claude/VERSION::repo`, and no legacy-allowlist match) → report the ambiguity and **ask**; do not guess a class and do not re-route on the guess. This is the expected shape of an unstamped byte-copy during the migration window, so it must not fall through to the plain-`type` arm below.
- `coc-source` (loom) → STOP: "this is loom — ingest the upstream streams with `/sync-from-build` + `/sync-from-use`."
- `coc-use-template` (credible) → STOP: "this is a USE template — ingest the downstream inbox with `/sync-from-downstream`."
- `coc-build` (credible) → STOP: "BUILD repos receive artifacts via `/sync-to-build` run at loom."
- Missing → ask the user what class this repo is.

## Downstream Sync

This is a **merge**, not an overwrite. Pull the latest artifacts from the upstream template and merge them, preserving consumer-OWNED paths. Delegate to `skills/30-claude-code-patterns/sync-flow.md` § Downstream Sync:

1. Resolve the upstream template from `.claude/.coc-sync-marker` (template repo + version).
2. Diff the consumer's managed `.claude/` paths against the template's current artifacts.
3. Merge per the additive semantics: global artifacts refresh from the template; **project-specific artifacts** (`.claude/agents/project/`, `.claude/skills/project/`, and any path the marker declares consumer-owned) MUST NEVER be overwritten.
4. **Sync external symlink targets (MUST).** Some `.claude/` entries are symlinks to repo-root EXTERNAL targets — e.g. `.claude/codex-mcp-guard` → `../.codex-mcp-guard`, whose real tree lives at repo-root `.codex-mcp-guard/`. Copying `.claude/` alone carries the symlink but leaves the external target stale → the consuming tool runs against stale content (a dead `extract-policies.mjs` guard). For every symlink declared in the template's `sync-manifest.yaml::multi_cli_overlays.<overlay-type>.symlinks` (overlay-type = `multi-cli` / `cc-only-legacy`), ALSO sync the external target tree AND recreate the link — per `sync-completeness.md` Rule 5. A plain `.claude/`-only copy (rsync, cp -r) is the failure mode this step blocks.
5. **Self-heal this repo's settings.json deny-rule FORM (MUST — additive, never overwrite).** Run the deterministic reconciler on THIS consumer's OWN `.claude/settings.json`:

   ```bash
   node .claude/bin/reconcile-settings-deny.mjs --write .claude/settings.json
   ```

   It rewrites every `permissions.deny` entry of the form `Write(<x>)` / `NotebookEdit(<x>)` to `Edit(<x>)` and collapses `Write(x)`+`Edit(x)`+`NotebookEdit(x)` to one `Edit(x)`. It touches the deny-rule FORM ONLY — it NEVER touches `permissions.allow`, your `hooks[]` (paths included), or any other key, and leaves an already-clean file byte-for-byte unchanged (idempotent). A changed file is re-serialized — values are preserved but formatting of unrelated blocks may normalize (e.g. an inline `hooks` object expands to multi-line); an already-clean file is left byte-for-byte unchanged. This is additive self-healing, not an overwrite: your project-local allow-rules and hook wiring are preserved. **Why:** Claude Code no longer matches `Write(<path>)` / `NotebookEdit(<path>)` deny rules — only `Edit(<path>)` covers file-editing tools; a consumer still carrying the stale form errors on every CC session init AND leaves its guarded state files un-denied. This is the leg that stops the init errors on already-deployed consumers.
6. Update `.claude/VERSION` upstream block (template version + `synced_at`).

To offer a COC-artifact improvement back UP to the template, use `/codify` Step-7c (a human-gated PR to the template's `.claude/.proposals/inbox/`) per `artifact-flow.md` § Downstream-Consumer Routing — NOT this command.

## Delegate

- **Downstream Sync** → no delegation (in-place per skill protocol).

## Examples

- `/sync-from-template` — at a downstream consumer project: pull the latest artifacts from the upstream USE template, preserving project-local artifacts
