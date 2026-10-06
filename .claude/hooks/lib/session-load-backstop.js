"use strict";
/**
 * session-load-backstop — "is a process THIS session spawned burning shared CPU right now?"
 *
 * THE DECISION THIS BACKS (journal/0609 decision 2, co-owner-directed): a process-state
 * check that reports descendant processes of the session which are sustained busy loops or
 * load generators, names each pid and its launching command, and instructs the agent to
 * stop them — covering launches the PreToolUse boundary guard did not see (sub-agents,
 * nested shells, scripts).
 *
 * WHY A PURE MODULE AND NOT A HOOK BODY. Every decision here takes its inputs as
 * arguments — the process rows, the hook's own pid and parent pid, the classifier — so the
 * fixtures exercise every branch against FABRICATED process tables. No fixture ever needs a
 * real CPU-burning process, which is the whole point on a shared machine: this detector
 * must be provable without ever generating the load it detects. The only I/O is
 * `readProcessTable`, and the hook is the thin edge that calls it.
 *
 * SCOPE IS THE SESSION'S OWN PROCESS SUBTREE, AND NEVER WIDER. The root is the OUTERMOST
 * session CLI process on the chain walked UP from the hook's own pid. MEASURED on this machine
 * (read-only `ps -o pid,ppid,command -p <pid>` walked up from a sub-agent's Bash shell):
 *
 *   /bin/zsh -c source <snapshot> … eval '<the tool command>'   ← the tool-call shell
 *   claude                                                     ← THE SESSION ROOT
 *   csq run 4                                                  ← account wrapper
 *   -zsh                                                       ← terminal shell
 *   tmux new -s <name>                                         ← multiplexer, hosts MANY sessions
 *   /sbin/launchd (pid 1)
 *
 * The same `claude` pid was the parent of a SUB-AGENT's Bash shell (this lane is a
 * sub-agent), so sub-agents run in-process and their processes are descendants of the one
 * root. Everything ABOVE the root hosts other sessions — tmux, the terminal shell, launchd
 * — so when no CLI ancestor is recognised the verdict is SILENT. Falling back to pid 1, to
 * the multiplexer, or to "every process of this user" would report OTHER sessions' work,
 * and on a shared machine that is the one mistake worse than silence: it tells an agent to
 * kill processes that are not its own.
 *
 * THE OUTERMOST CLI ANCESTOR IS THE ROOT, NOT THE NEAREST. Taking the NEAREST let ANY
 * process on the chain named `claude` become the root and NARROW the scan to its own
 * subtree: MEASURED on a fabricated table, an intermediate `claude` between the hook and
 * the real root dropped a 90%-CPU burner that was a direct child of the real root — the
 * assessment went from reporting it to SILENT. Narrowing is the evasion direction, so the
 * walk continues to the last CLI ancestor found before the chain leaves the session. The
 * consequence, stated rather than hidden: if a session legitimately NESTS a CLI (an agent
 * running `claude -p` as a tool call), the root is the OUTER session's CLI and the scan
 * covers the outer subtree — the same user's same lineage, never another terminal's session
 * (sibling sessions hang off the multiplexer, which is ABOVE every root and never adopted).
 *
 * WHICH COMMAND COLUMNS ARE A SESSION CLI — MEASURED, and where not, NAMED. Read off the
 * live table with read-only `ps -Ao pid,ppid,command -ww` on this machine: every live
 * Claude Code root prints the bare word `claude`, and Codex prints `codex` with its flags —
 * so both bare forms are MEASURED, not assumed. The NATIVE installer is the shape the bare
 * list misses: `~/.local/bin/claude` is a symlink to
 * `~/.local/share/claude/versions/<semver>`, and that target's BASENAME is the version
 * string (`2.1.269`), so a root started by its real path has no `claude` token at all —
 * hence the versioned-path predicate below. UNMEASURED and therefore a NAMED residual: the
 * node-hosted Codex shape (`node …/@openai/codex/bin/codex.js`) and EVERY Gemini shape. No
 * pattern for them is invented here; under those CLIs the root may simply not be found and
 * this hook stays SILENT, which is the safe direction and what `ci-cost-discipline.md`
 * MUST-7's wiring already records.
 *
 * WHAT THIS CANNOT SEE — MEASURED, a NAMED residual. A background child of a tool-call
 * shell that has already exited is REPARENTED TO pid 1: a zero-CPU `sleep 47 &` launched
 * from a Bash call whose shell then exited read `ppid 1` from a later `ps`. Such a process
 * is outside the session subtree and this module deliberately does not look for it
 * (widening to ppid 1 is the scope error above). The PreToolUse boundary guard
 * (`synthetic-load-guard.js`) is the fence for that launch shape; this is the backstop for
 * the shapes it cannot see (a loop inside a script, a launch by a still-running wrapper, a
 * sub-agent's nested shell).
 *
 * NO PROCESS ENVIRONMENTS ARE READ. `ps -E` / `eww` would pull every environment variable
 * of every process on the machine — every token and credential of every session — into
 * hook memory. The command column is all this needs, and even that is scrubbed before it
 * is emitted (`sanitizeCommand`).
 *
 * FAIL-OPEN IS THE WHOLE DISPOSITION. No `ps`, a timeout, win32, an unparseable table, an
 * unidentifiable root, an absent classifier: every unknown is silence. A backstop that can
 * wedge a Bash call is worse than the load it reports.
 *
 * THIS MODULE NEVER SIGNALS A PROCESS. Nothing here calls `process.kill`. Stopping a
 * process is the agent's act, and the report tells it how.
 */

