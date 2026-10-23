/**
 * workflow-launch-scan.js — PROVE what subagent launches a Workflow script makes, and read what it
 * declares for each, so effort routing covers WORKFLOW agents too (finding ROOT-W1, 2026-10-12).
 *
 * WHY THIS EXISTS. An agent the Workflow tool spawns — `agent(prompt, {effort, agentType, …})` inside
 * the script — does NOT fire PreToolUse `Task|Agent`. MEASURED 2026-10-12: the dispatch ledger held a
 * launch row for a plain Agent control and none for two workflow agents launched just before it. So
 * `dispatch-contract-guard.js` judges the ONE call it does see, the `Workflow` call, and needs to know
 * what each `agent(` call in its script declares. This module answers that, lexically.
 *
 * PROOF, NOT SEARCH (E3 R2 security, 2026-10-12). A scanner that FINDS `agent(` calls passes every
 * launch it fails to find — an alias (`const launch = agent`), `prompts.map(agent)`, `agent?.(`, a
 * call hidden in a `${…}` substitution or behind a mis-guessed regex — because a script with nothing
 * found reads as a script with nothing to judge. This module therefore proves the opposite: the
 * script is ALLOWED only when EVERY occurrence of the identifiers `agent` and `workflow` — in the code
 * AND inside every template substitution — is a DIRECT call `agent(`/`workflow(`, and every region of
 * the script is one the tokenizer can classify without guessing. Every other occurrence is reported in
 * `indirect`, and anything the tokenizer cannot classify — a non-ASCII character or an identifier
 * escape in code, a Unicode line separator anywhere, a `/` whose regex-or-divide reading is ambiguous —
 * makes the script UNSCANNABLE. The guard BLOCKS on both, fail-closed, with a self-correction.
 *
 * WHAT IT READS. The `Workflow` tool_input names EXACTLY ONE of: the script inline (`script`), an
 * ABSOLUTE path to one (`scriptPath`), or the `name` of a saved workflow. Only the first two are ever
 * read. Two sources, an empty script and a relative path are refused: the runtime's precedence between
 * sources and the root it resolves a relative path against are not known here, so judging one reading
 * while the runtime runs another would be a bypass. The no-follow refusal is LEAF-ONLY: the open
 * carries `O_NOFOLLOW`, which refuses a symlink in the FINAL path component and nothing else, so a
 * symlinked PARENT directory IS followed. There is no declared root a `scriptPath` must sit under —
 * no containment fence — so any absolute, readable regular file is read wherever it resolves.
 *
 * A `name` IS REFUSED, ALWAYS (E3 A5 F1, 2026-10-13). The runtime resolves a name by the `meta.name`
 * each saved `*.js` file declares, across the user, project, plugin and built-in workflow registries
 * — not by filename, and never from a `.mjs`. This module once looked a name up by FILENAME under
 * the project, and so judged a different file than the one that runs: a decoy whose filename matched
 * passed while the file whose `meta.name` matched launched a mis-routed agent. The registries the
 * runtime reads cannot be reproduced here, and mirroring its lookup would drift with it, so every
 * `name` is UNRESOLVED and the deny asks for the script inline or by absolute `scriptPath`. Built-in
 * names are refused by the same rule.
 *
 * WHAT IT CAN EVALUATE. A prompt is EVALUABLE when it is a string literal, a template literal with no
 * substitution, or a template literal whose text BEFORE its first `${` already holds a complete first
 * non-empty line (the `ROLE:` line is all the routing reads). An effort is evaluable when the second
 * argument is an object literal of plain `key: value` properties whose single `effort` key holds a
 * string literal, or that holds no `effort` key at all (the agent then inherits the session's effort —
 * reported as absent). A spread, accessor, method, computed key or repeated `effort` key ANYWHERE in it
 * is not evaluable, because the effort the call runs at could differ from the literal
 * read. Values are taken RAW — never trimmed — so the gate judges exactly the level the host is given.
 *
 * NOT A PARSER — AND THE RESIDUAL IS NAMED. A small tokenizer: strings, template literals (each
 * substitution tokenized recursively), comments, regex literals only where the previous token makes the
 * reading certain, and bracket depth. It never executes the script. What it cannot see is a launch
 * reached through no `agent`/`workflow` token at all, and it closes the routes it knows in two ways:
 *  - REFLECTIVE IDENTIFIERS (`eval`, `Function`, `constructor`, `globalThis`, `this`, `Reflect`,
 *    `import`, `require`, the prototype and property-descriptor readers, …) are reported as indirect
 *    wherever they appear AS AN IDENTIFIER TOKEN — in code, in property position and inside every
 *    template substitution. A name held in a STRING is not an identifier token, so this check alone
 *    never sees it.
 *  - COMPUTED ACCESS (E3 A5 F2, 2026-10-13). A string-held name is reached through a computed member
 *    access (`x[k]`, `x?.[k]`) or a computed key (in an object literal, a destructuring pattern or a
 *    class body). Every one whose key is not a single number literal makes the script UNSCANNABLE,
 *    because the property it reaches is named at run time and cannot be evaluated. An array literal or
 *    array pattern is told apart by the token before the `[`; where that cannot be told without a
 *    parser, the `[` is read as computed access, so the error falls on the refusing side.
 * The residual: a binding the Workflow runtime exposes under some OTHER name, or a run-time-named
 * property reached through a library call this module does not name, is NOT proven absent. Those routes
 * are bounded by the runtime (string code generation), not by this module, which does not check it.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** Cap on a script this module reads or scans. A workflow script is far below it. */
