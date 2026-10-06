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

const fs = require("fs");
const path = require("path");
const {
  splitShellSegments,
  maskDocCarrierPayloads,
  parseHeredocSpans,
  stripHeredocBodies,
} = require(path.join(__dirname, "violation-patterns.js"));

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
  // The builtins that run their operand as the command, as `command` does.
  // Measured before: `exec git commit -m x` parsed as no git invocation, and
  // `exec sh -c 'rm <state>'` / `builtin eval 'rm <state>'` passed the
  // state-file detector, because neither name was known to lead a command.
  "exec",
  "builtin",
  // GNU coreutils installed under the `g` program prefix (Homebrew, BSD ports).
  // Each is the same program as its unprefixed twin above. Measured before:
  // `gtimeout 5 git commit -m x` and `gnice -n 5 git commit -m x` parsed as no
  // git invocation, and `gnice sh -c 'rm <state>'` passed the state-file detector.
  "gtimeout",
  "gnice",
  "gnohup",
  "gstdbuf",
  "genv",
  // PREFIX RUNNERS — each parses its own options, then EXECs the command named in
  // its operands, exactly as `nice` and `taskset` do. Membership is all they need:
  // the git token sits where the wrapper scan already looks, and the state fence's
  // `nestedCommandStrings` shares this scan, so one entry closes BOTH fences.
  //
  // Measured on the pure functions with synthetic strings (nothing run) BEFORE
  // this block: `setarch x86_64 sh -c 'rm <state>'` returned null from
  // `detectStateFileMutationSegmentAware` and `setarch x86_64 git push --force`
  // parsed as NO git invocation, while `rm <state>` and `git commit -m x` on the
  // same tree returned `{layer:2,kind:"rm"}` and `commit`. Each name below
  // reproduced that pair; `taskset` did NOT, which is the control showing
  // membership is what decides it.
  //
  // util-linux setarch and its per-architecture aliases, which are the same
  // program invoked under another name (`linux32 <prog>` ≡ `setarch i386 <prog>`).
  // `setarch <arch> [-R -B -L -X -Z -T -F -I -v] <prog>` takes its options as
  // FLAGS only, so the arch operand is skipped by the wrapper-context rule.
  "setarch",
  "linux32",
  "linux64",
  "i386",
  "x86_64",
  // CPU/NUMA/namespace/cgroup placement. Each takes value-bearing options and
  // then an argv; a mis-read option value lands in front of the command word,
  // where the scan's own flag and wrapper-operand skips still reach it.
  "numactl",
  "nsenter",
  "unshare",
  "systemd-run",
  "cgexec",
  // Sandboxes and privilege/identity changers that exec an argv.
  "firejail",
  "bwrap",
  "proot",
  "fakeroot",
  "pkexec",
  "eatmydata",
  // Tracers and debuggers. `gdb --args <prog> <args>` is the argv form; the
  // interactive form runs nothing this scan can see, which fails toward silence.
  "strace",
  "ltrace",
  "dtruss",
  "valgrind",
  "gdb",
  // Display and network shims.
  "xvfb-run",
  "torsocks",
  "proxychains",
  "proxychains4",
  // Multi-call binaries: the applet name occupies the command slot, so the real
  // command is one word further along — the same shape as `env <prog>`. busybox
  // is ALSO a SHELL_BASENAMES member; `stopAt` is tested before this skip, so
  // `busybox sh -c '…'` still matches as a nesting token and is unaffected. The
  // nested-body walk and the shell reader both RE-ENTER on the applet
  // (2026-10-04, SEC-B-3) — as a TOKEN ARRAY, never a re-serialised string.
  "busybox",
  "toybox",
  // LOCAL ARGV-RUNNERS (fix round f, 2026-10-05): tmux/screen/entr/dbus-run-session
  // EXEC their trailing argv locally, but they were absent from every table — and
  // the walk-stop (round e) then resolved their SUBCOMMAND as the wrapped command
  // and returned before ever testing the real git token, so a destructive argv ran
  // while the CC fence returned allow (MEASURED: `sudo tmux new-session -d git
  // reset --hard HEAD` cc=0 on e vs base=2, likewise screen/entr). They are listed
  // here so the walk reaches their argv; their WRAPPER_GRAMMAR entry consumes
  // operands without ever resolving a command word (see the table).
  "tmux",
  "screen",
  "entr",
  "dbus-run-session",
  // f2: same argv-runner class (see the WRAPPER_GRAMMAR block).
  "systemd-nspawn",
  "machinectl",
  "setpriv",
  "softlimit",
  "daemonize",
  "faketime",
  "ts",
  "chpst",
  // round h (correctness review's residual sweep, MEASURED base resolves / g []):
  // the same exec-wrapper class, four more names. Every one EXECs its trailing
  // argv (documented; tools absent on macOS, present on Codex's Linux hosts).
  "authbind",
  "setuidgid",
  "envdir",
  "pgrphack",
  // round h2 (the FINAL constructive sweep, MEASURED base resolves / h []):
  // moreutils (ifne, lckdo, nq), daemontools (setlock), macOS (sandbox-exec).
  // All five EXEC their trailing argv. This class is closed by ENUMERATION,
  // not by construction — the reviewers' flagged property; the closure-by-
  // construction inversion is an operator decision, not a lane edit.
  "ifne",
  "lckdo",
  "nq",
  "setlock",
  "sandbox-exec",
]);

// THE ONE SHELL-NAME LIST (security ruling, 2026-10-03). Every reader of "is
// this word a shell?" imports THIS set — the Codex array adapter included (it
// previously carried its own SHELL_C_NAMES, which had already drifted: no
// toybox, no fish/csh/tcsh/yash/rbash). Matching is on the BASENAME,
// CASE-INSENSITIVELY, so `Bash`, `/bin/BASH` and `busybox sh` all read as
// shells. `busybox`/`toybox` are members because they ARE multicall shells; BOTH
// readers re-enter their walk on the applet word (2026-10-04, SEC-B-3), so
// `busybox watch …` reaches the watch grammar and `busybox sh -c …` the shell
// rules — as a token array, never a re-serialised string. `eval` is
// deliberately NOT a member: it is a BUILTIN whose operand semantics differ
// (it concatenates ALL operands), so it is handled alongside, not here.
const SHELL_BASENAMES = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "mksh",
  "ash",
  "hush",
  "fish",
  "csh",
  "tcsh",
  "yash",
  "rbash",
  "busybox",
  "toybox",
  "pwsh",
  "powershell",
]);

