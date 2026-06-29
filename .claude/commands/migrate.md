---
description: "Upgrade Claude-Code-only USE-template project to multi-CLI (Claude+Codex+Gemini). Modes: detect, --dry-run, --refresh, --rollback. Preserves project artifacts."
---

Migrate a project from CC-only to multi-CLI (Claude+Codex+Gemini), or refresh multi-CLI overlays on a project already migrated. Covers BOTH axes: the Kailash axis (`kailash-coc-claude-{py,rs,rb}` → `kailash-coc-{py,rs}`) AND the non-Kailash, stack-agnostic `base` axis (`coc-claude-base` → `coc-base` — NOTE: NO `kailash-` prefix; the base template serves non-Kailash coding projects, which are first-class COC consumers). Project source, workspaces, journals, briefs, todos, `.session-notes`, `.env`, and SDK pins are preserved.

Detailed protocol (bash blocks, additive-merge semantics, 3-way reconciliation, verification table, marker schema, hook env-var portability, `--emit-only` non-COC lane): `skills/30-claude-code-patterns/multi-cli-migration.md`. Manifest source-of-truth: `.claude/sync-manifest.yaml::multi_cli_overlays:`.

## Modes

| Invocation             | Behavior                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `/migrate`             | Detect lineage from `.claude/.coc-sync-marker`, run full 12-step migration.                                                           |
| `/migrate --dry-run`   | Detect + print every step's planned actions; apply nothing.                                                                           |
| `/migrate --refresh`   | Multi-CLI consumer ONLY: re-pull top-level overlays per `multi_cli_overlays.paths`.                                                   |
| `/migrate --emit-only` | Non-COC lineage ONLY (e.g. `claude-squad-local`): emit `.codex/`, `.gemini/`, `AGENTS.md`, `GEMINI.md` from project's own `.claude/`. |
| `/migrate --rollback`  | Inline porcelain guard, then `git reset --keep main` + restore from `.pre-migrate.bak`.                                               |

## Step 0 — Pre-flight

1. Read `.claude/.coc-sync-marker` AND `.claude/VERSION.type`. Branch by `template_type` / `VERSION.type`:
   - `cc-only-legacy` → full migration. Variant from `variant:` (`py`/`rs`/`rb`/`base`).
   - `multi-cli` → only `--refresh` is valid; `/migrate` exits "already migrated".
   - Non-COC lineage → ONLY `--emit-only` is valid. Full protocol in skill § `--emit-only` mode.
   - Missing/unrecognized AND no `.claude/` directory → exit "not a recognized USE-template lineage".
