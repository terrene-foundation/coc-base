#!/usr/bin/env node
/*
 * ============================================================================
 *  Synced-Artifact Disclosure Scanner — issue #263
 * ============================================================================
 *
 *  Structural fence around the now-closed #252 forest. /sync ships the
 *  `.claude/**` surface (plus AGENTS.md / GEMINI.md) to 30+ downstream
 *  repos. A single operator hostname, non-Foundation org slug, org-derived
 *  runner label, operator home path, or launchd/systemd service-label stem
 *  that survives into a synced artifact is the #252 disclosure class —
 *  correlatable across every consumer that pulls the template.
 *
 *  THIS SCRIPT IS ITSELF A SYNCED ARTIFACT (`bin/**` is a sync tier).
 *  Therefore it MUST NOT embed any real client codename, org slug,
 *  hostname, or service label. A denylist of secret tokens in a committed
 *  file IS the leak it is meant to prevent (that would become issue #264).
 *
 *  Detection is therefore TWO-LAYER and contains ZERO secret tokens:
 *    1. a POSITIVE allowlist of Foundation-public + ratified-placeholder
 *       vocabulary — these NEVER flag.
 *    2. structural SHAPE regexes — flag a line if it matches a disclosure
 *       shape AND no allowlist token covers the matched span.
 *
 *  Tuned so the CURRENT post-#260 main tree produces ZERO findings. That
 *  zero-on-main result is the structural receipt that the #252 forest is
 *  closed. Each allowlist addition beyond the issue spec is documented
 *  inline with its reason (search "ALLOWLIST-NOTE").
 *
 *  Usage:
 *    node .claude/bin/scan-synced-disclosure.mjs            human report
 *    node .claude/bin/scan-synced-disclosure.mjs --check    exit 1 if ≥1 finding
 *    node .claude/bin/scan-synced-disclosure.mjs --root DIR  scan a planted dir
 *    node .claude/bin/scan-synced-disclosure.mjs --help
 *
 *  Exit codes — the FULL vocabulary, each an outcome a caller must be able to
 *  tell apart (re-derived from the `process.exit` sites in this file, not
 *  restated from memory; `git grep -n 'process\.exit' <this file>` is the check):
 *
 *    0  the scan RAN to completion and the verdict is reportable — `--help`,
 *       a clean `--check`, and EVERY human-report run (report mode exits 0
 *       even WITH findings; only `--check` gates on them).
 *    1  `--check` mode ONLY: the scan RAN to completion and found ≥1 finding.
 *       This is the ONLY code that asserts a disclosure leak.
 *    2  the scan DID NOT START — a bad argument, a `--root` that does not
 *       resolve to a directory, a root carrying no synced surface, or a
 *       malformed tenant denylist / ecosystem registry. The ABSENCE of a
 *       result, never a clean one.
 *    3  the scan STARTED and DID NOT COMPLETE — an uncaught exception during
 *       file collection or file scanning. Disclosure status UNKNOWN: the
 *       surface was only PARTIALLY examined, so this is neither a finding nor
 *       an all-clear. See § CRASH FENCE at the scan loop for why it is a
 *       distinct code and not a reuse of 1 or 2.
 *
 *  A caller MUST NOT collapse these. Treating any non-zero as "findings"
 *  fabricates a leak out of a crash; treating only 1 as a failure lets a
 *  crashed scan pass as clean.
 *
 *  Findings NEVER print the raw matched token. Every line is rendered as
 *    path:line  [SHAPE:<id>]  <±20-char context, token → «REDACTED»>
 *  so the scanner's own output is safe to paste anywhere.
 * ============================================================================
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  SYNTHETIC_FIXTURE_USERS,
  deriveDynamicTokens,
  personIdentityTokens,
  PERSON_ID_FIELDS,
  rosterPersonEntries,
  denylistTokensOrThrow,
  personShapeProblem,
  trustAnchorTokens,
  foldForGate,
  readRegularFileNoFollow,
  UnsafeFileReadError,
  makeHomepathRe,
  isScrubPlaceholderToken,
} from "./lib/identity-scrub.mjs";
import { isAuditFixtureFile, isFixtureCorpusFile } from "./lib/fixture-corpus.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

// The loom#1471 subprocess envelope. HARD require, matching `clean-instantiate.mjs`:
// an ambient `git` is a steerable redirect (an inherited GIT_DIR answers about
// ANOTHER repository), and this scanner decides what is safe to distribute, so the
// correct disposition when the envelope is missing is not to start.
const _gse = createRequire(import.meta.url)("../hooks/lib/git-subprocess-env.js");

// ────────────────────────────────────────────────────────────────
// CLI args
// ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { mode: "report", root: null, allowSyntheticFixtureHomes: false, surface: "sync" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") args.mode = "check";
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--root") {
      // An EMPTY or missing value used to fall back to the scanner's own checkout, so
      // `--root "$DEST"` with DEST unset scanned loom and exited 0 on the destination it never
      // looked at. A `--root` must name something.
      const v = argv[++i];
      if (typeof v !== "string" || v.trim() === "") {
        console.error("scan-synced-disclosure: --root requires a non-empty directory argument");
        process.exit(2);
      }
      args.root = v;
    }
    // OPT-IN (client-template disclosure gate ONLY): tolerate a SYNTHETIC fixture home
    // (a `jdoe`/`fakeuser`-style `/Users/<name>/` in the SYNTHETIC_FIXTURE_USERS set) inside one
    // of loom's OWN detector fixtures — a `*.test.mjs` / `*.test.js` suite, OR any file under an
    // `audit-fixtures/<name>/` tree (the `run.mjs`/`run.cjs` runner convention and its sibling
    // candidate payloads). The client-template edition ships those fixtures with the homes
    // PRESERVED verbatim (loom#1318) so they still fire in a repo instantiated from the seed; a
    // REAL operator home (username NOT in the set) in ANY file — and a synthetic home in an
    // ORDINARY shipped file — still flags. DEFAULT OFF, so a generic consumer-destination scan
    // (and the `test-mjs-destination-flip` regression lock) is byte-identical.
    else if (a === "--allow-synthetic-fixture-homes") args.allowSyntheticFixtureHomes = true;
    // ── THE EXPLICIT SURFACE MODE (client-template blind-gate fix) ────────────────────────
    // WHY A MODE AND NOT A SECOND LIST. The never-synced predicate is written for the SYNC
    // surface, where the manifest's `exclude: test-harness/**` holds — and the client-template
    // PROJECTION gate was REUSING it over a tree that SHIPS those files. The gate therefore
    // never looked at `test-harness/**`, and MEASURED: four operator hostnames sat in
    // `ci-suites.json` / `ci-suites-bin.json`, both PRESENT in the projection, with the gate
    // returning `ok = true`. The fix is NOT another hand-maintained exclusion list — that is
    // the same drift one layer over. It is an explicit mode, so a caller cannot SILENTLY
    // inherit the sync list: `--surface projection` widens the surface to every file the WALK
    // REACHES, and the never-synced predicate is not consulted.
    //
    // ⛔ "EVERY FILE PRESENT IS IN SCOPE" STOOD HERE. IT IS FALSE, and the correction names the
    // two classes it was hiding rather than restating a smaller version of the same absolute.
    // Both are MEASURED; the first is the one that matters.
    //   (a) THE WALK ROOTS. `collectFiles` seeds `.claude/` plus `TOP_LEVEL_SYNCED_DIRS`
    //       (`.agents/skills`, `.codex`, `.gemini`, `.codex-mcp-guard`, `scripts`, `tools`).
    //       Repo-root `tests/`, `journal/`, `workspaces/`, `burndown/` and every other top-level
    //       path are NOT VISITED, so no file in them is in scope however this mode is set. NOT
    //       theoretical: a real canon trust-root key id sat in
    //       `tests/integration/operator-id.test.js`, and a `--surface projection` scan of THIS
    //       repo returned `0 findings` — while the SAME instrument, same run, on a fixture
    //       carrying a bare third-party org slug, returned 1. The zero was the WALK, not the
    //       surface, and it read exactly like a clean tree. `tests/` is skipped BY DECISION,
    //       with its reason and its accepted cost recorded at the `TOP_LEVEL_SYNCED_DIRS` note
    //       above — read that note before assuming this one is stale.
    //   (b) THE PER-FILE PREDICATES THAT SURVIVE THE FLIP. `isNeverSynced` is what this mode
    //       turns off, and it is consulted LAST. Everything above it in `isExcluded` still skips:
    //       the `.git` subtree; the two root declarations keyed to their one read path
    //       (`disclosure-tenant-denylist.json`, `disclosure-benign-collisions.json`); a
    //       source-only `ecosystem.json`; the gitignored operator companions; and the classes
    //       the walk NAMES rather than absorbs — binary files, unreadable entries (UNREAD), and
    //       symlinked directories it did not descend. MEASURED on the client-template
    //       projection: 8,837 regular files present (`find -type f`) against `Scanned: 8,692` —
    //       145 present-and-not-examined, which is the honest size of this clause on that
    //       surface. The mode removes the SYNC-SURFACE reasoning; it does not remove every
    //       reason to skip a file, and `Scanned: N` is a count over the walk, never over the tree.
    //
    // The sync path keeps its own list, unchanged, and remains the default.
    else if (a === "--surface") {
      const v = argv[++i];
      if (v !== "sync" && v !== "projection") {
        console.error("scan-synced-disclosure: --surface must be 'sync' (default) or 'projection'");
        process.exit(2);
      }
      args.surface = v;
    }
    else {
      // Named by SHAPE, not echoed: an argument can carry `/Users/<operator>/…`.
      console.error(`scan-synced-disclosure: unknown argument (${a.length} chars, starting ${JSON.stringify(a.slice(0, 2))})`);
      process.exit(2);
    }
  }
  return args;
}

function usage() {
  console.log(
    `Synced-Artifact Disclosure Scanner (issue #263)

Walks the SYNCED surface (.claude/** + AGENTS.md / GEMINI.md, minus
accepted-history / operator-local / binary exclusions) and flags lines
that match a structural disclosure SHAPE not covered by the positive
Foundation-public / placeholder allowlist.

Usage:
  node .claude/bin/scan-synced-disclosure.mjs            human report
  node .claude/bin/scan-synced-disclosure.mjs --check    exit 1 if ≥1 finding
  node .claude/bin/scan-synced-disclosure.mjs --root DIR  scan an alternate dir
  node .claude/bin/scan-synced-disclosure.mjs --help

Exit: 0 clean | 1 finding(s) in --check | 2 usage error.

Findings are printed with the matched token replaced by «REDACTED» —
the scanner's own output is safe to publish. Zero findings against the
current main tree is the structural receipt that the #252 forest is
closed (resolve any finding by genericizing + relocating to the
operator-local companion per the #255 / #260 pattern, never by
widening the allowlist to swallow a real token).`,
  );
}

// ────────────────────────────────────────────────────────────────
// Surface walk — scan .claude/** then apply exclusions, plus the
// top-level synced overlays. Simplest robust impl per the issue:
// scan broadly, exclude precisely.
// ────────────────────────────────────────────────────────────────
const TOP_LEVEL_SYNCED = ["AGENTS.md", "GEMINI.md", "CLAUDE.md", ".gitattributes", ".gitignore"];

// Top-level DIRECTORIES that leave this repo, and therefore belong to the surface this
// scanner fences. Until this list existed the walk covered `.claude/**` plus two top-level
// FILES and nothing else — so every path below was distributed UNSCANNED.
//
// DERIVED, not guessed, from the two authoritative routing sources:
//   1. `bin/lib/community-membership.mjs::INCLUDE` — the community-edition / public-fork
//      projection allowlist. Everything here is an INCLUDE root; `workspaces/` is NOT one.
//   2. `bin/sync-tier-aware.mjs` — the /sync engine. Its candidate walk (`walkClaudeDir`)
//      is rooted at `.claude/` alone, and `expandVariantOnly` routes a variant subtree to a
//      top-level destination (`scripts/`, `workspaces/`) at the TARGET. The variant sources
//      it reads live under `.claude/variants/**`, which the `.claude/` walk already covers.
//
// MEASURED at the time this landed (real `--dry-run --json` plans, all five lanes —
// `--target py|rs|base`, `--build py|rs`; 2527–5694 destinations each, so the extractor was
// shown to fire): ZERO destinations under `workspaces/`, and ZERO plan sources under the
// repo-root `workspaces/`. `isPublished("workspaces/…")` likewise returns false, against
// controls that return true for `.claude/rules/git.md` and false for `.claude/agents/
// management/…`. Repo-root `workspaces/` therefore distributes NOWHERE today and is
// deliberately NOT walked: widening to it would make the scan surface WIDER than the
// distributed surface, which is the same class of error as leaving it narrower — it burns
// the operator's attention on findings that cannot leave the repo. If a variant ever gains
// a `workspaces/` subtree it becomes distributed AND is already covered, because it lives
// under `.claude/variants/`.
//
// DO NOT "FIX" THIS FROM THE MANIFEST ALONE — it reads as a contradiction and is not one.
// `sync-manifest.yaml` DOES declare `workspaces/_template/**` in the coc-core tier, and a
// reader who finds that entry concludes the paragraph above is stale. Two separate lanes have
// now been sent at widening this walk on exactly that reasoning. The reconciliation: the sync
// engine's candidate walk (`bin/sync-tier-aware.mjs::walkClaudeDir`) seeds its stack with the
// `.claude/` directory ALONE and pushes only directories found beneath it, so a repo-root glob
// is NEVER OFFERED to the tier classifier and cannot match a candidate however it is declared.
// That tier entry is therefore DEAD — declared, and structurally unreachable by the engine that
// reads the declaration. It is a real defect, but it is the MANIFEST's, not this walk's, and
// widening here would encode the manifest's error into the fence.
//
// RE-MEASURED 2026-09-14 on a REAL `--target py` delivery (not a dry run): 5,493 files written,
// ZERO under `workspaces/`, against a control showing `scripts/` — a NON-`.claude` top-level
// root — IS delivered into the same tree. So the absence is a true negative, not an artifact of
// an instrument that only ever looks under `.claude/`.
//
// SCOPE THE CLAIM TO SOURCES, NOT TO DELIVERY — the `scripts/` control above is exactly why.
// Repo-root DESTINATIONS are plainly reachable: that control lands at `scripts/migrate.py` in the
// target. But its SOURCE is `.claude/variants/py/scripts/migrate.py`, routed to a top-level
// destination by the variant-only mechanism — a source UNDER `.claude/`. That is the whole shape:
// the engine can WRITE outside `.claude/`, and it only ever READS inside it. So "a repo-root glob
// never matches" is true of the CANDIDATE SET, and must not be restated as "repo-root content
// never ships" — the latter is false, and a reader who adopts it will mis-explain `scripts/` the
// next time this question comes round.
//
// THE TRAP, named so the next reader does not re-enter it: asking
// `bin/sync-tier-aware.mjs::buildLaneClassifier`'s `classify()` about these paths returns
// `copy/tier_match`, which looks like proof they ship. It is not. That predicate answers "does
// this path match a subscribed tier?" and says NOTHING about "is this path ever a candidate?"
// — one instrument read for two questions, `rules/instrument-discipline.md` MUST-4. The
// delivered tree is the discriminating instrument; the classifier is not.
//
// NOT imported from `community-membership.mjs`, deliberately: THIS FILE SHIPS (measured — it
// is a `dest` in the py plan), and that module is `loom_only`, so importing it would be
// ERR_MODULE_NOT_FOUND for every consumer — the exact broken-on-import class
// `community-import-closure.test.mjs` refuses. The two lists are instead pinned in step
// mechanically by `disclosure-scan-surface-parity.test.mjs`, the same literal-plus-parity-test
// shape `coc-artifact-eval.yml`'s ARTIFACT_SURFACE uses against its `push:` paths.
const TOP_LEVEL_SYNCED_DIRS = [
  ".agents/skills",
  ".codex",
  ".gemini",
  ".codex-mcp-guard",
  "scripts",
  "tools",
  // 2026-10-03 (disclosure-review finding d): `tests/` and `.github/` are BOTH published —
  // `community-membership.mjs::INCLUDE` carries `tests`, and the publish pipeline ships
  // `.github/**` as sync-gate2-worktree's surface records — yet NEITHER was walked, so the
  // two published trees were a scanner blind surface: a real identity in either could ship
  // unflagged, and the walk's silence about them was the absence of an instrument.
  //
  // The PREVIOUS note here deferred walking `tests/` because it measured 21 findings across
  // four files (19 by design — `eco-cross-ecosystem-disclosure-guard.test.js` necessarily
  // embeds the shapes the guard hunts). That deferral is now CLOSED by this change, and the
  // reconciliation chosen is the note's own third option, scoped: the disclosure-guard
  // test is scoped IDENTITY-ONLY by its exact path inside `isIdentityOnlyPath`, NOT a
  // blanket `*.test.js` skip — the earlier sweep's REAL username find in
  // `m9-1-fix-wave-regression.test.js` is exactly what a blanket skip would wave through, in
  // a PUBLISHED tree. Every remaining finding under either root was adjudicated one by one
  // in this change, with planted-value controls under BOTH roots in the fixture runner
  // (`new-walk-roots-planted-controls`) proving each root is reached.
  "tests",
  ".github",
];

// Active scan root (set by collectFiles; default repo root). Declared
// before isExcluded() so the scanner-own-file check resolves correctly.
let REPO_ROOT_ACTIVE = REPO_ROOT;

// Paths that sync-manifest.yaml `exclude:` declares NEVER-SYNCED. The
// disclosure scanner fences the SYNCED surface (the #252 forest is the
// content that reaches 30+ consumers); a real operator token in a
// never-synced file (the learning telemetry log, loom-only management
// agents, the local VERSION ledger, the loom-only test-harness) is NOT
// a sync disclosure — it never leaves this repo. Scanning it would bury
// the real sync-surface signal in thousands of non-actionable lines.
//
// NB: `sync-manifest.yaml` was listed above until 2026-08-16 and is NOT
// in this class — see its (removed) entry's replacement note below.
//
// R3 disclosure FIX (#263): `variants/` is NO LONGER blanket-excluded.
// `.claude/variants/{py,rs,prism}/**` are the language overlays that
// COMPOSE INTO the USE-template synced surface at emit time (per
// .claude/bin/emit.mjs::composeRule / variant-authoring.md) — they ARE
// downstream-shipped. A real operator token in a committed variant
// overlay reaches every consumer of that language template, exactly the
// #252 class. The prior blanket `variants/` exclusion was scope-evasion:
// it hid the composed-surface residues from the scanner. The genuinely
// non-synced variant companions (`*.operator.local.md`, `*.local.json`,
// `*.local.md`) stay excluded — but via the gitignored-companion suffix
// rules in isExcluded() (which run BEFORE this predicate), NOT via a
// blanket variants/ exclusion.
//
// Mirrors `exclude:` in .claude/sync-manifest.yaml — kept in sync by
// the same forest-closure discipline that authored it.

// The members of `sync-tier-aware.mjs::BUILD_ONLY_ALWAYS_INCLUDE` that live under
// `test-harness/`. Everything else under `test-harness/` is genuinely never-synced
// (the harness-wide `exclude: test-harness/**`), but this subtree is LIFTED OUT of
// that exclude on the /sync-to-build lane (classifyFile step 2c, `mode === "build"`)
// and DOES reach kailash-py / kailash-rs / kailash-prism.
//
// MEASURED on the real BUILD plan (`sync-tier-aware.mjs --build py --dry-run --json`,
// 4238 rows, 2881 non-skip — so the extractor was shown to fire): 6 files under
// `.claude/test-harness/lib/` with `action: "copy", reason: "build_only_always_include"`.
// Before this constant the scanner's `test-harness` skip was BLANKET, so every one of
// those 6 files was DISTRIBUTED UNSCANNED on every `/sync-to-build` delivery — and the
// gate that ships them (`sync-gate2-worktree.mjs::assertDisclosureClean` → this scanner
// with `--check --root <staged tree>`) reported CLEAN either way. Two-pole measurement
// at the fix: the SAME synthetic `operator-home-path` token planted at
// `.claude/rules/<f>.md` exited 1 `[SHAPE:operator-home-path]`, and planted at
// `.claude/test-harness/lib/<f>.mjs` exited 0 with `Scanned: 0 files` — the scan of a
// disarmed surface is byte-indistinguishable from a clean one, which is the whole
// defect class (`instrument-discipline.md` MUST-1).
//
// NOT imported from `sync-tier-aware.mjs`, for the SAME reason the
// `TOP_LEVEL_SYNCED_DIRS` block above is not imported from `community-membership.mjs`:
// THIS FILE SHIPS and that module does NOT. Both measured on the same plan —
// `.claude/bin/scan-synced-disclosure.mjs` is `action: "copy", reason: "always_include"`
// (the control), `.claude/bin/sync-tier-aware.mjs` is `action: "skip", reason:
// "loom_only"` — so a static import would be ERR_MODULE_NOT_FOUND for every consumer,
// the broken-on-import class `community-import-closure.test.mjs` refuses. The coupling
// is instead MECHANICAL: `disclosure-scan-surface-parity.test.mjs` derives its cases
// from `BUILD_ONLY_ALWAYS_INCLUDE` itself and asserts this scanner actually FLAGS a
// planted token at every shipped member — a behavioural pin, not a list comparison.
const BUILD_SHIPPED_HARNESS_GLOBS = ["test-harness/lib/**"];

// True iff `p` (a `.claude/`-stripped repo-relative path under `test-harness/`) is a
// path the /sync-to-build lane actually ships, OR an ANCESTOR DIRECTORY of one.
//
// The ancestor half is LOAD-BEARING, not defensive padding: `walk()` calls `isExcluded`
// on DIRECTORY entries and `continue`s without descending, so pruning `test-harness`
// itself would keep `test-harness/lib/**` unreachable no matter what the file-level
// predicate says. Measured while authoring this fix — the first revision omitted it and
// the two-pole probe still reported `Scanned: 0 files`, i.e. the "fix" changed nothing
// and its own green was non-discriminating.
//
// `**/*.test.mjs` is re-asserted here exactly as `classifyFile` step 2c re-asserts it,
// so a future `test-harness/lib/*.test.mjs` falls through to the universal
// `**/*.test.mjs` exclude instead of being treated as shipped.
function isBuildShippedHarnessPath(p) {
  if (p.endsWith(".test.mjs")) return false;
  return BUILD_SHIPPED_HARNESS_GLOBS.some((g) => {
    const base = g.endsWith("/**") ? g.slice(0, -2) : g; // "test-harness/lib/"
    if (g.endsWith("/**") ? p.startsWith(base) : p === g) return true;
    // ancestor directory of a shipped subtree → must be WALKED, never pruned
    return base.startsWith(p.endsWith("/") ? p : p + "/");
  });
}

function isNeverSynced(relPath, base, segs) {
  // .claude/ prefix is optional depending on scan root
  const p = relPath.replace(/^\.claude\//, "");
  const pSegs = p.split("/");
  if (pSegs[0] === "learning") return true;
  if (pSegs[0] === ".proposals") return true;
  // `test-harness/**` is never-synced EXCEPT the BUILD-lane-shipped subtree above —
  // scanning what the lane delivers, and nothing wider (a scan surface wider than the
  // distributed surface burns operator attention on findings that cannot leave the repo,
  // which is how a gate gets switched off; the converse invariant TOP_LEVEL_SYNCED_DIRS
  // records).
  if (pSegs[0] === "test-harness") return !isBuildShippedHarnessPath(p);
  if (pSegs[0] === "projects") return true;
  // PER-REPO TRUST + COORDINATION STATE. The operator roster and the trust root ARE
  // operator identity by definition — they are the declaration the
  // `operator-identity-token` shape reads — and both are owned by the repo that holds
  // them: `operators.roster.json` is committed at loom/BUILD and local-only at a
  // consumer (sync-manifest.yaml's consumer gitignore list), `trust-root.json` is a
  // `target_owned` entry each repo commits for itself. The `wip-authz/` ledgers and
  // `ref-adjudications.json` are the same repo's operational record of who authorised
  // what. MEASURED on the real `--dry-run --json` plans for all six lanes (`--target
  // base|py|rs`, `--build py|rs|prism`): every one is `skip` (`no_tier_match`, or
  // `loom_local` for the trust root) — none is ever distributed. Scanning them for the
  // operator identity they exist to record is a finding that cannot leave the repo, and
  // at a destination scan it would red Gate 2 on a target's OWN trust anchor.
  // `canon-identity-values.json` is the SAME class and joins them for the same reason: it IS
  // canon's own identity, declared rather than derived so the client-template value gate can
  // check values canon has RENOUNCED (an unreachable root is derivable from no checkout). It
  // never distributes — `loom_only` in sync-manifest.yaml AND CLIENT_TEMPLATE_REMOVE, both, so
  // it reaches neither a consumer tier nor a projection. Scanning it for the identity it exists
  // to record is a finding that cannot leave the repo. HONEST SCOPE, per `CLAUDE.md`'s own note
  // on this predicate: for a file skipped here the scanner is a NON-DISCRIMINATING instrument —
  // it returns the same verdict whether or not operator identity is present — so this is
  // correct because the file does not ship and never will, NOT because the scanner cleared it.
  if (p === "operators.roster.json" || p === "trust-root.json") return true;
  if (p === "canon-identity-values.json") return true;
  if (p === "ref-adjudications.json" || pSegs[0] === "wip-authz") return true;
  // NB: `.claude/cross-repo-authz/` receipts are handled SOURCE-ONLY in isExcluded()
  // below (mirroring the org-slug-bearing `ecosystem.json` entry) — NOT here. They
  // carry the target `<owner>/<repo>` slug, so a DESTINATION scan (`--root <consumer>`)
  // MUST still SCAN a leaked one (not suppress it) — flagging is best-effort, only WHEN
  // its org matches a disclosure shape; only the loom-SOURCE self-scan self-excludes them
  // (#1324). See the source-only guard next to `ecosystem.json` in isExcluded().
  // worktrees/ is gitignored and contains transient agent work directories
  // (each a full repo checkout under .claude/worktrees/agent-<hash>/). The
  // contents are not synced to consumers — they're operator-local agent
  // scratch space. Excluding them prevents the scanner from flagging
  // findings inside agent transients that NEVER reach a downstream surface.
  if (pSegs[0] === "worktrees") return true;
  // `.scratch/` is the orchestrator scratch surface (PR bodies, commit-message
  // buffers, throwaway analysis) — gitignored, never staged, never distributed.
  // The exclusion is LOAD-BEARING and is NOT redundant with the .gitignore entry:
  // this scanner walks `.claude/**` from the filesystem against ITS OWN exclusion
  // list and never consults gitignore, so an ignored-but-present directory is
  // scanned exactly as a tracked one is. MEASURED before this entry landed:
  // gitignoring the predecessor surface (`.claude/.prb/`) left the finding count
  // unchanged at 13 before and after, with the mutation confirmed reached — the
  // ignore rule alone silenced nothing. Pairs with the `.gitignore` entry + the
  // `sync-manifest.yaml::exclude` entry: the same three-layer defense-in-depth
  // `worktrees/` carries directly above.
  if (pSegs[0] === ".scratch") return true;
  // 2026-08-16: `sync-manifest.yaml` is NO LONGER skipped. The blanket skip
  // rested on a FALSE premise ("it never leaves this repo"). Manifest CONTENT IS
  // distributed — `multi_cli_overlays.multi-cli.manifest_distribute: true`
  // (issue #184) is a deliberate carve-out FROM the global
  // `exclude: sync-manifest.yaml` rule — agent-prose `cp` at coc-sync Step 4.6
  // until loom#1777 moved it into the engine, NARROWED by F95 to a three-stanza
  // projection (`sync-tier-aware.mjs::emitCliEmitProjection` writes
  // `.claude/.coc-cli-emit.yaml`; the verbatim `.claude/sync-manifest.yaml` copy
  // #1777 shipped is retired, because that path is the one emit.mjs Validator 16
  // requires ABSENT in a coc-use-template). EITHER WAY the write bypasses the
  // tier-lane copy loop, so `stripBuildInternalReferences` NEVER runs on it —
  // the projection slices its stanzas VERBATIM, which is the point (the
  // consumer's emitter must read the same declarations loom did). Those stanzas
  // reach every multi-CLI USE template with ZERO content transform, and those
  // templates are PUBLIC by design. So the one artifact shipping untransformed
  // to public consumers was the one file the scanner was hardcoded never to
  // inspect. It is therefore SCANNED — and scanning the SOURCE manifest is the
  // right scope even post-F95, since the projection is a verbatim slice of it and
  // is therefore clean iff the source stanzas are. (cc-only templates receive
  // nothing — `clis:` derives template_type — but "reaches fewer consumers" is
  // not "reaches none".) Same correction, same reason, as the F77 (#386)
  // settings.json removal from this list a few lines below.
  if (base === "VERSION") return true;
  // ANCHORED 2026-09-15 to the TOP-LEVEL file. `CLAUDE.md` is excluded because
  // loom's ROOT `CLAUDE.md` is operator-specific and never-synced — but the rule
  // was BASENAME-keyed with no depth anchor, so it also swallowed
  // `.claude/guides/claude-code/CLAUDE.md`, which DOES ship (measured: present in
  // the real py/rs/base plans). That file was distributed unscanned on every
  // delivery, and the scanner's clean exit said nothing about it either way.
  // This is the SAME basename-versus-path defect as the scanner's own
  // self-exclusion two hundred lines below; both were found by the same sweep.
  // `pSegs` has any `.claude/` prefix stripped, so length 1 IS the top-level
  // file at either a repo root or a `.claude/`-rooted scan. VERIFIED two-pole:
  // root `CLAUDE.md` stays ABSENT from the collected set, the shipped guide copy
  // becomes PRESENT, against a control confirming `AGENTS.md` is collected.
  if (base === "CLAUDE.md" && pSegs.length === 1) return true;
  // F77 (#386): settings.json IS synced to USE templates as committed
  // content. Operator-PII paths smuggled via `permissions.allow` /
  // `permissions.deny` entries — e.g. `Edit(/Users/<op>/repos/loom/**)` —
  // are correlatable across 30+ downstream consumers exactly like the
  // prose-level leaks the rest of the SHAPES catch. The scanner MUST
  // walk settings.json so the `operator-home-path` shape fires on those
  // `(/Users|/home)/<op>/` tokens regardless of whether they sit inside
  // a tool-call matcher (`Edit(...)`, `Write(...)`, `Read(...)`) or in
  // prose. `settings.local.json` REMAINS never-synced — that file is
  // gitignored per `permissions.deny` convention and carries genuine
  // per-operator local overrides.
  if (base === "settings.local.json") return true;
  // sync-preserve.local.yaml is the consumer-owned half of the scenario-11
  // sanctioned-local-preserve pair (sync-flow.md § Downstream Sync step 5b):
  // consumer-local, in the fixed NEVER-overwritten set, never propagates
  // upstream — same never-synced class as settings.local.json. The
  // template-carried `sync-preserve.yaml` (no `.local`) IS synced and is NOT
  // excluded here (it ships template→consumer and must be scanned like any
  // other synced artifact).
  if (base === "sync-preserve.local.yaml") return true;
  if (base === ".coc-sync-marker") return true;
  if (base === "scheduled_tasks.lock") return true;
  if (base === ".env" || /\.env$/.test(base)) return true;
  // loom-only management agents (excluded from sync per CLAUDE.md +
  // sync-manifest.yaml exclude:) — operator-local cp/path examples live
  // here legitimately because these files never reach a consumer.
  if (
    pSegs[0] === "agents" &&
    pSegs[1] === "management" &&
    /^(sync-reviewer|coc-sync|repo-ops|settings-manager)\.md$/.test(base)
  )
    return true;
  // operator-only debug dumps emitted by codex-mcp-guard tooling — these
  // capture the operator's absolute source_dir and are not synced
  // content (the *.dump.json convention is a local extract artifact).
  if (/\.dump\.json$/.test(base)) return true;
  return false;
}

// ────────────────────────────────────────────────────────────────
// git-tracking probe (operator-local destination-conditional parity)
// ────────────────────────────────────────────────────────────────
//
// A committed (git-TRACKED) file is public-distributable: it ships to every
// consumer that pulls the template. So it MUST be scanned regardless of a
// name pattern (`*.operator.local.md`) that would otherwise mark it
// operator-local. Only a file git confirms is UNTRACKED — the gitignored
// per-operator companion — may be skipped. TRACKED WINS over the name pattern.
//
// This replaces the earlier `REPO_ROOT_ACTIVE === REPO_ROOT` source/destination
// PROXY, which skipped every `*.operator.local.md` at loom-source
// UNCONDITIONALLY — so a TRACKED (committed) operator-local file at loom-source
// evaded the scrub. Git-tracking is the AUTHORITATIVE signal: the real companion
// (gitignored → untracked) is still skipped (zero-findings-on-main preserved),
// while a committed one (tracked) is scanned (the fix). Fail-CLOSED for a
// disclosure scanner: if git is unavailable, the root is not a work tree, or the
// status can't be determined, treat the file as TRACKED (SCAN) — never silently
// skip on an inconclusive probe.
const _workTreeCache = new Map();
function isInsideWorkTree(rootDir) {
  if (_workTreeCache.has(rootDir)) return _workTreeCache.get(rootDir);
  let inside = false;
  try {
    const out = execFileSync(
      "git",
      ["-C", rootDir, "rev-parse", "--is-inside-work-tree"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    inside = out.trim() === "true";
  } catch {
    inside = false; // git missing / not a repo → fail-closed (caller SCANs)
  }
  _workTreeCache.set(rootDir, inside);
  return inside;
}

// True iff `relPath` (relative to rootDir) is git-TRACKED in the repo
// containing rootDir. Fail-closed: only a positive "untracked" answer from a
// live git work tree returns false — every other outcome returns true (SCAN).
function isGitTracked(rootDir, relPath) {
  if (!isInsideWorkTree(rootDir)) return true; // no git → treat as tracked
  try {
    execFileSync(
      "git",
      ["-C", rootDir, "ls-files", "--error-unmatch", "--", relPath],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    return true; // exit 0 → tracked
  } catch (err) {
    // `ls-files --error-unmatch` exits status 1 for a genuinely-untracked path
    // → skip-eligible. ANY OTHER failure (index lock, IO error, pathspec-magic)
    // inside a confirmed work tree is INCONCLUSIVE → fail CLOSED (scan), never a
    // silent skip — matching this control's fail-closed contract (redteam LOW).
    if (err && err.status === 1) return false; // genuinely NOT tracked → skip-eligible
    return true; // inconclusive → treat as tracked → SCAN (fail-closed)
  }
}

// Path-segment / suffix exclusions (never scanned).
// IDENTITY-ONLY files. The scanner's own source and the two disclosure-detector fixture
// corpora carry disclosure SHAPES by design — the shape regexes themselves, and synthetic
// hostnames, org slugs and home paths planted to prove the shapes fire — so the structural
// shapes cannot run over them. They used to be EXCLUDED outright, and that exclusion is
// how the canon operator's real username, home path and host org shipped inside them to
// every consumer: all three paths are `copy` in the real distribution plans (measured, all
// six lanes), and an excluded file is a file nothing reads.
//
// So they are scanned, but ONLY by the identity shapes (`operator-identity-token`,
// `customer-identity-token`). Those shapes carry no synthetic vocabulary to trip over —
// their tokens exist only at runtime, from the roster and the tenant denylist — so a hit
// in one of these files is always a real identity in a shipped file.
//
// `private-key-material` runs here too. It is the one leak class with no synthetic
// vocabulary to protect: the corpus's single planted PEM marker is materialized by the
// fixture runner at scan time (`__PEM_BEGIN__`), so no marker is committed in these
// files and any marker that appears is a real one. Without it, a key pasted into a new
// fixture shipped unscanned — and at a root with no roster and no denylist (a consumer's
// in-place scan) ZERO shapes ran on these paths, the old wholesale exclusion by another
// route. Every OTHER shape stays off here. DECLARED BOUND: `operator-home-path` is off
// because the corpus plants non-synthetic usernames on purpose to prove the shape fires,
// so an unrostered person's home path in these files is not seen.
//
// Keyed on the LOOM-relative path, so when the fixture runner points `--root` AT a
// fixture tree (relPath then fixture-root-relative) the full shape set runs as it always
// did — that is the runner's whole purpose.
const IDENTITY_ONLY_SHAPES = new Set([
  "operator-identity-token",
  "customer-identity-token",
  "private-key-material",
]);
function isIdentityOnlyPath(relPath) {
  if (path.resolve(REPO_ROOT_ACTIVE, relPath) === SCRIPT_PATH) return true;
  // ANCHORED at the synced-surface root, with the optional leading `.claude` segment (a scan
  // may be rooted at a repo OR at its `.claude/`). Two earlier forms were too loose: a
  // SUBSTRING test admitted `…/scan-synced-disclosure-notes/`, and an any-DEPTH segment test
  // admitted `.claude/skills/zz/audit-fixtures/scan-synced-disclosure/sub/leak.md` — both
  // measured at 0 findings for content that flags elsewhere. Only the scanner's OWN source
  // path and the two corpora at their real location are identity-only.
  const all = relPath.split(path.sep).join("/").split("/");
  const segs = all[0] === ".claude" ? all.slice(1) : all;
  if (segs.length === 2 && segs[0] === "bin" && segs[1] === "scan-synced-disclosure.mjs") return true;
  // 2026-10-03 (walk-widening finding d): the cross-ecosystem disclosure-guard TEST is
  // the one PUBLISHED file whose content IS this scanner's own MUST-FLAG corpora — it
  // exercises that guard, so it necessarily embeds acme-corp-family org slugs and a
  // hostname case (the shape commentary's canonical flag examples, which is exactly why
  // the spans cannot be allowlisted away). Identity shapes STILL fire here, so a real
  // token planted in the file is not hidden by this scoping.
  if (all.join("/") === "tests/integration/multi-operator/eco-cross-ecosystem-disclosure-guard.test.js")
    return true;
  return (
    segs[0] === "audit-fixtures" &&
    (segs[1] === "scan-synced-disclosure" || segs[1] === "cross-ecosystem-disclosure-guard")
  );
}

// THE SCAN SURFACE, module-level for the same reason `REPO_ROOT_ACTIVE` is: `isExcluded` is
// reached from the walk with no argument to thread it through. Set ONCE from `--surface`, and
// read in exactly one place (the never-synced predicate) — a second read is where a surface
// mode starts to drift from itself.
let SCAN_SURFACE = "sync";

function isExcluded(relPath) {
  const segs = relPath.split("/");
  const base = segs[segs.length - 1];

  // .git is never content. The scanner's OWN file and its fixture corpus are NOT excluded
  // any more — they are scanned IDENTITY-ONLY (see isIdentityOnlyPath).
  if (segs[0] === ".git" || segs.includes(".git")) return true;
  if (isIdentityOnlyPath(relPath)) return false;
  // The loom-only tenant denylist (journal/0214) carries the literal
  // customer-identity tokens the `customer-identity-token` shape flags.
  // It MUST NOT be scanned-as-content (its own tokens would self-flag) and
  // it is never synced (sync-manifest.yaml `loom_only:`), so unlike the scanner's
  // own file (shipped, hence scanned identity-only) it is excluded outright.
  //
  // ANCHORED 2026-09-27 to the ONE path each file is READ from (`.claude/<name>` at the scan
  // root, or `<name>` at a `.claude/`-rooted scan). The skip was BASENAME-keyed at any depth, so
  // any file merely NAMED like it — `.claude/rules/x/disclosure-tenant-denylist.json` carrying an
  // operator home path — was never read (measured: rc=0, `0 findings`). Same basename-versus-path
  // defect as the `CLAUDE.md` and journal anchors elsewhere in this file.
  //
  // At the anchored path it stays skipped at EVERY root, source or destination — decided, not
  // inherited. The file there is not tree content but a DECLARATION this scan PARSES
  // (`loadCustomerIdentityShape` reads the scan root's copy): a fork carries its own, and the
  // fixture corpus plants one per tenant case (14 plantings in this runner, two committed fixture
  // trees). Scanning it would report the declaration's own tokens against itself. Whether a
  // DELIVERED one is a leak is a different question with a different instrument: both files are
  // `loom_only` (sync-manifest.yaml, the `loom_only:` entries for each), so /sync never offers them
  // to a consumer, and a copy arriving any other way is inside the fence that `loom_only` owns.
  //
  // ONLY A REGULAR FILE at that path is the declaration (round-2 item 2, 2026-09-28). The skip was
  // PATH-keyed, so a DIRECTORY named `.claude/disclosure-benign-collisions.json/` hid its whole
  // subtree (measured: a home path inside it, rc=0, `Scanned: 0 files`, no notice), and a LINK
  // there was never scanned as its target string. Anything else at the path — directory, link,
  // FIFO — is walked / scanned / named UNREAD like any other entry (the denylist path is also
  // refused at exit 2 by its parser).
  const isRegularFileHere = () => {
    try {
      return fs.lstatSync(path.join(REPO_ROOT_ACTIVE, relPath)).isFile();
    } catch {
      return false;
    }
  };
  // DECLARED BOUND (round-2, accepted): the CONTENT of the regular file at each anchored path is
  // never scanned — not the collision registry's other fields, not extra fields beside the
  // denylist's `tokens`. A payload smuggled there is outside this instrument; the protection is
  // the `loom_only` distribution fence that keeps both files out of every delivery.
  const isRootDeclaration = (name) => (relPath === `.claude/${name}` || relPath === name) && isRegularFileHere();
  if (isRootDeclaration("disclosure-tenant-denylist.json")) return true;
  // The #1068 benign-collision registry carries the literal tenant token in its
  // `token` field by design (it records which (token, host) substring collisions are
  // benign, e.g. a short token inside `HttpClient`). Identical self-flag / never-synced
  // (sync-manifest.yaml `loom_only:`) class as the denylist above — self-exclude so its
  // own legitimate tokens do not self-flag (preserving zero-findings-on-main). Anchored the
  // same way: `disclosure-adjudication.mjs::REGISTRY_REL` is the one path it is read from.
  if (isRootDeclaration("disclosure-benign-collisions.json")) return true;
  // The upflow ledgers (loom#1751(a)/(b)) key their rows on RESOLVER LOGICAL KEYS
  // of other repos in loom's fleet — and one of those keys carries a DENYLISTED
  // TENANT TOKEN by construction (`governance.<tenant>`; the token is in
  // disclosure-tenant-denylist.json). MEASURED 2026-10-03: recording a
  // disposition row for that repo made the row's own `target` key self-flag the
  // `customer-identity-token` shape, so the ledger could not record a decision
  // about it at all. Identical class to the two registries above — `loom_only`
  // in sync-manifest.yaml, "meaningless — and disclosing — anywhere else", the
  // SAME recorded reasoning the manifest entry carries — and SOURCE-ONLY,
  // mirroring the `ecosystem.json` destination-mode flip: at loom-source the
  // ledger is self-excluded so its own legitimate keys do not self-flag
  // (zero-findings-on-main preserved); at a DESTINATION scan a committed ledger
  // IS the disclosure event and stays in scope. The rows must key on the real
  // resolver key (the probe matches on it), so text-scrubbing is not expressible
  // here — the fence is the exclusion, not a rewritten token.
  if (
    (isRootDeclaration("upflow-dispositions.json") || isRootDeclaration("upflow-ingest-dispositions.json")) &&
    REPO_ROOT_ACTIVE === REPO_ROOT
  )
    return true;
  // The D6 ecosystem registry (ECO-IMPL W1) carries the REAL per-ecosystem org
  // slugs by design — it is loom-only (sync-manifest.yaml loom_only:) and
  // never reaches a consumer. The exclusion is SOURCE-ONLY (mirrors the #352
  // `*.local.json` destination-mode flip at :250): at loom-source
  // (REPO_ROOT_ACTIVE === REPO_ROOT) it is self-excluded so its OWN legitimate
  // slugs do not self-flag (preserving zero-findings-on-main). At a DESTINATION
  // scan (`--root <consumer>`), a committed `ecosystem.json` IS the disclosure
  // event the loom_only fence forbids (it shipped past the never-sync skip) —
  // so it is SCANNED there, and any bare non-allowlisted org/host slug fails
  // loud via the ecosystem-bare-org-slug shape below. ONLY the exact
  // `ecosystem.json` basename — `ecosystem.example.json` (synthetic tokens)
  // stays SCANNED in BOTH modes and is the positive fixture for that shape.
  if (base === "ecosystem.json" && REPO_ROOT_ACTIVE === REPO_ROOT) return true;
  // `.claude/fork-conference/<slug>.state.json` is the fork-conference generator's
  // per-fork cycle STATE: gitignored, `loom_local` in `sync-tier-aware.mjs`, and
  // keyed BY DESIGN on the fork's own identity (the `fork:` field), which can be
  // a tenant token. SOURCE-ONLY, the same disposition as `ecosystem.json` directly
  // above: at loom-source it self-excludes so a generated docket's state does not
  // fail the Gate-2 preflight (measured 2026-09-04 on HEAD: the one live source
  // finding was this file's `fork:` line); at a DESTINATION scan a leaked copy IS
  // the disclosure event and stays SCANNED. Deliberately NARROW: the generator's
  // OUTPUT under `out/` is not excluded — its content is scanned here exactly as
  // any other file, on top of the generator's own staged scan, so the two
  // instruments corroborate rather than one covering for the other.
  if (segs[0] === ".claude" && segs[1] === "fork-conference" && segs.length === 3 && base.endsWith(".state.json") && REPO_ROOT_ACTIVE === REPO_ROOT) return true;
  // The loom#1930 workspace-name ledger is, by construction, a list of INTERNAL
  // workspace names — that is its entire job: it is the floor the emission fence
  // strips against, and it exists precisely because those names must never ship.
  // Scanning it as content self-flags the very inventory it is keeping out of
  // consumers' trees (measured: a multi-word loom workspace name drawn from that
  // ledger's own `strip[]` list matched the `nonfoundation-org-slug` SHAPE). The
  // name is DESCRIBED and not QUOTED: this file ships `always_include`, and the
  // sentence directly above says those names must never ship — so quoting one
  // here would ship it, which is what an earlier revision of this comment did.
  //
  // SOURCE-ONLY, exactly mirroring the `ecosystem.json` disposition directly
  // above and for the same reason. The file is `loom_only`
  // (sync-manifest.yaml), so at loom-source it self-excludes and zero-findings
  // -on-main is preserved; at a DESTINATION scan (`--root <consumer>`) its mere
  // PRESENCE is the disclosure event the loom_only fence forbids, so it stays
  // SCANNED there and every internal name in it fails loud. Self-excluding in
  // both modes would hide the one case that actually matters.
  if (base === "loom-workspace-names.json" && REPO_ROOT_ACTIVE === REPO_ROOT)
    return true;
  // `.claude/bin/landing-cleanup-verdicts.json` is loom's one-time content verdict
  // over its OWN refs (landing-provenance lane, 2026-09-28): by construction it
  // records every ref name and the files each ref touched, and loom's ref names and
  // session-notes paths carry operator handles — so as content it self-flags on the
  // `operator-identity-token` shape (measured: 4463 findings, all in this file).
  // It is `loom_only` (sync-manifest.yaml), `EXCLUDE_WITHIN` for the community edition
  // and in `CLIENT_TEMPLATE_REMOVE`. SOURCE-ONLY, the same disposition as the two
  // ledgers above: at a DESTINATION scan a copy of it IS the disclosure event, so it
  // stays SCANNED there. Exact path, not basename: a same-named file elsewhere is scanned.
  if (relPath === ".claude/bin/landing-cleanup-verdicts.json" && REPO_ROOT_ACTIVE === REPO_ROOT)
    return true;

  // `.claude/cross-repo-authz/` holds per-operator cross-repo authorization RECEIPTS
  // (`<date>-<slug>.md`). By construction each embeds the target `<owner>/<repo>` slug —
  // the WHO-authorized-WHAT-against-WHICH-repo forensic payload `repo-scope-discipline.md`
  // § Affordance mandates — and the ceremony (`commands/cross-repo-authorize.md` Step 5)
  // directs COMMITTING them for durable team audit AT LOOM ONLY (`type: coc-source`);
  // every other repo class keeps them local, fenced by `sync-manifest.yaml::target_owned`
  // `publish: local_only`. They are never DISTRIBUTED to any consumer — containment is
  // THREE distribution fences: sync-tier-aware `no_tier_match`, edition-emit
  // `CLIENT_TEMPLATE_REMOVE`, community-membership `EXCLUDE_WITHIN`. All three govern
  // content flowing OUT OF LOOM and cover nothing written INTO another repo, which is why
  // the fence, not this scanner, is the fix. THIS scanner is a DETECTOR, not a fourth fence
  // (at a destination scan it flags a receipt that ALREADY shipped past every distribution
  // fence — it detects, it does not contain), and a leaked receipt fails loud only WHEN its
  // org matches a disclosure shape: best-effort detection bounded by content-shape coverage
  // (an arbitrary client `<org>/<repo>` matching no shape would NOT flag; the receipt
  // payload has no dedicated content shape). Matches whether the scan root is the repo
  // (`.claude/cross-repo-authz/…`) or `.claude/` itself.
  //
  // 2026-08-03 — TRACKED-KEYED, generalizing the `*.operator.local.md` precedent
  // below. This scanner walks the FILESYSTEM (`collectFiles`/`readdirSync`), so it
  // equated PRESENT ON DISK with ON THE SYNCED SURFACE. Measured counter-example:
  // kailash-coc-rs holds 4 receipts, 0 of them git-TRACKED (its operator had
  // already gitignored them), and the scanner still reported 12 findings on them.
  // Those findings are not disclosures — nothing untracked ships to any consumer —
  // and an instrument that cries wolf on a closed hole gets allowlisted, which is
  // how the NEXT real finding gets missed. So: a receipt git confirms is UNTRACKED
  // is skipped at EVERY root, source or destination. TRACKED WINS over the name
  // pattern, via the same fail-closed `isGitTracked` helper (git unavailable /
  // not-a-work-tree / inconclusive ⇒ treated as tracked ⇒ SCANNED).
  //
  // Deliberately NOT a universal untracked-skip: an untracked-but-STAGED
  // disclosure elsewhere would then evade the scrub. Scoped to this one class,
  // mirroring the operator-local precedent.
  //
  // A TRACKED receipt keeps the prior source-only disposition: at loom-source it
  // is skipped (committing is correct there and must not block the operator's
  // commit, #1324); at a DESTINATION scan it is SCANNED — a committed receipt at a
  // consumer IS the disclosure event, and it is exactly what the `target_owned`
  // `publish: local_only` fence now prevents going forward.
  const isCrossRepoAuthz =
    segs[0] === "cross-repo-authz" ||
    (segs[0] === ".claude" && segs[1] === "cross-repo-authz");
  if (isCrossRepoAuthz && !isGitTracked(REPO_ROOT_ACTIVE, relPath)) return true;
  if (isCrossRepoAuthz && REPO_ROOT_ACTIVE === REPO_ROOT) return true;

  // This scanner's OWN audit fixtures, and the cross-ecosystem-disclosure-guard fixtures
  // (#584: synthetic `canon` / `canon-origin` slugs), intentionally embed SYNTHETIC
  // disclosure shapes to prove the shapes fire. They were EXCLUDED here until 2026-09-25;
  // they are now scanned IDENTITY-ONLY — see isIdentityOnlyPath above isExcluded, which
  // returns before this point and records why the wholesale exclusion was the leak path.

  // accepted-history sweep reports + journals + proposals + session notes
  //
  // R2 exclusion-scoping FIX (#263): the prior journal predicate was
  // `segs.some(s => /^journal/.test(s))` — a `/^journal/` PREFIX on an
  // ARBITRARY path segment. It over-excluded every synced file whose
  // basename merely STARTS with `journal` (`rules/journaling-guide.md`,
  // `rules/journal-discipline.md` → 0-scanned → a synthetic leak in
  // either would never surface). The accepted-history exclusion is the
  // `journal/` DIRECTORY only — a path SEGMENT exactly equal to
  // `journal` (i.e. a `journal/`-rooted directory tree, never a file
  // basename). `rules/journaling-guide.md` is now scanned.
  //
  // `SWEEP-*` is already file-scoped (`/^SWEEP-.*\.md$/.test(base)`):
  // it matches a `SWEEP-<...>.md` FILE basename, NOT any `sweep*`
  // segment — verified correct, retained verbatim.
  //
  // ANCHORED 2026-09-15 — the R2 fix above narrowed PREFIX to EXACT-SEGMENT
  // but left the segment matchable at ANY DEPTH, so a directory merely NAMED
  // `journal` anywhere under the walk was swallowed by the accepted-history
  // rule. MEASURED: 18 files did exactly that and they SHIP —
  // `audit-fixtures/journal/**` (16) and two nested `**/loom/journal/` payloads
  // under `audit-fixtures/xref-absent/`. They are fixture corpora for the
  // JOURNAL rule, which is why they carry that directory name; being unscanned
  // was a name collision, not a decision. Anchoring to the ROOT segment keeps
  // the real accepted-history tree excluded at both a repo root and a
  // `.claude/`-rooted scan, and admits the collided fixtures.
  // Collected set 7485 -> 7504 with ZERO files LOST and ZERO new findings:
  // the 18 were CLEAN, so this closes an absent instrument rather than a live
  // leak — the distinction this file insists on everywhere else.
  if (/^SWEEP-.*\.md$/.test(base)) return true;
  if (segs[0] === "journal" || (segs[0] === ".claude" && segs[1] === "journal"))
    return true;
  if (base === ".session-notes") return true;
  // VS Code multi-root workspace files are operator-local IDE config
  // (the issue's exclusion list names one such file explicitly). Matched
  // by extension, NOT by the operator-specific filename — embedding that
  // literal here would itself be the #264 anti-pattern this scanner
  // exists to prevent.
  if (/\.code-workspace$/.test(base)) return true;

  // gitignored operator-local companions (committed *.example.md ARE in scope).
  //
  // Issue #352 fix: `*.local.json` exclusion is loom-source-only — at loom
  // these files are gitignored (never committed). At a destination scan
  // (--root pointing at a USE template or BUILD repo), a committed
  // `*.local.json` IS the disclosure event the scanner exists to catch:
  // the file shipped past the never-sync exclusion (parity gap with
  // `/sync`'s LOOM_LOCAL_PATTERNS). Scan it when REPO_ROOT_ACTIVE differs
  // from REPO_ROOT (destination mode).
  //
  // `*.operator.local.md` carries the #352 parity, now keyed on git-TRACKING
  // status rather than the source/destination PROXY. The prior guard
  // (`REPO_ROOT_ACTIVE === REPO_ROOT`) skipped EVERY operator-local file at
  // loom-source unconditionally — so a TRACKED (committed) `*.operator.local.md`
  // at loom-source evaded the scrub even though a committed file is
  // public-distributable (it ships to every consumer that pulls the template).
  // Skip ONLY the gitignored per-operator companion — a file git confirms is
  // UNTRACKED; a TRACKED operator-local file MUST still be scanned. TRACKED WINS
  // over the name pattern (fail-closed via isGitTracked: git-unavailable /
  // not-a-work-tree ⇒ treated as tracked ⇒ scanned). This SUBSUMES the old flip
  // in both directions: at loom-source the real companion is gitignored →
  // untracked → skipped (zero-findings-on-main preserved); a committed
  // operator-local (loom-source OR a consumer destination) → tracked → scanned
  // (the fix). The `*.local.json` rule directly below now uses the SAME signal.
  if (
    /\.operator\.local\.md$/.test(base) &&
    !isGitTracked(REPO_ROOT_ACTIVE, relPath)
  )
    return true;
  // `*.local.json` — same TRACKED-WINS signal as the operator-local rule above. It was the
  // root-identity PROXY (`REPO_ROOT_ACTIVE === REPO_ROOT`), which skipped EVERY
  // `*.local.json` in any IN-PLACE scan — including a COMMITTED one at a consumer, which
  // ships to that consumer's own clones. MEASURED: a tracked `.claude/bin/repo-links.local.json`
  // carrying a real `/Users/<operator>/` path read rc=0 in place, while Gate 2 from loom
  // (a different root, so the proxy was false) read rc=1 on the same bytes. The in-place
  // scan is the one `/codify` Step 7c(4) and `/migrate` run. At loom-source the real
  // companions are gitignored → untracked → still skipped; git unavailable / not a work
  // tree / inconclusive ⇒ treated as tracked ⇒ SCANNED (fail-closed).
  if (/\.local\.json$/.test(base) && !isGitTracked(REPO_ROOT_ACTIVE, relPath)) return true;
  // Generic `*.local.md` stays UNCONDITIONALLY excluded — but must NOT swallow
  // `*.operator.local.md` (a superset-suffix match), or the destination-mode
  // #352 flip above would be masked (a committed operator-local file would
  // still be skipped at a destination scan). The negative lookbehind scopes
  // this catch-all to plain `*.local.md`, leaving `*.operator.local.md` to the
  // destination-conditional rule above.
  if (/(?<!\.operator)\.local\.md$/.test(base)) return true;

  // loom's OWN unit tests (`*.test.mjs`, `node:test` suites under bin/ etc.)
  // are build-internal — the SAME "consumers do not run loom's tests" class
  // as `test-harness/**` (isNeverSynced) and now never-synced per
  // sync-manifest.yaml `exclude: **/*.test.mjs`. Their fixtures LEGITIMATELY
  // embed synthetic disclosure shapes to exercise the scrubber (e.g.
  // sync-from-canon.test.mjs plants a synthetic `/Users/jdoe/...`
  // operator-home-path), exactly like the audit-fixtures exclusion above.
  // SOURCE-ONLY (mirrors the `*.local.json` / `ecosystem.json` flip): at
  // loom-source the synthetic fixtures are by-design and self-excluded so the
  // Gate-2 `--check` preflight stays clean; at a DESTINATION scan
  // (`--root <consumer>`) a `*.test.mjs` that shipped past the never-sync
  // exclude IS the disclosure event the loom_only fence forbids, so it is
  // SCANNED there and flagged until the `use_obsoleted` purge removes it.
  if (/\.test\.mjs$/.test(base) && REPO_ROOT_ACTIVE === REPO_ROOT) return true;

  // `scripts/publish-to-public.mjs` — the loom-only public-fork projector. `scripts` is an
  // INCLUDE root, so widening the walk to it reaches this file; but the file itself is
  // FENCED from publication (measured: `isPublished("scripts/publish-to-public.mjs")` is
  // false, against controls returning true for `.claude/rules/git.md` and false for
  // `.claude/agents/management/…`), so nothing in it is ever distributed.
  //
  // It carries 8 customer-identity-token hits and that is BY DESIGN: it holds the
  // `EXTRA_IDENTITY_TOKENS` / `STATIC_SCRUB` tables — the literal tokens the projector
  // scrubs OUT. `community-membership.mjs`'s own header records that these deliberately stay
  // in this loom-only module because relocating them to a synced file would ship the literal
  // tokens, which is the leak the tables exist to prevent. Flagging the scrubber for
  // containing the strings it scrubs would make the only fix "delete the scrubber".
  //
  // SOURCE-ONLY, matching the `*.test.mjs` flip directly above: at a DESTINATION scan this
  // file's presence IS the disclosure event (it should never have shipped), so it is scanned
  // and flagged there.
  if (relPath === "scripts/publish-to-public.mjs" && REPO_ROOT_ACTIVE === REPO_ROOT) return true;

  // never-synced per manifest exclude: — out of the synced-forest scope
  //
  // SURFACE-GATED, and this ONE guard is the whole fix. Under `--surface projection` the
  // predicate is DELIBERATELY not consulted: the projection has already applied its own
  // subtractive fence, so every file PRESENT in it is in scope, and inheriting the sync list
  // here is exactly what made the gate blind to `test-harness/**` while those files shipped.
  // The sync surface keeps the predicate, unchanged.
  if (SCAN_SURFACE !== "projection" && isNeverSynced(relPath, base, segs)) return true;

  return false;
}

function isProbablyBinary(buf) {
  // NUL byte in the first 8KB → treat as binary, skip.
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// Symlinked DIRECTORIES the walk did NOT descend, with the reason. Module-level
// because `walk` runs inside `collectFiles`, which completes before the `stats`
// object the per-file receipt uses is constructed. Surfaced by
// `undescendedReceipt()` next to UNREAD, for the same reason UNREAD exists: a
// class the instrument did not examine is NAMED, never silently absorbed
// (`instrument-discipline.md` MUST-3(a), `conservation-gate.md` MUST-3).
const undescendedLinks = [];
// Every symlink to a DIRECTORY (descended or not). Its NAME and its TARGET STRING ship with
// the tree whatever the walk decides about the subtree, so both are scanned separately.
const directoryLinks = [];
// Directories the walk could NOT read: named like UNREAD, never silently skipped.
const unreadDirs = [];

function walk(dir, acc, visited = new Set()) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // An unreadable directory was never examined; it is named in the UNREAD receipt rather
    // than dropped without a trace (measured: silently skipped before).
    unreadDirs.push(dir);
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(REPO_ROOT_ACTIVE, full);
    if (isExcluded(rel)) continue;
    if (e.isDirectory()) {
      walk(full, acc, visited);
    } else if (e.isSymbolicLink()) {
      // `readdirSync(…, { withFileTypes: true })` types entries by LSTAT, so a
      // symlink POINTING AT A DIRECTORY reports `isDirectory() === false` and
      // `isSymbolicLink() === true` — it lands HERE, never in the branch above.
      // Before this branch it fell through to the file push, `scanFile`'s
      // `readFileSync` followed it to a directory and threw EISDIR, and the
      // ENTIRE SUBTREE behind it was never collected — while the receipt named
      // it as ONE unreadable FILE, understating the unexamined set by however
      // many files the directory held.
      //
      // MEASURED two-pole on a synthetic root before this fix: the same token
      // planted in a plain file and behind a symlinked directory produced a
      // finding for the plain file ONLY, with `UNREAD: 1 collected file(s)`
      // standing in for the whole unwalked tree. A destination whose
      // `.claude/codex-mcp-guard` is a symlink exhibits exactly this; canon,
      // where that path is a REAL directory, structurally cannot — so canon's
      // clean self-scan was never evidence about the destinations' blind spot.
      let st;
      try {
        st = fs.statSync(full); // follows the link
      } catch {
        // Dangling or unresolvable: keep the pre-existing behaviour — collect it
        // so `scanFile` records it under UNREAD.
        acc.push(full);
        continue;
      }
      if (!st.isDirectory()) {
        acc.push(full);
        continue;
      }
      directoryLinks.push(full);
      // A symlinked DIRECTORY is descended ONLY when it stays inside the scan
      // root, with BOTH candidate and root resolved through the SAME resolver
      // (`security.md` § Path Containment). Fail closed: anything that will not
      // resolve, resolves outside, or would revisit an already-walked target is
      // NAMED rather than silently skipped.
      let target;
      let rootReal;
      try {
        target = fs.realpathSync(full);
        rootReal = fs.realpathSync(REPO_ROOT_ACTIVE);
      } catch {
        undescendedLinks.push({ rel, why: "does not resolve" });
        continue;
      }
      if (target !== rootReal && !target.startsWith(rootReal + path.sep)) {
        undescendedLinks.push({ rel, why: "resolves OUTSIDE the scan root" });
        continue;
      }
      if (visited.has(target)) {
        undescendedLinks.push({ rel, why: "symlink cycle — target already walked" });
        continue;
      }
      visited.add(target);
      walk(full, acc, visited);
    } else {
      // A regular file — and ALSO a FIFO, socket or device, which used to be dropped here
      // without a trace (measured: a FIFO under `.claude/rules/` left no line in the receipt).
      // `scanFile` opens it without blocking and names every non-regular kind under UNREAD.
      acc.push(full);
    }
  }
}

// ────────────────────────────────────────────────────────────────
// GITIGNORED PAYLOAD IS NOT ON THE SYNCED SURFACE
// ────────────────────────────────────────────────────────────────
//
// This scanner walks the FILESYSTEM (`walk`/`readdirSync`), so it equates
// PRESENT ON DISK with ON THE SYNCED SURFACE. Those are different sets, and the
// repo's two notions of "clean" disagree by construction: every git-keyed
// cleanliness predicate in the tree UNDER-sees gitignored payload (measured: 22
// `git status` call sites across `.claude/bin`, `.claude/hooks` and `scripts/ci`,
// and NOT ONE passes `--ignored`), while this walk OVER-sees it.
//
// The gap is not hypothetical. MEASURED on this tree: 492 generated files under a
// gitignored path are reported as NOTHING by `git status --porcelain
// --untracked-files=all`, and a shape-matching file among them still moved this
// scanner 119 -> 120 findings and was NAMED in the refusal. The result is a gate
// refusing on a file that cannot reach any consumer — it is not in the index, not
// in any commit, and not in any push — which sends the reader bisecting commits
// for a cause that is not in the history at all. That bisect is the cost this
// exists to stop; it has already been paid once.
//
// The 2026-08-03 cross-repo-authz receipt skip above already made exactly this
// argument ("nothing untracked ships to any consumer") and deliberately scoped
// itself to one filename class, on a stated concern that was precisely right: a
// universal UNTRACKED-skip would let an untracked-but-STAGED disclosure evade the
// scrub.
//
// IGNORED-AND-UNTRACKED is the predicate that carries that argument WITHOUT the
// hole, which is why this generalizes where a bare untracked-skip could not:
//   - a STAGED path is TRACKED, so it stays SCANNED;
//   - an untracked path that is NOT ignored stays SCANNED;
//   - only a path git itself reports as ignored AND absent from the index is
//     dropped.
//
// SOURCE-ONLY, and that fence is load-bearing rather than cautious. It matches the
// `*.test.mjs` / `publish-to-public.mjs` / `*.local.json` flips already in this
// file, and it is what keeps `cross-repo-authz.test.mjs::SCAN-4` true: at a
// DESTINATION (`--root <consumer>`) an ignored, untracked file is a leak that has
// ALREADY ARRIVED, and whether the consumer's own `.gitignore` happens to name it
// says nothing about whether loom leaked it. The question differs by root — "can
// this ship OUT of here?" at source, "did something get IN here?" at a destination —
// so only the source half may skip.
//
// WHY THE SOURCE HALF IS SAFE, stated as narrowly as the code supports rather than
// as "it cannot ship by construction" (MEASURED, and that broader claim is WITHDRAWN
// as false): the distribution engines are either ignore-aware and fail-closed
// (`sync-tier-aware.mjs::walkClaudeDir` returns `filterSourceIgnored(...)`, loom#710,
// which THROWS rather than emit unfiltered when the detector cannot run) or read git
// objects rather than the working tree (`edition-emit.mjs` and
// `scripts/publish-to-public.mjs` both build from `git archive HEAD`). The
// derived-tree emitters (`emit.mjs`, `emit-cli-artifacts.mjs`, `emit-coc.mjs`) do
// walk the filesystem with NO ignore test — but their output lands in the Gate-2
// scratch worktree, where such a file is untracked and NOT ignored by the TARGET's
// rules, so this very predicate keeps it SCANNED by the delivered-side
// `assertDisclosureClean`. The backstop is that scan, not this skip.
// MEASURED, not assumed: `git check-ignore` already consults the index — a
// force-added tracked file matching an ignore pattern exits 1 (NOT reported) — so
// the staged case is closed twice over. The `ls-files` leg below is kept as
// defense-in-depth against that behaviour differing across git versions.
//
// BATCHED, not per-file: two `git` invocations for the whole candidate set rather
// than one per file. Measured here at ~7.7k files under `.claude/` against a 3.8s
// scan, so a per-file probe would add thousands of subprocesses to a 4-second job.
//
// Fail-CLOSED, matching `isGitTracked`: ANY inconclusive outcome — git missing,
// not a work tree, or a status that is not the documented "nothing matched" —
// drops NOTHING and scans everything. A scanner that silently stopped looking
// because git hiccuped is the failure mode this whole file exists to prevent.
function dropIgnoredUntracked(rootDir, absFiles) {
  if (absFiles.length === 0) return absFiles;
  if (rootDir !== REPO_ROOT) return absFiles; // DESTINATION scan → scan everything
  if (!isInsideWorkTree(rootDir)) return absFiles; // no git → scan everything

  // loom#1471 envelope: resolved binary + scrubbed env, never an ambient `git`.
  const gitBin = _gse.resolveGitBinary();
  if (!gitBin) return absFiles; // git that cannot answer → fail CLOSED
  const env = _gse.gitEnv();
  const rels = absFiles.map((f) => path.relative(rootDir, f).split(path.sep).join("/"));

  // ONE command computes the whole predicate: `--others` is untracked, `--ignored`
  // narrows it to the ignored ones. So the drop set is IGNORED-AND-UNTRACKED as GIT
  // itself computes it. Sibling of `fork-conference-pack.mjs::gitIgnoredUnder`.
  //
  // `--exclude-per-directory=.gitignore` DELIBERATELY, not `--exclude-standard`.
  // What may shrink a security scan must be COMMITTED AND REVIEWABLE. The standard
  // set also honours `$GIT_DIR/info/exclude` — per-clone, never committed, covered
  // by no test, and writable by any process running as the operator, including an
  // agent — so a single unreviewed line there would silently narrow this gate with
  // nothing in the tree to show for it. MEASURED: under `--exclude-standard` a file
  // named only in `.git/info/exclude` enters the drop set and goes unscanned; under
  // this flag it does not. The global `core.excludesFile` sibling is already closed
  // by `gitEnv()` (GIT_CONFIG_GLOBAL=/dev/null), so closing this one makes the two
  // halves agree instead of leaving a reviewer to wonder why only one was fenced.
  //
  // The cost is over-scanning a file ignored ONLY by those surfaces: a false
  // positive, never a miss, which is the direction this gate owes.
  //
  // TRACKED WINS is enforced BY GIT here rather than by set arithmetic: `--others`
  // excludes anything in the index, so a tracked path — including a force-added one
  // that matches an ignore pattern, and any STAGED path — can never enter this set
  // and is always scanned. That is what keeps the staged-evasion hole closed.
  //
  // WHY ONE COMMAND AND NOT TWO. An earlier revision intersected `check-ignore`
  // output with `ls-files` output. Those two sets come from DIFFERENT string
  // sources — `check-ignore` echoes back the caller's own path, `ls-files` emits the
  // INDEX's form — so a path whose byte form differs between the filesystem and the
  // index (macOS `core.precomposeunicode` stores NFC while `readdir` can yield NFD)
  // would miss the tracked lookup, be read as untracked, and get SKIPPED though it
  // is tracked and ships: a FAIL-OPEN in a disclosure gate. With one source the same
  // mismatch merely leaves the candidate absent from the drop set, so it is SCANNED
  // — the mismatch now fails CLOSED, which is the direction a security gate owes.
  let dropSet;
  try {
    const res = spawnSync(
      gitBin,
      ["-C", rootDir, "ls-files", "-z", "--others", "--ignored", "--exclude-per-directory=.gitignore"],
      { maxBuffer: 256 * 1024 * 1024, env },
    );
    if (res.error || res.status !== 0) return absFiles; // inconclusive → fail CLOSED
    dropSet = new Set(String(res.stdout).split("\0").filter(Boolean));
  } catch {
    return absFiles;
  }
  if (dropSet.size === 0) return absFiles;

  return absFiles.filter((_, i) => !dropSet.has(rels[i]));
}

function collectFiles(root) {
  REPO_ROOT_ACTIVE = path.resolve(root);
  // Reset per scan: this module is importable and `collectFiles` may run more
  // than once in a process, and a carried-over entry would attribute one root's
  // undescended link to another root's receipt.
  undescendedLinks.length = 0;
  directoryLinks.length = 0;
  unreadDirs.length = 0;
  const files = [];
  // A TOP-LEVEL root may itself be a symlink (a destination's `.codex-mcp-guard`, measured
  // shape). It gets the same treatment as a link met inside the walk: its name and target
  // string are scanned, and it is descended only when it resolves inside the scan root.
  const walkTop = (p) => {
    let lst;
    // A declared root can be nested (.agents/skills). Check each component before
    // descending: lstat of the leaf alone follows an ancestor link invisibly.
    let current = REPO_ROOT_ACTIVE;
    for (const part of path.relative(REPO_ROOT_ACTIVE, p).split(path.sep)) {
      current = path.join(current, part);
      try {
        lst = fs.lstatSync(current);
      } catch (e) {
        if (e.code !== "ENOENT") unreadDirs.push(current);
        return;
      }
      if (!lst.isSymbolicLink()) continue;
      // A declared leaf linking to a non-directory ships as its target string.
      // scanFile reads that string without following it; ancestor links still
      // need the containment check before the nested root can be reached.
      let targetStat = null;
      try { targetStat = fs.statSync(current); } catch {
        /* dangling links are reported below as unresolvable */
      }
      if (current === p && targetStat && !targetStat.isDirectory()) {
        files.push(p);
        return;
      }
      directoryLinks.push(current);
      const rel = path.relative(REPO_ROOT_ACTIVE, current);
      let target;
      let rootReal;
      try {
        target = fs.realpathSync(current);
        rootReal = fs.realpathSync(REPO_ROOT_ACTIVE);
      } catch {
        undescendedLinks.push({ rel, why: "does not resolve" });
        return;
      }
      if (target !== rootReal && !target.startsWith(rootReal + path.sep)) {
        undescendedLinks.push({ rel, why: "resolves OUTSIDE the scan root" });
        return;
      }
    }
    // A top-level synced DIRECTORY name that is a regular file is scanned as a file, never
    // reported as an unreadable directory (measured: its readable content went unscanned).
    if (lst.isFile()) {
      files.push(p);
      return;
    }
    walk(p, files);
  };
  const claudeDir = path.join(REPO_ROOT_ACTIVE, ".claude");
  walkTop(claudeDir);
  // Top-level distributed DIRECTORIES (see TOP_LEVEL_SYNCED_DIRS for the derivation).
  // `walk` applies the same per-file exclusions the `.claude/` walk gets, so a never-synced
  // path under one of these roots is skipped by exactly the rules that skip it under
  // `.claude/` — one exclusion mechanism, not a second one that could drift.
  for (const top of TOP_LEVEL_SYNCED_DIRS) {
    const p = path.join(REPO_ROOT_ACTIVE, top);
    if (!isExcluded(top)) walkTop(p);
  }
  for (const top of TOP_LEVEL_SYNCED) {
    const p = path.join(REPO_ROOT_ACTIVE, top);
    // Presence by lstat: a DANGLING top-level link was dropped silently by existsSync; it is
    // collected so its target string is scanned and it is named UNREAD.
    if (isPresentPath(p) && !isExcluded(top)) files.push(p);
  }
  // Applied HERE, after the lexical exclusions and once for the whole candidate
  // set, rather than inside `isExcluded`: `isExcluded` is a pure path predicate
  // called per directory entry during the walk, and making it shell out to git
  // would put a subprocess behind every one of ~7.7k entries. See the function's
  // header for why ignored-AND-untracked is the predicate and why it fails closed.
  return dropIgnoredUntracked(REPO_ROOT_ACTIVE, files);
}

