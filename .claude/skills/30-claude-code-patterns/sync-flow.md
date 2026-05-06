---
name: sync-flow
description: "Detailed protocol for /sync at loom (Gate 1 + Gate 2) and at coc-project consumers (Downstream Sync). Reference for sync-reviewer + coc-sync agents."
---

# /sync Flow Reference

`/sync` at loom has TWO gates (Gate 1 inbound + Gate 2 outbound). At downstream `coc-project` consumers, `/sync` runs the Downstream flow. This reference is loaded by the sync-reviewer agent (Gate 1), the coc-sync agent (Gate 2), and the in-place downstream sync logic (which has no dedicated agent).

## Downstream Sync (coc-project repos)

Pull latest artifacts from the USE template repo. No target needed — reads template identity from VERSION.

### Process

1. **Resolve template** (canonical resolver, v2.9.1+):
   `node "$RESOLVED_TEMPLATE_PATH/.claude/bin/resolve-template.js"` if a previous sync already exists locally; otherwise replicate the resolver inline. Resolution order:
   - **Step 1** — `KAILASH_COC_TEMPLATE_PATH` env var. If set and contains `.claude/`, use it. Source: `env-override`.
   - **Step 2** — Cache at `~/.cache/kailash-coc/<template>/`. Auto-update via `git -C <cache> fetch --depth 1 origin main && git -C <cache> reset --hard origin/main`. Source: `cache`.
   - **Step 3** — If no cache: `git clone --depth 1 --single-branch --branch main https://github.com/<template_repo>.git ~/.cache/kailash-coc/<template>/`. Source: `cloned`.
   - **Step 4 (offline fallback only)** — Local sibling at `../<template>/` or `~/repos/loom/<template>/`. Used ONLY when steps 2-3 all fail (network unreachable). Source: `sibling-offline-fallback`. Emit a `freshness NOT guaranteed` notice.
   - If a local sibling is detected during online resolution but NOT used, emit one stderr notice telling the user to set `KAILASH_COC_TEMPLATE_PATH` if they meant to use it.
   - Known slugs: `kailash-coc-claude-{py,rs,rb,prism}` and the multi-CLI `kailash-coc-{py,rs}` all live under `terrene-foundation/`.
   - **NEVER use the legacy `scripts/resolve-template.js` shim** — added to manifest's `obsoleted:` list in v2.9.1; purged in step 3 below.

2. **Read obsoleted list from the resolved template**: `cat "$RESOLVED_TEMPLATE_PATH/.claude/.coc-obsoleted"` (slim purpose-built file emitted by coc-sync Step 4.5). Each non-comment, non-blank line is a repo-relative path; trailing slash means directory. If missing, the template predates v2.9.1 — log a one-line warning, skip step 3, proceed; the obsoleted purge happens on the NEXT sync once the template upgrades.

3. **Purge obsoleted paths in this consumer (MUST, before any merge)**:

   ```bash
   for path in <obsoleted-paths>; do
     if [ -e "./$path" ]; then
       rm -rf "./$path"
       echo "obsoleted: removed ./$path"
     fi
   done
   ```

   This is the ONLY mechanism by which downstream consumers purge stale orphan directories from former COC layouts. Skipping it leaves `require("./lib/...")` resolving against the wrong sibling and ships hooks that fail at every CC session start with `MODULE_NOT_FOUND`.

