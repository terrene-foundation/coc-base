// Guard foundation S4 (R1 H1) — the EXECUTION CLOSURE of a trusted writer.
//
// The broker runs a trusted writer OUTSIDE the sandbox. Every file that run can execute is
// therefore part of the trusted computing base, and must be unwritable from inside the
// sandbox — not only the writer's entry file. This module computes that set, for one entry in
// the PRIMARY checkout, as the union of:
//   - static `import … from` / `export … from` / `import "x"` specifiers;
//   - `require(…)` and dynamic `import(…)` whose argument evaluates STATICALLY to a path
//     (string literals, __dirname / import.meta.url / dirname(fileURLToPath(...)),
//     path.join/resolve/dirname, and file-level consts bound only to such expressions);
//   - scripts handed to node by spawn / spawnSync / execFile / execFileSync / fork / Worker,
//     when the command evaluates to process.execPath and the script argument evaluates
//     statically; an executable that is itself a file in the repository;
//   - the git hooks git would run (the effective hooks directory, measured by asking git),
//     for every writer whose closure spawns git.
// Programs outside the repository (git, gpg, ssh-keygen, ps, …) and node builtins are LISTED,
// never walked. A site that cannot be resolved statically is resolved ONLY by a reviewed
// DECLARATION below, pinned to the sha256 of the file that holds it; otherwise it is reported
// UNRESOLVED and the broker refuses the writer (`closure-unresolved`). Nothing is skipped
// silently: a file that cannot be scanned, a bare package specifier (node would search
// node_modules directories outside the policy), a non-JS executable with no declaration, a
// child_process function passed around as a value, a shell command string — each is unresolved.
//
// This is ANALYSIS OF JAVASCRIPT SOURCE (a tokenizer plus a small constant evaluator), not a
// shell parser: a site that hands a COMMAND STRING to a shell is unresolved by construction.
//
// CLI:
//   node closure.mjs rows [--repo <primary>] [--policy <file>]
//       every trusted writer's closure as candidate protected_write rows (JSON, sorted), each
//       marked covered / uncovered by the policy, plus the unresolved sites per writer.
//   node closure.mjs show <writer-id> [--repo <primary>] [--policy <file>]
//
// HONEST LIMITS (named, not hidden):
//   - PATH: an external program is found on the writer's PATH (the broker's env allowlist);
//     resolveGitBinary() prefers fixed system candidates. A PATH entry inside a writable tree
//     is the launcher's to exclude, not this module's.
//   - git config can name programs (core.fsmonitor, gpg.program, core.sshCommand, filter and
//     credential helpers). .git/config and ~/.gitconfig are protected rows; the programs they
//     name are listed as neither members nor externals.
//   - eval / new Function / vm over data read at run time are not followed.
//   - A declaration is a reviewed claim about bytes: it holds for the sha256 it is pinned to
//     and for nothing else, so any edit to a declared file makes the writer refuse until the
//     declaration is re-reviewed and re-pinned here (this file is itself protected code).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { builtinModules, createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPolicy, POLICY_PATH, repoProtects } from "../policy/policy.mjs";
import { isMainModule } from "../../../../bin/lib/entry-point.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const toPosix = (p) => p.split(path.sep).join("/");

export class ScanError extends Error {}

// ── tokenizer ────────────────────────────────────────────────────────────────────────────
// Tokens: {t:"id"|"str"|"tmpl"|"num"|"re"|"p", v, line, pos}. "str" carries the COOKED value
// of a quoted string or a template with no substitution; "tmpl" marks a template that HAS
// substitutions (its expressions are tokenized inline and its value is not evaluable).

const PUNCT = [">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=", "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>"];
const RE_AFTER_KW = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const ID_START = /[A-Za-z_$\u0080-￿]/;
const ID_PART = /[\w$\u0080-￿]/;
const NUM = /^(?:0[xXoObB][\da-fA-F_]+n?|\d[\d_]*\.?[\d_]*(?:[eE][+-]?\d+)?n?|\.\d[\d_]*(?:[eE][+-]?\d+)?)/;

function cook(raw, line) {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g, (_, e) => {
    if (e[0] === "u") return String.fromCodePoint(parseInt(e[1] === "{" ? e.slice(2, -1) : e.slice(1), 16));
    if (e[0] === "x") return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e === "\n" || e === "\r\n" || e === "\r") return "";
    return { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" }[e] ?? e;
  });
}

export function tokenize(src) {
  const toks = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  let depth = 0; // brace depth
  const tmpl = []; // brace depths at which a template substitution opened
  if (src.startsWith("#!")) {
    i = src.indexOf("\n");
    if (i < 0) i = n;
  }
  const push = (t, v, pos) => toks.push({ t, v, line, pos });
  const regexAllowed = () => {
    const p = toks[toks.length - 1];
    if (!p) return true;
    if (p.t === "p") return p.v !== ")" && p.v !== "]";
    if (p.t === "id") return RE_AFTER_KW.has(p.v);
    return false;
  };
  const templateChunk = (startLine) => {
    let raw = "";
    while (i < n) {
      const c = src[i];
      if (c === "\\") {
        raw += src.slice(i, i + 2);
        if (src[i + 1] === "\n") line++;
        i += 2;
        continue;
      }
      if (c === "`") {
        i++;
        return { end: true, raw };
      }
      if (c === "$" && src[i + 1] === "{") {
        i += 2;
        return { end: false, raw };
      }
      if (c === "\n") line++;
      raw += c;
      i++;
    }
    throw new ScanError(`unterminated template literal opened at line ${startLine}`);
  };
  while (i < n) {
    const c = src[i];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v" || c === "﻿" || c === " " || c === " " || c === " ") {
      i++;
      continue;
    }
    const pos = i;
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) throw new ScanError(`unterminated block comment at line ${line}`);
      for (let k = i; k < end; k++) if (src[k] === "\n") line++;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let k = i + 1;
      let raw = "";
      while (k < n && src[k] !== c) {
        if (src[k] === "\n") throw new ScanError(`unterminated string at line ${line}`);
        if (src[k] === "\\") {
          if (src[k + 1] === "\n") line++;
          raw += src.slice(k, k + 2);
          k += 2;
          continue;
        }
        raw += src[k++];
      }
      if (k >= n) throw new ScanError(`unterminated string at line ${line}`);
      push("str", cook(raw, line), pos);
      i = k + 1;
      continue;
    }
    if (c === "`") {
      const startLine = line;
      i++;
      const r = templateChunk(startLine);
      if (r.end) push("str", cook(r.raw, line), pos);
      else {
        push("tmpl", null, pos);
        tmpl.push(depth);
        depth++;
      }
      continue;
    }
    if (c === "}" && tmpl.length && tmpl[tmpl.length - 1] === depth - 1) {
      depth--;
      tmpl.pop();
      i++;
      const r = templateChunk(line);
      if (!r.end) {
        tmpl.push(depth);
        depth++;
      }
      continue;
    }
    if (ID_START.test(c) || (c === "#" && ID_START.test(src[i + 1] || ""))) {
      let k = i + 1;
      while (k < n && ID_PART.test(src[k])) k++;
      push("id", src.slice(i, k), pos);
      i = k;
      continue;
    }
    if (/\d/.test(c) || (c === "." && /\d/.test(src[i + 1] || ""))) {
      const m = NUM.exec(src.slice(i, i + 64));
      push("num", m[0], pos);
      i += m[0].length;
      continue;
    }
    if (c === "/" && regexAllowed()) {
      let k = i + 1;
      let cls = false;
      for (; k < n; k++) {
        const d = src[k];
        if (d === "\n") throw new ScanError(`unterminated regular expression at line ${line}`);
        if (d === "\\") {
          k++;
          continue;
        }
        if (d === "[") cls = true;
        else if (d === "]") cls = false;
        else if (d === "/" && !cls) break;
      }
      if (k >= n) throw new ScanError(`unterminated regular expression at line ${line}`);
      k++;
      while (k < n && ID_PART.test(src[k])) k++;
      push("re", src.slice(i, k), pos);
      i = k;
      continue;
    }
    const p = PUNCT.find((q) => src.startsWith(q, i)) || c;
    if (p === "{") depth++;
    else if (p === "}") depth--;
    push("p", p, pos);
    i += p.length;
  }
  if (tmpl.length) throw new ScanError("unterminated template substitution");
  return toks;
}

// ── token helpers ────────────────────────────────────────────────────────────────────────
const OPEN = { "(": ")", "[": "]", "{": "}" };
const isP = (tok, v) => tok && tok.t === "p" && tok.v === v;
const isId = (tok, v) => tok && tok.t === "id" && (v === undefined || tok.v === v);

