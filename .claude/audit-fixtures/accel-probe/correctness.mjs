import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import Module from "node:module";

export async function correctnessFixtures(library) {
  const source = fs.readFileSync(library, "utf8");
  const load = (text) => {
    const instance = new Module(library);
    instance.filename = library;
    instance.paths = Module._nodeModulePaths(path.dirname(library));
    instance._compile(text + "\nmodule.exports.fixtureCommand = command;\n", library);
    return instance.exports;
  };
  const mutate = (from, to) => {
    assert.equal(source.split(from).length, 2, "correctness mutation target reached exactly once");
    return load(source.replace(from, to));
  };
  const saved = { PATH: process.env.PATH, LOOM_ECOSYSTEM_CONFIG: process.env.LOOM_ECOSYSTEM_CONFIG };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "accel-correctness-"));
  const bin = path.join(scratch, "bin");
  fs.mkdirSync(bin);
  const binary = (name, body) => fs.writeFileSync(path.join(bin, name),
    `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  try {
    process.env.PATH = bin;
    binary("csq", "process.exit(2);");
    const expected = (value) => assert.equal(value.outcome, "undetermined", "R1-C-MED-2 natural exit-2 outcome");
    const real = load(source);
    expected(await real.fixtureCommand("csq", ["api", "status", "--json"], scratch));
    const target = 'code === 2 || code === null ? "undetermined" : "unavailable"';
    const promoted = mutate(target, 'code === 2 ? "available" : code === null ? "undetermined" : "unavailable"');
    const natural = await promoted.fixtureCommand("csq", ["api", "status", "--json"], scratch);
    assert.equal(natural.outcome, "available", "natural mutation reached outcome before stdout parsing");
    assert.equal(natural.stdout, undefined, "natural exit-2 child supplied no extra stdout");
    assert.throws(() => expected(natural), /R1-C-MED-2 natural exit-2 outcome/);
    console.log("RED CONTROL R1-C-MED-2: natural exit-2 outcome (actual available, expected undetermined)");
    const log = path.join(scratch, "started");
    for (const [name, output] of [["csq", "{}"], ["ollama", "NAME ID SIZE MODIFIED\nfixture-model:latest abc 1GB now"], ["python3", ""]]) {
      binary(name, `const fs=require('node:fs');
        fs.appendFileSync(${JSON.stringify(log)},String(process.pid)+'\\n');
        function check(){
          if(fs.readFileSync(${JSON.stringify(log)},'utf8').split('\\n').filter(Boolean).length===3){
            console.log(${JSON.stringify(output)});process.exit(0);
          }else setTimeout(check,10);
        }check();`);
    }
    const config = path.join(scratch, "ecosystem.json");
    fs.writeFileSync(config, JSON.stringify({ schema_version: 1, ecosystem: { id: "concurrency" }, remote_links: {},
      rag: { reservoir_locator: "sqlite:///fixture.db", embedding: [{
        provider: "local", model_id: "fixture-model", dims: 1024, query_prefix_version: "v1",
      }] } }));
    process.env.LOOM_ECOSYSTEM_CONFIG = config;
    const run = async (subject, name) => {
      const project = path.join(scratch, name);
      fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
      fs.writeFileSync(log, "");
      const records = await subject.probeAll({ cwd: project, sessionId: name });
      const rows = fs.readFileSync(log, "utf8").trim().split("\n");
      assert.equal(new Set(rows).size, 3, "three distinct probe children reached the barrier");
      return records;
    };
    const concurrent = (records) => {
      for (const [kind, expected] of [["engine", real.LLM_FEATURE], ["csq", { outcome: "available", reason: "ok" }],
        ["ollama", { outcome: "available", reason: "model-installed" }]]) {
        const row = records.find((record) => record.kind === kind);
        assert.deepEqual({ outcome: row.outcome, reason: row.reason }, expected, `R1-C-MED-3 ${kind} barrier outcome and reason`);
      }
    };
    concurrent(await run(real, "parallel"));
    const targetAll = `await Promise.all([probeEngine(root, locator, deadline), probeOllama(root, tiers, deadline),
      probeBroker(root, deadline)])`;
    for (const [name, replacement] of [
      ["sequential", '[await probeEngine(root, locator, deadline), await probeOllama(root, tiers, deadline), await probeBroker(root, deadline)]'],
      ["engine-first", '[await probeEngine(root, locator, deadline), ...await Promise.all([probeOllama(root, tiers, deadline), probeBroker(root, deadline)])]'],
    ]) {
      const records = await run(mutate(targetAll, replacement), name);
      assert.equal(records.find((row) => row.kind === "engine").reason, "timeout", "mutation reached engine barrier timeout");
      assert.throws(() => concurrent(records), /R1-C-MED-3 engine barrier/);
      console.log(`RED CONTROL R1-C-MED-3 ${name}: engine timeout differs from imported LLM_FEATURE`);
    }
    return ["R1-C-MED-2-natural-exit-2-outcome-mutation-red", "R1-C-MED-3-sequential-barrier-mutation-red", "R1-C-MED-3-engine-first-barrier-mutation-red"];
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
