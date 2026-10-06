#!/usr/bin/env node
/**
 * floor-only-assertion.js — PURE PREDICATES for `conformance-walk.md` MUST-1 + MUST-3.
 *
 * Two families, one file, because they are the two halves of the same lie: a suite that reports
 * coverage it does not have.
 *
 *   (1) FLOOR-ONLY ASSERTIONS — `conformance-walk.md` MUST-1. A case whose ONLY assertion is the
 *       FLOOR (`status < 500`, `assert(true)`, a lone `expect(x).toBeDefined()`) cannot distinguish
 *       a working system from a broken one. The skill names it exactly: "an un-measured unit
 *       wearing a green hat" (`skills/conformance-walk/coverage-honesty-contract.md` §3, the
 *       no-vacuous-eval guard). Such a verdict MUST NOT count toward coverage.
 *
 *   (2) HAND-LISTED DENOMINATORS — `conformance-walk.md` MUST-3, and the same contract
 *       `instrument-discipline.md` MUST-6(c) states generally: a cited input set is DERIVED from
 *       what the run enumerated, never hand-typed. A coverage denominator written as an integer
 *       literal (`const total = 14;`) "silently shrinks to whatever the author remembered to
 *       include" (coverage-honesty-contract §1) — the fabricated-by-omission 100% MUST-3 blocks.
 *       The compliant form derives it: `cases.length`, `len(cases)`, `results.len()`.
 *
 * NO I/O IN THE PREDICATES. `inspectFile()` takes text + a declared path + a resolved scope
 * authority and returns findings. `readScopeAuthority()` is the ONE function that touches disk, so
 * fixtures drive every predicate directly with no live repo.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * SCOPE — DERIVED FROM TWO AUTHORITIES, WITH A DECLARED FALLBACK
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * A predicate keyed on a naming convention a newer convention outgrew is this repo's recurring
 * defect class, so the in-scope set is READ from the corpus rather than invented here:
 *
 *   - `.claude/rules/conformance-walk.md` frontmatter `paths:` — the rule's OWN declared surface
 *     (the e2e, suites, conformance and eval-harness globs). This is the authority for the harness
 *     surface family (2) lives on, which is frequently NOT named like a test file.
 *   - `.claude/rules/zero-tolerance.md` Rule 6's `Test files excluded:` line — the corpus's ONE
 *     declared test-file naming convention (`test_*`, `*_test.*`, `*.test.*`, `*.spec.*`,
 *     `__tests__/`).
 *
 * WHERE THE DERIVATION FAILS (unreadable corpus, a consumer with no `.claude/rules/`) the module
 * falls back to `FALLBACK_TEST_GLOBS` / `FALLBACK_RULE_GLOBS` below, which are HAND-LISTED — stated
 * here rather than implied — and marks `derived:false` on the returned authority so a caller can
 * see it. That is degradation to a smaller true answer, never to a false clean.
 *
 * WHERE THE SCOPE IS WEAK, stated: a Rust `#[cfg(test)]` module living in `src/foo.rs` matches
 * NEITHER authority and is not inspected; a `tests/` integration directory is in scope only when it
 * also matches one of the rule's globs. Both are UNDER-reach (silence), never over-reach.
 *
 * AND TWO MORE, both added 2026-09-19 with the loom-own-gate widening.
 *
 * (i) DATA FILES AND WORKFLOW YAML ARE IN SCOPE AND UNREACHED BY FAMILY (1). The widening put
 * `.claude/test-harness/**` and `.github/workflows/**` in scope, and family (1) needs a recognized
 * CASE-OPENING line, which those formats do not have. MEASURED over the 1023 in-scope tracked
 * files, counting files with >=1 case after masking: `.json` 0 of 103, `.yml` 0 of 3, `.sh` 0 of 3,
 * `.cjs` 0 of 5, `.md` 1 of 145 — against `.mjs` 321 of 369 and `.js` 110 of 386, which is the
 * firing control that makes those zeros readable. So a path being IN SCOPE is NOT the same as its
 * being REACHED, and an in-scope assertion in a fixture case proves only membership. Family (2)
 * (hand-listed denominator) needs no case shape and is not bound by this; family (1) is. This
 * module's silence on a workflow YAML or a suite JSON is the absence of an instrument.
 *
 * (ii) Any path with an `audit-fixtures` SEGMENT is withdrawn before any matcher runs
 * (`FIXTURE_TREE_SEGMENT`). That
 * removes a MEASURED over-match — the rule's root-anchored globs float in `globToRegExp`, so
 * `.claude/hooks/**` reached 36 fixture-tree replicas and `.github/workflows/**` was 75%
 * fixture — and it COSTS the fixture RUNNERS, which are genuine harness code. Both halves are
 * recorded at the constant rather than implied here.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * CASE BOUNDING — HOW, AND WHERE IT IS WEAK
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * The defect is a case whose ONLY assertion is the floor. A floor assertion sitting alongside a
 * real one is NOT this defect and MUST NOT fire. So the predicate needs a case boundary, and it
 * bounds one as: a case STARTS at a recognized case-opening line (`it(` / `test(` / `def test_` /
 * an `#[test]`-attributed `fn` / `func Test`) and RUNS to the next case-opening line or EOF.
 *
 * That bound is a heuristic and these are its known weaknesses, named rather than hidden:
 *   - a real assertion living in a HELPER the case calls is not seen, so the case can read
 *     floor-only and fire (over-reach — the one direction this predicate can be wrong);
 *   - a nested `describe`/helper `fn` between two cases is absorbed into the first case, so a
 *     floor-only case can be masked by an assertion in the helper below it (under-reach);
 *   - a file with NO recognizable case shape is NOT inspected by family (1) at all. Deliberate:
 *     treating a whole file as one case would fire on any harness that happens to contain a floor
 *     check. Silence, not a guess.
 * This over-reach is the concrete reason the finding is capped at `advisory`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHAT WITHDRAWS A MATCH
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *   - A pattern inside a COMMENT or a STRING LITERAL is documentation, not an assertion.
 *     `maskLiteralsAndComments()` blanks both (delimiters included, newlines and offsets
 *     preserved) BEFORE any matcher runs, so `// never write assert(true)` and
 *     `msg = "status < 500 is the floor"` are both silent.
 *   - Heredoc BODIES are blanked first via `violation-patterns.js::stripHeredocBodies` (REQUIRED,
 *     never copied, never edited) so a `<<EOF … assert(true) … EOF` payload a conformance script
 *     feeds to another process is read as DATA, not as this file's assertion.
 *   - Family (2) withdraws on an ACCUMULATOR: `let total = 0;` followed anywhere by `total += 1` /
 *     `total++` / `total = total + …` is a counter, not a hand-listed denominator. Without this
 *     withdrawal the predicate would fire on nearly every runner in the corpus, which is how an
 *     advisory earns the override reflex that makes it catch nothing.
 *
 * SEVERITY — `advisory`, and the cap is argued, not assumed. `hook-output-discipline.md` MUST-2
 * RESERVES `block` for a structural signal a surface rewrite cannot evade and FORBIDS it for a
 * lexical match. Both verdicts here are lexical judgments over code: whether an assertion is the
 * ONLY one in its case depends on a case boundary this module infers (above), and whether an
 * integer literal is a COVERAGE denominator rather than an unrelated constant is read off an
 * identifier NAME. `conformance-walk.md` § Trust Posture Wiring says the same in advance — "a
 * lexical tripwire on `assert(true)` / status-only assertions MAY pair as advisory but MUST NOT
 * carry `block`". It is not lower than advisory because the finding is actionable and specific: it
 * names the case and quotes the line.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SEVERITY = "advisory";
const FINDING_FLOOR = "conformance-walk/floor-only-assertion";
const FINDING_DENOM = "conformance-walk/hand-listed-denominator";

/** HAND-LISTED — the declared fallback when the corpus authority cannot be read. See header. */
const FALLBACK_TEST_GLOBS = ["test_*", "*_test.*", "*.test.*", "*.spec.*", "__tests__/"];

