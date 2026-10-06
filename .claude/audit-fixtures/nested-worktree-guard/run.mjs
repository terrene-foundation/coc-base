#!/usr/bin/env node
/**
 * run.mjs — fixture harness for `.claude/hooks/nested-worktree-guard.js`.
 *
 * Per cc-artifacts.md Rule 9 + hook-output-discipline.md MUST-4, a detector
 * ships with a committed fixture per scope-restriction predicate it relies on.
 * This harness covers three predicate classes and one meta-property:
 *
 *   (a) FLAG  — a payload carrying the literal `isolation: "worktree"`, or an
 *               `EnterWorktree` whose RESOLVED target is a nested placement,
 *               MUST be blocked (exit 2 / continue:false).
 *   (b) CLEAN — an ordinary call on the registered matcher MUST pass through.
 *               A wedge here wedges every delegation in the repo.
 *   (c) EDGE  — no stdin / empty stdin / malformed JSON / non-string isolation
 *               MUST fail OPEN (cc-artifacts.md Rule 7).
 *   (d) MUTATION — `--mutation-check` proves this fixture set can actually go
 *               RED. A fixture suite that passes against a DEFEATED guard is
 *               the same inert-green failure the guard itself exists to close.
 *
 * The load-bearing negative control is
 * `clean-prose-mentions-isolation-worktree.json`: a Task whose PROMPT TEXT
 * contains the literal characters `isolation: "worktree"` but whose tool_input
 * carries no such PARAMETER. It MUST pass. That fixture is what distinguishes
 * a structural detector (reads the field the harness acts on) from a lexical
 * one (greps the payload) — and mutation M3 below proves it is load-bearing.
 *
 * Usage:
 *   node .claude/audit-fixtures/nested-worktree-guard/run.mjs
 *   node .claude/audit-fixtures/nested-worktree-guard/run.mjs --mutation-check
 *   node .claude/audit-fixtures/nested-worktree-guard/run.mjs --json
 * Exit: 0 = every case matched expectation; 1 = at least one did not.
 */
import "../_lib/no-ambient-git.cjs";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOKS = path.resolve(HERE, "..", "..", "hooks");
const HOOK = path.join(HOOKS, "nested-worktree-guard.js");

// The hook resolves the receipt (and its git boundary roots) RELATIVE TO ITS OWN
// CWD, while this harness writes the receipt at an ABSOLUTE path. Left to
// inherit, the two agree only when the suite happens to be launched from the
// repo root — from the fixture directory the receipt row would fail and, worse,
// `--mutation-check` would report `FAIL M0-control`, which by the design below
// makes every KILLED verdict meaningless. Pinning the child's cwd makes the
// suite answer the same way from anywhere.
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

// The operator running this suite is, by construction, the person most likely
// to have set the escape hatch after hitting the block. Inheriting it would
// make every `flag-` fixture pass through and the whole suite meaningless, so
// it is stripped from the base env and only the explicit `<escape>` rows opt
// back in. Same reasoning for a stray receipt left on disk (handled below).
const BASE_ENV = { ...process.env };
delete BASE_ENV.COC_ALLOW_NESTED_WORKTREE;

/** Run a hook binary against a raw stdin string; classify the verdict. */
function probe(hookPath, input, env = {}, cwd = REPO_ROOT) {
  const r = spawnSync(process.execPath, [hookPath], {
    input,
    encoding: "utf8",
    timeout: 20000,
    cwd,
    env: { ...BASE_ENV, ...env },
  });
  const stdout = (r.stdout || "").trim();
  const stderr = (r.stderr || "").trim();
  const exit = r.status;

  // A crash is a stack trace with an exit outside the sanctioned {0, 2}.
  // Exit 2 at PreToolUse is the DELIBERATE deny channel, not a crash.
  const threw =
    /^\s*(?:[A-Za-z]*Error|Uncaught|node:internal)/m.test(stderr) &&
    exit !== 0 &&
    exit !== 2;
  const blocked = exit === 2 || /"continue"\s*:\s*false/.test(stdout);

  let verdict;
  if (r.error) verdict = `CRASH(${r.error.code || r.error.message})`;
  else if (threw) verdict = "THREW";
  else if (blocked) verdict = "BLOCKED";
  else verdict = "PASSTHROUGH";
  return { verdict, exit, stdout, stderr };
}

