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
// ────────────────────────────────────────────────────────────────
const REWRITES = [
  // ── 1. loom-internal workspace paths ────────────────────────────
  // `workspaces/multi-cli-coc/...` in backticks (path-context only)
  {
    pattern: /`workspaces\/multi-cli-coc\/[^`\s]+`/g,
    replacement: "(loom-internal reference)",
    desc: "loom workspace path (backticked)",
  },
  // bare workspaces/multi-cli-coc/<something> in prose
  {
    pattern: /\bworkspaces\/multi-cli-coc\/[A-Za-z0-9_./\-]+/g,
    replacement: "(loom-internal reference)",
    desc: "loom workspace path (bare)",
  },

  // ── 2. sibling-SDK workspaces/ prefixes ─────────────────────────
  // `kailash-{py,rs,prism}/workspaces/...` in backticks
  {
    pattern: /`kailash-(?:py|rs|prism)\/workspaces\/[^`]*`/g,
    replacement: "workspace artifacts",
    desc: "sibling SDK workspaces/ (backticked)",
  },

  // ── 3. gh api with concrete BUILD repo identity ─────────────────
  // gh api repos/<known-org>/kailash-<name>/...
  {
    pattern:
      /gh api repos\/(?:esperie-enterprise|terrene-foundation)\/kailash-[A-Za-z0-9_-]+/g,
    replacement: "gh api repos/<org>/<repo>",
    desc: "gh api with concrete org/repo",
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
 * @returns {{stripped: string, applied: string[]}}
 *   stripped — content with all REWRITES applied (idempotent).
 *   applied  — descriptions of which rewrite rules actually fired.
 */
export function stripBuildInternalReferences(content) {
  if (typeof content !== "string") {
    throw new TypeError(
      "stripBuildInternalReferences: content must be a string",
    );
  }
  let stripped = content;
  const applied = [];
  for (const { pattern, replacement, desc } of REWRITES) {
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
];

function selftest({ verbose = false } = {}) {
  let pass = 0;
  let fail = 0;
  const failures = [];
  for (const fx of SELF_TEST_FIXTURES) {
    const { stripped } = stripBuildInternalReferences(fx.input);
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
    const fs = await import("node:fs");
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
    const fs = await import("node:fs");
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
import { fileURLToPath } from "node:url";
const __thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && __thisFile === process.argv[1]) {
  cli().then((code) => process.exit(code));
}
