#!/usr/bin/env node
/*
 * OWED SUITES — which existing suite already covers what this change touched.
 *
 * THE GAP (loom#1727). A PR modifies `X`. A suite dedicated to `X` already exists,
 * already passes, and would have caught the defect. Nothing in the loop makes it run.
 * The lane runs the suites it THINKS are relevant, they pass, and the defect ships.
 *
 * Three instances were measured in one session. In the clearest, the lane had
 * AUTHORED the derived practice itself, in the same session, and still did not run
 * the suite: "Writing it down did not make me do it. The gap is not knowledge, it is
 * that nothing in my loop forced the check."
 *
 * So this is not a rule. It is the line that names the suite.
 *
 * WHY NOT "just run the full corpus": ~253 suites, ~13 minutes. Lanes reasonably run
 * a subset. The defect is not that they run a subset — it is that the subset is
 * chosen by JUDGMENT ABOUT RELEVANCE, which is exactly what fails when you have just
 * changed something you do not fully model. This picks the subset from the DIFF.
 *
 * HOW OWNERSHIP IS DERIVED, not hand-listed (loom#1727 AC #1). Three rules, each
 * measured on the live corpus at authoring time:
 *
 *   NAMED      the suite's stem equals the changed file's stem
 *              (`phase2-deferral-integrity.mjs` -> `phase2-deferral-integrity.test.mjs`).
 *              Strongest signal; MEASURED to cover 26% of suites on its own, which is
 *              why it is not the only rule.
 *   REFERENCED the changed file's basename appears in the suite body, AND that
 *              basename is referenced by at most the FAN-OUT BOUND's worth of suites.
 *              Reference alone covers 99% of suites (250/253, avg 4.4 sources each)
 *              but the INVERSE map is noisy: `emit.mjs` is referenced by 61 suites,
 *              and naming 61 is the same as naming none. The bound is DERIVED from
 *              each corpus rather than fixed — see "THE FAN-OUT BOUND" below. MEASURED
 *              on loom at this writing: p50 2, p75 4, p90 10, max 135 over 642
 *              referenced source basenames, giving a derived bound of 4.
 *   SUBTREE    the suite ENUMERATES a repo subdirectory (a `path.join(REPO, "a", "b")`
 *              that resolves to a real directory, plus a `readdirSync` walk), so it owns
 *              every changed file beneath that root. This rule exists because instance 3
 *              is unreachable without it: `trust-resolver-fail-closed-1471.test.js`
 *              enforces an ALLOWLIST over every trust-bearing hook and NEVER NAMES the
 *              two files that changed — measured, 0 occurrences of either basename. Its
 *              ownership is real but expressed as a POPULATION, so no amount of
 *              reference-matching finds it.
 *   TREE-WIDE  the suite enumerates the tracked tree (`git ls-files`), so it owns
 *              every changed source file. MEASURED: 7 of 253 — small enough to always
 *              owe, which is the point: instance 1 was a raw NUL byte in an arbitrary
 *              source file, owned by no file-specific suite and caught only by a
 *              whole-tree scanner.
 *
 * WHAT THIS DOES NOT CLAIM, stated rather than left to be discovered:
 *   - It reports the suites that OWN the change. It does not run them, and it cannot
 *     tell you they would have caught anything — a suite can own a file and still be
 *     blind to the defect in it.
 *   - A file referenced by MORE than the fan-out bound's worth of suites is reported
 *     as BROAD, with its count, and NOT resolved to an owner. That is a refusal to
 *     guess, not coverage. The bound is derived per corpus and is REPORTED with its
 *     provenance, because a bound imported from another repo silently refuses to
 *     answer for a large fraction of that repo's tree.
 *   - It NEVER suggests narrowing by test MARKER. Markers are not a band selector on a
 *     real gate: on the reference corpus measured for this tool, 62.6% of the tests in
 *     the gate carried no tier marker at all, and `-m e2e`, `-m conformance` and
 *     `-m performance` each selected ZERO. The run lines below are PATH-derived, which
 *     is the selector that is actually live.
 *   - Reference detection is by BASENAME occurrence in the suite text. It therefore
 *     sees a composed path (`join(ROOT, "bin", "x.mjs")`) — deliberately, since that
 *     is how most suites address their subject — and it will also match a basename
 *     that merely appears in a comment. Over-inclusion inside the fan-out bound is the
 *     intended trade: a suite named and not owed costs one read, a suite owed and not
 *     named costs a shipped defect.
 *   - Two suite POPULATIONS are scanned, because scoping to one was itself an instance
 *     of this bug class: `ci-suites.json` (the harness registry) AND
 *     `tests/integration/multi-operator/`, which is run by its own CI step and appears
 *     in NEITHER registry. Instance 3's suite lives in the second, so a mapper reading
 *     only the first would have missed the very case it was built for.
 *
 * Exit codes: 0 always (this REPORTS; it does not gate). Read the list.
 *
 * Run: node .claude/bin/owed-suites.mjs [--base <ref>] [--files a,b] [--fanout-max <n>] [--json]
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/entry-point.mjs";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

/* The hardened git shim (loom#1471): an absolute binary + a constant env, so no
 * ambient GIT_DIR can point this enumeration at another tree. */
