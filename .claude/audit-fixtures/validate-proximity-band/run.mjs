#!/usr/bin/env node
/*
 * Audit fixture runner for validate-proximity-band (F23e, journal/0155).
 *
 * Structural probes per rules/probe-driven-verification.md MUST-3:
 *   - exit-code / count-of-elements / equality checks on pure-function outputs.
 *   - integration tests use temp git repos (real subprocess; no mocks).
 *   - NO semantic judgment, NO regex on assistant prose.
 *
 * Exit 0 = all fixtures pass. Exit 1 = ≥1 fixture failed.
 */

import {
  getProximityBandAdvisory,
  HEADROOM_PROXIMITY_BAND_PCT_DEFAULT,
} from "../../bin/emit.mjs";
import {
  parseFrontmatter,
  isBaselineRule,
  LOAD_BEARING_MARKERS,
} from "../../bin/validate-proximity-band.mjs";
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  cpSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

let passed = 0;
let failed = 0;

function check(name, condition, details) {
  if (condition) {
    passed++;
    process.stdout.write(`  PASS  ${name}\n`);
  } else {
    failed++;
    process.stderr.write(`  FAIL  ${name}\n`);
    if (details) process.stderr.write(`        ${details}\n`);
  }
}

function gitInit(repoDir) {
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repoDir,
  });
  execFileSync("git", ["config", "user.name", "test"], { cwd: repoDir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repoDir });
}

function gitCommit(repoDir, msg, dateIso) {
  execFileSync("git", ["add", "-A"], { cwd: repoDir });
  execFileSync(
    "git",
    ["commit", "--quiet", "-m", msg, "--allow-empty-message", "--allow-empty"],
    {
      cwd: repoDir,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: dateIso,
        GIT_COMMITTER_DATE: dateIso,
      },
    },
  );
}

// Resolve canonical paths to the validator + emit script for subprocess
// integration tests (fixtures 02 / 03 / 06 / 07 / 09 / 10).
const __filename = fileURLToPath(import.meta.url);
const VALIDATOR_SCRIPT = __filename.replace(
  /\/audit-fixtures\/.*$/,
  "/bin/validate-proximity-band.mjs",
);
const EMIT_SCRIPT = __filename.replace(
  /\/audit-fixtures\/.*$/,
  "/bin/emit.mjs",
);

