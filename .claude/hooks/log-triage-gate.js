#!/usr/bin/env node
/**
 * @hook-event: Stop (lifecycle) — recent log entries already exist at the turn boundary and can be surfaced before the session moves on.
 *
 * Hook: log-triage-gate
 * Event: Stop
 * Purpose: Surface unacknowledged WARN+ log entries at session end so the
 *          next session doesn't inherit silent breakage.
 *
 *   At Stop time:
 *   - Scan *.log files modified in the last 120 minutes for WARN/ERROR/FAIL
 *     and for the structured lowercase severity forms real toolchains emit
 *   - Dedup entries by (file, message-pattern) to keep output tractable
 *   - Emit a disposition summary as a warning (non-blocking)
 *   - DISCLOSE any truncation, so the reported count is never read as a total
 *
 * Non-blocking by design. The /wrapup command owns the hard gate; this hook
 * just makes sure the warnings never disappear silently between sessions.
 *
 * SCAN BOUNDS, and why they are enforced HERE rather than by the timer above.
 * `clearTimeout` fires before any scanning starts, and even if it did not, a
 * JS timer cannot interrupt a synchronous walk or `spawnSync` — the event
 * loop is blocked for the whole scan. The stdin timer therefore covers only the
 * wait for stdin. Every bound that matters is explicit and synchronous:
 * FILE_ENUM_CEILING and ENUM_BUDGET_MS on enumeration, FILE_SCAN_CAP on files
 * read, PER_FILE_LINE_CAP on lines per file, and SCAN_BUDGET_MS as a
 * wall-clock deadline checked between files — and every one of those deadlines
 * is CLAMPED to one absolute hook deadline (HOOK_BUDGET_MS from hookMain
 * entry), so the phases cannot sum past the dispatcher's timeout. The
 * arithmetic is stated once, at HOOK_BUDGET_MS below.
 *
 * Exit Codes:
 *   0 = success (always, since this is advisory)
 *   1 = hook error
 */

/**
 * @hook-contract
 * {
 *   "side_effects": {
 *     "fs_writes": [],
 *     "network": false,
 *     "spawns": ["grep"]
 *   },
 *   "idempotent": true,
 *   "may_rewrite_input": false,
 *   "notes": "spawns: one `grep` per scanned file via spawnSync (argv, no shell), reading an already-open descriptor as its stdin — grep is never handed a path. Enumeration is an in-process bounded walk (fs.realpathSync on cwd, then fs.opendirSync / fs.lstatSync) — no shell pipeline, so no child can outlive the hook. Each log is opened read-only (fs.openSync O_RDONLY|O_NOFOLLOW|O_NONBLOCK, fs.fstatSync, fs.closeSync) and bound to the walk's lstat before grep sees it. Log files are READ only (fs.readdirSync / fs.existsSync for nested-checkout pruning) and the summary renders to stdout as systemMessage — no sink, no markers, no state, so a repeat reports the same scan."
 * }
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Scan bounds
// ---------------------------------------------------------------------------
// Every one of these truncates, and every truncation is DISCLOSED (see
// triageLogs). The bug they replace was not that caps existed — it was that
// they were silent, so `N unique` read as a total when it was a floor.

// Hard ceiling on ENUMERATION. The walk stops at N, so raising this above
// FILE_SCAN_CAP costs a bounded walk, not an unbounded one — and it is what
// lets the hook know how many recent logs it declined to open instead of
// silently discarding the remainder.
const FILE_ENUM_CEILING = 500;

// How many enumerated files are actually read. Unchanged from the original
// `head -20`; raising it is a budget decision, so the fix here is to DISCLOSE
// the shortfall rather than to spend more of the Stop budget by default.
const FILE_SCAN_CAP = 20;

// Lines taken from ANY ONE file. This replaces a single GLOBAL 200-line cap
// that sat downstream of a `xargs`-driven sequential grep: one high-volume
// file could consume the entire budget before a sibling's genuine errors were
// ever read, and the result was silence indistinguishable from clean. Each
// file is now grepped independently, so no file can starve another; the cap is
// per-file and equals the old global number, so single-file behaviour is
// unchanged.
const PER_FILE_LINE_CAP = 200;

// Wall-clock deadline across all per-file greps. Files not reached before it
// expires are counted as unscanned and disclosed, rather than silently lost.
const SCAN_BUDGET_MS = 2500;

// What ONE grep may return, and what ONE matched line may cost after it has.
// grep's stdout is capped at GREP_MAX_BUFFER (an overflow kills it and the file
// is disclosed as unreadable). Each matched line is rendered to DISPLAY_CHARS
// characters, and only DISPLAY_WINDOW_BYTES of it are ever decoded. Leading and
// trailing whitespace is skipped at the BYTE level first (displayLine), so the
// window starts at the line's first visible character however long the
// whitespace run before it — and 4096 bytes hold DISPLAY_CHARS characters many
// times over at the 4 bytes a UTF-8 character can take. So the post-grep work
// for a file is one native newline scan of ≤ GREP_MAX_BUFFER bytes, a byte-level
// whitespace skip that visits each of those bytes at most once from each end of
// its line, and ≤ PER_FILE_LINE_CAP x DISPLAY_WINDOW_BYTES of decoding — a
// constant, not a function of how long the file's lines are (matchedLines).
const GREP_MAX_BUFFER = 8 * 1024 * 1024;
const DISPLAY_CHARS = 120;
const DISPLAY_WINDOW_BYTES = 4096;

// Deadline for enumerating the WHOLE declared surface — every declared root AND
// the nested-checkout probe, under ONE deadline. It used to be armed afresh for
// each root, which made the enumeration's worst case 4 roots x 1500 ms = 6000 ms
// and the enumerate+scan worst case 6000 + 2500 = 8500 ms — over the 7 s the
// dispatcher allows this row, and unbounded under COC_LOG_TRIAGE_ROOTS (N roots
// x 1500 ms). The walk is in-process and checks
// it before every directory and every entry; a root that runs out is DISCLOSED
// as failed, never reported clean. It replaced a `find | head` shell pipeline
// run under execSync's timeout: on expiry Node killed only `sh`, so `find` and
// `head` were re-parented to init and kept walking — measured 5-12 orphans at a
// time, each walking a 2.37M-file tree for ~100 s, driving load to 128-180 on
// 16 cores. An in-process walk has no child to orphan. What it CANNOT do is
// preempt one blocking syscall (a single readdir batch or lstat on a hung
// mount), so the deadline is honoured at the next entry, not mid-call.
// COC_LOG_TRIAGE_ENUM_BUDGET_MS may LOWER it (a non-negative integer); a larger
// value is clamped to this constant, so the override cannot break the bound.
const ENUM_BUDGET_MS = 1500;

// The recency window: a *.log counts when modified less than this long ago.
const LOG_WINDOW_MS = 120 * 60_000;

// THE TIME BOUND, AS ARITHMETIC (L3). The dispatcher kills this row at
// DISPATCH_TIMEOUT_MS — `"timeout": 7` on the log-triage-gate.js row of
// .claude/hooks/dispatch-registry.json:548-549 (and of
// .claude/hook-registry.json:13221-13228); the audit fixture `fixture-43a`
// re-reads both values, so they cannot drift apart silently. The constants
// below live at .claude/hooks/log-triage-gate.js:84 (SCAN_BUDGET_MS), :115
// (ENUM_BUDGET_MS) and :156-158 (DISPATCH_TIMEOUT_MS, HOOK_BUDGET_MS,
// HEADROOM_MS); line numbers rot on insertion, the NAMES are the anchor. Every phase this hook runs after hookMain() is entered sits
// under ONE absolute deadline, `hookMain entry + HOOK_BUDGET_MS`:
//
//   stdin wait   — the timer fires AT the hook deadline         (≤ HOOK_BUDGET_MS)
//   enumeration  — min(start + ENUM_BUDGET_MS, hook deadline)   (≤ 1500 ms)
//   scan         — min(start + SCAN_BUDGET_MS, hook deadline);
//                  each grep gets `timeout = deadline - now`
//                  and is SIGKILLed on expiry                   (≤ 2500 ms)
//
//   ENUM_BUDGET_MS + SCAN_BUDGET_MS = 1500 + 2500 = 4000 ≤ HOOK_BUDGET_MS = 5500
//     ⇒ an ordinary run (stdin arrives at once) is never cut short by the clamp;
//   HOOK_BUDGET_MS + HEADROOM_MS = 5500 + 1500 = 7000 = DISPATCH_TIMEOUT_MS
//     ⇒ the stdin wait plus all scanning can never reach the dispatcher's kill.
//
// HEADROOM_MS pays for what happens OUTSIDE the clamped phases: node's own
// startup before hookMain() runs (CLI path), the one grep spawn/kill/reap
// straddling the scan deadline, rendering and writing the JSON, and the
// overshoot of ONE in-flight syscall past a deadline check. It also pays for
// the post-grep work of the ONE file whose grep straddles the deadline — which
// is why that work is a CONSTANT per file (GREP_MAX_BUFFER, DISPLAY_WINDOW_BYTES
// above; matchedLines), not a function of how long the file's lines are. A deadline that is
// already spent when a phase starts makes that phase do nothing and DISCLOSE it
// (roots named as failed, files counted as not scanned) — never report clean.
// NOT bounded by any of this, and named rather than hidden: a single blocking
// readdir/lstat on a hung mount is bounded by the OS, not by a JS deadline.
//
// Before this the bound did not exist: stdin waited up to 5000 ms, THEN each of
// 4 roots took up to 1500 ms, THEN the scan up to 2500 ms — 8500 ms after stdin
// (the measured worst case) and 13500 ms counting the stdin wait.
const DISPATCH_TIMEOUT_MS = 7000;
const HOOK_BUDGET_MS = 5500;
const HEADROOM_MS = DISPATCH_TIMEOUT_MS - HOOK_BUDGET_MS;
if (ENUM_BUDGET_MS + SCAN_BUDGET_MS > HOOK_BUDGET_MS || HEADROOM_MS < 1000) {
  // A constant edit that breaks the arithmetic above fails LOUDLY at load, on
  // every run, instead of quietly re-opening the overrun.
  throw new Error("log-triage-gate: time budgets no longer fit the dispatcher timeout");
}

/**
 * Detector entry — everything this script used to do at load time: arm the
 * timer, then read stdin and triage. Exported so the hook engine can run it
 * in-process (`lib/hook-engine.js`); the CLI entry at the bottom calls the same
 * function. It returns a promise that settles when the stdin `end` handler has
 * run, so the engine does not read a synchronous return as "the detector
 * finished" while the payload is still being read. The `catch` in `onStdinEnd`
 * encloses an exit and only writes output and exits (the engine's catch/finally
 * residual: in-engine it runs after the exit, and its writes are discarded).
 */