const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

/** Absolute `ps` locations. No PATH lookup: "which binary ran" stays an answerable question. */
const PS_CANDIDATES = Object.freeze(["/bin/ps", "/usr/bin/ps"]);

/**
 * `-A` every process, `-o` exactly the five columns decided on, `-ww` unbounded width so
 * the command column is not truncated at the terminal width (truncation would cut an
 * interpreter body in half and hide the loop).
 */
const PS_ARGS = Object.freeze(["-Ao", "pid,ppid,pcpu,etime,command", "-ww"]);

/**
 * Ceiling on the `ps` subprocess.
 *
 * TWO measurements, and the second is why this is not 1500 ms. One
 * `/bin/ps -Ao pid,ppid,pcpu,etime,command -ww` over a 1,262-process table took 0.066 s wall
 * time at a 1-minute load average of 172 on 16 cores. The SAME read over ~1,600 processes at a
 * load average of 370 took 0.64–0.77 s across three consecutive attempts — a 10x increase, and
 * 47% of a 1500 ms budget. At 1500 ms the read starts timing out under exactly the contention
 * this backstop exists for, and a timeout is SILENCE: the hook would go quiet precisely when
 * the machine is most starved, which is the same defeat direction `BUSY_LOOP_MIN_PCPU`
 * records. (It did time out: two LIVE fixture controls went red at load 370 and passed again
 * at 3000 ms, with no code on the read path changed between the runs.)
 *
 * 3000 ms is ~4x the starved measurement and ~45x the quiet one, and still leaves 2 s inside
 * the hook's own 5 s self-timeout for a purely in-memory classification pass.
 */
const PS_TIMEOUT_MS = 3000;

/**
 * Bounded buffer. `-ww` makes every command column full-length and tool-call shells carry
 * their whole command line (kilobytes each). 16 MiB covers thousands of such rows; a table
 * that overflows it errors, and an error is silence — never a partial table read as whole.
 */
const PS_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Built from constants, nothing inherited. `LC_ALL=C` is load-bearing, not hygiene: under a
 * decimal-comma locale `ps` prints `%CPU` as `12,5`, and a parser reading `12` would
 * under-report every burner by the fractional part.
 */
const PS_ENV = Object.freeze({ PATH: "/usr/bin:/bin", LC_ALL: "C" });

/**
 * Minimum `%CPU` for a classified BUSY LOOP to be reported.
 *
 * Deliberately LOW, and derived from the machine state this backstop exists for rather than
 * from an idle machine. `%CPU` is a share of ONE core, and a spinning process receives
 * roughly (cores / runnable) of one: at the incident's measured load average of 319.88 on 16
 * cores that is about 5%. A threshold of 25% or 50% — the intuitive "busy" figure — would go
 * silent exactly when the machine is most starved, which is the defeat direction. 2.0 sits
 * well above a blocked or sleeping process (which reads 0.0) and below what a spinner reads
 * even under 20x oversubscription once its average has ramped.
 *
 * INFERENCE, not measurement, and labelled as such: the ramp figure uses the BSD scheduler's
 * decaying average (about 0.95 per second, so after 20 s a 5%-share spinner reads about
 * 3.2%); on Linux procps `%CPU` is cumulative CPU time over elapsed time, which reads the
 * full share at once. Neither was measured by generating load — this lane forbids it.
 *
 * WHY A CPU FLOOR AT ALL for something already classified: the classifier reads a command
 * column LEXICALLY, so a body that merely LOOKS like a loop but blocks (a polling loop that
 * sleeps) must not be reported as burning CPU it is not burning. The floor is the
 * process-state half that confirms the lexical half.
 */
const BUSY_LOOP_MIN_PCPU = 2.0;

/**
 * Minimum elapsed seconds for a classified BUSY LOOP to be reported.
 *
 * `%CPU` on BSD-derived systems is a decaying average that starts at zero, so a seconds-old
 * process under-reads; 20 s is enough for the average to ramp past `BUSY_LOOP_MIN_PCPU` at
 * the oversubscription above (see that constant's inference note). Cost of the delay: a loop
 * launched in one Bash call is reported at the first Bash call made 20 s or more later, not
 * immediately — acceptable for a backstop, whose job is to notice a burner that OUTLIVES
 * its launch, not to race it. A `load-tool` finding carries no such floor (see `classifyRow`).
 */
const BUSY_LOOP_MIN_ETIME_SEC = 20;

/** Ancestry walk bound: a real chain is under ten hops; a cycle in a torn snapshot must not hang. */
const MAX_ANCESTRY_HOPS = 64;

/** Findings listed individually in the report; the remainder is counted, never dropped silently. */
const MAX_REPORTED_FINDINGS = 12;

