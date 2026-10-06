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
import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
  // loom#1750 — the distributed verifier half.
  emitCiVerifier,
  // The owned_surfaces election (co-owner ratified 2026-08-29). DEFAULT OFF.
  ciVerifierElected,
  assertWriteContainedIn,
  landedInTree,
  reconcileSuppressedWrite,
  formatCiVerifierReport,
  ciVerifierOnBase,
  ciVerifierRegistrationCommand,
  CI_VERIFIER_CONTEXT,
  CI_VERIFIER_TARGET_PATH,
  CI_VERIFIER_OPTOUT_PATH,
  // loom#1760 correctness round.
  isInvokedAsMain,
} = await import(DRIVER);

// The ENGINE's parser, imported so the F1 poles can assert WHICH LEVEL a planted
// election reached. Read from the same tree as DRIVER — asserting against a parser
// other than the one the driver consumes would be two instruments answering two
// questions (`instrument-discipline.md` MUST-4).
const { parseRepos } = await import(
  path.join(path.dirname(DRIVER), "sync-tier-aware.mjs")
);

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

// ═════════════════════════════════════════════════════════════════════════════
//  loom#1750 — THE DISTRIBUTED VERIFIER AND THE `unregistered` TIER
//
//  #1745 (every case above) made an unverifiable target LOUD. It could not make
//  one verifiABLE, because loom shipped no verifier — so the refusal was
//  unsatisfiable by construction and every new target repeated the gap.
//
//  WHAT WOULD BE OBSERVED IF THIS FIX DID NOT WORK, named before the cases are
//  read (`instrument-discipline.md` MUST-1):
//    - a Gate-2 worktree with no `.github/workflows/coc-artifact-validate.yml`;
//    - a not-verifiable verdict that still reads `unverifiable` with the
//      verifier sitting in the tree, i.e. an operator told to author a file
//      that already exists;
//    - the mirror failure, and the one that matters more: `unregistered`
//      appearing where NOTHING is known — an errored probe upgraded on the
//      strength of a file, which would be a positive claim about protection
//      state that no probe supported;
//    - a target's own workflow gone after a distribution.
//  Each of those has a case below, and each case FAILS on the naive
//  implementation that produces it.
// ═════════════════════════════════════════════════════════════════════════════

const TEMPLATE_ABS = path.join(REPO_ROOT, ".claude", "ci-templates", "coc-artifact-validate.yml");

/** Throwaway target tree. Returned path is removed by the caller. */
function mkTargetTree() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "gate2-civ-"));
  fs.mkdirSync(path.join(t, ".github", "workflows"), { recursive: true });
  fs.mkdirSync(path.join(t, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(t, ".github", "workflows", "ci-web.yml"), "name: target-owned\n");
  return t;
}
function rmTree(t) {
  fs.rmSync(t, { recursive: true, force: true });
}

// ── The tier itself, BIPOLAR. Each case is paired with the state it must NOT
//    be confused with, so an implementation hardwired to either pole reds. ────

check(
  "unregistered/no-protection-with-verifier-shipping-now",
  "an unprotected target that is RECEIVING the verifier in this distribution classifies unregistered/verifier-shipping-this-distribution",
  () => {
    const r = classifyTargetVerifiability({ status: "not-found" }, { present: true, shippingNow: true });
    return (
      (r.verdict === "unregistered" &&
        r.reason === "verifier-shipping-this-distribution" &&
        r.protection_reason === "no-branch-protection" &&
        r.required_context === CI_VERIFIER_CONTEXT) ||
      JSON.stringify(r)
    );
  },
);

check(
  "unregistered/empty-contexts-with-verifier-already-landed",
  "a target whose verifier landed in a PRIOR distribution gets the register-NOW reason, not the merge-first one",
  () => {
    const r = classifyTargetVerifiability(
      { status: "ok", protection: { required_status_checks: { contexts: [] } } },
      { present: true, shippingNow: false },
    );
    return (
      (r.verdict === "unregistered" &&
        r.reason === "verifier-present-check-unregistered" &&
        r.protection_reason === "required-status-checks-empty") ||
      JSON.stringify(r)
    );
  },
);

check(
  "unregistered/does-NOT-upgrade-an-unknown-verdict",
  "an ERRORED probe stays unknown even with the verifier present — a file is not evidence about protection state",
  () => {
    const r = classifyTargetVerifiability(
      { status: "error", detail: "HTTP 403" },
      { present: true, shippingNow: false },
    );
    return (
      (r.verdict === "unknown" && r.reason === "protection-probe-errored") ||
      `an errored probe was upgraded to ${r.verdict}/${r.reason} on the strength of a FILE — ` +
        `that is a positive claim about protection state the probe never made`
    );
  },
);

check(
  "unregistered/verifiable-is-unaffected-by-the-verifier-argument",
  "a target that IS registered stays verifiable whether or not the verifier is present",
  () => {
    const p = { status: "ok", protection: { required_status_checks: { contexts: ["COC required checks"] } } };
    const without = classifyTargetVerifiability(p);
    const with_ = classifyTargetVerifiability(p, { present: true, shippingNow: true });
    return (
      (without.verdict === "verifiable" && with_.verdict === "verifiable") ||
      `without=${without.verdict} with=${with_.verdict}`
    );
  },
);

check(
  "unregistered/default-argument-preserves-the-1745-verdicts",
  "called with ONE argument the classifier is byte-identical to its pre-#1750 self (every case above depends on this)",
  () => {
    const r = classifyTargetVerifiability({ status: "not-found" });
    return (
      (r.verdict === "unverifiable" && r.reason === "no-branch-protection" && !("protection_reason" in r)) ||
      JSON.stringify(r)
    );
  },
);

check(
  "unregistered/still-refuses-auto-merge",
  "the new tier changes the REMEDY, never the decision — the --merge refusal predicate still catches it",
  () => {
    const r = classifyTargetVerifiability({ status: "not-found" }, { present: true, shippingNow: true });
    const src = fs.readFileSync(DRIVER, "utf8");
    const needle = 'verifiability.verdict !== "verifiable" && !args.acceptUnverifiedTarget';
    if (!src.includes(needle)) return `driver no longer carries the refusal predicate ${JSON.stringify(needle)}`;
    return (
      r.verdict !== "verifiable" ||
      `verdict ${r.verdict} would PASS the refusal predicate — an unregistered check gates nothing`
    );
  },
);

check(
  "unregistered/notice-hands-over-the-registration-command",
  "the operator-facing notice names the exact context AND the gh command, so the remedy is executable, not described",
  () => {
    const r = classifyTargetVerifiability({ status: "not-found" }, { present: true, shippingNow: false });
    const n = formatVerifiabilityNotice("acme/thing", "main", r, { merging: true });
    return (
      (n.includes(CI_VERIFIER_CONTEXT) &&
        n.includes("repos/acme/thing/branches/main/protection") &&
        n.includes("required_status_checks[contexts][]") &&
        /REFUSING the auto-merge/.test(n)) ||
      n
    );
  },
);

// ── THE EMITTER. Preserve semantics are STRUCTURAL here: the assertion is not
//    "the preserve list covered it" but "the sibling file is still there". ────

check(
  "emit/writes-the-one-loom-owned-path",
  "a first distribution creates .github/workflows/coc-artifact-validate.yml from the loom template",
  () => {
    const t = mkTargetTree();
    try {
      const rep = emitCiVerifier(REPO_ROOT, t, { elected: true });
      const dest = path.join(t, CI_VERIFIER_TARGET_PATH);
      return (
        (rep.action === "written" &&
          rep.preexisting === false &&
          rep.shippingNow === true &&
          rep.present === true &&
          fs.existsSync(dest) &&
          fs.readFileSync(dest, "utf8") === fs.readFileSync(TEMPLATE_ABS, "utf8")) ||
        JSON.stringify(rep)
      );
    } finally {
      rmTree(t);
    }
  },
);

check(
  "emit/preserves-a-target-owned-workflow",
  "a sibling workflow the target authored survives the distribution byte-identical",
  () => {
    const t = mkTargetTree();
    try {
      emitCiVerifier(REPO_ROOT, t, { elected: true });
      const sibling = path.join(t, ".github", "workflows", "ci-web.yml");
      const names = fs.readdirSync(path.join(t, ".github", "workflows")).sort();
      return (
        (fs.readFileSync(sibling, "utf8") === "name: target-owned\n" &&
          names.join(",") === "ci-web.yml,coc-artifact-validate.yml") ||
        `sibling=${fs.existsSync(sibling)} names=${names.join(",")}`
      );
    } finally {
      rmTree(t);
    }
  },
);

check(
  "emit/second-run-is-unchanged-not-rewritten",
  "re-distributing an identical template reports `unchanged` (so the Gate-2 manifest does not churn)",
  () => {
    const t = mkTargetTree();
    try {
      emitCiVerifier(REPO_ROOT, t, { elected: true });
      const rep = emitCiVerifier(REPO_ROOT, t, { elected: true });
      return (rep.action === "unchanged" && rep.present === true) || JSON.stringify(rep);
    } finally {
      rmTree(t);
    }
  },
);

check(
  "emit/optout-marker-writes-nothing",
  "a target declaring .claude/coc-validate.optout receives NO workflow and the skip is reported, not silent",
  () => {
    const t = mkTargetTree();
    try {
      fs.writeFileSync(path.join(t, CI_VERIFIER_OPTOUT_PATH), "we run our own gate\n");
      const rep = emitCiVerifier(REPO_ROOT, t, { elected: true });
      const wrote = fs.existsSync(path.join(t, CI_VERIFIER_TARGET_PATH));
      const msg = formatCiVerifierReport(rep);
      return (
        (rep.action === "opted-out" && wrote === false && /SKIPPED/.test(msg)) ||
        `action=${rep.action} wrote=${wrote}`
      );
    } finally {
      rmTree(t);
    }
  },
);

