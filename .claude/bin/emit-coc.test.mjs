#!/usr/bin/env node
/**
 * Unit + integration tests for .claude/bin/emit-coc.mjs (issue #392).
 *
 * Run: node --test .claude/bin/emit-coc.test.mjs
 *
 * Per probe-driven-verification.md MUST-3: every assertion here is STRUCTURAL
 * (string equality, regex-grammar conformance on EMITTED ids, JSON-schema
 * shape, byte-equality, file existence, exit/throw) — not lexical regex
 * against assistant prose. Pure exported functions are unit-tested with
 * synthetic inputs; the full pipeline is integration-tested against the real
 * loom .claude/ tree, asserting the spec-09 + issue-#392 invariants.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Is python3 + PyYAML available as a real-YAML-parser oracle? (probe-driven-
// verification.md Rule 3: structural subprocess verifier; honest skip otherwise.)
const PY_YAML = (() => {
  try {
    return spawnSync("python3", ["-c", "import yaml"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

import {
  emitCoc,
  deriveId,
  computeAppliesTo,
  buildFrontmatter,
  extractListField,
  extractTypedBlock,
  buildLock,
  buildCocMd,
  buildTree,
  atomicSwap,
  sha256Hex,
  COC_VERSION,
  TYPED_FIELDS,
  FILE_SIZE_WARN_BYTES,
  EMPTY_SHA256,
} from "./emit-coc.mjs";

const ID_RE = /^[A-Z][A-Z0-9-]{1,32}$/;

// ──────────────────────────────────────────────────────────────────
// deriveId — spec §9.2.1 grammar + basename==id.
// ──────────────────────────────────────────────────────────────────
test("deriveId: rule basename → uppercase-dash id", () => {
  assert.equal(deriveId("rules", "zero-tolerance"), "ZERO-TOLERANCE");
  assert.equal(deriveId("rules", "multi-operator-coordination"), "MULTI-OPERATOR-COORDINATION");
});

test("deriveId: digit-leading skill prepends kind sentinel S", () => {
  assert.equal(deriveId("skills", "01-core-sdk"), "S01-CORE-SDK");
  assert.equal(deriveId("skills", "34-kailash-ml"), "S34-KAILASH-ML");
});

test("deriveId: short names stay grammar-valid (len >= 2)", () => {
  assert.equal(deriveId("skills", "ai"), "AI");
  assert.equal(deriveId("commands", "db"), "DB");
});

test("deriveId: agents + commands map without sentinel (letter-leading)", () => {
  assert.equal(deriveId("agents", "dataflow-specialist"), "DATAFLOW-SPECIALIST");
  assert.equal(deriveId("commands", "i-audit"), "I-AUDIT");
});

test("deriveId: every derived id matches the spec §9.2.1 grammar", () => {
  for (const [k, n] of [
    ["rules", "build-repo-release-discipline"],
    ["skills", "15-enterprise-infrastructure"],
    ["agents", "gold-standards-validator"],
    ["commands", "sync-to-build"],
  ]) {
    assert.match(deriveId(k, n), ID_RE, `${k}/${n}`);
  }
});

test("deriveId: throws when the derived id exceeds the 33-char cap", () => {
  // 40-char source → 40-char id → violates ^[A-Z][A-Z0-9-]{1,32}$ (max 33).
  assert.throws(() => deriveId("rules", "a".repeat(40)), /violates/);
});

test("deriveId: throws on an unknown kind (KIND_SENTINEL guard)", () => {
  assert.throws(() => deriveId("guides", "01-foo"), /unknown artifact kind/);
});

// ──────────────────────────────────────────────────────────────────
// computeAppliesTo — spec §9.2.2 + §9.2.4.1.
// ──────────────────────────────────────────────────────────────────
test("computeAppliesTo: universal artifact → null (omit field)", () => {
  assert.equal(computeAppliesTo("rules/git.md", { codex: [], gemini: [] }), null);
});

test("computeAppliesTo: excluded from both codex+gemini → claude-code only", () => {
  const r = computeAppliesTo("rules/cc-artifacts.md", {
    codex: ["rules/cc-artifacts.md"],
    gemini: ["rules/cc-artifacts.md"],
  });
  assert.deepEqual(r, ["claude-code"]);
});

test("computeAppliesTo: excluded from gemini only → claude-code + codex", () => {
  const r = computeAppliesTo("agents/codex-architect.md", {
    codex: [],
    gemini: ["agents/codex-architect.md"],
  });
  assert.deepEqual(r, ["claude-code", "codex"]);
});

test("computeAppliesTo: excluded from codex only → claude-code + gemini", () => {
  const r = computeAppliesTo("agents/gemini-architect.md", {
    codex: ["agents/gemini-architect.md"],
    gemini: [],
  });
  assert.deepEqual(r, ["claude-code", "gemini"]);
});

// ──────────────────────────────────────────────────────────────────
// buildFrontmatter — strict YAML 1.2, controlled keys.
// ──────────────────────────────────────────────────────────────────
test("buildFrontmatter: id only (quoted)", () => {
  assert.equal(buildFrontmatter({ id: "ZERO-TOLERANCE" }), '---\nid: "ZERO-TOLERANCE"\n---');
});

test("buildFrontmatter: id + paths + applies_to (quoted flow sequences)", () => {
  const fm = buildFrontmatter({
    id: "CC-ARTIFACTS",
    paths: ["**/*.py"],
    appliesTo: ["claude-code"],
  });
  assert.equal(
    fm,
    '---\nid: "CC-ARTIFACTS"\npaths: ["**/*.py"]\napplies_to: ["claude-code"]\n---',
  );
});

