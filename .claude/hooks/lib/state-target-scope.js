"use strict";
/*
 * state-target-scope.js — PATH-IDENTITY oracle for the state-file write guard
 * (loom#1703, residual (k)).
 *
 * THE PROBLEM THIS EXISTS FOR. `STATE_PATH_RX` (guard-path-scope.js) is an
 * UNANCHORED path matcher: it answers "does this text contain the SPELLING of a
 * protected state path". It has no notion of WHICH repo root a state path
 * belongs to, so a write to a throwaway sandbox — `$(mktemp -d)/.claude/
 * learning/coordination-log.jsonl` — is byte-identically indistinguishable from
 * a write to the live file. That over-block is residual (k), recorded in
 * `rules/state-file-write-guard.md` § "Known residuals" since #1363, re-measured
 * and kept open by #1426, and measured as having blocked a security reviewer's
 * symlink probe outright — turning an EXECUTED finding into a static one.
 *
 * WHAT THIS MODULE ANSWERS. Given a path TOKEN that already matched the
 * spelling, decide whether it actually NAMES protected state:
 *
 *   "in-tree"     the token RESOLVES to a real protected state root. BLOCK, and
 *                 now genuinely "structurally unambiguous" — the canonical form
 *                 was computed, not guessed.
 *   "out-of-tree" the token RESOLVES, and lands somewhere that is not any repo's
 *                 (nor the user's) `.claude`/`.git` state. Not this guard's file.
 *   "unresolved"  the token could NOT be resolved. FAIL CLOSED — the caller
 *                 still blocks, but MUST say the target did not resolve rather
 *                 than claim a structural match (`hook-output-discipline.md`
 *                 MUST-2; the honest-message half of #1703).
 *
 * RESOLUTION IS SYMMETRIC, per `security.md` § Path Containment: candidate AND
 * boundary root both go through `fs.realpathSync`, and the comparison is made on
 * the CANONICAL forms. Comparing a realpath'd candidate against a raw root is
 * the classic lexical bypass and is deliberately not done here. Because the
 * owner root is derived from the CANONICAL path, a symlink planted at a
 * lexically-out-of-tree location whose target escapes INTO the live
 * `.claude/learning/` resolves back inside the boundary and BLOCKS — that attack
 * is the one the earlier reviewer could not even stage.
 *
 * SCOPED HONESTLY (`security.md` § Path Containment, same wording): resolving
 * closes the lexical-bypass class. It does NOT defeat the check-to-use TOCTOU —
 * a symlink swapped between this classification and the shell's open(2). That
 * needs enforcement at the sink and is out of reach of a PreToolUse hook, which
 * only ever sees a command STRING. This module narrows an over-block; it is not
 * claimed as a complete containment control.
 *
 * ── ON `$VAR` AND `hook-output-discipline.md` MUST-3 ──
 *
 * MUST-3 forbids the hook from EXPANDING SHELL SYNTAX — running a shell,
 * evaluating substitutions, globbing. This module does none of that. It performs
 * one narrow ENVIRONMENT LOOKUP (`process.env`), under three conditions that
 * make it fail-closed in every direction that matters:
 *
 *   1. A variable the COMMAND ITSELF assigns (`T=$(mktemp -d)`, `export T=…`,
 *      `read T`) is refused outright → "unresolved". This is the case an
 *      attacker controls, and it never resolves.
 *   2. A variable absent from the hook's env, empty, or holding a RELATIVE path
 *      is refused → "unresolved".
 *   3. Command substitution, backticks, globs and `~` are refused → "unresolved".
 *
 * So the lookup can only ever turn a would-be BLOCK into a non-block when the
 * hook's own environment proves the target lands outside every protected root.
 * If it lands INSIDE, the verdict is "in-tree" and the block is TIGHTER than the
 * lexical matcher's. The residual assumption is that the hook process and the
 * Bash tool call share an environment — both are spawned by the same CLI
 * process — and condition 1 covers the one case where the command changes it.
 *
 * This is deliberately weaker than "never look at anything": refusing the lookup
 * entirely leaves the MEASURED (k) instance (`> "$TMPDIR/.claude/learning/
 * coordination-log.jsonl"` inside a `mktemp -d`) blocked, which is the exact
 * false positive #1703 exists to remove.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

/** Verdicts. Exported so callers compare against a symbol, not a string literal. */
const SCOPE = Object.freeze({
  IN_TREE: "in-tree",
  OUT_OF_TREE: "out-of-tree",
  UNRESOLVED: "unresolved",
});

