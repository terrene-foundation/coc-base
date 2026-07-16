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

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

// ────────────────────────────────────────────────────────────────
// CLI args
// ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { mode: "report", root: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") args.mode = "check";
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--root") args.root = argv[++i];
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
const TOP_LEVEL_SYNCED = ["AGENTS.md", "GEMINI.md"];

// Active scan root (set by collectFiles; default repo root). Declared
// before isExcluded() so the scanner-own-file check resolves correctly.
let REPO_ROOT_ACTIVE = REPO_ROOT;

// Paths that sync-manifest.yaml `exclude:` declares NEVER-SYNCED. The
// disclosure scanner fences the SYNCED surface (the #252 forest is the
// content that reaches 30+ consumers); a real operator token in a
// never-synced file (the learning telemetry log, loom-only management
// agents, the local VERSION ledger, sync-manifest.yaml itself, the
// loom-only test-harness) is NOT a sync disclosure — it never leaves
// this repo. Scanning it would bury the real sync-surface signal in
// thousands of non-actionable lines.
//
// R3 disclosure FIX (#263): `variants/` is NO LONGER blanket-excluded.
// `.claude/variants/{py,rs,rb,prism}/**` are the language overlays that
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
  // worktrees/ is gitignored and contains transient agent work directories
  // (each a full repo checkout under .claude/worktrees/agent-<hash>/). The
  // contents are not synced to consumers — they're operator-local agent
  // scratch space. Excluding them prevents the scanner from flagging
  // findings inside agent transients that NEVER reach a downstream surface.
  if (pSegs[0] === "worktrees") return true;
  if (base === "sync-manifest.yaml") return true;
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
  if (/\.operator\.local\.md$/.test(base)) return true;
  if (/\.local\.json$/.test(base) && REPO_ROOT_ACTIVE === REPO_ROOT) return true;
  if (/\.local\.md$/.test(base)) return true;

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
  /\bAegis\b/i, // public PACT product
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

function scanFile(file, findings, shapes) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return;
  }
  if (isProbablyBinary(buf)) return;
  const rel = path.relative(REPO_ROOT_ACTIVE, file);
  const base = path.basename(file);
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
      shape.rx.lastIndex = 0;
      let m;
      while ((m = shape.rx.exec(line)) !== null) {
        const matchText = m[0];
        if (m.index === shape.rx.lastIndex) shape.rx.lastIndex++;
        // F77 (#386): the settings-permission-absolute-path shape is
        // INTRINSICALLY wrong regardless of which operator's path it
        // wraps — a tool-call matcher in a synced settings.json's
        // `permissions.*` array MUST NOT carry an absolute filesystem
        // path even if the path's operator-stem is the maintainer's own
        // Option-1 self-coordinate. Skip the allowlist suppression for
        // this shape so own-coordinate `/Users/esperie/` tokens inside
        // an `Edit(...)` matcher still flag. Every other shape retains
        // the Option-1 allowlist semantics unchanged.
        if (
          shape.id !== "settings-permission-absolute-path" &&
          shape.id !== "customer-identity-token" &&
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
const files = collectFiles(root); // sets REPO_ROOT_ACTIVE
// Build the loom-only customer-identity shape from the tenant denylist at
// the SCANNED root (inert when absent; throws loud on a malformed file so
// the guard never silently disables itself).
let customerShape;
try {
  customerShape = loadCustomerIdentityShape(REPO_ROOT_ACTIVE);
} catch (e) {
  console.error(`scan-synced-disclosure: ${e.message}`);
  process.exit(2);
}
const activeShapes = customerShape ? [...SHAPES, customerShape] : SHAPES;
const findings = [];
for (const f of files) scanFile(f, findings, activeShapes);

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