check(
  "emit/optout-does-not-manufacture-a-verifier",
  "opting out reports present=false when no verifier was ever there — so the verdict stays `unverifiable`, not `unregistered`",
  () => {
    const t = mkTargetTree();
    try {
      fs.writeFileSync(path.join(t, CI_VERIFIER_OPTOUT_PATH), "x\n");
      const rep = emitCiVerifier(REPO_ROOT, t, { elected: true });
      const verdict = classifyTargetVerifiability({ status: "not-found" }, rep);
      return (
        (rep.present === false && verdict.verdict === "unverifiable") ||
        `present=${rep.present} verdict=${verdict.verdict} — an opt-out claimed a gate exists`
      );
    } finally {
      rmTree(t);
    }
  },
);

check(
  "emit/refuses-a-template-whose-context-name-drifted",
  "if the template's aggregator job name stops matching CI_VERIFIER_CONTEXT the emit THROWS rather than shipping a command that arms a context nothing reports",
  () => {
    const fakeLoom = fs.mkdtempSync(path.join(os.tmpdir(), "gate2-loom-"));
    const t = mkTargetTree();
    try {
      const dir = path.join(fakeLoom, ".claude", "ci-templates");
      fs.mkdirSync(dir, { recursive: true });
      const drifted = fs
        .readFileSync(TEMPLATE_ABS, "utf8")
        .replace(`name: "${CI_VERIFIER_CONTEXT}"`, 'name: "Some Other Name"');
      fs.writeFileSync(path.join(dir, "coc-artifact-validate.yml"), drifted);
      try {
        emitCiVerifier(fakeLoom, t, { elected: true });
        return "a drifted template emitted silently";
      } catch (e) {
        return /does not declare a job named/.test(e.message) || `wrong error: ${e.message}`;
      }
    } finally {
      rmTree(fakeLoom);
      rmTree(t);
    }
  },
);

check(
  "emit/missing-template-refuses-the-distribution",
  "a loom tree with no verifier template THROWS — distributing a corpus with no means of validating it is the #1750 defect itself",
  () => {
    const fakeLoom = fs.mkdtempSync(path.join(os.tmpdir(), "gate2-loom-"));
    const t = mkTargetTree();
    try {
      emitCiVerifier(fakeLoom, t, { elected: true });
      return "a missing template was tolerated";
    } catch (e) {
      return /verifier template is missing/.test(e.message) || `wrong error: ${e.message}`;
    } finally {
      rmTree(fakeLoom);
      rmTree(t);
    }
  },
);

// ── GIT-TRUTH vs FILESYSTEM-TRUTH. This pair is the sharpest in the #1750 set:
//    on the --finalize path the file IS in the tree (a prior --stage-only wrote
//    it), so a filesystem read answers a DIFFERENT question and silently
//    downgrades a first-ever delivery to "already landed, register now"
//    (`instrument-discipline.md` MUST-4). ────────────────────────────────────

check(
  "onbase/reads-the-commit-not-the-working-tree",
  "a file present in the WORKING TREE but absent from the BASE COMMIT reports onBase=false while fs.existsSync says true",
  () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), "gate2-git-"));
    try {
      const g = (...a) => execFileSync("git", ["-C", t, ...a], { stdio: ["ignore", "pipe", "pipe"] });
      g("init", "-q");
      g("config", "user.email", "f@x");
      g("config", "user.name", "f");
      fs.writeFileSync(path.join(t, "README.md"), "base\n");
      g("add", "README.md");
      g("commit", "-q", "-m", "base");
      const baseSha = String(g("rev-parse", "HEAD")).trim();
      emitCiVerifier(REPO_ROOT, t, { elected: true });
      const fsSays = fs.existsSync(path.join(t, CI_VERIFIER_TARGET_PATH));
      const gitSays = ciVerifierOnBase(t, baseSha);
      return (
        (fsSays === true && gitSays === false) ||
        `fs=${fsSays} git=${gitSays} — the two must disagree here, or --finalize cannot tell a first delivery from a refresh`
      );
    } finally {
      rmTree(t);
    }
  },
);

check(
  "onbase/errored-probe-returns-null-never-false",
  "a bogus base sha returns null (unknown), NOT false — false is the positive claim 'first delivery'",
  () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), "gate2-git-"));
    try {
      const r = ciVerifierOnBase(t, "0000000000000000000000000000000000000000");
      return r === null || `returned ${JSON.stringify(r)} from a tree that is not a git repo`;
    } finally {
      rmTree(t);
    }
  },
);

// ── THE DISTRIBUTED TEMPLATE'S OWN CONTRACT (loom#1567). A required context
//    that is never REPORTED pins every PR at "Expected — waiting for status",
//    with no admin override. These pin the four keys that cause it. ──────────

/** The `on:` block as TEXT — read as text, not through a parser, so it is scoped to the arm. */
function prArmBlock() {
  const src = fs.readFileSync(TEMPLATE_ABS, "utf8");
  const i = src.indexOf("\n  pull_request:");
  const j = src.indexOf("\n  merge_group:", i);
  return src.slice(i, j);
}

check(
  "template/pr-arm-carries-no-subtracting-filter",
  "the pull_request arm has no paths:/paths-ignore:/branches-ignore: — one would stop the workflow instantiating and the required context would never report",
  () => {
    const arm = prArmBlock();
    const bad = /^\s*"?(paths|paths-ignore|branches-ignore)"?\s*:/m.exec(arm);
    return bad === null || `pull_request arm carries ${bad[1]}: — this bricks the repo's merge gate`;
  },
);

check(
  "template/pr-arm-pins-branches-main",
  "the pull_request arm positively names main; narrowing it is the same brick reached by a different key",
  () => {
    const arm = prArmBlock();
    return /branches:\s*\[main\]/.test(arm) || `pull_request arm branches: is ${JSON.stringify(arm.slice(0, 200))}`;
  },
);

check(
  "template/carries-a-merge-group-arm",
  "without merge_group a queued candidate never instantiates the workflow and every queued merge hangs",
  () => {
    const src = fs.readFileSync(TEMPLATE_ABS, "utf8");
    return /^  merge_group:\s*$/m.test(src) || "no merge_group arm";
  },
);

check(
  "template/cost-filter-lives-on-the-push-arm-only",
  "the cost-saving paths: filter is on push:, which is the arm branch protection does NOT read",
  () => {
    const src = fs.readFileSync(TEMPLATE_ABS, "utf8");
    const i = src.indexOf("\n  push:");
    const j = src.indexOf("\n  workflow_dispatch:", i);
    const arm = src.slice(i, j);
    return /paths:/.test(arm) || "the push arm carries no paths: filter — the stated cost saving does not exist";
  },
);

check(
  "template/aggregator-is-always-and-admits-merge-group",
  "the required-context job runs with always() on BOTH pull_request and merge_group, so protection never scores a `skipped`",
  () => {
    const src = fs.readFileSync(TEMPLATE_ABS, "utf8");
    const i = src.indexOf("  coc-required-checks:");
    if (i < 0) return "the aggregator job is gone";
    const block = src.slice(i, i + 2000);
    return (
      (/if:\s*always\(\)/.test(block) &&
        /github\.event_name == 'pull_request'/.test(block) &&
        /github\.event_name == 'merge_group'/.test(block)) ||
      "the aggregator's if: no longer admits both events under always()"
    );
  },
);

check(
  "template/aggregator-job-name-IS-the-registered-context",
  "the job name and CI_VERIFIER_CONTEXT are the same string — a rename silently un-registers the gate",
  () => {
    const src = fs.readFileSync(TEMPLATE_ABS, "utf8");
    return (
      src.includes(`name: "${CI_VERIFIER_CONTEXT}"`) ||
      `the template declares no job named ${JSON.stringify(CI_VERIFIER_CONTEXT)}`
    );
  },
);

check(
  "template/unrecognised-outcome-reds",
  "the aggregator enumerates every outcome and its default branch FAILS — an unknown result must never resolve to green",
  () => {
    const src = fs.readFileSync(TEMPLATE_ABS, "utf8");
    const i = src.indexOf('case "$VALIDATE_RESULT" in');
    if (i < 0) return "the aggregator no longer dispatches on the validator's result";
    const block = src.slice(i, src.indexOf("esac", i));
    return (
      (/success\)[^\n]*exit 0/.test(block) &&
        /failure\)[^\n]*exit 1/.test(block) &&
        /cancelled\)[^\n]*exit 1/.test(block) &&
        /skipped\)[^\n]*exit 1/.test(block) &&
        /\*\)[^\n]*exit 1/.test(block)) ||
      "an outcome branch is missing or resolves to green"
    );
  },
);

check(
  "template/validator-absence-is-a-RED-not-a-silent-pass",
  "if the shipped validator is missing the job FAILS — a gate that executes nothing passes every input, including the ones it exists to catch",
  () => {
    const src = fs.readFileSync(TEMPLATE_ABS, "utf8");
    return (
      (/if \[ "\$ran" -eq 0 \]; then/.test(src) &&
        /validate-emit\.mjs is ABSENT/.test(src) &&
        /failed=\$\(\(failed \+ 1\)\)/.test(src)) ||
      "the no-validator-ran floor is gone; the workflow can now report green having run nothing"
    );
  },
);

// ── WIRING. A perfect emitter nothing calls is the un-gated shape itself. ────

check(
  "wiring/emitter-runs-before-the-single-shot-manifest-capture",
  "emitCiVerifier is called before parseManifest, so the workflow rides the SAME commit as the corpus it validates",
  () => {
    // SCOPED to the single-shot section, and that scoping is the whole check.
    // MEASURED: the unscoped form searched the WHOLE file, so its first hit was
    // the FINALIZE path's emit — it then passed with the single-shot call
    // deleted (mutation applied, `cmp` differed, 48/48 still green) AND with the
    // finalize call deleted, reddening only when BOTH were gone. A pin that
    // cannot return the other answer for the property in its own NAME is not
    // evidence for it (`instrument-discipline.md` MUST-1/MUST-2).
    const src = fs.readFileSync(DRIVER, "utf8");
    const start = src.indexOf("// ── Mode: single-shot");
    const single = start < 0 ? "" : src.slice(start);
    const i = single.indexOf("const ciVerifier = emitCiVerifier(");
    const j = single.indexOf("const manifest = parseManifest(", i);
    return (
      (start > 0 && i > 0 && j > i) ||
      `single-shot section at ${start}, emit at ${i}, manifest capture at ${j} — a corpus that arrives one PR ahead of its gate landed ungated`
    );
  },
);

