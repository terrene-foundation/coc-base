"use strict";
/**
 * source-code-view — the CODE of a source file, for lexical pattern checks.
 *
 * WHY THIS EXISTS. `integration-hygiene.js` and `validate-workflow.js` ran their
 * pattern checks over the raw file text, so they read comments, docstrings and
 * string literals as if they were code. `integration-hygiene.js` flagged its OWN
 * header comment as a silent exception swallow, because the header describes the
 * swallow shape it detects. `validate-workflow.js` raised a BLOCKING
 * NotImplementedError finding on a Python docstring that mentions the exception.
 * A per-line "starts with #" skip missed trailing comments, the middle lines of
 * block comments, and docstrings. This module is the one tokenizer both hooks use.
 *
 * TWO VIEWS, both the SAME LENGTH as the input with every newline in place, so
 * a match index or line number read from a view is the same in the original:
 *
 *   codeView(src, lang)                       comments + docstrings -> spaces;
 *                                             string literals KEPT (SQL, model
 *                                             ids and secrets live in strings)
 *   codeView(src, lang, { maskStrings: true }) ALSO string/regex literal BODIES
 *                                             -> spaces, delimiters kept; code
 *                                             inside JS `${}` / Ruby `#{}` kept
 *
 * Per language (`languageForPath`):
 *   python  `#` comments. A string literal that is a whole statement (it starts
 *           a logical line at bracket depth 0 and is followed only by a newline,
 *           `;`, `#` or EOF) is a docstring and is blanked like a comment. Prefixes
 *           r/b/u/f/t and pairs, triple quotes, backslash escapes.
 *   js      `//`, block comments, a leading `#!` line. '...' and "..." end at the
 *           line; template literals nest `${}`; a regex literal is recognised when
 *           `/` follows an operator, an opening bracket or a keyword such as
 *           `return`, so quotes and `//` inside `/["'\/]/` are not misread.
 *   rust    `//` (incl. `///`, `//!`), NESTED block comments, "..." spanning
 *           lines, r#"..."# raw strings, b"..."; a char literal such as '"' is
 *           told apart from a lifetime such as 'a.
 *   ruby    `#` comments, `=begin`/`=end`, `__END__`; "..." and `...` with `#{}`,
 *           '...', heredocs (<<~ID, <<-ID, <<ID uppercase, quoted ids), and
 *           %q/%Q/%w/%W/%i/%I/%s/%r/%x literals with bracket delimiters.
 *   other   returned unchanged — no stripping, so no silent change in behaviour.
 *
 * UNTERMINATED OPENERS READ AS CODE. A comment, string or template opener with no
 * closer (an Edit fragment, a JSX apostrophe in `<p>Don't</p>`) is not treated as
 * a comment or string: its opening character is read as code and scanning goes on.
 * The failure then leans toward the checks' previous behaviour (a possible false
 * positive), never toward hiding code.
 *
 * KNOWN RESIDUALS, named so a quiet check is not read as "nothing there":
 *   - Python f-string `{}` fields and Ruby heredoc / %-literal `#{}` fields are
 *     masked as literal text under maskStrings, so code inside them is not seen.
 *   - JSX text is not modelled: an apostrophe pair on one line is read as a
 *     string, and `</tag>` may be read as the start of a regex literal. Both are
 *     confined to that line or that literal.
 *   - Ruby regex literals, `?x` character literals and percent literals with
 *     non-bracket delimiters are not modelled.
 *   - A Python string at the start of a line inside an Edit fragment whose
 *     opening bracket is outside the fragment is read as a docstring.
 */

const path = require("path");

const LANG_BY_EXT = {
  ".py": "python",
  ".rs": "rust",
  ".js": "js",
  ".jsx": "js",
  ".ts": "js",
  ".tsx": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".rb": "ruby",
};

function languageForPath(filePath) {
  return LANG_BY_EXT[path.extname(String(filePath || "")).toLowerCase()] || null;
}

// ------------------------------------------------------------------ helpers

function isIdentStart(c) {
  return (
    c !== undefined &&
    ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$" || c.charCodeAt(0) > 127)
  );
}

