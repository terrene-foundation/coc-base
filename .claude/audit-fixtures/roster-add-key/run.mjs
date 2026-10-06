#!/usr/bin/env node
/**
 * roster-add-key — fixtures for `.claude/hooks/lib/add-key-ceremony.js`, the
 * ceremony that APPENDS a signing key to an EXISTING roster person_id.
 *
 * BIPOLAR PER REFUSAL. Every refusal below has a pole that MUST fire and a pole
 * that MUST stay silent. A ceremony shown only to refuse has proved it can say
 * "no" and nothing else, and a ceremony shown only to succeed has proved it can
 * say "yes" to anything. Each RED pole asserts a failure IDENTITY (the typed
 * `code`), never merely `ok === false` — a refusal test that accepts any
 * refusal passes identically when the ceremony refuses for the WRONG reason,
 * which is the same non-discriminating instrument the suite exists to prevent.
 *
 * NOT MOCKED. The keys are REAL ed25519 keys made by `ssh-keygen`, the
 * signatures are REAL SSHSIG signatures produced and verified by the shipped
 * `coc-sign.js`, and the rosters are REAL files schema-validated by the shipped
 * `roster-schema-validate.js`. A case therefore cannot pass against a substrate
 * the ceremony would not actually use.
 *
 * THE MUTATION CASE IS NOT DECORATION. `coc-sign.verify` returns
 * `{ok: true, valid: false}` for a signature that does NOT verify — `ok` reports
 * that the check RAN, `valid` reports the VERDICT. A first draft of the ceremony
 * read `ok` alone and would have admitted a mismatched key. `PoP/mutation`
 * below rebuilds the module with that exact regression re-introduced and asserts
 * the forged-key case then SUCCEEDS, which is what shows the `valid !== true`
 * conjunct is load-bearing rather than ornamental. Without it, the passing
 * `PoP/forged` case is consistent with both a working guard and a vacuous one.
 *
 * NEVER THE LIVE ROSTER. Every write happens inside one mkdtemp directory keyed
 * on this process's pid. The one case that consults the repo's real roster reads
 * it, builds a post-image IN MEMORY, and asserts over that — it opens no write
 * handle on `.claude/operators.roster.json` at all.
 */
import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const LIB_DIR = path.join(REPO_ROOT, ".claude", "hooks", "lib");
const CEREMONY = path.join(LIB_DIR, "add-key-ceremony.js");
const LIVE_ROSTER = path.join(REPO_ROOT, ".claude", "operators.roster.json");

const ck = require(CEREMONY);
const cocSign = require(path.join(LIB_DIR, "coc-sign.js"));
const { REFUSAL } = ck;

/** Captured BEFORE any case runs; re-read at the end as the no-write proof. */
const LIVE_MTIME = fs.statSync(LIVE_ROSTER).mtimeMs;

