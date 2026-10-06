#!/usr/bin/env node
/**
 * journal-write-guard — fixture runner (F51 residue; loom#2044 Group A).
 *
 * Six fixtures, six predicates, ONE guard: `.claude/hooks/journal-write-guard.js`.
 * FAMILY A (disposition) — driven through the shared `runDispositionSuite` in
 * ../hook-fixture-runner.mjs; only the staging is local.
 *
 * WHAT WAS UNEXECUTED. This directory held six `input.json` + `expected.txt`
 * pairs and no `run.mjs`, so it sat outside run-audit-fixtures.mjs's closure and
 * nothing compared the pinned dispositions against the hook.
 * `tests/integration/integrity-guards.test.js` DOES drive this guard and is
 * registered in ci-suites.json — this runner does not make the guard tested; it
 * makes THIS CORPUS executed.
 *
 * THE FIXTURES DECLARE A PREDICATE, NOT A WORLD. `03` and `04` carry a
 * `_setup_note` naming a SIGNED `journal-slot-reservation` record; SETUPS below
 * materializes exactly that — a real git repo, a real roster, real ssh keys, and
 * real `coc-sign` signatures, so the fold's rule-1 signature check is genuinely
 * satisfied. Tier 2 per `rules/testing.md`: no mocking. A fixture driven at the
 * wrong state fails for a HARNESS reason, and naming the setup per fixture is
 * what stops a future reader mistaking one for a guard defect.
 *
 *   node .claude/audit-fixtures/journal-write-guard/run.mjs
 *   HOOK=/abs/path/to/mutant.js node .../run.mjs     # red it against a mutant
 */
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import {
  makeReporter,
  mkKey,
  mkRepo,
  writeRoster,
  writeLog,
  logPathOf,
  signRecord,
  driveHook,
  ensureParent,
  cleanup,
  runDispositionSuite,
  GUARD_ENV_KEYS,
} from "../hook-fixture-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const HOOK = process.env.HOOK || path.join(REPO, ".claude/hooks/journal-write-guard.js");
const require_ = createRequire(import.meta.url);
const lib = (m) => require_(path.join(REPO, ".claude/hooks/lib", m));

const { check, finish } = makeReporter();

const FIXTURES = [
  "01-block-file-exists",
  "02-halt-slot-unreserved",
  "03-pass-self-reserved",
  "04-halt-sibling-reserved",
  "05-pass-outside-repo",
  "06-pass-non-write-tool",
];

const SETUPS = {
  "01-block-file-exists": {
    preexisting: "journal/0042-DECISION-existing.md",
    why: "the target journal entry EXISTS on disk. fs.existsSync is the only structural primitive in this guard and the only branch that ships severity:block; the file is materialized so the block is attributable to it.",
  },
  "02-halt-slot-unreserved": {
    why: "_setup: NO journal-slot-reservation record for (dir=journal, slot=0007) in the fold — a coordination log that IS readable and holds no covering reservation, which is what separates UNRESERVED from the INDETERMINATE branch one layer up.",
  },
  "03-pass-self-reserved": {
    reserve: { slot: "0012", dir: "journal", by: "self" },
    why: '_setup_note: "a signed journal-slot-reservation record with content.slot=0012, content.dir=journal, verified_id=<SELF_FINGERPRINT>". Signed with the SELF key so rule-1 accepts it and the self/sibling discriminator is the branch under test.',
  },
  "04-halt-sibling-reserved": {
    reserve: { slot: "0023", dir: "journal", by: "sibling" },
    why: '_setup_note: same record shape as 03 but verified_id=<SIBLING_FINGERPRINT>. Only the SIGNER moves, so a halt here is attributable to the self/sibling discriminator and not to the reservation lookup.',
  },
  "05-pass-outside-repo": {
    why: "no repo state required: /tmp/... is outside repoDir, so repoRelative returns null and the watched-PATH predicate passes it through before any registry read.",
  },
  "06-pass-non-write-tool": {
    why: "no repo state required: Read is not a mutation tool, so isWatchedTool refuses jurisdiction before any path or registry evaluation. Deliberately points at a journal path that WOULD be watched under Write.",
  },
};

const SELF = { person_id: "p-self", display_id: "self" };
const SIB = { person_id: "p-sibling", display_id: "sibling" };

const GENESIS = {
  repo_owner: "test-owner",
  repo_owner_kind: "user",
  root_commit: "deadbeef",
  genesis_generation: 1,
};

function personEntry(who, key, role, login) {
  return {
    display_id: who.display_id,
    role,
    github_login: login,
    host_role: "human",
    keys: [{ type: "ssh", fingerprint: key.fingerprint, pubkey: key.pubKey }],
  };
}

/** A real repo + roster + keys for both operators. */
function makeWorld(label) {
  const repoDir = mkRepo(label);
  const selfKey = mkKey(`${label}-self`);
  const sibKey = mkKey(`${label}-sib`);
  writeRoster(repoDir, {
    genesis: GENESIS,
    persons: {
      [SELF.person_id]: personEntry(SELF, selfKey, "owner", "self-login"),
      [SIB.person_id]: personEntry(SIB, sibKey, "contributor", "sib-login"),
    },
  });
  writeLog(repoDir, []);
  return { repoDir, selfKey, sibKey };
}

/**
 * An ENROLLED-SOLO repo: genesis anchored, ONE human bound, and NO force-ON
 * override — so `coordinationMode` resolves `implicit-solo-single-operator`
 * (loom#1890's solo floor) while `governanceMode` resolves `enrolled-solo`. This
 * is canon loom's own shape, and the one mode the 2026-09-12 re-key moves.
 */
function makeSoloWorld(label) {
  const repoDir = mkRepo(label, { coordinationForceOn: false });
  const selfKey = mkKey(`${label}-self`);
  writeRoster(repoDir, {
    genesis: GENESIS,
    persons: { [SELF.person_id]: personEntry(SELF, selfKey, "owner", "self-login") },
  });
  writeLog(repoDir, []);
  return { repoDir, selfKey };
}

/** The verdicts a world ACTUALLY resolves — the reach proof for a mode row. */
function modeOf(repoDir) {
  const cm = lib("coordination-mode.js");
  cm._resetCache();
  return {
    coordination: cm.coordinationMode(repoDir).source,
    governance: cm.governanceMode(repoDir).source,
  };
}