// THIS LIST IS A HAND-KEPT MIRROR OF `conformance-walk.md` frontmatter `paths:`, AND THE
// MIRROR IS THE HAZARD (2026-09-19). The derived authority above READS that frontmatter; this
// list is used ONLY when the read fails. So widening the rule and leaving this narrow produces
// a SILENT DIVERGENCE: the derived path sees loom's own gates, the degraded path does not, and
// nothing prints the difference. That is not hypothetical — the 2026-09-19 widening is the
// first time the two lists could disagree, and the divergence would have been invisible.
//
// WHY A COPY AT ALL, rather than a derivation. This list exists precisely for the case where
// the rule CANNOT be read (an unreadable corpus, or a consumer with no `.claude/rules/`), so
// it cannot be derived from the thing whose absence it covers. A copy is unavoidable; a
// SILENT copy is not. The anti-drift device is mechanical and lives with the fixtures:
// `.claude/audit-fixtures/conformance-walk/run.mjs` case U5 asserts this array equals the
// rule's frontmatter `paths:` set-for-set WHENEVER the rule is readable, and REDS on
// disagreement. Change one, the fixture runner fails until you change the other.
const FALLBACK_RULE_GLOBS = [
  // (1) consumer surface
  "**/tools/conformance/**",
  "**/e2e/**",
  "**/eval-harness/**",
  "**/04-validate/**",
  "**/*conformance*",
  "**/suites/**",
  // (2) loom's own enforcement surface
  "scripts/ci/**",
  ".github/workflows/**",
  ".claude/bin/check-*.mjs",
  ".claude/hooks/**",
  ".claude/test-harness/**",
  ".claude/audit-fixtures/**",
];

