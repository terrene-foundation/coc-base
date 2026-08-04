/**
 * git-command-parse.js — the ONE parser that answers "does this shell command
 * invoke `git <subcommand>`, and against WHICH working tree?"
 *
 * WHY THIS MODULE EXISTS (loom#1549 F3). Two hooks needed that answer and each
 * grew its own lineage:
 *
 *   validate-bash-command.js  — a segment-aware tokenizer handling command
 *     wrappers, `-C` retarget, `--work-tree`, and sequential-last-wins.
 *   fold-amendment-paired-with-helper.js — `/\bgit\b/` and `/\bcommit(?![\w-])/`
 *     tested against the WHOLE command string, with no `-C` awareness at all.
 *
 * The second fired on `git log --grep=commit`, on `commit` in a trailing shell
 * comment, and on `commit` echoed in an earlier segment; and when a command
 * said `git -C <other-repo> commit`, it diffed the SESSION repo instead — so it
 * could both halt on a non-commit and miss the pairing violation it exists to
 * catch. kailash-rs, reviewing loom's Gate-2 sync, held seven regression locks
 * for exactly these cases and rejected the sync because loom's hook did not
 * carry them.
 *
 * The durable fix is not to copy the good parser into the second hook — that
 * produces two lineages that drift, which is the `security.md` § Multi-Site
 * Kwarg Plumbing failure mode and the substance of #1549. It is to have ONE
 * parser both hooks consult. Adding a git-invocation dimension (a new wrapper,
 * a new global option) is then one edit here, not N across the corpus — the
 * same rationale as `tool-classes.js::isMutationTool` for tool names and
 * `guard-path-scope.js` for protected paths.
 *
 * Style: CommonJS, matching the rest of .claude/hooks/lib/. Pure functions;
 * NEVER throws — malformed input returns null/[] so callers can use these as
 * predicates without try/catch boilerplate.
 */

"use strict";

const path = require("path");
const { splitShellSegments } = require(
  path.join(__dirname, "violation-patterns.js"),
);

// Command-wrappers that may precede a `git` invocation. Each may carry its
// own flags AND a bare flag-operand (e.g. `sudo -u root`, `nice -n 10`); the
// scan below skips a bare operand ONLY inside an established wrapper context.
const GIT_WRAPPERS = new Set([
  "sudo",
  "doas",
  "env",
  "command",
  "nice",
  "nohup",
  "time",
  "timeout",
  "ionice",
  "setsid",
  "stdbuf",
  "chrt",
  "taskset",
]);

// `git`, `/usr/bin/git`, `./git`, `\git` — a path-qualified, bare, or
// backslash-escaped git token. The optional leading `\` closes the
// MED-R3-1 alias-bypass form (`\git clean` runs the git binary at bash
// runtime; the backslash only skips alias/function lookup). The `$IFS`
// form (`git$IFS clean`) is NOT closable here — it requires shell
// expansion the hook MUST NOT perform (hook-output-discipline.md Rule 3 /
// security.md § no-eval) — and stays an accepted residual backed by the
// sync-tier-aware pre-write snapshot (the surface-agnostic forever-layer).
const isGitToken = (t) => /^\\?(?:[^\s]*\/)?git$/.test(t);

