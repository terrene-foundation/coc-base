#!/usr/bin/env node
/**
 * lint-prose-drift.mjs — SSOT prose-drift tripwire (onboarding-portability D10).
 *
 * WHY: a repo-layout fact restated in PROSE (a guide/rule sentence asserting
 * "checks `../kailash-coc-claude-py/`" or "cascade to `~/repos/loom/...`") is a
 * SECOND source of truth that goes stale. The declarative resolver
 * (`loom-links.local.json`, read by `loom-links.mjs::resolveRepo`) already owns
 * NAME→on-disk-path; a hardcoded path in prose contradicts any non-default
 * operator layout, and Claude answers a layout question from whichever clock the
 * question lands on — prose is the stopped clock. This lint flags type-(b)
 * STALE-assertion prose so it cannot reaccumulate after the W4-a de-dup pass.
 *
 * DESIGN — TWO AXES. (1) The EXEMPTION axis IS a POSITIVE ALLOWLIST
 * (cc-artifacts.md Rule 10): within a detected shape, a hit is flagged UNLESS it
 * matches a structurally-recognized safe context (E1–E5) — it does NOT enumerate
 * known-bad literal strings, so a NEW stale path of an ALREADY-COVERED shape is
 * caught on sight (e.g. a future `../kailash-newpkg/` sibling probe). (2) The
 * DETECTION axis is a deliberately NARROW enumeration of the 3 layout-assertion
 * SHAPES below — it does NOT claim to catch every conceivable layout literal:
 * other home-roots (`~/Code/`, `~/dev/`) and single-word siblings (`../atelier`,
 * `../loom`, with no hyphen) are by-design NOT matched, because broadening a
 * shape would false-positive on legitimate paths such as `~/.cache/kailash-coc/`.
 * Narrow detection + positive-allowlist exemption is the precision/recall trade
 * chosen for the W4 drift register's actual shapes; widen a shape ONLY with a
 * paired exemption predicate + fixture.
 *
 *   Detection predicates (layout-assertion SHAPES):
 *     - abs-home-repos        ~/repos/<...>            (absolute home-repo layout)
 *     - obsolete-resolver-loc scripts/resolve-template.js (pre-v2.8.31 location;
 *                             canonical is .claude/bin/resolve-template.js)
 *     - sibling-repo-probe    ../<hyphenated-repo-slug> (positional sibling probe)
 *
 *   Exemption predicates (the positive allowlist — a hit is CLEARED iff):
 *     E1 fenced-code-block   — inside a ``` fence (DO/DO-NOT bash, ASCII diagrams,
 *                              synthetic examples). Display, not an assertion.
 *     E2 inline-marker       — the line carries an `ssot-lint-allow:` comment.
 *     E3 historical-section  — the line is under a heading fenced historical/hint
 *                              (heading text matches `(historical`/`(hint`, OR a
 *                              standalone `ssot-lint-allow:historical|hint` line
 *                              opened the section). Provenance, not a live path.
 *     E4 register-file       — the file is a dedicated layout/resolver-teaching
 *                              artifact on the drift register's "checked-and-cleared"
 *                              list (every layout literal in it is anti-pattern or
 *                              orchestration-root CONCEPT by construction).
 *     E5 antipattern-signal  — the hit line itself frames the literal AS an
 *                              anti-pattern / HINT (the SSOT defense working), e.g.
 *                              "never a positional …guess" / "This is a HINT".
 *
 * USAGE:
 *   node .claude/bin/lint-prose-drift.mjs [--root <dir> ...] [--json]
 *   default roots: .claude/guides  .claude/rules
 * EXIT: 0 = clean, 1 = at least one flagged line, 2 = bad invocation.
 *
 * Fixtures (cc-artifacts.md Rule 9, one per exemption predicate + one per
 * detection predicate): .claude/audit-fixtures/lint-prose-drift/<case>/ each with
 * a sibling `.expected` capturing the flagged-line report.
 */

import fs from "node:fs";
import path from "node:path";

// ─── detection predicates (SHAPES, not literal known-bad strings) ────────────
export const PREDICATES = [
  {
    id: "abs-home-repos",
    re: /~\/repos\//,
    fix: "resolve via loom-links.mjs::resolveRepo(<logical-key>); drop the hardcoded ~/repos path",
  },
  {
    id: "obsolete-resolver-loc",
    re: /scripts\/resolve-template\.js/,
    fix: "cite .claude/bin/resolve-template.js (scripts/resolve-template.js is the obsolete pre-v2.8.31 location)",
  },
  {
    id: "sibling-repo-probe",
    // ../ followed by a hyphenated repo-like slug (kailash-coc-claude-py, kailash-py,
    // …). A single-word ../hooks / ../bin intra-repo nav has no hyphen → not matched.
    re: /\.\.\/[a-z0-9]+(?:-[a-z0-9]+)+/,
    fix: "resolve the sibling via loom-links.mjs::resolveRepo(<key>); a positional ../ probe breaks on non-sibling layouts",
  },
];