check(
  "wiring/finalize-re-emits-into-the-enriched-worktree",
  "--finalize re-emits: enrichment is an arbitrary agent write and can clobber or delete the verifier between stage and finalize",
  () => {
    const src = fs.readFileSync(DRIVER, "utf8");
    const fin = src.slice(src.indexOf("if (args.finalize) {"), src.indexOf("// ── Mode: single-shot"));
    return (
      (fin.includes("emitCiVerifier(") && fin.includes("ciVerifierOnBase(")) ||
      "the finalize path does not re-emit, so a clobbered verifier ships as a corpus with no gate"
    );
  },
);

check(
  "wiring/verdict-reads-the-emitter-record-not-a-second-derivation",
  "commitPushPrMaybeMerge passes the emitter's own record into the classifier, so verdict and file cannot disagree",
  () => {
    const src = fs.readFileSync(DRIVER, "utf8");
    const fn = src.slice(src.indexOf("function commitPushPrMaybeMerge"));
    return (
      /classifyTargetVerifiability\(\s*probeTargetProtection\([^)]*\),\s*verifier,/.test(fn) ||
      "the classifier is not receiving the emitter's record"
    );
  },
);

check(
  "wiring/receipt-records-what-the-distribution-did-about-the-verifier",
  "buildReceipt carries ci_verifier, so a later audit can tell an arriving verifier from a long-present unarmed one",
  () => {
    const r = buildReceipt({
      lane: "build",
      target: "prism",
      baseSha: "a".repeat(40),
      worktree: "/tmp/x",
      branch: "b",
      manifest: { added: [], modified: [], deleted: [] },
      prUrl: null,
      mergeSha: null,
      loomSha: "b".repeat(40),
      timestamp: "t",
      ciVerifier: { action: "written", preexisting: false, present: true, shippingNow: true },
    });
    return (
      (r.ci_verifier && r.ci_verifier.action === "written" && r.ci_verifier.shippingNow === true) ||
      JSON.stringify(r.ci_verifier)
    );
  },
);

check(
  "wiring/registration-command-sends-every-boolean-through-the-TYPED-flag",
  "no boolean rides `-f` (--raw-field, a STRING) while its siblings use `-F` (--field, typed) — loom#1760 MED-2",
  () => {
    const cmd = ciVerifierRegistrationCommand("acme/thing", "main");
    // `-f` is legitimate for genuine strings (the context NAME is one), so this
    // does not ban the flag — it bans it for values that are booleans or null.
    const rawBooleans = (cmd.match(/-f\s+'[^']*=(true|false|null)'/g) || []);
    // Control: the matcher must be able to FIRE on the shape it exists to catch.
    if (!/-f\s+'[^']*=(true|false|null)'/.test("-f 'required_status_checks[strict]=false'"))
      return "the matcher cannot detect the defect it exists to catch";
    return (
      rawBooleans.length === 0 ||
      `${rawBooleans.length} boolean/null value(s) sent via the STRING flag: ${rawBooleans.join(", ")}`
    );
  },
);

check(
  "wiring/the-template-comment-mirrors-the-driver-registration-command",
  "the template's copied command does not drift from the driver's — an operator reads whichever is nearer",
  () => {
    const tpl = fs.readFileSync(TEMPLATE_ABS, "utf8");
    const stray = (tpl.match(/^#\s+-f\s+'[^']*=(true|false|null)'/gm) || []);
    if (!/^#\s+-f\s+'[^']*=(true|false|null)'/m.test("#      -f 'required_status_checks[strict]=false' \\"))
      return "the matcher cannot detect the defect it exists to catch";
    return (
      stray.length === 0 ||
      `the template comment still sends ${stray.length} boolean(s) via -f: ${stray.map((s) => s.trim()).join(", ")}`
    );
  },
);

// INSTRUMENT GAP, recorded where the next reader of this suite will find it
// (loom#1760 MED-2, second half). The pin BELOW asserts that the registration
// command NAMES the right context and endpoint. It was built for "does it name
// the right thing?" and is easy to read as evidence for "is the remedy
// EXECUTABLE?" — which `sync-completeness.md` explicitly claims ("executable,
// not described") and which NOTHING in this suite measures. That command is the
// single remedy the whole `unregistered` tier hands the operator, so the gap
// matters: the `-f`/`-F` defect above lived inside a command this pin called
// green, and would have kept living there. Closing it needs a live `gh api`
// write against a repo loom does not own, which `repo-scope-discipline.md` puts
// outside this suite — so the honest state is UNMEASURED, named here rather
// than implied by an adjacent green (`instrument-discipline.md` MUST-4).
check(
  "wiring/registration-command-names-the-registered-context",
  "the rendered command arms exactly CI_VERIFIER_CONTEXT against the named repo",
  () => {
    const cmd = ciVerifierRegistrationCommand("acme/thing", "main");
    return (
      (cmd.includes(`required_status_checks[contexts][]=${CI_VERIFIER_CONTEXT}`) &&
        cmd.includes("repos/acme/thing/branches/main/protection")) ||
      cmd
    );
  },
);

// ── CALL-SITE pins (loom#1760 MED-3 + HIGH-1). ───────────────────────────────
//
// WHY THESE EXIST, stated as the defect they close. Every pin above this block
// that claims something about a MODE is a grep over source TEXT, and the two
// argument-passing claims were not grepped at all: the receipt pin above calls
// `buildReceipt` DIRECTLY with a hand-built record, so it tests the FUNCTION and
// was read as evidence about the CALL SITE. MEASURED: deleting `verifier:
// ciVerifier` from the single-shot `commitPushPrMaybeMerge` call left the suite
// 48/48 PASS, and so did deleting `ciVerifier` from the single-shot
// `buildReceipt` call. Two silent holes behind a green.
//
// SCOPE, honestly: these pins close those specific holes and the HIGH-1 root
// anchoring. They do NOT close the structural root cause, which is that NO case
// in this suite executes `main()` — every mode-wiring claim here is still source
// text, and a pin can only assert what someone thought to grep. A behavioural
// fixture driving `main()` end-to-end is the real fix and is NOT in this change.
//
// Each region slice is GUARDED against the -1 hole: a missing marker makes
// `indexOf` return -1 and `slice(-1)` silently returns the LAST CHARACTER, on
// which every `.includes()` is false — that would red, not falsely pass, but it
// would red for the wrong reason and read as a real finding. Name the marker.
function regionOrFail(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) return { err: `region start marker not found: ${startMarker}` };
  let text;
  if (!endMarker) {
    text = src.slice(i);
  } else {
    const j = src.indexOf(endMarker, i);
    if (j < 0) return { err: `region end marker not found: ${endMarker}` };
    text = src.slice(i, j);
  }
  // Markers are located in the RAW source (they ARE comments), then comments are
  // stripped from the slice, because every pin below searches for CODE. Without
  // this, prose naming a construct is counted as an instance of it — MEASURED on
  // this very file: a comment listing `buildReceipt({` among the tokens it
  // discusses was counted as a fifth single-shot call site, omitting ciVerifier,
  // i.e. a FALSE finding manufactured by an explanatory comment. LINE comments
  // first, then block: a `//` line containing block-open characters otherwise
  // opens a phantom block and deletes real code (the 6,036-character swallow
  // this suite's sibling test file had to fix).
  return { text: text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "") };
}
const FINALIZE = ["if (args.finalize) {", "// ── Mode: single-shot"];
// BOUNDED at the closing marker, not left open to EOF (loom#1760 LOW-1). An
// open region silently swept everything below `main()` into "single-shot", so a
// helper added down there could satisfy — or break — a pin about a mode it has
// nothing to do with. `regionOrFail` names a missing end marker rather than
// falling back to EOF, so removing the marker reds loudly instead of quietly
// widening every single-shot pin.
const SINGLE_SHOT = ["// ── Mode: single-shot", "// ── /Mode: single-shot"];

for (const [mode, [startM, endM]] of [
  ["finalize", FINALIZE],
  ["single-shot", SINGLE_SHOT],
]) {
  check(
    `wiring/${mode}-passes-the-emitter-record-to-the-pr-path`,
    `the ${mode} commitPushPrMaybeMerge call passes verifier: ciVerifier — without it the classifier silently re-derives`,
    () => {
      const r = regionOrFail(fs.readFileSync(DRIVER, "utf8"), startM, endM);
      if (r.err) return r.err;
      return (
        /commitPushPrMaybeMerge\(\{[\s\S]{0,400}?verifier:\s*ciVerifier[\s\S]{0,200}?\}\)/.test(r.text) ||
        `the ${mode} PR path does not receive the emitter's record`
      );
    },
  );

  check(
    `wiring/${mode}-receipt-call-site-passes-the-verifier-record`,
    `the ${mode} buildReceipt CALL SITE passes ciVerifier — the sibling pin above proves only that the FUNCTION stores it`,
    () => {
      const r = regionOrFail(fs.readFileSync(DRIVER, "utf8"), startM, endM);
      if (r.err) return r.err;
      const calls = r.text.split("buildReceipt({").slice(1);
      if (calls.length === 0) return `no buildReceipt call site in the ${mode} region`;
      // Bound each window at the call's OWN closing `})`, never a fixed char
      // count. MEASURED while writing this pin: a `slice(0, 400)` window ran
      // PAST the finalize early-return receipt and into the adjacent
      // `commitPushPrMaybeMerge({ …, verifier: ciVerifier })`, so deleting the
      // field from the receipt left the pin GREEN — the first-hit/over-wide
      // window bug this very suite exists to catch, committed inside the fix
      // for it. A window that can see a neighbour's argument is not evidence
      // about this call (`instrument-discipline.md` MUST-1).
      //
      // SECOND correction, same class, also measured: with the window bounded,
      // the pin STILL stayed green when the field was deleted from the finalize
      // receipt — because the explanatory COMMENT inside that call's argument
      // list contains the word `ciVerifier`, and a bare `\bciVerifier\b` cannot
      // tell prose from code. So: strip line comments, THEN require the
      // shorthand-property FORM (`ciVerifier` terminated by `,` or `}`), which
      // a sentence like "ciVerifier rides even the no-op receipt" does not
      // satisfy. Two windows and two matchers had to be corrected here before
      // this pin could return the other answer; that is the cost of a lexical
      // instrument, recorded rather than smoothed over.
      const argsOf = (c) => {
        const end = c.indexOf(" })");
        return (end < 0 ? "" : c.slice(0, end)).replace(/\/\/[^\n]*/g, "");
      };
      const bad = calls.filter((c) => !/(?:^|[\s,{])ciVerifier\s*(?:,|\}|$)/m.test(argsOf(c)));
      return (
        bad.length === 0 ||
        `${bad.length} of ${calls.length} ${mode} buildReceipt call site(s) omit ciVerifier`
      );
    },
  );

  check(
    `emit/${mode}-reads-the-fence-scanned-root-not-the-cwd`,
    `the ${mode} emitCiVerifier call passes LOOM_ROOT — a process.cwd() anchor copies a template fence A never scanned (loom#1760 HIGH-1)`,
    () => {
      const r = regionOrFail(fs.readFileSync(DRIVER, "utf8"), startM, endM);
      if (r.err) return r.err;
      const m = r.text.match(/emitCiVerifier\(\s*([A-Za-z_.()]+)\s*,/);
      if (!m) return `no emitCiVerifier call in the ${mode} region`;
      return (
        m[1] === "LOOM_ROOT" ||
        `${mode} emitCiVerifier is anchored at ${m[1]}, not LOOM_ROOT — fence A scans LOOM_ROOT, and .github/** is on no scanner surface, so nothing downstream re-checks the emitted file`
      );
    },
  );
}

// ── BEHAVIOURAL pins for the two HIGH fixes. Source greps cannot show a refusal
//    actually happening; these call the real exported function.
check(
  "template/both-jobs-carry-a-bounded-timeout",
  "every job declares timeout-minutes — an unservable runner label must RED, not queue forever (loom#1760 MED-2)",
  () => {
    const tpl = fs.readFileSync(TEMPLATE_ABS, "utf8");
    const jobs = (tpl.match(/^ {4}runs-on:/gm) || []).length;
    const timeouts = (tpl.match(/^ {4}timeout-minutes:\s*\d+/gm) || []).length;
    if (jobs === 0) return "no jobs found — the matcher is not firing on this template";
    return (
      jobs === timeouts ||
      `${jobs} job(s) declare runs-on but only ${timeouts} declare timeout-minutes; an unservable ` +
        `COC_VALIDATE_RUNNER label leaves the required context QUEUED, which with enforce_admins ` +
        `on is the permanent-"Expected" state this file exists to prevent`
    );
  },
);

check(
  "template/pinned-actions-are-40-hex-shas-not-floating-tags",
  "every `uses:` names an immutable commit — this file reaches every target at once, so a tag repoint moves the whole fleet",
  () => {
    const tpl = fs.readFileSync(TEMPLATE_ABS, "utf8");
    const uses = tpl.match(/^\s*-?\s*uses:\s*\S+/gm) || [];
    if (uses.length === 0) return "no `uses:` lines found — the matcher is not firing on this template";
    const floating = uses.filter((u) => !/@[0-9a-f]{40}\b/.test(u));
    return (
      floating.length === 0 ||
      `${floating.length} action(s) pinned to a mutable ref: ${floating.map((u) => u.trim()).join(", ")}`
    );
  },
);

check(
  "emit/refuses-a-write-that-escapes-the-target-root",
  "a target committing .github as a symlink out of the tree is REFUSED, and nothing lands outside (loom#1760 HIGH-2)",
  () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "gate2-escape-"));
    const scratch = path.join(base, "target");
    const outside = path.join(base, "OUTSIDE");
    fs.mkdirSync(scratch);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(scratch, ".github"));
    let refused = false;
    try {
      emitCiVerifier(REPO_ROOT, scratch, { elected: true, onBase: false });
    } catch {
      refused = true;
    }
    const escaped = fs.existsSync(path.join(outside, "workflows", "coc-artifact-validate.yml"));
    return (
      (refused && !escaped) ||
      `refused=${refused} escapedFileExistsOutsideTarget=${escaped} — a lexical join lands this write outside the repo`
    );
  },
);