// ────────────────────────────────────────────────────────────────
// POSITIVE ALLOWLIST
// ────────────────────────────────────────────────────────────────
//
// A line/span is suppressed when an allowlist token COVERS the matched
// shape span. Tokens are matched case-insensitively where the issue
// spec says "where sensible". Every entry traces to the issue #263
// allowlist clause OR carries an ALLOWLIST-NOTE documenting why it was
// added to keep the current main tree at zero findings WITHOUT
// swallowing a real secret token.
//
const ALLOWLIST = [
  // Foundation-public identifiers
  /terrene-foundation(\/[A-Za-z0-9._-]+)?/i,
  /terrene\.foundation/i,
  /terrene\.dev/i,
  // ALLOWLIST-NOTE (W6b-i 2026-06-17): `terrenefoundation` (NO hyphen) is the
  // canon Docker Hub REGISTRY org — the Docker-namespace form of the Foundation
  // GitHub org `terrene-foundation` above (Docker Hub org slugs disallow the
  // hyphen). It is the SAME Foundation-public identity, not a client/3rd-party
  // org. It appears in the py dev-container emit TEST as the substituted-registry
  // assertion (`terrenefoundation/kailash-coc-py`) — the real registry org lives
  // only in the loom-only `ecosystem.json` and is substituted into the synthetic
  // `{{REGISTRY_*}}` placeholders at emit time (it never ships as a literal in the
  // synced template SOURCE). The trailing `(?![\w-])` non-word/non-hyphen boundary
  // anchors to the EXACT own Docker org (word-boundary anchoring):
  // a typosquat `terrenefoundation-evil/loom` no longer matches the
  // allowlist and is still flagged by the nonfoundation-org-slug shape.
  /terrenefoundation(?![\w-])(\/[A-Za-z0-9._-]+)?/i,
  // (2026-10-03 walk-widening finding d: an earlier revision of this change added
  // `/Users/jdoe/` and `/Users/op/` HERE, as GLOBAL span allowlist entries. REVERTED
  // before landing: the
  // `audit-fixture-runner-convention-reaches-synthetic-home-exemption` fixture caught
  // it — a global username entry blanketed a synthetic home written into an ORDINARY
  // shipped file too, which is exactly the per-convention, flag-gated design the
  // SYNTHETIC_FIXTURE_USERS tolerance below exists to keep. Synthetic users are
  // tolerated by CONVENTION (audit-fixtures trees unconditionally; `*.test.*` suites
  // under the opt-in flag; `tests/**` suites via the arm added below), never by a
  // username-global allowlist entry.)
  // RETIRED 2026-09-25 — the three OWN-COORDINATE entries that stood here (the canon
  // GitHub host org, and the maintainer's `/Users/<user>/` + `/home/<user>/` dev-home
  // prefixes), each written as a LITERAL. They were admitted under the co-owner Option-1
  // ruling of 2026-05-17 (#263), which adjudicated them as SELF-coordinates rather than
  // third-party disclosure, and the residual note that stood beside them already named the
  // cost under `artifact-flow.md` § Canon Neutrality: this file ships `copy/always_include`
  // to every consumer, so the entries both DISCLOSED the authoring ecosystem's identity at
  // every consumer and silently EXEMPTED an org that is not the consumer's. That note booked
  // its revisit trigger as "the residual sweep completing" — this is that sweep.
  //
  // WHAT IT COST, MEASURED. A leak sweep run in a repo that RECEIVES these files found the
  // canon operator's username, home path, host org and `codify/<operator>-…` branch names in
  // loom-delivered artifacts. Every one of them had passed the Gate-2 fence, because the
  // allowlist covered the org and the home path, and NO shape knew the bare operator
  // identity at all. On the source tree at the time of the fix: 134 SHIPPED files, 316 lines,
  // `0 findings`.
  //
  // WHAT REPLACES THEM. Nothing on this list. Own identity is no longer a static exemption
  // but a RUNTIME-DERIVED FINDING: `loadOperatorIdentityShape` builds the
  // `operator-identity-token` shape from the scanned repo's own roster (person ids, display
  // ids, logins, PGP UID names/emails, key fingerprints, the genesis repo owner) through the
  // SAME `identity-scrub.mjs::deriveDynamicTokens` the publish fence and `/clean-instantiate`
  // already use — so the three fences cannot disagree about what canon identity IS, and no
  // literal of it is written here. With the literals gone, a canon org slug is caught by
  // `nonfoundation-org-slug` and a canon home by `operator-home-path` exactly as a foreign
  // one is: the scanner no longer knows whose repo it is standing in, which is the
  // canon-neutral posture. The one file that once legitimately CARRIED identity in order to
  // scrub it (`strip-build-internal.mjs`) no longer contains any literal — its patterns
  // derive at runtime — so there is no file-scoped or per-shape tolerance anywhere; see the
  // note at the identity-shape definitions.
  // ALLOWLIST-NOTE (2026-09-07, burndown projected-class lane): the Homebrew-on-Linux
  // service-account home `/home/linuxbrew/` (its install prefix is
  // `/home/linuxbrew/.linuxbrew/`). `linuxbrew` is not a person — it is the fixed
  // account name Homebrew creates on Linux, and the path is a published constant of
  // that project, identical on every host. It reaches this tree only inside the frozen
  // binary-search constant lists the burndown query tools use to locate an interpreter
  // and `gh` (`MEMBERSHIP_PATH_DIRS`, `GH_SEARCH_DIRS`) and the fixture pinning them,
  // alongside `/opt/homebrew/bin` and `/usr/local/bin`, which this shape does not match
  // because they are not under `/home/`. Structurally `/home/linuxbrew/` is
  // indistinguishable from `/home/<username>/`, which is why it needs an ENTRY rather
  // than a shape change: the shape is CORRECT to fire on `/home/<x>/` in general, and
  // narrowing it would blind the fence to real operator homes.
  //
  // SCOPE, stated as what it actually allows: this suppresses the `linuxbrew` USERNAME
  // segment only. `allowlistCovers` tests the matched SPAN, and this shape's span is
  // `/home/<user>/` — so the entry is written to that span and cannot be anchored to the
  // longer `.linuxbrew` install path without failing to cover anything at all (measured:
  // the two-segment form left all three findings standing). It is NOT a relaxation of
  // `/home/*`: a real operator's home carries a different username, fails this prefix,
  // and is still flagged. Everything under `/home/linuxbrew/` is by construction the
  // Homebrew install, not a human's home directory.
  //
  // MEASURED, four mutation cases, each mutating the constant list in
  // burndown-query-issues.mjs, running `--check`, and restoring byte-identically. All
  // four RED at exit 1 with the finding naming the mutated file and line, which is also
  // the proof the mutated bytes were read:
  //   `/home/someoperator/`    — a different operator entirely
  //   `/home/linuxbrewer/`     — a LONGER username starting with the allowed one
  //   `/home/linuxbrew-alice/` — the allowed name with a hyphenated suffix
  // The middle two are the point: the trailing slash is load-bearing, so this entry
  // covers the username `linuxbrew` and NOT the prefix family beginning with it. An
  // entry that silently covered `linuxbrew*` would be a hole, and it does not.
  // The fourth case pins that suppression is SPAN-level, not line-level: with BOTH
  // `/home/linuxbrew/.linuxbrew/bin` and `/home/realoperator/bin` on ONE line, the
  // scanner still reds and redacts ONLY the real operator home, leaving the allowed
  // literal visible in the finding context. This entry therefore cannot mask a genuine
  // leak that happens to share its line.
  /^(?:[A-Za-z]:)?\/home\/linuxbrew\/?$/,
  // R2 detection-completeness FIX (#263): each SDK-repo-name allowlist
  // entry carries a `(?<![\w-]\/)` negative-lookbehind so it covers a
  // BARE SDK reference (`pip install kailash-py`, "the kailash-rs repo",
  // `kailash-dataflow` node) but NOT an `<org>/kailash-*` org-slug span
  // (`globex/kailash-py`, `github.com/acme/kailash-rs`). The prior
  // unanchored entries swallowed `globex/kailash-py`, silently
  // suppressing must-fix #1's `<org>/kailash-*` detection. Foundation
  // `<org>/kailash-*` spans are covered by the anchored
  // terrene-foundation entries above (and excluded by the org-slug
  // shape's own internal-name negative-lookahead), so this narrowing
  // only un-suppresses genuine NON-own org references.
  /(?<![\w-]\/)kailash-rs\b/i,
  /(?<![\w-]\/)kailash-py\b/i,
  /(?<![\w-]\/)kailash-prism\b/i,
  /(?<![\w-]\/)kailash-coc-[a-z0-9-]+/i,
  /(?<![\w-]\/)kailash[a-z-]*\b/i, // kailash, kailash-dataflow, kailash-nexus, …
  // R2 detection-completeness FIX (#263): the prior `/#\d+\b/` covered
  // ANY `#<digits>` span — including the issue-ref ORG-SLUG form
  // `acme-corp/loom#21`, silently suppressing must-fix #1's issue-ref
  // detection. The negative-lookbehind `(?<![\w/-])` restricts this
  // allowlist to a BARE public ref (`#252`, `PR #553`, `see #149`):
  // a `#N` immediately preceded by a word char, `/`, or `-` is an
  // org-slug-attached issue-ref (`loom#21`), NOT a bare public ref, and
  // is left for the nonfoundation-org-slug shape to flag.
  /(?<![\w/-])#\d+\b/, // bare public SDK / PR / issue refs only
  /BP-\d+\b/, // bug-pattern refs
  // framework + standard names
  /\b(DataFlow|Nexus|Kaizen|PACT|ML|Align|MCP|EATP|CARE|CO|COC|CC)\b/,
  // ALLOWLIST-NOTE (GAP B, 2026-08-10): the product-name entry that sat here was
  // annotated "public PACT product" and that annotation was FALSE — co-owner
  // correction 2026-07-26: the named product is NOT public; the public one is the
  // PACT *reference platform*. Because a positive-allowlist entry suppresses the
  // token on EVERY scanned surface in EVERY repo shipping this scanner, the false
  // annotation made the fence structurally blind to it — a disclosure hole, not a
  // cosmetic error. Entry REMOVED rather than re-pointed: naming the reference
  // platform here would require a name this change cannot verify, and inventing
  // one to fill the slot is exactly the fabrication that produced the original
  // defect. The frameworks entry above still covers the bare `PACT` token, so the
  // legitimate framework reference is unaffected.
  // Paired fixture: `clean-foundation-placeholder/.claude/rules/clean.md` line 9
  // carried the same false assertion and is corrected in this change.
  //
  // CORRECTED 2026-08-16 — the sentence that stood here claimed "Removal fails
  // SAFE — the token now flags and a human adjudicates, rather than passing
  // silently." That was FALSE AS WRITTEN and is withdrawn. Removing a positive
  // allowlist entry only UN-SUPPRESSES a token; it does not make anything MATCH
  // it. Measured three-pole on one tree with the tenant denylist present at the
  // probe root: an existing denylist token flagged (exit 1), a benign control
  // word did not (exit 0), and this token ALSO did not (exit 0) — i.e. between
  // 2026-08-10 and 2026-08-16 the fence was not blind-by-allowlist any more, it
  // was simply silent, which reads identically from the outside and is why the
  // GAP-C sites survived every scan. A removal is only fail-safe once some shape
  // actually matches the token, so the missing half — GAP B step (3), adding it
  // to `.claude/disclosure-tenant-denylist.json` — landed in the same change as
  // this correction.
  //
  // VERIFIABLE, NOT ASSERTED (2026-08-16). The claim above is not left as prose.
  // Reproduce it in any loom-class checkout — each pole names the result that
  // would falsify it, and the tree is left unmodified:
  //
  //   f=.claude/guides/rule-extracts/repo-scope-discipline.md   # any scanned file
  //   cp "$f" /tmp/f.bak
  //   node .claude/bin/scan-synced-disclosure.mjs --check       # BASELINE: exit 0
  //   # pole (a) EFFICACY — an existing denylist token must FLAG.
  //   #   falsified by exit 0: the scan cannot see a token it is given.
  //   # pole (b) NO-FALSE-POSITIVE — an arbitrary English word must NOT flag.
  //   #   falsified by exit 1: a flag then carries no information.
  //   # pole (c) THE REGRESSION — the token this note is about must FLAG.
  //   #   falsified by exit 0: the fix is inert and this note is wrong again.
  //   for t in <a-denylist-token> marmalade <this-token>; do
  //     cp /tmp/f.bak "$f"; printf '\nPROBE: the %s system.\n' "$t" >> "$f"
  //     node .claude/bin/scan-synced-disclosure.mjs --check; echo "$t -> $?"
  //   done; cp /tmp/f.bak "$f"
  //
  // ATTRIBUTION CONTROL, so the pole-(c) flag is not read as coming from
  // something else: restore ONLY the denylist to its pre-fix revision and replant
  // the SAME token — it returns to exit 0. Measured 2026-08-16: (a) exit 1,
  // (b) exit 0, (c) exit 1, control exit 0, against a 0-finding baseline over
  // 3186 scanned files, so the exit code discriminates here rather than riding a
  // non-zero floor.
  //
  // LOCKED IN CI, so this cannot silently rot back: the bipolar fixture case
  // `gapc-guide-security-history` in `audit-fixtures/scan-synced-disclosure/`
  // pins the class with a SYNTHETIC token, and both poles were shown to RED —
  // removing the token from the violation pole FAILS the case, and planting it
  // in the compliant pole FAILS the count-lock.
  //
  // The lesson worth keeping: an allowlist REMOVAL and a detector ADDITION are
  // two separate changes, and only the second one makes a scan mean anything.
  // ALLOWLIST-NOTE (R3 #263): `your-registry` is the documentation
  // placeholder container-registry host in the rs deployment-patterns
  // skill (`image: your-registry/kailash-service:latest`) — the
  // well-known "your-X" teaching placeholder, NOT an operator registry.
  // Same ratified-placeholder class as `example-*` / `<org>`. A real
  // private registry host carries an operator/cloud slug, not the
  // literal `your-registry`, and is still flagged.
  /\byour-registry\b/i,
  // ALLOWLIST-NOTE (R3 #263): `kailash-sdk` is the Foundation-public
  // Go-module org in the canonical `go get github.com/kailash-sdk/
  // kailash-go` install line (the published Go bindings module path,
  // Foundation-owned, documented in the rs core-sdk + ffi skills). It
  // is the Go-ecosystem analogue of the `terrene-foundation/<repo>`
  // GitHub form — Foundation-public, not a 3rd-party/operator org.
  // R4 SECURITY-FIX (#263): the R3 entry's stem was LEFT-UNANCHORED
  // (only `\b`) — a genuine 3rd-party disclosure
  // `github.com/acme-corp/kailash-sdk` (or bare `acme-corp/kailash-sdk`)
  // produces the org-slug span `acme-corp/kailash-sdk`; the inner
  // `\bkailash-sdk` token matched the WHOLE span via allowlistCovers(),
  // SUPPRESSING the `acme-corp` org leak (false clean). Same failure
  // class as R2 must-fix #2, reintroduced by the R3 `kailash-sdk`
  // broadener. The R2-hardened SDK-repo-name siblings above (L311–315)
  // use a bare `(?<![\w-]\/)<token>\b` form because those tokens are
  // ONLY ever REPOS (`<org>/kailash-rs`), never orgs — that pure
  // sibling-mirror form, applied here, correctly flags
  // `<org>/kailash-sdk` BUT also newly-FLAGS the legit Foundation
  // Go-module install line `github.com/kailash-sdk/kailash-go`
  // (verified: the bare-lookbehind fails on `github.com/`'s `m/`
  // exactly as it fails on `acme-corp/`). `kailash-sdk` is structurally
  // distinct from its siblings — it is BOTH a legit Foundation Go ORG
  // (`github.com/kailash-sdk/kailash-go`, FIRST segment) AND a possible
  // 3rd-party REPO name (`acme-corp/kailash-sdk`, LAST segment). The
  // discriminator is POSITION, not a bare boundary, so this entry is
  // position-aware (two alternatives):
  //  (A) `github\.com[:/]kailash-sdk\/<repo>` — kailash-sdk as the
  //      Foundation Go ORG: github host immediately before, repo
  //      segment immediately after. Covers `https://github.com/
  //      kailash-sdk/kailash-go` AND `git@github.com:kailash-sdk/
  //      kailash-go.git`. A 3rd-party span never has `github.com[:/]`
  //      immediately before `kailash-sdk` (its org slug sits there).
  //  (B) `(?<![\w-]\/)\bkailash-sdk\b(?!\/)` — a BARE token (prose
  //      "the kailash-sdk repo", `pip`-style mentions) NOT preceded by
  //      an `<org>/` slug and NOT followed by `/` (defense-in-depth:
  //      this shape produces no bare-token span, but other shapes /
  //      future callers may). A `<3rd-party-org>/kailash-sdk` span
  //      (`acme-corp/kailash-sdk`) is preceded by `[\w-]/` so (B)
  //      fails, and lacks `github.com[:/]…/<repo>` so (A) fails →
  //      NOT allowlisted → flagged by the nonfoundation-org-slug
  //      shape. Foundation `terrene-foundation/kailash-sdk` stays
  //      covered by the anchored Foundation entry above, independent
  //      of this entry.
  /github\.com[:/]kailash-sdk\/[A-Za-z0-9._-]+|(?<![\w-]\/)\bkailash-sdk\b(?!\/)/i,
  // ALLOWLIST-NOTE (Gate-1 2026-06-11, human-adjudicated): `include/kailash`
  // is the SDK's own C-ABI header path (kailash-capi emits include/kailash.h);
  // the nonfoundation-org-slug shape reads the `<dir>/<file>` form as an
  // org/repo slug in the kailash-rs build-speed.md prose. The SDK's own
  // header path is not an operator/3rd-party token; allowlist the exact
  // path span only (NOT bare `kailash`, which other anchored entries govern).
  /\binclude\/kailash\b/i,
  // ratified generic placeholder vocabulary (issue #263)
  /example-[a-z0-9-]*/i,
  /<runner-host(-\d+)?>/,
  /<org>/,
  /<repo>/,
  /<runner-label-arm>/,
  /<runner-service-label>/,
  /<runner-name>/,
  /<name>/,
  /\bapp-[a-z]\b/,
  /\bcli-app\b/,
  /\bconsumer\b/,
  /\bdownstream\b/,
  /\bfinancial-scenario\b/,
  /example-workspace\/[A-Za-z0-9._-]+/i,
  /partner organization/i,
  // ALLOWLIST-NOTE (G1, 2026-09-27): placeholder Azure DevOps ORG names, anchored to the WHOLE
  // org (`^…$`), so the entry can vouch for an org-slug span only through `allowlistCoversOrg`
  // (which matches the org whole) and never covers a hostname / runner-label / service-label span
  // that merely CONTAINS the word. `contoso` is Microsoft's documented fictitious company, the
  // org every Azure DevOps doc example uses (the ADO analogue of `example.com`); `my-org` and
  // `upstream-org` are generic placeholders. MEASURED: when the ADO arms landed they were the
  // ONLY orgs they flagged on the synced tree — 14 lines, all synthetic remotes in the ADO
  // upflow adapter (`hooks/lib/upflow-self-repo.js`) and its fixture runner
  // (`audit-fixtures/upflow-open-never-complete/run.mjs`). DECLARED BOUND: an org literally
  // named one of these reads clean.
  // ALLOWLIST-NOTE (batch 2, 2026-09-30): four more placeholder ORG names, admitted to THIS
  // entry rather than as a `-org` SUFFIX rule — and the rejected alternative is the reason.
  // MEASURED over the whole client-template projection: the bare/URL org arms produce 70 spans
  // whose org ends in `-org`, and they are FOUR distinct names — `example-org` (58, already
  // covered by the `example-[a-z0-9-]*` entry above), `client-org` (9), `test-org` (2),
  // `synthcanon-org` (1) — plus `private-org` (1, reached through the URL arm). Every hit was
  // READ: all are synthetic remotes in loom's OWN detector fixtures (`clean-instantiate`,
  // `ecosystem-config`, `sync-gate2-worktree`), naming an org that cannot exist.
  // A `/^[a-z][a-z0-9-]*-org$/` SUFFIX rule was the tempting fix and is REJECTED: it would
  // silently pass a REAL third-party org whose name happens to end in `-org`, which is a
  // false NEGATIVE on the one thing this shape exists to catch — a cost this entry does not
  // pay, because the enumeration above is CLOSED (four names, all read). If a fifth appears
  // the gate flags it, which is the correct direction to be wrong in.
  /^(?:contoso|my-org|upstream-org|client-org|test-org|synthcanon-org|private-org)$/i,
  // ALLOWLIST-NOTE: generic `<...>` angle-bracket placeholders (any
  // lowercase-hyphen teaching token) are Foundation-ratified redaction
  // vocabulary and appear throughout the #255/#260-genericized rules
  // (e.g. <runner-host>, <org>/<repo>). Treated as covering so the
  // hostname/org/path shapes do not re-flag the very redaction tokens
  // the forest closure standardized on. This NEVER covers a literal
  // capitalized hostname or a literal org slug — those have no angle
  // brackets and are matched by the shapes below.
  /<[a-z][a-z0-9-]*(?:-\d+)?>/,
  // ALLOWLIST-NOTE: `example.com` is the rules/documentation.md-mandated
  // public placeholder domain ("use example.com" — internal domains
  // BLOCKED). Allowlisted so example.com never trips the home/path or
  // org shapes. Not a secret — it is the prescribed non-secret.
  /\bexample\.com\b/i,
  // ALLOWLIST-NOTE: `Mac` / `macOS` / `Mac OS` as a bare platform word
  // (NOT a `Name-Mac…` operator-hostname compound) is generic OS
  // vocabulary in CC/Codex guides. The hostname shape requires a
  // capitalized-or-lowercase operator-name stem immediately before
  // `-Mac`; this token covers the bare-platform usage so "macOS" / "on Mac"
  // prose does not false-positive. Real operator hostnames (stem+`-Mac`)
  // are NOT covered — they have the stem the shape requires.
  /\bmac\s?os\b/i,
  /\bmacOS\b/,
  // ALLOWLIST-NOTE: bsdtar's documented `--no-mac-metadata` flag (strip macOS
  // resource-fork metadata from archive headers) yields the SPAN `no-mac`
  // under the lowercase hostname arm. `no` is not an operator-name stem;
  // the entry is anchored to that exact span, so `foo-mac` still flags, and
  // the `bsdtar-flag-not-hostname` fixture proves a real hostname stem beside
  // the flag still flags (that fixture exercises the CAPITALIZED arm; the
  // lowercase arm is what `foo-mac` illustrates here). The stem is SYNTHETIC
  // by the same convention the hostname examples below use; an earlier
  // revision used a real operator GIVEN NAME as the stem — the exact
  // `operator-hostname` class this shape hunts, in the one file the shape
  // can never fire on.
  /^no-mac$/,
  // ALLOWLIST-NOTE: generic documentation-placeholder home paths. These
  // are NOT operator identifiers — they are the well-known generic
  // usernames used in public tooling docs:
  //   /Users/runner/  — GitHub Actions' own hosted-runner home (literal,
  //                      appears verbatim in actions/setup-* docs; the
  //                      ci-runner-troubleshooting guide cites it to
  //                      explain why setup-python breaks on self-hosted)
  //   /home/me/, /Users/me/ — the canonical "me" placeholder in CC/Codex
  //                      MCP-config teaching examples (server.js args)
  // None correlate to the operator; all are public-doc vocabulary. Real
  // operator homes (`/Users/<operator>/`) are NOT covered — they carry
  // the operator's actual lowercase username, not `runner`/`me`.
  // ANCHORED to the whole span (2026-09-27): home spans now END at the name when no separator
  // follows (`HOME=/home/dev`), and a span may carry a traversal chain (`/home/dev/../<name>`)
  // that an unanchored substring entry would vouch for. Each entry here and below names ONE
  // home, whole, with or without its trailing separator.
  /^(?:[A-Za-z]:)?\/Users\/runner\/?$/,
  /^(?:[A-Za-z]:)?\/(?:Users|home)\/me\/?$/,
  // The same vocabulary in a WINDOWS home span (G2): `runneradmin` is the account GitHub's
  // hosted Windows runners run as (`C:\Users\runneradmin\`, the Windows analogue of
  // `/Users/runner/`), plus the `runner` / `me` forms above. Anchored to the whole span, any
  // separator form (`\`, `\\`, `/`). A real Windows username fails it and is still flagged.
  /^(?:[A-Za-z]:)?(?:\\{1,2}|\/)users(?:\\{1,2}|\/)(?:runneradmin|runner|me)(?:\\{1,2}|\/)?$/i,
  // A ONE-character username (`C:\\Users\\x\\`, `/home/x/`) — the two-character floor the
  // scanner's own arms always had, kept now that the root and name class come from the lib
  // (which takes one character). MEASURED: shipped files cite `C:\\Users\\x\\` as a teaching
  // example (the memory-cascade fixture, `hooks/lib/state-io.js`). A traversal chain
  // (`x\\..\\<name>`) is longer than one character and is not covered. DECLARED BOUND: a real
  // one-character username is not seen.
  /^(?:[A-Za-z]:)?(?:\\{1,2}|\/)(?:users|home)(?:\\{1,2}|\/)[A-Za-z0-9_](?:\\{1,2}|\/)?$/i,
  // ALLOWLIST-NOTE (W6b-i 2026-06-17): `/home/dev/` is the CONTAINER-INTERNAL
  // devcontainer user home, NOT a host operator home. The py dev-container
  // Dockerfile creates it with `useradd ... dev` + `USER dev` and the
  // devcontainer.json sets `remoteUser: "dev"`; every consumer's container gets
  // the identical fixed `dev` user. The mount/volume targets
  // (`target=/home/dev/.cache/uv`, `- uv-cache:/home/dev/.cache/uv`) are
  // in-container destination paths, carrying zero operator/tenant identity —
  // exact precedent class as `/Users/runner/` (GitHub hosted-runner home) and
  // `/home/me/` (CC teaching placeholder) above. Anchored to the EXACT
  // fixed container username `dev`: a real operator home (`/home/<operator>/`)
  // carries the operator's actual username, fails this anchored prefix, and is
  // still flagged by the operator-home-path shape.
  /^(?:[A-Za-z]:)?\/home\/dev\/?$/,
  // ALLOWLIST-NOTE (F404 Shard 3 2026-07-15): `/home/vscode/` is the
  // CONTAINER-INTERNAL devcontainer user home for the rs variant, NOT a host
  // operator home — the exact same class as `/home/dev/` above (py). The rs
  // dev-container builds `FROM mcr.microsoft.com/devcontainers/base` which
  // ships the fixed non-root `vscode` user (uid/gid 1000); rs's Dockerfile
  // sets `ARG REMOTE_USER=vscode` + `USER ${REMOTE_USER}` and its
  // devcontainer.json sets `remoteUser: "vscode"`, so every consumer's rs
  // container gets the identical fixed `vscode` user. The mount targets in
  // `rs/compose.override.yml.example` (`${HOME}/.claude:/home/vscode/.claude`,
  // the GPG side-mount prose) are in-container DESTINATION paths carrying zero
  // operator/tenant identity — the host SOURCE side already uses the
  // compose-aware `${HOME}` variable (never a literal operator home). Anchored
  // to the EXACT fixed container username `vscode`: a real operator home
  // (`/home/<operator>/`) carries the operator's actual username, fails this
  // anchored prefix, and is still flagged by the operator-home-path shape.
  /^(?:[A-Za-z]:)?\/home\/vscode\/?$/,
  // ALLOWLIST-NOTE: a `/Users/<PascalCase>/` span (e.g. `/Users/Items/`
  // from the `mockData/Users/Items/Records/Response*` glob comment in
  // validate-workflow.js) is a fake-data FIELD-NAME path, not a home
  // path. macOS account usernames are lowercase by convention; a
  // Capital-then-lowercase segment immediately under /Users/ is the
  // structural tell of a fake-data path token, never an operator home.
  // Real operator homes (`/Users/<lowercase-operator>/`) are NOT
  // covered — they fail the leading-uppercase requirement.
  // The trailing `/` is OPTIONAL since 2026-09-27: home spans now also end at the name
  // (`/Users/Shared` before a backtick — macOS's shared system directory, cited in a fixture).
  // The premise above is about the CASE of the segment, not about what follows it, so the entry
  // covers both forms. A Windows span carries its drive letter and never matches this anchor.
  /^\/Users\/[A-Z][a-z]+\/?$/,
  // ALLOWLIST-NOTE: `com.github.actions.runner.<name>` is the LITERAL,
  // public launchd service label that GitHub's self-hosted runner
  // installer creates (documented in GitHub's own runner docs). The org
  // segment is the well-known public `github`, not an operator stem; the
  // distinguishing `<name>` suffix is already a ratified placeholder.
  // The operator-service-label shape exists to catch a *private* stem
  // (`com.<operator-slug>.runner…`); `github` is public by definition.
  // A real operator label (`com.<private-slug>.runner`) is NOT covered.
  /com\.github\.actions\.runner\b/,
  // ALLOWLIST-NOTE: Foundation-public SDK "enterprise-tier" documentation
  // compounds. The org-slug shape's `*-enterprise` first alternative
  // matches the public Kailash/Nexus/DataFlow/EATP doc-feature names
  // (`nexus-enterprise[-features]`, `dataflow-enterprise[-migrations]`,
  // `eatp-trust-plane-enterprise`, `kailash-enterprise…`). "enterprise"
  // here is the SDK's own enterprise-grade FEATURE tier (auth, RBAC,
  // OIDC, K8s) — public Foundation product vocabulary documented in the
  // synced skill files, NOT a client/operator GitHub org slug. A real
  // non-Foundation org (`acme-enterprise`) has no SDK prefix and is
  // still flagged. R2 SECURITY-FIX (#263): the doc-suffix is a CLOSED
  // SET (`features`, `migrations`, `tier`, `grade`, `support`,
  // `edition`, `plan`, `sso`, `rbac`, `oidc`) and the entry is anchored
  // with a trailing `(?![\w-])`. The prior `(?:-[a-z]+)?` open suffix
  // matched ANY trailing word — so `nexus-enterprise-evil/loom` (a
  // typosquat) was SUPPRESSED. With the closed set + anchor,
  // `nexus-enterprise` and `dataflow-enterprise-migrations` stay clean
  // while `nexus-enterprise-evil` no longer matches the allowlist and
  // is flagged by the nonfoundation-org-slug shape. Span:
  // `<sdk>-enterprise[-<closed-doc-suffix>]`.
  /\b(?:nexus|dataflow|kaizen|kailash|eatp|eatp-trust-plane|trust-plane|align|pact|ml|mcp)-enterprise(?:-(?:features|migrations|tier|grade|support|edition|plan|sso|rbac|oidc))?(?![\w-])/i,
  // ── ALLOWLIST-NOTE (batch 2, 2026-09-30): THE RESERVED SYNTHETIC VOCABULARY, BY VALUE ────
  // WHY BY VALUE AND NOT BY PATH. Widening the projection gate to every file present surfaced
  // 448 findings, overwhelmingly SYNTHETIC BY CONSTRUCTION: RFC 2606 names, RFC 5737 addresses,
  // and the `acme-*` family this corpus standardised on long ago. The tempting fix is "exempt
  // test files" — and it is the wrong one, MEASURED: two of tonight's REAL leaks sat INSIDE
  // files that rule would have swallowed (an operator hostname in the `ci-suites` `_ceiling_note`
  // fields, and one in `burndown-build.test.mjs`). A path exemption recreates the blind spot by
  // construction. These entries judge the VALUE: a reserved name passes in ANY file, and a
  // REAL-looking host, home path or org in a test file still FIRES.
  //
  // Scope, stated because each entry is a deliberate widening:
  //   - `example.com/.org/.net`, `.test`, `.invalid`, `.example`, `.localhost` — RFC 2606/6761
  //     reserved, never registrable.
  //   - `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24` — RFC 5737 documentation prefixes.
  //
  //   THE `acme-*` ENTRY THAT STOOD HERE IS REMOVED (batch 2, 2026-09-30 — same session, hours
  //   after it landed). The reason is a CONTRADICTION, not a preference. This corpus's own
  //   disclosure-detector FIXTURE CORPUS uses `acme-corp` as its canonical third-party org — 18
  //   occurrences under `.claude/audit-fixtures/scan-synced-disclosure/` — so the same string
  //   cannot also sit on a suppression list. It does not merely risk that outcome; MEASURED, the
  //   entry turned 14 detector fixtures RED (`0/1 runner(s) met their declared expectation`, 239
  //   cases executed), every one of them a `nonfoundation-org-slug` shortfall, and it broke the
  //   one fixture whose NAME states the rule the allowlist must obey
  //   (`r4-allowlist-word-inside-org-does-not-cover-it-acme-kailash-loom`). The entry's own
  //   "THE CONTROL" sentence was satisfied by the control it chose and failed by the control that
  //   COUNTS — does the detector still detect. A suppression list and a regression corpus may not
  //   use one string for opposite purposes; the fixtures are the instrument, so the entry gives.
  //   THIS IS NOT "REMOVE AND FORGET" — THE COST IS MEASURED, AND IT IS NOT ZERO. Removal restores
  //   the 14 fixtures (MEASURED: the runner goes `0/1 runner(s) met their declared expectation`,
  //   239 cases, 14 red -> `1/1`, 239p/0f/239c). It also re-exposes 17 findings on the
  //   client-template projection (34 -> 51), all `nonfoundation-org-slug`, all inside
  //   `.claude/test-harness/tests/`, and every one of them a DELIBERATELY PLANTED synthetic
  //   third-party org used to exercise a detector — five `gh api repos/acme-corp-private/loom`,
  //   nine `acme-enterprise` in `identity-scrub`, two `acme-corp/kailash-sdk`, one
  //   `acme-corp/kailash-py-fork`. So the entry's job was suppressing THE CORPUS'S OWN TEST
  //   VOCABULARY FOR "A LEAK", and a corpus cannot both plant `acme-corp` as the org that must
  //   flag and list `acme-*` as the org that must not.
  //   THE NARROWER FORM IS NOT AVAILABLE, AND THAT IS MEASURED TOO. A path-scoped admission of
  //   test/fixture trees was the obvious retreat and is REJECTED in the note above on this file's
  //   own evidence (two real leaks sat inside files it would have swallowed). There is no
  //   value-scoped rule either: the fixtures REQUIRE `acme-*` to keep flagging, so any rule wide
  //   enough to clear the 17 clears the 14 with it. What is left is a decision, not a rule — accept
  //   the 17 in the residual, or change those 17 sites' vocabulary — and it is recorded here rather
  //   than pre-empted, because pre-empting it is how this entry got here.
  // THE CONTROL: a real org slug and a real-looking hostname both still flag.
  /\bexample\.(?:com|org|net)\b/i,
  /(?:^|[^a-z0-9-])\.?(?:test|invalid|example|localhost)\b/i,
  /\b(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}\b/,
];

