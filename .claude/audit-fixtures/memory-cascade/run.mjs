#!/usr/bin/env node
/**
 * run.mjs — audit-fixture runner for the `knowledge-cascade-routing.md` MUST-1
 * memory-write detector, shipped WITH that detector per `cc-artifacts.md` Rule 9.
 *
 * WHAT IS UNDER TEST:
 *   `.claude/hooks/lib/memory-cascade.js`   the PURE predicates
 *   `.claude/hooks/memory-cascade-guard.js` the PostToolUse:Write dispatcher
 *
 * THE FILE NAME IS `run.mjs`. Anything that cites this runner must cite that
 * name — a sibling suite shipped a self-description saying `routing-run.mjs`, the
 * rule copied the name FROM the file, and the rule then cited a path that
 * resolves to nothing. A file's self-description is a citation source.
 *
 * ── WHAT A GREEN RUN HERE DOES AND DOES NOT SHOW ────────────────────────────
 * It shows the PREDICATES decide correctly and that the GUARD BINARY emits what
 * they decide. It does NOT show the guard RUNS in a live session: registration
 * lives in `.claude/settings.json`, a shared registry this suite does not touch
 * and which, at the time this runner was authored, carried no entry for this
 * hook. Green here is evidence about logic and wiring-within-the-file, never
 * about enforcement (`instrument-discipline.md` MUST-3(a)).
 *
 * It also shows NOTHING about MUST-1's actual judgment — whether a capture was
 * cascade-valuable. The detector never looks at content, by design, and no case
 * in this table asserts otherwise.
 *
 * ── THREE ARMS, AND WHY NONE IS REDUNDANT ───────────────────────────────────
 *
 *   ARM 1 (pure predicate, no process). Each `<case>.json` carries `toolName` +
 *   `filePath`; its `<case>.expected` sidecar carries `flagged` + the resolved
 *   `arm`, or `clean`. It runs the SAME `inspectMemoryWrite` the guard calls —
 *   not a re-implementation — so a green here is a statement about the shipped
 *   predicate. The ANSWER KEY IS A SEPARATE FILE from the input, so nothing that
 *   reads a case can read its expected verdict.
 *
 *   ARM 2 (the real guard binary). ARM 1 is consistent with a guard that never
 *   calls the predicate, that builds a finding and drops it, or that crashes on
 *   every payload — three ways to be green and broken, and the third is not
 *   hypothetical: a sibling hook was silently inert for weeks because it
 *   `JSON.parse`d an already-parsed payload. So ARM 2 pipes real PostToolUse
 *   JSON into the real binary for every case and asserts the finding is EMITTED
 *   for each `flagged` case and ABSENT for each `clean` one.
 *
 *   ARM 3 (the falsifying pole for the TOOL GATE). ARM 2 alone is consistent
 *   with a detector that fires on any tool touching a memory path — a different,
 *   wrong detector that would annotate every session that merely READS its
 *   memory, and that passes every ARM-2 assertion. So ARM 3 re-runs every
 *   `flagged` case with the tool changed to `Read` and asserts SILENCE. This is
 *   the arm that makes the tool gate load-bearing rather than decorative.
 *
 * ── WHAT NO ARM HERE COVERS, stated rather than implied ─────────────────────
 * (`instrument-discipline.md` MUST-4 — each question named separately.)
 *   - Whether the captured content was cascade-valuable. Never asked.
 *   - Whether the hook is REGISTERED and therefore fires. ARM 2 invokes the
 *     binary directly; it says nothing about `settings.json`.
 *   - `Edit` appends to an existing memory file. Deliberately OUT of scope
 *     (the rule names `Write`), and pinned by the
 *     `clean-edit-tool-on-the-memory-file` case so the gap is a visible test
 *     result rather than an absence.
 *   - MUST-2 (unregistered artifact) and MUST-3 (unscrubbed specific) entirely.
 *
 * ── BIPOLARITY IS ENFORCED, NOT ASSUMED ─────────────────────────────────────
 * A table that drifted to all-clean would pass every assertion below while
 * proving the detector can never fire; a table that drifted to all-flagged could
 * not show it is ever silent. Both poles are asserted non-empty before any case
 * runs. That floor matters more than usual here, because the whole guard is
 * capped at `advisory` and an inert advisory is indistinguishable from a clean
 * session.
 *
 * Exit 0 = every case matched. Exit 1 = >=1 mismatch, with a RED SET naming each.
 */