// loom#1549 F3 lock 6 — strip ONE matched pair of surrounding quotes from an
// option VALUE. The tokenizer splits the RAW command string, so a quoted path
// arrives with its quote bytes still attached: `-C "/tmp/x"` yielded the dir
// `"/tmp/x"` (quotes included), the porcelain spawn then resolved nothing, and
// gitWorkingTreeStatus's fail-OPEN contract degraded `severity: "block"` to a
// non-blocking advisory. Quoting a path is normal, recommended shell style —
// so the fence was strongest on the form an agent is LEAST likely to write.
// The shell consumes these quotes before git ever sees them; modelling that is
// what makes the hook read the same directory git will act on.
const dequote = (v) =>
  typeof v === "string" && v.length >= 2 && /^(["']).*\1$/s.test(v)
    ? v.slice(1, -1)
    : v;

/**
 * Blank out shell comments, honouring quoting. POSIX rule: `#` opens a comment
 * ONLY at the start of a word (start-of-string or after whitespace), and never
 * inside a quoted span. So `git log # commit later` is a `log`, while
 * `git commit -m "fix #12"` keeps its `#`.
 *
 * Load-bearing for lock 2 AND lock 3: without it, a `#`-commented tail is still
 * split on its `&&`/`;` bytes, and the fragment after the separator parses as a
 * live git segment. Blanking (rather than truncating) preserves offsets for any
 * caller that correlates back to the original string.
 */
function stripShellComments(command) {
  const src = typeof command === "string" ? command : "";
  const out = src.split("");
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\" && quote !== "'") {
      i++; // escaped char — consume both
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(src[i - 1]))) {
      while (i < src.length && src[i] !== "\n") {
        out[i] = " ";
        i++;
      }
    }
  }
  return out.join("");
}

/**
 * Parse a shell segment as a git invocation, tolerant of command-prefixes
 * (sudo/doas/env/command/nice/… including their `-flag operand` forms, plus
 * `VAR=val` assignments and a path-qualified `git`) AND git global options
 * (`-C <dir>`, `-c <k=v>`, `--git-dir[=]`, `--work-tree[=]`, `-p`, `--bare`,
 * …) that sit BEFORE the subcommand. Returns { sub (lowercased), dir (the
 * effective work-tree for the structural check — `--work-tree` wins over
 * `-C`, else null=cwd), args (post-subcommand remainder) } or null when the
 * segment is not a git invocation.
 *
 * HIGH-1 (R1): the prior `^git\s+<sub>` anchors were bypassed by
 * `git -C <dir> <sub>` — the cross-tree form the #401 incident used.
 * HIGH-R2-1 (R2): the prefix-stripper regex was bypassed by `sudo -u root
 * git …` (the `-u` operand is not a dash-flag), `command git …`, and
 * `/usr/bin/git …`. This tokenize-and-skip scan closes that class.
 * MED-R2-1 (R2): `--work-tree=<dir>` attached form is now captured so the
 * porcelain check inspects the SAME tree the destructive op mutates.
 */
