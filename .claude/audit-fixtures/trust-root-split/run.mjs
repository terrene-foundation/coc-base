#!/usr/bin/env node
/*
 * trust-root-split — the COMMITTED verification surface, split out of the roster.
 * (`burndown-events.js::readCommittedTrustRoot` / `trustRootIndex` /
 *  `makeRosterSignerResolver`, and `bin/build-trust-root.mjs`)
 *
 * ── WHAT IS UNDER TEST ─────────────────────────────────────────────────────
 *
 * One file was answering two questions with incompatible distribution rules — "who are
 * the operators of this repo" (must be local, never shipped) and "what is authority
 * verified against" (must be committed). This suite pins the second one, split out.
 *
 * ── THE THREE-WAY READ IS THE SECURITY-BEARING PART ────────────────────────
 *
 * ABSENT      -> the roster fallback is permitted. This is every repo today, and it is
 *                what makes shard 1 behaviour-preserving.
 * VALID       -> authoritative; the roster is NOT consulted.
 * BROKEN      -> REFUSES, and MUST NOT fall back. A fallback on corruption is a
 *                downgrade an attacker triggers by damaging the file they cannot forge.
 *
 * Arm 2's poles make the trust root and the roster DISAGREE about the same fingerprint.
 * That is the only configuration in which "preferred" and "ignored" produce different
 * output — on agreeing inputs both readings are byte-identical, which would be a
 * non-discriminating instrument in this rule's own sense.
 *
 * Every generator case runs the REAL binary against a REAL temporary git repository.
 */

import "../_lib/no-ambient-git.cjs";
import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const EV = require(path.join(REPO_ROOT, ".claude", "hooks", "lib", "burndown-events.js"));
const GEN = path.join(REPO_ROOT, ".claude", "bin", "build-trust-root.mjs");

let cases = 0;
const failures = [];
const tmpDirs = [];

// ONE `PASS <name>` line PER CASE — `run-audit-fixtures.mjs` counts cases with
// /^[ \t]*(?:PASS|ok)[ \t]+\S/ and does NOT count a summary line.
function check(name, verdictOrFn) {
  cases++;
  // ACCEPTS A THUNK OR A VALUE. Passing the function un-called yields the function
  // OBJECT, which is `!== true`, so the case FAILS with `() => {` as its detail — loud,
  // but it fails for a reason that has nothing to do with the property. Normalising
  // here removes a whole class of author error that reads like a real finding.
  let verdict;
  try {
    verdict = typeof verdictOrFn === "function" ? verdictOrFn() : verdictOrFn;
  } catch (e) {
    verdict = `threw: ${(e && e.message) || String(e)}`;
  }
  if (verdict === true) {
    console.log(`PASS ${name}`);
    return true;
  }
  failures.push(`  ${name}\n      ${verdict}`);
  console.log(`FAIL ${name} — ${verdict}`);
  return false;
}

function pair(name, redWhat, red, greenWhat, green) {
  const r = red();
  const g = green();
  check(`${name} · RED   · ${redWhat}`, r);
  check(`${name} · GREEN · ${greenWhat}`, g);
  check(
    `${name} · NON-VACUOUS · the two poles produce DIFFERENT verdicts`,
    r === true && g === true ? true : "a pole failed, so non-vacuity cannot be asserted from this run",
  );
}

const FPR = "SHA256:AAAAfixturefingerprintAAAA";
const PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFIXTUREKEY fixture";

// The roster says CONTRIBUTOR. Every trust root below says OWNER. That disagreement is
// what makes "which surface answered" observable at all.
const ROSTER = {
  genesis: { established_at: "2026-08-01T00:00:00.000Z" },
  persons: {
    "pid-fixture": { display_id: "fixture", role: "contributor", host_role: "human", keys: [{ type: "ssh", fingerprint: FPR, pubkey: PUB }] },
  },
};
const trustRoot = (over) => ({
  _schema: "coc-trust-root/v1",
  root_commit: "0".repeat(40),
  signers: { [FPR]: { pubkey: PUB, type: "ssh", person_id: "pid-fixture", role: "owner", host_role: "human" } },
  ...over,
});