import "../_lib/no-ambient-git.cjs";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE = path.resolve(HERE, "..", "..");
const HOOK = path.join(CLAUDE, "hooks", "memory-cascade-guard.js");

const require_ = createRequire(import.meta.url);
const lib = require_(path.join(CLAUDE, "hooks", "lib", "memory-cascade.js"));

const red = [];
let passed = 0;
const pass = (name, detail) => {
  passed += 1;
  process.stdout.write(`  PASS  ${name}${detail ? ` — ${detail}` : ""}\n`);
};
const fail = (name, detail) => {
  red.push({ name, detail });
  process.stdout.write(`  FAIL  ${name} — ${detail}\n`);
};

/* ── fixture discovery ──────────────────────────────────────────────────────
 * Anti-vacuity floor local to this runner: an empty loop exits 0 and reads as
 * coverage, which is the bare-exit-0 failure `coc-artifact-eval-coverage.md`
 * MUST-3 names. readdir is CAUGHT so a missing directory is a FAIL line, not an
 * opaque node stack.
 */
let names = [];
try {
  names = readdirSync(HERE)
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.replace(/\.json$/, ""))
    .sort();
} catch (e) {
  fail("fixture-discovery", `cannot read ${HERE}: ${e.message}`);
}
if (names.length === 0) {
  fail("fixture-discovery", `no .json fixtures under ${HERE}`);
}

const cases = [];
for (const name of names) {
  try {
    const input = JSON.parse(readFileSync(path.join(HERE, `${name}.json`), "utf8"));
    const expected = JSON.parse(
      readFileSync(path.join(HERE, `${name}.expected`), "utf8"),
    );
    if (typeof input.filePath !== "string" || typeof input.toolName !== "string") {
      fail(name, "fixture needs string `toolName` and `filePath`");
      continue;
    }
    if (expected.verdict !== "flagged" && expected.verdict !== "clean") {
      fail(name, `unknown verdict ${JSON.stringify(expected.verdict)}`);
      continue;
    }
    if (expected.verdict === "flagged" && !expected.arm) {
      fail(name, "a flagged case must name the `arm` it resolves through");
      continue;
    }
    cases.push({ name, input, expected });
  } catch (e) {
    fail(name, `unreadable fixture pair: ${e.message}`);
  }
}

const flaggedCases = cases.filter((c) => c.expected.verdict === "flagged");
const cleanCases = cases.filter((c) => c.expected.verdict === "clean");
if (flaggedCases.length === 0) fail("bipolarity", "no `flagged` cases in the table");
if (cleanCases.length === 0) fail("bipolarity", "no `clean` cases in the table");

// BOTH ARMS MUST BE EXERCISED BY THE FLAGGED POLE. Without this, the table could
// drift to basename-only and the `memory-dir` arm could be deleted with every
// case still green — which is exactly the mutation this suite must red on.
const armsCovered = new Set(flaggedCases.map((c) => c.expected.arm));
for (const arm of ["basename", "memory-dir"]) {
  if (!armsCovered.has(arm)) {
    fail("arm-coverage", `no flagged case resolves through the \`${arm}\` arm`);
  }
}