const SCRIPT_MAX_BYTES = 1024 * 1024;
/** Cap on `agent(` calls reported per script — the Workflow runtime's own lifetime cap is 1000. */
const MAX_CALLS = 1000;
/** The tool_input fields that each name a script source. Exactly one may be present. */
const SOURCE_FIELDS = ["script", "scriptPath", "name"];

/** The launch hooks. Every occurrence of one must be a direct call. */
const HOOK_IDS = new Set(["agent", "workflow"]);
/**
 * Identifiers that reach code or a binding WITHOUT naming it — a launch through one of these carries no
 * `agent` token to prove. Reported as indirect wherever they appear as an identifier token or as a QUOTED
 * property key (`{"constructor": F}`), property position included (`[].constructor.constructor` reaches `Function` through property names alone). The
 * prototype and property-descriptor readers are here because they reach a property by a STRING name, or
 * by iteration, with no `[` for the computed-access refusal to catch.
 */
const REFLECTIVE_IDS = new Set([
  "eval", "Function", "constructor", "globalThis", "global", "window", "self", "this", "Reflect", "Proxy",
  "__proto__", "prototype", "import", "require", "module", "arguments", "with", "setTimeout", "setInterval",
  "getPrototypeOf", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "__lookupGetter__", "__lookupSetter__",
]);

/** Reserved words after which a `[` begins an array literal or an array pattern, never a member access. */
const ARRAY_AFTER_WORDS = new Set(["return", "typeof", "case", "do", "else", "in", "new", "delete", "void", "throw",
  "instanceof", "const", "var", "export", "default", "extends"]);
/** Words that cannot be a for-of binding, so an `of` after one is not the for-of keyword. */
const NOT_A_BINDING = new Set(["break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete",
  "do", "else", "export", "extends", "finally", "for", "function", "if", "import", "in", "instanceof", "new", "return",
  "super", "switch", "this", "throw", "try", "typeof", "var", "void", "while", "with", "yield", "let", "static",
  "await", "async", "of", "get", "set"]);

const ID_START = /[A-Za-z_$]/;
const ID_CHAR = /[A-Za-z0-9_$]/;
const NUMBER_RX = /^(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d[\d_]*)?)n?/;
/** Keywords after which a `/` begins a regex literal. After any other identifier it is a division. */
const REGEX_AFTER_WORDS = new Set(["return", "typeof", "case", "do", "else", "in", "new", "delete", "void", "throw", "instanceof"]);
/** Words that are a keyword in one context and an identifier in another, so a `/` after one cannot be told. */
const CONTEXTUAL_WORDS = new Set(["of", "yield", "await", "let", "async", "get", "set", "static"]);
/** Cap on indirect occurrences reported one by one; the rest are counted. */
const MAX_INDIRECT = 20;
/** Keywords whose parenthesised head may be followed by a regex statement: `if (x) /re/.test(y)`. */
const PAREN_HEAD_WORDS = new Set(["if", "while", "for", "with"]);
/** Multi-character punctuators, longest first. Only their extent matters here. */
const PUNCTS = [">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
  "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<", ">>", "**"];
