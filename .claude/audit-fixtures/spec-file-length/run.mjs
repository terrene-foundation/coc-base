#!/usr/bin/env node
/**
 * Bipolar fixtures for `.claude/bin/check-spec-file-length.mjs`.
 *
 * Every arm is a POLE PAIR: an input the gate must flag and a near-miss input it
 * must pass, differing in the ONE property under test. A gate that reds on
 * everything is not a gate — and each RED here asserts a failure IDENTITY
 * (`spec-file-length/...`) or a named field, NEVER a bare non-zero exit
 * (`instrument-bipolarity.md` MUST-2). A RED that only checks "exit != 0" passes
 * for a crash, a typo'd path, or a missing file, and is not evidence.
 *
 * § END-TO-END is the NEGATIVE CONTROL that runs WHERE THE GATE RUNS
 * (`verification-gate-integrity.md` MUST-1): it drives the real
 * `runSpecFileLength` over real directories on the real filesystem, not a stubbed
 * resolver. The pure-function arms above it are fast and precise but could all
 * pass while the actual walk reached nothing — which is the shape these arms
 * exist to rule out.
 */

"use strict";

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  parseCapFromRule,
  effectiveCap,
  countLines,
  assess,
  classifySpecRoot,
  runSpecFileLength,
  DOCUMENTED_SPEC_LINE_CAP,
  EXIT,
} from "../../bin/check-spec-file-length.mjs";

let passed = 0;
let failed = 0;
// Emit ONE line per case in the shape `run-audit-fixtures.mjs` parses
// (`/^[ \t]*(?:PASS|ok)[ \t]+\S/`). Printing only on failure looks fine when the
// file is run directly while the CI runner counts ZERO cases and reds against its
// min_cases floor — the same absence-reads-as-clean shape this gate exists for.
function check(name, actual, expected) {
  if (String(actual) === String(expected)) {
    passed += 1;
    process.stdout.write(`  PASS  ${name} → ${String(actual)}\n`);
  } else {
    failed += 1;
    process.stdout.write(
      `  FAIL  ${name} → got ${JSON.stringify(String(actual))}, want ${JSON.stringify(String(expected))}\n`,
    );
  }
}

