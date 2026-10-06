#!/usr/bin/env node
/**
 * run.mjs — audit-fixture runner for `.claude/hooks/lib/floor-only-assertion.js`, the pure
 * predicates behind `floor-only-assertion-guard.js` (`conformance-walk.md` MUST-1 + MUST-3),
 * shipped WITH the detector per `cc-artifacts.md` Rule 9.
 *
 * NAMESPACE. This directory ALSO holds the probe candidates + `.expected` answer-key sidecars for
 * this rule's SEMANTIC tier, which are a different instrument with a different owner. Every file
 * belonging to THIS structural tier — this runner and its fixtures — is prefixed `floor-`, and this
 * runner reads ONLY `floor-*.txt`. It touches nothing else in the directory.
 *
 * NO LIVE REPO NEEDED FOR THE FIXTURE CASES. Each fixture declares its own in-repo path in a
 * `@fixture-path:` marker and its expected verdict in an `@expect:` marker, and every case is
 * driven against the module's DECLARED fallback scope authority.
 *
 * TWO CASES TOUCH DISK, and the distinction matters (CORRECTED 2026-09-19 — this header read "the
 * one case", which the same change that added U5 falsified). U2 reads a path that does not exist,
 * on purpose, to exercise the degrade arm. U5 reads the LIVE rule at
 * `.claude/rules/conformance-walk.md`, because a mirror-parity claim cannot be made against a
 * fixture copy of the very thing it checks for drift. U5 therefore reports NOT-APPLICABLE — not
 * PASS, not FAIL — where that file is absent: `audit-fixtures/**` ships on the `cc` tier and
 * `rules/conformance-walk.md` on `coc-core`, so a target subscribing one and not the other
 * legitimately holds the runner and no rule, and a hard RED there would be a distribution
 * artefact masquerading as drift.
 *
 * BIPOLAR BY CONSTRUCTION, per predicate AND per scope restriction. A set that only ever asserts
 * firing passes identically against a detector that fires on everything; a set that only ever
 * asserts silence passes identically against an INERT one. Both are live risks here because the
 * whole guard is capped at `advisory` — an inert advisory is indistinguishable from a clean
 * session. The poles, paired:
 *
 *   floor verdict      flag-status-under-500 · flag-assert-true (py) · flag-assert-true-rust ·
 *                      flag-lone-tobedefined      ⟷  clean-real-assertion
 *   floor-ONLY bound   (all four above)           ⟷  clean-floor-plus-real-assertions
 *   denominator        flag-hand-listed-denominator (js) · -py  ⟷  clean-derived-denominator
 *   accumulator arm    flag-hand-listed-denominator            ⟷  clean-accumulator-not-denominator
 *   comment arm        flag-assert-true                        ⟷  skip-in-comment
 *   string-literal arm flag-status-under-500                   ⟷  skip-in-string-literal
 *   heredoc arm        flag-assert-true                        ⟷  skip-heredoc-body
 *   path scope arm     flag-hand-listed-denominator            ⟷  skip-non-test-file
 *   fail-open arm      (unit case U1 below)
 *   degrade arm        (U2 — corpus absent ⇒ declared fallback, never a false clean)
 *   scope bipolarity   (U3 — in-scope paths match ⟷ out-of-scope paths do not)
 *   line classifier    (U4 — floor/real poles, incl. two calls on one line)
 *   mirror parity      (U5 — FALLBACK_RULE_GLOBS ⟷ the frontmatter it copies; NOT-APPLICABLE,
 *                      never PASS, where the rule is not distributed to this target)
 *   fixture withdrawal (U6 — a fixture-tree replica withdraws ⟷ its non-fixture twin is
 *                      admitted; plus a segment-vs-substring pole)
 *   loom-gate reach    (U7 — the six loom enforcement globs reach their gates ⟷ their non-gate
 *                      neighbours are not claimed)
 *
 * Exits non-zero on ANY mismatch, after printing a line naming the failing case AND the predicate
 * that failed.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const L = require(join(HERE, "..", "..", "hooks", "lib", "floor-only-assertion.js"));

let pass = 0;
const failures = [];
// DERIVED, NEVER HAND-LISTED — every case name that actually RAN, so the verdict's denominator is
// read off the run instead of retyped. This runner enforces `conformance-walk.md` MUST-3 (coverage
// reported honestly, denominator derived) and its own footer used to violate it: the unit-case
// count was the literal `7`, updated by hand whenever a case was added. It had ALREADY drifted
// once (`4` while U1–U7 existed), and a literal cannot express the U5 N/A arm at all — a target
// where the rule is not distributed runs SIX unit cases while the footer still claims seven.
const ranCases = [];
const notApplicable = [];

function check(name, predicate, ok, detail) {
  ranCases.push(name);
  if (ok) {
    pass++;
    console.log(`PASS  ${name}  [${predicate}]`);
  } else {
    failures.push({ name, predicate, detail });
    console.log(`FAIL  ${name}  [${predicate}] — ${detail}`);
  }
}

// ── fixture-driven cases ─────────────────────────────────────────────────────

const authority = L.fallbackAuthority();
const fixtures = readdirSync(HERE)
  .filter((f) => f.startsWith("floor-") && f.endsWith(".txt"))
  .sort();

if (fixtures.length === 0) {
  console.log("FAIL  <fixture discovery>  [runner] — no floor-*.txt fixtures found");
  process.exit(1);
}

for (const f of fixtures) {
  const raw = readFileSync(join(HERE, f), "utf8");
  const pathM = /@fixture-path:\s*(\S+)/.exec(raw);
  const expectM = /@expect:\s*([^\n]+)/.exec(raw);
  if (!pathM || !expectM) {
    check(f, "fixture-markers", false, "missing @fixture-path: or @expect: marker");
    continue;
  }
  const rel = pathM[1];
  const expected = expectM[1].trim() === "none" ? [] : expectM[1].trim().split(/\s*,\s*/);

  const findings = L.inspectFile({ rel, text: raw, authority });
  const got = [...new Set(findings.map((x) => x.rule_id))].sort();
  const want = [...new Set(expected)].sort();

  check(
    f,
    want.length ? "fires-with-expected-identity" : "stays-silent",
    JSON.stringify(got) === JSON.stringify(want),
    `expected [${want.join(", ") || "∅"}] got [${got.join(", ") || "∅"}]` +
      (findings.length ? ` :: ${findings.map((x) => `L${x.line} ${x.evidence}`).join(" | ")}` : ""),
  );

  if (findings.length) {
    check(
      f,
      "severity-capped-at-advisory",
      findings.every((x) => x.severity === "advisory"),
      `hook-output-discipline.md MUST-2 caps a lexical verdict below block; got ` +
        `[${[...new Set(findings.map((x) => x.severity))].join(", ")}]`,
    );
    check(
      f,
      "evidence-is-bounded",
      findings.every((x) => x.evidence.length <= 240 && !/[\r\n]/.test(x.evidence)),
      "evidence must be bounded and newline-free",
    );
  }
}