const CODE_WS = new Set([" ", "\t", "\n", "\r", "\f", "\v"]);

class ScanError extends Error {}

/** 1-based line of a source offset. Linear — used once per error message; scans use `lineTable`. */
function lineOf(src, offset) {
  let line = 1;
  for (let k = 0; k < offset && k < src.length; k++) if (src[k] === "\n") line++;
  return line;
}

/** A 1-based line lookup for `src`, built once (binary search over the newline offsets). */
function lineTable(src) {
  const breaks = [];
  for (let k = 0; k < src.length; k++) if (src.charCodeAt(k) === 10) breaks.push(k);
  return (offset) => {
    let lo = 0;
    let hi = breaks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (breaks[mid] < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
}

/**
 * Tokenize `src` into tokens `{t, v, s, e}`: t ∈ str | tpl | id | num | punct | regex. A template is ONE
 * token carrying `parts` (its static text chunks, raw), `hasSubst`, and `substs` — the TOKENS of each
 * `${…}` body, tokenized by this same function, never skipped. Comments and ASCII whitespace are dropped.
 * Throws `ScanError` on anything it cannot classify without guessing.
 */
function tokenize(src) {
  if (/[\u2028\u2029]/.test(src)) throw new ScanError("it contains a Unicode line or paragraph separator, which ends a `//` comment in JavaScript but not in most readers");
  const { toks } = lex(src, 0, false);
  return toks;
}

/** Lex from `i`; in substitution mode stop at the `}` that closes the `${`. Returns `{toks, end}`. */
function lex(src, i, inSubst) {
  const out = [];
  const n = src.length;
  const braces = [];
  const parens = [];
  const at = (k) => `at line ${lineOf(src, k)}`;
  while (i < n) {
    const c = src[i];
    if (CODE_WS.has(c)) { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n" && src[i] !== "\r") i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) throw new ScanError(`an unterminated comment ${at(i)}`);
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const s = i;
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === "\\") i++;
        else if (src[i] === "\n" || src[i] === "\r") throw new ScanError(`an unterminated string ${at(s)}`);
        i++;
      }
      if (i >= n) throw new ScanError(`an unterminated string ${at(s)}`);
      i++;
      out.push({ t: "str", v: src.slice(s, i), s, e: i });
      continue;
    }
    if (c === "`") { i = readTemplate(src, i, out); continue; }
    if (c === "/") {
      const mode = slashMode(out);
      if (mode === "ambiguous") {
        throw new ScanError(`a \`/\` ${at(i)} could begin a regex or a division (after \`${out[out.length - 1].v}\`) — split the statement or parenthesise it`);
      }
      if (mode === "regex") {
        const s = i;
        i++;
        let inClass = false;
        while (i < n) {
          const d = src[i];
          if (d === "\\") { i += 2; continue; }
          if (d === "\n" || d === "\r") throw new ScanError(`an unterminated regex ${at(s)}`);
          if (inClass) { if (d === "]") inClass = false; }
          else if (d === "[") inClass = true;
          else if (d === "/") break;
          i++;
        }
        if (i >= n) throw new ScanError(`an unterminated regex ${at(s)}`);
        i++;
        while (i < n && ID_CHAR.test(src[i])) i++;
        out.push({ t: "regex", v: src.slice(s, i), s, e: i });
        continue;
      }
      const v = src[i + 1] === "=" ? "/=" : "/";
      out.push({ t: "punct", v, s: i, e: i + v.length });
      i += v.length;
      continue;
    }
    if (ID_START.test(c)) {
      const s = i;
      while (i < n && ID_CHAR.test(src[i])) i++;
      if (src[i] === "\\") throw new ScanError(`an identifier written with an escape ${at(s)}`);
      out.push({ t: "id", v: src.slice(s, i), s, e: i });
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] || ""))) {
      const m = NUMBER_RX.exec(src.slice(i, i + 64));
      if (!m || m[0].length === 0) throw new ScanError(`a number it cannot read ${at(i)}`);
      const e = i + m[0].length;
      if (e < n && (ID_CHAR.test(src[e]) || src[e] === "\\")) throw new ScanError(`a number run into an identifier ${at(i)}`);
      out.push({ t: "num", v: m[0], s: i, e });
      i = e;
      continue;
    }
    if (c === "\\") throw new ScanError(`an identifier escape or stray backslash ${at(i)}`);
    if (c.charCodeAt(0) > 0x7e || c.charCodeAt(0) < 0x20) throw new ScanError(`a character it cannot classify (U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}) ${at(i)} — use plain ASCII outside strings and comments`);
    let v = c;
    for (const p of PUNCTS) if (src.startsWith(p, i)) { v = p; break; }
    if (v === "?." && /[0-9]/.test(src[i + 2] || "")) v = "?";
    if (v === "{") braces.push(i);
    if (v === "}") {
      if (braces.length === 0) {
        if (inSubst) return { toks: out, end: i + 1 };
        throw new ScanError(`an unmatched \`}\` ${at(i)}`);
      }
      braces.pop();
    }
    const tk = { t: "punct", v, s: i, e: i + v.length };
    if (v === "(") {
      const prev = out[out.length - 1];
      parens.push(!!(prev && prev.t === "id" && PAREN_HEAD_WORDS.has(prev.v) && !isPropertyName(out, out.length - 1)));
    }
    if (v === ")") tk.closesHead = parens.length > 0 ? parens.pop() : false;
    out.push(tk);
    i += v.length;
  }
  if (inSubst) throw new ScanError("an unterminated template substitution");
  return { toks: out, end: i };
}

