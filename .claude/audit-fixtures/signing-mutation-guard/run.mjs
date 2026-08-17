#!/usr/bin/env node
/**
 * signing-mutation-guard — canonical fixture runner (coc-rs#89 AC-3).
 *
 * WHY THIS EXISTS. `.claude/audit-fixtures/signing-mutation-guard/` shipped six
 * fixtures and no runner, so nothing executed them. coc-rs#74 filed a suspected HIGH
 * fail-open against this guard on the strength of a direct fixture invocation
 * that could not be trusted precisely because there was no canonical way to
 * drive one. coc-rs#89 carved that out and named the runner as AC-3.
 *
 * THE PRECONDITION IS THE WHOLE POINT. The guard gates its ENTIRE substrate —
 * both the §4.2 sibling-porcelain check and the degraded-mode block — behind
 * `isCoordinationEnabled()` (signing-mutation-guard.js:398) and passes through
 * BEFORE either predicate is evaluated when coordination is OFF. Measured here,
 * on a real temp repo with the fixture-03 shape:
 *
 *   coordination OFF : exit 0, {"continue":true}          ← CORRECT, not fail-open
 *   coordination ON  : exit 2, {"continue":false}, deny   ← the fixture's expectation
 *
 * `.codex-mcp-guard`'s suite drives the degraded-mode lanes at a coordination-OFF
 * cwd and therefore asserts a DENY a CORRECT guard is right not to produce. That
 * is a fixture-precondition defect, not a guard defect. So this runner (a)
 * establishes coordination ON explicitly per fixture, (b) NAMES the precondition
 * in the check text so a future reader cannot mistake a precondition failure for
 * a guard failure, and (c) drives the same fixtures at a coordination-OFF repo as
 * a NEGATIVE CONTROL, so the precondition is demonstrated load-bearing rather
 * than asserted.
 *
 * INSTRUMENT DISCIPLINE (rules/instrument-discipline.md MUST-1). Every check
 * names the FALSIFYING result — what this instrument would have printed had the
 * proposition been false. MUST-2(b): the mutation table proving each check reds
 * in the behaviour's absence is recorded in README.md § "Runner discrimination".
 *
 * THE 01-vs-03/06 ASYMMETRY IS LOCKED, NOT NORMALIZED. Since loom#1323 the §4.2
 * branch (fixture 01) emits halt-and-report: sibling worktrees have physically
 * separate working trees, so the write cannot clobber the sibling's bytes and the
 * only collision is a recoverable 3-way merge conflict. `wouldMutateWorkingTree`
 * (fixtures 03 + 06) is the ONLY remaining `block` branch and stays block: an
 * unsigned mutation lands with no attributable, chain-verifiable record — the
 * IRRECOVERABLE class. T7 asserts BOTH poles so a future "consistency fix" in
 * EITHER direction reds.
 *
 *   node .claude/audit-fixtures/signing-mutation-guard/run.mjs
 *   echo $?            # 0 = all green; non-zero = at least one check failed
 *
 * Override the hook under test (to red the suite against a mutant) with:
 *   HOOK=/abs/path/to/mutant.js node .../run.mjs
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync, spawnSync } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const HOOK = process.env.HOOK || path.join(REPO, ".claude/hooks/signing-mutation-guard.js");
const require_ = createRequire(import.meta.url);

// The SHARED predicate the guard itself consults (signing-mutation-guard.js:398).
// Importing it — rather than re-deriving "is coordination on?" here — is what makes
// the precondition check attest to the SAME question the guard asks
// (rules/security.md § Enforcement-Surface Parity).
const { isCoordinationEnabled, _resetCache } = require_(
  path.join(REPO, ".claude/hooks/lib/coordination-mode.js"),
);

let pass = 0,
  fail = 0;
// Per-case lines MUST match run-audit-fixtures.mjs::CASE_PASS / CASE_FAIL
// (/^[ \t]*(?:PASS|ok)[ \t]+\S/ and /^[ \t]*(?:FAIL|not ok)[ \t]+\S/). A "  ✓ <name>"
// line matches NEITHER: the harness then counted ONE case here — the summary line —
// against a declared min_cases of 44, so the runner passed when run directly and was
// REJECTED by CI. Worse, with no parseable per-case line an ALL-FAILING run still
// presents as 1p/0f. Keep this format aligned with audit-fixtures/delegation-default.
function check(name, ok, detail, falsifier) {
  const idx = String(pass + fail + 1).padStart(2, "0");
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${idx}  ${name}`);
  if (detail) console.log(`      ${detail}`);
  if (!ok) console.log(`      FALSIFIER: ${falsifier}`);
}

// ---- fixture-set declaration -------------------------------------------------
//
// HARNESS-ESTABLISHED PRECONDITIONS. `input.json::_env` carries what the fixture
// injects; these are the preconditions the fixture's DECLARED PREDICATE requires
// but does not itself spell out. Each carries a `why` printed with the check, so a
// precondition failure is never mistaken for a guard failure (coc-rs#89's whole lesson).
const PRECONDITIONS = {
  "01-halt-sibling-porcelain": {
    signingKey: true,
    why:
      "the §4.2 porcelain branch is evaluated AFTER the degraded-mode branch " +
      "(signing-mutation-guard.js:423 PRECEDENCE note), so a resolvable signing key is " +
      "required for the porcelain branch to be REACHED at all. Left to `resolveIdentity`, " +
      "this fixture's disposition would depend on whether the HOST has a git signing key.",
  },
  "02-pass-no-sibling": {
    signingKey: true,
    why: "the fixture's own `_setup_note` declares 'signing key present'; pinning it makes that host-independent.",
  },
};

// The README table is the authority on which fixtures exist and what each expects.
const EXPECTED_FIXTURES = [
  "01-halt-sibling-porcelain",
  "02-pass-no-sibling",
  "03-block-degraded-mode-mutation",
  "04-pass-degraded-mode-read",
  "05-pass-signing-key-present",
  "06-block-git-commit-degraded",
];

// ---- helpers -----------------------------------------------------------------

function git(cwd, ...a) {
  return execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/**
 * A temp repo with the shape every fixture references: a tracked `.gitignore`
 * (fixtures 03/04) and a tracked `src/lib/foo.js` (fixtures 01/02/05).
 *
 * `coordinationOn` writes the tier-2 local override the README's canonical
 * invocation prescribes. Tier-2 force-ON is safe by construction: coordination-mode
 * ASYMMETRIC PRECEDENCE always honours `enabled:true` but REFUSES `enabled:false`
 * on an enrolled repo, so this precondition cannot be repurposed to weaken a real one.
 */
