/**
 * FS SANDBOX — the protected set is read-only to anything a Bash command runs.
 *
 * WHY THIS EXISTS: the parse-based guard decides where a shell write lands by
 * READING the command text, and shell has unbounded ways to hide a target
 * (CDPATH relocation, IFS set by printf -v/read/mapfile/getopts/eval/let/((..)),
 * eval/sh -c after a failed cd). Every review round found new forms. The OS does
 * not read the command: it refuses the write syscall itself. This suite pins
 * that the repo's `.claude/settings.json` sandbox block makes the protected set
 * unwritable under the REAL macOS mechanism (Seatbelt, `sandbox-exec`), however
 * the command spells its target.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT:
 *   PROVES  (a) settings.json declares the sandbox ON, fail-closed, with the
 *           escape hatch off, and lists every protected path in
 *           `sandbox.filesystem.denyWrite` (the Bash lane). The file-tool lane
 *           is NOT added to `permissions.deny` here: that array must equal the
 *           canonical floor (settings-deny-canon-parity.test.mjs, which also
 *           records "settings.json is NOT self-denied"), and widening the floor
 *           is a separate decision. File tools carry a literal file_path, so
 *           they never had the target-hiding problem this slice removes;
 *           (b) the ONE Seatbelt generator (os-profile/seatbelt.mjs, S1) fed the
 *           CLI-neutral policy refuses every attack row in
 *           fs-sandbox-attack-library.json under `sandbox-exec -f` (protected
 *           bytes unchanged), while the benign twins (git commit, a workspaces/
 *           write) still succeed — no CLI involved;
 *           (c) the same rows run WITHOUT the profile DO change the protected
 *           bytes — so (b)'s "unchanged" can discriminate;
 *           (d) dropping one policy row re-opens its path — so (b) reads the
 *           policy rather than passing on its own;
 *           (e) DROP-ONE SWEEP, DERIVED from the policy (round-1 M5): EVERY
 *           protected id, whatever its anchor, is refused under the full profile
 *           and re-opened by dropping exactly that id. It sits BESIDE the
 *           independent lists above, never instead: the lists catch the policy
 *           losing a row, the sweep catches a row the profile does not render.
 *   DOES NOT PROVE that Claude Code compiles settings.json into an equivalent
 *           profile; the live-session probe in 55f69a52c's commit body is the
 *           evidence for that link. Linux (bubblewrap) is S2's test.
 *
 * Run: node --test .claude/hooks/lib/guard-foundation/tests/fs-sandbox-protected-set.test.js
 */

"use strict";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..", "..", "..", "..");
// Fixture git goes through the shared helper: absolute binary + constants-built env.
const { resolveGitBinary, gitEnv } = require("../../git-subprocess-env.js");
const SETTINGS = JSON.parse(fs.readFileSync(path.join(REPO, ".claude", "settings.json"), "utf8"));
const LIBRARY = JSON.parse(fs.readFileSync(path.join(__dirname, "fs-sandbox-attack-library.json"), "utf8"));

// The protected set, stated independently of settings.json so a dropped entry
// there reds here rather than silently shrinking both sides.
const PROTECTED = [
  ".claude/hooks",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/learning/posture.json",
  ".claude/learning/coordination-log.jsonl",
  ".claude/learning/violations.jsonl",
  ".claude/operators.roster.json",
  ".git/hooks",
  ".git/config",
];
// Code that runs OUTSIDE the sandbox (trusted-writer entries through the broker,
// and the scripts the git hooks run). Writable code here would be a way out.
const EXCLUDED_CLOSURE = [
  ".claude/bin/land-lane.mjs",
  ".claude/bin/lib/entry-point.mjs",
  ".claude/bin/lib/landing-window.mjs",
  "scripts/ci/commit-msg-direct-stamp.mjs",
  "scripts/ci/dev-push-guard.mjs",
];
const WATCHED = [...PROTECTED, ...EXCLUDED_CLOSURE];

