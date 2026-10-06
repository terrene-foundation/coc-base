"use strict";
/**
 * add-key-ceremony — APPEND a signing key to an EXISTING roster person_id.
 *
 * WHY THIS EXISTS. `multi-operator-coordination.md` §1 states the identity model
 * as "one person_id → one human → role + enrolled KEYS", append-only, and
 * `operators.roster.schema.json` matches it (`persons.<pid>.keys` is an ARRAY,
 * documented "append-only list of signing keys for this person_id"). But no
 * shipped ceremony ever appended to that array. MEASURED before this file
 * existed: `/whoami` shipped `--register`, `--enroll-genesis`, `--owner-add`,
 * `--owner-depart`; `--register` MINTS A NEW person_id at `role: contributor`
 * and none of the four adds a key to an existing one. A described capability
 * with no producer is the class `artifact-stranding.md` MUST-3 names.
 *
 * The observable consequence on canon loom: the owner person_id held exactly one
 * key (gpg). Two ssh keys were enrolled against SEPARATE contributor person_ids
 * and a third against nothing, so the owner could not sign with ssh without
 * either signing AS a contributor or fragmenting their identity across two owner
 * person_ids. Both destroy the attribution primitive §1 designates.
 *
 * BEYOND CONVENIENCE. The Work Ledger roadmap binds `authority` to a signer
 * ROLE. Today `authority` is a self-declared caller field. Once the binding
 * lands, an owner signing with a contributor key cannot assert owner authority
 * over their own work — so this ceremony is the precondition for that binding
 * being SATISFIABLE at all, not a quality-of-life addition.
 *
 * WHAT THIS FILE IS NOT. It does not write `main`, and it does not attempt to.
 * `Edit(.claude/operators.roster.json)` sits in `settings.json::permissions.deny`
 * and branch protection rejects a direct roster push; the ceremony produces a
 * working-tree edit on a feature branch that becomes a PR, exactly as
 * `--register` does. `--apply` writes the WORKING TREE only.
 *
 * SINGLE DERIVATION. Fingerprints come from `operator-id.js::_fingerprintFromKey`
 * — the SAME resolver `resolveIdentity` uses to compute `verified_id`. A second
 * derivation that disagreed with the first would BE the defect: a key enrolled
 * under a fingerprint the resolver never produces is a key that never resolves.
 *
 * FAIL CLOSED ON EVERY UNKNOWN. Unreadable roster, unparseable key,
 * unresolvable fingerprint, absent person_id, unverifiable signer — each returns
 * a typed refusal and writes NOTHING. There is no partial-write path: the
 * post-image is built in memory, re-checked against the pre-image by the two
 * assertions below, schema-validated, and only then serialized.
 */

const path = require("path");

const { _fingerprintFromKey, _discoverSigningKey } = require("./operator-id.js");
const rosterSchema = require("./roster-schema-validate.js");
const cocSign = require("./coc-sign.js");
// THE single durable roster writer (tmp-in-same-dir -> rename, under an O_EXCL
// lock, with a compare-and-swap on the pre-image bytes). See its header for why
// the roster may not be written with a bare `writeFileSync`.
const { writeRosterAtomic, ROSTER_WRITE_CODES } = require("./roster-write.js");
// The hardened READ half, taken from the module `roster-write.js` already takes its
// hardened writer from. Neither roster read in this file is a state-dir path, and
// `readFileHardened` is not state-dir-bound — it takes an arbitrary path and owns the
// open(2) flag set (`O_RDONLY|O_NOFOLLOW|O_NONBLOCK` + an fstat regular-file check on
// the HELD fd), which is what `security.md` § "Multi-Site Kwarg Plumbing" requires be
// shared rather than re-derived. Both call sites below were plain `readFileSync`.
const { readFileHardened } = require("./state-io.js");

/** Roster path relative to a repo root. */
const ROSTER_REL = path.join(".claude", "operators.roster.json");