/**
 * Path components that OWN protected state. A token's "owner root" is the
 * directory immediately above the LAST of these components in its canonical
 * form — for `<X>/.claude/learning/posture.json` that is `<X>`, and for
 * `<X>/.git/config` it is likewise `<X>`.
 *
 * Case-insensitive, matching `_buildSurfaceRx`'s `i` flag: on APFS
 * `.CLAUDE/VERSION` and `.claude/VERSION` are the same file, and a
 * case-SENSITIVE owner derivation would hand an attacker the one-character
 * bypass that flag exists to close (loom#1399).
 */
const OWNER_COMPONENTS = Object.freeze([".claude", ".git"]);

/** Characters that terminate a shell path token. */
const PATH_TOKEN_BREAK_RX = /[\s|;&<>()'"`,=]/;

/*
 * ── WHY THE BOUNDS BELOW ARE NOT DEFENSIVE PADDING (loom#1704) ──
 *
 * This module runs inside `validate-bash-command.js`, whose Rule-7 timeout
 * CANNOT protect it. Measured, two independent reasons: `clearTimeout` runs
 * BEFORE `validateBashCommand()` is called, and `setTimeout` cannot interrupt
 * synchronous JavaScript in any case — the callback only runs once the stack
 * unwinds, i.e. after the work already finished. The timer therefore covers
 * exactly one thing: stdin never reaching `end`.
 *
 * That inverts the usual severity ordering for everything in this file:
 *
 *   a THROW  → the catch at validate-bash-command.js:138-142 emits
 *              {continue:true}. Fails OPEN for ONE command. Bad, bounded,
 *              and visible.
 *   a HANG   → no timer, no fallback, no advisory. Wedges the session
 *              INDEFINITELY, and presents as the agent thinking rather than as
 *              a guard defect.
 *
 * So a hang is strictly worse than a throw here, and every loop below is
 * bounded by a counter whose exhaustion returns the FAIL-CLOSED value
 * ("unresolved" / "truncated" / unmasked), never an optimistic one. The bounds
 * are sized far above any real command; hitting one means the input is
 * adversarial, and refusing to resolve it is the correct answer anyway.
 */

/** Max leftward steps when widening one token. Longest real path ≪ this. */
const WIDEN_STEP_BUDGET = 8192;
/** Max path components canonicalized. Each costs a realpath(2) syscall. */
const MAX_PATH_COMPONENTS = 128;
/** Max protected-path matches examined in one text. */
const MAX_TOKEN_MATCHES = 256;

/**
 * Widen LEFT from `s` to the start of the shell word, absorbing any expansion
 * the word was built from.
 *
 * A naive break-character walk TRUNCATES rather than stopping: for
 * `> "$(pwd)/.claude/learning/posture.json"` it halts at the `)` and hands back
 * `/.claude/learning/posture.json` — a DIFFERENT path (filesystem root) that
 * resolves cleanly to out-of-tree. That is a fail-OPEN produced by the widener
 * itself, and it was MEASURED: the command classified `out-of-tree` and the
 * detector returned null for a live write to posture.json.
 *
 * So a `)` or a closing backtick to the left is absorbed together with its
 * opener, keeping the `$(` / backtick INSIDE the token — which is exactly what
 * makes `classify` refuse it as "unresolved" (fail closed). If the opener cannot
 * be located the walk stops and reports truncation, which the caller turns into
 * the same refusal.
 *
 * @returns {{start: number, truncated: boolean}}
 */
function widenLeft(text, from) {
  let s = from;
  // TERMINATION ARGUMENT (loom#1704). Every iteration either RETURNS or strictly
  // DECREASES `s`: the default branch does `s--`; the `)` branch sets `s = j-1`
  // where `j` is the index of the matching `(`, which is < s-1, and otherwise
  // returns; the backtick branch sets `s = j` where `j = lastIndexOf("`", s-2)`,
  // so j ≤ s-2 < s, and otherwise returns. `s` is bounded below by 0, which
  // returns. So the loop terminates on every input. The counter is a BACKSTOP
  // against a future edit breaking that argument, and it fails CLOSED.
  let steps = WIDEN_STEP_BUDGET;
  for (;;) {
    if (--steps <= 0) return { start: s, truncated: true };
    if (s === 0) return { start: s, truncated: false };
    const prev = text[s - 1];
    if (prev === ")") {
      let depth = 0;
      let j = s - 1;
      for (; j >= 0; j--) {
        if (text[j] === ")") depth++;
        else if (text[j] === "(") {
          depth--;
          if (depth === 0) break;
        }
      }
      if (j >= 1 && text[j - 1] === "$") {
        s = j - 1; // absorb the whole `$( … )` span
        continue;
      }
      return { start: s, truncated: true }; // unbalanced / not a substitution
    }
    if (prev === "`") {
      const j = text.lastIndexOf("`", s - 2);
      if (j >= 0) {
        s = j;
        continue;
      }
      return { start: s, truncated: true };
    }
    if (PATH_TOKEN_BREAK_RX.test(prev)) return { start: s, truncated: false };
    s--;
  }
}

/**
 * Does the COMMAND assign this variable? Deliberately broad — every extra match
 * yields "unresolved", i.e. a retained block. Covers `V=…`, `export V=…`,
 * `declare/local/typeset V=…`, `read V`, and `env V=…`.
 */
function isAssignedInCommand(command, name) {
  if (!command) return false;
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(`(?:^|[\\s;&|(])(?:export\\s+|declare\\s+|local\\s+|typeset\\s+|env\\s+)?${n}\\s*=`).test(
      command,
    ) || new RegExp(`(?:^|[\\s;&|(])read\\b[^\\n;|&]*\\b${n}\\b`).test(command)
  );
}

