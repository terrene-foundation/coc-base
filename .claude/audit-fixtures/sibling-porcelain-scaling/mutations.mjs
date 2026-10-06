#!/usr/bin/env node
/**
 * mutations.mjs — the MUTATION HARNESS for sibling-porcelain-scaling.
 *
 * NOT registered in ci-audit-fixtures.json (that registry closes over `run.mjs`
 * only). This is the operator-run instrument that establishes what `run.mjs`'s
 * green is WORTH: for each mutation it (a) proves the mutated line EXECUTED
 * during the very run whose failures are being read, by counting a stderr
 * marker planted at that line, and (b) shows which named cases go RED. A
 * mutation that does not red leaves TWO hypotheses — vacuous case, or inert
 * mutation — and only the marker count tells them apart
 * (`instrument-discipline.md` MUST-2(b)).
 *
 * ONE DRIVER, ONE QUESTION (`instrument-discipline.md` MUST-4). Reachability is
 * measured on the SAME `run.mjs` invocation that produces the RED, because the
 * question that matters is "did this line execute in the run whose verdict I am
 * reading?" — not "does this line execute under some other input". An earlier
 * revision used a separate driver against a valid repo and read its 0 hits for
 * the enumeration-FAILURE mutation as "never runs"; that driver simply never
 * took the branch, so it could not have produced a hit either way.
 *
 * Run: node .claude/audit-fixtures/sibling-porcelain-scaling/mutations.mjs
 */
import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const LIBDIR = path.join(REPO_ROOT, ".claude", "hooks", "lib");
const LIB = path.join(LIBDIR, "sibling-porcelain.js");
const RUNNER = path.join(__dirname, "run.mjs");
const SRC = fs.readFileSync(LIB, "utf8");

const MARKER = "S54_MUT_REACHED";
const REACH = `try { process.stderr.write("${MARKER}\\n"); } catch {}`;

/**
 * COUNT THE HITS, NOT THE TALLY (`instrument-discipline.md` MUST-3(b)).
 *
 * A naive `stderr.match(/MARKER/g).length` OVER-COUNTS: when a mutation is
 * syntactically invalid node prints the offending SOURCE LINE in its
 * SyntaxError report, and that line contains the marker string. The first run
 * of this harness scored `marker_hits=1` for exactly that reason, on a mutant
 * that never executed a single statement — a false positive that would have
 * banked "the mutation reached the code" from a module that failed to parse.
 * A hit therefore counts only on a line that is NOTHING BUT the marker, and a
 * parse/require failure is reported as its own outcome rather than as
 * reachability.
 */
function countMarkerHits(stderr) {
  return (stderr || "").split("\n").filter((l) => l.trim() === MARKER).length;
}

const STATUS_CALL = `    const r = _git(
      [
        "--no-optional-locks",
        "status",
        "--porcelain",
        "--",
        \`:(literal)\${targetRelPath}\`,
      ],
      { cwd: wt },
    );`;

/**
 * `find` must appear EXACTLY once. A find matching 0 or >1 times is an unsound
 * edit and ABORTS, rather than silently mutating nothing — which would read
 * identically to an inert mutation.
 */