/** Build the case list: fixture files (prefix-typed) + inline edge cases. */
function buildCases() {
  const cases = [];
  for (const f of readdirSync(HERE)
    .filter((n) => n.endsWith(".json"))
    .sort()) {
    // Prefix typing is the expectation source, so an unrecognized prefix MUST
    // fail loudly rather than silently defaulting to PASSTHROUGH — a typo'd
    // `flg-` fixture intended to block would otherwise be asserted to pass.
    if (!f.startsWith("flag-") && !f.startsWith("clean-")) {
      throw new Error(
        `fixture "${f}" has no flag-/clean- prefix; expectation cannot be derived`,
      );
    }
    cases.push({
      name: f,
      input: readFileSync(path.join(HERE, f), "utf8"),
      expect: f.startsWith("flag-") ? "BLOCKED" : "PASSTHROUGH",
      env: {},
    });
  }
  // The block body is fed back to the agent as authoritative text, so an
  // untrusted `tool_name` must not smuggle control bytes or forge a second
  // status marker (`hook-output-discipline.md` MUST-1 delivery channel).
  cases.push({
    name: "<injection> control bytes stripped from emitted body",
    input: readFileSync(
      path.join(HERE, "flag-injection-in-tool-name.json"),
      "utf8",
    ),
    expect: "BLOCKED",
    env: {},
    // eslint-disable-next-line no-control-regex
    forbidStderr: /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/,
  });
  cases.push({
    name: "<injection> forged [ADVISORY] marker not reproduced",
    input: readFileSync(
      path.join(HERE, "flag-injection-in-tool-name.json"),
      "utf8",
    ),
    expect: "BLOCKED",
    env: {},
    forbidStderr: /\[ADVISORY\]/,
  });
  // EDGE class — every non-happy read path MUST fail OPEN (Rule 7).
  cases.push({
    name: "<edge> empty stdin",
    input: "",
    expect: "PASSTHROUGH",
    env: {},
  });
  cases.push({
    name: "<edge> malformed JSON",
    input: "{not json at all",
    expect: "PASSTHROUGH",
    env: {},
  });
  cases.push({
    name: "<edge> JSON null",
    input: "null",
    expect: "PASSTHROUGH",
    env: {},
  });
  // ESCAPE HATCH — the documented override must actually let the call through,
  // otherwise the block dead-ends work (hook-output-discipline.md MUST NOT
  // § "Detectors that block work the agent has been instructed to perform").
  cases.push({
    name: "<escape> env COC_ALLOW_NESTED_WORKTREE=1 lets the call through",
    input: readFileSync(
      path.join(HERE, "flag-task-isolation-worktree.json"),
      "utf8",
    ),
    expect: "PASSTHROUGH",
    env: { COC_ALLOW_NESTED_WORKTREE: "1" },
  });
  // ...and the override must be AUDITED, and audited on the channel the AGENT
  // actually reads. stderr alone is operator-only at a non-blocking PreToolUse;
  // `hookSpecificOutput.additionalContext` is the model-visible channel
  // (`lib/instruct-and-wait.js` delivery contract).
  cases.push({
    name: "<escape> override surfaces on stderr AND in additionalContext",
    input: readFileSync(
      path.join(HERE, "flag-task-isolation-worktree.json"),
      "utf8",
    ),
    expect: "PASSTHROUGH",
    env: { COC_ALLOW_NESTED_WORKTREE: "1" },
    alsoRequireStderr: /ADVISORY.*COC_ALLOW_NESTED_WORKTREE=1/,
    alsoRequireStdout: /additionalContext/,
  });
  // RECEIPT OVERRIDE — the agent-reachable channel. An env var cannot be set
  // from inside a session (a Bash `export` dies with the child shell), so the
  // one-shot receipt is what actually answers the MUST NOT. These rows prove
  // it (a) lets the call through, (b) is CONSUMED so it cannot silently disarm
  // the gate for later calls, and (c) is ignored when empty.
  cases.push({
    name: "<receipt> one-shot receipt lets the call through",
    input: readFileSync(
      path.join(HERE, "flag-task-isolation-worktree.json"),
      "utf8",
    ),
    expect: "PASSTHROUGH",
    env: {},
    setup: () => writeReceipt("sanctioned nested placement for this one shard"),
    teardown: clearReceipt,
    alsoRequireStdout: /additionalContext/,
  });
  cases.push({
    name: "<receipt> receipt is CONSUMED (second call blocks again)",
    input: readFileSync(
      path.join(HERE, "flag-task-isolation-worktree.json"),
      "utf8",
    ),
    expect: "BLOCKED",
    env: {},
    // Write the receipt, spend it on a first call, then assert the SECOND call
    // — the one this row actually measures — is blocked again.
    setup: () => {
      writeReceipt("one-shot");
      probe(
        HOOK,
        readFileSync(path.join(HERE, "flag-task-isolation-worktree.json"), "utf8"),
      );
    },
    teardown: clearReceipt,
  });
  cases.push({
    name: "<receipt> empty receipt is NOT an override",
    input: readFileSync(
      path.join(HERE, "flag-task-isolation-worktree.json"),
      "utf8",
    ),
    expect: "BLOCKED",
    env: {},
    setup: () => writeReceipt("   \n"),
    teardown: clearReceipt,
  });
  // ── PATH-TARGET class ────────────────────────────────────────────────────
  // The discriminator is the RESOLVED TARGET, never which key carried it. Each
  // row is built at setup time because it needs the REAL repo layout: a static
  // JSON fixture cannot name this machine's repo top or carry a live symlink.
  cases.push({
    name: "<path> resolved target INSIDE the repo top blocks (no .claude/worktrees segment)",
    expect: "BLOCKED",
    env: {},
    setup: () => ({
      input: enterWorktreePayload({
        path: path.join(REPO_ROOT, "wt-inside-the-repo"),
      }),
    }),
  });
  cases.push({
    // The load-bearing proof that resolution — not string comparison — is what
    // decides. The raw path is lexically OUTSIDE the repo and carries no
    // `.claude/worktrees` segment; only following the symlink reveals that an
    // agent rooted there sits inside the repo and double-loads. A lexical
    // implementation passes this and is thereby caught (mutant M10).
    name: "<path> symlink resolving back INSIDE the repo blocks (lexically outside)",
    expect: "BLOCKED",
    env: {},
    setup: () => {
      const dir = mkdtempSync(path.join(tmpdir(), "nwg-symlink-"));
      const link = path.join(dir, "link");
      symlinkSync(REPO_ROOT, link, "dir");
      return {
        dir,
        input: enterWorktreePayload({ path: path.join(link, "agent-x") }),
      };
    },
    teardown: (ctx) => rmSync(ctx.dir, { recursive: true, force: true }),
  });
  cases.push({
    // The genuine negative control for the whole path class. If this ever goes
    // BLOCKED the guard has started refusing the SANCTIONED placement, which
    // dead-ends the very remediation its own block body prescribes.
    name: "<path> real sibling worktree root passes",
    expect: "PASSTHROUGH",
    env: {},
    setup: () => ({ input: enterWorktreePayload({ path: siblingWorktreeRoot() }) }),
  });
  cases.push({
    // Re-rooting AT the repo top is not a nested worktree — it is the single
    // root. Containment must be STRICT, or the guard blocks a no-op re-root.
    name: "<path> the repo top itself passes (containment is strict)",
    expect: "PASSTHROUGH",
    env: {},
    setup: () => ({ input: enterWorktreePayload({ path: REPO_ROOT }) }),
  });
  cases.push({
    // security.md § Path Containment: "fail closed if the path will not
    // resolve". With no git boundary there is no root to compare against, so
    // the containment question is UNDECIDABLE — and an undecidable containment
    // question must be answered "contained", never waved through.
    name: "<path> no resolvable git boundary FAILS CLOSED",
    expect: "BLOCKED",
    env: {},
    setup: () => {
      const dir = mkdtempSync(path.join(tmpdir(), "nwg-nogit-"));
      return {
        dir,
        cwd: dir, // outside any git repo
        input: enterWorktreePayload({ path: path.join(dir, "some-worktree") }),
      };
    },
    teardown: (ctx) => rmSync(ctx.dir, { recursive: true, force: true }),
  });
  // A block must carry the canonical instructAndWait body, not a bare exit
  // (hook-output-discipline.md MUST-1).
  cases.push({
    name: "<shape> block carries actionable remediation",
    input: readFileSync(
      path.join(HERE, "flag-task-isolation-worktree.json"),
      "utf8",
    ),
    expect: "BLOCKED",
    env: {},
    alsoRequireStderr: /REPORT TO USER/,
    alsoRequireStderr2: /git worktree add -b/,
  });
  cases.push({
    name: "<shape> block names the one-shot receipt override",
    input: readFileSync(
      path.join(HERE, "flag-task-isolation-worktree.json"),
      "utf8",
    ),
    expect: "BLOCKED",
    env: {},
    alsoRequireStderr: /worktree-authz[/\\]nested-worktree-allow/,
  });
  return cases;
}

