/**
 * burndown-events — THE EVENT LOG. Schema, validation, the one append path, and
 * the pure fold that proves the log can produce the projection the consumer reads.
 *
 * ── WHY A LOG AT ALL ─────────────────────────────────────────────────────────
 *
 * `.session-notes.shared.md` is a PROJECTION pretending to be a log: simultaneously
 * the evidence a verified count is computed from and a live mutable work surface.
 * Three symptoms, one cause — `parseLedger` REFUSES a duplicate row id (a projection
 * invariant, not a log one); an append-only writer could not be the producer and had
 * to become an upsert; and the file needs a custom 3-way merge driver, which
 * append-only logs never do.
 *
 * ── WHERE IT LIVES, AND WHY NOT THERE ────────────────────────────────────────
 *
 * `burndown/events.jsonl`, a COMMITTED append-only JSONL. Ratified substrate.
 *
 * It is NOT on any `.session-notes*` path, and that is C4 rather than taste. The
 * tracker measures 291 lines against `session-notes-continuity.md` MUST-3's
 * 300-line ceiling — 97% consumed, ~9 rows from breach, and `decideCeilingAdvisory`
 * does NOT exempt the ledger kind. An append-only log is UNBOUNDED BY CONSTRUCTION,
 * so a log on that namespace breaches MUST-3 outright and makes MUST-2's
 * no-truncate-read — which carries `block` teeth at `PreToolUse:Read` — unaffordable.
 * Both breaches are CONDITIONAL on the placement, and the placement was ours.
 *
 * The T1 leak WAS real, and the mechanism that closes it is
 * `signed-log.js::verifyAppendOnlyPrefix`. The finding, restated so the fix is legible:
 * the log is not in `sources[]` — but it IS `tracker.path`, and
 * `assertCommittedAndUnmodified` holds the TRACKER to the same standard. MEASURED: with
 * 267 uncommitted appends in the working tree `burndown-build.mjs --check-links` exits 2
 * with "declared source 'burndown/events.jsonl' has uncommitted modifications against
 * HEAD". So a `PostToolUse` producer took the gate UNRUNNABLE from its FIRST append.
 *
 * The cause was the WRONG QUESTION, not a missing exemption.
 * `assertCommittedAndUnmodified` asks "is the working tree byte-identical to HEAD?",
 * which is right for a declared SOURCE and wrong for an APPEND-ONLY LOG. The right
 * question is "has anything already committed CHANGED?" — which permits appends and
 * forbids exactly what must be forbidden. Exempting the tracker would have been the
 * patch; replacing the predicate is the fix, and the SAME predicate is what makes
 * append-only a gate invariant rather than producer discipline (deleting, reordering or
 * truncating a committed record is caught, which per-record signature verification
 * cannot do — every surviving signature still verifies after a middle record is
 * removed). Gate wiring: `burndown-build.mjs`'s `event-log` branch.
 *
 * ── THE JOIN KEY ─────────────────────────────────────────────────────────────
 *
 * `checkLinks` joins on PURE `id` STRING EQUALITY — no ordering, no time — and
 * `resolveAnchor` is substrate-agnostic and needs ZERO change. So the log carries the
 * burndown item id VERBATIM and the fold below produces exactly
 * `Map<id, {id, anchorRaw, item, line}>`, the shape `parseLedger` returns.
 *
 * The field is named `item_id`, NOT `id`, and that is forced rather than chosen:
 * `appendStamped` stamps its OWN `id` (a unique per-RECORD `rec_…`) into the prefix
 * and then `Object.assign({}, prefix, partial)` lets a caller key of the same name
 * OVERRIDE it. A partial carrying `id` would therefore silently destroy per-record
 * identity and give every event for one item the same record id — un-forensicable.
 * Two identities, two names: `id` is WHICH EVENT, `item_id` is WHICH ITEM. The join
 * key's VALUE is the item id verbatim, which is what the join requires.
 *
 * ── ORDERING: FILE ORDER FOR THE FOLD, PER-EMITTER `seq` FOR THE CHAIN ───────
 *
 * The FOLD's order is FILE ORDER — the 1-based line ordinal, which is what becomes
 * `line` in the projection. That is unchanged, and reason 3 below is why:
 *
 *   3. A line ordinal is unique BY CONSTRUCTION within a file, costs nothing at
 *      fold time, and makes the fold DETERMINISTIC: the same bytes always produce
 *      the same projection, which is the property `--check` re-derivation needs.
 *
 * Generation 1 additionally carries a per-emitter `seq` + `prev_hash` chain. That is
 * NOT an ordering mechanism and does not compete with file order; it is a TAMPER
 * mechanism, and it exists because file order cannot express "a record used to be
 * here". Reasons 1 and 2 above were this file's case against a counter, and reason 1
 * was WRONG — recorded rather than quietly deleted, because it is why the log shipped
 * without a chain:
 *
 *   1. "A counter is NOT UNIQUE across clones — two operators appending concurrently
 *      each compute seq = N, and the fold becomes AMBIGUOUS." Sound against a GLOBAL
 *      counter; exactly wrong about a PER-EMITTER one. Two DIFFERENT operators never
 *      collide, because the counter is scoped to `verified_id`. The same operator
 *      colliding with themselves IS a fork, and a duplicate `(verified_id, seq)` with
 *      differing content hashes is precisely how `signed-log.js::verifyChain` DETECTS
 *      it. The objection treated detectability as the harm.
 *   2. "A counter must be READ before it is written — an O(n) scan on a `PostToolUse`
 *      path." CORRECT, kept, and paid deliberately: it is one read of the current
 *      generation per append, and it buys the only property that makes a deleted middle
 *      record visible from the RECORDS rather than from git.
 *
 * `timestamp` (stamped by `appendStamped`, UTC by `toISOString()`) is an ADVISORY
 * CAUSAL WITNESS and is explicitly NOT the sort key: wall clocks skew across clones,
 * and a local-time read wrote an 8-hour-forward skew into a ledger this month. The
 * fold below sorts by NOTHING — it walks the file — so a `timestamp` cannot reorder
 * anything. Stated so no later reader "fixes" the fold by sorting on it.
 *
 * What file order does NOT give is CAUSALITY ACROSS CLONES after a merge. That is
 * true, unfixable without vector clocks, and out of scope; it is recorded rather
 * than implied away, and `byPrecedence`'s path-tiebreak has exactly the same bound.
 *
 * ── GENESIS IS NOT A TRANSITION ──────────────────────────────────────────────
 *
 * C5. The 267 backfilled items are agent-drafted assertions RE-SERIALIZED — no
 * emitter, no timestamp, no signature. They carry `kind: "genesis"` and
 * `weight: "migration_baseline"`, never live-event weight. Claiming live authority
 * for them would reproduce THIS EXACT FAILURE CLASS one layer up, which is the whole
 * reason this work exists.
 *
 * The distinction is OPERATIVE, not decorative. `foldEvents` refuses to let a
 * `migration_baseline` event overwrite a `live` one for the same `item_id`, whatever
 * the file order — so a genesis backfill re-run after real work cannot silently
 * revert it. A label nothing reads is decoration; this one changes the fold.
 *
 * ── RETRACTION IS RETIRE-IN-PLACE, NEVER REMOVAL (component 11) ──────────────
 *
 * The kind vocabulary was CLOSED at `genesis|transition`, so nothing could retract or
 * retire a ledger item. `kind: "retraction"` opens that, and the SHAPE it takes is
 * forced by a coupling the widening would otherwise have broken silently.
 *
 * `burndown-build.mjs`'s `tracker.min_rows` gate is a LOG-INTEGRITY floor and it rests
 * on ONE premise: an append-only log's projection is MONOTONIC in POPULATION, so no
 * legitimate operation can ever shrink `rows.size`. That is what lets a shrink be read
 * as a truncation, a history rewrite, or a merge that dropped a side. A retraction that
 * REMOVED the item from the fold would falsify the premise and leave two bad options:
 *
 *   (a) let the floor fire on ordinary work — the always-refusing assertion an operator
 *       switches off, which is how a gate dies; or
 *   (b) teach the floor to SUBTRACT the retractions it can see.
 *
 * (b) is the one that looks principled and is not, and the reason is decisive: the
 * evidence that would explain the shrink lives INSIDE the file that shrank. A truncation
 * deletes retraction records exactly as readily as any other, so "N rows missing, N
 * retractions on record" and "N+M rows missing, N retractions surviving" are the same
 * observation to the gate — the attacker CHOOSES how vacuous the subtraction is. A gate
 * whose exculpatory evidence is under the adversary's control is not a gate.
 *
 * So a retraction RETIRES IN PLACE. The item KEEPS its row in the fold, keeps its
 * `value_anchor` — RESTATES it, precisely: the fold is last-wins per item, so the
 * retraction's own cells REPLACE the row wholesale rather than merging into it, and the
 * anchor survives only because the retraction carries one. Its traceability legs are
 * therefore checked exactly as any other row's are, against the anchor the RETRACTION
 * names. It carries the terminal status `retired`. The population never shrinks, the floor keeps its EXACT prior meaning and
 * its full teeth, and no consumer has to be told that a number changed meaning. What
 * changes is the item's STATUS — which is the thing a retirement is actually about —
 * and consumers that want open work filter the terminal status rather than trusting a
 * count to have quietly excluded it.
 *
 * RETRACTION IS OWNER-ONLY, and that is not conservatism. `burndown-traceability.md`
 * MUST-4 is that statuses are the OWNER's and an agent MUST NOT set or advance one.
 * Retiring an item takes it out of live work — the same adjudication `Signed off` makes,
 * under a different word — so an agent-emitted retraction would be a laundering channel
 * around the very fence `validateEvent` already applies to a transition. It therefore
 * requires `authority: "owner"`, which is only a real bound because of the section
 * below: before it, `owner` was self-declared.
 *
 * ── AUTHORITY IS BOUND TO A ROSTERED ROLE (component 12) ─────────────────────
 *
 * `authority` was validated against a closed vocabulary and NOTHING else. An earlier
 * revision of the fence comment inside `validateEvent` recorded the hole exactly: the
 * field is inside the signed canonical bytes, so it cannot be altered after signing —
 * but nothing mapped a SIGNER to a ROLE, so any rostered signer could write
 * `authority: "owner"` on their own event and be believed.
 *
 * That is now closed at BOTH ends. `owner` is a ROLE-BOUND authority: the claim is
 * checked against the signer's `role` in the COMMITTED operator roster
 * (`git show HEAD:.claude/operators.roster.json`), resolved from the record's
 * `verified_id` fingerprint, with the stamped `person_id` REQUIRED — present, and in
 * agreement with the person that owns that fingerprint (an absent one refuses; it is
 * not skipped).
 *
 *   THE ROSTER IS READ FROM `HEAD`, NEVER THE WORKING TREE. A working-tree roster is a
 *   trust root the adversary can write: add a key (or flip your own `role` to `owner`)
 *   and every claim it backs verifies. This is the identical defect that was fixed at
 *   `burndown-build.mjs::rosterKeyResolver`, and the fix is not re-litigated here — it
 *   is reused.
 *
 *   THREE STATES, NEVER TWO. A roster that cannot be read or parsed, a signer absent
 *   from it, and a role the schema does not declare are all INDETERMINATE: verification
 *   could not RUN. A signer who IS rostered with a role that does not carry the claimed
 *   authority — or whose `host_role` is `ci`, which is AUDIT-ONLY per R5-S-04 — is
 *   INVALID: a positive finding about the record. Both REFUSE; they differ in what the
 *   operator must go and fix, and reporting an outage as a forgery is a live defect
 *   class in this codebase.
 *
 *   FAIL CLOSED, NO EXCEPTIONS. There is no path on which an unresolvable signer falls
 *   back to accepting the self-declared value (`security.md` § Secure-Default). The
 *   producer's resolver is injectable for fixtures, and a caller that omits it gets the
 *   real committed-roster read — there is no unbound production path to reach.
 *
 *   IT COSTS NOTHING ON THE HOT PATH. The resolver is LAZY and is consulted only for a
 *   ROLE-BOUND authority, so the `PostToolUse` producer — which emits `agent`
 *   transitions — makes no git call at all.
 *
 * WHAT THIS DOES NOT BUY, stated so the claim is not over-read: `foldProjection` still
 * verifies no signature, so the RENDER surface believes what a hand-written line says.
 * The binding has teeth at the two places that ADJUDICATE — `appendEvent`, which is the
 * only write path, and `burndown-build.mjs`'s read gate, which verifies every signature
 * before it reads a role. That is exactly the bound `authority: "owner"` already had for
 * `Signed off`; nothing here widens it, and nothing here pretends to have closed it.
 *
 * ── SIGNING AND REFUSAL ──────────────────────────────────────────────────────
 *
 * ONE write path: `appendStamped` (`knowledge-convergence.md` MUST-6). Signed over
 * canonical bytes, refuse-on-overflow, NEVER truncate-after-signing. There is NO
 * unsigned path in this module and no `fs.appendFileSync` anywhere in it — a
 * silently-unsigned row is un-attributable, and an unsigned fallback would be the
 * same silent-discard class C6 exists to close.
 *
 * Every failure returns a TYPED refusal (`zero-tolerance.md` Rule 3). The CALLER is
 * obligated to surface it; see `todo-tracker-guard.js`, where a refusal becomes a
 * `halt-and-report` finding naming the rule, the criterion, and the `item_id`.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { appendStamped } = require(path.join(__dirname, "coc-append.js"));
const signedLog = require(path.join(__dirname, "signed-log.js"));
// The SHARED subprocess envelope, never a local re-implementation. An un-enveloped
// `git show` inherits the operator's `GIT_*` steering, and an ambient `GIT_DIR` would
// make the roster read answer about ANOTHER repository — i.e. the trust root would be
// supplied by the environment, which is the whole class reading from HEAD closes.
const { resolveGitBinary, gitEnvForArgs } = require(path.join(__dirname, "git-subprocess-env.js"));
// The SINGLE SOURCE OF TRUTH for signer eligibility (R5-S-04 audit-only-host exclusion
// + the per-context role floor). Delegated to rather than re-implemented: a fourth
// inlined `host_role === "ci"` is the drift class MED-3 consolidated.
const { isEligibleSigner } = require(path.join(__dirname, "eligibility.js"));

/**
 * ── THE GENERATION LINEAGE ───────────────────────────────────────────────────
 *
 * Version pin. Without it a v2 reader cannot tell a v1 line from a malformed one.
 *
 * `SCHEMA` is the CURRENT generation and is what `appendEvent` stamps. The lineage
 * below is this module's own record of which generations have ever existed and what
 * SHAPE each one's records have; WHICH SUITE each generation carries is declared by
 * the manifest (`signed-log.js::resolveSuitePolicy`), never here — one file cannot be
 * both the thing declared and the declaration.
 *
 * Generation 0 (`v1`) is CLOSED. Its 534 committed records carry no `sig_alg` and no
 * chain, and they are NOT re-emitted: a closed generation stays committed and
 * verifiable under the suite the manifest declares FOR IT.
 *
 * Generation 1 (`v2`) is ALSO CLOSED, and it closed holding ZERO records — MEASURED,
 * not assumed: every one of the 534 committed lines carries `schema:
 * "burndown-event/v1"`. It was declared openpgp and never written to, because the
 * suite fence correctly refused every append once the operator's signing key became
 * ssh. It stays declared rather than being deleted: dropping it would make any v2 line
 * that ever surfaced an `undeclared generation` refusal with nothing to point the
 * reader at, and a generation that existed is a fact about this log's history whether
 * or not it holds bytes.
 *
 * Generation 2 (`v3`) is what every new append joins. Its FIELD SET is identical to
 * v2's — the roll is a SUITE change (openpgp → ssh-rsa), which is precisely the event
 * the manifest's `_note` says rolls a generation. The schema string carries generation
 * identity here by design (`signed-log.js::resolveSuitePolicy` keys `bySchema`), so a
 * suite change necessarily bumps it; that conflation is the declared design, not drift.
 * WHICH SUITE each generation carries is still declared ONLY by the manifest.
 */