const MUTATIONS = [
  {
    id: "M1-wide-query",
    why: "revert the pathspec limiter — restore the full-tree per-sibling status",
    find: STATUS_CALL,
    replace: `    ${REACH}\n    const r = _git(["status", "--porcelain"], { cwd: wt });`,
    expectRed: [
      "SCALING/per-sibling-query-is-NARROW",
      "equivalence/untracked-dir-child-is-the-ONE-named-difference",
    ],
  },
  {
    id: "M2-eager-containment",
    why: "revert the deferral — run the containment rev-parse over the whole forest again",
    find: `  const contained = (wt) => _isContainedSibling(wt, listed.selfCommonAbs);`,
    replace:
      `  ${REACH}\n` +
      `  listed.candidates.forEach((wt) => _isContainedSibling(wt, listed.selfCommonAbs));\n` +
      `  const contained = (wt) => _isContainedSibling(wt, listed.selfCommonAbs);`,
    expectRed: ["SCALING/marginal-spawns-per-additional-sibling-is-ONE"],
  },
  {
    id: "M3-collapse-indeterminate",
    why: "collapse INVARIANT 1 — report an unanswerable enumeration as a clean result",
    find: `  if (!listed.ok) {
    return { ok: false, matches: [], reason: listed.reason };
  }`,
    replace: `  if (!listed.ok) {
    ${REACH}
    return { ok: true, matches: [] };
  }`,
    // NOT INV1/bad-arguments: those guards return BEFORE the enumeration, so
    // this mutation is genuinely unable to reach them. Naming them here would
    // have been an expectation the mutation could never meet.
    expectRed: ["INV1/not-a-repo-is-INDETERMINATE"],
  },
  {
    id: "M4-collapse-unreadable-tail",
    why: "collapse INVARIANT 1's tail — an unreadable sibling reported as no-contention",
    find: `  if (verifiedMatches.length === 0 && verifiedUnreadable.length > 0) {`,
    replace:
      `  ${REACH}\n` +
      `  if (false && verifiedMatches.length === 0 && verifiedUnreadable.length > 0) {`,
    expectRed: ["INV1/unreadable-CONTAINED-sibling-is-INDETERMINATE"],
  },
  {
    id: "M5-drop-literal-magic",
    why: "drop ':(literal)' — let git widen the pathspec to a wildmatch",
    // The marker goes OUTSIDE the array literal. An earlier revision spliced it
    // BETWEEN two array elements, producing a SyntaxError rather than a
    // mutation — the module never parsed, every case errored, and the marker
    // was "seen" only in node's own error echo.
    find: STATUS_CALL,
    replace: `    ${REACH}
    const r = _git(
      ["--no-optional-locks", "status", "--porcelain", "--", targetRelPath],
      { cwd: wt },
    );`,
    // MEASURED, and the reason the glob case was re-scoped: dropping the magic
    // does NOT red `glob/wildcard-target-cannot-FALSE-POSITIVE`. Git widens to
    // 5 rows, and the retained exact compare rejects every one, so the verdict
    // is unchanged. `:(literal)` is a NARROWING device; its fence is the argv
    // case, and that is the only case named here.
    expectRed: ["SCALING/per-sibling-query-is-NARROW"],
  },
  {
    id: "M6-drop-break",
    why: "remove the one-match-per-sibling break",
    find: "        break; // one match per sibling is sufficient",
    replace: `        ${REACH}\n        continue;`,
    expectRed: ["INV2/one-match-per-sibling-break-PIN"],
  },
  {
    id: "M7-drop-exact-compare",
    why: "make the pathspec correctness-bearing — accept any row the narrowed query returned",
    find: "      if (p === targetRelPath) {",
    replace: `      ${REACH}\n      if (true) {`,
    // MEASURED. This mutation does NOT red the two glob/exactness verdict
    // cases, and that is a finding rather than a gap: with the exact compare
    // gone, `:(literal)src/*.js` and `:(literal)src/foo.js` still return ZERO
    // rows, so the loop body never runs and the verdict is unchanged. The two
    // layers are INDEPENDENTLY SUFFICIENT for those inputs — which is what
    // defense-in-depth means, and is why neither can be read as fencing the
    // other. What DOES red is the pin, plus the legacy-equivalence case: a
    // quoted non-ASCII row (`?? "src/caf\303\251.js"`) is CLEAN under the exact
    // compare and MATCH once any row is accepted.
    expectRed: [
      "glob/EXACT-compare-is-the-decider-PIN",
      "equivalence/legacy-full-status-vs-narrow-query",
    ],
  },
  {
    // The TIMING pole's own positive control (`instrument-discipline.md`
    // MUST-3(a)): a ratio nobody has SEEN emit its falsifying result is not
    // yet evidence, however sound its arithmetic. M2 reds the spawn-COUNT
    // ratio but leaves the spawn-FLOOR ratio green, so this mutation exists
    // solely to show the floor ratio can move. It inflates the per-sibling
    // constant with extra whole-tree scans — the exact regression shape the
    // case is meant to catch.
    id: "M8-inflate-per-sibling-cost",
    why: "add three extra whole-tree scans per sibling — the timing pole's positive control",
    find: `    if (!r.ok) {
      // A sibling we could not read is not a sibling with nothing staged.
      unreadable.push(wt);
      continue;
    }`,
    replace: `    ${REACH}
    _git(["status", "--porcelain"], { cwd: wt });
    _git(["status", "--porcelain"], { cwd: wt });
    _git(["status", "--porcelain"], { cwd: wt });
    if (!r.ok) {
      // A sibling we could not read is not a sibling with nothing staged.
      unreadable.push(wt);
      continue;
    }`,
    expectRed: [
      "SCALING/per-sibling-cost-in-SPAWN-FLOORS",
      "SCALING/marginal-spawns-per-additional-sibling-is-ONE",
    ],
  },
];

let failures = 0;
const mutantPath = path.join(LIBDIR, "sibling-porcelain.__mutant__.js");

for (const m of MUTATIONS) {
  const hits = SRC.split(m.find).length - 1;
  if (hits !== 1) {
    console.log(`ABORT ${m.id}: anchor matched ${hits} times, expected exactly 1`);
    failures += 1;
    continue;
  }
  fs.writeFileSync(mutantPath, SRC.replace(m.find, m.replace));
  try {
    const run = spawnSync(process.execPath, [RUNNER], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SIBLING_PORCELAIN_LIB: mutantPath },
    });
    const markerHits = countMarkerHits(run.stderr);
    const parseBroke = /SyntaxError|Cannot find module/.test(run.stderr || "");
    const failedLine = (run.stdout.match(/^FAILED: (.*)$/m) || [])[1] || "";
    const reddened = failedLine
      .split(", ")
      .map((s) => s.trim())
      .filter(Boolean);
    const missing = m.expectRed.filter((c) => !reddened.includes(c));

    const ok =
      !parseBroke && markerHits > 0 && run.status !== 0 && missing.length === 0;
    if (!ok) failures += 1;
    console.log(
      `${ok ? "OK  " : "BAD "} ${m.id.padEnd(26)} marker_hits=${String(markerHits).padEnd(4)} ` +
        `parse_ok=${!parseBroke} suite_exit=${run.status} reddened=[${reddened.join(", ")}]` +
        (missing.length ? `  MISSING=[${missing.join(", ")}]` : ""),
    );
    console.log(`         ${m.why}`);
  } finally {
    fs.rmSync(mutantPath, { force: true });
  }
}

console.log(
  `\nmutations: ${MUTATIONS.length - failures}/${MUTATIONS.length} mutations both REACHED the code (marker on a line of its own) and REDDENED their named cases`,
);
process.exit(failures === 0 ? 0 : 1);
