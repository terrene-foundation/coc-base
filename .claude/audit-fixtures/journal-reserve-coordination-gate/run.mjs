#!/usr/bin/env node
/**
 * journal-reserve-coordination-gate — the regression lock for issue #76 AND for
 * the failure its own fix re-opened one path over.
 *
 * WHAT IS UNDER TEST. `journal-reserve.js::reserveJournalSlotSigned` gates
 * `requireSigningIdentity` on
 *
 *     isCoordinationEnabled(resolveMainCheckout(repoDir) || repoDir)
 *
 * and BOTH halves of that expression are load-bearing:
 *
 *   - WITHOUT the gate at all (`requireSigningIdentity` hard-true): a
 *     coordination-OFF repo cannot satisfy /codify's mandatory journal receipt,
 *     because the sibling `codify-lease.js` degrades cleanly while this one
 *     hard-fails on a null person_id. That is issue #76.
 *   - WITHOUT `resolveMainCheckout` (reading the predicate against the worktree
 *     cwd): the tier-2 local override `.claude/learning/coordination-mode.json`
 *     is GITIGNORED and therefore ABSENT inside a worktree, so a tier-2-enrolled
 *     repo resolves OFF here while `journal-write-guard.js` reads it ON from
 *     main — no record reserved, then the Write halts for "slot unreserved".
 *     That is issue #76's own failure class, re-opened on the worktree path by
 *     the fix for #76. It was caught by a Tier-1 redteam and shipped with NO
 *     fixture; this file is that fixture.
 *
 * HOW IT DISCRIMINATES. Each case drives a REAL git repository (and, for the
 * worktree cases, a REAL `git worktree`) through the REAL module — no stubbed
 * resolver, no injected coordination verdict. The identity is injected because
 * `opts.identity` is a documented injection point, and it is the LEVER: an
 * identity carrying `display_id` but NO signing fields is accepted when the gate
 * resolves OFF and REFUSED when it resolves ON. So the same input yields
 * opposite results either side of the predicate, which is what makes a green
 * here evidence rather than decoration (`instrument-discipline.md` MUST-1).
 *
 * WHY THE CASES ASSERT `step`, NOT JUST `ok`. The first cut of this file
 * asserted only `r.ok === false` on the two coordination-ON cases, and it was
 * VACUOUS — measured, not suspected. Under the hard-`false` mutation the call
 * still returns `ok:false`, because the unsigned identity is caught further
 * downstream at the emitter (`step: "emit:identity"`) instead of at the gate
 * (`step: "reserve"`). Both are `ok:false`, so the assertion could not tell
 * "the gate fired" from "something else fired later" — a result consistent with
 * both branches of the hypothesis, i.e. no evidence at all
 * (`instrument-discipline.md` MUST-1). Pinning `step === "reserve"` is what
 * makes these cases discriminate. Left recorded because this fixture exists to
 * lock a gate, and a gate-lock that any downstream refusal satisfies is the
 * failure mode it was written to prevent, one layer up.
 *
 * Each case names the mutation that reds it (`instrument-discipline.md`
 * MUST-2(b)); the mutations are recorded as measured in README.md.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// The modules under test are CommonJS; this file is ESM (`.mjs`, matching the
// sibling upflow suite). `createRequire` is what lets the fixture drive the REAL
// CJS module rather than a re-implementation of it.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const LIB = path.join(REPO_ROOT, ".claude", "hooks", "lib");
// Slot values a hostile or malformed record can carry. `parseInt` accepts an
// arbitrarily long digit string and `Number.isFinite` does NOT reject the
// result — 1e21 is finite — so without a shape check the high-water is
// permanently poisoned and every later reservation returns a garbage slot.
const POISON_SLOTS = ["999999999999999999999", "1e5", "0004junk", " 12"];
const JOURNAL_RESERVE = path.join(LIB, "journal-reserve.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
}

/**
 * Build a real repo, optionally coordination-ON via the tier-2 local override,
 * and optionally add a real worktree. Returns the path the caller should treat
 * as `repoDir`.
 */
