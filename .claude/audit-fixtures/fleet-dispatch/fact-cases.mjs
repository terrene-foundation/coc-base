import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

export async function runFactCases(ctx) {
  const { check, scaffold, lib, HOOKS, WH, WH_TARGET, REG_ONE, IDLE_ROW, BUSY_ROW } = ctx;
  const rootOf = (fx) => path.join(fx.stateDir, "fleet");
  const todo = "workspaces/ws/todos/active/item.md";
  const lane = "lw2d-lane";
  for (const [name, text, expected] of [
    ["quoted", `---\nlane: "${lane}"\n---\nbody\n`, 1],
    ["single-quoted", `---\nlane: '${lane}'\n---\n`, 1],
    ["comment", `---\nlane: ${lane} # bound\n---\n`, 1],
    ["body-is-unbound", `body\nlane: ${lane}\n`, 0],
    ["duplicate-is-unknown", `---\nlane: ${lane}\nlane: other\n---\n`, null],
    ["truncated-is-unknown", `---\nlane: ${lane}\n${"x".repeat(20000)}`, null],
    ["malformed-is-unknown", "---\nlane: [bad]\n---\n", null],
  ]) {
    const fx = scaffold({ laneFiles: { [todo]: text } });
    const got = lib.countBoundItems(fx.repoDir, lane);
    check(`facts.F2.${name}`, got === expected, `got=${got} expected=${expected}`);
  }
  {
    const fx = scaffold();
    check("facts.F1.absent-workspaces-known-empty", lib.countBoundItems(fx.repoDir, lane) === 0);
    const active = path.join(fx.repoDir, "workspaces/ws/todos/active");
    fs.mkdirSync(path.dirname(active), { recursive: true });
    fs.writeFileSync(active, "not a directory\n");
    check("facts.F1.nonabsence-readdir-unknown", lib.countBoundItems(fx.repoDir, lane) === null);
  }
  {
    const fx = scaffold();
    fs.mkdirSync(path.join(fx.repoDir, todo), { recursive: true });
    check("facts.F1.unreadable-todo-unknown", lib.countBoundItems(fx.repoDir, lane) === null);
  }
  {
    const fx = scaffold({ laneFiles: {
      [todo]: `---\nlane: ${lane}\n---\n`,
      "workspaces/_archive/todos/active/archived.md": `---\nlane: ${lane}\n---\n`,
      "workspaces/instructions/todos/active/instructions.md": `---\nlane: ${lane}\n---\n`,
    } });
    check("facts.F2.meta-workspaces-excluded", lib.countBoundItems(fx.repoDir, lane) === 1);
  }
  for (const [name, suffix] of [
    ["corrupt-newer", '{"event":"busy",'],
    ["null-newer", "null"],
    ["array-newer", "[]"],
    ["scalar-newer", "7"],
    ["invalid-newer", JSON.stringify({ ...BUSY_ROW, queue: -1 })],
  ]) {
    const fx = scaffold({ stateRows: [IDLE_ROW] });
    fs.appendFileSync(path.join(rootOf(fx), "state.jsonl"), suffix + "\n");
    check(`facts.F3.${name}-unknown`, lib.readStateRows(rootOf(fx)) === null);
  }
  for (const queue of [3, null, undefined, -1, "0"]) {
    const row = { ...IDLE_ROW, queue };
    const folded = lib.foldState([IDLE_ROW, row], WH_TARGET);
    const idle = lib.idleWorkhorses([{ ...row, live: true, state: "idle" }]);
    check(`facts.F3.invalid-idle-queue-${String(queue)}`, folded.state === "unknown" && Array.isArray(idle) && idle.length === 0);
  }
  {
    const fx = scaffold({ stateRows: [BUSY_ROW, IDLE_ROW], registry: REG_ONE });
    const rows = lib.readStateRows(rootOf(fx));
    const roster = lib.joinRoster([WH], REG_ONE.workhorses, rows);
    check("facts.F3.valid-idle-stays-eligible", Array.isArray(roster) && lib.idleWorkhorses(roster).length === 1);
    check("facts.F3.invalid-fold-does-not-skip", lib.foldState([IDLE_ROW, { bogus: true }], WH_TARGET).state === "unknown");
  }
  for (const [name, workhorses] of [
    ["null-row", [null]],
    ["nonobject-row", [7]],
    ["invalid-target", [{ ...REG_ONE.workhorses[0], target: "--all" }]],
    ["invalid-orchestrator", [{ ...REG_ONE.workhorses[0], orchestrator_target: "--all" }]],
    ["duplicate-target", [REG_ONE.workhorses[0], REG_ONE.workhorses[0]]],
  ]) {
    const fx = scaffold({ registry: { schema_version: 1, workhorses } });
    check(`facts.S1.registry-${name}-unknown`, lib.readRegistry(rootOf(fx)) === null);
  }
  for (const [name, sessions, workhorses] of [
    ["null-session", [null], REG_ONE.workhorses],
    ["null-workhorse", [WH], [null]],
    ["invalid-session-target", [{ ...WH, pid: "--all" }], REG_ONE.workhorses],
  ]) {
    let got;
    try { got = lib.joinRoster(sessions, workhorses, [IDLE_ROW]); }
    catch (error) { got = `THREW ${error.name}`; }
    check(`facts.S7.${name}-unknown-without-throw`, got === null, String(got));
  }
  {
    const fx = scaffold({ registry: REG_ONE });
    check("facts.S1.valid-registry-known", lib.readRegistry(rootOf(fx))?.workhorses.length === 1);
    let refused = false;
    try { lib.writeRegistry(rootOf(fx), { schema_version: 1, workhorses: [null] }); }
    catch (error) { refused = error instanceof TypeError; }
    check("facts.S1.registry-writer-refuses-invalid", refused && lib.readRegistry(rootOf(fx))?.workhorses.length === 1);
  }
  {
    const fx = scaffold({ stateRows: [IDLE_ROW] });
    const root = rootOf(fx);
    const open = fs.openSync;
    let reached = false;
    let result;
    try {
      fs.openSync = (file, ...args) => {
        if (file === path.join(root, "state.jsonl")) {
          reached = true;
          throw Object.assign(new Error("controlled append failure"), { code: "EIO" });
        }
        return open(file, ...args);
      };
      result = lib.appendStateRow(root, BUSY_ROW);
    } finally { fs.openSync = open; }
    const child = spawnSync(process.execPath, ["-e", "const m=require(process.argv[1]); const rows=m.readStateRows(process.argv[2]); process.stdout.write(JSON.stringify({rows,state:m.foldState(rows,process.argv[3]).state}));", path.join(HOOKS, "lib/fleet-dispatch.js"), root, WH_TARGET], { encoding: "utf8" });
    let observed; try { observed = JSON.parse(child.stdout); } catch { observed = null; }
    check("facts.F4.failed-busy-explicit-result", reached && result?.ok === false && result.invalidated === true);
    check("facts.F4.failed-busy-invalidates-other-process", child.status === 0 && Array.isArray(observed?.rows) && observed.state === "unknown", `rc=${child.status} out=${child.stdout}`);
    check("facts.F4.failed-busy-preserves-original-bytes", fs.readFileSync(path.join(root, "state.jsonl"), "utf8") === JSON.stringify(IDLE_ROW) + "\n");
  }
  {
    const fx = scaffold({ stateRows: [IDLE_ROW] });
    const root = rootOf(fx);
    const result = lib.appendStateRow(root, BUSY_ROW);
    check("facts.F4.successful-busy-known", result?.ok === true && lib.foldState(lib.readStateRows(root), WH_TARGET).state === "busy");
    const blocked = path.join(root, "blocked-root");
    fs.writeFileSync(blocked, "not a directory\n");
    check("facts.B3.failed-append-explicit-result", lib.appendStateRow(blocked, { event: "dispatch-override", target: null, reason_sha256: "a".repeat(64) })?.ok === false);
  }
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-linked-cwd-"));
    const primary = path.join(dir, "primary"), linked = path.join(dir, "linked");
    const sourceRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const binding = createRequire(import.meta.url)(path.join(sourceRepo, ".claude/hooks/lib/git-subprocess-env.js"));
    const git = binding.resolveGitBinary();
    const logs = [];
    let passed = false, detail;
    const run = (name, exe, args, opts = {}) => {
      const stdoutPath = path.join(dir, name + ".stdout"), stderrPath = path.join(dir, name + ".stderr");
      const out = fs.openSync(stdoutPath, "wx"), err = fs.openSync(stderrPath, "wx");
      let result;
      try { result = spawnSync(exe, args, { cwd: dir, env: binding.gitEnv(), timeout: 30000, ...opts, stdio: ["ignore", out, err] }); }
      finally { fs.closeSync(out); fs.closeSync(err); }
      const stdout = fs.readFileSync(stdoutPath, "utf8"), stderr = fs.readFileSync(stderrPath, "utf8");
      logs.push({ name, exe, args, status: result.status, signal: result.signal, error: result.error?.message || null, stdoutPath, stderrPath });
      return { ...result, stdout, stderr };
    };
    try {
      const cloned = run("clone", git, ["clone", "--shared", "--no-checkout", "--", sourceRepo, primary]);
      if (cloned.status !== 0) throw new Error("clone did not run: " + cloned.stderr);
      const added = run("linked", git, ["-C", primary, "worktree", "add", "--detach", "--no-checkout", "--", linked, "HEAD"]);
      if (added.status !== 0) throw new Error("linked worktree did not run: " + added.stderr);
      const top = run("top", git, ["-C", linked, "rev-parse", "--show-toplevel"]);
      const common = run("common", git, ["-C", linked, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
      if (top.status !== 0 || common.status !== 0 || fs.realpathSync(top.stdout.trim()) !== fs.realpathSync(linked) ||
          fs.realpathSync(common.stdout.trim()) !== fs.realpathSync(path.join(primary, ".git"))) throw new Error("fixture is not the requested real linked worktree");
      const env = { ...process.env };
      delete env.CLAUDE_TRUST_STATE_DIR;
      delete env.CLAUDE_PROJECT_DIR;
      const childSource = [
        'const fs=require("node:fs"),path=require("node:path");',
        'const lib=require(process.argv[1]);',
        'const resolved=lib.stateRoot();',
        'const expected=path.join(fs.realpathSync(process.argv[2]),".claude","learning","fleet");',
        'const separate=resolved!==null&&resolved===expected&&path.relative(process.cwd(),resolved).startsWith("..");',
        'const result=separate?lib.appendStateRow(resolved,{event:"busy",target:"11:22",name:"fixture",queue:1,last:null}):null;',
        'const rows=resolved?lib.readStateRows(resolved):null;',
        'process.stdout.write(JSON.stringify({cwd:process.cwd(),resolved,expected,separate,result,rows}));',
      ].join("\n");
      const child = run("append", process.execPath, ["-e", childSource, path.join(HOOKS, "lib/fleet-dispatch.js"), primary], { cwd: linked, env });
      const observed = child.status === 0 ? JSON.parse(child.stdout) : null;
      passed = child.status === 0 && observed?.separate === true && observed.result?.ok === true &&
        Array.isArray(observed.rows) && observed.rows.length === 1 && lib.foldState(observed.rows, "11:22").state === "busy";
      detail = JSON.stringify({ dir, observed, childStatus: child.status, childStderr: child.stderr });
    } catch (error) { detail = String(error.stack || error); }
    process.stdout.write("FLEET_WORKTREE_BOUNDARY_FIXTURE " + JSON.stringify({ dir, primary, linked, logs }) + "\n");
    check("facts.B4.linked-worktree-resolved-root-append-success", passed, detail);
  }
}