let _shim;
function gitInvocation() {
  if (_shim === undefined) {
    _shim = null;
    try {
      const m = require(path.resolve(HERE, "..", "hooks", "lib", "git-subprocess-env.js"));
      if (m && typeof m.resolveGitBinary === "function" && typeof m.gitEnv === "function") _shim = m;
    } catch {
      /* shim absent — PATH fallback, the pre-shim behaviour */
    }
  }
  const bin = _shim ? _shim.resolveGitBinary() : null;
  return { bin: bin || "git", env: _shim ? _shim.gitEnv() : process.env };
}

/*
 * THE FAN-OUT BOUND IS DERIVED FROM THIS CORPUS. It is not a constant, and it is not
 * loom's number travelling under a general-sounding name.
 *
 * It used to be `const FANOUT_MAX = 3`, calibrated on loom's own distribution (p50 2,
 * p75 4, p90 8, max 55; 202 of 291 referenced basenames at <= 3 — i.e. 3 sits at
 * roughly the 70th percentile HERE). MEASURED against a second, larger corpus, that
 * constant does not transfer: at a repo whose distribution is p90 15 / max 160, a
 * bound of 3 marks 44.3% of source modules BROAD — i.e. refuses to name an owner for
 * nearly half the tree. A tool that refuses half the time has stopped being an
 * instrument and become noise, and it fails SILENTLY, because "BROAD" is a plausible-
 * looking answer rather than an error.
 *
 * So the bound is recomputed per corpus, at the same percentile the loom number
 * happened to occupy, from the corpus's OWN observed fan-out distribution.
 *
 * WHAT THE DERIVATION MEASURES, stated so it is not read as more than it is: the
 * distribution is built from a TOKEN INDEX over suite bodies (one pass, filename-
 * shaped tokens with a recognised source extension), NOT from the `includes()`
 * matching that decides an individual file's ownership below. The two answer different
 * questions and the difference is deliberate — a per-basename `includes()` sweep over
 * every source file in the repo is O(sources x suites x body) and would cost more than
 * the whole rest of this tool. The token index is a CALIBRATION STATISTIC for the
 * shape of the corpus; ownership is still decided by the exact `includes()` test.
 *
 * HOW A CONSUMER CALIBRATES, in increasing order of commitment:
 *   1. do nothing — the bound is derived from your corpus on every run, and the
 *      derived value plus your corpus's p50/p75/p90/max are printed (and are in
 *      `--json` as `fanout_max`, `fanout_max_source`, `fanout_percentiles`);
 *   2. `--fanout-max <n>` for one run, to see what a different bound would name;
 *   3. `OWED_SUITES_FANOUT_MAX=<n>` in the repo's own env/CI, to pin it.
 * An explicit value always wins over the derivation and SAYS SO in the report, so a
 * pinned bound can never be mistaken for a measured one.
 */
const FANOUT_FLOOR = 3;
const FANOUT_PERCENTILE = 70;

/*
 * SUITE LAYOUTS — how a repo SAYS "this file is a test", per ecosystem.
 *
 * This replaced a two-entry hardcoded directory list (`.claude/test-harness/tests`
 * + `tests/integration/multi-operator`). That list was right for loom and inert
 * everywhere else, which is MEASURED rather than argued: under
 * `sync-tier-aware.mjs::buildLaneClassifier`, BOTH directories classify
 * `skip/exclude` on all six distribution lanes (use base/py/rs, build base/py/rs).
 * A consumer receives NEITHER, so a shipped copy of this tool would have enumerated
 * ZERO suites at every repo it reached — the exact defect `sync-manifest.yaml`
 * already records against `bin/run-harness-suites.mjs` ("a consumer receives no
 * suites, so the runner would enumerate an empty registry").
 *
 * The four ownership RULES (NAMED / REFERENCED / SUBTREE / TREE-WIDE) are not
 * language-bound. Only two things are: recognising a suite FILE, and reducing it to
 * a STEM. Those two are the only things parameterised here.
 *
 * `sources` is the language gate on the NAMED rule: `test_foo.py` must not claim
 * `foo.rs` merely because both reduce to the stem `foo`. DECLARATIVE files
 * (`.json`/`.yaml`/`.yml`/`.toml`/`.md`) are exempt from that gate — any layout may
 * own a config its language reads — which is also what preserves loom's
 * pre-existing behaviour over its own JSON registries.
 *
 * WHAT IS STILL LOOM-SHAPED, stated rather than left to be discovered:
 *   - REGISTRY_FILTERS below is loom-specific by construction and lazily inert
 *     elsewhere (the files simply do not exist at a consumer).
 *   - The SUBTREE rule reads path literals out of suite SOURCE TEXT. Its walker and
 *     path-constructor vocabulary (below) covers JS/TS, Python, Rust and Go; a suite
 *     that builds a directory path some other way is not seen by that rule. NAMED,
 *     REFERENCED and TREE-WIDE are unaffected.
 *   - Reference detection is BASENAME occurrence in suite text, which is
 *     language-neutral, and TREE-WIDE keys on `git ls-files`, which every language
 *     spells the same way in a subprocess call.
 */