/** Emitted command length cap. */
const COMMAND_MAX = 200;

/** Used only when a classifier finding omits its own rule_id. */
const FALLBACK_RULE_ID = "ci-cost-discipline/MUST-7";

/**
 * Command-column basenames that identify a session's CLI process.
 *
 * `claude` and `codex` are MEASURED — both appear as the bare word at command position in
 * this machine's live process table (see the header). `gemini` is UNMEASURED and is listed
 * so a mirrored registration has a chance of finding its root; if that CLI's process is
 * named differently the root is simply not found and the verdict is silence, which is the
 * safe direction.
 */
const CLI_BASENAMES = Object.freeze(new Set(["claude", "codex", "gemini"]));

/**
 * The NATIVE-installer shape, whose basename is a VERSION rather than a CLI name. MEASURED:
 * `~/.local/bin/claude` → `~/.local/share/claude/versions/2.1.269`, an executable file named
 * `2.1.269`. The `<cli>/versions/` segment is what carries the identity, so the CLI name is
 * required IN THE PATH — `/opt/tools/versions/1.2.3` matches nothing, and a sibling helper
 * inside the same directory (`…/claude/versions/2.1.269/claude-helper`) fails the
 * version-shaped basename.
 */
const CLI_VERSIONED_PATH = /(?:^|\/)(claude|codex|gemini)\/versions\/v?\d+(?:\.\d+)*[A-Za-z0-9._-]*$/;

/** Last path segment of a token, for either separator. */
function baseName(tok) {
  const s = String(tok || "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

function isExecutableFile(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** First existing, executable absolute `ps`, or null. `candidates` is a test seam. */
function resolvePsBinary(candidates) {
  const list = Array.isArray(candidates) ? candidates : PS_CANDIDATES;
  for (const c of list) {
    if (typeof c === "string" && c.startsWith("/") && isExecutableFile(c)) return c;
  }
  return null;
}

/**
 * Read the process table. Returns the raw `ps` text, or null for EVERY failure.
 *
 * null means "could not read", never "no processes" — a caller treating an empty string as
 * a clean table would be reading an unknown as an all-clear. `opts.psCandidates`,
 * `opts.platform` and `opts.spawn` are test seams — `spawn` lets the fixtures drive the
 * error / signal / non-zero / empty branches with a fabricated result instead of a real
 * failing process.
 */
function readProcessTable(opts) {
  const platform = opts && typeof opts.platform === "string" ? opts.platform : process.platform;
  if (platform === "win32") return null;
  const bin = resolvePsBinary(opts && opts.psCandidates);
  if (!bin) return null;
  const spawn = opts && typeof opts.spawn === "function" ? opts.spawn : spawnSync;
  try {
    const r = spawn(bin, PS_ARGS, {
      encoding: "utf8",
      timeout: PS_TIMEOUT_MS,
      maxBuffer: PS_MAX_BUFFER,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...PS_ENV },
      windowsHide: true,
    });
    if (r.error || r.signal || r.status !== 0) return null;
    if (typeof r.stdout !== "string" || r.stdout.length === 0) return null;
    return r.stdout;
  } catch {
    return null;
  }
}

/**
 * `[[dd-]hh:]mm:ss` → seconds, or null. Minutes and seconds must be < 60, and hours < 24
 * when a day field is present, so a garbled column cannot pass as a plausible age.
 */
function parseEtime(s) {
  if (typeof s !== "string") return null;
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return null;
  const days = m[1] === undefined ? 0 : Number(m[1]);
  const hours = m[2] === undefined ? 0 : Number(m[2]);
  const mins = Number(m[3]);
  const secs = Number(m[4]);
  if (mins >= 60 || secs >= 60) return null;
  if (m[1] !== undefined && hours >= 24) return null;
  const total = ((days * 24 + hours) * 60 + mins) * 60 + secs;
  return Number.isSafeInteger(total) ? total : null;
}

/**
 * Parse `ps -o pid,ppid,pcpu,etime,command` output into rows. Never throws; a row that does
 * not match the five-column shape is SKIPPED (the header is one such row). The command is
 * the whole remainder of the line, spaces included.
 */
function parsePsTable(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+(?:[.,]\d+)?)\s+(\S+)\s+(\S.*)$/.exec(raw);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const pcpu = Number(m[3].replace(",", "."));
    const etimeSec = parseEtime(m[4]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
    if (!Number.isFinite(pcpu) || etimeSec === null) continue;
    rows.push({ pid, ppid, pcpu, etimeSec, command: m[5].replace(/\s+$/, "") });
  }
  return rows;
}

/** Is this token a CLI executable — by name, or by the native versioned-path shape? */
function isCliExecutablePath(tok) {
  const s = String(tok || "");
  if (!s) return false;
  if (CLI_BASENAMES.has(baseName(s))) return true;
  return CLI_VERSIONED_PATH.test(s.replace(/\\/g, "/"));
}

/** Is this command column a session CLI process? See `CLI_BASENAMES` + `CLI_VERSIONED_PATH`. */
function isSessionCliCommand(command) {
  const toks = String(command || "").trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return false;
  if (isCliExecutablePath(toks[0])) return true;
  // A node-hosted CLI (`node /…/bin/claude …` or `node /…/@anthropic-ai/claude-code/cli.js`)
  // shows `node` as argv[0]; the script is what identifies it.
  if (/^node(js)?$/.test(baseName(toks[0])) && toks[1]) {
    if (isCliExecutablePath(toks[1])) return true;
    if (/[/\\]@anthropic-ai[/\\]claude-code[/\\]/.test(toks[1])) return true;
  }
  return false;
}

/**
 * Walk up from `selfPid` to the OUTERMOST session CLI ancestor.
 *
 * Returns `{rootPid, chain}`: `chain` is every pid walked BELOW the chosen root (the hook
 * itself, whatever launched it, and any INNER CLI the walk passed through), which the caller
 * excludes from the report. `rootPid` is null when no CLI ancestor is found at all — and null
 * means SILENT, never a wider fallback (see the header).
 *
 * The walk does NOT stop at the first CLI it meets. Stopping there let a process merely NAMED
 * like a CLI, sitting between the hook and the real root, become the root and hide every
 * burner outside its own subtree (header § THE OUTERMOST CLI ANCESTOR). It continues to pid 1,
 * a cycle, a broken chain or the hop bound, and keeps the LAST CLI it saw; a chain that breaks
 * after a CLI was found still yields that CLI rather than discarding a real, narrower answer.
 *
 * `selfPpid` is authoritative for the hook's own parent (it is `process.ppid`, not a
 * snapshot row), which also covers a snapshot that raced the hook's own row.
 */
function findSessionRoot(byPid, selfPid, selfPpid) {
  if (!(byPid instanceof Map)) return { rootPid: null, chain: [] };
  const walked = [];
  let rootPid = null;
  let rootIdx = -1;
  let cur = selfPid;
  const seen = new Set();
  for (let hop = 0; hop < MAX_ANCESTRY_HOPS; hop++) {
    if (!Number.isSafeInteger(cur) || cur <= 1 || seen.has(cur)) break;
    seen.add(cur);
    const row = byPid.get(cur);
    if (cur !== selfPid && row && isSessionCliCommand(row.command)) {
      rootPid = cur;
      rootIdx = walked.length;
    }
    let parent;
    if (cur === selfPid && Number.isSafeInteger(selfPpid) && selfPpid > 0) {
      parent = selfPpid;
    } else if (row) {
      parent = row.ppid;
    } else {
      break;
    }
    walked.push(cur);
    cur = parent;
  }
  if (rootPid === null) return { rootPid: null, chain: [] };
  return { rootPid, chain: walked.slice(0, rootIdx) };
}

/**
 * Every process descended from `rootPid`, breadth-first, EXCLUDING the root and any pid in
 * `exclude` (the hook's own chain). Excluded pids are still traversed, so a child of an
 * excluded wrapper is not hidden by the exclusion.
 */
function descendantsOf(rows, rootPid, exclude) {
  if (!Array.isArray(rows) || !Number.isSafeInteger(rootPid)) return [];
  const skip = exclude instanceof Set ? exclude : new Set();
  const children = new Map();
  for (const r of rows) {
    if (!r || r.pid === r.ppid) continue;
    if (!children.has(r.ppid)) children.set(r.ppid, []);
    children.get(r.ppid).push(r);
  }
  const out = [];
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const p = queue.shift();
    for (const c of children.get(p) || []) {
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      queue.push(c.pid);
      if (!skip.has(c.pid)) out.push(c);
    }
  }
  return out;
}

