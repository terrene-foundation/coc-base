#!/usr/bin/env node
/**
 * burndown-suite-prefix — fixtures for the WORK LEDGER ENVELOPE: the signature-suite
 * declaration (D1) and the append-only prefix predicate (D2/D3), both in
 * `hooks/lib/signed-log.js`.
 *
 * ── WHY A NEW RUNNER RATHER THAN AN EXTENSION ────────────────────────────────
 *
 * The envelope landed with ~640 lines of library and ZERO fixtures — its own author
 * recorded that `verifyAppendOnlyPrefix` and `verifyChain` "have been executed only
 * insofar as the module loads" and asked that they be treated as UNTESTED. The three
 * sibling runners that touch this area (`burndown-events`, `burndown-log-verification`,
 * `forest-ledger-projection`) each carry a `min_cases` floor a separate lane has
 * already raised, and growing them to absorb a new subject is how a floor becomes a
 * number nobody can reconcile. This subject gets its own registry key.
 *
 * ── BIPOLAR PER ARM, AND THE HARNESS ASSERTS THE POLES DIFFER ────────────────
 *
 * `instrument-bipolarity.md` MUST-1: every arm ships an executable pole PAIR run by
 * THIS harness, and the harness asserts the two verdicts DIFFER. A pair whose poles
 * agree is VACUOUS and FAILS here rather than passing quietly.
 *
 * MUST-2: every RED pole names a failure IDENTITY — which error, which breach kind,
 * which committed line — never a bare boolean or exit code. A suite that reads only
 * "it refused" stays green against a predicate that refuses the wrong thing.
 *
 * ── SCOPE, STATED SO A GREEN HERE IS NOT OVER-READ ───────────────────────────
 *
 * These cases are LIBRARY-LEVEL and hermetic: they call the predicates directly
 * against REAL temporary git repositories (nothing is mocked, and every prefix case
 * runs `git init` / `git commit` for real). They do NOT exercise
 * `burndown-build.mjs`. The END-TO-END statement — that the generator now permits an
 * uncommitted append and refuses a tampered committed prefix, which is defect T1 —
 * is asserted against the real binary as a subprocess in
 * `burndown-log-verification`'s `log-committed-prefix-tamper-refused-loudly` arm.
 * A green here is evidence about the PREDICATE, not about the gate that calls it.
 */
import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const sl = require(path.join(REPO_ROOT, ".claude", "hooks", "lib", "signed-log.js"));
const ev = require(path.join(REPO_ROOT, ".claude", "hooks", "lib", "burndown-events.js"));

let pass = 0;
const failures = [];
const tmpDirs = [];

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
 * Register one bipolar ARM. Both poles run and each returns a VERDICT STRING — not a
 * boolean, because two booleans can be equal for opposite reasons and the whole point
 * is that the poles are DISTINGUISHABLE. The harness then asserts, as its own case,
 * that the verdict BODIES differ with the author-supplied prefix stripped, so a pole
 * copy-pasted from its sibling reds here instead of passing.
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
  check(`${arm} · NON-VACUOUS · the two poles produce DIFFERENT verdicts`, () => {
    if (redV === null || greenV === null) return "a pole did not produce a verdict";
    const body = (v) => v.replace(/^(RED|GREEN):/, "");
    if (body(redV) === body(greenV)) {
      return `VACUOUS PAIR: the poles differ only by their prefix — both report ${JSON.stringify(body(redV))}`;
    }
    return true;
  });
}

// ── real temporary git repositories ─────────────────────────────────────────

const REL = "burndown/events.jsonl";

/** A real git repo carrying `lines` COMMITTED at `REL`. Nothing here is mocked. */
function mkLogRepo(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "burndown"), { recursive: true });
  fs.writeFileSync(path.join(dir, REL), `${lines.join("\n")}\n`);
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
  return dir;
}

/** Overwrite the WORKING COPY of the log, leaving the committed blob alone. */
function writeWorking(dir, lines) {
  fs.writeFileSync(path.join(dir, REL), `${lines.join("\n")}\n`);
}

