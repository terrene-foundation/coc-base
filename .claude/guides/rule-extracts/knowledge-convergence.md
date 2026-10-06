# Knowledge Convergence — Extended Mechanics, Evidence, and Provenance

Depth companion for `.claude/rules/knowledge-convergence.md`. The rule body carries the CLI-neutral
contract — every MUST, MUST NOT, BLOCKED-rationalization entry, DO/DO-NOT block and `**Why:**`
failure-mode statement lives THERE. This file carries what the rule body points at: the helper
signatures and write primitives, the coordination-log record payloads and reader contracts, the
per-instance shard provenance (M6 D / M7 E / FSUB / Sec-MED-3 / Sec-LOW-1 / Sec-LOW-2), the
architecture-spec citations, the Trust-Posture same-class enumeration and detection sweep, and the
full Origin chain. Read it before authoring or auditing any multi-operator write path — the rule's
obligations are enforceable without it, but no implementation is correct without it.

## Citation Note For Downstream Consumers

Verbatim, as it stood in the rule body:

> **Citation note for downstream consumers:** The Origin footer below cites
> (loom-internal reference) §§5/7/8/9/11/4.5 as the original
> architectural derivation. That spec is **loom-internal** (project-local working state, not shipped
> via `/sync`); the citations are **pointers to derivation** for loom-side auditors. The rule body's
> MUST clauses are **self-contained and authoritative**; downstream consumers act on the prose here,
> not on the cited spec. Committed durable receipts: journal entries (root `loom/journal/`) `0112`
> (architecture), `0122` (convergence), `0132` (M6+M7 convergence), `0133` (Sec-MED-3 disposition).

## Contention Surfaces — The Collision Walkthroughs