/**
 * Interpreter family of an argv[0] basename, or null. MIRRORS the classifier's
 * `interpreterLang`, and must stay in step with it: a family missing HERE leaves the body
 * unrejoined, so the classifier sees `["bun","-e","while","(true)","{}"]` and its
 * loop-detector never receives a body to read. `bun`/`deno` (node family) and `pypy` (python
 * family) were exactly that gap.
 */
function interpreterFamily(b) {
  if (/^(node(js)?|bun|deno)$/.test(b)) return "node";
  if (/^(python|pypy)(\d+(\.\d+)*)?$/.test(b)) return "python";
  if (/^perl(\d+(\.\d+)*)?$/.test(b)) return "perl";
  if (/^ruby(\d+(\.\d+)*)?$/.test(b)) return "ruby";
  if (/^(sh|bash|zsh|dash|ksh|ash)$/.test(b)) return "sh";
  return null;
}

/**
 * The flag that introduces an inline program body, per family, as its OWN token. Combined
 * short flags allowed. `-pe` / `-ep` are node's print+eval spellings and take the body as the
 * next token exactly as `-e` does.
 */
const EVAL_FLAG = Object.freeze({
  node: (t) => t === "-e" || t === "--eval" || t === "-p" || t === "--print" || t === "-pe" || t === "-ep",
  python: (t) => /^-[A-Za-z]*c$/.test(t),
  perl: (t) => /^-[A-Za-z]*[eE]$/.test(t),
  ruby: (t) => /^-[A-Za-z]*e$/.test(t),
  sh: (t) => /^-[A-Za-z]*c$/.test(t),
});

