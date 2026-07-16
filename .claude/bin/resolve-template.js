#!/usr/bin/env node
/**
 * Canonical COC USE template resolver — finds or fetches the template
 * for the current project. Replaces the legacy scripts/resolve-template.js
 * shim (added to manifest's `obsoleted:` list in v2.9.1).
 *
 * Usage:
 *   node .claude/bin/resolve-template.js [project-dir]
 *     → cwd-derived lane: reads <project-dir>/.claude/VERSION, resolves the
 *       template that VERSION points at. Output: JSON { path, source, fresh }.
 *   node .claude/bin/resolve-template.js --template <name>
 *     → name lane (what /migrate uses): resolves a SPECIFIC named sister
 *       template (e.g. kailash-coc-py / coc-base), independent of any VERSION.
 *       Output: a BARE PATH on stdout (one line) so `SISTER=$(...)` captures a
 *       usable directory. Errors go to stderr.
 * Exit:   0 on success, 1 on error
 *
 * Resolution order (see ../hooks/lib/template-resolver.js), applied to the
 * resolved template name in EITHER lane:
 *   1. KAILASH_COC_TEMPLATE_PATH env var (developer escape hatch — explicit override)
 *   2. Cache at ~/.cache/kailash-coc/<template>/  (auto-updated via git fetch + reset --hard)
 *   3. Shallow clone from GitHub if no cache exists
 *   4. Last-resort offline fallback: local sibling directory (only used when network is unreachable)
 */

const {
  resolveTemplate,
  resolveTemplateByName,
} = require("../hooks/lib/template-resolver");

const argv = process.argv.slice(2);
const tplFlag = argv.indexOf("--template");

if (tplFlag !== -1) {
  // Name lane: --template <name> → bare path on stdout, error on stderr.
  const name = argv[tplFlag + 1];
  if (!name || name.startsWith("--")) {
    console.error("resolve-template.js: --template requires a template name");
    process.exit(1);
  }
  const result = resolveTemplateByName(name);
  if (result.error) {
    console.error(`resolve-template.js: ${result.error}`);
    process.exit(1);
  }
  // BARE path (no JSON) so callers can `SISTER=$(... --template <name>)`.
  console.log(result.path);
  process.exit(0);
}

// cwd-derived lane (unchanged): positional [project-dir], JSON output.
const cwd = argv[0] || process.cwd();
const result = resolveTemplate(cwd);
console.log(JSON.stringify(result, null, 2));
process.exit(result.error ? 1 : 0);