const SCHEMA_V1 = "burndown-event/v1";
const SCHEMA_V2 = "burndown-event/v2";
const SCHEMA = "burndown-event/v3";

const SCHEMAS = Object.freeze({
  [SCHEMA_V1]: Object.freeze({ generation: 0, declaresSigAlg: false, requiresChain: false }),
  [SCHEMA_V2]: Object.freeze({ generation: 1, declaresSigAlg: true, requiresChain: true }),
  [SCHEMA]: Object.freeze({ generation: 2, declaresSigAlg: true, requiresChain: true }),
});

/** Repo-relative sink. Under `burndown/`, off `.session-notes*` — C4. */
const EVENTS_REL = "burndown/events.jsonl";

/**
 * The closed kind vocabulary. An unrecognized kind is REFUSED at both ends.
 *
 * `retraction` is the ONE widening this vocabulary has taken (component 11). It is
 * RETIRE-IN-PLACE — see the header — so it adds a terminal STATUS to an item and never
 * removes the item from the fold. Widening this array is a producer-side change and it
 * moves what BOTH validators accept, so it is not a local edit: `burndown-build.mjs`
 * folds through this same module by design, precisely so the two cannot disagree about
 * what a well-formed event is.
 */
const KINDS = Object.freeze(["genesis", "transition", "retraction", "proposal", "activation"]);

/**
 * kind → weight, as ONE table.
 *
 * `weight` is redundant with `kind` BY CONSTRUCTION and that is the point: C5
 * requires the `migration_baseline` weight to be carried EXPLICITLY, so a consumer
 * that reads only one of the two fields still gets the right answer. Because the
 * emitter derives `weight` here rather than accepting it, the two cannot drift at
 * the producer; because `validateEvent` re-checks the pair, a hand-written or
 * tampered line whose pair disagrees is REFUSED rather than folded.
 */
const WEIGHT_FOR_KIND = Object.freeze({
  genesis: "migration_baseline",
  transition: "live",
  // LIVE, not a third weight. A retraction is a real event by a real owner at a real
  // time, so it carries live weight — and that is load-bearing rather than tidy: the
  // C5 fence in `_walk` is keyed on weight, so live weight is what stops a re-run of
  // the genesis backfill from silently un-retiring an item the owner retired.
  retraction: "live",
  // A THIRD weight, and it is the mechanism rather than a label. `live` and
  // `migration_baseline` are both weights of events the fold FOLDS; a proposal is
  // never folded at all, so giving it either one would make the C5 fence — which
  // compares weights to decide which event wins — adjudicate a record that never
  // competes. `proposal` weight competes with nothing because nothing carrying it
  // ever reaches `weights`.
  proposal: "proposal",
  // LIVE. An activation is a real owner adjudication at a real time, signed by a
  // roster-bound owner — the same class of event a `retraction` is, and it takes the
  // same weight for the same reason: the C5 fence must stop a genesis re-run from
  // reverting it.
  activation: "live",
});

/** Who ASSERTS the state. Orthogonal to `weight`, which is about the EVENT's class. */
const AUTHORITIES = Object.freeze(["agent", "owner"]);

/**
 * The authorities a signer may NOT self-declare — each MUST be backed by a ROLE in the
 * COMMITTED roster (component 12). `agent` is deliberately absent: it claims nothing an
 * agent does not already have, and the signature gate independently reports an
 * unrostered signer as INDETERMINATE, so binding it would buy no authority the log does
 * not already check while putting a git read on the `PostToolUse` hot path.
 */
const ROLE_BOUND_AUTHORITIES = Object.freeze(["owner"]);

/**
 * authority → the `eligibility.js` SIGNING CONTEXT that decides it.
 *
 * The role floor itself lives in `eligibility.js::_REQUIRED_ROLES`, NOT here — this
 * table only says WHICH question to ask. A second copy of the floor is what makes two
 * sites disagree about who may sign.
 */
const SIGNING_CONTEXT_FOR_AUTHORITY = Object.freeze({ owner: "ledger-authority" });

/** The COMMITTED operator roster — the one artefact binding a fingerprint to a ROLE. */
const ROSTER_REL = ".claude/operators.roster.json";

/**
 * The COMMITTED VERIFICATION SURFACE — the half of the roster that must ship.
 *
 * `operators.roster.json` was doing two jobs that only coincide at canon: "who are the
 * operators of this repo" (must be LOCAL and per-clone, or a template author's identity
 * contaminates every downstream clone) and "what key material is authority verified
 * against" (must be COMMITTED, or a signed log verified against an uncommitted file is
 * not tamper-evident). `sync-manifest.yaml::gitignore_additions` resolves that conflict
 * in favour of the first at every USE lane — which is why `authority: "owner"` is
 * structurally unclaimable at a consumer and no item there can ever reach `Signed off`.
 *
 * This file is the second job, split out. It carries ONLY what answers "may this signer
 * claim this authority" — no email, no login, no business roles — so committing it
 * downstream discloses nothing the events do not already carry.
 *
 * Design, threat model and the refuted alternative:
 * `workspaces/runtime-enforcement-2026-08-14/01-analysis/trust-root-split-threat-model.md`
 */
const TRUST_ROOT_REL = ".claude/trust-root.json";

/**
 * The roster's closed role + host vocabularies, mirrored from
 * `.claude/operators.roster.schema.json`. They exist ONLY to decide the third state:
 * a value outside either list is INDETERMINATE — a role nobody declared cannot be shown
 * to carry an authority — and it is never coerced. The eligibility VERDICT for a
 * declared value is NOT decided here; it is delegated to `eligibility.js`.
 *
 * A mirror is a drift risk, so it is ASSERTED against the schema by the fixture runner
 * (`audit-fixtures/burndown-events/run.mjs`, the `mirror ·` cases) rather than assumed
 * here — the same disposition `OWNER_STATUSES` takes against the generator.
 */
const ROSTER_ROLES = Object.freeze(["owner", "senior", "contributor"]);
const ROSTER_HOST_ROLES = Object.freeze(["human", "ci"]);

/** A roster larger than this is refused rather than buffered. */
const MAX_ROSTER_BYTES = 4 * 1024 * 1024;

/**
 * THE TEMPORAL BOUND, stated in every refusal that could be caused by an ordinary
 * roster edit rather than by a bad record — an OPEN limitation, named rather than
 * implied away.
 *
 * The roster is read at CURRENT `HEAD`. The log is APPEND-ONLY and its records are
 * PAST. So this check answers "is this signer entitled NOW?", and a reader who takes it
 * for "was this signer entitled THEN?" is reading one instrument for a second question
 * (`instrument-discipline.md` MUST-4). Two ordinary, legitimate roster edits — renaming
 * a person key, or moving an owner to `contributor` / to a CI host — retroactively make
 * every one of that person's historical `owner` records fail this check, permanently,
 * because an append-only log cannot correct them.
 *
 * As-of-record resolution is NOT implemented and is deliberately not attempted here.
 * The obvious form — have the producer stamp the roster blob it was authorized against
 * — lets a signer PIN the most permissive roster the repo ever had, which is a
 * downgrade attack, and the sound form (resolve the roster as of the commit that
 * introduced the record) needs history traversal per record. Both exceed this shard and
 * carry real design doubt, so the bound is DECLARED in the operator-facing text instead
 * of being closed badly.
 */
const TEMPORAL_BOUND =
  "NOTE: this check resolves against the roster at CURRENT HEAD and has no as-of-record " +
  "resolution, so an ordinary roster edit made AFTER this record was signed — a person-id " +
  "rename, a role change, a move to a CI host — produces this identical finding. Read the " +
  "roster's history before concluding the record itself is wrong.";

/**
 * The burndown's closed status vocabulary, mirrored from `burndown-build.mjs`.
 *
 * Mirrored rather than imported for the reason `todo-tracker.js` records: that file
 * is an ESM `bin/` entrypoint with no export surface, and requiring it from a hook
 * would execute its CLI. The mirror is asserted against the generator by the fixture
 * runner rather than assumed here.
 */
const OWNER_STATUSES = Object.freeze([
  "Signed off",
  "Built-not-walked",
  "In progress",
  "Not started",
  "Blocked on you",
]);

/** The agent's own work-state namespace (`todo-tracker.js::TODO_STATUS_PREFIX`). */
const TODO_STATUS_PREFIX = "todo:";

/**
 * The passthrough status the migrated tracker rows already carry. Preserved verbatim
 * by the genesis backfill so the fold reproduces the committed row rather than
 * inventing a status no owner assigned.
 */
const SEE_BURNDOWN = "see burndown";

/**
 * The TERMINAL status a retraction projects (component 11).
 *
 * It is DERIVED from the kind, never accepted from the caller — the same discipline
 * `weight` takes, for the same reason: a caller-supplied terminal status would let a
 * `transition` retire an item and walk around the owner fence. `validateEvent` refuses
 * it on every kind but `retraction`, in both directions.
 *
 * It is deliberately OUTSIDE `OWNER_STATUSES`. That vocabulary is the burndown's own
 * closed set, mirrored from the generator and asserted against it by the fixtures; a
 * value invented here does not belong in it. The owner-only bound on retraction is
 * carried by the KIND's authority rule, not by status-vocabulary membership.
 */
const RETIRED_STATUS = "retired";

/**
 * ── THE COUNTERSIGNED TRANSITION (component 13) ──────────────────────────────
 *
 * THE GAP THIS CLOSES. `validateEvent`'s agent-cannot-assign-an-owner-status fence is
 * correct and stays exactly as strong. What the log had NO channel for is the case
 * that actually occurs: the owner MAKES the decision, out loud, and nothing can carry
 * it. MEASURED — the owner approved closing `F91-remove-nested-worktrees` and hours
 * later it was still unrecorded, because the only path was the owner personally
 * running a tool, and the one tool that existed (`bin/burndown-correct-status.mjs`) is
 * ONE-SHOT and exhausted. So the human was in the loop for the DECISION, which is
 * right, and ALSO for the TRANSCRIPTION, which is not — and the transcription is where
 * real decisions were being lost.
 *
 * TWO RECORDS, NOT ONE. An agent appends a `proposal`: fully formed, signed, dated,
 * naming the item and the owner status it proposes. It is INERT — `_walk` never folds
 * it, so it sets no row, holds no weight, and changes no cell on any surface. An owner
 * then appends an `activation` naming that proposal's record id; THAT is what folds.
 *
 * THE SHAPE IS NOT NEW. It is `.claude/ref-adjudications.json`'s
 * `_proposed_migration_baseline`: the agent populates everything, parked where the
 * consuming reader does not look, so it exempts nothing and cannot until a named human
 * moves it. A fourth shape was deliberately not invented. What is different is the
 * SUBSTRATE, and it is a strict improvement — that file is mutable, so a proposal in
 * it can be silently revised or deleted; this log is append-only, signed and chained,
 * so a proposal made is a proposal on the record whatever happens next.
 *
 * WHAT `accepted_by` BUYS, AND WHAT IT DOES NOT — stated exactly, because over-claiming
 * here would be worse than not building it. MEASURED on this repo: every record in the
 * log, agent-authored and owner-authored alike, is signed by the SAME human identity
 * (267+267 genesis and 100 transitions all carry `display_id: "<operator>"`). The agent
 * holds the operator's key. So NO signature-based mechanism on this host can separate
 * the agent from the owner, and this module does not pretend otherwise —
 * `presence-proof.js` records the identical caveat ("the #583 mintability adversary
 * HOLDS the operator's primary key"), and closing it needs the off-loom broker, which
 * is not in this substrate.
 *
 * What the countersignature therefore buys is what the reference implementation buys,
 * no more: an agent cannot advance a status SILENTLY. It can only do so by appending a
 * second record that NAMES A HUMAN as the acceptor, inside signed canonical bytes, in
 * an append-only log — which is a forgery someone can point at, not an oversight. The
 * refusal below makes that structural rather than promised: `accepted_by` is refused
 * outright for the words an agent would reach for.
 */
const AGENT_ACCEPTORS = Object.freeze(["agent", "assistant", "claude", "ai"]);

/**
 * IS THIS `accepted_by` NAMING AN AGENT? ONE predicate, for every surface that asks.
 *
 * MEASURED as a defect before this function existed: THREE sites asked this question
 * and no two of them agreed. This module compared the trimmed, lower-cased value
 * against `AGENT_ACCEPTORS` EXACTLY; `burndown-build.mjs`'s `migration_baseline` check
 * compared it CASE-SENSITIVELY against two of the four words; and its acceptance-channel
 * check tested `/\bagent\b/i`. Neither of the latter two subsumed the other — measured,
 * `"assistant"` was refused by the first and ACCEPTED by the second, while `"the agent"`
 * was ACCEPTED by the first and refused by the second — and a comment on the newest of
 * them asserted the two were held to "the same standard", which was false in both
 * directions. That is the drift class `eligibility.js::isEligibleSigner` was
 * consolidated to end (see the FOURTH-COPY fence in `classifyAuthorityClaim` below);
 * copying a predicate is how two gates come to disagree about what they both refuse.
 *
 * WORD-BOUNDED, not exact-match, and that is a deliberate WIDENING of this module's own
 * former reading. `"the release agent"` names an agent as plainly as `"agent"` does, and
 * an exact-match list is defeated by one adjacent article. The cost is named rather than
 * hidden: a human whose display name is a bare `"Claude"` or `"Ai"` is refused and must
 * write a fuller identity — which is the correct direction for a field whose entire job
 * is to name unambiguously the HUMAN who decided.
 *
 * The pattern is BUILT FROM `AGENT_ACCEPTORS`, never restated, so the vocabulary has one
 * home; the tokens are regex-escaped so a future entry carrying a metacharacter cannot
 * silently compile into something that matches more, or less, than the word.
 */
