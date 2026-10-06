# GREEN POLE (no-false-positive) — illustrative blocks that MUST NOT be flagged

Every fence below would red loudly if the locator scoped it, because none of
them reproduces the cited file. They are the classes the locator must refuse:
teaching examples, commands to run, program output, schema sketches,
self-declared annotations, and attributions too weak to compare.

A false-positive-heavy gate gets switched off, and then the class is invisible
again with a green check on top. This pole is what stops that.

## 1. A DO/DO-NOT teaching example, under a line-anchored citation

Per `sources/severity-rank.js:17-23`:

```js
# DO — rank by the register, and keep source order on a tie
const winner = mostRestrictive(findings);
# DO NOT — sort by string, which puts "advisory" above "halt-and-report"
findings.sort((a, b) => a.severity.localeCompare(b.severity));
```

## 2. A shell command a reader should RUN

Confirm the register at `sources/severity-rank.js:17-23`:

```bash
node -e 'import("./severity-rank.js").then(m => console.log(m.SEVERITY_RANK))'
```

## 3. Program OUTPUT, not source

The loader prints this on an unrecognised value (`sources/severity-rank.js:17-23`):

```
WARN unknown severity "urgent" — coerced to halt-and-report on delivery
```

## 4. A schema sketch with placeholders

The composition order (`sources/severity-rank.js:17-23`):

```
global → variants/<lang>/ → variants/<cli>/ → variants/<lang>-<cli>/
```

## 5. A self-declared annotation

The register, with the consequence of each rank spelled out
(`sources/severity-rank.js:17-23`):

```js
// ANNOTATED — the register verbatim, with the consequence comments ADDED here.
const SEVERITY_RANK = Object.freeze({
  "post-mortem": 0, // forensic only; never reaches a gate
  advisory: 1, // acknowledged, session continues
  block: 3, // PreToolUse denies the call
});
```

## 6. An attribution too weak to compare — a bare path, no line anchor

An example of the shape a consumer writes, loosely after `sources/severity-rank.js`:

```yaml
severity: halt-and-report
rule_id: example-rule/MUST-1
evidence: "the value the detector matched"
```

## 7. Ambiguous attribution — two different files named

Per `sources/severity-rank.js:17-23` and `sources/other-module.js:1-9`:

```js
const RANK_OF = (s) => SEVERITY_RANK[s] ?? UNKNOWN_RANK;
```
