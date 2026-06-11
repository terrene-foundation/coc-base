---
name: knowledge-convergence
description: "Multi-operator knowledge convergence: single-writer artifact splits, journal slot reservation + body-hash anchor, /codify lease, team-memory split rule, /onboard read-path, signed append-log identity stamping."
priority: 10
scope: path-scoped
paths:
  - ".claude/rules/**"
  - ".claude/team-memory/**"
  - ".claude/learning/**"
  - "**/journal/**"
  - ".claude/commands/codify.md"
  - ".session-notes*"
  - ".session-notes.d/**"
  - ".claude/.proposals/**"
---

# Knowledge Convergence — Multi-Operator Single-Writer Discipline

Under N concurrent operators against one shared repo, every artifact that historically had ONE writer per session — `.session-notes`, `journal/NNNN-*.md`, `observations.jsonl`, `violations.jsonl`, `.claude/.proposals/latest.yaml`, `.claude/learning/learning-codified.json`, team-shared memory facts — becomes a multi-writer contention surface. Two operators each scanning `ls journal/` reach the same next-number and clobber; two `/codify` sessions race on `latest.yaml` and drop one operator's bullets; two `.session-notes` writes overwrite each other. The structural defenses below — per-operator artifact splits, signed identity stamping, fold-anchored slot reservation, body-hash anchoring, the codify lease, the team-memory split rule, and the deterministic `/onboard` read-path — turn silent loss into either clean parallel writes or loud, named, recoverable conflict.

**Citation note for downstream consumers:** The Origin footer below cites `workspaces/multi-operator-coc/02-plans/01-architecture.md` §§5/7/8/9/11/4.5 as the original architectural derivation. That spec is **loom-internal** (project-local working state, not shipped via `/sync`); the citations are **pointers to derivation** for loom-side auditors. The rule body's MUST clauses are **self-contained and authoritative**; downstream consumers act on the prose here, not on the cited spec. Committed durable receipts: journal entries (root `loom/journal/`) `0112` (architecture), `0122` (convergence), `0132` (M6+M7 convergence), `0133` (Sec-MED-3 disposition).

## MUST Rules

### 1. Per-Operator Artifact Splits With Atomic Write + 3-Way Merge

`.session-notes` MUST be split into per-operator fragments at `.session-notes.d/<display_id>.md` and a shared forest ledger at `.session-notes.shared.md` carrying a per-row `owner:` attribution cell. Every write MUST use atomic `.tmp` + `rename()` with `O_EXCL` + mode `0o600` + `lstat` parent + `fsync` per M6 D. The `coc-ledger` merge driver (registered in `.gitattributes`) MUST perform 3-way per-row merge keyed on the first column; divergent-owner edits emit `<<<<<<< owner=alice ... >>>>>>> owner=bob` conflict markers naming the contending operators. A single shared `.session-notes` file is BLOCKED.

```text
# DO — per-operator fragment + shared forest ledger + atomic write
.session-notes.d/alice.md     ← alice's session fragment (alice-only writer)
.session-notes.d/bob.md       ← bob's session fragment (bob-only writer)
.session-notes.shared.md      ← forest ledger; per-row owner: cell;
                                coc-ledger merge driver in .gitattributes;
                                regenerated read-only via atomic .tmp+rename()

# DO NOT — single shared .session-notes (two concurrent writes silently clobber)
.session-notes                ← one operator's write wins; the other's lost
```

**BLOCKED rationalizations:**

- "Only one operator works in this repo at a time"
- "Atomic rename is overkill for a session notes file"
- "The forest ledger merge driver is too much ceremony for a markdown table"
- "We'll handle conflicts manually when they happen"

**Why:** Single-shared-file is structurally identical to journal-numbering collision (Rule 2) — both fail silently because the writer never observes the other writer's bytes. The split-plus-driver converts silent loss into either clean parallel writes (different `<display_id>` fragments never collide) or loud, named conflict (owner-tagged markers surface BOTH contributions). Per §5.1 + Sec-LOW-1: the `owner:` ledger cell is human-readable attribution only; authoritative attribution lives in the signed coordination-log slot record (Rule 2).

