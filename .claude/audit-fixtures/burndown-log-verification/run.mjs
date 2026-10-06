#!/usr/bin/env node
/**
 * burndown-log-verification — fixtures for the CONSUMER half of the log/projection
 * split: `burndown-build.mjs::checkLinks` verifying against the committed
 * append-only event log instead of parsing the tracker table.
 *
 * ── WHAT THIS SUITE IS FOR, AND WHAT IT IS NOT ───────────────────────────────
 *
 * `burndown-events` fixtures cover the PRODUCER (the append path, the schema, the
 * fold's own fence). This suite covers the CONSUMER: that the generator folds the
 * log into the projection `checkLinks` joins on, that the live repo re-reads
 * SURVIVED the substrate swap, and that every refusal the swap introduced is LOUD.
 *
 * ── BIPOLAR PER ARM, AND THE HARNESS ASSERTS THE POLES DIFFER ────────────────
 *
 * `instrument-bipolarity.md` MUST-1: every arm ships an executable pole PAIR run by
 * THIS harness, and the harness itself asserts the two verdicts DIFFER. A pair whose
 * poles agree is VACUOUS and FAILS here rather than passing quietly — see `pair()`.
 *
 * MUST-2: every RED pole names a failure IDENTITY — which criterion, which leg,
 * which item or line — never a bare exit code. A suite reading only exit codes stays
 * green against a generator that refuses the wrong thing for the wrong reason.
 *
 * ── THE C1 PROOF IS THE LOAD-BEARING ONE ─────────────────────────────────────
 *
 * C1 says LINK-2/LINK-3 MUST stay LIVE REPO READS, because an append-only log cannot
 * express "the artifact I pointed at was deleted" — an event that truthfully recorded
 * an anchor stays true forever while the anchor ROTS. Asserting the real binary
 * refuses on a rotted anchor is NOT by itself evidence that the live re-read is what
 * caught it. So arm C1 is paired with a SOURCE MUTATION that implements the
 * counterfactual design — resolveAnchor short-circuits to `ok` before it touches the
 * repository, i.e. it TRUSTS THE EVENT — and the mutant is run against the SAME tree
 * with a BYTE-IDENTICAL log. The mutant reports the chain INTACT. That is the
 * measurement, not the assertion, that the live re-read is doing the work.
 *
 * ── MUTATIONS ARE PROVEN TO REACH BEFORE ANY RESULT IS READ ──────────────────
 *
 * `instrument-discipline.md` MUST-2(b): a mutation that does NOT red leaves TWO live
 * hypotheses — vacuous test, or inert mutation. Every mutation here is proven twice:
 * (1) the textual anchor was FOUND (a no-op replace throws rather than returning a
 * verdict), and (2) the mutant's verdict on the same tree DIFFERS from the real
 * binary's. Both together are what makes "the check is doing the work" a measurement.
 *
 * Every case runs the REAL binary as a subprocess against REAL temporary git
 * repositories. Nothing is mocked.
 */
import "../_lib/no-ambient-git.cjs";
import { copyStaticImportClosure } from "../_lib/static-import-closure.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const GENERATOR = path.join(REPO_ROOT, ".claude", "bin", "burndown-build.mjs");
const LIB = path.join(REPO_ROOT, ".claude", "hooks", "lib", "burndown-events.js");

const ev = require(LIB);
const { foldEvents, buildEvent, EVENTS_REL } = ev;
const cocSign = require(path.join(REPO_ROOT, ".claude", "hooks", "lib", "coc-sign.js"));
const { canonicalRecordHash } = require(path.join(REPO_ROOT, ".claude", "hooks", "lib", "signed-log.js"));

// ── THE FIXTURE SIGNING IDENTITY ───────────────────────────────────────────
//
// Every synthesized record below is REALLY SIGNED, by a real ed25519 key this
// process generates once, against a real roster the fixture repo carries. Before
// the read gate existed these lines carried the literal string `sig: "FIXTURE"`
// and the suite's own README recorded the honest bound: "Signatures are not
// verified. A green run here is NOT evidence of signature verification."
//
// That bound is now GONE rather than restated, and it had to go: the generator
// verifies every record before it folds, so a suite signing with a placeholder
// would test only that the gate refuses placeholders. Signing for real is what
// makes the GREEN poles evidence that a HEALTHY signed log folds, which is the
// half a tamper fixture cannot supply.
//
// `ssh-ed25519` rather than `openpgp` — the same closed vocabulary the real log
// uses, the other member of it. MEASURED on this machine: keygen 9 ms, sign 9 ms,
// verify 2 ms, against 679 ms for one un-batched openpgp verify. A suite that took
// a gpg keyring per case would be a suite nobody runs.
//
// `algorithm` is parameterised because ONE suite cannot express a multi-generation
// log. The per-generation-suite arm below needs two generations signed under two
// GENUINELY DIFFERENT suites, and a fixture whose generations share a suite cannot
// tell "each record was attributed to its own generation" from "every record was
// attributed to the current one" — the two readings agree on every output. `rsa`
// buys that second suite without a gpg keyring, which the measurement above rules out.
function makeSigner(tag, personId, algorithm = "ed25519") {
  // NOT pushed to `tmpDirs` at construction — that array is declared BELOW the first
  // call and referencing it would be a temporal-dead-zone throw. Each signer's dir is
  // registered for cleanup immediately after the declaration instead.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `bd-logverify-key-${tag}-`));
  const keyPath = path.join(d, `id_${algorithm}`);
  const keygen = ["-t", algorithm, "-N", "", "-C", `burndown-fixture-${tag}`, "-f", keyPath];
  // 2048 rather than the 3072 default: this key is generated once per suite RUN and
  // RSA keygen dominates the fixture's startup cost at larger sizes.
  if (algorithm === "rsa") keygen.push("-b", "2048");
  execFileSync("ssh-keygen", keygen, { stdio: "ignore" });
  const pubkey = fs.readFileSync(`${keyPath}.pub`, "utf8").trim();
  const fingerprint = execFileSync("ssh-keygen", ["-lf", `${keyPath}.pub`], { encoding: "utf8" }).split(/\s+/)[1];
  return { dir: d, keyPath, pubkey, fingerprint, person_id: personId, display_id: tag, algorithm };
}

const SIGNER = makeSigner("fixture", "pid-fixture-signer");

/**
 * A SECOND, fully-real signing identity that the fixture roster does NOT carry.
 *
 * This is the adversary of the roster trust-root arm: a key anyone can generate,
 * whose signatures are cryptographically perfect, and whose only missing credential
 * is a COMMITTED roster entry binding it to a person. It exists to make the point
 * that the crypto is not what is being attacked — the KEY LIST is.
 */
const ATTACKER = makeSigner("attacker", "pid-fixture-attacker");

/**
 * The CLOSED generation's signer, under a DIFFERENT suite from the current one.
 *
 * This mirrors the real log's shape after the generation-2 roll: 534 committed
 * generation-0 records signed under one suite, a current generation that accepts
 * another. That separation is the whole reason the per-generation report exists —
 * while every generation shared a suite, a report attributing all records to the
 * CURRENT suite printed a true sentence for the wrong reason, and no output of it
 * could have shown the error.
 *
 * `rsa` gives suite `ssh-rsa` against the fixture signer's `ssh-ed25519`. Both are
 * real keys and both really sign, so the GREEN pole below is evidence that the closed
 * generation VERIFIES — not merely that it was counted.
 */
const PRIOR_SIGNER = makeSigner("prior-gen", "pid-fixture-prior-gen", "rsa");

const ROSTER_REL = ".claude/operators.roster.json";

/**
 * The roster the fixture repo carries, binding SIGNER's fingerprint to its key.
 *
 * `role` / `host_role` arrived with the authority binding (component 12), which
 * resolves a record's claimed authority against the signer's ROLE here. They default
 * to `contributor` / `human` — deliberately NOT `owner` — so that every pre-existing
 * arm keeps testing what it was written to test (none of them claims a role-bound
 * authority) while the new arms have to ASK for owner authority to get it. A default
 * of `owner` would have made the unbacked-claim RED pole unreachable.
 *
 * `omitRole` is an explicit flag rather than `role: undefined`, because a destructuring
 * default fires on `undefined` and would silently restore `contributor` — a case that
 * reads as "no declared role" while testing the opposite.
 */
function fixtureRoster({ role = "contributor", host_role = "human", omitRole = false, withPriorGen = false } = {}) {
  const person = {
    display_id: SIGNER.display_id,
    keys: [{ type: "ssh", fingerprint: SIGNER.fingerprint, pubkey: SIGNER.pubkey }],
  };
  if (!omitRole) person.role = role;
  person.host_role = host_role;
  const persons = { [SIGNER.person_id]: person };
  // The closed generation's signer is a SEPARATE rostered person, added only when an
  // arm asks for it. Folding its key into `person` above would give every pre-existing
  // arm a second key on one fingerprint-bearing identity — a different trust-root shape
  // from the one those arms were written against.
  if (withPriorGen) {
    persons[PRIOR_SIGNER.person_id] = {
      display_id: PRIOR_SIGNER.display_id,
      role: "contributor",
      host_role: "human",
      keys: [{ type: "ssh", fingerprint: PRIOR_SIGNER.fingerprint, pubkey: PRIOR_SIGNER.pubkey }],
    };
  }
  return JSON.stringify({ genesis: { established_at: "2026-08-01T00:00:00.000Z" }, persons }, null, 2);
}

/**
 * The manifest's suite declaration for a fixture repo. The CURRENT generation with
 * generation 0 as a CLOSED prior, mirroring the real `burndown-manifest.json` shape so
 * a fixture exercising the read gate exercises the same classification the real log
 * takes.
 *
 * The current generation is read from the library (`ev.SCHEMA`) rather than written as
 * a literal, because `evtRecord` below stamps records through `buildEvent` — which
 * stamps `ev.SCHEMA`. A literal that fell behind the library declared one generation
 * while every synthesized record carried another, and the whole suite then refused as
 * `undeclared generation` before a single arm measured anything.
 *
 * The SUITE stays `ssh-ed25519` and is pinned to the fixture signer, which generates a
 * real **ed25519** key. It is deliberately NOT the canonical log's `ssh-rsa`: suite is
 * declared per-manifest, and a fixture repo describing its own signer honestly is the
 * point. Change the generated key type without changing this and the suite fence reds
 * — now genuinely, because `suiteForSigningKey` reads the key's algorithm rather than
 * its coarse keyType.
 */
function fixtureSuiteDeclaration({ priorSuite = "ssh-ed25519" } = {}) {
  return {
    generation: ev.SCHEMAS[ev.SCHEMA].generation,
    schema: ev.SCHEMA,
    suite: "ssh-ed25519",
    // `priorSuite` defaults to the current suite so every pre-existing arm keeps the
    // single-suite log it was written against. The per-generation arm overrides it to
    // `ssh-rsa`, which is the only configuration in which "attributed to its own
    // generation" and "attributed to the current generation" produce DIFFERENT output.
    prior_generations: [{ generation: 0, schema: "burndown-event/v1", suite: priorSuite }],
  };
}

/**
 * Sign one record for real: canonical bytes of the record MINUS `sig`, which is the
 * exact scope `coc-append.js::appendStamped` signs and `signed-log.js` re-derives.
 * A different scope on either side is the shape where a record can be tampered in a
 * way one instrument sees and the other does not.
 */
function signRecordWith(rec, signer) {
  const copy = Object.assign({}, rec);
  delete copy.sig;
  const r = cocSign.sign(cocSign.canonicalSerialize(copy), { keyType: "ssh", keyPath: signer.keyPath });
  if (!r.ok) throw new Error(`the fixture signer failed: ${r.error}: ${r.reason}`);
  return Object.assign({}, copy, { sig: r.sig });
}

function signRecord(rec) {
  return signRecordWith(rec, SIGNER);
}

let pass = 0;
const failures = [];
const tmpDirs = [];
tmpDirs.push(SIGNER.dir, ATTACKER.dir, PRIOR_SIGNER.dir); // see the TDZ note in `makeSigner` above

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

/**
 * Register one bipolar ARM. Both poles run and each returns a VERDICT STRING —
 * not a boolean, because two booleans can be equal for opposite reasons and the
 * whole point is that the poles are DISTINGUISHABLE. The harness then asserts, as
 * its own case, that the verdicts DIFFER.
 */
function pair(arm, redName, redFn, greenName, greenFn) {
  let redV = null;
  let greenV = null;
  check(`${arm} · RED  · ${redName}`, () => {
    redV = redFn();
    return typeof redV === "string" && redV.startsWith("RED:")
      ? true
      : `expected a RED: verdict, got ${JSON.stringify(redV)}`;
  });
  check(`${arm} · GREEN · ${greenName}`, () => {
    greenV = greenFn();
    return typeof greenV === "string" && greenV.startsWith("GREEN:")
      ? true
      : `expected a GREEN: verdict, got ${JSON.stringify(greenV)}`;
  });
  // The poles are REQUIRED to prefix `RED:`/`GREEN:`, so comparing the raw strings
  // can never fail — a criticism this suite earned at review, and a real one: it made
  // a third of the registered cases structurally incapable of reddening. The
  // comparison is therefore made on the verdict BODY, with the author-supplied
  // prefix stripped, so a pole copy-pasted from its sibling reds here.
  check(`${arm} · NON-VACUOUS · the two poles produce DIFFERENT verdicts`, () => {
    if (redV === null || greenV === null) return "a pole did not produce a verdict";
    const body = (v) => v.replace(/^(RED|GREEN):/, "");
    if (body(redV) === body(greenV)) {
      return `VACUOUS PAIR: the poles differ only by their prefix — both report ${JSON.stringify(body(redV))}`;
    }
    return redV !== greenV ? true : `VACUOUS PAIR: both poles returned ${JSON.stringify(redV)}`;
  });
}

// ── temporary repositories ─────────────────────────────────────────────────

const ITEM_ID = "R1-alpha-item";
const ANCHOR_FILE = "journal/0001-alpha.md";

/**
 * One synthesized ON-DISK record line.
 *
 * `buildEvent` stamps the CURRENT generation (`burndown-event/v2`), which
 * `burndown-events.js::validateRecord` — the predicate the fold applies to every
 * line it reads off disk — requires to carry the signature/chain envelope:
 * `sig_alg`, an integer `seq >= 1`, and a `prev_hash` that is 64-hex or null (null
 * iff `seq === 1`). `buildEvent` deliberately stamps NONE of them (they are facts
 * about the signature and the log, stamped by `appendEvent` next to `sig`), so a
 * synthesized line must stamp them itself or the fold refuses it as malformed.
 *
 * The defaults below sit BEFORE `...over` so any case that wants to drive a
 * malformed-envelope branch can still override them. Every line is stamped
 * `seq: 1` / `prev_hash: null`, which is a WELL-FORMED shape: `validateRecord` is
 * documented SHAPE-ONLY and per-line, and whole-log chain consistency (that
 * `prev_hash` matches the emitter's previous record, that no `(verified_id, seq)`
 * forks) belongs to `signed-log.js::verifyChain`, which the fold does not run.
 */
// A monotonic per-suite counter so two records synthesized in the same millisecond
// still carry distinct ids — `id` is inside the signed bytes, so a collision would
// produce two records with identical canonical hashes and a spurious FORK finding.
let _recN = 0;

/**
 * @param {object} over   fields to override BEFORE signing (a well-formed variant)
 * @param {object} [tamper] fields to overwrite AFTER signing — the ONLY way to build
 *   a record whose bytes and signature disagree. Kept separate from `over` on purpose:
 *   a case that means "a different valid record" and a case that means "a FORGED
 *   record" must not be expressible by the same argument, or a fixture author gets a
 *   forgery by accident and reads the resulting refusal as the arm's real verdict.
 */
/**
 * @param {boolean} gen0  emit a GENERATION-0 (`burndown-event/v1`) record — really
 *   signed, but carrying NO `sig_alg`, `seq` or `prev_hash`, because none of those
 *   fields existed when that generation was written. `classifyRecord` REFUSES a gen-0
 *   record that carries `sig_alg`, so this is not merely omission: those three fields
 *   must be absent, not null.
 *
 *   Gen-0 is what the 534 committed records in this repo actually are, and it is the
 *   ONLY shape that isolates the prefix gate: a chainless record cannot be missed by
 *   the chain check, so a deleted gen-0 record is caught by prefix preservation ALONE.
 *   The prefix arms use it for exactly that reason — under gen-1 the chain also
 *   catches the deletion, and a mutation exempting only the prefix gate then still
 *   refuses, which is UNRESOLVED rather than a verdict.
 */
/**
 * @param {object} [signer=SIGNER] the identity that both STAMPS `verified_id` and
 *   really SIGNS. Parameterised so the roster trust-root arm can synthesize a record
 *   from a SECOND real key — the one property that arm is about, and one no `over`
 *   override could express, because the stamp and the signature must move together.
 */
function evtRecord(over, seq, prevHash, gen0, signer = SIGNER) {
  const envelope = gen0
    ? { schema: "burndown-event/v1" }
    : { sig_alg: "ssh-ed25519", seq, prev_hash: prevHash };
  return signRecordWith(
    {
    id: `rec_fixture_${String(++_recN).padStart(6, "0")}`,
    timestamp: new Date().toISOString(),
    session_id: "fixture",
    repo: "fixture",
    verified_id: signer.fingerprint,
    person_id: signer.person_id,
    display_id: signer.display_id,
    ...buildEvent({
      kind: "genesis",
      item_id: ITEM_ID,
      item: "an alpha item",
      value_anchor: `${ANCHOR_FILE}#${ITEM_ID}`,
      status: "In progress",
      authority: "agent",
      source: "fixture",
    }),
    // AFTER `buildEvent`, which stamps the CURRENT generation's `schema`. Under
    // `gen0` the envelope has to overwrite that, so it cannot sit above it.
    ...envelope,
    ...over,
    },
    signer,
  );
}

/**
 * Build a WHOLE LOG whose per-emitter chain is CORRECT — `seq` counting from 1 and
 * each `prev_hash` the canonical hash of this emitter's previous record.
 *
 * This is a log builder rather than a line builder because the chain is a property of
 * the LOG, not of a record. Every record here shares one emitter, so two independently
 * built lines both claiming `seq: 1` is a FORK, and concatenating two `evtLine()`
 * calls — which is what every multi-record case here used to do — now reds the chain
 * check for a reason that has nothing to do with the arm under test.
 *
 * A spec is either a plain `{over, tamper, gen0}` object or a RAW STRING, which is
 * emitted verbatim and advances nothing. The raw form is how the malformed-line arms
 * inject a line that is deliberately not a record at all.
 */
function evtLog(...specs) {
  let seq = 0;
  let prev = null;
  const out = [];
  for (const spec of specs) {
    if (typeof spec === "string") {
      out.push(spec);
      continue;
    }
    const s = spec || {};
    const rec = evtRecord(s.over || {}, seq + 1, prev, s.gen0 === true);
    seq += 1;
    const h = canonicalRecordHash(rec);
    if (!h.ok) throw new Error(`the fixture chain could not hash a record it just built: ${h.reason}`);
    prev = h.hash;
    out.push(JSON.stringify(s.tamper ? Object.assign(rec, s.tamper) : rec) + "\n");
  }
  return out.join("");
}

/**
 * ONE record, correctly chained as the FIRST record of its own log.
 *
 * @param {object} over     fields to override BEFORE signing (a well-formed variant)
 * @param {object} [tamper] fields to overwrite AFTER signing — the ONLY way to build a
 *   record whose bytes and signature disagree. Kept separate from `over` on purpose: a
 *   case meaning "a different valid record" and a case meaning "a FORGED record" must
 *   not be expressible by the same argument, or a fixture author gets a forgery by
 *   accident and reads the resulting refusal as the arm's real verdict.
 */
function evtLine(over = {}, tamper = null) {
  return evtLog({ over, tamper });
}

function gitInit(dir) {
  for (const a of [
    ["init", "-q"],
    ["config", "user.email", "fixture@example.invalid"],
    ["config", "user.name", "fixture"],
    ["config", "commit.gpgsign", "false"],
    ["add", "-A"],
    ["commit", "-q", "-m", "fixture"],
  ]) {
    execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  }
}

function commitAll(dir, msg) {
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", msg], { cwd: dir, stdio: "ignore" });
}

function blobOf(dir, rel) {
  try {
    return execFileSync("git", ["rev-parse", `HEAD:${rel}`], { cwd: dir, encoding: "utf8" }).trim();
  } catch {
    return "<absent>";
  }
}

/**
 * A repo whose burndown declares ONE item, whose event log carries ONE genesis
 * event for it, and whose anchor artifact is tracked and carries the id verbatim.
 * That is the minimal tree on which the chain holds, so every RED pole below is one
 * deliberate departure from it.
 */
function mkRepo(opts = {}) {
  const {
    events = evtLine(),
    trackerKind = "event-log",
    trackerPath = EVENTS_REL,
    anchorRoots = ["journal/"],
    minRows,
    sourcePath = "burndown/register.json",
    withAnchor = true,
    // The two artefacts the READ GATE depends on, defaulted PRESENT so every
    // pre-existing arm keeps testing what it was written to test, and switchable so
    // the INDETERMINATE poles below can remove exactly one of them.
    withSuite = true,
    withRoster = true,
    suite = fixtureSuiteDeclaration(),
    // The SIGNER's rostered role + host, for the authority-binding arms. Defaults
    // match `fixtureRoster`'s: contributor / human.
    roster = undefined,
  } = opts;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bd-logverify-"));
  tmpDirs.push(dir);
  const tracker = { path: trackerPath, kind: trackerKind, anchor_roots: anchorRoots };
  if (minRows !== undefined) tracker.min_rows = minRows;
  const manifest = {
    _schema: "burndown-manifest/v1",
    target: "REGISTER.md",
    pages: ["Alpha"],
    sources: [{ path: sourcePath, kind: "register", precedence: 0 }],
    tracker,
  };
  if (withSuite) manifest.signature_suite = suite;
  const files = {
    "REGISTER.md": "# Register\n",
    [sourcePath]: JSON.stringify(
      {
        _note: "fixture",
        _generated: "2026-08-01",
        _authority: "agent",
        _id_convention: "R1-SLUG",
        items: [{ id: ITEM_ID, page: "Alpha", status: "In progress" }],
      },
      null,
      2,
    ),
    "burndown-manifest.json": JSON.stringify(manifest, null, 2),
    // The tracker TABLE still exists on disk under both kinds. Under `event-log` it
    // is a projection nothing verifies against, and it is left DELIBERATELY STALE
    // here (it names no row) so that a case which passes could not have passed by
    // silently falling back to parsing it.
    ".session-notes.shared.md": "| ID | item | value_anchor |\n| --- | --- | --- |\n",
    [EVENTS_REL]: events,
  };
  if (withAnchor) {
    files[ANCHOR_FILE] = `# Alpha\n\nThe ruling for ${ITEM_ID} is recorded here.\n`;
  }
  // The roster is what binds a record's `verified_id` fingerprint to key material.
  // Without it NOTHING can attribute a signature, which the generator reports as
  // INDETERMINATE — see the `verification-cannot-run-is-not-clean` arm.
  if (withRoster) files[ROSTER_REL] = fixtureRoster(roster);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  gitInit(dir);
  return dir;
}

/**
 * @param {object} [extraEnv] variables added to the child's AMBIENT environment.
 *   Load-bearing for the git-steering arm: the whole class it pins is that an
 *   ambient variable re-points the subprocess at another repository, so a harness
 *   that could not set one could not express the attack at all.
 */