function hookMain() {
  // The ONE absolute deadline every later phase is clamped to (see
  // HOOK_BUDGET_MS). Taken at entry, not at process start, because in the hook
  // engine this function runs inside a long-lived dispatcher whose budget for
  // this row starts when the row does.
  const hookDeadline = Date.now() + HOOK_BUDGET_MS;
  const timeout = setTimeout(() => {
    console.error(
      `[HOOK TIMEOUT] log-triage-gate: no stdin within ${HOOK_BUDGET_MS}ms`,
    );
    console.log(JSON.stringify({ continue: true }));
    process.exit(1);
  }, HOOK_BUDGET_MS);

  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      try {
        onStdinEnd(input, timeout, hookDeadline);
      } catch (e) {
        return reject(e);
      }
      resolve();
    });
  });
}

function onStdinEnd(input, timeout, hookDeadline) {
  clearTimeout(timeout);
  try {
    const data = JSON.parse(input || "{}");
    const cwd = data.cwd || process.cwd();
    const messages = triageLogs(cwd, hookDeadline);
    const summary = messages.map((m) => m.message).join("\n");
    console.log(
      JSON.stringify({
        continue: true,
        ...(summary ? { systemMessage: summary } : {}),
      }),
    );
    process.exit(0);
  } catch (error) {
    console.error(`[HOOK ERROR] log-triage-gate: ${error.message}`);
    console.log(JSON.stringify({ continue: true }));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Log triage
// ---------------------------------------------------------------------------

// Directories pruned from the log scan. These produce WARN+ entries that are
// NOT session-actionable (tool caches, browser captures, build output, VCS
// internals, language package dirs). Adding a dir here means "the agent
// cannot fix issues surfaced by logs under this path, so don't waste a
// disposition turn on them."
//
// If you add a project-specific dir, prefer putting it here upstream in loom/
// and syncing out, rather than editing downstream copies.
const EXCLUDED_DIRS = [
  ".playwright-mcp", // Playwright MCP browser console captures
  ".chrome-devtools", // Chrome DevTools MCP captures
  "node_modules",
  ".venv",
  "venv",
  ".next",
  ".nuxt",
  ".cache",
  "target", // Rust build output
  "dist",
  "build",
  ".pytest_cache",
  "__pycache__",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  "coverage",
  ".coverage",
  ".git",
  ".claude", // hook logs, learning observations
  "benchmarks", // perf measurement output (FAIL means "missed perf target", not session-actionable)
  ".evidence", // captured evidence trees (millions of files; logs inside are records, not this session's runtime)
];

// Filename-keyed allowlist of STRUCTURED APPEND-ONLY AUDIT logs (observability.md
// Rule 5a). These are machine-readable records of decisions/skips — NOT runtime
// stderr/stdout — and legitimately store verbatim text (commit subjects, verdicts)
// that false-matches a WARN|ERROR|FAIL scan. Filename exclusion is the structural
// fix Rule 5a mandates; per-finding regex suppression is BLOCKED. Composes with
// EXCLUDED_DIRS (basename match). Add a new audit log here upstream in loom/ and
// sync out, rather than editing downstream copies.
const EXCLUDED_FILES = [
  ".journal-skipped.log", // session-local journal-skip audit; stores commit subjects verbatim
];

// ---------------------------------------------------------------------------
// The severity matcher
// ---------------------------------------------------------------------------
// The original matcher was `grep -HnE 'WARN|ERROR|FAIL'` — a case-SENSITIVE
// substring scan. Measured one file per format, 8 of 12 real-world log formats
// were entirely invisible to it, including `npm ERR!` and `cargo error[E0308]`
// — this repo's own toolchain. For a Node/Rust/Go/Ruby project the gate was
// close to inert, and inert SILENTLY: it emits nothing, which an operator
// cannot tell apart from "your logs are clean".
//
// A bare `-i` is the obvious fix and the wrong one: it widens the match into
// prose ("improved error handling", "no errors were reported", "the failover
// completed cleanly"), and an advisory channel that cries wolf gets muted —
// which restores the exact silent-breakage class this hook exists to prevent.
//
// So the widening is ANCHORED instead. A lowercase severity token counts only
// where it sits in a LOG-STRUCTURAL position, never as a bare word in a
// sentence. Four arms:
//
//   A1  legacy, case-SENSITIVE substring `WARN|ERROR|FAIL`. Kept verbatim so
//       every line that matched before still matches — including the suffixed
//       forms WARNING / FAILED / FAILURE.
//   A2  a structured level FIELD: `level=error`, `"level":"warn"`,
//       `level: fatal` (Go slog, pino, bunyan, zap, logrus).
//   A3  a severity token immediately followed by a log delimiter — `error:`
//       (docker-compose), `ERR!` (npm), `error[` (cargo), `error --` (Rails).
//   A4  `failed to <verb>` (systemd, and most CLIs), whose capital-F form
//       `Failed` the old substring matcher missed entirely.
//
// Written as explicit character classes rather than passing `-i`, because the
// case-insensitivity has to apply to A2/A3/A4 WITHOUT applying to A1 — `-i` is
// a per-invocation flag and would widen the legacy substring arm into the
// prose flood described above.
//
// Pure POSIX ERE — no `\b`, no `\d`, no PCRE. Measured to behave identically
// under GNU grep 3.11, BSD grep 2.6.0-FreeBSD, and ugrep 7.5.0: 12 of 12
// formats matched, 0 of 12 prose lines matched, on all three.
const ci = (word) =>
  word
    .split("")
    .map((c) => `[${c.toUpperCase()}${c.toLowerCase()}]`)
    .join("");

// Longest-first within a shared prefix (failure before failed before fail,
// error before err, warning before warn) so the alternation cannot settle on a
// short arm and then fail the delimiter check.
const SEVERITY_WORDS = [
  "warning",
  "warn",
  "error",
  "err",
  "failure",
  "failed",
  "fail",
  "fatal",
  "panic",
];

const SEV = SEVERITY_WORDS.map(ci).join("|");
const NOT_WORD_CHAR = "[^[:alnum:]_]";

const SEVERITY_PATTERN = [
  // A1 — legacy case-sensitive substring (unchanged behaviour)
  "WARN|ERROR|FAIL",
  // A2 — structured level field: level=error / "level":"warn" / level: fatal
  `${ci("level")}"?[[:space:]]*[:=][[:space:]]*"?(${SEV})`,
  // A3 — severity token abutting a log delimiter: error: / ERR! / error[ / error --
  `(^|${NOT_WORD_CHAR})(${SEV})(:|!|\\[|[[:space:]]+--)`,
  // A4 — "failed to <verb>" (systemd et al)
  `(^|${NOT_WORD_CHAR})${ci("failed")}[[:space:]]+${ci("to")}[[:space:]]`,
].join("|");

/**
 * Render any terminal control byte VISIBLE and INERT (L4). Filenames and log
 * content are attacker-influenced bytes — anything that can write a log, or name
 * one, in a scanned directory — and the systemMessage is shown in a terminal.
 * JSON transport escapes C0 on the wire, but the host DECODES it before display,
 * so a raw ESC would reach the terminal: an OSC title write, a CSI screen clear,
 * a cursor move that overprints the line above. Every C0 byte except TAB, DEL,
 * and every C1 code point (U+0080-U+009F, including the 8-bit CSI U+009B) is
 * rewritten as a literal `\xHH`. Escaping the ESC introducer is what neutralises
 * a whole escape SEQUENCE: its remaining bytes (`[2J`, `]0;title`) are printable
 * text once nothing introduces them. Newline is escaped too, because one entry
 * MUST stay one line — a filename carrying `\n` must not forge a second entry.
 */
const CONTROL_BYTES = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g;
function inert(s) {
  return String(s).replace(
    CONTROL_BYTES,
    (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

/**
 * Render every INVISIBLE format character as a literal `\u{H…}`. These are not
 * control bytes, so `inert` leaves them alone, yet each one changes what an
 * operator sees: U+2028 / U+2029 are line terminators (a log line carrying one
 * renders as two rows, the second free to imitate another file's entry), the
 * bidi overrides and isolates reorder the text after them, and the zero-width
 * characters and BOM hide text. Applied to log CONTENT (displayLine) as well as
 * to filenames (renderPath): a log's bytes are as attacker-influenced as its
 * name.
 */
const FORMAT_CHARS = /[\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
function visibleFormat(s) {
  return String(s).replace(
    FORMAT_CHARS,
    (ch) => `\\u{${ch.codePointAt(0).toString(16)}}`,
  );
}

function triageLogs(cwd, hookDeadline = Date.now() + HOOK_BUDGET_MS) {
  const messages = [];

  // 1. Scan *.log files modified recently (proxy for "this session")
  const scan = scanRecentLogs(cwd, hookDeadline);
  const unique = dedupe(scan.entries);

  // Whatever the scan declined to read, SAY SO. A count computed from a
  // truncated scan is a floor, and the original defect was not the truncation
  // — it was that nothing in the output distinguished "five clean logs" from
  // "five logs never opened".
  const shortfalls = [];
  if (scan.filesNotScanned > 0) {
    shortfalls.push(
      `${scan.filesNotScanned}${scan.enumTruncated ? "+" : ""} more recent *.log file(s) were NOT scanned (file cap ${FILE_SCAN_CAP})`,
    );
  }
  if (scan.cappedFiles > 0) {
    shortfalls.push(
      `${scan.cappedFiles} file(s) hit the ${PER_FILE_LINE_CAP}-line per-file read cap`,
    );
  }
  if (scan.unreadableFiles > 0) {
    shortfalls.push(`${scan.unreadableFiles} file(s) could not be read`);
  }
  if (scan.enumFailed) {
    const named =
      scan.failedRoots && scan.failedRoots.length > 0
        ? ` (${scan.failedRoots.map(inert).join(", ")})`
        : "";
    shortfalls.push(
      `the *.log enumeration failed or timed out for declared root(s)${named}`,
    );
  }

  if (unique.length > 0) {
    messages.push({
      severity: "warn",
      rule: "observability.md MUST Rule 5 (Log Triage Gate)",
      message: `${unique.length} unique WARN+ log entries found in recent *.log files. Review with /redteam or /wrapup before ending the session.`,
    });
    if (shortfalls.length > 0) {
      messages.push({
        severity: "warn",
        rule: "log-triage",
        message: `TRUNCATED — the count above is a FLOOR, not a total: ${shortfalls.join("; ")}.`,
      });
    }
    for (const entry of selectForDisplay(unique, 10)) {
      messages.push({
        severity: "warn",
        rule: "log-triage",
        message: `  ${renderPath(entry.file)}: ${entry.line}`,
      });
    }
    if (unique.length > 10) {
      messages.push({
        severity: "warn",
        rule: "log-triage",
        message: `  … and ${unique.length - 10} more unique entries`,
      });
    }
  } else if (shortfalls.length > 0) {
    // Zero findings AND an incomplete scan. Staying silent here is the one
    // case that is actively misleading: an operator reads no message as "the
    // tree is clean", when the truth is that some of the tree was never
    // opened. Note this fires ONLY on an incomplete scan — a clean tree that
    // was fully scanned still says nothing, because an advisory channel that
    // speaks when there is nothing to say gets muted.
    messages.push({
      severity: "warn",
      rule: "observability.md MUST Rule 5 (Log Triage Gate)",
      message: `No WARN+ entries in the *.log files that were scanned — but the scan was INCOMPLETE: ${shortfalls.join("; ")}. Absence of findings is NOT evidence the tree is clean.`,
    });
  }

  return messages;
}

// Enumerate nested git checkouts (sibling/BUILD repos like kailash-rs,
// kailash-coc-py, kailash-coc-rs) at shallow depth so the log scan can
// prune them. The Stop hook is loom's session-end signal; surfacing a
// nested repo's transient journal-skip log as a loom WARN is a false
// positive — that log is owned by the nested repo's own session
// lifecycle, not loom's. cwd itself is NOT pruned (its .git is loom's).
// Runs under the ENUMERATION deadline: it is part of enumerating, and it used to
// be the one walk with no bound at all. If the deadline expires here the probe
// stops early — and every declared root is then named as failed by
// walkDeclaredRoot, whose first act is the same deadline check, so a partial
// prune list can never be followed by a walk reported as complete.
function findNestedGitCheckouts(cwd, deadline, maxDepth = 2) {
  const out = [];
  const excludedSet = new Set(EXCLUDED_DIRS);
  function walk(dir, depth) {
    if (depth > maxDepth || Date.now() >= deadline) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (Date.now() >= deadline) return;
      if (!e.isDirectory()) continue;
      if (excludedSet.has(e.name)) continue;
      const child = path.join(dir, e.name);
      // .git can be a dir (regular repo) or a file (submodule / worktree).
      let hasGit = false;
      try {
        hasGit = fs.existsSync(path.join(child, ".git"));
      } catch {
        hasGit = false;
      }
      if (hasGit) {
        out.push(child);
        // Do not descend into a nested checkout — its inner tree is its
        // own concern; pruning the outer dir covers everything below.
        continue;
      }
      walk(child, depth + 1);
    }
  }
  walk(cwd, 1);
  return out;
}

// ---------------------------------------------------------------------------
// THE DECLARED LOG SURFACE (whole-tree find → declared enumeration)
// ---------------------------------------------------------------------------
// The enumeration used to be `find <cwd>` over the WHOLE tree (pruned): a full
// walk of whatever checkout the Stop hook fired in. That is unbounded by
// construction — the hook's cost was a function of the tree, not of the logs —
// and it made the scan surface implicit, so a log appearing anywhere changed
// what was scanned without anyone declaring it. The surface is now DECLARED,
// and each root is walked only to its declared depth. MEASURED before choosing
// the roots (loom, 2026-10-08): top-level *.log is where the harness fixtures
// and build tools drop them; `.claude/logs/` is the repo's live log dir
// (coc-telemetry-autocommit.log present); `logs/` is the consumer convention;
// `workspaces/` carries the Rule-5 "recent workspace logs" (15 tracked *.log
// under workspaces/codex-coc-parity/, plus lane evidence dirs).
//
// A MISSING declared root is a TRUE zero — the declaration says logs are not
// there, and a clean scan of an absent surface is honest. A root that EXISTS
// but cannot be enumerated (unreadable, timed out) is a FAILED scan and is
// DISCLOSED BY NAME, never reported as clean (triaged via `failedRoots`).
//
// Per-repo extension: COC_LOG_TRIAGE_ROOTS="root[:depth],root2[:depth]"
// (default depth 4 for overridden roots).
const DECLARED_LOG_SURFACE = [
  { root: ".", maxDepth: 1 },
  { root: ".claude/logs", maxDepth: 8 },
  { root: "logs", maxDepth: 8 },
  { root: "workspaces", maxDepth: 6 },
];

function declaredLogSurface() {
  const raw = process.env.COC_LOG_TRIAGE_ROOTS;
  if (!raw || !raw.trim()) return DECLARED_LOG_SURFACE;
  return raw
    .split(",")
    .map((s) => {
      const [root, d] = s.trim().split(":");
      const depth = Number.parseInt(d, 10);
      return {
        root,
        maxDepth: Number.isInteger(depth) && depth > 0 ? depth : 4,
      };
    })
    .filter((r) => r.root);
}

/**
 * Stage 1 — ENUMERATE recent *.log files over the DECLARED surface. One
 * bounded in-process walk per declared root (`walkDeclaredRoot`), each limited
 * by its declared depth and the shared FILE_ENUM_CEILING, and ALL of them —
 * nested-checkout probe included — under ONE deadline (ENUM_BUDGET_MS, clamped
 * to the hook deadline).
 * Returns the paths plus whether the enumeration truncated (ceiling) or failed
 * (a declared, existing root that could not be fully enumerated — named in
 * `failedRoots`), so a caller can say "500+" / "root X unscanned" rather than
 * reporting a partial scan as a total.
 */
function enumerateRecentLogs(cwd, hookDeadline) {
  // The session's directory is the SUBJECT, not a declared root, so it is
  // resolved once, here: a session started through a symlinked path must not
  // have its `.` root refused by the symlink rule below. Every declared root is
  // then resolved under the REAL directory and judged by its own lstat.
  let base;
  try {
    base = fs.realpathSync(cwd);
  } catch {
    base = path.resolve(cwd); // absent cwd ⇒ every root reads as declared-missing
  }
  const deadline = Math.min(Date.now() + enumBudgetMs(), hookDeadline);
  // Also prune nested git checkouts (BUILD/USE-template sibling repos that
  // happen to be nested under cwd). Their logs are owned by their own
  // session lifecycle, not loom's — surfacing them here is the documented
  // false-positive class (session-notes 2026-05-27 trap).
  const nested = new Set(
    findNestedGitCheckouts(base, deadline).map((p) => path.resolve(p)),
  );
  const files = [];
  const failedRoots = [];
  let truncated = false;
  for (const { root, maxDepth } of declaredLogSurface()) {
    if (files.length >= FILE_ENUM_CEILING) {
      truncated = true;
      break;
    }
    const abs = path.resolve(base, root);
    const r = walkDeclaredRoot(abs, {
      maxDepth,
      limit: FILE_ENUM_CEILING - files.length,
      nested,
      deadline,
      base,
    });
    if (r.missing) continue; // declared-missing ⇒ true zero
    // Whatever was found before a failure is kept: the root is still named
    // as failed, so the count stays a disclosed floor rather than a total.
    files.push(...r.files);
    // The root EXISTS but could not be fully enumerated (unreadable, budget
    // spent). Naming it is the difference between "clean" and "never looked".
    if (r.failed) failedRoots.push(root);
  }
  const enumTruncated = truncated || files.length >= FILE_ENUM_CEILING;
  return {
    files,
    enumTruncated,
    enumFailed: failedRoots.length > 0,
    failedRoots,
  };
}

function enumBudgetMs() {
  const raw = process.env.COC_LOG_TRIAGE_ENUM_BUDGET_MS;
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return ENUM_BUDGET_MS;
  return Math.min(Number.parseInt(raw.trim(), 10), ENUM_BUDGET_MS);
}

// Identity stats are taken with `bigint: true` so dev and ino compare EXACTLY:
// a 64-bit inode number does not survive conversion to a JS double, and two
// distinct inodes rounding to the same double would pass an identity check.
const lstatId = (p) => fs.lstatSync(p, { bigint: true });

/**
 * The identity of every directory from `base` (the session's real directory)
 * down to, but EXCLUDING, `abs` — the head of each chain the walk records.
 * `abs === base` yields an empty head (the root itself is added on entry). A
 * root that does not sit under `base` (an absolute or `..` override in
 * COC_LOG_TRIAGE_ROOTS) has no in-session ancestors to record, so its chain
 * starts at the root. Null when any of them is not a directory: the root is then
 * reached through something other than the tree it was declared in, and fails.
 */
function ancestorChain(base, abs) {
  const rel = path.relative(base, abs);
  if (rel === "") return [];
  if (rel.startsWith("..") || path.isAbsolute(rel)) return [];
  const chain = [];
  let cur = base;
  for (const seg of ["", ...rel.split(path.sep).slice(0, -1)]) {
    cur = seg === "" ? base : path.join(cur, seg);
    let st;
    try {
      st = lstatId(cur);
    } catch {
      return null;
    }
    if (!st.isDirectory()) return null;
    chain.push({ path: cur, dev: st.dev, ino: st.ino });
  }
  return chain;
}

/** Every directory in `chain` still IS the directory the walk recorded. */
function chainIntact(chain) {
  for (const link of chain) {
    let st;
    try {
      st = lstatId(link.path);
    } catch {
      return false;
    }
    if (!st.isDirectory() || st.dev !== link.dev || st.ino !== link.ino) return false;
  }
  return true;
}

// O_NOFOLLOW: never open what a final-component symlink points at — not even
// to reject it afterwards, since an open alone can have side effects on a
// device node. O_NONBLOCK: an entry swapped for a FIFO must not block the open
// on a writer that never comes; the fstat below then refuses the non-regular
// descriptor. Both are POSIX; where a platform lacks one (`undefined` ⇒ 0) the
// dev+ino binding still refuses any substituted file, so the flag is defence in
// depth there, never the only check.
const OPEN_BOUND_FLAGS =
  fs.constants.O_RDONLY |
  (fs.constants.O_NOFOLLOW || 0) |
  (fs.constants.O_NONBLOCK || 0);

/**
 * Open the file the walk classified, and ONLY that file. Returns a descriptor,
 * or null when what the path names now is not provably the walk's file: the
 * ancestor chain moved (checked immediately before the open and again after
 * it), the final component is a symlink (ELOOP under O_NOFOLLOW), the
 * descriptor is not a regular file with the dev+ino of the walk's lstat, or the
 * file has more than one link — refused by the walk's lstat (`entry.refused`)
 * and again by the descriptor's fstat, so a link added after the walk is
 * refused too (MED-2, walkDeclaredRoot). A null is counted as unreadable —
 * disclosed, never silently read and never clean.
 */
function openBound(entry) {
  if (entry.refused) return null;
  if (!chainIntact(entry.chain)) return null;
  let fd;
  try {
    fd = fs.openSync(entry.path, OPEN_BOUND_FLAGS);
  } catch {
    return null;
  }
  let same = false;
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    same =
      st.isFile() &&
      st.nlink === 1n &&
      st.dev === entry.st.dev &&
      st.ino === entry.st.ino &&
      chainIntact(entry.chain);
  } catch {
    same = false;
  }
  if (!same) {
    closeQuietly(fd);
    return null;
  }
  return fd;
}

function closeQuietly(fd) {
  try {
    fs.closeSync(fd);
  } catch {
    // already closed; there is nothing left to release
  }
}

/**
 * Walk ONE declared root in-process. It replaced this shell pipeline, and keeps
 * its predicates EXCEPT where a divergence is named below:
 *
 *   find <abs> -maxdepth <maxDepth>
 *     \( -type d \( -name <EXCLUDED_DIRS…> -o -path <nested…> \) -prune \)
 *     -o -type f -name '*.log' ! -name <EXCLUDED_FILES…> -mmin -120 -print
 *   | head -<limit>
 *
 * KEPT:
 * - every visited entry below the root is tested; a pruned directory is
 *   neither printed nor entered;
 * - types come from lstat / the directory entry, never a followed link (find's
 *   default -P), so a symlink BELOW the root is neither a directory nor a file
 *   and is skipped;
 * - `-name '*.log'` is a basename suffix test (`*` matches a leading dot);
 * - `-mmin -120` is "modified less than 120 minutes ago", future mtimes
 *   included;
 * - order is pre-order in directory-read order, as find emits it;
 * - the walk stops at `limit` (what `head` did) WITHOUT that being a failure.
 *
 * DIVERGES, deliberately, in four ways:
 * 1. NESTED-CHECKOUT PRUNE IS EXACT EQUALITY, NOT A GLOB. find's `-path` is a
 *    shell GLOB over the walked path, so the pipeline mis-pruned any nested
 *    checkout whose path contained `[`, `*` or `?`: `-path /r/a[1]` matches
 *    `/r/a1`, not the directory literally named `a[1]` — the checkout was
 *    walked (its logs surfaced as this session's) and an innocent sibling could
 *    be pruned instead. `nested.has(p)` compares the walked path to the probed
 *    checkout path byte for byte, which is what the prune always meant.
 * 2. AN UNREADABLE DIRECTORY FAILS THE ROOT. The pipeline's status was `head`'s,
 *    so an unreadable directory under the root (find exit 1, stderr to
 *    /dev/null) read as a clean root. It now marks the root `failed` — and the
 *    walk still continues past it, as find did.
 * 3. A ROOT THAT IS NOT A DIRECTORY FAILS (M1). find, given a symlink start
 *    point under -P, printed nothing and exited 0, so a declared root replaced
 *    by a symlink — or by a file, fifo or socket — read as an empty, CLEAN
 *    root. A declared root is a declared DIRECTORY: anything else is reported
 *    failed and is never followed. A root whose path does not exist at all
 *    (lstat ENOENT / ENOTDIR) is still a true zero (`missing`), dangling
 *    symlinks excluded: those exist, and fail.
 * 4. A DIRECTORY SWAPPED FOR A SYMLINK MID-WALK FAILS (L1). Between the lstat
 *    that classifies a path as a directory and the opendir that reads it, the
 *    path can be replaced by a symlink, and opendir FOLLOWS links — so the walk
 *    would enumerate wherever the link points. Every directory is therefore
 *    identity-checked: lstat (must be a directory), opendir, then lstat again —
 *    dev AND ino must equal the first lstat and it must still be a directory, or
 *    the opened handle is closed unread and the root is named failed. The check
 *    brackets the open with two lstats rather than fstat'ing the opened handle
 *    because Node offers no way to: fs.Dir exposes no descriptor, and fd-relative
 *    enumeration is unavailable on darwin (MEASURED: opendir('/dev/fd/<n>') on a
 *    directory descriptor → ENOTDIR).
 *
 *    WHAT THIS BRACKET NO LONGER HAS TO CARRY. Until MED-1 it was the only thing
 *    between a swapped directory and grep reading what that directory held, so
 *    its residuals — a swap AND swap-back inside the bracket, or an ANCESTOR
 *    swapped after its own check — were content disclosures. They are not any
 *    more: the walk only yields NAMES, and no byte of a named file is read until
 *    the scan has bound it (scanRecentLogs § THE BYTES READ ARE THE FILE THE
 *    WALK CLASSIFIED). A directory listed through a swapped ancestor yields
 *    names whose recorded chain no longer matches the tree, so each is refused
 *    and COUNTED as unreadable; the residual here is a name, never content.
 *    The residual that survives the scan-side binding is stated once, there.
 *
 * The deadline is checked before each directory is opened and before each
 * entry is read. A JS deadline cannot preempt one blocking syscall, so a hung
 * readdir or lstat is bounded by the OS, not by this budget — but no child
 * process exists, so nothing can be left running after the hook exits.
 */
function walkDeclaredRoot(abs, { maxDepth, limit, nested, deadline, base = abs }) {
  const files = [];
  const excludedDirs = new Set(EXCLUDED_DIRS);
  const excludedFiles = new Set(EXCLUDED_FILES);
  const recentAfter = Date.now() - LOG_WINDOW_MS;
  const stack = [];
  // `failed` DISCLOSES (the root is named); `outOfTime` STOPS. An unreadable
  // subdirectory is the first without the second: it is skipped, as find
  // skipped it, and the rest of the root is still walked.
  let failed = false;
  let outOfTime = false;

  const isPruned = (p, name) => excludedDirs.has(name) || nested.has(p);
  // Returns the lstat that classified `p` as a recent log, or null. That lstat
  // is CARRIED to the scan, which reads only a descriptor whose dev+ino equal it
  // (scanRecentLogs § THE BYTES READ). A path re-typed since the directory read
  // (no longer a regular file) is a failed root, as for directories below.
  const recentLogStat = (p, name) => {
    if (!name.endsWith(".log") || excludedFiles.has(name)) return null;
    let st;
    try {
      st = lstatId(p);
    } catch {
      return null; // vanished between read and stat ⇒ nothing to report
    }
    if (!st.isFile()) {
      failed = true; // swapped under us ⇒ not read, and not reported clean
      return null;
    }
    return st.mtimeMs > recentAfter ? st : null;
  };
  // A file with more than one link is NOT provably part of the declared
  // surface: a hard link planted in a scanned directory names an inode whose
  // other name can sit anywhere on the filesystem, so its bytes are another
  // file's (MED-2). The dev+ino binding cannot see this — it proves the bytes
  // read are the inode the walk classified, and here they are. Such a file is
  // still ENUMERATED, so it is counted and disclosed as unreadable, never read
  // and never silently dropped; openBound repeats the check on the descriptor.
  const refused = (st) => st.nlink > 1n;
  const sameDir = (a, b) =>
    b.isDirectory() && a.dev === b.dev && a.ino === b.ino;
  // `pre` is the lstat that classified `p` as a directory. The handle is kept
  // only if `p` still names THAT directory after the open (DIVERGES 4). `chain`
  // is the identity of every directory from the session root down to and
  // including `p`, recorded as the walk enters it; each file found below `p`
  // carries it, so the scan can re-verify the whole path it is about to open.
  const enter = (p, depth, pre, parentChain) => {
    if (Date.now() >= deadline) {
      failed = outOfTime = true;
      return;
    }
    let dir;
    try {
      dir = fs.opendirSync(p);
    } catch {
      failed = true; // exists but unreadable ⇒ never looked, not clean
      return;
    }
    let post = null;
    try {
      post = lstatId(p);
    } catch {
      post = null; // gone after the open ⇒ cannot vouch for what was opened
    }
    if (post === null || !sameDir(pre, post)) {
      try {
        dir.closeSync();
      } catch {
        // nothing was read from it; the handle is released either way
      }
      failed = true; // swapped under us ⇒ never enumerated, not clean
      return;
    }
    const chain = parentChain.concat({ path: p, dev: pre.dev, ino: pre.ino });
    stack.push({ dir, path: p, depth, chain });
  };

  try {
    let st;
    try {
      st = lstatId(abs);
    } catch (e) {
      if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) {
        return { files, failed: false, missing: true };
      }
      return { files, failed: true };
    }
    // DIVERGES 3: a declared root is a directory, or it is a failed root.
    if (!st.isDirectory()) return { files, failed: true };
    // The directories BETWEEN the session root and this declared root (e.g.
    // `.claude` above `.claude/logs`) head every chain, so a swap of one of them
    // is seen at read time exactly as a swap below the root is.
    const head = ancestorChain(base, abs);
    if (head === null) return { files, failed: true };
    if (!isPruned(abs, path.basename(abs)) && maxDepth > 0) enter(abs, 0, st, head);

    while (stack.length > 0 && !outOfTime && files.length < limit) {
      if (Date.now() >= deadline) {
        failed = outOfTime = true;
        break;
      }
      const top = stack[stack.length - 1];
      let ent;
      try {
        ent = top.dir.readSync();
      } catch {
        failed = true; // this directory stopped yielding entries; leave it
        ent = null;
      }
      if (ent === null) {
        try {
          stack.pop().dir.closeSync();
        } catch {
          // a failed read may already have released the handle
        }
        continue;
      }
      const p = path.join(top.path, ent.name);
      const depth = top.depth + 1;
      if (ent.isDirectory()) {
        if (!isPruned(p, ent.name) && depth < maxDepth) {
          let pre = null;
          try {
            pre = lstatId(p);
          } catch {
            pre = null; // vanished between read and stat ⇒ nothing to enter
          }
          if (pre !== null && pre.isDirectory()) enter(p, depth, pre, top.chain);
          else if (pre !== null) failed = true; // re-typed since the read
        }
      } else if (ent.isFile()) {
        const st = recentLogStat(p, ent.name);
        if (st !== null) files.push({ path: p, st, chain: top.chain, refused: refused(st) });
      }
    }
  } finally {
    for (const frame of stack) {
      try {
        frame.dir.closeSync();
      } catch {
        // already closed or never fully opened; nothing left to release
      }
    }
  }
  return { files: files.slice(0, limit), failed };
}

/**
 * Stage 2 — MATCH, one grep per file. Runs without a shell, so no path needs
 * quoting and no metacharacter in a checkout's name can reach a command line.
 *
 * `-m` is asked of a SINGLE file per invocation, where its meaning is the same
 * in every grep implementation (the BSD/GNU divergence is only about how a cap
 * applies ACROSS files). It is asked for one line MORE than the cap so that
 * "this file was truncated" is decidable rather than inferred from a count
 * that could legitimately have landed exactly on the cap.
 *
 * ATTRIBUTION COMES FROM THE LOOP, NEVER FROM GREP'S OUTPUT (L2). grep runs
 * with `-h` (no filename) and every match is attributed to `file`, the path
 * this loop handed it. The previous `-H` form re-parsed `<file>:<n>:<text>`
 * out of grep's stdout, so the filename was whatever that parse produced: a
 * log named `decoy:1:x.log` was reported as `decoy` with forged content, and a
 * name carrying a newline split into a second, fabricated entry attributed to
 * a file that does not exist.
 *
 * THE BYTES READ ARE THE FILE THE WALK CLASSIFIED (MED-1). grep used to be
 * handed the PATH, and grep opens a path the ordinary way: it follows a final
 * symlink and resolves every ancestor directory afresh. Anyone able to rename
 * inside a scanned directory could swap the entry — or a directory above it —
 * after the walk had lstat'd it, and the bytes of a file OUTSIDE the declared
 * surface were reported as this session's finding (a review executed it: 9
 * leaks in 40 runs of a racing swap loop). Each file is now read ONLY through a
 * descriptor bound to what the walk saw (`openBound`):
 *   1. every directory from the session root down to the file's parent is
 *      re-lstat'd and must carry the dev+ino the walk recorded on entering it;
 *   2. the file is opened O_RDONLY|O_NOFOLLOW|O_NONBLOCK — a final-component
 *      symlink fails (ELOOP) without being followed, a FIFO cannot block;
 *   3. fstat of the DESCRIPTOR must be a regular file with the dev+ino of the
 *      walk's own lstat — a hard link swapped in, a rename-over or any
 *      substitute differs — and must have exactly ONE link, as the walk's
 *      lstat did: a hard link PLANTED before the walk carries the outside
 *      file's inode from the start, so only the link count can refuse it (MED-2);
 *   4. step 1 is repeated, after the open;
 *   5. grep reads that descriptor as stdin (`-`) and never receives a path.
 * Any failure closes the descriptor unread and COUNTS the file as unreadable —
 * disclosed, never silently read and never reported clean. Every descriptor is
 * closed once spawnSync returns, on the timeout/kill path as on success.
 *
 * RESIDUAL, NAMED NOT HIDDEN. Node has no openat / O_BENEATH /
 * RESOLVE_NO_SYMLINKS, so an ancestor is verified by path, one lstat per
 * directory, rather than held open. What remains is a MULTI-swap race on an
 * ancestor directory: the walk's lstat of the file AND the open must both
 * resolve through the swapped ancestor (else step 3 refuses — the inode differs),
 * while each per-directory lstat of BOTH chain checks lands on the original —
 * at least three state transitions after the walk, two of them inside windows
 * of a few syscalls (the remaining chain lstats before the open; the fstat and
 * chain lstats after it). A single swap, or a swap that is held, is refused.
 * The final component is fully bound: once the walk has classified a file, no
 * swap of that entry, at any later moment, can make grep read a different one.
 */
function scanRecentLogs(cwd, hookDeadline = Date.now() + HOOK_BUDGET_MS) {
  const { files, enumTruncated, enumFailed, failedRoots } =
    enumerateRecentLogs(cwd, hookDeadline);

  const toScan = files.slice(0, FILE_SCAN_CAP);
  const entries = [];
  const deadline = Math.min(Date.now() + SCAN_BUDGET_MS, hookDeadline);
  let scannedCount = 0;
  let cappedFiles = 0;
  let unreadableFiles = 0;

  for (const entry of toScan) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break; // out of budget; the shortfall is disclosed below
    const fd = openBound(entry);
    if (fd === null) {
      unreadableFiles++;
      continue;
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      // The binding checks spent the last of the budget: this file is NOT
      // scanned (disclosed as such below), not unreadable.
      closeQuietly(fd);
      break;
    }
    let r;
    try {
      // grep reads the BOUND descriptor as its stdin (`-`) and never receives a
      // path, so nothing it does can resolve the name again.
      // `-a` (HIGH-1): read the file as TEXT whatever bytes it holds. Without
      // it, one NUL or invalid-UTF-8 byte makes GNU grep exit 0 with an empty
      // stdout and `binary file matches` on stderr, and BSD grep print that
      // phrase in place of every match — the file's findings either vanish
      // while it counts as scanned, or are replaced by a line that is not one.
      r = spawnSync(
        "grep",
        ["-a", "-m", String(PER_FILE_LINE_CAP + 1), "-hnE", SEVERITY_PATTERN, "-"],
        {
          stdio: [fd, "pipe", "pipe"],
          timeout: left,
          // SIGKILL, not the default SIGTERM: the HOOK_BUDGET_MS arithmetic
          // assumes a grep straddling the deadline is gone when the timeout
          // fires, and a SIGTERM can be caught or ignored.
          killSignal: "SIGKILL",
          maxBuffer: GREP_MAX_BUFFER,
        },
      );
    } finally {
      // spawnSync has returned, so the child is gone (exited or killed and
      // reaped): the descriptor is released on every path, timeout included.
      closeQuietly(fd);
    }
    // grep's exit status is the discriminator: 0 = matched, 1 = no match, and
    // anything else (2 = grep error, null = killed by the timeout or by
    // maxBuffer, r.error = could not spawn at all) means this file did NOT
    // produce a trustworthy answer. Counting those as "scanned, nothing found"
    // is precisely the silence-reads-as-clean failure being fixed here — a
    // missing grep binary would have reported every session as clean forever.
    if (r.error || (r.status !== 0 && r.status !== 1)) {
      unreadableFiles++;
      continue;
    }
    const { lines, capped } = matchedLines(r.stdout);
    // Exit 0 SAYS "matched", so a matched file that yielded no line is a grep
    // whose answer cannot be read — the `binary file matches` shape above, or
    // any grep that reports a match without printing it. Counting it scanned
    // would report its findings as absent; it is unreadable, and disclosed.
    if (r.status === 0 && lines.length === 0) {
      unreadableFiles++;
      continue;
    }
    scannedCount++;
    if (capped) cappedFiles++;
    for (const line of lines) entries.push({ file: entry.path, line });
  }

  return {
    entries,
    filesFound: files.length,
    filesScanned: scannedCount,
    filesNotScanned: files.length - scannedCount - unreadableFiles,
    unreadableFiles,
    enumTruncated,
    enumFailed,
    failedRoots,
    cappedFiles,
  };
}

/**
 * Pick which findings to RENDER, round-robin across files.
 *
 * The per-file read cap stops one file from starving another at the SCAN
 * layer, but that alone does not make a starved sibling visible: the display
 * window is 10 lines, and `slice(0, 10)` hands all ten to whichever file the
 * scan reached first. Measured on the motivating case — a 400-line benign
 * heartbeat log beside a file with five genuine production ERRORs — the five
 * errors reached the dedup and still rendered nowhere, in 5 of 5 runs.
 *
 * Round-robin gives every file with a finding at least one rendered line
 * before any file gets a second, so a spam log can no longer consume the
 * operator's entire view. Order within a file, and first-appearance order
 * across files, are both preserved.
 */
function selectForDisplay(entries, limit) {
  const byFile = new Map();
  for (const e of entries) {
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push(e);
  }
  const queues = Array.from(byFile.values());
  const out = [];
  let progressed = true;
  while (out.length < limit && progressed) {
    progressed = false;
    for (const q of queues) {
      if (out.length >= limit) break;
      if (q.length > 0) {
        out.push(q.shift());
        progressed = true;
      }
    }
  }
  return out;
}

/**
 * Split grep's raw stdout into display lines, doing a BOUNDED amount of work per
 * line whatever the line's length (LOW-2). The newline scan is `Buffer.indexOf`
 * — a native memchr over at most GREP_MAX_BUFFER — and the whitespace skip
 * (displayLine) visits a line's bytes from each end only until the first
 * non-whitespace character, so neither costs more than one pass over the
 * buffer. Each line then decodes at most DISPLAY_WINDOW_BYTES, and is cut to
 * DISPLAY_CHARS, made inert (L4) and its format characters visible, and cut
 * AGAIN — so the escapes cannot widen it past the display width, and the
 * per-character callbacks never see more than DISPLAY_CHARS characters.
 * Previously the WHOLE matched line was decoded, trimmed and made inert before
 * the cut: a file of `ERROR` + 40 kB of control bytes per line spent seconds in
 * per-byte callbacks after grep had already returned, past the scan deadline
 * and under none of its checks.
 *
 * The rendered text is what `trimStart().trimEnd()` of the WHOLE decoded line,
 * cut to DISPLAY_CHARS, gave, for every line. The trim is done on BYTES before
 * the window is taken — every code point those two methods strip, recognised in
 * its UTF-8 form (wsAfter / wsBefore) — so a matched line led by more than
 * DISPLAY_WINDOW_BYTES of whitespace renders its text, not the empty string a
 * window cut BEFORE trimming held. A window that stops short of the trimmed end
 * ends in a non-whitespace byte further on, so the whole-line trimEnd would
 * have removed nothing from its first DISPLAY_CHARS characters; and those
 * characters are all inside the window, because 4096 bytes decode to at least
 * 1024 characters. The first DISPLAY_CHARS characters of `inert(x)` depend only
 * on the first DISPLAY_CHARS characters of `x`, because `inert` maps each
 * character to one or more; the same holds for the format-character escape.
 *
 * `grep -hn` format: <lineno>:<content>. The FILE is the caller's loop variable
 * (scanRecentLogs § ATTRIBUTION), never parsed from the output.
 */
function matchedLines(buf) {
  const lines = [];
  let capped = false;
  let start = 0;
  const out = buf || Buffer.alloc(0);
  while (start < out.length) {
    let end = out.indexOf(0x0a, start);
    if (end === -1) end = out.length;
    const shown = end > start ? displayLine(out, start, end) : null;
    if (shown !== null) {
      if (lines.length === PER_FILE_LINE_CAP) {
        capped = true; // grep was asked for one line more than the cap
        break;
      }
      lines.push(shown);
    }
    start = end + 1;
  }
  return { lines, capped };
}

// Null for a raw line that is wholly whitespace (skipped and not counted, as the
// old `.filter((l) => l.trim())` did); otherwise the bounded display text.
function displayLine(buf, start, end) {
  // A CRLF log leaves `\r` on every line grep prints. Strip it FIRST: the old
  // `/^\d+:(.*)$/` parse failed on it (`.` does not match `\r`), so the grep
  // line number leaked into the rendered text and into the dedupe key, and N
  // identical CRLF lines reported as N distinct entries.
  if (end > start && buf[end - 1] === 0x0d) end--;
  let c = start;
  while (c < end && c - start < 20 && buf[c] >= 0x30 && buf[c] <= 0x39) c++;
  const prefixed = c > start && c < end && buf[c] === 0x3a;
  let from = prefixed ? c + 1 : start;
  let n;
  while (from < end && (n = wsAfter(buf, from, end)) > 0) from += n;
  while (end > from && (n = wsBefore(buf, from, end)) > 0) end -= n;
  if (!prefixed && from === end) return null;
  const lim = Math.min(end, from + DISPLAY_WINDOW_BYTES);
  const text = buf.toString("utf8", from, lim).slice(0, DISPLAY_CHARS);
  return visibleFormat(inert(text)).slice(0, DISPLAY_CHARS);
}

// The code points String.prototype.trim strips — WhiteSpace and LineTerminator:
// TAB VT FF SP LF CR, U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F,
// U+205F, U+3000, U+FEFF — in their UTF-8 byte forms. Every multi-byte form
// starts with a LEAD byte (never a continuation byte 0x80-0xBF), so a form found
// at a character boundary cannot be the tail of an earlier sequence, and the
// decoder reads it as the same code point; a stray continuation byte or a
// truncated sequence matches none of them, decodes to U+FFFD, and is kept.
// wsAfter: the byte length of the whitespace code point STARTING at `i`, else 0.
// wsBefore: the byte length of the one ENDING at `j` (exclusive), else 0.
function wsAfter(buf, i, end) {
  const b = buf[i];
  if (b === 0x20 || (b >= 0x09 && b <= 0x0d)) return 1;
  if (b === 0xc2) return i + 1 < end && buf[i + 1] === 0xa0 ? 2 : 0;
  if (b < 0xe1 || i + 2 >= end) return 0;
  return isWs3(b, buf[i + 1], buf[i + 2]) ? 3 : 0;
}
function wsBefore(buf, lo, j) {
  const b = buf[j - 1];
  if (b === 0x20 || (b >= 0x09 && b <= 0x0d)) return 1;
  if (j - 2 >= lo && buf[j - 2] === 0xc2 && b === 0xa0) return 2;
  return j - 3 >= lo && isWs3(buf[j - 3], buf[j - 2], b) ? 3 : 0;
}
function isWs3(a, b, c) {
  if (a === 0xe1) return b === 0x9a && c === 0x80; // U+1680
  if (a === 0xe3) return b === 0x80 && c === 0x80; // U+3000
  if (a === 0xef) return b === 0xbb && c === 0xbf; // U+FEFF
  if (a !== 0xe2) return false;
  if (b === 0x80) return (c >= 0x80 && c <= 0x8a) || c === 0xa8 || c === 0xa9 || c === 0xaf;
  return b === 0x81 && c === 0x9f; // U+205F
}

/**
 * Render a path for the attribution prefix `<path>: <line>` so that it can only
 * be read one way (LOW-3). A name containing `": "` used to render as
 * `…/a.log: FATAL db corrupted; z.log: ERROR x`, which reads as sibling `a.log`
 * reporting a FATAL. A path renders BARE only when it is printable ASCII with
 * no `"`, no `\` and no `": "` — then the first `": "` on the row IS the
 * separator, and every ordinary path renders exactly as it always did.
 * Anything else renders QUOTED: `"` and `\` are backslash-escaped, control
 * bytes become `\xHH` (inert), and invisible format characters (bidi overrides,
 * zero-width joiners, BOM) become `\u{H…}` so they cannot reorder or hide what
 * is displayed. A bare path never begins with `"`, so the two forms cannot be
 * confused, and a quoted path ends at its first unescaped `"`.
 */
const BARE_PATH = /^[\x20\x21\x23-\x5b\x5d-\x7e]*$/;
function renderPath(p) {
  const s = String(p);
  if (BARE_PATH.test(s) && !s.includes(": ")) return s;
  const escaped = visibleFormat(inert(s.replace(/[\\"]/g, (ch) => `\\${ch}`)));
  return `"${escaped}"`;
}

function dedupe(entries) {
  // Group by (file, normalized message) — same file + same message pattern = one entry
  const seen = new Map();
  for (const e of entries) {
    // Normalize: strip timestamps, line numbers, pids, hashes so similar lines collapse
    const key =
      e.file +
      "::" +
      e.line
        .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\S*/g, "<ts>")
        .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
        .replace(/\b\d{4,}\b/g, "<num>");
    if (!seen.has(key)) seen.set(key, e);
  }
  return Array.from(seen.values());
}

module.exports = { hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1")
    require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