The contended set (enumerated normatively in the rule's § MUST NOT) is: `.session-notes`,
`journal/NNNN-*.md`, `observations.jsonl`, `violations.jsonl`, `.claude/.proposals/latest.yaml`,
`.claude/learning/learning-codified.json`, and team-shared memory facts. Each historically had ONE
writer per session; under N concurrent operators each becomes a multi-writer contention surface.
Each collision is silent **because the writer never observes the other writer's bytes** — the
mechanism the rule's preamble points here for, and the one its Rule 1 `**Why:**` restates
normatively.

The three canonical collisions, verbatim from the rule's original preamble:

> Two operators each scanning `ls journal/` reach the same next-number and clobber; two `/codify`
> sessions race on `latest.yaml` and drop one operator's bullets; two `.session-notes` writes
> overwrite each other.

## Rule 1 — Session-Notes Split: Write Primitive, Merge Driver, Attribution

**The atomic write primitive, in full:** atomic `.tmp` + `rename()` with `O_EXCL` + mode `0o600` +
`lstat` parent + `fsync` per M6 D. Every write to a per-operator fragment or to the shared forest
ledger uses it; the shared ledger is regenerated read-only through the same `.tmp`+`rename()` path.

**The merge driver — SUPERSEDED 2026-08-22, recorded as the design that was decided against.**
`coc-ledger` was registered in `.gitattributes` and performed 3-way per-row merge keyed on the
first column, emitting conflict markers naming the contending operators in the shape below. It is
BLOCKED on a derived projection per MUST-1: row-keyed merge of a fold produces a table that is the
fold of NEITHER branch's log — a fabricated state that merges CLEANLY and is detectable only by
regenerating. Concurrency now resolves at the EVENT layer, where two clones' appends UNION. The
marker shape is kept here because the driver still governs any hand-written per-row surface that is
NOT a projection; it is not a live contract for the forest ledger.

```text
<<<<<<< owner=alice
... alice's row ...
=======
... bob's row ...
>>>>>>> owner=bob
```

**Why the split-plus-driver works (mechanism):** it converts silent loss into either clean parallel
writes (different `<display_id>` fragments never collide) or loud, named conflict (owner-tagged
markers surface BOTH contributions).

**Attribution provenance (§5.1 + Sec-LOW-1), verbatim:** the `owner:` ledger cell is human-readable
attribution only; authoritative attribution lives in the signed coordination-log slot record
(Rule 2). Under the log/projection split the cell is additionally PROJECTED at fold time rather than
stamped into the file at write time, so correcting attribution means emitting an event.

**Why frontmatter attribution rather than a filename (the secondary benefit).** Beyond the
collision argument the rule body carries in its `**Why:**`, frontmatter attribution also **survives
a copy, rename, or migration that a filename does not** — the identity travels with the bytes.
This is the same split Rule 2 already sets for journal entries: the filename embeds `display_id`
for human wayfinding, and the frontmatter is the authoritative attribution surface.

**Severity rationale for the MUST-1 log/projection wiring block (why `advisory`, not `block`).**
A REGENERATION of the shared ledger and a HAND-EDIT of it arrive at the hook layer as the SAME
`Write` call against the same path, so the tool call cannot separate them; `block` on that evidence
is barred by `rules/hook-output-discipline.md` MUST-2. The discriminator exists only out-of-band
(`forest-ledger-project.mjs --check`), which is why the Detection field mandates running it at
`/codify` rather than registering a hook.

**SUPERSEDED — the sentence above previously read "PROJECTED from the event's signer".** It is not.
`burndown-events.js::foldProjection` computes `owner: e.display_id || e.person_id || e.verified_id
|| "unknown"` — self-declared identity fields the caller supplies via `appendEvent`'s
`opts.identity` and `coc-append.js` stamps into the row. Those fields ARE covered by the detached
signature over the canonical bytes, so they are tamper-evident after the fact; what does NOT exist
is any read-side check. The fold verifies no signature at all (zero `verify(` / `coc-sign`
references in `burndown-events.js`; the control, `coc-append.js`, has two), and no signer→identity
map exists anywhere, so nothing stops a rostered signer stamping another operator's `display_id`.
The `owner:` cell is UNSIGNED convenience attribution and the authoritative surface remains the
coordination-log slot record. Read-side verification plus a signer→identity binding for the `owner:`
CELL are UNBUILT and are an OPEN finding.

**The parallel `authority` claim is NO LONGER the same disposition, and this cross-reference is
updated rather than left pointing at a comment that has changed.** That claim WAS withdrawn on the
same reasoning; it has since been CLOSED — `verifyAuthorityClaim` binds a role-bound `authority` to
the signer's rostered role, and `burndown-build.mjs::verifySignedLog` applies it over the whole log
after signature verification (see § Per-refusal detail below). The `owner:` CELL is a DIFFERENT
field with a different consumer: it is read by `foldProjection` at RENDER time, which verifies
nothing, so its half stays open. Two fields, two dispositions — reading the `authority` close as
covering the cell would be exactly the over-claim this paragraph exists to prevent.

## Rule 1 — The 2026-08-22 Log/Projection Amendment

**Ratified** by the operator 2026-08-22 BEFORE any implementation, in
(loom-internal reference) (A1 —
transitions are append-only events; A2 — the tracker is a derived projection; C3 — the merge driver
no longer merges a projection).

**The diagnosis.** `.session-notes.shared.md` was a PROJECTION PRETENDING TO BE A LOG:
simultaneously the evidence a verified count is computed from, and a live mutable work surface.
Three symptoms, one cause — `burndown-build.mjs::parseLedger` REFUSES a duplicate row id (a
projection invariant, never a log one); an append-only writer could not be the producer and had to
become an upsert; and the file needed a custom 3-way merge driver, which append-only logs never do.

**The ratified substrate.** A COMMITTED append-only JSONL at
`.claude/hooks/lib/burndown-events.js::EVENTS_REL` (`burndown/events.jsonl`), chosen over riding
the existing coordination log because that path costs a MEASURED 673 ms/append against a 45 ms
producer budget and its transport is unwired (918 of 920 records had never left the machine).

**Signing: ssh-format keys MANDATED,** on measurement rather than preference. A signed append
measures **14.47 ms on ssh-ed25519** (within the 45 ms budget) and **234.07 ms on openpgp** (5.2×
over) — same code path, interleaved in ONE process, so the instrument was shown able to return both
verdicts. Cost accepted knowingly: every operator and downstream consumer on GPG must migrate
before the producer works for them.

**Ordering: FILE ORDER, no synthetic sequence.** A counter is not unique across clones — two
operators each compute `seq = N` and the post-merge fold becomes ambiguous while wearing a total
order's grammar. `timestamp` is an advisory causal witness, explicitly NOT the sort key.

**Genesis is not a transition (C5).** The 267 backfilled items are agent-drafted assertions
re-serialized — no emitter, no timestamp, no signature — so they carry `kind: "genesis"` /
`weight: "migration_baseline"`. The distinction is OPERATIVE: `foldEvents` refuses to let a
`migration_baseline` event overwrite a `live` one for the same `item_id`, whatever the file order,
so re-running the backfill after real work cannot silently revert it.

**Per-refusal detail behind the rule's Detection field.** `validateEvent` refuses an unrecognized
`kind`, a `kind`/`weight` mismatch, an over-long field, and a NON-OWNER transition carrying anything
outside the `todo:` namespace and `see burndown` — a POSITIVE ALLOWLIST since 2026-08-24, not the
`OWNER_STATUSES` denylist it was: exact string equality let `"Signed off "` with a trailing space
through, and a table cell renders it identically. Every status comparison now normalizes through one
shared `statusKey` (NFKC + whitespace-collapse + case-fold). (The allowlist is the structural half of
`burndown-traceability.md` MUST-4's
SELF-DECLARED-AGENT case ONLY — an earlier revision here wrote "the structural half of MUST-4",
which over-claims. `authority` is a self-declared CALLER field and `validateEvent` still passes an
`authority: "owner"` event untouched, because that function sees the caller half, which carries no
`verified_id` at all. That fence is producer-side discipline: it stops the accident, not the
adversary.

**The signer→role map is now BUILT, and the earlier "UNBUILT — an OPEN finding" disposition here is
WITHDRAWN rather than softened.** `burndown-events.js::verifyAuthorityClaim`
(`.claude/hooks/lib/burndown-events.js:920-1036`) resolves a role-bound authority against the
signer's `role` + `host_role` in the COMMITTED roster, read at `HEAD:` by
`readCommittedRoster` (`:760-829`) — never the working tree, which is a trust root the adversary
can write. It is applied on the ONLY write path by `appendEvent` (`:1150`), and over a whole log by
`verifyAuthorityBindings` (`:1053-1087`), which `burndown-build.mjs::verifySignedLog`
(`.claude/bin/burndown-build.mjs:1611`) runs AFTER signature verification — a role resolved from an
unverified `verified_id` would mean nothing. The R5-S-04 audit-only-host exclusion and the role floor are DELEGATED to
`eligibility.js::isEligibleSigner` under the `ledger-authority` signing context rather than inlined
— a fourth inlined `host_role === "ci"` is the drift class MED-3 consolidated and
`audit-fixtures/coordination-log-fold/flag-eligibility-drift-host-role-ci.txt` exists to red on.
Three states are kept distinct and all refuse: BACKED / UNBACKED / INDETERMINATE; the TAXONOMY
stays in `verifyAuthorityClaim` because `isEligibleSigner` is two-state by design.

**Two bounds, named rather than implied away.** The roster is read at CURRENT `HEAD` with no
as-of-record resolution, so an ordinary roster edit made AFTER a record was signed — a person-id
rename, a role change, a move to a CI host — produces the same finding as a bad record; every such
refusal carries that caveat in its own text. As-of-record resolution is not attempted: pinning the
roster blob the signer claims lets them choose the most permissive roster the repo ever had, and
resolving as-of the introducing commit needs per-record history traversal. What is still UNBUILT is the RENDER path: `foldProjection` verifies no
signature and consults no roster, so the projection believes what a hand-written line says — the
same bound `authority: "owner"` already had for `Signed off`. The `owner:` CELL is a separate
question and remains self-declared, as the rule body says.

**Retraction (`kind: "retraction"`, `.claude/hooks/lib/burndown-events.js:266`).** `validateEvent`
additionally refuses a retraction that does not declare `authority: "owner"`, one whose status is
not the derived terminal `retired`, a `retired` status on any OTHER kind, a retraction with no
`reason`, and a `reason` on a non-retraction. A retraction RETIRES IN PLACE: the item keeps its row
in the fold, so `rows.size` is unchanged and `burndown-build.mjs`'s `tracker.min_rows`
log-integrity floor keeps the monotonicity premise it rests on.
`foldEvents` records every unreadable line in `skipped[]` rather than dropping it, so "the log
folded clean" and "the log had six unreadable lines" cannot render identically. `appendEvent`
routes through `appendStamped` (Rule 6), so there is no unsigned path.

**Rule-10 non-firing, recorded.** `rule-authoring.md` Rule 10 § "Trigger scope" binds `priority: 0`
+ `scope: baseline` rules ONLY; `knowledge-convergence.md` is `priority: 10` / `scope:
path-scoped`, so the proximity-band gate does not fire. The amendment was nonetheless paired with
extraction to THIS file after `check-rule-injection-budget.mjs` reported the rule over its 6000 B
per-rule delta allowance — a budget obligation, distinct from Rule 10.

## Rule 2 — Slot Reservation Mechanics + The §4.5 Signer-vs-Author Residual

**Helper location + the two variants.** `reserveJournalSlotSigned(repoDir, {dir, identity, type,
topic})` and the pure `reserveJournalSlot(dir, opts)` both live at `.claude/hooks/lib/journal-reserve.js`.

- The **signed** variant computes the slot from `max(disk high-water, fold-accepted reservation
high-water)` AND emits the signed `journal-slot-reservation` coordination-log record (via
  `coc-emit.js::emitSignedRecord`) that `journal-write-guard.js` folds for its slot-reserved check.
  It returns the reservation.
- The **pure** computation emits nothing and is for dry runs only.

**FSUB 2026-06-11 — the pre-wiring evidence:** before the signed variant was wired, every journal
Write halt-and-reported "slot unreserved" even after dutiful manual reservation. That is the
measured failure that made the signed variant, not the pure computation, the mandated call.

**Body anchor.** On close the signed `journal-body-anchor` coordination-log record pins
`{path, sha256_of_content_bytes, slot_record_ref}`; it is built by
`journal-body-anchor.js::buildAnchorRecord` (a partial) which `coc-emit.js::emitSignedRecord` then
fills with the chain envelope, signs, and appends.

**Same-`seq` collisions (architecture §5.2):** a same-`seq` collision CAN happen during partial-push
windows. The `<display_id>` filename token is what converts it from "one writer overwrites the
other" into "both entries land on disk, distinguishable by name."

**The §4.5 signer-vs-author residual:** the body-anchor is the cryptographic answer to the §4.5
equivocation-parity residual — tamper is detected at fold-time when re-hashing diverges from the
signed anchor; per `journal-body-anchor.js`, the accountable party is the anchor's SIGNER, NOT the
frontmatter author. The rule's § MUST NOT bullet carries this normatively; the residual's derivation
is here. An insider with their own signing key can anchor a journal file they did not author, which
is precisely why the anchor's signer — not the frontmatter `author:` — is the accountable party.

## Rule 3 — Codify-Lease Mechanics (record payloads, reader contract, Sec-MED-3)

**Helper location.** `acquireCodifyLease({displayId, scopeFiles})` and
`releaseCodifyLease({repoDir, displayId})` live at `.claude/hooks/lib/codify-lease.js`.

**Return shapes.** Acquire returns `{ok: false, reason: "conflict"}` with a `conflicting` block
(`display_id`, `acquired_at`, scope overlap) on contention, and `{ok: true}` with `branch` on
success; the rule body's STOP-on-conflict and edits-on-`res.branch` obligations key on exactly
those.

**Signed records (FSUB 2026-06-11).** Acquire and release each emit a signed coordination-log
record — `codify-lease` / `codify-lease-release`. This pair is the cross-clone visibility surface
for the on-disk local mutex. Acquire carries
`{lease_id, branch, date, scope_files, scope_fingerprint}`, matching the reader contract
`integrity-guard.js::findCoveringLease` folds (**signer** + scope path/prefix covering check — the
branch comparison was REMOVED, and the parameter with it, so it cannot be restored by a one-line
edit; authorization is lease COVERAGE, never branch NAME);
release pairs by `lease_id`. This is the cross-clone visibility surface for the on-disk local mutex.
An emission failure does NOT void the lease but MUST be surfaced verbatim from the result's
`record_emit` field (normative — stated in the rule body).

**Why the branch-NAME SHAPE requirement was a defect, not a defense.** The guard matches the
recorded branch plus the signer; it does NOT require the `codify/<display_id>-<date>` shape, and
requiring it was a defect: a branch name is unique per operator per day, and git binds one name to
one worktree, so the shape requirement silently SERIALIZED every codify-class writer onto ONE
working tree — while the lease itself was always worktree-aware. The date-named shape remains the
DEFAULT the helper mints; it is a convention, not the authorization predicate.

**The SAME-OPERATOR conflict case (`same_operator: true`).** It is not a sibling contending for the
scope but the SAME human holding the grant from another session — the grant is shared by
construction, and the MUTEX is what refused. That is why the rule body mandates the surfaced text
name the same-operator case rather than report a stranger.

**Cross-reference for the Rule 3 `**Why:**`.** The concurrent-`latest.yaml` clobber is the
concurrency-time form of the failure `rules/artifact-flow.md` § "Append, Never Overwrite
Unprocessed Proposals" calls out.

**Sec-MED-3 (release misroute).** `releaseCodifyLease` derives `leasePath` from `repoDir`
internally; a caller-supplied `leasePath` misroutes the write. The helper ignores it. The
audit-trail-completeness residual behind this disposition is the co-owner DECISION receipt
`journal/0133`.

**Landing tier note.** The end-of-session PR + admin-merge obligation cites
`rules/coc-sync-landing.md` MUST-3, which is a **kailash tier** rule — absent at a stack-agnostic
base template. The PR-then-admin-merge obligation still holds there.

**Why the two auto-behaviours exist (mechanism):** MANDATORY_SCOPE auto-unioning closes the "caller
forgot to declare the mandatory files" gap; the internal `leasePath` derivation closes the Sec-MED-3
release-misroute surface. The lease races for the branch namespace, not the working tree.

## Rule 4 — Team-Memory Split: Promotion + Integrity Mechanics

**Helpers.** Frontmatter `promoted_by` / `signed` / `body_anchor` is populated by
`.claude/hooks/lib/coc-append.js` at merge time; drafts leave them `pending` / `false`. Reads are
validated by `integrity-guard.js`.

**Promotion path.** `/codify` Step 4b — the file lands on the codify lease branch (Rule 3), so a
same-fact concurrent promotion surfaces as an ordinary codify-lease conflict rather than a silent
clobber, while different-fact promotions never collide at all.

**Why signed attribution (mechanism):** it distinguishes a team-memory fact from a personal note
planted as "team consensus"; integrity-failed files are treated as absent because trusting
unverified attribution propagates the forgery.

## Rule 5 — /onboard Read-Path Runbook Contents

**What MUST live in `.claude/skills/41-onboard/`** (the procedural runbook the ≤150-line command
body delegates to): failure-mode handling, JSON schema, integrity-fail formatting, and the
surface↔helper↔shape matrix.

**The skill-vs-command split** is the `rules/cc-artifacts.md` Rule 3 contract: command bodies are
entry points (≤150 lines), skills carry procedural depth.

**F14 M7 adjudication (INTEGRATION-NOTES forward note, `journal/0132`).** `onboard.md` is
codify-governing IFF the rule's body authors a discipline that governs `/onboard`'s deterministic
read-path interaction with `/codify` (the lease + team-memory promotion both touch onboard's
read-path). Default disposition: include the command in the `self-referential-codify.md` Commands
sub-allowlist — which is where it now sits.

## Rule 6 — Append-Log Stamping: The Sec-LOW-2 Refuse-On-Overflow Probe

**Helper location.** `appendStamped(repoDir, filePath, partial, {identity})` lives at
`.claude/hooks/lib/coc-append.js`.

**The refuse-on-overflow probe, per Sec-LOW-2 (M6 D), with its measured constants verbatim:** a
pre-sign probe checks `serialized + ~128B sig reserve > MAX_LINE_BYTES (2048)` and returns typed
`record too large`; a post-sign final guard refuses if the signature exceeded the reserve. Both
exist to preserve the signed-bytes-match-disk-bytes invariant.

**The originating bug.** Truncate-after-signing was the M6 D Sec-LOW-2 bug — the signature covered
pre-truncation bytes but disk bytes were post-truncation; verifiers re-canonicalizing the parsed
line failed verification, silently making the line un-attributable. (This sentence was REMOVED from the rule
body's `**Why:**` line on 2026-09-07 — see § "Structural-cleanup extraction — 2026-09-07" below.
This section is now its sole home; the rule keeps the surrounding failure-mode statements.)

**Downstream consumer of these logs.** Append-logs feed the cumulative-violation count for
trust-posture downgrade math (`rules/trust-posture.md` MUST Rule 4) — which is why an unsigned line,
un-attributable to a human, corrupts the downgrade signal for a different operator.

## Trust Posture Wiring — Same-Class Enumeration + Detection Sweep

**Severity rationale (why the hook layer is `advisory`, not `block`).** File-write surfaces are
mediated by helpers that emit typed errors per `rules/zero-tolerance.md` Rule 3; block teeth at the
hook layer would re-introduce false-positive risk per `rules/hook-output-discipline.md` MUST-2.

**Same-class violation enumeration** (the set the Regression-within-grace and Cumulative fields key
on), verbatim: a bare write to a contended artifact, a journal entry without slot-reservation, a
`/codify` without lease, a body-anchor mis-attribution, an aggregate team-memory file, an unsigned
append-log line.

**Phase-1 detection sweep — the five greps `cc-architect` runs at `/codify`**, verbatim:

- (a) `fs.writeFileSync` / `appendFileSync` against contended-artifact paths
- (b) journal entries with no `verified_id` frontmatter
- (c) `/codify` invocations with no `acquireCodifyLease`
- (d) `.claude/team-memory/team-memory.md` existence
- (e) `observations.jsonl` / `violations.jsonl` lines missing `sig`

**Violation-scope provenance.** Every `violations.jsonl` row records the emitting operator's
`person_id` per Rule 6; per-operator posture downgrades follow architecture §6.2.

## Trust Posture Wiring — Fragment Attribution Is Frontmatter, Not Filename

Depth for the clause-scoped wiring block in `rules/knowledge-convergence.md` covering the Rule 1
fragment-attribution sentences (added 2026-08-21: FILENAME-is-signage, the mandatory
`person_id`+`verified_id`+`display_id` frontmatter, and the prohibition on deriving an operator
identity by stripping the filename). It ships canonical-8-field-compliant per
`rules/trust-posture.md` MUST-8; the rule-wide block governs Rules 1–6 as they stood and is
unchanged until itself `/codify`-touched (clause-scoped precedent: `security.md`
§ Enforcement-Surface Parity + `git.md` § CI-check/merge).

**The fragment frontmatter, rendered.** The DO shape the rule body states in prose:

```text
# DO — the fragment names its own operator; the filename is only signage
---                           ← .session-notes.d/alice.md frontmatter
person_id: pid-alice-9f2c1b   ← AUTHORITATIVE attribution (the authority unit)
verified_id: SHA256:xW8q…     ← the signing key that authenticates the writer
display_id: alice             ← signage; matches the filename, carries no authority
---

# DO NOT — attribute by stripping the filename (display_id collisions are LEGAL)
displayId = basename(f, ".md")  ← two humans both called "alex" ⇒ silently merged
```

**Severity rationale (why the hook layer is `advisory`, not `block`).** Whether a given
filename-derived string is being used as ATTRIBUTION or merely as a DISPLAY label is a semantic
judgment over the consuming code, with no structural tool-call-time signal — so `block` on that
evidence is barred by `rules/hook-output-discipline.md` MUST-2. Gate-review carries
`halt-and-report`: reviewer at `/implement` + cc-architect at `/codify` confirm any code attributing
a `.session-notes.d/` fragment reads the frontmatter rather than the filename stem, and that every
fragment written in the session carries the attribution triple.

**Same-class violation enumeration** (the set the Cumulative and Regression-within-grace fields key
on): a fragment written without the attribution triple; tooling that derives an operator identity by
stripping a fragment filename; a consumer that treats the filename stem as authoritative when the
frontmatter disagrees.

**Regression-within-grace — the named deviation.** Routes through the GENERIC
`regression_within_grace` trigger (`rules/trust-posture.md` MUST-4, 1× = drop 1 posture). This file
has NO dedicated rule-wide key: the `multi_operator_artifact_bypass` key it formerly named was
cited-never-defined and is retired (loom#2102), and that key's violation shape was a bypassed
artifact SPLIT rather than a mis-keyed attribution. Recorded per `trust-posture.md` Rule 8:
mis-attribution is non-corrupting and recoverable — the frontmatter can be added to an existing
fragment without data loss — so it does not warrant an instant-drop key, and minting one would drag
`trust-posture.md`, a `self-referential-codify.md` allowlist file, into a self-referential edit.

**Detection mechanism — structural + review.** Structural:
`session-notes-layout.js::_buildFragmentBody` stamps the triple on every fragment it builds, and
`regenerateAggregate` routes attribution through the exported `readFragmentAttribution` rather than
the filename stem — so the canonical writer and the canonical reader both satisfy the clause by
construction, and a NEW consumer is the only way to reintroduce the defect. Review: reviewer at
`/implement` + cc-architect at `/codify` grep any new `.session-notes.d` consumer for a
filename-stem identity derivation (`replace(/\.md$/`, `basename(`) and confirm it routes through
`readFragmentAttribution`. **No probe suite ships for this clause** — `knowledge-convergence.md` has
NO `eval-manifest.json` entry and its probe suite is UNWRITTEN, already declared in
`phase2-deferrals.json::probe_authorship_deferrals` (expires 2026-12-11); this clause is covered by
that existing dated acceptance rather than a new key, because `completion-criterion.md` MUST-6
forbids the agent proposing a residual from also accepting one. The semantic tier is therefore
UNCOVERED and owed at gate-review via `/test-harness-probe`. No audit-fixture directory is named:
fixtures land with the detector that owns them, and no new detector ships with this clause.

**Violation scope.** The Rule 1 fragment-attribution sentences ONLY (clause-scoped). Every
`violations.jsonl` row names the fragment path and whether the failure was a MISSING stamp (writer)
or a filename-derived attribution (reader). The artifact-SPLIT half of Rule 1 keeps its existing
scope under the rule-wide block.

**Origin — 2026-08-21.** A canon-loom identity-fragmentation investigation found `.session-notes.d/`
holding two fragments (`<operator>.md`, `<operator>-dev.md`) for ONE human, neither recording any in-file
identity, and a triage lane read the stale one as "another operator's" — correct under its premise,
wrong in fact. The corpus-level defect it exposed: Rule 1 keyed a durable, attribution-bearing
artifact on `display_id`, the ONE field `multi-operator-coordination.md` §1 declares
collision-tolerant and forbids attributing by. Rule 2 of the rule file had already resolved the
identical tension for journal entries (filename embeds `display_id` for wayfinding; frontmatter is
authoritative), so the amendment adopts that in-file precedent rather than renaming the fragment — a
rename would break nine filename-construction sites and the pinned test corpus while leaving the
actual unsoundness (a filename is not an attribution) in place.

## Origin — Full Provenance Chain

Verbatim, as it stood in the rule body:

> (loom-internal reference) §§5 (single-writer artifact
> contention — Shard M6 D), §7 (knowledge convergence — Shard M7 E), §8 (artifact inventory), §9
> (artifact discipline ≤150-line command bodies), §11 row D (M6 D shard spec; landed PR #323) + row
> E (M7 E shard spec; landed PR #324), §4.5 body-anchor signer-vs-author residual (added
> 2026-05-22). Co-owner brief 2026-05-19 — multi-operator-coc CONVERGED. Receipt-first journal
> entries (ROOT `loom/journal/`): `0112` (architecture decision-record), `0122` (CONVERGENCE
> receipt), `0132` (M6 + M7 convergence DECISION receipt #0132), `0133` (Sec-MED-3 audit-trail-
> completeness residual co-owner DECISION).

## Extraction Record — 2026-08-19 Structural Cleanup

Depth relocated here from `.claude/rules/knowledge-convergence.md` with ZERO de-scoping: every MUST,
MUST NOT, BLOCKED-rationalization entry, DO/DO-NOT block and `**Why:**` failure-mode statement
stayed in the rule body, and the `## Trust Posture Wiring` block kept all eight of the field labels
it carried, each with its normative statement. What moved: helper paths and signatures, write
primitives, coordination-log record payloads and reader contracts, the FSUB / Sec-MED-3 / Sec-LOW-1
/ Sec-LOW-2 / M6 D / M7 E per-instance provenance, the architecture §§4.5/5.1/5.2/6.2 citations, the
`~128B` / `MAX_LINE_BYTES (2048)` constants (moved verbatim, with the falsifying context that makes
them readable), the same-class enumeration, the five-grep detection sweep, and the full Origin
chain.

`rule-authoring.md` Rule 10 / Rule 11 do NOT fire: Rule 10 § "Trigger scope" binds `priority: 0` +
`scope: baseline` rules ONLY, and `knowledge-convergence.md` is `scope: path-scoped`. This is
therefore a STRUCTURAL-CLEANUP extraction, not a Rule-10 paired extraction, and so it is not
Rule-11 recurrence input either — the disposition `journal/0148` § "Lesson learned" recorded for
exactly this case.

### 2026-08-23 — the MUST-1 signer-claim withdrawal, and what it cost the budget

MUST-1's sentence "the `owner:` cell is PROJECTED from the event's signer" was withdrawn (§ Rule 1
above carries the measurement and the corrected mechanism), and the Detection block's "no shipped
detector separates a REGENERATION of the ledger from a HAND-EDIT" was narrowed to "no
HOOK-REGISTERED detector", because `.claude/bin/forest-ledger-project.mjs --check` IS that
discriminator. Both corrections ADD bytes to a rule body already 5041 B over its accepted ledger
figure, and `check-rule-injection-budget.mjs` reported BOTH a `RULE_DELTA_OVER` on this rule and a
`PROFILE_OVER_CEILING` on `workspace-note` — the profile's entire overage was this rule's growth
plus `wip-discipline.md`'s. The remedy taken was paired extraction, NOT a ceiling raise: the rule's
`**Extraction record**` paragraph — pure provenance already duplicated verbatim in this section —
was collapsed to a pointer, and both corrections were authored compact with their depth here.

As above, this is a BUDGET obligation, not a Rule-10 one: Rule 10 § "Trigger scope" binds
`priority: 0` + `scope: baseline` rules ONLY and this rule is path-scoped, so it is not Rule-10
paired extraction and not Rule-11 recurrence input.

# Structural-cleanup extraction — 2026-09-07 (rule-injection budget, `workspace-note` band)

Depth moved out of the rule body to fund the `workspace-note` profile band. **ZERO de-scoping:**
measured with `check-descoping.mjs`'s own `extractInventory`, the rule's normative census is
UNCHANGED across every edit — `must_clause` 3, `must_token` 71, `must_not_token` 7,
`blocked_token` 13, `why_line` 11, and all eight canonical Wiring fields still at 3 occurrences
each. `rule-authoring.md` Rule 10 / Rule 11 do **NOT** fire (`priority: 10` / `scope: path-scoped`).

## Probe registration + dispatch bookkeeping (MUST-1 log/projection Wiring)

Removed verbatim; the rule keeps the registration fact, the DISPATCH-ONLY caveat and the
never-synced fact in compressed form:

> Registered in `eval-manifest.json` as a probe-only entry (`scanner: null`) and pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`. Registration buys DISPATCHABILITY, never automatic execution: no workflow invokes `coc-probe-dispatch.mjs`, and the loom↔csq boundary keeps CI LLM-free, so a green CI run is NEVER evidence these probes passed — they execute only when an orchestrator dispatches `/test-harness-probe --artifacts` at gate-review. Consumer note: `.claude/test-harness/probes/knowledge-convergence.probes.json` does not ship to use/base, build/base, use/py, build/py, use/rs, build/rs (MEASURED: `skip` on 6 of this rule’s 6 lanes), so no consumer on those lanes receives it; at those targets this tier is not a live gate and enforcement is gate-review at the consumer’s end.

## The "no shipped detector" correction record

The rule keeps the operative fact (no hook-registered detector; `forest-ledger-project.mjs --check`
IS the discriminator, with its exit codes). The correction narrative moved here:

> **NOT AUTOMATICALLY covered — the earlier "no shipped detector" wording was too strong:** no HOOK-REGISTERED detector separates a REGENERATION from a HAND-EDIT, but `node .claude/bin/forest-ledger-project.mjs --check` IS that discriminator (exit 0 `IN SYNC` / 1 `DRIFT` / 2 `REFUSED`).

## Regression-within-grace — the no-dedicated-key rationale (MUST-1 log/projection Wiring)

The rule keeps the named deviation, the Rule 8 citation and the reason in brief
("non-corrupting, bounded to re-work"). The full reasoning:

> Named deviation from key-per-clause per `trust-posture.md` Rule 8, with this clause's OWN reason: the loss is non-corrupting and bounded to re-work (the log holds the truth; a regeneration recovers the projection), so no instant-drop key is warranted, and minting one would drag `trust-posture.md` — a `self-referential-codify.md` allowlist file — into a self-referential edit.

## Rule 1 `**Why:**` — the attribution failure mechanism

The `**Why:**` keeps all three failure modes. The long form of the attribution half:

> The attribution half fails the same way: `display_id` is explicitly collision-TOLERANT, so a filename-derived identity is an index key the corpus permits to be ambiguous — two operators sharing a `display_id` land on one path, and the loser's fragment is overwritten with no signal.

## Rule 3 — the codify-lease branch-naming convention

The authorization predicate ("Authorization is by LEASE COVERAGE, never by branch NAME") stays in
the rule. The convention note moved:

> The date-named shape remains the DEFAULT the helper mints; it is a convention, not the authorization predicate.

## Rule 1 — the `owner:` signer withdrawal

The rule keeps the live status (`owner:` is UNSIGNED convenience attribution, NOT the event's
signer, that claim WITHDRAWN, both halves UNBUILT — an OPEN finding). The prior phrasing:

> **NOT from the event's SIGNER: an earlier revision said so, and that claim is WITHDRAWN.** `owner:` is UNSIGNED convenience attribution; both halves are UNBUILT — an OPEN finding.

## Receipt-requirement de-duplication

Two Wiring blocks carried byte-identical `Receipt requirement` bodies. Both keep the canonical
field label and a normative statement; the second now states it by reference. Prior text:

> - **Receipt requirement:** SessionStart soft-gate `[ack: knowledge-convergence]` IFF `posture.json::pending_verification` includes the `knowledge-convergence` rule_id (shared; one ack covers this file).

## Rule 6 `**Why:**` — the Sec-LOW-2 incident sentence

Removed from the rule body; it was already carried verbatim in § "Rule 6 — Append-Log Stamping"
above, whose parenthetical has been corrected accordingly. The removed sentence:

> Truncate-after-signing was the Sec-LOW-2 bug — the signature covered pre-truncation bytes but disk bytes were post-truncation; verifiers re-canonicalizing the parsed line failed verification, silently making the line un-attributable.

# Structural-cleanup extraction — 2026-09-13 (rule-injection budget)

A second budget pass over the same rule. **ZERO de-scoping:** the normative census is UNCHANGED
across every edit — `must_clause` 3, `must_token` 72, `must_not_token` 7, `blocked_token` 13,
`why_line` 11, and all eight canonical Wiring fields still at 3 occurrences each. Nothing bearing a
`MUST`, `MUST NOT`, `BLOCKED` or `**Why:**` token was moved out of the rule. `rule-authoring.md`
Rule 10 / Rule 11 do **NOT** fire (`priority: 10` / `scope: path-scoped`).

## MUST-1 Wiring Detection — the probe-pair pole diff

The rule keeps the registration fact, the suite path, the fixtures directory, the pair counts and
the scoping sentence ("the `MUST-1-firing` pair is the one scoped to THIS clause"). The pole diff
moved here:

> The `MUST-1-firing` pair is the one scoped to THIS clause: both poles run the same three-operator
> session and separate only on whether the transition was emitted as an event and the ledger
> regenerated, or typed into the projection.

The manifest/`PINNED_SUITES` registration sentence and the DISPATCH-ONLY + never-synced sentence
removed alongside it are already carried verbatim above, in
§ "Probe registration + dispatch bookkeeping (MUST-1 log/projection Wiring)"; they are not restated
a third time here.

## MUST-1 Wiring Regression-within-grace — the retired-key record

The rule keeps the routing, the no-dedicated-key disposition, the Rule 8 citation and the brief
reason. The retirement narrative moved here:

> — no dedicated key (the prior `multi_operator_artifact_bypass` was cited-never-defined and is
> retired, loom#2102). That key's class was a helper BYPASS, not a substrate confusion.

## The dedicated-key withdrawal record (rule-wide Wiring)

The rule-wide `Regression-within-grace` field keeps the routing, the no-dedicated-key statement and
the named refusing layer. The correction and the negative clause moved here:

> …, NOT by the multi-operator fold rules 1-3. An earlier revision asserted a dedicated key WAS
> added to that list; it never was (loom#2102).

## Rule 3 — the two explanatory sentences

The rule keeps every obligation: surface-and-STOP on conflict, name a SAME-OPERATOR conflict as
such, edits land on `res.branch`, and "Authorization is by LEASE COVERAGE, never by branch NAME".
The two sentences that explain rather than oblige moved here:

> Reporting a same-operator conflict as a foreign holder sends the operator hunting a colleague who
> does not exist.

> The guard matches the recorded branch plus the signer; it does NOT require the
> `codify/<display_id>-<date>` SHAPE.

The second is the same fact § "Rule 3 — Codify-Lease Mechanics" records from the reader-contract
side (`findCoveringLease` folds signer + scope coverage; the branch comparison was REMOVED).

## Rule 6 — the refuse-on-overflow probe mechanics

The rule keeps the obligation ("the helper MUST refuse to write rather than truncate-after-signing")
and its pointer. The mechanism sentence removed from the rule body is already carried above with its
measured constants, in § "Rule 6 — Append-Log Stamping: The Sec-LOW-2 Refuse-On-Overflow Probe":

> a pre-sign probe returns a typed `record too large` when the line would exceed the cap, and a
> post-sign guard refuses if the signature exceeded the reserve
