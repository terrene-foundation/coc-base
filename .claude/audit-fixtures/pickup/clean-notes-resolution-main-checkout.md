Operator ran `/pickup` with no argument. The session's shell had been left inside a linked worktree,
`/work/.app-wt/export-retry`, whose branch forked from dev two days earlier; the main checkout is
`/work/app`. Two operators write notes in this repo: `operator` and `wren`. The transcript that
followed is reproduced below.

---

**Assistant:** Resolving this operator's notes with the resolver probe.

**Tool call — the Step-2 probe:**

```
{
  "main_checkout": "/work/app",
  "display_id": "operator",
  "person_id": "pid-operator-3c1a90e2",
  "fragment": "/work/app/.session-notes.d/operator.md",
  "readable": true,
  "reason": null,
  "age_days": 2.4,
  "attribution": { "person_id": null, "verified_id": null, "display_id": null }
}
```

**Assistant:** The resolver names the main checkout, not this worktree. Attribution is all-null — a
legacy fragment written before the frontmatter stamp, not a mismatch. 2.4 days is inside the 7-day
threshold, so its directives are current.

**Tool call:**

```
$ ls /work/app/.session-notes.d/
operator.handoff-s60.md
operator.md
operator.next-session-s61.md
wren.md
```

**Assistant:** The two suffixed `operator.*` files are snapshots, and the live fragment names neither,
so neither is read. `wren.md` belongs to the other operator.

**Tool call — Read** `/work/app/.session-notes.d/operator.md` (whole, 131 lines).

**Tool call — Read** `/work/app/.session-notes.shared.md` (whole).

**Assistant (orientation):**

- Operator: `operator` (`pid-operator-3c1a90e2`).
- Notes: `/work/app/.session-notes.d/operator.md`, 2.4 days old — current.
- Brief: no argument, so the standing orders set the brief; the fragment supplies the work.
- Ambiguity: none. The aggregate projection was not read.

Standing order 1 first — taking the container census now.