/** True when token `k` sits in property position (`x.name`, `x?.name`). */
function isPropertyName(toks, k) {
  const p = toks[k - 1];
  return !!(p && p.t === "punct" && (p.v === "." || p.v === "?."));
}

/** Whether a `/` after the tokens so far begins a regex, a division, or cannot be told. */
function slashMode(out) {
  const p = out[out.length - 1];
  if (!p) return "regex";
  if (p.t === "num" || p.t === "str" || p.t === "tpl" || p.t === "regex") return "divide";
  if (p.t === "id") {
    if (isPropertyName(out, out.length - 1)) return "divide";
    if (CONTEXTUAL_WORDS.has(p.v)) return "ambiguous";
    return REGEX_AFTER_WORDS.has(p.v) ? "regex" : "divide";
  }
  if (p.v === "]") return "divide";
  if (p.v === ")") return p.closesHead ? "regex" : "divide";
  // `}` ends a block (regex follows) or an object literal (division follows); `++`/`--` are postfix
  // (division) or, after a line break, prefix (regex). Neither can be told without a parser.
  if (p.v === "}" || p.v === "++" || p.v === "--") return "ambiguous";
  return "regex";
}

/** Read a template literal starting at `src[i] === "\`"`; push its token; return the index after it. */
function readTemplate(src, i, out) {
  const s = i;
  const n = src.length;
  const parts = [];
  const substs = [];
  let chunk = "";
  i++;
  while (i < n) {
    const d = src[i];
    if (d === "\\") { chunk += src.slice(i, i + 2); i += 2; continue; }
    if (d === "`") {
      parts.push(chunk);
      out.push({ t: "tpl", v: src.slice(s, i + 1), parts, hasSubst: substs.length > 0, substs, s, e: i + 1 });
      return i + 1;
    }
    if (d === "$" && src[i + 1] === "{") {
      parts.push(chunk);
      chunk = "";
      const inner = lex(src, i + 2, true);
      substs.push(inner.toks);
      i = inner.end;
      continue;
    }
    chunk += d;
    i++;
  }
  throw new ScanError(`an unterminated template literal at line ${lineOf(src, s)}`);
}

