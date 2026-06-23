#!/usr/bin/env node
/**
 * Unit + integration tests for .claude/bin/coc-run.mjs (coc-universal W3).
 *
 * Run: node --test .claude/bin/coc-run.test.mjs
 *
 * Per probe-driven-verification.md MUST-3: every assertion is STRUCTURAL
 * (string equality, byte-equality, file existence, exit code, throw) — not
 * lexical regex against assistant prose. The pure exported functions are
 * unit-tested with synthetic records; the run() orchestrator is
 * integration-tested against a hand-built `.coc/` fixture with a CORRECT
 * COC.lock, asserting the contract-09b L1 invariants + the W3 wave-plan
 * invariants (zero-repo-files, applies_to filtering, integrity fail-loud,
 * deterministic L1 flatten, per-CLI config-home wiring).
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const COC_RUN = path.join(path.dirname(fileURLToPath(import.meta.url)), "coc-run.mjs");

import {
  resolveSurface,
  parseArtifact,
  scalarField,
  listField,
  splitFlowItems,
  verifyLock,
  loadCocSet,
  filterForSurface,
  translateL1,
  materializeEphemeral,
  reclaim,
  buildSpawn,
  parseArgs,
  sha256Hex,
  SURFACES,
  KINDS,
  run,
} from "./coc-run.mjs";

// ──────────────────────────────────────────────────────────────────
// Fixture builder — a minimal `.coc/` tree with a CORRECT COC.lock.
// ──────────────────────────────────────────────────────────────────
function fm(fields) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    if (Array.isArray(v)) lines.push(`${k}: [${v.map((x) => `"${x}"`).join(", ")}]`);
    else lines.push(`${k}: "${v}"`);
  }
  lines.push("---");
  return lines.join("\n");
}

function artifact(fields, body) {
  return `${fm(fields)}\n\n${body}\n`;
}

// Build a `.coc/` set under a fresh tmp dir; return the .coc dir path.
function buildFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coc-fixture-"));
  const cocDir = path.join(root, ".coc");
  for (const k of KINDS) fs.mkdirSync(path.join(cocDir, k), { recursive: true });

  const files = {
    "COC.md": "---\ncoc.version: 1.0.0\n---\n\n# COC primer\n",
    "rules/ZERO.md": artifact({ id: "ZERO" }, "Universal rule body."),
    "rules/CC-ONLY.md": artifact(
      { id: "CC-ONLY", paths: [".claude/agents/**"], applies_to: ["claude-code"] },
      "CC-only, path-scoped rule body.",
    ),
    "rules/SCOPED.md": artifact({ id: "SCOPED", paths: ["packages/**"] }, "Scoped rule body."),
    "agents/REVIEWER.md": artifact(
      { id: "REVIEWER", name: "reviewer", description: "Quality reviewer." },
      "Reviewer agent body.",
    ),
    "skills/TESTING.md": artifact(
      { id: "TESTING", applies_to: ["codex"], name: "testing", description: "Test strategies." },
      "Testing skill body.",
    ),
    "commands/CODIFY.md": artifact(
      { id: "CODIFY", name: "codify", description: "Codify phase." },
      "Codify command body.",
    ),
  };

  // Write artifact files first, then compute the lock over them.
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(cocDir, rel), content);
  }
  const lockFiles = Object.keys(files)
    .sort()
    .map((rel) => ({ path: rel, sha256: sha256Hex(fs.readFileSync(path.join(cocDir, rel))) }));
  fs.writeFileSync(
    path.join(cocDir, "COC.lock"),
    JSON.stringify({ schema_version: 1, files: lockFiles }, null, 2),
  );
  return { root, cocDir };
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

// Capture process.stdout/stderr writes during fn().
function capture(fn) {
  const out = [];
  const err = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s) => (out.push(String(s)), true);
  process.stderr.write = (s) => (err.push(String(s)), true);
  let rv;
  try {
    rv = fn();
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
  return { rv, out: out.join(""), err: err.join("") };
}

// ──────────────────────────────────────────────────────────────────
// resolveSurface
// ──────────────────────────────────────────────────────────────────
test("resolveSurface: aliases map to the canonical surface key", () => {
  assert.equal(resolveSurface("cc"), "cc");
  assert.equal(resolveSurface("claude"), "cc");
  assert.equal(resolveSurface("claude-code"), "cc");
  assert.equal(resolveSurface("CODEX"), "codex");
  assert.equal(resolveSurface("gemini"), "gemini");
});

test("resolveSurface: unknown / missing throws usage", () => {
  assert.throws(() => resolveSurface("vscode"), /unknown --cli/);
  assert.throws(() => resolveSurface(null), /missing --cli/);
});

// ──────────────────────────────────────────────────────────────────
// Frontmatter parsing
// ──────────────────────────────────────────────────────────────────
test("parseArtifact: extracts id/name/description/applies_to/paths + body", () => {
  const src = artifact(
    { id: "REVIEWER", name: "reviewer", description: "Quality reviewer.", applies_to: ["codex", "gemini"] },
    "Body line one.\nBody line two.",
  );
  const { fields, body } = parseArtifact(src, "agents/REVIEWER.md");
  assert.equal(fields.id, "REVIEWER");
  assert.equal(fields.name, "reviewer");
  assert.equal(fields.description, "Quality reviewer.");
  assert.deepEqual(fields.appliesTo, ["codex", "gemini"]);
  assert.equal(fields.paths, null);
  assert.equal(body.trim(), "Body line one.\nBody line two.");
});

test("parseArtifact: throws on missing fence and missing id", () => {
  assert.throws(() => parseArtifact("no frontmatter here", "x"), /missing leading/);
  assert.throws(() => parseArtifact("---\nname: x\n---\nbody", "x"), /required 'id'/);
});

test("scalarField: unquotes and honors emit-coc's escaping", () => {
  assert.equal(scalarField('id: "ZERO"', "id"), "ZERO");
  assert.equal(scalarField('description: "a \\"quote\\" in it"', "description"), 'a "quote" in it');
  assert.equal(scalarField("name: bare", "name"), "bare");
  assert.equal(scalarField("other: x", "id"), null);
});

test("scalarField: does NOT match an indented (nested) key", () => {
  // a `  command:` under `hooks:` must not be read as a top-level field
  assert.equal(scalarField("hooks:\n  command: x", "command"), null);
});

test("listField + splitFlowItems: flow sequence with quoted comma", () => {
  assert.deepEqual(listField('paths: ["a", "b,c"]', "paths"), ["a", "b,c"]);
  assert.deepEqual(splitFlowItems('"a", "b,c", d'), ["a", "b,c", "d"]);
  assert.equal(listField("id: x", "paths"), null);
});

// ──────────────────────────────────────────────────────────────────
// verifyLock — integrity fail-loud (zero-tolerance Rule 3)
// ──────────────────────────────────────────────────────────────────
test("verifyLock: passes on an intact set", () => {
  const { root, cocDir } = buildFixture();
  try {
    assert.doesNotThrow(() => verifyLock(cocDir));
  } finally {
    rmrf(root);
  }
});

test("verifyLock: throws on a tampered file (hash mismatch)", () => {
  const { root, cocDir } = buildFixture();
  try {
    fs.appendFileSync(path.join(cocDir, "rules/ZERO.md"), "tampered");
    assert.throws(() => verifyLock(cocDir), /hash mismatch/);
  } finally {
    rmrf(root);
  }
});

test("verifyLock: throws on a listed-but-absent file", () => {
  const { root, cocDir } = buildFixture();
  try {
    fs.rmSync(path.join(cocDir, "rules/ZERO.md"));
    assert.throws(() => verifyLock(cocDir), /absent from/);
  } finally {
    rmrf(root);
  }
});

test("verifyLock: throws on a present-but-unlisted file", () => {
  const { root, cocDir } = buildFixture();
  try {
    fs.writeFileSync(path.join(cocDir, "rules/SNEAKED.md"), artifact({ id: "SNEAKED" }, "x"));
    assert.throws(() => verifyLock(cocDir), /NOT listed in COC.lock/);
  } finally {
    rmrf(root);
  }
});

test("verifyLock: throws when COC.lock is missing", () => {
  const { root, cocDir } = buildFixture();
  try {
    fs.rmSync(path.join(cocDir, "COC.lock"));
    assert.throws(() => verifyLock(cocDir), /COC\.lock not found/);
  } finally {
    rmrf(root);
  }
});

// ──────────────────────────────────────────────────────────────────
// loadCocSet
// ──────────────────────────────────────────────────────────────────
test("loadCocSet: reads coc.version + sorted records across kinds", () => {
  const { root, cocDir } = buildFixture();
  try {
    const { cocVersion, records } = loadCocSet(cocDir);
    assert.equal(cocVersion, "1.0.0");
    assert.deepEqual(
      records.map((r) => `${r.kind}/${r.id}`),
      ["rules/CC-ONLY", "rules/SCOPED", "rules/ZERO", "agents/REVIEWER", "skills/TESTING", "commands/CODIFY"],
    );
  } finally {
    rmrf(root);
  }
});

test("loadCocSet: throws when .coc/ is absent", () => {
  assert.throws(() => loadCocSet(path.join(os.tmpdir(), "nope-" + Date.now())), /no \.coc\/ directory/);
});

// ──────────────────────────────────────────────────────────────────
// filterForSurface (contract §6 applies_to)
// ──────────────────────────────────────────────────────────────────
test("filterForSurface: universal everywhere; allowlist gates per surface", () => {
  const { root, cocDir } = buildFixture();
  try {
    const { records } = loadCocSet(cocDir);
    const cc = filterForSurface(records, "claude-code").map((r) => r.id);
    const codex = filterForSurface(records, "codex").map((r) => r.id);
    // CC: TESTING (codex-only) excluded; CC-ONLY included.
    assert.deepEqual(cc.sort(), ["CC-ONLY", "CODIFY", "REVIEWER", "SCOPED", "ZERO"]);
    // Codex: CC-ONLY excluded; TESTING included.
    assert.deepEqual(codex.sort(), ["CODIFY", "REVIEWER", "SCOPED", "TESTING", "ZERO"]);
  } finally {
    rmrf(root);
  }
});

test("filterForSurface: unknown surface token is excluded, never throws", () => {
  const recs = [
    { kind: "rules", id: "U", fields: { appliesTo: null } },
    { kind: "rules", id: "G", fields: { appliesTo: ["gemini"] } },
  ];
  const got = filterForSurface(recs, "future-cli").map((r) => r.id);
  assert.deepEqual(got, ["U"]); // universal kept; gemini-only excluded; no throw
});

// ──────────────────────────────────────────────────────────────────
// translateL1 — determinism + framing + empty-kind omission
// ──────────────────────────────────────────────────────────────────
test("translateL1: byte-identical across runs (determinism, contract §9)", () => {
  const { root, cocDir } = buildFixture();
  try {
    const { cocVersion, records } = loadCocSet(cocDir);
    const f = filterForSurface(records, "claude-code");
    const a = translateL1(f, { surfaceToken: "claude-code", cocVersion });
    const b = translateL1(f, { surfaceToken: "claude-code", cocVersion });
    assert.equal(a, b);
    assert.equal(a.endsWith("\n"), true);
    assert.equal(a.includes("\r"), false); // LF-only
  } finally {
    rmrf(root);
  }
});

test("translateL1: sections present, path-scope annotated, empty kind omitted", () => {
  const { root, cocDir } = buildFixture();
  try {
    const { cocVersion, records } = loadCocSet(cocDir);
    const f = filterForSurface(records, "claude-code"); // skills empty (TESTING is codex-only)
    const blob = translateL1(f, { surfaceToken: "claude-code", cocVersion });
    assert.ok(blob.includes("## Rules"));
    assert.ok(blob.includes("### Rule: ZERO"));
    assert.ok(blob.includes("### Rule: SCOPED — applies to paths: packages/**"));
    assert.ok(blob.includes("### Agent: reviewer (REVIEWER)"));
    assert.ok(blob.includes("_Quality reviewer._"));
    assert.ok(blob.includes("### Command: codify (CODIFY)"));
    assert.ok(blob.includes("surface=claude-code"));
    assert.ok(blob.includes("coc.version=1.0.0"));
    // skills kind has zero applicable artifacts for cc → heading omitted
    assert.equal(blob.includes("## Skills"), false);
    // body content carried verbatim
    assert.ok(blob.includes("Reviewer agent body."));
  } finally {
    rmrf(root);
  }
});

test("translateL1: a universal-paths rule gets NO scope annotation", () => {
  const recs = [{ kind: "rules", id: "U", fields: { paths: ["**/*"], appliesTo: null }, body: "b" }];
  const blob = translateL1(recs, { surfaceToken: "codex", cocVersion: "1.0.0" });
  assert.ok(blob.includes("### Rule: U\n"));
  assert.equal(blob.includes("applies to paths"), false);
});

