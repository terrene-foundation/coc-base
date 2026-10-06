#!/usr/bin/env node
/**
 * doctor-target-protection — the fixture lock for `loom doctor --targets` (F76).
 *
 * WHAT IS UNDER TEST. F76 is the claim "the 9 Gate-2 target repos have NO required
 * status check, so merges there are unverified by construction." The claim is only
 * as good as the instrument that measures it, and this instrument is easy to get
 * silently wrong in exactly one way: an implementation that cannot distinguish
 * "no protection configured" from "protection configured with no contexts" from
 * "the probe never answered" prints the SAME thing whether F76 is true or false.
 * A check consistent with both branches of the hypothesis carries zero information
 * (`instrument-discipline.md` MUST-1).
 *
 * HOW IT DISCRIMINATES — BIPOLAR BY CONSTRUCTION. Every verdict case is paired: a
 * payload that MUST report PROTECTED against one that MUST NOT. An implementation
 * hardwired to either pole reds on the other, so nothing here is "shown only to
 * pass". The named falsifying results are:
 *
 *   proposition                        | falsified when this fixture prints
 *   -----------------------------------+-----------------------------------------
 *   the instrument reports protected   | FAIL protected/* (it reported crit/warn
 *   for a properly protected target    | on a payload with contexts + admins on)
 *   the instrument reports UNPROTECTED | FAIL unprotected/* (it reported ok on a
 *   for an unprotected target          | payload with no required check)
 *   the instrument fails CLOSED        | FAIL failclosed/* (an errored, 404'd or
 *                                      | permission-denied probe reported ok/warn)
 *   ABSENT is kept apart from NULL     | FAIL discrimination/absent-vs-null-*
 *                                      | (both collapsed to one reason)
 *
 * THE SHARPEST CASES are `discrimination/absent-vs-null-required-status-checks` and
 * `discrimination/absent-vs-null-enforce-admins`. GitHub omits a key entirely for one
 * repo state and returns it `null` for another; `p.required_status_checks?.contexts
 * ?.length` and `p.enforce_admins?.enabled` collapse those to one falsy value, so an
 * optional-chained implementation returns ONE reason for two distinct repo states —
 * three, once PRESENT-AND-EMPTY is counted — and reds here.
 *
 * WHY THE WIRING CASES. A perfect classifier that nothing calls, or one wired into a
 * DEFAULT run that fans out cross-repo API calls on every unattended invocation, is
 * the un-gated shape this fixture exists to prevent. Cases under `wiring/` pin that
 * the probe is opt-in, that the roll-up reads the rows, and that the report-only
 * contract carries no write path.
 *
 * NO NETWORK. Every probe seam is injected, so each `gh` outcome (protected, 404
 * "Branch not protected", bare 404, auth failure, unparseable body, gh absent) is
 * exercised without a live repo and without any cross-repo call.
 *
 * Mutations that red each case are recorded in README.md, measured, not assumed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
// Overridable so a RED can be established against an UNFIXED build without mutating
// the working tree (`instrument-discipline.md` MUST-2).
const DOCTOR =
  process.env.LOOM_DOCTOR || path.join(REPO_ROOT, ".claude", "bin", "loom-doctor.mjs");

const {
  enumerateGate2Targets,
  probeDefaultBranch,
  probeTargetProtectionStrict,
  classifyEnforceAdmins,
  buildTargetCheck,
  buildTargetsSummary,
  configErrorRow,
  resolveTargetRepoArg,
  validateBaseRef,
  baseRefRefusalRow,
  ownOriginSlug,
  targetRepoRefusalRow,
  notProbedRow,
  runTargetChecks,
  withTargetChecks,
  parseFlags,
} = await import(DOCTOR);

let pass = 0;
const failures = [];

/** `PASS <name>` at column 0 is the shape run-audit-fixtures.mjs::CASE_PASS counts. */
async function check(name, expectation, actualFn) {
  let ok = false;
  let detail;
  try {
    const r = await actualFn();
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

// ── seams ────────────────────────────────────────────────────────────────────

/** The normalized shape loom-doctor's exec seam returns. */
const okExec = (stdout) => () => ({ ok: true, missing: false, code: 0, stdout, stderr: "" });
const errExec = (stderr, code = 1) => () => ({ ok: false, missing: false, code, stdout: "", stderr });
const missingExec = () => () => ({ ok: false, missing: true });

/** Build the whole per-target row from a raw gh body, through the real path. */
function rowFor(protectionExec, { base = "main" } = {}) {
  return runTargetChecks({
    exec: protectionExec,
    config: { remote_links: { "use-template.py": { org: "example", repo: "target-py" } } },
    configError: null,
    base,
  });
}

const PROTECTED_BODY = JSON.stringify({
  required_status_checks: { contexts: ["Required checks"], checks: [{ context: "Required checks" }] },
  enforce_admins: { enabled: true },
});

// ── POLE A — a properly protected target. MUST report ok. ────────────────────

await check(
  "protected/contexts-and-admins-on-reports-ok",
  "contexts:['Required checks'] + enforce_admins.enabled:true ⇒ status ok, detail names both",
  async () => {
    const { checks } = await rowFor(okExec(PROTECTED_BODY));
    const row = checks.find((c) => c.id === "gate2-target:use-template.py");
    return (
      (row.status === "ok" &&
        /1 required check\(s\): Required checks/.test(row.detail) &&
        /enforce_admins=on/.test(row.detail) &&
        row.required_checks.verdict === "verifiable" &&
        row.enforce_admins.verdict === "on") ||
      JSON.stringify(row)
    );
  },
);

await check(
  "protected/boolean-enforce-admins-true",
  "the bare-boolean enforce_admins:true carrier also classifies on",
  () => {
    const r = classifyEnforceAdmins({ status: "ok", protection: { enforce_admins: true } });
    return (r.verdict === "on" && r.reason === "enforce-admins-boolean") || JSON.stringify(r);
  },
);

// ── POLE B — protected but BYPASSABLE. MUST report warn, never ok. ───────────

await check(
  "bypassable/contexts-present-admins-off-reports-warn",
  "contexts present + enforce_admins.enabled:false ⇒ warn, never ok",
  async () => {
    const body = JSON.stringify({
      required_status_checks: { contexts: ["CI"] },
      enforce_admins: { enabled: false },
    });
    const { checks } = await rowFor(okExec(body));
    const row = checks.find((c) => c.id === "gate2-target:use-template.py");
    return (
      (row.status === "warn" &&
        /enforce_admins=OFF/.test(row.detail) &&
        /admin merge bypasses/.test(row.detail)) ||
      JSON.stringify(row)
    );
  },
);

// ── POLE C — UNPROTECTED. MUST report crit, with a state-specific reason. ────

await check(
  "unprotected/no-branch-protection-reports-crit",
  "a 404 body 'Branch not protected' ⇒ crit, reason no-branch-protection, admins off",
  async () => {
    const { checks } = await rowFor(errExec("gh: Branch not protected (HTTP 404)"));
    const row = checks.find((c) => c.id === "gate2-target:use-template.py");
    return (
      (row.status === "crit" &&
        /NO required status check \(no-branch-protection\)/.test(row.detail) &&
        /UNVERIFIED BY CONSTRUCTION/.test(row.detail) &&
        row.enforce_admins.verdict === "off") ||
      JSON.stringify(row)
    );
  },
);

await check(
  "unprotected/empty-contexts-reports-crit-with-its-own-reason",
  "required_status_checks present with contexts:[] ⇒ crit, reason required-status-checks-empty",
  async () => {
    const body = JSON.stringify({
      required_status_checks: { contexts: [], checks: [] },
      enforce_admins: { enabled: true },
    });
    const { checks } = await rowFor(okExec(body));
    const row = checks.find((c) => c.id === "gate2-target:use-template.py");
    return (
      (row.status === "crit" && row.required_checks.reason === "required-status-checks-empty") ||
      JSON.stringify(row)
    );
  },
);

await check(
  "unprotected/required-status-checks-key-absent-reports-crit",
  "protection present but the required_status_checks KEY absent ⇒ crit, its own reason",
  async () => {
    const body = JSON.stringify({ enforce_admins: { enabled: true } });
    const { checks } = await rowFor(okExec(body));
    const row = checks.find((c) => c.id === "gate2-target:use-template.py");
    return (
      (row.status === "crit" && row.required_checks.reason === "required-status-checks-absent") ||
      JSON.stringify(row)
    );
  },
);

// ── DISCRIMINATION — the cases an optional-chained implementation collapses ──

await check(
  "discrimination/absent-vs-null-required-status-checks",
  "ABSENT and PRESENT-AND-NULL required_status_checks give DIFFERENT reasons",
  async () => {
    const absent = await rowFor(okExec(JSON.stringify({ enforce_admins: { enabled: true } })));
    const isNull = await rowFor(
      okExec(JSON.stringify({ required_status_checks: null, enforce_admins: { enabled: true } })),
    );
    const a = absent.checks[0].required_checks.reason;
    const n = isNull.checks[0].required_checks.reason;
    return (
      (a === "required-status-checks-absent" && n === "required-status-checks-null" && a !== n) ||
      `absent=${a} null=${n}`
    );
  },
);

await check(
  "discrimination/absent-vs-null-vs-empty-are-three-reasons",
  "ABSENT / NULL / EMPTY are three distinct reasons, not one collapsed falsy verdict",
  async () => {
    const bodies = [
      JSON.stringify({}),
      JSON.stringify({ required_status_checks: null }),
      JSON.stringify({ required_status_checks: { contexts: [] } }),
    ];
    const reasons = [];
    for (const b of bodies) {
      const { checks } = await rowFor(okExec(b));
      reasons.push(checks[0].required_checks.reason);
    }
    return new Set(reasons).size === 3 || `reasons=${JSON.stringify(reasons)}`;
  },
);

await check(
  "discrimination/absent-vs-null-enforce-admins",
  "ABSENT enforce_admins ⇒ unknown (NOT off); PRESENT-AND-NULL ⇒ its own unknown reason",
  () => {
    const absent = classifyEnforceAdmins({ status: "ok", protection: { required_status_checks: {} } });
    const isNull = classifyEnforceAdmins({ status: "ok", protection: { enforce_admins: null } });
    return (
      (absent.verdict === "unknown" &&
        absent.reason === "enforce-admins-key-absent" &&
        isNull.verdict === "unknown" &&
        isNull.reason === "enforce-admins-null" &&
        absent.reason !== isNull.reason) ||
      JSON.stringify({ absent, isNull })
    );
  },
);

await check(
  "discrimination/enforce-admins-absent-is-never-reported-as-off",
  "an absent enforce_admins key MUST NOT be read as 'off' — absence is not observation",
  () => {
    const r = classifyEnforceAdmins({ status: "ok", protection: { required_status_checks: {} } });
    return r.verdict !== "off" || `absent key classified ${r.verdict}`;
  },
);

// ── FAIL-CLOSED — an unanswered probe is ZERO evidence, never an all-clear ───

await check(
  "failclosed/api-error-reports-unknown-crit",
  "a gh api failure ⇒ crit, protection UNKNOWN, never ok/warn",
  async () => {
    const { checks } = await rowFor(errExec("gh: HTTP 500 Internal Server Error"));
    const row = checks.find((c) => c.id === "gate2-target:use-template.py");
    return (
      (row.status === "crit" &&
        /protection UNKNOWN \(protection-probe-errored\)/.test(row.detail) &&
        row.required_checks.verdict === "unknown") ||
      JSON.stringify(row)
    );
  },
);

await check(
  "failclosed/permission-denial-reports-unknown-not-unprotected",
  "HTTP 403 / auth failure ⇒ UNKNOWN, never 'no required status check'",
  async () => {
    const { checks } = await rowFor(errExec("gh: HTTP 403: Resource not accessible by integration"));
    const row = checks.find((c) => c.id === "gate2-target:use-template.py");
    return (
      (row.status === "crit" &&
        row.required_checks.verdict === "unknown" &&
        !/NO required status check/.test(row.detail)) ||
      JSON.stringify(row)
    );
  },
);

await check(
  "failclosed/bare-404-is-unknown-not-unprotected",
  "a bare HTTP 404 (repo absent OR invisible to the token) ⇒ UNKNOWN, NOT no-branch-protection",
  () => {
    const p = probeTargetProtectionStrict(errExec("gh: HTTP 404: Not Found"), "example/target-absent", "main");
    return (
      (p.status === "error" && /invisible to this token/.test(p.detail)) || JSON.stringify(p)
    );
  },
);

await check(
  "failclosed/branch-not-protected-404-stays-determinate",
  "the OTHER pole: a 404 carrying 'Branch not protected' IS determinate ⇒ not-found",
  () => {
    const p = probeTargetProtectionStrict(
      errExec("gh: HTTP 404: Branch not protected"),
      "example/target-py",
      "main",
    );
    return p.status === "not-found" || JSON.stringify(p);
  },
);

await check(
  "failclosed/gh-not-installed-is-unknown-not-absent",
  "gh missing ⇒ error/UNKNOWN with a detail saying so, never 'unprotected'",
  () => {
    const p = probeTargetProtectionStrict(missingExec(), "example/target-py", "main");
    return (
      (p.status === "error" && /gh is not installed/.test(p.detail) && /UNKNOWN, not absent/.test(p.detail)) ||
      JSON.stringify(p)
    );
  },
);

await check(
  "failclosed/unparseable-body-is-unknown",
  "a 200 with a body that is not JSON ⇒ error/UNKNOWN, never a guessed verdict",
  () => {
    const p = probeTargetProtectionStrict(okExec("<html>proxy error</html>"), "example/target-py", "main");
    return (p.status === "error" && /unparseable gh api JSON/.test(p.detail)) || JSON.stringify(p);
  },
);

await check(
  "failclosed/default-branch-probe-error-reports-unknown",
  "when the default-branch lookup fails the target is UNKNOWN — no branch is guessed",
  async () => {
    const { checks } = await rowFor(errExec("gh: HTTP 401 Bad credentials"), { base: null });
    const row = checks.find((c) => c.id === "gate2-target:use-template.py");
    return (
      (row.status === "crit" &&
        row.base === "?" &&
        row.required_checks.reason === "default-branch-probe-errored") ||
      JSON.stringify(row)
    );
  },
);

await check(
  "failclosed/empty-default-branch-is-an-error",
  "an empty default_branch is an error, not an empty-string branch name",
  () => {
    const b = probeDefaultBranch(okExec("   "), "example/target-py");
    return (b.status === "error" && /empty default_branch/.test(b.detail)) || JSON.stringify(b);
  },
);

await check(
  "failclosed/unknown-outranks-a-determinate-checks-verdict",
  "contexts present but enforce_admins UNKNOWN ⇒ crit, not ok — unknown outranks a pass",
  () => {
    const row = buildTargetCheck(
      "use-template.py",
      "example/target-py",
      "main",
      { verdict: "verifiable", reason: "required-status-checks-present", contexts: ["CI"] },
      { verdict: "unknown", reason: "enforce-admins-key-absent" },
    );
    return (row.status === "crit" && /protection UNKNOWN/.test(row.detail)) || JSON.stringify(row);
  },
);

await check(
  "failclosed/classifier-unavailable-reports-unknown-not-a-local-verdict",
  "with the SSOT classifier unloadable every target is UNKNOWN, never locally re-derived",
  async () => {
    const { checks } = await runTargetChecks({
      exec: okExec(PROTECTED_BODY),
      config: { remote_links: { "build.py": { org: "example", repo: "target-build" } } },
      configError: null,
      base: "main",
      classifyChecks: null,
    });
    const row = checks.find((c) => c.id === "gate2-target:build.py");
    return (
      (row.status === "crit" && row.required_checks.reason === "verifiability-classifier-unavailable") ||
      JSON.stringify(row)
    );
  },
);

await check(
  "failclosed/malformed-ecosystem-config-is-not-zero-targets",
  "a config that failed to load reports crit, NOT the same output as an unconfigured clone",
  () => {
    const broken = configErrorRow("Unexpected token } in JSON at position 42");
    const unconfigured = notProbedRow({ remote_links: {} }, null);
    return (
      (broken.status === "crit" &&
        /failed to load/.test(broken.detail) &&
        unconfigured === null) ||
      JSON.stringify({ broken, unconfigured })
    );
  },
);

// ── ENUMERATION — which repos count as Gate-2 targets ────────────────────────

await check(
  "enumerate/build-and-use-template-keys-only",
  "build.* + use-template.* are targets; loom/atelier/command are NOT",
  () => {
    const t = enumerateGate2Targets({
      remote_links: {
        "build.py": { org: "example", repo: "target-build" },
        "use-template.rs": { org: "example", repo: "target-rs" },
        loom: { org: "example", repo: "orchestrator" },
        atelier: { org: "example", repo: "studio" },
        command: { org: "example", repo: "console" },
      },
    });
    return (
      JSON.stringify(t.map((x) => x.key)) === '["build.py","use-template.rs"]' || JSON.stringify(t)
    );
  },
);

await check(
  "enumerate/slug-is-org-slash-repo-and-incomplete-entries-are-dropped",
  "a target with no org or no repo yields no slug rather than a malformed one",
  () => {
    const t = enumerateGate2Targets({
      remote_links: {
        "build.py": { org: "example", repo: "target-build" },
        "build.rs": { org: "example" },
        "use-template.py": { repo: "coc-py" },
      },
    });
    return (
      (t.length === 1 && t[0].slug === "example/target-build") || JSON.stringify(t)
    );
  },
);

await check(
  "enumerate/no-config-yields-no-targets-and-no-row",
  "an absent ecosystem config yields zero targets and NO not-probed row (a consumer clone)",
  () => {
    return (
      (enumerateGate2Targets(null).length === 0 && notProbedRow(null, null) === null) ||
      "null config produced targets or a row"
    );
  },
);

// ── WIRING — a correct classifier nothing calls is the shape this prevents ──

await check(
  "wiring/probe-is-opt-in-and-off-by-default",
  "--targets defaults to false, so an unattended `loom doctor` makes no cross-repo call",
  () => {
    return (
      (parseFlags([]).targets === false &&
        parseFlags(["--json", "--strict"]).targets === false &&
        parseFlags(["--targets"]).targets === true) ||
      JSON.stringify(parseFlags([]))
    );
  },
);

await check(
  "wiring/not-probed-row-is-emitted-rather-than-omitted",
  "a default run at a clone WITH targets still prints a row saying it did NOT probe",
  () => {
    const row = notProbedRow(
      { remote_links: { "build.py": { org: "example", repo: "target-one" }, "use-template.py": { org: "example", repo: "target-two" } } },
      null,
    );
    return (
      (row !== null &&
        row.status === "info" &&
        row.probed === false &&
        /NOT PROBED/.test(row.detail) &&
        row.target_count === 2) ||
      JSON.stringify(row)
    );
  },
);

await check(
  "wiring/rollup-reads-the-rows-and-crit-propagates-to-the-summary",
  "a crit target row makes the roll-up crit AND raises result.summary.crit (so --strict exits 1)",
  async () => {
    const { checks } = await runTargetChecks({
      exec: errExec("gh: Branch not protected (HTTP 404)"),
      config: {
        remote_links: {
          "build.py": { org: "example", repo: "target-build" },
          "use-template.py": { org: "example", repo: "target-py" },
        },
      },
      configError: null,
      base: "main",
    });
    const rollup = checks.find((c) => c.id === "gate2-targets");
    const full = withTargetChecks({ schema_version: 1, checks: [], summary: {} }, checks);
    return (
      (rollup.status === "crit" &&
        /2 unprotected-or-UNKNOWN/.test(rollup.detail) &&
        full.summary.crit === 3) ||
      JSON.stringify({ rollup, summary: full.summary })
    );
  },
);

await check(
  "wiring/rollup-is-ok-only-when-every-row-is-ok",
  "the OTHER pole: all-protected rows roll up ok — the roll-up is not hardwired to crit",
  () => {
    const rows = [
      buildTargetCheck(
        "build.py",
        "example/target-build",
        "main",
        { verdict: "verifiable", reason: "required-status-checks-present", contexts: ["CI"] },
        { verdict: "on", reason: "enforce-admins-enabled" },
      ),
    ];
    const rollup = buildTargetsSummary(rows);
    return (
      (rollup.status === "ok" && /1 protected/.test(rollup.detail)) || JSON.stringify(rollup)
    );
  },
);

await check(
  "wiring/report-only-remediation-names-the-target-owner-not-a-loom-write",
  "an unprotected row's remediation directs the TARGET's owner and disclaims any loom write",
  () => {
    const row = buildTargetCheck(
      "use-template.py",
      "example/target-py",
      "main",
      { verdict: "unverifiable", reason: "no-branch-protection", contexts: [] },
      { verdict: "off", reason: "no-branch-protection" },
    );
    return (
      (/TARGET's owner/.test(row.remediation) &&
        /MUST NOT edit it/.test(row.remediation) &&
        /repo-scope-discipline/.test(row.remediation)) ||
      JSON.stringify(row.remediation)
    );
  },
);

await check(
  "failclosed/control-bytes-in-remote-text-are-escaped",
  "ESC/BEL in a gh failure line are rendered \\xNN, never written to the terminal raw",
  () => {
    const evil = `gh: HTTP 500 ${String.fromCharCode(27)}[31mRED${String.fromCharCode(27)}[0m${String.fromCharCode(7)}`;
    const p = probeTargetProtectionStrict(errExec(evil), "example/target-py", "main");
    return (
      (p.status === "error" &&
        !p.detail.includes(String.fromCharCode(27)) &&
        !p.detail.includes(String.fromCharCode(7)) &&
        p.detail.includes("\\x1b") &&
        p.detail.includes("\\x07")) ||
      JSON.stringify(p.detail)
    );
  },
);

await check(
  "wiring/fix-mode-still-reports-target-rows",
  "main() resolves the target rows BEFORE the --fix branch, so `--fix --targets` is not dropped",
  () => {
    const src = fs.readFileSync(DOCTOR, "utf8");
    const iRows = src.indexOf("const targetRows = flags.targets");
    const iFix = src.indexOf("if (flags.fix) {", iRows);
    const iFixReport = src.indexOf("formatFixReport(fix)", iFix);
    if (iRows < 0 || iFix < 0) return `targetRows=${iRows} fixBranch=${iFix}`;
    // The rows must be computed first AND the fix branch must fold them in.
    const foldsIn = /withTargetChecks\(runDoctor\(\), targetRows\)/.test(src);
    return (
      (iRows < iFix && iFixReport > iFix && foldsIn) ||
      `rows=${iRows} fix=${iFix} report=${iFixReport} foldsIn=${foldsIn}`
    );
  },
);

// ── --target-repo: an ALLOWLIST, never a free-form slug ─────────────────────
//
// The flag exists so the live known-answer control is one command instead of a
// hand-written script. That convenience must not become an arbitrary cross-repo
// READ affordance sitting OUTSIDE the /cross-repo-authorize ceremony — an escape
// hatch that also escapes its own authorization is a worse defect than the gap it
// closes. These cases pin BOTH poles: what it accepts, and that a refusal costs
// zero API calls.

const CFG_MIXED = {
  remote_links: {
    "build.py": { org: "example", repo: "target-build" },
    "use-template.py": { org: "example", repo: "target-py" },
    // NOT Gate-2 targets — present in remote_links, excluded from the enumeration.
    loom: { org: "example", repo: "orchestrator" },
    atelier: { org: "example", repo: "studio" },
  },
};

await check(
  "targetrepo/accepts-a-declared-resolver-key",
  "a declared key resolves to its slug",
  () => {
    const r = resolveTargetRepoArg("use-template.py", CFG_MIXED, null);
    return (r.ok && r.key === "use-template.py" && r.slug === "example/target-py") || JSON.stringify(r);
  },
);

await check(
  "targetrepo/accepts-a-declared-slug",
  "the owner/repo form of a declared target resolves to the same entry",
  () => {
    const r = resolveTargetRepoArg("example/target-build", CFG_MIXED, null);
    return (r.ok && r.key === "build.py") || JSON.stringify(r);
  },
);

await check(
  "targetrepo/accepts-own-origin-as-self",
  "this repo's own origin is accepted (it is not a cross-repo read) and keyed 'self'",
  () => {
    const r = resolveTargetRepoArg("example/its-own-repo", CFG_MIXED, "example/its-own-repo");
    return (r.ok && r.key === "self") || JSON.stringify(r);
  },
);

await check(
  "targetrepo/refuses-an-arbitrary-slug",
  "an undeclared owner/repo is REFUSED, with the allowlist named in the detail",
  () => {
    const r = resolveTargetRepoArg("evilcorp/secret", CFG_MIXED, "example/its-own-repo");
    return (
      (r.ok === false &&
        r.reason === "target-repo-not-allowlisted" &&
        /NO probe was issued/.test(r.detail)) ||
      JSON.stringify(r)
    );
  },
);

await check(
  "targetrepo/allowlist-EXCLUDES-non-enumerated-remote-links",
  "loom/atelier are declared in remote_links but are NOT Gate-2 targets — the flag must " +
    "NARROW the enumeration, never widen it past what --targets already reaches",
  () => {
    const byKey = resolveTargetRepoArg("loom", CFG_MIXED, null);
    const bySlug = resolveTargetRepoArg("example/studio", CFG_MIXED, null);
    return (
      (byKey.ok === false && bySlug.ok === false) ||
      JSON.stringify({ byKey, bySlug })
    );
  },
);

await check(
  "targetrepo/an-empty-value-is-refused-not-treated-as-all-targets",
  "`--target-repo ''` refuses rather than silently falling back to the full fan-out",
  () => {
    const r = resolveTargetRepoArg("", CFG_MIXED, "example/its-own-repo");
    return (r.ok === false && r.reason === "target-repo-empty") || JSON.stringify(r);
  },
);

await check(
  "targetrepo/refusal-costs-ZERO-gh-api-calls",
  "a refused --target-repo issues no `gh api` call at all — the fence sits BEFORE the probe",
  async () => {
    const calls = [];
    const countingExec = (cmd, args) => {
      calls.push(`${cmd} ${(args || []).join(" ")}`);
      if (cmd === "git") return { ok: true, missing: false, code: 0, stdout: "git@github.com:example/its-own-repo.git", stderr: "" };
      return { ok: true, missing: false, code: 0, stdout: "{}", stderr: "" };
    };
    const { checks } = await runTargetChecks({
      exec: countingExec,
      config: CFG_MIXED,
      configError: null,
      targetRepo: "evilcorp/secret",
      base: "main",
    });
    const apiCalls = calls.filter((c) => c.startsWith("gh api"));
    return (
      (apiCalls.length === 0 &&
        checks.length === 1 &&
        checks[0].status === "crit" &&
        checks[0].probed === false &&
        /REFUSED/.test(checks[0].detail)) ||
      JSON.stringify({ apiCalls, checks })
    );
  },
);

await check(
  "targetrepo/an-allowlisted-value-DOES-probe",
  "the other pole: an allowlisted target still issues its probes — the fence is not a blanket off-switch",
  async () => {
    const calls = [];
    const exec = (cmd, args) => {
      calls.push(`${cmd} ${(args || []).join(" ")}`);
      if (cmd === "git") return { ok: true, missing: false, code: 0, stdout: "git@github.com:example/its-own-repo.git", stderr: "" };
      return {
        ok: true, missing: false, code: 0, stderr: "",
        stdout: JSON.stringify({
          required_status_checks: { contexts: ["CI"] },
          enforce_admins: { enabled: true },
        }),
      };
    };
    const { checks } = await runTargetChecks({
      exec, config: CFG_MIXED, configError: null, targetRepo: "use-template.py", base: "main",
    });
    const row = checks.find((c) => c.id === "gate2-target:use-template.py");
    return (
      (calls.filter((c) => c.startsWith("gh api")).length === 1 && row && row.status === "ok") ||
      JSON.stringify({ calls, checks })
    );
  },
);

await check(
  "targetrepo/own-origin-slug-parsed-from-BOTH-url-forms",
  "ssh and https remotes both yield owner/repo; an unparseable remote yields null (no match)",
  () => {
    const mk = (stdout, ok = true) => () => ({ ok, missing: false, code: ok ? 0 : 1, stdout, stderr: "" });
    return (
      (ownOriginSlug(mk("git@github.com:example-org/loom.git")) === "example-org/loom" &&
        ownOriginSlug(mk("https://github.com/example-org/loom.git")) === "example-org/loom" &&
        ownOriginSlug(mk("https://github.com/example-org/loom")) === "example-org/loom" &&
        ownOriginSlug(mk("not-a-url")) === null &&
        ownOriginSlug(mk("", false)) === null) ||
      [
        ownOriginSlug(mk("git@github.com:example-org/loom.git")),
        ownOriginSlug(mk("https://github.com/example-org/loom.git")),
        ownOriginSlug(mk("https://github.com/example-org/loom")),
        ownOriginSlug(mk("not-a-url")),
      ].join(" | ")
    );
  },
);

await check(
  "wiring/target-repo-implies-targets",
  "--target-repo turns the probe ON — naming a target and silently not probing is the " +
    "accepted-but-unused shape (zero-tolerance Rule 3c)",
  () => {
    const a = parseFlags(["--target-repo", "use-template.py"]);
    const b = parseFlags(["--target-repo=use-template.py"]);
    return (
      (a.targets === true && a.targetRepo === "use-template.py" &&
        b.targets === true && b.targetRepo === "use-template.py") ||
      JSON.stringify({ a, b })
    );
  },
);

// ── B-1: the BASE ref is interpolated into the API path, so it is fenced too ──
//
// `--target-repo` allowlists the REPO half of `repos/<slug>/branches/<base>/protection`.
// The BASE half was free-form, on the one check that leaves this repo — un-allowlisted
// reach on exactly the axis the repo fence was written to deny. A `..` segment in `base`
// walks out of the intended path entirely:
//
//   --target-base "main/protection/../../../../evil/repo/branches/main"
//   → gh api repos/<org>/<repo>/branches/main/protection/../../../../evil/repo/branches/main/protection
//
// Whether a given client collapses `..` before sending is NOT what makes this a defect:
// rejecting a traversal segment in a path component you interpolate is correct
// regardless, and settling the client question needs a live request to a non-CWD repo
// this lane holds no receipt for. So these poles assert the REFUSAL, never the wire
// behaviour.
//
// The fence is deliberately NOT "no slashes" — branch names legitimately contain `/`
// (`release/v1.2.3`), and the compliant pole below exists so a blanket ban reds.

/** exec seam that RECORDS every invocation, so "no call was made" is measurable. */
function recordingExec(calls, stdout) {
  return (cmd, args) => {
    calls.push(`${cmd} ${(args || []).join(" ")}`);
    if (cmd === "git")
      return { ok: true, missing: false, code: 0, stdout: "git@github.com:example/its-own-repo.git", stderr: "" };
    return { ok: true, missing: false, code: 0, stdout, stderr: "" };
  };
}
const CFG_ONE = { remote_links: { "use-template.py": { org: "example", repo: "target-py" } } };

await check(
  "base/traversal-segment-is-refused-BEFORE-any-probe",
  "a `..` segment in --target-base is refused at crit with ZERO gh api calls",
  async () => {
    const calls = [];
    const { checks } = await runTargetChecks({
      exec: recordingExec(calls, PROTECTED_BODY),
      config: CFG_ONE,
      configError: null,
      base: "main/protection/../../../../evil/repo/branches/main",
    });
    const api = calls.filter((c) => c.startsWith("gh api"));
    return (
      (api.length === 0 && checks.some((c) => c.status === "crit" && /REFUSED/.test(c.detail))) ||
      JSON.stringify({ api, checks: checks.map((c) => [c.status, c.detail]) })
    );
  },
);

await check(
  "base/percent-encoded-traversal-is-refused",
  "`%2e%2e` must not survive as a traversal the server decodes after we validated",
  async () => {
    const calls = [];
    const { checks } = await runTargetChecks({
      exec: recordingExec(calls, PROTECTED_BODY),
      config: CFG_ONE,
      configError: null,
      base: "main%2e%2e%2f%2e%2e%2fevil",
    });
    return (
      (calls.filter((c) => c.startsWith("gh api")).length === 0 &&
        checks.some((c) => c.status === "crit")) ||
      JSON.stringify({ calls, checks: checks.map((c) => [c.status, c.detail]) })
    );
  },
);

await check(
  "base/control-chars-query-and-fragment-are-refused",
  "newline / space / `?` / `#` / `~` / `:` in a base ref are refused (argv + URL smuggling)",
  async () => {
    const bad = ["main\nX", "main other", "main?x=1", "main#frag", "ma~in", "ma:in", "main..x", "", "/main", "main/", "a//b", "main.lock"];
    const results = [];
    for (const b of bad) {
      const calls = [];
      const { checks } = await runTargetChecks({
        exec: recordingExec(calls, PROTECTED_BODY),
        config: CFG_ONE,
        configError: null,
        base: b,
      });
      const refused =
        calls.filter((c) => c.startsWith("gh api")).length === 0 &&
        checks.some((c) => c.status === "crit");
      if (!refused) results.push(JSON.stringify(b));
    }
    return results.length === 0 || `these were NOT refused: ${results.join(", ")}`;
  },
);

await check(
  "base/a-LEGITIMATE-slashed-branch-is-accepted",
  "the compliant pole: `release/v1.2.3` is a real branch name and MUST still probe — " +
    "a blanket slash ban would be the wrong fix and reds here",
  async () => {
    const calls = [];
    const { checks } = await runTargetChecks({
      exec: recordingExec(calls, PROTECTED_BODY),
      config: CFG_ONE,
      configError: null,
      base: "release/v1.2.3",
    });
    const api = calls.filter((c) => c.startsWith("gh api"));
    const row = checks.find((c) => c.id === "gate2-target:use-template.py");
    return (
      (api.length === 1 &&
        api[0].includes("branches/release/v1.2.3/protection") &&
        row.status === "ok") ||
      JSON.stringify({ api, row })
    );
  },
);

await check(
  "base/the-SINK-validates-too-not-only-the-flag-boundary",
  "probeTargetProtectionStrict refuses a traversal base even when called directly — the " +
    "branch name can also arrive from the API, and a future caller must not be able to bypass",
  () => {
    const calls = [];
    const p = probeTargetProtectionStrict(
      recordingExec(calls, PROTECTED_BODY),
      "example/target-py",
      "main/../../evil",
    );
    return (
      (p.status === "error" &&
        calls.filter((c) => c.startsWith("gh api")).length === 0 &&
        /base/i.test(p.detail)) ||
      JSON.stringify({ status: p.status, detail: p.detail, calls })
    );
  },
);

const total = pass + failures.length;
console.log(`\ndoctor-target-protection: ${pass}/${total} PASS`);
if (failures.length > 0) {
  console.log(`FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
