#!/usr/bin/env node
/**
 * codify-lease-journal-scope — the regression lock for RS-50.
 *
 * WHAT IS UNDER TEST. `codify-lease.js::_sortDedupRel` unions, into EVERY lease
 * scope, the journal directories `/codify`'s own phase-complete gate writes to —
 * RESOLVED against the repo, never hardcoded to one layout.
 *
 * THE DEFECT. `commands/codify.md` Step 0 tells the caller the helper unions only
 * `.claude/learning/learning-codified.json` + `.claude/.proposals/latest.yaml`;
 * § "Journal (MUST — phase-complete gate)" then REQUIRES a journal entry before
 * `/codify` may be reported complete. A caller following the command LITERALLY
 * acquired a lease covering two files and was halt-and-reported by
 * `integrity-guard.js` for the journal write — on a step the SAME command mandates.
 *
 * HOW IT DISCRIMINATES. Each case builds a REAL temp repo on disk with a real
 * directory layout and calls the REAL exported helper. The lever is the LAYOUT:
 * the same call yields different prefixes for a root-journal repo, a
 * workspace-journal repo, and a repo with neither — so a hardcoded-one-layout
 * implementation reds on the layout it did not hardcode, and an implementation
 * that unions nothing reds on all of them.
 *
 * WHY THE CASES ASSERT COVERAGE, NOT MEMBERSHIP. Asserting `scope.includes("journal/")`
 * would pass for a scope entry that `integrity-guard.js::findCoveringLease` does not
 * actually accept — the covering predicate is prefix-with-trailing-slash, not
 * substring. Each case therefore runs the candidate journal path through
 * `coversRel()` below, which is the covering predicate PINNED to the real source
 * (see `RS-50/covering-predicate-pin`). `findCoveringLease` is NOT importable —
 * `integrity-guard.js` has no `module.exports` and runs an unguarded `main()` IIFE,
 * so requiring it would EXECUTE the hook. The pin case is what keeps this local
 * copy honest: it reds the moment the real predicate's shape changes, which is the
 * only thing standing between a re-implementation and a silently divergent one.
 *
 * Each case names the mutation that reds it (`instrument-discipline.md` MUST-2(b));
 * the mutations are recorded as measured in README.md.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

// Overridable so the RED can be established against an UNFIXED build of the
// module without mutating the working tree (`instrument-discipline.md` MUST-2).
const LIB =
  process.env.CODIFY_LEASE_LIB ||
  path.join(REPO_ROOT, ".claude", "hooks", "lib", "codify-lease.js");
const GUARD = path.join(REPO_ROOT, ".claude", "hooks", "integrity-guard.js");

const mod = require(LIB);
const sortDedupRel = mod._test_sortDedupRel;

/**
 * `integrity-guard.js::findCoveringLease`'s covering predicate, transcribed. The
 * `RS-50/covering-predicate-pin` case below asserts these three lines are still
 * the real ones, so a divergence reds rather than silently passing.
 */