/**
 * The ATTACHED spellings of the same flag, which `ps` shows as ONE token glued to the head of
 * the body — `node --eval=while (true) {}`, `python3 -cwhile True: pass`. Each returns
 * `[flagToken, bodyHead]`, and the caller rejoins `bodyHead` with the rest of the line, so the
 * classifier receives the canonical detached shape it already understands.
 *
 * The `-c` cluster match is LAZY (`*?`) so it splits at the FIRST `c`: greedy matching splits
 * `-cexec(x)` at the `c` inside `exec`, yielding the flag `-cexec` and the body `(x)`.
 */
const EVAL_ATTACHED = Object.freeze({
  node: (t) => {
    const m = /^(--eval|--print)=(.*)$/.exec(t);
    return m ? [m[1], m[2]] : null;
  },
  python: (t) => {
    const m = /^(-[A-Za-z]*?c)(.+)$/.exec(t);
    return m && !/[mWXQ]/.test(m[1].slice(1, -1)) ? [m[1], m[2]] : null;
  },
  sh: (t) => {
    const m = /^(-[A-Za-z]*?c)(.+)$/.exec(t);
    return m ? [m[1], m[2]] : null;
  },
  perl: () => null,
  ruby: () => null,
});

/** Interpreter flags that consume the NEXT token as their value (so it is not the script). */
const VALUE_FLAGS = Object.freeze(new Set(["-r", "--require", "--import", "--loader", "-W", "-X", "-I"]));

/**
 * Best-effort argv from a `ps` command column.
 *
 * `ps` joins argv with single spaces and LOSES THE QUOTES, so `node -e "while(1){}"` reads
 * `node -e while(1){}` and a body containing spaces is split into many tokens. For an
 * interpreter, everything after its inline-program flag is REJOINED into ONE body token,
 * which is the shape the classifier's `classifyArgv` expects. Scanning for that flag stops
 * at the first non-flag token (the script path), so a SCRIPT's own `-c` argument is not
 * mistaken for an inline body. Lossy by construction — whitespace inside the body collapses
 * to single spaces — and that is a stated limit, not a claim of reconstruction.
 */
function commandToArgv(command) {
  const toks = String(command || "").trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return [];
  const fam = interpreterFamily(baseName(toks[0]));
  if (!fam) return toks;
  // `deno` spells its inline program as the SUBCOMMAND `eval` rather than a flag, so the body
  // begins at the first non-flag token after it.
  if (baseName(toks[0]) === "deno") {
    if (toks[1] !== "eval") return toks;
    const i = toks.findIndex((v, k) => k > 1 && !v.startsWith("-"));
    return i > 1 && i + 1 < toks.length ? [...toks.slice(0, i), toks.slice(i).join(" ")] : toks;
  }
  const isEval = EVAL_FLAG[fam];
  const attached = EVAL_ATTACHED[fam];
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i];
    if (isEval(t)) {
      return i + 1 < toks.length ? [...toks.slice(0, i + 1), toks.slice(i + 1).join(" ")] : toks;
    }
    const att = attached(t);
    if (att) {
      return [...toks.slice(0, i), att[0], [att[1], ...toks.slice(i + 1)].join(" ")];
    }
    if (!t.startsWith("-")) {
      if (VALUE_FLAGS.has(toks[i - 1])) continue;
      return toks; // the script path: anything after it belongs to the script
    }
  }
  return toks;
}

/** Does this row meet BOTH sustain floors? */
function meetsSustainFloors(row) {
  return !!row && row.pcpu >= BUSY_LOOP_MIN_PCPU && row.etimeSec >= BUSY_LOOP_MIN_ETIME_SEC;
}

/** `.has` on a Set or on the classifier's frozen word collection, defensively. */
function hasWord(words, word) {
  try {
    return !!(words && typeof words.has === "function" && words.has(word));
  } catch {
    return false;
  }
}

/**
 * Classify one row. Returns the classifier's finding, or null.
 *
 * - A DEDICATED load tool (`stress-ng`, `openssl speed`, `sysbench cpu`) is reported
 *   REGARDLESS of CPU: such a tool has no purpose except load, and one that is momentarily
 *   idle between phases is still a load generator.
 * - A CONDITIONAL load word (`yes`, `cat`, `dd`, the hash tools — the classifier's
 *   `CONDITIONAL_LOAD_TOOL_WORDS`) is load only where its output GOES, and a process table
 *   carries no redirects: `classifyArgv(["yes"])` with no context is null by the classifier's
 *   design, so `yes > /dev/null &` launched inside a script was NEVER reported however long it
 *   burned. Such a row is therefore re-classified ONCE with `{stdoutDiscard:true}` — but only
 *   when it has ALREADY met both sustain floors, which is the process-state evidence standing
 *   in for the redirect the table does not record: a `yes` feeding a live consumer BLOCKS on
 *   the pipe at ~0% CPU, so a `yes` sustaining CPU is a `yes` whose output is going nowhere.
 *   The floors are what keep this from turning a legitimate `gzip`/`sha256sum` of a real file
 *   into a finding — and the classifier's own conditions still apply on top (a stream tool
 *   also needs an INFINITE source), so `gzip big.tar` at 90% stays null.
 * - `busy-loop` is reported ONLY with sustained CPU (both floors above), because its
 *   classification is lexical over a lossy command column.
 * - `fan-out` and any unknown kind are SILENT at the process level: a fan-out launcher's
 *   MEMBERS are separate rows and are each classified on their own merits, so reporting the
 *   launcher too would double-count, and a launcher of non-burners is not load at all.
 * - A CPU-heavy process the classifier does not recognise (a compiler, a test runner) is
 *   SILENT. CPU alone is never the signal: a legitimately heavy build is the session's real
 *   work, and this backstop is about purposeless load.
 */
