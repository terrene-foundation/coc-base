#!/usr/bin/env node
/**
 * Audit fixtures for the CLASS-DERIVED pin sets in
 * `.claude/bin/coc-manifest-integrity.mjs` (loom#1393), per `cc-artifacts.md`
 * Rule 9 — one committed case per scope-restriction predicate the tool relies
 * on, with BOTH polarities (a case that MUST flag and a case that MUST stay
 * clean).
 *
 * Inline-case layout (the `run.mjs` variant Rule 9 permits alongside the sidecar
 * layout; see `.claude/audit-fixtures/codex-dispatcher/README.md` § "Fixture
 * layout"). Cases are inline because each one is a whole synthetic REPO TREE —
 * `.claude/VERSION` + eval-manifest + on-disk scanner/fixture files — and a
 * sidecar pair per tree would scatter one logical case across a directory.
 *
 * The predicate under test: checks (c) and (i) derive their backing sets from
 * `.claude/VERSION::type`, and EVERY unresolvable/undeclared shape fails CLOSED.
 * Before loom#1393 both sets were a flat `[]` shipped verbatim to BUILD, where
 * the checks could never fire and the harness still printed green.
 *
 * Run: node .claude/audit-fixtures/coc-manifest-integrity-class-derived/run.mjs
 * Exit 0 = every case matched its expectation; non-zero = mismatch (the Rule 9
 * runner contract).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// .claude/audit-fixtures/<tool> -> repo root is three up.
const repoRoot = resolve(__dirname, "..", "..", "..");
const { checkManifestIntegrity } = await import(
  join(repoRoot, ".claude", "bin", "coc-manifest-integrity.mjs")
);

const trees = [];
process.on("exit", () => {
  for (const t of trees) {
    try {
      rmSync(t, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

/** Materialize a synthetic repo tree. `klass === null` omits .claude/VERSION. */
function mkTree(manifest, files, klass) {
  const root = mkdtempSync(join(tmpdir(), "cocmi-fixture-"));
  trees.push(root);
  mkdirSync(join(root, ".claude", "test-harness"), { recursive: true });
  if (klass !== null) {
    writeFileSync(join(root, ".claude", "VERSION"), JSON.stringify({ type: klass }));
  }
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    if (content === null) {
      mkdirSync(abs, { recursive: true });
    } else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
  }
  const mp = join(root, ".claude", "test-harness", "eval-manifest.json");
  writeFileSync(mp, JSON.stringify(manifest, null, 2));
  return { root, mp };
}

// A well-formed bipolar structural entry + the on-disk files it declares.
const entryFiles = () => ({
  ".claude/bin/demo-readiness-check.mjs": "// synthetic scanner stub\n",
  ".claude/audit-fixtures/demo/clean": null,
  ".claude/audit-fixtures/demo/bad": null,
});
const entry = () => ({
  demo: {
    type: "tool",
    scanner: ".claude/bin/demo-readiness-check.mjs",
    fixturesDir: ".claude/audit-fixtures/demo",
    expected: {
      clean: { exit: 0, grade: "VALID" },
      bad: { exit: 1, grade: "INVALID", critical_failures: ["demo-violation"] },
    },
    probes: null,
  },
});
const pin = () => ({
  demo: {
    type: "tool",
    scanner: ".claude/bin/demo-readiness-check.mjs",
    fixturesDir: ".claude/audit-fixtures/demo",
  },
});
const decl = () => ({
  reason: "this repo adopts the eval engine and has authored no local structural scanners yet",
  graduation: "removed in the same change that registers the first local structural scanner entry",
  expires: "2099-01-01",
});

