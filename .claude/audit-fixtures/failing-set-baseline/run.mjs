#!/usr/bin/env node
/*
 * Audit fixture runner for `.claude/bin/check-failing-set.mjs`
 * (cc-artifacts.md Rule 9 + instrument-bipolarity.md MUST-1/2).
 *
 * WHY A POLE PAIR IS MANDATORY HERE
 *   This check CAN GATE — `scripts/ci/dev-preflight.mjs` withholds the push
 *   receipt on its verdict. `instrument-bipolarity.md` MUST-1 therefore requires
 *   both poles executable by the harness that runs the check, with the harness
 *   ASSERTING THE VERDICTS DIFFER. A green from an instrument never shown to red
 *   is consistent with a working check and with one that cannot fail.
 *
 * MUST-2 — THE RED POLES NAME AN IDENTITY, NOT A QUANTITY
 *   Every red assertion below matches the OBSERVED failure against a named unit
 *   id (`introduced` / `resolved` membership), never merely "exit != 0" or a
 *   count. Three of the three obvious repairs to a quantity-only pole survive
 *   vacuously; a named identity does not.
 *
 * THE THREE ARMS, one pole pair each:
 *   A. INTRODUCED — a unit failing that no signed row covers MUST block, named.
 *   B. INHERITED  — only baselined units failing MUST pass (the receipt-writing
 *                   case; this is the whole point of the mechanism).
 *   C. RESOLVED   — a baselined unit that now PASSES MUST block, demanding the
 *                   row be deleted. This is the may-only-FALL arm and the teeth:
 *                   without it the baseline only ever grows.
 *
 * Plus the signature contract, which is the half a naive implementation gets
 * wrong: an UNSIGNED row must grant NO amnesty, so that appending a row under
 * someone else's acceptance buys the appender nothing.
 *
 * Structural probes only: equality and membership over pure-function outputs,
 * plus end-to-end exit codes from the real CLI. No semantic judgment, no regex
 * over prose, no network, no git.
 *
 * Exit 0 = all fixtures pass. Exit 1 = >=1 fixture failed.
 */

import "../_lib/no-ambient-git.cjs";
import { compareFailingSet, validateRow, loadBaseline, DEFAULT_BASELINE } from "../../bin/check-failing-set.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const CHECKER = join(REPO_ROOT, ".claude", "bin", "check-failing-set.mjs");

let passed = 0;
let failed = 0;

function check(name, condition, details) {
  if (condition) {
    passed++;
    process.stdout.write(`  PASS  ${name}\n`);
  } else {
    failed++;
    process.stderr.write(`  FAIL  ${name}\n`);
    if (details) process.stderr.write(`        ${details}\n`);
  }
}

/** A fully-formed, signed row. Individual fixtures degrade a copy of it. */
function signedRow(over = {}) {
  return {
    check_id: "corpus-tests",
    check_group: "corpus-tests",
    unit_kind: "harness-suite",
    attribution: "BISECTED",
    introduced_by: "0123456789abcdef0123456789abcdef01234567",
    failing_before: "89abcdef0123456789abcdef0123456789abcdef",
    reason: "a reason long enough to clear the thirty-character floor this registry applies",
    acceptance: {
      accepted_by: "someoperator — co-owner",
      accepted_on: "2026-09-13",
      accepted_what:
        "this population only, accepted as declared-not-blocking and not as a licence to append",
      verbatim: "sign it, go",
    },
    ...over,
  };
}

const ROWS = { "corpus-tests::alpha.test.mjs": signedRow() };

// ==========================================================================
// ARM A — INTRODUCED. The red pole, named by IDENTITY.
// ==========================================================================
{
  const r = compareFailingSet({
    rows: ROWS,
    observed: ["corpus-tests::alpha.test.mjs", "corpus-tests::brand-new.test.mjs"],
  });
  check(
    "fixture-01-introduced-unit-blocks",
    r.blocking === true,
    `blocking=${r.blocking}`,
  );
  check(
    "fixture-02-introduced-names-the-identity-not-a-count",
    r.introduced.length === 1 && r.introduced[0] === "corpus-tests::brand-new.test.mjs",
    `introduced=${JSON.stringify(r.introduced)}`,
  );
  check(
    "fixture-03-introduced-does-not-swallow-the-inherited-one",
    r.inherited.length === 1 && r.inherited[0] === "corpus-tests::alpha.test.mjs",
    `inherited=${JSON.stringify(r.inherited)}`,
  );
}