test("buildFrontmatter: omits empty paths / applies_to", () => {
  const fm = buildFrontmatter({ id: "GIT", paths: [], appliesTo: null });
  assert.equal(fm, '---\nid: "GIT"\n---');
});

test("buildFrontmatter: YAML-1.1-coercible id is quoted (no bare NO/ON/NULL)", () => {
  // A hypothetical artifact named `no`/`on`/`null` derives to id NO/ON/NULL.
  // Quoting prevents 1.1-compat readers coercing the id to a bool/null.
  for (const id of ["NO", "ON", "OFF", "YES", "TRUE", "FALSE", "NULL"]) {
    assert.equal(buildFrontmatter({ id }), `---\nid: "${id}"\n---`);
  }
});

// ──────────────────────────────────────────────────────────────────
// extractListField — flow + block YAML list forms.
// ──────────────────────────────────────────────────────────────────
test("extractListField: flow form", () => {
  assert.deepEqual(extractListField('paths: ["a", "b"]', "paths"), ["a", "b"]);
});

test("extractListField: flow form — comma inside a quoted item is NOT a separator", () => {
  assert.deepEqual(extractListField('paths: ["a,b", "c"]', "paths"), ["a,b", "c"]);
});

test("extractListField: block form", () => {
  const raw = 'priority: 10\npaths:\n  - "**/*.py"\n  - "**/packages/**"\nscope: path-scoped';
  assert.deepEqual(extractListField(raw, "paths"), ["**/*.py", "**/packages/**"]);
});

test("extractListField: malformed block item THROWS (no silent truncation)", () => {
  const raw = "paths:\n  - a\n  -\n  - c\nscope: x"; // bare `-` empty item
  assert.throws(() => extractListField(raw, "paths"), /malformed YAML block-list/);
});

test("extractListField: a non-list key ends the block (does NOT throw)", () => {
  const raw = "paths:\n  - a\n  - b\nscope: path-scoped";
  assert.deepEqual(extractListField(raw, "paths"), ["a", "b"]);
});

test("extractListField: absent field → null", () => {
  assert.equal(extractListField("priority: 0\nscope: baseline", "paths"), null);
});

// ──────────────────────────────────────────────────────────────────
// extractTypedBlock — typed superset (contract §3.2), VERBATIM passthrough.
// ──────────────────────────────────────────────────────────────────
const AGENT_FM = [
  "name: cc-architect",
  "description: CC artifact architect. Use for auditing.",
  "tools: Read, Write, Edit, Grep, Glob, Bash, Task",
  "model: opus",
  "hooks:",
  "  PreToolUse:",
  "    - matcher: \"*\"",
  "      hooks:",
  "        - type: command",
  "          command: 'node x.js'",
  "          timeout: 5",
].join("\n");