const AGENT_ACCEPTOR_RX = new RegExp(
  `\\b(?:${AGENT_ACCEPTORS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "i",
);
function isAgentAcceptor(value) {
  // A NON-STRING IS NOT AN AGENT — it is an unnamed party, which every caller already
  // refuses on its own shape check. Answering `false` here keeps this predicate about
  // the one question it names, so a caller's "is this a string" refusal stays the site
  // that reports a missing name.
  return typeof value === "string" && AGENT_ACCEPTOR_RX.test(value);
}

/**
 * A proposal's OWN status. DERIVED, never accepted — the `RETIRED_STATUS` discipline,
 * for a sharper reason: the proposal carries an owner-vocabulary value in
 * `proposed_status`, so if its `status` were caller-chosen it could carry that same
 * value and `projectStatus` would have to be the only thing standing between an
 * agent-authored record and a rendered owner adjudication. It is pinned to the neutral
 * passthrough instead, so the proposal claims nothing on ANY surface that reads
 * `status` — including a surface that never heard of this kind.
 */
const PROPOSAL_STATUS = SEE_BURNDOWN;

/** The kinds that carry a `reason`. Required on each, REFUSED on every other kind. */
const KINDS_WITH_REASON = Object.freeze(["retraction", "proposal"]);

/**
 * kind → the non-empty string fields it MUST carry, as ONE table.
 *
 * A table rather than a ternary, because the ternary was already at its limit with two
 * kinds and this component adds two more; a three-way nested conditional is where a
 * kind silently acquires another kind's required set.
 */
const _BASE_FIELDS = ["item_id", "item", "value_anchor", "status", "source"];
const REQUIRED_FIELDS_FOR_KIND = Object.freeze({
  genesis: Object.freeze([..._BASE_FIELDS]),
  transition: Object.freeze([..._BASE_FIELDS]),
  retraction: Object.freeze([..._BASE_FIELDS, "reason"]),
  proposal: Object.freeze([..._BASE_FIELDS, "reason", "proposed_status"]),
  // `activates` is the proposal's RECORD id (`rec_…`), not an item id: the
  // countersignature binds to the exact record the owner read, so revising a proposal
  // — which in an append-only log means appending a NEW one — does not silently
  // inherit an activation written against the old text.
  activation: Object.freeze([..._BASE_FIELDS, "activates", "accepted_by"]),
});

const MAX_FIELD_CHARS = 512;

/**
 * The fields the APPEND PATH owns. A caller half supplying any of them is REFUSED by
 * `appendEvent` — see the fence there for why `validateEvent` cannot host this check.
 * `id`/`timestamp`/`session_id`/`repo`/`verified_id`/`person_id`/`display_id` are
 * stamped by `coc-append.js::appendStamped`; `sig` is written beside them;
 * `sig_alg`/`seq`/`prev_hash` are stamped by `appendEvent` itself.
 */
const STAMPED_FIELDS = Object.freeze([
  "id",
  "timestamp",
  "session_id",
  "repo",
  "verified_id",
  "person_id",
  "display_id",
  "sig",
  "seq",
  "prev_hash",
]);
// `sig_alg` is deliberately NOT in that list. It is stamped by `appendEvent`, but a
// caller MAY supply it and `signed-log.js::decideAppendSuite` is built to adjudicate
// exactly that — it refuses one that is not the declared generation's suite. Adding it
// here would make that designed refusal unreachable from the only write path, which is
// how a live branch becomes dead code nobody notices.

function bad(error, reason) {
  return { ok: false, error, reason };
}

/**
 * A refusal that means "verification could not RUN", as distinct from "the claim is
 * FALSE". Reporting an outage as a forgery sends the operator to hunt an adversary that
 * is not there and leaves the real fault — an unreadable roster, an unregistered signer
 * — unrepaired. Both shapes refuse; only this one carries `indeterminate: true`.
 */
function unresolved(error, reason) {
  return { ok: false, indeterminate: true, error, reason };
}

/**
 * The ONE normalization every status comparison in this module goes through.
 *
 * A status is compared against closed vocabularies at four places — the retraction
 * terminal-status fence in both directions, the non-owner transition allowlist, and
 * `projectStatus`'s render-time fence — and each of them was raw string equality. That
 * is a denylist with a whitespace-shaped hole: `"Signed off "` is not in
 * `OWNER_STATUSES`, `"retired "` is not `RETIRED_STATUS`, and BOTH render in a GFM
 * table cell exactly as the value they are pretending not to be. NFKC additionally
 * collapses compatibility forms (a full-width or non-breaking space) that a byte
 * comparison treats as distinct and a reader cannot tell apart at all.
 *
 * Shared rather than inlined so the four sites cannot drift: two fences disagreeing
 * about what a status IS is the same class as two folds disagreeing about which event
 * wins, which `_walk` exists to prevent.
 */
function statusKey(s) {
  if (typeof s !== "string") return "";
  return s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Bound an attacker-influenceable identifier before it reaches a refusal message.
 *
 * `verified_id` and `person_id` are stamped by the append path and are NOT in
 * `validateRecord`'s `MAX_FIELD_CHARS` loop, so a hand-written line can carry a
 * megabyte of either — and the read gate prints a finding's `why` verbatim into CI
 * logs, PR comments and operator terminals. Every OTHER interpolation on that surface
 * goes through the generator's `safeCell`; these did not.
 */
function safeId(v) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  // C0 + DEL + C1 replaced, not merely escaped: a raw ESC in a finding printed to a
  // terminal is an ANSI-injection surface, and the generator prints `f.why` verbatim.
  const t = String(s === undefined ? "undefined" : s).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
  return t.length > 128 ? `${t.slice(0, 128)}…(${t.length} chars)` : t;
}

/**
 * Validate one event's caller-supplied half.
 *
 * Positive allowlist on every enumerated field (`cc-artifacts.md` Rule 10): an
 * unrecognized kind, weight, or authority is REFUSED, never coerced to a default.
 * A coerced default is how a tampered line folds as though it were well-formed.
 */
function validateEvent(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) {
    return bad("invalid event", "event must be a non-array object");
  }
  // Schema is the GENERATION KEY. An unrecognised one REFUSES: a record whose
  // generation is unknown has no declared suite, so nothing can say which key type
  // verifies it — the D1 defect restated at the read end.
  if (!Object.prototype.hasOwnProperty.call(SCHEMAS, e.schema)) {
    return bad(
      "unknown schema",
      `schema is ${JSON.stringify(e.schema)}; the declared generations are ${Object.keys(SCHEMAS).join(", ")} ` +
        `(the current one, which appends join, is '${SCHEMA}')`,
    );
  }
  // A `sig_alg` PRESENT on a generation that has none means the line was authored by
  // something other than that generation's writer; a MALFORMED one on a generation
  // that requires it is refused rather than coerced. Its ABSENCE on the current
  // generation is checked by `validateRecord`, not here: this function validates the
  // CALLER HALF, and `sig_alg` is stamped by the append path alongside `sig`.
  const gen = SCHEMAS[e.schema];
  if (e.sig_alg !== undefined) {
    if (!gen.declaresSigAlg) {
      return bad(
        "sig_alg on a generation that has none",
        `schema '${e.schema}' is generation ${gen.generation}, whose records carry no 'sig_alg'`,
      );
    }
    if (!signedLog.isSuite(e.sig_alg)) {
      return bad(
        "unknown signature suite",
        `sig_alg is ${JSON.stringify(e.sig_alg)}; expected one of ${signedLog.SUITE_NAMES.join(", ")}`,
      );
    }
  }
  if (!KINDS.includes(e.kind)) {
    return bad("unknown kind", `kind is ${JSON.stringify(e.kind)}; expected one of ${KINDS.join(", ")}`);
  }
  if (e.weight !== WEIGHT_FOR_KIND[e.kind]) {
    return bad(
      "kind/weight mismatch",
      `kind '${e.kind}' requires weight '${WEIGHT_FOR_KIND[e.kind]}' but the event carries ` +
        `${JSON.stringify(e.weight)}. A genesis wearing live weight claims an authority no emitter gave it.`,
    );
  }
  if (!AUTHORITIES.includes(e.authority)) {
    return bad(
      "unknown authority",
      `authority is ${JSON.stringify(e.authority)}; expected one of ${AUTHORITIES.join(", ")}`,
    );
  }
  // A genesis is a RE-SERIALIZED agent draft. Letting one claim `owner` would mint
  // owner authority for 267 assertions no owner ever made — the failure class one
  // layer up that C5 names by name.
  if (e.kind === "genesis" && e.authority !== "agent") {
    return bad(
      "genesis cannot claim owner authority",
      `a genesis event is an agent-drafted assertion re-serialized — no emitter, no timestamp, no ` +
        `signature at the time it was drafted. Declaring authority '${e.authority}' on one claims live ` +
        `owner weight for a backfill.`,
    );
  }
  // ── THE RETRACTION FENCE (component 11) ────────────────────────────────────
  //
  // Retiring an item takes it out of live work, which is the adjudication
  // `burndown-traceability.md` MUST-4 reserves to the OWNER. An agent-emitted
  // retraction would be `Signed off` under another word, reaching the projection
  // through a kind the status fence below does not govern. So the kind carries the
  // authority requirement, and component 12 is what makes `owner` mean something.
  if (e.kind === "retraction" && e.authority !== "owner") {
    return bad(
      "retraction requires owner authority",
      `a retraction retires an item out of live work, which is an OWNER adjudication ` +
        `(burndown-traceability.md MUST-4). This event declares authority ` +
        `${JSON.stringify(e.authority)}. An agent that believes an item should be retired asks the ` +
        `owner to retract it; it does not retract it on the owner's behalf.`,
    );
  }
  // ── THE PROPOSAL FENCE (component 13) ──────────────────────────────────────
  //
  // A proposal is the AGENT's channel and only the agent's. An owner who wants a
  // status set emits the transition — they need no one to countersign them — so an
  // owner-authored proposal would be an owner adjudication wearing the one kind the
  // fold refuses to honour: a decision that looks made and changes nothing. Refused
  // in the same shape as the genesis clause above, which exists for the mirror
  // reason (a kind that cannot carry that authority says so).
  if (e.kind === "proposal" && e.authority !== "agent") {
    return bad(
      "proposal cannot claim owner authority",
      `a proposal is the channel by which an AGENT carries an owner's decision to the log for ` +
        `countersignature; it is INERT by construction and the fold never honours one. This event ` +
        `declares authority ${JSON.stringify(e.authority)}. An owner does not propose a status to ` +
        `themselves — they emit the transition.`,
    );
  }
  // ── THE ACTIVATION FENCE (component 13) ────────────────────────────────────
  //
  // An activation is the countersignature, and it IS folded — it carries an
  // owner-vocabulary status onto a live row. So it takes the retraction's bound
  // exactly: `authority: "owner"`, which `verifyAuthorityClaim` binds to a `role` in
  // the COMMITTED roster at the two places that adjudicate (`appendEvent`, and the
  // read gate). Without this clause the new kind would be a way around the
  // agent-cannot-assign-an-owner-status fence, which is precisely what this component
  // must not build.
  if (e.kind === "activation" && e.authority !== "owner") {
    return bad(
      "activation requires owner authority",
      `an activation COUNTERSIGNS a proposal and is the record the fold honours, so it sets an owner ` +
        `status on a live row — an OWNER adjudication (burndown-traceability.md MUST-4). This event ` +
        `declares authority ${JSON.stringify(e.authority)}. An agent that believes a status should ` +
        `advance appends a PROPOSAL; it does not activate its own.`,
    );
  }
  // The terminal status is DERIVED from the kind in BOTH directions. Without the
  // second direction a `transition` could carry `retired` and retire an item with no
  // owner anywhere near it — the laundering channel the fence above exists to close,
  // re-opened one field over.
  if (e.kind === "retraction" && statusKey(e.status) !== RETIRED_STATUS) {
    return bad(
      "retraction carries a non-terminal status",
      `a retraction's status is DERIVED, never accepted: it must be '${RETIRED_STATUS}', not ` +
        `${JSON.stringify(e.status)}. A caller-chosen status on a retraction is how an owner ` +
        `adjudication and a work-state update become the same record.`,
    );
  }
  if (e.kind !== "retraction" && statusKey(e.status) === RETIRED_STATUS) {
    return bad(
      "terminal status outside a retraction",
      `status ${JSON.stringify(e.status)} normalizes to the terminal status '${RETIRED_STATUS}' a ` +
        `RETRACTION projects; a '${e.kind}' event carrying it would retire an item without passing the ` +
        `owner-authority fence that kind carries.`,
    );
  }
  // A proposal's own status is DERIVED, in BOTH directions — the `RETIRED_STATUS`
  // discipline. Forward: a proposal must carry the neutral passthrough, so the record
  // claims nothing to any reader of `status`, including one that has never heard of
  // this kind. There is no reverse direction to state: `see burndown` is a legitimate
  // value for a transition, so carrying it is not evidence of anything.
  if (e.kind === "proposal" && statusKey(e.status) !== statusKey(PROPOSAL_STATUS)) {
    return bad(
      "proposal carries a non-neutral status",
      `a proposal's own status is DERIVED, never accepted: it must be ${JSON.stringify(PROPOSAL_STATUS)}, ` +
        `not ${JSON.stringify(e.status)}. The status it PROPOSES belongs in 'proposed_status', which ` +
        `nothing renders; a caller-chosen 'status' here is how an inert record becomes a rendered ` +
        `owner adjudication on any surface that reads the field it already knows.`,
    );
  }
  // `proposed_status` is a POSITIVE ALLOWLIST against the owner vocabulary, both
  // directions. Forward: a proposal that does not propose an OWNER status proposes
  // nothing an agent could not already append itself as an ordinary transition, so it
  // would spend the countersignature ceremony on a record that never needed one.
  // Reverse: the field is carried ONLY by the kind that defines it (`cc-artifacts.md`
  // Rule 10 — a field only some kinds carry is a field a reader has to guess about).
  if (e.kind === "proposal") {
    if (!OWNER_STATUSES.some((st) => statusKey(st) === statusKey(e.proposed_status))) {
      return bad(
        "proposed_status is outside the owner vocabulary",
        `'proposed_status' is ${JSON.stringify(e.proposed_status)}, which is not one of the burndown's ` +
          `owner statuses [${OWNER_STATUSES.join(", ")}]. This is an ALLOWLIST, normalized before ` +
          `comparison: a proposal exists to carry an OWNER adjudication for countersignature, and a ` +
          `non-owner status needs no countersignature because an agent may append it directly.`,
      );
    }
  } else if (e.proposed_status !== undefined) {
    return bad(
      "proposed_status outside a proposal",
      `'proposed_status' is carried ONLY by a proposal; a '${e.kind}' event carrying one declares a ` +
        `field no reader of this schema is defined to read — and on a kind the fold DOES honour it ` +
        `would sit beside the real status saying something different.`,
    );
  }
  // An activation's status IS the owner adjudication — positive allowlist, same
  // vocabulary. Its agreement with the proposal it names is a fact about the WHOLE LOG
  // and is checked in `_walk`, not here: `validateEvent` sees one line and cannot
  // resolve `activates` to anything.
  if (e.kind === "activation" && !OWNER_STATUSES.some((st) => statusKey(st) === statusKey(e.status))) {
    return bad(
      "activation carries a non-owner status",
      `an activation status is ${JSON.stringify(e.status)}, which is not one of ` +
        `[${OWNER_STATUSES.join(", ")}]. An activation exists to land an OWNER adjudication; one ` +
        `carrying an agent work-state spends an owner countersignature on a record an agent could ` +
        `have appended unaided.`,
    );
  }
  // `activates` and `accepted_by` are the countersignature itself, required on the one
  // kind that defines them and refused everywhere else (both directions, the `reason`
  // discipline). `accepted_by` REFUSES the words an agent reaches for — the same
  // refusal `check-archive-adjudication.mjs` makes against `accepted_by: "agent"`, and
  // for the identical reason (`completion-criterion.md` MUST-6: the party proposing
  // cannot also accept). It is inside the signed canonical bytes, so it is as
  // tamper-evident as the activation itself.
  if (e.kind === "activation") {
    if (isAgentAcceptor(e.accepted_by)) {
      return bad(
        "activation accepted by an agent",
        `'accepted_by' is ${JSON.stringify(e.accepted_by)}. An activation countersigns a proposal, and ` +
          `the party that proposed cannot also accept (completion-criterion.md MUST-6). This field ` +
          `names the HUMAN who decided; a value carrying any of ${AGENT_ACCEPTORS.join(", ")} as a WORD ` +
          `is refused, so "the release agent" is refused for the same reason a bare "agent" is.`,
      );
    }
  } else {
    for (const f of ["activates", "accepted_by"]) {
      if (e[f] !== undefined) {
        return bad(
          `${f} outside an activation`,
          `'${f}' is carried ONLY by an activation — it is half of the countersignature. A ` +
            `'${e.kind}' event carrying one declares a field no reader of this schema is defined to read.`,
        );
      }
    }
  }
  // `reason` is REQUIRED on a retraction and REFUSED on everything else. Required,
  // because a retirement with no recorded cause is un-auditable and the log is the
  // only record — it is inside the signed canonical bytes, so it is as tamper-evident
  // as the retraction itself. Refused elsewhere, because a field only some kinds carry
  // is a field a reader has to guess about (`cc-artifacts.md` Rule 10: positive
  // allowlist, never a coerced default).
  //
  // WIDENED to `proposal` (component 13), and required there for the SAME reason it is
  // required on a retraction: the proposal is the only place the owner's decision and
  // its grounds are written down, and an owner asked to countersign a bare item id is
  // being asked to ratify something they have to go and reconstruct. Still REFUSED on
  // every other kind — the positive allowlist is unchanged in shape, only its
  // membership moved.
  if (!KINDS_WITH_REASON.includes(e.kind) && e.reason !== undefined) {
    return bad(
      "reason on an event that does not carry one",
      `'reason' is carried ONLY by [${KINDS_WITH_REASON.join(", ")}], each of which needs a recorded ` +
        `cause; a '${e.kind}' event carrying one declares a field no reader of this schema is ` +
        `defined to read.`,
    );
  }
  for (const f of REQUIRED_FIELDS_FOR_KIND[e.kind]) {
    if (typeof e[f] !== "string" || !e[f]) {
      return bad("missing field", `'${f}' must be a non-empty string`);
    }
    if (e[f].length > MAX_FIELD_CHARS) {
      return bad("field too long", `'${f}' is ${e[f].length} chars; the maximum is ${MAX_FIELD_CHARS}`);
    }
  }
  // `burndown-traceability.md` MUST-4: statuses are the OWNER's, and an agent MUST
  // NOT set or advance one.
  //
  // WHAT THIS FENCE GUARANTEES, and what its NEIGHBOUR now guarantees. This clause is
  // a PRODUCER-SIDE discipline fence and nothing more: it refuses an event that
  // declares `authority: "agent"` and simultaneously carries an owner-vocabulary
  // status — the accident, not the adversary.
  //
  // The adversarial half used to be UNBUILT and was recorded here as an open finding:
  // `authority` was a SELF-DECLARED caller field, inside the signed canonical bytes so
  // un-alterable after signing, but with NOTHING anywhere mapping a signer to a role —
  // so a rostered signer could write `authority: "owner"` on their own event and this
  // function accepted it.
  //
  // That is CLOSED (component 12), and the close is stated with its exact reach so the
  // prose does not out-run the code (`instrument-bipolarity.md` MUST-4).
  // `verifyAuthorityClaim` binds a role-bound authority to the signer's `role` in the
  // COMMITTED roster; `appendEvent` applies it on the ONLY write path, and
  // `verifyAuthorityBindings` applies it to every record at the read gate, which
  // verifies signatures first. `validateEvent` ITSELF still cannot check it — it sees
  // the CALLER HALF, which carries no `verified_id` at all (that field is stamped by
  // `appendStamped`), so the binding lives where the signer is actually known.
  // `projectStatus` below remains the render-time half, and still verifies nothing.
  //
  // A POSITIVE ALLOWLIST, NOT A DENYLIST, and the change is a defect fix rather than a
  // tightening for its own sake. This clause was `OWNER_STATUSES.includes(e.status)` —
  // exact string equality against a DENYLIST — while the refusal message one line down
  // already declared the allowlist ("may carry only a `todo:`-prefixed work-state or
  // `see burndown`"). The gap between the two was reachable: `"Signed off "` with a
  // trailing space, or `"signed off"` lower-cased, is not in `OWNER_STATUSES`, passed
  // untouched, and rendered in a GFM cell as an owner adjudication no owner made. So
  // the code now implements what its own message promised (`cc-artifacts.md` Rule 10),
  // and `statusKey` normalizes before every comparison so a whitespace or case variant
  // cannot slip between the two.
  if (e.kind === "transition" && e.authority !== "owner") {
    const k = statusKey(e.status);
    const allowed = k === statusKey(SEE_BURNDOWN) || k.startsWith(TODO_STATUS_PREFIX);
    if (!allowed) {
      return bad(
        "agent cannot assign an owner status",
        `status ${JSON.stringify(e.status)} is outside what a non-owner transition may carry. An ` +
          `agent-authored transition may carry only a '${TODO_STATUS_PREFIX}'-prefixed work-state or ` +
          `'${SEE_BURNDOWN}'. This is an ALLOWLIST: a status that merely looks unlike an owner ` +
          `adjudication is not thereby permitted, because '${OWNER_STATUSES[0]} ' with a trailing space ` +
          `renders in a table cell exactly as the real thing does.`,
      );
    }
  }
  return { ok: true };
}