// ── path-target helpers (the resolved-target discriminator) ─────────────────
function enterWorktreePayload(toolInput) {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "EnterWorktree",
    tool_input: toolInput,
  });
}

/**
 * The SANCTIONED sibling root for this checkout, derived the same way
 * `commands/worktree.md` § 1 derives it — from the SHARED .git, so it is
 * correct whether the suite runs in the main checkout or a linked worktree.
 * Falls back to a plainly-outside path if git is unavailable, which keeps the
 * negative control meaningful rather than silently skipped.
 */
function siblingWorktreeRoot() {
  const r = spawnSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  if (r.status !== 0 || !r.stdout) {
    return path.join(path.dirname(REPO_ROOT), ".fallback-wt", "parallel-dev");
  }
  const mainTop = path.dirname(r.stdout.trim());
  const slug = path.basename(mainTop);
  return path.join(path.dirname(mainTop), `.${slug}-wt`, "parallel-dev");
}

// ── receipt helpers (the agent-reachable override channel) ──────────────────
const RECEIPT = path.resolve(
  HERE,
  "..",
  "..",
  "worktree-authz",
  "nested-worktree-allow",
);
function writeReceipt(reason) {
  mkdirSync(path.dirname(RECEIPT), { recursive: true });
  writeFileSync(RECEIPT, reason);
}
function clearReceipt() {
  try {
    rmSync(RECEIPT, { force: true });
  } catch {
    /* best effort */
  }
}