test("translateL1: canonical single-blank framing — a leading-whitespace body does NOT stack blanks", () => {
  // emit-coc bodies arrive as "\n<content>" (producer writes `<fm>\n\n<body>`);
  // the body must be trimmed at BOTH ends so the heading→body gap is ONE blank.
  const recs = [{ kind: "rules", id: "LEAD", fields: { paths: null, appliesTo: null }, body: "\n\n\n# Heading\nbody" }];
  const blob = translateL1(recs, { surfaceToken: "cc", cocVersion: "1.0.0" });
  assert.ok(blob.includes("### Rule: LEAD\n\n# Heading\nbody")); // exactly one blank
  assert.equal(blob.includes("### Rule: LEAD\n\n\n"), false); // no double blank
});

// ──────────────────────────────────────────────────────────────────
// materializeEphemeral — zero-repo-files + cleanup (contract §0)
// ──────────────────────────────────────────────────────────────────
test("materializeEphemeral: writes the inject file under os.tmpdir, never the repo", () => {
  const { dir, file } = materializeEphemeral("BLOB", "cc");
  try {
    assert.ok(dir.startsWith(os.tmpdir()));
    assert.equal(false, dir.startsWith(process.cwd()));
    assert.equal(path.basename(file), SURFACES.cc.injectFile); // CLAUDE.md
    assert.equal(fs.readFileSync(file, "utf8"), "BLOB");
  } finally {
    reclaim(dir);
  }
  assert.equal(fs.existsSync(dir), false); // reclaim removes it
});

