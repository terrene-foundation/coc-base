#!/usr/bin/env node
/**
 * auto-format-scan — the eval-manifest SCANNER surface for the auto-format
 * fixture suite (`coc-eval-core.mjs::runEvalHarness`).
 *
 * INVOCATION MODEL, which is the whole reason this file exists:
 *   node auto-format-scan.mjs --root <fixture-case-dir> --json
 * `runEvalHarness` execs this once per key in the manifest entry's `expected`
 * map, handing each key's DIRECTORY as `--root`, and compares the process exit
 * code (plus `grade` / `passed` / failing `critical` check ids) against that
 * key's declared disposition.
 *
 * WHAT A FIXTURE CASE DIRECTORY HOLDS — AND WHAT IT DELIBERATELY DOES NOT.
 * It holds ONE file, `expect.json`: a partial expectation map over the LIVE hook
 * at `<repo>/.claude/hooks/auto-format.js`. It does NOT hold a copy of the hook.
 * A fixture carrying its own copy of the subject would agree with itself by
 * construction — the self-derived oracle `evidence-first-claims.md` MUST-5 blocks,
 * and the precise defect `bin/verdict.mjs` records having shipped in its own
 * fixture path and then removed ("mutating main()'s exit to a constant 0 left the
 * suite 4/4 green"). Because every case drives the LIVE hook, re-adding ".md" to
 * the extension list reds BOTH poles from opposite directions: the clean case
 * starts failing, and the violation case starts PASSING its own assertion and so
 * mismatches its declared `exit: 1`.
 *
 * BIPOLARITY (coc-manifest-integrity check (h)) is therefore asserted against the
 * live subject, not against a frozen decoy: the violation pole declares an
 * expectation the hook MUST NOT satisfy, and the scanner is required to report it
 * non-zero. That is the opposite-verdict capability MUST-5 requires before any
 * green from this instrument is banked.
 *
 * THREE VERDICTS, BECAUSE TWO CANNOT TELL A SKIP FROM A PASS. A check that DID NOT
 * RUN is graded apart from one that ran and passed, in the OUTPUT and in the EXIT
 * STATUS both: 0/CLEAN every applicable critical check ran and passed; 1/INVALID at
 * least one RAN and failed; 2/INCOMPLETE nothing failed but an applicable critical
 * check did not run. A FAILURE outranks a did-not-run - it is an answer.
 *
 * CORRECTED, and the superseded text is quoted rather than smoothed away. This block
 * read: "Two arms (pin resolution, anti-vacuity) need `npx`; when it is unreachable
 * they return `skipped` and are scored by NEITHER polarity, so the exit code is
 * identical online and offline." The MECHANISM was described accurately and the
 * CONCLUSION was the defect: an exit code identical online and offline is precisely an
 * instrument that cannot report what it failed to observe (`instrument-discipline.md`
 * MUST-1 and MUST-3(a) - silence about a class the instrument never observed is not a
 * true negative). MEASURED on the authoring host, with no env override and no fault
 * injection, the clean pole graded CLEAN at exit 0 having scored 6 of 15 checks: the
 * aggregate budget was spent inside the dispatch loop (the hook itself reaches for
 * `npx`), so seven dispatch lanes plus BOTH `npx` arms never ran, the anti-vacuity arm
 * among them - the one whose absence makes the markdown pole satisfiable by a payload
 * prettier would not have touched anyway.
 *
 * THAT DIAGNOSIS WAS RIGHT AND ITS CAUSE HAS SINCE BEEN FIXED AT THE ROOT (2026-09-18),
 * so the paragraph above is history and NOT current behaviour. The dispatch lanes were
 * spending the budget to answer a question they never asked: the assertion is the
 * DISPATCH DECISION, and it was being paid for at the price of a full `npx prettier
 * --write`, nine times per pass. `auto-format-cases.mjs::evaluate` now stubs the hook's
 * OWN `npx` (MEASURED: the nine spawns 90000ms -> 4787ms), so the thirteen
 * offline-deterministic checks run everywhere. The two `npx` arms keep the REAL npx and
 * are the only remaining environment axis.
 *
 * A case MAY declare `tolerated_unrunnable: [<check-id>, ...]` to accept a specific
 * arm's non-execution in its environment. That relaxes the EXIT STATUS only; the ids
 * are reported in `did_not_run` and named in the message either way. The default is
 * the EMPTY set, so an unforeseen did-not-run reds instead of hiding.
 *
 * NO SHIPPED CASE DECLARES ONE, and that is a decision rather than an oversight. The
 * only ids that could want it are the two registry arms, and a declaration would relax
 * the exit status in EVERY environment — including a genuinely airgapped one, which
 * would then print CLEAN over two checks that never ran, which is the collapse this
 * file's three verdicts exist to end. The measured environments, the CI evidence, and
 * the documented escape for a slow host are recorded once in
 * `eval-manifest.json::auto-format._clean_pole_environment_axis`.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { CANONICAL_EXPECT, CHECK_IDS, evaluate } from "./auto-format-cases.mjs";

/** Emit a verdict in the shape `coc-eval-core.mjs::extractVerdict`/`extractChecks` read, then exit. */
function emit({ grade, passed, message, checks, extra = {} }, code) {
  console.log(JSON.stringify({ grade, passed, message, checks, ...extra }, null, 2));
  process.exit(code);
}