/**
 * Strip ONE matched pair of surrounding quotes. A quoted redirect target is a
 * real target — the shell removes the quotes before open(2) — so quoting must
 * not change the verdict. Interior quotes (bash word CONCATENATION, e.g.
 * `.claude/"learning"/posture.json`) are left in place and will fail resolution,
 * which is the fail-closed direction.
 */
function stripOuterQuotes(token) {
  let t = token;
  while (
    t.length >= 2 &&
    ((t[0] === '"' && t[t.length - 1] === '"') ||
      (t[0] === "'" && t[t.length - 1] === "'"))
  ) {
    t = t.slice(1, -1);
  }
  return t;
}

/**
 * Substitute `$VAR` / `${VAR}` from `env` under the three conditions in the
 * module header. Returns the substituted string, or `null` when any reference
 * is refused (→ "unresolved").
 */
function substituteEnvRefs(token, env, command) {
  if (!/\$/.test(token)) return token;
  let refused = false;
  const out = token.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_m, braced, bare) => {
      const name = braced || bare;
      if (isAssignedInCommand(command, name)) {
        refused = true;
        return "";
      }
      const v = env ? env[name] : undefined;
      if (typeof v !== "string" || v.length === 0 || !path.isAbsolute(v)) {
        refused = true;
        return "";
      }
      return v;
    },
  );
  // A surviving `$` is a form this function does not model (`$1`, `$@`, `$'…'`).
  if (refused || /\$/.test(out)) return null;
  return out;
}

/**
 * Canonicalize an absolute path that MAY NOT EXIST YET — the normal case for a
 * redirect target. `realpathSync` the deepest EXISTING ancestor, then re-join
 * the remainder. This is what makes the symlink-escape case resolve: the
 * sandbox's `.claude` may be a symlink into the live tree, and the ancestor walk
 * dereferences it.
 *
 * Returns null when nothing on the path resolves at all (→ "unresolved").
 */
