#!/usr/bin/env node
/**
 * integrity-guard — canonical fixture runner (F51 residue).
 *
 * WHY THIS EXISTS. `.claude/audit-fixtures/integrity-guard/` shipped six
 * fixture directories and NO `run.mjs`. `.claude/bin/run-audit-fixtures.mjs`
 * enforces a bidirectional closure over fixture dirs, but ONLY over the
 * `run.mjs` convention — a dir holding DATA and no runner is outside that
 * closure by construction, so this corpus survived an all-green CI having
 * executed nothing. `cc-artifacts.md` Rule 9 + `hook-output-discipline.md`
 * MUST-4 make the per-predicate fixture corpus a CONTRACT; an unrun fixture
 * does not hold up its end.
 *
 * WHAT THIS DOES *NOT* CLAIM. `integrity-guard.js` is NOT an untested guard.
 * `integrity-guard-optin.test.mjs`, `integrity-guard-learning-codified.test.mjs`
 * (both registered in `ci-suites.json`) and three `tests/integration/multi-operator/`
 * suites already drive it. What was unexecuted is THIS corpus — the per-predicate
 * fixture set whose `expected.txt` files are the pinned dispositions. Fixture 02's
 * own `note:` records the cost of that: its declared severity drifted for months
 * after loom#1855 raised the verdict halt-and-report → block, and "nothing executes
 * this directory (there is no run.mjs), so the drift could not red on its own."
 *
 * THE FIXTURES DECLARE A PREDICATE, NOT A WORLD. Each `input.json` carries a
 * `_setup_note` naming the repository state its predicate requires (active branch,
 * lease presence, log shape). That state is what SETUPS below materializes — a real
 * git repo, a real roster, a real ssh key, a real `coc-sign` signature over a real
 * codify-lease record. Tier 2 per `rules/testing.md`: no mocking. A fixture driven
 * at the wrong state fails for a HARNESS reason, and the whole point of naming the
 * setup per fixture is that a future reader cannot mistake one for a guard defect.
 *
 * INSTRUMENT DISCIPLINE (rules/instrument-discipline.md MUST-1/MUST-2/MUST-3).
 * Every check names the FALSIFYING result. And the greens are not read alone:
 * § T4 drives PAIRED CONTROLS that flip exactly one element of the fixture's
 * declared setup and require the disposition to CHANGE. A runner whose cases all
 * pass under every mutation proves nothing; the controls are what make each green
 * attributable to the predicate the fixture names rather than to a hook that
 * refuses (or passes) everything.
 *
 *   node .claude/audit-fixtures/integrity-guard/run.mjs
 *   echo $?            # 0 = all green; non-zero = at least one check failed
 *
 * Override the hook under test (to red the suite against a mutant) with:
 *   HOOK=/abs/path/to/mutant.js node .../run.mjs
 */
import "../_lib/no-ambient-git.cjs";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync, spawnSync } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const HOOK = process.env.HOOK || path.join(REPO, ".claude/hooks/integrity-guard.js");
const COC_SIGN = path.join(REPO, ".claude/hooks/lib/coc-sign.js");
const require_ = createRequire(import.meta.url);

// The fixture `_setup_note`s pin these two tokens literally
// ("active branch is 'codify/self-2026-05-21'; operator display_id=self").
const DISPLAY_ID = "self";
const DATE = "2026-05-21";

let pass = 0,
  fail = 0;