const basename = (t) => String(t).replace(/^.*\//, "");

/** Basename only, NEVER a full path: `/usr/bin/GIT` folds to `git`, `GITFOO`
 * does not fold to anything. NFKC-normalized so a compatibility spelling
 * (`ſh`) folds to the ASCII form (SEC-B-6), and a trailing `.exe` is folded
 * away (`pwsh.exe`, `bash.exe` — F4, 2026-10-04). */
const foldedBasename = (t) =>
  basename(String(t)).normalize("NFKC").toLowerCase().replace(/\.exe$/, "");

const isNestingCommandToken = (t) => {
  const b = foldedBasename(t);
  return b === "eval" || SHELL_BASENAMES.has(b);
};

// The `-c` operand is the command STRING a shell parses; the flag may be
// clustered (`-lc`, `-ec`) or bare (`-c`). RETAINED as the frozen sh-family
// clause: `shellCandidateIndexesLegacy` (the differential's pre-reader) uses it
// verbatim, and `SHELL_COMMAND_GRAMMAR` reuses it as its sh-family entry.
// Production readers consult the per-shell table, because this predicate alone
// is single-dash lowercase-`c` ONLY — it cannot see fish's `--command`/`-C`,
// PowerShell's case-insensitive `-Command…` prefixes, or the positional
// command of Windows PowerShell (security ruling 2026-10-04).
const isShellCFlag = (t) => t === "-c" || /^-[A-Za-z]*c[A-Za-z]*$/.test(t);

/** Multi-call binaries: the FIRST word after them names the applet
 * (`busybox sh -c BODY`), so the scan starts after it. Both `busybox` and
 * `toybox` ARE nesting tokens, so a scan that starts at the shell name must
 * skip the applet or the `-c` goes unseen. */
const MULTICALL_BINARIES = new Set(["busybox", "toybox"]);

/** Cost bound for re-entering the walk on a multicall applet (a literal
 * `busybox busybox …` chain terminates by token shrink alone; past the bound
 * the reading REFUSES rather than answering). */
const MULTICALL_HOP_BOUND = 8;

/** CLOSED PER-SHELL OPTION TABLES + the FAIL-CLOSED INVOCATION VERDICT
 * (security ruling 2026-10-04, round 3). The round-2 reader ENUMERATED dangerous
 * shapes, so every shape nobody listed was allowed; this one must POSITIVELY
 * account for every word before a shell's first operand. Option kinds:
 *   "flag"    — takes nothing.
 *   "value"   — consumes the rest of its cluster, its `=value`, or the next
 *               word; that word must itself be LITERAL.
 *   "command" — its operand is a command string (candidates).
 *   "opaque"  — its operand executes without being readable (PowerShell
 *               -EncodedCommand): REFUSES.
 * Over-inclusion in a flag/value set is SAFE — a wrongly-accepted word makes
 * the real shell error and run NOTHING — so the sets are unions of the shells'
 * documented invocation options. "Literal" = not `unexpandable` (no `$`,
 * backtick, or unquoted `{ } * ? [`) and no leading `~`; an UNKNOWN shell
 * grammar refuses. */
/** PER-SHELL SHORT TABLES, MEASURED against the real shells 2026-10-04
 * (`echo REACHED`):
 *   bash/sh : `-o`, `-O` take the NEXT WORD      (`bash -o pipefail -c B` → REACHED)
 *   zsh     : `-o` takes a value; `-O` is a FLAG  (`zsh -O extglob -c B` made
 *             `extglob` the SCRIPT operand; `zsh -O -o pipefail -c B` → REACHED)
 *   ksh     : `-o` takes the next word; `-O` is UNKNOWN (errors, runs nothing)
 *   dash    : `-o` is not invocable (errors, runs nothing) — read as a value
 *             option here; safe either way because nothing runs.
 *   fish    : ABSENT on this host — the FAIL-CLOSED reading applies (the
 *             command-letter scan below is the load-bearing part, not the table)
 *             and that is said here rather than implied.
 * THE TABLES ARE OVER-DENIAL REDUCERS ONLY (Tier-1, round 4): the
 * grammar-independent command-letter scan (rule b) and the every-literal-word
 * candidate rule (rule a) carry the detection, so a table mistake can never
 * hide a literal body. */
const SH_LONG_COMMON = {
  debug: "flag", debugger: "flag", "dump-po-strings": "flag",
  "dump-strings": "flag", emacs: "flag", help: "flag", "init-file": "value",
  login: "flag", noediting: "flag", "no-globalrcs": "flag", noprofile: "flag",
  "no-rcs": "flag", norc: "flag", posix: "flag", protected: "flag",
  rcfile: "value", restricted: "flag", verbose: "flag", version: "flag",
  vi: "flag",
};
const SH_SHORT_FLAGS = {
  a: "flag", b: "flag", d: "flag", e: "flag", f: "flag", g: "flag", h: "flag",
  i: "flag", k: "flag", l: "flag", m: "flag", n: "flag", p: "flag", r: "flag",
  s: "flag", t: "flag", u: "flag", v: "flag", w: "flag", x: "flag", y: "flag",
  B: "flag", C: "flag", D: "flag", E: "flag", F: "flag", G: "flag", H: "flag",
  K: "flag", P: "flag", R: "flag", T: "flag", V: "flag", X: "flag", Z: "flag",
};
const SH_OPTION = {
  short: { ...SH_SHORT_FLAGS, c: "command", o: "value", O: "value" }, // bash/sh (measured)
  long: SH_LONG_COMMON,
  plus: true, // `+x` / `+o name` forms are flags/value options too
  clusters: true,
  longPrefix: true, // getopt_long accepts any unambiguous prefix
};
const ZSH_OPTION = {
  short: { ...SH_SHORT_FLAGS, c: "command", o: "value", O: "flag" }, // O measured as a FLAG
  long: SH_LONG_COMMON,
  plus: true,
  clusters: true,
  longPrefix: true,
};
const KSH_OPTION = {
  short: { ...SH_SHORT_FLAGS, c: "command", o: "value", O: "flag" },
  long: SH_LONG_COMMON,
  plus: true,
  clusters: true,
  longPrefix: true,
};
const FALLBACK_SH_OPTION = {
  short: { ...SH_SHORT_FLAGS, c: "command", o: "value", O: "value" },
  long: SH_LONG_COMMON,
  plus: true,
  clusters: true,
  longPrefix: true,
};
const SH_FAMILY_TABLES = new Map([
  ["sh", SH_OPTION],
  ["bash", SH_OPTION],
  ["zsh", ZSH_OPTION],
  ["ksh", KSH_OPTION],
  ["mksh", KSH_OPTION],
  ["dash", FALLBACK_SH_OPTION],
  ["ash", FALLBACK_SH_OPTION],
  ["yash", FALLBACK_SH_OPTION],
  ["rbash", FALLBACK_SH_OPTION],
  ["hush", FALLBACK_SH_OPTION],
  ["csh", FALLBACK_SH_OPTION],
  ["tcsh", FALLBACK_SH_OPTION],
]);
const FISH_OPTION = {
  short: {
    c: "command", C: "command", d: "value", h: "flag", i: "flag", l: "flag",
    n: "flag", N: "flag", p: "value", P: "flag", v: "flag",
  },
  long: {
    command: "command", "init-command": "command", debug: "value",
    features: "value", help: "flag", interactive: "flag", login: "flag",
    "no-config": "flag", "no-execute": "flag", private: "flag",
    profile: "value", version: "flag",
  },
  plus: false,
  clusters: true,
  longPrefix: true,
};
/** PowerShell parameters: case-insensitive UNAMBIGUOUS prefixes, single or
 * double dash, `-Name:value` / `-Name=value` attached forms. `command` /
 * `commandwithargs` run their operand JOINED (SEC-B-4b); `encodedcommand`
 * executes without being readable (SEC-B-4a); `file` and the value entries
 * consume — the file is the named script residual. An AMBIGUOUS prefix (bare
 * `-c` collides Command/ConfigurationName; `-e` collides
 * EncodedCommand/ExecutionPolicy) makes the real shell error and run NOTHING,
 * and is refused here rather than guessed. */
const PW_PARAMS = {
  command: "command", commandwithargs: "command", encodedcommand: "opaque",
  configurationname: "value", executionpolicy: "value", file: "value",
  inputformat: "value", outputformat: "value", settingsfile: "value",
  windowstyle: "value", workingdirectory: "value",
  help: "flag", login: "flag", mta: "flag", noexit: "flag", nologo: "flag",
  noninteractive: "flag", noprofile: "flag", sta: "flag", version: "flag",
};

/** "Literal" — the shell runs exactly this word (SEC-B-1/B-2). */
const isLiteralWord = (tok) =>
  !!tok && tok.unexpandable !== true && !/^~/.test(String(tok.value));

/** Rule (c): the script-run operand must LOOK LIKE A PATH — it contains a path
 * separator or ends in a script extension. `bash ./run.sh "$HOME"` stays
 * allowed; `bash setup "$HOME"` refuses (accepted over-denial, reported). */
const SCRIPT_EXT_RX = /\.[A-Za-z0-9]{1,5}$/;
const looksLikePathOperand = (v) => {
  const s = String(v);
  return /[\\/]/.test(s) || SCRIPT_EXT_RX.test(s);
};

const UNRESOLVABLE_VERDICT = Object.freeze({ kind: "unresolvable" });
const SCRIPT_VERDICT = Object.freeze({ kind: "script" });

/** Parse ONE option word under a CLOSED table. Returns `{ command,
 * consumedNextWord }`, the string "opaque", or undefined (unknown/ambiguous/
 * unreadable — the caller REFUSES). Measured 2026-10-04 on bash/dash/zsh: an
 * ATTACHED body after `-c` is not a real form (all three ERROR, running
 * nothing), so letters after `c` in a cluster stay OPTION letters and the `-c`
 * body is always the first operand. */
function parseOptionWord(v, g) {
  if (v.startsWith("--")) {
    const eq = v.indexOf("=");
    const name = (eq === -1 ? v.slice(2) : v.slice(2, eq)).toLowerCase();
    const kind = g.longPrefix
      ? resolveLongOption(name, g.long)
      : hasOwn(g.long, name)
        ? g.long[name]
        : undefined;
    if (kind === undefined) return undefined;
    if (kind === "opaque") return "opaque";
    if (kind === "command") return { command: true, consumedNextWord: false, attachedBody: eq === -1 ? null : v.slice(eq + 1) };
    if (kind === "value") return { command: false, consumedNextWord: eq === -1 };
    return eq === -1 ? { command: false, consumedNextWord: false } : undefined; // `--flag=value`: not a real form
  }
  const word = v.slice(1);
  if (word === "") return { command: false, consumedNextWord: false }; // a lone "-"
  if (!g.clusters) {
    const kind = hasOwn(g.short, word) ? g.short[word] : undefined;
    if (kind === undefined) return undefined;
    if (kind === "opaque") return "opaque";
    if (kind === "command") return { command: true, consumedNextWord: false };
    if (kind === "value") return { command: false, consumedNextWord: true };
    return { command: false, consumedNextWord: false };
  }
  let command = false;
  for (let k = 0; k < word.length; k++) {
    const kind = hasOwn(g.short, word[k]) ? g.short[word[k]] : undefined;
    if (kind === undefined) return undefined; // an unknown letter in the cluster: refuse
    if (kind === "flag") continue;
    if (kind === "opaque") return "opaque";
    if (kind === "command") {
      if (command) return undefined; // two command letters in one cluster: not a real form
      command = true;
      continue;
    }
    // "value": the rest of the cluster is the attached value, else the next word.
    return { command, consumedNextWord: k + 1 === word.length };
  }
  return { command, consumedNextWord: false };
}

/** The VERDICT for a sh-family / fish invocation (grammar-independent detection,
 * Tier-1 round 4). THREE rules, in priority order:
 *   (a) EVERY literal later word is ALWAYS a candidate body — whatever the
 *       option tables say — so a table mistake can never hide a literal body.
 *   (b) ANY option word in the pre-operand region that CONTAINS a command
 *       letter for this shell (sh-family `c`, fish `c`/`C`) puts the call in
 *       COMMAND MODE; the text after the letter, if any, is ALSO a candidate.
 *       In command mode any unexpandable word means REFUSE.
 *   (c) An unexpandable word is TOLERATED only in a SCRIPT RUN: no command
 *       letter anywhere in the pre-operand region AND the first operand is a
 *       literal that looks like a path. Region unexpandables and an unreadable
 *       or non-path operand REFUSE. `bash ./run.sh "$HOME"` stays allowed;
 *       `bash -o pipefail ./x.sh "$HOME"` may refuse (accepted cost, reported).
 * The MEASURED tables only reduce over-denial inside this skeleton. */
function shellInvocationVerdict(g, later, commandLetters, opts = {}) {
  let sawCommandLetter = false;
  let bodyTaken = -1; // index in `later` of the FIRST parameter word (body consumed)
  let pendingBodyWord = -1; // index of a bare command flag whose NEXT word is the body
  let sawNoExec = false; // a short `-n` cluster: the shell parses without executing
  const attachedBodies = [];
  let i = 0;
  for (; i < later.length; i += 1) {
    const tok = later[i];
    const v = String(tok.value);
    if (v === "--") {
      i += 1;
      break;
    }
    const optionish = v.startsWith("-") || (g.plus && v.startsWith("+"));
    if (!optionish) break; // the first operand
    // (c): unreadable in the option region. Same f2 class as the opaque-word
    // refusal below: `sh -$OPTS -c 'git reset --hard HEAD'` measured base
    // resolving the literal body, so a later literal body behind a recognised
    // command letter rides WITH the mark rather than being dropped.
    if (tok.unexpandable) return lateBodyVerdict() || UNRESOLVABLE_VERDICT;
    // NOEXEC (Tier-1 round 5, over-denial): a short cluster containing `n` —
    // POSIX sh-family `-n` and fish `-n`/--no-execute — makes the shell READ
    // WITHOUT EXECUTING, so no `-c` body and no script operand can run:
    // `bash -n file.sh`, `sh -nc 'text'` are syntax checks. The letter is read
    // through the TABLE so a value cluster cannot smuggle it (`-Onoglob` stops
    // at the value kind before reaching `n`), only a plain flag counts, `+n`
    // turns it back off (POSIX option semantics), and long forms stay
    // unmodelled (fail closed).
    if (!v.startsWith("--") && (v.startsWith("-") || v.startsWith("+"))) {
      const onForm = v.startsWith("-");
      const cluster = v.replace(/^[-+]+/, "");
      for (let k = 0; k < cluster.length; k += 1) {
        const kind = hasOwn(g.short, cluster[k]) ? g.short[cluster[k]] : undefined;
        if (kind !== "flag" && kind !== "command") break;
        if (cluster[k] === "n" && kind === "flag") sawNoExec = onForm;
      }
    }
    const word = v.replace(/^[-+]+/, "");
    const shortForm = !v.startsWith("--");
    // (b) THE GRAMMAR-INDEPENDENT LETTER SCAN. The after-letter TEXT is
    // harvested only from SHORT forms (`-cd;…`, `-oc` clusters); a LONG option
    // name (`--command`) contains the letter as part of the NAME, not as an
    // attached body.
    for (let k = 0; k < word.length; k += 1) {
      if (commandLetters.includes(word[k])) {
        sawCommandLetter = true;
        const rest = word.slice(k + 1);
        if (rest && shortForm) attachedBodies.push(rest);
      }
    }
    // A command letter acts as a BARE command flag only when it ENDS the
    // cluster and every letter before it is a plain flag: `-lc` yes, `-oc` NO
    // (`o`'s value swallows the rest — which is why the MEASURED
    // `sh -oc pipefail -c BODY` line keeps its body among the candidates and
    // must not be position-narrowed). Only this shape lets the NEXT word be
    // KNOWN, structurally, as the command string.
    pendingBodyWord = -1;
    if (shortForm) {
      for (let k = 0; k < word.length; k += 1) {
        const kind = hasOwn(g.short, word[k]) ? g.short[word[k]] : undefined;
        if (kind === "command" && k === word.length - 1) {
          pendingBodyWord = i;
          break;
        }
        if (kind !== "flag") break;
      }
    }
    const parsed = parseOptionWord(v, g);
    // An opaque option word (`-${OPTS}`) refuses — but a later literal body
    // behind a recognised command letter still rides WITH the mark (round f2,
    // same class as 5c): base extracted that body and the CC path reads the
    // bare mark as advisory, so refusing with no candidates downgraded a block.
    if (parsed === undefined || parsed === "opaque") return lateBodyVerdict() || UNRESOLVABLE_VERDICT;
    if (parsed.command && parsed.attachedBody) {
      attachedBodies.push(parsed.attachedBody);
      // The body rode INSIDE the option token: everything AFTER this token is
      // a positional parameter.
      bodyTaken = i + 1;
    }
    if (parsed.consumedNextWord) {
      const val = later[i + 1];
      if (!val) return SCRIPT_VERDICT; // a value option with no value: the shell errors, nothing runs
      // The value-literal check (`bash -o $X` splits into a real -c). Same f2
      // class as above: an unreadable VALUE may hide the whole option region,
      // so a later literal `-c` body still rides WITH the refusal.
      if (!isLiteralWord(val)) return lateBodyVerdict() || UNRESOLVABLE_VERDICT;
      i += 1;
      if (parsed.command) {
        // A command option that CONSUMES its operand: the words after the
        // consumed value are positional parameters.
        bodyTaken = i + 1;
        break;
      }
    }
  }
  if (sawNoExec) {
    // Nothing executes under `-n`: neither the file operand nor a `-c` string.
    return { kind: "script", candidates: [] };
  }
  // COMMAND MODE WITHOUT AN ATTACHED OR CONSUMED BODY: when the option region's
  // LAST word was a bare command flag (`-c`, `-lc`) and the loop broke AT the
  // word directly after it, that first OPERAND is the body by construction —
  // everything AFTER it is a positional PARAMETER ($0, $1, …), never another
  // body, even when it starts with `-` or is an expansion: `sh -c 'body'
  // "$SP"` is a launch with a parameter, and reading `"$SP"` as a candidate
  // body refused it (Tier-1 round 5). Every uncertain region keeps the
  // previous all-literals-candidates reading (`sh -oc pipefail -c BODY`).
  if (sawCommandLetter && bodyTaken === -1 && pendingBodyWord !== -1 && pendingBodyWord === i - 1 && i < later.length) {
    bodyTaken = i + 1;
  }
  const paramsFrom = bodyTaken === -1 ? later.length : bodyTaken;
  const head = later.slice(0, paramsFrom);
  const operand = later[i];
  const anyUnexpandable = head.some((t) => t.unexpandable);
  const literals = head.filter((t) => !t.unexpandable);
  if (sawCommandLetter) {
    const candidates = attachedBodies
      .filter((b) => b !== "")
      .map((b) => ({ value: b, unexpandable: false }))
      .concat(literals);
    if (anyUnexpandable) {
      // (b): command mode refuses unreadables. Candidates ride WITH the refusal
      // only when one is a POSITIVELY-RECOGNISED BODY — an attached body, or a
      // literal word consumed as the body. The measured narrowing (round f2):
      // `sh -c $FLAGS BODY` reaches here with head [-c, $FLAGS(u)] and would
      // otherwise ship a bare flag word as "candidate"; base shipped NO
      // candidates on that shape and `-c` is inert as a command, so shipping it
      // is pure noise. Shapes where base DID extract a literal body —
      // `sh $FLAGS -c 'git reset --hard HEAD'` — never reach this arm: the
      // unreadable first operand refuses at the SCRIPT-RUN check and the body
      // rides via lateBodyVerdict(). Same contract as the module's note one
      // level up: an unexpandable candidate keeps the fail-closed mark AND
      // does not suppress a POSITIVELY-RECOGNISED sibling.
      const bodyTok = bodyTaken !== -1 ? later[bodyTaken - 1] : null;
      const bodyIsRecognised = attachedBodies.some((b) => b !== "")
        || (bodyTok && !bodyTok.unexpandable && isLiteralWord(bodyTok));
      // NO recognised body: still try the late scan before refusing (round g
      // security review, F2). `sh +c $FLAGS -c 'git reset --hard HEAD'`: the
      // unexpandable operand misassigns `bodyTaken` past the real `-c` body,
      // and this refusal point was the ONE not wired to lateBodyVerdict() —
      // base resolved `reset` there, g went advisory on the CC path. The late
      // scan's own result already carries `unresolvable: true`; when it finds
      // nothing (e.g. `sh -c $FLAGS BODY`, whose body position is the
      // unreadable word) this still returns the bare fail-closed mark.
      if (!bodyIsRecognised) return lateBodyVerdict() || UNRESOLVABLE_VERDICT;
      return { kind: "command", candidates, unresolvable: true };
    }
    return { kind: "command", candidates };
  }
  if (!operand) {
    if (anyUnexpandable) return lateBodyVerdict() || UNRESOLVABLE_VERDICT;
    return { kind: "script", candidates: literals }; // (a)
  }
  // (c) SCRIPT RUN definition.
  // An UNREADABLE operand refuses outright — the content is unknowable no
  // matter how the shell word was reached.
  if (!isLiteralWord(operand)) {
    return lateBodyVerdict() || UNRESOLVABLE_VERDICT;
  }
  // A non-path literal operand refuses EXCEPT on the inversion foot, where the
  // shell word may be an argument of an unknown launcher rather than a command
  // (`command grep -rln 'fish' .`): base and h2 allowed every wrapper spelling
  // of that shape because their walk stopped before the shell word. The
  // tolerance applies ONLY here — command-mode refusals and unreadable operands
  // above are untouched, so the fail-closed surface the rounds 4/5 closed is
  // unchanged. `bash setup "$HOME"` typed in true command position still
  // refuses (accepted over-denial, unchanged).
  if (!looksLikePathOperand(operand.value) && !opts.tolerateNonPathScriptOperand) {
    return lateBodyVerdict() || UNRESOLVABLE_VERDICT;
  }
  return { kind: "script", candidates: literals }; // post-operand unexpandables are $0/$args: tolerated

  // LATE BODY SCAN (round f2, correctness review 5c): an unexpandable word can
  // occupy the FIRST OPERAND position and hide the option region behind it
  // (`sh $FLAGS -c 'git reset --hard HEAD'` — `$FLAGS` may itself BE `-c`), so
  // the call is about to refuse. Base extracted the literal body there; refusing
  // with NO candidates downgraded a cc=2 block to a bare halt-mark. So before
  // any refusal, harvest a literal operand that DIRECTLY follows a short option
  // word whose last letter is this shell's command letter, anywhere later in the
  // words — the body rides WITH the fail-closed mark.
  function lateBodyVerdict() {
    const candidates = [];
    for (let k = 0; k < later.length - 1; k += 1) {
      const w = String(later[k].value);
      // PLUS-FORMS (round h3, security review's measured patch): `+c BODY` is a
      // real sh/dash/bash form that RUNS BODY (the main loop's own rule is
      // `optionish = - || (g.plus && +)`); testing only `-` missed the whole
      // plus family. MEASURED on their 10104-row sweep: +4572 resolved, 0 lost.
      if ((!w.startsWith("-") && !(g.plus && w.startsWith("+"))) || w.startsWith("--")) continue;
      const letters = w.replace(/^[-+]+/, "");
      // ANY letter in a short cluster may be the command letter: `-ce` is
      // `-c -e`, and MEASURED (round g security review, F1) sh/dash/bash/ksh/zsh
      // all RUN the `-c` body of `-ce` — likewise -cx/-cv/-cl/-cE. Testing only
      // the LAST letter dropped the body and downgraded a cc=2 block to an
      // advisory on the CC path, with five consumers measured regressed.
      if (![...letters].some((ch) => commandLetters.includes(ch))) continue;
      const val = commandOperandFrom(k);
      if (val) candidates.push({ value: String(val.value), unexpandable: false });
      // Base over-approximation KEPT: when the command word itself ends in a
      // value option, base read the consumed word as the body (`-co BODY`
      // errors in dash/bash and runs NOTHING, so that word is noise — but
      // shipping it costs nothing and keeps this reader >= base).
      const consumed = consumedValueWord(k);
      if (consumed) candidates.push({ value: String(consumed.value), unexpandable: false });
    }
    return candidates.length ? { kind: "command", candidates, unresolvable: true } : null;

    // ROUND-i RESIDUAL (rev-g-sec): the command string is the first OPERAND
    // after the command-letter word. MEASURED (dash/bash/ksh): -c -e BODY,
    // -c -x BODY, -c -- BODY, -c - BODY, -c -o pipefail BODY and
    // -c -e -x BODY all RUN BODY; -c -Q BODY (unknown letter) errors and
    // runs NOTHING. So: skip the shell-own option words (closed table; a
    // trailing value letter consumes its value) and the - and -- terminators;
    // an unreadable or unknown word STOPS the walk with no candidate
    // (fail closed — the refusal already rides). Measured on the reviewer's
    // 5208-row sweep3: 0 rows lost vs base, 0 vs round h, +2304 gained vs base.
    function commandOperandFrom(from) {
      let j = from;
      while (j < later.length) {
        const t = later[j];
        const v = String(t.value);
        if (v === "--" || v === "-") { j += 1; break; }
        if ((!v.startsWith("-") && !(g.plus && v.startsWith("+"))) || v.startsWith("--")) break; // round h3: plus-forms are optionish (see the scan-start note)
        if (t.unexpandable) return null;
        const letters = v.replace(/^[-+]+/, "");
        if (!letters.length) break;
        let skip = 1;
        let ok = true;
        for (let m = 0; m < letters.length; m += 1) {
          const kind = hasOwn(g.short, letters[m]) ? g.short[letters[m]] : undefined;
          if (kind === "flag" || kind === "command") continue;
          if (kind === "value" && m + 1 === letters.length) { skip = 2; break; }
          if (kind === "value") break;
          ok = false;
          break;
        }
        if (!ok) return null;
        j += skip;
      }
      const val = later[j];
      return val && isLiteralWord(val) && String(val.value).trim() ? val : null;
    }

    // The word a trailing value option on the START word consumes (`-co X`):
    // base read that word as a body; keep it as an extra candidate.
    function consumedValueWord(from) {
      const letters = String(later[from].value).replace(/^[-+]+/, "");
      for (let m = 0; m < letters.length; m += 1) {
        const kind = hasOwn(g.short, letters[m]) ? g.short[letters[m]] : undefined;
        if (kind === "flag" || kind === "command") continue;
        if (kind === "value" && m + 1 === letters.length) {
          const w = later[from + 1];
          return w && isLiteralWord(w) && String(w.value).trim() ? w : null;
        }
        return null;
      }
      return null;
    }
  }
}

/** A PowerShell command body: ALL the remaining words JOINED into ONE string
 * (SEC-B-4b) that is evaluated as a string, not word by word. Every joined word
 * must be literal — an unreadable element refuses. */
function pwshJoinVerdict(rest, attached) {
  const restToks = rest || [];
  for (const t of restToks) if (!isLiteralWord(t)) return UNRESOLVABLE_VERDICT;
  const parts = (attached !== null && attached !== "" ? [attached] : []).concat(
    restToks.map((t) => String(t.value)),
  );
  const text = parts.join(" ");
  if (!text.trim()) return SCRIPT_VERDICT;
  return { kind: "command", candidates: [{ value: text, unexpandable: false }, ...restToks] };
}

/** The VERDICT for pwsh/powershell (SEC-B-4): an encoded body is opaque, a
 * command parameter joins its rest, the positional first operand is a command
 * too (Windows PowerShell's positional -Command), and an unknown or ambiguous
 * prefix refuses. */
function pwshVerdict(later) {
  for (let i = 0; i < later.length; i += 1) {
    const tok = later[i];
    // F4 (Tier-1, 2026-10-04): the Unicode dashes (en `–`, em `—`, horizontal
    // bar `―`) and the `/` prefix are PowerSHell SWITCH spellings — normalise
    // them to `-` before any parameter decision. Encoded commands refuse in
    // EVERY spelling (the `.exe` fold lives in `foldedBasename`).
    const v = String(tok.value).replace(/^[/–—―]/, "-");
    if (v === "--") return pwshJoinVerdict(later.slice(i + 1), null);
    if (!v.startsWith("-")) return pwshJoinVerdict(later.slice(i), null); // positional command
    if (tok.unexpandable) return UNRESOLVABLE_VERDICT;
    const m = /^-{1,2}([^:=]+)(?:[:=]([\s\S]*))?$/.exec(v);
    if (!m || m[1] === "") return UNRESOLVABLE_VERDICT;
    const name = m[1].toLowerCase();
    // An EXACT parameter name wins outright (PowerShell binds it); only a
    // non-exact name goes through unambiguous-prefix resolution.
    let kind;
    if (hasOwn(PW_PARAMS, name)) kind = PW_PARAMS[name];
    else if (name === "c") {
      // DOCUMENTED alias of -Command (PowerShell's parameter docs), NOT
      // measured — pwsh is absent on this host, so this is the documented
      // reading; the bare `-c` binds the command and its rest JOINS.
      kind = "command";
    } else {
      const hits = Object.keys(PW_PARAMS).filter((k) => k.startsWith(name));
      kind = hits.length === 1 ? PW_PARAMS[hits[0]] : undefined;
    }
    if (kind === undefined) return UNRESOLVABLE_VERDICT; // unknown OR ambiguous prefix: refuse
    const attached = m[2] !== undefined ? m[2] : null;
    if (kind === "opaque") return UNRESOLVABLE_VERDICT; // SEC-B-4a
    if (kind === "command") return pwshJoinVerdict(later.slice(i + 1), attached); // SEC-B-4b
    if (kind === "flag") {
      if (attached !== null) return UNRESOLVABLE_VERDICT; // `-flag=value`: not a real form
      continue;
    }
    if (attached !== null) continue; // value/file, attached
    const val = later[i + 1];
    if (!val) return SCRIPT_VERDICT; // a value parameter with no value: nothing runs
    if (!isLiteralWord(val)) return UNRESOLVABLE_VERDICT;
    i += 1;
  }
  return SCRIPT_VERDICT;
}
const SH_FAMILY_BASENAMES = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "mksh",
  "ash",
  "hush",
  "csh",
  "tcsh",
  "yash",
  "rbash",
]);

