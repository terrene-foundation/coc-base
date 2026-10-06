#!/usr/bin/env node
/**
 * genesis-anchor-guard — canonical fixture runner (F51 residue).
 *
 * WHY THIS EXISTS. `.claude/audit-fixtures/genesis-anchor-guard/` shipped 50
 * files across three fixture families and NO `run.mjs`.
 * `.claude/bin/run-audit-fixtures.mjs` enforces a bidirectional closure over
 * fixture dirs, but ONLY over the `run.mjs` convention: an unregistered runner
 * reds with `UNREGISTERED runner:`, a registered-but-missing file reds with
 * `STALE registry entry:`, and `min_cases` reds a runner that silently stops
 * executing. A dir holding DATA and no runner is outside that closure BY
 * DESIGN — so this corpus, which includes the signing fixture and both N=1
 * org-admin anchor sets, survived an all-green CI having executed nothing.
 * `cc-artifacts.md` Rule 9 + `hook-output-discipline.md` MUST-4 make the
 * per-predicate fixture corpus a CONTRACT; an unrun fixture does not hold up
 * its end.
 *
 * WHAT THIS DOES *NOT* CLAIM. `genesis-anchor-guard.js` is NOT an untested
 * guard, and this runner does not make it tested. `genesis-anchor-guard.test.mjs`
 * is registered in `ci-suites.json`, and the two `must-7-*` sets each name a
 * behavioral suite that already exercises the same predicates with REAL keys and
 * REAL signatures (`tests/integration/multi-operator/f86-must-7-single-owner.test.js`,
 * `.../azure-migration-ceremony.test.js`). What was unexecuted is THIS corpus.
 *
 * THREE FAMILIES, THREE DIFFERENT INSTRUMENTS — and the choice per family is
 * dictated by what the fixture's own `.expected.txt` asserts, not by convenience:
 *
 *   A. The seven top-level `pretooluse-*.json` payloads. Their expectations are
 *      "watched" / "not-watched" — a claim about `isWatchedTool`. That predicate
 *      is NOT exported, so the honest instrument is the HOOK END-TO-END: staged
 *      at a repo state where a WATCHED tool blocks, "watched" and "not-watched"
 *      become two observably different dispositions produced by one state. Both
 *      poles are present in the fixture set itself, which is what lets family A
 *      discriminate without any harness-side mutation.
 *
 *   B. `malformed-log-line-structural-null.txt`. Its `.expected.txt` makes TWO
 *      claims — `loadLogRecords` skips the malformed lines without crashing, AND
 *      the resulting no-verifying-anchor state fails CLOSED. Both are asserted:
 *      the first at the exported `loadLogRecords` seam, the second end-to-end.
 *
 *   C/D. The two `must-7-single-owner` sets (GitHub + ADO). Their expectations carry
 *      `accepted: <bool>` (+ `reason_class:` on the GitHub set) and both READMEs
 *      state the runner contract explicitly: load the `.json`, pass it to
 *      `foldGenesisMigration` against a SYNTHETIC roster + foldState, and compare
 *      STRUCTURALLY (verdict + reason-class), NOT prose-equal, NOT by re-executing
 *      the signature gate — the fixtures carry STUB sigs on purpose and the
 *      behavioral suites own signature verification. This runner honours that
 *      contract exactly; it does not upgrade a snapshot into a crypto assertion
 *      it was never authored to make.
 *
 * INSTRUMENT DISCIPLINE (rules/instrument-discipline.md MUST-1/2/3). Every check
 * names the FALSIFYING result. The greens are not read alone: § T6 drives
 * NEGATIVE CONTROLS that flip exactly one element of the synthetic world and
 * require the verdict to MOVE. Without them, family C/D's eight and nine
 * rejections are each consistent with a fold that rejects everything, and the two
 * canonical passes are consistent with a roster that happens to fit.
 *
 *   node .claude/audit-fixtures/genesis-anchor-guard/run.mjs
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
const HOOK = process.env.HOOK || path.join(REPO, ".claude/hooks/genesis-anchor-guard.js");
const FOLD = path.join(REPO, ".claude/hooks/lib/fold-rule-9c.js");
const require_ = createRequire(import.meta.url);

const GH_DIR = path.join(HERE, "must-7-single-owner");
const ADO_DIR = path.join(HERE, "must-7-single-owner-ado");
const MALFORMED = path.join(HERE, "malformed-log-line-structural-null.txt");

let pass = 0,
  fail = 0;

// Per-case lines MUST match run-audit-fixtures.mjs::CASE_PASS / CASE_FAIL
// (/^[ \t]*(?:PASS|ok)[ \t]+\S/ and /^[ \t]*(?:FAIL|not ok)[ \t]+\S/). A "  ✓ name"
// line matches NEITHER: the harness would then count ONE case — the summary — and
// an ALL-FAILING run would present as 1p/0f.
function check(name, ok, detail, falsifier) {
  const idx = String(pass + fail + 1).padStart(2, "0");
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${idx}  ${name}`);
  if (detail) console.log(`      ${detail}`);
  if (!ok) console.log(`      FALSIFIER: ${falsifier}`);
}

// ---- fixture-set declaration -------------------------------------------------
//
// README.md § the predicate tables are the authority on which fixtures exist.
const PAYLOAD_FIXTURES = [
  "pretooluse-bash-git-commit",
  "pretooluse-bash-git-push",
  "pretooluse-bash-read-only-passthrough",
  "pretooluse-bash-shell-variable-skip",
  "pretooluse-bash-ssh-keygen-sign",
  "pretooluse-edit-roster",
  "pretooluse-edit-unrelated",
];

const GH_FIXTURES = [
  "n1-org-admin-canonical-pass",
  "n1-org-admin-mismatched-user-login",
  "n1-org-admin-missing-discriminator",
  "n1-org-admin-pending-role",
  "n1-org-admin-populated-co-signers",
  "n1-org-admin-stale-capture",
  "n1-org-admin-suspended-state",
  "n1-org-admin-user-owned-kind",
];

const ADO_FIXTURES = [
  "ado-n1-cross-provider-discriminator-forgery",
  "ado-n1-org-admin-canonical-pass",
  "ado-n1-org-admin-mismatched-principal",
  "ado-n1-org-admin-missing-discriminator",
  "ado-n1-org-admin-pending-role",
  "ado-n1-org-admin-populated-co-signers",
  "ado-n1-org-admin-stale-capture",
  "ado-n1-org-admin-suspended-state",
  "ado-n1-org-admin-user-owned-kind",
];

const TEMPDIRS = [];

// ---- helpers -----------------------------------------------------------------

function git(dir, ...a) {
  return execFileSync("git", ["-C", dir, ...a], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function mkKey(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gag-fx-key-${label}-`));
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
 * THE PRECONDITION IS THE WHOLE POINT for family A.
 *
 * `enrolled:true` builds a repo the guard reads as ENROLLED-WITH-NO-VERIFYING-
 * ANCHOR: a roster IS present, and the coordination log carries the malformed
 * fixture's own bytes — two unparseable lines the fold must skip, plus one
 * well-formed record whose `sig` is illustrative and does NOT verify. Per
 * README.md § Notes, "a log with no records OR only malformed lines OR only
 * non-verifying records IS the 'no verifying owner-bound anchor' case → hard
 * block". So a WATCHED tool refuses and an UNWATCHED tool passes — from ONE
 * state, which is what makes family A self-discriminating.
 *
 * `enrolled:false` (no roster, empty log) is the fresh-substrate-adopter lane
 * used as the § T6 control.
 *
 * The tier-2 override `{"enabled":true}` is what makes the guard RUN at all
 * without an anchored genesis. Force-ON is safe by construction: coordination-mode
 * ASYMMETRIC PRECEDENCE always honours `enabled:true` and REFUSES `enabled:false`
 * on an enrolled repo, so this precondition cannot be repurposed to weaken a real
 * one.
 */