// ─── E4: register checked-and-cleared dedicated layout/resolver-teaching files ─
// Path-SUFFIX match (so a fixture at .../rules/cross-repo.md also exercises it).
// Each entry's raison d'être IS teaching the layout/anti-pattern/orchestration-root
// concept; every layout literal in it is by-construction NOT a stale assertion.
const REGISTER_CLEARED_SUFFIXES = [
  "rules/cross-repo.md", // canonical-sublayout HINT + ~/repos anti-pattern DO-NOT
  "rules/repo-scope-discipline.md", // ~/repos orchestration-root concept + anti-pattern
  "rules/multi-operator-coordination.md", // MUST-NOT positional-construction clause
  "guides/co-setup/10-user-defined-repo-linkages.md", // the resolver guide itself
  "guides/rule-extracts/repo-scope-discipline.md", // extract of the anti-pattern prose
];

// ─── E5: on-line anti-pattern / HINT framing signals (the SSOT defense itself) ─
const ANTIPATTERN_SIGNALS = [
  /\bHINT\b/,
  /\banti-pattern\b/i,
  /never a positional/i,
  /positional (?:assumption|guess|construction)/i,
];

export function isRegisterCleared(relPath) {
  const norm = relPath.split(path.sep).join("/");
  return REGISTER_CLEARED_SUFFIXES.some((s) => norm.endsWith(s));
}

/**
 * Classify every line of a markdown file as flagged or exempt.
 * Returns an array of { line, col, predicate, text, fix } for FLAGGED hits only.
 */
export function scanContent(relPath, content) {
  const lines = content.split("\n");
  const flags = [];
  const fileCleared = isRegisterCleared(relPath);

  let inFence = false; // E1: ``` / ~~~ code fence
  let historicalActive = false; // E3: historical/hint section fence

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;

    // E1 — fence toggle (``` or ~~~ at start of trimmed line). The toggling line
    // itself is structural, never carries an assertion we score.
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }

    // E3 — section-fence state transitions on heading lines.
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (headingMatch) {
      const headingText = headingMatch[2];
      historicalActive =
        /\(historical/i.test(headingText) ||
        /\(hint/i.test(headingText) ||
        /ssot-lint-allow:\s*(?:historical|hint)/i.test(headingText);
      // a heading line is structural; do not score it.
      continue;
    }
    // a standalone marker line opens a historical/hint fence too (marker placed
    // below the heading rather than in the heading text).
    if (/ssot-lint-allow:\s*(?:historical|hint)/i.test(raw)) {
      historicalActive = true;
    }

    if (inFence) continue; // E1
    if (historicalActive) continue; // E3
    if (fileCleared) continue; // E4
    if (/ssot-lint-allow:/i.test(raw)) continue; // E2 (inline marker on this line)
    if (ANTIPATTERN_SIGNALS.some((re) => re.test(raw))) continue; // E5

    for (const pred of PREDICATES) {
      const m = pred.re.exec(raw);
      if (m) {
        flags.push({
          file: relPath,
          line: lineNo,
          col: m.index + 1,
          predicate: pred.id,
          text: m[0],
          fix: pred.fix,
        });
      }
    }
  }
  return flags;
}

function walkMarkdown(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try {
      st = fs.statSync(cur);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      for (const ent of fs.readdirSync(cur)) {
        if (ent === "node_modules" || ent.startsWith(".git")) continue;
        stack.push(path.join(cur, ent));
      }
    } else if (st.isFile() && cur.endsWith(".md")) {
      out.push(cur);
    }
  }
  return out.sort();
}

export function main(argv) {
  const roots = [];
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") {
      const r = argv[++i];
      if (!r) {
        process.stderr.write("error: --root requires a directory\n");
        return 2;
      }
      roots.push(r);
    } else if (a === "--json") {
      json = true;
    } else if (a === "-h" || a === "--help") {
      process.stdout.write(
        "usage: lint-prose-drift.mjs [--root <dir> ...] [--json]\n",
      );
      return 0;
    } else {
      process.stderr.write(`error: unknown argument '${a}'\n`);
      return 2;
    }
  }
  if (roots.length === 0) roots.push(".claude/guides", ".claude/rules");

  const cwd = process.cwd();
  const allFlags = [];
  for (const root of roots) {
    for (const file of walkMarkdown(root)) {
      const rel = path.relative(cwd, file) || file;
      const content = fs.readFileSync(file, "utf8");
      allFlags.push(...scanContent(rel, content));
    }
  }
  allFlags.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1,
  );

  if (json) {
    process.stdout.write(JSON.stringify(allFlags, null, 2) + "\n");
  } else if (allFlags.length === 0) {
    process.stdout.write("prose-drift lint: CLEAN (0 stale layout assertions)\n");
  } else {
    for (const f of allFlags) {
      process.stdout.write(
        `${f.file}:${f.line}:${f.col}: [${f.predicate}] "${f.text}" — ${f.fix}\n`,
      );
    }
    process.stdout.write(
      `\nprose-drift lint: ${allFlags.length} stale layout assertion(s) flagged\n`,
    );
  }
  return allFlags.length === 0 ? 0 : 1;
}

// Run as a CLI only when invoked directly (not when imported by the test harness).
import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.exit(main(process.argv.slice(2)));
}
