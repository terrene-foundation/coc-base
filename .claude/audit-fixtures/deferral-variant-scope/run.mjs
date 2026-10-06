#!/usr/bin/env node
// Audit fixture runner for the RULE-CORPUS SCOPE of the Phase-2 deferral gate
// in `.claude/bin/phase2-deferral-integrity.mjs`.
//
// THE DEFECT THESE FIXTURES PIN — two sides, and they are not the same bug.
//
//   CORPUS SIDE (silent). Pass 2 ("corpus -> registry") enumerated ONE
//   directory: `readdirSync(rulesDir)`, non-recursive, canon only. A rule under
//   `.claude/variants/<v>/rules/` carrying a `Phase 2 (deferred ...)` clause
//   inside a Trust Posture Wiring block was never read, so the
//   unregistered-deferral error could not fire for it AT ALL. Not "fired and
//   was dismissed" — never reached. Measured on the live corpus: two such
//   clauses exist today (`.claude/variants/rs/rules/build-speed.md`,
//   `.claude/variants/rs/rules/canon-incorporation.md`) and the gate is green
//   on both. Silence from an instrument that never looked is not a clean
//   result (`instrument-discipline.md` MUST-3(a)).
//
//   REGISTRY SIDE (loud, but a dead end). Two `startsWith(".claude/rules/")`
//   guards refused any declaration whose `rule` pointed at a variant path. So
//   the corpus side could not SEE a variant deferral and the registry side
//   would not LET you declare one either: both exits closed, which is why the
//   gap could not be worked around by an operator who noticed it.
//
// WHAT IS UNDER TEST
//
//   ruleCorpusRoots(repoRoot, rulesDir) -> [{dir, label}, ...]
//       canon root FIRST, then every EXISTING `.claude/variants/<v>/rules`
//       directory, sorted. A variant with no `rules/` subdir contributes
//       nothing; a repo with no `variants/` dir yields canon alone.
//   isRuleCorpusPath(relPath) -> boolean
//       true for `.claude/rules/<f>.md` and `.claude/variants/<v>/rules/<f>.md`,
//       false otherwise. This is the registry side's admission predicate, and
//       it must agree with what `ruleCorpusRoots` actually enumerates — a path
//       admitted here but never enumerated there re-opens the blind spot from
//       the other direction.
//   expectedRuleForKey(key) -> string
//       the THIRD fence. A registry key is `<rule-file>.md#<clause-slug>`,
//       optionally prefixed `variants/<v>/`. Without that prefix a variant
//       row's key is BYTE-IDENTICAL to its canon sibling's and the two collide
//       in a flat object, so widening the path predicate alone would produce a
//       registry that accepts a variant `rule` but cannot NAME it distinctly —
//       a half-fix that reads as a whole one. Fixtures below pin the coherence
//       check in both directions, because a fence that only ever refuses is
//       indistinguishable from one that refuses everything.
//   checkPhase2Deferrals({...}) end to end, on synthetic repos.
//
// BIPOLAR BY CONSTRUCTION (`cc-artifacts.md` Rule 9). Each side gets a pole
// that must FIRE and a pole that must stay SILENT, and the two poles differ in
// exactly ONE property. A pole pair that differs in three ways isolates
// nothing.
//
// EVERY "SILENT" ASSERTION CARRIES ITS OWN POSITIVE CONTROL. A check that
// asserts an error is ABSENT passes identically when the whole instrument is
// dead, so every such case runs a canon-side rule through the SAME repo, the
// SAME checker call and the SAME error list, and asserts that one DOES fire.
// If the control ever goes quiet the silence is the instrument, not the
// subject, and the case says so by name.
//
// The clock is INJECTED (`NOW`), never read, so these fixtures assert the
// predicate rather than today's date. Every repo is built fresh under
// `mkdtempSync` and torn down; nothing here reads the live registry or the
// live rules corpus, so editing either changes the live gate and never
// silently rewrites what these fixtures assert.
//
// Exits 0 when ALL fixtures pass, non-zero otherwise.
//   node .claude/audit-fixtures/deferral-variant-scope/run.mjs

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

import * as gate from "../../bin/phase2-deferral-integrity.mjs";
import { grandfatherDigest } from "../../bin/lib/deferral-acceptance.mjs";

// Frozen clock. Fixtures assert the PREDICATE, not today's date.
const NOW = new Date("2026-08-06T12:00:00Z");

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, reason) {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    failures.push({ name, reason });
    console.log(`FAIL  ${name}: ${reason}`);
  }
}

/**
 * Run one block of cases so that a THROW inside it cannot abort the suite.
 *
 * NOT a swallow — the throw is recorded as an explicit, named FAIL and the
 * process still exits non-zero. It exists because a mutation that removes a
 * guard (measured: dropping `ruleCorpusRoots`' `rules/`-exists check makes the
 * checker `readdirSync` a directory that is not there) throws out of the gate
 * and killed every case AFTER it, so the red-set read as one line instead of
 * the eleven cases the mutation actually broke. A suite that stops counting on
 * the first throw UNDER-reports, and then trips its own `min_cases` floor for a
 * reason that has nothing to do with the drop the floor exists to catch.
 */
