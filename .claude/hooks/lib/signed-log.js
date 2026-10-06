/**
 * signed-log — the SHARED envelope contract for committed append-only signed logs.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 *
 * `coordination-log.js` already implements the full model: per-emitter `seq` +1,
 * `prev_hash` chaining, and cryptographic fork detection on `(verified_id, seq)` with
 * differing content hashes. `burndown-events.js` then built a SECOND, weaker signed
 * log beside it — re-implementing a fraction of that model and getting the fraction
 * wrong. Three defects followed from the one cause, and all three are envelope
 * defects, not burndown defects:
 *
 *   D1  a record did not declare its signature suite, and `coc-sign::verify` DEFAULTS
 *       to `keyType: "ssh"` (`const keyType = o.keyType || "ssh"`). Every committed
 *       burndown record is openpgp, so the first verifying gate to exist would have
 *       defaulted to ssh and rejected the entire log.
 *   D2  append-only was PRODUCER DISCIPLINE, not a gate invariant — zero `sig` reads
 *       and zero verify calls on the fold path, and no chain at all, so deleting or
 *       reordering a middle record was undetectable even WITH full per-record
 *       signature verification.
 *   D3  the log held two contradictory roles: it is `manifest.tracker.path`, and the
 *       tracker is held to `assertCommittedAndUnmodified`, so a `PostToolUse` producer
 *       took `--check-links` UNRUNNABLE from its FIRST append.
 *
 * D2 and D3 are ONE mechanism read two ways: verify the COMMITTED PREFIX and PERMIT
 * uncommitted appends beyond it. That is why this is one module and not three fixes.
 *
 * ── WHAT IS SHARED, AND WHAT IS NOT (stated, not implied) ────────────────────
 *
 * SHARED here: the suite vocabulary + declaration policy (§1), the append-only
 * prefix-preservation predicate (§2), the canonical record hash + per-emitter chain
 * (§3), and the suite-directed verify wrapper (§4). These are the four things both
 * logs need and neither should own privately.
 *
 * NOT shared yet: `coordination-log.js` has NOT been migrated onto §1/§3 — its chain
 * and fork detection remain its own code. That migration is a separate shard and is
 * named here rather than implied away. What this module guarantees TODAY is that the
 * burndown log is not a third divergent copy: it is a CONSUMER of this contract, and
 * the contract is shaped so `coordination-log.js` can become the second consumer
 * without changing its record shape (`seq`/`prev_hash`/fork-on-`(verified_id, seq)`
 * are deliberately its field names and its semantics, not new ones).
 *
 * ── FAIL CLOSED, EVERYWHERE ──────────────────────────────────────────────────
 *
 * Every function here returns a TYPED refusal (`zero-tolerance.md` Rule 3) and never
 * falls back to a default. An absent, unrecognised or malformed suite declaration
 * REFUSES. That is the whole point of D1: the defect was a DEFAULT, so no function in
 * this file may supply one.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const {
  canonicalSerialize,
  verify: cocVerify,
  // The SHARED verify-homedir lifecycle. §5 batches every record of a log through ONE
  // homedir; the per-call alternative was MEASURED at 679 ms/record against 0.08 ms
  // here, which is the difference between a gate that runs and a gate that gets
  // switched off. See §5.
  createVerifyHomedir,
  destroyVerifyHomedir,
} = require(path.join(__dirname, "coc-sign.js"));
const { resolveGitBinary, gitEnvForArgs } = require(path.join(__dirname, "git-subprocess-env.js"));

function bad(error, reason, extra) {
  return Object.assign({ ok: false, error, reason }, extra || {});
}

// ═══ §1  THE SUITE VOCABULARY AND THE DECLARATION POLICY ════════════════════

/**
 * The CLOSED signature-suite vocabulary.
 *
 * The key is the value that appears in a record's `sig_alg` and in a manifest's
 * declaration; it names the CRYPTOGRAPHIC SUITE, not `coc-sign`'s internal keyType.
 * That separation is deliberate: `coc-sign` calls the OpenPGP path `"gpg"` after the
 * BINARY it shells to, and a record that declared `"gpg"` would be pinning an
 * implementation rather than a suite. `openpgp` is what the bytes actually are.
 *
 * ADO NOTE, because it is the constraint most likely to be mis-read: the ADO adapter
 * records that commit-signature verification is unavailable on ADO — the host exposes
 * no signature-verification API. That constrains WHERE verification happens (it must
 * be in-process, which it already is for BOTH suites), and it does NOT constrain the
 * key format. Neither suite below is excluded by ADO.
 *
 * ── WHY `ssh-rsa` IS HERE, AND WHY IT IS A SEPARATE SUITE ────────────────────
 *
 * `ssh-ed25519` was the ONLY ssh entry, and `keyType: "ssh"` was treated as though it
 * determined it. It does not. `coc-sign`'s keyType names the TOOL (`ssh-keygen -Y`
 * versus `gpg`); the SSHSIG bytes it produces carry whichever algorithm the key is.
 * The owner's ledger signing key, ratified and enrolled by loom#1929, is `ssh-rsa`
 * (MEASURED: `ssh-keygen -lf ~/.ssh/<key>.pub` → `2048 SHA256:<prefix>… (RSA)`,
 * pubkey first field `ssh-rsa`). Stamping `sig_alg: "ssh-ed25519"` on those bytes is
 * exactly the record "whose declared sig_alg is a lie about its own bytes" that
 * `decideAppendSuite` below exists to refuse — so the vocabulary gains the suite that
 * is TRUE rather than the fence gaining an exception.
 *
 * The asymmetry with `openpgp` is deliberate and is NOT an inconsistency to be tidied.
 * An OpenPGP signature packet SELF-DESCRIBES its public-key algorithm and gpg reads it
 * out of the packet, so `openpgp` names everything a verifier needs. SSHSIG likewise
 * self-describes, but this repo ALSO carries an in-process fast path
 * (`coc-sign.js`, loom s49 P5) that is hard-wired to ed25519 and returns `null` for
 * anything else — so the ssh algorithm changes which verification path runs, and the
 * declaration is the only place that fact is legible before the bytes are read.
 */
const SUITES = Object.freeze({
  openpgp: Object.freeze({ keyType: "gpg", keyAlgorithms: Object.freeze([]) }),
  "ssh-ed25519": Object.freeze({ keyType: "ssh", keyAlgorithms: Object.freeze(["ssh-ed25519"]) }),
  "ssh-rsa": Object.freeze({
    keyType: "ssh",
    keyAlgorithms: Object.freeze(["ssh-rsa", "rsa-sha2-256", "rsa-sha2-512"]),
  }),
});

const SUITE_NAMES = Object.freeze(Object.keys(SUITES));

/**
 * keyType → the suites that share it. Built once so the two cannot drift.
 *
 * An ARRAY, not a scalar, and that is the whole point of the shape change. The prior
 * `Object.fromEntries` inverse silently kept the LAST suite per keyType, so the moment
 * a second ssh suite existed, `suiteForKeyType("ssh")` would have answered with one of
 * them and no caller could have told it had guessed. A lossy inverse of a security
 * vocabulary is the D1 defect in miniature — a default wearing the grammar of a lookup.
 */
const SUITES_FOR_KEYTYPE = Object.freeze(
  Object.entries(SUITES).reduce((acc, [s, d]) => {
    (acc[d.keyType] || (acc[d.keyType] = [])).push(s);
    return acc;
  }, Object.create(null)),
);

/**
 * ssh public-key algorithm token → suite. Built from `SUITES` so the two cannot drift.
 */
const SUITE_FOR_KEY_ALGORITHM = Object.freeze(
  Object.entries(SUITES).reduce((acc, [s, d]) => {
    for (const a of d.keyAlgorithms) acc[a] = s;
    return acc;
  }, Object.create(null)),
);

function isSuite(name) {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(SUITES, name);
}

/**
 * suite name → `coc-sign` keyType. REFUSES an unrecognised name; never defaults.
 *
 * This function is the single place the D1 default is denied. `coc-sign::verify` will
 * happily read `o.keyType || "ssh"`; every caller in this codebase that touches a
 * signed-log record must obtain its keyType HERE instead, so an absent declaration
 * becomes a refusal rather than a silent ssh assumption.
 */
function keyTypeForSuite(name) {
  if (!isSuite(name)) {
    return bad(
      "unknown signature suite",
      `signature suite ${JSON.stringify(name)} is not one of ${SUITE_NAMES.join(", ")}. ` +
        `An unrecognised suite is REFUSED rather than defaulted: coc-sign::verify falls back to ` +
        `keyType 'ssh' when told nothing, and defaulting here would reject an entire openpgp log ` +
        `while reporting a signature failure.`,
    );
  }
  return { ok: true, keyType: SUITES[name].keyType };
}

/**
 * `coc-sign` keyType → suite name. REFUSES an unrecognised keyType, and REFUSES an
 * AMBIGUOUS one rather than picking.
 *
 * A keyType that maps to more than one suite carries strictly less information than
 * the answer requires, and there is no safe pick: choosing either one stamps a
 * `sig_alg` the bytes may contradict. `suiteForSigningKey` below is the resolver that
 * CAN answer, because it reads the key.
 */
function suiteForKeyType(keyType) {
  const candidates = SUITES_FOR_KEYTYPE[keyType];
  if (!candidates || candidates.length === 0) {
    return bad(
      "unknown key type",
      `key type ${JSON.stringify(keyType)} maps to no declared signature suite ` +
        `(known key types: ${Object.keys(SUITES_FOR_KEYTYPE).join(", ")})`,
    );
  }
  if (candidates.length > 1) {
    return bad(
      "ambiguous key type",
      `key type ${JSON.stringify(keyType)} maps to ${candidates.length} declared suites ` +
        `(${candidates.join(", ")}), so it does not determine one. The key ITSELF does: supply ` +
        `the key path so 'suiteForSigningKey' can read its algorithm. Picking one here would ` +
        `stamp a sig_alg the signature bytes can contradict.`,
    );
  }
  return { ok: true, suite: candidates[0] };
}