// The IN-CODE required structural entry for MANIFEST_OWNER_CLASS (coc-source).
//
// This set was EMPTY until 2026-07-28, when `detection-binding-check` landed as
// loom's first local structural scanner (coc-manifest-integrity.mjs § (i)). A
// coc-source case that wants to be CLEAN must now satisfy that requirement — the
// in-code branch governs, and check (i) hard-fails a missing pinned entry because
// deleting one erases a whole coverage tier while the gate stays green.
//
// Mirrors the pinned triple exactly; a drift here re-opens the class the pin closes.
const requiredEntry = () => ({
  "detection-binding-check": {
    type: "tool",
    scanner: ".claude/bin/detection-binding-check.mjs",
    fixturesDir: ".claude/audit-fixtures/detection-binding-check",
    expected: {
      clean: { exit: 0, grade: "VALID" },
      bad: { exit: 1, grade: "INVALID", critical_failures: ["detection-binding-violation"] },
    },
    probes: null,
  },
});
const requiredEntryFiles = () => ({
  ".claude/bin/detection-binding-check.mjs": "// synthetic scanner stub\n",
  ".claude/audit-fixtures/detection-binding-check/clean": null,
  ".claude/audit-fixtures/detection-binding-check/bad": null,
});

const cases = [
  // ── predicate: class resolution (fail-closed half) ────────────────────────
  {
    name: "01-unresolved-class-no-version",
    why: "no .claude/VERSION — the class cannot be established, so the pin sets must NOT default to empty",
    expect: "flag",
    match: "repo class UNRESOLVED",
    build: () => mkTree(entry(), entryFiles(), null),
  },
  {
    name: "02-unresolved-class-unknown-value",
    why: "an out-of-vocabulary class value — positive allowlist, never bucketed into a branch",
    expect: "flag",
    match: "repo class UNRESOLVED",
    build: () => mkTree(entry(), entryFiles(), "coc-invented-class"),
  },
  // ── predicate: in-code branch (coc-source) ────────────────────────────────
  {
    name: "03-coc-source-in-code-set-clean",
    why: "loom's own class: the in-code set governs — a manifest SATISFYING it must stay clean. (The set was empty until 2026-07-28; `detection-binding-check` now populates it, so the conforming manifest must carry that entry.)",
    expect: "clean",
    build: () =>
      mkTree(
        { ...entry(), ...requiredEntry() },
        { ...entryFiles(), ...requiredEntryFiles() },
        "coc-source",
      ),
  },
  {
    name: "04-coc-source-stray-declaration-flagged",
    why: "a manifest pin at the in-code class would be SILENTLY IGNORED — say so instead of dropping it",
    expect: "flag",
    match: "SILENTLY IGNORED",
    build: () => mkTree({ ...entry(), _required_structural_entries: pin() }, entryFiles(), "coc-source"),
  },
  // ── predicate: manifest-declared branch (every other class) ───────────────
  {
    name: "05-coc-build-undeclared-warns",
    why: "THE loom#1393 regression: pre-fix this printed PASS in SILENCE on every BUILD repo. Now loud (WARN, not fail — security.md secure-default: a hard fail would brick an un-surveyed consumer)",
    expect: "warn",
    match: "ASSERT NOTHING",
    build: () => mkTree(entry(), entryFiles(), "coc-build"),
  },
  {
    name: "05b-coc-build-undeclared-warn-is-actionable",
    why: "a warning that does not name the stanza AND the wiring is one the reader routes around",
    expect: "warn",
    match: "_required_structural_entries",
    build: () => mkTree(entry(), entryFiles(), "coc-build"),
  },
  {
    name: "06-coc-build-declared-no-pins-clean",
    why: "an explicit, substantive, EXPIRING no-pins declaration is the legible way to be green",
    expect: "clean",
    build: () => mkTree({ ...entry(), _declared_no_pins: decl() }, entryFiles(), "coc-build"),
  },
  {
    name: "07-coc-build-expired-declaration-flagged",
    why: "an expired declaration is a permanent blanket — it must age out",
    expect: "flag",
    match: "EXPIRED",
    build: () =>
      mkTree({ ...entry(), _declared_no_pins: { ...decl(), expires: "2020-01-01" } }, entryFiles(), "coc-build"),
  },
  // ── predicate: the pin itself is NON-VACUOUS on the BUILD side ────────────
  {
    name: "08-coc-build-pin-intact-clean",
    why: "anti-vacuity CONTROL — proves case 09 fails from the disarm, not because a BUILD tree cannot pass",
    expect: "clean",
    build: () => mkTree({ ...entry(), _required_structural_entries: pin() }, entryFiles(), "coc-build"),
  },
  {
    name: "09-coc-build-pinned-entry-deleted-flagged",
    why: "the disarm (i) exists to catch, now REACHABLE on BUILD: entry deleted, pin notices",
    expect: "flag",
    match: "required structural entry 'demo'",
    build: () =>
      mkTree(
        { _required_structural_entries: pin(), _declared_empty: decl() },
        entryFiles(),
        "coc-build",
      ),
  },
  {
    name: "10-coc-build-fixturesdir-repoint-flagged",
    why: "the (h)-sibling decoy lever: repointing fixturesDir to a fresh tree must be a HARD fail",
    expect: "flag",
    match: "fixturesDir is pinned to",
    build: () => {
      const m = { ...entry(), _required_structural_entries: pin() };
      m.demo.fixturesDir = ".claude/audit-fixtures/decoy";
      return mkTree(
        m,
        { ...entryFiles(), ".claude/audit-fixtures/decoy/clean": null, ".claude/audit-fixtures/decoy/bad": null },
        "coc-build",
      );
    },
  },
];