4. **Diff** template's `.claude/` against local — MUST diff EVERY child directory under `.claude/`, not only the COC-tier directories:
   - `.claude/agents/**`, `.claude/commands/**`, `.claude/rules/**`, `.claude/skills/**`, `.claude/guides/**`
   - `.claude/hooks/**` — runtime enforcement scripts (canonical since v2.9.1)
   - `.claude/hooks/lib/**` — sibling helper modules loaded via `require("./lib/...")`
   - `.claude/bin/**` — resolver + emitter binaries
   - `.claude/.coc-obsoleted` — the obsoleted-purge contract file
   - Top-level `scripts/migrate.py` and other items declared in the manifest's `variant_only:` block
   - **NOT** `scripts/hooks/` or `.claude/scripts/` — obsoleted in v2.9.1, MUST NOT be re-emitted.

   **Multi-CLI consumers ALSO diff top-level CLI overlays** (Loom-C, 2026-05-06): when consumer's `.claude/.coc-sync-marker.template_type == "multi-cli"` OR `clis:` contains `codex`/`gemini`, the diff set extends with the manifest's `multi_cli_overlays.multi-cli.paths` (currently `.codex/**`, `.codex-mcp-guard/**`, `.gemini/**`, `AGENTS.md`, `GEMINI.md`). This closes the historical gap where multi-CLI top-level scaffolds landed only at `/migrate` time and never refreshed on subsequent `/sync` cycles. The `multi_cli_overlays.multi-cli.preserved` list is the consumer-customizable subset that sync MUST NOT overwrite (analogous to the "NEVER overwritten" set in step 5).

   For `template_type: cc-only-legacy` (kailash-coc-claude-{py,rs,rb}) the multi-CLI top-level set is empty — only `CLAUDE.md` is the baseline, declared in `repos.<target>.templates[].baseline_files`.

   **BLOCKED rationalizations:** "hooks/ are not codegen artifacts so the diff skips them" / "the manifest tiers section doesn't list hooks/\*\*" / "settings.json paths are normalized in step 7, scripts arriving on disk is separate" / "multi-CLI overlays are a /migrate-time concern, not /sync-time" / "consumers can re-run /migrate to refresh top-level overlays". The `.claude/hooks/` directory MUST physically exist on disk for normalized settings.json paths to resolve at runtime. Multi-CLI top-level overlays are sync-time concerns: every loom cycle that touches `.claude/rules/` re-emits `AGENTS.md`/`GEMINI.md` via `emit.mjs`; a consumer that doesn't pull these on `/sync` ships stale baselines for Codex/Gemini.

5. **Additive merge** (same semantics as Gate 2 step 4):
   - Template files overwrite matching local files
   - Local-only files preserved (never deleted) **except** paths in obsoleted list (handled in step 3 above)
   - **NEVER overwritten** (downstream-owned): `CLAUDE.md`, `.claude/VERSION`, `.claude/settings.local.json`, `.env`, `.git/`, `.claude/.proposals/`, `.claude/learning/`
   - **NEVER overwritten** (multi-CLI consumer-customizable): every path in `multi_cli_overlays.multi-cli.preserved` from the manifest. Currently `.codex/local-config.toml`, `.gemini/local-settings.json` — reserved for future per-project overrides without sync conflict.

6. **Present merge plan** with per-file decisions before applying — include obsoleted-path deletions from step 3 in the plan output.

7. **Normalize settings.json hook paths**: scan consumer's `.claude/settings.json` for any `hooks[].command` containing `$CLAUDE_PROJECT_DIR/scripts/hooks/` and rewrite to `$CLAUDE_PROJECT_DIR/.claude/hooks/`. Stale references would fail with `MODULE_NOT_FOUND` after step 3 deleted the directory.

8. **Verify** hook paths in `settings.json` resolve on disk under `.claude/hooks/` AND `grep -F 'scripts/hooks' .claude/settings.json` returns zero matches.

9. **Update `.claude/VERSION` in-place** (never replace the file — only update specific fields): `upstream.template_version` ← template VERSION's `version`, `upstream.template_repo` ← resolved GitHub slug, `upstream.synced_at` ← now, `upstream.sdk_packages` ← from template. MUST preserve `type: coc-project`, `upstream.template` (name), and other fields.

10. **Update SDK pins** in `pyproject.toml` / `Cargo.toml` from template VERSION's `upstream.sdk_packages`.

11. **Install**: `uv sync` (py) or `cargo check` (rs) — **MANDATORY**.

12. **Update `.claude/.coc-sync-marker`** with timestamp + list of obsoleted paths purged in step 3 (audit trail for the migration).

## Gate 1: Review (inbound — BUILD repo → loom/)

Scans the BUILD repo for artifact changes not yet upstreamed to loom/. Delegated to **sync-reviewer** agent. Runs automatically when `/sync` detects unreviewed changes; also runs on explicit `/sync py review`.

### Process

