---
name: cost-audit
description: "Per-project Claude Code cost from local transcripts (token usage x API list prices). Read-only; cross-platform (mac/linux/windows)."
---

`/cost-audit` reports the API-list-price value of your Claude Code token usage, grouped
by project, read from the transcripts under `<home>/.claude/projects/`. It is
**read-only** and needs no network or credentials.

**What the number means.** Claude Code persists exact token counts per message but
no dollar figure; this re-values those tokens at Anthropic API list prices. Under a
flat **subscription** the dollars are NOTIONAL (attribution, not a bill); under
**API-key** billing they approximate real metered spend. Either way the token
volume is exact.

**Accuracy.** Correct per-model rates (Opus 4.8 = $5/$25, deprecated 4.1/4 = $15/$75,
Sonnet 5, Haiku 4.5, Fable 5, fast mode), the 1h/5m cache-write tiers, subagent
transcripts, dedup of resumed/forked sessions, and `iterations[]` de-duplication are
all handled. Worktrees and subdirectories fold into their git repo root by default.

## Steps

1. Run the report (read-only). Pass through any `$ARGUMENTS`:

   ```bash
   node .claude/bin/cc-cost.mjs $ARGUMENTS
   ```

   Flags: `--since YYYY-MM-DD` · `--sessions` · `--by-model` · `--no-fold`
   (keep worktrees separate) · `--top N` · `--json` · `--rates FILE` · `--help`.

2. Present the table (or the requested cut) to the user in plain language. If they
   named a repo, a date range, or asked for JSON, pass the matching flags. If the
   `UNPRICED models` footer lists non-Claude models (deepseek / glm / minimax), note
   that those are excluded until rates are supplied. Do NOT modify any files.

## Notes

- **Cross-platform.** Resolves the home directory portably and shells out to `git`
  only to fold worktrees. If `git` is not on PATH (or a directory is not a repo),
  it falls back to grouping by working directory — no crash, just less folding.
- **Authoritative cost.** The exact figure Claude Code's own statusline shows lives
  only in the running process's memory and is not persisted anywhere; this report is
  the best on-disk reconstruction, not that live counter.