/** A refusal is a FAILED scan, never a silent pass: every check is reported failed. */
function refuse(message) {
  emit(
    {
      grade: "INVALID",
      passed: false,
      message,
      checks: CHECK_IDS.map((id) => ({ id, critical: true, passed: false })),
    },
    1,
  );
}

const argv = process.argv.slice(2);
const ri = argv.indexOf("--root");
if (ri === -1 || ri + 1 >= argv.length || !argv[ri + 1] || argv[ri + 1].startsWith("--")) {
  // Fail CLOSED. A `--root` that falls through would scan nothing and report a
  // `passed: true` over zero executed steps — the vacuous pass `bin/verdict.mjs`
  // records fixing in its own argv handling.
  refuse("--root requires a fixture-case directory argument; got none.");
}
const rootArg = argv[ri + 1];
const root = isAbsolute(rootArg) ? rootArg : resolve(process.cwd(), rootArg);
if (!existsSync(root) || !statSync(root).isDirectory()) {
  refuse(`--root '${rootArg}' is not an existing directory.`);
}

const expectPath = join(root, "expect.json");
if (!existsSync(expectPath)) {
  refuse(`fixture case has no expect.json at ${expectPath} (a case with no declared expectation asserts nothing).`);
}
let declared;
try {
  declared = JSON.parse(readFileSync(expectPath, "utf8"));
} catch (e) {
  refuse(`expect.json is not valid JSON: ${e.message}`);
}
if (!declared || typeof declared !== "object" || Array.isArray(declared)) {
  refuse("expect.json must be a JSON object of CANONICAL_EXPECT's shape.");
}

/**
 * The one `expect.json` field this scanner owns rather than `CANONICAL_EXPECT`.
 * It names check-ids whose NON-EXECUTION this case accepts (the `npx`-dependent
 * arms in a sandbox with no registry). It NEVER converts a did-not-run into a
 * pass: the ids are reported either way, and only the EXIT STATUS is relaxed.
 * Default is the EMPTY set, so an unforeseen did-not-run reds rather than hides.
 */
const TOLERATED_KEY = "tolerated_unrunnable";

// Reject an unknown key rather than silently ignoring it: a typo'd field would
// otherwise leave the case asserting the canonical value while reading as though
// it asserted something else.
const allowed = new Set([...Object.keys(CANONICAL_EXPECT), TOLERATED_KEY]);
const unknown = Object.keys(declared).filter((k) => !k.startsWith("_") && !allowed.has(k));
if (unknown.length) {
  refuse(`expect.json declares unknown field(s): ${unknown.join(", ")} (allowed: ${[...allowed].join(", ")})`);
}

// A case MAY declare which check-ids it accepts as UNRUNNABLE in its environment
// (the two `npx`-dependent arms in a sandbox with no registry). The declaration is
// the ONLY thing that converts a DID-NOT-RUN into a non-blocking outcome, and it is
// reported by id either way — never absorbed into the pass.
const toleratedRaw = declared[TOLERATED_KEY];
if (toleratedRaw !== undefined && (!Array.isArray(toleratedRaw) || toleratedRaw.some((v) => typeof v !== "string"))) {
  refuse(`${TOLERATED_KEY} must be an array of check-id strings.`);
}
const tolerated = new Set(toleratedRaw ?? []);
const unknownTolerated = [...tolerated].filter((id) => !CHECK_IDS.includes(id));
if (unknownTolerated.length) {
  // A tolerated id that matches no check is a silently-empty waiver: it would read
  // as coverage-accounting while waiving nothing, and would survive a rename of the
  // very check it was written to excuse.
  refuse(`${TOLERATED_KEY} names unknown check-id(s): ${unknownTolerated.join(", ")} (known: ${CHECK_IDS.join(", ")})`);
}

// A THROW OUT OF `evaluate` MUST BECOME A VERDICT, NOT A BARE EXIT 1.
// `evaluate` refuses loudly in two cases — a typo'd env var (`boundedMs`) and an
// npx stub that fails to shadow the real npx — and both are CORRECT refusals. But
// an uncaught throw leaves this process exiting 1 with ZERO stdout, which
// `coc-eval-core.mjs` reads on its clean-exit branch and compares against the
// fixture's declared `exit` — presenting a scan that never ran as an ordinary
// verdict mismatch. That is the same kill-laundering class `auto-format-cases.mjs`
// records returning a TIMED_OUT sentinel to avoid, reached one frame out.
// `refuse` emits the INVALID/exit-1 shape with every check reported failed and the
// reason in `message`, so the refusal survives as an answer.
let rows;
try {
  ({ rows } = evaluate(declared));
} catch (e) {
  refuse(`the scan could not run: ${e && e.message ? e.message : String(e)}`);
}
const byId = new Map(rows.map((r) => [r.id, r]));

