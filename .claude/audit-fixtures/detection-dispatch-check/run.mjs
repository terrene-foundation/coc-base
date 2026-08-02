#!/usr/bin/env node
/*
 * Audit fixture runner for `.claude/bin/detection-dispatch-check.mjs`
 * (cc-artifacts.md Rule 9 — committed structural fixtures for a mechanical
 * audit tool).
 *
 * WHAT THIS LOCKS
 *   The scanner's value is entirely in its SCOPE-RESTRICTION PREDICATES: which
 *   require forms it can see, and which claim states it treats as fatal. Both
 *   are exactly the kind of non-obvious predicate Rule 9 exists to pin, and one
 *   of them has ALREADY drawn blood — see fixture-02.
 *
 *   Structural probes only (probe-driven-verification.md MUST-3): equality and
 *   membership checks over pure-function outputs. No semantic judgment, no regex
 *   over assistant prose, no network, no git.
 *
 * WHY THE REQUIRE-FORM MATRIX IS LOAD-BEARING (fixture-02)
 *   The first cut of RE_REQUIRE_JOIN allowed a trailing comma INSIDE
 *   `path.join(...)` but not AFTER it, so it missed every wrapped multi-line
 *   `require(\n  path.join(__dirname, "lib", "x.js"),\n)` — the dominant form in
 *   this corpus. The scanner then reported
 *   `.claude/hooks/lib/provenance-author-backing.js` as UNDISPATCHED while
 *   `.claude/hooks/journal-write-guard.js:108` requires it and IS registered.
 *   That is a FALSE RED, and a false red on this instrument is the worst
 *   outcome available: it dispatches a remediation lane against working code and
 *   teaches the reader to discount the tool. fixture-02 is the regression lock.
 *
 * Exit 0 = all fixtures pass. Exit 1 = >=1 fixture failed.
 */

import {
  buildDispatchClosure,
  classifyClaim,
  countSymbolSites,
  extractRequireEdges,
  loadRegisteredRoots,
  stripComments,
  stripFrontmatter,
} from "../../bin/detection-dispatch-check.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