function mkRepo(label, { enrolled }) {
  const repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `gag-fx-repo-${label}-`)));
  TEMPDIRS.push(repoDir);
  execFileSync("git", ["init", "-q", "-b", "main", repoDir]);
  // Hermetic: never inherit the operator's commit.gpgsign — gpg would launch
  // pinentry on a CI runner and every fixture commit would hang or fail.
  git(repoDir, "config", "commit.gpgsign", "false");
  git(repoDir, "config", "user.email", "fixture@example.invalid");
  git(repoDir, "config", "user.name", "genesis-anchor fixture");
  fs.mkdirSync(path.join(repoDir, ".claude", "learning"), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, ".claude", "learning", "coordination-mode.json"),
    '{"enabled":true}\n',
  );
  fs.writeFileSync(path.join(repoDir, "README.md"), "fixture baseline\n");
  git(repoDir, "add", "README.md");
  execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "fixture baseline"], {
    stdio: "ignore",
  });

  const key = mkKey(label);
  const rosterPath = path.join(repoDir, ".claude", "operators.roster.json");
  const logPath = path.join(repoDir, ".claude", "learning", "coordination-log.jsonl");

  if (enrolled) {
    fs.writeFileSync(
      rosterPath,
      JSON.stringify(
        {
          genesis: {
            repo_owner: "test-owner",
            repo_owner_kind: "user",
            root_commit: "deadbeef",
            genesis_generation: 0,
          },
          persons: {
            "pid-self": {
              display_id: "self",
              role: "owner",
              github_login: "self",
              host_role: "human",
              keys: [{ type: "ssh", fingerprint: key.fingerprint, pubkey: key.pubKey }],
            },
          },
        },
        null,
        2,
      ),
    );
    // The corpus's OWN malformed-log fixture IS the log. This is deliberate: it
    // makes family A's staging and family B's end-to-end assertion the same
    // world, so neither can drift away from the other.
    fs.copyFileSync(MALFORMED, logPath);
  } else {
    fs.rmSync(path.join(repoDir, ".claude", "learning", "coordination-mode.json"), {
      force: true,
    });
  }
  return { repoDir, key, rosterPath, logPath };
}

