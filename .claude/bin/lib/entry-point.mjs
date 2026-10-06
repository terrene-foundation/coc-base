/**
 * entry-point.mjs — the ONE "was this module run as the entry script?" check.
 *
 * Every CLI under `.claude/bin/` and `.claude/test-harness/` runs its `main()`
 * only when it is the process entry point, so that importing it (from a test,
 * a sibling gate, an audit fixture) runs nothing. That check MUST go through
 * this module. The regrowth guard
 * `.claude/test-harness/tests/entry-point-guard-single-source.test.mjs` reds
 * on any other spelling.
 *
 * Why one implementation, and why real paths: Node's ESM loader sets
 * `import.meta.url` from the file's REAL path, while `process.argv[1]` keeps the
 * path as typed. Through a symlinked directory (on macOS `/tmp` ->
 * `/private/tmp`, a symlinked checkout, a symlink on PATH) the two differ for
 * the same file. A lexical comparison — `resolve(argv1) === filename`,
 * `` import.meta.url === `file://${argv1}` ``, `pathToFileURL(argv1).href` —
 * is then false, `main()` never runs, and the script prints NOTHING and EXITS 0:
 * a gate reporting success having checked nothing. The URL-string forms fail
 * the same way on any path containing a space or non-ASCII character, which
 * `import.meta.url` percent-encodes and `argv[1]` does not. 105 scripts
 * carried their own copy of this check in about a dozen spellings, most of them
 * lexical (101 under `.claude/bin/` + `.claude/test-harness/`, 4 under
 * `scripts/` + `tools/`, enumerated at bb98aea4b); 955f7890f fixed four.
 *
 * Both sides go through the SAME resolver (`realpathSync`), per
 * `rules/security.md` § Path Containment. Only `realpathSync` is guarded: when
 * a path does not resolve on disk (a virtual entrypoint, a deleted file) the
 * comparison falls back to `resolve()` on both sides, which is correct whenever
 * no symlink is in play — the only case where resolution can fail for a file
 * Node actually loaded.
 *
 * Dependencies: Node.js built-ins only. This file SHIPS: it is on
 * `sync-tier-aware.mjs::ALWAYS_INCLUDE`, because shipped bin tools import it
 * statically and a static import that does not ship is an ERR_MODULE_NOT_FOUND
 * at the consumer.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * True when `argv1` (the entry path as typed) names the same file as
 * `filename` (a filesystem PATH, never a URL — convert with `fileURLToPath` at
 * the call site). False when `argv1` is absent: `node -e`, the REPL and
 * embedders leave it undefined, and an absent entry is simply "not main".
 */
export function isInvokedAsMain(argv1, filename) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(filename);
  } catch {
    return resolve(argv1) === resolve(filename);
  }
}

/**
 * The call-site form: `if (isMainModule(import.meta.url)) main();`.
 * A non-`file:` module URL (data:, http:) is never a CLI entry point.
 */
export function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  if (!String(importMetaUrl).startsWith("file:")) return false;
  return isInvokedAsMain(argv1, fileURLToPath(importMetaUrl));
}