// A finding is suppressed only when an allowlist token covers the
// matched SPAN itself. Testing the full line is deliberately NOT done:
// a line containing both a real operator token and an unrelated
// Foundation token (`/Users/<operator>/… (kailash-rs)`) must still
// flag the operator token — line-level matching would let the
// Foundation token mask the leak. Every ALLOWLIST entry is a positive
// Foundation-public / ratified-placeholder pattern, documented inline,
// authored to match the SPAN the shapes produce.
function allowlistCovers(span) {
  for (const rx of ALLOWLIST) {
    rx.lastIndex = 0;
    if (rx.test(span)) return true;
  }
  return false;
}

// For an ORG-SLUG span the allowlist must vouch for the ORG it names, WHOLE — not for some
// word inside it. The entries are unanchored, so `\bconsumer\b` covered `consumer-labs/loom`,
// `\bdownstream\b` covered `downstream-io/kailash-rs`, and a repo-name entry (`kailash[a-z-]*`)
// covered an org merely STARTING with `kailash` (measured: third-party org spans read clean at
// every path). The org segment must be matched from its first character to its last by one
// entry. DECLARED BOUND: an org that IS wholly a ratified vocabulary entry still reads clean
// — placeholders (`app-a`…`app-z`, `consumer`, `downstream`, `example-*`, `your-*`), the
// platform word `macos`, and the SDK doc-feature compounds (`<sdk>-enterprise[-<doc-suffix>]`,
// e.g. `ml-enterprise`, `mcp-enterprise-sso`, `kailash-enterprise`). Those spellings are the
// allowlist's own vocabulary; an org literally named one of them is not distinguishable here.
const REPO_NAME_ENTRY = /^\(\?<!\[\\w-\]\\\/\)kailash/;
function allowlistCoversOrg(span) {
  const org = orgNamedBySpan(span);
  if (!org) return allowlistCovers(span);
  // Whole ORG, or the whole SPAN (an entry authored for an exact non-org span, e.g.
  // `include/kailash` — a C header path the shape reads as `<org>/kailash`).
  // REPO-name entries (`(?<![\w-]/)kailash…`, authored for the repo position) never vouch
  // for an ORG: `kailash[a-z-]*` wholly matched the typosquat org `kailash-enterprise-evil`.
  const whole = (str) =>
    ALLOWLIST.filter((rx) => !REPO_NAME_ENTRY.test(rx.source)).some((rx) => {
      const m = new RegExp(rx.source, rx.flags.replace("g", "")).exec(str);
      return m && m.index === 0 && m[0].length === str.length;
    });
  return whole(org) || whole(String(span).trim());
}

