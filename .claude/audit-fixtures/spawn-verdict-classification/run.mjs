#!/usr/bin/env node
/*
 * spawn-verdict-classification — did the child produce a VERDICT, or nothing?
 * (`.claude/hooks/lib/coc-sign.js::_spawnDidNotRun` / `_noVerdictReason`)
 *
 * ── THE DEFECT THIS PINS, AND WHY IT IS NOT CI WEATHER ──────────────────────
 *
 * `_spawnDidNotRun` returned true whenever `r.error` was set. Its own docblock
 * justified that by naming ENOENT, ETIMEDOUT and EAGAIN — every one of which
 * leaves `status` NULL, which is what makes them "no verdict".
 *
 * EPIPE is not one of those. It means the child RAN, decided, and exited BEFORE
 * consuming all of stdin; the unfinished parent-side write raises it. The child's
 * verdict is present in `status`/`stdout`/`stderr` — and the blanket `r.error ||`
 * discarded it and reported an outage instead.
 *
 * MEASURED against the real gpg on this machine, and the reason it is a
 * correctness bug rather than a flake — it flips at the PIPE BUFFER:
 *
 *     stdin      status   error    stderr
 *     64 B         2      none     "gpg: invalid armor header: ..."
 *     64 KB        2      none     "gpg: invalid armor header: ..."
 *     1 MB         2      EPIPE    "gpg: invalid armor header: ..."
 *
 * The SAME bad signature is a record fact on a small payload and a gpg outage on
 * a large one. In CI it surfaced as three `burndown-log-verification` failures
 * reading "gpg --verify did not run: EPIPE", sending a reader to repair a healthy
 * gpg when the truth was "this record did not verify".
 *
 * ── ARM 3 IS THE ONE THAT COULD NOT BE FAKED ───────────────────────────────
 *
 * Arms 1-2 hand the predicate synthesized `spawnSync` shapes, so they say nothing
 * about whether a REAL gpg on a REAL large payload still lands in the branch they
 * describe (`instrument-discipline.md` MUST-2(a) — a green reports on the
 * behaviour it NAMES). Arm 3 runs the real binary at both sizes and asserts the
 * classification is SIZE-INVARIANT, which is the property in one sentence.
 *
 * Exits non-zero on the first mismatch.
 */

import "../_lib/no-ambient-git.cjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const CS = require(path.join(REPO_ROOT, ".claude", "hooks", "lib", "coc-sign.js"));

let cases = 0;
const failures = [];
const tmpDirs = [];