function runSuite(hookPath, { quiet = false } = {}) {
  const rows = [];
  let failures = 0;
  for (const c of buildCases()) {
    clearReceipt(); // no stray receipt from a prior aborted run
    const ctx = c.setup ? c.setup() : undefined;
    // A dynamic case may need the real repo layout (a symlink that resolves back
    // inside the repo, the actual sibling-worktree root, a non-git cwd). Those
    // build their payload at setup time and hand it back here.
    const input = ctx && ctx.input !== undefined ? ctx.input : c.input;
    const cwd = ctx && ctx.cwd !== undefined ? ctx.cwd : c.cwd;
    const r = probe(hookPath, input, c.env, cwd);
    if (c.teardown) c.teardown(ctx);
    let ok = r.verdict === c.expect;
    let note = "";
    if (ok && c.alsoRequireStderr && !c.alsoRequireStderr.test(r.stderr)) {
      ok = false;
      note = `stderr missing ${c.alsoRequireStderr}`;
    }
    if (ok && c.alsoRequireStderr2 && !c.alsoRequireStderr2.test(r.stderr)) {
      ok = false;
      note = `stderr missing ${c.alsoRequireStderr2}`;
    }
    if (ok && c.alsoRequireStdout && !c.alsoRequireStdout.test(r.stdout)) {
      ok = false;
      note = `stdout missing ${c.alsoRequireStdout}`;
    }
    if (ok && c.forbidStderr && c.forbidStderr.test(r.stderr)) {
      ok = false;
      note = `stderr contains forbidden ${c.forbidStderr}`;
    }
    if (!ok) failures++;
    rows.push({ ...c, ...r, ok, note, input: undefined, env: undefined });
    if (!quiet) {
      console.log(
        `${ok ? "ok  " : "FAIL"} ${r.verdict.padEnd(12)} exit=${String(r.exit).padEnd(4)} ` +
          `${c.name}${c.expect === "BLOCKED" ? "  [expect BLOCKED]" : ""}${note ? "  <- " + note : ""}`,
      );
      if (!ok) {
        if (r.stdout) console.log(`       stdout: ${r.stdout.slice(0, 240)}`);
        if (r.stderr) console.log(`       stderr: ${r.stderr.slice(0, 240)}`);
      }
    }
  }
  return { rows, failures };
}