const SUITE_LAYOUTS = [
  {
    id: "node",
    label: "*.test.* / *.spec.*  (node:test, jest, vitest, mocha)",
    match: (p) => /(^|\/)[^/]+\.(test|spec)\.(mjs|cjs|js|jsx|ts|tsx)$/.test(p),
    stem: (b) => b.replace(/\.(test|spec)\.(mjs|cjs|js|jsx|ts|tsx)$/, ""),
    sources: /\.(mjs|cjs|js|jsx|ts|tsx)$/,
  },
  {
    id: "pytest",
    label: "test_*.py / *_test.py  (pytest, unittest)",
    match: (p) => /(^|\/)(test_[^/]+\.py|[^/]+_test\.py)$/.test(p),
    stem: (b) => b.replace(/\.py$/, "").replace(/^test_/, "").replace(/_test$/, ""),
    sources: /\.py$/,
  },
  {
    id: "cargo",
    label: "tests/**/*.rs  (cargo integration tests)",
    match: (p) => /(^|\/)tests\/.*\.rs$/.test(p),
    stem: (b) => b.replace(/\.rs$/, ""),
    sources: /\.rs$/,
  },
  {
    id: "go",
    label: "*_test.go  (go test)",
    match: (p) => /(^|\/)[^/]+_test\.go$/.test(p),
    stem: (b) => b.replace(/_test\.go$/, ""),
    sources: /\.go$/,
  },
];

/* A layout may own a declarative file regardless of its `sources` gate. */
const DECLARATIVE_RX = /\.(json|yaml|yml|toml|md)$/;

/* Changed-file stem: strip a recognised SOURCE extension only. `.md` is left
 * whole, preserving the pre-generalisation behaviour for prose files. */
const SOURCE_EXT_RX = /\.(mjs|cjs|js|jsx|ts|tsx|py|rs|go|json|yaml|yml|toml)$/;

/* Which changed files make the TREE-WIDE band owed at all. */
const SOURCEISH_RX = /\.(mjs|cjs|js|jsx|ts|tsx|py|rs|go|json|yaml|yml|toml|md)$/;

/* Directory-scoped registries that NARROW the discovered set to what CI declares.
 * Loom-shaped and lazily inert: at a repo without these files no filter applies and
 * every discovered suite counts, which is the safe direction (over-inclusion costs a
 * read; under-inclusion costs a shipped defect). */
const REGISTRY_FILTERS = [
  { dir: ".claude/test-harness/tests", registry: ".claude/test-harness/ci-suites.json" },
  { dir: ".claude/bin", registry: ".claude/test-harness/ci-suites-bin.json" },
];

/* Bounds. A monorepo can carry thousands of test files, and this is run before a
 * commit. Both bounds are reported LOUDLY when hit rather than silently shrinking
 * the corpus — a quietly truncated scan is a quietly incomplete owed set. */
const SUITE_SCAN_MAX = 4000;
const SUITE_BODY_MAX = 4 * 1024 * 1024;