### 2. Journal Slot Reservation Reads From The Fold, Not The Filesystem

Every `journal/NNNN-*.md` write MUST acquire its slot via `reserveJournalSlotSigned(repoDir, {dir, identity, type, topic})` (from `.claude/hooks/lib/journal-reserve.js`) — the signed variant computes the slot from `max(disk high-water, fold-accepted reservation high-water)` AND emits the signed `journal-slot-reservation` coordination-log record (via `coc-emit.js::emitSignedRecord`) that `journal-write-guard.js` folds for its slot-reserved check; the pure `reserveJournalSlot(dir, opts)` computation emits nothing and is for dry runs only (FSUB 2026-06-11 — pre-wiring, every journal Write halt-and-reported "slot unreserved" even after dutiful manual reservation). The authoritative high-water-mark is the fold-accepted coordination log (totally ordered per-emitter), NOT a filesystem `ls journal/` scan alone. The filename MUST embed the operator's `<display_id>`: `NNNN-<display_id>-TYPE-slug.md`. Every entry's frontmatter MUST carry `verified_id`+`person_id`+`display_id` — frontmatter, NOT filename, is the authoritative attribution surface. On close, a signed `journal-body-anchor` coordination-log record MUST be emitted pinning `{path, sha256_of_content_bytes, slot_record_ref}` (via `journal-body-anchor.js::buildAnchorRecord`); fold-time re-hash detects body tamper and names the anchor's SIGNER (not the frontmatter author) per the §4.5 signer-vs-author residual.

```text
# DO — fold-anchored slot via reserveJournalSlotSigned(repoDir, {dir, identity, type, topic});
#      emits the signed journal-slot-reservation record AND returns the reservation;
#      writes journal/NNNN-<display_id>-TYPE-slug.md (e.g. 0042-alice-DECISION-foo.md)
#      with frontmatter verified_id+person_id+display_id; on close emit signed
#      journal-body-anchor coordination-log record (buildAnchorRecord partial →
#      coc-emit.js::emitSignedRecord fills the chain envelope + signs + appends).

# DO NOT — fs scan high-water (race) + plain NNNN-TYPE-slug filename + no body anchor
```

**BLOCKED rationalizations:**

- "The filesystem scan is good enough; we have only ~12 operators"
- "We don't need display_id in the filename if frontmatter carries it"
- "Body anchor is post-hoc forensics; not worth the per-write cost"
- "Two operators on the same NNNN can rename later"

**Why:** Filesystem high-water reads race because the writer cannot see another writer's in-flight bytes; the fold-accepted log is totally ordered per-emitter. The `<display_id>` filename token converts a same-`seq` collision (CAN happen during partial-push windows per architecture §5.2) from "one writer overwrites the other" into "both entries land on disk, distinguishable by name." The body-anchor is the cryptographic answer to the §4.5 equivocation-parity residual: tamper is detected at fold-time when re-hashing diverges from the signed anchor; per `journal-body-anchor.js`, the accountable party is the anchor's SIGNER, NOT the frontmatter author.

### 3. /codify Acquires A Lease Covering Mandatory Codify-Class Files

Every `/codify` MUST acquire a structural lease via `acquireCodifyLease({displayId, scopeFiles})` (from `.claude/hooks/lib/codify-lease.js`) as Step 0, BEFORE any artifact edit. The lease scope MUST union `scopeFiles` with MANDATORY_SCOPE (`.claude/learning/learning-codified.json` + `.claude/.proposals/latest.yaml`) automatically; callers cannot opt out. On `{ok: false, reason: "conflict"}` the orchestrator MUST surface the conflicting `display_id` + `acquired_at` + scope overlap verbatim and STOP — silent proceed is BLOCKED per `rules/zero-tolerance.md` Rule 3. On `{ok: true}` all edits MUST land on the lease's `codify/<display_id>-<date>` branch; end-of-session opens a PR + admin-merge per `rules/coc-sync-landing.md` MUST-3. Release MUST call `releaseCodifyLease({repoDir, displayId})` — the helper derives `leasePath` from `repoDir` internally per Sec-MED-3; callers MUST NOT supply `leasePath` to misroute the write. Acquire and release each emit a signed coordination-log record (`codify-lease` / `codify-lease-release`, FSUB 2026-06-11) — acquire carries `{lease_id, branch, date, scope_files, scope_fingerprint}` matching the reader contract `integrity-guard.js::findCoveringLease` folds (branch + signer + scope path/prefix covering check); release pairs by `lease_id`. This is the cross-clone visibility surface for the on-disk local mutex; an emission failure does NOT void the lease but MUST be surfaced verbatim from the result's `record_emit` field.