function runGen(dir, args = [], tool = GENERATOR, extraEnv = null) {
  const r = spawnSync("node", [tool, "--repo", dir, ...args], {
    cwd: dir,
    encoding: "utf8",
    timeout: 120000,
    ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
  });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

// ── the mutation harness ───────────────────────────────────────────────────
//
// A mutant is the REAL generator source with one textual substitution. Two things
// are asserted before any mutant verdict is read: the anchor was FOUND (a no-op
// substitution throws), and — at the call site — that the mutant's verdict on the
// SAME tree differs from the real binary's. Absent the second, a non-reddening
// mutation would leave "vacuous check" and "inert mutation" both live.
/**
 * A mutated copy of `signed-log.js`, for the arms whose counterfactual lives in the
 * LIBRARY rather than in the generator.
 *
 * `mutantTool` below rebases the generator's lazy requires onto the REAL library
 * paths, so a mutation of the library cannot be expressed through it — the mutant
 * generator would load the pristine library and the case would report the real
 * binary's behaviour twice. This writes the mutated copy and hands its path back for
 * `mutantTool`'s `signedLog` override to point at.
 *
 * The copy's OWN two sibling requires are rebased for the same reason `mutantTool`
 * rebases the generator's: `signed-log.js` resolves them through `__dirname`, which
 * in a temp directory finds nothing, and the resulting load failure is a typed
 * refusal indistinguishable from an arm's RED pole.
 */
function mutantSignedLog(mutate) {
  const abs = path.join(REPO_ROOT, ".claude", "hooks", "lib", "signed-log.js");
  let out = fs.readFileSync(abs, "utf8");
  for (const dep of ["coc-sign.js", "git-subprocess-env.js"]) {
    const bridge = `require(path.join(__dirname, ${JSON.stringify(dep)}))`;
    if (!out.includes(bridge)) throw new Error(`a sibling-require anchor is gone from signed-log.js: ${bridge}`);
    out = subOnce(out, bridge, `require(${JSON.stringify(path.join(REPO_ROOT, ".claude", "hooks", "lib", dep))})`);
  }
  const before = out;
  out = mutate(out);
  if (out === before) throw new Error("the library mutation anchor was NOT found — the mutation never reached the source");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bd-mutant-lib-"));
  tmpDirs.push(dir);
  const p = path.join(dir, "signed-log.js");
  fs.writeFileSync(p, out);
  return p;
}

function mutantTool(mutate, { signedLog = null } = {}) {
  const src = fs.readFileSync(GENERATOR, "utf8");
  // Rebase the LAZY require onto an absolute path: the mutant lives outside
  // `.claude/bin/`, so the relative `../hooks/lib/...` resolution would not find the
  // event library and the mutant would take the typed "library could not be loaded"
  // refusal — an exit 2 that looks like the arm's RED pole while measuring nothing.
  //
  // BOTH lazy requires are rebased, not just the event library's. The generator gained
  // a second lazy dependency (`signed-log.js`, the append-only predicate) and it is
  // resolved on the `event-log` path too, so leaving it relative reproduced exactly the
  // mode this comment warns about: two mutation cases took the typed "append-only
  // library could not be loaded" refusal — an exit 2 indistinguishable from the arm's
  // RED pole — and reported UNRESOLVED because the mutation was never reached.
  //
  // THREE bridges now, not two. The generator gained a THIRD lazy dependency —
  // `coc-sign.js`, the transitive half of the compat guard (`assertCocSignCompatible`)
  // — and leaving it relative reproduced the mode this comment warns about for the
  // third time: four mutation cases took the typed "signing library could not be
  // loaded" refusal, an exit 2 indistinguishable from their RED pole, and reported
  // UNRESOLVED because the mutation was never reached.
  const BRIDGES = [
    ['const rel = path.join(here, "..", "hooks", "lib", "burndown-events.js");', LIB],
    [
      'const rel = path.join(here, "..", "hooks", "lib", "signed-log.js");',
      // Overridable, so an arm whose counterfactual lives in the LIBRARY can point
      // this bridge at a mutated copy. Absent an override it resolves to the real
      // library, exactly as every pre-existing arm expects.
      signedLog || path.join(REPO_ROOT, ".claude", "hooks", "lib", "signed-log.js"),
    ],
    [
      'const rel = path.join(here, "..", "hooks", "lib", "coc-sign.js");',
      path.join(REPO_ROOT, ".claude", "hooks", "lib", "coc-sign.js"),
    ],
    // The FOURTH, and it is the one whose absence is not merely a missing feature:
    // `git-subprocess-env.js` supplies the resolved binary + constants-built env
    // that every `git` in the generator runs under, and its absence is a TYPED
    // REFUSAL by design (a security dependency that degrades quietly is not one).
    // Un-rebased, ten mutation and bin-only arms took that refusal — an exit 2
    // indistinguishable from their own RED pole — and reported UNRESOLVED.
    [
      'const rel = path.join(here, "..", "hooks", "lib", "git-subprocess-env.js");',
      path.join(REPO_ROOT, ".claude", "hooks", "lib", "git-subprocess-env.js"),
    ],
  ];
  let out = src;
  for (const [bridge, abs] of BRIDGES) {
    if (!out.includes(bridge)) throw new Error(`a lazy-require anchor is gone from burndown-build.mjs: ${bridge}`);
    out = subOnce(out, bridge, `const rel = ${JSON.stringify(abs)};`);
  }
  // `mutate` is null when the counterfactual lives in the LIBRARY: the generator is
  // copied unmutated and only its `signed-log.js` bridge is re-pointed. The
  // anchor-found assertion is skipped for that case ALONE — `mutantSignedLog` makes
  // the identical assertion against the library source, so no mutation anywhere is
  // permitted to silently no-op.
  if (mutate) {
    const before = out;
    out = mutate(out);
    if (out === before) throw new Error("the mutation anchor was NOT found — the mutation never reached the source");
  } else if (!signedLog) {
    throw new Error("mutantTool was called with neither a generator mutation nor a library override");
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bd-mutant-"));
  tmpDirs.push(dir);
  // THE STATIC-IMPORT CLOSURE, DERIVED from the tree (2026-10-03). The BRIDGES
  // above rebase the generator's four LAZY PATH-resolved deps, but a STATIC
  // import cannot be rebased that way — `import { isMainModule } from
  // "./lib/entry-point.mjs"` resolves against the MUTANT'S OWN location, and
  // after fcecaa28f added it twelve mutation arms died with
  // ERR_MODULE_NOT_FOUND and reported UNRESOLVED (the mutant's own exit, not
  // the arm's verdict). The mutant is therefore written into a MIRRORED
  // `.claude/bin/` layout with the closure copied beside it — deriving rather
  // than listing, so the next static import cannot break these arms either.
  const binDir = path.join(dir, ".claude", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  copyStaticImportClosure({ fromRoot: REPO_ROOT, toRoot: dir, entries: [GENERATOR] });
  const p = path.join(binDir, "burndown-build.mjs");
  fs.writeFileSync(p, out);
  return p;
}

function subOnce(src, from, to) {
  const parts = src.split(from);
  if (parts.length !== 2) {
    throw new Error(`mutation anchor matched ${parts.length - 1} time(s), expected exactly 1: ${JSON.stringify(from)}`);
  }
  return parts.join(to);
}

// ═══════════════════════════════════════════════════════════════════════════
// ARM C2 — the fold reproduces the committed projection
// ═══════════════════════════════════════════════════════════════════════════

const REAL_LOG = path.join(REPO_ROOT, EVENTS_REL);
const REAL_MANIFEST = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "burndown-manifest.json"), "utf8"));

pair(
  "C2-fold-reproduces-the-projection",
  "a log missing three appends folds to a SMALLER population, named by the ids it lost",
  () => {
    const text = fs.readFileSync(REAL_LOG, "utf8");
    const lines = text.split("\n").filter((l) => l.trim());
    const full = foldEvents(text).rows;
    // SELECTED BY WHAT THEY HOLD, not by where they sit. This pole drops lines and
    // asserts the population shrinks, so it must drop lines that HOLD a row — and
    // positional picks (first / middle / last) do not. It broke when the last line
    // became an INERT `kind: "proposal"`, which holds no row by construction, so
    // dropping it lost nothing and the pole reported "removing 3 appends did not
    // shrink the fold" about a fold behaving exactly as designed.
    //
    // Deriving the selection makes the pole robust to every future kind: pick items
    // whose id is carried by EXACTLY ONE considered record, so dropping that record
    // cannot be absorbed by an earlier event for the same item (supersession would
    // otherwise re-expose the row and hide the loss).
    const counts = new Map();
    const lineOf = new Map();
    for (let i = 0; i < lines.length; i++) {
      let e;
      try { e = JSON.parse(lines[i]); } catch { continue; }
      if (!ev.validateRecord(e).ok) continue;
      counts.set(e.item_id, (counts.get(e.item_id) || 0) + 1);
      if (full.has(e.item_id)) lineOf.set(e.item_id, i);
    }
    const soleIds = [...full.keys()].filter((id) => counts.get(id) === 1).slice(0, 3);
    if (soleIds.length < 3) {
      // ABSENT, not RED. A log in which fewer than three items are carried by a single
      // record cannot exercise this pole at all, and saying so is not the same as
      // saying the fold failed to shrink.
      return `this log carries only ${soleIds.length} item(s) held by exactly one record — it cannot exercise this pole, which is an ABSENT result and not a fold failure`;
    }
    const dropped = soleIds.map((id) => lines[lineOf.get(id)]);
    const kept = lines.filter((l) => !dropped.includes(l)).join("\n") + "\n";
    const short = foldEvents(kept).rows;
    const lost = [...full.keys()].filter((k) => !short.has(k));
    if (short.size >= full.size) return `removing 3 appends did not shrink the fold (${full.size} → ${short.size})`;
    if (lost.length === 0) return "the fold shrank but named no lost id — the projection is not keyed on item_id";
    return `RED:C2 criterion=fold-completeness folded=${short.size} expected=${full.size} lost=${lost.join(",")}`;
  },
  "the committed log folds to the declared population, with ordinals as line numbers",
  () => {
    const text = fs.readFileSync(REAL_LOG, "utf8");
    const { rows, skipped, considered } = foldEvents(text);
    const nonBlank = text.split("\n").filter((l) => l.trim()).length;
    const declared = REAL_MANIFEST.tracker.min_rows;
    if (nonBlank !== considered) return `${nonBlank - considered} of ${nonBlank} committed line(s) are unreadable`;
    // `>=`, NOT `===`. `min_rows` is a FLOOR — "growth is free and needs no
    // declaration" — so equality would red this suite on a healthy repo the first
    // time the producer appends a transition for a NEW item, which is exactly what
    // `todo-tracker-guard.js` does in ordinary work.
    if (rows.size < declared) return `the fold produced ${rows.size} item(s); the manifest floor is ${declared}`;
    // The projection SHAPE is what `checkLinks` joins on. Assert every field, not a
    // count: a fold producing the right NUMBER of wrong-shaped rows passes a count.
    for (const [id, r] of rows) {
      if (r.id !== id) return `row '${id}' carries id '${r.id}' — the map key and the row disagree`;
      if (typeof r.anchorRaw !== "string" || !r.anchorRaw) return `row '${id}' has no anchorRaw cell`;
      if (typeof r.item !== "string") return `row '${id}' has no item text`;
      if (!Number.isInteger(r.line) || r.line < 1 || r.line > nonBlank) {
        return `row '${id}' has ordinal ${r.line}, outside 1..${nonBlank}`;
      }
    }
    return `GREEN:C2 criterion=fold-completeness folded=${rows.size} declared=${declared} lines=${nonBlank} skipped=${skipped.length}`;
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// ARM C1 — a rotted anchor is STILL CAUGHT, because the re-read is still live
// ═══════════════════════════════════════════════════════════════════════════

/** The rotted tree: the log is untouched, the artifact it points at is gone. */
function mkRottedRepo() {
  const dir = mkRepo();
  const before = blobOf(dir, EVENTS_REL);
  execFileSync("git", ["rm", "-q", ANCHOR_FILE], { cwd: dir, stdio: "ignore" });
  commitAll(dir, "rot: the context artifact is deleted; the event that named it is untouched");
  const after = blobOf(dir, EVENTS_REL);
  if (before !== after || before === "<absent>") {
    throw new Error(`the log blob MOVED across the rot (${before} → ${after}) — the rot is not isolated to the anchor`);
  }
  return { dir, logBlob: after };
}

pair(
  "C1-rotted-anchor-still-caught",
  "the anchor artifact is deleted while the event stays true — LINK-2 refuses",
  () => {
    const { dir, logBlob } = mkRottedRepo();
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 2) return `a rotted anchor exited ${r.code}; C1 requires UNRUNNABLE (exit 2)`;
    if (r.out !== "") return `a refusal wrote to stdout: ${JSON.stringify(r.out.slice(0, 120))}`;
    if (!/traceability chain is BROKEN/.test(r.err)) return `refused, but not for the chain: ${r.err.slice(0, 200)}`;
    if (!r.err.includes(ITEM_ID)) return "the refusal does not name the item id";
    const leg = (r.err.match(/\b(LINK-[123])\b/) || [])[1];
    if (!leg) return "the refusal names no LINK leg — the failure has no identity";
    if (!/is not a tracked file/.test(r.err)) {
      return `refused on leg ${leg} but not on the live repo read: ${r.err.slice(0, 200)}`;
    }
    return `RED:C1 criterion=live-re-read leg=${leg} id=${ITEM_ID} log_blob=${logBlob} exit=2`;
  },
  "the anchor artifact is present and tracked — the same log folds to an INTACT chain",
  () => {
    const dir = mkRepo();
    const logBlob = blobOf(dir, EVENTS_REL);
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 0) return `an intact tree exited ${r.code}: ${r.err.slice(0, 200)}`;
    if (!/chain INTACT — 1 ADJUDICATED item\(s\)/.test(r.out)) return `unexpected stdout: ${r.out.slice(0, 200)}`;
    if (!r.out.includes(`event in ${EVENTS_REL}`)) return "the verdict does not name the EVENT LOG as the substrate";
    return `GREEN:C1 criterion=live-re-read leg=none id=${ITEM_ID} log_blob=${logBlob} exit=0`;
  },
);

check("C1 · MUTATION · a resolveAnchor that TRUSTS THE EVENT reports the rotted chain INTACT", () => {
  // The counterfactual design C1 forbids: short-circuit resolveAnchor to `ok` BEFORE
  // the first repo read, i.e. replay the anchor from the event and believe it.
  const tool = mutantTool((s) =>
    subOnce(
      s,
      '  const stagedAnchor = git(repo, ["ls-files", "-s", "--", p]);',
      '  return { ok: true, path: p, fragment };\n  const stagedAnchor = git(repo, ["ls-files", "-s", "--", p]);',
    ),
  );
  const { dir } = mkRottedRepo();
  const real = runGen(dir, ["--check-links"]);
  const mutant = runGen(dir, ["--check-links"], tool);
  if (real.code !== 2) return `the real binary did not refuse the rotted tree (exit ${real.code}) — nothing to compare`;
  if (mutant.code !== 0) {
    return `the mutant ALSO refused (exit ${mutant.code}) — the mutation did not reach the live read, so this is UNRESOLVED, not a verdict: ${mutant.err.slice(0, 200)}`;
  }
  if (!/chain INTACT/.test(mutant.out)) return `the mutant exited 0 but printed no verdict: ${mutant.out.slice(0, 200)}`;
  return true;
});

// ═══════════════════════════════════════════════════════════════════════════
// ARM — a TAMPERED committed prefix is refused, and the refusal is LOUD
// ═══════════════════════════════════════════════════════════════════════════
//
// This arm used to assert that an appended-but-UNCOMMITTED log takes the build
// UNRUNNABLE, because the tracker went through `assertCommittedAndUnmodified` under
// both kinds. That was defect T1, and the arm encoded it: "is the working tree
// byte-identical to HEAD?" is the right question for a TABLE, which is a snapshot,
// and the WRONG question for a LOG, which is append-only. It took the gate unrunnable
// from the producer's first append — every hook that records a transition appends a
// line, so the next `--check-links` refused with exit 2 until someone committed, i.e.
// the gate was unrunnable during exactly the work it exists to observe.
//
// The generator now asks the question that fits the substrate — has anything already
// COMMITTED changed? (`signed-log.js::verifyAppendOnlyPrefix`) — so the poles move
// with it. The RED pole is retargeted onto the property that is STRICTLY STRONGER and
// is what actually matters: a committed record that was DELETED. Nothing is weakened
// by the move; an append is permitted, and tampering with committed evidence is not.
pair(
  "log-committed-prefix-tamper-refused-loudly",
  "a DELETED committed record takes the build UNRUNNABLE, naming the log and the breach",
  () => {
    // TWO records for the SAME item, so deleting the first still leaves the board
    // COMPLETE. With a second item the surviving log would fail the LINK gate instead,
    // and the mutation case below could not tell "the prefix gate caught it" from
    // "something else did" — the counterfactual mutant would refuse either way.
    // GENERATION-0 records, deliberately. Gen-0 predates `seq`/`prev_hash`, so the
    // per-emitter chain neither covers nor could catch this deletion — which is what
    // ISOLATES the property under test to prefix preservation ALONE. Under gen-1 the
    // chain also fires, and the mutation below could then no longer tell which gate
    // did the work (it measured exactly that: the prefix-exempted mutant still
    // refused, on the chain, and reported UNRESOLVED).
    const dir = mkRepo({ events: evtLog({ gen0: true }, { gen0: true }) });
    // Remove the FIRST committed record: the surviving record's bytes are untouched,
    // so nothing about it is detectably wrong — this is precisely the mutation that
    // per-record signature verification cannot see, and that prefix preservation can.
    const lines = fs.readFileSync(path.join(dir, EVENTS_REL), "utf8").split("\n").filter((l) => l.trim());
    fs.writeFileSync(path.join(dir, EVENTS_REL), `${lines.slice(1).join("\n")}\n`);
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 2) return `a tampered log exited ${r.code}; the gate must be UNRUNNABLE (exit 2)`;
    if (r.out !== "") return `a refusal wrote to stdout: ${JSON.stringify(r.out.slice(0, 120))}`;
    if (!/^UNRUNNABLE — refusing because /m.test(r.err)) return "the refusal is not the LOUD UNRUNNABLE form";
    if (!/This is exit 2\. It is NOT a pass\./.test(r.err)) return "the refusal does not say it is not a pass";
    if (!r.err.includes(EVENTS_REL)) return "the refusal does not name the event log";
    if (!/APPEND-ONLY/.test(r.err)) return `refused, but not on the append-only predicate: ${r.err.slice(0, 200)}`;
    if (!/was DELETED/.test(r.err)) return `refused, but did not name the breach as a DELETION: ${r.err.slice(0, 200)}`;
    if (!/committed line 1/.test(r.err)) return "the refusal does not name WHICH committed line was lost";
    // Every token a reader would skim for to conclude the build worked.
    for (const tok of ["chain INTACT", "ALL PAGES", "BURNDOWN:BEGIN", "✓"]) {
      if ((r.out + r.err).includes(tok)) return `the refusal carries the clean-summary token ${tok}`;
    }
    return `RED:committed-evidence criterion=verifyAppendOnlyPrefix path=${EVENTS_REL} breach=deleted line=1 exit=2 stdout=empty`;
  },
  "an UNCOMMITTED CURRENT-generation append beyond the committed prefix is PERMITTED and folds — the T1 regression test",
  () => {
    // ── THIS POLE WAS INVERTED, AND WHAT IT USED TO PIN WAS A BYPASS ─────────
    //
    // It appended a GENERATION-0 record — against a manifest declaring generation 0
    // CLOSED — and asserted `r.code !== 0` is a T1 REGRESSION. So it pinned AS GREEN
    // the exact route around `verifyChain` that this suite's own chain arms exist to
    // close: a closed-generation record joins no chain, is issued no `seq`, and is
    // invisible to fork detection, because `verifyChain` runs scoped to the CURRENT
    // generation and `continue`s a differing schema before it counts anything.
    // MEASURED when the read gate learned to refuse it, on the unmodified arm:
    //   "an uncommitted append exited 2 — T1 has regressed: UNRUNNABLE — refusing
    //    because event log 'burndown/events.jsonl': 1 record(s) of a CLOSED
    //    generation lie beyond the committed prefix."
    // The fixture called the FIX a regression, which is what a green-pinned bypass
    // does. The T1 property itself is real and is still pinned — it just has to be
    // pinned with a record of the generation that is actually OPEN.
    //
    // The prior comment's reason for reaching for gen-0 ("two independently-built
    // gen-1 records would each claim seq: 1, which is a FORK") was a true observation
    // with the wrong remedy: the answer is to build ONE CHAINED log of two records
    // and commit only its first line, which is what `evtLog` produces natively.
    const chained = evtLog({}, { over: { item_id: "R2-beta-item" } });
    const lines = chained.split("\n").filter((l) => l.trim());
    if (lines.length !== 2) return `the fixture builder produced ${lines.length} record(s), expected 2`;
    const dir = mkRepo({ events: `${lines[0]}\n` });
    // seq 2, prev_hash = hash of the committed record: a correctly chained CURRENT-
    // generation append. Deliberately NOT committed. Under the pre-T1 predicate this
    // was exit 2; under the closed-generation fence it must still be exit 0.
    fs.appendFileSync(path.join(dir, EVENTS_REL), `${lines[1]}\n`);
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 0) return `an uncommitted append exited ${r.code} — T1 has regressed: ${r.err.slice(0, 200)}`;
    if (!/chain INTACT/.test(r.out)) return `unexpected stdout: ${r.out.slice(0, 200)}`;
    // The chain must have SEEN both records. Without this the pole is consistent
    // with "the append was permitted because nothing looked at it".
    if (!/SIGNATURES: 2 record\(s\) verified/.test(r.out)) {
      return `the read gate did not verify BOTH records: ${r.out.slice(0, 300)}`;
    }
    if (!/2 record\(s\) of the CURRENT generation carried the per-emitter chain/.test(r.out)) {
      return `the appended record did not JOIN the chain — the append routed around it: ${r.out.slice(0, 300)}`;
    }
    return `GREEN:committed-evidence criterion=verifyAppendOnlyPrefix path=${EVENTS_REL} uncommitted-append=permitted generation=current chained=2 exit=0`;
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// ARM — a CLOSED generation may not GROW, and the read gate is what says so
// ═══════════════════════════════════════════════════════════════════════════
//
// THE DEFECT THIS PINS. `decideAppendSuite` refuses a PRODUCER append carrying a
// closed generation's schema, and `buildEvent` always stamps the current one — so
// the producer side was fenced three ways over. The READ GATE had no fence at all,
// and neither of the two checks it does run can see this by construction:
// `verifyAppendOnlyPrefix` permits everything past the committed prefix (that is
// its entire purpose), and `verifyChain` is scoped to the current generation and
// `continue`s a differing schema BEFORE `checked++`. A record stamped with the
// closed schema and appended therefore joined no chain, got no `seq`, and was
// invisible to the fork detector while every gate reported clean.
//
// The poles differ ONLY in whether the closed-generation record is COMMITTED. That
// is the whole boundary: 534 committed generation-0 records are legitimate evidence
// and must keep folding; a 535th appended beyond the prefix is growth.
pair(
  "closed-generation-may-not-grow",
  "a CLOSED-generation record appended BEYOND the committed prefix is refused, naming the generation and the byte boundary",
  () => {
    const dir = mkRepo({ events: evtLog({ gen0: true }) });
    fs.appendFileSync(path.join(dir, EVENTS_REL), evtLog({ gen0: true, over: { item_id: "R2-beta-item" } }));
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 2) return `a closed-generation append exited ${r.code}; it must be UNRUNNABLE (exit 2)`;
    if (r.out !== "") return `a refusal wrote to stdout: ${JSON.stringify(r.out.slice(0, 120))}`;
    if (!/^UNRUNNABLE — refusing because /m.test(r.err)) return "the refusal is not the LOUD UNRUNNABLE form";
    if (!/CLOSED/.test(r.err)) return `refused, but not on the closed-generation fence: ${r.err.slice(0, 200)}`;
    if (!/burndown-event\/v1/.test(r.err)) return "the refusal does not name WHICH generation is closed";
    if (!/BEYOND the committed prefix/.test(r.err)) return "the refusal does not name the committed-prefix boundary";
    if (!/line 2:/.test(r.err)) return "the refusal does not name WHICH line";
    for (const tok of ["chain INTACT", "ALL PAGES", "BURNDOWN:BEGIN"]) {
      if ((r.out + r.err).includes(tok)) return `the refusal carries the clean-summary token ${tok}`;
    }
    return `RED:closed-generation criterion=verifyClosedGenerationAppends schema=burndown-event/v1 line=2 boundary=committed-prefix exit=2`;
  },
  "the SAME closed-generation record, COMMITTED, is legitimate evidence and folds",
  () => {
    // Byte-identical log to the RED pole. The ONLY difference is that the second
    // record is inside the committed prefix — which is exactly the property under
    // test, and is why the two poles cannot both be explained by anything else.
    const dir = mkRepo({ events: evtLog({ gen0: true }) });
    fs.appendFileSync(path.join(dir, EVENTS_REL), evtLog({ gen0: true, over: { item_id: "R2-beta-item" } }));
    commitAll(dir, "commit the second generation-0 record");
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 0) return `a COMMITTED closed-generation record was refused (exit ${r.code}): ${r.err.slice(0, 250)}`;
    if (!/chain INTACT/.test(r.out)) return `unexpected stdout: ${r.out.slice(0, 200)}`;
    if (!/2 record\(s\) of a CLOSED prior generation were checked/.test(r.out)) {
      return `the fence did not report having examined both closed-generation records: ${r.out.slice(0, 300)}`;
    }
    return `GREEN:closed-generation criterion=verifyClosedGenerationAppends schema=burndown-event/v1 committed=2 exit=0`;
  },
);

check("closed-generation · MUTATION · exempting the fence lets the un-chained closed-generation append fold clean", () => {
  // The counterfactual, and it is the load-bearing measurement for this arm: if the
  // refusal above came from the prefix predicate, the chain, the fold or a schema
  // check, the mutant would refuse too and this would be UNRESOLVED rather than a
  // verdict. It exiting 0 is what proves NOTHING ELSE sees a closed-generation
  // append — which is the defect, stated as a measurement.
  const tool = mutantTool((s) =>
    subOnce(
      s,
      "  const closed = lib.verifyClosedGenerationAppends(text, pol.policy, committedBytes);",
      "  const closed = { ok: true, checked: 0 };",
    ),
  );
  const dir = mkRepo({ events: evtLog({ gen0: true }) });
  fs.appendFileSync(path.join(dir, EVENTS_REL), evtLog({ gen0: true, over: { item_id: "R2-beta-item" } }));
  const real = runGen(dir, ["--check-links"]);
  const mutant = runGen(dir, ["--check-links"], tool);
  if (real.code !== 2) return `the real binary did not refuse the closed-generation append (exit ${real.code})`;
  if (mutant.code !== 0) {
    return `the mutant ALSO refused (exit ${mutant.code}) — UNRESOLVED, not a verdict: ${mutant.err.slice(0, 250)}`;
  }
  if (!/chain INTACT/.test(mutant.out)) return `the mutant exited 0 but printed no verdict: ${mutant.out.slice(0, 200)}`;
  return true;
});

check("committed-prefix · MUTATION · exempting the log from the prefix gate lets a TAMPERED log pass", () => {
  // The counterfactual: drop the append-only check entirely for the log. If the real
  // binary's refusal above came from anywhere else, the mutant would still refuse.
  // The mutation IGNORES the predicate's VERDICT rather than deleting the call.
  // Stubbing `const r = { ok: true }` also destroyed `r.committedBytes`, which the
  // closed-generation fence needs and which fails CLOSED when absent — so the
  // mutant refused for a reason that had nothing to do with the prefix gate and
  // the case reported UNRESOLVED. Exempting only the refusal is the faithful
  // counterfactual, and the breach return carries `committedBytes` too, so the
  // fence downstream still gets a real boundary.
  const tool = mutantTool((s) =>
    subOnce(
      s,
      "    if (!r.ok) refuse(`event log '${trackerRel}': ${r.reason}`);",
      "    if (false && !r.ok) refuse(`event log '${trackerRel}': ${r.reason}`);",
    ),
  );
  // Gen-0, for the reason spelled out in the RED pole above: the chain must NOT be
  // able to catch this deletion, or the mutant refuses too and measures nothing.
  const dir = mkRepo({ events: evtLog({ gen0: true }, { gen0: true }) });
  const lines = fs.readFileSync(path.join(dir, EVENTS_REL), "utf8").split("\n").filter((l) => l.trim());
  fs.writeFileSync(path.join(dir, EVENTS_REL), `${lines.slice(1).join("\n")}\n`);
  const real = runGen(dir, ["--check-links"]);
  const mutant = runGen(dir, ["--check-links"], tool);
  if (real.code !== 2) return `the real binary did not refuse the tampered log (exit ${real.code})`;
  if (mutant.code !== 0) {
    return `the mutant ALSO refused (exit ${mutant.code}) — UNRESOLVED, not a verdict: ${mutant.err.slice(0, 200)}`;
  }
  return true;
});

// ═══════════════════════════════════════════════════════════════════════════
// ARM — a malformed line REFUSES rather than folding around its own corruption
// ═══════════════════════════════════════════════════════════════════════════

pair(
  "malformed-line-refuses",
  "an unreadable committed line refuses, naming the line and the reason",
  () => {
    const dir = mkRepo({ events: evtLog({}, '{"schema":"burndown-event/v9","kind":"invented"}\n') });
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 2) return `a corrupt log exited ${r.code}; it must be UNRUNNABLE (exit 2)`;
    if (!/unreadable line\(s\)/.test(r.err)) return `refused, but not for corruption: ${r.err.slice(0, 200)}`;
    if (!/line 2:/.test(r.err)) return "the refusal does not name WHICH line";
    if (!/unknown schema/.test(r.err)) return "the refusal does not name WHY the line is unreadable";
    return `RED:log-integrity criterion=malformed-line line=2 reason=unknown-schema exit=2`;
  },
  "a genesis SUPERSEDED by a live transition is skipped WITHOUT being called corruption",
  () => {
    // The C5 fence reports through the same `skipped[]` array. Counting its skips as
    // corruption would refuse a healthy log the first time real work superseded a
    // backfill — so the fold's arithmetic must separate them.
    const dir = mkRepo({
      events:
        evtLog({ over: { kind: "transition", weight: "live", status: "todo:in_progress" } }, {}),
    });
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 0) return `a superseded genesis was treated as corruption (exit ${r.code}): ${r.err.slice(0, 200)}`;
    if (!/chain INTACT — 1 ADJUDICATED item\(s\)/.test(r.out)) return `unexpected stdout: ${r.out.slice(0, 200)}`;
    return `GREEN:log-integrity criterion=malformed-line line=none reason=c5-fence-not-corruption exit=0`;
  },
);

