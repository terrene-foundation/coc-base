"use strict";
/**
 * audit-emit-ordering — decide whether a Python function ADVANCES A STATE SLOT BEFORE it
 * emits the signed audit row for that transition.
 *
 * This is the detector `eatp.md` § "Signed Audit Event Emits BEFORE State Advance" booked as
 * Phase 2. The rule named it `violation-patterns.js::detectStateAdvanceBeforeAuditEmit`; it
 * ships HERE instead, under a different name, for a reason recorded in the rule's own prose:
 * `violation-patterns.js` is a shared 5k-line surface and this predicate needs ~120 lines of
 * Python block-structure machinery that no other pattern in that file consumes. The NAME
 * deviates; the PREDICATE is the one the rule specified — "a state-slot write followed by
 * `<audit>.append(` in the SAME function".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY FUNCTION BOUNDARIES, AND NOT A LINE WINDOW
 *
 * The cheap version of this check is a line window: find `<audit>.append(`, look back N lines
 * for a state assignment. MEASURED against the rule's own DO/DO-NOT block plus five adjacent
 * shapes, a window gets the two poles right and gets two compliant shapes WRONG:
 *
 *   1. ADJACENT FUNCTIONS. A function ending on `self._phase = Phase.DONE` followed by a
 *      function opening on `self._audit_engine.append(event)` is two correct functions. Any
 *      window wide enough to span the intervening lines of a real transition reads it as one
 *      violation. Function boundaries are the only thing that separates them.
 *   2. DOCSTRINGS AND COMMENTS. The violating order written INSIDE a docstring — which is how
 *      a codebase documents the anti-pattern, and is literally how the rule itself states it —
 *      is not code. Blanking strings and comments before matching is what keeps the detector
 *      from firing on the documentation of the thing it detects.
 *
 * So this module walks Python block structure. Python has no braces; the boundary is
 * INDENTATION, and that is exactly what `def` gives us: a header at indent K owns every
 * following non-blank line at indent > K, until the first line at indent <= K. That is the
 * same algorithm `synthetic-load.js::analyzePython` already runs in production here for
 * `while`/`for` bodies. It is re-implemented rather than imported because that module does not
 * export it (`blankCode` and the walk are both module-private) and this lane may not edit it.
 * The duplication is named rather than hidden.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SEVERITY IS `halt-and-report`, AND THE SIGNAL IS WHAT CAPS IT
 *
 * The ORDERING half is structural: statement positions inside a parsed, indent-delimited
 * function body, over source whose strings and comments have been blanked. A surface rewrite
 * cannot reorder two statements without actually reordering them.
 *
 * The ANCHOR half is LEXICAL, and it is the binding constraint. Whether a receiver is an AUDIT
 * SINK is decided by its NAME containing `audit`; whether an assignment is a STATE SLOT is
 * decided by the `self.<attr> = <Enum>.<MEMBER>` SHAPE plus a state-ish attribute name. Nothing
 * here knows the type of `self._phase` or what `self.ledger.append` writes to. Because a
 * lexical test decides whether the finding EXISTS AT ALL, `hook-output-discipline.md` MUST-2
 * bars `severity: "block"`, and `halt-and-report` is the ceiling. The exception in MUST-2 is
 * not invoked and does not apply — this is not a disclosure-isolation boundary.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * KNOWN RESIDUALS, named so a silent result is not read as "no violation anywhere"
 *
 *   - FALSE NEGATIVE: an audit sink whose name does not contain `audit` (`self.ledger.append`,
 *     `self._chain.append`). The rule's own DO/DO-NOT block names the receiver `_audit_engine`
 *     / `audit_log`, and widening to every `.append(` in the file would fire on every list
 *     append in the codebase — a non-discriminating instrument, which is worse than this miss.
 *   - FALSE NEGATIVE: a state advance written as `setattr(self, "_phase", ...)`, through a
 *     property setter, or as a bare `phase = X` module global. Only the `self.<attr> =` form
 *     is recognised.
 *   - FALSE NEGATIVE: the emit and the advance in DIFFERENT functions (advance in the caller,
 *     emit in a callee). That is a real instance of the failure the rule describes and this
 *     detector structurally cannot see it — the rule's own Detection-mechanism scopes the
 *     check to "the SAME function", and cross-function flow needs a call graph.
 *   - FALSE POSITIVE: a function that advances the slot, emits an UNRELATED audit row, and
 *     emits the transition's own row earlier through a helper. The finding is `halt-and-report`
 *     precisely so a human reads it rather than a hook refusing the write.
 *   - NOT COVERED: any language but Python, and any write that does not go through
 *     Write/Edit/NotebookEdit (a heredoc from Bash writes the same file unseen).
 */

