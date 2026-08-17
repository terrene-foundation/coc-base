/**
 * Differential oracle for `_splitRemoteUrl` host derivation.
 *
 * The fence's whole correctness property is: THE HOST THIS MODULE DERIVES MUST
 * EQUAL THE HOST GIT ACTUALLY CONNECTS TO. Three defects in this PR were all
 * violations of exactly that, found one at a time by reading. This asks the
 * real resolvers instead.
 *
 * ORACLES (each is the thing git actually delegates to):
 *   scp-style  -> `ssh -G <dest>` reports the host ssh would use.
 *   scheme URL -> WHATWG `new URL()` .hostname (what curl resolves; git uses
 *                 curl for http/https).
 *
 * BIPOLAR BY CONSTRUCTION — and this is a CORRECTION, recorded rather than
 * quietly fixed. The first version of this file scored a `derived=null`
 * (refusal) as "ok" on every row and stated that as a deliberate caveat. It was
 * not merely a caveat, it was a NON-DISCRIMINATING INSTRUMENT: measured, a
 * parser stubbed to `return {ok:false}` for EVERY input scored
 * `DIVERGENCES: 0` and exited 0. No result it could produce would have
 * falsified "the parser derives correctly" — the exact
 * `instrument-discipline.md` MUST-1 defect this file exists to catch one layer
 * down. Documenting a weakness is not testing for it.
 *
 * So every row now carries an explicit expectation:
 *   "derive" -> MUST return a host, and it MUST equal the oracle's. A refusal
 *               here is a FINDING: a legitimate remote the fence would lock its
 *               own maintainer out of.
 *   "refuse" -> MUST return null (the path component carries a byte the
 *               `normalizeComponent` allowlist rejects).
 * A refuse-everything parser now fails every "derive" row; a derive-everything
 * parser fails the "refuse" rows. Both directions are instrumented, and a dead
 * `ssh -G` oracle is itself a finding rather than a silent pass.
 *
 * WHAT THIS IS AND IS NOT EVIDENCE OF: a divergence is a finding; agreement is
 * NOT proof of security. It is proof of check/use PARITY over the corpus
 * driven, plus non-vacuity in both directions — the property each of the three
 * defects broke, and nothing more.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// Resolve the module under test RELATIVE to this file, so the check runs against
// the tree it ships in — from a worktree, a sandbox copy, or a consumer clone.
// An absolute repo path would silently test the WRONG tree from a copy, which is
// its own non-discriminating-instrument failure.
const HERE = dirname(fileURLToPath(import.meta.url));
const MOD = resolve(HERE, "../../hooks/lib/upflow-self-repo.js");
const mod = require(MOD);

function derivedHost(url) {
  const d = mkdtempSync(join(tmpdir(), "diffhost-"));
  try {
    execFileSync("git", ["init", "-q", "."], { cwd: d });
    execFileSync("git", ["remote", "add", "origin", url], { cwd: d });
    const r = mod.deriveSelfRepoRef(d);
    return r.ok ? r.self.host : null; // null = refused (fail-closed)
  } catch {
    return null;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

function sshHost(dest) {
  const out = execFileSync("ssh", ["-G", dest], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const m = out.match(/^hostname (.+)$/m);
  return m ? m[1].trim().toLowerCase() : null;
}

function urlHost(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// [url, expectation] — "derive" (host must match oracle) | "refuse" (must be null)
const SCHEME = [
  ["https://github.com/o/r.git", "derive"],
  ["http://github.com/o/r", "derive"],
  ["https://user@github.com/o/r", "derive"],
  ["https://user:tok@github.com/o/r", "derive"],
  ["https://evil.com#@github.com/o/r", "derive"], // authority ends at `#` (curl)
  ["https://evil.com?@github.com/o/r", "derive"],
  ["https://user@evil.com@github.com/o/r", "derive"], // last `@` wins
  ["https://github.com:443/o/r", "derive"],
  ["HTTPS://github.com/o/r", "derive"],
  ["https://github.com./o/r", "derive"], // trailing dot preserved, deliberately
  ["https://dev.azure.com/org/proj/_git/repo", "derive"],
  ["https://org.visualstudio.com/proj/_git/repo", "derive"],
  ["https://[::1]/o/r", "derive"], // bracketed IPv6 taken whole
  ["https://github.com/o/r?x=1", "refuse"], // `?` in the path component
  ["https://github.com/o/r#frag", "refuse"], // `#` in the path component
  // Fragment/query inject EXTRA path segments. The `#`/`?` cut applies to the
  // AUTHORITY only, so before the exact-segment-count fix these derived the
  // TRAILING pair — `upstream/repo` for a URL naming `evil/repo`. Measured.
  ["https://github.com/evil/repo#/upstream/repo", "refuse"],
  ["https://github.com/evil/repo?x=/upstream/repo", "refuse"],
  // A pasted browser URL: four segments. Previously derived `tree/main`.
  ["https://github.com/o/r/tree/main", "refuse"],
  // ADO twin — the trailing pair became project/repo under the real org.
  [
    "https://dev.azure.com/realorg/realproj/_git/realrepo#/otherproj/otherrepo",
    "refuse",
  ],
];

const SCP = [
  ["git@github.com:o/r.git", "derive"],
  ["git@github.com#@evil.com:o/r", "derive"], // ssh splits at LAST `@`
  ["git@github.com?@evil.com:o/r", "derive"],
  // These two carried expectation "derive" until the exact-segment-count fix,
  // and the change is recorded rather than silently retuned. Their scp PATHS
  // (`mirror/https://github.com/o/r`, `x/https://github.com/o/r`) are five
  // segments, so they no longer parse to an owner/name pair at all. Refusing is
  // STRICTLY STRONGER than deriving the correct host, so the expectation moves
  // in the safe direction — but it does mean these two rows no longer exercise
  // host parity. The `#`/`?` scp rows above still do, which is what keeps the
  // scp userinfo-split property instrumented here.
  ["git@evil.com:mirror/https://github.com/o/r", "refuse"],
  ["evil.com:x/https://github.com/o/r", "refuse"],
  ["git#foo@github.com:o/r", "derive"], // `#` in USERINFO is legitimate
  ["user@host@github.com:o/r", "derive"],
  ["git@ssh.dev.azure.com:v3/org/proj/repo", "derive"],
  ["github.com:o/r", "derive"],
  ["git@github.com:o/r", "derive"],
];

let findings = 0;
let derivedCount = 0;

function check(url, expect, oracle, oracleLabel) {
  const got = derivedHost(url);
  let verdict;
  if (expect === "refuse") {
    verdict = got === null ? "ok" : "SHOULD-REFUSE";
  } else if (got === null) {
    verdict = "FALSE-REFUSAL"; // a legitimate remote the fence would lock out
  } else {
    derivedCount++;
    verdict = got === oracle ? "ok" : "DIVERGE";
  }
  if (verdict !== "ok") findings++;
  console.log(
    `${(verdict === "ok" ? "ok" : verdict).padEnd(14)} derived=${String(got).padEnd(16)} ${oracleLabel}=${String(oracle).padEnd(16)} ${url}`,
  );
}

console.log("=== SCHEME FORMS (oracle: WHATWG URL / curl) ===");
for (const [u, expect] of SCHEME) check(u, expect, urlHost(u), "oracle");

console.log("\n=== SCP FORMS (oracle: ssh -G) ===");
for (const [u, expect] of SCP) {
  const dest = u.slice(0, u.indexOf(":")); // scp destination = before first colon
  let oracle = null;
  try {
    oracle = sshHost(dest);
  } catch (e) {
    oracle = null;
    console.log(`ORACLE-DEAD    ssh -G threw for ${dest}: ${e.message}`);
  }
  // A dead oracle MUST NOT read as agreement — that is the same
  // non-discriminating failure, relocated from the subject into the instrument.
  if (oracle === null) {
    console.log(`ORACLE-DEAD    no hostname from ssh -G for ${dest}`);
    findings++;
    continue;
  }
  check(u, expect, oracle, "ssh");
}

// NON-VACUITY FLOOR (aggregate). The per-row FALSE-REFUSAL verdict already
// catches a refuse-everything parser; this catches the corpus itself being
// gutted, which would otherwise silently shrink the denominator to zero and
// still print a clean run — `conformance-walk.md`'s fabricated-pass shape.
const EXPECTED_DERIVING =
  SCHEME.filter(([, e]) => e === "derive").length +
  SCP.filter(([, e]) => e === "derive").length;
if (derivedCount !== EXPECTED_DERIVING) {
  console.log(
    `\nNON-VACUITY FLOOR BREACHED: ${derivedCount} rows derived a host, expected ${EXPECTED_DERIVING}.`,
  );
  findings++;
}

console.log(
  `\nFINDINGS: ${findings}  (rows deriving a host: ${derivedCount}/${EXPECTED_DERIVING})`,
);
process.exit(findings ? 1 : 0);