// ── the malformed-line mutation, RE-DERIVED because the substrate changed ──
//
// This case used to make ONE mutation (drop the fold's malformed refusal) and assert
// the corrupt log then folded CLEAN. That assertion is now FALSE, and it is false for
// a good reason: the read gate classifies every line against the manifest's declared
// generations before the projection is used, and a line carrying an invented schema
// belongs to no declared generation — so NOTHING says which suite verifies it, which
// is INDETERMINATE and refuses. Two independent gates now see the same corruption.
//
// Restating the old assertion would have been the honest failure; suppressing the case
// would have been the dishonest one. Instead the claim is re-derived into the three
// facts that are now true, each measured separately, because "two gates catch it" is a
// STRONGER property than the one this case was written to pin and is worth pinning as
// such:
//
//   1. exempting the FOLD's refusal alone does NOT let the corruption through — the
//      read gate independently refuses. (defense in depth, and the reason the old
//      assertion had to change)
//   2. and it refuses with a DIFFERENT reason than the real binary's, which is what
//      proves the fold's refusal was genuinely REACHED and produced the real
//      binary's message rather than being dead code some other check shadowed.
//   3. exempting BOTH gates DOES let it fold clean — which is what proves neither is
//      vacuous. Without (3), (1) and (2) are equally consistent with "some third
//      thing refuses everything", and `instrument-discipline.md` MUST-2(b) is
//      explicit that a non-reddening mutation leaves two live hypotheses.
check("malformed-line · MUTATION · the fold's refusal and the read gate INDEPENDENTLY catch corruption; removing BOTH folds it clean", () => {
  const dropFold = (s) => subOnce(s, "  if (malformed.length > 0) {", "  if (false && malformed.length > 0) {");
  const dropReadGate = (s) =>
    subOnce(
      s,
      "      sigVerdict = verifySignedLog(repo, manifestRel, trackerRel, text, committedBytes);",
      "      sigVerdict = null; void verifySignedLog;",
    );
  const foldExempt = mutantTool(dropFold);
  const bothExempt = mutantTool((s) => dropReadGate(dropFold(s)));
  const dir = mkRepo({ events: evtLog({}, '{"schema":"burndown-event/v9","kind":"invented"}\n') });
  const real = runGen(dir, ["--check-links"]);
  const one = runGen(dir, ["--check-links"], foldExempt);
  const both = runGen(dir, ["--check-links"], bothExempt);

  if (real.code !== 2) return `the real binary did not refuse the corrupt log (exit ${real.code})`;
  if (!/unreadable line\(s\)/.test(real.err)) return `the real binary refused, but not on the FOLD's message: ${real.err.slice(0, 200)}`;
  // (1) + (2)
  if (one.code !== 2) return `exempting the fold's refusal let the corrupt log through (exit ${one.code}) — the read gate did NOT hold it`;
  if (/unreadable line\(s\)/.test(one.err)) {
    return "the fold-exempted mutant STILL produced the fold's own message — the mutation did not reach the refusal it targeted";
  }
  if (!/INDETERMINATE/.test(one.err)) {
    return `the fold-exempted mutant refused for a third, unexpected reason — UNRESOLVED: ${one.err.slice(0, 200)}`;
  }
  // (3) — the corruption really does get through once BOTH guards are gone, so
  // neither was vacuous and neither was shadowed by something else.
  if (both.code !== 0) {
    return `with BOTH guards exempted the log STILL refused (exit ${both.code}) — UNRESOLVED, not a verdict: ${both.err.slice(0, 200)}`;
  }
  if (!/chain INTACT/.test(both.out)) return `the double mutant exited 0 but printed no verdict: ${both.out.slice(0, 200)}`;
  return true;
});

// ═══════════════════════════════════════════════════════════════════════════
// ARM — the self-input floor covers the LOG, so the chain cannot verify itself
// ═══════════════════════════════════════════════════════════════════════════
//
// ISOLATION MATTERS HERE. Under `event-log` the log is also `tracker.path`, which was
// already a self-input — so a `burndown/` root would refuse even without the change,
// and a case built that way would be VACUOUS about what the change added. The RED
// pole below is therefore a `forest-ledger` manifest whose sources live OUTSIDE
// `burndown/`: the log is then the ONLY self-input under the declared root, so the
// refusal can have come from nowhere else.

pair(
  "selfinput-floor-covers-the-log",
  "a 'burndown/' anchor root is refused because it admits the EVENT LOG itself",
  () => {
    const dir = mkRepo({
      trackerKind: "forest-ledger",
      trackerPath: ".session-notes.shared.md",
      sourcePath: "data/register.json",
      anchorRoots: ["burndown/"],
    });
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 2) return `a self-admitting root exited ${r.code}; it must be UNRUNNABLE (exit 2)`;
    if (!/admits the burndown's own input/.test(r.err)) return `refused, but not for self-admission: ${r.err.slice(0, 200)}`;
    if (!r.err.includes(EVENTS_REL)) {
      return `refused for a DIFFERENT self-input than the log — this case is not isolating the log: ${r.err.slice(0, 240)}`;
    }
    return `RED:selfinput-floor criterion=anchor_roots-tautology root=burndown/ clash=${EVENTS_REL} exit=2`;
  },
  "a durable root that admits no burndown input resolves the chain normally",
  () => {
    const dir = mkRepo({
      trackerKind: "forest-ledger",
      trackerPath: ".session-notes.shared.md",
      sourcePath: "data/register.json",
      anchorRoots: ["journal/"],
      // The table IS the tracker under this kind, so it must carry the row.
    });
    fs.writeFileSync(
      path.join(dir, ".session-notes.shared.md"),
      `| ID | item | value_anchor |\n| --- | --- | --- |\n| ${ITEM_ID} | an alpha item | ${ANCHOR_FILE}#${ITEM_ID} |\n`,
    );
    commitAll(dir, "populate the ledger table");
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 0) return `a clean root exited ${r.code}: ${r.err.slice(0, 200)}`;
    if (!/chain INTACT — 1 ADJUDICATED item\(s\)/.test(r.out)) return `unexpected stdout: ${r.out.slice(0, 200)}`;
    return `GREEN:selfinput-floor criterion=anchor_roots-tautology root=journal/ clash=none exit=0`;
  },
);

check("selfinput-floor · MUTATION · removing EVENTS_REL from selfInputs re-opens the tautology", () => {
  const tool = mutantTool((s) => subOnce(s, "    joinRel(t.path),\n    EVENTS_REL,\n", "    joinRel(t.path),\n"));
  const dir = mkRepo({
    trackerKind: "forest-ledger",
    trackerPath: ".session-notes.shared.md",
    sourcePath: "data/register.json",
    anchorRoots: ["burndown/"],
  });
  const real = runGen(dir, ["--check-links"]);
  const mutant = runGen(dir, ["--check-links"], tool);
  if (real.code !== 2) return `the real binary did not refuse the self-admitting root (exit ${real.code})`;
  if (/admits the burndown's own input/.test(mutant.err)) {
    return "the mutant STILL refused for self-admission — the floor is held by something other than EVENTS_REL, so this is UNRESOLVED";
  }
  return true;
});

// ═══════════════════════════════════════════════════════════════════════════
// ARM — the INVENTORY is a self-input too
// ═══════════════════════════════════════════════════════════════════════════
//
// Found by an adversarial review of this very change, and it was LIVE: the inventory
// enumerates every item id by construction (that is what makes it the coverage
// denominator), and it was the one burndown input absent from `selfInputs`. A manifest
// moving it under its own root and anchoring every item at it cleared every clause of
// the floor and every leg of `resolveAnchor` — `chain INTACT`, LINK-2 and LINK-3 both
// vacuous. The log arm above could not see it: `mkRepo` declared no inventory at all.

function mkInventoryRepo(anchorRoots) {
  const dir = mkRepo({ trackerKind: "forest-ledger", trackerPath: ".session-notes.shared.md", anchorRoots });
  fs.mkdirSync(path.join(dir, "inv"), { recursive: true });
  // The inventory carries the id verbatim — which is exactly why anchoring at it
  // satisfies LINK-3 for every item by construction.
  fs.writeFileSync(
    path.join(dir, "inv", "inventory.json"),
    JSON.stringify({ items: [{ id: ITEM_ID }] }, null, 2),
  );
  const mPath = path.join(dir, "burndown-manifest.json");
  const m = JSON.parse(fs.readFileSync(mPath, "utf8"));
  m.inventory = { path: "inv/inventory.json" };
  fs.writeFileSync(mPath, JSON.stringify(m, null, 2));
  fs.writeFileSync(
    path.join(dir, ".session-notes.shared.md"),
    `| ID | item | value_anchor |\n| --- | --- | --- |\n| ${ITEM_ID} | an alpha item | inv/inventory.json |\n`,
  );
  commitAll(dir, "an inventory outside burndown/, and a row anchored AT it");
  return dir;
}

pair(
  "selfinput-floor-covers-the-inventory",
  "an anchor root admitting the INVENTORY is refused — it carries every id by construction",
  () => {
    const dir = mkInventoryRepo(["inv/"]);
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 2) return `a root admitting the inventory exited ${r.code}; it must be UNRUNNABLE (exit 2)`;
    if (!/admits the burndown's own input/.test(r.err)) return `refused for another reason: ${r.err.slice(0, 200)}`;
    if (!/inv\/inventory\.json/.test(r.err)) {
      return `refused for a DIFFERENT self-input than the inventory: ${r.err.slice(0, 240)}`;
    }
    return `RED:selfinput-inventory criterion=anchor_roots-tautology root=inv/ clash=inv/inventory.json exit=2`;
  },
  "the same inventory under a root that does not admit it resolves normally",
  () => {
    const dir = mkInventoryRepo(["journal/"]);
    fs.writeFileSync(
      path.join(dir, ".session-notes.shared.md"),
      `| ID | item | value_anchor |\n| --- | --- | --- |\n| ${ITEM_ID} | an alpha item | ${ANCHOR_FILE}#${ITEM_ID} |\n`,
    );
    commitAll(dir, "anchor at the journal instead");
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 0) return `a clean root exited ${r.code}: ${r.err.slice(0, 200)}`;
    if (!/chain INTACT — 1 ADJUDICATED item\(s\)/.test(r.out)) return `unexpected stdout: ${r.out.slice(0, 200)}`;
    return `GREEN:selfinput-inventory criterion=anchor_roots-tautology root=journal/ clash=none exit=0`;
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// ARM — manifest paths are shape-checked at EVERY site, not just two
// ═══════════════════════════════════════════════════════════════════════════
//
// `tracker.path` and `inventory.path` each carried three private clauses;
// `sources[].path` and `target` carried none, and `target` is the one that is
// WRITTEN. None of the four rejected git PATHSPEC MAGIC — which the original comment
// named as a closed case while the code never checked it. MEASURED here:
// `git ls-files -s -- ':(attr:x'` exits 128, which throws a non-typed error out of
// `git()`, printing the operator's absolute path and exiting 1 (the STALE code).

pair(
  "manifest-paths-shape-checked-everywhere",
  "a pathspec-magic tracker.path is REFUSED, not handed to git",
  () => {
    const dir = mkRepo({ trackerKind: "forest-ledger", trackerPath: ":(attr:x" });
    const r = runGen(dir, ["--check-links"]);
    if (r.code === 1) return `exit 1 — the crash is still misreported as STALE: ${r.err.slice(0, 200)}`;
    if (r.code !== 2) return `a pathspec-magic path exited ${r.code}; it must be UNRUNNABLE (exit 2)`;
    if (/at Object\.|node:internal|\/Users\//.test(r.err)) {
      return `the refusal carries a stack trace or an absolute path: ${r.err.slice(0, 240)}`;
    }
    if (!/is not a repo-relative path/.test(r.err)) return `refused for another reason: ${r.err.slice(0, 200)}`;
    return `RED:path-shape criterion=repo-relative site=tracker.path value=pathspec-magic exit=2`;
  },
  "a traversing TARGET is REFUSED — it is the one manifest path that gets WRITTEN",
  () => {
    const dir = mkRepo();
    const mPath = path.join(dir, "burndown-manifest.json");
    const m = JSON.parse(fs.readFileSync(mPath, "utf8"));
    m.target = "../../../tmp/burndown-escape.md";
    fs.writeFileSync(mPath, JSON.stringify(m, null, 2));
    commitAll(dir, "a target that traverses out of the repo");
    const r = runGen(dir, ["--write"]);
    if (r.code !== 2) return `a traversing target exited ${r.code}; it must be UNRUNNABLE (exit 2)`;
    if (!/declares target .* which is not a repo-relative path/.test(r.err)) {
      return `refused for another reason: ${r.err.slice(0, 200)}`;
    }
    if (fs.existsSync("/tmp/burndown-escape.md")) return "the write escaped the repository";
    return `GREEN:path-shape criterion=repo-relative site=target value=traversal exit=2`;
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// ARM — the EVENTS_REL mirror is asserted on the forest-ledger path too
// ═══════════════════════════════════════════════════════════════════════════
//
// The drift check used to live inside the lazy loader, which runs ONLY under
// `event-log` — while the mirrored constant is consumed by the self-input floor under
// BOTH kinds. So it was unreachable on exactly the case the mirror was written for.
// MEASURED before the fix, with the library's sink drifted and a `forest-ledger`
// manifest anchoring every item AT the drifted sink: `chain INTACT`.

/**
 * Build a generator whose lazy require resolves to a MUTATED copy of the event
 * library. Two rebases are needed and the second was learned the hard way: the
 * library `require`s its siblings relative to its OWN `__dirname`, so a copy in a
 * bare temp dir fails to LOAD — and `tryEventsLib` swallows a load failure by design
 * (absent is not drift), so the case exited 0 and would have read as "no drift" while
 * measuring nothing. Rebasing the library's own dependencies onto absolute paths is
 * what makes the mutant actually reach the code under test.
 *
 * `SIBLING_DEPS` is enumerated rather than pattern-rewritten so that a NEW sibling
 * dependency added to the library fails LOUDLY here (the `require(libP)` reachability
 * assertion below throws MODULE_NOT_FOUND) instead of silently resurrecting the
 * measuring-nothing mode above. `signed-log.js` was exactly that: it was added to the
 * library after this helper was written, and the three cases built on this helper went
 * red with `Cannot find module .../signed-log.js` until it was enumerated here.
 *
 * `git-subprocess-env.js` is the THIRD, and it arrived by exactly the route the
 * paragraph above predicts: the authority binding (component 12) gave the library a
 * COMMITTED-roster read, that read runs through the shared subprocess envelope, and the
 * three cases built on this helper went red with `Cannot find module
 * .../git-subprocess-env.js` until it was enumerated. The loud failure is the feature.
 *
 * `eligibility.js` is the FOURTH, and it arrived the same way: the authority binding
 * delegates the R5-S-04 audit-only-host exclusion and the role floor to that module's
 * `isEligibleSigner` rather than inlining a fourth copy of the predicate.
 */
const SIBLING_DEPS = ["coc-append.js", "signed-log.js", "git-subprocess-env.js", "eligibility.js"];

function mkLibVariantTool(mutateLib, tag) {
  const libSrc = fs.readFileSync(LIB, "utf8");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `bd-${tag}-`));
  tmpDirs.push(d);
  const libP = path.join(d, "burndown-events.js");
  let rebased = libSrc;
  for (const dep of SIBLING_DEPS) {
    rebased = subOnce(
      rebased,
      `require(path.join(__dirname, ${JSON.stringify(dep)}))`,
      `require(${JSON.stringify(path.join(REPO_ROOT, ".claude", "hooks", "lib", dep))})`,
    );
  }
  fs.writeFileSync(libP, mutateLib(rebased));
  // Reachability, asserted BEFORE the mutant's verdict is read: the variant must LOAD.
  // Without this a load failure is indistinguishable from the behaviour under test.
  require(libP);
  return mutantTool((s) => subOnce(s, `const rel = ${JSON.stringify(LIB)};`, `const rel = ${JSON.stringify(libP)};`));
}

function mkDriftedLibTool() {
  return mkLibVariantTool(
    (s) => subOnce(s, 'const EVENTS_REL = "burndown/events.jsonl";', 'const EVENTS_REL = "evlog/log.jsonl";'),
    "driftlib",
  );
}

pair(
  "mirror-drift-caught-on-both-kinds",
  "a drifted library sink is caught even on a FOREST-LEDGER manifest, where the fold never runs",
  () => {
    const tool = mkDriftedLibTool();
    const dir = mkRepo({ trackerKind: "forest-ledger", trackerPath: ".session-notes.shared.md" });
    fs.writeFileSync(
      path.join(dir, ".session-notes.shared.md"),
      `| ID | item | value_anchor |\n| --- | --- | --- |\n| ${ITEM_ID} | an alpha item | ${ANCHOR_FILE}#${ITEM_ID} |\n`,
    );
    commitAll(dir, "populate the ledger table");
    const r = runGen(dir, ["--check-links"], tool);
    if (r.code !== 2) return `a drifted mirror exited ${r.code} on forest-ledger; it must be UNRUNNABLE (exit 2)`;
    if (!/The mirror has DRIFTED/.test(r.err)) return `refused for another reason: ${r.err.slice(0, 240)}`;
    if (!/evlog\/log\.jsonl/.test(r.err)) return "the refusal does not name the library's drifted value";
    return `RED:mirror-drift criterion=EVENTS_REL-mirror kind=forest-ledger lib_sink=evlog/log.jsonl exit=2`;
  },
  "an undrifted library leaves the same forest-ledger manifest resolving normally",
  () => {
    const dir = mkRepo({ trackerKind: "forest-ledger", trackerPath: ".session-notes.shared.md" });
    fs.writeFileSync(
      path.join(dir, ".session-notes.shared.md"),
      `| ID | item | value_anchor |\n| --- | --- | --- |\n| ${ITEM_ID} | an alpha item | ${ANCHOR_FILE}#${ITEM_ID} |\n`,
    );
    commitAll(dir, "populate the ledger table");
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 0) return `an undrifted mirror exited ${r.code}: ${r.err.slice(0, 200)}`;
    if (/DRIFTED/.test(r.err)) return "drift was reported against an undrifted library";
    return `GREEN:mirror-drift criterion=EVENTS_REL-mirror kind=forest-ledger lib_sink=${EVENTS_REL} exit=0`;
  },
);

// ── standalone: PRESENT-but-incompatible is a typed refusal, not exit 1 ─────
check("lazy-dep · a library that loads but exports no fold is a TYPED refusal, not a STALE exit 1", () => {
  // Keeps EVENTS_REL, drops the fold from the export surface — a stale hooks tree,
  // which is the realistic shape. Before the contract check this escaped as
  // `TypeError: foldEvents is not a function`, exit 1 (the code reserved for STALE),
  // with the operator's absolute path in the trace.
  const tool = mkLibVariantTool((s) => subOnce(s, "  foldEvents,\n", ""), "stalelib");
  const dir = mkRepo();
  const r = runGen(dir, ["--check-links"], tool);
  if (r.code === 1) return `still exit 1 — a crash misreported as STALE: ${r.err.slice(0, 240)}`;
  if (r.code !== 2) return `exited ${r.code}; a present-but-incompatible library must be UNRUNNABLE (exit 2)`;
  if (!/exports no 'foldEvents' function/.test(r.err)) return `refused for another reason: ${r.err.slice(0, 240)}`;
  if (/node:internal|TypeError|\/Users\//.test(r.err)) return "the refusal carries a stack trace or an absolute path";
  return true;
});

// ── standalone: supersessions are REPORTED, never silent ───────────────────
check("A4 · a superseded event is counted and stated in the verdict", () => {
  const dir = mkRepo({
    events:
      evtLog(
        { over: { kind: "transition", weight: "live", status: "todo:pending" } },
        { over: { kind: "transition", weight: "live", status: "todo:in_progress" } },
      ),
  });
  const r = runGen(dir, ["--check-links"]);
  if (r.code !== 0) return `two transitions for one item exited ${r.code}: ${r.err.slice(0, 200)}`;
  if (!/SUPERSEDED: 1 event\(s\)/.test(r.out)) {
    return `the supersession is invisible in the verdict: ${r.out.slice(0, 300)}`;
  }
  // Control: with ONE event the same line must read 0, or the counter is not counting.
  const solo = mkRepo();
  const r2 = runGen(solo, ["--check-links"]);
  if (!/SUPERSEDED: 0/.test(r2.out)) return `the control did not read 0: ${r2.out.slice(0, 300)}`;
  return true;
});

// ── standalone: an ABSENT row floor is reported ABSENT, never clean ─────────
check("log-integrity · an undeclared min_rows is reported ABSENT, not silently omitted", () => {
  const dir = mkRepo();
  const r = runGen(dir, ["--check-links"]);
  if (r.code !== 0) return `exited ${r.code}: ${r.err.slice(0, 200)}`;
  if (!/ROW FLOOR: NOT DECLARED/.test(r.out)) return `absence is not surfaced: ${r.out.slice(0, 300)}`;
  const declared = mkRepo({ minRows: 1 });
  const r2 = runGen(declared, ["--check-links"]);
  if (!/ROW FLOOR: 1 folded item\(s\) against a declared floor of 1/.test(r2.out)) {
    return `the declared case does not read differently: ${r2.out.slice(0, 300)}`;
  }
  return true;
});

// ═══════════════════════════════════════════════════════════════════════════
// ARM — min_rows survives as a LOG-INTEGRITY floor
// ═══════════════════════════════════════════════════════════════════════════

pair(
  "min_rows-log-integrity-floor",
  "a log that LOST an append falls below the declaration and refuses as monotonicity broken",
  () => {
    const dir = mkRepo({
      events: evtLog({}, { over: { item_id: "R2-beta-item" } }),
      minRows: 2,
    });
    // Truncate the log — the shape a history rewrite or a dropped merge side takes.
    fs.writeFileSync(path.join(dir, EVENTS_REL), evtLine());
    commitAll(dir, "the log lost an append");
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 2) return `a shrunken log exited ${r.code}; it must be UNRUNNABLE (exit 2)`;
    if (!/carries 1 row\(s\) but the manifest declares it was last reconciled at 2/.test(r.err)) {
      return `refused, but not on the row floor: ${r.err.slice(0, 200)}`;
    }
    if (!/APPEND-ONLY log's projection is monotonic/.test(r.err)) {
      return "the refusal still reads as a hand-removal diagnosis, which is the WRONG remedy for a log";
    }
    return `RED:min_rows criterion=log-integrity-floor declared=2 folded=1 exit=2`;
  },
  "a log at or above its declaration folds and the chain holds",
  () => {
    const dir = mkRepo({ events: evtLine(), minRows: 1 });
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 0) return `a healthy log exited ${r.code}: ${r.err.slice(0, 200)}`;
    if (!/chain INTACT — 1 ADJUDICATED item\(s\)/.test(r.out)) return `unexpected stdout: ${r.out.slice(0, 200)}`;
    return `GREEN:min_rows criterion=log-integrity-floor declared=1 folded=1 exit=0`;
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// ARM — RETRACTION RETIRES IN PLACE, so the min_rows floor KEEPS its teeth
// ═══════════════════════════════════════════════════════════════════════════
//
// THE ARM THAT PINS THE RECONCILIATION. Widening the kind vocabulary with a retraction
// threatened the floor above: that gate is a LOG-INTEGRITY floor precisely because an
// append-only log's projection is monotonic in POPULATION, and a retraction that
// removed the item would have falsified the premise. The two poles are the same tree
// differing in ONE respect — whether the second item was LOST or RETRACTED — and they
// must land on opposite verdicts. If they did not, the floor would either fire on
// ordinary work or have gone silent on a real loss.

/** A REALLY-SIGNED owner-authored retraction of `id`, as a whole correctly-chained log. */
function retractionLog(id, anchorFile) {
  return evtLog(
    { over: { item_id: ITEM_ID } },
    { over: { item_id: "R2-beta-item", value_anchor: `${anchorFile}#R2-beta-item` } },
    {
      over: {
        kind: "retraction",
        weight: "live",
        authority: "owner",
        status: "retired",
        reason: "retired by the owner: the work moved to another item",
        item_id: id,
        value_anchor: `${anchorFile}#${id}`,
      },
    },
  );
}

pair(
  "retraction-retires-in-place-floor-keeps-teeth",
  "the same population LOST to a truncation falls below the floor and refuses",
  () => {
    const dir = mkRepo({
      events: evtLog({ over: { item_id: ITEM_ID } }, { over: { item_id: "R2-beta-item", value_anchor: `${ANCHOR_FILE}#R2-beta-item` } }),
      minRows: 2,
      roster: { role: "owner" },
    });
    fs.writeFileSync(path.join(dir, ANCHOR_FILE), `# Alpha\n\nRulings for ${ITEM_ID} and R2-beta-item are recorded here.\n`);
    fs.writeFileSync(path.join(dir, "burndown", "register.json"), fs.readFileSync(path.join(dir, "burndown", "register.json"), "utf8").replace(/"items": \[[\s\S]*?\]/, `"items": [{"id": "${ITEM_ID}", "page": "Alpha", "status": "In progress"}, {"id": "R2-beta-item", "page": "Alpha", "status": "In progress"}]`));
    commitAll(dir, "two items");
    // Drop the SECOND record — a truncation, a dropped merge side, a rewritten history.
    fs.writeFileSync(path.join(dir, EVENTS_REL), evtLog({ over: { item_id: ITEM_ID } }));
    commitAll(dir, "the log lost an append");
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 2) return `a shrunken log exited ${r.code}; it must be UNRUNNABLE (exit 2)`;
    if (!/carries 1 row\(s\) but the manifest declares it was last reconciled at 2/.test(r.err)) {
      return `refused, but not on the row floor: ${r.err.slice(0, 240)}`;
    }
    return `RED:retire-in-place criterion=min_rows cause=truncation declared=2 folded=1 exit=2`;
  },
  "the same population RETIRED by an owner retraction holds the floor, and is REPORTED as retired",
  () => {
    const dir = mkRepo({
      events: retractionLog("R2-beta-item", ANCHOR_FILE),
      minRows: 2,
      roster: { role: "owner" },
    });
    fs.writeFileSync(path.join(dir, ANCHOR_FILE), `# Alpha\n\nRulings for ${ITEM_ID} and R2-beta-item are recorded here.\n`);
    fs.writeFileSync(path.join(dir, "burndown", "register.json"), fs.readFileSync(path.join(dir, "burndown", "register.json"), "utf8").replace(/"items": \[[\s\S]*?\]/, `"items": [{"id": "${ITEM_ID}", "page": "Alpha", "status": "In progress"}, {"id": "R2-beta-item", "page": "Alpha", "status": "In progress"}]`));
    commitAll(dir, "two items, one retracted");
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 0) return `a retraction took the gate UNRUNNABLE (exit ${r.code}) — the floor now fires on ordinary work: ${r.err.slice(0, 300)}`;
    if (!/ROW FLOOR: 2 folded item\(s\) against a declared floor of 2/.test(r.out)) {
      return `the retracted item left the population: ${r.out.slice(0, 400)}`;
    }
    if (!/RETIRED: 1 of 2 folded item\(s\)/.test(r.out)) return `the retirement was not REPORTED: ${r.out.slice(0, 400)}`;
    if (!/R2-beta-item/.test(r.out)) return "the RETIRED line does not name WHICH item";
    return `GREEN:retire-in-place criterion=min_rows cause=retraction declared=2 folded=2 retired=1 exit=0`;
  },
);