```text
# DO — Step 0: res = acquireCodifyLease({displayId, scopeFiles}); on conflict, surface
#      res.conflicting.display_id verbatim + STOP; on ok, edits on res.branch
#      (codify/<display_id>-<date>) → PR + admin-merge; release via repoDir only.

# DO NOT — proceed without lease (concurrent /codify clobbers latest.yaml), or
#          supply leasePath to release (misroutes per Sec-MED-3; helper ignores it).
```

**BLOCKED rationalizations:**

- "Solo session, no concurrent /codify to worry about"
- "I'll add the lease when we see a collision"
- "The caller knows the scope, no need to union mandatory files"
- "Passing leasePath explicitly is more flexible"

**Why:** Two concurrent `/codify` invocations writing `.claude/.proposals/latest.yaml` produce a last-writer-wins clobber that drops one operator's entire knowledge-extraction cycle — the concurrency-time form of the failure `rules/artifact-flow.md` § "Append, Never Overwrite Unprocessed Proposals" calls out. The lease races for the branch namespace, not the working tree. MANDATORY_SCOPE auto-unioning closes the "caller forgot to declare the mandatory files" gap; the internal `leasePath` derivation closes the Sec-MED-3 release-misroute surface.

### 4. Team-Memory Lives Under .claude/team-memory/ — One File Per Fact

Every shared, signed team-memory fact MUST live in its own `.claude/team-memory/<topic-slug>.md`. The split rule — one fact per file — is non-negotiable; an aggregate `team-memory.md` is BLOCKED. Promotion MUST happen via `/codify` Step 4b: the file lands on the codify lease branch. Each file MUST carry frontmatter `promoted_by`, `signed`, `body_anchor` populated by `.claude/hooks/lib/coc-append.js` at merge time — drafts leave them `pending`/`false`. Reads MUST be validated by `integrity-guard.js`; a file failing integrity MUST be treated as absent, NEVER displayed as authoritative.

```text
# DO — split rule: one fact per file; frontmatter signed:true, promoted_by:
#      {display_id, verified_id}, body_anchor sha256 stamped by coc-append
.claude/team-memory/canonical-build-targets.md   ← one fact
.claude/team-memory/deploy-window-policy.md      ← one fact

# DO NOT — aggregate (two operators promoting concurrently silently clobber)
.claude/team-memory/team-memory.md               ← multiple facts in one body
```

**BLOCKED rationalizations:**

- "A consolidated team-memory.md is easier to read"
- "We can split later when N grows"
- "Signed attribution is overkill for shared facts"
- "Treating an integrity-failed file as absent loses information"

**Why:** The aggregate-file pattern reproduces the `.session-notes` single-writer contention at the team-memory layer. The split rule makes each fact an independent write surface — concurrent promotions of different facts never collide; same-fact promotions surface as a normal codify-lease conflict (Rule 3). Signed attribution distinguishes a team-memory fact from a personal note planted as "team consensus"; integrity-failed files are treated as absent because trusting unverified attribution propagates the forgery.

### 5. /onboard Is A Deterministic Read-Path Delegating Procedure To The Skill