/** EVERY candidate body of a command-position shell wrapper — FAIL-CLOSED BY
 * CONSTRUCTION (security ruling 2026-10-04, round 3). The reader POSITIVELY
 * recognises the invocation or REFUSES; it no longer enumerates dangerous
 * shapes. Strip `GIT_WRAPPERS` launchers; if the next word is a shell name
 * (basename, case-insensitive, NFKC), re-enter on multicall applets as a TOKEN
 * ARRAY (SEC-B-3), then decide with the CLOSED per-shell tables above:
 *
 *   SCRIPT-RUN (no candidates, allowed) — every word before the first operand
 *     is a LITERAL the shell's closed option table accounts for (option
 *     arguments consumed per the table, and literal too) AND the first operand
 *     is literal. The named residual: the operand names a FILE this reader
 *     does not open.
 *   COMMAND (candidates) — a command option (`sh -c`, fish `-c`/`-C`/
 *     `--command`/`--init-command`, PowerShell `-Command…`/positional) with a
 *     literal body; every later word rides along (recorded over-denial).
 *   UNRESOLVABLE (refuse) — EVERYTHING ELSE: an unknown option, a non-literal
 *     word in the option region or at the first operand, PowerShell
 *     `-EncodedCommand`, a multicall chain past its hop bound, an unknown
 *     shell grammar.
 *
 * RETURNS `{ candidates, shellAt, unresolvable }` where each candidate is the
 * INPUT token object (`{ value, unexpandable }`). The Codex array adapter
 * refuses the whole call on `unresolvable` (`shellWrapperBody`); the string
 * side folds it into its own return.
 *
 * `shellCandidateIndexesLegacy` below is the round-1 reader, kept ONLY for the
 * old-vs-new differential; its ⊇ premise is RETIRED where this ruling flips an
 * over-approximation (`bash script.sh -c BODY` is SCRIPT-RUN now) — see the
 * tests. */
function shellCandidateBodies(words, opts = {}) {
  const toks = (words || []).map((w) =>
    w && typeof w === "object"
      ? { value: String(w.value == null ? "" : w.value), unexpandable: w.unexpandable === true }
      : { value: String(w == null ? "" : w), unexpandable: false },
  );
  // ONE LAUNCHER MODEL: the prefix walk IS `scanCommandPrefix` (which words are
  // transparent prefixes = ONE list, `GIT_WRAPPERS`, in ONE implementation).
  const isShellTok = (tok) => SHELL_BASENAMES.has(foldedBasename(tok.value));
  const scan = scanCommandPrefix(toks, isShellTok);
  if (scan.kind !== "match") return { candidates: [], shellAt: -1, unresolvable: false };
  // INVERSION FOOT (operator-ratified fix, 2026-10-05): the shell word may be
  // the ARGUMENT of an unknown launcher the walk passed (`command grep -rln
  // 'fish' .`), not a command. Two routes reach here: the scan's own flag (the
  // caller passed the whole command, wrapper included) or the explicit option
  // (`nestedCommandStrings` re-enters on a SLICE starting AT the shell, so its
  // slice-local scan cannot see the wrapper the OUTER scan already passed).
  const tolerateNonPathScriptOperand =
    opts.tolerateNonPathScriptOperand === true || scan.sawUnknownCommandWord === true;
  // MULTICALL APPLET RE-ENTRY (SEC-B-3): the applet word is the real command,
  // and the walk re-enters ON THE TOKEN ARRAY — never a re-serialised string,
  // which lost quoting and let `busybox env "X=$Y'" sh -c BODY` through.
  let shellIdx = scan.idx;
  for (let hops = 0; hops < MULTICALL_HOP_BOUND; hops += 1) {
    if (!MULTICALL_BINARIES.has(foldedBasename(toks[shellIdx].value))) break;
    const applet = toks[shellIdx + 1];
    if (!applet) return { candidates: [], shellAt: shellIdx, unresolvable: false }; // a bare multicall binary
    if (applet.unexpandable || String(applet.value).startsWith("-")) {
      // busybox's own flags are not modelled, and an applet produced by an
      // expansion is opaque: both refuse.
      return { candidates: [], shellAt: shellIdx, unresolvable: true };
    }
    const rescan = scanCommandPrefix(toks.slice(shellIdx + 1), isShellTok);
    if (rescan.kind !== "match") return { candidates: [], shellAt: -1, unresolvable: false }; // e.g. `busybox watch …` — the nested-body walk owns it
    shellIdx += 1 + rescan.idx;
  }
  if (MULTICALL_BINARIES.has(foldedBasename(toks[shellIdx].value))) {
    return { candidates: [], shellAt: shellIdx, unresolvable: true }; // hop bound: refuse
  }
  const shellName = foldedBasename(toks[shellIdx].value);
  const later = toks.slice(shellIdx + 1);
  if (!later.length) return { candidates: [], shellAt: shellIdx, unresolvable: false }; // a bare shell: interactive
  // THE VERDICT — fail-closed by construction: SCRIPT-RUN needs positive
  // recognition of every word, COMMAND needs a literal body, everything else
  // refuses. An UNKNOWN shell grammar refuses too (SHELL_BASENAMES growing
  // without a table entry is a defect, and it lands loudly here).
  let verdict;
  if (shellName === "pwsh" || shellName === "powershell") verdict = pwshVerdict(later);
  else if (shellName === "fish") verdict = shellInvocationVerdict(FISH_OPTION, later, ["c", "C"], { tolerateNonPathScriptOperand });
  else if (SH_FAMILY_BASENAMES.has(shellName)) {
    verdict = shellInvocationVerdict(SH_FAMILY_TABLES.get(shellName) || FALLBACK_SH_OPTION, later, ["c"], { tolerateNonPathScriptOperand });
  } else return { candidates: [], shellAt: shellIdx, unresolvable: true };
  if (verdict.kind === "script") return { candidates: verdict.candidates || [], shellAt: shellIdx, unresolvable: false };
  if (verdict.kind === "unresolvable") return { candidates: [], shellAt: shellIdx, unresolvable: true };
  // The verdict's OWN unresolvable flag rides through (round f2): a command-mode
  // verdict may carry both candidates AND the fail-closed mark.
  return { candidates: verdict.candidates, shellAt: shellIdx, unresolvable: verdict.unresolvable === true };
}

// (LAUNCHER_BASENAMES DELETED 2026-10-04: the reader rides `GIT_WRAPPERS` via
// `scanCommandPrefix` — ONE launcher list, per the ruling. See shellCandidateBodies.)

// (isLauncherCruft DELETED 2026-10-04: operand skipping is the shared
// scanCommandPrefix walk's own sawWrapper branch. ONE model.)

/** The PREVIOUS reader (candidate-union with `-c` required), kept for the
 * old-vs-new differential the ruling requires. NOT called by any production
 * path — the differential test imports it under its own name. */
function shellCandidateIndexesLegacy(argv) {
  const wrapper = argv.length ? basename(argv[0]) : "";
  const start = MULTICALL_BINARIES.has(wrapper) && argv.length > 1 && !String(argv[1]).startsWith("-") ? 2 : 1;
  let sawC = false;
  let endOptions = false;
  for (let i = start; i < argv.length && !sawC; i += 1) {
    const token = argv[i];
    if (endOptions) continue; // after `--` nothing is a flag
    if (token === "--") { endOptions = true; continue; }
    if (token.length > 1 && (token.startsWith("-") || token.startsWith("+"))) {
      if (isShellCFlag(token)) sawC = true;
    }
  }
  if (!sawC) return [];
  const candidates = [];
  for (let i = start; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") continue;
    if (token.length > 1 && (token.startsWith("-") || token.startsWith("+"))) continue;
    candidates.push(i);
  }
  return candidates;
}

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

// Folded through the ONE helper (security ruling 2026-10-04): `GIT`, `Git` and
// `/usr/bin/GIT` are the git token exactly as the lowercase spelling is —
// `GITFOO` is not (basename equality, never a substring).
const isGitToken = (t) => foldedBasename(String(t).replace(/^\\/, "")) === "git";

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
  /^\\?(?:[^\s]*\/)?git(?![A-Za-z0-9_.-])/i.test(tok.value);

const looksLikeFusedGhToken = (tok) =>
  !!tok &&
  tok.unexpandable === true &&
  /^\\?(?:[^\s]*\/)?gh(?![A-Za-z0-9_.-])/i.test(tok.value);

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
 * The DISPATCH SURFACE of a command: the text that can hold a command WORD,
 * with the text that provably cannot removed. Two removals, one order:
 *
 *   1. HEREDOC BODIES — `stripHeredocBodies`, the shared separator in
 *      `violation-patterns.js`. Which forms it strips and which it deliberately
 *      still matches (an UNQUOTED body carrying `$` or a backtick is RETAINED,
 *      because bash runs `$(…)` while building it) is documented there, ONCE.
 *   2. SHELL COMMENTS — `stripShellComments`, unchanged.
 *
 * WHY THIS FUNCTION EXISTS RATHER THAN A SECOND `stripShellComments` CALL.
 * `parseGitInvocations` and `parseGhInvocations` are the two entry points every
 * git/gh verb fence in this repo dispatches through — the stranding guard, the
 * destructive-op fences, the posture mutation fence, the CI-check/merge guard.
 * Each opened with `stripShellComments` and then split on newlines, so a heredoc
 * BODY line arrived at command position and a fixture that WROTE `git worktree
 * remove . --force` was read as a command that RAN it. Three detectors, one
 * cause. Making both parsers share ONE normalization is the convergence the fix
 * belongs at (`security.md` § Enforcement-Surface Parity): the next time this
 * surface is hardened, both learn it, and neither can grow a private lineage.
 *
 * ORDER IS LOAD-BEARING. Bodies first: a `#` inside a heredoc body is literal
 * text, and blanking from it to end-of-line first would delete body bytes that
 * the heredoc parser then needs to match its close line against, desyncing the
 * close and swallowing the real commands after it into a phantom body.
 */
function dispatchSurface(command) {
  return stripShellComments(stripHeredocBodies(command));
}

/**
 * Shell RESERVED WORDS that can sit in front of a command in a compound
 * command, plus the function-definition prefix that does the same.
 *
 * WHY THESE ARE A DISGUISE AND NOT PROSE. A reserved word is reserved ONLY in
 * command position, so a segment whose FIRST word is one of these is a segment
 * whose REAL command sits one word further along — exactly the shape
 * `stripShellGroupDelimiters` already exists to reach for `(` / `{`. It was
 * reaching only the bracket forms, so `(git reset --hard HEAD)` blocked while
 * the equivalent compound-command spellings were invisible.
 *
 * MEASURED on a genuinely dirty tree, with the bare spelling as the positive
 * control in the same run (`git reset --hard HEAD` -> rc=2 BLOCK), so each rc=0
 * below is attributable to the leading token and not to a dead instrument:
 *
 *   if true; then git reset --hard HEAD; fi   -> rc=0   (the command RUNS)
 *   for i in 1; do git reset --hard HEAD; done-> rc=0   (the command RUNS)
 *   while true; do git reset --hard HEAD; done-> rc=0   (the command RUNS)
 *   f() { git reset --hard HEAD; }; f         -> rc=0   (the command RUNS)
 *   function f { git reset --hard HEAD; }; f  -> rc=0   (the command RUNS)
 *
 * and the negative controls show the boundary is real rather than a blanket
 * widening: `git commit -m 'git reset --hard HEAD'` and a heredoc body carrying
 * the same text BOTH stay rc=0, because neither puts the verb in a command slot.
 *
 * SCOPED TO THE WORD AT POSITION 0, which is precisely where bash reserves them.
 * A `then` in argument position (`echo then`) is an ordinary word and is never
 * touched, and a command that merely shares the name (`./then`) is a different
 * token. That is the same position-0-only discipline the bracket stripping above
 * documents, for the same reason: a global delete would edit the inside of a
 * substitution and turn a fail-CLOSED unresolvable verdict into a silent allow.
 *
 * `time` is deliberately NOT a member. It is a reserved word AND a wrapper, and
 * `GIT_WRAPPERS` already carries it; stripping it here as well would be a second
 * mechanism for one fact (security.md § Enforcement-Surface Parity, inverted).
 */
const LEADING_RESERVED_WORDS = new Set([
  "!",
  "if",
  "then",
  "elif",
  "else",
  "while",
  "until",
  "for",
  "do",
  "done",
  "fi",
  "esac",
  "case",
  "select",
  "coproc",
  "in",
]);

// `function f`, `function f()`, `f()`, and the space-before-paren spelling
// `f ()` that bash also accepts. Anchored at position 0 — see above.
const FUNCTION_DEF_BARE = /^[A-Za-z_][A-Za-z0-9_.]*\s*\(\s*\)\s*/;
const FUNCTION_DEF_KEYWORD = /^function\s+[A-Za-z_][A-Za-z0-9_.]*\s*(?:\(\s*\))?\s*/;

/**
 * Strip the SHELL GROUPING delimiters that wrap a segment, so the command word
 * inside a group sits in the command POSITION every fence dispatches on.
 *
 * WHY THIS EXISTS (loom s60). `splitShellSegments` separates on `&&`, `||`,
 * `;`, `|` and newline — never on `(`/`)`/`{`/`}`. So a grouped command stays
 * ONE segment whose leading token is `(git`, which `parseGitInvocation` does
 * not recognise as a git token, and every downstream fence dispatching on
 * `g.sub` sees nothing. MEASURED on a genuinely dirty checkout, against the two
 * fences whose loss is IRRECOVERABLE and which were ALREADY shipped:
 *
 *   git -C <dirty> reset --hard HEAD        (alone)     -> exit 2 BLOCK
 *   (git -C <dirty> reset --hard HEAD)      (grouped)   -> exit 0 SILENT
 *   git -C <dirty> clean -fd                (alone)     -> exit 2 BLOCK
 *   (git -C <dirty> clean -fd)              (grouped)   -> exit 0 SILENT
 *   { git -C <dirty> reset --hard HEAD; }   (grouped)   -> exit 0 SILENT
 *
 * The unwrapped rows are the positive control: the hook CAN speak about that
 * tree, so the silence on the grouped rows is a real bypass and not an inert
 * instrument (`instrument-discipline.md` MUST-3(a)). One added keystroke
 * disarmed a guard protecting work that has no reflog.
 *
 * Fixed HERE, in the shared parse lib, rather than in any one lane — per
 * `security.md` § Enforcement-Surface Parity, a normalization promoted at one
 * surface must be learned by every surface through ONE shared function, or the
 * surfaces drift the next time one is hardened.
 *
 * SCOPED DELIBERATELY NARROW — position 0 only, never a global delete:
 *   - A leading `(` / `{` / reserved word / function-definition prefix is
 *     stripped ONLY when it is at the START of the trimmed segment. `$(`, `>(`,
 *     `<(` and `${` therefore survive intact, because their first character is
 *     `$`/`>`/`<`. That matters: splitting or stripping inside a command
 *     substitution would fracture `git $(echo reset) --hard`, whose
 *     UNRESOLVABLE-subcommand fence deliberately fails CLOSED, into fragments
 *     that resolve — turning a fail-closed verdict into a silent allow.
 *   - A trailing `)` / `}` / `;` is stripped from the end for the closing half
 *     (`cmd2)` after a `&&` split).
 *   - Arithmetic `((i++))` reduces to `i++`, which parses as no command at all
 *     and is harmless.
 *   - Quoted text is untouched: a segment beginning `"(foo)"` starts with `"`.
 *
 * The prefix walk REPEATS until it stops shrinking, because the forms nest:
 * `{ f() { git reset --hard HEAD; }; }` needs the brace, then the definition
 * prefix, then the brace again. Termination is on strict shrinkage.
 */
