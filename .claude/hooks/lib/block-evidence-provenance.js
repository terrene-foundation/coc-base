#!/usr/bin/env node
/**
 * block-evidence-provenance.js — the mechanical half of `hook-output-discipline.md`
 * MUST-5(a), which until now had none.
 *
 * ONE QUESTION, asked of a detector-bearing JavaScript source:
 *
 *     "Does any object literal carrying `severity: \"block\"` also carry an
 *      `evidence` field whose value is derived from a `match()` / `exec()` /
 *      `matchAll()` result?"
 *
 * That is the check MUST-5's Trust-Posture Wiring names as its ONE genuine Phase-2
 * deferral, verbatim: "a `validate-emit.mjs`-class check could assert that no
 * `severity: \"block\"` return in `violation-patterns.js` has a `match()`-derived
 * `evidence` field." This module IS that check. It is deliberately a PROXY for the
 * clause (see § SEVERITY below) and says so rather than claiming to decide the
 * clause outright.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY A TOKENIZER AND NOT A REGEX — MEASURED, NOT PREFERRED
 * ════════════════════════════════════════════════════════════════════════════════
 * Node ships no JS parser in core and this repo has NO `node_modules` and no
 * dependency manifest at the root (measured: `find . -maxdepth 3 -name package.json`
 * returns only the two `codex-mcp-guard` trees; `find . -maxdepth 3 -name node_modules`
 * returns nothing). So an off-the-shelf AST walk is not available and the choice is
 * between a regex and a hand-rolled scanner.
 *
 * A regex is DISQUALIFIED here on this repo's own evidence, not on principle. The
 * subject file `.claude/hooks/lib/violation-patterns.js` carries, in PROSE COMMENTS:
 *   - `// severity:block from lexical regex is BLOCKED — halt-and-report is the`
 *   - `// The signal (why \`severity:block\` is justified per hook-output-discipline.md`
 * A `grep`-shaped check keying on the token would flag both, and a detector whose
 * first real-tree run is two false positives on its own rule's commentary is the
 * failure this rule exists to name. It would also be a LEXICAL check emitting a
 * verdict about whether another detector's signal is lexical — instancing its own
 * subject matter.
 *
 * So this module LEXES JavaScript — comments, strings, template literals with
 * `${}` interpolation, and regex literals are all recognised as such — and then
 * reasons over TOKENS: brace matching is exact, an object literal's direct
 * properties are enumerated at one nesting level, and the `evidence` value is a
 * token RANGE, not a line. The signal is therefore STRUCTURAL (a token-level
 * source fact: which expression feeds which property of which object literal),
 * which is what `hook-output-discipline.md` MUST-5(a) asks an enforcing check to
 * dispatch on. It is NOT a full parser, and § WHAT IT CANNOT SEE below is the
 * honest boundary — named inline per `conservation-gate.md` MUST-3 rather than
 * left for a reader to discover.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT IT DOES SEE
 * ════════════════════════════════════════════════════════════════════════════════
 *   `severity: "block"` as a real property of a real object literal — never the
 *       same characters inside a comment, a string, a template chunk or a regex.
 *   `evidence:` as a DIRECT property of that same object literal (depth 1), not a
 *       property of some nested or sibling object that happens to be nearby.
 *   Evidence built directly from a match call:  `evidence: cmd.match(RX)[0]`
 *   Evidence interpolated in a template:        `evidence: \`saw ${m[0]}\``
 *   Evidence read off an INTERMEDIATE BINDING — the case a same-line matcher
 *       misses entirely:
 *           const m = cmd.match(RX);
 *           return { severity: "block", evidence: m[0] };
 *       resolved by tainting bindings whose initialiser contains a match/exec/
 *       matchAll call, within the ENCLOSING FUNCTION BODY, to a fixpoint (so
 *       `const m = s.match(RX); const g = m[1]; … evidence: g` is also seen).
 *   Destructured match results:  `const [, g1] = s.match(RX)` · `const { groups } = RX.exec(s)`
 *   Plain re-assignment:         `let m; m = RX.exec(s);`
 *   `RegExp.$1` and friends.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT IT CANNOT SEE — named, never implied (`conservation-gate.md` MUST-3)
 * ════════════════════════════════════════════════════════════════════════════════
 * Each of these is PINNED by a fixture in `.claude/audit-fixtures/parsed-signal-detector/`
 * so the blind class is asserted rather than asserted-about.
 *
 *   (1) NON-LITERAL SEVERITY. `severity: sev` / `severity: SEV.BLOCK` / the
 *       shorthand `{ severity }`. The scanner keys on a STRING LITERAL value, so a
 *       computed severity is invisible. Every `severity:` in the subject file today
 *       is a string literal (measured: 26 occurrences, all literal).
 *   (2) CROSS-FUNCTION EVIDENCE. `evidence: renderEvidence(cmd)` where the helper
 *       internally matches. Taint is INTRA-procedural; a helper's body is not
 *       followed.
 *   (3) PARAMETER-BORNE MATCHES. `function f(m) { return { severity: "block",
 *       evidence: m[0] }; }` — `m` is bound by the caller, so nothing in this
 *       function body taints it.
 *   (4) INCREMENTALLY-BUILT OBJECTS. `const o = { severity: "block" }; o.evidence = m[0];`
 *       and spread/`Object.assign` composition. Only literal properties present in
 *       the object literal itself are enumerated.
 *   (5) REGEX-VS-DIVISION after `}`. The lexer resolves `/` by the preceding
 *       significant token; after `}` it assumes DIVISION. `}` closing a block
 *       followed by a regex literal would mis-lex. No such construct exists in the
 *       subject today, and the failure mode is a parse abort (reported as
 *       `parsed:false`, never as a clean pass).
 *   (6) NON-JS SURFACES. TypeScript type annotations, JSX, and decorators are not
 *       handled; this module is pointed at `.claude/hooks/**` CommonJS only.
 *
 * A blind class produces a MISS, never a false positive, and a miss is reported as
 * a miss: `examined === 0` is returned as its own state so a caller can refuse to
 * read "no findings" as "clean" (`instrument-discipline.md` MUST-3(a)).
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * SEVERITY CEILING — WHY THIS IS `halt-and-report` AND NOT `block`
 * ════════════════════════════════════════════════════════════════════════════════
 * `hook-output-discipline.md` MUST-2 bars `block` on a LEXICAL signal. That is NOT
 * the binding constraint here, and saying it were would be the over-claim in the
 * other direction: this signal is a token-structural source fact, which MUST-2
 * explicitly admits ("a structural / behavioral / AST ... signal"). Two OTHER
 * things cap it, and both are stated rather than assumed:
 *
 *   (a) THE CHECK IS A PROXY FOR THE CLAUSE, not the clause. MUST-5(a) is about the
 *       signal a detector DISPATCHES on; "the evidence field quotes a match span" is
 *       a strong correlate and not an identity. A detector could dispatch on a
 *       genuinely parsed signal and still quote the matched text back in `evidence`
 *       for readability. That case is worth SURFACING and is not worth REFUSING,
 *       and only a human reading the dispatch can tell the two apart — which is
 *       exactly the (b)-half judgment MUST-5 says no predicate can make.
 *   (b) THE EVENT. At `PostToolUse` the edit has already landed; `block` cannot
 *       un-write it, it only halts the flow. MEASURED against the shared renderer
 *       rather than assumed: `instruct-and-wait.js` maps `severity: "block"` at a
 *       non-STOP_LIKE event to `{continue:false}` with exit 2, so `block` here
 *       would wedge an in-flight edit on a proxy. `halt-and-report` delivers the
 *       full report and leaves the edit standing, which is the intervention
 *       actually needed: the author must SAY which signal the block dispatches on.
 *
 * FAILS OPEN on every error (`cc-artifacts.md` Rule 7). A source this module cannot
 * lex returns `{parsed:false}` and the caller stays quiet — a guard that cannot read
 * a file must not cry wolf.
 *
 * NO I/O, NO NETWORK, NO CLOCK. Pure function of a string, so the fixture battery
 * and the hook exercise the identical code path.
 */

