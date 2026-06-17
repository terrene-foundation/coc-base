#!/usr/bin/env node
/**
 * Unit + integration tests for .claude/bin/emit-dev-container.mjs (W6b-i, specs/04 §6).
 *
 * Run: node --test .claude/bin/emit-dev-container.test.mjs
 *
 * Per probe-driven-verification.md MUST-3: every assertion here is STRUCTURAL
 * (array membership, string equality, count equality, thrown-error type, file
 * existence / byte content) — not lexical regex against assistant prose. The
 * resolver is integration-tested against the REAL loom sync-manifest.yaml; the
 * substitution + fail-closed paths are unit-tested with synthetic inputs and an
 * injected registryFn.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  readOwnership,
  resolveFileList,
  substituteRegistry,
  emitDevContainer,
  DevContainerEmitError,
} from "./emit-dev-container.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_DIR = path.resolve(SCRIPT_DIR, "..");
const MANIFEST_PATH = path.join(CLAUDE_DIR, "sync-manifest.yaml");

// The 4 functional registry-break files (specs/04 §6) — all MUST appear in the
// resolved py distribution set.
const FUNCTIONAL_BREAK_FILES = [
  ".devcontainer/devcontainer.json",
  "docker-compose.yml",
  "bin/dev",
  ".github/workflows/publish-dev-image.yml",
];

// publisher/consumer variant-overlay files declared py-only in the manifest.
const PY_VARIANT_FILES = [
  "requirements-coc.txt",
  "requirements-coc-ml.txt",
  ".github/workflows/publish-dev-image.yml",
  ".devcontainer/postCreate.sh",
  ".devcontainer/postCreate.user.sh.example",
  "Dockerfile.user.example",
];

// ──────────────────────────────────────────────────────────────────
// 1. Resolver against the REAL manifest for variant=py
// ──────────────────────────────────────────────────────────────────
test("resolveFileList(py) includes the 4 functional break files + py variant files", () => {
  const ownership = readOwnership(MANIFEST_PATH);
  const resolved = resolveFileList("py", ownership);

  assert.equal(resolved.distributed, true, "py MUST be distributed");
  assert.equal(
    resolved.registry_substitution,
    true,
    "py MUST declare registry_substitution",
  );
  assert.deepEqual(
    resolved.classes,
    ["publisher_internal", "consumer_shipped"],
    "py classes per manifest",
  );

  for (const f of FUNCTIONAL_BREAK_FILES) {
    assert.ok(
      resolved.files.includes(f),
      `resolved py file list MUST include functional break file ${f}`,
    );
  }
  for (const f of PY_VARIANT_FILES) {
    assert.ok(
      resolved.files.includes(f),
      `resolved py file list MUST include py variant file ${f}`,
    );
  }
  // No duplicate entries (union must dedup the variant overlay).
  assert.equal(
    new Set(resolved.files).size,
    resolved.files.length,
    "resolved file list MUST be deduplicated",
  );
});

// ──────────────────────────────────────────────────────────────────
// 2. In-memory substitution replaces BOTH tokens
// ──────────────────────────────────────────────────────────────────
test("substituteRegistry replaces {{REGISTRY_HOST}} and {{REGISTRY_ORG}}", () => {
  const fixture =
    'image: ${DEV_IMAGE:-{{REGISTRY_HOST}}/{{REGISTRY_ORG}}/kailash-coc-py:1.10.1}\n';
  const fullReg = () => ({ host: "docker.io", org: "terrenefoundation" });
  const { content, substitutions } = substituteRegistry(
    fixture,
    "docker-compose.yml",
    fullReg,
  );
  assert.ok(
    content.includes("docker.io/terrenefoundation/kailash-coc-py:1.10.1"),
    "both host and org MUST be substituted",
  );
  assert.ok(
    !content.includes("{{REGISTRY_"),
    "no residual token after substitution",
  );
  assert.equal(substitutions, 2, "exactly 2 substitutions (host + org)");
});

test("substituteRegistry counts every occurrence of each token", () => {
  // 3 ORG tokens, 1 HOST token = 4 substitutions.
  const fixture =
    "{{REGISTRY_HOST}}/{{REGISTRY_ORG}}/a {{REGISTRY_ORG}}/b {{REGISTRY_ORG}}/c";
  const { content, substitutions } = substituteRegistry(fixture, "f", () => ({
    host: "h",
    org: "o",
  }));
  assert.equal(substitutions, 4);
  assert.equal(content, "h/o/a o/b o/c");
});

// ──────────────────────────────────────────────────────────────────
// 3. Fail-closed: a partial getRegistry leaving a residual token throws
// ──────────────────────────────────────────────────────────────────
test("substituteRegistry FAILS CLOSED when getRegistry returns null", () => {
  const fixture = "{{REGISTRY_HOST}}/{{REGISTRY_ORG}}/x";
  assert.throws(
    () => substituteRegistry(fixture, "bin/dev", () => null),
    (e) =>
      e instanceof DevContainerEmitError && /refusing to write/.test(e.message),
    "null registry MUST throw DevContainerEmitError, never write placeholders",
  );
});

test("substituteRegistry FAILS CLOSED when a residual {{REGISTRY_ token survives", () => {
  // Simulate a partial registry: host present, org token left because the
  // registryFn yields a value whose org replacement does NOT cover the token
  // shape. Here we feed a registryFn that only knows HOST, so the ORG token
  // would remain — but the {host,org} shape guard fires first. To exercise the
  // residual-token branch directly, feed a fixture carrying an extra unknown
  // REGISTRY token the two-token replace cannot cover.
  const fixture = "{{REGISTRY_HOST}}/{{REGISTRY_ORG}}/x {{REGISTRY_REGION}}/y";
  assert.throws(
    () =>
      substituteRegistry(fixture, ".devcontainer/devcontainer.json", () => ({
        host: "docker.io",
        org: "terrenefoundation",
      })),
    (e) =>
      e instanceof DevContainerEmitError &&
      /still contains a \{\{REGISTRY_ token/.test(e.message),
    "a residual {{REGISTRY_ token MUST fail closed (broken pointer)",
  );
});

// ──────────────────────────────────────────────────────────────────
// 4. variant=rs (absent from loom_distributed) is a no-op exit 0
// ──────────────────────────────────────────────────────────────────
test("emitDevContainer(rs) is a preserve-only no-op (distributed:false), writes nothing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "w6bi-rs-noop-"));
  try {
    const summary = emitDevContainer({
      variant: "rs",
      target: tmp,
      dryRun: false,
      manifestPath: MANIFEST_PATH,
      registryFn: () => ({ host: "docker.io", org: "terrenefoundation" }),
      claudeDir: CLAUDE_DIR,
    });
    assert.equal(summary.distributed, false, "rs MUST be preserve-only");
    assert.deepEqual(summary.written, [], "rs MUST write nothing");
    assert.equal(summary.substitutions, 0);
    assert.match(summary.message, /preserve-only/);
    // Target dir MUST be empty (nothing written).
    assert.deepEqual(fs.readdirSync(tmp), [], "no files written for rs");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────
// 5. End-to-end emit(py) into a temp target — substituted, no residual tokens
// ──────────────────────────────────────────────────────────────────
test("emitDevContainer(py) writes all files substituted, zero residual tokens", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "w6bi-py-emit-"));
  try {
    const summary = emitDevContainer({
      variant: "py",
      target: tmp,
      dryRun: false,
      manifestPath: MANIFEST_PATH,
      registryFn: () => ({ host: "docker.io", org: "terrenefoundation" }),
      claudeDir: CLAUDE_DIR,
    });
    assert.equal(summary.distributed, true);
    assert.ok(summary.written.length >= 14, "py distributes the full set");
    assert.ok(summary.substitutions > 0, "py substitutes >0 registry tokens");

    // Every functional break file landed and carries NO residual token.
    for (const f of FUNCTIONAL_BREAK_FILES) {
      const p = path.join(tmp, f);
      assert.ok(fs.existsSync(p), `${f} MUST be written`);
      const body = fs.readFileSync(p, "utf8");
      assert.ok(
        !body.includes("{{REGISTRY_"),
        `${f} MUST carry NO {{REGISTRY_ token after emit`,
      );
      assert.ok(
        body.includes("docker.io/terrenefoundation") ||
          body.includes("terrenefoundation/kailash-coc-py"),
        `${f} MUST carry the substituted registry`,
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
