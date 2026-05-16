---
name: multi-cli-migration
description: "Detailed protocol for /migrate (claude-only USE template → multi-CLI USE template). Reference for in-place migration logic, modes, verification table, marker schema, cross-CLI artifact contract."
---

# Multi-CLI Migration Reference

`/migrate` is loom's downstream-side counterpart to `/sync`. It runs in a project repo whose `.claude/.coc-sync-marker` declares either a claude-only USE template lineage (`kailash-coc-claude-{py,rs,rb}` — full migration) or a multi-CLI lineage (`kailash-coc-{py,rs}` — `--refresh` mode), and ensures the project's per-CLI surfaces stay current with the sister template at loom.

This document is loaded at `/migrate` time. It is the source of truth for the protocol; the command body (`commands/migrate.md`) is the entry point only.

## Modes

| Mode           | Trigger                                     | Steps run                                                                             | Commit message                                                     |
| -------------- | ------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Full migration | `cc-only-legacy` lineage                    | 0–12                                                                                  | `chore(coc): migrate to multi-CLI template (claude+codex+gemini)`  |
| `--dry-run`    | Any lineage                                 | 0 detection only; print all planned actions; apply nothing                            | (no commit)                                                        |
| `--refresh`    | `multi-cli` lineage                         | 0.1 lineage check, 3 (overlay re-pull), 6 (re-emit), 8 (timestamp+stats), 10 (verify) | `chore(coc): refresh multi-CLI overlays`                           |
| `--emit-only`  | Non-COC lineage (e.g. `claude-squad-local`) | 0.1 (non-COC accept), 1, 4a (scaffold), 6, 8 (emit-only marker), 10, 11, 12           | `chore(coc): emit multi-CLI artifacts from project's own .claude/` |
| `--rollback`   | Migration branch active                     | Inline porcelain guard, `git reset --keep main`, restore `.pre-migrate.bak`           | (no commit; branch deleted)                                        |

## Cross-CLI Project Artifact Contract

The migration is safe-by-construction because project artifacts are CLI-neutral by template design. Every Kailash-COC USE template — claude-only or multi-CLI — uses the same paths for project-owned content:

| Artifact path                      | Owned by   | All 3 CLIs read it?                                                    |
| ---------------------------------- | ---------- | ---------------------------------------------------------------------- |
| `workspaces/<workstream>/`         | project    | yes (CC commands, Codex prompts, Gemini commands all target this path) |
| `workspaces/<workstream>/journal/` | project    | yes                                                                    |
| `workspaces/<workstream>/briefs/`  | project    | yes                                                                    |
| `workspaces/<workstream>/todos/`   | project    | yes                                                                    |
| `.session-notes` (gitignored)      | local-only | yes (SessionStart hooks)                                               |
| `src/`, `tests/`, `docs/`          | project    | yes (no CLI awareness)                                                 |
| `.env`, `.env.example`             | project    | yes                                                                    |
| `pyproject.toml` / `Cargo.toml`    | project    | yes                                                                    |

What IS per-CLI:

| Path                | Owned by               | Purpose                                                          |
| ------------------- | ---------------------- | ---------------------------------------------------------------- |
| `.claude/`          | template               | Claude Code config tree (commands, skills, agents, hooks, bin/)  |
| `.codex/`           | template               | Codex config tree (prompts, skills, hooks.json, config.toml)     |
| `.gemini/`          | template               | Gemini config tree (commands, skills, agents, settings.json)     |
| `.codex-mcp-guard/` | template               | MCP guard server (consumed by Codex AND Gemini)                  |
| `CLAUDE.md` (root)  | project (post-migrate) | CC baseline at session start                                     |
| `AGENTS.md` (root)  | template               | Codex baseline (emitted by `.claude/bin/emit.mjs --cli codex`)   |
| `GEMINI.md` (root)  | template               | Gemini baseline (emitted by `.claude/bin/emit.mjs --cli gemini`) |

Migration touches ONLY the per-CLI rows. The project-artifact rows are untouched by construction.

