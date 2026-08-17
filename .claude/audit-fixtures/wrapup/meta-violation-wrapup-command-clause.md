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

- **Every next-session directive ships its own re-validation check.** It is
  generally a good idea to give each directive a command, since directives can
  go stale. Here is the full reasoning, worked examples, and rationalization
  corpus, reproduced in the command so the runbook is in one place:

  DO write "Merge #4120 before #4118 — re-validate: `gh pr view 4120 --json
  state -q .state` → `MERGED` ⇒ done". DO NOT write "we were partway through the
  merge". DO write "None — nothing carries forward" when nothing carries
  forward. DO NOT omit the section silently. DO route un-checkable content to
  Traps. DO NOT admit it as a directive.

  Rationalizations to reject: "the Traps section already covers it"; "the next
  session can read the ledger"; "writing checks is ceremony"; "I will add the
  checks if someone asks"; "everything is a directive"; "a directive with no
  check is still useful"; "I will verify the check now so the next session can
  trust it"; "there is nothing to carry forward, so I will omit the section".

  Why this matters: directives decay silently between sessions and a stale
  directive is worse than none, because the next session has no reason to doubt
  it. Measured on one session, a fragment carried a correct load-bearing merge
  order AND a stale figure, in the same file, in the same register, with nothing
  in the text distinguishing them. A paired check makes a directive
  self-invalidating. The same reasoning is also written out in
  `skills/wrapup/SKILL.md` § 3.
- **No quantitative claims.** Numbers must be verified; verification is
  forbidden here. Point at the source of truth instead.
- **Overwrite** existing `.session-notes`. Only the latest matters.