function mkrepo(coordinationOn) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "smg-fx-")));
  git(d, "init", "-q", ".");
  git(d, "config", "user.email", "fixture@example.invalid");
  git(d, "config", "user.name", "fixture");
  fs.writeFileSync(path.join(d, ".gitignore"), "node_modules/\n");
  fs.mkdirSync(path.join(d, "src", "lib"), { recursive: true });
  fs.writeFileSync(path.join(d, "src", "lib", "foo.js"), "module.exports = 1;\n");
  git(d, "add", "-f", ".gitignore", "src/lib/foo.js");
  execFileSync("git", ["commit", "-qm", "fixture baseline"], { cwd: d, stdio: "ignore" });
  if (coordinationOn) {
    fs.mkdirSync(path.join(d, ".claude", "learning"), { recursive: true });
    fs.writeFileSync(
      path.join(d, ".claude", "learning", "coordination-mode.json"),
      JSON.stringify({ enabled: true }),
    );
  }
  _resetCache(); // the predicate memoizes per repoDir; fixtures mutate state per case
  return d;
}

/**
 * A signing-key file. The guard's Tier-1 predicate is `existsSync(explicitKey)`
 * (signing-mutation-guard.js:439-442) — it never parses the key — so a real
 * ed25519 key is not required for the predicate to resolve. We generate one when
 * `ssh-keygen` is available anyway (fixture 05 names "a valid ssh ed25519 key"),
 * and fall back to a plain file otherwise. Either way the guard sees "key present",
 * which is the property under test.
 */