function stripShellGroupDelimiters(segment, { reservedWords = true } = {}) {
  if (typeof segment !== "string") return "";
  let s = segment.trim();
  // Leading group openers, reserved words and function-definition prefixes,
  // repeated so the nested spellings reduce all the way down.
  //
  // TWO CONSUMERS WITH OPPOSITE NEEDS (C2 fix, 2026-10-03). The FENCE consumers
  // (landing-window-guard, push-preflight, violation-patterns ×2,
  // ci-runner-saturation) want the reserved-word strip: the real command sits
  // one word past `do`/`then`. The LOAD CLASSIFIER
  // (`synthetic-load.js::classifyUnit`) calls this to unwrap a GROUP and then
  // re-classifies the inner text — where the keyword IS the signal: this same
  // pass turned `(while :; do :; done)` into `:; do :; done` and the classifier
  // stopped seeing its loop (synthetic-load-guard pair11-red-seq-subshell-loops
  // red at 4ccb1fb55, bisected). `reservedWords: false` is the classifier's
  // mode; the DEFAULT keeps every fence call site byte-identical, so the two
  // cannot drift — one implementation, an explicit mode.
  for (;;) {
    const before = s;
    while (s.length > 0 && (s[0] === "(" || s[0] === "{")) {
      s = s.slice(1).trim();
    }
    const fn = /^function\b/.test(s)
      ? FUNCTION_DEF_KEYWORD.exec(s)
      : FUNCTION_DEF_BARE.exec(s);
    if (fn) s = s.slice(fn[0].length).trim();
    const word = /^(\S+)/.exec(s);
    if (reservedWords && word && LEADING_RESERVED_WORDS.has(word[1])) {
      s = s.slice(word[1].length).trim();
    }
    if (s === before) break;
  }
  // Trailing closers, and the group's terminating `;`.
  //
  // A trailing closer is stripped ONLY when it is UNBALANCED in what remains —
  // i.e. it closes a group whose opener is not in this segment (either stripped
  // above, or left in a sibling segment by the `&&`/`;` split). A BALANCED pair
  // belongs to the command and is left alone.
  //
  // MEASURED defect this guards against: the first cut stripped any trailing
  // closer unconditionally, which rewrote
  //   git worktree remove --force $(cat /tmp/x)
  // into `… $(cat /tmp/x`, mangling a command SUBSTITUTION the hook must not
  // evaluate. The verdict was unaffected (an unresolvable target ranks
  // INDETERMINATE either way), but a normalizer that silently edits the inside
  // of a substitution is one refactor away from turning a fail-CLOSED
  // unresolvable verdict into a resolvable — and silently allowed — one.
  const countOutsideQuotes = (str, ch) => {
    let n = 0;
    let quote = null;
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (c === "\\" && quote !== "'") {
        i++;
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
      if (c === ch) n++;
    }
    return n;
  };
  let changed = true;
  while (changed && s.length > 0) {
    changed = false;
    const last = s[s.length - 1];
    if (last === ";") {
      s = s.slice(0, -1).trim();
      changed = true;
      continue;
    }
    const open = last === ")" ? "(" : last === "}" ? "{" : null;
    if (open === null) break;
    if (countOutsideQuotes(s, last) > countOutsideQuotes(s, open)) {
      s = s.slice(0, -1).trim();
      changed = true;
    }
  }
  return s;
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

/**
 * A REDIRECTION opening a shell word, recognized HERE because this is the last
 * point that still knows whether the bytes were quoted.
 *
 * THE DEFECT THIS CLOSES. `tokenize` consumes quotes, so by the time any
 * consumer reads `argv`, `git branch -D "2>&1"` and `git branch -D x 2>&1` have
 * both produced a token whose VALUE is `2>&1`. The first is a (legal, absurd)
 * branch NAME; the second is the shell wiring fd 2 onto fd 1 and is not an
 * argument at all. A consumer filtering on the VALUE therefore cannot fix one
 * without deleting the other — it would drop a real target to silence a
 * non-target, which is the over-narrow half of this defect rather than its fix.
 * Recognition belongs at the only place holding the evidence that separates
 * them.
 *
 * MEASURED SYMPTOM (stranded-artifact guard). `git worktree remove <path> 2>&1`
 * parsed to targets `[<path>, "2>&1"]`, and the guard duly reported that the
 * target `2>&1` "could NOT be assessed (no-worktree-at:2>&1) ... This is
 * INDETERMINATE". The report was accurate about a target that never existed:
 * it inflated the target count on every redirected command and trained the
 * reader to skip the one surface that names artifacts about to be stranded.
 *
 * SCOPE. Any UNQUOTED redirection, at a word start or MID-word, with the
 * optional leading fd (`2>&1`) or `&` (`&>log`) the shell allows at a word
 * start. An earlier revision of this block scoped the recognizer to word STARTS
 * ONLY, reasoning that a mid-word `>` might cost argument BYTES while a miss
 * cost only a noisy report. That pricing was taken from the TARGET position and
 * does NOT hold in the VERB position, where a miss costs the whole fence:
 * measured on `origin/main`, `git push>/dev/null --force origin main` parses its
 * subcommand as `push>/dev/null`, matching no fenced verb and leaving
 * `unresolvable` null, so neither the fence nor the fail-closed lane fires — a
 * pre-existing silent bypass of every `sub`-dispatching fence, surfaced by the
 * adversarial review OF this change. Splitting at the operator costs no bytes,
 * because the prefix is FLUSHED as an ordinary token.
 *
 * Process substitution is excluded explicitly: `<(cmd)` / `>(cmd)` expand to a
 * `/dev/fd/N` ARGUMENT, so matching their leading bracket would delete a real
 * operand — the one outcome this recognizer must never produce.
 *
 * The OPERAND is marked alongside the operator, never the operator alone: in
 * `> /dev/null` the path is its own word, so stripping just the `>` would trade
 * a `>` target for a `/dev/null` target — the same defect wearing a name
 * plausible enough to survive review.
 *
 * `|`, `||`, `&&`, `;` and newline need nothing here: `splitShellSegments`
 * already separates on them BEFORE tokenize runs, so they never reach a token.
 * Verified rather than assumed — `git worktree remove /tmp/wt | cat` parses to
 * argv `["remove", "/tmp/wt"]` on the pre-fix parser.
 */
// STICKY, not `^`-anchored, and that is a performance property rather than a
// style one: the anchored form needs `raw.slice(i)`, which allocates a copy of
// the whole remainder at every word boundary and turns `tokenize` from O(n) into
// O(n·w) in the count of unquoted spaces. Measured on a 200 KB space-padded
// command: 3.8 ms before this recognizer existed, 8.2 ms with the slicing form.
// `lastIndex` is assigned immediately before every `exec`, so the shared object
// carries no state between calls.
const REDIRECT_OPERATOR = /(?:\d+|&)?(?:>>|>&|>\||<<-|<<<|<<|<&|<>|>|<)/y;

/**
 * Drop the words `tokenize` marked as shell redirection plumbing.
 *
 * Applied at every `tokenize` call site in the same change — the three in this
 * module AND the two outside it, since `tokenize` is EXPORTED
 * (`security.md` § Multi-Site Kwarg Plumbing: grep every caller, do not patch
 * the primary site alone). The gh path carries the identical defect
 * (`gh pr checks 12 --json state 2>&1` puts `2>&1` in gh's argv exactly as the
 * git path did), and so does `destructive-force-target.js::selectRmForce`, where
 * `rm -rf /tmp/scratch >/dev/null 2>&1` reported two phantom paths as deletion
 * targets. `rebase-content-loss.js::namesAnotherGitDir` is outcome-neutral today
 * and is routed anyway, because one consumer left on the raw stream is how the
 * next predicate added there inherits the defect silently.
 *
 * Kept OUT of `tokenize` itself, which is exported for the fidelity suites and
 * the corpus measurements that size this module's false-positive surface. Those
 * read the token STREAM, and a stream silently missing words would make an
 * approximation of the tokenizer measure something other than the tokenizer.
 * The mark travels on the token; the filter is the consumer's step.
 */
function stripRedirectionTokens(toks) {
  return Array.isArray(toks) ? toks.filter((t) => !(t && t.redirect)) : toks;
}

function tokenize(raw) {
  const toks = [];
  let cur = "";
  let started = false;
  let unexpandable = false;
  let quote = null;
  // Set when the word now being accumulated OPENED with a redirection operator.
  let redirect = false;
  // That word's operator text, so `flush` can tell `>` — whose operand is the
  // NEXT word — from `>/dev/null`, whose operand is already attached to this one.
  let redirectOp = "";
  // Set when the word just flushed was a BARE operator, making the word that
  // follows it that operator's operand.
  let redirectOperandPending = false;
  const flush = () => {
    toks.push({
      value: cur,
      unexpandable,
      redirect: redirect || redirectOperandPending,
    });
    // Recomputed from THIS word before the state resets: a bare operator arms
    // the flag for the next word, and anything else (including the operand just
    // consumed) disarms it.
    redirectOperandPending = redirect && cur === redirectOp;
    cur = "";
    started = false;
    unexpandable = false;
    redirect = false;
    redirectOp = "";
  };
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    // A redirection. Tested FIRST, and only while no quote is open — a quoted
    // `">"` reaches this line with `quote` already set by the branch that opened
    // it, and an escaped `\>` is consumed by the backslash branch below without
    // ever reaching here. That is the whole reason the test lives at this point
    // and not in a consumer reading dequoted values.
    //
    // MID-WORD COUNTS. `<` and `>` are shell METACHARACTERS: bash ends the
    // current word at one wherever it appears. So `git push>/dev/null --force
    // origin main` runs `git push --force origin main`, while a recognizer
    // looking only at word STARTS read the verb as `push>/dev/null` — matching
    // no fenced verb, and leaving `unresolvable` null so the fail-closed lane
    // did not fire either. Every fence dispatching on `sub` was bypassable by
    // one character. `git branch -D "main">out` is the same bypass reached
    // through a closing quote, which is why the test is on `quote === null` AT
    // THIS CHARACTER rather than on whether the word ever contained a quote.
    //
    // The fd prefix (`2>&1`, `&>log`) is matched ONLY at a word start: in
    // `x2>&1` those digits belong to the preceding word, exactly as bash reads
    // them, so mid-word entry is on `<` / `>` alone.
    const midWord = c === ">" || c === "<";
    if (
      quote === null &&
      (midWord || (!started && (c === "&" || (c >= "0" && c <= "9")))) &&
      // PROCESS SUBSTITUTION is an ARGUMENT, not a redirection: bash expands
      // `<(cmd)` / `>(cmd)` to a `/dev/fd/N` path and hands it to the command.
      // Without this guard the recognizer matched the leading bracket and
      // dropped half of it — `git diff <(cat a) <(cat b)` lost both `<(cat`
      // tokens — which is the one outcome this recognizer must never produce.
      !(midWord && raw[i + 1] === "(")
    ) {
      REDIRECT_OPERATOR.lastIndex = i;
      const m = REDIRECT_OPERATOR.exec(raw);
      if (m) {
        // The word ends HERE, as bash ends it, and FLUSHING it is what keeps
        // this from deleting argument bytes: the prefix is emitted as an
        // ordinary token and only the operator (with its operand) is marked.
        // `flush` recomputes `redirectOperandPending` from the word it closes —
        // an ordinary one — so it disarms, and the operator's state is set after.
        if (started) flush();
        redirect = true;
        redirectOp = m[0];
        cur += m[0];
        started = true;
        i += m[0].length - 1;
        continue;
      }
    }
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
      // `$@` `$*` `$#` `$-` — POSIX SPECIAL PARAMETERS (Tier-1 F2, 2026-10-04):
      // one-character expansions that carry arbitrary content, marked
      // unexpandable exactly like `$NAME`.
      if (next && "@*#-".includes(next)) {
        cur += raw.slice(i, i + 2);
        unexpandable = true;
        started = true;
        i += 1;
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
    // GLOB / BRACE EXPANSION (SEC-B-2, security ruling 2026-10-04): an unquoted
    // `*`/`?`, a `[` CLOSED by a `]` in the same word (a bracket expression),
    // and a `{…}` group that WILL expand — bash expands braces only with a
    // top-level `,` or a `..` sequence, so `{}` (find's inert placeholder) and
    // `{x}` stay literal — are expanded BEFORE any command runs, so their real
    // content is not readable from this string and they carry the same
    // `unexpandable` mark `$…` does. Quoted forms NEVER reach this branch (the
    // quote branches above consume them), so `find . -name '*.js'` and
    // `ls '*.txt'` stay literal, and a LONE `[` (the test builtin) is not a
    // glob — the pair tests are what keep those out of the mark class.
    if (c === "*" || c === "?") unexpandable = true;
    else if (c === "]" && cur.includes("[")) unexpandable = true;
    else if (c === "}") {
      const open = cur.lastIndexOf("{");
      if (open !== -1 && /[,]|\.\./.test(cur.slice(open + 1))) unexpandable = true;
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
 * Round 5 extends the same principle INSIDE the bare-operand skip: which bare
 * words belong to the WRAPPER (flag values, positional operands) and which is
 * the wrapped command is decided by that wrapper's grammar — see the table and
 * `wrapperFlagEffect` below — never by position alone.
 */
// ── WRAPPER GRAMMAR (Tier-1 round 5, 2026-10-04) ───────────────────────────
// `scanCommandPrefix` must answer ONE question about a bare word inside wrapper
// context: is it the WRAPPED COMMAND — so everything after it is argument
// position, where a glob/brace/variable is inert — or is it a word the wrapper
// ITSELF consumes (`sudo -u root`, `nice -n 10`, `timeout 5`)? The two are
// indistinguishable without the wrapper's own grammar, and c→d cleared the
// command-slot mark on a flag VALUE, so `timeout 5 $CMD` / `sudo -u root $CMD`
// / `nice -n 10 $CMD` silently reached an allow while their base spelling
// blocked (correctness re-check, measured on a dirty repo).
//
// Entries answer exactly that: `short`/`long` map a flag spelling to "value"
// (consumes the NEXT word), "flag" (boolean), or "optional" (may or may not
// take a value — ambiguous). `operands` counts positional words BEFORE the
// command word (timeout's DURATION, taskset's MASK, setarch's ARCH). A wrapper
// or spelling ABSENT from this table is NOT provably the command's position, so
// no bare word it precedes clears the mark — the base fail-closed direction.
// Entries deliberately list the COMMON spellings only: a rare flag left out
// costs an over-denial on that spelling, never a silent allow.
//
// THE PREVIOUS SENTENCE WAS FALSE IN ONE DIRECTION and is corrected (round f;
// security review found it via `nsenter --setuid 0 --target 1 git commit`):
// `stopAt` IS tested before any consumption, so a git token can never be
// swallowed BY THE CONSUMPTION of the word it sits on — but a WRONG "flag"
// kind (a value-taking spelling marked boolean) makes the walk consume the
// flag's VALUE as the wrapped command and RETURN there, and the walk-stop means
// the later git token is never TESTED at all. The table's flag/value derivation
// is what protects that direction, and it is load-bearing: every "flag" entry
// is a claim the real program takes no value there. MEASURED instance: setuid/
// setgid were marked "flag" (util-linux takes values) and the CC fence allowed
// a destructive argv that base blocked.
const WRAPPER_GRAMMAR = new Map();
{
  const add = (name, g) => {
    WRAPPER_GRAMMAR.set(name, {
      short: new Map(Object.entries(g.short || {})),
      long: new Map(Object.entries(g.long || {})),
      operands: g.operands || 0,
    });
  };
  // Privilege / identity changers — value flags, no positional operands.
  add("sudo", {
    short: { u: "value", g: "value", h: "optional", p: "value", C: "value", D: "value", R: "value", r: "value", t: "value", T: "value", U: "value", A: "flag", b: "flag", E: "flag", i: "flag", K: "flag", k: "flag", l: "optional", n: "flag", S: "flag", s: "flag", v: "flag", e: "flag" },
    long: { user: "value", group: "value", host: "value", prompt: "value", chdir: "value", "close-from": "value", role: "value", type: "value", "command-timeout": "value", "other-user": "value", "preserve-env": "optional", edit: "flag", list: "optional", validate: "flag", "reset-timestamp": "flag", "invalidate-timestamp": "flag", kill: "flag", "remove-timestamp": "flag", background: "flag", askpass: "flag", login: "flag", "non-interactive": "flag", stdin: "flag", shell: "flag", "set-home": "flag", "use-pty": "flag", help: "flag", version: "flag" },
  });
  add("doas", { short: { u: "value", C: "value", n: "flag", s: "flag" } });
  add("pkexec", { long: { user: "value", "disable-internal-agent": "flag", help: "flag", version: "flag" } });
  // env-style: assignments are handled by the caller's VAR=val skip.
  add("env", { short: { u: "value", C: "value", S: "value", i: "flag", 0: "flag", v: "flag" }, long: { unset: "value", chdir: "value", "split-string": "value", "ignore-environment": "flag", null: "flag", debug: "flag", help: "flag", version: "flag" } });
  add("command", { short: { p: "flag", v: "flag", V: "flag" } });
  add("exec", { short: { a: "value", c: "flag", l: "flag" } });
  add("builtin", {});
  add("eatmydata", {});
  // Scheduling / timing — `timeout` is the one with a POSITIONAL operand.
  add("nice", { short: { n: "value" }, long: { adjustment: "value", help: "flag", version: "flag" } });
  add("nohup", {});
  add("time", { short: { f: "value", o: "value", a: "flag", p: "flag", v: "flag", q: "flag" }, long: { format: "value", output: "value", append: "flag", portable: "flag", verbose: "flag", quiet: "flag", help: "flag", version: "flag" } });
  add("timeout", { short: { k: "value", s: "value", v: "flag" }, long: { "kill-after": "value", signal: "value", "preserve-status": "flag", foreground: "flag", verbose: "flag", help: "flag", version: "flag" }, operands: 1 });
  add("ionice", { short: { c: "value", n: "value", p: "value", t: "flag", u: "flag" }, long: { class: "value", classdata: "value", pid: "value", ignore: "flag", help: "flag", version: "flag" } });
  add("setsid", { short: { c: "flag", f: "flag", w: "flag", W: "flag" }, long: { ctty: "flag", fork: "flag", wait: "flag", "wait-all": "flag", help: "flag", version: "flag" } });
  add("stdbuf", { short: { i: "value", o: "value", e: "value" }, long: { input: "value", output: "value", error: "value" } });
  add("chrt", { short: { p: "value", m: "flag", o: "value", r: "value", b: "flag", d: "flag", f: "flag", i: "flag", a: "value", R: "flag", T: "value", P: "value" }, operands: 1 });
  add("taskset", { short: { p: "value", c: "value", a: "value" }, long: { pid: "value", "cpu-list": "value", "all-tasks": "flag", help: "flag", version: "flag" }, operands: 1 });
  add("xargs", { short: { I: "value", n: "value", P: "value", d: "value", a: "value", E: "value", e: "optional", s: "value", L: "value", l: "optional", x: "flag", r: "flag", t: "flag", p: "flag", o: "flag", 0: "flag" }, long: { "arg-file": "value", delimiter: "value", "max-args": "value", "max-chars": "value", "max-lines": "value", "max-procs": "value", replace: "value", eof: "optional", "show-limits": "flag", "no-run-if-empty": "flag", null: "flag", verbose: "flag", "open-tty": "flag", interactive: "flag", exit: "flag", help: "flag", version: "flag" } });
  // Placement / namespaces — value-bearing options, no positional operands.
  add("setarch", { short: { R: "flag", B: "flag", L: "flag", X: "flag", Z: "flag", T: "flag", F: "flag", I: "flag", v: "flag", 3: "flag", 4: "flag" }, long: { "uname-2.6": "flag", list: "flag", help: "flag", version: "flag" }, operands: 1 });
  add("numactl", { long: { interleave: "value", cpunodebind: "value", membind: "value", physcpubind: "value", preferred: "value", localalloc: "flag", show: "flag", hardware: "optional", help: "flag", version: "flag" } });
  add("nsenter", { short: { t: "value", S: "value", G: "value" }, long: { target: "value", mount: "flag", uts: "flag", ipc: "flag", pid: "flag", net: "flag", user: "flag", cgroup: "flag", time: "flag", root: "value", wd: "value", "preserve-credentials": "flag", setgid: "value", setuid: "value", help: "flag", version: "flag" } });
  add("unshare", { short: { m: "flag", u: "flag", i: "flag", p: "flag", n: "flag", U: "flag", C: "flag", T: "flag", f: "flag", r: "flag", w: "flag", a: "flag", S: "value", R: "value" }, long: { mount: "flag", uts: "flag", ipc: "flag", pid: "flag", net: "flag", user: "flag", cgroup: "flag", time: "flag", fork: "flag", "map-root-user": "flag", propagation: "value", setgroups: "value", "map-users": "value", "map-user": "value", "map-groups": "value", "map-group": "value", "keep-caps": "flag", help: "flag", version: "flag" } });
  add("systemd-run", { short: { p: "value", E: "value", u: "value", q: "flag", t: "flag", G: "flag", H: "flag", M: "value", h: "flag" }, long: { property: "value", setenv: "value", unit: "value", description: "value", slice: "value", scope: "flag", user: "flag", system: "flag", wait: "flag", pipe: "flag", pty: "flag", quiet: "flag", collect: "flag", "same-dir": "flag", machine: "value", host: "value", help: "flag", version: "flag" } });
  add("cgexec", { short: { g: "value" }, long: { sticky: "flag" } });
  // Sandboxes / tracers / shims — value-bearing options, no operands.
  add("firejail", { long: { profile: "value", net: "value", help: "flag", version: "flag" } });
  add("bwrap", { long: { bind: "value", "ro-bind": "value", "bind-try": "value", "ro-bind-try": "value", dev: "value", proc: "value", devbind: "value", tmpfs: "value", dir: "value", file: "value", chdir: "value", setenv: "value", unsetenv: "value", rofiles: "flag", "unshare-all": "flag", diewithparent: "flag" } });
  add("proot", { short: { b: "value", w: "value", r: "value", 0: "flag", q: "value" }, long: { bind: "value", cwd: "value", rootfs: "value", "kill-on-exit": "flag", "change-id": "value", link2symlink: "flag" } });
  add("fakeroot", { short: { s: "value", i: "value", u: "value", f: "value", c: "value", b: "flag" } });
  add("strace", { short: { o: "value", e: "value", p: "value", s: "value", u: "value", E: "value", a: "value", b: "value", A: "value", f: "flag", t: "flag", c: "flag", y: "flag" }, long: { output: "value", trace: "value", attach: "value", "string-limit": "value", help: "flag", version: "flag" } });
  add("ltrace", { short: { o: "value", e: "value", p: "value", s: "value", l: "value", x: "value", a: "value", u: "value", n: "value", i: "flag", f: "flag", t: "flag" } });
  add("dtruss", { short: { p: "value", n: "value", f: "value", t: "value", l: "flag", a: "flag" } });
  add("valgrind", { short: { q: "flag", v: "flag" }, long: { "log-file": "value", "log-fd": "value", "error-exitcode": "value", suppressions: "value", tool: "optional", "trace-children": "optional" } });
  add("gdb", { short: { x: "value", ex: "value", e: "value", b: "value", s: "value", d: "value" }, long: { args: "flag", core: "value", pid: "value", batch: "flag", quiet: "flag" } });
  add("xvfb-run", { short: { a: "flag", e: "value", f: "value", n: "value", p: "value", s: "value", w: "value" }, long: { "auto-servernum": "flag", "error-file": "value", "server-args": "value", "server-num": "value" } });
  add("torsocks", { short: { p: "value", u: "value", P: "flag", d: "flag" } });
  add("proxychains", { short: { f: "value", q: "flag", v: "flag" } });
  add("proxychains4", { short: { f: "value", q: "flag", v: "flag" } });
  // Multicall dispatchers — the FIRST bare word is the applet that runs.
  add("busybox", {});
  add("toybox", {});
  // LOCAL ARGV-RUNNERS (fix round f): each EXECs its trailing argv, so NO bare
  // word in their argument list is "the command" — the wrapped command is only
  // known once a later stop token (git / a shell) is seen. `operands: Infinity`
  // makes the grammar consume every bare word as an operand, which is exactly
  // the pre-e behaviour this restores: the walk keeps scanning, and a `git` or
  // `sh` token in the argv is reached and matched. MEASURED regression this
  // closes (e vs base, CC path on a dirty repo): `sudo tmux new-session -d git
  // reset --hard HEAD` 0 vs 2; screen/entr likewise; the fused-flag controls
  // were 2/2 throughout.
  for (const argvRunner of [
    "tmux",
    "screen",
    "entr",
    "dbus-run-session",
    // Round f2 (correctness review, 5b): the SAME class, more launcher names —
    // each EXECs its trailing argv, each was absent from every table, and each
    // measured base-resolves / e-f-[] at the reader.
    "systemd-nspawn",
    "machinectl",
    "setpriv",
    "softlimit",
    "daemonize",
    "faketime",
    "ts",
    "chpst",
    // Round h: the residual four the correctness review swept (MEASURED base
    // resolves through each; the walk-stop swallowed them). Same class, same
    // operands:Infinity grammar.
    "authbind",
    "setuidgid",
    "envdir",
    "pgrphack",
    // Round h2: the final constructive sweep's five (same class, same grammar).
    "ifne",
    "lckdo",
    "nq",
    "setlock",
    "sandbox-exec",
  ]) {
    add(argvRunner, { operands: Infinity });
  }
  // GNU coreutils under the `g` prefix: same programs, same grammar.
  const alias = (name, target) => WRAPPER_GRAMMAR.set(name, WRAPPER_GRAMMAR.get(target));
  alias("gtimeout", "timeout");
  alias("gnice", "nice");
  alias("gnohup", "nohup");
  alias("gstdbuf", "stdbuf");
  alias("genv", "env");
  // util-linux setarch invoked under its per-architecture names: the arch is
  // implied by the NAME, so these take no arch operand.
  const setarchFlags = {
    short: WRAPPER_GRAMMAR.get("setarch").short,
    long: WRAPPER_GRAMMAR.get("setarch").long,
  };
  for (const name of ["linux32", "linux64", "i386", "x86_64"]) {
    WRAPPER_GRAMMAR.set(name, { short: setarchFlags.short, long: setarchFlags.long, operands: 0 });
  }
}

/**
 * Which effect a wrapper flag token has on the command-word question.
 * `pending` — the NEXT word is this flag's VALUE (never the wrapped command);
 * `ambiguous` — a spelling the table does not know, so nothing after it is
 * provably in command position. Long `--name=value` is always fused-consumed.
 */
function wrapperFlagEffect(token, g) {
  if (token.startsWith("--")) {
    const body = token.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    const spec = g.long.get(name);
    if (spec === undefined) return { pending: false, ambiguous: true };
    if (eq !== -1) return { pending: false, ambiguous: false };
    if (spec === "value") return { pending: true, ambiguous: false };
    return { pending: false, ambiguous: spec !== "flag" };
  }
  const chars = token.slice(1);
  for (let k = 0; k < chars.length; k++) {
    const spec = g.short.get(chars[k]);
    if (spec === undefined) return { pending: false, ambiguous: true };
    if (spec === "value") {
      // A value-taking letter with anything after it (or before it in the
      // cluster) consumes the REMAINDER as its value: `-n10`, `-o0`.
      return { pending: k === chars.length - 1, ambiguous: false };
    }
    if (spec !== "flag") return { pending: false, ambiguous: true };
  }
  return { pending: false, ambiguous: false };
}

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
  // Tier-1 round 4 (over-denial regression): TRUE once the wrapper's command
  // word has been CONSUMED as such — i.e. a bare operand the wrapper's own
  // grammar LEAVES IN COMMAND POSITION (`time ls *.txt` → `ls`). A later
  // brace/glob is then in ARGUMENT position and is inert; only an unexpandable
  // word with NO resolved command before it sits at a genuine COMMAND-NAME
  // position. Round 5 (correctness re-check): this must NEVER be set by a word
  // the wrapper itself consumes as a flag value or positional operand
  // (`sudo -u root`, `nice -n 10`, `timeout 5`) — doing so cleared the mark on
  // a following `$CMD`, silently allowing what the base blocked.
  let sawWrapperOperand = false;
  // TRUE once the walk has PASSED a bare word sitting in command position that
  // it could neither classify as a wrapper nor resolve as a stop token — the
  // word the pre-inversion walk STOPPED at (the INVERSION site below). A later
  // shell token may therefore be that unknown launcher's ARGUMENT, not a
  // command: in `command grep -rln 'fish' .` the fish word is grep's operand,
  // and base AND h2 allowed every wrapper spelling of that shape (measured,
  // seven wrappers — the operator-ratified inversion fix, 2026-10-05). The
  // shell verdicts read this flag via `tolerateNonPathScriptOperand` and
  // tolerate a non-path literal script operand there. Deliberately NARROW: it
  // does NOT tolerate an unreadable operand (content unknowable ⇒ fail closed)
  // and command-mode refusals are untouched.
  let sawUnknownCommandWord = false;
  // Grammar of the MOST RECENT wrapper name: null = no bare word is provably
  // the wrapped command from here (unknown wrapper, unknown flag spelling, or
  // an optional-value flag), which is the fail-closed direction.
  let wrapperGrammar = null;
  let pendingValue = false; // the previous flag consumes the NEXT word as its value
  let operandsSeen = 0; // positional operands consumed since the last wrapper name
  while (i < toks.length) {
    const t = toks[i].value;
    if (stopAt(toks[i]))
      return {
        kind: "match",
        idx: i,
        unresolvedCommandSlot,
        commandSlotIdx,
        sawWrapperOperand,
        sawUnknownCommandWord,
      };
    if (/^[A-Za-z_]\w*\+?=/.test(t)) {
      i++;
      continue;
    } // VAR=val assignment, or the `arr+=(…)` append form (also an assignment,
    // never a command — without the `\+?` it fell through to the command-name
    // slot and, being substitution-bearing, marked the segment unresolvable)
    // Case-folded: wrapper NAMES are case-insensitive on this side too (co-owner
    // ruling 2026-10-04) — `SUDO git ...` / `/usr/bin/Nice ...` must see through.
    const wrapperName = basename(t).toLowerCase();
    if (GIT_WRAPPERS.has(wrapperName)) {
      sawWrapper = true;
      wrapperGrammar = WRAPPER_GRAMMAR.get(wrapperName) || null;
      pendingValue = false;
      operandsSeen = 0;
      i++;
      continue;
    } // wrapper command name (basename, so `/usr/bin/sudo` counts)
    if (t.startsWith("-")) {
      if (wrapperGrammar) {
        const eff = wrapperFlagEffect(t, wrapperGrammar);
        pendingValue = eff.pending;
        // An unrecognized spelling: no word after it is provably the command,
        // so the operand claim is withdrawn from here on (fail closed).
        if (eff.ambiguous) wrapperGrammar = null;
      }
      i++;
      continue;
    } // a flag (wrapper's or env's)
    if (toks[i].unexpandable) {
      // Tier-1 round 4: AFTER the wrapper's command word was already resolved
      // (`time ls *.txt` → `ls`), an unexpandable sits in ARGUMENT position —
      // inert, so it gets no command-slot mark at all. Before one, it may BE
      // the command name, so it is marked as before: keep scanning — a LATER
      // literal git token is strictly more informative than this mark
      // (`timeout $(echo 5) git commit` should fence on `commit`, precisely,
      // rather than on the unknown operand) — but remember that we passed one,
      // so a caller that finds nothing better can fail CLOSED instead of
      // silently reporting "not a git invocation".
      if (!sawWrapperOperand) {
        unresolvedCommandSlot = true;
        if (commandSlotIdx === -1) commandSlotIdx = i;
      }
      i++;
      continue;
    }
    if (sawWrapper) {
      if (pendingValue) {
        // The previous flag's VALUE: `sudo -u root`, `nice -n 10` (round 5).
        // Consumed by the wrapper — it is NOT the wrapped command, so it must
        // not resolve an operand.
        pendingValue = false;
        i++;
        continue;
      }
      if (!sawWrapperOperand && wrapperGrammar) {
        if (operandsSeen < wrapperGrammar.operands) {
          // A positional word the wrapper's grammar consumes before its
          // command: `timeout 5`, `taskset 0x3` (round 5).
          operandsSeen++;
          i++;
          continue;
        }
        // The first word the grammar leaves in command position: THIS is the
        // wrapped command, so later words sit in argument position.
        sawWrapperOperand = true;
        // The word is KEPT IN SCAN, not classified — see the flag's declaration.
        sawUnknownCommandWord = true;
        // INVERSION (mechanism A; OPERATOR-RATIFIED): the wrapped command word
        // does NOT terminate the walk. It may itself be an UNKNOWN launcher
        // (prlimit, perf, tmux, s6-setuidgid, …) whose trailing argv is the real
        // command, so keep scanning for a later recognised git/shell token. The
        // accepted cost (measured, stated in the commit body): base's 11
        // non-executing over-blocks return, matching base exactly, and the
        // over-denial-guard suite cases move to the new contract.
        i++;
        continue;
      }
      i++;
      continue;
    } // bare operand inside wrapper context
    return {
      kind: "other",
      idx: i,
      unresolvedCommandSlot,
      commandSlotIdx,
      sawWrapperOperand,
      sawUnknownCommandWord,
    };
  }
  return {
    kind: "end",
    idx: i,
    unresolvedCommandSlot,
    commandSlotIdx,
    sawWrapperOperand,
    sawUnknownCommandWord,
  };
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
// Single-quote a word so re-tokenizing the joined string yields it unchanged.
const shellQuoteWord = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;

// Re-join tokens into a command string for a second parse. A literal word is
// single-quoted so its argv boundary survives; an UNEXPANDABLE one keeps its
// raw bytes so the next parse still marks it unexpandable — with its EMBEDDED
// quote/backslash bytes ESCAPED (SEC-B-3 class sweep, 2026-10-04): a
// quote-stripped value carrying an unbalanced quote (`X=$Y'`) previously
// re-opened quoting on the second parse and swallowed the following words,
// which is how `busybox env "X=$Y'" sh -c BODY` was allowed. The `$`/backtick/
// glob bytes stay RAW so the mark itself survives re-tokenization.
const rejoinTokens = (toks) =>
  toks
    .map((t) =>
      t.unexpandable
        ? String(t.value).replace(/(["'`\\])/g, "\\$1")
        : shellQuoteWord(t.value),
    )
    .join(" ");

const ENV_COMMANDS = new Set(["env", "genv"]);

/**
 * `env -S <string>` / `env --split-string=<string>` — env splits the string into
 * words and runs them, followed by the remaining operands. That is `sh -c` with a
 * different spelling, and it was a measured bypass of every fence reading nested
 * bodies: `env -S 'git commit -m x'` parsed as no git invocation, and
 * `env -S 'rm <state>'` passed the state-file guard with the hook exiting 0.
 *
 * Returns `{ commands, unresolvable }` when an `env` command word carries a split
 * string, or null so the caller's ordinary scan runs (`env` stays a wrapper there).
 * An unexpandable string (`env -S "$CMD"`) is reported unresolvable, the same
 * verdict `sh -c "$CMD"` gets.
 *
 * Option grammar walked (GNU coreutils env; FreeBSD env shares `-S` / `-u` / `-P`):
 * short options may cluster (`-iS`); `S` takes the rest of the cluster or the next
 * word; `u`, `C`, `a`, `P` take a value the same way; `--unset`, `--chdir`,
 * `--argv0` take the next word when not written with `=`. `NAME=VALUE` words are
 * skipped. The first other word is the command, and a split string can no longer
 * follow it.
 */
function envSplitStringCommand(toks) {
  // `genv` is GNU env under the `g` program prefix, with the same `-S`.
  // (Folded with the rest of the command-name checks — ruling 2026-10-04.)
  const scan = scanCommandPrefix(toks, (tok) =>
    ENV_COMMANDS.has(foldedBasename(tok.value)),
  );
  if (scan.kind !== "match") return null;
  const empty = { commands: [], unresolvable: false };
  for (let j = scan.idx + 1; j < toks.length; j++) {
    const t = toks[j].value;
    if (t === "--") return null;
    if (/^[A-Za-z_]\w*=/.test(t)) continue;
    let valueTok;
    let valueText = null;
    let restFrom = -1;
    if (t === "--split-string") {
      valueTok = toks[j + 1];
      restFrom = j + 2;
    } else if (t.startsWith("--split-string=")) {
      valueTok = toks[j];
      valueText = t.slice("--split-string=".length);
      restFrom = j + 1;
    } else if (/^--(?:unset|chdir|argv0)$/.test(t)) {
      j++;
      continue;
    } else if (t.startsWith("--")) {
      continue;
    } else if (/^-[^-]/.test(t)) {
      let consumesNext = false;
      for (let k = 1; k < t.length; k++) {
        const ch = t[k];
        if (ch === "S") {
          if (k + 1 < t.length) {
            valueTok = toks[j];
            valueText = t.slice(k + 1);
            restFrom = j + 1;
          } else {
            valueTok = toks[j + 1];
            restFrom = j + 2;
          }
          break;
        }
        if (ch === "u" || ch === "C" || ch === "a" || ch === "P") {
          consumesNext = k + 1 === t.length;
          break;
        }
      }
      if (restFrom === -1) {
        if (consumesNext) j++;
        continue;
      }
    } else {
      return null;
    }
    if (!valueTok) return empty;
    if (valueTok.unexpandable) return { commands: [], unresolvable: true };
    const text = valueText !== null ? valueText : valueTok.value;
    const body = [text, rejoinTokens(toks.slice(restFrom))]
      .filter((s) => s.trim())
      .join(" ");
    return body.trim() ? { commands: [body], unresolvable: false } : empty;
  }
  return null;
}

// `find`'s command-running actions. Each takes words up to a `;` word, or up to a
// `+` word that immediately follows `{}`.
const FIND_EXEC_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/**
 * The commands `find` runs through `-exec` / `-execdir` / `-ok` / `-okdir`.
 * `find . -exec git commit -m x \;` parsed as no git invocation before this, for
 * the same reason `sh -c` once did: the command sits in find's operands, where no
 * prefix walk looks. An action whose COMMAND word is unexpandable is reported
 * unresolvable; later unexpandable words keep their raw bytes.
 */
function findExecCommands(toks, from) {
  const commands = [];
  for (let j = from; j < toks.length; j++) {
    if (!FIND_EXEC_ACTIONS.has(toks[j].value)) continue;
    const body = [];
    let k = j + 1;
    for (; k < toks.length; k++) {
      const v = toks[k].value;
      if (v === ";") break;
      if (v === "+" && body.length && toks[k - 1].value === "{}") break;
      body.push(toks[k]);
    }
    j = k;
    if (!body.length) continue;
    if (body[0].unexpandable) return { commands: [], unresolvable: true };
    commands.push(rejoinTokens(body));
  }
  return { commands, unresolvable: false };
}

/**
 * Commands that RUN a command given in their operands but are not transparent
 * prefixes. Each has its own option grammar, some take positional operands before
 * the command, and several run a SHELL BODY rather than an argv, so the wrapper
 * walk in `scanCommandPrefix` (which skips every bare word as a possible option
 * operand) cannot model them. Their commands are EXTRACTED as nested command
 * strings instead, where `expandNestedSegments` hands them to every consumer —
 * the state-file detector and the git/gh verb fences alike.
 *
 * Measured before this table, on the pure functions with synthetic strings (no
 * command run): `watch find . -fprint "<state>"`, `watch 'rm <state>'`,
 * `flock /tmp/l -c 'rm <state>'`, `chronic sh -c 'rm <state>'`, `su -c 'rm
 * <state>'` and `script -c 'rm <state>' /dev/null` each returned null from
 * `detectStateFileMutationSegmentAware`, and `watch -x git commit -m x`,
 * `flock /tmp/l git commit -m x`, `arch -arch arm64 git commit -m x` and
 * `chroot / git commit -m x` each parsed as no git invocation, while
 * `git commit -m x` on the same tree parsed as `commit`.
 *
 * Grammar fields. `short` / `long` map an option to "value" (takes the rest of
 * its cluster, its `=value`, or the next word), "optional" (argument only when
 * attached), "exec" (switches the command to argv form) or "body" (its value is a
 * shell body run by `sh -c`); anything unlisted is a flag, and a long option
 * matches any unambiguous prefix, as getopt_long does. `singleDashLong` lists
 * words spelled with one dash (`arch -arch x86_64`); `cluster: false` disables
 * short-option clustering. `permute` means options may follow operands (GNU
 * getopt without `+`), so body options are looked for across every word.
 * `operands` counts positional words before the command; `operandBody` names the
 * words that, in the command position, introduce a body instead. `subcommands`
 * names the verbs of a MULTI-VERB front-end (`uv run`, `pnpm exec`): the grammar
 * applies only AFTER one of them, and a segment carrying none runs nothing.
 * `doubleDashStarts` begins the command at the word after an explicit `--`, the
 * spelling `mise exec node@20 -- <cmd>` needs. `run` is "argv"
 * (the remaining words ARE the command), "shell" (they are joined with spaces and
 * run by `sh -c`) or "none" (only a body option runs anything). `terminators` end
 * the command words.
 *
 * Where a grammar is uncertain the reading fails toward RECOGNISING the command: a
 * mis-read option value lands in front of the command word, where the state
 * detector's unknown-command word scan still sees what follows.
 */
const COMMAND_RUNNING_WRAPPERS = new Map(
  Object.entries({
    // procps-ng watch, getopt "+bcCd::eghq:n:prs:tvwx". Without -x the operands
    // are joined and run through `sh -c`; with -x they are an argv. (BSD `watch`
    // snoops a tty and runs nothing; reading it as procps fails toward recognising.)
    watch: {
      short: { d: "optional", n: "value", q: "value", s: "value", x: "exec" },
      long: {
        beep: "flag",
        color: "flag",
        "no-color": "flag",
        differences: "optional",
        errexit: "flag",
        chgexit: "flag",
        equexit: "value",
        interval: "value",
        precise: "flag",
        "no-rerun": "flag",
        shotsdir: "value",
        "no-title": "flag",
        "no-wrap": "flag",
        "no-linewrap": "flag",
        exec: "exec",
        help: "flag",
        version: "flag",
      },
      run: "shell",
    },
    // util-linux flock, getopt "+sexnoFuw:E:hV". `flock <file> -c <cmd>` runs a
    // shell body, `flock <file> <cmd> [args]` an argv, a lone `flock <fd>` nothing.
    flock: {
      short: { w: "value", E: "value" },
      long: {
        shared: "flag",
        exclusive: "flag",
        unlock: "flag",
        nonblock: "flag",
        nonblocking: "flag",
        nb: "flag",
        timeout: "value",
        wait: "value",
        "conflict-exit-code": "value",
        close: "flag",
        "no-fork": "flag",
        verbose: "flag",
        help: "flag",
        version: "flag",
      },
      operands: 1,
      operandBody: ["-c", "--command"],
      run: "argv",
    },
    // moreutils `chronic [-ev] cmd`, expect `unbuffer [-p] cmd`.
    chronic: { run: "argv" },
    unbuffer: { run: "argv" },
    // macOS `arch [-32] [-64] [-<arch> | -arch <arch>] [-c] [-d env] [-e env=val] prog`.
    arch: {
      cluster: false,
      short: { d: "value", e: "value" },
      singleDashLong: { arch: "value" },
      run: "argv",
    },
    // macOS `caffeinate [-disu] [-t timeout] [-w pid] [utility args...]`.
    caffeinate: { short: { t: "value", w: "value" }, run: "argv" },
    // GNU `chroot [--userspec=U:G] [--groups=G] [--skip-chdir] NEWROOT [CMD...]`;
    // BSD `chroot [-G groups] [-g group] [-u user] newroot [command]`.
    chroot: {
      short: { G: "value", g: "value", u: "value" },
      long: {
        userspec: "value",
        groups: "value",
        "skip-chdir": "flag",
        help: "flag",
        version: "flag",
      },
      operands: 1,
      run: "argv",
    },
    // BSD `script [-aeFkqr] [-t time] [file [command ...]]` runs an argv after the
    // typescript file; util-linux `script -c <cmd> [file]` runs a shell body and
    // its getopt permutes. Both readings are extracted.
    script: {
      short: {
        c: "body",
        t: "value",
        T: "value",
        E: "value",
        I: "value",
        O: "value",
        B: "value",
        m: "value",
        o: "value",
      },
      long: {
        command: "body",
        timing: "optional",
        "log-timing": "value",
        "log-in": "value",
        "log-out": "value",
        "log-io": "value",
        "logging-format": "value",
        "output-limit": "value",
        echo: "value",
        append: "flag",
        return: "flag",
        flush: "flag",
        force: "flag",
        quiet: "flag",
        help: "flag",
        version: "flag",
      },
      permute: true,
      operands: 1,
      run: "argv",
    },
    // util-linux `su`/`runuser [options] [-] [user [args]]` run `-c`/`--command`/
    // `--session-command` through the shell, options permuting; BSD `su` hands the
    // args after the login name to the shell, where `-c <cmd>` is the same body.
    su: {
      short: { c: "body", g: "value", G: "value", s: "value", w: "value" },
      long: {
        command: "body",
        "session-command": "body",
        group: "value",
        "supp-group": "value",
        shell: "value",
        "whitelist-environment": "value",
        login: "flag",
        "preserve-environment": "flag",
        pty: "flag",
        fast: "flag",
        help: "flag",
        version: "flag",
      },
      permute: true,
      run: "none",
    },
    // GNU parallel runs its command through the shell (`-q` quotes it into an
    // argv) with the `:::` / `::::` argument lists appended. Getopt::Long with
    // require_order, so options precede the command.
    parallel: {
      short: {
        a: "value",
        C: "value",
        d: "value",
        E: "value",
        I: "value",
        j: "value",
        L: "value",
        N: "value",
        n: "value",
        P: "value",
        S: "value",
        s: "value",
        q: "exec",
      },
      long: {
        "arg-file": "value",
        colsep: "value",
        delimiter: "value",
        jobs: "value",
        "max-procs": "value",
        "max-args": "value",
        "max-lines": "value",
        "max-replace-args": "value",
        "max-chars": "value",
        replace: "value",
        sshlogin: "value",
        sshloginfile: "value",
        joblog: "value",
        results: "value",
        tmpdir: "value",
        timeout: "value",
        delay: "value",
        memfree: "value",
        load: "value",
        retries: "value",
        workdir: "value",
        basefile: "value",
        "tag-string": "value",
        halt: "value",
        termseq: "value",
        quote: "exec",
      },
      run: "shell",
      terminators: [":::", "::::", ":::+", "::::+"],
    },
    // shadow-utils `sg [-] <group> [-c] <command>` — the named-open residual of
    // the previous round. The group is a positional operand; with `-c` the next
    // word is a shell body, and without it the remaining words are joined and run
    // by the login shell, which is the `watch` reading. Measured before this
    // entry: `sg staff -c 'rm <state>'` returned null and
    // `sg staff -c 'git commit -m x'` parsed as no git invocation.
    sg: { operands: 1, operandBody: ["-c"], run: "shell" },
    // `nix-shell [-p pkgs] [--run <body>] [--command <body>] [file]`. Only the
    // body options run anything a fence can see — the positional operand is a
    // `.nix` FILE, the same residual class `bash script.sh` is — so `run: "none"`.
    // Its getopt permutes, so the body options are looked for across every word.
    "nix-shell": {
      short: { I: "value", A: "value" },
      long: {
        run: "body",
        command: "body",
        arg: "value",
        argstr: "value",
        attr: "value",
        keep: "value",
        packages: "flag",
        pure: "flag",
        help: "flag",
        version: "flag",
      },
      permute: true,
      run: "none",
    },
    // PACKAGE / ENVIRONMENT RUNNERS. Each is a MULTI-VERB front-end, so plain
    // GIT_WRAPPERS membership would be wrong: `pnpm install` runs no operand and
    // `uv pip list` names no command. `subcommands` says which verb switches the
    // remaining words into the argv reading `flock <file> <cmd>` already gets.
    //
    // SCOPE DECISION (stated rather than left implicit). The verb-form runners
    // below are MODELLED, because after the verb the next word IS the command
    // that executes. The PACKAGE-form runners — `npx`, `bunx`, `bun x`,
    // `pnpm dlx`, `yarn dlx`, `pipx run --spec`'s package slot — are DEFERRED as
    // a named residual and deliberately NOT modelled: their operand names a
    // PACKAGE to fetch, and every following word is an ARGUMENT to that package,
    // not a command. Reading `npx some-cli git push --force` as a git invocation
    // would fence a line that runs no git at all, and the git verb fence carries
    // `block`, so the over-read is worse than the under-read. Closing that form
    // needs package→binary knowledge this parser must not acquire (it would mean
    // reading `package.json`/the registry, a different and changing artifact than
    // the string the fence was handed). Residual recorded at the detector header.
    uv: {
      subcommands: ["run"],
      short: { p: "value", m: "value" },
      long: {
        with: "value",
        python: "value",
        directory: "value",
        project: "value",
        "env-file": "value",
        module: "value",
      },
      run: "argv",
    },
    poetry: {
      subcommands: ["run"],
      short: { C: "value" },
      long: { directory: "value", project: "value" },
      run: "argv",
    },
    pipx: {
      subcommands: ["run"],
      long: { spec: "value", python: "value" },
      run: "argv",
    },
    pnpm: { subcommands: ["exec"], short: { C: "value" }, run: "argv" },
    yarn: { subcommands: ["exec"], run: "argv" },
    // `mise exec [tool@version] -- <cmd>` puts a NON-OPTION operand before the
    // command, so the option walk stops early; `doubleDashStarts` restarts the
    // command at the word after `--`, which is the documented spelling.
    mise: {
      subcommands: ["exec", "x"],
      short: { C: "value" },
      long: { cd: "value", env: "value" },
      doubleDashStarts: true,
      run: "argv",
    },
    asdf: { subcommands: ["exec"], run: "argv" },
    // `direnv exec <dir> <cmd>` — the directory is a positional operand.
    direnv: { subcommands: ["exec"], operands: 1, run: "argv" },
    conda: {
      subcommands: ["run"],
      short: { n: "value", p: "value" },
      long: {
        name: "value",
        prefix: "value",
        cwd: "value",
        "live-stream": "flag",
        "no-capture-output": "flag",
      },
      run: "argv",
    },
  }),
);
// `micromamba`/`mamba` share conda's `run` grammar.
COMMAND_RUNNING_WRAPPERS.set("mamba", COMMAND_RUNNING_WRAPPERS.get("conda"));
COMMAND_RUNNING_WRAPPERS.set(
  "micromamba",
  COMMAND_RUNNING_WRAPPERS.get("conda"),
);
// util-linux `runuser` shares su's grammar, and adds `-u <user> [--] <cmd> [args]`,
// which runs an argv. Reading the operands as an argv even without `-u` fails
// toward recognising: the su-style `runuser root -c <cmd>` still yields its body.
COMMAND_RUNNING_WRAPPERS.set("runuser", {
  ...COMMAND_RUNNING_WRAPPERS.get("su"),
  short: { ...COMMAND_RUNNING_WRAPPERS.get("su").short, u: "value" },
  long: { ...COMMAND_RUNNING_WRAPPERS.get("su").long, user: "value" },
  run: "argv",
});

const hasOwn = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

// getopt_long accepts any unambiguous PREFIX of a long option (`--int 5`).
function resolveLongOption(name, table) {
  if (!name || !table) return undefined;
  if (hasOwn(table, name)) return table[name];
  const hits = Object.keys(table).filter((k) => k.startsWith(name));
  return hits.length === 1 ? table[hits[0]] : undefined;
}

/**
 * The commands a COMMAND_RUNNING_WRAPPERS entry runs, reading `toks` from `from`
 * (the word after the wrapper's name) under grammar `g`. Returns the
 * `{ commands, unresolvable }` shape `nestedCommandStrings` returns. A body or
 * shell-run operand list carrying an unexpandable word is unresolvable, the verdict
 * `eval "$X"` gets; an argv is unresolvable only when its COMMAND word is, the
 * verdict `find -exec` gets.
 */
function wrapperCommandStrings(toks, from, g) {
  const commands = [];
  let unresolvable = false;
  let exec = false;
  const takeBody = (tok, attached) => {
    if (!tok) return;
    if (tok.unexpandable) {
      unresolvable = true;
      return;
    }
    const text = attached === null ? tok.value : attached;
    if (text.trim()) commands.push(text);
  };
  // The index of the last word the option at `j` consumes, or -1 for a non-option.
  // A leading `-` is literal even in a word carrying a substitution.
  const readOption = (j) => {
    const tok = toks[j];
    const t = tok.value;
    if (t === "-" || !t.startsWith("-")) return -1;
    const apply = (kind, attached) => {
      if (kind === "exec") exec = true;
      if (kind === "body") {
        takeBody(attached === null ? toks[j + 1] : tok, attached);
      }
      const takesNext = kind === "value" || kind === "body";
      return takesNext && attached === null ? j + 1 : j;
    };
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq === -1 ? t.slice(2) : t.slice(2, eq);
      const attached = eq === -1 ? null : t.slice(eq + 1);
      return apply(resolveLongOption(name, g.long), attached);
    }
    const word = t.slice(1);
    if (hasOwn(g.singleDashLong, word)) {
      return apply(g.singleDashLong[word], null);
    }
    if (g.cluster === false) {
      return apply(hasOwn(g.short, word) ? g.short[word] : undefined, null);
    }
    for (let k = 0; k < word.length; k++) {
      const kind = hasOwn(g.short, word[k]) ? g.short[word[k]] : undefined;
      if (kind === "exec") exec = true;
      else if (kind === "optional") return j;
      else if (kind === "value" || kind === "body") {
        const rest = word.slice(k + 1);
        return apply(kind, rest ? rest : null);
      }
    }
    return j;
  };

  // A MULTI-VERB front-end runs nothing until its runner verb appears, and the
  // verb may sit behind the front-end's own options (`conda --no-plugins run …`,
  // `uv --directory x run …`), so the search is a forward scan rather than a test
  // of the first word. No verb ⇒ this invocation runs no operand command.
  if (g.subcommands) {
    let s = from;
    while (s < toks.length && !g.subcommands.includes(toks[s].value)) s++;
    if (s >= toks.length) return { commands, unresolvable };
    from = s + 1;
  }

  let j = from;
  let optionsEnded = false;
  for (; j < toks.length; j++) {
    if (toks[j].value === "--") {
      j++;
      optionsEnded = true;
      break;
    }
    const end = readOption(j);
    if (end === -1) break;
    j = end;
  }
  // After an explicit `--` nothing is an option, so there is nothing to permute.
  if (g.permute && !optionsEnded) {
    for (let p = j; p < toks.length; p++) {
      if (toks[p].value === "--") break;
      const end = readOption(p);
      if (end !== -1) p = end;
    }
  }
  let k = Math.min(j + (g.operands || 0), toks.length);
  // An explicit `--` separates the wrapper's own operands from the command, so
  // where the grammar says so it, not the operand count, decides where the
  // command starts — the option walk above stops at the FIRST non-option
  // (`node@20`), which would otherwise read the tool spec as the command word.
  if (g.doubleDashStarts) {
    for (let p = from; p < toks.length; p++) {
      if (toks[p].value === "--") {
        k = p + 1;
        break;
      }
    }
  }
  if (g.operandBody && k < toks.length && g.operandBody.includes(toks[k].value)) {
    takeBody(toks[k + 1], null);
    return { commands, unresolvable };
  }
  if (g.run === "none" && !exec) return { commands, unresolvable };
  let stop = toks.length;
  if (g.terminators) {
    for (let p = k; p < toks.length; p++) {
      if (g.terminators.includes(toks[p].value)) {
        stop = p;
        break;
      }
    }
  }
  const rest = toks.slice(k, stop);
  if (!rest.length) {
    // GNU parallel given NO command runs each argument as a command line, so
    // `parallel ::: 'rm <state>'` runs rm. An argument FILE after `::::` is read
    // the same way, which fails toward recognising.
    if (stop < toks.length) {
      for (let p = stop + 1; p < toks.length; p++) {
        if (!g.terminators.includes(toks[p].value)) takeBody(toks[p], null);
      }
    }
    return { commands, unresolvable };
  }
  if (exec || g.run === "argv") {
    if (rest[0].unexpandable) unresolvable = true;
    else commands.push(rejoinTokens(rest));
  } else if (rest.some((t) => t.unexpandable)) {
    unresolvable = true;
  } else {
    const body = rest.map((t) => t.value).join(" ");
    if (body.trim()) commands.push(body);
  }
  return { commands, unresolvable };
}

/**
 * The COMMAND STRINGS a segment runs through a COMMAND SUBSTITUTION — the bodies
 * of `$(…)`, of backticks, and of process substitution `<(…)` / `>(…)`.
 *
 * loom T65. `tokenize` has consumed `$(…)` and backticks ATOMICALLY since
 * loom#1549 F3 lock 8 (so the enclosing token is `unexpandable` and the
 * subcommand POSITION after it parses correctly), and `violation-patterns.js`
 * has descended into those bodies since loom#1431 via its own private
 * `substitutionBodies`. The git/gh path never did, which is a live guard gap,
 * not a cosmetic one — MEASURED on a pinned `origin/dev` worktree, against a
 * genuinely DIRTY tree, with the bare spelling as the positive control on the
 * SAME tree:
 *
 *   git reset --hard HEAD              -> deny, rc=2        (control FIRES)
 *   echo $(git reset --hard HEAD)      -> "Validated", rc=0 (no finding at all)
 *   `git reset --hard HEAD`            -> "Validated", rc=0
 *   $(git reset --hard HEAD)  (cmd slot)-> "Validated", rc=0
 *
 * and the LOSS was demonstrated, not inferred: an uncommitted `M tracked.txt`
 * became clean while the fence reported success. The heredoc was INCIDENTAL —
 * it fails with no heredoc at all, so this is a parser gap rather than a
 * quoting one.
 *
 * WHY THE BODY IS A COMMAND STRING AND NOT "expanded text". A substitution RUNS
 * the command in its body, wherever the construct sits: in argument position
 * (`echo $(git reset --hard HEAD)`), in the command slot (`$(git …)`), inside
 * `sh -c '…'`, inside another substitution. Extracting the body and re-parsing
 * it asks the SAME structural question one level down — it is extraction, not
 * evaluation, so `hook-output-discipline.md` Rule 3 / `security.md` § no-eval
 * are both untouched.
 *
 * PLACED IN `nestedCommandStrings` DELIBERATELY, and this is the load-bearing
 * choice. That function is the ONE extractor of "command strings nested inside a
 * segment", consumed by `expandNestedSegments` — hence by `parseGitInvocations`,
 * `parseGhInvocations`, `validate-bash-command.js` and
 * `violation-patterns.js::lineExpansions`. A descent written into
 * `parseGitInvocations` alone would have been a THIRD lineage of substitution
 * descent (tokenize's atomic grouping, `substitutionBodies`, and the new one)
 * and would have missed `validate-bash-command.js`, which calls
 * `expandNestedSegments` directly and never goes through `parseGitInvocations`.
 * `security.md` § Enforcement-Surface Parity: one shared function, so the next
 * hardening reaches every surface.
 *
 * QUOTING IS THE WHOLE CORRECTNESS SURFACE, in BOTH directions:
 *   - SINGLE quotes are LITERAL: `'$(git reset --hard HEAD)'` runs nothing, and
 *     extracting it would refuse legitimate work — the failure this fence must
 *     NOT introduce. Skipped. (`tokenize` already declines to mark such a token
 *     `unexpandable`, which is the same fact reached from the other side.)
 *   - DOUBLE quotes still EXPAND: `"$(git …)"` and `` "`git …`" `` both run, so
 *     both are extracted — INCLUDING when the same double-quoted string also
 *     contains an apostrophe. That last clause is not decoration: the first cut
 *     of this scanner set `quote = "'"` with no state guard, so a `'` inside a
 *     `"…"` span opened a literal span bash never entered and silenced every
 *     substitution AFTER it (F1, and it defeated this arm's own claim). The
 *     branch now reads `c === "'" && quote === null`; the claim and the code
 *     are the same statement again.
 *   - Process substitution is NOT recognised inside double quotes (`"<(x)"` is
 *     literal text), so that arm is gated on `quote === null`.
 *   - `$'…'` (ANSI-C) is literal in the same way single quotes are: the `'` opens
 *     the literal span below and the body is skipped.
 *   - An unterminated construct (`$(a && b)` cut in half by the segment splitter)
 *     yields the PARTIAL body, which is the fail-CLOSED direction: the fragment
 *     is still re-parsed for the verb it does contain.
 *
 * ⛔ DO NOT "RESTORE SYMMETRY" ACROSS THE QUOTE BRANCHES. The single-quote
 * branch now carries the `quote === null` guard and the BACKTICK branch does
 * NOT — that asymmetry is CORRECT and load-bearing, not an oversight to tidy up.
 * A backtick DOES expand inside double quotes, so adding the guard there would
 * silently stop extracting `` "`git reset --hard HEAD`" ``, which this scanner
 * catches today; and the same edit is the one that would "fix" F1 into a new
 * hole. `tests/integration/multi-operator/t65-f1-apostrophe-double-quote.test.js`
 * carries a canary row that reds on exactly that edit and whose failure message
 * says so.
 *
 * The reverse asymmetry is deliberate too: SINGLE quotes are skipped with no
 * expansion at all, so they carry no extraction and need no guard beyond the
 * state test above. Three branches, three different correct forms, and the only
 * way to tell them apart is to ask what BASH does at that character — not what
 * makes the three lines look alike.
 *
 * ⛔ KNOWN RESIDUAL — AN APOSTROPHE IN AN UNQUOTED HEREDOC BODY BLINDS THE REST
 * OF THE BODY, AND THE F1 GUARD IS *CORRECT* HERE. A retained heredoc body
 * arrives at this function as ONE SEGMENT WITH EMBEDDED NEWLINES — the splitter
 * does not split inside it — so an apostrophe opens a literal span that swallows
 * every later line of the same body, including a `$(…)` that bash really does
 * run. MEASURED, control firing (bare heredoc carrying the same substitution is
 * seen; the apostrophe is what blinds it):
 *
 *   cat <<EOF ⏎ $(git … reset --hard HEAD) ⏎ EOF          -> seen
 *   cat <<EOF ⏎ don't ⏎ $(git … reset --hard HEAD) ⏎ EOF  -> BLIND
 *
 * The instrumented segmentation, so the mechanism is not guessed at: the two
 * segments are `cat <<EOF` and `don't\n$(git … reset --hard HEAD)\nEOF`. There is
 * no newline for a span to "cross" — the body was never split, so this walk runs
 * a LINE-oriented quote model over multi-line DATA.
 *
 * ⛔ DO NOT FIX THIS BY MAKING THE F1 GUARD DECLINE. The apostrophe here is
 * genuinely UNQUOTED, so `quote === null` is TRUE and `c === "'" && quote ===
 * null` fires exactly as designed. Narrowing it would be wrong. This is DATA
 * whose only live parts are its substitutions: the fix belongs in how a retained
 * heredoc body is segmented, or in making a newline terminate a quote span inside
 * one — never in the guard. Bound by the `todo` row in
 * `tests/integration/multi-operator/t65-declared-residuals.test.js`.
 * SEVERITY: a MISSED BLOCK (the destructive fence returns ALLOW while the
 * substitution discards uncommitted work), pre-existing at both trees.
 *
 * `$((…))` is ARITHMETIC, and falls out correctly rather than being special-cased:
 * the scanner enters at the `$(`, `scanBalanced` counts the second `(` as
 * NESTING, and the body is handed over as `(1+1)` — which strips to `1+1` and
 * parses as no command at all. What it must not do is refuse the form, and it
 * does not (fixture: `$((1+1))` stays silent). It must also not MISS a real
 * substitution nested inside arithmetic (`$(( $(git rev-parse HEAD) + 1 ))`),
 * which it does not — `expandNestedSegments` re-scans every body it is handed.
 *
 * `stripShellComments` masks first so a `$(…)` in a trailing COMMENT is not read
 * as a live construct. It blanks bytes and preserves offsets, so the scan and the
 * returned slices still index the caller's own text; the two call sites that have
 * already stripped comments are unaffected because the mask is idempotent.
 */
function substitutionCommandStrings(seg) {
  const v = stripShellComments(String(seg || ""));
  const out = [];
  let quote = null; // "'" (literal) | '"' (expanding) | null (expanding)
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    // A backslash escapes the next character in unquoted and double-quoted text
    // alike, so an escaped opener (`\$(…)`) is literal and is skipped here.
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'" && quote === null) {
      quote = "'";
      continue;
    }
    if (c === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (c === "`") {
      const end = scanBalanced(v, i + 1, "\0", "`");
      const closed = end - 1 > i && v[end - 1] === "`";
      out.push(v.slice(i + 1, closed ? end - 1 : end));
      i = end - 1;
      continue;
    }
    if (c === "$" && v[i + 1] === "(") {
      if (v[i + 2] === "(") {
        // `$((…))` is ARITHMETIC — an expression, never a command list. The
        // extraction used to hand `( … )` to the walk as a command string, so
        // `echo "sum: $(( $(a) + $(b) ))"` reported a phantom command (Tier-1
        // round 5, over-denial). Skip the opener but KEEP SCANNING INSIDE, so a
        // real substitution nested in the arithmetic is still found.
        i += 2;
        continue;
      }
      const end = scanBalanced(v, i + 2, "(", ")");
      out.push(v.slice(i + 2, v[end - 1] === ")" ? end - 1 : end));
      i = end - 1;
      continue;
    }
    // Process substitution — an ARGUMENT (`/dev/fd/N`) whose command still RUNS,
    // so its body is a command string like any other. Gated on unquoted AND on a
    // single `<`/`>`: `<<(EOF)` is a heredoc whose DELIMITER begins with `(`, and
    // `>>(x)` is a redirect to a file literally named `(x)` — neither runs
    // anything, and extracting them would refuse legitimate work.
    if (
      quote === null &&
      (c === "<" || c === ">") &&
      v[i + 1] === "(" &&
      v[i - 1] !== c
    ) {
      const end = scanBalanced(v, i + 2, "(", ")");
      out.push(v.slice(i + 2, v[end - 1] === ")" ? end - 1 : end));
      i = end - 1;
      continue;
    }
  }
  return out.filter((b) => b.trim());
}

// The ONE stop predicate of the nested-body walk: a shell/eval name, `find`, or
// a COMMAND_RUNNING_WRAPPERS word. Folded through the ONE helper (ruling
// 2026-10-04): `FIND`, `WATCH` and any case-varied wrapper name reach their
// grammar exactly as the lowercase spelling does.
const NESTING_STOP = (tok) =>
  isNestingCommandToken(tok.value) ||
  foldedBasename(tok.value) === "find" ||
  (!tok.unexpandable && COMMAND_RUNNING_WRAPPERS.has(foldedBasename(tok.value)));

function nestedCommandStringsInner(seg) {
  return nestingFromTokens(stripRedirectionTokens(tokenize(String(seg || ""))), 0);
}

/** The token-array walk (see nestedCommandStringsInner). The recursion lives
 * HERE so the multicall applet re-entry (SEC-B-3) passes tokens with their
 * marks intact and NEVER re-serialises (the round-2 `rejoinTokens` re-entry
 * lost quoting: a quote-stripped value re-parsed as NEW quoting and swallowed
 * the `-c`). */
function nestingFromTokens(toks, multicallHop) {
  const empty = { commands: [], unresolvable: false };
  const split = envSplitStringCommand(toks);
  if (split) return split;
  const scan = scanCommandPrefix(toks, NESTING_STOP);

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

  const name = foldedBasename(toks[scan.idx].value); // folded through the ONE helper (ruling 2026-10-04)
  // MULTICALL APPLET (2026-10-04, SEC-B-3): busybox/toybox ARE shell names AND
  // launchers, so the walk used to stop AT them and the applet's grammar was
  // never reached — and the round-2 re-entry went through `rejoinTokens`, whose
  // re-serialisation LOST QUOTING (`busybox env "X=$Y'" sh -c BODY` was
  // allowed). The re-entry passes the TOKEN ARRAY with its marks intact and
  // never re-serialises; past the bound the read refuses rather than answering.
  if (MULTICALL_BINARIES.has(name)) {
    if (multicallHop >= MULTICALL_HOP_BOUND) return { commands: [], unresolvable: true };
    return nestingFromTokens(toks.slice(scan.idx + 1), multicallHop + 1);
  }
  let i = scan.idx + 1;

  if (name === "find") return findExecCommands(toks, i);

  const grammar = COMMAND_RUNNING_WRAPPERS.get(name);
  if (grammar) return wrapperCommandStrings(toks, i, grammar);

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
  // clustered (`bash -lc '…'`, `sh -ec '…'`) or bare (`sh -c '…'`), which is a
  // spelling an agent emits and which a bare `t === "-c"` test misses —
  // measured: `bash -lc 'git commit -m x'` committed for real against an
  // `allow` verdict. The candidates are picked by `shellCandidateBodies`,
  // SHARED with the Codex array adapter, FAIL-CLOSED BY CONSTRUCTION: EVERY
  // word after a command-position shell is a candidate body and ALL of them
  // are returned, so no shell dialect can hide one (see its doc comment).
  // WHOLE TOKENS are passed, not their values (H3, security ruling 2026-10-03):
  // the previous form mapped to `.value` first, so an `unexpandable` mark was
  // GONE before the reader saw the words and an option produced by an expansion
  // (`sh $FLAGS BODY`) yielded no candidates and no unresolvable mark — a
  // silent allow. An unexpandable candidate keeps the fail-closed
  // `unresolvable` mark AND does not suppress its expandable siblings.
  const { candidates, unresolvable: shellUnresolvable } = shellCandidateBodies(toks.slice(scan.idx), {
    // The slice starts AT the shell word, so the re-entered scan cannot see the
    // wrapper THIS walk already passed — forward the foot fact explicitly
    // (`command grep -rln 'fish' .`: fish reached past the unknown `grep`).
    tolerateNonPathScriptOperand: scan.sawUnknownCommandWord === true,
  });
  if (!candidates.length) return shellUnresolvable ? { commands: [], unresolvable: true } : empty;
  const commands = [];
  let unresolvable = shellUnresolvable;
  for (const c of candidates) {
    if (c.unexpandable) { unresolvable = true; continue; }
    if (c.value.trim()) commands.push(c.value);
  }
  return { commands: [...new Set(commands)], unresolvable };
}

/**
 * The COMMAND STRINGS nested inside a segment — the wrapper bodies
 * (`sh -c` / `eval` / `env -S` / `find -exec` / the COMMAND_RUNNING_WRAPPERS
 * table) AND the COMMAND SUBSTITUTIONS (`$(…)`, backticks, process
 * substitution) found anywhere in the segment's text.
 *
 * The two halves are computed separately and CONCATENATED rather than merged
 * into one walk, because they answer from different evidence: the first from the
 * tokenizer's command-POSITION analysis, the second from a quote-aware text scan
 * (a `<(` never becomes a token at all — the tokenizer deliberately leaves the
 * bracket ungrouped so the redirection recognizer cannot delete a real operand).
 * Merging them would mean teaching one walk both facts.
 *
 * ORDER IS LOAD-BEARING for a reader of the result, not for correctness:
 * wrapper bodies come first because they are the more PRECISE reading (a `-c`
 * operand is KNOWN to be a command), so a consumer taking `commands[0]` gets the
 * narrower one. Every consumer today walks the whole list.
 *
 * BOTH HALVES RECURSE. `expandNestedSegments` walks each returned command and
 * calls this function again, so `sh -c 'echo $(git reset --hard HEAD)'` and
 * `$(sh -c 'git reset --hard HEAD')` both reach the same verb. A substitution
 * body is a STRICT SUBSTRING of its carrier, so termination on length alone
 * holds here exactly as it does for the wrapper half.
 */
function nestedCommandStrings(seg) {
  const base = nestedCommandStringsInner(seg);
  const subs = substitutionCommandStrings(seg);
  if (!subs.length) return base;
  return {
    commands: base.commands.concat(subs),
    unresolvable: base.unresolvable,
  };
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
  // For every emitted segment, the INDEX (in `out`) of the ORIGINAL depth-0
  // segment it descends from — its own index for an original. Consumed by
  // `parseGitInvocations` to drop a nested body's record when the original it
  // came from ALREADY reported the same git invocation: since the inversion
  // both routes resolve `sudo chroot / setuidgid 0 git reset --hard HEAD` and
  // the same command was reported twice (measured ['reset','reset'] against
  // base/h2's ['reset']).
  const parents = [];
  let truncated = false;
  let unresolvable = false;
  const walk = (segs, depth, owner) => {
    for (const s of segs || []) {
      const text = typeof s === "string" ? s : s && s.text;
      if (typeof text !== "string" || !text.trim()) continue;
      const self = out.length;
      out.push(text);
      parents.push(depth === 0 ? self : owner);
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
          splitShellSegments(maskCasePatterns(cleaned), { newlineSeparates: true }),
          depth + 1,
          depth === 0 ? self : owner,
        );
      }
    }
  };
  walk(segments, 0, -1);
  return { segments: out, parents, truncated, unresolvable };
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
  const toks = stripRedirectionTokens(tokenize(raw));

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
    // SEC-B-2 (security ruling 2026-10-04): a BRACE/GLOB word at the
    // command-name position may expand to ANY command — `{git,reset,--hard}`
    // expands to exactly a git invocation — so the verb cannot be known and the
    // segment REFUSES through the existing unresolvable-subcommand lane. A
    // `$`-word keeps the documented command-slot allowance ("command" is NOT in
    // the refuse set); only the forms the shell RESOLVES BEFORE RUNNING
    // (brace/glob) refuse here. A lone `[` (the test builtin) carries no
    // closing bracket and is not a glob — it does not fire.
    const csVal = toks[scan.commandSlotIdx] ? String(toks[scan.commandSlotIdx].value) : "";
    if (
      !scan.sawWrapperOperand &&
      (/^\{/.test(csVal) || /[*?]/.test(csVal) || /\[[^\]]*\]/.test(csVal))
    ) {
      return { sub: null, dir: null, args: "", argv: [], unresolvable: "subcommand" };
    }
    // Tier-1 round 4: a brace/glob AFTER a resolved wrapper operand is an
    // ARGUMENT (`time ls *.txt`, `sudo grep x *.js`, `command cat {a,b}.txt`) —
    // inert, not a command name; only the no-operand shape (`{git,reset,--hard}`
    // at the head) refuses.
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
    // If the COMMAND NAME itself was unresolvable, that alone is still
    // reportable — `$(which foo) --bar` names no verb this parser can see, and
    // reporting null would put it back on the fail-OPEN path. `"command"` (not
    // `"subcommand"`) is deliberate: there is no evidence a git verb is present
    // at all, so the mark says exactly what is unknown and lets the consumer set
    // its own threshold.
    //
    // This branch is reached with `sawUnexpandable` EITHER way and the answer is
    // the same, which is the loom#1594 fix. `sawUnexpandable` records only that
    // SOME word at/after the command slot was opaque; when no git token was ever
    // found, those words are the operands of an UNKNOWN command, so they are no
    // evidence of a hidden git VERB. Gating this return on `!sawUnexpandable`
    // sent `$(which foo) --bar $(date)` to the `"subcommand"` return below — a
    // member of UNRESOLVABLE_COMMAND_IDENTITY, the mark consumers rank TIGHTEST —
    // and produced a live halt-and-report saying git was invoked on a command
    // that never mentions git. The `"command"` boundary documented at this file's
    // UNRESOLVABLE_COMMAND_IDENTITY declaration (`:167-187`) names `command -v
    // "$1"` as exactly this case; this site and the precedence ladder at the
    // function's final return simply never consulted it.
    if (commandSlotUnresolved) {
      return {
        sub: null,
        dir: workTree || cDir,
        args: "",
        argv: [],
        unresolvable: "command",
      };
    }
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
    //
    // The `!commandSlotUnresolved` conjunct is the loom#1594 fix and is the same
    // reasoning the `i >= toks.length` branch above now applies. An opaque word
    // in the VERB SLOT promotes to `"subcommand"` — the tightest-ranked mark —
    // only when a git token was ACTUALLY found (literal, path-qualified,
    // backslashed, or the fused `git$IFS` form, which returns earlier). With no
    // git token, the slot holds the second word of an UNKNOWN command, so
    // `"subcommand"` would assert a hidden git VERB on no evidence: `$(echo
    // node) -e $(cat s)` and `"$PWD/x.js" $(date)` each produced a live
    // halt-and-report reading "Bash invoked git with a subcommand this hook
    // cannot resolve". Dropping only this leg leaves the rest of the ladder
    // intact, so such a segment falls through to `"dir"` or `"command"` exactly
    // as it would have without the opaque verb word — and every genuine git
    // invocation keeps the mark unchanged.
    unresolvable:
      toks[i].unexpandable && !commandSlotUnresolved
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
// ── CASE-PATTERN MASKING (Tier-1 round 5, over-denial) ─────────────────────
// A `case` BRANCH PATTERN is not a command slot: `*)`, `\ *|/*)`, `"R "*` are
// words the shell MATCHES, never commands it runs. Segmentation runs before any
// grammar, so it split `\ *|/*)` at the `|` and handed `/*)` and `*)` to the
// fence as command words — three refusals on one ordinary scroll-and-classify
// loop. This pass blanks each PATTERN (and its closing `)`) BEFORE segmenting,
// leaving branch BODIES intact so their commands stay visible. Conservative by
// construction: a statement is masked only when a command-position `case` can
// be followed through `in`, every branch's closing `)`, and the terminators
// (`;;` / `;&` / `;;&`) to `esac`; anything unexpected abandons the mask for
// that statement and the prior behaviour stands (under-masking is safe,
// over-masking would hide a real command, so every bail keeps the raw text).
function maskCasePatterns(raw) {
  const v = String(raw || "");
  if (!v.includes("case")) return v;
  const n = v.length;
  const isIdent = (c) => c !== undefined && /[A-Za-z0-9_]/.test(c);
  const skipQuote = (i) => {
    const c = v[i];
    if (c === "\\") return i + 2;
    if (c === "'") {
      const e = v.indexOf("'", i + 1);
      return e === -1 ? n : e + 1;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (v[j] === "\\") {
          j += 2;
          continue;
        }
        if (v[j] === '"') return j + 1;
        j++;
      }
      return n;
    }
    return i;
  };
  const skipSubst = (i) => {
    if (v[i] === "`") return scanBalanced(v, i + 1, "\0", "`");
    if (v[i] === "$" && v[i + 1] === "(") return scanBalanced(v, i + 2, "(", ")");
    return i;
  };
  const commandPosition = (i) => {
    let j = i - 1;
    while (j >= 0 && (v[j] === " " || v[j] === "\t")) j--;
    if (j < 0) return true;
    return ";&|({\n".includes(v[j]);
  };
  const wordAt = (i, w) => v.startsWith(w, i) && !isIdent(v[i - 1]) && !isIdent(v[i + w.length]);
  const oneStatement = (from) => {
    const ranges = [];
    // 1. the `in` keyword (POSIX `case WORD in`).
    let i = from;
    let inAt = -1;
    const bound = Math.min(n, from + 2000);
    while (i < bound) {
      if (v[i] === "\\" || v[i] === "'" || v[i] === '"') { i = skipQuote(i); continue; }
      if (v[i] === "`" || (v[i] === "$" && v[i + 1] === "(")) { i = skipSubst(i); continue; }
      if (wordAt(i, "in")) { inAt = i + 2; break; }
      i++;
    }
    if (inAt === -1) return null;
    let cursor = inAt;
    // 2. branches: PATTERN `)` BODY ( `;;` | `;&` | `;;&` ) … until `esac`.
    while (cursor < n) {
      while (cursor < n && /\s/.test(v[cursor])) cursor++;
      if (cursor >= n) return null;
      if (wordAt(cursor, "esac")) return { ranges, end: cursor + 4 };
      let closeParen = -1;
      let j = cursor;
      while (j < n) {
        if (v[j] === "\\" || v[j] === "'" || v[j] === '"') { j = skipQuote(j); continue; }
        if (v[j] === "`" || (v[j] === "$" && v[j + 1] === "(")) { j = skipSubst(j); continue; }
        if (v[j] === ")") { closeParen = j; break; }
        if (wordAt(j, "esac")) return null;
        j++;
      }
      if (closeParen === -1) return null;
      // FIX ROUND f — a POSIX case PATTERN still undergoes command substitution:
      // `case x in $(git reset --hard HEAD)) ;; esac` really RUNS the reset. The
      // masker originally blanked the whole pattern span, ERASING the `$( )` from
      // the text every parseGitInvocations consumer scans (MEASURED reader-level
      // regression vs base: base extracts sub:"reset", e returned []). So blank
      // only the span's LITERAL text: the complement of its substitution spans.
      {
        const subs = [];
        let q = cursor;
        while (q < closeParen) {
          if (v[q] === "\\" || v[q] === "'" || v[q] === '"') { q = skipQuote(q); continue; }
          if (v[q] === "`" || (v[q] === "$" && v[q + 1] === "(")) {
            const end = skipSubst(q);
            subs.push([q, Math.min(end, closeParen + 1)]);
            q = end;
            continue;
          }
          q++;
        }
        let at = cursor;
        for (const [a, b] of subs) {
          if (a > at) ranges.push([at, a]);
          at = Math.max(at, b);
        }
        if (at < closeParen + 1) ranges.push([at, closeParen + 1]);
      }
      let k = closeParen + 1;
      let term = -1;
      while (k < n) {
        if (v[k] === "\\" || v[k] === "'" || v[k] === '"') { k = skipQuote(k); continue; }
        if (v[k] === "`" || (v[k] === "$" && v[k + 1] === "(")) { k = skipSubst(k); continue; }
        if (v.startsWith(";;&", k)) { term = k + 3; break; }
        if (v.startsWith(";;", k) || v.startsWith(";&", k)) { term = k + 2; break; }
        if (wordAt(k, "esac")) { term = k; break; }
        k++;
      }
      if (term === -1) return null;
      cursor = term;
    }
    return null;
  };
  const ranges = [];
  let i = 0;
  let guard = 0;
  while (i < n && guard++ < 4000) {
    if (v[i] === "\\" || v[i] === "'" || v[i] === '"') { i = skipQuote(i); continue; }
    if (v[i] === "`" || (v[i] === "$" && v[i + 1] === "(")) { i = skipSubst(i); continue; }
    if (v[i] === "c" && wordAt(i, "case") && commandPosition(i)) {
      const stmt = oneStatement(i + 4);
      if (stmt) {
        ranges.push(...stmt.ranges);
        i = stmt.end;
        continue;
      }
    }
    i++;
  }
  if (!ranges.length) return v;
  const out = v.split("");
  for (const [a, b] of ranges) for (let k = a; k < b && k < n; k++) out[k] = " ";
  return out.join("");
}

function parseGitInvocations(command) {
  const cleaned = dispatchSurface(command);
  if (!cleaned.trim()) return [];
  const top = splitShellSegments(maskCasePatterns(cleaned), { newlineSeparates: true });
  // Nested shell bodies are commands too (loom#1589) — see expandNestedSegments.
  const nested = expandNestedSegments(top);
  const out = [];
  // PRECISE ROUTE WINS over its own over-approximation. The inversion lets the
  // top-level walk see through an unknown launcher word, so a segment like
  // `sudo chroot / setuidgid 0 git reset --hard HEAD` now resolves BOTH at the
  // top level and again through its extracted nested body — the same command,
  // reported twice (measured ['reset','reset']; base and h2 report ['reset'],
  // via the nested route alone). A nested-derived record is dropped ONLY when
  // the ORIGINAL segment it descends from already reported an equal invocation
  // (sub/dir/mark/argv). Duplicates between ORIGINALS (a literal
  // `git reset … ; git reset …`) and between SIBLING nested bodies
  // (`$(git reset …) $(git reset …)`) are real invocations and never dropped.
  // The key includes argv, so a substitution's body and its carrier differ
  // (the carrier's argv holds the substitution placeholder) and neither is
  // suppressed.
  const keyOf = (g) => JSON.stringify([g.sub, g.dir, g.unresolvable ?? null, g.argv]);
  const topKeysBySegment = new Map();
  for (let k = 0; k < nested.segments.length; k += 1) {
    const g = parseGitInvocation(nested.segments[k]);
    if (!g) continue;
    const owner = nested.parents[k];
    if (owner === k) {
      let keys = topKeysBySegment.get(k);
      if (!keys) topKeysBySegment.set(k, (keys = new Set()));
      keys.add(keyOf(g));
      out.push(g);
      continue;
    }
    if (topKeysBySegment.get(owner)?.has(keyOf(g))) continue;
    out.push(g);
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
 * WHICH DIRECTORY do this command's later segments actually run in?
 *
 * A hook's payload `cwd` is the SESSION directory, and in this repo's own
 * workflow that is the MAIN CHECKOUT while the work happens in a linked
 * worktree reached by a `cd <wt> &&` prefix on the command itself. A guard that
 * resolves a command's relative path argument against the payload `cwd` is
 * therefore resolving against a tree the command never enters — it reads a
 * DIFFERENT file, or (far more often) no file at all.
 *
 * This is the SAME walk `validate-bash-command.js` already performs inline for
 * its worktree stale-base probe, extracted so a second consumer cannot grow a
 * second lineage of it (`security.md` § Multi-Site Kwarg Plumbing, the one-parser
 * rationale this whole module was extracted on). Its conservatism is inherited
 * verbatim and is load-bearing:
 *
 *   - Heredoc BODIES are stripped and doc-carrier payloads masked FIRST, so a
 *     `cd` mentioned in prose being written to a file is not applied.
 *   - The trail is trusted ONLY for a homogeneous `&&` chain or a homogeneous
 *     `;`/newline chain. Any pipeline, subshell, backgrounding, or a MIX of `&&`
 *     with `;` makes it unknowable: `cd <B> | cat ; cmd` runs the cd in a
 *     SUBSHELL, and `a || cd <B> ; cmd` runs it only on a failure that has not
 *     happened yet. Reconstructing the shell's control flow is not attempted.
 *   - Only `cd <one literal operand>` / `pushd <one literal operand>` is applied.
 *     A bare `cd`, `cd -`, `popd`, an option form, or an operand carrying
 *     `$` `` ` `` `*` `?` `~` marks the directory UNKNOWN.
 *   - A `cd` to something that is not a directory FAILS in the shell, leaving it
 *     where it was, so the trail is unchanged rather than advanced; a path that
 *     cannot be stat'ed is UNKNOWN.
 *
 * FAIL DIRECTION. `known: false` means "do not use this" — every caller is
 * expected to fall back to whatever root it used before rather than guess, so an
 * untrackable command lands on the caller's PRE-EXISTING behaviour and never on
 * an invented directory.
 *
 * @param {string} command the raw shell command string
 * @param {string} baseDir the directory the command STARTS in (the payload cwd)
 * @param {{stopWhen?:(segment:string)=>boolean}} [opts] stop before the segment
 *   the caller cares about, so a LATER `cd` is not applied to an EARLIER command
 * @returns {{dir:string|null, known:boolean}}
 */
function resolveCdTrailDir(command, baseDir, opts = {}) {
  const base = typeof baseDir === "string" && baseDir ? baseDir : null;
  if (!base) return { dir: null, known: false };
  const cmd = String(command || "");
  if (!cmd) return { dir: base, known: true };
  // No `cd`/`pushd` token at all → the command runs where it started. Cheap
  // exact exit, not a heuristic: the walk below can only ever move the
  // directory through one of those two verbs.
  if (!/(?:^|[^\w./-])(?:cd|pushd|popd)(?=\s|$)/.test(cmd)) {
    return { dir: base, known: true };
  }

  const spans =
    cmd.indexOf("<<") === -1 ? { structural: cmd } : parseHeredocSpans(cmd);
  const masked = maskDocCarrierPayloads(spans.structural || "");
  const hasPipe = /\|/.test(masked);
  const hasAmp = /&/.test(masked);
  const hasSeq = /[;\n]/.test(masked);
  const trailTrustworthy =
    !hasPipe && !/[()]/.test(masked) && !(hasAmp && hasSeq);

  let dir = base;
  for (const seg of splitShellSegments(masked, { newlineSeparates: true })) {
    const t = seg.trim();
    if (typeof opts.stopWhen === "function" && opts.stopWhen(t)) break;
    if (!/(?:^|[^\w./-])(?:cd|pushd|popd)(?=\s|$)/.test(t)) continue;
    const m = /^(?:cd|pushd)\s+(\S+)$/.exec(t);
    const arg = m ? m[1].replace(/^(['"])(.*)\1$/, "$2") : null;
    if (!arg || !trailTrustworthy || /[$`*?~]/.test(arg) || arg.startsWith("-")) {
      return { dir: null, known: false };
    }
    const next = path.resolve(dir, arg);
    let st = null;
    try {
      st = fs.statSync(next);
    } catch {
      st = null;
    }
    if (!st) return { dir: null, known: false };
    // `cd <file>` fails and the shell stays put, so `dir` is deliberately
    // unchanged rather than advanced to a path no shell will ever be in.
    if (st.isDirectory()) dir = next;
  }
  return { dir, known: true };
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
// Folded through the ONE helper (security ruling 2026-10-04), the git-token
// check's sibling.
const isGhToken = (t) => foldedBasename(String(t).replace(/^\\/, "")) === "gh";

// gh flags that consume a SEPARATE following value. Skipping the value matters
// because it can otherwise be mistaken for a positional word: in
// `gh --repo o/r pr create`, `o/r` would parse as the GROUP and `pr` as the
// SUBCOMMAND, so the `pr create` fence would not fire. Attached forms
// (`--repo=o/r`) are a single token and need no entry.
const GH_VALUE_FLAGS = new Set(["-R", "--repo", "--hostname"]);

function parseGhInvocation(seg) {
  const raw = (seg || "").trim();
  if (!raw) return null;
  const toks = stripRedirectionTokens(tokenize(raw));

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
  const cleaned = dispatchSurface(command);
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
  SHELL_BASENAMES,
  COMMAND_RUNNING_WRAPPERS,
  UNRESOLVABLE_COMMAND_IDENTITY,
  isGitToken,
  looksLikeFusedGitToken,
  looksLikeFusedGhToken,
  // Exported for `codex-hook-runtime.js::shellWrapperBody`: the array adapter
  // asks THIS module which words are candidate shell bodies — the ONE reader
  // and the ONE shell-name list, so the two consumers cannot disagree about
  // either (security ruling, 2026-10-03: the adapter's own SHELL_C_NAMES had
  // already drifted from this module's set).
  isShellCFlag,
  shellCandidateBodies,
  // The PREVIOUS reader, kept ONLY for the old-vs-new differential the ruling
  // requires (new ⊇ old over every fixture string). No production caller.
  shellCandidateIndexesLegacy,
  dequote,
  stripShellComments,
  stripShellGroupDelimiters,
  // Exported for the fidelity suites and for the corpus measurements that size
  // this module's false-positive surface: an approximation of the tokenizer
  // measures an approximation of the fence.
  tokenize,
  stripRedirectionTokens,
  // Exported for `violation-patterns.js::substitutionBodies`, which needs the
  // BODY of a `$(…)` / backtick that `tokenize` already grouped atomically. It
  // reuses this scan rather than growing a second one, so both read the same
  // close for the same construct.
  scanBalanced,
  scanCommandPrefix,
  nestedCommandStrings,
  expandNestedSegments,
  parseGitInvocation,
  parseGitInvocations,
  findGitSubcommand,
  resolveCdTrailDir,
  isGhToken,
  GH_VALUE_FLAGS,
  parseGhInvocation,
  parseGhInvocations,
  findGhSubcommand,
};