// ── The DANGLING poles (loom#1760 second pass). ──────────────────────────────
//
// The case above builds its escape target with `mkdirSync(outside)` BEFORE
// symlinking, so it only ever exercised the EXISTING-target pole — and a
// resolver that decides "exists" by whether `realpathSync` throws classifies a
// DANGLING link as nonexistent, walks PAST it, and re-attaches the tail
// LEXICALLY, producing exactly the path the guard rejects. `writeFileSync` then
// follows the link. MEASURED on the code before this fix: dangling leaf →
// `action="written"` with 15231 bytes landing outside the target root, while
// both EXISTING poles correctly REFUSED. The suite was 58/58 green on a branch
// that escaped: the no-false-positive control passed, which is what made the
// green look earned, while the instrument could not SEE the failing class
// (`evidence-first-claims.md` MUST-6 — a green generalized past the class its
// instrument could observe).
//
// A dangling symlink is REACHABLE, not theoretical: git stores a symlink as
// mode 120000 with no special-casing of the `.github` name, so a target repo
// can COMMIT one whose target does not exist, checkout materialises it
// dangling, and the Gate-2 scratch is a worktree of that repo. The attacker
// controls the PATH; loom controls the CONTENT.
function escapePole(name, build) {
  check(name, "the write is REFUSED and nothing lands outside the target root", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "gate2-escape-"));
    const scratch = path.join(base, "target");
    const outside = path.join(base, "OUTSIDE");
    fs.mkdirSync(scratch);
    build(scratch, outside);
    // Bytes present BEFORE the call, so bait planted by the pole itself is not
    // counted as a leak — the verdict is the DELTA, never the absolute.
    const bytes = (d) => {
      let n = 0;
      const walk = (p) => {
        if (!fs.existsSync(p)) return;
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
          const q = path.join(p, e.name);
          if (e.isDirectory()) walk(q);
          else if (e.isFile()) n += fs.statSync(q).size;
        }
      };
      walk(d);
      return n;
    };
    const before = bytes(outside);
    let verdict = "ALLOWED";
    try {
      emitCiVerifier(REPO_ROOT, scratch, { elected: true, onBase: false });
    } catch (e) {
      // A typed refusal is the contract. An untyped crash (ENOENT/EACCES from
      // the write itself) is NOT a pass: it happens to avoid the escape here,
      // but it is the resolver failing open and then getting lucky downstream.
      verdict = /refusing the COC-verifier write/.test(e.message)
        ? "REFUSED"
        : `UNTYPED CRASH: ${e.code || e.message.slice(0, 60)}`;
    }
    const leaked = bytes(outside) - before;
    return (
      (verdict === "REFUSED" && leaked === 0) ||
      `verdict=${verdict} bytesLeakedOutsideRoot=${leaked}`
    );
  });
}

escapePole("emit/refuses-a-DANGLING-leaf-symlink-escape", (s, o) => {
  fs.mkdirSync(path.join(s, ".github", "workflows"), { recursive: true });
  fs.mkdirSync(o, { recursive: true });
  fs.symlinkSync(path.join(o, "escaped.yml"), path.join(s, CI_VERIFIER_TARGET_PATH));
});

escapePole("emit/refuses-a-DANGLING-directory-symlink-escape", (s, o) => {
  // `.github` -> a directory that does NOT exist. Before the fix this produced
  // an untyped ENOENT crash rather than a refusal.
  fs.symlinkSync(path.join(o, "nope"), path.join(s, ".github"));
});

escapePole("emit/refuses-a-symlinked-INTERMEDIATE-component", (s, o) => {
  // The escape need not sit at the leaf or at the first component.
  fs.mkdirSync(path.join(s, ".github"), { recursive: true });
  fs.mkdirSync(o, { recursive: true });
  fs.symlinkSync(o, path.join(s, ".github", "workflows"));
});

// The two remaining branches of the guard, each pinned by the CHEAPEST
// deterministic trigger rather than left uncovered. Both were found by mutating
// the guard and noticing the suite did NOT red — an uncovered branch and an
// inert mutation look identical from the tally, so each was resolved by finding
// a trigger that actually reaches it (`instrument-discipline.md` MUST-2(b)).
check(
  "emit/containment-fails-CLOSED-on-an-uninspectable-component",
  "a component that cannot be lstat'd for a reason OTHER than ENOENT is refused, never walked past",
  () => {
    // `.github` as a regular FILE makes the walk to `.github/workflows` raise
    // ENOTDIR. Chosen over a chmod-000 EACCES trigger deliberately: chmod is a
    // no-op for a process running as root, so that pole would pass VACUOUSLY in
    // any root CI container — the exact silent-green class this suite exists to
    // catch. ENOTDIR reaches the same branch and is uid-independent.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gate2-notdir-"));
    fs.writeFileSync(path.join(scratch, ".github"), "i am a file, not a directory");
    try {
      assertWriteContainedIn(scratch, path.join(scratch, CI_VERIFIER_TARGET_PATH));
    } catch (e) {
      return (
        /refusing the COC-verifier write/.test(e.message) ||
        `refused, but not with the typed contract: ${e.code || e.message.slice(0, 80)}`
      );
    }
    return "an uninspectable component was ALLOWED — the walk failed open";
  },
);

