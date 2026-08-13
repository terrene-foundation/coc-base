#!/usr/bin/env node
/**
 * Fixture runner for `.claude/bin/sync-preflight-local-mods.mjs`.
 *
 * Per `cc-artifacts.md` Rule 9 the runner contract is: assert expected vs actual
 * and exit non-zero on mismatch. Cases are inline (the sanctioned alternative to
 * per-case sidecars — see `.claude/audit-fixtures/codex-dispatcher/README.md`
 * § "Fixture layout"), because every case needs a CONSTRUCTED git repo, which a
 * static sidecar cannot carry.
 *
 * The load-bearing case class is DID-NOT-RUN → exit 1. A tool that returns 0
 * when it could not run is indistinguishable at the call site from one that ran
 * clean; cases 1–5 are what keep those two apart, and each is named for the
 * specific way the run can fail to happen.
 *
 *   node .claude/audit-fixtures/sync-preflight-local-mods/run.mjs
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(HERE, "../../bin/sync-preflight-local-mods.mjs");

const SYNC_SUBJECT = "chore(coc): sync-from-template";
const CONSUMER_SUBJECT = "fix: tighten the local auth rule";

function sh(cwd, cmd, args) {
  execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function mkrepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "syncpreflight-"));
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  sh(dir, "git", ["config", "user.email", "fixture@example.invalid"]);
  sh(dir, "git", ["config", "user.name", "fixture"]);
  sh(dir, "git", ["config", "commit.gpgsign", "false"]);
  return dir;
}

function write(root, rel, body) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

function commit(root, subject) {
  sh(root, "git", ["add", "-A"]);
  sh(root, "git", ["commit", "-q", "-m", subject]);
}

/** A consumer repo whose shared artifacts are entirely sync-authored. */
function baselineRepo() {
  const root = mkrepo();
  write(root, ".claude/rules/security.md", "# security\n");
  write(root, ".claude/agents/analyst.md", "# analyst\n");
  write(root, ".claude/skills/foo/SKILL.md", "# foo\n");
  commit(root, SYNC_SUBJECT);
  return root;
}

function runTool(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

const cases = [];
const add = (name, fn) => cases.push({ name, fn });

// ── DID-NOT-RUN class — every one of these MUST be 1, never 0 ────────────────

add("01-nonexistent-root-is-1-not-0", () => {
  const r = runTool(["--root", "/nonexistent/path/that/cannot/exist"]);
  return { pass: r.code === 1, got: r.code, want: 1 };
});

add("02-root-without-dot-claude-is-1", () => {
  const root = mkrepo();
  write(root, "README.md", "x\n");
  commit(root, "init");
  const r = runTool(["--root", root]);
  return { pass: r.code === 1, got: r.code, want: 1 };
});

add("03-not-a-git-repo-is-1", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "syncpreflight-nogit-"));
  fs.mkdirSync(path.join(dir, ".claude", "rules"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "rules", "a.md"), "x\n");
  const r = runTool(["--root", dir]);
  return { pass: r.code === 1, got: r.code, want: 1 };
});

add("04-unrecognized-flag-is-1", () => {
  const root = baselineRepo();
  const r = runTool(["--root", root, "--totally-bogus"]);
  return { pass: r.code === 1, got: r.code, want: 1 };
});

add("05-invalid-sync-subject-regex-is-1", () => {
  const root = baselineRepo();
  const r = runTool(["--root", root, "--sync-subject-re", "([unclosed"]);
  return { pass: r.code === 1, got: r.code, want: 1 };
});

add("05b-did-not-run-stderr-names-the-absence", () => {
  const r = runTool(["--root", "/nonexistent/path/that/cannot/exist"]);
  return {
    pass: r.code === 1 && /DID NOT RUN/.test(r.err) && /not a clean result/.test(r.err),
    got: `${r.code} :: ${r.err.split("\n")[0]}`,
    want: "1 :: message naming DID NOT RUN and 'not a clean result'",
  };
});

// ── RAN-CLEAN vs AT-RISK ────────────────────────────────────────────────────

add("06-all-sync-authored-is-0", () => {
  const root = baselineRepo();
  const r = runTool(["--root", root]);
  return { pass: r.code === 0, got: `${r.code} :: ${r.out.trim()}`, want: 0 };
});

add("07-consumer-authored-commit-is-2", () => {
  const root = baselineRepo();
  write(root, ".claude/rules/security.md", "# security\nlocal tightening\n");
  commit(root, CONSUMER_SUBJECT);
  const r = runTool(["--root", root]);
  return {
    pass: r.code === 2 && /rules\/security\.md/.test(r.out),
    got: `${r.code} :: ${r.out.trim()}`,
    want: "2 and security.md named",
  };
});

