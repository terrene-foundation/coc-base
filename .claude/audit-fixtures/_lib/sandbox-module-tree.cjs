"use strict";
require("./no-ambient-git.cjs");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveGitBinary, gitEnv } = require("../../hooks/lib/git-subprocess-env.js");

function within(root, file) {
  const rel = path.relative(fs.realpathSync(root), fs.realpathSync(file));
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}
function trackedCopyFilter(source) {
  const physical = fs.realpathSync(source), git = resolveGitBinary();
  if (!git) throw Error("EP7_COPY_GIT_UNAVAILABLE");
  const probe = (args, cwd = physical) => spawnSync(git, ["-C", cwd, ...args], { env: gitEnv(), encoding: "utf8", timeout: 5000 });
  const top = probe(["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) {
    for (let p = physical;; p = path.dirname(p)) {
      if (fs.existsSync(path.join(p, ".git"))) throw Error("EP7_COPY_GIT_UNRESOLVED:" + physical);
      if (p === path.dirname(p)) break;
    }
    return () => true;
  }
  const root = fs.realpathSync(top.stdout.trim()), rel = path.relative(root, physical);
  const listed = probe(["ls-files", "-z", "--cached", "--full-name", "--", rel || "."], root);
  if (listed.status !== 0) throw Error("EP7_COPY_TRACKED_UNRESOLVED:" + physical);
  const allowed = new Set([physical]);
  for (const name of listed.stdout.split("\0").filter(Boolean)) {
    let file = path.join(root, name);
    try {
      if (!within(root, file)) throw Error("EP7_COPY_TRACKED_ESCAPE:" + name);
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    for (;;) {
      allowed.add(file);
      if (file === physical || file === path.dirname(file)) break;
      file = path.dirname(file);
    }
  }
  return file => allowed.has(fs.realpathSync(file));
}
function copyModuleTree(source, destination) {
  const filter = trackedCopyFilter(source);
  fs.cpSync(source, destination, { recursive: true, dereference: true, filter });
  assertPhysicalTree(destination);
  process.stdout.write("CONTROL EP7_PHYSICAL_COPY " + JSON.stringify({ source, destination, selection: "tracked-only when source is a repository" }) + "\n");
}
function assertPhysicalTree(root) {
  if (fs.lstatSync(root).isSymbolicLink()) throw Error("EP7_SANDBOX_LINK:" + root);
  for (const name of fs.readdirSync(root)) {
    const file = path.join(root, name), st = fs.lstatSync(file);
    if (st.isSymbolicLink() || !within(root, file)) throw Error("EP7_SANDBOX_LINK:" + file);
    if (st.isDirectory()) assertPhysicalTree(file);
  }
}
const traces = new Map();
process.once("exit", () => {
  for (const { dir } of traces.values()) fs.rmSync(dir, { recursive: true, force: true });
});
function moduleClosureArgs(root, args) {
  const canonical = fs.realpathSync(root);
  for (const rel of ["lib", ".claude/hooks", ".claude/bin"]) {
    const target = path.join(canonical, rel);
    if (fs.existsSync(target)) assertPhysicalTree(target);
  }
  if (!traces.has(canonical)) {
    const dir = fs.mkdtempSync(path.join(path.dirname(canonical), ".ep7-trace-"));
    const preload = path.join(dir, "closure.cjs"), receipt = path.join(dir, "receipt.jsonl");
    fs.writeFileSync(preload, "(" + traceModuleClosure.toString() + ")(" + JSON.stringify(canonical) + "," + JSON.stringify(receipt) + ");\n");
    traces.set(canonical, { dir, preload, receipt, offset: 0 });
  }
  return ["--require", traces.get(canonical).preload, ...args];
}
function traceModuleClosure(root, receipt) {
  const fs = require("node:fs"), path = require("node:path"), Module = require("node:module");
  const inside = file => {
    const rel = path.relative(root, fs.realpathSync(file));
    return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
  };
  const seen = new Set(), refused = new Set(), resolve = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, ...rest) {
    const resolved = resolve.call(this, request, parent, ...rest);
    if (parent?.filename && fs.existsSync(parent.filename) && inside(parent.filename) &&
        path.isAbsolute(resolved)) {
      if (!inside(resolved)) {
        refused.add(fs.realpathSync(resolved));
        fs.writeSync(2, "EP7_MODULE_ESCAPE_REACHED:" + resolved + "\n");
        throw Error("EP7_MODULE_ESCAPE:" + resolved);
      }
      seen.add(fs.realpathSync(resolved));
    }
    return resolved;
  };
  process.on("exit", () => fs.appendFileSync(receipt, JSON.stringify({
    root, scope: "CJS-only; ESM not traced", modules: [...seen].sort(), refused: [...refused].sort(),
  }) + "\n"));
}
function moduleClosureEnv(root, env) {
  const [, preload] = moduleClosureArgs(root, []);
  return { ...env, NODE_OPTIONS: [env.NODE_OPTIONS, "--require " + JSON.stringify(preload)].filter(Boolean).join(" ") };
}
function moduleClosureResult(root, result) {
  const canonical = fs.realpathSync(root), trace = traces.get(canonical);
  const text = trace && fs.existsSync(trace.receipt) ? fs.readFileSync(trace.receipt, "utf8").trim() : "";
  const rows = text ? text.split("\n") : [];
  const fresh = rows.slice(trace?.offset || 0);
  if (fresh.length === 0) throw Error("EP7_CLOSURE_RECEIPT_MISSING");
  for (const line of fresh) {
    const row = JSON.parse(line);
    if (row.root !== canonical || row.scope !== "CJS-only; ESM not traced" ||
        !Array.isArray(row.modules) || !Array.isArray(row.refused) ||
        !row.modules.every(file => within(canonical, file))) throw Error("EP7_CLOSURE_RECEIPT_INVALID");
    process.stdout.write("CONTROL EP7_MODULE_CLOSURE " + line + "\n");
    if (row.refused.length) throw Error("EP7_CLOSURE_REFUSED_ESCAPE:" + row.refused.join(","));
  }
  trace.offset = rows.length;
  return result;
}
function moduleClosureReceipt(root) {
  return traces.get(fs.realpathSync(root))?.receipt;
}
module.exports = { within, trackedCopyFilter, copyModuleTree, assertPhysicalTree, moduleClosureArgs, moduleClosureEnv, moduleClosureResult, moduleClosureReceipt };