// Ambient values for any of these would silently change the guard's jurisdiction
// or verdict, so a fixture that does not set one must run WITHOUT it. Stripping is
// what makes this runner's result a property of the FIXTURE rather than of the
// developer's shell. COC_GENESIS_GUARD_ENROLLMENT_MARKER especially: a marker
// left in the environment is the guard's documented enrollment-in-progress
// relaxation and would convert every family-A block into a pass.
const GUARD_ENV_KEYS = [
  "CLAUDE_TRUST_STATE_DIR",
  "COC_GENESIS_GUARD_ENROLLMENT_MARKER",
  "COC_OPERATOR_KEY_PATH",
  "LOOM_ECOSYSTEM_CONFIG",
];

function driveGuard(fx, payload) {
  const env = { ...process.env };
  for (const k of GUARD_ENV_KEYS) delete env[k];
  env.COC_OPERATOR_REPO_DIR = fx.repoDir;
  // resolvePaths() honours these ONLY when BOTH are set (genesis-anchor-guard.js
  // §resolvePaths) — otherwise it falls back to paths relative to the HOOK FILE,
  // i.e. THIS repo's live roster and live coordination log. Setting one alone is
  // the silent-wrong-world failure; both, or neither.
  env.COC_GENESIS_GUARD_ROSTER_PATH = fx.rosterPath;
  env.COC_GENESIS_GUARD_LOG_PATH = fx.logPath;
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
    // block as exit 2 / continue:false but halt-and-report as exit 0 /
    // continue:TRUE — the tool call RUNS. A status-only predicate reads a
    // halt-and-report fail-open as a fence, so `refused` keys on the TAG.
    refused: combined.includes("[BLOCK]") || combined.includes("[HALT-AND-REPORT]"),
  };
}

/** `watched:` / `not-watched:` is the whole machine-readable content of family A. */
function parsePayloadExpectation(text) {
  const t = text.trim();
  if (/^not-watched:/.test(t)) return "not-watched";
  if (/^watched:/.test(t)) return "watched";
  return null;
}

