# POLE — a file where the gate compares NOTHING must not read as clean

This is the `07-measuring.md` shape reconstructed. Every block below is dropped
SILENTLY by the exclusion battery — a shell fence, a teaching example, a
self-declared non-verbatim block, and an uncited one. None of them is wrong to
exclude; each has its own named reason.

The defect is what the OUTPUT looked like before the volume accounting existed.
This file produced zero findings, zero coverage rows and `ok: true` — byte-identical
to `green-omission.md`, where two blocks were genuinely compared against their
source and matched. One file was examined and one was not, and no consumer of the
gate's output could tell them apart.

Measured on the real corpus at the time: `07-measuring.md` LOCATED 53 blocks and
COMPARED zero, and a sibling lane that had inlined quotations there got a green
and correctly refused to cite it.

This pole must therefore report `file-not-compared`, and its GREEN twin
`green-omission.md` must not.

A shell fence — a command to run, never a source reproduction:

```bash
node .claude/bin/validate-quoted-content.mjs --all
```

A teaching example, invented by construction, from `sources/severity-rank.js:17-23`:

```js
# DO — token-replace leaves a grep-able trail
# DO NOT — quote-escape (the payload survives as data)
```

A self-declared non-verbatim block, also from `sources/severity-rank.js:17-23`:

```js
// REFERENCE-ONLY — the shape, not the bytes
const SEVERITY_RANK = { ...severities };
```

And an uncited block, which never claimed to reproduce anything:

```js
const something = compute();
```