// A FIXTURE TREE IS DATA, NOT AN ASSERTION — the path-level sibling of the comment, string
// and heredoc withdrawals in the header (2026-09-19).
//
// `globToRegExp` PREFIXES `**/` to any glob not already starting with `**` or `/`, so the
// root-anchored globs above are FLOATING in this module's matcher. MEASURED on this tree over
// `git ls-files`, float vs root-anchored, ALL SIX loom globs rather than the two that make the
// point — an over-match census that reports only its worst rows is the selective denominator
// this rule blocks:
//     scripts/ci/**              8 vs 8      float-only 0
//     .github/workflows/**       8 vs 2      float-only 6   (75% over-match)
//     .claude/bin/check-*.mjs   36 vs 36     float-only 0
//     .claude/hooks/**         302 vs 266    float-only 36
//     .claude/test-harness/**  452 vs 435    float-only 17
//     .claude/audit-fixtures/** 4879 vs 4879 float-only 0
// Those float-only files are authored to CONTAIN a planted pattern for some OTHER detector, so
// inspecting them manufactures findings true of the fixture and false of the repo.
//
// RESIDUAL OVER-REACH AFTER THE WITHDRAWAL IS EXACTLY ONE PATH, and it is declared because this
// header states the module is UNDER-reach-only, which that one path contradicts:
// `.claude/dev-container-templates/py/.github/workflows/publish-dev-image.yml` — a container
// TEMPLATE's workflow, not a loom gate, admitted by the floating `.github/workflows/**` and not
// withdrawn because it carries no `audit-fixtures` segment. MEASURED across all twelve globs: 1.
// It yields zero findings today, so there is no live false positive; it is recorded rather than
// rounded away. NOT fixed with a second segment withdrawal — a per-exception segment list is the
// enumeration-drift shape this module refuses elsewhere; the root fix is for `globToRegExp` to
// honour a root-anchored glob the way `check-rule-injection-budget.mjs::globToRegex` does, which
// is a matcher change owed its own mutation-verified shard (all sixteen test globs depend on the
// `**/` prefix and would have to move with it).
//
// The withdrawal is by SEGMENT, so it holds wherever the tree is rooted, and it is UNDER-reach
// (silence) rather than over-reach — the direction this module's header commits to.
//
// THE `.claude/audit-fixtures/**` GLOB AND THIS WITHDRAWAL CANCEL EXACTLY, AND THE PAIR IS
// DELIBERATE — DO NOT "SIMPLIFY" EITHER HALF. MEASURED on this tree: that glob matches 4879
// files, this withdrawal removes 4879, and the module's in-scope set is 1023 either way. The
// two halves answer DIFFERENT questions for DIFFERENT consumers, which is why both are needed:
//   - the frontmatter glob is CLAUDE CODE's LOAD trigger — authoring a structural fixture is
//     exactly when the freeze-then-judge discipline should be in context, so the rule SHOULD
//     load there;
//   - this withdrawal is THIS MODULE's INSPECTION scope — a fixture payload is authored to
//     CONTAIN a planted pattern, so inspecting one manufactures a finding true of the fixture
//     and false of the repo.
// Delete the glob and the rule stops loading when fixtures are authored (a reachability
// regression, invisible). Delete the withdrawal and 4879 payload files enter an advisory's
// scope, including this guard's OWN negative controls — MEASURED without it: 10 findings, all
// inside `.claude/audit-fixtures/conformance-walk/`, and THREE of them on poles whose expected
// answer is SILENCE — `clean-coverage-separate-from-pass-rate.txt`, `floor-skip-heredoc-body.txt`
// and `floor-skip-non-test-file.txt`. (An earlier revision of this line said "two"; re-measured
// with the withdrawal removed on a scratch copy, the control confirming the replica path became
// in-scope, the count is three. Corrected rather than left, in the comment block of a guard whose
// whole subject is honest denominators.) An advisory that fires on its own answer key is the one
// that teaches an operator to switch it off.
//
// DECLARED BLIND CLASS, SIZED rather than gestured at (`instrument-discipline.md` MUST-3(a) +
// `conservation-gate.md` MUST-3). Real harness code IS silenced here, and an under-sized
// declaration on a coverage-honesty guard would be the fabricated-by-omission shape
// `conformance-walk.md` MUST-3 itself blocks. MEASURED over `git ls-files` on 2026-09-19:
//   - TWO roots, not one: `.claude/audit-fixtures/**` AND `.claude/variants/rs/audit-fixtures/**`
//     (12 tracked files, including a whole semantic sub-harness under `worktree-reclaim/`). The
//     segment test reaches both, which is WHY it is a segment test — but a reader cannot size a
//     blind spot whose second root is never named.
//   - 86 tracked `.mjs` files under those roots are NOT named `run.mjs` and are still harness
//     code: `_lib/arm-coverage.mjs`, `hook-fixture-runner.mjs`, the `*-scanner.mjs` family,
//     `coc-artifact-eval-coverage/coverage-run.mjs`, `handoff-completion/surface-run.mjs`.
//   - ONE path is RETRACTED from scope that was in scope BEFORE this change:
//     `.claude/audit-fixtures/scan-synced-disclosure/test-mjs-destination-flip/.claude/bin/
//     sample.test.mjs` matched `FALLBACK_TEST_GLOBS`'s `*.test.*`, a family this widening never
//     touched, and is now withdrawn because the segment test precedes ALL matchers. Declared per
//     `conservation-gate.md` MUST-1 as an element of the before/after delta; it is planted
//     payload, so the retraction is right on the merits — it was simply not free.
// A basename allowlist ("inspect `run.mjs`, skip the rest") is deliberately NOT the fix: that is
// exactly the naming-convention predicate this module's header names as the repo's recurring
// defect class, and the 86 files above are what it would miss. So this module does NOT inspect
// fixture trees at all, and its silence about them is the absence of an instrument, never an
// all-clear.
//
// TWO PROPERTIES OF THE TEST ITSELF, stated so a caller is not surprised:
//   - SEGMENT, not substring: `my-audit-fixtures-notes/e2e/x.test.js` stays IN scope (pinned by
//     U6). Basename-only matches are likewise untouched — `.claude/bin/run-audit-fixtures.mjs`
//     and `.claude/test-harness/ci-audit-fixtures.json` carry the token but not the segment.
//   - CASE-SENSITIVE, and the direction is the safe one. On a case-insensitive filesystem a path
//     typed `.claude/Audit-Fixtures/…` lands in the real tree yet keeps its typed case in `rel`,
//     so the withdrawal MISSES and the payload IS inspected. A case mismatch therefore cannot be
//     used to ESCAPE inspection — only to manufacture a false finding, which is the documented
//     mechanism by which an advisory earns the override reflex.
const FIXTURE_TREE_SEGMENT = "audit-fixtures";

