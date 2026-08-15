/**
 * journal-reserve — slot reservation for multi-operator journal numbering.
 *
 * Shard M6 D (workspaces/multi-operator-coc, design v11 §5.2).
 *
 * Single-writer artifact contention: under N concurrent operators,
 * `journal/NNNN-TYPE-slug.md` numbering silently collides — two operators
 * each scanning `ls journal/` reach the same next-number and clobber each
 * other on write. The structural fix moves the high-water-mark read from
 * the filesystem (race) to the fold-accepted coordination log (totally
 * ordered per-emitter chain): the slot reservation is a record-typed
 * append whose `seq` defines the slot, and the file name carries the
 * operator's `display_id` so two reservations on the same `seq` (e.g.,
 * during a partial-push window) remain distinguishable on disk.
 *
 * Contract:
 *   reserveJournalSlot(dir, opts) → {
 *     slot: NNNN,                      // 4-digit, zero-padded
 *     filename: "NNNN-<display_id>-TYPE-slug.md",
 *     verified_id: <emitter>,          // frontmatter authority field
 *     person_id: <emitter>,
 *     display_id: <emitter>,
 *     type: <UPPER>,
 *     topic: <slug>,
 *   }
 *
 * The returned slot is the high-water + 1 of the journal dir AT
 * RESERVATION TIME — the caller MUST not assume monotonicity across
 * concurrent reserves; under N concurrent ops the disk may receive
 * NNNN-alice-DECISION-foo.md AND NNNN-bob-DISCOVERY-bar.md with the
 * SAME NNNN, distinguishable by display_id. This is by design: the
 * fold rules + per-row owner: attribution (see §5.1) resolve collisions
 * at fold time; the filename is human-readable, not authoritative.
 *
 * The `verified_id` in the returned object is authoritative for the
 * frontmatter the caller writes — that field, not the filename, is
 * what attribution scans grep on.
 */

"use strict";

const fs = require("fs");
const path = require("path");

// FSUB (2026-06-11): signed-emission dependencies are lazy-required inside
// reserveJournalSlotSigned so the pure reserveJournalSlot path keeps its
// zero-dep cost for callers that only need the computation (tests, dry
// runs). The signed path is the one the /journal command mandates.

const VALID_TYPES = new Set([
  "DECISION",
  "DISCOVERY",
  "TRADE-OFF",
  "RISK",
  "CONNECTION",
  "GAP",
  "AMENDMENT",
]);

// Match the canonical journal command's filename regex: NNNN- (4 digits),
// then anything up to .md. We also support the new shape
// NNNN-<display_id>-TYPE-slug.md and tolerate the legacy NNNN-TYPE-slug.md.
// FOUR-OR-MORE digits, not exactly four. `padStart(4, "0")` PADS but never
// TRUNCATES, so slot 10000 renders "10000" — and an exactly-4 pattern does not
// match "10000-alice-DECISION-x.md" (index 4 is "0", not "-"), making every
// 5-digit journal file INVISIBLE to the disk high-water scan. Paired with the
// same widening in the fold's shape check, so the three width surfaces —
// this regex, that check, and `padStart` — agree. They did not: an exactly-4
// fold check plus an exactly-4 disk regex plus a non-truncating padStart put a
// hard ceiling at 9999 that BOTH high-water surfaces were blind to, so one
// record at slot 9999 (or simply a journal that legitimately reaches 9999)
// pinned every later reservation at 10000 forever.
const SLOT_RE = /^(\d{4,})-/;

function _slugify(s) {
  return (
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "untitled"
  );
}

function _scanHighWater(dir) {
  // Read the journal dir; the high-water is the max NNNN prefix observed.
  // Missing dir → 0 (no entries yet). Caller is responsible for creating
  // the dir before writing a new entry; this function does NOT create it.
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") return 0;
    throw err;
  }
  let high = 0;
  for (const name of entries) {
    const m = name.match(SLOT_RE);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n)) continue;
    if (n > high) high = n;
  }
  return high;
}

/**
 * Reserve the next journal slot.
 *
 * @param {string} dir - absolute path to the journal directory (the
 *   slot is computed from this directory's high-water).
 * @param {object} opts
 * @param {{verified_id:string, person_id:string, display_id:string}} opts.identity
 *   REQUIRED. The display_id is consumed in the filename; verified_id
 *   is what the caller will write to frontmatter as authoritative.
 * @param {string} opts.type - one of DECISION/DISCOVERY/TRADE-OFF/RISK/
 *   CONNECTION/GAP/AMENDMENT (the canonical journal TYPE set, per
 *   rules/journal.md Entry Types).
 * @param {string} opts.topic - human-readable topic; slugified.
 * @returns {{
 *   slot: string,            // "NNNN" zero-padded
 *   slot_num: number,        // integer slot
 *   filename: string,        // "NNNN-<display_id>-TYPE-slug.md"
 *   verified_id: string,
 *   person_id: string,
 *   display_id: string,
 *   type: string,
 *   topic: string,
 *   slug: string,
 * }}
 *
 * Throws on missing identity / bad type — same shape as
 * `zero-tolerance.md` Rule 3a typed-delegate-guard pattern.
 */
