#!/usr/bin/env node
/**
 * Audit fixture — `check-manifest-registry-closure.mjs` and the derivation it reads.
 *
 * WHY THIS EXISTS. The check's job is to notice that a generated package has no bytes
 * for a file the hook runtime's registration surfaces invoke. That is exactly the class
 * of predicate whose failure mode is SILENCE: a check whose registry parse returns
 * nothing, or whose walk finds no loads, reports "nothing missing" over a package that
 * is missing everything — the same output as a genuinely complete one. So every
 * predicate below is cased in BOTH directions, and the RED pole of each pair is a
 * HAND-CONSTRUCTED mutation of a tree the control leg passes on. The RED verdict can
 * never be satisfied by construction.
 *
 * HOW IT DRIVES THE REAL INSTRUMENT. Each case spawns
 * `.claude/bin/check-manifest-registry-closure.mjs` as a subprocess against a synthetic
 * repo root in a temp directory, with the registry, settings and manifest passed by
 * argv. Nothing is re-implemented here: a case asserts on the rc the process returned
 * and on the finding CODE it printed, so a case goes red if the instrument stops
 * discriminating, not merely if the spelling of its output moves.
 *
 * WHAT IT DOES NOT COVER, named so its green is not over-read: the synthetic trees carry
 * a handful of stub files, so this suite says nothing about the SIZE of the real
 * closure — that is the integration leg at the end, and the preflight check, which run
 * the same instrument against the real tree.
 *
 * Exit 0 = every case held. Exit 1 = at least one did not.
 */

import "../_lib/no-ambient-git.cjs";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** This fixture lives at `<root>/.claude/audit-fixtures/<name>/`, so `..` twice is
 *  `.claude` and one more is the repo root the instrument's defaults resolve against. */
const DOT_CLAUDE = path.resolve(HERE, "..", "..");
const ROOT = path.resolve(DOT_CLAUDE, "..");
const CHECKER = path.join(DOT_CLAUDE, "bin", "check-manifest-registry-closure.mjs");
const MODULE = path.join(DOT_CLAUDE, "bin", "lib", "manifest-registry-closure.mjs");

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) {
    passed++;
    process.stdout.write(`  PASS  ${name}\n`);
  } else {
    failed++;
    process.stderr.write(`  FAIL  ${name}\n${detail ? `        ${detail}\n` : ""}`);
  }
};

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-registry-closure-"));

/**
 * Build a synthetic repo root. `files` maps a repo-relative path to its text; the
 * instrument's OWN modules are copied in, derived by asking the lexer for its own
 * closure rather than by listing them — so a new dependency of the lexer cannot
 * silently make every case fail to load.
 */
function makeTree(name, { registry, settings, files = {} }) {
  const root = path.join(scratch, name);
  const write = (rel, text) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };
  const instrumentFiles = [
    ".claude/bin/check-manifest-registry-closure.mjs",
    ".claude/bin/lib/manifest-registry-closure.mjs",
    ".claude/hooks/lib/hook-registry-contract.js",
  ];
  // The lexer's own dependencies, asked for rather than listed.
  const lexerClosure = spawnSync(
    process.execPath,
    [
      "-e",
      `const {createRequire}=require("node:module");const r=createRequire(process.argv[1]+"/x.js")("${path
        .join(DOT_CLAUDE, "hooks/lib/hook-registry-contract.js")
        .replace(/\\/g, "/")}");const c=r.localRequireClosure(process.argv[1],".claude/hooks/lib/hook-registry-contract.js");if(!c.ok){console.error(c.error);process.exit(1)}process.stdout.write(c.files.map(f=>f.path).join("\\n"))`,
      ROOT,
    ],
    { encoding: "utf8" },
  );
  if (lexerClosure.status !== 0) throw new Error(`fixture cannot derive the lexer closure: ${lexerClosure.stderr}`);
  for (const rel of [...instrumentFiles, ...lexerClosure.stdout.split("\n").filter(Boolean)]) {
    write(rel, fs.readFileSync(path.join(ROOT, rel)));
  }
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  write(".claude/hooks/dispatch-registry.json", JSON.stringify(registry, null, 2));
  write(".claude/settings.json", JSON.stringify(settings, null, 2));
  return root;
}

/** A manifest listing exactly `paths`, with real hashes. Hand-built per case: it is the
 *  CONTROL's independent oracle, never derived from the instrument under test. */
function writeManifest(root, relPath, paths) {
  const files = paths.map((p) => {
    const buf = fs.readFileSync(path.join(root, p));
    return { path: p, sha256: sha256(buf), bytes: buf.length };
  });
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .map((f) => `${f.sha256}  ${f.path}\n`)
    .join("");
  const digest = sha256(Buffer.from(lines, "utf8"));
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify({ file_count: files.length, files, content_digest: digest }, null, 2) + "\n");
  return abs;
}

const MANIFEST = "packages/PACKAGE-MANIFEST.json";
/** The instrument's declared supplement, read from the module so the fixture cannot
 *  drift from it. Registered on disk as stubs; the check requires them to exist. */
const SUPPLEMENT = (await import(MODULE)).PACKAGE_SUPPLEMENT;

const row = (file, { on_incomplete = "continue" } = {}) => ({
  type: "command",
  command: `node "$CLAUDE_PROJECT_DIR/${file}"`,
  on_incomplete,
});
const registryOf = (files, { loomOnly = [], extraRows = [] } = {}) => ({
  schema: 1,
  loom_only: loomOnly,
  events: {
    PreToolUse: { dispatcher: { matcher: "*", timeout: 60 }, groups: [{ matcher: "Bash", hooks: [...files.map((f) => row(f)), ...extraRows] }] },
  },
});
const settingsOf = (files) => ({
  hooks: { PreToolUse: [{ hooks: files.map((f) => ({ type: "command", command: `node "$CLAUDE_PROJECT_DIR/${f}"` })) }] },
});

/** Run the REAL checker as a subprocess. `status === null` means the spawn itself failed,
 *  which is reported rather than read as a verdict. `defaultManifest` omits `--manifest`
 *  so the instrument resolves its own default — the real-tree leg needs that, and a leg
 *  that inherits the synthetic path is testing a file that is not there. */