function reservationRecord(w, { slot, dir, by }) {
  const who = by === "self" ? SELF : SIB;
  const key = by === "self" ? w.selfKey : w.sibKey;
  return signRecord(
    REPO,
    {
      type: "journal-slot-reservation",
      verified_id: key.fingerprint,
      person_id: who.person_id,
      display_id: who.display_id,
      seq: 0,
      prev_hash: null,
      ts: new Date().toISOString(),
      content: { slot, dir },
    },
    key.keyPath,
  );
}

function payloadFor(c, repoDir) {
  const p = {
    session_id: "journal-write-guard-audit-fixtures",
    hook_event_name: c.input.hook_event_name,
    tool_name: c.input.tool_name,
    tool_input: {},
    cwd: repoDir,
  };
  for (const [k, v] of Object.entries(c.input.tool_input || {})) {
    p.tool_input[k] = typeof v === "string" ? v.replace(/<repo>/g, repoDir) : v;
  }
  return p;
}

function envFor(w) {
  return { COC_OPERATOR_KEY_PATH: w.selfKey.keyPath };
}

function stage(name, setup, c) {
  const w = makeWorld(name.slice(0, 2));
  if (setup.preexisting) {
    const p = path.join(w.repoDir, setup.preexisting);
    ensureParent(p);
    fs.writeFileSync(p, "# pre-existing entry\n");
  }
  if (setup.reserve) writeLog(w.repoDir, [reservationRecord(w, setup.reserve)]);
  const payload = payloadFor(c, w.repoDir);
  if (payload.tool_input.file_path) ensureParent(payload.tool_input.file_path);
  const cite =
    name === "01-block-file-exists"
      ? ["journal-write-guard", "0042"]
      : name === "02-halt-slot-unreserved"
        ? ["journal-write-guard", "0007", "UNRESERVED"]
        : name === "04-halt-sibling-reserved"
          ? ["journal-write-guard", "0023", SIB.display_id]
          : null;
  return { repoDir: w.repoDir, stdinRaw: JSON.stringify(payload), env: envFor(w), bodyMustCite: cite };
}

runDispositionSuite({ suiteDir: HERE, hook: HOOK, fixtures: FIXTURES, setups: SETUPS, stage }, check);

// ---- T4: PAIRED CONTROLS ------------------------------------------------------
//
// Every row above is consistent with a degenerate guard. One that refuses
// everything satisfies 01/02/04; one that passes everything satisfies 03/05/06.
// Neither shape is excluded by the fixture set alone. Each control flips EXACTLY
// ONE element and requires the disposition to MOVE.
console.log("\n=== T4: paired controls — flip one setup element, require the verdict to move ===");

function drive(w, payload) {
  return driveHook(HOOK, { stdinRaw: JSON.stringify(payload), cwd: w.repoDir, env: envFor(w) });
}

// A frontmatter block that SATISFIES the canonical shape contract, with
// `author: agent` so the author layer passes it too.
//
// Why it exists: every payload below used to carry a throwaway body ("body\n",
// "x\n") because no layer in this guard read content. The shape layer now does,
// and those throwaway bodies are journal-entry Writes that genuinely violate the
// contract — so a bare-body payload asserting "silent passthrough" had quietly
// become a compound assertion that BOTH layers are quiet, which is not what any
// of these cases is about. Prefixing this block restores each case to testing the
// ONE layer it names. The assertions are NOT relaxed: the advisory is still
// asserted wherever it is genuinely expected (see C13's control arms).
const SHAPE_CLEAN_FM = [
  "---",
  "type: DECISION",
  "date: 2026-09-15",
  "author: agent",
  "project: loom",
  "topic: fixture payload for the reservation layer",
  "phase: codify",
  "verified_id: SHA256:fixture-not-a-real-key",
  "person_id: pid-fixture-00000000",
  "display_id: fixture",
  "tags: []",
  "---",
  "",
].join("\n");

function writePayload(w, rel) {
  const p = path.join(w.repoDir, rel);
  ensureParent(p);
  return {
    session_id: "jwg-control",
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: p, content: SHAPE_CLEAN_FM + "body\n" },
    cwd: w.repoDir,
  };
}

const verdict = (r) => `exit=${r.code} tag=${r.tag}`;

{
  // C1 — 03's PASS is attributable to the RESERVATION's SIGNER. Both arms carry a
  // covering reservation for the same slot; only the key that signed it moves.
  const w = makeWorld("c1");
  const payload = writePayload(w, "journal/0012-DECISION-mine.md");
  writeLog(w.repoDir, [reservationRecord(w, { slot: "0012", dir: "journal", by: "self" })]);
  const mine = drive(w, payload);
  writeLog(w.repoDir, [reservationRecord(w, { slot: "0012", dir: "journal", by: "sibling" })]);
  const theirs = drive(w, payload);
  check(
    "C1: same slot with a covering reservation — signed by SELF ⇒ passthrough / by SIBLING ⇒ REFUSED",
    mine.code === 0 && mine.tag === "(none)" && theirs.refused === true,
    `self-signed: exit=${mine.code} tag=${mine.tag} | sibling-signed: exit=${theirs.code} tag=${theirs.tag}`,
    "identical dispositions = the reservation.verified_id === selfVerifiedId discriminator is dead. Passing on BOTH means one operator can write over a slot another operator reserved (the silent clobber MUST-NOT-3 exists to prevent); refusing on BOTH means an operator cannot write their OWN reserved slot.",
  );
}

{
  // C2 — 01's BLOCK is attributable to fs.existsSync, not to the slot being
  // unreserved. Both arms carry a SELF reservation for 0042; only the file moves.
  const w = makeWorld("c2");
  writeLog(w.repoDir, [reservationRecord(w, { slot: "0042", dir: "journal", by: "self" })]);
  const payload = writePayload(w, "journal/0042-DECISION-existing.md");
  const absent = drive(w, payload);
  fs.writeFileSync(payload.tool_input.file_path, "# already here\n");
  const present = drive(w, payload);
  check(
    "C2: reserved-by-self throughout — file ABSENT ⇒ passthrough / file PRESENT ⇒ BLOCK",
    absent.code === 0 && absent.tag === "(none)" && present.code === 2 && present.tag === "[BLOCK]",
    `absent: exit=${absent.code} tag=${absent.tag} | present: exit=${present.code} tag=${present.tag}`,
    "identical dispositions = the append-only fence is not keyed on file existence. A pass on the PRESENT arm overwrites a journal entry in place and destroys the audit trail rules/journal.md exists to keep; a block on the ABSENT arm makes writing any new entry impossible.",
  );
}