"use strict";

/** Keywords after which a `/` begins a REGEX literal rather than a division. */
const REGEX_PRECEDERS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "do",
  "else",
  "case",
  "yield",
  "await",
  "throw",
]);

/** Punctuators after which a `/` is DIVISION (the token completed a value). */
const VALUE_CLOSERS = new Set([")", "]", "}", "++", "--"]);

/** Call names whose result is a match object. */
const MATCH_CALLS = new Set(["match", "exec", "matchAll"]);

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

/**
 * Lex JavaScript into tokens. Comments are DROPPED (they are exactly the surface a
 * regex check would false-positive on). Strings, template chunks and regex literals
 * become single tokens carrying their decoded value where that is meaningful;
 * template INTERPOLATIONS are lexed as code, because `evidence: \`x ${m[0]}\`` puts
 * the thing under test inside one.
 *
 * @param {string} src
 * @returns {{tokens: Array, ok: boolean, error: string|null}}
 */
function tokenize(src) {
  const tokens = [];
  const s = String(src);
  const n = s.length;
  let i = 0;
  let line = 1;

  // Mode stack. "code" or "template". A backtick pushes "template"; `${` inside a
  // template pushes "code" and records the brace depth it must unwind to.
  const modes = ["code"];
  const tmplBrace = []; // brace depth at each open interpolation
  let brace = 0;

  const mode = () => modes[modes.length - 1];
  const last = () => (tokens.length ? tokens[tokens.length - 1] : null);

  const push = (type, start, end, value) => {
    tokens.push({
      type,
      start,
      end,
      line,
      value: value === undefined ? s.slice(start, end) : value,
    });
  };

  /** Does a `/` at position i begin a regex literal? */
  const regexAllowed = () => {
    const t = last();
    if (!t) return true;
    if (t.type === "ident") return REGEX_PRECEDERS.has(t.value);
    if (t.type === "number" || t.type === "string" || t.type === "regex") return false;
    if (t.type === "tmpl-end") return false;
    if (t.type === "punct") return !VALUE_CLOSERS.has(t.value);
    return true;
  };

  try {
    while (i < n) {
      if (mode() === "template") {
        // Raw template chunk: scan to an unescaped backtick or `${`.
        const start = i;
        let text = "";
        while (i < n) {
          const c = s[i];
          if (c === "\\") {
            text += s[i + 1] ?? "";
            i += 2;
            continue;
          }
          if (c === "`") break;
          if (c === "$" && s[i + 1] === "{") break;
          if (c === "\n") line++;
          text += c;
          i++;
        }
        if (i > start) push("tmpl-chunk", start, i, text);
        if (i >= n) throw new Error("unterminated template literal");
        if (s[i] === "`") {
          push("tmpl-end", i, i + 1, "`");
          i++;
          modes.pop();
          continue;
        }
        // `${`
        push("punct", i, i + 2, "${");
        i += 2;
        tmplBrace.push(brace);
        brace++;
        modes.push("code");
        continue;
      }

      const c = s[i];

      if (c === "\n") {
        line++;
        i++;
        continue;
      }
      if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v") {
        i++;
        continue;
      }

      // ── comments: dropped entirely ──────────────────────────────────────────
      if (c === "/" && s[i + 1] === "/") {
        while (i < n && s[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && s[i + 1] === "*") {
        i += 2;
        while (i < n && !(s[i] === "*" && s[i + 1] === "/")) {
          if (s[i] === "\n") line++;
          i++;
        }
        if (i >= n) throw new Error("unterminated block comment");
        i += 2;
        continue;
      }

      // ── string literals ─────────────────────────────────────────────────────
      if (c === '"' || c === "'") {
        const start = i;
        const q = c;
        const startLine = line;
        i++;
        let val = "";
        let closed = false;
        while (i < n) {
          if (s[i] === "\\") {
            val += s[i + 1] ?? "";
            if (s[i + 1] === "\n") line++;
            i += 2;
            continue;
          }
          if (s[i] === q) {
            i++;
            closed = true;
            break;
          }
          if (s[i] === "\n") line++;
          val += s[i];
          i++;
        }
        if (!closed) throw new Error("unterminated string literal");
        tokens.push({ type: "string", start, end: i, line: startLine, value: val });
        continue;
      }

      // ── template start ──────────────────────────────────────────────────────
      if (c === "`") {
        push("tmpl-start", i, i + 1, "`");
        i++;
        modes.push("template");
        continue;
      }

      // ── regex literal ───────────────────────────────────────────────────────
      if (c === "/" && regexAllowed()) {
        const start = i;
        i++;
        let inClass = false;
        let closed = false;
        while (i < n) {
          const d = s[i];
          if (d === "\\") {
            i += 2;
            continue;
          }
          if (d === "\n") throw new Error("unterminated regex literal");
          if (d === "[") inClass = true;
          else if (d === "]") inClass = false;
          else if (d === "/" && !inClass) {
            i++;
            closed = true;
            break;
          }
          i++;
        }
        if (!closed) throw new Error("unterminated regex literal");
        while (i < n && IDENT_PART.test(s[i])) i++; // flags
        push("regex", start, i);
        continue;
      }

      // ── identifiers / keywords ──────────────────────────────────────────────
      if (IDENT_START.test(c)) {
        const start = i;
        while (i < n && IDENT_PART.test(s[i])) i++;
        push("ident", start, i);
        continue;
      }

      // ── numbers ─────────────────────────────────────────────────────────────
      if (c >= "0" && c <= "9") {
        const start = i;
        while (i < n && /[0-9a-fA-FxXoObBeE._n]/.test(s[i])) {
          // `1..toString()` is not a thing we need; stop before a second `.`
          if (s[i] === "." && s.slice(start, i).includes(".")) break;
          i++;
        }
        push("number", start, i);
        continue;
      }

      // ── punctuation ─────────────────────────────────────────────────────────
      if (c === "{") {
        brace++;
        push("punct", i, i + 1, "{");
        i++;
        continue;
      }
      if (c === "}") {
        brace--;
        // Does this `}` close a template interpolation?
        if (tmplBrace.length && brace === tmplBrace[tmplBrace.length - 1]) {
          tmplBrace.pop();
          push("punct", i, i + 1, "}$");
          i++;
          modes.pop(); // back to template
          continue;
        }
        push("punct", i, i + 1, "}");
        i++;
        continue;
      }

      // Multi-char operators that matter for the `regexAllowed` heuristic.
      const three = s.slice(i, i + 3);
      const two = s.slice(i, i + 2);
      if (["===", "!==", "**=", "...", "<<=", ">>=", "&&=", "||=", "??=", ">>>"].includes(three)) {
        push("punct", i, i + 3, three);
        i += 3;
        continue;
      }
      if (
        ["==", "!=", "<=", ">=", "&&", "||", "??", "?.", "=>", "++", "--", "+=", "-=", "*=", "/=", "%=", "**", "<<", ">>", "|=", "&=", "^="].includes(
          two,
        )
      ) {
        push("punct", i, i + 2, two);
        i += 2;
        continue;
      }
      push("punct", i, i + 1, c);
      i++;
    }

    if (modes.length !== 1) throw new Error("unbalanced template literal");
    return { tokens, ok: true, error: null };
  } catch (e) {
    return { tokens, ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/** Build an index: token index of `{` → token index of its matching `}`, and back. */
function braceMap(tokens) {
  const open = new Map();
  const close = new Map();
  const stack = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type !== "punct") continue;
    if (t.value === "{" || t.value === "${") stack.push(k);
    else if (t.value === "}" || t.value === "}$") {
      const o = stack.pop();
      if (o === undefined) continue;
      open.set(o, k);
      close.set(k, o);
    }
  }
  return { open, close };
}

/** The innermost `{ … }` enclosing token index `k`, as [openIdx, closeIdx]. */
function enclosingBraces(tokens, bmap, k) {
  const out = [];
  const stack = [];
  for (let j = 0; j <= k; j++) {
    const t = tokens[j];
    if (t.type !== "punct") continue;
    if (t.value === "{" || t.value === "${") stack.push(j);
    else if (t.value === "}" || t.value === "}$") stack.pop();
  }
  for (let d = stack.length - 1; d >= 0; d--) {
    const o = stack[d];
    const c = bmap.open.get(o);
    if (c !== undefined) out.push([o, c]);
  }
  return out; // innermost first
}

/**
 * Enumerate the DIRECT properties of the object literal spanning [openIdx, closeIdx].
 * Returns `[{ key, keyIdx, valueStart, valueEnd }]` where the value range is
 * inclusive/exclusive over token indices.
 */
function objectProperties(tokens, bmap, openIdx, closeIdx) {
  const props = [];
  let k = openIdx + 1;
  while (k < closeIdx) {
    const t = tokens[k];
    // Skip separators.
    if (t.type === "punct" && (t.value === "," || t.value === ";")) {
      k++;
      continue;
    }
    // Key: ident, string, or number. Computed keys `[expr]:` are skipped (a
    // computed `severity` key is a declared blind class).
    let key = null;
    if (t.type === "ident" || t.type === "string" || t.type === "number") key = t.value;
    if (key === null) {
      k = skipToNextTopLevelComma(tokens, bmap, k, closeIdx);
      continue;
    }
    const colon = tokens[k + 1];
    if (!colon || colon.type !== "punct" || colon.value !== ":") {
      // Shorthand `{ severity }` or a method — no value expression to inspect.
      props.push({ key, keyIdx: k, valueStart: -1, valueEnd: -1, shorthand: true });
      k = skipToNextTopLevelComma(tokens, bmap, k, closeIdx);
      continue;
    }
    const valueStart = k + 2;
    const valueEnd = skipToNextTopLevelComma(tokens, bmap, valueStart, closeIdx);
    props.push({ key, keyIdx: k, valueStart, valueEnd, shorthand: false });
    k = valueEnd;
  }
  return props;
}

/** Advance past one property value: to the next `,` at THIS nesting level, or to `limit`. */
function skipToNextTopLevelComma(tokens, bmap, from, limit) {
  let k = from;
  let depth = 0;
  while (k < limit) {
    const t = tokens[k];
    if (t.type === "punct") {
      if (t.value === "{" || t.value === "[" || t.value === "(" || t.value === "${") depth++;
      else if (t.value === "}" || t.value === "]" || t.value === ")" || t.value === "}$") {
        if (depth === 0) return k;
        depth--;
      } else if (t.value === "," && depth === 0) return k;
    }
    k++;
  }
  return limit;
}

/** Render a token range back to readable source-ish text (for the finding message). */
function renderRange(tokens, from, to, cap = 160) {
  const parts = [];
  for (let k = from; k < to && k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === "string") parts.push(JSON.stringify(t.value));
    else if (t.type === "tmpl-chunk") parts.push(t.value);
    else if (t.type === "tmpl-start" || t.type === "tmpl-end") parts.push("`");
    // `}$` is this lexer's internal marker for the `}` that closes a `${…}`; it
    // renders as a plain `}` so a quoted evidence expression reads as source.
    else if (t.type === "punct" && t.value === "}$") parts.push("}");
    else parts.push(t.value);
  }
  const out = parts.join("").replace(/\s+/g, " ").trim();
  return out.length > cap ? `${out.slice(0, cap)}…` : out;
}

/** Does a token range contain a `.match(` / `.exec(` / `.matchAll(` call? */
function rangeHasMatchCall(tokens, from, to) {
  for (let k = from; k < to - 1 && k < tokens.length - 1; k++) {
    const t = tokens[k];
    if (t.type !== "ident" || !MATCH_CALLS.has(t.value)) continue;
    const next = tokens[k + 1];
    if (!next || next.type !== "punct" || next.value !== "(") continue;
    // `match(` preceded by `.` or `?.` is a method call; a bare `match(` is a
    // local function of that name and is NOT assumed to be one.
    const prev = tokens[k - 1];
    if (prev && prev.type === "punct" && (prev.value === "." || prev.value === "?.")) return true;
  }
  return false;
}

/** `RegExp.$1`, `RegExp.lastMatch`, … — the static match registers. */
function rangeHasRegExpStatics(tokens, from, to) {
  for (let k = from; k < to - 2 && k < tokens.length - 2; k++) {
    if (tokens[k].type === "ident" && tokens[k].value === "RegExp") {
      const dot = tokens[k + 1];
      const prop = tokens[k + 2];
      if (dot && dot.type === "punct" && dot.value === "." && prop) {
        if (prop.type === "punct" && prop.value === "$") return true;
        if (prop.type === "ident" && /^(lastMatch|lastParen|leftContext|rightContext|input)$/.test(prop.value))
          return true;
      }
    }
  }
  return false;
}

/** Identifier names referenced in a token range. */
function identsIn(tokens, from, to) {
  const out = new Set();
  for (let k = from; k < to && k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type !== "ident") continue;
    // Skip property positions: `x.evidence` — `evidence` is not a binding here.
    const prev = tokens[k - 1];
    if (prev && prev.type === "punct" && (prev.value === "." || prev.value === "?.")) continue;
    out.add(t.value);
  }
  return out;
}

