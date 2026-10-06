#!/usr/bin/env node
/**
 * @hook-event: PostToolUse:Edit|NotebookEdit|Write (verification) — the edited file exists on disk before its format is checked and corrected.
 *
 * Hook: auto-format
 * Event: PostToolUse
 * Matcher: Edit|Write|NotebookEdit (registered as a detector in its own trailing
 *   PostToolUse group at `.claude/hooks/dispatch-registry.json:414-423` — the
 *   matcher is :415, this hook's command entry is :419 — so it runs AFTER every
 *   reader of the edited file; dispatched by `dispatch.js PostToolUse`)
 * Purpose: Auto-format Python (black, else ruff), JavaScript/TypeScript/JSON
 *   (prettier), and YAML (prettier). Markdown is DELIBERATELY EXCLUDED — see
 *   the `.md` note at the YAML branch below.
 *
 * Exit Codes:
 *   0 = success (continue)
 *   2 = blocking error (stop tool execution)
 *   other = non-blocking error (warn and continue)
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const path = require("path");

// Timeout fallback — prevents hanging the Claude Code session
const TIMEOUT_MS = 10000;

// PIN THE FORMATTER. There is no ROOT package.json — and the root IS the cwd this
// hook passes to npx — no node_modules, and no prettier config anywhere in loom's
// own tree. (Two package.json files DO exist, both under codex-mcp-guard; neither
// is on this resolution path. A `.prettierrc.json` also exists inside a nested
// application subtree, but that is a SEPARATE repository mounted as a submodule
// and tracks none of loom's markdown.) So a bare `npx prettier` resolves whatever
// version sits in the npx cache: operator-dependent, and free to change with no
// diff to review. MEASURED on this machine — the cache held FIVE versions (3.4.2,
// 3.6.2, 3.8.0, 3.9.0, 3.9.6), which is direct evidence the unpinned resolve HAS
// drifted. Every behaviour this hook is trusted for is a property of a SPECIFIC
// prettier. Bump deliberately, with a re-measurement, never incidentally.
// Bound by a fixture that REDS: `.claude/audit-fixtures/auto-format/run.mjs`
// asserts the RESOLVED `--version` equals this constant, so a silent drift fails
// the fixture run rather than living in a registry row nobody reads.
//
// BOUND, stated honestly: `npx --yes prettier@<pin>` still resolves from a mutable
// registry on a cache miss. This closes DRIFT, not COMPROMISE. Closing compromise
// needs a lockfile (a devDependency + `package-lock.json`, invoked via
// `node_modules/.bin/prettier`, which pins the integrity hash rather than the
// range) or a vendored binary. Neither is landed here; this is the cheap half.
//
// `--yes` is NEUTRAL here, and that is MEASURED rather than assumed, because an
// adversarial review argued it was a regression that converted a fail-closed
// cache miss into an automatic network install. It does not: WITHOUT `--yes`, on
// a genuinely uncached version (control: `npx --offline prettier@3.3.3` exits
// non-zero), with stdin closed and no TTY, npx printed `npm warn exec The
// following package was not found and will be installed` and installed and ran it
// anyway, rc=0, rewriting the file. The pre-existing form was ALREADY fetching and
// executing from the network without confirmation; `--yes` only suppresses a
// prompt that never appears non-interactively. So do NOT remove `--yes` believing
// it restores a fail-closed posture — there was none to restore, and the real
// residual is the missing lockfile named above.
const PRETTIER_PIN = "prettier@3.9.6";
// NAME and VERSION are PARSED OUT OF THE PIN, never re-typed (reviewer F2). A
// second, hand-written copy of the version is a copy that can drift from the pin
// while every check still reports success — the failure mode this whole block is
// built to avoid. `lastIndexOf("@")` is the version boundary for BOTH `name@ver`
// and `@scope/name@ver`. A pin with no `@` yields empty strings, which fail the
// predicates below and fall back to `npx` — fail closed, never a partial match.
const _PIN_AT = PRETTIER_PIN.lastIndexOf("@");
const PRETTIER_PIN_NAME = _PIN_AT > 0 ? PRETTIER_PIN.slice(0, _PIN_AT) : "";
const PRETTIER_PIN_VERSION = _PIN_AT > 0 ? PRETTIER_PIN.slice(_PIN_AT + 1) : "";
let _timeout = null;

// ── RESOLVED-BINARY FAST PATH (perf/hook-cost) ───────────────────────────────
//
// MEASURED (perf/hook-cost lane harness — no path is cited because it is a
// lane-scratch instrument, not a repo artifact: this hook invoked standalone with
// one fixed PostToolUse payload, N=6 serial, CPU = user+sys from `/usr/bin/time
// -l`, child spawns counted by a `child_process` preload whose control fires on a
// known one-spawn subject; Apple M4 Pro, node v25.8.2, npx cache warm):
// `npx --yes prettier@3.9.6 --write <file>` costs ~410 ms CPU, which is ~75 % of
// the whole PostToolUse Edit dispatch (~560 ms) for ONE edited .json. The npm
// CLI's own startup is the cost; prettier's share is ~40 ms — the same as a bare
// `node` start.
//
// PROCESS COUNT, STATED WITH ITS INSTRUMENT (reviewer F4). A `child_process`
// census taken FROM the hook process saw TWO invocations for one formatter run —
// the `npx` call and the `sh -c "prettier"` shim npx spawns, which inherits the
// census preload through NODE_OPTIONS. A census that does not follow that
// inheritance (or a process-tree count) sees only the first. The DURABLE claim
// here is therefore the CPU delta above, not the process count.
//
// WHAT PARITY ACTUALLY HOLDS. The fast path reproduces npx's own CACHE KEYING —
// the single directory npx would install this pin into, derived from the same
// spec hash (see `cachedPrettierDir`) — requires the pinned NAME and VERSION from
// that package's own manifest, and starts that package's own declared `bin` entry
// under node with the same argv and the same cwd, from the environment's default
// npm cache. The program run is one that CLAIMS the pinned identity: its own
// manifest says `prettier@3.9.6`, the install directory's manifest corroborates it
// (`_npx.packages`), and both are contained by path. That is a CLAIM, corroborated
// — NOT a verification of the bytes, which this path does not perform (see the
// integrity paragraph below).
//
// WHAT DOES NOT HOLD, STATED RATHER THAN GLOSSED. This paragraph replaces an
// earlier claim that the fast path runs "the same file npx would run" and is "not
// a weaker trust position" — as written that claim was FALSE, because the two
// resolutions are not the same resolution:
//   - a project `.npmrc` (or any npm config that is not an environment variable)
//     setting `cache=` is IGNORED here: this path reads `npm_config_cache`,
//     `NPM_CONFIG_CACHE` and `~/.npm` only, so it can select a DIFFERENT COPY of
//     prettier than npx would;
//   - a project-local prettier install is likewise not consulted.
// Both differences select only among copies of the SAME pinned name@version; a
// wrong name or a wrong version falls back to `npx` untouched, and the
// containment below refuses a package resolving outside the cache root.
//
// WHAT IS NOT TRADED — THE PIN, AND THE CALL SITES. Both pinned `execFileSync`
// invocations stay where they were; this is purely an ADDITIVE short-circuit in
// front of each. Every doubt — no cache, a relocated cache, an unreadable
// manifest, a name or version mismatch, an absent `bin`, a path resolving outside
// the cache root, a spawn error — returns false and the ORIGINAL `npx` call runs,
// so a cold cache reproduces today's behaviour exactly.
//
// WHAT THIS CLOSES, AND WHAT IT DOES NOT. It removes npm-CLI startup from the
// warm path. It adds NO INTEGRITY VERIFICATION: a cache entry is only as
// trustworthy as the cache, which is the residual the PRETTIER_PIN comment above
// already names. The name+version predicates below choose WHICH cached program
// runs; they do not vouch for its bytes.
/**
 * The npx cache directory npx ITSELF would install this pin into.
 *
 * npx keys its cache on a HASH OF THE PACKAGE LIST, never on a scan:
 *   hash = sha512(packages.map(dir→fetchSpec).sort(localeCompare 'en').join("\n"))
 *            .digest("hex").slice(0, 16)
 *   installDir = resolve(npxCache, hash),  npxCache = join(<npm cache>, "_npx")
 * (MEASURED against the shipped algorithm: npm's
 * `node_modules/libnpmexec/lib/index.js:238-250`, and `npxCache` at
 * `@npmcli/config/lib/definitions/definitions.js:340`.) For a single registry
 * spec the map is the identity, so the input is exactly PRETTIER_PIN.
 *
 * WHY A SINGLE CANDIDATE AND NOT A SCAN (security review, HIGH). A scan over
 * `_npx/*` selects by READDIR ORDER. MEASURED on the authoring host: THREE cache
 * directories held a prettier 3.9.6, and the scan hit the correct one only
 * because its hash happens to sort early. A decoy `prettier/` package planted in
 * another cache directory would have been selected instead. Deriving the ONE
 * directory npx uses removes the choice entirely.
 *
 * @returns {{npxCache: string, dir: string}|null}
 */