/** Decode the escapes of a quoted string body or a template chunk. */
function decodeEscapes(body) {
  return body.replace(/\\(u\{[0-9A-Fa-f]+\}|u[0-9A-Fa-f]{4}|x[0-9A-Fa-f]{2}|\r\n|[\s\S])/g, (_, e) => {
    if (e[0] === "u" && e[1] === "{") return String.fromCodePoint(parseInt(e.slice(2, -1), 16));
    if (e[0] === "u" || e[0] === "x") return String.fromCharCode(parseInt(e.slice(1), 16));
    switch (e) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "b": return "\b";
      case "f": return "\f";
      case "v": return "\v";
      case "0": return "\0";
      case "\n": case "\r\n": return "";
      default: return e;
    }
  });
}

/** Split the tokens between an opening `(` at index `open` and its match into top-level arguments. */
function splitArgs(toks, open) {
  const args = [];
  let cur = [];
  let depth = 0;
  for (let k = open + 1; k < toks.length; k++) {
    const tk = toks[k];
    if (tk.t === "punct" && (tk.v === "(" || tk.v === "[" || tk.v === "{")) depth++;
    if (tk.t === "punct" && (tk.v === ")" || tk.v === "]" || tk.v === "}")) {
      if (depth === 0) {
        if (cur.length) args.push(cur);
        return { args, end: k };
      }
      depth--;
    }
    if (tk.t === "punct" && tk.v === "," && depth === 0) { args.push(cur); cur = []; continue; }
    cur.push(tk);
  }
  return null;
}

/** Read a prompt argument: `{evaluable, text?, why?}` — `text` is the literal, or its static first line. */
function readPrompt(arg) {
  if (!arg || arg.length === 0) return { evaluable: false, why: "the call passes no prompt" };
  if (arg.length === 1 && arg[0].t === "str") return { evaluable: true, text: decodeEscapes(arg[0].v.slice(1, -1)) };
  if (arg.length === 1 && arg[0].t === "tpl") {
    const tk = arg[0];
    if (!tk.hasSubst) return { evaluable: true, text: decodeEscapes(tk.parts[0]) };
    // Only the text before the first substitution is known. It decides the routing when it already
    // holds a COMPLETE first non-empty line. When the second line is not complete too, an override line
    // could still arrive through the substitution: `overrideUnknown` says so, and the decision then
    // refuses to honour an override it cannot read.
    const head = decodeEscapes(tk.parts[0]);
    const lines = head.split(/\r?\n/);
    const tail = lines.pop().trim();
    const complete = lines.map((l) => l.trim()).filter((l) => l !== "");
    if (complete.length >= 2) return { evaluable: true, text: complete.slice(0, 2).join("\n") + "\n", overrideUnknown: false };
    if (complete.length === 1) {
      return { evaluable: true, text: complete[0] + "\n", overrideUnknown: "EFFORT-OVERRIDE:".startsWith(tail) || tail.startsWith("EFFORT-OVERRIDE:") };
    }
    return { evaluable: false, why: "the prompt's first line is built from a substitution" };
  }
  return { evaluable: false, why: "the prompt is not a literal" };
}

/** Split an object literal's tokens (without its braces) into top-level properties. */
function splitProps(inner) {
  const props = [];
  let cur = [];
  let depth = 0;
  for (const tk of inner) {
    if (tk.t === "punct" && "([{".includes(tk.v)) depth++;
    if (tk.t === "punct" && ")]}".includes(tk.v)) depth--;
    if (tk.t === "punct" && tk.v === "," && depth === 0) { props.push(cur); cur = []; continue; }
    cur.push(tk);
  }
  if (cur.length) props.push(cur);
  return props;
}

