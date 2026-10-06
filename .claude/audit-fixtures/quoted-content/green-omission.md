# GREEN POLE — the same two fences, faithful

Byte-for-byte the RED pole's structure: same prose, same citation, same
inheritance across two consecutive fences. The ONLY difference is that nothing
was deleted. A checker that reds here is reporting on shape, not on content.

The corpus ships five severities, and `sources/severity-rank.js:11-23` is where their
meanings and ordering are pinned:

```text
block           tool call is DENIED (exit 2). Only meaningful at PreToolUse.
halt-and-report tool RAN; agent must surface and wait.
pre-action      PreToolUse only: NOT blocked and NOT yet run; agent decides.
advisory        tool RAN; agent acknowledges and may proceed.
post-mortem     forensic only (Stop-class events).
```

```js
const SEVERITY_RANK = Object.freeze({
  "post-mortem": 0,
  advisory: 1,
  "pre-action": 1,
  "halt-and-report": 2,
  block: 3,
});
```

The second fence carries NO citation of its own — it inherits the one above it,
which is the shape the real defect shipped in.