function cachedPrettierDir() {
  try {
    const cacheRoot =
      process.env.npm_config_cache ||
      process.env.NPM_CONFIG_CACHE ||
      path.join(os.homedir(), ".npm");
    const npxCache = path.join(cacheRoot, "_npx");
    const hash = crypto
      .createHash("sha512")
      .update(PRETTIER_PIN)
      .digest("hex")
      .slice(0, 16);
    return { npxCache, dir: path.join(npxCache, hash) };
  } catch {
    return null;
  }
}

/**
 * The pinned prettier's entry file, or null.
 *
 * CONTAINMENT IS AGAINST THE CACHE ROOT (rules/security.md § Path Containment),
 * NOT against the package directory: `pkgDir` is itself a candidate path and may
 * be a symlink, so containing to it would be self-referential — it would vouch
 * for whatever it pointed at. BOTH sides go through the SAME resolver
 * (`fs.realpathSync`) and the comparison is separator-boundaried. The package's
 * own `bin` is then contained against the REAL package dir by the same method.
 *
 * The name and version predicates are TWO INDEPENDENT requirements, both read
 * from the resolved package's own manifest: the cached program must BE the pinned
 * package and must BE the pinned version. Any doubt returns null and the caller
 * runs the unchanged `npx` call.
 */
function cachedPrettierEntry() {
  try {
    const at = cachedPrettierDir();
    if (!at) return null;
    const cacheReal = _realOrNull(at.npxCache);
    if (!cacheReal) return null;

    const pkgReal = _realOrNull(path.join(at.dir, "node_modules", PRETTIER_PIN_NAME));
    if (!pkgReal) return null;
    if (pkgReal !== cacheReal && !pkgReal.startsWith(cacheReal + path.sep)) return null;

    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(pkgReal, "package.json"), "utf8"));
    } catch {
      return null;
    }
    if (
      !pkg ||
      pkg.name !== PRETTIER_PIN_NAME ||
      pkg.version !== PRETTIER_PIN_VERSION
    ) {
      return null;
    }

    // CORROBORATION FROM THE INSTALL DIR'S OWN MANIFEST (optional hardening,
    // reviewer finding 5). libnpmexec writes `<installDir>/package.json` with
    // `_npx: { packages }` naming the SPECS it installed there (npm's
    // `node_modules/libnpmexec/lib/index.js:308`, MEASURED against this machine's
    // cache: `{"dependencies":{},"_npx":{"packages":["prettier@3.9.6"]}}`). This is
    // npx's own record that the directory belongs to THIS spec, which is evidence
    // the package manifest above cannot supply on its own.
    //
    // PLACED AFTER the name/version predicates on purpose: those are the two the
    // named fixture cases target, and checking `_npx` first would refuse those
    // cases for the wrong reason. ABSENT ⇒ refuse: "not provably an npx install
    // for this spec" is a doubt, and every doubt falls back to `npx`.
    let installManifest;
    try {
      installManifest = JSON.parse(fs.readFileSync(path.join(at.dir, "package.json"), "utf8"));
    } catch {
      return null;
    }
    const npxPkgs = installManifest && installManifest._npx && installManifest._npx.packages;
    if (!Array.isArray(npxPkgs) || npxPkgs.length !== 1 || npxPkgs[0] !== PRETTIER_PIN) {
      return null;
    }

    const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin && pkg.bin.prettier;
    if (typeof rel !== "string" || !rel) return null;

    const entryReal = _realOrNull(path.resolve(pkgReal, rel));
    if (!entryReal) return null;
    if (entryReal !== pkgReal && !entryReal.startsWith(pkgReal + path.sep)) return null;

    try {
      if (!fs.statSync(entryReal).isFile()) return null;
    } catch {
      return null;
    }
    return entryReal;
  } catch {
    return null;
  }
}