// ==========================================================================
// ARM B — INHERITED ONLY. The green pole.
// ==========================================================================
{
  const r = compareFailingSet({ rows: ROWS, observed: ["corpus-tests::alpha.test.mjs"] });
  check("fixture-04-inherited-only-does-not-block", r.blocking === false, `blocking=${r.blocking}`);
  check(
    "fixture-05-inherited-only-reports-zero-introduced-and-zero-resolved",
    r.introduced.length === 0 && r.resolved.length === 0,
    `introduced=${JSON.stringify(r.introduced)} resolved=${JSON.stringify(r.resolved)}`,
  );
}

// ==========================================================================
// ARM C — RESOLVED (may-only-FALL). The teeth.
// ==========================================================================
{
  const r = compareFailingSet({ rows: ROWS, observed: [] });
  check("fixture-06-baselined-unit-that-now-passes-blocks", r.blocking === true, `blocking=${r.blocking}`);
  check(
    "fixture-07-resolved-names-the-row-to-delete",
    r.resolved.length === 1 && r.resolved[0] === "corpus-tests::alpha.test.mjs",
    `resolved=${JSON.stringify(r.resolved)}`,
  );
}

// ==========================================================================
// BIPOLARITY ASSERTION (MUST-1) — the three arms' verdicts must DIFFER.
// Identical verdicts is a VACUOUS pair and must itself fail.
// ==========================================================================
{
  const introduced = compareFailingSet({
    rows: ROWS,
    observed: ["corpus-tests::alpha.test.mjs", "corpus-tests::brand-new.test.mjs"],
  });
  const inherited = compareFailingSet({ rows: ROWS, observed: ["corpus-tests::alpha.test.mjs"] });
  const resolved = compareFailingSet({ rows: ROWS, observed: [] });
  check(
    "fixture-08-poles-differ-green-vs-introduced",
    inherited.blocking !== introduced.blocking,
    "a green pole and an introduced pole returned the SAME verdict — vacuous pair",
  );
  check(
    "fixture-09-poles-differ-green-vs-resolved",
    inherited.blocking !== resolved.blocking,
    "a green pole and a resolved pole returned the SAME verdict — the may-only-fall arm is DISARMED",
  );
  check(
    "fixture-10-the-two-red-poles-red-for-DIFFERENT-named-reasons",
    introduced.introduced.length === 1 &&
      introduced.resolved.length === 0 &&
      resolved.resolved.length === 1 &&
      resolved.introduced.length === 0,
    "the two red poles must be distinguishable by reason, not merely both non-green",
  );
}

// ==========================================================================
// SIGNATURE CONTRACT — an UNSIGNED row grants NO amnesty.
// This is the arm that makes "append a row under an existing signature" inert.
// ==========================================================================
{
  const noAcc = signedRow();
  delete noAcc.acceptance;
  const rows = { "corpus-tests::alpha.test.mjs": noAcc };
  const r = compareFailingSet({ rows, observed: ["corpus-tests::alpha.test.mjs"] });
  check(
    "fixture-11-unsigned-row-grants-no-amnesty",
    r.blocking === true && r.introduced.includes("corpus-tests::alpha.test.mjs"),
    `introduced=${JSON.stringify(r.introduced)} inherited=${JSON.stringify(r.inherited)}`,
  );
  check(
    "fixture-12-unsigned-row-is-named-as-unsigned-not-as-a-mystery",
    r.unsigned_and_failing.includes("corpus-tests::alpha.test.mjs"),
    `unsigned_and_failing=${JSON.stringify(r.unsigned_and_failing)}`,
  );
}
{
  // A PARTIAL acceptance signs nothing — each field individually required.
  for (const f of ["accepted_by", "accepted_on", "accepted_what", "verbatim"]) {
    const row = signedRow();
    delete row.acceptance[f];
    const v = validateRow("x", row);
    check(
      `fixture-13-partial-acceptance-missing-${f}-does-not-sign`,
      v.signed === false,
      `signed=${v.signed} problems=${JSON.stringify(v.acceptance_problems)}`,
    );
  }
}
{
  // A one-line accepted_what cannot express a scope, so it does not sign.
  const row = signedRow();
  row.acceptance.accepted_what = "fine";
  check("fixture-14-token-accepted_what-does-not-sign", validateRow("x", row).signed === false);
  const row2 = signedRow();
  row2.acceptance.accepted_on = "13-09-2026";
  check("fixture-15-non-iso-accepted_on-does-not-sign", validateRow("x", row2).signed === false);
}