function group(fn) {
  try {
    fn();
  } catch (e) {
    check("block/ABORTED-BY-THROW", false, `a case block threw, so its remaining cases never ran: ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
  }
}

/** Path separators normalized so assertions read the same on every platform. */
const norm = (s) => String(s).split(sep).join("/");

// ─── Rule bodies ───────────────────────────────────────────────────────────
//
// ONE body, parameterized by the fixture directory it names. Every pole in
// this file uses it, so a pole pair can never differ by rule CONTENT — only by
// where the file was placed or how it was declared.

const ruleBody = (slug) => `# ${slug}

## MUST: Do the thing this rule is about

Body text that is not a deferral and must never be read as one.

## Trust Posture Wiring

- **Severity:** \`halt-and-report\` at gate-review.
- **Grace period:** 7 days from rule landing (2026-08-01 → 2026-08-08).
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer inspects the diff. Phase 2 (deferred per \`trust-posture.md\` § Two-Phase Rollout) — no hook detector; audit fixtures land with the Phase-2 detector at \`.claude/audit-fixtures/${slug}/\` per \`cc-artifacts.md\` Rule 9.
- **Violation scope:** this clause ONLY.
- **Origin:** See § Origin.
`;

/** The verbatim span a registry entry binds to. Unique inside its own file. */
const quoteFor = (slug) =>
  `Phase 2 (deferred per \`trust-posture.md\` § Two-Phase Rollout) — no hook detector; audit fixtures land with the Phase-2 detector at \`.claude/audit-fixtures/${slug}/\``;

/** A well-formed declaration for `slug`'s clause, pointed at `rulePath`. */
const entryFor = (slug, rulePath) => ({
  rule: rulePath,
  quote: quoteFor(slug),
  detector: `none built; planned advisory detector with fixtures at .claude/audit-fixtures/${slug}/`,
  risk: "process",
  reason: "Phase-1 coverage is a manual reviewer sweep at the gate, which fires only when a reviewer happens to run it.",
  graduation: `Delete this entry when the ${slug} detector and its audit fixtures land together in one change.`,
  expires: "2027-03-01",
  accepted_by: "repo-owner",
});

// The ROOT deferral every per-rule Wiring block chains to. Each temp repo
// carries it so the missing-root arm never fires as incidental noise in a case
// aimed at corpus scope — the same treatment, for the same reason, that
// `phase2-deferral-integrity.test.mjs::mkRepo` gives it.
const ROLLOUT_RULE = `# Trust Posture

## Two-Phase Rollout

Phase 1 (current): observer-mode detection live.
Phase 2 (after N real sessions exercise the system): enforcement on.
`;

const ROLLOUT_ENTRY = {
  rule: ".claude/rules/rollout.md",
  quote: "Phase 2 (after N real sessions exercise the system): enforcement on.",
  detector: "the global rollout itself: /codify wiring enforcement plus posture-gate teeth",
  risk: "trust",
  reason: "The root deferral every per-rule Wiring block chains to; its condition is not measured anywhere.",
  graduation: "Delete this declaration when Phase 2 actually ships, or restate the condition as something a program can read.",
  expires: "2026-12-04",
  accepted_by: "repo-owner",
};

// ─── Synthetic repo ────────────────────────────────────────────────────────

/**
 * Materialize an isolated temp repo.
 *
 * @param {object} opts
 * @param {Record<string,object>} [opts.deferrals]  registry `deferrals` map
 * @param {Record<string,string>}  [opts.rules]     basename -> body, under `.claude/rules/`
 * @param {Record<string,string>}  [opts.variantRules]
 *        "<variant>/<basename>" -> body, under `.claude/variants/<variant>/rules/`
 * @param {Record<string,string>}  [opts.files]     repo-relative path -> body, verbatim
 * @param {string[]}               [opts.emptyDirs] repo-relative dirs created with no files
 */
function mkRepo({ deferrals = {}, rules = {}, variantRules = {}, files = {}, emptyDirs = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "loom-p2-varscope-"));

  const rulesDir = join(root, ".claude", "rules");
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(join(rulesDir, "rollout.md"), ROLLOUT_RULE, "utf8");
  for (const [name, body] of Object.entries(rules)) {
    writeFileSync(join(rulesDir, name), body, "utf8");
  }

  for (const [key, body] of Object.entries(variantRules)) {
    const [variant, name] = key.split("/");
    const dir = join(root, ".claude", "variants", variant, "rules");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), body, "utf8");
  }

  for (const [relPath, body] of Object.entries(files)) {
    const abs = join(root, ...relPath.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }

  for (const d of emptyDirs) mkdirSync(join(root, ...d.split("/")), { recursive: true });

  // Grandfather exactly this repo's own keys, so the acceptance gate — which is
  // about the COMMITTED registry's exemption list — stays quiet for fixtures
  // aimed at corpus scope. This IS derived from the subject, and it is sound
  // only because acceptance is not what these fixtures test; the same
  // reasoning, and the same construction, as the checker's own test suite.
  const keys = ["rollout", ...Object.keys(deferrals)].sort();
  const registry = {
    rollout: ROLLOUT_ENTRY,
    deferrals,
    acceptance_gate: { effective_from: "2026-08-14", grandfathered_count: keys.length, grandfathered: keys },
  };
  const gfDigest = grandfatherDigest(keys);

  const registryPath = join(root, ".claude", "test-harness", "phase2-deferrals.json");
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf8");

  return { root, registryPath, rulesDir, gfDigest };
}

/** Build the repo, run the checker against it, tear it down, return the result. */
function run(opts) {
  const { root, registryPath, rulesDir, gfDigest } = mkRepo(opts);
  try {
    const res = gate.checkPhase2Deferrals({
      registryPath,
      rulesDir,
      repoRoot: root,
      now: NOW,
      expectedGrandfatherDigest: gfDigest,
    });
    return { ...res, errorText: res.errors.map(norm).join("\n"), warningText: res.warnings.map(norm).join("\n") };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const CANON_PATH = ".claude/rules/canon-sample.md";
const VARIANT_RS_PATH = ".claude/variants/rs/rules/variant-sample.md";
const VARIANT_PY_PATH = ".claude/variants/py/rules/variant-py-sample.md";

// Keys carry the lane segment for a variant row. `expectedRuleForKey` derives
// the `rule` path FROM the key, so these three strings and the three paths
// above are one fact stated twice — which is what the coherence fence checks.
const CANON_KEY = "canon-sample.md#detector";
const VARIANT_RS_KEY = "variants/rs/variant-sample.md#detector";
const VARIANT_PY_KEY = "variants/py/variant-py-sample.md#detector";

/** The unregistered-deferral error, scoped to one rule path. */
const unregisteredRx = (path) => new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\d+ — a Phase-2 clause inside a Trust Posture Wiring section`);

/** The registry-side path-shape refusal, scoped to one declared path. */
const pathShapeRx = (path) => new RegExp(`must be a repo-relative rule path[^\\n]*${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

/** Any registry-side path-shape refusal, whatever path it names. */
const ANY_PATH_SHAPE_RX = /must be a repo-relative rule path/;

// ═══════════════════════════════════════════════════════════════════════════
// SIDE 1 — CORPUS. Does pass 2 read variant rules at all?
// ═══════════════════════════════════════════════════════════════════════════
//
// Both poles build the IDENTICAL repo: one canon rule and one variant rule,
// byte-identical in body apart from the fixture slug they name, both carrying
// a real Phase-2 deferral inside a real Wiring block. The canon rule is
// UNREGISTERED in BOTH poles and is the positive control. The single property
// that moves between the poles is whether the VARIANT clause is registered.

const CORPUS_RULES = { "canon-sample.md": ruleBody("canon-sample") };
const CORPUS_VARIANT_RULES = { "rs/variant-sample.md": ruleBody("variant-sample") };

group(() => {
  // (a) FIRES — a variant deferral with no registry entry must be REPORTED.
  //
  // If the proposition were FALSE (pass 2 still canon-only), this prints:
  //   "expected the variant clause to be reported as unregistered, got: <a list
  //    that mentions .claude/rules/canon-sample.md and never mentions
  //    .claude/variants/rs/rules/variant-sample.md>"
  // — which is exactly the pre-fix state, and is why the control below sits in
  // the same repo: it proves the enumerator, the slicer and the temp repo all
  // work, leaving the variant path as the only thing that can differ.
  const res = run({ rules: CORPUS_RULES, variantRules: CORPUS_VARIANT_RULES, deferrals: {} });

  check(
    "corpus/control-canon-unregistered-deferral-FIRES",
    unregisteredRx(CANON_PATH).test(res.errorText),
    `the positive control did not fire — the instrument is dead, so nothing below it is readable. errors: ${res.errorText || "(none)"}`,
  );
  check(
    "corpus/fires-variant-unregistered-deferral-is-reported",
    unregisteredRx(VARIANT_RS_PATH).test(res.errorText),
    `expected the variant clause to be reported as unregistered, got: ${res.errorText || "(no errors at all)"}`,
  );
  check(
    "corpus/fires-verdict-is-not-ok",
    res.ok === false,
    "a repo carrying two unregistered Phase-2 deferrals must not be green",
  );
  check(
    "corpus/fires-variant-is-an-error-not-a-warning",
    !unregisteredRx(VARIANT_RS_PATH).test(res.warningText),
    `a variant deferral inside a Wiring block is fail-closed, not the out-of-band warning tier. warnings: ${res.warningText || "(none)"}`,
  );
});

group(() => {
  // (b) SILENT — the SAME variant rule, now declared. One property moved.
  //
  // If the proposition were FALSE this prints one of two things: pre-fix, the
  // registry-side refusal ("must be a repo-relative path under .claude/rules/")
  // naming the variant path; or, if the corpus widened but the registry did
  // not, the unregistered-deferral error still standing despite a declaration.
  // Either way the case names which.
  const res = run({
    rules: CORPUS_RULES,
    variantRules: CORPUS_VARIANT_RULES,
    deferrals: { [VARIANT_RS_KEY]: entryFor("variant-sample", VARIANT_RS_PATH) },
  });

  check(
    "corpus/control-canon-still-FIRES-while-variant-is-silent",
    unregisteredRx(CANON_PATH).test(res.errorText),
    `the positive control went quiet, so the silence asserted below is the instrument and not the subject. errors: ${res.errorText || "(none)"}`,
  );
  check(
    "corpus/silent-registered-variant-raises-no-unregistered-error",
    !unregisteredRx(VARIANT_RS_PATH).test(res.errorText),
    `a declared variant deferral must not be reported as unregistered. errors: ${res.errorText || "(none)"}`,
  );
  check(
    "corpus/silent-registered-variant-raises-no-path-shape-error",
    !pathShapeRx(VARIANT_RS_PATH).test(res.errorText),
    `the registry must ACCEPT a variant rule path. errors: ${res.errorText || "(none)"}`,
  );
  check(
    "corpus/silent-registered-variant-is-counted-in-the-backlog",
    res.notes.some((n) => n.includes(VARIANT_RS_KEY)),
    `a declared deferral must be SURFACED as a note, never pass invisibly. notes: ${res.notes.join(" | ") || "(none)"}`,
  );
});

group(() => {
  // The quote-binding contract must hold ACROSS the boundary, not just the
  // path check. A variant path that is admitted but whose quote is never
  // looked up would accept any declaration at all.
  const bad = entryFor("variant-sample", VARIANT_RS_PATH);
  bad.quote = "Phase 2 (deferred) — a sentence that appears in no file in this repo.";
  const res = run({
    rules: CORPUS_RULES,
    variantRules: CORPUS_VARIANT_RULES,
    deferrals: { [VARIANT_RS_KEY]: bad },
  });
  check(
    "corpus/fires-variant-entry-with-a-non-matching-quote-is-STALE",
    /is STALE — its verbatim `quote` no longer appears in/.test(res.errorText),
    `a variant declaration must be quote-bound like a canon one, or it guards nothing. errors: ${res.errorText || "(none)"}`,
  );
});

group(() => {
  // Bipolar companion to the case above: the SAME repo, the SAME entry, with
  // the real quote restored. Without this pole, a quote check that rejected
  // every variant declaration would pass the case above and look correct.
  const res = run({
    rules: CORPUS_RULES,
    variantRules: CORPUS_VARIANT_RULES,
    deferrals: { [VARIANT_RS_KEY]: entryFor("variant-sample", VARIANT_RS_PATH) },
  });
  check(
    "corpus/silent-variant-entry-with-the-real-quote-binds",
    !/is STALE/.test(res.errorText),
    `the real quote must bind inside the variant rule's Wiring block. errors: ${res.errorText || "(none)"}`,
  );
});

group(() => {
  // A variant rule with NO deferral must produce NO finding. Otherwise
  // widening the corpus would trade a false negative for a false positive and
  // the gate would red on the whole variant tree.
  const clean = `# Clean Variant Rule

## MUST: Do the thing

Body with no wiring block and no deferral language at all.
`;
  const res = run({ variantRules: { "rs/clean.md": clean } });
  check(
    "corpus/silent-variant-rule-without-a-deferral-produces-no-error",
    res.ok === true && res.errors.length === 0,
    `a variant rule carrying no deferral must be green. errors: ${res.errorText || "(none)"}`,
  );
  check(
    // Scoped to the SUBJECT rather than to `warnings.length`. Every temp repo
    // legitimately carries the acceptance gate's grandfathered-declarations
    // warning for its own rollout row, so a length-zero assertion would red on
    // unrelated machinery and say nothing about variant enumeration.
    "corpus/silent-variant-rule-without-a-deferral-produces-no-warning",
    !/variants\/rs\/rules\/clean\.md/.test(res.warningText),
    `nor an out-of-band warning naming the variant rule. warnings: ${res.warningText || "(none)"}`,
  );
});

group(() => {
  // Every variant DIRECTORY must be reached, not just the first one. A loop
  // that enumerated `variants/<first>/rules` and stopped would pass every case
  // above, because every case above uses `rs` alone.
  const res = run({
    variantRules: {
      "rs/variant-sample.md": ruleBody("variant-sample"),
      "py/variant-py-sample.md": ruleBody("variant-py-sample"),
      "py-codex/variant-hyphen-sample.md": ruleBody("variant-hyphen-sample"),
    },
    deferrals: {},
  });
  check(
    "corpus/fires-second-variant-directory-is-also-enumerated",
    unregisteredRx(VARIANT_PY_PATH).test(res.errorText),
    `the py variant tree was not reached. errors: ${res.errorText || "(none)"}`,
  );
  check(
    "corpus/fires-hyphenated-variant-directory-is-also-enumerated",
    unregisteredRx(".claude/variants/py-codex/rules/variant-hyphen-sample.md").test(res.errorText),
    `a hyphenated variant name (py-codex, rs-gemini) was not reached. errors: ${res.errorText || "(none)"}`,
  );
  check(
    "corpus/fires-all-three-variant-trees-reported-together",
    unregisteredRx(VARIANT_RS_PATH).test(res.errorText),
    `the rs variant tree was not reached in a multi-variant repo. errors: ${res.errorText || "(none)"}`,
  );
});

group(() => {
  // The enumeration must stay NON-RECURSIVE below a rules root, matching
  // canon's own contract. `.claude/rules/local/` is the reserved
  // deployment-local subtree (`rules/local/_README.md`), and canon has always
  // skipped it: `readdirSync` non-recursive never descends. A widening that
  // made the walk recursive would start enumerating it, which is a DIFFERENT
  // scope change wearing this one's clothes.
  const res = run({
    files: { ".claude/rules/local/local-sample.md": ruleBody("local-sample") },
  });
  check(
    "corpus/silent-nested-local-subtree-is-not-enumerated",
    !unregisteredRx(".claude/rules/local/local-sample.md").test(res.errorText),
    `the reserved local subtree must stay outside the enumerated corpus. errors: ${res.errorText || "(none)"}`,
  );
});

group(() => {
  // Positive control for the case directly above: the SAME body at the SAME
  // depth under a real corpus root DOES fire. Without it, "not enumerated"
  // would be indistinguishable from "this body never fires anywhere".
  const res = run({ rules: { "canon-sample.md": ruleBody("canon-sample") } });
  check(
    "corpus/control-same-body-at-corpus-depth-FIRES",
    unregisteredRx(CANON_PATH).test(res.errorText),
    `the body used by the nested-subtree case must fire at corpus depth, or that case proves nothing. errors: ${res.errorText || "(none)"}`,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// SIDE 2 — REGISTRY. Which declared `rule` paths are admitted?
// ═══════════════════════════════════════════════════════════════════════════
//
// Both poles declare the SAME clause with the SAME eight fields and the SAME
// quote, against a rule file with byte-identical content. The single property
// that moves is WHERE that file lives, and therefore what the declaration's
// `rule` field says.

group(() => {
  // (c) FIRES — a path under neither accepted shape is refused.
  //
  // The file EXISTS and its quote binds, so a refusal here cannot be the
  // missing-file or stale-quote arm wearing a different message: the ONLY
  // thing wrong is the path shape. If the proposition were FALSE this prints
  // "expected a path-shape refusal, got: (none)".
  const res = run({
    files: { ".claude/agents/foo-agent.md": ruleBody("foo-agent") },
    deferrals: { "foo-agent.md#detector": entryFor("foo-agent", ".claude/agents/foo-agent.md") },
  });

  check(
    "registry/fires-agents-path-is-refused",
    pathShapeRx(".claude/agents/foo-agent.md").test(res.errorText),
    `expected a path-shape refusal for an off-corpus path, got: ${res.errorText || "(none)"}`,
  );
  check(
    "registry/fires-refusal-names-the-canon-shape",
    /must be a repo-relative rule path[^\n]*\.claude\/rules\/<file>\.md/.test(res.errorText),
    `the refusal must name .claude/rules/ as an accepted shape. errors: ${res.errorText || "(none)"}`,
  );
  check(
    // The half that reds pre-fix: the old message named ONE shape, so an
    // operator reading it would conclude a variant deferral is unregisterable.
    "registry/fires-refusal-names-the-variant-shape-too",
    /must be a repo-relative rule path[^\n]*\.claude\/variants\/<variant>\/rules\/<file>\.md/.test(res.errorText),
    `the refusal must name .claude/variants/<v>/rules/ as an accepted shape too, or it tells the operator the variant lane is closed. errors: ${res.errorText || "(none)"}`,
  );
  check(
    "registry/fires-off-corpus-path-is-not-a-stale-file-finding",
    !/is not on disk/.test(res.errorText),
    `the file exists; a missing-file message here would mean the refusal is the wrong arm. errors: ${res.errorText || "(none)"}`,
  );
});

group(() => {
  // (d) SILENT — a legitimate variant path under a DIFFERENT variant than the
  // corpus cases used, so admission is not accidentally pinned to `rs`.
  const res = run({
    variantRules: { "py/variant-py-sample.md": ruleBody("variant-py-sample") },
    deferrals: { [VARIANT_PY_KEY]: entryFor("variant-py-sample", VARIANT_PY_PATH) },
  });

  check(
    "registry/silent-variant-py-path-is-accepted",
    !/must be a repo-relative path under/.test(res.errorText),
    `a .claude/variants/py/rules/ path must be admitted. errors: ${res.errorText || "(none)"}`,
  );
  check(
    "registry/silent-variant-py-declaration-is-fully-green",
    res.ok === true && res.errors.length === 0,
    `a well-formed variant declaration bound to a real in-Wiring clause must be green. errors: ${res.errorText || "(none)"}`,
  );
  check(
    "registry/silent-variant-py-declaration-is-counted",
    res.notes.some((n) => n.includes(VARIANT_PY_KEY)),
    `notes: ${res.notes.join(" | ") || "(none)"}`,
  );
});

group(() => {
  // Canon control on the registry side. Same entry shape, canon path. Proves
  // the admission predicate is not simply accepting everything — a predicate
  // that returned true unconditionally would pass (d) and fail nothing.
  const res = run({
    rules: { "canon-sample.md": ruleBody("canon-sample") },
    deferrals: { [CANON_KEY]: entryFor("canon-sample", CANON_PATH) },
  });
  check(
    "registry/control-canon-path-is-accepted-and-green",
    res.ok === true && res.errors.length === 0,
    `the canon lane must be untouched by the widening. errors: ${res.errorText || "(none)"}`,
  );
});

// Near-miss shapes. Each is ONE segment away from an accepted path, which is
// where a `startsWith`-shaped widening quietly goes wrong.
for (const [name, path, body] of [
  ["docs-tree", "docs/whatever.md", ruleBody("whatever")],
  ["variants-but-not-rules", ".claude/variants/rs/skills/skill-sample.md", ruleBody("skill-sample")],
  ["variants-missing-the-variant-segment", ".claude/variants/rules/no-variant.md", ruleBody("no-variant")],
  ["nested-under-canon-rules", ".claude/rules/local/local-sample.md", ruleBody("local-sample")],
]) {
  group(() => {
    const slug = path.split("/").pop().replace(/\.md$/, "");
    const res = run({
      files: { [path]: body },
      deferrals: { [`${slug}.md#detector`]: entryFor(slug, path) },
    });
    check(
      `registry/fires-near-miss-${name}-is-refused`,
      pathShapeRx(path).test(res.errorText),
      `'${path}' is not an enumerated corpus path, so admitting it would let a declaration point at a file pass 2 never reads — a registered deferral nothing can ever reconcile. errors: ${res.errorText || "(none)"}`,
    );
    check(
      `registry/fires-near-miss-${name}-verdict-is-not-ok`,
      res.ok === false,
      `a registry naming an unreachable path must not be green. errors: ${res.errorText || "(none)"}`,
    );
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SIDE 3 — KEY GRAMMAR. Can a variant row be NAMED distinctly?
// ═══════════════════════════════════════════════════════════════════════════
//
// The third fence, and the one that keeps the first two from adding up to a
// half-fix. A key with no `variants/<v>/` segment is byte-identical for a
// variant rule and its canon sibling, so the two collide in a flat object and
// one silently overwrites the other. Every pole below declares the SAME clause
// against the SAME file; the property that moves is the KEY.

group(() => {
  // FIRES — a lane-less key naming a variant `rule`. The path is admitted, the
  // file exists, the quote binds: the ONLY defect is that the key does not say
  // which lane it belongs to. If the proposition were FALSE this prints
  // "expected the key/rule disagreement to be reported, got: (none)" — and a
  // registry that accepts this row is one where the rs and canon `security.md`
  // deferrals cannot coexist.
  const res = run({
    variantRules: { "rs/variant-sample.md": ruleBody("variant-sample") },
    deferrals: { "variant-sample.md#detector": entryFor("variant-sample", VARIANT_RS_PATH) },
  });
  check(
    "keygrammar/fires-laneless-key-on-a-variant-rule-disagrees",
    /key and \.rule disagree/.test(res.errorText),
    `expected the key/rule disagreement to be reported, got: ${res.errorText || "(none)"}`,
  );
  check(
    "keygrammar/fires-disagreement-names-the-key-it-expected",
    /the key names "\.claude\/rules\/variant-sample\.md"/.test(res.errorText),
    `the refusal must show the path the key IMPLIES, or the reader cannot tell which half to change. errors: ${res.errorText || "(none)"}`,
  );
});

group(() => {
  // SILENT — the SAME repo, the SAME entry, the key now lane-qualified.
  // Exactly one property moved from the pole above.
  const res = run({
    variantRules: { "rs/variant-sample.md": ruleBody("variant-sample") },
    deferrals: { [VARIANT_RS_KEY]: entryFor("variant-sample", VARIANT_RS_PATH) },
  });
  check(
    "keygrammar/silent-lane-qualified-key-agrees",
    !/key and \.rule disagree/.test(res.errorText),
    `a lane-qualified key must be accepted. errors: ${res.errorText || "(none)"}`,
  );
  check(
    "keygrammar/silent-lane-qualified-key-is-not-a-malformed-key",
    !/key must have the form/.test(res.errorText),
    `the key grammar must ADMIT the variants/<v>/ prefix, not merely tolerate the path. errors: ${res.errorText || "(none)"}`,
  );
  check(
    "keygrammar/silent-lane-qualified-declaration-is-fully-green",
    res.ok === true && res.errors.length === 0,
    `errors: ${res.errorText || "(none)"}`,
  );
});

group(() => {
  // FIRES — the mirror defect: a lane-qualified key on a CANON rule. Catching
  // only the missing-prefix direction would leave a canon row able to
  // masquerade as a variant one, which is the same collision from the other
  // end.
  const res = run({
    rules: { "canon-sample.md": ruleBody("canon-sample") },
    deferrals: { "variants/rs/canon-sample.md#detector": entryFor("canon-sample", CANON_PATH) },
  });
  check(
    "keygrammar/fires-lane-qualified-key-on-a-canon-rule-disagrees",
    /key and \.rule disagree/.test(res.errorText),
    `a canon row must not wear a lane segment. errors: ${res.errorText || "(none)"}`,
  );
});

group(() => {
  // FIRES — a lane-qualified key whose lane does not match the rule's lane.
  // `rs` and `py` are both real lanes and both admissible paths, so nothing
  // about this row is malformed in isolation; only the PAIRING is wrong.
  const res = run({
    variantRules: { "rs/variant-sample.md": ruleBody("variant-sample") },
    deferrals: { "variants/py/variant-sample.md#detector": entryFor("variant-sample", VARIANT_RS_PATH) },
  });
  check(
    "keygrammar/fires-key-lane-and-rule-lane-must-match",
    /key and \.rule disagree/.test(res.errorText),
    `a py-keyed row pointing at an rs rule must be refused. errors: ${res.errorText || "(none)"}`,
  );
});

group(() => {
  // SILENT — the canon lane, unchanged by all of the above. A canon key on a
  // canon rule was legal before this widening and must stay legal after it.
  const res = run({
    rules: { "canon-sample.md": ruleBody("canon-sample") },
    deferrals: { [CANON_KEY]: entryFor("canon-sample", CANON_PATH) },
  });
  check(
    "keygrammar/silent-canon-key-on-a-canon-rule-agrees",
    !/key and \.rule disagree/.test(res.errorText),
    `the canon lane must be untouched by the key-grammar widening. errors: ${res.errorText || "(none)"}`,
  );
});

group(() => {
  // THE COLLISION ITSELF, stated as a fixture rather than as prose. A variant
  // rule and its canon sibling share a basename (`security.md` is the live
  // case: `.claude/rules/security.md` and `.claude/variants/rs/rules/security.md`
  // both exist). Both carry a deferral; both are declared. Under the old flat
  // key grammar these two rows could not coexist — one would overwrite the
  // other in the JSON object and the survivor's span would cover only ONE of
  // the two files, leaving the other reported as unregistered. With lane
  // segments both are nameable, so both must be green together.
  const res = run({
    rules: { "security.md": ruleBody("security-canon") },
    variantRules: { "rs/security.md": ruleBody("security-rs") },
    deferrals: {
      "security.md#detector": entryFor("security-canon", ".claude/rules/security.md"),
      "variants/rs/security.md#detector": entryFor("security-rs", ".claude/variants/rs/rules/security.md"),
    },
  });
  check(
    "keygrammar/silent-same-basename-canon-and-variant-rows-coexist",
    res.ok === true && res.errors.length === 0,
    `a variant rule and its canon sibling must both be declarable at once. errors: ${res.errorText || "(none)"}`,
  );
  check(
    "keygrammar/silent-both-same-basename-rows-are-counted",
    res.notes.some((n) => n.includes("variants/rs/security.md#detector")) && res.notes.some((n) => /(^|[^/])security\.md#detector/.test(n)),
    `both rows must appear in the backlog, not one. notes: ${res.notes.join(" | ") || "(none)"}`,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// SIDE 4 — the exported predicates, directly.
// ═══════════════════════════════════════════════════════════════════════════
//
// A namespace import is used deliberately. A named import of a binding the
// module does not export is a link-time SyntaxError: NOTHING in this file
// would run and the case count would collapse to zero, which reads in CI as a
// registry/floor problem rather than as the missing export it is. The
// existence of each export is therefore its own named, LOUD case.

check(
  "api/ruleCorpusRoots-is-exported",
  typeof gate.ruleCorpusRoots === "function",
  `phase2-deferral-integrity.mjs does not export ruleCorpusRoots (got ${typeof gate.ruleCorpusRoots}) — the corpus-side widening has not landed`,
);
check(
  "api/isRuleCorpusPath-is-exported",
  typeof gate.isRuleCorpusPath === "function",
  `phase2-deferral-integrity.mjs does not export isRuleCorpusPath (got ${typeof gate.isRuleCorpusPath}) — the registry-side widening has not landed`,
);
check(
  "api/expectedRuleForKey-is-exported",
  typeof gate.expectedRuleForKey === "function",
  `phase2-deferral-integrity.mjs does not export expectedRuleForKey (got ${typeof gate.expectedRuleForKey}) — the key-grammar fence has not landed`,
);
check(
  "api/DEFERRAL_KEY_RE-is-exported",
  gate.DEFERRAL_KEY_RE instanceof RegExp,
  `phase2-deferral-integrity.mjs does not export DEFERRAL_KEY_RE as a RegExp (got ${typeof gate.DEFERRAL_KEY_RE}) — the shared key grammar has not landed`,
);

// ─── DEFERRAL_KEY_RE, directly ─────────────────────────────────────────────
//
// Pinned as its OWN subject, not only through the end-to-end cases, because it
// stopped being a private constant: it is now EXPORTED and shared with the
// deferral-request / accept path. A grammar two callers read is a contract, and
// a contract nothing pins drifts at whichever caller is edited second. The
// end-to-end cases exercise the shapes this registry happens to use; these
// exercise the shapes a DIFFERENT caller could hand it.

group(() => {
  if (!(gate.DEFERRAL_KEY_RE instanceof RegExp)) {
    check("keyre/SKIPPED-NOT-EXPORTED", false, "DEFERRAL_KEY_RE is not an exported RegExp, so none of its poles could run");
    return;
  }
  const KEY_RE = gate.DEFERRAL_KEY_RE;

  // A shared regex carrying the `g` flag would be a STATEFUL contract: `.test()`
  // advances `lastIndex`, so two callers alternating on the same object get
  // answers that depend on call ORDER rather than on the key. That is a
  // non-discriminating instrument by construction, and it is a hazard that
  // arrives precisely when a private constant becomes a shared one.
  check(
    "keyre/carries-no-g-flag-so-it-is-stateless-across-callers",
    !KEY_RE.global && !KEY_RE.sticky,
    `flags are ${JSON.stringify(KEY_RE.flags)} — a shared key grammar must be stateless, or .test() answers depend on which caller ran first`,
  );
  check(
    "keyre/repeated-tests-of-one-key-agree",
    KEY_RE.test(VARIANT_RS_KEY) === KEY_RE.test(VARIANT_RS_KEY),
    "two identical .test() calls disagreed — the exported regex is carrying state between callers",
  );

  for (const [name, key] of [
    ["canon", "canon-sample.md#detector"],
    ["variant-lane", "variants/rs/variant-sample.md#detector"],
    ["hyphenated-lane", "variants/py-codex/a.md#detector"],
    ["hyphenated-clause-slug", "variants/rs/a.md#must-6-firing"],
    ["dotted-basename", "ci-runners.operator.local.example.md#detector"],
  ]) {
    check(`keyre/accepts-${name}`, KEY_RE.test(key) === true, `expected the shared key grammar to accept ${JSON.stringify(key)}`);
  }

  for (const [name, key] of [
    // The single most likely authoring error: writing the RULE PATH where a key
    // belongs. The rule path carries `/rules/`; the key does not.
    ["key-written-as-a-rule-path", "variants/rs/rules/a.md#detector"],
    ["full-repo-path-as-a-key", ".claude/rules/a.md#detector"],
    ["uppercase-lane", "variants/RS/a.md#detector"],
    ["uppercase-clause-slug", "a.md#Detector"],
    ["empty-lane-segment", "variants//a.md#detector"],
    ["doubled-lane-segment", "variants/rs/variants/py/a.md#detector"],
    ["no-clause-slug", "variants/rs/a.md"],
    ["empty-clause-slug", "a.md#"],
    ["no-file-part", "#detector"],
    ["non-markdown-file", "variants/rs/a.txt#detector"],
    ["lane-prefix-without-variants-literal", "rs/a.md#detector"],
  ]) {
    check(`keyre/refuses-${name}`, KEY_RE.test(key) === false, `expected the shared key grammar to REFUSE ${JSON.stringify(key)}, but it accepted it`);
  }

  // Tie the grammar to the fixtures that depend on it. If a key this file uses
  // stopped matching, the end-to-end cases would red with a confusing
  // "key must have the form" message pointing at the wrong layer; this names it
  // at the grammar instead.
  for (const [name, key] of [["canon", CANON_KEY], ["variant-rs", VARIANT_RS_KEY], ["variant-py", VARIANT_PY_KEY]]) {
    check(`keyre/this-suite-own-key-${name}-is-well-formed`, KEY_RE.test(key) === true, `this file's own ${name} key ${JSON.stringify(key)} does not match the shared grammar`);
  }

  // The two halves of the fence must AGREE: every key the grammar accepts must
  // imply a path the admission predicate accepts. A grammar that admitted a key
  // whose derived path is inadmissible would make the coherence check at
  // :1417 unsatisfiable — no `rule` value could ever agree with such a key.
  if (typeof gate.expectedRuleForKey === "function" && typeof gate.isRuleCorpusPath === "function") {
    const accepted = ["canon-sample.md#detector", "variants/rs/a.md#detector", "variants/py-codex/a.md#must-6-firing", "ci-runners.operator.local.example.md#detector"];
    const unsatisfiable = accepted.filter((k) => !gate.isRuleCorpusPath(gate.expectedRuleForKey(k)));
    check(
      "keyre/every-accepted-key-implies-an-admissible-path",
      unsatisfiable.length === 0,
      `these keys are accepted but imply a path the admission predicate refuses, so the coherence fence could never be satisfied for them: ${unsatisfiable.join(", ")}`,
    );
  }
});

if (typeof gate.expectedRuleForKey === "function") {
  const { expectedRuleForKey } = gate;
  for (const [name, key, expected] of [
    ["canon-key", "canon-sample.md#detector", ".claude/rules/canon-sample.md"],
    ["variant-rs-key", "variants/rs/variant-sample.md#detector", ".claude/variants/rs/rules/variant-sample.md"],
    ["hyphenated-variant-key", "variants/py-codex/a.md#detector", ".claude/variants/py-codex/rules/a.md"],
    // A clause slug carrying a hyphen must not be mistaken for a lane segment;
    // the split is on `#`, not on the first `-`.
    ["hyphenated-clause-slug", "canon-sample.md#must-6-firing", ".claude/rules/canon-sample.md"],
    // A dotted basename must survive intact. Several live rules are dotted
    // (`ci-runners.operator.local.example.md`), and a derivation that split on
    // `.` would truncate them.
    ["dotted-basename", "variants/py/ci-runners.operator.local.example.md#detector", ".claude/variants/py/rules/ci-runners.operator.local.example.md"],
  ]) {
    const got = expectedRuleForKey(key);
    check(
      `predicate/expectedRuleForKey-${name}`,
      got === expected,
      `expected ${JSON.stringify(expected)} for key ${JSON.stringify(key)}, got ${JSON.stringify(got)}`,
    );
    // The derivation must land INSIDE the corpus it is derived for. A key that
    // produced an inadmissible path would make the coherence fence
    // unsatisfiable: no valid `rule` value could ever agree with it.
    check(
      `predicate/expectedRuleForKey-${name}-is-an-admissible-corpus-path`,
      typeof gate.isRuleCorpusPath === "function" && gate.isRuleCorpusPath(got) === true,
      `the path derived from key ${JSON.stringify(key)} is ${JSON.stringify(got)}, which the admission predicate refuses — the fence would be unsatisfiable`,
    );
  }
}

if (typeof gate.isRuleCorpusPath === "function") {
  const { isRuleCorpusPath } = gate;
  for (const [name, path] of [
    ["canon-rule", ".claude/rules/sample.md"],
    ["variant-rs-rule", ".claude/variants/rs/rules/sample.md"],
    ["variant-py-rule", ".claude/variants/py/rules/sample.md"],
    ["hyphenated-variant-rule", ".claude/variants/py-codex/rules/sample.md"],
    ["variant-name-with-digits", ".claude/variants/rs2/rules/sample.md"],
  ]) {
    check(`predicate/isRuleCorpusPath-true-${name}`, isRuleCorpusPath(path) === true, `expected true for '${path}', got ${JSON.stringify(isRuleCorpusPath(path))}`);
  }
  for (const [name, path] of [
    ["agents-tree", ".claude/agents/sample.md"],
    ["skills-tree", ".claude/skills/sample.md"],
    ["docs-tree", "docs/sample.md"],
    ["repo-root-file", "sample.md"],
    ["variants-but-not-rules", ".claude/variants/rs/skills/sample.md"],
    ["variants-missing-the-variant-segment", ".claude/variants/rules/sample.md"],
    ["variants-bare", ".claude/variants/rs/rules"],
    // Nested below a rules root. Canon's enumeration is non-recursive, so a
    // path admitted here could never be reconciled by pass 2 — the blind spot
    // re-opened from the registry side.
    ["nested-under-canon-rules", ".claude/rules/local/sample.md"],
    ["nested-under-variant-rules", ".claude/variants/rs/rules/local/sample.md"],
    // The contract names `<f>.md`. A non-markdown file is never enumerated by
    // either root (both filter on `.endsWith(".md")`).
    ["non-markdown-under-canon", ".claude/rules/sample.txt"],
    ["non-markdown-under-variant", ".claude/variants/rs/rules/sample.txt"],
    // Traversal must not launder a path into the corpus.
    //
    // THIS FIRST CASE DOES NOT EXERCISE THE TRAVERSAL GUARD and is kept only
    // because it pins the SHAPE rule. `.claude/rules/../agents/sample.md` has
    // four segments and `agents` is not `rules`, so the shape regex alone
    // rejects it — MEASURED: with the traversal guard removed entirely, this
    // case still PASSES. A case that cannot fail for the reason it is filed
    // under is not coverage of that reason (`instrument-discipline.md` MUST-2).
    ["dot-dot-escape-caught-by-shape", ".claude/rules/../agents/sample.md"],
    // These two DO exercise it. Each MATCHES the shape regex — `[^/]+` is
    // perfectly happy to match `..` or `.` — so only the explicit segment guard
    // rejects them. Found by mutation: removing the guard produced an EMPTY
    // red-set against the suite as it stood, while the mutation was PROVEN to
    // reach the code (the predicate flipped to true for the first path here).
    // An empty red-set under a reaching mutation is an UNCOVERED behaviour, not
    // a vacuous one, and these are the cases that were missing.
    //
    // Why it matters beyond tidiness: two spellings of one path let a registry
    // row bind to a file the enumeration reports under its OTHER name, so a
    // stale entry survives the staleness check that exists to catch it. The
    // `deferrals` arm's coherence fence would refuse these anyway — a key never
    // implies a path containing `..` — but `probe_authorship_deferrals` has no
    // coherence fence, so there the predicate is the only thing standing.
    // The VARIANT segment is the only position where a bare `.`/`..` can both
    // appear and satisfy the shape regex: a filename must end in `.md`, so a
    // traversal segment cannot occupy that slot. These are therefore the whole
    // reachable surface of the guard, not a sample of it.
    ["dot-dot-as-the-variant-segment", ".claude/variants/../rules/security.md"],
    ["dot-as-the-variant-segment", ".claude/variants/./rules/security.md"],
    // Absolute paths are not repo-relative and must not be admitted, or the
    // same file would be admissible under two spellings.
    ["absolute-path", "/tmp/loom/.claude/rules/sample.md"],
    ["leading-dot-slash", "./.claude/rules/sample.md"],
  ]) {
    check(`predicate/isRuleCorpusPath-false-${name}`, isRuleCorpusPath(path) === false, `expected false for '${path}', got ${JSON.stringify(isRuleCorpusPath(path))}`);
  }
  for (const [name, value] of [
    ["empty-string", ""],
    ["null", null],
    ["undefined", undefined],
    ["number", 42],
  ]) {
    let got;
    let threw = null;
    try {
      got = isRuleCorpusPath(value);
    } catch (e) {
      threw = e;
    }
    check(
      `predicate/isRuleCorpusPath-falsey-${name}`,
      threw === null && got === false,
      threw ? `threw ${threw.message} — a malformed registry value must be REFUSED, not crash the gate` : `expected false, got ${JSON.stringify(got)}`,
    );
  }
}

if (typeof gate.ruleCorpusRoots === "function") {
  const { ruleCorpusRoots } = gate;

  group(() => {
    // No variants tree at all. Canon alone, and no throw on the missing dir.
    const { root, rulesDir } = mkRepo({ rules: { "canon-sample.md": ruleBody("canon-sample") } });
    try {
      const roots = ruleCorpusRoots(root, rulesDir);
      check("roots/no-variants-tree-yields-canon-alone", roots.length === 1, `expected 1 root, got ${roots.length}: ${roots.map((r) => r.label).join(", ")}`);
      check("roots/no-variants-tree-canon-dir-is-the-rules-dir", roots.length === 1 && norm(roots[0].dir) === norm(rulesDir), `expected dir ${norm(rulesDir)}, got ${roots.length ? norm(roots[0].dir) : "(none)"}`);
      check("roots/no-variants-tree-canon-label-is-repo-relative", roots.length === 1 && norm(roots[0].label) === ".claude/rules", `expected label '.claude/rules', got ${roots.length ? JSON.stringify(norm(roots[0].label)) : "(none)"}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  group(() => {
    // Three variants, deliberately written in non-alphabetical order so a
    // filesystem that happened to return them sorted cannot be mistaken for
    // the sort this contract requires.
    const { root, rulesDir } = mkRepo({
      variantRules: {
        "rs/a.md": ruleBody("rs-a"),
        "py/a.md": ruleBody("py-a"),
        "py-codex/a.md": ruleBody("py-codex-a"),
      },
    });
    try {
      const roots = ruleCorpusRoots(root, rulesDir);
      const labels = roots.map((r) => norm(r.label));
      check("roots/every-variant-rules-dir-is-included", roots.length === 4, `expected 4 roots (canon + 3 variants), got ${roots.length}: ${labels.join(", ")}`);
      check("roots/canon-is-first", labels[0] === ".claude/rules", `expected '.claude/rules' first, got ${JSON.stringify(labels[0])}`);
      const variantLabels = labels.slice(1);
      // Sorted by VARIANT NAME, which is the only sort key that makes the order
      // stable across machines AND readable to an operator. Sorting the whole
      // LABEL string is a different order and the wrong one: `-` (0x2D) sorts
      // before `/` (0x2F), so a label sort puts `py-codex` ahead of `py` and
      // splits a lane family apart. Pinned as a literal expected array rather
      // than re-derived with `.sort()`, because re-deriving it here would be a
      // self-derived oracle — computing the expectation with the same operation
      // the subject uses guarantees agreement whatever either one does
      // (`evidence-first-claims.md` MUST-5).
      const EXPECTED_VARIANT_LABELS = [".claude/variants/py/rules", ".claude/variants/py-codex/rules", ".claude/variants/rs/rules"];
      check(
        "roots/variants-are-sorted-by-variant-name",
        JSON.stringify(variantLabels) === JSON.stringify(EXPECTED_VARIANT_LABELS),
        `expected ${EXPECTED_VARIANT_LABELS.join(", ")} — got ${variantLabels.join(", ")}`,
      );
      check(
        // The negative half: the order must NOT be a label-string sort. Without
        // this, an implementation that sorted full labels would be caught only
        // by the pin above, and a later "tidy-up" could silently swap the key.
        "roots/variants-are-not-sorted-by-full-label-string",
        JSON.stringify(variantLabels) !== JSON.stringify([...variantLabels].sort()),
        `the three labels here order DIFFERENTLY under the two sort keys, so equality means the label-string key was used: ${variantLabels.join(", ")}`,
      );
      check(
        "roots/variant-labels-are-repo-relative-rules-dirs",
        variantLabels.every((l) => /^\.claude\/variants\/[a-z0-9-]+\/rules$/.test(l)),
        `unexpected variant label shape: ${variantLabels.join(", ")}`,
      );
      check(
        "roots/every-dir-is-absolute-and-under-the-repo",
        roots.every((r) => norm(r.dir).startsWith(norm(root) + "/") || norm(r.dir) === norm(rulesDir)),
        `a root escaped the repo: ${roots.map((r) => norm(r.dir)).join(", ")}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  group(() => {
    // A variant directory with NO `rules/` subdir contributes nothing. Without
    // this pole, an implementation that returned every `variants/<v>` dir
    // would pass the case above and then hand pass 2 a directory whose
    // `readdirSync` lists skills.
    const { root, rulesDir } = mkRepo({
      variantRules: { "rs/a.md": ruleBody("rs-a") },
      emptyDirs: [".claude/variants/base/skills", ".claude/variants/gemini"],
    });
    try {
      const labels = ruleCorpusRoots(root, rulesDir).map((r) => norm(r.label));
      check(
        "roots/variant-without-a-rules-subdir-is-excluded",
        labels.length === 2 && !labels.some((l) => l.includes("/base/") || l.includes("/gemini/")),
        `expected canon + rs only, got: ${labels.join(", ")}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  group(() => {
    // Bipolar companion: the SAME repo shape with a `rules/` subdir added
    // under `base`. If the exclusion above were an unconditional "skip base",
    // this pole would red.
    const { root, rulesDir } = mkRepo({
      variantRules: { "rs/a.md": ruleBody("rs-a"), "base/a.md": ruleBody("base-a") },
      emptyDirs: [".claude/variants/gemini"],
    });
    try {
      const labels = ruleCorpusRoots(root, rulesDir).map((r) => norm(r.label));
      check(
        "roots/variant-with-a-rules-subdir-is-included",
        labels.includes(".claude/variants/base/rules"),
        `expected base to be included once it has a rules/ dir, got: ${labels.join(", ")}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  group(() => {
    // Every root `ruleCorpusRoots` returns must be a path `isRuleCorpusPath`
    // would admit a file under. The two predicates are the enumerator and the
    // admission gate for ONE corpus; if they disagree, the blind spot reopens
    // from whichever side is narrower — which is the defect this whole file is
    // about, arriving through a different door.
    const { root, rulesDir } = mkRepo({
      variantRules: { "rs/a.md": ruleBody("rs-a"), "py-codex/a.md": ruleBody("py-codex-a") },
    });
    try {
      const roots = ruleCorpusRoots(root, rulesDir);
      const disagreeing = typeof gate.isRuleCorpusPath === "function" ? roots.filter((r) => !gate.isRuleCorpusPath(`${norm(r.label)}/a.md`)) : ["isRuleCorpusPath not exported"];
      check(
        "roots/enumerator-and-admission-predicate-agree",
        disagreeing.length === 0,
        `these enumerated roots hold files the admission predicate would refuse: ${disagreeing.map((r) => r.label ?? r).join(", ")}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

console.log(`\n${pass}/${pass + fail} fixtures passed`);

if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  ${f.name}: ${f.reason}`);
  process.exit(1);
}

process.exit(0);