/**
 * Validate one ON-DISK RECORD: `validateEvent` PLUS the envelope the append path
 * stamps.
 *
 * ── WHY TWO FUNCTIONS AND NOT ONE ────────────────────────────────────────────
 *
 * They validate two different things, and conflating them is what let the envelope go
 * unchecked for 534 records. `validateEvent` answers "is this a valid event to
 * APPEND?" — it sees the CALLER HALF, before `appendStamped` has stamped `id`,
 * `timestamp`, `verified_id`, `sig`, and (now) `sig_alg`/`seq`/`prev_hash`.
 * `validateRecord` answers "is this a valid record ON DISK?", where every stamped
 * field must be present. The fold reads disk, so the fold uses THIS one.
 *
 * SHAPE ONLY, deliberately. That `seq` is an integer ≥ 1 is a shape fact this function
 * can decide from one line. That the chain is CONSISTENT — that `prev_hash` matches the
 * emitter's previous record and that no `(verified_id, seq)` forks — is a fact about
 * the WHOLE LOG and belongs to `signed-log.js::verifyChain`, which the verifying gate
 * runs. Keeping the per-line check O(1) keeps the fold deterministic and cheap; putting
 * the whole-log check in the fold would make every projection O(n²).
 */
function validateRecord(e) {
  const v = validateEvent(e);
  if (!v.ok) return v;
  const gen = SCHEMAS[e.schema];
  if (gen.declaresSigAlg && e.sig_alg === undefined) {
    return bad(
      "missing sig_alg",
      `schema '${e.schema}' is generation ${gen.generation}, whose records MUST declare 'sig_alg'. ` +
        `Absent NEVER reads as the default: coc-sign::verify falls back to keyType 'ssh' when told ` +
        `nothing, so an undeclared openpgp record verifies as a total signature failure.`,
    );
  }
  if (gen.requiresChain) {
    if (!Number.isInteger(e.seq) || e.seq < 1) {
      return bad(
        "missing chain position",
        `schema '${e.schema}' is generation ${gen.generation}, whose records MUST carry a per-emitter ` +
          `'seq' (integer ≥ 1); this record carries ${JSON.stringify(e.seq)}. Without it a deleted middle ` +
          `record is undetectable from the records themselves.`,
      );
    }
    const p = e.prev_hash;
    const wellFormed = p === null || (typeof p === "string" && /^[0-9a-f]{64}$/.test(p));
    if (!wellFormed) {
      return bad(
        "malformed chain link",
        `'prev_hash' must be a 64-char lowercase sha256 hex digest, or null at seq 1; this record ` +
          `carries ${JSON.stringify(p)}`,
      );
    }
    if (e.seq === 1 && p !== null) {
      return bad("malformed chain link", "a record at seq 1 has no predecessor, so 'prev_hash' must be null");
    }
    if (e.seq > 1 && p === null) {
      return bad("malformed chain link", `a record at seq ${e.seq} has a predecessor, so 'prev_hash' must not be null`);
    }
  }
  return { ok: true };
}

/**
 * Build the caller half of one event. `weight` is DERIVED, never accepted.
 *
 * It stamps the CURRENT generation's schema and NOTHING else about the envelope:
 * `sig_alg`, `seq` and `prev_hash` are stamped by `appendEvent`, next to `sig`, because
 * they are facts about the SIGNATURE and the LOG rather than about the event. A builder
 * that guessed them would be guessing about state it cannot see.
 */
function buildEvent({ kind, item_id, item, value_anchor, status, authority, source, reason, proposed_status, activates, accepted_by }) {
  const e = {
    schema: SCHEMA,
    kind,
    weight: WEIGHT_FOR_KIND[kind],
    item_id,
    item,
    value_anchor,
    // DERIVED for a retraction, exactly as `weight` is derived for every kind. A
    // caller-supplied status here would be silently overridden, so it is overridden
    // LOUDLY instead — `validateEvent` refuses any retraction whose status is not the
    // terminal one, so a caller that passed something else learns it rather than
    // discovering later that its value never reached disk.
    // A PROPOSAL's status is derived for the same reason and by the same rule: the
    // value it PROPOSES goes in `proposed_status`, and its own `status` is pinned to
    // the neutral passthrough so no surface reading `status` renders a claim.
    status: kind === "retraction" ? RETIRED_STATUS : kind === "proposal" ? PROPOSAL_STATUS : status,
    authority,
    source,
  };
  // Present ONLY on the kind that defines it, so a `transition` record's canonical
  // bytes are byte-identical to what they were before this kind existed.
  if (KINDS_WITH_REASON.includes(kind)) e.reason = reason;
  if (kind === "proposal") e.proposed_status = proposed_status;
  if (kind === "activation") {
    e.activates = activates;
    e.accepted_by = accepted_by;
  }
  return e;
}

/**
 * Read the operator roster from the COMMITTED tree.
 *
 * `git show HEAD:<rel>` resolves through the tree git holds, so a working-tree edit, a
 * symlink, or a mid-run swap cannot change what comes back — and there is no second
 * read to race, which a check-then-read pair would have. The failure is INDETERMINATE
 * in every branch: an absent, unreadable or unparseable roster means the claim could
 * not be EVALUATED, which is a different fact from the claim being false.
 *
 * @param {string} repoDir
 * @param {object} [opts]
 * @param {(repoDir:string)=>string} [opts.readRoster] injectable committed-roster read.
 *   It exists so the fixtures can drive every branch without a git repo; it does NOT
 *   soften the default, which is the real `HEAD:` read.
 */
function readCommittedRoster(repoDir, opts) {
  const o = opts || {};
  let raw;
  if (typeof o.readRoster === "function") {
    try {
      raw = o.readRoster(repoDir);
    } catch (err) {
      return unresolved(
        "roster unreadable",
        // The CLASS, not the message: an injected reader doing a filesystem read puts an
        // ABSOLUTE PATH in `err.message`, which is the one disclosure every refusal on
        // this path is worded to avoid.
        `the injected committed-roster reader threw a ${(err && err.constructor && err.constructor.name) || "non-Error"} ` +
          `(code ${(err && err.code) || "none"}), so the roster could not be read`,
      );
    }
  } else {
    const gitBin = resolveGitBinary();
    if (!gitBin) {
      return unresolved(
        "roster unreadable",
        `git could not be resolved on a trusted path, so '${ROSTER_REL}' cannot be read at HEAD. ` +
          `Nothing else maps a signer fingerprint to a role, so no authority claim can be evaluated.`,
      );
    }
    const args = ["show", `HEAD:${ROSTER_REL}`];
    try {
      raw = execFileSync(gitBin, args, {
        cwd: repoDir,
        encoding: "utf8",
        maxBuffer: MAX_ROSTER_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
        env: gitEnvForArgs(args),
      });
    } catch (err) {
      // `err.message` is NOT interpolated: a spawn failure's message embeds absolute
      // paths, which is the one disclosure every refusal on this path is worded to
      // avoid. The CODE is named, which is what tells an operator where to look.
      return unresolved(
        "roster unreadable",
        `'${ROSTER_REL}' could not be read at HEAD (${(err && err.code) || "git show failed"}). The roster ` +
          `is read from HEAD rather than the working tree because a working-tree roster is a trust root ` +
          `the adversary can write. "Could not verify" is a refusal, never a pass — commit the roster.`,
      );
    }
  }
  if (typeof raw !== "string") {
    return unresolved("roster unreadable", `the committed-roster read returned ${typeof raw}, not text`);
  }
  let roster;
  try {
    roster = JSON.parse(raw);
  } catch (err) {
    // The OFFSET, never the message: V8's JSON SyntaxError embeds a SNIPPET OF THE
    // INPUT, and the input here is the operator roster — display ids, logins,
    // fingerprints — which would land verbatim in CI logs and PR comments.
    const at = /position (\d+)/.exec((err && err.message) || "");
    return unresolved(
      "roster unparseable",
      `'${ROSTER_REL}' is not valid JSON at HEAD` +
        (at ? ` (parse failed at byte ${at[1]})` : "") +
        `. The parser's own message is NOT quoted here: it embeds a snippet of the input, and the ` +
        `input is the roster.`,
    );
  }
  if (!roster || typeof roster !== "object" || Array.isArray(roster)) {
    return unresolved("roster unparseable", `'${ROSTER_REL}' at HEAD is not a JSON object`);
  }
  return { ok: true, roster };
}