test("extractTypedBlock: agent preserves the nested hooks: block verbatim", () => {
  const blk = extractTypedBlock(AGENT_FM, "agents");
  // All five fields present, in canonical TYPED_FIELDS order.
  assert.ok(blk.startsWith("name: cc-architect\ndescription: "), "name then description first");
  assert.match(blk, /\ntools: Read, Write, Edit, Grep, Glob, Bash, Task\n/);
  assert.match(blk, /\nmodel: opus\n/);
  // Nested block preserved EXACTLY (indentation + children intact).
  assert.match(blk, /hooks:\n {2}PreToolUse:\n {4}- matcher: "\*"\n {6}hooks:\n {8}- type: command\n {10}command: 'node x\.js'\n {10}timeout: 5$/);
});

test("extractTypedBlock: emits in canonical order regardless of source order", () => {
  const scrambled = ["model: opus", "description: d", "name: n"].join("\n");
  assert.equal(extractTypedBlock(scrambled, "agents"), "name: n\ndescription: d\nmodel: opus");
});

test("extractTypedBlock: absent optional fields are omitted (clean L1 degrade)", () => {
  const minimal = "name: foo\ndescription: bar";
  assert.equal(extractTypedBlock(minimal, "agents"), "name: foo\ndescription: bar");
});

test("extractTypedBlock: command carries name/description/argument-hint/model only", () => {
  const cmdFm = ["name: redteam", "description: d", "argument-hint: \"[target]\"", "extra: ignored"].join("\n");
  const blk = extractTypedBlock(cmdFm, "commands");
  assert.equal(blk, "name: redteam\ndescription: d\nargument-hint: \"[target]\"");
  assert.equal(blk.includes("extra"), false, "non-allowlisted key excluded");
});

test("extractTypedBlock: skill carries name + description only", () => {
  const skFm = "name: core-sdk\ndescription: d\ntools: Read"; // tools NOT in skill allowlist
  assert.equal(extractTypedBlock(skFm, "skills"), "name: core-sdk\ndescription: d");
});

test("extractTypedBlock: rules carry NO typed block (paths/applies_to are the strict block)", () => {
  assert.equal(extractTypedBlock("paths: [\"**/*.py\"]\nscope: path-scoped", "rules"), "");
});

test("extractTypedBlock: empty/absent rawFm → empty string", () => {
  assert.equal(extractTypedBlock("", "agents"), "");
  assert.equal(extractTypedBlock(null, "agents"), "");
});

test("extractTypedBlock: id/paths/applies_to never leak into a typed block", () => {
  // Even if a source FM carried these (it shouldn't for agents), they are not in
  // any kind's TYPED_FIELDS, so they cannot duplicate the strict block.
  const fm = "id: SHOULD-NOT-APPEAR\nname: n\napplies_to: [codex]\npaths: [x]";
  const blk = extractTypedBlock(fm, "agents");
  assert.equal(blk, "name: n");
});

test("extractTypedBlock: multi-line scalar continuation in an ALLOWLISTED field THROWS (no silent truncation)", () => {
  // A double-quoted scalar wrapping to column 0 — the silent-drop hazard
  // (R1 reviewer + analyst LOW). FAIL LOUD per zero-tolerance Rule 3.
  const fm = 'name: n\ndescription: "line one\nline two"\nmodel: m';
  assert.throws(() => extractTypedBlock(fm, "agents"), /multi-line/);
});

test("extractTypedBlock: multi-line value in a NON-allowlisted field is harmlessly skipped (no throw)", () => {
  // `examples` is in no kind's TYPED_FIELDS — its column-0 wrap never reaches an
  // emitted block, so it must NOT trip the loud guard.
  const fm = 'name: n\nexamples: "a\nb"\ndescription: d';
  assert.equal(extractTypedBlock(fm, "agents"), "name: n\ndescription: d");
});

test("extractTypedBlock: an INDENTED block scalar (description: |) is preserved, not thrown", () => {
  const fm = "name: n\ndescription: |\n  line one\n  line two\nmodel: m";
  const blk = extractTypedBlock(fm, "agents");
  assert.match(blk, /description: \|\n {2}line one\n {2}line two/);
  assert.match(blk, /\nmodel: m$/);
});

test("buildFrontmatter: typedBlock appended verbatim after the strict fields", () => {
  const fm = buildFrontmatter({
    id: "CC-ARCHITECT",
    appliesTo: ["claude-code"],
    typedBlock: "name: cc-architect\ndescription: d",
  });
  assert.equal(
    fm,
    '---\nid: "CC-ARCHITECT"\napplies_to: ["claude-code"]\nname: cc-architect\ndescription: d\n---',
  );
});

