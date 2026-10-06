---
name: knowledge-convergence
description: "Multi-operator knowledge convergence: single-writer artifact splits, journal slot reservation + body-hash anchor, /codify lease, team-memory split rule, /onboard read-path, signed append-log identity stamping."
priority: 10
scope: path-scoped
paths:
  - ".claude/team-memory/**"
  - ".claude/learning/**"
  - "**/journal/**"
  - ".claude/commands/codify.md"
  - ".session-notes*"
  - ".session-notes.d/**"
  - ".claude/.proposals/**"
---

# Knowledge Convergence — Multi-Operator Single-Writer Discipline

Depth companion, cited below as **the extract**: `.claude/guides/rule-extracts/knowledge-convergence.md`. Full worked examples: `.claude/guides/rule-extracts/knowledge-convergence-examples.md`.

Under N concurrent operators against one shared repo, every artifact that historically had ONE writer per session (the contended set enumerated in § MUST NOT) becomes a multi-writer contention surface. The defenses below turn silent loss into clean parallel writes or loud, named, recoverable conflict. Collision walkthroughs: the extract § Contention Surfaces.

**Citation note:** the Origin's architecture-spec citations are loom-internal derivation pointers; the MUST clauses here are self-contained and authoritative (full note: the extract § Citation Note).

## MUST Rules

### 1. Per-Operator Fragments Are WRITTEN; The Shared Ledger Is A DERIVED PROJECTION

`.session-notes` MUST be split into per-operator fragments at `.session-notes.d/<display_id>.md` — single-writer, hand-written — plus a shared forest ledger at `.session-notes.shared.md` carrying a per-row `owner:` cell. A single shared `.session-notes` file is BLOCKED. Every write to EITHER surface MUST use the atomic `.tmp` + `rename()` primitive; that primitive is UNCHANGED (spec: the extract § Rule 1).

**The fragment FILENAME is advisory signage ONLY.** Per `multi-operator-coordination.md` §1 `display_id` collisions are harmless and tooling MUST attribute via `verified_id`, NEVER `display_id`. Every fragment MUST therefore carry frontmatter `person_id`+`verified_id`+`display_id`, and any tooling that attributes a fragment to an operator MUST read THAT frontmatter — deriving an operator identity by stripping the filename is BLOCKED.

**The shared ledger is a DERIVED PROJECTION — never a log, never a write surface.** Every work-state transition MUST be appended as a signed event to `burndown-events.js::EVENTS_REL` (`burndown/events.jsonl`) via `appendEvent`, and the ledger MUST be REGENERATED from `foldEvents`. Hand-editing a ledger row, and writing a row in place of emitting an event, are both BLOCKED — a hand-edit is silently reverted by the next regeneration, so the work it recorded is lost with no diff. The `owner:` cell is PROJECTED, never sourced — correcting attribution means emitting an event, not editing the cell. `owner:` is UNSIGNED convenience attribution, NOT the event's signer (that claim is WITHDRAWN); both halves are UNBUILT — an OPEN finding. Depth: the extract § Rule 1.

**A row-keyed 3-way merge driver MUST NOT be registered on a derived projection** — retaining or re-adding a `merge=coc-ledger` `.gitattributes` entry for one is BLOCKED; concurrency resolves at the EVENT layer, where two clones' appends UNION (superseded marker shape: the extract § Rule 1).

```text
DO: write the attributed operator fragment; append signed events; regenerate the ledger atomically with unsigned owner attribution.
DO NOT: share one notes file, hand-edit ledger rows, install a projection merge driver, or infer identity from a filename.
```

**BLOCKED rationalizations:**

- "Only one operator works in this repo at a time"
- "Atomic rename is overkill for a session notes file"
- "The forest ledger merge driver is too much ceremony for a markdown table"
- "We'll handle conflicts manually when they happen"
- "Editing the row directly is faster than emitting an event"
- "The projection is committed, so it is the record"
- "Keeping the merge driver is harmless on a generated file"
- "I'll fix the owner cell by hand; the event's attribution is wrong"
- "The owner cell came off a signature, so it is verified attribution"
- "The filename already tells us whose fragment it is"
- "`display_id` is unique in practice, so the filename is a safe key"
- "Adding the frontmatter is redundant when the path already encodes it"

**Why:** Single-shared-file is structurally identical to journal-numbering collision (Rule 2) — both fail silently because the writer never observes the other writer's bytes. A row-keyed merge of a PROJECTION is worse: it produces a state that is no branch's fold yet carries a clean-merge receipt, so the corruption is invisible until someone regenerates. The attribution half fails the same way: `display_id` is collision-TOLERANT, so two operators sharing one land on a single path and the loser's fragment is overwritten with no signal. Mechanism + attribution provenance: the extract § Rule 1.

