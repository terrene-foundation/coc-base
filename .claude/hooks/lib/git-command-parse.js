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
  // `xargs` (loom#1589). It belongs here for the same reason `nice` does: it
  // carries its own flags and then EXECs the command named in its operands, so
  // the git token sits exactly where the wrapper scan already looks. What it
  // adds — stdin words appended to argv — cannot change WHICH command runs, so
  // it needs no special case beyond membership. Measured before this entry:
  // `echo --allow-empty | xargs git commit -m x` produced a real commit
  // (commits 1->2) while the mutation fence returned `allow`, because `xargs`
  // fell through the prefix scan's "bare non-git command" branch and the
  // segment parsed as NOT-git at all.
  "xargs",
]);

// Shells that accept a COMMAND STRING as the operand of `-c`. The string is a
// nested command, not an argument, so answering "does this command run
// `git commit`?" requires re-parsing it — see nestedCommandStrings. `eval` is
// handled alongside these but is a BUILTIN with different operand semantics
// (it concatenates ALL of them), so it is not a member.
const SHELL_C_WRAPPERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "mksh",
  "ash",
  "busybox",
]);

const basename = (t) => String(t).replace(/^.*\//, "");

const isNestingCommandToken = (t) => {
  const b = basename(t);
  return b === "eval" || SHELL_C_WRAPPERS.has(b);
};

// The `unresolvable` values that mean "a git/gh invocation IS implicated and its
// VERB cannot be known without evaluating shell". A verb fence MUST fail closed
// on these: any fence might have applied. Callers share THIS set rather than each
// spelling its own literal, per security.md § Enforcement-Surface Parity.
//
// `"dir"` is NOT a member: there the verb is known and only the target tree is
// not, so a verb fence has everything it needs.
//
// `"command"` is NOT a member either, and that boundary is load-bearing. It marks
// an unresolvable COMMAND NAME with NO evidence git is involved (`$PYTHON -m
// pytest`, `command -v "$1"`, `files+=("$f")`, and every `$VAR`-headed line of a
// HEREDOC BODY, since callers split on newlines). Measured over this repo's own
// `.sh`/`.bash` corpus (2888 command-ish lines): 15 such lines resolve a verb and
// 40 resolve none — and reading the hits shows they are array appends, heredoc
// bodies and `command -v` probes, not hidden git. Fencing on `"command"` alone
// would therefore re-introduce the HEREDOC false-positive class that
// `hook-output-discipline.md`'s own Origin names and that loom#1590 removed. Its
// USE is to let a consumer act on a verb that IS visible next to an opaque
// command name (`$(echo git) commit` → `sub: "commit"`), which is what closes
// that bypass without the noise.
const UNRESOLVABLE_COMMAND_IDENTITY = new Set(["subcommand", "group"]);

// `git`, `/usr/bin/git`, `./git`, `\git` — a path-qualified, bare, or
// backslash-escaped git token. The optional leading `\` closes the
// MED-R3-1 alias-bypass form (`\git clean` runs the git binary at bash
// runtime; the backslash only skips alias/function lookup).
//
// The `$IFS` form (`git$IFS clean`) is NOT matchable HERE — resolving it needs
// the expansion the hook MUST NOT perform (hook-output-discipline.md Rule 3 /
// security.md § no-eval) — but it is NO LONGER an accepted residual. The prior
// comment justified accepting it "backed by the sync-tier-aware pre-write
// snapshot", and that justification DOES NOT TRANSFER to a git-verb fence: the
// snapshot was reasoned for validate-bash-command.js's destructive-FILE-op lane,
// and a pre-write file snapshot does not undo an unauthorized `git commit`,
// while nothing local undoes a `git push`. A residual accepted under one
// backstop had been inherited by a `block`-severity gate whose backstop does not
// exist. Measured: all three spellings (`git$IFS commit`, `git${IFS}commit`,
// `git${IFS}commit${IFS}-m${IFS}x`) produced real commits (1->2) while the
// mutation fence returned `allow`. They are now caught NOT by matching the token
// but by REFUSING TO GUESS at it — see looksLikeFusedGitToken.
// A backslash-newline is a LINE CONTINUATION: POSIX deletes it outright before
// word splitting, so `git \<newline>commit` is the two words `git` `commit`.
// This tokenizer instead preserves the escaped newline as a literal `\n` inside
// the token it was accreting. When horizontal whitespace follows the
// continuation the token flushes and the residue is whitespace-only, which the
// verb loop already skips (`t.trim() === ""`). When NOTHING follows it, the
// next word accretes onto the newline and the verb slot receives `"\ncommit"` —
// which matches no entry in any FENCED_* set and leaves `unresolvable` null, so
// neither the fenced comparison nor the fail-closed lane fires. Measured: that
// spelling executes a real commit (commits 1->2, exit 0) while the gate allows.
// It is the SAME class as the `sub: "\n"` bypass this file already fixes, one
// character apart — the fix closed the indented spelling and stopped there.
//
// Stripping is unambiguous here: callers split segments with
// `newlineSeparates: true`, so an UNESCAPED newline can never survive inside a
// token. A raw leading newline therefore proves a continuation was consumed.
// Scoped to LEADING newlines only — an interior one (`git com\<newline>mit`)
// joins to `commit` in the shell too, but that reshapes the word rather than
// prefixing it, and is left to the tokenizer rather than papered over here.
// Values retain their quotes at this layer, so a deliberate `git "\n" …` starts
// with `"` and is untouched.
const stripConsumedContinuation = (v) =>
  typeof v === "string" ? v.replace(/^[\n\r]+/, "") : v;

const isGitToken = (t) => /^\\?(?:[^\s]*\/)?git$/.test(t);

/**
 * A token that BEGINS with a complete `git` (or `gh`) word and then runs
 * straight into a shell expansion: `git$IFS`, `git${IFS}commit`, `gh$X pr`.
 *
 * This is POSITIVE EVIDENCE the segment invokes git/gh, obtained without
 * expanding anything. The word boundary is what makes it evidence rather than a
 * substring guess: the negative lookahead rejects `github`, `gitk`, `git-foo`
 * and `ghost`, so only a token whose git/gh word ENDS at the expansion matches.
 *
 * It is a predicate over ONE TOKEN at the COMMAND-NAME POSITION, produced by the
 * tokenizer — the same structural class as `isGitToken` itself, NOT a regex over
 * a joined command string (`hook-output-discipline.md` MUST-5). What the caller
 * does with it is REFUSE TO RESOLVE: the expansion may either separate the verb
 * (`git$IFS commit` → words `git` `commit`) or FUSE it into this same token
 * (`git${IFS}commit` → words `git` `commit` as well, but the literal `commit`
 * never appears as its own token). Those two shapes are indistinguishable
 * without expanding, and one of them hides the verb — so both are reported as an
 * UNRESOLVABLE SUBCOMMAND rather than parsed. That is deliberately the SAME mark
 * `git $(echo commit)` already carries, which is what makes every consumer's
 * existing fail-closed lane cover this class without a new branch.
 */
const looksLikeFusedGitToken = (tok) =>
  !!tok &&
  tok.unexpandable === true &&
  /^\\?(?:[^\s]*\/)?git(?![A-Za-z0-9_.-])/.test(tok.value);

const looksLikeFusedGhToken = (tok) =>
  !!tok &&
  tok.unexpandable === true &&
  /^\\?(?:[^\s]*\/)?gh(?![A-Za-z0-9_.-])/.test(tok.value);

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

/**
 * Walk the TRANSPARENT PREFIX of a segment — `VAR=val` assignments,
 * command-wrappers and their flags/operands — and report where the
 * COMMAND-NAME slot lands.
 *
 * ONE walk shared by the git path, the gh path and the nested-body extractor
 * (loom#1589). Each had grown its own copy of these six skip rules, which is the
 * drift this module exists to end; adding `xargs` or a new assignment shape is
 * now one edit here rather than three.
 *
 * Returns `{ kind, idx, unresolvedCommandSlot }`:
 *   kind "match" — toks[idx] satisfies `stopAt`; the caller's command was found.
 *   kind "other" — toks[idx] is a RESOLVABLE command name that is not the
 *                  caller's. Historically this was a bare `return null`; the
 *                  index is now reported because when an EARLIER slot was
 *                  unresolvable, the words from here on still occupy the
 *                  argument positions of whatever that slot names.
 *   kind "end"   — the prefix consumed every token (idx === toks.length).
 *
 * `unresolvedCommandSlot` is set when an UNEXPANDABLE construct occupied a slot
 * that could itself BE the command name. That is the asymmetry loom#1589
 * measured: the SUBCOMMAND slot already failed CLOSED, while an unresolvable
 * COMMAND slot returned null and was therefore indistinguishable from "no git
 * here" — it failed OPEN. `$(echo git) commit -m x` produced a real commit
 * (1->2) against an `allow` verdict for exactly that reason.
 *
 * Note the ORDER: the unexpandable test sits BEFORE the `sawWrapper` bare-operand
 * skip so it fires in wrapper context too (`sudo $(echo git) commit`), and AFTER
 * the dash-flag and `VAR=val` tests so a substitution in a FLAG VALUE or an
 * assignment (`env FOO=$(date) git commit`) is not mistaken for the command name.
 */
function scanCommandPrefix(toks, stopAt) {
  let i = 0;
  let sawWrapper = false;
  let unresolvedCommandSlot = false;
  // Index of the FIRST unexpandable token treated as a possible command name.
  // The caller must RESUME PARSING AT `commandSlotIdx + 1`, not at `idx`: this
  // walk skips dash-flags ONE AT A TIME without knowing which consume a value
  // (correct for a wrapper's flags, and it never reaches a git GLOBAL option
  // because it stops at the git token first). With the command name unresolved
  // there is no such stop, so `-C` was skipped as a wrapper flag and its PATH
  // landed in the verb slot: `$(echo git) -C <dir> reset --hard` parsed
  // `sub: "<dir>"`, matched no fence, and reached a silent allow while the plain
  // spelling of the same operation BLOCKS. Resuming after the command slot hands
  // `-C` to the git global-option loop, which does know it takes a value.
  let commandSlotIdx = -1;
  while (i < toks.length) {
    const t = toks[i].value;
    if (stopAt(toks[i]))
      return { kind: "match", idx: i, unresolvedCommandSlot, commandSlotIdx };
    if (/^[A-Za-z_]\w*\+?=/.test(t)) {
      i++;
      continue;
    } // VAR=val assignment, or the `arr+=(…)` append form (also an assignment,
    // never a command — without the `\+?` it fell through to the command-name
    // slot and, being substitution-bearing, marked the segment unresolvable)
    if (GIT_WRAPPERS.has(basename(t))) {
      sawWrapper = true;
      i++;
      continue;
    } // wrapper command name (basename, so `/usr/bin/sudo` counts)
    if (t.startsWith("-")) {
      i++;
      continue;
    } // a flag (wrapper's or env's)
    if (toks[i].unexpandable) {
      // The command name itself is produced by a construct this hook must not
      // evaluate. Keep scanning — a LATER literal git token is strictly more
      // informative than this mark (`timeout $(echo 5) git commit` should fence
      // on `commit`, precisely, rather than on the unknown operand) — but
      // remember that we passed one, so a caller that finds nothing better can
      // fail CLOSED instead of silently reporting "not a git invocation".
      unresolvedCommandSlot = true;
      if (commandSlotIdx === -1) commandSlotIdx = i;
      i++;
      continue;
    }
    if (sawWrapper) {
      i++;
      continue;
    } // bare flag-operand inside wrapper context (e.g. `-u root`)
    return { kind: "other", idx: i, unresolvedCommandSlot, commandSlotIdx };
  }
  return { kind: "end", idx: i, unresolvedCommandSlot, commandSlotIdx };
}

/**
 * The COMMAND STRINGS nested inside a segment: the operand of a shell's `-c`,
 * and the concatenated operands of `eval`.
 *
 * loom#1589. `eval "git commit -m x"`, `sh -c 'git commit -m x'` and
 * `bash -c '…'` each produced a real commit (1->2) while the mutation fence
 * returned `allow`, because the quoted body is ONE TOKEN and was never re-parsed:
 * the segment's command name was `eval`/`sh`, which is not git, so
 * `parseGitInvocation` returned null and the fence's loop body never ran. An
 * ABSENT invocation read identically to "no git here".
 *
 * This is EXTRACTION, not evaluation. The body is a substring the tokenizer
 * already isolated; re-parsing it asks the same structural question one level
 * down. Nothing is expanded, and nothing is executed.
 *
 * Returns `{ commands, unresolvable }`. `unresolvable` is set when a body EXISTS
 * but its content cannot be known — `sh -c "$CMD"`, `eval "$(cat f)"` — because
 * "there is a nested command and it could be anything" must not read the same as
 * "there is no nested command".
 *
 * A shell invoked WITHOUT `-c` (`bash script.sh`) yields NO nested command and is
 * NOT marked unresolvable. That is a NAMED, deliberate residual: the body is a
 * FILE, so catching it would mean either reading the file (a different and
 * changing artifact from the one the fence was handed) or denying every
 * `bash ./run.sh`, and the latter is how a guard gets switched off. It is also
 * not a one-liner rewrite of a fenced command — it needs a separate file-write
 * step, which the Edit/Write fences govern at L2/L1.
 */
function nestedCommandStrings(seg) {
  const toks = tokenize(String(seg || ""));
  const empty = { commands: [], unresolvable: false };
  const scan = scanCommandPrefix(toks, (tok) =>
    isNestingCommandToken(tok.value),
  );

  if (scan.kind !== "match") {
    if (!scan.unresolvedCommandSlot) return empty;
    // OPAQUE COMMAND NAME. The shell's IDENTITY is hidden, so its OPERAND
    // SEMANTICS are hidden with it — this parser cannot know whether operand N is
    // a filename, a `k=v`, or a COMMAND STRING. Optimistically reading the
    // remainder as git global-options + subcommand (what parseGitInvocation does)
    // then walks straight past a body: measured, `$(echo sh) -c 'git commit -m x'`,
    // `$(echo bash) -c '…'`, `$(echo eval) "git commit -m x"` and
    // `SH=sh; $SH -c '…'` each produced a real commit (1->2) against an `allow`
    // verdict, because `-c` was consumed as git's OWN `-c` and its value skipped.
    //
    // So consider the WORST PLAUSIBLE READING: every non-flag operand is offered
    // as a candidate command string. That fails closed only when a candidate
    // actually PARSES to a fenced invocation, which is what keeps it quiet on the
    // ordinary forms — `$PYTHON -m pytest` offers `pytest`, `"$PM" install` offers
    // `install`, and neither is a git invocation, so neither is fenced.
    const cands = [];
    for (let j = scan.commandSlotIdx + 1; j < toks.length; j++) {
      const t = toks[j].value;
      if (t === "--") break;
      if (t.startsWith("-")) continue; // a flag is never a command string
      // An UNEXPANDABLE operand is skipped rather than marked: an opaque operand
      // beside an opaque command name adds no evidence that git is involved, and
      // marking it would fence every `$SH -c "$CMD"`-shaped line — the same
      // over-reach the `"command"` mark is scoped away from.
      if (toks[j].unexpandable) continue;
      if (t.trim()) cands.push(t);
    }
    return { commands: cands, unresolvable: false };
  }

  const name = basename(toks[scan.idx].value);
  let i = scan.idx + 1;

  if (name === "eval") {
    // `eval` concatenates ALL its operands with a space and evaluates the
    // result, so the body is the remainder of the segment — not just the next
    // token. That is what makes the unquoted `eval git commit -m x` equivalent
    // to the quoted spelling; both were measured committing for real.
    const rest = toks.slice(i);
    if (!rest.length) return empty;
    if (rest.some((t) => t.unexpandable)) {
      return { commands: [], unresolvable: true };
    }
    const body = rest.map((t) => t.value).join(" ");
    return body.trim() ? { commands: [body], unresolvable: false } : empty;
  }

  // A shell: the command string is the operand of `-c`. The flag may arrive
  // clustered (`bash -lc '…'`, `sh -ec '…'`), which is a spelling an agent
  // emits and which a bare `t === "-c"` test misses — measured: `bash -lc
  // 'git commit -m x'` committed for real against an `allow` verdict.
  for (; i < toks.length; i++) {
    const t = toks[i].value;
    if (t === "--") break;
    const isShortC = t === "-c" || /^-[A-Za-z]*c[A-Za-z]*$/.test(t);
    if (!isShortC) continue;
    const v = toks[i + 1];
    if (v === undefined) break;
    if (v.unexpandable) return { commands: [], unresolvable: true };
    return v.value.trim()
      ? { commands: [v.value], unresolvable: false }
      : empty;
  }
  return empty;
}

// A nested body is always a STRICT SUBSTRING of the segment that carries it, so
// the recursion below terminates on string length alone. The cap is a COST bound
// for a pathological input, not a correctness bound — and hitting it is reported
// (`truncated`) rather than silently stopping, so no consumer mistakes an
// abandoned walk for a clean one (zero-tolerance.md Rule 3).
const MAX_NEST_DEPTH = 8;

/**
 * Expand a segment list to include every nested shell body, recursively.
 *
 * Returned segments are ORDER-EXTENDED, never re-ordered: the originals come
 * first in their original order, each followed by its own nested bodies. A
 * caller that tracks state ACROSS segments (validate-bash-command.js's `cd`
 * trail) must therefore keep using its own unexpanded list — a nested body runs
 * in a SUBSHELL, so it cannot move the parent shell's cwd, and splicing it into
 * a cd trail would model a directory change that never happens.
 */
function expandNestedSegments(segments, maxDepth = MAX_NEST_DEPTH) {
  const out = [];
  let truncated = false;
  let unresolvable = false;
  const walk = (segs, depth) => {
    for (const s of segs || []) {
      const text = typeof s === "string" ? s : s && s.text;
      if (typeof text !== "string" || !text.trim()) continue;
      out.push(text);
      const nested = nestedCommandStrings(text);
      if (nested.unresolvable) unresolvable = true;
      if (!nested.commands.length) continue;
      if (depth >= maxDepth) {
        truncated = true;
        continue;
      }
      for (const cmd of nested.commands) {
        const cleaned = stripShellComments(cmd);
        if (!cleaned.trim()) continue;
        walk(
          splitShellSegments(cleaned, { newlineSeparates: true }),
          depth + 1,
        );
      }
    }
  };
  walk(segments, 0);
  return { segments: out, truncated, unresolvable };
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
  // A FUSED git token (`git$IFS…`) stops the scan too: it is positive evidence
  // of a git invocation whose verb may be hidden inside the expansion, and the
  // caller below refuses to resolve it rather than guessing which.
  const scan = scanCommandPrefix(
    toks,
    (tok) => isGitToken(tok.value) || looksLikeFusedGitToken(tok),
  );
  let i = scan.idx;

  if (scan.kind === "match" && looksLikeFusedGitToken(toks[i])) {
    // `git$IFS commit` and `git${IFS}commit` are the SAME command to the shell
    // (both word-split to `git` `commit`) but differ in whether the verb ever
    // appears as its own token. Indistinguishable without expanding, and one of
    // them hides the verb — so report the mark every consumer already fails
    // CLOSED on rather than parsing one shape correctly and the other blind.
    return {
      sub: null,
      dir: null,
      args: "",
      argv: [],
      unresolvable: "subcommand",
    };
  }

  const gitFound = scan.kind === "match";
  if (!gitFound && scan.unresolvedCommandSlot) {
    // Resume AFTER the unresolved command-name token so the git global-option
    // loop below — which knows `-C` and `--work-tree` consume a value — parses
    // the remainder, rather than inheriting the prefix walk's one-flag-at-a-time
    // skip. See scanCommandPrefix's commandSlotIdx for the measured defect.
    i = scan.commandSlotIdx + 1;
  }
  if (!gitFound) {
    // No literal git token. Historically an unconditional `return null` — which
    // is correct for a genuinely non-git segment (`echo hi`) but was ALSO the
    // answer when a substitution occupied the command-name slot, and that is the
    // fail-OPEN asymmetry loom#1589 measured. When such a slot was passed, the
    // remaining words still sit in the argument positions of whatever it names,
    // so they are parsed and reported ALONGSIDE the mark: `$(echo git) commit`
    // yields `sub: "commit"` with `unresolvable: "command"`, which lets a verb
    // fence act on the precise verb instead of on a bare unknown.
    if (!scan.unresolvedCommandSlot) return null;
  } else {
    i++; // consume the git token
  }
  const commandSlotUnresolved = !gitFound && scan.unresolvedCommandSlot;

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
    const t = stripConsumedContinuation(toks[i].value);
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
    // A WHITESPACE-ONLY token is not a shell WORD and must never occupy the
    // verb slot. `git \<newline> commit -m x` is ONE command to the shell —
    // backslash-newline is a line continuation, removed before word splitting —
    // but the tokenizer preserves the escaped newline as its own token. Without
    // this skip it lands in the verb slot as `sub: "\n"`, which matches no entry
    // in any FENCED_* set AND leaves `unresolvable` null, so neither the fenced
    // comparison nor the fail-closed lane fires; the real verb then sits
    // unexamined in argv[0] and a genuine commit reaches only halt-and-report.
    // Measured before the fix: the shape executes a real commit (commits 1->2,
    // exit 0) while the gate returned HALT-AND-REPORT rather than BLOCK. Same
    // shape class as the confirmed live prod-deploy bypass S-1587-7, which is
    // why this is a parity fix and not a one-off (security.md § Enforcement-
    // Surface Parity).
    //
    // Scoped deliberately to the UNQUOTED case. Values here are still quoted
    // (callers `dequote` on demand), so a deliberate `git " " …` keeps its
    // quotes, does not trim to empty, and retains its pre-existing behaviour —
    // this skip cannot swallow a real argument, and it never touches argv,
    // which is built from `rest` below.
    if (t.trim() === "") {
      i++;
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
    if (!sawUnexpandable) {
      // Nothing at/after the command slot hid a verb. If the COMMAND NAME itself
      // was unresolvable, that alone is still reportable — `$(which foo) --bar`
      // names no verb this parser can see, and reporting null would put it back
      // on the fail-OPEN path. `"command"` (not `"subcommand"`) is deliberate:
      // there is no evidence a git verb is present at all, so the mark says
      // exactly what is unknown and lets the consumer set its own threshold.
      if (commandSlotUnresolved) {
        return {
          sub: null,
          dir: workTree || cDir,
          args: "",
          argv: [],
          unresolvable: "command",
        };
      }
      return null;
    }
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
  const rest = toks.slice(i + 1);
  return {
    sub: stripConsumedContinuation(toks[i].value).toLowerCase(),
    dir: workTree || cDir,
    args: rest.map((t) => t.value).join(" "),
    // loom#1590 — the post-subcommand words as TOKENS, not a joined string.
    // A caller deciding whether an invocation MUTATES has to tell a real
    // `--dry-run` FLAG from the same characters sitting inside a `-m` message
    // body; the joined `args` cannot express that difference, so any consumer
    // splitting it on whitespace would read `git commit -m "fix --dry-run"` as
    // a dry run and wave through a real commit. Quoting is already consumed by
    // the tokenizer, so one token is exactly one shell word.
    argv: rest.map((t) => t.value),
    // Precedence, worst-first: an unknown VERB could match any fence, so it
    // outranks an unknown TREE; an unknown COMMAND NAME ranks last because the
    // verb IS resolved here and a consumer can fence on it precisely.
    unresolvable: toks[i].unexpandable
      ? "subcommand"
      : dirUnexp
        ? "dir"
        : commandSlotUnresolved
          ? "command"
          : null,
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
  const top = splitShellSegments(cleaned, { newlineSeparates: true });
  // Nested shell bodies are commands too (loom#1589) — see expandNestedSegments.
  const nested = expandNestedSegments(top);
  const out = [];
  for (const text of nested.segments) {
    const g = parseGitInvocation(text);
    if (g) out.push(g);
  }
  if (nested.unresolvable || nested.truncated) {
    // A nested body EXISTS but its content is unknowable (`sh -c "$CMD"`) or the
    // cost cap stopped the walk. Reporting only the segments we DID parse would
    // make an abandoned walk read as a complete one, which is the silent pass
    // this whole change closes. Appended LAST so a genuinely-resolved fenced verb
    // found earlier still produces the more precise finding.
    out.push({
      sub: null,
      dir: null,
      args: "",
      argv: [],
      unresolvable: "subcommand",
    });
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

// ---------------------------------------------------------------------------
// gh (GitHub CLI) invocations — the SAME structural treatment as git above.
//
// WHY HERE, and not a fourth regex somewhere (loom#1590). posture-gate.js
// fenced `gh pr create` / `gh pr merge` / `gh release create` with flat
// `\b`-anchored regexes over the RAW command string. That is the identical
// defect this module was extracted to end for git: the pattern fires on the
// verb appearing inside a quoted string or a heredoc body, and misses nothing
// only because nobody had yet written the evasion. Answering "does this
// command actually RUN `gh <group> <sub>`?" needs the same tokenize →
// segment → SUBCOMMAND-POSITION dispatch, so it reuses the same tokenizer
// rather than growing a parallel lineage.
//
// gh's grammar is `gh <group> <subcommand> [flags]` — two positional words,
// where git has one. Everything else (wrappers, VAR=val, quoting, comments,
// substitution marking) is shared verbatim with the git path.
const isGhToken = (t) => /^\\?(?:[^\s]*\/)?gh$/.test(t);

// gh flags that consume a SEPARATE following value. Skipping the value matters
// because it can otherwise be mistaken for a positional word: in
// `gh --repo o/r pr create`, `o/r` would parse as the GROUP and `pr` as the
// SUBCOMMAND, so the `pr create` fence would not fire. Attached forms
// (`--repo=o/r`) are a single token and need no entry.
const GH_VALUE_FLAGS = new Set(["-R", "--repo", "--hostname"]);

function parseGhInvocation(seg) {
  const raw = (seg || "").trim();
  if (!raw) return null;
  const toks = tokenize(raw);

  // (1) Skip leading wrappers + their flags/operands + VAR=val until `gh`.
  // Identical contract to the git path — see parseGitInvocation step (1). Swept
  // in the SAME change per security.md § Enforcement-Surface Parity: a gh path
  // left on the old prologue would ship the exact command-slot fail-OPEN the git
  // path just closed, and `gh pr merge` is as consequential as `git push`.
  const scan = scanCommandPrefix(
    toks,
    (tok) => isGhToken(tok.value) || looksLikeFusedGhToken(tok),
  );
  let i = scan.idx;

  if (scan.kind === "match" && looksLikeFusedGhToken(toks[i])) {
    return { group: null, sub: null, args: "", argv: [], unresolvable: "group" };
  }

  const ghFound = scan.kind === "match";
  if (!ghFound && scan.unresolvedCommandSlot) {
    // Same resume rule as the git twin: `$(echo gh) --repo o/r pr create` must
    // hand `--repo` to the positional loop below (which knows it takes a value)
    // instead of letting `o/r` be read as the GROUP.
    i = scan.commandSlotIdx + 1;
  }
  if (!ghFound) {
    if (!scan.unresolvedCommandSlot) return null;
  } else {
    i++; // consume the gh token
  }
  const commandSlotUnresolved = !ghFound && scan.unresolvedCommandSlot;

  // (2) Collect the first TWO positional words: the group and its subcommand.
  const words = [];
  let sawUnexpandable = false;
  let positionalUnexpandable = false;
  while (i < toks.length && words.length < 2) {
    const t = toks[i].value;
    if (toks[i].unexpandable) sawUnexpandable = true;
    if (t === "--") {
      i++;
      break;
    }
    if (GH_VALUE_FLAGS.has(t)) {
      i += 2;
      continue;
    }
    if (t.startsWith("-")) {
      i++;
      continue;
    }
    if (toks[i].unexpandable) positionalUnexpandable = true;
    words.push(t.toLowerCase());
    i++;
  }

  if (!words.length) {
    // Same reasoning as the git path's no-subcommand return: a bare `gh` is
    // not an invocation worth reporting, but a substitution that SWALLOWED the
    // group must not be reported as "no gh here" — that is the silent pass the
    // fail-closed mark exists to prevent.
    if (!sawUnexpandable) {
      if (commandSlotUnresolved) {
        return {
          group: null,
          sub: null,
          args: "",
          argv: [],
          unresolvable: "command",
        };
      }
      return null;
    }
    return { group: null, sub: null, args: "", unresolvable: "group" };
  }

  const rest = toks.slice(i);
  return {
    group: words[0],
    sub: words[1] || null,
    args: rest.map((t) => t.value).join(" "),
    argv: rest.map((t) => t.value), // see the git twin: tokens, not a joined string
    // Same worst-first precedence as the git twin.
    unresolvable: positionalUnexpandable
      ? "subcommand"
      : commandSlotUnresolved
        ? "command"
        : null,
  };
}

/**
 * Every gh invocation in a command string, one per shell segment. Comments are
 * blanked FIRST, then the quote-aware segmenter runs — so `gh pr create` inside
 * a comment or a quoted string is not mistaken for a live invocation.
 */
function parseGhInvocations(command) {
  const cleaned = stripShellComments(command);
  if (!cleaned.trim()) return [];
  const top = splitShellSegments(cleaned, { newlineSeparates: true });
  // Same nested-body expansion as the git twin. Measured before it landed:
  // `sh -c 'gh pr create --title x'` and `eval "gh pr merge 12 --admin"` both
  // returned `allow` from the mutation fence.
  const nested = expandNestedSegments(top);
  const out = [];
  for (const text of nested.segments) {
    const g = parseGhInvocation(text);
    if (g) out.push(g);
  }
  if (nested.unresolvable || nested.truncated) {
    out.push({
      group: null,
      sub: null,
      args: "",
      argv: [],
      unresolvable: "group",
    });
  }
  return out;
}

/**
 * The predicate a verb fence needs: does this command actually RUN
 * `gh <group> <sub>`? Both words are matched exactly against parsed POSITIONS,
 * which is what makes `gh pr create` distinct from `gh pr list --search create`
 * and from the string `"gh pr create"` echoed inside an argument.
 */
function findGhSubcommand(command, group, sub) {
  const wantGroup = String(group || "").toLowerCase();
  const wantSub = String(sub || "").toLowerCase();
  if (!wantGroup || !wantSub) return null;
  for (const g of parseGhInvocations(command)) {
    if (g.group === wantGroup && g.sub === wantSub) return g;
  }
  return null;
}

module.exports = {
  GIT_WRAPPERS,
  SHELL_C_WRAPPERS,
  UNRESOLVABLE_COMMAND_IDENTITY,
  isGitToken,
  looksLikeFusedGitToken,
  looksLikeFusedGhToken,
  dequote,
  stripShellComments,
  // Exported for the fidelity suites and for the corpus measurements that size
  // this module's false-positive surface: an approximation of the tokenizer
  // measures an approximation of the fence.
  tokenize,
  scanCommandPrefix,
  nestedCommandStrings,
  expandNestedSegments,
  parseGitInvocation,
  parseGitInvocations,
  findGitSubcommand,
  isGhToken,
  GH_VALUE_FLAGS,
  parseGhInvocation,
  parseGhInvocations,
  findGhSubcommand,
};