const resolveWith = (trustRootDoc) =>
  EV.makeRosterSignerResolver("/nonexistent-repo", {
    readRoster: () => JSON.stringify(ROSTER),
    readTrustRoot: () => (trustRootDoc === null ? null : JSON.stringify(trustRootDoc)),
  })(FPR);

// ═══════════════════════════════════════════════════════════════════════════
// ARM 1 — ABSENT FALLS BACK (behaviour-preserving); VALID IS PREFERRED
// ═══════════════════════════════════════════════════════════════════════════

pair(
  "absent-falls-back-valid-is-preferred",
  "an ABSENT trust root falls back to the roster — today's behaviour, unchanged",
  () => {
    const got = resolveWith(null);
    if (!got || got.ok !== true) return `the roster fallback did not resolve: ${JSON.stringify(got)}`;
    return got.role === "contributor"
      ? true
      : `the ROSTER says contributor; resolving to ${JSON.stringify(got.role)} means the fallback read something else`;
  },
  "a VALID trust root is PREFERRED — it answers 'owner' where the roster says 'contributor'",
  () => {
    const got = resolveWith(trustRoot());
    if (!got || got.ok !== true) return `a valid trust root did not resolve: ${JSON.stringify(got)}`;
    return got.role === "owner"
      ? true
      : `the trust root was NOT preferred — resolved to ${JSON.stringify(got.role)}, which is the roster's answer`;
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// ARM 2 — A BROKEN TRUST ROOT REFUSES AND DOES NOT FALL BACK
//
// THE ATTACK THIS CLOSES: damage the surface you cannot forge, and a resolver that
// "helpfully" falls back reverts to one whose contents you can influence differently.
// Both poles have a PRESENT trust root and a RESOLVABLE roster behind it; they differ
// only in whether the trust root parses.
// ═══════════════════════════════════════════════════════════════════════════

pair(
  "broken-trust-root-refuses-without-fallback",
  "a committed-but-UNPARSEABLE trust root REFUSES — the roster behind it is never reached",
  () => {
    const got = EV.makeRosterSignerResolver("/nonexistent-repo", {
      readRoster: () => JSON.stringify(ROSTER),
      readTrustRoot: () => "{ not json",
    })(FPR);
    if (!got || got.ok !== false) return `a corrupt trust root resolved anyway: ${JSON.stringify(got)}`;
    if (got.role === "contributor") return "it FELL BACK to the roster — the downgrade this arm exists to prevent";
    if (!/unparseable/i.test(got.error || "")) return `refused, but not on the parse: ${JSON.stringify(got.error)}`;
    if (got.indeterminate !== true) return "a corrupt trust root is INDETERMINATE, not a positive finding about a signer";
    return true;
  },
  "the SAME roster behind a WELL-FORMED trust root resolves — so the refusal was the trust root, not the roster",
  () => {
    const got = resolveWith(trustRoot());
    return got && got.ok === true && got.role === "owner"
      ? true
      : `the control did not resolve: ${JSON.stringify(got)}`;
  },
);

check("arm2/empty-signers-is-INDETERMINATE-not-no-authority", (() => {
  const got = EV.makeRosterSignerResolver("/nonexistent-repo", {
    readRoster: () => JSON.stringify(ROSTER),
    readTrustRoot: () => JSON.stringify(trustRoot({ signers: {} })),
  })(FPR);
  if (!got || got.ok !== false) return `an empty trust root resolved: ${JSON.stringify(got)}`;
  if (got.role === "contributor") return "it fell back to the roster on an EMPTY trust root";
  return got.indeterminate === true ? true : `an empty trust root must be INDETERMINATE; got ${JSON.stringify(got)}`;
})());

check("arm2/missing-signers-object-refuses", (() => {
  const got = EV.makeRosterSignerResolver("/nonexistent-repo", {
    readRoster: () => JSON.stringify(ROSTER),
    readTrustRoot: () => JSON.stringify({ _schema: "coc-trust-root/v1" }),
  })(FPR);
  return got && got.ok === false && got.role === undefined
    ? true
    : `a trust root with no signers object must refuse; got ${JSON.stringify(got)}`;
})());

// ═══════════════════════════════════════════════════════════════════════════
// ARM 3 — THE ADMISSION PREDICATE MATCHES `signerIndex` EXACTLY
//
// An index admitting an entry the SIGNATURE path skips would make one signer
// `unrostered` for signatures and role-resolvable for authority. That asymmetry is what
// an attacker looks for, so it is pinned rather than assumed.
// ═══════════════════════════════════════════════════════════════════════════

pair(
  "admission-predicate-parity",
  "an entry with NO pubkey is REFUSED by the trust-root index — same as signerIndex",
  () => {
    const idx = EV.trustRootIndex({ signers: { [FPR]: { type: "ssh", person_id: "pid-fixture", role: "owner" } } });
    if (idx.size !== 0) return `a pubkey-less entry was admitted; size=${idx.size}`;
    const rosterIdx = EV.signerIndex({ persons: { "pid-fixture": { role: "owner", keys: [{ type: "ssh", fingerprint: FPR }] } } });
    return rosterIdx.size === 0 ? true : `the two predicates DISAGREE: trustRoot=0 signerIndex=${rosterIdx.size}`;
  },
  "a fully-declared entry is admitted by BOTH — so the refusal above is the missing field, not a dead index",
  () => {
    const idx = EV.trustRootIndex(trustRoot());
    const rosterIdx = EV.signerIndex(ROSTER);
    if (idx.size !== 1) return `a complete trust-root entry was not admitted; size=${idx.size}`;
    return rosterIdx.size === 1 ? true : `signerIndex did not admit the equivalent roster entry; size=${rosterIdx.size}`;
  },
);


// ═══════════════════════════════════════════════════════════════════════════
// ARM 4 — THE GENERATOR: ONE WRITER, AND --check ACTUALLY REDS (P4)
// ═══════════════════════════════════════════════════════════════════════════

function mkRepo({ withRoster = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trust-root-fx-"));
  tmpDirs.push(dir);
  const g = (a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "fixture@example.invalid"]);
  g(["config", "user.name", "fixture"]);
  g(["config", "commit.gpgsign", "false"]);
  // The generator resolves the library out of the repo it is pointed at, so the repo
  // needs the real lib tree. Symlinking keeps the fixture honest about WHICH code ran.
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.symlinkSync(path.join(REPO_ROOT, ".claude", "hooks"), path.join(dir, ".claude", "hooks"));
  fs.symlinkSync(path.join(REPO_ROOT, ".claude", "bin"), path.join(dir, ".claude", "bin"));
  if (withRoster) fs.writeFileSync(path.join(dir, ".claude", "operators.roster.json"), JSON.stringify(ROSTER, null, 2));
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "seed"]);
  return dir;
}