/** `accepted: <bool>` (+ optional `reason_class:`) — families C/D. */
function parseFoldExpectation(text) {
  const acc = /^accepted:\s*(true|false)\s*$/m.exec(text);
  const rc = /^reason_class:\s*(.+)$/m.exec(text);
  return {
    accepted: acc ? acc[1] === "true" : null,
    // The README calls this the "structural-class identifier" and mandates a
    // STRUCTURAL comparison, "NOT prose-equal" — so this line is a CLASS LABEL,
    // and asserting it as a literal substring is the wrong instrument. Measured:
    // `reason_class: user.login mismatch` against a live reason reading "user.login
    // (mallory) does not match sole owner's bound github_login (alice)" — same
    // gate, different words, and a literal match reds a fixture that is correct.
    //
    // So the alternatives (`|`-separated) are decomposed into WORD tokens and the
    // assertion is that AT LEAST ONE token of length >= 4 appears in the reason.
    // The looseness is deliberate and bounded, and it still discriminates on the
    // hypothesis this row exists to test — a PREDICATE SWAP. Measured against the
    // sibling gates: if the mismatched-login record were instead refused by the
    // freshness gate, the reason would read "stale ... per migration-ceremony
    // freshness predicate" and carries NONE of {user, login, mismatch}, so the row
    // reds. What it does NOT do is pin the exact wording, which the README forbids.
    reason_class: rc
      ? rc[1]
          .split("|")
          .map((s) => s.trim())
          .filter(Boolean)
      : null,
    reason_class_raw: rc ? rc[1].trim() : null,
  };
}

// The synthetic rosters the two READMEs' runner contracts call for. Each is the
// MINIMUM world in which its canonical-pass fixture can be accepted: exactly one
// rostered owner, that owner holding the fixture's `verified_id` as an enrolled
// key, bound to the identity the fixture's capture attests (github_login on the
// GitHub set, principal/Entra-UPN on the ADO set).
function ghRoster() {
  return {
    genesis: {
      repo_owner: "myorg",
      repo_owner_kind: "org",
      root_commit: "abc123def456",
      genesis_generation: 0,
    },
    persons: {
      "pid-owner-f86": {
        display_id: "alice",
        role: "owner",
        github_login: "alice",
        host_role: "human",
        keys: [
          {
            type: "ssh",
            fingerprint: "SHA256:CANONICAL-FP",
            pubkey: "ssh-ed25519 AAAA-FIXTURE-STUB alice",
          },
        ],
      },
    },
  };
}

function adoRoster() {
  return {
    genesis: {
      repo_owner: "myorg",
      repo_owner_kind: "org",
      root_commit: "abc123def456",
      genesis_generation: 0,
    },
    persons: {
      "pid-owner-ado-f122": {
        display_id: "alice",
        role: "owner",
        principal: "alice@contoso.com",
        host_role: "human",
        keys: [
          {
            type: "ssh",
            fingerprint: "SHA256:ADO-CANONICAL-FP",
            pubkey: "ssh-ed25519 AAAA-FIXTURE-STUB alice",
          },
        ],
      },
    },
  };
}

function loadRecord(dir, name) {
  return JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"));
}

function loadFoldExpected(dir, name) {
  return parseFoldExpectation(fs.readFileSync(path.join(dir, `${name}.expected.txt`), "utf8"));
}

// =============================================================================

const { foldGenesisMigration } = require_(FOLD);
const { loadLogRecords } = require_(HOOK);

console.log(`\nhook under test : ${HOOK}`);
console.log(`fold under test : ${FOLD}`);

