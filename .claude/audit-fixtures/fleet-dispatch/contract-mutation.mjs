import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { CONTRACT_CASES } from "./contract-cases.mjs";
import sandboxModules from "../_lib/sandbox-module-tree.cjs";
const { copyModuleTree, moduleClosureArgs, moduleClosureResult } = sandboxModules;

const here = path.dirname(fileURLToPath(import.meta.url));
const hooks = path.resolve(here, "../../hooks");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-contract-mutation-"));
process.once("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));
copyModuleTree(path.join(hooks, "lib"), path.join(scratch, "lib"));
const originals = new Map(CONTRACT_CASES.map(({ file }) => [file, fs.readFileSync(path.join(hooks, file), "utf8")]));
for (const [file, source] of originals) fs.writeFileSync(path.join(scratch, file), source);
const hashOf = (source) => createHash("sha256").update(source).digest("hex");
function runCandidate(name, mutated) {
  const result = spawnSync(process.execPath, moduleClosureArgs(scratch, [path.join(here, "run.mjs")]), {
    env: { ...process.env, FLEET_FIXTURE_GROUP: "contract", FLEET_FIXTURE_HOOKS: scratch },
    encoding: "utf8", timeout: 30000,
  });
  moduleClosureResult(scratch, result);
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  for (const { key, file } of CONTRACT_CASES) {
    const hash = hashOf(fs.readFileSync(path.join(scratch, file), "utf8"));
    if (!result.stdout?.includes("REACHED " + key + "-contract source_sha256=" + hash)) throw Error(name + ": " + file + " candidate bytes did not reach owning parser");
  }
  const expectedStatus = mutated ? 1 : 0;
  if (result.status !== expectedStatus) throw Error(name + ": expected status " + expectedStatus + ", received " + result.status);
  if (mutated && !result.stdout.includes("FAIL contract." + mutated.key + ".exactly-one-declaration — no @hook-contract block")) throw Error(name + ": named declaration assertion did not red");
  console.log("PASS mutation." + name + " child_status=" + result.status + (mutated ? " REACHED=" + hashOf(fs.readFileSync(path.join(scratch, mutated.file), "utf8")) : ""));
}
runCandidate("baseline", null);
for (const entry of CONTRACT_CASES) {
  const original = originals.get(entry.file);
  const reverted = original.replace(/\/\*\*\n \* @hook-contract\n[\s\S]*?\n \*\//, "");
  if (reverted === original) throw Error(entry.file + ": mutation did not remove a declaration");
  fs.writeFileSync(path.join(scratch, entry.file), reverted);
  runCandidate(entry.key + "-reverted", entry);
  fs.writeFileSync(path.join(scratch, entry.file), original);
  if (fs.readFileSync(path.join(scratch, entry.file), "utf8") !== original) throw Error(entry.file + ": candidate restoration did not conserve source bytes");
}