let pass = 0;
const failures = [];
function check(name, fn) {
  let ok;
  try {
    ok = fn();
  } catch (e) {
    ok = `threw: ${e && e.message}`;
  }
  if (ok === true) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name}${typeof ok === "string" ? ` — ${ok}` : ""}`);
  }
}

/** Assert a refusal by IDENTITY, not merely by falsiness. */
function refusedWith(res, code) {
  if (res.ok) return `expected refusal ${code}, got ok`;
  if (res.code !== code) return `expected refusal ${code}, got ${res.code}: ${res.message}`;
  return true;
}

// ---------------------------------------------------------------------------
// One sandbox, keyed on this pid. Nothing below ever touches the live roster.
// ---------------------------------------------------------------------------
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), `roster-add-key-${process.pid}-`));
process.on("exit", () => {
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch {}
});

/** Real ed25519 keypairs — the fingerprints and signatures must both be real. */
const KEYS = path.join(SANDBOX, "keys");
fs.mkdirSync(KEYS, { recursive: true });
function mkkey(name) {
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", path.join(KEYS, name)]);
  const priv = path.join(KEYS, name);
  const pubPath = `${priv}.pub`;
  const out = execFileSync("ssh-keygen", ["-lf", pubPath], { encoding: "utf8" }).trim();
  const fingerprint = out.split(/\s+/)[1];
  return { priv, pubPath, pubkey: fs.readFileSync(pubPath, "utf8").trim(), fingerprint };
}
const alphaKey = mkkey("alpha");
const betaKey = mkkey("beta");
const newKey = mkkey("newkey");
const otherKey = mkkey("otherkey");

const PID_A = "pid-alpha-aaaa1111";
const PID_B = "pid-beta-bbbb2222";

function baseRoster() {
  return {
    genesis: {
      repo_owner: "alpha",
      repo_owner_kind: "user",
      root_commit: "abc1234",
      genesis_generation: 0,
    },
    persons: {
      [PID_A]: {
        display_id: "alpha",
        role: "contributor",
        github_login: "alpha",
        host_role: "human",
        keys: [{ type: "ssh", fingerprint: alphaKey.fingerprint, pubkey: alphaKey.pubkey }],
      },
      [PID_B]: {
        display_id: "beta",
        role: "owner",
        github_login: "beta",
        host_role: "human",
        keys: [{ type: "ssh", fingerprint: betaKey.fingerprint, pubkey: betaKey.pubkey }],
      },
    },
  };
}

let caseSeq = 0;
/** A throwaway roster file per case, so no case can observe another's write. */
function mkRoster(mutate) {
  const dir = path.join(SANDBOX, `case-${++caseSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  const r = baseRoster();
  if (mutate) mutate(r);
  const p = path.join(dir, "operators.roster.json");
  fs.writeFileSync(p, JSON.stringify(r, null, 2) + "\n");
  return p;
}

