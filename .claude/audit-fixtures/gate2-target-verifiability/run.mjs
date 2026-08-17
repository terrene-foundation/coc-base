#!/usr/bin/env node
/**
 * gate2-target-verifiability — the regression lock for loom#1745.
 *
 * WHAT IS UNDER TEST. `sync-gate2-worktree.mjs` must determine, and SURFACE, whether a
 * Gate-2 distribution target's base branch can be CI-gated at all — before it opens the
 * PR, and as a hard refusal before it AUTO-MERGES one.
 *
 * THE DEFECT. Gate-2 asserted a distribution contract ("landed, CI-gated") it never
 * checked the target could honour. It opened a PR into any resolvable target and told
 * the operator to "merge after CI green" on repos where no check will ever report. The
 * operator then had to choose between merging blind and holding the distribution, with
 * nothing upstream having said the target was unverifiable BY CONSTRUCTION.
 *
 * HOW IT DISCRIMINATES — BIPOLAR BY CONSTRUCTION. Every verdict case is paired: one
 * payload that MUST classify `verifiable` (the gate stays silent) against one that MUST
 * NOT (the gate fires). A classifier hardwired to either pole reds on the other, so a
 * check "shown only to pass" cannot survive here. The `absent` vs `null` pair is the
 * sharpest: `p.required_status_checks?.contexts?.length` collapses both to the same
 * falsy value, so a `?.`-based implementation returns ONE reason for two distinct repo
 * states and reds on case `null-vs-absent-discriminated`.
 *
 * WHY TWO SOURCE PINS. Cases 13–14 read the real source, because a perfect classifier
 * that nothing CALLS is exactly the un-gated shape this fixture exists to prevent
 * (`instrument-discipline.md` MUST-1: name what a false proposition would print — here,
 * an unwired gate prints an identical classifier green). The pins red if the probe call
 * or the merge refusal is removed from `commitPushPrMaybeMerge`.
 *
 * Mutations that red each case are recorded in README.md, measured, not assumed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
// Overridable so the RED can be established against an UNFIXED build of the driver
// without mutating the working tree (`instrument-discipline.md` MUST-2). BOTH the
// imported symbols AND the two source pins read this SAME path — importing a mutant
// while pinning the real file would be two instruments answering two questions
// (`instrument-discipline.md` MUST-4).
const DRIVER =
  process.env.GATE2_DRIVER || path.join(REPO_ROOT, ".claude", "bin", "sync-gate2-worktree.mjs");

const {
  classifyTargetVerifiability,
  probeTargetProtection,
  formatVerifiabilityNotice,
  buildReceipt,
  parseArgs,
} = await import(DRIVER);

let pass = 0;
const failures = [];

/** `PASS <name>` at column 0 is the shape run-audit-fixtures.mjs::CASE_PASS counts. */
function check(name, expectation, actualFn) {
  let ok = false;
  let detail;
  try {
    const r = actualFn();
    ok = r === true;
    if (!ok) detail = typeof r === "string" ? r : JSON.stringify(r);
  } catch (err) {
    detail = `threw: ${err && err.message ? err.message : String(err)}`;
  }
  if (ok) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name}`);
    console.log(`      expected: ${expectation}`);
    console.log(`      actual  : ${detail}`);
  }
}

const v = (probe) => classifyTargetVerifiability(probe);

// ── POLE A — targets that ARE verifiable. The gate MUST NOT fire. ─────────────
check(
  "verifiable/legacy-contexts",
  'a protection payload with required_status_checks.contexts:["validate"] classifies verifiable',
  () => {
    const r = v({ status: "ok", protection: { required_status_checks: { contexts: ["validate"] } } });
    return (
      (r.verdict === "verifiable" && r.contexts.length === 1 && r.contexts[0] === "validate") ||
      JSON.stringify(r)
    );
  },
);

check(
  "verifiable/modern-checks-array-only",
  "a payload carrying ONLY the newer checks:[{context}] carrier still classifies verifiable",
  () => {
    const r = v({
      status: "ok",
      protection: { required_status_checks: { checks: [{ context: "validate", app_id: 15368 }] } },
    });
    return (r.verdict === "verifiable" && r.contexts[0] === "validate") || JSON.stringify(r);
  },
);

check(
  "verifiable/both-carriers-unioned-and-deduped",
  "contexts + checks naming the same and different checks union to the deduped set",
  () => {
    const r = v({
      status: "ok",
      protection: {
        required_status_checks: { contexts: ["validate"], checks: [{ context: "validate" }, { context: "lint" }] },
      },
    });
    return (
      (r.verdict === "verifiable" && JSON.stringify(r.contexts) === '["lint","validate"]') || JSON.stringify(r)
    );
  },
);

// ── POLE B — targets that are NOT verifiable. The gate MUST fire. ─────────────
check(
  "unverifiable/no-branch-protection-404",
  "a 404 from the protection endpoint is the DETERMINATE answer 'unprotected', not an error",
  () => {
    const r = v({ status: "not-found", protection: null });
    return (r.verdict === "unverifiable" && r.reason === "no-branch-protection") || JSON.stringify(r);
  },
);

check(
  "unverifiable/required-status-checks-absent",
  "protection exists but declares no status-check rule at all -> unverifiable",
  () => {
    const r = v({ status: "ok", protection: { required_pull_request_reviews: { dismiss_stale_reviews: true } } });
    return (
      (r.verdict === "unverifiable" && r.reason === "required-status-checks-absent") || JSON.stringify(r)
    );
  },
);

check(
  "unverifiable/required-status-checks-empty",
  "a status-check rule present but naming ZERO contexts is still unverifiable",
  () => {
    const r = v({ status: "ok", protection: { required_status_checks: { contexts: [], checks: [] } } });
    return (
      (r.verdict === "unverifiable" && r.reason === "required-status-checks-empty") || JSON.stringify(r)
    );
  },
);

// The anti-`?.` case. ABSENT and PRESENT-AND-NULL are different repo states with
// different remedies; an optional-chain implementation cannot tell them apart.
check(
  "null-vs-absent-discriminated",
  "required_status_checks ABSENT and required_status_checks:null yield DIFFERENT reasons",
  () => {
    const absent = v({ status: "ok", protection: {} });
    const isNull = v({ status: "ok", protection: { required_status_checks: null } });
    return (
      (absent.verdict === "unverifiable" &&
        isNull.verdict === "unverifiable" &&
        absent.reason === "required-status-checks-absent" &&
        isNull.reason === "required-status-checks-null" &&
        absent.reason !== isNull.reason) ||
      `absent=${absent.reason} null=${isNull.reason} (a ?.-based read collapses these)`
    );
  },
);

// ── POLE C — UNKNOWN is not a pass. An errored probe is zero evidence. ────────
check(
  "unknown/errored-probe-is-not-verifiable",
  "an errored probe classifies unknown, NEVER verifiable (evidence-first-claims.md MUST-3)",
  () => {
    const r = v({ status: "error", protection: null, detail: "HTTP 401: Bad credentials" });
    return (
      (r.verdict === "unknown" && r.verdict !== "verifiable" && r.reason === "protection-probe-errored") ||
      JSON.stringify(r)
    );
  },
);

check(
  "unknown/non-object-payload-is-not-verifiable",
  "a payload that parsed to a non-object (e.g. a bare string) classifies unknown, not verifiable",
  () => {
    const r = v({ status: "ok", protection: "Branch not protected" });
    return (r.verdict === "unknown" && r.verdict !== "verifiable") || JSON.stringify(r);
  },
);

// ── The probe's own 404-vs-error mapping (injected runner; no network). ───────
check(
  "probe/404-maps-to-not-found",
  "a gh failure whose text carries HTTP 404 maps to status not-found, not error",
  () => {
    const r = probeTargetProtection("o/r", "main", () => {
      const e = new Error("gh exited 1");
      e.stderr = "gh: Branch not protected (HTTP 404)\n";
      throw e;
    });
    return r.status === "not-found" || JSON.stringify(r);
  },
);

check(
  "probe/auth-failure-maps-to-error",
  "a gh failure with no 404 signal maps to status error (which classifies unknown)",
  () => {
    const r = probeTargetProtection("o/r", "main", () => {
      const e = new Error("gh exited 1");
      e.stderr = "gh: Bad credentials (HTTP 401)\n";
      throw e;
    });
    return (r.status === "error" && v(r).verdict === "unknown") || JSON.stringify(r);
  },
);

check(
  "probe/unparseable-json-maps-to-error",
  "a 0-exit gh call returning non-JSON maps to error, never to a determinate verdict",
  () => {
    const r = probeTargetProtection("o/r", "main", () => "<html>proxy interstitial</html>");
    return (r.status === "error" && v(r).verdict === "unknown") || JSON.stringify(r);
  },
);

// ── The notice actually NAMES the verdict (a notice nobody can pin can drift). ─
check(
  "notice/names-verdict-and-refusal",
  "the unverifiable notice names the verdict, the no-required-check fact, and the waiver flag",
  () => {
    const text = formatVerifiabilityNotice("o/r", "main", v({ status: "not-found" }), { merging: true });
    const missing = ["[unverifiable]", "NO required status check", "--accept-unverified-target"].filter(
      (s) => !text.includes(s),
    );
    return missing.length === 0 || `notice omits ${JSON.stringify(missing)}`;
  },
);

check(
  "notice/verifiable-pole-lists-the-checks-and-does-not-warn",
  "the verifiable notice lists the contexts and carries NO refusal/warning language",
  () => {
    const text = formatVerifiabilityNotice(
      "o/r",
      "main",
      v({ status: "ok", protection: { required_status_checks: { contexts: ["validate"] } } }),
      { merging: false },
    );
    return (
      (text.includes("[verifiable]") &&
        text.includes("validate") &&
        !text.includes("NO required status check") &&
        !text.includes("REFUSING")) ||
      `unexpected verifiable-pole notice: ${JSON.stringify(text)}`
    );
  },
);

// ── The verdict is RECORDED, so a later audit need not re-probe. ──────────────
check(
  "receipt/records-the-verdict",
  "buildReceipt carries target_verifiability, and defaults it to null when none was probed",
  () => {
    const base = {
      lane: "build",
      target: "prism",
      baseSha: "a".repeat(40),
      worktree: "/tmp/wt",
      branch: "sync/x",
      manifest: { added: [], modified: [], deleted: [] },
      prUrl: "https://example/pr/1",
      mergeSha: null,
      loomSha: "b".repeat(40),
      timestamp: "2026-08-16T00:00:00Z",
    };
    const withV = buildReceipt({ ...base, targetVerifiability: v({ status: "not-found" }) });
    const without = buildReceipt(base);
    return (
      (withV.target_verifiability &&
        withV.target_verifiability.verdict === "unverifiable" &&
        Object.prototype.hasOwnProperty.call(without, "target_verifiability") &&
        without.target_verifiability === null) ||
      `withV=${JSON.stringify(withV.target_verifiability)} without=${JSON.stringify(without.target_verifiability)}`
    );
  },
);

// ── The waiver is only grantable where it means something. ────────────────────
check(
  "args/waiver-rejected-without-merge",
  "--accept-unverified-target without --merge is a LOUD parse error, not a silent no-op",
  () => {
    try {
      parseArgs(["node", "x", "--lane", "build", "--target", "prism", "--accept-unverified-target"]);
      return "parseArgs accepted the waiver on a path where it waives nothing";
    } catch (e) {
      return /only valid with --merge/.test(e.message) || `wrong error: ${e.message}`;
    }
  },
);

check(
  "args/waiver-accepted-with-merge",
  "--accept-unverified-target --merge parses and sets the flag",
  () => {
    const a = parseArgs([
      "node", "x", "--lane", "build", "--target", "prism", "--merge", "--accept-unverified-target",
    ]);
    return (a.acceptUnverifiedTarget === true && a.merge === true) || JSON.stringify(a);
  },
);

// ── SOURCE PINS — a classifier nothing calls is the un-gated shape itself. ────
check(
  "wiring/probe-is-called-before-the-commit",
  "commitPushPrMaybeMerge probes verifiability BEFORE stageBranchCommit (no push side effect first)",
  () => {
    const src = fs.readFileSync(DRIVER, "utf8");
    const fn = src.slice(src.indexOf("function commitPushPrMaybeMerge"));
    const iProbe = fn.indexOf("classifyTargetVerifiability(");
    const iCommit = fn.indexOf("stageBranchCommit(");
    if (iProbe < 0) return "commitPushPrMaybeMerge does not call classifyTargetVerifiability";
    if (iCommit < 0) return "commitPushPrMaybeMerge no longer calls stageBranchCommit — re-derive this pin";
    return iProbe < iCommit || `probe at ${iProbe} runs AFTER stageBranchCommit at ${iCommit}`;
  },
);

check(
  "wiring/auto-merge-refuses-on-non-verifiable",
  'the --merge branch refuses unless verdict === "verifiable" or the waiver is set',
  () => {
    const src = fs.readFileSync(DRIVER, "utf8");
    const needle = 'verifiability.verdict !== "verifiable" && !args.acceptUnverifiedTarget';
    if (!src.includes(needle))
      return `driver no longer carries the refusal predicate ${JSON.stringify(needle)}`;
    // The refusal must sit INSIDE the merge branch and BEFORE the gh pr merge call.
    const iMerge = src.indexOf("if (args.merge) {");
    const iRefuse = src.indexOf(needle, iMerge);
    const iGhMerge = src.indexOf('"pr", "merge"', iMerge);
    return (
      (iMerge >= 0 && iRefuse > iMerge && iGhMerge > iRefuse) ||
      `merge=${iMerge} refuse=${iRefuse} ghMerge=${iGhMerge}`
    );
  },
);

const total = pass + failures.length;
console.log(`\ngate2-target-verifiability: ${pass}/${total} PASS`);
if (failures.length > 0) {
  console.log(`FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