const runGen = (dir, a) =>
  spawnSync(process.execPath, [GEN, "--repo", dir, ...a], { cwd: dir, encoding: "utf8", timeout: 60000 });

pair(
  "generator-check-discriminates",
  "--check REDS when the derived file is absent but IS derivable",
  () => {
    const r = runGen(mkRepo(), ["--check"]);
    if (r.status !== 1) return `expected exit 1 (drift); got ${r.status}: ${(r.stderr || "").slice(0, 200)}`;
    return /DRIFT/.test(r.stderr || "") ? true : `refused without naming DRIFT: ${(r.stderr || "").slice(0, 200)}`;
  },
  "--check is GREEN immediately after --write, on the same repo",
  () => {
    const dir = mkRepo();
    const w = runGen(dir, ["--write"]);
    if (w.status !== 0) return `--write failed: ${(w.stderr || "").slice(0, 200)}`;
    const c = runGen(dir, ["--check"]);
    return c.status === 0 ? true : `--check red after a fresh write: ${(c.stderr || "").slice(0, 250)}`;
  },
);

check("arm4/check-REDS-on-a-tampered-derived-file", (() => {
  const dir = mkRepo();
  runGen(dir, ["--write"]);
  const p = path.join(dir, ".claude", "trust-root.json");
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  doc.signers[FPR].role = "owner"; // the roster says contributor
  fs.writeFileSync(p, `${JSON.stringify(doc, null, 2)}\n`);
  const r = runGen(dir, ["--check"]);
  if (r.status !== 1) return `a hand-edited role escalation was not caught; exit ${r.status}`;
  return /DRIFT/.test(r.stderr || "") ? true : `caught, but not reported as DRIFT: ${(r.stderr || "").slice(0, 200)}`;
})());