// ────────────────────────────────────────────────────────────────
// STRUCTURAL DISCLOSURE SHAPES
// ────────────────────────────────────────────────────────────────
//
// Each shape: { id, rx }. A line flags when rx matches AND the matched
// substring is not covered by the allowlist. `rx` carries the global
// flag so we can enumerate every match on a line.
//
// The URL / API arms of `nonfoundation-org-slug` (G1, 2026-09-27).
//
// FORMS. Before this, only `github.com[:/]`, `git@github.com:`, `gh api repos|orgs/` (no flags,
// no leading slash) and `--repo` were recognised. Each form below was planted with a synthetic
// org and read rc=0 `0 findings` against a `github.com/<org>/loom` control that flagged:
// `api.github.com/repos/<org>/…`, `raw.githubusercontent.com/<org>/…`, `gitlab.com/<org>/…`,
// `dev.azure.com/<org>/…`, `<org>.visualstudio.com/…`, `gh api /repos/<org>/…`,
// `gh api <flags> repos|orgs/<org>…`, and `github.com/orgs/<org>`.
//
// SCOPE, the same design as the GitHub arm it extends: a repo/project URL flags when a later
// segment names a repo-family repo (`loom`, `kailash*`, `coc*`, `atelier`) — the #252
// correlation class — because public third-party URLs (`gitlab.com/<vendor>/<tool>`) are not
// it. Org-LEVEL references (`github.com/orgs/<org>`, `gh api orgs/<org>`, a bare
// `dev.azure.com/<org>` or `<org>.visualstudio.com` as an `az devops --defaults` value) name
// the org and nothing else, so they flag unconditionally, as `gh api orgs/<org>` always has.
// MEASURED before choosing: the synced tree carries ~60 synthetic ADO URLs in adapter code and
// fixtures (`dev.azure.com/acme/core/_git/widget`, `someorg`, `my-org`, …); none names a
// repo-family repo, so the scoped arm leaves them clean where an unscoped one would not.
//
// CASE. GitHub, GitLab and ADO org names are case-insensitive, so `github.com/AcmeCorp/loom`
// read clean (the declared gap). These arms are case-blind on host, org and repo-family; the
// BARE / BRANCH / SCHEME arms stay lowercase (prose `Word/loom` is not a URL). The ONE carve-out
// is the capitalised placeholder word `Org` / `ORG` as the org — MEASURED: the previous
// `i`-on-URL/API-arms trial produced 6 findings on this tree and every one was that placeholder
// (`github.com:Org/loom`, `--repo Org/loom` in detector fixtures). Lowercase `org` is NOT
// carved out: it flagged before and still does, so the carve-out removes nothing that fired.
const ciWord = (w) => w.replace(/[a-z]/g, (c) => `[${c.toUpperCase()}${c}]`).replace(/\./g, "\\.");
const ORG_CI = String.raw`(?!(?:ORG|Org)(?![A-Za-z0-9-]))[A-Za-z][A-Za-z0-9-]{2,}`;
const REPO_FAMILY_CI =
  `(?:${ciWord("loom")}|${ciWord("kailash")}[A-Za-z0-9-]*|${ciWord("coc")}[A-Za-z0-9-]*|${ciWord("atelier")})`;
// `gh api`, any flags (a flag's value may be quoted text; shell separators end the command),
// then an optional QUOTE and an optional leading `/` on the endpoint. Shared with `orgSpanParts`.
// The quote is round-1 M4: `gh api 'repos/<org>/loom'` — the normal shell idiom — read clean.
// A shell TOKEN: any run of quoted segments ('…' / "…") and unquoted non-separator characters.
// Round-2 item 3: the old class `[^\s|;&]+` could not cross a quoted flag value holding a space
// or a shell separator (`--jq '.[] | .name'`, `-f 'body=a;b'`), so the endpoint after it read
// clean (measured, five forms). Unambiguous — the unquoted class excludes quotes and blanks —
// so a failed attempt backtracks each token at most once. The token COUNT is capped at 24: with
// no cap, every `gh ` on a line re-scanned the rest of it — MEASURED 8.8 s for a 60k line of
// repeated `gh pr ` (a cost the `-R` form already had before this change). DECLARED BOUND: an
// endpoint or `-R` preceded by more than 24 tokens in one gh command is not seen.
const GH_TOKEN = String.raw`(?:'[^'\n]*'|"[^"\n]*"|[^\s|;&'"])+`;
const GH_API_PREFIX = String.raw`gh api(?:[ \t]+(?!["']?\/?(?:repos|orgs)\/)` + GH_TOKEN + String.raw`){0,24}[ \t]+["']?\/?`;
// `gh repo <verb> [flags] <org>/<repo>` and a `-R` / `--repo` flag (space or `=`, optionally
// quoted) — the gh CLI forms that NAME a repo, made case-blind like the URL arms (round-1 M4; the
// lowercase forms were already caught by the bare arm, the mixed-case ones were not).
// `-R` only inside a gh command: as a bare flag it is also `cp -R` / `grep -R`, whose `src/loom`
// argument is a path (measured: `cp -R src/loom dist/` flagged when `-R` was accepted anywhere).
// `gh repo <verb>` skips ANY tokens — flags AND their values (`--json name`) — lazily up to the
// first `<org>/` argument; the trailing lookahead pins that stop point, so `orgSpanParts` (which
// reuses this prefix, anchored) strips exactly what the shape matched and not a shorter prefix.
const GH_ORG_ARG_AHEAD = String.raw`(?=[A-Za-z][A-Za-z0-9-]{2,}\/)`;
const GH_REPO_ARG_PREFIX =
  String.raw`gh repo [a-z-]+(?:[ \t]+` + GH_TOKEN + String.raw`){0,24}?[ \t]+["']?` + GH_ORG_ARG_AHEAD +
  String.raw`|gh [a-z-]+(?: [a-z-]+)?(?:[ \t]+` + GH_TOKEN + String.raw`){0,24}?[ \t]+-R(?:[ \t]+|=)["']?` + GH_ORG_ARG_AHEAD +
  String.raw`|(?<![\w-])--repo(?:[ \t]+|=)["']?`;
// Up to THREE intermediate path segments before the repo-family segment: ADO's `<project>/_git/`,
// and the legacy `<org>.visualstudio.com/DefaultCollection/<project>/_git/` clone (round-1 L3:
// three segments, read clean at two).
const ADO_SEGS = String.raw`\/(?:[^\/\s"'\x60<>]+\/){0,3}` + REPO_FAMILY_CI + String.raw`(?![A-Za-z0-9-])`;
// An org-level URL: the org is the last thing in it.
const ORG_URL_END = String.raw`\/?(?=[\s"'\x60)\]>,;]|$)`;
const ORG_URL_ARMS = [
  // github.com/orgs/<org> and github.com/enterprises/<slug> (round-1 F6) — before the repo arm,
  // which would read `orgs` as the org.
  `${ciWord("github.com")}\\/(?:orgs|enterprises)\\/${ORG_CI}\\b`,
  // GitLab SUBGROUPS (round-1 L4): `gitlab.com/<org>/<subgroup>[/<subgroup>…]/<repo-family>` —
  // up to three subgroups; the zero-subgroup form is the repo arm below.
  `(?:${ciWord("git@")}${ciWord("gitlab.com")}:|${ciWord("gitlab.com")}[:/])${ORG_CI}(?:\\/[A-Za-z0-9._-]+){1,3}\\/${REPO_FAMILY_CI}(?![A-Za-z0-9-])`,
  `(?:${ciWord("git@")}(?:${ciWord("github.com")}|${ciWord("gitlab.com")}):|` +
    `(?:${ciWord("api.github.com")}\\/repos\\/)|` +
    `(?:${ciWord("github.com")}|${ciWord("raw.githubusercontent.com")}|${ciWord("gitlab.com")})[:/]|` +
    `${GH_API_PREFIX}repos\\/|${GH_REPO_ARG_PREFIX})${ORG_CI}\\/${REPO_FAMILY_CI}[A-Za-z0-9._-]*(?:#\\d+)?`,
  `${GH_API_PREFIX}orgs\\/${ORG_CI}\\b`,
  // Azure DevOps: dev.azure.com/<org>, its SSH form, and the legacy <org>.visualstudio.com host.
  `(?:${ciWord("ssh.")})?${ciWord("dev.azure.com")}(?::v3)?\\/${ORG_CI}(?:${ADO_SEGS}|${ORG_URL_END})`,
  `${ciWord("vs-ssh.visualstudio.com")}(?::\\d+)?\\/(?:v3\\/)?${ORG_CI}${ADO_SEGS}`,
  `(?<![\\w.-])(?!${ciWord("vs-ssh")}\\.)${ORG_CI}\\.${ciWord("visualstudio.com")}(?::\\d+)?(?:${ADO_SEGS}|${ORG_URL_END})`,
].join("|");

// The BARE and BRANCH/SCHEME arms of `nonfoundation-org-slug`, unchanged in behaviour since 2026-09-15 (see
// that shape's commentary). Held here so the shape can be assembled from named parts.
//
// ── THE TOKEN LISTS ARE ONE DECLARATION, NOT TWO (batch 2, 2026-09-30) ────────────────────────
// The excluded-token list and the repo-family list each appeared TWICE in this arm — once for the
// BARE form and once after the BRANCH/SCHEME prefix — as byte-identical literal copies. That is a
// divergence hazard of the kind this arm has already paid for: `use` was missing from BOTH copies,
// so an admission applied to one copy would have looked complete and fixed half the shape. Both
// are now single named parts interpolated twice, so the next admission cannot land in one place
// and miss the other.
//
// ── ADMITTED: `use` (batch 2, 2026-09-30) ────────────────────────────────────────────────────
// MEASURED on the client-template projection: this shape produced 406 findings and 372 of them
// (92%) were ONE token — `use/coc-base@codex` and its siblings, all 372 in one file
// (`.claude/test-harness/in-force-baseline.json`), every one of the form `<lane>/<template>@<cli>`.
// Every hit was READ, per the convention this file already applies to the branch-prefix set below
// (`build/` scored 53, was read, and was excluded: every hit a sync-lane identifier; `merge/`,
// `ci/`, `perf/`, `hotfix/`, `revert/`, `sync/` scored zero and were excluded for want of
// evidence). The six distinct templates here are `coc-base`, `kailash-coc-py`, `kailash-coc-rs`,
// `coc-claude-base`, `kailash-coc-claude-py`, `kailash-coc-claude-rs` — the USE-TEMPLATE names
// this repo syncs to — and NOT ONE hit names a third-party org. `use` is the exact sibling of
// `build` (already excluded, for the same reason): this repo's two sync lanes are
// `/sync-to-build` and `/sync-to-use`.
//
// THE TRAILING HANDLE IS NOT THE MECHANISM, AND SAYING SO IS LOAD-BEARING. The token tally that
// first named this class counted `@gemini` / `@codex` / `@claude` — the CLI handle these addresses
// CARRY. That is not what the shape matches. MEASURED, two poles on one fixture root, the two
// strings differing in ONE token: `use/kailash-coc-py@gemini` FIRED, and `use/kailash-coc-py` with
// the handle REMOVED STILL FIRED. A fix keyed on the handle — or on a manifest-DERIVED CLI set —
// therefore leaves the second string live. The org the shape reads here is `use`, and this entry
// is what stops it being read as one. Keying on the LANE is also CLI-agnostic BY CONSTRUCTION: a
// new CLI adds an `@<newcli>` suffix and changes nothing here, which is the property a derived
// handle set would have had to be maintained to preserve. And this scanner runs against arbitrary
// `--root` trees, where `sync-manifest.yaml` may be absent — so a run-time derivation owes a
// hand-typed FALLBACK, i.e. the same enumeration one layer down.
//
// CONTROLS, fired on a fixture root carrying `.claude/` before the entry was admitted:
//   FIRES — the shape can still return the flag: `https://github.com/globex/loom` and the bare
//     `globex/loom-rs` each exited 1 `[SHAPE:nonfoundation-org-slug]` on their own line.
//   CLEAN — the admission, not the instrument, is what changed: `build/kailash-py` was already
//     clean (`build` is excluded), so this puts `use` in the SAME class rather than a new one.
// The `@<cli>`-handle control asked for alongside these is NON-DISCRIMINATING and is recorded as
// such rather than banked: handles did not fire BEFORE the fix either, so it returns the same
// verdict on both branches and carries no information about this change
// (`instrument-discipline.md` MUST-1).
//
// ── BOUNDARY: a backslash ends a token (same batch) ──────────────────────────────────────────
// The preceding-character class was `[\w./-]`: it treats `/` as a path boundary and `\` as not,
// although a backslash IS a path separator on a platform this scanner already supports
// (`operator-home-path` carries Windows arms). MEASURED consequence: a LITERAL escape sequence in
// source text glues its final letter onto the next token, and that letter defeats a WHOLE-TOKEN
// exclusion. `"aaaa\\trefs/coc/coordination"` reads as org `trefs` (`trefs` is not excluded while
// `refs` IS — the exclusion defeated by one character), and `'bin/coc\\nbin/coc-analyze'` reads as
// org `nbin`. 12 findings, every one read: all are escape-glued path fragments, none a
// third-party org. `\` joins the boundary class. A real `<org>/<repo-family>` reference preceded
// by a backslash is not a form this arm ever matched (the arms require `/`), so the tightening
// removes only glued tokens — and a fixture later corrected to a REAL tab rather than the escaped
// two-character form lands on `refs/…`, which the token list already excludes.
//
// ── KNOWN FALSE POSITIVE, DECLARED: A LOWERCASE ENGLISH WORD BEFORE A CANON-FAMILY NAME ───────
// SHAPE. A lowercase English word sitting before a canon-family repo name, where the word follows
// a path segment that CONTAINS A SPACE. The org token is `[a-z][a-z0-9-]{2,}` gated by the
// lookbehind `(?<![\w./-])`, and a SPACE SATISFIES that lookbehind — so the trailing word of
// `…some dir/<name>` reads as an org token, and the family name after the slash completes the
// match.
// MEASURED INSTANCES, four, and named by FILE rather than by literal because the literal is the
// thing that fires: `.claude/test-harness/tests/codex-native-policy.test.mjs` — a synthetic fixture
// directory, asserted three times, whose sibling assertion one line below uses a companion name
// that does NOT fire (which is what makes the diagnosis decisive rather than plausible); and
// `.claude/test-harness/tests/import-meta-url-path-anchor.test.mjs` — a recorded measurement whose
// provenance was a checkout path containing a space. Both sites are BENIGN: a fixture path and a
// measurement's provenance. Neither is an org reference and neither is an internal-name leak.
// THIS IS NOT A RESIDUAL ROW AND THERE IS NO ALLOWANCE FOR IT. The class is declared HERE, in the
// source the next reader is already standing in, because each quiet alternative is wrong for a
// reason worth writing down:
//   - NO NAME-LIST ENTRY for the offending words. They are ordinary English nouns; admitting them
//     clears those words and leaves every OTHER English noun firing, so the list would rot on its
//     first new fixture while looking like a fix.
//   - NO NARROWING, and the FIRST argument is the decisive one: requiring the family name not to
//     continue after a hyphen would refuse `<x>/<a canon-family repo name that CONTINUES past the
//     hyphen>` — and such a repo EXISTS in this family, so that narrowing is a real false NEGATIVE
//     bought to clear a fixture path. The second argument is structural: no lookbehind can separate
//     "a word after a space INSIDE a path" from "a word after a space in prose", because the
//     scanner reads one line of text, not a parsed filesystem path.
//     ⚠ THE NAME IS DELIBERATELY NOT SPELLED HERE, AND THAT IS NOT PRUDERY. An earlier revision of
//     this very paragraph quoted it to make the argument concrete — and this file ships
//     `always_include` to every consumer, so the quote was an internal workspace name from the
//     MUST-NOT-SHIP ledger riding into every edition. MEASURED: `disclosure-scan-surface-parity`'s
//     self-audit case caught it in the emitted tree, reporting the name's LENGTH ONLY (the suite is
//     careful not to reprint what it catches) — which is why the failure read `len12` and the name
//     had to be recovered by matching the ledger against this file. **Documenting a leak by
//     reproducing it is the same defect; that is now five times in one session, and every one was
//     caught by re-reading the artifact, never by the writing feeling wrong.**
//   - THE TWO DIRECTIONS ARE NOT SYMMETRIC. A false positive here costs a reviewer one line; the
//     false negative above costs a leaked reference. That asymmetry is why the pattern is left as
//     it is rather than tuned.
// The two fixture sites were nonetheless corrected AT THE SOURCE — one by CASE (the arm requires a
// lowercase first character) and one by rephrasing a measured record to state the property it
// carries (a path containing a space) instead of the literal path. NEITHER was done by weakening
// this pattern, which is the distinction that keeps them fixes rather than evasions.
const ORG_REPO_FAMILY = String.raw`(?:loom|kailash[a-z0-9-]*|coc[a-z0-9-]*|atelier)`;
// EXPORTED (batch 2, 2026-09-30) so the list has ONE canonical spelling a test can compare
// against — a single source used for EVERY `--root`, whether the root is loom, a projection or a
// consumer tree. It was already the single source; exporting it is what makes it ASSERTABLE.
// The drift this guards is specific and measured: `use` was missing from this list while `build`
// was present, and the two are SIBLINGS — this repo's sync lanes are `/sync-to-build` and
// `/sync-to-use`. A hand-typed list whose twin is present and whose other half is absent is the
// signature of an admission that was never made. `.claude/bin/org-token-drift.test.mjs` — its
// sibling in THIS directory — is the lock, and it does exactly two things: it reads this
// declaration's literal straight OUT OF THIS FILE'S SOURCE TEXT (one `readFileSync`, no import —
// importing would execute this module's top-level main block and start a scan), and it asserts the
// hand-typed pair `["build", "use"]` is present, with a control pole showing an absent lane is
// reported at all.
// ⛔ IT DOES NOT READ `sync-manifest.yaml`, AND THE TEXT THAT STOOD HERE UNTIL NOW SAID IT DID —
// naming a file that does not exist (`scan-synced-disclosure.org-token-drift.test.mjs`) and a
// mechanism the test does not use. Both halves were wrong in the same direction, which is why they
// read as plausible: the MANIFEST-DERIVED form is the obvious design, and that test's own header
// records it ATTEMPTED AND UNSOUND three times over, with a counter-example for each derivation
// rule. So the lock keys on a PAIR, not a derivation.
// THE CONSEQUENCE, STATED HERE SO THE TWO COMMENTS CANNOT CONTRADICT EACH OTHER: adding a third
// lane to the manifest moves NOTHING here — a lane is guarded only once someone adds it to
// `SIBLING_LANES`. That is a real gap and it is DECLARED rather than implied away; the pair is the
// lock, and keeping the pair current is what the next reader owes.
export const ORG_EXCLUDED_TOKENS = String.raw`(?:loom|kailash[a-z0-9-]*|coc[a-z0-9-]*|atelier|repos|agents|skills|commands|rules|bin|lib|hooks|guides|variants|specs|chore|csq|workspaces|feat|fix|docs|test|refactor|style|src|packages|pkg|pkgs|tests|crates|ext|cmd|internal|node_modules|dist|build|use|target|bindings|ffi|python|java|deployment|localhost|service|statefulset|daemonset|pod|svc|refs(?=\/))`;
// ── THE EXCLUSION BOUNDARY: THE WHOLE SEGMENT, NOT A WORD ────────────────────────────────────
// `\b` was the boundary here, and `\b` treats a HYPHEN as a boundary — so an excluded token
// exempted every token that merely STARTED with it. A third-party org whose name BEGINS with an
// excluded token and then CONTINUES past a hyphen therefore read clean at every path, which is
// the same class the `use` admission exists to stop, one character to the right of where it was
// stopped.
//
// MEASURED BEFORE THE CHANGE, and the instrument was shown to fire in the same run: on a probe
// root holding ONE deliberately-real bare org slug (the FIRING control) plus FIVE tokens that
// continue an excluded token across a hyphen, the scan returned EXACTLY ONE finding — the
// control. All five continued forms were silent. The literal tokens are NOT written here, and
// that is the rule this file states two paragraphs up rather than a style preference: this
// source SHIPS, so an org-shaped literal quoted to make the argument concrete becomes a finding
// the tightening below would raise against the scanner's own text.
//
// `(?![\w-])` requires the token to be followed by neither a word character nor a hyphen, so a
// token is exempt only when it IS the segment. `-` is not a word character, and that is the
// entire defect.
//
// THE CHANGE ONLY EVER ADDS FINDINGS, AND THAT IS WHY IT NEEDS NO FALSE-NEGATIVE BOUND.
// `(?![\w-])` IMPLIES `\b`: every excluded token ends in a word character, and `-` is exactly
// the one non-word character that satisfies `\b` while failing this lookahead. So the lookahead
// is STRICTLY STRONGER, the exclusion matches a strictly SMALLER set, and the arms match a
// strictly larger one. A tightening in this direction can only lose a suppression it should
// never have had; it cannot lose a finding. The declared false positive above — a lowercase
// English word before a canon-family name — is unaffected either way: that is a MATCH-side
// shape and this is an EXCLUSION-side tightening.
//
// `refs(?=\/)` IS UNAFFECTED, CHECKED RATHER THAN ASSUMED: its own lookahead requires `/` next,
// and `/` is not in `[\w-]`, so the two lookaheads cannot disagree.
//
// THE RESIDUAL IS ENUMERATED, NEVER SUPPRESSED. Because the tightening is monotone, every row it
// adds is by construction a token the old boundary exempted BY ACCIDENT — a third-party org
// mis-read as a canon lane — and so each added row is a real finding to disposition, not a
// regression to re-exclude.
const ORG_EXCLUSION_BOUNDARY = String.raw`(?![\w-])`;