// ---- T1: fixture-set coverage ------------------------------------------------
// Runs FIRST: a runner that silently skips a fixture is the exact defect class
// this file exists to close, so coverage is asserted before any behaviour is.
console.log("\n=== T1: every fixture on disk is driven by this runner ===");
{
  const onDisk = fs
    .readdirSync(HERE)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
  const missing = PAYLOAD_FIXTURES.filter((f) => !onDisk.includes(f));
  const extra = onDisk.filter((f) => !PAYLOAD_FIXTURES.includes(f));
  check(
    "every payload fixture named in README.md exists on disk",
    missing.length === 0,
    `expected ${PAYLOAD_FIXTURES.length}, on disk ${onDisk.length}`,
    `non-empty missing list (${JSON.stringify(missing)}) = the README table names a fixture nothing drives`,
  );
  check(
    "no payload fixture on disk is left undriven",
    extra.length === 0,
    `undriven: ${JSON.stringify(extra)}`,
    "non-empty = a fixture exists that this runner silently ignores — the F51 'survives an all-green CI executing nothing' condition, reopened one file at a time",
  );
  for (const f of PAYLOAD_FIXTURES) {
    check(
      `${f}: both .json and .expected.txt present`,
      fs.existsSync(path.join(HERE, `${f}.json`)) &&
        fs.existsSync(path.join(HERE, `${f}.expected.txt`)),
      "both present",
      "a half-populated fixture cannot assert anything, and its absence would read as a pass",
    );
  }
  check(
    "the structural-NULL log fixture and its expectation both exist",
    fs.existsSync(MALFORMED) &&
      fs.existsSync(path.join(HERE, "malformed-log-line-structural-null.expected.txt")),
    "both present",
    "absent = family B has nothing to assert against",
  );

  for (const [label, dir, list] of [
    ["must-7-single-owner", GH_DIR, GH_FIXTURES],
    ["must-7-single-owner-ado", ADO_DIR, ADO_FIXTURES],
  ]) {
    const disk = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
    const miss = list.filter((f) => !disk.includes(f));
    const ext = disk.filter((f) => !list.includes(f));
    check(
      `${label}/: README predicate matrix and disk agree`,
      miss.length === 0 && ext.length === 0,
      `declared ${list.length}, on disk ${disk.length}`,
      `missing=${JSON.stringify(miss)} undriven=${JSON.stringify(ext)} — either direction means a predicate the README claims is locked is in fact executed by nothing`,
    );
    for (const f of disk) {
      check(
        `${label}/${f}: .expected.txt declares a machine-readable verdict`,
        loadFoldExpected(dir, f).accepted !== null,
        `accepted=${loadFoldExpected(dir, f).accepted}`,
        "a null verdict = the expectation is prose only; this runner would then be asserting nothing while reporting a pass — the vacuity shape instrument-discipline.md MUST-2 forbids",
      );
    }
  }
}

// ---- T2: family A — the seven payloads, end-to-end at one staged state --------
console.log("\n=== T2: payload fixtures — watched ⇒ REFUSED, not-watched ⇒ silent passthrough ===");
const enrolledFx = mkRepo("enrolled", { enrolled: true });
{
  console.log(
    `  [harness precondition: ENROLLED-with-NO-VERIFYING-ANCHOR — roster present; coordination log = this corpus's own malformed-log fixture (2 unparseable lines the fold must skip + 1 well-formed record whose sig is illustrative and does NOT verify). Per README.md § Notes that IS the "no verifying owner-bound anchor" case → hard block for a WATCHED tool. One state, two dispositions.]`,
  );
  for (const name of PAYLOAD_FIXTURES) {
    const payload = JSON.parse(fs.readFileSync(path.join(HERE, `${name}.json`), "utf8"));
    payload.cwd = enrolledFx.repoDir;
    const want = parsePayloadExpectation(
      fs.readFileSync(path.join(HERE, `${name}.expected.txt`), "utf8"),
    );
    const r = driveGuard(enrolledFx, payload);

    check(
      `${name}: .expected.txt declares a watched/not-watched class`,
      want !== null,
      `class=${want}`,
      "null = the expectation names no disposition, so any observed behaviour would satisfy it",
    );
    if (want === "watched") {
      check(
        `${name}: WATCHED ⇒ the guard proceeds to verify the trust root and REFUSES`,
        r.refused === true && r.code === 2 && r.json?.hookSpecificOutput?.permissionDecision === "deny" && r.json?.continue !== false,
        `exit=${r.code} continue=${r.json?.continue} tag=${r.tag}`,
        "a silent exit 0 here = isWatchedTool no longer matches this literal, so a sign/commit/push/roster-write proceeds on a repo with NO verifying owner-bound genesis anchor — the fail-OPEN this guard exists to prevent",
      );
      check(
        `${name}: refusal is attributable — the emitted payload names the guard`,
        /genesis-anchor/.test(r.combined),
        "guard named in the emitted report",
        "absent = the agent receives a refusal with no attributable source (hook-output-discipline.md MUST-1)",
      );
    } else {
      check(
        `${name}: NOT-WATCHED ⇒ SILENT passthrough (no severity tag at all)`,
        r.code === 0 && r.json?.continue === true && r.tag === "(none)",
        `exit=${r.code} continue=${r.json?.continue} tag=${r.tag}`,
        "a refusal here = the positive allowlist over-matched. For pretooluse-bash-shell-variable-skip specifically that is a hook-output-discipline.md MUST-3 violation: `$GITCMD commit` is a PRE-EXPANSION shell variable the hook cannot evaluate, and blocking on it is a lexical block. And WITHOUT the tag leg this row cannot discriminate — halt-and-report is exit 0 / continue:true, byte-identical to a silent pass on both other fields",
      );
    }
  }
}

