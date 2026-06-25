#!/usr/bin/env node
/**
 * Unit + integration tests for the W3-d surface_roles emit-strip
 * (onboarding-portability, the deferred W2-c tail).
 *
 * Unit: loadSurfaceRoles / loadTargetRole / surfaceRolesAllow against the real
 * manifest (deterministic reads). Integration: emitCommands proves the strip
 * FIRES for a non-use-consumer target role (the forward-enforcement behavior
 * that has no current shipped-consumer effect because no live target carries a
 * platform/build role) while default-surfaced commands survive.
 *
 * Run: node --test .claude/bin/surface-roles-emit.test.mjs
 *
 * Per probe-driven-verification.md MUST-3: STRUCTURAL probes (map membership,
 * file presence/absence after emission), not lexical regex against prose.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  loadSurfaceRoles,
  loadTargetRole,
  surfaceRolesAllow,
  loadLoomOnly,
  loadExclusions,
} from "./lib/coc-manifest.mjs";
import { emitCommands } from "./emit-cli-artifacts.mjs";

// ── unit: loaders ────────────────────────────────────────────────────────────

test("loadSurfaceRoles parses the manifest map (lifecycle + utility entries)", () => {
  const sr = loadSurfaceRoles();
  // 6 lifecycle + 11 utility = 17 declared; each value is the closed role set.
  assert.deepEqual(sr["commands/analyze.md"], ["build", "use-consumer"]);
  assert.deepEqual(sr["commands/sdk.md"], ["build", "use-consumer"]);
  assert.deepEqual(sr["commands/i-harden.md"], ["build", "use-consumer"]);
  // /start, /learn, /journal are DELIBERATELY default-surfaced (no entry).
  assert.equal(sr["commands/start.md"], undefined);
  assert.equal(sr["commands/learn.md"], undefined);
  assert.equal(sr["commands/journal.md"], undefined);
});

test("loadTargetRole: base→use-consumer; py/rs unset→null; unknown→null", () => {
  assert.equal(loadTargetRole("base"), "use-consumer");
  assert.equal(loadTargetRole("py"), null); // intentionally unset (back-compat)
  assert.equal(loadTargetRole("rs"), null);
  assert.equal(loadTargetRole("nonexistent"), null);
  assert.equal(loadTargetRole(null), null);
});

test("surfaceRolesAllow: default-surfaced + null-role keep; restriction strips", () => {
  const sr = { "commands/analyze.md": ["build", "use-consumer"] };
  // null targetRole → keep (back-compat full emission)
  assert.equal(surfaceRolesAllow(sr, "commands/analyze.md", null), true);
  // no entry → default-surfaced → keep for any role
  assert.equal(surfaceRolesAllow(sr, "commands/start.md", "platform"), true);
  // declared list includes the role → keep
  assert.equal(surfaceRolesAllow(sr, "commands/analyze.md", "use-consumer"), true);
  assert.equal(surfaceRolesAllow(sr, "commands/analyze.md", "build"), true);
  // declared list EXCLUDES the role → strip
  assert.equal(surfaceRolesAllow(sr, "commands/analyze.md", "platform"), false);
});

// ── integration: emitCommands strip fires for a platform target ──────────────

function emittedCommandNames(outDir) {
  // emitCommands writes codex prompts + gemini commands; collect the basenames
  // (without lane suffix) that landed in either lane.
  const names = new Set();
  for (const lane of [
    path.join(outDir, "codex", "prompts", "commands"),
    path.join(outDir, "gemini", "commands"),
  ]) {
    if (!existsSync(lane)) continue;
    for (const f of readdirSync(lane)) names.add(f.replace(/\.(toml|md)$/, ""));
  }
  return names;
}

test("emitCommands strips [build,use-consumer] cmds for a platform target; keeps default-surfaced", () => {
  const out = mkdtempSync(path.join(tmpdir(), "sr-platform-"));
  try {
    const stats = emitCommands({
      outDir: out,
      exclusions: loadExclusions(),
      tierFilter: null, // full emit (no tier narrowing) to isolate the role strip
      loomOnly: loadLoomOnly(),
      surfaceRoles: loadSurfaceRoles(),
      targetRole: "platform",
      lang: null,
      verbose: false,
    });
    const names = emittedCommandNames(out);
    // restricted ([build, use-consumer], excludes platform) → STRIPPED
    assert.equal(names.has("analyze"), false, "analyze must be stripped for platform");
    assert.equal(names.has("sdk"), false, "sdk must be stripped for platform");
    assert.equal(names.has("i-harden"), false, "i-harden must be stripped for platform");
    // default-surfaced (no entry) → KEPT
    assert.equal(names.has("start"), true, "start must survive for platform");
    assert.equal(names.has("learn"), true, "learn must survive for platform");
    assert.ok(stats.skipped > 0, "platform emit must record role-strip skips");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("emitCommands keeps [build,use-consumer] cmds for a use-consumer target (no strip)", () => {
  const out = mkdtempSync(path.join(tmpdir(), "sr-uc-"));
  try {
    emitCommands({
      outDir: out,
      exclusions: loadExclusions(),
      tierFilter: null,
      loomOnly: loadLoomOnly(),
      surfaceRoles: loadSurfaceRoles(),
      targetRole: "use-consumer",
      lang: null,
      verbose: false,
    });
    const names = emittedCommandNames(out);
    // use-consumer ∈ [build, use-consumer] → KEPT (the "no current behavioral change" proof)
    assert.equal(names.has("analyze"), true, "analyze surfaces for use-consumer");
    assert.equal(names.has("sdk"), true, "sdk surfaces for use-consumer");
    assert.equal(names.has("start"), true, "start surfaces for use-consumer");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("emitCommands with null target role emits everything (back-compat)", () => {
  const out = mkdtempSync(path.join(tmpdir(), "sr-null-"));
  try {
    emitCommands({
      outDir: out,
      exclusions: loadExclusions(),
      tierFilter: null,
      loomOnly: loadLoomOnly(),
      surfaceRoles: loadSurfaceRoles(),
      targetRole: null, // py/rs / no --target
      lang: null,
      verbose: false,
    });
    const names = emittedCommandNames(out);
    assert.equal(names.has("analyze"), true, "null role → analyze emitted (back-compat)");
    assert.equal(names.has("sdk"), true, "null role → sdk emitted (back-compat)");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