/** Ascending-sorted array -> the value at percentile p (nearest-rank). */
function percentileOf(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

/* A filename-shaped token with a recognised SOURCE extension. Deliberately excludes
 * `/`, so a path literal `bin/emit.mjs` contributes the BASENAME `emit.mjs` — the same
 * unit the ownership test keys on. */
const REF_TOKEN_RX =
  /[A-Za-z0-9_][A-Za-z0-9_.@+-]*\.(?:mjs|cjs|js|jsx|ts|tsx|py|rs|go|json|yaml|yml|toml|md)(?![A-Za-z0-9])/g;

/**
 * basename -> how many DISTINCT suites mention it. One pass over the suite bodies.
 *
 * `population` is REQUIRED and load-bearing: it is the set of real, non-suite source
 * basenames in this repo. Without it the index counts every filename-shaped token —
 * scratch fixture names, tmpfile stems, basenames of files that do not exist — each
 * appearing in exactly one suite, and that singleton tail drags every percentile down
 * to the floor at ANY corpus. MEASURED here: unfiltered, loom's p70 is 2 and p90 is 5
 * over 1826 tokens; filtered to real source basenames it is the distribution the
 * header records. An index that reports the same depressed number for every repo is
 * not a per-corpus derivation — it is the constant it replaced, wearing a percentile.
 */
function corpusFanout(suites, population) {
  const counts = new Map();
  for (const s of suites) {
    const seen = new Set();
    REF_TOKEN_RX.lastIndex = 0;
    let m;
    while ((m = REF_TOKEN_RX.exec(s.body)) !== null) {
      if (population.has(m[0])) seen.add(m[0]);
    }
    for (const t of seen) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return counts;
}

/**
 * The fan-out bound for THIS corpus.
 *
 * `explicit` (a `--fanout-max` flag or `OWED_SUITES_FANOUT_MAX`) always wins and is
 * reported as an override, so a pinned bound is never mistaken for a measured one.
 *
 * The FLOOR is a READABILITY floor, not a smuggled loom calibration: a reader can act
 * on three suite names, so a corpus whose suites barely cross-reference must not
 * collapse the bound to 1 and start refusing files referenced by two suites. It is the
 * one number here that is a judgment about the READER rather than about the corpus,
 * which is why it is named separately and reported when it binds.
 */
function deriveFanoutMax(suites, population, opts = {}) {
  const counts = corpusFanout(suites, population || new Set());
  const sorted = [...counts.values()].sort((a, b) => a - b);
  const percentiles = {
    p50: percentileOf(sorted, 50),
    p75: percentileOf(sorted, 75),
    p90: percentileOf(sorted, 90),
    max: sorted.length ? sorted[sorted.length - 1] : null,
  };
  const derived = percentileOf(sorted, FANOUT_PERCENTILE);
  const base = { percentiles, referenced_basenames: sorted.length, derived, percentile: FANOUT_PERCENTILE };
  const explicit = Number(opts.explicit);
  if (Number.isFinite(explicit) && explicit > 0) {
    return { ...base, max: Math.floor(explicit), source: opts.explicitSource || "override" };
  }
  if (derived === null) {
    return { ...base, max: FANOUT_FLOOR, source: "readability-floor (no corpus signal to derive from)" };
  }
  return {
    ...base,
    max: Math.max(FANOUT_FLOOR, derived),
    source:
      derived >= FANOUT_FLOOR
        ? `derived p${FANOUT_PERCENTILE} of this corpus`
        : `readability-floor ${FANOUT_FLOOR} (this corpus's p${FANOUT_PERCENTILE} is ${derived})`,
  };
}

function parseArgs(argv) {
  const out = {
    base: "origin/main",
    files: null,
    json: false,
    repo: path.resolve(HERE, "..", ".."),
    fanoutMax: null,
    fanoutSource: null,
  };
  const envFanout = process.env.OWED_SUITES_FANOUT_MAX;
  if (envFanout !== undefined && envFanout !== "") {
    out.fanoutMax = envFanout;
    out.fanoutSource = "override via OWED_SUITES_FANOUT_MAX";
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") out.base = argv[++i];
    else if (a === "--files") out.files = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--repo-root") out.repo = path.resolve(argv[++i]);
    else if (a === "--fanout-max") {
      out.fanoutMax = argv[++i];
      out.fanoutSource = "override via --fanout-max";
    } else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "usage: owed-suites.mjs [--base <ref>] [--files a,b] [--repo-root <d>] [--fanout-max <n>] [--json]\n" +
          "\n" +
          "  --fanout-max <n>  pin the bound above which a file is reported BROAD rather than\n" +
          "                    resolved to owners. DEFAULT: derived from THIS corpus's own\n" +
          `                    fan-out distribution at p${FANOUT_PERCENTILE} (floor ${FANOUT_FLOOR}). The bound is NOT\n` +
          "                    portable between repos — see the header. Env: OWED_SUITES_FANOUT_MAX.\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`owed-suites: unknown argument: ${a}\n`);
      process.exit(2);
    }
  }
  return out;
}

function git(repo, args) {
  const { bin, env } = gitInvocation();
  return execFileSync(bin, ["-C", repo, ...args], {
    encoding: "utf8",
    env,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Changed files: the committed diff UNION the working tree.
 *
 * THREE-dot against the merge base — the two-dot form renders the base's newer commits
 * as reversions (evidence-first-claims.md MUST-5).
 *
 * The working tree is unioned in because of a defect found by WALKING this tool rather
 * than reading it: run BEFORE committing — which is exactly when a lane wants to know
 * what to run — the committed diff is empty and the report read "0 changed files ... none".
 * A tool whose whole purpose is to stop a silent miss must not have a silent miss of its
 * own at the moment it is most likely to be used.
 */
function changedFiles(repo, base) {
  const out = new Set();
  let committedOk = false;
  try {
    for (const f of git(repo, ["diff", "--name-only", `${base}...HEAD`]).split("\n")) if (f) out.add(f);
    committedOk = true;
  } catch (err) {
    process.stderr.write(
      `owed-suites: could not diff against ${base} (${String(err.message).trim()}). ` +
        "Reporting on the WORKING TREE only — this is a partial answer, not a clean one.\n",
    );
  }
  try {
    // -z + NUL split so a path with a space or quote is not mangled into two.
    for (const rec of git(repo, ["status", "--porcelain=1", "-z", "--untracked-files=all"]).split("\0")) {
      if (!rec) continue;
      const p = rec.slice(3);
      if (p) out.add(p);
    }
  } catch {
    if (!committedOk) process.stderr.write("owed-suites: could not read the working tree either.\n");
  }
  return [...out].sort();
}

/**
 * Repo subdirectories a suite ENUMERATES.
 *
 * Only counts a suite that actually walks (`readdirSync`), so a path merely mentioned
 * for a single-file read does not claim a whole subtree. Each candidate is required to
 * RESOLVE to a real directory, which is what keeps a `path.join(t, "a", "b")` over some
 * scratch tmpdir from being read as ownership of a repo path that does not exist.
 */
const WALK_RX =
  /readdirSync|readdir\(|opendirSync|globSync|os\.listdir|os\.walk|\.iterdir\(|\.rglob\(|\.glob\(|glob\.glob|read_dir\(|WalkDir|filepath\.Walk|ioutil\.ReadDir/;

/* Path CONSTRUCTORS whose quoted arguments are joined into one relative path.
 * `path.join("a","b")` -> `a/b`; `os.path.join("a","b")` and `Path("a","b")` the
 * same. Unquoted arguments (variables) are skipped, which is what keeps a
 * `path.join(tmpdir, "x")` from claiming a repo path. */
const PATH_CTOR_RX =
  /(?:path\.join|os\.path\.join|filepath\.Join|Path::new|PathBuf::from|Path)\(([^)]*)\)/g;

/* A bare quoted literal that LOOKS like a relative path (contains a separator, no
 * whitespace, no glob metacharacters). This is how Python and Rust suites most often
 * spell a directory. It is safe to be liberal here ONLY because every candidate must
 * then RESOLVE to a real directory in this repo — a string that happens to name a
 * real repo directory is a real repo directory. */
const BARE_PATH_RX = /["'`]([A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)+)\/?["'`]/g;

function enumeratedSubtrees(repo, body) {
  if (!WALK_RX.test(body)) return [];
  const out = new Set();
  const candidates = [];
  let m;
  PATH_CTOR_RX.lastIndex = 0;
  while ((m = PATH_CTOR_RX.exec(body)) !== null) {
    const parts = [...m[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1]);
    if (parts.length) candidates.push(parts.join("/"));
  }
  BARE_PATH_RX.lastIndex = 0;
  while ((m = BARE_PATH_RX.exec(body)) !== null) candidates.push(m[1]);
  for (const raw of candidates) {
    const rel = raw.replace(/^\.\//, "").replace(/\/+$/, "");
    // `.` and `""` would resolve to the repo ROOT and claim every changed file —
    // that is the TREE-WIDE band's job, reached by a different and explicit signal.
    if (!rel || rel === "." || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    try {
      if (fs.statSync(path.join(repo, rel)).isDirectory()) out.add(rel);
    } catch {
      /* not a real repo directory — not ownership */
    }
  }
  return [...out];
}

/**
 * Every path the repo tracks, PLUS untracked-not-ignored.
 *
 * `git ls-files` rather than a directory walk, for the same reason the rest of this
 * file uses git: it is the repo's own answer about what belongs to it, it honours
 * `.gitignore` (so a vendored `node_modules` or `.venv` full of third-party tests is
 * not scanned), and it costs one subprocess instead of a recursive stat storm.
 *
 * `--others --exclude-standard` is load-bearing, not a flourish: a suite AUTHORED IN
 * THIS CHANGE is untracked, and a mapper that cannot see the suite you just wrote has
 * a blind spot exactly where a lane is most likely to consult it — the same defect
 * `changedFiles` records for the pre-commit case.
 */
function repoFiles(repo) {
  try {
    return git(repo, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
      .split("\0")
      .filter(Boolean);
  } catch (err) {
    process.stderr.write(
      `owed-suites: git could not enumerate this repo (${String(err.message).trim()}). ` +
        "Any empty result below is THAT failure, not an empty owed set.\n",
    );
    return [];
  }
}

/** Loom-shaped registry narrowing. Returns null when the registry is absent or
 *  unreadable, which means NO filter — never an empty set (an empty set would read
 *  as "nothing is owed", the one answer this tool must never fabricate). */
function registryFor(repo, rel) {
  for (const f of REGISTRY_FILTERS) {
    if (path.dirname(rel) !== f.dir) continue;
    if (f._cache === undefined) {
      f._cache = null;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(repo, f.registry), "utf8"));
        if (j && j.suites && typeof j.suites === "object") f._cache = new Set(Object.keys(j.suites));
      } catch {
        /* absent or unreadable — no narrowing */
      }
    }
    return f._cache;
  }
  return null;
}

function collectSuites(repo) {
  const suites = [];
  const perLayout = new Map();
  /* The fan-out CALIBRATION population: real source basenames in this repo that are
   * NOT themselves suites. This is the population the BROAD decision is applied to (a
   * changed file), so it is the population the bound must be calibrated over. */
  const sourceBasenames = new Set();
  let scanned = 0;
  let truncated = 0;
  let oversize = 0;
  for (const rel of repoFiles(repo)) {
    const layout = SUITE_LAYOUTS.find((L) => L.match(rel));
    if (!layout) {
      if (SOURCEISH_RX.test(rel)) sourceBasenames.add(path.basename(rel));
      continue;
    }
    scanned++;
    if (suites.length >= SUITE_SCAN_MAX) {
      truncated++;
      continue;
    }
    const name = path.basename(rel);
    const declared = registryFor(repo, rel);
    if (declared && !declared.has(name)) continue;
    let body = "";
    try {
      const abs = path.join(repo, rel);
      if (fs.statSync(abs).size > SUITE_BODY_MAX) {
        oversize++;
        continue;
      }
      body = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    suites.push({
      name,
      rel,
      layout: layout.id,
      sources: layout.sources,
      stem: layout.stem(name),
      body,
      treeWide: /["'`]ls-files["'`]|git ls-files/.test(body),
      subtrees: enumeratedSubtrees(repo, body),
    });
    perLayout.set(layout.id, (perLayout.get(layout.id) || 0) + 1);
  }
  return { suites, perLayout, scanned, truncated, oversize, sourceBasenames };
}

/**
 * LAYOUT BLIND SPOT — the failure this tool must never have silently.
 *
 * Zero suites is caught by its own guard. The nastier case is PARTIAL: the scan finds
 * SOME suites, so nothing looks wrong, while the repo's actual test system is a layout
 * this tool cannot see. Then "0 owed" reads as coverage news when it is a layout
 * report.
 *
 * The predicate is cheap and local: for each changed file, which layout COULD own it
 * (by its `sources` gate)? If not one suite of any such layout was enumerated, say so.
 */
function layoutBlindSpots(changed, perLayout) {
  const spots = [];
  for (const L of SUITE_LAYOUTS) {
    if (perLayout.get(L.id)) continue;
    const n = changed.filter((c) => L.sources.test(c)).length;
    if (n > 0) spots.push({ layout: L.id, label: L.label, changed_files: n });
  }
  return spots;
}

/* How each layout's suites are RUN. Suggestions, not gospel — a repo may wrap its
 * runner — but a suggestion in the wrong language is worse than none. */
const RUNNERS = {
  node: (f) => `node --test ${f.join(" \\\n              ")}`,
  pytest: (f) => `pytest ${f.join(" ")}`,
  cargo: (f) => `cargo test ${f.map((x) => `--test ${path.basename(x).replace(/\.rs$/, "")}`).join(" ")}`,
  go: (f) => `go test ${[...new Set(f.map((x) => "./" + path.dirname(x)))].join(" ")}`,
  _default: (f) => f.join(" "),
};

function groupByLayout(rels, suites) {
  const byRel = new Map(suites.map((s) => [s.rel, s.layout]));
  const out = new Map();
  for (const r of rels) {
    const id = byRel.get(r) || "_default";
    if (!out.has(id)) out.set(id, []);
    out.get(id).push(r);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = args.repo;
  const changed = args.files ?? changedFiles(repo, args.base);
  const { suites, perLayout, truncated, oversize, sourceBasenames } = collectSuites(repo);
  const blindSpots = layoutBlindSpots(changed, perLayout);

  if (!suites.length) {
    const msg =
      "owed-suites: enumerated ZERO suites — a LAYOUT OR REGISTRY FAILURE, not an empty owed set.\n" +
      "  Layouts probed: " +
      SUITE_LAYOUTS.map((L) => `${L.id} (${L.label})`).join("; ") +
      "\n  If this repo tests some other way, this tool cannot see it and reports NOTHING about\n" +
      "  your coverage. Do not read this as 'no suite owes you a run'.\n";
    process.stderr.write(msg);
    // The stdout channel must carry the failure too. A caller that reads only stdout
    // — every `--json` consumer — otherwise sees an ABSENCE and an exit 0, which is
    // indistinguishable from "nothing is owed": the one answer this tool must never
    // fabricate (instrument-discipline.md MUST-1).
    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          {
            enumeration_failure: true,
            reason: "zero-suites-enumerated",
            layouts_probed: SUITE_LAYOUTS.map((L) => L.id),
            changed: changed.length,
            owed: [],
            subtree: [],
            tree_wide: [],
            broad: [],
            blind_spots: blindSpots,
            fanout_max: FANOUT_FLOOR,
            fanout_max_source: "readability-floor (zero suites enumerated — nothing to derive from)",
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      process.stdout.write("\n" + msg);
    }
    process.exit(0);
  }
  if (truncated) {
    process.stderr.write(
      `owed-suites: suite scan TRUNCATED at ${SUITE_SCAN_MAX} — ${truncated} further suite file(s) were ` +
        "NOT read, so the owed set below is INCOMPLETE by that many candidates.\n",
    );
  }
  if (oversize) {
    process.stderr.write(
      `owed-suites: ${oversize} suite file(s) exceeded ${SUITE_BODY_MAX} bytes and were NOT read — ` +
        "their ownership is unevaluated, not absent.\n",
    );
  }

  // THE BOUND, derived from this corpus (see the header). An explicit --fanout-max or
  // OWED_SUITES_FANOUT_MAX wins and is reported as an override.
  const fan = deriveFanoutMax(suites, sourceBasenames, {
    explicit: args.fanoutMax,
    explicitSource: args.fanoutSource,
  });
  const FANOUT_MAX = fan.max;

  // Fan-out: how many suites reference each basename. Computed over the SUITE corpus,
  // once, so the bound is a property of the corpus rather than of this diff.
  const fanout = new Map();
  for (const s of suites) {
    for (const c of changed) {
      const b = path.basename(c);
      if (!b) continue;
      if (s.body.includes(b)) fanout.set(b, (fanout.get(b) || 0) + 1);
    }
  }

  // SPECIFIC owners and ALWAYS-OWED tree-wide scanners are reported SEPARATELY.
  // Mixed together, 7 always-owed rows bury the 1 row that names this diff's subject
  // — the 63%-noise shape a WIP surface already taught this repo to scroll past.
  const owed = new Map(); // suite rel -> Set of reasons (SPECIFIC only)
  const broad = [];
  const add = (s, why) => {
    if (!owed.has(s.rel)) owed.set(s.rel, new Set());
    owed.get(s.rel).add(why);
  };

  const sourceish = changed.filter((c) => SOURCEISH_RX.test(c));
  for (const c of changed) {
    const b = path.basename(c);
    const stem = b.replace(SOURCE_EXT_RX, "");
    const n = fanout.get(b) || 0;
    if (n > FANOUT_MAX) broad.push({ file: c, suites: n });
    // A DECLARATIVE file (json/yaml/toml/md) may be owned by a suite of ANY layout —
    // every language reads config. A CODE file may only be NAMED by a suite whose
    // layout speaks that language, so `test_foo.py` cannot claim `foo.rs` on the
    // strength of a shared stem.
    const declarative = DECLARATIVE_RX.test(b);
    for (const s of suites) {
      const sameLanguage = declarative || s.sources.test(b);
      if (sameLanguage && s.stem === stem) add(s, `NAMED ${c}`);
      else if (n > 0 && n <= FANOUT_MAX && s.body.includes(b)) add(s, `REFERENCED ${c}`);
    }
  }
  const treeWide = sourceish.length ? suites.filter((s) => s.treeWide).map((s) => s.rel).sort() : [];

  // SUBTREE scanners get their OWN band, grouped by root. MEASURED at authoring: for a
  // 2-file change under .claude/hooks/lib/, folding them into the specific band produced
  // 40 owners and buried the 1 row that named the subject. A list that long is not a
  // finding, it is a directory listing — so it is separated and grouped rather than
  // mixed in, and the deepest roots print first because they are the tightest claims.
  const subtreeByRoot = new Map();
  for (const s of suites) {
    for (const root of s.subtrees || []) {
      if (!changed.some((c) => c === root || c.startsWith(root + "/"))) continue;
      if (s.treeWide) continue; // already reported in the always-owed band
      if (!subtreeByRoot.has(root)) subtreeByRoot.set(root, new Set());
      subtreeByRoot.get(root).add(s.rel);
    }
  }
  const subtreeBands = [...subtreeByRoot.entries()]
    .map(([root, set]) => ({ root, suites: [...set].sort() }))
    .sort((a, b) => b.root.split("/").length - a.root.split("/").length || a.root.localeCompare(b.root));

  const rows = [...owed.entries()].map(([rel, why]) => ({ suite: rel, reasons: [...why].sort() })).sort((a, b) => a.suite.localeCompare(b.suite));

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          changed: changed.length,
          owed: rows,
          subtree: subtreeBands,
          tree_wide: treeWide,
          broad,
          blind_spots: blindSpots,
          suites_enumerated: suites.length,
          layouts: Object.fromEntries(perLayout),
          truncated,
          fanout_max: FANOUT_MAX,
          fanout_max_source: fan.source,
          fanout_percentiles: fan.percentiles,
          fanout_referenced_basenames: fan.referenced_basenames,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  const say = (s) => process.stdout.write(s + "\n");
  say("");
  say(`OWED SUITES — ${changed.length} changed file(s); ${rows.length} suite(s) NAME or REFERENCE them`);
  say("");
  if (!rows.length) {
    say("  none names or references anything in this diff.");
  } else {
    for (const r of rows) say(`  ${r.suite}\n      ${r.reasons.join("\n      ")}`);
    say("");
    say("Run them:");
    // The invocation is LAYOUT-derived, not hardcoded. A `node --test` line printed
    // over `tests/unit/test_billing.py` is not a small cosmetic wrong: it is an
    // instruction that cannot work, handed to the reader at the exact moment the tool
    // is asking them to act on it.
    for (const [id, group] of groupByLayout(rows.map((r) => r.suite), suites)) {
      const runner = RUNNERS[id] || RUNNERS._default;
      say(`  ${runner(group)}`);
    }
  }
  if (subtreeBands.length) {
    say("");
    say("ENUMERATE A DIRECTORY YOUR CHANGE IS UNDER — these own it as a POPULATION and");
    say("may never name the file, so reference-matching cannot find them. Deepest root first:");
    for (const b of subtreeBands) {
      say(`  ${b.root}/  (${b.suites.length} suite(s))`);
      for (const q of b.suites.slice(0, 6)) say(`      ${q}`);
      if (b.suites.length > 6) say(`      … and ${b.suites.length - 6} more`);
    }
  }
  if (treeWide.length) {
    say("");
    say(`ALWAYS OWED on any source change — ${treeWide.length} whole-tree scanner(s), listed`);
    say("separately so they cannot bury the suites that name THIS diff:");
    for (const t of treeWide) say(`  ${t}`);
  }
  if (broad.length) {
    say("");
    say(`BROADLY REFERENCED — no owner claimed (over the fan-out bound of ${FANOUT_MAX}):`);
    for (const b of broad) say(`  ${b.file} — referenced by ${b.suites} suites; naming them all names none`);
    say(
      `  Bound: ${FANOUT_MAX} — ${fan.source}. This corpus: p50 ${fan.percentiles.p50}, p75 ${fan.percentiles.p75}, ` +
        `p90 ${fan.percentiles.p90}, max ${fan.percentiles.max} over ${fan.referenced_basenames} referenced basename(s).`,
    );
    say("  It is DERIVED HERE, not inherited: re-run with --fanout-max <n> to see another bound,");
    say("  or pin OWED_SUITES_FANOUT_MAX in this repo. A bound from another repo does not transfer.");
  }
  say("");
  if (blindSpots.length) {
    say("");
    say("LAYOUT BLIND SPOT — this diff touches files of a language whose test layout");
    say("this scan found NONE of. The silence above is about THIS TOOL, not about your");
    say("coverage, and must not be read as 'no suite owes you a run':");
    for (const b of blindSpots) {
      say(`  ${b.changed_files} changed file(s) match the ${b.layout} layout (${b.label}) — 0 such suites enumerated`);
    }
  }
  say("");
  say(
    `Enumerated ${suites.length} suite(s) across ` +
      ([...perLayout.entries()].map(([k, v]) => `${k}:${v}`).join(", ") || "no layout") +
      ".",
  );
  /* The bound is reported HERE, unconditionally, not only inside the BROAD block. It
   * shapes which files got resolved to owners on EVERY run, including runs where
   * nothing was broad — so a reader calibrating it must not have to provoke a BROAD
   * row first to find out what it was. */
  say(
    `Fan-out bound: ${FANOUT_MAX} — ${fan.source}` +
      (fan.referenced_basenames
        ? ` (this corpus: p50 ${fan.percentiles.p50}, p75 ${fan.percentiles.p75}, p90 ${fan.percentiles.p90}, ` +
          `max ${fan.percentiles.max} over ${fan.referenced_basenames} referenced basename(s))`
        : "") +
      ". Not portable between repos: --fanout-max <n> or OWED_SUITES_FANOUT_MAX to change it.",
  );
  say("This REPORTS ownership. It does not run the suites, and a suite that owns a");
  say("file can still be blind to the defect in it.");
}

/* Run as a script; IMPORTABLE as a module.
 *
 * The entrypoint guard was added so `enumeratedSubtrees` — where the SUBTREE rule's
 * whole judgment lives — can be exercised directly. It could not be before, and that
 * had a measured cost: the `rel === "."` guard (which stops one suite claiming the
 * entire repo) is DOMINATED end-to-end by main()'s `changed.some(...)` prefix filter,
 * so removing it left every black-box case GREEN. Traced at the function boundary the
 * mutation is plainly live — the extractor returns `[]` guarded and `["."]` unguarded
 * — but no subprocess-level fixture could ever show that. A guard whose behaviour no
 * instrument can observe is not a verified guard (instrument-discipline.md MUST-2(b)). */
export { enumeratedSubtrees, collectSuites, layoutBlindSpots, deriveFanoutMax, corpusFanout, SUITE_LAYOUTS };

// Entry-point check: .claude/bin/lib/entry-point.mjs (symlink-safe; a lexical compare exits 0 silently).
if (isMainModule(import.meta.url)) {
  main();
}