// ── MUTATION: the coupling is REAL, not a hypothetical the comment invented ──
//
// The design note in `burndown-build.mjs` claims that a retraction which REMOVED the
// item would have broken the min_rows floor. `instrument-discipline.md` MUST-2(b): a
// claim like that is worth nothing unless the counterfactual is shown to red. So the
// REJECTED DESIGN is built — retired items dropped from the counted population, one
// line, immediately above the floor — and the SAME healthy tree the GREEN pole above
// passes on is re-run against it.
//
// MUTATED AT THE CONSUMER, not in the fold, and the reason is a measurement rather than
// a preference. Mutating `_walk` to `rows.delete` on a retraction DOES red — the
// mutation is live either way — but it reds on the SUPERSESSION cross-check
// ("the fold recorded 1 supersession(s) while this reader derives 2"), which fires
// before the floor and shadows it. That is a second instrument seeing the same change,
// and it is worth knowing; it is not what this case is about. Mutating the consumer's
// population directly puts the verdict where the claim is.
check("retire-in-place · MUTATION · a retraction that REMOVED the row makes the floor fire on ordinary work", () => {
  const tool = mutantTool((s) =>
    subOnce(
      s,
      "  if (t.min_rows !== undefined) {",
      "  if (folded) for (const id of folded.retired) rows.delete(id);\n  if (t.min_rows !== undefined) {",
    ),
  );
  const mk = () => {
    const dir = mkRepo({ events: retractionLog("R2-beta-item", ANCHOR_FILE), minRows: 2, roster: { role: "owner" } });
    fs.writeFileSync(path.join(dir, ANCHOR_FILE), `# Alpha\n\nRulings for ${ITEM_ID} and R2-beta-item are recorded here.\n`);
    fs.writeFileSync(
      path.join(dir, "burndown", "register.json"),
      fs
        .readFileSync(path.join(dir, "burndown", "register.json"), "utf8")
        .replace(/"items": \[[\s\S]*?\]/, `"items": [{"id": "${ITEM_ID}", "page": "Alpha", "status": "In progress"}, {"id": "R2-beta-item", "page": "Alpha", "status": "In progress"}]`),
    );
    commitAll(dir, "two items, one retracted");
    return dir;
  };
  // The real binary's verdict on this tree, so the mutant's verdict is read against a
  // control rather than in isolation.
  const real = runGen(mk(), ["--check-links"]);
  if (real.code !== 0) return `the control tree is not healthy under the REAL generator (exit ${real.code}): ${real.err.slice(0, 240)}`;
  const mutated = runGen(mk(), ["--check-links"], tool);
  if (mutated.code === 0) {
    return "the mutation did NOT red — either the fold's retire-in-place line is not what holds the population, or the mutation never reached it. Two live hypotheses, no vacuity verdict.";
  }
  if (!/carries 1 row\(s\) but the manifest declares it was last reconciled at 2/.test(mutated.err)) {
    return `the mutant refused, but not on the row floor — the mutation reached something else: ${mutated.err.slice(0, 240)}`;
  }
  return true;
});

// ═══════════════════════════════════════════════════════════════════════════
// ARM — `authority` IS BOUND TO A ROSTERED SIGNER ROLE (component 12)
// ═══════════════════════════════════════════════════════════════════════════
//
// The record in both poles is REALLY SIGNED by the SAME key and is byte-identical
// apart from nothing at all: the poles differ ONLY in what the COMMITTED roster says
// that signer's role is. That is the whole claim — `authority` was a self-declared
// field, the signature proves WHO wrote it, and the roster is what proves they were
// entitled to. A pair that varied the record instead would be testing the validator.

/** A really-signed record claiming `authority: "owner"`. */
const OWNER_CLAIM = () => evtLine({ kind: "transition", weight: "live", authority: "owner", status: "Signed off" });

pair(
  "authority-bound-to-roster-role",
  "an `owner` claim from a signer the COMMITTED roster rosters as CONTRIBUTOR is refused",
  () => {
    const dir = mkRepo({ events: OWNER_CLAIM(), roster: { role: "contributor" } });
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 2) return `an unbacked owner claim exited ${r.code}; it must be UNRUNNABLE (exit 2)`;
    if (!/authority not backed by role/.test(r.err)) return `refused for another reason: ${r.err.slice(0, 300)}`;
    if (!/authority-unbacked/.test(r.err)) return "the refusal does not classify the finding as a DECIDED one";
    if (/could not be EVALUATED/.test(r.err)) return "a decidable, FALSE claim was reported as an outage";
    return `RED:authority criterion=role-binding claimed=owner rostered=contributor exit=2`;
  },
  "the SAME signed record, with the SAME signature, passes once the roster rosters that signer as OWNER",
  () => {
    const dir = mkRepo({ events: OWNER_CLAIM(), roster: { role: "owner", host_role: "human" } });
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 0) return `a backed owner claim exited ${r.code}: ${r.err.slice(0, 300)}`;
    if (!/AUTHORITY: 1 record\(s\) claiming a role-bound authority/.test(r.out)) {
      return `the binding did not report its denominator: ${r.out.slice(0, 400)}`;
    }
    return `GREEN:authority criterion=role-binding claimed=owner rostered=owner checked=1 exit=0`;
  },
);

pair(
  "authority-outage-is-not-forgery",
  "a roster entry with NO declared role makes the claim INDETERMINATE, and it SAYS so",
  () => {
    const dir = mkRepo({ events: OWNER_CLAIM(), roster: { omitRole: true } });
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 2) return `an unevaluable owner claim exited ${r.code}; it must be UNRUNNABLE (exit 2)`;
    if (!/could not be EVALUATED/.test(r.err)) {
      return `refused, but not as an outage — an outage reported as a forgery sends the operator after an adversary who is not there: ${r.err.slice(0, 300)}`;
    }
    if (!/authority-indeterminate/.test(r.err)) return "the finding is not classified INDETERMINATE";
    if (!/unrecognized roster role/.test(r.err)) return "the refusal does not name what is missing from the roster";
    return `RED:authority-outage criterion=three-states state=INDETERMINATE exit=2`;
  },
  "a roster that DOES declare the role produces a DECIDED refusal instead, naming the role it found",
  () => {
    const dir = mkRepo({ events: OWNER_CLAIM(), roster: { role: "contributor" } });
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 2) return `expected the decided refusal at exit 2, got ${r.code}`;
    if (/could not be EVALUATED/.test(r.err)) return "a decidable claim was still reported as an outage";
    if (!/role 'contributor'/.test(r.err)) return `the refusal does not name the role it found: ${r.err.slice(0, 300)}`;
    if (!/insufficient for 'ledger-authority'/.test(r.err)) return "the refusal does not name the signing context the claim resolved to";
    return `GREEN:authority-outage criterion=three-states state=INVALID role=contributor exit=2`;
  },
);

// ── standalone: an audit-only CI host is never eligible, at the GATE ────────
check("authority · a rostered OWNER on a `host_role: ci` host is refused at the read gate (R5-S-04)", () => {
  const dir = mkRepo({ events: OWNER_CLAIM(), roster: { role: "owner", host_role: "ci" } });
  const r = runGen(dir, ["--check-links"]);
  if (r.code !== 2) return `a CI-host owner claim exited ${r.code}; it must be UNRUNNABLE (exit 2)`;
  // The IDENTITY is asserted on the delegate's own R5-S-04 wording. The CI exclusion is
  // decided by `eligibility.js::isEligibleSigner` (the SSOT) rather than by an inlined
  // `host_role === "ci"`, so it surfaces under one error with that module's message —
  // which is the price, and the point, of not owning a fourth copy of the predicate.
  if (!/R5-S-04/.test(r.err)) return `refused without naming R5-S-04: ${r.err.slice(0, 300)}`;
  if (!/audit-only and NEVER eligible/.test(r.err)) return `refused for another reason: ${r.err.slice(0, 300)}`;
  if (/could not be EVALUATED/.test(r.err)) return "an INELIGIBLE host was reported as an outage rather than as a decided refusal";
  return true;
});

// ── standalone: the ABSENCE of any owner claim is reported ABSENT, not clean ─
check("authority · a log with NO role-bound claim reports checked=0 as an ABSENT result", () => {
  const dir = mkRepo();
  const r = runGen(dir, ["--check-links"]);
  if (r.code !== 0) return `exited ${r.code}: ${r.err.slice(0, 200)}`;
  if (!/AUTHORITY: 0 record\(s\) claim a role-bound authority, so this check examined NOTHING/.test(r.out)) {
    return `a zero denominator is rendered as a pass: ${r.out.slice(0, 400)}`;
  }
  return true;
});

// ── MUTATION: dropping the read-gate binding lets the unbacked claim through ─
//
// The GREEN pole above proves a BACKED claim passes; it says nothing about whether the
// gate would notice an unbacked one for a reason other than this check. The mutation
// removes the binding from `verifySignedLog` and re-runs the RED pole's tree: if the
// tree still refuses, the RED pole was measuring something else.
check("authority · MUTATION · removing the read-gate binding lets an UNBACKED owner claim pass", () => {
  const tool = mutantTool((s) =>
    subOnce(
      s,
      // ANCHORED ON THE `verifyAuthorityBindings(` CALL, not on its full argument list.
      // The previous anchor quoted the whole one-line call including `{ roster }`, and
      // it silently stopped matching the moment that argument changed — which happened
      // when the read gate was fixed to pass the TRUST-ROOT index instead. The harness
      // threw (`anchor matched 0 time(s)`) rather than reporting a pass, which is the
      // behaviour that caught it; a fixture that had defaulted to "no change, no
      // finding" would have gone quietly vacuous at exactly the moment the code under
      // test moved.
      "  const authz = events.verifyAuthorityBindings(",
      "  const authz = { ok: true, indeterminate: false, checked: 0, findings: [] }; void events.verifyAuthorityBindings(",
    ),
  );
  const mk = () => mkRepo({ events: OWNER_CLAIM(), roster: { role: "contributor" } });
  const real = runGen(mk(), ["--check-links"]);
  if (real.code !== 2) return `the control tree does not refuse under the REAL generator (exit ${real.code})`;
  const mutated = runGen(mk(), ["--check-links"], tool);
  if (mutated.code !== 0) {
    return `the mutant still refused (exit ${mutated.code}) — the RED pole may be measuring some OTHER gate, not the authority binding: ${mutated.err.slice(0, 240)}`;
  }
  return true;
});

// ═══════════════════════════════════════════════════════════════════════════
// ARM — the tracker-kind vocabulary is CLOSED, and it GAINED rather than swapped
// ═══════════════════════════════════════════════════════════════════════════

pair(
  "tracker-kind-vocabulary-closed",
  "an unrecognized tracker kind is refused, naming the accepted set",
  () => {
    const dir = mkRepo({ trackerKind: "invented-kind" });
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 2) return `an unknown kind exited ${r.code}; it must be UNRUNNABLE (exit 2)`;
    if (!/declares tracker kind 'invented-kind'/.test(r.err)) return `refused for another reason: ${r.err.slice(0, 200)}`;
    if (!/expected one of event-log, forest-ledger/.test(r.err)) return "the refusal does not enumerate the accepted kinds";
    return `RED:tracker-kind criterion=closed-vocabulary kind=invented-kind exit=2`;
  },
  "'event-log' selects the fold and the verdict names the log as the substrate",
  () => {
    const dir = mkRepo({ trackerKind: "event-log" });
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 0) return `event-log exited ${r.code}: ${r.err.slice(0, 200)}`;
    if (!r.out.includes(`event in ${EVENTS_REL}`)) return "the verdict does not name the EVENT LOG as the substrate";
    return `GREEN:tracker-kind criterion=closed-vocabulary kind=event-log exit=0`;
  },
);

pair(
  "event-log-path-bound-to-the-append-sink",
  "an 'event-log' pointed anywhere but the one append path is refused",
  () => {
    const dir = mkRepo({ trackerPath: "burndown/other-events.jsonl" });
    fs.writeFileSync(path.join(dir, "burndown", "other-events.jsonl"), evtLine());
    commitAll(dir, "a second, unwritten log");
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 2) return `a misdirected event-log exited ${r.code}; it must be UNRUNNABLE (exit 2)`;
    if (!/the one append path writes to/.test(r.err)) return `refused for another reason: ${r.err.slice(0, 200)}`;
    return `RED:sink-binding criterion=producer-verifier-agreement path=burndown/other-events.jsonl exit=2`;
  },
  "an 'event-log' at the append sink is read",
  () => {
    const dir = mkRepo();
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 0) return `the sink path exited ${r.code}: ${r.err.slice(0, 200)}`;
    // "is read" is the claim, so the verdict must name the substrate rather than
    // resting on exit 0 — an exit 0 is consistent with reading something else.
    if (!r.out.includes(`event in ${EVENTS_REL}`)) return "exit 0, but the verdict does not name the log as read";
    return `GREEN:sink-binding criterion=producer-verifier-agreement path=${EVENTS_REL} exit=0`;
  },
);

// ── standalone: the kind set GAINED a member, it did not swap one ───────────
//
// This binary ships ecosystem-wide via `always_include` while the manifest that
// selects the kind does NOT ship. A repo carrying a hand-maintained ledger and no
// event log must keep working across the pull, so `forest-ledger` staying accepted is
// a CASCADE property, not a nicety, and it is asserted rather than assumed.
check("cascade · a 'forest-ledger' manifest still verifies against its table", () => {
  const dir = mkRepo({ trackerKind: "forest-ledger", trackerPath: ".session-notes.shared.md" });
  fs.writeFileSync(
    path.join(dir, ".session-notes.shared.md"),
    `| ID | item | value_anchor |\n| --- | --- | --- |\n| ${ITEM_ID} | an alpha item | ${ANCHOR_FILE}#${ITEM_ID} |\n`,
  );
  commitAll(dir, "populate the ledger table");
  const r = runGen(dir, ["--check-links"]);
  if (r.code !== 0) return `a forest-ledger manifest exited ${r.code}: ${r.err.slice(0, 200)}`;
  if (!r.out.includes(`row in .session-notes.shared.md`)) return `unexpected stdout: ${r.out.slice(0, 200)}`;
  return true;
});

// ═══════════════════════════════════════════════════════════════════════════
// ARM — the generator still runs when the bin is copied WITHOUT the hooks tree
// ═══════════════════════════════════════════════════════════════════════════
//
// `sync-tier-aware.mjs` ships `.claude/bin/burndown-build.mjs` on a stated guarantee
// that its default path takes NO relative import, and the `burndown-quote-hooks` and
// `burndown-trace` harnesses both COPY THE BIN ALONE into a temporary `.claude/bin/`.
// A top-level require of the event library broke every mode of the tool in such a
// tree with a module-resolution stack trace — measured, not hypothesised: it reds 38
// cases across those two sibling suites. So the library is required LAZILY, and this
// arm is the regression pin for that.

/**
 * "BIN-ONLY" MEANS WITHOUT THE **CONDITIONAL** DEPS, NOT WITHOUT THE MANDATORY ONE.
 *
 * The generator carries two CLASSES of lazy dependency and they are not
 * interchangeable, so this helper cannot treat them alike:
 *
 *   CONDITIONAL — `burndown-events.js`, `signed-log.js`, `coc-sign.js`. Reached
 *   only by an `event-log` manifest. Their absence is the property THIS arm
 *   exists to pin: a typed refusal rather than a loader stack trace, and every
 *   other mode (notably `--quote`) still runs. They stay absent here.
 *
 *   MANDATORY — `git-subprocess-env.js`. Every mode spawns git, and running git
 *   un-enveloped is a SILENT SECURITY DOWNGRADE (an inherited `GIT_DIR` outranks
 *   repository discovery, so the answers come from whatever repo the environment
 *   names). Its absence is therefore a refusal BY DESIGN, on every path. Copying
 *   it here is not a weakening of the arm: `sync-tier-aware.mjs::ALWAYS_INCLUDE`
 *   carries `.claude/hooks/lib/**` and this generator in the SAME list, so a tree
 *   that has the generator and not this file does not exist for any real
 *   consumer — only for a fixture that constructs one. Its own absence is pinned
 *   separately, by the `git-envelope-is-mandatory` arm below.
 */
function mkBinOnlyRepo(opts = {}) {
  const dir = mkRepo(opts);
  const binDir = path.join(dir, ".claude", "bin");
  const libDir = path.join(dir, ".claude", "hooks", "lib");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(libDir, { recursive: true });
  // The generator + its STATIC relative-import closure, DERIVED from the tree
  // (fcecaa28f added `./lib/entry-point.mjs`; the hand-kept copy that used to
  // sit here went stale and turned every arm below into ERR_MODULE_NOT_FOUND).
  // Conditional deps stay absent by construction — see the _lib helper's header
  // for the top-level-only rule that keeps them absent.
  copyStaticImportClosure({ fromRoot: REPO_ROOT, toRoot: dir, entries: [GENERATOR] });
  fs.copyFileSync(
    path.join(REPO_ROOT, ".claude", "hooks", "lib", "git-subprocess-env.js"),
    path.join(libDir, "git-subprocess-env.js"),
  );
  commitAll(dir, "copy the generator with its MANDATORY git envelope and no conditional deps");
  return { dir, tool: path.join(binDir, "burndown-build.mjs") };
}