const rec = (n) => JSON.stringify({ id: `rec_${n}`, item_id: `I${n}`, seq: n, sig: "FIXTURE" });

/** The canonical single-suite declaration: generation 1 (`v2`) on openpgp. */
const DECL = Object.freeze({
  generation: 1,
  schema: "burndown-event/v2",
  suite: "openpgp",
  prior_generations: [{ generation: 0, schema: "burndown-event/v1", suite: "openpgp" }],
});

/**
 * An `ssh-rsa` generation, for the arms that vary the KEY rather than the keyType.
 *
 * Mirrors the canonical log's generation 2. Its schema is a CLOSED prior's here only
 * to keep this fixture self-contained: these arms drive `decideAppendSuite` directly
 * with explicit declarations and never read the repo's own manifest.
 */
const DECL_SSH_RSA = Object.freeze({
  generation: 2,
  schema: "burndown-event/v3",
  suite: "ssh-rsa",
  prior_generations: [{ generation: 0, schema: "burndown-event/v1", suite: "openpgp" }],
});

// Key MATERIAL, not keys on disk. `suiteForSigningKey` takes an injectable `readFile`
// precisely so a fixture can drive every algorithm branch without generating a keypair
// per case — and so these arms measure the RESOLVER rather than the machine's ssh
// configuration.
const ED25519_PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureKeyMaterial fixture@example.invalid\n";
const RSA_PUB = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQFixtureKeyMaterial fixture@example.invalid\n";
const KEY_ED25519 = Object.freeze({ keyType: "ssh", keyPath: "/fixture/id_ed25519.pub" });
const KEY_RSA = Object.freeze({ keyType: "ssh", keyPath: "/fixture/id_rsa.pub" });
const readingKey = (text) => ({ readFile: () => text });

function policyOrThrow(decl) {
  const p = sl.resolveSuitePolicy(decl);
  if (!p.ok) throw new Error(`the fixture's own policy did not resolve: ${p.error}: ${p.reason}`);
  return p.policy;
}

// ═══════════════════════════════════════════════════════════════════════════
// ARM 1 — the declared suite is ENFORCED, not advisory
// ═══════════════════════════════════════════════════════════════════════════
//
// Single-suite-per-generation is the D1 fix. `coc-sign::verify` reads
// `o.keyType || "ssh"`, so a record that disagrees with the declaration — or declares
// nothing — is not merely odd, it verifies under the WRONG algorithm and reports a
// total signature failure. The declaration has to be a fence, not a comment.

pair(
  "suite-mismatch-refused",
  "an event declaring a suite the generation does not accept is REFUSED, naming both suites",
  () => {
    const policy = policyOrThrow(DECL);
    const r = sl.decideAppendSuite({ schema: "burndown-event/v2", sig_alg: "ssh-ed25519" }, policy);
    if (r.ok) return `a mismatched suite was ACCEPTED as ${JSON.stringify(r.sig_alg)}`;
    if (r.error !== "suite mismatch") return `refused, but as ${JSON.stringify(r.error)}`;
    if (!/ssh-ed25519/.test(r.reason)) return "the refusal does not name the suite the event declared";
    if (!/openpgp/.test(r.reason)) return "the refusal does not name the suite the generation accepts";
    return `RED:suite-fence error=suite-mismatch declared=ssh-ed25519 accepted=openpgp`;
  },
  "an event declaring the generation's own suite is ACCEPTED and stamped with it",
  () => {
    const policy = policyOrThrow(DECL);
    const r = sl.decideAppendSuite({ schema: "burndown-event/v2", sig_alg: "openpgp" }, policy);
    if (!r.ok) return `a matching suite was refused: ${r.error}: ${r.reason}`;
    if (r.sig_alg !== "openpgp") return `stamped ${JSON.stringify(r.sig_alg)}, expected 'openpgp'`;
    if (r.keyType !== "gpg") return `resolved keyType ${JSON.stringify(r.keyType)}, expected 'gpg'`;
    return `GREEN:suite-fence accepted sig_alg=openpgp keyType=gpg schema=burndown-event/v2`;
  },
);