/**
 * Split a segment into words the way the shell does: whitespace separates,
 * quotes group and are CONSUMED, and a backslash escapes the next character.
 *
 * loom#1549 F3 lock 6, second half. A plain `split(/\s+/)` breaks apart any
 * quoted value containing a space, so `git -C "/a b" reset --hard` tokenized to
 * [`-C`, `"/a`, `b"`, `reset`] — `-C` captured `"/a`, its `i += 2` skipped past
 * `b"`, and the SUBCOMMAND parsed as `b"`. The invocation then matched no
 * fenced verb at all, so the destructive-op guard never fired. Quoting is the
 * one thing a path with a space REQUIRES, which put the most-quoted paths
 * outside the fence entirely.
 *
 * Tokenizing quote-aware subsumes the value-level `dequote` for separated
 * forms (`-C "/x"`); `dequote` stays for the ATTACHED form (`--work-tree="/x"`),
 * where the quotes sit inside a single token after the `=`.
 *
 * Command substitution (`$(…)`, backticks) is deliberately NOT expanded — a
 * hook must not evaluate shell (hook-output-discipline.md Rule 3 / security.md
 * § no-eval).
 *
 * loom#1549 F3 lock 8 — but NOT expanding it is not the same as pretending it
 * parsed. The prior tokenizer let substitution bytes "pass through as literal
 * token content", and because `$(echo /tmp/x)` contains a SPACE that split it
 * into TWO tokens: `-C` captured `$(echo`, its `i += 2` skipped past
 * `/tmp/x)` — and the SUBCOMMAND parsed as `/tmp/x)`. `reset` was never seen
 * as the subcommand, so the destructive-verb fence never fired at all. A
 * `git -C $(echo <dirty>) reset --hard` reached NO guard (measured: exit 0, no
 * fence, against a genuinely dirty tree that the plain spelling BLOCKS at exit
 * 2). Pre-existing — origin/main behaves identically — and owned here per
 * zero-tolerance.md Rule 1a.
 *
 * The fix is two-part, and neither part evaluates anything:
 *
 *   (1) LEXICAL GROUPING. Each construct is consumed ATOMICALLY, the way the
 *       shell's own word splitter does: `$(…)` and `${…}` to their matching
 *       close (nesting-aware), backticks to the next backtick. That alone
 *       restores correct SUBCOMMAND identification, so the fenced verb is seen.
 *   (2) AN EXPLICIT UNRESOLVABLE MARK. The token is flagged `unexpandable`, so
 *       a caller can fail CLOSED on a slot whose value it cannot know, BY
 *       DESIGN — rather than relying on a porcelain spawn happening to fail on
 *       a nonsense path, which is what "worked" for `${VAR}` by accident.
 *
 * Quoting context is modelled, because it decides whether the shell expands:
 * inside SINGLE quotes everything is literal (`'/tmp/a$b'` is a real path and
 * is NOT flagged); unquoted and inside DOUBLE quotes, `$`/backtick expand.
 *
 * ANSI-C quoting (`$'…'`) is handled here rather than left to chance. It used
 * to tokenize as `$/tmp/x` — the `$` fell through as an ordinary character —
 * which named no directory and so HALTed by ACCIDENT via the same fail-open
 * spawn. Now: an escape-FREE body is a literal path, decoded exactly (so
 * `$'/tmp/x'` reaches the same BLOCK as `/tmp/x` and `"/tmp/x"`); a body
 * containing a backslash carries escape semantics this parser will not
 * half-implement, so it is kept raw and flagged unexpandable → fail closed.
 * Correct where correctness is certain, fail-closed where it is not.
 *
 * Returns `{ value, unexpandable }[]`. `$IFS`-style word-splitting of the git
 * TOKEN ITSELF (`sudo $(echo git) …`) remains the accepted residual documented
 * at isGitToken — flagging it would require deciding an unknown wrapper operand
 * IS git, which is a guess, and would halt `sudo $(which foo) --bar`.
 */
function scanBalanced(raw, start, open, close) {
  // `start` indexes the character AFTER the opener. Returns the index just
  // past the matching close, or raw.length when unterminated (the segment
  // splitter can cut a substitution in half — see parseGitInvocation).
  let depth = 1;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i + 1;
  }
  return raw.length;
}

