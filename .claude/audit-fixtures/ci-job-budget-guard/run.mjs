#!/usr/bin/env node
/**
 * run.mjs — fixture battery for `.claude/hooks/ci-job-budget-guard.js`.
 *
 * WHAT IS UNDER TEST: the hook, end to end, as a spawned process reading real
 * stdin and writing real stdout — not an imported function. The hook's whole
 * contract lives in the process boundary (exit code, the `continue` field, the
 * severity register, the stderr summary line), so importing it would test a
 * different thing than the one that ships.
 *
 * WHAT IS *NOT* UNDER TEST: the classifier. See `engine-double.mjs` — the engine
 * is stood in for so the presenter's inputs are KNOWN. Classifier correctness
 * belongs with `.claude/bin/ci-job-budget-audit.mjs` and its own fixtures, and
 * reading a green here as evidence about it would be `instrument-discipline.md`
 * MUST-4 (an instrument read for a question it was not built for).
 *
 * BIPOLARITY IS THE POINT. Every firing arm carries its opposite pole: a battery
 * that only proves the guard FIRES cannot detect an over-firing guard, and an
 * over-firing advisory on every workflow edit is the failure that gets a hook
 * switched off — which lands in the same place as silence.
 *
 * THE TREE IS BUILT SYNTHETICALLY, IN A TEMP DIR, ONE FILE AT A TIME. It is never
 * a recursive copy of the live `.claude/` tree, and nothing here writes to a
 * tracked file. The upstream battery this was ported from mutated its own subject
 * in place; that is not replicated — the mutation mode below rewrites only the
 * COPY inside the temp tree.
 *
 * Usage:
 *   node .claude/audit-fixtures/ci-job-budget-guard/run.mjs
 *   node .claude/audit-fixtures/ci-job-budget-guard/run.mjs --mutation-check
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const HOOK_SRC = path.join(REPO_ROOT, ".claude", "hooks", "ci-job-budget-guard.js");
const LIB_SRC = path.join(
  REPO_ROOT,
  ".claude",
  "hooks",
  "lib",
  "instruct-and-wait.js",
);
const DOUBLE_SRC = path.join(HERE, "engine-double.mjs");

const MUTATION_MODE = process.argv.includes("--mutation-check");

// ── scratch lifecycle ────────────────────────────────────────────────────────
// Every tree and every session marker this battery creates is registered here and
// swept on exit AND on a signal. A battery that leaves markers behind in the OS
// temp dir would make its own once-per-session dedupe cases pass or fail
// depending on what a previous run left lying around.
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
 * Build a synthetic repo whose layout matches what the hook resolves against:
 *   <root>/.claude/hooks/ci-job-budget-guard.js   (the real hook, copied)
 *   <root>/.claude/hooks/lib/instruct-and-wait.js (the real lib, copied)
 *   <root>/.claude/bin/ci-job-budget-audit.mjs    (the double — omitted on demand)
 * The hook derives its boundary root as resolve(__dirname, "..", "..") = <root>.
 */
function makeTree({ engine = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "cjb-fx-"));
  TRASH.push(root);
  mkdirSync(path.join(root, ".claude", "hooks", "lib"), { recursive: true });
  mkdirSync(path.join(root, ".claude", "bin"), { recursive: true });
  mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  copyFileSync(HOOK_SRC, path.join(root, ".claude", "hooks", "ci-job-budget-guard.js"));
  copyFileSync(LIB_SRC, path.join(root, ".claude", "hooks", "lib", "instruct-and-wait.js"));
  if (engine) {
    copyFileSync(DOUBLE_SRC, path.join(root, ".claude", "bin", "ci-job-budget-audit.mjs"));
  }
  return root;
}

function hookIn(root) {
  return path.join(root, ".claude", "hooks", "ci-job-budget-guard.js");
}

/** Write a workflow file into the synthetic tree and return its absolute path. */
function workflow(root, name, body) {
  const p = path.join(root, ".github", "workflows", name);
  writeFileSync(p, body ?? PR_WORKFLOW);
  return p;
}

const PR_WORKFLOW = ["on:", "  pull_request:", "    branches: [main]", "", "jobs:", "  a:", "    steps:", "      - run: true"].join("\n");
const NON_PR_WORKFLOW = ["on:", "  workflow_dispatch:", "", "jobs:", "  a:", "    steps:", "      - run: true"].join("\n");

let sessionCounter = 0;
function freshSession() {
  sessionCounter += 1;
  const id = `cjbfx-${process.pid}-${sessionCounter}`;
  TRASH.push(path.join(os.tmpdir(), `coc-cjb-engine-absent-${id.replace(/[^A-Za-z0-9_-]/g, "")}`));
  return id;
}