function classifyRow(row, classify, conditionalWords) {
  if (!row || typeof classify !== "function") return null;
  const argv = commandToArgv(row.command);
  if (!argv.length) return null;
  const call = (ctx) => {
    try {
      const r = classify(argv, ctx);
      return r && typeof r === "object" ? r : null;
    } catch {
      return null;
    }
  };
  let f = call(undefined);
  if (!f && meetsSustainFloors(row) && hasWord(conditionalWords, baseName(argv[0]))) {
    f = call({ stdoutDiscard: true });
  }
  if (!f) return null;
  if (f.kind === "load-tool") return f;
  if (f.kind === "busy-loop") return meetsSustainFloors(row) ? f : null;
  return null;
}

/**
 * Credential-bearing NAME shapes. The name may be BARE (`TOKEN=`), PREFIXED (`GITHUB_TOKEN=`),
 * SUFFIXED (`TOKEN_FILE=`), or written as a FLAG (`--token=`, `-password=`) — an earlier form
 * of this scrub required at least one word character BEFORE the keyword, so every bare and
 * hyphen-led spelling passed through UNREDACTED into agent-visible text while only the
 * prefixed ones were caught.
 *
 * OVER-REDACTION IS THE CHOSEN DIRECTION, and one case is worth naming because it is common:
 * `AUTH` is a substring of `author`, so `git log --author=alice` emits `--author=<redacted>`.
 * That is DELIBERATE. Losing an author name costs a diagnostic detail in a line whose only job
 * is to identify a process to stop; keeping it would mean narrowing the pattern until
 * `--auth=<token>` slips out, and this text is quoted into transcripts, journals and PRs.
 */
const CREDENTIAL_WORD =
  "(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|APIKEY|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?|AUTH)";
const CREDENTIAL_ASSIGNMENT = new RegExp(
  `(^|[\\s"'\`=:;,|&()<>])(-{0,2}[A-Za-z0-9_.-]*${CREDENTIAL_WORD}[A-Za-z0-9_.-]*)=\\S+`,
  "gi",
);
/** `--token <value>` — a hyphen-led flag only, and only when the value is not itself a flag. */
const CREDENTIAL_FLAG_VALUE = new RegExp(
  `(^|\\s)(-{1,2}[A-Za-z0-9_.-]*${CREDENTIAL_WORD}[A-Za-z0-9_.-]*)(\\s+)(?!-)(\\S+)`,
  "gi",
);
/** URL userinfo: `https://user:pass@host` — the whole userinfo goes, not only the password. */
const URL_USERINFO = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+@/g;

/**
 * Scrub a command column for emission. Best-effort DISCLOSURE hygiene, never a trust
 * decision: control characters (incl. ANSI/OSC introducers) become spaces; the operator's
 * home and any `/Users/<name>` or `/home/<name>` become placeholders (hook output lands in
 * transcripts that are quoted into journals and PRs); credential-shaped assignments, credential
 * FLAG VALUES, URL userinfo and `Bearer`/`Basic` values are redacted; square brackets are
 * stripped so a command cannot forge a `[BLOCK]`-style marker inside the body the agent reads
 * as authoritative; length is capped.
 */