/** Bound: files larger than this are not scanned (fail-open, never a hang). */
const MAX_BYTES = 512 * 1024;

/**
 * Any dotted receiver calling `.append(`. The receiver NAME is captured and tested separately
 * (`AUDIT_NAME` below) rather than folded into this pattern.
 *
 * That split is not style. The folded form — `[A-Za-z_][\w.]*audit[\w.]*` — silently fails on a
 * receiver whose name BEGINS with `audit`, because the mandatory leading character class
 * consumes the `a` before the literal can match. `self._audit_engine.append(` matched;
 * `audit_log.append(` did not, and that is the commonest spelling of the thing this detector
 * exists to find. The fixture `pair7-violation-both-inside-function.py` is what surfaced it.
 */
const APPEND_CALL = /(^|[^\w.])([A-Za-z_][\w.]*)\.append\s*\(/g;

/** A receiver is an audit sink if its name mentions `audit`, in any case. */
const AUDIT_NAME = /audit/i;

/**
 * Whether a line calls `.append(` on a receiver whose name marks it an audit sink.
 *
 * @param {string} line source line, already comment/string-blanked
 * @returns {boolean}
 */
function hasAuditAppend(line) {
  APPEND_CALL.lastIndex = 0;
  let m;
  while ((m = APPEND_CALL.exec(line)) !== null) {
    if (AUDIT_NAME.test(m[2])) return true;
  }
  return false;
}

/**
 * A state-slot advance. TWO recognised shapes, deliberately narrow:
 *   (a) `self.<attr> = <Enum>.<MEMBER>`  — an enum member assigned to any self attribute.
 *       This is the rule's own verbatim shape (`self._phase = Phase.ACTING`).
 *   (b) `self.<state-ish attr> = <expr>` — where the attribute name is one of the state
 *       names, so `self._state = next_state` is caught without `self._pending = payload`
 *       (a plain attribute write) being read as a transition.
 */
const ADVANCE_ENUM = /^\s*self\.([_A-Za-z]\w*)\s*=\s*[A-Z]\w*\.[A-Z][A-Z0-9_]*\s*(?:#.*)?$/;
const ADVANCE_NAMED = /^\s*self\.(_?(?:phase|state|status|stage|step))\s*=\s*[^=]/i;

const DEF_HEADER = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;

/**
 * Blank Python comments and string literals IN PLACE (preserving line/column geometry) so the
 * matchers above never see the anti-pattern as documented rather than as written. Newlines are
 * preserved so line numbers in findings stay true to the source.
 *
 * @param {string} src
 * @returns {string} same length, same newlines, comment/string bytes replaced by spaces
 */
function blankPythonNonCode(src) {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === "#") {
      while (i < n && src[i] !== "\n") {
        out[i] = " ";
        i++;
      }
      continue;
    }
    const tri = src.slice(i, i + 3);
    if (tri === '"""' || tri === "'''") {
      out[i] = out[i + 1] = out[i + 2] = " ";
      i += 3;
      while (i < n && src.slice(i, i + 3) !== tri) {
        if (src[i] !== "\n") out[i] = " ";
        i++;
      }
      for (let k = 0; k < 3 && i < n; k++, i++) out[i] = " ";
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      out[i] = " ";
      i++;
      while (i < n && src[i] !== q && src[i] !== "\n") {
        if (src[i] === "\\") {
          out[i] = " ";
          i++;
          if (i < n && src[i] !== "\n") out[i] = " ";
          i++;
          continue;
        }
        out[i] = " ";
        i++;
      }
      if (i < n && src[i] === q) out[i] = " ";
      i++;
      continue;
    }
    i++;
  }
  return out.join("");
}