test("materializeEphemeral: per-surface inject filename", () => {
  for (const [key, s] of Object.entries(SURFACES)) {
    const { dir, file } = materializeEphemeral("x", key);
    assert.equal(path.basename(file), s.injectFile);
    reclaim(dir);
  }
});

// ──────────────────────────────────────────────────────────────────
// buildSpawn — config-home env wiring (contract §5)
// ──────────────────────────────────────────────────────────────────
test("buildSpawn: injects the surface config-home env at the ephemeral dir", () => {
  const plan = buildSpawn("cc", "/tmp/eph-X", { bin: null, passthrough: ["--foo", "bar"] });
  assert.equal(plan.cmd, "claude");
  assert.deepEqual(plan.args, ["--foo", "bar"]);
  assert.equal(plan.env.CLAUDE_CONFIG_DIR, "/tmp/eph-X");
});

test("buildSpawn: --bin override + codex/gemini config-home vars", () => {
  assert.equal(buildSpawn("cc", "/d", { bin: "/opt/claude", passthrough: [] }).cmd, "/opt/claude");
  assert.equal(buildSpawn("codex", "/d", { bin: null, passthrough: [] }).env.CODEX_HOME, "/d");
  assert.equal(buildSpawn("gemini", "/d", { bin: null, passthrough: [] }).env.GEMINI_CLI_HOME, "/d");
});