/**
 * ANCHOR ARITY — a mutant anchor matching TWO sites leaves the second edge live
 * behind a mutant that LOOKS applied, and the kill is then off the one edge that
 * actually broke. `replace()` rewrites only the first occurrence, so "at least
 * one" is not good enough: EXACTLY one is the contract.
 *
 * Self-contained here rather than shared: `.claude/audit-fixtures/_lib/` carries
 * no mutation helper at loom, and adding one would widen this lane's blast
 * radius past its own fixtures.
 */
function mutateOnce(src, m) {
  let count = 0;
  let from = 0;
  for (;;) {
    const i = src.indexOf(m.anchor, from);
    if (i === -1) break;
    count++;
    from = i + m.anchor.length;
    if (count > 1) break;
  }
  if (count === 0)
    return {
      problem: `anchor DRIFTED — not found in the hook source.`,
      mutated: null,
    };
  if (count > 1)
    return {
      problem: `anchor is AMBIGUOUS — matches 2+ sites, so replace() would leave the others live.`,
      mutated: null,
    };
  return { problem: null, mutated: src.replace(m.anchor, m.to) };
}

/**
 * A0 control, the arity sibling of M0: an arity check whose own logic has rotted
 * lets an ambiguous anchor mint a kill for an edge nothing broke. Fire it at
 * known-answer inputs before trusting any of its verdicts
 * (`instrument-discipline.md` MUST-3(a)).
 */
function arityControlProblems() {
  const problems = [];
  const zero = mutateOnce("abc", { anchor: "zzz", to: "q" });
  if (!zero.problem || !/DRIFTED/.test(zero.problem))
    problems.push("a ZERO-match anchor was not reported as drifted");
  const two = mutateOnce("xx-yy-xx", { anchor: "xx", to: "q" });
  if (!two.problem || !/AMBIGUOUS/.test(two.problem))
    problems.push("a TWO-match anchor was not reported as ambiguous");
  const one = mutateOnce("aa-bb", { anchor: "bb", to: "cc" });
  if (one.problem || one.mutated !== "aa-cc")
    problems.push("a ONE-match anchor did not apply cleanly");
  return problems;
}

/**
 * Mutation harness. Each mutant is a single targeted defeat of the guard; the
 * fixture suite MUST go RED on every one. A mutant the suite still passes is a
 * hole in the fixture set, reported as a failure of THIS harness.
 */