/**
 * Partition a SKIPPED row into the two kinds the grade must tell apart.
 *
 * NOT-APPLICABLE  the check has no referent under THIS case's declared
 *                 expectation or the observed state of the subject. Nothing was
 *                 suppressed, so it is not a coverage hole.
 * DID-NOT-RUN     the check was applicable and its instrument could not execute
 *                 (hook spawn over budget, npx unreachable, aggregate budget
 *                 spent). This is the class that MUST NOT read as a pass.
 *
 * Decided from data the scanner ALREADY holds — the parsed expectation, and the
 * OBSERVED `actual` of the pin-declaration row — never from the row's prose note,
 * and never by re-deriving the cases module's own skip predicate.
 *
 * FAIL-CLOSED: any skip this function does not positively recognise as
 * not-applicable is DID-NOT-RUN. A new skip reason added upstream therefore reds
 * this scanner rather than silently widening the set of unverified checks.
 */
function isNotApplicable(row) {
  // `md-byte-identical` is a CONSEQUENCE of the markdown refusal. A case that
  // declares markdown IS dispatched has no refusal for it to be a consequence of.
  if (row.id === "md-byte-identical") {
    const wantMdDispatched = declared.dispatch?.md ?? CANONICAL_EXPECT.dispatch.md;
    if (wantMdDispatched === true) return true;
  }
  // Both pin-dependent arms need a declared pin to act on. `pin-declared`'s
  // OBSERVED value is the authority — not the expectation, which may disagree
  // with the subject (that disagreement is `pin-declared`'s own FAILURE to report).
  if (row.id === "pin-resolves" || row.id === "red-pole-payload-corrupts") {
    if (byId.get("pin-declared")?.actual === false) return true;
  }
  return false;
}

const scored = rows.filter((r) => !r.skipped);
const checks = scored.map((r) => ({ id: r.id, critical: true, passed: r.passed === true }));
const failed = checks.filter((c) => !c.passed).map((c) => c.id);

const skippedRows = rows.filter((r) => r.skipped);
const notApplicable = skippedRows.filter(isNotApplicable);
const didNotRun = skippedRows.filter((r) => !isNotApplicable(r));
const didNotRunUndeclared = didNotRun.filter((r) => !tolerated.has(r.id));

// A scan that scored NOTHING has verified nothing. It is never CLEAN, whatever
// the tolerations say — the vacuous pass this file's own `--root` handling
// already refuses, reached by the other road.
const vacuous = scored.length === 0;

// THREE verdicts, and the exit status carries the distinction the grade does.
//   0 / CLEAN      every applicable critical check RAN and passed
//   1 / INVALID    at least one check RAN and failed  (an answer, so it outranks)
//   2 / INCOMPLETE nothing failed, but an applicable critical check DID NOT RUN
// DID-NOT-RUN is never folded into CLEAN. A DECLARED toleration keeps the exit
// status at 0 but is still reported by id in `did_not_run` and in the message,
// so the reader is told what the green does NOT cover.
let grade;
let code;
if (failed.length > 0) {
  grade = "INVALID";
  code = 1;
} else if (vacuous || didNotRunUndeclared.length > 0) {
  grade = "INCOMPLETE";
  code = 2;
} else {
  grade = "CLEAN";
  code = 0;
}
const passed = grade === "CLEAN";

const describe = (list) => list.map((r) => ({ id: r.id, reason: r.note }));
const coverage = `${checks.length}/${CHECK_IDS.length} scored`;
let message;
if (grade === "INVALID") {
  message = `${failed.length} declared expectation(s) did not hold against the live hook: ${failed.join(", ")} (${coverage})`;
} else if (vacuous) {
  message = `NOT A PASS — zero checks were scored; every declared expectation is UNVERIFIED (${CHECK_IDS.length} declared, ${didNotRun.length} did-not-run, ${notApplicable.length} not-applicable)`;
} else if (grade === "INCOMPLETE") {
  message = `NOT A PASS — ${didNotRunUndeclared.length} critical check(s) DID NOT RUN and are undeclared: ${didNotRunUndeclared.map((r) => r.id).join(", ")}. Nothing failed, but the scan did not verify them (${coverage})`;
} else {
  const tol = didNotRun.length ? `; ${didNotRun.length} did-not-run DECLARED-tolerated: ${didNotRun.map((r) => r.id).join(", ")}` : "";
  message = `every applicable expectation held against the live hook (${coverage}, ${notApplicable.length} not-applicable${tol})`;
}

emit(
  {
    grade,
    passed,
    message,
    checks,
    extra: {
      critical_failures: failed,
      did_not_run: describe(didNotRun),
      did_not_run_undeclared: didNotRunUndeclared.map((r) => r.id),
      not_applicable: describe(notApplicable),
      // Retained under its original name for any reader that predates the
      // three-verdict split; it is the UNION of the two partitions above.
      skipped: describe(skippedRows),
      coverage: { declared: CHECK_IDS.length, scored: checks.length, did_not_run: didNotRun.length, not_applicable: notApplicable.length },
      rows: rows.map((r) => ({ id: r.id, expected: r.expected, actual: r.actual, passed: r.passed, skipped: r.skipped })),
    },
  },
  code,
);
