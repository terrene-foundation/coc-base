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

- `coc-project` → proceed below.
- `coc-source` (loom) → STOP: "this is loom — ingest the upstream streams with `/sync-from-build` + `/sync-from-use`."
- `coc-use-template` → STOP: "this is a USE template — ingest the downstream inbox with `/sync-from-downstream`."
- `coc-build` → STOP: "BUILD repos receive artifacts via `/sync-to-build` run at loom."
- `coc-use-template` / `coc-build` that is NOT the actual template/BUILD repo (basename + `git remote get-url origin` mismatch) → auto-correct VERSION in-place to `coc-project` (per `.claude/hooks/lib/version-utils.js::correctTemplateDerivedVersion`), then proceed below.
- Missing → ask the user what class this repo is.

## Downstream Sync

This is a **merge**, not an overwrite. Pull the latest artifacts from the upstream template and merge them, preserving consumer-OWNED paths. Delegate to `skills/30-claude-code-patterns/sync-flow.md` § Downstream Sync:

1. Resolve the upstream template from `.claude/.coc-sync-marker` (template repo + version).
2. Diff the consumer's managed `.claude/` paths against the template's current artifacts.
3. Merge per the additive semantics: global artifacts refresh from the template; **project-specific artifacts** (`.claude/agents/project/`, `.claude/skills/project/`, and any path the marker declares consumer-owned) MUST NEVER be overwritten.
4. Update `.claude/VERSION` upstream block (template version + `synced_at`).

To offer a COC-artifact improvement back UP to the template, use `/codify` Step-7c (a human-gated PR to the template's `.claude/.proposals/inbox/`) per `artifact-flow.md` § Downstream-Consumer Routing — NOT this command.

## Delegate

- **Downstream Sync** → no delegation (in-place per skill protocol).

## Examples

- `/sync-from-template` — at a downstream consumer project: pull the latest artifacts from the upstream USE template, preserving project-local artifacts
