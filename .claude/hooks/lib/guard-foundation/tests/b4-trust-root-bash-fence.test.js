/**
 * B4 — the hook-registry / TRUST-ROOT files on the BASH lane.
 *
 * THE HOLE, MEASURED before this change (probe, this worktree):
 *   PASSED   echo x > .claude/hooks/dispatch-registry.json   <- the registry's
 *            data file: settings.json pins its sha256 in every dispatcher
 *            command, so a bash write silently changes which detectors run
 *            while the pin goes stale
 *   PASSED   echo x > .claude/trust-root.json                <- the DERIVED
 *            signer authority surface (pubkeys + root commit)
 *   FLAGGED  echo x > .claude/learning/posture.json          <- CONTROL: an
 *            existing registry row, proving the harness discriminates
 *
 * RED-CASE-FIRST: this file is written to FAIL against the pre-change tree —
 * the two RED CASE tests and the propagation test red, the controls pass.
 * The change adds two rows to the ONE registry
 * (`guard-path-scope.js::PROTECTED_PATHS`); the bash lane's matchers are BUILT
 * from that registry (`_buildSurfaceRx`), so the propagation assertion here is
 * the registry-built-matchers contract made explicit rather than assumed.
 *
 * SURFACES: `{ bash: true, layer3: true }` — the same shape as settings.json,
 * settings.local.json and VERSION, and deliberately NOT `direct`: the registry
 * is legitimately maintained with FILE TOOLS (a new detector row + `--repin`),
 * and trust-root.json is regenerated/ authored through its own ceremony — the
 * same "sanctioned file-tool writer" asymmetry those rows document.
 *
 * Run: node --test .claude/hooks/lib/guard-foundation/tests/b4-trust-root-bash-fence.test.js
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..", "..", "..", "..");
const HOOK = path.join(REPO, ".claude", "hooks", "validate-bash-command.js");
const BLOCKED = 2;

function runHook(command) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_input: { command }, cwd: REPO }),
    cwd: REPO,
    encoding: "utf8",
    timeout: 30000,
  });
  return res.status;
}

test("B4 RED CASE: bash write to the hook-registry data file is REFUSED", () => {
  assert.equal(
    runHook("echo x > .claude/hooks/dispatch-registry.json"),
    BLOCKED,
    "canonical write to the registry's data file must refuse",
  );
  assert.equal(
    runHook("echo x > .claude/hooks/Dispatch-Registry.json"),
    BLOCKED,
    "case-variant of the SAME file must refuse (case-insensitive builder, loom#1399)",
  );
});

test("B4 RED CASE: bash write to the TRUST-ROOT file is REFUSED", () => {
  assert.equal(
    runHook("echo x > .claude/trust-root.json"),
    BLOCKED,
    "canonical write to the derived trust root must refuse",
  );
  assert.equal(
    runHook("echo x > .claude/Trust-Root.json"),
    BLOCKED,
    "case-variant of the SAME file must refuse",
  );
});

test("B4 PROPAGATION: the refusal rides the registry-built matcher, not a hand-spelled regex", () => {
  const gps = require(path.join(REPO, ".claude", "hooks", "lib", "guard-path-scope.js"));
  for (const rel of [".claude/hooks/dispatch-registry.json", ".claude/trust-root.json"]) {
    assert.ok(
      gps.PROTECTED_PATHS.some((r) => r.surfaces.bash === true && r.segments.join("/") === rel),
      `PROTECTED_PATHS must carry a bash-surface row for ${rel}`,
    );
    assert.ok(
      gps.STATE_PATH_RX.test(rel),
      `STATE_PATH_RX (built from the registry) must match ${rel} — propagation is the point`,
    );
    assert.ok(
      gps.LAYER3_BLOCK_RX.test(rel),
      `LAYER3_BLOCK_RX must match ${rel} so Layer-3 writes keep severity:block`,
    );
  }
});

test("B4 CONTROLS: sanctioned writers and unrelated paths still pass; an existing row still refuses", () => {
  assert.notEqual(
    runHook("node .claude/bin/hook-dispatch-migrate.mjs --repin --apply"),
    BLOCKED,
    "the SANCTIONED registry writer must keep passing (control)",
  );
  assert.notEqual(
    runHook("node .claude/bin/build-trust-root.mjs"),
    BLOCKED,
    "the sanctioned trust-root regeneration must keep passing (control)",
  );
  assert.notEqual(
    runHook("echo x > .claude/hooks/not-protected-scratch.json"),
    BLOCKED,
    "an unprotected file in the same directory must stay writable — the fence is targeted, not a blanket (control)",
  );
  assert.equal(
    runHook("echo x > .claude/learning/posture.json"),
    BLOCKED,
    "existing-row control: the fence still fires for a pre-existing row, so the new assertions cannot pass vacuously",
  );
});