check(
  "emit/containment-refuses-a-parent-traversal-destination",
  // Pins the DISJUNCTION of the lexical `..` test and the canonical comparison,
  // which are OR-redundant for this shape — not either one alone. Measured:
  // deleting either check singly leaves this pole GREEN (the other catches it);
  // deleting BOTH reds it. Recorded because the single-lever reading is exactly
  // the mistake `coc-artifact-eval-coverage.md` MUST-5(b) blocks, and two drafts
  // of this pin's own comment made it before the composed mutation settled it.
  // At runtime the refusal comes from the lexical test (message: 'not lexically
  // beneath the target root'), so that is the branch a reader should expect.
  "a `..` destination is refused — by the lexical test in practice, with the canonical comparison as the redundant backstop",
  () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gate2-trav-"));
    try {
      assertWriteContainedIn(scratch, path.join(scratch, "..", "escape.yml"));
    } catch (e) {
      return (
        /refusing the COC-verifier write/.test(e.message) ||
        `refused, but not with the typed contract: ${e.code || e.message.slice(0, 80)}`
      );
    }
    return "a parent-traversal destination was ALLOWED";
  },
);

// ── The receipt must never assert a delivery that did not happen. ────────────
//
// This is the clause that made the symlink finding a BLOCK rather than a bug.
// When the write escaped, the target tree was left EMPTY and the record STILL
// said `action:"written", shippingNow:true` — so `formatCiVerifierReport` told
// the operator "this distribution is what makes the target verifiABLE; register
// the context". Arming a REQUIRED status check for a workflow that is not there
// hangs every PR on that repo, and under the `enforce_admins` the template's own
// registration step recommends there is no admin override. Refusing the escape
// is necessary; refusing to REPORT a delivery that did not occur is what makes
// the remedy safe to follow.
check(
  "emit/landedInTree-does-not-mistake-a-symlink-for-a-delivery",
  // Covers the DISJUNCTION of `landedInTree`'s two mechanisms — the containment
  // re-assertion and the `lstat().isFile()` test — which are OR-redundant for a
  // symlinked dest. Measured, composed, not inferred: swapping `lstat` for
  // `existsSync` alone leaves this GREEN (containment refuses the symlink
  // component first), dropping the containment re-assertion alone leaves it
  // GREEN (`lstat().isFile()` is false for a symlink), and doing BOTH reds it.
  // Stated because reading either single-lever green as "that mechanism is
  // uncovered" is the mistake `coc-artifact-eval-coverage.md` MUST-5(b) names,
  // and it has already been made twice in this file's history.
  "a dest pointing at a file OUTSIDE the tree is NOT counted as landed, though existsSync would follow it",
  () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "gate2-landed-"));
    const scratch = path.join(base, "target");
    const outside = path.join(base, "OUTSIDE");
    fs.mkdirSync(path.join(scratch, ".github", "workflows"), { recursive: true });
    fs.mkdirSync(outside);
    const dest = path.join(scratch, CI_VERIFIER_TARGET_PATH);
    // A real file exists at the far end, so `existsSync(dest)` is TRUE — the
    // discrimination this pole exists for.
    fs.writeFileSync(path.join(outside, "escaped.yml"), "content");
    fs.symlinkSync(path.join(outside, "escaped.yml"), dest);
    const viaExists = fs.existsSync(dest);
    const viaLanded = landedInTree(scratch, dest);
    // And the honest positive: a genuine in-tree regular file IS landed.
    const ok = path.join(scratch, ".github", "workflows", "real.yml");
    fs.writeFileSync(ok, "x");
    return (
      (viaExists === true && viaLanded === false && landedInTree(scratch, ok) === true) ||
      `existsSync=${viaExists} landedInTree=${viaLanded} landedInTree(realFile)=${landedInTree(scratch, ok)}`
    );
  },
);

check(
  "emit/landedInTree-sees-a-symlinked-PARENT-not-just-a-symlinked-leaf",
  "a file reached THROUGH a symlinked .github/ is not a delivery — lstat does not follow the leaf but DOES follow parents",
  () => {
    // Found by VERIFYING the fix rather than by assuming it: with containment
    // neutered to simulate a future bypass, this shape returned
    // action:"written" and printed the registration-routing line, because
    // `lstat(dest).isFile()` is TRUE for a real file at the far end of a
    // symlinked parent and the helper's only containment was the call it
    // delegated to. It now re-derives containment from realpath, so it is a
    // second lever rather than an alias of the first.
    //
    // COVERAGE, stated honestly: this shape is caught by THREE independent
    // levers (the symlink-component walk, this helper's own realpath check, and
    // the canonical comparison), so the pole cannot red on any single mutation
    // — measured, it survives dropping the realpath check alone and survives
    // that composed with neutering the walk. That is good defense in depth and
    // a WEAK single-lever regression detector, and both halves are true. Do not
    // read its green as evidence that any one of the three is live.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "gate2-parentlink-"));
    const scratch = path.join(base, "target");
    const outside = path.join(base, "OUTSIDE", "workflows");
    fs.mkdirSync(scratch);
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(path.dirname(outside), path.join(scratch, ".github"));
    const dest = path.join(scratch, CI_VERIFIER_TARGET_PATH);
    fs.writeFileSync(path.join(outside, path.basename(CI_VERIFIER_TARGET_PATH)), "outside content");
    const rawLstat = fs.lstatSync(dest).isFile(); // TRUE — the naive measure
    return (
      (rawLstat === true && landedInTree(scratch, dest) === false) ||
      `lstat(dest).isFile()=${rawLstat} landedInTree=${landedInTree(scratch, dest)} ` +
        `(the pole is only meaningful while the naive measure says true)`
    );
  },
);

check(
  "emit/absent-file-is-not-a-delivery",
  "landedInTree is false for a path that was never created — no delivery may be reported from a missing file",
  () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gate2-absent-"));
    return (
      landedInTree(scratch, path.join(scratch, CI_VERIFIER_TARGET_PATH)) === false ||
      "an absent path was reported as landed"
    );
  },
);