/**
 * The token range of the FUNCTION BODY enclosing token `k`, or the whole file.
 * A `{` is a function body when the token before it is `)` (a parameter list) or
 * `=>`. Walk outward until one is found — the innermost such brace is the function
 * whose local bindings can taint the evidence expression.
 */
function enclosingFunctionBody(tokens, bmap, k) {
  for (const [o, c] of enclosingBraces(tokens, bmap, k)) {
    const prev = tokens[o - 1];
    if (prev && prev.type === "punct" && (prev.value === ")" || prev.value === "=>")) return [o + 1, c];
  }
  return [0, tokens.length];
}

/**
 * Collect identifiers bound to a match/exec/matchAll result within [from, to).
 * Runs to a fixpoint so a chain (`const m = s.match(RX); const g = m[1];`) is
 * followed. Handles `const`/`let`/`var` declarations, array and object
 * destructuring patterns, and bare re-assignment.
 */
function matchDerivedBindings(tokens, bmap, from, to) {
  const tainted = new Set();
  const DECL = new Set(["const", "let", "var"]);

  for (let pass = 0; pass < 4; pass++) {
    const before = tainted.size;
    for (let k = from; k < to && k < tokens.length; k++) {
      const t = tokens[k];

      // ── `const|let|var <pattern> = <init>` ────────────────────────────────
      if (t.type === "ident" && DECL.has(t.value)) {
        let j = k + 1;
        while (j < to) {
          const names = [];
          let eq = -1;
          const head = tokens[j];
          if (!head) break;
          if (head.type === "ident") {
            names.push(head.value);
            j++;
          } else if (head.type === "punct" && (head.value === "[" || head.value === "{")) {
            const close = bmap.open.get(j);
            const end = close !== undefined ? close : findMatching(tokens, j, head.value);
            for (let p = j + 1; p < end; p++) {
              const pt = tokens[p];
              if (pt.type !== "ident") continue;
              const nxt = tokens[p + 1];
              // `{ groups: g }` binds `g`, not `groups`.
              if (nxt && nxt.type === "punct" && nxt.value === ":") continue;
              names.push(pt.value);
            }
            j = end + 1;
          } else {
            break;
          }
          if (tokens[j] && tokens[j].type === "punct" && tokens[j].value === "=") {
            eq = j;
            const initEnd = declaratorEnd(tokens, bmap, eq + 1, to);
            if (initTaints(tokens, bmap, eq + 1, initEnd, tainted)) {
              for (const nm of names) tainted.add(nm);
            }
            j = initEnd;
          }
          if (tokens[j] && tokens[j].type === "punct" && tokens[j].value === ",") {
            j++;
            continue;
          }
          break;
        }
        continue;
      }

      // ── bare `<ident> = <expr>` (re-assignment) ───────────────────────────
      if (t.type === "ident") {
        const eq = tokens[k + 1];
        const prev = tokens[k - 1];
        const prevIsMember = prev && prev.type === "punct" && (prev.value === "." || prev.value === "?.");
        if (!prevIsMember && eq && eq.type === "punct" && eq.value === "=") {
          const initEnd = declaratorEnd(tokens, bmap, k + 2, to);
          if (initTaints(tokens, bmap, k + 2, initEnd, tainted)) tainted.add(t.value);
        }
      }

      // ── `for (const m of s.matchAll(RX))` ─────────────────────────────────
      if (t.type === "ident" && t.value === "of") {
        const nameTok = tokens[k - 1];
        const end = skipToNextTopLevelComma(tokens, bmap, k + 1, to);
        if (nameTok && nameTok.type === "ident" && initTaints(tokens, bmap, k + 1, end, tainted)) {
          tainted.add(nameTok.value);
        }
      }
    }
    if (tainted.size === before) break;
  }
  return tainted;
}