// ---- T3: family B — the structural-NULL log fixture ---------------------------
console.log("\n=== T3: malformed-log-line-structural-null — skip, do not crash, fail CLOSED ===");
{
  let recs = null,
    threw = null;
  try {
    recs = loadLogRecords(MALFORMED);
  } catch (e) {
    threw = e;
  }
  check(
    "loadLogRecords does NOT throw on a log carrying malformed lines",
    threw === null,
    threw ? `threw: ${threw.message}` : "returned normally",
    "a throw = the malformed line reaches main()'s catch-all, and that catch-all's recovery arm is a passthrough — a syntactically bad line would then DISABLE the anchor fence, which is failing OPEN on the syntactic question exactly where MUST-4 requires failing closed on the SEMANTIC one",
  );
  check(
    "loadLogRecords SKIPS the unparseable lines and keeps the well-formed one",
    Array.isArray(recs) && recs.length === 1 && recs[0].verified_id === "SHA256:def",
    `records=${Array.isArray(recs) ? recs.length : "<none>"} ids=${JSON.stringify((recs || []).map((r) => r.verified_id))}`,
    "0 records = the parser rejected the whole file on one bad line (the well-formed record is silently lost, so a real anchor could be dropped by an unrelated truncation); >1 = a malformed line was admitted as a record and can contribute to trust-root computation, which is the fixture's stated impossibility ('they cannot be folded — no signature to verify')",
  );
  const r = driveGuard(enrolledFx, {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git commit -m 'structural-null probe'" },
    cwd: enrolledFx.repoDir,
  });
  check(
    "end-to-end: skipped-malformed + non-verifying survivor ⇒ fail CLOSED (block)",
    r.code === 2 && r.json?.hookSpecificOutput?.permissionDecision === "deny" && r.json?.continue !== false && r.tag === "[BLOCK]",
    `exit=${r.code} continue=${r.json?.continue} tag=${r.tag}`,
    "exit 0 = no verifying anchor was found and the guard let the commit through anyway. The surviving record parses but its sig is illustrative and does NOT verify, so this is precisely the fixture's declared 'only non-verifying records' case — a pass makes the fence a no-op against any log an attacker can corrupt",
  );
}