function run(root, args = [], { defaultManifest = false } = {}) {
  const argv = [CHECKER, "--root", root, ...(defaultManifest ? [] : ["--manifest", MANIFEST]), ...args];
  const r = spawnSync(process.execPath, argv, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", signal: r.signal, error: r.error };
}

const supplementStubs = Object.fromEntries(SUPPLEMENT.map((p) => [p, `// fixture stub for ${p}\n`]));
const REGISTRY_REL = ".claude/hooks/dispatch-registry.json";
const SETTINGS_REL = ".claude/settings.json";

// ---------------------------------------------------------------------------------
// Pair 1 — THE MANDATED RED: a registry row naming a file that does not exist.
// ---------------------------------------------------------------------------------
{
  const root = makeTree("ghost-row", {
    registry: registryOf([".claude/hooks/present-row.js", ".claude/hooks/ghost-row.js"]),
    settings: settingsOf([".claude/hooks/present-row.js"]),
    files: { ".claude/hooks/present-row.js": "// row\n", ...supplementStubs },
  });
  writeManifest(root, MANIFEST, [".claude/hooks/present-row.js", REGISTRY_REL, ...SUPPLEMENT]);
  const r = run(root);
  const names = r.stderr.includes("ghost-row.js") && r.stderr.includes("row-file-missing-on-disk");
  const namesRow = r.stderr.includes("PreToolUse/group 0") && r.stderr.includes("Bash");
  check("red/row-names-a-nonexistent-file->non-zero", r.status === 1, `expected rc 1, got ${r.status} (signal ${r.signal}, error ${r.error && r.error.message})`);
  check("red/…and-the-finding-names-the-file", names, `stderr did not carry row-file-missing-on-disk + ghost-row.js:\n${r.stderr.slice(0, 400)}`);
  check("red/…and-the-finding-names-the-row", namesRow, `stderr did not carry the row identity:\n${r.stderr.slice(0, 400)}`);
  check("red/…and-it-is-not-reported-clean", !r.stdout.includes("CLEAN"), "the checker printed CLEAN while a registered row had no file");
}

// ---------------------------------------------------------------------------------
// Pair 1 control — the same tree with the row's file present and packaged.
// ---------------------------------------------------------------------------------
{
  const root = makeTree("ghost-row-control", {
    registry: registryOf([".claude/hooks/present-row.js"]),
    settings: settingsOf([".claude/hooks/present-row.js"]),
    files: { ".claude/hooks/present-row.js": "// row\n", ...supplementStubs },
  });
  writeManifest(root, MANIFEST, [".claude/hooks/present-row.js", REGISTRY_REL, ...SUPPLEMENT]);
  const r = run(root);
  check("control/complete-set->exit-0", r.status === 0, `expected rc 0, got ${r.status}:\n${r.stderr.slice(0, 400)}`);
  check("control/…and-quiet", r.stderr.trim() === "", `expected no findings on stderr, got:\n${r.stderr.slice(0, 400)}`);
}

// ---------------------------------------------------------------------------------
// Pair 2 — the DEFECT ITSELF (the csq P0): the row's file exists, the package omits it.
// ---------------------------------------------------------------------------------
{
  const root = makeTree("row-not-packaged", {
    registry: registryOf([".claude/hooks/row-file.js"]),
    settings: settingsOf([".claude/hooks/row-file.js"]),
    files: { ".claude/hooks/row-file.js": "// row\n", ...supplementStubs },
  });
  writeManifest(root, MANIFEST, [REGISTRY_REL, ...SUPPLEMENT]); // row-file.js deliberately absent
  const r = run(root);
  check(
    "red/row-file-absent-from-package->non-zero",
    r.status === 1 && r.stderr.includes("row-file-absent-from-package") && r.stderr.includes("row-file.js"),
    `expected rc 1 naming row-file-absent-from-package + row-file.js, got rc ${r.status}:\n${r.stderr.slice(0, 400)}`,
  );
}

// ---------------------------------------------------------------------------------
// Pair 3 — the CLOSURE: a shipped file loads an engine module the package omits.
// ---------------------------------------------------------------------------------
{
  const loader = `require("./lib/engine.js");\n`;
  const root = makeTree("closure-gap", {
    registry: registryOf([".claude/hooks/loader.js"]),
    settings: settingsOf([".claude/hooks/loader.js"]),
    files: {
      ".claude/hooks/loader.js": loader,
      ".claude/hooks/lib/engine.js": "module.exports = { ok: true };\n",
      ...supplementStubs,
    },
  });
  writeManifest(root, MANIFEST, [".claude/hooks/loader.js", REGISTRY_REL, ...SUPPLEMENT]); // engine.js absent
  const r = run(root);
  check(
    "red/closure-member-absent-from-package->non-zero",
    r.status === 1 && r.stderr.includes("engine-file-absent-from-package") && r.stderr.includes("engine.js"),
    `expected rc 1 naming engine-file-absent-from-package + engine.js, got rc ${r.status}:\n${r.stderr.slice(0, 400)}`,
  );
  writeManifest(root, MANIFEST, [".claude/hooks/loader.js", ".claude/hooks/lib/engine.js", REGISTRY_REL, ...SUPPLEMENT]);
  const r2 = run(root);
  check("control/closure-member-packaged->exit-0", r2.status === 0, `expected rc 0, got ${r2.status}:\n${r2.stderr.slice(0, 400)}`);
}


const factoryContract = (await import(path.join(DOT_CLAUDE, "hooks/lib/hook-registry-contract.js"))).default;
const factoryCases = [
  ["literal-site", "createRequire(import.meta.url)(\"./lib/engine.js\");", ["./lib/engine.js"], 0],
  ["lazy-site", "function load() { return createRequire(import.meta.url)(\"./lib/engine.js\"); }", ["./lib/engine.js"], 0],
  ["trivia-site", "createRequire /* factory */ (import.meta.url) /* loader */ (\"./lib/engine.js\");", ["./lib/engine.js"], 0],
  ["nested-factory-argument", "createRequire(select({ root: base, cb: () => nested(\")\") }))(\"./lib/engine.js\");", ["./lib/engine.js"], 0],
  ["template-factory-argument", "createRequire(`${base}/x.js`)(\"./lib/engine.js\");", ["./lib/engine.js"], 0],
  ["dynamic-identifier-remains-unknown", "createRequire(import.meta.url)(specifier);", [], 1],
  ["dynamic-template-remains-unknown", "createRequire(import.meta.url)(`./lib/${name}.js`);", [], 1],
  ["string-head-remains-unknown", "createRequire(import.meta.url)(\"./lib/engine.js\" + suffix);", [], 1],
  ["comment-is-data", "// createRequire(import.meta.url)(\"./lib/engine.js\");\n", [], 0],
  ["string-is-data", "const note = 'createRequire(import.meta.url)(\"./lib/engine.js\");';", [], 0],
  ["missing-literal-site", "createRequire(import.meta.url)(\"./lib/absent.js\");", ["./lib/absent.js"], 0],
  ["bare-require-opposite", "require(\"./lib/engine.js\");", ["./lib/engine.js"], 0],
  ["alias-opposite", "const r = createRequire(import.meta.url); r(\"./lib/engine.js\");", ["./lib/engine.js"], 0],
  ["template-punctuation-argument", "createRequire(`${select(\")\")}/x.js`)(\"./lib/engine.js\");", ["./lib/engine.js"], 0],
];
for (const [name, source, expected, dynamicCount] of factoryCases) {
  const sites = factoryContract.requireSites(source);
  const literals = sites.sites.filter((site) => site.kind === "literal").map((site) => site.specifier);
  const dynamic = sites.sites.filter((site) => site.kind === "dynamic");
  check(`factory/${name}`, sites.ok && JSON.stringify(literals) === JSON.stringify(expected) && dynamic.length === dynamicCount, JSON.stringify(sites));
}
const factoryEntry = ".claude/hooks/loader.js";
const factoryEngine = ".claude/hooks/lib/engine.js";
const lazyFactory = 'function load() { return createRequire(import.meta.url)("./lib/engine.js"); }\n';
const factoryFiles = (loader) => ({ [factoryEntry]: loader, [factoryEngine]: "module.exports = { ok: true };\n", ...supplementStubs });
{
  const root = makeTree("immediate-lazy", { registry: registryOf([factoryEntry]), settings: settingsOf([factoryEntry]), files: factoryFiles(lazyFactory) });
  const closure = factoryContract.localRequireClosure(root, factoryEntry);
  check("factory/lazy-member", closure.ok && closure.files.some((file) => file.path === factoryEngine), JSON.stringify(closure));
  writeManifest(root, MANIFEST, [factoryEntry, REGISTRY_REL, ...SUPPLEMENT]);
  const missing = run(root);
  check("red/lazy-factory-engine-absent-from-package", missing.status === 1 && missing.stderr.includes("engine-file-absent-from-package") && missing.stderr.includes(factoryEngine), missing.stderr);
  writeManifest(root, MANIFEST, [factoryEntry, factoryEngine, REGISTRY_REL, ...SUPPLEMENT]);
  const present = run(root);
  check("control/lazy-factory-engine-packaged", present.status === 0, present.stderr);
}
{
  const root = makeTree("immediate-missing", { registry: registryOf([factoryEntry]), settings: settingsOf([factoryEntry]), files: factoryFiles(factoryCases[10][1]) });
  const closure = factoryContract.localRequireClosure(root, factoryEntry);
  check("factory/missing-literal-refuses", !closure.ok && closure.error.includes('requires "./lib/absent.js" which does not resolve to a file in this tree'), JSON.stringify(closure));
}
for (const [name, source] of [factoryCases[5], factoryCases[6]]) {
  const root = makeTree(`immediate-${name}`, { registry: registryOf([factoryEntry]), settings: settingsOf([factoryEntry]), files: factoryFiles(source) });
  const closure = factoryContract.localRequireClosure(root, factoryEntry);
  check(`factory/${name}-closure`, closure.ok && closure.dynamic.length === 1 && !closure.files.some((file) => file.path === factoryEngine), JSON.stringify(closure));
  writeManifest(root, MANIFEST, [factoryEntry, REGISTRY_REL, ...SUPPLEMENT]);
  const result = run(root);
  check(`factory/${name}-advisory`, result.status === 0 && result.stdout.includes("dynamic-load-sites-uncounted"), result.stdout + result.stderr);
}

const factoryProofProgram = [
  'const assert = require("node:assert/strict");',
  'const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");',
  'const inputHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(process.argv[2], ".claude/hooks/loader.js"))).digest("hex");',
  'process.stderr.write("FACTORY_PROOF_INPUT:" + inputHash + "\\n");',
  'const contract = require(process.argv[1]);',
  'const closure = contract.localRequireClosure(process.argv[2], ".claude/hooks/loader.js");',
  'assert.equal(closure.ok, true, "factory/proof-readable");',
  'assert.equal(closure.files.some(file => file.path === ".claude/hooks/lib/engine.js"), true, process.argv[3]);',
].join("\n");
const factoryReversions = [
  {"id": "immediate", "source": "function load() { return createRequire(import.meta.url)(\"./lib/engine.js\"); }\n", "from": "      factoryOpen >= 0 && tokens[factoryOpen]?.type === \"punct\" && at(factoryOpen) === \"(\";", "to": "      factoryOpen >= 0 && tokens[factoryOpen]?.type === \"punct\" && at(factoryOpen) === \"(\" && !(src === \"function load() { return createRequire(import.meta.url)(\\\"./lib/engine.js\\\"); }\\n\" && (process.stderr.write(\"FACTORY_IMMEDIATE_REACHED:\" + sha256Bytes(Buffer.from(src)) + \":\" + t.start + \"\\n\"), true));", "marker": "FACTORY_IMMEDIATE_REACHED", "point": 25, "inputSHA256": "301a8835228873f0b2e9c31b5137a46ccf778b2aab19559f70f5addff3143deb", "expectedMarker": "FACTORY_IMMEDIATE_REACHED:301a8835228873f0b2e9c31b5137a46ccf778b2aab19559f70f5addff3143deb:25"},
  {"id": "punctuation", "source": "createRequire(select({ root: base, cb: () => nested(\")\") }))(\"./lib/engine.js\");", "from": "    if (tokens[j].type !== \"punct\") continue;", "to": "    if (tokens[j].type !== \"punct\") { if (tokens[j].type !== \"string\" || tokens[j].value !== \")\") continue; process.stderr.write(\"FACTORY_PUNCTUATION_REACHED:\" + tokens[j].start + \"\\n\"); }", "marker": "FACTORY_PUNCTUATION_REACHED", "point": 52, "inputSHA256": "3c2f05b53db87ab756e7847eea00b8d95603844d889df5102f64c2da3c712dcb", "expectedMarker": "FACTORY_PUNCTUATION_REACHED:52"},
  {"id": "template", "source": "createRequire(`${select(\")\")}/x.js`)(\"./lib/engine.js\");", "from": "    if (tokens[j].type !== \"punct\") continue;", "to": "    if (tokens[j].type !== \"punct\") { if (tokens[j].type !== \"string\" || tokens[j].value !== \")\") continue; process.stderr.write(\"FACTORY_TEMPLATE_REACHED:\" + tokens[j].start + \"\\n\"); }", "marker": "FACTORY_TEMPLATE_REACHED", "point": 24, "inputSHA256": "b455546494285bec63ae4301c611e36e16fd60056b1eecec7781841c57a6eced", "expectedMarker": "FACTORY_TEMPLATE_REACHED:24"},
];
for (const recipe of factoryReversions) {
  const root = makeTree(`immediate-proof-${recipe.id}`, { registry: registryOf([factoryEntry]), settings: settingsOf([factoryEntry]), files: factoryFiles(recipe.source) });
  const contractPath = path.join(root, ".claude/hooks/lib/hook-registry-contract.js");
  const original = fs.readFileSync(contractPath, "utf8");
  const assertionName = `factory/proof-${recipe.id}-member`;
  const invoke = () => {
    const result = spawnSync(process.execPath, ["-e", factoryProofProgram, contractPath, root, assertionName], { encoding: "utf8" });
    process.stdout.write(`  CHILD ${recipe.id} stdout BEGIN\n${result.stdout || ""}  CHILD ${recipe.id} stdout END\n`);
    process.stderr.write(`  CHILD ${recipe.id} stderr BEGIN\n${result.stderr || ""}  CHILD ${recipe.id} stderr END\n`);
    return result;
  };
  const baseline = invoke();
  check(`control/factory-${recipe.id}-proof-baseline`, baseline.status === 0 && !baseline.stderr.includes(recipe.marker), baseline.stdout + baseline.stderr);
  if (baseline.status !== 0) { process.stdout.write(`  NOTRUN factory/${recipe.id}-reversion (baseline did not pass)\n`); continue; }
  const pieces = original.split(recipe.from);
  check(`factory/${recipe.id}-mutation-anchor`, pieces.length === 2, `expected ONE exact native anchor, got ${pieces.length - 1}`);
  if (pieces.length !== 2) continue;
  try {
    fs.writeFileSync(contractPath, original.replace(recipe.from, () => recipe.to));
    const mutant = invoke();
    const inputAt = (mutant.stderr || "").indexOf(`FACTORY_PROOF_INPUT:${recipe.inputSHA256}\n`);
    const markerAt = (mutant.stderr || "").indexOf(recipe.expectedMarker + "\n");
    check(`reversion/factory-${recipe.id}-named-lost-member`, mutant.status === 1 && inputAt >= 0 && markerAt > inputAt && mutant.stderr.indexOf("ERR_ASSERTION", markerAt) > markerAt && mutant.stderr.includes(assertionName), mutant.stdout + mutant.stderr);
  } finally {
    fs.writeFileSync(contractPath, original);
    check(`factory/${recipe.id}-copy-restored`, fs.readFileSync(contractPath, "utf8") === original, "copied canonical contract bytes did not restore");
  }
}


const layoutTargetBytes = "module.exports = { layoutFixture: true };\n";
const layoutRows = [
  {"id": "source", "file": ".claude/codex-mcp-guard/extract-policies.mjs", "source": "const extractorDir = path.dirname(fileURLToPath(import.meta.url));\nconst registryLib = createRequire(import.meta.url)(path.resolve(extractorDir,\n  path.basename(extractorDir) === \"codex-mcp-guard\" && path.basename(path.dirname(extractorDir)) === \".claude\" ? \"../hooks/lib/dispatch-registry.js\" : \"../.claude/hooks/lib/dispatch-registry.js\"));\n", "present": [".claude/hooks/lib/dispatch-registry.js"], "expected": {"error": null, "layout": "source", "target": ".claude/hooks/lib/dispatch-registry.js", "targetSHA256": "3031f8b217338e165874aa007c411feedc6a7233a00743a998a38806ba09be5f", "spanStart": 67, "spanEnd": 342, "dynamic": false}, "baselineFault": null, "inputSHA256": "35b8e9c9e76d6e73aba971d24a8391f74885230d38fb3c5247781c48df4d45e9", "reversion": {"from": "      queue.push(target);", "to": "      if (layoutLoad) process.stderr.write(\"LAYOUT_QUEUE_REACHED:\" + layoutLoad.sourceSHA256 + \":\" + layoutLoad.span.start + \"\\n\"); else queue.push(target);", "marker": "LAYOUT_QUEUE_REACHED:35b8e9c9e76d6e73aba971d24a8391f74885230d38fb3c5247781c48df4d45e9:67", "assertion": "layout/source-target-closure", "scope": "normal chosen-target queue operation; postcondition refusal may absorb operation loss but named membership still RED"}},
  {"id": "projected", "file": ".codex-mcp-guard/extract-policies.mjs", "source": "const extractorDir = path.dirname(fileURLToPath(import.meta.url));\nconst registryLib = createRequire(import.meta.url)(path.resolve(extractorDir,\n  path.basename(extractorDir) === \"codex-mcp-guard\" && path.basename(path.dirname(extractorDir)) === \".claude\" ? \"../hooks/lib/dispatch-registry.js\" : \"../.claude/hooks/lib/dispatch-registry.js\"));\n", "present": [".claude/hooks/lib/dispatch-registry.js"], "expected": {"error": null, "layout": "projection", "target": ".claude/hooks/lib/dispatch-registry.js", "targetSHA256": "3031f8b217338e165874aa007c411feedc6a7233a00743a998a38806ba09be5f", "spanStart": 67, "spanEnd": 342, "dynamic": false}, "baselineFault": null, "inputSHA256": "35b8e9c9e76d6e73aba971d24a8391f74885230d38fb3c5247781c48df4d45e9", "reversion": {"from": "      queue.push(target);", "to": "      if (layoutLoad) process.stderr.write(\"LAYOUT_QUEUE_REACHED:\" + layoutLoad.sourceSHA256 + \":\" + layoutLoad.span.start + \"\\n\"); else queue.push(target);", "marker": "LAYOUT_QUEUE_REACHED:35b8e9c9e76d6e73aba971d24a8391f74885230d38fb3c5247781c48df4d45e9:67", "assertion": "layout/projected-target-closure", "scope": "normal chosen-target queue operation; postcondition refusal may absorb operation loss but named membership still RED"}},
  {"id": "third", "file": "third/codex-mcp-guard/extract-policies.mjs", "source": "const extractorDir = path.dirname(fileURLToPath(import.meta.url));\nconst registryLib = createRequire(import.meta.url)(path.resolve(extractorDir,\n  path.basename(extractorDir) === \"codex-mcp-guard\" && path.basename(path.dirname(extractorDir)) === \".claude\" ? \"../hooks/lib/dispatch-registry.js\" : \"../.claude/hooks/lib/dispatch-registry.js\"));\n", "present": [".claude/hooks/lib/dispatch-registry.js"], "expected": {"error": "declared-layout/unknown-layout", "layout": null, "target": ".claude/hooks/lib/dispatch-registry.js", "targetSHA256": "3031f8b217338e165874aa007c411feedc6a7233a00743a998a38806ba09be5f", "spanStart": 67, "spanEnd": 342, "dynamic": false}, "baselineFault": null, "inputSHA256": "35b8e9c9e76d6e73aba971d24a8391f74885230d38fb3c5247781c48df4d45e9", "reversion": {"faults": [{"from": "  if (!layout) return bad(\"unknown-layout\");", "to": "  if (!layout) { process.stderr.write(\"LAYOUT_PREDICATE_REACHED:third\\n\"); return null; }", "point": "actual resolver decision arm BEFORE returned missing-fact error"}, {"from": "        layoutLoad = resolveDeclaredLayout(rootAbs, rel, site);\n        if (layoutLoad.error) return layoutFailure(layoutLoad.error);", "to": "        layoutLoad = resolveDeclaredLayout(rootAbs, rel, site);\n        if (layoutLoad === null) { process.stderr.write(\"LAYOUT_PAIRED_REACHED:third\\n\"); dynamic.push({ file: rel, line: site.line }); continue; }\n        if (layoutLoad.error) return layoutFailure(layoutLoad.error);", "point": "paired caller fallback consumes only the null created at that actual resolver arm; retains generic unknown fact instead of a TypeError"}], "markers": ["LAYOUT_PREDICATE_REACHED:third", "LAYOUT_PAIRED_REACHED:third"], "marker": "LAYOUT_PREDICATE_REACHED:third", "assertion": "layout/third-refuses", "scope": "Bounded paired fault: responsible resolver arm returns null, then its caller wrongly downgrades null to an ordinary dynamic record. BOTH markers required. Different error/syntax/crash cannot credit safety-refusal oracle."}},
  {"id": "wrong-declaration", "file": ".claude/codex-mcp-guard/extract-policies.mjs", "source": "const extractorDir = path.dirname(fileURLToPath(import.meta.url));\nconst registryLib = createRequire(import.meta.url)(path.resolve(extractorDir,\n  path.basename(extractorDir) === \"codex-mcp-guard\" && path.basename(path.dirname(extractorDir)) === \".claude\" ? \"../hooks/lib/dispatch-registry.js\" : \"../.claude/hooks/lib/dispatch-registry.js\"));\n", "present": [".claude/hooks/lib/dispatch-registry.js"], "expected": {"error": "declared-layout/declaration-mismatch", "layout": null, "target": ".claude/hooks/lib/dispatch-registry.js", "targetSHA256": "3031f8b217338e165874aa007c411feedc6a7233a00743a998a38806ba09be5f", "spanStart": 67, "spanEnd": 342, "dynamic": false}, "baselineFault": {"from": "    Object.freeze({ id: \"source\", canonicalCarrier: \".claude/codex-mcp-guard/extract-policies.mjs\", arm: \"true\", literal: \"../hooks/lib/dispatch-registry.js\" }),", "to": "    Object.freeze({ id: \"source\", canonicalCarrier: \".claude/codex-mcp-guard/extract-policies.mjs\", arm: \"true\", literal: \"../changed/lib/dispatch-registry.js\" }),"}, "inputSHA256": "35b8e9c9e76d6e73aba971d24a8391f74885230d38fb3c5247781c48df4d45e9", "reversion": {"faults": [{"from": "      if (actualCarrierLayout(declared.canonicalCarrier) !== declared.id || declared.id !== (role === 0 ? \"source\" : \"projection\") || declared.arm !== (role === 0 ? \"true\" : \"false\") || pattern?.type !== \"string\" || pattern.value !== declared.literal) return bad(\"declaration-mismatch\");", "to": "      if (actualCarrierLayout(declared.canonicalCarrier) !== declared.id || declared.id !== (role === 0 ? \"source\" : \"projection\") || declared.arm !== (role === 0 ? \"true\" : \"false\") || pattern?.type !== \"string\" || pattern.value !== declared.literal) { process.stderr.write(\"LAYOUT_PREDICATE_REACHED:wrong-declaration\\n\"); return null; }", "point": "actual false predicate arm BEFORE construction of the missing-fact error"}], "markers": ["LAYOUT_PREDICATE_REACHED:wrong-declaration"], "marker": "LAYOUT_PREDICATE_REACHED:wrong-declaration", "assertion": "layout/wrong-declaration-refuses", "scope": "Responsible declaration predicate arm removed; returns no recognized declaration so existing ordinary dynamic parsing can run. Only original closure.ok===false safety assertion may credit a new RED."}},
  {"id": "source-literal-change", "file": ".claude/codex-mcp-guard/extract-policies.mjs", "source": "const extractorDir = path.dirname(fileURLToPath(import.meta.url));\nconst registryLib = createRequire(import.meta.url)(path.resolve(extractorDir,\n  path.basename(extractorDir) === \"codex-mcp-guard\" && path.basename(path.dirname(extractorDir)) === \".claude\" ? \"../changed/lib/dispatch-registry.js\" : \"../.claude/hooks/lib/dispatch-registry.js\"));\n", "present": [".claude/hooks/lib/dispatch-registry.js"], "expected": {"error": "declared-layout/source-mismatch", "layout": null, "target": ".claude/hooks/lib/dispatch-registry.js", "targetSHA256": "3031f8b217338e165874aa007c411feedc6a7233a00743a998a38806ba09be5f", "spanStart": 67, "spanEnd": 344, "dynamic": false}, "baselineFault": null, "inputSHA256": "d5628fa216a2ac2122053250a1fa88f39ecf90cc6c627bad9712960c6a9ed72c", "reversion": {"faults": [{"from": "    if (symbols.length !== 1 || statements.length !== 1 || symbols[0] !== statements[0] || !layoutTopLevel(tokens, statements[0])) return bad(\"source-mismatch\");", "to": "    if (symbols.length !== 1 || statements.length !== 1 || symbols[0] !== statements[0] || !layoutTopLevel(tokens, statements[0])) { process.stderr.write(\"LAYOUT_PREDICATE_REACHED:source-literal-change\\n\"); return null; }", "point": "actual false predicate arm BEFORE construction of the missing-fact error"}], "markers": ["LAYOUT_PREDICATE_REACHED:source-literal-change"], "marker": "LAYOUT_PREDICATE_REACHED:source-literal-change", "assertion": "layout/source-literal-change-refuses", "scope": "Responsible declaration predicate arm removed; returns no recognized declaration so existing ordinary dynamic parsing can run. Only original closure.ok===false safety assertion may credit a new RED."}},
  {"id": "raw-role-spelling", "file": ".claude/codex-mcp-guard/extract-policies.mjs", "source": "const extractorDir = path.dirname(fileURLToPath(import.meta.url));\nconst registryLib = createRequire(import.meta.url)(path.resolve(extractorDir,\n  path.basename(extractorDir) === \"codex-mcp-guard\" && path.basename(path.dirname(extractorDir)) === \".claude\" ? '../hooks/lib/dispatch-registry.js' : \"../.claude/hooks/lib/dispatch-registry.js\"));\n", "present": [".claude/hooks/lib/dispatch-registry.js"], "expected": {"error": "declared-layout/source-literal-mismatch", "layout": null, "target": ".claude/hooks/lib/dispatch-registry.js", "targetSHA256": "3031f8b217338e165874aa007c411feedc6a7233a00743a998a38806ba09be5f", "spanStart": 67, "spanEnd": 342, "dynamic": false}, "baselineFault": null, "inputSHA256": "c7fd346ef2935f32b3ef38f6c7486771078fceb9589359c8de5bed70cf92bb68", "reversion": {"faults": [{"from": "      if (actual?.type !== \"string\" || actual.value !== declared.literal || src.slice(actual.start, actual.end) !== declaration.statement.slice(pattern.start, pattern.end)) return bad(\"source-literal-mismatch\");", "to": "      if (actual?.type !== \"string\" || actual.value !== declared.literal || src.slice(actual.start, actual.end) !== declaration.statement.slice(pattern.start, pattern.end)) { process.stderr.write(\"LAYOUT_PREDICATE_REACHED:raw-role-spelling\\n\"); return null; }", "point": "actual false predicate arm BEFORE construction of the missing-fact error"}], "markers": ["LAYOUT_PREDICATE_REACHED:raw-role-spelling"], "marker": "LAYOUT_PREDICATE_REACHED:raw-role-spelling", "assertion": "layout/raw-role-spelling-refuses", "scope": "Responsible declaration predicate arm removed; returns no recognized declaration so existing ordinary dynamic parsing can run. Only original closure.ok===false safety assertion may credit a new RED."}},
  {"id": "both", "file": ".claude/codex-mcp-guard/extract-policies.mjs", "source": "const extractorDir = path.dirname(fileURLToPath(import.meta.url));\nconst registryLib = createRequire(import.meta.url)(path.resolve(extractorDir,\n  path.basename(extractorDir) === \"codex-mcp-guard\" && path.basename(path.dirname(extractorDir)) === \".claude\" ? \"../hooks/lib/dispatch-registry.js\" : \"../.claude/hooks/lib/dispatch-registry.js\"));\n", "present": [".claude/hooks/lib/dispatch-registry.js", ".claude/.claude/hooks/lib/dispatch-registry.js"], "expected": {"error": "declared-layout/target-count-both", "layout": null, "target": ".claude/hooks/lib/dispatch-registry.js", "targetSHA256": "3031f8b217338e165874aa007c411feedc6a7233a00743a998a38806ba09be5f", "spanStart": 67, "spanEnd": 342, "dynamic": false}, "baselineFault": null, "inputSHA256": "35b8e9c9e76d6e73aba971d24a8391f74885230d38fb3c5247781c48df4d45e9", "reversion": {"faults": [{"from": "  if (present.length !== 1) return bad(present.length ? \"target-count-both\" : \"target-count-neither\");", "to": "  if (present.length !== 1) { process.stderr.write(\"LAYOUT_PREDICATE_REACHED:both\\n\"); return null; }", "point": "actual resolver decision arm BEFORE returned missing-fact error"}, {"from": "        layoutLoad = resolveDeclaredLayout(rootAbs, rel, site);\n        if (layoutLoad.error) return layoutFailure(layoutLoad.error);", "to": "        layoutLoad = resolveDeclaredLayout(rootAbs, rel, site);\n        if (layoutLoad === null) { process.stderr.write(\"LAYOUT_PAIRED_REACHED:both\\n\"); dynamic.push({ file: rel, line: site.line }); continue; }\n        if (layoutLoad.error) return layoutFailure(layoutLoad.error);", "point": "paired caller fallback consumes only the null created at that actual resolver arm; retains generic unknown fact instead of a TypeError"}], "markers": ["LAYOUT_PREDICATE_REACHED:both", "LAYOUT_PAIRED_REACHED:both"], "marker": "LAYOUT_PREDICATE_REACHED:both", "assertion": "layout/both-refuses", "scope": "Bounded paired fault: responsible resolver arm returns null, then its caller wrongly downgrades null to an ordinary dynamic record. BOTH markers required. Different error/syntax/crash cannot credit safety-refusal oracle."}},
  {"id": "neither", "file": ".claude/codex-mcp-guard/extract-policies.mjs", "source": "const extractorDir = path.dirname(fileURLToPath(import.meta.url));\nconst registryLib = createRequire(import.meta.url)(path.resolve(extractorDir,\n  path.basename(extractorDir) === \"codex-mcp-guard\" && path.basename(path.dirname(extractorDir)) === \".claude\" ? \"../hooks/lib/dispatch-registry.js\" : \"../.claude/hooks/lib/dispatch-registry.js\"));\n", "present": [], "expected": {"error": "declared-layout/target-count-neither", "layout": null, "target": ".claude/hooks/lib/dispatch-registry.js", "targetSHA256": "3031f8b217338e165874aa007c411feedc6a7233a00743a998a38806ba09be5f", "spanStart": 67, "spanEnd": 342, "dynamic": false}, "baselineFault": null, "inputSHA256": "35b8e9c9e76d6e73aba971d24a8391f74885230d38fb3c5247781c48df4d45e9", "reversion": {"faults": [{"from": "  if (present.length !== 1) return bad(present.length ? \"target-count-both\" : \"target-count-neither\");", "to": "  if (present.length !== 1) { process.stderr.write(\"LAYOUT_PREDICATE_REACHED:neither\\n\"); return null; }", "point": "actual resolver decision arm BEFORE returned missing-fact error"}, {"from": "        layoutLoad = resolveDeclaredLayout(rootAbs, rel, site);\n        if (layoutLoad.error) return layoutFailure(layoutLoad.error);", "to": "        layoutLoad = resolveDeclaredLayout(rootAbs, rel, site);\n        if (layoutLoad === null) { process.stderr.write(\"LAYOUT_PAIRED_REACHED:neither\\n\"); dynamic.push({ file: rel, line: site.line }); continue; }\n        if (layoutLoad.error) return layoutFailure(layoutLoad.error);", "point": "paired caller fallback consumes only the null created at that actual resolver arm; retains generic unknown fact instead of a TypeError"}], "markers": ["LAYOUT_PREDICATE_REACHED:neither", "LAYOUT_PAIRED_REACHED:neither"], "marker": "LAYOUT_PREDICATE_REACHED:neither", "assertion": "layout/neither-refuses", "scope": "Bounded paired fault: responsible resolver arm returns null, then its caller wrongly downgrades null to an ordinary dynamic record. BOTH markers required. Different error/syntax/crash cannot credit safety-refusal oracle."}},
  {"id": "wrong-selected-arm", "file": ".claude/codex-mcp-guard/extract-policies.mjs", "source": "const extractorDir = path.dirname(fileURLToPath(import.meta.url));\nconst registryLib = createRequire(import.meta.url)(path.resolve(extractorDir,\n  path.basename(extractorDir) === \"codex-mcp-guard\" && path.basename(path.dirname(extractorDir)) === \".claude\" ? \"../hooks/lib/dispatch-registry.js\" : \"../.claude/hooks/lib/dispatch-registry.js\"));\n", "present": [".claude/.claude/hooks/lib/dispatch-registry.js"], "expected": {"error": "declared-layout/selected-arm-mismatch", "layout": null, "target": ".claude/hooks/lib/dispatch-registry.js", "targetSHA256": "3031f8b217338e165874aa007c411feedc6a7233a00743a998a38806ba09be5f", "spanStart": 67, "spanEnd": 342, "dynamic": false}, "baselineFault": null, "inputSHA256": "35b8e9c9e76d6e73aba971d24a8391f74885230d38fb3c5247781c48df4d45e9", "reversion": {"faults": [{"from": "  if (present[0].id !== layout) return bad(\"selected-arm-mismatch\");", "to": "  if (present[0].id !== layout) { process.stderr.write(\"LAYOUT_PREDICATE_REACHED:wrong-selected-arm\\n\"); return null; }", "point": "actual resolver decision arm BEFORE returned missing-fact error"}, {"from": "        layoutLoad = resolveDeclaredLayout(rootAbs, rel, site);\n        if (layoutLoad.error) return layoutFailure(layoutLoad.error);", "to": "        layoutLoad = resolveDeclaredLayout(rootAbs, rel, site);\n        if (layoutLoad === null) { process.stderr.write(\"LAYOUT_PAIRED_REACHED:wrong-selected-arm\\n\"); dynamic.push({ file: rel, line: site.line }); continue; }\n        if (layoutLoad.error) return layoutFailure(layoutLoad.error);", "point": "paired caller fallback consumes only the null created at that actual resolver arm; retains generic unknown fact instead of a TypeError"}], "markers": ["LAYOUT_PREDICATE_REACHED:wrong-selected-arm", "LAYOUT_PAIRED_REACHED:wrong-selected-arm"], "marker": "LAYOUT_PREDICATE_REACHED:wrong-selected-arm", "assertion": "layout/wrong-selected-arm-refuses", "scope": "Bounded paired fault: responsible resolver arm returns null, then its caller wrongly downgrades null to an ordinary dynamic record. BOTH markers required. Different error/syntax/crash cannot credit safety-refusal oracle."}},
  {"id": "base-unproven", "file": ".claude/codex-mcp-guard/extract-policies.mjs", "source": "const extractorDir = elsewhere;\nconst registryLib = createRequire(import.meta.url)(path.resolve(extractorDir,\n  path.basename(extractorDir) === \"codex-mcp-guard\" && path.basename(path.dirname(extractorDir)) === \".claude\" ? \"../hooks/lib/dispatch-registry.js\" : \"../.claude/hooks/lib/dispatch-registry.js\"));\n", "present": [".claude/hooks/lib/dispatch-registry.js"], "expected": {"error": "declared-layout/base-unproven", "layout": null, "target": ".claude/hooks/lib/dispatch-registry.js", "targetSHA256": "3031f8b217338e165874aa007c411feedc6a7233a00743a998a38806ba09be5f", "spanStart": 32, "spanEnd": 307, "dynamic": false}, "baselineFault": null, "inputSHA256": "51995643440bac115e7283785908b2353c3664d6d591eda7e4bdecbb04d0b1a3", "reversion": {"faults": [{"from": "    if (bases.length !== 1 || bases[0] >= start || !layoutTopLevel(tokens, bases[0]) || !parts || parts.length !== 0) return bad(\"base-unproven\");", "to": "    if (bases.length !== 1 || bases[0] >= start || !layoutTopLevel(tokens, bases[0]) || !parts || parts.length !== 0) { process.stderr.write(\"LAYOUT_PREDICATE_REACHED:base-unproven\\n\"); return null; }", "point": "actual false predicate arm BEFORE construction of the missing-fact error"}], "markers": ["LAYOUT_PREDICATE_REACHED:base-unproven"], "marker": "LAYOUT_PREDICATE_REACHED:base-unproven", "assertion": "layout/base-unproven-refuses", "scope": "Responsible declaration predicate arm removed; returns no recognized declaration so existing ordinary dynamic parsing can run. Only original closure.ok===false safety assertion may credit a new RED."}},
  {"id": "duplicate-symbol", "file": ".claude/codex-mcp-guard/extract-policies.mjs", "source": "const extractorDir = path.dirname(fileURLToPath(import.meta.url));\nconst registryLib = createRequire(import.meta.url)(path.resolve(extractorDir,\n  path.basename(extractorDir) === \"codex-mcp-guard\" && path.basename(path.dirname(extractorDir)) === \".claude\" ? \"../hooks/lib/dispatch-registry.js\" : \"../.claude/hooks/lib/dispatch-registry.js\"));\nconst registryLib = createRequire(import.meta.url)(path.resolve(extractorDir,\n  path.basename(extractorDir) === \"codex-mcp-guard\" && path.basename(path.dirname(extractorDir)) === \".claude\" ? \"../hooks/lib/dispatch-registry.js\" : \"../.claude/hooks/lib/dispatch-registry.js\"));\n", "present": [".claude/hooks/lib/dispatch-registry.js"], "expected": {"error": "declared-layout/source-mismatch", "layout": null, "target": ".claude/hooks/lib/dispatch-registry.js", "targetSHA256": "3031f8b217338e165874aa007c411feedc6a7233a00743a998a38806ba09be5f", "spanStart": 67, "spanEnd": 342, "dynamic": false}, "baselineFault": null, "inputSHA256": "333e823afe1970c4944209c92699f66570a12ee56bb2ac185a65686dcea95a42", "reversion": {"faults": [{"from": "    if (symbols.length !== 1 || statements.length !== 1 || symbols[0] !== statements[0] || !layoutTopLevel(tokens, statements[0])) return bad(\"source-mismatch\");", "to": "    if (symbols.length !== 1 || statements.length !== 1 || symbols[0] !== statements[0] || !layoutTopLevel(tokens, statements[0])) { process.stderr.write(\"LAYOUT_PREDICATE_REACHED:duplicate-symbol\\n\"); return null; }", "point": "actual false predicate arm BEFORE construction of the missing-fact error"}], "markers": ["LAYOUT_PREDICATE_REACHED:duplicate-symbol"], "marker": "LAYOUT_PREDICATE_REACHED:duplicate-symbol", "assertion": "layout/duplicate-symbol-refuses", "scope": "Responsible declaration predicate arm removed; returns no recognized declaration so existing ordinary dynamic parsing can run. Only original closure.ok===false safety assertion may credit a new RED."}},
  {"id": "literal-role-count", "file": ".claude/codex-mcp-guard/extract-policies.mjs", "source": "const extractorDir = path.dirname(fileURLToPath(import.meta.url));\nconst registryLib = createRequire(import.meta.url)(path.resolve(extractorDir,\n  path.basename(extractorDir) === \"codex-mcp-guard\" && path.basename(path.dirname(extractorDir)) === \".claude\" ? \"../hooks/lib/dispatch-registry.js\" : \"../.claude/hooks/lib/dispatch-registry.js\"));\n", "present": [".claude/hooks/lib/dispatch-registry.js"], "expected": {"error": "declared-layout/literal-role-count", "layout": null, "target": ".claude/hooks/lib/dispatch-registry.js", "targetSHA256": "3031f8b217338e165874aa007c411feedc6a7233a00743a998a38806ba09be5f", "spanStart": 67, "spanEnd": 342, "dynamic": false}, "baselineFault": {"from": "    Object.freeze({ id: \"projection\", canonicalCarrier: \".codex-mcp-guard/extract-policies.mjs\", arm: \"false\", literal: \"../.claude/hooks/lib/dispatch-registry.js\" }),\n", "to": ""}, "inputSHA256": "35b8e9c9e76d6e73aba971d24a8391f74885230d38fb3c5247781c48df4d45e9", "reversion": {"faults": [{"from": "    if (questions.length !== 1 || colons.length !== 1 || declaration.layouts.length !== 2) return bad(\"literal-role-count\");", "to": "    if (questions.length !== 1 || colons.length !== 1 || declaration.layouts.length !== 2) { process.stderr.write(\"LAYOUT_PREDICATE_REACHED:literal-role-count\\n\"); return null; }", "point": "actual false predicate arm BEFORE construction of the missing-fact error"}], "markers": ["LAYOUT_PREDICATE_REACHED:literal-role-count"], "marker": "LAYOUT_PREDICATE_REACHED:literal-role-count", "assertion": "layout/literal-role-count-refuses", "scope": "Responsible declaration predicate arm removed; returns no recognized declaration so existing ordinary dynamic parsing can run. Only original closure.ok===false safety assertion may credit a new RED."}},
  {"id": "target-unpinned", "file": ".claude/codex-mcp-guard/extract-policies.mjs", "source": "const extractorDir = path.dirname(fileURLToPath(import.meta.url));\nconst registryLib = createRequire(import.meta.url)(path.resolve(extractorDir,\n  path.basename(extractorDir) === \"codex-mcp-guard\" && path.basename(path.dirname(extractorDir)) === \".claude\" ? \"../hooks/lib/dispatch-registry.js\" : \"../.claude/hooks/lib/dispatch-registry.js\"));\n", "present": [".claude/hooks/lib/dispatch-registry.js"], "expected": {"error": "declared-layout/target-unpinned", "layout": null, "target": ".claude/hooks/lib/dispatch-registry.js", "targetSHA256": "3031f8b217338e165874aa007c411feedc6a7233a00743a998a38806ba09be5f", "spanStart": 67, "spanEnd": 342, "dynamic": false}, "baselineFault": {"from": "      queue.push(target);", "to": "      if (layoutLoad) process.stderr.write(\"LAYOUT_QUEUE_REACHED:\" + layoutLoad.sourceSHA256 + \":\" + layoutLoad.span.start + \"\\n\"); else queue.push(target);"}, "inputSHA256": "35b8e9c9e76d6e73aba971d24a8391f74885230d38fb3c5247781c48df4d45e9", "reversion": {"faults": [{"from": "  if (layoutLoads.some((load) => load.target !== entryCanon && !files.some((file) => file.path === load.target))) return layoutFailure(\"declared-layout/target-unpinned\");", "to": "  if (layoutLoads.some((load) => load.target !== entryCanon && !files.some((file) => file.path === load.target))) process.stderr.write(\"LAYOUT_PREDICATE_REACHED:target-unpinned\\n\");", "point": "actual selected-target membership postcondition before failure-return"}], "markers": ["LAYOUT_QUEUE_REACHED:35b8e9c9e76d6e73aba971d24a8391f74885230d38fb3c5247781c48df4d45e9:67", "LAYOUT_PREDICATE_REACHED:target-unpinned"], "marker": "LAYOUT_PREDICATE_REACHED:target-unpinned", "assertion": "layout/target-unpinned-refuses", "scope": "Double fault keeps original selected-queue suppression and drops actual missing-membership postcondition. Actual queue and postcondition markers both precede unchanged safety-refusal assertion."}},
  {"id": "undeclared-dynamic", "file": ".claude/hooks/layout-dynamic.js", "source": "createRequire(import.meta.url)(specifier);\n", "present": [], "expected": {"error": null, "layout": null, "target": ".claude/hooks/lib/dispatch-registry.js", "targetSHA256": "3031f8b217338e165874aa007c411feedc6a7233a00743a998a38806ba09be5f", "spanStart": null, "spanEnd": null, "dynamic": true}, "baselineFault": null, "inputSHA256": "2f849640818b2ff36572d79528436a46a669df4519a9a874012e4af04015a628", "reversion": {"from": "        dynamic.push({\n          file: rel,\n          line: site.line,\n          ...(site.why ? { why: site.why } : {}),\n        });", "to": "        process.stderr.write(\"LAYOUT_DYNAMIC_REACHED\\n\");", "marker": "LAYOUT_DYNAMIC_REACHED", "assertion": "layout/undeclared-dynamic-dynamic", "scope": "retained canonical unknown fact; native unexempted refusal belongs emitter owner"}},
];
const layoutProofProgram = [
  'const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");',
  'const row = JSON.parse(process.argv[3]), input = fs.readFileSync(path.join(process.argv[2], row.file));',
  'const inputHash = crypto.createHash("sha256").update(input).digest("hex"); process.stderr.write("LAYOUT_INPUT:" + inputHash + "\\n");',
  'const closure = require(process.argv[1]).localRequireClosure(process.argv[2], row.file), expected = row.expected;',
  'if (expected.error) { assert.equal(closure.ok, false, "layout/" + row.id + "-refuses"); assert.ok(closure.error.includes(expected.error), "layout/" + row.id + "-identity"); }',
  'else if (expected.dynamic) { assert.equal(closure.ok && closure.dynamic.length === 1 && closure.files.length === 0, true, "layout/" + row.id + "-dynamic"); }',
  'else { const member = closure.files.find(file => file.path === expected.target); assert.equal(closure.ok && member?.sha256 === expected.targetSHA256, true, "layout/" + row.id + "-target-closure");',
  'const fact = closure.layoutLoads[0]; assert.equal(closure.layoutLoads.length, 1, "layout/" + row.id + "-one-fact"); assert.equal(fact.layout, expected.layout, "layout/" + row.id + "-actual-layout");',
  'assert.equal(fact.sourceSHA256, inputHash, "layout/" + row.id + "-source-bytes"); assert.deepEqual(fact.span, { start: expected.spanStart, end: expected.spanEnd }, "layout/" + row.id + "-source-span"); assert.equal(fact.target, expected.target, "layout/" + row.id + "-target-fact"); }',
].join("\n");
for (const row of layoutRows) {
  const files = { ...supplementStubs, [row.file]: row.source };
  for (const member of row.present) files[member] = layoutTargetBytes;
  const root = makeTree(`declared-layout-${row.id}`, { registry: registryOf([]), settings: settingsOf([]), files });
  const contractPath = path.join(root, ".claude/hooks/lib/hook-registry-contract.js");
  const original = fs.readFileSync(contractPath, "utf8");
  let baselineBytes = original;
  const applyFault = (bytes, recipe) => {
    for (const fault of recipe.faults || [recipe]) {
      const count = bytes.split(fault.from).length - 1;
      check(`layout/${row.id}-exact-anchor`, count === 1, `expected ONE owning anchor, got ${count}`);
      if (count !== 1) return null;
      bytes = bytes.replace(fault.from, () => fault.to);
    }
    return bytes;
  };
  if (row.baselineFault) baselineBytes = applyFault(original, row.baselineFault);
  if (baselineBytes === null) continue;
  const invoke = (phase) => {
    const stdoutPath = path.join(root, `layout-${phase}.stdout`), stderrPath = path.join(root, `layout-${phase}.stderr`);
    const stdoutFD = fs.openSync(stdoutPath, "w"), stderrFD = fs.openSync(stderrPath, "w");
    let result;
    try { result = spawnSync(process.execPath, ["-e", layoutProofProgram, contractPath, root, JSON.stringify(row)], { stdio: ["ignore", stdoutFD, stderrFD] }); }
    finally { fs.fsyncSync(stdoutFD); fs.fsyncSync(stderrFD); fs.closeSync(stdoutFD); fs.closeSync(stderrFD); }
    result.stdout = fs.readFileSync(stdoutPath, "utf8"); result.stderr = fs.readFileSync(stderrPath, "utf8");
    process.stdout.write(`  LAYOUT CHILD ${row.id} ${phase} stdout BEGIN\n${result.stdout}  LAYOUT CHILD ${row.id} ${phase} stdout END\n`);
    process.stderr.write(`  LAYOUT CHILD ${row.id} ${phase} stderr BEGIN\n${result.stderr}  LAYOUT CHILD ${row.id} ${phase} stderr END\n`);
    return result;
  };
  try {
    fs.writeFileSync(contractPath, baselineBytes);
    const baseline = invoke("baseline");
    check(`control/layout-${row.id}-baseline`, baseline.status === 0 && !baseline.stderr.includes(row.reversion.marker), baseline.stdout + baseline.stderr);
    if (baseline.status !== 0) { process.stdout.write(`  NOTRUN layout/${row.id}-inverse (baseline did not pass)\n`); continue; }
    const mutantBytes = applyFault(baselineBytes, row.reversion);
    if (mutantBytes === null) continue;
    try {
      fs.writeFileSync(contractPath, mutantBytes);
      const mutant = invoke("mutant"), stderr = mutant.stderr || "";
      const inputAt = stderr.indexOf(`LAYOUT_INPUT:${row.inputSHA256}\n`);
      const points = (row.reversion.markers || [row.reversion.marker]).map(marker => stderr.indexOf(marker + "\n"));
      const lastPoint = Math.max(...points), assertionAt = stderr.indexOf("ERR_ASSERTION", lastPoint);
      check(`reversion/layout-${row.id}-named-red`, mutant.status === 1 && inputAt >= 0 && points.every(point => point > inputAt) && assertionAt > lastPoint && stderr.indexOf(row.reversion.assertion, assertionAt) > assertionAt, mutant.stdout + stderr);
    } finally {
      fs.writeFileSync(contractPath, baselineBytes);
      check(`layout/${row.id}-copy-restored`, fs.readFileSync(contractPath, "utf8") === baselineBytes, "copy mutation did not restore its declared baseline bytes");
    }
  } finally {
    fs.writeFileSync(contractPath, original);
    check(`layout/${row.id}-original-copy-restored`, fs.readFileSync(contractPath, "utf8") === original, "controlled negative fixture did not restore original copied authority");
  }
}

// ---------------------------------------------------------------------------------
// Pair 4 — a row whose command the parser cannot read is a FINDING, never a skip.
// ---------------------------------------------------------------------------------
{
  const root = makeTree("unparsable-row", {
    registry: {
      schema: 1,
      events: {
        PreToolUse: {
          dispatcher: { matcher: "*", timeout: 60 },
          groups: [
            {
              matcher: "Bash",
              hooks: [
                row(".claude/hooks/ok.js"),
                { type: "command", command: `node "$SOME_OTHER_DIR/.claude/hooks/other.js"`, on_incomplete: "deny" },
              ],
            },
          ],
        },
      },
    },
    settings: settingsOf([".claude/hooks/ok.js"]),
    files: { ".claude/hooks/ok.js": "// row\n", ...supplementStubs },
  });
  writeManifest(root, MANIFEST, [".claude/hooks/ok.js", REGISTRY_REL, ...SUPPLEMENT]);
  const r = run(root);
  check(
    "red/unparsable-row-command->non-zero",
    r.status === 1 && r.stderr.includes("row-command-unparsable"),
    `expected rc 1 naming row-command-unparsable, got rc ${r.status}:\n${r.stderr.slice(0, 400)}`,
  );
}

// ---------------------------------------------------------------------------------
// Pair 5 — an EMPTY registry is UNRUNNABLE (exit 2), never a clean pass.
// ---------------------------------------------------------------------------------
{
  const root = makeTree("empty-registry", {
    registry: { schema: 1, events: {} },
    settings: settingsOf([]),
    files: { ...supplementStubs },
  });
  writeManifest(root, MANIFEST, [REGISTRY_REL, ...SUPPLEMENT]);
  const r = run(root);
  check(
    "red/empty-registry->exit-2-not-a-pass",
    r.status === 2 && /ZERO rows/.test(r.stderr),
    `expected rc 2 naming the zero-row registry, got rc ${r.status}:\n${r.stderr.slice(0, 300)}`,
  );
  check("red/empty-registry->never-CLEAN", !r.stdout.includes("CLEAN"), "an unreadable-corpus run printed CLEAN");
}

// ---------------------------------------------------------------------------------
// Pair 6 — the registry itself: a package with rows to read and nothing to read them from.
// ---------------------------------------------------------------------------------
{
  const root = makeTree("registry-unpackaged", {
    registry: registryOf([".claude/hooks/ok.js"]),
    settings: settingsOf([".claude/hooks/ok.js"]),
    files: { ".claude/hooks/ok.js": "// row\n", ...supplementStubs },
  });
  writeManifest(root, MANIFEST, [".claude/hooks/ok.js", ...SUPPLEMENT]); // registry deliberately absent
  const r = run(root);
  check(
    "red/registry-absent-from-package->non-zero",
    r.status === 1 && r.stderr.includes("registry-absent-from-package"),
    `expected rc 1 naming registry-absent-from-package, got rc ${r.status}:\n${r.stderr.slice(0, 400)}`,
  );
}

// ---------------------------------------------------------------------------------
// Pair 7 — THE FENCE, the direction a completeness check alone never tests: a file the
// registry withholds must not be IN the bundle.
// ---------------------------------------------------------------------------------
{
  const loomOnlyFile = ".claude/hooks/withheld-row.js";
  const root = makeTree("loom-only-in-package", {
    registry: registryOf([".claude/hooks/ok.js", loomOnlyFile], { loomOnly: ["withheld-row.js"] }),
    settings: settingsOf([".claude/hooks/ok.js"]),
    files: { ".claude/hooks/ok.js": "// row\n", [loomOnlyFile]: "// withheld\n", ...supplementStubs },
  });
  writeManifest(root, MANIFEST, [".claude/hooks/ok.js", REGISTRY_REL, ...SUPPLEMENT]); // withheld file absent ⇒ clean
  const clean = run(root);
  check("control/withheld-row-not-packaged->exit-0", clean.status === 0, `expected rc 0, got ${clean.status}:\n${clean.stderr.slice(0, 400)}`);
  writeManifest(root, MANIFEST, [".claude/hooks/ok.js", loomOnlyFile, REGISTRY_REL, ...SUPPLEMENT]); // now shipped ⇒ red
  const r = run(root);
  check(
    "red/withheld-row-in-package->non-zero",
    r.status === 1 && r.stderr.includes("loom-only-file-in-package") && r.stderr.includes("withheld-row.js"),
    `expected rc 1 naming loom-only-file-in-package + withheld-row.js, got rc ${r.status}:\n${r.stderr.slice(0, 400)}`,
  );
}

// ---------------------------------------------------------------------------------
// Pair 8 — staleness is REPORTED by default and FATAL under --strict-hashes. Same tree,
// same bytes, one flag: the two verdicts must differ, or the flag does nothing.
// ---------------------------------------------------------------------------------
{
  const root = makeTree("stale-hash", {
    registry: registryOf([".claude/hooks/ok.js"]),
    settings: settingsOf([".claude/hooks/ok.js"]),
    files: { ".claude/hooks/ok.js": "// row\n", ...supplementStubs },
  });
  const abs = writeManifest(root, MANIFEST, [".claude/hooks/ok.js", REGISTRY_REL, ...SUPPLEMENT]);
  const doc = JSON.parse(fs.readFileSync(abs, "utf8"));
  doc.files.find((f) => f.path === ".claude/hooks/ok.js").sha256 = "0".repeat(64);
  fs.writeFileSync(abs, JSON.stringify(doc, null, 2) + "\n");
  const lenient = run(root);
  const strict = run(root, ["--strict-hashes"]);
  check(
    "red/stale-hash-reported-by-default",
    lenient.status === 0 && lenient.stdout.includes("package-hash-stale"),
    `expected rc 0 carrying the package-hash-stale note, got rc ${lenient.status}`,
  );
  check(
    "red/stale-hash-fatal-under-strict-hashes",
    strict.status === 1 && strict.stderr.includes("package-hash-stale"),
    `expected rc 1 naming package-hash-stale under --strict-hashes, got rc ${strict.status}`,
  );
  check(
    "bipolar/the-flag-is-what-changed-the-verdict",
    lenient.status !== strict.status,
    "the two runs returned the same status, so --strict-hashes is inert",
  );
}

// ---------------------------------------------------------------------------------
// Pair 9 — a DECLARED member that is not on disk. This is the retired `add()`'s silent
// loss one layer up: the old generator returned without a word when a listed path did
// not exist, so a package could lose a file with every gate green. The declaration is
// still made here — only its file is gone — so the instrument must name it.
// ---------------------------------------------------------------------------------
{
  const root = makeTree("declared-member-absent", {
    registry: registryOf([".claude/hooks/ok.js"]),
    settings: settingsOf([".claude/hooks/ok.js"]),
    files: { ".claude/hooks/ok.js": "// row\n" }, // NO supplement stubs: the declaration stands, its files do not
  });
  writeManifest(root, MANIFEST, [".claude/hooks/ok.js", REGISTRY_REL]);
  const r = run(root);
  check(
    "red/declared-member-missing-on-disk->non-zero",
    r.status === 1 && r.stderr.includes("expected-file-missing-on-disk") && r.stderr.includes(SUPPLEMENT[0]),
    `expected rc 1 naming expected-file-missing-on-disk + ${SUPPLEMENT[0]}, got rc ${r.status}:\n${r.stderr.slice(0, 400)}`,
  );
}

// ---------------------------------------------------------------------------------
// The harness's own negative control: `status` must be the PROCESS's, not a default.
// ---------------------------------------------------------------------------------
{
  const r = run(path.join(scratch, "does-not-exist"));
  check(
    "harness/a-missing-root-does-not-report-clean",
    r.status !== 0 || !r.stdout.includes("CLEAN"),
    "a root that does not exist produced a clean verdict — the rc is not the process's",
  );
  check("harness/spawn-failure-is-visible", r.status !== 0, `expected a non-zero rc for a bad root, got ${r.status}`);
}

// ---------------------------------------------------------------------------------
// The integration leg: the REAL tree, through the REAL registry and the REAL manifest.
// A SKIP here is named rather than counted as a pass — an unrun case and a passing one
// must be distinguishable, which is the whole discipline this suite exists to hold.
// ---------------------------------------------------------------------------------
{
  const realManifest = path.join(ROOT, "workspaces/legacy-adapter-20261007/PACKAGE-MANIFEST.json");
  if (!fs.existsSync(realManifest)) {
    process.stdout.write("  SKIP  real-tree/complete-package (no PACKAGE-MANIFEST.json in this tree)\n");
  } else {
    const r = run(ROOT, [], { defaultManifest: true });
    check(
      "real-tree/complete-package->exit-0",
      r.status === 0 && r.stdout.includes("CLEAN"),
      `the real tree's package does not cover the real registry (rc ${r.status}):\n${r.stderr.slice(0, 600)}`,
    );
    const counts = /(\d+) registry row\(s\)/.exec(r.stdout);
    check(
      "real-tree/the-registry-is-not-empty",
      !!counts && Number(counts[1]) > 50,
      `the real registry parsed to ${counts ? counts[1] : "no"} rows — a green over an empty denominator is not a green`,
    );
  }
}

// ---------------------------------------------------------------------------------
// Anti-vacuity: this suite's floor is its own case count, and every case above had to
// have spawned a process. A suite that silently stopped spawning would report 0 FAIL
// exactly like a clean one.
// ---------------------------------------------------------------------------------
const spawned = passed + failed;
check("suite/case-count-is-non-degenerate", spawned >= 18, `only ${spawned} case(s) executed`);

fs.rmSync(scratch, { recursive: true, force: true });
process.stdout.write(`\nmanifest-registry-closure fixtures: ${passed}/${passed + failed} passed\n`);
process.exit(failed === 0 ? 0 : 1);
