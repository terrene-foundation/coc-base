import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { requireSites } = require("../../hooks/lib/hook-registry-contract.js");

export const gateCallSites = [
  ".claude/bin/scan-synced-disclosure.mjs",
  ".claude/bin/land-lane.mjs",
  ".claude/hooks/posture-gate.js",
  ".claude/hooks/wip-discipline-guard.js",
];

export function checkGateImporters(root, replacements = {}) {
  const findings = [];
  const visited = new Set();
  function visit(relative) {
    if (visited.has(relative)) return;
    visited.add(relative);
    const source = replacements[relative] ?? fs.readFileSync(path.join(root, relative), "utf8");
    const parsed = requireSites(source, { cjs: /\.(js|cjs)$/.test(relative) });
    if (!parsed.ok) throw new Error(`importer-unparseable:${relative}`);
    for (const site of parsed.sites) {
      const spec = site.specifier || site.spec;
      if (typeof spec !== "string") continue;
      if (path.basename(spec).replace(/\.(js|cjs|mjs)$/, "") === "accel-probe") {
        findings.push({ code: "gate-accel-import", file: relative });
      } else if (spec.startsWith(".")) {
        const target = path.normalize(path.join(path.dirname(relative), spec));
        if (target.startsWith("..") || path.isAbsolute(target)) throw new Error("importer-outside-root");
        const candidate = [target, target + ".js", target + ".mjs", target + ".cjs"]
          .find((file) => fs.existsSync(path.join(root, file)) && fs.statSync(path.join(root, file)).isFile());
        if (candidate && /\.(js|mjs|cjs)$/.test(candidate)) visit(candidate);
      }
    }
  }
  const registry = JSON.parse(fs.readFileSync(path.join(root, ".claude/hook-registry.json"), "utf8"));
  const denyHooks = registry.hooks.filter((row) => row.on_incomplete !== "continue").map((row) => row.file);
  [...new Set([...gateCallSites, ...denyHooks])].forEach(visit);
  return findings;
}