// ---- T4/T5: families C + D — fold the N=1 org-admin snapshot corpora -----------
for (const [label, dir, list, roster] of [
  ["must-7-single-owner (GitHub)", GH_DIR, GH_FIXTURES, ghRoster()],
  ["must-7-single-owner-ado (Azure DevOps)", ADO_DIR, ADO_FIXTURES, adoRoster()],
]) {
  console.log(`\n=== T4/T5: ${label} — foldGenesisMigration against the synthetic N=1 roster ===`);
  const reasons = new Map();
  for (const name of list) {
    const record = loadRecord(dir, name);
    const want = loadFoldExpected(dir, name);
    const v = foldGenesisMigration(record, { foldState: null, roster });

    check(
      `${name}: accepted=${want.accepted}`,
      v.accepted === want.accepted,
      `accepted=${v.accepted}${v.accepted ? "" : ` reason="${String(v.reason).slice(0, 110)}"`}`,
      want.accepted
        ? "a rejection = the fold predicate no longer admits a WELL-FORMED N=1 org-admin anchor, so a legitimate single-owner org migration is now impossible (and every rejection row below would still be green, which is why this pole must be asserted)"
        : "an acceptance = this fixture's malformed/forged/stale record now FOLDS CLEAN, promoting it to the repo's trust root. That is the sock-puppet / replay / cross-provider-forgery class MUST-7 exists to block",
    );
    if (!v.accepted) {
      check(
        `${name}: rejection carries a non-empty reason`,
        typeof v.reason === "string" && v.reason.length > 0,
        `reason length=${typeof v.reason === "string" ? v.reason.length : 0}`,
        "an empty reason = the caller emitting this verdict cannot tell the operator WHICH gate refused, and the remediation it prints would be a guess",
      );
      reasons.set(name, v.reason);
    }
    if (want.reason_class) {
      const lower = String(v.reason || "").toLowerCase();
      const tokens = want.reason_class
        .flatMap((alt) => alt.split(/[^A-Za-z0-9_.-]+/))
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length >= 4);
      const hit = tokens.find((t) => lower.includes(t));
      check(
        `${name}: reason matches the declared reason_class`,
        hit !== undefined,
        `matched token "${hit}" of ${JSON.stringify(tokens)} (label: "${want.reason_class_raw}")`,
        `no token matched = the record is still rejected but by a DIFFERENT gate than the fixture pins. That is a silent predicate swap: the corpus would keep reporting this sub-clause as covered while the clause it names goes unexercised (README: compare structurally on verdict + reason-class)`,
      );
    }
  }

  // Anti-collapse lock. Every rejection above is individually consistent with a
  // fold that refuses EVERYTHING for one shared reason. Requiring the reasons to
  // be pairwise distinct is what excludes that shape: if a refactor collapsed the
  // (a)-(g) chain into a single early guard, each row would still say
  // accepted=false and this row alone would red.
  check(
    `${label}: the ${reasons.size} rejections are produced by PAIRWISE DISTINCT gates`,
    new Set(reasons.values()).size === reasons.size,
    `${reasons.size} rejections, ${new Set(reasons.values()).size} distinct reasons`,
    "a collision = two fixtures pinning two different sub-clauses are being refused by the SAME gate, so at least one sub-clause is no longer reachable and the corpus over-reports its own coverage",
  );
}