/** PEM-armoured private key material — never an algorithm token. */
const _PRIVATE_KEY_ARMOR = /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----$/;

/**
 * The ssh public-key algorithm token, read from an OpenSSH public-key line.
 *
 * Returns `{ private: true }` for PEM-armoured PRIVATE key material rather than the
 * armor line's first word. `git config user.signingkey` legitimately points at either
 * half of the pair — `.pub` in this repo's own configuration, the private path in
 * every generated sandbox — and reading `-----BEGIN` as an algorithm would refuse the
 * private-key case with a message naming a token that is not a token.
 */
function _sshKeyAlgorithm(text) {
  const first = String(text == null ? "" : text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  if (!first) return null;
  if (_PRIVATE_KEY_ARMOR.test(first)) return { private: true };
  const tok = first.split(/\s+/)[0];
  return tok || null;
}

/**
 * The SIGNING KEY → suite resolver. This is the one that can answer honestly.
 *
 * `keyType` alone is `coc-sign`'s tool selector and does not determine the suite once
 * a keyType carries more than one (see `suiteForKeyType`). This reads the key material
 * and maps its declared algorithm. Every failure is TYPED and nothing defaults: an
 * unreadable key, an unparseable key line, or an algorithm outside the vocabulary each
 * REFUSE, because the alternative is stamping a suite nobody established.
 *
 * `gpg` keys are exempt from the file read and stay resolved by keyType — `keyPath` on
 * that path is a key IDENTIFIER (email/fingerprint) rather than a file, as
 * `coc-sign.js` documents, and `openpgp` is the only openpgp suite, so keyType already
 * determines it without ambiguity.
 *
 * @param {{keyType?:string, keyPath?:string}} signOpts
 * @param {{readFile?:function}} [opts]  injectable read so a fixture drives every branch
 */
function suiteForSigningKey(signOpts, opts) {
  const o = opts || {};
  const keyType = signOpts && signOpts.keyType;
  const byType = suiteForKeyType(keyType);
  if (byType.ok) return byType;
  if (byType.error !== "ambiguous key type") return byType;

  const keyPath = signOpts && signOpts.keyPath;
  if (typeof keyPath !== "string" || !keyPath) {
    return bad(
      "signing key unresolvable",
      `key type ${JSON.stringify(keyType)} maps to more than one suite and no 'keyPath' was supplied, ` +
        `so the key's algorithm cannot be read. An unresolvable suite REFUSES; it never defaults.`,
    );
  }
  const readFile = typeof o.readFile === "function" ? o.readFile : (p) => fs.readFileSync(p, "utf8");
  const read = (p) => {
    try {
      return { ok: true, text: readFile(p) };
    } catch (err) {
      return { ok: false, why: (err && err.code) || (err && err.message) || String(err) };
    }
  };

  // `git config user.signingkey` points at EITHER half of the pair. Read the declared
  // path first; if it holds private key material the algorithm is not legible there, so
  // fall through to the `.pub` companion — and REFUSE naming BOTH paths if that is
  // absent too, rather than guessing an algorithm for a key nobody could read.
  const tried = [keyPath];
  let r = read(keyPath);
  if (!r.ok) {
    return bad(
      "signing key unreadable",
      `the signing key at ${JSON.stringify(keyPath)} could not be read (${r.why}), so its algorithm is ` +
        `unknown and no suite can be established for it.`,
    );
  }
  let algo = _sshKeyAlgorithm(r.text);
  if (algo && algo.private === true) {
    const pubPath = `${keyPath}.pub`;
    tried.push(pubPath);
    const rp = read(pubPath);
    if (!rp.ok) {
      return bad(
        "signing key unreadable",
        `the signing key at ${JSON.stringify(keyPath)} holds PRIVATE key material, whose armor declares no ` +
          `algorithm, and its public companion ${JSON.stringify(pubPath)} could not be read (${rp.why}). ` +
          `Paths tried: ${tried.join(", ")}. An unresolvable algorithm REFUSES; it never defaults.`,
      );
    }
    algo = _sshKeyAlgorithm(rp.text);
  }
  if (!algo || typeof algo !== "string") {
    return bad(
      "signing key unparseable",
      `the signing key (paths tried: ${tried.join(", ")}) carries no readable algorithm token on its first ` +
        `non-comment line; an OpenSSH public key begins with one (e.g. 'ssh-ed25519 AAAA…').`,
    );
  }
  const suite = SUITE_FOR_KEY_ALGORITHM[algo];
  if (!suite) {
    return bad(
      "unknown key algorithm",
      `the signing key at ${JSON.stringify(keyPath)} declares algorithm ${JSON.stringify(algo)}, which maps ` +
        `to no declared signature suite (known: ${Object.keys(SUITE_FOR_KEY_ALGORITHM).join(", ")}). ` +
        `Signing under a suite chosen for it would write a record whose sig_alg is a lie about its bytes.`,
    );
  }
  if (SUITES[suite].keyType !== keyType) {
    return bad(
      "signing key type mismatch",
      `the signing key at ${JSON.stringify(keyPath)} declares algorithm ${JSON.stringify(algo)} (suite ` +
        `'${suite}', key type '${SUITES[suite].keyType}') but the caller declared key type ` +
        `${JSON.stringify(keyType)}. The two statements about one key disagree.`,
    );
  }
  return { ok: true, suite, keyAlgorithm: algo };
}

/**
 * Resolve a manifest's `signature_suite` declaration into a POLICY.
 *
 * ── THE SHAPE, AND WHY IT IS GENERATIONAL ────────────────────────────────────
 *
 * ```json
 * "signature_suite": {
 *   "generation": 1,
 *   "schema": "burndown-event/v2",
 *   "suite": "openpgp",
 *   "prior_generations": [
 *     { "generation": 0, "schema": "burndown-event/v1", "suite": "openpgp" }
 *   ]
 * }
 * ```
 *
 * ONE suite is accepted for the CURRENT generation. That is the load-bearing fence:
 * the operator has rejected format mixing, and a convention cannot enforce that — a
 * declaration the append path REFUSES against can. A suite change therefore rolls a
 * NEW GENERATION, following the `refs/coc/coordination-genN` precedent
 * (`log-ref-name.js`): the prior generation is CLOSED to appends, stays committed, and
 * stays verifiable under ITS OWN declared suite. Nothing is ever re-signed, and no
 * generation is ever mixed.
 *
 * Generation identity is carried by the record's `schema` string rather than by a
 * separate `generation` integer field. Two reasons, in order of weight: a v1 record
 * ALREADY carries `schema` and carries no generation field, so a schema-keyed policy
 * can classify the 534 committed records without re-emitting one of them; and a reader
 * that pins a schema is pinning the field set it knows how to parse, which is the same
 * thing the generation is for.
 *
 * @returns {{ok:true, policy:object} | {ok:false, error:string, reason:string}}
 */
function resolveSuitePolicy(declaration, opts) {
  const where = (opts && opts.where) || "signature_suite";
  if (declaration === undefined || declaration === null) {
    return bad(
      "no signature suite declared",
      `'${where}' is ABSENT. A signed log with no declared suite cannot be verified: ` +
        `coc-sign::verify defaults to keyType 'ssh', so an undeclared openpgp log verifies as ` +
        `a total signature failure. Absent NEVER reads as 'use the default'.`,
    );
  }
  if (typeof declaration !== "object" || Array.isArray(declaration)) {
    return bad("malformed signature suite", `'${where}' must be a non-array object`);
  }
  const gen = declaration.generation;
  if (!Number.isInteger(gen) || gen < 0) {
    return bad(
      "malformed signature suite",
      `'${where}.generation' is ${JSON.stringify(gen)}; it must be a non-negative integer`,
    );
  }
  if (typeof declaration.schema !== "string" || !declaration.schema) {
    return bad(
      "malformed signature suite",
      `'${where}.schema' must be the non-empty schema string the CURRENT generation's records carry`,
    );
  }
  const kt = keyTypeForSuite(declaration.suite);
  if (!kt.ok) return bad(kt.error, `'${where}.suite': ${kt.reason}`);

  const bySchema = new Map();
  const current = Object.freeze({
    generation: gen,
    schema: declaration.schema,
    suite: declaration.suite,
    keyType: kt.keyType,
    closed: false,
  });
  bySchema.set(current.schema, current);

  const priors = declaration.prior_generations === undefined ? [] : declaration.prior_generations;
  if (!Array.isArray(priors)) {
    return bad("malformed signature suite", `'${where}.prior_generations' must be an array when present`);
  }
  for (let i = 0; i < priors.length; i++) {
    const p = priors[i];
    const at = `${where}.prior_generations[${i}]`;
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      return bad("malformed signature suite", `'${at}' must be a non-array object`);
    }
    if (!Number.isInteger(p.generation) || p.generation < 0) {
      return bad("malformed signature suite", `'${at}.generation' must be a non-negative integer`);
    }
    if (p.generation >= gen) {
      return bad(
        "malformed signature suite",
        `'${at}.generation' is ${p.generation}, which is not BELOW the current generation ${gen}. ` +
          `A prior generation is closed to appends by definition; declaring one at or above the ` +
          `current generation would make two generations simultaneously open and re-admit mixing.`,
      );
    }
    if (typeof p.schema !== "string" || !p.schema) {
      return bad("malformed signature suite", `'${at}.schema' must be a non-empty string`);
    }
    if (bySchema.has(p.schema)) {
      return bad(
        "malformed signature suite",
        `'${at}.schema' is '${p.schema}', which is already declared by another generation. ` +
          `Schema is the generation KEY, so a duplicate makes a record's generation ambiguous — ` +
          `and therefore its suite ambiguous, which is the D1 defect restated.`,
      );
    }
    const pkt = keyTypeForSuite(p.suite);
    if (!pkt.ok) return bad(pkt.error, `'${at}.suite': ${pkt.reason}`);
    bySchema.set(
      p.schema,
      Object.freeze({
        generation: p.generation,
        schema: p.schema,
        suite: p.suite,
        keyType: pkt.keyType,
        closed: true,
      }),
    );
  }

  return {
    ok: true,
    policy: Object.freeze({
      current,
      bySchema,
      /** Whether the CURRENT generation requires the per-emitter chain fields (§3). */
      requiresChain: current.generation >= 1,
    }),
  };
}