function isIdentChar(c) {
  return isIdentStart(c) || (c !== undefined && c >= "0" && c <= "9");
}

function lineEnd(src, i) {
  const e = src.indexOf("\n", i);
  return e === -1 ? src.length : e;
}

function blankRange(out, start, end) {
  for (let k = start; k < end; k++) {
    if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  }
}

// Comments and docstrings. Kept separate from literal masking so each has one
// reachable call site.
function blankComment(ctx, start, end) {
  blankRange(ctx.out, start, end);
}

function blankLiteral(ctx, start, end) {
  if (ctx.mask) blankRange(ctx.out, start, end);
}

// Undo everything written from `start` on: used when an opener turns out to be
// unterminated and is re-read as code.
function restore(ctx, start) {
  for (let k = start; k < ctx.src.length; k++) ctx.out[k] = ctx.src[k];
}

// Skip a backslash escape starting at `j`; a backslash before CRLF skips both.
function afterEscape(src, j) {
  return src[j + 1] === "\r" && src[j + 2] === "\n" ? j + 3 : j + 2;
}

// ------------------------------------------------------------------ JS / TS

const JS_REGEX_AFTER_WORD = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await",
]);

// '...' or "..." — cannot span a line. Returns the index past the closing quote,
// or -1 when unterminated on its line.
function jsQuotedEnd(src, i, q) {
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") { j = afterEscape(src, j); continue; }
    if (c === q) return j + 1;
    if (c === "\n") return -1;
    j++;
  }
  return -1;
}

function jsRegexEnd(src, i) {
  let j = i + 1;
  let inClass = false;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") { j += 2; continue; }
    if (c === "\n" || c === "\r") return null;
    if (inClass) {
      if (c === "]") inClass = false;
    } else if (c === "[") {
      inClass = true;
    } else if (c === "/") {
      let e = j + 1;
      while (e < src.length && isIdentChar(src[e])) e++;
      return { bodyEnd: j, end: e };
    }
    j++;
  }
  return null;
}

function jsTemplate(ctx, start) {
  const { src } = ctx;
  let i = start + 1;
  let chunk = i;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "`") { blankLiteral(ctx, chunk, i); return i + 1; }
    if (c === "$" && src[i + 1] === "{") {
      blankLiteral(ctx, chunk, i);
      const e = jsCode(ctx, i + 2, true);
      if (e === -1) break;
      i = e;
      chunk = i;
      continue;
    }
    i++;
  }
  restore(ctx, start);
  return -1;
}

// Scan JS code from `i`. Inside a template `${}` returns the index past its
// closing brace (or -1 at EOF); at top level returns the source length.
function jsCode(ctx, i, inTemplateExpr) {
  const { src } = ctx;
  const n = src.length;
  let depth = 0;
  let regexOk = true;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      const e = lineEnd(src, i);
      blankComment(ctx, i, e);
      i = e;
      continue;
    }
    if (c === "/" && d === "*") {
      const close = src.indexOf("*/", i + 2);
      if (close !== -1) {
        blankComment(ctx, i, close + 2);
        i = close + 2;
        continue;
      }
      i++;
      regexOk = true;
      continue;
    }
    if (c === "'" || c === '"') {
      const e = jsQuotedEnd(src, i, c);
      if (e === -1) { i++; regexOk = true; continue; }
      blankLiteral(ctx, i + 1, e - 1);
      i = e;
      regexOk = false;
      continue;
    }
    if (c === "`") {
      const e = jsTemplate(ctx, i);
      if (e === -1) { i++; regexOk = true; continue; }
      i = e;
      regexOk = false;
      continue;
    }
    if (c === "/" && regexOk) {
      const r = jsRegexEnd(src, i);
      if (r) {
        blankLiteral(ctx, i + 1, r.bodyEnd);
        i = r.end;
        regexOk = false;
        continue;
      }
      i++;
      continue;
    }
    if (isIdentChar(c)) {
      const s = i;
      while (i < n && isIdentChar(src[i])) i++;
      regexOk = JS_REGEX_AFTER_WORD.has(src.slice(s, i));
      continue;
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (inTemplateExpr) {
      if (c === "{") depth++;
      else if (c === "}") {
        if (depth === 0) return i + 1;
        depth--;
      }
    }
    regexOk = !(c === ")" || c === "]");
    i++;
  }
  return inTemplateExpr ? -1 : n;
}