/** End of one declarator's initialiser: next top-level `,` or `;`. */
function declaratorEnd(tokens, bmap, from, limit) {
  let k = from;
  let depth = 0;
  while (k < limit && k < tokens.length) {
    const t = tokens[k];
    if (t.type === "punct") {
      if (t.value === "{" || t.value === "[" || t.value === "(" || t.value === "${") depth++;
      else if (t.value === "}" || t.value === "]" || t.value === ")" || t.value === "}$") {
        if (depth === 0) return k;
        depth--;
      } else if (depth === 0 && (t.value === "," || t.value === ";")) return k;
    }
    k++;
  }
  return Math.min(limit, tokens.length);
}

function findMatching(tokens, openIdx, openVal) {
  const closeVal = openVal === "[" ? "]" : openVal === "{" ? "}" : ")";
  let depth = 0;
  for (let k = openIdx; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type !== "punct") continue;
    if (t.value === openVal) depth++;
    else if (t.value === closeVal) {
      depth--;
      if (depth === 0) return k;
    }
  }
  return tokens.length - 1;
}

/** Is an initialiser expression match-derived (directly, or via an already-tainted id)? */
function initTaints(tokens, bmap, from, to, tainted) {
  if (rangeHasMatchCall(tokens, from, to)) return true;
  if (rangeHasRegExpStatics(tokens, from, to)) return true;
  for (const id of identsIn(tokens, from, to)) if (tainted.has(id)) return true;
  return false;
}

