/*
 * THE FIXTURE-CORPUS PATH AUTHORITY.
 *
 * This module is the single exported authority for TWO path conventions that
 * together define loom's disclosure FIXTURE CORPUS — the files whose SYNTHETIC
 * operator homes must survive a scrub so the detectors they drive still FIRE in
 * a repo made from a seed:
 *
 *   1. the DIRECTORY convention — a root-relative `audit-fixtures/` path SEGMENT,
 *      holding a `run.mjs`/`run.cjs` runner plus its sibling candidate payloads;
 *   2. the BASENAME convention — loom's `node:test` suites, `*.test.mjs` and
 *      (at most surfaces) `*.test.js`.
 *
 * WHY IT EXISTS. Before this module the two conventions were restated inline at
 * four surfaces, and `scan-synced-disclosure.mjs`'s own comment recorded the gap
 * verbatim: "no exported authority owns this root path." The nearest candidates
 * each declined the job — `lib/audit-fixture-runners.mjs` owns the runner
 * BASENAME and takes the fixtures ROOT as a parameter, while
 * `run-audit-fixtures.mjs`'s `DEFAULT_FIXTURES_DIR` and `census-build.mjs`'s
 * `isNonRuntime` are module-private to a CLI. Four inline copies of a
 * security-relevant predicate is the drift shape `rules/security.md`
 * § Enforcement-Surface Parity names.
 *
 * CONSUMERS (a call-site enumeration; `rules/zero-tolerance.md` Rule 3e):
 *   - `.claude/bin/scan-synced-disclosure.mjs`'s `scanLines` — which binds BOTH the composed
 *     predicate (`const fixtureCorpusFile = isFixtureCorpusFile(rel)`) and the directory half
 *     alone (`const detectorFixtureFile = isAuditFixtureFile(rel)`). ANCHORED TO THE SYMBOL: this
 *     line cited `:1920-1922`, which is prose in a comment on this tree, and it also said
 *     `scanFile` — the bindings are in `scanLines`.
 *   - `.claude/bin/clean-instantiate.mjs:778-778` — inside `neutralizeWholeTree`, the
 *     ONLY consumer passing `{ includeDotJs: false }` (see the next paragraph).
 *   - `.claude/bin/edition-emit.mjs:578-578` — inside `buildClientTemplateTree`.
 *   - `scripts/publish-to-public.mjs:452-452` — inside `runIdentityTokenGate`.
 *
 * `includeDotJs` IS A DELIBERATE ASYMMETRY, NOT AN OVERSIGHT. Three of the four
 * consumers accept `*.test.mjs` AND `*.test.js`; `clean-instantiate.mjs` accepts
 * `*.test.mjs` ONLY, and that narrowness is preserved EXACTLY here rather than
 * collapsed. Collapsing it would WIDEN which files take the PRESERVING scrub,
 * which is a preservation widening and therefore a security regression — the one
 * direction a shared-authority refactor must never take silently. Whether the
 * narrowness is itself a defect is a question for the surface that owns it; this
 * module's job is to make the divergence VISIBLE at the call site instead of
 * hiding it in a fourth copy of a regex.
 *
 * WHAT THIS MODULE IS *NOT* THE AUTHORITY FOR — the SAFETY HALF. These predicates
 * decide WHICH FILES a tolerance may apply to. They never decide WHICH USERNAMES
 * are preserved: that is the `SYNTHETIC_FIXTURE_USERS` membership test in
 * `lib/identity-scrub.mjs`, which stays at every call site, as does
 * `runIdentityTokenGate`'s own `allowSyntheticFixtureHomes` flag. A REAL operator
 * home inside `audit-fixtures/` is still a hit at every surface.
 *
 * NOT FOLDED IN: `census-build.mjs::isNonRuntime` is a SUPERSET of this predicate
 * (it adds a `test-harness/` segment) answering a DIFFERENT question — runtime vs
 * non-runtime for census input selection, not fixture-corpus membership for a
 * disclosure scrub. Folding it either way changes behaviour: adding
 * `test-harness/` here would widen preservation at four security surfaces;
 * dropping it there would make census treat the harness as runtime.
 */

import path from "node:path";

/**
 * The `audit-fixtures/` DIRECTORY segment. Segment-anchored rather than a
 * substring test so a file merely NAMED `…my-audit-fixtures-notes.md` is NOT
 * corpus, and root-relative (`^|/`) so it also covers
 * `variants/<lang>/audit-fixtures/**` and any other nesting depth.
 */
const AUDIT_FIXTURES_SEGMENT = /(^|\/)audit-fixtures\//;

/** `*.test.mjs` and `*.test.js` — the wide basename convention. */
const TEST_SUITE_MJS_OR_JS = /\.test\.(mjs|js)$/;

/** `*.test.mjs` only — the narrow basename convention (`clean-instantiate.mjs`). */
const TEST_SUITE_MJS_ONLY = /\.test\.mjs$/;

/**
 * Normalize a repo/tree-relative path to POSIX separators. Callers previously did
 * this inline (`rel.split(path.sep).join("/")`); it lives here so every surface
 * normalizes identically. A no-op on POSIX, load-bearing on win32.
 *
 * @param {string} rel
 * @returns {string}
 */
export function toPosixRel(rel) {
  return String(rel).split(path.sep).join("/");
}

/**
 * The DIRECTORY half ALONE. `scan-synced-disclosure.mjs::scanFile` needs it
 * separately for its `detectorFixtureFile` decision, which must NOT pick up the
 * test-suite basename convention — exported so that surface does not have to
 * restate the regex.
 *
 * @param {string} rel  repo/tree-relative path, POSIX or native separators.
 * @returns {boolean}
 */
export function isAuditFixtureFile(rel) {
  return AUDIT_FIXTURES_SEGMENT.test(toPosixRel(rel));
}

/**
 * The BASENAME half alone.
 *
 * The pattern is END-ANCHORED and contains no `/`, so testing it against a full
 * POSIX relative path and against that path's basename is EQUIVALENT: if the path
 * ends `.test.mjs`, so does everything after its last `/`, and conversely. The
 * `rel`-vs-`basename` split among the four historical call sites was therefore
 * cosmetic, never behavioural. (Verified exhaustively over every 3-segment path
 * built from a probe alphabet containing both matching and near-miss segments —
 * see `.claude/bin/fixture-corpus.test.mjs`.)
 *
 * @param {string} rel  repo/tree-relative path OR a bare basename.
 * @param {{ includeDotJs?: boolean }} [opts]  `false` narrows to `*.test.mjs`.
 * @returns {boolean}
 */
export function isTestSuiteFile(rel, { includeDotJs = true } = {}) {
  const p = toPosixRel(rel);
  return includeDotJs ? TEST_SUITE_MJS_OR_JS.test(p) : TEST_SUITE_MJS_ONLY.test(p);
}

/**
 * THE COMPOSED PREDICATE: is this file part of the disclosure fixture corpus?
 *
 * @param {string} rel  repo/tree-relative path, POSIX or native separators.
 * @param {{ includeDotJs?: boolean }} [opts]  `false` narrows the BASENAME half to
 *   `*.test.mjs` (the `clean-instantiate.mjs` behaviour preserved verbatim). The
 *   DIRECTORY half is unaffected by this option.
 * @returns {boolean}
 */
export function isFixtureCorpusFile(rel, opts = {}) {
  return isAuditFixtureFile(rel) || isTestSuiteFile(rel, opts);
}