function coversRel(scope, candidateRel) {
  for (const s of scope) {
    if (s === candidateRel) return true;
    if (s.endsWith("/") && candidateRel.startsWith(s)) return true;
    if (!s.includes(".") && candidateRel.startsWith(s + "/")) return true;
  }
  return false;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rs50-"));
let pass = 0;
const failures = [];

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
    // `PASS <name>` at column 0 is the shape run-audit-fixtures.mjs::CASE_PASS
    // counts (/^[ \t]*(?:PASS|ok)[ \t]+\S/). An indented `✓ <name>` is invisible
    // to it, so this runner reported 0 cases against its own min_cases floor of 9
    // while passing 9/9 standalone.
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name}`);
    console.log(`      expected: ${expectation}`);
    console.log(`      actual  : ${detail}`);
  }
}

function mkRepo(label, dirs) {
  const root = path.join(TMP, label);
  fs.mkdirSync(root, { recursive: true });
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
}

// ── RS-50 — the finding itself ────────────────────────────────────────────────
// A lease acquired with EMPTY scopeFiles must cover the repo-root journal entry
// `/codify`'s phase-complete gate writes.
check(
  "RS-50",
  'empty scopeFiles yields a scope covering "journal/0001-x-DECISION-y.md"',
  () => {
    const root = mkRepo("root-journal", ["journal"]);
    const scope = sortDedupRel([], root);
    return (
      coversRel(scope, "journal/0001-x-DECISION-y.md") ||
      `scope=${JSON.stringify(scope)}`
    );
  },
);

// The root default must hold even when the directory does not exist yet — the
// /codify that CREATES a repo's first journal entry is the case that has no
// directory to enumerate.
check(
  "RS-50/root-journal-covered-before-the-dir-exists",
  'a repo with NO journal/ still yields a scope covering "journal/0001-x.md"',
  () => {
    const root = mkRepo("no-journal-yet", []);
    const scope = sortDedupRel([], root);
    return coversRel(scope, "journal/0001-x.md") || `scope=${JSON.stringify(scope)}`;
  },
);

// The workspace-scoped layout — the half a root-only hardcode would miss.
check(
  "RS-50/workspace-journal-covered",
  'workspaces/<n>/journal/ is resolved and covers "workspaces/alpha/journal/0001-x.md"',
  () => {
    const root = mkRepo("ws-journal", ["workspaces/alpha/journal"]);
    const scope = sortDedupRel([], root);
    return (
      coversRel(scope, "workspaces/alpha/journal/0001-x.md") ||
      `scope=${JSON.stringify(scope)}`
    );
  },
);

// `.pending/` is a real journal write target (`journal-write-guard.js` watches
// `workspaces/<name>/journal/.pending/<slot>-…`), so the scope must reach it.
// NOTE, measured: this case does NOT pin the trailing-slash form. A bare
// `workspaces/<n>/journal` covers the same candidate via findCoveringLease's
// dot-free-bare-dir clause, and mutation M3 (README) left this case GREEN.
check(
  "RS-50/pending-subdir-covered",
  'the trailing-slash prefix also covers "workspaces/alpha/journal/.pending/0001-x.md"',
  () => {
    const root = mkRepo("ws-pending", ["workspaces/alpha/journal/.pending"]);
    const scope = sortDedupRel([], root);
    return (
      coversRel(scope, "workspaces/alpha/journal/.pending/0001-x.md") ||
      `scope=${JSON.stringify(scope)}`
    );
  },
);

// A repo with no workspaces/ at all must not throw — a lease MUST NOT fail to
// acquire because the layout is minimal.
check(
  "RS-50/no-workspaces-dir-does-not-throw",
  "a repo with no workspaces/ resolves cleanly and still carries the root default",
  () => {
    const root = mkRepo("bare", ["journal"]);
    const scope = sortDedupRel([], root);
    return scope.includes("journal/") || `scope=${JSON.stringify(scope)}`;
  },
);

// Leading-underscore meta-dirs per cc-artifacts.md Rule 8 — scoping the lease
// over `_archive` would claim dirs no /codify writes to.
check(
  "RS-50/meta-dirs-excluded",
  "workspaces/_archive/journal/ and workspaces/instructions/journal/ are NOT scoped",
  () => {
    const root = mkRepo("meta", [
      "workspaces/_archive/journal",
      "workspaces/instructions/journal",
      "workspaces/real/journal",
    ]);
    const scope = sortDedupRel([], root);
    const leaked = scope.filter(
      (s) => s.includes("_archive") || s.includes("instructions"),
    );
    if (leaked.length > 0) return `leaked=${JSON.stringify(leaked)}`;
    return (
      scope.includes("workspaces/real/journal/") || `scope=${JSON.stringify(scope)}`
    );
  },
);

// knowledge-convergence.md MUST-3's named pair must survive the change — the
// journal prefixes are an ADDITION to the mandatory scope, never a replacement.
check(
  "RS-50/mandatory-scope-preserved",
  "both MANDATORY_SCOPE files are still auto-unioned (knowledge-convergence.md MUST-3)",
  () => {
    const root = mkRepo("mandatory", ["journal"]);
    const scope = sortDedupRel([], root);
    const missing = [
      ".claude/learning/learning-codified.json",
      ".claude/.proposals/latest.yaml",
    ].filter((f) => !scope.includes(f));
    return missing.length === 0 || `missing=${JSON.stringify(missing)}`;
  },
);

// Caller-supplied scope entries must survive alongside the auto-unioned ones.
check(
  "RS-50/caller-scope-preserved",
  "an explicit scopeFiles entry is not dropped by the journal union",
  () => {
    const root = mkRepo("caller", ["journal"]);
    const scope = sortDedupRel([".claude/rules/foo.md"], root);
    return (
      scope.includes(".claude/rules/foo.md") || `scope=${JSON.stringify(scope)}`
    );
  },
);

// The pin. `coversRel()` above is a transcription; this asserts it still matches
// the real predicate, so a change to integrity-guard.js reds HERE instead of
// silently making every coverage assertion above test a stale contract.
check(
  "RS-50/covering-predicate-pin",
  "integrity-guard.js::findCoveringLease still carries the three transcribed covering lines",
  () => {
    const src = fs.readFileSync(GUARD, "utf8");
    const lines = [
      "if (s === candidateRel) return rec;",
      'if (s.endsWith("/") && candidateRel.startsWith(s)) return rec;',
      'if (!s.includes(".") && candidateRel.startsWith(s + "/")) return rec;',
    ];
    const absent = lines.filter((l) => !src.includes(l));
    return (
      absent.length === 0 ||
      `integrity-guard.js no longer carries: ${JSON.stringify(absent)} — ` +
        "re-derive coversRel() in this fixture against the real predicate"
    );
  },
);

fs.rmSync(TMP, { recursive: true, force: true });

const total = pass + failures.length;
console.log(`\ncodify-lease-journal-scope: ${pass}/${total} PASS`);
if (failures.length > 0) {
  console.log(`FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
