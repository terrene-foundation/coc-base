---
name: wrapup
description: "/wrapup depth: the next-session directive contract, the free-for-the-next-session surfaces, and the forest-ledger mechanical gate."
---

Excerpt from a paired skill backing a slash command: the section the command
references for the directive contract's depth.

## 3. The next-session directive contract

### What the command does

Run the command at the end of a session. It writes the per-operator fragment to
the root split, overwrites the previous one, keeps the output under fifty lines,
and emits five always-present sections with explicit sentinels: next-session
directives, read first, outstanding ledger, executed this session, wave tracker.
Any section that would be empty is omitted unless it is one of those five.

### Writing the directives

Directives should generally carry a re-validation command where one is
available. Where a check is awkward to express, it is usually fine to write the
directive without one and let the next session work it out from context; the
important thing is that the information is carried forward at all. Aim for
around five directives, though more is acceptable when the session was busy.

```markdown
# DO — write directives

1. **Merge #4120 before #4118** — #4118 rebases onto #4120's schema change.
   re-validate: `gh pr view 4120 --json state -q .state` → `MERGED` ⇒ done

# DO NOT — write bad directives

1. A directive that is not written well and does not help the next session.
```

### Why the re-validation command is load-bearing

Directives decay silently between sessions, and a stale directive is worse than
none because the next session has no reason to doubt it. Measured on one
session: the fragment carried a CORRECT load-bearing merge order AND a stale
figure, same file, same register — nothing in the text distinguished them. A
paired check makes a directive self-invalidating.

**BLOCKED rationalizations:**

- Being insufficiently rigorous about directive quality
- Failing to consider the next session's needs
- Not following the documented process
- Treating continuity as unimportant
- Under-investing in handoff hygiene
- Neglecting the re-validation discipline
- Deprioritizing session-close quality