check(
  "emit/the-written-verdict-is-CONFIRMED-from-the-filesystem-not-inferred",
  "the write path checks landedInTree BEFORE returning action:'written' — a delivery is never inferred from writeFileSync not throwing",
  () => {
    const src = fs.readFileSync(DRIVER, "utf8");
    const fn = src.slice(src.indexOf("export function emitCiVerifier"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    const iWrite = body.indexOf("fs.writeFileSync(dest, content)");
    const iCheck = body.indexOf("landedInTree(scratch, dest)", iWrite);
    const iWritten = body.indexOf('action: "written"', iWrite);
    if (iWrite < 0) return "could not locate the write in emitCiVerifier";
    if (iCheck < 0) return "the write is never confirmed against the filesystem before reporting";
    return (
      (iCheck < iWritten) ||
      `the landed check at ${iCheck} must precede the "written" verdict at ${iWritten}`
    );
  },
);

// ── SEC-1: nothing in this driver may anchor to the operator's cwd. ──────────
//
// HIGH-1 closed a wrong-tree READ. This is the same class at an EXEC sink:
// `path.resolve(".claude/bin/sync-tier-aware.mjs")` anchors to `process.cwd()`,
// and the result was passed to `execFileSync("node", …)`. Every agent on this
// work runs from a `.loom-wt/*` worktree, so an operator invoking the tool by
// absolute path executed THAT worktree's unreviewed branch copy of the engine,
// whose output is committed and PR'd to nine downstream repos. No attacker
// required. MEASURED two-pole with cwd set to a decoy tree holding a planted
// engine: the old expression resolved INSIDE the decoy and outside loom; the
// new one resolved inside loom and outside the decoy; with cwd at the loom root
// both agree, so the fix is a no-op where cwd was already right.
//
// Comparisons below resolve BOTH sides. A raw string-prefix test cannot return
// true on macOS, where `/tmp` maps to `/private/tmp` — that exact mistake made a
// reviewer's own boolean deny a finding its printed path confirmed.
check(
  "wiring/the-EXECUTED-engine-is-anchored-to-this-script-not-the-cwd",
  "the engine handed to execFileSync is derived from SCRIPT_DIR — a cwd-anchored path executes another checkout's copy",
  () => {
    const r = regionOrFail(fs.readFileSync(DRIVER, "utf8"), ...SINGLE_SHOT);
    if (r.err) return r.err;
    const m = r.text.match(/const engine\s*=\s*([^;]+);/);
    if (!m) return "no `const engine = …` assignment in the single-shot region";
    const expr = m[1].trim();
    // Control: the matcher must reject the shape it exists to catch.
    if (/SCRIPT_DIR|LOOM_ROOT/.test('path.resolve(".claude/bin/sync-tier-aware.mjs")'))
      return "the matcher cannot distinguish the defective shape";
    return (
      (/SCRIPT_DIR|LOOM_ROOT/.test(expr) && !/process\.cwd\(\)/.test(expr)) ||
      `the executed engine is \`${expr}\` — not anchored to SCRIPT_DIR/LOOM_ROOT`
    );
  },
);

check(
  "wiring/no-LIVE-cwd-anchoring-anywhere-in-the-driver",
  "no executable line reads process.cwd() or path.resolve()s a relative literal — the whole class, not the three sites that were reported",
  () => {
    // Comments stripped first: this file discusses `process.cwd()` at length,
    // and prose naming a construct is not an instance of it — the confusion
    // this suite has now hit four times. Line comments before block, per the
    // ordering the sibling test file had to fix.
    const code = fs
      .readFileSync(DRIVER, "utf8")
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const cwdSites = code.match(/process\.cwd\(\)/g) || [];
    const relResolve = code.match(/path\.resolve\(\s*["'][^/"']/g) || [];
    // Control: both matchers must fire on the exact defective shapes.
    if (!/process\.cwd\(\)/.test("git(process.cwd(), [])") ||
        !/path\.resolve\(\s*["'][^/"']/.test('path.resolve(".claude/bin/x.mjs")'))
      return "a matcher cannot detect the shape it exists to catch";
    return (
      (cwdSites.length === 0 && relResolve.length === 0) ||
      `${cwdSites.length} live process.cwd() and ${relResolve.length} relative path.resolve() remain — ` +
        `each anchors this driver to the directory the operator happened to stand in`
    );
  },
);

check(
  "wiring/human-prose-never-goes-to-the-stdout-the-json-receipt-owns",
  "no formatter writes to stdout — stdout carries the --json receipt sync-completeness.md Rule 7 makes the MUST-2 audit record",
  () => {
    const code = fs
      .readFileSync(DRIVER, "utf8")
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    // Line comments stripped FIRST — the ordering loom#1760 had to fix in the
    // sibling test file, where a `//` line containing block-open characters
    // deleted 6,036 characters of source and dropped a wiring count to 0.
    const offenders = code.match(/process\.stdout\.write\(\s*format\w+\(/g) || [];
    // Control: the matcher must be able to FIRE. Feed it the exact shape.
    if (!/process\.stdout\.write\(\s*format\w+\(/.test("process.stdout.write(formatXReport(y));"))
      return "the matcher cannot detect the shape it exists to catch";
    return (
      offenders.length === 0 ||
      `${offenders.length} human-prose formatter(s) write to stdout: ${offenders.join(", ")} — ` +
        `one interleaved line breaks every \`| jq\` consumer on the run whose receipt matters most`
    );
  },
);

check(
  "emit/containment-does-NOT-over-fire-on-an-ordinary-target",
  "the no-false-positive pole: a plain worktree still receives the verifier",
  () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gate2-ok-"));
    const rep = emitCiVerifier(REPO_ROOT, scratch, { elected: true, onBase: false });
    return (
      (rep.action === "written" &&
        fs.existsSync(path.join(scratch, CI_VERIFIER_TARGET_PATH))) ||
      `action=${rep.action} present=${fs.existsSync(path.join(scratch, CI_VERIFIER_TARGET_PATH))}`
    );
  },
);

// ── loom#1750 / co-owner ratification 2026-08-29 — THE owned_surfaces ELECTION ──
// `.github/workflows/coc-artifact-validate.yml` is the first EXECUTABLE surface loom
// writes outside `.claude/**`, so `artifact-flow.md` § The Owned-Surface Bound makes it
// opt_in: true / DEFAULT OFF. These poles pin the DEFAULT, not merely the mechanism.
// `elected` is REQUIRED and throws when absent (loom#1760 F2) — an earlier revision
// defaulted it to true so the other cases here need not restate an election they are
// not testing, and that convenience made a caller who FORGOT it fail OPEN. The
// refusal is pinned below rather than trusted.

check(
  "emit/an-UNELECTED-target-receives-nothing",
  "elected:false writes no file and reports `not-elected` — default OFF is the contract, not a detail of it",
  () => {
    const t = mkTargetTree();
    try {
      const rep = emitCiVerifier(REPO_ROOT, t, { onBase: false, elected: false });
      const landed = fs.existsSync(path.join(t, CI_VERIFIER_TARGET_PATH));
      // The target's OWN workflow must survive untouched — loom owns ONE path here.
      const targetCiKept = fs.existsSync(path.join(t, ".github", "workflows", "ci-web.yml"));
      return (
        (rep.action === "not-elected" &&
          rep.shippingNow === false &&
          !landed &&
          targetCiKept) ||
        `action=${rep.action} shippingNow=${rep.shippingNow} landed=${landed} targetCiKept=${targetCiKept}`
      );
    } finally {
      rmTree(t);
    }
  },
);

check(
  "emit/an-ELECTED-target-still-receives-the-verifier",
  "the election is a GATE, not a global off-switch — elected:true must still deliver, or the pole above would pass on a broken emitter",
  () => {
    const t = mkTargetTree();
    try {
      const rep = emitCiVerifier(REPO_ROOT, t, { onBase: false, elected: true });
      const landed = fs.existsSync(path.join(t, CI_VERIFIER_TARGET_PATH));
      return (
        (rep.action === "written" && landed) || `action=${rep.action} landed=${landed}`
      );
    } finally {
      rmTree(t);
    }
  },
);

check(
  "emit/not-elected-is-DISTINCT-from-opted-out",
  "the two states carry different operator remedies, so collapsing them would report a decision that was never made",
  () => {
    const t = mkTargetTree();
    try {
      // Opt-out present AND unelected: election is checked FIRST, so the report must
      // say `not-elected` — the target never elected, so it has nothing to opt out of.
      fs.writeFileSync(path.join(t, ".claude", "coc-validate.optout"), "x\n");
      const unelected = emitCiVerifier(REPO_ROOT, t, { onBase: false, elected: false });
      const optedOut = emitCiVerifier(REPO_ROOT, t, { onBase: false, elected: true });
      return (
        (unelected.action === "not-elected" && optedOut.action === "opted-out") ||
        `unelected=${unelected.action} optedOut=${optedOut.action}`
      );
    } finally {
      rmTree(t);
    }
  },
);

check(
  "wiring/BOTH-production-call-sites-pass-an-explicit-election",
  "`elected` defaults to TRUE, so a call site that omits it fails OPEN — this pin is the only thing standing between that default and a silent default-ON regression",
  () => {
    const raw = fs.readFileSync(DRIVER, "utf8");
    // Strip line comments FIRST, then block comments: a `//` line containing the two
    // characters that open a block comment would otherwise swallow the code below it
    // and report a green over the hole (the loom#1760 ordering defect).
    const code = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    // Match ANY emitCiVerifier call, not `emitCiVerifier(LOOM_ROOT` (loom#1760 F2):
    // anchoring on the first argument made a third site written
    // `emitCiVerifier(root, …)` invisible here while the suite stayed green. The
    // function itself now THROWS on a missing `elected`, so this pin is a backstop
    // that keeps the two shipped sites reading from the manifest rather than
    // hard-coding a literal — it is no longer the only thing standing between the
    // default and a regression.
    const calls = code.match(/emitCiVerifier\([\s\S]{0,400}?\n?\s*\}\);/g) || [];
    const withElection = calls.filter((c) => /elected:\s*ciVerifierElected\(/.test(c));
    return (
      (calls.length === 2 && withElection.length === 2) ||
      `production call sites=${calls.length}, of which passing an election=${withElection.length} (expected 2/2)`
    );
  },
);

check(
  "emit/the-election-reader-defaults-OFF-and-does-not-grant-siblings",
  "ciVerifierElected returns false for an absent key, an unknown target and an unreadable manifest — for a grant, 'cannot tell' and 'not granted' must carry the SAME answer",
  () => {
    const real = fs.readFileSync(path.join(REPO_ROOT, ".claude", "sync-manifest.yaml"), "utf8");
    // Anchor the mutation at repos: -> py:, NOT the first `  py:` in the file (there are
    // many); an unanchored replace lands elsewhere and the pole reads as a false negative.
    const i = real.indexOf("\nrepos:\n");
    const j = real.indexOf("\n  py:\n", i);
    if (i < 0 || j < 0) return "could not locate repos.py — mutation unanchored, result unreadable";
    const elect = real.slice(0, j) + "\n  py:\n    coc_validate: true\n" + real.slice(j + "\n  py:\n".length);
    const results = {
      real_py: ciVerifierElected(real, "build", "py"),
      elected_py: ciVerifierElected(elect, "build", "py"),
      sibling_rs: ciVerifierElected(elect, "build", "rs"),
      unknown_target: ciVerifierElected(elect, "build", "no-such-target"),
      unreadable: ciVerifierElected("", "build", "py"),
    };
    return (
      (results.real_py === false &&
        results.elected_py === true &&
        results.sibling_rs === false &&
        results.unknown_target === false &&
        results.unreadable === false) ||
      JSON.stringify(results)
    );
  },
);

/**
 * Plant `coc_validate: true` at a NAMED level, and prove it reached THAT level.
 * Returns the mutated manifest text. Anchors on `repos:` explicitly — the first
 * `  py:` in this file is NOT under `repos:` (which starts near line 5900), and an
 * unanchored replace lands elsewhere and reads as a false negative.
 */
function plantElection(real, level, templateRepo = "kailash-coc-claude-py") {
  if (level === "repo") {
    const i = real.indexOf("\nrepos:\n");
    const j = real.indexOf("\n  py:\n", i);
    if (i < 0 || j < 0) return null;
    return real.slice(0, j) + "\n  py:\n    coc_validate: true\n" + real.slice(j + "\n  py:\n".length);
  }
  if (level === "repo-after-templates") {
    // The MIRROR position: a repo-level key written AFTER the templates: block.
    const i = real.indexOf("\nrepos:\n");
    const j = real.indexOf("\n  py:\n", i);
    const next = real.indexOf("\n  rs:\n", j);
    if (next < 0) return null;
    return real.slice(0, next) + "\n    coc_validate: true" + real.slice(next);
  }
  const anchor = `      - repo: ${templateRepo}\n`;
  const k = real.indexOf(anchor);
  if (k < 0) return null;
  return real.slice(0, k) + anchor + "        coc_validate: true\n" + real.slice(k + anchor.length);
}

check(
  "election/a-USE-template-election-does-NOT-elect-the-BUILD-repo",
  "loom#1760 F1: `body` includes the templates: sub-block, so an unanchored match let a template row set repos.<lang>.coc_validate — electing a USE template silently elected the BUILD repo, which is the exact act the ratification keeps the consumer's",
  () => {
    const real = fs.readFileSync(path.join(REPO_ROOT, ".claude", "sync-manifest.yaml"), "utf8");
    const m = plantElection(real, "template");
    if (m === null) return "template anchor not found — mutation unanchored, result unreadable";
    const py = parseRepos(m).py;
    const reached = py.templates.find((t) => t.repo === "kailash-coc-claude-py");
    return (
      // the mutation must REACH the template (else this pole proves nothing) ...
      (reached && reached.coc_validate === true &&
        // ... and must NOT leak to the repo level or the BUILD election
        py.coc_validate === false &&
        ciVerifierElected(m, "build", "py") === false) ||
      `templateReached=${reached && reached.coc_validate} repoLevel=${py.coc_validate} buildElected=${ciVerifierElected(m, "build", "py")}`
    );
  },
);

check(
  "election/a-repo-election-written-AFTER-templates-does-NOT-elect-the-last-template",
  "loom#1760 F1 mirror: the last entry's body ran to repoBody.length, so a repo-level key placed after the templates: block was captured by the last template. YAML permits either key order and nothing enforces one. TWO INDEPENDENT LEVERS cover this (the 8-space template anchor AND the entry-body bound), so this pole CANNOT red on either mutation alone — measured: loosening the anchor leaves 93/93, neutering the bound leaves 93/93, doing BOTH reds it. That is good defence in depth and a weak single-lever regression detector; the pole says both rather than implying a strength it does not have",
  () => {
    const real = fs.readFileSync(path.join(REPO_ROOT, ".claude", "sync-manifest.yaml"), "utf8");
    const m = plantElection(real, "repo-after-templates");
    if (m === null) return "mirror anchor not found — mutation unanchored, result unreadable";
    const py = parseRepos(m).py;
    const leaked = py.templates.filter((t) => t.coc_validate);
    return (
      (py.coc_validate === true && leaked.length === 0) ||
      `repoLevel=${py.coc_validate} leakedTemplates=[${leaked.map((t) => t.repo).join(",")}]`
    );
  },
);

check(
  "election/the-USE-lane-arm-reads-the-per-TEMPLATE-key",
  "loom#1760 F3: every prior pole passed lane='build', so mutating the USE arm to `return true` left the suite green while every template became elected",
  () => {
    const real = fs.readFileSync(path.join(REPO_ROOT, ".claude", "sync-manifest.yaml"), "utf8");
    const m = plantElection(real, "template", "kailash-coc-claude-py");
    if (m === null) return "template anchor not found — mutation unanchored, result unreadable";
    const results = {
      baseline_use: ciVerifierElected(real, "use", "py", "kailash-coc-claude-py"),
      elected_use: ciVerifierElected(m, "use", "py", "kailash-coc-claude-py"),
      sibling_template: ciVerifierElected(m, "use", "py", "kailash-coc-py"),
    };
    return (
      (results.baseline_use === false &&
        results.elected_use === true &&
        results.sibling_template === false) ||
      JSON.stringify(results)
    );
  },
);

check(
  "election/the-USE-lane-fails-CLOSED-on-every-unresolvable-input",
  "loom#1760 F3: a null slug, an unmappable target (useLaneLang throws) and a slug naming no manifest entry must each return false — for a grant, 'cannot tell' and 'not granted' carry the same answer",
  () => {
    const real = fs.readFileSync(path.join(REPO_ROOT, ".claude", "sync-manifest.yaml"), "utf8");
    const m = plantElection(real, "template");
    if (m === null) return "template anchor not found — mutation unanchored, result unreadable";
    const results = {
      null_slug: ciVerifierElected(m, "use", "py", null),
      unmappable_target: ciVerifierElected(m, "use", "no-such-lang", "kailash-coc-claude-py"),
      unknown_slug: ciVerifierElected(m, "use", "py", "not-a-declared-template"),
      unreadable_manifest: ciVerifierElected("", "use", "py", "kailash-coc-claude-py"),
      prototype_key: ciVerifierElected(m, "use", "py", "__proto__"),
    };
    return (
      Object.values(results).every((v) => v === false) || JSON.stringify(results)
    );
  },
);

check(
  "emit/emitCiVerifier-REFUSES-a-missing-election-rather-than-assuming-one",
  "loom#1760 F2: `elected` defaulted to true, so the security control failed OPEN at the function boundary when a caller forgot it (security.md § Secure-Default)",
  () => {
    const t = mkTargetTree();
    try {
      let threw = null;
      try {
        emitCiVerifier(REPO_ROOT, t, { onBase: false });
      } catch (e) {
        threw = e.message;
      }
      const landed = fs.existsSync(path.join(t, CI_VERIFIER_TARGET_PATH));
      return (
        (threw !== null && /elected/.test(threw) && !landed) ||
        `threw=${threw === null ? "NOTHING" : threw.slice(0, 90)} landed=${landed}`
      );
    } finally {
      rmTree(t);
    }
  },
);

check(
  "emit/a-non-boolean-election-is-REFUSED-not-coerced",
  "a truthy string, 1, or null must not pass for an election — coercion would re-open the fail-open path through a different door",
  () => {
    const bad = ["true", 1, null, undefined, {}];
    const survived = [];
    for (const v of bad) {
      const t = mkTargetTree();
      try {
        emitCiVerifier(REPO_ROOT, t, { onBase: false, elected: v });
        survived.push(JSON.stringify(v));
      } catch {
        /* refused, as required */
      } finally {
        rmTree(t);
      }
    }
    return survived.length === 0 || `accepted non-boolean election(s): ${survived.join(", ")}`;
  },
);

check(
  "election/de-election-after-stage-does-not-report-a-file-the-PR-will-ship-as-absent",
  "loom#1760 F4: `present` read `preexisting` (the BASE COMMIT), so after a staged write + de-election the receipt claimed absence while the PR shipped the workflow — Rule 7 makes this receipt the audit record, so it must not disagree with the tree",
  () => {
    const t = mkTargetTree();
    try {
      // 1. elected run writes the verifier into the staged tree
      const staged = emitCiVerifier(REPO_ROOT, t, { onBase: false, elected: true });
      const onDisk = fs.existsSync(path.join(t, CI_VERIFIER_TARGET_PATH));
      // 2. operator de-elects; --finalize re-emits against the SAME tree
      const after = emitCiVerifier(REPO_ROOT, t, { onBase: false, elected: false });
      return (
        (staged.action === "written" &&
          onDisk &&
          after.action === "not-elected" &&
          after.present === true &&
          after.staleFromPriorElection === true) ||
        `staged=${staged.action} onDisk=${onDisk} after=${after.action} present=${after.present} stale=${after.staleFromPriorElection}`
      );
    } finally {
      rmTree(t);
    }
  },
);

check(
  "emit/dry-run-writes-nothing",
  "write:false performs every decision and touches no file — a read-only verb must not mutate the target (loom#1760 HIGH-2 aggravator)",
  () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gate2-dry-"));
    const rep = emitCiVerifier(REPO_ROOT, scratch, { elected: true, onBase: false, write: false });
    const landed = fs.existsSync(path.join(scratch, CI_VERIFIER_TARGET_PATH));
    return (
      (rep.action === "would-write" && rep.shippingNow === true && !landed) ||
      `action=${rep.action} shippingNow=${rep.shippingNow} fileLanded=${landed}`
    );
  },
);

check(
  "emit/dry-run-bucket-assignment-follows-preexisting",
  "a first delivery predicts an ADD and a refresh predicts a MODIFY — the source-order pin below cannot tell these apart (loom#1760 LOW-3)",
  () => {
    // BEHAVIOURAL, because the sibling pin is source-ORDER only: swapping the
    // buckets (`preexisting ? added : modified` reversed) is a genuine behaviour
    // change that leaves it green. The count survives either way — both buckets
    // sum into `changed`, so MED-1's total stays right — but added-vs-modified
    // classification is what a receipt reader uses to tell a NEW gate from a
    // refreshed one, which is the same distinction the `unregistered` tier
    // turns on.
    //
    // Calls the DRIVER's exported reconciler. An earlier version of this pole
    // re-derived the rule here and therefore tested the fixture's own copy —
    // it stayed green through the very bucket swap it was written to catch,
    // which is the self-derived oracle `evidence-first-claims.md` MUST-5 names.
    // The decision was extracted from `main()` precisely so this can reach it.
    const bucketFor = (rep) => {
      const manifest = reconcileSuppressedWrite(
        { added: [], modified: [], deleted: [] },
        rep,
        true,
      );
      return manifest.added.length ? "added" : manifest.modified.length ? "modified" : "none";
    };
    // FIRST delivery: nothing on the base commit -> the prediction is an ADD.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "gate2-bucket-a-"));
    const first = emitCiVerifier(REPO_ROOT, fresh, { elected: true, onBase: false, write: false });
    // REFRESH: already on the base commit -> the prediction is a MODIFY.
    const known = fs.mkdtempSync(path.join(os.tmpdir(), "gate2-bucket-m-"));
    const again = emitCiVerifier(REPO_ROOT, known, { elected: true, onBase: true, write: false });
    const gotFirst = bucketFor(first);
    const gotAgain = bucketFor(again);
    return (
      (first.action === "would-write" &&
        again.action === "would-write" &&
        gotFirst === "added" &&
        gotAgain === "modified") ||
      `first-delivery -> ${gotFirst} (want added, preexisting=${first.preexisting }); ` +
        `refresh -> ${gotAgain} (want modified, preexisting=${again.preexisting })`
    );
  },
);

check(
  "emit/dry-run-manifest-COUNTS-the-file-it-declines-to-write",
  "the preview's changed-count includes the verifier path, so DRY-RUN N matches the real run's N (loom#1760 MED-1)",
  () => {
    // Source-level, deliberately: driving the real single-shot path needs a
    // git remote, a worktree and a network fetch, none of which this offline
    // suite has. What IS checkable here is that the dry-run branch reconciles
    // the suppressed write into the manifest BEFORE `changed` is computed —
    // and the ordering is the half that was wrong.
    const r = regionOrFail(fs.readFileSync(DRIVER, "utf8"), ...SINGLE_SHOT);
    if (r.err) return r.err;
    // Searches for the CALL, not the inline branch: the decision was extracted
    // to `reconcileSuppressedWrite` so a behavioural pole could reach it
    // (loom#1760 LOW-3), which moved the old anchor out of this region. The
    // extraction reddened this pin, which is the right way round — it noticed.
    const iRecon = r.text.indexOf("reconcileSuppressedWrite(");
    const iChanged = r.text.indexOf("const changed =");
    const iEmit = r.text.indexOf("DRY-RUN: ${changed} file(s) would change");
    if (iRecon < 0) return "the dry-run branch never reconciles the would-write path into the manifest";
    if (iChanged < 0 || iEmit < 0) return "could not locate the changed-count or the DRY-RUN message";
    return (
      (iRecon < iChanged && iChanged < iEmit) ||
      `reconciliation at ${iRecon} must precede the count at ${iChanged}, which must precede the message at ${iEmit}`
    );
  },
);

check(
  "emit/the-dry-run-flag-is-actually-wired-to-the-single-shot-call",
  "the single-shot emit passes write: !args.dryRun — the emit precedes the dry-run exit, so an unwired flag writes on a read-only verb",
  () => {
    const r = regionOrFail(fs.readFileSync(DRIVER, "utf8"), ...SINGLE_SHOT);
    if (r.err) return r.err;
    const m = r.text.match(/emitCiVerifier\([\s\S]{0,300}?\}\);/);
    if (!m) return "no emitCiVerifier call found in the single-shot region";
    return (
      /write:\s*!args\.dryRun/.test(m[0]) ||
      "the single-shot emit does not gate its write on --dry-run"
    );
  },
);


// ── loom#1760 CORRECTNESS ROUND ───────────────────────────────────────────────
// Six poles for four defects a correctness pass found on this branch. Each is
// paired: the violation pole AND the shape that must stay unchanged, so a fix
// that simply hardwires the safe answer reds on the sibling.

/** A worktree already carrying the verifier — the state --stage-only leaves. */
function stagedTree(tag) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), tag));
  fs.mkdirSync(path.dirname(path.join(t, CI_VERIFIER_TARGET_PATH)), { recursive: true });
  fs.writeFileSync(path.join(t, CI_VERIFIER_TARGET_PATH), "bytes a prior --stage-only wrote");
  return t;
}

check(
  "emit/an-UNRESOLVED-base-probe-never-manufactures-already-landed",
  "on a tree the caller declares ALREADY WRITTEN, onBase:null must resolve to shipping-now — the side whose worst case is a redundant merge, not a permanent PR hang",
  () => {
    // `ciVerifierOnBase` returns null for an errored probe precisely so no
    // verdict is manufactured (evidence-first-claims.md MUST-3). Before this
    // round `emitCiVerifier` then read `fs.existsSync(dest)` on BOTH call paths
    // — and on --finalize that file is one this same delivery staged, so the
    // read reported `preexisting: true` and routed the operator to ARM the
    // required check for a workflow not yet on the base. MEASURED at the time:
    // preexisting=true shippingNow=false verdict=verifier-present-check-unregistered.
    const rep = emitCiVerifier(REPO_ROOT, stagedTree("g2-unres-"), { elected: true, onBase: null,
      treeAlreadyWritten: true,});
    const cls = classifyTargetVerifiability({ status: "not-found" }, rep);
    return (
      (rep.preexisting === false &&
        rep.shippingNow === true &&
        rep.probeUnresolved === true &&
        cls.reason === "verifier-shipping-this-distribution") ||
      `preexisting=${rep.preexisting} shippingNow=${rep.shippingNow} ` +
        `probeUnresolved=${rep.probeUnresolved} reason=${cls.reason}`
    );
  },
);

check(
  "emit/the-single-shot-filesystem-fallback-is-PRESERVED",
  "the no-false-positive pole: where the fs read DOES reproduce git truth (a tree nothing has written), an unresolved probe still uses it",
  () => {
    // Without this pole the fix above is indistinguishable from deleting the
    // fallback outright, which would report every single-shot refresh as a
    // first delivery. The single-shot worktree is detached at the base commit
    // and the engine apply never touches `.github/`, so the read IS git truth
    // there — `treeAlreadyWritten` defaults false and nothing changes.
    const rep = emitCiVerifier(REPO_ROOT, stagedTree("g2-ss-"), { elected: true, onBase: null });
    return (
      (rep.preexisting === true && rep.shippingNow === false && rep.probeUnresolved === false) ||
      `preexisting=${rep.preexisting} shippingNow=${rep.shippingNow} probeUnresolved=${rep.probeUnresolved}`
    );
  },
);

check(
  "emit/an-unresolved-probe-is-ANNOUNCED-not-silently-resolved",
  "the operator must be able to see that a PROBE, not git, decided the delivery tier (zero-tolerance.md Rule 3 — no silent fallback)",
  () => {
    const warned = formatCiVerifierReport(
      emitCiVerifier(REPO_ROOT, stagedTree("g2-warn-"), { elected: true, onBase: null, treeAlreadyWritten: true }),
    );
    const quiet = formatCiVerifierReport(
      emitCiVerifier(REPO_ROOT, stagedTree("g2-quiet-"), { elected: true, onBase: true, treeAlreadyWritten: true }),
    );
    // BIPOLAR: the WARN must appear on the unresolved pole and MUST NOT appear
    // on the resolved one, or it is decoration rather than a signal.
    return (
      (/WARN the base-commit probe did NOT answer/.test(warned) &&
        !/WARN the base-commit probe did NOT answer/.test(quiet)) ||
      `unresolved-pole warned=${/WARN the base-commit probe/.test(warned)} ` +
        `resolved-pole warned=${/WARN the base-commit probe/.test(quiet)}`
    );
  },
);

check(
  "wiring/finalize-DECLARES-its-tree-already-written",
  "the --finalize call site must pass treeAlreadyWritten — the emitter cannot know, and the default is the single-shot one",
  () => {
    const r = regionOrFail(fs.readFileSync(DRIVER, "utf8"), ...FINALIZE);
    if (r.err) return r.err;
    const m = r.text.match(/emitCiVerifier\([\s\S]{0,400}?\}\);/);
    if (!m) return "no emitCiVerifier call found in the --finalize region";
    // And the SINGLE-SHOT site must NOT carry it: that path's fs read is sound,
    // and declaring otherwise would report every refresh as a first delivery.
    const ss = regionOrFail(fs.readFileSync(DRIVER, "utf8"), ...SINGLE_SHOT);
    if (ss.err) return ss.err;
    const sm = ss.text.match(/emitCiVerifier\([\s\S]{0,400}?\}\);/);
    if (!sm) return "no emitCiVerifier call found in the single-shot region";
    return (
      (/treeAlreadyWritten:\s*true/.test(m[0]) && !/treeAlreadyWritten/.test(sm[0])) ||
      `finalize-declares=${/treeAlreadyWritten:\s*true/.test(m[0])} ` +
        `single-shot-declares=${/treeAlreadyWritten/.test(sm[0])}`
    );
  },
);

check(
  "emit/isInvokedAsMain-takes-the-SAME-argument-shape-as-its-sibling",
  "two same-named entrypoint predicates in one tree must not take incompatible second parameters — a copied call site would otherwise answer wrongly",
  () => {
    // The comment on this function claims parity with
    // `validate-emit.mjs::isInvokedAsMain`. That claim was FALSE until this
    // round: this one took a module URL and converted inside, the sibling takes
    // an already-converted path. MEASURED cross-fed: thisFn(path, PATH) threw
    // ERR_INVALID_URL, and sibling(path, URL) returned false for the SAME file —
    // an entrypoint guard silently answering "not main".
    const p = path.join(os.tmpdir(), "gate2-nonexistent-entrypoint.mjs");
    const q = path.join(os.tmpdir(), "gate2-other-entrypoint.mjs");
    const url = new URL("file://" + p).href;
    let urlRejected = false;
    try {
      // A URL in the filename slot must NOT compare equal to the path it names.
      urlRejected = isInvokedAsMain(p, url) === false;
    } catch {
      urlRejected = false; // throwing is also not parity
    }
    return (
      (isInvokedAsMain(p, p) === true &&
        isInvokedAsMain(p, q) === false &&
        isInvokedAsMain(undefined, p) === false &&
        urlRejected) ||
      `same=${(() => { try { return isInvokedAsMain(p, p); } catch (e) { return "THREW " + e.code; } })()} ` +
        `diff=${(() => { try { return isInvokedAsMain(p, q); } catch (e) { return "THREW " + e.code; } })()} ` +
        `urlRejected=${urlRejected}`
    );
  },
);

check(
  "emit/the-opt-out-report-does-not-claim-the-verdict-is-UNAFFECTED",
  "an opt-out DOES move the verdict when a prior distribution left the file behind — the report must not assert otherwise",
  () => {
    // MEASURED on the pre-fix revision: opt-out + no file -> `unverifiable`;
    // opt-out + file on the base -> `unregistered`. The report nevertheless said
    // "Its verifiability verdict is unaffected", which is a claim the classifier
    // contradicts on the second pole (zero-tolerance.md Rule 3e).
    const mkOptout = (tag) => {
      const t = fs.mkdtempSync(path.join(os.tmpdir(), tag));
      fs.mkdirSync(path.dirname(path.join(t, CI_VERIFIER_OPTOUT_PATH)), { recursive: true });
      fs.writeFileSync(path.join(t, CI_VERIFIER_OPTOUT_PATH), "");
      return t;
    };
    const absent = emitCiVerifier(REPO_ROOT, mkOptout("g2-opt-a-"), { elected: true, onBase: false });
    const present = emitCiVerifier(REPO_ROOT, mkOptout("g2-opt-p-"), { elected: true, onBase: true });
    const vAbsent = classifyTargetVerifiability({ status: "not-found" }, absent).verdict;
    const vPresent = classifyTargetVerifiability({ status: "not-found" }, present).verdict;
    const text = formatCiVerifierReport(present);
    return (
      (vAbsent === "unverifiable" &&
        vPresent === "unregistered" &&
        !/verdict is unaffected/.test(text)) ||
      `absent->${vAbsent} present->${vPresent} ` +
        `claims-unaffected=${/verdict is unaffected/.test(text)}`
    );
  },
);

const total = pass + failures.length;
console.log(`\ngate2-target-verifiability: ${pass}/${total} PASS`);
if (failures.length > 0) {
  console.log(`FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
