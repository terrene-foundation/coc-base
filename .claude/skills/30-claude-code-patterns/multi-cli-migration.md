---
name: multi-cli-migration
description: "Protocol for /migrate — COC-adoption front door: --adopt bootstraps COC onto a non-COC repo; migrate/--refresh update an outdated COC repo. Families kailash/base; markers, verification table."
---

# Multi-CLI Migration + COC-Adoption Reference

`/migrate` is the COC-adoption front door for an EXISTING repo. It spans two entry scenarios across the two template families (kailash / base), and this document is the source of truth for every mode's protocol; the command body (`commands/migrate.md`) is the entry point only.

## Scenarios & families

**Two entry scenarios:**

- **(A) Adopt — a NON-COC-NATIVE repo** (`--adopt`): an existing codebase with NO `.claude/` COC tree. Bootstrap COC in fresh, select the family, emit per-CLI surfaces. Protocol: § `--adopt` mode.
- **(B) Update — an OUTDATED-COC repo** (already carries `.claude/`, but stale): full migration upgrades a CC-only lineage to multi-CLI; `--refresh` re-pulls multi-CLI overlays; a `coc-project` consumer only version-behind on the SAME template routes to `/sync-from-template` (a merge-pull, NOT `/migrate`). The lineage → disposition routing is in § Detection & routing.

**Two template families** (all handled; the "multi-CLI axis" is a CLI distinction WITHIN each family, not a third family — see the row-note below the table):

| Family      | CC-only source (claude)      | multi-CLI sister (claude+codex+gemini) | manifest `variant` | build present      |
| ----------- | ---------------------------- | -------------------------------------- | ------------------ | ------------------ |
| **kailash** | `kailash-coc-claude-{py,rs}` | `kailash-coc-{py,rs}`                  | `py` / `rs`        | yes                |
| **base**    | `coc-claude-base`            | `coc-base` (NO `kailash-` prefix)      | `base`             | no (`build: null`) |