/**
 * Read a manifest file and resolve its `signature_suite` declaration.
 *
 * Injectable `opts.readFile` so a fixture can drive every refusal branch without a
 * repo on disk. Every failure is typed; a missing or unreadable manifest REFUSES.
 */
function loadSuitePolicy(repoDir, manifestRel, opts) {
  const o = opts || {};
  if (o.policy) return { ok: true, policy: o.policy };
  const rel = manifestRel || "burndown-manifest.json";
  const readFile = typeof o.readFile === "function" ? o.readFile : (p) => fs.readFileSync(p, "utf8");
  let raw;
  try {
    raw = readFile(path.join(repoDir, rel));
  } catch (err) {
    return bad(
      "manifest unreadable",
      `the suite declaration lives in '${rel}', which could not be read (${(err && err.code) || (err && err.message) || String(err)}). ` +
        `An append cannot proceed without knowing which suite the log accepts.`,
    );
  }
  let m;
  try {
    m = JSON.parse(raw);
  } catch (err) {
    return bad("manifest unparseable", `'${rel}' is not valid JSON: ${(err && err.message) || String(err)}`);
  }
  return resolveSuitePolicy(m && m.signature_suite, { where: `${rel}::signature_suite` });
}

/**
 * Classify one PARSED record against a policy: which generation is it, and therefore
 * which suite verifies it.
 *
 * This is the function that closes D1 at read time. It NEVER guesses: an unrecognised
 * schema, an absent `sig_alg` on a generation that requires one, or a `sig_alg` that
 * disagrees with its generation's declared suite each REFUSE.
 *
 * `sig_alg` is inside the signed canonical bytes (`coc-append.js::appendStamped`
 * canonicalizes the record MINUS `sig`), so it cannot be altered after signing without
 * invalidating the signature. The manifest declaration and the in-record field are
 * therefore two independent statements of the same fact, and this function requires
 * them to AGREE — a record whose `sig_alg` disagrees with its generation is a record
 * whose signer intended a different suite than the log accepts.
 */
function classifyRecord(record, policy) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return bad("invalid record", "record must be a non-array object");
  }
  if (!policy || !policy.bySchema) {
    return bad("no suite policy", "classifyRecord requires a policy from resolveSuitePolicy");
  }
  const g = policy.bySchema.get(record.schema);
  if (!g) {
    const known = Array.from(policy.bySchema.keys()).join(", ");
    return bad(
      "undeclared generation",
      `record schema ${JSON.stringify(record.schema)} matches no declared generation (declared: ${known}). ` +
        `A record whose generation is unknown has no declared suite, so nothing can say which key ` +
        `type verifies it.`,
    );
  }
  // Generation 0 predates the in-record declaration. Its suite is declared ONCE, by
  // the manifest, for the whole closed generation — which is exactly what makes it
  // verifiable without re-emitting a single one of its records. A generation-0 record
  // that DOES carry `sig_alg` is malformed: the field did not exist when those bytes
  // were signed, so its presence means the line was authored by something other than
  // the generation-0 producer.
  const declaresInRecord = g.generation >= 1;
  const alg = record.sig_alg;
  if (!declaresInRecord) {
    if (alg !== undefined) {
      return bad(
        "sig_alg on a generation that has none",
        `record schema '${g.schema}' is generation ${g.generation}, whose records carry no 'sig_alg' ` +
          `(the field postdates them). This line declares ${JSON.stringify(alg)}, so it was not produced ` +
          `by that generation's writer.`,
      );
    }
    return { ok: true, generation: g };
  }
  if (alg === undefined || alg === null) {
    return bad(
      "missing sig_alg",
      `record schema '${g.schema}' is generation ${g.generation}, whose records MUST declare 'sig_alg'. ` +
        `Absent NEVER reads as the default: coc-sign::verify would fall back to keyType 'ssh'.`,
    );
  }
  if (!isSuite(alg)) {
    return bad(
      "unknown signature suite",
      `record declares sig_alg ${JSON.stringify(alg)}, which is not one of ${SUITE_NAMES.join(", ")}`,
    );
  }
  if (alg !== g.suite) {
    return bad(
      "suite mismatch",
      `record declares sig_alg '${alg}' but generation ${g.generation} ('${g.schema}') accepts only ` +
        `'${g.suite}'. One generation carries ONE suite; a change rolls a new generation.`,
    );
  }
  return { ok: true, generation: g };
}

/**
 * The PRODUCER fence (D1 part 2). Decide the `sig_alg` an append may carry, refusing
 * every disagreement loudly.
 *
 * Three independent statements must agree before a byte is written:
 *   1. the manifest-declared suite for the CURRENT generation,
 *   2. the `sig_alg` the caller supplied, if any,
 *   3. the suite the caller's signing KEY actually is.
 *
 * (3) is the one that matters in practice and the one a convention cannot hold. The
 * operator's `git config gpg.format` is openpgp today; the day it becomes ssh, every
 * caller keeps working, keeps passing a discovered `signOpts.keyType`, and the log
 * silently becomes mixed. Refusing here converts that into a loud failure at the first
 * append, which is a generation-roll prompt rather than a corrupted log.
 *
 * (3) READS THE KEY, and did not before. It resolved through `suiteForKeyType`, so the
 * whole check ran at the granularity of `coc-sign`'s TOOL SELECTOR: every ssh key
 * answered `ssh-ed25519` regardless of what it was. That made this fence structurally
 * unable to detect the one thing its own refusal text names — "a record whose declared
 * sig_alg is a lie about its own bytes" — for the entire ssh half of the vocabulary.
 * It now resolves through `suiteForSigningKey`, which reads the key's algorithm and
 * REFUSES when it cannot. `opts.readFile` is injectable so a fixture can drive every
 * refusal branch without a key on disk.
 */
function decideAppendSuite(partial, policy, signOpts, opts) {
  if (!policy || !policy.current) {
    return bad("no suite policy", "decideAppendSuite requires a policy from resolveSuitePolicy");
  }
  const cur = policy.current;
  if (partial && partial.schema !== undefined && partial.schema !== cur.schema) {
    const g = policy.bySchema.get(partial.schema);
    return bad(
      "append to a closed generation",
      g
        ? `the event declares schema '${partial.schema}' (generation ${g.generation}), which is CLOSED. ` +
            `Appends go to the current generation ${cur.generation} ('${cur.schema}') only — a closed ` +
            `generation stays committed and verifiable, and never grows.`
        : `the event declares schema ${JSON.stringify(partial.schema)}, which matches no declared ` +
            `generation; the current generation is '${cur.schema}'`,
    );
  }
  const supplied = partial ? partial.sig_alg : undefined;
  if (supplied !== undefined && supplied !== cur.suite) {
    return bad(
      "suite mismatch",
      `the event declares sig_alg ${JSON.stringify(supplied)} but this log's generation ${cur.generation} ` +
        `accepts only '${cur.suite}'. Mixing suites within one generation is REFUSED; a suite change ` +
        `rolls a new generation.`,
    );
  }
  const callerKeyType = signOpts && signOpts.keyType;
  if (callerKeyType !== undefined && callerKeyType !== null) {
    const s = suiteForSigningKey(signOpts, opts);
    if (!s.ok) return bad(s.error, `signOpts: ${s.reason}`);
    if (s.suite !== cur.suite) {
      return bad(
        "signing key suite mismatch",
        `the signing key is keyType '${callerKeyType}'${s.keyAlgorithm ? `, algorithm '${s.keyAlgorithm}'` : ""} ` +
          `(suite '${s.suite}') but this log's generation ${cur.generation} accepts only '${cur.suite}'. ` +
          `Signing anyway would write a record whose declared sig_alg is a lie about its own bytes. ` +
          `Roll a new generation, or sign with the declared suite's key.`,
      );
    }
  }
  return { ok: true, sig_alg: cur.suite, schema: cur.schema, keyType: cur.keyType };
}

// ═══ §2  PREFIX PRESERVATION — APPEND-ONLY AS A GATE INVARIANT ══════════════

/** Bound the bytes this predicate will hold in memory at once. */
const MAX_PREFIX_BYTES = 64 * 1024 * 1024;

/**
 * Every git subprocess in this file goes through the loom#1471 ENVELOPE: the resolved
 * absolute binary rather than the literal `git`, and `gitEnvForArgs` rather than the
 * inherited environment. An un-enveloped site inherits the operator's config — system
 * and global `gitconfig`, `GIT_*` steering, a hostile `PATH` entry named `git` — any of
 * which can change what a "committed prefix" resolves to, which would make this
 * predicate report on a tree other than the one under test.
 *
 * `.claude/test-harness/tests/git-env-regrowth-guard-1471.test.mjs` is the ledger that
 * enforces this; it RED-ed on this file's single un-helpered call before this change
 * (`lib/signed-log.js: 1 un-helpered git call(s), ledger allows 0`).
 */
