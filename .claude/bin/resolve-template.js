#!/usr/bin/env node
/**
 * Canonical COC USE template resolver — finds or fetches the template
 * for the current project. Replaces the legacy scripts/resolve-template.js
 * shim (added to manifest's `obsoleted:` list in v2.9.1).
 *
 * Usage: node .claude/bin/resolve-template.js [project-dir]
 * Output: JSON { path, source, fresh } or { error }
 * Exit:   0 on success, 1 on error
 *
 * Resolution order (see ../hooks/lib/template-resolver.js):
 *   1. KAILASH_COC_TEMPLATE_PATH env var (developer escape hatch — explicit override)
 *   2. Cache at ~/.cache/kailash-coc/<template>/  (auto-updated via git fetch + reset --hard)
 *   3. Shallow clone from GitHub if no cache exists
 *   4. Last-resort offline fallback: local sibling directory (only used when network is unreachable)
 */

const { resolveTemplate } = require("../hooks/lib/template-resolver");

const cwd = process.argv[2] || process.cwd();
const result = resolveTemplate(cwd);

console.log(JSON.stringify(result, null, 2));
process.exit(result.error ? 1 : 0);