pair(
  "bin-copied-without-the-hooks-tree",
  "an 'event-log' manifest with no event library gets a TYPED refusal, not a loader trace",
  () => {
    const { dir, tool } = mkBinOnlyRepo();
    const r = runGen(dir, ["--check-links"], tool);
    if (r.code !== 2) return `a missing event library exited ${r.code}; it must be UNRUNNABLE (exit 2)`;
    if (/node:internal\/modules/.test(r.err)) {
      return "the failure is a raw module-resolution stack trace, not a typed refusal";
    }
    if (!/^UNRUNNABLE — refusing because /m.test(r.err)) return "the refusal is not the LOUD UNRUNNABLE form";
    if (!/burndown-events\.js' could not be loaded/.test(r.err)) return `refused for another reason: ${r.err.slice(0, 200)}`;
    return `RED:lazy-dep criterion=zero-relative-imports mode=check-links lib=absent exit=2`;
  },
  "the same bin-only tree still QUOTES and verifies a forest-ledger, needing no library at all",
  () => {
    const { dir, tool } = mkBinOnlyRepo({ trackerKind: "forest-ledger", trackerPath: ".session-notes.shared.md" });
    fs.writeFileSync(
      path.join(dir, ".session-notes.shared.md"),
      `| ID | item | value_anchor |\n| --- | --- | --- |\n| ${ITEM_ID} | an alpha item | ${ANCHOR_FILE}#${ITEM_ID} |\n`,
    );
    commitAll(dir, "populate the ledger table");
    const links = runGen(dir, ["--check-links"], tool);
    if (links.code !== 0) return `a bin-only forest-ledger tree exited ${links.code}: ${links.err.slice(0, 200)}`;
    // `--quote` is the mode the two sibling suites drive, and it never touches a
    // tracker at all — so it is the sharpest witness that the default path is
    // dependency-free.
    const quote = runGen(dir, ["--quote", "ALL PAGES/Open"], tool);
    if (quote.code !== 0) return `--quote exited ${quote.code} in a bin-only tree: ${quote.err.slice(0, 200)}`;
    if (/node:internal\/modules/.test(quote.err)) return "--quote died on module resolution in a bin-only tree";
    return `GREEN:lazy-dep criterion=zero-relative-imports mode=quote+check-links lib=absent exit=0`;
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// ARM — the PRODUCER stays in scope when the manifest moves to `event-log`
// ═══════════════════════════════════════════════════════════════════════════
//
// Repointing the manifest is a CONSUMER change with a PRODUCER consequence, and this
// arm is the pin for it. `todo-tracker-guard.js::resolveScope` read `forest-ledger`
// as the only burndown kind, so the moment the manifest declared `event-log` the
// producer went to UNKNOWN and recorded NOTHING — measured on this tree, both poles,
// before the fix. The guard was honest about it (UNKNOWN, never "clean"), which is
// why the disarm was visible; a silent version of the same bug would have looked
// exactly like a repo with no outstanding todos.

const TODO_GUARD = path.join(REPO_ROOT, ".claude", "hooks", "todo-tracker-guard.js");

function runTodoGuard(dir) {
  const r = spawnSync("node", [TODO_GUARD], {
    cwd: dir,
    input: JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "TodoWrite",
      tool_input: { todos: [{ id: "probe-1", status: "in_progress", content: "probe" }] },
    }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    timeout: 60000,
  });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

// The question this arm asks is SCOPE — does the producer accept that a burndown
// exists here — and NOT whether the append then succeeds. In a bare temporary repo
// it correctly cannot: there is no enrolled identity and no signing key, and the
// design has no unsigned fallback. So the GREEN pole is not "the event landed"; it is
// "the producer got PAST the kind check and failed on signing instead", which is a
// POSITIVE signal that scope resolved, not merely the absence of one message.
pair(
  "producer-scope-follows-the-manifest-kind",
  "a manifest kind the producer does not recognise stops at SCOPE and reports UNKNOWN",
  () => {
    const dir = mkRepo({ trackerKind: "invented-kind" });
    const r = runTodoGuard(dir);
    if (!/projection is UNKNOWN/.test(r.out)) {
      return `an unrecognised kind did not surface UNKNOWN: ${r.out.slice(0, 200)}`;
    }
    if (!/tracker\.kind is 'invented-kind'/.test(r.out)) {
      return `UNKNOWN, but not on the kind check: ${r.out.slice(0, 300)}`;
    }
    return `RED:producer-scope criterion=kind-vocabulary kind=invented-kind stopped_at=scope`;
  },
  "an 'event-log' manifest passes SCOPE — the consumer swap did not disarm the producer",
  () => {
    const dir = mkRepo({ trackerKind: "event-log" });
    const r = runTodoGuard(dir);
    if (/tracker\.kind is/.test(r.out)) {
      return `the producer still rejects the kind the consumer now verifies: ${r.out.slice(0, 300)}`;
    }
    // Reached the append path — the positive witness that scope resolved.
    if (!/signed-append preconditions are absent|transition\(s\)/.test(r.out) && r.out.trim() !== '{"continue":true}') {
      return `scope resolved but the producer reached no recognisable next stage: ${r.out.slice(0, 300)}`;
    }
    return `GREEN:producer-scope criterion=kind-vocabulary kind=event-log stopped_at=signing-or-done`;
  },
);

// ── standalone: an EMPTY log refuses rather than reporting a clear board ────
// The OR this once carried (`ZERO items` OR `chain is BROKEN`) would have passed on
// the wrong refusal. Measured: the empty log produces the former, so the case pins
// exactly that one.
check("log-integrity · an EMPTY log refuses rather than reporting clean", () => {
  const dir = mkRepo({ events: "\n" });
  const r = runGen(dir, ["--check-links"]);
  if (r.code !== 2) return `an empty log exited ${r.code}; it must be UNRUNNABLE (exit 2)`;
  if (!/is EMPTY — it folds to zero items/.test(r.err)) {
    return `refused for another reason: ${r.err.slice(0, 200)}`;
  }
  return true;
});

// ── standalone: the projection is NOT consulted under the event-log kind ────
//
// Every `event-log` case above ships a DELIBERATELY EMPTY tracker table. If any of
// them could have passed by falling back to parsing it, this case would fail: the
// table names no row, so a fallback reader would report LINK-1 missing.
check("A2 · the tracker table is never read under the event-log kind", () => {
  const dir = mkRepo();
  const table = fs.readFileSync(path.join(dir, ".session-notes.shared.md"), "utf8");
  if (/R1-alpha-item/.test(table)) return "the fixture's table carries the row, so this case proves nothing";
  const r = runGen(dir, ["--check-links"]);
  if (r.code !== 0) return `the chain did not hold against an EMPTY table (exit ${r.code}): ${r.err.slice(0, 200)}`;
  if (r.out.includes(".session-notes.shared.md")) return "the verdict still names the table as the verified surface";
  return true;
});

// ── standalone: the two derivations of the malformed count agree ────────────
//
// THE REAL LOG ALONE CANNOT ANSWER THIS. It has `skipped: 0` and `malformed: 0`, so
// both sides of the comparison are `0` and the case passes whatever the fold does —
// proven, not assumed: moving `considered++` past the C5 fence leaves the real log
// reading `nonBlank=267 considered=267 malformed=0 agree=true`, i.e. INVISIBLE. The
// equivalence rests entirely on that statement's position relative to the fence, so
// the case is run on a log that HAS a C5 skip, which is the only shape that can see
// it. The real log is kept as a second input, not as the only one.
function accountingOf(text) {
  const { considered, skipped } = foldEvents(text);
  const lines = text.split(/\r?\n/);
  const nonBlank = lines.filter((l) => l.trim()).length;
  const malformed = skipped.filter((s) => {
    try {
      return !ev.validateEvent(JSON.parse(lines[s.line - 1])).ok;
    } catch {
      return true;
    }
  });
  return { nonBlank, considered, malformed: malformed.length, skipped: skipped.length };
}

for (const [name, text, wantSkips] of [
  ["a log with a C5-superseded genesis (the shape that can SEE the fence)",
    evtLog({ over: { kind: "transition", weight: "live", status: "todo:in_progress" } }, {}), 1],
  // `null`, NOT a number. The synthetic input above pins `1` and that pin is
  // LOAD-BEARING — it is what makes the fence observable, and it stays hard. This
  // one pinned `0`, which was never load-bearing: it was an incidental fact about
  // the live committed log on the day it was written, and the log GROWS. It broke
  // the first time a well-formed record was legitimately not folded (an INERT
  // `kind: "proposal"` — `burndown-events.js` component 13), reporting "it is not
  // the shape this case needs" about a perfectly healthy log. A premise that has to
  // be re-typed whenever the artifact it describes changes is a premise that will be
  // re-typed wrong.
  //
  // `null` means: assert no COUNT, assert the PROPERTY. Every skip in the committed
  // log must be a fence, never corruption — which is the fact worth holding, is
  // stable under growth, and is strictly stronger than `0` was against the failure
  // this case exists to catch (the accounting identity below is unchanged either way).
  ["the committed event log", fs.readFileSync(REAL_LOG, "utf8"), null],
]) {
  check(`log-integrity · foldEvents' accounting agrees with this reader's re-derivation · ${name}`, () => {
    const a = accountingOf(text);
    if (wantSkips === null) {
      if (a.malformed !== 0) {
        return `the committed log carries ${a.malformed} MALFORMED line(s) of ${a.skipped} skip(s) — a fold that walks around its own corruption reports a smaller board, not a broken one`;
      }
    } else if (a.skipped !== wantSkips) {
      return `this input carries ${a.skipped} skip(s), expected ${wantSkips} — it is not the shape this case needs`;
    }
    if (a.nonBlank - a.considered !== a.malformed) {
      return `disagreement: nonBlank=${a.nonBlank} considered=${a.considered} re-derived-malformed=${a.malformed}`;
    }
    return true;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// ARM — A SIGNATURE THAT DOES NOT VERIFY REFUSES (component 8, the read gate)
//
// `verifyRecordSignature` and `verifyChain` existed in `signed-log.js` for a full
// generation with ZERO call sites outside their own module: the read path verified the
// committed PREFIX and then folded the log without checking a single signature or
// chain link. An unverified signed log is an unsigned log.
//
// The RED established before the wiring, on THIS repo's real 534-record log: a record
// copied from the log with its `sig` replaced by the literal text
// `TOTALLY-FORGED-NOT-A-SIGNATURE`, appended and left uncommitted, was ACCEPTED at
// exit 0 and WON the last-wins fold — flipping a live item to "Signed off" and moving
// the reported supersession count from 267 to 268.
// ═══════════════════════════════════════════════════════════════════════════

pair(
  "signature-tamper-refused",
  "a record altered AFTER signing refuses, naming the record, the item and the emitter",
  () => {
    // `tamper` is applied after `signRecord`, so the bytes on disk are not the bytes
    // that were signed. Everything else about the record is well-formed — it folds,
    // it validates, its schema and envelope are correct. The ONLY thing wrong with it
    // is that its signature does not cover it, which is precisely the class no other
    // gate in this generator can see.
    const dir = mkRepo({ events: evtLine({}, { status: "Signed off" }) });
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 2) return `a forged record exited ${r.code}; the gate must be UNRUNNABLE (exit 2)`;
    if (r.out !== "") return `a refusal wrote to stdout: ${JSON.stringify(r.out.slice(0, 120))}`;
    if (!/^UNRUNNABLE — refusing because /m.test(r.err)) return "the refusal is not the LOUD UNRUNNABLE form";
    if (!/FAILED signature verification/.test(r.err)) return `refused, but not on signature verification: ${r.err.slice(0, 240)}`;
    if (!/\[bad-signature\]/.test(r.err)) return `the refusal does not carry the typed failure IDENTITY: ${r.err.slice(0, 240)}`;
    // A positive forgery and an unverifiable log are different facts. Collapsing them
    // would send the operator to add a key when what happened was a tamper.
    if (/INDETERMINATE/.test(r.err)) return `a positive forgery was mis-reported as INDETERMINATE: ${r.err.slice(0, 240)}`;
    if (!r.err.includes(ITEM_ID)) return "the refusal does not name WHICH item the forged record claims";
    if (!r.err.includes(SIGNER.fingerprint)) return "the refusal does not name the emitter whose key it failed against";
    if (!/rec_fixture_/.test(r.err)) return "the refusal does not name WHICH record failed";
    for (const tok of ["chain INTACT", "ALL PAGES", "BURNDOWN:BEGIN"]) {
      if ((r.out + r.err).includes(tok)) return `the refusal carries the clean-summary token ${tok}`;
    }
    return `RED:signed-log criterion=verifyRecordSignature finding=bad-signature item=${ITEM_ID} emitter=${SIGNER.fingerprint} exit=2 stdout=empty`;
  },
  "the SAME record, untampered, verifies and stays silent — the gate is not refusing everything",
  () => {
    // Byte-for-byte the same construction minus the post-signing overwrite. Without
    // this pole a gate that refused every log unconditionally would pass the RED pole.
    const dir = mkRepo({ events: evtLine({ status: "Signed off" }) });
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 0) return `an intact signed log exited ${r.code}: ${r.err.slice(0, 240)}`;
    if (!/chain INTACT — 1 ADJUDICATED item\(s\)/.test(r.out)) return `unexpected stdout: ${r.out.slice(0, 200)}`;
    if (/signature/i.test(r.err)) return `a healthy log emitted signature noise on stderr: ${r.err.slice(0, 200)}`;
    return `GREEN:signed-log criterion=verifyRecordSignature finding=none item=${ITEM_ID} emitter=${SIGNER.fingerprint} exit=0 verdict=intact`;
  },
);

check("signature-tamper · MUTATION · exempting the read gate lets the FORGED record fold clean", () => {
  // The counterfactual. If the refusal above came from anywhere but the read gate —
  // the fold, the prefix predicate, a schema check — the mutant would refuse too and
  // this case would report UNRESOLVED rather than passing.
  const tool = mutantTool((s) =>
    subOnce(
      s,
      "      sigVerdict = verifySignedLog(repo, manifestRel, trackerRel, text, committedBytes);",
      "      sigVerdict = null; void verifySignedLog;",
    ),
  );
  const dir = mkRepo({ events: evtLine({}, { status: "Signed off" }) });
  const real = runGen(dir, ["--check-links"]);
  const mutant = runGen(dir, ["--check-links"], tool);
  if (real.code !== 2) return `the real binary did not refuse the forged log (exit ${real.code})`;
  if (mutant.code !== 0) {
    return `the mutant ALSO refused (exit ${mutant.code}) — UNRESOLVED, not a verdict: ${mutant.err.slice(0, 240)}`;
  }
  if (!/chain INTACT/.test(mutant.out)) return `the mutant exited 0 but printed no verdict: ${mutant.out.slice(0, 200)}`;
  return true;
});

// ═══════════════════════════════════════════════════════════════════════════
// ARM — A CLOSED GENERATION VERIFIES UNDER ITS OWN SUITE, AND THE COUNT IS
//       GATED ON VERIFICATION RATHER THAN ON POPULATION
//
// THIS IS THE CONTROL PR #1954 NAMED AND DID NOT SHIP. That PR rolls the ledger to
// generation 2 under an ssh key while 534 committed generation-0 records stay
// openpgp, and its read gate reports "534 record(s) verified, each under ITS OWN
// generation's suite (534 under 'openpgp')". The lane was terminated by a 529 before
// it built the control proving that line would RED if those 534 records did NOT
// verify — so a green read gate was not yet evidence for the claim it was being read
// to support (`instrument-discipline.md` MUST-2(a): a green reports on the behaviour
// it NAMES only once the run is shown to RED in that behaviour's absence).
//
// THE FALSIFYING RESULT, NAMED BEFORE THE INSTRUMENT IS CITED. Two readings survive a
// green on a single-suite log and they disagree on exactly one thing:
//
//   (a) the closed generation's records were VERIFIED and tallied because they passed
//   (b) the closed generation's records were COUNTED because they were present
//
// Under (b) the gate would print the identical line for a log of forged prior-generation
// records. The RED pole is that log. If the gate exits 0, or tallies the forged record
// under 'ssh-rsa', reading (b) is the live one and the PR's claim is unbanked.
//
// The two generations carry DIFFERENT suites deliberately. On a log where they match,
// "attributed to its own generation" and "attributed to the current generation" produce
// byte-identical output — the exact non-discrimination the PR's second commit fixed,
// reproduced here as the fixture's own construction rather than asserted about it.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A log spanning TWO generations under TWO suites: one chainless generation-0 record
 * signed by the RSA prior-generation signer, then one current-generation record signed
 * by the ed25519 fixture signer as the FIRST link of its own emitter's chain.
 *
 * Built here rather than through `evtLog` because that builder advances one shared
 * `seq`/`prev_hash` across every spec, which would stamp the current-generation record
 * as `seq: 2` chained to a generation-0 record. The chain is per-emitter AND
 * generation-scoped, so the honest value is `seq: 1` with a null `prev_hash` — and a
 * fixture that reds the chain check measures the chain, not the suite attribution.
 *
 * @param {object} [tamperPrior] fields overwritten on the generation-0 record AFTER
 *   signing — the only way to build a closed-generation record whose bytes and
 *   signature disagree.
 */
function twoGenerationLog({ tamperPrior = null } = {}) {
  const priorRec = evtRecord({}, 1, null, true, PRIOR_SIGNER);
  const currentRec = evtRecord({ item_id: ITEM_ID }, 1, null, false, SIGNER);
  const prior = tamperPrior ? Object.assign({}, priorRec, tamperPrior) : priorRec;
  return `${JSON.stringify(prior)}\n${JSON.stringify(currentRec)}\n`;
}

function twoGenerationRepo(opts = {}) {
  return mkRepo({
    events: twoGenerationLog(opts),
    suite: fixtureSuiteDeclaration({ priorSuite: "ssh-rsa" }),
    roster: { withPriorGen: true },
  });
}

pair(
  "closed-generation-signature-verified-not-merely-counted",
  "a CLOSED-generation record that does NOT verify REFUSES, and is NOT tallied under its generation's suite",
  () => {
    // Committed, so the prefix gate has nothing to say about it: this record sits
    // exactly where the 534 real generation-0 records sit. The ONLY thing wrong with
    // it is that its signature does not cover its bytes.
    const dir = twoGenerationRepo({ tamperPrior: { sig: "TOTALLY-FORGED-NOT-A-SIGNATURE" } });
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 2) return `a forged CLOSED-generation record exited ${r.code}; the gate must be UNRUNNABLE (exit 2)`;
    if (r.out !== "") return `a refusal wrote to stdout: ${JSON.stringify(r.out.slice(0, 120))}`;
    if (!/^UNRUNNABLE — refusing because /m.test(r.err)) return "the refusal is not the LOUD UNRUNNABLE form";
    if (!/FAILED signature verification/.test(r.err)) return `refused, but not on signature verification: ${r.err.slice(0, 240)}`;
    if (!/\[bad-signature\]/.test(r.err)) return `the refusal does not carry the typed failure IDENTITY: ${r.err.slice(0, 240)}`;
    if (/INDETERMINATE/.test(r.err)) return `a positive forgery was mis-reported as INDETERMINATE: ${r.err.slice(0, 240)}`;
    if (!r.err.includes(PRIOR_SIGNER.fingerprint)) {
      return "the refusal does not name the CLOSED generation's emitter whose key it failed against";
    }
    // The load-bearing assertion, and the one that separates reading (a) from (b):
    // a forged record must not appear in the per-suite tally at all.
    if (/under 'ssh-rsa'/.test(r.out + r.err)) {
      return `the forged CLOSED-generation record was TALLIED under its suite anyway: ${(r.out + r.err).slice(0, 300)}`;
    }
    for (const tok of ["chain INTACT", "ALL PAGES", "BURNDOWN:BEGIN"]) {
      if ((r.out + r.err).includes(tok)) return `the refusal carries the clean-summary token ${tok}`;
    }
    return `RED:closed-generation-suite criterion=verifyLogSignatures finding=bad-signature generation=0 suite=ssh-rsa emitter=${PRIOR_SIGNER.fingerprint} tallied=no exit=2`;
  },
  "the SAME log, untampered, verifies the closed generation under ITS OWN suite and reports both populations separately",
  () => {
    // Byte-identical construction minus the post-signing overwrite. Without this pole
    // a gate refusing every multi-generation log would pass the RED pole.
    const dir = twoGenerationRepo();
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 0) return `an intact two-generation log exited ${r.code}: ${r.err.slice(0, 300)}`;
    if (!/chain INTACT/.test(r.out)) return `unexpected stdout: ${r.out.slice(0, 250)}`;
    // The closed generation is attributed to ITS OWN suite, not to the current one.
    if (!/1 under 'ssh-rsa'/.test(r.out)) {
      return `the closed generation was not reported under its own suite 'ssh-rsa': ${r.out.slice(0, 300)}`;
    }
    if (!/1 under 'ssh-ed25519'/.test(r.out)) {
      return `the current generation was not reported under its own suite 'ssh-ed25519': ${r.out.slice(0, 300)}`;
    }
    // And the CURRENT generation's append suite is reported as a SEPARATE fact, so a
    // reader cannot mistake it for the suite the records were signed with.
    if (!/the CURRENT generation accepts 'ssh-ed25519' for appends/.test(r.out)) {
      return `the append suite is not reported as a distinct fact: ${r.out.slice(0, 300)}`;
    }
    if (/2 under '/.test(r.out)) {
      return `both generations were collapsed into ONE suite tally: ${r.out.slice(0, 300)}`;
    }
    return `GREEN:closed-generation-suite criterion=verifyLogSignatures finding=none generation=0 suite=ssh-rsa verified=1 current=ssh-ed25519 exit=0`;
  },
);

check("closed-generation-suite · MUTATION · a verifier that SKIPS closed generations passes the FORGED record clean", () => {
  // THE COUNTERFACTUAL THAT ANSWERS #1954's BOUND, and it is reading (b) implemented
  // literally: a verifier that reaches only the CURRENT generation and lets prior
  // generations through unread. That instrument prints the same clean line for a
  // healthy log and for a log of 534 forged generation-0 records, which is exactly
  // the possibility a green read gate did not previously exclude.
  //
  // The mutation drops closed-generation records before `parsed`, so pass 2 never
  // sees them. If the mutant still refuses, the real binary's refusal came from
  // somewhere other than closed-generation signature verification — the prefix gate,
  // the chain, a schema check — and this case reports UNRESOLVED rather than a verdict.
  //
  // An EARLIER revision of this case mutated the `if (r.ok)` tally guard instead. That
  // mutation is real but UNOBSERVABLE at this surface: a failed signature REFUSES
  // before the SIGNATURES line is ever printed, so both poles produce a refusal with
  // no tally in it. It was reported UNRESOLVED by this harness rather than read as a
  // verdict, and is recorded here because the distinction — the tally protects nobody,
  // the REFUSAL does — is the load-bearing one for the PR's claim.
  const tool = mutantTool(null, {
    signedLog: mutantSignedLog((s) =>
      subOnce(
        s,
        "    parsed.push({ ordinal, record: e, key, generation: c.generation });",
        "    if (c.generation.generation !== policy.current.generation) continue;\n    parsed.push({ ordinal, record: e, key, generation: c.generation });",
      ),
    ),
  });
  const dir = twoGenerationRepo({ tamperPrior: { sig: "TOTALLY-FORGED-NOT-A-SIGNATURE" } });
  const real = runGen(dir, ["--check-links"]);
  const mutant = runGen(dir, ["--check-links"], tool);
  if (real.code !== 2) return `the real binary did not refuse the forged closed-generation record (exit ${real.code})`;
  if (mutant.code !== 0) {
    return `the mutant ALSO refused (exit ${mutant.code}) — UNRESOLVED, not a verdict: ${mutant.err.slice(0, 300)}`;
  }
  if (!/chain INTACT/.test(mutant.out)) return `the mutant exited 0 but printed no verdict: ${mutant.out.slice(0, 250)}`;
  // And the mutant's own report is the tell: with the closed generation unread, its
  // suite disappears from the breakdown entirely.
  if (/under 'ssh-rsa'/.test(mutant.out)) {
    return `the mutant claimed to have verified the closed generation it never read: ${mutant.out.slice(0, 300)}`;
  }
  return true;
});

check("closed-generation-suite · MUTATION · attributing to the CURRENT suite reports a population that does not exist", () => {
  // The second counterfactual, and the one that pins the PR's actual defect rather
  // than its consequence: the pre-fix reading took `policy.current.suite` as "the
  // suite these records verified under". On a single-suite log that mutation is
  // INERT — which is why this arm's fixture carries two suites, and why an inert
  // result here would mean the fixture, not the gate, had stopped discriminating.
  const tool = mutantTool(null, {
    signedLog: mutantSignedLog((s) =>
      subOnce(
        s,
        "      if (r.ok) bySuite.set(generation.suite, (bySuite.get(generation.suite) || 0) + 1);",
        "      if (r.ok) bySuite.set(policy.current.suite, (bySuite.get(policy.current.suite) || 0) + 1);",
      ),
    ),
  });
  const dir = twoGenerationRepo();
  const real = runGen(dir, ["--check-links"]);
  const mutant = runGen(dir, ["--check-links"], tool);
  if (real.code !== 0) return `the real binary refused an intact two-generation log (exit ${real.code}): ${real.err.slice(0, 250)}`;
  if (!/1 under 'ssh-rsa'/.test(real.out)) return "the real binary did not attribute per generation — the arm above should have caught this";
  if (mutant.code !== 0) {
    return `the mutant refused rather than mis-reporting (exit ${mutant.code}) — UNRESOLVED, not a verdict: ${mutant.err.slice(0, 250)}`;
  }
  if (/1 under 'ssh-rsa'/.test(mutant.out)) {
    return `the mutation was INERT — the mutant still attributed the closed generation to 'ssh-rsa': ${mutant.out.slice(0, 300)}`;
  }
  if (!/2 under 'ssh-ed25519'/.test(mutant.out)) {
    return `the mutant neither attributed per generation nor collapsed onto the current suite: ${mutant.out.slice(0, 300)}`;
  }
  return true;
});

// ═══════════════════════════════════════════════════════════════════════════
// ARM — THE CHAIN CATCHES A DELETED MIDDLE RECORD THAT GIT CANNOT SEE
//
// The deletion is COMMITTED, which is what makes this arm worth having. Prefix
// preservation compares the working copy to HEAD, so once the rewrite is itself
// committed the two agree and that gate is BLIND — the shape a history rewrite, a
// squashed branch or a merge with a side dropped actually takes. Every surviving
// record's signature still verifies perfectly. The per-emitter chain is the only
// instrument left, which is the whole reason `seq`/`prev_hash` exist.
// ═══════════════════════════════════════════════════════════════════════════

pair(
  "chain-catches-a-committed-middle-record-deletion",
  "a middle record removed and RE-COMMITTED refuses on the chain, naming the emitter and the gap",
  () => {
    const dir = mkRepo({ events: evtLog({}, {}, {}) });
    const lines = fs.readFileSync(path.join(dir, EVENTS_REL), "utf8").split("\n").filter((l) => l.trim());
    if (lines.length !== 3) return `the fixture built ${lines.length} record(s), not 3`;
    fs.writeFileSync(path.join(dir, EVENTS_REL), `${[lines[0], lines[2]].join("\n")}\n`);
    commitAll(dir, "history rewrite: the middle record is gone and the rewrite is committed");
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 2) return `a chain-broken log exited ${r.code}; the gate must be UNRUNNABLE (exit 2)`;
    if (r.out !== "") return `a refusal wrote to stdout: ${JSON.stringify(r.out.slice(0, 120))}`;
    // The prefix gate MUST be silent here — if it fired, this arm is measuring that
    // gate again rather than the chain, and the whole point is the case it cannot see.
    if (/APPEND-ONLY/.test(r.err)) {
      return `the APPEND-ONLY predicate fired — the deletion was not committed, so this arm did not reach the chain: ${r.err.slice(0, 200)}`;
    }
    if (!/the per-emitter chain is BROKEN/.test(r.err)) return `refused, but not on the chain: ${r.err.slice(0, 240)}`;
    if (!/\[seq-gap\]/.test(r.err)) return `the refusal does not carry the typed seq-gap IDENTITY: ${r.err.slice(0, 240)}`;
    if (!/A gap is a REMOVED record/.test(r.err)) return "the refusal does not say what a gap MEANS";
    if (!r.err.includes(SIGNER.fingerprint)) return "the refusal does not name WHICH emitter's chain broke";
    return `RED:signed-log criterion=verifyChain finding=seq-gap emitter=${SIGNER.fingerprint} records=2-of-3 exit=2 stdout=empty`;
  },
  "the same three records, none removed, chain cleanly and fold to one item",
  () => {
    const dir = mkRepo({ events: evtLog({}, {}, {}) });
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 0) return `an intact 3-record chain exited ${r.code}: ${r.err.slice(0, 240)}`;
    if (!/chain INTACT — 1 ADJUDICATED item\(s\)/.test(r.out)) return `unexpected stdout: ${r.out.slice(0, 200)}`;
    return `GREEN:signed-log criterion=verifyChain finding=none emitter=${SIGNER.fingerprint} records=3-of-3 exit=0 verdict=intact`;
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// ARM — "COULD NOT VERIFY" IS REPORTED AS INDETERMINATE, NEVER AS A PASS
//
// The failure mode this closes is the quiet one. A gate that cannot run — no roster
// to resolve a fingerprint, no declared suite, no usable gpg — and that says nothing
// is indistinguishable from a gate that ran and found the log clean, and it is the
// shape every disarmed verifier takes. `zero-tolerance.md` Rule 3: fail CLOSED, typed,
// on stderr, never warn-and-continue.
// ═══════════════════════════════════════════════════════════════════════════

pair(
  "verification-cannot-run-is-not-clean",
  "a log whose signers cannot be resolved refuses as INDETERMINATE, naming what is missing",
  () => {
    // The records are GENUINELY SIGNED and entirely well-formed. The only missing
    // thing is the roster that binds their fingerprint to key material — so nothing
    // is wrong with the log, and nothing can be said about it either.
    const dir = mkRepo({ withRoster: false });
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 2) return `an unverifiable log exited ${r.code}; the gate must be UNRUNNABLE (exit 2)`;
    if (r.out !== "") return `a refusal wrote to stdout: ${JSON.stringify(r.out.slice(0, 120))}`;
    if (!/INDETERMINATE/.test(r.err)) return `refused, but did not say the result is INDETERMINATE: ${r.err.slice(0, 240)}`;
    if (!/operators\.roster\.json/.test(r.err)) return `the refusal does not name the missing artefact: ${r.err.slice(0, 240)}`;
    if (/FAILED signature verification/.test(r.err)) {
      return "an UNVERIFIABLE log was reported as a FORGED one — the two are different facts and must not collapse";
    }
    for (const tok of ["chain INTACT", "ALL PAGES"]) {
      if ((r.out + r.err).includes(tok)) return `the refusal carries the clean-summary token ${tok}`;
    }
    return `RED:signed-log criterion=indeterminate-is-not-clean missing=${ROSTER_REL} exit=2 stdout=empty`;
  },
  "the same log WITH the roster verifies and folds — absence of the roster was the only difference",
  () => {
    const dir = mkRepo({ withRoster: true });
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 0) return `the same log with a roster exited ${r.code}: ${r.err.slice(0, 240)}`;
    if (!/chain INTACT — 1 ADJUDICATED item\(s\)/.test(r.out)) return `unexpected stdout: ${r.out.slice(0, 200)}`;
    return `GREEN:signed-log criterion=indeterminate-is-not-clean missing=none exit=0 verdict=intact`;
  },
);

check("indeterminate · an UNDECLARED signature suite refuses rather than defaulting to ssh", () => {
  // The D1 defect at the read end. `coc-sign::verify` reads `o.keyType || "ssh"`, so a
  // reader that guessed would report an entire openpgp log as a total signature
  // failure — a FORGERY verdict on an honest log, which is the more damaging of the
  // two wrong answers. The refusal must therefore be INDETERMINATE, not "failed".
  const dir = mkRepo({ withSuite: false });
  const r = runGen(dir, ["--check-links"]);
  if (r.code !== 2) return `a log with no declared suite exited ${r.code}; it must be UNRUNNABLE (exit 2)`;
  if (!/INDETERMINATE/.test(r.err)) return `refused, but not as INDETERMINATE: ${r.err.slice(0, 240)}`;
  if (!/signature_suite' is ABSENT/.test(r.err)) return `the refusal does not name the absent declaration: ${r.err.slice(0, 240)}`;
  if (/FAILED signature verification/.test(r.err)) return "an undeclared suite was reported as a signature FAILURE";
  return true;
});

check("indeterminate · a record signed by an UNROSTERED key refuses without calling it forged", () => {
  // A key the roster does not carry. The signature may be perfectly valid — nothing
  // here can tell, which is exactly the point: `unrostered-signer` and `bad-signature`
  // are different findings and the operator acts on them differently (add the key vs
  // investigate a forgery).
  const dir = mkRepo();
  const roster = JSON.parse(fs.readFileSync(path.join(dir, ROSTER_REL), "utf8"));
  roster.persons[SIGNER.person_id].keys[0].fingerprint = "SHA256:aDifferentKeyEntirely0000000000000000000000";
  fs.writeFileSync(path.join(dir, ROSTER_REL), JSON.stringify(roster, null, 2));
  commitAll(dir, "the roster no longer carries the signer's fingerprint");
  const r = runGen(dir, ["--check-links"]);
  if (r.code !== 2) return `a log with an unrostered signer exited ${r.code}; it must be UNRUNNABLE (exit 2)`;
  if (!/\[unrostered-signer\]/.test(r.err)) return `the refusal does not carry the typed identity: ${r.err.slice(0, 240)}`;
  // The VERDICT sentence, not the word anywhere in the output. MEASURED: asserting
  // `/INDETERMINATE/` alone passed even with the `indeterminate` classification
  // mutated to a constant `false`, because the unrostered-signer FINDING's own prose
  // contains the word — a non-discriminating assertion in this rule's own sense. The
  // "could not RUN" clause is emitted only on the indeterminate branch.
  if (!/signature verification could not RUN over/.test(r.err)) {
    return `an unresolvable signer was not classified INDETERMINATE by the VERDICT: ${r.err.slice(0, 240)}`;
  }
  if (/\[bad-signature\]/.test(r.err)) return "an UNROSTERED signer was reported as a FORGED signature — different facts, different actions";
  if (!r.err.includes(SIGNER.fingerprint)) return "the refusal does not name the unresolvable fingerprint";
  return true;
});

// ═══════════════════════════════════════════════════════════════════════════
// ARM — THE ROSTER IS THE TRUST ROOT, AND IT IS READ FROM `HEAD`
// ═══════════════════════════════════════════════════════════════════════════
//
// THE ATTACK, END TO END, and it needs no privilege the gate does not already
// assume: generate a key → add it to the WORKING-TREE roster → sign a record →
// append. `classifyRecord` passes, `resolveKey` returns the attacker's key,
// `createVerifyHomedir` imports it, and the `VALIDSIG` line names the attacker's OWN
// fingerprint — so the `expectedFpr` identity bind, the strongest check in this
// path, is satisfied BY CONSTRUCTION. `ok:true`, exit 0, and last-wins folds the
// forged status.
//
// WHAT MADE IT BLOCKING was the asymmetry inside one file: the manifest, the
// tracker, the inventory and every declared source are ALL held to
// `assertCommittedAndUnmodified`; the roster — which supplies the KEYS — was the
// only exemption. The two poles below differ ONLY in whether the roster edge is
// COMMITTED, which is the whole property.

/**
 * One really-signed CURRENT-generation record from an arbitrary signer, shaped as a
 * live TRANSITION on the SAME item — which is the attack's payload, not a detail: a
 * transition supersedes the genesis under last-wins, so accepting it flips the item's
 * reported status. The override shape mirrors the suite's existing superseded-genesis
 * arm exactly (`buildEvent` derives `weight` from `kind` and does not take a status
 * vocabulary for transitions, so both are applied AFTER it).
 *
 * `seq: 1, prev_hash: null` is CORRECT here and not a shortcut: the chain is
 * PER-EMITTER, and this is a different emitter's first record.
 */
function attackerRecord(signer) {
  return evtRecord(
    { kind: "transition", weight: "live", status: "todo:in_progress" },
    1,
    null,
    false,
    signer,
  );
}

/** Add `signer`'s key to the repo's roster ON DISK. Does NOT commit. */
function addKeyToWorkingTreeRoster(dir, signer) {
  const abs = path.join(dir, ROSTER_REL);
  const roster = JSON.parse(fs.readFileSync(abs, "utf8"));
  roster.persons[signer.person_id] = {
    display_id: signer.display_id,
    keys: [{ type: "ssh", fingerprint: signer.fingerprint, pubkey: signer.pubkey }],
  };
  fs.writeFileSync(abs, JSON.stringify(roster, null, 2));
}

/** The tree both poles start from: one legitimate record, one appended attacker record. */
function mkRosterAttackRepo() {
  const dir = mkRepo({ events: evtLog({}) });
  fs.appendFileSync(path.join(dir, EVENTS_REL), `${JSON.stringify(attackerRecord(ATTACKER))}\n`);
  addKeyToWorkingTreeRoster(dir, ATTACKER);
  return dir;
}

pair(
  "roster-trust-root-is-committed",
  "a key present ONLY in the working-tree roster does NOT make its record verify",
  () => {
    const dir = mkRosterAttackRepo();
    // The roster edit is DELIBERATELY not committed — that is the entire attack.
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 2) return `an uncommitted roster key was TRUSTED (exit ${r.code}) — the trust root is writable`;
    if (r.out !== "") return `a refusal wrote to stdout: ${JSON.stringify(r.out.slice(0, 120))}`;
    if (!/^UNRUNNABLE — refusing because /m.test(r.err)) return "the refusal is not the LOUD UNRUNNABLE form";
    if (!/\[unrostered-signer\]/.test(r.err)) return `refused, but not on the roster: ${r.err.slice(0, 240)}`;
    if (!r.err.includes(ATTACKER.fingerprint)) return "the refusal does not name the untrusted fingerprint";
    // INDETERMINATE, not forged: the signature is genuine, the SIGNER is not vouched
    // for. Those are different findings and the operator acts on them differently.
    if (!/signature verification could not RUN over/.test(r.err)) {
      return `an uncommitted-roster signer was not classified INDETERMINATE: ${r.err.slice(0, 240)}`;
    }
    if (/\[bad-signature\]/.test(r.err)) return "an unvouched signer was reported as a FORGERY";
    return `RED:roster-trust-root criterion=HEAD-roster signer=${ATTACKER.fingerprint} exit=2 stdout=empty`;
  },
  "the SAME key, COMMITTED to the roster, verifies — a reviewed roster edit is what grants trust",
  () => {
    const dir = mkRosterAttackRepo();
    commitAll(dir, "register the second operator in the roster");
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 0) return `a COMMITTED roster key was refused (exit ${r.code}): ${r.err.slice(0, 240)}`;
    if (!/chain INTACT/.test(r.out)) return `unexpected stdout: ${r.out.slice(0, 200)}`;
    if (!/SIGNATURES: 2 record\(s\) verified/.test(r.out)) {
      return `the gate did not verify BOTH records: ${r.out.slice(0, 300)}`;
    }
    return `GREEN:roster-trust-root criterion=HEAD-roster signer=${ATTACKER.fingerprint} committed=yes exit=0`;
  },
);

