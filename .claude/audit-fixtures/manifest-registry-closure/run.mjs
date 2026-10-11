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
