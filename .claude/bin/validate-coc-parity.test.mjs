#!/usr/bin/env node
/**
 * Unit + integration tests for .claude/bin/validate-coc-parity.mjs (coc-universal W4).
 *
 * Run: node --test .claude/bin/validate-coc-parity.test.mjs
 *
 * Per probe-driven-verification.md MUST-3 every assertion is STRUCTURAL (set equality,
 * byte equality, count, exit-disposition) — not lexical regex against prose. The pure
 * comparison functions are unit-tested with SYNTHETIC sources + cocById (so the
 * coverage-divergence DETECTION is guarded independently of the live tree — the D1/D2/D3
 * class of gap the harness exists to catch); the orchestrator is integration-tested against
 * the REAL loom artifact tree (the W4 "≥1 full cycle" smoke proof). The two carried-forward
 * W3 forward-notes (buildFrontmatter↔listField round-trip; spawn-arm filename parity) live
 * here because they pin the producer↔consumer contract this harness validates.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  legacyDelivers,
  cocDelivers,
  computeMembership,
  classifyMember,
  membershipVerdict,
  relForCompose,
  runParity,
  formatReport,
  KNOWN_GAPS,
  SURFACE_TOKENS,
  KINDS,
} from "./validate-coc-parity.mjs";

import { deriveId, buildFrontmatter } from "./emit-coc.mjs";
import { listField, splitFlowItems, SURFACES, materializeEphemeral, buildSpawn, reclaim } from "./coc-run.mjs";

// ──────────────────────────────────────────────────────────────────
// legacyDelivers — the manifest-driven legacy-membership predicate.
// ──────────────────────────────────────────────────────────────────
test("legacyDelivers: cc gets everything that survives loom_only + tier (no cc-side exclusions)", () => {
  const filt = { loomOnly: [], tierFilter: null, exclusions: { codex: ["agents/x.md"], gemini: [] } };
  // cc ignores cli_emit_exclusions entirely (cc IS the source; emit-cli-artifacts emits no cc tree).
  assert.equal(legacyDelivers("claude-code", "agents/x.md", filt), true);
});

test("legacyDelivers: codex/gemini subtract the TRUE legacy set (manifest cli_emit_exclusions ∪ hardcoded *_STRUCTURAL_EXCLUSIONS)", () => {
  // (1) the manifest half still excludes: a manifest-declared glob NOT in the structural constants.
  const manifestOnly = { loomOnly: [], tierFilter: null, exclusions: { codex: ["agents/foo.md"], gemini: [] } };
  assert.equal(legacyDelivers("codex", "agents/foo.md", manifestOnly), false);
  assert.equal(legacyDelivers("gemini", "agents/foo.md", manifestOnly), true); // excluded by neither half for gemini
  // (2) THE DRIFT TRIPWIRE (W4 R-MED): the hardcoded constants exclude the authoring agents on BOTH surfaces
  // EVEN with an empty manifest — so a manifest exclusion dropped while the constant stays is still caught.
  const emptyManifest = { loomOnly: [], tierFilter: null, exclusions: { codex: [], gemini: [] } };
  for (const surface of ["codex", "gemini"]) {
    assert.equal(legacyDelivers(surface, "agents/cli-orchestrator.md", emptyManifest), false, `${surface} must exclude cli-orchestrator via the structural constant`);
    assert.equal(legacyDelivers(surface, "agents/codex-architect.md", emptyManifest), false);
    assert.equal(legacyDelivers(surface, "agents/gemini-architect.md", emptyManifest), false);
  }
  // (3) a normal runtime specialist is delivered to both (the union does not over-exclude).
  assert.equal(legacyDelivers("codex", "agents/quality/reviewer.md", emptyManifest), true);
  assert.equal(legacyDelivers("gemini", "agents/quality/reviewer.md", emptyManifest), true);
});

test("legacyDelivers: loom_only removes from EVERY surface, before tier", () => {
  const filt = { loomOnly: ["agents/management/**"], tierFilter: null, exclusions: { codex: [], gemini: [] } };
  for (const s of SURFACE_TOKENS) assert.equal(legacyDelivers(s, "agents/management/gh-manager.md", filt), false);
});

test("legacyDelivers: tier filter excludes a non-subscribed path on every surface", () => {
  const filt = { loomOnly: [], tierFilter: ["rules/**"], exclusions: { codex: [], gemini: [] } };
  assert.equal(legacyDelivers("claude-code", "rules/git.md", filt), true);
  assert.equal(legacyDelivers("claude-code", "commands/codify.md", filt), false); // not in the tier glob
});

// ──────────────────────────────────────────────────────────────────
// cocDelivers — the .coc/ membership predicate (forward deriveId + applies_to).
// ──────────────────────────────────────────────────────────────────
function cocByIdFrom(records) {
  const m = { rules: new Map(), agents: new Map(), skills: new Map(), commands: new Map() };
  for (const r of records) m[r.kind].set(r.id, r);
  return m;
}

test("cocDelivers: a present record with universal applies_to reaches every surface", () => {
  const cocById = cocByIdFrom([{ kind: "agents", id: deriveId("agents", "reviewer"), fields: { appliesTo: null } }]);
  for (const s of SURFACE_TOKENS) assert.equal(cocDelivers(s, "agents", "reviewer", cocById), true);
});

test("cocDelivers: an ABSENT record (a skill emit-coc never emitted) reaches nothing", () => {
  const cocById = cocByIdFrom([]); // emit-coc never emitted it (e.g. loom_only / tier-filtered)
  for (const s of SURFACE_TOKENS) assert.equal(cocDelivers(s, "skills", "never-emitted-skill", cocById), false);
});

test("cocDelivers: applies_to allowlist gates per surface", () => {
  const cocById = cocByIdFrom([{ kind: "agents", id: deriveId("agents", "cc-architect"), fields: { appliesTo: ["claude-code"] } }]);
  assert.equal(cocDelivers("claude-code", "agents", "cc-architect", cocById), true);
  assert.equal(cocDelivers("codex", "agents", "cc-architect", cocById), false);
  assert.equal(cocDelivers("gemini", "agents", "cc-architect", cocById), false);
});

// ──────────────────────────────────────────────────────────────────
// computeMembership — the coverage-divergence detector (D1/D2/D3 class).
// Synthetic sources + cocById so the detection is guarded WITHOUT the live tree.
// ──────────────────────────────────────────────────────────────────
function emptySources() {
  return { rules: [], agents: [], skills: [], commands: [] };
}

test("computeMembership: detects a coverage ADD (coc over-delivers an excluded artifact — the D1/D2 class)", () => {
  // legacy excludes agents/over.md from codex; coc carries it universally → codex coc-only.
  const sources = emptySources();
  sources.agents = [{ mrel: "agents/over.md", base: "over" }];
  const cocById = cocByIdFrom([{ kind: "agents", id: deriveId("agents", "over"), fields: { appliesTo: null } }]);
  const cells = computeMembership({
    sources,
    cocById,
    loomOnly: [],
    tierFilter: null,
    exclusions: { codex: ["agents/over.md"], gemini: [] },
  });
  const codexAgents = cells.find((c) => c.surface === "codex" && c.kind === "agents");
  assert.deepEqual(codexAgents.cocOnly, ["agents/over.md"]); // coc delivers it, legacy excluded it
  assert.deepEqual(codexAgents.legacyOnly, []);
  const geminiAgents = cells.find((c) => c.surface === "gemini" && c.kind === "agents");
  assert.deepEqual(geminiAgents.cocOnly, []); // gemini did not exclude → both deliver → EQUAL
});

test("computeMembership: detects a coverage LOSS (legacy delivers, coc dropped — the D3 class)", () => {
  const sources = emptySources();
  sources.skills = [{ mrel: "skills/nested/SKILL.md", base: "nested", dir: "nested", hasTopSkill: false }];
  const cocById = cocByIdFrom([]); // emit-coc dropped it (no top SKILL.md)
  const cells = computeMembership({ sources, cocById, loomOnly: [], tierFilter: null, exclusions: { codex: [], gemini: [] } });
  const ccSkills = cells.find((c) => c.surface === "claude-code" && c.kind === "skills");
  assert.deepEqual(ccSkills.legacyOnly, ["skills/nested/SKILL.md"]); // legacy delivers, coc doesn't
  assert.deepEqual(ccSkills.cocOnly, []);
});

test("computeMembership: a manifest⟷constant DRIFT is caught end-to-end (the W4 R-MED fix)", () => {
  // Simulate the drift the MED finding reproduced: the manifest cli_emit_exclusions DROPPED the
  // cli-orchestrator line (exclusions empty), so emit-coc emits CLI-ORCHESTRATOR.md universally
  // (cocById universal). The REAL legacy emitter still excludes it via the hardcoded constant.
  // A manifest-only "legacy" model would report EQUAL (blind); the faithful TRUE-legacy model
  // (manifest ∪ constants) reports a coc-only coverage ADD — a NEW gap that fails the gate.
  const sources = emptySources();
  sources.agents = [{ mrel: "agents/cli-orchestrator.md", base: "cli-orchestrator" }];
  const cocById = cocByIdFrom([{ kind: "agents", id: deriveId("agents", "cli-orchestrator"), fields: { appliesTo: null } }]);
  const cells = computeMembership({ sources, cocById, loomOnly: [], tierFilter: null, exclusions: { codex: [], gemini: [] } });
  for (const surface of ["codex", "gemini"]) {
    const cell = cells.find((c) => c.surface === surface && c.kind === "agents");
    assert.deepEqual(cell.cocOnly, ["agents/cli-orchestrator.md"], `${surface}: the drift MUST surface as a coc-only coverage ADD, not a false EQUAL`);
  }
});

test("computeMembership: clean parity → empty legacyOnly + cocOnly", () => {
  const sources = emptySources();
  sources.commands = [{ mrel: "commands/codify.md", base: "codify" }];
  const cocById = cocByIdFrom([{ kind: "commands", id: deriveId("commands", "codify"), fields: { appliesTo: null } }]);
  const cells = computeMembership({ sources, cocById, loomOnly: [], tierFilter: null, exclusions: { codex: [], gemini: [] } });
  for (const c of cells.filter((c) => c.kind === "commands")) {
    assert.deepEqual(c.legacyOnly, []);
    assert.deepEqual(c.cocOnly, []);
  }
});

// ──────────────────────────────────────────────────────────────────
// classifyMember + membershipVerdict — known vs new gap partitioning.
// ──────────────────────────────────────────────────────────────────
test("classifyMember: with KNOWN_GAPS empty (D3 resolved), any membership divergence classifies NEW", () => {
  assert.equal(KNOWN_GAPS.length, 0, "D3-nested-skill was the sole known gap; resolved by the nested-skill flattening (option a)");
  assert.equal(classifyMember("skills", "codex", "skills/40-stack-onboarding/python/SKILL.md").kind, "new");
  assert.equal(classifyMember("agents", "codex", "agents/whatever.md").kind, "new");
});

test("membershipVerdict: EQUAL / KNOWN-GAP / NEW-GAP", () => {
  const known = [{ surface: "codex", kind: "skills", member: "skills/40-stack-onboarding/SKILL.md" }];
  assert.equal(membershipVerdict({ surface: "codex", kind: "skills", legacyOnly: [], cocOnly: [] }, known), "EQUAL");
  assert.equal(
    membershipVerdict({ surface: "codex", kind: "skills", legacyOnly: ["skills/40-stack-onboarding/SKILL.md"], cocOnly: [] }, known),
    "KNOWN-GAP",
  );
  assert.equal(
    membershipVerdict({ surface: "codex", kind: "skills", legacyOnly: ["skills/surprise/SKILL.md"], cocOnly: [] }, known),
    "NEW-GAP",
  );
});

test("relForCompose: skills → leafRel (flat OR nested leaf); other kinds → manifestRel minus the kind prefix", () => {
  assert.equal(relForCompose("skills", { dir: "04-kaizen", leafRel: "04-kaizen/SKILL.md", mrel: "skills/04-kaizen/SKILL.md" }), "04-kaizen/SKILL.md");
  assert.equal(relForCompose("skills", { dir: "40-stack-onboarding", sub: "python", leafRel: "40-stack-onboarding/python/SKILL.md", mrel: "skills/40-stack-onboarding/SKILL.md" }), "40-stack-onboarding/python/SKILL.md"); // nested leaf
  assert.equal(relForCompose("agents", { mrel: "agents/quality/reviewer.md" }), "quality/reviewer.md");
  assert.equal(relForCompose("commands", { mrel: "commands/codify.md" }), "codify.md");
  assert.equal(relForCompose("rules", { mrel: "rules/git.md" }), "git.md");
});

// ──────────────────────────────────────────────────────────────────
// Integration — runParity against the REAL loom tree (the W4 smoke proof).
// Pins: full parity (zero NEW gaps, zero known gaps post-D3-resolution, zero body
// mismatches, every cell EQUAL), the D1/D2 agents fix, and the D3 nested-skill resolution.
// ──────────────────────────────────────────────────────────────────
test("runParity (real tree, emit-everything): full PARITY — no new gaps, no known gaps, body byte-parity, nested skill represented", () => {
  const r = runParity({ target: null });
  assert.equal(r.newGaps.length, 0, `unexpected NEW gaps: ${JSON.stringify(r.newGaps)}`);
  assert.equal(r.body.mismatches.length, 0, `unexpected body mismatches: ${JSON.stringify(r.body.mismatches)}`);
  assert.equal(r.knownGaps.length, 0, `D3 resolved → expected zero known gaps; got ${JSON.stringify(r.knownGaps)}`);
  // every membership cell is EQUAL — including skills, where the nested 40-stack-onboarding
  // per-language leaves are now each a delivered unit on both sides.
  for (const c of r.membership) {
    assert.deepEqual(c.legacyOnly, [], `${c.surface}/${c.kind} legacyOnly ${JSON.stringify(c.legacyOnly)}`);
    assert.deepEqual(c.cocOnly, [], `${c.surface}/${c.kind} cocOnly ${JSON.stringify(c.cocOnly)}`);
  }
  // D1/D2 fix receipt: architect/orchestrator agents excluded from codex+gemini.
  for (const surface of ["codex", "gemini"]) {
    const cell = r.membership.find((c) => c.surface === surface && c.kind === "agents");
    assert.deepEqual(cell.cocOnly, [], `D1/D2 regression: ${surface} agents over-delivered ${JSON.stringify(cell.cocOnly)}`);
  }
  // D3 resolution receipt: the per-language leaves are counted individually (each leaf is a
  // distinct membership entry, so a dropped language would surface as a divergence — see the
  // dropped-leaf detection test below).
  const ccSkills = r.membership.find((c) => c.surface === "claude-code" && c.kind === "skills");
  assert.ok(ccSkills.legacyCount >= 38, `nested-skill leaves should be counted individually (got ${ccSkills.legacyCount})`);
});

test("runParity (real tree, --target rs variant): full parity, no gaps (40-stack-onboarding tier-filtered on both sides)", () => {
  const r = runParity({ target: "rs" });
  assert.equal(r.newGaps.length, 0, `rs NEW gaps: ${JSON.stringify(r.newGaps)}`);
  assert.equal(r.knownGaps.length, 0, "rs does not subscribe to the onboarding tier → D3 does not manifest");
  assert.equal(r.body.mismatches.length, 0);
  // every membership cell is EQUAL for the rs variant
  for (const c of r.membership) {
    assert.deepEqual(c.legacyOnly, [], `rs ${c.surface}/${c.kind} legacyOnly ${JSON.stringify(c.legacyOnly)}`);
    assert.deepEqual(c.cocOnly, [], `rs ${c.surface}/${c.kind} cocOnly ${JSON.stringify(c.cocOnly)}`);
  }
});

test("computeMembership: a DROPPED nested-skill language leaf is caught (per-leaf keying, not dir-collapsed)", () => {
  // A nested skill with 2 language leaves; `.coc/` emitted only 1 → the missing language MUST
  // surface as a legacy-only divergence, NOT collapse into a single dir-level EQUAL entry. This
  // pins the per-leaf membership keying that the D3 resolution depends on for regression safety.
  const sources = emptySources();
  sources.skills = [
    { mrel: "skills/nested/SKILL.md", base: "nested-go", dir: "nested", sub: "go", leafRel: "nested/go/SKILL.md" },
    { mrel: "skills/nested/SKILL.md", base: "nested-python", dir: "nested", sub: "python", leafRel: "nested/python/SKILL.md" },
  ];
  const cocById = cocByIdFrom([
    { kind: "skills", id: deriveId("skills", "nested-go"), fields: { appliesTo: null } }, // python MISSING
  ]);
  const cells = computeMembership({ sources, cocById, loomOnly: [], tierFilter: null, exclusions: { codex: [], gemini: [] } });
  const cc = cells.find((c) => c.surface === "claude-code" && c.kind === "skills");
  assert.deepEqual(cc.legacyOnly, ["skills/nested/python/SKILL.md"], "the dropped language leaf MUST surface as a coverage LOSS");
  assert.deepEqual(cc.cocOnly, []);
});

// ──────────────────────────────────────────────────────────────────
// formatReport — the --strict verdict must name the W5 blocker, not be self-referential (W4 R-LOW).
// (The real tree has zero known gaps post-D3; the strict-vs-default branch is exercised with a
// synthetic known-gap result, then the real-tree PARITY-HOLDS path is pinned separately.)
// ──────────────────────────────────────────────────────────────────
test("formatReport: with a known gap, --strict names the W5 blocker; default points to --strict; neither lies", () => {
  const synthetic = {
    membership: [],
    body: { cells: [], mismatches: [] },
    knownGaps: [{ surface: "codex", kind: "skills", member: "skills/x/SKILL.md", direction: "legacy-only (coverage LOSS)", gapId: "SYNTHETIC" }],
    newGaps: [],
  };
  const dflt = formatReport(synthetic, { strict: false });
  const strict = formatReport(synthetic, { strict: true });
  assert.match(dflt, /VERDICT: NO REGRESSION/);
  assert.match(dflt, /run with --strict to gate/); // default (regression) gate points to the strict gate
  assert.match(strict, /VERDICT: FAIL \(--strict/); // strict (W5-readiness) gate fails on the known gap
  assert.equal(/run with --strict to gate/.test(strict), false); // NOT self-referential once --strict is active
});

test("formatReport: real tree (D3 resolved → zero known gaps) → PARITY HOLDS under both default and --strict", () => {
  const r = runParity({ target: null });
  assert.equal(r.knownGaps.length, 0);
  assert.match(formatReport(r, { strict: false }), /VERDICT: PARITY HOLDS/);
  assert.match(formatReport(r, { strict: true }), /VERDICT: PARITY HOLDS/);
});

// ──────────────────────────────────────────────────────────────────
// W3 forward-note 1 — buildFrontmatter ↔ listField round-trip (cc-architect R3/R4 NIT).
// Pins the STRUCTURAL DEPENDENCY at coc-run.mjs:169-175: emit-coc::buildFrontmatter emits
// paths/applies_to as single-line FLOW sequences, and coc-run::listField reads ONLY flow
// form. If the producer ever switched to block form, path-scope + applies_to fidelity would
// silently read null. This test fails the moment the two sides drift.
// ──────────────────────────────────────────────────────────────────
test("forward-note: buildFrontmatter emits FLOW form that listField recovers (paths + applies_to)", () => {
  const cases = [
    { paths: ["packages/**"], appliesTo: ["codex"] },
    { paths: ["a", "b,c"], appliesTo: ["codex", "gemini"] }, // comma INSIDE a quoted glob — the load-bearing case
    { paths: ["src/**/*.py", "tests/**"], appliesTo: null },
    { paths: null, appliesTo: ["gemini"] },
  ];
  for (const { paths, appliesTo } of cases) {
    const fm = buildFrontmatter({ id: "X", paths, appliesTo, typedBlock: "" });
    if (paths) {
      // (1) producer emits FLOW form (single-line `[...]`) — the form listField requires.
      assert.match(fm, /^paths: \[.*\]$/m, `buildFrontmatter must emit flow-form paths: ${fm}`);
      // (2) consumer recovers it exactly (quote-aware comma handling included).
      assert.deepEqual(listField(fm, "paths"), paths, `listField must recover paths ${JSON.stringify(paths)}`);
    } else {
      assert.equal(listField(fm, "paths"), null);
    }
    if (appliesTo) {
      assert.match(fm, /^applies_to: \[.*\]$/m);
      assert.deepEqual(listField(fm, "applies_to"), appliesTo);
    } else {
      assert.equal(listField(fm, "applies_to"), null);
    }
  }
});

test("forward-note: splitFlowItems (the shared tokenizer) round-trips a quoted-comma item", () => {
  // emit-coc yamlQuotes each item; coc-run splitFlowItems must not split the comma inside quotes.
  const fm = buildFrontmatter({ id: "X", paths: ["weird,glob", "plain/**"], appliesTo: null, typedBlock: "" });
  assert.deepEqual(listField(fm, "paths"), ["weird,glob", "plain/**"]);
  assert.deepEqual(splitFlowItems('"weird,glob", "plain/**"'), ["weird,glob", "plain/**"]);
});

// ──────────────────────────────────────────────────────────────────
// W3 forward-note 2 — spawn-arm filename parity (cc-architect R4 LOW).
// The --print byte-parity surface cannot see a SPAWN-arm filename divergence. This pins that
// the launcher's spawn arm materializes the per-surface baseline at the canonical filename
// (CLAUDE.md / AGENTS.md / GEMINI.md — contract §7) — the exact in-home baseline filename a
// retiring per-CLI emission must preserve, and the one csq's W4 byte-parity golden must match.
// ──────────────────────────────────────────────────────────────────
test("forward-note: SURFACES.injectFile is the canonical per-surface baseline filename (retirement-preserved)", () => {
  // These are the per-CLI baseline filenames loom emits today (CLAUDE.md / AGENTS.md /
  // GEMINI.md, contract §7); the launcher spawn-arm MUST inject into the same name so a
  // .coc/-only consumer's baseline lands where each CLI reads it.
  assert.equal(SURFACES.cc.injectFile, "CLAUDE.md");
  assert.equal(SURFACES.codex.injectFile, "AGENTS.md");
  assert.equal(SURFACES.gemini.injectFile, "GEMINI.md");
});

test("forward-note: the launcher spawn-arm materializes the baseline AT that filename (not the --print path)", () => {
  const expected = { cc: "CLAUDE.md", codex: "AGENTS.md", gemini: "GEMINI.md" };
  for (const [key, name] of Object.entries(expected)) {
    const { dir, file } = materializeEphemeral("L1-SURFACE-BLOB", key);
    try {
      // the spawn arm writes the surface into the per-CLI baseline filename, under tmp (zero repo files)
      assert.equal(path.basename(file), name, `spawn-arm filename divergence for ${key}`);
      assert.ok(dir.startsWith(os.tmpdir()));
      assert.equal(fs.readFileSync(file, "utf8"), "L1-SURFACE-BLOB");
      // and the spawn plan points the CLI's config-home at that ephemeral dir
      const plan = buildSpawn(key, dir, { bin: null, passthrough: [] });
      assert.equal(plan.env[SURFACES[key].configHomeEnv], dir);
    } finally {
      reclaim(dir);
    }
  }
});
