---
priority: 10
scope: path-scoped
paths:
  - "**/ingest/**"
  - "**/*identifier*"
---

# Unicode Normalization Boundary — Normalize On Ingest, Never At Compare Time

A string that arrives over the wire can spell one identifier two ways. Normalizing where it
enters makes every later comparison a byte comparison; normalizing where it is compared means
every call site must remember, and one of them will not.

## MUST Rules

### 1. Text Is Normalized At The Ingest Boundary, Before Its First Store

Any externally-sourced string that will be compared, indexed, or used as a key MUST be
normalized to NFC at the ingest boundary and stored in that form. Normalizing at comparison
time instead is BLOCKED, including when only one call site does the comparing today.

```text
# DO — one normalize, at the edge, before anything stores or indexes it
handle = unicodedata.normalize("NFC", body["handle"])   # then store, index, compare as bytes
# DO NOT — normalize inside the comparison, leaving the stored value in whatever arrived
if normalize("NFC", row.handle) == normalize("NFC", query):   # row.handle is still NFD on disk
```

**BLOCKED rationalizations:** "there is only one place that compares these" / "the database
collation handles it" / "our clients all send NFC anyway" / "normalizing on read is safer
because we keep the original" / "we can backfill later if it turns out to matter".

**Why:** A store holding both spellings has already lost the uniqueness its index claims, so
the second call site that compares — a migration, a report, a new endpoint — sees two rows
where the first saw one.

### 2. The Stored Form Is Declared Beside The Column, Not In The Reader

A column holding normalized text MUST carry the form in its schema declaration, and any reader
that re-normalizes MUST fail rather than silently convert. A reader that quietly normalizes a
column whose declared form differs is BLOCKED.

```text
# DO — the form is part of the column, and a mismatch is loud
handle TEXT NOT NULL,  -- unicode-form: NFC (enforced at ingest, see ingest/handles.py)
assert form_of(row.handle) == "NFC", f"handle read as {form_of(row.handle)}, expected NFC"
# DO NOT — a reader that repairs what it finds, so the store never gets fixed
handle = unicodedata.normalize("NFC", row.handle)   # quietly repairs, hides the bad write
```

**BLOCKED rationalizations:** "defensive normalization costs nothing" / "the reader is the last
line of defence" / "a comment in the model class is close enough" / "failing on read is worse
than repairing".

**Why:** A repairing reader converts a write-path bug into a permanent read-path tax, and it
removes the only signal — a mismatch — that would have located the bad writer.

## MUST NOT

- Compare user-supplied text to stored text without both having passed the same ingest boundary

**Why:** The query string and the stored string reach the comparison by different paths, so an
un-normalized query silently misses rows that are present and correctly stored.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement` confirms the
  normalize call sits at the ingest boundary and that no reader re-normalizes); `advisory` at
  the hook layer per `hook-output-discipline.md` MUST-2.
- **Grace period:** 7 days from rule landing (2026-06-14 → 2026-06-21).
- **Cumulative posture impact:** same-class violations (text normalized at comparison time; a
  reader silently re-normalizing a declared column) contribute to `trust-posture.md` MUST-4
  cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1
  posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency
  trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger
  key. Named deviation from the canonical key-per-clause shape, recorded here per
  `trust-posture.md` Rule 8: minting one would drag that file, a `self-referential-codify.md`
  allowlist path, into a self-referential edit.
- **Receipt requirement:** SessionStart soft-gate `[ack: unicode-normalization-boundary]` IFF
  `posture.json::pending_verification` includes the `unicode-normalization-boundary` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer reads the ingest module and
  the model layer. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — a detector
  flagging any `unicodedata.normalize` call whose enclosing function is reachable from a read
  path rather than from an ingest entry point. Both the call site and the enclosing function's
  reachability are AST facts over the same module graph, so the deferral names a structural
  signal and books enforcement that can arrive; fixtures land WITH it at
  `.claude/audit-fixtures/unicode-normalization-boundary/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1, MUST-2 and the MUST NOT bullet. Every `violations.jsonl` row
  names the column and which side of the boundary the normalize call sat on.
- **Origin:** See § Origin.

## Origin

2026-06-14 — two accounts were created with the same display handle, one NFC and one NFD, and
the uniqueness index accepted both because it compared bytes. The support path then merged them
into each other twice in a week. The rule fixes a PLACE rather than asking reviewers to
remember a call, because remembering was exactly what failed at the second call site.
