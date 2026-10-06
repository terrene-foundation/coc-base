/**
 * hook-fixture-runner.mjs — the ONE parameterized driver behind seven
 * previously-DATA-ONLY audit-fixture directories (F51 residue, loom#2044 Group A).
 *
 * WHY THIS EXISTS. `.claude/bin/run-audit-fixtures.mjs` enforces a bidirectional
 * closure over fixture dirs, but ONLY over the `run.mjs` convention. A directory
 * holding `input.json` + `expected.txt` and NO `run.mjs` is outside that closure
 * BY CONSTRUCTION — so seven corpora (36 cases) survived an all-green CI having
 * executed nothing. `cc-artifacts.md` Rule 9 + `hook-output-discipline.md` MUST-4
 * make the per-predicate fixture corpus a CONTRACT; an unrun fixture does not hold
 * up its end.
 *
 * WHY ONE MODULE AND NOT SEVEN RUNNERS. All seven share the same physical shape —
 * one subdirectory per case, `input.json` + `expected.txt`. What they do NOT share
 * is what `expected.txt` ASSERTS. Measured, not assumed, there are two families:
 *
 *   FAMILY A — DISPOSITION. `severity:` / `exit_code:` / `continue:` /
 *     `stderr_tag:` — a verdict on a PreToolUse gate. Four dirs:
 *     adjacency-leasecheck, journal-write-guard, journal-author-discipline,
 *     probe-phase-guard. `runDispositionSuite` below drives these end-to-end from
 *     a declarative spec.
 *   FAMILY B — SIDE EFFECT. Prose about what the hook WROTE (a record appended,
 *     a banner citing a display_id, a log whose size must not move). Three dirs:
 *     multi-operator-sessionstart, multi-operator-sessionend, adjacency-heartbeat.
 *     These share the scaffold (repo, keys, driving, reporting, coverage, SUMMARY)
 *     and supply their own `assert` per case, because a generic parser over that
 *     prose would be a non-discriminating instrument (rules/instrument-discipline.md
 *     MUST-1): it would pass on any output that happened to contain the words.
 *
 * WHAT THIS DOES *NOT* CLAIM. None of these six hooks is untested.
 * `tests/integration/adjacency-leasecheck.test.js`,
 * `tests/integration/integrity-guards.test.js` and
 * `tests/integration/multi-operator/m5-b2-lifecycle-hooks.test.js` are all
 * registered in `ci-suites.json` and drive them with real subprocess spawns.
 * What was unexecuted is THESE CORPORA — the `expected.txt` files that are the
 * PINNED dispositions. Nothing red when one drifted from its hook.
 *
 * INSTRUMENT DISCIPLINE (rules/instrument-discipline.md MUST-1/2/3). Every check
 * names the FALSIFYING result. Greens are never read alone: each suite drives
 * PAIRED CONTROLS that flip exactly one element of a declared setup and require
 * the disposition to MOVE, so the instrument is SHOWN to discriminate rather than
 * asserted to. A suite all of whose rows pass under every mutation proves nothing.
 *
 * ENV HYGIENE. The ambient shell can silently change a guard's jurisdiction, so
 * every drive strips the guard-relevant keys and sets only what the fixture's own
 * `_setup_note` / `env` block declares. That is what makes a result a property of
 * the FIXTURE rather than of the developer's machine.
 */
import "./_lib/no-ambient-git.cjs";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync, spawnSync } from "child_process";
import { createRequire } from "module";

const require_ = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