/** Build a throwaway tree and hand its root to `fn`. */
function withTree(spec, fn) {
  const root = mkdtempSync(join(tmpdir(), "spec-file-length-fx-"));
  try {
    for (const [rel, body] of Object.entries(spec)) {
      const abs = join(root, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, body, "utf8");
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Read a field off the FIRST finding without throwing when there is none.
 *
 * Load-bearing for mutation testing, not defensive habit: under a mutation that
 * suppresses findings, `r.findings[0].identity` throws and ABORTS the runner, so
 * every case after it never executes and its red-set is truncated. A truncated
 * red-set is indistinguishable from a small one — the mutation looks weaker than
 * it is. Returning a sentinel keeps each case reporting its own verdict.
 */
function f0(r, key) {
  return at0(r.findings, key);
}

/**
 * Read `key` off the FIRST element of any findings-like array without throwing
 * when it is empty.
 *
 * GENERALISED from a single-array helper after the narrow version failed to cover
 * its siblings: a mutation restoring the silent `catch` in `listSpecFiles` left
 * `walkErrors` empty, `walkErrors[0].scope` threw, the runner ABORTED, and the
 * red-set read as ONE failure when the real figure was larger. A truncated
 * red-set is indistinguishable from a small one, so the mutation looks weaker
 * than it is — which would have understated the very defect under test.
 */
function at0(arr, key) {
  return !Array.isArray(arr) || arr.length === 0 ? "(empty)" : arr[0][key];
}

// A NOTE ON THE `*-not-ok` CASES, which assert a RELATION (`exit !== EXIT.OK`)
// rather than a value. `instrument-bipolarity.md` MUST-2 names a bare relation as
// weak evidence, and on its own it would be: it passes for any non-zero, a crash
// included. Every one of them is therefore PAIRED with an exact-value pin on the
// line immediately above (`... → EXIT.UNMEASURED`), and the relation case is kept
// deliberately alongside it because it names the specific regression DIRECTION
// this suite exists to prevent — a silent exit 0. The pin carries the evidence;
// the relation carries the intent. Neither stands alone.

/** A markdown body of exactly `n` lines (n newlines, trailing terminator). */
function linesOf(n) {
  return n === 0 ? "" : `${Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
}

/** A synthetic `specs-authority.md` declaring `cap` as Rule 8's threshold. */
function ruleDeclaring(cap) {
  return [
    "### 8. Large Spec Files Are Split",
    "",
    `When a spec file exceeds ${cap} lines, it MUST be split into sub-domain files and \`_index.md\` updated.`,
    "",
  ].join("\n");
}

// ---- (a) THE THRESHOLD IS READ, NOT ASSUMED -----------------------------
// The whole point of parsing Rule 8's own sentence is that the gate cannot
// silently disagree with the rule. These arms prove the number genuinely comes
// FROM the text — a hardcoded 300 would pass the first case and fail the second.
check("cap:reads-rule-sentence", parseCapFromRule(ruleDeclaring(300)), 300);
check("cap:rule-value-wins-not-hardcode", parseCapFromRule(ruleDeclaring(77)), 77);
check("cap:effective-uses-rule-value", effectiveCap(ruleDeclaring(77)).cap, 77);
check("cap:effective-marks-rule-readable", effectiveCap(ruleDeclaring(300)).readable, "true");
check("cap:source-is-rule", effectiveCap(ruleDeclaring(300)).source, "rule");
// RED pole: a REWORDED rule must NOT silently match some other number nearby.
// Failing to parse is the correct, loud outcome; a loose matcher would return a
// confident wrong cap.
check("cap:reworded-rule-does-not-match", parseCapFromRule("Specs should stay under 300 lines."), "null");
check("cap:unrelated-300-not-harvested", parseCapFromRule("a validator declared 300 lines away in main"), "null");
check("cap:non-string-rejected", parseCapFromRule(null), "null");
check("cap:zero-rejected", parseCapFromRule(ruleDeclaring(0)), "null");
// FAIL LOUD, STILL MEASURE: an unreadable rule falls back to the documented
// value and SAYS which branch it took — never a silent pass.
check("failclosed:unreadable-uses-documented", effectiveCap(null).cap, DOCUMENTED_SPEC_LINE_CAP);
check("failclosed:unreadable-marked", effectiveCap(null).readable, "false");
check("failclosed:unreadable-source-named", effectiveCap(null).source, "documented-default-rule-unreadable");
check("failclosed:unparsed-source-named", effectiveCap("# some other rule\n").source, "documented-default-rule-unparsed");

// ---- (b) COUNTING MATCHES THE READER'S `wc -l` --------------------------
check("count:trailing-newline-matches-wc", countLines("a\nb\nc\n"), 3);
// RED-adjacent pole: no trailing terminator. `wc -l` under-counts here and this
// must not, or a 301-line file with no final newline would slip the cap.
check("count:no-trailing-newline-counts-last", countLines("a\nb\nc"), 3);
check("count:empty-is-zero", countLines(""), 0);
check("count:single-line-no-newline", countLines("only"), 1);
check("count:exactly-300", countLines(linesOf(300)), 300);
check("count:exactly-301", countLines(linesOf(301)), 301);

// ---- (c) THE BOUNDARY IS EXACT — "exceeds" IS STRICTLY GREATER ----------
// Rule 8 says "exceeds 300 lines". 300 is compliant; 301 is not. An off-by-one
// here either reds a conforming file or lets a breaching one through.
{
  const over = assess({ lines: 301, cap: 300 });
  check("boundary:301-identity", over.identity, "spec-file-length/exceeds-cap");
  check("boundary:301-verdict", over.verdict, "EXCEEDS");
  check("boundary:301-over-by-one", over.over, 1);
  // GREEN twin: one line fewer, same cap, differing ONLY in the property tested.
  const at = assess({ lines: 300, cap: 300 });
  check("boundary:300-is-ok-not-exceeds", at.verdict, "OK");
  check("boundary:300-identity", at.identity, "spec-file-length/ok");
  check("boundary:299-is-ok", assess({ lines: 299, cap: 300 }).verdict, "OK");
  // The real finding on this corpus, pinned by value.
  const real = assess({ lines: 310, cap: 300 });
  check("boundary:real-corpus-over-by-ten", real.over, 10);
  check("boundary:real-corpus-identity", real.identity, "spec-file-length/exceeds-cap");
  // Identities are DISTINCT — a collapsed verdict space hides the breach.
  check(
    "boundary:identities-distinct",
    String(assess({ lines: 1, cap: 300 }).identity !== assess({ lines: 999, cap: 300 }).identity),
    "true",
  );
}

// ---- (d) THE ROOT ALLOWLIST IS POSITIVE AND FAILS CLOSED ----------------
check("roots:repo-root-governed", classifySpecRoot("specs").governed, "true");
check("roots:repo-root-kind", classifySpecRoot("specs").kind, "repo-root");
check("roots:docs-specs-governed", classifySpecRoot("docs/specs").governed, "true");
check("roots:workspace-governed", classifySpecRoot("workspaces/coc-universal/specs").governed, "true");
check("roots:workspace-kind", classifySpecRoot("workspaces/coc-universal/specs").kind, "workspace");
check("roots:archived-workspace-governed", classifySpecRoot("workspaces/_archive/foo/specs").governed, "true");
check("roots:template-governed", classifySpecRoot(".claude/templates/specs").governed, "true");
check("roots:template-kind", classifySpecRoot(".claude/templates/specs").kind, "template");
// RED poles. The fixture tree is refused for a NAMED reason, not silently.
{
  const fx = classifySpecRoot(".claude/audit-fixtures/spec-corpus-conformance/violation-orphan-citation/specs");
  check("roots:fixture-tree-refused", fx.governed, "false");
  check("roots:fixture-refusal-names-reason", String(fx.reason.includes("audit-fixtures")), "true");
}
// An UNRECOGNISED location is refused too — the allowlist fails closed rather
// than admitting anything that merely happens to be named `specs`.
check("roots:unknown-location-refused", classifySpecRoot("vendor/thirdparty/specs").governed, "false");
check("roots:bare-workspaces-specs-refused", classifySpecRoot("workspaces/specs").governed, "false");
check("roots:node-modules-refused", classifySpecRoot("node_modules/pkg/specs").governed, "false");

// ---- (e) END-TO-END: the negative control, run WHERE THE GATE RUNS ------
// Real filesystem, real walk, real read. Each pair below differs in exactly one
// property, and every RED asserts an identity or a named field.
{
  // RED pole: one spec one line over the cap.
  const red = withTree(
    {
      ".claude/rules/specs-authority.md": ruleDeclaring(300),
      "specs/_index.md": linesOf(5),
      "specs/oversized.md": linesOf(301),
    },
    (root) => runSpecFileLength({ root }),
  );
  check("e2e:red-exit-is-exceeds", red.exit, EXIT.EXCEEDS);
  check("e2e:red-one-finding", red.findings.length, 1);
  check("e2e:red-identity", f0(red, "identity"), "spec-file-length/exceeds-cap");
  check("e2e:red-names-the-file", f0(red, "rel"), "specs/oversized.md");
  check("e2e:red-reports-line-count", f0(red, "lines"), 301);
  check("e2e:red-reports-overage", f0(red, "over"), 1);
  check("e2e:red-read-both-files", red.files, 2);

  // GREEN twin: byte-identical tree except the file is 300 lines, not 301.
  const green = withTree(
    {
      ".claude/rules/specs-authority.md": ruleDeclaring(300),
      "specs/_index.md": linesOf(5),
      "specs/oversized.md": linesOf(300),
    },
    (root) => runSpecFileLength({ root }),
  );
  check("e2e:green-exit-ok", green.exit, EXIT.OK);
  check("e2e:green-no-findings", green.findings.length, 0);
  check("e2e:green-still-read-the-files", green.files, 2);
}
{
  // THE ANTI-HARDCODE END-TO-END CONTROL. The same 60-line spec is a BREACH under
  // a rule declaring 50 and CLEAN under one declaring 300. If the gate carried a
  // private 300, the first arm would return OK and this pair would fail — which
  // is the only way to show the threshold is genuinely read in a full run.
  const tight = withTree(
    { ".claude/rules/specs-authority.md": ruleDeclaring(50), "specs/d.md": linesOf(60) },
    (root) => runSpecFileLength({ root }),
  );
  check("e2e:cap-from-rule-tight-cap-reds", tight.exit, EXIT.EXCEEDS);
  check("e2e:cap-from-rule-tight-cap-value", tight.cap, 50);
  check("e2e:cap-from-rule-tight-identity", f0(tight, "identity"), "spec-file-length/exceeds-cap");
  const loose = withTree(
    { ".claude/rules/specs-authority.md": ruleDeclaring(300), "specs/d.md": linesOf(60) },
    (root) => runSpecFileLength({ root }),
  );
  check("e2e:cap-from-rule-loose-cap-green", loose.exit, EXIT.OK);
  check("e2e:cap-from-rule-loose-cap-value", loose.cap, 300);
}
{
  // FALLBACK still MEASURES: no rule file at all -> documented cap, marked
  // unreadable, and the breach is STILL found. An unreadable rule must not
  // convert a breaching corpus into a clean one.
  const noRule = withTree({ "specs/d.md": linesOf(400) }, (root) => runSpecFileLength({ root }));
  check("e2e:no-rule-still-finds-breach", noRule.exit, EXIT.EXCEEDS);
  check("e2e:no-rule-marks-unreadable", noRule.capReadable, "false");
  check("e2e:no-rule-uses-documented-cap", noRule.cap, DOCUMENTED_SPEC_LINE_CAP);
  check("e2e:no-rule-identity", f0(noRule, "identity"), "spec-file-length/exceeds-cap");
}
{
  // ZERO INPUT IS NOT ZERO FINDINGS. Both arms must be UNMEASURED, not OK —
  // exit 0 here would convert an unread corpus into a false green.
  const noTree = withTree({ "README.md": linesOf(3) }, (root) => runSpecFileLength({ root }));
  check("e2e:no-spec-root-is-unmeasured", noTree.exit, EXIT.UNMEASURED);
  check("e2e:no-spec-root-not-ok", String(noTree.exit !== EXIT.OK), "true");
  check("e2e:no-spec-root-zero-roots", noTree.roots.length, 0);

  const emptyTree = withTree({ "specs/.keep": "" }, (root) => runSpecFileLength({ root }));
  check("e2e:empty-spec-root-is-unmeasured", emptyTree.exit, EXIT.UNMEASURED);
  check("e2e:empty-spec-root-found-the-root", emptyTree.roots.length, 1);
  check("e2e:empty-spec-root-read-nothing", emptyTree.files, 0);
}
{
  // THE EXCLUSION IS REAL AND IS REPORTED. A tree whose ONLY `specs` dir sits
  // under `.claude/audit-fixtures/` yields NO governed root — and the refusal is
  // surfaced with its reason rather than silently dropped, so a reader can see
  // the tree was considered.
  const fxOnly = withTree(
    { ".claude/audit-fixtures/spec-corpus-conformance/violation-x/specs/d.md": linesOf(999) },
    (root) => runSpecFileLength({ root }),
  );
  check("e2e:fixture-only-tree-unmeasured", fxOnly.exit, EXIT.UNMEASURED);
  check("e2e:fixture-only-no-governed-roots", fxOnly.roots.length, 0);
  check("e2e:fixture-only-refusal-reported", fxOnly.refused.length, 1);
  check("e2e:fixture-only-refusal-has-reason", String(String(at0(fxOnly.refused, "reason")).includes("audit-fixtures")), "true");
  // And the GREEN twin proving the exclusion is about LOCATION, not content: the
  // identical 999-line file under a governed root DOES red.
  const governed = withTree({ "specs/d.md": linesOf(999) }, (root) => runSpecFileLength({ root }));
  check("e2e:same-file-under-governed-root-reds", governed.exit, EXIT.EXCEEDS);
  check("e2e:same-file-governed-identity", f0(governed, "identity"), "spec-file-length/exceeds-cap");
}
{
  // WORKSPACE + TEMPLATE roots are really walked, not just allowlisted in theory.
  const ws = withTree(
    {
      ".claude/rules/specs-authority.md": ruleDeclaring(300),
      "workspaces/proj/specs/deep/nested.md": linesOf(301),
      ".claude/templates/specs/scaffold.md": linesOf(10),
    },
    (root) => runSpecFileLength({ root }),
  );
  check("e2e:workspace-root-walked", ws.exit, EXIT.EXCEEDS);
  check("e2e:workspace-finding-path", f0(ws, "rel"), "workspaces/proj/specs/deep/nested.md");
  check("e2e:workspace-finding-kind", f0(ws, "kind"), "workspace");
  check("e2e:template-root-admitted", String(ws.roots.some((r) => r.kind === "template")), "true");
  check("e2e:both-roots-read", ws.files, 2);
  // The READ SET is EMITTED, not typed (`instrument-discipline.md` MUST-6(c)) —
  // whoever later cites "N spec files" can re-derive which ones they were.
  check("e2e:read-set-is-emitted", ws.readSet.length, 2);
  check("e2e:read-set-carries-counts", String(ws.readSet.some((r) => r.endsWith(":301"))), "true");
}

// ---- (f) THE FAILURE PATHS — an untested failure path is an unenforced claim --
//
// These three branches were the gate's own blind spot, and the shape is the one
// this gate exists to catch: the checker COLLECTED walk errors, RETURNED them,
// and PRINTED a warning — while the exit code said 0. CI reads the exit code, not
// the warning. A run that knew it had under-measured reported success.
//
// Covered twice over, deliberately. The INJECTED arm replaces only the leaf
// syscall, so every line of walk/classify/record logic under test is the code the
// corpus run executes (`instrument-discipline.md` MUST-4) and the case is
// deterministic on any filesystem and any uid. The CHMOD arm below then runs the
// same branches against the REAL filesystem — the negative control that runs
// where the gate runs (`verification-gate-integrity.md` MUST-1).
{
  // A readdir that fails ONLY at a named subtree, so the failure is scoped rather
  // than global — a global throw would also empty the population and could red
  // via the zero-input branch instead of the branch under test.
  const failingReaddirAt = (needle, real) => (dir, opts) => {
    if (String(dir).includes(needle)) {
      const err = new Error("synthetic EACCES");
      err.code = "EACCES";
      throw err;
    }
    return real(dir, opts);
  };
  const { readdirSync } = nodeFs;

  // (f1) DISCOVERY-scope walk error. The tree is otherwise clean and under cap.
  const disc = withTree(
    {
      ".claude/rules/specs-authority.md": ruleDeclaring(300),
      "specs/fine.md": linesOf(10),
      "workspaces/locked/specs/also-fine.md": linesOf(10),
    },
    (root) => runSpecFileLength({ root, readdir: failingReaddirAt("workspaces", readdirSync) }),
  );
  check("fail:discovery-error-recorded", disc.walkErrors.length, 1);
  check("fail:discovery-error-scope", at0(disc.walkErrors, "scope"), "discovery");
  check("fail:discovery-error-code", at0(disc.walkErrors, "code"), "EACCES");
  // THE FINDING-A POLE. Every file this run DID read was under the cap, so the
  // pre-fix gate returned 0 here. A partial walk cannot support "nothing exceeds".
  check("fail:discovery-error-is-unmeasured-not-ok", disc.exit, EXIT.UNMEASURED);
  check("fail:discovery-error-not-exit-zero", String(disc.exit !== EXIT.OK), "true");
  // GREEN twin: byte-identical tree, readdir that never fails -> OK.
  const discOk = withTree(
    {
      ".claude/rules/specs-authority.md": ruleDeclaring(300),
      "specs/fine.md": linesOf(10),
      "workspaces/locked/specs/also-fine.md": linesOf(10),
    },
    (root) => runSpecFileLength({ root }),
  );
  check("fail:clean-walk-is-ok", discOk.exit, EXIT.OK);
  check("fail:clean-walk-no-errors", discOk.walkErrors.length, 0);
  check("fail:clean-walk-read-both", discOk.files, 2);

  // (f2) FILE-LISTING-scope walk error — Finding B. The root IS admitted; a
  // subdirectory under it is unreadable, so its `.md` files vanish. Pre-fix this
  // was a bare `catch { return; }` leaving no trace anywhere.
  const listErr = withTree(
    {
      ".claude/rules/specs-authority.md": ruleDeclaring(300),
      "specs/visible.md": linesOf(10),
      "specs/nested/hidden.md": linesOf(10),
    },
    (root) => runSpecFileLength({ root, readdir: failingReaddirAt("nested", readdirSync) }),
  );
  check("fail:listing-error-recorded", listErr.walkErrors.length, 1);
  check("fail:listing-error-scope", at0(listErr.walkErrors, "scope"), "file-listing");
  check("fail:listing-error-names-subtree", String(String(at0(listErr.walkErrors, "path")).includes("nested")), "true");
  check("fail:listing-error-is-unmeasured", listErr.exit, EXIT.UNMEASURED);
  // The population really did shrink — 1 file read, not 2. This is what makes the
  // silent version dangerous: the count looks plausible.
  check("fail:listing-error-population-shrank", listErr.files, 1);
  // GREEN twin: same tree, working readdir -> both files read, OK.
  const listOk = withTree(
    {
      ".claude/rules/specs-authority.md": ruleDeclaring(300),
      "specs/visible.md": linesOf(10),
      "specs/nested/hidden.md": linesOf(10),
    },
    (root) => runSpecFileLength({ root }),
  );
  check("fail:listing-clean-reads-both", listOk.files, 2);
  check("fail:listing-clean-is-ok", listOk.exit, EXIT.OK);

  // (f3) UNREADABLE SPEC — wired to exit EXCEEDS, previously never exercised.
  const failingReadFile = (p, enc) => {
    if (String(p).endsWith("locked.md")) {
      const err = new Error("synthetic EACCES");
      err.code = "EACCES";
      throw err;
    }
    return nodeFs.readFileSync(p, enc);
  };
  const unread = withTree(
    {
      ".claude/rules/specs-authority.md": ruleDeclaring(300),
      "specs/open.md": linesOf(10),
      "specs/locked.md": linesOf(10),
    },
    (root) => runSpecFileLength({ root, readFile: failingReadFile }),
  );
  check("fail:unreadable-recorded", unread.unreadable.length, 1);
  check("fail:unreadable-names-file", at0(unread.unreadable, "rel"), "specs/locked.md");
  check("fail:unreadable-carries-code", at0(unread.unreadable, "code"), "EACCES");
  check("fail:unreadable-reds", unread.exit, EXIT.EXCEEDS);
  check("fail:unreadable-not-ok", String(unread.exit !== EXIT.OK), "true");
  // An unreadable spec is NOT counted as measured — it never enters the read set.
  check("fail:unreadable-not-counted-as-read", unread.files, 1);

  // (f4) PRECEDENCE: a real breach still reds as EXCEEDS even alongside a walk
  // error, so hardening the clean path did not swallow the actionable verdict.
  const both = withTree(
    {
      ".claude/rules/specs-authority.md": ruleDeclaring(300),
      "specs/oversized.md": linesOf(400),
      "workspaces/locked/specs/x.md": linesOf(10),
    },
    (root) => runSpecFileLength({ root, readdir: failingReaddirAt("workspaces", readdirSync) }),
  );
  check("fail:breach-outranks-walk-error", both.exit, EXIT.EXCEEDS);
  check("fail:breach-still-identified", f0(both, "identity"), "spec-file-length/exceeds-cap");
  check("fail:walk-error-still-recorded", both.walkErrors.length, 1);
}

// ---- (g) THE SAME BRANCHES ON THE REAL FILESYSTEM ------------------------
// `verification-gate-integrity.md` MUST-1. The injected arm above proves the
// LOGIC; this proves a real EACCES from a real permission bit reaches the same
// verdict. Guarded by a probe: as root, or on a filesystem that ignores mode
// bits, chmod grants nothing and a silent skip here would be a coverage claim
// this suite did not earn — so the probe result is PRINTED either way.
{
  const probe = (() => {
    const d = mkdtempSync(join(tmpdir(), "spec-file-length-chmodprobe-"));
    try {
      const sub = join(d, "locked");
      mkdirSync(sub);
      writeFileSync(join(sub, "a.md"), "x\n");
      chmodSync(sub, 0o000);
      try {
        nodeFs.readdirSync(sub);
        return { usable: false, reason: "readdir succeeded on a 0o000 directory" };
      } catch (err) {
        return { usable: true, reason: err.code || "threw" };
      } finally {
        chmodSync(sub, 0o755);
      }
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  })();

  check("chmod:probe-is-usable-instrument", probe.usable, "true");
  if (!probe.usable) {
    // NOT a silent skip. The suite says which coverage it lost and why, so the
    // degraded run is distinguishable from the full one.
    process.stdout.write(
      `  NOTE  chmod is not a usable instrument here (${probe.reason}); ` +
        "real-filesystem EACCES cases SKIPPED — the injected arm above still covers the logic.\n",
    );
  } else {
    const root = mkdtempSync(join(tmpdir(), "spec-file-length-real-"));
    const locked = join(root, "specs", "nested");
    try {
      mkdirSync(join(root, ".claude", "rules"), { recursive: true });
      writeFileSync(join(root, ".claude", "rules", "specs-authority.md"), ruleDeclaring(300), "utf8");
      mkdirSync(locked, { recursive: true });
      writeFileSync(join(root, "specs", "visible.md"), linesOf(10), "utf8");
      writeFileSync(join(locked, "hidden.md"), linesOf(10), "utf8");
      chmodSync(locked, 0o000);

      const real = runSpecFileLength({ root });
      check("chmod:real-eacces-recorded", real.walkErrors.length, 1);
      check("chmod:real-eacces-code", at0(real.walkErrors, "code"), "EACCES");
      check("chmod:real-eacces-scope", at0(real.walkErrors, "scope"), "file-listing");
      // The verdict that matters: a real permission bit produces UNMEASURED, not OK.
      check("chmod:real-eacces-is-unmeasured", real.exit, EXIT.UNMEASURED);
      check("chmod:real-eacces-not-ok", String(real.exit !== EXIT.OK), "true");

      // GREEN twin on the SAME tree: restore the mode bit, nothing else changes.
      chmodSync(locked, 0o755);
      const restored = runSpecFileLength({ root });
      check("chmod:restored-mode-is-ok", restored.exit, EXIT.OK);
      check("chmod:restored-mode-no-errors", restored.walkErrors.length, 0);
      check("chmod:restored-mode-reads-both", restored.files, 2);
    } finally {
      // Restore before removal or the cleanup itself fails on the locked dir.
      try {
        chmodSync(locked, 0o755);
      } catch {
        // Already restored by the happy path; nothing further is owed.
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
}

process.stdout.write(`\nspec-file-length fixtures: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