function scanJs(ctx) {
  let i = 0;
  if (ctx.src.startsWith("#!")) {
    i = lineEnd(ctx.src, 0);
    blankComment(ctx, 0, i);
  }
  jsCode(ctx, i, false);
}

// ------------------------------------------------------------------ Python

const PY_PREFIX = /^(?:[rRuUbBfFtT]|[rR][bBfFtT]|[bBfFtT][rR])$/;

// Returns { bodyStart, bodyEnd, end } for the literal whose quote is at `qi`,
// or null when unterminated.
function pyStringEnd(src, qi, q) {
  const n = src.length;
  if (src[qi + 1] === q && src[qi + 2] === q) {
    let j = qi + 3;
    while (j < n) {
      if (src[j] === "\\") { j += 2; continue; }
      if (src[j] === q && src[j + 1] === q && src[j + 2] === q) {
        return { bodyStart: qi + 3, bodyEnd: j, end: j + 3 };
      }
      j++;
    }
    return null;
  }
  let j = qi + 1;
  while (j < n) {
    const c = src[j];
    if (c === "\\") { j = afterEscape(src, j); continue; }
    if (c === q) return { bodyStart: qi + 1, bodyEnd: j, end: j + 1 };
    if (c === "\n") return null;
    j++;
  }
  return null;
}

// True when only whitespace, then a newline / `;` / `#` / EOF, follows `j`.
function pyStatementEndsAt(src, j) {
  while (j < src.length && (src[j] === " " || src[j] === "\t" || src[j] === "\r")) j++;
  return j >= src.length || src[j] === "\n" || src[j] === ";" || src[j] === "#";
}

function scanPython(ctx) {
  const { src } = ctx;
  const n = src.length;
  let i = 0;
  let depth = 0;
  let lineStart = true;
  while (i < n) {
    const c = src[i];
    if (c === "#") {
      const e = lineEnd(src, i);
      blankComment(ctx, i, e);
      i = e;
      continue;
    }
    if (c === "\n") {
      if (depth === 0) lineStart = true;
      i++;
      continue;
    }
    if (c === "\\" && (src[i + 1] === "\n" || (src[i + 1] === "\r" && src[i + 2] === "\n"))) {
      i = afterEscape(src, i);
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\f") { i++; continue; }
    let quoteAt = i;
    if (isIdentChar(c)) {
      let j = i;
      while (j < n && isIdentChar(src[j])) j++;
      if ((src[j] === '"' || src[j] === "'") && PY_PREFIX.test(src.slice(i, j))) {
        quoteAt = j;
      } else {
        i = j;
        lineStart = false;
        continue;
      }
    }
    const q = src[quoteAt];
    if (q === '"' || q === "'") {
      const r = pyStringEnd(src, quoteAt, q);
      if (!r) {
        i = quoteAt + 1;
        lineStart = false;
        continue;
      }
      if (lineStart && depth === 0 && pyStatementEndsAt(src, r.end)) {
        blankComment(ctx, i, r.end);
      } else {
        blankLiteral(ctx, r.bodyStart, r.bodyEnd);
      }
      i = r.end;
      lineStart = false;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    lineStart = c === ";" && depth === 0;
    i++;
  }
}

// ------------------------------------------------------------------ Rust

function rustBlockCommentEnd(src, i) {
  let depth = 1;
  let j = i + 2;
  while (j < src.length) {
    if (src[j] === "/" && src[j + 1] === "*") { depth++; j += 2; continue; }
    if (src[j] === "*" && src[j + 1] === "/") {
      depth--;
      j += 2;
      if (depth === 0) return j;
      continue;
    }
    j++;
  }
  return -1;
}

function rustStringEnd(src, i) {
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === "\\") { j += 2; continue; }
    if (src[j] === '"') return j + 1;
    j++;
  }
  return -1;
}