// ── unit cases: the arms no fixture text can express ─────────────────────────

// U1 — fail open on absent input (no rel, no text). An UNKNOWN is never a violation.
check(
  "U1 unknown-input-fails-open",
  "inspectFile-absent-fields",
  L.inspectFile({}).length === 0 &&
    L.inspectFile({ rel: "e2e/a.test.js" }).length === 0 &&
    L.inspectFile({ text: "assert(true)" }).length === 0 &&
    L.inspectFile(null).length === 0,
  "absent rel/text/payload must yield zero findings",
);

// U2 — a corpus-less consumer degrades to the DECLARED hand-listed fallback, never to a false
// clean: derived:false, and the fallback globs still reach the test surface.
const degraded = L.readScopeAuthority(join(HERE, "no-such-project-root-xyz"));
check(
  "U2 corpus-absent-degrades-to-declared-fallback",
  "readScopeAuthority-degrade",
  degraded.derived === false &&
    degraded.sources.some((s) => s.includes("FALLBACK")) &&
    L.isInScopePath("e2e/api/orders.test.js", degraded) === true,
  `derived=${degraded.derived} sources=${degraded.sources.join("+")}`,
);

// U3 — the scope predicate is bipolar on its OWN axis, not only via fixtures.
check(
  "U3 scope-predicate-bipolar",
  "isInScopePath",
  L.isInScopePath("tools/conformance/report.js", authority) === true &&
    L.isInScopePath("tests/e2e/test_x.py", authority) === true &&
    L.isInScopePath("a/b/__tests__/x.js", authority) === true &&
    L.isInScopePath("src/server/routes.js", authority) === false &&
    L.isInScopePath("", authority) === false &&
    L.isInScopePath("../outside/e2e/x.test.js", authority) === false,
  "in-scope paths must match and out-of-scope paths must not",
);