function _git(repo, args, encoding) {
  const gitBin = resolveGitBinary();
  if (!gitBin) {
    const e = new Error("git binary could not be resolved on a trusted path");
    e.code = "ENOGIT";
    throw e;
  }
  return execFileSync(gitBin, args, {
    cwd: repo,
    encoding: encoding === undefined ? "utf8" : encoding,
    maxBuffer: MAX_PREFIX_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    env: gitEnvForArgs(args),
  });
}

/**
 * Locate the first byte at which two buffers differ, and describe the breach in terms
 * a reviewer can act on: WHICH committed line, and whether the line that used to be
 * there is missing entirely (a DELETION) or still present later in the file (a
 * REORDER).
 *
 * The classification is a diagnostic, not the verdict — the verdict is "the committed
 * prefix changed", which is already fatal. But `instrument-bipolarity.md` MUST-2 wants
 * a failure IDENTITY rather than a bare code, and "record R was deleted at committed
 * line 4" is the identity; "prefix mismatch at byte 391" is not.
 */
function _classifyBreach(committed, working) {
  const n = Math.min(committed.length, working.length);
  let at = n;
  for (let i = 0; i < n; i++) {
    if (committed[i] !== working[i]) {
      at = i;
      break;
    }
  }
  const head = committed.slice(0, at).toString("utf8");
  const line = head.split("\n").length; // 1-based ordinal of the first differing line
  const committedLines = committed.toString("utf8").split("\n");
  const lost = committedLines[line - 1] === undefined ? "" : committedLines[line - 1];
  let kind = "altered";
  if (working.length < committed.length && at === working.length) {
    kind = "truncated";
  } else if (lost) {
    // WHOLE-LINE membership, not `workingText.includes(lost)`. A substring test over
    // the whole file answers a DIFFERENT question — "do these bytes appear anywhere?" —
    // and a record genuinely DELETED whose text is a substring of any surviving line is
    // then reported as REORDERED. Measured, before this line read by line: committed
    // `aaa/bb/bbccc/ddd` with `bb` deleted classified as "reordered", because `bb`
    // survives inside `bbccc`. The verdict was right and the IDENTITY was wrong, which
    // is the half a reviewer acts on — it names the wrong attack.
    //
    // With the lost line absent, DELETED and ALTERED are told apart by whether the file
    // lost a line at all. Under the old substring test `altered` was effectively
    // unreachable (it required an empty lost line), so an in-place edit reported as a
    // deletion.
    const workingLines = working.toString("utf8").split("\n");
    if (workingLines.includes(lost)) {
      kind = "reordered";
    } else {
      kind = workingLines.length < committedLines.length ? "deleted" : "altered";
    }
  }
  return { kind, byte: at, line, lost };
}

/**
 * THE APPEND-ONLY PREDICATE (D2 + D3, one mechanism).
 *
 * Assert that the log's content AT `priorRef` is an EXACT BYTE PREFIX of the log's
 * content NOW. Everything beyond the prefix is a permitted append.
 *
 * ── WHY THIS IS THE HIGHEST-VALUE PROPERTY, AND WHY IT COMES FIRST ───────────
 *
 * It needs NO schema change, NO key material, and NO signature verification, and it
 * catches DELETION, REORDERING and TRUNCATION of anything already committed —
 * mutations that full per-record signature verification does NOT catch, because every
 * surviving record's signature still verifies perfectly after a middle record is
 * removed. Per-record signature validity and signer-in-roster are STRICTLY WEAKER than
 * this for the tamper classes that matter, and they are additive rather than
 * alternative (see §4).
 *
 * ── AND WHY IT IS ALSO THE D3 FIX ────────────────────────────────────────────
 *
 * `assertCommittedAndUnmodified` asks "is the working tree byte-identical to HEAD?".
 * For a source that is TRUE, and for an APPEND-ONLY LOG it is the wrong question: it
 * takes the gate UNRUNNABLE from the producer's first append. The right question is
 * "has anything already committed CHANGED?" — which permits appends and forbids
 * exactly what must be forbidden. One predicate, both defects.
 *
 * @param {object} p
 * @param {string} p.repo      absolute repo root
 * @param {string} p.rel       repo-relative path to the log
 * @param {string} [p.priorRef="HEAD"] the revision whose content must be a prefix
 * @param {Buffer} [p.current] current bytes; read from disk when omitted
 * @returns {{ok:true, committedBytes:number, currentBytes:number, appendedBytes:number,
 *            appendedLines:number, priorRef:string, blob:string, current:Buffer}
 *          | {ok:false, error:string, reason:string, current?:Buffer, ...}}
 *   `current` is THE BYTES THIS VERDICT IS ABOUT. Present on `ok:true` and on the
 *   append-only-violation shape; ABSENT on the returns that refuse before reading
 *   (symlink, git failure, unreadable), so a caller must treat it as optional. A
 *   caller that re-reads the file instead is verifying a DIFFERENT read than the
 *   one judged here — see the field's own comment for the class that slips
 *   through that gap.
 */
function verifyAppendOnlyPrefix(p) {
  const repo = p && p.repo;
  const rel = p && p.rel;
  const priorRef = (p && p.priorRef) || "HEAD";
  if (!repo || typeof repo !== "string") return bad("invalid argument", "repo must be a non-empty string");
  if (!rel || typeof rel !== "string") return bad("invalid argument", "rel must be a non-empty string");

  // A SYMLINK defeats this predicate exactly as it defeated `assertCommittedAndUnmodified`
  // (that function's own BUG-3 note): git stores the LINK TEXT as the blob while the
  // reader follows it to the TARGET, so the "committed prefix" would describe something
  // other than what was read. Same refusal, same reason, checked here so a caller that
  // swaps to this predicate does not silently drop the check.
  let staged = "";
  try {
    staged = _git(repo, ["ls-files", "-s", "--", rel]).trim();
  } catch (err) {
    return bad("git failed", `git ls-files -s -- '${rel}' failed: ${_gitErr(err)}`);
  }
  const mode = (staged.match(/^(\d{6})\s/) || [])[1];
  if (mode === "120000") {
    return bad(
      "log is a symlink",
      `'${rel}' is a SYMLINK. git hashes the link TEXT while the reader follows it to the TARGET, so a ` +
        `prefix comparison would compare two different files. Declare the real file.`,
    );
  }
  if (mode && mode !== "100644" && mode !== "100755") {
    return bad("log is not a regular file", `'${rel}' has git mode ${mode}; the log must be a regular file`);
  }

  // No committed content at all ⇒ no prefix to preserve, and no provenance either.
  // REFUSE rather than vacuously pass: a predicate that returns ok for a log git has
  // never seen cannot discriminate "append-only, verified" from "this file is not the
  // committed log" — the non-discriminating-instrument shape.
  let blob;
  try {
    blob = _git(repo, ["rev-parse", `${priorRef}:${rel}`]).trim();
  } catch {
    return bad(
      "no committed prefix",
      `'${rel}' does not exist at ${priorRef}, so there is no committed prefix to preserve. An ` +
        `append-only log with no committed content has no provenance: commit the log once before the ` +
        `gate can hold it to anything.`,
    );
  }

  let committed;
  try {
    committed = _git(repo, ["cat-file", "blob", blob], null);
  } catch (err) {
    return bad("git failed", `git cat-file blob ${blob} failed: ${_gitErr(err)}`);
  }

  let working = p && p.current;
  if (working === undefined) {
    try {
      working = fs.readFileSync(path.join(repo, rel));
    } catch (err) {
      return bad("log unreadable", `'${rel}' could not be read: ${(err && err.code) || String(err)}`);
    }
  }
  if (!Buffer.isBuffer(working)) working = Buffer.from(String(working), "utf8");

  if (working.length < committed.length || !committed.equals(working.slice(0, committed.length))) {
    const b = _classifyBreach(committed, working);
    const lost = b.lost.length > 200 ? `${b.lost.slice(0, 200)}…` : b.lost;
    return bad(
      "append-only violation",
      `'${rel}' is APPEND-ONLY, but its content at ${priorRef} is no longer a prefix of the working ` +
        `copy: the committed line ${b.line} was ${b.kind.toUpperCase()} (first differing byte ${b.byte} of ` +
        `${committed.length} committed). Appends beyond the committed prefix are permitted; changing, ` +
        `removing or reordering anything already committed is not — a surviving record's signature still ` +
        `verifies perfectly after a middle record is deleted, so signature checking alone cannot see this.` +
        (lost ? ` The committed line that is no longer at ordinal ${b.line}: ${lost}` : ""),
      {
        breach: b.kind,
        breach_line: b.line,
        breach_byte: b.byte,
        priorRef,
        rel,
        committedBytes: committed.length,
        currentBytes: working.length,
        // Carried on the BREACH shape too, so `current` means the same thing on
        // every return that has read the file. A caller holding only the ok-shape
        // would re-read on failure, which is the second read this field exists to
        // remove — and the other `bad()` returns here (symlink, git failure,
        // unreadable) legitimately have no bytes, so a caller must still treat
        // `current` as optional rather than assume it.
        current: working,
      },
    );
  }

  const appended = working.slice(committed.length);
  const appendedLines = appended.length === 0 ? 0 : appended.toString("utf8").split("\n").filter((l) => l.trim()).length;
  return {
    ok: true,
    priorRef,
    rel,
    blob,
    committedBytes: committed.length,
    currentBytes: working.length,
    appendedBytes: appended.length,
    appendedLines,
    // THE BYTES THIS VERDICT IS ABOUT, returned so a caller need not read the
    // file a second time to get them. A caller that re-reads is verifying a
    // DIFFERENT read than the one this predicate judged, and the gap between the
    // two is a window in which a committed middle record can be deleted — the one
    // class this predicate uniquely catches, invisible to signatures by
    // construction (every surviving record still verifies) and invisible to the
    // chain whenever the current generation is empty.
    current: working,
  };
}