function makeRepo({ coordinationOn, withWorktree }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jrcg-"));
  const main = path.join(root, "main");
  fs.mkdirSync(main, { recursive: true });
  git(main, ["init", "-q", "-b", "main"]);
  fs.mkdirSync(path.join(main, "journal"), { recursive: true });
  fs.writeFileSync(path.join(main, "journal", ".keep"), "");
  fs.writeFileSync(path.join(main, "README.md"), "fixture\n");
  git(main, ["add", "-A"]);
  git(main, ["commit", "-q", "-m", "init"]);

  if (coordinationOn) {
    // Tier 2, the GITIGNORED local override — deliberately written ONLY at main
    // and never committed, which is exactly why a worktree-cwd read misses it.
    const learning = path.join(main, ".claude", "learning");
    fs.mkdirSync(learning, { recursive: true });
    fs.writeFileSync(
      path.join(learning, "coordination-mode.json"),
      JSON.stringify({ enabled: true }, null, 2),
    );
  }

  if (!withWorktree) return { root, repoDir: main };

  const wt = path.join(root, "wt");
  git(main, ["worktree", "add", "-q", "-b", "wtbranch", wt]);
  fs.mkdirSync(path.join(wt, "journal"), { recursive: true });
  return { root, repoDir: wt };
}

// An identity with a display_id but NO signing fields. This is the lever: it
// passes when the gate resolves OFF and is refused when it resolves ON.
const UNSIGNED_IDENTITY = { display_id: "fixture-op" };

/**
 * Write a `journal-slot-reservation` record into the coordination log the
 * high-water fold reads. `COC_TEST_SKIP_SIGN=1` makes the fold count RAW
 * records, which is the same posture the module already documents for that env
 * var — so the record does not need a valid signature to be counted. That is
 * not a shortcut for the fixture: `_foldHighWater` folds with
 * `skipSignatureVerify: true` on the normal path too, which is precisely why an
 * unvalidated `content.slot` is reachable.
 */
function writeSlotRecord(repoDir, slot, seq) {
  const { resolveLogPath } = require(path.join(LIB, "state-io.js"));
  const logPath = resolveLogPath(repoDir);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(
    logPath,
    JSON.stringify({
      type: "journal-slot-reservation",
      content: { dir: "journal", slot },
      // FULL ENVELOPE, NOT A BARE `{type, content}`. The first cut of this
      // helper emitted only those two fields, which `foldLog` rejects at the
      // SHAPE check ("verified_id missing") long before roster membership is
      // ever consulted. That made every roster case unable to exercise the
      // property it claimed to test: the records never reached rule 1, so an
      // emptied roster and a valid one produced the SAME fold outcome (nothing
      // accepted), and the cases passed only because the guard under test at
      // the time refused on the roster's shape rather than on the fold's
      // verdict. A record that cannot reach the check is not an instrument for
      // it. Measured shape requirements, in rejection order: verified_id,
      // person_id, then a non-negative integer seq.
      verified_id: SIGNED_IDENTITY.verified_id,
      person_id: SIGNED_IDENTITY.person_id,
      ts: "2026-08-04T00:00:00Z",
      seq: typeof seq === "number" ? seq : 0,
      prev_hash: null,
      sig: "fixture-signature",
    }) + "\n",
    "utf8",
  );
}

// A FULL signing identity plus a stubbed signer. Needed by the roster cases:
// coordination-mode.js fail-CLOSES a corrupt roster to ON
// (`implicit-corrupt-roster-failclosed`), so the unsigned lever would be refused
// by the coordination gate for an unrelated reason and mask what is under test.
// With signing satisfied, the ONLY thing that can refuse is the fold read.
const SIGNED_IDENTITY = {
  display_id: "fixture-op",
  person_id: "fixture-person",
  verified_id: "FIXTUREKEYFINGERPRINT",
};
const STUB_SIGN = () => ({ ok: true, sig: "fixture-signature" });

function reserve(repoDir, opts) {
  const o = opts || {};
  delete require.cache[require.resolve(JOURNAL_RESERVE)];
  const { reserveJournalSlotSigned } = require(JOURNAL_RESERVE);
  return reserveJournalSlotSigned(repoDir, {
    dir: "journal",
    type: "DECISION",
    topic: "fixture-topic",
    identity: o.identity || UNSIGNED_IDENTITY,
    // Emission is stubbed: this fixture is about the GATE, not the transport.
    // Injecting `append` also bypasses coc-emit's default fold-validation,
    // which is scoped to the default-append path.
    //
    // `null` = "no prior chain for this emitter", which coc-emit turns into
    // `seq: 0, prev_hash: null`. The earlier stub returned
    // `{ok:true, prev_hash:null, seq:0}` — a shape coc-emit does not read
    // (it wants `{lastSeq, lastContentHash}`), so `chainHead.lastSeq + 1` was
    // NaN and canonical-serialize refused. It went unnoticed because no case
    // in this file reached the emitter until the roster cases were added.
    readChainHead: () => null,
    append: () => ({ ok: true }),
    ...(o.sign ? { sign: o.sign } : {}),
  });
}