### Cross-CLI artifact emission contract

| Source                                      | Emitted to                                                              | Emitter                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| `.claude/rules/*.md` (CRIT baseline)        | `AGENTS.md`, `GEMINI.md`                                                | `node .claude/bin/emit.mjs --cli {codex,gemini}`             |
| `.claude/commands/<name>.md`                | `.codex/prompts/<name>.md`, `.gemini/commands/<name>.toml`              | `node .claude/bin/emit-cli-artifacts.mjs --target <variant>` |
| `.claude/skills/<nn-name>/SKILL.md`         | `.codex/skills/<nn-name>/SKILL.md`, `.gemini/skills/<nn-name>/SKILL.md` | same                                                         |
| `.claude/agents/**/<name>.md` (specialists) | `.gemini/agents/<name>.md`                                              | same                                                         |
| `.claude/hooks/**/*.js`                     | (consumed in-place by all three CLIs)                                   | (no emission — env-var portability handles dispatch)         |

Body content is byte-identical across CLI emissions modulo delegation-syntax slot overrides — verified by `cli-audit` cross-CLI drift sweep. Every path the body references resolves the same way under any CLI.

## Manifest source-of-truth

`.claude/sync-manifest.yaml::multi_cli_overlays:` declares the refresh set for multi-CLI consumers:

```yaml
multi_cli_overlays:
  multi-cli:
    paths:
      - .codex/**
      - .codex-mcp-guard/**
      - .gemini/**
      - AGENTS.md
      - GEMINI.md
    preserved:
      - .codex/local-config.toml
      - .gemini/local-settings.json
  cc-only-legacy:
    paths: []
    preserved: []
```

`/migrate` reads `paths:` for overlay copies (Steps 3 + `--refresh`); honors `preserved:` so consumer customizations survive.

## Migration Protocol

### Step 0 — Pre-flight

1. Parse `.claude/.coc-sync-marker`. Branch by `template_type`:
   - `cc-only-legacy` → full migration. Variant from `variant:`.
   - `multi-cli` → `--refresh` only; otherwise exit "already migrated".
   - Missing/unrecognized → exit "not a recognized USE-template lineage".
2. Map variant → multi-CLI sister:
   - `py` → `kailash-coc-py`
   - `rs` → `kailash-coc-rs`
   - `rb` → no sister exists. Run `gh issue create --title "Multi-CLI sister template for kailash-coc-claude-rb" --body "Project at $(git remote get-url origin) requests a multi-CLI Ruby USE template. Currently rb consumers cannot migrate (no sister)."` against the loom repo (orchestration root). Exit.
3. Verify clean working tree inline (do NOT just cite `rules/git.md`):
   ```bash
   [ -z "$(git status --porcelain)" ] || {
     echo "uncommitted work — recommend: git stash push -u -m pre-migrate (preserves untracked); commit alternative leaves migration mixed with prior work";
     exit 1;
   }
   ```
4. Resolve sister template path. Reuse `/sync` resolution chain (`commands/sync.md` Downstream Sync step 1):
   ```bash
   SISTER=$(node .claude/bin/resolve-template.js --template kailash-coc-${VARIANT})
   # Else inline: env KAILASH_COC_TEMPLATE_PATH → ~/.cache/kailash-coc/<sister>/ → git clone --depth 1 → offline-fallback ~/repos/loom/<sister>/
   ```
5. Branch-name collision handling (same-day idempotency):
   ```bash
   TS=$(date -u +%Y%m%dT%H%M%SZ)
   BRANCH="chore/coc-multi-cli-migrate-${TS}"
   git rev-parse --verify "$BRANCH" 2>/dev/null && BRANCH="${BRANCH}-$$"  # PID suffix on collision
   ```

### Step 1 — Branch + snapshot