function reserveJournalSlot(dir, opts) {
  if (!dir || typeof dir !== "string") {
    throw new Error("reserveJournalSlot: dir must be a non-empty string");
  }
  const o = opts || {};
  const identity = o.identity;
  // `requireSigningIdentity` defaults TRUE — the signed path is unchanged.
  // Coordination-OFF repos pass FALSE: only `display_id` is load-bearing there,
  // because it is the ONLY identity field the reserved FILENAME embeds. The
  // roster-derived `person_id` and the key-derived `verified_id` exist to stamp
  // the SIGNED coordination record, which a coordination-off repo never emits
  // (`multi-operator-coordination.md`: opt-in, OFF by default — "a solo /
  // un-enrolled repo pays nothing"). Requiring them unconditionally made the
  // /codify journal gate UNSATISFIABLE on such a repo. See issue #76.
  const requireSigningIdentity = o.requireSigningIdentity !== false;
  const missingDisplay =
    !identity ||
    typeof identity.display_id !== "string" ||
    !identity.display_id;
  const missingSigningFields =
    !identity ||
    typeof identity.verified_id !== "string" ||
    !identity.verified_id ||
    typeof identity.person_id !== "string" ||
    !identity.person_id;
  if (missingDisplay || (requireSigningIdentity && missingSigningFields)) {
    throw new Error(
      requireSigningIdentity
        ? "reserveJournalSlot: opts.identity must carry non-empty verified_id, person_id, display_id"
        : "reserveJournalSlot: opts.identity must carry a non-empty display_id " +
            "(coordination disabled — verified_id/person_id not required)",
    );
  }
  if (typeof o.type !== "string" || !VALID_TYPES.has(o.type.toUpperCase())) {
    throw new Error(
      `reserveJournalSlot: opts.type must be one of ${Array.from(
        VALID_TYPES,
      ).join("/")}; got ${JSON.stringify(o.type)}`,
    );
  }
  if (typeof o.topic !== "string" || !o.topic.trim()) {
    throw new Error(
      "reserveJournalSlot: opts.topic must be a non-empty string",
    );
  }

  const high = _scanHighWater(dir);
  const slotNum = high + 1;
  const slot = String(slotNum).padStart(4, "0");
  const type = o.type.toUpperCase();
  const slug = _slugify(o.topic);
  // display_id is slugified separately so embedded spaces / punctuation
  // do not break the filename grep surface (TYPE token sits in a stable
  // position regardless of display_id shape).
  const displaySlug = _slugify(identity.display_id);
  const filename = `${slot}-${displaySlug}-${type}-${slug}.md`;

  return {
    slot,
    slot_num: slotNum,
    filename,
    verified_id: identity.verified_id,
    person_id: identity.person_id,
    display_id: identity.display_id,
    type,
    topic: o.topic,
    slug,
  };
}

/**
 * Scan the fold-accepted coordination log for journal-slot-reservation
 * records targeting `dirRel` and return the highest reserved slot number
 * (0 when none). This is the FOLD half of the high-water computation —
 * a sibling operator may have reserved a slot whose file has not landed
 * on this clone's disk yet (partial-push window), so the disk scan alone
 * under-counts. Per knowledge-convergence.md MUST-2 the fold-accepted
 * log is the authoritative ordering surface.
 *
 * Read errors REFUSE (throw) rather than silently returning 0 — a 0 on
 * an unreadable log would hand out an already-reserved slot. This covers
 * BOTH inputs the fold needs: the coordination log AND the roster it is
 * folded against (a null roster makes rule 1 reject every record, which
 * collapses the high-water to 0 by a different route — issue #84). In both
 * cases ENOENT alone means "legitimately absent" and returns/proceeds; any
 * other failure means "unknown" and refuses.
 */
