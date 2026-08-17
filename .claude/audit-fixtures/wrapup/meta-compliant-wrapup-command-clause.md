---
name: wrapup
description: "Write .session-notes so the next session resumes without re-discovering context."
---

Excerpt from a slash-command body: the emitted-format entry and the governing
hard rule for the next-session directives surface.

## Format

Hard cap: **50 lines**. Omit any section that would be empty — EXCEPT the five
always-present sections, which write an explicit empty-sentinel rather than
vanish: **Next-session directives** ("None — nothing carries forward"), **Read
first**, **Outstanding ledger**, **Executed this session**, **Wave tracker**.

```markdown
## Next-session directives

Imperative standing orders for the NEXT session — ≤5, each carrying the command
that says whether it is STILL TRUE. Written FROM MEMORY; the checks are for the
NEXT session to RUN, never for this one. If you cannot write the check, it is
NOT a directive — it is context, and it belongs in Traps.

1. **<imperative order>** — re-validate: `<command>` → `<result meaning STILL TRUE>`
   (write "None — nothing carries forward" if none; never omit silently)
```

## Hard rules

- **Every next-session directive ships its own re-validation check — no check,
  no directive.** The directives section is the ONE imperative surface in the
  notes; every other section is descriptive. Each directive MUST name the
  command a future session runs to learn whether it is STILL TRUE, and what
  result means still-true. Cap **5**. "None — nothing carries forward" is a
  VALID and expected answer, not a box to fill. Un-checkable content is context
  → **Traps**, never a directive. Memory-sourced like everything else here: the
  check is authored for the NEXT session to run, and running it now is BLOCKED
  by the 4-tool-call cap. DO / DO-NOT + BLOCKED corpus:
  `skills/wrapup/SKILL.md` § 3.
- **No quantitative claims.** Numbers must be verified; verification is
  forbidden here. Point at the source of truth instead.
- **Overwrite** existing `.session-notes`. Only the latest matters.