function readRoster(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** The self-service happy path, parameterised so poles differ in ONE input. */
function addKey(overrides) {
  return ck.runAddKeyCeremony(
    Object.assign(
      {
        repoDir: SANDBOX,
        personId: PID_A,
        newKeyPath: newKey.pubPath,
        newKeyType: "ssh",
        signingKeyPath: alphaKey.priv,
        signingKeyType: "ssh",
        apply: false,
      },
      overrides,
    ),
  );
}

// ===========================================================================
// A · THE CAPABILITY ITSELF — the thing that did not exist before this file.
// ===========================================================================

check("A/appends a key to the caller's OWN person_id", () => {
  const rp = mkRoster();
  const res = addKey({ rosterPath: rp, apply: true });
  if (!res.ok) return `refused: ${res.code} ${res.message}`;
  if (res.keys_before !== 1 || res.keys_after !== 2) {
    return `expected 1 → 2 keys, got ${res.keys_before} → ${res.keys_after}`;
  }
  const after = readRoster(rp);
  const keys = after.persons[PID_A].keys;
  if (keys.length !== 2) return `on-disk roster has ${keys.length} keys, expected 2`;
  if (keys[1].fingerprint !== newKey.fingerprint) return "the appended key is not the one requested";
  if (keys[1].pubkey !== newKey.pubkey) return "the stored pubkey body is not the new key's";
  return true;
});

check("A/the PRE-EXISTING key survives the append byte-for-byte at index 0", () => {
  const rp = mkRoster();
  const before = readRoster(rp).persons[PID_A].keys[0];
  const res = addKey({ rosterPath: rp, apply: true });
  if (!res.ok) return `refused: ${res.code}`;
  const after = readRoster(rp).persons[PID_A].keys[0];
  return JSON.stringify(before) === JSON.stringify(after)
    ? true
    : "the existing key at index 0 was rewritten by an APPEND";
});

check("A/the OTHER person's record is untouched by the append", () => {
  const rp = mkRoster();
  const before = JSON.stringify(readRoster(rp).persons[PID_B]);
  const res = addKey({ rosterPath: rp, apply: true });
  if (!res.ok) return `refused: ${res.code}`;
  return JSON.stringify(readRoster(rp).persons[PID_B]) === before
    ? true
    : "an unrelated person's record changed";
});

check("A/without --apply the roster file is not written at all", () => {
  const rp = mkRoster();
  const before = fs.readFileSync(rp, "utf8");
  const res = addKey({ rosterPath: rp, apply: false });
  if (!res.ok) return `refused: ${res.code} ${res.message}`;
  if (res.applied !== false) return "plan mode reported applied:true";
  return fs.readFileSync(rp, "utf8") === before ? true : "plan mode wrote the roster";
});

check("A/the fingerprint stored is the one operator-id's OWN resolver derives", () => {
  // A second derivation that disagreed with resolveIdentity's would enroll a
  // key under a fingerprint that never resolves. Same resolver, same answer.
  const { _fingerprintFromKey } = require(path.join(LIB_DIR, "operator-id.js"));
  const rp = mkRoster();
  const res = addKey({ rosterPath: rp, apply: true });
  if (!res.ok) return `refused: ${res.code}`;
  const stored = readRoster(rp).persons[PID_A].keys[1].fingerprint;
  const resolver = _fingerprintFromKey(newKey.pubPath, "ssh");
  return stored === resolver ? true : `stored ${stored} but the resolver derives ${resolver}`;
});

// ===========================================================================
// B · DUPLICATE FINGERPRINT — one key never binds two identities.
// ===========================================================================

check("B/RED a fingerprint already enrolled under ANOTHER person is refused", () => {
  const rp = mkRoster();
  const res = addKey({ rosterPath: rp, newKeyPath: betaKey.pubPath, apply: true });
  const v = refusedWith(res, REFUSAL.DUPLICATE_FINGERPRINT);
  if (v !== true) return v;
  if (res.holder_person_id !== PID_B) return `refusal did not name the holder (${res.holder_person_id})`;
  return true;
});

check("B/RED a fingerprint already enrolled under the SAME person is refused", () => {
  const rp = mkRoster();
  const res = addKey({ rosterPath: rp, newKeyPath: alphaKey.pubPath, apply: true });
  const v = refusedWith(res, REFUSAL.DUPLICATE_FINGERPRINT);
  if (v !== true) return v;
  return res.holder_person_id === PID_A ? true : "refusal named the wrong holder";
});

check("B/GREEN a fingerprint enrolled nowhere is accepted", () => {
  const rp = mkRoster();
  const res = addKey({ rosterPath: rp, newKeyPath: otherKey.pubPath, apply: true });
  return res.ok ? true : `refused: ${res.code} ${res.message}`;
});

check("B/a refused duplicate leaves the roster byte-identical", () => {
  const rp = mkRoster();
  const before = fs.readFileSync(rp, "utf8");
  addKey({ rosterPath: rp, newKeyPath: betaKey.pubPath, apply: true });
  return fs.readFileSync(rp, "utf8") === before ? true : "a refusal still wrote the roster";
});

// ===========================================================================
// C · SELF-SERVICE ONLY — someone else's person_id is a quorum act.
// ===========================================================================

check("C/RED adding a key to ANOTHER person's person_id is refused", () => {
  const rp = mkRoster();
  const res = addKey({ rosterPath: rp, personId: PID_B, apply: true });
  const v = refusedWith(res, REFUSAL.NOT_SELF_SERVICE);
  if (v !== true) return v;
  if (res.signer_person_id !== PID_A) return "refusal did not name the signer's own person_id";
  if (!/quorum/i.test(res.message)) return "refusal does not say WHY (quorum-gated), only that it refused";
  return true;
});

check("C/GREEN the same signer adding to their OWN person_id is accepted", () => {
  const rp = mkRoster();
  const res = addKey({ rosterPath: rp, personId: PID_A, apply: true });
  return res.ok ? true : `refused: ${res.code} ${res.message}`;
});

check("C/RED a signing key enrolled under NO person_id is refused", () => {
  const rp = mkRoster();
  const res = addKey({ rosterPath: rp, signingKeyPath: otherKey.priv, apply: true });
  return refusedWith(res, REFUSAL.SIGNER_UNROSTERED);
});

check("C/RED a person_id absent from the roster is refused, not created", () => {
  const rp = mkRoster();
  const res = addKey({ rosterPath: rp, personId: "pid-ghost-99999999", apply: true });
  const v = refusedWith(res, REFUSAL.UNKNOWN_PERSON);
  if (v !== true) return v;
  if (readRoster(rp).persons["pid-ghost-99999999"]) return "the ceremony MINTED the absent person_id";
  if (!/--register/.test(res.message)) return "refusal does not route to the ceremony that DOES mint one";
  return true;
});

// ===========================================================================
// D · PROOF OF POSSESSION — naming an enrolled key is free; holding it is not.
// ===========================================================================

check("D/PoP/RED a roster pubkey that does not match its stored fingerprint is refused", () => {
  // The realistic shape: a hand-edited roster where the fingerprint says alpha
  // but the pubkey body is someone else's. The caller signs with alpha's real
  // key, so the fingerprint lookup succeeds and only the SIGNATURE CHECK can
  // catch it.
  const rp = mkRoster((r) => {
    r.persons[PID_A].keys[0].pubkey = otherKey.pubkey;
  });
  const res = addKey({ rosterPath: rp, apply: true });
  return refusedWith(res, REFUSAL.PROOF_OF_POSSESSION_FAILED);
});

check("D/PoP/GREEN a matching enrolled pubkey verifies and the append proceeds", () => {
  const rp = mkRoster();
  const res = addKey({ rosterPath: rp, apply: true });
  return res.ok ? true : `refused: ${res.code} ${res.message}`;
});

check("D/PoP/the verify substrate's VERDICT field is `valid`, not `ok`", () => {
  // Pins the contract the guard is written against. coc-sign.verify reports
  // that the check RAN in `ok` and the verdict in `valid`; if that ever
  // inverts, this case tells us before the ceremony silently starts admitting.
  const payload = cocSign.canonicalSerialize({ t: "pin" });
  const s = cocSign.sign(payload, { keyPath: alphaKey.priv, keyType: "ssh" });
  if (!s.ok) return `could not sign: ${s.reason || s.error}`;
  const good = cocSign.verify(payload, s.sig, alphaKey.pubkey, { keyType: "ssh" });
  const bad = cocSign.verify(payload, s.sig, otherKey.pubkey, { keyType: "ssh" });
  if (good.valid !== true) return "a correct signature did not report valid:true";
  if (bad.valid !== false) return "a wrong-key signature did not report valid:false";
  if (bad.ok !== true) return "the wrong-key verify no longer reports ok:true — the guard's premise changed";
  return true;
});

check("D/PoP/mutation — dropping the `valid` conjunct makes the forged case SUCCEED", () => {
  // The discrimination proof. Rebuild the module with the exact prior
  // regression (`valid !== true` removed) and confirm the case that catches a
  // mismatched pubkey now passes. If this mutation did NOT change the result,
  // the passing PoP/RED case above would be consistent with a vacuous guard.
  const src = fs.readFileSync(CEREMONY, "utf8");
  const NEEDLE = "if (!verified || !verified.ok || verified.valid !== true) {";
  if (!src.includes(NEEDLE)) return "the guarded line is not where the mutation expects it";
  const mutated = src
    .replace(NEEDLE, "if (!verified || !verified.ok) {")
    // The copy lives outside hooks/lib, so its relative requires must be rebound.
    .replace(/require\("\.\/([a-z0-9-]+\.js)"\)/g, (_m, f) => `require(${JSON.stringify(path.join(LIB_DIR, f))})`);
  if (mutated === src) return "the mutation produced an identical file — it never reached the code";
  const mutPath = path.join(SANDBOX, "mutant-add-key-ceremony.cjs");
  fs.writeFileSync(mutPath, mutated);
  const mut = require(mutPath);
  const rp = mkRoster((r) => {
    r.persons[PID_A].keys[0].pubkey = otherKey.pubkey;
  });
  const res = mut.runAddKeyCeremony({
    repoDir: SANDBOX,
    rosterPath: rp,
    personId: PID_A,
    newKeyPath: newKey.pubPath,
    newKeyType: "ssh",
    signingKeyPath: alphaKey.priv,
    signingKeyType: "ssh",
    apply: false,
  });
  if (!res.ok) {
    return `the mutant STILL refused (${res.code}) — the guard is not what stops the forged case, so PoP/RED proves nothing`;
  }
  return true;
});

// ===========================================================================
// E · FAIL CLOSED ON EVERY UNKNOWN.
// ===========================================================================

check("E/RED an absent roster fails closed with roster-unreadable", () => {
  const res = addKey({ rosterPath: path.join(SANDBOX, "nope", "operators.roster.json") });
  return refusedWith(res, REFUSAL.ROSTER_UNREADABLE);
});

check("E/RED an unparseable roster fails closed with roster-malformed", () => {
  const dir = path.join(SANDBOX, `bad-${++caseSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "operators.roster.json");
  fs.writeFileSync(p, "{ this is not json ");
  return refusedWith(addKey({ rosterPath: p }), REFUSAL.ROSTER_MALFORMED);
});

check("E/RED a roster with no persons object fails closed", () => {
  const dir = path.join(SANDBOX, `nopersons-${++caseSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "operators.roster.json");
  fs.writeFileSync(p, JSON.stringify({ genesis: {} }));
  return refusedWith(addKey({ rosterPath: p }), REFUSAL.ROSTER_MALFORMED);
});

check("E/RED an unparseable key file fails closed with new-key-unresolvable", () => {
  const junk = path.join(SANDBOX, "junk.pub");
  fs.writeFileSync(junk, "this is not a public key\n");
  return refusedWith(addKey({ rosterPath: mkRoster(), newKeyPath: junk }), REFUSAL.NEW_KEY_UNRESOLVABLE);
});

check("E/RED an absent key file fails closed with new-key-unresolvable", () => {
  const missing = path.join(SANDBOX, "does-not-exist.pub");
  return refusedWith(addKey({ rosterPath: mkRoster(), newKeyPath: missing }), REFUSAL.NEW_KEY_UNRESOLVABLE);
});

check("E/RED gpg without an explicit armored pubkey fails closed, never guesses a keyring", () => {
  // The gpg arm of _fingerprintFromKey falls back to the VERBATIM identifier
  // when nothing normalizes it, so a non-40-hex id must be caught here rather
  // than enrolled as a fingerprint that never resolves.
  const res = addKey({
    rosterPath: mkRoster(),
    newKeyPath: "DEADBEEF",
    newKeyType: "gpg",
  });
  if (res.ok) return "a bare gpg key id was accepted";
  if (res.code !== REFUSAL.NEW_KEY_UNRESOLVABLE && res.code !== REFUSAL.NEW_PUBKEY_UNREADABLE) {
    return `expected a gpg-path refusal, got ${res.code}: ${res.message}`;
  }
  return true;
});

check("E/RED a valid 40-hex gpg fingerprint with no armored pubkey is still refused", () => {
  const res = addKey({
    rosterPath: mkRoster(),
    newKeyPath: "A".repeat(40),
    newKeyType: "gpg",
  });
  return refusedWith(res, REFUSAL.NEW_PUBKEY_UNREADABLE);
});

check("E/RED an unsupported key type is refused before anything is read", () => {
  return refusedWith(
    addKey({ rosterPath: mkRoster(), newKeyType: "rsa-pkcs1" }),
    REFUSAL.BAD_KEY_TYPE,
  );
});

check("E/RED no signing key at all is refused — an add-key is never unsigned", () => {
  const res = ck.runAddKeyCeremony({
    repoDir: path.join(SANDBOX, "no-git-here"),
    rosterPath: mkRoster(),
    personId: PID_A,
    newKeyPath: newKey.pubPath,
    signingKeyPath: undefined,
    apply: true,
  });
  if (res.ok) return "an unsigned add-key succeeded";
  if (res.code !== REFUSAL.SIGNER_UNRESOLVABLE && res.code !== REFUSAL.SIGNER_UNROSTERED) {
    return `expected a signer refusal, got ${res.code}: ${res.message}`;
  }
  return true;
});

check("E/every refusal path leaves the roster byte-identical", () => {
  const cases = [
    { newKeyPath: betaKey.pubPath },
    { personId: PID_B },
    { signingKeyPath: otherKey.priv },
    { personId: "pid-ghost-99999999" },
    { newKeyType: "rsa-pkcs1" },
  ];
  for (const c of cases) {
    const rp = mkRoster();
    const before = fs.readFileSync(rp, "utf8");
    const res = addKey(Object.assign({ rosterPath: rp, apply: true }, c));
    if (res.ok) return `case ${JSON.stringify(c)} unexpectedly succeeded`;
    if (fs.readFileSync(rp, "utf8") !== before) return `case ${JSON.stringify(c)} wrote on a refusal`;
  }
  return true;
});

// ===========================================================================
// F · APPEND-ONLY, asserted over a post-image the ceremony did NOT construct.
// ===========================================================================

/** Write a pre/post pair and run the public predicate over them. */
function checkEdit(mutatePost) {
  const dir = path.join(SANDBOX, `edit-${++caseSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  const prePath = path.join(dir, "pre.json");
  const postPath = path.join(dir, "post.json");
  const pre = baseRoster();
  fs.writeFileSync(prePath, JSON.stringify(pre, null, 2));
  const post = JSON.parse(JSON.stringify(pre));
  mutatePost(post);
  fs.writeFileSync(postPath, JSON.stringify(post, null, 2));
  return ck.checkRosterEdit(prePath, postPath);
}

const APPENDED = { type: "ssh", fingerprint: newKey.fingerprint, pubkey: newKey.pubkey };

check("F/GREEN a pure append passes the append-only predicate", () => {
  const res = checkEdit((p) => p.persons[PID_A].keys.push(APPENDED));
  return res.ok ? true : `refused: ${res.code} ${res.message}`;
});

check("F/RED removing an existing key is refused", () => {
  return refusedWith(
    checkEdit((p) => {
      p.persons[PID_A].keys = [];
      p.persons[PID_A].keys.push(APPENDED);
    }),
    REFUSAL.APPEND_ONLY_VIOLATION,
  );
});

check("F/RED shortening the key list is refused", () => {
  const res = checkEdit((p) => {
    p.persons[PID_A].keys.push(APPENDED);
    p.persons[PID_B].keys = [];
  });
  return refusedWith(res, REFUSAL.APPEND_ONLY_VIOLATION);
});

check("F/RED REORDERING keys is refused (a set comparison would accept it)", () => {
  const res = checkEdit((p) => {
    p.persons[PID_A].keys.push(APPENDED);
    p.persons[PID_A].keys.reverse();
  });
  const v = refusedWith(res, REFUSAL.APPEND_ONLY_VIOLATION);
  if (v !== true) return v;
  return /replaced or reordered/.test(res.message) ? true : "refusal message does not name the reorder";
});

check("F/RED REPLACING an existing key in place is refused (a length check would accept it)", () => {
  const res = checkEdit((p) => {
    p.persons[PID_A].keys[0] = APPENDED;
    p.persons[PID_A].keys.push({
      type: "ssh",
      fingerprint: otherKey.fingerprint,
      pubkey: otherKey.pubkey,
    });
  });
  return refusedWith(res, REFUSAL.APPEND_ONLY_VIOLATION);
});

check("F/RED mutating an existing key's pubkey body in place is refused", () => {
  const res = checkEdit((p) => {
    p.persons[PID_A].keys[0].pubkey = otherKey.pubkey;
    p.persons[PID_A].keys.push(APPENDED);
  });
  return refusedWith(res, REFUSAL.APPEND_ONLY_VIOLATION);
});

check("F/RED dropping a whole person (and their keys) is refused", () => {
  const res = checkEdit((p) => {
    delete p.persons[PID_B];
  });
  // Dropping a person removes their keys AND changes the person_id set; either
  // predicate is a correct refusal, but it must be one of exactly these two.
  if (res.ok) return "dropping a person was accepted";
  if (res.code !== REFUSAL.APPEND_ONLY_VIOLATION && res.code !== REFUSAL.IDENTITY_FIELD_CHANGE) {
    return `expected an append-only or identity refusal, got ${res.code}`;
  }
  return true;
});

// ===========================================================================
// G · NO ROLE CHANGE — a promotion never rides in on an add-key diff.
// ===========================================================================

check("G/RED a role promotion riding on an add-key diff is refused", () => {
  const res = checkEdit((p) => {
    p.persons[PID_A].keys.push(APPENDED);
    p.persons[PID_A].role = "owner";
  });
  const v = refusedWith(res, REFUSAL.IDENTITY_FIELD_CHANGE);
  if (v !== true) return v;
  if (!/role/.test(res.message)) return "refusal does not name the changed field";
  if (!/owner-add/.test(res.message)) return "refusal does not route to the ceremony that DOES promote";
  return true;
});

check("G/RED a github_login rebind is refused", () => {
  const res = checkEdit((p) => {
    p.persons[PID_A].keys.push(APPENDED);
    p.persons[PID_A].github_login = "mallory";
  });
  return refusedWith(res, REFUSAL.IDENTITY_FIELD_CHANGE);
});

check("G/RED a host_role flip to ci is refused", () => {
  const res = checkEdit((p) => {
    p.persons[PID_A].keys.push(APPENDED);
    p.persons[PID_A].host_role = "ci";
  });
  return refusedWith(res, REFUSAL.IDENTITY_FIELD_CHANGE);
});

check("G/RED a display_id rewrite is refused", () => {
  const res = checkEdit((p) => {
    p.persons[PID_A].keys.push(APPENDED);
    p.persons[PID_A].display_id = "not-alpha";
  });
  return refusedWith(res, REFUSAL.IDENTITY_FIELD_CHANGE);
});

check("G/RED minting a NEW person_id on an add-key diff is refused", () => {
  const res = checkEdit((p) => {
    p.persons[PID_A].keys.push(APPENDED);
    p.persons["pid-sock-77777777"] = {
      display_id: "sock",
      role: "owner",
      github_login: "sock",
      host_role: "human",
      keys: [{ type: "ssh", fingerprint: otherKey.fingerprint, pubkey: otherKey.pubkey }],
    };
  });
  return refusedWith(res, REFUSAL.IDENTITY_FIELD_CHANGE);
});

check("G/RED editing the genesis trust root is refused", () => {
  const res = checkEdit((p) => {
    p.persons[PID_A].keys.push(APPENDED);
    p.genesis.repo_owner = "mallory";
  });
  return refusedWith(res, REFUSAL.IDENTITY_FIELD_CHANGE);
});

check("G/RED a schema-invalid post-image is refused", () => {
  const res = checkEdit((p) => {
    p.persons[PID_A].keys.push({ type: "ssh", fingerprint: newKey.fingerprint });
  });
  return refusedWith(res, REFUSAL.SCHEMA_INVALID);
});

check("G/GREEN an append that changes nothing else passes every predicate", () => {
  const res = checkEdit((p) => p.persons[PID_A].keys.push(APPENDED));
  return res.ok ? true : `refused: ${res.code} ${res.message}`;
});

// ===========================================================================
// H · THE REAL ROSTER'S SHAPE — read-only, in-memory post-image.
// ===========================================================================

check("H/the repo's REAL roster accepts an in-memory append (no write, no copy edited)", () => {
  const live = JSON.parse(fs.readFileSync(LIVE_ROSTER, "utf8"));
  const owner = Object.keys(live.persons).find((k) => live.persons[k].role === "owner");
  if (!owner) return "the live roster declares no owner — the fixture's premise is gone";
  const post = JSON.parse(JSON.stringify(live));
  post.persons[owner].keys.push(APPENDED);
  const a = ck.assertAppendOnlyKeys(live, post);
  if (!a.ok) return `append-only refused a pure append on the real roster: ${a.message}`;
  const b = ck.assertIdentityInvariant(live, post);
  if (!b.ok) return `identity invariant refused a pure append on the real roster: ${b.message}`;
  return true;
});

check("H/RED removing the real owner's existing key is refused on the real shape", () => {
  const live = JSON.parse(fs.readFileSync(LIVE_ROSTER, "utf8"));
  const owner = Object.keys(live.persons).find((k) => live.persons[k].role === "owner");
  if (!owner) return "the live roster declares no owner";
  const post = JSON.parse(JSON.stringify(live));
  post.persons[owner].keys = [APPENDED];
  return refusedWith(ck.assertAppendOnlyKeys(live, post), REFUSAL.APPEND_ONLY_VIOLATION);
});

check("H/the live roster is never opened for writing by this suite", () => {
  // The suite's whole write surface is SANDBOX. Assert the live file's mtime is
  // unchanged across the run rather than trusting that no case wrote it.
  return fs.statSync(LIVE_ROSTER).mtimeMs === LIVE_MTIME
    ? true
    : "the live roster's mtime changed during this run";
});

// ===========================================================================
// I · THE CLI ARM — exit codes and the refusal channel.
// ===========================================================================

function cli(args) {
  const r = spawnSync(process.execPath, [CEREMONY, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

check("I/CLI a refusal exits 1 and names the code on STDERR", () => {
  const rp = mkRoster();
  const r = cli([
    "--roster", rp,
    "--person-id", PID_B,
    "--new-key", newKey.pubPath,
    "--signing-key", alphaKey.priv,
    "--apply",
  ]);
  if (r.code !== 1) return `expected exit 1, got ${r.code}: ${r.err || r.out}`;
  return /REFUSED \[not-self-service\]/.test(r.err)
    ? true
    : `refusal channel did not carry the code: ${r.err.slice(0, 200)}`;
});

check("I/CLI a successful plan exits 0 and says nothing was written", () => {
  const rp = mkRoster();
  const before = fs.readFileSync(rp, "utf8");
  const r = cli([
    "--roster", rp,
    "--person-id", PID_A,
    "--new-key", newKey.pubPath,
    "--signing-key", alphaKey.priv,
  ]);
  if (r.code !== 0) return `expected exit 0, got ${r.code}: ${r.err}`;
  if (!/PLAN ONLY/.test(r.out)) return "plan mode did not say it wrote nothing";
  return fs.readFileSync(rp, "utf8") === before ? true : "plan mode wrote the roster";
});

check("I/CLI --apply exits 0 and writes exactly one appended key", () => {
  const rp = mkRoster();
  const r = cli([
    "--roster", rp,
    "--person-id", PID_A,
    "--new-key", newKey.pubPath,
    "--signing-key", alphaKey.priv,
    "--apply",
  ]);
  if (r.code !== 0) return `expected exit 0, got ${r.code}: ${r.err}`;
  const keys = readRoster(rp).persons[PID_A].keys;
  return keys.length === 2 ? true : `expected 2 keys on disk, found ${keys.length}`;
});

check("I/CLI missing required arguments exits 2 with usage, never a partial run", () => {
  const r = cli(["--person-id", PID_A]);
  if (r.code !== 2) return `expected exit 2, got ${r.code}`;
  return /--new-key/.test(r.err) ? true : "usage was not printed on the refusal channel";
});

check("I/CLI --check-against surfaces an append-only violation with exit 1", () => {
  const dir = path.join(SANDBOX, `cli-check-${++caseSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  const prePath = path.join(dir, "pre.json");
  const postPath = path.join(dir, "post.json");
  const pre = baseRoster();
  fs.writeFileSync(prePath, JSON.stringify(pre, null, 2));
  const post = JSON.parse(JSON.stringify(pre));
  post.persons[PID_A].keys = [APPENDED];
  fs.writeFileSync(postPath, JSON.stringify(post, null, 2));
  const r = cli(["--roster", prePath, "--check-against", postPath]);
  if (r.code !== 1) return `expected exit 1, got ${r.code}: ${r.out}`;
  return /REFUSED \[append-only-violation\]/.test(r.err) ? true : `wrong refusal: ${r.err.slice(0, 160)}`;
});

check("I/CLI --check-against accepts a clean append with exit 0", () => {
  const dir = path.join(SANDBOX, `cli-check-ok-${++caseSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  const prePath = path.join(dir, "pre.json");
  const postPath = path.join(dir, "post.json");
  const pre = baseRoster();
  fs.writeFileSync(prePath, JSON.stringify(pre, null, 2));
  const post = JSON.parse(JSON.stringify(pre));
  post.persons[PID_A].keys.push(APPENDED);
  fs.writeFileSync(postPath, JSON.stringify(post, null, 2));
  const r = cli(["--roster", prePath, "--check-against", postPath]);
  return r.code === 0 ? true : `expected exit 0, got ${r.code}: ${r.err}`;
});

console.log("");
console.log(`roster-add-key fixtures: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failing: ${failures.join(", ")}`);
  process.exit(1);
}