function matchClose(toks, k) {
  const want = OPEN[toks[k].v];
  let d = 0;
  for (let j = k; j < toks.length; j++) {
    const t = toks[j];
    if (t.t !== "p") continue;
    if (OPEN[t.v]) d++;
    else if (t.v === ")" || t.v === "]" || t.v === "}") {
      d--;
      if (d === 0) {
        if (t.v !== want) throw new ScanError(`mismatched '${toks[k].v}' at line ${toks[k].line}`);
        return j;
      }
    }
  }
  throw new ScanError(`unclosed '${toks[k].v}' at line ${toks[k].line}`);
}

/** Split toks[a..b) (exclusive) at depth-0 commas into [start, end) ranges. */
function splitTop(toks, a, b) {
  const out = [];
  let d = 0;
  let s = a;
  for (let j = a; j < b; j++) {
    const t = toks[j];
    if (t.t === "p") {
      if (OPEN[t.v]) d++;
      else if (t.v === ")" || t.v === "]" || t.v === "}") d--;
      else if (t.v === "," && d === 0) {
        out.push([s, j]);
        s = j + 1;
      }
    }
  }
  if (s < b) out.push([s, b]);
  return out;
}


// ── values ───────────────────────────────────────────────────────────────────────────────
// A value is {k:"str", v} | {k:"url", v:<href>} | {k:"node"} | {k:"git"} | null (unresolvable).
const PATH_FNS = new Set(["join", "resolve", "dirname", "basename"]);
const CP_FNS = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "fork", "exec", "execSync"]);
const SHELL_FNS = new Set(["exec", "execSync"]);

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

/**
 * Per-file binding facts gathered in one pass: const/let/var initialisers, plain assignments,
 * names that are bound any other way (parameters, destructuring, catch) — those are POISONED
 * and never evaluate — the local names for path/url/child_process/worker_threads functions,
 * require aliases, and whether the file loads git-subprocess-env.js.
 */
function bindings(toks) {
  const init = new Map(); // name -> [[a,b), ...] initialiser token ranges
  const poison = new Set();
  const addInit = (name, a, b) => (init.has(name) ? init.get(name) : init.set(name, []).get(name)).push([a, b]);
  const patternNames = (a, b) => {
    // identifiers in a destructuring pattern / parameter list (keys of `k: v` excluded where obvious)
    for (let j = a; j < b; j++) if (toks[j].t === "id" && !isP(toks[j + 1], ":")) poison.add(toks[j].v);
  };
  const exprEnd = (k) => {
    // initialiser starts at k; ends at a depth-0 ',' ';' or a closer, or at a statement boundary
    let d = 0;
    for (let j = k; j < toks.length; j++) {
      const t = toks[j];
      if (t.t === "p") {
        if (OPEN[t.v]) d++;
        else if (t.v === ")" || t.v === "]" || t.v === "}") {
          if (d === 0) return j;
          d--;
        } else if (d === 0 && (t.v === "," || t.v === ";")) return j;
      }
      const nx = toks[j + 1];
      if (d === 0 && nx && nx.line > t.line && (t.t === "id" || t.t === "str" || t.t === "num" || isP(t, ")") || isP(t, "]")) && (nx.t === "id" || nx.t === "str" || nx.t === "tmpl")) {
        if (!(t.t === "id" && (t.v === "new" || t.v === "typeof" || t.v === "await"))) return j + 1;
      }
    }
    return toks.length;
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    // destructuring assignment: ({ a, b } = …) / [a, b] = … rebinds every name in the pattern
    if ((isP(t, "}") || isP(t, "]")) && isP(toks[k + 1], "=")) {
      let d = 0;
      for (let j = k; j >= 0; j--) {
        if (isP(toks[j], t.v)) d++;
        else if (isP(toks[j], t.v === "}" ? "{" : "[") && --d === 0) {
          patternNames(j + 1, k);
          break;
        }
      }
      continue;
    }
    if (t.t !== "id") continue;
    // declarations
    if ((t.v === "const" || t.v === "let" || t.v === "var") && !isP(toks[k - 1], ".")) {
      let j = k + 1;
      for (;;) {
        const nm = toks[j];
        if (!nm) break;
        if (isP(nm, "{") || isP(nm, "[")) {
          const e = matchClose(toks, j);
          patternNames(j + 1, e);
          j = e + 1;
        } else if (nm.t === "id") j++;
        else break;
        if (isP(toks[j], "=")) {
          const e = exprEnd(j + 1);
          if (nm.t === "id") addInit(nm.v, j + 1, e);
          j = e;
        } else if (nm.t === "id") poison.add(nm.v); // no initialiser: a loop variable, or assigned later — never a constant
        if (isP(toks[j], ",")) {
          j++;
          continue;
        }
        break;
      }
      continue;
    }
    // function parameters: function NAME? ( … ), and NAME ( … ) { for methods, catch ( … )
    if (t.v === "function" || t.v === "catch") {
      let j = k + 1;
      if (isP(toks[j], "*")) j++;
      if (isId(toks[j])) j++;
      if (isP(toks[j], "(")) patternNames(j + 1, matchClose(toks, j));
      continue;
    }
    // reassignment NAME = / NAME op= (not ==, not =>)
    const nx = toks[k + 1];
    if (nx && nx.t === "p" && !isP(toks[k - 1], ".") && !isP(toks[k - 1], "?.")) {
      if (nx.v === "=") addInit(t.v, k + 2, exprEnd(k + 2));
      else if (/^(\+|-|\*|\/|%|\*\*|<<|>>|>>>|&|\||\^|&&|\|\||\?\?)=$/.test(nx.v) || nx.v === "++" || nx.v === "--") poison.add(t.v);
      else if (nx.v === "=>") poison.add(t.v); // single-parameter arrow
    }
  }
  // arrow parameter lists ( … ) => and method/function parameter lists ( … ) {
  for (let k = 0; k < toks.length; k++) {
    if (!isP(toks[k], ")")) continue;
    const nx = toks[k + 1];
    if (!(isP(nx, "=>") || isP(nx, "{"))) continue;
    let d = 0;
    let open = -1;
    for (let j = k; j >= 0; j--) {
      if (isP(toks[j], ")")) d++;
      else if (isP(toks[j], "(")) {
        d--;
        if (d === 0) {
          open = j;
          break;
        }
      }
    }
    if (open < 0) continue;
    const before = toks[open - 1];
    if (isP(nx, "{") && before && before.t === "id" && ["if", "for", "while", "switch", "with"].includes(before.v)) continue;
    patternNames(open + 1, k);
  }
  return { init, poison };
}

/** Names bound ONLY to `createRequire(…)` (never poisoned): each is a require function. */
function requireAliases(toks, binds) {
  const out = new Set();
  for (const [name, inits] of binds.init) {
    const real = inits.filter(([x]) => x >= 0);
    if (name === "require" || binds.poison.has(name) || !real.length) continue;
    if (real.every(([x, y]) => isId(toks[x], "createRequire") && isP(toks[x + 1], "(") && matchClose(toks, x + 1) === y - 1)) out.add(name);
  }
  return out;
}