// A char literal ('a', '"', '\'', '\u{1F600}', a surrogate pair) or -1 for a
// lifetime / label such as 'a or 'static.
function rustCharEnd(src, i) {
  const c1 = src[i + 1];
  if (c1 === "\\") {
    for (let j = i + 3; j < Math.min(src.length, i + 14); j++) {
      if (src[j] === "'") return j + 1;
      if (src[j] === "\n") return -1;
    }
    return -1;
  }
  if (c1 !== undefined && c1 !== "'" && c1 !== "\n" && src[i + 2] === "'") return i + 3;
  if (c1 !== undefined && c1.charCodeAt(0) >= 0xd800 && c1.charCodeAt(0) <= 0xdbff && src[i + 3] === "'") {
    return i + 4;
  }
  return -1;
}

function scanRust(ctx) {
  const { src } = ctx;
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      const e = lineEnd(src, i);
      blankComment(ctx, i, e);
      i = e;
      continue;
    }
    if (c === "/" && d === "*") {
      const e = rustBlockCommentEnd(src, i);
      if (e === -1) { i++; continue; }
      blankComment(ctx, i, e);
      i = e;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i;
      while (j < n && isIdentChar(src[j])) j++;
      const w = src.slice(i, j);
      if ((w === "r" || w === "br" || w === "cr") && (src[j] === '"' || src[j] === "#")) {
        let h = j;
        while (src[h] === "#") h++;
        if (src[h] === '"') {
          const closer = '"' + "#".repeat(h - j);
          const close = src.indexOf(closer, h + 1);
          if (close !== -1) {
            blankLiteral(ctx, h + 1, close);
            i = close + closer.length;
            continue;
          }
        }
        i = j;
        continue;
      }
      if (!((w === "b" || w === "c") && (src[j] === '"' || src[j] === "'"))) {
        i = j;
        continue;
      }
      i = j; // a b"..." / c"..." / b'x' prefix: the literal starts at `j`
    }
    const q = src[i];
    if (q === '"') {
      const e = rustStringEnd(src, i);
      if (e === -1) { i++; continue; }
      blankLiteral(ctx, i + 1, e - 1);
      i = e;
      continue;
    }
    if (q === "'") {
      const e = rustCharEnd(src, i);
      if (e !== -1) blankLiteral(ctx, i + 1, e - 1);
      i = e === -1 ? i + 1 : e;
      continue;
    }
    i++;
  }
}

// ------------------------------------------------------------------ Ruby

