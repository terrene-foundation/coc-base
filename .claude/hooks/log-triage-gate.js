#!/usr/bin/env node
/**
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
 * JS timer cannot interrupt a synchronous `execSync`/`spawnSync` — the event
 * loop is blocked for the whole scan. The 5s guard therefore covers only the
 * wait for stdin. Every bound that matters is explicit and synchronous:
 * FILE_ENUM_CEILING on enumeration, FILE_SCAN_CAP on files read,
 * PER_FILE_LINE_CAP on lines per file, and SCAN_BUDGET_MS as a wall-clock
 * deadline checked between files.
 *
 * Exit Codes:
 *   0 = success (always, since this is advisory)
 *   1 = hook error
 */

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Scan bounds
// ---------------------------------------------------------------------------
// Every one of these truncates, and every truncation is DISCLOSED (see
// triageLogs). The bug they replace was not that caps existed — it was that
// they were silent, so `N unique` read as a total when it was a floor.

// Hard ceiling on ENUMERATION. `find | head -N` still SIGPIPEs find on a
// pathological tree, so raising this above FILE_SCAN_CAP costs a bounded walk,
// not an unbounded one — and it is what lets the hook know how many recent
// logs it declined to open instead of silently discarding the remainder.
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

// Deadline for the enumeration stage alone.
const FIND_TIMEOUT_MS = 1500;

const TIMEOUT_MS = 5000;
const timeout = setTimeout(() => {
  console.error("[HOOK TIMEOUT] log-triage-gate exceeded 5s limit");
  console.log(JSON.stringify({ continue: true }));
  process.exit(1);
}, TIMEOUT_MS);

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  clearTimeout(timeout);
  try {
    const data = JSON.parse(input || "{}");
    const cwd = data.cwd || process.cwd();
    const messages = triageLogs(cwd);
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
});

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

function triageLogs(cwd) {
  const messages = [];

  // 1. Scan *.log files modified recently (proxy for "this session")
  const scan = scanRecentLogs(cwd);
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
    shortfalls.push("the *.log enumeration itself failed or timed out");
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
        message: `  ${entry.file}: ${entry.line}`,
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
function findNestedGitCheckouts(cwd, maxDepth = 2) {
  const out = [];
  const excludedSet = new Set(EXCLUDED_DIRS);
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
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

/**
 * Stage 1 — ENUMERATE recent *.log files. Shell pipeline (find + prune + head)
 * because that genuinely needs a shell. Returns the paths plus whether the
 * enumeration itself hit FILE_ENUM_CEILING, so a caller can say "500+" rather
 * than reporting a ceiling as a total.
 */
function enumerateRecentLogs(cwd) {
  try {
    // Build -prune expression for excluded tool-cache directories so we don't
    // scan .playwright-mcp/, node_modules/, .venv/, etc. These dirs produce
    // WARN+ entries that are not session-actionable and drown real signal.
    const nameClauses = EXCLUDED_DIRS.map((d) => `-name '${d}'`).join(" -o ");
    // Also prune nested git checkouts (BUILD/USE-template sibling repos that
    // happen to be nested under cwd). Their logs are owned by their own
    // session lifecycle, not loom's — surfacing them here is the documented
    // false-positive class (session-notes 2026-05-27 trap).
    const nestedRepos = findNestedGitCheckouts(cwd);
    const pathClauses = nestedRepos
      .map((p) => `-path '${p.replace(/'/g, "'\\''")}'`)
      .join(" -o ");
    const prune = pathClauses
      ? `${nameClauses} -o ${pathClauses}`
      : nameClauses;
    // Filename-keyed exclusion for structured append-only audit logs
    // (observability.md Rule 5a) — composes with the EXCLUDED_DIRS prune.
    const fileExcludeClauses = EXCLUDED_FILES.map((f) => `! -name '${f}'`).join(
      " ",
    );
    // find: prune tool cache dirs + nested git checkouts, then match *.log
    // (excluding audit logs by filename) modified in last 120 min.
    //
    // This one genuinely needs a shell — it is a four-stage pipeline, not a
    // single spawn — so the roots are QUOTED rather than the call rewritten.
    // `cwd` used to sit in DOUBLE quotes unescaped while the nested-repo paths
    // three lines up were already single-quoted with `'\''` escaping; a `"` or
    // `$(...)` in a checkout's own path therefore broke out of the one and not
    // the other. Same escaping for both now, so the asymmetry is gone.
    const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
    // The pipeline stops at ENUMERATION. Matching used to be stapled on here
    // as `| xargs -I{} grep … | head -200`: one shared, global line budget fed
    // by sequential per-file greps, so the first high-volume file could
    // consume all of it and later files were never read. Matching now happens
    // per-file in stage 2, which removes the shared budget entirely.
    const cmd =
      `find ${shq(cwd)} \\( -type d \\( ${prune} \\) -prune \\) -o ` +
      `-type f -name '*.log' ${fileExcludeClauses} -mmin -120 -print 2>/dev/null ` +
      `| head -${FILE_ENUM_CEILING}`;
    const out = execSync(cmd, { encoding: "utf8", timeout: FIND_TIMEOUT_MS });
    const files = out.split("\n").filter((l) => l.trim());
    return { files, enumTruncated: files.length >= FILE_ENUM_CEILING, enumFailed: false };
  } catch {
    // The enumeration itself failed or timed out. Returning an empty list is
    // correct, but reporting it as "no logs found" would be the defect this
    // change exists to remove — a failed scan is not a clean scan, so the
    // caller is told which one this was.
    return { files: [], enumTruncated: false, enumFailed: true };
  }
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
 */
function scanRecentLogs(cwd) {
  const { files, enumTruncated, enumFailed } = enumerateRecentLogs(cwd);

  const toScan = files.slice(0, FILE_SCAN_CAP);
  const entries = [];
  const deadline = Date.now() + SCAN_BUDGET_MS;
  let scannedCount = 0;
  let cappedFiles = 0;
  let unreadableFiles = 0;

  for (const file of toScan) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break; // out of budget; the shortfall is disclosed below
    const r = spawnSync(
      "grep",
      ["-m", String(PER_FILE_LINE_CAP + 1), "-HnE", SEVERITY_PATTERN, file],
      { encoding: "utf8", timeout: remaining, maxBuffer: 8 * 1024 * 1024 },
    );
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
    scannedCount++;
    const lines = (r.stdout || "").split("\n").filter((l) => l.trim());
    if (lines.length > PER_FILE_LINE_CAP) {
      cappedFiles++;
      lines.length = PER_FILE_LINE_CAP;
    }
    for (const line of lines) entries.push(parseLogLine(line));
  }

  return {
    entries,
    filesFound: files.length,
    filesScanned: scannedCount,
    filesNotScanned: files.length - scannedCount - unreadableFiles,
    unreadableFiles,
    enumTruncated,
    enumFailed,
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

function parseLogLine(line) {
  // format: <file>:<lineno>:<content>
  const m = line.match(/^([^:]+):(\d+):(.*)$/);
  if (!m) return { file: "unknown", line: line.slice(0, 120) };
  return { file: m[1], line: m[3].trim().slice(0, 120) };
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
