// strip-build-internal.mjs — codify BUILD-internal-path strip for USE-template emission.
//
// Applied at /sync Gate 2 + per-CLI artifact emission. Codifies the patterns
// from the 2026-05-12 Phase-4 broad strip (PR #84 on kailash-coc-claude-rs,
// PR #25 on kailash-coc-rs) so future /sync cycles do NOT re-leak BUILD-internal
// references that the manual sweep just cleaned.
//
// Contract: pure content transform. Idempotent — applying twice yields the
// same result as applying once. Preserves institutional content; only paths
// the USE consumer cannot resolve get rewritten.
//
// Pairs with `.claude/agents/management/coc-sync.md` Step 3a — the agent's
// per-file judgment cases (rule softening, BUILD-only artifact exclusion)
// remain prose; mechanical path-strip lives here.

// ────────────────────────────────────────────────────────────────
// REWRITES — order matters: backtick variants run before bare variants
// so the more specific match wins. Each entry is structurally:
//   pattern:     RegExp (must have /g flag for replaceAll behavior)
//   replacement: string with $N backrefs or function
//   desc:        short label used in --check output and self-test
//   buildSafe:   (optional) when true, the rewrite ALSO fires on the
//                BUILD lane (`buildMode`). See the BUILD-subset note below.
// ────────────────────────────────────────────────────────────────
//
// BUILD-scoped subset (#673): rewrites tagged `buildSafe: true` are the
// DISCLOSURE-class rules — loom-internal workspace paths (sections 1+2) +
// the canon org slug (section 3). They ALSO fire on the BUILD lane
// (`stripBuildInternalReferences(content, { buildMode: true })`) so a
// public-facing SDK BUILD repo (kailash-py / kailash-rs) never receives a
// loom workspace path or the canon org slug `esperie-enterprise`. Rewrites
// WITHOUT the tag (sections 4–7: `packages/<repo>` / `crates/<repo>` /
// sibling `.claude/` / workspace-tree headers) are package/repo
// SELF-references a BUILD repo legitimately owns; they apply on the USE
// lane only and ship VERBATIM to BUILD (stripping `kailash-py` → generic
// ON kailash-py would corrupt the repo's own names — the F11 reason the
// BUILD lane shipped verbatim before this subset).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── loom-workspace name set (DERIVED, not literal) ──────────────────
// #673-A2: section 1 below used to match ONLY `workspaces/multi-cli-coc/…`,
// so a real `--build py` emission shipped `workspaces/multi-operator-coc/…`
// (and every other loom workspace) VERBATIM to a BUILD repo — proven live in
// rules/knowledge-convergence.md. The fix derives the workspace name set from
// loom's LIVE `workspaces/` dir (resolved relative to THIS module, NOT cwd, so
// it works under the worktree the strip runs in), covering EVERY current loom
// workspace + any future one with zero literal-list drift. The strip runs at
// loom (during /sync-to-build + /sync-to-use), where `workspaces/` always
// exists. A name present in `workspaces/` is — by construction — a loom-internal
// workspace; an instructional / synthetic example name (`workspaces/my-project/`,
// `workspaces/acme-cust-engagement-q3/`) is NOT in the set and ships verbatim.
// This is the "provably scoped to loom-internal workspaces" guarantee: BUILD
// repos (kailash-py/rs) do not contain loom workspaces, so a derived match is
// always strip-eligible. The fallback (workspaces/ unreadable — e.g. a synced
// consumer running `--selftest` without a workspaces/ dir) keeps the long-lived
// canonical names so the shipped fixtures + proven-leak classes still strip;
// it NEVER under-strips to zero (an empty alternation would over-match).
function deriveLoomWorkspaceDirs() {
  const FALLBACK = ["multi-cli-coc", "multi-operator-coc"];
  try {
    const wsRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "workspaces",
    );
    const dirs = fs
      .readdirSync(wsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    return dirs.length > 0 ? dirs : FALLBACK;
  } catch {
    return FALLBACK;
  }
}
const LOOM_WS_ALT = deriveLoomWorkspaceDirs()
  .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) // regex-escape each dir
  .join("|");