function _gitErr(err) {
  const s = err && err.stderr ? String(err.stderr) : (err && err.message) || String(err);
  return s.trim().slice(0, 256);
}

// ═══ §3  THE CANONICAL RECORD HASH AND THE PER-EMITTER CHAIN ════════════════

/**
 * The canonical content hash of ONE record: sha256 over the canonical bytes of the
 * record MINUS `sig`.
 *
 * This is deliberately the SAME scope `coc-append.js::appendStamped` signs over, so
 * the hash and the signature describe identical bytes. A hash over a different scope
 * than the signature is the shape where a record can be tampered in a way one
 * instrument sees and the other does not.
 */
function canonicalRecordHash(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return bad("invalid record", "record must be a non-array object");
  }
  const copy = Object.assign({}, record);
  delete copy.sig;
  let bytes;
  try {
    bytes = canonicalSerialize(copy);
  } catch (err) {
    return bad("canonical-serialize failed", (err && err.message) || String(err));
  }
  return { ok: true, hash: crypto.createHash("sha256").update(bytes).digest("hex") };
}

/**
 * THE CHAIN, as `coordination-log.js` already defines it — same field names, same
 * semantics, so the two logs converge rather than diverge:
 *
 *   `seq`        per-EMITTER monotonic counter, 1-based, scoped to ONE generation.
 *   `prev_hash`  `canonicalRecordHash` of THIS emitter's `seq - 1` record; `null` at
 *                `seq === 1`.
 *
 * Fork detection is on `(verified_id, seq)` with differing content hashes: two records
 * claiming the same emitter and the same position, with different bytes, is a FORK and
 * is cryptographically detectable.
 *
 * ── CORRECTING THE PRIOR REASONING, WHICH IS WHY THERE WAS NO CHAIN ──────────
 *
 * `burndown-events.js` argued against a counter on the ground that "a counter is NOT
 * UNIQUE across clones: two operators appending concurrently each compute seq = N, and
 * after the merge the log carries two records claiming the same sequence and the fold
 * becomes AMBIGUOUS". That argument is sound against a GLOBAL counter and is exactly
 * WRONG about a PER-EMITTER one, and the difference is the whole design:
 *
 *   - Two DIFFERENT operators never collide, because the counter is scoped to
 *     `verified_id`. The concurrent-merge case the objection describes cannot arise.
 *   - The SAME operator colliding with themselves (two processes, one identity) is a
 *     genuine fork, and a duplicate `(verified_id, seq)` with differing hashes is
 *     precisely how it is DETECTED. The objection treated detectability as the harm.
 *
 * The second objection — that a counter must be READ before it is written, an O(n)
 * scan on a `PostToolUse` path — is CORRECT and is not waved away. It is a measured
 * cost, reported at this shard's landing rather than assumed; see the shard report.
 * It buys the only property that makes a middle-record deletion detectable from the
 * records themselves rather than from git, which is what a log that may one day be
 * verified outside a git working tree needs.
 */
function chainFieldsFor(text, verifiedId, generationSchema) {
  if (typeof verifiedId !== "string" || !verifiedId) {
    return bad("invalid argument", "verifiedId must be a non-empty string");
  }
  let seq = 0;
  let prevHash = null;
  const lines = String(text == null ? "" : text).split(/\r?\n/);
  for (const raw of lines) {
    if (!raw.trim()) continue;
    let e;
    try {
      e = JSON.parse(raw);
    } catch {
      // A line this walker cannot parse cannot be attributed to an emitter, so it
      // cannot advance that emitter's counter. It is NOT silently ignored anywhere it
      // matters: `verifyChain` below reports it.
      continue;
    }
    if (e.verified_id !== verifiedId) continue;
    if (generationSchema !== undefined && e.schema !== generationSchema) continue;
    if (Number.isInteger(e.seq) && e.seq > seq) {
      seq = e.seq;
      const h = canonicalRecordHash(e);
      if (!h.ok) return h;
      prevHash = h.hash;
    }
  }
  return { ok: true, seq: seq + 1, prev_hash: prevHash };
}

/**
 * Verify the per-emitter chain over a whole log, for ONE generation.
 *
 * Returns every finding rather than the first: a caller showing a reviewer what broke
 * needs the hits, not a tally (`instrument-discipline.md` MUST-3(b)).
 */
function verifyChain(text, generationSchema) {
  const lastByEmitter = new Map(); // verified_id → {seq, hash, line}
  const seen = new Map(); // `${verified_id}#${seq}` → {hash, line}
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
      findings.push({ line: ordinal, kind: "unparseable", why: (err && err.message) || String(err) });
      continue;
    }
    if (generationSchema !== undefined && e.schema !== generationSchema) continue;
    checked++;
    const who = e.verified_id;
    if (typeof who !== "string" || !who) {
      findings.push({ line: ordinal, kind: "unattributed", why: "record carries no verified_id" });
      continue;
    }
    if (!Number.isInteger(e.seq) || e.seq < 1) {
      findings.push({ line: ordinal, kind: "missing-seq", why: `seq is ${JSON.stringify(e.seq)}; expected an integer ≥ 1` });
      continue;
    }
    const h = canonicalRecordHash(e);
    if (!h.ok) {
      findings.push({ line: ordinal, kind: "unhashable", why: h.reason });
      continue;
    }
    const forkKey = `${who}#${e.seq}`;
    const prior = seen.get(forkKey);
    if (prior && prior.hash !== h.hash) {
      findings.push({
        line: ordinal,
        kind: "fork",
        why:
          `FORK: '${who}' has two records at seq ${e.seq} with different content (lines ${prior.line} and ` +
          `${ordinal}). One position, two histories.`,
      });
    } else if (!prior) {
      seen.set(forkKey, { hash: h.hash, line: ordinal });
    }
    const last = lastByEmitter.get(who);
    const expectedPrev = last ? last.hash : null;
    const expectedSeq = last ? last.seq + 1 : 1;
    if (e.seq !== expectedSeq) {
      findings.push({
        line: ordinal,
        kind: "seq-gap",
        why: `'${who}' jumped to seq ${e.seq}; the previous record for this emitter was seq ${last ? last.seq : 0}. A gap is a REMOVED record.`,
      });
    }
    const declaredPrev = e.prev_hash === undefined ? null : e.prev_hash;
    if (declaredPrev !== expectedPrev) {
      findings.push({
        line: ordinal,
        kind: "chain-break",
        why:
          `'${who}' declares prev_hash ${JSON.stringify(declaredPrev)} but this emitter's previous record ` +
          `hashes to ${JSON.stringify(expectedPrev)}`,
      });
    }
    lastByEmitter.set(who, { seq: e.seq, hash: h.hash, line: ordinal });
  }
  return { ok: findings.length === 0, checked, findings };
}

// ═══ §4  THE SUITE-DIRECTED VERIFY WRAPPER ══════════════════════════════════

/**
 * Verify ONE record's signature using the suite its GENERATION declares — never a
 * default.
 *
 * This is the D1 fix at the read end. `coc-sign::verify(content, sig, pubKey, opts)`
 * reads `o.keyType || "ssh"`; this wrapper obtains the keyType from `classifyRecord`
 * and passes it explicitly, so an undeclared record REFUSES instead of being verified
 * under the wrong algorithm and reported as a signature failure.
 *
 * `opts.verify` is injectable so a fixture can drive every branch without key material.
 */
