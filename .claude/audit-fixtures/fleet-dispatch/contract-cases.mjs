import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const root = "<main-checkout>/.claude/learning/fleet/";
export const CONTRACT_CASES = [
  { key: "broker", file: "fleet-dispatch-broker.js", idempotent: false, writes: [root, root + "state.jsonl"] },
  { key: "roster", file: "fleet-roster-inject.js", idempotent: true,
    writes: [root, root + "roster-injected-<pid>-<started_at>.json"] },
  { key: "reporter", file: "fleet-workhorse-report.js", idempotent: false, writes: [
    root, root + "state.jsonl", root + "report-lock-<pid>-<started_at>/",
    root + "state-unknown-busy-overlap-<pid>-<started_at>",
    root + "state-unknown-delivered-<pid>-<started_at>", root + "state-unknown-busy-intent-<pid>-<started_at>-<uuid>",
  ] },
];

export async function runContractCases({ check, HOOKS }) {
  const { parseContractBlockFromText, validateContractBlock } = require(path.join(HOOKS, "lib/hook-registry-contract.js"));
  for (const { key, file, idempotent, writes } of CONTRACT_CASES) {
    const source = fs.readFileSync(path.join(HOOKS, file), "utf8");
    console.log("REACHED " + key + "-contract source_sha256=" + createHash("sha256").update(source).digest("hex"));
    const parsed = parseContractBlockFromText(source);
    check("contract." + key + ".exactly-one-declaration", parsed.ok && parsed.count === 1, parsed.error);
    check("contract." + key + ".schema-valid", parsed.ok && validateContractBlock(parsed.block, file).length === 0,
      parsed.ok ? validateContractBlock(parsed.block, file).join("; ") : parsed.error);
    const expected = {
      "write-target": (b) => JSON.stringify(b?.side_effects?.fs_writes) === JSON.stringify(writes),
      "no-network": (b) => b?.side_effects?.network === false,
      "spawn-inventory": (b) => JSON.stringify(b?.side_effects?.spawns) === JSON.stringify(["git", "csq"]),
      "state-idempotence": (b) => b?.idempotent === idempotent,
      "no-input-rewrite": (b) => b?.may_rewrite_input === false,
    };
    for (const [name, accepts] of Object.entries(expected)) check("contract." + key + "." + name, parsed.ok && accepts(parsed.block));
    const absent = source.replace(/\/\*\*\n \* @hook-contract\n[\s\S]*?\n \*\//, "");
    const missing = parseContractBlockFromText(absent);
    check("contract." + key + ".absence-countercontrol", absent !== source && !missing.ok && missing.count === 0 && missing.error === "no @hook-contract block");
    const mutations = {
      "write-target": (b) => { b.side_effects.fs_writes = []; },
      "no-network": (b) => { b.side_effects.network = true; },
      "spawn-inventory": (b) => { b.side_effects.spawns = []; },
      "state-idempotence": (b) => { b.idempotent = !idempotent; },
      "no-input-rewrite": (b) => { b.may_rewrite_input = true; },
    };
    for (const [name, mutate] of Object.entries(mutations)) {
      const block = { side_effects: { fs_writes: [...writes], network: false, spawns: ["git", "csq"] }, idempotent, may_rewrite_input: false };
      mutate(block);
      const candidate = parseContractBlockFromText("/**\n * @hook-contract\n" + JSON.stringify(block) + "\n */");
      check("contract." + key + "." + name + "-countercontrol", candidate.ok && validateContractBlock(candidate.block, file).length === 0 && !expected[name](candidate.block));
    }
  }
}