const MUTANTS = [
  {
    id: "M1-neutered-predicate",
    doc: "detector always returns null (the 'registered but inert' class)",
    anchor: "function detectNestedWorktreeRequest(payload) {",
    to: "function detectNestedWorktreeRequest(payload) {\n  return null; // MUTANT M1",
  },
  {
    id: "M2-sync-stdin-drain",
    doc: "stdin read reverted to a synchronous drain (reads zero bytes, always passes)",
    anchor:
      "const payload = await readStdinBounded({ timeoutMs: 2000, fallback: null });",
    // The exact defective shape readStdinBounded exists to remove: a sync read
    // at call time returns null on a stream whose data has not yet arrived.
    to: "let payload = null; try { const b = process.stdin.read(); payload = b ? JSON.parse(String(b)) : null; } catch { payload = null; } // MUTANT M2",
  },
  {
    id: "M3-lexical-not-structural",
    doc: "detector greps the whole payload for the substring instead of reading the parameter (must false-positive on the prose negative control)",
    anchor: "  const input = payload.tool_input;",
    to: '  if (JSON.stringify(payload).includes("worktree")) return "worktree"; // MUTANT M3\n  const input = payload.tool_input;',
  },
  {
    id: "M4-escape-hatch-always-on",
    doc: "escape hatch treated as always armed (block never fires)",
    // RE-ANCHORED 2026-08-23: both override channels moved into the SHARED
    // `lib/override-receipt.js`, so the old `process.env[ESCAPE_ENV]` line no longer
    // exists in this hook. The harness caught the drift LOUDLY (anchor DRIFTED, exit 1)
    // rather than silently reporting the mutant killed — which is the property that
    // made this re-anchor a two-minute fix instead of an undetected hole. The mutant
    // still expresses the same defect at the new seam: an override resolved as always
    // present means the block never fires.
    anchor: "  const override = overrideGate().resolveOverride();",
    to: '  const override = { channel: "forced", detail: "forced", reason: null }; // MUTANT M4',
  },
  {
    id: "M5-no-normalization",
    doc: "isolation value compared raw (drops trim/lowercase) — locks the mixed-case fixture",
    anchor: "isolation.trim().toLowerCase() === NESTED_ISOLATION_VALUE",
    to: "isolation === NESTED_ISOLATION_VALUE /* MUTANT M5 */",
  },
  {
    id: "M6-enterworktree-blind",
    doc: "the whole EnterWorktree route removed — locks every nested-placement fixture on that tool",
    anchor: 'if (readToolName(payload) === "EnterWorktree") {',
    to: "if (false) { // MUTANT M6",
  },
  {
    // Keying on `name` WITHOUT `path` means appending a `path` key DISARMS the
    // block. Killed ONLY by `flag-enterworktree-name-plus-sibling-path.json` —
    // the name+NESTED-path fixture cannot kill it, because that one still falls
    // through to the path edge and blocks anyway.
    id: "M8-path-key-disarms-name",
    doc: "name route reverted to `hasName && !hasPath` — adding a `path` key evades the block again",
    anchor: '    if (nameVal) return { kind: "enter-worktree-name", value: nameVal };',
    to: '    if (nameVal && !pathVal) return { kind: "enter-worktree-name", value: nameVal }; // MUTANT M8',
  },
  {
    id: "M9-path-target-unchecked",
    doc: "`path` targets never classified (the assumption that any `path` form is safe)",
    anchor: "function classifyWorktreeTarget(rawPath) {",
    to: "function classifyWorktreeTarget(rawPath) {\n  return null; // MUTANT M9",
  },
  {
    id: "M10-lexical-not-realpath",
    doc: "containment compares the LEXICAL path (drops symlink resolution) — a symlink into the repo escapes",
    anchor:
      "  const tail = [];\n  // Bounded so a pathological input cannot spin inside the hook's own budget.",
    to: "  return abs; // MUTANT M10\n  // eslint-disable-next-line no-unreachable\n  const tail = [];\n  //",
  },
  {
    id: "M11-segment-edge-blind",
    doc: "`.claude/worktrees` segment edge removed — a nested placement under ANOTHER repo is missed",
    anchor: '  if (hasNestedSegments(target)) return { code: "nested-segment" };',
    to: "  // MUTANT M11 (segment edge removed)",
  },
  {
    id: "M12-fail-open-undecidable",
    doc: "unresolvable boundary/target waved through instead of failing closed (security.md § Path Containment)",
    anchor:
      '  if (boundaries.length === 0) return { code: "unresolvable-boundary" };',
    to: "  if (boundaries.length === 0) return null; // MUTANT M12",
  },
  {
    id: "M13-tool-name-fallback-dropped",
    doc: "`payload.tool` fallback dropped — the same call under the shape sibling hooks accept is missed",
    anchor:
      '  if (typeof payload.tool === "string" && payload.tool.trim() !== "")\n    return payload.tool;',
    to: "  // MUTANT M13 (tool fallback dropped)",
  },
  {
    id: "M7-unsanitized-interpolation",
    doc: "the payload-derived value is interpolated RAW — locks the control-byte / forged-marker injection fixtures",
    // RE-ANCHORED 2026-08-23: `safeField` is no longer DEFINED here — it is imported from the
    // shared `lib/override-receipt.js`, because a sanitizer duplicated across two guards is a
    // sanitizer that is wrong in one of them. The mutant therefore targets the CALL SITE that
    // actually feeds untrusted payload text into the agent-visible body, which is the behaviour
    // the injection fixtures pin. Mutating the shared definition is out of reach by design: this
    // harness copies and mutates the HOOK source only.
    //
    // MEASURED, and worth recording because it corrects an over-reading of the OLD mutant:
    // anchoring first at `safeValue: safeField(hit.value, ...)` made M7 SURVIVE. The injection
    // fixture (`flag-injection-in-tool-name.json`) carries its payload in the TOOL NAME, so the
    // only sanitizer call site this fixture set actually pins is the one below. The previous
    // mutant edited the FUNCTION DEFINITION, which made every call site identity at once and was
    // therefore killed by the single covered site — reading as though all three were covered.
    // Two of the three still are not. That is a pre-existing coverage gap this refactor exposed
    // rather than caused, and it is left named here instead of silently re-hidden.
    anchor: '  const toolName = safeField(readToolName(payload), "<unknown>");',
    to: "  const toolName = readToolName(payload); // MUTANT M7",
  },
];

