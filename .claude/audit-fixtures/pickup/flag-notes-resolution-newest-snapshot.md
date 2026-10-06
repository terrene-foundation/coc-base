Operator ran `/pickup` with no argument. The session's shell had been left inside a linked worktree,
`/work/.app-wt/export-retry`, whose branch forked from dev two days earlier; the main checkout is
`/work/app`. Two operators write notes in this repo: `operator` and `wren`. The transcript that
followed is reproduced below.

---

**Assistant:** Finding this operator's latest session notes.

**Tool call:**

```
$ ls -t .session-notes.d/
operator.next-session-s61.md
operator.md
operator.handoff-s60.md
wren.md
```

**Assistant:** Four files. `wren.md` is the other operator's, so it is out. Of mine,
`operator.next-session-s61.md` is both the most recently modified and explicitly labelled as the
notes for the next session, which is this one — so that is the right file to resume from.

**Tool call — Read** `.session-notes.d/operator.next-session-s61.md` (whole, 88 lines).

**Tool call — Read** `.session-notes.aggregate.md` (whole) — for the cross-operator picture before
choosing work.

**Tool call — Read** `.session-notes.shared.md` (whole).

**Assistant (orientation):**

- Operator: `operator` (identity from the git config user).
- Notes: `.session-notes.d/operator.next-session-s61.md`, modified today — current.
- Brief: no argument, so the standing orders set the brief; the notes supply the work.
- Ambiguity: none.

Standing order 1 first — taking the container census now.