`/onboard` MUST be a read-only command — no commits, roster writes, posture writes, lease writes, or log writes. Its body MUST stay ≤150 lines per `rules/cc-artifacts.md` Rule 3; the procedural runbook (failure-mode handling, JSON schema, integrity-fail formatting, surface↔helper↔shape matrix) MUST live in `.claude/skills/41-onboard/`. The command MUST surface artifacts in fixed order — Operator → Team Memory → Workspace → Posture → Claims → Codify Lease → Rules Changed → Action Items — so two operators against the same repo see consistent state. Identity MUST come from `operator-id.js::resolveIdentity()`; an unregistered operator MUST stop and surface `/whoami --register`. The Codify Lease section MUST call `readActiveLease()` and name the holder + branch + acquired_at when held.

```text
# DO — read-only ≤150-line body; resolve identity → team-memory → workspace →
#      posture → claims → codify lease → rules-changed → Action Items.
#      Procedure detail lives in skills/41-onboard/SKILL.md.

# DO NOT — oversized body that writes state (acquireCodifyLease, runs roster
#          genesis ceremony) or reorders sections per "urgency"
```

**BLOCKED rationalizations:**

- "A larger command body keeps the runbook close to the entry point"
- "Auto-running genesis when the roster is missing helps the new operator"
- "Section order should adapt to what the operator needs most"
- "/onboard could quietly fix posture corruption it detects"

**Why:** Two operators joining the same repo MUST see identical state in identical order — otherwise the briefing becomes a personal narrative rather than a deterministic surface. Read-only makes `/onboard` safe to invoke at any time without side effects. The skill-vs-command split is the `rules/cc-artifacts.md` Rule 3 contract: command bodies are entry points (≤150 lines), skills carry procedural depth.

### 6. Append Logs Carry Signed Identity Stamping With Refuse-On-Overflow

Every write to `.claude/learning/observations.jsonl` and `.claude/learning/violations.jsonl` MUST route through `appendStamped(repoDir, filePath, partial, {identity})` (from `.claude/hooks/lib/coc-append.js`). Each line MUST carry `verified_id`+`person_id`+(optionally)`display_id`+a detached `sig` over canonical bytes with `sig` absent. Bare `fs.appendFileSync` with hand-built JSON is BLOCKED. Per Sec-LOW-2 (M6 D), the helper MUST refuse to write rather than truncate-after-signing: a pre-sign probe checks `serialized + ~128B sig reserve > MAX_LINE_BYTES (2048)` and returns typed `record too large`; a post-sign final guard refuses if the signature exceeded the reserve. This preserves the signed-bytes-match-disk-bytes invariant.

```text
# DO — stamped, signed, refuse-on-overflow
r = appendStamped(repoDir, ".claude/learning/violations.jsonl", partial, {identity});
if (!r.ok) { /* surface r.reason; do NOT silently truncate evidence and retry */ }

# DO NOT — bare append, no identity stamping, silent truncate on overflow
fs.appendFileSync(".claude/learning/violations.jsonl", JSON.stringify(partial) + "\n");
# no verified_id, no sig — forensic scan cannot attribute the row to a human
```

**BLOCKED rationalizations:**

- "Observations are advisory; signing is overkill"
- "Truncate-after-signing keeps the line under 2KB; the verifier won't notice"
- "Hand-built JSON is faster than calling the helper"
- "A typed error on overflow is a UX regression; silent truncate is friendlier"

**Why:** Append-logs feed the cumulative-violation count for trust-posture downgrade math (`rules/trust-posture.md` MUST Rule 4). An unsigned line cannot be attributed to a human; a row planted by one operator and counted against another corrupts the downgrade signal. Truncate-after-signing was the M6 D Sec-LOW-2 bug — the signature covered pre-truncation bytes but disk bytes were post-truncation; verifiers re-canonicalizing the parsed line failed verification, silently making the line un-attributable. Refuse-on-overflow preserves signed-bytes-match-disk-bytes.

## MUST NOT

- Write any of `.session-notes`, `journal/NNNN-*.md`, `observations.jsonl`, `violations.jsonl`, `.claude/.proposals/latest.yaml`, `.claude/learning/learning-codified.json`, or `.claude/team-memory/*.md` via direct `fs.writeFileSync`/`appendFileSync` bypassing Rules 1–6

**Why:** Every helper exists because direct writes have a known concurrent-clobber failure mode. Bypass IS the failure mode this rule blocks.