// ──────────────────────────────────────────────────────────────────
// parseArgs
// ──────────────────────────────────────────────────────────────────
test("parseArgs: flags + passthrough after --", () => {
  const a = parseArgs(["--cli", "cc", "--coc", "/x/.coc", "--print", "--", "-p", "hi"]);
  assert.equal(a.cli, "cc");
  assert.equal(a.coc, "/x/.coc");
  assert.equal(a.print, true);
  assert.deepEqual(a.passthrough, ["-p", "hi"]);
});

test("parseArgs: unknown flag throws", () => {
  assert.throws(() => parseArgs(["--bogus"]), /unknown argument/);
});

// ──────────────────────────────────────────────────────────────────
// run() — orchestration exit codes + zero-files + spawn wiring
// ──────────────────────────────────────────────────────────────────
test("run --print: emits the L1 blob, exit 0, writes ZERO files anywhere", () => {
  const { root, cocDir } = buildFixture();
  const before = fs.readdirSync(cocDir).length;
  try {
    const { rv, out } = capture(() => run(["--cli", "cc", "--coc", cocDir, "--print"]));
    assert.equal(rv, 0);
    assert.ok(out.includes("### Rule: ZERO"));
    assert.ok(out.includes("surface=claude-code"));
    // zero-repo-files: nothing added under .coc/
    assert.equal(fs.readdirSync(cocDir).length, before);
  } finally {
    rmrf(root);
  }
});