/** Read an options argument: `{evaluable, effort (string|null), agentType?, why?}`. */
function readOptions(arg) {
  if (!arg || arg.length === 0) return { evaluable: true, effort: null };
  if (!(arg[0].t === "punct" && arg[0].v === "{" && arg[arg.length - 1].t === "punct" && arg[arg.length - 1].v === "}")) {
    return { evaluable: false, why: "the options argument is not an object literal" };
  }
  let effort = null;
  let effortKeys = 0;
  let agentType = null;
  for (const p of splitProps(arg.slice(1, -1))) {
    if (p.length === 0) continue;
    // A shorthand property (`{agentType}`) names a variable; only an `effort` shorthand can move the effort.
    if (p.length === 1 && p[0].t === "id") {
      if (p[0].v === "effort") return { evaluable: false, why: "`effort` is a shorthand property, not a literal" };
      continue;
    }
    const keyTok = p[0];
    const hasColon = p.length >= 3 && p[1].t === "punct" && p[1].v === ":";
    if (!hasColon || !(keyTok.t === "id" || keyTok.t === "str" || keyTok.t === "num")) {
      // A spread, accessor, method or computed key can set `effort` to something other than the literal read.
      return { evaluable: false, why: "the options carry a spread, accessor, method or computed key, which can change the effort the call runs at" };
    }
    const key = keyTok.t === "str" ? decodeEscapes(keyTok.v.slice(1, -1)) : keyTok.v;
    const val = p.slice(2);
    if (key === "effort") {
      effortKeys++;
      if (effortKeys > 1) return { evaluable: false, why: "the options name `effort` more than once" };
      if (val.length === 1 && val[0].t === "str") effort = decodeEscapes(val[0].v.slice(1, -1));
      else if (val.length === 1 && val[0].t === "tpl" && !val[0].hasSubst) effort = decodeEscapes(val[0].parts[0]);
      else return { evaluable: false, why: "`effort` is not a string literal" };
    }
    if (key === "agentType" && val.length === 1 && val[0].t === "str") agentType = decodeEscapes(val[0].v.slice(1, -1));
  }
  return { evaluable: true, effort, agentType };
}

/**
 * What the `[` at `toks[k]` opens: "array" (an array literal or array pattern) or "computed" (a computed
 * member access or computed key). `open` is the stack of brackets enclosing it in this token list, each
 * `{v, forHead}`; `inSubst` is true inside a template substitution, where no statement begins. Where the
 * reading cannot be told without a parser the answer is "computed" — the refusing side.
 */
function bracketRole(toks, k, open, inSubst) {
  const p = toks[k - 1];
  if (!p) return "array";
  if (p.t === "num" || p.t === "str" || p.t === "tpl" || p.t === "regex") return "computed";
  const top = open[open.length - 1];
  if (p.t === "id") {
    if (isPropertyName(toks, k - 1)) return "computed";
    if (ARRAY_AFTER_WORDS.has(p.v)) return "array";
    // `let [` opens a declaration only where a statement begins (or in a for head); elsewhere `let` is a name.
    if (p.v === "let" && !inSubst) {
      const q = toks[k - 2];
      if (!q || (q.t === "punct" && (q.v === ";" || q.v === "{" || q.v === "}"))) return "array";
      if (q.t === "punct" && q.v === "(" && top && top.forHead) return "array";
      return "computed";
    }
    // `of [` is the for-of keyword only directly inside a for head and after a binding.
    if (p.v === "of" && top && top.v === "(" && top.forHead) {
      const q = toks[k - 2];
      if (q && ((q.t === "id" && !NOT_A_BINDING.has(q.v)) || (q.t === "punct" && (q.v === "]" || q.v === "}")))) return "array";
    }
    return "computed";
  }
  if (p.v === ")" || p.v === "]" || p.v === "}" || p.v === "?." || p.v === "++" || p.v === "--" || p.v === "{") return "computed";
  if (p.v === ",") return top && top.v === "{" ? "computed" : "array";
  return "array";
}

/** Refuse a computed member access or computed key whose key is not one number literal. */
function assertComputedKey(toks, k, lineAt) {
  let depth = 0;
  let end = -1;
  for (let j = k; j < toks.length; j++) {
    const tk = toks[j];
    if (tk.t !== "punct") continue;
    if (tk.v === "(" || tk.v === "[" || tk.v === "{") depth++;
    else if (tk.v === ")" || tk.v === "]" || tk.v === "}") {
      depth--;
      if (depth === 0) { end = j; break; }
    }
  }
  if (end < 0) throw new ScanError(`a \`[\` at line ${lineAt(toks[k].s)} is not closed`);
  if (end === k + 2 && toks[k + 1].t === "num") return;
  throw new ScanError(`a computed member access or key \`[…]\` at line ${lineAt(toks[k].s)} names its property at run time, ` +
    "so what it reaches cannot be evaluated — use `.name`, or a number literal index");
}