function mkSigningKey() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smg-key-"));
  const p = path.join(dir, "id_ed25519");
  const r = spawnSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "fixture", "-f", p], {
    stdio: "ignore",
  });
  if (r.status !== 0 || !fs.existsSync(p)) {
    fs.writeFileSync(p, "-- fixture placeholder; guard predicate is existsSync only --\n");
  }
  return { path: p, dir, real: r.status === 0 };
}

/** Parse the four load-bearing assertion fields out of expected.txt. */
function parseExpected(text) {
  const field = (k) => {
    const m = new RegExp(`^${k}:\\s*(.+)$`, "m").exec(text);
    return m ? m[1].trim() : null;
  };
  return {
    severity: field("severity"),
    exit_code: Number(field("exit_code")),
    continue: field("continue") === "true",
    stderr_tag: field("stderr_tag"),
    raw: text,
  };
}

/** Substitute the fixture's `<repo>` / key placeholders. */
function materialize(value, repoDir, keyPath) {
  if (typeof value !== "string") return value;
  return value
    .replace(/<repo>/g, repoDir)
    .replace(/<absolute path to a valid ssh ed25519 key>/g, keyPath);
}

// Ambient values for any of these would silently change the guard's disposition,
// so a fixture that does not set one must run WITHOUT it. Stripping is what makes
// this runner's result a property of the fixture rather than of the developer's shell.
const GUARD_ENV_KEYS = [
  "COC_OPERATOR_REPO_DIR",
  "COC_OPERATOR_KEY_PATH",
  "COC_PORCELAIN_OVERRIDE",
  "COC_SIGNING_MUTATION_GUARD_FORCE_DEGRADED",
  "CLAUDE_TRUST_STATE_DIR",
  "LOOM_ECOSYSTEM_CONFIG",
];

function driveGuard(payload, fixtureEnv) {
  const env = { ...process.env };
  for (const k of GUARD_ENV_KEYS) delete env[k];
  Object.assign(env, fixtureEnv);
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env,
    timeout: 20000,
  });
  let json = null;
  try {
    json = JSON.parse((r.stdout || "").trim());
  } catch {
    /* a hook that emitted no parseable stdout is itself the finding */
  }
  return {
    code: r.status,
    json,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
  };
}

/** Build the (payload, env, precondition-note) triple for one fixture. */
function loadFixture(name, repoDir, keyPath) {
  const dir = path.join(HERE, name);
  const input = JSON.parse(fs.readFileSync(path.join(dir, "input.json"), "utf8"));
  const expected = parseExpected(fs.readFileSync(path.join(dir, "expected.txt"), "utf8"));

  const payload = {
    hook_event_name: input.hook_event_name,
    tool_name: input.tool_name,
    tool_input: {},
    cwd: materialize(input.cwd, repoDir, keyPath),
  };
  for (const [k, v] of Object.entries(input.tool_input || {})) {
    payload.tool_input[k] = materialize(v, repoDir, keyPath);
  }

  const env = {};
  for (const [k, v] of Object.entries(input._env || {})) {
    env[k] = materialize(v, repoDir, keyPath);
  }
  const pre = PRECONDITIONS[name];
  if (pre && pre.signingKey && env.COC_OPERATOR_KEY_PATH === undefined) {
    env.COC_OPERATOR_KEY_PATH = keyPath;
  }
  return { name, dir, input, expected, payload, env, pre };
}

// =============================================================================

const key = mkSigningKey();
console.log(`\nhook under test : ${HOOK}`);
console.log(`signing key     : ${key.path} (${key.real ? "real ed25519" : "placeholder file"})`);

