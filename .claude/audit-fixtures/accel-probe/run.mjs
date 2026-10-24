import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { checkGateImporters } from "./importer-check.mjs";
import { sessionStartGolden } from "./golden.mjs";
import { r1Fixtures } from "./r1.mjs";
import { correctnessFixtures } from "./correctness.mjs";
import { orphanFixtures } from "./orphan.mjs";
import { secLowFixtures } from "./sec-low.mjs";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const library = path.join(root, ".claude/hooks/lib/accel-probe.js");
const probe = require(library);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "accel-probe-"));
const log = path.join(scratch, "commands.jsonl");
const oldEnv = { PATH: process.env.PATH, LOOM_ECOSYSTEM_CONFIG: process.env.LOOM_ECOSYSTEM_CONFIG };
let passed = 0;
const pass = (name) => { passed++; console.log(`PASS ${name}`); };
function binary(name, body) {
  fs.writeFileSync(path.join(scratch, name), `#!${process.execPath}\nconst fs=require('node:fs');\nfs.appendFileSync(${JSON.stringify(log)},JSON.stringify({name:${JSON.stringify(name)},args:process.argv.slice(2)})+'\\n');\n${body}\n`, { mode: 0o700 });
}
function mutant(from, to) {
  const source = fs.readFileSync(library, "utf8");
  assert.equal(source.split(from).length, 2, "mutation target reached exactly once");
  const instance = new Module(library);
  instance.filename = library;
  instance.paths = Module._nodeModulePaths(path.dirname(library));
  instance._compile(source.replace(from, to), library);
  return instance.exports;
}
try {
  process.env.PATH = scratch;
  binary("csq", "process.exit(2);");
  const rejectsExit2 = (value) => {
    assert.equal(value.outcome, "undetermined", "exit-2-outcome");
    assert.equal(value.reason, "exit-2", "exit-2-reason");
    assert.equal(value.rung, "R0", "exit-2-rung");
  };
  rejectsExit2(await probe.probeBroker(scratch));
  assert.throws(() => rejectsExit2({ outcome: "undetermined", reason: "wrong", rung: "R0" }), /exit-2-reason/);
  pass("exit-2-undetermined-R0");
  const wrong = mutant(': { outcome: code === 2 || code === null ? "undetermined" : "unavailable", reason: code === null ? "crash" : `exit-${code}` }',
    ': { outcome: code === 2 ? "available" : "unavailable", reason: "mutated", stdout }');
  // The promoted exit-2 verdict must also survive status parsing to reach its rung.
  binary("csq", "console.log('{}');process.exit(2);");
  assert.throws(() => rejectsExit2({ outcome: "available", rung: "B1" }), /exit-2-outcome/);
  const mutation = await wrong.probeBroker(scratch);
  assert.equal(mutation.outcome, "available", "mutated mapping reached");
  assert.throws(() => rejectsExit2(mutation), /exit-2-outcome/);
  pass("exit-2-mutation-red");
  binary("csq", "setInterval(()=>{},1000);");
  const started = performance.now();
  const hung = await probe.probeBroker(scratch);
  assert.equal(hung.reason, "timeout");
  assert.equal(hung.outcome, "undetermined");
  assert.ok(performance.now() - started <= 1600, "1500ms probe deadline exceeded 1600ms");
  pass("hang-undetermined-under-1600ms");
  binary("csq", "console.log('not-json');");
  assert.equal((await probe.probeBroker(scratch)).reason, "unparseable");
  pass("unparseable-undetermined");
  binary("csq", "console.log('{}');");
  assert.equal((await probe.probeBroker(scratch)).rung, "B1");
  pass("broker-available");
  binary("python3", "process.exit(0);");
  assert.deepEqual(probe.LLM_FEATURE, { outcome: "undetermined", reason: "llm-feature-unobservable" });
  assert.equal((await probe.probeEngine(scratch, "sqlite:///test.db")).rung, "R0");
  assert.equal((await probe.probeEngine(scratch, null)).reason, "no-locator");
  pass("engine-feature-unobservable-R0");
  // Real `ollama list` NAMEs always carry a tag, so the fake list does too.
  binary("ollama", "console.log('NAME ID SIZE MODIFIED\\nembedding-model:latest abc 1GB now\\npinned-model:q4 def 1GB now');");
  const ollamaRung = async (subject, model) => (await subject.probeOllama(scratch, [{ provider: "local", model_id: model }])).rung;
  assert.equal(await ollamaRung(probe, "embedding-model"), "E1", "untagged id reads as :latest");
  assert.equal(await ollamaRung(probe, "embedding-model:latest"), "E1", "explicit :latest");
  assert.equal(await ollamaRung(probe, "pinned-model:q4"), "E1", "exact non-latest tag");
  assert.equal(await ollamaRung(probe, "pinned-model"), "R0", "untagged id must not match a non-latest tag");
  assert.equal(await ollamaRung(probe, "embedding-model:q4"), "R0", "a different tag must not match");
  assert.equal((await probe.probeOllama(scratch, [{ provider: "local", model_id: "missing" }])).outcome, "unavailable");
  pass("ollama-installed-list-only");
  const exact = mutant("installed.includes(ollamaTag(model))", "installed.includes(model)");
  assert.equal(await ollamaRung(exact, "embedding-model:latest"), "E1", "tag mutation reached a matching path");
  assert.equal(await ollamaRung(exact, "pinned-model"), "R0");
  assert.equal(await ollamaRung(exact, "embedding-model"), "R0", "exact-name mutation reds the untagged id");
  pass("ollama-untagged-latest-mutation-red");
  const project = path.join(scratch, "project");
  fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
  const config = path.join(scratch, "ecosystem.json");
  fs.writeFileSync(config, JSON.stringify({ schema_version: 1, ecosystem: { id: "probe-test" }, remote_links: {} }));
  process.env.LOOM_ECOSYSTEM_CONFIG = config;
  const first = await probe.probeAll({ cwd: project, sessionId: "session" });
  const before = fs.readFileSync(log, "utf8");
  assert.deepEqual(await probe.probeAll({ cwd: project, sessionId: "session" }), first);
  assert.equal(fs.readFileSync(log, "utf8"), before);
  const records = fs.readdirSync(path.join(project, ".claude/learning/accel"));
  assert.equal(records.length, 1);
  assert.equal(fs.readFileSync(path.join(project, ".claude/learning/accel", records[0]), "utf8").trim().split("\n").length, 1);
  pass("session-cache-one-jsonl-record");
  const gate = ".claude/bin/scan-synced-disclosure.mjs";
  assert.deepEqual(checkGateImporters(root), []);
  const changed = fs.readFileSync(path.join(root, gate), "utf8") + '\nimport "../hooks/lib/accel-probe.js";\n';
  assert.ok(checkGateImporters(root, { [gate]: changed }).some((finding) => finding.code === "gate-accel-import" && finding.file === gate));
  pass("gate-import-green-and-red-poles");
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  for (const call of calls) {
    if (call.name === "csq") assert.deepEqual(call.args, ["api", "status", "--json"]);
    if (call.name === "ollama") assert.deepEqual(call.args, ["list"]);
    if (call.name === "python3") assert.deepEqual(call.args, ["-I", "-c", "import kailash.distill as d; d.GovernedDistiller"]);
  }
  pass("no-credit-no-model-loading-commands");
  console.log(`accel-probe fixtures: ${passed}/${passed} passed`);
} finally {
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
for (const name of sessionStartGolden(root)) pass(name);
for (const name of await r1Fixtures(library)) pass(name);
for (const name of await correctnessFixtures(library)) pass(name);
for (const name of await orphanFixtures(root)) pass(name);
for (const name of await secLowFixtures(library)) pass(name);
console.log(`accel-probe fixtures: ${passed}/${passed} passed`);