1. Read `sync-manifest.yaml` for tier membership and variant mappings.
2. Read BUILD repo path from `sync-manifest.yaml` → `repos.{target}.build`.
3. **Read SDK version** from BUILD repo's `pyproject.toml` (py) or `Cargo.toml` (rs). Report it in the review header.
4. Compute **expected state**: for each file in `loom/.claude/`, apply the variant overlay for this target. This is what the BUILD repo SHOULD have if it were freshly synced.
5. Diff BUILD repo's `.claude/` against expected state.
6. Check `.claude/.proposals/latest.yaml` (created by /codify):
   - `pending_review` — new unprocessed proposal. Proceed with review.
   - `reviewed` — already classified in a prior `/sync`; check whether new changes were appended after the review (look for entries below `reviewed_date`). If new entries exist, re-review only those.
   - `distributed` — fully processed. Skip proposal review unless BUILD repo diffs show changes outside the proposal.
   - If proposal includes `sdk_version`, verify it matches BUILD repo SDK version — mismatch means the proposal is stale.
   - Multi-session proposals may contain changes from several `/codify` sessions (separated by date-stamped comment blocks). Review ALL unreviewed changes, not just the latest session.

7. For each NEW or MODIFIED file, classify (sync-reviewer agent team — autonomous classification, global vs variant vs skip; reads source + BUILD versions, checks for language-specific content; presents consolidated classification with reasoning for approval).

8. For each change classified as **global**, consider cross-SDK impact: does rs need an equivalent adaptation? If yes → create alignment note.

9. Place files:
   - **Global** → copy to `loom/.claude/{type}/{file}`
   - **Variant** → copy to `loom/.claude/variants/{lang}/{type}/{file}`
   - **Skip** → leave in BUILD repo only

10. Mark proposal as reviewed (update `.proposals/latest.yaml` status).

### Skip conditions

- No changes detected between BUILD repo and expected state.
- User explicitly says "distribute only" or "skip review".

## Gate 2: Distribute (outbound — loom/ → templates)

Merges loom/ source + variant overlays into USE template repos. Delegated to **coc-sync** agent. This is a **merge** — templates may have legitimate local content.

### Process

1. **Read manifest** for tiers, variants, exclusions (`exclude:`, `use_exclude:`).
2. **Inventory the template** — read what's currently there before computing changes.
3. **Compute expected state** for the target (py, rs, rb, base):
   - **Read `repos.<target>.tier_subscriptions`** from `sync-manifest.yaml`. Ordered list of tier names — e.g., `[cc, co, coc]` for py/rs/rb; `[cc, co, onboarding]` for base. Files matched by tier patterns NOT in this list MUST NOT be emitted, even if they sit on disk under a tier-style path. Falling back to "all tiers" when `tier_subscriptions` is absent is BLOCKED — the field is required on every entry under `repos.<target>` in v2.21.0+; missing field = manifest defect that MUST halt sync.
   - For each subscribed tier, emit files matched by that tier's path patterns under `tiers.<tier>:` in the manifest. The union across subscribed tiers IS the codegen-content set; `agents/`, `commands/`, `rules/`, `skills/`, `guides/` are NOT unconditional fanouts — they are scoped by patterns listed in subscribed tiers.
   - **Apply `use_exclude:`** — paths listed there are BUILD-only. USE-template emission MUST skip them. Symmetric with `build_exclude:` for `/sync-to-build`. `/sync-to-build` ignores `use_exclude:`.
   - **Global runtime infrastructure (MUST include — tier-independent)**:
     - `.claude/hooks/**` (canonical since v2.9.1) — every `*.js` plus the `lib/` sibling helpers
     - `.claude/bin/**` — `resolve-template.js`, `emit.mjs`, other resolver/emitter binaries
     - `.claude/.coc-obsoleted` — the obsoleted-purge contract file (regenerated by Step 4.5)
   - **Variant overlay** from `variants/{repos.<target>.variant}/` — replacements + additions, including any `variants/{variant}/hooks/*.js` declared in `variant_only:`. Variant slug is `repos.<target>.variant` (`py`, `rs`, `rb`, `base`) — not necessarily equal to target name; e.g., `repos.rb.variant: rb` but a future `repos.rb-pro.variant: rb` would re-use the same overlay.
   - Top-level non-`.claude/` files declared in `variant_only:` (e.g., `scripts/migrate.py`).
   - **NOT** `scripts/hooks/` or `.claude/scripts/` — obsoleted in v2.9.1, MUST NOT be re-emitted to any target.

   **BLOCKED rationalizations (Gate 2)**: "the manifest tiers section enumerates the artifact set, hooks aren't in it" / "the multi-CLI emitter regenerates hooks via cli_variants, no need to copy" / "consumer settings.json points at hooks/, that's enough" / "we'll fix the missing hooks on the next sync" / "base subscribes to cc + co + onboarding so it should also pick up coc — Kailash specialists are useful everywhere" / "tier_subscriptions is an optimization, defaulting to all tiers is safer" / "the new onboarding tier hasn't been validated yet, ship coc to base too as a fallback".

   Skipping `hooks/` or `bin/` ships a USE template whose downstream consumers have settings.json entries pointing at a non-existent directory; every CC session at the consumer fails SessionStart with `MODULE_NOT_FOUND`. Conversely, ignoring `tier_subscriptions` and emitting `coc` to the `base` variant ships Kailash framework specialists into a non-Kailash USE template — every consumer onboarding a non-Kailash stack inherits irrelevant specialists that pollute their `/agents` listing and confuse semantic-activation.

