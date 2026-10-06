#!/usr/bin/env node
/**
 * run.mjs — fixture battery for `.claude/hooks/block-evidence-guard.js` and its
 * predicate `.claude/hooks/lib/block-evidence-provenance.js`, the shipped detector
 * for `hook-output-discipline.md` MUST-5(a).
 *
 * WHAT IS UNDER TEST: the hook, end to end, spawned as a real process reading real
 * stdin and writing real stdout. The whole contract lives at the process boundary
 * (exit code, the `continue` field, the severity register on stderr, the report
 * body), so importing the predicate alone would test a different thing than the one
 * that ships. The predicate IS also imported directly, but only for the arms that
 * assert on its returned STATE (`parsed`, `examined`) — states the hook deliberately
 * converts to silence.
 *
 * BIPOLARITY IS THE POINT, and here it is sharper than usual: this detector's own
 * subject matter is detectors that mis-report their signal. A battery that only
 * proved it FIRES could not detect an over-firing guard, and an over-firing guard on
 * every hook edit is the one that gets switched off — which lands in the same place
 * as the silence it replaced. Every firing arm below carries its opposite pole, and
 * the poles are NEAR-MISSES by construction:
 *   - `block` + a parsed-field evidence   (CLEAN)  beside `block` + `m[0]`  (FLAG)
 *   - `halt-and-report` + `m[0]`          (CLEAN — the severity is what matters)
 *   - the same violation reached through an INTERMEDIATE BINDING (FLAG) — the case a
 *     same-line matcher cannot see, which is why the predicate is a lexer and not a
 *     regex.
 *
 * THE DECLARED BLIND CLASSES ARE PINNED, NOT DESCRIBED. ARM E asserts that each
 * class named in the predicate's header § WHAT IT CANNOT SEE really does produce a
 * MISS. A blind spot that is asserted-about but never asserted is a claim, not a
 * bound; when one of these arms starts FAILING, the header is what needs correcting.
 *
 * THE TREE IS BUILT SYNTHETICALLY, ONE FILE AT A TIME, IN A TEMP DIR. It is never a
 * recursive copy of the live `.claude/` tree, and nothing here writes to a tracked
 * file. Mutation mode rewrites only the COPY inside a throwaway tree.
 *
 * Usage:
 *   node .claude/audit-fixtures/parsed-signal-detector/run.mjs
 *   node .claude/audit-fixtures/parsed-signal-detector/run.mjs --mutation-check
 */
import "../_lib/no-ambient-git.cjs";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const HOOK_SRC = path.join(REPO_ROOT, ".claude", "hooks", "block-evidence-guard.js");
const PRED_SRC = path.join(REPO_ROOT, ".claude", "hooks", "lib", "block-evidence-provenance.js");
const EMIT_SRC = path.join(REPO_ROOT, ".claude", "hooks", "lib", "instruct-and-wait.js");
const SUBJECT_REAL = path.join(REPO_ROOT, ".claude", "hooks", "lib", "violation-patterns.js");

const MUTATION_MODE = process.argv.includes("--mutation-check");
const require_ = createRequire(import.meta.url);

// ── scratch lifecycle ────────────────────────────────────────────────────────
const TRASH = [];
const sweep = () => {
  while (TRASH.length) {
    const p = TRASH.pop();
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
};
process.on("exit", sweep);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    sweep();
    process.exit(130);
  });
}

/**
 * Build a synthetic repo matching what the hook resolves against:
 *   <root>/.claude/hooks/block-evidence-guard.js       (the real hook, copied)
 *   <root>/.claude/hooks/lib/instruct-and-wait.js      (the real renderer, copied)
 *   <root>/.claude/hooks/lib/block-evidence-provenance.js (the real predicate)
 * The hook derives its boundary root as resolve(__dirname, "..", "..") = <root>.
 */
function makeTree({ predicate = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "bep-fx-"));
  TRASH.push(root);
  mkdirSync(path.join(root, ".claude", "hooks", "lib"), { recursive: true });
  copyFileSync(HOOK_SRC, path.join(root, ".claude", "hooks", "block-evidence-guard.js"));
  copyFileSync(EMIT_SRC, path.join(root, ".claude", "hooks", "lib", "instruct-and-wait.js"));
  if (predicate) {
    copyFileSync(PRED_SRC, path.join(root, ".claude", "hooks", "lib", "block-evidence-provenance.js"));
  }
  return root;
}

const hookIn = (root) => path.join(root, ".claude", "hooks", "block-evidence-guard.js");

/** Write a candidate detector source into the synthetic tree; return its path. */
function subject(root, name, body) {
  const p = path.join(root, ".claude", "hooks", "lib", name);
  writeFileSync(p, body);
  return p;
}

/** Run the hook as a process on one edited path. */
function runHook(root, { file, hook = null, raw = null } = {}) {
  const payload =
    raw ??
    JSON.stringify({
      session_id: `bepfx-${process.pid}`,
      tool_name: "Edit",
      tool_input: file === undefined ? {} : { file_path: file },
    });
  const r = spawnSync("node", [hook ?? hookIn(root)], {
    input: payload,
    encoding: "utf8",
    timeout: 20000,
  });
  let json = null;
  try {
    json = JSON.parse((r.stdout || "").trim());
  } catch {
    /* left null; cases that care assert on it */
  }
  const ctx = json && json.hookSpecificOutput ? json.hookSpecificOutput.additionalContext || "" : "";
  return {
    status: r.status,
    timedOut: Boolean(r.error && r.error.code === "ETIMEDOUT"),
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    json,
    ctx,
    /** true when a report body actually reached the agent channel */
    fired: Boolean(ctx && ctx.trim()),
  };
}