{
  // C3 — 06's PASS is attributable to the TOOL, not to the path. Same repo, same
  // unreserved journal target; only tool_name moves.
  const w = makeWorld("c3");
  const target = path.join(w.repoDir, "journal/0099-DECISION-anything.md");
  ensureParent(target);
  const base = { session_id: "jwg-c3", hook_event_name: "PreToolUse", cwd: w.repoDir };
  const read = drive(w, { ...base, tool_name: "Read", tool_input: { file_path: target } });
  const write = drive(w, { ...base, tool_name: "Write", tool_input: { file_path: target, content: SHAPE_CLEAN_FM + "x\n" } });
  check(
    "C3: same unreserved journal path — Read ⇒ passthrough / Write ⇒ REFUSED",
    read.code === 0 && read.tag === "(none)" && write.refused === true,
    `Read: exit=${read.code} tag=${read.tag} | Write: exit=${write.code} tag=${write.tag}`,
    "identical dispositions = isWatchedTool is not gating. Both refusing halts every Read of a journal entry; both passing removes the slot fence from the mutation tools it exists for.",
  );
}

{
  // C4 — 05's PASS is attributable to the PATH being outside the repo. Same Write,
  // same basename shape; only the directory crosses the repo boundary.
  const w = makeWorld("c4");
  const outside = drive(w, {
    session_id: "jwg-c4",
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/tmp/not-the-repo-journal-0001.md", content: "x\n" },
    cwd: w.repoDir,
  });
  const inside = drive(w, writePayload(w, "journal/0001-DECISION-inside.md"));
  check(
    "C4: same Write — /tmp/... ⇒ passthrough / <repo>/journal/... ⇒ REFUSED",
    outside.code === 0 && outside.tag === "(none)" && inside.refused === true,
    `outside: exit=${outside.code} tag=${outside.tag} | inside: exit=${inside.code} tag=${inside.tag}`,
    "identical dispositions = isWatchedPath is not scoping. Refusing on the OUTSIDE arm taxes every unrelated Write on the machine; passing on the INSIDE arm removes the slot fence from the repo it guards.",
  );
}

{
  // C5 — the mode gate is load-bearing AND correctly PLACED, on the protected
  // side. An UNENROLLED repo (no roster, no genesis ⇒ governance OFF) must stand
  // the registry branch down — reserve emits no record there, so demanding one
  // would make issue #76's journal receipt unsatisfiable — while the append-only
  // BLOCK, which is mode-INDEPENDENT, must still fire. This row predates the
  // 2026-09-12 re-key; its world resolves OFF under BOTH predicates, which is why
  // it did not move and why C6 exists.
  const repoDir = mkRepo("c5", { coordinationForceOn: false });
  const w = { repoDir, selfKey: mkKey("c5-self") };
  const mode = modeOf(repoDir);
  const unreserved = drive(w, writePayload(w, "journal/0007-DECISION-fresh-slot.md"));
  const existingPath = path.join(repoDir, "journal/0042-DECISION-existing.md");
  ensureParent(existingPath);
  fs.writeFileSync(existingPath, "# already here\n");
  const existing = drive(w, writePayload(w, "journal/0042-DECISION-existing.md"));
  check(
    "C5: UNENROLLED (governance OFF) — unreserved slot ⇒ SILENT passthrough / existing file ⇒ still BLOCK",
    mode.governance === "not-enrolled" &&
      unreserved.code === 0 &&
      unreserved.tag === "(none)" &&
      existing.code === 2 &&
      existing.tag === "[BLOCK]",
    `modes: ${mode.coordination}/${mode.governance} | unreserved: ${verdict(unreserved)} | existing: ${verdict(existing)}`,
    "a halt on the UNRESERVED arm = the gate stopped gating and an unenrolled repo, where reserve emits no record, can no longer write its journal receipt (issue #76); a pass on the EXISTING arm = the gate was placed ABOVE the append-only block and a solo repo can now silently overwrite its own journal history.",
  );
}

{
  // C6 — THE RE-KEY, bipolar on the ONE mode it moves: ENROLLED-SOLO. Coordination
  // resolves OFF (one human) and governance ON (a trust root exists). Keyed on
  // coordination, the registry branch stood down here and a hand-picked slot was
  // never checked — while the reservation primitive now emits its record on this
  // exact shape, so a sibling LANE's reservation is sitting in the fold unread.
  // Only the reservation record moves between the arms; the repo, roster, key,
  // path and payload are identical.
  const w = makeSoloWorld("c6");
  const mode = modeOf(w.repoDir);
  const payload = writePayload(w, "journal/0012-DECISION-solo.md");
  const unreserved = drive(w, payload);
  writeLog(w.repoDir, [reservationRecord(w, { slot: "0012", dir: "journal", by: "self" })]);
  const reserved = drive(w, payload);
  check(
    "C6: ENROLLED-SOLO (coordination OFF, governance ON) — unreserved ⇒ REFUSED UNRESERVED / self-reserved ⇒ passthrough",
    mode.coordination === "implicit-solo-single-operator" &&
      mode.governance === "enrolled-solo" &&
      unreserved.refused === true &&
      unreserved.combined.includes("UNRESERVED") &&
      reserved.code === 0 &&
      reserved.tag === "(none)",
    `modes: ${mode.coordination}/${mode.governance} | unreserved: ${verdict(unreserved)} | self-reserved: ${verdict(reserved)}`,
    "a pass on the UNRESERVED arm = the gate is keyed on coordination again, and an enrolled single-human repo writes unreserved slots its other lanes can collide with; a refusal on the RESERVED arm = the governance-only fold (skipSignatureVerify) is not admitting the reservation reserve allocated from, which is the deadlock the re-key must not introduce.",
  );
}