/**
 * Every refusal this ceremony can emit. Exported so a caller (and the fixture
 * suite) asserts a failure IDENTITY rather than "it refused somehow" — a
 * refusal test that only checks `ok === false` passes identically when the
 * ceremony refuses for the WRONG reason.
 */
const REFUSAL = {
  ROSTER_UNREADABLE: "roster-unreadable",
  ROSTER_MALFORMED: "roster-malformed",
  NEW_KEY_UNRESOLVABLE: "new-key-unresolvable",
  NEW_PUBKEY_UNREADABLE: "new-pubkey-unreadable",
  BAD_KEY_TYPE: "bad-key-type",
  SIGNER_UNRESOLVABLE: "signer-unresolvable",
  SIGNER_UNROSTERED: "signer-unrostered",
  UNKNOWN_PERSON: "unknown-person",
  NOT_SELF_SERVICE: "not-self-service",
  PROOF_OF_POSSESSION_FAILED: "proof-of-possession-failed",
  DUPLICATE_FINGERPRINT: "duplicate-fingerprint",
  APPEND_ONLY_VIOLATION: "append-only-violation",
  IDENTITY_FIELD_CHANGE: "identity-field-change",
  SCHEMA_INVALID: "schema-invalid",
  WRITE_FAILED: "write-failed",
  // Distinct from WRITE_FAILED on purpose: the write did not FAIL, it was
  // REFUSED because a concurrent writer changed the roster between this
  // ceremony's read and its write. A caller that collapses the two cannot tell
  // "disk problem, retry" from "someone else enrolled a key, re-read first".
  ROSTER_CHANGED_UNDER_US: "roster-changed-under-us",
};

/** The person fields this ceremony must leave BIT-IDENTICAL. */
const IDENTITY_FIELDS = [
  "display_id",
  "role",
  "github_login",
  "principal",
  "host_role",
  "business_roles",
];

function refuse(code, message, extra) {
  return Object.assign({ ok: false, code, message }, extra || {});
}

/** Structural equality over the JSON subset the roster is made of. */
function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * ASSERTION 1 — keys are APPEND-ONLY, per person, across the whole roster.
 *
 * This is deliberately a check on the POST-IMAGE, not a property claimed by the
 * construction that produced it. `runAddKeyCeremony` builds the post-image
 * itself and could in principle build it correctly forever; the point is that
 * this function is ALSO the public predicate a PR gate (or `--check-against`)
 * runs over a post-image it did NOT construct, where removal, replacement and
 * reordering are all live possibilities.
 *
 * Append-only means, for every person present in BOTH images: the pre-image key
 * list is a PREFIX of the post-image key list, element-for-element. That single
 * predicate rejects removal (post shorter), replacement (prefix mismatch) and
 * reordering (prefix mismatch) at once — a set-comparison would accept a
 * reorder, and a length-comparison would accept a replacement.
 *
 * Dropping a person entirely is also a removal of their keys, so it refuses
 * here too.
 */
function assertAppendOnlyKeys(pre, post) {
  const prePersons = (pre && pre.persons) || {};
  const postPersons = (post && post.persons) || {};
  for (const pid of Object.keys(prePersons)) {
    if (!Object.prototype.hasOwnProperty.call(postPersons, pid)) {
      return refuse(
        REFUSAL.APPEND_ONLY_VIOLATION,
        `person_id '${pid}' present before the edit and absent after it — this ceremony may only ADD`,
      );
    }
    const before = (prePersons[pid] && prePersons[pid].keys) || [];
    const after = (postPersons[pid] && postPersons[pid].keys) || [];
    if (after.length < before.length) {
      return refuse(
        REFUSAL.APPEND_ONLY_VIOLATION,
        `person_id '${pid}': key count fell ${before.length} → ${after.length}; keys are append-only`,
      );
    }
    for (let i = 0; i < before.length; i++) {
      if (!jsonEqual(before[i], after[i])) {
        return refuse(
          REFUSAL.APPEND_ONLY_VIOLATION,
          `person_id '${pid}': existing key at index ${i} was replaced or reordered; keys are append-only`,
        );
      }
    }
  }
  return { ok: true };
}