/**
 * Re-root the lib requires at the real hooks dir so a mutant can run from a
 * temp directory without symlinks. Returns null if the anchor is gone (which
 * would silently produce mutants that die at `require` and look "killed").
 */
function reroot(src) {
  const ANCHOR = 'path.join(__dirname, "lib"';
  if (!src.includes(ANCHOR)) return null;
  return src.replaceAll(ANCHOR, `path.join(${JSON.stringify(HOOKS)}, "lib"`);
}

function mutationCheck() {
  const original = readFileSync(HOOK, "utf8");
  const dir = mkdtempSync(path.join(tmpdir(), "nwg-mutants-"));
  let harnessFailures = 0;
  try {
    const rerooted = reroot(original);
    if (rerooted === null) {
      console.log(
        'FAIL <control>: the `path.join(__dirname, "lib"` re-root anchor is gone. Every mutant ' +
          "would die at require() and be misreported as KILLED. Fix the harness before trusting it.",
      );
      // null, not a count: no mutant ran, so there is no kill ratio to report
      // and the caller must NOT print a MUTATION-BATTERY marker claiming one.
      return null;
    }

    // CONTROL MUTANT — the re-rooted but OTHERWISE UNMODIFIED hook. It MUST
    // pass the whole suite. Without this, a mutant that merely crashes (bad
    // re-root, missing lib, syntax error) scores fixture failures and is
    // misreported as KILLED — the suite would then claim "N/N killed" while
    // testing nothing. This is the inert-green class the guard itself exists
    // to close, one layer up.
    const controlPath = path.join(dir, "M0-control.js");
    writeFileSync(controlPath, rerooted);
    const control = runSuite(controlPath, { quiet: true });
    if (control.failures !== 0) {
      console.log(
        `FAIL M0-control                  ${control.failures} failure(s) on the UNMUTATED hook.\n` +
          `         Every later KILLED verdict would be meaningless (crash, not detection). ` +
          `Failing rows: ${control.rows
            .filter((r) => !r.ok)
            .map((r) => r.name)
            .join(", ")}`,
      );
      // Same reasoning as the re-root failure above: the battery never got to
      // run a mutant, so it has no ratio to publish.
      return null;
    }
    console.log(
      "ok   M0-control                  CLEAN (0/…) — re-rooting works, so later kills are real detections\n" +
        "         the unmutated hook passes the full suite from the temp dir",
    );

    const arityProblems = arityControlProblems();
    if (arityProblems.length) {
      console.log(
        `FAIL A0-control                  the anchor-arity check is not working:\n` +
          arityProblems.map((p) => `         - ${p}`).join("\n") +
          `\n         Every anchor below would be unverifiable, so no mutant was run.`,
      );
      return null;
    }
    console.log(
      "ok   A0-control                  anchor-arity check refuses drifted and 2+ anchors",
    );

    for (const m of MUTANTS) {
      // EXACTLY one site, not "at least one" — see mutateOnce above.
      const { problem, mutated: src } = mutateOnce(rerooted, m);
      if (problem) {
        console.log(
          `FAIL ${m.id}: ${problem} ` +
            `Update the mutant or the harness is no longer testing what it claims.`,
        );
        harnessFailures++;
        continue;
      }
      const mutantPath = path.join(dir, `${m.id}.js`);
      writeFileSync(mutantPath, src);
      const { rows, failures } = runSuite(mutantPath, { quiet: true });
      const detected = failures > 0;
      // Naming the killer rows is what lets a reviewer verify INDEPENDENCE: a
      // second belt-and-braces edge silently defeats the single-edge test for
      // the edge it duplicates, and a bare kill COUNT hides that.
      const killers = rows
        .filter((r) => !r.ok)
        .map((r) => r.name)
        .slice(0, 4)
        .join(", ");
      console.log(
        `${detected ? "ok  " : "FAIL"} ${m.id.padEnd(28)} ` +
          `${detected ? `KILLED (${failures} fixture failure(s))` : "SURVIVED — fixture set has a hole"}` +
          `\n         ${m.doc}` +
          (detected ? `\n         killed by: ${killers}` : ""),
      );
      if (!detected) harnessFailures++;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    clearReceipt();
  }
  return harnessFailures;
}

// ── main ────────────────────────────────────────────────────────────────────
if (!existsSync(HOOK)) {
  console.error(`FAIL: hook not found at ${HOOK}`);
  process.exit(1);
}

if (process.argv.includes("--mutation-check")) {
  console.log(
    `# mutation check — every mutant MUST be killed by the fixture set\n`,
  );
  const hf = mutationCheck();
  if (hf === null) {
    // The harness broke before any mutant ran (bad re-root, or the unmutated
    // hook failing its own suite). Deliberately NO MUTATION-BATTERY line: the
    // marker asserts that a battery executed, and publishing a ratio here would
    // be fabricated for mutants that never ran.
    console.log("\nNo mutants were run — the harness itself is broken.");
    process.exit(1);
  }
  console.log(
    `\n${MUTANTS.length - hf}/${MUTANTS.length} mutants killed.` +
      (hf ? `  ${hf} SURVIVED — the fixture set cannot detect that defect.` : ""),
  );
  console.log(`MUTATION-BATTERY: ${MUTANTS.length - hf}/${MUTANTS.length} killed`);
  process.exit(hf === 0 ? 0 : 1);
}

const { rows, failures } = runSuite(HOOK, {
  quiet: process.argv.includes("--json"),
});
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log(
    `\n${rows.length - failures}/${rows.length} cases matched expectation.` +
      (failures ? `  ${failures} did NOT.` : ""),
  );
}
process.exit(failures === 0 ? 0 : 1);