/**
 * Read the COMMITTED trust root, and distinguish ABSENT from BROKEN.
 *
 * THE THREE-WAY RETURN IS THE SECURITY-BEARING PART, and it is why this does not just
 * return `{ok}` like its roster sibling:
 *
 *   {absent:true}     not committed here. The caller MAY fall back to the roster — this
 *                     is every repo today, and it is what makes shard 1 behaviour-
 *                     preserving at loom and BUILD.
 *   {ok:true,index}   committed and well-formed. Authoritative; no fallback is consulted.
 *   {ok:false,...}    committed and BROKEN. **REFUSES, and the caller MUST NOT fall
 *                     back.** Falling back on a corrupt trust root would hand an
 *                     attacker a downgrade: damage the surface you cannot forge, and the
 *                     resolver silently reverts to one whose contents you can influence
 *                     differently. Present-but-unreadable is a refusal, never a retry.
 *
 * Read from HEAD, not the working tree, for the same reason the roster is: a working-tree
 * trust root is a trust root the adversary can write.
 */
function readCommittedTrustRoot(repoDir, opts) {
  const o = opts || {};
  let raw;
  if (typeof o.readTrustRoot === "function") {
    try {
      raw = o.readTrustRoot(repoDir);
    } catch (err) {
      return unresolved(
        "trust root unreadable",
        `the injected trust-root reader threw a ${(err && err.constructor && err.constructor.name) || "non-Error"} ` +
          `(code ${(err && err.code) || "none"}), so the trust root could not be read`,
      );
    }
    if (raw === null || raw === undefined) return { absent: true };
  } else {
    const gitBin = resolveGitBinary();
    if (!gitBin) {
      return unresolved(
        "trust root unreadable",
        `git could not be resolved on a trusted path, so '${TRUST_ROOT_REL}' cannot be read at HEAD.`,
      );
    }
    // ASK THE NARROW QUESTION FIRST. A catch-all around `git show` conflates "no such
    // path at HEAD" with EVERY other failure, and an attacker who can damage the file
    // picks whichever failure lands in the permissive branch. Measured in review: a
    // truncation, a >maxBuffer inflation, and any git-level error ALL read as ABSENT
    // and took the roster fallback that this module's own header calls "a downgrade an
    // attacker triggers by damaging the surface they cannot forge".
    //
    // `git cat-file -e HEAD:<path>` answers ONLY existence, so its failure is the one
    // case that genuinely means "not adopted here" — which is the case the permissive
    // branch exists to serve.
    const existsArgs = ["cat-file", "-e", `HEAD:${TRUST_ROOT_REL}`];
    try {
      execFileSync(gitBin, existsArgs, {
        cwd: repoDir,
        stdio: ["ignore", "ignore", "ignore"],
        env: gitEnvForArgs(existsArgs),
      });
    } catch {
      return { absent: true }; // genuinely not committed here — the only permissive case
    }
    const args = ["show", `HEAD:${TRUST_ROOT_REL}`];
    try {
      raw = execFileSync(gitBin, args, {
        cwd: repoDir,
        encoding: "utf8",
        maxBuffer: MAX_ROSTER_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
        env: gitEnvForArgs(args),
      });
    } catch (err) {
      // It EXISTS (proven above) and could not be read: oversize past `maxBuffer`, a
      // corrupt object, an unreadable pack. Present-but-unreadable is a REFUSAL, never
      // a retry against a different surface.
      return unresolved(
        "trust root unreadable",
        `'${TRUST_ROOT_REL}' EXISTS at HEAD but could not be read (${(err && err.code) || "git show failed"}). ` +
          `Existence was established separately, so this is damage rather than non-adoption, and it REFUSES ` +
          `rather than falling back to the roster — the fallback would be an attacker-triggerable downgrade.`,
      );
    }
  }
  // Present-and-empty is DAMAGE, not absence. An attacker who can truncate picks this
  // shape precisely because a length check reads it as "never adopted".
  if (typeof raw !== "string") {
    return unresolved("trust root unreadable", `the committed trust-root read returned ${typeof raw}, not text`);
  }
  if (!raw.trim()) {
    return unresolved(
      "trust root empty",
      `'${TRUST_ROOT_REL}' is committed but is EMPTY. Truncation is damage, not non-adoption: a repo that ` +
        `has not adopted a trust root does not have the path at all.`,
    );
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    // The OFFSET, never the message — V8's JSON SyntaxError embeds a snippet of the
    // input, and the input is key material.
    const at = /position (\d+)/.exec((err && err.message) || "");
    return unresolved(
      "trust root unparseable",
      `'${TRUST_ROOT_REL}' is committed but is not valid JSON` +
        (at ? ` (parse failed at byte ${at[1]})` : "") +
        `. A committed-but-broken trust root REFUSES rather than falling back to the roster: ` +
        `a fallback here is a downgrade an attacker can trigger by corrupting this file.`,
    );
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || !doc.signers || typeof doc.signers !== "object") {
    return unresolved(
      "trust root unparseable",
      `'${TRUST_ROOT_REL}' is committed but carries no 'signers' object.`,
    );
  }
  const index = trustRootIndex(doc);
  if (index.size === 0) {
    return unresolved(
      "trust root empty",
      `'${TRUST_ROOT_REL}' is committed but admits ZERO signers. An empty trust root is INDETERMINATE, ` +
        `not "no signer has authority": the two are indistinguishable downstream and only one is safe.`,
    );
  }
  // THE ANCHOR IS ENFORCED, not merely carried. It was written and never compared —
  // review called it decorative, correctly: a trust root lifted verbatim from ANOTHER
  // repository was accepted without complaint, which is precisely the wholesale
  // replacement first-wins anchoring exists to refuse.
  //
  // Skipped for an INJECTED reader (fixtures have no repo) and fail-OPEN when the root
  // commit cannot be resolved — git unavailable, a shallow or grafted checkout. That
  // half is deliberate: an anchor check that refuses because it could not ask the
  // question would take down every shallow CI clone, and the surface it guards is
  // already fail-closed on every other axis.
  const declaredAnchor = typeof doc.root_commit === "string" ? doc.root_commit : null;
  if (typeof o.readTrustRoot !== "function" && declaredAnchor) {
    const gitBin2 = resolveGitBinary();
    if (gitBin2) {
      let actual = null;
      const rootArgs = ["rev-list", "--max-parents=0", "HEAD"];
      try {
        const out = execFileSync(gitBin2, rootArgs, {
          cwd: repoDir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: gitEnvForArgs(rootArgs),
        });
        const roots = out.split("\n").map((s) => s.trim()).filter(Boolean);
        actual = roots.length ? roots[roots.length - 1] : null;
      } catch {
        actual = null; // unresolvable ⇒ the check does not run; see fail-open note above
      }
      if (actual && actual !== declaredAnchor) {
        return unresolved(
          "trust root anchored elsewhere",
          `'${TRUST_ROOT_REL}' declares root_commit ${safeId(declaredAnchor)} but this repository's root ` +
            `commit is ${safeId(actual)}. A trust root carrying another repository's anchor is a WHOLESALE ` +
            `REPLACEMENT, not an update — that is the case first-wins anchoring exists to refuse, and it is ` +
            `exactly what copying canon's committed trust root into a consumer would look like.`,
        );
      }
    }
  }
  return { ok: true, index, root_commit: declaredAnchor };
}

/**
 * fingerprint → {person_id, role, host_role}, built from a parsed TRUST ROOT.
 *
 * THE ADMISSION PREDICATE IS DELIBERATELY IDENTICAL to `signerIndex`'s — `pubkey` and
 * `type` both present and strings, FIRST WINS on a duplicate. Two indexes over the same
 * trust question that admit different entries can disagree about which entry a duplicated
 * fingerprint resolves to, so the key that verified a record and the role that authorised
 * it could come from different persons. That asymmetry is what an attacker looks for, and
 * it is the reason this function is a near-copy rather than a looser convenience reader.
 */
function trustRootIndex(doc) {
  const byFpr = new Map();
  for (const [fpr, s] of Object.entries((doc && doc.signers) || {})) {
    if (!fpr || typeof fpr !== "string") continue;
    if (!s || typeof s !== "object") continue;
    if (typeof s.pubkey !== "string" || typeof s.type !== "string") continue;
    if (typeof s.person_id !== "string" || !s.person_id) continue;
    if (byFpr.has(fpr)) continue;
    // KEY MATERIAL IS CARRIED, not dropped. An earlier revision kept only the role
    // projection here, which made `pubkey` dead data at runtime: the read gate resolved
    // ROLES from this index and KEYS from the roster, so the key that verified a record
    // and the role that authorised it came from two DIFFERENT FILES. That is the exact
    // asymmetry `signerIndex`'s own comment says the predicates are aligned to prevent,
    // reproduced one layer up between artifacts instead of between indexes. Carrying
    // both projections is what lets ONE read of this file answer both questions.
    byFpr.set(fpr, {
      person_id: s.person_id,
      role: s.role,
      host_role: s.host_role,
      pubkey: s.pubkey,
      keyType: s.type,
      fingerprint: fpr,
    });
  }
  return byFpr;
}

/**
 * fingerprint → {person_id, role, host_role}, built from a parsed roster.
 *
 * FIRST WINS on a duplicate fingerprint, matching `burndown-build.mjs::rosterKeyResolver`
 * deliberately: a duplicate across two persons is a roster defect its own schema
 * validator owns, and silently preferring the LATER one would let a roster edit
 * re-point an existing signer without the diff reading as a change of signer.
 *
 * THE ADMISSION PREDICATE IS THE SAME ONE THE KEY RESOLVER USES — `fingerprint`,
 * `pubkey` and `type` all present and strings — and matching it is not cosmetic. Two
 * indexes over one roster that admit different entries can disagree about WHICH entry
 * a duplicated fingerprint resolves to, so the key that verified a record and the role
 * that authorised it could come from different persons. Admitting a half-declared entry
 * here would also be strictly looser than the signature path, which skips it: the
 * signer would be `unrostered-signer` for signatures and role-resolvable for authority,
 * which is the asymmetry an attacker looks for.
 */
function signerIndex(roster) {
  const byFpr = new Map();
  for (const [pid, person] of Object.entries((roster && roster.persons) || {})) {
    if (!person || typeof person !== "object") continue;
    // NON-EMPTY `pid`, matching `trustRootIndex`. `pid` arrives as an object KEY here
    // and was never checked, so an entry under `""` was admitted here and REFUSED
    // there — while a comment below asserted the two predicates are identical. Review
    // found the divergence. It is aligned UPWARD (this one tightens) rather than by
    // relaxing the trust root, because the failure mode of "restoring parity" in the
    // other direction is loosening the surface that grants authority.
    if (!pid) continue;
    for (const k of person.keys || []) {
      if (!k || typeof k.fingerprint !== "string" || !k.fingerprint) continue;
      if (typeof k.pubkey !== "string" || typeof k.type !== "string") continue;
      if (byFpr.has(k.fingerprint)) continue;
      byFpr.set(k.fingerprint, { person_id: pid, role: person.role, host_role: person.host_role });
    }
  }
  return byFpr;
}

/**
 * The LAZY committed-roster signer resolver.
 *
 * Lazy because a role-bound authority is rare and an `agent` transition is the hot
 * path: constructing this costs nothing, and the `git show` happens on the FIRST claim
 * that actually needs it, or never. The result — including a FAILURE — is cached, so a
 * log carrying 300 owner claims reads the roster once and an outage reports identically
 * on every record rather than re-spawning git 300 times.
 *
 * @returns {(verifiedId:string)=>({ok:true,person_id:string,role:*,host_role:*}|{ok:false,indeterminate:boolean,error:string,reason:string})}
 */
function makeRosterSignerResolver(repoDir, opts) {
  const o = opts || {};
  let cached = null;
  return function resolveSigner(verifiedId) {
    if (cached === null) {
      // `opts.roster` is an ALREADY-READ committed roster, for a caller that read the
      // trust root for another purpose in the same run (the generator resolves KEYS
      // from it before it resolves ROLES). It is NOT a relaxation: the caller supplying
      // it is the one that did the `HEAD:` read, and re-reading would open a window in
      // which the key that verified a record and the role that authorised it came from
      // two different rosters.
      // A PRE-READ TRUST-ROOT INDEX WINS OVER A PRE-READ ROSTER, and this ordering is
      // the fix for a CRITICAL found in review. The read gate reads its trust surface
      // ONCE and passes it in; before this option existed it could only pass `roster`,
      // which took the branch below and meant `readCommittedTrustRoot` was NEVER
      // REACHED FROM THE READ GATE. The trust root was authoritative on `appendEvent`
      // alone — the write path, which is the path an adversary skips by hand-writing a
      // signed record. So the trust root could LOOSEN the producer and could not
      // TIGHTEN the reader: a demotion recorded here was unenforceable against the only
      // actor it was meant to bind.
      if (o.trustRootIndex instanceof Map) {
        cached = { ok: true, index: o.trustRootIndex, source: TRUST_ROOT_REL };
      } else if (o.roster !== undefined && o.roster !== null) {
        cached = { ok: true, index: signerIndex(o.roster), source: ROSTER_REL };
      } else {
        // THE TRUST ROOT IS CONSULTED FIRST, and its ABSENCE is the only condition that
        // permits the roster fallback. A committed-but-broken trust root REFUSES here
        // rather than falling through — see `readCommittedTrustRoot`, where the reason
        // is that a fallback on corruption is an attacker-triggerable downgrade.
        //
        // "BEHAVIOUR-PRESERVING BY CONSTRUCTION" WAS CLAIMED HERE AND IS WITHDRAWN —
        // review falsified it on the PR's own evidence. Loom COMMITS a trust root in
        // this very change, so loom takes the VALID branch, not `absent`.
        //
        // Behaviour IS preserved at loom, but it is VERIFIED, not structural: the two
        // indexes were measured equal (4 entries, identical {person_id, role, host_role}
        // for every fingerprint), and they stay equal because the generator derives one
        // from the other and `--check` runs in `validate-emit` (CI) plus
        // `registration-preflight` (pre-push). Drift is possible the instant someone
        // edits the roster without regenerating; those gates are what catch it.
        //
        // AND ADOPTING A TRUST ROOT INHERITS A NEW FAILURE MODE the roster-only world
        // did not have: an operator added to the roster but NOT regenerated into the
        // trust root resolves as `unrostered signer`, because the VALID branch never
        // falls back. That is why the refusal below names the surface actually consulted.
        const tr = readCommittedTrustRoot(repoDir, o);
        if (tr.ok === true) {
          cached = { ok: true, index: tr.index, source: TRUST_ROOT_REL };
        } else if (tr.absent === true) {
          const r = readCommittedRoster(repoDir, o);
          cached = r.ok ? { ok: true, index: signerIndex(r.roster), source: ROSTER_REL } : r;
        } else {
          cached = tr;
        }
      }
    }
    if (cached.ok !== true) return cached;
    const hit = cached.index.get(verifiedId);
    if (!hit) {
      // The message NAMES THE SURFACE ACTUALLY CONSULTED. Once two surfaces can answer
      // this question, a refusal citing a file the resolver never read sends the
      // operator to edit the wrong one — and they would find their entry present there
      // and conclude the guard is broken.
      const src = cached.source || ROSTER_REL;
      return unresolved(
        "unrostered signer",
        `no entry in the COMMITTED '${src}' carries a key with fingerprint ` +
          `${safeId(verifiedId)}, so this signer has no role and the claim cannot be evaluated. ` +
          `That is INDETERMINATE, not a forgery: run /whoami --register, or commit the entry in '${src}'.`,
      );
    }
    return { ok: true, person_id: hit.person_id, role: hit.role, host_role: hit.host_role };
  };
}