function _foldHighWater(repoDir, dirRel) {
  const { resolveLogPath } = require("./state-io.js");
  const coordinationLog = require("./coordination-log.js");

  const logPath = resolveLogPath(repoDir);
  let raw;
  try {
    raw = fs.readFileSync(logPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return 0;
    throw err;
  }
  const records = raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((r) => r && typeof r === "object");
  if (records.length === 0) return 0;

  // The roster read REFUSES on failure, for the same reason the log read above
  // does — and it is the same failure, one read over (issue #84).
  //
  // A null roster is NOT inert. `coordination-log.js::_resolveRosterPerson`
  // returns null for it, so `_verifyRule1` rejects EVERY record with "signer
  // verified_id not in roster keys" — the roster-MEMBERSHIP gate is explicitly
  // RETAINED under `skipSignatureVerify`, which is the mode this function folds
  // in. `folded.accepted` is then empty and `high` is 0: the FOLD HALF OF THE
  // HIGH-WATER VANISHES and a slot a sibling operator already reserved is
  // handed out again. That is precisely the outcome the log read's own
  // docstring refuses for. The previous `catch { roster = null; }` swallowed
  // every read and parse error into that state silently.
  //
  // ENOENT is the ONE case that legitimately means "no roster": coordination is
  // OPT-IN and OFF BY DEFAULT (`multi-operator-coordination.md`), so a solo /
  // un-enrolled repo has no roster file and MUST still get a slot. It folds
  // with a null roster exactly as before. Every OTHER failure — unreadable,
  // unparseable, a directory, a permission error — is an UNKNOWN roster, not an
  // absent one, and refuses. `coordination-mode.js` already draws this same
  // line: an unparseable roster fails CLOSED there
  // (`implicit-corrupt-roster-failclosed`), so treating the same bytes as
  // absence here was inconsistent with the sibling predicate as well as with
  // the read directly above.
  //
  // `fs.existsSync` is deliberately gone: the ENOENT arm of the read covers it
  // without the check-then-use gap, and it matches the log read byte for byte.
  // RESOLVED FROM THE MAIN CHECKOUT, THE SAME TREE THE LOG IS READ FROM. The log
  // above goes through `resolveLogPath` -> `resolveStateDir` -> the main
  // checkout; this read was `path.join(repoDir, ...)`, i.e. the WORKTREE. That
  // asymmetry silently disabled the guard: the roster is a TRACKED file, so a
  // worktree on a branch that predates or omits it reads ENOENT, the presence
  // gate resolves false, and the guard is skipped — while the reservations it
  // exists to protect are read from main, where they do exist. A `git checkout`
  // of the wrong branch achieved what deleting the roster achieves, without
  // deleting anything.
  //
  // The two reads have to agree about WHICH REPOSITORY they describe, or the
  // guard answers a question about a different tree than the one whose slots it
  // is handing out. `resolveMainCheckout` is the same resolution the coordination
  // predicate already uses further down in this module.
  // `requireMainCheckout`, NOT the legacy `resolveMainCheckout` — and the
  // difference is the whole point of the paragraph above rather than a style
  // preference. The legacy accessor returns its own `startCwd` argument when git
  // cannot answer (`state-resolver.js` § INDETERMINATE), so the idiom this
  // replaced — `resolveMainCheckout(repoDir) || repoDir` — reads as defensive and
  // CANNOT fire: the `||` fallback is dead code, and the silent result is the
  // WORKTREE path, which is exactly the tree the paragraph above establishes we
  // must not read the roster from.
  //
  // REFUSING is the fail-closed direction here, and it is worth stating which way
  // that runs, because the two dispositions are not symmetric. Proceeding on an
  // unverified tree reaches the ENOENT arm below, and ENOENT is the ONE input this
  // function reads as "no roster, coordination is off, fold with null" — which
  // empties `folded.accepted`, drives `high` to 0, and hands out a slot a sibling
  // already reserved. So a fallback does not merely guess a path: it manufactures
  // the exact evidence of absence that collapses the high-water. An indeterminate
  // resolution is UNKNOWN, and this function already refuses on unknown — that is
  // what the coordination-log read directly above does, for this same reason.
  //
  // The throw is the established shape, not a new one: `reserveJournalSlotSigned`
  // catches it at `step: "fold-high-water"` and returns the typed
  // `{ok:false, reason}` result whose message already names BOTH inputs.
  const { requireMainCheckout } = require("./state-resolver.js");
  const mainRes = requireMainCheckout(repoDir);
  if (!mainRes.ok) {
    throw new Error(
      `main checkout unresolved, refusing to read the roster from an unverified tree: ${mainRes.reason}`,
    );
  }
  const rosterPath = path.join(
    mainRes.repoDir,
    ".claude",
    "operators.roster.json",
  );
  let roster = null;
  let rosterRaw;
  try {
    rosterRaw = fs.readFileSync(rosterPath, "utf8");
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
  }
  if (rosterRaw !== undefined) {
    try {
      roster = JSON.parse(rosterRaw);
    } catch (err) {
      // JSON.parse throws a SyntaxError carrying no path, and the caller
      // surfaces `err.message` verbatim — so name the file here or the refusal
      // is unactionable.
      throw new Error(
        `roster unparseable at ${rosterPath}: ${err && err.message ? err.message : String(err)}`,
      );
    }
    // PARSING CLEANLY IS NOT THE SAME AS RESOLVING ANYONE, and the difference is
    // the whole gap this closes. Distinguishing ENOENT from a read/parse failure
    // (above) closes the CORRUPT-BYTES route to the high-water collapse and
    // leaves the EMPTIED one open: `null`, `{}`, `{"persons":null}` and
    // `{"persons":{}}` all parse without throwing, and each then resolves NO
    // signer at `coordination-log.js::_resolveRosterPerson` — which makes
    // `_verifyRule1` reject EVERY record ("signer verified_id not in roster
    // keys"), empties `folded.accepted`, and drives `high` to 0. That is
    // byte-for-byte the state the old `catch { roster = null; }` produced.
    //
    // So the guard above, alone, failed LOUD on corruption and SILENT on
    // erasure — and erasure is both the cheaper act (write `{}`; no need to
    // craft invalid JSON) and the one this file's own threat model names
    // (`multi-operator-coordination.md`: a write-capable team member seeking
    // sabotage). A guard that only catches the noisy half is not a guard.
    //
    // "Parsed but resolves nobody" is UNKNOWN, not ABSENT. ABSENT is ENOENT,
    // which is legitimate because coordination is opt-in and a solo repo has no
    // roster; a roster file that EXISTS was written by someone, so an empty one
    // is a roster that lost its persons, not a repo that never had them. This
    // is the same disposition `coordination-mode.js` already takes for a corrupt
    // roster (`implicit-corrupt-roster-failclosed`) — the two modules disagreed
    // about exactly these bytes until now.
  }

  // skipSignatureVerify: the journal-slot HIGH-WATER needs only chain
  // STRUCTURE (which slots are taken), not crypto validity — same O(N)-gpg-
  // verify-per-emit fix as coc-emit.js::_defaultReadChainHead (see its NOTE
  // for the fail-closed proof: a forged-sig reservation at slot N is counted →
  // we advance PAST it, never reuse N). Read-time folds (journal-write-guard)
  // still verify. Without this, reserveJournalSlotSigned re-verified the whole
  // chain (~710ms/record × N) on every reservation — the second half of the
  // signing hang (the first was the chain-head read in coc-emit).
  const folded = coordinationLog.foldLog(records, roster, {
    skipSignatureVerify: true,
  });
  const accepted =
    process.env.COC_TEST_SKIP_SIGN === "1"
      ? records
      : (folded && folded.accepted) || [];

  // A RESERVATION RECORD REJECTED FOR ROSTER MEMBERSHIP IS LOST HIGH-WATER, and
  // this asks that question DIRECTLY rather than through a proxy for it.
  //
  // The first cut of this guard asked "does the roster name ANYBODY"
  // (`Object.keys(roster.persons).length > 0`). That is a different question
  // from the one the fold actually answers: `_resolveRosterPerson` resolves
  // PER-RECORD, keyed on THAT record's `verified_id`, so a roster naming alice
  // and bob with BOB'S ENTRY DELETED still passes a non-empty check while every
  // record bob emitted fails rule 1, drops out of `accepted`, and stops
  // contributing to `high` — the same collapse, scoped to one emitter, reached
  // by an edit CHEAPER and QUIETER than the `{}` erasure the proxy did catch.
  // (`clean-instantiate.mjs::placeholderRoster` ships a non-empty roster that
  // resolves no real signer, so "non-empty yet resolves nobody" is a state this
  // repo already produces, not a hypothetical.)
  //
  // It also OVER-fired: an empty roster on a coordination-OFF repo refused even
  // when no reservation record existed to lose, which re-opens issue #76's class
  // — the journal receipt `/codify` mandates becoming unsatisfiable — through a
  // new input. This check cannot: with no rule-1-rejected reservation record for
  // this dir, there is nothing to refuse about.
  //
  // Scoped to `journal-slot-reservation` records for THIS `dir` because those
  // are the only records whose loss can hand out a taken slot; a rule-1
  // rejection of some unrelated record type is not this function's business.
  // Skipped under COC_TEST_SKIP_SIGN=1 for the same reason `accepted` is: that
  // mode bypasses the fold entirely, so there are no rejections to read.
  // GATED ON A ROSTER BEING PRESENT, and that gate is load-bearing. With NO
  // roster file (the ENOENT arm above, which leaves `roster` null), rule 1
  // rejects every record for want of a roster to check against — but that is the
  // NORMAL state of a solo, un-enrolled, coordination-OFF repo, not evidence
  // that a reservation was lost. Refusing there would make `/codify`'s mandatory
  // journal receipt unsatisfiable on exactly those repos, which is issue #76's
  // failure class re-opened through a new input. A roster that EXISTS was
  // written by someone, so records it fails to resolve are records whose
  // reservations we can no longer see.
  // GATED ON THE FILE BEING PRESENT, NOT ON THE PARSED VALUE. The first cut
  // tested `roster !== null`, and `JSON.parse("null")` RETURNS null — so a
  // roster file containing the four bytes `null` parsed cleanly, produced the
  // same value as the absent-roster sentinel, and SKIPPED this guard entirely.
  // `null` is the first of the four erasure shapes the comment above enumerates
  // as covered, so the guard was defeated by the cheapest input it named. Worse,
  // the fixture case for it was VACUOUS: measured, `roster/null-roster-refuses`
  // stayed green with this whole block replaced by `if (false)`, because the
  // reservation was refused further downstream for an unrelated reason. A case
  // that passes with the guard deleted is not an instrument for the guard
  // (`instrument-discipline.md` MUST-2). `rosterRaw !== undefined` is the
  // presence question the surrounding prose always meant to ask.
  if (rosterRaw !== undefined && process.env.COC_TEST_SKIP_SIGN !== "1") {
    const rejected = (folded && folded.rejected) || [];
    const lost = rejected.filter((entry) => {
      // SCOPED TO ROSTER-CAUSED REJECTIONS (`rule-1`), and the previous
      // widening to ALL rules was a DENIAL-OF-SERVICE regression, measured.
      //
      // The widening's argument was true as far as it went — every rejection
      // rule drops the record and loses its slot. What it missed is that most of
      // those rules fire on ORDINARY, non-adversarial conditions, and the
      // refusal here is PERMANENT: the log is append-only, so no later record can
      // make a rejected one accepted, and the only escapes are hand-editing the
      // log (BLOCKED by `multi-operator-coordination.md` § MUST NOT) or deleting
      // the roster (the very bypass this guard exists to close).
      //
      // Measured: two ordinary reservations from one emitter — `seq` 0 then 1 —
      // fold to 1 accepted + 1 `rule-2` rejection ("prev_hash mismatch"), against
      // a VALID roster, because `_foldHighWater` does not supply
      // `perEmitterStateSeed`. Reservations are `checkpoint_exempt`, so exactly
      // this shape survives every compaction. Under the widened filter that
      // permanently denied `/codify`'s mandatory journal receipt on a healthy
      // repo — reopening issue #76's class, which the comment above claims this
      // check "cannot" do. It could.
      //
      // rule-3 (fork) and `shape` are the same story: two clones of one operator
      // merging, or a record predating a schema field, are availability events,
      // not roster events. They are real losses and they are NOT silently
      // ignored — they simply do not belong on a fail-CLOSED path whose only
      // remedy is the documented bypass. The roster question is the one this
      // guard can answer AND remediate (`git show HEAD:…roster.json`).
      //
      // BOTH POLARITIES ARE PINNED, because this file has now oscillated twice on
      // exactly this axis: `roster/targeted-erasure-…` reds if the rule scoping
      // is dropped back to nothing, and `roster/ordinary-chain-continuation-…`
      // reds if it is widened to every rule.
      // BOTH ROSTER-CAUSED RULES, and scoping to rule-1 alone missed the
      // cheaper attack. `rule-1` asks "does the roster resolve this signer's
      // fingerprint"; `rule-4` asks "does the record's `person_id` match the
      // person the roster resolved that fingerprint TO". Both answers are
      // DERIVED FROM THE ROSTER, so both are roster-caused losses.
      //
      // Measured: renaming a roster persons-map KEY from `alice` to
      // `alice.smith` while keeping the identical key entry and fingerprint
      // leaves rule-1 PASSING (the fingerprint still resolves) and reds rule-4
      // (`alice` != `alice.smith`). The record leaves `accepted`, the fold
      // high-water collapses, and the slot is re-issued — the exact outcome
      // `roster/targeted-erasure-…` locks, reached by an edit that is quieter
      // than the erasure: the roster still names the person, still names the
      // key, still resolves the fingerprint.
      //
      // rule-2 (chain), rule-3 (fork) and `shape` stay EXCLUDED — those are
      // availability events, not roster events, and including them permanently
      // denied the receipt on an ordinary repo (see the previous entry in this
      // file's history). rule-5 and presence-proof are roster-dependent but
      // structurally unreachable for a reservation record: rule-5 gates on
      // `type === "compaction-checkpoint"`, and presence-proof only fires on a
      // record carrying `content.presence_proof`, which a reservation has not.
      if (!entry || (entry.rule !== "rule-1" && entry.rule !== "rule-4")) {
        return false;
      }
      const rec = entry.record;
      if (!rec || rec.type !== "journal-slot-reservation") return false;
      return ((rec.content || {}).dir || null) === dirRel;
    });
    if (lost.length > 0) {
      const first = lost[0];
      throw new Error(
        // BRANCHES ON THE RULE, because the two are different failures and the
        // remedy differs. The first cut framed BOTH as "rejected at roster
        // membership … the roster does not resolve the signer(s)", which is
        // FALSE for rule-4: membership PASSED there and the signer WAS resolved
        // — the mismatch is the record's `person_id` against the person that
        // fingerprint resolved to. Worse, it pointed at `git show HEAD:…roster`,
        // which does not fix a legitimately re-keyed `person_id`. An operator
        // reading a true reason inside false framing is the failure mode this
        // module keeps recording about its own comments.
        `${lost.length} journal-slot reservation record(s) for "${dirRel}" were rejected by the fold ` +
          `(first: ${first.reason || first.rule || "unknown rule"}); ` +
          "refusing to hand out a possibly-reserved slot. " +
          (first.rule === "rule-4"
            ? `The roster at ${rosterPath} resolves the signer's key but binds it to a DIFFERENT person_id ` +
              "than the record claims — reconcile the persons-map key with the emitted records " +
              "(a persons-map key is declared immutable by the roster schema) before reserving."
            : `The roster at ${rosterPath} does not resolve the signer(s) that reserved them — ` +
              "restore it (e.g. `git show HEAD:.claude/operators.roster.json`) before reserving."),
      );
    }
  }

  let high = 0;
  for (const rec of accepted) {
    if (!rec || rec.type !== "journal-slot-reservation") continue;
    const c = rec.content || {};
    if (c.dir !== dirRel) continue;
    // SHAPE-VALIDATE THE SLOT BEFORE IT CAN RAISE THE HIGH-WATER. `parseInt`
    // accepts arbitrarily long digit strings, and `Number.isFinite` does NOT
    // reject them — 1e21 is finite. The fail-closed argument this function rests
    // on ("a forged reservation at slot N is counted, so we advance PAST N,
    // never reuse it") silently assumed N was in a sane range, and it is read
    // from a record folded with `skipSignatureVerify: true`, so the record need
    // not even be validly signed to be counted here.
    //
    // Unbounded, a single record with `slot: "999999999999999999999"` yields
    // n = 1e21; `String(1e21).padStart(4, "0")` is "1e+21", so the reservation,
    // the emitted record, and the resulting FILENAME all become `1e+21-…`. The
    // poisoning record is re-folded on every later call, so every subsequent
    // reservation for that dir returns the same garbage slot — permanently, for
    // every operator on the repo. That is a denial of the journal receipt
    // `/codify` mandates, from one append, which `multi-operator-coordination.md`
    // puts squarely inside the threat model ("a legitimate team member with repo
    // write access seeking … sabotage").
    //
    // BOUNDED, BUT NOT PINNED AT FOUR. The first cut of this check used
    // `/^[0-9]{1,4}$/`, which fixed the overflow and introduced a PERMANENT
    // CEILING: `padStart(4)` does not truncate, so slot 10000 renders "10000",
    // which this check then REJECTED — and the exactly-4 `SLOT_RE` did not match
    // its filename either. Both high-water surfaces went blind past 9999, so one
    // record at slot 9999 (or a journal that legitimately reaches 9999) pinned
    // every later reservation at 10000, forever, for every operator. That is the
    // same permanence as the 1e21 poison it replaced, with a smaller magnitude.
    //
    // Nine digits is far above any real journal and far below the precision
    // boundary where `String(n)` switches to exponent form (1e21), which is what
    // produced the "1e+21" filename. `Number.isSafeInteger` is retained because
    // the digit bound alone would still admit a value past 2^53 if the bound
    // were ever widened again.
    //
    // WHY THIS SKIPS SILENTLY WHILE THE ROSTER READ ABOVE REFUSES. The two
    // dispositions were compared deliberately when #84 landed, and the
    // asymmetry is load-bearing rather than an oversight:
    //
    //   - The roster failure is GLOBAL. One unreadable roster discards EVERY
    //     record, including well-formed ones naming slots a sibling really did
    //     reserve. Information about real reservations is lost, so proceeding
    //     hands out a taken slot. Refusing is the only safe disposition.
    //   - A malformed or out-of-range `content.slot` is LOCAL to one record,
    //     and that record names NO REAL SLOT — "999999999999999999999" and
    //     "0004junk" are not reservations anything can collide with. Skipping
    //     it loses no information about the reserved set, so the fail-safe
    //     direction here is to skip, not to refuse.
    //
    // Refusing on a bad shape would also be strictly WORSE than the poison it
    // replaced: one append of `slot: "9999999999"` would permanently deny every
    // reservation for every operator on the repo, which is the same permanent
    // denial the shape check exists to prevent, reached through the guard
    // instead of around it. Same threat model
    // (`multi-operator-coordination.md`: a write-capable team member seeking
    // sabotage), lower cost to the attacker.
    //
    // The honest residual: the skip is UNOBSERVABLE. A poisoning record is
    // dropped with no counter and no WARN, so an operator cannot tell a clean
    // log from one being probed. That is a real gap, and NOT closed here —
    // `_foldHighWater` has no logger surface and is consulted on a guard path
    // where throwing is BLOCKED (`zero-tolerance.md` Rule 3). Recorded rather
    // than silently accepted.
    if (typeof c.slot !== "string" && typeof c.slot !== "number") continue;
    if (!/^[0-9]{1,9}$/.test(String(c.slot))) continue;
    const n = parseInt(c.slot, 10);
    if (Number.isSafeInteger(n) && n > high) high = n;
  }
  return high;
}

/**
 * Reserve the next journal slot AND emit the signed
 * `journal-slot-reservation` coordination-log record that
 * journal-write-guard.js folds for its slot-reserved check.
 *
 * This is the FSUB wiring (knowledge-convergence.md MUST-2): the pure
 * reserveJournalSlot computes a slot from the filesystem only and emits
 * nothing, so every subsequent journal Write halt-and-reports "slot
 * unreserved in fold". This variant:
 *
 *   1. Computes slot = max(disk high-water, fold-accepted reservation
 *      high-water for the same dir) + 1 — the fold half covers the
 *      partial-push window where a sibling reserved a slot whose file
 *      has not landed on this clone yet.
 *   2. Emits the signed record {type: "journal-slot-reservation",
 *      content: {slot, dir, filename}} via coc-emit.js (per-emitter
 *      chained seq/prev_hash, canonical-bytes signature, 2KB-capped
 *      append).
 *
 * @param {string} repoDir - absolute MAIN-checkout repo root (callers
 *   inside worktrees resolve via state-resolver first — the log + the
 *   guard's fold both live at the main checkout).
 * @param {object} opts
 * @param {string} [opts.dir="journal"] - REPO-RELATIVE journal directory
 *   ("journal", "workspaces/<name>/journal", or the /.pending variant).
 *   MUST match the dir token journal-write-guard.js derives from the
 *   Write path, byte-for-byte — the guard's reservation match is
 *   content.dir === <derived dir>.
 * @param {{verified_id, person_id, display_id}} [opts.identity] -
 *   defaults to operator-id.js::resolveIdentity(repoDir).
 * @param {string} opts.type / opts.topic - as reserveJournalSlot.
 * @param {string} [opts.signingKeyPath] / {function} [opts.sign] /
 *   {function} [opts.readChainHead] / {function} [opts.append] -
 *   forwarded to coc-emit.js (test injection).
 * @returns {{ok: true, reservation: object, record: object} |
 *           {ok: false, error: string, reason: string, step: string,
 *            reservation?: object}}
 *   On emission failure the computed reservation is attached so the
 *   caller can surface BOTH the slot it would have taken AND why the
 *   reservation did not land (the guard will halt the Write either way).
 */
function reserveJournalSlotSigned(repoDir, opts) {
  if (!repoDir || typeof repoDir !== "string") {
    return {
      ok: false,
      error: "invalid argument",
      reason: "repoDir must be a non-empty string",
      step: "args",
    };
  }
  const o = opts || {};
  const dirRel =
    typeof o.dir === "string" && o.dir.trim() ? o.dir.trim() : "journal";

  // Resolve identity up front — the filename embeds display_id and the
  // emitter stamps verified_id/person_id.
  let identity = o.identity;
  if (!identity) {
    const { resolveIdentity } = require("./operator-id.js");
    identity = resolveIdentity(repoDir, {});
  }

  // Fold high-water FIRST (it can refuse); then compute the reservation
  // off max(disk, fold). reserveJournalSlot re-validates identity/type/
  // topic with its typed throws — convert to the typed-result shape.
  let foldHigh;
  try {
    foldHigh = _foldHighWater(repoDir, dirRel);
  } catch (err) {
    return {
      ok: false,
      error: "fold high-water read failed",
      // Names BOTH inputs: the throw can now come from the coordination-log
      // read OR the roster read (issue #84), and a reason naming only the log
      // would misdirect the reader at exactly the moment they need the path.
      // The underlying message carries which one.
      reason: `coordination log or roster unreadable; refusing to hand out a possibly-reserved slot: ${err && err.message ? err.message : String(err)}`,
      step: "fold-high-water",
    };
  }

  // Coordination is OPT-IN, OFF BY DEFAULT (`multi-operator-coordination.md`).
  // The sibling primitive `codify-lease.js` already gates record emission on
  // this exact predicate; this one did not, so two coordination primitives
  // invoked by the SAME /codify run disagreed about whether coordination was
  // required — the lease degraded cleanly while the journal gate hard-failed on
  // a null person_id, making /codify's mandatory journal receipt unsatisfiable
  // on every coordination-off repo. See issue #76.
  // Resolve the MAIN checkout for the predicate, exactly as `codify-lease.js`,
  // `integrity-guard.js`, `journal-write-guard.js` and `signing-mutation-guard.js`
  // all do. The tier-2 local override (`.claude/learning/coordination-mode.json`)
  // is GITIGNORED and therefore ABSENT inside a worktree, so reading it against a
  // worktree cwd would split a tier-2-enrolled repo OFF here while
  // `journal-write-guard.js` reads it ON from main — reserving no record, then
  // halting the Write for "slot unreserved". That is issue #76's own failure class
  // re-opened on the worktree path by the fix for #76; caught by the Tier-1 redteam.
  // Resolved through `requireMainCheckout` — the FAIL-CLOSED accessor — for the
  // same reason `_foldHighWater` uses it, and this site is the more consequential
  // of the two: the value below does not name a file, it GATES. The legacy
  // `resolveMainCheckout(repoDir) || repoDir` idiom silently yields the WORKTREE
  // when git cannot answer, and the paragraph above is precisely the record of
  // what a worktree-resolved coordination read does — the gitignored tier-2
  // override is ABSENT there, so a tier-2-enrolled repo reads OFF here while
  // `journal-write-guard.js` reads it ON from main. That is issue #76's class
  // reopened, and the `||` fallback cannot detect it: OFF is a legitimate answer
  // for a solo repo, so the wrong verdict is indistinguishable from the right one.
  //
  // WHICH WAY fail-closed runs here, since both directions are defensible until
  // the harm is named. Reading OFF when the repo is ON is SILENT: no signed record
  // is emitted, the slot never enters the shared log, and a sibling clone hands
  // out the same slot — the same high-water collapse `_foldHighWater` refuses for,
  // reached by a different route. Refusing is LOUD and self-describing, and it is
  // the disposition that AGREES with the guard downstream: `journal-write-guard.js`
  // is in the `MUST_BLOCK_ON_INDETERMINATE` set of
  // `tests/integration/multi-operator/trust-resolver-fail-closed-1471.test.js`, so
  // on this same unresolvable tree it BLOCKS the journal Write outright. Handing
  // back a reservation the guard is guaranteed to reject would be the substrate
  // disagreeing with itself.
  //
  // NOT over-blocking the opt-in case, stated rather than assumed: a coordination-
  // OFF solo repo is still a GIT repo, so it resolves DETERMINATELY and takes the
  // `coordination-disabled` early return below exactly as before. Only "git could
  // not identify a main checkout at all" refuses — the asymmetry
  // `requireMainCheckout` exists to preserve (`state-resolver.js` § NOTE).
  const { isCoordinationEnabled } = require("./coordination-mode.js");
  const { requireMainCheckout } = require("./state-resolver.js");
  const mainRes = requireMainCheckout(repoDir);
  if (!mainRes.ok) {
    return {
      ok: false,
      error: "main checkout unresolved",
      reason: `refusing to read the coordination verdict from an unverified tree; a worktree-resolved OFF is indistinguishable from a genuine one and silently skips the signed reservation: ${mainRes.reason}`,
      step: "coordination-mode",
    };
  }
  const coordinationOn = isCoordinationEnabled(mainRes.repoDir);

  const absDir = path.join(repoDir, dirRel);
  let reservation;
  try {
    reservation = reserveJournalSlot(absDir, {
      identity,
      type: o.type,
      topic: o.topic,
      requireSigningIdentity: coordinationOn,
    });
  } catch (err) {
    return {
      ok: false,
      error: "reservation invalid",
      reason: err && err.message ? err.message : String(err),
      step: "reserve",
    };
  }

  if (foldHigh >= reservation.slot_num) {
    // A fold-accepted reservation outranks the disk scan — rebuild the
    // reservation at fold-high + 1 (same identity/type/topic).
    const slotNum = foldHigh + 1;
    const slot = String(slotNum).padStart(4, "0");
    const displaySlug = _slugify(identity.display_id);
    reservation = Object.assign({}, reservation, {
      slot,
      slot_num: slotNum,
      filename: `${slot}-${displaySlug}-${reservation.type}-${reservation.slug}.md`,
    });
  }

  // Coordination OFF → the reservation is a LOCAL high-water slot; there is no
  // signed coordination record to emit and no sibling clone to inform. Mirrors
  // `codify-lease.js`'s `record_emit.reason: "coordination-disabled"` shape, so
  // both primitives now report the same way on the same repo.
  if (!coordinationOn) {
    return {
      ok: true,
      reservation,
      record: null,
      record_emit: { emitted: false, reason: "coordination-disabled" },
    };
  }

  const { emitSignedRecord } = require("./coc-emit.js");
  const emitOpts = {
    repoDir,
    type: "journal-slot-reservation",
    content: {
      slot: reservation.slot,
      dir: dirRel,
      filename: reservation.filename,
    },
    identity,
    signingKeyPath: o.signingKeyPath,
    keyType: o.keyType,
    sign: o.sign,
    readChainHead: o.readChainHead,
    append: o.append,
  };
  if (Object.prototype.hasOwnProperty.call(o, "gitConfigSigningKey")) {
    emitOpts.gitConfigSigningKey = o.gitConfigSigningKey;
  }
  const emitResult = emitSignedRecord(emitOpts);
  if (!emitResult.ok) {
    return {
      ok: false,
      error: emitResult.error,
      reason: emitResult.reason,
      step: `emit:${emitResult.step}`,
      reservation,
    };
  }

  return { ok: true, reservation, record: emitResult.record };
}

module.exports = {
  reserveJournalSlot,
  reserveJournalSlotSigned,
  VALID_TYPES,
};