// ══ candidate detector sources ═══════════════════════════════════════════════
// Every pair below runs the SAME detector shape and separates on ONE property.
// `$` + `{` is assembled at run time so these template bodies stay literal.
const I = (expr) => "${" + expr + "}";

/** VIOLATION — the match call is inline in the evidence expression. */
const FLAG_DIRECT = `"use strict";
const RX = /\\bgit\\s+commit(?![\\w-])/;
function detectCommit(cmd) {
  if (!cmd || typeof cmd !== "string") return null;
  if (!RX.test(cmd)) return null;
  return { rule_id: "trust-posture/L3", severity: "block", evidence: cmd.match(RX)[0] };
}
module.exports = { detectCommit };
`;

/** VIOLATION — identical detector, evidence read off an INTERMEDIATE BINDING. */
const FLAG_BINDING = `"use strict";
const RX = /\\bgit\\s+commit(?![\\w-])/;
function detectCommit(cmd) {
  if (!cmd || typeof cmd !== "string") return null;
  const m = cmd.match(RX);
  if (!m) return null;
  return { rule_id: "trust-posture/L3", severity: "block", evidence: m[0] };
}
module.exports = { detectCommit };
`;

/** VIOLATION — binding CHAIN: m → g, two hops from the match call. */
const FLAG_CHAIN = `"use strict";
const RX = /\\bgit\\s+(\\w+)/;
function detectCommit(cmd) {
  const m = RX.exec(String(cmd || ""));
  if (!m) return null;
  const verb = m[1];
  return { rule_id: "trust-posture/L3", severity: "block", evidence: verb };
}
module.exports = { detectCommit };
`;

/** VIOLATION — destructured match result. */
const FLAG_DESTRUCTURE = `"use strict";
const RX = /\\bgit\\s+(\\w+)/;
function detectCommit(cmd) {
  const [, verb] = String(cmd || "").match(RX) || [];
  if (!verb) return null;
  return { rule_id: "trust-posture/L3", severity: "block", evidence: verb };
}
module.exports = { detectCommit };
`;

/** VIOLATION — the match span reaches evidence through a template interpolation. */
const FLAG_TEMPLATE = `"use strict";
const RX = /\\bgit\\s+(\\w+)/;
function detectCommit(cmd) {
  const m = RX.exec(String(cmd || ""));
  if (!m) return null;
  return { rule_id: "trust-posture/L3", severity: "block", evidence: \`matched ${I("m[1]")}\` };
}
module.exports = { detectCommit };
`;

/**
 * COMPLIANT — the same `block`, dispatching on a PARSED field. This is the pole that
 * matters most: it is the shape `hook-output-discipline.md` MUST-5's own DO block
 * carries, and a predicate that flags it would refuse the exemplar its rule cites.
 */
const CLEAN_PARSED = `"use strict";
const { parseGitInvocations, isNonMutating } = require("./git-command-parse.js");
const FENCED = new Set(["commit", "push", "merge"]);
function detectCommit(cmd) {
  for (const g of parseGitInvocations(cmd)) {
    if (FENCED.has(g.sub) && !isNonMutating(g.argv)) {
      return { rule_id: "trust-posture/L3", severity: "block", evidence: \`parsed verb: git ${I("g.sub")}\` };
    }
  }
  return null;
}
module.exports = { detectCommit };
`;

/**
 * COMPLIANT — a `block` on a STRUCTURAL env/path fact, evidence built from the env
 * var and the argument. This is `violation-patterns.js::detectWorktreeDrift`'s real
 * shape, reproduced so the battery's clean pole is the corpus's own live case.
 */
const CLEAN_ENV = `"use strict";
function detectWorktreeDrift(filePath) {
  if (!filePath || typeof filePath !== "string") return null;
  const pinned = process.env.CLAUDE_WORKTREE_PATH;
  if (!pinned) return null;
  if (filePath.startsWith("/") && !filePath.startsWith(pinned)) {
    return {
      rule_id: "worktree-isolation/MUST-1",
      severity: "block",
      evidence: \`absolute path ${I("filePath")} outside pinned worktree ${I("pinned")}\`,
    };
  }
  return null;
}
module.exports = { detectWorktreeDrift };
`;

/**
 * COMPLIANT — a match-derived evidence field under `halt-and-report`. The SEVERITY
 * is what MUST-5(a) keys on; a lexical detector that correctly caps itself is the
 * compliant outcome the rule WANTS, and flagging it would punish the fix.
 */
const CLEAN_HAR = `"use strict";
const RX = /\\bgit\\s+commit(?![\\w-])/;
function detectCommit(cmd) {
  const m = String(cmd || "").match(RX);
  if (!m) return null;
  return { rule_id: "git/commit", severity: "halt-and-report", evidence: m[0] };
}
module.exports = { detectCommit };
`;

/** COMPLIANT — `advisory` with the same match-derived evidence. */
const CLEAN_ADVISORY = `"use strict";
const RX = /\\btodo\\b/i;
function detectTodo(text) {
  const m = String(text || "").match(RX);
  if (!m) return null;
  return { rule_id: "zero-tolerance/2", severity: "advisory", evidence: m[0] };
}
module.exports = { detectTodo };
`;

/**
 * COMPLIANT — the tokens appear ONLY in a comment and a string. A grep-shaped check
 * flags this; the lexer must not. This is not hypothetical: the real
 * `violation-patterns.js` carries exactly these two comment forms.
 */
const CLEAN_PROSE = `"use strict";
// severity:block from lexical regex is BLOCKED — halt-and-report is the ceiling.
// The signal (why \`severity: "block"\` with evidence: m[0] is wrong) is discussed above.
const DOC = 'severity: "block" with evidence: m[0] would be a MUST-5(a) violation';
function detectNothing() {
  return null;
}
module.exports = { detectNothing, DOC };
`;