// ---- T1: fixture-set coverage ------------------------------------------------
// Runs FIRST: a runner that silently skips a fixture is the defect class this
// whole file exists to close, so coverage is asserted before any behaviour is.
console.log("\n=== T1: every fixture on disk is driven by this runner ===");
{
  const onDisk = fs
    .readdirSync(HERE, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const missing = EXPECTED_FIXTURES.filter((f) => !onDisk.includes(f));
  const extra = onDisk.filter((f) => !EXPECTED_FIXTURES.includes(f));
  check(
    "every fixture named in README.md § Predicates covered exists on disk",
    missing.length === 0,
    `expected ${EXPECTED_FIXTURES.length}, on disk ${onDisk.length}`,
    `non-empty missing list (${JSON.stringify(missing)}) = the README table names a fixture nothing drives`,
  );
  check(
    "no fixture on disk is left undriven by this runner",
    extra.length === 0,
    `undriven: ${JSON.stringify(extra)}`,
    "non-empty = a fixture exists that this runner silently ignores — the coc-rs#74 'could not be trusted' condition, reopened",
  );
  for (const f of onDisk) {
    check(
      `${f}/ carries both input.json and expected.txt`,
      fs.existsSync(path.join(HERE, f, "input.json")) &&
        fs.existsSync(path.join(HERE, f, "expected.txt")),
      "both present",
      "a half-populated fixture dir cannot assert anything; absence would read as a pass",
    );
  }
}

// ---- T2: contradiction lock --------------------------------------------------
// A pre-loom#1323 fixture (`01-block-sibling-porcelain/`) survived the downgrade
// because the sync that ADDED `01-halt-*` never DELETED it, leaving two dirs with
// byte-identical input.json and opposite expected dispositions. Whichever one is
// driven, the other is a standing argument for the regression. Locked structurally.
console.log("\n=== T2: no two fixtures share an input with contradictory expectations ===");
{
  // Scans EVERY dir on disk, deliberately NOT `EXPECTED_FIXTURES`: a stale fixture
  // the runner does not drive is exactly the one whose contradiction would go unseen.
  const allDirs = fs
    .readdirSync(HERE, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(HERE, e.name, "input.json")))
    .map((e) => e.name);
  const byInput = new Map();
  for (const f of allDirs) {
    const raw = fs.readFileSync(path.join(HERE, f, "input.json"), "utf8");
    // Normalize away `_setup_note` prose: two fixtures differing only in commentary
    // still drive the guard identically.
    const o = JSON.parse(raw);
    delete o._setup_note;
    const k = JSON.stringify(o);
    if (!byInput.has(k)) byInput.set(k, []);
    byInput.get(k).push(f);
  }
  const collisions = [];
  for (const [, names] of byInput) {
    if (names.length < 2) continue;
    const sevs = new Set(
      names.map(
        (n) => parseExpected(fs.readFileSync(path.join(HERE, n, "expected.txt"), "utf8")).severity,
      ),
    );
    if (sevs.size > 1) collisions.push({ names, severities: [...sevs] });
  }
  check(
    "identical guard inputs do not carry contradictory expected severities",
    collisions.length === 0,
    `collisions: ${JSON.stringify(collisions)}`,
    "non-empty = two fixtures assert opposite dispositions for one input; no guard can satisfy both, and the loser silently argues for a regression",
  );
}