test("buildFrontmatter: empty typedBlock is a no-op (L1-floor artifact)", () => {
  assert.equal(buildFrontmatter({ id: "GIT", typedBlock: "" }), '---\nid: "GIT"\n---');
});

test("TYPED_FIELDS: rules carry none; id/paths/applies_to absent from every kind", () => {
  assert.deepEqual(TYPED_FIELDS.rules, []);
  for (const kind of Object.keys(TYPED_FIELDS)) {
    for (const strict of ["id", "paths", "applies_to"]) {
      assert.equal(TYPED_FIELDS[kind].includes(strict), false, `${kind} must not list strict field ${strict}`);
    }
  }
});

// ──────────────────────────────────────────────────────────────────
// buildLock — canonical JSON, sorted by path, deterministic.
// ──────────────────────────────────────────────────────────────────
test("buildLock: sorts by path lexicographically, schema_version 1", () => {
  const lock = buildLock([
    { path: "rules/B.md", sha256: "y" },
    { path: "COC.md", sha256: "z" },
    { path: "agents/A.md", sha256: "x" },
  ]);
  const obj = JSON.parse(lock);
  assert.equal(obj.schema_version, 1);
  assert.deepEqual(obj.files.map((f) => f.path), ["COC.md", "agents/A.md", "rules/B.md"]);
});

test("buildLock: no trailing newline (issue AC)", () => {
  const lock = buildLock([{ path: "COC.md", sha256: "z" }]);
  assert.equal(lock.endsWith("\n"), false);
  assert.equal(lock.endsWith("}"), true);
});

test("buildLock: deterministic — identical input → identical bytes", () => {
  const input = [{ path: "b", sha256: "1" }, { path: "a", sha256: "2" }];
  assert.equal(buildLock(input), buildLock([...input].reverse()));
});

// ──────────────────────────────────────────────────────────────────
// sha256Hex / EMPTY_SHA256.
// ──────────────────────────────────────────────────────────────────
test("sha256Hex: empty buffer matches the documented .gitkeep sentinel hash", () => {
  assert.equal(sha256Hex(Buffer.from("", "utf8")), EMPTY_SHA256);
});

test("buildCocMd: declares the coc.version envelope once", () => {
  const md = buildCocMd({ rules: 1, agents: 0, skills: 0, commands: 0 });
  assert.match(md, /^---\ncoc\.version: 1\.0\.0\n---/);
  assert.equal((md.match(/coc\.version:/g) || []).length, 1);
});