/**
 * ASSERTION 2 — adding a key changes NOTHING else about who anyone is.
 *
 * Role promotion is `--owner-add`'s job behind a 2-of-N quorum gate; a
 * `github_login` / `principal` rebind is an identity swap; a `person_id` set
 * change is a registration. None of the three is an add-key, and each of them
 * riding IN on an add-key PR is exactly how a quorum gate gets bypassed by a
 * diff nobody reads closely.
 */
function assertIdentityInvariant(pre, post) {
  const prePersons = (pre && pre.persons) || {};
  const postPersons = (post && post.persons) || {};
  const preIds = Object.keys(prePersons).sort();
  const postIds = Object.keys(postPersons).sort();
  if (!jsonEqual(preIds, postIds)) {
    return refuse(
      REFUSAL.IDENTITY_FIELD_CHANGE,
      `the person_id set changed (${preIds.length} → ${postIds.length}); adding a key never mints or drops a person_id`,
    );
  }
  for (const pid of preIds) {
    for (const field of IDENTITY_FIELDS) {
      const a = prePersons[pid] ? prePersons[pid][field] : undefined;
      const b = postPersons[pid] ? postPersons[pid][field] : undefined;
      if (!jsonEqual(a, b)) {
        return refuse(
          REFUSAL.IDENTITY_FIELD_CHANGE,
          `person_id '${pid}': '${field}' changed ${JSON.stringify(a)} → ${JSON.stringify(b)}; adding a key never changes it` +
            (field === "role"
              ? " (role promotion is /whoami --owner-add, a separate quorum gate)"
              : ""),
        );
      }
    }
  }
  // The genesis block is the trust root; an add-key never touches it.
  if (!jsonEqual(pre && pre.genesis, post && post.genesis)) {
    return refuse(
      REFUSAL.IDENTITY_FIELD_CHANGE,
      "the genesis trust-root block changed; adding a key never touches it",
    );
  }
  return { ok: true };
}

/** Locate the fingerprint's holder anywhere in the roster, or null. */
// S61 — DELIBERATELY UNFENCED. Do NOT apply the `Array.isArray` shape guard
// used at the fold resolvers: at the :402 call site (the roster-wide DUPLICATE
// fingerprint check) `if (holder) return refuse(...)`, so NOT-FOUND is the
// PERMIT path and the search must be EXHAUSTIVE to be sound. Skipping a
// malformed person would admit a fingerprint already enrolled under it —
// ":399-401" states the stake. Letting it THROW aborts the ceremony, which is
// fail-closed. Note the OTHER caller at :435 has the OPPOSITE polarity, so no
// single fence inside this function can be correct for both.
function findKeyHolder(roster, fingerprint) {
  const persons = (roster && roster.persons) || {};
  for (const pid of Object.keys(persons)) {
    const keys = (persons[pid] && persons[pid].keys) || [];
    for (const k of keys) {
      if (k && k.fingerprint === fingerprint) return { pid, key: k };
    }
  }
  return null;
}