let failed = 0;
for (const c of cases) {
  const { root, mp } = c.build();
  const r = checkManifestIntegrity({ manifestPath: mp, repoRoot: root });
  try {
    if (c.expect === "clean") {
      assert.equal(r.ok, true, `expected CLEAN but got errors: ${JSON.stringify(r.errors)}`);
      assert.equal(
        (r.warnings ?? []).length,
        0,
        `a CLEAN case must not warn either, got: ${JSON.stringify(r.warnings)}`,
      );
    } else if (c.expect === "warn") {
      // Non-terminal but NEVER silent — the secure-default WARN path.
      assert.equal(r.ok, true, `expected a non-terminal WARN but the check hard-failed: ${JSON.stringify(r.errors)}`);
      assert.ok(
        (r.warnings ?? []).some((w) => w.includes(c.match)),
        `expected a warning containing ${JSON.stringify(c.match)}, got: ${JSON.stringify(r.warnings)}`,
      );
    } else {
      assert.equal(r.ok, false, "expected a FLAG but the check passed");
      assert.ok(
        r.errors.some((e) => e.includes(c.match)),
        `expected an error containing ${JSON.stringify(c.match)}, got: ${JSON.stringify(r.errors)}`,
      );
    }
    console.log(`  ok   ${c.name} [${c.expect}] — ${c.why}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${c.name} [${c.expect}] — ${e.message}`);
  }
}

const flagCount = cases.filter((c) => c.expect === "flag").length;
const cleanCount = cases.filter((c) => c.expect === "clean").length;
const warnCount = cases.filter((c) => c.expect === "warn").length;
console.log(
  `\ncoc-manifest-integrity-class-derived: ${cases.length - failed}/${cases.length} cases matched ` +
    `(${flagCount} flag, ${warnCount} warn, ${cleanCount} clean)`,
);
if (failed > 0) {
  console.log(`FAIL — ${failed} case(s) did not match expectation`);
  process.exit(1);
}
// Anti-vacuity floor: a runner that silently enumerated zero cases would print
// the same "all matched" line as a real pass. The WARN polarity is included
// because the un-adopted state is the one disposition that is neither a hard
// fail nor a clean pass, and dropping its cases would hide the loom#1393 core.
if (flagCount === 0 || cleanCount === 0 || warnCount === 0) {
  console.log("FAIL — the fixture set must carry ALL THREE polarities (Rule 9)");
  process.exit(1);
}
console.log("PASS");