/**
 * Scan Python source for advance-before-emit orderings.
 *
 * Statements are attributed to the INNERMOST enclosing `def`, so a nested helper's body is
 * that helper's, not its parent's — which is what keeps a `_advance_to_failed_no_audit` nested
 * inside its parent from inheriting the parent's audit emit.
 *
 * @param {string} src Python source text
 * @returns {{findings: Array<{fn:string, advanceLine:number, emitLine:number, advance:string, emit:string}>, scanned: boolean, reason: string|null}}
 */
function scanAuditEmitOrdering(src) {
  if (typeof src !== "string" || src.length === 0) {
    return { findings: [], scanned: false, reason: "empty-or-non-string source" };
  }
  if (src.length > MAX_BYTES) {
    return { findings: [], scanned: false, reason: `source exceeds ${MAX_BYTES} bytes` };
  }
  const raw = src.replace(/\r/g, "");
  const code = blankPythonNonCode(raw);
  const codeLines = code.split("\n");
  const rawLines = raw.split("\n");

  const findings = [];
  /** @type {Array<{name:string, indent:number, adv:number, emit:number}>} */
  const stack = [];

  const settle = (frame) => {
    if (frame.adv >= 0 && frame.emit >= 0 && frame.adv < frame.emit) {
      findings.push({
        fn: frame.name,
        advanceLine: frame.adv + 1,
        emitLine: frame.emit + 1,
        advance: rawLines[frame.adv].trim(),
        emit: rawLines[frame.emit].trim(),
      });
    }
  };

  for (let i = 0; i < codeLines.length; i++) {
    const line = codeLines[i];
    if (!line.trim()) continue;
    const indent = /^(\s*)/.exec(line)[1].length;

    // Close every frame this line has dedented out of. A `def` at indent K owns lines at
    // indent > K only; the first line at indent <= K ends it.
    while (stack.length > 0 && indent <= stack[stack.length - 1].indent) {
      settle(stack.pop());
    }

    const def = DEF_HEADER.exec(line);
    if (def) {
      stack.push({ name: def[1], indent, adv: -1, emit: -1 });
      continue;
    }
    const frame = stack[stack.length - 1];
    if (!frame) continue;

    // FIRST occurrence of each anchor is the one that decides the ordering: the transition's
    // own emit is the first audit write after its advance, and a later compliant emit cannot
    // retroactively make the earlier advance safe.
    if (frame.emit < 0 && hasAuditAppend(line)) frame.emit = i;
    if (frame.adv < 0 && (ADVANCE_ENUM.test(line) || ADVANCE_NAMED.test(line))) frame.adv = i;
  }
  while (stack.length > 0) settle(stack.pop());

  return { findings, scanned: true, reason: null };
}

/**
 * Whether a repo-relative path is in the rule's own `paths:` scope — the EATP/trust Python
 * surface. Scoping here rather than in the matcher keeps the hook from paying a scan on every
 * Python file in every repo that installs it.
 *
 * @param {string} rel
 * @returns {boolean}
 */
function isEatpPythonPath(rel) {
  if (!rel || typeof rel !== "string") return false;
  const p = rel.replace(/\\/g, "/");
  if (!/\.py$/i.test(p)) return false;
  return /(^|\/)trust(\/|$)/.test(p) || /(^|\/)eatp(\/|$)/.test(p);
}

/**
 * Render the finding set as the hook's `what_happened` line.
 *
 * @param {string} rel
 * @param {Array<object>} findings
 * @returns {string}
 */
function formatFindings(rel, findings) {
  const head = `${findings.length} state-advance-before-audit-emit ordering(s) in ${rel}`;
  const rows = findings
    .slice(0, 5)
    .map(
      (f) =>
        `  ${rel}:${f.advanceLine} advances the state slot (\`${f.advance}\`) BEFORE ` +
        `${rel}:${f.emitLine} emits the audit row (\`${f.emit}\`) in \`def ${f.fn}\``,
    );
  const more = findings.length > 5 ? [`  … and ${findings.length - 5} more`] : [];
  return [head, ...rows, ...more].join("\n");
}

module.exports = {
  MAX_BYTES,
  APPEND_CALL,
  AUDIT_NAME,
  hasAuditAppend,
  ADVANCE_ENUM,
  ADVANCE_NAMED,
  blankPythonNonCode,
  scanAuditEmitOrdering,
  isEatpPythonPath,
  formatFindings,
};