function verifyRecordSignature(record, policy, opts) {
  const o = opts || {};
  const c = classifyRecord(record, policy);
  if (!c.ok) return c;
  if (typeof record.sig !== "string" || !record.sig) {
    return bad("unsigned record", "record carries no 'sig'; an unsigned row is un-attributable");
  }
  if (typeof o.pubKey !== "string" || !o.pubKey) {
    return bad("no public key", "verifyRecordSignature requires opts.pubKey for the record's signer");
  }
  const copy = Object.assign({}, record);
  delete copy.sig;
  let bytes;
  try {
    bytes = canonicalSerialize(copy);
  } catch (err) {
    return bad("canonical-serialize failed", (err && err.message) || String(err));
  }
  const verifyFn = typeof o.verify === "function" ? o.verify : cocVerify;
  const r = verifyFn(bytes, record.sig, o.pubKey, {
    keyType: c.generation.keyType,
    gpgHome: o.gpgHome,
    expectedFpr: o.expectedFpr,
    // Forwarded, never synthesized here: only the caller that BUILT the keyring
    // can assert what is in it, and §5 is the only thing in this file that does.
    keyringIsTrustSet: o.keyringIsTrustSet,
  });
  if (!r || r.ok !== true) {
    return bad(
      (r && r.error) || "verify failed",
      (r && r.reason) || "verify returned a non-ok result with no reason",
      // A `verify` that could not RUN is INDETERMINATE, not a signature failure.
      // Propagated rather than collapsed: the caller's whole job is to tell an
      // operator whether to investigate a forgery or repair a toolchain.
      { indeterminate: true },
    );
  }
  // `reason` and `indeterminate` are FORWARDED, not dropped. An earlier revision
  // returned only `{ok, valid, suite, keyType}`, so `coc-sign`'s own diagnosis —
  // "gpg --verify exited 0 but emitted no VALIDSIG", "gpg --verify did not run:
  // ENOENT" — was discarded at this boundary and every caller downstream could
  // only report the record as forged.
  return {
    ok: true,
    valid: r.valid === true,
    ...(r.indeterminate === true ? { indeterminate: true } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
    suite: c.generation.suite,
    keyType: c.generation.keyType,
  };
}

/**
 * The shortest signer fingerprint the identity bind can be trusted with.
 *
 * NOT a style choice, and no longer a collision defense. `coc-sign.js` binds
 * `expectedFpr` by comparing it for EQUALITY against the two fingerprint fields
 * of gpg's `VALIDSIG` line, so a short value can no longer widen the bind — it
 * narrows it to nothing: a truncated value equals no full fingerprint gpg will
 * ever report, so every record from that signer fails the bind.
 *
 * That is why the floor still earns its place. Without it the reader is handed a
 * signature mismatch and pointed at the RECORD, when what is broken is the
 * ROSTER entry — a value too short to name one key cannot identify a signer, and
 * the bind has nothing to hold the signature to. The floor catches it first and
 * says so. 16 is gpg's own short-key-id width; every credential this ecosystem
 * issues (40-hex OpenPGP, `SHA256:`-prefixed ssh digests) clears it by a wide
 * margin, so it fires only on an entry that has been shortened.
 */
const MIN_SIGNER_FINGERPRINT_CHARS = 16;

// ═══ §5  THE BATCH READ GATE — VERIFY EVERY RECORD, OR SAY WHY YOU CANNOT ═══

/**
 * Verify EVERY record in a log, batching the expensive part ONCE.
 *
 * ── WHY THIS EXISTS AND IS NOT LEFT TO THE CALLER ────────────────────────────
 *
 * §4 verifies ONE record. A read gate needs all of them, and the naive loop over §4
 * is not merely slower — it is UNAFFORDABLE, which is the same thing as absent,
 * because an unaffordable gate is the one an operator switches off. MEASURED on this
 * repo's 534-record openpgp log, 2026-08-23:
 *
 *   per-call ephemeral homedir, no `expectedFpr`   679.4 ms/record → 363 s for 534
 *   ONE shared homedir + `expectedFpr` bind          0.08 ms/record →  42 ms for 534
 *
 * Four orders of magnitude, and none of it is cryptography: `coc-sign.js` records
 * that `gpg --version` alone costs 8.33 ms, so the bill is process spawn plus, on the
 * per-call path, `mkdtemp` + `--import` + `gpgconf --kill all` + `rmSync` per record.
 * The shared homedir pays that once; `expectedFpr` then arms `coc-sign`'s per-process
 * fingerprint canary (loom#1891) so every subsequent verify runs in-process.
 *
 * `expectedFpr` is NOT an optimisation here even though it buys the speed. A shared
 * homedir holds EVERY key this batch resolves, and a bare `gpg --verify` against a
 * multi-key keyring accepts a signature made by ANY of them — which would let one
 * rostered emitter forge a record attributed to another. The bind is what keeps the
 * batched path as strict as the per-call one. Same reasoning, same field, as
 * `coordination-log.js::_verifyRule1`.
 *
 * ── INDETERMINATE IS NOT CLEAN ───────────────────────────────────────────────
 *
 * Three outcomes, never two. `ok:true` means every record VERIFIED. `ok:false` with
 * `indeterminate:false` means a record FAILED. `ok:false` with `indeterminate:true`
 * means verification could not RUN — gpg absent, a signer absent from the key
 * resolver, a generation this log does not declare. A caller that collapses the third
 * into the first reports an unverified log as a verified one, which is the whole
 * defect this module was written against. Both non-ok shapes REFUSE; they differ only
 * in what the operator must go and fix.
 *
 * @param {string} text        the whole log
 * @param {object} policy      from `resolveSuitePolicy`
 * @param {object} opts
 * @param {(verifiedId:string)=>({pubkey:string,keyType:string,fingerprint:string}|null)} opts.resolveKey
 *   `fingerprint` is REQUIRED, not optional: it is the identity the signature is
 *   bound to. A resolver that omits it yields an INDETERMINATE finding for that
 *   record rather than a bind computed from the record's own fields.
 * @param {object} [opts.cocSign]  injectable `{createVerifyHomedir,destroyVerifyHomedir}`
 * @param {Function} [opts.verify] injectable per-record verify (fixtures)
 * @returns {{ok:boolean, indeterminate:boolean, checked:number, findings:Array}}
 */
function verifyLogSignatures(text, policy, opts) {
  const o = opts || {};
  const findings = [];
  // ── WHAT COUNTS AS "THE VERIFIER COULD NOT RUN" ──────────────────────────
  //
  // The set was under-inclusive and the shortfall was not cosmetic: FOUR
  // distinct toolchain failures were reported to the operator as
  // `bad-signature`, i.e. as a FORGERY, when the correct action was "repair
  // gpg". They were (measured against `coc-sign.js`, 2026-08-23):
  //
  //   gpg exit 0 with no VALIDSIG   the identity bind could not be evaluated
  //   a mid-batch non-zero exit     carrying no BADSIG/NODATA status line
  //   a mid-batch ENOENT/timeout    `status: null`, read as `!== 0`
  //   a `verify-error` return       the wrapper itself failed to reach a verdict
  //
  // Only batch-START ENOENT was classified correctly (`createVerifyHomedir`
  // returns `ok:false` and this function already routed that to
  // `verification-unavailable`), and the shim test exercised only that path.
  //
  // `bad-signature` is now reserved for a GENUINE signature failure: gpg or
  // ssh-keygen reached a verdict and the verdict was "these bytes and this
  // signature disagree" — including the identity-bind MISMATCH, which is a true
  // statement about the record (signed by a key that is not the one it names).
  const indeterminateKinds = new Set([
    "unrostered-signer",
    "verification-unavailable",
    "undeclared-generation",
    "no-signer-fingerprint",
    "no-records",
    "signer-key-type-mismatch",
  ]);
  if (!policy || !policy.bySchema) {
    return {
      ok: false,
      indeterminate: true,
      checked: 0,
      findings: [{ line: 0, kind: "no-suite-policy", why: "verifyLogSignatures requires a policy from resolveSuitePolicy" }],
    };
  }
  if (typeof o.resolveKey !== "function") {
    return {
      ok: false,
      indeterminate: true,
      checked: 0,
      findings: [{ line: 0, kind: "no-key-resolver", why: "verifyLogSignatures requires opts.resolveKey; without it no signature can be attributed" }],
    };
  }

  // ── pass 1: parse and resolve keys. Nothing is verified yet, because the shared
  // homedir must be built from the COMPLETE key set — building it lazily mid-loop
  // would re-import per key and give back the per-call cost this function exists to
  // avoid.
  const parsed = [];
  const gpgPubKeys = new Map(); // fingerprint → pubkey (distinct)
  const lines = String(text == null ? "" : text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const ordinal = i + 1;
    if (!raw.trim()) continue;
    let e;
    try {
      e = JSON.parse(raw);
    } catch (err) {
      findings.push({ line: ordinal, kind: "unparseable", why: (err && err.message) || String(err) });
      continue;
    }
    const c = classifyRecord(e, policy);
    if (!c.ok) {
      // An undeclared generation is INDETERMINATE (nothing says which suite verifies
      // it); a suite MISMATCH or a stray `sig_alg` is a positive finding about the
      // record itself. `classifyRecord` already tells them apart by `error`.
      findings.push({
        line: ordinal,
        kind: c.error === "undeclared generation" ? "undeclared-generation" : "unclassifiable",
        why: c.reason,
      });
      continue;
    }
    const who = e.verified_id;
    if (typeof who !== "string" || !who) {
      findings.push({ line: ordinal, kind: "unattributed", why: "record carries no verified_id, so no key can be resolved for it" });
      continue;
    }
    let key = null;
    try {
      key = o.resolveKey(who);
    } catch (err) {
      findings.push({ line: ordinal, kind: "verification-unavailable", why: `the key resolver threw for '${who}': ${(err && err.message) || String(err)}` });
      continue;
    }
    if (!key || typeof key.pubkey !== "string" || !key.pubkey) {
      findings.push({
        line: ordinal,
        kind: "unrostered-signer",
        why:
          `no public key is available for verified_id '${who}', so this record's signature cannot be ` +
          `checked at all. That is INDETERMINATE, not clean — an unverifiable row is exactly as ` +
          `un-attributable as an unsigned one.`,
      });
      continue;
    }
    // THE IDENTITY BIND'S INPUT MUST COME FROM THE RESOLVER, NEVER THE RECORD.
    //
    // Pass 2 used to compute `expectedFpr: key.fingerprint || record.verified_id`.
    // Under today's roster resolver the fallback is unreachable (that resolver
    // skips any key without a string `fingerprint`), but it is not a resolver
    // property — `resolveKey` is INJECTABLE, and for any resolver that omits
    // `fingerprint` the fallback silently re-points the identity bind at an
    // ATTACKER-CONTROLLED RECORD FIELD. `gpg --verify` against the shared
    // multi-key keyring would then be asked to confirm the signer is whoever the
    // record says it is, which it trivially is. That is structurally the hole
    // `coc-sign.js::_canaryKey` documents having DELETED rather than documented,
    // for the same reason.
    //
    // So the fingerprint is REQUIRED and its absence FAILS CLOSED as
    // INDETERMINATE — the resolver, not this function, is the thing that is
    // broken, and no signature in this batch can be attributed without it.
    //
    // WHERE THE PROTECTION ACTUALLY LIVES, stated so a future "hardening" along
    // this axis is not a no-op. With the production resolver `key.fingerprint`
    // IS the map key, so on every successful resolution it equals
    // `record.verified_id` byte for byte — the provenance of the STRING is not
    // what protects anything. The protection is the roster LOOKUP: a fingerprint
    // the roster does not carry resolves to null and the record never reaches
    // the bind at all. Requiring the resolver-supplied value still matters, but
    // for a different reason — it keeps the contract true for an INJECTED
    // resolver, where the two are not the same string.
    // NORMALIZED THE SAME WAY THE BIND NORMALIZES, which is the whole point of
    // measuring it here at all. This was `.trim()` — leading/trailing whitespace
    // only — while `coc-sign.js` compares `.replace(/\s+/g, "")`, stripping
    // INTERIOR whitespace too. Measured, they disagree without bound:
    // "1  2  3  4  5  6" is 16 characters after trim() and SIX after the strip,
    // so a padded roster entry cleared this floor and reached the bind
    // degenerate, with every surface still reporting the floor as enforced. And
    // because OpenPGP fingerprints are conventionally WRITTEN with spaces, such
    // an entry looks entirely normal in review.
    //
    // A floor is only a floor if it measures the string the consumer consumes.
    const fpr = typeof key.fingerprint === "string" ? key.fingerprint.replace(/\s+/g, "") : "";
    if (!fpr) {
      findings.push({
        line: ordinal,
        kind: "no-signer-fingerprint",
        why:
          `the key resolver returned key material for '${who}' but NO 'fingerprint', so the signer ` +
          `identity cannot be bound to anything the resolver vouched for. Falling back to the record's ` +
          `own verified_id would bind the signature to a field the record's author controls, which is ` +
          `not a check. Verification is INDETERMINATE for this record, not clean and not a forgery.`,
      });
      continue;
    }
    // A LENGTH FLOOR, because a short value is not an IDENTIFIER.
    // `coc-sign.js` satisfies `expectedFpr` by comparing it for equality against
    // the fingerprint fields of the `VALIDSIG` status line. That is exact for a
    // full fingerprint and useless for a short one — not because a 2-character
    // "fingerprint" matches too much, but because it matches NOTHING: it equals
    // no fingerprint gpg will ever report, so the bind refuses every record the
    // signer legitimately signed.
    //
    // The floor exists to name that failure at its source. Left to the bind, a
    // shortened roster entry surfaces as a signature mismatch and sends the
    // reader after the record; raised here it is what it actually is — a roster
    // entry too short to identify anyone, with nothing for the bind to compare.
    //
    // 16 is gpg's own short-key-id width and is what `coc-sign` already truncates
    // to when it REPORTS a fingerprint; every real credential this ecosystem
    // issues is far longer (a 40-hex OpenPGP fingerprint, a `SHA256:`-prefixed
    // ssh digest ~50 chars), so the floor cannot fire on an honest roster — it
    // fires on a roster entry that has been shortened, which is the attack.
    if (fpr.length < MIN_SIGNER_FINGERPRINT_CHARS) {
      findings.push({
        line: ordinal,
        kind: "no-signer-fingerprint",
        why:
          `the key resolver returned a fingerprint of ${fpr.length} character(s) for '${who}'; the floor ` +
          `is ${MIN_SIGNER_FINGERPRINT_CHARS}. A value that short does not identify a signer, and the ` +
          `identity bind needs a full fingerprint to compare the signing key against — there is nothing ` +
          `here to hold the signature to. The roster entry is what is wrong, not this record: fix the ` +
          `entry and re-run the check. This record is INDETERMINATE — it was never verified, and it was ` +
          `never accused.`,
      });
      continue;
    }
    // THE KEY'S OWN TYPE, CHECKED — not the generation's, assumed for it.
    //
    // The line below keyed the shared keyring off `c.generation.keyType`, the
    // GENERATION's type, and never consulted `key.keyType` at all — the resolver
    // records it (`burndown-build.mjs::rosterKeyResolver` sets `keyType: k.type`)
    // and it was read ZERO times. So an OpenSSH public key could be handed to
    // `createVerifyHomedir` as though it were OpenPGP material.
    //
    // MEASURED, the whole chain, on a roster carrying 1 gpg and 3 ssh keys: an
    // attacker appends ONE JSONL line — current gpg generation, `verified_id` set
    // to a rostered SSH fingerprint, `sig: "x"` — with NO signing key and NO
    // roster write. `classifyRecord` passes; `key.pubkey` is a non-empty string
    // so it clears the resolver fence; the ~50-char ssh fingerprint clears both
    // the fingerprint fence and the length floor. The ssh key then entered
    // `gpgPubKeys`, and `gpg --import` on OpenSSH material exits 2 with
    // `[GNUPG:] NODATA` ("no valid OpenPGP data found") — against a positive
    // control where genuine OpenPGP material reimports at exit 0. So
    // `createVerifyHomedir` returned `{ok:false}`, this function returned
    // `checked:0, indeterminate:true`, and the ENTIRE BUILD refused with "a
    // shared GPG verification homedir could not be created" — the operator sent
    // to repair gpg when the cause was one appended record.
    //
    // Fail-CLOSED, so never a bypass. But it is a PER-RECORD fault promoted into
    // a WHOLE-BATCH verifier outage, which is the verifier-fault-versus-
    // record-fault misclassification this file has now fixed at five other sites.
    // `coc-sign.js` already classifies this correctly per record — that fence
    // just lives in pass 2, and the keyring is built first.
    //
    // Absent is a mismatch too: a roster entry with no `type` cannot be matched to
    // a generation, and guessing is what this whole module refuses to do.
    if (key.keyType !== c.generation.keyType) {
      findings.push({
        line: ordinal,
        kind: "signer-key-type-mismatch",
        why:
          `record schema '${c.generation.schema}' is verified with ${JSON.stringify(c.generation.keyType)} ` +
          `keys, but the roster's entry for '${who}' carries a ${JSON.stringify(key.keyType)} key. This ` +
          `record cannot be verified — the signer named has no key of the required type — so it is ` +
          `INDETERMINATE, not forged. It is reported against THIS LINE rather than allowed to poison the ` +
          `shared keyring, where one bad record would take the whole log's verification down and read as ` +
          `a broken gpg installation.`,
      });
      continue;
    }
    if (c.generation.keyType === "gpg") gpgPubKeys.set(key.fingerprint, key.pubkey);
    // The record's OWN generation is carried forward, not re-derived downstream from
    // `policy.current`. A multi-generation log verifies each record under ITS OWN
    // declared suite, so any count attributed to "the" suite is a count about a
    // population that does not exist.
    parsed.push({ ordinal, record: e, key, generation: c.generation });
  }

  // ── THE ZERO-RECORD FENCE ────────────────────────────────────────────────
  //
  // With nothing to verify this function used to return `{ok:true, checked:0}` —
  // a CLEAN VERIFICATION OF ZERO RECORDS, which is the non-discriminating
  // instrument in its purest form: identical output for "every record verified"
  // and "there was nothing here at all". It was unreachable from the burndown
  // gate only because `foldLedgerEvents` happens to refuse an empty log EIGHT
  // LINES EARLIER — an UNDOCUMENTED ORDERING DEPENDENCY carrying this gate's
  // entire non-vacuity, which any reordering, any second caller, or any manifest
  // whose fold tolerates emptiness would silently remove.
  //
  // The sibling predicate fences this explicitly and says why
  // (`verifyAppendOnlyPrefix`: "REFUSE rather than vacuously pass"). Same
  // disposition, same reason, here — so the property is owned by the function
  // that claims it rather than borrowed from a neighbour.
  if (parsed.length === 0 && findings.length === 0) {
    return {
      ok: false,
      indeterminate: true,
      checked: 0,
      findings: [
        {
          line: 0,
          kind: "no-records",
          why:
            `the log carries NO verifiable records, so a 'verified' verdict here would report on an ` +
            `EMPTY population. "Every record verified" and "there was nothing to verify" are opposite ` +
            `facts and must not share an output. This is INDETERMINATE, not clean.`,
        },
      ],
    };
  }

  // ── the shared homedir, built once from the complete gpg key set.
  const cs = o.cocSign || { createVerifyHomedir, destroyVerifyHomedir };
  let home = null;
  if (gpgPubKeys.size > 0 && typeof o.verify !== "function") {
    const h = cs.createVerifyHomedir(Array.from(gpgPubKeys.values()));
    if (!h.ok) {
      // DELIBERATELY NOT the per-call fallback `coordination-log.js` takes. That
      // fallback is correct there and wrong here: measured above it costs 679 ms a
      // record, so on this log it converts a 42 ms gate into a 6-minute one, and a
      // gate nobody will wait for is a gate nobody runs. `createVerifyHomedir` fails
      // for exactly one reason that matters — gpg is not usable in this environment —
      // and "the verifier could not run" is INDETERMINATE, which is a refusal.
      return {
        ok: false,
        indeterminate: true,
        checked: 0,
        findings: findings.concat([
          {
            line: 0,
            kind: "verification-unavailable",
            why:
              `a shared GPG verification homedir could not be created (${h.reason}), so none of the ` +
              `${gpgPubKeys.size} openpgp key(s) in this log can be used. Verification did not RUN; the ` +
              `log's integrity is UNKNOWN, which is reported as such rather than as a pass.`,
          },
        ]),
      };
    }
    home = h.home;
  }

  // ── pass 2: verify. One shared homedir, one fingerprint bind per record.
  let checked = 0;
  // Verified records TALLIED BY THEIR OWN GENERATION'S SUITE. A single scalar suite
  // cannot describe a multi-generation log: on this repo's log, 534 records are
  // generation-0 openpgp while the CURRENT generation is ssh-rsa, so a caller reading
  // one suite off the policy reports 534 records verified under a suite not one of
  // them was signed with. That reading survives review precisely because it is right
  // whenever every generation happens to share a suite — which was true here until the
  // generation-2 roll, and is the shape of an instrument that cannot discriminate.
  const bySuite = new Map();
  try {
    for (const { ordinal, record, key, generation } of parsed) {
      const r = verifyRecordSignature(record, policy, {
        pubKey: key.pubkey,
        gpgHome: home || undefined,
        // THE ASSERTION, made only where it is TRUE. `home` was built by
        // `createVerifyHomedir` from `gpgPubKeys` — every key this batch resolved
        // through the roster resolver and nothing else — so for this call the
        // keyring IS the trust set, and an issuer absent from it is absent from
        // the roster. Scoped to `home`: when the shared homedir was not built
        // (an ssh-suite log, or a per-call fallback), the claim is not made.
        keyringIsTrustSet: home ? true : undefined,
        // RESOLVER-SUPPLIED ONLY. The `|| record.verified_id` fallback that used
        // to sit here is deleted, not defaulted — see the no-signer-fingerprint
        // fence in pass 1, which is what guarantees this field is present.
        expectedFpr: key.fingerprint,
        verify: o.verify,
      });
      checked++;
      if (r.ok) bySuite.set(generation.suite, (bySuite.get(generation.suite) || 0) + 1);
      if (!r.ok) {
        // `verifyRecordSignature` refuses for two DIFFERENT reasons and they are
        // no longer merged. A record with no `sig` at all is a positive finding
        // ABOUT THE RECORD; a `verify` that could not reach a verdict is a fact
        // about the TOOLCHAIN and is INDETERMINATE.
        findings.push({
          line: ordinal,
          kind: r.indeterminate === true ? "verification-unavailable" : "unsigned-or-unverifiable-record",
          why: `${r.error}: ${r.reason}`,
        });
        continue;
      }
      if (r.valid !== true) {
        if (r.indeterminate === true) {
          findings.push({
            line: ordinal,
            kind: "verification-unavailable",
            why:
              `record '${record.id}' (item '${record.item_id}', emitter '${record.verified_id}') could not ` +
              `be verified because the VERIFIER did not reach a verdict: ${r.reason || "no reason given"}. ` +
              `That is INDETERMINATE — the record's integrity is UNKNOWN. It is NOT a signature failure, ` +
              `and reporting it as one would send an operator hunting a forgery when the fix is to repair ` +
              `the signing toolchain.`,
          });
          continue;
        }
        findings.push({
          line: ordinal,
          kind: "bad-signature",
          why:
            `record '${record.id}' (item '${record.item_id}', emitter '${record.verified_id}') carries a ` +
            `signature that does NOT verify against that emitter's key under suite '${r.suite}'. The ` +
            `record's bytes and its signature disagree: it was altered after signing, or never signed by ` +
            `the emitter it names.` + (r.reason ? ` (${r.reason})` : ""),
        });
      }
    }
  } finally {
    // `createVerifyHomedir`'s contract: the caller that supplied `gpgHome` owns the
    // teardown, and not doing it leaks one gpg-agent per fold. A `finally` so a throw
    // in the loop cannot leak one either.
    if (home) {
      try {
        cs.destroyVerifyHomedir(home);
      } catch {
        /* teardown is best-effort; a leaked temp dir must not mask the verdict */
      }
    }
  }

  const indeterminate = findings.length > 0 && findings.every((f) => indeterminateKinds.has(f.kind));
  // `verifiedBySuite` is the per-generation breakdown, ordered by DESCENDING count so
  // the dominant population renders first. It is a separate field rather than a
  // replacement for `checked`: `checked` counts records the verifier REACHED (failures
  // included), this counts records that VERIFIED, and merging them would make one
  // number answer two questions.
  const verifiedBySuite = Object.freeze(
    [...bySuite.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([suite, count]) => Object.freeze({ suite, count })),
  );
  return { ok: findings.length === 0, indeterminate, checked, verifiedBySuite, findings };
}

// ═══ §6  A CLOSED GENERATION NEVER GROWS — ENFORCED ON READ ═════════════════

/**
 * Refuse any record of a CLOSED generation that lies BEYOND the committed prefix.
 *
 * ── THE HOLE THIS CLOSES ─────────────────────────────────────────────────────
 *
 * "A prior generation is CLOSED to appends" is stated by `resolveSuitePolicy`, by
 * the manifest's own note, and by `decideAppendSuite`, which refuses a producer
 * append carrying a closed generation's schema. All three are PRODUCER fences.
 * The READ GATE had none, and the two checks it does run BOTH miss a closed-
 * generation append by construction:
 *
 *   `verifyAppendOnlyPrefix`  permits everything after the committed prefix —
 *                             that is its entire purpose (defect D3).
 *   `verifyChain`             is called scoped to the CURRENT generation's
 *                             schema, and `continue`s a differing schema BEFORE
 *                             `checked++`. A closed-generation record therefore
 *                             joins no chain, is issued no `seq`, and is INVISIBLE
 *                             to the fork detector.
 *
 * So a record stamped with the closed generation's schema, appended and left
 * uncommitted, routed around the chain ENTIRELY while every gate reported clean.
 * The `closed: true` flag `resolveSuitePolicy` computes was read by NOTHING on
 * the read path.
 *
 * ── WHY THE BOUNDARY IS THE COMMITTED PREFIX, AND NOT "ANY CLOSED RECORD" ────
 *
 * The committed prefix is exactly the population a closed generation is entitled
 * to occupy: this repo's log carries 534 committed generation-0 records and
 * re-emitting them is the thing generational classification exists to avoid.
 * What a closed generation may NOT do is GROW. `verifyAppendOnlyPrefix` already
 * returns `committedBytes`, so the boundary is a number the caller is holding.
 *
 * FAIL-CLOSED ON AN ABSENT BOUNDARY: a caller that cannot supply `committedBytes`
 * gets a refusal, not a pass. An unknown boundary means every closed-generation
 * record is unadjudicable, which is INDETERMINATE and never clean.
 *
 * @param {string} text            the whole log, as read
 * @param {object} policy          from `resolveSuitePolicy`
 * @param {number} committedBytes  byte length of the committed prefix
 * @returns {{ok:true, checked:number, appendedClosed:0} | {ok:false, error, reason, findings}}
 */
function verifyClosedGenerationAppends(text, policy, committedBytes) {
  if (!policy || !policy.bySchema) {
    return bad("no suite policy", "verifyClosedGenerationAppends requires a policy from resolveSuitePolicy");
  }
  if (!Number.isInteger(committedBytes) || committedBytes < 0) {
    return bad(
      "no committed boundary",
      `verifyClosedGenerationAppends needs the committed prefix length as a non-negative integer, got ` +
        `${JSON.stringify(committedBytes)}. Without it nothing can say which records are COMMITTED and ` +
        `which were appended, so a closed generation's growth is unadjudicable — which is INDETERMINATE, ` +
        `not clean.`,
    );
  }
  const src = String(text == null ? "" : text);
  const findings = [];
  let checked = 0;
  // Byte offsets, not character offsets: `committedBytes` comes from a Buffer
  // length and the log may carry multi-byte UTF-8. Comparing it against a
  // character index would misplace the boundary by exactly the number of
  // non-ASCII bytes before it — a silent off-by-N on the one number that decides
  // whether a record is committed evidence or an append.
  let offset = 0;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const ordinal = i + 1;
    const lineStart = offset;
    // +1 for the "\n" that `split` consumed. The final element has no trailing
    // newline; over-counting it by one byte cannot move a verdict, because a
    // record that starts at or after the boundary is an append either way.
    offset += Buffer.byteLength(raw, "utf8") + 1;
    if (!raw.trim()) continue;
    let e;
    try {
      e = JSON.parse(raw);
    } catch {
      // Unparseable lines belong to `verifyChain` / the fold, both of which
      // report them. Not double-reported here.
      continue;
    }
    const g = policy.bySchema.get(e && e.schema);
    if (!g || g.closed !== true) continue;
    checked++;
    if (lineStart < committedBytes) continue; // committed evidence — legitimate
    findings.push({
      line: ordinal,
      kind: "closed-generation-append",
      why:
        `record on line ${ordinal} declares schema '${g.schema}' (generation ${g.generation}), which is ` +
        `CLOSED, and it begins at byte ${lineStart} — BEYOND the committed prefix of ${committedBytes} ` +
        `byte(s). A closed generation stays committed and verifiable and never GROWS. Worse, a closed ` +
        `generation's records are exempt from the per-emitter chain (which runs scoped to generation ` +
        `${policy.current.generation}, '${policy.current.schema}'), so this record carries no 'seq', joins ` +
        `no chain, and is invisible to fork detection — appending under a closed schema routes around the ` +
        `chain entirely. Append to generation ${policy.current.generation} instead.`,
    });
  }
  if (findings.length > 0) {
    return bad("closed generation grew", `${findings.length} record(s) of a CLOSED generation lie beyond the committed prefix`, {
      findings,
      checked,
    });
  }
  return { ok: true, checked, appendedClosed: 0 };
}

module.exports = {
  // §1
  SUITES,
  SUITE_NAMES,
  isSuite,
  keyTypeForSuite,
  suiteForKeyType,
  suiteForSigningKey,
  resolveSuitePolicy,
  loadSuitePolicy,
  classifyRecord,
  decideAppendSuite,
  // §2
  verifyAppendOnlyPrefix,
  MAX_PREFIX_BYTES,
  // §3
  canonicalRecordHash,
  chainFieldsFor,
  verifyChain,
  // §4
  verifyRecordSignature,
  // §5
  verifyLogSignatures,
  // §6
  verifyClosedGenerationAppends,
};