check("roster-trust-root · MUTATION · reading the WORKING-TREE roster lets the attacker's own key verify his own record", () => {
  // The counterfactual is the PRE-FIX CODE, restored verbatim: read the roster off
  // disk instead of out of `HEAD`. If the refusal above came from anywhere else —
  // the chain, the prefix predicate, the fold — the mutant would refuse too and this
  // would be UNRESOLVED. Its exiting 0 IS the measurement that the trust root was
  // writable, and that the `HEAD:` read is what closed it.
  const tool = mutantTool((s) =>
    subOnce(
      s,
      '    raw = git(repo, ["show", `HEAD:${ROSTER_REL}`]);',
      '    raw = fs.readFileSync(path.join(repo, ROSTER_REL), "utf8");',
    ),
  );
  const dir = mkRosterAttackRepo();
  const real = runGen(dir, ["--check-links"]);
  const mutant = runGen(dir, ["--check-links"], tool);
  if (real.code !== 2) return `the real binary did not refuse the uncommitted roster key (exit ${real.code})`;
  if (mutant.code !== 0) {
    return `the mutant ALSO refused (exit ${mutant.code}) — UNRESOLVED, not a verdict: ${mutant.err.slice(0, 250)}`;
  }
  if (!/chain INTACT/.test(mutant.out)) return `the mutant exited 0 but printed no verdict: ${mutant.out.slice(0, 200)}`;
  return true;
});