// ── masking ──────────────────────────────────────────────────────────────────

/**
 * Blank every string literal and comment, delimiters included, preserving length and newlines so
 * line numbers and offsets still resolve. Single- and double-quoted spans are LINE-BOUNDED: an
 * unterminated `'` on a line is treated as an ordinary character, which is what keeps a Rust
 * lifetime (`&'a str`) from opening a span that swallows the rest of the file. Backticks and
 * triple-quotes are multi-line, because template literals and docstrings genuinely are.
 */
function maskLiteralsAndComments(text) {
  if (typeof text !== "string" || text === "") return "";
  const n = text.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = text[i];

  const blank = (from, to) => {
    for (let i = from; i < to && i < n; i++) if (out[i] !== "\n") out[i] = " ";
  };
  const lineEnd = (from) => {
    const j = text.indexOf("\n", from);
    return j === -1 ? n : j;
  };

  let i = 0;
  while (i < n) {
    const c = text[i];
    const c2 = text.slice(i, i + 2);
    const c3 = text.slice(i, i + 3);

    // Line comments. `#[` is a Rust/attribute sigil, never a comment; `#!` is a shebang.
    if (c2 === "//" || (c === "#" && text[i + 1] !== "[" && text[i + 1] !== "!")) {
      const e = lineEnd(i);
      blank(i, e);
      i = e;
      continue;
    }
    if (c2 === "/*") {
      const close = text.indexOf("*/", i + 2);
      const e = close === -1 ? n : close + 2;
      blank(i, e);
      i = e;
      continue;
    }
    if (c3 === '"""' || c3 === "'''") {
      const close = text.indexOf(c3, i + 3);
      const e = close === -1 ? n : close + 3;
      blank(i, e);
      i = e;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      while (j < n && !(text[j] === "`" && text[j - 1] !== "\\")) j++;
      const e = Math.min(j + 1, n);
      blank(i, e);
      i = e;
      continue;
    }
    if (c === '"' || c === "'") {
      const stop = lineEnd(i);
      let j = i + 1;
      let closed = false;
      while (j < stop) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === c) {
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) {
        i++; // lone quote — a lifetime, an apostrophe in prose. Not a span.
        continue;
      }
      blank(i, j + 1);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** Heredoc bodies are DATA. Required from the shared module; never copied, never edited. */
function stripHeredocs(text) {
  try {
    const { stripHeredocBodies } = require("./violation-patterns.js");
    if (typeof stripHeredocBodies !== "function") return text;
    const out = stripHeredocBodies(text);
    return typeof out === "string" ? out : text;
  } catch {
    return text; // fail OPEN to the raw text — a smaller true answer, never a false clean
  }
}

// ── scope ────────────────────────────────────────────────────────────────────

function globToRegExp(glob) {
  let g = String(glob).trim();
  if (!g) return null;
  if (g.endsWith("/")) g += "**";
  if (!g.startsWith("**") && !g.startsWith("/")) g = "**/" + g;
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === "*") {
      if (g[i + 1] === "*") {
        if (g[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
      continue;
    }
    re += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  try {
    return new RegExp("^" + re + "$");
  } catch {
    return null;
  }
}

function parseFrontmatterPaths(md) {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  if (!m) return [];
  const block = /(^|\n)paths:\s*\n((?:\s*-\s*.*\n?)+)/.exec(m[1]);
  if (!block) return [];
  return block[2]
    .split("\n")
    .map((l) => /^\s*-\s*"?([^"]+?)"?\s*$/.exec(l))
    .filter(Boolean)
    .map((x) => x[1]);
}

function parseTestFileConvention(md) {
  const line = /Test files excluded:\*{0,2}\s*([^\n]+)/.exec(md);
  if (!line) return [];
  return (line[1].match(/`([^`]+)`/g) || []).map((t) => t.slice(1, -1));
}

/**
 * The ONE disk-touching function. Never throws: every read failure degrades that source to its
 * declared fallback and records it on `sources`.
 */
function readScopeAuthority(projectDir) {
  const sources = [];
  let ruleGlobs = null;
  let testGlobs = null;
  try {
    const md = fs.readFileSync(
      path.join(projectDir, ".claude", "rules", "conformance-walk.md"),
      "utf8",
    );
    const p = parseFrontmatterPaths(md);
    if (p.length) {
      ruleGlobs = p;
      sources.push("conformance-walk.md:frontmatter.paths");
    }
  } catch {}
  try {
    const md = fs.readFileSync(path.join(projectDir, ".claude", "rules", "zero-tolerance.md"), "utf8");
    const t = parseTestFileConvention(md);
    if (t.length) {
      testGlobs = t;
      sources.push("zero-tolerance.md:Rule-6-test-file-convention");
    }
  } catch {}
  const derived = ruleGlobs !== null && testGlobs !== null;
  if (!ruleGlobs) {
    ruleGlobs = FALLBACK_RULE_GLOBS;
    sources.push("FALLBACK_RULE_GLOBS(hand-listed)");
  }
  if (!testGlobs) {
    testGlobs = FALLBACK_TEST_GLOBS;
    sources.push("FALLBACK_TEST_GLOBS(hand-listed)");
  }
  return buildAuthority(ruleGlobs, testGlobs, derived, sources);
}

function buildAuthority(ruleGlobs, testGlobs, derived, sources) {
  const all = [...ruleGlobs, ...testGlobs];
  return {
    derived: Boolean(derived),
    sources: sources || [],
    globs: all,
    matchers: all.map(globToRegExp).filter(Boolean),
  };
}

/** The declared-fallback authority, for fixtures and for a corpus-less consumer. */
function fallbackAuthority() {
  return buildAuthority(FALLBACK_RULE_GLOBS, FALLBACK_TEST_GLOBS, false, [
    "FALLBACK_RULE_GLOBS(hand-listed)",
    "FALLBACK_TEST_GLOBS(hand-listed)",
  ]);
}

/**
 * CONTRACT FOR EXTERNAL CALLERS: `rel` MUST already be repo-relative and `..`-free. This function
 * normalizes backslashes and ONE leading `./` and REFUSES a `..`-leading path, but it does not
 * RESOLVE interior `..`, so `.claude/audit-fixtures/../hooks/real-guard.js` is withdrawn although
 * it names an in-scope file. Not a live bypass — the shipped caller
 * (`floor-only-assertion-guard.js`) does `path.join(PROJECT_DIR, filePath)` then `path.relative`,
 * which collapses `..` before this predicate is reached — but the predicate is EXPORTED for reuse,
 * so the obligation is stated here rather than left to be rediscovered.
 */
function isInScopePath(rel, authority) {
  if (!rel || !authority || !authority.matchers || !authority.matchers.length) return false;
  const p = String(rel).replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p || p.startsWith("..")) return false;
  // Fixture trees are DATA for other detectors. Withdrawn BEFORE any matcher runs, by segment,
  // so it holds at any depth. See FIXTURE_TREE_SEGMENT above for the measurement and the
  // declared blind class this buys.
  if (p.split("/").includes(FIXTURE_TREE_SEGMENT)) return false;
  return authority.matchers.some((rx) => rx.test(p));
}

// ── family (1): floor-only assertions ────────────────────────────────────────

const CASE_START = [
  /^\s*(?:it|test)\s*(?:\.\s*\w+\s*(?:\([^)]*\))?)?\s*\(/, //          JS/TS: it( test( it.skip( test.each(...)(
  /^\s*(?:async\s+)?def\s+test\w*\s*\(/, //                            Python
  /^\s*(?:pub\s+)?(?:async\s+)?fn\s+\w+\s*\(/, //                      Rust (gated on a preceding #[test])
  /^\s*func\s+Test\w*\s*\(/, //                                        Go
];
const RUST_TEST_ATTR = /^\s*#\[\s*(?:\w+\s*::\s*)?(?:test|rstest|tokio\s*::\s*test)\b/;

const FLOOR_PATTERNS = [
  // The status floor — "it returned something that wasn't a 5xx" is not a contract.
  /\b(?:status|status_code|statusCode|statusCode|code)\s*<=?\s*(?:499|500|599|600)\b/,
  // Tautologies, across the three languages the brief names.
  /\bassert\s*\(\s*(?:true|True|1)\s*\)/,
  /\bassert(?:_eq)?\s*!\s*\(\s*true\s*(?:,\s*true\s*)?\)/,
  /\bassert(?:True|_true)\s*\(\s*(?:True|true|1)\s*\)/,
  /\bassert\s+True\b\s*(?:,|;|$)/m,
  /\bexpect\s*\(\s*(?:true|True|1)\s*\)\s*\.\s*(?:toBe|toEqual|toBeTruthy|toBeTrue)\s*\(\s*(?:true|True|1)?\s*\)/,
  /\bassert\s*\.\s*(?:ok|isOk|isTrue)\s*\(\s*(?:1|true|True)\s*\)/,
  // A LONE existence probe: "something came back". Floor by itself; harmless beside a real one.
  /\bexpect\s*\([^)]*\)\s*\.\s*toBeDefined\s*\(\s*\)/,
];

const ASSERTION_CALL =
  /\bexpect\s*\(|\bassert\w*\s*[!(.]|\bassert\s+\S|\bEXPECT_\w+\s*\(|\.\s*should\s*[.(]/g;

/**
 * @returns {{floor:boolean, real:boolean, calls:number}}
 *
 * The floor and the assertion CALL are counted separately, because the floor is usually WRAPPED in
 * an assertion call — `expect(res.status < 500).toBe(true)` is one call, and stripping the `status
 * < 500` span alone would leave an `expect(` behind and score the line REAL, which is exactly
 * backwards. So: a line carrying a floor is REAL only if it carries a SECOND assertion call
 * (`assert(true); assertEqual(x, 3)`); a line with no floor is REAL if it carries any call at all.
 */
function classifyAssertionLine(line) {
  if (typeof line !== "string" || !line.trim()) return { floor: false, real: false, calls: 0 };
  const floor = FLOOR_PATTERNS.some((rx) => rx.test(line));
  ASSERTION_CALL.lastIndex = 0;
  const calls = (line.match(ASSERTION_CALL) || []).length;
  return { floor, real: floor ? calls > 1 : calls >= 1, calls };
}

/** Segment masked text into cases. See the header for how this bound is weak. */
function splitCases(maskedText) {
  const lines = String(maskedText).split("\n");
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    for (let k = 0; k < CASE_START.length; k++) {
      if (!CASE_START[k].test(l)) continue;
      // The bare-`fn` shape is Rust and only counts under a test attribute above it.
      if (k === 2) {
        const prev = lines.slice(Math.max(0, i - 3), i);
        if (!prev.some((p) => RUST_TEST_ATTR.test(p))) continue;
      }
      starts.push({ index: i, name: caseName(l) });
      break;
    }
  }
  return starts.map((s, idx) => ({
    name: s.name,
    startLine: s.index + 1,
    endLine: idx + 1 < starts.length ? starts[idx + 1].index : lines.length,
    body: lines.slice(s.index, idx + 1 < starts.length ? starts[idx + 1].index : lines.length),
  }));
}

function caseName(line) {
  // The declared identifier wins on a `def`/`fn`/`func` case — reading the first parenthesised
  // token there names the FIXTURE PARAMETER (`reporter`), not the case.
  const fn = /\b(?:def|fn|func)\s+(\w+)/.exec(line);
  if (fn) return fn[1];
  const q = /\(\s*([A-Za-z0-9_\- .]{3,60})\s*[,)]/.exec(line);
  if (q && q[1].trim()) return q[1].trim();
  return line.trim().slice(0, 60);
}

function detectFloorOnlyAssertions(maskedText) {
  const findings = [];
  for (const c of splitCases(maskedText)) {
    let floorLine = null;
    let floorCount = 0;
    let realCount = 0;
    for (let i = 0; i < c.body.length; i++) {
      const v = classifyAssertionLine(c.body[i]);
      if (v.real) realCount++;
      if (v.floor) {
        floorCount++;
        if (floorLine === null) floorLine = { n: c.startLine + i, text: c.body[i] };
      }
    }
    if (floorCount >= 1 && realCount === 0) {
      findings.push({
        rule_id: FINDING_FLOOR,
        severity: SEVERITY,
        line: floorLine.n,
        evidence:
          `case "${bound(c.name, 48)}" (line ${c.startLine}) asserts only the FLOOR: ` +
          `\`${bound(floorLine.text.trim(), 80)}\``,
      });
    }
  }
  return findings;
}

