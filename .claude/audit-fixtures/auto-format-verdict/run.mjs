#!/usr/bin/env node
/**
 * Bipolar poles for the THREE-VERDICT grading in
 * `.claude/audit-fixtures/auto-format/auto-format-scan.mjs` (cc-artifacts.md Rule 9,
 * instrument-bipolarity.md MUST-1/MUST-2).
 *
 * THE DEFECT THESE PIN. The scanner filtered `skipped` rows out of `checks` and then
 * graded on the remainder, so a CRITICAL arm that DID NOT RUN contributed nothing and
 * the scan graded CLEAN at exit 0. MEASURED on the authoring host with no fault
 * injection: the clean pole scored 6 of 15 checks — seven dispatch lanes and BOTH
 * `npx` arms never ran, the ANTI-VACUITY arm among them — and reported CLEAN. A check
 * that could not run was indistinguishable from one that ran and found nothing, which
 * is `instrument-discipline.md` MUST-1 and MUST-3(a) at the grading layer.
 *
 * WHY EVERY POLE RUNS UNDER AUTO_FORMAT_TOTAL_BUDGET_MS=1. The unrunnable condition is
 * the SUBJECT here, so it is INDUCED deterministically rather than waited for. It also
 * keeps the suite at milliseconds: the natural reproduction costs ~22s because the hook
 * itself reaches for `npx` on every dispatch lane.
 *
 * EVERY ASSERTION IS AN IDENTITY, NEVER A CARDINALITY. This repo has a measured case
 * where a pole asserting `count > 0` stayed GREEN while the defect it pinned returned,
 * because deleting the pinned code moved the count 3 -> 2. So these poles name the
 * check-id they expect and the partition they expect it in; a count would pass on the
 * wrong twelve checks just as happily as on the right ones.
 */
import "../_lib/no-ambient-git.cjs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const SCANNER = path.join(REPO, ".claude", "audit-fixtures", "auto-format", "auto-format-scan.mjs");

let failures = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log(`PASS ${name}`);
  else {
    console.log(`FAIL ${name}`);
    console.log(`     ${detail}`);
    failures += 1;
  }
};

/** Drive the REAL scanner against a case dir under an exhausted budget. */
function scan(caseName) {
  const root = path.join(HERE, caseName);
  let stdout = "";
  let status = 0;
  try {
    stdout = execFileSync("node", [SCANNER, "--root", root, "--json"], {
      encoding: "utf8",
      env: { ...process.env, AUTO_FORMAT_TOTAL_BUDGET_MS: "1" },
    });
  } catch (e) {
    // A non-zero exit is the EXPECTED outcome for three of these poles, so it is
    // read, never rethrown. A signal kill leaves `status` non-numeric; surface that
    // as its own value rather than letting it read as an ordinary verdict.
    status = typeof e.status === "number" ? e.status : `non-numeric(${e.signal ?? e.code})`;
    stdout = e.stdout ?? "";
  }
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = null;
  }
  return { status, parsed, stdout };
}

const ids = (list) => (Array.isArray(list) ? list.map((r) => (typeof r === "string" ? r : r.id)) : []);

// ── POLE 1 (RED) — an UNDECLARED did-not-run must NOT grade CLEAN ──────────────
// This is the regression case for the defect itself. Pre-fix: CLEAN / exit 0.
{
  const { status, parsed } = scan("incomplete-undeclared-skip");
  ok("incomplete-undeclared-skip: grade is INCOMPLETE", parsed?.grade === "INCOMPLETE", `got grade ${parsed?.grade}`);
  ok("incomplete-undeclared-skip: exit status is 2", status === 2, `got exit ${status}`);
  ok("incomplete-undeclared-skip: passed is false", parsed?.passed === false, `got passed ${parsed?.passed}`);
  ok(
    "incomplete-undeclared-skip: NAMES the anti-vacuity arm as undeclared-did-not-run",
    ids(parsed?.did_not_run_undeclared).includes("red-pole-payload-corrupts"),
    `did_not_run_undeclared = [${ids(parsed?.did_not_run_undeclared).join(", ")}]`,
  );
  ok(
    "incomplete-undeclared-skip: the unrun arm is NOT counted among scored checks",
    !ids(parsed?.checks).includes("red-pole-payload-corrupts"),
    `checks = [${ids(parsed?.checks).join(", ")}]`,
  );
}