// ──────────────────────────────────────────────────────────────────
// buildTree — .gitkeep sentinel in EMPTY canonical subdirs (issue AC).
// Synthetic records (no REPO dependency) → empty kinds get .gitkeep.
// ──────────────────────────────────────────────────────────────────
test("buildTree: empty canonical subdirs get a zero-byte .gitkeep, hashed in lock", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coc-buildtree-"));
  try {
    const records = [
      { kind: "rules", id: "ALPHA", relInCoc: "rules/ALPHA.md", content: "---\nid: ALPHA\n---\n\nbody\n" },
    ];
    buildTree(tmp, records);
    // rules populated → no sentinel; the other three empty → sentinel present.
    assert.equal(fs.existsSync(path.join(tmp, "rules", ".gitkeep")), false);
    for (const d of ["agents", "skills", "commands"]) {
      const keep = path.join(tmp, d, ".gitkeep");
      assert.ok(fs.existsSync(keep), `${d}/.gitkeep missing`);
      assert.equal(fs.statSync(keep).size, 0, `${d}/.gitkeep not zero-byte`);
    }
    const lock = JSON.parse(fs.readFileSync(path.join(tmp, "COC.lock"), "utf8"));
    const paths = lock.files.map((f) => f.path);
    for (const d of ["agents", "skills", "commands"]) {
      assert.ok(paths.includes(`${d}/.gitkeep`), `${d}/.gitkeep absent from lock`);
    }
    // Sentinel hash is the empty-file sha256.
    const keepEntry = lock.files.find((f) => f.path === "agents/.gitkeep");
    assert.equal(keepEntry.sha256, EMPTY_SHA256);
    // COC.lock excludes itself.
    assert.equal(paths.includes("COC.lock"), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────
// deriveId collision precondition (spec §9.4.2) — distinct source names
// that normalize to the same id must be DETECTABLE (deriveId deterministic).
// ──────────────────────────────────────────────────────────────────
test("deriveId: distinct names normalizing to the same id collide deterministically", () => {
  // The collision GUARD in collectArtifacts relies on deriveId being a stable
  // many-to-one map. Prove two distinct source spellings → identical id.
  assert.equal(deriveId("rules", "foo-bar"), deriveId("rules", "foo.bar"));
  assert.equal(deriveId("rules", "foo-bar"), deriveId("rules", "foo_bar"));
  assert.equal(deriveId("rules", "foo-bar"), "FOO-BAR");
});

// ──────────────────────────────────────────────────────────────────
// atomicSwap — swap over an existing tree, leave no tmp/bak, refuse symlinks.
// ──────────────────────────────────────────────────────────────────
test("atomicSwap: replaces an existing .coc tree, no .bak/.tmp leftovers", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "coc-swap-"));
  try {
    const recA = [{ kind: "rules", id: "ALPHA", relInCoc: "rules/ALPHA.md", content: "A" }];
    const recB = [{ kind: "rules", id: "BETA", relInCoc: "rules/BETA.md", content: "B" }];
    // First emit.
    let tmp = path.join(out, ".coc.tmp.1");
    fs.mkdirSync(tmp);
    buildTree(tmp, recA);
    atomicSwap(path.join(out, ".coc"), tmp);
    assert.ok(fs.existsSync(path.join(out, ".coc", "rules", "ALPHA.md")));
    // Second emit swaps over the first.
    tmp = path.join(out, ".coc.tmp.2");
    fs.mkdirSync(tmp);
    buildTree(tmp, recB);
    atomicSwap(path.join(out, ".coc"), tmp);
    assert.ok(fs.existsSync(path.join(out, ".coc", "rules", "BETA.md")));
    assert.equal(fs.existsSync(path.join(out, ".coc", "rules", "ALPHA.md")), false);
    // No leftover tmp/bak siblings.
    const siblings = fs.readdirSync(out).filter((n) => n.startsWith(".coc.tmp") || n.startsWith(".coc.bak"));
    assert.deepEqual(siblings, []);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("atomicSwap: refuses a symlinked finalDir (symlink-redirect hardening)", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "coc-swap-sym-"));
  try {
    // Pre-plant a symlink at the final `.coc` path pointing at an external dir.
    const evil = fs.mkdtempSync(path.join(os.tmpdir(), "coc-evil-"));
    const finalDir = path.join(out, ".coc");
    fs.symlinkSync(evil, finalDir);
    const tmp = path.join(out, ".coc.tmp.9");
    fs.mkdirSync(tmp);
    buildTree(tmp, [{ kind: "rules", id: "ALPHA", relInCoc: "rules/ALPHA.md", content: "A" }]);
    assert.throws(() => atomicSwap(finalDir, tmp), /symlink/i);
    // The evil target was never written into.
    assert.equal(fs.existsSync(path.join(evil, "rules")), false);
    fs.rmSync(evil, { recursive: true, force: true });
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────
// Integration — emitCoc against the real loom .claude/ tree.
// ──────────────────────────────────────────────────────────────────
test("emitCoc[integration]: produces canonical shape + determinism + grammar", () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), "coc-int-a-"));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "coc-int-b-"));
  try {
    emitCoc({ outDir: a });
    emitCoc({ outDir: b });
    const cocA = path.join(a, ".coc");

    // Shape: COC.md + COC.lock + 4 canonical subdirs.
    for (const p of ["COC.md", "COC.lock", "rules", "agents", "skills", "commands"]) {
      assert.ok(fs.existsSync(path.join(cocA, p)), `missing ${p}`);
    }

    // coc.version envelope present in COC.md.
    assert.match(fs.readFileSync(path.join(cocA, "COC.md"), "utf8"), /coc\.version: 1\.0\.0/);

    // Every artifact id matches grammar AND basename == id.
    for (const kind of ["rules", "agents", "skills", "commands"]) {
      const dir = path.join(cocA, kind);
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md"))) {
        const base = f.replace(/\.md$/, "");
        assert.match(base, ID_RE, `${kind}/${f} basename not grammar-valid`);
        const fm = fs.readFileSync(path.join(dir, f), "utf8");
        const idLine = fm.match(/^id: (.+)$/m);
        assert.ok(idLine, `${kind}/${f} missing id`);
        assert.equal(idLine[1].replace(/^"|"$/g, ""), base, `${kind}/${f} basename != id`);
      }
    }

    // COC.lock: valid JSON, schema_version 1, sorted by codepoint, self-excluded.
    const lock = JSON.parse(fs.readFileSync(path.join(cocA, "COC.lock"), "utf8"));
    assert.equal(lock.schema_version, 1);
    const paths = lock.files.map((f) => f.path);
    const sorted = [...paths].sort();
    assert.deepEqual(paths, sorted, "COC.lock files not codepoint-sorted");
    assert.equal(paths.includes("COC.lock"), false);
    for (const f of lock.files) assert.match(f.sha256, /^[0-9a-f]{64}$/);

    // Determinism: COC.lock content identical across two independent emits.
    assert.equal(
      fs.readFileSync(path.join(cocA, "COC.lock"), "utf8"),
      fs.readFileSync(path.join(b, ".coc", "COC.lock"), "utf8"),
      "re-emit produced a different COC.lock",
    );
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test("emitCoc[integration]: oversize files are WARNed (not blocked, not truncated)", () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "coc-int-warn-"));
  try {
    const r = emitCoc({ outDir: t });
    // Contract: warnOversize is an array; every entry is a real >budget file
    // that was nevertheless EMITTED intact (never truncated).
    assert.ok(Array.isArray(r.warnOversize));
    for (const w of r.warnOversize) {
      assert.ok(w.bytes > FILE_SIZE_WARN_BYTES, `${w.relInCoc} listed but not oversize`);
      const onDisk = fs.statSync(path.join(t, ".coc", w.relInCoc)).size;
      assert.equal(onDisk, w.bytes, `${w.relInCoc} truncated — on-disk ${onDisk} != reported ${w.bytes}`);
    }
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test("emitCoc[integration]: COC.md/COC.lock/artifacts are UTF-8 no-BOM, LF-only", () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "coc-int-enc-"));
  try {
    emitCoc({ outDir: t });
    const coc = path.join(t, ".coc");
    const samples = [
      path.join(coc, "COC.md"),
      path.join(coc, "COC.lock"),
      path.join(coc, "rules", fs.readdirSync(path.join(coc, "rules"))[0]),
    ];
    for (const f of samples) {
      const buf = fs.readFileSync(f);
      assert.notEqual(buf[0], 0xef, `${f} starts with a UTF-8 BOM`); // EF BB BF
      assert.equal(buf.includes(0x0d), false, `${f} contains CR (not LF-only)`);
    }
    // COC.lock specifically: no trailing newline.
    const lock = fs.readFileSync(path.join(coc, "COC.lock"), "utf8");
    assert.equal(lock.endsWith("\n"), false);
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test(
  "emitCoc[integration]: every emitted frontmatter block parses as valid YAML (regression gate for verbatim passthrough)",
  { skip: PY_YAML ? false : "python3+PyYAML unavailable — real-parser YAML gate skipped (probe-driven Rule 3)" },
  () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), "coc-int-yaml-"));
    try {
      emitCoc({ outDir: t });
      const coc = path.join(t, ".coc");
      const blocks = [];
      for (const kind of ["rules", "agents", "skills", "commands"]) {
        for (const f of fs.readdirSync(path.join(coc, kind)).filter((x) => x.endsWith(".md"))) {
          const src = fs.readFileSync(path.join(coc, kind, f), "utf8");
          const m = src.match(/^---\n([\s\S]*?)\n---\n/);
          if (m) blocks.push({ rel: `${kind}/${f}`, fm: m[1] });
        }
      }
      // Authoritative oracle: a real YAML parser must load each block as a mapping.
      const pySrc = [
        "import sys, json, yaml",
        "bad = []",
        "for it in json.load(sys.stdin):",
        "    try:",
        "        d = yaml.safe_load(it['fm'])",
        "        assert isinstance(d, dict), 'not a mapping'",
        "    except Exception as e:",
        "        bad.append(it['rel'] + ': ' + str(e))",
        "print(json.dumps(bad))",
      ].join("\n");
      const res = spawnSync("python3", ["-c", pySrc], { input: JSON.stringify(blocks), encoding: "utf8" });
      assert.equal(res.status, 0, `python yaml probe failed: ${res.stderr}`);
      const bad = JSON.parse((res.stdout || "[]").trim() || "[]");
      assert.deepEqual(bad, [], `invalid-YAML frontmatter blocks: ${bad.join("; ")}`);
      assert.ok(blocks.length > 100, `expected the full emitted corpus, got ${blocks.length}`);
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  },
);

