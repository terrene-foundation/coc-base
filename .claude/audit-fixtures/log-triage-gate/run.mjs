#!/usr/bin/env node
/*
 * Audit fixture runner for `.claude/hooks/log-triage-gate.js` — the Stop-event
 * WARN+ log triage scanner (observability.md MUST Rule 5).
 *
 * WHY THIS FILE EXISTS
 *   The hook shipped with no fixtures, in arrears of cc-artifacts.md Rule 9
 *   ("Audit Tools Ship With Committed Test Fixtures"). Its scope-restriction
 *   predicates are exactly the non-obvious kind that rule names: a 120-minute
 *   mtime window, a case-sensitive match set, a normalize-then-key dedup whose
 *   numeric arm fires only at >=4 digits, and a 10-entry display cap layered
 *   over TWO undocumented upstream caps. Every one of those can be silently
 *   weakened by an edit that still looks correct and still exits 0.
 *
 * WHY END-TO-END: the hook exports nothing. Each case drives the REAL hook the
 * way Claude Code loads it — a `{cwd}` JSON on stdin, a `{continue, systemMessage?}`
 * JSON on stdout — against a real on-disk log tree in mktemp. Structural probes
 * only (presence/absence of a filename in the emitted message, the reported
 * count, the exit status). No LLM judge, no regex over prose.
 *
 * BIPOLARITY IS THE POINT (instrument-discipline.md MUST-1 + MUST-3b). A set
 * that only ever exercises the FLAG pole passes identically against a hook that
 * flags everything, and would therefore be worth nothing. So every behaviour
 * asserted here is pinned from BOTH sides: the window flags at 119 min and is
 * silent at 121; the dedup collapses ts/hex/large-number variants AND leaves
 * small numbers, distinct files and distinct messages alone; the prunes mute
 * node_modules and a nested checkout WHILE a sibling log still surfaces.
 *
 * DIVERGENCE PINNED, NOT ASSUMED (fixture-23). `head -20` on files and
 * `head -200` on grep lines sit UPSTREAM of the dedup, so the "N unique"
 * headline is a FLOOR, not the true unique total, once a tree carries more than
 * 20 recent *.log files. Measured: 25 distinct one-line logs report 20. That is
 * undocumented in the hook's own header comment; the fixture exists so the next
 * reader meets the real behaviour rather than the described one.
 *
 * NOT COVERED HERE, DELIBERATELY: the EXCLUDED_FILES / `.journal-skipped.log`
 * audit-log exclusion (observability.md Rule 5a) already has behavioural
 * coverage in `.claude/test-harness/tests/log-triage-gate.test.mjs`, which is
 * registered in ci-suites.json. Duplicating it here would add cases without
 * adding discrimination.
 *
 * Exit 0 = all fixtures pass. Exit 1 = >=1 fixture failed.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "..", "..", "hooks", "log-triage-gate.js");

let passed = 0;
let failed = 0;

function check(name, condition, details) {
  if (condition) {
    passed++;
    process.stdout.write(`  PASS  ${name}\n`);
  } else {
    failed++;
    process.stderr.write(`  FAIL  ${name}\n`);
    if (details) process.stderr.write(`        ${details}\n`);
  }
}

/**
 * Drive the real hook. `input` is the raw stdin string so the degenerate-input
 * cases can send something that is not JSON at all.
 */
function runHookRaw(input, opts = {}) {
  const r = spawnSync("node", [HOOK], {
    input,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 30000,
    killSignal: "SIGKILL",
  });
  const stdout = r.stdout || "";
  let parsed = null;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    /* left null — a case asserting on shape will report it */
  }
  return {
    status: r.status ?? -1,
    raw: stdout,
    err: r.stderr || "",
    json: parsed,
    msg: (parsed && parsed.systemMessage) || "",
  };
}

const runHook = (cwd) => runHookRaw(JSON.stringify({ hook_event_name: "Stop", cwd }));