// ── POLE 2 (GREEN) — a DECLARED did-not-run relaxes the EXIT, never the DISCLOSURE ──
// Byte-identical expectation and environment to POLE 1; separates only on the
// declaration, which is the most-similar-point convergence this pair is built for.
{
  const { status, parsed } = scan("clean-declared-toleration");
  ok("clean-declared-toleration: grade is CLEAN", parsed?.grade === "CLEAN", `got grade ${parsed?.grade}`);
  ok("clean-declared-toleration: exit status is 0", status === 0, `got exit ${status}`);
  ok(
    "clean-declared-toleration: nothing is left UNDECLARED",
    ids(parsed?.did_not_run_undeclared).length === 0,
    `did_not_run_undeclared = [${ids(parsed?.did_not_run_undeclared).join(", ")}]`,
  );
  ok(
    "clean-declared-toleration: the green STILL NAMES the anti-vacuity arm as unrun",
    ids(parsed?.did_not_run).includes("red-pole-payload-corrupts"),
    `did_not_run = [${ids(parsed?.did_not_run).join(", ")}]`,
  );
  ok(
    "clean-declared-toleration: the message discloses the unrun arms rather than claiming full coverage",
    typeof parsed?.message === "string" && parsed.message.includes("red-pole-payload-corrupts"),
    `message = ${parsed?.message}`,
  );
}

// ── POLE 3 — a FAILURE is an ANSWER and outranks a did-not-run ─────────────────
{
  const { status, parsed } = scan("invalid-outranks-did-not-run");
  ok("invalid-outranks-did-not-run: grade is INVALID", parsed?.grade === "INVALID", `got grade ${parsed?.grade}`);
  ok("invalid-outranks-did-not-run: exit status is 1", status === 1, `got exit ${status}`);
  ok(
    "invalid-outranks-did-not-run: pins the FAILING check by identity",
    ids(parsed?.critical_failures).includes("pin-no-bare-call-sites"),
    `critical_failures = [${ids(parsed?.critical_failures).join(", ")}]`,
  );
  ok(
    "invalid-outranks-did-not-run: did-not-run arms are still present, and did NOT win the grade",
    ids(parsed?.did_not_run).includes("red-pole-payload-corrupts") && parsed?.grade === "INVALID",
    `grade=${parsed?.grade} did_not_run=[${ids(parsed?.did_not_run).join(", ")}]`,
  );
}

// ── POLE 4 — NOT-APPLICABLE is a distinct partition from DID-NOT-RUN ───────────
{
  const { parsed } = scan("not-applicable-is-not-did-not-run");
  ok(
    "not-applicable-is-not-did-not-run: md-byte-identical is NOT-APPLICABLE",
    ids(parsed?.not_applicable).includes("md-byte-identical"),
    `not_applicable = [${ids(parsed?.not_applicable).join(", ")}]`,
  );
  ok(
    "not-applicable-is-not-did-not-run: md-byte-identical is NOT reported as did-not-run",
    !ids(parsed?.did_not_run).includes("md-byte-identical"),
    `did_not_run = [${ids(parsed?.did_not_run).join(", ")}]`,
  );
  ok(
    "not-applicable-is-not-did-not-run: its budget-killed sibling IS reported as did-not-run",
    ids(parsed?.did_not_run).includes("dispatch-md-refused"),
    `did_not_run = [${ids(parsed?.did_not_run).join(", ")}]`,
  );
}

// ── POLE 5 — a waiver naming no real check is REFUSED, not accepted as inert ───
{
  const { status, parsed } = scan("refuse-unknown-tolerated-id");
  ok("refuse-unknown-tolerated-id: exit status is 1", status === 1, `got exit ${status}`);
  ok("refuse-unknown-tolerated-id: grade is INVALID", parsed?.grade === "INVALID", `got grade ${parsed?.grade}`);
  ok(
    "refuse-unknown-tolerated-id: names the unknown id in the refusal",
    typeof parsed?.message === "string" && parsed.message.includes("no-such-check-id"),
    `message = ${parsed?.message}`,
  );
}

console.log(failures === 0 ? `\nAll poles held (${failures} failures).` : `\n${failures} pole assertion(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