// U4 — the line classifier's own poles, including the two-calls-on-one-line case that decides
// whether a floor beside a real assertion is scored REAL.
const c = L.classifyAssertionLine.bind(L);
check(
  "U4 classify-line-poles",
  "classifyAssertionLine",
  c("expect(res.status < 500).toBe(true);").floor === true &&
    c("expect(res.status < 500).toBe(true);").real === false &&
    c("assert(true); assertEqual(x, 3);").floor === true &&
    c("assert(true); assertEqual(x, 3);").real === true &&
    c("expect(res.body.sku).toBe('A1');").floor === false &&
    c("expect(res.body.sku).toBe('A1');").real === true &&
    c("const res = await client.post('/orders');").real === false,
  "floor/real classification poles",
);

// U5 — THE MIRROR CANNOT DRIFT SILENTLY. `FALLBACK_RULE_GLOBS` is a hand-kept copy of
// `conformance-walk.md` frontmatter `paths:`, used only when the rule is unreadable. Nothing
// printed the two lists' disagreement until this case existed, and the 2026-09-19 loom-own-gate
// widening is the first edit that could have created one. Set-for-set, order-insensitive; the
// falsifying result is a non-empty `only_in_*` list, which this case PRINTS rather than
// summarising. If the rule is unreadable the case SKIPS loudly rather than passing vacuously —
// a green here must mean "compared and agreed", never "could not compare".
{
  const ruleMd = join(HERE, "..", "..", "rules", "conformance-walk.md");
  // THREE outcomes, not two, and the split is a DISTRIBUTION fact rather than a nicety.
  // `audit-fixtures/**` ships on the `cc` tier; `rules/conformance-walk.md` ships on `coc-core`
  // (sync-manifest.yaml). A target subscribing `cc` and not `coc-core` legitimately holds this
  // runner and NO rule, so reading the file's ABSENCE as drift would RED every such consumer on
  // a condition it cannot fix — the false positive that teaches an operator the suite is broken.
  //   ABSENT, and coc-core NOT subscribed -> NOT APPLICABLE, announced
  //   ABSENT, and coc-core IS subscribed   -> FAIL: the rule MOVED or was deleted
  //   PRESENT, no paths -> FAIL. That IS the silent-degradation class U5 exists to catch: the
  //                        module falls back while a caller still reads the scope as derived.
  //   PRESENT, paths    -> compare set-for-set
  //
  // THE N/A ARM IS DISCRIMINATED, NOT ASSUMED (added after a Tier-1 redteam finding). An
  // unconditional N/A-on-absence would mean that renaming or deleting this rule AT LOOM silently
  // disarms the only mirror-parity check there is, with the suite exiting 0 — and a prose warning
  // ("if you see this line at loom, the rule moved") is an instruction to a human, not an
  // assertion. `zero-tolerance.md` rides the SAME `coc-core` tier as `conformance-walk.md`
  // (sync-manifest.yaml) and this module ALREADY reads it as its second scope authority, so its
  // presence is a sound, dependency-free probe for whether this target subscribes that tier:
  //   both absent      -> genuinely a `cc`-only target; N/A is the true answer
  //   zero-tolerance   -> `coc-core` IS here, so conformance-walk.md SHOULD be too; its absence
  //   present, CW not     is drift, and drift is a FAIL
  let ruleText = null;
  let readErr = null;
  try {
    ruleText = readFileSync(ruleMd, "utf8");
  } catch (err) {
    readErr = err;
  }
  let cocCoreSubscribed = false;
  try {
    readFileSync(join(HERE, "..", "..", "rules", "zero-tolerance.md"), "utf8");
    cocCoreSubscribed = true;
  } catch {
    cocCoreSubscribed = false;
  }
  if (ruleText === null && cocCoreSubscribed) {
    check(
      "U5 fallback-mirrors-frontmatter",
      "FALLBACK_RULE_GLOBS-parity",
      false,
      `${ruleMd} is ABSENT but zero-tolerance.md (same coc-core tier) is PRESENT, so this target ` +
        `DOES subscribe the rule tier — the rule moved or was deleted, and the mirror-parity ` +
        `check is disarmed. This is drift, not a distribution boundary.`,
    );
  } else if (ruleText === null) {
    // Announced LOUDLY per `conservation-gate.md` MUST-4: an empty outcome MUST be
    // distinguishable from a successful one, so it prints rather than passing in silence.
    console.log(
      `N/A   U5 fallback-mirrors-frontmatter  [FALLBACK_RULE_GLOBS-parity] — ${ruleMd} absent ` +
        `(${readErr && readErr.code ? readErr.code : "unreadable"}); the rule ships on a ` +
        `DIFFERENT tier than this runner, so parity is NOT APPLICABLE here — not clean, not ` +
        `failed — zero-tolerance.md is absent too, so the coc-core tier is genuinely not here.`,
    );
    notApplicable.push("U5 fallback-mirrors-frontmatter");
  } else if (!L.parseFrontmatterPaths(ruleText).length) {
    check(
      "U5 fallback-mirrors-frontmatter",
      "FALLBACK_RULE_GLOBS-parity",
      false,
      `${ruleMd} EXISTS but no frontmatter paths: parsed — the silent-degradation class: ` +
        `readScopeAuthority falls back while a caller reads the scope as derived`,
    );
  } else {
    const frontPaths = L.parseFrontmatterPaths(ruleText);
    const a = new Set(frontPaths);
    const b = new Set(L.FALLBACK_RULE_GLOBS);
    const onlyFront = [...a].filter((x) => !b.has(x));
    const onlyFallback = [...b].filter((x) => !a.has(x));
    check(
      "U5 fallback-mirrors-frontmatter",
      "FALLBACK_RULE_GLOBS-parity",
      onlyFront.length === 0 && onlyFallback.length === 0,
      `only_in_frontmatter=[${onlyFront.join(", ")}] only_in_FALLBACK_RULE_GLOBS=[${onlyFallback.join(", ")}]`,
    );

    // U5b — THE SECOND MIRROR, which had no case at all. `readScopeAuthority` derives TWO
    // authorities and `derived` is true only when BOTH parse: this rule's frontmatter AND
    // `zero-tolerance.md` Rule 6's `Test files excluded:` line. U5 above mirrors only the first,
    // so a reword of that Rule-6 line drifted `FALLBACK_TEST_GLOBS` in silence — and that array
    // is the same hand-listed shape this module's own `detectHandListedDenominators` exists to
    // catch, which makes the gap self-referential. Same tier as U5 (`zero-tolerance.md` rides
    // `coc-core`), so the absence branch is already discriminated above: reaching here means the
    // file is present.
    const ztPath = join(HERE, "..", "..", "rules", "zero-tolerance.md");
    let ztConv = null;
    try {
      ztConv = L.parseTestFileConvention(readFileSync(ztPath, "utf8"));
    } catch {
      ztConv = null;
    }
    if (!ztConv || !ztConv.length) {
      // The two causes are distinguished because the WRONG diagnosis sends a reader to the wrong
      // file. Reaching here means conformance-walk.md parsed, so the same-tier inference makes an
      // absent zero-tolerance.md unreachable in distribution — but an inference is not a reason to
      // print a false cause.
      const ztPresent = existsSync(ztPath);
      check(
        "U5b fallback-mirrors-test-file-convention",
        "FALLBACK_TEST_GLOBS-parity",
        false,
        ztPresent
          ? `${ztPath} is PRESENT but its Rule-6 test-file convention did not parse — ` +
              `readScopeAuthority degrades to FALLBACK_TEST_GLOBS while a caller reads the scope ` +
              `as derived`
          : `${ztPath} is ABSENT while conformance-walk.md parsed, though both ride coc-core — ` +
              `so this is not the distribution boundary and the rule tree is inconsistent`,
      );
    } else {
      const ca = new Set(ztConv);
      const cb = new Set(L.FALLBACK_TEST_GLOBS);
      const onlyRule = [...ca].filter((x) => !cb.has(x));
      const onlyConst = [...cb].filter((x) => !ca.has(x));
      check(
        "U5b fallback-mirrors-test-file-convention",
        "FALLBACK_TEST_GLOBS-parity",
        onlyRule.length === 0 && onlyConst.length === 0,
        `only_in_zero-tolerance=[${onlyRule.join(", ")}] only_in_FALLBACK_TEST_GLOBS=[${onlyConst.join(", ")}]`,
      );
    }
  }
}