const DARWIN_SKIP =
  process.platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec")
    ? "Seatbelt (sandbox-exec) is macOS-only; this host cannot exercise the OS mechanism"
    : false;

function denyWriteList() {
  return SETTINGS.sandbox.filesystem.denyWrite;
}

// The policy loader and the S1 generator are ES modules.
let POLICY;
let SEATBELT;
before(async () => {
  POLICY = (await import(path.join(__dirname, "..", "policy", "policy.mjs"))).loadPolicy();
  SEATBELT = await import(path.join(__dirname, "..", "os-profile", "seatbelt.mjs"));
});

function git(cwd, args, home) {
  const r = spawnSync(resolveGitBinary(), ["-c", "commit.gpgsign=false", ...args], { cwd, env: { ...gitEnv(), HOME: home }, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
}

// A scratch repo holding every watched path, a scratch HOME and a scratch TMP,
// all realpath'd because Seatbelt matches the resolved path (/var -> /private/var).
function scratch() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fssbx-")));
  const root = path.join(base, "repo");
  const home = path.join(base, "home");
  const tmp = path.join(base, "tmp");
  const cfg = path.join(base, "cfg");
  const vault = path.join(base, "vault");
  for (const d of [root, home, tmp, cfg, vault]) fs.mkdirSync(d, { recursive: true });
  // The home's ~/.gnupg exists, as on an operator's machine, so the gnupg rows exercise the
  // option-file denials rather than the creation of their parent directory.
  fs.mkdirSync(path.join(home, ".gnupg"), { mode: 0o700 });
  git(root, ["init", "-q", "-b", "main"], home);
  git(root, ["config", "user.name", "fssbx"], home);
  git(root, ["config", "user.email", "fssbx@example.invalid"], home);
  const files = {
    ".claude/hooks/dispatch.js": "// guard\n",
    ".claude/settings.json": "{}\n",
    ".claude/settings.local.json": "{}\n",
    ".claude/learning/posture.json": "{}\n",
    ".claude/learning/coordination-log.jsonl": "",
    ".claude/learning/violations.jsonl": "",
    ".claude/operators.roster.json": "[]\n",
    "workspaces/.keep": "",
  };
  for (const rel of EXCLUDED_CLOSURE) files[rel] = "// code\n";
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  git(root, ["add", "-A"], home);
  git(root, ["commit", "-q", "-m", "init"], home);
  return { base, root, home, tmp, cfg, vault };
}

function digestTree(abs) {
  if (!fs.existsSync(abs)) return "absent";
  const st = fs.lstatSync(abs);
  if (!st.isDirectory()) return crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  const out = [];
  for (const name of fs.readdirSync(abs).sort()) out.push(`${name}=${digestTree(path.join(abs, name))}`);
  return `dir[${out.join(",")}]`;
}

function snapshot(s) {
  const snap = {};
  for (const rel of WATCHED) snap[rel] = digestTree(path.join(s.root, rel));
  snap["{HOME}"] = digestTree(s.home);
  return snap;
}

// The profile mirrors Claude Code's documented boundary: writes allowed only in
// the working directory and a per-user temp directory, minus denyWrite. Entries
// resolve as the docs define for project settings: "./x" or "x" -> <root>/x.
// The profile comes from the ONE Seatbelt generator, fed the policy and the
// scratch anchors. config_dir and vault are not supplied here, so their rows are
// reported unanchored rather than silently dropped. Written to a file outside
// the scratch repo and applied with `sandbox-exec -f`, as a launcher applies it.
function profile(s, policy = POLICY) {
  const anchors = SEATBELT.resolveAnchors({ repoDir: s.root, homeDir: s.home, configDir: null });
  const { profile: sb } = SEATBELT.generateSeatbeltProfile({ policy, anchors, allowUnanchored: true });
  const file = path.join(s.base, `profile-${crypto.randomBytes(4).toString("hex")}.sb`);
  fs.writeFileSync(file, sb);
  return file;
}

function run(s, row, sbFile) {
  const cmd = row.command.replaceAll("{ROOT}", s.root).replaceAll("{HOME}", s.home);
  const env = { PATH: process.env.PATH, HOME: s.home, TMPDIR: s.tmp, GIT_CONFIG_NOSYSTEM: "1" };
  const argv = sbFile ? ["/usr/bin/sandbox-exec", ["-f", sbFile, "/bin/bash", "-c", cmd]] : ["/bin/bash", ["-c", cmd]];
  return spawnSync(argv[0], argv[1], { cwd: s.root, env, encoding: "utf8", timeout: 20000 });
}

function withoutRow(id) {
  return { ...POLICY, protected_write: POLICY.protected_write.filter((r) => r.id !== id) };
}

function rows(expect) {
  return LIBRARY.rows.filter((r) => r.fs_sandbox_expect === expect);
}
// The HOME tool-config rows (the library's `home_rows`) run here, beside the repo rows: this suite's
// scratch HOME is seeded with .gnupg/ (scratch()).
const homeRows = (expect) => LIBRARY.home_rows.filter((r) => r.fs_sandbox_expect === expect);
const REFUSED = () => [...rows("refused"), ...homeRows("refused")];
const ALLOWED = () => [...rows("allowed"), ...homeRows("allowed")];

function cleanup(s) {
  fs.rmSync(s.base, { recursive: true, force: true });
}

test("settings.json turns the sandbox on, fail-closed, with the escape hatch off", () => {
  const sb = SETTINGS.sandbox;
  assert.equal(sb.enabled, true);
  assert.equal(sb.failIfUnavailable, true, "an unavailable sandbox must refuse to start, not run unsandboxed");
  assert.equal(sb.allowUnsandboxedCommands, false, "dangerouslyDisableSandbox must be ignored");
  assert.equal(sb.filesystem.disabled, undefined);
});

test("every protected path is in sandbox.filesystem.denyWrite", () => {
  const dw = new Set(denyWriteList());
  for (const rel of WATCHED) assert.ok(dw.has(`./${rel}`), `denyWrite lacks ./${rel}`);
});

test("no command is excluded from the sandbox, and no allowWrite reopens a protected path", () => {
  // An excluded command runs fully unsandboxed: `trestle run --local -- <anything>`
  // under a "trestle *" exclusion would write the protected set. Keep the list empty.
  assert.deepEqual(SETTINGS.sandbox.excludedCommands || [], []);
  for (const w of SETTINGS.sandbox.filesystem.allowWrite || []) {
    const norm = w.replace(/^\.\//, "");
    for (const rel of WATCHED) assert.ok(!(norm === rel || rel.startsWith(`${norm}/`) || norm.startsWith(`${rel}/`)), `allowWrite ${w} overlaps ${rel}`);
  }
});

test("attack library carries refused rows, benign twins and named out-of-scope rows", () => {
  assert.ok(rows("refused").length >= 25, `refused rows: ${rows("refused").length}`);
  assert.ok(rows("allowed").length >= 5);
  assert.ok(homeRows("refused").length >= 3 && homeRows("allowed").length >= 1, "the HOME tool-config rows are missing");
  for (const r of rows("out-of-scope")) assert.match(r.id, /update-ref|mainref/, `only ref rows may be out of scope: ${r.id}`);
});

// The guard-reference rows carry the `gf-` id prefix: 709785598 renamed ten of them from a
// disclosure-shaped prefix, deliberately NOT spelled here, and the three gnupg rows arrived as gf-
// in 79ca441b1. The only other hardcoded id
// sits in a darwin-gated case, so this host-independent case is what pins the rename: every id's
// leading segment is one the library is known to use, the prefix the `source` field names is
// `gf`, and each guard-reference id is present exactly once. A row reverted to any other prefix
// fails the allowlist AND drops out of the gf- set.
const ROW_ID_LEADS = ["BEN", "POS", "bashc", "cdpath", "eval", "gf", "git", "ifs", "plain", "shc"];
const GF_ROW_IDS = [
  "gf-append-coordination-log",
  "gf-append-land-lane",
  "gf-append-push-guard",
  "gf-cd-then-append-violations",
  "gf-git-config-local-hookspath",
  "gf-gnupg-create-versioned-conf",
  "gf-gnupg-rename-dir-away",
  "gf-gnupg-write-common-conf",
  "gf-mv-over-roster",
  "gf-node-fs-append-hook",
  "gf-printf-v-ifs-then-rm-settings-local",
  "gf-rm-hooks-dir",
  "gf-write-git-hook",
];

test("attack library row ids: the guard-reference rows carry the gf- prefix, and no unknown prefix exists", () => {
  const ids = [...LIBRARY.rows, ...LIBRARY.home_rows].map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "a row id is duplicated");
  for (const id of ids) assert.ok(ROW_ID_LEADS.includes(id.split("-")[0]), `row id ${id} has a prefix the library does not use`);
  const named = /rows prefixed ([A-Za-z0-9]+)- /.exec(LIBRARY.source);
  assert.ok(named, "the library's source field no longer names its row prefix");
  assert.equal(named[1], "gf");
  assert.deepEqual(ids.filter((id) => id.startsWith("gf-")).sort(), GF_ROW_IDS);
});

test("CONTROL: unsandboxed, every refused row really writes a protected path", { skip: DARWIN_SKIP }, () => {
  for (const row of REFUSED()) {
    const s = scratch();
    try {
      const before = snapshot(s);
      run(s, row, null);
      assert.notDeepEqual(snapshot(s), before, `${row.id}: no protected byte moved even WITHOUT the sandbox — the row is not an attack`);
    } finally {
      cleanup(s);
    }
  }
});

test("UNDER THE SANDBOX: every refused row leaves every protected byte unchanged", { skip: DARWIN_SKIP }, () => {
  for (const row of REFUSED()) {
    const s = scratch();
    try {
      const before = snapshot(s);
      const r = run(s, row, profile(s));
      assert.deepEqual(snapshot(s), before, `${row.id} changed a protected path under the sandbox\n${r.stdout}${r.stderr}`);
    } finally {
      cleanup(s);
    }
  }
});

test("UNDER THE SANDBOX: the benign twins still succeed (git commit, workspaces/ write)", { skip: DARWIN_SKIP }, () => {
  for (const row of ALLOWED()) {
    const s = scratch();
    try {
      const r = run(s, row, profile(s));
      assert.equal(r.status, 0, `${row.id} failed under the sandbox\n${r.stdout}${r.stderr}`);
    } finally {
      cleanup(s);
    }
  }
});

test("UNDER THE SANDBOX: refs stay writable by design (the out-of-scope rows are NOT covered)", { skip: DARWIN_SKIP }, () => {
  const s = scratch();
  try {
    const row = LIBRARY.rows.find((r) => r.id === "POS-write-mainref");
    run(s, row, profile(s));
    assert.equal(fs.readFileSync(path.join(s.root, ".git/refs/heads/main"), "utf8"), "x");
  } finally {
    cleanup(s);
  }
});

test("MUTATION: dropping one policy row re-opens exactly that path", { skip: DARWIN_SKIP }, () => {
  const cases = [
    ["hooks", "POS-append-hook-file"],
    ["git-config", "gf-git-config-local-hookspath"],
    ["settings", "POS-append-settings"],
    ["home-gnupg-versioned-option-files", "gf-gnupg-create-versioned-conf"],
  ];
  for (const [policyId, id] of cases) {
    const s = scratch();
    try {
      const row = [...LIBRARY.rows, ...LIBRARY.home_rows].find((r) => r.id === id);
      const before = snapshot(s);
      run(s, row, profile(s, withoutRow(policyId)));
      assert.notDeepEqual(snapshot(s), before, `${id} still refused with policy row ${policyId} removed — the profile is not built from the policy`);
    } finally {
      cleanup(s);
    }
  }
});

// ── (e) DROP-ONE SWEEP, derived from the policy (round-1 M5) ────────────────
// Every anchor is supplied (repo, home, config dir, vault), so no row is left
// unanchored. One write target per row: a probe file under a `dir/**` row, the
// file itself for an exact row. Each target must stay untouched under the full
// profile and be written once exactly that row is dropped.
function sweepTarget(s, row) {
  const base = { repo: s.root, home: s.home, config_dir: s.cfg, vault: s.vault }[row.anchor];
  if (!base) return null;
  if (row.path === "**") return path.join(base, "drop-one-probe");
  if (row.path.endsWith("/**")) return path.join(base, row.path.slice(0, -3), "drop-one-probe");
  return path.join(base, row.path);
}

// A row the generator ALSO renders from a sibling of the policy (MUST-5(b)): dropping the row alone
// leaves the sibling refusing, so the re-open needs the sibling's line dropped too.
// git-config-worktree: seatbelt.mjs renders a per-git-dir `config.worktree` literal for every
// checkout (R2a H-5) whatever the policy says.
const SIBLING_RENDERED = { "git-config-worktree": "; per-worktree git config" };

function sweepProfile(s, policy, dropSuffix = null) {
  const anchors = SEATBELT.resolveAnchors({ repoDir: s.root, homeDir: s.home, configDir: s.cfg, vaultDir: s.vault });
  let { profile: sb, unanchored } = SEATBELT.generateSeatbeltProfile({ policy, anchors });
  assert.deepEqual(unanchored, []);
  if (dropSuffix) {
    const kept = sb.split("\n").filter((l) => !l.endsWith(dropSuffix));
    assert.ok(kept.length < sb.split("\n").length, `no profile line ends with ${dropSuffix}`);
    sb = kept.join("\n");
  }
  const file = path.join(s.base, `sweep-${crypto.randomBytes(4).toString("hex")}.sb`);
  fs.writeFileSync(file, sb);
  return file;
}

function appendUnder(s, sbFile, target) {
  const env = { PATH: "/usr/bin:/bin", HOME: s.home, TMPDIR: s.tmp };
  return spawnSync("/usr/bin/sandbox-exec", ["-f", sbFile, "/bin/bash", "-c", 'printf drop-one >> "$1"', "_", target], { env, encoding: "utf8", timeout: 20000 });
}

test("DROP-ONE SWEEP: every protected id is refused under the full profile and re-opened by dropping exactly that id", { skip: DARWIN_SKIP }, () => {
  const s = scratch();
  try {
    const full = sweepProfile(s, POLICY);
    const swept = [];
    for (const row of POLICY.protected_write) {
      const target = sweepTarget(s, row);
      assert.ok(target, `${row.id}: anchor ${row.anchor} has no scratch base — the sweep cannot reach it`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const before = digestTree(target);
      const refused = appendUnder(s, full, target);
      assert.equal(digestTree(target), before, `${row.id}: ${row.anchor}:${row.path} was written under the FULL profile\n${refused.stderr}`);
      const sibling = SIBLING_RENDERED[row.id];
      if (sibling) {
        appendUnder(s, sweepProfile(s, withoutRow(row.id)), target);
        assert.equal(digestTree(target), before, `${row.id}: re-opened by dropping the row alone — the sibling render (${sibling}) no longer refuses it`);
      }
      appendUnder(s, sweepProfile(s, withoutRow(row.id), sibling || null), target);
      assert.notEqual(digestTree(target), before, `${row.id}: still refused with only that row dropped${sibling ? " and its sibling render" : ""} — the profile does not render it from the policy`);
      swept.push(row.id);
    }
    assert.deepEqual(swept, POLICY.protected_write.map((r) => r.id), "the sweep skipped a protected id");
  } finally {
    cleanup(s);
  }
});
