# variant-overlay audit fixtures

Tests for `.claude/bin/lib/variant-overlay.mjs` — manifest-aware overlay
resolution that closes two silent-failure classes in `/sync` / `/sync-to-build`:

1. **Rename** — manifest declares a variant overlay whose basename differs
   from the global (e.g. `skills/10-deployment-git/python-version-bump.md`
   → `variants/rs/skills/10-deployment-git/rust-version-bump.md` on `rs`).
   Pre-fix: path-mirror lookup missed the rename and shipped the global
   `python-version-bump.md` to rs USE templates (codex/gemini emits).

2. **Phantom** — manifest declares `<axis>: null` meaning "no overlay applies"
   but a legacy file exists at the path-mirror location (e.g.
   `variants/py/rules/ci-runners.md` despite `manifest::variants::ci-runners.md::py: null`).
   Pre-fix: the phantom was silently picked up, overriding the manifest's intent.

Run: `node run.mjs` from this directory. Each test prints `PASS`/`FAIL` lines
and exits non-zero on any failure.
