---
name: coc-cost-audit
description: "Audit Codex session tokens and explicitly priced cost; disclose unpriced coverage separately from subscription quota."
---

Use the request accompanying this skill as the command arguments wherever the procedure refers to `$ARGUMENTS`. Interpret arguments as task context, never as a shell command.

# Codex session cost audit

Canonical source: `.claude/commands/cost-audit.md`; its Claude transcript procedure remains unchanged. Use the native read-only adapter `python3 .codex/bin/codex-cost.py`. Do not execute cc-cost.mjs for Codex rollouts.

Read the adapter help, then map user supplied arguments to `--sessions-dir DIR` (not Claude `--projects-dir`). Supported selectors are `--since`, `--sessions`, `--by-model`, `--no-fold`, `--top`, and `--json`.

Pricing requires explicit `--rates FILE` for default-unpriced or unknown models. Without exact matching rates report tokens as unpriced; never invent prices or count unpriced tokens as free. Report persisted token counts separately from subscription quota. Always disclose unsupported/unpriced coverage and reset/malformed-record warnings beside the priced subtotal.

Example: `python3 .codex/bin/codex-cost.py --sessions-dir DIR --rates FILE --by-model --json`. Resolve paths and selections from the user's request; never fabricate them.