// Per-case lines MUST match run-audit-fixtures.mjs::CASE_PASS / CASE_FAIL
// (/^[ \t]*(?:PASS|ok)[ \t]+\S/ and /^[ \t]*(?:FAIL|not ok)[ \t]+\S/). A
// decorative "  ✓ <name>" line matches NEITHER, and the harness would then count
// ONE case — the summary — against the declared min_cases; worse, an ALL-FAILING
// run would present as 1p/0f. Keep aligned with audit-fixtures/integrity-guard.
export function makeReporter() {
  let pass = 0;
  let fail = 0;
  function check(name, ok, detail, falsifier) {
    const idx = String(pass + fail + 1).padStart(2, "0");
    ok ? pass++ : fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${idx}  ${name}`);
    if (detail) console.log(`      ${detail}`);
    if (!ok) console.log(`      FALSIFIER: ${falsifier}`);
  }
  function finish() {
    // NOT "PASS <n>" — that shape matches CASE_PASS and the harness would count
    // the summary line as an extra case. "SUMMARY:" matches neither pattern.
    console.log(
      `\n${"=".repeat(62)}\nSUMMARY: ${pass} passed, ${fail} failed\n${"=".repeat(62)}`,
    );
    process.exit(fail === 0 ? 0 : 1);
  }
  return { check, finish, counts: () => ({ pass, fail }) };
}

// ---------------------------------------------------------------------------
// temp-state lifecycle
// ---------------------------------------------------------------------------

const TEMPDIRS = [];
export function cleanup() {
  for (const d of TEMPDIRS) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

function track(dir) {
  TEMPDIRS.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// real keys, real signatures (Tier 2 per rules/testing.md — no mocking)
// ---------------------------------------------------------------------------

export function mkKey(label) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `afx-key-${label}-`)));
  const keyPath = path.join(dir, "id_ed25519");
  execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-f", keyPath, "-C", label]);
  const pubKey = fs.readFileSync(`${keyPath}.pub`, "utf8").trim();
  const out = execFileSync("ssh-keygen", ["-lf", `${keyPath}.pub`], { encoding: "utf8" });
  const m = out.match(/SHA256:[A-Za-z0-9+/=]+/);
  if (!m) throw new Error("could not extract ssh key fingerprint");
  return { dir, keyPath, pubKey, fingerprint: m[0] };
}

/** Sign `core` with `keyPath` via the canonical lib and return the full record. */
export function signRecord(repoRoot, core, keyPath) {
  const { canonicalSerialize, sign } = require_(
    path.join(repoRoot, ".claude/hooks/lib/coc-sign.js"),
  );
  const r = sign(canonicalSerialize(core), { keyType: "ssh", keyPath });
  if (!r.ok) throw new Error(`coc-sign failed: ${r.error}`);
  return { ...core, sig: r.sig };
}

// ---------------------------------------------------------------------------
// repo materialization
// ---------------------------------------------------------------------------

function git(dir, ...a) {
  return execFileSync("git", ["-C", dir, ...a], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * A real git repo in the state a fixture's `_setup_note` DECLARES but does not
 * itself construct.
 *
 * `coordinationForceOn` writes the tier-2 local override `{"enabled":true}`.
 * Force-ON is safe by construction: coordination-mode ASYMMETRIC PRECEDENCE
 * always honours `enabled:true` but REFUSES `enabled:false` on an enrolled repo,
 * so this precondition cannot be repurposed to weaken a real one. It is REQUIRED
 * here because loom#1890 raised tier 4 to a ≥2-distinct-humans floor: without it
 * a single-person fixture roster resolves coordination OFF and every registry
 * predicate below would passthrough for a reason the fixture never declared.
 */
export function mkRepo(label, opts = {}) {
  const repoDir = track(
    fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `afx-repo-${label}-`))),
  );
  execFileSync("git", ["init", "-q", "-b", "main", repoDir]);
  // Hermetic: never inherit the operator's commit.gpgsign — gpg would launch
  // pinentry on a CI runner and every fixture commit would hang or fail.
  git(repoDir, "config", "commit.gpgsign", "false");
  git(repoDir, "config", "user.email", "fixture@example.invalid");
  git(repoDir, "config", "user.name", "audit-fixture");
  fs.mkdirSync(path.join(repoDir, ".claude", "learning"), { recursive: true });
  if (opts.coordinationForceOn !== false) {
    fs.writeFileSync(
      path.join(repoDir, ".claude", "learning", "coordination-mode.json"),
      '{"enabled":true}\n',
    );
  }
  fs.writeFileSync(path.join(repoDir, ".gitignore"), ".session-notes\n");
  git(repoDir, "add", ".gitignore");
  execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "fixture baseline"], {
    stdio: "ignore",
  });
  if (opts.branch && opts.branch !== "main") git(repoDir, "checkout", "-q", "-b", opts.branch);
  return repoDir;
}

export function writeRoster(repoDir, roster) {
  fs.writeFileSync(
    path.join(repoDir, ".claude", "operators.roster.json"),
    JSON.stringify(roster, null, 2),
  );
}

export function logPathOf(repoDir) {
  return path.join(repoDir, ".claude", "learning", "coordination-log.jsonl");
}

export function appendLogRecord(repoDir, record) {
  fs.appendFileSync(logPathOf(repoDir), JSON.stringify(record) + "\n");
}

export function writeLog(repoDir, records) {
  fs.writeFileSync(
    logPathOf(repoDir),
    records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""),
  );
}

export function ensureParent(p) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// fixture loading
// ---------------------------------------------------------------------------

export function materialize(value, repoDir) {
  return typeof value === "string" ? value.replace(/<repo>/g, repoDir) : value;
}

/** Raw read of a fixture case; `input` is null when input.json is not JSON. */
export function readCase(suiteDir, name) {
  const dir = path.join(suiteDir, name);
  const rawInput = fs.readFileSync(path.join(dir, "input.json"), "utf8");
  let input = null;
  try {
    input = JSON.parse(rawInput);
  } catch {
    /* a deliberately-malformed fixture (structural-NULL) — the caller decides */
  }
  return {
    name,
    rawInput,
    input,
    expectedText: fs.readFileSync(path.join(dir, "expected.txt"), "utf8"),
  };
}

/**
 * Parse the four load-bearing FAMILY-A assertion fields out of `expected.txt`.
 *
 * `severity:` / `disposition:` lines carry trailing PROSE in several fixtures — a parenthetical
 * ("block (on non-codify branch, …)", "(silent — INDEPENDENT)") explaining WHICH
 * predicate fires. Comparing the raw line would red a fixture that is internally
 * consistent, which is a harness defect masquerading as a finding. The token is
 * normalized to one of block | halt-and-report | advisory | silent.
 *
 * `stderr_tag:` and `stderr:` are the SAME field under two spellings across the
 * corpora; both are read, and any "(none)" / "(empty…)" rendering normalizes to
 * the sentinel "(none)".
 */
export function parseExpected(text) {
  const field = (k) => {
    const m = new RegExp(`^${k}:\\s*(.*)$`, "m").exec(text);
    return m ? m[1].trim() : null;
  };
  // `severity:` is the spelling four corpora use; journal-author-discipline
  // spells the SAME field `disposition:` ("silent passthrough (…)",
  // "halt-and-report (REGISTRY-class, NEVER block …)"). Read both, or this
  // parser silently returns null and the consistency check below degenerates
  // into a tautology that passes on every fixture it cannot read.
  const rawSeverity = field("severity") ?? field("disposition");
  let severity = null;
  if (rawSeverity !== null) {
    const s = rawSeverity.toLowerCase();
    if (/\bhalt-and-report\b/.test(s)) severity = "halt-and-report";
    else if (/\bblock\b/.test(s)) severity = "block";
    else if (/\badvisory\b/.test(s)) severity = "advisory";
    else if (/\bsilent\b/.test(s)) severity = "silent";
  }
  const rawTag = field("stderr_tag") ?? field("stderr");
  let tag = null;
  if (rawTag !== null) {
    const m = rawTag.match(/\[(?:BLOCK|HALT-AND-REPORT|ADVISORY)\]/);
    tag = m ? m[0] : "(none)";
  }
  const exitRaw = field("exit_code");
  return {
    severity,
    severity_raw: rawSeverity,
    tag,
    tag_raw: rawTag,
    exit_code: exitRaw === null ? null : Number(exitRaw),
    continue: field("continue") === "true",
    continue_raw: field("continue"),
  };
}

// ---------------------------------------------------------------------------
// driving a hook
// ---------------------------------------------------------------------------

// Ambient values for any of these would silently change a guard's jurisdiction
// or verdict, so a fixture that does not set one MUST run WITHOUT it.
//
// THE SESSION-ID KEYS ARE THE ONE CLASS WHOSE OMISSION IS INVISIBLE. Every other
// entry here is a switch whose ambient presence a reader would expect to matter.
// An ambient SESSION ID is different: it is present in the environment of every
// Claude Code tool child, it is the guard's PRIMARY identity input, and a fixture
// that declares no session reads as "ABSENT" only to a reader who never checked
// the parent's environment. MEASURED 2026-10-01 (T68 D1): with
// `CLAUDE_CODE_SESSION_ID` set in the parent, `landing-window` ran 51p/1f and its
// H1 control (payload=OWNER, env ABSENT ⇒ ALLOWED) drove the HOST'S session id
// instead of an absent one and BLOCKED; unset in the identical tree on the same
// host at the same commit, 52p/0f. That is the suite's verdict being a property
// of the CALLER'S shell — the precise thing this list exists to eliminate.
export const GUARD_ENV_KEYS = [
  "CLAUDE_TRUST_STATE_DIR",
  "CLAUDE_PROJECT_DIR",
  // Session identity: `landing-window-read.js` reads
  // `CLAUDE_CODE_SESSION_ID`/`CLAUDE_SESSION_ID` (callerIdentity, ownerIdentity —
  // the ownership confluence) and `CLAUDE_PID` (ownerPid — the death check and
  // the opener's staleness bound).
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_SESSION_ID",
  "CLAUDE_PID",
  // The guard's EXECUTION-PATH switch: `=== "1"` routes `hookMain` through
  // `hook-engine.js::runCli` instead of calling it directly, so an ambient `=1`
  // would drive every fixture through a different dispatcher than the one under
  // test.
  "COC_HOOK_ENGINE_SELFTEST",
  "COC_OPERATOR_REPO_DIR",
  "COC_OPERATOR_KEY_PATH",
  "COC_PORCELAIN_OVERRIDE",
  "COC_INTEGRITY_GUARD_TIMEOUT_MS",
  // journal-write-guard's tighten-only check budget. AMBIENT `=1` would starve
  // EVERY journal fixture into the halt-and-report not-completed arm, so a suite
  // pinning a reservation disposition would go green on the timeout path instead
  // — the verdict would be right by accident and the branch under test unrun.
  "COC_JOURNAL_GUARD_BUDGET_MS",
  // journal-write-guard's injected-fault switch (its internal-error branch is
  // otherwise unreachable). Ambient `=1` turns every journal fixture into that
  // branch.
  "COC_TEST_JOURNAL_GUARD_INTERNAL_ERROR",
  "LOOM_ECOSYSTEM_CONFIG",
  "COC_TEST_FINGERPRINT",
  "COC_TEST_PERSON_ID",
  "COC_TEST_SKIP_SIGN",
  "COC_TEST_FORCE_RELEASE",
  "COC_TEST_FORCE_CHECKPOINT",
  "COC_TEST_WRITE_SESSION_NOTES",
  "COC_TEST_LOCAL_GENESIS_GENERATION",
  "COC_TEST_PEER_GENESIS_GENERATION",
  "COC_TEST_CONTESTED_REVOCATIONS",
  "COC_TEST_UNVERIFIED_REGISTRATIONS",
  "COC_TEST_PENDING_GATE_APPROVALS",
  "COC_TEST_WORKER_BUDGET_MS",
];

/**
 * Spawn `hook` with `stdinRaw` on stdin. Returns the verdict signal.
 *
 * THE VERDICT SIGNAL IS NOT THE EXIT STATUS ALONE. instruct-and-wait emits
 * severity=block as exit 2 / continue:false, but halt-and-report AND advisory as
 * exit 0 / continue:TRUE — the tool RUNS. A status-only predicate reads a
 * halt-and-report fail-open as a fence, so `tag` (and `refused`) key on the
 * emitted severity TAG, not on the status.
 */
export function driveHook(hook, { stdinRaw, cwd, env = {}, timeout = 90000 }) {
  const childEnv = { ...process.env };
  for (const k of GUARD_ENV_KEYS) delete childEnv[k];
  // Ambient git config is neutralized for the ORDINARY git reads a guard makes
  // (worktree enumeration, status, rev-parse), so a developer's aliases, hooks
  // or includeIf blocks cannot steer a fixture.
  //
  // WHAT THIS DOES **NOT** PIN — measured, and recorded so no future reader
  // mistakes it for a full fence. `operator-id.js` Tier 2 routes its
  // `user.signingkey` read through git-subprocess-env.js's CONFIG profile, which
  // DELIBERATELY ignores ambient GIT_CONFIG_GLOBAL/GIT_CONFIG_COUNT/HOME (a
  // loom#1471 hardening against exactly this kind of steering). MEASURED on a
  // bare `git init` temp repo with no roster and no COC_TEST_* env: identity
  // still resolved to a real verified_id off the operator's true global config,
  // BOTH with and without these two variables set. So a fixture that needs
  // "identity UNRESOLVABLE" is NOT drivable through any env seam on a machine
  // whose user has a signing key; the seams that ARE authoritative are
  // COC_TEST_FINGERPRINT/COC_TEST_PERSON_ID (short-circuit) and
  // COC_OPERATOR_KEY_PATH (Tier 1), and every suite here pins one of them.
  childEnv.GIT_CONFIG_GLOBAL = "/dev/null";
  childEnv.GIT_CONFIG_SYSTEM = "/dev/null";
  Object.assign(childEnv, env);
  const r = spawnSync(process.execPath, [hook], {
    input: stdinRaw,
    encoding: "utf8",
    cwd,
    env: childEnv,
    timeout,
  });
  if (r.signal === "SIGTERM") {
    // A killed child writes nothing, so its empty stdout would otherwise read as
    // "the hook emitted no verdict" — a product defect — when the real event is a
    // timeout. Name it (loom#1352).
    return {
      code: null,
      json: null,
      tag: "(timeout)",
      combined: `HARNESS: ${path.basename(hook)} killed at the ${timeout}ms hang bound`,
      refused: false,
      timedOut: true,
    };
  }
  const combined = `${r.stdout || ""}${r.stderr || ""}`;
  let json = null;
  try {
    // Hooks may print diagnostics before the protocol line; the LAST stdout line
    // is the payload.
    const lines = (r.stdout || "").trim().split("\n");
    json = JSON.parse(lines[lines.length - 1]);
  } catch {
    /* a hook that emitted no parseable stdout is itself the finding */
  }
  const tagMatch = combined.match(/\[(?:BLOCK|HALT-AND-REPORT|ADVISORY)\]/);
  return {
    code: r.status,
    json,
    tag: tagMatch ? tagMatch[0] : "(none)",
    combined,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    refused: combined.includes("[BLOCK]") || combined.includes("[HALT-AND-REPORT]"),
    timedOut: false,
  };
}

// ---------------------------------------------------------------------------
// T1 — corpus coverage (runs FIRST in every suite)
// ---------------------------------------------------------------------------

/**
 * A runner that silently skips a fixture is the exact defect class this whole
 * family exists to close, so coverage is asserted BEFORE any behaviour.
 */
export function coverageChecks(check, suiteDir, expectedFixtures, setups) {
  const onDisk = fs
    .readdirSync(suiteDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const missing = expectedFixtures.filter((f) => !onDisk.includes(f));
  const extra = onDisk.filter((f) => !expectedFixtures.includes(f));
  check(
    "every fixture named in README.md § Predicates covered exists on disk",
    missing.length === 0,
    `expected ${expectedFixtures.length}, on disk ${onDisk.length}`,
    `non-empty missing list (${JSON.stringify(missing)}) = the README table names a fixture nothing drives`,
  );
  check(
    "no fixture on disk is left undriven by this runner",
    extra.length === 0,
    `undriven: ${JSON.stringify(extra)}`,
    "non-empty = a fixture dir exists that this runner silently ignores — the F51 'survives an all-green CI executing nothing' condition, reopened one directory at a time",
  );
  for (const f of onDisk) {
    check(
      `${f}/ carries both input.json and expected.txt`,
      fs.existsSync(path.join(suiteDir, f, "input.json")) &&
        fs.existsSync(path.join(suiteDir, f, "expected.txt")),
      "both present",
      "a half-populated fixture dir cannot assert anything, and its absence would read as a pass",
    );
    check(
      `${f}/ has a declared harness setup`,
      Object.prototype.hasOwnProperty.call(setups, f),
      setups[f] ? "setup declared" : "NO SETUP",
      "absent = the fixture would be driven at whatever state happens to exist, so its verdict would be a property of the harness rather than of the predicate it names",
    );
  }
  return onDisk;
}

// ---------------------------------------------------------------------------
// FAMILY A — the disposition suite, fully parameterized
// ---------------------------------------------------------------------------

/**
 * Drive a whole FAMILY-A corpus from a declarative spec.
 *
 * spec = {
 *   suiteDir, hook, fixtures: [names…],
 *   setups: { <name>: { why, ...opaque } },
 *   stage(name, setup)   → { repoDir, env, stdinRaw?, bodyMustCite? }
 * }
 *
 * `stage` materializes the world the fixture DECLARES and returns everything the
 * drive needs. `why` is printed with the fixture's rows so a setup failure can
 * never be mistaken for a guard failure.
 */
export function runDispositionSuite(spec, check) {
  const { suiteDir, hook, fixtures, setups, stage } = spec;

  console.log(`\nhook under test : ${hook}`);

  console.log("\n=== T1: every fixture on disk is driven by this runner ===");
  coverageChecks(check, suiteDir, fixtures, setups);

  // T2 — expected.txt internal consistency. The severity token and the
  // exit/continue/tag triple encode the SAME verdict; locking them against each
  // other means a future half-edit reds HERE rather than silently disagreeing
  // with itself (the drift integrity-guard fixture 02's own `note:` records).
  console.log("\n=== T2: each expected.txt is internally consistent ===");
  for (const name of fixtures) {
    const c = readCase(suiteDir, name);
    const e = parseExpected(c.expectedText);
    const isBlock = e.severity === "block";
    const isSilent = e.severity === "silent";
    // A fixture whose own `stderr:` line is a DISJUNCTION ("(empty OR [ADVISORY]
    // …)") cannot be locked to one tag — pinning either arm would red a fixture
    // that is internally consistent. `permittedTags` declares the disjunction the
    // fixture text states; the tag leg is then asserted as MEMBERSHIP in T3
    // instead of equality here.
    const disjunctive = Array.isArray(setups[name] && setups[name].permittedTags);
    const consistent =
      e.exit_code === (isBlock ? 2 : 0) &&
      e.continue === true && // no severity halts the session: a block is exit 2 + deny
      (disjunctive ? true : isSilent ? e.tag === "(none)" : e.tag !== "(none)");
    check(
      `${name}: severity "${e.severity}" agrees with exit_code/continue/stderr_tag${disjunctive ? " (tag leg deferred — fixture states a disjunction)" : ""}`,
      consistent,
      `severity=${e.severity} exit=${e.exit_code} continue=${e.continue_raw} tag=${e.tag}`,
      "disagreement = the fixture pins two different verdicts at once; whichever field the reader trusts, the other is a standing argument for the opposite disposition",
    );
  }

  console.log("\n=== T3: drive each fixture against the REAL hook at its declared setup ===");
  for (const name of fixtures) {
    const setup = setups[name];
    const c = readCase(suiteDir, name);
    const e = parseExpected(c.expectedText);
    const staged = stage(name, setup, c);
    console.log(`\n  -- ${name} [harness setup: ${setup.why}]`);
    const r = driveHook(hook, {
      stdinRaw: staged.stdinRaw,
      cwd: staged.repoDir,
      env: staged.env || {},
    });
    check(
      `${name}: exit code ${e.exit_code}`,
      r.code === e.exit_code,
      `exit=${r.code} (expected ${e.exit_code})${r.timedOut ? " [TIMED OUT]" : ""}`,
      `a different exit code = the guard took a different branch than the fixture's declared predicate; exit 0 where ${e.exit_code} is expected is a fail-OPEN, exit ${e.exit_code} where 0 is expected is a false positive that halts clean work`,
    );
    check(
      `${name}: continue=${e.continue}`,
      r.json !== null && (r.json.continue !== false) === e.continue,
      `continue=${r.json ? r.json.continue : "<unparseable stdout>"}`,
      "a mismatched or unparseable `continue` = the agent is either let through a fenced action or halted on an authorized one",
    );
    if (Array.isArray(setup.permittedTags)) {
      check(
        `${name}: emitted tag is one of ${JSON.stringify(setup.permittedTags)}`,
        setup.permittedTags.includes(r.tag),
        `tag=${r.tag}`,
        `a tag outside the fixture's own declared set = the guard took a branch the fixture does not sanction. The set is a DISJUNCTION the fixture text states, not a wildcard: [BLOCK] or [HALT-AND-REPORT] here would be a refusal on a lane the fixture declares non-halting`,
      );
    } else if (e.tag === "(none)") {
      check(
        `${name}: silent passthrough — no severity tag emitted`,
        r.tag === "(none)",
        `tag=${r.tag}`,
        "any tag = the guard surfaced a finding on a lane the fixture declares clean (false positive). exit/continue ALONE cannot see this: halt-and-report is exit 0 / continue:true, byte-identical to a silent pass on both fields",
      );
    } else {
      check(
        `${name}: emits ${e.tag}`,
        r.tag === e.tag,
        `tag=${r.tag}`,
        `a different tag = the verdict SEVERITY moved. [HALT-AND-REPORT] or [ADVISORY] where [BLOCK] is pinned maps to continue:true and the tool RUNS — on a mutation fence that is not a softer refusal but NO refusal`,
      );
      if (staged.bodyMustCite) {
        for (const frag of staged.bodyMustCite) {
          check(
            `${name}: emitted body cites ${JSON.stringify(frag)}`,
            r.combined.includes(frag),
            "discriminator present in the agent-facing body",
            "absent = a severity-only assertion cannot tell WHICH branch fired; two branches sharing a severity are then interchangeable, and deleting one passes via the other's fallthrough",
          );
        }
      }
    }
  }
}