function sanitizeCommand(command, homeDir) {
  let s = String(command == null ? "" : command);
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  if (typeof homeDir === "string" && homeDir.length > 1 && homeDir.startsWith("/")) {
    s = s.split(homeDir).join("~");
  }
  s = s.replace(/\/(Users|home)\/[A-Za-z][\w.-]*/g, "/$1/<user>");
  s = s.replace(URL_USERINFO, "$1<redacted>@");
  s = s.replace(CREDENTIAL_ASSIGNMENT, "$1$2=<redacted>");
  s = s.replace(CREDENTIAL_FLAG_VALUE, "$1$2$3<redacted>");
  s = s.replace(/\b(Bearer|Basic)\s+\S+/g, "$1 <redacted>");
  s = s.replace(/[[\]]/g, "").replace(/`/g, "'").replace(/\s+/g, " ").trim();
  if (s.length > COMMAND_MAX) s = s.slice(0, COMMAND_MAX) + "…";
  return s;
}

function silent(why, extra) {
  return { verdict: "silent", findings: [], why, ...(extra || {}) };
}

/**
 * The decision. PURE: every input is injected.
 *
 * @param {object} a
 * @param {Array<{pid,ppid,pcpu,etimeSec,command}>} a.rows  parsed process table
 * @param {number} a.selfPid   the hook's own pid
 * @param {number} a.selfPpid  the hook's own parent pid
 * @param {(argv:string[],ctx?:object)=>object|null} a.classify  the synthetic-load classifier
 * @param {{has:(w:string)=>boolean}} [a.conditionalWords]  the classifier's context-dependent
 *        load words; absent ⇒ no row is ever re-classified (see `classifyRow`)
 * @param {string} [a.homeDir] scrubbed from emitted commands
 * @returns {{verdict:"silent"|"report", findings:object[], why:string, rootPid?:number}}
 */
function assessSessionLoad({ rows, selfPid, selfPpid, classify, conditionalWords, homeDir } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return silent("no-process-table");
  if (typeof classify !== "function") return silent("classifier-unavailable");
  const byPid = new Map();
  for (const r of rows) if (r && !byPid.has(r.pid)) byPid.set(r.pid, r);

  const { rootPid, chain } = findSessionRoot(byPid, selfPid, selfPpid);
  if (rootPid === null) return silent("session-root-unidentified");

  const exclude = new Set(chain);
  const desc = descendantsOf(rows, rootPid, exclude);
  const hits = new Map();
  for (const row of desc) {
    const f = classifyRow(row, classify, conditionalWords);
    if (f) hits.set(row.pid, { row, f });
  }
  if (hits.size === 0) {
    return silent("no-classified-descendant", { rootPid, descendantCount: desc.length });
  }

  // FOLD THE WRAPPER, NEVER A BURNING ANCESTOR. A shell whose `-c` body launched a burner
  // carries the burner's text in its own command column, so it classifies too; listing both
  // tells the agent to stop the same work twice. But folding EVERY classified ancestor hid a
  // parent that was itself burning: a 50%-CPU parent with a 97%-CPU child reported only the
  // child, so the agent killed the child while the parent kept burning — and the "stop the
  // parent too" advice below needs TWO flagged children before it fires, so nothing named the
  // parent at all. An ancestor is folded ONLY while it is below the CPU floor (a wrapper that
  // is merely waiting); one that meets the floor is burning in its own right and is its own
  // finding, listed alongside its child.
  const folded = new Set();
  for (const pid of hits.keys()) {
    const seen = new Set();
    let p = byPid.has(pid) ? byPid.get(pid).ppid : null;
    while (Number.isSafeInteger(p) && p > 1 && p !== rootPid && !seen.has(p)) {
      seen.add(p);
      const prow = byPid.get(p);
      if (hits.has(p) && prow && prow.pcpu < BUSY_LOOP_MIN_PCPU) folded.add(p);
      p = prow ? prow.ppid : null;
    }
  }

  const findings = [...hits.values()]
    .filter((h) => !folded.has(h.row.pid))
    .sort((x, y) => x.row.pid - y.row.pid)
    .map(({ row, f }) => ({
      rule_id: typeof f.rule_id === "string" && f.rule_id ? f.rule_id : FALLBACK_RULE_ID,
      kind: f.kind,
      pid: row.pid,
      ppid: row.ppid,
      pcpu: row.pcpu,
      etimeSec: row.etimeSec,
      command: sanitizeCommand(row.command, homeDir),
      parentIsSessionRoot: row.ppid === rootPid || exclude.has(row.ppid),
    }));
  return { verdict: "report", findings, why: "classified-session-descendant", rootPid };
}

/** `1234` → `20m34s`; for the report only. */
function formatEtime(sec) {
  const n = Number.isSafeInteger(sec) && sec >= 0 ? sec : 0;
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m${String(s).padStart(2, "0")}s`;
}

/**
 * The `instruct-and-wait` payload for a `report` assessment. PURE, so the fixtures pin the
 * report's content (every pid named, the stop command present, the non-stopping statement
 * present) without spawning the hook.
 */
function buildEmitPayload(assessment) {
  const all = (assessment && Array.isArray(assessment.findings) && assessment.findings) || [];
  const shown = all.slice(0, MAX_REPORTED_FINDINGS);
  const more = all.length - shown.length;
  const pids = all.map((f) => f.pid);
  const ruleIds = [...new Set(all.map((f) => f.rule_id))].join(", ") || FALLBACK_RULE_ID;
  const line = (f) =>
    `pid ${f.pid} (parent ${f.ppid}; ${f.kind}; ${f.pcpu}% CPU; running ${formatEtime(f.etimeSec)}): ${f.command}`;

  const report = [
    ...shown.map((f) => `${line(f)} — stop it with \`kill ${f.pid}\``),
    ...(more > 0 ? [`…and ${more} more classified process(es) in this session: pids ${pids.slice(MAX_REPORTED_FINDINGS).join(" ")}`] : []),
  ];

  // GROUP ADVICE, only where it cannot reach past the group. `pkill -P <ppid>` signals EVERY
  // child of that parent, so it is offered only for a parent that is neither the session
  // CLI nor the hook's own launcher — pointed at the session root it would kill every tool
  // shell and server the session owns.
  const byParent = new Map();
  for (const f of all) {
    if (f.parentIsSessionRoot) continue;
    if (!byParent.has(f.ppid)) byParent.set(f.ppid, []);
    byParent.get(f.ppid).push(f.pid);
  }
  for (const [ppid, kids] of byParent) {
    if (kids.length < 2) continue;
    report.push(
      `pids ${kids.join(", ")} share parent ${ppid}: \`kill ${kids.join(" ")}\` stops exactly these; ` +
        `\`pkill -P ${ppid}\` stops EVERY child of that parent, not only these — check it is a throwaway wrapper first. ` +
        `If the parent respawns them, stop it too with \`kill ${ppid}\`.`,
    );
  }
  report.push(
    "This hook did NOT stop, signal or kill anything. Every process above is still running until you stop it.",
    "Never use a name-wide kill (`pkill node`, `killall node`, `killall python`): this is a shared machine and a name match reaches other sessions' processes.",
    `Confirm they are gone: \`ps -o pid,pcpu,etime,command -p ${pids.slice(0, MAX_REPORTED_FINDINGS).join(",")}\` prints only the header once every one has exited.`,
    "State why the load was generated. A timing- or load-dependent failure is reproduced by forcing the budget, injecting a clock, or stubbing the slow call — never by generating CPU load.",
    "Scope of what was checked: only processes descended from THIS session's CLI process. A loop launched with `&` from a shell that has since exited is reparented outside the session and is NOT visible here — if you launched one that way, find and stop it yourself.",
  );

  const n = all.length;
  return {
    hookEvent: "PostToolUse",
    severity: "halt-and-report",
    what_happened:
      `${n} process(es) started by this session ${n === 1 ? "is" : "are"} burning shared CPU as ` +
      `synthetic load: ${shown.map((f) => `pid ${f.pid} \`${f.command}\``).join("; ")}` +
      (more > 0 ? `; and ${more} more` : "") +
      ". They are still running.",
    why:
      `${ruleIds} — a shared machine's CPU is purchased capacity every concurrent session draws on; a ` +
      "busy loop or load generator starves that work without producing any of its own (journal/0609: " +
      "load average 319.88 on 16 cores from three groups of `node -e` busy loops). The process table is " +
      "a structural read, but each command column is classified lexically, and stopping a process is " +
      "your act rather than the hook's — so this reports, and neither refuses nor kills.",
    agent_must_report: report,
    agent_must_wait:
      "Stop the listed processes now with the commands above — they are this session's own — and launch no " +
      "further load. If a listed process is one you did not start, or one that must keep running, do NOT kill " +
      "it: say which and why, and wait for the operator.",
    user_summary:
      `ci-cost-discipline — ${n} CPU-burning process(es) from this session still running ` +
      `(pid ${pids.slice(0, 6).join(", ")}${n > 6 ? ", …" : ""}); the hook did not stop them.`,
  };
}

