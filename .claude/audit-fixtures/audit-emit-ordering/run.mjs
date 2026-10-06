#!/usr/bin/env node
/**
 * audit-emit-ordering — fixture runner for `eatp.md` § "Signed Audit Event Emits BEFORE State
 * Advance" (`.claude/hooks/lib/audit-emit-ordering.js` + `.claude/hooks/audit-emit-ordering-guard.js`).
 *
 * BIPOLAR BY CONSTRUCTION. Every ordering case ships as a PAIR over the SAME function body,
 * separating only on the ORDER of the two statements. A predicate that fired on both poles, or
 * on neither, would pass a one-sided suite and is caught here: the compliant pole of each pair
 * is the falsifying result for that pair's violation pole.
 *
 * THE HARD CASES ARE THE COMPLIANT ONES. `pair3` (a plain attribute write before the emit),
 * `pair4` (the anti-pattern written inside a DOCSTRING — which is how the rule itself states
 * it) and `pair5` (advance ending one function, emit opening the next) are each a shape a
 * LINE-WINDOW heuristic scores backwards. They are what the function-boundary walk buys, and
 * they red immediately if the walk is replaced by a window.
 *
 * THE GUARD IS DRIVEN END-TO-END, not only the lib: `guard-*` cases spawn the real hook with a
 * real PostToolUse payload and assert on its stdout/stderr, so a lib that discriminates behind
 * a guard that never reaches it still reds.
 *
 *   node .claude/audit-fixtures/audit-emit-ordering/run.mjs
 *   HOOK=/abs/path/to/mutant.js node .../run.mjs     # red it against a mutant guard
 *   LIB=/abs/path/to/mutant-lib.js node .../run.mjs  # red it against a mutant lib
 */
import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const HOOK = process.env.HOOK || path.join(REPO, ".claude/hooks/audit-emit-ordering-guard.js");
const LIB = process.env.LIB || path.join(REPO, ".claude/hooks/lib/audit-emit-ordering.js");
const CASES = path.join(HERE, "cases");

const require_ = createRequire(import.meta.url);
const { scanAuditEmitOrdering, isEatpPythonPath } = require_(LIB);

let pass = 0;
let fail = 0;
const check = (ok, name, detail) => {
  if (ok) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

// ── Family A: the lib predicate, over on-disk Python fixtures ────────────────
// [fixture file, expected finding count, why this case exists]
const ORDERING = [
  ["pair1-violation-advance-then-emit.py", 1, "the rule's own DO-NOT block, verbatim"],
  ["pair1-clean-emit-then-advance.py", 0, "the rule's own DO block, verbatim — same two statements, swapped"],
  ["pair2-violation-intervening-lines.py", 1, "adjacency is not the signal; ordering is"],
  ["pair2-clean-intervening-lines.py", 0, "same intervening work, emit first"],
  ["pair3-violation-state-attr-before-emit.py", 1, "a state-ish attribute name, non-enum value"],
  ["pair3-clean-plain-attr-before-emit.py", 0, "a PLAIN attribute write before the emit is not a transition"],
  ["pair4-violation-real-code-below-docstring.py", 1, "docstring blanked, the real code below it still caught"],
  ["pair4-clean-antipattern-only-in-docstring.py", 0, "the violating order exists ONLY as documentation"],
  ["pair5-violation-same-function.py", 1, "both statements inside one def"],
  ["pair5-clean-across-function-boundary.py", 0, "advance ends def one, emit opens def two"],
  ["pair6-violation-two-functions.py", 2, "each def is settled independently"],
  ["pair6-clean-failed-helper-no-audit.py", 0, "the no-recurse FAILED helper emits nothing at all"],
  // pair7 is the DEDENT-SENSITIVE pair, and it exists because a mutation proved the rest of the
  // suite was blind to half the boundary walk. Pushing a frame on each `def` re-targets
  // attribution on its own, so every earlier case stayed green when the dedent-CLOSE loop was
  // disabled. Only a statement that leaves a function WITHOUT entering another one — here a
  // module-level audit append below the class — distinguishes a closed frame from an open one.
  ["pair7-clean-dedent-out-of-function.py", 0, "module-level append belongs to no function"],
  ["pair7-violation-both-inside-function.py", 1, "the same two statements, both inside the def"],
];

for (const [file, want, why] of ORDERING) {
  const src = fs.readFileSync(path.join(CASES, file), "utf8");
  const r = scanAuditEmitOrdering(src);
  const got = r.findings.length;
  check(got === want, `ordering ${file}`, `want ${want} finding(s), got ${got} (${why})`);
}

// ── Family B: path scoping matches the rule's own `paths:` ──────────────────
const SCOPE = [
  ["src/trust/executor.py", true],
  ["src/eatp/lifecycle.py", true],
  ["trust/x.py", true],
  ["src/trust/executor.rs", false],
  ["src/trusted_helpers/x.py", false],
  ["src/eatplike/x.py", false],
  ["src/core/executor.py", false],
  ["", false],
];
for (const [rel, want] of SCOPE) {
  check(isEatpPythonPath(rel) === want, `scope ${rel || "(empty)"}`, `expected ${want}`);
}

// ── Family C: the guard, driven end-to-end with real payloads ───────────────
function driveGuard(relPath, srcFile) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-emit-ordering-"));
  const abs = path.join(tmp, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (srcFile) fs.copyFileSync(path.join(CASES, srcFile), abs);
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: abs },
    }),
    encoding: "utf8",
    timeout: 20000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: tmp },
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  return { stdout: res.stdout || "", stderr: res.stderr || "", status: res.status };
}

{
  const r = driveGuard("src/trust/executor.py", "pair1-violation-advance-then-emit.py");
  const flagged = /halt-and-report/i.test(r.stdout + r.stderr);
  const namesIt = /advances the state slot/.test(r.stdout + r.stderr);
  const namesLine = /executor\.py:\d+/.test(r.stdout + r.stderr);
  check(flagged, "guard-violation emits halt-and-report", `stdout=${r.stdout.slice(0, 160)}`);
  check(namesIt, "guard-violation names the failure IDENTITY (not just an exit code)", r.stdout.slice(0, 160));
  check(namesLine, "guard-violation cites path:line for the advance", r.stdout.slice(0, 160));
}
{
  const r = driveGuard("src/trust/executor.py", "pair1-clean-emit-then-advance.py");
  check(/"continue"\s*:\s*true/.test(r.stdout) && !/halt-and-report/.test(r.stdout),
    "guard-clean passes through silently", r.stdout.slice(0, 160));
}
{
  const r = driveGuard("src/core/executor.py", "pair1-violation-advance-then-emit.py");
  check(/"continue"\s*:\s*true/.test(r.stdout) && !/halt-and-report/.test(r.stdout),
    "guard-out-of-scope path is not scanned", r.stdout.slice(0, 160));
}
{
  // Fail-open (cc-artifacts.md Rule 7): the declared file does not exist.
  const r = driveGuard("src/trust/missing.py", null);
  check(/"continue"\s*:\s*true/.test(r.stdout) && r.status === 0,
    "guard-fails-open on an unreadable target", `status=${r.status} stdout=${r.stdout.slice(0, 120)}`);
}

console.log(`\naudit-emit-ordering: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