check("arm4/drift-report-does-NOT-print-key-material", (() => {
  const dir = mkRepo();
  runGen(dir, ["--write"]);
  fs.writeFileSync(path.join(dir, ".claude", "trust-root.json"), "{}\n");
  const r = runGen(dir, ["--check"]);
  const all = (r.stdout || "") + (r.stderr || "");
  if (all.includes(PUB)) return "the drift report printed the PUBKEY — a CI log is not a place for key material";
  if (all.includes(FPR)) return "the drift report printed a FINGERPRINT";
  return true;
})());

check("arm4/no-roster-is-NOT-DERIVABLE-rather-than-an-empty-trust-root", (() => {
  // The consumer case. Writing an empty trust root here would be worse than writing
  // none: empty is INDETERMINATE at the reader, and would look like a completed adoption.
  const r = runGen(mkRepo({ withRoster: false }), ["--write"]);
  if (r.status !== 2) return `expected exit 2 (unrunnable); got ${r.status}`;
  if (!/NOT DERIVABLE/.test(r.stderr || "")) return `did not name the condition: ${(r.stderr || "").slice(0, 200)}`;
  return /CONSUMER|authored/i.test(r.stderr || "")
    ? true
    : "the refusal does not tell a consumer that authoring, not deriving, is the expected path";
})());

check("arm4/derived-file-carries-no-identity-beyond-the-verification-question", (() => {
  const dir = mkRepo();
  runGen(dir, ["--write"]);
  const doc = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "trust-root.json"), "utf8"));
  const fields = Object.keys(doc.signers[FPR] || {}).sort().join(",");
  const want = "host_role,person_id,pubkey,role,type";
  if (fields !== want) return `the disclosure surface CHANGED: got ${fields}, expected ${want}`;
  const blob = JSON.stringify(doc);
  for (const leaked of ["display_id", "email", "login", "fixture@"]) {
    if (blob.includes(leaked)) return `the derived file leaked ${leaked} — a consumer COMMITS this file`;
  }
  return true;
})());

// THE DUPLICATE-FINGERPRINT RISK LIVES IN THE GENERATOR, NOT IN THE READER.
//
// An earlier case here claimed to pin FIRST-WINS and was VACUOUS: it asserted the
// property against a `signers` map holding ONE entry, which cannot fail unless
// `trustRootIndex` rejects a well-formed entry — already covered by
// `admission-predicate-parity · GREEN`. The reader's `byFpr.has(fpr)` branch is in fact
// UNREACHABLE, because JSON object keys cannot repeat and `JSON.parse` keeps the last.
//
// The real exposure is two PERSONS in the ROSTER sharing one fingerprint. Review
// measured it: delete the generator's three-line first-wins guard and this suite stayed
// GREEN with eight proven reach hits, while the derived trust root elevated the shared
// fingerprint from `contributor` to `owner` — the reader still saying `contributor`.
// That is a privilege elevation between two surfaces that are supposed to agree.
check("arm3/generator-first-wins-matches-the-READER-on-a-shared-fingerprint", () => {
  const dir = mkRepo({ withRoster: false });
  // TWO persons, ONE fingerprint. `pid-first` is a contributor; `pid-second` is an
  // owner. `signerIndex` is first-wins over `Object.entries`, so the READER answers
  // `pid-first`/contributor. The generator must agree.
  const shared = {
    genesis: { established_at: "2026-08-01T00:00:00.000Z" },
    persons: {
      "pid-first": { display_id: "first", role: "contributor", host_role: "human", keys: [{ type: "ssh", fingerprint: FPR, pubkey: PUB }] },
      "pid-second": { display_id: "second", role: "owner", host_role: "human", keys: [{ type: "ssh", fingerprint: FPR, pubkey: PUB }] },
    },
  };
  fs.writeFileSync(path.join(dir, ".claude", "operators.roster.json"), JSON.stringify(shared, null, 2));
  const w = runGen(dir, ["--write"]);
  if (w.status !== 0) return `the generator refused a shared-fingerprint roster: ${(w.stderr || "").slice(0, 200)}`;
  const derived = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "trust-root.json"), "utf8"));
  const gen = derived.signers[FPR];
  const reader = EV.signerIndex(shared).get(FPR);
  if (!gen) return "the generator emitted no entry for the shared fingerprint";
  if (!reader) return "signerIndex admitted nothing — the control side of this comparison is dead";
  if (gen.person_id !== reader.person_id) {
    return `GENERATOR and READER disagree on a shared fingerprint: generator=${gen.person_id}/${gen.role}, reader=${reader.person_id}/${reader.role} — this is the privilege-elevation shape`;
  }
  return gen.role === reader.role
    ? true
    : `same person_id but different role: generator=${gen.role}, reader=${reader.role}`;
});