/** Build a throwaway repo tree; returns its root. Caller removes it. */
function makeRepo(files) {
  const root = mkdtempSync(join(tmpdir(), "ddc-fixture-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

// ==========================================================================
// A. Require-form matrix — what the graph walker can SEE.
// ==========================================================================

// ------------------------------------------------------------------
// fixture-01-require-join-single-line
// ------------------------------------------------------------------
{
  const src = `const P = require(path.join(__dirname, "lib", "violation-patterns.js"));`;
  const { specifiers, dynamic } = extractRequireEdges(src);
  check(
    "fixture-01-require-join-single-line",
    specifiers.includes("./lib/violation-patterns.js") && dynamic === 0,
    `got specifiers=${JSON.stringify(specifiers)} dynamic=${dynamic}`,
  );
}

// ------------------------------------------------------------------
// fixture-02-require-join-multiline-trailing-comma  <-- REGRESSION LOCK
// The exact shape at .claude/hooks/journal-write-guard.js:108 whose omission
// produced a false UNDISPATCHED red against provenance-author-backing.js.
// ------------------------------------------------------------------
{
  const src = [
    "const { checkAuthorBacking } = require(",
    '  path.join(__dirname, "lib", "provenance-author-backing.js"),',
    ");",
  ].join("\n");
  const { specifiers } = extractRequireEdges(src);
  check(
    "fixture-02-require-join-multiline-trailing-comma",
    specifiers.includes("./lib/provenance-author-backing.js"),
    `got specifiers=${JSON.stringify(specifiers)} — a miss here re-opens the false-red class`,
  );
}

// ------------------------------------------------------------------
// fixture-03-require-literal-relative
// ------------------------------------------------------------------
{
  const src = `const { buildEdge } = require("./derives-from-edge.js");`;
  const { specifiers } = extractRequireEdges(src);
  check(
    "fixture-03-require-literal-relative",
    specifiers.includes("./derives-from-edge.js"),
    `got ${JSON.stringify(specifiers)}`,
  );
}

// ------------------------------------------------------------------
// fixture-04-require-literal-multiline-trailing-comma
// ------------------------------------------------------------------
{
  const src = ['const x = require(', '  "./lib/state-io.js",', ");"].join("\n");
  const { specifiers } = extractRequireEdges(src);
  check(
    "fixture-04-require-literal-multiline-trailing-comma",
    specifiers.includes("./lib/state-io.js"),
    `got ${JSON.stringify(specifiers)}`,
  );
}

// ------------------------------------------------------------------
// fixture-05-esm-import-from
// Hooks are CJS today; a future .mjs hook must not fall silently out of graph.
// ------------------------------------------------------------------
{
  const src = `import { emit } from "./lib/instruct-and-wait.js";`;
  const { specifiers } = extractRequireEdges(src);
  check(
    "fixture-05-esm-import-from",
    specifiers.includes("./lib/instruct-and-wait.js"),
    `got ${JSON.stringify(specifiers)}`,
  );
}

// ------------------------------------------------------------------
// fixture-06-dynamic-require-counted-never-guessed
// An unresolvable edge must be COUNTED, not silently dropped and not invented.
// ------------------------------------------------------------------
{
  const src = `const mod = require(detectorPath);`;
  const { specifiers, dynamic } = extractRequireEdges(src);
  check(
    "fixture-06-dynamic-require-counted-never-guessed",
    dynamic === 1 && specifiers.length === 0,
    `got specifiers=${JSON.stringify(specifiers)} dynamic=${dynamic}`,
  );
}

// ------------------------------------------------------------------
// fixture-07-bare-specifier-not-an-in-repo-edge
// `require("path")` is a builtin: captured as a specifier, never resolvable to
// an in-repo file. Proven at the closure level in fixture-12.
// ------------------------------------------------------------------
{
  const src = `const path = require("path");`;
  const { specifiers, dynamic } = extractRequireEdges(src);
  check(
    "fixture-07-bare-specifier-not-an-in-repo-edge",
    specifiers.includes("path") && dynamic === 0,
    `got specifiers=${JSON.stringify(specifiers)} dynamic=${dynamic}`,
  );
}

// ==========================================================================
// B. settings.json root extraction (Leg A input).
// ==========================================================================

// ------------------------------------------------------------------
// fixture-08-roots-extracted-with-event-and-matcher
// ------------------------------------------------------------------
{
  const root = makeRepo({
    ".claude/settings.json": JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/detect-violations.js"',
              },
            ],
          },
        ],
      },
    }),
  });
  try {
    const { roots, ok } = loadRegisteredRoots(root);
    const events = roots.get(".claude/hooks/detect-violations.js");
    check(
      "fixture-08-roots-extracted-with-event-and-matcher",
      ok &&
        roots.size === 1 &&
        events &&
        events[0].event === "PostToolUse" &&
        events[0].matcher === "Bash",
      `got size=${roots.size} events=${JSON.stringify(events)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-09-zero-roots-fails-closed
// An empty root set would make EVERY claim read as undispatched. That must be a
// gate, never a finding list.
// ------------------------------------------------------------------
{
  const root = makeRepo({ ".claude/settings.json": JSON.stringify({ hooks: {} }) });
  try {
    const { roots, ok } = loadRegisteredRoots(root);
    check(
      "fixture-09-zero-roots-fails-closed",
      ok === false && roots.size === 0,
      `got ok=${ok} size=${roots.size}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-10-malformed-settings-fails-closed
// ------------------------------------------------------------------
{
  const root = makeRepo({ ".claude/settings.json": "{ not json" });
  try {
    const { ok, detail } = loadRegisteredRoots(root);
    check(
      "fixture-10-malformed-settings-fails-closed",
      ok === false && /not valid JSON/.test(detail),
      `got ok=${ok} detail=${detail}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ==========================================================================
// C. Transitive closure (Leg B) — the core of the new question.
// ==========================================================================

// ------------------------------------------------------------------
// fixture-11-transitive-two-hops-reachable
// registered hook -> lib-a -> lib-b. lib-b IS dispatched.
// ------------------------------------------------------------------
{
  const root = makeRepo({
    ".claude/hooks/entry.js": 'require(path.join(__dirname, "lib", "a.js"));',
    ".claude/hooks/lib/a.js": 'require("./b.js");',
    ".claude/hooks/lib/b.js": "module.exports = {};",
  });
  try {
    const roots = new Map([[".claude/hooks/entry.js", [{ event: "Stop", matcher: "*" }]]]);
    const { reach } = buildDispatchClosure(root, roots);
    check(
      "fixture-11-transitive-two-hops-reachable",
      reach.has(".claude/hooks/lib/b.js") && reach.get(".claude/hooks/lib/b.js").depth === 2,
      `keys=${JSON.stringify([...reach.keys()])}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-12-unregistered-hook-does-not-confer-dispatch  <-- LEG B CORE
// lib-c is required ONLY by a hook that settings.json never registers. A lib
// required only by another unreachable file is STILL undispatched — this is the
// precise property a naive "is it referenced anywhere?" grep gets wrong.
// ------------------------------------------------------------------
{
  const root = makeRepo({
    ".claude/hooks/registered.js": 'const path = require("path");',
    ".claude/hooks/orphan.js": 'require("./lib/c.js");',
    ".claude/hooks/lib/c.js": "module.exports = {};",
  });
  try {
    const roots = new Map([[".claude/hooks/registered.js", [{ event: "Stop", matcher: "*" }]]]);
    const { reach } = buildDispatchClosure(root, roots);
    check(
      "fixture-12-unregistered-hook-does-not-confer-dispatch",
      !reach.has(".claude/hooks/lib/c.js") && !reach.has("path"),
      `keys=${JSON.stringify([...reach.keys()])} — c.js is referenced, but not DISPATCHED`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-13-require-cycle-terminates
// A <-> B must not hang the walker.
// ------------------------------------------------------------------
{
  const root = makeRepo({
    ".claude/hooks/entry.js": 'require("./lib/a.js");',
    ".claude/hooks/lib/a.js": 'require("./b.js");',
    ".claude/hooks/lib/b.js": 'require("./a.js");',
  });
  try {
    const roots = new Map([[".claude/hooks/entry.js", [{ event: "Stop", matcher: "*" }]]]);
    const { reach } = buildDispatchClosure(root, roots);
    check(
      "fixture-13-require-cycle-terminates",
      reach.has(".claude/hooks/lib/a.js") && reach.has(".claude/hooks/lib/b.js"),
      `keys=${JSON.stringify([...reach.keys()])}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-14-extensionless-specifier-resolves
// ------------------------------------------------------------------
{
  const root = makeRepo({
    ".claude/hooks/entry.js": 'require(path.join(__dirname, "lib", "d"));',
    ".claude/hooks/lib/d.js": "module.exports = {};",
  });
  try {
    const roots = new Map([[".claude/hooks/entry.js", [{ event: "Stop", matcher: "*" }]]]);
    const { reach } = buildDispatchClosure(root, roots);
    check(
      "fixture-14-extensionless-specifier-resolves",
      reach.has(".claude/hooks/lib/d.js"),
      `keys=${JSON.stringify([...reach.keys()])}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-15-closure-never-escapes-root
// A `../../..` specifier must not walk out of the scanned tree.
// ------------------------------------------------------------------
{
  const root = makeRepo({
    ".claude/hooks/entry.js": 'require("../../../../etc/passwd");',
  });
  try {
    const roots = new Map([[".claude/hooks/entry.js", [{ event: "Stop", matcher: "*" }]]]);
    const { reach } = buildDispatchClosure(root, roots);
    check(
      "fixture-15-closure-never-escapes-root",
      reach.size === 1 && reach.has(".claude/hooks/entry.js"),
      `keys=${JSON.stringify([...reach.keys()])}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ==========================================================================
// D. classifyClaim state matrix — which states carry teeth.
//
// hook-output-discipline.md MUST-2: teeth only on a structural signal. Exactly
// ONE state below is fatal, and the non-fatal ones are non-fatal for stated
// reasons (sanctioned deferral / another scanner's red / not a dispatch unit).
// ==========================================================================
{
  const roots = new Map([[".claude/hooks/entry.js", [{ event: "Stop", matcher: "*" }]]]);
  const reach = new Map([
    [".claude/hooks/entry.js", { root: ".claude/hooks/entry.js", events: [], depth: 0, via: [] }],
    [".claude/hooks/lib/reached.js", { root: ".claude/hooks/entry.js", events: [], depth: 1, via: [] }],
  ]);
  const claim = (over) => ({ path: ".claude/hooks/lib/x.js", deferred: false, resolves: true, ...over });

  const cases = [
    ["fixture-16-deferred-not-fatal", claim({ deferred: true }), "deferred", false],
    ["fixture-17-unresolved-delegated-not-fatal", claim({ resolves: false }), "unresolved-delegated", false],
    ["fixture-18-directory-not-dispatchable", claim({ path: ".claude/hooks/lib/" }), "non-dispatchable-target", false],
    ["fixture-19-non-script-not-dispatchable", claim({ path: ".claude/hooks/README.md" }), "non-dispatchable-target", false],
    ["fixture-20-registered-root-is-dispatched-direct", claim({ path: ".claude/hooks/entry.js" }), "dispatched-direct", false],
    ["fixture-21-in-closure-is-dispatched-transitive", claim({ path: ".claude/hooks/lib/reached.js" }), "dispatched-transitive", false],
    ["fixture-22-unreachable-is-undispatched-and-fatal", claim({}), "undispatched", true],
  ];

  for (const [name, input, expectState, expectFatal] of cases) {
    const got = classifyClaim(input, roots, reach);
    check(
      name,
      got.state === expectState && got.fatal === expectFatal,
      `got state=${got.state} fatal=${got.fatal}, want state=${expectState} fatal=${expectFatal}`,
    );
  }
}

// ------------------------------------------------------------------
// fixture-23-deferred-precedes-unreachable
// A deferred claim naming an unreachable file stays a sanctioned promise. If
// this inverted, the scanner would red the whole corpus on the two-phase
// rollout pattern trust-posture.md explicitly permits.
// ------------------------------------------------------------------
{
  const got = classifyClaim(
    { path: ".claude/hooks/lib/nope.js", deferred: true, resolves: true },
    new Map(),
    new Map(),
  );
  check(
    "fixture-23-deferred-precedes-unreachable",
    got.state === "deferred" && got.fatal === false,
    `got ${JSON.stringify(got)}`,
  );
}

// ==========================================================================
// E. countSymbolSites — the symbol-liveness predicate.
//
// This predicate replaced one that SKIPPED THE DEFINING FILE outright, which
// turned every symbol defined-and-called in a single dispatched file into a
// false accusation of deadness. Two live symbols in this repo have that exact
// shape, one of which demonstrably fired against a real command. The cases below
// pin both directions of that repair and the inverse error it introduced on the
// first attempt (an inline `module.exports = { sym }` read as a use).
// ==========================================================================

// ------------------------------------------------------------------
// fixture-24-intra-file-call-is-a-use  <-- THE REPAIR
// ------------------------------------------------------------------
{
  const src = [
    "function decideGate({ a }) { return a; }",
    "function main() {",
    "  const decision = decideGate({ a: 1 });",
    "}",
    "module.exports = {",
    "  decideGate,",
    "};",
  ].join("\n");
  const { definitions, uses } = countSymbolSites(src, "decideGate");
  check(
    "fixture-24-intra-file-call-is-a-use",
    definitions === 1 && uses === 1,
    `got definitions=${definitions} uses=${uses} — skipping the defining file is what falsely accused live symbols`,
  );
}

// ------------------------------------------------------------------
// fixture-25-bare-export-listing-is-not-a-use
// ------------------------------------------------------------------
{
  const src = ["function f() {}", "module.exports = {", "  f,", "};"].join("\n");
  const { definitions, uses } = countSymbolSites(src, "f");
  check(
    "fixture-25-bare-export-listing-is-not-a-use",
    definitions === 1 && uses === 0,
    `got definitions=${definitions} uses=${uses}`,
  );
}

// ------------------------------------------------------------------
// fixture-26-inline-export-manifest-is-not-a-use
// The inverse error the first repair introduced: `module.exports = { f };` on
// ONE line was counted as a use, reporting a never-called symbol as `invoked`.
// ------------------------------------------------------------------
{
  const src = ["function neverCalled({ a }) { return a; }", "module.exports = { neverCalled };"].join("\n");
  const { definitions, uses } = countSymbolSites(src, "neverCalled");
  check(
    "fixture-26-inline-export-manifest-is-not-a-use",
    definitions === 1 && uses === 0,
    `got definitions=${definitions} uses=${uses}`,
  );
}

// ------------------------------------------------------------------
// fixture-27-comment-mention-is-not-a-use
// `detectStreetlightSelection` is named in four comments and called nowhere.
// Counting comment mentions returns a false all-clear on a genuinely dead
// detector — the failure direction that matters most here.
// ------------------------------------------------------------------
{
  const src = [
    "function detectStreetlightSelection(text) { return null; }",
    "// Companion to detectStreetlightSelection — that one scans prose",
    "/* block comment naming detectStreetlightSelection twice: detectStreetlightSelection */",
    "module.exports = { detectStreetlightSelection };",
  ].join("\n");
  const { definitions, uses } = countSymbolSites(stripComments(src), "detectStreetlightSelection");
  check(
    "fixture-27-comment-mention-is-not-a-use",
    definitions === 1 && uses === 0,
    `got definitions=${definitions} uses=${uses}`,
  );
}

// ------------------------------------------------------------------
// fixture-28-call-inside-export-manifest-line-still-counts
// Guard against the exclusion over-reaching: an actual CALL on a line that also
// matches `exports =` must remain a use.
// ------------------------------------------------------------------
{
  const src = ["function g() {}", "module.exports = { value: g() };"].join("\n");
  const { uses } = countSymbolSites(src, "g");
  check("fixture-28-call-inside-export-manifest-line-still-counts", uses === 1, `got uses=${uses}`);
}

// ------------------------------------------------------------------
// fixture-29-non-callable-export-reference-is-a-use
// `MUTATION_TOOLS` is a Set: referenced, never invoked. Counting CALLS instead
// of USES would report every such constant dead.
// ------------------------------------------------------------------
{
  const src = "if (MUTATION_TOOLS.has(tool)) { return true; }";
  const { definitions, uses } = countSymbolSites(src, "MUTATION_TOOLS");
  check(
    "fixture-29-non-callable-export-reference-is-a-use",
    definitions === 0 && uses === 1,
    `got definitions=${definitions} uses=${uses}`,
  );
}

// ------------------------------------------------------------------
// fixture-30-regex-metacharacters-in-symbol-do-not-crash
// ------------------------------------------------------------------
{
  const { definitions, uses } = countSymbolSites("const a = 1;", "we.ird$sym");
  check(
    "fixture-30-regex-metacharacters-in-symbol-do-not-crash",
    definitions === 0 && uses === 0,
    `got definitions=${definitions} uses=${uses}`,
  );
}

// ==========================================================================
// F. Comment / string-literal masking on the GATE surface.
//
// The comment bug was fixed once in the symbol DIAGNOSTIC and left standing in
// the edge extractor that feeds the TEETH. One commented-out require in any
// registered hook laundered a dead lib to `dispatched-transitive` — the
// FAIL-OPEN direction, which HIDES findings, on the surface that reds the gate.
// These cases pin the repair at the layer that matters.
// ==========================================================================

// ------------------------------------------------------------------
// fixture-31-line-comment-is-not-an-edge
// ------------------------------------------------------------------
{
  const { specifiers } = extractRequireEdges('// require("./lib/dead.js");\nconst p = require("path");');
  check(
    "fixture-31-line-comment-is-not-an-edge",
    !specifiers.includes("./lib/dead.js") && specifiers.includes("path"),
    `got ${JSON.stringify(specifiers)}`,
  );
}

// ------------------------------------------------------------------
// fixture-32-block-comment-is-not-an-edge
// ------------------------------------------------------------------
{
  const { specifiers } = extractRequireEdges('/*\n require("./lib/dead.js");\n*/\nconst p = require("path");');
  check(
    "fixture-32-block-comment-is-not-an-edge",
    !specifiers.includes("./lib/dead.js"),
    `got ${JSON.stringify(specifiers)}`,
  );
}

// ------------------------------------------------------------------
// fixture-33-require-inside-a-string-is-not-an-edge
// ------------------------------------------------------------------
{
  const { specifiers } = extractRequireEdges(`const doc = "call require('./lib/dead.js') to load";`);
  check(
    "fixture-33-require-inside-a-string-is-not-an-edge",
    !specifiers.includes("./lib/dead.js"),
    `got ${JSON.stringify(specifiers)}`,
  );
}

// ------------------------------------------------------------------
// fixture-34-masking-preserves-real-specifiers
// The masker must not over-reach: a genuine require survives, and an apostrophe
// in a comment must not desync the string state and swallow following code.
// ------------------------------------------------------------------
{
  const src = ["// don't let this apostrophe desync the scan", 'require("./lib/real.js");'].join("\n");
  const { specifiers } = extractRequireEdges(src);
  check(
    "fixture-34-masking-preserves-real-specifiers",
    specifiers.includes("./lib/real.js"),
    `got ${JSON.stringify(specifiers)}`,
  );
}

// ------------------------------------------------------------------
// fixture-35-export-from-and-bare-import-are-edges
// Previously invisible: neither followed nor counted as dynamic.
// ------------------------------------------------------------------
{
  const src = ['export { a } from "./x.js";', 'export * from "./y.js";', 'import "./z.js";'].join("\n");
  const { specifiers } = extractRequireEdges(src);
  check(
    "fixture-35-export-from-and-bare-import-are-edges",
    ["./x.js", "./y.js", "./z.js"].every((s) => specifiers.includes(s)),
    `got ${JSON.stringify(specifiers)}`,
  );
}

// ------------------------------------------------------------------
// fixture-36-string-hook-path-is-collected
// The `FOLD_PATH = ".claude/hooks/lib/fold-rule-9c.js"` dispatch shape.
// ------------------------------------------------------------------
{
  const { stringPaths } = extractRequireEdges('const FOLD_PATH = ".claude/hooks/lib/fold-rule-9c.js";');
  check(
    "fixture-36-string-hook-path-is-collected",
    stringPaths.includes(".claude/hooks/lib/fold-rule-9c.js"),
    `got ${JSON.stringify(stringPaths)}`,
  );
}

// ------------------------------------------------------------------
// fixture-37-commented-hook-path-is-not-collected
// ------------------------------------------------------------------
{
  const { stringPaths } = extractRequireEdges('// see ".claude/hooks/lib/fold-rule-9c.js" for the shape');
  check(
    "fixture-37-commented-hook-path-is-not-collected",
    stringPaths.length === 0,
    `got ${JSON.stringify(stringPaths)}`,
  );
}

// ------------------------------------------------------------------
// fixture-38-dynamic-import-counted
// `import(expr)` was uncounted while the bound claimed such edges are caveated.
// ------------------------------------------------------------------
{
  const { dynamic } = extractRequireEdges("const m = import(modulePath);");
  check("fixture-38-dynamic-import-counted", dynamic === 1, `got dynamic=${dynamic}`);
}

// ------------------------------------------------------------------
// fixture-43-dead-code-require-is-FOLLOWED (documents a BOUND, not a bug)
//
// Extraction is POSITION-aware (comments and strings are masked) but not
// REACHABILITY-aware: a specifier in code that never runs still confers an edge.
// Pinned deliberately, and asserting the CURRENT behaviour rather than the
// desirable one, so that STATED BOUNDS #2 and the code cannot drift apart — if a
// later change adds control-flow analysis, this case reds and forces the bound to
// be rewritten in the same commit. A prose-only bound has nothing holding it.
//
// Direction matters: this is FALSE-GREEN (a dead `require` clears a claim), so it
// hides a finding rather than inventing one, and it is a usable evasion.
// ------------------------------------------------------------------
{
  const deadIf = extractRequireEdges('if (false) { require("./lib/dead.js"); }');
  const deadReturn = extractRequireEdges('function f(){ return 1; require("./lib/dead.js"); }');
  check(
    "fixture-43-dead-code-require-is-FOLLOWED",
    deadIf.specifiers.includes("./lib/dead.js") && deadReturn.specifiers.includes("./lib/dead.js"),
    `if(false)=${JSON.stringify(deadIf.specifiers)} after-return=${JSON.stringify(deadReturn.specifiers)} — if these are now EMPTY the scanner gained reachability analysis and STATED BOUNDS #2 must be rewritten`,
  );
}

// ==========================================================================
// G. Containment + frontmatter.
// ==========================================================================

// ------------------------------------------------------------------
// fixture-39-escaping-symlink-is-refused
// security.md § Path Containment: a lexically-contained symlink whose TARGET
// escapes must not be followed — the walker READS and parses what it resolves.
// ------------------------------------------------------------------
{
  const outside = mkdtempSync(join(tmpdir(), "ddc-out-"));
  writeFileSync(join(outside, "escapee.js"), "module.exports = {};\n");
  const root = makeRepo({ ".claude/hooks/entry.js": 'require("./lib/escape.js");' });
  try {
    mkdirSync(join(root, ".claude/hooks/lib"), { recursive: true });
    symlinkSync(join(outside, "escapee.js"), join(root, ".claude/hooks/lib/escape.js"));
    const roots = new Map([[".claude/hooks/entry.js", [{ event: "Stop", matcher: "*" }]]]);
    const { reach } = buildDispatchClosure(root, roots);
    check(
      "fixture-39-escaping-symlink-is-refused",
      reach.size === 1,
      `keys=${JSON.stringify([...reach.keys()])}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-40-in-tree-symlink-is-followed
// The containment fix must not over-reach into refusing legitimate in-tree links.
// ------------------------------------------------------------------
{
  const root = makeRepo({
    ".claude/hooks/entry.js": 'require("./lib/link.js");',
    ".claude/hooks/lib/actual.js": "module.exports = {};\n",
  });
  try {
    symlinkSync(join(root, ".claude/hooks/lib/actual.js"), join(root, ".claude/hooks/lib/link.js"));
    const roots = new Map([[".claude/hooks/entry.js", [{ event: "Stop", matcher: "*" }]]]);
    const { reach } = buildDispatchClosure(root, roots);
    check(
      "fixture-40-in-tree-symlink-is-followed",
      reach.has(".claude/hooks/lib/actual.js"),
      `keys=${JSON.stringify([...reach.keys()])}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-41-frontmatter-stripped-line-numbers-preserved
// ------------------------------------------------------------------
{
  const src = ['---', 'paths:', '  - "**/.claude/hooks/**"', '---', '', 'body line 6'].join("\n");
  const out = stripFrontmatter(src);
  check(
    "fixture-41-frontmatter-stripped-line-numbers-preserved",
    !out.includes(".claude/hooks") &&
      out.split("\n").length === src.split("\n").length &&
      out.split("\n")[5] === "body line 6",
    `got ${JSON.stringify(out)}`,
  );
}

// ------------------------------------------------------------------
// fixture-42-no-frontmatter-passes-through
// ------------------------------------------------------------------
{
  const src = "# Rule\n\nbody\n";
  check("fixture-42-no-frontmatter-passes-through", stripFrontmatter(src) === src, "content changed");
}

// ==========================================================================
process.stdout.write(`\ndetection-dispatch-check fixtures: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