/** Why an occurrence of a launch hook is not a direct call, or null when it is one. */
function indirectWhy(toks, k) {
  const tk = toks[k];
  const prev = toks[k - 1];
  const next = toks[k + 1];
  if (isPropertyName(toks, k)) return `\`${tk.v}\` is used as a member name (\`.${tk.v}\`)`;
  if (prev && prev.t === "punct" && prev.v === "#") return `\`#${tk.v}\` is a private name`;
  if (prev && prev.t === "id" && ["function", "class", "new", "let", "const", "var", "get", "set", "static", "async"].includes(prev.v)) {
    return `\`${tk.v}\` follows \`${prev.v}\`, so it is declared, constructed or redefined rather than called`;
  }
  if (!next || next.t !== "punct" || next.v !== "(") {
    return `\`${tk.v}\` is referenced without being called directly (alias, argument, member access, optional or tagged call)`;
  }
  return null;
}

/**
 * Scan a workflow script. Pure.
 *
 * @param {string} src the script text
 * @returns {{ok:true, calls:Array<{line, prompt, options}>, nested:Array<{line}>, indirect:Array<{line, why}>,
 *           indirectMore:number}
 *          | {ok:false, reason:string}}
 */
function scanWorkflowScript(src) {
  if (typeof src !== "string") return { ok: false, reason: "the script is not text" };
  if (Buffer.byteLength(src, "utf8") > SCRIPT_MAX_BYTES) return { ok: false, reason: `the script exceeds ${SCRIPT_MAX_BYTES} bytes` };
  let toks;
  try {
    toks = tokenize(src);
  } catch (e) {
    if (!(e instanceof ScanError)) throw e;
    return { ok: false, reason: `the script could not be tokenized: ${e.message}` };
  }
  const calls = [];
  const nested = [];
  const indirect = [];
  let indirectMore = 0;
  const lineAt = lineTable(src);
  const flag = (line, why) => { if (indirect.length < MAX_INDIRECT) indirect.push({ line, why }); else indirectMore++; };
  const visit = (list, inSubst) => {
    const open = [];
    for (let k = 0; k < list.length; k++) {
      const tk = list[k];
      if (tk.t === "tpl") { for (const sub of tk.substs) visit(sub, true); continue; }
      if (tk.t === "punct") {
        if (tk.v === "[") {
          if (bracketRole(list, k, open, inSubst) === "computed") assertComputedKey(list, k, lineAt);
          open.push({ v: "[", forHead: false });
        } else if (tk.v === "(") {
          const p = list[k - 1];
          const q = list[k - 2];
          const forHead = !!(p && p.t === "id" && !isPropertyName(list, k - 1) &&
            (p.v === "for" || (p.v === "await" && q && q.t === "id" && q.v === "for")));
          open.push({ v: "(", forHead });
        } else if (tk.v === "{") {
          open.push({ v: "{", forHead: false });
        } else if (tk.v === ")" || tk.v === "]" || tk.v === "}") {
          open.pop();
        }
        continue;
      }
      // A QUOTED property key names a property exactly as an identifier key does: `{"constructor": F} = x`
      // reaches `Function` and `{"agent": a} = g` aliases the hook, with no identifier token and no `[`.
      // So a string literal in key position (followed by `:`) whose decoded value is a reflective or hook
      // name is reported the same way. A `? "agent" :` ternary arm also matches; that refuses, never allows.
      // A quoted key holding ANY backslash (an escape or a line continuation) is UNSCANNABLE rather than
      // decoded: a hand decoder drifts from the engine (a lone-CR continuation and legacy octal `\143` both
      // decoded differently from JavaScript and let a reflective key through), so the key's identity is not
      // proved and the script is refused. A plain key costs nothing to write.
      if (tk.t === "str") {
        const nx = list[k + 1];
        if (nx && nx.t === "punct" && nx.v === ":") {
          if (tk.v.includes("\\")) {
            throw new ScanError(`the quoted key ${JSON.stringify(tk.v.slice(0, 40))} at line ` +
              `${lineAt(tk.s)} contains an escape or line continuation, so which property it names cannot be ` +
              "evaluated — write the key without any backslash");
          }
          const key = tk.v.slice(1, -1);
          if (REFLECTIVE_IDS.has(key) || HOOK_IDS.has(key)) {
            flag(lineAt(tk.s), `the quoted key ${JSON.stringify(key)} names \`${key}\` as a property, which can reach a launch without calling it`);
          }
        }
        continue;
      }
      if (tk.t !== "id") continue;
      if (REFLECTIVE_IDS.has(tk.v)) {
        flag(lineAt(tk.s), `it uses \`${tk.v}\`, which can reach a launch without naming it`);
        continue;
      }
      if (!HOOK_IDS.has(tk.v)) continue;
      const line = lineAt(tk.s);
      if (inSubst) { flag(line, `\`${tk.v}\` appears inside a template substitution`); continue; }
      const why = indirectWhy(list, k);
      if (why) { flag(line, why); continue; }
      const split = splitArgs(list, k + 1);
      if (!split) throw new ScanError(`an \`${tk.v}(\` call at line ${line} is not closed`);
      if (tk.v === "workflow") { nested.push({ line }); continue; }
      if (calls.length >= MAX_CALLS) throw new ScanError(`the script makes more than ${MAX_CALLS} \`agent(\` calls`);
      calls.push({ line, prompt: readPrompt(split.args[0]), options: readOptions(split.args[1]) });
    }
  };
  try {
    visit(toks, false);
  } catch (e) {
    if (!(e instanceof ScanError)) throw e;
    return { ok: false, reason: `the script could not be scanned: ${e.message}` };
  }
  return { ok: true, calls, nested, indirect, indirectMore };
}