function canonicalizeAllowingMissing(abs) {
  const parts = abs.split(path.sep);
  // Each iteration costs a realpath(2). A path with thousands of components
  // would issue thousands of syscalls inside a hook that nothing can time out
  // (loom#1704), so refuse outright rather than walk it. Returning null means
  // "unresolved", which the caller turns into a BLOCK — fail closed.
  if (parts.length > MAX_PATH_COMPONENTS) return null;
  for (let i = parts.length; i > 0; i--) {
    const prefix = parts.slice(0, i).join(path.sep) || path.sep;
    let real;
    try {
      real = fs.realpathSync(prefix);
    } catch {
      continue; // this prefix does not exist (or is unreadable) — try shorter
    }
    const rest = parts.slice(i).filter((s) => s.length > 0);
    return rest.length ? path.resolve(real, ...rest) : real;
  }
  return null;
}

/** The directory above the LAST `.claude` / `.git` component, or null. */
function ownerRootOf(canonical) {
  const parts = canonical.split(path.sep);
  let last = -1;
  for (let i = 0; i < parts.length; i++) {
    if (OWNER_COMPONENTS.includes(parts[i].toLowerCase())) last = i;
  }
  if (last <= 0) return null;
  return parts.slice(0, last).join(path.sep) || path.sep;
}