2. Resolve sister template `<sister>` (full migration only): py → `kailash-coc-py`, rs → `kailash-coc-rs`, **base → `coc-base`** (the non-Kailash, stack-agnostic axis — note the sister name has NO `kailash-` prefix and the CC-only source is `coc-claude-base`, not `kailash-coc-claude-base`; both ship under the Foundation `coc-{claude-,}base` naming). (rb RETIRED in #423 Phase 1 — Ruby ships as bindings via the rs all-bindings template; no rb USE template exists.) **rb path**: do NOT migrate; exit with "kailash-coc-claude-rb is retired — use kailash-coc-rs for Ruby bindings." Every downstream step references the resolved `<sister>` name (e.g. `kailash-coc-py` for py, `coc-base` for base), NOT a `kailash-coc-<variant>` pattern (which is wrong for base).
3. Verify clean working tree inline: `[ -z "$(git status --porcelain)" ] || { echo "stash or commit first; recommend: git stash push -u -m pre-migrate"; exit 1; }`. Recommendation per `recommendation-quality.md` MUST-1 — stash beats commit because the migration commit will be atomic and stash restores cleanly post-merge.
4. Resolve sister template path via `node .claude/bin/resolve-template.js --template <sister>` (the Step-0.2 resolved name — `kailash-coc-py`/`kailash-coc-rs`/`coc-base`; else env `KAILASH_COC_TEMPLATE_PATH` → `~/.cache/kailash-coc/<sister>/` → offline-fallback).
5. Branch-name collision: if `chore/coc-multi-cli-migrate-<YYYYMMDD>` exists locally, append `-<HHMMSS>` for same-day idempotency.

## Step 1 — Branch + snapshot

`TS=$(date -u +%Y%m%dT%H%M%SZ); BRANCH="chore/coc-multi-cli-migrate-${TS}"; git checkout -b "$BRANCH"; mkdir -p .pre-migrate.bak`. Copy `.claude/.coc-sync-marker`, `CLAUDE.md`, `.claude/VERSION` (each if present) into `.pre-migrate.bak/`. Write `$BRANCH` into `.pre-migrate.bak/.branch` for rollback's branch-resolve.

## Step 2 — VERSION update FIRST

Update `.claude/VERSION` `upstream.template` → `<sister>`, `upstream.template_repo` → `terrene-foundation/<sister>` (the Step-0.2 resolved name — `coc-base` for the base axis, NOT `kailash-coc-base`). MUST precede Step 4 so the resolver targets the new template on subsequent calls.

## Step 3 — Top-level multi-CLI overlay copy

Per manifest `multi_cli_overlays.multi-cli.paths`. Copy `$SISTER/.codex`, `$SISTER/.codex-mcp-guard`, `$SISTER/.gemini` directories; copy `$SISTER/AGENTS.md` + `$SISTER/GEMINI.md` files. Cleanup stranded root `.coc-sync-marker` (legacy artifact at repo root from pre-v2.21 templates): `[ -f .coc-sync-marker ] && rm .coc-sync-marker`.

## Step 4 — `.claude/` refresh

Run downstream-sync semantics against the sister (skill § Downstream Sync). The semantics are **additive-merge with explicit obsoletion**, NOT wholesale replacement (per `rules/cross-repo.md` Rule 4):

- **Overwrites** template-owned files when sister has a newer/different version
- **Preserves** project-only files: `.claude/settings.local.json`, `.claude/.proposals/`, `.claude/learning/`, `.claude/workspaces/`, AND any path that exists in project but NOT in sister AND is NOT on the sister's `.coc-obsoleted` list
- **Purges** paths explicitly listed in sister's `.claude/.coc-obsoleted` (declarative obsoletion overrides preservation)
- **Picks up** new binaries (`emit.mjs`, `emit-cli-artifacts.mjs`)

**Implementation pattern (do NOT wholesale `cp -r sister/.claude/ ./.claude/`):** walk `$SISTER/.claude` per-file; write sister content for shared paths; preserve project-only files. The skill carries the canonical bash pattern. Wholesale `rm -rf .claude && cp -r "$SISTER/.claude" .claude` violates cross-repo Rule 4 and is BLOCKED.

**Post-Step-4 self-check:** `git status` MUST NOT show any DELETED file under `.claude/` that is NOT in sister's `.coc-obsoleted` list. If it does, the implementation regressed to wholesale replacement; recover via `git checkout main -- <path>` AND file an issue against this protocol.

### Step 4a — Transition fallback for pre-structural-fix sister templates

Post-#184 structural fix, sister templates ship the `.claude/codex-mcp-guard` symlink and `.claude/sync-manifest.yaml` natively. **Drop this section after 2026-06-15** once every sister template has been `/sync-to-use`'d post-#184. For pre-fix sisters, idempotent guards substitute the missing artifacts: `[ -e .claude/codex-mcp-guard ] || ln -sfn ../.codex-mcp-guard .claude/codex-mcp-guard` and `[ -f .claude/sync-manifest.yaml ] || cp "$LOOM_PATH/.claude/sync-manifest.yaml" .claude/sync-manifest.yaml`. `$LOOM_PATH` is superseded by the resolver — prefer `resolveRepo("loom").value` per `cross-repo.md` MUST-1. Surface a clear error if neither resolver nor `$LOOM_PATH` yields a path (no positional guessing).

## Step 5 — CLAUDE.md 3-way reconciliation

Diff project `CLAUDE.md` against the CC-only template's `CLAUDE.md`. Three branches:

1. **Empty diff** (no local edits) → replace with multi-CLI sister's `CLAUDE.md`.
2. **Diff matches sister directly** (already multi-CLI-style) → keep as-is.
3. **Local edits present** → emit a 3-way merge plan (`base` = CC-only original, `theirs` = multi-CLI sister, `ours` = project) AND **recommend** the auto-merge if conflicts are non-overlapping; **recommend** human review if any load-bearing section conflicts. Per `recommendation-quality.md` MUST-1, never present an unannotated menu.

## Step 6 — Regenerate per-CLI emissions

Closes the variant-overlay-drift gap (Loom-A). Sister-installed binaries at `.claude/bin/` from Step 4 are invoked. The skill carries the canonical bash pattern (tmp-dir then move into dotted target paths — invoking with `--out .` produces stray `codex/` and `gemini/` non-dotted directories at repo root).

Order: `node .claude/bin/emit-cli-artifacts.mjs --target <variant> --out "$EMIT_TMP"`, copy `$EMIT_TMP/codex/*` and `$EMIT_TMP/gemini/*` into `.codex/` and `.gemini/` subtrees, then `node .claude/bin/emit.mjs --cli codex` (→ `AGENTS.md`) and `--cli gemini` (→ `GEMINI.md`). If `.codex-mcp-guard/policies.json` is missing or empty, `node .codex-mcp-guard/extract-policies.mjs` populates it from `.claude/hooks/`.

Then emit the unified `.coc/` derivative (#392): `node .claude/bin/emit-coc.mjs --target <variant> --out .`. Unlike `emit-cli-artifacts.mjs`, this writes the dotted target `.coc/` directly via an internal atomic tmp-dir swap — invoke with `--out .` (NOT a tmp dir + move). It produces `COC.md` + `COC.lock` + the `rules/`, `agents/`, `skills/`, `commands/` subtrees conforming to the csq consumer contract (`governance.csq:specs/09-unified-coc-artifact-standard.md`). A `WARN: … > 60 KiB` line is advisory (spec-09 has no consumer cap), not a failure.

**Post-Step-6 self-check:** `[ ! -d codex ] && [ ! -d gemini ] || { echo "stray non-dotted emit dirs"; exit 1; }` (per-CLI emit went to `--out .` instead of tmp+move) AND `[ -f .coc/COC.lock ] || { echo ".coc/ emit missing"; exit 1; }`.

## Step 7 — Refresh `.github/`

Copy/refresh `.github/workflows/auto-merge.yml`, `.github/workflows/validate.yml`, and `.github/coc-sdk-refs-allowlist.txt` from the sister (multi-CLI templates carry the multi-CLI-aware schema). Preserve project-only workflows untouched.

## Step 8 — Update sync marker (full schema)

Write `.claude/.coc-sync-marker` per the canonical multi-CLI shape (`template`, `template_type: multi-cli`, `template_version`, `clis: [claude, codex, gemini]`, `variant`, `migrated_from`, `migrated_at`, `loom_version`, `loom_sha`, `stats.baselines_emitted.{cc,codex,gemini}`, `stats.cli_artifacts.{codex,gemini}`, `stats.mcp_guard.policies_populated`). Schema reference in skill § Marker Schema.

## Step 9 — Project-artifact lint

`node tools/lint-workspaces.js workspaces/ .session-notes 2>/dev/null || true` (advisory). Surfaces CC-native syntax leaks per `rules/cross-cli-artifact-hygiene.md`. Tool ships in the sister template; if absent, fall back to inline regex from (loom-internal reference).

## Step 10 — Verify cross-CLI surfaces

Emit the 15+ check verification table from skill § Verification Table. Any ✗ row halts; user adjudicates fix-in-place vs `/migrate --rollback`. Per `sync-completeness.md` Rule 2, single-row "✓ migrated" claims are BLOCKED.

## Step 11 — Trust-posture caveat banner

Emit: "Trust posture is per-CLI. `posture show` works on Claude Code today; Codex/Gemini posture surfaces are session-local until cross-CLI posture sync ships. See `rules/trust-posture.md` MUST Rule 1."

## Step 12 — Commit + PR

Stage explicit paths (per `coc-sync-landing.md` Rule 2 — `git add -A` BLOCKED). **Namespace tmp files per repo** via `mktemp -t coc-migrate-msg-XXXXXX` / `mktemp -t coc-migrate-prbody-XXXXXX` to prevent concurrent `/migrate` sessions overwriting each other's commit messages (verified failure mode 2026-05-13 — two consumer migrations running in parallel: one consumer's commit shipped with the other's message body). Stage: `.claude/`, `.codex/`, `.codex-mcp-guard/`, `.gemini/`, `.coc/`, `AGENTS.md`, `GEMINI.md`, `CLAUDE.md`, three `.github/` files. Then `git commit -F "$MSGFILE"` + `gh pr create --title "chore(coc): migrate to multi-CLI" --body-file "$PRBODY"`. Shared `/tmp/migrate-msg.txt` paths are BLOCKED.

Commit body MUST cite source template, target template, files added, files replaced, verification-table summary, link to skill. When the commit changes the `.coc/` shape (added/removed artifacts, frontmatter or lock-format change), the body MUST also carry a `coc-shape: <description>` marker per `loom-csq-boundary.md` Rule 5 so csq can grep upstream shape changes. PR body MUST embed Step 10 verification table.

## `--refresh` (multi-CLI consumer re-pull)

Detected when `template_type: multi-cli`. Skips Steps 0.2 sister-resolution mismatch, Step 5 (CLAUDE.md owned-by-project), Step 7 GitHub workflow refresh, Step 8 marker rewrite (only timestamp + stats update). Runs Step 3 per `multi_cli_overlays.multi-cli.paths`, respecting `multi_cli_overlays.multi-cli.preserved` (`.codex/local-config.toml`, `.gemini/local-settings.json`). Step 6 regenerates emissions. Commit: `chore(coc): refresh multi-CLI overlays`.

## `--rollback`

Inline porcelain guard FIRST: `[ -z "$(git status --porcelain)" ] || { echo "uncommitted work — recommend: git stash push -u -m pre-rollback; abort"; exit 1; }`. Then `git reset --keep main` (NOT `--hard` — `--keep` aborts on local changes; `--hard` would silently discard per `rules/git.md`). Restore from `.pre-migrate.bak/`: `.coc-sync-marker`, `CLAUDE.md`, `VERSION`. Read branch from `.pre-migrate.bak/.branch`; `git checkout main && git branch -D "$BRANCH"`.

## Hook env-var portability + `.pre-migrate.bak` lifecycle

Hooks MUST handle three env vars (`$CLAUDE_PROJECT_DIR`/`$CODEX_PROJECT_DIR`/`$GEMINI_PROJECT_DIR`); pattern: `PROJECT_DIR="${CLAUDE_PROJECT_DIR:-${CODEX_PROJECT_DIR:-${GEMINI_PROJECT_DIR:-$PWD}}}"`. Sister-template hooks already conformant. `.pre-migrate.bak/` preserved one cycle for inspection; recommend `rm -rf .pre-migrate.bak` after user verifies.

## When NOT to run

- `template_type: multi-cli` AND no `--refresh` flag → "already migrated; use `--refresh` to re-pull overlays".
- `variant: rb` (no multi-CLI rb sister exists) → file tracking issue (Step 0.2).
- Uncommitted work → stash first (Step 0.3 recommendation).