// Per-case lines MUST match run-audit-fixtures.mjs::CASE_PASS / CASE_FAIL
// (/^[ \t]*(?:PASS|ok)[ \t]+\S/ and /^[ \t]*(?:FAIL|not ok)[ \t]+\S/). A decorative
// "  ✓ <name>" line matches NEITHER, and the harness would then count ONE case —
// the summary — against the declared min_cases. Worse, an ALL-FAILING run would
// present as 1p/0f. Keep this aligned with audit-fixtures/signing-mutation-guard.
function check(name, ok, detail, falsifier) {
  const idx = String(pass + fail + 1).padStart(2, "0");
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${idx}  ${name}`);
  if (detail) console.log(`      ${detail}`);
  if (!ok) console.log(`      FALSIFIER: ${falsifier}`);
}

// ---- fixture-set declaration -------------------------------------------------
//
// README.md § "Predicates covered" is the authority on which fixtures exist.
const EXPECTED_FIXTURES = [
  "01-block-non-codify-branch",
  "02-halt-no-lease-on-codify-branch",
  "03-pass-branch-and-lease-match",
  "04-pass-unwatched-path",
  "05-pass-foreign-codify-branch",
  "06-structural-null-malformed-log",
];

// HARNESS-ESTABLISHED SETUPS. Each entry materializes the world the fixture's
// `_setup_note` DECLARES but does not itself construct. `why` is printed with the
// fixture's rows so a setup failure can never be mistaken for a guard failure.
const SETUPS = {
  "01-block-non-codify-branch": {
    branch: "main",
    why: "_setup_note: \"active branch is 'main' (NOT codify/*-<date>)\" — the structural branch predicate is what this fixture pins.",
  },
  "02-halt-no-lease-on-codify-branch": {
    branch: `codify/${DISPLAY_ID}-${DATE}`,
    why: "_setup_note: branch matches BUT the coordination log has NO codify-lease record; the branch fence must pass so the LEASE fence is the one evaluated.",
  },
  "03-pass-branch-and-lease-match": {
    branch: `codify/${DISPLAY_ID}-${DATE}`,
    lease: [".claude/learning/coordination-log.jsonl"],
    why: "_setup_note: a SIGNED codify-lease carrying lease_id + un-released + acquired_at within the 12h TTL + scope_files covering the target. lease_id and acquired_at are LOAD-BEARING as of the 2026-08-21 expiry/release fix — a record lacking either folds to 'unpairable'/'indeterminate-age' and DENIES, producing a BLOCK instead of the passthrough this case pins.",
  },
  "04-pass-unwatched-path": {
    branch: "main",
    why: "no branch requirement: src/foo.js is outside the §2.3 watched set, so the unwatched passthrough fires BEFORE any branch/lease evaluation. Deliberately staged on 'main' — the branch that BLOCKS every watched path — so the passthrough is attributable to the PATH predicate and nothing else.",
  },
  "05-pass-foreign-codify-branch": {
    branch: `codify/SIBLING-${DATE}`,
    why: "_setup_note: branch is another operator's codify branch while our display_id is 'self' → isCodifyBranch returns {match:false, foreign:true}.",
  },
  "06-structural-null-malformed-log": {
    branch: "main",
    malformedLog: true,
    why: "_setup_note: coordination log truncated mid-line ('{not-valid-json'); on 'main' the structural branch predicate fires FIRST, so the log-read failure is moot and the hook must NOT crash into a fail-open.",
  },
};

// ---- helpers -----------------------------------------------------------------

function git(dir, ...a) {
  return execFileSync("git", ["-C", dir, ...a], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

const TEMPDIRS = [];

function mkKey(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ig-fx-key-${label}-`));
  TEMPDIRS.push(dir);
  const keyPath = path.join(dir, "id_ed25519");
  execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-f", keyPath, "-C", label]);
  const pubKey = fs.readFileSync(`${keyPath}.pub`, "utf8").trim();
  const out = execFileSync("ssh-keygen", ["-lf", `${keyPath}.pub`], { encoding: "utf8" });
  const m = out.match(/SHA256:[A-Za-z0-9+/=]+/);
  if (!m) throw new Error("could not extract ssh key fingerprint");
  return { dir, keyPath, pubKey, fingerprint: m[0] };
}

/**
 * A real git repo in the state the fixture's `_setup_note` declares.
 *
 * The tier-2 local override `{"enabled":true}` is what makes the fence RUN at all
 * without an anchored genesis. Force-ON is safe by construction: coordination-mode
 * ASYMMETRIC PRECEDENCE always honours `enabled:true` but REFUSES `enabled:false`
 * on an enrolled repo, so this precondition cannot be repurposed to weaken a real
 * one.
 */