### 2. Journal Slot Reservation Reads From The Fold, Not The Filesystem

Every `journal/NNNN-*.md` write MUST acquire its slot via `reserveJournalSlotSigned(...)` — NEVER the pure `reserveJournalSlot(...)` (dry-run only), and NEVER a filesystem `ls journal/` scan alone: the authoritative high-water-mark is the fold-accepted coordination log (totally ordered per-emitter). The filename MUST embed the operator's `<display_id>`: `NNNN-<display_id>-TYPE-slug.md`. Every entry's frontmatter MUST carry `verified_id`+`person_id`+`display_id` — frontmatter, NOT filename, is the authoritative attribution surface. On close a signed `journal-body-anchor` record MUST be emitted pinning the entry's path, content hash and slot-record ref; fold-time re-hash detects body tamper and names the anchor's SIGNER, not the frontmatter author. Helper signatures, record payload, emit/fold mechanics, the FSUB 2026-06-11 evidence, the §4.5 residual: the extract § Rule 2.

```text
DO: reserveJournalSlotSigned → attributed journal file → signed journal-body-anchor on close.
DO NOT: allocate from an ls scan, omit the operator filename token, or skip the body anchor.
```

**BLOCKED rationalizations:**

- "The filesystem scan is good enough; we have only ~12 operators"
- "We don't need display_id in the filename if frontmatter carries it"
- "Body anchor is post-hoc forensics; not worth the per-write cost"
- "Two operators on the same NNNN can rename later"

**Why:** Filesystem high-water reads race because the writer cannot see another writer's in-flight bytes; the fold-accepted log is totally ordered per-emitter. Same-`seq` collision mechanics + the §4.5 residual the body anchor answers: the extract § Rule 2.

### 3. /codify Acquires A Lease Covering Mandatory Codify-Class Files

Every `/codify` MUST acquire a structural lease via `acquireCodifyLease({displayId, scopeFiles})` as Step 0, BEFORE any artifact edit. The scope MUST auto-union `scopeFiles` with MANDATORY_SCOPE (`.claude/learning/learning-codified.json` + `.claude/.proposals/latest.yaml`); callers cannot opt out. On a conflict result the orchestrator MUST surface the conflicting `display_id` + `acquired_at` + scope overlap verbatim and STOP — silent proceed is BLOCKED per `rules/zero-tolerance.md` Rule 3. **A SAME-OPERATOR conflict is a distinct case and the result says so** (`same_operator: true`): the surfaced text MUST name that rather than report a stranger. On success all edits MUST land on **the branch the lease RECORDS** — `res.branch`, whatever it is named — and end-of-session opens a PR + admin-merge per `rules/coc-sync-landing.md` MUST-3. **Authorization is by LEASE COVERAGE, never by branch NAME** — never the `codify/<display_id>-<date>` SHAPE. Release MUST call `releaseCodifyLease({repoDir, displayId})`; callers MUST NOT supply `leasePath`. Acquire and release each emit a signed coordination-log record; an emission failure does NOT void the lease but MUST be surfaced verbatim from the result's `record_emit` field. Return shapes, record payloads, the `findCoveringLease` reader contract, the kailash-tier note, Sec-MED-3: the extract § Rule 3.

```text
DO: acquireCodifyLease → surface conflict and stop, or edit only res.branch → PR + merge → release via repoDir.
DO NOT: proceed unleased, ignore same_operator, authorize by branch spelling, or supply leasePath.
```

**BLOCKED rationalizations:**

- "Solo session, no concurrent /codify to worry about"
- "I'll add the lease when we see a collision"
- "The caller knows the scope, no need to union mandatory files"
- "Passing leasePath explicitly is more flexible"

**Why:** Two concurrent `/codify` invocations writing `.claude/.proposals/latest.yaml` produce a last-writer-wins clobber that drops one operator's entire knowledge-extraction cycle. Auto-union + internal `leasePath` rationale: the extract § Rule 3.

### 4. Team-Memory Lives Under .claude/team-memory/ — One File Per Fact

Every shared, signed team-memory fact MUST live in its own `.claude/team-memory/<topic-slug>.md`. The split rule — one fact per file — is non-negotiable; an aggregate `team-memory.md` is BLOCKED. Promotion MUST happen via `/codify` Step 4b: the file lands on the codify lease branch. Each file MUST carry frontmatter `promoted_by`, `signed`, `body_anchor` stamped by `coc-append.js` at merge time; drafts leave them `pending`/`false`. Reads MUST be validated by `integrity-guard.js`; a file failing integrity MUST be treated as absent, NEVER displayed as authoritative.

