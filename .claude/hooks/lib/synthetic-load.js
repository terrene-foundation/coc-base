"use strict";
/**
 * synthetic-load.js — "does this command exist to burn CPU?"
 *
 * THE DECISION THIS BACKS (co-owner-directed, receipt journal/0609): a sub-agent
 * reproduced a fixture flake "under load" by launching
 * `node -e "const e=Date.now()+N*1000;while(Date.now()<e){}"` in three groups, and a
 * 16-core machine shared by many sessions went to a load average of 319. No rule or
 * hook stood at the moment the loop was launched. This module is the predicate the
 * `PreToolUse:Bash` boundary guard (../synthetic-load-guard.js) consults, and the
 * process-table backstop (session-load-backstop) imports for its argv reads.
 *
 * INTERFACE CONTRACT (the backstop depends on these names — do not rename):
 *   RULE_ID                              "ci-cost-discipline/MUST-7"
 *   LOAD_TOOL_WORDS                      dedicated load-tool command words
 *   classifyCommand(command) -> Finding[]   [] = silent; block findings first
 *   classifyArgv(argv)       -> Finding|null
 *   isBusyLoopBody(lang, body) -> { busy, evidence }
 *   Finding = { rule_id, kind, severity, matched, evidence }
 * ADDITIVE beyond the contract, never replacing it: `CONDITIONAL_LOAD_TOOL_WORDS`
 * (words that are load only in context — `yes` to a discard sink, `dd` from an
 * infinite source); an optional second `context` argument to `classifyArgv`; and a
 * `copies` field on `fan-out` findings. `LOAD_TOOL_WORDS` is an ARRAY that also
 * answers `.has(word)` and `.size`, so a consumer written against either an Array or a
 * Set reading of "collection" works unchanged.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO SIGNAL CLASSES, TWO SEVERITIES — and why the line falls where it does
 * ─────────────────────────────────────────────────────────────────────────────
 * `kind:"load-tool"` → `block`. The verdict is the COMMAND WORD at the argv position a
 *   real parse puts it (`tokenize` + `scanCommandPrefix`), plus parsed argv facts (an
 *   `if=` operand, a redirect TARGET token, a `speed` subcommand). That is the
 *   parsed-signal class `hook-output-discipline.md` MUST-5(a) names as fencing-grade:
 *   `echo "stress-ng --cpu 8"`, `grep -n stress-ng notes.md` and a heredoc body naming
 *   it all put the word OUTSIDE command position and stay silent, while `timeout 60
 *   stress-ng`, `(stress-ng)`, `sh -c 'stress-ng'` and `env -S "stress-ng"` all put it
 *   IN command position and block. A bounded wrapper does not lift the block: "it only
 *   runs for a minute" is the rationalization this exists to refuse.
 *
 * `kind:"busy-loop"` and `kind:"fan-out"` → `halt-and-report`, PERMANENTLY
 *   (MUST-5(b)). Deciding that a loop body "does nothing but check the clock" reads the
 *   TEXT of an interpreter program. That is lexical by construction, so MUST-2 caps it
 *   below `block` however careful the reader is, and no later phase will promote it —
 *   there is no structural signal for "this program's only effect is heat" short of
 *   running it, which a hook must never do.
 *
 * WHAT A BUSY LOOP IS, precisely (every clause is required):
 *   - the condition is CONSTANT-TRUE (`while(true)`, `for(;;)`, `while :`), TIME-BOUND
 *     (`while(Date.now()<e)`, `while time.time()<e`, `[ $(date +%s) -lt $end ]`), or a
 *     counter over a range too large to be work (per-language floors below); AND
 *   - the body calls NOTHING outside a pure-compute allowlist (clock reads, `Math.*`,
 *     counters, arithmetic, hashing) — so any `await`, `sleep`, `setTimeout`, `read`,
 *     IO call, or unrecognised function makes it NOT a busy loop; AND
 *   - an exit (`break`/`last`) inside the body counts only when a clock is read, because
 *     `while(true){i++; if(i>5) break}` terminates immediately.
 * Consequence: every UNKNOWN is silent. A poll loop (`until curl …; do sleep 1; done`),
 * an IO loop (`while read -r l`), an async wait (`while(true){ if(await ready()) break }`)
 * and a REPL bridge (`python -u -c "import sys;exec(eval(sys.stdin.readline()))"`) all
 * fail the allowlist and are never reported.
 *
 * FAIL-OPEN IS THE WHOLE DISPOSITION. This runs on EVERY Bash call in every consumer.
 * A parse failure, an over-budget input, a missing sibling parser, a shell variable in
 * command position (`$CMD --cpu 8`, MUST-3), an expandable heredoc body — all return []
 * / null. A guard that wedges ordinary shell work is worse than the load it prevents.
 *
 * NAMED RESIDUALS (silent by design, not by oversight):
 *   - a script FILE (`node burn.js`, `bash ./burn.sh`) — the body is not in the command;
 *     the process-table backstop is the layer that sees it run.
 *   - a PROJECT-LOCAL path spelling of a load-tool word (`./stress`, `scripts/stress`) — the
 *     basename names a file in THIS repo, not the system tool (§ projectLocal). Backstop's layer.
 *   - a CONTAINER runner (`docker run … stress-ng`, `podman run`, `nerdctl run`). The inner word
 *     is at an argv position the shared wrapper table does not model, and the load lands in a
 *     container whose CPU is the host's all the same. Modelling `run`'s option grammar (which
 *     flags take values, where the image name ends) is a second grammar this module would own
 *     alone, so it is declined rather than guessed at; the backstop sees the container's
 *     processes on the host process table.
 *   - a PACKAGE runner (`npx stress-ng`, `uvx`, `pipx run`, `bunx`). Same shape: the tool word is
 *     an operand, and the runner may also DOWNLOAD what it runs, so the word need not name
 *     anything installed. Declined for the same reason, covered by the same layer.
 *   - a pipeline whose infinite source is several stages from its discard sink
 *     (`cat /dev/zero | gzip > /dev/null`) — only a single command's own redirects are read.
 *   - a `$(…)` inside an UNQUOTED heredoc body — bodies are data here, never commands.
 *   - busy loops written in languages other than JS / Python / Perl / Ruby / POSIX shell.
 *   - ACCEPTED: an input that makes a sub-parse THROW, or that exceeds the guard's 5 s
 *     self-timeout, fails OPEN and is classified as silent. That is the whole disposition above,
 *     stated here as a residual too because it is the one an adversary reaches for deliberately:
 *     a crafted command can be built to be unparseable. Kept anyway — the alternative is a guard
 *     that wedges ordinary shell work — and the process-table backstop is what sees the launch
 *     that gets through.
 */

const path = require("node:path");

const RULE_ID = "ci-cost-discipline/MUST-7";

/** Inputs over this are not parsed at all — fail open rather than spend the hook budget. */
const MAX_COMMAND_CHARS = 256 * 1024;
/** Nested bodies (`sh -c`, `eval`, `$(…)`, subshells) are re-parsed at most this deep. */
const MAX_DEPTH = 6;
const EVIDENCE_MAX = 120;

// Range floors below which a counter loop is plausibly real work.
//
// A JUDGMENT CALL, NOT A MEASUREMENT. These numbers were reasoned from rough per-iteration costs
// in each runtime, not timed on any machine, and nothing here should be cited as a measured
// threshold. They are also only half the test: a huge BOUND means a long loop only when the
// counter walks to it ADDITIVELY (§ additiveGrowth), which is what keeps `x*=2` out of the class
// regardless of the floor. Being too HIGH costs a missed report — never a false refusal, since
// this whole class is capped at halt-and-report.
const COUNTER_FLOOR = Object.freeze({
  node: 1e10,
  python: 1e8,
  perl: 1e8,
  ruby: 1e8,
  sh: 1e6,
});

/**
 * ASCII-lowercase a command word before a membership test.
 *
 * PLATFORM-MOTIVATED, not cosmetic: APFS (and NTFS) are case-INSENSITIVE by default, so on the
 * machine this guard was written for `STRESS-NG --cpu 8` and `NODE -e '…'` execute the very same
 * binaries as their lowercase spellings while an exact-case `.has(word)` sees neither. On a
 * case-SENSITIVE filesystem the folded spelling names no executable, so the command would fail
 * anyway and the fold costs only a refusal of something already broken — the asymmetry runs the
 * safe way. Only ASCII A–Z is folded; a non-ASCII word is returned unchanged rather than put
 * through locale-dependent `toLowerCase()`.
 *
 * DECLARED HERE, above every table, because `wordCollection` folds its KEYS: a `const` below the
 * first call site would be in its temporal dead zone at module load.
 *
 * THE LINE THIS MODULE DRAWS: a word the KERNEL resolves through the filesystem is folded (command
 * names, wrapper names, device paths). Bytes some PROGRAM parses are not (flags, `dd` operand keys,
 * `openssl`/`sysbench` subcommands, shell reserved words, language keywords) — those are compared
 * case-sensitively by the thing that reads them, so folding would invent matches the system never
 * makes. Every membership test in this file sits on one side of that line, deliberately.
 */
const foldWord = (w) => String(w).replace(/[A-Z]/g, (c) => c.toLowerCase());

/** An Array that also answers `.has` / `.size`, so Array- and Set-shaped consumers both work. */
function wordCollection(words) {
  const arr = [...words];
  // FOLDED ON BOTH SIDES (§ foldWord). The table itself carries mixed-case CANONICAL spellings
  // (`burnP5`, `burnP6`, `burnK6`, `burnK7`, `burnMMX`, `burnBX`) while every consumer looks the
  // word up ALREADY FOLDED (`classifyArgvTokens` line § word). An exact-case set therefore made
  // those six entries unmatchable from either direction — measured before this change:
  // `.has("burnP5")` true, `.has("burnp5")` false, and `classifyCommand("burnP5")` → `[]`, so the
  // one spelling a user actually types for six of the fourteen load tools was SILENT. Folding the
  // keys AND the argument makes the answer independent of which spelling either side holds; `arr`
  // keeps the original spellings, which is what `.includes()` consumers and evidence text read.
  const set = new Set(arr.map(foldWord));
  Object.defineProperty(arr, "has", { value: (w) => set.has(foldWord(String(w))) });
  Object.defineProperty(arr, "size", { value: set.size });
  return Object.freeze(arr);
}

// Tools whose function IS to occupy CPU. Seeing one at command position is the verdict.
//
// Not every one of these is a pure burner, and the claim that they have "no other function" was
// withdrawn as inaccurate: Go's `golang.org/x/tools/cmd/stress` is a FLAKE REPRODUCER — its
// purpose is to run a test binary until it fails — and it is on this list precisely because of
// HOW it does that, by running parallel copies until the machine saturates. `geekbench*` likewise
// exists to produce a score, and generates full-machine load to do it. The common property that
// earns a place here is that running the tool at all means saturating cores, so no argument about
// intent changes the verdict; the `--help` / `--version` forms are excluded above, and a
// project-local path spelling (`./stress`) is not this tool at all (§ projectLocal).
const LOAD_TOOL_WORDS = wordCollection([
  "stress",
  "stress-ng",
  "stressapptest",
  "lookbusy",
  "cpuburn",
  "burnP5",
  "burnP6",
  "burnK6",
  "burnK7",
  "burnMMX",
  "burnBX",
  "geekbench",
  "geekbench5",
  "geekbench6",
]);

const HASH_TOOLS = new Set([
  "md5",
  "md5sum",
  "sha1sum",
  "sha224sum",
  "sha256sum",
  "sha384sum",
  "sha512sum",
  "shasum",
  "b2sum",
  "b3sum",
  "cksum",
  "sum",
  "xxhsum",
  "xxh64sum",
]);
const STREAM_TOOLS = new Set([
  "cat",
  "gzip",
  "pigz",
  "bzip2",
  "xz",
  "zstd",
  "lz4",
  "brotli",
  "base64",
  "od",
  "hexdump",
  "xxd",
  "tr",
]);

// Words that are load ONLY in context (a discard sink, an infinite source, a benchmark verb).
const CONDITIONAL_LOAD_TOOL_WORDS = wordCollection([
  "yes",
  "openssl",
  "sysbench",
  "dd",
  "mprime",
  "7z",
  "7za",
  "7zz",
  "7zr",
  ...HASH_TOOLS,
  ...STREAM_TOOLS,
]);

const INFINITE_SOURCES = new Set([
  "/dev/zero",
  "/dev/urandom",
  "/dev/random",
  "/dev/full",
]);
// DELIBERATELY NOT FOLDED (§ foldWord): a flag is parsed by the TOOL, not resolved by the kernel,
// and every one of these tools compares them case-sensitively — `stress-ng --HELP` is an unknown
// option that still runs the stressors. Folding would invent an exemption the tool never grants.
const INFO_FLAGS = new Set([
  "--help",
  "-h",
  "-?",
  "--version",
  "-V",
  "--usage",
  "--cmd-list",
  "--stressors",
  "-help",
]);