/**
 * THE AUTHORITY BINDING (component 12).
 *
 * Decide whether a signer may assert the authority their event declares. PURE apart
 * from the injected resolver, so both ends — the producer at append time and the read
 * gate over a whole log — apply the identical predicate rather than two copies of it.
 *
 * Returns one of THREE shapes, never two:
 *   {ok:true,...}                              the claim is BACKED (or needs no backing)
 *   {ok:false, indeterminate:true, ...}        verification could not RUN
 *   {ok:false, ...}                            the claim is FALSE — a positive finding
 *
 * @param {object} claim  {authority, verified_id, person_id}
 * @param {Function} resolveSigner  from `makeRosterSignerResolver`
 */
function verifyAuthorityClaim(claim, resolveSigner) {
  const c = claim || {};
  if (!AUTHORITIES.includes(c.authority)) {
    return bad("unknown authority", `authority is ${JSON.stringify(c.authority)}; expected one of ${AUTHORITIES.join(", ")}`);
  }
  if (!ROLE_BOUND_AUTHORITIES.includes(c.authority)) {
    // Not a silent pass: the caller is told the claim was NOT bound and why, so
    // "checked and backed" and "needed no backing" cannot render identically.
    return { ok: true, bound: false, authority: c.authority, why: `authority '${c.authority}' is not role-bound` };
  }
  if (typeof resolveSigner !== "function") {
    return unresolved(
      "no signer resolver",
      `authority '${c.authority}' is role-bound and no signer resolver was supplied, so the roster was ` +
        `never consulted. An absent resolver NEVER reads as permission — that would restore the ` +
        `self-declared field this binding exists to remove.`,
    );
  }
  const who = c.verified_id;
  if (typeof who !== "string" || !who) {
    return bad(
      "unattributed authority claim",
      `an event declaring authority '${c.authority}' carries no verified_id, so there is no signer to ` +
        `resolve a role for. A role-bound authority asserted by nobody is exactly the self-declaration ` +
        `this fence removes.`,
    );
  }
  let r;
  try {
    r = resolveSigner(who);
  } catch (err) {
    return unresolved(
      "signer resolver threw",
      `resolving ${safeId(who)} threw a ${(err && err.constructor && err.constructor.name) || "non-Error"}; the ` +
        `message is not quoted because it may embed an absolute path`,
    );
  }
  if (!r || r.ok !== true) {
    return {
      ok: false,
      indeterminate: !!(r && r.indeterminate),
      error: (r && r.error) || "signer unresolved",
      reason: (r && r.reason) || `the signer resolver returned no verdict for ${safeId(who)}`,
    };
  }
  // The stamped `person_id` is REQUIRED and must AGREE with the person that owns the
  // key. The FINGERPRINT is the identity the signature is bound to, so it is
  // authoritative; a disagreeing `person_id` is a positive finding about the record —
  // an event signed by one person and attributed to another.
  //
  // REQUIRED, not merely checked-when-present. An earlier revision guarded on
  // `typeof c.person_id === "string" && c.person_id`, so a hand-written record that
  // simply OMITTED the field skipped the agreement check silently while the header
  // said the field was "required to AGREE" — a claim the code did not implement
  // (`instrument-bipolarity.md` MUST-4). `appendStamped` always stamps it, so no
  // legitimate record is affected.
  if (typeof c.person_id !== "string" || !c.person_id) {
    return bad(
      "unattributed authority claim",
      `an event declaring authority '${c.authority}' carries no person_id, so the fingerprint's roster ` +
        `binding has nothing to be checked against. A role-bound authority attributed to nobody is the ` +
        `self-declaration this fence removes.`,
    );
  }
  if (c.person_id !== r.person_id) {
    return bad(
      "authority person_id mismatch",
      `the record is stamped person_id ${safeId(c.person_id)} but the COMMITTED roster binds fingerprint ` +
        `${safeId(who)} to ${safeId(r.person_id)}. The fingerprint is what the signature actually attests, ` +
        `so the stamp is the field that is wrong — UNLESS the roster changed after this record was ` +
        `signed. ${TEMPORAL_BOUND}`,
    );
  }
  if (!ROSTER_ROLES.includes(r.role)) {
    return unresolved(
      "unrecognized roster role",
      `the COMMITTED roster declares role ${safeId(r.role)} for person ${safeId(r.person_id)}; ` +
        `the declared vocabulary is ${ROSTER_ROLES.join(", ")}. A role nobody declared cannot be shown to ` +
        `carry authority '${c.authority}', so this is INDETERMINATE — repair the roster.`,
    );
  }
  if (!ROSTER_HOST_ROLES.includes(r.host_role)) {
    return unresolved(
      "unrecognized roster host_role",
      `the COMMITTED roster declares host_role ${safeId(r.host_role)} for person ` +
        `${safeId(r.person_id)}; the declared vocabulary is ${ROSTER_HOST_ROLES.join(", ")}. Whether ` +
        `this signer is a human or an audit-only CI host is undecidable, and audit-only hosts are never ` +
        `eligible — so the claim cannot be evaluated.`,
    );
  }
  // ── THE ELIGIBILITY VERDICT IS DELEGATED, NOT RE-IMPLEMENTED ─────────────
  //
  // The R5-S-04 audit-only-host exclusion and the role floor are BOTH decided by
  // `eligibility.js::isEligibleSigner`, the declared single source of truth, under the
  // `ledger-authority` signing context. Inlining `person.host_role === "ci"` here would
  // have been a FOURTH copy of that predicate — the exact drift class MED-3 consolidated
  // and `audit-fixtures/coordination-log-fold/flag-eligibility-drift-host-role-ci.txt`
  // exists to red on ("Drift between sites was unbounded").
  //
  // The TAXONOMY stays here and is deliberately not delegated: `isEligibleSigner` is
  // two-state by design, and this function owes three. So the vocabulary checks above
  // run FIRST and classify an undeclared role or host_role as INDETERMINATE; only a
  // fully-declared person reaches the delegate, whose `eligible:false` is then a
  // DECIDED refusal. Delegate the predicates, keep the taxonomy.
  const ctx = SIGNING_CONTEXT_FOR_AUTHORITY[c.authority];
  const elig = isEligibleSigner({ role: r.role, host_role: r.host_role }, ctx);
  if (!elig.eligible) {
    return bad(
      "authority not backed by role",
      `the event declares authority '${c.authority}', which resolves to signing context '${ctx}'; the ` +
        `COMMITTED roster gives person ${safeId(r.person_id)} role '${safeId(r.role)}' on a ` +
        `'${safeId(r.host_role)}' host, and eligibility.js refused it: ${elig.reason}. 'authority' is a ` +
        `SELF-DECLARED field and this is what checks it. ${TEMPORAL_BOUND}`,
    );
  }
  return { ok: true, bound: true, authority: c.authority, person_id: r.person_id, role: r.role };
}

/** Finding kinds that mean "could not RUN", not "is false". */
const AUTHORITY_INDETERMINATE_KINDS = Object.freeze(["authority-indeterminate", "authority-unparseable"]);

/**
 * Apply `verifyAuthorityClaim` to every record in a log (the read-gate half).
 *
 * `checked` counts records that CLAIMED a role-bound authority — the population this
 * instrument can actually speak about. A log with none returns `checked: 0`, and the
 * caller is expected to REPORT that rather than render it as a pass: a zero here means
 * the check examined nothing, which is a different fact from every claim being backed.
 *
 * Unparseable lines are recorded rather than skipped, but they are INDETERMINATE here:
 * this function is not the parser, and the fold and the signature gate both refuse a
 * malformed line with a far better diagnosis.
 */
function verifyAuthorityBindings(text, resolveSigner) {
  const findings = [];
  let checked = 0;
  const lines = String(text == null ? "" : text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const ordinal = i + 1;
    if (!raw.trim()) continue;
    let e;
    try {
      e = JSON.parse(raw);
    } catch (err) {
      findings.push({ line: ordinal, kind: "authority-unparseable", why: `unparseable JSON: ${(err && err.message) || String(err)}` });
      continue;
    }
    if (!e || typeof e !== "object" || !ROLE_BOUND_AUTHORITIES.includes(e.authority)) continue;
    checked++;
    const v = verifyAuthorityClaim({ authority: e.authority, verified_id: e.verified_id, person_id: e.person_id }, resolveSigner);
    if (v.ok) continue;
    findings.push({
      line: ordinal,
      kind: v.indeterminate ? "authority-indeterminate" : "authority-unbacked",
      why: `${v.error}: ${v.reason}`,
    });
  }
  // PER-KIND COUNTS, not just the all-or-nothing flag. `indeterminate` alone collapses
  // a MIXED set: one decided finding beside nine outages yields `indeterminate: false`,
  // and the caller's headline then reports all ten as records whose signer lacked the
  // authority — nine of which are an unreadable roster. The flag is kept (callers read
  // it) and the counts are added so a caller can render BOTH clauses.
  const unbackedCount = findings.filter((f) => !AUTHORITY_INDETERMINATE_KINDS.includes(f.kind)).length;
  const indeterminateCount = findings.length - unbackedCount;
  const indeterminate = findings.length > 0 && unbackedCount === 0;
  return { ok: findings.length === 0, indeterminate, checked, findings, unbackedCount, indeterminateCount };
}

/**
 * THE ONE APPEND PATH.
 *
 * `opts.append` exists so the fixtures can drive every refusal branch without a
 * signing key or a repo on disk. It defaults to the real `appendStamped`, and a
 * caller that omits it gets the signed, hardened, refuse-on-overflow write — there
 * is no unsigned production path to reach.
 */
function appendEvent(repoDir, partial, opts) {
  const o = opts || {};
  const v = validateEvent(partial);
  if (!v.ok) return v;
  if (!o.identity || !o.identity.verified_id || !o.identity.person_id) {
    return bad(
      "missing identity",
      "an event with no verified_id/person_id cannot be attributed to a human; run /whoami --register if un-rostered",
    );
  }

  // ── THE ENVELOPE IS THE APPEND PATH'S, NOT THE CALLER'S ────────────────────
  //
  // Every field in STAMPED_FIELDS is now overwritten downstream, whatever the caller
  // sends: `coc-append.js::appendStamped` PINS the envelope (id, timestamp, session_id,
  // repo, verified_id, person_id, display_id — composed prefix, partial, prefix again)
  // and writes `sig` after signing, and this function sets `seq` / `prev_hash` after the
  // partial (below). Until 2026-09-27 appendStamped composed prefix-then-partial and the
  // PARTIAL WON, so a caller `verified_id` landed a record whose signer was not the
  // identity the authority fence below adjudicated. That lever is closed at the source.
  //
  // The refusal STAYS, as defence in depth, for two reasons the pin does not cover:
  //   1. A pinned field is SILENTLY IGNORED. A caller half carrying one is a caller
  //      that believes it controls the envelope; refusing turns that silent drop into
  //      a loud, typed error at the only place both halves are visible.
  //   2. `o.append` is an injection seam. The pin is a property of `appendStamped`,
  //      not of whatever appender a caller passes, so this module cannot rely on it.
  // `validateEvent` cannot host this check: it is shared with `validateRecord`, whose
  // input is an ON-DISK record where every one of these fields is REQUIRED.
  //
  // No production caller does this today — all three go through `buildEvent`, which
  // whitelists its own keys. `guides/handbook/docket/02-work-ledger.md` §4.2 quotes the
  // refusal below as canon's bytes: reword both together, never one.
  for (const f of STAMPED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(partial, f)) {
      return bad(
        "caller half carries a stamped field",
        `'${f}' is stamped by the append path, never by the caller: appendStamped pins it after the ` +
          `partial (silently dropping a caller key of the same name), and an injected appender may not pin ` +
          `it at all. A partial supplying it would write a record whose envelope disagrees with the identity ` +
          `this call was authorized under.`,
      );
    }
  }

  // ── THE AUTHORITY FENCE (component 12) ─────────────────────────────────────
  //
  // Placed HERE, immediately after the identity check, because the claim it
  // adjudicates is a property of the (caller half, identity) PAIR and nothing further
  // down is needed to decide it. Ordering is a refusal IDENTITY choice, and an
  // un-backed `owner` claim should be diagnosed as an authority problem rather than
  // surfacing later as a suite or chain refusal that names the wrong thing.
  //
  // FAIL CLOSED. `o.resolveSigner` exists for the fixtures; a caller that omits it
  // gets the real COMMITTED-roster read. There is no branch on which an unresolvable
  // signer, an unreadable roster, or an unrecognized role falls through to accepting
  // the self-declared value — every one of them REFUSES, and the typed refusal says
  // which of the three it was.
  //
  // It costs the hot path NOTHING: the resolver is lazy and `verifyAuthorityClaim`
  // consults it only for a ROLE-BOUND authority, so an `agent` transition — which is
  // what the `PostToolUse` producer emits — never spawns git.
  const authz = verifyAuthorityClaim(
    { authority: partial.authority, verified_id: o.identity.verified_id, person_id: o.identity.person_id },
    typeof o.resolveSigner === "function" ? o.resolveSigner : makeRosterSignerResolver(repoDir, o),
  );
  // THE THIRD STATE IS FORWARDED, not flattened. `bad()` alone drops `indeterminate`,
  // and this is the ONLY write path — so a caller could not tell an unreadable roster
  // from a rejected claim except by string-matching `error`, while the header two
  // hundred lines up promises "THREE STATES, NEVER TWO … they differ in what the
  // operator must go and fix". The promise is made true here rather than softened there.
  if (!authz.ok) {
    return Object.assign(bad(authz.error, authz.reason), authz.indeterminate ? { indeterminate: true } : {});
  }

  // ── THE SUITE FENCE (D1 part 2) ────────────────────────────────────────────
  //
  // The manifest declares ONE accepted suite for this log's CURRENT generation, and
  // this is where single-suite stops being a convention and becomes a structural fact.
  // `decideAppendSuite` refuses three disagreements: an event addressed to a CLOSED
  // generation, a caller-supplied `sig_alg` that is not the declared suite, and — the
  // one a convention can never hold — a SIGNING KEY whose type is not the declared
  // suite's. That last one is the real-world failure: the operator's
  // `git config gpg.format` is openpgp today, and the day it becomes ssh every caller
  // keeps working, keeps passing a discovered `signOpts.keyType`, and the log silently
  // becomes mixed. Refusing at the first append turns that into a generation-roll
  // prompt instead of a corrupted log.
  //
  // Fail CLOSED at every step: an absent, unreadable, malformed or unrecognised
  // declaration REFUSES. There is no default suite anywhere on this path.
  const pol = signedLog.loadSuitePolicy(repoDir, o.manifestRel, { policy: o.suitePolicy, readFile: o.readFile });
  if (!pol.ok) return bad(pol.error, pol.reason);
  const suite = signedLog.decideAppendSuite(partial, pol.policy, o.signOpts);
  if (!suite.ok) return bad(suite.error, suite.reason);

  // ── THE CHAIN (D2, the schema half) ────────────────────────────────────────
  //
  // Per-emitter `seq` + `prev_hash`, the model `coordination-log.js` already
  // implements. Computed over the CURRENT generation only, so generation 0's 534
  // chainless records neither participate nor need re-emitting. Costs one O(n) read of
  // the log per append — the objection the prior design raised, kept and measured
  // rather than waved away.
  const abs = path.join(repoDir, EVENTS_REL);

  // ── T68 CLAUSE 3: THE OWNER'S OWN GUARDED WRITES ARE COVERED TOO ───────────
  //
  // THIS is the instance that forced the clause. `todo-durable-guard`, a HOOK doing
  // exactly what it is designed to do, appended a signed, hash-chained transition here
  // because a `todos/` file was edited — and the append landed on a TRACKED file inside
  // a live `dev-preflight` window, costing a GREEN run:
  //   `dev-preflight --import-receipt: REFUSED — this clone's tree is DIRTY; a green
  //    cannot be bound to it`.
  //
  // There is NO OWNER EXEMPTION and no SPOOL. Exempting the owner would exempt the
  // window's own session — whose hooks are the ones that fire during its own preflight.
  // Spooling the row to a side file would be the silent fallback `zero-tolerance.md`
  // Rule 3 forbids: `burndown-build.mjs` folds THIS path, so a row written elsewhere is
  // invisible to every projection while the caller is told it was recorded.
  //
  // The refusal is TYPED and arrives through the `bad()` channel every caller already
  // handles — `todo-durable-guard.js` collects it into its `refused` list and reports
  // "N transition(s) REFUSED by the append gate", so the loss is stated rather than
  // dropped. Placed BEFORE the chain read so a frozen append costs no O(n) log read.
  let frozen = null;
  try {
    frozen = require("./landing-window-read.js").windowCovers(repoDir, abs);
  } catch {
    // Detector unavailable is NOT a finding; the run's dirty-tree check is the second layer.
    frozen = null;
  }
  if (frozen && frozen.covered) {
    return bad(
      "landing window",
      `a LANDING WINDOW is live over this working tree, so '${EVENTS_REL}' is FROZEN and this event was ` +
        `NOT recorded. window: ${frozen.description}; marker: ${frozen.path}. A \`dev-preflight\` receipt ` +
        `binds to the head AND the tree digest, so any tracked change inside the window makes the run ` +
        `un-bindable. Re-issue this transition after the window closes (the todo edit itself is also ` +
        `refused by \`.claude/hooks/landing-window-guard.js\` while the window is open).`,
    );
  }

  const stamped = Object.assign({}, partial, { schema: suite.schema, sig_alg: suite.sig_alg });
  if (pol.policy.requiresChain) {
    let text = "";
    try {
      text = (o.readLog ? o.readLog(abs) : fs.readFileSync(abs, "utf8"));
    } catch (err) {
      // ENOENT is the FIRST append and is not an error; anything else is, and is
      // refused rather than silently treated as an empty log — an unreadable log read
      // as empty would restart every emitter's chain at seq 1 and forge a fork.
      if (!err || err.code !== "ENOENT") {
        return bad(
          "log unreadable",
          `'${EVENTS_REL}' could not be read to compute this emitter's chain position ` +
            `(${(err && err.code) || (err && err.message) || String(err)}). An unreadable log read as EMPTY ` +
            `would restart the chain at seq 1 and forge a fork.`,
        );
      }
    }
    const chain = signedLog.chainFieldsFor(text, o.identity.verified_id, suite.schema);
    if (!chain.ok) return bad(chain.error, chain.reason);
    stamped.seq = chain.seq;
    stamped.prev_hash = chain.prev_hash;
  }

  const rec = validateRecord(Object.assign({ id: "pre", sig: "pre" }, stamped));
  if (!rec.ok) return bad(rec.error, `the stamped envelope is invalid before writing: ${rec.reason}`);

  const append = typeof o.append === "function" ? o.append : appendStamped;
  let r;
  try {
    r = append(repoDir, abs, stamped, { identity: o.identity, signOpts: o.signOpts || {} });
  } catch (err) {
    // `appendStamped` documents that it never throws; a throw here means a
    // dependency did. Typed, never swallowed.
    return bad("append threw", (err && err.message) || String(err));
  }
  if (!r || !r.ok) {
    return bad(
      (r && r.error) || "append failed",
      (r && r.reason) || "the append helper returned a non-ok result with no reason",
    );
  }
  return { ok: true, id: r.id, line: r.line };
}

