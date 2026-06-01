# Sweep Stub-Marker False-Positives — Audit Fixture Directory

> **Status: institutional convention — no mechanical enforcement yet.** The
> SWEEP runner (`.claude/commands/sweep.md` + skills) does NOT currently read
> the `// SWEEP-EXEMPT-STUB-MARKERS:` marker or this fixture directory. The
> convention is a human-triage aid: a future SWEEP author confronted with
> false-positive flags on a tagged file SHOULD consult this directory before
> re-litigating the disposition. Wiring `/sweep` to honor the marker
> mechanically is a planned follow-up (no issue yet — file when the convention
> hits its second self-detector file).
>
> **Scope: documentation-only fixture.** Unlike `.claude/audit-fixtures/<tool>/`
> dirs that ship paired `<name>.txt` + `<name>.expected` files for an
> executable runner, this directory holds classification records (markdown).
> The structural variation is intentional — there is no runner; the record
>
> - marker comment are the institutional artifact.

This directory documents acknowledged false-positives for `rules/zero-tolerance.md`
Rule 2 sweep findings where a file is a **self-detector** of stub markers.

## The Self-Detection Pattern

A file that IS the detector for stub marker patterns (`TODO`, `FIXME`, `HACK`,
`XXX`, `raise NotImplementedError`) will necessarily contain those patterns as:

- Regex patterns used in detection logic
- Error string literals in violation messages
- Comment headers labeling detection sections

These are NOT actual stubs — they are the detection apparatus.

## The `// SWEEP-EXEMPT-STUB-MARKERS:` Convention

Files that are stub-marker self-detectors MUST carry the following comment block
immediately after their file header and before the first `require`/`import`
statement:

```javascript
// SWEEP-EXEMPT-STUB-MARKERS: this file IS the stub-marker detector; literal strings are detection patterns, not stubs.
```

Future SWEEP runs that flag a file carrying this comment for `TODO|FIXME|HACK|
XXX|NotImplementedError` hits MUST check:

1. Does the file carry the `SWEEP-EXEMPT-STUB-MARKERS:` comment?
2. Are ALL flagged lines inside the detection logic (regex patterns, error
   strings, comment headers)?
3. Is there an acknowledged false-positive record in this directory for this file?

If all three are YES → mark as **acknowledged false-positive**, no action needed.

If any flagged line is OUTSIDE the detection logic (e.g., a genuine TODO in
business logic added after this fixture was created) → treat as TRUE positive
and fix.

## Files With Acknowledged False-Positives

| File                                 | False-positive count | Fixture record                        |
| ------------------------------------ | -------------------- | ------------------------------------- |
| `.claude/hooks/validate-workflow.js` | 12                   | `validate-workflow-self-detection.md` |

**Current self-detector inventory: N=1.** Other files containing
incidental marker references (e.g., `.claude/bin/validate-cert-bank.mjs`
has 1 advisory-comment hit unrelated to its own detection logic) are NOT
classified as stub-marker self-detectors and do NOT require the
`SWEEP-EXEMPT-STUB-MARKERS:` marker. Threshold for tagging: a file's
detection logic produces ≥3 false-positive hits that re-litigate every
SWEEP cycle. Below that threshold, per-finding human disposition is
cheaper than the convention overhead.

## Origin

SWEEP-2026-05-26 F34 triage. All 12 matches in `validate-workflow.js`
classified as false-positives (commit `82b1c86`). Convention established to
prevent recurrence across future SWEEP runs.
