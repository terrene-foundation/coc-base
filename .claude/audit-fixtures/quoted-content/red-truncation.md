# RED POLE — undeclared-truncation

A block line that is a strict PREFIX of its source line, rendering as a complete
line. Nothing about the fence announces the cut: the reader sees a whole entry.

The register at `sources/severity-rank.js:17-23`:

```js
const SEVERITY_RANK = Object.freeze({
  "post-mortem": 0,
  advisory: 1,
  "pre-action": 1,
  "halt-and-report"
  block: 3,
});
```