function mkRepo(label, { branch, malformedLog }) {
  const repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ig-fx-repo-${label}-`)));
  TEMPDIRS.push(repoDir);
  execFileSync("git", ["init", "-q", "-b", "main", repoDir]);
  // Hermetic: never inherit the operator's commit.gpgsign — gpg would launch
  // pinentry on a CI runner and every fixture commit would hang or fail.
  git(repoDir, "config", "commit.gpgsign", "false");
  git(repoDir, "config", "user.email", "fixture@example.invalid");
  git(repoDir, "config", "user.name", "integrity-guard fixture");
  fs.mkdirSync(path.join(repoDir, ".claude", "learning"), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, ".claude", "learning", "coordination-mode.json"),
    '{"enabled":true}\n',
  );
  fs.writeFileSync(path.join(repoDir, ".gitignore"), ".session-notes\n");
  git(repoDir, "add", ".gitignore");
  execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "fixture baseline"], {
    stdio: "ignore",
  });

  const key = mkKey(label);
  const roster = {
    genesis: {
      repo_owner: "test-owner",
      repo_owner_kind: "user",
      root_commit: "deadbeef",
      genesis_generation: 1,
    },
    persons: {
      "pid-self": {
        display_id: DISPLAY_ID,
        role: "contributor",
        github_login: "self-login",
        host_role: null,
        keys: [{ type: "ssh", fingerprint: key.fingerprint, pubkey: key.pubKey }],
      },
    },
  };
  fs.writeFileSync(
    path.join(repoDir, ".claude", "operators.roster.json"),
    JSON.stringify(roster, null, 2),
  );

  const logPath = path.join(repoDir, ".claude", "learning", "coordination-log.jsonl");
  if (malformedLog) {
    // The fixture's own literal: a line truncated mid-JSON.
    fs.writeFileSync(logPath, "{not-valid-json\n");
  }
  if (branch && branch !== "main") {
    git(repoDir, "checkout", "-q", "-b", branch);
  }
  return { repoDir, key, logPath };
}

/** Append a REAL signed codify-lease record covering `scopeFiles`. */
function appendLease(fx, scopeFiles) {
  const { canonicalSerialize, sign } = require_(COC_SIGN);
  const core = {
    type: "codify-lease",
    verified_id: fx.key.fingerprint,
    person_id: "pid-self",
    display_id: DISPLAY_ID,
    seq: 0,
    prev_hash: null,
    ts: new Date().toISOString(),
    content: {
      scope_files: scopeFiles,
      date: DATE,
      branch: `codify/${DISPLAY_ID}-${DATE}`,
      // `acquired_at` is NOW, not DATE: DATE names the BRANCH, and a 2026-05-21
      // timestamp is past LEASE_TTL_MS on every day after it — the fixture would
      // then start failing on a calendar roll rather than on a code change.
      lease_id: `lease_fixture_${Date.now()}_${Math.floor(Math.random() * 1e6).toString(16)}`,
      acquired_at: new Date().toISOString(),
    },
  };
  const r = sign(canonicalSerialize(core), { keyType: "ssh", keyPath: fx.key.keyPath });
  if (!r.ok) throw new Error(`coc-sign failed: ${r.error}`);
  fs.appendFileSync(fx.logPath, JSON.stringify({ ...core, sig: r.sig }) + "\n");
}

/** Parse the four load-bearing assertion fields out of expected.txt. */
function parseExpected(text) {
  const field = (k) => {
    const m = new RegExp(`^${k}:\\s*(.+)$`, "m").exec(text);
    return m ? m[1].trim() : null;
  };
  // Fixture 06 writes `severity: block (on non-codify branch, …)` — the
  // parenthetical is PROSE explaining WHICH predicate fires first, not part of
  // the severity token. Strip it; comparing the raw line would red a fixture
  // that is internally consistent, which is a harness defect masquerading as a
  // finding (instrument-discipline.md MUST-1: name what a FALSE result looks
  // like, and a parser artefact is not one).
  const rawSeverity = field("severity");
  return {
    severity: rawSeverity ? rawSeverity.replace(/\s*\(.*$/, "").trim() : null,
    severity_raw: rawSeverity,
    exit_code: Number(field("exit_code")),
    continue: field("continue") === "true",
    stderr_tag: field("stderr_tag"),
  };
}

function materialize(value, repoDir) {
  return typeof value === "string" ? value.replace(/<repo>/g, repoDir) : value;
}

// Ambient values for any of these would silently change the guard's jurisdiction
// or verdict, so a fixture that does not set one must run WITHOUT it. Stripping is
// what makes this runner's result a property of the FIXTURE rather than of the
// developer's shell.
const GUARD_ENV_KEYS = [
  "CLAUDE_TRUST_STATE_DIR",
  "COC_INTEGRITY_GUARD_TIMEOUT_MS",
  "LOOM_ECOSYSTEM_CONFIG",
];

function driveGuard(fx, payload) {
  const env = { ...process.env };
  for (const k of GUARD_ENV_KEYS) delete env[k];
  env.COC_OPERATOR_REPO_DIR = fx.repoDir;
  env.COC_OPERATOR_KEY_PATH = fx.key.keyPath;
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    cwd: fx.repoDir,
    env,
    timeout: 60000,
  });
  const combined = `${r.stdout || ""}${r.stderr || ""}`;
  let json = null;
  try {
    json = JSON.parse((r.stdout || "").trim());
  } catch {
    /* a hook that emitted no parseable stdout is itself the finding */
  }
  const tagMatch = combined.match(/\[(?:BLOCK|HALT-AND-REPORT|ADVISORY)\]/);
  return {
    code: r.status,
    json,
    tag: tagMatch ? tagMatch[0] : "(none)",
    combined,
    // THE VERDICT SIGNAL IS NOT THE EXIT STATUS ALONE. instruct-and-wait emits
    // severity=block as exit 2 / continue:false, but halt-and-report as exit 0 /
    // continue:TRUE — the write RUNS. A status-only predicate reads a
    // halt-and-report fail-open as a fence, so `refused` keys on the TAG.
    refused: combined.includes("[BLOCK]") || combined.includes("[HALT-AND-REPORT]"),
  };
}

/** Build the PreToolUse payload for one fixture against a materialized repo. */
function loadFixture(name, repoDir) {
  const dir = path.join(HERE, name);
  const input = JSON.parse(fs.readFileSync(path.join(dir, "input.json"), "utf8"));
  const expected = parseExpected(fs.readFileSync(path.join(dir, "expected.txt"), "utf8"));
  const payload = {
    session_id: "integrity-guard-audit-fixtures",
    hook_event_name: input.hook_event_name,
    tool_name: input.tool_name,
    tool_input: {},
    cwd: repoDir,
  };
  for (const [k, v] of Object.entries(input.tool_input || {})) {
    payload.tool_input[k] = materialize(v, repoDir);
  }
  return { name, input, expected, payload };
}

/** Make sure the target's parent exists — Write/Edit fixtures name nested paths. */
function ensureParent(p) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
  } catch {
    /* best-effort */
  }
}

// =============================================================================

console.log(`\nhook under test : ${HOOK}`);
console.log(`display_id      : ${DISPLAY_ID}   codify date token: ${DATE}`);

// ---- T1: fixture-set coverage ------------------------------------------------
// Runs FIRST: a runner that silently skips a fixture is the exact defect class
// this whole file exists to close, so coverage is asserted before any behaviour.
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
    "non-empty = a fixture dir exists that this runner silently ignores — the F51 'survives an all-green CI executing nothing' condition, reopened one directory at a time",
  );
  for (const f of onDisk) {
    check(
      `${f}/ carries both input.json and expected.txt`,
      fs.existsSync(path.join(HERE, f, "input.json")) &&
        fs.existsSync(path.join(HERE, f, "expected.txt")),
      "both present",
      "a half-populated fixture dir cannot assert anything, and its absence would read as a pass",
    );
    check(
      `${f}/ has a declared harness setup`,
      Object.prototype.hasOwnProperty.call(SETUPS, f),
      SETUPS[f] ? "setup declared" : "NO SETUP",
      "absent = the fixture would be driven at whatever state happens to exist, so its verdict would be a property of the harness rather than of the predicate it names",
    );
  }
}

// ---- T2: expected.txt internal consistency -----------------------------------
// Fixture 02's own `note:` records a severity that drifted out of sync with the
// hook for months precisely because nothing executed this directory. The severity
// token and the exit/continue pair encode the SAME verdict; locking them against
// each other means a future half-edit reds here rather than silently disagreeing.
console.log("\n=== T2: each expected.txt is internally consistent ===");
{
  for (const name of EXPECTED_FIXTURES) {
    const e = parseExpected(fs.readFileSync(path.join(HERE, name, "expected.txt"), "utf8"));
    const isRefusal = e.severity === "block" || e.severity === "halt-and-report";
    const consistent = isRefusal
      ? e.exit_code === (e.severity === "block" ? 2 : 0) &&
        e.continue === true && // no severity halts the session: a block is exit 2 + deny
        e.stderr_tag !== "(none)"
      : e.exit_code === 0 && e.continue === true && e.stderr_tag === "(none)";
    check(
      `${name}: severity "${e.severity}" agrees with exit_code/continue/stderr_tag`,
      consistent,
      `severity=${e.severity} exit=${e.exit_code} continue=${e.continue} tag=${e.stderr_tag}`,
      "disagreement = the fixture pins two different verdicts at once; whichever field the reader trusts, the other is a standing argument for the opposite disposition (the exact drift fixture 02's own note records)",
    );
  }
}

// ---- T3: per-fixture behaviour at the declared setup --------------------------
console.log("\n=== T3: drive each fixture against the REAL hook at its declared setup ===");
{
  for (const name of EXPECTED_FIXTURES) {
    const setup = SETUPS[name];
    const fx = mkRepo(name.slice(0, 2), setup);
    if (setup.lease) appendLease(fx, setup.lease);
    const f = loadFixture(name, fx.repoDir);
    if (f.payload.tool_input.file_path) ensureParent(f.payload.tool_input.file_path);
    const r = driveGuard(fx, f.payload);

    console.log(`\n  -- ${name} [harness setup: branch=${setup.branch}${setup.lease ? ", signed lease" : ""}${setup.malformedLog ? ", malformed log" : ""} — ${setup.why}]`);

    check(
      `${name}: exit code ${f.expected.exit_code}`,
      r.code === f.expected.exit_code,
      `exit=${r.code} (expected ${f.expected.exit_code})`,
      `a different exit code = the guard took a different branch than the fixture's declared predicate; exit 0 where ${f.expected.exit_code} is expected is a fail-OPEN on an integrity-critical write, exit ${f.expected.exit_code} where 0 is expected is a false positive that halts a clean /codify`,
    );
    check(
      `${name}: continue=${f.expected.continue}`,
      r.json !== null && (r.json.continue !== false) === f.expected.continue,
      `continue=${r.json ? r.json.continue : "<unparseable stdout>"}`,
      "a mismatched or unparseable `continue` = the agent is either let through a fenced integrity-critical write or halted on an authorized one",
    );
    if (f.expected.stderr_tag === "(none)") {
      check(
        `${name}: silent passthrough — no severity tag emitted`,
        r.tag === "(none)",
        `tag=${r.tag}`,
        "any tag = the guard surfaced a finding on a lane the fixture declares clean (false positive). exit/continue ALONE cannot see this: halt-and-report is exit 0 / continue:true, byte-identical to a silent pass on both fields",
      );
    } else {
      check(
        `${name}: emits ${f.expected.stderr_tag}`,
        r.tag === f.expected.stderr_tag,
        `tag=${r.tag}`,
        `a different tag = the verdict SEVERITY moved. Specifically, [HALT-AND-REPORT] where [BLOCK] is pinned maps to continue:true and the Edit/Write RUNS — on a PreToolUse mutation fence that is not a softer refusal but NO refusal (loom#1855 review F-C)`,
      );
      check(
        `${name}: emitted payload names the guard`,
        /integrity-guard/.test(r.combined),
        "guard named in the emitted report",
        "absent = the agent receives a refusal with no attributable source (hook-output-discipline.md MUST-1)",
      );
    }
  }
}