const RUBY_HEREDOC = /<<([~-]?)(["'`]?)([A-Za-z_]\w*)\2/y;
const RUBY_PERCENT = /%[qQwWiIsrx]([({[<])/y;
const RUBY_CLOSER = { "(": ")", "{": "}", "[": "]", "<": ">" };

function rubySingleEnd(src, i) {
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === "\\") { j += 2; continue; }
    if (src[j] === "'") return j + 1;
    j++;
  }
  return -1;
}

// "..." or `...` with #{} interpolation. Returns the index past the closer or -1.
function rubyInterpolated(ctx, start, q) {
  const { src } = ctx;
  let j = start + 1;
  let chunk = j;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") { j += 2; continue; }
    if (c === q) { blankLiteral(ctx, chunk, j); return j + 1; }
    if (c === "#" && src[j + 1] === "{") {
      blankLiteral(ctx, chunk, j);
      const e = rubyCode(ctx, j + 2, true);
      if (e === -1) break;
      j = e;
      chunk = j;
      continue;
    }
    j++;
  }
  restore(ctx, start);
  return -1;
}

function rubyPercentEnd(src, i, open) {
  const close = RUBY_CLOSER[open];
  let depth = 1;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") { j += 2; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return j;
    j++;
  }
  return -1;
}

// Heredoc bodies begin at `i` (a line start). Returns where code resumes.
function rubyHeredocBodies(ctx, i, pending) {
  const { src } = ctx;
  for (const h of pending) {
    const bodyStart = i;
    let j = i;
    let found = false;
    while (j < src.length) {
      const e = lineEnd(src, j);
      const line = src.slice(j, e).replace(/\r$/, "");
      if ((h.indented ? line.trim() : line) === h.id) {
        blankLiteral(ctx, bodyStart, j);
        i = Math.min(src.length, e + 1);
        found = true;
        break;
      }
      j = e + 1;
    }
    if (!found) return bodyStart;
  }
  return i;
}

function rubyCode(ctx, i, inInterpolation) {
  const { src } = ctx;
  const n = src.length;
  let depth = 0;
  let lineStart = i === 0 || src[i - 1] === "\n";
  let pending = [];
  while (i < n) {
    const c = src[i];
    if (lineStart && !inInterpolation) {
      if (/^=begin(?:\s|$)/.test(src.slice(i, i + 7))) {
        const m = /\n=end(?=\s|$)/g;
        m.lastIndex = i;
        const r = m.exec(src);
        if (r) {
          const e = lineEnd(src, r.index + 1);
          blankComment(ctx, i, e);
          i = e;
          lineStart = false;
          continue;
        }
      }
      if (/^__END__(?:\r?\n|$)/.test(src.slice(i, i + 9))) {
        blankComment(ctx, i, n);
        return n;
      }
    }
    if (c === "\n") {
      i++;
      lineStart = true;
      if (pending.length) {
        i = rubyHeredocBodies(ctx, i, pending);
        pending = [];
      }
      continue;
    }
    lineStart = false;
    if (c === "#") {
      const e = lineEnd(src, i);
      blankComment(ctx, i, e);
      i = e;
      continue;
    }
    if (inInterpolation) {
      if (c === "{") depth++;
      else if (c === "}") {
        if (depth === 0) return i + 1;
        depth--;
      }
    }
    if (c === '"' || c === "`") {
      const e = rubyInterpolated(ctx, i, c);
      i = e === -1 ? i + 1 : e;
      continue;
    }
    if (c === "'") {
      const e = rubySingleEnd(src, i);
      if (e === -1) { i++; continue; }
      blankLiteral(ctx, i + 1, e - 1);
      i = e;
      continue;
    }
    if (c === "<" && src[i + 1] === "<") {
      RUBY_HEREDOC.lastIndex = i;
      const m = RUBY_HEREDOC.exec(src);
      if (m && (m[1] || m[2] || /^[A-Z_][A-Z0-9_]*$/.test(m[3]))) {
        pending.push({ id: m[3], indented: m[1] !== "" });
        i += m[0].length;
        continue;
      }
    }
    if (c === "%") {
      RUBY_PERCENT.lastIndex = i;
      const m = RUBY_PERCENT.exec(src);
      if (m) {
        const bodyStart = i + m[0].length;
        const close = rubyPercentEnd(src, bodyStart, m[1]);
        if (close !== -1) {
          blankLiteral(ctx, bodyStart, close);
          i = close + 1;
          continue;
        }
      }
    }
    i++;
  }
  return inInterpolation ? -1 : n;
}

function scanRuby(ctx) {
  rubyCode(ctx, 0, false);
}

// ------------------------------------------------------------------ entry

const SCANNERS = { js: scanJs, python: scanPython, rust: scanRust, ruby: scanRuby };

/**
 * @param {string} content  source text
 * @param {string|null} lang  "python" | "js" | "rust" | "ruby" (see languageForPath)
 * @param {{maskStrings?: boolean}} [opts]
 * @returns {string} same length as `content`, newlines in place; comments and
 *   docstrings blanked, and with `maskStrings` string/regex literal bodies too.
 *   An unknown `lang` returns `content` unchanged.
 */
function codeView(content, lang, opts = {}) {
  if (typeof content !== "string" || content.length === 0) return content;
  const scan = SCANNERS[lang];
  if (!scan) return content;
  const ctx = { src: content, out: content.split(""), mask: Boolean(opts.maskStrings) };
  scan(ctx);
  return ctx.out.join("");
}

module.exports = { codeView, languageForPath };