```bash
git checkout -b "$BRANCH"
mkdir -p .pre-migrate.bak
cp .claude/.coc-sync-marker .pre-migrate.bak/.coc-sync-marker
[ -f CLAUDE.md ]       && cp CLAUDE.md       .pre-migrate.bak/CLAUDE.md
[ -f .claude/VERSION ] && cp .claude/VERSION .pre-migrate.bak/VERSION
[ -d .codex ]          && cp -R .codex       .pre-migrate.bak/.codex 2>/dev/null  # if a partial migration ran
[ -d .gemini ]         && cp -R .gemini      .pre-migrate.bak/.gemini 2>/dev/null
echo "$BRANCH" > .pre-migrate.bak/.branch
```

The `.pre-migrate.bak/` directory is preserved post-migration for one inspection cycle. User deletes manually after verification.

### Step 2 — VERSION update FIRST (load-bearing ordering)

Update `.claude/VERSION` BEFORE `.claude/` refresh. Step 4 calls `node .claude/bin/resolve-template.js` again (transitively, via downstream-sync semantics), and the resolver MUST target the multi-CLI sister, not the CC-only template the project came from. Reversing Steps 2 and 4 means Step 4 pulls from the wrong sister.

Fields updated:

- `upstream.template` ← `kailash-coc-<variant>`
- `upstream.template_repo` ← `terrene-foundation/kailash-coc-<variant>`
- `upstream.template_version` ← read from sister `.claude/VERSION`
- `upstream.synced_at` ← now (ISO-8601)
- Preserve `type: coc-project`, all other fields

### Step 3 — Top-level multi-CLI overlay copy

Copy paths declared in `multi_cli_overlays.multi-cli.paths` from sister → project. Cleanup stranded root `.coc-sync-marker` (legacy artifact at repo root from pre-v2.21 templates):

```bash
cp -R "$SISTER/.codex"           ./.codex
cp -R "$SISTER/.codex-mcp-guard" ./.codex-mcp-guard
cp -R "$SISTER/.gemini"          ./.gemini
cp    "$SISTER/AGENTS.md"        ./AGENTS.md
cp    "$SISTER/GEMINI.md"        ./GEMINI.md
[ -f .coc-sync-marker ] && rm .coc-sync-marker  # legacy root sentinel; canonical is .claude/.coc-sync-marker
```

For `--refresh`: respect `multi_cli_overlays.multi-cli.preserved` — files in that list are NOT overwritten even if present in the sister.

### Step 4 — `.claude/` refresh via downstream-sync

Run downstream-sync semantics against the sister (per `skills/30-claude-code-patterns/sync-flow.md` § Downstream Sync, steps 2–8). This:

- Reads sister's `.claude/.coc-obsoleted` and purges any matching paths in the project (per Rule 4 of `rules/cross-repo.md`).
- Diffs sister `.claude/` against project `.claude/`.
- Overwrites template-owned files with sister versions (commands, skills, agents, hooks, rules — globals + variant overlay for the project's variant axis).
- Preserves project-owned files: `.claude/settings.local.json`, `.claude/.proposals/`, `.claude/learning/`.
- Multi-CLI sister adds binaries the CC-only template lacked: `.claude/bin/emit.mjs`, `.claude/bin/emit-cli-artifacts.mjs`, `.claude/bin/compose.mjs`. Picked up here.
- Normalizes `settings.json` hook paths from `$CLAUDE_PROJECT_DIR/scripts/hooks/` → `$CLAUDE_PROJECT_DIR/.claude/hooks/` (legacy v2.8.x pattern).

### Step 5 — CLAUDE.md 3-way reconciliation

CLAUDE.md is template-owned at the CC-only template; the multi-CLI variant differs (per-CLI baseline table, Regeneration section). Three branches:

1. **Empty diff** (project CLAUDE.md byte-equals CC-only template's CLAUDE.md) → replace with multi-CLI sister's CLAUDE.md.
2. **Already-multi-CLI** (project CLAUDE.md byte-equals multi-CLI sister's CLAUDE.md) → keep as-is (idempotent re-run case).
3. **Local edits present** (diffs against both) → emit a 3-way merge plan AND a recommendation per `rules/recommendation-quality.md` MUST-1:
   - **Recommend** auto-merge IF project edits land outside the sections the multi-CLI variant rewrites (per-CLI baseline table, Regeneration section, Workspace Commands table). Implications: project edits preserved, multi-CLI scaffolding gained, ~30s automated.
   - **Recommend** human review IF any conflict overlaps load-bearing sections. Implications: ~5–10 min adjudication, prevents silently dropping multi-CLI guidance the user will need.
   - Cons of recommended option spelled out (per Rule 3 of recommendation-quality.md).

### Step 6 — Regenerate per-CLI emissions

Closes variant-overlay-drift (the gap PR #52 left open). Sister installed `.claude/bin/emit.mjs` + `emit-cli-artifacts.mjs` at Step 4; now run them so the project's `.claude/rules/`, `.claude/commands/`, `.claude/skills/`, `.claude/agents/` propagate to the per-CLI surfaces with variant overlays applied:

```bash
# Per-CLI commands + skills + Gemini agents — variant-overlay-aware (Loom-A composeArtifactBody)
node .claude/bin/emit-cli-artifacts.mjs --target ${VARIANT} --out .

# Per-CLI baselines — emitted from project's own .claude/rules/ (CRIT-tier rules)
node .claude/bin/emit.mjs --cli codex
node .claude/bin/emit.mjs --cli gemini
```

`.codex-mcp-guard/policies.json` population: if missing/empty, Loom-B's emission path runs `node .codex-mcp-guard/extract-policies.mjs` to populate from `.claude/hooks/`. Sister-side emission writes `policies.json` metadata; the live `POLICIES_POPULATED=true` flip stays deferred until predicate runtime ships (per `.claude/bin/emit-cli-artifacts.mjs` deferred-section). Currently fail-closed by design (`rules/zero-tolerance.md` Rule 2).

### Step 7 — Refresh `.github/`

Multi-CLI templates ship multi-CLI-aware CI workflows. Replace project's `.github/workflows/{auto-merge,validate}.yml` and `.github/coc-sdk-refs-allowlist.txt` with sister versions. Preserve project-only workflow files untouched.

```bash
[ -d "$SISTER/.github/workflows" ] && {
  for f in auto-merge.yml validate.yml; do
    [ -f "$SISTER/.github/workflows/$f" ] && cp "$SISTER/.github/workflows/$f" .github/workflows/
  done
}
[ -f "$SISTER/.github/coc-sdk-refs-allowlist.txt" ] && cp "$SISTER/.github/coc-sdk-refs-allowlist.txt" .github/
```

### Step 8 — Update sync marker (full schema)

Write `.claude/.coc-sync-marker` per the full canonical multi-CLI shape (see § Marker Schema below for every required field). Populate `migrated_from: kailash-coc-claude-<variant>` and `migrated_at: <ISO-8601 now>` for full migrations; preserve them on `--refresh`.

### Step 9 — Project-artifact lint

Surface CC-native syntax leaks in workspaces/journals/briefs/todos/.session-notes per `rules/cross-cli-artifact-hygiene.md`:

```bash
node tools/lint-workspaces.js workspaces/ .session-notes 2>/dev/null || true   # advisory
```

If `tools/lint-workspaces.js` is absent (project predates v2.23.x), inline the regex set from `workspaces/multi-cli-coc/fixtures/slot-markers/emitter.mjs:279-301`:

- `Agent\([^)]*subagent_type` (CC delegation)
- `Agent\([^)]*run_in_background`
- `\bTaskCreate\b` / `\bTaskUpdate\b` / `\bExitPlanMode\b` (CC tool names)
- `\b(Read|Write|Edit|Bash|Grep|Glob)\s+tool\b` (CC tool nouns)
- `\b(SessionStart|SessionEnd|PreToolUse|PostToolUse|UserPromptSubmit|PreCompact)\b` (CC hook events)
- `\.claude\/(agents|skills|commands)\b` / `\bCLAUDE\.md\b` / `\bAGENTS\.md\b` / `\bGEMINI\.md\b` (CLI baseline paths)

Findings are advisory — surfaced for the user to decide. Migration does NOT auto-rewrite project-owned content.

### Step 10 — Verification table (15+ checks)

Per `rules/sync-completeness.md` Rule 2, MUST emit a per-template-axis verification table. Any ✗ row halts:

```text
| #  | check                                                          | result | notes                          |
| -- | -------------------------------------------------------------- | ------ | ------------------------------ |
|  1 | CLAUDE.md present                                              | ✓/✗    | reconciled at Step 5           |
|  2 | AGENTS.md present                                              | ✓/✗    | re-emitted at Step 6           |
|  3 | GEMINI.md present                                              | ✓/✗    | re-emitted at Step 6           |
|  4 | .claude/ present                                               | ✓/✗    | refreshed at Step 4            |
|  5 | .codex/ present                                                | ✓/✗    | copied at Step 3               |
|  6 | .gemini/ present                                               | ✓/✗    | copied at Step 3               |
|  7 | .codex-mcp-guard/ present                                      | ✓/✗    | copied at Step 3               |
|  8 | .claude/bin/emit.mjs --cli codex --dry-run exit 0              | ✓/✗    | regression of Step 6           |
|  9 | .claude/bin/emit.mjs --cli gemini --dry-run exit 0             | ✓/✗    | regression of Step 6           |
| 10 | .claude/.coc-sync-marker template_type == "multi-cli"          | ✓/✗    | Step 8 schema check            |
| 11 | .claude/.coc-sync-marker clis == ["claude","codex","gemini"]   | ✓/✗    | Step 8 schema check            |
| 12 | .claude/.coc-sync-marker stats.baselines_emitted populated     | ✓/✗    | Step 8 schema check            |
| 13 | .claude/.coc-sync-marker stats.cli_artifacts populated         | ✓/✗    | Step 8 schema check            |
| 14 | .claude/VERSION upstream.template == kailash-coc-<variant>     | ✓/✗    | Step 2                         |
| 15 | .claude/VERSION upstream.template_version matches sister       | ✓/✗    | Step 2                         |
| 16 | git diff main -- workspaces/ src/ tests/ docs/ pyproject.toml empty | ✓/✗    | project content untouched      |
| 17 | grep -rF 'scripts/hooks' .claude/settings.json returns nothing | ✓/✗    | hook-path normalization Step 4 |
| 18 | .codex/config.toml present                                     | ✓/✗    | overlay copy completeness      |
| 19 | .gemini/settings.json present                                  | ✓/✗    | overlay copy completeness      |
| 20 | tools/lint-workspaces.js advisory findings (count surfaced)    | (n)    | Step 9 advisory                |
```

Single-row "✓ migrated" claims are BLOCKED per `rules/sync-completeness.md` Rule 2.

### Step 11 — Trust-posture caveat

Emit banner to user:

> Trust posture is per-CLI today. `posture show` on Claude Code reads `.claude/learning/posture.json` per `rules/trust-posture.md` MUST Rule 1. Codex and Gemini have no posture surface yet — their sessions run at default trust until cross-CLI posture sync ships. Plan accordingly when running mutating commands from Codex/Gemini.

This is informational; no action required.

### Step 12 — Commit + PR

Commit message MUST cite source/target template + version, files added (`.codex/`, `.codex-mcp-guard/`, `.gemini/`, `AGENTS.md`, `GEMINI.md`), files replaced (`CLAUDE.md` per Step 5), files updated (`.claude/.coc-sync-marker`, `.claude/VERSION`, `.github/workflows/{auto-merge,validate}.yml`, `.github/coc-sdk-refs-allowlist.txt`), files re-emitted (Step 6 per-CLI artifacts), files preserved (`workspaces/`, project source, SDK pins, `.claude/.proposals/`, `.claude/learning/`, `.claude/settings.local.json`), AND verification-table summary (`20/20 ✓`).

Stage explicit paths only (per `rules/coc-sync-landing.md` Rule 2 — `git add -A` BLOCKED on COC-shaped PRs):

```bash
git add .claude/ .codex/ .codex-mcp-guard/ .gemini/ AGENTS.md GEMINI.md CLAUDE.md \
        .github/workflows/auto-merge.yml .github/workflows/validate.yml \
        .github/coc-sdk-refs-allowlist.txt
git commit -F /tmp/migrate-msg.txt
gh pr create --title "chore(coc): migrate to multi-CLI" --body-file /tmp/migrate-pr-body.md
```

PR body MUST include the verification table from Step 10.

## `--refresh` mode (multi-CLI consumer re-pull)

Triggered when `template_type: multi-cli`. Refreshes top-level overlays per `multi_cli_overlays.multi-cli.paths` (NOT a full migration; project is already multi-CLI):

1. Step 0: lineage check (must be `multi-cli`); inline porcelain guard.
2. Step 3: copy paths from `multi_cli_overlays.multi-cli.paths`, respecting `multi_cli_overlays.multi-cli.preserved`.
3. Step 6: re-emit per-CLI artifacts + baselines.
4. Step 8: update marker `timestamp`, `loom_sha`, `loom_version`, `stats.baselines_emitted`, `stats.cli_artifacts`. Do NOT touch `template_type`, `migrated_from`, `migrated_at`, `clis`.
5. Step 10: verification table (rows 1–9, 17–19 — schema fields already canonical).
6. Step 12: commit `chore(coc): refresh multi-CLI overlays`.

Skipped: Steps 2 (VERSION upstream pointer already correct), 4 (downstream-sync handles `.claude/` refresh on next `/sync` — `--refresh` is overlay-only), 5 (CLAUDE.md project-owned post-migration), 7 (workflows already aligned), 11 (posture caveat already known to multi-CLI users).

## `--emit-only` mode (non-COC lineage)

Triggered for projects whose `.claude/VERSION.type` is NOT `cc-only-legacy` or `multi-cli` — typically `claude-squad-local` or any future non-COC fork that wants per-CLI artifacts emitted from its OWN `.claude/` source WITHOUT pulling sister-template content. The originating case is csq (`terrene-foundation/csq`, type=`claude-squad-local`): csq forked from kailash-coc-claude-py and pruned Kailash content; its `csq-loom-boundary.md` rule explicitly forbids template re-pulls; but csq still needs `.codex/`, `.gemini/`, `AGENTS.md`, `GEMINI.md` emitted from its own pruned `.claude/` so Codex and Gemini sessions against csq have a scaffold to load.

The mode runs only the EMIT phase. Sister-template-dependent steps (3, 4, 5, 7) are skipped. The project's existing `.claude/` is the source of truth.

### Steps

1. **Step 0.1 — non-COC accept**: `--emit-only` bypasses the default "unrecognized lineage" rejection. The recognized non-COC types are `claude-squad-local` plus any project lineage that has a `.claude/` directory AND declares its type explicitly in `.claude/VERSION.type`. The flag MUST be set explicitly — `/migrate` without `--emit-only` on a non-COC type still rejects per the original Step 0 contract (no silent acceptance).
2. **Step 1 — branch + snapshot**: same as full migration. Branch name: `chore/coc-multi-cli-emit-<YYYYMMDD>` (different prefix from `chore/coc-multi-cli-migrate-` to distinguish in `git log`).
3. **Step 4a — scaffold the emitter dependencies**: same as full migration. Create `.claude/codex-mcp-guard → ../.codex-mcp-guard` symlink and copy `$LOOM_PATH/.claude/sync-manifest.yaml` into `.claude/`. The symlink + manifest are scaffold artifacts the emitters require; they do NOT come from a sister.
4. **Step 6 — emit from project's own `.claude/`**: invoke `emit.mjs --cli codex` and `--cli gemini` against the project's existing `.claude/rules/`, plus `emit-cli-artifacts.mjs --target <project-variant>` against the project's `.claude/commands/`, `.claude/skills/`, `.claude/agents/`. **Crucially**: no `--target` filtering by tier-subscription (the project is non-COC, doesn't subscribe to any tier); emit EVERY artifact present in the project's own `.claude/` tree (modulo any `cli_emit_exclusions.{codex,gemini}` in the manifest). Same `mktemp + cp into dotted` pattern as full-migration Step 6.
5. **Step 8 — emit-only marker schema**: write `.claude/.coc-sync-marker` with the emit-only schema (different shape from full-migration marker — no `migrated_from`, no `template`/`template_version` change, instead records `last_emit_at` and `loom_sha`):
   ```yaml
   template_type: <existing type — claude-squad-local, etc.> # preserved, NOT rewritten
   clis: [claude, codex, gemini] # added/refreshed
   last_emit_at: <ISO-8601>
   loom_version: <semver>
   loom_sha: <git sha>
   stats:
     baselines_emitted: { cc: <count>, codex: <count>, gemini: <count> }
     cli_artifacts: { codex: { ... }, gemini: { ... } }
     mcp_guard: { policies_populated: <bool> }
   ```
   The original `template`, `template_version`, `variant`, `migrated_from`, `migrated_at` fields are NOT modified. The marker becomes a hybrid: project-lineage metadata preserved + emit telemetry added.
6. **Step 10 — verification**: rows 1–9 (file presence) + rows 17–19 (settings/config) apply. Rows 10–16 (full-migration marker schema, VERSION upstream, project-content diff) do NOT apply — the emit-only marker schema differs. Surface this in the report: "Step 10 verification: 12/12 emit-only rows ✓".
7. **Step 11 — posture banner**: same as full migration (per-CLI posture caveat).
8. **Step 12 — commit + PR**: same staging pattern (explicit paths, mktemp commit message). Commit: `chore(coc): emit multi-CLI artifacts from project's own .claude/`.

Skipped: Steps 2 (VERSION upstream pointer — project is non-COC, doesn't track loom version), 3 (sister-template overlay copy — there's no sister for non-COC lineage), 4 (`.claude/` refresh from sister — explicitly forbidden by the project's own boundary contract, e.g. csq-loom-boundary), 5 (CLAUDE.md merge — project owns CLAUDE.md outright), 7 (`.github/` workflows refresh — project owns workflows), 9 (project-artifact lint — same as full migration runs it advisorily; included is fine, listing as optional here for emphasis).

### When `--emit-only` is the right disposition

- Project has a `.claude/` directory authored from a COC USE-template fork that has since diverged (csq pattern)
- Project explicitly forbids template re-pulls via a boundary rule (csq's `csq-loom-boundary.md`)
- Project wants to operate via Codex and Gemini using its OWN `.claude/` source-of-truth
- Project does not want loom version tracking or SDK pin updates

When in doubt, run `/migrate --emit-only --dry-run` first to surface the planned actions before applying.

### When NOT to use `--emit-only`

- Project has `cc-only-legacy` lineage → use full migration (`/migrate` without flag) to gain sister-template content
- Project has `multi-cli` lineage → use `--refresh` to re-pull overlays from sister
- Project has `coc-project` lineage (consumer of a COC USE template) → use full migration (sister exists)
- Loom itself (this repo) → run the emit commands directly per `commands/migrate.md` § "Loom-self emission" (the canonical dogfooding harness, no `--emit-only` framing needed)

## `--rollback` mode

Restores from `.pre-migrate.bak/`. Inline porcelain guard required (do NOT cite `rules/git.md` only):

```bash
[ -z "$(git status --porcelain)" ] || {
  echo "uncommitted work — recommend: git stash push -u -m pre-rollback (preserves the recovery option); abort";
  exit 1;
}

# Per rules/git.md: prefer --keep over --hard. --keep aborts loudly on
# local changes; --hard would silently discard. Verify clean tree above
# is the precondition for either, but --keep adds a second-line defense.
git reset --keep main

# Restore snapshot
[ -d .pre-migrate.bak ] && {
  [ -f .pre-migrate.bak/.coc-sync-marker ] && cp .pre-migrate.bak/.coc-sync-marker .claude/.coc-sync-marker
  [ -f .pre-migrate.bak/CLAUDE.md ]        && cp .pre-migrate.bak/CLAUDE.md        ./CLAUDE.md
  [ -f .pre-migrate.bak/VERSION ]          && cp .pre-migrate.bak/VERSION          .claude/VERSION
}

# Drop migration branch
BRANCH=$(cat .pre-migrate.bak/.branch 2>/dev/null)
git checkout main
[ -n "$BRANCH" ] && git branch -D "$BRANCH"
```

If `.pre-migrate.bak/` is missing (rollback after a fresh checkout), recommend `git reset --keep main` followed by manual re-clone — implications: any uncommitted user work in the migration branch is lost, but `--keep` aborts before destruction so the user notices.

## Marker Schema

The full canonical shape every `template_type: multi-cli` marker MUST satisfy. Verification rows 10–13 of Step 10 check these fields exist. Schema mismatch is `block` severity per `rules/sync-completeness.md` Rule 3 + `rules/hook-output-discipline.md` MUST-2 (structural signal).

```yaml
template: kailash-coc-{py,rs} # required
template_type: multi-cli # required, exact string
template_version: <semver> # required
clis: [claude, codex, gemini] # required, exact list
variant: <py|rs> # required
loom_version: <semver> # required
loom_sha: <git sha> # required
timestamp: <ISO-8601> # required
migrated_from: kailash-coc-claude-{py,rs,rb} # required for migrated; absent for fresh multi-CLI
migrated_at: <ISO-8601> # required for migrated
stats:
  baselines_emitted:
    cc: <count> # required
    codex: <count> # required
    gemini: <count> # required
  cli_artifacts:
    codex:
      prompts: <count> # required
      skills: <count> # required
    gemini:
      commands: <count> # required
      skills: <count> # required
      agents: <count> # required
  mcp_guard:
    policies_populated: <bool> # required (false until Loom-B ships)
sdk_pins: <map> # optional but recommended
```

## Hook Env-Var Portability

Hooks MUST accept three env vars (`$CLAUDE_PROJECT_DIR` set by CC, `$CODEX_PROJECT_DIR` set by Codex per hooks.json contract, `$GEMINI_PROJECT_DIR` set by Gemini per `.gemini/settings.json` hooks block). Resolution: `PROJECT_DIR="${CLAUDE_PROJECT_DIR:-${CODEX_PROJECT_DIR:-${GEMINI_PROJECT_DIR:-$PWD}}}"`. Sister-template hooks already conformant; pre-migration project-local hooks MAY need rewriting (Step 9 lint surfaces fragile env-var references).

Every command authored at loom lives at `.claude/commands/<name>.md`; at Gate 2 sync time AND Step 6 of `/migrate`, the SAME body is replicated to `.codex/prompts/<name>.md` and `.gemini/commands/<name>.toml`. Body content is byte-identical modulo delegation-syntax slot overrides. Cross-CLI drift audit (`commands/cli-audit.md`) verifies. Switching CLIs does not invalidate any prior workspace — that is the structural reason `/migrate` does not rewrite project content.

## Trust Posture Wiring

- **Severity**: `halt-and-report` for any verification-table ✗ row in Step 10. `block` for marker-schema mismatch (Step 8 → Step 10 row 10–13).
- **Receipt requirement**: none — `/migrate` is a one-shot opt-in command, not a recurring discipline.
- **Detection mechanism**: `rules/sync-completeness.md` Rule 2 verification table; manifest `multi_cli_overlays:` keys verified at Step 3 + Step 6.
- **Grace period**: not applicable (one-shot command).

Origin: 2026-05-06 — initial /migrate (PR #52) shipped shallow, missing variant overlay regen, AGENTS.md/GEMINI.md staleness, MCP guard population, project-artifact lint, full marker schema, and the verification table. User directive: "no migrate v2 — there is only ONE migrate today and it MUST be perfect." This document replaces PR #52's shallow version with the comprehensive 12-step protocol + 4 modes.
