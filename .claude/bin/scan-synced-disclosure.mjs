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
 *  Exit codes: 0 = clean (no findings); 1 = ≥1 finding in --check mode;
 *              2 = usage error.
 *
 *  Findings NEVER print the raw matched token. Every line is rendered as
 *    path:line  [SHAPE:<id>]  <±20-char context, token → «REDACTED»>
 *  so the scanner's own output is safe to paste anywhere.
 * ============================================================================
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { SYNTHETIC_FIXTURE_USERS } from "./lib/identity-scrub.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

// ────────────────────────────────────────────────────────────────
// CLI args
// ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { mode: "report", root: null, allowSyntheticFixtureHomes: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") args.mode = "check";
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--root") args.root = argv[++i];
    // OPT-IN (client-template disclosure gate ONLY): tolerate a SYNTHETIC fixture home
    // (a `jdoe`/`fakeuser`-style `/Users/<name>/` in the SYNTHETIC_FIXTURE_USERS set) inside a
    // `*.test.mjs` / `*.test.js` fixture. The client-template edition ships loom's OWN
    // disclosure-detector fixtures with those homes PRESERVED verbatim (loom#1318) so they
    // still fire in a repo instantiated from the seed; a REAL operator home (username NOT in
    // the set) in ANY file — and a synthetic home in a NON-test file — still flags. DEFAULT
    // OFF, so a generic consumer-destination scan (and the `test-mjs-destination-flip`
    // regression lock) is byte-identical.
    else if (a === "--allow-synthetic-fixture-homes") args.allowSyntheticFixtureHomes = true;
    else {
      console.error(`scan-synced-disclosure: unknown argument: ${a}`);
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
// NOT imported from `community-membership.mjs`, deliberately: THIS FILE SHIPS (measured — it
// is a `dest` in the py plan), and that module is `loom_only`, so importing it would be
// ERR_MODULE_NOT_FOUND for every consumer — the exact broken-on-import class
// `community-import-closure.test.mjs` refuses. The two lists are instead pinned in step
// mechanically by `disclosure-scan-surface-parity.test.mjs`, the same literal-plus-parity-test
// shape `coc-artifact-eval.yml`'s ARTIFACT_SURFACE uses against its `push:` paths.
const TOP_LEVEL_SYNCED_DIRS = [
  ".codex",
  ".gemini",
  ".codex-mcp-guard",
  "scripts",
  "tools",
];

// `tests` IS an INCLUDE root — it is published — and is DELIBERATELY NOT walked here. This
// is a deferral with a stated reason, not an oversight, and the parity test below asserts
// the exclusion is declared rather than forgotten.
//
// MEASURED: walking it yields 21 findings across four files, and 19 of them are BY DESIGN.
// `tests/integration/multi-operator/eco-cross-ecosystem-disclosure-guard.test.js` exists to
// exercise the cross-ecosystem disclosure guard, so it necessarily embeds the very shapes
// this scanner hunts — 16 `acme-corp`-family org slugs and a homograph/ZWSP hostname case.
// Those are not leaks; `acme-corp/kailash-sdk` is the canonical MUST-FLAG example in this
// file's own shape commentary, which is exactly why it cannot be allowlisted away.
//
// The sibling precedent does not transfer cleanly, and that is the whole difficulty. Loom's
// `*.test.mjs` fixtures get a SOURCE-ONLY skip (see isExcluded) on the reasoning that their
// synthetic shapes are by-design; but those files are ALSO manifest-`exclude:`d, so they
// never reach a consumer. `tests/**` is PUBLISHED, so a blanket source-only skip here would
// let a genuine leak ship unflagged — which is not a hypothetical: this sweep found a REAL
// operator username (not a member of SYNTHETIC_FIXTURE_USERS) in
// `m9-1-fix-wave-regression.test.js`, genericized in the same change that added this note.
//
// Reconciling those two — fence `tests/` from publication, split fixtures from assertions,
// or add a synthetic-fixture policy for published tests — is a real design decision about a
// PUBLIC surface, with more than one defensible answer. It is left to a change that can be
// reviewed on its own terms rather than settled as a side effect of widening a walk. Landing
// it silently either way would be the worse outcome: including `tests/` as-is would red this
// scanner's own CI gate on every run, which is how a gate gets switched off.

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
function isNeverSynced(relPath, base, segs) {
  // .claude/ prefix is optional depending on scan root
  const p = relPath.replace(/^\.claude\//, "");
  const pSegs = p.split("/");
  if (pSegs[0] === "learning") return true;
  if (pSegs[0] === ".proposals") return true;
  if (pSegs[0] === "test-harness") return true;
  if (pSegs[0] === "projects") return true;
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
  // 2026-08-16: `sync-manifest.yaml` is NO LONGER skipped. The blanket skip
  // rested on a FALSE premise ("it never leaves this repo"). The manifest IS
  // distributed — `multi_cli_overlays.multi-cli.manifest_distribute: true`
  // (issue #184) is a deliberate carve-out FROM the global
  // `exclude: sync-manifest.yaml` rule — agent-prose `cp` at coc-sync Step 4.6
  // until loom#1777 moved it into the engine
  // (`sync-tier-aware.mjs::emitSyncManifest`). EITHER WAY the copy bypasses the
  // tier-lane copy loop, so `stripBuildInternalReferences` NEVER runs on it —
  // the engine emit is a VERBATIM byte copy, which is the point (the consumer's
  // emitter must read the same declarations loom did). The manifest reaches
  // every multi-CLI USE template with ZERO content transform. Those
  // templates are PUBLIC by design. So the one artifact shipping untransformed
  // to public consumers was the one file the scanner was hardcoded never to
  // inspect. It is therefore SCANNED. (cc-only templates do not receive it —
  // `clis:` derives template_type — but "reaches fewer consumers" is not
  // "reaches none".) Same correction, same reason, as the F77 (#386)
  // settings.json removal from this list a few lines below.
  if (base === "VERSION") return true;
  if (base === "CLAUDE.md") return true;
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
function isExcluded(relPath) {
  const segs = relPath.split("/");
  const base = segs[segs.length - 1];

  // .git and the scanner's own file
  if (segs[0] === ".git" || segs.includes(".git")) return true;
  if (path.resolve(REPO_ROOT_ACTIVE, relPath) === SCRIPT_PATH) return true;
  if (base === "scan-synced-disclosure.mjs") return true;
  // The loom-only tenant denylist (journal/0214) carries the literal
  // customer-identity tokens the `customer-identity-token` shape flags.
  // It MUST NOT be scanned-as-content (its own tokens would self-flag) and
  // it is never synced (sync-manifest.yaml `loom_only:`). Same self-exclude
  // pattern as the scanner's own file above.
  if (base === "disclosure-tenant-denylist.json") return true;
  // The #1068 benign-collision registry carries the literal tenant token in its
  // `token` field by design (it records which (token, host) substring collisions are
  // benign, e.g. a short token inside `HttpClient`). Identical self-flag / never-synced
  // (sync-manifest.yaml `loom_only:`) class as the denylist above — self-exclude so its
  // own legitimate tokens do not self-flag (preserving zero-findings-on-main).
  if (base === "disclosure-benign-collisions.json") return true;
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

  // This scanner's OWN audit fixtures intentionally embed SYNTHETIC
  // disclosure shapes (invented `acme-*` / `Fakename-*` / `fakeuser`
  // tokens) to prove the shapes fire — exactly like
  // audit-fixtures/violation-patterns/ holds intentional bad inputs.
  // Excluded from the loom-default scan so the by-design synthetic
  // tokens are not counted as residuals. NOTE: this is keyed on the
  // loom-relative path, so it does NOT fire when the fixture runner
  // points `--root` AT a fixture (relPath is then fixture-root-relative
  // and the runner's whole purpose is to scan those planted shapes).
  if (relPath.includes("audit-fixtures/scan-synced-disclosure")) return true;

  // ALLOWLIST-NOTE (#584 follow-up): the cross-ecosystem-disclosure-guard
  // audit fixtures intentionally embed SYNTHETIC canon/fork org slugs
  // (`ssh://canon/loom.git`, `canon-origin`) to exercise the guard's own
  // boundary recognition — `canon` is the architectural placeholder for the
  // canonical upstream (artifact-flow.md § "Ecosystem Forks vs Downstream
  // Consumers"), NOT a real org slug. The `nonfoundation-org-slug` shape
  // over-matches that synthetic token, exactly the by-design-synthetic case
  // the scan-synced-disclosure exclusion above covers. Same loom-relative-path
  // keying: it does NOT fire when the guard's own fixture runner points
  // `--root` AT the fixture dir (relPath then fixture-root-relative). #584
  // landed these fixtures without extending this exclusion; this closes the gap.
  if (relPath.includes("audit-fixtures/cross-ecosystem-disclosure-guard"))
    return true;

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
  if (/^SWEEP-.*\.md$/.test(base)) return true;
  if (segs.slice(0, -1).some((s) => s === "journal")) return true;
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
  // (the fix). Same shape as the `*.local.json` flip below, but via the
  // authoritative git-tracking signal instead of the root-identity proxy.
  if (
    /\.operator\.local\.md$/.test(base) &&
    !isGitTracked(REPO_ROOT_ACTIVE, relPath)
  )
    return true;
  if (/\.local\.json$/.test(base) && REPO_ROOT_ACTIVE === REPO_ROOT) return true;
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
  if (isNeverSynced(relPath, base, segs)) return true;

  return false;
}

function isProbablyBinary(buf) {
  // NUL byte in the first 8KB → treat as binary, skip.
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function walk(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(REPO_ROOT_ACTIVE, full);
    if (isExcluded(rel)) continue;
    if (e.isDirectory()) {
      walk(full, acc);
    } else if (e.isFile() || e.isSymbolicLink()) {
      acc.push(full);
    }
  }
}

function collectFiles(root) {
  REPO_ROOT_ACTIVE = path.resolve(root);
  const files = [];
  const claudeDir = path.join(REPO_ROOT_ACTIVE, ".claude");
  if (fs.existsSync(claudeDir)) walk(claudeDir, files);
  // Top-level distributed DIRECTORIES (see TOP_LEVEL_SYNCED_DIRS for the derivation).
  // `walk` applies the same per-file exclusions the `.claude/` walk gets, so a never-synced
  // path under one of these roots is skipped by exactly the rules that skip it under
  // `.claude/` — one exclusion mechanism, not a second one that could drift.
  for (const top of TOP_LEVEL_SYNCED_DIRS) {
    const p = path.join(REPO_ROOT_ACTIVE, top);
    if (fs.existsSync(p) && !isExcluded(top)) walk(p, files);
  }
  for (const top of TOP_LEVEL_SYNCED) {
    const p = path.join(REPO_ROOT_ACTIVE, top);
    if (fs.existsSync(p) && !isExcluded(top)) files.push(p);
  }
  return files;
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
  // anchors to the EXACT own Docker org (mirrors the `esperie-enterprise` entry's
  // anchoring): a typosquat `terrenefoundation-evil/loom` no longer matches the
  // allowlist and is still flagged by the nonfoundation-org-slug shape.
  /terrenefoundation(?![\w-])(\/[A-Za-z0-9._-]+)?/i,
  // ALLOWLIST-NOTE: `esperie-enterprise` is loom's own GitHub host org
  // per co-owner Option-1 ruling 2026-05-17 (#263); self-coordinates,
  // not a client/3rd-party disclosure. The scanner still flags genuine
  // non-own, non-Foundation org slugs. Covers both the bare org token
  // and `esperie-enterprise/<repo>` self-references (the same shape as
  // the Foundation entry above). R2 SECURITY-FIX (#263): the prior
  // entry's stem was UNANCHORED — `esperie-enterprise-evil/loom` and
  // `gh api repos/esperie-enterprise-evil/kailash-py` were SUPPRESSED
  // (a typosquat org leaked silently). The trailing `(?![\w-])`
  // non-word/non-hyphen boundary anchors the allowlist to the EXACT
  // own org: `esperie-enterprise` and `esperie-enterprise/<repo>`
  // stay clean; `esperie-enterprise-evil/loom` no longer matches the
  // allowlist and is flagged by the nonfoundation-org-slug shape.
  /esperie-enterprise(?![\w-])(\/[A-Za-z0-9._-]+)?/i,
  // ALLOWLIST-NOTE: loom maintainer's own dev-home-path prefixes
  // (`/Users/esperie/` and `/home/esperie/`) are self-coordinates under
  // the Option-1 ruling 2026-05-17 (#263) — they appear in teaching /
  // doc / posture-report examples as the maintainer's own checkout root,
  // not a client or third-party operator identifier. This is the
  // specific own-dev-path username only, NOT a blanket `/Users/*` allow:
  // a *different* operator's home path (`/Users/<other>/`) carries a
  // different username, fails this anchored prefix, and is still flagged
  // by the operator-home-path shape.
  //
  // SURFACE SCOPE (GAP D, ratified 2026-07-26): the Option-1 own-coordinate
  // ruling covers the INSTANTIATION surface as well as the SYNC surface. A
  // client-template edition or a fresh clone generated FROM this checkout is a
  // publish event in the same sense a sync is (`artifact-flow.md` § "The source
  // of instantiation MUST be clean at rest"), so the same own-coordinate
  // reasoning applies there and needs no separate ruling. What that does NOT
  // license: the allowance stays scoped to the maintainer's OWN dev-home
  // prefix on both surfaces — an instantiation carrying a DIFFERENT operator's
  // home path is flagged on the instantiation surface exactly as on the sync
  // surface.
  /\/Users\/esperie\//,
  /\/home\/esperie\//,
  // R2 detection-completeness FIX (#263): each SDK-repo-name allowlist
  // entry carries a `(?<![\w-]\/)` negative-lookbehind so it covers a
  // BARE SDK reference (`pip install kailash-py`, "the kailash-rs repo",
  // `kailash-dataflow` node) but NOT an `<org>/kailash-*` org-slug span
  // (`globex/kailash-py`, `github.com/acme/kailash-rs`). The prior
  // unanchored entries swallowed `globex/kailash-py`, silently
  // suppressing must-fix #1's `<org>/kailash-*` detection. Own/Foundation
  // `<org>/kailash-*` spans are covered by the anchored own-org /
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
  //      shape. Own/Foundation `terrene-foundation/kailash-sdk` stays
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
  /\/Users\/runner\//,
  /\/(?:Users|home)\/me\//,
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
  /\/home\/dev\//,
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
  /\/home\/vscode\//,
  // ALLOWLIST-NOTE: a `/Users/<PascalCase>/` span (e.g. `/Users/Items/`
  // from the `mockData/Users/Items/Records/Response*` glob comment in
  // validate-workflow.js) is a fake-data FIELD-NAME path, not a home
  // path. macOS account usernames are lowercase by convention; a
  // Capital-then-lowercase segment immediately under /Users/ is the
  // structural tell of a fake-data path token, never an operator home.
  // Real operator homes (`/Users/<lowercase-operator>/`) are NOT
  // covered — they fail the leading-uppercase requirement.
  /^\/Users\/[A-Z][a-z]+\/$/,
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

// ────────────────────────────────────────────────────────────────
// STRUCTURAL DISCLOSURE SHAPES
// ────────────────────────────────────────────────────────────────
//
// Each shape: { id, rx }. A line flags when rx matches AND the matched
// substring is not covered by the allowlist. `rx` carries the global
// flag so we can enumerate every match on a line.
//
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
    // The leading `(?!…esperie-enterprise|terrene-foundation…)`
    // negative-lookahead is intentionally NOT relied on for own/Foundation
    // suppression — the positive ALLOWLIST (anchored, see Fix 2) is the
    // single source of own/Foundation suppression and covers the matched
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
    // `globex/kailash-py`, `initech/coc-sync`. Own/Foundation orgs
    // (`esperie-enterprise/loom`, `terrene-foundation/loom`) DO match
    // the shape here but are suppressed by the anchored ALLOWLIST.
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
    //      slug is the segment after `orgs/`; Foundation/own orgs match
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
    //      reference in prose or an `#N` issue-ref. Own/Foundation orgs
    //      match here too but are suppressed by the anchored ALLOWLIST.
    // The `-enterprise` alternative captures the FULL org token
    // INCLUDING any trailing `-<suffix>` segments (`esperie-enterprise-evil`,
    // `nexus-enterprise-evil`) so the SPAN handed to allowlistCovers() is
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
    // `test/`,`refactor/`,`style/`) OR a URL scheme (`<scheme>://`) —
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
    // passes WITH this alt live (the `nonown-org-slug-smuggle`
    // fixture locks the closed disposition). Own/Foundation orgs that
    // appear in a branch/scheme context match here too but are
    // suppressed by the anchored ALLOWLIST, identical to the other
    // four alternatives. Disposition: CLOSED (not documented-residual).
    id: "nonfoundation-org-slug",
    rx: /\b[a-z][a-z0-9-]*-enterprise(?:-[a-z0-9]+)*\b|(?:git@github\.com:|github\.com[:/]|gh api repos\/|--repo\s+)[a-z][a-z0-9-]{2,}\/(?:loom|kailash[a-z0-9-]*|coc[a-z0-9-]*|atelier)[a-z0-9._-]*(?:#\d+)?|gh api orgs\/[a-z][a-z0-9-]{2,}\b|(?<![\w./-])(?!(?:loom|kailash[a-z0-9-]*|coc[a-z0-9-]*|atelier|repos|agents|skills|commands|rules|bin|lib|hooks|guides|variants|specs|chore|csq|workspaces|feat|fix|docs|test|refactor|style|src|packages|pkg|pkgs|tests|crates|ext|cmd|internal|node_modules|dist|build|target|bindings|ffi|python|java|deployment|localhost|service|statefulset|daemonset|pod|svc|refs(?=\/))\b)[a-z][a-z0-9-]{2,}\/(?:loom|kailash[a-z0-9-]*|coc[a-z0-9-]*|atelier)(?:#\d+)?\b|(?:\b(?:chore|feat|fix|release|docs|test|refactor|style)\/|[a-z][a-z0-9+.-]*:\/\/)(?!(?:loom|kailash[a-z0-9-]*|coc[a-z0-9-]*|atelier|repos|agents|skills|commands|rules|bin|lib|hooks|guides|variants|specs|chore|csq|workspaces|feat|fix|docs|test|refactor|style|src|packages|pkg|pkgs|tests|crates|ext|cmd|internal|node_modules|dist|build|target|bindings|ffi|python|java|deployment|localhost|service|statefulset|daemonset|pod|svc|refs(?=\/))\b)[a-z][a-z0-9-]{2,}\/(?:loom|kailash[a-z0-9-]*|coc[a-z0-9-]*|atelier)(?:#\d+)?\b/g,
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
    rx: /\/Users\/(?!\.\.\.|<)[A-Za-z][\w.-]+\/|\/home\/(?!<)[A-Za-z][\w.-]+\//g,
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
    // `/Users/esperie/` is wrong INSIDE a `permissions.*` matcher in a
    // synced settings.json (the matcher should be relative or
    // `$CLAUDE_PROJECT_DIR`-rooted). The shape deliberately does NOT
    // intersect the allowlist (allowlistCovers is keyed to the matched
    // SPAN, and the span here is the WHOLE matcher token; no
    // Option-1 allowlist entry covers a tool-call-matcher span).
    // Foundation-public placeholder `$CLAUDE_PROJECT_DIR` and relative
    // paths do not match the shape's leading `(/` anchor — they stay
    // clean.
    id: "settings-permission-absolute-path",
    rx: /"(?:Edit|Write|Read|Bash|MultiEdit|Glob|Grep|NotebookEdit)\((\/(?:Users|home)\/[^"\)]+)\)"/g,
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
    id: "ecosystem-bare-org-slug",
    fileScope: /^ecosystem.*\.json$/,
    rx: /"(?:org|host)"\s*:\s*"[a-z][a-z0-9-]{2,}"/g,
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

// Build the `customer-identity-token` SHAPE from the loom-only tenant
// denylist at `rootActive`, or return null when the file is absent / empty
// (the inert consumer/fixture case). A PRESENT-but-unparseable file throws
// — a guard that silently disables itself on a typo is worse than no guard.
function loadCustomerIdentityShape(rootActive) {
  const p = path.join(rootActive, TENANT_DENYLIST_REL);
  if (!fs.existsSync(p)) return null; // inert: no tenant list at this root
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(
      `disclosure-tenant-denylist.json present but unparseable at ${p}: ` +
        `${e.message} (refusing to run a silently-disabled tenant guard)`,
    );
  }
  const tokens = Array.isArray(parsed && parsed.tokens)
    ? parsed.tokens.filter((t) => typeof t === "string" && t.trim())
    : [];
  if (tokens.length === 0) return null; // inert: empty list
  const alt = tokens.map((t) => `\\b${escapeForRegex(t)}\\b`).join("|");
  return { id: "customer-identity-token", rx: new RegExp(alt, "gi") };
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
  if (!fs.existsSync(p)) return orgs;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(
      `ecosystem.json present but unparseable at ${p}: ${e.message} ` +
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
function redactContext(line, matchStart, matchText) {
  const matchEnd = matchStart + matchText.length;
  const ctxStart = Math.max(0, matchStart - 20);
  const ctxEnd = Math.min(line.length, matchEnd + 20);
  const before = line.slice(ctxStart, matchStart);
  const after = line.slice(matchEnd, ctxEnd);
  const lead = ctxStart > 0 ? "…" : "";
  const trail = ctxEnd < line.length ? "…" : "";
  return `${lead}${before}«REDACTED»${after}${trail}`
    .replace(/\s+/g, " ")
    .trim();
}

function scanFile(file, findings, shapes, allowSyntheticFixtureHomes = false) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return;
  }
  if (isProbablyBinary(buf)) return;
  const rel = path.relative(REPO_ROOT_ACTIVE, file);
  const base = path.basename(file);
  // client-template gate opt-in: a SYNTHETIC fixture home inside a *.test.(mjs|js) fixture is
  // PRESERVED verbatim by that projection's scrubber (loom#1318) and is benign here. Scoped to
  // test files so a synthetic-looking home in a NON-test shipped file still flags; scoped to the
  // shared SYNTHETIC_FIXTURE_USERS set so a REAL operator home still flags (dual-half parity).
  const testFixtureFile = allowSyntheticFixtureHomes && /\.test\.(mjs|js)$/.test(base);
  const text = buf.toString("utf8");
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    for (const shape of shapes) {
      // A shape may declare `fileScope` (a basename regex); it then applies
      // ONLY to matching files. File-scoped shapes (e.g. the ecosystem
      // bare-org-slug shape) avoid flooding every repo-wide JSON value.
      if (shape.fileScope && !shape.fileScope.test(base)) continue;
      // A shape may declare `pathScope` (a repo-relative-path regex); it
      // then applies ONLY to files whose `rel` path matches. The
      // cross-repo-authz receipt-payload shape (#1330) uses this to fire
      // ONLY on receipt FILES inside a `cross-repo-authz/` directory — never
      // on a doc/journal/proposal that merely quotes the marker in prose,
      // which is a different file class and would false-positive.
      if (shape.pathScope && !shape.pathScope.test(rel)) continue;
      shape.rx.lastIndex = 0;
      let m;
      while ((m = shape.rx.exec(line)) !== null) {
        const matchText = m[0];
        if (m.index === shape.rx.lastIndex) shape.rx.lastIndex++;
        // Opt-in synthetic-fixture-home tolerance (client-template gate): skip an
        // operator-home-path span in a *.test.(mjs|js) fixture whose username is in the shared
        // synthetic set (loom#1318). A real username fails the set → still flagged.
        if (testFixtureFile && shape.id === "operator-home-path") {
          const uname = (matchText.match(/\/(?:Users|home)\/([\w.-]+)/) || [])[1];
          if (uname && SYNTHETIC_FIXTURE_USERS.has(uname.toLowerCase())) continue;
        }
        // F77 (#386): the settings-permission-absolute-path shape is
        // INTRINSICALLY wrong regardless of which operator's path it
        // wraps — a tool-call matcher in a synced settings.json's
        // `permissions.*` array MUST NOT carry an absolute filesystem
        // path even if the path's operator-stem is the maintainer's own
        // Option-1 self-coordinate. Skip the allowlist suppression for
        // this shape so own-coordinate `/Users/esperie/` tokens inside
        // an `Edit(...)` matcher still flag. Every other shape retains
        // the Option-1 allowlist semantics unchanged.
        // The cross-repo-authz-receipt-payload shape (#1330) is also skipped
        // here: its own OWN-ORG negative-lookahead (derived from
        // ecosystem.json) is the SOLE suppression mechanism, so the generic
        // ALLOWLIST must NOT additionally suppress a foreign-org receipt that
        // happens to embed a placeholder-shaped token (fail-closed toward
        // flagging), exactly as the customer-identity-token shape self-governs.
        if (
          shape.id !== "settings-permission-absolute-path" &&
          shape.id !== "customer-identity-token" &&
          shape.id !== "cross-repo-authz-receipt-payload" &&
          allowlistCovers(matchText)
        )
          continue;
        findings.push({
          path: rel,
          line: i + 1,
          shape: shape.id,
          context: redactContext(line, m.index, matchText),
        });
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv);
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
    `scan-synced-disclosure: --root does not exist or is not a directory: ${root}`,
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
  !fs.existsSync(path.join(root, ".claude")) &&
  !TOP_LEVEL_SYNCED.some((t) => fs.existsSync(path.join(root, t)))
) {
  console.error(
    `scan-synced-disclosure: no synced surface under ${root} — no .claude/ and no top-level synced path`,
  );
  console.error(
    `  The scan DID NOT RUN against a repo checkout. Exit 2 is the absence of a result, not a clean result.`,
  );
  process.exit(2);
}
const files = collectFiles(root); // sets REPO_ROOT_ACTIVE
// Build the loom-only customer-identity shape from the tenant denylist at
// the SCANNED root (inert when absent; throws loud on a malformed file so
// the guard never silently disables itself).
let customerShape;
let receiptPayloadShape;
try {
  customerShape = loadCustomerIdentityShape(REPO_ROOT_ACTIVE);
  // #1330: own-org set derived from the D6 registry at the scanned root;
  // throws loud on a present-but-unparseable ecosystem.json.
  receiptPayloadShape = loadReceiptPayloadShape(REPO_ROOT_ACTIVE);
} catch (e) {
  console.error(`scan-synced-disclosure: ${e.message}`);
  process.exit(2);
}
const activeShapes = [
  ...SHAPES,
  ...(customerShape ? [customerShape] : []),
  receiptPayloadShape,
];
const findings = [];
for (const f of files) scanFile(f, findings, activeShapes, args.allowSyntheticFixtureHomes);

if (args.mode === "check") {
  if (findings.length > 0) {
    console.error(
      `scan-synced-disclosure: ${findings.length} disclosure finding(s) on the synced surface`,
    );
    for (const f of findings) {
      console.error(`  ${f.path}:${f.line}  [SHAPE:${f.shape}]  ${f.context}`);
    }
    process.exit(1);
  }
  // The clean receipt is DISCRIMINATING: it names how many files were examined,
  // so a caller reading a 0 exit can tell a real clean scan from a scan of
  // nothing. Before this line, check-mode's clean path printed nothing at all.
  console.log(`Scanned: ${files.length} files on the synced surface — 0 findings`);
  process.exit(0);
}

// human report
console.log(`Synced-Artifact Disclosure Scan (issue #263)`);
console.log(`Root:    ${root}`);
console.log(`Scanned: ${files.length} files on the synced surface`);
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
  console.log(`  ${f.path}:${f.line}  [SHAPE:${f.shape}]  ${f.context}`);
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
