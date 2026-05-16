/*
 * Variant overlay resolver — manifest-first, path-mirror fallback.
 *
 * sync-manifest.yaml::variants is the declarative source of truth for which
 * language/CLI axis overlay applies to which global artifact. The legacy
 * path-mirror logic (overlay_path = `variants/<axis>/<category>/<relPath>`)
 * is correct for the majority of entries but silently fails on two cases:
 *
 *   1. Rename — manifest declares `<axis>: variants/<axis>/<category>/<new-name>.md`
 *      The path-mirror lookup misses the rename and ships the global.
 *
 *   2. Phantom — manifest declares `<axis>: null` to mean "no overlay" but a
 *      legacy file at the mirror path exists on disk; the path-mirror lookup
 *      silently picks it up, overriding the manifest's intent.
 *
 * resolveOverlay() consults the manifest map first. On an explicit declaration
 * it returns the exact overlay path; on `null` it returns `kind: "manifest-null"`
 * which the caller MUST treat as "no overlay applies". When the manifest is
 * silent for that (global, axis) pair, the resolver falls through to path-mirror.
 *
 * Exports:
 *   loadManifestVariants()      → Map<globalKey, Map<axis, overlayPath|null>>
 *   resolveOverlay(category, relPath, axis) → { kind, path, destRelPath }
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.resolve(__dirname, "..", "..", "..");

// Memoized parse — manifest does not change during one process run.
let _manifestVariants = null;

// ────────────────────────────────────────────────────────────────
// Narrow regex parse of the `variants:` block in sync-manifest.yaml.
// Matches the existing convention in emit.mjs::loadPerRuleBudgets —
// deliberate narrow regex over a YAML dependency. Block shape:
//
//   variants:
//     <global-path>:
//       <axis>: <overlay-relative-path>|null
//       <axis>: ...
//     <global-path>:
//       ...
//   <next-top-level-key>:
// ────────────────────────────────────────────────────────────────
export function loadManifestVariants() {
  if (_manifestVariants !== null) return _manifestVariants;

  const manifestPath = path.join(REPO, ".claude", "sync-manifest.yaml");
  const src = fs.readFileSync(manifestPath, "utf8");

  // Extract the `variants:` block until the next top-level key OR EOF.
  // The `(?![\s\S])` (end-of-input) alternative protects against the failure
  // mode where `variants:` becomes the last top-level key — without it the
  // regex returns null and every overlay silently falls through to
  // path-mirror. NOTE: a naive `|$` with /m flag matches every line-ending
  // (each `\n` is end-of-line) and the lazy quantifier captures an empty
  // block; `(?![\s\S])` is the JS idiom for end-of-string regardless of /m.
  const blockMatch = src.match(
    /^variants:\s*\n([\s\S]*?)(?=\n[a-zA-Z_][a-zA-Z0-9_-]*:|(?![\s\S]))/m,
  );
  const map = new Map();
  if (!blockMatch) {
    _manifestVariants = map;
    return map;
  }

  const lines = blockMatch[1].split("\n");
  let currentKey = null;
  let currentAxes = null;
  const keyRe = /^ {2}(\S.*?):\s*$/;
  // axisRe accepts an optional value (handles the empty-value malformed-line
  // case — see normalization below). Trailing `# comment` is stripped.
  const axisRe = /^ {4}(\w+):\s*(.*?)\s*$/;

  for (const ln of lines) {
    if (/^\s*#/.test(ln)) continue; // skip whole-line comments
    const km = ln.match(keyRe);
    if (km) {
      currentKey = km[1];
      currentAxes = new Map();
      map.set(currentKey, currentAxes);
      continue;
    }
    const am = ln.match(axisRe);
    if (am && currentAxes) {
      const axis = am[1];
      // Normalize: strip inline `# comment`, strip surrounding quotes.
      let raw = am[2].replace(/\s+#.*$/, "").trim();
      if (
        (raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))
      ) {
        raw = raw.slice(1, -1);
      }
      if (raw === "" || raw === "null" || raw === "~") {
        // Empty value treated identically to literal `null` (declarative
        // intent: no overlay applies). Strict mode would halt; lenient is
        // chosen here so authors mid-edit don't crash the emitter.
        currentAxes.set(axis, null);
      } else {
        currentAxes.set(axis, raw);
      }
    }
  }

  _manifestVariants = map;
  return map;
}

// ────────────────────────────────────────────────────────────────
// resolveOverlay — return the overlay descriptor for one (global, axis) pair.
//
// category: "rules" | "skills" | "commands" | "agents" | ...
// relPath:  path relative to .claude/<category>/ — e.g.
//           "10-deployment-git/python-version-bump.md" for a skill sub-file,
//           or "agents.md" for a top-level rule.
// axis:     a single overlay axis token — language ("py", "rs", "rb", "prism",
//           "base") OR CLI ("codex", "gemini") OR ternary ("rs-codex" etc.).
//
// Return shape:
//   {
//     kind:        "manifest-null" | "manifest-explicit" | "path-mirror",
//     path:        absolute path to overlay file (null when kind=manifest-null),
//     destRelPath: relPath under <category>/ on the destination tree (renamed
//                  basename when manifest-explicit + basename differs from global,
//                  else identical to input relPath),
//   }
//
// Caller responsibilities:
//   - kind=manifest-null      → skip overlay (do NOT path-mirror as fallback)
//   - kind=manifest-explicit  → fs.existsSync(path) MUST be true; otherwise
//                               the manifest declares a missing file —
//                               structural defect, halt.
//   - kind=path-mirror        → fs.existsSync(path) determines whether overlay
//                               actually applies (legacy semantics).
// ────────────────────────────────────────────────────────────────
export function resolveOverlay(category, relPath, axis) {
  const variants = loadManifestVariants();
  const key = `${category}/${relPath}`;

  if (variants.has(key)) {
    const axes = variants.get(key);
    if (axes.has(axis)) {
      const declared = axes.get(axis);
      if (declared === null) {
        return { kind: "manifest-null", path: null, destRelPath: relPath };
      }
      // Manifest values are paths relative to .claude/.
      const overlayAbs = path.join(REPO, ".claude", declared);
      const overlayBase = path.basename(declared);
      const globalBase = path.basename(relPath);
      let destRelPath = relPath;
      if (overlayBase !== globalBase) {
        // Rename — destination basename follows overlay basename.
        const dir = path.dirname(relPath);
        destRelPath = dir === "." ? overlayBase : path.posix.join(dir, overlayBase);
      }
      return { kind: "manifest-explicit", path: overlayAbs, destRelPath };
    }
  }

  // Path-mirror fallback.
  const mirror = path.join(REPO, ".claude", "variants", axis, category, relPath);
  return { kind: "path-mirror", path: mirror, destRelPath: relPath };
}

// Test-only: clear memoized cache (used by audit fixtures).
export function _resetManifestCache() {
  _manifestVariants = null;
}