// ── Command-prefix wrappers ────────────────────────────────────────────────────
// THE SHARED TABLES ARE THE GRAMMAR. `git-command-parse.js` owns two of them and this module
// consumes both rather than restating either:
//   · `GIT_WRAPPERS` — TRANSPARENT prefixes (`sudo`, `timeout`, `nice`, `exec`, `builtin`, …),
//     walked by `scanCommandPrefix`. `exec` and `builtin` were once duplicated here; they are
//     in that set already, so the copies were removed.
//   · `COMMAND_RUNNING_WRAPPERS` — wrappers with their OWN option grammar that RUN a command
//     (`watch`, `flock`, `su`, `script`, `arch`, `chroot`, `caffeinate`, `chronic`, `unbuffer`,
//     `runuser`), plus `find`'s `-exec`/`-execdir`/`-ok`/`-okdir` actions. These cannot be walked
//     as prefixes — several run a SHELL BODY, several take positional operands first — so their
//     inner commands are EXTRACTED through the shared `nestedCommandStrings` and re-classified
//     (§ wrapperNested below). `caffeinate`, `chronic` and `unbuffer` were duplicated here as
//     transparent prefixes, which mis-modelled them AND missed the rest of the table; the copies
//     were removed and the shared entry is now the one reading.
// WHAT REMAINS is only what NEITHER shared table carries, because a LOAD launch is spelled
// through it and a git launch never is. Each is a transparent prefix whose operand flags are
// declared in OPERAND_FLAGS below, and each is mapped onto a shared wrapper token before
// `scanCommandPrefix` runs, so the shared walk stays the one walk.
//   · `taskpolicy` — macOS; re-classes a process's scheduling tier, the spelling a "polite"
//     background burner uses.
//   · `numactl`   — Linux; pins a burner to a NUMA node / CPU set.
//   · `cpulimit`  — throttles a launched process; "it is capped at 50%" is a rationalization
//     this guard refuses, so the wrapped word must still be read.
const EXTRA_WRAPPERS = new Set(["taskpolicy", "numactl", "cpulimit"]);
// `parallel` IS in the shared COMMAND_RUNNING_WRAPPERS table, but it is handled locally instead:
// this module reads its `-j` degree to emit a `fan-out` finding with a `copies` count, which the
// shared extraction discards. Routing it through `wrapperNested` would silently downgrade that.
const WRAPPER_HANDLED_LOCALLY = new Set(["parallel"]);
// Flags that CONSUME the next token, per wrapper. A bare token after a wrapper is accepted as
// a wrapper operand ONLY through one of these or a declared positional — otherwise it IS the
// command word. This is what keeps `timeout 5 grep -rn stress-ng .` silent: `grep` is the
// command, not an operand of `timeout`, so `stress-ng` is grep's argument.
const OPERAND_FLAGS = {
  sudo: [
    "-u",
    "-g",
    "-h",
    "-p",
    "-U",
    "-C",
    "-D",
    "-r",
    "-t",
    "-T",
    "--user",
    "--group",
    "--host",
    "--prompt",
    "--other-user",
    "--chdir",
    "--role",
    "--type",
    "--close-from",
    "--command-timeout",
  ],
  doas: ["-u", "-C"],
  env: ["-u", "--unset", "-C", "--chdir"],
  nice: ["-n", "--adjustment"],
  timeout: ["-s", "--signal", "-k", "--kill-after"],
  ionice: ["-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "-u"],
  stdbuf: ["-i", "-o", "-e", "--input", "--output", "--error"],
  time: ["-f", "-o", "--format", "--output"],
  xargs: [
    "-P",
    "-n",
    "-I",
    "-L",
    "-s",
    "-d",
    "-E",
    "-a",
    "-J",
    "-R",
    "-S",
    "--max-procs",
    "--max-args",
    "--replace",
    "--max-lines",
    "--max-chars",
    "--delimiter",
    "--eof",
    "--arg-file",
  ],
  exec: ["-a"],
  // No `caffeinate` entry: it is a COMMAND_RUNNING_WRAPPERS member, so its option grammar is the
  // shared table's and it never reaches this walk. A copy here would be dead AND would advertise
  // a second, partial model of the same tool.
  taskpolicy: ["-c", "-t", "-l", "-p", "-d", "-g"],
  numactl: ["-C", "-N", "-m", "-p", "-i"],
  cpulimit: ["-l", "--limit", "-p", "--pid", "-e", "--exe"],
};
const WRAPPER_POSITIONALS = { timeout: 1, chrt: 1, taskset: 1 };

// DELIBERATELY NOT FOLDED (§ foldWord): bash matches its reserved words case-SENSITIVELY and never
// consults the filesystem for them, so `WHILE` is an ordinary command word, not a loop keyword.
// Folding here would peel a word bash does not peel and mis-read the unit's command position.
const SHELL_RESERVED = new Set([
  "while",
  "until",
  "for",
  "select",
  "do",
  "done",
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "case",
  "esac",
  "{",
  "}",
  "!",
]);

const basename = (t) => String(t).replace(/^.*\//, "");

/**
 * Collapse the spellings that name the same file, so a membership test on a path operand is not
 * defeated by punctuation: `//dev/zero`, `/dev//zero` and `/dev/./zero` are all `/dev/zero` to
 * `open(2)`. Leading `//` is collapsed too — POSIX reserves exactly-two leading slashes as
 * implementation-defined, and no platform this runs on gives `//dev/zero` a different meaning.
 * A relative path keeps its shape; no `..` resolution is attempted (that would need the
 * filesystem, which a hook must not touch).
 */
function normalizePathOperand(p) {
  if (typeof p !== "string" || !p) return p;
  let t = p.replace(/\/{2,}/g, "/");
  while (/\/\.(?=\/|$)/.test(t)) t = t.replace(/\/\.(?=\/|$)/g, "");
  if (t === "") t = "/";
  if (t.length > 1 && t.endsWith("/")) t = t.replace(/\/+$/, "");
  return t;
}
// FOLDED (§ foldWord). `/DEV/zero` and `/Dev/Null` are the SAME FILES on this machine: the
// directory components live on the case-insensitive root volume, so the kernel resolves them. Only
// the devfs LEAF is case-sensitive, which makes the fold deliberately over-broad by exactly one
// spelling class (`/dev/ZERO`, which resolves nowhere) — the safe direction, and the same asymmetry
// § foldWord already accepts for command words: a folded spelling that names nothing costs a
// refusal of something already broken, while an unfolded one costs a live bypass of the `block`
// tier. Normalization runs FIRST so `//DEV/./zero` folds as one path, not as punctuation.
const isInfiniteSource = (p) => INFINITE_SOURCES.has(foldWord(normalizePathOperand(p)));
const isDiscardSink = (p) => foldWord(normalizePathOperand(p)) === "/dev/null";

/**
 * Does the loop variable grow ADDITIVELY by a constant?
 *
 * A huge BOUND is only evidence of a long loop when the counter walks to it one step at a time.
 * `while(x<1e12){x=x*2}` reaches 1e12 in 40 iterations and `while n<10**9: n*=2` in 30 — both
 * finish instantly, and reporting either as a busy loop is a false positive on arithmetic that
 * is not load at all. So: any multiplicative / exponential / shift update DISQUALIFIES the huge
 * class outright, and an additive one is required to grant it. Constant-true and time-bound
 * conditions never consult this — their duration does not depend on a counter's step.
 *
 * Sigils are inside the identifier class, so `$x += 1` (Perl/shell) reads the same as `x += 1`.
 */
function additiveGrowth(text) {
  const t = String(text || "");
  if (/(?:\*\*=|\*=|\/=|<<=|>>=|>>>=)/.test(t)) return false;
  if (/([A-Za-z_$][\w$]*)\s*=\s*\1\s*(?:\*\*|\*|\/|<<|>>)/.test(t)) return false;
  if (/([A-Za-z_$][\w$]*)\s*=\s*[\d_.]+\s*(?:\*\*|\*)\s*\1(?![\w$])/.test(t)) return false;
  if (/(?:\+\+|--)\s*[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*\s*(?:\+\+|--)/.test(t)) return true;
  if (/[A-Za-z_$][\w$]*\s*[+-]=\s*\d/.test(t)) return true;
  if (/([A-Za-z_$][\w$]*)\s*=\s*\1\s*[+-]\s*\d/.test(t)) return true;
  return false;
}

let _parsers;
/** Lazy, memoized, fail-open. `null` ⇒ every classification is silent. */
function parsers() {
  if (_parsers !== undefined) return _parsers;
  try {
    const gp = require(path.join(__dirname, "git-command-parse.js"));
    const vp = require(path.join(__dirname, "violation-patterns.js"));
    _parsers = {
      tokenize: gp.tokenize,
      stripRedirectionTokens: gp.stripRedirectionTokens,
      scanCommandPrefix: gp.scanCommandPrefix,
      stripShellComments: gp.stripShellComments,
      stripShellGroupDelimiters: gp.stripShellGroupDelimiters,
      dequote: gp.dequote,
      scanBalanced: gp.scanBalanced,
      nestedCommandStrings: gp.nestedCommandStrings,
      GIT_WRAPPERS: gp.GIT_WRAPPERS,
      SHELL_BASENAMES: gp.SHELL_BASENAMES,
      COMMAND_RUNNING_WRAPPERS: gp.COMMAND_RUNNING_WRAPPERS,
      splitShellSegments: vp.splitShellSegments,
      maskDocCarrierPayloads: vp.maskDocCarrierPayloads,
      parseHeredocSpans: vp.parseHeredocSpans,
    };
    for (const v of Object.values(_parsers)) {
      if (v === undefined) {
        _parsers = null;
        break;
      }
    }
  } catch {
    _parsers = null;
  }
  return _parsers;
}

function boundEvidence(s) {
  const raw = typeof s === "string" ? s : "";
  try {
    const { safeField } = require(path.join(__dirname, "override-receipt.js"));
    return safeField(raw, "", EVIDENCE_MAX);
  } catch {
    // eslint-disable-next-line no-control-regex
    let t = raw.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/[[\]`]/g, "").replace(/\s+/g, " ").trim();
    if (t.length > EVIDENCE_MAX) t = t.slice(0, EVIDENCE_MAX) + "…";
    return t;
  }
}

function hit(kind, matched, evidence, extra) {
  return Object.assign(
    {
      kind,
      severity: kind === "load-tool" ? "block" : "halt-and-report",
      matched,
      evidence: String(evidence || ""),
      background: false,
    },
    extra || {},
  );
}

function finalize(hits) {
  const out = [];
  const seen = new Set();
  for (const h of hits) {
    const evidence = boundEvidence(h.evidence);
    const key = `${h.kind}\0${h.matched}\0${evidence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const f = {
      rule_id: RULE_ID,
      kind: h.kind,
      severity: h.severity,
      matched: h.matched,
      evidence,
    };
    if (h.kind === "fan-out") f.copies = h.copies === undefined ? null : h.copies;
    out.push(f);
  }
  const rank = (f) => (f.severity === "block" ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b));
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHELL STRUCTURE — units (simple commands with their separators) and loops
// ═══════════════════════════════════════════════════════════════════════════════

/** Unquoted `(` minus `)`, plus whether a backtick span is left open. */
function groupBalance(text) {
  let depth = 0;
  let quote = null;
  let tick = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && quote !== "'") {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "`") {
      tick = !tick;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
  }
  return { depth, open: depth > 0 || tick || quote !== null };
}

/** Split a unit on a bare background `&` at group depth 0 (never `>&`, `&>`, `<&`, `|&`). */
function splitBackground(text) {
  const pieces = [];
  let quote = null;
  let depth = 0;
  let tick = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && quote !== "'") {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "`") {
      tick = !tick;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "&" && depth <= 0 && !tick) {
      const prev = text[i - 1];
      const next = text[i + 1];
      if (prev === ">" || prev === "<" || prev === "|" || next === ">" || next === "&") continue;
      pieces.push({ text: text.slice(start, i), background: true });
      start = i + 1;
    }
  }
  pieces.push({ text: text.slice(start), background: false });
  return pieces;
}

/**
 * The command as an ordered list of UNITS: `{text, sep, background, pipedIn, pipedOut}`.
 * Segmentation is `splitShellSegments` (offsets on, so each separator is recovered from the
 * original text), then re-joined where a segment left a `(`/backtick open — the shared
 * segmenter is quote-aware but not group-aware, so `for ((;;))` and `$(a; b)` would otherwise
 * be cut inside the group — then split on a bare background `&`.
 */
function buildUnits(surface, P) {
  const segs = P.splitShellSegments(surface, {
    newlineSeparates: true,
    withOffsets: true,
  });
  const raw = segs.map((s, i) => {
    const end = s.start + s.text.length;
    const next = i + 1 < segs.length ? segs[i + 1].start : surface.length;
    return { text: s.text, sep: surface.slice(end, next) };
  });
  const merged = [];
  let acc = null;
  for (const r of raw) {
    if (acc) {
      acc.text += acc.sep + r.text;
      acc.sep = r.sep;
    } else {
      acc = { text: r.text, sep: r.sep };
    }
    if (groupBalance(acc.text).open) continue;
    merged.push(acc);
    acc = null;
  }
  if (acc) merged.push(acc);

  const units = [];
  for (const m of merged) {
    const pieces = splitBackground(m.text);
    if (pieces.length > 1 && !pieces[pieces.length - 1].text.trim()) pieces.pop();
    pieces.forEach((p, idx) => {
      const last = idx === pieces.length - 1;
      units.push({
        text: p.text,
        sep: last ? m.sep : "&",
        background: p.background || (last && pieces.length > 1 && m.text.trim().endsWith("&")),
      });
    });
  }
  for (let i = 0; i < units.length; i++) {
    units[i].pipedOut = units[i].sep.trim() === "|";
    units[i].pipedIn = i > 0 && units[i - 1].sep.trim() === "|";
  }
  return units;
}

/** Peel leading reserved words (`do`, `while`, `{`, `!` …) off a unit's text. */
function peelReserved(text) {
  const kws = [];
  let s = text.trimStart();
  for (;;) {
    const m = /^([^\s;&|<>()'"`]+)(?=\s|$)/.exec(s);
    if (!m || !SHELL_RESERVED.has(m[1])) break;
    kws.push(m[1]);
    s = s.slice(m[1].length).trimStart();
  }
  return { kws, rest: s };
}

/**
 * Flatten units into keyword / command items and assemble loop records with nesting.
 * A for-header is recorded as a header, never classified as a command.
 */
function scanStructure(units) {
  const items = [];
  units.forEach((u, ui) => {
    const { kws, rest } = peelReserved(u.text);
    for (const k of kws) items.push({ kw: k, unit: ui });
    if (rest.trim()) items.push({ cmd: rest, unit: ui });
  });

  const loops = [];
  const stack = [];
  const topLevel = [];
  let caseDepth = 0;
  let expectHeader = null;
  for (const it of items) {
    if (caseDepth > 0) {
      if (it.kw === "case") caseDepth++;
      else if (it.kw === "esac") caseDepth--;
      continue;
    }
    if (it.kw === "case") {
      caseDepth = 1;
      continue;
    }
    const top = stack[stack.length - 1];
    if (it.kw === "while" || it.kw === "until" || it.kw === "for" || it.kw === "select") {
      const loop = {
        type: it.kw,
        phase: it.kw === "for" || it.kw === "select" ? "header" : "cond",
        header: null,
        condItems: [],
        bodyItems: [],
        background: false,
        pipedOut: false,
        unit: it.unit,
      };
      stack.push(loop);
      expectHeader = loop.phase === "header" ? loop : null;
      continue;
    }
    if (it.kw === "do") {
      if (top && (top.phase === "cond" || top.phase === "header")) top.phase = "body";
      expectHeader = null;
      continue;
    }
    if (it.kw === "done") {
      const loop = stack.pop();
      if (!loop) continue;
      loops.push(loop);
      loop.background = units[it.unit].background;
      loop.pipedOut = units[it.unit].pipedOut;
      const parent = stack[stack.length - 1];
      if (parent && parent.phase === "body") parent.bodyItems.push({ loop });
      else if (parent && parent.phase === "cond") parent.condItems.push({ loop });
      else topLevel.push({ loop });
      continue;
    }
    if (it.kw) {
      if (top && top.phase === "body") top.bodyItems.push(it);
      continue;
    }
    // A command item.
    if (expectHeader && top === expectHeader && top.header === null) {
      top.header = it.cmd;
      expectHeader = null;
      continue;
    }
    const entry = Object.assign({}, it, units[it.unit]);
    entry.text = it.cmd;
    if (!top) topLevel.push(entry);
    else if (top.phase === "cond") top.condItems.push(entry);
    else if (top.phase === "body") top.bodyItems.push(entry);
  }
  // Unterminated loops contribute nothing structural; their commands are still classified.
  return { items, loops, topLevel };
}

const SH_TIME_TOKEN_RX = /\$\(\s*date\b|`\s*date\b|\$\{?(?:SECONDS|EPOCHSECONDS|EPOCHREALTIME)\b/;
const SH_COMPARE = new Set(["-lt", "-le", "-gt", "-ge", "-ne", "-eq", "<", ">", "<=", ">="]);
const SH_PURE_WORDS = new Set([":", "true", "false", "continue", "let", "[", "[[", "test", "break"]);
const SH_PURE_SUBST = new Set(["date", "expr", "echo", "printf", "seq", "bc", "true", ":"]);

function literalNumber(s) {
  if (typeof s !== "string") return null;
  const t = s.replace(/_/g, "").trim();
  if (/^\d+(?:\.\d+)?(?:e\+?\d+)?$/i.test(t)) return Number(t);
  const pow = /^(\d+)\s*\*\*\s*(\d+)$/.exec(t);
  if (pow) return Math.pow(Number(pow[1]), Number(pow[2]));
  return null;
}

/** Inner command strings of every `$(…)` (not `$((…))`) and backtick span in a token value. */
function substitutions(value) {
  const out = [];
  const v = String(value || "");
  for (let i = 0; i < v.length; i++) {
    if (v[i] === "$" && v[i + 1] === "(" && v[i + 2] !== "(") {
      let depth = 1;
      let j = i + 2;
      for (; j < v.length; j++) {
        if (v[j] === "(") depth++;
        else if (v[j] === ")" && --depth === 0) break;
      }
      out.push(v.slice(i + 2, j));
      i = j;
    } else if (v[i] === "`") {
      const j = v.indexOf("`", i + 1);
      if (j < 0) break;
      out.push(v.slice(i + 1, j));
      i = j;
    }
  }
  return out;
}

function shCondClass(loop, P) {
  if (loop.type === "for") {
    const header = String(loop.header || "").trim();
    if (header.startsWith("((")) {
      const inner = header.replace(/^\(\(/, "").replace(/\)\)\s*$/, "");
      const parts = inner.split(";");
      if (parts.length !== 3) return { cls: null, iterations: null };
      const cond = parts[1].trim();
      if (!cond) return { cls: "const", iterations: "unbounded" };
      const m = /[<]=?\s*([\d_]+(?:e\d+)?)\s*$/i.exec(cond);
      const n = m ? literalNumber(m[1]) : null;
      // § additiveGrowth — the third clause is the counter's step; `i*=2` is not a long loop.
      if (n !== null && !additiveGrowth(parts[2])) return { cls: null, iterations: n };
      if (n !== null) return { cls: n >= COUNTER_FLOOR.sh ? "huge" : null, iterations: n };
      return { cls: null, iterations: null };
    }
    const toks = P.tokenize(header);
    if (toks.length < 2 || toks[1].value !== "in") return { cls: null, iterations: null };
    const list = toks.slice(2);
    if (list.length === 1) {
      const v = list[0].value;
      const brace = /^\{(-?\d+)\.\.(-?\d+)(?:\.\.\d+)?\}$/.exec(v);
      if (brace) {
        const n = Math.abs(Number(brace[2]) - Number(brace[1])) + 1;
        return { cls: n >= COUNTER_FLOOR.sh ? "huge" : null, iterations: n };
      }
      if (list[0].unexpandable) {
        const subs = substitutions(v);
        if (subs.length === 1) {
          const st = P.tokenize(subs[0]).map((t) => t.value);
          if (st[0] === "seq") {
            const nums = st.slice(1).filter((x) => !x.startsWith("-") || /^-\d/.test(x)).map(literalNumber);
            if (nums.length && nums.every((x) => x !== null)) {
              const last = nums[nums.length - 1];
              const first = nums.length > 1 ? nums[0] : 1;
              const n = Math.abs(last - first) + 1;
              return { cls: n >= COUNTER_FLOOR.sh ? "huge" : null, iterations: n };
            }
          }
        }
        return { cls: null, iterations: null };
      }
    }
    if (list.some((t) => t.unexpandable || /[*?[]/.test(t.value))) return { cls: null, iterations: null };
    return { cls: null, iterations: list.length };
  }
  if (loop.type !== "while" && loop.type !== "until") return { cls: null, iterations: null };
  const conds = loop.condItems.filter((c) => c.cmd !== undefined);
  if (conds.length !== 1 || loop.condItems.length !== 1) return { cls: null, iterations: null };
  const text = conds[0].text.trim();
  const toks = P.stripRedirectionTokens(P.tokenize(text));
  const words = toks.map((t) => t.value);
  const joined = words.join(" ");
  if (loop.type === "while") {
    if (
      joined === ":" ||
      joined === "true" ||
      joined === "[ 1 ]" ||
      joined === "[[ 1 ]]" ||
      /^\(\(\s*1\s*\)\)$/.test(text)
    ) {
      return { cls: "const", iterations: "unbounded" };
    }
  } else if (joined === "false") {
    return { cls: "const", iterations: "unbounded" };
  }
  const timed = toks.some((t) => SH_TIME_TOKEN_RX.test(t.value));
  const compares = words.some((w) => SH_COMPARE.has(w)) || /^\(\(.*[<>].*\)\)$/.test(text);
  if (timed && compares) return { cls: "time", iterations: "unbounded" };
  return { cls: null, iterations: null };
}

function shItemPure(item, P, timeSeen) {
  if (item.loop) return false; // evaluated separately by the caller
  if (item.kw) return ["if", "then", "elif", "else", "fi", "{", "}", "!"].includes(item.kw);
  if (item.background) return false;
  const text = item.text.trim();
  if (!text) return true;
  if (text.startsWith("((")) return true;
  const toks = P.stripRedirectionTokens(P.tokenize(text));
  if (!toks.length) return true;
  for (const t of toks) {
    for (const inner of substitutions(t.value)) {
      const w = P.tokenize(inner.trim()).map((x) => x.value);
      // FOLDED (§ foldWord): `$(DATE)` runs /bin/date on this filesystem exactly as `$(date)` does.
      if (!w.length || !SH_PURE_SUBST.has(foldWord(basename(w[0])))) return false;
    }
  }
  if (toks.every((t) => /^[A-Za-z_]\w*\+?=/.test(t.value))) return true;
  // FOLDED (§ foldWord). Mixed membership, and BOTH halves fold safely: `true`/`false`/`test` are
  // PATH lookups the kernel folds, while `:`/`[`/`[[`/`let`/`break`/`continue` are bash builtins
  // and keywords that do NOT fold — but their folded spellings (`LET`, `BREAK`) name no builtin
  // and no file either, so a loop body spelling them runs nothing, exits nothing, and spins. Both
  // readings therefore land on "this item does no work", which is what this predicate decides.
  // Unfolded, a body of `TRUE` read as IMPURE and suppressed the busy-loop finding entirely.
  const w0 = foldWord(toks[0].value);
  if (!SH_PURE_WORDS.has(w0)) return false;
  if (w0 === "break" && !timeSeen) return false;
  return true;
}

function analyzeShLoop(loop, P) {
  const { cls, iterations } = shCondClass(loop, P);
  const tokensOf = (items) =>
    items.filter((i) => i.cmd !== undefined).flatMap((i) => P.tokenize(i.text).map((t) => t.value));
  const timeSeen =
    cls === "time" || tokensOf(loop.condItems).concat(tokensOf(loop.bodyItems)).some((v) => SH_TIME_TOKEN_RX.test(v));
  let bodyPure = true;
  for (const it of loop.bodyItems) {
    if (it.loop) {
      const nested = analyzeShLoop(it.loop, P);
      if (!nested.bodyPure || it.loop.background || !nested.condPure) bodyPure = false;
      continue;
    }
    if (!shItemPure(it, P, timeSeen)) bodyPure = false;
  }
  const condPure = loop.condItems.every((c) => c.cmd === undefined || shItemPure(c, P, timeSeen));
  const busy = (cls === "const" || cls === "time" || cls === "huge") && bodyPure;
  const header =
    loop.type === "for"
      ? `for ${loop.header || ""}`
      : `${loop.type} ${loop.condItems.map((c) => (c.cmd !== undefined ? c.text.trim() : "…")).join("; ")}`;
  const body = loop.bodyItems.map((b) => (b.loop ? "…loop…" : b.kw ? b.kw : b.text.trim())).join("; ");
  return {
    busy,
    bodyPure,
    condPure,
    iterations,
    evidence: `${header}; do ${body}; done`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTERPRETER BODIES
// ═══════════════════════════════════════════════════════════════════════════════

/** Same-length copy with string contents and comments blanked, so offsets map back 1:1. */
function blankCode(src, { lineComment, blockComment, quotes }) {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (lineComment && lineComment(src, i)) {
      while (i < n && src[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (blockComment && src.startsWith(blockComment[0], i)) {
      const end = src.indexOf(blockComment[1], i + blockComment[0].length);
      const stop = end < 0 ? n : end + blockComment[1].length;
      for (; i < stop; i++) if (src[i] !== "\n") out[i] = " ";
      continue;
    }
    const triple = quotes.includes('"""') && (src.startsWith('"""', i) || src.startsWith("'''", i));
    if (triple) {
      const q = src.slice(i, i + 3);
      const end = src.indexOf(q, i + 3);
      const stop = end < 0 ? n : end + 3;
      for (let k = i + 3; k < stop - 3; k++) if (src[k] !== "\n") out[k] = " ";
      i = stop;
      continue;
    }
    if (quotes.includes(c)) {
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === "\\") {
          out[i] = " ";
          i++;
        }
        if (i < n && src[i] !== "\n") out[i] = " ";
        i++;
      }
      i++;
      continue;
    }
    i++;
  }
  return out.join("");
}

function matchClose(code, openIdx, open, close) {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    if (code[i] === open) depth++;
    else if (code[i] === close && --depth === 0) return i;
  }
  return -1;
}
function skipWs(code, i) {
  while (i < code.length && /\s/.test(code[i])) i++;
  return i;
}
function splitTopLevel(s, sep) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === sep && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}
function maxLiteral(s) {
  let max = null;
  if (/\bInfinity\b|MAX_SAFE_INTEGER|MAX_VALUE|float\(\s*["']?inf/.test(s)) return Infinity;
  for (const m of s.matchAll(/(\d[\d_]*)\s*\*\*\s*(\d+)/g)) {
    const v = Math.pow(Number(m[1].replace(/_/g, "")), Number(m[2]));
    if (max === null || v > max) max = v;
  }
  for (const m of s.matchAll(/(?<![\w.])(\d[\d_]*(?:\.\d+)?(?:e\+?\d+)?)n?(?![\w.])/gi)) {
    const v = Number(m[1].replace(/_/g, ""));
    if (!Number.isNaN(v) && (max === null || v > max)) max = v;
  }
  return max;
}
const compact = (s) => String(s).replace(/\s+/g, " ").trim();
const NOT_BUSY = Object.freeze({ busy: false, evidence: "" });

// ── JavaScript ────────────────────────────────────────────────────────────────
const JS_TIME_RX =
  /\b(?:Date\s*\.\s*now|performance\s*\.\s*now|process\s*\.\s*hrtime(?:\s*\.\s*bigint)?)\s*\(|\bnew\s+Date\b/;
const JS_CALL_OK = new Set([
  "Date.now",
  "performance.now",
  "process.hrtime",
  "process.hrtime.bigint",
  "Number",
  "parseInt",
  "parseFloat",
  "String",
  "Boolean",
  "BigInt",
  "isNaN",
  "isFinite",
  "JSON.stringify",
  "JSON.parse",
  "crypto.randomBytes",
  "crypto.createHash",
  "crypto.createHmac",
]);
const JS_CHAIN_OK = new Set(["update", "digest", "toString", "toFixed", "charCodeAt"]);
const JS_PAREN_KEYWORDS = new Set(["if", "while", "for", "switch", "catch", "typeof", "void", "in", "of"]);

function jsBodyPure(body, condHasTime) {
  if (/\b(?:await|yield|return|throw|function|async|import|require|eval|debugger|with)\b/.test(body)) return false;
  if (/=>/.test(body)) return false;
  for (const nm of body.matchAll(/\bnew\s+([A-Za-z_$][\w$]*)/g)) if (nm[1] !== "Date") return false;
  for (const cm of body.matchAll(/([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/g)) {
    const name = cm[1].replace(/\s+/g, "");
    const before = body.slice(0, cm.index).trimEnd();
    if (before.endsWith(".")) {
      if (!JS_CHAIN_OK.has(name.split(".").pop())) return false;
      continue;
    }
    if (/\bnew$/.test(before)) continue; // `new Date(` — the constructor was vetted above
    if (JS_PAREN_KEYWORDS.has(name)) continue;
    if (JS_CALL_OK.has(name) || /^Math\.[A-Za-z]\w*$/.test(name)) continue;
    return false;
  }
  if (/\bbreak\b/.test(body) && !condHasTime && !JS_TIME_RX.test(body)) return false;
  return true;
}

function jsCondClass(cond) {
  let c = cond.trim();
  if (c === "") return "const";
  while (c.startsWith("(") && matchClose(c, 0, "(", ")") === c.length - 1) c = c.slice(1, -1).trim();
  if (/^(?:true|1|1n|!0|!false|!!1|!!true)$/.test(c.replace(/\s+/g, ""))) return "const";
  if (JS_TIME_RX.test(c) && /[<>]|!==?/.test(c)) return "time";
  const lit = maxLiteral(c);
  if (lit !== null && /</.test(c) && lit >= COUNTER_FLOOR.node) return "huge";
  return null;
}

function analyzeJs(src) {
  const code = blankCode(src, {
    lineComment: (s, i) => s[i] === "/" && s[i + 1] === "/",
    blockComment: ["/*", "*/"],
    quotes: ["'", '"', "`"],
  });
  const consumedWhile = new Set();
  const kwRx = /\b(while|for|do)\b/g;
  let m;
  while ((m = kwRx.exec(code))) {
    const at = m.index;
    if (at > 0 && /[\w$.]/.test(code[at - 1])) continue;
    const kw = m[1];
    let loop = null;
    let update = ""; // a `for(init;cond;UPDATE)` third clause — where the counter's step lives
    if (kw === "do") {
      let j = skipWs(code, at + 2);
      if (code[j] !== "{") continue;
      const be = matchClose(code, j, "{", "}");
      if (be < 0) continue;
      const body = code.slice(j + 1, be);
      j = skipWs(code, be + 1);
      if (!code.startsWith("while", j)) continue;
      const wAt = j;
      j = skipWs(code, j + 5);
      if (code[j] !== "(") continue;
      const ce = matchClose(code, j, "(", ")");
      if (ce < 0) continue;
      consumedWhile.add(wAt);
      loop = { cond: code.slice(j + 1, ce), body, start: at, end: ce + 1 };
    } else {
      if (kw === "while" && consumedWhile.has(at)) continue;
      let j = skipWs(code, at + kw.length);
      if (code.startsWith("await", j)) continue;
      if (code[j] !== "(") continue;
      const he = matchClose(code, j, "(", ")");
      if (he < 0) continue;
      const header = code.slice(j + 1, he);
      let cond = header;
      if (kw === "for") {
        const parts = splitTopLevel(header, ";");
        if (parts.length !== 3) continue; // for-in / for-of iterate a finite collection
        cond = parts[1];
        update = parts[2];
      }
      const k = skipWs(code, he + 1);
      let body;
      let end;
      if (code[k] === "{") {
        const be = matchClose(code, k, "{", "}");
        if (be < 0) continue;
        body = code.slice(k + 1, be);
        end = be + 1;
      } else if (code[k] === ";" || k >= code.length) {
        body = "";
        end = Math.min(k + 1, code.length);
      } else {
        let e = k;
        let depth = 0;
        for (; e < code.length; e++) {
          const ch = code[e];
          if (ch === "(" || ch === "[" || ch === "{") depth++;
          else if (ch === ")" || ch === "]" || ch === "}") {
            if (depth === 0) break;
            depth--;
          } else if ((ch === ";" || ch === "\n") && depth === 0) break;
        }
        body = code.slice(k, e);
        end = e;
      }
      loop = { cond, body, start: at, end };
    }
    const cls = jsCondClass(loop.cond);
    if (!cls) continue;
    // § additiveGrowth — a huge BOUND only means a long loop when the counter walks there one
    // step at a time; `while(x<1e12){x=x*2}` is 40 iterations.
    if (cls === "huge" && !additiveGrowth(`${loop.body} ; ${update}`)) continue;
    if (!jsBodyPure(loop.body, cls === "time")) continue;
    return { busy: true, evidence: compact(src.slice(loop.start, loop.end)) };
  }
  return NOT_BUSY;
}

// ── Python ────────────────────────────────────────────────────────────────────
const PY_TIME_RX =
  /\b(?:time\s*\.\s*(?:time|monotonic|perf_counter|process_time|time_ns|monotonic_ns|perf_counter_ns)|(?:datetime\s*\.\s*)?datetime\s*\.\s*now|monotonic|perf_counter)\s*\(|\btime\s*\(\s*\)/;
const PY_CALL_OK = new Set([
  "abs",
  "int",
  "float",
  "str",
  "len",
  "pow",
  "round",
  "min",
  "max",
  "sum",
  "divmod",
  "hash",
  "bool",
  "range",
  "time",
  "monotonic",
  "perf_counter",
]);
const PY_CHAIN_OK = new Set(["hexdigest", "digest", "update", "bit_length", "encode"]);
const PY_PAREN_KEYWORDS = new Set(["if", "while", "for", "elif", "not", "and", "or", "in", "is"]);

function pyBodyPure(body, condHasTime) {
  if (/\b(?:await|yield|return|raise|import|from|with|lambda|global|nonlocal|def|class|async|del|assert)\b/.test(body))
    return false;
  for (const cm of body.matchAll(/([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\(/g)) {
    const name = cm[1].replace(/\s+/g, "");
    const before = body.slice(0, cm.index).trimEnd();
    if (before.endsWith(".") || before.endsWith(")")) {
      if (!PY_CHAIN_OK.has(name.split(".").pop())) return false;
      continue;
    }
    if (PY_PAREN_KEYWORDS.has(name)) continue;
    if (PY_CALL_OK.has(name)) continue;
    if (/^(?:math|random|hashlib)\.\w+$/.test(name)) continue;
    if (/^(?:time\.)?(?:time|monotonic|perf_counter|process_time|time_ns|monotonic_ns|perf_counter_ns)$/.test(name))
      continue;
    return false;
  }
  if (/\bbreak\b/.test(body) && !condHasTime && !PY_TIME_RX.test(body)) return false;
  return true;
}

function analyzePython(src) {
  const code = blankCode(src.replace(/\r/g, ""), {
    lineComment: (s, i) => s[i] === "#",
    blockComment: null,
    quotes: ['"""', "'", '"'],
  });
  const lines = code.split("\n");
  const orig = src.replace(/\r/g, "").split("\n");
  for (let li = 0; li < lines.length; li++) {
    const m = /^(\s*)(while|for)\b(.*)$/.exec(lines[li]);
    if (!m) continue;
    const indent = m[1].length;
    const rest = m[3];
    let colon = -1;
    let depth = 0;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (c === ":" && depth === 0 && rest[i + 1] !== "=") {
        colon = i;
        break;
      }
    }
    if (colon < 0) continue;
    const header = rest.slice(0, colon).trim();
    let body = rest.slice(colon + 1).trim();
    let lastLine = li;
    if (!body) {
      const bodyLines = [];
      for (let k = li + 1; k < lines.length; k++) {
        if (!lines[k].trim()) continue;
        if (/^(\s*)/.exec(lines[k])[1].length <= indent) break;
        bodyLines.push(lines[k]);
        lastLine = k;
      }
      body = bodyLines.join("\n");
    }
    let cls = null;
    if (m[2] === "while") {
      const h = header.replace(/^\(+|\)+$/g, "").trim();
      if (/^(?:True|1|not\s+False|not\s+0)$/.test(h)) cls = "const";
      else if (PY_TIME_RX.test(h) && /[<>]|!=/.test(h)) cls = "time";
      else {
        const lit = maxLiteral(h);
        if (lit !== null && /</.test(h) && lit >= COUNTER_FLOOR.python) cls = "huge";
      }
    } else {
      const fm = /^.+?\s+in\s+(.+)$/.exec(header);
      if (fm) {
        const iter = fm[1].trim();
        if (/^iter\s*\(\s*int\s*,\s*1\s*\)$/.test(iter) || /^(?:itertools\s*\.\s*)?count\s*\(/.test(iter)) cls = "const";
        else if (/^(?:itertools\s*\.\s*)?repeat\s*\([^,]*\)$/.test(iter)) cls = "const";
        else if (/^range\s*\(/.test(iter)) {
          const lit = maxLiteral(iter);
          if (lit !== null && lit >= COUNTER_FLOOR.python) cls = "huge";
        }
      }
    }
    if (!cls) continue;
    if (!body.trim()) continue;
    // § additiveGrowth — `while n<10**9: n*=2` reaches the bound in 30 iterations, not 1e9.
    // A `for … in range(N)` is additive by construction and never reaches this test.
    if (cls === "huge" && m[2] === "while" && !additiveGrowth(body)) continue;
    if (!pyBodyPure(body, cls === "time")) continue;
    return { busy: true, evidence: compact(orig.slice(li, lastLine + 1).join("; ")) };
  }
  return NOT_BUSY;
}

// ── Perl ──────────────────────────────────────────────────────────────────────
const PERL_TIME_RX = /\btime\b|Time::HiRes::time/;
const PERL_OK = new Set([
  "time",
  "rand",
  "int",
  "sqrt",
  "abs",
  "sin",
  "cos",
  "exp",
  "log",
  "hex",
  "oct",
  "my",
  "our",
  "local",
  "if",
  "unless",
  "while",
  "until",
  "for",
  "foreach",
  "last",
  "next",
  "redo",
  "do",
  "lt",
  "gt",
  "le",
  "ge",
  "eq",
  "ne",
  "cmp",
  "and",
  "or",
  "not",
  "xor",
  "x",
  "Time::HiRes::time",
]);
function perlPure(text, timeSeen) {
  if (/<\w*>|`/.test(text)) return false;
  for (const w of text.matchAll(/(?<![$@%&\w:>])([A-Za-z_]\w*(?:::\w+)*)/g)) {
    if (!PERL_OK.has(w[1])) return false;
  }
  if (/\blast\b/.test(text) && !timeSeen) return false;
  return true;
}
function perlCondClass(cond, type) {
  const c = cond.trim();
  if (type === "until") return /^(?:0|!1)$/.test(c) ? "const" : null;
  if (c === "" || /^(?:1|!0|!!1)$/.test(c)) return "const";
  if (PERL_TIME_RX.test(c) && /[<>]|\b(?:lt|gt|le|ge|ne)\b|!=/.test(c)) return "time";
  const lit = maxLiteral(c);
  if (lit !== null && /<|\blt\b/.test(c) && lit >= COUNTER_FLOOR.perl) return "huge";
  return null;
}
function analyzePerl(src) {
  const code = blankCode(src, {
    lineComment: (s, i) => s[i] === "#" && (i === 0 || /[\s;{}]/.test(s[i - 1])),
    blockComment: null,
    quotes: ["'", '"'],
  });
  const consider = (cond, body, type, start, end, update) => {
    const cls = perlCondClass(cond, type);
    if (!cls) return null;
    // § additiveGrowth — see the JS/Python sites; `$x *= 2` is not a long loop.
    if (cls === "huge" && !additiveGrowth(`${body} ; ${update || ""}`)) return null;
    const timeSeen = cls === "time" || PERL_TIME_RX.test(body);
    if (!perlPure(body, timeSeen) || !perlPure(cond, true)) return null;
    return { busy: true, evidence: compact(src.slice(start, end)) };
  };
  // Block forms: while/until (COND) {BODY}; for (;;) {BODY}; foreach (A..B) {BODY}
  for (const m of code.matchAll(/\b(while|until|for|foreach)\s*(?:my\s+\$\w+\s*)?\(/g)) {
    const open = m.index + m[0].length - 1;
    const ce = matchClose(code, open, "(", ")");
    if (ce < 0) continue;
    const k = skipWs(code, ce + 1);
    if (code[k] !== "{") continue;
    const be = matchClose(code, k, "{", "}");
    if (be < 0) continue;
    const header = code.slice(open + 1, ce);
    const body = code.slice(k + 1, be);
    let r = null;
    if (m[1] === "for" || m[1] === "foreach") {
      const parts = splitTopLevel(header, ";");
      if (parts.length === 3) r = consider(parts[1], body, "while", m.index, be + 1, parts[2]);
      else {
        const range = /(\d[\d_]*)\s*\.\.\s*(\d[\d_]*(?:e\d+)?)/.exec(header);
        if (range && Number(range[2].replace(/_/g, "")) - Number(range[1].replace(/_/g, "")) >= COUNTER_FLOOR.perl)
          r = perlPure(body, false) ? { busy: true, evidence: compact(src.slice(m.index, be + 1)) } : null;
      }
    } else r = consider(header, body, m[1], m.index, be + 1);
    if (r) return r;
  }
  // do {BODY} while|until (COND)
  for (const m of code.matchAll(/\bdo\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    const be = matchClose(code, open, "{", "}");
    if (be < 0) continue;
    const t = /^\s*(while|until)\b(.*?)(?:;|$)/.exec(code.slice(be + 1));
    if (!t) continue;
    const r = consider(t[2].replace(/^\s*\(|\)\s*$/g, ""), code.slice(open + 1, be), t[1], m.index, be + 1 + t[0].length);
    if (r) return r;
  }
  // Statement modifier: STMT while COND;
  let offset = 0;
  for (const stmt of splitTopLevel(code, ";")) {
    const t = /^(\s*)(.*?)\s\b(while|until)\b(.+)$/s.exec(stmt);
    if (t && t[2].trim() && !/[{}]/.test(stmt)) {
      const r = consider(t[4], t[2], t[3], offset, offset + stmt.length);
      if (r) return r;
    }
    offset += stmt.length + 1;
  }
  // Bare block redo: { redo }
  const redo = /(?:^|[;\s])\{\s*redo\s*;?\s*\}/.exec(code);
  if (redo) return { busy: true, evidence: compact(src.slice(redo.index, redo.index + redo[0].length)) };
  return NOT_BUSY;
}

// ── Ruby ──────────────────────────────────────────────────────────────────────
const RUBY_TIME_RX = /\bTime\s*\.\s*(?:now|new)\b|\bProcess\s*\.\s*clock_gettime\b/;
const RUBY_KEYWORDS = new Set([
  "if",
  "unless",
  "then",
  "else",
  "elsif",
  "end",
  "do",
  "while",
  "until",
  "break",
  "next",
  "redo",
  "true",
  "false",
  "nil",
  "and",
  "or",
  "not",
  "loop",
  "begin",
  "rand",
]);
function rubyPure(text, locals, timeSeen) {
  if (/`|\$stdin|\bSTDIN\b/.test(text)) return false;
  for (const w of text.matchAll(/(?<![@$:\w.])([A-Za-z_]\w*(?:(?:\.|::)[A-Za-z_]\w*[?!]?)*[?!]?)/g)) {
    const name = w[1];
    if (RUBY_KEYWORDS.has(name) || locals.has(name)) continue;
    if (/^Math(?:\.|::)\w+$/.test(name)) continue;
    if (/^(?:Time\.now|Time\.new|Process\.clock_gettime|Process::CLOCK_MONOTONIC)$/.test(name)) continue;
    return false;
  }
  if (/\bbreak\b/.test(text) && !timeSeen) return false;
  return true;
}
function rubyBlockEnd(code, from) {
  // From just after an opener, find the matching `end` (openers: do/begin/def/class/module/case,
  // and if/unless/while/until only at statement start).
  const rx = /\b(do|begin|def|class|module|case|if|unless|while|until|end)\b/g;
  rx.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = rx.exec(code))) {
    const w = m[1];
    if (w === "end") {
      if (--depth === 0) return m.index;
      continue;
    }
    if (["if", "unless", "while", "until"].includes(w)) {
      const before = code.slice(0, m.index).replace(/[ \t]+$/, "");
      if (before && !/[\n;(=]$/.test(before) && !/\b(?:do|then|else|begin)$/.test(before)) continue;
    }
    depth++;
  }
  return -1;
}
function analyzeRuby(src) {
  const code = blankCode(src, {
    lineComment: (s, i) => s[i] === "#" && (i === 0 || /\s/.test(s[i - 1])),
    blockComment: null,
    quotes: ["'", '"'],
  });
  const locals = new Set([...code.matchAll(/\b([a-z_]\w*)\s*(?:[+\-*/%]|\*\*)?=(?![=~>])/g)].map((m) => m[1]));
  for (const bp of code.matchAll(/\|\s*([a-z_]\w*(?:\s*,\s*[a-z_]\w*)*)\s*\|/g))
    for (const n of bp[1].split(",")) locals.add(n.trim());
  const judge = (cls, body, start, end, cond) => {
    if (!cls) return null;
    const timeSeen = cls === "time" || RUBY_TIME_RX.test(body);
    if (!rubyPure(body, locals, timeSeen) || !rubyPure(cond || "", locals, true)) return null;
    return { busy: true, evidence: compact(src.slice(start, end)) };
  };
  const condCls = (cond, type) => {
    const c = cond.trim();
    if (type === "until") return /^(?:false|nil)$/.test(c) ? "const" : null;
    if (/^(?:true|1|!false|!nil)$/.test(c)) return "const";
    if (RUBY_TIME_RX.test(c) && /[<>]|!=/.test(c)) return "time";
    return null;
  };
  // loop { } / loop do end / N.times { }
  for (const m of code.matchAll(/\b(loop|(\d[\d_]*)\s*\.\s*times)\s*(\{|do\b)/g)) {
    const cls = m[1] === "loop" ? "const" : Number(m[2].replace(/_/g, "")) >= COUNTER_FLOOR.ruby ? "huge" : null;
    if (!cls) continue;
    const openIdx = m.index + m[0].length - m[3].length;
    let body;
    let end;
    if (m[3] === "{") {
      const be = matchClose(code, openIdx, "{", "}");
      if (be < 0) continue;
      body = code.slice(openIdx + 1, be);
      end = be + 1;
    } else {
      const ee = rubyBlockEnd(code, openIdx + 2);
      if (ee < 0) continue;
      body = code.slice(openIdx + 2, ee);
      end = ee + 3;
    }
    const r = judge(cls, body, m.index, end, "");
    if (r) return r;
  }
  // while COND [do] BODY end — at statement start
  for (const m of code.matchAll(/(?:^|[\n;])\s*(while|until)\b([^\n;]*?)(?:\bdo\b|;|\n)/g)) {
    const kwAt = m.index + m[0].indexOf(m[1]);
    const bodyStart = m.index + m[0].length;
    const ee = rubyBlockEnd(code, bodyStart);
    if (ee < 0) continue;
    const r = judge(condCls(m[2], m[1]), code.slice(bodyStart, ee), kwAt, ee + 3, m[2]);
    if (r) return r;
  }
  // Modifier: STMT while COND
  let offset = 0;
  for (const stmt of code.split(/[;\n]/)) {
    const t = /^(\s*)(\S.*?)\s\b(while|until)\b(.+)$/.exec(stmt);
    if (t && !/^(?:while|until|end)\b/.test(t[2])) {
      const r = judge(condCls(t[4], t[3]), t[2], offset, offset + stmt.length, t[4]);
      if (r) return r;
    }
    offset += stmt.length + 1;
  }
  return NOT_BUSY;
}

// ── Shell body ────────────────────────────────────────────────────────────────
function analyzeShBody(body) {
  const P = parsers();
  if (!P) return NOT_BUSY;
  const surface = shellSurface(body, P);
  if (surface === null) return NOT_BUSY;
  const { loops } = scanStructure(buildUnits(surface, P));
  for (const loop of loops) {
    const a = analyzeShLoop(loop, P);
    if (a.busy) return { busy: true, evidence: compact(a.evidence) };
  }
  return NOT_BUSY;
}

/**
 * Is `body`, written in `lang`, a busy loop? PURE; never throws.
 * @param {"node"|"python"|"perl"|"ruby"|"sh"} lang
 * @param {string} body
 * @returns {{busy:boolean, evidence:string}}
 */
function isBusyLoopBody(lang, body) {
  try {
    if (typeof body !== "string" || !body.trim() || body.length > MAX_COMMAND_CHARS) return NOT_BUSY;
    let r;
    if (lang === "node") r = analyzeJs(body);
    else if (lang === "python") r = analyzePython(body);
    else if (lang === "perl") r = analyzePerl(body);
    else if (lang === "ruby") r = analyzeRuby(body);
    else if (lang === "sh") r = analyzeShBody(body);
    else return NOT_BUSY;
    return r.busy ? { busy: true, evidence: boundEvidence(r.evidence) } : NOT_BUSY;
  } catch {
    return NOT_BUSY;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIMPLE COMMANDS
// ═══════════════════════════════════════════════════════════════════════════════

const REDIRECT_DECODE_RX = /^(\d+|&)?(>>|>&|>\||<<-|<<<|<<|<&|<>|>|<)([\s\S]*)$/;

/** Decode the redirect tokens `tokenize` already marked, into `{fd, op, target, unexpandable}`. */
function readRedirects(toks) {
  const ops = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t || !t.redirect) continue;
    const m = REDIRECT_DECODE_RX.exec(t.value);
    if (!m) continue;
    let target = m[3];
    let unexpandable = t.unexpandable;
    if (target === "") {
      const n = toks[i + 1];
      if (n && n.redirect && !REDIRECT_DECODE_RX.test(n.value)) {
        target = n.value;
        unexpandable = n.unexpandable;
        i++;
      }
    }
    ops.push({ fd: m[1] || "", op: m[2], target, unexpandable });
  }
  return ops;
}

function redirectContext(ops) {
  let stdout;
  let stdinSource = null;
  let hereString = null;
  for (const r of ops) {
    if ((r.fd === "" || r.fd === "1" || r.fd === "&") && (r.op === ">" || r.op === ">>" || r.op === ">|")) {
      stdout = r.unexpandable ? "?" : r.target;
    } else if (r.fd === "" && r.op === ">&" && !/^\d+$/.test(r.target)) {
      stdout = r.unexpandable ? "?" : r.target;
    } else if ((r.fd === "" || r.fd === "0") && r.op === "<") {
      stdinSource = r.unexpandable ? null : r.target;
    } else if (r.op === "<<<") {
      hereString = r.unexpandable ? null : r.target;
    }
  }
  return { stdoutDiscard: isDiscardSink(stdout), stdinSource, hereString };
}

/**
 * Where does the command word sit? Shared `scanCommandPrefix` locates it; a stricter walk
 * then refuses to accept a bare token as a WRAPPER OPERAND unless a declared operand flag or
 * positional consumed it — and both must agree, or the answer is "unknown" (null).
 */
function resolveSlot(toks, P) {
  const wrappers = [];
  let cur = null;
  let pending = false;
  let slot = -1;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const v = t.value;
    if (pending) {
      pending = false;
      cur.argv.push(v);
      continue;
    }
    if (/^[A-Za-z_]\w*\+?=/.test(v)) {
      if (cur) cur.argv.push(v);
      continue;
    }
    if (cur && !cur.endOfOpts && v === "--") {
      cur.endOfOpts = true;
      continue;
    }
    if (cur && !cur.endOfOpts && v.length > 1 && v.startsWith("-")) {
      cur.argv.push(v);
      if (cur.name === "env") {
        if (v === "-S" || v === "--split-string") {
          const n = toks[i + 1];
          if (!n || n.unexpandable) return { unresolved: true };
          return { split: [n.value, ...toks.slice(i + 2).map((x) => x.value)].join(" ") };
        }
        if (/^-S./.test(v) && !t.unexpandable) return { split: [v.slice(2), ...toks.slice(i + 1).map((x) => x.value)].join(" ") };
        if (v.startsWith("--split-string=") && !t.unexpandable)
          return { split: [v.slice(15), ...toks.slice(i + 1).map((x) => x.value)].join(" ") };
      }
      if (cur.name === "command" && (v === "-v" || v === "-V")) return { lookup: true };
      if (!v.includes("=") && (OPERAND_FLAGS[cur.name] || []).includes(v)) pending = true;
      continue;
    }
    if (t.unexpandable) return { unresolved: true };
    const b = foldWord(basename(v)); // § foldWord — `TIMEOUT 60 stress-ng` runs on a folding fs
    if (P.GIT_WRAPPERS.has(b) || EXTRA_WRAPPERS.has(b)) {
      cur = { name: b, argv: [], positional: WRAPPER_POSITIONALS[b] || 0, endOfOpts: false };
      wrappers.push(cur);
      continue;
    }
    if (cur && cur.positional > 0) {
      cur.positional--;
      cur.argv.push(v);
      continue;
    }
    slot = i;
    break;
  }
  if (slot < 0) return null;
  // Cross-check with the shared walk, through the ONE rewrite `wrapperNested` also uses
  // (§ sharedPrefixWord). Two things it does, both so the shared walk sees the same wrappers this
  // one did:
  //   · an EXTRA wrapper becomes a shared wrapper token, so the shared walk keeps walking;
  //   · a CASE-VARIANT of a shared wrapper (`TIMEOUT 60 …`) becomes its folded spelling, because
  //     `scanCommandPrefix` tests `GIT_WRAPPERS.has(basename(value))` on the RAW bytes and would
  //     otherwise read `TIMEOUT` as the command name, disagree with this walk, and return null —
  //     silently dropping the whole command. The folding belongs HERE, in the caller, not in the
  //     shared parser: case-insensitive resolution is a property of THIS filesystem, and the
  //     parser is consumed by fences that must not inherit it.
  // It was a LOCAL copy of that rewrite until the chained-wrapper class was measured; the copy is
  // gone, because having it here and not in `wrapperNested` is exactly what left the chain silent.
  const mapped = toks.map((t) => {
    const v = sharedPrefixWord(t.value, P);
    return v === t.value ? t : Object.assign({}, t, { value: v });
  });
  const scan = P.scanCommandPrefix(mapped, (tok) => tok === mapped[slot]);
  if (!scan || scan.kind !== "match" || scan.idx !== slot || scan.unresolvedCommandSlot) return null;
  return { idx: slot, wrappers };
}

function decodeAnsiC(tok) {
  if (!tok) return null;
  if (!tok.unexpandable) return tok.value;
  const v = tok.value;
  if (!(v.startsWith("$'") && v.endsWith("'"))) return null;
  return v
    .slice(2, -1)
    .replace(/\\(n|t|r|\\|'|")/g, (_, c) => ({ n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"' })[c]);
}

function interpreterLang(word) {
  if (word === "node" || word === "nodejs" || word === "bun" || word === "deno") return "node";
  if (/^(?:python|pypy)(?:\d+(?:\.\d+)*)?$/.test(word)) return "python";
  if (/^perl(?:\d+(?:\.\d+)*)?$/.test(word)) return "perl";
  if (/^ruby(?:\d+(?:\.\d+)*)?$/.test(word)) return "ruby";
  return null;
}

/** `{ body, flag }` for an inline program, `{ stdin:true }` for a script read from stdin, or null. */
function interpreterBody(lang, word, argvToks) {
  const vals = argvToks.map((t) => t.value);
  if (lang === "node") {
    if (word === "deno") {
      if (vals[1] !== "eval") return null;
      const i = vals.findIndex((v, k) => k > 1 && !v.startsWith("-"));
      return i > 0 ? { tok: argvToks[i], flag: "deno eval" } : null;
    }
    for (let i = 1; i < vals.length; i++) {
      const v = vals[i];
      if (["-e", "--eval", "-p", "--print", "-pe", "-ep"].includes(v)) return { tok: argvToks[i + 1], flag: `${word} ${v}` };
      if (v.startsWith("--eval=") || v.startsWith("--print="))
        return { tok: { value: v.slice(v.indexOf("=") + 1), unexpandable: argvToks[i].unexpandable }, flag: `${word} ${v.split("=")[0]}` };
      if (["-r", "--require", "--import", "--loader", "-C", "--conditions"].includes(v)) {
        i++;
        continue;
      }
      if (v === "-") return { stdin: true, flag: word };
      if (!v.startsWith("-")) return null;
    }
    return { stdin: true, flag: word };
  }
  if (lang === "python") {
    for (let i = 1; i < vals.length; i++) {
      const v = vals[i];
      if (v === "-c" || (/^-[A-Za-z]+$/.test(v) && v.endsWith("c") && !/[WXmQ]/.test(v.slice(1, -1))))
        return { tok: argvToks[i + 1], flag: `${word} ${v}` };
      if (v === "-m" || (/^-[A-Za-z]+$/.test(v) && v.endsWith("m"))) return null;
      if (v === "-W" || v === "-X" || v === "--check-hash-based-pycs") {
        i++;
        continue;
      }
      if (v === "-") return { stdin: true, flag: word };
      if (!v.startsWith("-")) return null;
    }
    return { stdin: true, flag: word };
  }
  // perl / ruby: one or more -e bodies; -n / -p wrap the program in a READ loop (IO-bound).
  const bodies = [];
  let flag = null;
  for (let i = 1; i < vals.length; i++) {
    const v = vals[i];
    if (v === "--") break;
    if (/^-[A-Za-z]*[np][A-Za-z]*$/.test(v) && !/^-[A-Za-z]*[IrM]/.test(v)) return null;
    if (/^-[A-Za-z]*[eE]$/.test(v)) {
      const b = argvToks[i + 1];
      if (!b) return null;
      bodies.push(b);
      flag = flag || `${word} ${v}`;
      i++;
      continue;
    }
    if (lang === "ruby" && (v === "-r" || v === "-I")) {
      i++;
      continue;
    }
    if (!v.startsWith("-")) {
      if (bodies.length) break;
      return null;
    }
  }
  if (bodies.length) {
    if (bodies.some((b) => decodeAnsiC(b) === null)) return { skip: true };
    return { tok: { value: bodies.map(decodeAnsiC).join("\n"), unexpandable: false }, flag };
  }
  return { stdin: true, flag: word };
}

/**
 * Classify one already-split argv. `argvToks` are tokenizer tokens (`{value, unexpandable}`);
 * `ctx` carries what the SHELL around the argv established (redirects, background, pipes).
 * Returns internal hits.
 */
function classifyArgvTokens(argvToks, ctx, depth, P) {
  if (!argvToks.length) return [];
  const vals = argvToks.map((t) => t.value);
  // Case-folded for every membership test (§ foldWord — APFS folds, so the exact-case spelling is
  // not what the kernel resolves); the RAW spelling still appears in the evidence.
  const word = foldWord(basename(vals[0]));
  // A PROJECT-LOCAL invocation: a path with a separator that is not absolute (`./stress`,
  // `scripts/stress`, `bin/stress`). Its basename says nothing about the system tool — it names a
  // FILE IN THIS REPO that merely shares a word with one, and Go's x/tools ships a `stress` of
  // exactly that shape. Blocking it is the MUST NOT case (`hook-output-discipline.md`): a detector
  // refusing work the agent was instructed to perform.
  const projectLocal = vals[0].includes("/") && !vals[0].startsWith("/");
  const args = vals.slice(1);
  const bg = !!ctx.background;
  const discardOrOrphan = !!ctx.stdoutDiscard || (bg && !ctx.pipedOut);
  const ev = () => vals.slice(0, 6).join(" ");
  const out = [];

  if (LOAD_TOOL_WORDS.has(word)) {
    if (args.some((a) => INFO_FLAGS.has(a))) return [];
    // SILENT, not a lower tier. There is no evidence here at all — the parsed fact this block
    // keys on is "the word at command position names the system load tool", and a repo-relative
    // path is the one spelling that positively refutes it. Emitting halt-and-report instead would
    // cost every `./stress --help` a report the agent must answer for, which is how a guard gets
    // switched off. NAMED RESIDUAL: a repo-local script that IS a burner is silent here, and is
    // the process-table backstop's layer — the same disposition `node burn.js` already has.
    // Absolute paths (`/usr/bin/stress`) and the bare word (a PATH lookup, which resolves to the
    // system tool) both still block; an ABSOLUTE path to a project-local script is the residual
    // edge of that line, accepted because an absolute path to a repo file is not how an agent
    // spells a script invocation.
    if (projectLocal) return [];
    return [hit("load-tool", word, ev(), { background: bg })];
  }
  if (word === "yes") {
    if (args.some((a) => a === "--help" || a === "--version")) return [];
    return discardOrOrphan ? [hit("load-tool", "yes", ev(), { background: bg })] : [];
  }
  if (word === "openssl") {
    if (args[0] === "speed" && !args.some((a) => a === "-help" || a === "--help"))
      return [hit("load-tool", "openssl speed", ev(), { background: bg })];
    if (["dgst", "md5", "sha1", "sha256", "sha512"].includes(args[0]) && args.some((a) => isInfiniteSource(a)))
      return [hit("load-tool", `openssl ${args[0]}`, ev(), { background: bg })];
    return [];
  }
  if (word === "sysbench") {
    if (args.some((a) => a === "help" || a === "--help" || a === "--version" || a === "prepare" || a === "cleanup"))
      return [];
    const test = args.find((a) => ["cpu", "threads", "memory", "mutex"].includes(a)) ||
      (args.find((a) => /^--test=(?:cpu|threads|memory|mutex)$/.test(a)) || "").replace("--test=", "");
    return test ? [hit("load-tool", `sysbench ${test}`, ev(), { background: bg })] : [];
  }
  if (/^7z[arz]?$/.test(word)) {
    return args[0] === "b" ? [hit("load-tool", `${word} b`, ev(), { background: bg })] : [];
  }
  if (word === "mprime") {
    return args.includes("-t") ? [hit("load-tool", "mprime -t", ev(), { background: bg })] : [];
  }
  if (word === "dd") {
    const op = (k) => {
      const a = args.find((x) => x.startsWith(`${k}=`));
      return a === undefined ? undefined : a.slice(k.length + 1);
    };
    if (!isInfiniteSource(op("if")) || op("count") !== undefined) return [];
    const of = op("of");
    if (isDiscardSink(of) || (of === undefined && discardOrOrphan))
      return [hit("load-tool", "dd", ev(), { background: bg })];
    return [];
  }
  if (HASH_TOOLS.has(word)) {
    const files = args.filter((a) => !a.startsWith("-"));
    const infinite = files.some((f) => isInfiniteSource(f)) || (!files.length && isInfiniteSource(ctx.stdinSource));
    return infinite ? [hit("load-tool", word, ev(), { background: bg })] : [];
  }
  if (STREAM_TOOLS.has(word)) {
    const files = args.filter((a) => !a.startsWith("-"));
    const infinite = files.some((f) => isInfiniteSource(f)) || isInfiniteSource(ctx.stdinSource);
    // The matched identity is NORMALIZED **and FOLDED**, so `cat //dev/zero`, `cat /dev/./zero` and
    // `cat /DEV/zero` are ONE finding, not three; `ev()` still carries the spelling the agent
    // actually typed. The fold belongs here for the same reason it belongs in `isInfiniteSource`
    // above — this branch only runs once the operand HAS been recognised as a device, so the two
    // spellings name one file and a per-spelling identity would split one finding in the report.
    return infinite
      ? discardOrOrphan
        ? [hit("load-tool", `${word} ${foldWord(normalizePathOperand(files[0] || ctx.stdinSource))}`, ev(), { background: bg })]
        : []
      : [];
  }

  // ── nested command strings: shells, eval ──────────────────────────────────
  const shellIdx = word === "busybox" && P.SHELL_BASENAMES.has(foldWord(basename(vals[1] || ""))) ? 1 : 0;
  const shellWord = foldWord(basename(vals[shellIdx]));
  if (P.SHELL_BASENAMES.has(shellWord) && shellWord !== "busybox") {
    for (let i = shellIdx + 1; i < vals.length; i++) {
      const v = vals[i];
      if (v === "--") break;
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(v)) {
        const body = decodeAnsiC(argvToks[i + 1]);
        if (body === null || body === undefined) return [];
        return classifyText(body, depth + 1, P).map((h) => Object.assign(h, { background: h.background || bg }));
      }
      if (v === "-o" || v === "-O" || v === "+O") {
        i++;
        continue;
      }
      if (!v.startsWith("-") && !v.startsWith("+")) return []; // a script FILE — named residual
    }
    // A HERE-STRING TO A SHELL IS ITS SCRIPT. `bash <<<"stress-ng --cpu 8"` feeds the shell's
    // stdin exactly as a pipe or a heredoc does, and bash runs stdin as a script when no `-c` and
    // no file operand was given. `ctx.hereString` was already decoded for the INTERPRETER branch
    // below (`node <<< 'while(true){}'`) but was never consulted here, so the shell spelling of
    // the same launch was silent. `redirectContext` sets it to null for an unexpandable target,
    // so `bash <<<"$CMD"` still fails open (MUST-3).
    const stdinProgram = ctx.stdinScript || ctx.hereString;
    if (stdinProgram) {
      return classifyText(stdinProgram, depth + 1, P).map((h) => Object.assign(h, { background: h.background || bg }));
    }
    return [];
  }
  if (word === "eval") {
    const rest = argvToks.slice(1);
    if (!rest.length || rest.some((t) => t.unexpandable)) return [];
    return classifyText(rest.map((t) => t.value).join(" "), depth + 1, P).map((h) =>
      Object.assign(h, { background: h.background || bg }),
    );
  }
  if (word === "parallel") {
    let jobs = "cpu-count";
    let i = 1;
    for (; i < vals.length; i++) {
      const v = vals[i];
      if (v === "-j" || v === "--jobs" || v === "-P") {
        jobs = vals[++i];
        continue;
      }
      const at = /^(?:-j|-P|--jobs=)(.+)$/.exec(v);
      if (at) {
        jobs = at[1];
        continue;
      }
      if (!v.startsWith("-")) break;
    }
    const end = vals.findIndex((v, k) => k >= i && (v === ":::" || v === "::::"));
    const cmdToks = argvToks.slice(i, end < 0 ? undefined : end);
    if (!cmdToks.length) return [];
    const inner =
      cmdToks.length === 1
        ? classifyText(cmdToks[0].value, depth + 1, P)
        : classifyArgvTokens(cmdToks, {}, depth + 1, P);
    const relevant = inner.filter((h) => h.kind === "busy-loop" || h.kind === "load-tool");
    if (!relevant.length) return inner;
    const n = literalNumber(String(jobs));
    const copies = n === 0 ? "unbounded" : n !== null ? n : jobs;
    return inner.concat([
      hit("fan-out", "parallel", `parallel -j ${copies} → ${relevant[0].matched}: ${relevant[0].evidence}`, {
        copies,
        background: bg,
      }),
    ]);
  }

  // ── interpreters ──────────────────────────────────────────────────────────
  const lang = interpreterLang(word);
  if (lang) {
    if (word === "bun" && !args.some((a) => a === "-e" || a === "--eval" || a.startsWith("--eval="))) return [];
    const b = interpreterBody(lang, word, argvToks);
    if (!b || b.skip) return [];
    let body;
    let flag = b.flag;
    if (b.stdin) {
      body = ctx.stdinScript || ctx.hereString || null;
      if (!body) return [];
      flag = `${word} (stdin program)`;
    } else {
      body = decodeAnsiC(b.tok);
      if (body === null || body === undefined) return []; // shell-variable body: MUST-3 skip
    }
    const r = isBusyLoopBody(lang, body);
    if (r.busy) out.push(hit("busy-loop", flag, `${flag}: ${r.evidence}`, { background: bg }));
    return out;
  }
  return [];
}

/**
 * PROCESS SUBSTITUTION — `<(cmd)` and `>(cmd)`.
 *
 * The shell RUNS `cmd` and hands the reader a /dev/fd path, so `head <(stress-ng --cpu 8)`
 * launches the load generator exactly as `$(…)` would. `tokenize` does not group these (measured:
 * `head <(stress-ng --cpu 8)` yields the words `head`, `<(stress-ng`, `--cpu`, `8)`), so neither
 * the redirect decoder nor `substitutions()` ever sees the body. This scan finds them in the RAW
 * unit text, at quote depth 0 only, and returns both the bodies and a MASKED copy in which each
 * span is replaced by a single placeholder word — so the carrier command (`head`) still parses.
 * The close is found with the shared `scanBalanced`, the same scan `$(…)` uses.
 */
function processSubstitutions(text, P) {
  const raw = String(text || "");
  const bodies = [];
  let out = "";
  let quote = null;
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === "\\" && quote !== "'") {
      out += raw.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      out += c;
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if ((c === "<" || c === ">") && raw[i + 1] === "(") {
      const end = P.scanBalanced(raw, i + 2, "(", ")");
      bodies.push(raw.slice(i + 2, Math.max(i + 2, end - 1)));
      out += "/dev/fd/63";
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return { bodies, masked: out };
}

/**
 * COMMAND-RUNNING WRAPPERS — `watch`, `flock`, `su`, `script`, `arch`, `chroot`, `caffeinate`,
 * `chronic`, `unbuffer`, `runuser` — and `find`'s `-exec` / `-execdir` / `-ok` / `-okdir`.
 *
 * Each RUNS a command it was handed, but none is a transparent prefix: several run a shell BODY,
 * several take positional operands first, and `find`'s command sits in an action's operands where
 * no prefix walk looks. `scanCommandPrefix` therefore cannot reach the inner command word, which
 * is why `watch stress-ng --cpu 1`, `flock /tmp/l stress-ng -c 1` and `find . -exec stress-ng \;`
 * were all SILENT before this. The per-wrapper option grammar is NOT restated here: this defers
 * entirely to the shared `nestedCommandStrings`, so a wrapper added to that table is covered here
 * the moment it lands. Returns `null` when no such wrapper is at command position.
 */
/** Is this ALREADY-FOLDED word one `wrapperNested` delegates to `nestedCommandStrings`? */
const isNestedWrapperWord = (w, P) =>
  w === "find" || (P.COMMAND_RUNNING_WRAPPERS.has(w) && !WRAPPER_HANDLED_LOCALLY.has(w));

/**
 * Every word resolved by NAME on the walk to a nested command — the wrapper that RUNS it, and the
 * TRANSPARENT PREFIXES walked past to reach it. Both halves have to fold together: `scanCommandPrefix`
 * reads its prefix table on the RAW basename, so with only the target folded, `TIMEOUT 60 WATCH
 * stress-ng` still stopped at `TIMEOUT`, read it as the command word, and returned no match —
 * measured silent while `timeout 60 WATCH …` blocked. The prefix and the target are one walk.
 */
const isWrapperCaseWord = (w, P) => isNestedWrapperWord(w, P) || P.GIT_WRAPPERS.has(w) || EXTRA_WRAPPERS.has(w);

/** That fold applied to one token/word value, preserving any directory prefix. */
function foldWrapperCase(value, P) {
  const b = basename(value);
  const f = foldWord(b);
  return f === b || !isWrapperCaseWord(f, P) ? value : value.slice(0, value.length - b.length) + f;
}

/**
 * The token a SHARED walk has to see in place of a LOCALLY-modelled wrapper.
 *
 * `EXTRA_WRAPPERS` (`cpulimit`, `taskpolicy`, `numactl`) are declared in THIS module because
 * neither shared table carries them, so `scanCommandPrefix` and `nestedCommandStrings` — which
 * both test `GIT_WRAPPERS.has(basename(value))` on the raw bytes — read such a word as the
 * COMMAND NAME and stop walking there. Rewriting it to a shared TRANSPARENT-PREFIX token keeps
 * the shared walk going, which is the whole point of deferring to it.
 *
 * ONE HELPER, BOTH WALKS — and that unification is the fix, not a tidy-up. The rewrite existed
 * only in `resolveSlot` (§ mapped) and not in `wrapperNested`, so a local wrapper CHAINED in
 * front of a command-running wrapper escaped the `block` tier entirely: measured before this
 * change, `cpulimit -l 50 watch stress-ng`, `taskpolicy -c background watch stress-ng` and
 * `cpulimit -l 50 flock /tmp/l stress-ng` were all SILENT while `watch stress-ng` blocked.
 * The near-miss that hid it: `nice -n 19 cpulimit -l 50 flock /tmp/l stress-ng` DID block, because
 * a leading SHARED wrapper sets `scanCommandPrefix`'s `sawWrapper`, after which every bare operand
 * — including the unmodelled `cpulimit` — is skipped. So the class only fired when the local
 * wrapper was FIRST, and any probe that led with `timeout`/`nice` reported it fixed.
 *
 * `nohup` is the surrogate because it is a pure transparent prefix with NO option grammar of its
 * own, so no operand of the real wrapper can be mistaken for one of its flag VALUES; the wrapper's
 * own `OPERAND_FLAGS` entry is what `resolveSlot` reads for that, and the shared walk only needs
 * to know "keep going". The surrogate is never surfaced: evidence comes from the inner command.
 */
const SHARED_PREFIX_SURROGATE = "nohup";
function sharedPrefixWord(value, P) {
  if (EXTRA_WRAPPERS.has(foldWord(basename(value)))) return SHARED_PREFIX_SURROGATE;
  return foldWrapperCase(value, P);
}

/**
 * Rewrite every word a shared walk resolves BY NAME in a segment — a case-VARIANT of a wrapper to
 * its folded spelling, a LOCALLY-modelled wrapper to the shared surrogate (§ sharedPrefixWord) —
 * so the shared `nestedCommandStrings`, which keys on the RAW basename, reads the same wrappers
 * `wrapperNested`'s own predicate just matched.
 *
 * BOTH HALVES OF THE REWRITE ARE LOAD-BEARING, and the second is not a case fold: it changes the
 * word's LENGTH, which the quote-preserving interleave below cannot express. Rewriting only the
 * TOKENS and not the text leaves `nestedCommandStrings` stopping at the local wrapper and
 * returning `{commands: []}`, which the `!nested.commands.length` line reads as a SILENT early
 * return — the same one-of-two-walks gap this whole path was fixing.
 *
 * Word-level and quote-aware, because BOTH callers matter and they are shaped differently: the
 * shell path hands over RAW text (`TIMEOUT 60 WATCH stress-ng`), while `classifyArgv` hands over a
 * segment in which EVERY word is single-quoted (`'WATCH' 'stress-ng'`). So the membership test runs
 * on the word's DEQUOTED core and the rewrite is mapped back through the quote bytes, leaving them
 * exactly where they were. A word carrying `$`, a backtick or a backslash is left untouched: its
 * core is not what the shell will resolve, so no fold of it would be sound.
 *
 * ALL case-variants are folded, not only the one at command position: `TIMEOUT 60 WATCH …` puts a
 * variant in the PREFIX, and folding only the matched token leaves `WATCH` raw for the shared walk
 * to miss. Folding an OPERAND that happens to be a variant (`watch -n5 cat FIND`) is inert —
 * `nestedCommandStrings` resolves by command POSITION, so the word is still an operand afterwards.
 */
function rewriteWrapperWordsForSharedWalk(text, P) {
  const raw = String(text || "");
  let out = "";
  let word = ""; // raw bytes, quotes included
  let core = ""; // what the shell resolves: the same word with quote bytes removed
  let opaque = false; // `$` / backtick / backslash ⇒ the core is not the resolved word
  let quote = null;
  // THE SUBSTITUTION STOPS AT THE TARGET; THE CASE FOLD DOES NOT. Past the command-running
  // wrapper every word is ITS operand, and the substitution is NOT inert there the way the fold
  // is: measured, rewriting the whole segment turned `watch cpulimit -l 50 stress-ng` and
  // `flock /tmp/l cpulimit -l 50 stress-ng` from `block` into SILENT, because `nohup` has no
  // option grammar, so `-l` was read as a bare flag and `50` landed in the command slot instead
  // of being consumed as `cpulimit`'s limit. An operand-position CASE FOLD keeps the word's
  // identity and is still inert; a surrogate destroys the model the recursion needs. The inner
  // `cpulimit` is left raw, and the `classifyText` hop below reads it with this module's own
  // `OPERAND_FLAGS`, which is the model that knows `-l` takes a value.
  let pastTarget = false;
  const flush = () => {
    const next =
      opaque || !word ? core : pastTarget ? foldWrapperCase(core, P) : sharedPrefixWord(core, P);
    if (!opaque && word && isNestedWrapperWord(foldWord(basename(core)), P)) pastTarget = true;
    if (next === core) {
      out += word;
    } else if (next.length === core.length) {
      // A CASE FOLD. Same length, so the quote bytes are put back exactly where they were.
      let k = 0;
      for (const c of word) out += c === "'" || c === '"' ? c : next[k++];
    } else {
      // A SUBSTITUTION (`cpulimit` → `nohup`). There is no byte-for-byte position to restore the
      // quotes to, and none is owed: the surrogate is a bare command word with no metacharacter,
      // so quoting it changes nothing the re-tokenizer will read. Emitted unquoted.
      out += next;
    }
    word = "";
    core = "";
    opaque = false;
  };
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\" && quote !== "'") {
      word += raw.slice(i, i + 2);
      core += raw.slice(i, i + 2);
      opaque = true;
      i++;
      continue;
    }
    if (quote) {
      word += c;
      if (c === quote) quote = null;
      else core += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      word += c;
      continue;
    }
    if (/[\s;|&<>()]/.test(c)) {
      flush();
      out += c;
      continue;
    }
    if (c === "$" || c === "`") opaque = true;
    word += c;
    core += c;
  }
  flush();
  return out;
}

function wrapperNested(toks, text, depth, bg, P) {
  if (!P.nestedCommandStrings || !P.COMMAND_RUNNING_WRAPPERS) return null;
  // FOLDED ON EVERY ARM (§ foldWord). The `find` arm folded and the shared-wrapper arm did not,
  // which made the fold's own class a live bypass of the `block` tier: measured, `watch stress-ng
  // --cpu 1` blocked and `Watch stress-ng --cpu 1` was silent; `find . -exec stress-ng \;` blocked
  // and `FIND …` was silent. `WRAPPER_HANDLED_LOCALLY` folds with it, so `PARALLEL -j 8 …` still
  // routes to the local `fan-out` reading rather than losing its `copies` count here.
  // DEFENSE IN DEPTH, and MEASURED as such rather than assumed: the token rewrite below folds every
  // value before this predicate ever sees one, so reverting THIS fold alone reds nothing (mutation
  // run: 916 reach-marker writes, 0 failures; the double mutation dropping both reds 10). It is
  // kept because the predicate is also correct standing alone — but the rewrite is the load-bearing
  // half, and a green here is NOT evidence this line is covered.
  const isTarget = (tok) => !tok.unexpandable && isNestedWrapperWord(foldWord(basename(tok.value)), P);
  // The SCAN runs on REWRITTEN tokens for the same reason the segment below is rewritten: the shared
  // walk reads its PREFIX table on the raw basename too, so an unfolded `TIMEOUT` — or a local
  // `cpulimit` the shared table has never heard of — halted it before the target was ever reached.
  // This is the token half of the ONE rewrite `resolveSlot` also performs (§ sharedPrefixWord).
  // UNLIKE the segment rewrite below, this one is not bounded at the target, and does not need to
  // be: `scanCommandPrefix` RETURNS at the first token satisfying `stopAt`, so no token past the
  // target is ever examined, and the hits come from `nested`, never from `mapped`.
  const mapped = toks.map((t) =>
    t.unexpandable ? t : Object.assign({}, t, { value: sharedPrefixWord(t.value, P) }),
  );
  if (!mapped.some(isTarget)) return null;
  const scan = P.scanCommandPrefix(mapped, isTarget);
  if (!scan || scan.kind !== "match") return null;
  // AND THE SEGMENT IS REWRITTEN, not only the predicate. `nestedCommandStrings` takes a STRING,
  // re-tokenizes it, and keys its own scan on the RAW basename — so a matched `WATCH` would reach
  // it unfolded, resolve to no wrapper, and return `{commands: []}`, which the `!nested.commands
  // .length` line below reads as an early SILENT return. The fold therefore has to travel WITH the
  // text. This is the same rewrite `resolveSlot` already performs for `GIT_WRAPPERS` (§ mapped),
  // and it belongs HERE, in the caller: case-insensitive resolution is a property of THIS
  // filesystem, and `git-command-parse.js` is consumed by fences that must not inherit it.
  const nested = P.nestedCommandStrings(rewriteWrapperWordsForSharedWalk(text, P));
  if (!nested || !Array.isArray(nested.commands) || !nested.commands.length) return [];
  const hits = [];
  // BOUNDED BY `MAX_DEPTH`, and by that ONE cap rather than a second one declared here. Each
  // extracted command re-enters `classifyText` at `depth + 1`, and `classifyText` returns [] above
  // `MAX_DEPTH` (6) — so a chain of wrappers each nesting the next (`watch flock … watch …`)
  // terminates after at most six hops and fails OPEN, per this module's whole disposition. A
  // chain of TRANSPARENT prefixes (`nice -n 19 cpulimit -l 50 timeout 60 … stress-ng`) costs no
  // depth at all: `scanCommandPrefix` walks it iteratively in one pass, so its length is bounded
  // by the token count, not by recursion. Declaring a second cap here would be a second model of
  // the same bound and would drift from it.
  for (const cmd of nested.commands) {
    hits.push(...classifyText(cmd, depth + 1, P).map((h) => Object.assign(h, { background: h.background || bg })));
  }
  return hits;
}

/** Classify one unit of shell text (a simple command, or a group that recurses). */
function classifyUnit(unit, depth, P) {
  const text = unit.text.trim();
  if (!text) return [];
  const bg = !!unit.background;
  // `reservedWords: false` (C2 fix, 2026-10-03): this consumer unwraps a GROUP
  // and re-classifies the inner text, so a loop keyword IS the signal — the
  // fence-side reserved-word strip turned `(while :; do :; done)` into
  // `:; do :; done` and retired this classifier's loop recognition
  // (synthetic-load-guard pair11, red at 4ccb1fb55). The fences keep the strip;
  // this call site is the ONE that opts out.
  const inner0 = P.stripShellGroupDelimiters(text, { reservedWords: false });
  if (inner0 !== text && !text.startsWith("((") && groupHasSeparator(inner0)) {
    return classifyText(inner0, depth + 1, P).map((h) => Object.assign(h, { background: h.background || bg }));
  }
  const hits = [];
  const procsub = processSubstitutions(inner0, P);
  for (const body of procsub.bodies) {
    hits.push(...classifyText(body, depth + 1, P).map((h) => Object.assign(h, { background: h.background || bg })));
  }
  const inner = procsub.bodies.length ? procsub.masked : inner0;
  const toks = P.tokenize(inner);
  for (const t of toks) {
    if (!t.unexpandable) continue;
    for (const sub of substitutions(t.value)) hits.push(...classifyText(sub, depth + 1, P));
  }
  const wrapped = wrapperNested(P.stripRedirectionTokens(toks), inner, depth, bg, P);
  if (wrapped) return hits.concat(wrapped);
  const ops = readRedirects(toks);
  const rctx = redirectContext(ops);
  const args = P.stripRedirectionTokens(toks);
  const slot = resolveSlot(args, P);
  if (!slot || slot.unresolved || slot.lookup) return hits;
  if (slot.split !== undefined) {
    return hits.concat(classifyText(slot.split, depth + 1, P).map((h) => Object.assign(h, { background: h.background || bg })));
  }
  const ctx = {
    background: bg,
    pipedOut: !!unit.pipedOut,
    stdoutDiscard: rctx.stdoutDiscard,
    stdinSource: rctx.stdinSource,
    hereString: rctx.hereString,
    stdinScript: unit.stdinScript || null,
  };
  const found = classifyArgvTokens(args.slice(slot.idx), ctx, depth, P);
  hits.push(...found);
  const xargs = slot.wrappers.find((w) => w.name === "xargs");
  if (xargs) {
    let procs = null;
    for (let i = 0; i < xargs.argv.length; i++) {
      const a = xargs.argv[i];
      if (a === "-P" || a === "--max-procs") procs = xargs.argv[i + 1];
      else if (/^-P\d+$/.test(a)) procs = a.slice(2);
      else if (a.startsWith("--max-procs=")) procs = a.slice(12);
    }
    const n = literalNumber(String(procs));
    const relevant = found.filter((h) => h.kind === "busy-loop" || h.kind === "load-tool");
    if (relevant.length && n !== null && n !== 1) {
      const copies = n === 0 ? "unbounded" : n;
      hits.push(
        hit("fan-out", "xargs -P", `xargs -P ${copies} → ${relevant[0].matched}: ${relevant[0].evidence}`, {
          copies,
          background: bg,
        }),
      );
    }
  }
  return hits;
}

function groupHasSeparator(text) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && quote !== "'") {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && (c === ";" || c === "\n" || c === "&" || c === "|")) return true;
  }
  return false;
}

/** The literal text a pipe hands to the next command, for `echo '…' | node`. */
function pipedProgram(unit, P) {
  const toks = P.stripRedirectionTokens(P.tokenize(unit.text.trim()));
  if (!toks.length || toks.some((t) => t.unexpandable)) return null;
  // FOLDED (§ foldWord): `ECHO 'while(true){}' | node` pipes the same bytes `echo` would.
  const w = foldWord(basename(toks[0].value));
  if (w === "echo") {
    const rest = toks.slice(1).map((t) => t.value);
    while (rest.length && /^-[neE]+$/.test(rest[0])) rest.shift();
    return rest.join(" ") || null;
  }
  if (w === "printf" && toks[1]) return toks[1].value.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  return null;
}

/** The dispatch surface: heredoc bodies removed, doc-carrier payloads masked, comments stripped. */
function shellSurface(command, P, heredocSink) {
  const spans = P.parseHeredocSpans(command);
  if (!spans || spans.overflow) return null;
  if (heredocSink) heredocSink.spans = spans;
  return P.stripShellComments(P.maskDocCarrierPayloads(spans.structural || ""));
}

/**
 * Heredoc-fed programs: `node <<'EOF' … EOF`, `python3 - <<EOF`, `bash <<'EOF'`. The opener
 * line is aligned to the corpus parser's committed heredoc by BODY EQUALITY, so this reaches
 * only bodies `parseHeredocSpans` itself agrees are heredocs. An UNQUOTED body carrying `$` or a
 * backtick is expanded by the shell before the interpreter sees it, so it is skipped (MUST-3).
 */
function heredocPrograms(command, spans, depth, P) {
  const heredocs = spans.heredocs || [];
  if (!heredocs.length) return [];
  const lines = command.split("\n");
  const hits = [];
  let k = 0;
  for (let p = 0; p < lines.length && k < heredocs.length; p++) {
    if (!lines[p].includes("<<")) continue;
    const h = heredocs[k];
    const bodyLines = h.body === "" ? [] : h.body.split("\n");
    if (lines.slice(p + 1, p + 1 + bodyLines.length).join("\n") !== h.body) continue;
    k++;
    const opener = lines[p];
    p += bodyLines.length + 1;
    if (h.expandable) continue;
    for (const unit of buildUnits(P.stripShellComments(opener), P)) {
      const toks = P.tokenize(unit.text.trim());
      if (!toks.some((t) => t.redirect && /^(?:\d+)?<<-?(?!<)/.test(t.value))) continue;
      hits.push(...classifyUnit(Object.assign({}, unit, { stdinScript: h.body }), depth, P));
    }
  }
  return hits;
}

function classifyText(command, depth, P) {
  if (typeof command !== "string" || !command.trim()) return [];
  if (depth > MAX_DEPTH || command.length > MAX_COMMAND_CHARS) return [];
  const sink = {};
  const surface = shellSurface(command, P, sink);
  if (surface === null) return [];
  const units = buildUnits(surface, P);
  for (let i = 1; i < units.length; i++) {
    if (units[i].pipedIn) units[i].stdinScript = pipedProgram(units[i - 1], P);
  }
  const { loops, topLevel } = scanStructure(units);
  const hits = [];

  // Every command item, wherever it sits (a loop condition runs each iteration too).
  const classified = new Map();
  const unitHits = (entry) => {
    const key = entry;
    if (!classified.has(key)) classified.set(key, classifyUnit(entry, depth, P));
    return classified.get(key);
  };
  const walkItems = (list) => {
    for (const it of list) {
      if (it.loop) {
        walkItems(it.loop.condItems);
        walkItems(it.loop.bodyItems);
      } else if (it.cmd !== undefined) hits.push(...unitHits(it));
    }
  };
  walkItems(topLevel);

  // Loops: busy verdicts and fan-out from backgrounded busy work inside the body.
  const loopBusy = new Map();
  for (const loop of loops) {
    const a = analyzeShLoop(loop, P);
    loopBusy.set(loop, a);
    if (a.busy) {
      hits.push(hit("busy-loop", `${loop.type}-loop`, a.evidence, { background: loop.background }));
    }
  }
  for (const loop of loops) {
    const a = loopBusy.get(loop);
    const spawns = loop.bodyItems.some((it) => {
      if (it.loop) return it.loop.background && loopBusy.get(it.loop).busy;
      if (it.cmd === undefined || !it.background) return false;
      return unitHits(it).some((h) => h.kind === "busy-loop" || h.kind === "load-tool");
    });
    if (!spawns) continue;
    const copies = a.iterations === null ? "unknown" : a.iterations;
    if (typeof copies === "number" && copies < 2) continue;
    hits.push(
      hit("fan-out", `${loop.type}-loop &`, `${copies} background copies: ${a.evidence}`, {
        copies,
        background: loop.background,
      }),
    );
  }

  // Top-level fan-out: repeated backgrounded busy work in one command line.
  let bgCopies = 0;
  let sample = null;
  for (const it of topLevel) {
    if (it.loop) {
      if (it.loop.background && loopBusy.get(it.loop).busy) {
        bgCopies++;
        sample = sample || `${it.loop.type}-loop`;
      }
      continue;
    }
    if (!it.background) continue;
    const rel = unitHits(it).filter((h) => h.kind === "busy-loop" || h.kind === "load-tool");
    if (rel.length) {
      bgCopies++;
      sample = sample || rel[0].matched;
    }
  }
  if (bgCopies >= 2) {
    hits.push(hit("fan-out", "&", `${bgCopies} background copies of ${sample}`, { copies: bgCopies }));
  }

  hits.push(...heredocPrograms(command, sink.spans, depth, P));
  return hits;
}

/**
 * Classify a full Bash tool command string. PURE; never throws; [] = silent.
 * @param {string} command
 * @returns {Array<{rule_id:string, kind:string, severity:string, matched:string, evidence:string}>}
 */
function classifyCommand(command) {
  try {
    const P = parsers();
    if (!P) return [];
    return finalize(classifyText(command, 0, P));
  } catch {
    return [];
  }
}

/**
 * Classify an argv that is ALREADY split (e.g. a process table's command line). `argv[0]` may
 * be a path. With no `context`, words that are load only in context (`yes`, `cat /dev/zero`)
 * return null — argv alone does not say where stdout goes.
 * @param {string[]} argv
 * @param {{background?:boolean, stdoutDiscard?:boolean, pipedOut?:boolean, stdinSource?:string}} [context]
 * @returns {object|null}
 */
function classifyArgv(argv, context) {
  try {
    if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== "string")) return null;
    const P = parsers();
    if (!P) return null;
    const toks = argv.map((value) => ({ value, unexpandable: false, redirect: false }));
    // A process table hands the backstop ONE argv for a wrapper AND the command it runs
    // (`watch stress-ng --cpu 1`), so this entry point needs the same wrapper reading
    // `classifyUnit` has. `nestedCommandStrings` takes a segment STRING, so the argv is re-joined
    // with each word single-quoted — the round trip is exact because every token here is literal
    // (`unexpandable: false`), which is the same re-join the parser does internally.
    const seg = argv.map((v) => `'${v.replace(/'/g, "'\\''")}'`).join(" ");
    const wrappedArgv = wrapperNested(toks, seg, 0, !!(context && context.background), P);
    if (wrappedArgv) {
      const fw = finalize(wrappedArgv);
      return fw.length ? fw[0] : null;
    }
    const slot = resolveSlot(toks, P);
    if (!slot || slot.unresolved || slot.lookup) return null;
    const ctx = Object.assign({}, context && typeof context === "object" ? context : {});
    const hits =
      slot.split !== undefined
        ? classifyText(slot.split, 1, P)
        : classifyArgvTokens(toks.slice(slot.idx), ctx, 0, P);
    const f = finalize(hits);
    return f.length ? f[0] : null;
  } catch {
    return null;
  }
}

module.exports = {
  RULE_ID,
  LOAD_TOOL_WORDS,
  CONDITIONAL_LOAD_TOOL_WORDS,
  COUNTER_FLOOR,
  classifyCommand,
  classifyArgv,
  isBusyLoopBody,
};
