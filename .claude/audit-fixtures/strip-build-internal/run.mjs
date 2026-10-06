#!/usr/bin/env node
// Audit fixtures for .claude/bin/lib/strip-build-internal.mjs.
//
// Per rules/cc-artifacts.md Rule 9, every mechanical audit tool MUST
// ship with at least one committed fixture per scope-restriction
// predicate. This runner exercises:
//   (a) the helper's built-in self-test (inline fixtures; the count is
//       asserted HERE, not by the helper — the helper prints ${pass}/${pass},
//       a self-derived ratio that agrees with itself at any corpus size)
//   (b) external-file fixtures that real /sync emissions would hit,
//       so a future refactor that drops in-source fixtures still has
//       a separate audit trail on disk.
//   (c) idempotence over a DISCOVERED corpus, with a non-vacuity floor.
//   (d) the repo-class scope restriction on the workspace-name derivation.
//
// Exits non-zero on any failure.
//
// OPTIONAL: `--module <abs-path>` points ONLY the section-4 scoping probe at a
// different copy of the helper. Sections 1–3 always exercise this repo's helper.
// It exists so the section-4 red/green poles can be run on the SAME harness
// against a pre-fix and post-fix helper; it is not used by any automated caller.

import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  stripBuildInternalReferences,
} from "../../bin/lib/strip-build-internal.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..", "..");