const REWRITES = [
  // ── 1. loom-internal workspace paths ────────────────────────────
  // `workspaces/<loom-internal-ws>/...` in backticks (path-context only).
  // The workspace name set is DERIVED from loom's live workspaces/ dir
  // (LOOM_WS_ALT above) so EVERY current loom workspace is covered, not just
  // the historical multi-cli-coc literal (#673-A2).
  {
    pattern: new RegExp("`workspaces\\/(?:" + LOOM_WS_ALT + ")\\/[^`\\s]+`", "g"),
    replacement: "(loom-internal reference)",
    desc: "loom workspace path (backticked)",
    buildSafe: true, // #673 — loom-internal workspace path; strip on BUILD too
  },
  // bare workspaces/<loom-internal-ws>/<something> in prose
  {
    pattern: new RegExp(
      "\\bworkspaces\\/(?:" + LOOM_WS_ALT + ")\\/[A-Za-z0-9_./\\-]+",
      "g",
    ),
    replacement: "(loom-internal reference)",
    desc: "loom workspace path (bare)",
    buildSafe: true, // #673 — loom-internal workspace path; strip on BUILD too
  },

  // ── 2. sibling-SDK workspaces/ prefixes ─────────────────────────
  // `kailash-{py,rs,prism}/workspaces/...` in backticks
  {
    pattern: /`kailash-(?:py|rs|prism)\/workspaces\/[^`]*`/g,
    replacement: "workspace artifacts",
    desc: "sibling SDK workspaces/ (backticked)",
    buildSafe: true, // #673 — loom-internal workspace-path class; strip on BUILD too
  },

  // ── 3. gh api with concrete BUILD repo identity ─────────────────
  // gh api repos/<known-org>/kailash-<name>/...
  {
    pattern:
      /gh api repos\/(?:esperie-enterprise|terrene-foundation)\/kailash-[A-Za-z0-9_-]+/g,
    replacement: "gh api repos/<org>/<repo>",
    desc: "gh api with concrete org/repo",
    buildSafe: true, // #673 — canon org slug; strip on BUILD too
  },
  // ── 3b. gh api orgs/<known-org>/... (org-scoped endpoint) ───────
  // The orgs/ form (hosted-runners, actions, members, …) shipped the canon
  // org slug VERBATIM — the repos/ pattern above never matched it
  // (#673-A2: proven live at guides/rule-extracts/verify-resource-existence.md:102).
  {
    pattern: /gh api orgs\/(?:esperie-enterprise|terrene-foundation)\b/g,
    replacement: "gh api orgs/<org>",
    desc: "gh api with concrete org (orgs endpoint)",
    buildSafe: true, // #673-A2 — canon org slug; strip on BUILD too
  },
  // ── 3c. bare canon org slug — STANDALONE token only ─────────────
  // The standalone token `esperie-enterprise` / `terrene-foundation` outside
  // any gh-api form shipped VERBATIM (#673-A2: proven live at
  // guides/rule-extracts/verify-resource-existence.md:100, the backticked
  // `esperie-enterprise` form). The negative-lookahead `(?!/)` SCOPES this to
  // the standalone token: a slug used as a path PREFIX (`terrene-foundation/
  // kailash`, `terrene-foundation/kailash-coc-claude-rs#52`) is a legitimate
  // org/repo citation the existing strip deliberately preserves (the J10
  // variant-source-hygiene invariant depends on it), and the gh-api repos/orgs
  // forms above already consume the path-prefix disclosure cases. Runs AFTER
  // 3/3b so those more-specific rewrites claim their slug first; `<org>` is
  // slug-free so re-application is a fixed point.
  {
    pattern: /\b(?:esperie-enterprise|terrene-foundation)\b(?!\/)/g,
    replacement: "<org>",
    desc: "canon org slug (bare token)",
    buildSafe: true, // #673-A2 — canon org slug; strip on BUILD too
  },

  // ── 4. BUILD packages/ paths (backticked) ───────────────────────
  // `packages/kailash-X/path/to/file` → the X package (`path/to/file`)
  {
    pattern: /`packages\/kailash-([a-z][a-z0-9_-]*)\/([^`]+)`/g,
    replacement: "the $1 package (`$2`)",
    desc: "BUILD packages/ path (backticked)",
  },

  // ── 5. BUILD packages/ paths (bare in prose) ────────────────────
  // packages/kailash-X/<rest>  →  the X package directory <rest>
  // Trailing punctuation (. , ; : ! ?) is kept outside the path.
  {
    pattern: /\bpackages\/kailash-([a-z][a-z0-9_-]*)\/([A-Za-z0-9_./\-]+)/g,
    replacement: "the $1 package directory $2",
    desc: "BUILD packages/ path (bare)",
  },

  // ── 5b. BUILD monorepo sub-package paths (backticked) ───────────
  // kailash-kaizen monorepo layout: `packages/kaizen-agents/<rest>`.
  // Non-kailash-prefixed BUILD sub-packages are an explicit family
  // allowlist (kaizen- today) — a generic `packages/<name>/` pattern
  // would corrupt consumer-project monorepo paths (see PRESERVED).
  // Replacement keeps the full package name (no prefix to drop),
  // matching the #475 R5 manual-rewording convention at source.
  {
    pattern: /`packages\/(kaizen-[a-z][a-z0-9_-]*)\/([^`]+)`/g,
    replacement: "the $1 package (`$2`)",
    desc: "BUILD monorepo packages/ path (backticked)",
  },

  // ── 5c. BUILD monorepo sub-package paths (bare in prose) ────────
  {
    pattern: /\bpackages\/(kaizen-[a-z][a-z0-9_-]*)\/([A-Za-z0-9_./\-]+)/g,
    replacement: "the $1 package directory $2",
    desc: "BUILD monorepo packages/ path (bare)",
  },

  // ── 5d. BUILD packages/ dir, trailing-slash no-subpath (backticked)
  // `packages/kailash-X/` / `packages/kaizen-X/` with NOTHING after
  // the slash (e.g. "- `packages/kailash-align/` -- Source code").
  // Patterns 4/4b require a subpath, so this form previously shipped
  // verbatim (#477 item 1 / #475 redteam R-1).
  {
    pattern: /`packages\/((?:kailash|kaizen)-[a-z][a-z0-9_-]*)\/`/g,
    replacement: (_m, pkg) =>
      `the ${pkg.startsWith("kailash-") ? pkg.slice("kailash-".length) : pkg} package directory`,
    desc: "BUILD packages/ dir, no subpath (backticked)",
  },

  // ── 5e. BUILD packages/ dir, trailing-slash no-subpath (bare) ───
  // Negative lookahead: no subpath character may follow. `*` is in the
  // excluded set so glob forms (`packages/kailash-dataflow/**` in
  // `paths:` frontmatter / CI path filters) stay load-bearing verbatim.
  {
    pattern:
      /\bpackages\/((?:kailash|kaizen)-[a-z][a-z0-9_-]*)\/(?![A-Za-z0-9_.*/\-])/g,
    replacement: (_m, pkg) =>
      `the ${pkg.startsWith("kailash-") ? pkg.slice("kailash-".length) : pkg} package directory`,
    desc: "BUILD packages/ dir, no subpath (bare)",
  },

  // ── 6. sibling-SDK .claude/ examples (descriptive cross-repo) ───
  // `kailash-{py,rs,prism}/.claude/<rest>` → the sibling SDK's `.claude/<rest>`
  {
    pattern: /`kailash-(?:py|rs|prism)\/(\.claude\/[^`]+)`/g,
    replacement: "the sibling SDK's `$1`",
    desc: "sibling SDK .claude/ example",
  },

  // ── 7. workspace-tree headers (`kailash-rs/` as top-of-tree label)
  // Matches `kailash-{py,rs,prism}/` only when followed by an ASCII
  // tree-drawing character or end-of-string (avoids consuming repo
  // names appearing in prose like "the kailash-rs/ repo"). Backticked
  // form only — bare prose mentions stay.
  {
    pattern: /`kailash-(?:py|rs|prism)\/`(?=\s*$|\s*[\n├└│─])/gm,
    replacement: "`<workspace-root>/`",
    desc: "workspace-tree header",
  },
];

// ────────────────────────────────────────────────────────────────
// PRESERVED (per Phase-4 strip contract — informative, not code)
// ────────────────────────────────────────────────────────────────
//   - `crates/kailash-*/` — illustrative for binding consumers describing
//     crate-level architecture (kailash-rs-alignment skill body relies on this)
//   - PyPI package names in dep specs: `kailash-dataflow>=2.0.3`, etc.
//     (public package identifiers users `pip install` directly)
//   - `kailash-{py,rs,prism}` repo names appearing in unstructured prose
//     (NOT followed by /workspaces/, /.claude/, or tree-character)
//   - Glob forms: `packages/kailash-X/**` / `packages/kaizen-X/**` (and any
//     `*` immediately after the package slash) — these are LOAD-BEARING in
//     `paths:` frontmatter of path-scoped rules/skills and in CI path
//     filters; `*` is excluded from every subpath char-class and from the
//     5e trailing-slash lookahead by design. Rewriting them would break
//     rule loading on the consumer side.
//   - Generic consumer monorepo paths: `packages/<name>/...` where <name>
//     is NOT kailash-/kaizen- prefixed (e.g. packages/my-app/src/). Consumer
//     projects legitimately use packages/ layouts; only the known BUILD
//     package families strip. New BUILD monorepo families extend the
//     explicit alternation (kailash|kaizen), never a wildcard.
// These patterns are intentionally NOT in REWRITES.

/**
 * stripBuildInternalReferences — apply BUILD-internal-path rewrites.
 *
 * @param {string} content  Source content (markdown/text).
 * @param {{buildMode?: boolean}} [opts]
 *   buildMode (#673) — when true, apply ONLY the `buildSafe` rewrites
 *   (loom workspace paths + canon org slug), leaving package/repo
 *   self-reference rewrites OFF so a BUILD repo's own `packages/<repo>`
 *   / `crates/<repo>` / sibling `.claude/` names ship verbatim. Default
 *   false = full USE-lane strip (every rewrite), back-compat with every
 *   single-arg caller (emit-cli-artifacts.mjs, the USE deploy path).
 * @returns {{stripped: string, applied: string[]}}
 *   stripped — content with the applicable REWRITES applied (idempotent).
 *   applied  — descriptions of which rewrite rules actually fired.
 */