/**
 * COMPLIANT — the same prose, but INSIDE the returned object literal. This is the
 * realistic shape (a comment in a detector's return explaining why it does NOT
 * block) and it is the one that SEPARATES a comment-dropping lexer from a
 * text-scanning one: with comments dropped this is a `halt-and-report` return and
 * silent; without, the commented `severity: "block"` becomes a property of a real
 * object literal that also carries a match-derived `evidence`, and the whole thing
 * fires. MEASURED at both poles — see the `mutant-stops-dropping-comments` note.
 */
const CLEAN_PROSE_IN_OBJECT = `"use strict";
const RX = /\\bgit\\s+commit\\b/;
function detectCommit(cmd) {
  const m = String(cmd || "").match(RX);
  if (!m) return null;
  return {
    rule_id: "git/commit",
    // NOT severity: "block" — with evidence: m[0] that would be a MUST-5(a) violation.
    severity: "halt-and-report",
    evidence: m[0],
  };
}
module.exports = { detectCommit };
`;

/** COMPLIANT — a `block` carrying NO evidence field at all. Not this violation. */
const CLEAN_NO_EVIDENCE = `"use strict";
function detectPinned(p) {
  const pinned = process.env.CLAUDE_WORKTREE_PATH;
  if (!pinned || !String(p).startsWith("/")) return null;
  return { rule_id: "worktree-isolation/MUST-1", severity: "block" };
}
module.exports = { detectPinned };
`;

/** COMPLIANT — evidence is match-derived on a NESTED object, not on the block object. */
const CLEAN_NESTED = `"use strict";
const RX = /\\bgit\\s+(\\w+)/;
function detectCommit(cmd) {
  const m = RX.exec(String(cmd || ""));
  if (!m) return null;
  const pinned = process.env.CLAUDE_WORKTREE_PATH;
  if (!pinned) return null;
  return {
    rule_id: "trust-posture/L3",
    severity: "block",
    evidence: \`pinned ${I("pinned")}\`,
    debug: { evidence: m[0] },
  };
}
module.exports = { detectCommit };
`;

// ── DECLARED BLIND CLASSES — each pinned as a MISS in ARM E ───────────────────
const BLIND_NONLITERAL_SEVERITY = `"use strict";
const SEV = { BLOCK: "block" };
const RX = /\\bgit\\s+(\\w+)/;
function detectCommit(cmd) {
  const m = RX.exec(String(cmd || ""));
  if (!m) return null;
  return { rule_id: "x/1", severity: SEV.BLOCK, evidence: m[0] };
}
module.exports = { detectCommit };
`;

const BLIND_CROSS_FUNCTION = `"use strict";
const RX = /\\bgit\\s+(\\w+)/;
function render(cmd) {
  const m = RX.exec(String(cmd || ""));
  return m ? m[1] : "";
}
function detectCommit(cmd) {
  if (!RX.test(String(cmd || ""))) return null;
  return { rule_id: "x/2", severity: "block", evidence: render(cmd) };
}
module.exports = { detectCommit };
`;

const BLIND_PARAMETER = `"use strict";
function fromMatch(m) {
  return { rule_id: "x/3", severity: "block", evidence: m[0] };
}
module.exports = { fromMatch };
`;

const BLIND_INCREMENTAL = `"use strict";
const RX = /\\bgit\\s+(\\w+)/;
function detectCommit(cmd) {
  const m = RX.exec(String(cmd || ""));
  if (!m) return null;
  const out = { rule_id: "x/4", severity: "block" };
  out.evidence = m[0];
  return out;
}
module.exports = { detectCommit };
`;

// ── case bookkeeping ─────────────────────────────────────────────────────────
const results = [];
function t(id, pass, detail = "") {
  results.push({ id, pass: Boolean(pass), detail });
}