/**
 * Read a file size-capped, refusing a symlink in the FINAL component only (`O_NOFOLLOW` is leaf-only:
 * a symlinked parent directory is followed, and no root fence applies — see header).
 * `{ok, text}` or `{ok:false, reason}`. Never throws.
 */
function readScriptFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (e) {
    return { ok: false, reason: e && e.code === "ELOOP" ? "the script path is a symlink, which is never followed" : "the script path cannot be opened" };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: "the script path is not a regular file" };
    if (st.size > SCRIPT_MAX_BYTES) return { ok: false, reason: `the script exceeds ${SCRIPT_MAX_BYTES} bytes` };
    return { ok: true, text: fs.readFileSync(fd, "utf8") };
  } catch {
    return { ok: false, reason: "the script could not be read" };
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

/**
 * Resolve the script a `Workflow` call runs. Never throws. Exactly one source is accepted, and a saved
 * `name` is never resolved (see header).
 *
 * @param {object} toolInput the Workflow tool_input
 * @returns {{ok:true, text:string, source:string} | {ok:false, reason:string, source:string}}
 */
function resolveWorkflowScript(toolInput) {
  const ti = toolInput && typeof toolInput === "object" ? toolInput : {};
  const named = SOURCE_FIELDS.filter((f) => ti[f] !== undefined && ti[f] !== null);
  if (named.length > 1) {
    return { ok: false, source: "multiple",
      reason: `the call names more than one script source (${named.join(", ")}), and which one the runtime runs is not known here — pass exactly one` };
  }
  if (named.length === 0) return { ok: false, reason: "the call names no script, scriptPath or saved workflow", source: "none" };
  const source = named[0];
  const value = ti[source];
  if (typeof value !== "string") return { ok: false, reason: `\`${source}\` is not a string`, source };
  if (source === "script") {
    if (value.trim() === "") return { ok: false, reason: "the inline script is empty", source };
    return { ok: true, text: value, source };
  }
  if (source === "scriptPath") {
    if (!path.isAbsolute(value)) {
      return { ok: false, source,
        reason: "a relative scriptPath is not resolved here (the runtime may resolve it against a different root) — pass an absolute path" };
    }
    const r = readScriptFile(value);
    return r.ok ? { ok: true, text: r.text, source } : { ok: false, reason: r.reason, source };
  }
  return { ok: false, source,
    reason: "a saved workflow `name` is resolved by the runtime from registries this check cannot read, so the script it runs is not known here — inline the script or pass an absolute scriptPath" };
}

module.exports = {
  SCRIPT_MAX_BYTES,
  MAX_CALLS,
  HOOK_IDS,
  REFLECTIVE_IDS,
  tokenize,
  scanWorkflowScript,
  resolveWorkflowScript,
  readScriptFile,
};