// U6 — the fixture-tree withdrawal, BIPOLAR. A withdrawal asserted in one direction only passes
// identically against a module that withdraws EVERYTHING, which for an advisory is
// indistinguishable from an inert guard. So both poles run: the SAME basename under a fixture
// tree is withdrawn and outside one is admitted.
check(
  "U6 fixture-tree-withdrawal-bipolar",
  "isInScopePath-FIXTURE_TREE_SEGMENT",
  // withdrawn: fixture-tree replicas of real in-scope paths
  L.isInScopePath(".claude/audit-fixtures/x/.claude/hooks/leaky.js", authority) === false &&
    L.isInScopePath(".claude/audit-fixtures/y/.github/workflows/w.yml", authority) === false &&
    L.isInScopePath("audit-fixtures/e2e/orders.test.js", authority) === false &&
    // admitted: the same shapes OUTSIDE a fixture tree — the opposite pole
    L.isInScopePath(".claude/hooks/leaky.js", authority) === true &&
    L.isInScopePath(".github/workflows/w.yml", authority) === true &&
    L.isInScopePath("e2e/orders.test.js", authority) === true &&
    // a segment match, not a substring one: `my-audit-fixtures-notes` is NOT the fixture tree
    L.isInScopePath("my-audit-fixtures-notes/e2e/orders.test.js", authority) === true,
  "fixture-tree paths must withdraw and their non-fixture twins must admit",
);