{
  // C7 — NO DEADLOCK, END TO END, through the REAL supply. C6 hand-signs its
  // record; this row obtains it the way `/journal new` does —
  // `journal-reserve.js::reserveJournalSlotSigned`, real key, real coc-sign, real
  // append, real emit-time fold validation — and then writes the filename that
  // call returned. The demand is satisfiable only if the supply is keyed on the
  // same predicate AND lands where this guard folds; a guard gated wider than the
  // reserve refuses the write reserve just authorized.
  //
  // CONTAINMENT: the in-process reserve inherits this runner's environment, so the
  // guard-steering keys are removed for its duration and the log path it would
  // append to is asserted to be THIS temp repo's before anything is emitted.
  const w = makeSoloWorld("c7");
  const saved = {};
  for (const k of GUARD_ENV_KEYS) {
    if (k in process.env) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  let r = null;
  let contained = false;
  let logTarget = null;
  try {
    lib("coordination-mode.js")._resetCache();
    logTarget = lib("state-io.js").resolveLogPath(w.repoDir);
    contained = logTarget === logPathOf(w.repoDir);
    if (contained) {
      const identity = lib("operator-id.js").resolveIdentity(w.repoDir, {
        signingKeyPath: w.selfKey.keyPath,
        keyType: "ssh",
      });
      r = lib("journal-reserve.js").reserveJournalSlotSigned(w.repoDir, {
        dir: "journal",
        type: "DECISION",
        topic: "c7 deadlock lock",
        identity,
        signingKeyPath: w.selfKey.keyPath,
        keyType: "ssh",
      });
    }
  } finally {
    Object.assign(process.env, saved);
  }
  const logged = fs
    .readFileSync(logPathOf(w.repoDir), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((x) => x.type === "journal-slot-reservation");
  const landed =
    !!(r && r.ok && r.record) &&
    logged.some((x) => x.content.slot === r.record.content.slot && x.sig === r.record.sig);
  const slot = r && r.reservation ? r.reservation.slot : "0001";
  const filename = r && r.reservation ? r.reservation.filename : "0001-missing.md";
  const reservedWrite = drive(w, writePayload(w, `journal/${filename}`));
  const next = String(Number(slot) + 1).padStart(4, "0");
  const unreservedWrite = drive(w, writePayload(w, `journal/${next}-self-DECISION-never-reserved.md`));
  check(
    "C7: ENROLLED-SOLO end to end — reserveJournalSlotSigned lands its record ⇒ writing THAT slot passes / the next, unreserved slot ⇒ REFUSED",
    contained &&
      landed &&
      reservedWrite.code === 0 &&
      reservedWrite.tag === "(none)" &&
      unreservedWrite.refused === true &&
      unreservedWrite.combined.includes("UNRESERVED"),
    `contained=${contained} (${logTarget}) | reserve: ok=${r && r.ok} slot=${slot} record=${!!(r && r.record)} step=${r && r.step} | log reservations=${logged.length} landed=${landed} | write ${filename}: ${verdict(reservedWrite)} | write ${next}: ${verdict(unreservedWrite)}`,
    "landed=false = the supply emitted no record on a governed repo, and every governed journal write halts; a refusal on the reserved write = supply and demand disagree about the key or the fold, the deadlock; a pass on the unreserved write = the demand is not armed here at all.",
  );
}

{
  // C8 — SIGNATURE VERIFICATION follows COORDINATION; the gate does not. One world,
  // one record, one payload; only the coordination verdict moves (the tier-2
  // override forces it ON for the second arm). The record names the SELF
  // fingerprint and person, but its `sig` was transplanted from a record over
  // DIFFERENT content, so it is a well-formed signature that does not verify.
  //
  //   coordination OFF ⇒ the fold keeps roster MEMBERSHIP and skips the signature
  //     subprocess — the acceptance set `journal-reserve.js::_foldHighWater`
  //     allocated this slot from — so the slot reads SELF-reserved: passthrough.
  //   coordination ON  ⇒ the fold verifies every signature, byte-unchanged from
  //     before the re-key, so the record is rejected: UNRESERVED.
  //
  // Why the OFF arm is not stricter: per-record signature verification is the
  // subprocess cost loom#1890 removed from single-human repos, and on a governed
  // repo this guard now runs on every new journal entry under a 5s hook budget.
  // A stricter fold there would be killed by that budget, not enforced.
  const w = makeSoloWorld("c8");
  const donor = reservationRecord(w, { slot: "9999", dir: "journal", by: "self" });
  const record = { ...reservationRecord(w, { slot: "0031", dir: "journal", by: "self" }), sig: donor.sig };
  writeLog(w.repoDir, [record]);
  const payload = writePayload(w, "journal/0031-DECISION-sig.md");
  const offMode = modeOf(w.repoDir);
  const off = drive(w, payload);
  fs.writeFileSync(path.join(w.repoDir, ".claude", "learning", "coordination-mode.json"), '{"enabled":true}\n');
  const onMode = modeOf(w.repoDir);
  const on = drive(w, payload);
  check(
    "C8: same record with a non-verifying sig — coordination OFF (governance ON) ⇒ membership-only fold, passthrough / coordination ON ⇒ signature-verified fold, REFUSED UNRESERVED",
    offMode.coordination === "implicit-solo-single-operator" &&
      offMode.governance === "enrolled-solo" &&
      onMode.coordination === "local-override" &&
      record.sig !== reservationRecord(w, { slot: "0031", dir: "journal", by: "self" }).sig &&
      off.code === 0 &&
      off.tag === "(none)" &&
      on.refused === true &&
      on.combined.includes("UNRESERVED"),
    `off modes: ${offMode.coordination}/${offMode.governance} → ${verdict(off)} | on modes: ${onMode.coordination}/${onMode.governance} → ${verdict(on)}`,
    "a refusal on the OFF arm = the governance-only fold verifies signatures, paying loom#1890's per-record subprocess on every governed journal write and disagreeing with the allocator's acceptance set; a pass on the ON arm = coordination-ON repos lost signature verification, i.e. a sibling can forge a reservation that reads as yours.",
  );
}

{
  // C9 — ACCEPTANCE IS A PROPERTY OF THE EMITTER'S WHOLE CHAIN, NOT OF THE
  // RESERVATION RECORD ALONE. C1–C8 each fold a one-record log at seq 0, so no row
  // above can tell the guard's full fold from a fold of reservation records only —
  // and that pre-filter was proposed as the fix for this guard's latency. Measured
  // 2026-09-12 on loom's real 935-record log it accepts 2 of 337 reservations: the
  // other 335 are rule-2 rejected, because `coordination-log.js::_checkRule2`
  // advances an emitter's chain only on ACCEPTED records of ANY type. A guard
  // reading that set would call nearly every real reservation UNRESERVED.
  //
  // One emitter, 2000 correctly chained records (placeholder signatures — this
  // world is enrolled-solo, so the fold runs with `skipSignatureVerify`, the
  // acceptance set `journal-reserve.js::_foldHighWater` allocates from), three
  // reservations mid-chain, one torn line, and one reservation appended OFF the
  // chain. The guard's three verdicts must equal the verdicts the full in-process
  // fold implies; the pre-filtered fold is computed alongside as the reach proof
  // that the 0120 arm is the one that discriminates it.
  const crypto = require_("crypto");
  const w = makeSoloWorld("c9");
  const mode = modeOf(w.repoDir);
  const { canonicalSerialize } = lib("coc-sign.js");
  const { createEngine } = lib("coordination-log.js");
  const N = 2000;
  const AT = { 400: "0040", 1200: "0120", 1900: "0190" };
  const FILLER = ["codify-lease", "codify-lease-release", "gate-op-receipt"];
  const records = [];
  const lines = [];
  let prev = null;
  for (let i = 0; i < N; i++) {
    const slot = AT[i];
    const core = {
      type: slot ? "journal-slot-reservation" : FILLER[i % FILLER.length],
      verified_id: w.selfKey.fingerprint,
      person_id: SELF.person_id,
      display_id: SELF.display_id,
      seq: i,
      prev_hash: prev,
      ts: new Date(Date.UTC(2026, 8, 1) + i).toISOString(),
      content: slot ? { slot, dir: "journal" } : { lease_id: `c9-${i}` },
    };
    prev = crypto.createHash("sha256").update(canonicalSerialize(core)).digest("hex");
    const rec = { ...core, sig: "c9-placeholder-signature" };
    records.push(rec);
    lines.push(JSON.stringify(rec));
    if (i === 1000) lines.push("{ torn line - not JSON");
  }
  const offChain = {
    type: "journal-slot-reservation",
    verified_id: w.selfKey.fingerprint,
    person_id: SELF.person_id,
    display_id: SELF.display_id,
    seq: N,
    prev_hash: "0".repeat(64),
    ts: new Date(Date.UTC(2026, 8, 2)).toISOString(),
    content: { slot: "0150", dir: "journal" },
    sig: "c9-placeholder-signature",
  };
  records.push(offChain);
  lines.push(JSON.stringify(offChain));
  fs.writeFileSync(logPathOf(w.repoDir), lines.join("\n") + "\n");

  const roster = JSON.parse(fs.readFileSync(path.join(w.repoDir, ".claude", "operators.roster.json"), "utf8"));
  const heldBy = (accepted, slot) =>
    accepted
      .filter((r) => r.type === "journal-slot-reservation" && r.content && r.content.dir === "journal" && r.content.slot === slot)
      .map((r) => r.verified_id);
  const t0 = Date.now();
  const full = createEngine().foldLog(records, roster, { skipSignatureVerify: true });
  const foldMs = Date.now() - t0;
  const pre = createEngine().foldLog(
    records.filter((r) => r.type === "journal-slot-reservation"),
    roster,
    { skipSignatureVerify: true },
  );
  const expectA = JSON.stringify(heldBy(full.accepted, "0120")) === JSON.stringify([w.selfKey.fingerprint]);
  const expectB = heldBy(full.accepted, "0121").length === 0;
  const expectC = heldBy(full.accepted, "0150").length === 0;
  const preBlind = heldBy(pre.accepted, "0120").length === 0;

  const tA = Date.now();
  const a = drive(w, writePayload(w, "journal/0120-self-DECISION-mid-chain.md"));
  const aMs = Date.now() - tA;
  const b = drive(w, writePayload(w, "journal/0121-self-DECISION-never-reserved.md"));
  const c = drive(w, writePayload(w, "journal/0150-self-DECISION-off-chain.md"));
  check(
    "C9: 2000-record chained log — mid-chain reservation ⇒ passthrough / never reserved ⇒ REFUSED UNRESERVED / off-chain reservation ⇒ REFUSED UNRESERVED, each equal to the full fold's verdict",
    mode.coordination === "implicit-solo-single-operator" &&
      mode.governance === "enrolled-solo" &&
      full.accepted.length === N &&
      full.rejected.length === 1 &&
      full.rejected[0].rule === "rule-2" &&
      expectA &&
      expectB &&
      expectC &&
      preBlind &&
      a.code === 0 &&
      a.tag === "(none)" &&
      b.refused === true &&
      b.combined.includes("UNRESERVED") &&
      c.refused === true &&
      c.combined.includes("UNRESERVED"),
    `modes: ${mode.coordination}/${mode.governance} | full fold: ${full.accepted.length} accepted, ${full.rejected.length} rejected (${full.rejected.map((e) => e.rule).join(",")}) in ${foldMs}ms | pre-filtered fold holds 0120: ${!preBlind} | 0120: ${verdict(a)} (${aMs}ms) | 0121: ${verdict(b)} | 0150: ${verdict(c)}`,
    "a refusal on 0120 = the guard no longer folds the emitter's whole chain (a record-type pre-filter, or any reading that drops the codify-lease / gate-op-receipt records a reservation chains through) and every real reservation reads UNRESERVED; a pass on 0150 = chain integrity is no longer consulted and a hand-appended off-chain record reserves a slot the allocator never counted; a pass on 0121 = the lookup is not keyed on the slot.",
  );
}

{
  // C10 — A CHECK THAT DID NOT FINISH IS NOT A PASS. The fallback timer used to
  // write a bare `{continue:true}`, byte-identical to "checked, and clean". The
  // tighten-only budget knob drives the not-completed arm deterministically: at 1ms
  // the reservation check's own deadline has passed before the log is read, on any
  // machine, at any load. Four arms; only the knob and the target move.
  const w = makeSoloWorld("c10");
  writeLog(w.repoDir, [reservationRecord(w, { slot: "0012", dir: "journal", by: "self" })]);
  const payload = writePayload(w, "journal/0012-DECISION-budget.md");
  const STARVE = { COC_JOURNAL_GUARD_BUDGET_MS: "1" };
  const driveWith = (world, p, extra) =>
    driveHook(HOOK, { stdinRaw: JSON.stringify(p), cwd: world.repoDir, env: { ...envFor(world), ...extra } });
  const completed = drive(w, payload);
  const starved = driveWith(w, payload, STARVE);
  const notesPath = path.join(w.repoDir, "notes", "c10.md");
  ensureParent(notesPath);
  const offJurisdiction = driveWith(
    w,
    {
      session_id: "jwg-c10",
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: notesPath, content: "x\n" },
      cwd: w.repoDir,
    },
    STARVE,
  );
  const u = { repoDir: mkRepo("c10u", { coordinationForceOn: false }), selfKey: mkKey("c10u-self") };
  const unenrolled = driveWith(u, writePayload(u, "journal/0007-DECISION-unenrolled.md"), STARVE);
  const ctx =
    starved.json &&
    starved.json.hookSpecificOutput &&
    typeof starved.json.hookSpecificOutput.additionalContext === "string"
      ? starved.json.hookSpecificOutput.additionalContext
      : "";
  check(
    "C10: self-reserved slot — default budget ⇒ passthrough / budget exhausted ⇒ HALT-AND-REPORT 'did not complete … slot unverified', never bare continue; the exhausted budget taxes neither a non-journal Write nor an unenrolled repo",
    completed.code === 0 &&
      completed.tag === "(none)" &&
      starved.code === 0 &&
      starved.tag === "[HALT-AND-REPORT]" &&
      !!starved.json &&
      starved.json.continue === true &&
      ctx.includes("did not complete within the hook budget") &&
      ctx.includes("slot unverified") &&
      ctx.includes("0012") &&
      !starved.combined.includes("UNRESERVED") &&
      offJurisdiction.code === 0 &&
      offJurisdiction.tag === "(none)" &&
      unenrolled.code === 0 &&
      unenrolled.tag === "(none)",
    `completed: ${verdict(completed)} | starved: ${verdict(starved)} json=${JSON.stringify(starved.json).slice(0, 90)} | notes/ under starve: ${verdict(offJurisdiction)} | unenrolled under starve: ${verdict(unenrolled)}`,
    "a bare {continue:true} or tag (none) on the STARVED arm = a check that never finished reads as a clean pass again; UNRESERVED there = an unfinished check is reported as a completed negative; a refusal on the COMPLETED arm = the budget trips on an ordinary check; a refusal on either off arm = the budget taxes writes the reservation check has no jurisdiction over.",
  );
}

{
  // C11 — A ROSTER THE FOLD CANNOT READ IS UNKNOWN, NOT UNRESERVED. Every arm
  // holds the IDENTICAL self-signed reservation for the slot being written, so a
  // pass is the only correct verdict on a healthy roster; only the ROSTER BYTES
  // move. Pre-fix the guard's `loadRoster` swallowed all three failures into
  // `null`, which resolves no signer, rejects every record at rule-1, empties
  // `accepted` — and the guard reported the slot UNRESERVED (halt-and-report ⇒
  // continue:true ⇒ THE WRITE LANDS), while the allocator
  // (`journal-reserve.js::_foldHighWater`) REFUSES on the same bytes. That
  // disagreement between the two readers of one fold input is the defect.
  //
  // The three failure shapes are deliberately different in KIND: corrupt bytes
  // (loud), an unreadable path (EISDIR — an errno), and an ERASED-BUT-VALID
  // roster (`{"persons":{}}` — parses fine, resolves nobody). The last is the
  // one a presence-or-parse check cannot see and the cheapest to perform.
  const w = makeSoloWorld("c11");
  const rosterPath = path.join(w.repoDir, ".claude", "operators.roster.json");
  const healthy = fs.readFileSync(rosterPath, "utf8");
  writeLog(w.repoDir, [reservationRecord(w, { slot: "0012", dir: "journal", by: "self" })]);
  const payload = writePayload(w, "journal/0012-DECISION-roster.md");

  const ok = drive(w, payload);

  fs.writeFileSync(rosterPath, "{ not json at all\n");
  const corrupt = drive(w, payload);

  fs.rmSync(rosterPath);
  fs.mkdirSync(rosterPath); // readFileSync on a directory ⇒ EISDIR
  const unreadable = drive(w, payload);
  fs.rmdirSync(rosterPath);

  fs.writeFileSync(rosterPath, JSON.stringify({ genesis: GENESIS, persons: {} }) + "\n");
  const erased = drive(w, payload);

  fs.writeFileSync(rosterPath, healthy);
  const restored = drive(w, payload);

  // THE CLASSIFIER'S OTHER POLE — a HEALTHY roster with a record the fold
  // rejects anyway, which must NOT read as a roster failure. The sig below is
  // transplanted from a record over different content: well-formed, does not
  // verify. With coordination forced ON the fold verifies signatures and rejects
  // it at rule-1 — the SAME RULE the erased roster trips — so a classifier that
  // keys on the rule NAME calls this a roster loss and BLOCKS, when the honest
  // verdict is UNRESERVED: the roster is fine, the record is a forgery, and the
  // slot genuinely holds no valid reservation. The classifier must therefore ask
  // the ROSTER, not the rule name. Pinned as a TAG, not as `refused`: a BLOCK is
  // also "refused", so only the severity discriminates the two verdicts.
  const f = makeSoloWorld("c11f");
  const donor = reservationRecord(f, { slot: "9999", dir: "journal", by: "self" });
  writeLog(f.repoDir, [
    { ...reservationRecord(f, { slot: "0031", dir: "journal", by: "self" }), sig: donor.sig },
  ]);
  fs.writeFileSync(
    path.join(f.repoDir, ".claude", "learning", "coordination-mode.json"),
    '{"enabled":true}\n',
  );
  const forged = drive(f, writePayload(f, "journal/0031-DECISION-forged.md"));

  // IDENTITY ASSERTION: the refusals must name the ROSTER as the failing input,
  // not merely refuse. A block that says "coordination log unreadable" sends the
  // operator to chmod a healthy file.
  const namesRoster = (r) =>
    r.combined.includes("operators.roster.json") || r.combined.toLowerCase().includes("roster");
  // ...and must NOT be the UNRESERVED verdict. Keyed on that branch's OWN
  // what_happened sentence, not on the bare token "UNRESERVED": the roster
  // branch's `why` legitimately quotes the word while explaining why it must not
  // fall through to it, so a token match here would red on correct prose.
  const saysUnreserved = (r) => r.combined.includes("is not reserved in the coordination log");
  check(
    "C11: identical self-reservation throughout — healthy roster ⇒ passthrough / corrupt ⇒ BLOCK / unreadable ⇒ BLOCK / erased-but-valid ⇒ BLOCK, each naming the ROSTER; restoring it ⇒ passthrough again",
    ok.code === 0 &&
      ok.tag === "(none)" &&
      corrupt.code === 2 &&
      corrupt.tag === "[BLOCK]" &&
      namesRoster(corrupt) &&
      unreadable.code === 2 &&
      unreadable.tag === "[BLOCK]" &&
      namesRoster(unreadable) &&
      erased.code === 2 &&
      erased.tag === "[BLOCK]" &&
      namesRoster(erased) &&
      !saysUnreserved(corrupt) &&
      !saysUnreserved(unreadable) &&
      !saysUnreserved(erased) &&
      restored.code === 0 &&
      restored.tag === "(none)" &&
      forged.tag === "[HALT-AND-REPORT]" &&
      saysUnreserved(forged),
    `forged-sig on a HEALTHY roster (coordination ON): ${verdict(forged)} unreservedMsg=${saysUnreserved(forged)} | healthy: ${verdict(ok)} | corrupt: ${verdict(corrupt)} namesRoster=${namesRoster(corrupt)} unreservedMsg=${saysUnreserved(corrupt)} | unreadable(EISDIR): ${verdict(unreadable)} namesRoster=${namesRoster(unreadable)} unreservedMsg=${saysUnreserved(unreadable)} | erased {persons:{}}: ${verdict(erased)} namesRoster=${namesRoster(erased)} unreservedMsg=${saysUnreserved(erased)} | restored: ${verdict(restored)}`,
    "UNRESERVED or a pass on any BROKEN arm = a roster the fold cannot use reads as a completed clean check, the guard waves the write through, and it disagrees with the allocator, which refuses on those exact bytes; a refusal on the HEALTHY or RESTORED arm = the fence now fires on a working repo and no journal entry can be written at all; a BLOCK on the FORGED-SIG arm = the classifier reads the rule NAME instead of asking the roster, so every forged reservation is misreported as a broken trust root and the operator is sent to restore a healthy file.",
  );
}

{
  // C12 — THE AUTHOR CHECK RUNS ON EVERY RESERVATION VERDICT, NOT ONLY THE
  // SELF-RESERVED ONE. It used to sit below two emit() calls that never return,
  // so an `author: human` claim in an UNRESERVED slot or a SIBLING'S slot was
  // never checked — the surface where a false authorship claim is most likely
  // was the one surface the verifier could not reach.
  //
  // The content is byte-identical across the three arms (`author: human`, no
  // ledger ⇒ undetermined); only the RESERVATION moves. Each verdict must carry
  // BOTH findings, and the self-reserved arm must still refuse on the author
  // alone. IDENTITY: the emitted text must name the author claim, not just halt.
  const w = makeWorld("c12");
  const body = "---\nauthor: human\ntype: DECISION\n---\n\nbody\n";
  const at = (rel) => {
    const p = path.join(w.repoDir, rel);
    ensureParent(p);
    return {
      session_id: "jwg-c12",
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: p, content: body },
      cwd: w.repoDir,
    };
  };
  writeLog(w.repoDir, []);
  const unreserved = drive(w, at("journal/0007-DECISION-unreserved.md"));
  writeLog(w.repoDir, [reservationRecord(w, { slot: "0023", dir: "journal", by: "sibling" })]);
  const sibling = drive(w, at("journal/0023-DECISION-sibling.md"));
  writeLog(w.repoDir, [reservationRecord(w, { slot: "0012", dir: "journal", by: "self" })]);
  const selfSlot = drive(w, at("journal/0012-DECISION-self.md"));
  const carriesAuthor = (r) => r.combined.includes("author") && r.combined.includes("human");
  check(
    "C12: identical `author: human` content, unbacked — UNRESERVED slot ⇒ refusal carrying BOTH the slot and the author finding / SIBLING slot ⇒ likewise / SELF-reserved slot ⇒ refusal on the author finding alone",
    unreserved.refused === true &&
      unreserved.combined.includes("UNRESERVED") &&
      carriesAuthor(unreserved) &&
      sibling.refused === true &&
      sibling.combined.includes(SIB.display_id) &&
      carriesAuthor(sibling) &&
      selfSlot.refused === true &&
      carriesAuthor(selfSlot) &&
      !selfSlot.combined.includes("UNRESERVED"),
    `unreserved: ${verdict(unreserved)} carriesAuthor=${carriesAuthor(unreserved)} | sibling: ${verdict(sibling)} carriesAuthor=${carriesAuthor(sibling)} | self: ${verdict(selfSlot)} carriesAuthor=${carriesAuthor(selfSlot)}`,
    "an author-free refusal on the UNRESERVED or SIBLING arm = the backing check is still short-circuited by the reservation verdict, and a false authorship claim ships unexamined on exactly the slots it is most likely to appear on; a pass on the SELF arm = the check stopped running at all.",
  );
}