test("emitCoc[integration]: typed superset lands for agents/commands/skills, NOT rules (contract §3.2)", () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "coc-int-typed-"));
  try {
    emitCoc({ outDir: t });
    const coc = path.join(t, ".coc");

    // Helper: read the leading frontmatter block of an emitted artifact.
    const fmOf = (rel) => {
      const src = fs.readFileSync(path.join(coc, rel), "utf8");
      const m = src.match(/^---\n([\s\S]*?)\n---\n/);
      return m ? m[1] : "";
    };

    // Every agent carries name + description (the required L2 typed fields).
    const agentsDir = path.join(coc, "agents");
    for (const f of fs.readdirSync(agentsDir).filter((x) => x.endsWith(".md"))) {
      const fm = fmOf(`agents/${f}`);
      assert.match(fm, /^name: /m, `agents/${f} missing typed name`);
      assert.match(fm, /^description: /m, `agents/${f} missing typed description`);
    }

    // Rules carry NO native typed fields — paths/applies_to (strict block) only.
    const rulesDir = path.join(coc, "rules");
    for (const f of fs.readdirSync(rulesDir).filter((x) => x.endsWith(".md"))) {
      const fm = fmOf(`rules/${f}`);
      assert.equal(/^name: /m.test(fm), false, `rules/${f} must not carry a native name`);
      assert.equal(/^tools: /m.test(fm), false, `rules/${f} must not carry tools`);
    }

    // At least one agent carries the nested hooks: block verbatim (multi-line
    // preservation — the YAML re-serialization hazard this design avoids).
    const withHooks = fs
      .readdirSync(agentsDir)
      .filter((x) => x.endsWith(".md"))
      .map((f) => fmOf(`agents/${f}`))
      .filter((fm) => /^hooks:\n {2}\S/m.test(fm));
    assert.ok(withHooks.length > 0, "expected ≥1 agent with a preserved nested hooks: block");

    // Skills carry the typed superset VERBATIM — whatever the source has (some
    // skills omit `name:`, deriving the handle from the dir → clean degrade).
    // Invariant: a skill carries ≥1 typed field AND never a non-allowlisted one
    // (tools/model/hooks belong to agents, not skills).
    for (const f of fs.readdirSync(path.join(coc, "skills")).filter((x) => x.endsWith(".md"))) {
      const fm = fmOf(`skills/${f}`);
      assert.ok(/^name: /m.test(fm) || /^description: /m.test(fm), `skills/${f} missing both typed fields`);
      assert.equal(/^tools: /m.test(fm), false, `skills/${f} leaked agent-only field tools`);
      assert.equal(/^hooks:/m.test(fm), false, `skills/${f} leaked agent-only field hooks`);
    }
    // Representative skill that DOES declare a name carries both fields.
    const coreFm = fmOf("skills/S01-CORE-SDK.md");
    assert.match(coreFm, /^name: /m, "S01-CORE-SDK should carry typed name");
    assert.match(coreFm, /^description: /m, "S01-CORE-SDK should carry typed description");
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

test("emitCoc[integration]: applies_to only emits closed-set surface tokens", () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "coc-int-c-"));
  try {
    emitCoc({ outDir: t });
    const allowed = new Set(["claude-code", "codex", "gemini"]);
    for (const kind of ["rules", "agents", "skills", "commands"]) {
      const dir = path.join(t, ".coc", kind);
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md"))) {
        const fm = fs.readFileSync(path.join(dir, f), "utf8");
        const m = fm.match(/^applies_to: \[(.+)\]$/m);
        if (!m) continue; // universal → omitted
        for (const tok of m[1].split(",").map((s) => s.trim().replace(/"/g, ""))) {
          assert.ok(allowed.has(tok), `${kind}/${f} applies_to has out-of-set token "${tok}"`);
        }
      }
    }
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});