```text
DO: one signed fact per .claude/team-memory/<topic>.md; validate integrity before reading.
DO NOT: combine facts into team-memory.md or trust an integrity-failed file.
```

**BLOCKED rationalizations:**

- "A consolidated team-memory.md is easier to read"
- "We can split later when N grows"
- "Signed attribution is overkill for shared facts"
- "Treating an integrity-failed file as absent loses information"

**Why:** The aggregate-file pattern reproduces the `.session-notes` single-writer contention at the team-memory layer. Split-rule, signed-attribution and integrity-failed-is-absent rationale: the extract § Rule 4.

### 5. /onboard Is A Deterministic Read-Path Delegating Procedure To The Skill

`/onboard` MUST be a read-only command — no commits, roster writes, posture writes, lease writes, or log writes. Its body MUST stay ≤150 lines per `rules/cc-artifacts.md` Rule 3; the procedural runbook MUST live in `.claude/skills/41-onboard/` (contents: the extract § Rule 5). The command MUST surface artifacts in fixed order: Operator → Team Memory → Workspace → Posture → Claims → Codify Lease → Rules Changed → Action Items. Identity MUST come from `operator-id.js::resolveIdentity()`; an unregistered operator MUST stop and surface `/whoami --register`. The Codify Lease section MUST call `readActiveLease()` and name the holder + branch + acquired_at when held.

```text
DO: read-only onboarding: identity → team-memory → workspace → posture → claims → lease → rules-changed → Action Items.
DO NOT: write state, exceed 150 command lines, or reorder by urgency; procedure stays in skills/41-onboard/.
```

**BLOCKED rationalizations:**

- "A larger command body keeps the runbook close to the entry point"
- "Auto-running genesis when the roster is missing helps the new operator"
- "Section order should adapt to what the operator needs most"
- "/onboard could quietly fix posture corruption it detects"

**Why:** Two operators joining the same repo MUST see identical state in identical order — otherwise the briefing becomes a personal narrative rather than a deterministic surface. Read-only makes `/onboard` safe to invoke at any time without side effects. Skill-vs-command split contract: the extract § Rule 5.

### 6. Append Logs Carry Signed Identity Stamping With Refuse-On-Overflow

Every write to `.claude/learning/observations.jsonl` and `.claude/learning/violations.jsonl` MUST route through `appendStamped(repoDir, filePath, partial, {identity})`. Each line MUST carry `verified_id`+`person_id`+(optionally)`display_id`+a detached `sig` over canonical bytes with `sig` absent. Bare `fs.appendFileSync` with hand-built JSON is BLOCKED. Per Sec-LOW-2 the helper MUST refuse to write rather than truncate-after-signing. Cap + reserve constants, helper path: the extract § Rule 6.

```text
DO: appendStamped(repoDir, filePath, partial, {identity}); surface a typed overflow refusal.
DO NOT: fs.appendFileSync an unsigned row or truncate signed evidence.
```

**BLOCKED rationalizations:**

- "Observations are advisory; signing is overkill"
- "Truncate-after-signing keeps the line under 2KB; the verifier won't notice"
- "Hand-built JSON is faster than calling the helper"
- "A typed error on overflow is a UX regression; silent truncate is friendlier"

**Why:** Append-logs feed the cumulative-violation count for trust-posture downgrade math (`rules/trust-posture.md` MUST Rule 4). An unsigned line cannot be attributed to a human; a row planted by one operator and counted against another corrupts the downgrade signal. Refuse-on-overflow preserves signed-bytes-match-disk-bytes.

## MUST NOT

- Write any of `.session-notes`, `burndown/events.jsonl`, `journal/NNNN-*.md`, `observations.jsonl`, `violations.jsonl`, `.claude/.proposals/latest.yaml`, `.claude/learning/learning-codified.json`, or `.claude/team-memory/*.md` via direct `fs.writeFileSync`/`appendFileSync` bypassing Rules 1–6

**Why:** Every helper exists because direct writes have a known concurrent-clobber failure mode. Bypass IS the failure mode this rule blocks.

- Treat a body-anchor finding as accusing the journal's frontmatter author when the anchor predicate names a DIFFERENT signer

**Why:** The accountable party is the SIGNER of the anchor record; an insider with their own signing key can anchor a journal file they did not author. Misattributing the frontmatter author cryptographically frames an innocent operator and lets the forger walk. (§4.5 residual: the extract § Rule 2.)