function tokenize(raw) {
  const toks = [];
  let cur = "";
  let started = false;
  let unexpandable = false;
  let quote = null;
  const flush = () => {
    toks.push({ value: cur, unexpandable });
    cur = "";
    started = false;
    unexpandable = false;
  };
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    // Single quotes: fully literal. No expansion, so nothing is flagged.
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      continue;
    }
    // Unquoted OR double-quoted: `$` and backtick still expand.
    if (quote !== "'" && (c === "$" || c === "`")) {
      const next = raw[i + 1];
      if (c === "`") {
        const end = scanBalanced(raw, i + 1, "\0", "`");
        cur += raw.slice(i, end);
        unexpandable = true;
        started = true;
        i = end - 1;
        continue;
      }
      if (next === "(") {
        const end = scanBalanced(raw, i + 2, "(", ")");
        cur += raw.slice(i, end);
        unexpandable = true;
        started = true;
        i = end - 1;
        continue;
      }
      if (next === "{") {
        const end = scanBalanced(raw, i + 2, "{", "}");
        cur += raw.slice(i, end);
        unexpandable = true;
        started = true;
        i = end - 1;
        continue;
      }
      // ANSI-C `$'…'` — only an opener when UNQUOTED (inside double quotes a
      // `'` is an ordinary character, so `"$'"` is a literal dollar-quote).
      if (next === "'" && quote === null) {
        let j = i + 2;
        let body = "";
        let escaped = false;
        for (; j < raw.length; j++) {
          if (raw[j] === "\\" && j + 1 < raw.length) {
            escaped = true;
            body += raw[j] + raw[j + 1];
            j++;
            continue;
          }
          if (raw[j] === "'") break;
          body += raw[j];
        }
        if (escaped) {
          cur += raw.slice(i, Math.min(j + 1, raw.length));
          unexpandable = true;
        } else {
          cur += body; // escape-free body IS the literal value
        }
        started = true;
        i = j;
        continue;
      }
      // `$NAME` / `$1` — parameter expansion without braces.
      if (next && /[A-Za-z_0-9]/.test(next)) {
        let j = i + 1;
        while (j < raw.length && /[A-Za-z_0-9]/.test(raw[j])) j++;
        cur += raw.slice(i, j);
        unexpandable = true;
        started = true;
        i = j - 1;
        continue;
      }
      // A bare `$` or backtick-less `$` before punctuation is a literal.
      cur += c;
      started = true;
      continue;
    }
    if (quote === '"') {
      // Inside DOUBLE quotes a backslash is special ONLY before `$`, a
      // backtick, `"`, `\`, or a newline (POSIX / bash). Before anything else
      // it is an ORDINARY CHARACTER and bash passes it through.
      //
      // loom#1549 F3 lock 9 — this branch used to consume the backslash
      // unconditionally, so `git -C "C:\Users\x\repo" reset --hard` parsed the
      // directory as `C:Usersxrepo`: a path that names nothing, so the
      // porcelain probe failed, `ok:false` fired, and `severity:"block"`
      // degraded to a non-blocking advisory. That is lock 6's own failure mode
      // reappearing on the exact form lock 6 exists to protect (a QUOTED path),
      // and it lands on Windows operators — where backslash paths are not an
      // edge case but the normal spelling. The single-quoted form was always
      // correct, which is what made the gap easy to miss.
      if (c === "\\" && i + 1 < raw.length) {
        const n = raw[i + 1];
        if (n === "$" || n === "`" || n === '"' || n === "\\" || n === "\n") {
          cur += raw[++i]; // a real escape — the backslash is consumed
        } else {
          cur += c; // literal backslash, e.g. every separator in C:\Users\x
        }
      } else if (c === '"') quote = null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      continue;
    }
    if (c === "\\" && i + 1 < raw.length) {
      cur += raw[++i];
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (started) flush();
      else {
        cur = "";
        unexpandable = false;
      }
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) flush();
  return toks;
}