/**
 * The synthetic-load classifier, loaded LAZILY and optionally. Absent or malformed ⇒ null,
 * which the caller treats as silence. `requireFn` is a test seam.
 *
 * The returned function FORWARDS its context argument. It previously dropped it, which made
 * the conditional re-classification in `classifyRow` structurally impossible — every call
 * reached the classifier as `classifyArgv(argv)` however it was made here.
 */
function loadClassifier(requireFn) {
  try {
    const req = typeof requireFn === "function" ? requireFn : require;
    const W = req("./synthetic-load.js");
    if (W && typeof W.classifyArgv === "function") return (argv, ctx) => W.classifyArgv(argv, ctx);
  } catch {
    // fail open
  }
  return null;
}

/**
 * The classifier's CONDITIONAL load words (`yes`, `dd`, `cat`, the hash tools …), loaded the
 * same way and equally optionally. Absent ⇒ null ⇒ `classifyRow` re-classifies nothing, which
 * is the pre-existing behaviour and silent. Read from the classifier rather than copied here:
 * a second copy of that list would drift, and the drift direction is silence.
 */
function loadConditionalLoadWords(requireFn) {
  try {
    const req = typeof requireFn === "function" ? requireFn : require;
    const W = req("./synthetic-load.js");
    const words = W && W.CONDITIONAL_LOAD_TOOL_WORDS;
    if (words && typeof words.has === "function") return words;
  } catch {
    // fail open
  }
  return null;
}

module.exports = {
  PS_CANDIDATES,
  PS_ARGS,
  PS_TIMEOUT_MS,
  PS_MAX_BUFFER,
  BUSY_LOOP_MIN_PCPU,
  BUSY_LOOP_MIN_ETIME_SEC,
  MAX_REPORTED_FINDINGS,
  COMMAND_MAX,
  FALLBACK_RULE_ID,
  CLI_BASENAMES,
  CLI_VERSIONED_PATH,
  resolvePsBinary,
  readProcessTable,
  parseEtime,
  parsePsTable,
  isSessionCliCommand,
  findSessionRoot,
  descendantsOf,
  commandToArgv,
  classifyRow,
  sanitizeCommand,
  assessSessionLoad,
  buildEmitPayload,
  formatEtime,
  loadClassifier,
  loadConditionalLoadWords,
};