// ---- T4: PAIRED CONTROLS — each green is attributable to its own predicate ----
//
// Every row above is consistent with a degenerate hook: one that refuses
// everything would satisfy 01/02/05/06, and one that passes everything would
// satisfy 03/04. Neither shape is excluded by the fixture set alone. Each control
// below flips EXACTLY ONE element of a fixture's declared setup and requires the
// disposition to CHANGE, so the instrument is shown to discriminate rather than
// asserted to (instrument-discipline.md MUST-1 + MUST-3).
console.log("\n=== T4: paired controls — flip one setup element, require the verdict to move ===");
{
  // C1 — 03's PASS is attributable to the LEASE, not to a watched-path miss.
  {
    const setup = SETUPS["03-pass-branch-and-lease-match"];
    const fx = mkRepo("c1", setup);
    const f = loadFixture("03-pass-branch-and-lease-match", fx.repoDir);
    ensureParent(f.payload.tool_input.file_path);
    const before = driveGuard(fx, f.payload); // NO lease appended
    appendLease(fx, setup.lease);
    const after = driveGuard(fx, f.payload);
    check(
      "C1: same payload + same branch, lease ABSENT ⇒ REFUSED / lease PRESENT ⇒ passthrough",
      before.refused === true && after.refused === false && after.code === 0,
      `no-lease: exit=${before.code} tag=${before.tag} | with-lease: exit=${after.code} tag=${after.tag}`,
      "identical dispositions = the covering-lease lookup is NOT what produces fixture 03's passthrough, so that green carries no information about findCoveringLease. A no-lease passthrough specifically means the fence is off (watched-path miss, coordination gate, or an unresolved identity), and fixture 03 would then be green against a guard that authorizes every integrity-critical write",
    );
  }

  // C2 — 04's PASS is attributable to the PATH predicate. Same repo, same branch
  // ('main', which blocks every watched path), only the target changes.
  {
    const fx = mkRepo("c2", SETUPS["04-pass-unwatched-path"]);
    const f = loadFixture("04-pass-unwatched-path", fx.repoDir);
    ensureParent(f.payload.tool_input.file_path);
    const unwatched = driveGuard(fx, f.payload);
    const watchedPayload = JSON.parse(JSON.stringify(f.payload));
    watchedPayload.tool_input.file_path = path.join(fx.repoDir, ".claude", "operators.roster.json");
    const watched = driveGuard(fx, watchedPayload);
    check(
      "C2: same repo/branch, src/foo.js ⇒ passthrough / operators.roster.json ⇒ REFUSED",
      unwatched.refused === false && unwatched.code === 0 && watched.refused === true,
      `src/foo.js: exit=${unwatched.code} tag=${unwatched.tag} | roster: exit=${watched.code} tag=${watched.tag}`,
      "identical dispositions = isWatchedPath is not gating anything here. If BOTH pass, the §2.3 watched set stopped matching and every integrity-critical artifact is unfenced; if BOTH refuse, the guard fences ordinary source edits and every session halts on src/",
    );
  }

  // C3 — 01's BLOCK is attributable to the BRANCH predicate. Identical payload,
  // identical watched target; only the active branch (+ its required lease) moves.
  {
    const fxMain = mkRepo("c3a", { branch: "main" });
    const fMain = loadFixture("01-block-non-codify-branch", fxMain.repoDir);
    ensureParent(fMain.payload.tool_input.file_path);
    const onMain = driveGuard(fxMain, fMain.payload);

    const fxCodify = mkRepo("c3b", { branch: `codify/${DISPLAY_ID}-${DATE}` });
    appendLease(fxCodify, [".claude/operators.roster.json"]);
    const fCodify = loadFixture("01-block-non-codify-branch", fxCodify.repoDir);
    ensureParent(fCodify.payload.tool_input.file_path);
    const onCodify = driveGuard(fxCodify, fCodify.payload);

    check(
      "C3: same roster Edit, branch=main ⇒ REFUSED / branch=codify/self-<date> + lease ⇒ passthrough",
      onMain.refused === true && onCodify.refused === false && onCodify.code === 0,
      `main: exit=${onMain.code} tag=${onMain.tag} | codify: exit=${onCodify.code} tag=${onCodify.tag}`,
      "identical dispositions = resolveActiveBranch/isCodifyBranch is not what produces fixture 01's block. A guard that refuses on BOTH makes /codify itself impossible; one that passes on BOTH has lost the §2.3 off-codify fence entirely",
    );
  }

  // C4 — 05's BLOCK is attributable to FOREIGNNESS, not merely to "codify/ + no
  // lease". Both arms sit on a codify-shaped branch with a covering lease; only
  // the display_id embedded in the branch name differs.
  {
    const fxForeign = mkRepo("c4a", SETUPS["05-pass-foreign-codify-branch"]);
    appendLease(fxForeign, [".claude/operators.roster.json"]);
    const fForeign = loadFixture("05-pass-foreign-codify-branch", fxForeign.repoDir);
    ensureParent(fForeign.payload.tool_input.file_path);
    const foreign = driveGuard(fxForeign, fForeign.payload);

    const fxOwn = mkRepo("c4b", { branch: `codify/${DISPLAY_ID}-${DATE}` });
    appendLease(fxOwn, [".claude/operators.roster.json"]);
    const fOwn = loadFixture("05-pass-foreign-codify-branch", fxOwn.repoDir);
    ensureParent(fOwn.payload.tool_input.file_path);
    const own = driveGuard(fxOwn, fOwn.payload);

    check(
      "C4: covering lease on BOTH arms — codify/SIBLING-<date> ⇒ REFUSED / codify/self-<date> ⇒ passthrough",
      foreign.refused === true && own.refused === false && own.code === 0,
      `SIBLING: exit=${foreign.code} tag=${foreign.tag} | self: exit=${own.code} tag=${own.tag}`,
      "identical dispositions = the {foreign:true} arm of isCodifyBranch is dead. A pass on the SIBLING arm means one operator can write integrity-critical artifacts from another operator's codify branch — the cross-operator condition the lease exists to guard",
    );
  }

  // C5 — the opt-in gate is load-bearing. The SAME fixture that blocks on an
  // enrolled repo must pass SILENTLY on an un-enrolled one; without this row,
  // 01/05/06's blocks are consistent with a guard that ignores the gate and
  // taxes every solo repo (the MO-OPT W1 disruption).
  {
    const fx = mkRepo("c5", { branch: "main" });
    // Un-enroll: remove BOTH the roster and the tier-2 force-ON override, which
    // is the only pair that resolves coordination OFF (asymmetric precedence
    // REFUSES {enabled:false} on an enrolled repo, so deleting the roster is
    // required — flipping the override alone would not turn the gate off).
    fs.rmSync(path.join(fx.repoDir, ".claude", "operators.roster.json"), { force: true });
    fs.rmSync(path.join(fx.repoDir, ".claude", "learning", "coordination-mode.json"), {
      force: true,
    });
    const f = loadFixture("01-block-non-codify-branch", fx.repoDir);
    ensureParent(f.payload.tool_input.file_path);
    const r = driveGuard(fx, f.payload);
    check(
      "C5: coordination OFF (no roster, no override) ⇒ SILENT passthrough, NOT a fail-open",
      r.code === 0 && r.json?.continue === true && r.tag === "(none)",
      `exit=${r.code} continue=${r.json?.continue} tag=${r.tag}`,
      "a refusal here = the opt-in gate stopped gating and a solo/un-enrolled repo now pays the full multi-operator fence. WITHOUT the tag leg this row cannot discriminate: halt-and-report is exit 0 / continue:true and would read as a silent pass",
    );
  }
}

// ---- cleanup -----------------------------------------------------------------
for (const d of TEMPDIRS) {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// NOT "PASS <n>" — that shape matches CASE_PASS and the harness would count the
// summary line as an extra case. "SUMMARY:" matches neither case pattern.
console.log(`\n${"=".repeat(62)}\nSUMMARY: ${pass} passed, ${fail} failed\n${"=".repeat(62)}`);
process.exit(fail === 0 ? 0 : 1);