export function stripBuildInternalReferences(content, { buildMode = false } = {}) {
  if (typeof content !== "string") {
    throw new TypeError(
      "stripBuildInternalReferences: content must be a string",
    );
  }
  let stripped = content;
  const applied = [];
  for (const rw of REWRITES) {
    // #673 BUILD-scoped subset: on the BUILD lane only the disclosure-class
    // (buildSafe) rewrites fire; package/repo self-reference rewrites are
    // skipped so the BUILD repo's own names survive verbatim.
    if (buildMode && !rw.buildSafe) continue;
    const { pattern, replacement, desc } = rw;
    const before = stripped;
    stripped = stripped.replace(pattern, replacement);
    if (stripped !== before && !applied.includes(desc)) applied.push(desc);
  }
  return { stripped, applied };
}

// ────────────────────────────────────────────────────────────────
// Self-test fixtures — committed alongside the helper per
// rules/cc-artifacts.md Rule 9. Each fixture is structurally:
//   name:     short label
//   input:    raw content
//   expected: post-strip content
// Fail-loud on mismatch; CLI mode prints first 3 diff lines.
// ────────────────────────────────────────────────────────────────
const SELF_TEST_FIXTURES = [
  {
    name: "loom-workspace-path-backticked",
    input:
      "See `workspaces/multi-cli-coc/02-plans/07-loom-multi-cli-spec-v6.md` for the spec.",
    expected: "See (loom-internal reference) for the spec.",
  },
  {
    name: "loom-workspace-path-bare",
    input: "Origin: workspaces/multi-cli-coc/journal/0042-DECISION.md cites this.",
    expected: "Origin: (loom-internal reference) cites this.",
  },
  {
    name: "sibling-workspaces-backticked",
    input:
      "Compare `kailash-py/workspaces/foo/` and `kailash-rs/workspaces/bar/`.",
    expected: "Compare workspace artifacts and workspace artifacts.",
  },
  {
    name: "gh-api-concrete-repo",
    input:
      "Diagnose: `gh api repos/esperie-enterprise/kailash-rs/actions/runs`.",
    expected: "Diagnose: `gh api repos/<org>/<repo>/actions/runs`.",
  },
  {
    name: "packages-backticked",
    input:
      "Edit `packages/kailash-ml/src/kailash_ml/trainable.py` to fix the bug.",
    expected: "Edit the ml package (`src/kailash_ml/trainable.py`) to fix the bug.",
  },
  {
    name: "packages-bare-prose",
    input: "The path packages/kailash-dataflow/src/dataflow/adapters/mongodb.py is internal.",
    expected:
      "The path the dataflow package directory src/dataflow/adapters/mongodb.py is internal.",
  },
  {
    name: "sibling-dot-claude-example",
    input:
      "Like `kailash-py/.claude/rules/foo.md` references work fine.",
    expected: "Like the sibling SDK's `.claude/rules/foo.md` references work fine.",
  },
  {
    name: "preserve-crates-path",
    input:
      "The `crates/kailash-pact/` crate provides governance primitives.",
    expected:
      "The `crates/kailash-pact/` crate provides governance primitives.",
  },
  {
    name: "preserve-pypi-package-name",
    input: 'Add "kailash-dataflow>=2.0.3" to dependencies.',
    expected: 'Add "kailash-dataflow>=2.0.3" to dependencies.',
  },
  {
    name: "preserve-prose-repo-mention",
    input: "Users of the kailash-rs repo should pin via Cargo.toml.",
    expected: "Users of the kailash-rs repo should pin via Cargo.toml.",
  },
  {
    name: "idempotent-on-already-stripped",
    input: "See (loom-internal reference) and the dataflow package (`x.py`).",
    expected: "See (loom-internal reference) and the dataflow package (`x.py`).",
  },
  {
    name: "workspace-tree-header",
    input: "Tree:\n`kailash-rs/`\n├── src\n└── tests",
    expected: "Tree:\n`<workspace-root>/`\n├── src\n└── tests",
  },
  {
    name: "monorepo-subpackage-backticked",
    input:
      "**Source**: `packages/kaizen-agents/src/kaizen_agents/supervisor.py`",
    expected:
      "**Source**: the kaizen-agents package (`src/kaizen_agents/supervisor.py`)",
  },
  {
    name: "monorepo-subpackage-bare",
    input: "Run the grep against packages/kaizen-agents/tests/ for callers.",
    expected:
      "Run the grep against the kaizen-agents package directory tests/ for callers.",
  },
  {
    name: "trailing-slash-no-subpath-backticked",
    input: "- `packages/kailash-align/` -- Source code",
    expected: "- the align package directory -- Source code",
  },
  {
    name: "trailing-slash-no-subpath-bare",
    input: "git log <last-tag>..HEAD -- packages/kailash-dataflow/  → changes?",
    expected:
      "git log <last-tag>..HEAD -- the dataflow package directory  → changes?",
  },
  {
    name: "trailing-slash-monorepo-backticked",
    input: "MOVE it to `packages/kaizen-agents/` for the monorepo layout.",
    expected:
      "MOVE it to the kaizen-agents package directory for the monorepo layout.",
  },
  {
    name: "preserve-paths-frontmatter-glob",
    input: 'paths: ["packages/kailash-dataflow/**"]',
    expected: 'paths: ["packages/kailash-dataflow/**"]',
  },
  {
    name: "preserve-ci-path-filter-glob",
    input: '      - "packages/kailash-dataflow/**"\n      - "packages/kaizen-agents/**"',
    expected:
      '      - "packages/kailash-dataflow/**"\n      - "packages/kaizen-agents/**"',
  },
  {
    name: "preserve-consumer-monorepo-path",
    input: "Put shared code under packages/my-lib/src/index.ts in your repo.",
    expected:
      "Put shared code under packages/my-lib/src/index.ts in your repo.",
  },
  {
    name: "idempotent-on-extended-outputs",
    input:
      "See the kaizen-agents package (`src/kaizen_agents/supervisor.py`) and the align package directory for detail.",
    expected:
      "See the kaizen-agents package (`src/kaizen_agents/supervisor.py`) and the align package directory for detail.",
  },
  {
    name: "multiple-patterns-one-pass",
    input:
      "From `workspaces/multi-cli-coc/journal/0001.md`, edit `packages/kailash-kaizen/tests/foo.py` and run `gh api repos/terrene-foundation/kailash-py/issues`.",
    expected:
      "From (loom-internal reference), edit the kaizen package (`tests/foo.py`) and run `gh api repos/<org>/<repo>/issues`.",
  },
  // ── #673 BUILD-scoped subset (buildMode:true) ──────────────────────
  // The disclosure-class rewrites (workspace paths + canon org) STILL fire;
  // package/repo self-references are PRESERVED verbatim.
  {
    name: "build-subset-strips-loom-workspace-path",
    buildMode: true,
    input:
      "See `workspaces/multi-cli-coc/02-plans/07-loom-multi-cli-spec-v6.md` for the spec.",
    expected: "See (loom-internal reference) for the spec.",
  },
  {
    name: "build-subset-strips-canon-org-slug",
    buildMode: true,
    input:
      "Diagnose: `gh api repos/esperie-enterprise/kailash-rs/actions/runs`.",
    expected: "Diagnose: `gh api repos/<org>/<repo>/actions/runs`.",
  },
  {
    name: "build-subset-strips-sibling-workspaces",
    buildMode: true,
    input: "Compare `kailash-py/workspaces/foo/` and `kailash-rs/workspaces/bar/`.",
    expected: "Compare workspace artifacts and workspace artifacts.",
  },
  {
    name: "build-subset-PRESERVES-packages-path",
    buildMode: true,
    input:
      "Edit `packages/kailash-ml/src/kailash_ml/trainable.py` to fix the bug.",
    expected:
      "Edit `packages/kailash-ml/src/kailash_ml/trainable.py` to fix the bug.",
  },
  {
    name: "build-subset-PRESERVES-crates-path",
    buildMode: true,
    input:
      "The `crates/kailash-pact/` crate provides governance primitives.",
    expected:
      "The `crates/kailash-pact/` crate provides governance primitives.",
  },
  {
    name: "build-subset-PRESERVES-sibling-dot-claude",
    buildMode: true,
    input: "Like `kailash-py/.claude/rules/foo.md` references work fine.",
    expected: "Like `kailash-py/.claude/rules/foo.md` references work fine.",
  },
  {
    name: "build-subset-mixed-strips-disclosure-preserves-package",
    buildMode: true,
    input:
      "From `workspaces/multi-cli-coc/journal/0001.md`, edit `packages/kailash-kaizen/tests/foo.py` and run `gh api repos/terrene-foundation/kailash-py/issues`.",
    expected:
      "From (loom-internal reference), edit `packages/kailash-kaizen/tests/foo.py` and run `gh api repos/<org>/<repo>/issues`.",
  },
  // ── #673-A2: generic loom-workspace strip (not just multi-cli-coc) ──
  // USE lane: any current loom workspace dir strips (multi-operator-coc was
  // the proven leak in rules/knowledge-convergence.md).
  {
    name: "loom-workspace-multi-operator-coc-backticked",
    input:
      "Origin: `workspaces/multi-operator-coc/02-plans/01-architecture.md` §5 cites this.",
    expected: "Origin: (loom-internal reference) §5 cites this.",
  },
  {
    name: "loom-workspace-non-multi-cli-bare",
    input: "See workspaces/ecosystem-operating-model/02-plans/05-x.md for detail.",
    expected: "See (loom-internal reference) for detail.",
  },
  {
    name: "build-subset-strips-multi-operator-coc",
    buildMode: true,
    input:
      "Origin: `workspaces/multi-operator-coc/02-plans/01-architecture.md` cites this.",
    expected: "Origin: (loom-internal reference) cites this.",
  },
  {
    name: "build-subset-strips-other-loom-workspace",
    buildMode: true,
    input: "See workspaces/sync-upflow/briefs/00-brief.md for the value anchor.",
    expected: "See (loom-internal reference) for the value anchor.",
  },
  // Provably-scoped: a NON-loom workspace name (instructional / synthetic) is
  // PRESERVED verbatim on BOTH lanes — the derived set strips loom names only.
  {
    name: "preserve-non-loom-workspace-instructional",
    input: "Put your plans under `workspaces/my-project/02-plans/` in your repo.",
    expected: "Put your plans under `workspaces/my-project/02-plans/` in your repo.",
  },
  {
    name: "build-subset-PRESERVES-non-loom-workspace",
    buildMode: true,
    input: "Put your plans under `workspaces/my-project/02-plans/` in your repo.",
    expected: "Put your plans under `workspaces/my-project/02-plans/` in your repo.",
  },
  // ── #673-A2: canon org slug — orgs/ form + bare token ──────────────
  // USE lane: both broadened forms strip (were form-narrow to repos/ before).
  {
    name: "gh-api-orgs-form-strips-canon-org",
    input: "Run `gh api orgs/esperie-enterprise/actions/hosted-runners`.",
    expected: "Run `gh api orgs/<org>/actions/hosted-runners`.",
  },
  {
    name: "bare-canon-org-slug-backticked",
    input: "The canon org is `terrene-foundation` (public fork).",
    expected: "The canon org is `<org>` (public fork).",
  },
  // BUILD lane: orgs/ form + bare token both strip (disclosure-class).
  {
    name: "build-subset-strips-orgs-form",
    buildMode: true,
    input: "Run `gh api orgs/esperie-enterprise/actions/hosted-runners`.",
    expected: "Run `gh api orgs/<org>/actions/hosted-runners`.",
  },
  {
    name: "build-subset-strips-bare-canon-org-slug",
    buildMode: true,
    input: "The canon org is `terrene-foundation` (public fork).",
    expected: "The canon org is `<org>` (public fork).",
  },
];