test("run --dry-run: emits plan, exit 0, leaves NO persistent ephemeral dir", () => {
  const { root, cocDir } = buildFixture();
  try {
    const { rv, out } = capture(() => run(["--cli", "codex", "--coc", cocDir, "--dry-run"]));
    assert.equal(rv, 0);
    assert.ok(out.includes("surface:        codex"));
    assert.ok(out.includes("config-home env:CODEX_HOME="));
    // The inject path printed must no longer exist (reclaimed in finally).
    const m = out.match(/inject file:\s+(\S+)/);
    assert.ok(m);
    assert.equal(fs.existsSync(m[1]), false);
  } finally {
    rmrf(root);
  }
});

test("run: unknown --cli → exit 2", () => {
  const { rv } = capture(() => run(["--cli", "vscode"]));
  assert.equal(rv, 2);
});

test("run: missing .coc/ → exit 1 (CocError)", () => {
  const miss = path.join(os.tmpdir(), "absent-" + Date.now(), ".coc");
  const { rv, err } = capture(() => run(["--cli", "cc", "--coc", miss]));
  assert.equal(rv, 1);
  assert.ok(err.includes("coc-run:"));
});

test("run: tampered .coc/ → exit 1 before any spawn (integrity gate)", () => {
  const { root, cocDir } = buildFixture();
  try {
    fs.appendFileSync(path.join(cocDir, "rules/ZERO.md"), "tampered");
    let spawned = false;
    const { rv } = capture(() =>
      run(["--cli", "cc", "--coc", cocDir], { spawn: () => ((spawned = true), { status: 0 }) }),
    );
    assert.equal(rv, 1);
    assert.equal(spawned, false); // never reached spawn
  } finally {
    rmrf(root);
  }
});

test("run spawn path: materializes inject file, wires env, passes exit code, reclaims", () => {
  const { root, cocDir } = buildFixture();
  try {
    let capturedEnvDir = null;
    let injectExistedAtSpawn = false;
    let injectContent = null;
    const stub = (cmd, args, opts) => {
      capturedEnvDir = opts.env.CLAUDE_CONFIG_DIR;
      const f = path.join(capturedEnvDir, SURFACES.cc.injectFile);
      injectExistedAtSpawn = fs.existsSync(f);
      injectContent = injectExistedAtSpawn ? fs.readFileSync(f, "utf8") : null;
      return { status: 7 }; // CLI exit code to be passed through
    };
    const { rv } = capture(() => run(["--cli", "cc", "--coc", cocDir], { spawn: stub }));
    assert.equal(rv, 7); // exit-code passthrough
    assert.ok(capturedEnvDir && capturedEnvDir.startsWith(os.tmpdir()));
    assert.equal(injectExistedAtSpawn, true); // injected BEFORE spawn
    assert.ok(injectContent.includes("### Rule: ZERO")); // the L1 surface
    assert.equal(fs.existsSync(capturedEnvDir), false); // reclaimed after spawn
  } finally {
    rmrf(root);
  }
});