const cases = [
  {
    // COORDINATION ON, read from MAIN. The unsigned identity must be REFUSED.
    // This is the case that reds if `requireSigningIdentity` is hard-wired to
    // `false`, or if the gate is dropped entirely.
    name: "coordination-on/main/unsigned-identity-refused",
    mutation:
      "journal-reserve.js — pass `requireSigningIdentity: false` (or drop the option) in the reserveJournalSlot call",
    setup: { coordinationOn: true, withWorktree: false },
    expect: (r) => r.ok === false && r.step === "reserve",
    describe:
      'ok === false AND step === "reserve" (the GATE refused, not a downstream step)',
  },
  {
    // THE REGRESSION LOCK, and the reason this file exists. cwd is a WORKTREE of
    // a coordination-ON main. The tier-2 override is gitignored and absent here,
    // so a predicate read against the worktree resolves OFF and would ACCEPT the
    // unsigned identity. Reading it against the resolved MAIN checkout resolves
    // ON and REFUSES. Reds the moment `resolveMainCheckout(repoDir) || repoDir`
    // is simplified back to `repoDir`.
    name: "coordination-on/worktree/resolves-main-not-worktree",
    mutation:
      "journal-reserve.js — replace `isCoordinationEnabled(resolveMainCheckout(repoDir) || repoDir)` with `isCoordinationEnabled(repoDir)`",
    setup: { coordinationOn: true, withWorktree: true },
    expect: (r) => r.ok === false && r.step === "reserve",
    describe:
      'ok === false AND step === "reserve" (ON verdict from main, refused AT the gate)',
  },
  {
    // THE OTHER POLARITY, and it is not optional: a refusal-only suite cannot
    // detect over-tightening. Coordination OFF must still ACCEPT the unsigned
    // identity, which is issue #76 itself — /codify's mandatory journal receipt
    // has to remain satisfiable on a coordination-off consumer. Reds if the gate
    // is hard-wired to `true`.
    name: "coordination-off/main/unsigned-identity-accepted",
    mutation:
      "journal-reserve.js — hard-wire `requireSigningIdentity: true` (reverting the #76 fix)",
    setup: { coordinationOn: false, withWorktree: false },
    expect: (r) => r.ok === true,
    describe: "ok === true (issue #76: coordination-off must stay satisfiable)",
  },
];

// ---------------------------------------------------------------------------
// Slot-shape validation in the high-water fold
// ---------------------------------------------------------------------------

cases.push({
  // THE INSTRUMENT FOR THE SLOT SHAPE CHECK. `_foldHighWater` folds with
  // `skipSignatureVerify: true` — stated and justified in the module — so a
  // record's `content.slot` is attacker-reachable without a valid signature,
  // and `multi-operator-coordination.md` puts a write-capable team member
  // squarely inside the threat model.
  //
  // Unbounded, `slot: "999999999999999999999"` yields n = 1e21, and
  // `String(1e21).padStart(4, "0")` is "1e+21" — so the reservation, the emitted
  // record, and the FILENAME all become `1e+21-…`. The poisoning record is
  // re-folded on every later call, so the damage is PERMANENT for every operator
  // on the repo: a denial of the journal receipt `/codify` mandates, from a
  // single append.
  //
  // Each poison value targets a different way the old check failed: an
  // overflowing digit run (finite, so `Number.isFinite` passed), exponent
  // notation, a digits-then-junk prefix `parseInt` happily truncates, and a
  // leading-space form.
  // WHAT THIS CASE DOES AND DOES NOT REACH — measured, and load-bearing.
  // It FORCES `COC_TEST_SKIP_SIGN=1`, and that is not a convenience: with the
  // default fold path this case stays GREEN EVEN UNDER ITS OWN MUTATION,
  // because the synthetic records a fixture can write are rejected by the fold's
  // OTHER rules (chain continuity / emitter registration) before they ever reach
  // the slot loop. A case that cannot red is not an instrument, so the env var
  // is set deterministically here rather than left to the caller — otherwise
  // this file would ship a green that means nothing on the default path.
  //
  // The honest consequence: this instruments the shape check against records the
  // fold ADMITS, and the population that can produce such a record on the
  // default path is a ROSTERED operator emitting a properly-chained record whose
  // `content.slot` is arbitrary — `content` is not validated by the fold. That
  // is exactly `multi-operator-coordination.md`'s stated adversary (a legitimate
  // team member with write access seeking sabotage), so the guard is not
  // theatre; but constructing that record needs real signing infrastructure this
  // fixture deliberately does not stand up. Stated rather than papered over.
  name: "slot-shape/poisoned-high-water-cannot-escape-4-digits",
  mutation:
    "journal-reserve.js::_foldHighWater — drop the `/^[0-9]{1,9}$/` shape check and restore `Number.isFinite(n)` (reds ONLY with COC_TEST_SKIP_SIGN=1, which this case sets)",
  setup: { coordinationOn: false, withWorktree: false },
  poison: POISON_SLOTS,
  forceSkipSign: true,
  // `{4,}` not `{4}`: the shape check is bounded, NOT pinned at four. Pinning it
  // here would red on the very widening that fixed the 9999 ceiling, i.e. the
  // assertion would defend the bug.
  expect: (r) =>
    r.ok === true && /^[0-9]{4,}$/.test(r.reservation && r.reservation.slot),
  describe:
    "ok === true AND the slot is a plain digit string (no 1e+21 filename)",
});