/** Run the hook as a process. Returns the parsed payload plus raw streams. */
function runHook(root, { file, spec = {}, session = null, hook = null } = {}) {
  const payload = JSON.stringify({
    session_id: session ?? freshSession(),
    tool_input: file === undefined ? {} : { file_path: file },
  });
  const r = spawnSync("node", [hook ?? hookIn(root)], {
    input: payload,
    encoding: "utf8",
    timeout: 20000,
    env: { ...process.env, CJB_FIXTURE_SPEC: JSON.stringify(spec) },
  });
  let json = null;
  try {
    json = JSON.parse((r.stdout || "").trim());
  } catch {
    /* left null; cases that care assert on it */
  }
  const ctx =
    json && json.hookSpecificOutput ? json.hookSpecificOutput.additionalContext || "" : "";
  return {
    status: r.status,
    signal: r.signal,
    timedOut: Boolean(r.error && r.error.code === "ETIMEDOUT"),
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    json,
    ctx,
    /** true when an advisory body actually reached the agent channel */
    fired: Boolean(ctx && ctx.trim()),
  };
}

/** A spec whose single job freeloads — the canonical firing input. */
function oneOffender(overrides = {}) {
  return {
    jobs: [{ key: "wf::freeloader", pool: "pool-a" }],
    requiredContexts: [],
    decl: { budgeted: {}, pools: { "pool-a": { capacity: 4 } } },
    ...overrides,
  };
}

// ── case bookkeeping ─────────────────────────────────────────────────────────
const results = [];
function t(id, pass, detail = "") {
  results.push({ id, pass: Boolean(pass), detail });
}