// ═══════════════════════════════════════════════════════════════════════════
// ARM 5 — THE CONTAMINATION FENCE. LOOM'S OWN TRUST ROOT MUST NEVER TRAVEL.
//
// This is the most important property in the change and the one that was WRONG first.
// `target_owned:` was declared and believed sufficient; it is not. Its contract is
// "loom never DELETES the path" plus a `publish:` attribute governing GITIGNORE
// EMISSION — neither of which stops a COPY. Measured before the fence existed:
// `classifyFile('.claude/trust-root.json', …)` returned `{action:"copy",
// reason:"tier_match"}` on the USE lane, i.e. canon's fingerprints, pubkeys and
// `role: owner` shipped to every consumer — the exact contamination the roster/trust-root
// split exists to close, re-created inside the fix for it.
//
// The poles are two paths through the SAME classifier with the SAME arguments. A fence
// that skipped everything would fail the GREEN pole.
// ═══════════════════════════════════════════════════════════════════════════

const SYNC = require(path.join(REPO_ROOT, ".claude", "bin", "sync-tier-aware.mjs"));
const WIDE = [".claude/**"]; // deliberately wide: only a REAL fence can skip, not a narrow include

pair(
  "trust-root-never-ships",
  "the trust root is SKIPPED as loom-local on the USE lane — loom never supplies a consumer's",
  () => {
    const v = SYNC.classifyFile(".claude/trust-root.json", WIDE, [], [], [], "use");
    if (!v || v.action !== "skip") {
      return `LOOM'S TRUST ROOT WOULD SHIP: ${JSON.stringify(v)} — this is the contamination vector the split closes`;
    }
    return v.reason === "loom_local" ? true : `skipped for the wrong reason: ${JSON.stringify(v)}`;
  },
  "an ordinary governed artifact still COPIES on the same lane — the fence is not a blanket skip",
  () => {
    const v = SYNC.classifyFile(".claude/rules/security.md", WIDE, [], [], [], "use");
    return v && v.action === "copy"
      ? true
      : `the control did not ship, so the skip above measures nothing: ${JSON.stringify(v)}`;
  },
);

check("arm5/trust-root-never-ships-on-the-BUILD-lane-either", (() => {
  // BUILD repos have their OWN operators and their own trust root. The lane is not the
  // axis; ownership is. A build-lane copy would overwrite kailash-py's signers with
  // loom's.
  const v = SYNC.classifyFile(".claude/trust-root.json", WIDE, [], [], [], "build");
  return v && v.action === "skip"
    ? true
    : `loom's trust root would reach a BUILD repo: ${JSON.stringify(v)}`;
})());