// ═══════════════════════════════════════════════════════════════════════════
// ARM — THE GIT ENVELOPE IS MANDATORY, ON EVERY MODE
// ═══════════════════════════════════════════════════════════════════════════
//
// Every `git` the generator spawns runs on the resolved binary with an env built
// from constants (`git-subprocess-env.js`). That is not hygiene: an inherited
// `GIT_DIR` OUTRANKS repository discovery and neither `cwd:` nor `-C` pins which
// repository git resolves, so an un-enveloped query is answered by whatever
// repository the ENVIRONMENT names — including `rosterKeyResolver`'s
// `git show HEAD:<roster>`, which is this gate's trust root. The working-tree
// roster hole would simply reopen through the environment.
//
// So its absence must REFUSE rather than fall back, and on EVERY mode — a
// dependency that silently degrades a security control is not a dependency. The
// GREEN pole is what stops that from being over-read as "the tool refuses
// everything": with the envelope present, the same bin-only tree still quotes.
pair(
  "git-envelope-is-mandatory",
  "a tree WITHOUT the git envelope refuses — the tool never falls back to an ambient-env git",
  () => {
    const { dir, tool } = mkBinOnlyRepo({ trackerKind: "forest-ledger", trackerPath: ".session-notes.shared.md" });
    fs.rmSync(path.join(dir, ".claude", "hooks", "lib", "git-subprocess-env.js"), { force: true });
    const r = runGen(dir, ["--quote", "ALL PAGES/Open"], tool);
    if (r.code !== 2) return `a tree with no git envelope exited ${r.code} — it fell back to an ambient-env git`;
    if (/node:internal\/modules/.test(r.err)) return "the failure is a raw module-resolution stack trace, not a typed refusal";
    if (!/git-subprocess-env\.js' could not be loaded/.test(r.err)) return `refused for another reason: ${r.err.slice(0, 240)}`;
    if (!/GIT_DIR/.test(r.err)) return "the refusal does not name the steering vector it exists to close";
    return `RED:git-envelope criterion=mandatory-dependency mode=quote lib=absent exit=2`;
  },
  "the SAME tree WITH the envelope quotes normally — the refusal is the envelope's absence, not the tool refusing everything",
  () => {
    const { dir, tool } = mkBinOnlyRepo({ trackerKind: "forest-ledger", trackerPath: ".session-notes.shared.md" });
    // The ledger table has to carry the row, exactly as the sibling bin-only GREEN
    // pole does it: `--quote` runs the full build, so an unpopulated table refuses
    // on the traceability chain — a true finding, and not the one under test here.
    fs.writeFileSync(
      path.join(dir, ".session-notes.shared.md"),
      `| ID | item | value_anchor |\n| --- | --- | --- |\n| ${ITEM_ID} | an alpha item | ${ANCHOR_FILE}#${ITEM_ID} |\n`,
    );
    commitAll(dir, "populate the ledger table");
    const r = runGen(dir, ["--quote", "ALL PAGES/Open"], tool);
    if (r.code !== 0) return `a tree WITH the envelope exited ${r.code}: ${r.err.slice(0, 240)}`;
    if (!/ALL PAGES/.test(r.out)) return `unexpected stdout: ${r.out.slice(0, 200)}`;
    return `GREEN:git-envelope criterion=mandatory-dependency mode=quote lib=present exit=0`;
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// ARM — AN AMBIENT `GIT_DIR` MUST NOT RE-POINT THE TRUST ROOT
// ═══════════════════════════════════════════════════════════════════════════
//
// THE DEFECT, AND WHY THE ABSENCE ARM ABOVE DOES NOT COVER IT. `GIT_DIR` OUTRANKS
// repository discovery; neither `cwd:` nor `-C` pins which REPOSITORY git
// resolves — both only choose a DIRECTORY. So with an un-enveloped `git`, one
// ambient variable makes `rosterKeyResolver`'s `git show HEAD:<roster>` answer
// from an ATTACKER-CONTROLLED repository, and the working-tree trust-root hole
// closed elsewhere in this shard reopens through the environment.
//
// MEASURED: reverting `git()` to the literal-`git`/ambient-env form left the
// `git-envelope-is-mandatory` arm GREEN — because that arm pins the library's
// ABSENCE, not its USE. A test that stays green with the fix reverted is not
// evidence for the fix (`instrument-discipline.md` MUST-2). This arm is the one
// that discriminates, and it is why the other one is not sufficient on its own.
//
// The decoy is a full COPY of the victim, so every OTHER query it answers is
// plausible and the ONLY semantic difference between the two repositories is the
// roster. Absent that, the poles could differ for a dozen reasons.
pair(
  "ambient-GIT_DIR-cannot-repoint-the-roster",
  "a decoy repository named by GIT_DIR does NOT get to supply the key list",
  () => {
    const dir = mkRepo({
      events: evtLog({}) + `${JSON.stringify(attackerRecord(ATTACKER))}\n`,
    });
    // The decoy: byte-identical, except its COMMITTED roster carries the attacker.
    const decoy = fs.mkdtempSync(path.join(os.tmpdir(), "bd-decoy-"));
    tmpDirs.push(decoy);
    fs.cpSync(dir, decoy, { recursive: true });
    addKeyToWorkingTreeRoster(decoy, ATTACKER);
    commitAll(decoy, "the decoy repository vouches for the attacker");
    const r = runGen(dir, ["--check-links"], GENERATOR, { GIT_DIR: path.join(decoy, ".git") });
    if (r.code === 0) return "an ambient GIT_DIR re-pointed the trust root — the decoy's roster was used";
    if (!/\[unrostered-signer\]/.test(r.err)) {
      return `refused, but not because the attacker stayed unvouched-for: ${r.err.slice(0, 300)}`;
    }
    if (!r.err.includes(ATTACKER.fingerprint)) return "the refusal does not name the untrusted fingerprint";
    return `RED:git-steering criterion=GIT_DIR-cannot-repoint decoy=ignored signer=${ATTACKER.fingerprint} exit=${r.code}`;
  },
  "with the attacker COMMITTED to THIS repository's own roster, the same tree verifies — the refusal tracked the roster, not the env",
  () => {
    const dir = mkRepo({
      events: evtLog({}) + `${JSON.stringify(attackerRecord(ATTACKER))}\n`,
    });
    addKeyToWorkingTreeRoster(dir, ATTACKER);
    commitAll(dir, "register the second operator in THIS repository");
    const decoy = fs.mkdtempSync(path.join(os.tmpdir(), "bd-decoy-green-"));
    tmpDirs.push(decoy);
    fs.cpSync(dir, decoy, { recursive: true });
    // Same ambient steering as the RED pole, so the env is NOT what differs.
    const r = runGen(dir, ["--check-links"], GENERATOR, { GIT_DIR: path.join(decoy, ".git") });
    if (r.code !== 0) return `a legitimately rostered signer was refused (exit ${r.code}): ${r.err.slice(0, 300)}`;
    if (!/SIGNATURES: 2 record\(s\) verified/.test(r.out)) return `the gate did not verify both records: ${r.out.slice(0, 300)}`;
    return `GREEN:git-steering criterion=GIT_DIR-cannot-repoint decoy=ignored signer=${ATTACKER.fingerprint} exit=0`;
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// ARM — IMPERSONATION: a ROSTERED name on an UNROSTERED signature is a FORGERY
// ═══════════════════════════════════════════════════════════════════════════
//
// THE ROUTE. The unrostered-signer arm below covers the case where `verified_id`
// names a fingerprint the roster does not carry — `resolveKey` returns nothing and
// the record short-circuits as INDETERMINATE before any verifier runs. That is
// correct, and it is NOT the natural forgery. The natural forgery sets
// `verified_id` to a ROSTERED operator's fingerprint and signs with an UNROSTERED
// key: `resolveKey` then SUCCEEDS with the victim's key, the record reaches the
// verify pass, and the signature is checked against a key that did not make it.
//
// It must land as `bad-signature`. Under gpg it very nearly did not: the shared
// homedir is built from the ROSTER and never receives the attacker's key, so gpg
// emits ERRSIG/NO_PUBKEY with NO BADSIG, which the first cut of the INDETERMINATE
// widening read as "the verifier could not run" — telling the operator to repair
// gpg while a forgery sat on disk. See `coc-sign.js::_gpgNonZeroIsRecordVerdict`.
pair(
  "impersonation-is-a-forgery-not-an-outage",
  "a record NAMING a rostered signer but SIGNED by an unrostered key is refused as a FORGERY",
  () => {
    // The impersonated record must be WELL-FORMED, or the fold refuses it first
    // and the arm measures corruption instead of impersonation. MEASURED when it
    // was not: "the fold reports 1 considered of 2 non-blank line(s)". So it is
    // chained properly — `seq: 2` with `prev_hash` = the canonical hash of record
    // one — because it CLAIMS to be that emitter's second record. Signed by
    // ATTACKER; `verified_id` overridden BEFORE signing, so the claim sits inside
    // the signed bytes and nothing about the line is malformed.
    const first = evtRecord({}, 1, null, false, SIGNER);
    const h = canonicalRecordHash(first);
    if (!h.ok) return `the fixture could not hash the record it just built: ${h.reason}`;
    const impersonated = evtRecord(
      { verified_id: SIGNER.fingerprint, kind: "transition", weight: "live", status: "todo:in_progress" },
      2,
      h.hash,
      false,
      ATTACKER,
    );
    const dir = mkRepo({ events: `${JSON.stringify(first)}\n${JSON.stringify(impersonated)}\n` });
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 2) return `an impersonated record was ACCEPTED (exit ${r.code})`;
    if (!/\[bad-signature\]/.test(r.err)) {
      return `refused, but not as a signature failure — an impersonation reported as an outage sends the operator to repair the toolchain: ${r.err.slice(0, 300)}`;
    }
    if (/signature verification could not RUN over/.test(r.err)) {
      return `the verdict was INDETERMINATE, not a forgery: ${r.err.slice(0, 300)}`;
    }
    return `RED:impersonation criterion=rostered-name-unrostered-key kind=bad-signature exit=2`;
  },
  "the SAME record, signed by the key it NAMES, verifies",
  () => {
    const dir = mkRepo({
      events: evtLog({}, { over: { kind: "transition", weight: "live", status: "todo:in_progress" } }),
    });
    const r = runGen(dir, ["--check-links"]);
    if (r.code !== 0) return `an honest record was refused (exit ${r.code}): ${r.err.slice(0, 240)}`;
    if (!/chain INTACT/.test(r.out)) return `unexpected stdout: ${r.out.slice(0, 200)}`;
    return `GREEN:impersonation criterion=rostered-name-unrostered-key kind=none exit=0`;
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// ARM — THE COMPAT GUARD REACHES THE LEAF LIBRARY, AND A THROW IS TYPED
// ═══════════════════════════════════════════════════════════════════════════
//
// The guard named four `signed-log.js` exports and stopped there. But `signed-log.js`
// is not the leaf: it destructures `coc-sign.js` at load time — which yields
// `undefined` rather than failing — and calls into it 500 lines later. A CURRENT
// `signed-log.js` beside a STALE `coc-sign.js` therefore passed every check and then
// threw a bare `TypeError`, which is not an `Unrunnable`, so it rethrew with an
// ABSOLUTE-PATH stack trace and exited 1 — the code this file's ladder reserves for
// STALE. Verbatim the failure the guard exists to prevent, one dependency down.

/** A repo carrying its OWN copy of the bin + hooks tree, so a library can be aged. */
function mkOwnHooksRepo(cocSignBody) {
  const dir = mkRepo();
  const binDir = path.join(dir, ".claude", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  copyStaticImportClosure({ fromRoot: REPO_ROOT, toRoot: dir, entries: [GENERATOR] });
  fs.cpSync(path.join(REPO_ROOT, ".claude", "hooks"), path.join(dir, ".claude", "hooks"), { recursive: true });
  if (cocSignBody !== undefined) {
    fs.writeFileSync(path.join(dir, ".claude", "hooks", "lib", "coc-sign.js"), cocSignBody);
  }
  commitAll(dir, "carry an own bin + hooks tree");
  return { dir, tool: path.join(binDir, "burndown-build.mjs") };
}

// A coc-sign.js from BEFORE the shared verify-homedir lifecycle (F17) existed:
// structurally a module, semantically a tree the current signed-log.js cannot use.
const STALE_COC_SIGN = `"use strict";
module.exports = {
  canonicalSerialize: require("node:util").inspect,
  verify: () => ({ ok: true, valid: true }),
};
`;

pair(
  "compat-guard-reaches-coc-sign",
  "a STALE coc-sign.js beside a current signed-log.js gets a TYPED refusal, not a stack trace",
  () => {
    const { dir, tool } = mkOwnHooksRepo(STALE_COC_SIGN);
    const r = runGen(dir, ["--check-links"], tool);
    if (r.code !== 2) return `a stale signing library exited ${r.code}; it must be UNRUNNABLE (exit 2)`;
    if (/node:internal\/modules|\n\s+at /.test(r.err)) return `the failure is a raw stack trace, not a typed refusal: ${r.err.slice(0, 240)}`;
    if (!/^UNRUNNABLE — refusing because /m.test(r.err)) return "the refusal is not the LOUD UNRUNNABLE form";
    if (!/coc-sign\.js' loaded but exports no/.test(r.err)) return `refused for another reason: ${r.err.slice(0, 240)}`;
    if (!/createVerifyHomedir/.test(r.err)) return "the refusal does not name WHICH export is missing";
    if (r.err.includes(dir)) return "the refusal leaked the operator's absolute tree";
    return `RED:compat-guard criterion=transitive-library lib=coc-sign.js missing=createVerifyHomedir exit=2`;
  },
  "the SAME own-hooks tree with the REAL coc-sign.js verifies and folds",
  () => {
    const { dir, tool } = mkOwnHooksRepo();
    const r = runGen(dir, ["--check-links"], tool);
    if (r.code !== 0) return `an own-hooks tree with a current coc-sign.js exited ${r.code}: ${r.err.slice(0, 240)}`;
    if (!/chain INTACT/.test(r.out)) return `unexpected stdout: ${r.out.slice(0, 200)}`;
    return `GREEN:compat-guard criterion=transitive-library lib=coc-sign.js missing=none exit=0`;
  },
);

// A coc-sign.js that satisfies every STRUCTURAL check the guard can make — all four
// exports present, all four functions — and is still stale in the way that matters:
// its `verify` throws instead of returning. This is the residue the guard CANNOT
// see, and is exactly why the call site needs a try/catch as well.
const THROWING_COC_SIGN = `"use strict";
const real = require("node:module").createRequire(__filename);
module.exports = {
  canonicalSerialize: (v) => Buffer.from(JSON.stringify(v), "utf8"),
  verify: () => { throw new TypeError("coc-sign::verify signature changed in a way the guard cannot see"); },
  createVerifyHomedir: () => ({ ok: false, reason: "stale" }),
  destroyVerifyHomedir: () => {},
  SSH_NAMESPACE: "coc-multi-operator",
  _real: real,
};
`;

check("read-gate-throw · a NON-Unrunnable throw out of the read gate surfaces as the typed STALE diagnostic, not a raw trace", () => {
  const { dir, tool } = mkOwnHooksRepo(THROWING_COC_SIGN);
  const r = runGen(dir, ["--check-links"], tool);
  if (r.code !== 2) return `a throwing verify exited ${r.code}; it must be UNRUNNABLE (exit 2), never 1 (STALE) with a trace`;
  if (/\n\s+at /.test(r.err)) return `the failure printed stack frames: ${r.err.slice(0, 300)}`;
  if (r.err.includes(dir)) return "the failure leaked the operator's absolute tree";
  if (!/the signature read gate threw a TypeError/.test(r.err)) {
    return `refused, but not with the typed read-gate diagnostic: ${r.err.slice(0, 300)}`;
  }
  if (!/INDETERMINATE/.test(r.err)) return "the diagnostic does not say the log's integrity is UNKNOWN";
  return true;
});

check("read-gate-throw · MUTATION · rethrowing every error prints the raw stack trace and exits 1 — the code reserved for STALE", () => {
  // The counterfactual is the pre-fix behaviour: no typing at the call site. Its
  // exit code (1, meaning STALE) and its stack frames are what the arm above exists
  // to have replaced, and measuring them here is what proves the try/catch is what
  // produced the typed verdict rather than something upstream.
  // NOT `mutantTool`, deliberately: that harness REBASES the lazy requires onto the
  // REAL repo tree, which would load the real `coc-sign.js` and the throw would never
  // happen — the mutation would be inert, leaving two live hypotheses. The fixture
  // repo already carries its OWN complete hooks tree, so the mutant is written beside
  // it and resolves the STALE library through the ordinary relative path.
  const { dir, tool } = mkOwnHooksRepo(THROWING_COC_SIGN);
  const mutantPath = path.join(path.dirname(tool), "mutant-rethrow.mjs");
  fs.writeFileSync(
    mutantPath,
    subOnce(fs.readFileSync(tool, "utf8"), "      if (e instanceof Unrunnable) throw e;", "      throw e;"),
  );
  const real = runGen(dir, ["--check-links"], tool);
  const mutant = runGen(dir, ["--check-links"], mutantPath);
  if (real.code !== 2) return `the real binary did not produce the typed refusal (exit ${real.code}): ${real.err.slice(0, 240)}`;
  if (mutant.code === 2) {
    return `the mutant ALSO produced a typed refusal (exit 2) — UNRESOLVED, not a verdict: ${mutant.err.slice(0, 240)}`;
  }
  if (!/\n\s+at /.test(mutant.err)) {
    return `the mutant exited ${mutant.code} but printed no stack frames — the counterfactual did not reproduce: ${mutant.err.slice(0, 240)}`;
  }
  return true;
});

// ═══════════════════════════════════════════════════════════════════════════
// LIBRARY-LEVEL — the three properties the CLI surface cannot isolate
// ═══════════════════════════════════════════════════════════════════════════

const signedLog = require(path.join(REPO_ROOT, ".claude", "hooks", "lib", "signed-log.js"));
const openpgpVerify = require(path.join(REPO_ROOT, ".claude", "hooks", "lib", "openpgp-verify.js"));

function fixturePolicy() {
  const p = signedLog.resolveSuitePolicy(fixtureSuiteDeclaration(), { where: "fixture" });
  if (!p.ok) throw new Error(`the fixture suite declaration did not resolve: ${p.reason}`);
  return p.policy;
}

const RESOLVES_TO_SIGNER = () => ({
  pubkey: SIGNER.pubkey,
  keyType: "ssh",
  fingerprint: SIGNER.fingerprint,
});

check("zero-record-fence · verifyLogSignatures REFUSES an empty log instead of reporting a clean verification of ZERO records", () => {
  // The pre-fix return was `{ok:true, checked:0}` — a CLEAN verdict over an EMPTY
  // population, i.e. output that cannot tell "every record verified" from "there was
  // nothing here". It was unreachable from the CLI only because `foldLedgerEvents`
  // refuses first, EIGHT LINES EARLIER — an undocumented ordering dependency carrying
  // this gate's entire non-vacuity. Called directly, the fence must be the function's
  // own, which is what this asserts and what the CLI arm structurally cannot.
  for (const [label, text] of [["empty string", ""], ["whitespace only", "\n\n   \n"]]) {
    const r = signedLog.verifyLogSignatures(text, fixturePolicy(), { resolveKey: RESOLVES_TO_SIGNER });
    if (r.ok === true) return `a ${label} log returned ok:true with checked=${r.checked} — a clean verification of ZERO records`;
    if (r.indeterminate !== true) return `a ${label} log refused, but not as INDETERMINATE`;
    if (!(r.findings || []).some((f) => f.kind === "no-records")) {
      return `a ${label} log refused without the typed no-records finding: ${JSON.stringify(r.findings)}`;
    }
  }
  // The other pole, in the same case: a NON-empty log must still be able to pass, or
  // the fence above would be indistinguishable from "this function refuses everything".
  const live = signedLog.verifyLogSignatures(evtLine(), fixturePolicy(), { resolveKey: RESOLVES_TO_SIGNER });
  if (live.ok !== true) return `a healthy one-record log was ALSO refused (${JSON.stringify(live.findings)}) — the fence refuses everything`;
  if (live.checked !== 1) return `a healthy one-record log reported checked=${live.checked}, expected 1`;
  return true;
});

check("identity-bind · a resolver that omits `fingerprint` FAILS CLOSED instead of binding to the record's own field", () => {
  // The pre-fix line was `expectedFpr: key.fingerprint || record.verified_id`. Dead
  // under today's roster resolver, and `resolveKey` is INJECTABLE — so for any
  // resolver omitting `fingerprint` the identity bind silently became an
  // ATTACKER-CONTROLLED RECORD FIELD, and `gpg --verify` would then be asked to
  // confirm the signer is whoever the record says it is, which it trivially is.
  const noFpr = () => ({ pubkey: SIGNER.pubkey, keyType: "ssh" });
  const r = signedLog.verifyLogSignatures(evtLine(), fixturePolicy(), { resolveKey: noFpr });
  if (r.ok === true) return "a fingerprint-less resolver produced a CLEAN verification — the bind fell back to the record";
  if (r.indeterminate !== true) return `refused, but not as INDETERMINATE: ${JSON.stringify(r.findings)}`;
  const f = (r.findings || []).find((x) => x.kind === "no-signer-fingerprint");
  if (!f) return `refused without the typed finding: ${JSON.stringify(r.findings)}`;
  // The bipolar half: the SAME log, the SAME key material, WITH a fingerprint, must
  // verify — so the refusal above is attributable to the missing field alone.
  const withFpr = signedLog.verifyLogSignatures(evtLine(), fixturePolicy(), { resolveKey: RESOLVES_TO_SIGNER });
  if (withFpr.ok !== true) return `the same resolver WITH a fingerprint was also refused: ${JSON.stringify(withFpr.findings)}`;
  return true;
});

check("identity-bind · the length floor measures the SAME normalization the bind consumes", () => {
  // F9 — THE POLE THAT WAS MISSING, and its absence is why the defect below was
  // findable by reading rather than by running. The only pre-existing case
  // touching `no-signer-fingerprint` omitted `fingerprint` ENTIRELY, exercising
  // the `!fpr` branch and never the length branch — so the floor shipped
  // bipolar-uncovered and nothing measured WHICH string it measured.
  //
  // The defect: the floor used `.trim()` (edge whitespace) while the bind uses
  // `.replace(/\s+/g,"")` (interior too). "1  2  3  4  5  6" is 16 after trim
  // and SIX after the strip, so a PADDED entry cleared the floor and reached the
  // bind degenerate. And OpenPGP fingerprints are conventionally written WITH
  // spaces, so such an entry looks normal in review.
  const cases = [
    ["a padded short fingerprint (16 after trim, 6 after the real normalization)", "1  2  3  4  5  6"],
    ["a bare short fingerprint", "ABCD1234"],
    ["whitespace only", "     "],
    ["a fingerprint that is ONLY separators", "  \t  \t "],
  ];
  for (const [label, fingerprint] of cases) {
    const r = signedLog.verifyLogSignatures(evtLine(), fixturePolicy(), {
      resolveKey: () => ({ pubkey: SIGNER.pubkey, keyType: "ssh", fingerprint }),
    });
    if (r.ok === true) return `${label} produced a CLEAN verification — the floor did not fire`;
    if (r.indeterminate !== true) return `${label} was refused, but not as INDETERMINATE: ${JSON.stringify(r.findings)}`;
    if (!(r.findings || []).some((f) => f.kind === "no-signer-fingerprint")) {
      return `${label} refused without the typed finding: ${JSON.stringify(r.findings)}`;
    }
  }
  // The other pole: a real fingerprint — which in this suite is a `SHA256:`
  // digest ~50 chars — must still verify, or the floor is indistinguishable from
  // "this function refuses every roster".
  const good = signedLog.verifyLogSignatures(evtLine(), fixturePolicy(), { resolveKey: RESOLVES_TO_SIGNER });
  if (good.ok !== true) return `an HONEST full-length fingerprint was also refused: ${JSON.stringify(good.findings)}`;
  // And a fingerprint carrying the conventional GPG spacing must PASS: the fix
  // is "normalize before measuring", not "reject anything with a space in it".
  const spaced = SIGNER.fingerprint.replace(/(.{4})/g, "$1 ");
  const spacedRes = signedLog.verifyLogSignatures(evtLine(), fixturePolicy(), {
    resolveKey: () => ({ pubkey: SIGNER.pubkey, keyType: "ssh", fingerprint: spaced }),
  });
  if (spacedRes.ok !== true) {
    return `a conventionally SPACED full-length fingerprint was refused — the floor now rejects the normal GPG form: ${JSON.stringify(spacedRes.findings)}`;
  }
  return true;
});

check("identity-bind · the floor is enforced at the SHARED callee, so every caller inherits it", () => {
  // F2 — `MIN_SIGNER_FINGERPRINT_CHARS` sat in `signed-log.js` while FIVE call
  // sites reach the bind in `coc-sign.js`. Four of them (coordination-log,
  // fold-verification-checkpoint, presence-proof-verify, state-file-write-guard)
  // had no floor at all. This drives `coc-sign.verify` DIRECTLY — the shared
  // callee, bypassing signed-log entirely — which is the only way to show the
  // control is where every caller inherits it rather than where one caller has it.
  const short = cocSign.verify(Buffer.from("payload"), "sig", "pub", {
    keyType: "gpg",
    expectedFpr: "1  2  3  4  5  6",
  });
  if (short.ok !== false) return `the shared callee ACCEPTED a padded short expectedFpr: ${JSON.stringify(short)}`;
  if (!/invalid expected fingerprint/.test(short.error || "")) {
    return `refused, but not with the typed floor error: ${JSON.stringify(short)}`;
  }
  // The compliant pole must reach the real verifier rather than the floor — it
  // will fail for a DIFFERENT reason (the sig is not a signature), and that
  // difference is what shows the floor is not simply refusing everything.
  const longFpr = cocSign.verify(Buffer.from("payload"), "sig", "pub", {
    keyType: "gpg",
    expectedFpr: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
  });
  if (longFpr.ok === false && /invalid expected fingerprint/.test(longFpr.error || "")) {
    return "a full-length fingerprint was ALSO rejected by the floor";
  }
  return true;
});

check("identity-bind · VALIDSIG is matched by FIELD, not by substring — and the subkey field still counts", () => {
  // F3 — the bind was `wholeLine.replace(/\s+/g,"").includes(want)`. GnuPG's
  // VALIDSIG line carries several DECIMAL fields between the two fingerprints,
  // and every decimal digit is a hex digit, so an all-digit `want` could match a
  // run spanning timestamps and algo ids WITHOUT touching a signing key. A floor
  // makes that improbable; comparing FIELDS makes it impossible.
  //
  // Driven through a shim, because a healthy gpg will not emit a line shaped to
  // demonstrate the flaw. Field layout: [GNUPG:] VALIDSIG <fpr> <date> <ts>
  // <exp> <ver> <reserved> <pk-algo> <hash-algo> <sig-class> [<primary-fpr>].
  const SIGNING = "AAAABBBBCCCCDDDDEEEEFFFF0000111122223333";
  const PRIMARY = "9999888877776666555544443333222211110000";
  const line = `[GNUPG:] VALIDSIG ${SIGNING} 2026-08-24 1787000000 0 4 0 1 8 00 ${PRIMARY}`;
  const shim = `#!/bin/sh\nfor a in "$@"; do case "$a" in --import) exit 0;; esac; done\necho '${line}'\nexit 0\n`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bd-validsig-"));
  tmpDirs.push(home);
  const run = (expectedFpr) =>
    withGpgShim(shim, () => cocSign.verify(Buffer.from("payload"), "sig", "pub", { keyType: "gpg", gpgHome: home, expectedFpr }));

  // The SIGNING key field — the ordinary case.
  if (run(SIGNING).valid !== true) return "the signing-key fingerprint did not match its own VALIDSIG field";
  // The PRIMARY key field — a subkey signer whose roster entry is the primary.
  // `coc-sign-shared-homedir.test.mjs` locks this by name; tightening to field 1
  // alone would silently reject every subkey signer.
  if (run(PRIMARY).valid !== true) return "the PRIMARY-key fingerprint no longer matches — subkey signers would be rejected";
  // A run of digits drawn from the NON-fingerprint fields, and it is CONSTRUCTED
  // rather than guessed: an earlier attempt used "2026082417870000", which does
  // NOT appear in the concatenation because the date's HYPHENS are not whitespace
  // and survive the strip — so the pole passed under the old substring bind too
  // and the arm measured nothing (observed: reverting to `.includes()` left this
  // suite GREEN). The run below spans the sig-timestamp and the algorithm-id
  // fields and IS present in the concatenated line; length 16 clears the floor,
  // so the floor is not what refuses it.
  const digitRun = "1787000000040180";
  const concatenated = line.toUpperCase().replace(/\s+/g, "");
  if (!concatenated.includes(digitRun)) {
    return `the arm is VACUOUS: '${digitRun}' does not appear in the concatenated VALIDSIG line, so the old substring bind would not have matched it either`;
  }
  const r = run(digitRun);
  if (r.valid === true) return `a digit run spanning the timestamp fields satisfied the identity bind: ${JSON.stringify(r)}`;
  if (r.ok === false) return `the digit-run pole was refused by the FLOOR, not by the bind — the arm measures the wrong thing: ${JSON.stringify(r)}`;
  // A genuine mismatch must still read as a mismatch, not as an outage.
  const other = run("1111222233334444555566667777888899990000");
  if (other.valid !== false) return "a different key satisfied the bind";
  if (other.indeterminate === true) return "a key MISMATCH was reported as an outage rather than a record fact";
  return true;
});

check("identity-bind · a crafted USER ID on a non-VALIDSIG line cannot satisfy the bind", () => {
  // THE HOLE THE FIELD-COMPARISON FIX DID NOT REACH, and the pole that would
  // have caught it. Comparing FIELDS closed the substring class; it said nothing
  // about WHICH LINE those fields are read from. The caller selected with
  // `/\bVALIDSIG\b/` — the word ANYWHERE on ANY line — and the field reader
  // trusted the positions without checking the line's own keyword tokens.
  //
  // gpg emits UID-bearing lines (GOODSIG, USERID_HINT) BEFORE the verdict, and
  // their trailing field is FREE-FORM TEXT chosen by whoever generated the key —
  // spaces unescaped. MEASURED against this module before the fix: a user ID of
  // the form `VALIDSIG a b c d e f g <victim-fpr> <addr>` puts the victim's
  // fingerprint at token 11 of a GOODSIG line, that line satisfied the selector,
  // and `verify` returned {ok:true, valid:true} for a record the victim's key
  // never signed.
  //
  // The adversary is the one the bind was written for: a ROSTERED operator
  // forging a record attributed to ANOTHER. gpg exits 0 throughout, because the
  // attacker's key really is in the roster-built keyring.
  //
  // Every prior gpg-shim arm in this suite emits ONE status line, so none of them
  // could see this: `evidence-first-claims.md` MUST-6 — a green covers the class
  // its instrument can observe, and a single-line stream cannot observe line
  // SELECTION.
  //
  // WHAT THIS ARM MEASURES, stated so its green is not over-read: the fix is
  // DEFENSE IN DEPTH — the caller anchors its selector AND `_validsigNamesKey`
  // checks its own keyword tokens — and EITHER half alone closes the hole. So
  // reverting one half leaves this arm GREEN, which is the defense working, not
  // the arm being vacuous. MEASURED both ways: with either half reverted the
  // suite stays green; with BOTH reverted (the state the code was actually in)
  // this arm reds with "IMPERSONATION ACCEPTED … {ok:true, valid:true}". The
  // conjunction is the property; a single-revert green is not evidence about
  // either half on its own.
  const VICTIM = "AAAABBBBCCCCDDDDEEEEFFFF0000111122223333";
  const ATTACKER = "1111222233334444555566667777888899990000";
  const craftedUid = `VALIDSIG a b c d e f g ${VICTIM} attacker@example.invalid`;
  const goodsig = `[GNUPG:] GOODSIG DEADBEEFDEADBEEF ${craftedUid}`;

  // The payload's GEOMETRY is asserted before any verdict is read. An earlier
  // revision of this probe used EIGHT filler tokens, which put the fingerprint at
  // index 12 and made the attack pole read as REFUSED — an instrument miscounting
  // its own payload, indistinguishable from a closed hole.
  const tokens = goodsig.trim().split(/\s+/);
  if (tokens[11] !== VICTIM) {
    return `the pole is MIS-BUILT: the victim fingerprint sits at index ${tokens.indexOf(VICTIM)}, not 11, so a refusal below would measure nothing`;
  }

  const multiline = (lines) =>
    [
      "#!/bin/sh",
      'home=""; prev=""',
      'for a in "$@"; do if [ "$prev" = "--homedir" ]; then home="$a"; fi; prev="$a"; done',
      'case " $* " in *" --import "*) mkdir -p "$home"; printf KBX > "$home/pubring.kbx"; exit 0;; esac',
      ...lines.map((l) => `echo '${l}'`),
      "exit 0",
      "",
    ].join("\n");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bd-uidattack-"));
  tmpDirs.push(home);
  const run = (lines, expectedFpr) =>
    withGpgShim(multiline(lines), () =>
      cocSign.verify(Buffer.from("payload"), "sig", "pub", { keyType: "gpg", gpgHome: home, expectedFpr }),
    );

  // CONTROL FIRST — a genuine, correctly-shaped VALIDSIG naming the victim must
  // verify. Without it, a refusal on the attack pole is equally consistent with
  // "the bind works" and "this shim never verifies anything".
  const control = run(
    [`[GNUPG:] NEWSIG`, `[GNUPG:] VALIDSIG ${VICTIM} 2026-08-24 1787000000 0 4 0 1 8 00 ${VICTIM}`],
    VICTIM,
  );
  if (control.valid !== true) return `the CONTROL did not verify, so this arm can prove nothing: ${JSON.stringify(control)}`;

  // THE ATTACK — the attacker's key genuinely signed; the victim's fingerprint
  // appears only inside the crafted UID, on a line that is not the verdict.
  const attack = run(
    [
      `[GNUPG:] NEWSIG`,
      `[GNUPG:] KEY_CONSIDERED ${ATTACKER} 0`,
      goodsig,
      `[GNUPG:] VALIDSIG ${ATTACKER} 2026-08-24 1787000000 0 4 0 1 8 00 ${ATTACKER}`,
    ],
    VICTIM,
  );
  if (attack.valid === true) {
    return `IMPERSONATION ACCEPTED: a record signed by the attacker was attributed to the victim — ${JSON.stringify(attack)}`;
  }
  // And the refusal must come from reading the REAL verdict line, not from
  // failing to find any line at all: an "exited 0 but emitted no VALIDSIG"
  // indeterminate here would mean the selector had become blind rather than
  // accurate, which passes this arm for the wrong reason.
  if (attack.indeterminate === true) {
    return `the selector went BLIND rather than accurate — it found no VALIDSIG line in a stream that has one: ${JSON.stringify(attack)}`;
  }
  return true;
});

check("indeterminate-taxonomy · a status KEYWORD is read positionally, so a user ID spelling one cannot flip the verdict", () => {
  // The same class in the REFUSE direction. `BADSIG`/`NODATA`/`NO_PUBKEY` were
  // matched with `\bTOKEN\b` against the WHOLE status blob, so a user ID
  // CONTAINING one of those words flipped the record-verdict predicate — turning
  // a toolchain outage into a forgery accusation against a signer who did
  // nothing wrong. A keyword is token 1 of a line whose token 0 is `[GNUPG:]`.
  const FPR = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bd-kwattack-"));
  tmpDirs.push(home);
  const shim = [
    "#!/bin/sh",
    'home=""; prev=""',
    'for a in "$@"; do if [ "$prev" = "--homedir" ]; then home="$a"; fi; prev="$a"; done',
    'case " $* " in *" --import "*) mkdir -p "$home"; printf KBX > "$home/pubring.kbx"; exit 0;; esac',
    // An operational failure, whose USER ID happens to spell BADSIG.
    'echo "[GNUPG:] NEWSIG"',
    'echo "[GNUPG:] USERID_HINT DEADBEEF a user named BADSIG NODATA <x@y.invalid>"',
    'echo "gpg: keyblock resource unusable" 1>&2',
    "exit 2",
    "",
  ].join("\n");
  const r = withGpgShim(shim, () =>
    cocSign.verify(Buffer.from("payload"), "sig", "pub", { keyType: "gpg", gpgHome: home, expectedFpr: FPR }),
  );
  if (r.valid !== false) return `fail-open: ${JSON.stringify(r)}`;
  if (r.indeterminate !== true) {
    return `a user ID spelling BADSIG turned an OUTAGE into a forgery accusation: ${JSON.stringify(r)}`;
  }
  // The compliant pole: a REAL BADSIG keyword must still read as a record fact,
  // or the fix has simply made the predicate blind.
  const realBad = withGpgShim(
    shim.replace('echo "[GNUPG:] USERID_HINT DEADBEEF a user named BADSIG NODATA <x@y.invalid>"', 'echo "[GNUPG:] BADSIG DEADBEEF a user <x@y.invalid>"'),
    () => cocSign.verify(Buffer.from("payload"), "sig", "pub", { keyType: "gpg", gpgHome: home, expectedFpr: FPR }),
  );
  if (realBad.indeterminate === true) return `a GENUINE BADSIG keyword was no longer recognised: ${JSON.stringify(realBad)}`;
  return true;
});

check("batch-isolation · ONE record naming a wrong-key-type signer does not take the whole log down", () => {
  // MEASURED before the fix, whole chain: an attacker appends ONE line — current
  // generation, `verified_id` set to a rostered signer whose roster key is of the
  // OTHER suite, `sig` anything — with no signing key and no roster write. Pass 1
  // keyed the shared keyring off the GENERATION's type and never read the KEY's,
  // so the wrong-suite key entered the keyring, `createVerifyHomedir` failed on
  // it, and the ENTIRE build refused with "a shared GPG verification homedir
  // could not be created" — a per-record fault promoted to a whole-batch verifier
  // outage, with the operator sent to repair gpg.
  //
  // Driven at the library, because the CLI surface cannot show the difference:
  // both states refuse. What must differ is WHICH line is named and whether the
  // other records were still checked.
  //
  // SCOPE, so this green is not over-read. This suite signs with ssh, so the pole
  // exercises the MIRROR direction of the same root cause — an ssh generation
  // whose roster entry declares `gpg`. With the check reverted that record is not
  // routed to `gpgPubKeys` at all and simply VERIFIES, which is why the observed
  // RED here is "produced a CLEAN verification" rather than the keyring-poisoning
  // outage measured in production. Same defect (the key's own type was never
  // consulted), and this direction is the more dangerous of the two — but the
  // gpg-keyring-poisoning path itself needs real OpenPGP material and is NOT
  // covered by this arm.
  const twoRecords = evtLog({}, { over: { item_id: "R2-beta-item" } });
  const mixedResolver = (verifiedId) =>
    verifiedId === SIGNER.fingerprint
      ? { pubkey: SIGNER.pubkey, keyType: "gpg", fingerprint: SIGNER.fingerprint } // WRONG suite for this generation
      : null;
  const poisoned = signedLog.verifyLogSignatures(twoRecords, fixturePolicy(), { resolveKey: mixedResolver });
  if (poisoned.ok === true) return "a wrong-key-type signer produced a CLEAN verification";
  if (poisoned.indeterminate !== true) return `refused, but not as INDETERMINATE: ${JSON.stringify(poisoned.findings)}`;
  const kinds = (poisoned.findings || []).map((f) => f.kind);
  if (!kinds.includes("signer-key-type-mismatch")) {
    return `the fault was not attributed to the RECORD — kinds ${JSON.stringify(kinds)}. A batch-level outage here is the defect.`;
  }
  // THE LINE IS NAMED. A whole-batch failure reports line 0; a per-record finding
  // reports the ordinal, and that difference is the entire point of the fix.
  if (!(poisoned.findings || []).some((f) => f.kind === "signer-key-type-mismatch" && f.line > 0)) {
    return `the finding names no line — it is still a batch-level verdict: ${JSON.stringify(poisoned.findings)}`;
  }
  // And the healthy pole: the SAME log with a correctly-typed roster entry
  // verifies, so the refusal above tracked the key type and nothing else.
  const healthy = signedLog.verifyLogSignatures(twoRecords, fixturePolicy(), { resolveKey: RESOLVES_TO_SIGNER });
  if (healthy.ok !== true) return `the same log with a correctly-typed key was ALSO refused: ${JSON.stringify(healthy.findings)}`;
  if (healthy.checked !== 2) return `the healthy pole checked ${healthy.checked} record(s), expected 2`;
  return true;
});

check("identity-bind · a well-formed fingerprint of the WRONG VERSION is a roster defect, not a different key", () => {
  // The 64-hex arm added alongside the form check re-created a slice of the very
  // defect that check was for. Equality is length-sensitive, so a 64-hex (v5)
  // roster value against a v4 key — whose VALIDSIG fields are 40 hex — is
  // WELL-FORMED, clears the form check, can never equal either field, and used to
  // land on the mismatch branch: "signature verified against a DIFFERENT key than
  // expected". A forgery accusation over a roster VERSION mismatch.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bd-fprversion-"));
  tmpDirs.push(home);
  const V4 = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
  const V5 = "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789";
  const shim = [
    "#!/bin/sh",
    'home=""; prev=""',
    'for a in "$@"; do if [ "$prev" = "--homedir" ]; then home="$a"; fi; prev="$a"; done',
    'case " $* " in *" --import "*) mkdir -p "$home"; printf KBX > "$home/pubring.kbx"; exit 0;; esac',
    `echo "[GNUPG:] VALIDSIG ${V4} 2026-08-24 1787000000 0 4 0 1 8 00 ${V4}"`,
    "exit 0",
    "",
  ].join("\n");
  const run = (expectedFpr) =>
    withGpgShim(shim, () =>
      cocSign.verify(Buffer.from("payload"), "sig", "pub", { keyType: "gpg", gpgHome: home, expectedFpr }),
    );
  // A v5-shaped entry against a v4 key: the two can never be equal, whatever the key.
  const wrongVersion = run(V5);
  if (wrongVersion.valid === true) return "a 64-hex value matched a 40-hex field — equality is not length-sensitive?";
  if (wrongVersion.indeterminate !== true) {
    return `a fingerprint-VERSION mismatch was reported as a different key: ${JSON.stringify(wrongVersion)}`;
  }
  // A DIFFERENT key of the SAME version must still read as a mismatch, or the fix
  // has swallowed the real finding along with the false one.
  const differentKey = run("1111222233334444555566667777888899990000");
  if (differentKey.indeterminate === true) {
    return `a genuinely DIFFERENT key of the same version was excused as a form defect: ${JSON.stringify(differentKey)}`;
  }
  if (differentKey.valid !== false) return `a different key verified: ${JSON.stringify(differentKey)}`;
  // And the matching case still verifies.
  if (run(V4).valid !== true) return "the correct v4 fingerprint no longer verifies";
  return true;
});

check("identity-bind · a cross-version IMPERSONATION still BLOCKS; only a mis-transcribed roster entry is excused", () => {
  // The excuse added for a roster-VERSION mismatch had two causes producing
  // byte-identical evidence, and resolving every case to the benign one
  // relabelled the malignant one from blocking to advisory:
  //   (a) roster defect — the roster's fingerprint field mis-transcribes the SAME
  //       key. INDETERMINATE is right.
  //   (b) IMPERSONATION — a rostered operator whose key is a DIFFERENT VERSION
  //       signs a record naming another rostered operator. Their key is in the
  //       shared ring because their own legitimate records put it there, gpg
  //       exits 0, and the fingerprints differ in length only because the two
  //       PEOPLE use different key versions. That is a forgery.
  // Not reachable on today's roster (one gpg key, so no second gpg operator to be
  // the attacker) — it arms the moment a second is rostered at another version.
  //
  // What separates them is what the SUPPLIED KEY MATERIAL hashes to, so both
  // poles hand `verify` a real armored key and differ only in whether the
  // VALIDSIG names THAT key.
  const realKey = fs.readFileSync(path.join(REPO_ROOT, ".claude", "operators.roster.json"), "utf8");
  const gpgEntry = JSON.parse(realKey).persons;
  let armored = null;
  for (const p of Object.values(gpgEntry || {})) {
    for (const k of p.keys || []) if (k.type === "gpg" && typeof k.pubkey === "string") armored = k.pubkey;
  }
  if (!armored) return "the repo roster carries no gpg key, so this arm cannot supply real key material";
  const derived = openpgpVerify.fingerprintFromArmoredKey(armored);
  if (!derived) return "the roster's gpg key is not one this parser derives from — the arm cannot discriminate, so it must not report a verdict";

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bd-crossver-"));
  tmpDirs.push(home);
  const V5_WANT = "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789";
  const OTHER40 = "1111222233334444555566667777888899990000";
  const mk = (fpr) =>
    [
      "#!/bin/sh",
      'home=""; prev=""',
      'for a in "$@"; do if [ "$prev" = "--homedir" ]; then home="$a"; fi; prev="$a"; done',
      'case " $* " in *" --import "*) mkdir -p "$home"; printf KBX > "$home/pubring.kbx"; exit 0;; esac',
      `echo "[GNUPG:] VALIDSIG ${fpr} 2026-08-24 1787000000 0 4 0 1 8 00 ${fpr}"`,
      "exit 0",
      "",
    ].join("\n");
  const run = (validsigFpr, want) =>
    withGpgShim(mk(validsigFpr), () =>
      cocSign.verify(Buffer.from("payload"), "sig", armored, {
        keyType: "gpg",
        gpgHome: home,
        expectedFpr: want,
        keyringIsTrustSet: true,
      }),
    );

  // (a) THE ROSTER DEFECT — the VALIDSIG names the SUPPLIED key; `want` is merely
  // a v5-shaped mis-transcription of it. Excused, INDETERMINATE.
  const rosterDefect = run(derived, V5_WANT);
  if (rosterDefect.indeterminate !== true) {
    return `a genuine roster mis-transcription was accused rather than excused: ${JSON.stringify(rosterDefect)}`;
  }
  // (b) THE IMPERSONATION — a DIFFERENT key signed. Same length difference, same
  // shape of evidence, opposite cause. Must BLOCK, not be excused.
  const impersonation = run(OTHER40, V5_WANT);
  if (impersonation.valid !== false) return `fail-open: ${JSON.stringify(impersonation)}`;
  if (impersonation.indeterminate === true) {
    return `a cross-version IMPERSONATION was relabelled ADVISORY — a different key signed and it was excused as a form defect: ${JSON.stringify(impersonation)}`;
  }
  return true;
});

check("surface-parity · the SIBLING consumers of the indeterminate contract distinguish it too", () => {
  // `security.md` § Enforcement-Surface Parity: a distinction promoted at one
  // surface must be learned by EVERY independent surface in the same change.
  // `coc-sign::verify` gained `indeterminate` — "the verifier never reached a
  // verdict" as against "this signature does not verify" — and two sibling
  // consumers still collapsed it, accusing an operator of forgery over what may
  // be a gpg outage or a roster defect.
  //
  // Driven through the REAL modules with an injected verdict, because the point
  // is the CLASSIFICATION each consumer makes, not the crypto beneath it.
  const coordLog = require(path.join(REPO_ROOT, ".claude", "hooks", "lib", "coordination-log.js"));
  const checkpoint = require(path.join(REPO_ROOT, ".claude", "hooks", "lib", "fold-verification-checkpoint.js"));
  for (const [label, mod] of [["coordination-log", coordLog], ["fold-verification-checkpoint", checkpoint]]) {
    if (!mod || typeof mod !== "object") return `${label} did not load as a module`;
  }
  // The contract both must honour, asserted on the SOURCE they actually ship:
  // an `indeterminate` verdict must not reach the operator as "did not verify".
  const sources = [
    ["coordination-log.js", fs.readFileSync(path.join(REPO_ROOT, ".claude", "hooks", "lib", "coordination-log.js"), "utf8")],
    ["fold-verification-checkpoint.js", fs.readFileSync(path.join(REPO_ROOT, ".claude", "hooks", "lib", "fold-verification-checkpoint.js"), "utf8")],
  ];
  for (const [name, src] of sources) {
    // A CHEAP STRUCTURAL FLOOR, and nothing more. It shows the field is consulted
    // and a distinct diagnosis exists; the DISPOSITION is pinned by the black-box
    // arms below, which are strictly stronger.
    //
    // AN EARLIER VERSION OF THIS COMMENT JUSTIFIED THE SOURCE-LEVEL FORM BY
    // CLAIMING "neither `_verifyRule1` nor the checkpoint verify loop is
    // exported, so a black-box pole would need a full coordination log plus a gpg
    // environment — a flake, not a test." THAT WAS FALSE. Both ARE exported —
    // `coordination-log.js::_internal._verifyRule1` and
    // `fold-verification-checkpoint.js::resolveCheckpointCoverage` — and a
    // black-box pole needs neither gpg nor a real log, because both call
    // `cocSign.verify` as a CALL-TIME PROPERTY LOOKUP on the shared exports
    // object, so the verdict can simply be substituted.
    //
    // How the false claim was reached, since the mechanism is the lesson: the
    // check that produced it filtered `Object.keys` through
    // `/verify|rule1|checkpoint/i`, and `_internal` — the CONTAINER holding
    // `_verifyRule1` — does not match that pattern, so the export was filtered
    // out of view. `resolveCheckpointCoverage` DID appear in the output and was
    // not recognised. A tally read instead of the hits
    // (`instrument-discipline.md` MUST-3(b)), then banked as a fact about a code
    // surface (`zero-tolerance.md` Rule 3e).
    if (!/\.indeterminate\s*===\s*true/.test(src)) {
      return `${name} does not consult the 'indeterminate' verdict — it collapses a verifier outage into a forgery accusation`;
    }
    if (!/could not RUN/.test(src)) {
      return `${name} consults the field but emits no distinct diagnosis for it`;
    }
  }
  return true;
});

check("surface-parity · _verifyRule1 DISPOSES an indeterminate verdict differently — black-box, three poles", () => {
  // Strictly stronger than the structural floor above: this pins the VERDICT the
  // consumer produces, not the presence of a field reference.
  //
  // No gpg and no real coordination log are needed. `coordination-log.js` calls
  // `cocSign.verify` as a call-time property lookup on the shared exports object,
  // so substituting that property redirects it deterministically.
  const coordLog = require(path.join(REPO_ROOT, ".claude", "hooks", "lib", "coordination-log.js"));
  const verifyRule1 = coordLog._internal && coordLog._internal._verifyRule1;
  if (typeof verifyRule1 !== "function") return "coordination-log.js no longer exports _internal._verifyRule1";

  const FPR = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
  const roster = { persons: { "pid-owner": { display_id: "owner", role: "owner", keys: [{ type: "gpg", fingerprint: FPR, pubkey: "PUB" }] } } };
  const record = { type: "claim", verified_id: FPR, person_id: "pid-owner", seq: 1, sig: "SIG" };
  const real = cocSign.verify;
  const poles = [
    ["valid", { ok: true, valid: true }, (r) => r.ok === true],
    ["indeterminate", { ok: true, valid: false, indeterminate: true, reason: "gpg --verify did not run: ENOENT" },
      (r) => r.ok === false && r.indeterminate === true && /could not RUN/.test(r.reason || "")],
    ["invalid", { ok: true, valid: false, reason: "gpg --verify exit 1: BAD signature" },
      (r) => r.ok === false && r.indeterminate !== true && /did not verify/.test(r.reason || "")],
  ];
  try {
    for (const [name, verdict, ok] of poles) {
      let calls = 0;
      cocSign.verify = () => { calls += 1; return verdict; };
      const r = verifyRule1(record, roster, {}, undefined);
      // POSITIVE CONTROL: a verdict reached without the verify running came from
      // an earlier fence (roster membership, key match), and would make `ok:false`
      // consistent with both hypotheses. This caught a real mis-built pole while
      // these arms were being written.
      if (calls !== 1) return `pole '${name}': the verify was called ${calls} time(s) — an earlier fence produced the verdict, so this pole measures nothing`;
      if (!ok(r)) return `pole '${name}' disposed wrongly: ${JSON.stringify({ ok: r.ok, indeterminate: r.indeterminate, reason: (r.reason || "").slice(0, 120) })}`;
    }
  } finally {
    cocSign.verify = real;
  }
  return true;
});

check("surface-parity · resolveCheckpointCoverage DISPOSES an indeterminate verdict differently — black-box, three poles", () => {
  const checkpoint = require(path.join(REPO_ROOT, ".claude", "hooks", "lib", "fold-verification-checkpoint.js"));
  if (typeof checkpoint.resolveCheckpointCoverage !== "function") return "fold-verification-checkpoint.js no longer exports resolveCheckpointCoverage";

  const FPR = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
  // `role: "owner"` — the eligibility gate reads the SINGULAR field, and an
  // owner-quorum signer is required before the verify is ever reached.
  const roster = { persons: { "pid-owner": { display_id: "owner", role: "owner", keys: [{ type: "gpg", fingerprint: FPR, pubkey: "PUB" }] } } };
  const prior = { type: "claim", verified_id: FPR, person_id: "pid-owner", seq: 1, sig: "S1" };
  // Built through the module's OWN builder, so both digests are correct by
  // construction rather than by guessing at them.
  const built = checkpoint.buildCheckpointContent({
    records: [prior], coveredCount: 1, rule1FailedIndices: [], derivedFrom: null,
    verifierMode: "full", verifiedAt: new Date().toISOString(), roster,
  });
  if (!built.ok) return `the fixture could not build a checkpoint content: ${built.reason}`;
  const records = [prior, { type: checkpoint.CHECKPOINT_TYPE, verified_id: FPR, person_id: "pid-owner", seq: 2, sig: "S2", content: built.content }];

  const real = cocSign.verify;
  const poles = [
    ["valid", { ok: true, valid: true }, (r) => r.coveredCount === 1 && r.checkpointIndex === 1],
    ["indeterminate", { ok: true, valid: false, indeterminate: true, reason: "gpg --verify did not run: ENOENT" },
      (r) => r.coveredCount === 0 && /could not RUN/.test(r.reason || "") && /UNVERIFIED, not forged/.test(r.reason || "")],
    ["invalid", { ok: true, valid: false, reason: "gpg --verify exit 1: BAD signature" },
      (r) => r.coveredCount === 0 && /did not verify/.test(r.reason || "") && !/could not RUN/.test(r.reason || "")],
  ];
  try {
    for (const [name, verdict, ok] of poles) {
      let calls = 0;
      cocSign.verify = () => { calls += 1; return verdict; };
      const r = checkpoint.resolveCheckpointCoverage(records, roster, {});
      if (calls !== 1) return `pole '${name}': the verify was called ${calls} time(s) — an earlier fence (shape, roster digest, eligibility) produced the verdict, so this pole measures nothing`;
      if (!ok(r)) return `pole '${name}' disposed wrongly: ${JSON.stringify({ coveredCount: r.coveredCount, checkpointIndex: r.checkpointIndex, reason: (r.reason || "").slice(0, 140) })}`;
    }
  } finally {
    cocSign.verify = real;
  }
  return true;
});

check("identity-bind · a VALIDSIG carrying NO fingerprint field accuses nobody", () => {
  // `lengths=[]` used to fall through to the mismatch branch and accuse the
  // record of forgery, where NO VALIDSIG line at all is correctly INDETERMINATE.
  // An accusation drawn from an ABSENT field.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bd-nofield-"));
  tmpDirs.push(home);
  const shim = [
    "#!/bin/sh",
    'home=""; prev=""',
    'for a in "$@"; do if [ "$prev" = "--homedir" ]; then home="$a"; fi; prev="$a"; done',
    'case " $* " in *" --import "*) mkdir -p "$home"; printf KBX > "$home/pubring.kbx"; exit 0;; esac',
    'echo "[GNUPG:] VALIDSIG"',
    "exit 0",
    "",
  ].join("\n");
  const r = withGpgShim(shim, () =>
    cocSign.verify(Buffer.from("payload"), "sig", "pub", {
      keyType: "gpg",
      gpgHome: home,
      expectedFpr: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
    }),
  );
  if (r.valid !== false) return `fail-open: ${JSON.stringify(r)}`;
  if (r.indeterminate !== true) return `a record was accused on an ABSENT fingerprint field: ${JSON.stringify(r)}`;
  return true;
});

check("committed-evidence · the bytes VERIFIED are the bytes the prefix gate JUDGED", () => {
  // `verifyAppendOnlyPrefix` read the log to judge it and the caller then read the
  // file AGAIN, so `committedBytes` and the append-only verdict described read #1
  // while everything verified and folded described read #2. The class that slips
  // through that gap is the one this predicate uniquely catches — a committed
  // MIDDLE-RECORD DELETION, invisible to signatures by construction and invisible
  // to the chain while the current generation is empty.
  //
  // Pinned STRUCTURALLY: the predicate must hand back what it read, on BOTH its
  // ok and its breach shapes, because a caller holding only one of them re-reads
  // on the other. A behavioural race pole would need a write landing inside a
  // millisecond window, which is not a test — it is a flake.
  const dir = mkRepo({ events: evtLog({ gen0: true }, { gen0: true }) });
  const okShape = signedLog.verifyAppendOnlyPrefix({ repo: dir, rel: EVENTS_REL });
  if (!okShape.ok) return `the fixture tree did not satisfy the prefix predicate: ${okShape.reason}`;
  if (!Buffer.isBuffer(okShape.current)) return "the ok shape does not return the bytes it judged — the caller must re-read";
  if (okShape.current.length !== okShape.currentBytes) {
    return `the returned bytes (${okShape.current.length}) are not the bytes measured (${okShape.currentBytes})`;
  }
  const onDisk = fs.readFileSync(path.join(dir, EVENTS_REL));
  if (!onDisk.equals(okShape.current)) return "the returned bytes are not the file's bytes";

  // The BREACH shape too: delete a committed record and confirm the refusal still
  // carries what it read. Without this, a caller that ignores the verdict — or a
  // mutation that exempts it — falls back to a second read, which is the seam.
  const lines = fs.readFileSync(path.join(dir, EVENTS_REL), "utf8").split("\n").filter((l) => l.trim());
  fs.writeFileSync(path.join(dir, EVENTS_REL), `${lines.slice(1).join("\n")}\n`);
  const breach = signedLog.verifyAppendOnlyPrefix({ repo: dir, rel: EVENTS_REL });
  if (breach.ok !== false) return "the deletion was not detected, so this pole measures nothing";
  if (!Buffer.isBuffer(breach.current)) return "the BREACH shape drops the bytes it read — a caller ignoring the verdict re-reads";
  return true;
});

check("identity-bind · a value equality can NEVER satisfy is a roster defect, not a forgery", () => {
  // Both floors were sized for a SUBSTRING bind ("16 is gpg's own short-key-id
  // width"). Under FIELD EQUALITY that sizing accuses the innocent: any value of
  // length 16..39 — a gpg LONG KEY ID being the canonical case, and an ordinary
  // thing to paste into a roster — clears the floor and can never equal a 40-hex
  // field, so it fell through to the mismatch branch and the operator was told
  // the record "was altered after signing, or never signed by the emitter it
  // names". Fails closed either way; what changes is who gets accused.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bd-shortfpr-"));
  tmpDirs.push(home);
  const GOOD = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
  const shim = [
    "#!/bin/sh",
    'home=""; prev=""',
    'for a in "$@"; do if [ "$prev" = "--homedir" ]; then home="$a"; fi; prev="$a"; done',
    'case " $* " in *" --import "*) mkdir -p "$home"; printf KBX > "$home/pubring.kbx"; exit 0;; esac',
    `echo "[GNUPG:] VALIDSIG ${GOOD} 2026-08-24 1787000000 0 4 0 1 8 00 ${GOOD}"`,
    "exit 0",
    "",
  ].join("\n");
  const run = (expectedFpr) =>
    withGpgShim(shim, () =>
      cocSign.verify(Buffer.from("payload"), "sig", "pub", { keyType: "gpg", gpgHome: home, expectedFpr }),
    );
  // A 16-char gpg LONG KEY ID: clears the length floor, can never equal a field.
  const longKeyId = run("ABCDEF0123456789");
  if (longKeyId.valid === true) return "a long key id satisfied a field-equality bind — impossible, so the bind is not comparing fields";
  if (longKeyId.indeterminate !== true) {
    return `a roster-configuration defect was reported as a FORGERY: ${JSON.stringify(longKeyId)}`;
  }
  // A full 40-hex fingerprint must still reach the bind and verify — otherwise
  // the shape check has swallowed the honest case too.
  const full = run(GOOD);
  if (full.valid !== true) return `an HONEST full fingerprint no longer verifies: ${JSON.stringify(full)}`;
  return true;
});

check("identity-bind · the issuer-absent verdict requires an ASSERTED trust set, and a vanished keyring withdraws it", () => {
  // F4 + the homedir-existence assert. "An issuer absent from this keyring is a
  // forgery" rests on a PRECONDITION — that the keyring IS the trust set. Two
  // things falsify it, and both invert the verdict against an innocent operator.
  const shim = '#!/bin/sh\nfor a in "$@"; do case "$a" in --import) exit 0;; esac; done\necho "[GNUPG:] NO_PUBKEY DEADBEEF"\nexit 2\n';
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bd-trustset-"));
  tmpDirs.push(home);
  const FPR = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";

  // (1) THE CALLER NEVER CLAIMED IT. A supplied path is a fact about an argument,
  // not about its contents — a NARROW homedir would otherwise have every other
  // signer reported as forged.
  const unclaimed = withGpgShim(shim, () =>
    cocSign.verify(Buffer.from("p"), "sig", "pub", { keyType: "gpg", gpgHome: home, expectedFpr: FPR }),
  );
  if (unclaimed.valid !== false) return "fail-open: an absent issuer read as valid";
  if (unclaimed.indeterminate !== true) {
    return `an UNASSERTED keyring produced a forgery verdict — the precondition was inferred, not required: ${JSON.stringify(unclaimed)}`;
  }

  // (2) THE KEYRING IS NO LONGER WHAT WE BUILT. Claiming the trust set is not
  // enough when this process never recorded building that homedir: a shared
  // homedir under os.tmpdir() removed mid-fold is recreated EMPTY by gpg, and
  // one filesystem event would otherwise accuse an entire log.
  const claimedButUnrecorded = withGpgShim(shim, () =>
    cocSign.verify(Buffer.from("p"), "sig", "pub", {
      keyType: "gpg",
      gpgHome: home,
      expectedFpr: FPR,
      keyringIsTrustSet: true,
    }),
  );
  if (claimedButUnrecorded.indeterminate !== true) {
    return `an unrecorded keyring was trusted on the caller's word alone: ${JSON.stringify(claimedButUnrecorded)}`;
  }
  return true;
});

check("indeterminate-taxonomy · a verifier that reached NO verdict is INDETERMINATE; only a real signature failure is `bad-signature`", () => {
  // FOUR toolchain failures used to report as `bad-signature` — telling an operator
  // to investigate a FORGERY when the fix is "repair gpg". The discrimination is
  // driven here through the injectable `verify`, because the four differ only in
  // what the SUBPROCESS returned and the CLI surface cannot isolate them.
  const cases = [
    ["gpg exit 0 with no VALIDSIG", { ok: true, valid: false, indeterminate: true, reason: "gpg --verify exited 0 but emitted no VALIDSIG status" }, "verification-unavailable", true],
    ["a mid-batch non-zero exit with no BADSIG", { ok: true, valid: false, indeterminate: true, reason: "gpg --verify exit 2 with no BADSIG/NODATA status line" }, "verification-unavailable", true],
    ["a mid-batch ENOENT", { ok: true, valid: false, indeterminate: true, reason: "gpg --verify did not run: ENOENT" }, "verification-unavailable", true],
    ["a verify-error return", { ok: false, error: "verify failed", reason: "unsupported keyType" }, "verification-unavailable", true],
    // The pole that keeps the taxonomy from collapsing the other way: a GENUINE
    // signature failure must STILL be `bad-signature`, or the fix would have turned
    // every forgery into "go and repair gpg".
    ["a genuine signature failure", { ok: true, valid: false, reason: "gpg --verify exit 1: BAD signature" }, "bad-signature", false],
    // An identity-bind MISMATCH is a true statement ABOUT THE RECORD — signed by a
    // key that is not the one it names — so it stays a positive finding.
    ["an identity-bind mismatch", { ok: true, valid: false, reason: "signature verified against a DIFFERENT key than expected" }, "bad-signature", false],
  ];
  for (const [label, verdict, expectKind, expectIndeterminate] of cases) {
    const r = signedLog.verifyLogSignatures(evtLine(), fixturePolicy(), {
      resolveKey: RESOLVES_TO_SIGNER,
      verify: () => verdict,
    });
    if (r.ok === true) return `${label} produced a CLEAN verification`;
    const kinds = (r.findings || []).map((f) => f.kind);
    if (!kinds.includes(expectKind)) return `${label} → ${JSON.stringify(kinds)}, expected kind '${expectKind}'`;
    if (r.indeterminate !== expectIndeterminate) {
      return `${label} → indeterminate=${r.indeterminate}, expected ${expectIndeterminate}`;
    }
  }
  return true;
});

// ═══════════════════════════════════════════════════════════════════════════
// ARM — EVERY gpg SPAWN IS BOUNDED, AND A HUNG gpg IS INDETERMINATE
// ═══════════════════════════════════════════════════════════════════════════
//
// `coord-background.js::teardownGpgHomedir` already bounds its `gpgconf --kill` and
// records why: "an unbounded one hangs here forever and the rmSync never executes."
// Every `gpg` spawn in `coc-sign.js` was unbounded — the same defect one layer up,
// where a wedged gpg hangs the READ GATE itself, and a gate that never returns is
// indistinguishable from a gate that was switched off.
//
// Driven through a SHIM on PATH rather than a real gpg, because the behaviours under
// test (exit 0 with no VALIDSIG, a hang) are ones a healthy gpg will not produce.

// A full-length fingerprint for the shim arms. Sub-floor literals are refused by
// the shared callee's identity-bind floor BEFORE any shim runs, which would make
// these arms measure the floor instead of the branch each was written for.
const FULL_FPR = "DEADBEEF0123456789ABCDEF0123456789ABCDEF";

function withGpgShim(body, run) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bd-gpgshim-"));
  tmpDirs.push(d);
  const shim = path.join(d, "gpg");
  fs.writeFileSync(shim, body, { mode: 0o755 });
  const prevPath = process.env.PATH;
  process.env.PATH = `${d}${path.delimiter}${prevPath}`;
  try {
    return run(d);
  } finally {
    process.env.PATH = prevPath;
  }
}

check("gpg-spawn · exit 0 with NO VALIDSIG is INDETERMINATE, not a bad signature", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bd-gpghome-"));
  tmpDirs.push(home);
  return withGpgShim("#!/bin/sh\nexit 0\n", () => {
    const r = cocSign.verify(Buffer.from("payload"), "sig", "pub", {
      keyType: "gpg",
      gpgHome: home,
      expectedFpr: FULL_FPR,
    });
    if (r.valid === true) return "a gpg that emitted no VALIDSIG was read as a VALID signature — fail-open";
    if (r.indeterminate !== true) return `exit 0 with no VALIDSIG was classified as a signature verdict: ${JSON.stringify(r)}`;
    return true;
  });
});

check("gpg-spawn · a non-zero exit carrying BADSIG stays a SIGNATURE failure, and one without it is INDETERMINATE", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bd-gpghome2-"));
  tmpDirs.push(home);
  // BADSIG on the status channel: gpg reached a verdict about the signature.
  const withBadsig = withGpgShim('#!/bin/sh\necho "[GNUPG:] BADSIG DEADBEEF fixture"\nexit 1\n', () =>
    cocSign.verify(Buffer.from("payload"), "sig", "pub", { keyType: "gpg", gpgHome: home, expectedFpr: FULL_FPR }),
  );
  if (withBadsig.valid !== false) return `a BADSIG result was not a failure: ${JSON.stringify(withBadsig)}`;
  if (withBadsig.indeterminate === true) return "a GENUINE bad signature was mislabelled INDETERMINATE — the taxonomy collapsed the other way";
  // Exit 2 with no status line at all: gpg failed, it did not judge.
  const withoutBadsig = withGpgShim('#!/bin/sh\necho "gpg: keyblock resource unusable" 1>&2\nexit 2\n', () =>
    cocSign.verify(Buffer.from("payload"), "sig", "pub", { keyType: "gpg", gpgHome: home, expectedFpr: FULL_FPR }),
  );
  if (withoutBadsig.valid !== false) return "a failed gpg was read as a valid signature — fail-open";
  if (withoutBadsig.indeterminate !== true) return `an operational gpg failure was reported as a FORGERY: ${JSON.stringify(withoutBadsig)}`;
  return true;
});

// A gpg shim that BUILDS A KEYRING FILE on `--import`, so the trust-set
// bookkeeping (`createVerifyHomedir` records the ring; the verify path re-stats
// it) is exercised for real rather than short-circuited. Without the file,
// `_keyringIsStillTheTrustSet` refuses on "no ring recorded" and every pole below
// would come back INDETERMINATE for a reason unrelated to the branch under test.
const ISSUER_ABSENT_SHIM = [
  "#!/bin/sh",
  'home=""; prev=""',
  'for a in "$@"; do if [ "$prev" = "--homedir" ]; then home="$a"; fi; prev="$a"; done',
  'case " $* " in *" --import "*) mkdir -p "$home"; printf KBXFIXTUREKEYRING > "$home/pubring.kbx"; exit 0;; esac',
  'echo "[GNUPG:] NEWSIG"',
  'echo "[GNUPG:] ERRSIG DEADBEEF 1 8 00 0 9"',
  'echo "[GNUPG:] NO_PUBKEY DEADBEEF"',
  "exit 2",
  "",
].join("\n");

check("gpg-spawn · an ABSENT ISSUER is a FORGERY on an ASSERTED roster-built keyring, and INDETERMINATE otherwise", () => {
  // The discrimination `_gpgNonZeroIsRecordVerdict` makes, at every pole that can
  // move it. MEASURED gpg emits `NEWSIG / ERRSIG / NO_PUBKEY / FAILURE` and exit 2
  // when the signing key is absent from the keyring — no BADSIG anywhere, which is
  // why an exit-code-only or BADSIG-only reading mislabels it.
  return withGpgShim(ISSUER_ABSENT_SHIM, () => {
    // POLE 1 — a keyring THIS PROCESS BUILT from a declared key set, and which the
    // caller ASSERTS is the trust set. That is what the batch read gate does, and
    // only there is an absent issuer a fact about the RECORD.
    const built = cocSign.createVerifyHomedir([
      "-----BEGIN PGP PUBLIC KEY BLOCK-----\nfixture\n-----END PGP PUBLIC KEY BLOCK-----\n",
    ]);
    if (!built.ok) return `the fixture could not build a shared homedir: ${built.reason}`;
    tmpDirs.push(built.home);
    const opts = { keyType: "gpg", gpgHome: built.home, expectedFpr: FULL_FPR, keyringIsTrustSet: true };
    const supplied = cocSign.verify(Buffer.from("payload"), "sig", "pub", opts);
    if (supplied.valid !== false) return `an absent issuer was read as a VALID signature — fail-open: ${JSON.stringify(supplied)}`;
    if (supplied.indeterminate === true) {
      return `an impersonation on an asserted roster-built keyring was reported as an OUTAGE: ${JSON.stringify(supplied)}`;
    }

    // POLE 2 — THE CALLER DID NOT ASSERT IT. A supplied path is a fact about an
    // argument, not about its contents; a caller passing a NARROW homedir would
    // otherwise have every other signer reported as forged.
    const unasserted = cocSign.verify(Buffer.from("payload"), "sig", "pub", {
      keyType: "gpg",
      gpgHome: built.home,
      expectedFpr: FULL_FPR,
    });
    if (unasserted.indeterminate !== true) {
      return `an UNASSERTED keyring produced a forgery verdict — the precondition was inferred: ${JSON.stringify(unasserted)}`;
    }

    // POLE 3 — THE KEYRING VANISHED. Same homedir, same assertion, ring file gone.
    // A shared homedir under os.tmpdir() removed mid-fold is recreated EMPTY by
    // gpg, and one filesystem event would otherwise turn an entire log into an
    // accusation. The verdict must WITHDRAW — this is what proves the assert is
    // live rather than a comment.
    fs.rmSync(path.join(built.home, "pubring.kbx"), { force: true });
    const vanished = cocSign.verify(Buffer.from("payload"), "sig", "pub", opts);
    if (vanished.indeterminate !== true) {
      return `a DESTROYED keyring still produced a forgery verdict — one rm would accuse a whole log: ${JSON.stringify(vanished)}`;
    }

    // POLE 4 — PER-CALL keyring, which this library imports from the ONE key it
    // was handed. An absent issuer there means the import did not take: a verifier
    // fact, never a record fact.
    const perCall = cocSign.verify(Buffer.from("payload"), "sig", "pub", { keyType: "gpg", expectedFpr: FULL_FPR });
    if (perCall.valid !== false) return `an absent issuer was read as VALID on the per-call path: ${JSON.stringify(perCall)}`;
    if (perCall.indeterminate !== true) {
      return `a per-call import failure was reported as a FORGERY — the opposite misdiagnosis: ${JSON.stringify(perCall)}`;
    }
    return true;
  });
});

check("gpg-spawn · a HUNG gpg is KILLED at the bound and returns INDETERMINATE rather than hanging the gate", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bd-gpghome3-"));
  tmpDirs.push(home);
  const bound = cocSign.SPAWN_TIMEOUT_MS;
  if (typeof bound !== "number" || bound <= 0) return `coc-sign declares no SPAWN_TIMEOUT_MS (got ${JSON.stringify(bound)})`;
  // Sleeps for TWICE the bound. Without the bound this call blocks for the full
  // sleep, so the assertion below reds on ELAPSED TIME rather than hanging the suite
  // — a bounded RED, which is what makes this runnable as a regression test at all.
  const sleepSeconds = Math.ceil((bound * 2) / 1000);
  return withGpgShim(`#!/bin/sh\nsleep ${sleepSeconds}\nexit 0\n`, () => {
    const t0 = Date.now();
    const r = cocSign.verify(Buffer.from("payload"), "sig", "pub", {
      keyType: "gpg",
      gpgHome: home,
      expectedFpr: FULL_FPR,
    });
    const elapsed = Date.now() - t0;
    if (elapsed >= sleepSeconds * 1000) {
      return `the call waited ${elapsed} ms for a ${sleepSeconds}s gpg — the spawn is UNBOUNDED`;
    }
    if (elapsed < bound * 0.5) return `the call returned in ${elapsed} ms, before the ${bound} ms bound — it did not reach the spawn`;
    if (r.valid === true) return "a killed gpg was read as a VALID signature — fail-open";
    if (r.indeterminate !== true) return `a timed-out gpg was reported as a signature failure: ${JSON.stringify(r)}`;
    return true;
  });
});

for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });

console.log("");
console.log(`burndown-log-verification fixtures: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failing: ${failures.join(", ")}`);
  process.exit(1);
}