/** Read + parse the roster. Every failure mode is distinct and fails closed. */
function loadRoster(rosterPath) {
  // Through `state-io.js::readFileHardened` (implemented by `state-io.js::_readFileHardened`), the same open(2)
  // flag set `roster-write.js::readRosterBytes` uses for this very file. The previous
  // plain `readFileSync` had a failure mode the surrounding try/catch could not reach:
  // a FIFO planted at `rosterPath` does not THROW, it BLOCKS FOREVER in open(2) waiting
  // for a writer, so the ceremony wedged instead of refusing. `O_NOFOLLOW` does not
  // close that — `O_NONBLOCK` plus a regular-file `fstat` on the HELD descriptor does.
  // ENOENT/EACCES keep their meaning: they arrive here as `ok:false` and take the SAME
  // ROSTER_UNREADABLE refusal they took as a throw.
  const preimage = readFileHardened(rosterPath);
  if (!preimage.ok) {
    return refuse(
      REFUSAL.ROSTER_UNREADABLE,
      `cannot read roster at ${rosterPath}: ${preimage.reason}`,
    );
  }
  // `.toString("utf8")` reproduces byte-for-byte what `readFileSync(p, "utf8")` returned,
  // which matters below: `raw` is compared with `!==` against the writer's own pre-image
  // read, so a lossy decode would turn every CAS into a mismatch.
  const raw = preimage.value.toString("utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return refuse(
      REFUSAL.ROSTER_MALFORMED,
      `roster at ${rosterPath} is not parseable JSON: ${err && err.message}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || !parsed.persons || typeof parsed.persons !== "object") {
    return refuse(
      REFUSAL.ROSTER_MALFORMED,
      `roster at ${rosterPath} has no persons object`,
    );
  }
  // `raw` is the compare-and-swap PRE-IMAGE. It is the exact bytes this process
  // parsed, so the write can prove nothing changed underneath it. Additive:
  // existing callers destructure `.roster` and are unaffected.
  return { ok: true, roster: parsed, raw };
}

/**
 * Read the armored public-key body that goes into the roster entry.
 *
 * SSH: default to the `.pub` sibling of the given key path (the same
 * `<path>` / `<path>.pub` candidate order `_fingerprintFromKey` uses, so the
 * fingerprint and the stored pubkey are derived from the SAME file).
 * GPG: there is no on-disk armored file to infer, so an explicit
 * `pubkeyPath` is REQUIRED — inventing one by shelling out to an ambient
 * keyring would make the stored pubkey depend on which keyring answered.
 */
function readPubkeyBody(keyPath, keyType, pubkeyPath) {
  const candidates = [];
  if (pubkeyPath) candidates.push(pubkeyPath);
  else if (keyType === "ssh") {
    if (keyPath.endsWith(".pub")) candidates.push(keyPath);
    else candidates.push(`${keyPath}.pub`);
  }
  if (candidates.length === 0) {
    return refuse(
      REFUSAL.NEW_PUBKEY_UNREADABLE,
      `keyType 'gpg' requires an explicit --new-pubkey (armored export: gpg --armor --export <fingerprint>)`,
    );
  }
  for (const c of candidates) {
    // Same hardened read as `loadRoster` above, for the same reason: these candidates
    // are paths the CALLER named, so they sit in the plantable position the roster does,
    // and the `catch {}` this replaces could not reach a blocking open(2) — a FIFO at
    // `<keyPath>.pub` wedged the ceremony instead of falling through to the next
    // candidate. An irregular entry (FIFO, symlink, directory, device) is now SKIPPED
    // rather than read through or hung on; if no candidate yields a body the refusal
    // below fires, so the case is loud at the boundary and never a silent empty read.
    const r = readFileHardened(c);
    if (!r.ok) continue;
    const body = r.value.toString("utf8").trim();
    if (body) return { ok: true, pubkey: body, source: c };
  }
  return refuse(
    REFUSAL.NEW_PUBKEY_UNREADABLE,
    `cannot read a public-key body from: ${candidates.join(", ")}`,
  );
}

/**
 * PROOF OF POSSESSION. Self-service means the caller PROVES they already hold a
 * key enrolled under the target person_id — not merely that they can name one.
 * Naming is free: the roster is a committed file, so every enrolled fingerprint
 * is public to anyone with a clone. So the request is canonical-serialized and
 * SIGNED with the caller's signing key, then verified against the PUBKEY THE
 * ROSTER ALREADY STORES for that fingerprint. A caller who can read the roster
 * but cannot sign fails here.
 *
 * The signed request binds the target person_id and the new fingerprint, so a
 * signature captured for one add-key cannot be replayed to authorize a
 * different one.
 */
function proveSelfService(request, signerKeyPath, signerKeyType, enrolledKey) {
  let payload;
  try {
    payload = cocSign.canonicalSerialize(request);
  } catch (err) {
    return refuse(
      REFUSAL.PROOF_OF_POSSESSION_FAILED,
      `cannot canonical-serialize the add-key request: ${err && err.message}`,
    );
  }
  const signed = cocSign.sign(payload, {
    keyPath: signerKeyPath,
    keyType: signerKeyType,
  });
  if (!signed || !signed.ok || !signed.sig) {
    return refuse(
      REFUSAL.PROOF_OF_POSSESSION_FAILED,
      `could not sign the add-key request with ${signerKeyPath}: ${(signed && (signed.reason || signed.error)) || "unknown signing failure"}`,
    );
  }
  const verified = cocSign.verify(payload, signed.sig, enrolledKey.pubkey, {
    keyType: enrolledKey.type,
  });
  // MEASURED, not assumed: coc-sign.verify returns `{ok: true, valid: false}`
  // for a signature that does NOT verify — `ok` reports that the CHECK RAN, and
  // `valid` reports the VERDICT. Reading `ok` alone is a non-discriminating
  // instrument: it returns the same truthy value whether the signature is good
  // or forged, so it would admit a mismatched key. The verdict field is
  // `valid`, and it is required to be strictly true.
  if (!verified || !verified.ok || verified.valid !== true) {
    return refuse(
      REFUSAL.PROOF_OF_POSSESSION_FAILED,
      `the request signature did not verify against the enrolled pubkey for ${enrolledKey.fingerprint}: ${(verified && (verified.reason || verified.error)) || "unknown verify failure"}`,
    );
  }
  return { ok: true, sig: signed.sig };
}

/**
 * The ceremony.
 *
 * @param {object} opts
 * @param {string} opts.repoDir            repo root (roster resolved under it unless rosterPath given)
 * @param {string} [opts.rosterPath]       explicit roster path (tests operate on COPIES)
 * @param {string} opts.personId           the EXISTING person_id gaining a key
 * @param {string} opts.newKeyPath         path to the new key (pub or private)
 * @param {string} [opts.newKeyType]       "ssh" (default) | "gpg"
 * @param {string} [opts.newPubkeyPath]    explicit armored pubkey file (REQUIRED for gpg)
 * @param {string} [opts.signingKeyPath]   caller's already-enrolled key; default = git config user.signingkey
 * @param {string} [opts.signingKeyType]   "ssh" | "gpg"; default inferred by _discoverSigningKey
 * @param {boolean} [opts.apply]           false (default) = plan only, write nothing
 * @returns {{ok: true, ...}|{ok: false, code: string, message: string}}
 */
function runAddKeyCeremony(opts) {
  const o = opts || {};
  const repoDir = o.repoDir || process.cwd();
  const rosterPath = o.rosterPath || path.join(repoDir, ROSTER_REL);

  const newKeyType = o.newKeyType || "ssh";
  if (newKeyType !== "ssh" && newKeyType !== "gpg") {
    return refuse(
      REFUSAL.BAD_KEY_TYPE,
      `unsupported key type '${newKeyType}' (allowed: ssh, gpg)`,
    );
  }
  if (!o.personId || typeof o.personId !== "string") {
    return refuse(REFUSAL.UNKNOWN_PERSON, "no --person-id given");
  }
  if (!o.newKeyPath || typeof o.newKeyPath !== "string") {
    return refuse(REFUSAL.NEW_KEY_UNRESOLVABLE, "no --new-key given");
  }

  // (1) Roster — fail closed on unreadable / malformed.
  const loaded = loadRoster(rosterPath);
  if (!loaded.ok) return loaded;
  const pre = loaded.roster;

  // (2) The person must already exist. This ceremony never mints one.
  if (!Object.prototype.hasOwnProperty.call(pre.persons, o.personId)) {
    return refuse(
      REFUSAL.UNKNOWN_PERSON,
      `person_id '${o.personId}' is not in the roster; registering a NEW person_id is /whoami --register`,
    );
  }
  const target = pre.persons[o.personId];

  // (3) New key → fingerprint, through the SAME resolver resolveIdentity uses.
  const newFingerprint = _fingerprintFromKey(o.newKeyPath, newKeyType);
  // The gpg arm of _fingerprintFromKey falls back to the VERBATIM identifier
  // when no resolver can normalize it. A verbatim non-40-hex id would be
  // enrolled as a fingerprint that never matches at resolution time, so the
  // schema's uppercase-40-hex constraint is asserted HERE rather than being
  // discovered later as a silent L2 fallback.
  if (!newFingerprint) {
    return refuse(
      REFUSAL.NEW_KEY_UNRESOLVABLE,
      `could not derive a fingerprint from ${o.newKeyPath} (type ${newKeyType})`,
    );
  }
  if (newKeyType === "gpg" && !/^[0-9A-F]{40}$/.test(newFingerprint)) {
    return refuse(
      REFUSAL.NEW_KEY_UNRESOLVABLE,
      `gpg fingerprint '${newFingerprint}' is not the canonical uppercase 40-hex form the roster schema requires`,
    );
  }
  if (newKeyType === "ssh" && !newFingerprint.startsWith("SHA256:")) {
    return refuse(
      REFUSAL.NEW_KEY_UNRESOLVABLE,
      `ssh fingerprint '${newFingerprint}' is not the canonical SHA256: form`,
    );
  }

  // (4) The armored pubkey body that will be stored.
  const pub = readPubkeyBody(o.newKeyPath, newKeyType, o.newPubkeyPath);
  if (!pub.ok) return pub;

  // (5) Duplicate refusal, roster-wide. One fingerprint under two person_ids
  //     breaks attribution outright: _findPersonByFingerprint returns the FIRST
  //     match, so the resolved identity would depend on key insertion order.
  const holder = findKeyHolder(pre, newFingerprint);
  if (holder) {
    return refuse(
      REFUSAL.DUPLICATE_FINGERPRINT,
      holder.pid === o.personId
        ? `fingerprint ${newFingerprint} is ALREADY enrolled under '${o.personId}' — nothing to add`
        : `fingerprint ${newFingerprint} is already enrolled under a DIFFERENT person_id '${holder.pid}'; one key never binds two identities`,
      { holder_person_id: holder.pid },
    );
  }

  // (6) Who is asking, and are they that person?
  let signerKeyPath = o.signingKeyPath;
  let signerKeyType = o.signingKeyType;
  if (!signerKeyPath) {
    const discovered = _discoverSigningKey(repoDir, {});
    signerKeyPath = discovered.keyPath;
    signerKeyType = signerKeyType || discovered.keyType;
  }
  signerKeyType = signerKeyType || "ssh";
  if (!signerKeyPath) {
    return refuse(
      REFUSAL.SIGNER_UNRESOLVABLE,
      "no signing key configured (git config user.signingkey) and no --signing-key given; self-service add-key must be signed",
    );
  }
  const signerFingerprint = _fingerprintFromKey(signerKeyPath, signerKeyType);
  if (!signerFingerprint) {
    return refuse(
      REFUSAL.SIGNER_UNRESOLVABLE,
      `could not derive a fingerprint from the signing key ${signerKeyPath} (type ${signerKeyType})`,
    );
  }
  const signerHolder = findKeyHolder(pre, signerFingerprint);
  if (!signerHolder) {
    return refuse(
      REFUSAL.SIGNER_UNROSTERED,
      `the signing key ${signerFingerprint} is not enrolled under any person_id; enroll via /whoami --register first`,
    );
  }
  if (signerHolder.pid !== o.personId) {
    return refuse(
      REFUSAL.NOT_SELF_SERVICE,
      `the signing key ${signerFingerprint} belongs to '${signerHolder.pid}', not '${o.personId}'. ` +
        `Adding a key to SOMEONE ELSE's person_id is a quorum-gated roster edit, not a self-service ceremony — REFUSED here rather than half-implemented.`,
      { signer_person_id: signerHolder.pid },
    );
  }

  // (7) Prove possession of the enrolled key, not merely knowledge of it.
  const request = {
    type: "roster-add-key",
    person_id: o.personId,
    new_fingerprint: newFingerprint,
    new_key_type: newKeyType,
    signer_fingerprint: signerFingerprint,
  };
  const proof = proveSelfService(
    request,
    signerKeyPath,
    signerKeyType,
    signerHolder.key,
  );
  if (!proof.ok) return proof;

  // (8) Build the post-image: a pure APPEND to this one person's key list.
  const post = JSON.parse(JSON.stringify(pre));
  post.persons[o.personId].keys = [
    // S61 — `target.keys` is spread unguarded, and that is SAFE BY
    // UNREACHABILITY (not, as an earlier note claimed, by prior shape
    // validation — there is none before this point). A truthy non-array
    // `keys` throws earlier at `findKeyHolder` (:196 via :402); a falsy one
    // yields `|| []` there, so the signer cannot resolve and the ceremony
    // refuses at :436/:442; a string spreads to characters and is caught by
    // `rosterSchema.validate(post)` before any write. No shape reaches here.
    ...target.keys,
    { type: newKeyType, fingerprint: newFingerprint, pubkey: pub.pubkey },
  ];

  // (9) Re-check the post-image against the pre-image with the SAME public
  //     predicates a PR gate would run. Constructing correctly and VERIFYING
  //     the construction are different acts; only the second one is evidence.
  const appendOnly = assertAppendOnlyKeys(pre, post);
  if (!appendOnly.ok) return appendOnly;
  const identity = assertIdentityInvariant(pre, post);
  if (!identity.ok) return identity;

  // (10) Schema. valid:false is a hard stop — never a warning.
  const validation = rosterSchema.validate(post);
  if (!validation.valid) {
    return refuse(
      REFUSAL.SCHEMA_INVALID,
      `post-edit roster failed schema validation: ${JSON.stringify(validation.errors)}`,
    );
  }

  const result = {
    ok: true,
    person_id: o.personId,
    added: { type: newKeyType, fingerprint: newFingerprint },
    signer_fingerprint: signerFingerprint,
    keys_before: target.keys.length,
    keys_after: post.persons[o.personId].keys.length,
    roster_path: rosterPath,
    applied: false,
    roster: post,
  };

  if (!o.apply) return result;

  // The post-image is written through the SHARED atomic roster writer, never a
  // bare `writeFileSync`. Two failure modes are closed here and neither is
  // hypothetical for a file every signature check resolves against:
  //   (A) a crash mid-write left a TRUNCATED roster, which every loader fails
  //       closed on, wedging integrity-critical writes repo-wide;
  //   (B) a concurrent enrollment's read-modify-write silently discarded this
  //       ceremony's appended key while reporting success.
  // `loaded.raw` is the pre-image THIS ceremony read at step (1); the writer
  // refuses if the on-disk bytes have moved since.
  const written = writeRosterAtomic({
    rosterPath,
    roster: post,
    expectBytes: loaded.raw,
  });
  if (!written.ok) {
    return refuse(
      written.code === ROSTER_WRITE_CODES.CAS_MISMATCH
        ? REFUSAL.ROSTER_CHANGED_UNDER_US
        : REFUSAL.WRITE_FAILED,
      `post-image validated but was NOT written to ${rosterPath}: ${written.reason}`,
    );
  }
  result.applied = true;
  return result;
}