check("arm5/the-manifest-still-declares-it-target-owned", (() => {
  // Both fences are required and they are NOT substitutes: this one keeps loom from
  // DELETING the consumer's file, the classifier keeps loom from SUPPLYING one.
  // Asserted against the manifest text because the two live in different files and a
  // future edit could remove either half believing the other covers it.
  const mf = fs.readFileSync(path.join(REPO_ROOT, ".claude", "sync-manifest.yaml"), "utf8");
  const block = mf.slice(mf.indexOf("\ntarget_owned:"));
  if (!block) return "no target_owned block found in the manifest";
  const idx = block.indexOf(".claude/trust-root.json");
  if (idx === -1) return "the trust root is NOT declared target_owned — loom may delete a consumer's copy";
  return /publish:\s*committed/.test(block.slice(idx, idx + 200))
    ? true
    : "declared target_owned but not `publish: committed` — a consumer must be able to commit it";
})());

// ═══════════════════════════════════════════════════════════════════════════
// ARM 6 — THE REVIEW FIXES. Each case pins a defect an adversarial review found
// in the FIRST revision of this change; none of them would have been caught by
// the arms above, which is why they are here rather than folded in.
// ═══════════════════════════════════════════════════════════════════════════

check("arm6/C1-read-gate-does-not-unconditionally-pass-the-roster", () => {
  // THE CRITICAL. `burndown-build.mjs` passed `{ roster }` to the resolver, which hits
  // the pre-read short-circuit — so `readCommittedTrustRoot` was NEVER REACHED FROM THE
  // READ GATE. The trust root bound `appendEvent` alone: the WRITE path, which an
  // adversary skips by hand-writing a signed record. Net effect, measured on a scratch
  // clone: an EMPTY committed trust root still verified all 534 records at exit 0.
  //
  // Structural rather than behavioural because the defect IS the wiring — a behavioural
  // test passes either way as long as roster and trust root agree, which is exactly the
  // condition that hid it.
  const src = fs.readFileSync(path.join(REPO_ROOT, ".claude", "bin", "burndown-build.mjs"), "utf8");
  const m = /verifyAuthorityBindings\([\s\S]{0,400}?\)\s*;/.exec(src);
  if (!m) return "could not locate the verifyAuthorityBindings call — anchor drifted, this case measures nothing";
  const call = m[0];
  if (!/trustRootIndex/.test(call)) {
    return `the read gate's resolver never receives a trust-root index — the trust root cannot TIGHTEN, only loosen the write path: ${call.slice(0, 160)}`;
  }
  if (/makeRosterSignerResolver\(repo,\s*\{\s*roster\s*\}\s*\)/.test(call)) {
    return "the read gate still passes `{ roster }` unconditionally — the short-circuit that caused the CRITICAL";
  }
  return true;
});

pair(
  "C1-preread-precedence",
  "a pre-read TRUST-ROOT index WINS over a pre-read roster — the fix's precedence",
  () => {
    const got = EV.makeRosterSignerResolver("/nonexistent-repo", {
      roster: ROSTER, // says contributor
      trustRootIndex: EV.trustRootIndex(trustRoot()), // says owner
    })(FPR);
    if (!got || got.ok !== true) return `nothing resolved: ${JSON.stringify(got)}`;
    return got.role === "owner"
      ? true
      : `the pre-read roster won over the pre-read trust root — this is the CRITICAL's shape: ${JSON.stringify(got)}`;
  },
  "with NO trust-root index supplied, the pre-read roster is still honoured — the option is additive",
  () => {
    const got = EV.makeRosterSignerResolver("/nonexistent-repo", { roster: ROSTER })(FPR);
    return got && got.ok === true && got.role === "contributor"
      ? true
      : `the roster path regressed: ${JSON.stringify(got)}`;
  },
);

check("arm6/H2-a-TRUNCATED-trust-root-is-BROKEN-not-absent", () => {
  // The downgrade an attacker picks: damage the surface you cannot forge, and a
  // catch-all "absent" hands the resolver back to the one you can influence. Empty is
  // DAMAGE — a repo that never adopted a trust root does not have the path at all.
  const got = EV.makeRosterSignerResolver("/nonexistent-repo", {
    readRoster: () => JSON.stringify(ROSTER),
    readTrustRoot: () => "   ",
  })(FPR);
  if (got && got.ok === true && got.role === "contributor") {
    return "a TRUNCATED trust root fell back to the roster — the attacker-triggerable downgrade";
  }
  if (!got || got.ok !== false) return `expected a refusal; got ${JSON.stringify(got)}`;
  return /empty|EMPTY/.test(got.reason || "") ? true : `refused, but not on truncation: ${JSON.stringify(got.error)}`;
});