function cases() {
  results.length = 0;

  // ══ ARM A — path-shape gating ══════════════════════════════════════════════
  {
    const root = makeTree();
    const wfPath = workflow(root, "pr.yml");
    const notWf = path.join(root, "src-main.rs");
    writeFileSync(notWf, "fn main() {}\n");
    const notWfDir = path.join(root, ".github", "dependabot.yml");
    writeFileSync(notWfDir, "version: 2\n");
    const yamlPath = workflow(root, "pr.yaml");

    t("A1-non-workflow-path-is-ignored",
      !runHook(root, { file: notWf, spec: oneOffender() }).fired);
    t("A2-workflow-yml-is-inspected",
      runHook(root, { file: wfPath, spec: oneOffender() }).fired);
    t("A3-workflow-yaml-extension-is-inspected",
      runHook(root, { file: yamlPath, spec: oneOffender() }).fired);
    t("A4-github-file-outside-workflows-is-ignored",
      !runHook(root, { file: notWfDir, spec: oneOffender() }).fired);
    t("A5-absent-workflow-file-is-ignored",
      !runHook(root, {
        file: path.join(root, ".github", "workflows", "does-not-exist.yml"),
        spec: oneOffender(),
      }).fired);
    t("A6-missing-tool-input-is-ignored",
      !runHook(root, { spec: oneOffender() }).fired);
  }

  // ══ ARM B — path containment (security.md § Path Containment) ══════════════
  {
    const inside = makeTree();
    const outside = makeTree();
    const insideWf = workflow(inside, "pr.yml");
    const outsideWf = workflow(outside, "pr.yml");

    // B1/B2 are ONE instrument read twice. B1's silence means "contained out"
    // only because B2 proves the identical content INSIDE the boundary fires.
    t("B1-workflow-outside-the-boundary-root-is-refused",
      !runHook(inside, { file: outsideWf, spec: oneOffender() }).fired);
    t("B2-control-identical-workflow-inside-the-boundary-fires",
      runHook(inside, { file: insideWf, spec: oneOffender() }).fired);

    // A symlink at a LEXICALLY-contained path whose target escapes. This is the
    // case a `path.resolve`-only check passes: resolve() collapses `..` and
    // nothing else, so only realpath on BOTH sides refuses it.
    const escaping = path.join(inside, ".github", "workflows", "escape.yml");
    symlinkSync(outsideWf, escaping);
    t("B3-symlink-escaping-the-boundary-is-refused",
      !runHook(inside, { file: escaping, spec: oneOffender() }).fired);

    const internal = path.join(inside, ".github", "workflows", "internal-link.yml");
    symlinkSync(insideWf, internal);
    t("B4-control-symlink-resolving-inside-the-boundary-fires",
      runHook(inside, { file: internal, spec: oneOffender() }).fired);

    const dangling = path.join(inside, ".github", "workflows", "dangling.yml");
    symlinkSync(path.join(outside, ".github", "workflows", "nope.yml"), dangling);
    const dr = runHook(inside, { file: dangling, spec: oneOffender() });
    t("B5-unresolvable-path-is-refused-without-crashing",
      !dr.fired && dr.status === 0, `status=${dr.status}`);
  }

  // ══ ARM C — read discipline (fd, FIFO, size cap) ═══════════════════════════
  {
    const root = makeTree();
    const fifo = path.join(root, ".github", "workflows", "fifo.yml");
    const mk = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    if (mk.status === 0) {
      const started = Date.now();
      const r = runHook(root, { file: fifo, spec: oneOffender() });
      const elapsed = Date.now() - started;
      // The FIFO is the case that hung PAST the hook's own 5s timer upstream: a
      // setTimeout callback cannot fire while a synchronous read blocks the loop,
      // so only O_NONBLOCK at `open` bounds it. 12s is well inside the 20s spawn
      // timeout and well outside a normal ~200ms run.
      t("C1-fifo-does-not-hang-the-hook",
        !r.timedOut && elapsed < 12000, `elapsed=${elapsed}ms timedOut=${r.timedOut}`);
      t("C2-fifo-produces-no-advisory", !r.fired);
      try { unlinkSync(fifo); } catch { /* swept with the tree */ }
    } else {
      // Never silently skip: a case that did not run is not a case that passed.
      t("C1-fifo-does-not-hang-the-hook", false, "mkfifo unavailable on this host");
      t("C2-fifo-produces-no-advisory", false, "mkfifo unavailable on this host");
    }

    const regular = workflow(root, "regular.yml");
    t("C3-control-regular-file-at-a-workflow-path-fires",
      runHook(root, { file: regular, spec: oneOffender() }).fired);

    const big = path.join(root, ".github", "workflows", "big.yml");
    writeFileSync(big, `${PR_WORKFLOW}\n# ${"x".repeat(600 * 1024)}\n`);
    t("C4-file-over-the-size-cap-is-refused",
      !runHook(root, { file: big, spec: oneOffender() }).fired);

    const nearCap = path.join(root, ".github", "workflows", "near-cap.yml");
    writeFileSync(nearCap, `${PR_WORKFLOW}\n# ${"x".repeat(400 * 1024)}\n`);
    t("C5-control-file-under-the-size-cap-fires",
      runHook(root, { file: nearCap, spec: oneOffender() }).fired);

    const dir = path.join(root, ".github", "workflows", "a-directory.yml");
    mkdirSync(dir);
    t("C6-non-regular-file-is-refused",
      !runHook(root, { file: dir, spec: oneOffender() }).fired);
  }

  // ══ ARM D — engine ABSENT: fail open, but never silently ═══════════════════
  // This is the arm that separates this hook from the upstream original, which
  // returned quiet here and would have shipped as inert coverage to every
  // consumer on the ALWAYS_INCLUDE surface.
  {
    const noEngine = makeTree({ engine: false });
    const prWf = workflow(noEngine, "pr.yml");
    const nonPrWf = workflow(noEngine, "dispatch.yml", NON_PR_WORKFLOW);

    const d1 = runHook(noEngine, { file: prWf, spec: oneOffender() });
    t("D1-engine-absent-emits-an-advisory", d1.fired, d1.ctx.slice(0, 120));
    t("D2-engine-absent-advisory-says-the-check-did-not-run",
      /NOT CHECKED/.test(d1.ctx) && /was classified|no job/i.test(d1.ctx), d1.ctx.slice(0, 200));
    t("D3-engine-absent-advisory-names-what-is-unchecked",
      /required context/i.test(d1.ctx) &&
      /relevance-gated/i.test(d1.ctx) &&
      /budgeted/i.test(d1.ctx) &&
      /capacity/i.test(d1.ctx));
    t("D4-engine-absent-advisory-is-not-a-finding-about-the-edit",
      /coverage gap, not a finding/i.test(d1.ctx) && /edit stands/i.test(d1.ctx));
    t("D5-engine-absent-still-lets-the-edit-stand",
      d1.json && d1.json.continue === true && d1.status === 0,
      `continue=${d1.json && d1.json.continue} status=${d1.status}`);
    t("D6-engine-absent-names-the-cascading-engine-path",
      /\.claude\/bin\/ci-job-budget-audit\.mjs/.test(d1.ctx));

    t("D7-engine-absent-stays-quiet-on-a-non-pull-request-workflow",
      !runHook(noEngine, { file: nonPrWf, spec: oneOffender() }).fired);

    // Dedupe: same session → once. Different session → again. Both poles, because
    // a dedupe that never resets is indistinguishable from a guard that fired once
    // and then broke.
    const sess = freshSession();
    const first = runHook(noEngine, { file: prWf, spec: oneOffender(), session: sess });
    const second = runHook(noEngine, { file: prWf, spec: oneOffender(), session: sess });
    t("D8-engine-absent-notice-fires-once-per-session", first.fired && !second.fired,
      `first=${first.fired} second=${second.fired}`);
    const third = runHook(noEngine, { file: prWf, spec: oneOffender() });
    t("D9-control-a-new-session-gets-the-notice-again", third.fired);

    // The pole that matters most: with the engine PRESENT the coverage-gap notice
    // must never appear, or every consumer would read a permanent false gap.
    const withEngine = makeTree();
    const wf2 = workflow(withEngine, "pr.yml");
    const e = runHook(withEngine, { file: wf2, spec: oneOffender() });
    t("D10-control-engine-present-emits-no-coverage-gap-notice",
      e.fired && !/NOT CHECKED/.test(e.ctx), e.ctx.slice(0, 120));
  }

  // ══ ARM E — classification presentation ═══════════════════════════════════
  {
    const root = makeTree();
    const wf = workflow(root, "pr.yml");

    const e1 = runHook(root, { file: wf, spec: oneOffender() });
    t("E1-offender-key-is-named", /wf::freeloader/.test(e1.ctx), e1.ctx.slice(0, 200));
    t("E2-offender-pool-is-named", /pool: pool-a/.test(e1.ctx));
    t("E3-advisory-characterizes-the-cost",
      /consumes a runner slot on every/i.test(e1.ctx) && /cannot block a merge/i.test(e1.ctx));

    t("E4-required-job-is-not-listed",
      !runHook(root, {
        file: wf,
        spec: oneOffender({ jobs: [{ key: "wf::gate", pool: "pool-a", required: true }] }),
      }).fired);
    t("E5-relevance-gated-job-is-not-listed",
      !runHook(root, {
        file: wf,
        spec: oneOffender({ jobs: [{ key: "wf::heavy", pool: "pool-a", gated: true }] }),
      }).fired);
    t("E6-budgeted-job-is-not-listed",
      !runHook(root, {
        file: wf,
        spec: oneOffender({ jobs: [{ key: "wf::declared", pool: "pool-a", budgeted: true }] }),
      }).fired);
    t("E7-job-unreachable-from-a-pull-request-is-not-listed",
      !runHook(root, {
        file: wf,
        spec: oneOffender({ jobs: [{ key: "wf::push-only", pool: "pool-a", isNull: true }] }),
      }).fired);
    t("E8-workflow-not-triggered-on-pull-request-is-not-inspected",
      !runHook(root, {
        file: wf,
        spec: oneOffender({ triggersOnPullRequest: false }),
      }).fired);
    t("E9-empty-job-set-produces-no-advisory",
      !runHook(root, { file: wf, spec: oneOffender({ jobs: [] }) }).fired);
    t("E10-a-job-with-no-pool-is-named-as-undeclared",
      /UNDECLARED POOL/.test(
        runHook(root, {
          file: wf,
          spec: oneOffender({ jobs: [{ key: "wf::nopool", pool: null }] }),
        }).ctx,
      ));

    // Mixed set: the offender surfaces and the three accounted siblings do not.
    const mixed = runHook(root, {
      file: wf,
      spec: oneOffender({
        jobs: [
          { key: "wf::gate", pool: "pool-a", required: true },
          { key: "wf::heavy", pool: "pool-a", gated: true },
          { key: "wf::declared", pool: "pool-a", budgeted: true },
          { key: "wf::freeloader", pool: "pool-a" },
        ],
      }),
    });
    t("E11-mixed-set-lists-only-the-freeloader",
      /wf::freeloader/.test(mixed.ctx) &&
      !/wf::gate/.test(mixed.ctx) &&
      !/wf::heavy/.test(mixed.ctx) &&
      !/wf::declared/.test(mixed.ctx) &&
      /^.*1 job\(s\)/m.test(mixed.ctx), mixed.ctx.slice(0, 240));

    // Cap + elision. A truncated list the reader cannot detect is worse than a
    // short one, so the elided COUNT is asserted, not just the truncation.
    const many = Array.from({ length: 25 }, (_, i) => ({ key: `wf::j${i}`, pool: "pool-a" }));
    const capped = runHook(root, { file: wf, spec: oneOffender({ jobs: many }) });
    t("E12-over-cap-list-is-truncated-at-twenty",
      /wf::j19/.test(capped.ctx) && !/wf::j20/.test(capped.ctx));
    t("E13-over-cap-list-names-the-elided-count",
      /and 5 more/.test(capped.ctx), capped.ctx.slice(-200));
    t("E14-over-cap-advisory-reports-the-full-total",
      /25 job\(s\)/.test(capped.ctx));

    const exactly20 = Array.from({ length: 20 }, (_, i) => ({ key: `wf::k${i}`, pool: "pool-a" }));
    const atCap = runHook(root, { file: wf, spec: oneOffender({ jobs: exactly20 }) });
    t("E15-control-at-cap-emits-no-elision-line",
      !/more \(run the audit/.test(atCap.ctx) && /wf::k19/.test(atCap.ctx));
  }

  // ══ ARM F — degraded declaration: loud, never silent ═══════════════════════
  {
    const root = makeTree();
    const wf = workflow(root, "pr.yml");

    const f1 = runHook(root, {
      file: wf,
      spec: oneOffender({ declThrows: "declaration is malformed" }),
    });
    t("F1-malformed-declaration-still-produces-the-advisory", f1.fired);
    t("F2-malformed-declaration-is-named-in-the-advisory",
      /declaration was UNAVAILABLE/.test(f1.ctx) && /declaration is malformed/.test(f1.ctx),
      f1.ctx.slice(0, 200));
    t("F3-malformed-declaration-says-classification-is-incomplete",
      /Classification is incomplete/.test(f1.ctx));

    const f4 = runHook(root, {
      file: wf,
      spec: oneOffender({ requiredThrows: "required contexts unreadable" }),
    });
    t("F4-unreadable-required-set-is-named-in-the-advisory",
      f4.fired && /required-context set was UNAVAILABLE/.test(f4.ctx));

    const f5 = runHook(root, {
      file: wf,
      spec: oneOffender({
        declThrows: "declaration is malformed",
        requiredThrows: "required contexts unreadable",
      }),
    });
    t("F5-both-degradations-are-reported-together",
      /declaration was UNAVAILABLE/.test(f5.ctx) &&
      /required-context set was UNAVAILABLE/.test(f5.ctx));
    t("F6-degraded-run-still-lists-the-offender", /wf::freeloader/.test(f5.ctx));

    const f7 = runHook(root, { file: wf, spec: oneOffender() });
    t("F7-control-healthy-declaration-adds-no-degradation-note",
      f7.fired && !/UNAVAILABLE/.test(f7.ctx), f7.ctx.slice(0, 120));
  }

  // ══ ARM G — output contract ═══════════════════════════════════════════════
  {
    const root = makeTree();
    const wf = workflow(root, "pr.yml");
    const g = runHook(root, { file: wf, spec: oneOffender() });
    t("G1-exit-code-is-zero-when-firing", g.status === 0, `status=${g.status}`);
    t("G2-payload-continues-the-session", g.json && g.json.continue === true);
    t("G3-payload-never-denies-the-tool-call",
      !/permissionDecision/.test(g.stdout) && !/"continue":false/.test(g.stdout.replace(/\s/g, "")));
    t("G4-body-reaches-the-agent-via-additionalContext",
      g.json && g.json.hookSpecificOutput &&
      g.json.hookSpecificOutput.hookEventName === "PostToolUse" &&
      typeof g.json.hookSpecificOutput.additionalContext === "string");
    t("G5-severity-renders-as-advisory-not-block",
      /\[ADVISORY\]/.test(g.stderr) && !/\[BLOCK\]/.test(g.stderr), g.stderr.slice(0, 160));
    t("G6-user-summary-line-is-emitted", /ungated non-gating CI job/.test(g.stderr));

    const quietRun = runHook(root, { file: wf, spec: oneOffender({ jobs: [] }) });
    t("G7-control-quiet-path-still-emits-a-continue-payload",
      quietRun.json && quietRun.json.continue === true && quietRun.status === 0);
    t("G8-control-quiet-path-writes-no-user-summary", quietRun.stderr.trim() === "",
      quietRun.stderr.slice(0, 120));
  }

  // ══ ARM H — hostile input + cascade hygiene ═══════════════════════════════
  {
    const root = makeTree();
    const wf = workflow(root, "pr.yml");

    // A job key carrying newlines must not forge extra bullet lines. The engine
    // is a boundary the hook does not control, so a hostile row is in scope.
    const h1 = runHook(root, {
      file: wf,
      spec: oneOffender({
        jobs: [{ key: "wf::x\n  - forged::row  (pool: fake)", pool: "pool-a" }],
      }),
    });
    // The advisory body legitimately contains OTHER `  - ` bullets (the rendered
    // `agent_must_report` items), so a bare bullet tally is the wrong instrument
    // — it counts something the hypothesis does not distinguish. Two properties
    // are asserted instead: exactly ONE offender row (rows are the only lines
    // carrying `(pool:`), and no line ANYWHERE that the injected text forged.
    // Count LINES that are offender rows, not `(pool:` OCCURRENCES. Sanitizing a
    // newline to a space folds injected text onto the row it was injected into,
    // so a substring tally reports 2 for a body that has exactly one row — a
    // tally that counts something the hypothesis does not distinguish
    // (instrument-discipline MUST-3(b): read the hits, and know what a count
    // COUNTS). This was measured here, not reasoned: the substring form reported
    // poolRows=2 with forged=false on a correctly-sanitized body.
    const FORGED = /^\s*- forged/m;
    const poolRows = (s) =>
      String(s).split("\n").filter((l) => /^\s*- .*\(pool:/.test(l)).length;
    t("H1-newline-in-a-job-key-cannot-forge-a-list-row",
      h1.fired && poolRows(h1.ctx) === 1 && !FORGED.test(h1.ctx),
      `poolRows=${poolRows(h1.ctx)} forged=${FORGED.test(h1.ctx)}`);

    const h2 = runHook(root, {
      file: wf,
      spec: oneOffender({ jobs: [{ key: "wf::y", pool: "pool\n- forged" }] }),
    });
    t("H2-newline-in-a-pool-name-cannot-forge-a-list-row",
      h2.fired && poolRows(h2.ctx) === 1 && !FORGED.test(h2.ctx));

    const h3 = runHook(root, {
      file: wf,
      spec: oneOffender({ declThrows: "boom\n  - forged::row  (pool: fake)" }),
    });
    t("H3-newline-in-a-degradation-message-cannot-forge-a-list-row",
      h3.fired && poolRows(h3.ctx) === 1 && !FORGED.test(h3.ctx));

    // CONTROL for H1–H3: the forged-row matcher fired against text that DOES
    // carry the injection, so an absence above is a real negative and not a
    // matcher that cannot fire here (instrument-discipline MUST-3(a)).
    t("H3b-control-the-forged-row-matcher-fires-on-a-known-positive",
      FORGED.test("  - wf::x\n  - forged::row  (pool: fake)") &&
      poolRows("  - a  (pool: p)\n  - forged  (pool: q)") === 2);

    // knowledge-cascade-routing MUST-3: this hook ships to every consumer and to
    // the public fork. Assert on the SHIPPED SOURCE, with a fired control below
    // so an empty result cannot be read as clean.
    // The patterns are STRUCTURAL, and deliberately name no real label, host or
    // operator: this battery cascades too, so a detector that spelled out an
    // actual runner label would carry the very disclosure it exists to refuse.
    // Each carries its own synthetic positive below.
    const shipped = readFileSync(HOOK_SRC, "utf8");
    const forbidden = [
      { re: /\bself-hosted\b/, fires: "runs-on: [self-hosted, a-label]" },
      { re: /^\s*runs-on:/m, fires: "  runs-on: ubuntu-latest" },
      { re: /\brunner-\d+\b/, fires: "assigned to runner-17" },
      // The known-positive uses the `me` placeholder specifically. This file is
      // itself on the SYNCED surface, so `scan-synced-disclosure.mjs` reads this
      // literal: `/Users/me/` is one of its documented benign-placeholder
      // allowlist entries ("the canonical `me` placeholder … none correlate to
      // the operator"), whereas a realistic-looking stem — `someone`, `jdoe`,
      // `fakeuser` — is flagged `[SHAPE:operator-home-path]` and REDS the
      // disclosure gate (measured: `me` exit 0, the other three exit 1). Do not
      // "improve" this to a more human-looking name. It still matches the
      // `[a-z]` the pattern requires, so H5's control is unweakened.
      { re: /\/Users\/[a-z]/i, fires: "/Users/me/repos/a-repo" },
      { re: /\bscripts\/ci\//, fires: "node scripts/ci/a-script.mjs" },
    ];
    const hits = forbidden.filter((f) => f.re.test(shipped)).map((f) => String(f.re));
    t("H4-shipped-hook-carries-no-runner-label-host-id-or-internal-path",
      hits.length === 0, hits.join(", "));
    // CONTROL for H4, per pattern rather than per list. A `some()` control passes
    // when ONE pattern works and four are dead, so it cannot tell a sound matcher
    // set from a mostly-broken one — H4's empty result would then be
    // indistinguishable from a sweep that could not fire (instrument-discipline
    // MUST-3(a)).
    const dead = forbidden.filter((f) => !f.re.test(f.fires)).map((f) => String(f.re));
    t("H5-control-every-disclosure-pattern-fires-on-its-own-known-positive",
      dead.length === 0, dead.join(", "));

    t("H6-shipped-hook-resolves-the-engine-under-claude-bin",
      /"bin",\s*"ci-job-budget-audit\.mjs"/.test(shipped));
    t("H7-shipped-hook-declares-no-block-severity",
      !/severity:\s*"block"/.test(shipped));
    t("H8-control-the-severity-matcher-fires-on-a-known-positive",
      /severity:\s*"block"/.test('severity: "block",'));
  }

  // ══ ARM I — malformed hook input ══════════════════════════════════════════
  {
    const root = makeTree();
    const bad = spawnSync("node", [hookIn(root)], {
      input: "not json at all",
      encoding: "utf8",
      timeout: 20000,
      env: { ...process.env, CJB_FIXTURE_SPEC: "{}" },
    });
    t("I1-non-json-stdin-exits-clean", bad.status === 0, `status=${bad.status}`);
    t("I2-non-json-stdin-still-continues", /"continue":\s*true/.test(bad.stdout || ""));

    const empty = spawnSync("node", [hookIn(root)], {
      input: "",
      encoding: "utf8",
      timeout: 20000,
      env: { ...process.env, CJB_FIXTURE_SPEC: "{}" },
    });
    t("I3-empty-stdin-exits-clean", empty.status === 0, `status=${empty.status}`);

    // A notebook edit carries `notebook_path`, not `file_path`. It is never a
    // workflow path, so the guard must ignore it rather than crash on the shape.
    const nb = spawnSync("node", [hookIn(root)], {
      input: JSON.stringify({
        session_id: freshSession(),
        tool_input: { notebook_path: path.join(root, "notes.ipynb") },
      }),
      encoding: "utf8",
      timeout: 20000,
      env: { ...process.env, CJB_FIXTURE_SPEC: "{}" },
    });
    t("I4-notebook-path-shape-is-handled", nb.status === 0 && !/additionalContext/.test(nb.stdout || ""));
  }

  return results;
}

// ── mutation mode ────────────────────────────────────────────────────────────
// Each mutant rewrites ONLY the hook COPY inside a throwaway temp tree. The
// tracked source is never touched — the upstream battery this was ported from
// rewrote its own subject in place, and a reviewer correctly declined to run it
// for that reason.
//
// A mutant that does NOT red its named case leaves TWO live hypotheses (vacuous
// case, or inert mutation), so the report says UNRESOLVED and names both rather
// than declaring the case vacuous (instrument-discipline MUST-2(b)). The
// `applied` check below closes the inert half: a mutation whose search text was
// not found is reported as NOT APPLIED and never scored.
const MUTANTS = [
  {
    id: "mutant-engine-absent-goes-silent",
    engine: false,
    find: "      if (!looksPullRequestTriggered(src)) return quiet();",
    with: "      if (!looksPullRequestTriggered(src)) return quiet();\n      return quiet();",
    killedBy: "D1-engine-absent-emits-an-advisory",
  },
  {
    // Killed by the containment ARM (both poles), not by the escape case alone.
    // MEASURED: with only the escape case, this mutant SURVIVED — dropping the
    // candidate-side realpath while the boundary root stays realpath'd makes the
    // guard refuse EVERYTHING on a host whose temp dir is itself a symlink, so
    // the escape stays refused for the wrong reason. Reading that survival as
    // "the case is vacuous" would have been the wrong one of the two hypotheses
    // (instrument-discipline MUST-2(b)); the mutation was real and the KILL
    // CRITERION was under-specified. The sound criterion is the pair: contained
    // paths must still fire.
    id: "mutant-containment-uses-lexical-resolve",
    engine: true,
    find: "      resolved = fs.realpathSync(path.resolve(file));",
    with: "      resolved = path.resolve(file);",
    killedBy: "B3+B4-containment-arm-both-poles",
  },
  {
    id: "mutant-drops-the-nonblock-flag",
    engine: true,
    find: "        fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0),",
    with: "        fs.constants.O_RDONLY,",
    killedBy: "C1-fifo-does-not-hang-the-hook",
  },
  {
    id: "mutant-removes-the-size-cap",
    engine: true,
    find: "      if (st.size > 512 * 1024) return quiet();",
    with: "      if (st.size > 512 * 1024 * 1024) return quiet();",
    killedBy: "C4-file-over-the-size-cap-is-refused",
  },
  {
    id: "mutant-truncates-without-saying-so",
    engine: true,
    find: "      ? `\\n  ... and ${offenders.length - CAP} more (run the audit for the full list)`",
    with: '      ? ""',
    killedBy: "E13-over-cap-list-names-the-elided-count",
  },
  {
    id: "mutant-swallows-a-degraded-declaration",
    engine: true,
    find: "      declUnavailable = safeName(e && e.message);",
    with: "      declUnavailable = null;",
    killedBy: "F2-malformed-declaration-is-named-in-the-advisory",
  },
  {
    id: "mutant-stops-sanitizing-job-keys",
    engine: true,
    find: "        key: safeName(row.key),",
    with: "        key: row.key,",
    killedBy: "H1-newline-in-a-job-key-cannot-forge-a-list-row",
  },
  {
    // MEASURED: this mutant first SURVIVED because the harness inferred engine
    // presence from the mutant's ID, so the engine-absent branch it mutates was
    // never reached — the INERT half of the two hypotheses, resolved rather than
    // recorded as a vacuity verdict. Engine presence is now DECLARED per mutant.
    id: "mutant-escalates-to-block",
    engine: false,
    find: '        severity: "advisory",\n        what_happened:\n          `CI JOB BUDGET — NOT CHECKED.',
    with: '        severity: "block",\n        what_happened:\n          `CI JOB BUDGET — NOT CHECKED.',
    killedBy: "D5-engine-absent-still-lets-the-edit-stand",
  },
];

function runMutations() {
  const pristine = readFileSync(HOOK_SRC, "utf8");
  const problems = [];
  for (const m of MUTANTS) {
    if (!pristine.includes(m.find)) {
      problems.push(`${m.id}: NOT APPLIED — search text absent from the hook source (the mutant is stale, not the hook wrong)`);
      continue;
    }
    const tmp = mkdtempSync(path.join(os.tmpdir(), "cjb-mut-"));
    TRASH.push(tmp);
    const mutatedHook = path.join(tmp, "ci-job-budget-guard.js");
    mkdirSync(path.join(tmp, "lib"), { recursive: true });
    copyFileSync(LIB_SRC, path.join(tmp, "lib", "instruct-and-wait.js"));
    writeFileSync(mutatedHook, pristine.replace(m.find, m.with));

    // Run only the ONE case the mutant names, against a tree whose hook copy is
    // swapped for the mutant. Cheaper than the whole battery and isolates the arm.
    const root = makeTree({ engine: m.engine !== false });
    copyFileSync(mutatedHook, hookIn(root));
    const wf = workflow(root, "pr.yml");
    const verdict = mutationVerdict(m, root, wf);
    if (verdict !== "killed") problems.push(`${m.id}: ${verdict}`);
    process.stdout.write(
      `${verdict === "killed" ? "PASS" : "FAIL"} ${m.id} [killedBy ${m.killedBy}] — ${verdict}\n`,
    );
  }
  return problems;
}

/** Re-runs the single behaviour a mutant is supposed to break. */
function mutationVerdict(m, root, wf) {
  switch (m.killedBy) {
    case "D1-engine-absent-emits-an-advisory":
      return runHook(root, { file: wf, spec: oneOffender() }).fired
        ? "UNRESOLVED — mutant survived; either the case is vacuous or the mutation was inert"
        : "killed";
    case "B3+B4-containment-arm-both-poles": {
      const outside = makeTree();
      const outWf = workflow(outside, "pr.yml");
      const escape = path.join(root, ".github", "workflows", "escape.yml");
      symlinkSync(outWf, escape);
      const internal = path.join(root, ".github", "workflows", "internal-link.yml");
      symlinkSync(wf, internal);
      const escaped = runHook(root, { file: escape, spec: oneOffender() }).fired;
      const contained = runHook(root, { file: internal, spec: oneOffender() }).fired;
      // Killed if EITHER pole broke: the escape got through, or a contained path
      // stopped being inspected.
      return escaped || !contained
        ? "killed"
        : "UNRESOLVED — mutant survived; either the case is vacuous or the mutation was inert";
    }
    case "C1-fifo-does-not-hang-the-hook": {
      const fifo = path.join(root, ".github", "workflows", "fifo.yml");
      if (spawnSync("mkfifo", [fifo]).status !== 0) return "SKIPPED — mkfifo unavailable";
      const started = Date.now();
      const r = runHook(root, { file: fifo, spec: oneOffender() });
      const elapsed = Date.now() - started;
      return r.timedOut || elapsed >= 12000
        ? "killed"
        : `UNRESOLVED — mutant survived (elapsed=${elapsed}ms); either the case is vacuous or the mutation was inert`;
    }
    case "C4-file-over-the-size-cap-is-refused": {
      const big = path.join(root, ".github", "workflows", "big.yml");
      writeFileSync(big, `${PR_WORKFLOW}\n# ${"x".repeat(600 * 1024)}\n`);
      return runHook(root, { file: big, spec: oneOffender() }).fired
        ? "killed"
        : "UNRESOLVED — mutant survived; either the case is vacuous or the mutation was inert";
    }
    case "E13-over-cap-list-names-the-elided-count": {
      const many = Array.from({ length: 25 }, (_, i) => ({ key: `wf::j${i}`, pool: "pool-a" }));
      return /and 5 more/.test(runHook(root, { file: wf, spec: oneOffender({ jobs: many }) }).ctx)
        ? "UNRESOLVED — mutant survived; either the case is vacuous or the mutation was inert"
        : "killed";
    }
    case "F2-malformed-declaration-is-named-in-the-advisory":
      return /declaration was UNAVAILABLE/.test(
        runHook(root, { file: wf, spec: oneOffender({ declThrows: "declaration is malformed" }) }).ctx,
      )
        ? "UNRESOLVED — mutant survived; either the case is vacuous or the mutation was inert"
        : "killed";
    case "H1-newline-in-a-job-key-cannot-forge-a-list-row": {
      const r = runHook(root, {
        file: wf,
        spec: oneOffender({ jobs: [{ key: "wf::x\n  - forged::row  (pool: fake)", pool: "pool-a" }] }),
      });
      return (r.ctx.match(/^ {2}- /gm) || []).length > 1
        ? "killed"
        : "UNRESOLVED — mutant survived; either the case is vacuous or the mutation was inert";
    }
    case "D5-engine-absent-still-lets-the-edit-stand": {
      const r = runHook(root, { file: wf, spec: oneOffender() });
      return r.json && r.json?.hookSpecificOutput?.permissionDecision === "deny"
        ? "killed"
        : "UNRESOLVED — mutant survived; either the case is vacuous or the mutation was inert";
    }
    default:
      return `UNRESOLVED — no verdict procedure for ${m.killedBy}`;
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
if (!existsSync(HOOK_SRC)) {
  process.stderr.write(`FAIL harness — hook under test not found: ${HOOK_SRC}\n`);
  process.exit(1);
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