/** Local names imported for the path / url / child_process / worker_threads / module APIs. */
function moduleNames(toks, evalSpec = null, aliases = new Set()) {
  const ns = { path: new Set(), url: new Set(), cp: new Set(), wt: new Set(), module: new Set(), gse: new Set() };
  const fns = { path: new Map(), url: new Map(), cp: new Map(), wt: new Map(), module: new Map(), gse: new Map() }; // local -> imported
  const bindIdx = new Set(); // token indices that ARE the binding of such a name (not uses)
  const which = (spec) => {
    const s = String(spec).replace(/^node:/, "");
    if (s === "path" || s === "path/posix") return "path";
    if (s === "url") return "url";
    if (s === "child_process") return "cp";
    if (s === "worker_threads") return "wt";
    if (s === "module") return "module";
    if (/(^|\/)git-subprocess-env(\.js)?$/.test(String(spec))) return "gse"; // the protected git envelope (it is walked like any member)
    return null;
  };
  const bindNamed = (kind, a, b, sepAs) => {
    // { a, b as c } (import) or { a, b: c } (destructure)
    for (let j = a; j < b; j++) {
      if (toks[j].t !== "id") continue;
      const imported = toks[j].v;
      let local = imported;
      let li = j;
      if ((sepAs && isId(toks[j + 1], "as")) || (!sepAs && isP(toks[j + 1], ":"))) {
        local = toks[j + 2].v;
        li = j + 2;
        j += 2;
      }
      fns[kind].set(local, imported);
      bindIdx.add(li);
      if (isP(toks[j + 1], "=")) {
        // default value in a pattern: skip it
        while (j < b && !isP(toks[j], ",")) j++;
      }
    }
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    // import … from "x"
    if (isId(t, "import") && !isP(toks[k - 1], ".") && !isP(toks[k + 1], "(") && !isP(toks[k + 1], ".")) {
      let j = k + 1;
      let from = -1;
      while (j < toks.length && j < k + 400 && !isP(toks[j], ";")) {
        if (toks[j].t === "str" && (isId(toks[j - 1], "from") || j === k + 1)) {
          from = j;
          break;
        }
        j++;
      }
      if (from < 0) continue;
      const kind = which(toks[from].v);
      if (!kind) continue;
      for (let q = k + 1; q < from; q++) {
        if (isP(toks[q], "{")) {
          const e = matchClose(toks, q);
          bindNamed(kind, q + 1, e, true);
          q = e;
        } else if (isP(toks[q], "*") && isId(toks[q + 1], "as")) {
          ns[kind].add(toks[q + 2].v);
          bindIdx.add(q + 2);
          q += 2;
        } else if (toks[q].t === "id" && toks[q].v !== "from") {
          ns[kind].add(toks[q].v); // default import = the namespace for node builtins
          bindIdx.add(q);
        }
      }
      continue;
    }
    // require(x) / import(x) / createRequire(…)(x) bound by `NAME =` or `{ … } =`
    let callAt = -1;
    if (((isId(t, "require") || (t.t === "id" && aliases.has(t.v))) && !isP(toks[k - 1], ".")) || isId(t, "import")) callAt = k + 1;
    else if (isId(t, "createRequire") && isP(toks[k + 1], "(")) {
      const c1 = matchClose(toks, k + 1);
      if (isP(toks[c1 + 1], "(")) callAt = c1 + 1;
    }
    if (callAt < 0 || !isP(toks[callAt], "(")) continue;
    const close = matchClose(toks, callAt);
    let spec = null;
    if (close === callAt + 2 && toks[callAt + 1].t === "str") spec = toks[callAt + 1].v;
    else if (evalSpec) {
      const args = splitTop(toks, callAt + 1, close);
      if (args.length === 1) spec = evalSpec(...args[0]);
    }
    const kind = spec === null ? null : which(spec);
    if (!kind) continue;
    if (isP(toks[close + 1], ".") || isP(toks[close + 1], "(")) continue; // a direct member use, handled at the use site
    let e = k - 1;
    if (isId(toks[e], "await")) e--;
    if (!isP(toks[e], "=")) continue;
    const lhs = toks[e - 1];
    if (lhs && lhs.t === "id") {
      ns[kind].add(lhs.v);
      bindIdx.add(e - 1);
    } else if (isP(lhs, "}")) {
      let d = 0;
      let o = e - 1;
      for (; o >= 0; o--) {
        if (isP(toks[o], "}")) d++;
        else if (isP(toks[o], "{") && --d === 0) break;
      }
      bindNamed(kind, o + 1, e - 1, false);
    }
  }
  return { ns, fns, bindIdx };
}


/** A small constant evaluator over toks[a..b). Returns a value or null. */
function evaluator(ctx) {
  const { toks, file, isCjs, binds, mods } = ctx;
  const dir = path.dirname(file);
  const memo = new Map();
  const ev = (a, b, depth = 0) => {
    if (depth > 24 || a >= b) return null;
    // strip one layer of parentheses
    if (isP(toks[a], "(") && matchClose(toks, a) === b - 1) return ev(a + 1, b - 1, depth + 1);
    // a + b string concatenation at depth 0
    const parts = [];
    {
      let d = 0;
      let s = a;
      for (let j = a; j < b; j++) {
        const t = toks[j];
        if (t.t === "p") {
          if (OPEN[t.v]) d++;
          else if (t.v === ")" || t.v === "]" || t.v === "}") d--;
          else if (d === 0 && t.v === "+") {
            parts.push([s, j]);
            s = j + 1;
          } else if (d === 0 && t.v !== ".") {
            return null; // any other operator at depth 0 (?: || && ?? ?. , …) — not a constant we evaluate
          }
        }
      }
      if (parts.length) {
        parts.push([s, b]);
        let acc = "";
        for (const [x, y] of parts) {
          const v = ev(x, y, depth + 1);
          if (!v || v.k !== "str") return null;
          acc += v.v;
        }
        return { k: "str", v: acc };
      }
    }
    const t = toks[a];
    const n = b - a;
    if (n === 1 && t.t === "str") return { k: "str", v: t.v };
    if (n === 1 && t.t === "id") {
      if (t.v === "__dirname" && isCjs) return { k: "str", v: dir };
      if (t.v === "__filename" && isCjs) return { k: "str", v: file };
      return ident(t.v, depth);
    }
    // import.meta.url / .dirname / .filename
    if (isId(t, "import") && isP(toks[a + 1], ".") && isId(toks[a + 2], "meta") && isP(toks[a + 3], ".") && n === 5) {
      const f = toks[a + 4].v;
      if (f === "url") return { k: "url", v: pathToFileURL(file).href };
      if (f === "dirname") return { k: "str", v: dir };
      if (f === "filename") return { k: "str", v: file };
      return null;
    }
    // process.execPath
    if (n === 3 && isId(t, "process") && isP(toks[a + 1], ".") && isId(toks[a + 2], "execPath")) return { k: "node" };
    // new URL(x, base)
    if (isId(t, "new") && isId(toks[a + 1], "URL") && isP(toks[a + 2], "(") && matchClose(toks, a + 2) === b - 1) {
      const args = splitTop(toks, a + 3, b - 1);
      if (args.length !== 2) return null;
      const x = ev(...args[0], depth + 1);
      const base = ev(...args[1], depth + 1);
      if (!x || x.k !== "str" || !base || base.k !== "url") return null;
      return { k: "url", v: new URL(x.v, base.v).href };
    }
    // X.href on a url
    if (n >= 3 && isP(toks[b - 2], ".") && isId(toks[b - 1], "href")) {
      const v = ev(a, b - 2, depth + 1);
      return v && v.k === "url" ? { k: "str", v: v.v } : null;
    }
    // call: callee(args)
    if (isP(toks[b - 1], ")")) {
      let o = -1;
      let d = 0;
      for (let j = b - 1; j >= a; j--) {
        if (isP(toks[j], ")")) d++;
        else if (isP(toks[j], "(") && --d === 0) {
          o = j;
          break;
        }
      }
      if (o <= a) return null;
      const callee = callName(a, o);
      if (!callee) return null;
      const args = splitTop(toks, o + 1, b - 1);
      const vals = () => args.map(([x, y]) => ev(x, y, depth + 1));
      if (callee.mod === "path" && PATH_FNS.has(callee.fn)) {
        const vs = vals();
        if (!vs.length || vs.some((v) => !v || v.k !== "str")) return null;
        const ss = vs.map((v) => v.v);
        if (callee.fn === "join") return { k: "str", v: path.join(...ss) };
        if (callee.fn === "resolve") return path.isAbsolute(ss[0]) || ss.slice(1).some((s) => path.isAbsolute(s)) ? { k: "str", v: path.resolve(...ss) } : null;
        if (callee.fn === "dirname") return ss.length === 1 ? { k: "str", v: path.dirname(ss[0]) } : null;
        if (callee.fn === "basename") return { k: "str", v: path.basename(...ss) };
      }
      if (callee.mod === "url" && callee.fn === "fileURLToPath") {
        const vs = vals();
        return vs.length === 1 && vs[0] && vs[0].k === "url" ? { k: "str", v: fileURLToPath(vs[0].v) } : null;
      }
      if (callee.mod === "url" && callee.fn === "pathToFileURL") {
        const vs = vals();
        return vs.length === 1 && vs[0] && vs[0].k === "str" && path.isAbsolute(vs[0].v) ? { k: "url", v: pathToFileURL(vs[0].v).href } : null;
      }
      if (callee.mod === "gse" && callee.fn === "resolveGitBinary") return { k: "git" };
      return null;
    }
    return null;
  };
  // callee as {mod, fn}: path.join / join / url.fileURLToPath / gse.resolveGitBinary / lib.resolveGitBinary()
  const callName = (a, o) => {
    const n = o - a;
    if (n === 1 && toks[a].t === "id") {
      for (const m of Object.keys(mods.fns)) if (mods.fns[m].has(toks[a].v)) return { mod: m, fn: mods.fns[m].get(toks[a].v) };
      return null;
    }
    if (n === 3 && toks[a].t === "id" && isP(toks[a + 1], ".") && isId(toks[a + 2])) {
      for (const m of Object.keys(mods.ns)) if (mods.ns[m].has(toks[a].v)) return { mod: m, fn: toks[a + 2].v };
      return null;
    }
    // X.resolveGitBinary() where X = a git-subprocess-env module value (gseValue)
    if (toks[o - 1].t === "id" && toks[o - 1].v === "resolveGitBinary" && isP(toks[o - 2], ".")) {
      const recv = ev(a, o - 2);
      if (recv && recv.k === "gse") return { mod: "gse", fn: "resolveGitBinary" };
      return null;
    }
    return null;
  };
  const ident = (name, depth) => {
    if (mods.ns.gse.has(name)) return { k: "gse" };
    if (binds.poison.has(name)) return null;
    if (memo.has(name)) return memo.get(name);
    memo.set(name, null); // cycle guard
    const inits = (binds.init.get(name) || []).filter(([x]) => x >= 0);
    let out = null;
    if (inits.length) {
      const vs = inits.map(([x, y]) => ev(x, y, depth + 1));
      if (vs.every((v) => v && JSON.stringify(v) === JSON.stringify(vs[0]))) out = vs[0];
    }
    memo.set(name, out);
    return out;
  };
  return ev;
}