const ORG_BARE_ARMS = new RegExp(
  String.raw`(?<![\w./\\-])(?!` +
    ORG_EXCLUDED_TOKENS +
    ORG_EXCLUSION_BOUNDARY +
    String.raw`)[a-z][a-z0-9-]{2,}\/` +
    ORG_REPO_FAMILY +
    String.raw`(?:#\d+)?\b` +
    String.raw`|(?:\b(?:chore|feat|fix|release|docs|test|refactor|style|codify|lane|wip)\/|[a-z][a-z0-9+.-]{0,31}:\/\/)(?!` +
    ORG_EXCLUDED_TOKENS +
    ORG_EXCLUSION_BOUNDARY +
    String.raw`)[a-z][a-z0-9-]{2,}\/` +
    ORG_REPO_FAMILY +
    String.raw`(?:#\d+)?\b`,
  "g",
);

const SHAPES = [
  {
    // R2 detection-completeness hardening (#263):
    //  (a) Lowercase `<op>-mini` now flags (e.g. `bar-mini`) — the prior
    //      shape only matched `[A-Z][a-z]+-Mini` (capitalized), so a
    //      lowercased operator hostname evaded. The `-mini` arm is
    //      case-insensitive on the stem and the `mini` suffix.
    //  (b) The `-Mac` arm no longer false-positives `Proc-Macro`: the
    //      prior `[A-Z][a-z]+s?-Mac[A-Za-z-]*` swallowed any `-Mac`
    //      followed by letters (`Proc-Macro` → match). It now requires a
    //      genuine Mac-PRODUCT boundary: `-Mac(Book|Studio|Pro|Mini)` OR
    //      a bare `-Mac` followed by a non-word/`.` boundary (covers
    //      `Baz-Mac.local` and bare `Foo-Mac`). `Proc-Macro` has `ro`
    //      after `-Mac` (not a product, not a boundary) → no match.
    //      Real shapes (`Foo-MacStudio`, `Bar-MacBookPro`,
    //      `Baz-Mac.local`) still match.
    //  (c) R3 completeness FIX (#263): the operator-name stem on the
    //      two `-Mac` arms was `[A-Z][a-z]+s?` — it REQUIRED ≥1
    //      lowercase letter after the leading capital, so a
    //      single-uppercase / all-caps stem (`X-MacBook-Pro`,
    //      `A-MacStudio`) evaded ALL three `-Mac` arms. The stem is now
    //      `[A-Z][A-Za-z]*s?` (leading capital, then any letters incl.
    //      zero) so a 1-char / all-caps stem still matches. The
    //      product-boundary group and the bare-`-Mac` non-word boundary
    //      are UNCHANGED, so `Proc-Macro` still does NOT match (`ro`
    //      after `-Mac` is not a product, not a boundary). The
    //      lowercase `-mac` arm and the `-[Mm]ini` arm are NOT loosened
    //      (loosening `-mini` to a single-char stem would flood
    //      `a-mini` / `x-mini` prose).
    rx: /\b[A-Z][A-Za-z]*s?-Mac(?:Book(?:Pro|Air)?|Studio|Pro|Mini)\b|\b[A-Z][A-Za-z]*s?-Mac(?=[.\s]|$|[^A-Za-z])|\b[a-z]+-mac(?=[.\s]|$|[^a-z])|\b[A-Za-z][A-Za-z0-9]*-[Mm]ini\b/g,
    id: "operator-hostname",
  },
  {
    // SHAPE-NARROWING (issue #263 sanctions narrowing when a shape
    // over-matches a legitimate token): the issue's literal second
    // alternative `[a-z][a-z0-9-]{2,}/(kailash|loom|coc)…` matched every
    // internal FILESYSTEM path (`.claude/coc-sync.md`, `agents/coc-*`,
    // `repos/loom`, `skills/03-nexus/…`) — none of which are GitHub org
    // slugs. R2 detection-completeness hardening (#263): the prior shape
    // only matched a github/gh/--repo context AND a 2nd-segment in
    // {kailash,loom,coc}; it MISSED the SSH-clone form
    // (`git@github.com:acme-corp/loom.git`), the `gh api orgs/<org>`
    // form, bare `<org>/<repo>` in prose, and the issue-ref
    // `<org>/<repo>#N` form (the last two are 2 of the original 12 real
    // disclosure forms). The shape now detects a non-own, non-Foundation
    // org in ANY of these contexts:
    //   1. `github.com[:/]<org>/…`         (HTTPS or SSH after-host)
    //   2. `git@github.com:<org>/…`        (SSH clone)
    //   3. `gh api (repos|orgs)/<org>/…`   (orgs/ form added)
    //   4. `--repo <org>/<repo>`           (gh --repo flag)
    //   5. `<org>/(loom|kailash*|coc*|atelier)(#N)?`  repo-family
    //      bare/issue-ref form — anchored to the KNOWN repo-family list
    //      (NOT literally any `a/b`, which would flood prose-path
    //      false-positives) with an optional trailing `#<digits>`.
    // No leading own-org negative-lookahead is relied on for Foundation
    // suppression — the positive ALLOWLIST (anchored, see Fix 2) is the
    // single source of Foundation suppression (own-org suppression was
    // RETIRED 2026-09-25; see the RETIRED note in ALLOWLIST) and covers the matched
    // span in every one of these forms. The `-enterprise` first
    // alternative is kept (anchored on the literal `-enterprise` suffix);
    // Foundation `<sdk>-enterprise` doc compounds are still allowlisted.
    // The bare/issue-ref alternative is deliberately anchored TWO ways
    // to avoid the "literally any a/b" flood the issue spec warns
    // against: (1) a negative-lookbehind `(?<![\w./-])` so the `<org>`
    // token is NOT a continuation of an internal FILESYSTEM path
    // (`repos/loom`, `.claude/agents/coc-sync`, `skills/coc-x/y`,
    // `loom/kailash-py` all have a `/`, `.`, `-`, or word char
    // immediately before the org token → not matched); (2) a
    // negative-lookahead excluding the known internal repo/dir names
    // (`repos`, `agents`, `skills`, `commands`, `rules`, `bin`, `lib`,
    // `hooks`, `guides`, `variants`, `specs`, plus the repo-family names
    // themselves) as the `<org>` token. What remains is a genuine
    // `<external-org>/<repo-family>` reference in prose or an `#N`
    // issue-ref — `acme-corp/loom`, `acme-corp/loom#21`,
    // `globex/kailash-py`, `initech/coc-sync`. Foundation orgs
    // (`terrene-foundation/loom`) DO match the shape here but are
    // suppressed by the anchored ALLOWLIST; the canon host org is NOT
    // (own-org suppression retired 2026-09-25) and flags like any other.
    // FOUR alternatives, each anchored so it cannot flood prose paths:
    //  (1) `<org>-enterprise`  — literal `-enterprise` suffix anchor;
    //      Foundation `<sdk>-enterprise` doc compounds are allowlisted.
    //  (2) repo-family CONTEXT form — a github/gh/git context prefix
    //      (`github.com[:/]`, `git@github.com:`, `gh api repos/`,
    //      `--repo `) followed by `<org>/<repo-family>` where
    //      <repo-family> ∈ {loom, kailash*, coc*, atelier}. Constraining
    //      the 2nd segment to the repo-family (Round-1 design, RETAINED)
    //      is what stops the flood on legitimate public SDK URLs
    //      (`github.com/openai/openai-python`,
    //      `github.com/anthropics/claude-code`) — those do not reference
    //      a Foundation repo-family repo and are NOT a #252-class
    //      correlatable disclosure. SSH (`git@github.com:`) and the
    //      `--repo` flag forms are NEW in R2.
    //  (3) `gh api orgs/<org>` — the `orgs/` API form (one of the
    //      original 12 disclosure forms, MISSED by Round-1). The org
    //      slug is the segment after `orgs/`; Foundation orgs match
    //      the shape but are suppressed by the anchored ALLOWLIST.
    //  (4) bare / issue-ref `<org>/<repo-family>(#N)?` — a
    //      negative-lookbehind `(?<![\w./-])` ensures `<org>` is NOT a
    //      continuation of an internal FILESYSTEM path (`repos/loom`,
    //      `.claude/agents/coc-sync`, `loom/kailash-py` all fail it),
    //      and a negative-lookahead excludes (a) the known internal
    //      repo/dir names, (b) the conventional-commit branch prefixes
    //      (`chore/coc-telemetry-…`, `feat/coc-x` are git BRANCH names,
    //      not org slugs), and (c) the documented sibling-repo tokens
    //      (`csq/coc-eval`, `workspaces/coc-harness-…` are loom↔csq
    //      boundary paths per rules/loom-csq-boundary.md, not external
    //      GitHub orgs). What remains is a genuine external-org
    //      reference in prose or an `#N` issue-ref. Foundation orgs
    //      match here too but are suppressed by the anchored ALLOWLIST.
    // The `-enterprise` alternative captures the FULL org token
    // INCLUDING any trailing `-<suffix>` segments (`nexus-enterprise-evil`) so the SPAN handed to allowlistCovers() is
    // the complete typosquat — the anchored ALLOWLIST then correctly
    // does NOT cover it (must-fix #2). The prior `-enterprise\b` stopped
    // at `enterprise`, handing the allowlist the clean own-org prefix
    // which it legitimately covered → silent typosquat leak.
    // R3 disclosure FIX (#263): with variants/ now in scope (Fix B),
    // the rs binding-tree paths surfaced as 4th-alt org tokens:
    // `ffi/kailash-go`, `ffi/kailash-java`, `python/kailash/...`,
    // `java/...` are INTERNAL monorepo binding-source directory paths
    // in the kailash-rs FFI tree (same class as the already-excluded
    // `src`/`packages`/`bindings` — a build-tree dir, never a GitHub
    // org slug). Added `ffi`, `python`, `java` to the 4th-alt internal
    // dir-name negative-lookahead. (`go` is 2 chars < the `{2,}` ≥3-char
    // org-token floor, so `go/kailash` never reaches the 4th-alt — no
    // entry needed.) A real external org (`acme/kailash-rs`) has none
    // of these reserved dir names and is still flagged.
    // 4th-alt negative-lookahead excludes (a) internal repo/dir names,
    // (b) conventional-commit branch prefixes, (c) sibling-repo tokens,
    // (d) universal monorepo source-tree directory names (`src`,
    // `packages`, `pkg`, `tests`, `crates`, `cmd`, `internal`,
    // `ffi`, `python`, `java` — language-binding tree dirs,
    // `node_modules`, `dist`, `build`, `target`, `bindings`) —
    // `src/kailash/…`, `packages/kailash-ml/…`,
    // `bindings/kailash-rs/…` are internal package PATHS, never GitHub
    // org slugs — AND (e) k8s/infra resource words + the `localhost`
    // literal (`deployment/kailash-app`,
    // `postgresql://user:pass@localhost/kailash` — a k8s resource
    // selector / a DB connection-string DB-name, never an org slug).
    // Without (d)+(e) the broadened bare form floods on every monorepo
    // path / k8s selector / DB URL ending in a repo-family token.
    //
    // R3 must-fix #D (#263) — bare-org-slug SMUGGLE, now CLOSED.
    // The 4th-alt anti-flood negative-lookbehind `(?<![\w./-])` rejects
    // an `<org>` token preceded by `/`, `.`, `-`, or a word char — by
    // design, so internal FS paths (`repos/loom`, `src/kailash/…`)
    // don't flood. That same lookbehind let a GENUINE 3rd-party org
    // ride a `/` after a git-branch prefix or a URL scheme:
    // `chore/acme-corp/loom`, `feat/acme-corp/kailash-rs`,
    // `release/globex/loom`, `postgres://acme-corp/loom` ALL evaded.
    // Closed by a 5th alternative that REQUIRES a closed-set context
    // prefix immediately before the org token — either a conventional
    // git-branch prefix (`chore/`,`feat/`,`fix/`,`release/`,`docs/`,
    // `test/`,`refactor/`,`style/`, plus `codify/`,`lane/`,`wip/`)
    // OR a URL scheme (`<scheme>://`) —
    // then `<org>/<repo-family>`. The org token reuses the SAME
    // internal-dir / repo-family / branch-token negative-lookahead as
    // the 4th alt, so the flood vectors stay clean: `chore/coc-
    // telemetry-auto` (branch, `coc*` is repo-family-excluded),
    // `feat/issue-263-disclosure` (`issue-263…` not a repo-family
    // 2nd seg), `src/kailash/core` (no branch/scheme prefix),
    // `postgresql://user:pass@localhost/kailash` (`localhost`
    // excluded), `https://github.com/openai/openai-python` (2nd seg
    // `openai-python` ≠ repo-family) ALL stay clean. Empirically
    // gated: `--check` on the branch tree exits 0 and every fixture
    // passes WITH this alt live (the `r3-smuggle-closed` fixture pair
    // locks the closed disposition — `smuggle.md` MUST flag, its
    // `cleanlocks.md` sibling MUST stay clean). That fixture was cited
    // here as `nonown-org-slug-smuggle` until 2026-09-15, a name no
    // directory has ever carried: the citation did not resolve, so the
    // sentence claiming the disposition was locked pointed at nothing.
    // Foundation orgs that
    // appear in a branch/scheme context match here too but are
    // suppressed by the anchored ALLOWLIST, identical to the other
    // four alternatives.
    //
    // PREFIX SET WIDENED 2026-09-15, and the prior "Disposition: CLOSED"
    // was FALSE WHEN WRITTEN for this repo's own most-used branch prefix.
    // The closed set held only the CONVENTIONAL-COMMIT type words, so a
    // third-party org riding ANY other prefix evaded. MEASURED two-pole,
    // the two strings differing in ONE token: `chore/globex/loom` exited 1
    // `[SHAPE:nonfoundation-org-slug]`, and `codify/globex/loom` exited 0
    // with `0 findings` — while `codify/` is the LEASE-BRANCH prefix this
    // corpus cites 20 times. `lane/` and `wip/` were derived the same way.
    // The set is DERIVED from citations in this corpus, not guessed: a
    // matcher over backticked `<word>/<path>` forms under `.claude/`, fired
    // first at a known-positive control. `build/` scored 53 and is
    // DELIBERATELY EXCLUDED — reading the hits rather than the tally shows
    // every one is a SYNC-LANE identifier (`build/prism`, `build/base`,
    // `build/py`), never a branch, so admitting it would widen on a
    // misread. `merge/`, `ci/`, `perf/`, `hotfix/`, `revert/` and `sync/`
    // scored ZERO citations and are excluded for want of evidence.
    // Blast radius MEASURED on the live tree: still 7485 files / 0
    // findings, so the widening reds nothing currently clean. That
    // measurement is scoped to THIS tree — a consumer's corpus is a
    // different population and was not measured; what bounds the risk
    // there is the DIRECTION of the change (it can only ADD detections of
    // a THIRD-PARTY `<org>/<repo-family>`, which is the signal this fence
    // exists to raise) and the fact that Foundation orgs stay
    // allowlist-suppressed, as the paragraph above records.
    // Disposition: CLOSED for the enumerated prefixes; a prefix outside
    // the set is a KNOWN and DECLARED residual, not a closed hole.
    //
    // HOST / API FORMS WIDENED 2026-09-27 (G1), and the URL/API arms made CASE-BLIND on the
    // org (and host and repo-family) — see ORG_URL_ARMS above SHAPES for the forms, the
    // placeholder carve-out, and the measurement.
    id: "nonfoundation-org-slug",
    rx: new RegExp(
      // LINEAR (round-1 F5, 2026-09-27). Two arms were quadratic on one long line and are now
      // BOUNDED: the `-enterprise` arm's `[a-z0-9-]*` (a `\b` start after every `-` re-scanned
      // the rest of the line — MEASURED 3.1 s for a 60k `ab-cd-…` line) is capped at 99
      // characters before `-enterprise` (a GitHub org name is at most 39), and the bare arms'
      // URL scheme `[a-z][a-z0-9+.-]*://` (unanchored, so every position of a long alphanumeric
      // run re-scanned the run — MEASURED 10.3 s for a 120k hex line, 25 s at 60k with a finding
      // per the round-1 review) is capped at 32 characters (IANA schemes are short). Both now
      // scan 60k-120k lines in ~0.3 s end to end. DECLARED BOUND: a `<org>-enterprise` token
      // with more than 99 characters before `-enterprise`, and a scheme longer than 32, are
      // not seen.
      String.raw`\b[a-z][a-z0-9-]{0,99}-enterprise(?:-[a-z0-9]+)*\b|` + ORG_URL_ARMS + "|" + ORG_BARE_ARMS.source,
      "g",
    ),
  },
  {
    // R2 detection-completeness hardening (#263): the prior arch
    // alternative was only `arm|x64`, so `initech-linux-arm64` evaded.
    // Added `arm64`, `x64`, `x86_64`, `aarch64` (order: longest-first
    // so `arm64` wins over `arm`; the `\b` after still anchors the
    // shorter `arm`/`x64` for bare `<org>-linux-arm`). The
    // `(?!example\b)` placeholder exclusion and the own-prefix
    // suppression (via the anchored allowlist) are retained.
    // R3 disclosure FIX (#263): with variants/ now in scope (Fix B),
    // the GitHub-Actions matrix JOB name `build-wheels-linux-x86_64`
    // surfaced — the stem matched is `wheels` (after the `build-`
    // word boundary). `wheels` / `build` are generic CI matrix-job
    // vocabulary, NOT an operator org slug; a self-hosted runner LABEL
    // (the #252 class this shape catches) is `<org>-linux-<arch>`,
    // never `build-wheels-linux-<arch>` (a `runs-on:` job name). Added
    // `wheels` and `build` to the placeholder negative-lookahead. A
    // real org runner label (`acme-linux-arm64`) has no `wheels`/`build`
    // stem and is still flagged.
    id: "org-derived-runner-label",
    rx: /\b(?!(?:example|wheels|build)\b)[a-z][a-z0-9]+-linux-(?:x86_64|aarch64|arm64|x64|arm)\b/g,
  },
  {
    id: "operator-home-path",
    // WINDOWS HOMES (G2, 2026-09-27): `C:\Users\<name>\`, its JSON-escaped `C:\\Users\\<name>\\`
    // and a lower-case `c:\users\…` all read clean (the `/Users/` arm needs forward slashes), and
    // `C:/Users/<Name>/` was flagged only as its `/Users/<Name>/` substring — which the POSIX
    // PascalCase allowlist entry then covered, so a capitalised Windows username read clean.
    // The Windows arm comes FIRST so its span carries the drive letter: the POSIX-anchored
    // PascalCase entry (`^\/Users\/…`) cannot cover it, which is right, because Windows
    // usernames are conventionally capitalised and that entry's premise (lower-case macOS
    // accounts) does not hold there. A username may contain spaces (`Alice Smith`). Same
    // `<…>` / `...` placeholder exclusions and two-character floor as the POSIX arms.
    //
    // ONE DEFINITION WITH THE PUBLISH GATE (2026-09-27, round-1 M3/F1/F7). The home ROOT, the
    // USERNAME class and the excluded names are now `identity-scrub.mjs::makeHomepathRe` itself,
    // imported, so the scanner and the scrub/publish gate cannot disagree about what a home path
    // is. What the scanner's own arm missed and the lib catches (measured, each rc=0 before):
    // a home with NO trailing separator (`"C:\\Users\\<name>"` ending a JSON value,
    // `USERPROFILE=C:\Users\<name>`, `/Users/<name>` at end of line); a UNC share
    // (`\\<server>\c$\Users\<name>\`); an 8.3 short name (`<NAME>~1`); non-ASCII and apostrophe
    // names; and traversal past an excluded name (`C:\Users\runneradmin\..\<name>\`).
    // Two scanner-side wrappers, both for the ALLOWLIST: an optional DRIVE prefix, so the span of
    // `C:/Users/<Name>/` carries the drive and the POSIX-anchored PascalCase entry still cannot
    // cover a capitalised Windows name; and an optional trailing separator, so the span-keyed
    // entries (`/home/dev/`, `/Users/<Word>/`) keep matching the spans they were written for.
    // A `<letter>:` before the root is ALWAYS taken into the span (round-2 item 4, 2026-09-28).
    // It used to be taken only when not preceded by a letter/digit/`_`, which then let the
    // POSIX-anchored PascalCase entry vouch for the remainder: `x_C:/Users/<Name>/` and
    // `vol1D:/Users/<Name>/` read clean while `dir:C:/Users/<Name>/` flagged (measured). The
    // lookbehind existed for ONE real false positive — the `e:` of a compose volume mount
    // `uv-cache:/home/dev/…` defeating the span-anchored container-home entries — which is closed
    // on the ALLOWLIST side instead: those entries accept an optional `<letter>:` prefix, so a
    // container home stays clean whatever precedes it, and a drive-shaped prefix never lets the
    // PascalCase entry (which does NOT accept one) cover a capitalised name.
    rx: new RegExp(String.raw`(?:[A-Za-z]:)?(?:` + makeHomepathRe().source + String.raw`)(?:\/|\\{1,2})?`, "gu"),
    // CONTEXT MASK ONLY — detection is unchanged. A spaced Windows profile name is taken whole only
    // when a terminator follows it, so `C:\Users\<First> <Last>, then` matched `<First>` and the
    // context printed the surname in clear (round-2, measured: `«REDACTED» <Last>, then`,
    // `PATH=«REDACTED» <Last>;C:\…`, `«REDACTED» de la <Name> <Nam…`). When a home span ends at
    // the name (no trailing separator), the mask runs on over up to FOUR following blank-separated
    // name-like words. It errs wide: prose after an unterminated home may be masked too.
    // Since the lib's 528ee01f7 the match span itself carries a spaced WINDOWS name whole, so
    // this extension now discriminates only where the lib's rule stops — the POSIX arm, which
    // never takes a space (`/Users/<first> <last> …`; pinned by the posix-following-words case).
    // Kept independent of the lib's exact name rule on purpose.
    maskExtend: /(?:[ \t]+[\p{L}\p{M}\p{N}_.~'’-]+){1,4}/uy,
  },
  {
    // MACOS PER-USER TEMP TREE (2026-10-03, security-review residual, ALWAYS-ESCALATE
    // class). The `os.tmpdir()` root on Darwin is
    // `/var/folders/<2-char>/<per-user-hash>/T`, and the `<per-user-hash>` — a ~30-char
    // base-36 token with underscores — is a STABLE per-user identifier, the same identity
    // class the `operator-home-path` shape exists to catch, one directory over. NO publish
    // gate de-names it: the scrubber's SUBSTITUTE mode rewrites HOME ROOTS only
    // (`identity-scrub.mjs::makeHomepathRe`; read, and it carries no temp-tree rule), so a
    // recorded command output carrying the REAL hash ships intact through every fence —
    // which is how these reached synced files. Hence a scanner shape: the hash is the
    // token that must not ship. (An earlier revision of this comment claimed the gates
    // "de-name the /var/folders PREFIX" — FALSE, and corrected per review finding e; the
    // prefix it de-named in the measured case was a HOME root.)
    // The token in the hash arm's character class is FOR THE FORM ONLY — never write a
    // real value here, or in any comment, fixture, or commit body about this shape.
    // REVIEW HARDENING (2026-10-03, findings a+b): the 2-char class was
    // `[A-Za-z0-9]{2}`, which MISSES `_`, `+` and `-` — measured by synthetic run:
    // `/var/folders/_z/<hash>` and `/var/folders/z_/<hash>` EVADED. Both segments now
    // carry `[A-Za-z0-9_+-]` (the hash segment already had `_-`; `+` joins). The prefix
    // is CASE-INSENSITIVE — `/VAR/FOLDERS/…` (the spelling `path-containment.mjs`
    // itself records) evaded a case-sensitive prefix. Implemented as the `i` flag on
    // the whole pattern, which is EXACTLY the prefix case-insensitive and nothing else:
    // every character class here already spans both cases, and `/private` wants the
    // same treatment.
    // WHAT STAYS CLEAN, each measured on this tree: the placeholder form
    // `/var/folders/<two-char>/.../` (an angle bracket and an ellipsis are not in the
    // classes), bare `/var/folders` prose and code mentions (no hash segment follows),
    // and dotted `/var/folders/...` citations across `run-harness-suites.mjs` /
    // `path-containment.mjs` / `worktree-reap.test.mjs` et al. A real hash needs ≥12
    // chars in the third segment — measured: an earlier sweep's `[A-Za-z0-9]`-only
    // class silently missed a real hash whose underscores are load-bearing. The
    // resolved `/private/var/folders/…` realpath form is included so a resolved echo
    // flags identically.
    id: "operator-temp-path",
    rx: /(?:\/private)?\/var\/folders\/[A-Za-z0-9_+-]{2}\/[A-Za-z0-9_+-]{12,}/gi,
  },
  {
    id: "operator-service-label",
    rx: /\bcom\.(?!example\b)[a-z0-9]+\.(?:runner|actions)[a-z0-9.-]*\b/g,
  },
  {
    // F77 (#386): synced settings.json `permissions.allow` / `permissions.deny`
    // matcher entries of the form `Edit(/<absolute-path>/...)`,
    // `Write(/<absolute-path>/...)`, `Read(/<absolute-path>/...)` (and the
    // sibling `Bash`/`MultiEdit`/`Glob`/`Grep` tool-name forms — MultiEdit
    // was removed from CC ~v2.0.8/journal/0276 but is deliberately RETAINED
    // in this scan vocabulary: stale consumer settings may still carry
    // `MultiEdit(...)` entries and a legacy entry leaks operator PII exactly
    // like a current one) carry a
    // structural defect distinct from the prose `/Users/<op>/` leak class:
    // the matcher itself encodes a runtime authorization scope keyed to an
    // absolute filesystem path, so every downstream consumer's session
    // inherits a matcher that ONLY ever fires against the maintainer's
    // own checkout layout. This shape flags the matcher form regardless
    // of which operator's path it carries — even an Option-1-allowlisted
    // `/Users/<operator>/` is wrong INSIDE a `permissions.*` matcher in a
    // synced settings.json (the matcher should be relative or
    // `$CLAUDE_PROJECT_DIR`-rooted). The shape deliberately does NOT
    // intersect the allowlist (allowlistCovers is keyed to the matched
    // SPAN, and the span here is the WHOLE matcher token; no
    // Option-1 allowlist entry covers a tool-call-matcher span).
    // Foundation-public placeholder `$CLAUDE_PROJECT_DIR` and relative
    // paths do not match the shape's leading `(/` anchor — they stay
    // clean.
    // WINDOWS HOMES too (2026-09-27): `Edit(C:\\Users\\<name>\\…)` (JSON-escaped, as it sits in
    // settings.json), `C:\Users\…` and `C:/Users/…` read clean (measured, rc=0, against rc=1 for
    // the POSIX twin). The home-path shape often catches the same span, but NOT when its allowlist
    // covers the name (`runneradmin`) — and this shape exists because the matcher is wrong
    // REGARDLESS of whose home it names.
    id: "settings-permission-absolute-path",
    rx: /"(?:Edit|Write|Read|Bash|MultiEdit|Glob|Grep|NotebookEdit)\(((?:\/(?:Users|home)\/|[A-Za-z]:(?:\\{1,2}|\/)[Uu][Ss][Ee][Rr][Ss](?:\\{1,2}|\/))[^"\)]+)\)"/g,
  },
  {
    // D6-1 (ECO-IMPL W1-S3 / redteam/01 HIGH promoted to impl). The
    // nonfoundation-org-slug shape above flags an org ONLY inside a
    // <org>/<repo-family> slug, a git/gh context, or an `-enterprise` suffix —
    // it is structurally BLIND to a BARE JSON value like `"org": "acme-corp"`
    // (no `/`, no repo-family, no git context). The D6 ecosystem registry is
    // exactly that shape: { "remote_links": { "build.py": { "org":
    // "acme-corp", "repo": "..." } } }. This FILE-SCOPED shape (ecosystem*
    // files ONLY — NOT every repo-wide JSON value, which would flood) flags a
    // bare lowercase-slug "org" / "host" value. The REAL ecosystem.json is
    // self-excluded (isExcluded) and never reaches here; ecosystem.example.json
    // IS scanned and its synthetic `example-*` / `<org>` values pass via the
    // POSITIVE allowlist (allowlistCovers applies to this shape) — it is the
    // positive fixture proving the shape catches a real bare slug. A bare host
    // WITH a dot ("docker.io") does not match (the closing quote is not
    // adjacent to the [a-z0-9-] run), so public registry hosts stay clean.
    //
    // VALUE CLASS ALIGNED 2026-09-27 (G5) with `readEcosystemOwnOrgs`, which ADMITS an org as own
    // under `/^[a-z0-9-]+$/i` and folds it to lower case. This shape used to see only
    // `[a-z][a-z0-9-]{2,}`, so a leaked registry declaring `"org": "AcmeCorp"` both EXEMPTED that
    // org's receipts (the own-org lookahead is case-blind) AND was itself never flagged — measured:
    // rc=0 `0 findings`, against rc=1 for the same tree with the org spelled `acmecorp`. Every
    // value the reader can treat as own now flags here, so a registry cannot exempt what it does
    // not also disclose.
    id: "ecosystem-bare-org-slug",
    fileScope: /^ecosystem.*\.json$/,
    rx: /"(?:org|host)"\s*:\s*"[A-Za-z0-9-]+"/g,
  },
  {
    // PRIVATE-KEY MATERIAL (loom#1873-sibling; the Gate-2 literal-gate residual).
    //
    // WHY THIS SHAPE EXISTS. `scripts/publish-to-public.mjs::runIdentityTokenGate` — the
    // LITERAL identity gate — checks THREE classes: maintained identity tokens, surviving
    // operator home paths, and PRIVATE KEY MATERIAL. It is called from `edition-emit.mjs`
    // and publish-to-public's own `main` ONLY, i.e. the seeding/publish lanes. The Gate-2
    // distribution lanes fence through `sync-gate2-worktree.mjs::assertDisclosureClean` →
    // `runOutputDisclosureScan` → THIS scanner, which is a DISJOINT shape engine: of those
    // three classes it carried `operator-home-path` and nothing else. Identity tokens are
    // deliberately NOT added here (see below); private-key material is the class with no
    // ecosystem-relative ambiguity — a key is a leak on every lane, in every direction.
    //
    // MEASURED two-pole before this shape existed, with a control shown to fire on the same
    // synthetic tree (`[SHAPE:operator-home-path]`, exit 1): a PEM RSA private key planted at
    // `.claude/rules/<f>.md` exited 0 with ZERO findings, byte-indistinguishable from the
    // benign-text pole that also exited 0. A `grep -in 'private key\|BEGIN RSA\|pem'` over
    // this file returned EMPTY against a control grep that returned 8 hits. So a private key
    // staged into a `/sync-to-build` or `/sync-to-use` delivery shipped SILENTLY.
    //
    // WHY NOT import runIdentityTokenGate into the Gate-2 driver instead. MEASURED on a REAL
    // staged BUILD tree (`sync-tier-aware.mjs --build py --out <tmp>`, 2881 files copied):
    // `runIdentityTokenGate(staged, { repo: LOOM_ROOT })` returns `ok:false` on the tree AS
    // DELIVERED TODAY — 33 files on one maintained identity token, 13 on another, plus 38
    // operator-home-path files (loom's OWN disclosure-detector fixtures, whose synthetic
    // homes are preserved by design per loom#1318). Planting an extra token moved that to 34
    // files: the two poles differ by ONE file in 2883, so the instrument does not
    // discriminate on this surface (`instrument-discipline.md` MUST-1) and wiring it would
    // refuse EVERY delivery rather than gate one. That is not a defect in either gate — they
    // answer DIFFERENT questions. runIdentityTokenGate enforces CROSS-ECOSYSTEM publication
    // hygiene, where the own-org identity must not appear at all; Gate-2 distributes WITHIN
    // the ecosystem, where the own-org slug is legitimate and is deliberately allowlisted by
    // this scanner's own-org shapes (`nonfoundation-org-slug`, `ecosystem-bare-org-slug`).
    //
    // NO EXTERNAL LIST, SO NOTHING TO FAIL OPEN. The tenant-denylist class has a loom-only
    // token file and therefore a loader that can return inert — the defect loom#1873 fixes
    // one function below with a two-root union. This shape carries its authority INLINE as a
    // structural marker, so it is armed identically at loom, at a staged worktree, and at a
    // consumer running the shipped copy; there is no root to key on and no load to fail.
    // That also makes it safe to SHIP: the pattern names no operator, tenant or customer.
    //
    // MATCHES TO END OF LINE, deliberately. Scanning is line-based, so a real multi-line PEM
    // is caught on its BEGIN marker (the marker line holds no key bytes). A single-line
    // embedded key (JSON with escaped newlines) would otherwise leave up to 20 bytes of
    // base64 in `redactContext`'s trailing window; consuming the rest of the line puts every
    // trailing byte inside the redacted span. The refusal therefore names the CLASS and the
    // path and prints no key material — the same posture the tenant shape takes.
    // ONE CARVE-OUT, AND ONLY ONE: a marker followed immediately by a literal `...` is the
    // documentation-placeholder form (`private_key="-----BEGIN PRIVATE KEY-----..."`). MEASURED
    // at loom root before the carve-out: exactly 2 hits, both that form, both in synced
    // `variants/py/skills/03-nexus/` prose — so an uncarved shape would have refused fence A on
    // EVERY Gate-2 run, the same brick-wall failure the runIdentityTokenGate wiring was rejected
    // for. The carve-out cannot hide a real key: a valid PEM never has `...` adjacent to its
    // BEGIN marker, and a multi-line PEM's marker line ends right after the marker, which the
    // lookahead admits. No allowlist, no root-keyed list, no other suppression path.
    id: "private-key-material",
    rx: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----(?!\.\.\.).*/g,
  },
  {
    // JOURNAL-CITATION display_id (loom#1495 Class B — the AC#3 regrowth detector).
    //
    // WHY THIS SHAPE EXISTS. `knowledge-convergence.md` MUST-2 mandates the journal
    // filename `NNNN-<display_id>-TYPE-slug.md`, so the operator handle is part of every
    // journal filename BY DESIGN. The journal FILES do not distribute (no tier matches
    // `journal/**`); the CITATIONS do, and the tier-aware sync lane copies them VERBATIM —
    // it has no scrubber at all. A full-filename citation written into a `.claude/**`
    // artifact therefore ships canon operator identity to every consumer that pulls the
    // template. `rules/journal.md` § "Citation convention" records the disposition (cite by
    // NUMBER in a cascading artifact) and names this file as the detector's structural home.
    //
    // ZERO SECRET TOKENS, which is what lets it live in a file that itself ships
    // `copy/always_include`. It matches the FILENAME SHAPE, never a handle: `journal/NNNN-`
    // followed by a LOWERCASE segment. The lowercase test is the discriminator and it is
    // derived, not invented — `hooks/session-end.js`'s journal-filename parser spells the
    // format as `^\d+-(?:[a-z0-9_-]+-)?(DECISION|DISCOVERY|TRADE-OFF|RISK|CONNECTION|GAP|
    // AMENDMENT)-(.+)\.md$`, i.e. an OPTIONAL lowercase display_id segment followed by an
    // ALL-CAPS TYPE. So a citation whose segment-2 is all-caps is the display_id-LESS legacy
    // form (`journal/0006-DECISION-…`) and discloses nothing; one whose segment-2 is
    // lowercase IS a handle. Keying on the CASE rather than on a TYPE list is deliberate:
    // restating `DECISION|DISCOVERY|…` here would be a hand-copied enumeration that goes
    // stale the day an eighth type is added, which is the same convention-outgrows-predicate
    // defect this scanner's own `TOP_LEVEL_SYNCED_DIRS` note records.
    //
    // SYNTHETIC DISPLAY_IDS ARE EXEMPT, from the SHARED authority rather than a local list:
    // the negative-lookahead is BUILT from `SYNTHETIC_FIXTURE_USERS` (`lib/identity-scrub.mjs`),
    // the same set the `operator-home-path` synthetic gate uses. Teaching examples that
    // illustrate the FORMAT (`journal/0042-alice-DECISION-foo.md` in
    // `guides/rule-extracts/knowledge-convergence-examples.md`, `hooks/lib/journal-reserve.js`)
    // are documentation vocabulary, not identity; a REAL handle is not in that set and still
    // flags. Adding a real handle to that set to silence a finding would be the
    // widen-the-allowlist move this file's own report footer forbids.
    //
    // PATH-SCOPED AWAY FROM `audit-fixtures/**`, and this is the one thing the shape gives
    // up. Those trees are the DETECTORS' TEST INPUT: `audit-fixtures/journal-author-discipline/
    // */input.json` hands a hook a `file_path` whose display_id segment is the very thing the
    // hook parses, and `audit-fixtures/o1-citation-check/pass-*-real.txt` are VERBATIM
    // excerpts of real receipts whose `relates_to:` line cannot be edited without ceasing to
    // be verbatim. MEASURED on this tree: 31 filename-shape citations live under
    // `audit-fixtures/`, 10 of them on a real handle. Those 10 DO reach a consumer (the
    // fixture corpus ships on the `cc` tier), so this is a NAMED residual and not a clean
    // surface — scoped out because rewriting them disarms four live detectors, which is the
    // worse trade, and recorded here so the next reader finds the adjudication instead of
    // reading the shape's silence as absence. Same disposition, same reasoning, as the
    // `detectorFixtureFile` tolerance `scanFile` already carries for `operator-home-path`.
    //
    // The ALLOWLIST is NOT skipped for this shape (it is absent from the skip-list in
    // `scanFile`): the span is `journal/NNNN-<segment>-` and no Option-1 entry covers that
    // shape, so allowlist participation costs nothing and keeps the placeholder vocabulary
    // (`<org>`-style angle-bracket tokens) working uniformly.
    id: "journal-citation-display-id",
    pathScope: /^(?!(?:.*\/)?audit-fixtures\/)/,
    rx: new RegExp(
      `journal\\/\\d{4}-(?!(?:${[...SYNTHETIC_FIXTURE_USERS]
        .map(escapeForRegex)
        .join("|")})-)[a-z][a-z0-9_.]*-`,
      "g",
    ),
  },
];