// ── family (2): hand-listed denominators ─────────────────────────────────────

const DENOM_NAME =
  /^(?:total|totals|total_cases|totalcases|total_units|totalunits|total_count|denominator|expected_total|expectedtotal|unit_count|unitcount|case_count|casecount|num_cases|numcases|n_cases|coverage_total|coveragetotal)$/i;

const ASSIGN_RX =
  /(?:^|[^\w.$])(?:const|let|var|static|final|pub\s+const|pub\s+static)?\s*([A-Za-z_][\w]*)\s*(?::\s*[\w<>:]+\s*)?=\s*(\d+)\b/g;
const RATIO_RX =
  /\b(coverage|coverage_pct|coveragePct|pass_rate|passRate|covered|pct)\s*=\s*[^=\n;]*?\/\s*(\d+)\b/g;

function isAccumulator(maskedText, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `\\b${esc}\\s*(?:\\+\\+|\\+=|-=)|\\b${esc}\\s*=\\s*${esc}\\s*[+\\-]`,
  ).test(maskedText);
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function detectHandListedDenominators(maskedText) {
  const findings = [];
  const text = String(maskedText);

  ASSIGN_RX.lastIndex = 0;
  let m;
  while ((m = ASSIGN_RX.exec(text)) !== null) {
    const [, name, valueRaw] = m;
    if (!DENOM_NAME.test(name)) continue;
    const value = Number(valueRaw);
    if (!Number.isFinite(value) || value < 1) continue; // `= 0` is an accumulator seed
    if (isAccumulator(text, name)) continue; //            later `+=` ⇒ a counter, not a denominator
    findings.push({
      rule_id: FINDING_DENOM,
      severity: SEVERITY,
      line: lineOf(text, m.index),
      evidence:
        `coverage denominator \`${bound(name, 40)}\` is TYPED as the literal ${valueRaw}, not ` +
        `derived from what the run enumerated (\`cases.length\` / \`len(cases)\` / \`results.len()\`)`,
    });
  }

  RATIO_RX.lastIndex = 0;
  while ((m = RATIO_RX.exec(text)) !== null) {
    findings.push({
      rule_id: FINDING_DENOM,
      severity: SEVERITY,
      line: lineOf(text, m.index),
      evidence:
        `\`${bound(m[1], 40)}\` is divided by the literal ${m[2]} — a hand-listed denominator; ` +
        `divide by the enumerated unit count instead`,
    });
  }

  return findings;
}