function selftest({ verbose = false } = {}) {
  let pass = 0;
  let fail = 0;
  const failures = [];
  for (const fx of SELF_TEST_FIXTURES) {
    const { stripped } = stripBuildInternalReferences(fx.input, {
      buildMode: fx.buildMode === true,
    });
    if (stripped === fx.expected) {
      pass++;
      if (verbose) console.log(`  PASS  ${fx.name}`);
    } else {
      fail++;
      failures.push({
        name: fx.name,
        expected: fx.expected,
        actual: stripped,
      });
    }
  }
  if (fail > 0) {
    console.error(`strip-build-internal selftest: ${pass} pass, ${fail} fail`);
    for (const f of failures) {
      console.error(`  FAIL  ${f.name}`);
      console.error(`    expected: ${JSON.stringify(f.expected)}`);
      console.error(`    actual:   ${JSON.stringify(f.actual)}`);
    }
    return false;
  }
  console.log(`strip-build-internal selftest: ${pass}/${pass} pass`);
  return true;
}

// ────────────────────────────────────────────────────────────────
// CLI entry point — runnable for sync-flow / debugging / pre-commit.
//
//   node strip-build-internal.mjs --selftest
//     Run all fixtures; exit 0 on full pass, 1 otherwise.
//
//   node strip-build-internal.mjs --check <file>
//     Read <file>, report which rewrite rules would fire, exit 0
//     if file is clean (no rewrites), 1 if it would be modified.
//
//   node strip-build-internal.mjs --apply <input> [--out <output>]
//     Read <input>, write stripped to <output> (defaults to stdout).
//
// Used by:
//   - rules/cc-artifacts.md Rule 9 (audit fixtures via --selftest)
//   - agents/management/coc-sync.md Step 3a (--check as post-sync audit)
//   - .claude/bin/emit-cli-artifacts.mjs (library import; in-process call)
//   - .claude/bin/sync-tier-aware.mjs (library import since #473; #475 adds
//     write-time strip of plain-global copy actions + the variant_only
//     strip-dirty completeness gate)
// ────────────────────────────────────────────────────────────────
async function cli() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      `Usage:\n` +
        `  --selftest               Run fixtures, exit 0 on pass.\n` +
        `  --check <file>           Report rules that would fire on <file>.\n` +
        `  --apply <file> [--out X] Strip <file>; write to X or stdout.\n`,
    );
    return 0;
  }
  if (args[0] === "--selftest") {
    return selftest({ verbose: args.includes("-v") }) ? 0 : 1;
  }
  if (args[0] === "--check") {
    const fp = args[1];
    if (!fp) {
      process.stderr.write("--check requires a file path\n");
      return 2;
    }
    const content = fs.readFileSync(fp, "utf8");
    const { stripped, applied } = stripBuildInternalReferences(content);
    if (stripped === content) {
      console.log(`clean: ${fp}`);
      return 0;
    }
    console.log(`would-rewrite: ${fp}`);
    for (const desc of applied) console.log(`  - ${desc}`);
    return 1;
  }
  if (args[0] === "--apply") {
    const fp = args[1];
    if (!fp) {
      process.stderr.write("--apply requires a file path\n");
      return 2;
    }
    const content = fs.readFileSync(fp, "utf8");
    const { stripped } = stripBuildInternalReferences(content);
    const outIdx = args.indexOf("--out");
    if (outIdx >= 0 && args[outIdx + 1]) {
      fs.writeFileSync(args[outIdx + 1], stripped);
    } else {
      process.stdout.write(stripped);
    }
    return 0;
  }
  process.stderr.write(`unknown args: ${args.join(" ")}\n`);
  return 2;
}

// Run CLI when invoked directly; skip when imported as a module.
// (fileURLToPath imported at module top for the workspace-dir derivation.)
const __thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && __thisFile === process.argv[1]) {
  cli().then((code) => process.exit(code));
}