{
  // C13 — FRONTMATTER THE PARSER CANNOT READ IS A FINDING, NOT A SKIP. All five
  // arms are in the SAME self-reserved slot, so the reservation fence is
  // satisfied and the author layer is the only thing that can speak. The prior
  // line regex `/^author:\s*(.+?)\s*$/` matched only arm (a); (b) and (c) are the
  // SAME CLAIM in shapes it missed, and (d)/(e) are frontmatter that cannot be
  // read at all — every one of them returned `null`, i.e. "no claim", i.e. pass.
  const w = makeSoloWorld("c13");
  writeLog(w.repoDir, [reservationRecord(w, { slot: "0012", dir: "journal", by: "self" })]);
  const fire = (content) => {
    const p = path.join(w.repoDir, "journal/0012-DECISION-fm.md");
    ensureParent(p);
    return drive(w, {
      session_id: "jwg-c13",
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: p, content },
      cwd: w.repoDir,
    });
  };
  const plain = fire("---\nauthor: human\n---\nbody\n");
  const quotedKey = fire('---\n"author": human\n---\nbody\n');
  const spacedKey = fire("---\nauthor : human\n---\nbody\n");
  const unterminated = fire("---\nauthor: human\ntype: DECISION\n\nbody with no closing fence\n");
  const duplicate = fire("---\nauthor: agent\nauthor: human\n---\nbody\n");
  // CONTROLS — neither shape may become a false positive.
  const agent = fire(SHAPE_CLEAN_FM + "body\n");
  const noFrontmatter = fire("# just a heading\n\nbody\n");
  const bodyOnly = fire("---\ntype: DECISION\n---\n\nauthor: human\n");
  check(
    "C13: same self-reserved slot — `author: human` written plain / quoted-key / spaced-key ⇒ all REFUSED; unterminated and duplicated frontmatter ⇒ REFUSED as unparseable; `author: agent`, no frontmatter, and a BODY-only `author:` line ⇒ passthrough",
    plain.refused === true &&
      quotedKey.refused === true &&
      spacedKey.refused === true &&
      unterminated.refused === true &&
      unterminated.combined.includes("UNPARSEABLE") &&
      duplicate.refused === true &&
      duplicate.combined.includes("UNPARSEABLE") &&
      agent.code === 0 &&
      agent.tag === "(none)" &&
      // These two arms CANNOT be made shape-clean without destroying what they
      // test: `noFrontmatter` has no frontmatter BY DEFINITION, and `bodyOnly`
      // deliberately carries a minimal block. So their expected verdict MOVES
      // rather than their content — a journal Write with no/incomplete
      // frontmatter IS now an advisory (`rules/journal.md` § MUST NOT). This is
      // a STRONGER assertion than the `(none)` it replaces: it now requires the
      // shape layer to fire here, so switching that layer off REDS this case.
      // What is unchanged is the authorship verdict both arms exist for —
      // `code === 0`, i.e. no refusal, because neither made an authorship claim.
      noFrontmatter.code === 0 &&
      noFrontmatter.tag === "[ADVISORY]" &&
      bodyOnly.code === 0 &&
      bodyOnly.tag === "[ADVISORY]",
    `plain: ${verdict(plain)} | "author": ${verdict(quotedKey)} | author : ${verdict(spacedKey)} | unterminated: ${verdict(unterminated)} | duplicate: ${verdict(duplicate)} | agent: ${verdict(agent)} | no-frontmatter: ${verdict(noFrontmatter)} | body-only: ${verdict(bodyOnly)}`,
    "a pass on the quoted- or spaced-key arm = the SAME false `author: human` claim ships unchecked by writing it differently; a pass on the unterminated/duplicate arms = a frontmatter the checker could not read is reported as a clean check that ran; a refusal on the agent/no-frontmatter/body-only arms = the layer fires where no human-authorship claim was made, and every agent-surfaced entry halts.",
  );
}

