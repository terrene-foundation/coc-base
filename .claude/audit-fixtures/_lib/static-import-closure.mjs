/**
 * static-import-closure — mirror a module's STATIC relative-import closure into
 * a fixture repo, derived from the tree.
 *
 * WHY THIS EXISTS. Three burndown fixtures built bin-only repos by copying a
 * HAND-KEPT list — the generator plus one runtime-resolved lib — and the list
 * went stale the moment the generator gained a static import
 * (`./lib/entry-point.mjs`, fcecaa28f): every fixture repo then died with
 * ERR_MODULE_NOT_FOUND, reading as 105/36/23 arm failures that say nothing
 * about the code under test. A hand-kept copy list is a second model of the
 * tree's dependency graph, and it drifts exactly when the graph moves. This is
 * the f0149456a lesson ("copy what the tree HAS") strengthened one step: the
 * tree's own import statements are what decide what a fixture repo needs, so
 * the walk below DERIVES the closure instead of restating it.
 *
 * THE TOP-LEVEL-ONLY RULE IS LOAD-BEARING, not tidiness. The burndown generator
 * resolves its CONDITIONAL deps (`burndown-events.js`, `signed-log.js`,
 * `coc-sign.js`) by PATH at runtime, and more than one suite PINS their absence
 * (the zero-relative-imports property `--quote` demonstrates). Only UNINDENTED
 * (column-0) `import`/`require` statements are matched, so:
 *   - a top-level static import is ALWAYS copied (its absence is a crash);
 *   - a conditional or indented require is NEVER copied (its absent state is
 *     what the fixtures exercise).
 * A future static import cannot silently break these fixtures again; a future
 * PATH-resolved runtime dep still must be copied by hand at the call site,
 * because no import statement names it — that boundary is stated here so it is
 * a decision and not an accident.
 *
 * MISSING SOURCES ARE SKIPPED, never thrown (f0149456a's exact rule): on a tree
 * that lacks a listed module the fixture must surface the module's REAL error,
 * not a fixture-construction crash. Resolution mirrors Node's file rules for
 * the extensions this corpus uses (as-is, .mjs, .js, .cjs, index.mjs, index.js).
 *
 * @param {object} args
 * @param {string} args.fromRoot  repo root of the SOURCE tree (files copied FROM)
 * @param {string} args.toRoot    fixture repo root (files copied INTO, mirrored by relative path)
 * @param {string[]} args.entries absolute path(s) of the seed module(s), e.g. the generator
 * @returns {string[]} repo-relative paths actually copied, in copy order
 */
import fs from "node:fs";
import path from "node:path";

// Column-0 `import ... from "…"` / `import "…"` / `export ... from "…"` /
// `const|let|var x = require("…")`. Relative specifiers only — bare and
// node:-prefixed specifiers are builtins/packages, which a fixture repo never
// carries.
const TOP_LEVEL_REL_RE =
  /^(?:import\s[^\n]*?from\s*|import\s*|export\s[^\n]*?from\s*|(?:const|let|var)\s[^=\n]*?=\s*require\()["'](\.[^"']+)["']/;

function resolveModule(base) {
  const candidates = [base, `${base}.mjs`, `${base}.js`, `${base}.cjs`, path.join(base, "index.mjs"), path.join(base, "index.js")];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export function copyStaticImportClosure({ fromRoot, toRoot, entries }) {
  const copied = [];
  const seen = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const source = queue.shift();
    if (seen.has(source)) continue;
    seen.add(source);
    const rel = path.relative(fromRoot, source);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue; // never copy from outside the source tree
    const dest = path.join(toRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
    copied.push(rel);
    for (const line of fs.readFileSync(source, "utf8").split("\n")) {
      const match = TOP_LEVEL_REL_RE.exec(line);
      if (!match) continue;
      const resolved = resolveModule(path.resolve(path.dirname(source), match[1]));
      if (resolved) queue.push(resolved); // absent ⇒ skipped, surfaced as the module's real error
    }
  }
  return copied;
}