/* ── ARM 1 — the pure predicate ─────────────────────────────────────────────── */
process.stdout.write("ARM 1 — inspectMemoryWrite (pure predicate)\n");
for (const c of cases) {
  let got;
  try {
    got = lib.inspectMemoryWrite({
      toolName: c.input.toolName,
      filePath: c.input.filePath,
    });
  } catch (e) {
    fail(`arm1/${c.name}`, `predicate THREW: ${e.message}`);
    continue;
  }
  if (c.expected.verdict === "flagged") {
    if (got.length !== 1) {
      fail(`arm1/${c.name}`, `expected exactly 1 finding, got ${got.length}`);
    } else if (got[0].arm !== c.expected.arm) {
      fail(
        `arm1/${c.name}`,
        `resolved arm ${JSON.stringify(got[0].arm)}, expected ${JSON.stringify(c.expected.arm)}`,
      );
    } else if (got[0].severity !== "advisory") {
      // The rule DECLARES advisory. A predicate that quietly returned a stronger
      // severity would exceed the rule that authorises it.
      fail(`arm1/${c.name}`, `severity ${JSON.stringify(got[0].severity)}, expected "advisory"`);
    } else {
      pass(`arm1/${c.name}`, `arm=${got[0].arm}`);
    }
  } else if (got.length !== 0) {
    fail(
      `arm1/${c.name}`,
      `expected silence, got [${got.map((f) => f.arm).join(",")}]` +
        (c.expected.defeats ? ` — this case exists to defeat ${c.expected.defeats}` : ""),
    );
  } else {
    pass(`arm1/${c.name}`, "silent");
  }
}

/* ── ARM 2 — the real guard binary ──────────────────────────────────────────── */
process.stdout.write("ARM 2 — the real guard binary on real PostToolUse JSON\n");

const RULE_MARK = "knowledge-cascade-routing/memory-write";

function hookSays(toolName, filePath) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: toolName,
      tool_input: { file_path: filePath },
    }),
    encoding: "utf8",
    timeout: 30000,
  });
  const out = `${r.stdout || ""}`;
  return { fired: out.includes(RULE_MARK), out, status: r.status };
}

// The control for the CONTROL. If the binary cannot be invoked at all, every
// "silent" below would be unexplained and the whole arm would be measuring
// nothing (`instrument-discipline.md` MUST-3(a)).
{
  const probe = hookSays("Write", "MEMORY.md");
  if (probe.status !== 0) {
    fail("arm2/setup", `guard exited ${probe.status} on a known-positive (expected 0)`);
  } else if (!probe.fired) {
    fail("arm2/setup", "guard was SILENT on a known-positive — the arm cannot discriminate");
  } else {
    pass("arm2/setup", "guard fires on a known-positive");
  }
}

for (const c of cases) {
  const want = c.expected.verdict === "flagged";
  const { fired, status } = hookSays(c.input.toolName, c.input.filePath);
  if (status !== 0) {
    // `advisory` is non-blocking: exit 0 on every path. A non-zero here would
    // mean the guard learned teeth the rule never granted it.
    fail(`arm2/${c.name}`, `guard exited ${status} (expected 0 — advisory never blocks)`);
  } else if (fired === want) {
    pass(`arm2/${c.name}`, want ? "fired" : "silent");
  } else {
    fail(
      `arm2/${c.name}`,
      want ? "expected the finding, guard was SILENT" : "expected silence, guard FIRED",
    );
  }
}

/* ── ARM 3 — the falsifying pole for the TOOL GATE ──────────────────────────── */
process.stdout.write("ARM 3 — every flagged path under a non-Write tool must go SILENT\n");
for (const c of flaggedCases) {
  const { fired, status } = hookSays("Read", c.input.filePath);
  if (status !== 0) {
    fail(`arm3/${c.name}`, `guard exited ${status} (expected 0)`);
  } else if (fired) {
    fail(
      `arm3/${c.name}`,
      "FIRED on a Read — the tool gate is not load-bearing, and this detector would " +
        "annotate every session that merely loads its own memory",
    );
  } else {
    pass(`arm3/${c.name}`, "silent under Read");
  }
}

/* ── verdict ────────────────────────────────────────────────────────────────── */
process.stdout.write(
  `\nmemory-cascade: ${passed} passed, ${red.length} failed ` +
    `(${cases.length} fixture cases: ${flaggedCases.length} flagged / ${cleanCases.length} clean, ` +
    `x ARM1 predicate + ARM2 binary, + ${flaggedCases.length} ARM3 tool-gate cases)\n`,
);
if (red.length > 0) {
  process.stdout.write("\nRED SET — each line names the case and the identity mismatch:\n");
  for (const r of red) process.stdout.write(`  ${r.name} :: ${r.detail}\n`);
  process.exit(1);
}
process.exit(0);
