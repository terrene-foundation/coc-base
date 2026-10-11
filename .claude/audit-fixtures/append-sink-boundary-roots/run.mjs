#!/usr/bin/env node
/*
 * Audit fixture runner — every `appendSinkLine` caller UNDER `.claude/hooks/lib/`
 * whose sink lives under `.claude/learning/**` MUST pass
 * `additionalRoots: mainCheckoutBoundaryRoots(...)`.
 *
 * SCOPE, stated rather than implied (correctness round 1, F1): the enumerator below
 * covers `.claude/hooks/lib/*.js` ONLY — the nine drifted callers that motivated this
 * fixture all live there. Top-level `.claude/hooks/*.js` call sites were examined at
 * landing and none fails closed today, but they are NOT enumerated here, so this
 * fixture's green does not speak for them. A caller added OUTSIDE `hooks/lib` needs
 * `callerFiles()` extended first; do not read this fixture as covering "every caller".
 *
 * WHY THIS EXISTS. `.claude/learning/**` is SHARED state that resolves to the MAIN
 * CHECKOUT, so in a git worktree the session's own `repoDir` is the wrong containment
 * boundary — `append-sink.js` documents exactly this and offers `additionalRoots` for
 * it. The derivation was open-coded at the call sites and DRIFTED: of NINE callers,
 * only THREE carried it. The six that did not failed CLOSED from every worktree,
 * taking the journal-slot reservation and the `derives_from[]` emitter with them —
 * both MANDATORY `/codify` steps — while `worktree-isolation.md` MANDATES worktrees.
 * The measured symptom was `/codify` unable to complete from a worktree at all.
 *
 * Extracting the helper removes the copy-paste; THIS fixture is what stops caller
 * #10 from drifting again. A precondition with no enforcement is a precondition that
 * will be forgotten — which is the whole finding.
 *
 * Structural probes per rules/probe-driven-verification.md MUST-3: AST-free source
 * inspection of a closed, enumerated call-site set. No semantic judgment.
 *
 * Exit 0 = all fixtures pass. Exit 1 = >=1 fixture failed.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, "..", "..", "hooks", "lib");

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) {
    passed++;
    process.stdout.write(`  PASS  ${name}\n`);
  } else {
    failed++;
    process.stderr.write(`  FAIL  ${name}\n`);
    if (detail) process.stderr.write(`        ${detail}\n`);
  }
};

/** Every lib file that calls appendSinkLine, excluding the primitive itself.
 *  Scope: `.claude/hooks/lib/*.js` ONLY (see the header's SCOPE note) — extend this
 *  enumerator before relying on this fixture for a caller outside that directory. */
function callerFiles() {
  return readdirSync(LIB)
    .filter((f) => f.endsWith(".js") && f !== "append-sink.js")
    .filter((f) => readFileSync(path.join(LIB, f), "utf8").includes("appendSinkLine("));
}

/** Call sites in `src`, each with the window up to its closing `});`. */
function callWindows(src) {
  const out = [];
  const re = /appendSinkLine\(\{/g;
  let m;
  while ((m = re.exec(src))) {
    const tail = src.slice(m.index);
    const end = tail.indexOf("});");
    out.push(end === -1 ? tail.slice(0, 600) : tail.slice(0, end));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The denominator itself must be non-degenerate. A zero-caller run would pass
// every assertion below while measuring nothing — the empty-denominator shape.
// ---------------------------------------------------------------------------
const files = callerFiles();
check(
  "denominator-is-non-degenerate",
  files.length >= 5,
  `only ${files.length} appendSinkLine caller(s) found under ${LIB}; the sweep is not reaching the tree`,
);

// ---------------------------------------------------------------------------
// Every call site passes additionalRoots.
// ---------------------------------------------------------------------------
for (const f of files.sort()) {
  const src = readFileSync(path.join(LIB, f), "utf8");
  const windows = callWindows(src);
  check(
    `${f}/has-call-sites`,
    windows.length > 0,
    "file mentions appendSinkLine( but no `appendSinkLine({` call site parsed",
  );
  const missing = windows.filter((w) => !/additionalRoots/.test(w));
  check(
    `${f}/every-call-site-declares-additionalRoots`,
    missing.length === 0,
    `${missing.length} of ${windows.length} call site(s) omit additionalRoots — they fail CLOSED from any git worktree`,
  );
}

// ---------------------------------------------------------------------------
// The helper is exported, and is the ONE derivation (no re-open-coded copies).
// ---------------------------------------------------------------------------
const sink = readFileSync(path.join(LIB, "append-sink.js"), "utf8");
check(
  "helper-is-exported",
  /module\.exports\s*=\s*\{[\s\S]*mainCheckoutBoundaryRoots/.test(sink),
  "append-sink.js does not export mainCheckoutBoundaryRoots",
);
check(
  "helper-uses-fail-closed-resolver",
  /requireMainCheckout/.test(sink) && !/resolveMainCheckout\s*\(/.test(sink),
  "the helper must use requireMainCheckout (fail-closed), never the legacy resolveMainCheckout",
);

/**
 * Strip comments before asking whether CODE re-open-codes the derivation.
 * The first version of this check grepped the raw source and flagged three
 * callers whose only remaining mentions were in PROSE explaining the helper —
 * a lexical probe that cannot tell code from commentary, which is the same
 * defect class this whole fixture exists to catch. Test the code.
 */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const reopened = files.filter((f) => {
  const code = stripComments(readFileSync(path.join(LIB, f), "utf8"));
  // A real re-implementation IMPORTS the resolver; a mention cannot.
  return /require\([^)]*state-resolver\.js[^)]*\)/.test(code) && /requireMainCheckout\s*\(/.test(code);
});
check(
  "no-caller-re-opencodes-the-derivation",
  reopened.length === 0,
  `re-open-coded in: ${reopened.join(", ")} — call mainCheckoutBoundaryRoots() instead, or the drift returns`,
);

// ---------------------------------------------------------------------------
// Negative control: the detector must FIRE on a known-bad shape. Without this a
// green run is a statement about the detector, not the tree.
// ---------------------------------------------------------------------------
const BAD = `const w = appendSinkLine({ repoDir, sinkPath: p, line });`;
const GOOD = `const w = appendSinkLine({\n  repoDir,\n  additionalRoots: mainCheckoutBoundaryRoots(repoDir),\n  sinkPath: p,\n  line,\n});`;
check(
  "negative-control-detector-fires-on-known-bad",
  callWindows(BAD).length === 1 && !/additionalRoots/.test(callWindows(BAD)[0]),
  "the detector did not flag a call site that omits additionalRoots — it cannot flag a real one either",
);
check(
  "negative-control-detector-silent-on-known-good",
  callWindows(GOOD).length === 1 && /additionalRoots/.test(callWindows(GOOD)[0]),
  "the detector flagged a compliant call site — false positive",
);

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