- Synchronize `posture.json`, `violations.jsonl`, `coordination-log.jsonl`, or any other `.claude/learning/` state across repos via `/sync`/`/sync-to-build`

**Why:** State is per-repo per `rules/trust-posture.md` MUST NOT clause. Insight (rules, skills, hooks) syncs through `/codify` + `/sync`; state stays local. A USE template inheriting BUILD-repo state would corrupt every downstream consumer.

- Skip the `/codify` lease "because it's a trivial codify"

**Why:** Trivial codifies still write `latest.yaml` and `learning-codified.json`; lease scope is structural, not value-weighted. A trivial clobbering an in-flight large codify produces the same data loss as a large-vs-large clobber.

- Consolidate `.claude/team-memory/*.md` into a single aggregate file "for readability"

**Why:** Aggregate consolidation re-introduces the multi-writer contention the split rule structurally fences. Readability is addressed by an index file or `/onboard` rendering, NEVER by collapsing the split.

## Trust Posture Wiring — Fragment Attribution Is Frontmatter, Not Filename

Applies to the **Rule 1 fragment-attribution sentences** ONLY (added 2026-08-21). Canonical-8-field per `trust-posture.md` MUST-8; the rule-wide block below governs Rules 1–6 and stays grandfathered. All depth: the extract § Trust Posture Wiring — Fragment Attribution.

- **Severity:** `halt-and-report` at gate-review; `advisory` at the hook layer per `hook-output-discipline.md` MUST-2.
- **Grace period:** 7 days from clause landing (2026-08-21 → 2026-08-28).
- **Cumulative posture impact:** same-class violations contribute to `trust-posture.md` MUST-4 cumulative math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** the GENERIC `regression_within_grace` trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — no dedicated key. Named deviation per `trust-posture.md` Rule 8.
- **Receipt requirement:** SessionStart soft-gate `[ack: knowledge-convergence]` IFF `posture.json::pending_verification` includes the `knowledge-convergence` rule_id (shared; one ack covers this file).
- **Detection mechanism:** structural + review. `_buildFragmentBody` stamps the triple and `regenerateAggregate` reads it via `readFragmentAttribution`, so writer and reader comply by construction; a NEW consumer is the only reintroduction path. No probe suite ships — covered by the dated `phase2-deferrals.json` acceptance (expires 2026-12-11); semantic tier UNCOVERED, owed via `/test-harness-probe`.
- **Violation scope:** the Rule 1 fragment-attribution sentences ONLY (clause-scoped). Each row names the fragment path and whether the failure was a MISSING stamp (writer) or a filename-derived attribution (reader).
- **Origin:** 2026-08-21 — canon loom held two fragments for ONE human with no in-file identity; a triage lane read the stale one as another operator's.

## Trust Posture Wiring — MUST-1 Log/Projection Split (added 2026-08-23)

Applies to the **MUST-1 derived-projection sentences ONLY** (transitions-are-events, regenerate, no-hand-edit, projected-`owner:`, no-driver-on-a-projection); canonical-8-field per `trust-posture.md` MUST-8. The rule-wide block below governs MUST-2..6 + MUST-1's split/atomic-write halves and STAYS GRANDFATHERED until itself `/codify`-touched.