/**
 * Fold the log into the projection shape `parseLedger` returns.
 *
 * PURE: text in, plain data out. It writes nothing and reads no repo — the tracker
 * regeneration that will CONSUME this is a separate shard. What it exists to prove
 * here is that the schema CAN produce `Map<id, {id, anchorRaw, item, line}>`, which
 * is the claim the whole design rests on.
 *
 * `anchorRaw` is the RAW cell text, matching `parseLedger`: `resolveAnchor` runs
 * `stripDecoration` itself, and pre-stripping here would bind two readers to one
 * decoration policy.
 *
 * A malformed line is SKIPPED AND RECORDED, never silently dropped: the caller gets
 * `skipped[]` with a line number, a reason, and a `kind` from `SKIP_KINDS`, so "the log
 * folded clean" and "the log had six unreadable lines" cannot render identically — and
 * "six unreadable lines" and "one proposal awaiting its countersignature" cannot either.
 * Classify a skip with `partitionSkips`, never by matching its `why` prose.
 */
function foldEvents(text) {
  return _walk(text, (e, ordinal) => ({
    id: e.item_id,
    anchorRaw: e.value_anchor,
    item: e.item,
    line: ordinal,
  }));
}

/**
 * Fold the log into the PROJECTION row shape — the five cells
 * `.session-notes.shared.md` renders. Same walk, same C5 fence, one extra
 * mapping; the fence is SHARED rather than re-implemented, because two folds
 * disagreeing about which event wins is the drift class this whole design exists
 * to close.
 *
 * ── WHY `status` IS NOT `e.status` ───────────────────────────────────────────
 *
 * MEASURED at this shard's landing, with a positive control (the same grep fires
 * 26 and 241 times against the committed tracker and 0 times against the log):
 * the 267 genesis events carry `status` values drawn from the burndown SOURCES —
 * 261 `Not started`, 4 `In progress`, 2 `Blocked on you` — while the tracker rows
 * they were built from carry 26 `see burndown` and 241 `awaiting human
 * adjudication`. `burndown-genesis.mjs` takes `item`/`value_anchor` from the
 * TRACKER and `status` from `manifest.sources`, so every one of those 267 statuses
 * is in the burndown's CLOSED OWNER VOCABULARY (`OWNER_STATUSES`) while the event
 * carrying it declares `authority: "agent"`.
 *
 * `burndown-traceability.md` MUST-4 is that statuses are the OWNER's and an agent
 * MUST NOT set or advance one — the fence `validateEvent` applies to a
 * `transition` and, by construction, cannot apply to a `genesis` (a backfill of
 * pre-existing state is not an agent ADVANCING anything). Projecting `e.status`
 * verbatim would therefore render 267 owner adjudications no owner ever made,
 * straight into the surface a human reads — the C5 failure class one layer up.
 *
 * So the projection applies the fence AT RENDER TIME instead:
 *
 *   an owner-vocabulary status is projected ONLY from an `authority: "owner"`
 *   event; from any other authority it projects the neutral passthrough
 *   `see burndown`, which claims nothing.
 *
 * A non-owner-vocabulary status (a `todo:` work-state, `see burndown` itself) is
 * projected verbatim whatever the authority — it makes no owner claim to launder.
 *
 * This is LOSSY and the loss is named rather than implied: the tracker's own
 * `awaiting human adjudication` is not recoverable from the log, because the
 * backfill never conserved it. It is not DESTROYED — every such row's
 * `value_anchor` names a context artifact that `--check-links` proves is tracked
 * and carries the id verbatim — but it does not survive a regeneration, and that
 * is a NEW FINDING for the operator, not a decision this fold makes quietly.
 */
function foldProjection(text) {
  return _walk(text, (e, ordinal) => ({
    id: e.item_id,
    owner: e.display_id || e.person_id || e.verified_id || "unknown",
    item: e.item,
    anchorRaw: e.value_anchor,
    status: projectStatus(e),
    line: ordinal,
  }));
}

/**
 * The render-time authority fence, as ONE named function so it is inspectable and
 * testable rather than inlined into a template string. See `foldProjection`.
 */
function projectStatus(e) {
  if (!e || typeof e.status !== "string") return SEE_BURNDOWN;
  // NORMALIZED, for the reason the `validateEvent` allowlist records: `"Signed off "`
  // is not in `OWNER_STATUSES` under string equality and renders in a GFM cell exactly
  // as `Signed off` does, so a raw comparison here would project a laundered owner
  // adjudication from a non-owner event. This fence sees ON-DISK records, including
  // hand-written ones the producer never validated, so it cannot rely on the producer
  // having refused them.
  const k = statusKey(e.status);
  if (OWNER_STATUSES.some((s) => statusKey(s) === k) && e.authority !== "owner") return SEE_BURNDOWN;
  return e.status;
}

/**
 * The CLASS of every `skipped[]` entry `_walk` records — a CLOSED vocabulary, set at the
 * PRODUCER so no consumer has to recover a class by string-matching `why`.
 *
 * WHY IT EXISTS. `skipped[]` carries two populations that mean opposite things: lines the
 * fold could not READ (unparseable JSON, a record failing `validateRecord`) and WELL-FORMED
 * records the fold deliberately did not honour (an inert proposal, a fenced activation, a
 * baseline genesis under a live row, a non-owner un-retirement, a phantom retraction).
 * Consumers that counted `skipped.length` as "unreadable" told an operator a valid proposal
 * awaiting sign-off was corruption, and `session-notes-layout.js::regenerateForestLedger`
 * refused to render the shared ledger over a log whose every line read clean. The readers
 * that re-derive "malformed" by re-parsing each line (`burndown-build.mjs::foldLedgerEvents`,
 * `burndown-countersign.mjs::foldOrDie`) were right; the ones that trusted the count were not.
 *
 * ADDITIVE: every entry keeps `line` and `why`, so the arithmetic cross-checks that count
 * `skipped.length` are unmoved. Well-formed skips also carry `item_id` and `record_id` (and
 * an activation's `activates`) so a consumer can NAME what is outstanding.
 */
const SKIP_KINDS = Object.freeze({
  UNPARSEABLE: "unparseable",
  INVALID_RECORD: "invalid-record",
  PROPOSAL_INERT: "proposal-inert",
  ACTIVATION_ORPHAN: "activation-orphan",
  ACTIVATION_ITEM_MISMATCH: "activation-item-mismatch",
  ACTIVATION_STATUS_MISMATCH: "activation-status-mismatch",
  BASELINE_UNDER_LIVE: "baseline-under-live",
  RETIRED_NON_OWNER: "retired-non-owner",
  RETRACTION_PHANTOM: "retraction-phantom",
});

/** The kinds that mean the fold could not READ a line. */
const UNREADABLE_SKIP_KINDS = new Set([SKIP_KINDS.UNPARSEABLE, SKIP_KINDS.INVALID_RECORD]);
const KNOWN_SKIP_KINDS = new Set(Object.values(SKIP_KINDS));

/**
 * Partition a fold result's `skipped[]` by what each entry MEANS. The one classifier every
 * consumer shares, so two readers cannot disagree about which skip is corruption.
 *
 *   unreadable          — a line the fold could not read. A projection over it is short.
 *   unclassified        — an entry with no known `kind`. FAIL CLOSED: treat as unreadable,
 *                         because a classifier that cannot name a skip must not call it benign.
 *   awaitingActivation  — an inert proposal no activation has countersigned yet.
 *   resolvedProposals   — an inert proposal a later activation DID countersign; its skip
 *                         entry is permanent history, not outstanding work.
 *   fenced              — a well-formed record a whole-log fence declined to fold.
 */
function partitionSkips(folded) {
  const skipped = (folded && Array.isArray(folded.skipped)) ? folded.skipped : [];
  const pending = new Set(
    ((folded && Array.isArray(folded.pendingProposals)) ? folded.pendingProposals : []).map((p) => p.record_id),
  );
  const out = { unreadable: [], unclassified: [], awaitingActivation: [], resolvedProposals: [], fenced: [] };
  for (const s of skipped) {
    const kind = s && s.kind;
    if (!KNOWN_SKIP_KINDS.has(kind)) out.unclassified.push(s);
    else if (UNREADABLE_SKIP_KINDS.has(kind)) out.unreadable.push(s);
    else if (kind === SKIP_KINDS.PROPOSAL_INERT) {
      (pending.has(s.record_id) ? out.awaitingActivation : out.resolvedProposals).push(s);
    } else out.fenced.push(s);
  }
  return out;
}

/**
 * The ONE walker both folds share: parse, validate, apply the C5 weight fence,
 * and hand each surviving event to `mapRow`. Extracted so `foldEvents` and
 * `foldProjection` cannot drift on WHICH EVENT WINS — only on which cells they
 * read off the winner.
 */