// ────────────────────────────────────────────────────────────────
// CUSTOMER-IDENTITY TENANT DENYLIST (loom-only; journal/0214, loom#411)
// ────────────────────────────────────────────────────────────────
//
// The customer-identity token list lives in a LOOM-ONLY file
// (`.claude/disclosure-tenant-denylist.json` — a TOP-LEVEL .claude/ file,
// NOT under bin/**, so it sits outside every synced-tier glob and the
// `loom_only:` declaration passes the loom-only-mutual-exclusion
// validator; /sync NEVER ships it). The scanner
// reads it RELATIVE TO THE SCANNED ROOT and builds a flag-shape from it:
//   • loom Gate-2 (root = loom): real tokens load → a SYNCED artifact
//     naming a customer flags BEFORE it can ship.
//   • a consumer / a fixture without the file: the shape is INERT (the
//     token list never synced down → the customer-identity surface is
//     empty). Each repo populates its OWN tenant tokens.
//   • a fixture WITH its own synthetic denylist: synthetic tokens load,
//     proving the mechanism without committing a real token to the
//     (synced) fixture surface.
// The literal tokens are therefore NEVER embedded in this synced scanner
// file — inlining a real customer token here would re-create the very leak
// the shape prevents (a consumer greps the synced scanner source). The denylist
// file is excluded from the scan (isExcluded) so its own tokens do not
// self-flag. Only the GENERIC concept terms (`works-council` /
// `co-determination`) are safe in synced prose — they identify no
// customer and are deliberately NOT tokens.
const TENANT_DENYLIST_REL = path.join(
  ".claude",
  "disclosure-tenant-denylist.json",
);

function escapeForRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Read the token list out of ONE denylist path. Absent → `[]`. A PRESENT-but-
// unparseable file throws — a guard that silently disables itself on a typo is
// worse than no guard.
function readTenantTokens(p) {
  if (!isPresentPath(p)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readConfigText(p));
  } catch (e) {
    throw new Error(
      `disclosure-tenant-denylist.json present but unreadable or unparseable at ${displayPath(p)}: ` +
        `${parseErrorWhere(e)} (refusing to run a silently-disabled tenant guard)`,
    );
  }
  // TRIMMED on the way out, not only tested trimmed: a padded entry (`"  acme  "`, a
  // spreadsheet paste) otherwise became a `\b  acme  \b` alternative that matched only
  // text carrying the same padding, while the operator-identity shape dropped the trimmed
  // form as a tenant token — neither shape fired (measured rc=0). `identity-scrub.mjs`
  // already trims the same entries for the publish gate.
  // A readable denylist of the WRONG SHAPE (`{"tokens":"x"}`, `[]`, `{}`, a non-string entry)
  // used to read as an empty list: the customer shape went inert, rc 0, no notice (measured).
  // The shared validator refuses it, exactly as the publish gate does.
  try {
    return denylistTokensOrThrow(parsed, displayPath(p));
  } catch (e) {
    throw new Error(`${String(e.message).split(p).join(displayPath(p))}`);
  }
}

// Build the `customer-identity-token` SHAPE from the tenant denylist, or return
// null when NO reachable denylist carries tokens (the genuinely-inert consumer
// case).
//
// TOKENS ARE UNIONED ACROSS TWO ROOTS: the SCANNED root, and — when they differ —
// the root of THIS SCRIPT's own checkout. That second root is the fix for a
// silently-disarming guard.
//
// The denylist is `loom_only` BY DESIGN (its literal tokens must never reach a
// consumer), so it is ABSENT FROM EVERY TREE THIS SCANNER IS POINTED AT WITH
// `--root`: the Gate-2 staged worktree (`sync-gate2-worktree.mjs::
// assertDisclosureClean`, which fences EVERY `/sync-to-build` and `/sync-to-use`
// delivery), the edition/seed projections, and the intake trees at Gate 1. Keyed
// on the scanned root ALONE the tenant shape was therefore inert at exactly the
// moments it was supposed to fire, and its silence was byte-identical to a clean
// result. MEASURED two-pole before the fix, token located programmatically and
// never printed: the same tenant token planted in a staged tree scanned WITHOUT a
// denylist exited 0 / `0 findings`; with the denylist copied in, exit 1
// `[SHAPE:customer-identity-token]`.
//
// The fallback changes nothing for a CONSUMER running the shipped copy: there
// `REPO_ROOT` IS the consumer repo, which has no denylist, so the shape stays
// null — which is correct and unavoidable (shipping the list would BE the leak).
// It arms the guard only where the token authority actually exists: a loom-rooted
// scanner scanning a tree it is about to distribute. Union rather than
// first-wins so a fork that carries its OWN denylist keeps its tokens too.
function loadCustomerIdentityShape(rootActive) {
  const roots =
    path.resolve(rootActive) === path.resolve(REPO_ROOT)
      ? [rootActive]
      : [rootActive, REPO_ROOT];
  const tokens = [
    ...new Set(roots.flatMap((r) => readTenantTokens(path.join(r, TENANT_DENYLIST_REL)))),
  ];
  if (tokens.length === 0) return null; // inert: no reachable tenant list
  // Bounded by Unicode-aware lookarounds, not `\b`: `\b` knows only ASCII word characters,
  // so a token ending in an accented letter or punctuation (`Acmé`, `Acme Inc.`, `@acme`)
  // had no boundary to match at and never fired (measured rc=0).
  const alt = tokens.map(escapeForRegex).join("|");
  return {
    id: "customer-identity-token",
    rx: new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alt})(?![\\p{L}\\p{N}_])`, "giu"),
    // The CONTEXT mask is unbounded: a glued form is not a finding, but it is still the token.
    maskRx: new RegExp(`(?:${alt})`, "giu"),
    hasNonAsciiToken: tokens.some((t) => /[^\x00-\x7f]/.test(t)),
    // Folded twin for the FOLDED PASS (see scanFoldedLine).
    foldRx: new RegExp(
      `(?<![\\p{L}\\p{N}_])(?:${[...new Set(tokens.map(foldForGate))].map(escapeForRegex).join("|")})(?![\\p{L}\\p{N}_])`,
      "giu",
    ),
  };
}

// ────────────────────────────────────────────────────────────────
// OPERATOR-IDENTITY SHAPE (runtime-derived; replaces the retired own-coordinate allowlist)
// ────────────────────────────────────────────────────────────────
//
// THE GAP IT CLOSES. Every shape above is STRUCTURAL: it recognises a hostname, an org
// slug, a home path by their SHAPE. A bare operator identity has no shape — a username
// inside `codify/<operator>-2026-08-20`, `.session-notes.d/<operator>.md`, a Claude
// projects slug `-Users-<operator>-repos-loom`, a `display_id: "<operator>"` example — is
// an ordinary lowercase word, so NO shape could fire on it and the fence was structurally
// BLIND to the class. MEASURED at the fix: the canon operator's username sat in 100+
// SHIPPED files and the scan reported `0 findings`; a receiving repo's own sweep is what
// found them.
//
// WHY THE ROSTER, AND WHY THIS FUNCTION. The roster is the repo's own declaration of who
// operates it, and `identity-scrub.mjs::deriveDynamicTokens` is the ONE extractor the
// publish fence and `/clean-instantiate` already share for "what counts as canon
// identity" (ids, display ids, logins, ADO principals, PGP UID names/emails and their
// separator variants, key fingerprints, the genesis repo owner). Reusing it makes this the
// THIRD fence on one definition instead of a fourth definition. No literal is written
// here: the tokens exist only at runtime, read from a file that is itself never synced.
//
// ROOTS ARE UNIONED exactly as `loadCustomerIdentityShape` does and for the same reason:
// the roster is absent from every staged tree this scanner is pointed at with `--root`
// (the Gate-2 worktree, the edition projections), so keyed on the scanned root alone the
// shape would be inert at precisely the moment it must fire. At a CONSUMER running the
// shipped copy, `REPO_ROOT` is the consumer, so it gates the consumer's OWN operators
// against its own synced surface — the same property, canon-neutrally.
//
// TENANT TOKENS ARE SUBTRACTED: `deriveDynamicTokens` also returns the denylist tokens,
// which already carry their own `customer-identity-token` shape; reporting them twice
// under two ids would make one leak read as two.
//
// MATCHING — what the shape catches, and the bounds it DECLARES rather than hides.
//
//   * Tokens of 7+ characters match UNBOUNDED: a suffix or prefix GLUED to the name —
//     `<operator>2`, `<operator>Home`, `my<operator>`, `<operator>_notes` — is the
//     ordinary accident, and it still carries the name. Tokens of 3–6 characters keep
//     alphanumeric lookarounds, because a short name glued into a longer word is far
//     more often a different word (and a fence that reds on noise gets switched off).
//   * Every 40-hex token (a commit — the roster's genesis `root_commit`, the committed
//     trust root's `root_commit`, and this checkout's own `git rev-list --max-parents=0`
//     — or a key fingerprint) also matches in its SHORT forms: any prefix of 7+ hex
//     digits (how commits are cited: `a1b2c3d…`-style short SHAs), and the 16- and 8-digit
//     suffixes (how GPG key IDs are cited). Hex-delimited on both sides. FALSE-POSITIVE
//     cost measured, not assumed: a 7-hex window collides by chance at ~1/16^7 per
//     position, and on this tree the prefix forms hit only genuine citations of loom's
//     own root / genesis commits (every one genericized in the same change).
//   * A malformed ROSTER does not make the shape quietly inert. A roster that is present
//     but unparseable, not an object, carries no `persons`/`operators` collection, or
//     has ANY person entry that yields zero identity tokens (checked PER PERSON — the
//     genesis owner alone kept a whole-roster count above zero) throws, and the caller
//     exits 2 (the scan DID NOT START): measured before this rule, `{}`, `null`, `{"persons":"x"}` and a
//     wrong-key roster each exited 0 with 0 findings, byte-identical to a clean scan.
//     A roster whose only tokens are PLACEHOLDER sentinels is a deliberately-scrubbed
//     roster (the client-template edition writes one) and is accepted.
//   * NO roster reachable at any root prints one loud stderr line naming the shape
//     INERT, so its absence is never read as a pass. Exit code is unchanged: a repo with
//     no roster has no operator identity to leak, which is a true answer, but it is a
//     different answer from "checked and clean", and the line says which one this is.
//
// DECLARED BOUNDS — forms this shape does NOT see. Named here so their absence from the
// findings is never read as evidence (`conservation-gate.md` MUST-3):
//   - a 3–6 character token glued to other letters or digits (see above);
//   - letters split by spaces or punctuation (`e s p …`), URL- or percent-encoding,
//     HTML entities, base64 or any other encoding;
//   - zero-width characters inside the token, and full-width / homoglyph substitutes;
//   - a hex token cited from its MIDDLE, or a prefix SHORTER than 12 digits embedded
//     mid-run in a longer hex string (recognised: a hex-delimited prefix of 7+ digits,
//     the hex-delimited 16/8-digit key-ID suffixes, and a prefix of 12+ digits anywhere,
//     including mid-run — see HEX_MIDRUN_MIN);
//   - an identity the roster does not declare (a nickname, a former handle);
//   - a person declared twice under the SAME map key: `JSON.parse` keeps only the last, so
//     the first entry's fields are never seen (roster files are tool-written; not re-parsed);
//   - a PARTIAL fingerprint written in separated groups (the first N groups of a spaced gpg
//     fingerprint): only the whole separated identity, and contiguous prefixes, are matched.
// And, for the structural `nonfoundation-org-slug` shape: its URL / API arms (host forms, `gh
// api`, `--repo`, Azure DevOps) are CASE-BLIND since 2026-09-27, with the placeholder word
// `Org`/`ORG` carved out (see ORG_URL_ARMS). Its BARE `<org>/<repo-family>` and BRANCH/SCHEME
// arms are still CASE-SENSITIVE (`AcmeCorp/loom` in prose reads clean): with the `i` flag on
// the whole shape the self-scan went from 0 to 15 findings, the 9 beyond the URL/API arms'
// 6 being capitalised prose paths. Also still unseen: a host other than github.com /
// raw.githubusercontent.com / gitlab.com / Azure DevOps (a self-hosted GitLab or GHES host), and
// an Azure DevOps project URL none of whose first three segments is a repo-family name.
// These are deliberate or adversarial forms, not ordinary accidents; catching them needs
// normalisation this line-oriented scanner does not do.
//
// A roster that cannot be parsed, or is structurally empty, THROWS here (see
// `assertRosterUsable`); `deriveDynamicTokens` additionally throws on a malformed
// `keys` field. The caller turns either into exit 2.
// The scrubber file (`bin/lib/strip-build-internal.mjs`) is scanned like ANY other file:
// there is NO file- or token-scoped tolerance for it (removed 2026-10-04, security
// re-run). The tolerance this replaces existed because that file CARRIED the private
// org literal — rewrite patterns plus self-test inputs — so flagging it left "delete the
// scrubber" as the only fix, and the delivered scanner (whose roster and ecosystem
// registry do not travel) reddened on the delivered scrubber: measured rc=1, 10
// findings on a real `--target py` tree, halting `/codify` Step 7c and `/migrate`.
//
// That literal is GONE BY CONSTRUCTION. The rewrite patterns derive at runtime from
// `canon-identity-values.json` — itself both `loom_only` and client-template-REMOVEd,
// and never-synced as the identity declaration (see `isNeverSynced`) — and the
// self-test fixtures compose the slug from `privateOrgSlugs()` instead of embedding it.
// At every consumer the derived set is EMPTY, so the delivered file contains no literal
// for a tolerance to cover, and the delivered scanner has nothing to red on.
//
// If a private literal ever reappears in that file, flagging it is CORRECT — it is
// exactly the class the delivery gate exists to stop — so the file is now scanned with
// no suppression whatsoever, and its clean scan is evidence rather than a skip.

// Every PERSON-derived identity token (lowercased), populated by
// `loadOperatorIdentityShape`; a span equal to one of these is a person identity,
// never a mere org slug.
const PERSON_TOKENS = new Set();