function cases() {
  results.length = 0;
  const pred = require_(PRED_SRC);

  // ══ ARM A — the bipolar core: SAME detector, one property apart ════════════
  {
    const root = makeTree();
    const pairs = [
      ["direct-match-call", FLAG_DIRECT, true],
      ["intermediate-binding", FLAG_BINDING, true],
      ["binding-chain", FLAG_CHAIN, true],
      ["destructured-match", FLAG_DESTRUCTURE, true],
      ["template-interpolation", FLAG_TEMPLATE, true],
      ["parsed-field-evidence", CLEAN_PARSED, false],
      ["structural-env-evidence", CLEAN_ENV, false],
      ["halt-and-report-severity", CLEAN_HAR, false],
      ["advisory-severity", CLEAN_ADVISORY, false],
      ["tokens-only-in-prose", CLEAN_PROSE, false],
      ["prose-inside-the-returned-object", CLEAN_PROSE_IN_OBJECT, false],
      ["block-with-no-evidence-field", CLEAN_NO_EVIDENCE, false],
      ["match-evidence-on-a-nested-object", CLEAN_NESTED, false],
    ];
    for (const [name, body, shouldFire] of pairs) {
      const p = subject(root, `a-${name}.js`, body);
      const r = runHook(root, { file: p });
      t(
        `A-${shouldFire ? "flag" : "clean"}-${name}`,
        r.fired === shouldFire,
        `fired=${r.fired} expected=${shouldFire} ${r.ctx.slice(0, 120)}`,
      );
    }

    // The two poles a naive same-line matcher CANNOT separate, asserted as a pair
    // rather than as two independent cases: FLAG_BINDING and CLEAN_HAR both carry
    // `evidence: m[0]` on the line, and differ only in the severity three tokens
    // earlier. A line-oriented check scores them identically.
    const fb = runHook(root, { file: subject(root, "a-pairL.js", FLAG_BINDING) });
    const ch = runHook(root, { file: subject(root, "a-pairR.js", CLEAN_HAR) });
    t("A-pair-same-evidence-line-separates-on-severity", fb.fired && !ch.fired,
      `flagPole=${fb.fired} cleanPole=${ch.fired}`);
  }

  // ══ ARM B — report content ════════════════════════════════════════════════
  {
    const root = makeTree();
    const p = subject(root, "b-subject.js", FLAG_BINDING);
    const r = runHook(root, { file: p });
    t("B1-report-names-the-rule-clause", /MUST-5\(a\)/.test(r.ctx), r.ctx.slice(0, 160));
    t("B2-report-names-the-line-number", /line 7\b/.test(r.ctx), r.ctx.slice(0, 200));
    t("B3-report-quotes-the-evidence-expression", /evidence: m\[0\]/.test(r.ctx));
    t("B4-report-names-the-derivation-kind",
      /bound to a match\(\)\/exec\(\) result in the same function/.test(r.ctx));
    t("B5-report-says-the-edit-stands", /edit STANDS/.test(r.ctx));
    t("B6-report-names-the-subject-file", /b-subject\.js/.test(r.ctx));
    t("B7-report-offers-the-discharge-path",
      /say so at the block site and this finding is discharged/.test(r.ctx));
    t("B8-report-counts-examined-block-returns", /1 of the 1 /.test(r.ctx), r.ctx.slice(0, 200));
  }

  // ══ ARM C — path shape + containment (security.md § Path Containment) ══════
  {
    const inside = makeTree();
    const outside = makeTree();
    const insideSubject = subject(inside, "c-in.js", FLAG_DIRECT);
    const outsideSubject = subject(outside, "c-out.js", FLAG_DIRECT);

    // C1/C2 are ONE instrument read twice. C1's silence means "contained out" only
    // because C2 proves the identical content INSIDE the boundary fires.
    t("C1-subject-outside-the-boundary-root-is-refused",
      !runHook(inside, { file: outsideSubject }).fired);
    t("C2-control-identical-subject-inside-the-boundary-fires",
      runHook(inside, { file: insideSubject }).fired);

    const escaping = path.join(inside, ".claude", "hooks", "lib", "c-escape.js");
    symlinkSync(outsideSubject, escaping);
    t("C3-symlink-escaping-the-boundary-is-refused", !runHook(inside, { file: escaping }).fired);

    const internal = path.join(inside, ".claude", "hooks", "lib", "c-link.js");
    symlinkSync(insideSubject, internal);
    t("C4-control-symlink-resolving-inside-the-boundary-fires",
      runHook(inside, { file: internal }).fired);

    const dangling = path.join(inside, ".claude", "hooks", "lib", "c-dangle.js");
    symlinkSync(path.join(outside, ".claude", "hooks", "lib", "nope.js"), dangling);
    const dr = runHook(inside, { file: dangling });
    t("C5-unresolvable-path-is-refused-without-crashing",
      !dr.fired && dr.status === 0, `status=${dr.status}`);

    // Path SHAPE: the same violating content outside `.claude/hooks/**`, and in a
    // non-JS file, must not be inspected at all.
    mkdirSync(path.join(inside, ".claude", "bin"), { recursive: true });
    const binPath = path.join(inside, ".claude", "bin", "c-bin.js");
    writeFileSync(binPath, FLAG_DIRECT);
    t("C6-same-content-under-claude-bin-is-out-of-scope", !runHook(inside, { file: binPath }).fired);

    const mdPath = path.join(inside, ".claude", "hooks", "lib", "c-doc.md");
    writeFileSync(mdPath, FLAG_DIRECT);
    t("C7-non-js-extension-is-out-of-scope", !runHook(inside, { file: mdPath }).fired);

    const cjsPath = path.join(inside, ".claude", "hooks", "lib", "c-mod.cjs");
    writeFileSync(cjsPath, FLAG_DIRECT);
    t("C8-control-cjs-extension-is-in-scope", runHook(inside, { file: cjsPath }).fired);

    t("C9-missing-tool-input-is-ignored", !runHook(inside, {}).fired);
    t("C10-absent-file-is-ignored",
      !runHook(inside, { file: path.join(inside, ".claude", "hooks", "lib", "gone.js") }).fired);
  }

  // ══ ARM D — read discipline (fd, FIFO, size cap) ══════════════════════════
  {
    const root = makeTree();
    const fifo = path.join(root, ".claude", "hooks", "lib", "d-fifo.js");
    const mk = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    if (mk.status === 0) {
      const started = Date.now();
      const r = runHook(root, { file: fifo });
      const elapsed = Date.now() - started;
      t("D1-fifo-does-not-hang-the-hook", !r.timedOut && elapsed < 12000,
        `elapsed=${elapsed}ms timedOut=${r.timedOut}`);
      t("D2-fifo-produces-no-report", !r.fired);
      try { unlinkSync(fifo); } catch { /* swept with the tree */ }
    } else {
      // Never silently skip: a case that did not run is not a case that passed.
      t("D1-fifo-does-not-hang-the-hook", false, "mkfifo unavailable on this host");
      t("D2-fifo-produces-no-report", false, "mkfifo unavailable on this host");
    }

    t("D3-control-regular-file-at-an-in-scope-path-fires",
      runHook(root, { file: subject(root, "d-ok.js", FLAG_DIRECT) }).fired);

    const big = path.join(root, ".claude", "hooks", "lib", "d-big.js");
    writeFileSync(big, `${FLAG_DIRECT}\n// ${"x".repeat(2 * 1024 * 1024 + 16)}\n`);
    t("D4-file-over-the-size-cap-is-refused", !runHook(root, { file: big }).fired);

    const nearCap = path.join(root, ".claude", "hooks", "lib", "d-near.js");
    writeFileSync(nearCap, `${FLAG_DIRECT}\n// ${"x".repeat(1024 * 1024)}\n`);
    t("D5-control-file-under-the-size-cap-fires", runHook(root, { file: nearCap }).fired);

    const dir = path.join(root, ".claude", "hooks", "lib", "d-dir.js");
    mkdirSync(dir);
    t("D6-non-regular-file-is-refused", !runHook(root, { file: dir }).fired);
  }

  // ══ ARM E — the DECLARED BLIND CLASSES, pinned as misses ══════════════════
  // Each of these SHOULD be a violation and is NOT seen. The header names all four;
  // these cases are what make that a bound rather than a claim. When one starts
  // FAILING, the predicate got better and the header is what needs correcting.
  {
    const root = makeTree();
    const blind = [
      ["nonliteral-severity", BLIND_NONLITERAL_SEVERITY],
      ["cross-function-helper", BLIND_CROSS_FUNCTION],
      ["parameter-borne-match", BLIND_PARAMETER],
      ["incrementally-built-object", BLIND_INCREMENTAL],
    ];
    for (const [name, body] of blind) {
      const r = runHook(root, { file: subject(root, `e-${name}.js`, body) });
      t(`E-declared-blind-${name}-is-a-MISS`, !r.fired,
        `fired=${r.fired} — if this now FAILS the predicate improved; update its header`);
    }
    // The control that keeps ARM E honest: the SAME violation in a shape the
    // predicate DOES see. Without it, four silences are indistinguishable from a
    // guard that stopped working (instrument-discipline MUST-3(a)).
    t("E-control-the-seen-shape-still-fires",
      runHook(root, { file: subject(root, "e-control.js", FLAG_BINDING) }).fired);
  }

  // ══ ARM F — predicate STATE the hook converts to silence ══════════════════
  // `parsed:false` and `examined:0` are distinct states in the library and must not
  // collapse into "clean" for a caller that can act on them.
  {
    const unlexable = 'const s = "unterminated;\nfunction f(){ return 1; }\n';
    const f1 = pred.scanSource(unlexable);
    t("F1-unlexable-source-returns-parsed-false", f1.parsed === false && Boolean(f1.error),
      `parsed=${f1.parsed} error=${f1.error}`);
    t("F2-unlexable-source-reports-no-findings-as-findings", f1.findings.length === 0);

    const f3 = pred.scanSource(CLEAN_ADVISORY);
    t("F3-no-block-return-reports-examined-zero", f3.parsed && f3.examined === 0,
      `examined=${f3.examined}`);

    const f4 = pred.scanSource(CLEAN_ENV);
    t("F4-a-clean-block-return-is-counted-as-examined",
      f4.examined === 1 && f4.withEvidence === 1 && f4.findings.length === 0 && f4.clean.length === 1,
      `examined=${f4.examined} clean=${f4.clean.length}`);

    const f5 = pred.scanSource(CLEAN_NO_EVIDENCE);
    t("F5-a-block-with-no-evidence-is-examined-but-not-withEvidence",
      f5.examined === 1 && f5.withEvidence === 0);

    // The hook turns BOTH states into silence — deliberately, per its header.
    const root = makeTree();
    t("F6-hook-is-silent-on-an-unlexable-source",
      !runHook(root, { file: subject(root, "f-bad.js", unlexable) }).fired);

    // Predicate ABSENT: the hook must fail open, not crash.
    const noPred = makeTree({ predicate: false });
    const r = runHook(noPred, { file: subject(noPred, "f-x.js", FLAG_DIRECT) });
    t("F7-predicate-absent-fails-open-quietly",
      !r.fired && r.status === 0 && r.json && r.json.continue === true,
      `status=${r.status}`);
  }

  // ══ ARM G — output contract + the SEVERITY CEILING measurement ════════════
  {
    const root = makeTree();
    const g = runHook(root, { file: subject(root, "g-sub.js", FLAG_DIRECT) });
    t("G1-exit-code-is-zero-when-firing", g.status === 0, `status=${g.status}`);
    t("G2-payload-continues-the-session", g.json && g.json.continue === true);
    t("G3-payload-never-denies-the-tool-call",
      !/permissionDecision/.test(g.stdout) && !/"continue":false/.test(g.stdout.replace(/\s/g, "")));
    t("G4-body-reaches-the-agent-via-additionalContext",
      g.json && g.json.hookSpecificOutput &&
      g.json.hookSpecificOutput.hookEventName === "PostToolUse" &&
      typeof g.json.hookSpecificOutput.additionalContext === "string");
    t("G5-severity-renders-as-halt-and-report-not-block",
      /\[HALT-AND-REPORT\]/.test(g.stderr) && !/\[BLOCK\]/.test(g.stderr), g.stderr.slice(0, 200));
    t("G6-user-summary-line-is-emitted", /quote a match\(\) span as evidence/.test(g.stderr));
    t("G7-report-carries-a-delivery-channel",
      /SendMessage/.test(g.ctx), g.ctx.slice(-200));

    const quietRun = runHook(root, { file: subject(root, "g-clean.js", CLEAN_ENV) });
    t("G8-control-quiet-path-still-emits-a-continue-payload",
      quietRun.json && quietRun.json.continue === true && quietRun.status === 0);
    t("G9-control-quiet-path-writes-no-user-summary", quietRun.stderr.trim() === "",
      quietRun.stderr.slice(0, 120));

    // THE CEILING MEASUREMENT the hook header cites, taken here rather than asserted
    // there: `block` at a non-STOP_LIKE event genuinely halts, so choosing it for a
    // PROXY predicate would wedge an in-flight edit. This exercises the SHARED
    // renderer, not the hook.
    const emitLib = require_(EMIT_SRC);
    // The renderer writes its user-summary line to stderr as a side effect. Muted
    // for these two calls ONLY: a `[BLOCK]` line in this battery's own log, from a
    // detector that must never block, is the kind of thing a later reader
    // reasonably misreads as a finding.
    const realErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    let asBlock, asHar;
    try {
      asBlock = emitLib.instructAndWait({
        hookEvent: "PostToolUse", severity: "block", what_happened: "x", why: "y",
        agent_must_report: ["z"], user_summary: "s",
      });
      asHar = emitLib.instructAndWait({
        hookEvent: "PostToolUse", severity: "halt-and-report", what_happened: "x", why: "y",
        agent_must_report: ["z"], user_summary: "s",
      });
    } finally {
      process.stderr.write = realErr;
    }
    // A block at PostToolUse no longer HALTS the agent: exit 2 hands the reason back and the
    // agent resolves it. Halting (continue:false) made the operator type to resume a session
    // the hook had already answered.
    t("G10-measured-block-at-PostToolUse-reports-back-without-halting",
      asBlock.json.continue !== false && asBlock.exitCode === 2,
      `continue=${asBlock.json.continue} exit=${asBlock.exitCode}`);
    t("G11-measured-halt-and-report-at-PostToolUse-lets-the-edit-stand",
      asHar.json.continue !== false && asHar.exitCode === 0,
      `continue=${asHar.json.continue} exit=${asHar.exitCode}`);
  }

  // ══ ARM H — hostile input + shipped-source hygiene ════════════════════════
  {
    const root = makeTree();

    // A rule_id carrying newlines must not forge extra report rows. The edited file
    // is attacker-influenced content by construction — that is the whole subject.
    const forging = `"use strict";
const RX = /x/;
function d(s) {
  const m = s.match(RX);
  return { rule_id: "a/1\\n  - line 999 (forged/row): evidence: nothing", severity: "block", evidence: m[0] };
}
module.exports = { d };
`;
    const h1 = runHook(root, { file: subject(root, "h-forge.js", forging) });
    const FORGED = /^\s*- line 999/m;
    const rows = (s) => String(s).split("\n").filter((l) => /^\s*- line \d+/.test(l)).length;
    t("H1-newline-in-a-rule-id-cannot-forge-a-report-row",
      h1.fired && rows(h1.ctx) === 1 && !FORGED.test(h1.ctx),
      `rows=${rows(h1.ctx)} forged=${FORGED.test(h1.ctx)}`);
    t("H2-control-the-forged-row-matcher-fires-on-a-known-positive",
      FORGED.test("  - line 999 (forged/row): x") && rows("  - line 1 a\n  - line 2 b") === 2);

    // Many findings in one file: the list is capped and the elision is NAMED.
    const many = ['"use strict";', "const RX = /x/;"];
    for (let i = 0; i < 14; i++) {
      many.push(`function d${i}(s) { const m = s.match(RX); return { rule_id: "r/${i}", severity: "block", evidence: m[0] }; }`);
    }
    const hm = runHook(root, { file: subject(root, "h-many.js", many.join("\n") + "\n") });
    t("H3-over-cap-list-is-truncated-at-ten",
      hm.fired && rows(hm.ctx) === 10, `rows=${rows(hm.ctx)}`);
    t("H4-over-cap-list-names-the-elided-count", /and 4 more/.test(hm.ctx), hm.ctx.slice(-200));
    t("H5-over-cap-report-states-the-full-total", /14 of the 14 /.test(hm.ctx), hm.ctx.slice(0, 160));

    // knowledge-cascade-routing MUST-3: both files ship to every consumer on the
    // ALWAYS_INCLUDE hooks surface. Assert on the SHIPPED SOURCE, with a fired
    // control per pattern so an empty result cannot be read as clean.
    const shipped = readFileSync(HOOK_SRC, "utf8") + readFileSync(PRED_SRC, "utf8");
    const forbidden = [
      { re: /\/Users\/[a-z]/i, fires: "/Users/me/repos/a-repo" },
      { re: /\bself-hosted\b/, fires: "runs-on: [self-hosted, a-label]" },
      { re: /\brunner-\d+\b/, fires: "assigned to runner-17" },
    ];
    const hits = forbidden.filter((f) => f.re.test(shipped)).map((f) => String(f.re));
    t("H6-shipped-sources-carry-no-operator-path-or-runner-label", hits.length === 0, hits.join(", "));
    const dead = forbidden.filter((f) => !f.re.test(f.fires)).map((f) => String(f.re));
    t("H7-control-every-disclosure-pattern-fires-on-its-own-known-positive",
      dead.length === 0, dead.join(", "));

    // The detector must obey the rule it enforces: it emits no `block` itself.
    //
    // MEASURED, AND THE INSTRUMENT MATTERS — this case was originally written with
    // the naive matcher `/severity:\s*"block"/` over the raw file, and it FAILED on
    // a correct hook: the guard's report body quotes the literal
    // `severity: "block"` when NAMING the offending return. That is the exact
    // regex-over-prose defect the predicate's header cites from the real
    // `violation-patterns.js`, reproduced here by accident in this battery's own
    // instrument. Both readings ship, because the contrast IS the evidence: the
    // lexical matcher HITS (H8a) and the structural one correctly reports zero
    // originated block returns (H8b).
    const hookSrc = readFileSync(HOOK_SRC, "utf8");
    t("H8a-the-naive-lexical-matcher-hits-the-hooks-own-prose",
      /severity:\s*"block"/.test(hookSrc),
      "if this stops hitting, the prose changed — H8b is the load-bearing case");
    t("H8b-shipped-hook-originates-no-block-severity",
      pred.scanSource(hookSrc).examined === 0,
      `examined=${pred.scanSource(hookSrc).examined}`);
    t("H9-control-the-structural-check-fires-on-a-known-positive",
      pred.scanSource(FLAG_DIRECT).examined === 1);

    // MUST-4 of hook-event-selection: the marker must name the registered pair.
    t("H10-shipped-hook-declares-its-hook-event-marker",
      /@hook-event:\s*PostToolUse:Edit\|Write\s*\(verification\)/.test(readFileSync(HOOK_SRC, "utf8")));
  }

  // ══ ARM I — malformed hook input ══════════════════════════════════════════
  {
    const root = makeTree();
    const bad = runHook(root, { raw: "not json at all" });
    t("I1-non-json-stdin-exits-clean", bad.status === 0, `status=${bad.status}`);
    t("I2-non-json-stdin-still-continues", /"continue":\s*true/.test(bad.stdout));
    const empty = runHook(root, { raw: "" });
    t("I3-empty-stdin-exits-clean", empty.status === 0, `status=${empty.status}`);
    const nb = runHook(root, {
      raw: JSON.stringify({ tool_input: { notebook_path: path.join(root, "n.ipynb") } }),
    });
    t("I4-notebook-path-shape-is-handled", nb.status === 0 && !nb.fired);
  }

  // ══ ARM J — the REAL subject, with its control fired first ════════════════
  // `hook-output-discipline.md` MUST-5's deferral names ONE file. Running the
  // predicate against it is the point of the graduation — and a zero here is only
  // readable because J1 shows the matcher fires on a known positive on THIS host
  // (instrument-discipline MUST-3(a)).
  {
    t("J1-control-the-predicate-fires-on-a-known-positive",
      pred.scanSource(FLAG_BINDING).findings.length === 1);
    if (existsSync(SUBJECT_REAL)) {
      const r = pred.scanSource(readFileSync(SUBJECT_REAL, "utf8"));
      t("J2-real-violation-patterns-lexes-cleanly", r.parsed === true, r.error || "");
      t("J3-real-violation-patterns-has-at-least-one-block-return-to-examine",
        r.examined >= 1, `examined=${r.examined} — a zero here is NOT a clean pass`);
      t("J4-real-violation-patterns-has-no-match-derived-block-evidence",
        r.findings.length === 0,
        r.findings.map((f) => `line ${f.line}: ${f.evidence}`).join(" | "));
    } else {
      t("J2-real-violation-patterns-lexes-cleanly", false, "subject file absent");
      t("J3-real-violation-patterns-has-at-least-one-block-return-to-examine", false, "subject file absent");
      t("J4-real-violation-patterns-has-no-match-derived-block-evidence", false, "subject file absent");
    }
  }

  return results;
}