// ==========================================================================
// ROW VALIDITY — the attribution and pre-session fence are STRUCTURAL.
// ==========================================================================
{
  const missingFence = signedRow({ failing_before: undefined });
  check(
    "fixture-16-row-without-failing_before-is-invalid",
    validateRow("x", missingFence).valid === false,
  );
  const badAttr = signedRow({ attribution: "probably old" });
  check("fixture-17-freeform-attribution-is-invalid", validateRow("x", badAttr).valid === false);
  const unknownOk = signedRow({ attribution: "UNKNOWN", introduced_by: undefined, searched_commits: 412 });
  check(
    "fixture-18-explicit-UNKNOWN-with-search-effort-is-valid",
    validateRow("x", unknownOk).valid === true,
    JSON.stringify(validateRow("x", unknownOk).problems),
  );
  const unknownBare = signedRow({ attribution: "UNKNOWN", introduced_by: undefined });
  check(
    "fixture-19-bare-UNKNOWN-without-search-effort-is-invalid",
    validateRow("x", unknownBare).valid === false,
  );
  const shortReason = signedRow({ reason: "old" });
  check("fixture-20-token-reason-is-invalid", validateRow("x", shortReason).valid === false);
  const invalidRows = { "corpus-tests::alpha.test.mjs": signedRow({ reason: "old" }) };
  const r = compareFailingSet({ rows: invalidRows, observed: ["corpus-tests::alpha.test.mjs"] });
  check(
    "fixture-21-invalid-row-blocks-and-grants-no-amnesty",
    r.blocking === true && r.introduced.includes("corpus-tests::alpha.test.mjs"),
    `introduced=${JSON.stringify(r.introduced)}`,
  );
}

// ==========================================================================
// SCOPE — arm 3's correctness condition. dev-preflight scopes its groups from
// the diff and narrows corpus-tests to the suites the diff owns, so on most runs
// MOST baselined units are never exercised. Scoring those as "started passing"
// would red the gate on every scoped run and demand the deletion of rows
// describing live failures — the fastest way to get this mechanism disabled.
// ==========================================================================
{
  const rows = {
    "corpus-tests::alpha.test.mjs": signedRow(),
    "corpus-tests::beta.test.mjs": signedRow(),
  };
  // beta was NOT exercised by this run. It must be UNKNOWN, not resolved.
  const r = compareFailingSet({
    rows,
    observed: ["corpus-tests::alpha.test.mjs"],
    scope: ["corpus-tests::alpha.test.mjs"],
  });
  check(
    "fixture-23a-unexercised-row-is-not-scored-as-now-passing",
    r.resolved.length === 0 && r.out_of_scope.includes("corpus-tests::beta.test.mjs"),
    `resolved=${JSON.stringify(r.resolved)} out_of_scope=${JSON.stringify(r.out_of_scope)}`,
  );
  check("fixture-23b-unexercised-row-does-not-block", r.blocking === false, `blocking=${r.blocking}`);
  // ...but a row that WAS exercised and passed still reds. Scope narrows the
  // arm; it must not disarm it.
  const r2 = compareFailingSet({
    rows,
    observed: [],
    scope: ["corpus-tests::alpha.test.mjs"],
  });
  check(
    "fixture-23c-scope-narrows-arm-3-without-disarming-it",
    r2.resolved.length === 1 &&
      r2.resolved[0] === "corpus-tests::alpha.test.mjs" &&
      r2.blocking === true,
    `resolved=${JSON.stringify(r2.resolved)} blocking=${r2.blocking}`,
  );
  // An OBSERVED unit is always in scope even if the caller forgot to list it —
  // otherwise a failing unit could be silently dropped from both arms.
  const r3 = compareFailingSet({
    rows,
    observed: ["corpus-tests::beta.test.mjs"],
    scope: ["corpus-tests::alpha.test.mjs"],
  });
  check(
    "fixture-23d-observed-unit-is-in-scope-even-if-unlisted",
    r3.inherited.includes("corpus-tests::beta.test.mjs"),
    `inherited=${JSON.stringify(r3.inherited)}`,
  );
}