add("08-uncommitted-modification-is-2", () => {
  const root = baselineRepo();
  fs.appendFileSync(path.join(root, ".claude/rules/security.md"), "dirty\n");
  const r = runTool(["--root", root]);
  return {
    pass: r.code === 2 && /uncommitted/.test(r.out),
    got: `${r.code} :: ${r.out.trim()}`,
    want: "2 with an 'uncommitted' reason",
  };
});

// ── SCOPE — preserved subdirs and the stated coverage residual ───────────────

add("09-preserved-project-subdir-not-reported", () => {
  const root = baselineRepo();
  write(root, ".claude/rules/project/local.md", "# local\n");
  commit(root, CONSUMER_SUBJECT);
  const r = runTool(["--root", root]);
  return {
    pass: r.code === 0 && !/rules\/project/.test(r.out),
    got: `${r.code} :: ${r.out.trim()}`,
    want: "0, rules/project/ never reported (it is preserved, not at risk)",
  };
});

add("10-residual-unscanned-bin-is-not-reported", () => {
  // Asserts the RESIDUAL the tool's header and both command bodies state:
  // .claude/bin/ is NOT scanned. This case exists so the gap stays honest —
  // if the scanned set widens, this case reddens and the prose must be updated
  // in the same change.
  const root = baselineRepo();
  write(root, ".claude/bin/local-tool.mjs", "// consumer-authored\n");
  commit(root, CONSUMER_SUBJECT);
  const r = runTool(["--root", root]);
  return {
    pass: r.code === 0 && !/bin\/local-tool/.test(r.out),
    got: `${r.code} :: ${r.out.trim()}`,
    want: "0 — .claude/bin is outside the six scanned dirs (documented residual)",
  };
});

// ── OVERRIDE + OUTPUT SHAPE ─────────────────────────────────────────────────

add("11-sync-subject-re-override-reclassifies-to-0", () => {
  const root = mkrepo();
  write(root, ".claude/rules/security.md", "# security\n");
  commit(root, "template roll 2026-08-10");
  const bare = runTool(["--root", root]);
  const overridden = runTool([
    "--root",
    root,
    "--sync-subject-re",
    "^template roll",
  ]);
  return {
    pass: bare.code === 2 && overridden.code === 0,
    got: `default=${bare.code} overridden=${overridden.code}`,
    want: "default=2 overridden=0",
  };
});

add("12-json-report-carries-at-risk-and-scanned-count", () => {
  const root = baselineRepo();
  write(root, ".claude/rules/security.md", "# security\nlocal\n");
  commit(root, CONSUMER_SUBJECT);
  const r = runTool(["--root", root, "--json"]);
  let parsed = null;
  try {
    parsed = JSON.parse(r.out);
  } catch {
    /* fall through to a failing assertion */
  }
  return {
    pass:
      r.code === 2 &&
      parsed !== null &&
      parsed.scanned >= 3 &&
      parsed.at_risk.length === 1 &&
      parsed.at_risk[0].path.endsWith("rules/security.md") &&
      Array.isArray(parsed.scanned_dirs) &&
      parsed.scanned_dirs.length === 6,
    got: `${r.code} :: ${r.out.trim().slice(0, 200)}`,
    want: "2 with a parseable report naming 1 at-risk path and 6 scanned dirs",
  };
});

add("13-scanned-count-is-the-discriminating-line", () => {
  // A clean run and a did-not-run both produce "no findings"; only the
  // `Scanned: N` line distinguishes them. Assert it is present on the 0 path.
  const root = baselineRepo();
  const r = runTool(["--root", root]);
  return {
    pass: r.code === 0 && /^Scanned: [1-9]\d* files/m.test(r.out),
    got: `${r.code} :: ${r.out.trim()}`,
    want: "0 with a non-zero 'Scanned: N files' line",
  };
});

let failed = 0;
for (const c of cases) {
  let res;
  try {
    res = c.fn();
  } catch (e) {
    res = { pass: false, got: `threw: ${e.message}`, want: "no throw" };
  }
  if (res.pass) {
    process.stdout.write(`PASS ${c.name}\n`);
  } else {
    failed++;
    process.stdout.write(`FAIL ${c.name}\n  want: ${res.want}\n  got:  ${res.got}\n`);
  }
}
process.stdout.write(`\n${cases.length - failed}/${cases.length} passed\n`);
process.exit(failed === 0 ? 0 : 1);