// ---- T3-T6: per-fixture behaviour at the correct precondition -----------------
console.log("\n=== T3: PRECONDITION coordination=ON, then drive each fixture ===");
const onRepo = mkrepo(true);
{
  check(
    "PRECONDITION — isCoordinationEnabled() is TRUE at the fixture repo",
    isCoordinationEnabled(onRepo) === true,
    `repo=${onRepo} via tier-2 .claude/learning/coordination-mode.json {"enabled":true}`,
    "false = the substrate opt-in gate (signing-mutation-guard.js:398) short-circuits to passthrough BEFORE any predicate runs; every block/halt fixture below would then fail for a HARNESS reason, not a guard reason — the exact coc-rs#89 defect",
  );

  for (const name of EXPECTED_FIXTURES) {
    const fx = loadFixture(name, onRepo, key.path);
    const r = driveGuard(fx.payload, fx.env);
    const preNote = fx.pre ? ` [harness precondition: signing key pinned — ${fx.pre.why}]` : "";
    console.log(`\n  -- ${name} (coordination=ON)${preNote}`);

    check(
      `${name}: exit code ${fx.expected.exit_code}`,
      r.code === fx.expected.exit_code,
      `exit=${r.code} (expected ${fx.expected.exit_code})`,
      `a different exit code = the guard took a different branch than the fixture's declared predicate; exit 0 where ${fx.expected.exit_code} is expected is a fail-OPEN, exit ${fx.expected.exit_code} where 0 is expected is a false positive`,
    );
    check(
      `${name}: continue=${fx.expected.continue}`,
      r.json !== null && r.json.continue === fx.expected.continue,
      `continue=${r.json ? r.json.continue : "<unparseable stdout>"}`,
      "a mismatched or unparseable `continue` = the agent is either let through a blocked mutation or halted on a clean one",
    );
    if (fx.expected.stderr_tag === "(none)") {
      check(
        `${name}: silent passthrough — no severity tag on stderr`,
        !/\[(BLOCK|HALT-AND-REPORT|ADVISORY)\]/.test(r.stderr),
        `stderr=${r.stderr ? r.stderr.slice(0, 80) : "<empty>"}`,
        "a tag present = the guard surfaced a finding on a lane the fixture declares clean (false positive)",
      );
    } else {
      check(
        `${name}: stderr carries ${fx.expected.stderr_tag}`,
        r.stderr.includes(fx.expected.stderr_tag),
        `stderr=${r.stderr.slice(0, 90)}`,
        `tag absent = the user-facing summary line is missing or carries the WRONG severity; the operator sees no signal for a ${fx.expected.severity} disposition`,
      );
      check(
        `${name}: emitted payload names the guard`,
        /signing-mutation-guard/.test(r.stderr) || /signing-mutation-guard/.test(r.stdout),
        "guard named in the emitted report",
        "absent = the agent receives a halt with no attributable source (hook-output-discipline.md MUST-1)",
      );
    }
  }
}

// ---- T7: the 01-vs-03/06 asymmetry, both poles --------------------------------
console.log("\n=== T7: the loom#1323 asymmetry is locked in BOTH directions ===");
{
  const f01 = loadFixture("01-halt-sibling-porcelain", onRepo, key.path);
  const r01 = driveGuard(f01.payload, f01.env);
  check(
    "§4.2 sibling contention is halt-and-report (recoverable class)",
    r01.code === 0 && r01.json?.continue === true && /\[HALT-AND-REPORT\]/.test(r01.stderr),
    `exit=${r01.code} continue=${r01.json?.continue} tag=${/\[HALT-AND-REPORT\]/.test(r01.stderr) ? "HALT-AND-REPORT" : "other"}`,
    "exit 2 / continue:false here = the §4.2 branch was re-UPGRADED to block, undoing loom#1323; sibling worktrees are physically separate, so the write cannot clobber the sibling's bytes",
  );
  check(
    "§4.2 sibling contention does NOT emit [BLOCK]",
    !/\[BLOCK\]/.test(r01.stderr),
    "no BLOCK tag on the recoverable branch",
    "a BLOCK tag = the recoverable merge-conflict class is being treated as irrecoverable",
  );

  for (const name of ["03-block-degraded-mode-mutation", "06-block-git-commit-degraded"]) {
    const fx = loadFixture(name, onRepo, key.path);
    const r = driveGuard(fx.payload, fx.env);
    check(
      `${name}: degraded-mode mutation STAYS block (irrecoverable class)`,
      r.code === 2 && r.json?.continue === false && /\[BLOCK\]/.test(r.stderr),
      `exit=${r.code} continue=${r.json?.continue}`,
      "halt-and-report / exit 0 here = the 'consistency fix' README.md warns about: an UNSIGNED mutation would land with no attributable, chain-verifiable record and nothing recovers the missing signature after the fact",
    );
    check(
      `${name}: does NOT emit [HALT-AND-REPORT]`,
      !/\[HALT-AND-REPORT\]/.test(r.stderr),
      "no HALT-AND-REPORT tag on the irrecoverable branch",
      "a HALT-AND-REPORT tag = 03/06 were normalized to match 01, exactly the downgrade the matched fixture pair exists to prevent",
    );
  }
}