cases.push({
  // THE 9999 CEILING, which the FIRST cut of the shape check created while
  // fixing the overflow. `padStart(4)` pads but never truncates, so slot 10000
  // renders "10000" — which an exactly-4 fold check REJECTS and an exactly-4
  // `SLOT_RE` does not match on disk. Both high-water surfaces went blind past
  // 9999, so a single record at slot 9999 pinned every later reservation at
  // 10000 permanently, for every operator: the same permanence as the 1e21
  // poison it replaced, at a smaller magnitude. It also fires with no attacker
  // at all, the moment a journal legitimately reaches 9999 entries.
  //
  // Drives it directly: seed 9999 AND 10000. A width-blind implementation drops
  // the 10000 record, computes high=9999, and hands back 10000 — a slot already
  // taken. A width-agnostic one computes high=10000 and returns 10001.
  name: "slot-shape/high-water-does-not-collapse-past-9999",
  mutation:
    "journal-reserve.js — pin the fold check back to /^[0-9]{1,4}$/ (or SLOT_RE back to /^(\\d{4})-/)",
  setup: { coordinationOn: false, withWorktree: false },
  poison: ["9999", "10000"],
  forceSkipSign: true,
  expect: (r) =>
    r.ok === true && r.reservation && r.reservation.slot === "10001",
  describe: 'slot === "10001" (monotonic past 9999, not pinned at 10000)',
});

cases.push({
  // THE DISK half of the same ceiling, and a SEPARATE surface from the case
  // above: `_scanHighWater` reads filenames through `SLOT_RE`, and an exactly-4
  // pattern does not match "10000-…" because index 4 is "0", not "-". So a
  // 5-digit journal file already on disk is invisible to the scan and its slot
  // is handed out again.
  //
  // Needed because the fold-side case CANNOT reach this: with no numbered file
  // on disk, pinning SLOT_RE back to exactly-4 reds nothing there — an inert
  // mutation, not a vacuous test. Both width surfaces must be driven, or the
  // widening is only half instrumented.
  name: "slot-shape/disk-scan-sees-five-digit-journal-files",
  mutation:
    "journal-reserve.js — pin SLOT_RE back to /^(\\d{4})-/ (the disk scan then cannot see 5-digit files)",
  setup: { coordinationOn: false, withWorktree: false },
  journalFiles: ["10000-someone-DECISION-prior-entry.md"],
  expect: (r) =>
    r.ok === true && r.reservation && r.reservation.slot === "10001",
  describe:
    'slot === "10001" (the on-disk 10000 was seen, not skipped back to 0001)',
});

// ---------------------------------------------------------------------------
// Roster read in the high-water fold (issue #84)
// ---------------------------------------------------------------------------