// ONE `PASS <name>` line PER CASE. `run-audit-fixtures.mjs` counts cases with
// /^[ \t]*(?:PASS|ok)[ \t]+\S/ and does NOT count a summary line — a runner that
// prints only its summary is observed at ZERO cases against its declared
// min_cases, exiting 0 while contributing no coverage.
function check(name, verdict) {
  cases++;
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

// ═══════════════════════════════════════════════════════════════════════════
// ARM 1 — EPIPE WITH A FAILING STATUS IS A VERDICT; EVERY OTHER ERROR IS NOT
// ═══════════════════════════════════════════════════════════════════════════

pair(
  "epipe-failing-status-is-a-verdict",
  "ENOENT (status null) is NO verdict — the classification this predicate was written for",
  () => {
    const got = CS._spawnDidNotRun({ error: { code: "ENOENT" }, status: null });
    return got === true ? true : `ENOENT must be no-verdict; got ${got}`;
  },
  "EPIPE with a FAILING status IS a verdict — the child rejected what it read",
  () => {
    const got = CS._spawnDidNotRun({ error: { code: "EPIPE" }, status: 2, stderr: "gpg: invalid armor header" }, { admitEpipeVerdict: true });
    return got === false
      ? true
      : `EPIPE+status2 carries the child's rejection and must NOT be reported as an outage; got ${got}`;
  },
);

check("arm1/etimedout-null-status-is-no-verdict", (() => {
  const got = CS._spawnDidNotRun({ error: { code: "ETIMEDOUT" }, status: null });
  return got === true ? true : `a killed child produced no verdict; got ${got}`;
})());

check("arm1/eagain-null-status-is-no-verdict", (() => {
  const got = CS._spawnDidNotRun({ error: { code: "EAGAIN" }, status: null });
  return got === true ? true : `an unforkable child produced no verdict; got ${got}`;
})());

check("arm1/clean-exit-is-a-verdict", (() => {
  const got = CS._spawnDidNotRun({ error: null, status: 0 });
  return got === false ? true : `a clean run is a verdict; got ${got}`;
})());

check("arm1/clean-nonzero-exit-is-a-verdict", (() => {
  const got = CS._spawnDidNotRun({ error: null, status: 1 });
  return got === false ? true : `a non-zero exit with no spawn error is a verdict; got ${got}`;
})());

check("arm1/null-result-is-no-verdict", (() => {
  const got = CS._spawnDidNotRun(null);
  return got === true ? true : `a missing result is no verdict; got ${got}`;
})());

// ═══════════════════════════════════════════════════════════════════════════
// ARM 2 — THE SECURITY-BEARING ASYMMETRY: A *SUCCESS* UNDER EPIPE IS REFUSED
//
// Under EPIPE the child provably did not read all the input. A REJECTION of a
// prefix is still a rejection (fail-closed, and now informative). A PASS over
// data the verifier never finished reading is indistinguishable from "the first
// N bytes were fine" — the fail-OPEN shape a signature check must never take.
// Both poles are EPIPE; they differ ONLY in the child's status.
// ═══════════════════════════════════════════════════════════════════════════

pair(
  "epipe-success-is-refused",
  "EPIPE with status 0 is REFUSED as a verdict — a pass over a partial read is not a pass",
  () => {
    const got = CS._spawnDidNotRun({ error: { code: "EPIPE" }, status: 0 });
    return got === true
      ? true
      : `a SUCCESS over input the child never finished reading must stay INDETERMINATE; got ${got}`;
  },
  "EPIPE with status 2 is ACCEPTED as a verdict — the same error code, the opposite disposition",
  () => {
    const got = CS._spawnDidNotRun({ error: { code: "EPIPE" }, status: 2 }, { admitEpipeVerdict: true });
    return got === false ? true : `EPIPE+status2 is the child's own rejection; got ${got}`;
  },
);

check("arm2/refused-success-reason-names-the-partial-read", (() => {
  const reason = CS._noVerdictReason({ error: { code: "EPIPE" }, status: 0 });
  if (!/partial|prefix|before reading all/i.test(reason)) {
    return `the reason must explain WHY a success was refused, not just print the errno; got ${JSON.stringify(reason)}`;
  }
  if (!/INDETERMINATE|fail-closed/i.test(reason)) {
    return `the reason must state the disposition taken; got ${JSON.stringify(reason)}`;
  }
  return true;
})());

// ── the two cases adversarial review showed were MISSING ───────────────────

check("arm2/EPIPE-with-a-NULL-status-is-not-announced-as-a-SUCCESS", (() => {
  // A child KILLED BY A SIGNAL while the parent was mid-write: status null, error
  // EPIPE. Review reproduced it with a real subprocess (`kill -TERM $$` under an 8 MiB
  // stdin) and this function announced "EPIPE with a SUCCESS status" — there was no
  // success and no status. The suite had no case in this shape at all: it covered
  // EPIPE+0, EPIPE+2, ENOENT+null and null-error+null, and this one fell between them.
  const reason = CS._noVerdictReason({ error: { code: "EPIPE" }, status: null });
  if (/SUCCESS status/.test(reason)) {
    return `a signal-killed child was reported as a partial-read PASS: ${JSON.stringify(reason)}`;
  }
  return reason === "EPIPE" ? true : `expected the plain errno rendering; got ${JSON.stringify(reason)}`;
})());

pair(
  "epipe-admission-is-per-call-site",
  "WITHOUT the opt-in, EPIPE+nonzero is NO verdict — the safe default every site inherits",
  () => {
    const got = CS._spawnDidNotRun({ error: { code: "EPIPE" }, status: 2 });
    return got === true
      ? true
      : `a site with no way to tell "decided and rejected" from "died before reading stdin" must not be handed a verdict; got ${got}`;
  },
  "WITH the opt-in, the SAME result IS a verdict — reserved for the caller holding a status channel",
  () => {
    const got = CS._spawnDidNotRun({ error: { code: "EPIPE" }, status: 2 }, { admitEpipeVerdict: true });
    return got === false ? true : `the opt-in did not admit the child's rejection; got ${got}`;
  },
);

check("arm2/the-opt-in-does-NOT-unlock-a-SUCCESS-under-EPIPE", (() => {
  // The security-bearing half survives the opt-in: a pass over input the child never
  // finished reading is not a pass at ANY site, however capable the caller.
  const got = CS._spawnDidNotRun({ error: { code: "EPIPE" }, status: 0 }, { admitEpipeVerdict: true });
  return got === true ? true : `the opt-in unlocked a partial-read SUCCESS — fail-open; got ${got}`;
})());

check("arm2/exactly-ONE-call-site-opts-in", (() => {
  // Which site opts in is the whole finding, so it is pinned structurally: the gpg
  // --verify site is the only caller with `_gpgNonZeroIsRecordVerdict` to classify with.
  const src = fs.readFileSync(path.join(REPO_ROOT, ".claude", "hooks", "lib", "coc-sign.js"), "utf8");
  const optIns = (src.match(/admitEpipeVerdict:\s*true/g) || []).length;
  if (optIns !== 1) return `expected exactly ONE opt-in call site; found ${optIns}`;
  const idx = src.indexOf("admitEpipeVerdict: true");
  const window = src.slice(idx, idx + 600);
  return /gpg --verify did not run/.test(window)
    ? true
    : "the opt-in is not at the gpg --verify site — that is the only caller able to discriminate";
})());

check("arm2/ordinary-errno-still-renders-plainly", (() => {
  const reason = CS._noVerdictReason({ error: { code: "ENOENT" }, status: null });
  return reason === "ENOENT" ? true : `a genuine no-run must still render its errno; got ${JSON.stringify(reason)}`;
})());

check("arm2/absent-error-renders-no-exit-status", (() => {
  const reason = CS._noVerdictReason({ error: null, status: null });
  return reason === "no exit status" ? true : `got ${JSON.stringify(reason)}`;
})());

// ═══════════════════════════════════════════════════════════════════════════
// ARM 3 — THE REAL BINARY, AT BOTH SIZES. THE CLASSIFICATION IS SIZE-INVARIANT.
//
// Arms 1-2 injected the shapes; this one PRODUCES them. Without it, a green
// above is consistent with a real gpg that never reaches the EPIPE branch at
// all. 1 MB is past the pipe buffer on every platform this runs on; 64 B is
// comfortably inside it. Same signature, same homedir, same verdict required.
// ═══════════════════════════════════════════════════════════════════════════

const home = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-verdict-gpg-"));
tmpDirs.push(home);
fs.chmodSync(home, 0o700);
const sigFile = path.join(home, "bad.asc");
fs.writeFileSync(sigFile, "-----BEGIN PGP SIGNATURE-----\nnotarealsignature\n-----END PGP SIGNATURE-----\n");

function gpgVerdict(bytes) {
  const r = spawnSync(
    "gpg",
    ["--homedir", home, "--batch", "--status-fd", "1", "--verify", sigFile, "-"],
    { input: "x".repeat(bytes), encoding: "utf8", timeout: 30000 },
  );
  // THE OPT-IN, because this arm stands in for the gpg --verify site — the one
  // caller holding a `--status-fd` channel, and therefore the one permitted to read
  // an EPIPE+nonzero as the child's own rejection. Without it this arm would assert
  // size-invariance about a site that does not exist.
  return { r, noVerdict: CS._spawnDidNotRun(r, { admitEpipeVerdict: true }) };
}

const small = gpgVerdict(64);
const large = gpgVerdict(1024 * 1024);

// The control fires FIRST: if gpg is absent or never rejects, the arm measures
// nothing and must say so rather than passing.
check("arm3/control-gpg-actually-rejected-the-bad-signature", (() => {
  if (small.r.error && small.r.error.code === "ENOENT") {
    return "gpg is not installed here — this arm can prove nothing and is NOT a pass";
  }
  if (small.r.status === 0) return "gpg ACCEPTED a bogus signature — the fixture's premise is broken";
  return small.r.status !== null ? true : `gpg produced no status at 64 B: ${JSON.stringify(small.r.error)}`;
})());

check("arm3/small-payload-is-a-verdict", (() => {
  return small.noVerdict === false ? true : `a 64 B rejection must be a verdict; got noVerdict=${small.noVerdict}`;
})());

check("arm3/large-payload-is-ALSO-a-verdict", (() => {
  if (large.r.status === null) return `gpg produced no status at 1 MB: ${JSON.stringify(large.r.error)}`;
  return large.noVerdict === false
    ? true
    : `a 1 MB rejection was classified as an OUTAGE — this is the defect; error=${large.r.error && large.r.error.code}`;
})());

check("arm3/SIZE-INVARIANCE-the-property-in-one-assertion", (() => {
  return small.noVerdict === large.noVerdict
    ? true
    : `the same bad signature classified differently by payload size: 64B noVerdict=${small.noVerdict}, 1MB noVerdict=${large.noVerdict}`;
})());

// And the honest bound: the two runs must have taken DIFFERENT spawn paths, or
// size-invariance was asserted over a case that never varied. This is what keeps
// arm 3 from being a pair of identical measurements wearing different labels.
check("arm3/the-two-sizes-genuinely-exercised-different-spawn-outcomes", (() => {
  const se = small.r.error && small.r.error.code;
  const le = large.r.error && large.r.error.code;
  if (se === le) {
    return `NOT MEASURED — both sizes produced error=${JSON.stringify(se)}, so the EPIPE branch was never reached and size-invariance was asserted over one path. UNRESOLVED, not a pass.`;
  }
  return le === "EPIPE" ? true : `expected the large payload to raise EPIPE; got ${JSON.stringify(le)}`;
})());

for (const d of tmpDirs) {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch {
    /* best effort — a leftover temp dir is not a test failure */
  }
}

if (failures.length) {
  console.error(`\nspawn-verdict-classification fixtures: ${failures.length} of ${cases} FAILED\n`);
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`\nspawn-verdict-classification fixtures: ${cases}/${cases} passed`);