// The org a matched span NAMES: strip a git/gh/URL/branch context prefix, then take the
// first path segment. `gh api repos/<org>/kailash-x` → `<org>`; `<org>/loom#21` →
// `<org>`; a bare `<org>` → itself.
//
// Every context prefix an org-slug arm can produce is stripped here (G1 added the api / raw /
// gitlab / orgs-page / flagged-`gh api` / Azure DevOps forms). An unstripped prefix names the
// HOST as the org, so the allowlist and the scrubber tolerance would judge the wrong token —
// a Foundation org behind `api.github.com/repos/` flagged, and a riding org went unexamined.
// `<org>.visualstudio.com` carries the org as its first host label, hence the `.` split.
const ORG_SPAN_PREFIX = new RegExp(
  String.raw`^(?:git@(?:github\.com|gitlab\.com):|[a-z][a-z0-9+.-]*:\/\/)?(?:` +
    String.raw`(?:github\.com|raw\.githubusercontent\.com|gitlab\.com)[:/](?:orgs\/|enterprises\/)?|api\.github\.com\/repos\/|` +
    GH_API_PREFIX +
    String.raw`(?:repos|orgs)\/|` +
    GH_REPO_ARG_PREFIX +
    String.raw`|(?:ssh\.)?dev\.azure\.com(?::v3)?\/|vs-ssh\.visualstudio\.com(?::\d+)?\/(?:v3\/)?|` +
    String.raw`--repo\s+|(?:chore|feat|fix|release|docs|test|refactor|style|codify|lane|wip)\/)?`,
  "i",
);
function orgSpanParts(span) {
  const s = String(span).trim();
  const after = s.slice((ORG_SPAN_PREFIX.exec(s) || [""])[0].length);
  const org = after.split(/[/#\s.:]/)[0];
  return { org: org.toLowerCase(), rest: after.slice(org.length) };
}
function orgNamedBySpan(span) {
  return orgSpanParts(span).org;
}

// True when the part of an org-shaped span AFTER the org it names itself matches the org
// shape — a second, different org riding inside one span (`repos/<org>/kailash-x-enterprise`).
// Any per-span suppression keyed on the FIRST org (the scrubber tolerance, the Foundation
// allowlist) must not extend to what rides along.
function orgRidesAlong(span, shapeRx) {
  // The rest is taken from the org's OWN position, after the stripped prefix — never from the
  // first occurrence of its text, which can sit inside the prefix (org `dev` in `dev.azure.com/dev/…`).
  const { org, rest } = orgSpanParts(span);
  if (!org) return false;
  return new RegExp(shapeRx.source, shapeRx.flags.replace("g", "")).test(rest);
}

// The SENTINELS a scrubbed roster carries in place of identity — the client-template
// edition writes a schema-valid placeholder roster (`PLACEHOLDER-owner`,
// `placeholder-owner`, an all-zero root commit, a `synthHex` DEADBEEF fingerprint) so a
// re-derive over the emitted tree "harvests nothing". `deriveDynamicTokens` drops the
// `PLACEHOLDER-` genesis owner but NOT the rest, so without this filter the shape would
// flag every file that DESCRIBES the placeholder (the emitter itself, clean-instantiate,
// any fixture using the conventional synthetic fingerprint). MEASURED: the client-template
// emit went red on exactly those 11 lines and nothing else. A sentinel is by construction
// not anyone's identity.
//
// Two vocabularies are filtered, and they have DIFFERENT authors:
//
//   (1) the placeholder ROSTER the two emitters write (`edition-emit.mjs` and
//       `clean-instantiate.mjs::placeholderRoster`): `PLACEHOLDER-owner` / `placeholder-owner`,
//       pubkey `PLACEHOLDER`, root `0000000`, a `synthHex` DEADBEEF fingerprint — declared here;
//   (2) the SCRUB's replacement vocabulary (`identity-scrub.mjs::SCRUB_PLACEHOLDER` +
//       `synthHex`), declared ONCE in that module and consulted through
//       `isScrubPlaceholderToken`, never re-listed here. A carrier NEUTRALIZE-scrubbed IN PLACE
//       (a `.claude/trust-root.json` signer `person_id` now reading `maintainer`) is read back by
//       `trustRootSignerTokens`, and before (2) was consulted the scanner harvested the
//       scrubber's own placeholder as an operator identity: 219 findings on the client-template
//       edition and 79 on a clean-instantiate'd copy, every one the English word.
//
// Every entry is EXACT-match (case-insensitive), never prefix or substring, and each hex
// sentinel is floored at the length it is written at, so neither swallows a real login that
// merely looks like one. Measured before: `/^placeholder-/` and an unfloored DEADBEEF pattern
// dropped real logins `placeholder-ops` and `DeadBeef` — a single-person roster of either read
// INERT, rc 0. The DEADBEEF floor stays 16 HERE (`minSynthHexLength`); clean-instantiate's own
// token filter passes no floor and so carries the `DeadBeef` bound this reader refuses — a
// difference of callers, not of vocabulary. DECLARED BOUND: a real login spelled exactly `placeholder-owner`, or
// exactly one of `SCRUB_PLACEHOLDER`'s values (`maintainer`, `example-host`, …), is not seen.
function isIdentityPlaceholder(t) {
  return (
    /^placeholder-owner$/i.test(t) ||
    /^0{7,}$/.test(t) ||
    isScrubPlaceholderToken(t, { minSynthHexLength: 16 })
  );
}

const ROSTER_REL = path.join(".claude", "operators.roster.json");

// PRESENCE by `lstat`, not `existsSync`: `existsSync` follows a symlink and returns false
// for a DANGLING one, so a roster or denylist that was a broken link read as ABSENT — the
// identity shape went INERT with a NOTICE and rc 0 — instead of present-but-unreadable,
// which refuses (measured). Only "no such entry" is absence; any entry at the path is
// present, and a read that then fails is the caller's loud refusal.
function isPresentPath(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch (e) {
    return !(e && (e.code === "ENOENT" || e.code === "ENOTDIR"));
  }
}

// Operator-visible messages name a root by ROLE, never by absolute path: an absolute path
// here is `/Users/<operator>/…` or `/home/<operator>/…`, the very class this scanner
// flags, printed to stderr by the tool that claims its output is safe to paste.
function displayPath(p) {
  const abs = path.resolve(p);
  if (abs === path.resolve(REPO_ROOT_ACTIVE)) return "<scan-root>";
  if (abs === path.resolve(REPO_ROOT)) return "<scanner-checkout>";
  const within = (root) => {
    const rel = path.relative(path.resolve(root), abs);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : null;
  };
  const inScan = within(REPO_ROOT_ACTIVE);
  if (inScan !== null) return `<scan-root>/${inScan}`;
  const inSelf = within(REPO_ROOT);
  if (inSelf !== null) return `<scanner-checkout>/${inSelf}`;
  return `<outside-root>/${path.basename(abs)}`;
}
const TRUST_ROOT_REL = path.join(".claude", "trust-root.json");

// Structural check BEFORE token derivation, so an empty or wrong-shaped roster is a loud
// refusal instead of an inert shape. Returns the parsed roster.
function assertRosterUsable(p) {
  let parsed;
  try {
    parsed = JSON.parse(readConfigText(p));
  } catch (e) {
    throw new Error(
      `operators.roster.json present but unreadable or unparseable at ${displayPath(p)}: ${parseErrorWhere(e)} ` +
        `(refusing to run with the operator-identity shape silently disabled)`,
    );
  }
  // BOTH collections are read, merged (`rosterPersonEntries`, the one the token harvest uses).
  // `persons ?? operators` read only the first: a roster carrying both silently dropped every
  // `operators` person while the scan read clean (measured rc=0). A key that is present
  // (non-null) must be a collection; any other type is refused, as is a roster whose merged
  // collection is empty.
  const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const present = ["persons", "operators"].filter((k) => obj[k] !== undefined && obj[k] !== null);
  const badKey = present.find((k) => typeof obj[k] !== "object");
  const entries = badKey ? [] : rosterPersonEntries(obj);
  if (entries.length === 0) {
    const got = badKey
      ? `${badKey}: ${typeof obj[badKey]}`
      : present.length === 0
        ? "none"
        : present.map((k) => `${k}: ${Array.isArray(obj[k]) ? "an empty array" : "an empty object"}`).join(", ");
    throw new Error(
      `operators.roster.json at ${displayPath(p)} carries no non-empty persons/operators collection ` +
        `(got ${got}). ` +
        `A roster that declares nobody would make the operator-identity shape INERT while the scan ` +
        `still reports clean; refusing instead.`,
    );
  }
  // PER PERSON, not per roster: the genesis owner and root commit keep a whole-roster count
  // above zero, so a person with no harvestable field would otherwise pass as covered while
  // no token of theirs could ever match. Located by INDEX into the merged list, never by value.
  for (const [i, [pid, person]] of entries.entries()) {
    // A declared field of the wrong TYPE (an array `principal`, a string `keys[]` entry, a
    // short fingerprint) was dropped silently while another field kept the person "covered"
    // (measured rc=0 on the dropped value). Shape is checked by the shared validator.
    // A person record that is not an object (a bare string or array) carried its identity
    // where no field is read, while the map key kept the person "covered" (measured rc=0).
    const problem =
      person !== null && person !== undefined && (typeof person !== "object" || Array.isArray(person))
        ? `person record is ${Array.isArray(person) ? "an array" : typeof person}, not an object`
        : personShapeProblem(person);
    if (problem) {
      throw new Error(
        `operators.roster.json at ${displayPath(p)}: person entry #${i} (0-based) has a field of the ` +
          `wrong shape (${problem}); its value could never be matched, so the scan would read clean ` +
          `over it; refusing instead.`,
      );
    }
    if (personIdentityTokens(pid, person).length === 0) {
      throw new Error(
        `operators.roster.json at ${displayPath(p)}: person entry #${i} (0-based) yields ZERO ` +
          `identity tokens — no map-key id, ${PERSON_ID_FIELDS.join(" / ")} value, or key ` +
          `fingerprint of length > 2. Its ` +
          `identity could never be matched, so the scan would read clean over it; refusing instead.`,
      );
    }
  }
  return parsed;
}

// Every 7-64-hex commit this root declares: the roster genesis root_commit (also in the
// deriveDynamicTokens gate), the committed trust root, and — at this checkout only — the
// git root commit(s). Read failures here add nothing; the roster itself is asserted above.
// The trust root at `r`, parsed ONCE per path and shared by `rootCommitsAt` and
// `trustRootSignerTokens`, or null when nothing is at the path. Both used to read the file
// separately, and the signer read swallowed every failure (`catch { return [] }`) on the
// assumption that the other read would refuse — two reads of one name can also see two
// different files. A present trust root must be a regular file (read without following a
// link, and without blocking on a FIFO), must parse, and must be a JSON object.
const _trustRootCache = new Map();
function readTrustRootAt(r) {
  const tp = path.join(r, TRUST_ROOT_REL);
  if (_trustRootCache.has(tp)) return _trustRootCache.get(tp);
  let got = null;
  if (isPresentPath(tp)) {
    let tr;
    try {
      tr = JSON.parse(readConfigText(tp));
    } catch (e) {
      throw new Error(
        `trust-root.json present but unreadable or unparseable at ${displayPath(tp)} (${parseErrorWhere(e)}) — ` +
          `refusing to run with its root commit and signers silently unchecked`,
      );
    }
    if (!tr || typeof tr !== "object" || Array.isArray(tr)) {
      throw new Error(`trust-root.json at ${displayPath(tp)} is not a JSON object (got ${Array.isArray(tr) ? "array" : tr === null ? "null" : typeof tr}); refusing`);
    }
    got = { tp, tr };
  }
  _trustRootCache.set(tp, got);
  return got;
}

function rootCommitsAt(r) {
  const out = [];
  // A committed trust root that is PRESENT must parse: a corrupt one used to add nothing, with
  // no notice, dropping that root commit from the shape. Parse errors are reported by position
  // only — V8's message quotes input bytes.
  const got = readTrustRootAt(r);
  if (got) {
    const { tp, tr } = got;
    const rc = tr.root_commit;
    if (rc !== undefined && rc !== null) {
      if (typeof rc !== "string" || !/^[0-9a-f]{7,64}$/i.test(rc.trim())) {
        throw new Error(
          `trust-root.json at ${displayPath(tp)} has a root_commit of the wrong shape ` +
            `(${typeof rc === "string" ? `length ${rc.trim().length}, not 7-64 hex` : typeof rc}); refusing`,
        );
      }
      out.push(rc.trim());
    }
  }
  if (path.resolve(r) === path.resolve(REPO_ROOT) && isInsideWorkTree(r)) {
    const gitBin = _gse.resolveGitBinary();
    if (gitBin) {
      try {
        const res = spawnSync(gitBin, ["-C", r, "rev-list", "--max-parents=0", "HEAD"], {
          encoding: "utf8",
          env: _gse.gitEnv(),
          stdio: ["ignore", "pipe", "ignore"],
        });
        if (res.status === 0) out.push(...res.stdout.split(/\s+/).filter(Boolean));
      } catch {
        /* git could not answer — the full-length genesis token still covers the roster's */
      }
    }
  }
  return out.filter((h) => /^[0-9a-f]{7,64}$/i.test(h));
}

// The trust root's SIGNERS are declared identities too (each a `person_id` and a PGP
// `pubkey`); when they diverge from the roster they were never gated (measured rc=0). Their
// tokens are harvested with the roster's own rules. A malformed signers field is refused.
function trustRootSignerTokens(r) {
  // A read or parse failure REFUSES here (readTrustRootAt), never reads as "no signers".
  const got = readTrustRootAt(r);
  if (!got) return [];
  const { tp, tr } = got;
  if (tr.signers === undefined || tr.signers === null) return [];
  // `signers` is a MAP keyed by the signer's key fingerprint (what build-trust-root.mjs
  // writes); an array of records is accepted too. The key IS a fingerprint and is harvested.
  if (typeof tr.signers !== "object") {
    throw new Error(`trust-root.json at ${displayPath(tp)} has a signers field of the wrong type (${typeof tr.signers}); refusing`);
  }
  const entries = Array.isArray(tr.signers) ? tr.signers.map((x) => [null, x]) : Object.entries(tr.signers);
  const out = [];
  for (const [i, [fpKey, sg]] of entries.entries()) {
    // A signer record is checked like a roster KEY as well as a person: a null or short
    // `fingerprint` shadowed the map-key fingerprint, and an array `pubkey` dropped its UIDs
    // (both measured rc=0). The map key is the fingerprint unless the record carries one.
    let problem = sg && typeof sg === "object" && !Array.isArray(sg) ? personShapeProblem(sg) : `non-object entry, got ${typeof sg}`;
    if (!problem) {
      const f = sg.fingerprint;
      if (f !== undefined && f !== null && (typeof f !== "string" || f.trim().length < 16)) problem = "fingerprint not a 16+ character string";
      else if (sg.pubkey !== undefined && sg.pubkey !== null && typeof sg.pubkey !== "string") problem = `non-string pubkey, got ${Array.isArray(sg.pubkey) ? "array" : typeof sg.pubkey}`;
      else if (fpKey !== null && (typeof fpKey !== "string" || fpKey.trim().length < 16)) problem = "map key is not a 16+ character fingerprint";
    }
    if (problem) throw new Error(`trust-root.json at ${displayPath(tp)}: signer entry #${i} has the wrong shape (${problem}); refusing`);
    // BOTH the map-key fingerprint and any fingerprint the record carries are harvested: a
    // record's own (different) fingerprint used to shadow the map key.
    const rec = { ...sg, fingerprint: sg.fingerprint ?? fpKey ?? undefined };
    out.push(...personIdentityTokens(null, sg), ...trustAnchorTokens({ trust_anchors: [rec] }));
    if (fpKey !== null && sg.fingerprint != null && sg.fingerprint !== fpKey)
      out.push(...trustAnchorTokens({ trust_anchors: [{ ...sg, fingerprint: fpKey }] }));
  }
  // An SSH signer key is also cited by its 6-character `SHA256:<pre>` prose form, which the
  // roster derive adds for roster keys but nothing added for a signer-only key.
  for (const t of [...out]) {
    const m = /^sha256:([A-Za-z0-9+/=]{6})/i.exec(String(t).trim());
    if (m) out.push(`SHA256:${m[1]}`);
  }
  return out
    .filter((t) => typeof t === "string" && t.trim().length >= 3)
    .map((t) => t.trim())
    .filter((t) => !isSignerPlaceholder(t));
}

// PLACEHOLDER vocabulary a SCRUBBED trust root carries in place of a signer's identity. The
// neutralize scrub (`identity-scrub.mjs::makeScrubber`, NEUTRALIZE mode) rewrites each identity
// token to one of these words, and `clean-instantiate.mjs::isPlaceholderToken` already drops
// `maintainer` / `PLACEHOLDER`. The scanner harvested them as identity: MEASURED, a scrubbed trust
// root whose signer `person_id` is `maintainer` made that word an UNBOUNDED 10-character token and
// flagged every `maintainers` in the tree (26 findings on a six-file tree, ~219 on a real one).
// Filtered for SIGNER tokens, where the neutralizer writes them, on top of `isIdentityPlaceholder`
// (applied to every token later). NOT applied to roster persons: a roster person literally named
// `Placeholder` still flags (r3-bare-placeholder-login-is-not-a-sentinel). The list restates the
// scrub's literal `to` values (`identity-scrub.mjs`, the `scrub.push([…, "<word>"])` sites) because
// the lib does not export them. DECLARED BOUND: a real signer whose person_id is exactly one of
// these words is not seen.
const SIGNER_PLACEHOLDER_WORDS = new Set([
  "maintainer",
  "example maintainer",
  "example-maintainer",
  "example-host",
  "maintainer@example.com",
  "example.com",
  "a downstream tenant",
  "placeholder",
]);
function isSignerPlaceholder(t) {
  const s = String(t).trim();
  return isIdentityPlaceholder(s) || SIGNER_PLACEHOLDER_WORDS.has(s.toLowerCase()) || /^<[^>]*>$/.test(s);
}

// Every CONFIG file this scanner parses (tenant denylist, roster, trust root, ecosystem
// registry) is read through the lib's `readRegularFileNoFollow`: the open itself refuses a
// final-component symlink (O_NOFOLLOW) and does not block on a FIFO (O_NONBLOCK), and the kind
// is decided from the OPENED descriptor. `readFileSync` followed a link — an inbound tree's
// `disclosure-tenant-denylist.json -> <file elsewhere>` loaded out-of-tree tokens, and an
// `ecosystem.json` link declared an out-of-tree org as OWN, exempting a foreign receipt (rc=0,
// measured) — and a FIFO at any of the four paths hung the scan until killed (measured, all four).
// The refusal is an `UnsafeFileReadError`; callers turn it into exit 2 via `parseErrorWhere`,
// which names the refused KIND and never a byte of the file.
function readConfigText(p) {
  assertNoLinkedAncestor(p);
  return readRegularFileNoFollow(p, { label: path.basename(p) });
}

// O_NOFOLLOW guards only the FINAL component. Every directory BETWEEN the root and a config file
// is also checked, by `lstat`, and a symlink there refuses the read (round-2 item 1, 2026-09-28).
// MEASURED before: `.claude/bin` linked to an out-of-tree directory holding `ecosystem.json`
// declared a foreign org as OWN, so a foreign receipt read rc=0 (rc=1 without the link) — while
// the same link was named UNDESCENDED as resolving outside the root. The roster, denylist and
// trust root were read the same way through a linked `.claude`. The root itself is not checked
// (a scan root may legitimately be reached through a link, e.g. macOS `/var` → `/private/var`).
// DECLARED RESIDUAL: the walk and the open are separate syscalls, so an ancestor swapped in
// between is not seen — the check-to-use class `rules/security.md` § Path Containment records as
// open for the whole path walk on this runtime (no `openat`).
function assertNoLinkedAncestor(p) {
  const abs = path.resolve(p);
  const within = (r) => {
    const rel = path.relative(path.resolve(r), abs);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  const root = [REPO_ROOT_ACTIVE, REPO_ROOT].map((r) => path.resolve(r)).find(within);
  if (!root) throw new UnsafeFileReadError(path.basename(p), "outside-root", "it is not under a scan root");
  let cur = root;
  for (const seg of path.relative(root, path.dirname(abs)).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, seg);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      return; // an absent ancestor: the read itself reports the file absent / unreadable
    }
    if (st.isSymbolicLink()) {
      throw new UnsafeFileReadError(path.basename(p), "symlinked-ancestor", "a directory on its path is a symlink");
    }
  }
}

// A parse error's POSITION, never its message: V8's JSON.parse messages quote an excerpt of
// the input, and these inputs are the identity/tenant files this scanner exists to withhold
// (measured: a denylist token printed on stderr under exit 2).
function parseErrorWhere(e) {
  if (e && e.code === "ERR_UNSAFE_FILE_READ")
    return `refused to read it: ${e.kind} (a config file is read only as a regular file, never through a link or from a FIFO / device)`;
  if (!(e instanceof SyntaxError)) return `read error ${(e && e.code) || "unknown"}`;
  const m = /position (\d+)/.exec(String((e && e.message) || ""));
  return m ? `JSON syntax error at position ${m[1]}` : `JSON syntax error, position unknown`;
}

// Nested-optional prefix pattern: `abcdefg(?:h(?:i…)?)?` matches exactly the prefixes of
// `hex` that are at least `min` long, and nothing that merely shares the first `min`.
// A 40-hex identity's prefix is ALSO matched with hex on either side once it is at least
// this long. The scanner reports and never rewrites, so an in-run match cannot corrupt
// content (the class `identity-scrub.mjs` bounds its root_commit scrub pair against); its
// only cost is a chance collision, ~1/16^12 per position. Below 12 the in-run form stays
// a declared bound, because a 7-digit window inside unrelated hex is not rare enough.
// Why it exists: at 9e5d6c1b7 a shipped comment in `bin/lib/identity-scrub.mjs` carried
// 32 leading digits of loom's git root commit glued after 10 other hex digits — a pasted
// measurement, not an adversarial form — and the hex-delimited prefix form could not see it.
const HEX_MIDRUN_MIN = 12;
function hexPrefixPattern(hex, min) {
  let tail = "";
  for (let i = hex.length - 1; i >= min; i--) tail = `(?:${escapeForRegex(hex[i])}${tail})?`;
  return escapeForRegex(hex.slice(0, min)) + tail;
}

// A trust-root SIGNER is a person — a `person_id` and a key — exactly as a roster person is, so
// its tokens are PERSON tokens and always flag (G7, 2026-09-27; the scrubber-path tolerance this
// comment once leaned on was DELETED Tier-1 round 2, so nothing at that path is exempt now).
// They were harvested into the shape but not into PERSON_TOKENS, so a signer
// whose `person_id` equals a declared canon org (a user-owned repo whose owner IS a login) read
// rc=0 in `strip-build-internal.mjs` while the same person declared in the roster read rc=1 —
// and at a root with NO roster, PERSON_TOKENS stayed empty, so every signer token was eligible.
// Fail-closed direction: this only removes tolerances.
function addSignerPersonTokens(tokens) {
  for (const t of tokens) PERSON_TOKENS.add(String(t).trim().toLowerCase());
}

function loadOperatorIdentityShape(rootActive) {
  const roots =
    path.resolve(rootActive) === path.resolve(REPO_ROOT)
      ? [rootActive]
      : [rootActive, REPO_ROOT];
  const tenant = new Set(
    roots
      .flatMap((r) => readTenantTokens(path.join(r, TENANT_DENYLIST_REL)))
      .map((t) => t.trim().toLowerCase()),
  );
  PERSON_TOKENS.clear();
  const raw = [];
  let rostersRead = 0;
  for (const r of roots) {
    const rp = path.join(r, ROSTER_REL);
    if (!isPresentPath(rp)) {
      // No roster at this root, but its TRUST ROOT is still read: a consumer commits
      // `trust-root.json` and keeps the roster local, so an inbound tree at Gate-1 intake
      // carried a root commit and signer identities that were never loaded (measured rc=0).
      const signers = trustRootSignerTokens(r);
      addSignerPersonTokens(signers);
      raw.push(...rootCommitsAt(r), ...signers);
      continue;
    }
    const parsed = assertRosterUsable(rp);
    rostersRead++;
    for (const [pid, person] of rosterPersonEntries(parsed)) {
      for (const t of personIdentityTokens(pid, person)) PERSON_TOKENS.add(String(t).trim().toLowerCase());
    }
    addSignerPersonTokens(trustRootSignerTokens(r));
    // Every token the ROSTER declares (persons, genesis values, trust anchors) is exempt from
    // the tenant subtraction below. Subtracting one handed it to the customer shape's BOUNDED
    // match, so adding a roster value to the denylist made a glued citation that flagged
    // before read clean (measured for a person login, then for the genesis owner). Either
    // root's denylist could do it, including an INBOUND tree's at Gate-1 intake.
    const rosterDeclared = new Set(PERSON_TOKENS);
    const g = parsed.genesis && typeof parsed.genesis === "object" ? parsed.genesis : {};
    for (const k of ["repo_owner", "ado_project", "root_commit"])
      if (typeof g[k] === "string" && g[k].trim()) rosterDeclared.add(g[k].trim().toLowerCase());
    for (const t of trustAnchorTokens(parsed)) rosterDeclared.add(String(t).trim().toLowerCase());
    // So are the SSH `SHA256:<pre>` prose tokens derived from a roster fingerprint (neither
    // token list carries them), and the trust root's signers.
    for (const t of trustRootSignerTokens(r)) rosterDeclared.add(String(t).trim().toLowerCase());
    for (const t of [...rosterDeclared])
      if (/^sha256:[a-z0-9+/=]{6,}$/i.test(t)) rosterDeclared.add(`sha256:${t.slice(7, 13)}`);
    const gate = deriveDynamicTokens(r)
      .gate.filter((t) => typeof t === "string")
      .map((t) => t.trim())
      .filter((t) => t.length >= 3 && (!tenant.has(t.toLowerCase()) || rosterDeclared.has(t.toLowerCase())));
    // A roster whose every harvested token is a PLACEHOLDER sentinel (a deliberately scrubbed
    // roster) is announced HERE, per root, from the ROSTER's own tokens. It used to be decided
    // from the union with trust-root / root-commit tokens, so a scrubbed roster beside a trust
    // root printed a bare "0 findings" with no notice (measured).
    if (!gate.some((t) => !isIdentityPlaceholder(t))) {
      console.error(
        `scan-synced-disclosure: NOTICE — the roster at ${displayPath(r)}/ carries only PLACEHOLDER sentinels, ` +
          `so its operator identities were NOT checked.`,
      );
    }
    raw.push(...gate, ...rootCommitsAt(r), ...trustRootSignerTokens(r));
  }
  if (rostersRead === 0) {
    // LOUD whenever no roster was read, including when trust-root or git root-commit tokens
    // keep the shape alive: without this a consumer's in-place scan checked only commit and
    // signer tokens and printed a bare "0 findings" (the declared contract says a notice).
    console.error(
      `scan-synced-disclosure: NOTICE — operator-identity shape ${raw.length ? "PARTIAL" : "INERT"}: no ` +
        `.claude/operators.roster.json at ${roots.map((r) => displayPath(r) + "/").join(" or ")}, so roster identities were NOT checked` +
        (raw.length ? " (only root-commit / trust-root signer tokens were)." : "."),
    );
    if (raw.length === 0) return null;
  }
  const tokens = [...new Set(raw.filter((t) => !isIdentityPlaceholder(t)))];
  if (tokens.length === 0) {
    // Only placeholder sentinels anywhere: the per-roster notice above has already named each
    // scrubbed roster; this line says the shape as a whole checks nothing.
    console.error(
      `scan-synced-disclosure: NOTICE — operator-identity shape INERT: every declared identity is a ` +
        `PLACEHOLDER sentinel, so operator identity was NOT checked.`,
    );
    return null;
  }
  const built = buildOperatorIdentityRx(tokens);
  // FOLDED twin, for lines carrying non-ASCII: the publish gate matches through
  // `foldForGate` (NFKD, marks stripped, lower-cased), so a Kelvin-sign `K`, a dotted `İ`
  // or an NFD-decomposed name that the publish gate catches read clean here (measured).
  const folded = buildOperatorIdentityRx([...new Set(tokens.map(foldForGate))]);
  return {
    id: "operator-identity-token",
    rx: built.rx,
    maskRx: built.maskRx,
    foldRx: folded.rx,
    hasNonAsciiToken: tokens.some((t) => /[^\x00-\x7f]/.test(t)),
  };
}

// The operator shape's regexes over a token list: `rx` detects, `maskRx` hides in context.
function buildOperatorIdentityRx(tokens) {
  // A hex identity is recognised in its COMPACT form: a fingerprint written in spaced groups
  // (`gpg --fingerprint` prints it that way) or with a `0x` prefix otherwise stayed a literal
  // word, so its compact citation and every short form below were never matched (measured
  // rc=0). 40 hex is a SHA-1 commit or v4 key fingerprint; 64 hex a SHA-256 commit or v5/v6
  // key fingerprint, whose key ID is its LEADING 16 digits and so is a prefix form.
  const compactHex = (t) => t.replace(/\s+/g, "").replace(/^0x/i, "");
  const isHexId = (t) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(t);
  const hexIds = [...new Set(tokens.map(compactHex).filter(isHexId).map((t) => t.toLowerCase()))];
  const words = tokens.filter((t) => !isHexId(t)).sort((a, b) => b.length - a.length);
  const B64 = "[A-Za-z0-9+/=]";
  // SSH `SHA256:<base64>` fingerprints. The full literal stays a word. Its BODY is also cited
  // alone, and truncated: any 16+-character prefix of the body is matched (a 16-character
  // base64 window does not collide by chance), greedy over the rest of the body. The
  // 6-character `SHA256:<pre>` prose token is matched greedy over the base64 that follows
  // it, so the span — and the context mask — covers the whole truncated citation rather
  // than 13 characters with the next 20 printed in clear (measured).
  const sshBodies = [];
  const sshPre = [];
  const plain = [];
  for (const t of words) {
    const body = /^sha256:([A-Za-z0-9+/=]{16,})$/i.exec(t);
    const pre = /^sha256:([A-Za-z0-9+/=]{1,15})$/i.exec(t);
    if (body) sshBodies.push(body[1]);
    if (pre) sshPre.push(`SHA256:${escapeForRegex(pre[1])}${B64}*`);
    if (!pre) plain.push(t);
  }
  const long = plain.filter((t) => t.length >= 7);
  const short = plain.filter((t) => t.length < 7);
  const alts = [];
  const maskAlts = [];
  if (hexIds.length) {
    const forms = hexIds.flatMap((h) =>
      h.length === 40 ? [hexPrefixPattern(h, 7), h.slice(-16), h.slice(-8)] : [hexPrefixPattern(h, 7)],
    );
    alts.push(`(?<![0-9A-Fa-f])(?:${forms.join("|")})(?![0-9A-Fa-f])`);
    // MID-RUN: a prefix of HEX_MIDRUN_MIN+ digits, or a 40-hex key's 16-digit key ID, with hex
    // on either side. Tried only where the hex-delimited form above failed at this position,
    // and greedy over the rest of the prefix so the whole cited run is one span (and so masked
    // in context). A 16-digit window collides by chance at ~1/16^16 per position.
    const midRun = [
      ...hexIds.map((h) => hexPrefixPattern(h, HEX_MIDRUN_MIN)),
      ...hexIds.filter((h) => h.length === 40).map((h) => h.slice(-16)),
    ];
    alts.push(`(?:${midRun.join("|")})`);
    // SEPARATED: the full identity with up to three separator characters (space, tab, `:`, `-`)
    // allowed between any two hex PAIRS — `gpg --fingerprint`'s spaced groups, colon- or
    // dash-grouped fingerprints. The compact roster value alone never matched pasted gpg
    // output (measured rc=0), and a punctuation-grouped one printed in clear beside a finding.
    const separated = hexIds
      .map((h) => h.match(/.{2}/g).map(escapeForRegex).join("[ \\t:\\-]{0,3}"));
    if (separated.length) alts.push(`(?<![0-9A-Fa-f])(?:${separated.join("|")})(?![0-9A-Fa-f])`);
    maskAlts.push(...alts);
  }
  if (sshBodies.length) {
    alts.push(`(?:${sshBodies.map((b) => base64PrefixPattern(b, 16)).join("|")})`);
  }
  if (sshPre.length) alts.push(`(?:${sshPre.join("|")})`);
  if (long.length) alts.push(`(?:${long.map(escapeForRegex).join("|")})`);
  if (short.length) alts.push(`(?<![A-Za-z0-9])(?:${short.map(escapeForRegex).join("|")})(?![A-Za-z0-9])`);
  // The CONTEXT mask hides every word token UNBOUNDED: a short token glued to letters is a
  // declared bound for DETECTION, but printed beside a real finding it was shown in clear.
  if (sshBodies.length) maskAlts.push(`(?:${sshBodies.map((b) => base64PrefixPattern(b, 16)).join("|")})`);
  if (sshPre.length) maskAlts.push(`(?:${sshPre.join("|")})`);
  if (long.length + short.length) maskAlts.push(`(?:${[...long, ...short].map(escapeForRegex).join("|")})`);
  return {
    rx: new RegExp(alts.join("|"), "gi"),
    maskRx: new RegExp(maskAlts.length ? maskAlts.join("|") : "(?!)", "gi"),
  };
}

// Prefix pattern over a base64 body (case-SENSITIVE content, matched under the shape's `i`
// flag — a case variant of base64 is a different value, so a chance case-folded match is
// accepted as a false positive in the safe direction).
//
// LINEAR, not nested (G9, 2026-09-27). This used to nest one optional group per body character
// past `min` — the `hexPrefixPattern` form, which is safe there because a hex identity is at
// most 64 digits, but a roster `SHA256:` fingerprint has NO length bound. MEASURED: a roster
// fingerprint of `SHA256:` + 200,000 base64 characters killed the scanner with SIGSEGV (status
// null, zero output); in isolation the same pattern aborted V8 with `FATAL ERROR: RegExpCompiler
// Allocation failed` (exit 134) from 5,000 characters. Neither is catchable, so the crash fence
// never ran and the caller got an exit code outside this scanner's vocabulary. The trigger is the
// same 16-character prefix; the span now continues over ANY following base64 rather than only
// over the body's own continuation, which can only WIDEN the span and so the context mask.
function base64PrefixPattern(b, min) {
  return `${escapeForRegex(b.slice(0, min))}[A-Za-z0-9+/=]*`;
}

// ────────────────────────────────────────────────────────────────
// CROSS-REPO-AUTHZ RECEIPT-PAYLOAD SHAPE (#1330)
// ────────────────────────────────────────────────────────────────
//
// A committed `.claude/cross-repo-authz/<date>-<slug>.md` receipt embeds
// its target `<org>/<repo>` in two structured payload lines (the greppable
// marker `cross-repo-authorized: <org>/<repo> <mode>` and the bounded-action
// `- **Target repo:** <org>/<repo>`). At loom-source those receipts are
// self-excluded (isExcluded, source-only, next to the `ecosystem.json`
// entry); at a DESTINATION scan (`--root <consumer>`) a LEAKED receipt is
// scanned. The pre-#1330 scanner only flagged such a leak when its target
// org happened to match ANOTHER disclosure shape (e.g. `*-enterprise`); an
// arbitrary client `<org>/<repo>` (a plain `slug/slug`) matched NO shape and
// sailed through — the destination backstop was honest best-effort. This
// shape closes that gap by matching the receipt payload's own content.
//
// OWN-ORG ALLOWLISTED: the OWN-ecosystem org set is derived from the D6
// registry (`.claude/bin/ecosystem.json` — the same source
// `checkClientTemplateCompleteness` reads), so a legitimate own-ecosystem
// receipt reference is suppressed while a receipt naming a FOREIGN org flags.
// Deriving from ecosystem.json (not a hardcoded own-org list) is what makes
// the shape correct inside a client FORK, whose own org differs from canon's.
// A consumer WITHOUT an ecosystem.json yields an EMPTY own set → the shape
// fails CLOSED (every concrete-slug receipt flags — any receipt at a plain
// consumer is a leak by construction).
//
// PATH-SCOPED to a `cross-repo-authz/` directory (see scanFile `pathScope`):
// the shape examines ONLY receipt FILES, never a doc/journal/proposal that
// quotes the marker in prose. That structural scope — not a placeholder
// denylist — is what keeps the shape FALSE-POSITIVE-free at a loom-source
// scan (`commands/cross-repo-authorize.md` uses the metavariable form
// `<owner/repo>`, which the leading `<` breaks anyway; journals are excluded
// wholesale; but path-scoping removes the entire class of doc false hits).
const ECOSYSTEM_REGISTRY_REL = path.join(".claude", "bin", "ecosystem.json");

// Derive the OWN-ecosystem GitHub-org set from the D6 registry at
// `rootActive` (registry.org + every remote_links.*.org). Absent file →
// empty set (fail-closed: all receipts flag). PRESENT-but-unparseable →
// throw loud (a guard that silently disables itself on a typo is worse than
// no guard — the same posture loadCustomerIdentityShape takes).
function readEcosystemOwnOrgs(rootActive) {
  const orgs = new Set();
  const p = path.join(rootActive, ECOSYSTEM_REGISTRY_REL);
  // Presence by lstat (`isPresentPath`): `existsSync` follows a link and read a DANGLING one as
  // absent. Any entry at the path is present, and `readConfigText` then refuses a non-regular one.
  if (!isPresentPath(p)) return orgs;
  let parsed;
  try {
    parsed = JSON.parse(readConfigText(p));
  } catch (e) {
    throw new Error(
      `ecosystem.json present but unreadable or unparseable at ${displayPath(p)}: ${parseErrorWhere(e)} ` +
        `(refusing to run a silently-org-blind receipt-payload guard)`,
    );
  }
  const add = (v) => {
    if (typeof v === "string" && /^[a-z0-9-]+$/i.test(v.trim())) {
      orgs.add(v.trim().toLowerCase());
    }
  };
  if (parsed && parsed.registry) add(parsed.registry.org);
  if (parsed && parsed.remote_links && typeof parsed.remote_links === "object") {
    for (const link of Object.values(parsed.remote_links)) {
      if (link && typeof link === "object") add(link.org);
    }
  }
  return orgs;
}

// Build the `cross-repo-authz-receipt-payload` SHAPE from the own-org set at
// `rootActive`. The `<org>` segment carries a negative-lookahead over the
// own-org alternation (empty set → no lookahead → every concrete slug flags,
// fail-closed). A CONCRETE `slug/slug` is required: the metavariable
// placeholders (`<org>/<repo>`, `<owner/repo>`) never match because the
// leading `<` after the marker is not a slug char. `pathScope` confines the
// shape to receipt files under a `cross-repo-authz/` directory.
//
// THREE org-bearing marker lines are matched — every real receipt carries all
// three: the two body markers (`cross-repo-authorized:` + `**Target repo:**`)
// AND the frontmatter key `target:` (#1330 L1). Matching the frontmatter line
// closes the partial-genericize evasion where a receipt's BODY markers were
// scrubbed but its frontmatter `target:` still carried the concrete foreign
// org. The `target:` alternative is anchored to line-start (`^[ \t]*target:`,
// per-line exec) so an INLINE prose "target:" cannot match — only the YAML
// frontmatter key. All three carry the SAME own-org negative-lookahead, so an
// own-org `target:` is suppressed exactly like the body markers.
function loadReceiptPayloadShape(rootActive) {
  const ownOrgs = readEcosystemOwnOrgs(rootActive);
  const negLookahead = ownOrgs.size
    ? `(?!(?:${[...ownOrgs].map(escapeForRegex).join("|")})\\/)`
    : "";
  const slug = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
  const rx = new RegExp(
    `(?:cross-repo-authorized:|\\*\\*Target repo:\\*\\*|^[ \\t]*target:)[ \\t]+` +
      `${negLookahead}(${slug}\\/${slug})`,
    "gi",
  );
  return {
    id: "cross-repo-authz-receipt-payload",
    rx,
    pathScope: /(^|\/)cross-repo-authz\//,
  };
}

// ────────────────────────────────────────────────────────────────
// Scan
// ────────────────────────────────────────────────────────────────
// Every active shape's spans are masked out of any finding's context, not just the
// finding's own span. Without it, a line carrying two flagged tokens printed the second in
// clear inside the first one's ±20-char window — measured for identity tokens (a name, an
// email, a branch) and, after the first fix covered identity shapes only, for org slugs,
// hostnames and runner labels. Masked on the FULL line before slicing, so a token cut by
// the window edge cannot survive as a fragment either.
const CONTEXT_MASK_RXS = [];
// The identity shapes are matched OVERLAPPING (see scanFile): their tokens are free text
// and can start inside one another. The structural shapes keep end-to-end iteration, which
// their finding counts are calibrated on.
const OVERLAPPING_SHAPES = new Set(["operator-identity-token", "customer-identity-token"]);

// Every hex run of 7+ digits is masked in context regardless of shape: an identity hash
// cited in a DECLARED-BOUND form (an 11-digit prefix mid-run, a key ID glued to other hex, a
// middle citation) is not a finding, but printed beside a real one it was shown in clear.
const CONTEXT_HEX_RUN_RX = /[0-9A-Fa-f]{7,}/g;
// The SEPARATED sibling (G4, 2026-09-27). A fingerprint cited PARTIALLY in groups — the first
// few `gpg --fingerprint` groups (`0A1B 2C3D 4E5F`), mixed separators (`0A1B2C.3D4E5F_607182`),
// or colon pairs (`0A:1B:2C:3D:4E:5F`) — is a declared bound for DETECTION, but no group reaches
// the 7-digit run above, so beside a real finding every group printed in clear (measured).
// Masked here: two or more groups of 4+ hex, or four or more groups of 2+ hex, joined by up to
// three of space / tab / `:` / `.` / `_` / `-`. Over-masking a hex-looking word pair in CONTEXT
// costs only legibility, never a leak.
//
// CORRECTED 2026-09-27 (round-1 L5): the claim that stood here — "a date and a clock time stay
// readable" — was true of each ALONE and false of the two together: `2026-09-27 12:30` is five
// decimal groups joined by `-`, ` ` and `:` and was masked (measured). A match that is EXACTLY a
// calendar date-time (`YYYY-MM-DD` plus an optional ` HH:MM[:SS]`) is now left readable
// (`isDateTimeText`); anything glued to it (a fingerprint group after the time) still masks the
// whole run.
//
// LINEAR (round-1 F5): the pattern is anchored so a match can only START where the previous
// character is not hex. Unanchored, every position of a long hex run re-tried the greedy first
// group and backtracked through the rest of the run — quadratic, MEASURED at 5k/20k/40k hex:
// 64 / 1224 / 4890 ms for this one pattern; anchored, 0-3 ms at up to 200k. The 7+-run pattern
// above was measured at 0 ms on the same inputs and is unchanged.
const CONTEXT_HEX_GROUPS_RX =
  /(?<![0-9A-Fa-f])(?:[0-9A-Fa-f]{4,}(?:[ \t:._-]{1,3}[0-9A-Fa-f]{4,})+|[0-9A-Fa-f]{2,}(?:[ \t:._-]{1,3}[0-9A-Fa-f]{2,}){3,})/g;
const isDateTimeText = (s) => /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(s);

// The mask is the UNION of every mask pattern's spans, each found on the ORIGINAL line and
// overlapping. Applying the patterns one after another to the already-masked line let an
// earlier mask cut the start off a later token, which then no longer matched and printed
// its remainder in clear (measured: a hostname mask left most of a glued login visible).
// One mask per line, cached: it was recomputed per finding, quadratic on a long line.
let maskCache = { line: null, masked: null };
// Folded identity patterns, for WITHHOLDING: a folded hit cannot be mapped back to raw
// columns (folding changes length), so a line or path in which one matches is withheld
// whole. Without this the folded finding's neighbours — and every printed path — showed the
// identity in clear (measured: an NFD login in a file name, a Kelvin-sign login in context).
const FOLD_MASK_SHAPES = [];
function maskIdentitySpans(line) {
  if (maskCache.line === line) return maskCache.masked;
  for (const sh of FOLD_MASK_SHAPES) {
    if (!foldApplies(sh, line)) continue;
    const r = new RegExp(sh.foldRx.source, sh.foldRx.flags.replace("g", ""));
    if (r.test(foldLine(line))) {
      maskCache = { line, masked: "\u0000".repeat(line.length) };
      return maskCache.masked;
    }
  }
  const hide = new Uint8Array(line.length);
  for (const { rx, overlapping, keep, extend } of [
    ...CONTEXT_MASK_RXS,
    { rx: CONTEXT_HEX_RUN_RX, overlapping: false },
    { rx: CONTEXT_HEX_GROUPS_RX, overlapping: false, keep: isDateTimeText },
  ]) {
    rx.lastIndex = 0;
    let m;
    while ((m = rx.exec(line)) !== null) {
      if (!(keep && keep(m[0]))) hide.fill(1, m.index, m.index + m[0].length);
      if (extend && !/[\\/]$/.test(m[0])) {
        extend.lastIndex = m.index + m[0].length;
        const e = extend.exec(line);
        if (e) hide.fill(1, e.index, e.index + e[0].length);
      }
      if (overlapping) rx.lastIndex = m.index + 1;
      else if (m[0].length === 0) rx.lastIndex++;
    }
  }
  let out = "";
  for (let i = 0; i < line.length; i++) out += hide[i] ? "\u0000" : line[i];
  maskCache = { line, masked: out };
  return out;
}

function redactContext(line, matchStart, matchText) {
  const src = maskIdentitySpans(line);
  const matchEnd = matchStart + matchText.length;
  const ctxStart = Math.max(0, matchStart - 20);
  const ctxEnd = Math.min(line.length, matchEnd + 20);
  const before = src.slice(ctxStart, matchStart);
  const after = src.slice(matchEnd, ctxEnd);
  const lead = ctxStart > 0 ? "…" : "";
  const trail = ctxEnd < line.length ? "…" : "";
  return `${lead}${before}«REDACTED»${after}${trail}`
    .replace(/\u0000+/g, "«REDACTED»")
    .replace(/\s+/g, " ")
    .trim();
}

// `stats.unread` collects files this function COLLECTED but could not READ. It is
// an out-parameter rather than a return value because every other exit from this
// function is a bare `return`, and the caller needs the fact regardless of which
// one was taken.
// FOLDED PASS. The publish gate matches identity through `foldForGate` (NFKD, combining marks
// stripped, lower-cased); this scanner matched raw text only, so a Kelvin-sign `K`, a dotted
// capital `İ` or an NFD-decomposed name that the publish gate stops read clean here
// (measured, three forms). For a line carrying non-ASCII, each identity shape's folded twin
// runs over the folded line; a hit the raw pass does not also make is one finding for the
// line. Folding can change string length, so no column is claimed and the context withholds
// the whole line.
function scanFoldedLine(line, ln, rel, findings, shapes, before) {
  for (const shape of shapes) {
    const fr = shape.foldRxG;
    if (!fr || !foldApplies(shape, line)) continue;
    // Reported already by the RAW pass for this line? Decided from findings that SURVIVED the
    // raw pass's allowlist and self-governing shapes, never from a bare raw match: a suppressed
    // raw match on the same line must not stand in for a real folded hit.
    let reported = false;
    for (let k = before; k < findings.length; k++) {
      if (findings[k].shape === shape.id && findings[k].line === ln) reported = true;
    }
    if (reported) continue;
    const folded = foldLine(line);
    fr.lastIndex = 0;
    let m;
    let hit = false;
    while ((m = fr.exec(folded)) !== null) {
      fr.lastIndex = m.index + 1;
      hit = true;
      break;
    }
    if (!hit) continue;
    findings.push({
      path: rel,
      line: ln,
      col: 1,
      shape: shape.id,
      context: "«REDACTED» (identity matched after Unicode folding; line withheld)",
    });
  }
}

// The folded pass runs on a line carrying non-ASCII, and on EVERY line when the shape has a
// non-ASCII token: the ASCII spelling of an accented token (`Societe` for `Société`) matches
// only after folding both sides, which the publish gate does and the raw pass cannot.
function foldApplies(shape, s) {
  return shape.hasNonAsciiToken || /[^\x00-\x7f]/.test(s);
}
function foldLine(s) {
  return /[^\x00-\x7f]/.test(s) ? foldForGate(s) : s.toLowerCase();
}

// PATH PASS. File NAMES ship too, and an identity in one (`.session-notes.d/<operator>.md`,
// `<login>-notes.md`) was never examined: only content lines were (measured rc=0). Each
// identity shape — raw and folded — runs over the scan-root-relative path; one finding per
// shape per path, and the printed path is masked like any context.
function scanPathForIdentity(relPosix, findings, shapes) {
  const folded = foldLine(relPosix);
  for (const shape of shapes) {
    if (!OVERLAPPING_SHAPES.has(shape.id) || !shape.rx) continue;
    const probes = [[new RegExp(shape.rx.source, shape.rx.flags.replace("g", "")), relPosix]];
    if (shape.foldRx && foldApplies(shape, relPosix))
      probes.push([new RegExp(shape.foldRx.source, shape.foldRx.flags.replace("g", "")), folded]);
    const m = probes.map(([rx, s]) => rx.exec(s)).find(Boolean);
    if (!m) continue;
    findings.push({ path: relPosix, line: 0, col: 1, shape: shape.id, context: "«REDACTED» (identity in the file PATH)" });
  }
}

// The STRUCTURAL shapes (org slug, hostname, runner label, …) run over the path too, as a
// line-0 pseudo-line through the same per-file rules and allowlist as content: a file named
// `<third-party>-enterprise-notes.md` shipped with the org in its NAME (measured rc=0).
function scanPathForStructure(file, findings, shapes, allowSyntheticFixtureHomes) {
  const rel = path.relative(REPO_ROOT_ACTIVE, file);
  const relPosix = rel.split(path.sep).join("/");
  const structural = shapes.filter((sh) => sh && sh.rx && !OVERLAPPING_SHAPES.has(sh.id));
  scanLines(rel, path.basename(file), [relPosix], findings, structural, allowSyntheticFixtureHomes, () => 0);
}

// Every path the scanner PRINTS goes through the same mask as finding context.
function shownPath(p) {
  return maskIdentitySpans(String(p)).replace(/\u0000+/g, "«REDACTED»");
}

// OPEN, THEN DECIDE — a collected tree path is classified from the OPENED descriptor, never from a
// path lookup made before the read. The previous form was `lstat → isFile → readFileSync(path)`,
// and a name re-pointed between the second `lstat` and the read was FOLLOWED: MEASURED with a
// preload that swaps the file for a link to an out-of-tree file after its 2nd `lstat`, the
// out-of-tree bytes printed in a finding's context (rc=1); swapped after the 1st, the path was
// named UNREAD and the link's target string was never scanned.
//
// Now: `O_NOFOLLOW` makes the open itself fail (ELOOP) on a final-component link, which is then
// scanned as what ships — its TARGET STRING (`readlinkSync`; a link that is replaced again before
// that read is UNREAD, never followed). `O_NONBLOCK` keeps a FIFO from blocking the open, and the
// descriptor's `fstat` must say REGULAR FILE or the path is UNREAD. The bytes read are the bytes
// of the object checked. No size cap: tree files are scanned whole, as before.
// Where `O_NOFOLLOW` is not defined (win32) the check is race-EVIDENT instead: `lstat` before the
// open and `fstat` after must name the same `dev`+`ino`, or the path is UNREAD.
const TREE_O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
const TREE_O_NONBLOCK = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
function openTreeFile(file) {
  const readLink = () => {
    try {
      return { kind: "link", text: fs.readlinkSync(file) };
    } catch {
      return { kind: "unread" };
    }
  };
  let pre = null;
  if (!TREE_O_NOFOLLOW) {
    try {
      pre = fs.lstatSync(file);
    } catch {
      return { kind: "unread" };
    }
    if (pre.isSymbolicLink()) return readLink();
    if (!pre.isFile()) return { kind: "unread" };
  }
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | TREE_O_NOFOLLOW | TREE_O_NONBLOCK);
  } catch (e) {
    if (TREE_O_NOFOLLOW && e && (e.code === "ELOOP" || e.code === "EMLINK")) return readLink();
    return { kind: "unread" };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { kind: "unread" };
    if (pre && (pre.dev !== st.dev || pre.ino !== st.ino)) return { kind: "unread" };
    const chunks = [];
    const chunk = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      chunks.push(Buffer.from(chunk.subarray(0, n)));
    }
    return { kind: "file", buf: Buffer.concat(chunks) };
  } catch {
    return { kind: "unread" };
  } finally {
    fs.closeSync(fd);
  }
}