/** `fs.realpathSync`, or null when the path will not resolve (never throws). */
function _realOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Run the pinned prettier from its resolved cache entry.
 *
 * @returns {boolean} true when prettier RAN, false when the caller must fall back
 *   to the unchanged `npx` call — a RESOLUTION MISS or a SPAWN ERROR only.
 * @throws the child's own error when prettier RAN and did not complete normally —
 *   a NON-ZERO EXIT, or a SIGNAL (`e.signal`) — so the caller reports it exactly as
 *   it reports `npx` doing the same.
 *
 * WHY THE THROW IS NOT A FALLBACK (security review, MEDIUM). `execFileSync` sets
 * `status` to the exit code when the process ran and came back non-zero — a
 * syntax error in the edited file is the ordinary case — and leaves it null on a
 * spawn error. Falling back on a non-zero exit would run the formatter TWICE over
 * the same file and report the second run's outcome as if it were the first's.
 *
 * SIGNAL DEATH IS TREATED THE SAME WAY (reviewer finding 5): a killed child also
 * reports `status === null`, and falling back on it would re-run the formatter over
 * a file the first run may already have half-written. `e.signal` is what
 * distinguishes that case from a spawn error, and it takes the throw.
 */
function runCachedPrettier(resolvedPath, resolvedCwd) {
  const entry = cachedPrettierEntry();
  if (!entry) return false;
  try {
    execFileSync(process.execPath, [entry, "--write", resolvedPath], {
      stdio: "pipe",
      cwd: resolvedCwd,
    });
    return true;
  } catch (e) {
    if (e && (typeof e.status === "number" || e.signal)) throw e;
    return false;
  }
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). Everything a standalone run
// did at load time happens here instead, so a require() has no side effects.
function hookMain() {
  _timeout = setTimeout(() => {
    console.log(JSON.stringify({ continue: true }));
    process.exit(1);
  }, TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      try {
        onStdinEnd(input);
      } catch (e) {
        return reject(e);
      }
      resolve();
    });
  });
}