- **Severity:** `halt-and-report` at gate-review (cc-architect at `/codify` + reviewer at `/implement` confirm every transition was emitted as an event and the ledger regenerated, not written); `advisory` at the hook layer per `rules/hook-output-discipline.md` MUST-2 (rationale: the extract § Rule 1).
- **Grace period:** 7 days from clause landing (2026-08-23 → 2026-08-30).
- **Cumulative posture impact:** same-class violations (a transition written into the projection instead of emitted; a hand-edited row; an `owner:` cell hand-corrected; a `merge=coc-ledger` entry retained for a derived projection) contribute to `trust-posture.md` MUST-4 cumulative math (3× same-rule / 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** the GENERIC `regression_within_grace` trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — no dedicated key (retired, loom#2102; the record: the extract § MUST-1 Wiring Regression-within-grace). Named deviation from key-per-clause per `trust-posture.md` Rule 8, with this clause's OWN reason (non-corrupting, bounded to re-work): the extract § Trust Posture Wiring.
- **Receipt requirement:** as the fragment-attribution block above (shared rule_id; one ack covers this file).
- **Detection mechanism:** structural + review; the structural half PARTLY ships. `burndown-events.js::validateEvent` + `foldEvents` + `appendEvent` refuse malformed, mis-authorized, genesis-overwriting and unsigned events (per-refusal list: the extract § Rule 1); `todo-tracker-guard.js` surfaces the typed refusal as `halt-and-report`. No HOOK-REGISTERED detector separates a REGENERATION from a HAND-EDIT, but `node .claude/bin/forest-ledger-project.mjs --check` IS that discriminator (exit 0 `IN SYNC` / 1 `DRIFT` / 2 `REFUSED`). It fires only when run, so cc-architect MUST run it at `/codify` alongside confirming each ledger delta has a matching `burndown/events.jsonl` append. It reports THAT the file diverged, never why. Also uncovered: `owner:`'s signer binding (MUST-1). **Probes: REGISTERED — `.claude/test-harness/probes/knowledge-convergence.probes.json`**, 16 rows in 8 bipolar `pair_id` pairs (one per derived clause — MUST-1..6 and MUST NOT — plus a surface-equalized meta-compliance pair), with candidate fixtures + `.expected` answer-key sidecars at `.claude/audit-fixtures/knowledge-convergence/`. Registered in `eval-manifest.json` (probe-only), pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`; no workflow invokes `coc-probe-dispatch.mjs`. The `MUST-1-firing` pair is the one scoped to THIS clause. Depth — that bookkeeping and the pole diff — lives in `.claude/guides/rule-extracts/knowledge-convergence.md` § Probe registration + dispatch bookkeeping and § MUST-1 Wiring Detection.
- **Violation scope:** the MUST-1 derived-projection sentences ONLY (clause-scoped). Each `violations.jsonl` row names the row id and the failed mandate — event-not-emitted, row-hand-edited, `owner:` hand-corrected, or driver-retained. MUST-1's split/atomic-write halves and MUST-2..6 stay under the rule-wide block below.
- **Origin:** See § Origin (2026-08-22 operator-ratified log/projection split).

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer / cc-architect at `/codify`); `advisory` at the hook layer per `rules/hook-output-discipline.md` MUST-2 (rationale: the extract § Trust Posture Wiring).
- **Grace period:** 7 days from this rule landing.
- **Cumulative posture impact:** any same-class violation contributes to cumulative-downgrade math per `rules/trust-posture.md` MUST Rule 4 (3× same-rule / 5× total in 30 days → drop one posture).
- **Regression-within-grace:** any same-class violation (six-member enumeration + the dedicated-key withdrawal record: the extract § Trust Posture Wiring) within 7 days triggers emergency downgrade L5→L4 per `rules/trust-posture.md` MUST Rule 4. Routed through the GENERIC `regression_within_grace` trigger (1× = drop 1 posture) — no dedicated key; Rule-8 deviation: the structural cases are refused by `burndown-events.js::validateEvent` / `foldEvents` / `appendEvent` (see the MUST-1 Wiring block above).
- **Receipt requirement:** SessionStart MUST require `[ack: knowledge-convergence]` in the agent's first response IF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 — review-layer mechanical sweep at `/codify`: `cc-architect` runs the five greps enumerated in the extract § Trust Posture Wiring. **Probes: REGISTERED** — `.claude/test-harness/probes/knowledge-convergence.probes.json` (16 rows, 8 bipolar pairs covering MUST-1..6, MUST NOT and meta-compliance; fixtures `.claude/audit-fixtures/knowledge-convergence/`); registration + dispatch semantics in the MUST-1 block above. Phase 2 (after ≥3 real sessions exercise Phase 1): hook-layer detector at `.claude/hooks/lib/violation-patterns.js::detectKnowledgeConvergenceBypass` on PostToolUse(Edit|Write), advisory.
- **Violation scope:** `operator`. Every `violations.jsonl` row records the emitting operator's `person_id` per Rule 6; downgrades are per-operator (§6.2: the extract § Trust Posture Wiring).
- **Origin:** See § Origin below.

## Origin

Co-owner brief 2026-05-19 — multi-operator-coc CONVERGED (Shard M6 D, PR #323; Shard M7 E, PR #324). Full citation chain + receipts `0112`/`0122`/`0132`/`0133`: the extract § Origin.

**MUST-1 log/projection amendment — 2026-08-22 operator ratification.** Diagnosis, substrate, ssh-signing measurement, Rule-10 non-firing record: the extract § Rule 1 — The 2026-08-22 Log/Projection Amendment.

**Extraction record — 2026-08-19 cleanup + the 2026-08-23 signer-claim withdrawal, ZERO de-scoping; Rule 10 / Rule 11 do NOT fire (path-scoped):** the extract § Extraction Record.