// ==========================================================================
// FAIL-CLOSED ON UNRESOLVED IDENTITY — a check-id unit is never matched by a
// sub-unit row, so "I could not tell which suite failed" always blocks.
// ==========================================================================
{
  const r = compareFailingSet({ rows: ROWS, observed: ["corpus-tests"] });
  check(
    "fixture-22-bare-check-id-is-not-covered-by-a-sub-unit-row",
    r.introduced.includes("corpus-tests"),
    `introduced=${JSON.stringify(r.introduced)}`,
  );
}

// ==========================================================================
// END-TO-END — the real CLI, real baseline, real exit codes. The pure
// comparator could be right while the process wiring is wrong.
// ==========================================================================
{
  const live = loadBaseline(DEFAULT_BASELINE);
  check("fixture-23-live-baseline-parses", live.ok === true, live.why || "");
  check(
    "fixture-24-live-baseline-declared_row_count-reconciles",
    (live.count_problems || []).length === 0,
    JSON.stringify(live.count_problems),
  );

  const run = (args) =>
    spawnSync(process.execPath, [CHECKER, ...args], { cwd: REPO_ROOT, encoding: "utf8" });

  // ------------------------------------------------------------------------
  // THE E2E POLES RUN AGAINST A SYNTHETIC BASELINE, NOT THE LIVE ONE.
  //
  // They used to DERIVE their inputs from the live registry's signed rows:
  //
  //     const ids = allIds.filter((id) => validateRow(id, live.rows[id]).signed);
  //
  // That is the same shape the 25b block below was already rewritten to escape,
  // left half-finished: 25b synthesized its unsigned row, and 25/26/27/28/29/30
  // went on borrowing theirs. It broke exactly as predicted. The live registry's
  // LAST signed row was deleted when its suite started passing — which is the
  // `may-only-fall` arm doing its job, and the registry's own `_README` calls the
  // resulting empty population "the TIGHTENED state, not an unconfigured one".
  // `ids` became `[]`, and three cases fell over: 25a asserted `ids.length > 0`;
  // 29 ran `--observed "" --scope ""` and got exit 0 where it demanded 1; 30
  // looked for `ids[0]`, which was `undefined`.
  //
  // Worse, fixture-25 kept PASSING — vacuously. `--observed "" --scope ""` over
  // an empty baseline is a green that verifies nothing, and without 25a nothing
  // would have said so. A pole that disappears (or empties out) when the world
  // changes is the vacuous pair `instrument-bipolarity.md` MUST-1 forbids, and a
  // case that stops measuring while its suite still exits 0 is
  // `probe-driven-verification.md` MUST-7 — not-having-run spelled the same as a
  // substantive answer.
  //
  // So the whole pole set now drives a baseline this fixture OWNS: two
  // well-formed SIGNED rows (the amnesty the green pole needs, and the row the
  // may-only-fall pole demands be deleted) plus one well-formed UNSIGNED row.
  // Nothing here reads live state, so no signing or deletion in the live registry
  // can empty these poles again. Rows 23/24 above stay on the LIVE file, because
  // "it parses" and "its declared_row_count reconciles" are legitimately
  // questions about live state and are true of an empty registry.
  //
  // It is built FRESH rather than by mutating a copy of the live document: a
  // future live row that is INVALID sets `blocking` regardless of scope, which
  // would red the green pole for a reason none of these poles is about — the
  // same re-coupling being removed here.
  // ------------------------------------------------------------------------
  const SIGNED_A = "corpus-tests::synthetic-signed-alpha.test.mjs";
  const SIGNED_B = "corpus-tests::synthetic-signed-beta.test.mjs";
  const UNSIGNED = "corpus-tests::synthetic-unsigned-row.test.mjs";

  const syntheticRows = {
    [SIGNED_A]: signedRow(),
    [SIGNED_B]: signedRow(),
    // Same shape as a real row MINUS the `acceptance` block — an unsigned row is
    // exactly one whose acceptance is absent or incomplete.
    [UNSIGNED]: {
      check_id: "corpus-tests",
      check_group: "corpus-tests",
      unit_kind: "harness-suite",
      attribution: "UNKNOWN",
      // POSITIVE — `attribution: "UNKNOWN"` requires it, and a row that fails
      // validation is unsigned for the WRONG REASON. An earlier draft left this
      // 0: the row was still reported unsigned, so the pole still passed, but it
      // was then measuring "a MALFORMED row blocks" rather than "a WELL-FORMED
      // row with no acceptance blocks" — and the signature contract is the
      // second one. Caught only because mutating the row to signed failed to red
      // it (instrument-discipline.md MUST-5(b): an empty red-set is an inert
      // mutation until shown otherwise, never a vacuity verdict).
      searched_commits: 1,
      failing_before: "0000000000000000000000000000000000000000",
      direction_evidence: "synthetic fixture row; never a claim about history",
      reason:
        "synthetic well-formed row carrying NO acceptance block, so the only thing making it unsigned is the absent signature",
    },
  };

  // The signed subset the poles drive. Named explicitly rather than filtered out
  // of the document, so the set cannot quietly shrink to [] the way the live one
  // did; 25a below is the guard that the rows behind these ids really are signed.
  const ids = [SIGNED_A, SIGNED_B];

  const tmp = mkdtempSync(join(tmpdir(), "fsb-poles-"));
  try {
    const baselinePath = join(tmp, "failing-set-baseline.json");
    writeFileSync(
      baselinePath,
      JSON.stringify(
        {
          _README:
            "SYNTHETIC fixture baseline written by .claude/audit-fixtures/failing-set-baseline/run.mjs. " +
            "Never a declaration about this repo's real failing set.",
          declared_row_count: Object.keys(syntheticRows).length,
          baseline: syntheticRows,
        },
        null,
        2,
      ),
    );
    const runB = (args) => run(["--baseline", baselinePath, ...args]);

    // The anti-vacuity guard for the green pole, RE-POINTED at the baseline that
    // pole now drives. Deliberately NOT an assertion about the live registry: an
    // empty live registry is the TIGHTENED state, so a case demanding the live
    // file be non-empty is one the ratchet is designed to break. Here it is a
    // real guard — degrade an acceptance field on `signedRow()` and this reds
    // with the reason, instead of fixture-25 silently going green over nothing.
    check(
      "fixture-25a-synthetic-baseline-has-signed-rows-to-drive-the-green-pole",
      ids.length > 0 && ids.every((id) => validateRow(id, syntheticRows[id]).signed),
      `signed=${JSON.stringify(ids.map((id) => [id, validateRow(id, syntheticRows[id]).signed]))}`,
    );

    // An unsigned row's unit must be reported INTRODUCED even when it is observed
    // failing — this is what makes appending a row under someone else's
    // signature buy the appender nothing. The signed rows are observed alongside
    // it, so this pole and the green pole differ in exactly ONE variable: the
    // presence of the unsigned unit.
    const u = runB(["--observed", [...ids, UNSIGNED].join(","), "--json"]);
    let uj = null;
    try {
      uj = JSON.parse(u.stdout);
    } catch {}
    check(
      "fixture-25b-unsigned-rows-block-as-introduced",
      u.status === 1 && !!uj && (uj.introduced || []).includes(UNSIGNED),
      `status=${u.status} introduced=${uj ? JSON.stringify(uj.introduced) : "unparseable"}`,
    );

    // SCOPE is pinned to the signed subset throughout, so the unsigned row is
    // out-of-scope rather than scored as "now passing". Scoring it RESOLVED would
    // red every pole for a reason none of these poles is about.
    const green = runB(["--observed", ids.join(","), "--scope", ids.join(","), "--json"]);
    check(
      "fixture-25-e2e-green-pole-exits-0",
      green.status === 0,
      `status=${green.status} ${green.stderr}`,
    );
    let greenJson = null;
    try {
      greenJson = JSON.parse(green.stdout);
    } catch {}
    // The exit code alone cannot tell "amnesty was granted to two real units"
    // from "there was nothing to grant amnesty over" — which is precisely how the
    // old green stayed green while measuring nothing. Assert the WORK: both
    // signed units came back INHERITED, by identity.
    check(
      "fixture-25c-green-pole-inherited-both-signed-units-by-name",
      !!greenJson &&
        greenJson.inherited.length === 2 &&
        ids.every((id) => greenJson.inherited.includes(id)),
      `inherited=${greenJson ? JSON.stringify(greenJson.inherited) : "unparseable"}`,
    );

    const red = runB([
      "--observed",
      [...ids, "corpus-tests::not-a-real-suite.test.mjs"].join(","),
      "--scope",
      ids.join(","),
      "--json",
    ]);
    check("fixture-26-e2e-introduced-pole-exits-1", red.status === 1, `status=${red.status}`);
    let redJson = null;
    try {
      redJson = JSON.parse(red.stdout);
    } catch {}
    check(
      "fixture-27-e2e-red-pole-names-the-identity",
      !!redJson && redJson.introduced.includes("corpus-tests::not-a-real-suite.test.mjs"),
      `stdout=${String(red.stdout).slice(0, 200)}`,
    );
    check(
      "fixture-28-e2e-poles-differ",
      green.status !== red.status,
      `both exited ${green.status} — VACUOUS pair`,
    );

    // SIGNED_A is dropped from the observed set while staying IN SCOPE: it was
    // exercised and it passed, so its row has outlived its fact and must go.
    const fall = runB([
      "--observed",
      ids.slice(1).join(","),
      "--scope",
      ids.join(","),
      "--json",
    ]);
    check("fixture-29-e2e-may-only-fall-pole-exits-1", fall.status === 1, `status=${fall.status}`);
    let fallJson = null;
    try {
      fallJson = JSON.parse(fall.stdout);
    } catch {}
    check(
      "fixture-30-e2e-may-only-fall-names-the-row-to-delete",
      !!fallJson && fallJson.resolved.includes(ids[0]),
      `resolved=${fallJson ? JSON.stringify(fallJson.resolved) : "unparseable"}`,
    );

    // An ABSENT observed set must be UNRESOLVABLE (exit 2), never treated as an
    // empty one — an empty set would score every row RESOLVED and red for the
    // wrong reason.
    //
    // THE EXIT CODE ALONE IS NOT THE ASSERTION, and an earlier revision of this
    // case made it one. `.claude/bin/check-failing-set.mjs::main()` returns 2 from
    // FOUR distinct causes — an unknown argument (:339), an unreadable baseline
    // (:357), an unreadable `--observed-file` (:412), and this one (:421) — so
    // `status === 2` is equally satisfied by three refusals this case is not about,
    // which is the quantity-not-identity shape this suite's own header forbids.
    //
    // A prior comment here claimed that running against the synthetic baseline made
    // exit 2 mean ONLY "no observed set". That was FALSE and is withdrawn rather
    // than quietly dropped: choosing a readable input makes one cause unlikely, it
    // implements no discrimination, and the case still could not tell them apart.
    // MEASURED twice at the Tier-1 redteam that caught it — substituting an unknown
    // flag, and corrupting the synthetic baseline immediately before this call, each
    // left this case GREEN. The refusal's OWN words are what bind it now, the same
    // shape fixtures 27 and 30 already use for their arms.
    const none = runB(["--json"]);
    check(
      "fixture-31-absent-observed-set-is-exit-2-not-a-verdict",
      none.status === 2 && /Refusing to assume an EMPTY observed set/.test(none.stderr || ""),
      `status=${none.status} stderr=${JSON.stringify((none.stderr || "").slice(0, 160))}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ==========================================================================
process.stdout.write(`\nfailing-set-baseline fixtures: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