// U7 — the loom-own-gate globs actually REACH loom's own gates. The widening's whole purpose,
// asserted against the DECLARED fallback so it holds for a corpus-less consumer too.
check(
  "U7 loom-own-gate-surface-in-scope",
  "isInScopePath-loom-gates",
  // Asserted against the DECLARED FALLBACK below. The DERIVED authority is pinned separately by
  // U8, because these two cases fail for DIFFERENT reasons and collapsing them would let a
  // frontmatter-only regression hide behind a healthy mirror (Tier-1 redteam L4).
  L.isInScopePath("scripts/ci/dev-preflight.mjs", authority) === true &&
    L.isInScopePath(".github/workflows/coc-artifact-eval.yml", authority) === true &&
    L.isInScopePath(".claude/bin/check-descoping.mjs", authority) === true &&
    L.isInScopePath(".claude/hooks/lib/floor-only-assertion.js", authority) === true &&
    L.isInScopePath(".claude/test-harness/ci-suites.json", authority) === true &&
    // opposite pole: neighbours the widening deliberately does NOT claim
    L.isInScopePath("scripts/publish-to-public.mjs", authority) === false &&
    L.isInScopePath(".claude/bin/emit.mjs", authority) === false &&
    L.isInScopePath(".claude/commands/codify.md", authority) === false,
  "loom gate paths must be in scope and their non-gate neighbours must not",
);