// ---- T6: NEGATIVE CONTROLS — the synthetic world is load-bearing --------------
//
// Families C/D above are 17 rows against ONE roster. Two canonical passes are
// consistent with a fold that accepts any org-admin-shaped record; fifteen
// rejections are consistent with a fold that rejects everything. Each control
// below changes exactly ONE element of the world and requires the verdict to
// MOVE, so the instrument is shown to discriminate (instrument-discipline.md
// MUST-1 + MUST-3) rather than asserted to.
console.log("\n=== T6: negative controls — flip one element, require the verdict to move ===");
{
  const ghCanonical = loadRecord(GH_DIR, "n1-org-admin-canonical-pass");
  const adoCanonical = loadRecord(ADO_DIR, "ado-n1-org-admin-canonical-pass");

  // N1 — the N=1 precondition is real. A SECOND rostered owner means the 2-of-N
  // path is structurally available, and MUST-7 blocks routing around it.
  {
    const twoOwners = ghRoster();
    twoOwners.persons["pid-owner-f86-b"] = {
      display_id: "bob",
      role: "owner",
      github_login: "bob",
      host_role: "human",
      keys: [{ type: "ssh", fingerprint: "SHA256:SECOND-FP", pubkey: "ssh-ed25519 AAAA-STUB bob" }],
    };
    const v = foldGenesisMigration(ghCanonical, { foldState: null, roster: twoOwners });
    check(
      "N1: the canonical GitHub record + a SECOND rostered owner ⇒ REJECTED",
      v.accepted === false && /exactly one rostered owner/i.test(String(v.reason)),
      `accepted=${v.accepted} reason="${String(v.reason).slice(0, 110)}"`,
      "acceptance = the owner-count gate is gone and the N=1 substitution anchor can be used on a repo where a genuine 2-of-N quorum was available — the sock-puppet bypass. This is also what proves T4's canonical PASS is a property of the roster and not of a fold that accepts every org-admin-shaped record",
    );
  }

  // N2 — the identity binding is real. Same record, same single owner, only the
  // owner's bound github_login moves.
  {
    const wrongLogin = ghRoster();
    wrongLogin.persons["pid-owner-f86"].github_login = "someone-else";
    const v = foldGenesisMigration(ghCanonical, { foldState: null, roster: wrongLogin });
    check(
      "N2: the canonical GitHub record + a DIFFERENT bound github_login ⇒ REJECTED",
      v.accepted === false && /github_login/i.test(String(v.reason)),
      `accepted=${v.accepted} reason="${String(v.reason).slice(0, 110)}"`,
      "acceptance = MUST-7 (g) no longer binds the org-admin attestation to a specific GitHub identity, so an attestation captured for ANY org admin would anchor ANY owner's migration",
    );
  }

  // N3 — the ADO branch binds on `principal`, not on github_login. Confirms the
  // ADO rows are exercising the ADO branch rather than falling into the GitHub one.
  {
    const wrongPrincipal = adoRoster();
    wrongPrincipal.persons["pid-owner-ado-f122"].principal = "someone-else@contoso.com";
    const v = foldGenesisMigration(adoCanonical, { foldState: null, roster: wrongPrincipal });
    check(
      "N3: the canonical ADO record + a DIFFERENT bound principal ⇒ REJECTED",
      v.accepted === false && /principal/i.test(String(v.reason)),
      `accepted=${v.accepted} reason="${String(v.reason).slice(0, 110)}"`,
      "acceptance = MUST-7 ADO (g) no longer binds the PCA attestation to the migrating owner's Entra UPN; combined with N2 this row is also what shows the two fixture sets take DIFFERENT code paths rather than both landing in the GitHub branch",
    );
  }

  // N4 — the key-enrollment gate is real. Same roster, same record, only the
  // fingerprint the owner holds moves.
  {
    const wrongKey = ghRoster();
    wrongKey.persons["pid-owner-f86"].keys = [
      { type: "ssh", fingerprint: "SHA256:NOT-THE-SIGNER", pubkey: "ssh-ed25519 AAAA-STUB other" },
    ];
    const v = foldGenesisMigration(ghCanonical, { foldState: null, roster: wrongKey });
    check(
      "N4: the canonical GitHub record + signer key NOT enrolled under the owner ⇒ REJECTED",
      v.accepted === false && /not enrolled/i.test(String(v.reason)),
      `accepted=${v.accepted} reason="${String(v.reason).slice(0, 110)}"`,
      "acceptance = MUST-7 (f) no longer requires the primary signer to be the sole owner's enrolled key, so any key at all could emit a migration that folds clean",
    );
  }

  // N5 — family A's blocks are attributable to the OPT-IN GATE, not to a guard
  // that taxes every repo. The same watched fixture on a fresh un-enrolled repo
  // must NOT hard-block (README § the F72 fresh-substrate-adopter branch).
  {
    const freshFx = mkRepo("fresh", { enrolled: false });
    const payload = JSON.parse(
      fs.readFileSync(path.join(HERE, "pretooluse-bash-git-commit.json"), "utf8"),
    );
    payload.cwd = freshFx.repoDir;
    const r = driveGuard(freshFx, payload);
    check(
      "N5: the SAME watched fixture on a fresh un-enrolled repo ⇒ NOT hard-blocked",
      r.code === 0 && r.json?.continue === true,
      `exit=${r.code} continue=${r.json?.continue} tag=${r.tag}`,
      "a block here = a never-enrolled consumer that merely received the substrate hooks cannot land its first commit — and it would mean T2's blocks are produced by the watched-tool predicate ALONE, carrying no information about the trust-root verification they are cited for",
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