{
  // C14 — AN ERRORED CHECK IS NOT A CLEAN CHECK. The internal-error branch wrote
  // a bare `{continue:true}` — byte-identical to "I folded the log and your slot
  // is fine" — so any exception in this guard read downstream as a pass, and
  // nothing could drive it to notice. Same world, same self-reserved slot, same
  // payload; only the injected fault moves.
  const w = makeSoloWorld("c14");
  writeLog(w.repoDir, [reservationRecord(w, { slot: "0012", dir: "journal", by: "self" })]);
  const payload = writePayload(w, "journal/0012-DECISION-fault.md");
  const clean = drive(w, payload);
  const faulted = driveHook(HOOK, {
    stdinRaw: JSON.stringify(payload),
    cwd: w.repoDir,
    env: { ...envFor(w), COC_TEST_JOURNAL_GUARD_INTERNAL_ERROR: "1" },
  });
  const ctx =
    faulted.json && faulted.json.hookSpecificOutput && typeof faulted.json.hookSpecificOutput.additionalContext === "string"
      ? faulted.json.hookSpecificOutput.additionalContext
      : "";
  check(
    "C14: self-reserved slot — no fault ⇒ passthrough / injected internal error ⇒ HALT-AND-REPORT 'reservation check errored — slot unverified' naming the slot, never a bare continue",
    clean.code === 0 &&
      clean.tag === "(none)" &&
      faulted.code === 0 &&
      faulted.tag === "[HALT-AND-REPORT]" &&
      !!faulted.json &&
      faulted.json.continue === true &&
      ctx.includes("reservation check errored") &&
      ctx.includes("slot unverified") &&
      ctx.includes("0012") &&
      !faulted.combined.includes("UNRESERVED"),
    `clean: ${verdict(clean)} | faulted: ${verdict(faulted)} json=${JSON.stringify(faulted.json).slice(0, 90)}`,
    "tag (none) or a bare {continue:true} on the FAULTED arm = a guard that threw still reports as a completed clean check; UNRESERVED there = an errored check is reported as a completed negative; a refusal on the CLEAN arm = the injected fault is not the thing being measured.",
  );
}