// Regression (user-flow walk 2026-06-19): --print piped to a reader MUST NOT
// truncate. main() formerly called process.exit() right after the async
// stdout.write(blob); for a blob exceeding the ~64KB pipe buffer the undrained
// tail was dropped — silently corrupting the §10.2 byte-parity surface. This
// spawns the launcher as a REAL subprocess (stdout is a pipe, reproducing the
// bug) with output > 64KB and asserts the LAST-emitted artifact survives.
test("run --print (subprocess pipe): large output is NOT truncated", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coc-big-"));
  const cocDir = path.join(root, ".coc");
  for (const k of KINDS) fs.mkdirSync(path.join(cocDir, k), { recursive: true });
  const SENTINEL = "ZZZ-TAIL-SENTINEL-7f3a";
  const bigBody = ("padding line to exceed the pipe buffer.\n".repeat(4000)); // ~160KB
  const files = {
    "COC.md": "---\ncoc.version: 1.0.0\n---\n\n# primer\n",
    "rules/BIG.md": artifact({ id: "BIG" }, bigBody),
    // commands sort last in kind order → ZZLAST is the final emitted artifact.
    "commands/ZZLAST.md": artifact({ id: "ZZLAST", name: "zzlast" }, `tail body ${SENTINEL}`),
  };
  for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(cocDir, rel), content);
  const lockFiles = Object.keys(files)
    .sort()
    .map((rel) => ({ path: rel, sha256: sha256Hex(fs.readFileSync(path.join(cocDir, rel))) }));
  fs.writeFileSync(path.join(cocDir, "COC.lock"), JSON.stringify({ schema_version: 1, files: lockFiles }, null, 2));

  try {
    const res = spawnSync(process.execPath, [COC_RUN, "--cli", "cc", "--coc", cocDir, "--print"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(res.stdout.length > 64 * 1024, `output ${res.stdout.length}B should exceed the pipe buffer`);
    assert.ok(res.stdout.includes(SENTINEL), "the final artifact's tail must survive the pipe (no truncation)");
    assert.ok(res.stdout.includes("### Command: zzlast (ZZLAST)"));
  } finally {
    rmrf(root);
  }
});

test("run spawn path: ENOENT binary → exit 127", () => {
  const { root, cocDir } = buildFixture();
  try {
    const stub = () => ({ error: Object.assign(new Error("nope"), { code: "ENOENT" }) });
    const { rv, err } = capture(() => run(["--cli", "cc", "--coc", cocDir, "--bin", "nope-bin"], { spawn: stub }));
    assert.equal(rv, 127);
    assert.ok(err.includes("not found on PATH"));
  } finally {
    rmrf(root);
  }
});

// Round-3 redteam (security MED): a signal-killed child (status:null) must NOT
// be reported as exit 0 — that would mask a crashed CLI as success to a
// coc-eval / byte-parity driver (zero-tolerance Rule 3).
test("run spawn path: a signal-killed child maps to 128+signal, never 0", () => {
  const { root, cocDir } = buildFixture();
  try {
    const segv = () => ({ status: null, signal: "SIGSEGV" });
    const { rv } = capture(() => run(["--cli", "cc", "--coc", cocDir], { spawn: segv }));
    assert.equal(rv, 128 + os.constants.signals.SIGSEGV); // 139, NOT 0
    assert.notEqual(rv, 0);
    // a clean status:0 child still returns 0
    const { rv: ok } = capture(() => run(["--cli", "cc", "--coc", cocDir], { spawn: () => ({ status: 0 }) }));
    assert.equal(ok, 0);
  } finally {
    rmrf(root);
  }
});

// ──────────────────────────────────────────────────────────────────
// Security hardening regressions (Round-1 redteam: HIGH symlink-bypass,
// MED hostile-lock traversal). emit-coc NEVER emits symlinks; any symlink in a
// .coc/ set is tampering and MUST be refused across the entire read path.
// ──────────────────────────────────────────────────────────────────
test("security: an UNLISTED symlinked artifact is refused, never injected (integrity bypass closed)", () => {
  const { root, cocDir } = buildFixture();
  try {
    fs.writeFileSync(path.join(root, "payload.md"), artifact({ id: "EVIL" }, "INJECTED-PAYLOAD-must-not-appear"));
    fs.symlinkSync(path.join(root, "payload.md"), path.join(cocDir, "rules", "EVIL.md")); // NOT in COC.lock
    let spawned = false;
    const { rv, err } = capture(() =>
      run(["--cli", "cc", "--coc", cocDir], { spawn: () => ((spawned = true), { status: 0 }) }),
    );
    assert.equal(rv, 1);
    assert.equal(spawned, false); // never reached spawn
    assert.ok(/symlink/i.test(err), "the failure must name the symlink");
  } finally {
    rmrf(root);
  }
});