cases.push({
  // THE INSTRUMENT FOR ISSUE #84. `_foldHighWater` read the roster inside a bare
  // `catch { roster = null; }`. A null roster is NOT inert: `coordination-log.js
  // ::_resolveRosterPerson` returns null for it, `_verifyRule1` then rejects
  // every record with "signer verified_id not in roster keys" (the roster-
  // MEMBERSHIP gate is explicitly RETAINED under `skipSignatureVerify`), so
  // `folded.accepted` is empty and `high` is 0. The FOLD HALF OF THE HIGH-WATER
  // VANISHES, and a slot a sibling operator already reserved is handed out
  // again — the exact outcome the log read one line above REFUSES for, in its
  // own words: "a 0 on an unreadable log would hand out an already-reserved
  // slot."
  //
  // WHY THE FOLD PATH, NOT THE RAW PATH — a deliberate call, not a default.
  // `COC_TEST_SKIP_SIGN=1` sets `accepted = records`, which BYPASSES the fold
  // entirely, so under the raw path a null roster costs nothing: the high-water
  // survives. The damage this case locks exists ONLY on the fold path, so the
  // case runs there (no `forceSkipSign`). The slot-shape cases above force the
  // raw path for the opposite and equally deliberate reason — their subject is
  // the slot loop, which synthetic records cannot reach through a real fold.
  //
  // The log must be NON-EMPTY or the roster read is never reached: the
  // `records.length === 0` early return sits above it. One seeded record is
  // enough; it does not need to survive the fold, because the assertion is
  // about REFUSING vs PROCEEDING, not about the resulting number.
  //
  // WHY A SIGNED IDENTITY HERE. `coordination-mode.js` fail-CLOSES a corrupt
  // roster to ON (`implicit-corrupt-roster-failclosed`), so the unsigned lever
  // the coordination cases use would be refused at `step: "reserve"` for an
  // unrelated reason and mask what is under test. With signing satisfied and
  // emission stubbed, the fold read is the ONLY thing that can refuse — so the
  // measured pre-fix result is the DEFECT itself (`ok: true`, slot "0001":
  // a slot handed out over an unreadable roster), not an incidental refusal.
  // Worth stating: the coordination predicate ALREADY treats an unparseable
  // roster as a security-relevant condition and fails closed on it. The fold
  // read, one module over, treated the same bytes as absence.
  name: "roster/corrupt-roster-refuses-rather-than-restarting-high-water",
  mutation:
    "journal-reserve.js::_foldHighWater — restore the bare `catch { roster = null; }` around the roster read (issue #84)",
  setup: { coordinationOn: false, withWorktree: false },
  seedSlots: ["0007"],
  roster: "{ this is not json",
  identity: SIGNED_IDENTITY,
  sign: STUB_SIGN,
  expect: (r) => r.ok === false && r.step === "fold-high-water",
  describe:
    'ok === false AND step === "fold-high-water" (REFUSED at the fold read, not silently restarted from 0)',
});

cases.push({
  // THE ENOENT POLARITY, and it is not optional: a refusal-only pair cannot
  // distinguish the fix from a refuse-everything implementation. A repo that
  // legitimately has no roster (solo, un-enrolled — coordination is OFF BY
  // DEFAULT per `multi-operator-coordination.md`) MUST still get a slot. ENOENT
  // and unreadable are DIFFERENT cases and the fix turns on telling them apart.
  //
  // HONEST BOUND: this case is GREEN BEFORE the fix as well as after — the bare
  // catch also yielded `roster = null` and proceeded. It is therefore NOT an
  // instrument for the #84 fix; it is the over-tightening guard, and it reds
  // under the mutation named below. Stated rather than counted as fix evidence
  // (`instrument-discipline.md` MUST-2(a)).
  name: "roster/absent-roster-proceeds",
  mutation:
    'journal-reserve.js::_foldHighWater — drop the `err.code === "ENOENT"` arm and throw on every roster read failure',
  setup: { coordinationOn: false, withWorktree: false },
  seedSlots: ["0007"],
  expect: (r) => r.ok === true,
  describe:
    "ok === true (no roster is not a failure — coordination is OFF by default)",
});

cases.push({
  // THE THIRD POLARITY: a roster that reads, parses, AND RESOLVES A PERSON must
  // proceed. Distinguishes "refuses when the read fails" from "refuses whenever
  // a roster is present at all" — the ENOENT case cannot, because it never
  // exercises the read. Green before the #84 fix as well as after; named as the
  // over-tightening guard it is, not as fix evidence.
  //
  // THIS CASE PREVIOUSLY SEEDED `{persons: {}}` AND WAS ITSELF THE BUG BELOW.
  // An empty persons map resolves NO signer, which collapses the fold high-water
  // exactly as a null roster does — so the case was pinning the defeating shape
  // as CORRECT behavior. Seeding a roster with a real person is what makes this
  // a guard against over-tightening rather than a licence for the gap.
  name: "roster/valid-roster-proceeds",
  mutation:
    "journal-reserve.js::_foldHighWater — throw unconditionally after reading the roster (ignore the parse result)",
  setup: { coordinationOn: false, withWorktree: false },
  seedSlots: ["0007"],
  // KEYS ARE `{fingerprint}` OBJECTS, NOT BARE STRINGS. `_resolveRosterPerson`
  // matches on `k.fingerprint === verified_id`, so a string key resolves NOBODY
  // — the first cut of this case used `keys: ["FIXTUREKEY…"]` and was therefore
  // a roster that looked valid, read as valid, and resolved nothing. It passed
  // only while the guard under test asked about the roster's SHAPE; the moment
  // the guard began reading the fold's verdict it failed, correctly.
  roster: JSON.stringify({
    persons: {
      "fixture-person": {
        display_id: "fixture-op",
        keys: [{ fingerprint: "FIXTUREKEYFINGERPRINT" }],
      },
    },
  }),
  expect: (r) => r.ok === true,
  describe:
    "ok === true (a roster that reads, parses, and RESOLVES THE RESERVING SIGNER is not a refusal condition)",
});