let failures = 0;
function check(name, cond, detail = "") {
  const tag = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`${tag}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── 1. Run the helper's inline self-test as a sub-process to assert
//      the canonical pattern set still passes — failure here means
//      a code change broke one of the codified Phase-4 patterns.
import { spawnSync } from "node:child_process";
const helperPath = path.resolve(
  __dirname,
  "..",
  "..",
  "bin",
  "lib",
  "strip-build-internal.mjs",
);
const selftest = spawnSync("node", [helperPath, "--selftest"], {
  encoding: "utf8",
});
check(
  "helper --selftest exits 0",
  selftest.status === 0,
  selftest.stdout.trim(),
);

// THE EXIT STATUS ALONE IS NOT COVERAGE, and the helper's own ratio cannot
// supply the missing half. `selftest()` prints `${pass}/${pass}` — the SAME
// variable on both sides of the slash — so "39/39" reads as a ratio but is a
// TAUTOLOGY: the denominator is derived from the numerator and the two agree
// under every input. It is the self-derived oracle `evidence-first-claims.md`
// MUST-5 names, and it means a `passed === total` assertion would ALSO pass at
// "2/2". Measured: deleting all but two SELF_TEST_FIXTURES entries left the
// helper printing "2/2 pass", returning true and exiting 0, while this file
// stayed 6/6 GREEN and its declared min_cases of 6 stayed satisfied — 37 inner
// assertions silently gone with nothing red.
//
// So the COUNT is asserted here, against a number this file owns and the helper
// cannot derive. The numerator is real (fixtures that actually passed; a
// failure takes the other branch and exits 1), so pinning it pins the corpus.
// EXACT, not a floor: a floor that lags observed is the drift class that left
// two registry entries under-declared, and an added fixture SHOULD cost one
// deliberate edit here rather than silently widening the gate.
// 39 -> 56 when this branch landed on the s62 integration branch. The pin was
// written 2026-08-18 against a helper carrying 39 inline fixtures; main had
// since grown SELF_TEST_FIXTURES to 56, and that merge did not touch
// bin/lib/strip-build-internal.mjs, so 56 was main's own count and 39 was simply
// stale.
//
// 56 -> 60 (2026-09-06). `a87374d7` (round-2 docket redteam) added FOUR inline
// fixtures — loom-workspace-bare-name-punctuated, -before-paren, -sentence-end,
// and preserve-workspace-name-prefix-of-longer-token — and did NOT bump this
// pin, which is verbatim the drift the failure text below names ("added without
// bumping SELF_TEST_FIXTURE_COUNT here"). The assertion caught it and held it
// red for three commits; this is the assertion WORKING, not being worked around.
//
// 63 -> 64 (2026-10-04, strip lane Tier-1 redesign). The org fixtures were
// restructured to the PRIVATE/PUBLIC split: the two "bare canon org slug"
// rewrite rows became THREE survival/rewrite rows (public-org-survival USE,
// public-org bare-token survival, and a BUILD-lane survival pole) plus the
// derived-slug rows were re-pointed at `privateOrgSlugs()`. The helper's
// --selftest prints 64/64 on these bytes; the pin discriminates at 64 (63 and
// 65 both red), and the mover is a fixture restructure, not a rule silently
// changing behaviour — checked before editing per the paragraph above.
//
// The bump is warranted by provenance, not by convenience: the helper and this
// runner are both byte-identical to the session baseline, so the count moved
// because fixtures were ADDED upstream, never because a rule stopped firing —
// checked before editing, since bumping a pin to silence a red is the tolerance
// bump this very comment argues against. Re-measured, not assumed: the helper's
// --selftest prints "strip-build-internal selftest: 60/60 pass", and the pin
// still DISCRIMINATES at the new value (60 passes; 59 and 61 both red).
const SELF_TEST_FIXTURE_COUNT = 64;
const summaryMatch = /strip-build-internal selftest: (\d+)\/(\d+) pass/.exec(
  selftest.stdout || "",
);
// Parse failure must RED, never pass quietly: if the helper's summary line is
// reworded, an unanchored check would silently stop measuring anything.
check(
  "helper --selftest summary line is PARSEABLE",
  summaryMatch !== null,
  summaryMatch
    ? `summary: "${summaryMatch[0]}"`
    : `no "<n>/<n> pass" summary in stdout — reworded? stdout=${JSON.stringify(
        (selftest.stdout || "").trim().slice(0, 200),
      )}`,
);
const selftestSummary = /strip-build-internal selftest: (\d+)\/(\d+) pass(?: \((\d+) skipped without a config: ([^)]+)\))?/.exec(
  selftest.stdout || "",
);
const selftestSkipped = selftestSummary && selftestSummary[3] ? Number(selftestSummary[3]) : 0;
// SKIP BY CONFIG, NOT REPO TYPE (cc-architect ruling, 2026-10-04): the count is
// asserted as RAN + SKIPPED = the pin, so the runner passes in EVERY shipped
// shape — a seed-shaped fork (no config yet: rows skip, named) and a
// public-edition-shaped tree alike. Where the config EXISTS (this repo), zero
// skips are allowed: a silent skip at a configured tree is a red.
const identityConfigPresent = fs.existsSync(
  path.join(repoRoot, ".claude", "canon-identity-values.json"),
);
check(
  `helper --selftest covered all ${SELF_TEST_FIXTURE_COUNT} inline fixtures (ran + skipped)`,
  summaryMatch !== null &&
    summaryMatch &&
    Number(summaryMatch[1]) + selftestSkipped === SELF_TEST_FIXTURE_COUNT &&
    (!identityConfigPresent || selftestSkipped === 0),
  summaryMatch
    ? `${summaryMatch[1]} ran + ${selftestSkipped} skipped (config present here: ${identityConfigPresent})`
    : `expected ${SELF_TEST_FIXTURE_COUNT} inline fixtures to run or skip, helper reported ` +
      `${summaryMatch ? summaryMatch[1] : "unparseable"} — SELF_TEST_FIXTURES ` +
      `entries were deleted, or added without bumping SELF_TEST_FIXTURE_COUNT here`,
);

// THE F6 REDACTION SECTION IS SEPARATELY PINNED, because the inline-fixture count
// above cannot see it: `f6RedactionSelftest` prints its OWN summary line and adds
// no `buildSelfTestFixtures` entries, so DELETING THE WHOLE SECTION (or its call
// in `selftest()`) would leave the 64-count green and this runner silent — the
// section's cases would be enforcement that nothing measures. A FLOOR, not a pin:
// adding cases is free, dropping below the measured count reds.
const redactionMatch = /strip-build-internal redaction-selftest: (\d+)\/(\d+) pass/.exec(
  selftest.stdout || "",
);
check(
  "helper --selftest ran the F6 redaction section (>= the measured 16 cases)",
  redactionMatch !== null &&
    Number(redactionMatch[1]) >= 16 &&
    Number(redactionMatch[1]) === Number(redactionMatch[2]),
  redactionMatch
    ? `redaction-selftest: ${redactionMatch[1]}/${redactionMatch[2]} pass`
    : "no `redaction-selftest` summary line — the F6 section (or its call in selftest()) was removed",
);

// ── 1b. CONFIG-LESS SELFTEST, BOTH SHIPPED SHAPES (L4 + cc-architect ruling
//      2026-10-04). The private-armed rows SKIP BY CONFIG (a tree with no
//      canon-identity declaration — pre-init forks and consumers alike), every
//      other row must pass on the synthetic fallback, and the skip list must
//      NAME each skipped row. The SAME assertion runs for a SEED-shaped tree
//      (type coc-source, no config yet — the /ecosystem-init pre-state) and a
//      CONSUMER-shaped tree (type coc-project): both must exit 0 with a named
//      skip list, because the DELIVERED runners have to pass in every shipped
//      edition. Removal of each temp tree happens in the finally.
for (const shape of ["coc-source", "coc-project"]) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `strip-noconfig-${shape}-`));
  try {
    const libDir = path.join(sandbox, ".claude", "bin", "lib");
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(
      path.join(sandbox, ".claude", "VERSION"),
      JSON.stringify({ version: "1.0.0", type: shape }),
    );
    fs.cpSync(path.dirname(helperPath), libDir, { recursive: true });
    const r = spawnSync("node", [path.join(libDir, "strip-build-internal.mjs"), "--selftest"], {
      encoding: "utf8",
    });
    const out = (r.stdout || "") + (r.stderr || "");
    check(`${shape} selftest exits 0 (synthetic fallback, rows skip by CONFIG)`, r.status === 0, out.trim().slice(0, 200));
    const m = /selftest: (\d+)\/(\d+) pass(?: \((\d+) skipped without a config: (.+)\))?/.exec(r.stdout || "");
    check(
      `${shape} selftest NAMES its skips`,
      m !== null && m[3] !== undefined && Number(m[3]) > 0 && (m[4] || "").split(",").length >= 3,
      m ? `skipped=${m[3]} names=${(m[4] || "").slice(0, 120)}` : `no summary; out=${out.trim().slice(0, 160)}`,
    );
    check(
      `${shape} selftest ran the remaining fixtures`,
      m !== null && Number(m[1]) + Number(m[3] || 0) === SELF_TEST_FIXTURE_COUNT,
      m ? `${m[1]} pass + ${m[3] || 0} skip = ${SELF_TEST_FIXTURE_COUNT}` : "",
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

// ── 2. External-file fixtures: each fixture-NN-<name>.md has a
//      sibling .expected file containing the post-strip content.
const fixturesDir = __dirname;
const inputs = fs
  .readdirSync(fixturesDir)
  .filter((f) => /^fixture-\d{2}-.*\.md$/.test(f))
  .sort();

for (const fn of inputs) {
  const inputPath = path.join(fixturesDir, fn);
  const expectedPath = inputPath.replace(/\.md$/, ".expected");
  if (!fs.existsSync(expectedPath)) {
    check(`fixture ${fn} has .expected sibling`, false);
    continue;
  }
  const input = fs.readFileSync(inputPath, "utf8");
  const expected = fs.readFileSync(expectedPath, "utf8");
  const { stripped } = stripBuildInternalReferences(input);
  check(`fixture ${fn}`, stripped === expected, stripped === expected ? "" : `mismatch (len in=${input.length} expected=${expected.length} actual=${stripped.length})`);
}

// ── 3. Idempotence check: running the strip twice on a real source
//      file produces the same result as running it once. This is the
//      structural invariant that makes the helper safe to wire into
//      composeArtifactBody without worrying about double-emission.
//
//      The sample corpus is DISCOVERED from the tracked tree, not hardcoded.
//      The previous version read ONE fixed path
//      (`.claude/agents/management/coc-sync.md`). That path still resolves HERE,
//      but the assertion's worth depended on that one file happening to contain
//      strippable content — an unpinned accident, and a path that is simply
//      absent in the repos this helper also ships to.
//
//      It also asserts NON-VACUITY: idempotence over content the strip does not
//      touch is trivially true and proves nothing, so the check requires at
//      least one file the strip actually rewrites, and fails loudly at zero.
const corpusFiles = execFileSync(
  "git",
  ["ls-files", ".claude/rules", ".claude/agents", ".claude/commands", ".claude/skills"],
  { cwd: repoRoot, encoding: "utf8" },
)
  .split("\n")
  .filter((f) => f.endsWith(".md"));

// The shipped fixture inputs are ALWAYS part of the sample. They contain
// strippable content by construction — that is what makes them fixtures — so
// the non-vacuity floor is structural rather than dependent on the live corpus
// happening to carry loom-internal references. Without this anchor, a repo
// whose corpus had been thoroughly cleaned would rewrite zero files and the
// suite would go red for being "vacuous" when nothing was actually wrong.
// Live corpus files are additional, real-world coverage on top.
const fixtureInputs = inputs.map((fn) =>
  path.relative(repoRoot, path.join(fixturesDir, fn)),
);
const idempotenceSample = [...fixtureInputs, ...corpusFiles];

let stripRewrote = 0;
const idempotenceBreaks = [];
for (const rel of idempotenceSample) {
  let source;
  try {
    source = fs.readFileSync(path.join(repoRoot, rel), "utf8");
  } catch {
    continue; // listed but unreadable (e.g. a deleted-but-staged path)
  }
  const once = stripBuildInternalReferences(source).stripped;
  if (once === source) continue; // strip is a no-op here; proves nothing
  stripRewrote++;
  const twice = stripBuildInternalReferences(once).stripped;
  if (once !== twice) idempotenceBreaks.push(rel);
}

check(
  "idempotence sample is non-vacuous (>=1 file the strip rewrites)",
  stripRewrote > 0,
  stripRewrote > 0
    ? `${stripRewrote} file(s)`
    : "the strip rewrote NOTHING — not even the shipped fixture inputs, which " +
      "contain strippable content by construction. The strip itself is broken.",
);
check(
  `idempotent over ${stripRewrote} rewritten corpus file(s)`,
  idempotenceBreaks.length === 0,
  idempotenceBreaks.length === 0 ? "" : `not idempotent on: ${idempotenceBreaks.join(", ")}`,
);

// ── 4. Repo-class scope restriction on the workspace-name derivation.
//
//      This helper SHIPS: `.claude/bin/lib/strip-build-internal.mjs` resolves
//      `action: copy, reason: always_include` on the py / rs / base lanes, so it
//      executes at BUILD repos and downstream consumers, not only at loom.
//      Deriving the loom-workspace name set from the live `workspaces/` dir is
//      only meaningful AT LOOM (type `coc-source`). Anywhere else that directory
//      holds the CONSUMER's own workspaces.
//
//      The two failure identities this pins, both observed on the pre-fix helper:
//        CANONICAL-UNDERSTRIP — a canonical loom workspace name STOPPED stripping
//                               at a non-loom repo (the derived set REPLACED the
//                               canonical one), so loom-internal paths leak.
//        CONSUMER-OVERSTRIP   — the consumer's OWN workspace path was rewritten
//                               to "(loom-internal reference)", corrupting their
//                               real content.
//
//      Probed against a synthetic `coc-project` tree in a temp dir, so the
//      assertion holds regardless of which repo this runner is executing in.
const moduleFlagIdx = process.argv.indexOf("--module");
const moduleUnderTest =
  moduleFlagIdx >= 0 && process.argv[moduleFlagIdx + 1]
    ? path.resolve(process.argv[moduleFlagIdx + 1])
    : helperPath;

if (moduleUnderTest !== helperPath) {
  console.log(`      (section 4 module under test: ${moduleUnderTest})`);
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "strip-scope-"));
const fakeRepo = path.join(sandbox, "consumer-repo");
const consumerWs = "acme-consumer-engagement";
fs.mkdirSync(path.join(fakeRepo, ".claude", "bin", "lib"), { recursive: true });
fs.mkdirSync(path.join(fakeRepo, "workspaces", consumerWs), { recursive: true });
fs.writeFileSync(
  path.join(fakeRepo, ".claude", "VERSION"),
  JSON.stringify({ version: "1.0.0", type: "coc-project" }, null, 2),
);
fs.copyFileSync(
  moduleUnderTest,
  path.join(fakeRepo, ".claude", "bin", "lib", "strip-build-internal.mjs"),
);
// The helper's relative static imports — this list MUST TRACK its import block,
// because the sandbox is a MODULE-LOAD, not an invocation: a missing dep throws
// ERR_MODULE_NOT_FOUND before a single assertion runs and reds the whole runner.
//   entry-point.mjs   — the main-module check.
//   identity-scrub.mjs — the ONE fold `redactPrivateIdentity` shares with the
//                        scanner (F6e); MEASURED: this file's absence was the
//                        runner's first failure once that import landed.
// Both are zero-dependency ESM (node builtins only), so no transitive copies
// are owed; the helper ships on every lane (sync-tier-aware.mjs::ALWAYS_INCLUDE),
// so a real consumer tree carries both too.
for (const dep of ["entry-point.mjs", "identity-scrub.mjs"]) {
  fs.copyFileSync(
    path.resolve(__dirname, "..", "..", "bin", "lib", dep),
    path.join(fakeRepo, ".claude", "bin", "lib", dep),
  );
}

// Positive control: the probe must be exercising a tree that really reads as a
// non-loom consumer. If this is wrong, everything below passes for the wrong
// reason.
const fakeClass = JSON.parse(
  fs.readFileSync(path.join(fakeRepo, ".claude", "VERSION"), "utf8"),
).type;
check(
  "scope probe control: synthetic tree reads as a non-loom repo",
  fakeClass === "coc-project",
  `type=${fakeClass}`,
);

try {
  const consumerMod = await import(
    pathToFileURL(
      path.join(fakeRepo, ".claude", "bin", "lib", "strip-build-internal.mjs"),
    ).href
  );
  const strip = consumerMod.stripBuildInternalReferences;

  const canonicalCite =
    "See `workspaces/multi-cli-coc/02-plans/07-spec.md` for the spec.";
  const consumerCite = `Put plans under \`workspaces/${consumerWs}/02-plans/\` here.`;

  const canonicalOut = strip(canonicalCite).stripped;
  const consumerOut = strip(consumerCite).stripped;

  check(
    "CANONICAL-UNDERSTRIP: canonical loom workspace still strips at a non-loom repo",
    canonicalOut !== canonicalCite,
    canonicalOut !== canonicalCite
      ? ""
      : `CANONICAL-UNDERSTRIP — 'workspaces/multi-cli-coc/...' survived VERBATIM at a ` +
        `coc-project repo. The derived set REPLACED the canonical names instead of ` +
        `unioning with them, so every canonical loom path under-strips to zero. Got: ${JSON.stringify(canonicalOut)}`,
  );

  check(
    "CONSUMER-OVERSTRIP: consumer's own workspace path is preserved verbatim",
    consumerOut === consumerCite,
    consumerOut === consumerCite
      ? ""
      : `CONSUMER-OVERSTRIP — the consumer's own 'workspaces/${consumerWs}/' path was ` +
        `rewritten as if it were loom-internal. Got: ${JSON.stringify(consumerOut)}`,
  );
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

// ── (e) loom#1930 — the RATCHET, and the `_archive` descent it depends on ──
//
// The fence's floor is a committed append-only manifest, which only works if it
// stays current. `--verify-manifest` fails when a workspace that EXISTS RIGHT
// NOW is unrecorded — it has to fire while the directory is still there, since
// once archived or deleted there is nothing left to compare against.
//
// The `_archive` descent gets its OWN assertion rather than being inferred from
// a green ratchet. Mutation M6 (deleting the descent) reds nothing today, purely
// because every currently-archived name also happens to sit in the committed
// manifest — an accident of how the manifest was seeded, not a property. Pinning
// the descent directly means the arm has a test that discriminates it, instead
// of one that would pass with the arm removed.
{
  const mod = await import(
    pathToFileURL(
      path.join(repoRoot, ".claude", "bin", "lib", "strip-build-internal.mjs"),
    ).href
  );
  const live = mod.liveLoomWorkspaceDirs();
  const manifest = mod.readWorkspaceNameManifest();

  check(
    "MANIFEST-NONEMPTY: the committed name ledger loaded",
    manifest.strip.length > 0 && manifest.preserve.length > 0,
    manifest.strip.length > 0 && manifest.preserve.length > 0
      ? ""
      : `strip=${manifest.strip.length} preserve=${manifest.preserve.length} — a failed read fails closed to empty, which would silently drop the floor`,
  );

  const archiveDir = path.join(repoRoot, "workspaces", "_archive");
  let archived = [];
  try {
    archived = fs
      .readdirSync(archiveDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    archived = [];
  }
  if (archived.length > 0) {
    const missed = archived.filter((n) => !live.includes(n));
    check(
      "ARCHIVE-DESCENT: liveLoomWorkspaceDirs() enumerates workspaces/_archive/* one level deeper",
      missed.length === 0,
      missed.length === 0
        ? ""
        : `archived workspaces absent from the live set: ${JSON.stringify(missed)} — ` +
          "the walk is one level deep again, so every archived name silently drops out of the fence",
    );
  } else {
    console.log("SKIP  ARCHIVE-DESCENT — workspaces/_archive/ is empty or absent");
  }

  const known = new Set([...manifest.strip, ...manifest.preserve]);
  const unrecorded = [...new Set(live)].filter((n) => !known.has(n)).sort();
  check(
    "MANIFEST-RATCHET: every live workspace name is recorded in loom-workspace-names.json",
    unrecorded.length === 0,
    unrecorded.length === 0
      ? ""
      : `unrecorded: ${JSON.stringify(unrecorded)} — append each to \`strip\` (a real workspace) ` +
        "or `preserve` (a meta-dir). Recording it NOW is what keeps it stripping after it is archived.",
  );
}

// STRIP-SEC-2 (cc-architect MUST-2, 2026-10-04): the REFUTED suffix-convention
// arm must never return. `kailash-enterprise` (a product name, MEASURED to have
// been swallowed by that arm in 26 rs variant sources) stays byte-identical on
// the USE and BUILD lanes, WITH a config (this tree) AND WITHOUT one (a
// consumer-shaped copy). A suffix arm coming back reds this by name.
{
  const sample = "Tier notes: kailash-enterprise and kailash-foundation rows.\n";
  const libPath = path.join(repoRoot, ".claude/bin/lib/strip-build-internal.mjs");
  const probeOne = (lib, buildMode) => {
    const r = spawnSync(
      process.execPath,
      [
        "-e",
        `import(${JSON.stringify(pathToFileURL(lib).href)}).then((m) => {` +
          `const out = m.stripBuildInternalReferences(${JSON.stringify(sample)}, { buildMode: ${buildMode} }).stripped;` +
          `console.log(JSON.stringify(out));` +
          `}).catch((e) => { console.error("THREW " + e.message); process.exit(3); });`,
      ],
      { encoding: "utf8" },
    );
    return r.status === 0 ? JSON.parse(r.stdout) : `rc=${r.status} ${(r.stderr || "").slice(0, 120)}`;
  };
  let noConfigLib = null;
  let sec2Tmp = null;
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "strip-sec2-"));
    fs.mkdirSync(path.join(tmp, "lib"), { recursive: true });
    fs.cpSync(path.dirname(libPath), path.join(tmp, "lib"), { recursive: true });
    noConfigLib = path.join(tmp, "lib", "strip-build-internal.mjs");
    sec2Tmp = tmp;
  } catch {
    noConfigLib = null;
  }
  try {
    for (const [label, lib] of [
      ["with config (loom tree)", libPath],
      ["no config (consumer-shaped copy)", noConfigLib],
    ]) {
      if (!lib) {
        check(`STRIP-SEC-2 kailash-enterprise identity — ${label}`, false, "could not stage the copy");
        continue;
      }
      for (const buildMode of [false, true]) {
        const lane = buildMode ? "BUILD" : "USE";
        const got = probeOne(lib, buildMode);
        check(
          `STRIP-SEC-2 kailash-enterprise identity — ${lane} lane, ${label}`,
          got === sample,
          got === sample ? "" : `rewritten: ${JSON.stringify(got)} — a suffix-convention arm is back`,
        );
      }
    }
  } finally {
    // L4 (cc-architect, 2026-10-04): the staged consumer copy was leaked per
    // run; remove it with the sandbox pattern the other sections use.
    if (sec2Tmp) fs.rmSync(sec2Tmp, { recursive: true, force: true });
  }
}

console.log("");
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