// ── mutation mode ────────────────────────────────────────────────────────────
// Each mutant rewrites ONLY the PREDICATE copy inside a throwaway tree; the tracked
// source is never touched. A mutant that does NOT red its named case leaves TWO live
// hypotheses (vacuous case, or inert mutation), so the verdict says UNRESOLVED and
// names both rather than declaring the case vacuous (instrument-discipline MUST-2(b)).
// The `applied` check below closes the inert half: a mutation whose search text is
// absent is reported NOT APPLIED and never scored.
const MUTANTS = [
  {
    id: "mutant-stops-following-intermediate-bindings",
    find: "      const hit = [...identsIn(tokens, ev.valueStart, ev.valueEnd)].find((id) => tainted.has(id));",
    with: "      const hit = undefined;",
    killedBy: { subjectName: "m-binding.js", body: null, expectFired: true },
    note: "the case a same-line matcher misses; without taint it goes silent",
  },
  {
    id: "mutant-ignores-the-severity-value",
    find: '    if (!val || val.type !== "string" || val.value !== "block") continue;',
    with: '    if (!val || val.type !== "string") continue;',
    killedBy: { subjectName: "m-har.js", body: "CLEAN_HAR", expectFired: false },
    note: "over-fires on halt-and-report — the pole that keeps the guard from being switched off",
  },
  {
    id: "mutant-stops-dropping-comments",
    find: '      if (c === "/" && s[i + 1] === "/") {\n        while (i < n && s[i] !== "\\n") i++;\n        continue;\n      }',
    with: '      if (c === "/" && s[i + 1] === "/" && false) {\n        while (i < n && s[i] !== "\\n") i++;\n        continue;\n      }',
    killedBy: { subjectName: "m-prose.js", body: "CLEAN_PROSE_IN_OBJECT", expectFired: false },
    // REACH PROOF, part 3 — specific to this mutant, and NOT optional here. On its
    // first run this mutant SURVIVED against the top-level `CLEAN_PROSE` fixture,
    // leaving the two hypotheses `instrument-discipline.md` MUST-2(b) names. It was
    // RESOLVED rather than recorded as a vacuity verdict: the mutation was MEASURED
    // to reach the lexer (11 tokens pristine → 25 mutated on the same prose) and was
    // nonetheless INERT for that fixture, because top-level prose sits outside any
    // object literal, so `enclosingBraces` returns empty and the hit is discarded
    // before an `evidence` property is ever sought. The fixture was the weak half,
    // not the mutation. Repointed at `CLEAN_PROSE_IN_OBJECT`, where the commented
    // `severity: "block"` lands INSIDE a real object that also carries a
    // match-derived `evidence` — measured 0 findings pristine, 1 mutated.
    reach: (mutatedPred, pristinePred) => {
      const a = pristinePred.tokenize(CLEAN_PROSE_IN_OBJECT).tokens.length;
      const b = mutatedPred.tokenize(CLEAN_PROSE_IN_OBJECT).tokens.length;
      return { ok: b > a, detail: `tokens pristine=${a} mutated=${b}` };
    },
    note: "the regex-shaped failure: prose inside a return object becomes a finding",
  },
  {
    id: "mutant-widens-evidence-to-nested-objects",
    find: "    const ev = props.find((p) => p.key === \"evidence\");",
    with: "    const ev = { key: \"evidence\", shorthand: false, valueStart: openIdx, valueEnd: closeIdx };",
    killedBy: { subjectName: "m-nested.js", body: "CLEAN_NESTED", expectFired: false },
    note: "reads the whole object instead of the evidence property — a nested debug field now fires",
  },
  {
    id: "mutant-drops-path-containment",
    find: "    if (resolved !== repoRoot && !resolved.startsWith(repoRoot + path.sep)) return quiet();",
    with: "    if (false) return quiet();",
    target: "hook",
    killedBy: { containment: true },
    note: "a subject outside the boundary root becomes readable",
  },
];