The **multi-CLI axis** the co-owner named ("coc- and coc-claude") is NOT a third family — it is the CC-only (`coc-claude-*`) vs multi-CLI (`coc-*` / `kailash-coc-{py,rs}`) distinction WITHIN each family, i.e. the full-migration + `--refresh` surface. `rb` is RETIRED (#423 Phase 1 — Ruby ships as bindings via the rs all-bindings template; no rb USE template).

## Detection & routing (scenario dispatch)

`/migrate` with no flag reads `.claude/.coc-sync-marker` + `.claude/VERSION.type`, then RECOMMENDS the disposition (per `recommendation-quality.md` MUST-1 — never a bare exit):

| Detected repo state                                          | Scenario | Recommended disposition                                        |
| ------------------------------------------------------------ | -------- | -------------------------------------------------------------- |
| No `.claude/` AND no marker                                  | A        | `/migrate --adopt` (state the auto-detected family + CLI axis) |
| `cc-only-legacy` lineage                                     | B        | full migration (`/migrate`, 12 steps)                          |
| `multi-cli` lineage, overlays stale                          | B        | `/migrate --refresh`                                           |
| `coc-project` consumer, only version-behind on SAME template | B        | `/sync-from-template` (merge-pull; not `/migrate`)             |
| Non-COC lineage WITH `.claude/` (e.g. `claude-squad-local`)  | —        | `/migrate --emit-only`                                         |

## Modes

| Mode           | Trigger                                     | Steps run                                                                                                                                                                                                      | Commit message                                                     |
| -------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Full migration | `cc-only-legacy` lineage                    | 0–12                                                                                                                                                                                                           | `chore(coc): migrate to multi-CLI template (claude+codex+gemini)`  |
| `--adopt`      | No `.claude/` tree (scenario A)             | A-pre (clean-tree guard), A0 (family detect), A1 (target select), A-branch (branch + collision snapshot), A2 (STACK.md for base), A3 (fresh-install), then 2 (VERSION), 6 (emit), 8 (fresh marker), 10, 11, 12 | `chore(coc): adopt COC (<family>, <cli-axis>)`                     |
| `--dry-run`    | Any lineage                                 | 0 detection only; print all planned actions (adopt OR update); apply nothing                                                                                                                                   | (no commit)                                                        |
| `--refresh`    | `multi-cli` lineage                         | 0.1 lineage check, 3 (overlay re-pull), 6 (re-emit), 8 (timestamp+stats), 10 (verify)                                                                                                                          | `chore(coc): refresh multi-CLI overlays`                           |
| `--emit-only`  | Non-COC lineage (e.g. `claude-squad-local`) | 0.1 (non-COC accept), 1, 4a (scaffold), 6, 8 (emit-only marker), 10, 11, 12                                                                                                                                    | `chore(coc): emit multi-CLI artifacts from project's own .claude/` |
| `--rollback`   | Migration branch active                     | Inline porcelain guard, `git reset --keep main`, restore `.pre-migrate.bak`                                                                                                                                    | (no commit; branch deleted)                                        |

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
2. Map variant → multi-CLI sister `<sister>` (NOT a `kailash-coc-<variant>` string-concat — that is WRONG for base, which has no `kailash-` prefix):
   - `py` → `kailash-coc-py`
   - `rs` → `kailash-coc-rs`
   - `base` → `coc-base` (CC-only source `coc-claude-base`; NO `kailash-` prefix — the stack-agnostic Foundation axis)
   - `rb` → RETIRED (#423 Phase 1). Ruby ships as bindings via the rs all-bindings template (kailash-coc-rs + the 28-ruby-bindings skill); there is no rb USE template. Do NOT migrate; exit with "kailash-coc-claude-rb is retired — use kailash-coc-rs for Ruby bindings."
3. Verify clean working tree inline (do NOT just cite `rules/git.md`):
   ```bash
   [ -z "$(git status --porcelain)" ] || {
     echo "uncommitted work — recommend: git stash push -u -m pre-migrate (preserves untracked); commit alternative leaves migration mixed with prior work";
     exit 1;
   }
   ```
4. Resolve sister template path. Reuse the `/sync-from-template` resolution chain (`commands/sync-from-template.md` § Downstream Sync). Use the Step-0.2 resolved `<sister>` NAME (`kailash-coc-py`/`kailash-coc-rs`/`coc-base`), NOT a `kailash-coc-${VARIANT}` concat (wrong for base):
   ```bash
   case "$VARIANT" in
     py) SISTER_NAME=kailash-coc-py ;;
     rs) SISTER_NAME=kailash-coc-rs ;;
     base) SISTER_NAME=coc-base ;;
     *) echo "unexpected variant '$VARIANT' — aborting before branch/VERSION mutation"; exit 1 ;;
   esac
   # FAIL-CLOSED (mirrors --adopt A3): halt BEFORE Step 1 branches / Step 2 rewrites VERSION.
   SISTER=$(node .claude/bin/resolve-template.js --template "$SISTER_NAME") \
     || { echo "sister $SISTER_NAME unresolvable — aborting"; exit 1; }
   [ -n "$SISTER" ] || { echo "empty sister path — aborting"; exit 1; }
   # Chain (by name): env KAILASH_COC_TEMPLATE_PATH → ~/.cache/kailash-coc/<sister>/ → git clone --depth 1 →
   # offline-fallback via loom-links `use-template.<key>` (NEVER a positional ~/repos/<sister> guess, per cross-repo.md MUST-1)
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

### Step 2 — VERSION update (persist post-migration pull identity)

Update `.claude/VERSION` to point at the multi-CLI sister. This persists the migrated template identity that a FUTURE `/sync-from-template` reads to pull the right upstream — it is NOT a Step-4 input. Step 4 operates on the `$SISTER` resolved by NAME at Step 0.4 (VERSION-independent — the `--template <name>` lane resolves the sister directly, not via `.claude/VERSION`), and reuses the Step-3-scanned tree; it does NOT re-read VERSION or re-resolve the sister. There is therefore no Steps-2-before-4 re-resolution dependency (an earlier version of this protocol DID re-resolve via VERSION at Step 4; the Step-0.4 name-lane resolution + the Step-4 `$SISTER` reuse removed it and closed the cache-re-pull window — do NOT re-introduce a Step-4 re-resolve).

Fields updated:

- `upstream.template` ← `<sister>` (the Step-0.2 resolved name — `coc-base` for base, NOT `kailash-coc-base`)
- `upstream.template_repo` ← `terrene-foundation/<sister>` (`terrene-foundation/coc-base` for base)
- `upstream.template_version` ← read from sister `.claude/VERSION`
- `upstream.synced_at` ← now (ISO-8601)
- Preserve `type: coc-project`, all other fields

### Step 3 — Top-level multi-CLI overlay copy

Copy paths declared in `multi_cli_overlays.multi-cli.paths` from sister → project. Cleanup stranded root `.coc-sync-marker` (legacy artifact at repo root from pre-v2.21 templates):

**Disclosure scrub before copy (multi-tenant fence) — UNCONDITIONAL, same as `--adopt` A3.** Full migration AND `--refresh` copy `$SISTER` content into the project; `$SISTER` may be an operator-pointed local directory belonging to ANOTHER tenant/ecosystem via EITHER the `KAILASH_COC_TEMPLATE_PATH` env override OR the offline-fallback sibling. Run `node .claude/bin/scan-synced-disclosure.mjs --root "$SISTER"` BEFORE the copy below; a non-zero exit or any finding HALTS (genericize + re-resolve first), mirroring `rules/artifact-flow.md` § "Intake Disclosure Scrub". A fresh canonical GitHub clone scans clean.

```bash
node .claude/bin/scan-synced-disclosure.mjs --root "$SISTER" || { echo "disclosure finding in resolved template — HALT"; exit 1; }
cp -R "$SISTER/.codex"           ./.codex
cp -R "$SISTER/.codex-mcp-guard" ./.codex-mcp-guard
cp -R "$SISTER/.gemini"          ./.gemini
cp    "$SISTER/AGENTS.md"        ./AGENTS.md
cp    "$SISTER/GEMINI.md"        ./GEMINI.md
[ -f .coc-sync-marker ] && rm .coc-sync-marker  # legacy root sentinel; canonical is .claude/.coc-sync-marker
```

For `--refresh`: respect `multi_cli_overlays.multi-cli.preserved` — files in that list are NOT overwritten even if present in the sister.

### Step 4 — `.claude/` refresh via downstream-sync

Run downstream-sync semantics against the sister (per `skills/30-claude-code-patterns/sync-flow.md` § Downstream Sync, steps 2–8), operating on the SAME `$SISTER` path resolved at Step 0.4 and disclosure-scanned at Step 3 — do NOT re-resolve the sister here. Re-resolving would re-enter the resolver's cache lane (`git fetch` + `git reset --hard origin/main`), so the `.claude/` copy source could differ from the tree Step 3 scanned; reusing the scanned `$SISTER` closes that window by construction. The semantics are **additive-merge with explicit obsoletion**, NOT wholesale replacement (per `rules/cross-repo.md` Rule 4). This:

- Reads sister's `.claude/.coc-obsoleted` and purges any matching paths in the project (per Rule 4 of `rules/cross-repo.md`).
- Diffs sister `.claude/` against project `.claude/`.
- Overwrites template-owned files with sister versions (commands, skills, agents, hooks, rules — globals + variant overlay for the project's variant axis).
- Preserves project-owned files: `.claude/settings.local.json`, `.claude/.proposals/`, `.claude/learning/`.
- Multi-CLI sister adds binaries the CC-only template lacked: `.claude/bin/emit.mjs`, `.claude/bin/emit-cli-artifacts.mjs`, `.claude/bin/compose.mjs`. Picked up here.
- Normalizes `settings.json` hook paths from `$CLAUDE_PROJECT_DIR/scripts/hooks/` → `$CLAUDE_PROJECT_DIR/.claude/hooks/` (legacy v2.8.x pattern).

**Implementation pattern (per-file walk; do NOT bulk-copy):**

```bash
# DO — per-file diff + merge respecting cross-repo Rule 4
SISTER_OBSOLETED=$(cat "$SISTER/.claude/.coc-obsoleted" 2>/dev/null || echo "")
# Compute file set: sister files + project's surviving files (not on obsoleted).
# Walk `find $SISTER/.claude` and per-file decide write-vs-preserve.
# (Real implementation: invoke `sync-tier-aware.mjs` or equivalent
#  downstream-sync helper — NEVER bulk `cp -r`.)

# DO NOT — wholesale replacement drops project-only files (BLOCKED per
# `rules/cross-repo.md` Rule 4)
rm -rf .claude && cp -r "$SISTER/.claude" .claude
# (This violates cross-repo Rule 4; if your implementation does this,
#  surface the gap.)
```

**Post-Step-4 self-check:** `git status` MUST NOT show any DELETED file under `.claude/` that is NOT in sister's `.coc-obsoleted` list. If it does, the Step 4 implementation regressed to wholesale replacement; recover via `git checkout main -- <path>` for each unintentional deletion AND open an issue against the migrate.md protocol.

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
# emit-cli-artifacts.mjs writes to <out>/codex/ and <out>/gemini/ (NO
# leading dot). Use a tmp dir then move into dotted target paths —
# invoking with `--out .` directly produces stray `codex/` and
# `gemini/` directories at repo root alongside the dotted ones from
# Step 3. Variant-aware per-CLI artifacts overlay the sister's Step 3
# copy.
EMIT_TMP="$(mktemp -d -t coc-migrate-emit-XXXXXX)"
node .claude/bin/emit-cli-artifacts.mjs --target ${VARIANT} --out "$EMIT_TMP"

mkdir -p .codex/prompts .codex/skills .gemini/commands .gemini/skills .gemini/agents
cp -R "$EMIT_TMP/codex/prompts/." .codex/prompts/
cp -R "$EMIT_TMP/codex/skills/."  .codex/skills/
cp -R "$EMIT_TMP/gemini/commands/." .gemini/commands/
cp -R "$EMIT_TMP/gemini/skills/."   .gemini/skills/
cp -R "$EMIT_TMP/gemini/agents/."   .gemini/agents/
rm -rf "$EMIT_TMP"

# Per-CLI baselines — emitted from project's own .claude/rules/ (CRIT-tier rules)
node .claude/bin/emit.mjs --cli codex   # → AGENTS.md
node .claude/bin/emit.mjs --cli gemini  # → GEMINI.md

# Unified .coc/ derivative (#392) — writes the dotted target directly via an
# internal atomic tmp-dir swap; invoke with `--out .` (NOT a tmp dir + move).
node .claude/bin/emit-coc.mjs --target ${VARIANT} --out .   # → COC.md + COC.lock + subtrees
```

**Post-Step-6 self-check:** verify no stray non-dotted `codex/` or `gemini/` exist at repo root: `[ ! -d codex ] && [ ! -d gemini ] || { echo "stray non-dotted emit dirs"; exit 1; }` AND the `.coc/` derivative landed: `[ -f .coc/COC.lock ] || { echo ".coc/ emit missing"; exit 1; }`. If stray non-dotted dirs exist, the agent invoked `emit-cli-artifacts.mjs --out .` instead of the tmp+move pattern above; clean up before proceeding.

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

If `tools/lint-workspaces.js` is absent (project predates v2.23.x), inline the regex set from (loom-internal reference):

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
| 14 | .claude/VERSION upstream.template == <sister> (coc-base for base) | ✓/✗  | Step 2                         |
| 15 | .claude/VERSION upstream.template_version matches sister       | ✓/✗    | Step 2                         |
| 16 | git diff main -- workspaces/ src/ tests/ docs/ pyproject.toml empty | ✓/✗    | project content untouched      |
| 17 | grep -rF 'scripts/hooks' .claude/settings.json returns nothing | ✓/✗    | hook-path normalization Step 4 |
| 18 | .codex/config.toml present                                     | ✓/✗    | overlay copy completeness      |
| 19 | .gemini/settings.json present                                  | ✓/✗    | overlay copy completeness      |
| 20 | tools/lint-workspaces.js advisory findings (count surfaced)    | (n)    | Step 9 advisory                |
| 21 | .coc/COC.lock present (unified .coc/ derivative #392)          | ✓/✗    | emitted at Step 6              |
```

Single-row "✓ migrated" claims are BLOCKED per `rules/sync-completeness.md` Rule 2.

### Step 11 — Trust-posture caveat

Emit banner to user:

> Trust posture is per-CLI today. `posture show` on Claude Code reads `.claude/learning/posture.json` per `rules/trust-posture.md` MUST Rule 1. Codex and Gemini have no posture surface yet — their sessions run at default trust until cross-CLI posture sync ships. Plan accordingly when running mutating commands from Codex/Gemini.

This is informational; no action required.

### Step 12 — Commit + PR

Commit message MUST cite source/target template + version, files added (`.codex/`, `.codex-mcp-guard/`, `.gemini/`, `.coc/`, `AGENTS.md`, `GEMINI.md`), files replaced (`CLAUDE.md` per Step 5), files updated (`.claude/.coc-sync-marker`, `.claude/VERSION`, `.github/workflows/{auto-merge,validate}.yml`, `.github/coc-sdk-refs-allowlist.txt`), files re-emitted (Step 6 per-CLI artifacts), files preserved (`workspaces/`, project source, SDK pins, `.claude/.proposals/`, `.claude/learning/`, `.claude/settings.local.json`), AND verification-table summary (`20/20 ✓`).

Stage explicit paths only (per `rules/coc-sync-landing.md` Rule 2 — `git add -A` BLOCKED on COC-shaped PRs). **Namespace tmp files per repo** via `mktemp` to prevent concurrent `/migrate` sessions overwriting each other's commit messages (verified failure mode 2026-05-13 — two consumer migrations running in parallel: one consumer's commit shipped with the other's message body). Shared `/tmp/migrate-msg.txt` paths are BLOCKED.

```bash
# DO — per-repo tmp namespacing OR mktemp; never shared /tmp/migrate-msg.txt
MSGFILE="$(mktemp -t coc-migrate-msg-XXXXXX)"
PRBODY="$(mktemp -t coc-migrate-prbody-XXXXXX)"
# ... write commit message to "$MSGFILE", PR body to "$PRBODY" ...

git add .claude/ .codex/ .codex-mcp-guard/ .gemini/ .coc/ AGENTS.md GEMINI.md CLAUDE.md \
        .github/workflows/auto-merge.yml .github/workflows/validate.yml \
        .github/coc-sdk-refs-allowlist.txt
git commit -F "$MSGFILE"
gh pr create --title "chore(coc): migrate to multi-CLI" --body-file "$PRBODY"
rm -f "$MSGFILE" "$PRBODY"

# DO NOT — shared /tmp/migrate-msg.txt path; second concurrent migrate overwrites first
git commit -F /tmp/migrate-msg.txt   # BLOCKED — Write + git commit window is racey
```

A full migration ADDS the `.coc/` derivative (#392), so the commit body MUST carry a `coc-shape: <description>` marker per `rules/loom-csq-boundary.md` Rule 5 (csq greps upstream `.coc/` shape changes). PR body MUST include the verification table from Step 10.

## `--refresh` mode (multi-CLI consumer re-pull)

Triggered when `template_type: multi-cli`. Refreshes top-level overlays per `multi_cli_overlays.multi-cli.paths` (NOT a full migration; project is already multi-CLI):

1. Step 0: lineage check (must be `multi-cli`); inline porcelain guard.
2. Step 3: copy paths from `multi_cli_overlays.multi-cli.paths`, respecting `multi_cli_overlays.multi-cli.preserved`.
3. Step 6: re-emit per-CLI artifacts + baselines.
4. Step 8: update marker `timestamp`, `loom_sha`, `loom_version`, `stats.baselines_emitted`, `stats.cli_artifacts`. Do NOT touch `template_type`, `migrated_from`, `migrated_at`, `clis`.
5. Step 10: verification table (rows 1–9, 17–19 — schema fields already canonical).
6. Step 12: commit `chore(coc): refresh multi-CLI overlays`.

Skipped: Steps 2 (VERSION upstream pointer already correct), 4 (downstream-sync handles `.claude/` refresh on next `/sync-from-template` — `--refresh` is overlay-only), 5 (CLAUDE.md project-owned post-migration), 7 (workflows already aligned), 11 (posture caveat already known to multi-CLI users).

## `--adopt` mode (scenario A — bootstrap COC onto a non-COC repo)

Triggered by `/migrate --adopt` on an EXISTING repo that has NO `.claude/` COC tree. This is the genuinely-new capability: a FRESH INSTALL of the family template into a repo that has never carried COC, NOT a merge against a prior marker. It REUSES the existing engines (`resolve-template.js`, `/onboard-stack`, `emit.mjs` / `emit-cli-artifacts.mjs`, and `/sync-from-template`'s downstream-sync copy in a fresh-install branch) — it does not introduce a new install engine.

**Entry point (bootstrap paradox).** A repo with NO `.claude/` tree has no project-local `/migrate` command to invoke — the command is a COC artifact that only exists inside a `.claude/` tree. `--adopt` MUST therefore be invoked from the operator's **user-global** command scope (`~/.claude/commands/migrate.md`), which Claude Code loads for every session regardless of the repo's own `.claude/` state. State this explicitly to the user when `--adopt` is recommended from a bare repo: "run `/migrate --adopt` — it is available from your user-global `~/.claude/commands/`, even though this repo has no `.claude/` yet." (Codex/Gemini equivalents: the user-global `~/.codex/prompts/` and `~/.gemini/commands/` scopes.)

The distinction from full migration: full migration has a `.claude/` tree from a CC-only template and UPGRADES it (additive-merge against the sister); `--adopt` starts from nothing, so there is no obsoletion and no 3-way CLAUDE.md reconciliation. **But "no `.claude/` tree" does NOT mean "nothing to collide with."** The install writes SEVEN-PLUS root paths — `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.codex/`, `.codex-mcp-guard/`, `.gemini/`, `.coc/`, and `.claude/` — and a repo can carry a HAND-AUTHORED `CLAUDE.md` (or any of these) with no `.claude/` present. Checking only `.claude/` absence and then overwriting `CLAUDE.md` irrecoverably is the exact destructive-op class `rules/git.md` blocks. `--adopt` therefore carries the SAME safety rails every other mutating mode carries: a clean-tree porcelain guard (Step A-pre), a branch + a `.pre-migrate.bak` snapshot of EVERY install-target path that already exists (Step A-branch), so `--rollback` restores any pre-existing file the install overwrote. Rollback for `--adopt` is `git reset --keep main` + drop the branch + restore the snapshot — identical to full migration.

### Step A-pre — Clean-tree pre-flight gate (FIRST, before any detection)

`--adopt` mutates the working tree; run the SAME inline porcelain guard full migration runs at Step 0.3 BEFORE anything else. Do NOT cite `rules/git.md` only — run the check:

```bash
[ -z "$(git status --porcelain)" ] || {
  echo "uncommitted work — recommend: git stash push -u -m pre-adopt (preserves untracked); abort. Adopt overwrites root COC paths and must run on a clean tree so --rollback is total.";
  exit 1;
}
```

A dirty tree HALTS here: an adopt that overwrites a hand-authored `CLAUDE.md` on top of other uncommitted edits leaves a state `--rollback` cannot cleanly restore.

### Step A0 — Family detection

Detect which template family fits the repo. HIGH-confidence signals:

- **Kailash family** — `pyproject.toml` requires a `kailash*` package (`kailash`, `kailash-dataflow`, `kailash-nexus`, `kailash-kaizen`, …), OR `Cargo.toml` declares a `kailash` / `kailash-*` crate. Variant: `py` (Python project) or `rs` (Rust project).
- **Base family** (stack-agnostic, non-Kailash) — no Kailash SDK signal. Serves Go, Java, TypeScript, .NET, Ruby, Python-non-Kailash, etc. Variant: `base`.

`--family` accepts ONLY `kailash` or `base` — any other value HALTS with `echo "unknown --family <v> (accepted: kailash | base)"; exit 1` (no silent default to base). The variant is DERIVED, never free-form: kailash → `py` (Python project) or `rs` (Rust project) from the Step-A0 signal; base → `base`. There is no `rb` variant (retired #423). Per `verify-resource-existence.md` discipline, a non-HIGH-confidence detection MUST be CONFIRMED with the user before installing — never auto-scaffold from a low-confidence guess. `--dry-run` prints the detected family + planned target without applying.

### Step A1 — Target (CLI axis) selection

Default target is the **multi-CLI** sister (claude+codex+gemini):

- kailash + py → `kailash-coc-py`; kailash + rs → `kailash-coc-rs`; base → `coc-base`.

`--cc-only` selects the **claude-only** sister instead (`kailash-coc-claude-{py,rs}` / `coc-claude-base`) for a repo that only runs Claude Code today. The user can later run full migration to gain multi-CLI (scenario B).

### Step A-branch — Branch + collision snapshot (before STACK.md scaffold + install)

Create the adopt branch and snapshot EVERY install-target path that already exists, so `--rollback` is total. Runs AFTER A1 (the target/CLI axis is resolved, so the write-set is known) and BEFORE A2 (`/onboard-stack`, which WRITES `STACK.md`) and A3 (the install) — the snapshot MUST precede every tree mutation, including the base-family `STACK.md` scaffold:

```bash
# Stale-backup guard: a prior aborted adopt may have left .pre-migrate.bak/.
# A-pre's clean-tree guard already HALTs on leftover untracked install files,
# but refuse explicitly rather than snapshot template content over a true original.
[ -e .pre-migrate.bak ] && { echo "stale .pre-migrate.bak/ present — a prior adopt did not complete or roll back; resolve (inspect + rm) before re-running"; exit 1; }

TS=$(date -u +%Y%m%dT%H%M%SZ)
BRANCH="chore/coc-adopt-${TS}"
git rev-parse --verify "$BRANCH" 2>/dev/null && BRANCH="${BRANCH}-$$"   # same-second idempotency
git checkout -b "$BRANCH"
mkdir -p .pre-migrate.bak
echo "$BRANCH" > .pre-migrate.bak/.branch

# The install's ROOT write-set. STACK.md is base-family only (written by A2 /onboard-stack);
# it is harmless on kailash (the `[ -e ]` test skips it). CC-only target writes CLAUDE.md + .claude/.
# Snapshot each path that ALREADY exists — a hand-authored CLAUDE.md/STACK.md is the common collision.
COLLISIONS=""
for p in CLAUDE.md AGENTS.md GEMINI.md STACK.md .codex .codex-mcp-guard .gemini .coc .claude; do
  # Reject a symlinked install-target root: `cp -R` on a symlinked dir is platform-divergent
  # (BSD vs GNU) and the install would write THROUGH the link outside the repo.
  [ -L "$p" ] && { echo "install-target $p is a symlink — refusing (adopt writes real trees; resolve the symlink first)"; git checkout main; git branch -D "$BRANCH"; rm -rf .pre-migrate.bak; exit 1; }
  [ -e "$p" ] && { cp -R "$p" ".pre-migrate.bak/$p"; COLLISIONS="$COLLISIONS $p"; }
done
[ -n "$COLLISIONS" ] && echo "PRE-EXISTING paths snapshotted (will be overwritten; restore via --rollback):$COLLISIONS"
```

Surface `$COLLISIONS` to the user: a repo with a hand-authored `CLAUDE.md`/`STACK.md` (no `.claude/`) DOES collide — the file is snapshotted and overwritten, and `--rollback` restores it. The Step-0 / A0 routing gates only on `.claude/` + marker absence to DECIDE adopt-vs-migrate; the ROOT-write-set collision check lives HERE (A-branch), covering the whole set — `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `STACK.md`, `.codex`, `.codex-mcp-guard`, `.gemini`, `.coc`, `.claude` — not `.claude/` alone. This is the CRIT the "everything is an ADD, nothing collides" premise missed.

### Step A2 — Base family: scaffold STACK.md (after snapshot, before install)

For the **base** family only, run `/onboard-stack` AFTER Step A-branch and before the install (delegates to `stack-detector`, writes `STACK.md` per `rules/stack-detection.md`). A-branch runs first specifically so a pre-existing hand-authored `STACK.md` is snapshotted before `/onboard-stack` overwrites it (the STACK.md sibling of the CLAUDE.md collision class). The base template's generic specialists (`agents/generic/{ai,api,db}-specialist`) bind to `STACK.md`; installing the base tree without it leaves the phase commands unable to resolve the stack (per `stack-detection.md` MUST-1). Kailash family skips this — the SDK pins in `pyproject.toml` / `Cargo.toml` ARE the canonical stack answer.

### Step A3 — Fresh-install the resolved template

**Resolve the sister path FAIL-CLOSED via `SISTER=$(node .claude/bin/resolve-template.js --template <sister>)`** — the `--template` name lane prints a BARE PATH (env `KAILASH_COC_TEMPLATE_PATH` → `~/.cache/kailash-coc/<sister>/` → GitHub clone → offline-fallback local sibling), exit 1 on total failure. If the resolver exits non-zero / yields no path (all chain links fail), HALT before writing anything AND clean up the branch's untracked backup dir: `echo "template <sister> unresolvable — aborting adopt (no partial install)"; git checkout main && git branch -D "$BRANCH"; rm -rf .pre-migrate.bak; exit 1`. A partial install from a half-resolved template is un-rollback-able coherently — fail closed per `rules/zero-tolerance.md` Rule 3.

**Disclosure scrub before install (multi-tenant fence) — UNCONDITIONAL.** Run `node .claude/bin/scan-synced-disclosure.mjs --root "$SISTER"` against the resolved source BEFORE copying it into the client repo, regardless of which resolver link produced it; a non-zero exit or any finding HALTS the install (genericize + re-resolve first), mirroring the Gate-1 Intake Disclosure Scrub (`rules/artifact-flow.md` § "Intake Disclosure Scrub"). The scrub is unconditional because `$SISTER` can be an operator-pointed local directory belonging to ANOTHER tenant/ecosystem via EITHER the `KAILASH_COC_TEMPLATE_PATH` env override OR the offline-fallback sibling — scoping the scrub to only one link leaves the other as a leak path. A fresh canonical GitHub clone scans clean, so the unconditional scrub costs one scan and closes the env-var/sibling bypass entirely.

Then copy the template into the repo as a FRESH INSTALL, reusing `/sync-from-template`'s downstream-sync copy semantics with every template-owned path treated as an ADD (no prior tree, so no obsoletion/preserve arbitration):

- `.claude/` (the full COC config tree: commands, skills, agents, hooks, rules, `bin/`).
- Multi-CLI target only: also `.codex/`, `.codex-mcp-guard/`, `.gemini/`, plus the external symlink targets per `sync-completeness.md` Rule 5 (`.claude/codex-mcp-guard` → `../.codex-mcp-guard`).
- Project-owned paths (`src/`, `tests/`, `docs/`, `.env`, `pyproject.toml`/`Cargo.toml`, `workspaces/`) are the repo's own and untouched by construction. The TEMPLATE-owned ROOT files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) are NOT project-owned — if the repo hand-authored one, Step A-branch already snapshotted it and the install overwrites it (restore via `--rollback`).

### Step A4 — Marker + VERSION + emit + verify + commit

- **VERSION (Step 2 shape):** write a fresh `.claude/VERSION` with `type: coc-project`, `upstream.template` = `<sister>`, `upstream.template_repo` = `terrene-foundation/<sister>`, `upstream.template_version` from the sister, `upstream.synced_at` = now.
- **Per-CLI emit (Step 6), multi-CLI target only:** `emit.mjs --cli codex` / `--cli gemini` (→ `AGENTS.md` / `GEMINI.md`) + `emit-cli-artifacts.mjs --target <variant>` (→ `.codex/` + `.gemini/` bodies), same tmp-dir-then-move pattern as full-migration Step 6. Then the unified `.coc/` derivative (`emit-coc.mjs --target <variant> --out .`). CC-only target: only `CLAUDE.md` is the baseline (no `AGENTS.md`/`GEMINI.md`).
- **Fresh marker (Step 8 shape):** write `.claude/.coc-sync-marker` with `template_type` = `multi-cli` (or, for `--cc-only`, `cc-only-legacy` — the value is the DETECTION-ROUTING KEY that lets a later `/migrate` recognize this repo as a CC-only lineage eligible for multi-CLI upgrade, NOT a claim the fresh adoption is old), `template` = `<sister>`, `clis`, `variant`, `adopted_at` = now, `loom_version`, `loom_sha`, and the `stats` block. Use `adopted_at` (NOT `migrated_from`/`migrated_at` — there was no prior COC lineage to migrate FROM).
- **Verify (Step 10):** emit the verification table (file presence + emit dry-run exit 0 + marker/VERSION schema; for multi-CLI targets include the `.coc/COC.lock present` row). Rows that assume a prior tree (project-content-diff-empty) do not apply — surface "N/N adopt rows ✓".
- **Posture banner (Step 11), multi-CLI target:** emit the same per-CLI trust-posture caveat as full-migration Step 11 (`posture show` works on Claude Code; Codex/Gemini posture is session-local until cross-CLI sync ships). Informational; the caveat is relevant to a fresh multi-CLI adoption whose operator will run mutating commands from Codex/Gemini.
- **Commit + PR (Step 12):** stage explicit paths (multi-CLI: include `.coc/`; carry the `coc-shape:` marker per `rules/loom-csq-boundary.md` Rule 5 since adopt ADDS `.coc/`); commit `chore(coc): adopt COC (<family>, <cli-axis>)`; PR body embeds the verification table + the detected family + confidence.

### When `--adopt` is the right disposition

- The repo is an existing codebase with production/source code but NO `.claude/` COC tree (never adopted COC).
- The user wants to START using COC discipline (phase commands, specialists, rules) in that repo.

### When NOT to use `--adopt`

- Repo ALREADY has a `.claude/` COC tree → it is scenario B: use full migration (`cc-only-legacy` → multi-CLI), `--refresh` (multi-CLI overlay re-pull), or `/sync-from-template` (version-behind on the same template). Step 0.1 routing catches this.
- Standing up a whole NEW ecosystem (canon or a client fork) → `/ecosystem-init` (writes `ecosystem.json` + genesis trust-root), not `--adopt` (which adopts COC into ONE existing project).
- A non-COC fork that wants per-CLI artifacts from its OWN `.claude/` without pulling a sister → `--emit-only`.

## `--emit-only` mode (non-COC lineage)

Triggered for projects whose `.claude/VERSION.type` is NOT `cc-only-legacy` or `multi-cli` — typically `claude-squad-local` or any future non-COC fork that wants per-CLI artifacts emitted from its OWN `.claude/` source WITHOUT pulling sister-template content. The originating case is csq (`terrene-foundation/csq`, type=`claude-squad-local`): csq forked from kailash-coc-claude-py and pruned Kailash content; its `loom-csq-boundary.md` rule explicitly forbids template re-pulls; but csq still needs `.codex/`, `.gemini/`, `AGENTS.md`, `GEMINI.md` emitted from its own pruned `.claude/` so Codex and Gemini sessions against csq have a scaffold to load.

The mode runs only the EMIT phase. Sister-template-dependent steps (3, 4, 5, 7) are skipped. The project's existing `.claude/` is the source of truth.

### Steps

1. **Step 0.1 — non-COC accept**: `--emit-only` bypasses the default "unrecognized lineage" rejection. The recognized non-COC types are `claude-squad-local` plus any project lineage that has a `.claude/` directory AND declares its type explicitly in `.claude/VERSION.type`. The flag MUST be set explicitly — `/migrate` without `--emit-only` on a non-COC type still rejects per the original Step 0 contract (no silent acceptance).
2. **Step 1 — branch + snapshot**: same as full migration. Branch name: `chore/coc-multi-cli-emit-<YYYYMMDD>` (different prefix from `chore/coc-multi-cli-migrate-` to distinguish in `git log`).
3. **Step 4a — scaffold the emitter dependencies**: same as full migration. Create `.claude/codex-mcp-guard → ../.codex-mcp-guard` symlink and copy `$LOOM_PATH/.claude/sync-manifest.yaml` into `.claude/`. The symlink + manifest are scaffold artifacts the emitters require; they do NOT come from a sister.
4. **Step 6 — emit from project's own `.claude/`**: invoke `emit.mjs --cli codex` and `--cli gemini` against the project's existing `.claude/rules/`, plus `emit-cli-artifacts.mjs --target <project-variant>` against the project's `.claude/commands/`, `.claude/skills/`, `.claude/agents/`. **Crucially**: no `--target` filtering by tier-subscription (the project is non-COC, doesn't subscribe to any tier); emit EVERY artifact present in the project's own `.claude/` tree (modulo any `cli_emit_exclusions.{codex,gemini}` in the manifest). Same `mktemp + cp into dotted` pattern as full-migration Step 6. **`.coc/` is DELIBERATELY excluded from `--emit-only`** (unlike full-migration Step 6 and `--adopt` A4, which emit it): `--emit-only` scaffolds the per-CLI SESSION surfaces (`.codex/`/`.gemini/`/`AGENTS.md`/`GEMINI.md`) a non-COC fork needs so Codex/Gemini sessions load; the unified `.coc/` derivative (#392) is a distinct downstream-consumer artifact whose producer stays loom-owned per `rules/loom-csq-boundary.md` (csq consumes loom's `.coc/`, it does not self-emit one from `--emit-only`). A fork that genuinely needs a self-generated `.coc/` runs `emit-coc.mjs` directly — out of scope for this scaffold mode.
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

Skipped: Steps 2 (VERSION upstream pointer — project is non-COC, doesn't track loom version), 3 (sister-template overlay copy — there's no sister for non-COC lineage), 4 (`.claude/` refresh from sister — explicitly forbidden by the project's own boundary contract, e.g. loom-csq-boundary), 5 (CLAUDE.md merge — project owns CLAUDE.md outright), 7 (`.github/` workflows refresh — project owns workflows), 9 (project-artifact lint — same as full migration runs it advisorily; included is fine, listing as optional here for emphasis).

### When `--emit-only` is the right disposition

- Project has a `.claude/` directory authored from a COC USE-template fork that has since diverged (csq pattern)
- Project explicitly forbids template re-pulls via a boundary rule (csq's `loom-csq-boundary.md`)
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

# Restore snapshot — generic over whatever was snapshotted (full migration:
# .coc-sync-marker + CLAUDE.md + VERSION [+ .codex/.gemini on partial re-run];
# --adopt: every pre-existing install-target path Step A-branch snapshotted —
# CLAUDE.md, AGENTS.md, GEMINI.md, .codex, .codex-mcp-guard, .gemini, .coc, .claude).
# The snapshot is the ONLY restore path for a pre-existing UNTRACKED file
# adopt overwrote (git reset --keep main cannot restore what main never had).
[ -d .pre-migrate.bak ] && {
  # VERSION + .coc-sync-marker live under .claude/; everything else at repo root.
  [ -f .pre-migrate.bak/.coc-sync-marker ] && cp -R .pre-migrate.bak/.coc-sync-marker .claude/.coc-sync-marker
  [ -e .pre-migrate.bak/VERSION ]          && cp -R .pre-migrate.bak/VERSION          .claude/VERSION
  for p in CLAUDE.md AGENTS.md GEMINI.md STACK.md .codex .codex-mcp-guard .gemini .coc .claude; do
    [ -e ".pre-migrate.bak/$p" ] && { rm -rf "./$p"; cp -R ".pre-migrate.bak/$p" "./$p"; }
  done
}

# Drop migration branch — validate the name shape before force-delete (the
# .branch file is a trusted local artifact, but never `git branch -D` an
# unvalidated string; git also refuses to delete the checked-out branch, so
# `git checkout main` first self-guards `main`).
BRANCH=$(cat .pre-migrate.bak/.branch 2>/dev/null)
git checkout main
case "$BRANCH" in
  chore/coc-adopt-*|chore/coc-multi-cli-migrate-*|chore/coc-multi-cli-emit-*)
    git branch -D "$BRANCH" ;;
  "") : ;;  # no branch recorded
  *) echo "refusing to delete unexpected branch name from .pre-migrate.bak/.branch: $BRANCH" ;;
esac
```

**Non-pre-existing install paths (--adopt):** any install-target path the repo did NOT carry before adopt has NO snapshot and is reverted by `git reset --keep main` for a COMMITTED adopt. For a mid-install (pre-commit) rollback those paths remain as untracked leftovers — surface them (`git status --porcelain`) and `rm -rf` after the user confirms, since they were freshly installed and hold no user work.

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