function scanFile(file, findings, shapes, allowSyntheticFixtureHomes = false, stats = null) {
  scanPathForIdentity(path.relative(REPO_ROOT_ACTIVE, file).split(path.sep).join("/"), findings, shapes);
  scanPathForStructure(file, findings, shapes, allowSyntheticFixtureHomes);
  // A SYMLINK's content in git is its TARGET STRING, and that is what ships — never the
  // target's bytes. It was never read: a tracked link to `/Users/<operator>/…` read clean
  // (dangling: UNREAD only; resolving: the target's content was scanned instead). The target
  // string is scanned as line 0 with every shape.
  const opened = openTreeFile(file);
  if (opened.kind === "link") {
    scanLines(path.relative(REPO_ROOT_ACTIVE, file), path.basename(file), [opened.text], findings, shapes, allowSyntheticFixtureHomes, () => 0);
    // The link's CONTENT is its target string, scanned above — and that is all that ships.
    // Following it read out-of-tree bytes (an inbound tree's `notes.md -> ../../.git-credentials`
    // printed ±20 characters beside a shape hit) and could block on `/dev/zero` or a FIFO.
    return;
  }
  if (opened.kind !== "file") {
    // A file that cannot be READ was never EXAMINED. Recording it is NOT a
    // decision about whether it is a FINDING — that is a genuine design question
    // with caller impact and is deliberately NOT settled here. What is settled,
    // and was not before, is that the receipt must not COUNT this file among the
    // ones it examined. MEASURED before this change: a root holding one readable
    // and one dangling-symlink file exited 0 and printed `Scanned: 2 files`, so
    // the receipt vouched for a file the scanner never opened.
    if (stats) stats.unread.push(file);
    return;
  }
  const buf = opened.buf;
  if (isProbablyBinary(buf)) return;
  const rel = path.relative(REPO_ROOT_ACTIVE, file);
  const base = path.basename(file);
  // Client-template gate opt-in + detector-corpus tolerance. A SYNTHETIC fixture home inside
  // one of loom's OWN detector-fixture files is PRESERVED verbatim by that projection's scrubber
  // (loom#1318) and is benign here. The USERNAME GATE below -- not the scan root, not the flag --
  // is what discriminates: a REAL operator home in ANY of these files still FLAGS, so none of this
  // can swallow a live leak (dual-half parity).
  //
  // THE CORPUS HAS TWO CONVENTIONS, AND KEYING ON ONE OF THEM WAS THE DEFECT. The original
  // predicate was a BASENAME test (`*.test.(mjs|js)`) -- loom's `node:test` suites. The newer
  // audit-fixture convention is a DIRECTORY: `audit-fixtures/<name>/` holding a `run.mjs`/`run.cjs`
  // runner plus its sibling candidate payloads (`.txt`, `.md`, `.json`). NO file written to that
  // convention can ever end `.test.mjs`, so for those fixtures the exemption was STRUCTURALLY
  // UNREACHABLE -- not "evaluated and declined". Measured before the fix on a two-file tree with the
  // flag ON: an `op` home in `audit-fixtures/demo/run.mjs` FLAGGED while the identical home in
  // `bin/demo.test.mjs` cleared; with the flag OFF both flagged, which is what shows the exemption
  // fires HERE and was blind only to the directory convention.
  //
  // MERGED 2026-09-13 from two lanes that fixed this independently, taking the stronger half of
  // each. SEGMENT-ANCHORED and ROOT-RELATIVE (from the scope-authority lane) rather than anchored
  // at `.claude/`, so `variants/<lang>/audit-fixtures/**` is covered too and a file merely NAMED
  // `...audit-fixtures...` is not. UNCONDITIONAL on the opt-in flag for the detector corpus (from
  // the gate-red lane), because the username gate is the real discriminator and the Gate-2 preflight
  // passes no flag -- without this the default scan stays red on loom's own fixture corpus.
  // Separator-normalised so the segment test holds where path.sep is not "/".
  //
  // SCOPE NOTE -- a per-shape TOLERANCE, never a directory EXCLUSION. `isExcluded` above records
  // why a wholesale source-only skip of a fixture tree is a regression: it once let a REAL operator
  // username ship, and audit-fixtures DO ship on the `cc` tier. Every OTHER shape still fires on
  // every file in this tree, and a non-synthetic username still fires on THIS shape.
  //
  // The directory segment is no longer a LITERAL here. `bin/lib/fixture-corpus.mjs` now OWNS both
  // conventions (the `audit-fixtures/` root segment and the `*.test.(mjs|js)` basename) and is the
  // exported authority this comment previously recorded as MISSING — the earlier note that "no
  // exported authority owns this root path" was true when written and is now FALSE. The candidates
  // it named still decline the job, which is why a new module was minted rather than one of them
  // extended: `bin/lib/audit-fixture-runners.mjs` owns the fixture RUNNER BASENAME and takes the
  // fixtures ROOT as a parameter, while `run-audit-fixtures.mjs`'s `DEFAULT_FIXTURES_DIR` and
  // `census-build.mjs`'s `isNonRuntime` are module-private to a CLI.
  //
  // `isFixtureCorpusFile` is passed `rel` where this used to pass `base` for the basename half.
  // That is NOT a widening: the suite-basename pattern is END-ANCHORED and contains no path
  // separator, so it matches a full POSIX relative path exactly when it matches that path's
  // basename (exhaustively verified in `.claude/bin/fixture-corpus.test.mjs`).
  //
  // NOT the same question as `isExcluded`'s own `*.test.mjs` rule at :642, which stays inline: that
  // one decides whether a file is SCANNED AT ALL and is source-only (`REPO_ROOT_ACTIVE ===
  // REPO_ROOT`), where this one decides whether a scanned file's SYNTHETIC home is tolerated.
  // Sharing a predicate across the two would couple a corpus widening to a scan-coverage narrowing.
  scanLines(rel, base, buf.toString("utf8").split(/\r?\n/), findings, shapes, allowSyntheticFixtureHomes, (i) => i + 1);
}

function scanLines(rel, base, lines, findings, shapes, allowSyntheticFixtureHomes, lineNo) {
  const fixtureCorpusFile = isFixtureCorpusFile(rel);
  const testFixtureFile = allowSyntheticFixtureHomes && fixtureCorpusFile;
  const detectorFixtureFile = isAuditFixtureFile(rel);
  // 2026-10-03 (walk-widening finding d): `tests/**` is now WALKED, and the
  // multi-operator suites there are the same class as the audit-fixtures trees — loom's
  // OWN committed synthetic corpora, whose synthetic users (SYNTHETIC_FIXTURE_USERS) the
  // publish scrubbers deliberately PRESERVE. UNCONDITIONAL for the audit-fixtures arm's
  // own recorded reason (loom-source scans pass no flag), and NARROW on both axes: the
  // path must be under `tests/` and the basename must match the test-corpus convention,
  // so a non-test file under tests/ takes no tolerance, and the username gate below
  // compares the WHOLE username chain (see the tolerance block) so a REAL username — or a
  // traversal chain, or a non-synthetic first word of a spaced Windows name — still flags
  // in the same tree. Those are the pairs the fixture suite now reads on BOTH poles.
  const testsTreeFixtureFile =
    rel.split(path.sep).join("/").startsWith("tests/") && fixtureCorpusFile;
  const identityOnlyFile = isIdentityOnlyPath(rel);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const before = findings.length;
    for (const shape of shapes) {
      // A shape may declare `fileScope` (a basename regex); it then applies
      // ONLY to matching files. File-scoped shapes (e.g. the ecosystem
      // bare-org-slug shape) avoid flooding every repo-wide JSON value.
      if (shape.fileScope && !shape.fileScope.test(base)) continue;
      if (identityOnlyFile && !IDENTITY_ONLY_SHAPES.has(shape.id)) continue;
      // A shape may declare `pathScope` (a repo-relative-path regex); it
      // then applies ONLY to files whose `rel` path matches. The
      // cross-repo-authz receipt-payload shape (#1330) uses this to fire
      // ONLY on receipt FILES inside a `cross-repo-authz/` directory — never
      // on a doc/journal/proposal that merely quotes the marker in prose,
      // which is a different file class and would false-positive.
      if (shape.pathScope && !shape.pathScope.test(rel)) continue;
      shape.rx.lastIndex = 0;
      const overlapping = OVERLAPPING_SHAPES.has(shape.id);
      let prevEnd = -1;
      let prevText = "";
      let m;
      while ((m = shape.rx.exec(line)) !== null) {
        const matchText = m[0];
        if (overlapping) {
          // Resume one character past the match START, not at its end, and skip a match lying
          // wholly inside one already seen. A token beginning INSIDE an earlier span is then
          // still found — a greedy hex prefix swallowing the first digit of a glued second
          // hash, or a person token starting inside a private-org-shaped span — where
          // resuming at the end never looked at it (both measured: rc=0 / digits in clear).
          // A repeat of the SAME text overlapping the previous match (a periodic token in a
          // periodic run) is one citation, not several.
          shape.rx.lastIndex = m.index + 1;
          const end = m.index + matchText.length;
          const text = matchText.toLowerCase();
          if (end <= prevEnd || (m.index < prevEnd && text === prevText)) continue;
          prevEnd = end;
          prevText = text;
        } else if (m.index === shape.rx.lastIndex) shape.rx.lastIndex++;
        // Opt-in synthetic-fixture-home tolerance (client-template gate): skip an
        // operator-home-path span in one of loom's OWN detector fixtures -- a `*.test.(mjs|js)`
        // suite (flag-gated) or any file under an `audit-fixtures/<name>/` tree (unconditional,
        // since the Gate-2 preflight passes no flag) -- whose username is in the shared synthetic
        // set (loom#1318). A real username fails the set -> still flagged.
        if ((testFixtureFile || detectorFixtureFile || testsTreeFixtureFile) && shape.id === "operator-home-path") {
          // Any separator form, so a synthetic WINDOWS fixture home (`C:\\Users\\jdoe\\`) gets
          // the same tolerance as its POSIX twin.
          // THE WHOLE USERNAME CHAIN, through the SAME regex the shape was built from —
          // `makeHomepathRe` group 2 is "the USERNAME CHAIN, in every form", traversal
          // chains included ("an excluded name followed by such a traversal is not
          // excluded"). SECURITY REVIEW HIGH (2026-10-03): the previous form re-extracted
          // with `[\w.-]+`, so `/Users/jdoe/../real/` matched the PREFIX `jdoe` and was
          // suppressed, and the spaced-Windows, 8.3 (`JDOEZQ~1`) and non-ASCII chain forms
          // were missed entirely — while the publish scrubber compares the WHOLE name
          // (identity-scrub.mjs). A traversal chain never equals a set member, so it now
          // FLAGS; a non-synthetic first word in a spaced Windows chain likewise.
          const chain = (makeHomepathRe().exec(matchText) || [])[2];
          if (chain && SYNTHETIC_FIXTURE_USERS.has(chain.toLowerCase())) continue;
        }
        // F77 (#386): the settings-permission-absolute-path shape is
        // INTRINSICALLY wrong regardless of which operator's path it
        // wraps — a tool-call matcher in a synced settings.json's
        // `permissions.*` array MUST NOT carry an absolute filesystem
        // path even if the path's operator-stem is the maintainer's own
        // Option-1 self-coordinate. Skip the allowlist suppression for
        // this shape so own-coordinate `/Users/<operator>/` tokens inside
        // an `Edit(...)` matcher still flag. Every other shape retains
        // the Option-1 allowlist semantics unchanged.
        // The cross-repo-authz-receipt-payload shape (#1330) is also skipped
        // here: its own OWN-ORG negative-lookahead (derived from
        // ecosystem.json) is the SOLE suppression mechanism, so the generic
        // ALLOWLIST must NOT additionally suppress a foreign-org receipt that
        // happens to embed a placeholder-shaped token (fail-closed toward
        // flagging), exactly as the customer-identity-token shape self-governs.
        // `private-key-material` is skipped here on the same fail-closed reasoning: a PEM
        // marker span is not a coordinate any Option-1 allowlist entry legitimately covers,
        // and an allowlist that could suppress key material would be a switch for turning the
        // one unambiguous leak class off. No allowlist entry may ever swallow a private key.
        // `operator-identity-token` self-governs like the customer shape: its tokens are
        // the roster's own, so no placeholder allowlist entry may suppress one.
        if (
          shape.id !== "settings-permission-absolute-path" &&
          shape.id !== "customer-identity-token" &&
          shape.id !== "operator-identity-token" &&
          shape.id !== "cross-repo-authz-receipt-payload" &&
          shape.id !== "private-key-material" &&
          (shape.id === "nonfoundation-org-slug"
            ? // The allowlist vouches for the org a span NAMES, whole, and not for a second org
              // riding inside it (measured: `repos/<foundation-org>/kailash-x-enterprise` and
              // `consumer-labs/loom` read clean at every path).
              allowlistCoversOrg(matchText) && !orgRidesAlong(matchText, shape.rx)
            : allowlistCovers(matchText))
        )
          continue;
        findings.push({
          path: rel,
          line: lineNo(i),
          col: m.index + 1,
          shape: shape.id,
          context: redactContext(line, m.index, matchText),
        });
      }
    }
    scanFoldedLine(line, lineNo(i), rel, findings, shapes, before);
  }
}

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv);
SCAN_SURFACE = args.surface;
if (args.help) {
  usage();
  process.exit(0);
}

const root = args.root ? path.resolve(args.root) : REPO_ROOT;

// A NON-DISCRIMINATING RUN MUST NOT EXIT 0.
//
// `artifact-flow.md` § Intake Disclosure Scrub makes `--check --root <inbound-repo>`
// exiting 0 the Gate-1 intake gate, and `/ecosystem-init` invariant 1 makes it the
// pre-config-write gate. MEASURED 2026-08-10: a `--root` at a NONEXISTENT path
// produced exit 0 with ZERO bytes of output — byte-identical to a genuinely clean
// scan of a real root — so a mistyped, unresolved, or wrongly-relative path passed
// both gates silently. An outcome consistent with both branches of the hypothesis
// is not evidence (`instrument-discipline.md` MUST-1); the scan had not run.
//
// Both guards below exit 2, the code an unknown argument and a malformed denylist
// already use for "did not run". Exit 2 is the ABSENCE of a result, never a clean
// one — a caller that treats non-zero as "findings" must not collapse 1 and 2.
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(
    `scan-synced-disclosure: --root does not exist or is not a directory (the path is not echoed: an ` +
      `absolute path carries /Users/<operator>/)`,
  );
  console.error(
    `  The scan DID NOT RUN. Exit 2 is the absence of a result, not a clean result.`,
  );
  process.exit(2);
}
// The second guard keys on a STRUCTURAL fact about the root — does it carry any
// synced surface at all — NOT on `files.length === 0` after filtering. That
// distinction is load-bearing: `sync-preserve-local-skipped` and
// `excluded-accepted-history` legitimately enumerate to ZERO files because the
// exclusion rules they exist to test skip their only content, and a naive
// post-filter zero-check reds both (measured: it did). A root with no `.claude/`
// and no top-level synced path is a DIFFERENT thing — a wrong root, where a
// "clean" verdict describes nothing.
if (
  !isPresentPath(path.join(root, ".claude")) &&
  ![...TOP_LEVEL_SYNCED, ...TOP_LEVEL_SYNCED_DIRS].some((t) => isPresentPath(path.join(root, t)))
) {
  console.error(
    `scan-synced-disclosure: no synced surface under <scan-root> — no .claude/ and no top-level synced path`,
  );
  console.error(
    `  The scan DID NOT RUN against a repo checkout. Exit 2 is the absence of a result, not a clean result.`,
  );
  process.exit(2);
}
// ── CRASH FENCE — an exception during the scan is NOT a finding ─────────────
//
// MEASURED on this tree before this fence existed: a `TypeError` thrown inside
// `scanFile` exited **1** against a fixture with ZERO findings — byte-identical
// to the `--check` FINDINGS exit below. A crashed scan and a scan that found a
// leak were therefore indistinguishable to every caller keying on the exit code.
// That is the non-discriminating-instrument class `instrument-discipline.md`
// MUST-1 blocks: one exit consistent with BOTH "found a leak" and "never
// looked". The falsifying result, had they already been distinguishable, would
// have been any non-1 code from that induced crash; it was 1.
//
// Exit 3 is minted rather than reusing 1 or 2. 1 is the only code that ASSERTS
// a leak, so a crash must never borrow it. 2 is "did not START" — every site
// that emits it fires BEFORE a single file is read and names an actionable
// INPUT defect (bad arg, bad root, malformed denylist), so folding an internal
// fault into it would send triage hunting for an operator typo. A crash is a
// fourth outcome: STARTED, did not COMPLETE, surface only PARTIALLY examined.
//
// The diagnostic deliberately carries NO `[SHAPE:` token. `clean-instantiate.mjs`
// discriminates a finding from a did-not-complete by grepping the captured
// output for that marker, so emitting one here would re-forge the collision at
// the caller.
// Absolute paths in free text (a crash stack, an error message from a library) become
// ROLE labels: the scan root, this checkout, and the home directory. The output of this
// tool is documented as safe to paste; an absolute path is `/Users/<operator>/`.
function redactPaths(text) {
  let t = String(text);
  const pairs = [
    [path.resolve(REPO_ROOT_ACTIVE), "<scan-root>"],
    [path.resolve(REPO_ROOT), "<scanner-checkout>"],
    // The scanner's OWN directory too: a crash trace names this file's frames, and a copy
    // run from outside any checkout (measured: `/tmp/<dir>/` on a Linux host, where the
    // derived checkout root collapses to `/` and is skipped) printed its absolute path.
    [SCRIPT_DIR, "<scanner-dir>"],
    [os.homedir(), "~"],
  ].sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of pairs) if (from && from.length > 1) t = t.split(from).join(to);
  return t;
}

// A RegExp error ("Invalid regular expression: /…/", "Regular expression too large") embeds
// the pattern SOURCE, and the identity shapes' sources ARE the roster and denylist tokens:
// its message is withheld, only its kind is printed. ONE predicate for BOTH error exits — the
// crash fence below and the config-loading refusal (exit 2) — which used to print
// `e.message` unfiltered (item 7, 2026-09-27; pinned by a preload that raises such an error
// from inside shape loading).
function isRegExpError(e) {
  return Boolean(e && /regular expression/i.test(String(e.message || "")));
}
function withheldRegExpText(e) {
  return `${(e && e.name) || "Error"}: regular-expression error (message withheld: it embeds identity tokens)`;
}

function scanDidNotComplete(phase, e) {
  console.error("");
  console.error(
    `scan-synced-disclosure: FATAL — the scan DID NOT COMPLETE (phase: ${phase}).`,
  );
  const trace = isRegExpError(e) ? withheldRegExpText(e) : e && e.stack ? e.stack : String(e);
  console.error(`  ${redactPaths(trace)}`);
  console.error(
    `  Disclosure status is UNKNOWN. This is NOT a clean result and NOT a finding:`,
  );
  console.error(
    `  the scanner failed mid-run, so the synced surface was only PARTIALLY examined.`,
  );
  console.error(
    `  Exit 3 = crashed scan. Do NOT read it as "0 findings"; do NOT distribute on it.`,
  );
  process.exit(3);
}

let files;
try {
  files = collectFiles(root); // sets REPO_ROOT_ACTIVE
} catch (e) {
  scanDidNotComplete("file collection", e);
}
// Build the loom-only customer-identity shape from the tenant denylist at
// the SCANNED root (inert when absent; throws loud on a malformed file so
// the guard never silently disables itself).
let customerShape;
let operatorShape;
let receiptPayloadShape;
try {
  customerShape = loadCustomerIdentityShape(REPO_ROOT_ACTIVE);
  // Own operator identity from the roster (scanned root ∪ this checkout); throws
  // loud on a malformed roster rather than silently scanning without it.
  operatorShape = loadOperatorIdentityShape(REPO_ROOT_ACTIVE);
  // #1330: own-org set derived from the D6 registry at the scanned root;
  // throws loud on a present-but-unparseable ecosystem.json.
  receiptPayloadShape = loadReceiptPayloadShape(REPO_ROOT_ACTIVE);
} catch (e) {
  console.error(`scan-synced-disclosure: ${isRegExpError(e) ? withheldRegExpText(e) : redactPaths(e.message)}`);
  process.exit(2);
}
const activeShapes = [
  ...SHAPES,
  ...(customerShape ? [customerShape] : []),
  ...(operatorShape ? [operatorShape] : []),
  receiptPayloadShape,
];
// Mask EVERY active shape's spans, not only the identity shapes: a finding's ±20-char window
// otherwise printed a neighbouring flagged token in clear (a third-party org, a hostname, a
// runner label). Over-masking an allowlisted span is harmless; under-masking is the leak.
for (const sh of activeShapes) {
  if (sh && sh.foldRx) {
    sh.foldRxG = new RegExp(sh.foldRx.source, sh.foldRx.flags.includes("g") ? sh.foldRx.flags : sh.foldRx.flags + "g");
    FOLD_MASK_SHAPES.push(sh);
  }
  if (sh && sh.rx) {
    const src = sh.maskRx || sh.rx;
    CONTEXT_MASK_RXS.push({
      rx: new RegExp(src.source, src.flags.includes("g") ? src.flags : src.flags + "g"),
      overlapping: OVERLAPPING_SHAPES.has(sh.id),
      extend: sh.maskExtend || null,
    });
  }
}
const findings = [];
const stats = { unread: [] };
try {
  for (const f of files)
    scanFile(f, findings, activeShapes, args.allowSyntheticFixtureHomes, stats);
  // Directory NAMES that never yield a collected file — an unreadable directory — are
  // path-checked here; every other directory name is covered by the files beneath it.
  for (const d of unreadDirs) {
    scanPathForIdentity(path.relative(REPO_ROOT_ACTIVE, d).split(path.sep).join("/"), findings, activeShapes);
    scanPathForStructure(d, findings, activeShapes, args.allowSyntheticFixtureHomes);
  }
  for (const d of directoryLinks) {
    const rel = path.relative(REPO_ROOT_ACTIVE, d);
    scanPathForIdentity(rel.split(path.sep).join("/"), findings, activeShapes);
    scanPathForStructure(d, findings, activeShapes, args.allowSyntheticFixtureHomes);
    let t = null;
    try {
      t = fs.readlinkSync(d);
    } catch {
      /* raced away — the walk already named it */
    }
    if (t !== null) scanLines(rel, path.basename(d), [t], findings, activeShapes, args.allowSyntheticFixtureHomes, () => 0);
  }
} catch (e) {
  // Partial `findings` are deliberately DISCARDED rather than reported: a
  // truncated finding list read as the whole verdict is the same false-clean
  // this fence exists to close (§ CRASH FENCE above).
  scanDidNotComplete("file scanning", e);
}

// EXAMINED = collected minus the ones that could not be read. Every receipt below
// reports THIS, never `files.length`. The unread list is surfaced alongside it so
// the blind class is NAMED rather than silently absorbed into the scanned count
// (`instrument-discipline.md` MUST-3(b) — read the hits, and name what the
// instrument could not see). Deliberately NOT an exit-code change: whether an
// unreadable file is a FINDING is a separate design question with caller impact,
// left open here rather than decided as a side effect of fixing the receipt.
const examined = files.length - stats.unread.length;
// Unreadable DIRECTORIES are named with the unread files but never subtracted from the file
// count: they were never collected (counting them gave `Scanned: -1 files`, measured).
const unreadAll = () => [...stats.unread, ...unreadDirs];
const unreadReceipt = () => {
  const all = unreadAll();
  const shown = all.slice(0, 10).map((f) => `  - ${shownPath(path.relative(root, f))}`);
  const more = all.length > shown.length ? `\n  … and ${all.length - shown.length} more` : "";
  return (
    `UNREAD: ${stats.unread.length} collected file(s) and ${unreadDirs.length} director(y/ies) could NOT be read and were NOT examined.\n` +
    `  They are EXCLUDED from the scanned count above — no verdict covers them:\n` +
    shown.join("\n") +
    more
  );
};

// A symlinked DIRECTORY that was NOT descended is a blind class of its own, and
// a LOUDER one than UNREAD: UNREAD names a single file nothing opened, while
// this names a whole SUBTREE nothing enumerated — the count of files behind it
// is not merely unexamined, it is unknown. Reported on its own line, and
// deliberately NOT an exit-code change, on the same reasoning recorded for
// UNREAD above: whether an unexamined subtree is itself a FINDING is a design
// question with caller impact, left open rather than decided as a side effect of
// fixing the receipt.
const undescendedReceipt = () => {
  const shown = undescendedLinks
    .slice(0, 10)
    .map((d) => `  - ${shownPath(d.rel)}  (${d.why})`);
  const more =
    undescendedLinks.length > shown.length
      ? `\n  … and ${undescendedLinks.length - shown.length} more`
      : "";
  return (
    `UNDESCENDED: ${undescendedLinks.length} symlinked director(y/ies) were NOT walked.\n` +
    `  No file beneath them was collected or examined — no verdict covers that subtree:\n` +
    shown.join("\n") +
    more
  );
};

if (args.mode === "check") {
  if (findings.length > 0) {
    console.error(
      `scan-synced-disclosure: ${findings.length} disclosure finding(s) on the synced surface`,
    );
    for (const f of findings) {
      console.error(`  ${shownPath(f.path)}:${f.line}:${f.col}  [SHAPE:${f.shape}]  ${f.context}`);
    }
    // Named even on the findings path: the finding list is not the whole verdict
    // if part of the surface was never opened.
    if (unreadAll().length) console.error(unreadReceipt());
    if (undescendedLinks.length) console.error(undescendedReceipt());
    process.exit(1);
  }
  // The clean receipt is DISCRIMINATING: it names how many files were examined,
  // so a caller reading a 0 exit can tell a real clean scan from a scan of
  // nothing. Before this line, check-mode's clean path printed nothing at all.
  //
  // The count is EXAMINED, not COLLECTED. It previously reported `files.length`,
  // which includes files `scanFile` could not read — so the receipt vouched for
  // bytes nothing had looked at, and a root of entirely unreadable files printed
  // a confident clean. Unread files are named on their OWN line rather than
  // folded into this one, so a reader cannot mistake them for examined content.
  console.log(`Scanned: ${examined} files on the synced surface — 0 findings`);
  if (unreadAll().length) console.log(unreadReceipt());
  if (undescendedLinks.length) console.log(undescendedReceipt());
  process.exit(0);
}

// human report
console.log(`Synced-Artifact Disclosure Scan (issue #263)`);
console.log(`Root:    <scan-root>`);
console.log(`Scanned: ${examined} files on the synced surface`);
if (unreadAll().length) console.log(unreadReceipt());
if (undescendedLinks.length) console.log(undescendedReceipt());
console.log("");
if (findings.length === 0) {
  console.log(
    `RESULT: clean — 0 findings. This is the structural receipt that the`,
  );
  console.log(`        #252 disclosure forest is closed on this surface.`);
  process.exit(0);
}
console.log(`RESULT: ${findings.length} finding(s) — synced surface NOT clean`);
console.log("");
const byShape = {};
for (const f of findings) {
  byShape[f.shape] = (byShape[f.shape] || 0) + 1;
  console.log(`  ${shownPath(f.path)}:${f.line}:${f.col}  [SHAPE:${f.shape}]  ${f.context}`);
}
console.log("");
console.log(`=== Summary ===`);
for (const [id, n] of Object.entries(byShape).sort()) {
  console.log(`  ${id}: ${n}`);
}
console.log(`  TOTAL: ${findings.length}`);
console.log("");
console.log(
  `Resolve each by genericizing the disclosure + relocating it to the`,
);
console.log(
  `operator-local companion (per the #255 / #260 pattern), then re-run.`,
);
console.log(
  `Do NOT widen the allowlist to swallow a real token — that re-opens #252.`,
);
process.exit(0);