/**
 * `--check-against <candidate.json>`: run the two public assertions over a
 * post-image this process did NOT construct. This is the reviewable form — the
 * one a PR gate can run over a proposed `operators.roster.json` diff — and it is
 * why the assertions are predicates over two images rather than invariants
 * asserted by the builder.
 */
function checkRosterEdit(prePath, postPath) {
  const a = loadRoster(prePath);
  if (!a.ok) return a;
  const b = loadRoster(postPath);
  if (!b.ok) return b;
  const appendOnly = assertAppendOnlyKeys(a.roster, b.roster);
  if (!appendOnly.ok) return appendOnly;
  const identity = assertIdentityInvariant(a.roster, b.roster);
  if (!identity.ok) return identity;
  const validation = rosterSchema.validate(b.roster);
  if (!validation.valid) {
    return refuse(
      REFUSAL.SCHEMA_INVALID,
      `candidate roster failed schema validation: ${JSON.stringify(validation.errors)}`,
    );
  }
  return { ok: true, checked: postPath };
}

// ---------------------------------------------------------------------------
// CLI arm. Invoked BY ITS OWN PATH as a separate command, which is the shape
// `validate-bash-command.js::detectStateFileMutationSegmentAware` sanctions for
// a canonical state-file writer: the protected path lives inside the script
// body, never on the run command line.
// ---------------------------------------------------------------------------