function _walk(text, mapRow) {
  const rows = new Map();
  const weights = new Map(); // item_id → the weight that last WON, for the C5 fence
  const wonAt = new Map(); // item_id → the ordinal of the event currently winning
  const skipped = [];
  const superseded = [];
  // ── RETIRE-IN-PLACE (component 11) ───────────────────────────────────────
  // The item_ids whose WINNING event is a retraction. It is a projection OF the
  // rows, never a subtraction FROM them: `rows` is set for a retraction exactly as
  // for any other event, so the folded POPULATION is unchanged and the
  // `tracker.min_rows` log-integrity floor keeps the monotonicity premise it rests
  // on. See the header for why teaching that floor to subtract instead would have
  // put its own exculpatory evidence inside the file an attacker truncates.
  //
  // A later transition UN-RETIRES, because the fold is last-wins and a retirement is
  // a status, not a tombstone. Tracked by delete rather than by "once retired,
  // always retired", so re-opening an item needs no new kind.
  const retiredIds = new Set();
  // ── THE COUNTERSIGNATURE (component 13) ──────────────────────────────────
  // `proposalById` is the record-id index an `activation` resolves `activates`
  // against. Built AS THE WALK GOES, which is sound because the log is append-only:
  // a proposal is always EARLIER in file order than any activation of it, so a
  // forward reference is not a thing the substrate can express. `activatedIds` is
  // what makes "pending" answerable without a second pass.
  const proposalById = new Map();
  const activatedIds = new Set();
  const proposals = [];
  // Register membership — see the `registerIds` note on this function's return.
  const registerIds = new Set();
  let considered = 0;
  const lines = String(text == null ? "" : text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const ordinal = i + 1;
    if (!raw.trim()) continue;
    let e;
    try {
      e = JSON.parse(raw);
    } catch (err) {
      skipped.push({
        line: ordinal,
        kind: SKIP_KINDS.UNPARSEABLE,
        why: `unparseable JSON: ${(err && err.message) || String(err)}`,
      });
      continue;
    }
    // `validateRecord`, NOT `validateEvent`: this walker's input is the FILE, so every
    // line it sees is an ON-DISK RECORD and must carry the envelope the append path
    // stamps. Validating only the caller half here is how 534 records reached disk with
    // no declared signature suite and no chain position.
    const v = validateRecord(e);
    if (!v.ok) {
      skipped.push({ line: ordinal, kind: SKIP_KINDS.INVALID_RECORD, why: `${v.error}: ${v.reason}` });
      continue;
    }
    considered++;
    // Recorded BEFORE the C5 fence and the last-wins comparison below, because
    // membership is a fact about the LOG ("this item was genesised"), not about
    // which event currently wins. A genesis that is later superseded still put
    // the item in the register.
    if (e.kind === "genesis") registerIds.add(e.item_id);
    // ── A PROPOSAL IS NEVER FOLDED ─────────────────────────────────────────
    //
    // THIS is the inertness, and it is structural rather than promised: the branch
    // `continue`s before `rows.set`, before `weights.set`, before `wonAt.set`. A
    // proposal therefore sets no cell, holds no weight, wins nothing, and cannot
    // supersede the event that currently holds the item. The falsifying result is
    // nameable and does not occur: if the fold honoured one, `rows.get(item_id)`
    // would carry the proposed owner status with no owner record anywhere in the log.
    //
    // RECORDED IN `skipped[]`, not dropped — and the channel is not a borrowing. The
    // C5 weight fence and both retirement fences already put WELL-FORMED records
    // there with a reason, so `skipped[]` is already "considered, deliberately not
    // folded, and here is why"; a proposal is exactly that. It is also what keeps the
    // READ GATE's two arithmetic cross-checks intact with no change to
    // `burndown-build.mjs`: `considered` counts this line and `skipped` counts it, so
    // `considered − rows.size − (skipped − malformed)` is unmoved, and the line still
    // parses and validates so it never lands in `malformed`.
    if (e.kind === "proposal") {
      proposalById.set(e.id, e);
      proposals.push({
        record_id: e.id,
        item_id: e.item_id,
        line: ordinal,
        proposed_status: e.proposed_status,
        reason: e.reason,
      });
      skipped.push({
        line: ordinal,
        kind: SKIP_KINDS.PROPOSAL_INERT,
        item_id: e.item_id,
        record_id: e.id,
        why: `proposal '${safeId(e.id)}' for '${e.item_id}' is INERT: it PROPOSES owner status ` +
          `'${e.proposed_status}' and changes nothing. It folds only once an 'activation' event ` +
          `countersigns that record id under owner authority.`,
      });
      continue;
    }
    // ── AN ACTIVATION HONOURS A PROPOSAL, OR IT HONOURS NOTHING ────────────
    //
    // Three whole-log facts `validateEvent` structurally cannot see from one line, so
    // they live here on the C5 precedent. Each one closes a way the countersignature
    // could be made to say something the owner did not countersign:
    //
    //   (a) the named proposal must EXIST — otherwise an activation is just an owner
    //       transition wearing a ceremony that never happened, and a reviewer reading
    //       the log would count a countersignature with no counterparty;
    //   (b) it must name the SAME item — otherwise an owner reads a proposal about
    //       one item and signs a status onto another;
    //   (c) the status must be the one PROPOSED — otherwise the ceremony authorises
    //       `In progress` and lands `Signed off`.
    //
    // Fenced OUT of the fold rather than refused at the producer, exactly as the
    // retraction-needs-an-existing-row fence is, and recorded in `skipped[]` with the
    // same visibility.
    if (e.kind === "activation") {
      const p = proposalById.get(e.activates);
      if (!p) {
        skipped.push({
          line: ordinal,
          kind: SKIP_KINDS.ACTIVATION_ORPHAN,
          item_id: e.item_id,
          record_id: e.id,
          activates: e.activates,
          why: `activation for '${e.item_id}' ignored: it names proposal '${safeId(e.activates)}', and ` +
            `no proposal with that record id appears earlier in this log. A countersignature with no ` +
            `counterparty adjudicates nothing.`,
        });
        continue;
      }
      if (p.item_id !== e.item_id) {
        skipped.push({
          line: ordinal,
          kind: SKIP_KINDS.ACTIVATION_ITEM_MISMATCH,
          item_id: e.item_id,
          record_id: e.id,
          activates: e.activates,
          why: `activation ignored: proposal '${safeId(e.activates)}' is for item '${p.item_id}' but ` +
            `this activation names '${e.item_id}'. An owner countersigns the item they read.`,
        });
        continue;
      }
      if (statusKey(p.proposed_status) !== statusKey(e.status)) {
        skipped.push({
          line: ordinal,
          kind: SKIP_KINDS.ACTIVATION_STATUS_MISMATCH,
          item_id: e.item_id,
          record_id: e.id,
          activates: e.activates,
          why: `activation for '${e.item_id}' ignored: proposal '${safeId(e.activates)}' proposes ` +
            `'${p.proposed_status}' but this activation carries '${e.status}'. An activation lands the ` +
            `status that was PROPOSED, never a different one.`,
        });
        continue;
      }
      activatedIds.add(e.activates);
    }
    // ── THE C5 FENCE, IN THE FOLD ──────────────────────────────────────────
    // A `migration_baseline` event NEVER overwrites a `live` one, whatever the
    // file order. Without this, re-running the genesis backfill after real work
    // would silently revert every item to its 2026-08-22 draft state and the fold
    // would report it as a clean projection.
    if (weights.get(e.item_id) === "live" && e.weight === "migration_baseline") {
      skipped.push({
        line: ordinal,
        kind: SKIP_KINDS.BASELINE_UNDER_LIVE,
        item_id: e.item_id,
        record_id: e.id,
        why: `genesis for '${e.item_id}' ignored: a live transition already holds this item and ` +
          `migration_baseline weight never overwrites live weight`,
      });
      continue;
    }
    // ── UN-RETIRING IS AN OWNER ADJUDICATION TOO ───────────────────────────
    //
    // The retraction fence in `validateEvent` is one-directional: it makes RETIRING
    // owner-only and said nothing about REVERSING it. Last-wins then let any
    // `authority: "agent"` transition for a retired item win and silently delete the
    // retirement — and `todo-tracker-guard.js` emits exactly that shape automatically
    // on every `PostToolUse:TodoWrite`, so a retired item reappearing in a todo list
    // reversed an owner ruling with nothing reporting it. That is the SAME laundering
    // channel the retraction fence exists to close, running the other way.
    //
    // So an event that would take an item OUT of retirement must itself carry owner
    // authority. Re-opening still needs no new kind — an OWNER transition does it —
    // and it stays VISIBLE: the retraction line shows up in `superseded[]` with both
    // ordinals, and the retired population drops by one.
    //
    // Fenced in the FOLD rather than at the producer, on the C5 precedent: whether an
    // item is currently retired is a fact about the WHOLE LOG, which `validateEvent`
    // (one line, no context) structurally cannot see.
    if (retiredIds.has(e.item_id) && e.authority !== "owner") {
      skipped.push({
        line: ordinal,
        kind: SKIP_KINDS.RETIRED_NON_OWNER,
        item_id: e.item_id,
        record_id: e.id,
        why: `'${e.item_id}' is RETIRED and this event declares authority '${e.authority}': un-retiring is ` +
          `an owner adjudication, exactly as retiring is, so a non-owner event never takes an item back ` +
          `out of retirement`,
      });
      continue;
    }
    // ── A RETRACTION RETIRES SOMETHING THAT EXISTS ─────────────────────────
    // Without this, a retraction naming an `item_id` no prior event ever won would
    // CREATE a row — already retired, never linked, and counted in both the ROW FLOOR
    // and the RETIRED denominator. It does not shrink the population, so the floor's
    // premise survives either way; what it does is inflate the board with a phantom
    // and make "3 of 267 retired" a statement about an item that never existed.
    // Recorded in `skipped[]` like every other fence, never dropped silently.
    if (e.kind === "retraction" && !rows.has(e.item_id)) {
      skipped.push({
        line: ordinal,
        kind: SKIP_KINDS.RETRACTION_PHANTOM,
        item_id: e.item_id,
        record_id: e.id,
        why: `retraction for '${e.item_id}' ignored: no earlier event in this log holds that item, so ` +
          `there is nothing to retire and folding it would CREATE an already-retired row`,
      });
      continue;
    }
    // ── SUPERSESSION IS RECORDED, NOT MERELY SURVIVED ──────────────────────
    // This fold is LAST-WINS where `parseLedger` REFUSED a duplicate row id
    // outright. Last-wins is CORRECT here — supersession IS the A4 status-promotion
    // channel — but silence about it is not. Under the table, redirecting an item was
    // an EDIT, so the diff showed the substitution and whoever adjudicated the diff
    // saw it. Under the log it is an APPEND: the diff shows one added line, the
    // superseded line is untouched and still reads correctly, and nothing tells the
    // reviewer which one the fold actually read.
    //
    // So each overwrite is recorded with BOTH ordinals and the id. A caller that
    // wants only the tally can take `.length`; a caller that must show a reviewer
    // WHICH line lost has the line numbers without re-walking the file. Deriving the
    // count arithmetically instead — `considered − rows.size − c5skips` — yields the
    // same number and no hits, which is the tally-in-place-of-the-hits shape
    // `instrument-discipline.md` MUST-3(b) names.
    if (rows.has(e.item_id)) {
      superseded.push({
        item_id: e.item_id,
        superseded_line: wonAt.get(e.item_id),
        superseded_by_line: ordinal,
      });
    }
    rows.set(e.item_id, mapRow(e, ordinal));
    weights.set(e.item_id, e.weight);
    wonAt.set(e.item_id, ordinal);
    if (e.kind === "retraction") retiredIds.add(e.item_id);
    else retiredIds.delete(e.item_id);
  }
  // `retired` is an ARRAY of ids, not a count. A tally sends a reviewer to grep the
  // log for which items it means (`instrument-discipline.md` MUST-3(b)); the ids ARE
  // the hits, and `.length` still gives the tally to a caller that only wants one.
  return {
    rows,
    skipped,
    superseded,
    considered,
    retired: [...retiredIds],
    // ── REGISTER MEMBERSHIP (loom s67, the S66-1 narrowing) ─────────────────
    // The item_ids that have EVER carried a `genesis` event. Like `retiredIds`
    // this is a projection OF the walk, never a subtraction FROM `rows`, so the
    // folded POPULATION and the `tracker.min_rows` floor are untouched.
    //
    // KEYED ON "EVER", NOT ON THE WINNING EVENT'S KIND, and that is the whole
    // point. The fold is last-wins, so a register item that later receives a
    // `transition` would have `kind: "transition"` on its winning event. A
    // narrowing keyed on the winner would evict that item from the projection
    // the moment real work touched it — a row vanishing with no diff, which is
    // the silent-narrowing failure this mechanism is forbidden to have. Once in
    // the register, always in the register.
    //
    // MEASURED at landing: 267 genesis item_ids, 100 transition item_ids, ZERO
    // overlap — so today the two keyings agree and this distinction changes
    // nothing. It is written for the first day they disagree.
    registerIds,
    // ── PENDING COUNTERSIGNATURES (component 13) ────────────────────────────
    // The HITS, never a tally (`instrument-discipline.md` MUST-3(b)): each row names
    // the record id an owner must activate, the item, the proposed status and the
    // line. `proposals` is EVERY proposal the log carries; `pendingProposals` is the
    // subset no activation has countersigned, which is the one a reader acts on.
    //
    // A proposal nobody can SEE is the failure this component exists to close, one
    // layer up: the owner's F91 decision went unrecorded because nothing surfaced it.
    // A proposal that folds to nothing AND reports nothing would reproduce that
    // exactly, so inertness is paired with visibility by construction.
    proposals,
    pendingProposals: proposals.filter((p) => !activatedIds.has(p.record_id)),
  };
}

module.exports = {
  SCHEMA,
  SCHEMA_V1,
  SCHEMA_V2,
  SCHEMAS,
  EVENTS_REL,
  KINDS,
  WEIGHT_FOR_KIND,
  AUTHORITIES,
  OWNER_STATUSES,
  TODO_STATUS_PREFIX,
  SEE_BURNDOWN,
  RETIRED_STATUS,
  // The countersigned transition (component 13). `AGENT_ACCEPTORS` is exported so the
  // fixtures can assert it against `check-archive-adjudication.mjs`'s copy rather than
  // trusting the mirror; `PROPOSAL_STATUS` so a consumer names the derived value from
  // one place instead of restating the literal. `isAgentAcceptor` is exported because
  // exporting the VOCABULARY alone was not enough: three sites held the same list and
  // still disagreed about what matching it meant, which is the drift this predicate
  // ends. A consumer asking "does this name an agent?" calls this — it does not
  // re-derive the answer from the array.
  AGENT_ACCEPTORS,
  isAgentAcceptor,
  PROPOSAL_STATUS,
  KINDS_WITH_REASON,
  REQUIRED_FIELDS_FOR_KIND,
  MAX_FIELD_CHARS,
  // The authority↔role binding (component 12). `ROSTER_REL` is exported so a consumer
  // reports the SAME path this module reads rather than restating it, and the resolver
  // is exported so the read gate applies the identical predicate the producer does.
  ROSTER_REL,
  ROSTER_ROLES,
  ROSTER_HOST_ROLES,
  ROLE_BOUND_AUTHORITIES,
  SIGNING_CONTEXT_FOR_AUTHORITY,
  readCommittedRoster,
  signerIndex,
  makeRosterSignerResolver,
  // The split trust surface. `TRUST_ROOT_REL` is exported so the generator and the
  // sync manifest name the same path from one place rather than three string literals.
  TRUST_ROOT_REL,
  ROSTER_REL,
  readCommittedTrustRoot,
  trustRootIndex,
  verifyAuthorityClaim,
  verifyAuthorityBindings,
  validateEvent,
  // The ON-DISK record validator: `validateEvent` plus the envelope the append path
  // stamps (`sig_alg` for a generation that declares one, `seq`/`prev_hash` for a
  // generation that chains). The fold uses THIS one.
  validateRecord,
  buildEvent,
  appendEvent,
  foldEvents,
  // The projection fold + its render-time authority fence. `foldEvents` keeps its
  // exact prior shape (the `parseLedger` claim it exists to prove); this is the
  // richer read the DERIVED tracker needs, off the SAME walk.
  foldProjection,
  projectStatus,
  SKIP_KINDS,
  partitionSkips,
  // EXPORTED for the projection narrowing's `exclude_statuses` comparison
  // (`session-notes-layout.js::_resolveProjectionNarrowing`). Its own header says it
  // is "shared rather than inlined so the four sites cannot drift"; a manifest-declared
  // status compared by raw equality would be a FIFTH site, and it would be the one
  // where drift is silent — `"awaiting human adjudication "` renders in a GFM cell
  // exactly as the unpadded form does, so a trailing space would quietly stop
  // excluding a row while the declaration still looked satisfied.
  statusKey,
};