function mutantBody(name) {
  const table = {
    CLEAN_HAR, CLEAN_PROSE, CLEAN_PROSE_IN_OBJECT, CLEAN_NESTED,
  };
  return table[name] ?? FLAG_BINDING;
}

function runMutations() {
  const problems = [];
  const pristinePred = readFileSync(PRED_SRC, "utf8");
  const pristineHook = readFileSync(HOOK_SRC, "utf8");

  for (const m of MUTANTS) {
    const isHook = m.target === "hook";
    const pristine = isHook ? pristineHook : pristinePred;
    // REACH PROOF, part 1: the search text must EXIST in the shipped source. A
    // mutant whose anchor drifted is stale, and reading its survival as evidence
    // about the case would be the inert half of MUST-2(b).
    if (!pristine.includes(m.find)) {
      problems.push(`${m.id}: NOT APPLIED — search text absent from the ${isHook ? "hook" : "predicate"} source`);
      process.stdout.write(`FAIL ${m.id} — NOT APPLIED\n`);
      continue;
    }
    const mutated = pristine.replace(m.find, m.with);
    // REACH PROOF, part 2: the mutated text must DIFFER. A replacement identical to
    // the original applies cleanly and changes nothing.
    if (mutated === pristine) {
      problems.push(`${m.id}: NOT APPLIED — replacement is byte-identical to the original`);
      process.stdout.write(`FAIL ${m.id} — NOT APPLIED (no-op replacement)\n`);
      continue;
    }

    const root = makeTree();
    const predPath = path.join(root, ".claude", "hooks", "lib", "block-evidence-provenance.js");
    writeFileSync(isHook ? hookIn(root) : predPath, mutated);

    // REACH PROOF, part 3 (when a mutant declares one): show the mutated line is
    // EXECUTED before reading any result from it. `instrument-discipline.md`
    // MUST-5(a) — a mutation whose reach is unproven yields a result that carries
    // no information about the case.
    if (typeof m.reach === "function") {
      let rr;
      try {
        rr = m.reach(require_(predPath), require_(PRED_SRC));
      } catch (e) {
        rr = { ok: false, detail: `reach probe threw: ${e && e.message}` };
      }
      process.stdout.write(`     reach[${m.id}]: ${rr.detail}\n`);
      if (!rr.ok) {
        problems.push(`${m.id}: REACH UNPROVEN — ${rr.detail}; result not scored`);
        process.stdout.write(`FAIL ${m.id} — REACH UNPROVEN\n`);
        continue;
      }
    }

    let verdict;
    if (m.killedBy.containment) {
      const outside = makeTree();
      const outSub = subject(outside, "m-out.js", FLAG_DIRECT);
      const leaked = runHook(root, { file: outSub }).fired;
      verdict = leaked
        ? "killed"
        : "UNRESOLVED — mutant survived; either the case is vacuous or the mutation was inert";
    } else {
      const body = m.killedBy.body ? mutantBody(m.killedBy.body) : FLAG_BINDING;
      const p = subject(root, m.killedBy.subjectName, body);
      const fired = runHook(root, { file: p }).fired;
      // Killed when the behaviour DIFFERS from the pristine expectation.
      verdict = fired !== m.killedBy.expectFired
        ? "killed"
        : "UNRESOLVED — mutant survived; either the case is vacuous or the mutation was inert";
    }

    if (verdict !== "killed") problems.push(`${m.id}: ${verdict}`);
    process.stdout.write(`${verdict === "killed" ? "PASS" : "FAIL"} ${m.id} — ${verdict}  [${m.note}]\n`);
  }
  return problems;
}

// ── main ─────────────────────────────────────────────────────────────────────
for (const [label, p] of [["hook", HOOK_SRC], ["predicate", PRED_SRC], ["renderer", EMIT_SRC]]) {
  if (!existsSync(p)) {
    process.stderr.write(`FAIL harness — ${label} under test not found: ${p}\n`);
    process.exit(1);
  }
}

if (MUTATION_MODE) {
  const problems = runMutations();
  process.stdout.write(`\n${MUTANTS.length - problems.length}/${MUTANTS.length} mutants killed\n`);
  if (problems.length) {
    for (const p of problems) process.stderr.write(`  ${p}\n`);
    process.exit(1);
  }
  process.exit(0);
}

const out = cases();
for (const c of out) {
  process.stdout.write(`${c.pass ? "PASS" : "FAIL"} ${c.id}${c.detail ? ` — ${c.detail}` : ""}\n`);
}
const failed = out.filter((c) => !c.pass);
process.stdout.write(`\n${out.length - failed.length}/${out.length} cases pass\n`);
process.exit(failed.length ? 1 : 0);