// Build a minimal-but-faithful temp loom repo with the bin/ scripts +
// rules/ + sync-manifest.yaml needed for emit.mjs to run. Copy from
// the real repo's checked-in artifacts so the temp repo behaves
// identically to a live /sync invocation. The bin/ + rules/ + manifest
// surface is shared across all integration fixtures.
function buildTempLoomRepo(tag) {
  const dir = join(tmpdir(), `f23e-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  gitInit(dir);
  // Copy the LIVE .claude/bin + .claude/rules + .claude/skills + manifest
  // + supporting files. Live copy is the cheapest way to keep emit.mjs's
  // dependencies satisfied without re-stubbing every helper.
  const realRoot = __filename.replace(/\/\.claude\/audit-fixtures\/.*$/, "");
  cpSync(join(realRoot, ".claude", "bin"), join(dir, ".claude", "bin"), {
    recursive: true,
  });
  cpSync(join(realRoot, ".claude", "rules"), join(dir, ".claude", "rules"), {
    recursive: true,
  });
  // Skills directory is referenced by the abridge / extract-paths logic
  // inside emit.mjs's composer. Copy in full so emit doesn't choke on a
  // missing skill referenced from a rule.
  if (existsSync(join(realRoot, ".claude", "skills"))) {
    cpSync(join(realRoot, ".claude", "skills"), join(dir, ".claude", "skills"), {
      recursive: true,
    });
  }
  // sync-manifest.yaml lives at .claude/sync-manifest.yaml per emit.mjs
  // REPO resolution (REPO = .claude/bin/.. /.. = repo root; manifest at
  // .claude/sync-manifest.yaml relative to REPO).
  if (existsSync(join(realRoot, ".claude", "sync-manifest.yaml"))) {
    copyFileSync(
      join(realRoot, ".claude", "sync-manifest.yaml"),
      join(dir, ".claude", "sync-manifest.yaml"),
    );
  }
  // .claude/VERSION carries the repo CLASS. Without it emit.mjs's Validator 16
  // resolves class UNRESOLVED and fails CLOSED, so the emit dry-run exits 1 and
  // parses ZERO lanes — which, before loom#1537's coverage floor, silently
  // turned fixtures 02/03/06/07 into vacuous passes: they asserted on a verdict
  // computed from a lane set that was always empty. Copying VERSION is what
  // makes those four fixtures discriminate at all.
  if (existsSync(join(realRoot, ".claude", "VERSION"))) {
    copyFileSync(
      join(realRoot, ".claude", "VERSION"),
      join(dir, ".claude", "VERSION"),
    );
  }
  // .claude/codex-mcp-guard policies fixtures are consulted by validator-13.
  if (existsSync(join(realRoot, ".claude", "codex-mcp-guard"))) {
    cpSync(
      join(realRoot, ".claude", "codex-mcp-guard"),
      join(dir, ".claude", "codex-mcp-guard"),
      { recursive: true },
    );
  }
  // settings.json + supporting policy fixtures
  if (existsSync(join(realRoot, ".claude", "settings.json"))) {
    copyFileSync(
      join(realRoot, ".claude", "settings.json"),
      join(dir, ".claude", "settings.json"),
    );
  }
  if (existsSync(join(realRoot, ".claude", "audit-fixtures"))) {
    cpSync(
      join(realRoot, ".claude", "audit-fixtures"),
      join(dir, ".claude", "audit-fixtures"),
      { recursive: true },
    );
  }
  // Validator 13 reads .claude/fixtures/validator-13/expected-policies.json —
  // NOT .claude/audit-fixtures/. The copy above named the wrong directory, so
  // Validator 13 failed on every temp repo and emit exited 1. That was
  // invisible while a non-zero emit exit still produced a "clean" verdict;
  // loom#1537's coverage floor is what surfaced it.
  if (existsSync(join(realRoot, ".claude", "fixtures"))) {
    cpSync(
      join(realRoot, ".claude", "fixtures"),
      join(dir, ".claude", "fixtures"),
      { recursive: true },
    );
  }
  // Initial commit = "main" baseline.
  gitCommit(dir, "init from live tree", "2026-05-23T12:00:00Z");
  return dir;
}

function runValidator(repoRoot, extraArgs = []) {
  const result = spawnSync(
    "node",
    [VALIDATOR_SCRIPT, "--repo-root", repoRoot, ...extraArgs],
    { encoding: "utf8", cwd: repoRoot },
  );
  return result;
}

// ------------------------------------------------------------------
// fixture-01-no-near-breach
// ------------------------------------------------------------------
// Direct helper call: getProximityBandAdvisory at 20% headroom (> 15%
// band) returns null. No subprocess needed.
{
  const BLOCK_CAP = 61440;
  // emissionBytes producing 20% headroom: 0.80 * BLOCK_CAP = 49152
  const advisory = getProximityBandAdvisory({
    cli: "codex",
    lang: "base",
    emissionBytes: 49152,
    blockCap: BLOCK_CAP,
    floorPct: 10,
    proximityBandPct: 15,
  });
  check(
    "fixture-01-no-near-breach",
    advisory === null,
    `expected null (20% headroom > 15% band); got ${JSON.stringify(advisory)}`,
  );
}

// ------------------------------------------------------------------
// fixture-02-near-breach-no-diff
// ------------------------------------------------------------------
// Subprocess integration: live tree has near-breach lanes (13.92%
// codex / 13.54% gemini per current emit output) BUT diff is empty
// (HEAD..HEAD). Expect verdict=advisory_only_no_diff, exit 0.
{
  const tmp = buildTempLoomRepo("fix-02");
  try {
    const result = runValidator(tmp, ["--base", "HEAD", "--head", "HEAD", "--json"]);
    let report = null;
    try {
      report = JSON.parse(result.stdout || "{}");
    } catch {
      // fall through
    }
    check(
      "fixture-02-near-breach-no-diff",
      result.status === 0 &&
        report &&
        report.rule_10_fires === false &&
        report.verdict === "advisory_only_no_diff" &&
        report.near_breach_lanes.length > 0 &&
        report.proposal_diff.baseline_additions_total === 0,
      `exit=${result.status} verdict=${report?.verdict} ` +
        `near_breach=${report?.near_breach_lanes?.length} ` +
        `baseline_additions=${report?.proposal_diff?.baseline_additions_total} ` +
        `stderr=${(result.stderr || "").slice(0, 300)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-03-near-breach-with-diff
// ------------------------------------------------------------------
// Subprocess integration: create a SECOND commit that adds a NEW MUST
// clause to a known baseline rule. Diff main..HEAD now shows a
// baseline addition; emit lanes are still near-breach → Rule 10 fires.
{
  const tmp = buildTempLoomRepo("fix-03");
  try {
    // Identify a known baseline rule (priority: 0, scope: baseline).
    // security.md is a canonical baseline rule per emit.mjs::getCritBaseline.
    const targetRule = join(tmp, ".claude", "rules", "security.md");
    if (!existsSync(targetRule)) {
      check(
        "fixture-03-near-breach-with-diff",
        false,
        `setup: target rule security.md not present in temp tree`,
      );
    } else {
      // Confirm baseline-at-head.
      const isBL = isBaselineRule(".claude/rules/security.md", tmp);
      if (!isBL) {
        check(
          "fixture-03-near-breach-with-diff",
          false,
          `setup: .claude/rules/security.md not classified as baseline at HEAD (frontmatter mismatch)`,
        );
      } else {
        // Append a new MUST clause to the rule body.
        const cur = execFileSync(
          "git",
          ["show", "HEAD:.claude/rules/security.md"],
          { cwd: tmp, encoding: "utf8" },
        );
        writeFileSync(
          targetRule,
          cur + "\n\n## F23e Fixture Probe\n\nMUST exercise the validator gate.\n",
        );
        execFileSync("git", ["checkout", "-b", "feat/f23e-fixture-03"], {
          cwd: tmp,
        });
        gitCommit(tmp, "test: add MUST clause", "2026-05-23T13:00:00Z");

        const result = runValidator(tmp, [
          "--base",
          "main",
          "--head",
          "HEAD",
          "--json",
        ]);
        let report = null;
        try {
          report = JSON.parse(result.stdout || "{}");
        } catch {
          // fall through
        }
        check(
          "fixture-03-near-breach-with-diff",
          result.status === 1 &&
            report &&
            report.rule_10_fires === true &&
            report.verdict === "fires" &&
            report.near_breach_lanes.length > 0 &&
            report.proposal_diff.baseline_additions_total >= 1,
          `exit=${result.status} verdict=${report?.verdict} ` +
            `near_breach=${report?.near_breach_lanes?.length} ` +
            `baseline_additions=${report?.proposal_diff?.baseline_additions_total} ` +
            `stderr=${(result.stderr || "").slice(0, 300)}`,
        );
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-04-band-edge-15pct
// ------------------------------------------------------------------
// F23a's band edge is EXCLUSIVE: headroom == proximityBandPct → null.
// Mirrors proximity-band-budget fixture-03 to lock the symmetric edge
// behavior at the composition layer.
{
  const BLOCK_CAP = 61440;
  // 85% used = 15% headroom EXACTLY
  const advisory = getProximityBandAdvisory({
    cli: "codex",
    lang: "base",
    emissionBytes: 52224,
    blockCap: BLOCK_CAP,
    floorPct: 10,
    proximityBandPct: 15,
  });
  check(
    "fixture-04-band-edge-15pct",
    advisory === null,
    `expected null at exact band edge; got ${JSON.stringify(advisory)}`,
  );
}

// ------------------------------------------------------------------
// fixture-05-misconfig-band-le-floor
// ------------------------------------------------------------------
// proximityBandPct <= floorPct → null (security M4 defense).
{
  const BLOCK_CAP = 61440;
  const advisory = getProximityBandAdvisory({
    cli: "codex",
    lang: "base",
    emissionBytes: 54068,
    blockCap: BLOCK_CAP,
    floorPct: 15,
    proximityBandPct: 10,
  });
  check(
    "fixture-05-misconfig-band-le-floor",
    advisory === null,
    `expected null on band<=floor misconfig; got ${JSON.stringify(advisory)}`,
  );
}

// ------------------------------------------------------------------
// fixture-06-diff-only-path-scoped
// ------------------------------------------------------------------
// A diff that adds a MUST clause to a `scope: path-scoped` rule MUST
// NOT contribute to Rule 10's trigger (per Rule 10 Trigger scope:
// fires on priority:0 + scope:baseline rules ONLY). Even with near-
// breach lanes present, rule_10_fires=false because baseline_additions=0.
{
  const tmp = buildTempLoomRepo("fix-06");
  try {
    // Create a NEW path-scoped rule (no priority:0) so the diff only
    // touches a non-baseline rule.
    const pathScopedRule = join(
      tmp,
      ".claude",
      "rules",
      "f23e-fixture-path-scoped.md",
    );
    writeFileSync(
      pathScopedRule,
      "---\nscope: path-scoped\npriority: 10\npaths: \"foo/**\"\n---\n\n# Test path-scoped rule\n\nMUST not fire Rule 10.\n",
    );
    // Declare the synthetic rule loom-only in the TEMP repo's manifest.
    // emit.mjs's Validator 15 (tier-completeness) fails closed on any
    // undeclared .claude/rules/*.md, so without this the emit dry-run exits 1
    // and this fixture asserts against a zero-lane run. It passed anyway until
    // loom#1537's coverage floor made a non-measuring run visible.
    const tmpManifest = join(tmp, ".claude", "sync-manifest.yaml");
    writeFileSync(
      tmpManifest,
      readFileSync(tmpManifest, "utf8").replace(
        /^use_exclude:$/m,
        "use_exclude:\n  - rules/f23e-fixture-path-scoped.md",
      ),
    );
    execFileSync("git", ["checkout", "-b", "feat/f23e-fixture-06"], {
      cwd: tmp,
    });
    gitCommit(tmp, "test: add path-scoped rule with MUST", "2026-05-23T13:00:00Z");

    const result = runValidator(tmp, [
      "--base",
      "main",
      "--head",
      "HEAD",
      "--json",
    ]);
    let report = null;
    try {
      report = JSON.parse(result.stdout || "{}");
    } catch {
      // fall through
    }
    check(
      "fixture-06-diff-only-path-scoped",
      result.status === 0 &&
        report &&
        report.rule_10_fires === false &&
        // additions on path-scoped rules are recorded but NOT baseline
        report.proposal_diff.additions_total >= 1 &&
        report.proposal_diff.baseline_additions_total === 0,
      `exit=${result.status} verdict=${report?.verdict} ` +
        `additions_total=${report?.proposal_diff?.additions_total} ` +
        `baseline_additions=${report?.proposal_diff?.baseline_additions_total} ` +
        `stderr=${(result.stderr || "").slice(0, 300)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-07-empty-diff
// ------------------------------------------------------------------
// No commits beyond main → diff HEAD..HEAD is empty; additions_total=0.
// Verdict is either advisory_only_no_diff (near-breach lanes exist) or
// clean (no near-breach). Either way exit 0.
{
  const tmp = buildTempLoomRepo("fix-07");
  try {
    const result = runValidator(tmp, [
      "--base",
      "HEAD",
      "--head",
      "HEAD",
      "--json",
    ]);
    let report = null;
    try {
      report = JSON.parse(result.stdout || "{}");
    } catch {
      // fall through
    }
    check(
      "fixture-07-empty-diff",
      result.status === 0 &&
        report &&
        report.rule_10_fires === false &&
        report.proposal_diff.additions_total === 0,
      `exit=${result.status} additions_total=${report?.proposal_diff?.additions_total} ` +
        `stderr=${(result.stderr || "").slice(0, 300)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-08-multiple-lanes-mixed
// ------------------------------------------------------------------
// Direct helper call exercises (a) within-band advisory, (b) above-band
// null, (c) below-floor null — three lanes from one BLOCK_CAP. The
// validator's near-breach predicate is exercised at the composition
// layer in fixtures 02 + 03 + 07; here we lock the per-lane helper
// shape that the composition layer consumes.
{
  const BLOCK_CAP = 61440;
  const lanes = [
    // within band (12% headroom) → advisory
    getProximityBandAdvisory({
      cli: "codex",
      lang: "rs",
      emissionBytes: 54068,
      blockCap: BLOCK_CAP,
      floorPct: 10,
      proximityBandPct: 15,
    }),
    // above band (20% headroom) → null
    getProximityBandAdvisory({
      cli: "gemini",
      lang: "rs",
      emissionBytes: 49152,
      blockCap: BLOCK_CAP,
      floorPct: 10,
      proximityBandPct: 15,
    }),
    // below floor (8.76% headroom) → null (BLOCK path)
    getProximityBandAdvisory({
      cli: "codex",
      lang: "py",
      emissionBytes: 56058,
      blockCap: BLOCK_CAP,
      floorPct: 10,
      proximityBandPct: 15,
    }),
  ];
  check(
    "fixture-08-multiple-lanes-mixed",
    lanes[0] !== null &&
      lanes[0].cli === "codex" &&
      lanes[0].lang === "rs" &&
      Math.abs(lanes[0].headroom_pct - 12) < 0.01 &&
      lanes[1] === null &&
      lanes[2] === null,
    `lanes=${JSON.stringify(lanes.map((l) => (l ? { cli: l.cli, lang: l.lang, hp: l.headroom_pct } : null)))}`,
  );
}

// ------------------------------------------------------------------
// fixture-09-help-exit-0
// ------------------------------------------------------------------
// Subprocess: --help exits 0 with usage text.
{
  const result = spawnSync("node", [VALIDATOR_SCRIPT, "--help"], {
    encoding: "utf8",
  });
  check(
    "fixture-09-help-exit-0",
    result.status === 0 &&
      result.stdout &&
      result.stdout.includes("usage:") &&
      result.stdout.includes("Rule 10"),
    `exit=${result.status} stdout-prefix=${(result.stdout || "").slice(0, 100)}`,
  );
  // loom#1539 (E) — the usage text must document EVERY exit code the script
  // can return. It documented 0/1/2 while `main()` had exited 3 on an UNRUN
  // run since loom#1537, and this fixture asserted only "exit 0 + contains
  // usage:", so nothing caught the omission. An operator reading --help got a
  // list that did not contain the code the gate actually returns when it
  // cannot look. Assert each code is documented, not just that help printed.
  const help = result.stdout || "";
  const exitSection = help.slice(help.indexOf("exit codes:"));
  check(
    "fixture-09b-help-documents-every-exit-code",
    help.includes("exit codes:") &&
      /^\s*0\s/m.test(exitSection) &&
      /^\s*1\s/m.test(exitSection) &&
      /^\s*2\s/m.test(exitSection) &&
      /^\s*3\s+UNRUN/m.test(exitSection) &&
      /coverage_asserted/.test(exitSection),
    `exit-codes section=${JSON.stringify(exitSection.slice(0, 400))}`,
  );
}

// ------------------------------------------------------------------
// fixture-10-malformed-flag-exit-2
// ------------------------------------------------------------------
// Subprocess: unknown flag exits 2.
{
  const result = spawnSync(
    "node",
    [VALIDATOR_SCRIPT, "--this-flag-does-not-exist"],
    { encoding: "utf8" },
  );
  check(
    "fixture-10-malformed-flag-exit-2",
    result.status === 2 && /unknown flag/i.test(result.stderr || ""),
    `exit=${result.status} stderr=${(result.stderr || "").slice(0, 200)}`,
  );
}

// ------------------------------------------------------------------
// fixture-11-unrun-zero-lanes-exits-nonzero  (regression — loom#1537)
// ------------------------------------------------------------------
// The vacuity regression. Before the fix the final exit was
// `ruleFires ? 1 : 0`; ruleFires derives from emit.lanes, so a FAILED emit
// dry-run parsed zero lanes, no lane could be near-breach, and the gate
// exited 0 printing "verdict: clean" — reporting success precisely because
// it measured nothing. This fixture pins the fail-closed replacement.
//
// The emit dry-run is broken the way a real one breaks — the SPAWNED run
// exits non-zero — while emit.mjs still LOADS, because this validator
// statically imports getProximityBandAdvisory from it. A wrapper that
// re-exports the real module and exits 2 as main produces exactly the
// `exit=2, 0 lane(s) scanned` shape #1537 reports.
{
  const repo = buildTempLoomRepo("unrun");
  const emitPath = join(repo, ".claude", "bin", "emit.mjs");
  copyFileSync(emitPath, join(repo, ".claude", "bin", "emit.real.mjs"));
  writeFileSync(
    emitPath,
    'export * from "./emit.real.mjs";\n' +
      "if (import.meta.url === `file://${process.argv[1]}`) {\n" +
      '  process.stderr.write("simulated emit dry-run failure\\n");\n' +
      "  process.exit(2);\n" +
      "}\n",
  );
  gitCommit(repo, "break the emit dry-run", "2026-05-23T12:05:00Z");

  const text = runValidator(repo, ["--base", "HEAD", "--head", "HEAD"]);
  check(
    "fixture-11-unrun-zero-lanes-exits-nonzero",
    text.status === 3 &&
      /verdict: unrun_no_coverage/.test(text.stdout || "") &&
      /UNRUN — NO LANE COVERAGE/.test(text.stdout || "") &&
      !/verdict: clean/.test(text.stdout || ""),
    `exit=${text.status} (want 3) stdout-tail=${(text.stdout || "").slice(-400)}`,
  );

  const json = runValidator(repo, [
    "--base",
    "HEAD",
    "--head",
    "HEAD",
    "--json",
  ]);
  let parsed = null;
  try {
    parsed = JSON.parse(json.stdout || "{}");
  } catch {
    /* leave null — the check below fails loudly */
  }
  check(
    "fixture-11b-unrun-json-coverage-asserted-false",
    json.status === 3 &&
      parsed !== null &&
      parsed.coverage_asserted === false &&
      parsed.ok === false &&
      parsed.verdict === "unrun_no_coverage" &&
      Array.isArray(parsed.unrun_reasons) &&
      parsed.unrun_reasons.length === 2,
    `exit=${json.status} parsed=${JSON.stringify(parsed && { ok: parsed.ok, verdict: parsed.verdict, ca: parsed.coverage_asserted, ur: parsed.unrun_reasons })}`,
  );
  rmSync(repo, { recursive: true, force: true });
}

// ------------------------------------------------------------------
// fixture-12-emit-loads-without-codex-surface  (regression — loom#1538)
// ------------------------------------------------------------------
// emit.mjs held a TOP-LEVEL import of ../codex-mcp-guard/extract-policies.mjs,
// a codex-lane artifact a cc-only template (clis: [claude]) correctly does
// not ship. Module load therefore failed with ERR_MODULE_NOT_FOUND on those
// repos, taking validate-emit.mjs AND this validator (which imports emit.mjs
// statically) down with it. This fixture pins that emit.mjs LOADS with no
// codex surface present, and that the extractor still fails AT USE with a
// message naming the missing surface rather than an opaque loader error.
{
  const repo = buildTempLoomRepo("nocodex");
  rmSync(join(repo, ".claude", "codex-mcp-guard"), {
    recursive: true,
    force: true,
  });
  check(
    "fixture-12-precondition-no-codex-surface",
    !existsSync(join(repo, ".claude", "codex-mcp-guard")),
    "codex-mcp-guard still present; the probe would not discriminate",
  );

  const emitUrl = pathToFileURL(join(repo, ".claude", "bin", "emit.mjs")).href;
  const probe = spawnSync(
    "node",
    [
      "-e",
      `import(${JSON.stringify(emitUrl)}).then(async (m) => {
         const surface = m.hasCodexGuardSurface();
         const v13 = await m.validateMcpBijectionAgainstFixtures();
         let threw = "";
         try { await m.wireMcpPolicies(${JSON.stringify(join(repo, "out"))}); }
         catch (e) { threw = e.message; }
         console.log(JSON.stringify({ loaded: true, surface, v13, threw }));
       }, (e) => { console.log(JSON.stringify({ loaded: false, code: e.code })); });`,
    ],
    { encoding: "utf8" },
  );
  let out = null;
  try {
    out = JSON.parse((probe.stdout || "").trim());
  } catch {
    /* leave null — the check below fails loudly */
  }
  check(
    "fixture-12-emit-loads-without-codex-surface",
    out !== null &&
      out.loaded === true &&
      out.surface === false &&
      out.v13 &&
      out.v13.skipped === true &&
      /codex surface absent/.test(out.threw || "") &&
      /codex-mcp-guard/.test(out.threw || ""),
    `probe=${JSON.stringify(out)} stderr=${(probe.stderr || "").slice(0, 300)}`,
  );
  rmSync(repo, { recursive: true, force: true });
}

// ------------------------------------------------------------------
// fixture-13 / 13b — headroom measurement survives ADVISORY-line drift,
//                    and NO carrier at all is UNRUN   (regression — loom#1539 B)
// ------------------------------------------------------------------
// The severest #1539 defect: `advisoryRe` was the ONLY carrier of headroom on
// emit's stdout, and a non-match was INTERPRETED AS CLEAN. A one-token edit in
// emit.mjs (`headroom ` → `headroom of `) made the gate report both 13.46%
// lanes as `headroom=(above band)`, `near-breach lanes: 0`, `verdict: clean`,
// exit 0 — a FALSE CLEAN, on a tree where Rule 10 would then silently fail to
// fire on a baseline MUST addition.
//
// Two arms, because the fix has two halves and each can regress alone:
//   13   emit now prints headroom UNCONDITIONALLY, so drifting the ADVISORY
//        line loses the FLAG but never the MEASUREMENT — the lane is still
//        correctly near-breach. Reds if emit's unconditional line is removed
//        or if the validator goes back to reading headroom from the advisory.
//   13b  drift BOTH carriers and the lane has no measurement at all — that
//        must be UNRUN (exit 3), never "above band". Reds if the
//        headroom_pct===null clause is dropped from the coverage floor.
{
  const repo = buildTempLoomRepo("advdrift");
  const emitPath = join(repo, ".claude", "bin", "emit.mjs");
  const original = readFileSync(emitPath, "utf8");

  // ARM 13 — drift the ADVISORY line only.
  const ADV_NEEDLE = "] ADVISORY: headroom ${proximityBandAdvisory.headroom_pct}%";
  const advMutated = original.replace(
    ADV_NEEDLE,
    "] ADVISORY: headroom of ${proximityBandAdvisory.headroom_pct}%",
  );
  // Prove the mutation REACHED the code under test. A no-op string replace
  // would leave the run green for the wrong reason — an inert mutation read
  // as a passing probe (`instrument-discipline.md` MUST-2b).
  const advMutationLanded =
    original.includes(ADV_NEEDLE) && advMutated !== original;
  writeFileSync(emitPath, advMutated);
  gitCommit(repo, "drift the ADVISORY line", "2026-05-23T12:10:00Z");

  const advRun = runValidator(repo, ["--base", "HEAD", "--head", "HEAD", "--json"]);
  let advReport = null;
  try {
    advReport = JSON.parse(advRun.stdout || "{}");
  } catch {
    /* leave null — the check below fails loudly */
  }
  check(
    "fixture-13-headroom-survives-advisory-line-drift",
    advMutationLanded &&
      advRun.status === 0 &&
      advReport &&
      advReport.coverage_asserted === true &&
      advReport.emit.lanes_scanned === 2 &&
      // the FLAG is gone (that is what drifted) …
      advReport.emit.lanes.every((l) => l.advisory_fired === false) &&
      // … but the MEASUREMENT is not, and the band verdict is unchanged.
      advReport.emit.lanes.every(
        (l) => typeof l.headroom_pct === "number" && l.headroom_pct !== null,
      ) &&
      advReport.emit.lanes.every((l) => l.headroom_source === "headroom_line") &&
      advReport.near_breach_lanes.length === 2 &&
      advReport.verdict === "advisory_only_no_diff",
    `mutation_landed=${advMutationLanded} exit=${advRun.status} verdict=${advReport?.verdict} ` +
      `near_breach=${advReport?.near_breach_lanes?.length} ` +
      `lanes=${JSON.stringify(advReport?.emit?.lanes?.map((l) => ({ cli: l.cli, hp: l.headroom_pct, src: l.headroom_source })))}`,
  );

  // ARM 13b — drift the unconditional line too: no carrier remains.
  const HR_NEEDLE = "] headroom: ${headroomPctForReport}%";
  const bothMutated = advMutated.replace(
    HR_NEEDLE,
    "] headroom-pct: ${headroomPctForReport}%",
  );
  const bothMutationLanded =
    advMutated.includes(HR_NEEDLE) && bothMutated !== advMutated;
  writeFileSync(emitPath, bothMutated);
  gitCommit(repo, "drift the unconditional headroom line too", "2026-05-23T12:11:00Z");

  const bothRun = runValidator(repo, ["--base", "HEAD", "--head", "HEAD", "--json"]);
  let bothReport = null;
  try {
    bothReport = JSON.parse(bothRun.stdout || "{}");
  } catch {
    /* leave null — the check below fails loudly */
  }
  check(
    "fixture-13b-no-headroom-carrier-is-unrun-not-clean",
    bothMutationLanded &&
      bothRun.status === 3 &&
      bothReport &&
      bothReport.ok === false &&
      bothReport.coverage_asserted === false &&
      bothReport.verdict === "unrun_no_coverage" &&
      // 2 lanes still PARSE (the tier line is untouched) — this is precisely
      // the case the old floor waved through: lanes present, measurement absent.
      bothReport.emit.lanes_scanned === 2 &&
      bothReport.emit.lanes.every((l) => l.headroom_pct === null) &&
      bothReport.unrun_reasons.some((r) => /NO headroom measurement/.test(r)),
    `mutation_landed=${bothMutationLanded} exit=${bothRun.status} verdict=${bothReport?.verdict} ` +
      `lanes_scanned=${bothReport?.emit?.lanes_scanned} reasons=${JSON.stringify(bothReport?.unrun_reasons)}`,
  );

  rmSync(repo, { recursive: true, force: true });
}

// ------------------------------------------------------------------
// fixture-14 / 14b — the DIFF half of the gate has a coverage floor too
//                                                (regression — loom#1539 A)
// ------------------------------------------------------------------
// `ruleFires` has TWO inputs; only `emit` was floored. The diff scanner
// swallows every git failure into `ok:false` + an EMPTY additions array, and
// Rule 10 fires only on a NON-empty one — so a failed diff was
// indistinguishable from a clean one, and nothing read `diff.ok`. Measured
// before the fix: `--head refs/heads/does-not-exist-xyz` returned `ok: true`,
// `coverage_asserted: true`, `verdict: advisory_only_no_diff`, exit 0 while
// carrying `proposal_diff.ok: false` and `fatal: bad revision`.
//
//   14   unresolvable --head is a LOUD exit 2 (the pre-check validated only
//        --base). Reds if the head arm of the ref pre-check is removed.
//   14b  refs that DO resolve but whose diff still fails — the residue the
//        pre-check cannot cover (in production: a 30s timeout or a 64MB
//        maxBuffer overflow, both with perfectly valid refs). Reproduced
//        deterministically with a ref pointing at a BLOB: `rev-parse --verify`
//        succeeds, `git diff` exits 129. Must be UNRUN, not clean. Reds if
//        `!diff.ok` is dropped from the coverage floor.
{
  const repo = buildTempLoomRepo("difffloor");

  const badHead = runValidator(repo, [
    "--base",
    "HEAD",
    "--head",
    "refs/heads/does-not-exist-xyz",
    "--json",
  ]);
  check(
    "fixture-14-unresolvable-head-ref-exit-2",
    badHead.status === 2 &&
      /--head ref .* is not resolvable/.test(badHead.stderr || "") &&
      // must NOT have produced a verdict at all
      !/"verdict"/.test(badHead.stdout || ""),
    `exit=${badHead.status} (want 2) stderr=${(badHead.stderr || "").slice(0, 300)}`,
  );

  // A tag pointing at a BLOB: resolvable by rev-parse --verify, unusable by
  // git diff. This is the ONLY arm that exercises the `!diff.ok` clause —
  // without it the clause is unreachable from the fixture suite.
  const blobSha = execFileSync(
    "git",
    ["rev-parse", "HEAD:.claude/sync-manifest.yaml"],
    { cwd: repo, encoding: "utf8" },
  ).trim();
  execFileSync("git", ["tag", "blobref", blobSha], { cwd: repo });
  const revParseOk = execFileSync(
    "git",
    ["rev-parse", "--verify", "blobref"],
    { cwd: repo, encoding: "utf8" },
  ).trim();

  const blobRun = runValidator(repo, [
    "--base",
    "blobref",
    "--head",
    "blobref",
    "--json",
  ]);
  let blobReport = null;
  try {
    blobReport = JSON.parse(blobRun.stdout || "{}");
  } catch {
    /* leave null — the check below fails loudly */
  }
  check(
    "fixture-14b-failed-diff-scan-is-unrun-not-clean",
    // precondition: the ref really does pass the pre-check, so this arm
    // reaches the diff scanner rather than exiting 2 upstream of it
    revParseOk === blobSha &&
      blobRun.status === 3 &&
      blobReport &&
      blobReport.ok === false &&
      blobReport.coverage_asserted === false &&
      blobReport.verdict === "unrun_no_coverage" &&
      blobReport.proposal_diff.ok === false &&
      // the emit half is FINE — this proves the diff half floored it
      blobReport.emit.lanes_scanned === 2 &&
      blobReport.unrun_reasons.some((r) => /proposal diff scan FAILED/.test(r)),
    `revParseOk=${revParseOk === blobSha} exit=${blobRun.status} verdict=${blobReport?.verdict} ` +
      `diff_ok=${blobReport?.proposal_diff?.ok} lanes=${blobReport?.emit?.lanes_scanned} ` +
      `reasons=${JSON.stringify(blobReport?.unrun_reasons)}`,
  );

  rmSync(repo, { recursive: true, force: true });
}

// ------------------------------------------------------------------
// fixture-15 — a PARTIAL lane set is UNRUN     (regression — loom#1539 C)
// ------------------------------------------------------------------
// `lanes.length === 0` was the only cardinality check, so HALF a lane set
// passed the floor: mutating one CLI's tier line yielded `1 lane(s) scanned`,
// `coverage_asserted: true`, exit 0. The dropped lane is exactly where an
// unmeasured near-breach hides. The expected count is derived from the shared
// axis declaration (EMIT_CLIS × langs), so this reds if that derivation is
// replaced by a restated literal that drifts, or removed.
{
  const repo = buildTempLoomRepo("partial");
  const emitPath = join(repo, ".claude", "bin", "emit.mjs");
  const original = readFileSync(emitPath, "utf8");
  const TIER_NEEDLE = "${result.tier}: ${result.rules} rules,";
  const mutated = original.replace(
    TIER_NEEDLE,
    '${result.tier}: ${result.rules} ${cli === "codex" ? "rule(s)" : "rules"},',
  );
  const mutationLanded = original.includes(TIER_NEEDLE) && mutated !== original;
  writeFileSync(emitPath, mutated);
  gitCommit(repo, "drift the codex tier line only", "2026-05-23T12:12:00Z");

  const run = runValidator(repo, ["--base", "HEAD", "--head", "HEAD", "--json"]);
  let report = null;
  try {
    report = JSON.parse(run.stdout || "{}");
  } catch {
    /* leave null — the check below fails loudly */
  }
  check(
    "fixture-15-partial-lane-set-is-unrun-not-clean",
    mutationLanded &&
      run.status === 3 &&
      report &&
      report.ok === false &&
      report.coverage_asserted === false &&
      report.verdict === "unrun_no_coverage" &&
      // the surviving lane parses and is even near-breach — the old floor saw
      // a non-empty lane array and asserted coverage on it
      report.emit.lanes_scanned === 1 &&
      report.unrun_reasons.some((r) =>
        /produced 1 lane\(s\) but 2 were expected/.test(r),
      ),
    `mutation_landed=${mutationLanded} exit=${run.status} verdict=${report?.verdict} ` +
      `lanes_scanned=${report?.emit?.lanes_scanned} reasons=${JSON.stringify(report?.unrun_reasons)}`,
  );

  rmSync(repo, { recursive: true, force: true });
}

// ------------------------------------------------------------------
process.stdout.write(`\n${passed}/${passed + failed} fixtures pass\n`);
process.exit(failed === 0 ? 0 : 1);