// U8 — the FRONTMATTER's own loom-gate reach, read through `readScopeAuthority` rather than the
// fallback. U7 proves the hand-kept mirror reaches loom's gates and U5 proves the two lists agree,
// so a frontmatter regression is caught only TRANSITIVELY through U5 — and U5 is the case that
// goes N/A off-loom. This asserts the live derivation directly, and reports NOT-APPLICABLE by the
// same coc-core probe U5 uses rather than failing where the rule is legitimately absent.
{
  const derivedAuth = L.readScopeAuthority(join(HERE, "..", ".."  , ".."));
  // U5 AND U8 READ THE RULE THROUGH DIFFERENT PATH EXPRESSIONS, and that is the whole hazard.
  // U5 reads `<HERE>/../../rules/conformance-walk.md` directly; U8 reads it through
  // `readScopeAuthority`, which builds its own path. So "U5 owns the absent-vs-drift verdict" is
  // FALSE for a regression INSIDE `readScopeAuthority` — break its path and U5 still passes while
  // the SHIPPED guard silently degrades to the hand-listed fallback. An unconditional N/A here
  // absorbed exactly that, green, which is the class U5's own comment claims to own. So the N/A
  // arm is DISCRIMINATED against U5's own readability probe: the rule being READABLE while the
  // derivation FAILED is a defect in the derivation, and it FAILS.
  // Asked INDEPENDENTLY rather than reusing U5's block-scoped read, which is also the more
  // correct instrument: U8's question is whether the rule is reachable at U5's path expression
  // AT THIS MOMENT, not what U5 happened to observe earlier.
  const ruleReadableAtU5Path = existsSync(join(HERE, "..", "..", "rules", "conformance-walk.md"));
  if (!derivedAuth.derived && ruleReadableAtU5Path) {
    check(
      "U8 frontmatter-reaches-loom-gates",
      "readScopeAuthority-derived",
      false,
      `the rule IS readable at U5's path but readScopeAuthority did NOT derive ` +
        `(sources: ${derivedAuth.sources.join("+")}) — the degradation is in the derivation, not ` +
        `in distribution, and the shipped guard is running on the hand-listed fallback`,
    );
  } else if (!derivedAuth.derived) {
    console.log(
      `N/A   U8 frontmatter-reaches-loom-gates  [readScopeAuthority-derived] — scope did not ` +
        `derive AND the rule is absent at U5's path too, so this is the distribution boundary ` +
        `U5 reported, not a derivation defect.`,
    );
    notApplicable.push("U8 frontmatter-reaches-loom-gates");
  } else {
    check(
      "U8 frontmatter-reaches-loom-gates",
      "readScopeAuthority-derived",
      L.isInScopePath("scripts/ci/dev-preflight.mjs", derivedAuth) === true &&
        L.isInScopePath(".github/workflows/coc-artifact-eval.yml", derivedAuth) === true &&
        L.isInScopePath(".claude/bin/check-descoping.mjs", derivedAuth) === true &&
        L.isInScopePath(".claude/hooks/lib/floor-only-assertion.js", derivedAuth) === true &&
        L.isInScopePath(".claude/test-harness/ci-suites.json", derivedAuth) === true &&
        // opposite pole, so this is not a matches-everything assertion
        L.isInScopePath(".claude/commands/codify.md", derivedAuth) === false &&
        L.isInScopePath(".claude/bin/emit.mjs", derivedAuth) === false,
      `derived=${derivedAuth.derived} globs=${derivedAuth.globs.length} ` +
        `sources=${derivedAuth.sources.join("+")}`,
    );
  }
}

// ── verdict ──────────────────────────────────────────────────────────────────

console.log("");
if (failures.length) {
  console.log(`RED SET (${failures.length}):`);
  for (const f of failures) console.log(`  - ${f.name} :: predicate ${f.predicate} :: ${f.detail}`);
  console.log(
    `\n${pass} passed, ${failures.length} FAILED${notApplicable.length ? `, ${notApplicable.length} n/a` : ""}`,
  );
  process.exit(1);
}
// `/^U\d+\b/` was WRONG and under-reported by one: `\b` between `5` and `b` is not a boundary,
// so `U5b` never matched — a derived denominator that was still wrong, in the runner enforcing
// `conformance-walk.md` MUST-3. Suffixed case ids are the norm here, not the exception.
const unitRan = ranCases.filter((n) => /^U\d+/.test(n)).length;
const naNote = notApplicable.length ? `, ${notApplicable.length} n/a (${notApplicable.join(", ")})` : "";
console.log(
  `${pass} passed, 0 failed${naNote} — ${fixtures.length} fixtures + ${unitRan} unit case(s) RUN`,
);
process.exit(0);
