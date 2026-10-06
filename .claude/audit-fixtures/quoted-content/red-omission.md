# RED POLE — undeclared-omission (THE CANONICAL REGRESSION)

This is the shipped defect reconstructed. The corpus's `05-governance.md` cited
`hooks/lib/severity-rank.js:57-80`, fenced the register, DELETED `"post-mortem": 0,`
with no ellipsis, and adjusted the prose count to match — so the fence was
internally consistent, parsed cleanly, and was wrong.

It must red as `undeclared-omission` forever.

The corpus ships four severities, and `sources/severity-rank.js:11-23` is where their
meanings and ordering are pinned:

```text
block           tool call is DENIED (exit 2). Only meaningful at PreToolUse.
halt-and-report tool RAN; agent must surface and wait.
pre-action      PreToolUse only: NOT blocked and NOT yet run; agent decides.
advisory        tool RAN; agent acknowledges and may proceed.
```

```js
const SEVERITY_RANK = Object.freeze({
  advisory: 1,
  "pre-action": 1,
  "halt-and-report": 2,
  block: 3,
});
```

The second fence carries NO citation of its own — it inherits the one above it,
which is the shape the real defect shipped in.