// ---- T8: NEGATIVE CONTROL — the precondition is load-bearing ------------------
// The instrument must be shown to DISCRIMINATE, not merely to have printed a
// plausible value (instrument-discipline.md MUST-1/MUST-3). Driving the SAME
// fixtures at a coordination-OFF repo reproduces coc-rs#89's measured passthrough, so
// T3's greens are attributable to the precondition rather than to luck.
console.log("\n=== T8: NEGATIVE CONTROL — the same fixtures at coordination=OFF ===");
const offRepo = mkrepo(false);
{
  check(
    "PRECONDITION — isCoordinationEnabled() is FALSE at the control repo",
    isCoordinationEnabled(offRepo) === false,
    `repo=${offRepo}, no coordination-mode.json, no roster, no genesis`,
    "true = the control repo is NOT actually coordination-OFF, so the rows below prove nothing about the precondition",
  );

  const T8_FIXTURES = [
    "01-halt-sibling-porcelain",
    "03-block-degraded-mode-mutation",
    "06-block-git-commit-degraded",
  ];

  // exit/continue ALONE cannot separate a passthrough from a §4.2 finding: at
  // coordination-ON, 01 emits [HALT-AND-REPORT] at exit 0 / continue true — byte-identical
  // to 02's silent pass on both of those fields. Asserting the ABSENCE of any severity tag
  // is what makes this row discriminate for 01 (instrument-discipline.md MUST-1).
  const offDisposition = {};
  for (const name of T8_FIXTURES) {
    const fx = loadFixture(name, offRepo, key.path);
    const r = driveGuard(fx.payload, fx.env);
    const tag = (r.stderr.match(/\[(?:BLOCK|HALT-AND-REPORT|ADVISORY)\]/) || ["(none)"])[0];
    offDisposition[name] = `exit=${r.code} continue=${r.json?.continue} tag=${tag}`;
    check(
      `${name}: coordination OFF ⇒ SILENT passthrough (NOT a fail-open, NOT a finding)`,
      r.code === 0 && r.json?.continue === true && tag === "(none)",
      `${offDisposition[name]} — matches coc-rs#89's measurement`,
      "a DENY here, or ANY severity tag on stderr, would mean the opt-in gate at signing-mutation-guard.js:398 stopped gating — and WITHOUT the tag leg this row reads identically whether the guard passed through or emitted the full §4.2 finding at exit 0",
    );
  }

  // The discrimination claim, EVALUATED rather than asserted. The prior version of this
  // row asserted the literal `true` with a falsifier reading "n/a": it printed green while
  // evaluating nothing, and was counted in the CI floor. It now drives the SAME fixtures at
  // the ON repo and requires each disposition to DIFFER from its OFF counterpart.
  for (const name of T8_FIXTURES) {
    const fx = loadFixture(name, onRepo, key.path);
    const r = driveGuard(fx.payload, fx.env);
    const tag = (r.stderr.match(/\[(?:BLOCK|HALT-AND-REPORT|ADVISORY)\]/) || ["(none)"])[0];
    const onDisp = `exit=${r.code} continue=${r.json?.continue} tag=${tag}`;
    check(
      `${name}: the precondition CHANGES the disposition (instrument discriminates)`,
      onDisp !== offDisposition[name],
      `ON: ${onDisp}   OFF: ${offDisposition[name]}`,
      "identical dispositions = the opt-in gate is NOT what produces the ON-repo verdict, so every T3/T7 green for this fixture carries no information about the precondition",
    );
  }
}

// ---- cleanup -----------------------------------------------------------------
fs.rmSync(onRepo, { recursive: true, force: true });
fs.rmSync(offRepo, { recursive: true, force: true });
fs.rmSync(key.dir, { recursive: true, force: true });

// NOT "PASS <n>" — that shape matches CASE_PASS and the harness would count the
// summary as a 45th case. "SUMMARY:" matches neither case pattern.
console.log(`\n${"=".repeat(62)}\nSUMMARY: ${pass} passed, ${fail} failed\n${"=".repeat(62)}`);
process.exit(fail === 0 ? 0 : 1);