/** Is `child` equal to, or nested under, `parent`? Both must be canonical. */
function isAtOrUnder(child, parent) {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/**
 * createStateTargetScope — build the oracle for ONE command evaluation.
 *
 * @param {object} input
 * @param {string} input.cwd            Session cwd; relative tokens resolve against it. Absent ⇒ relative tokens are "unresolved".
 * @param {string[]} [input.boundaryRoots]  Roots whose subtree is ALWAYS protected (this repo + its main checkout). Canonicalized here.
 * @param {string} input.command        The full command — read ONLY to refuse self-assigned variables.
 * @param {object} [input.env]          Defaults to process.env.
 * @param {string} [input.homedir]      Defaults to os.homedir(); the user-global `.claude` tree.
 * @returns {{classify: (token: string) => string}}
 */
function createStateTargetScope(input) {
  const cfg = input || {};
  const cwd = typeof cfg.cwd === "string" && cfg.cwd.length ? cfg.cwd : null;
  const env = cfg.env || process.env;
  const command = typeof cfg.command === "string" ? cfg.command : "";

  const canonRoots = [];
  for (const r of cfg.boundaryRoots || []) {
    if (typeof r !== "string" || !r.length) continue;
    const c = canonicalizeAllowingMissing(path.resolve(r));
    if (c) canonRoots.push(c);
  }
  let canonHome = null;
  try {
    const h = typeof cfg.homedir === "string" ? cfg.homedir : os.homedir();
    if (h) canonHome = canonicalizeAllowingMissing(h);
  } catch {
    canonHome = null;
  }

  // Memoized: Layers 1-4 re-test overlapping text, so the same token is
  // classified many times per command and each miss costs filesystem syscalls.
  const memo = new Map();

  function classifyUncached(rawToken) {
    if (typeof rawToken !== "string" || rawToken.length === 0) {
      return SCOPE.UNRESOLVED;
    }
    let tok = stripOuterQuotes(rawToken);
    if (!tok) return SCOPE.UNRESOLVED;
    // Command substitution / backtick — the value is produced by RUNNING
    // something. Never resolved here (MUST-3).
    if (/`|\$\(/.test(tok)) return SCOPE.UNRESOLVED;
    // Glob metacharacters — bash expands these at runtime; residual (f).
    if (/[*?[\]]/.test(tok)) return SCOPE.UNRESOLVED;
    // `~` is shell tilde expansion, not a path component.
    if (tok.startsWith("~")) return SCOPE.UNRESOLVED;

    const substituted = substituteEnvRefs(tok, env, command);
    if (substituted === null) return SCOPE.UNRESOLVED;
    tok = substituted;

    let abs;
    if (path.isAbsolute(tok)) {
      abs = tok;
    } else if (cwd) {
      abs = path.resolve(cwd, tok);
    } else {
      return SCOPE.UNRESOLVED;
    }

    const canonical = canonicalizeAllowingMissing(abs);
    if (!canonical) return SCOPE.UNRESOLVED;

    const owner = ownerRootOf(canonical);
    // No `.claude`/`.git` component in the CANONICAL form. The spelling matched
    // but the resolved path does not carry an owner component (e.g. a symlink
    // whose real name differs). Cannot attribute it ⇒ fail closed.
    if (!owner) return SCOPE.UNRESOLVED;

    // (1) Inside a declared boundary root — this repo, or its main checkout.
    for (const root of canonRoots) {
      if (isAtOrUnder(owner, root)) return SCOPE.IN_TREE;
    }
    // (2) Some OTHER real repository's state. Keeping this IN_TREE preserves the
    //     pre-#1703 protection of a sibling repo's `.claude`/`.git` — narrowing
    //     to "this repo only" would have been a cross-repo weakening the brief
    //     never asked for (`repo-scope-discipline.md` fences the intent; this
    //     fences the file).
    try {
      if (fs.existsSync(path.join(owner, ".git"))) return SCOPE.IN_TREE;
    } catch {
      return SCOPE.UNRESOLVED;
    }
    // (3) The user-global `~/.claude` tree (settings.json et al).
    if (canonHome && owner === canonHome) return SCOPE.IN_TREE;

    // Resolved, and owned by nothing this guard protects: a throwaway sandbox.
    return SCOPE.OUT_OF_TREE;
  }

  return {
    classify(rawToken) {
      const key = String(rawToken);
      if (memo.has(key)) return memo.get(key);
      let v;
      try {
        v = classifyUncached(rawToken);
      } catch {
        v = SCOPE.UNRESOLVED; // any resolver error fails CLOSED
      }
      memo.set(key, v);
      return v;
    },
  };
}

/**
 * protectedPathTokens — every path TOKEN in `text` that contains a `pathRx`
 * match, widened from the match to its enclosing shell word.
 *
 * The matcher finds the protected SUFFIX (`.claude/learning/posture.json`); the
 * decision needs the whole token, because the PREFIX is what distinguishes a
 * sandbox from the live tree.
 */
function protectedPathTokens(text, pathRx) {
  if (!text || !pathRx) return [];
  const rx = new RegExp(
    pathRx.source,
    pathRx.flags.includes("g") ? pathRx.flags : pathRx.flags + "g",
  );
  const out = [];
  const seen = new Set();
  let m;
  // TERMINATION (loom#1704): `rx` is `g`-flagged, so `exec` advances `lastIndex`
  // past each non-empty match; the zero-length branch advances it by hand. Both
  // are strictly monotonic in `lastIndex`, which is bounded by `text.length`.
  // The counter backstops a future edit and fails CLOSED — on exhaustion the
  // caller receives an unresolvable token and BLOCKS rather than clearing.
  let budget = MAX_TOKEN_MATCHES;
  while ((m = rx.exec(text)) !== null) {
    if (--budget <= 0) {
      out.push("$");
      break;
    }
    if (m[0].length === 0) {
      rx.lastIndex++;
      continue;
    }
    const { start: s, truncated } = widenLeft(text, m.index);
    let e = m.index + m[0].length;
    while (e < text.length && !PATH_TOKEN_BREAK_RX.test(text[e])) e++;
    // A truncated widen means the real prefix could not be recovered. Emitting
    // the visible remainder would hand `classify` a DIFFERENT path than the one
    // the shell will open, so emit an explicitly-unresolvable token instead.
    const tok = truncated ? "$" + text.slice(s, e) : text.slice(s, e);
    if (!seen.has(tok)) {
      seen.add(tok);
      out.push(tok);
    }
  }
  return out;
}

module.exports = {
  SCOPE,
  createStateTargetScope,
  protectedPathTokens,
  // Exported for targeted regression tests.
  canonicalizeAllowingMissing,
  ownerRootOf,
  stripOuterQuotes,
  isAssignedInCommand,
  substituteEnvRefs,
};