// ── per-file analysis ────────────────────────────────────────────────────────────────────

/**
 * Analyse one JavaScript file. Returns
 *   { loads: [{line, abs, how}], spawns: [{line, kind, script|file|program, how}],
 *     builtins: [name], ids: [identifier], unresolved: [{line, site, reason}] }
 * Paths are absolute; specifiers are resolved against the file's directory.
 */
export function analyzeSource(src, file) {
  const toks = tokenize(src);
  // ES module syntax at a statement start (`import x from`, `import "x"`, `export …`); a dynamic
  // `import(…)` is legal in CommonJS too, so it does not make a file a module.
  const isCjs = file.endsWith(".cjs") || (!file.endsWith(".mjs") && !/^\s*(?:import\s*[\w{*"']|export\s)/m.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
  const binds = bindings(toks);
  // Pass 1 learns the path/url/child_process names from LITERAL specifiers; pass 2 re-reads
  // every load whose specifier only EVALUATES (require(path.join(__dirname, "…"))) with them.
  const aliases = requireAliases(toks, binds);
  const mods1 = moduleNames(toks, null, aliases);
  const ev1 = evaluator({ toks, file, isCjs, binds, mods: mods1 });
  const mods = moduleNames(toks, (a, b) => {
    const v = ev1(a, b);
    return v && v.k === "str" ? v.v : null;
  }, aliases);
  const ev = evaluator({ toks, file, isCjs, binds, mods });
  const dir = path.dirname(file);
  const out = { loads: [], spawns: [], builtins: new Set(), ids: new Set(), unresolved: [] };
  for (const t of toks) if (t.t === "id") out.ids.add(t.v);
  // A site's KEY: its first tokens (comments excluded), so a declaration matches the code, not
  // the prose around it.
  const site = (k, close) =>
    toks
      .slice(k, Math.min(close + 1, k + 16))
      .map((x) => (x.t === "str" ? JSON.stringify(x.v) : x.t === "tmpl" ? "`…`" : x.v))
      .join(" ");
  const unres = (k, close, reason) => out.unresolved.push({ line: toks[k].line, site: site(k, close), reason });

  const load = (k, close, spec, how) => {
    if (BUILTINS.has(spec)) return out.builtins.add(spec.replace(/^node:/, ""));
    if (spec.startsWith("file:")) spec = fileURLToPath(spec);
    if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === ".." || path.isAbsolute(spec)) {
      out.loads.push({ line: toks[k].line, abs: path.resolve(dir, spec), how });
      return;
    }
    unres(k, close, `bare package specifier '${spec}': node would search node_modules directories outside the policy`);
  };
  const evalArg = (a, b) => (a < b ? ev(a, b) : null);

  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t !== "id") continue;
    const prevDot = isP(toks[k - 1], ".") || isP(toks[k - 1], "?.");

    // static import / export-from
    if (t.v === "import" && !prevDot && !isP(toks[k + 1], "(") && !isP(toks[k + 1], ".")) {
      if (isP(toks[k + 1], ":") || isP(toks[k + 1], ",") || isP(toks[k + 1], "}") || isP(toks[k + 1], ")")) continue; // a property named import
      let j = k + 1;
      let found = -1;
      while (j < toks.length && j < k + 400 && !isP(toks[j], ";")) {
        if (toks[j].t === "str" && (j === k + 1 || isId(toks[j - 1], "from"))) {
          found = j;
          break;
        }
        if (isId(toks[j], "import") || isId(toks[j], "export") || isId(toks[j], "const") || isId(toks[j], "function")) break;
        j++;
      }
      if (found < 0) unres(k, k + 6, "an import statement whose specifier could not be read");
      else load(k, found, toks[found].v, "import");
      continue;
    }
    if (t.v === "export" && !prevDot && (isP(toks[k + 1], "*") || isP(toks[k + 1], "{"))) {
      let j = k + 1;
      if (isP(toks[j], "{")) j = matchClose(toks, j) + 1;
      else {
        j++;
        if (isId(toks[j], "as")) j += 2;
      }
      if (isId(toks[j], "from") && toks[j + 1] && toks[j + 1].t === "str") load(k, j + 1, toks[j + 1].v, "export-from");
      continue;
    }
    // dynamic import(x)
    if (t.v === "import" && isP(toks[k + 1], "(")) {
      const close = matchClose(toks, k + 1);
      const args = splitTop(toks, k + 2, close);
      const v = args.length ? evalArg(...args[0]) : null;
      if (v && v.k === "str") load(k, close, v.v, "dynamic-import");
      else if (v && v.k === "url") load(k, close, v.v, "dynamic-import");
      else unres(k, close, "dynamic import() whose specifier does not evaluate statically");
      continue;
    }
    // require(x) — `require`, or an alias bound EXACTLY to `createRequire(…)`
    const isKey = isP(toks[k + 1], ":") && (isP(toks[k - 1], "{") || isP(toks[k - 1], ","));
    if (!prevDot && !isKey && (t.v === "require" || aliases.has(t.v))) {
      const isBinding = (isId(toks[k - 1], "const") || isId(toks[k - 1], "let") || isId(toks[k - 1], "var")) && isP(toks[k + 1], "=");
      if (isP(toks[k + 1], "(")) {
        const close = matchClose(toks, k + 1);
        const args = splitTop(toks, k + 2, close);
        const v = args.length === 1 ? evalArg(...args[0]) : null;
        if (v && v.k === "str") load(k, close, v.v, "require");
        else unres(k, close, "require() whose specifier does not evaluate statically");
      } else if (isP(toks[k + 1], ".") && (isId(toks[k + 2], "resolve") || isId(toks[k + 2], "main") || (isId(toks[k + 2], "cache") && !isP(toks[k + 3], "[") && !isP(toks[k + 3], "=") && !isP(toks[k + 3], ".")))) {
        // require.resolve names a path (running it is a separate site); require.main is a
        // probe; a bare read of require.cache (Object.keys(require.cache)) loads nothing
      } else if (isBinding || isId(toks[k - 1], "typeof")) {
        // the binding of an alias (const require = createRequire(…)), or a typeof probe
      } else {
        unres(k, k + 1, `${t.v === "require" ? "require" : `the require alias '${t.v}'`} used as a value (it could load code this analysis cannot see)`);
      }
      continue;
    }
    // createRequire(…)(x) — an immediately-called require
    if (t.v === "createRequire" && isP(toks[k + 1], "(")) {
      const c1 = matchClose(toks, k + 1);
      if (isP(toks[c1 + 1], "(")) {
        const close = matchClose(toks, c1 + 1);
        const args = splitTop(toks, c1 + 2, close);
        const v = args.length === 1 ? evalArg(...args[0]) : null;
        if (v && v.k === "str") load(k, close, v.v, "require");
        else unres(k, close, "createRequire(…)() whose specifier does not evaluate statically");
      }
      continue;
    }

    // child_process / worker_threads uses
    let fn = null;
    let callAt = -1;
    if (!prevDot && mods.fns.cp.has(t.v) && !mods.bindIdx.has(k)) {
      fn = mods.fns.cp.get(t.v);
      callAt = k + 1;
    } else if (!prevDot && mods.ns.cp.has(t.v) && !mods.bindIdx.has(k)) {
      if (isP(toks[k + 1], ".") && isId(toks[k + 2]) && CP_FNS.has(toks[k + 2].v)) {
        fn = toks[k + 2].v;
        callAt = k + 3;
      } else {
        unres(k, k + 2, `the child_process module '${t.v}' used as a value`);
        continue;
      }
    } else if (t.v === "Worker" && isId(toks[k - 1], "new") && mods.fns.wt.has("Worker")) {
      fn = "Worker";
      callAt = k + 1;
    } else if (prevDot && t.v === "Worker" && isId(toks[k - 2]) && mods.ns.wt.has(toks[k - 2].v) && isId(toks[k - 3], "new")) {
      fn = "Worker";
      callAt = k + 1;
    } else if (prevDot && CP_FNS.has(t.v) && isP(toks[k - 2], ")")) {
      // require("child_process").spawnSync(…) — a member use straight off the load
      let d = 0;
      let o = -1;
      for (let j = k - 2; j >= 0; j--) {
        if (isP(toks[j], ")")) d++;
        else if (isP(toks[j], "(") && --d === 0) {
          o = j;
          break;
        }
      }
      if (o > 0 && (isId(toks[o - 1], "require") || isId(toks[o - 1], "import")) && toks[o + 1] && toks[o + 1].t === "str" && /^(node:)?child_process$/.test(toks[o + 1].v)) {
        fn = t.v;
        callAt = k + 1;
      }
    }
    if (!fn) continue;
    if (!isP(toks[callAt], "(")) {
      unres(k, k + 1, `child_process function '${t.v}' used as a value (it could be called where this analysis cannot see)`);
      continue;
    }
    const close = matchClose(toks, callAt);
    const args = splitTop(toks, callAt + 1, close);
    if (SHELL_FNS.has(fn)) {
      unres(k, close, `${fn}() runs a shell command string`);
      continue;
    }
    if (fn === "fork" || fn === "Worker") {
      const v = args.length ? evalArg(...args[0]) : null;
      const p = v && (v.k === "str" ? v.v : v.k === "url" ? fileURLToPath(v.v) : null);
      if (p && path.isAbsolute(p)) out.spawns.push({ line: t.line, kind: "node-script", script: p, how: fn });
      else unres(k, close, `${fn}() whose module argument does not evaluate statically`);
      continue;
    }
    const cmd = args.length ? evalArg(...args[0]) : null;
    if (!cmd) {
      unres(k, close, `${fn}() whose command does not evaluate statically`);
      continue;
    }
    const isNode = cmd.k === "node" || (cmd.k === "str" && cmd.v === "node");
    if (isNode) {
      const a1 = args[1];
      if (!a1 || !isP(toks[a1[0]], "[") || matchClose(toks, a1[0]) !== a1[1] - 1) {
        unres(k, close, `${fn}(node, …) whose argument vector is not an array literal`);
        continue;
      }
      const els = splitTop(toks, a1[0] + 1, a1[1] - 1);
      const first = els.length ? evalArg(...els[0]) : null;
      if (!first || first.k !== "str" || first.v.startsWith("-")) {
        unres(k, close, `${fn}(node, […]) whose script does not evaluate statically, or that passes node flags/-e`);
        continue;
      }
      out.spawns.push({ line: t.line, kind: "node-script", script: path.resolve(dir, first.v), how: fn });
      continue;
    }
    if (cmd.k === "git") {
      out.spawns.push({ line: t.line, kind: "external", program: "git", how: fn });
      continue;
    }
    if (cmd.k === "str") {
      const c = cmd.v;
      if (/^(sh|bash|zsh|dash|ksh|cmd|cmd\.exe|powershell|pwsh|env|xargs)$/.test(path.basename(c))) {
        unres(k, close, `${fn}('${c}') runs a shell or a command launcher`);
        continue;
      }
      if (!c.includes("/") && !c.includes("\\")) {
        out.spawns.push({ line: t.line, kind: "external", program: c, how: fn });
        continue;
      }
      out.spawns.push({ line: t.line, kind: "executable", file: path.resolve(dir, c), how: fn });
      continue;
    }
    unres(k, close, `${fn}() whose command evaluates to a ${cmd.k}`);
  }
  out.builtins = [...out.builtins].sort();
  out.ids = [...out.ids];
  return out;
}

// ── declarations (reviewed; each pinned to the sha256 of the file it describes) ─────────
//
// A declaration resolves an unresolved SITE (matched by its collapsed source text, the
// `site` string analyzeSource reports, `count` times) to what it executes:
//   targets   repo-relative files it loads or runs (walked like any other member)
//   programs  external programs it runs (listed)
//   refuse    a site that loads or runs code from a location the broker cannot pin — a root
//             the REQUESTER chooses (a --repo argument), or a temp-dir copy. Declared so the
//             reason is reviewed and named, and the writer is REFUSED while the site exists.
// An opaque (non-JavaScript) executable is declared with site "<opaque>".

//   reachedOnlyVia  the site runs only inside these functions of its own file; it stays
//             resolved only while NO OTHER closure member names one of them (checked per walk)
const RUNS_ADMITTED_ENTRY = "runs the entry of a trusted writer that admit() has just checked — that entry's own closure is computed and checked at its admission";
const PS = ["/bin/ps|/usr/bin/ps"];
const HOOK_SHIM = (script) => ({
  site: "<opaque>",
  targets: [script],
  programs: ["git", "node"],
  why: `POSIX sh shim: runs \`node "$REPO_ROOT/${script}"\`, REPO_ROOT = \`git rev-parse --show-toplevel\` of the checkout git acts on. The broker pins every writer's cwd to the primary; a writer that points git at another checkout is refused at its own site (land-lane, build-trust-root).`,
});

export const DECLARATIONS = [
  { file: ".git/hooks/commit-msg", sha256: "224e61de8d85b52a392e1ae54189fe0ccbad7f9bc610aeab8660d9ad41fb680d", sites: [HOOK_SHIM("scripts/ci/commit-msg-direct-stamp.mjs")] },
  { file: ".git/hooks/pre-push", sha256: "f2aae69a90a063febe6e2080c92cba04baf6670cb73ce4f171d8460caaa283e1", sites: [HOOK_SHIM("scripts/ci/dev-push-guard.mjs")] },
  // the tracked copies a clone activates with core.hooksPath=.githooks (same bytes)
  { file: ".githooks/commit-msg", sha256: "224e61de8d85b52a392e1ae54189fe0ccbad7f9bc610aeab8660d9ad41fb680d", sites: [HOOK_SHIM("scripts/ci/commit-msg-direct-stamp.mjs")] },
  { file: ".githooks/pre-push", sha256: "f2aae69a90a063febe6e2080c92cba04baf6670cb73ce4f171d8460caaa283e1", sites: [HOOK_SHIM("scripts/ci/dev-push-guard.mjs")] },
  {
    file: ".claude/bin/build-trust-root.mjs",
    sha256: "df15fd15f81d1d434b412c79ddc62914cc6e2ceda04325f0436451850ac51b1a",
    sites: [
      {
        site: 'require ( join ( args . repo , ".claude" , "hooks" , "lib" , "burndown-events.js" )',
        targets: [".claude/hooks/lib/burndown-events.js"],
        refuse: "requires <--repo>/.claude/hooks/lib/burndown-events.js (:137), and --repo is a REQUESTER argument (:125): a sandboxed caller names a writable directory and the broker would require its code outside the sandbox. Fix in the writer: load code relative to its own file (HERE), never relative to --repo",
      },
    ],
  },
  {
    file: ".claude/bin/coc-roster-register.mjs",
    sha256: "f96b83d4c1557f0b4896db2fb7412e21ba968dc60d88a6a1f73ffdedf19f43b3",
    sites: [
      {
        site: 'require ( path . resolve ( repoDir , ".claude/hooks/lib/roster-schema-validate.js" ) )',
        targets: [".claude/hooks/lib/roster-schema-validate.js"],
        why: "repoDir = COC_REPO_DIR || process.cwd() (:469); the broker pins cwd to the primary and never passes COC_REPO_DIR (ROOT_ENV)",
      },
    ],
  },
  {
    // RE-PINNED 2026-10-19 (fail-closed completeness lane). This is a REFUSE declaration, so a
    // re-pin cannot admit anything: it restores the designed refusal text, which the stale pin
    // had replaced with a generic one. The lane changed land-lane.mjs to route every working-tree
    // write through gitWritingTree (keepRegistryCopy before each registry write), adding one
    // STATIC require of ../hooks/lib/dispatch-registry.js and no exec site. The declared site
    // (runLaneNode's spawnSync) is byte-unchanged; only its line moved, so the cites below are
    // now symbols, not line numbers.
    file: ".claude/bin/land-lane.mjs",
    sha256: "19314d74338c38c0ad1a2a2418dc8d60e695a318e75c3feb48200ddf26318330",
    sites: [
      {
        site: 'spawnSync ( process . execPath , args , { cwd : repo , encoding : "utf8"',
        targets: [".claude/bin/check-citation-targets.mjs", ".claude/bin/emit-hook-registry.mjs", ".claude/bin/sync-tier-aware.mjs"],
        refuse: "runLaneNode(repo, args) runs <repo>/.claude/bin/{check-citation-targets, emit-hook-registry, sync-tier-aware}.mjs (each tool path joined onto repo), and repo = --repo or cwd (main's assertRepo(o.repo || process.cwd())): --repo is a REQUESTER argument that names any checkout — a lane worktree's bin/ is editable lane work — and it also points git, and so the hooks' $REPO_ROOT, at that checkout. Fix in the writer: under the broker (COC_GUARD_BROKER=1) refuse a --repo that is not the primary, and resolve tool code from land-lane's own checkout",
      },
    ],
  },
  {
    file: ".claude/bin/lib/strip-build-internal.mjs",
    sha256: "2dbbc958172c48656f4fbc7525e4d80aee2c2e7306849394d8b476dd615819fc",
    sites: [
      {
        site: 'spawnSync ( process . execPath , [ path . join ( libDir , "strip-build-internal.mjs" ) ,',
        why: "the F6 redaction self-test runs a TEMP COPY of this directory (:1885-1898) inside f6RedactionSelftest (:1790) ← selftest (:1985, :2042); neither is exported, and only the isMainModule block (:2197) calls selftest — unreachable while this file is a library in a writer's closure",
      },
    ],
  },
  {
    // RE-PINNED 2026-10-21 (release-reds train, second pass). This one is a COMMENTS-ONLY
    // edit and nothing else: four line-number citations were re-anchored after the 9-commit
    // landing shifted .claude/bin/run-harness-suites.mjs (+23 lines) and the workflow's PyYAML
    // step shifted .github/workflows/coc-artifact-eval.yml (+17 lines). `git diff` on this file
    // at the re-pin is eight changed lines and every one of them begins with a comment marker —
    // no code, no spawn site, no argument shape, no reachability change. The real code change
    // in this train was the FIRST pass: `expandCheckArg` (fs.globSync, cwd = REPO_ROOT), the
    // `checkArgs` flatMap in `runCheck`, and the `multi-operator-integration` CHECKS entry
    // with its CHECK_BUDGETS_MS row. The three unresolved sites this declaration leaves
    // standing - spawn(NODE,[script), spawnSync(ps), spawnSync(PS) - are untouched; neither
    // re-pin is a step toward admitting them.
    // RE-PINNED 2026-10-22 (R2 fenced re-pins). COMMENTS-ONLY again: four `(workflow :<n>)`
    // citations in the header block comment, each one line stale after a workflow step was
    // inserted above them, now name the workflow STEP instead. `git diff` on the file is four
    // changed lines, all inside the leading `/* … */` block — no code, no spawn site, no
    // argument shape, no reachability change.
    // RE-PINNED 2026-10-23 (R2 cite rot, min-cases lane). COMMENTS-ONLY again: the
    // `describeCapturedFailures` header comment's line-range citations of
    // run-harness-suites.mjs and registration-preflight.mjs, stale after a 7-line runner
    // insertion, now name SYMBOLS (`::classifySuite`, `::reportCompletenessFailure`,
    // `::checkRegistryCoverage`) plus one scoped range. `git diff` on the file against the
    // previous pin is 16 changed lines (12 added, 4 removed), all inside that one `/** … */`
    // block — no code, no spawn site, no argument shape, no reachability change.
    file: "scripts/ci/dev-preflight.mjs",
    sha256: "33d07c9bb1a5702dd158d9e1f6f12b7889b16ac700d145514bff42e71c1786a1",
    sites: [
      {
        site: 'spawnSync ( NODE , [ tool , "--files" , changed . join ( "," ) ,',
        reachedOnlyVia: ["importReceipt"],
        // Anchored to SYMBOLS, not line numbers: the numeric cites this row carried went stale
        // the moment the train above inserted ~80 lines, and a re-pin is exactly when a stale
        // cite is least visible.
        why: "owedSuites runs <REPO_ROOT>/.claude/bin/owed-suites.mjs; reached via corpusTestsNarrowing from the exported importReceipt and from main, which only the isMainModule line calls. The pre-push guard imports this module for validateReceiptShape / contentDigest / toAsciiPrintable / CHECKS / BASE_REFS only",
      },
    ],
  },
  {
    // RE-PINNED 2026-10-22 (R2 fenced re-pins). Reviewed: the pinned ps site is byte-identical,
    // the file's spawn/exec count is unchanged (4 -> 4), and the only new requires are
    // ./boundary-seed.js and ./context-state.js, neither of which starts a process. The cite
    // below is now a symbol, not a line number, so it survives the next edit above it.
    file: ".claude/hooks/lib/context-meter.js",
    sha256: "add9e8f85fd3c58cb3dd5007de5790dd156c59d775f08efa458c415944fb08a1",
    sites: [{ site: 'execFileSync ( bin , [ "-o" , "ppid=" , "-o" , "lstart=" , "-o" , "comm="', programs: PS, why: "bin = session-load-backstop.js::resolvePsBinary(), fixed absolute candidates" }],
  },
  {
    file: ".claude/hooks/lib/coord-background.js",
    sha256: "f0844868e453bc157977d726a13ac11048eb4bf63687d885830b502415667d1f",
    sites: [
      { site: "spawn ( process . execPath , [ scriptPath , WORKER_FLAG ] , { detached : true", reachedOnlyVia: ["spawnDetachedWorker"], why: "scriptPath is the CALLER's hook file (:153); called by hook entry points, never by a writer's closure" },
      { site: "spawnSync ( process . execPath , [ scriptPath , WORKER_FLAG ] , { timeout : budgetMs", reachedOnlyVia: ["runBoundedWorker"], why: "scriptPath is the CALLER's hook file (:774)" },
      { site: "spawn ( process . execPath , [ scriptPath , CACHE_REBUILD_FLAG ] , { detached : true", reachedOnlyVia: ["spawnDetachedCacheRebuild"], why: "scriptPath is the CALLER's hook file (:1101)" },
    ],
  },
  {
    file: ".claude/hooks/lib/guard-foundation/broker/broker.mjs",
    sha256: "e81d35143a325d672a1d607a52868083052df1943aea868e35baf37d344a3730",
    sites: [{ site: "spawnSync ( process . execPath , [ ad . entryAbs , ... request . args ]", why: RUNS_ADMITTED_ENTRY }],
  },
  {
    file: ".claude/hooks/lib/landing-window-read.js",
    sha256: "cec176227df5e70639b93734de0354eeb8698e8efab7f22289d71bbd7f0b3f5b",
    sites: [{ site: 'spawnSync ( bin , [ "-o" , "lstart=" , "-p" , String ( pid ) ]', programs: PS, why: "processStartToken: bin = PS_CANDIDATES.find(…), the fixed absolute candidates /bin/ps and /usr/bin/ps" }],
  },
  {
    file: ".claude/hooks/lib/session-load-backstop.js",
    sha256: "b40a4fb6f7e6b80850e095c34170df6045a96933a1fcb8117571d09fe723cbfa",
    sites: [
      { site: "spawnSync ;", programs: PS, why: "readProcessTable (:236): spawn = opts.spawn || spawnSync, called with resolvePsBinary() (:214-220, fixed absolute candidates)" },
      { site: "require ;", count: 2, targets: [".claude/hooks/lib/synthetic-load.js"], why: 'loadClassifier / loadConditionalLoadWords (:810-830): req = requireFn || require, called only with "./synthetic-load.js"' },
    ],
  },
  {
    file: ".claude/hooks/lib/state-resolver.js",
    sha256: "ef835aefe7ee76e705cb0b99504475a60e72fcf5fe15fb993012629096e45e07",
    // RE-DERIVED from the landed bytes after P1's target-envelope routing moved the exec
    // behind an injected `spawn` seam, so the analyzer can no longer evaluate the command
    // statically (it reports exactly this one site as unresolved). The executed program did
    // NOT widen: `spawn(file, argv, options)` is the closure _spawnProbe defines and hands to
    // targetGitAt / resolveTargetRepo / targetGit through options.spawn, and every `file`
    // those functions pass to an injected spawn is resolveGitBinary() — target-repo-git.js
    // resolves it at targetGitInvocation, targetGitAt and targetGit, then calls
    // `inject(gitBin, …)` in _spawn. Same resolver, same program class: git, never
    // caller-chosen. Symbols, not line numbers, so the cite survives the next edit above it.
    sites: [{ site: 'execFileSync ( file , argv , { cwd : options . cwd , encoding : "utf8"', programs: ["git"], why: "_spawnProbe's injected `spawn` closure: every `file` reaching it is resolveGitBinary() from target-repo-git.js (_spawn's inject branch, fed by targetGitInvocation / targetGitAt / targetGit)" }],
  },
  {
    file: ".claude/hooks/lib/target-repo-git.js",
    sha256: "24ce397651cff9b073817a199cb43254f39cb1f6a7ce128e275f3843cad68bbc",
    // A plain site, with NO reachedOnlyVia: the vault-render members reach this exec
    // DIRECTLY, not only through state-resolver's injected seam, so scoping it to a route
    // would under-declare it. `_spawn` is unexported; each of its callers resolves the
    // binary itself.
    sites: [{ site: 'spawnSync ( gitBin , argv , { cwd : opts . cwd , encoding : "utf8"', programs: ["git"], why: "_spawn is the one spawn site and is not exported; its only callers — targetGit (through targetGitInvocation), targetGitAt and _revParse — each pass resolveGitBinary(), with argv through the protected wrapper and env through targetRepoEnv(). The :354 inject branch is a test seam, not an exec site." }],
  },
  {
    // RE-PINNED 2026-10-19 (fail-closed completeness lane). Reviewed: the diff against the
    // previous pin is ONE line inside a block comment (a validate-bash-command.js citation
    // re-anchored from a line number to a symbol), with the line count unchanged. No code, no
    // exec site and no reachability changed, so the (:268)/(:324)/(:381) cites below still hold.
    file: ".claude/hooks/lib/version-utils.js",
    sha256: "7e4dacf272a01f87fbdbfc486f9b5249b3a354d2698d55eaac850869bfc2eb13",
    sites: [
      {
        // the TOKENIZED text of version-utils.js's real (1471-G4-ledgered) site, not a spawn here; \x22 is the quote, spelled to keep 1471's lexical scan off a non-spawn
        site: 'execFileSync ( \x22node\x22 , [ script , "--json" ] , { cwd , encoding : "utf8"',
        reachedOnlyVia: ["checkVersion", "resolveReplicaFreshness", "runCanonFetchProbe"],
        why: "runs <cwd>/.claude/bin/sync-from-canon-fetch.mjs (:268) through node on PATH; reached only via runCanonFetchProbe ← resolveReplicaFreshness (:324) ← checkVersion (:381)",
      },
    ],
  },
];

/** Names of environment variables that move a declared site's root: the broker never passes them. */
export const ROOT_ENV = ["COC_REPO_DIR"];

// ── git hooks ────────────────────────────────────────────────────────────────────────────

// Loaded through an evaluable specifier, so this module's own closure resolves statically.
const gse = require(path.join(HERE, "..", "..", "git-subprocess-env.js"));

/**
 * Ask git (scrubbed of ambient GIT_* by git-subprocess-env.js::gitEnv) a question in `dir`.
 * `withUserConfig` keeps HOME and lifts the global/system config neutralisers, because a
 * writer's own git may read them (core.hooksPath can be set globally).
 */
function askGit(dir, args, { withUserConfig = false } = {}) {
  const bin = gse.resolveGitBinary();
  if (!bin) return { ok: false, err: "no git binary on a trusted path" };
  const env = gse.gitEnv();
  if (withUserConfig) {
    delete env.GIT_CONFIG_NOSYSTEM;
    delete env.GIT_CONFIG_GLOBAL;
    delete env.GIT_CONFIG_SYSTEM;
    if (process.env.HOME) env.HOME = process.env.HOME;
    if (process.env.XDG_CONFIG_HOME) env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  }
  const r = spawnSync(bin, ["-C", dir, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000 });
  if (r.status !== 0) return { ok: false, err: (r.stderr || String(r.error || "")).trim().slice(0, 300) };
  return { ok: true, out: r.stdout.trim() };
}

/**
 * The PRIMARY checkout of the repository holding `dir`: the parent of git's common dir, when
 * that parent's `.git` IS the common dir (so a bare repo, a submodule or a separate git dir
 * fails closed). Returns { primary } or { error }.
 */
export function resolvePrimary(dir) {
  const r = askGit(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!r.ok) return { error: `git could not name the common dir of ${dir}: ${r.err}` };
  let common;
  try {
    common = fs.realpathSync(r.out);
  } catch {
    return { error: `the common dir ${r.out} does not resolve` };
  }
  const parent = path.dirname(common);
  let dotgit = null;
  try {
    dotgit = fs.realpathSync(path.join(parent, ".git"));
  } catch {}
  if (path.basename(common) !== ".git" || dotgit !== common) {
    return { error: `the common dir ${common} is not the .git directory of a checkout (bare repository, submodule or separate git dir)` };
  }
  return { primary: parent };
}

/** Every file in the effective git hooks directories of `primary` (sample files excluded). */
export function gitHookFiles(primary) {
  const dirs = new Set();
  const errors = [];
  for (const withUserConfig of [false, true]) {
    const r = askGit(primary, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"], { withUserConfig });
    if (!r.ok) errors.push(r.err);
    else dirs.add(path.resolve(primary, r.out));
  }
  const files = [];
  for (const d of [...dirs].sort()) {
    let names = [];
    try {
      names = fs.readdirSync(d);
    } catch (e) {
      if (e.code !== "ENOENT") errors.push(`${d}: ${e.code}`);
      continue;
    }
    for (const nm of names.sort()) if (!nm.endsWith(".sample")) files.push(path.join(d, nm));
  }
  return { dirs: [...dirs].sort(), files, errors };
}

// ── the closure walk ─────────────────────────────────────────────────────────────────────

const JS_EXT = /\.(m|c)?js$/;
const cache = new Map(); // sha256 -> analysis (re-read and re-hashed on every walk)

function analyzeFileCached(abs, buf) {
  const digest = sha256(buf);
  const key = `${digest}:${abs}`;
  if (!cache.has(key)) {
    let a;
    try {
      a = analyzeSource(buf.toString("utf8"), abs);
    } catch (e) {
      a = { loads: [], spawns: [], builtins: [], unresolved: [{ line: 0, site: "<scan>", reason: `could not be scanned: ${e.message}` }] };
    }
    cache.set(key, a);
  }
  return { digest, a: cache.get(key) };
}

function resolveModule(abs) {
  for (const c of [abs, `${abs}.js`, `${abs}.mjs`, `${abs}.cjs`, `${abs}.json`, path.join(abs, "index.js")]) {
    try {
      const st = fs.lstatSync(c);
      if (!st.isDirectory()) return c;
    } catch {}
  }
  return abs; // missing: reported by the caller as a member that is not a protected file
}

/**
 * The execution closure of `entry` (absolute) within `primary`.
 * Returns { members: [{abs, rel, via}], builtins, programs: [{program, from, line}],
 *           unresolved: [{file, line, site, reason}], hooks: {dirs, files, errors} | null }.
 */
export function computeClosure({ primary, entry, declarations = DECLARATIONS, hooks = true } = {}) {
  const primaryReal = fs.realpathSync(primary);
  // A repo-anchored `.git/…` row means the COMMON git dir (os-profile/seatbelt.mjs maps it so),
  // so a member under the common dir is named `.git/<rest>` even when `primary` is a worktree.
  const common = askGit(primaryReal, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  let commonReal = null;
  try {
    commonReal = common.ok ? fs.realpathSync(common.out) : null;
  } catch {}
  const relOf = (abs) => {
    if (commonReal) {
      const r = path.relative(commonReal, abs);
      if (r && !r.startsWith("..") && !path.isAbsolute(r)) return toPosix(path.join(".git", r));
    }
    return toPosix(path.relative(primaryReal, abs));
  };
  const declByFile = new Map(declarations.map((d) => [d.file, d]));
  const members = new Map();
  const builtins = new Set();
  const programs = [];
  const unresolved = [];
  let usesGit = false;
  const onlyVia = []; // declared sites reachable only through named functions of their own file
  const idsOf = new Map(); // rel -> identifiers of each analysed member
  const stack = [{ abs: entry, via: "entry" }];
  const add = (abs, via) => stack.push({ abs, via });

  const applyDeclaration = (rel, digest, open) => {
    const d = declByFile.get(rel);
    // Nothing unresolved in this file: no declaration is needed, and a stale one is moot.
    if (!open.length) return;
    if (!d) {
      for (const u of open) unresolved.push({ file: rel, ...u });
      return;
    }
    if (d.sha256 !== digest) {
      unresolved.push({ file: rel, line: 0, site: "<declaration>", reason: `the declaration for ${rel} is pinned to sha256 ${d.sha256.slice(0, 12)}…, the file is now ${digest.slice(0, 12)}…: re-review and re-pin it` });
      for (const u of open) unresolved.push({ file: rel, ...u });
      return;
    }
    const left = [...open];
    for (const s of d.sites) {
      const want = s.count || 1;
      let got = 0;
      for (let i = left.length - 1; i >= 0; i--) if (left[i].site === s.site && got < want) {
        left.splice(i, 1);
        got++;
      }
      if (got !== want) {
        unresolved.push({ file: rel, line: 0, site: s.site, reason: `declared ${want} site(s), found ${got}: the declaration is stale` });
        continue;
      }
      // A refused site's targets are still walked, so the rows report names what it would run.
      if (s.refuse) unresolved.push({ file: rel, line: 0, site: s.site, reason: `DECLARED UNSAFE: ${s.refuse}` });
      if (s.reachedOnlyVia) onlyVia.push({ rel, site: s.site, names: s.reachedOnlyVia });
      for (const t of s.targets || []) add(path.join(primaryReal, t), `declared:${rel}`);
      for (const p of s.programs || []) {
        programs.push({ program: p, from: rel, line: 0 });
        if (p === "git") usesGit = true;
      }
    }
    for (const u of left) unresolved.push({ file: rel, ...u });
  };

  const drain = () => {
    while (stack.length) {
      const { abs, via } = stack.pop();
      if (members.has(abs)) continue;
      const rel = relOf(abs);
      members.set(abs, { abs, rel, via });
      let st;
      try {
        st = fs.lstatSync(abs);
      } catch {
        continue; // a missing member is refused by the broker (not a protected regular file)
      }
      if (!st.isFile()) continue; // a symlink or a directory: refused by the broker likewise
      const buf = fs.readFileSync(abs);
      if (abs.endsWith(".json")) continue; // data, not code
      const isJs = JS_EXT.test(abs) || /^#![^\n]*\bnode\b/.test(buf.subarray(0, 120).toString("utf8"));
      if (!isJs) {
        applyDeclaration(rel, sha256(buf), [{ line: 0, site: "<opaque>", reason: "a non-JavaScript executable: what it runs cannot be analysed" }]);
        continue;
      }
      const { digest, a } = analyzeFileCached(abs, buf);
      idsOf.set(rel, a.ids || []);
      for (const b of a.builtins) builtins.add(b);
      for (const l of a.loads) add(resolveModule(l.abs), `${l.how}:${rel}:${l.line}`);
      for (const s of a.spawns) {
        if (s.kind === "node-script") add(s.script, `${s.how}:${rel}:${s.line}`);
        else if (s.kind === "executable" && !relOf(s.file).startsWith("../")) add(s.file, `${s.how}:${rel}:${s.line}`);
        else if (s.kind === "executable") programs.push({ program: s.file, from: rel, line: s.line });
        else {
          programs.push({ program: s.program, from: rel, line: s.line });
          if (s.program === "git") usesGit = true;
        }
      }
      applyDeclaration(rel, digest, a.unresolved);
    }
  };

  drain();
  // git runs the hooks of the repository it acts on; a writer that spawns git runs them too.
  let hk = null;
  if (hooks && usesGit) {
    hk = gitHookFiles(primaryReal);
    for (const e of hk.errors) unresolved.push({ file: "<git hooks>", line: 0, site: "git rev-parse --git-path hooks", reason: e });
    for (const f of hk.files) add(f, "git-hook");
    drain();
  }
  // A site declared reachable only through functions of its own file stays resolved only while
  // no OTHER member of this closure names one of those functions.
  for (const o of onlyVia) {
    for (const [rel, ids] of idsOf) {
      if (rel === o.rel) continue;
      const hit = o.names.filter((nm) => ids.includes(nm));
      if (hit.length) unresolved.push({ file: o.rel, line: 0, site: o.site, reason: `declared reachable only via ${o.names.join(", ")}, but closure member ${rel} names ${hit.join(", ")}` });
    }
  }
  return {
    members: [...members.values()].sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0)),
    builtins: [...builtins].sort(),
    programs: programs.sort((x, y) => (x.program + x.from).localeCompare(y.program + y.from)),
    unresolved,
    hooks: hk,
  };
}

// ── policy data: the closure of every trusted writer as candidate protected_write rows ──

const rowId = (rel) => `closure-${rel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;

/**
 * For every trusted writer of `policy`, its closure in `repo` and whether the policy covers
 * each member. Deterministic: writers in policy order, rows sorted by path.
 */
export function closureRows({ repo, policy }) {
  const repoReal = fs.realpathSync(repo);
  const pr = resolvePrimary(repoReal);
  const rows = new Map();
  const writers = [];
  for (const w of policy.trusted_writers) {
    const c = computeClosure({ primary: repoReal, entry: path.join(repoReal, w.entry) });
    const uncovered = [];
    for (const m of c.members) {
      let st = null;
      try {
        st = fs.lstatSync(m.abs);
      } catch {}
      const inside = !m.rel.startsWith("../") && !path.isAbsolute(m.rel);
      const covered = inside && !!st && st.isFile() && repoProtects(policy, m.rel);
      if (!covered) uncovered.push(m.rel);
      if (!rows.has(m.rel)) rows.set(m.rel, { id: rowId(m.rel), anchor: "repo", path: m.rel, covered, exists: !!st, inside, writers: [] });
      rows.get(m.rel).writers.push(w.id);
    }
    writers.push({
      id: w.id,
      entry: w.entry,
      admissible: uncovered.length === 0 && c.unresolved.length === 0,
      members: c.members.length,
      uncovered,
      unresolved: c.unresolved,
      programs: [...new Set(c.programs.map((p) => p.program))].sort(),
      builtins: c.builtins,
      hooks: c.members.filter((m) => m.via === "git-hook").map((m) => m.rel),
    });
  }
  const all = [...rows.values()].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  for (const r of all) r.reason = `execution closure of trusted writer(s) ${r.writers.join(", ")} (broker/closure.mjs)`;
  return {
    repo: repoReal,
    is_primary: pr.primary === repoReal,
    primary: pr.primary || null,
    node_modules: "none walked: a bare (non-builtin) specifier is UNRESOLVED; loom ships no package.json or node_modules",
    writers,
    candidate_rows: all.filter((r) => !r.covered && r.inside && r.exists).map(({ id, anchor, path: p, reason }) => ({ id, anchor, path: p, reason })),
    not_rowable: all.filter((r) => !r.covered && !(r.inside && r.exists)).map((r) => ({ path: r.path, inside: r.inside, exists: r.exists, writers: r.writers })),
    covered: all.filter((r) => r.covered).map((r) => r.path),
  };
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const cmd = argv.shift();
  const o = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo" || argv[i] === "--policy") o[argv[i].slice(2)] = argv[++i];
    else pos.push(argv[i]);
  }
  const fail = (m) => {
    process.stderr.write(`closure: ${m}\n`);
    process.exit(2);
  };
  let repo = o.repo;
  if (!repo) {
    const pr = resolvePrimary(process.cwd());
    if (!pr.primary) fail(`no --repo, and ${pr.error}`);
    repo = pr.primary;
  }
  const policy = loadPolicy(o.policy || POLICY_PATH);
  if (cmd === "rows") {
    const r = closureRows({ repo, policy });
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    process.exit(r.writers.every((w) => w.admissible) ? 0 : 1);
  } else if (cmd === "show" && pos.length === 1) {
    const w = policy.trusted_writers.find((x) => x.id === pos[0]);
    if (!w) fail(`no trusted writer ${pos[0]}`);
    const repoReal = fs.realpathSync(repo);
    const c = computeClosure({ primary: repoReal, entry: path.join(repoReal, w.entry) });
    process.stdout.write(`${JSON.stringify({ ...c, members: c.members.map(({ rel, via }) => ({ rel, via })) }, null, 2)}\n`);
  } else {
    fail("usage: closure.mjs rows [--repo <primary>] [--policy <file>] | show <writer-id> [--repo <primary>] [--policy <file>]");
  }
}