- Treat a body-anchor finding as accusing the journal's frontmatter author when the anchor predicate names a DIFFERENT signer

**Why:** Per architecture §4.5 body-anchor residual, the accountable party is the SIGNER of the anchor record; an insider with their own signing key can anchor a journal file they did not author. Misattributing the frontmatter author cryptographically frames an innocent operator and lets the forger walk.

- Synchronize `posture.json`, `violations.jsonl`, `coordination-log.jsonl`, or any other `.claude/learning/` state across repos via `/sync`/`/sync-to-build`

**Why:** State is per-repo per `rules/trust-posture.md` MUST NOT clause. Insight (rules, skills, hooks) syncs through `/codify` + `/sync`; state stays local. A USE template inheriting BUILD-repo state would corrupt every downstream consumer.

- Skip the `/codify` lease "because it's a trivial codify"

**Why:** Trivial codifies still write `latest.yaml` and `learning-codified.json`; lease scope is structural, not value-weighted. A trivial clobbering an in-flight large codify produces the same data loss as a large-vs-large clobber.

- Consolidate `.claude/team-memory/*.md` into a single aggregate file "for readability"

**Why:** Aggregate consolidation re-introduces the multi-writer contention the split rule structurally fences. Readability is addressed by an index file or `/onboard` rendering, NEVER by collapsing the split.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer / cc-architect at `/codify`); `advisory` at the hook layer (file-write surfaces are mediated by helpers emitting typed errors per `rules/zero-tolerance.md` Rule 3 — block teeth would re-introduce false-positive risk per `rules/hook-output-discipline.md` MUST-2).
- **Grace period:** 7 days from this rule landing.
- **Cumulative posture impact:** any same-class violation contributes to cumulative-downgrade math per `rules/trust-posture.md` MUST Rule 4 (3× same-rule / 5× total in 30 days → drop one posture).
- **Regression-within-grace:** any same-class violation (bare write to a contended artifact, journal entry without slot-reservation, `/codify` without lease, body-anchor mis-attribution, aggregate team-memory file, unsigned append-log line) within 7 days triggers emergency downgrade L5→L4 per `rules/trust-posture.md` MUST Rule 4. Trigger key `multi_operator_artifact_bypass` is added to that rule's emergency-trigger list (1× = drop 1 posture).
- **Receipt requirement:** SessionStart MUST require `[ack: knowledge-convergence]` in the agent's first response IF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 — review-layer mechanical sweep at `/codify`. `cc-architect` greps for (a) `fs.writeFileSync`/`appendFileSync` against contended-artifact paths, (b) journal entries with no `verified_id` frontmatter, (c) `/codify` invocations with no `acquireCodifyLease`, (d) `.claude/team-memory/team-memory.md` existence, (e) `observations.jsonl`/`violations.jsonl` lines missing `sig`. Phase 2 (after ≥3 real sessions exercise Phase 1): hook-layer detector at `.claude/hooks/lib/violation-patterns.js::detectKnowledgeConvergenceBypass` on PostToolUse(Edit|Write), advisory.
- **Violation scope:** `operator`. Every `violations.jsonl` row records the emitting operator's `person_id` per Rule 6; per-operator posture downgrades follow architecture §6.2.
- **Origin:** See § Origin below.

## Origin

`workspaces/multi-operator-coc/02-plans/01-architecture.md` §§5 (single-writer artifact contention — Shard M6 D), §7 (knowledge convergence — Shard M7 E), §8 (artifact inventory), §9 (artifact discipline ≤150-line command bodies), §11 row D (M6 D shard spec; landed PR #323) + row E (M7 E shard spec; landed PR #324), §4.5 body-anchor signer-vs-author residual (added 2026-05-22). Co-owner brief 2026-05-19 — multi-operator-coc CONVERGED. Receipt-first journal entries (ROOT `loom/journal/`): `0112` (architecture decision-record), `0122` (CONVERGENCE receipt), `0132` (M6 + M7 convergence DECISION receipt #0132), `0133` (Sec-MED-3 audit-trail-completeness residual co-owner DECISION).