/**
 * Build a real log tree. `files` maps a relative path to its body; `ages` maps
 * the same key to an age in MINUTES, applied via utimes so the `-mmin -120`
 * predicate is exercised for real rather than simulated.
 */
function withLogs(files, ages = {}, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logtriage-fx-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      const p = path.join(dir, name);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body.endsWith("\n") ? body : body + "\n");
    }
    // mtimes are set AFTER every write, so creating a sibling file cannot bump
    // a directory mtime in a way that re-freshens an intentionally-stale log.
    for (const [name, minutes] of Object.entries(ages)) {
      const t = new Date(Date.now() - minutes * 60_000);
      fs.utimesSync(path.join(dir, name), t, t);
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The headline count the hook reports: "<N> unique WARN+ log entries found". */
function reportedCount(msg) {
  const m = msg.match(/^(\d+) unique WARN\+ log entries/m);
  return m ? Number(m[1]) : null;
}

/** Number of rendered per-entry lines (two-space indented, not the "… and N" tail). */
function renderedEntryLines(msg) {
  return msg.split("\n").filter((l) => /^ {2}\S/.test(l) && !l.includes("… and")).length;
}

// ===========================================================================
// THE FLAG POLE — the scan works at all
// ===========================================================================

// fixture-01: the base case. Catches a hook whose scan is wholly broken — a
// find that never matches, a grep that never fires, an emit path that drops the
// message. Without this, every CLEAN fixture below is satisfied by a no-op.
withLogs({ "app.log": "2026-08-12T10:00:00 ERROR database connection failed" }, {}, (dir) => {
  const r = runHook(dir);
  check(
    "fixture-01-fresh-error-flags",
    r.status === 0 && r.msg.includes("app.log") && reportedCount(r.msg) === 1,
    `status=${r.status} msg=${JSON.stringify(r.msg).slice(0, 220)}`,
  );
});

// fixture-02: all three tokens of the match set, in separate files so each is
// independently attributable. Catches a NARROWED match set — dropping FAIL, or
// rewriting the alternation as `WARN|ERROR` — which would silently stop
// surfacing a whole severity class while every other fixture stayed green.
withLogs(
  {
    "w.log": "WARN retry budget nearly exhausted",
    "e.log": "ERROR upstream returned 500",
    "f.log": "FAIL assertion in migration step",
  },
  {},
  (dir) => {
    const r = runHook(dir);
    check(
      "fixture-02-match-set-warn-error-fail-all-flag",
      r.msg.includes("w.log") && r.msg.includes("e.log") && r.msg.includes("f.log"),
      `one or more severity tokens did not surface: ${JSON.stringify(r.msg).slice(0, 300)}`,
    );
  },
);

// ===========================================================================
// THE CLEAN POLE — the discriminators
// ===========================================================================

// fixture-03: THE anti-vacuity arm. A log with no WARN+ token must produce NO
// systemMessage. Catches a hook that flags unconditionally — against which
// every FLAG fixture above passes and the whole set proves nothing.
withLogs({ "app.log": "2026-08-12T10:00:00 INFO started\nDEBUG cache warm\nnothing wrong here" }, {}, (dir) => {
  const r = runHook(dir);
  check(
    "fixture-03-clean-log-emits-no-message",
    r.status === 0 && r.json && r.json.continue === true && r.json.systemMessage === undefined,
    `a log with no WARN+ token still produced a message: ${JSON.stringify(r.msg).slice(0, 220)}`,
  );
});

// fixture-04: the match is case-SENSITIVE (`grep -HnE`, no -i). Catches someone
// "helpfully" adding -i, which would match `warning`, `errors`, and every
// lowercase `fail` in prose — flooding the channel until operators mute it,
// which restores the silent-breakage bug class the hook exists to prevent.
withLogs({ "app.log": "warn low signal\nerror lowercase\nfailed softly" }, {}, (dir) => {
  const r = runHook(dir);
  check(
    "fixture-04-lowercase-tokens-do-not-match",
    r.json && r.json.systemMessage === undefined,
    `lowercase warn/error/fail matched — the scan is no longer case-sensitive: ${JSON.stringify(r.msg).slice(0, 220)}`,
  );
});

// fixture-05: THE TIME-WINDOW DISCRIMINATOR. A log carrying a real ERROR but
// modified 200 minutes ago must NOT surface. Catches removal of `-mmin -120`,
// after which every historical log in the tree surfaces at every session end.
withLogs({ "old.log": "2026-08-12T05:00:00 ERROR long-since-resolved failure" }, { "old.log": 200 }, (dir) => {
  const r = runHook(dir);
  check(
    "fixture-05-stale-log-outside-window-is-silent",
    r.json && r.json.systemMessage === undefined,
    `a 200-minute-old log surfaced — the -mmin window is gone: ${JSON.stringify(r.msg).slice(0, 220)}`,
  );
});

// fixture-06: the window BOUNDARY, both sides, same shape of log. 119 min in,
// 121 min out. Catches a window silently RESIZED rather than removed (-mmin -60
// would drop real breakage on the floor; -mmin -1440 would resurrect a day of
// noise) — a mutation fixture-05 alone cannot see.
withLogs({ "inside.log": "ERROR just inside the window" }, { "inside.log": 119 }, (dir) => {
  const r = runHook(dir);
  check(
    "fixture-06a-119-minutes-is-inside-the-window",
    r.msg.includes("inside.log"),
    `a 119-minute-old log did not surface — window narrowed: ${JSON.stringify(r.msg).slice(0, 220)}`,
  );
});
withLogs({ "outside.log": "ERROR just outside the window" }, { "outside.log": 121 }, (dir) => {
  const r = runHook(dir);
  check(
    "fixture-06b-121-minutes-is-outside-the-window",
    r.json && r.json.systemMessage === undefined,
    `a 121-minute-old log surfaced — window widened: ${JSON.stringify(r.msg).slice(0, 220)}`,
  );
});

// ===========================================================================
// DEDUP — the collapse arm
// ===========================================================================

// fixture-07: three emissions of ONE failure, differing only in timestamp,
// collapse to a single entry. Catches removal of the <ts> normalizer, after
// which a tight retry loop alone fills the entire 10-entry budget and pushes
// every other failure in the session off the report.
withLogs(
  {
    "app.log": [
      "2026-08-12T10:00:01 ERROR connection pool exhausted",
      "2026-08-12T10:00:02 ERROR connection pool exhausted",
      "2026-08-12T10:00:03 ERROR connection pool exhausted",
    ].join("\n"),
  },
  {},
  (dir) => {
    const r = runHook(dir);
    check(
      "fixture-07-dedup-collapses-timestamp-variants",
      reportedCount(r.msg) === 1,
      `expected 1 unique, got ${reportedCount(r.msg)}: ${JSON.stringify(r.msg).slice(0, 300)}`,
    );
  },
);

// fixture-08: same failure at two different heap addresses collapses. Catches
// removal of the <hex> normalizer. Note the normalizer requires a literal `0x`
// prefix — a bare digest does NOT collapse, which is why this fixture uses the
// prefixed form the code actually recognises rather than an invented one.
withLogs(
  {
    "app.log": ["ERROR segfault in handler at 0xdeadbeef", "ERROR segfault in handler at 0xcafef00d"].join("\n"),
  },
  {},
  (dir) => {
    const r = runHook(dir);
    check(
      "fixture-08-dedup-collapses-hex-variants",
      reportedCount(r.msg) === 1,
      `expected 1 unique, got ${reportedCount(r.msg)}: ${JSON.stringify(r.msg).slice(0, 300)}`,
    );
  },
);

// fixture-09: same failure carrying differing large numbers (pids, byte counts,
// row ids) collapses. Catches removal of the <num> normalizer.
withLogs(
  {
    "app.log": ["ERROR worker 481920 died processing 1048576 rows", "ERROR worker 773311 died processing 2097152 rows"].join(
      "\n",
    ),
  },
  {},
  (dir) => {
    const r = runHook(dir);
    check(
      "fixture-09-dedup-collapses-large-number-variants",
      reportedCount(r.msg) === 1,
      `expected 1 unique, got ${reportedCount(r.msg)}: ${JSON.stringify(r.msg).slice(0, 300)}`,
    );
  },
);

// ===========================================================================
// DEDUP — the PRECISION arm (over-collapse is as wrong as under-collapse)
// ===========================================================================

// fixture-10: the numeric normalizer fires only at >=4 digits (`\b\d{4,}\b`), so
// small numbers stay significant and these two lines remain DISTINCT. Catches a
// normalizer widened to `\d+`, which would merge genuinely different failures —
// "retry 100" and "retry 200" are different facts — and silently under-report
// breakage. This is the mutation fixtures 07-09 cannot see: they all get MORE
// green as the normalizer widens.
withLogs({ "app.log": ["ERROR gave up after 100 retries", "ERROR gave up after 200 retries"].join("\n") }, {}, (dir) => {
  const r = runHook(dir);
  check(
    "fixture-10-dedup-keeps-small-number-variants-distinct",
    reportedCount(r.msg) === 2,
    `expected 2 unique (3-digit numbers are NOT normalized), got ${reportedCount(r.msg)}: ${JSON.stringify(r.msg).slice(0, 300)}`,
  );
});

// fixture-11: the dedup key is (file, normalized message) — the SAME text in two
// different files is two findings, because the file is where the operator has to
// go. Catches a key that drops the file component, which would hide a fault
// spreading across services behind whichever file happened to be scanned first.
withLogs({ "svc-a.log": "ERROR shared upstream timeout", "svc-b.log": "ERROR shared upstream timeout" }, {}, (dir) => {
  const r = runHook(dir);
  check(
    "fixture-11-dedup-keeps-same-message-in-different-files-distinct",
    reportedCount(r.msg) === 2 && r.msg.includes("svc-a.log") && r.msg.includes("svc-b.log"),
    `expected both files, got count=${reportedCount(r.msg)}: ${JSON.stringify(r.msg).slice(0, 300)}`,
  );
});

// fixture-12: two genuinely unrelated failures in ONE file stay two entries.
// Catches a dedup that collapses on the file component alone — one entry per
// file — which would make the report structurally incapable of showing a
// session's second distinct failure.
withLogs({ "app.log": ["ERROR disk full on /var", "ERROR certificate expired for api.internal"].join("\n") }, {}, (dir) => {
  const r = runHook(dir);
  check(
    "fixture-12-dedup-keeps-distinct-messages-in-one-file-distinct",
    reportedCount(r.msg) === 2,
    `expected 2 unique, got ${reportedCount(r.msg)}: ${JSON.stringify(r.msg).slice(0, 300)}`,
  );
});

// ===========================================================================
// THE DISPLAY CAP
// ===========================================================================

// fixture-13: 13 unique findings render 10 entries plus an "… and 3 more" tail,
// while the HEADLINE still reports the true 13. Catches both halves: a removed
// cap (all 13 rendered, flooding the Stop channel) and a headline that reports
// the truncated 10 as though it were the total, which would under-state
// breakage to the operator making the end-of-session call.
withLogs(
  { "app.log": Array.from({ length: 13 }, (_, i) => `ERROR distinct failure kind ${String.fromCharCode(97 + i)}`).join("\n") },
  {},
  (dir) => {
    const r = runHook(dir);
    check(
      "fixture-13a-cap-renders-exactly-ten-entries",
      renderedEntryLines(r.msg) === 10,
      `expected 10 rendered entries, got ${renderedEntryLines(r.msg)}: ${JSON.stringify(r.msg).slice(0, 400)}`,
    );
    check(
      "fixture-13b-headline-reports-the-true-count-not-the-cap",
      reportedCount(r.msg) === 13,
      `headline should say 13, said ${reportedCount(r.msg)}: ${JSON.stringify(r.msg).slice(0, 300)}`,
    );
    check(
      "fixture-13c-overflow-tail-names-the-remainder",
      r.msg.includes("… and 3 more unique entries"),
      `overflow tail missing or miscounted: ${JSON.stringify(r.msg).slice(0, 400)}`,
    );
  },
);

// fixture-14: exactly AT the cap, no overflow tail at all. Catches an off-by-one
// (`>=10` instead of `>10`) that would emit a nonsensical "… and 0 more".
withLogs(
  { "app.log": Array.from({ length: 10 }, (_, i) => `ERROR distinct failure kind ${String.fromCharCode(97 + i)}`).join("\n") },
  {},
  (dir) => {
    const r = runHook(dir);
    check(
      "fixture-14-exactly-ten-emits-no-overflow-tail",
      reportedCount(r.msg) === 10 && renderedEntryLines(r.msg) === 10 && !r.msg.includes("… and"),
      `count=${reportedCount(r.msg)} rendered=${renderedEntryLines(r.msg)} msg=${JSON.stringify(r.msg).slice(0, 400)}`,
    );
  },
);

// ===========================================================================
// SCOPE — what the scan must NOT reach
// ===========================================================================

// fixture-15: only `*.log` is scanned. Catches a widened glob (`-name '*'`),
// which would scan source files, fixtures and this very runner — every file
// mentioning ERROR becomes a session-end finding.
withLogs({ "app.txt": "ERROR in a text file", "archive.log.gz": "ERROR in a rotated archive" }, {}, (dir) => {
  const r = runHook(dir);
  check(
    "fixture-15-non-log-extensions-are-not-scanned",
    r.json && r.json.systemMessage === undefined,
    `a non-.log file was scanned: ${JSON.stringify(r.msg).slice(0, 220)}`,
  );
});

// fixture-16: EXCLUDED_DIRS pruning, pinned BIPOLAR in one tree — the
// node_modules log is muted AND the sibling project log still surfaces. Catches
// removal of the prune (dependency noise drowns real signal) and, equally, a
// prune so broad it mutes the whole scan. A one-sided fixture cannot tell those
// apart.
withLogs({ "node_modules/dep.log": "ERROR from a dependency", "top.log": "ERROR from the project" }, {}, (dir) => {
  const r = runHook(dir);
  check(
    "fixture-16a-excluded-dir-is-pruned",
    !r.msg.includes("dep.log"),
    `node_modules was scanned: ${JSON.stringify(r.msg).slice(0, 300)}`,
  );
  check(
    "fixture-16b-sibling-log-outside-excluded-dir-still-flags",
    r.msg.includes("top.log"),
    `the prune muted the whole scan: ${JSON.stringify(r.msg).slice(0, 300)}`,
  );
});

// fixture-17: nested git checkouts are pruned — a sibling BUILD/USE repo's logs
// belong to its own session lifecycle, not this one. Pinned bipolar for the same
// reason as fixture-16. Catches removal of findNestedGitCheckouts, the
// documented false-positive class the prune was added for.
withLogs(
  {
    "sibling/.git/HEAD": "ref: refs/heads/main",
    "sibling/nested.log": "ERROR inside a nested checkout",
    "top.log": "ERROR at the top level",
  },
  {},
  (dir) => {
    const r = runHook(dir);
    check(
      "fixture-17a-nested-git-checkout-is-pruned",
      !r.msg.includes("nested.log"),
      `a nested checkout's log surfaced: ${JSON.stringify(r.msg).slice(0, 300)}`,
    );
    check(
      "fixture-17b-top-level-log-still-flags-alongside",
      r.msg.includes("top.log"),
      `the nested-repo prune muted the whole scan: ${JSON.stringify(r.msg).slice(0, 300)}`,
    );
  },
);

// ===========================================================================
// DEGENERATE INPUT — the hook is advisory and must never take the session down
// ===========================================================================

// fixture-18: an empty *.log file. Catches a crash or a spurious finding on a
// zero-byte file, which is the ordinary state of a freshly-opened log.
withLogs({ "app.log": "" }, {}, (dir) => {
  const r = runHook(dir);
  check(
    "fixture-18-empty-log-file-is-silent",
    r.status === 0 && r.json && r.json.systemMessage === undefined,
    `status=${r.status} msg=${JSON.stringify(r.msg).slice(0, 220)}`,
  );
});

// fixture-19: no *.log anywhere. The overwhelmingly common real case; catches a
// hook that emits an empty-but-present message, training operators to ignore the
// channel.
withLogs({ "readme.md": "no logs here" }, {}, (dir) => {
  const r = runHook(dir);
  check(
    "fixture-19-no-logs-at-all-is-silent",
    r.status === 0 && r.json && r.json.continue === true && r.json.systemMessage === undefined,
    `status=${r.status} raw=${r.raw.slice(0, 220)}`,
  );
});

// fixture-20: EMPTY stdin. `JSON.parse(input || "{}")` makes this a valid Stop
// payload, so the hook must still emit protocol-shaped stdout and exit 0.
// Catches a parse path that throws on the empty string.
{
  const r = runHookRaw("");
  check(
    "fixture-20-empty-stdin-still-emits-protocol-json",
    r.status === 0 && r.json && r.json.continue === true,
    `status=${r.status} raw=${r.raw.slice(0, 220)} err=${r.err.slice(0, 160)}`,
  );
}

// fixture-21: MALFORMED stdin. Pins the actual contract, which is subtler than
// "advisory means exit 0": the hook exits 1 AND still writes `{continue:true}`.
// Catches the change that matters — a failure path that omits `continue`, or
// sets it false, and thereby lets an advisory log scanner block session end.
{
  const r = runHookRaw("not json at all");
  check(
    "fixture-21a-malformed-stdin-still-emits-continue-true",
    r.json && r.json.continue === true,
    `an advisory hook failed without emitting continue:true — raw=${r.raw.slice(0, 220)}`,
  );
  check(
    "fixture-21b-malformed-stdin-reports-error-on-stderr-and-exits-1",
    r.status === 1 && r.err.includes("[HOOK ERROR] log-triage-gate"),
    `status=${r.status} err=${r.err.slice(0, 220)}`,
  );
}

// ===========================================================================
// PINNED DIVERGENCES from the hook's own header comment
// ===========================================================================

// fixture-22: rendered entries are truncated to 120 characters. Catches removal
// of the slice, which would let a single stack-trace line blow out the Stop
// message.
withLogs({ "app.log": "ERROR " + "x".repeat(400) }, {}, (dir) => {
  const r = runHook(dir);
  const entry = r.msg.split("\n").find((l) => l.includes("app.log")) || "";
  const content = entry.slice(entry.indexOf("app.log") + "app.log: ".length);
  check(
    "fixture-22-long-line-truncated-to-120-chars",
    content.length === 120,
    `expected a 120-char entry body, got ${content.length}: ${JSON.stringify(content).slice(0, 200)}`,
  );
});

// fixture-23: THE UNDOCUMENTED CAP. `head -20` on files sits UPSTREAM of the
// dedup, so with 25 recent single-finding logs the headline reports 20 — the
// "unique entries found" number is a FLOOR, not a total. Pinned because the
// hook's header comment describes neither this cap nor the `head -200` line cap,
// and an operator reading "25 files, 20 unique" would reasonably conclude five
// logs were clean when they were never opened. Asserts the COUNT only: which 20
// files `find` yields is not ordering-stable across platforms.
{
  const many = {};
  for (let i = 0; i < 25; i++) many[`f${String(i).padStart(2, "0")}.log`] = `ERROR unique kind ${i}`;
  withLogs(many, {}, (dir) => {
    const r = runHook(dir);
    check(
      "fixture-23-file-scan-caps-at-20-so-the-count-is-a-floor",
      reportedCount(r.msg) === 20,
      `expected the head -20 file cap to yield 20, got ${reportedCount(r.msg)} — the cap moved: ${JSON.stringify(r.msg).slice(0, 300)}`,
    );
  });
}

// fixture-24: the SECOND undocumented cap — `head -200` on grep LINES (213).
// One file carrying 250 genuinely distinct findings reports 200, and the
// overflow tail inherits the truncated number (190, not the true 240). So the
// under-report reaches BOTH halves of the output, not just the headline.
// MEASURED, not inferred. Pinned so that if the cap is ever raised or removed
// the change has to be deliberate.
{
  const lines = Array.from({ length: 250 }, (_, i) => `ERROR distinct failure kind ${i}`);
  withLogs({ "big.log": lines.join("\n") }, {}, (dir) => {
    const r = runHook(dir);
    check(
      "fixture-24a-line-scan-caps-at-200",
      reportedCount(r.msg) === 200,
      `expected the head -200 line cap to yield 200 of 250, got ${reportedCount(r.msg)} — the cap moved`,
    );
    check(
      "fixture-24b-overflow-tail-inherits-the-capped-count",
      r.msg.includes("… and 190 more unique entries"),
      `tail should report 190 (200 capped - 10 shown), true remainder is 240: ${JSON.stringify(r.msg.split("\n").pop()).slice(0, 200)}`,
    );
  });
}

// fixture-25: the same under-report through the FILE cap, and specifically that
// the "… and N more unique entries" tail is WRONG rather than merely truncated.
// 25 files x 1 finding: the headline says 20 (true 25) and the tail says 10
// (true remainder 15). An operator reading the tail believes ten findings are
// hidden when fifteen are. Pinned as CURRENT BEHAVIOUR — this fixture is the
// one that reds if the count is ever made accurate, which is the correct
// signal for a deliberate fix rather than a silent drift.
{
  const f = {};
  for (let i = 0; i < 25; i++) f[`f${String(i).padStart(2, "0")}.log`] = `ERROR distinct failure ${i}`;
  withLogs(f, {}, (dir) => {
    const r = runHook(dir);
    check(
      "fixture-25-file-cap-truncates-the-overflow-tail-too",
      reportedCount(r.msg) === 20 && r.msg.includes("… and 10 more unique entries"),
      `expected headline 20 + tail 10 (true 25 / 15), got headline ${reportedCount(r.msg)}: ${JSON.stringify(r.msg.split("\n").pop()).slice(0, 200)}`,
    );
  });
}

// fixture-26: BUDGET EXHAUSTION. A high-cardinality but benign log (heartbeat
// ticks) both evades the dedup — the tick counters are 1-3 digits, below the
// `\b\d{4,}\b` normalizer's threshold — and consumes the entire 200-line grep
// budget, so a sibling file's genuine ERRORs compete for nothing. 405 true
// findings report as 200.
//
// SCOPE OF THE ASSERTION, stated precisely. Only the budget exhaustion is
// asserted, because it holds whatever order `find` yields. WHICH findings get
// evicted depends on directory traversal order, which is not guaranteed across
// filesystems — on this platform the sibling's five real ERRORs were masked
// entirely in 5 of 5 runs, but that is a measurement recorded in the README,
// NOT an assertion here. A fixture whose verdict depends on readdir order
// would be flaky on other filesystems, and a flaky fixture is worse than none.
{
  const spam = Array.from({ length: 400 }, (_, i) => `WARN heartbeat tick ${i} ok`);
  const real = Array.from({ length: 5 }, (_, i) => `ERROR genuine production failure ${i}`);
  withLogs({ "aaa-spam.log": spam.join("\n"), "zzz-real.log": real.join("\n") }, {}, (dir) => {
    const r = runHook(dir);
    check(
      "fixture-26-high-cardinality-log-consumes-the-whole-line-budget",
      reportedCount(r.msg) === 200,
      `expected 200 of 405 true findings (budget exhausted), got ${reportedCount(r.msg)}`,
    );
  });
}

// ===========================================================================
process.stdout.write(`\n${passed}/${passed + failed} fixtures pass\n`);
process.exit(failed === 0 ? 0 : 1);