/**
 * THE CHECK.
 *
 * @param {string} src  JavaScript source text.
 * @returns {{
 *   parsed: boolean,
 *   error: string|null,
 *   examined: number,                 // object literals carrying severity:"block"
 *   withEvidence: number,             // …of which carry an `evidence` property
 *   findings: Array<{line:number, ruleId:string|null, evidence:string, kind:string, why:string}>,
 *   clean: Array<{line:number, ruleId:string|null, evidence:string}>
 * }}
 */
function scanSource(src) {
  const lex = tokenize(src);
  if (!lex.ok) {
    return { parsed: false, error: lex.error, examined: 0, withEvidence: 0, findings: [], clean: [] };
  }
  const tokens = lex.tokens;
  const bmap = braceMap(tokens);

  const findings = [];
  const clean = [];
  let examined = 0;
  let withEvidence = 0;

  for (let k = 0; k < tokens.length - 2; k++) {
    const key = tokens[k];
    if (key.type !== "ident" && key.type !== "string") continue;
    if (key.value !== "severity") continue;
    const colon = tokens[k + 1];
    const val = tokens[k + 2];
    if (!colon || colon.type !== "punct" || colon.value !== ":") continue;
    if (!val || val.type !== "string" || val.value !== "block") continue;

    const enclosing = enclosingBraces(tokens, bmap, k);
    if (!enclosing.length) continue;
    const [openIdx, closeIdx] = enclosing[0];
    examined++;

    const props = objectProperties(tokens, bmap, openIdx, closeIdx);
    const ruleProp = props.find((p) => p.key === "rule_id" && !p.shorthand);
    const ruleId = ruleProp ? renderRange(tokens, ruleProp.valueStart, ruleProp.valueEnd, 80) : null;
    const ev = props.find((p) => p.key === "evidence");
    if (!ev || ev.shorthand) continue;
    withEvidence++;

    const [fnFrom, fnTo] = enclosingFunctionBody(tokens, bmap, k);
    const tainted = matchDerivedBindings(tokens, bmap, fnFrom, fnTo);
    const expr = renderRange(tokens, ev.valueStart, ev.valueEnd);

    let kind = null;
    let why = null;
    if (rangeHasMatchCall(tokens, ev.valueStart, ev.valueEnd)) {
      kind = "direct-match-call";
      why = "the evidence expression calls .match()/.exec()/.matchAll() inline";
    } else if (rangeHasRegExpStatics(tokens, ev.valueStart, ev.valueEnd)) {
      kind = "regexp-static-register";
      why = "the evidence expression reads a RegExp static match register";
    } else {
      const hit = [...identsIn(tokens, ev.valueStart, ev.valueEnd)].find((id) => tainted.has(id));
      if (hit) {
        kind = "match-derived-binding";
        why = `the evidence expression reads \`${hit}\`, bound to a match()/exec() result in the same function`;
      }
    }

    if (kind) {
      findings.push({ line: key.line, ruleId, evidence: expr, kind, why });
    } else {
      clean.push({ line: key.line, ruleId, evidence: expr });
    }
  }

  return { parsed: true, error: null, examined, withEvidence, findings, clean };
}

/**
 * Is this path a detector-bearing hook source this check applies to?
 * SHAPE only — containment is the caller's job (`security.md` § Path Containment).
 * Scoped to `.claude/hooks/**.js`: that is where a `severity` is ORIGINATED. The
 * check is not run over `.claude/bin/**` or the test harness, where the same tokens
 * appear as data rather than as a detector's return.
 */
function isDetectorBearingSource(p) {
  const s = String(p || "").replace(/\\/g, "/");
  if (!/\.(c|m)?js$/.test(s)) return false;
  return /(^|\/)\.claude\/hooks\/[^?]*$/.test(s);
}

module.exports = {
  scanSource,
  isDetectorBearingSource,
  tokenize,
  // exported for the fixture battery's own controls
  braceMap,
  objectProperties,
  matchDerivedBindings,
};