function parseArgv(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

const USAGE = `/whoami --add-key — append a signing key to an EXISTING person_id

  node .claude/hooks/lib/add-key-ceremony.js \\
    --person-id <pid> --new-key <path> [--new-key-type ssh|gpg] \\
    [--new-pubkey <armored-file>] [--signing-key <path>] [--roster <path>] [--apply]

  node .claude/hooks/lib/add-key-ceremony.js --check-against <candidate.json> [--roster <path>]

Without --apply nothing is written: the plan is printed and the process exits 0.
Adding a key to someone ELSE's person_id is REFUSED (quorum-gated, not self-service).
Never run on main — cut a codify/ branch first; the roster lands via PR.`;

function main(argv) {
  const args = parseArgv(argv);
  if (args.help || args.h) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  const repoDir = args["repo-dir"] || process.cwd();
  const rosterPath = args.roster || path.join(repoDir, ROSTER_REL);

  let res;
  if (args["check-against"]) {
    res = checkRosterEdit(rosterPath, args["check-against"]);
  } else if (!args["person-id"] || !args["new-key"]) {
    process.stderr.write(USAGE + "\n");
    return 2;
  } else {
    res = runAddKeyCeremony({
      repoDir,
      rosterPath,
      personId: args["person-id"],
      newKeyPath: args["new-key"],
      newKeyType: args["new-key-type"],
      newPubkeyPath: args["new-pubkey"],
      signingKeyPath: args["signing-key"],
      signingKeyType: args["signing-key-type"],
      apply: Boolean(args.apply),
    });
  }

  if (!res.ok) {
    process.stderr.write(`REFUSED [${res.code}] ${res.message}\n`);
    return 1;
  }
  // Never print the roster body: it is large and already on disk.
  const { roster, ...summary } = res;
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  if (summary.applied) {
    process.stdout.write(
      `\nWrote ${summary.roster_path}. Next: git add ${ROSTER_REL} && git commit && git push && gh pr create.\n`,
    );
  } else if (summary.person_id) {
    process.stdout.write("\nPLAN ONLY — nothing written. Re-run with --apply.\n");
  }
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  runAddKeyCeremony,
  checkRosterEdit,
  assertAppendOnlyKeys,
  assertIdentityInvariant,
  findKeyHolder,
  loadRoster,
  REFUSAL,
  IDENTITY_FIELDS,
  ROSTER_REL,
  _main: main,
};