test("security: a LISTED symlinked artifact (hash-consistent hostile lock) is still refused (O_NOFOLLOW)", () => {
  const { root, cocDir } = buildFixture();
  try {
    const payload = artifact({ id: "EVIL" }, "INJECTED-PAYLOAD");
    fs.writeFileSync(path.join(root, "payload.md"), payload);
    fs.symlinkSync(path.join(root, "payload.md"), path.join(cocDir, "rules", "EVIL.md"));
    const lock = JSON.parse(fs.readFileSync(path.join(cocDir, "COC.lock"), "utf8"));
    lock.files.push({ path: "rules/EVIL.md", sha256: sha256Hex(Buffer.from(payload)) }); // attacker supplies matching hash
    lock.files.sort((a, b) => (a.path < b.path ? -1 : 1));
    fs.writeFileSync(path.join(cocDir, "COC.lock"), JSON.stringify(lock, null, 2));
    assert.throws(() => verifyLock(cocDir), /symlink/i);
  } finally {
    rmrf(root);
  }
});

test("security: a symlinked artifact is refused even under --no-verify-lock (loadCocSet is independently strict)", () => {
  const { root, cocDir } = buildFixture();
  try {
    fs.writeFileSync(path.join(root, "payload.md"), artifact({ id: "EVIL" }, "X"));
    fs.symlinkSync(path.join(root, "payload.md"), path.join(cocDir, "rules", "EVIL.md"));
    assert.throws(() => loadCocSet(cocDir), /symlink/i);
    const { rv } = capture(() => run(["--cli", "cc", "--coc", cocDir, "--no-verify-lock", "--print"]));
    assert.equal(rv, 1);
  } finally {
    rmrf(root);
  }
});

test("security: a symlinked KIND dir is refused", () => {
  const { root, cocDir } = buildFixture();
  try {
    fs.rmSync(path.join(cocDir, "rules"), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, "elsewhere"));
    fs.writeFileSync(path.join(root, "elsewhere", "X.md"), artifact({ id: "X" }, "b"));
    fs.symlinkSync(path.join(root, "elsewhere"), path.join(cocDir, "rules"));
    assert.throws(() => loadCocSet(cocDir), /symlink/i);
  } finally {
    rmrf(root);
  }
});

test("security: hostile COC.lock with traversal / absolute entry.path is refused before any read", () => {
  for (const [bad, re] of [["../../../etc/hosts", /escapes|outside/i], ["/etc/hosts", /absolute/i], ["a\\b.md", /backslash/i]]) {
    const { root, cocDir } = buildFixture();
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(cocDir, "COC.lock"), "utf8"));
      lock.files.push({ path: bad, sha256: "0".repeat(64) });
      fs.writeFileSync(path.join(cocDir, "COC.lock"), JSON.stringify(lock, null, 2));
      assert.throws(() => verifyLock(cocDir), re, `entry.path ${JSON.stringify(bad)}`);
    } finally {
      rmrf(root);
    }
  }
});

test("security: a clean (symlink-free) .coc/ still verifies + loads (no false positive)", () => {
  const { root, cocDir } = buildFixture();
  try {
    assert.doesNotThrow(() => verifyLock(cocDir));
    assert.equal(loadCocSet(cocDir).records.length, 6);
  } finally {
    rmrf(root);
  }
});

// Regression (Round-1 reviewer MED): run() is exported and must not leak
// process exit/SIGINT/SIGTERM listeners across repeated in-process calls.
test("run spawn path: does NOT leak process listeners across repeated in-process calls", () => {
  const { root, cocDir } = buildFixture();
  try {
    const before = {
      exit: process.listenerCount("exit"),
      int: process.listenerCount("SIGINT"),
      term: process.listenerCount("SIGTERM"),
    };
    const stub = () => ({ status: 0 });
    for (let i = 0; i < 8; i++) capture(() => run(["--cli", "cc", "--coc", cocDir], { spawn: stub }));
    assert.equal(process.listenerCount("exit"), before.exit, "exit listeners leaked");
    assert.equal(process.listenerCount("SIGINT"), before.int, "SIGINT listeners leaked");
    assert.equal(process.listenerCount("SIGTERM"), before.term, "SIGTERM listeners leaked");
  } finally {
    rmrf(root);
  }
});

test("parseArgs: a value-taking flag followed by another flag fails loud (missing value)", () => {
  assert.throws(() => parseArgs(["--cli", "--print"]), /missing value for --cli/);
  assert.throws(() => parseArgs(["--coc", "--cli", "cc"]), /missing value for --coc/);
  assert.throws(() => parseArgs(["--bin"]), /missing value for --bin/);
});