function parseGitInvocation(seg) {
  const raw = (seg || "").trim();
  if (!raw) return null;
  // loom#1549 F3 lock 9 — NO empty-token filter. The inherited
  // `.filter(Boolean)` was correct for `raw.split(/\s+/)`, which manufactures
  // empty strings at every run of whitespace. A quote-aware tokenizer never
  // does: it emits an empty token from exactly ONE source, an explicit empty
  // quote pair (`""` / `''`), which is a REAL shell word and load-bearing here.
  // Carrying the filter across the rewrite deleted that word — so in
  // `git -C "" reset --hard HEAD` the `-C` handler captured the SUBCOMMAND as
  // its directory and `sub` parsed as `head`, matching no fenced verb, and all
  // three fences went silent. Git's own semantics are the point: "If <path> is
  // present but empty, e.g. -C "", then the current working directory is left
  // unchanged" — so bash runs that command as a plain `git reset --hard HEAD`
  // against the SESSION repo, the dirty tree the fence exists to protect.
  const toks = tokenize(raw);

  // (1) Skip leading wrappers + their flags/operands + VAR=val until `git`.
  let i = 0;
  let sawWrapper = false;
  while (i < toks.length) {
    const t = toks[i].value;
    if (isGitToken(t)) break; // the git command token
    if (/^[A-Za-z_]\w*=/.test(t)) {
      i++;
      continue;
    } // VAR=val assignment
    if (GIT_WRAPPERS.has(t.replace(/^.*\//, ""))) {
      sawWrapper = true;
      i++;
      continue;
    } // wrapper command name (basename, so `/usr/bin/sudo` counts)
    if (t.startsWith("-")) {
      i++;
      continue;
    } // a flag (wrapper's or env's)
    if (sawWrapper) {
      i++;
      continue;
    } // bare flag-operand inside wrapper context (e.g. `-u root`)
    return null; // bare non-git command outside wrapper context → not git
  }
  if (i >= toks.length || !isGitToken(toks[i].value)) return null;
  i++; // consume the git token

  // (2) Skip git global options; capture the effective work-tree for the
  // structural porcelain check. A bare `--git-dir` does NOT set the target
  // (its work-tree defaults to cwd); only `--work-tree`/`-C` relocate it.
  // git applies these SEQUENTIALLY, so a later `-C` supersedes an earlier
  // one — the plain assignment below is what makes last-wins hold.
  let cDir = null;
  let cDirUnexp = false;
  let workTree = null;
  let workTreeUnexp = false;
  // Did an unexpandable construct appear anywhere at/after the git token? Used
  // ONLY to distinguish "this is not a git invocation" from "this IS one whose
  // subcommand a substitution swallowed" — see the return below.
  let sawUnexpandable = false;
  while (i < toks.length) {
    const t = toks[i].value;
    if (toks[i].unexpandable) sawUnexpandable = true;
    if (t === "--") {
      i++;
      break;
    }
    // An EMPTY value is git's documented no-op, NOT a relocation: "If <path> is
    // present but empty, e.g. -C \"\", then the current working directory is
    // left unchanged" (git(1)). So the empty word is CONSUMED (`i += 2`, or the
    // subcommand would be read as the directory) while the effective target is
    // left exactly as it was — which correctly preserves an earlier `-C` under
    // git's sequential last-wins, and otherwise leaves `dir` null so the fence
    // measures the session cwd. This is the tree git will really mutate.
    //
    // It is also a plain correctness fix, not only an evasion fix: an unset
    // `$REPO` in `git -C "$REPO" reset --hard` produces the identical word.
    if (t === "-C") {
      const v = toks[i + 1];
      if (v !== undefined && v.value !== "") {
        cDir = dequote(v.value);
        cDirUnexp = v.unexpandable;
        if (cDirUnexp) sawUnexpandable = true;
      }
      i += 2;
      continue;
    }
    if (t === "--work-tree") {
      // Same treatment. An empty `--work-tree` cannot name a directory, so it
      // does not relocate the tree and the fence falls back to `-C`/cwd. (The
      // ATTACHED spelling `--work-tree=""` already behaved this way: its
      // `(.+)` capture cannot match empty, so the token fell through to the
      // generic dash-flag skip. The separated spelling is what was missing.)
      const v = toks[i + 1];
      if (v !== undefined && v.value !== "") {
        workTree = dequote(v.value);
        workTreeUnexp = v.unexpandable;
        if (workTreeUnexp) sawUnexpandable = true;
      }
      i += 2;
      continue;
    }
    if (
      t === "-c" ||
      t === "--git-dir" ||
      t === "--namespace" ||
      t === "--super-prefix"
    ) {
      i += 2;
      continue;
    }
    const wt = t.match(/^--work-tree=(.+)$/);
    if (wt) {
      workTree = dequote(wt[1]);
      workTreeUnexp = toks[i].unexpandable;
      i++;
      continue;
    }
    if (t.startsWith("-")) {
      i++; // --git-dir=X, -p, --paginate, --bare, --no-pager, etc.
      continue;
    }
    break; // first non-option token = the subcommand
  }
  if (i >= toks.length) {
    // No subcommand token. Ordinarily that is "not a git invocation" (a bare
    // `git`) and stays null. But when an unexpandable construct was consumed on
    // the way here, the subcommand may have been swallowed by it — including
    // the case where the caller's RAW segment splitter cut a `$(a && b)` in
    // half, leaving an unterminated opener that ate the rest of the fragment.
    // Reporting null there would resurrect the exact silent-pass this fix
    // exists to close, so it is reported as an invocation with an UNKNOWN
    // subcommand instead. Verb fences compare `sub` against a literal and so
    // ignore it; only the fail-closed lane acts on `unresolvable`.
    if (!sawUnexpandable) return null;
    return {
      sub: null,
      dir: workTree || cDir,
      args: "",
      unresolvable: "subcommand",
    };
  }
  // Scope of the fail-closed mark (loom#1549 F3 lock 8). It covers ONLY the two
  // slots that can change WHICH fence fires or WHICH tree it measures:
  //
  //   "subcommand" — the verb itself is unknown, so ANY fence might have
  //                  applied. Strictly worse than an unknown dir; wins.
  //   "dir"        — the `-C` / `--work-tree` VALUE, i.e. the tree the
  //                  destructive op will mutate and the porcelain probe must
  //                  read.
  //
  // Deliberately NOT every substitution-bearing git segment. Measured over this
  // repo's own corpus: 1905 git invocations carry a substitution somewhere, but
  // only 19 (1.0%) put one in a `-C`/`--work-tree`/`--git-dir` value. Marking
  // all 1905 would halt `git log $(git merge-base a b)`, `git status`,
  // `git rev-parse` and ~1900 more benign reads — noise on that scale is how a
  // guard gets switched off, which costs the whole fence rather than this one
  // slot. An ARG-slot substitution (`git reset --hard $(git rev-parse X)`)
  // needs no mark: both the verb and the target tree are still fully known, so
  // the fence measures the right tree and BLOCKS normally — a strictly stronger
  // outcome than halting would be. `--git-dir` is likewise excluded: it
  // relocates the REPO, not the work tree, so the cwd the probe reads is still
  // the tree the op mutates.
  const dirUnexp = workTree ? workTreeUnexp : cDirUnexp;
  return {
    sub: toks[i].value.toLowerCase(),
    dir: workTree || cDir,
    args: toks
      .slice(i + 1)
      .map((t) => t.value)
      .join(" "),
    unresolvable: toks[i].unexpandable ? "subcommand" : dirUnexp ? "dir" : null,
  };
}

/**
 * Every git invocation in a command string, one per shell segment.
 *
 * Comments are blanked FIRST, then the (quote-aware) segmenter runs, so a
 * `commit` appearing in a comment or inside a quoted `-m` body is not mistaken
 * for a subcommand. Segments that are not git invocations are dropped.
 */
function parseGitInvocations(command) {
  const cleaned = stripShellComments(command);
  if (!cleaned.trim()) return [];
  const out = [];
  for (const seg of splitShellSegments(cleaned, { newlineSeparates: true })) {
    const text = typeof seg === "string" ? seg : seg && seg.text;
    const g = parseGitInvocation(text);
    if (g) out.push(g);
  }
  return out;
}

/**
 * The predicate the pairing guard needs: does this command actually RUN
 * `git <sub>`? Returns the matching invocation (so the caller can read `.dir`
 * and act on the SAME tree git will) or null.
 *
 * `sub` is matched exactly against the parsed subcommand, which is what makes
 * `commit` distinct from `commit-tree` / `commit-graph` without a lookahead,
 * and makes `--grep=commit` an ARGUMENT rather than a subcommand.
 */
function findGitSubcommand(command, sub) {
  const want = String(sub || "").toLowerCase();
  if (!want) return null;
  for (const g of parseGitInvocations(command)) {
    if (g.sub === want) return g;
  }
  return null;
}

module.exports = {
  GIT_WRAPPERS,
  isGitToken,
  dequote,
  stripShellComments,
  parseGitInvocation,
  parseGitInvocations,
  findGitSubcommand,
};