check("arm6/M3-a-FOREIGN-root-commit-anchor-refuses", () => {
  // The anchor was written and never compared — a trust root lifted verbatim from
  // ANOTHER repository (including canon's) was accepted. That is precisely the
  // wholesale replacement first-wins anchoring exists to refuse.
  const dir = mkRepo();
  runGen(dir, ["--write"]);
  const p = path.join(dir, ".claude", "trust-root.json");
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  const real = doc.root_commit;
  doc.root_commit = "f".repeat(40); // some other repository's root
  fs.writeFileSync(p, `${JSON.stringify(doc, null, 2)}\n`);
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "foreign anchor"], { cwd: dir, stdio: "ignore" });
  const got = EV.readCommittedTrustRoot(dir, {});
  if (!real) return "the generator wrote no anchor, so this case cannot discriminate — UNRESOLVED";
  if (got.ok === true) return "a trust root carrying ANOTHER repository's root commit was accepted";
  return /anchored elsewhere/.test(got.error || "")
    ? true
    : `refused, but not on the anchor: ${JSON.stringify(got.error)}`;
});

check("arm6/M3-the-repo-s-OWN-anchor-is-accepted", () => {
  // The control for the case above: if the anchor check refused everything, the RED
  // case would pass while proving nothing.
  const dir = mkRepo();
  runGen(dir, ["--write"]);
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "own anchor"], { cwd: dir, stdio: "ignore" });
  const got = EV.readCommittedTrustRoot(dir, {});
  return got.ok === true ? true : `the repo's OWN anchor was rejected: ${JSON.stringify(got.error || got)}`;
});

check("arm6/M4-the-publish-lane-carries-BOTH-fences", () => {
  // Parity with the artifact this was split from: `.claude/audit-fixtures` IS an
  // INCLUDE root, so a fixture named `trust-root.json` under it would carry canon's
  // real fingerprints to the public fork without these two entries.
  const cm = fs.readFileSync(path.join(REPO_ROOT, ".claude", "bin", "lib", "community-membership.mjs"), "utf8");
  if (!/EXCLUDE_WITHIN[\s\S]{0,4000}?"\.claude\/trust-root\.json"/.test(cm)) {
    return "the trust root is not in EXCLUDE_WITHIN — its twin operators.roster.json is";
  }
  if (!/KILL_BASENAMES[\s\S]{0,2000}?"trust-root\.json"/.test(cm)) {
    return "the trust root is not in KILL_BASENAMES — its twin operators.roster.json is";
  }
  return true;
});

check("arm6/L1-signerIndex-and-trustRootIndex-agree-on-an-EMPTY-person-id", () => {
  // They were claimed identical and were not: `signerIndex` took `pid` from an object
  // key and never checked it non-empty, so `""` was admitted there and refused here.
  // Aligned UPWARD — relaxing the authority-granting surface to "restore parity" is
  // the wrong direction.
  const rosterIdx = EV.signerIndex({ persons: { "": { role: "owner", keys: [{ type: "ssh", fingerprint: FPR, pubkey: PUB }] } } });
  const trIdx = EV.trustRootIndex({ signers: { [FPR]: { pubkey: PUB, type: "ssh", person_id: "", role: "owner" } } });
  if (trIdx.size !== 0) return `trustRootIndex admitted an empty person_id; size=${trIdx.size}`;
  return rosterIdx.size === 0
    ? true
    : `signerIndex still admits an empty person_id (size=${rosterIdx.size}) while trustRootIndex refuses it`;
});

for (const d of tmpDirs) {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

if (failures.length) {
  console.error(`\ntrust-root-split fixtures: ${failures.length} of ${cases} FAILED\n`);
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`\ntrust-root-split fixtures: ${cases}/${cases} passed`);