// ── composition ──────────────────────────────────────────────────────────────

function bound(s, max) {
  const t = String(s == null ? "" : s)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/**
 * @param {{filePath?:string, rel:string, text:string, authority:object}} input
 * @returns {Array<{rule_id:string, severity:string, line:number, evidence:string}>}
 */
function inspectFile(input) {
  const o = input && typeof input === "object" ? input : {};
  const rel = o.rel || o.filePath || "";
  const text = typeof o.text === "string" ? o.text : "";
  const authority = o.authority || fallbackAuthority();
  if (!rel || !text) return []; //                 absent field ⇒ UNKNOWN ⇒ fail open
  if (!isInScopePath(rel, authority)) return []; // out of scope ⇒ silent by construction

  let masked;
  try {
    masked = maskLiteralsAndComments(stripHeredocs(text));
  } catch {
    return []; // a masker that throws must not produce findings from unmasked text
  }

  const findings = [];
  try {
    findings.push(...detectFloorOnlyAssertions(masked));
  } catch {}
  try {
    findings.push(...detectHandListedDenominators(masked));
  } catch {}
  return findings.sort((a, b) => a.line - b.line);
}

module.exports = {
  SEVERITY,
  FINDING_FLOOR,
  FINDING_DENOM,
  FALLBACK_TEST_GLOBS,
  FALLBACK_RULE_GLOBS,
  FIXTURE_TREE_SEGMENT,
  // Exported for the fixture runner's U5 mirror-parity case ONLY — it is the ONE way to compare
  // FALLBACK_RULE_GLOBS against the frontmatter it copies without re-implementing the parse
  // (`specs-authority.md` Rule 9: cite the authority, never retype it).
  parseFrontmatterPaths,
  parseTestFileConvention,
  maskLiteralsAndComments,
  stripHeredocs,
  globToRegExp,
  readScopeAuthority,
  fallbackAuthority,
  buildAuthority,
  isInScopePath,
  classifyAssertionLine,
  splitCases,
  detectFloorOnlyAssertions,
  detectHandListedDenominators,
  inspectFile,
  bound,
};