// ──────────────────────────────────────────────────────────────────
// Round-2 redteam regressions: applies_to:[] universal, --print/--dry-run
// mutual exclusivity, symlinked COC.md, early-close-reader EPIPE.
// ──────────────────────────────────────────────────────────────────
test("filterForSurface: an empty applies_to [] is universal (contract §6 'empty=universal')", () => {
  const recs = [
    { kind: "rules", id: "EMPTY", fields: { appliesTo: [] } },
    { kind: "rules", id: "CCONLY", fields: { appliesTo: ["claude-code"] } },
  ];
  for (const surface of ["claude-code", "codex", "gemini"]) {
    assert.ok(
      filterForSurface(recs, surface).some((r) => r.id === "EMPTY"),
      `applies_to:[] must be delivered on ${surface}`,
    );
  }
  assert.equal(filterForSurface(recs, "codex").some((r) => r.id === "CCONLY"), false);
});

test("parseArgs: --print and --dry-run together fail loud (mutually exclusive)", () => {
  assert.throws(() => parseArgs(["--cli", "cc", "--print", "--dry-run"]), /mutually exclusive/);
});

test("security: a symlinked COC.md is refused (loadCocSet O_NOFOLLOW), even under --no-verify-lock", () => {
  const { root, cocDir } = buildFixture();
  try {
    fs.writeFileSync(path.join(root, "evil-cocmd.md"), "---\ncoc.version: 9.9.9 --><injected>\n---\n");
    fs.rmSync(path.join(cocDir, "COC.md"));
    fs.symlinkSync(path.join(root, "evil-cocmd.md"), path.join(cocDir, "COC.md"));
    assert.throws(() => loadCocSet(cocDir), /symlink/i);
    const { rv } = capture(() => run(["--cli", "cc", "--coc", cocDir, "--no-verify-lock", "--print"]));
    assert.equal(rv, 1);
  } finally {
    rmrf(root);
  }
});

test("translateL1: a `-->`-bearing cocVersion cannot break out of the header comment", () => {
  // sanitizeVersion runs in loadCocSet; verify the framing is safe even if a
  // crafted version reached translateL1 directly.
  const blob = translateL1([], { surfaceToken: "cc", cocVersion: "1.0.0 --><injected>" });
  const header = blob.split("\n")[0];
  assert.ok(header.startsWith("<!-- "), "header is an HTML comment");
  // the raw `-->` breakout token must not appear inside the version interpolation
  // (sanitizeVersion strips it upstream; translateL1's own header stays one comment)
  assert.equal(blob.split("-->").length <= 3, true); // at most the 2 legit header comment closers
});

test("run --print (early-close reader): exits cleanly with NO uncaught EPIPE crash", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coc-epipe-"));
  const cocDir = path.join(root, ".coc");
  for (const k of KINDS) fs.mkdirSync(path.join(cocDir, k), { recursive: true });
  const big = "padding to exceed the pipe buffer so the write is mid-flight.\n".repeat(5000); // ~300KB
  const files = {
    "COC.md": "---\ncoc.version: 1.0.0\n---\n\n# primer\n",
    "rules/BIG.md": artifact({ id: "BIG" }, big),
  };
  for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(cocDir, rel), content);
  const lockFiles = Object.keys(files)
    .sort()
    .map((rel) => ({ path: rel, sha256: sha256Hex(fs.readFileSync(path.join(cocDir, rel))) }));
  fs.writeFileSync(path.join(cocDir, "COC.lock"), JSON.stringify({ schema_version: 1, files: lockFiles }, null, 2));

  try {
    const stderr = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [COC_RUN, "--cli", "cc", "--coc", cocDir, "--print"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let err = "";
      let got = 0;
      child.stderr.on("data", (d) => (err += d));
      child.stdout.on("data", (chunk) => {
        got += chunk.length;
        if (got > 2000) child.stdout.destroy(); // reader closes the pipe early, mid-write
      });
      child.on("error", reject);
      child.on("close", () => resolve(err));
    });
    assert.equal(/EPIPE/.test(stderr), false, `early-close must not crash with EPIPE; stderr=${stderr.slice(0, 240)}`);
    assert.equal(/Unhandled 'error' event/.test(stderr), false);
  } finally {
    rmrf(root);
  }
});