for (const [label, body] of [
  ["null", "null"],
  ["empty-object", "{}"],
  ["null-persons", JSON.stringify({ persons: null })],
  ["empty-persons", JSON.stringify({ persons: {} })],
]) {
  cases.push({
    // THE #84 GUARD COVERED READ AND PARSE ONLY, AND THE SILENT PATH SURVIVED.
    // Distinguishing ENOENT from a read/parse failure closes the CORRUPT-BYTES
    // route to the collapse and leaves the EMPTIED one wide open: each body
    // below parses cleanly, so nothing throws, and each then resolves NO signer
    // at `coordination-log.js::_resolveRosterPerson` — which makes `_verifyRule1`
    // reject EVERY record ("signer verified_id not in roster keys"), empties
    // `folded.accepted`, and drives `high` to 0. That is byte-for-byte the state
    // the removed `catch { roster = null; }` produced: the fold half of the
    // high-water vanishes and a slot a sibling operator already reserved is
    // handed out again.
    //
    // The attacker-preferred route is the SILENT one, and it is the CHEAPER one
    // — writing `{}` is easier than corrupting bytes, and this sits squarely in
    // the threat model this file cites (a write-capable team member seeking
    // sabotage). A guard that fails loud on corruption and silent on erasure is
    // not a guard against erasure.
    //
    // "Parsed but resolves nobody" is UNKNOWN, not ABSENT, and refuses — the
    // same disposition `coordination-mode.js` already takes for a corrupt
    // roster (`implicit-corrupt-roster-failclosed`), which the two modules
    // otherwise disagreed about for these exact bytes.
    name: `roster/${label}-roster-refuses-rather-than-restarting-high-water`,
    mutation:
      "journal-reserve.js::_foldHighWater — accept any successfully-parsed roster (drop the resolves-a-person check), restoring the silent collapse",
    setup: { coordinationOn: false, withWorktree: false },
    seedSlots: ["0007"],
    roster: body,
    // ASSERTS THE STEP, NOT JUST `ok === false` — the lesson this suite's own
    // header already records for the coordination cases, which my roster cases
    // initially failed to apply. Measured: with the entire guard replaced by
    // `if (false)`, `roster/null-…` STAYED GREEN, because the reservation is
    // refused further downstream for an unrelated reason and both refusals are
    // `ok:false`. A case that passes with the guard deleted is not an instrument
    // for the guard (`instrument-discipline.md` MUST-1: the result was
    // consistent with both branches of the hypothesis). `step` is what
    // discriminates: the fold guard refuses at "fold-high-water".
    expect: (r) => r.ok === false && r.step === "fold-high-water",
    describe: `ok === false AND step === "fold-high-water" (a roster of \`${body}\` parses but resolves no signer, so the fold rejects the reservation records)`,
  });
}

cases.push({
  // TARGETED ERASURE — the shape a "does the roster name ANYBODY" check cannot
  // see, and the reason this guard reads the fold's verdict instead of the
  // roster's shape.
  //
  // The roster below is well-formed and NON-EMPTY: it names a person, with a
  // key. It simply does not name the person who RESERVED the seeded slot.
  // `_resolveRosterPerson` resolves PER-RECORD on that record's `verified_id`,
  // so every reservation from the erased signer fails rule 1, drops out of
  // `accepted`, and stops contributing to the high-water — the identical
  // collapse the empty-roster cases produce, scoped to one emitter.
  //
  // It is also the CHEAPER attack: deleting one person's entry from a roster
  // that still looks populated is quieter than truncating the file to `{}`,
  // and a shape-based guard reports green throughout. `clean-instantiate.mjs`
  // ships a non-empty placeholder roster that resolves no real signer, so
  // "non-empty yet resolves nobody" is a state this repo already produces.
  name: "roster/targeted-erasure-of-the-reserving-signer-refuses",
  mutation:
    "journal-reserve.js::_foldHighWater — replace the rule-1 rejection check with a roster-shape check (e.g. `Object.keys(roster.persons).length > 0`), which this roster passes",
  setup: { coordinationOn: false, withWorktree: false },
  seedSlots: ["0007"],
  roster: JSON.stringify({
    persons: {
      "someone-else": {
        display_id: "other-op",
        keys: [{ fingerprint: "SOMEOTHERKEYFINGERPRINT" }],
      },
    },
  }),
  expect: (r) => r.ok === false && r.step === "fold-high-water",
  describe:
    'ok === false AND step === "fold-high-water" (a populated roster that does not resolve the RESERVING signer loses that signer\'s slots)',
});

