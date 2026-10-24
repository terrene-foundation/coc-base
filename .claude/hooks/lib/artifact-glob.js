'use strict';

function expandBraces(glob) {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(glob);
  if (!m) return [glob];
  const head = glob.slice(0, m.index);
  const tail = glob.slice(m.index + m[0].length);
  return m[1].split(",").flatMap((alt) => expandBraces(head + alt + tail));
}

// `?` is ONE non-`/` character (2026-09-25), as in Claude Code's matcher. It
// was escaped to a literal, so `**/?*` matched no real path and a rule using it
// charged nothing. Measured: no emitted-artifact or manifest glob changes
// verdict (emit-cli-artifacts --out diffs clean against the parent).
function globBody(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return escaped
    .replace(/\?/g, "__ONECHAR__")
    .replace(/(^|\/)\*\*\//g, "$1__ANYSEGS__")
    .replace(/\*\*/g, "__DOUBLESTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLESTAR__/g, ".*")
    .replace(/__ANYSEGS__/g, "(?:.*/)?")
    .replace(/__ONECHAR__/g, "[^/]");
}

function globSource(glob) {
  const bodies = expandBraces(glob.replace(/^\.\//, "")).map(globBody);
  return bodies.length === 1 ? `^${bodies[0]}$` : `^(?:${bodies.join("|")})$`;
}

function globToRegex(glob) {
  // Escape regex metacharacters, then re-expand glob tokens. `?` is one non-`/`
  // character (never a regex 0-or-1 quantifier) — see globBody().
  // A `**/` at the START of the pattern OR immediately after a `/` matches ZERO
  // or more path segments, so it compiles to `(?:.*/)?` — which keeps the `/`
  // boundary (a bare `.*` would substring-match `yx` for `**/x`). Measured
  // against Claude Code 2.1.226: the LEADING case 2/2 (loom#1597), the INTERIOR
  // case 2/2 on three glob shapes (S21-GLOB-INTERIOR.md). Both positions are
  // zero-or-more in CC; treating the interior as >=1 silently defeated 12 corpus
  // globs' stated intent. Brace sets and a leading `./`: see expandBraces().
  return new RegExp(globSource(glob));
}

module.exports = { globToRegex };