{
  // C15 — THE INJECTION SWITCHES ARE STRIPPED BY THE HARNESS. Both keys make the
  // guard refuse unconditionally, so an AMBIENT value would turn every journal
  // fixture in this suite green on the wrong branch — a verdict right by accident
  // with the branch under test unrun. Set them in THIS process, then drive the
  // same self-reserved payload through the harness and require a passthrough.
  const w = makeSoloWorld("c15");
  writeLog(w.repoDir, [reservationRecord(w, { slot: "0012", dir: "journal", by: "self" })]);
  const payload = writePayload(w, "journal/0012-DECISION-ambient.md");
  const saved = {
    b: process.env.COC_JOURNAL_GUARD_BUDGET_MS,
    e: process.env.COC_TEST_JOURNAL_GUARD_INTERNAL_ERROR,
  };
  process.env.COC_JOURNAL_GUARD_BUDGET_MS = "1";
  process.env.COC_TEST_JOURNAL_GUARD_INTERNAL_ERROR = "1";
  let ambient;
  try {
    ambient = drive(w, payload);
  } finally {
    if (saved.b === undefined) delete process.env.COC_JOURNAL_GUARD_BUDGET_MS;
    else process.env.COC_JOURNAL_GUARD_BUDGET_MS = saved.b;
    if (saved.e === undefined) delete process.env.COC_TEST_JOURNAL_GUARD_INTERNAL_ERROR;
    else process.env.COC_TEST_JOURNAL_GUARD_INTERNAL_ERROR = saved.e;
  }
  check(
    "C15: both injection keys exported AMBIENTLY in the runner — a self-reserved write still passes, so GUARD_ENV_KEYS strips them",
    GUARD_ENV_KEYS.includes("COC_JOURNAL_GUARD_BUDGET_MS") &&
      GUARD_ENV_KEYS.includes("COC_TEST_JOURNAL_GUARD_INTERNAL_ERROR") &&
      ambient.code === 0 &&
      ambient.tag === "(none)",
    `ambient: ${verdict(ambient)} | listed: budget=${GUARD_ENV_KEYS.includes("COC_JOURNAL_GUARD_BUDGET_MS")} fault=${GUARD_ENV_KEYS.includes("COC_TEST_JOURNAL_GUARD_INTERNAL_ERROR")}`,
    "a refusal here = an ambient value reaches the guard, and every disposition this suite pins can be satisfied on the not-completed or errored branch instead of the branch it names.",
  );
}

cleanup();
finish();