cases.push({
  // THE AVAILABILITY POLARITY, and its absence is why the over-widened filter
  // shipped. Two ordinary reservations from ONE emitter — seq 0 then seq 1 —
  // against a VALID roster that resolves the signer. This is a healthy repo.
  //
  // `_foldHighWater` folds without `perEmitterStateSeed`, so the second record
  // is `rule-2` rejected ("prev_hash mismatch"). That is an ORDINARY condition,
  // not an attack: reservations are `checkpoint_exempt`, so exactly this shape
  // survives every compaction and generation rotation.
  //
  // A filter that refuses on ANY rejection rule therefore PERMANENTLY denies
  // /codify's mandatory journal receipt on a healthy repo — the log is
  // append-only, so nothing can un-reject the record, and the only escapes are
  // hand-editing the log (BLOCKED) or deleting the roster (the bypass the guard
  // exists to close). Measured: the widened filter turned this case red.
  //
  // Paired deliberately with `roster/targeted-erasure-…`, which reds in the
  // OPPOSITE direction. The two together are what stop this axis oscillating:
  // one forbids under-scoping, the other forbids over-scoping, and no single
  // change can satisfy only one of them.
  name: "roster/ordinary-chain-continuation-does-not-deny-the-receipt",
  mutation:
    'journal-reserve.js::_foldHighWater — widen the rejection filter to ANY rule (drop `entry.rule !== "rule-1"`), so an ordinary rule-2 chain continuation denies the receipt',
  setup: { coordinationOn: false, withWorktree: false },
  seedSlots: ["0007", "0008"],
  roster: JSON.stringify({
    persons: {
      "fixture-person": {
        display_id: "fixture-op",
        keys: [{ fingerprint: "FIXTUREKEYFINGERPRINT" }],
      },
    },
  }),
  expect: (r) => r.ok === true,
  describe:
    "ok === true (an ordinary multi-record chain on a VALID roster must not deny the receipt)",
});

cases.push({
  // THE WORKTREE ASYMMETRY. `_foldHighWater` reads the LOG through
  // `resolveLogPath` -> `resolveStateDir` -> the MAIN checkout, but read the
  // ROSTER with a bare `path.join(repoDir, ...)`, i.e. the WORKTREE. The roster
  // is a TRACKED file, so a worktree on a branch that predates or omits it read
  // ENOENT, the presence gate resolved false, and the guard was SKIPPED — while
  // the reservations it protects were read from main, where they exist.
  //
  // That made a `git checkout` of the wrong branch equivalent to deleting the
  // roster, without deleting anything: the documented bypass, reachable by an
  // ordinary and entirely innocent action. Two reads that disagree about WHICH
  // TREE they describe cannot guard each other.
  //
  // Drives a worktree whose branch has no roster, with a degenerate `{}` roster
  // committed on main and a reservation record in the shared log. Correct
  // behavior is to refuse — main's roster governs.
  name: "roster/worktree-reads-the-main-checkout-roster-not-its-own",
  mutation:
    "journal-reserve.js::_foldHighWater — resolve the roster with `path.join(repoDir, ...)` again instead of `resolveMainCheckout(repoDir)`, so a worktree lacking the tracked roster silently skips the guard",
  setup: { coordinationOn: false, withWorktree: true },
  seedSlots: ["0007"],
  roster: "{}",
  rosterOnMain: true,
  expect: (r) => r.ok === false && r.step === "fold-high-water",
  describe:
    'ok === false AND step === "fold-high-water" (main\'s degenerate roster governs a worktree that has none of its own)',
});