// A SIGNING KEY of the wrong type is the disagreement a convention can never hold:
// the operator's `git config gpg.format` changes and every caller keeps working while
// the log silently becomes mixed. Kept as its own pair because it is a DIFFERENT
// input surface from the event's own `sig_alg` above.
pair(
  "signing-key-suite-mismatch-refused",
  "a signing key whose type is not the generation's suite is REFUSED before anything is written",
  () => {
    const policy = policyOrThrow(DECL);
    const r = sl.decideAppendSuite({ schema: "burndown-event/v2" }, policy, KEY_ED25519, readingKey(ED25519_PUB));
    if (r.ok) return "an ssh key was accepted for an openpgp generation";
    if (r.error !== "signing key suite mismatch") return `refused, but as ${JSON.stringify(r.error)}`;
    if (!/declared sig_alg is a lie about its own bytes/.test(r.reason)) {
      return `refused, but not for the signing-key reason: ${r.reason.slice(0, 160)}`;
    }
    return `RED:suite-fence error=signing-key-suite-mismatch keyType=ssh accepted=openpgp`;
  },
  "a signing key of the generation's own type is ACCEPTED",
  () => {
    const policy = policyOrThrow(DECL);
    const r = sl.decideAppendSuite({ schema: "burndown-event/v2" }, policy, { keyType: "gpg" });
    if (!r.ok) return `a matching key was refused: ${r.error}: ${r.reason}`;
    return `GREEN:suite-fence accepted keyType=gpg sig_alg=${r.sig_alg}`;
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// ARM 1b — the ssh half of the fence discriminates by ALGORITHM, not keyType
// ═══════════════════════════════════════════════════════════════════════════
//
// `keyType: "ssh"` is `coc-sign`'s TOOL selector. It was also, wrongly, the granularity
// this fence ran at: `suiteForKeyType("ssh")` answered `ssh-ed25519` for every ssh key,
// so an `ssh-rsa` key signing an `ssh-ed25519` generation — a record whose `sig_alg` is
// a lie about its own bytes, the exact thing the refusal text names — was ACCEPTED.
// Both suites share one keyType, so a pair that only varied keyType could never have
// caught it; these poles vary the KEY, holding keyType fixed at "ssh".

pair(
  "ssh-suite-fence-reads-the-key-algorithm",
  "an ed25519 key is REFUSED by an ssh-rsa generation — same keyType, different suite",
  () => {
    const policy = policyOrThrow(DECL_SSH_RSA);
    const r = sl.decideAppendSuite({}, policy, KEY_ED25519, readingKey(ED25519_PUB));
    if (r.ok) return `an ssh-ed25519 key was accepted for an ssh-rsa generation as ${JSON.stringify(r.sig_alg)}`;
    if (r.error !== "signing key suite mismatch") return `refused, but as ${JSON.stringify(r.error)}: ${r.reason}`;
    if (!/ssh-ed25519/.test(r.reason)) return "the refusal does not name the key's own suite";
    if (!/ssh-rsa/.test(r.reason)) return "the refusal does not name the suite the generation accepts";
    return `RED:suite-fence error=signing-key-suite-mismatch keyType=ssh algorithm=ssh-ed25519 accepted=ssh-rsa`;
  },
  "an ssh-rsa key is ACCEPTED by that same generation and stamped ssh-rsa",
  () => {
    const policy = policyOrThrow(DECL_SSH_RSA);
    const r = sl.decideAppendSuite({}, policy, KEY_RSA, readingKey(RSA_PUB));
    if (!r.ok) return `the generation's own key was refused: ${r.error}: ${r.reason}`;
    if (r.sig_alg !== "ssh-rsa") return `accepted but stamped ${JSON.stringify(r.sig_alg)}`;
    return `GREEN:suite-fence accepted keyType=ssh algorithm=ssh-rsa sig_alg=ssh-rsa`;
  },
);

// A keyType that maps to more than one suite carries less information than the answer
// needs. There is no safe pick — either choice stamps a `sig_alg` the bytes may
// contradict — so the resolver REFUSES. This is the D1 shape restated one level down:
// the defect was a DEFAULT, and a lossy inverse of a security vocabulary is a default
// wearing the grammar of a lookup.

pair(
  "ambiguous-keytype-refuses-rather-than-picks",
  "keyType alone, with no key to read, REFUSES and names both candidate suites",
  () => {
    const policy = policyOrThrow(DECL_SSH_RSA);
    const r = sl.decideAppendSuite({}, policy, { keyType: "ssh" });
    if (r.ok) return `an unresolvable ssh key was accepted as ${JSON.stringify(r.sig_alg)}`;
    if (r.error !== "signing key unresolvable") return `refused, but as ${JSON.stringify(r.error)}: ${r.reason}`;
    if (!/never defaults/.test(r.reason)) return "the refusal does not state that absent never reads as a default";
    const k = sl.suiteForKeyType("ssh");
    if (k.ok) return `suiteForKeyType('ssh') answered ${JSON.stringify(k.suite)} instead of refusing`;
    if (!/ssh-ed25519/.test(k.reason) || !/ssh-rsa/.test(k.reason)) {
      return "the ambiguity refusal does not name both candidate suites";
    }
    return `RED:suite-fence error=signing-key-unresolvable keyType=ssh candidates=ssh-ed25519,ssh-rsa`;
  },
  "keyType 'gpg' maps to exactly one suite, so it resolves without a key to read",
  () => {
    const k = sl.suiteForKeyType("gpg");
    if (!k.ok) return `an unambiguous keyType was refused: ${k.error}: ${k.reason}`;
    if (k.suite !== "openpgp") return `resolved to ${JSON.stringify(k.suite)}`;
    return `GREEN:suite-fence keyType=gpg suite=openpgp resolved=without-key-read`;
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// ARM 2 — a v2 record with NO `sig_alg` is REFUSED, not defaulted
// ═══════════════════════════════════════════════════════════════════════════
//
// The whole point of D1: absent NEVER reads as "use the default". All 534
// generation-0 records are openpgp, so a reader that defaulted to ssh would reject
// the entire log while reporting a signature failure. Generation 0 is exempt BY
// DECLARATION — it carries no `sig_alg` and none is demanded of it — and that
// exemption is asserted here too, because a fence that refuses the committed history
// is a fence nobody can turn on.

pair(
  "v2-record-must-declare-sig_alg",
  "a generation-1 record with NO sig_alg is REFUSED, naming the schema and the ssh-default hazard",
  () => {
    const r = ev.validateRecord({
      schema: "burndown-event/v2",
      kind: "genesis",
      weight: "migration_baseline",
      item_id: "I1",
      item: "an item",
      value_anchor: "journal/0001.md#I1",
      status: "In progress",
      authority: "agent",
      source: "fixture",
      seq: 1,
      prev_hash: null,
    });
    if (r.ok) return "a v2 record with no sig_alg was ACCEPTED";
    if (r.error !== "missing sig_alg") return `refused, but as ${JSON.stringify(r.error)}: ${r.reason}`;
    if (!/burndown-event\/v2/.test(r.reason)) return "the refusal does not name the schema";
    if (!/falls back to keyType 'ssh'/.test(r.reason)) return "the refusal does not name the ssh-default hazard";
    return `RED:envelope error=missing-sig_alg schema=burndown-event/v2 generation=1`;
  },
  "a generation-0 record with no sig_alg is ACCEPTED — the closed generation is exempt BY DECLARATION",
  () => {
    const r = ev.validateRecord({
      schema: "burndown-event/v1",
      kind: "genesis",
      weight: "migration_baseline",
      item_id: "I1",
      item: "an item",
      value_anchor: "journal/0001.md#I1",
      status: "In progress",
      authority: "agent",
      source: "fixture",
    });
    if (!r.ok) return `the closed generation was refused: ${r.error}: ${r.reason}`;
    return `GREEN:envelope accepted schema=burndown-event/v1 generation=0 sig_alg=not-required`;
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// ARM 3 — the committed PREFIX is preserved: DELETION
// ═══════════════════════════════════════════════════════════════════════════
//
// This is the class per-record signature verification CANNOT see: every surviving
// record's signature still verifies perfectly after a middle record is removed. The
// GREEN pole is the untouched tree, which is also the "prefix preserved ACCEPTED"
// statement.

pair(
  "committed-record-deleted-refused",
  "a DELETED committed record is REFUSED, naming the breach as a DELETION and the committed line",
  () => {
    const dir = mkLogRepo([rec(1), rec(2), rec(3)]);
    writeWorking(dir, [rec(1), rec(3)]); // record 2 removed from the middle
    const r = sl.verifyAppendOnlyPrefix({ repo: dir, rel: REL });
    if (r.ok) return "a deleted committed record was ACCEPTED";
    if (r.error !== "append-only violation") return `refused, but as ${JSON.stringify(r.error)}`;
    if (r.breach !== "deleted") return `breach classified as ${JSON.stringify(r.breach)}, expected 'deleted'`;
    if (r.breach_line !== 2) return `named committed line ${r.breach_line}, expected 2`;
    if (!r.reason.includes(rec(2))) return "the refusal does not quote the committed line that was lost";
    return `RED:prefix error=append-only-violation breach=deleted line=2 rel=${r.rel}`;
  },
  "an UNTOUCHED committed log preserves its prefix and is ACCEPTED with zero appended bytes",
  () => {
    const dir = mkLogRepo([rec(1), rec(2), rec(3)]);
    const r = sl.verifyAppendOnlyPrefix({ repo: dir, rel: REL });
    if (!r.ok) return `an untouched log was refused: ${r.error}: ${r.reason}`;
    if (r.appendedBytes !== 0) return `reported ${r.appendedBytes} appended byte(s) on an untouched log`;
    if (r.appendedLines !== 0) return `reported ${r.appendedLines} appended line(s) on an untouched log`;
    if (r.committedBytes !== r.currentBytes) {
      return `committed ${r.committedBytes}B vs current ${r.currentBytes}B on an untouched log`;
    }
    return `GREEN:prefix preserved appended=0B/0L committed=${r.committedBytes}B`;
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// ARM 4 — the committed PREFIX is preserved: REORDERING
// ═══════════════════════════════════════════════════════════════════════════
//
// A reorder is byte-for-byte the same SET of records, so a checksum over the sorted
// contents would pass it. It is caught here because ORDER is part of the prefix.
//
// NOT the regression test for the substring bug — that is the arm BELOW, and the
// distinction is worth stating because it would be easy to claim otherwise. The
// records in this arm and in the deletion arm above are mutually non-overlapping
// strings, so the OLD `workingText.includes(lost)` discriminator would classify both
// of them correctly. Asserting the exact breach kind here is necessary but is NOT
// sufficient to pin the fix.

pair(
  "committed-record-reordered-refused",
  "a REORDERED committed record is REFUSED, naming the breach as a REORDER — not a deletion",
  () => {
    const dir = mkLogRepo([rec(1), rec(2), rec(3)]);
    writeWorking(dir, [rec(1), rec(3), rec(2)]); // same set, order swapped
    const r = sl.verifyAppendOnlyPrefix({ repo: dir, rel: REL });
    if (r.ok) return "a reordered committed prefix was ACCEPTED";
    if (r.error !== "append-only violation") return `refused, but as ${JSON.stringify(r.error)}`;
    if (r.breach !== "reordered") return `breach classified as ${JSON.stringify(r.breach)}, expected 'reordered'`;
    if (r.breach_line !== 2) return `named committed line ${r.breach_line}, expected 2`;
    return `RED:prefix error=append-only-violation breach=reordered line=2 rel=${r.rel}`;
  },
  "an IN-PLACE alteration of the same committed line is REFUSED as an ALTERATION, not a reorder",
  () => {
    // Same committed line, same ordinal, different bytes, and the lost line's text does
    // NOT survive anywhere. Distinct breach kind, so this pole discriminates the
    // classifier rather than merely re-asserting that tampering refuses.
    const dir = mkLogRepo([rec(1), rec(2), rec(3)]);
    writeWorking(dir, [rec(1), rec(9), rec(3)]);
    const r = sl.verifyAppendOnlyPrefix({ repo: dir, rel: REL });
    if (r.ok) return "an altered committed record was ACCEPTED";
    if (r.breach !== "altered") return `breach classified as ${JSON.stringify(r.breach)}, expected 'altered'`;
    return `GREEN:prefix error=append-only-violation breach=altered line=${r.breach_line} rel=${r.rel}`;
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// ARM 4b — DELETE vs REORDER is decided by LINE MEMBERSHIP, not by substring
// ═══════════════════════════════════════════════════════════════════════════
//
// THE REGRESSION TEST for the discriminator itself. `_classifyBreach` used to decide
// this with `workingText.includes(lost)` — a substring test over the WHOLE FILE, which
// answers "do these bytes appear anywhere?" rather than "is this line still present?".
// A record genuinely DELETED whose text happens to occur inside a surviving line was
// therefore reported as REORDERED: the verdict was right and the IDENTITY named the
// wrong attack, which is the half a reviewer acts on.
//
// The predicate is deliberately BYTE-level — it needs no schema and no key material,
// which is why it works on a closed generation that carries neither — so these poles
// use bare byte lines rather than JSON records. That is the property under test.
// Measured against the pre-fix classifier: the RED pole below returned "reordered".

pair(
  "delete-vs-reorder-by-line-not-substring",
  "a DELETED line whose text is a SUBSTRING of a surviving line is still classified DELETED",
  () => {
    // "bb" survives INSIDE "bbccc", so a whole-file substring test says "reordered".
    const dir = mkLogRepo(["aaa", "bb", "bbccc", "ddd"]);
    writeWorking(dir, ["aaa", "bbccc", "ddd"]);
    const r = sl.verifyAppendOnlyPrefix({ repo: dir, rel: REL });
    if (r.ok) return "a deleted line was ACCEPTED";
    if (r.breach !== "deleted") {
      return `breach classified as ${JSON.stringify(r.breach)}, expected 'deleted' — the discriminator is ` +
        `matching on SUBSTRING again, so a deletion is being reported as the wrong attack`;
    }
    if (r.breach_line !== 2) return `named committed line ${r.breach_line}, expected 2`;
    return `RED:prefix error=append-only-violation breach=deleted line=2 lost-text-survives-inside=bbccc`;
  },
  "the SAME line genuinely MOVED is classified REORDERED — the two are told apart on one tree shape",
  () => {
    const dir = mkLogRepo(["aaa", "bb", "bbccc", "ddd"]);
    writeWorking(dir, ["aaa", "bbccc", "bb", "ddd"]);
    const r = sl.verifyAppendOnlyPrefix({ repo: dir, rel: REL });
    if (r.ok) return "a reordered prefix was ACCEPTED";
    if (r.breach !== "reordered") return `breach classified as ${JSON.stringify(r.breach)}, expected 'reordered'`;
    if (r.breach_line !== 2) return `named committed line ${r.breach_line}, expected 2`;
    return `GREEN:prefix error=append-only-violation breach=reordered line=2 lost-line-survives-whole=bb`;
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// ARM 5 — UNCOMMITTED APPENDS BEYOND THE PREFIX ARE PERMITTED (T1)
// ═══════════════════════════════════════════════════════════════════════════
//
// THE T1 REGRESSION TEST. `assertCommittedAndUnmodified` asked "is the working tree
// byte-identical to HEAD?", which is right for a snapshot table and wrong for an
// append-only log: it took the gate UNRUNNABLE from the producer's first append.
// An operator who meets exit 2 on every append switches the gate off, which is worse
// than either answer. The predicate must PERMIT the append and still refuse tampering
// — that combination is the whole fix, so both halves are asserted here.

pair(
  "uncommitted-appends-permitted",
  "a TRUNCATED log is still REFUSED — permitting appends does not permit shrinking",
  () => {
    const dir = mkLogRepo([rec(1), rec(2), rec(3)]);
    writeWorking(dir, [rec(1), rec(2)]); // the tail is gone
    const r = sl.verifyAppendOnlyPrefix({ repo: dir, rel: REL });
    if (r.ok) return "a truncated log was ACCEPTED";
    if (r.breach !== "truncated") return `breach classified as ${JSON.stringify(r.breach)}, expected 'truncated'`;
    if (r.currentBytes >= r.committedBytes) {
      return `reported current ${r.currentBytes}B >= committed ${r.committedBytes}B on a truncation`;
    }
    return `RED:prefix error=append-only-violation breach=truncated line=${r.breach_line} rel=${r.rel}`;
  },
  "UNCOMMITTED appends beyond the committed prefix are PERMITTED, and are counted",
  () => {
    const dir = mkLogRepo([rec(1), rec(2)]);
    // Appended and DELIBERATELY NOT COMMITTED. Under the old predicate this was the
    // refusal that made the gate unrunnable during the work it exists to observe.
    fs.appendFileSync(path.join(dir, REL), `${rec(3)}\n${rec(4)}\n`);
    const dirty = execFileSync("git", ["status", "--porcelain", "--", REL], { cwd: dir, encoding: "utf8" });
    if (!dirty.trim()) return "the fixture's own precondition failed: the append left the tree CLEAN";
    const r = sl.verifyAppendOnlyPrefix({ repo: dir, rel: REL });
    if (!r.ok) return `an uncommitted append was refused — T1 has regressed: ${r.error}: ${r.reason}`;
    if (r.appendedLines !== 2) return `counted ${r.appendedLines} appended line(s), expected 2`;
    if (r.currentBytes <= r.committedBytes) return "the append did not grow the file";
    return `GREEN:prefix uncommitted-append=permitted appended=${r.appendedBytes}B/${r.appendedLines}L`;
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// ARM 6 — a log git has NEVER SEEN refuses rather than vacuously passing
// ═══════════════════════════════════════════════════════════════════════════
//
// The non-discriminating-instrument case, closed inside the predicate itself: with no
// committed content there is no prefix to preserve, so an `ok` here could not tell
// "append-only, verified" from "this file is not the committed log at all".

pair(
  "no-committed-prefix-refused",
  "an UNTRACKED log is REFUSED — no committed content is no provenance, not a pass",
  () => {
    const dir = mkLogRepo([rec(1)]);
    const other = "burndown/not-committed.jsonl";
    fs.writeFileSync(path.join(dir, other), `${rec(1)}\n`);
    const r = sl.verifyAppendOnlyPrefix({ repo: dir, rel: other });
    if (r.ok) return "a log git has never seen was ACCEPTED";
    if (r.error !== "no committed prefix") return `refused, but as ${JSON.stringify(r.error)}: ${r.reason}`;
    if (!r.reason.includes(other)) return "the refusal does not name the path";
    return `RED:prefix error=no-committed-prefix rel=${other}`;
  },
  "the COMMITTED log at the same repo is accepted — the refusal is about provenance, not the repo",
  () => {
    const dir = mkLogRepo([rec(1)]);
    fs.writeFileSync(path.join(dir, "burndown/not-committed.jsonl"), `${rec(1)}\n`);
    const r = sl.verifyAppendOnlyPrefix({ repo: dir, rel: REL });
    if (!r.ok) return `the committed log was refused: ${r.error}: ${r.reason}`;
    if (!r.blob) return "the accepted result names no committed blob";
    return `GREEN:prefix accepted rel=${REL} blob=${r.blob.slice(0, 12)} committed=${r.committedBytes}B`;
  },
);

// ── summary ─────────────────────────────────────────────────────────────────

for (const d of tmpDirs) {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch {
    /* a leftover temp dir is not a fixture result */
  }
}

console.log(`\nburndown-suite-prefix fixtures: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failing: ${failures.join(", ")}`);
  process.exit(1);
}