4. **Per-file merge decisions**:
   - **UNCHANGED** → skip
   - **NEW** (in source, not in template) → add
   - **MODIFIED** (both exist, content differs) → read both versions. If template has USE-specific adaptations (e.g., different wording for downstream context), flag for review before overwriting.
   - **TEMPLATE-ONLY** (in template, not in source) → preserve (never delete).

5. **Present merge plan** with per-file decisions, not a bulk "Apply all".

6. **Apply approved changes**.

7. **Update `.coc-sync-marker`** with timestamp and file list.

8. **Update `.claude/VERSION`** — set `upstream.build_version` to loom/'s version. Create VERSION if missing (per `guides/co-setup/08-versioning.md`). **MUST update `upstream.sdk_packages`** with all package versions from BUILD repo (read from `pyproject.toml` / `Cargo.toml`). This map is what session-start hooks use to detect stale pins in downstream repos.

9. **Update SDK dependency pins** in target's `pyproject.toml` (py) or `Cargo.toml` (rs) — **MANDATORY, never skip**:
   - **py**: Read version from BUILD repo's root `pyproject.toml` and each `packages/*/pyproject.toml`. Update target's `pyproject.toml` `dependencies` so each Kailash package pin (`>=X.Y.Z`) matches BUILD's current release. Applies to ALL targets — templates AND downstream repos.
   - **rs**: Read version from BUILD repo's root `Cargo.toml` and workspace member `Cargo.toml`. Update target's `Cargo.toml` dependency versions accordingly.
   - Report any version changes in the sync report.

10. **Install updated dependencies** — **MANDATORY, never skip**:
    - **py**: Run `uv sync` in target. If `.venv` doesn't exist, run `uv venv && uv sync`. MUST NOT use `pip install`, `pip install -e .`, or any non-`uv` installer.
    - **rs**: Run `cargo check` in target to verify dependency resolution.
    - Report success/failure.

11. **Verify hooks** — every hook in `settings.json` has a corresponding script on disk.

12. **Mark proposal as distributed** — after Gate 2 completes, update BUILD repo's `.claude/.proposals/latest.yaml`:
    - Set `status: distributed`
    - Add `distributed_date: YYYY-MM-DDTHH:MM:SSZ`
    - This signals to the next `/codify` run that it is safe to create a fresh proposal. Without this step, `/codify` would see `reviewed` and append rather than start fresh, accumulating stale entries indefinitely.

### Report shape

```
## Sync Report: loom/ → kailash-coc-claude-py/
Gate 1: 3 reviewed (1 global, 1 variant-py, 1 skipped), SDK 2.2.1
Gate 2: 12 updated, 2 added, 1 flagged, 482 unchanged, 3 preserved
SDK pins: kailash 2.2.1→2.3.0, kailash-dataflow 1.2.1→1.3.0
Dependencies: uv sync ✓ | Hooks: 11/11 | VERSION: 1.0.0→1.1.0
```

## Exclusions (never synced anywhere)

`learning/`, `.proposals/`, `sync-manifest.yaml`, `variants/`, `settings.local.json`, `CLAUDE.md`, `.env`, `.git/`. See `guides/co-setup/06-artifact-lifecycle.md` § "What downstream NEVER gets" for full list.