cases.push({
  // THE SECOND ROSTER-CAUSED RULE, and the cheapest roster attack of the three.
  //
  // The roster below is well-formed, non-empty, names a person, carries a key,
  // and RESOLVES THE RESERVING FINGERPRINT — so rule-1 PASSES. Only the
  // persons-map KEY was renamed (`fixture-person` -> `fixture-person-RENAMED`),
  // which reds `rule-4`: the record claims `person_id: "fixture-person"` while
  // the roster resolves that fingerprint to `fixture-person-RENAMED`.
  //
  // Both questions are answered FROM THE ROSTER, so both are roster-caused
  // losses — but a filter scoped to rule-1 alone skipped this one, and the
  // reservation silently stopped raising the high-water. That is byte-for-byte
  // the outcome `roster/targeted-erasure-…` locks, reached by an edit QUIETER
  // than the erasure: nothing is deleted, nothing is emptied, every shape check
  // and every "does it resolve the signer" check still passes.
  //
  // This is the third distinct shape on this axis, after the four erasure shapes
  // and the availability case. The axis has now oscillated twice; the three
  // together bound it from every direction the fold can produce.
  name: "roster/persons-key-rename-loses-the-reservation-and-refuses",
  mutation:
    'journal-reserve.js::_foldHighWater — scope the rejection filter back to `entry.rule !== "rule-1"` alone, dropping the rule-4 arm',
  setup: { coordinationOn: false, withWorktree: false },
  seedSlots: ["0007"],
  roster: JSON.stringify({
    persons: {
      "fixture-person-RENAMED": {
        display_id: "fixture-op",
        keys: [{ fingerprint: "FIXTUREKEYFINGERPRINT" }],
      },
    },
  }),
  expect: (r) => r.ok === false && r.step === "fold-high-water",
  describe:
    'ok === false AND step === "fold-high-water" (a roster that resolves the FINGERPRINT but not the PERSON still loses the reservation)',
});

let failed = 0;
for (const c of cases) {
  let made = null;
  try {
    made = makeRepo(c.setup);
    // `roster` seeds the roster file `_foldHighWater` reads. Written verbatim, so
    // a case can seed unparseable bytes.
    //
    // `rosterOnMain` writes it to the MAIN checkout instead of `repoDir`, which
    // is the only way to express the worktree asymmetry: the roster is a TRACKED
    // file, so a worktree on a branch that omits it must still be governed by
    // main's copy — the same tree the coordination log is read from.
    if (c.roster !== undefined) {
      const rosterRoot = c.rosterOnMain
        ? path.join(made.root, "main")
        : made.repoDir;
      const rosterPath = path.join(
        rosterRoot,
        ".claude",
        "operators.roster.json",
      );
      fs.mkdirSync(path.dirname(rosterPath), { recursive: true });
      fs.writeFileSync(rosterPath, c.roster, "utf8");
    }
    // `journalFiles` drives the DISK high-water (`_scanHighWater` + `SLOT_RE`),
    // which is a SEPARATE width surface from the coordination-log fold. Without
    // a real numbered file on disk, pinning `SLOT_RE` back to exactly-4 reds
    // nothing — the scan never sees a 5-digit name, so the mutation is inert
    // rather than the test being vacuous. This is what makes it discriminate.
    if (c.journalFiles)
      for (const fname of c.journalFiles)
        fs.writeFileSync(path.join(made.repoDir, "journal", fname), "x\n");
    // `poison` seeds hostile/malformed slot values; `seedSlots` seeds ordinary
    // ones. Same writer — the distinction is what the case is asserting about,
    // not how the record is written.
    const logSlots = c.poison || c.seedSlots;
    // Sequential `seq` per record: the fold chains per emitter, and every record
    // here carries the same `verified_id`, so a constant seq would be rejected
    // on chain order rather than on the property under test.
    if (logSlots)
      logSlots.forEach((s, i) => writeSlotRecord(made.repoDir, s, i));
    const prevSkipSign = process.env.COC_TEST_SKIP_SIGN;
    if (c.forceSkipSign) process.env.COC_TEST_SKIP_SIGN = "1";
    let r;
    try {
      r = reserve(made.repoDir, { identity: c.identity, sign: c.sign });
    } finally {
      if (c.forceSkipSign) {
        if (prevSkipSign === undefined) delete process.env.COC_TEST_SKIP_SIGN;
        else process.env.COC_TEST_SKIP_SIGN = prevSkipSign;
      }
    }
    if (c.expect(r)) {
      // `PASS <name>` at column 0 is the shape run-audit-fixtures.mjs::CASE_PASS
      // counts (/^[ \t]*(?:PASS|ok)[ \t]+\S/). An indented `✓ <name>` is invisible
      // to it, so this runner reported 0 cases against its own min_cases floor of 17
      // while passing standalone.
      console.log(`PASS ${c.name}`);
    } else {
      failed += 1;
      console.log(`FAIL ${c.name}`);
      console.log(`      expected: ${c.describe}`);
      console.log(`      actual  : ${JSON.stringify(r).slice(0, 300)}`);
    }
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${c.name} — threw: ${err && err.message}`);
  } finally {
    if (made) fs.rmSync(made.root, { recursive: true, force: true });
  }
}

const total = cases.length;
if (failed) {
  console.log(`\njournal-reserve-coordination-gate: ${failed}/${total} FAILED`);
  process.exit(1);
}
console.log(`\njournal-reserve-coordination-gate: ${total}/${total} PASS`);