function onStdinEnd(input) {
  try {
    const data = JSON.parse(input);
    const result = autoFormat(data);
    console.log(
      JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          formatted: result.formatted,
          formatter: result.formatter,
        },
      }),
    );
    process.exit(0);
  } catch (error) {
    console.error(`[HOOK ERROR] ${error.message}`);
    console.log(JSON.stringify({ continue: true }));
    process.exit(1);
  }
}

function autoFormat(data) {
  const filePath = data.tool_input?.file_path;
  const cwd = data.cwd || process.cwd();

  if (!filePath || !fs.existsSync(filePath)) {
    return { formatted: false, formatter: "none" };
  }

  // Validate file is within the project directory to prevent symlink attacks.
  //
  // `resolvedCwd` has a SECOND job, and omitting it was a live defect. Every
  // formatter below is spawned with an ABSOLUTE file path, and prettier resolves
  // `.prettierignore` relative to ITS OWN cwd, never relative to the file it is
  // handed. So when this hook ran from anywhere but the repo root, the ignore
  // file was invisible and every fence in it was INERT — including the one
  // written specifically for `.claude/sync-manifest.yaml`, whose `use_softenings:`
  // block requires single-line `- {json}` items that a prettier reflow destroys,
  // taking `sync-tier-aware.mjs::parseUseSoftenings` and the whole USE lane down
  // with it (journal/0563, loom #1281). The fence was present and did nothing.
  //
  // MEASURED bipolar on one tree, same absolute path, only cwd differing:
  // from the repo root prettier printed nothing and left the manifest
  // byte-identical; from a scratch directory it reformatted it and 12 broken
  // items appeared. Passing `cwd` below is what makes the ignore file reachable.
  // Both sides go through the SAME resolver and the comparison is
  // separator-boundaried. `security.md` § Path Containment requires exactly this,
  // and the previous form met neither half: it compared `path.resolve` output,
  // which performs NO symlink resolution — so the "prevent symlink attacks"
  // sentence above was vouching for protection the code did not provide — and it
  // used a bare `startsWith`, under which a sibling whose name merely EXTENDS the
  // root (root `/a/b`, candidate `/a/bevil/x`) passes containment. Fails CLOSED:
  // a path that will not resolve is refused rather than admitted.
  const realOrNull = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  };
  const resolvedPath = realOrNull(path.resolve(filePath));
  const resolvedCwd = realOrNull(path.resolve(cwd));
  if (!resolvedPath || !resolvedCwd) {
    return { formatted: false, formatter: "path did not resolve" };
  }
  if (
    resolvedPath !== resolvedCwd &&
    !resolvedPath.startsWith(resolvedCwd + path.sep)
  ) {
    return { formatted: false, formatter: "path outside project" };
  }

  const ext = path.extname(filePath).toLowerCase();

  try {
    // Python files: black or ruff
    if (ext === ".py") {
      try {
        execFileSync("black", [resolvedPath], { stdio: "pipe" });
        return { formatted: true, formatter: "black" };
      } catch {
        // Try ruff if black not available
        try {
          execFileSync("ruff", ["format", resolvedPath], { stdio: "pipe" });
          return { formatted: true, formatter: "ruff" };
        } catch {
          return { formatted: false, formatter: "none (black/ruff not found)" };
        }
      }
    }

    // JavaScript/TypeScript files: prettier
    if ([".js", ".jsx", ".ts", ".tsx", ".json"].includes(ext)) {
      try {
        // perf/hook-cost — the resolved-cache short-circuit (§ RESOLVED-BINARY FAST
        // PATH above). False means "not run": fall through to the pinned npx call.
        if (!runCachedPrettier(resolvedPath, resolvedCwd)) {
          execFileSync("npx", ["--yes", PRETTIER_PIN, "--write", resolvedPath], {
            stdio: "pipe",
            cwd: resolvedCwd,
          });
        }
        return { formatted: true, formatter: "prettier" };
      } catch {
        return { formatted: false, formatter: "none (prettier not found)" };
      }
    }

    // YAML: prettier.
    //
    // § MARKDOWN IS DELIBERATELY EXCLUDED — `.md` was in this list until
    // 2026-09-15 and it CORRUPTED CONTENT, silently, in files nobody had edited.
    //
    // prettier rewrites a markdown file WHOLE, and its INLINE re-printer does not
    // round-trip two shapes this corpus is dense in. Both are content damage, not
    // layout, and both land on lines the author never touched:
    //   (1) a wrapped expression whose continuation line begins with ">" —
    //       CommonMark reads it as a blockquote INTERRUPTING the paragraph, so the
    //       reprint inserts a blank line and a spurious "> " marker mid-prose;
    //   (2) backtick-dense prose, especially code spans containing ESCAPED
    //       backticks — the reprint joins the next line and DROPS the separating
    //       space, turning "`x.md` MUST-4" into "`x.md`MUST-4".
    // Shape (2) carries no ">" at all, so a fix scoped to the blockquote case
    // leaves it live. That is why both are named.
    //
    // Shape (2) REPRODUCED verbatim at landing, on a file that SHIPS: running
    // prettier 3.9.6 over `.claude/rules/security.md` joined lines 260-261 and
    // deleted the space, yielding `...<f>.md\`.`and the provenance...`. The
    // instrument discriminates — the other two files in the same probe changed by
    // one line each, and an unpatched-vs-patched pair of this hook separates.
    //
    // MEASURED at 9103ad50e (derivation: `git ls-files '*.md'`, 4907 tracked):
    // 1282 files would be rewritten and 21 of those take NEW content damage
    // (delta-measured, so pre-existing legitimate constructions cancel). The other
    // 1261 were cosmetic table realignment. That 21 is PROSPECTIVE — files prettier
    // WOULD damage on its next run. How many files are ALREADY corrupted is a
    // DIFFERENT question, and it was NOT established: no number should be inferred
    // from this comment. Two signature-matching attempts at it produced false
    // positives (escaped backticks break code-span parity, so a naive matcher flags
    // undamaged lines), which is why the open item names git-history attribution
    // rather than signature matching.
    //
    // THIS IS A FENCE AGAINST FUTURE DAMAGE, NOT A REPAIR. Nothing here fixes a
    // file already corrupted; the 21 are PENDING damage that this cut prevents.
    //
    // It also removes an UNDECLARED NORMALIZER. prettier was silently rewriting
    // markdown list markers to canonical `- ` form, and line-oriented governance
    // parsers depend on that form without declaring the dependency — see
    // `.claude/bin/validate-emit.mjs::findUnrecognizedAllowlistBullets`, which now
    // FLAGS a non-canonical marker instead of skipping it in silence. Measured
    // before that fix: one marker drifted to `* ` dropped the parsed
    // self-referential allowlist from 220 entries to 199, with exit 0 both ways —
    // 21 load-bearing paths left the Tier-1 gate and the only trace was a pass
    // count that went DOWN. Disarming without that fix would have armed this class.
    //
    // Corroboration, independent and pre-existing — `bin/lib/declaration-anchor.mjs`
    // reached the same conclusions from the other direction, with no stake in this
    // change: that `proseWrap` is already the default "preserve" (so no option was
    // available to fix this), and that the rule `.md` files are "not prettier-clean
    // at rest", which is the 1282 measured here.
    //
    // No prettier option fixes this, and prettier has no changed-hunk-only mode.
    // Formatting markdown bought table alignment; it cost silent corruption of the
    // prose corpus that IS this repo's product.
    //
    // ACCEPTED RESIDUAL — the upstream reprinter defect is OPEN, not deferred.
    // The space-drop is a defect in prettier's own inline printer; this repo cannot
    // fix it and does not vendor a patched build. NO Phase-2 row is booked and none
    // is owed: a dated debt against a third-party reprinter is the permanent-by-
    // default shape `hook-output-discipline.md` MUST-5(b) forbids. `phase2-
    // deferrals.json` additionally CANNOT hold this one — it is keyed
    // `<rule>.md#<clause>` and this residual lives in `hooks/` — so the in-place
    // acceptance is the correct binding of the three, not a fallback.
    //
    // ACCEPTED BY the co-owner, jack@terrene.foundation — a named human in a
    // standing role, as `completion-criterion.md` MUST-6 requires. The agent that
    // proposed this residual did NOT accept it: MUST-6 forbids that, and an agent
    // relaying its own acceptance one hop out would be the same defect.
    //
    // The revisit TRIGGER is OBSERVABLE, not a calendar backstop: prettier
    // round-tripping code spans (assert it with the fixture suite's anti-vacuity
    // case, which REDS when the payload stops corrupting). The deviation from
    // MUST-6's calendar backstop is recorded HERE rather than papered over with a
    // date nobody chose — the same shape `security.md` § "Accepted residual" and
    // `hook-output-discipline.md`'s own accepted residual take.
    //
    // This acceptance is a BET, logged and owned, NEVER a claim the residual is
    // harmless: until prettier fixes its inline printer, markdown in this repo has
    // no automated formatter at all, and any future re-enablement re-opens the
    // corruption class in full. Until then markdown stays un-formatted here.
    //
    // Sibling precedent, same class one file over: `.prettierignore` fences
    // `.claude/sync-manifest.yaml` because a prettier YAML reflow broke
    // `sync-tier-aware.mjs::parseUseSoftenings` and took the whole USE lane down
    // (loom #1281; receipts `journal/0558` for parseUseSoftenings and
    // `journal/0405` for the prettier half). That was patched per-file; this is
    // the root cut. The `journal/0563` pointer carried by `.prettierignore` and by
    // an earlier revision of this comment is WRONG and is corrected in both places
    // rather than inherited: measured, 0563 returns ZERO hits for `prettier`,
    // `parseUseSoftenings`, `softening` and `V17` against a firing control (36 for
    // `the`). `zero-tolerance.md` Rule 3e binding-inheritance is why it was
    // re-derived instead of copied — a restated citation is a fresh claim.
    // YAML stays formatted here on MEASUREMENT, not habit. Of 44 tracked yaml/yml
    // files, the count that matters is WOULD-BE-REWRITTEN, and it is exactly 1
    // (`.claude/.proposals/archive/2026-05-16-loom.yaml`). Stated that precisely
    // because an earlier figure of 2 came from collapsing two different facts: one
    // more file is an unparseable `{{REGISTRY_ORG}}` template that prettier ERRORS
    // on, which is CANNOT-PROCESS, not declines-to-change — prettier can never
    // rewrite it, so it does not belong in a would-rewrite count. The manifest is a
    // third distinct case, measuring `ignored: true` under the fence above. A count
    // whose definition is unstated is the defect this whole change is about.
    if ([".yaml", ".yml"].includes(ext)) {
      try {
        // perf/hook-cost — as the .js/.ts/.json branch above.
        if (!runCachedPrettier(resolvedPath, resolvedCwd)) {
          execFileSync("npx", ["--yes", PRETTIER_PIN, "--write", resolvedPath], {
            stdio: "pipe",
            cwd: resolvedCwd,
          });
        }
        return { formatted: true, formatter: "prettier" };
      } catch {
        return { formatted: false, formatter: "none" };
      }
    }

    return { formatted: false, formatter: "unsupported file type" };
  } catch (error) {
    return { formatted: false, formatter: `error: ${error.message}` };
  }
}

module.exports = { hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
