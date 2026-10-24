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

import "../_lib/no-ambient-git.cjs";
import { spawn, spawnSync } from "node:child_process";
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

// fixture-26: NO SIBLING STARVATION (loom#1662). A high-cardinality but benign
// log (heartbeat ticks) evades the dedup — the tick counters are 1-3 digits,
// below the `\b\d{4,}\b` normalizer's threshold — and so used to consume the
// entire SHARED 200-line grep budget, after which a sibling file's genuine
// ERRORs were never read at all. Masked in 5 of 5 runs, and the resulting
// silence is indistinguishable from clean.
//
// Now each file is grepped independently under a PER-FILE cap, and the display
// window is filled round-robin across files, so the spam log can monopolise
// neither the scan nor the operator's view.
//
// ORDER-INDEPENDENT BY CONSTRUCTION, which is what makes it safe to assert the
// masking half that the previous revision could only record as a measurement.
// The old verdict turned on which file `find` yielded first — not guaranteed
// across filesystems, and a flaky fixture is worse than none. Round-robin
// selection removes that dependency: the sibling surfaces whichever order the
// two files arrive in.
{
  const spam = Array.from({ length: 400 }, (_, i) => `WARN heartbeat tick ${i} ok`);
  const real = Array.from({ length: 5 }, (_, i) => `ERROR genuine production failure ${i}`);
  withLogs({ "aaa-spam.log": spam.join("\n"), "zzz-real.log": real.join("\n") }, {}, (dir) => {
    const r = runHook(dir);
    const rendered = r.msg.split("\n").filter((l) => /^ {2}\S/.test(l) && !l.includes("… and"));
    check(
      "fixture-26a-spam-log-does-not-starve-a-sibling-of-the-scan",
      reportedCount(r.msg) === 205,
      `expected 200 (capped spam) + 5 (sibling) = 205 findings, got ${reportedCount(r.msg)} — a shared budget is starving the sibling again`,
    );
    // ALL FIVE DISTINCT ERRORS, identified by CONTENT. The sibling has exactly 5
    // genuine ERRORs and the display window is 10, so every one of them fits;
    // "are actually RENDERED" is a claim about all five, and the assertion says
    // so in the only terms that cannot be satisfied by a proxy.
    //
    // TWO EARLIER FORMS OF THIS CHECK WERE NON-DISCRIMINATING, both measured:
    //
    //   `.some()`               — ONE line in ten satisfies it. Replacing
    //     selectForDisplay's round-robin with a greedy fill moved the composition
    //     from 5-of-5 sibling rows to 1-of-5 and this fixture stayed 59/59 GREEN.
    //
    //   `fromSibling === 5`     — counts ROWS, which is a PROXY for distinct
    //     errors. Mutating `out.push(q.shift())` to `out.push(q[0])` (peek, never
    //     consume) renders the SAME error five times: rows stay 5, DISTINCT lines
    //     go 5 → 1, and four of five genuine production ERRORs are still starved
    //     out of the operator's view — loom#1662 exactly, in the form the pin
    //     exists to catch. 59/59 GREEN again. The fix for a non-discriminating
    //     assertion was itself non-discriminating one step over.
    //
    // Both mutations were proven NON-INERT by measuring the RENDERED OUTPUT
    // directly (distinct sibling lines, and which error indices appear), never by
    // reading the verdict — a verdict cannot tell an inert mutation from a blind
    // assertion.
    //
    // Anchoring on `ERROR genuine production failure <i>` for EACH i closes the
    // repeat class (a duplicate contributes no new index), the distinct-but-wrong
    // class (a set-size check alone would accept five unrelated lines), and
    // severity mislabelling (the rendered line carries `ERROR`). Guards loom#1662.
    const sibling = rendered.filter((l) => l.includes("zzz-real.log"));
    const missingErrors = [0, 1, 2, 3, 4].filter(
      (i) => !sibling.some((l) => l.includes(`ERROR genuine production failure ${i}`)),
    );
    check(
      "fixture-26b-sibling-genuine-errors-are-actually-RENDERED",
      rendered.length === 10 && missingErrors.length === 0,
      `the sibling's genuine ERRORs reached the count but not the operator's view: rendered=${rendered.length} siblingRows=${sibling.length} distinct=${new Set(sibling).size} MISSING errors=[${missingErrors.join(",")}] (expected all 5 of 5 distinct — a window of 10 fits every one)`,
    );
    // 26d — THE SPAM SIDE IS NOT SILENTLY COLLAPSED EITHER.
    //
    // Deliberately its OWN case rather than a clause bolted onto 26b. 26b is named
    // for the SIBLING side and asserts that all five genuine ERRORs reach the view;
    // this asserts a different property of a different file, and folding the two
    // together would over-fit a case to a claim its name does not make.
    //
    // The property: the display window must not spend slots on REPEATS. The hook
    // dedupes upstream, so a duplicate rendered row means either dedupe failed or
    // selection re-emitted one entry — both real defects, and both invisible to
    // every other case here. Measured: making the largest queue yield its first
    // entry every time moves the spam side from 5 rows / 5 distinct to 5 rows /
    // 1 distinct while the sibling side stays intact, and 26a/26b/26c ALL stay
    // green. That mutation was proven non-inert by reading the rendered
    // composition of BOTH files, never a verdict.
    //
    // 26b correctly stays green under it: no genuine ERROR is starved, which is
    // the only thing 26b claims. Two properties, two cases.
    const spam = rendered.filter((l) => l.includes("aaa-spam.log"));
    check(
      "fixture-26d-the-spam-side-is-not-collapsed-into-repeats",
      spam.length > 0 && new Set(spam).size === spam.length,
      `the display window spent slots on duplicate rows: spamRows=${spam.length} distinct=${new Set(spam).size} — a repeat wastes a slot a distinct finding could have used`,
    );
    check(
      "fixture-26c-the-per-file-cap-still-exists",
      r.msg.includes("200-line per-file read cap"),
      `the per-file cap was removed or stopped being disclosed — an unbounded read is a different defect, not a fix: ${JSON.stringify(r.msg.split("\n")[1] || "").slice(0, 200)}`,
    );
  });
}

// ===========================================================================
// TRUNCATION IS DISCLOSED (loom#1661) — the count is a FLOOR and says so
// ===========================================================================
// The caps are not the defect; SILENT caps are. Each disclosure below is
// pinned BIPOLAR — a hook that announced truncation unconditionally would
// satisfy the positive arm and is caught by the negative one.

// fixture-27: the FILE cap discloses the files it declined to open. 25 recent
// logs, 20 scanned. Catches the original defect exactly: a headline of 20 that
// an operator reads as "25 files, 20 with findings, 5 clean" when five were
// never opened at all.
{
  const f = {};
  for (let i = 0; i < 25; i++) f[`f${String(i).padStart(2, "0")}.log`] = `ERROR distinct failure ${i}`;
  withLogs(f, {}, (dir) => {
    const r = runHook(dir);
    check(
      "fixture-27a-file-cap-shortfall-is-disclosed",
      r.msg.includes("FLOOR") && r.msg.includes("5 more recent *.log file(s) were NOT scanned"),
      `the scan silently dropped 5 files: ${JSON.stringify(r.msg.split("\n").slice(0, 2)).slice(0, 300)}`,
    );
  });
}
// fixture-27b: THE ANTI-VACUITY ARM for the disclosure. A tree well inside the
// file cap must NOT claim truncation. Without this, a hook that always prints
// "TRUNCATED" passes 27a and tells the operator nothing.
withLogs({ "a.log": "ERROR one", "b.log": "ERROR two" }, {}, (dir) => {
  const r = runHook(dir);
  check(
    "fixture-27b-a-complete-scan-does-NOT-claim-truncation",
    !r.msg.includes("FLOOR") && !r.msg.includes("NOT scanned"),
    `a fully-scanned 2-file tree reported truncation: ${JSON.stringify(r.msg).slice(0, 300)}`,
  );
});

// fixture-28: the PER-FILE line cap discloses too. One file with 250 distinct
// findings yields 200 and says the file was capped. Catches the same class as
// 27 on the other axis — a floor presented as a total.
{
  const lines = Array.from({ length: 250 }, (_, i) => `ERROR distinct failure kind ${i}`);
  withLogs({ "big.log": lines.join("\n") }, {}, (dir) => {
    const r = runHook(dir);
    check(
      "fixture-28a-per-file-cap-shortfall-is-disclosed",
      reportedCount(r.msg) === 200 && r.msg.includes("1 file(s) hit the 200-line per-file read cap"),
      `count=${reportedCount(r.msg)} disclosure=${JSON.stringify(r.msg.split("\n")[1] || "").slice(0, 200)}`,
    );
  });
}
// fixture-28b: the negative arm — a file comfortably under the per-file cap
// must not be reported as capped.
withLogs({ "small.log": ["ERROR alpha", "ERROR beta"].join("\n") }, {}, (dir) => {
  const r = runHook(dir);
  check(
    "fixture-28b-an-uncapped-file-is-NOT-reported-as-capped",
    !r.msg.includes("per-file read cap"),
    `a 2-finding file was reported as hitting the cap: ${JSON.stringify(r.msg).slice(0, 300)}`,
  );
});

// fixture-29: an INCOMPLETE scan that found nothing must still speak. This is
// the silence-reads-as-clean case: >20 recent logs, all clean in the 20 that
// were opened, five never looked at. Emitting nothing here is the one outcome
// that actively misleads.
{
  const f = {};
  for (let i = 0; i < 25; i++) f[`c${String(i).padStart(2, "0")}.log`] = `INFO everything is fine ${i}`;
  withLogs(f, {}, (dir) => {
    const r = runHook(dir);
    check(
      "fixture-29a-incomplete-scan-with-zero-findings-still-warns",
      r.msg.includes("INCOMPLETE") && r.msg.includes("NOT evidence the tree is clean"),
      `25 clean logs with 5 never opened produced silence: ${JSON.stringify(r.msg).slice(0, 300)}`,
    );
  });
}
// fixture-29b: THE ANTI-NAG ARM. A clean tree that was scanned COMPLETELY must
// stay silent. Catches the over-correction — a hook that comments on every
// clean session end trains operators to ignore the channel, which is the
// silent-breakage class this hook exists to prevent.
withLogs({ "a.log": "INFO fine", "b.log": "DEBUG fine" }, {}, (dir) => {
  const r = runHook(dir);
  check(
    "fixture-29b-a-complete-clean-scan-stays-silent",
    r.json && r.json.systemMessage === undefined,
    `a fully-scanned clean tree emitted a message: ${JSON.stringify(r.msg).slice(0, 300)}`,
  );
});

// ===========================================================================
// THE MATCH SET REACHES REAL LOG FORMATS (loom#1663)
// ===========================================================================
// The matcher was a case-SENSITIVE substring scan, and 8 of these 12 formats
// were entirely invisible to it — including `npm ERR!` and `cargo error[E0308]`,
// this repo's own toolchain. For a Node/Rust/Go/Ruby project the gate was close
// to inert, and inert silently.
//
// One tree per format, deliberately: with all twelve in one tree the 10-entry
// display cap would hide two of them and a genuine blind spot would read as a
// display artifact.
{
  const FORMATS = {
    "python-logging.log": "2026-08-12 10:00:00,123 ERROR root: db connection failed",
    "python-warning.log": "2026-08-12 10:00:00,123 WARNING root: retry budget low",
    "go-slog.log": 'time=2026-08-12T10:00:00Z level=error msg="db connection failed"',
    "pino-json.log": '{"level":"error","time":1754990400000,"msg":"db connection failed"}',
    "bunyan-lower.log": '{"level":"warn","msg":"retry budget low"}',
    "rails.log": "[2026-08-12 10:00:00] error -- : db connection failed",
    "docker-compose.log": "web_1  | error: connection refused",
    "npm.log": "npm ERR! code ELIFECYCLE",
    "cargo.log": "error[E0308]: mismatched types",
    "pytest.log": "FAILED tests/test_db.py::test_connect - AssertionError",
    "systemd.log": "Aug 12 10:00:00 host svc[123]: Failed to start service",
    "uppercase-fail.log": "FAILURE: migration step 3 did not complete",
  };
  for (const [name, line] of Object.entries(FORMATS)) {
    withLogs({ [name]: line }, {}, (dir) => {
      const r = runHook(dir);
      check(
        `fixture-30-format-reaches-the-gate-${name.replace(/\.log$/, "")}`,
        r.msg.includes(name),
        `this log format is invisible to the matcher: ${line}`,
      );
    });
  }
}

// fixture-31: THE ANTI-FLOOD ARM, and the reason a bare `-i` was rejected.
// Every line here contains a severity WORD in ordinary prose. None sits in a
// log-structural position, so none may match. Catches exactly the "helpful"
// widening — adding -i, or dropping the delimiter anchor from the lowercase
// arms — that would flood the channel until operators mute it. fixture-04
// pins the same property on the three bare tokens; this one pins the harder
// cases, where the severity word is a substring or a sentence subject.
withLogs(
  {
    "p1.log": "the failover completed cleanly",
    "p2.log": "improved error handling in the parser",
    "p3.log": "no errors were reported by the linter",
    "p4.log": "compiled 3 modules with no errors",
    "p5.log": "downloading package error-stack v0.4.1",
    "p6.log": "terminating cleanly, warnings suppressed",
  },
  {},
  (dir) => {
    const r = runHook(dir);
    check(
      "fixture-31-severity-words-in-prose-do-not-match",
      r.json && r.json.systemMessage === undefined,
      `prose matched — the lowercase arms lost their log-structural anchor: ${JSON.stringify(r.msg).slice(0, 400)}`,
    );
  },
);

// ===========================================================================
// A FAILED SCAN IS NOT A CLEAN SCAN
// ===========================================================================
// The same silence-reads-as-clean class as #1662, on the error paths rather
// than the budget path. Each of these used to produce an empty result
// indistinguishable from "your logs are clean".

// Drive the hook with a doctored PATH. node is invoked by ABSOLUTE path
// (`process.execPath`) so that stripping PATH disables the tools the hook
// shells out to WITHOUT also disabling the runtime — an earlier revision of
// fixture-32 emptied PATH outright, and the resulting `status=null, stdout=""`
// looked exactly like the defect it was meant to catch. Distinguishing "the
// hook reported clean" from "the hook never ran" is the whole point.
function runHookWithPath(cwd, pathValue, extraEnv = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: "Stop", cwd }),
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, PATH: pathValue, ...extraEnv },
  });
  let parsed = null;
  try {
    parsed = JSON.parse((r.stdout || "").trim());
  } catch {
    /* left null — the assertion reports it */
  }
  return { status: r.status, json: parsed, msg: (parsed && parsed.systemMessage) || "" };
}

// ---------------------------------------------------------------------------
// PRELOADS — deterministic control of the filesystem the hook SEES.
// ---------------------------------------------------------------------------
// Some properties are about ORDER or TIMING the host decides (readdir order, a
// path swapped between two syscalls, a slow directory). Real trees cannot pin
// those, so a preload (`node -r <file>`) wraps the exact fs calls the hook
// makes. The hook itself is unmodified; each preload appends to a MARK file
// whenever it acts, and every case using one asserts that mark — a preload that
// stopped reaching the code it wraps reds the case instead of greening it.

// Hand `locked` to the reader before every sibling (fixture-34c).
const ORDER_LOCKED_FIRST = `
const fs = require("fs");
const read = fs.Dir.prototype.readSync;
const queued = new WeakMap();
fs.Dir.prototype.readSync = function () {
  if (!queued.has(this)) {
    const all = [];
    let e;
    while ((e = read.call(this)) !== null) all.push(e);
    all.sort((a, b) => (b.name === "locked") - (a.name === "locked"));
    if (all.length > 1 && all[0].name === "locked") fs.appendFileSync(process.env.LOGTRIAGE_FX_MARK, "reordered\\n");
    queued.set(this, all);
  }
  const q = queued.get(this);
  return q.length > 0 ? q.shift() : null;
};
`;

// Swap <tree>/logs for a symlink to LOGTRIAGE_FX_OUTSIDE at the instant the
// hook opens it — after any lstat that classified it as a directory (fixture-40).
const SWAP_LOGS_ON_OPEN = `
const fs = require("fs");
const path = require("path");
const open = fs.opendirSync;
let swapped = false;
fs.opendirSync = function (p, ...rest) {
  if (!swapped && typeof p === "string" && path.basename(p) === "logs" &&
      fs.realpathSync(path.dirname(p)) === process.env.LOGTRIAGE_FX_TREE) {
    swapped = true;
    fs.renameSync(p, p + ".real");
    fs.symlinkSync(process.env.LOGTRIAGE_FX_OUTSIDE, p);
    fs.appendFileSync(process.env.LOGTRIAGE_FX_MARK, "swapped\\n");
  }
  return open.call(this, p, ...rest);
};
`;

// Every directory entry costs 100 ms (fixture-43b).
const SLOW_DIR_READS = `
const fs = require("fs");
const read = fs.Dir.prototype.readSync;
const cell = new Int32Array(new SharedArrayBuffer(4));
let marked = false;
fs.Dir.prototype.readSync = function () {
  Atomics.wait(cell, 0, 0, 100);
  if (!marked) { marked = true; fs.appendFileSync(process.env.LOGTRIAGE_FX_MARK, "slowed\\n"); }
  return read.call(this);
};
`;

/** Write a preload + mark file into a private mktemp dir. */
function preloadKit(source) {
  const kit = fs.mkdtempSync(path.join(os.tmpdir(), "logtriage-preload-"));
  const file = path.join(kit, "preload.cjs");
  const mark = path.join(kit, "mark");
  fs.writeFileSync(file, source);
  fs.writeFileSync(mark, "");
  return {
    file,
    mark,
    marks: () => fs.readFileSync(mark, "utf8"),
    cleanup: () => fs.rmSync(kit, { recursive: true, force: true }),
  };
}

function runHookWithPreload(cwd, source, extraEnv = {}, opts = {}) {
  const kit = preloadKit(source);
  try {
    const r = spawnSync(process.execPath, ["-r", kit.file, HOOK], {
      input: JSON.stringify({ hook_event_name: "Stop", cwd }),
      encoding: "utf8",
      timeout: opts.timeoutMs ?? 30000,
      killSignal: "SIGKILL",
      env: { ...process.env, LOGTRIAGE_FX_MARK: kit.mark, ...extraEnv },
    });
    let parsed = null;
    try {
      parsed = JSON.parse((r.stdout || "").trim());
    } catch {
      /* left null — the assertion reports it */
    }
    return {
      status: r.status,
      json: parsed,
      msg: (parsed && parsed.systemMessage) || "",
      err: r.stderr || "",
      marks: kit.marks(),
    };
  } finally {
    kit.cleanup();
  }
}

// fixture-32: every per-file `grep` FAILS (exit 2), which is not the same thing
// as "matched nothing" (exit 1). A hook that conflates them reports a clean
// session on every machine where the scan is broken — silently, forever. A
// shim grep that exits 2 isolates exactly that branch, leaving find/head intact.
{
  const shim = fs.mkdtempSync(path.join(os.tmpdir(), "logtriage-shim-"));
  try {
    fs.writeFileSync(path.join(shim, "grep"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
    withLogs({ "app.log": "ERROR database connection failed" }, {}, (dir) => {
      const r = runHookWithPath(dir, `${shim}:${process.env.PATH}`);
      check(
        "fixture-32-a-failing-grep-is-reported-not-treated-as-clean",
        r.json !== null && r.json.continue === true && r.msg.includes("could not be read"),
        `a scan whose greps all errored reported clean: status=${r.status} msg=${JSON.stringify(r.msg).slice(0, 300)}`,
      );
    });
  } finally {
    fs.rmSync(shim, { recursive: true, force: true });
  }
}

// fixture-33: THE NEGATIVE ARM for 32 — with a working PATH, no file is
// reported unreadable. Catches a hook that cries "could not be read" on every
// healthy scan, which would satisfy 32 while meaning nothing.
withLogs({ "app.log": "ERROR database connection failed" }, {}, (dir) => {
  const r = runHook(dir);
  check(
    "fixture-33-a-healthy-scan-reports-nothing-unreadable",
    !r.msg.includes("could not be read"),
    `a healthy scan claimed files were unreadable: ${JSON.stringify(r.msg).slice(0, 300)}`,
  );
});

// fixture-34: the ENUMERATION stage itself fails — here by running out of its
// budget. The enumeration is an in-process walk now, so stripping PATH no
// longer breaks it (fixture-38 pins exactly that); the deterministic way to
// make it fail on every host is a zero budget. Reporting that as "no logs
// found" is the same defect one stage earlier.
withLogs({ "app.log": "ERROR database connection failed" }, {}, (dir) => {
  const r = runHookWithPath(dir, process.env.PATH, { COC_LOG_TRIAGE_ENUM_BUDGET_MS: "0" });
  check(
    "fixture-34-a-failed-enumeration-is-reported-not-treated-as-clean",
    r.json !== null && r.json.continue === true && r.msg.includes("enumeration failed or timed out for declared root(s) (.)"),
    `a scan whose enumeration ran out of budget reported clean: status=${r.status} msg=${JSON.stringify(r.msg).slice(0, 300)}`,
  );
});

// fixture-34b: an UNREADABLE declared root is a failed enumeration, not an
// empty one. Needs a host where mode 000 actually denies the reader — root
// reads straight through it, so there the arm says NOT RUN and emits no row.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logtriage-fx-"));
  const logs = path.join(dir, "logs");
  try {
    fs.mkdirSync(logs);
    fs.writeFileSync(path.join(logs, "app.log"), "ERROR database connection failed\n");
    fs.chmodSync(logs, 0o000);
    let denied = false;
    try {
      fs.readdirSync(logs);
    } catch {
      denied = true;
    }
    if (!denied) {
      process.stdout.write("  NOT RUN  fixture-34b (mode 000 does not deny this reader; uid 0?)\n");
    } else {
      const r = runHook(dir);
      check(
        "fixture-34b-an-unreadable-declared-root-is-named-as-failed",
        r.json !== null && r.json.continue === true && r.msg.includes("declared root(s) (logs)"),
        `an unreadable declared root reported clean: status=${r.status} msg=${JSON.stringify(r.msg).slice(0, 300)}`,
      );
    }
  } finally {
    try {
      fs.chmodSync(logs, 0o755);
    } catch {
      // never created; rmSync below has nothing to restore
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// fixture-34c: an unreadable SUBdirectory is skipped, not fatal. The root is
// still named as failed, AND every readable sibling is still walked — find
// walked past it too.
//
// DETERMINISTIC BY CONSTRUCTION. Directory-read order is filesystem-defined, so
// a walk that STOPS at the unreadable directory used to miss only whatever it
// had not yet reached — all fifteen siblings only if `locked` happened to be
// read first, so the stop mutation redded ~15 runs in 16, not 16 in 16. A
// preload (ORDER_LOCKED_FIRST) now hands the hook's directory reader `locked`
// BEFORE every sibling, so a stop-on-unreadable walk reaches none of the
// fifteen on every host. The preload records that it reordered, and the case
// requires that record — a preload that silently stopped reaching the reader
// would red here instead of reverting to a probabilistic green.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logtriage-fx-"));
  const locked = path.join(dir, "logs", "locked");
  try {
    for (let i = 0; i < 15; i++) {
      const sub = path.join(dir, "logs", `ok${i}`);
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, "app.log"), `ERROR sibling ${String.fromCharCode(97 + i)} failed\n`);
    }
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    let denied = false;
    try {
      fs.readdirSync(locked);
    } catch {
      denied = true;
    }
    if (!denied) {
      process.stdout.write("  NOT RUN  fixture-34c (mode 000 does not deny this reader; uid 0?)\n");
    } else {
      const r = runHookWithPreload(dir, ORDER_LOCKED_FIRST);
      check(
        "fixture-34c-an-unreadable-subdirectory-is-named-and-its-siblings-still-walked",
        r.marks.includes("reordered") && reportedCount(r.msg) === 15 && r.msg.includes("declared root(s) (logs)"),
        `expected the preload to put locked first (marks=${JSON.stringify(r.marks)}), all 15 sibling findings AND the root named as failed, got ${reportedCount(r.msg)}: ${JSON.stringify(r.msg).slice(0, 400)}`,
      );
    }
  } finally {
    try {
      fs.chmodSync(locked, 0o755);
    } catch {
      // never created; rmSync below has nothing to restore
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// fixture-35: THE NEGATIVE ARM for 34 — a healthy scan never claims the
// enumeration failed. Pairs with 34 the way 33 pairs with 32.
withLogs({ "app.log": "ERROR database connection failed" }, {}, (dir) => {
  const r = runHook(dir);
  check(
    "fixture-35-a-healthy-scan-does-not-claim-enumeration-failure",
    !r.msg.includes("enumeration failed"),
    `a healthy scan claimed its enumeration failed: ${JSON.stringify(r.msg).slice(0, 300)}`,
  );
});

// fixture-36: NO-FALSE-POSITIVE AT REALISTIC SCALE. Twenty-eight lines of
// ordinary, healthy build output — npm install, cargo build, a passing pytest
// run, structured INFO/DEBUG server logs, docker build steps — carrying exactly
// ONE genuine severity line (`npm WARN deprecated`). The fixtures above check
// the widened matcher one crafted line at a time; this checks it against the
// shape of a real log file, where an over-broad arm shows up as a dozen matches
// on "Compiling", "found 0 vulnerabilities", "0 failed" and "Removing".
//
// Measured: the new matcher returns exactly the same single line the ORIGINAL
// case-sensitive matcher did on this corpus. The #1663 widening buys twelve
// formats and costs nothing here.
withLogs(
  {
    "build.log": [
      "npm WARN deprecated core-js@2.6.12: core-js@<3.4 is no longer maintained",
      "npm notice created a lockfile as package-lock.json",
      "added 1201 packages from 620 contributors in 24.573s",
      "found 0 vulnerabilities",
      "Compiled successfully.",
      "   Compiling serde v1.0.196",
      "    Finished dev [unoptimized + debuginfo] target(s) in 12.34s",
      "running 42 tests",
      "test result: ok. 42 passed; 0 failed; 0 ignored; 0 measured",
      "platform linux -- Python 3.11.4, pytest-7.4.0, pluggy-1.2.0",
      "tests/test_auth.py ........................                             [ 18%]",
      "============================== 128 passed in 4.21s ===========================",
      "2026-08-12T10:00:00Z INFO  server listening on :8080",
      "2026-08-12T10:00:01Z DEBUG cache warmed, 512 entries",
      "2026-08-12T10:00:02Z INFO  request completed status=200 duration=12ms",
      "INFO: Build completed successfully, 1 total action",
      "Successfully tagged myapp:latest",
      "Removing intermediate container 1a2b3c4d",
      "Step 7/12 : RUN npm ci --production",
    ].join("\n"),
  },
  {},
  (dir) => {
    const r = runHook(dir);
    check(
      "fixture-36-healthy-build-output-yields-only-its-one-real-warning",
      reportedCount(r.msg) === 1 && r.msg.includes("npm WARN deprecated"),
      `expected exactly the one genuine WARN line, got ${reportedCount(r.msg)}: ${JSON.stringify(r.msg).slice(0, 500)}`,
    );
  },
);

// ===========================================================================
// NOTHING THE HOOK STARTS OUTLIVES IT
// ===========================================================================
// The enumeration used to be `find … | head` under execSync's timeout. On
// expiry Node killed only `sh`; `find` and `head` were re-parented to init and
// kept walking — 5-12 orphans at a time on the host, each walking a 2.37M-file
// tree for ~100 s. A slow REAL tree is host-speed-dependent and costs the host
// exactly the load this case exists to prevent, so the slowness is supplied
// deterministically instead: a `find` shim on PATH that records each call and
// then sleeps far past the hook's enumeration budget.
//
// Descendants are identified by PROCESS GROUP, which survives re-parenting:
// the hook is spawned detached (its own group, pgid = its pid) and every child
// it starts inherits that group. A pid cannot be reused while a group still
// carries it as its id, so after the hook exits ANY process in that group is
// something the hook left behind. Each is matched by pid + start time + command
// before it is signalled, and only this fixture's group is ever signalled.

/** pid, pgid, start time and command of every process, from one `ps` read. */
function processTable() {
  const r = spawnSync("ps", ["-A", "-ww", "-o", "pid=,pgid=,lstart=,command="], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return null;
  const rows = [];
  for (const line of r.stdout.split("\n")) {
    // lstart is five fields on both procps and BSD ps ("Sun Oct 11 20:05:34 2026").
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/);
    if (m) rows.push({ pid: Number(m[1]), pgid: Number(m[2]), start: m[3], command: m[4] });
  }
  return rows;
}

function runHookDetached(cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      detached: true,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.resume();
    const killer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // group already gone
      }
    }, 30000);
    child.on("close", (status) => {
      clearTimeout(killer);
      resolve({ pid: child.pid, status, stdout });
    });
    child.stdin.end(JSON.stringify({ hook_event_name: "Stop", cwd }));
  });
}

/** Signal ONLY processes still matching the exact identity recorded for them. */
function reapExact(survivors) {
  for (const s of survivors) {
    const now = (processTable() || []).find((p) => p.pid === s.pid);
    if (now && now.pgid === s.pgid && now.start === s.start && now.command === s.command) {
      try {
        process.kill(s.pid, "SIGKILL");
      } catch {
        // exited between the read and the signal
      }
    }
  }
}

// fixture-37: a hook run whose enumeration is slow leaves NO process behind.
{
  const shim = fs.mkdtempSync(path.join(os.tmpdir(), "logtriage-orphan-"));
  const calls = path.join(shim, "calls");
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "logtriage-fx-"));
  let survivors = [];
  try {
    fs.writeFileSync(
      path.join(shim, "find"),
      `#!/bin/sh\necho "$$" >> '${calls}'\nexec sleep 20\n`,
      { mode: 0o755 },
    );
    fs.mkdirSync(path.join(tree, "logs", "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(tree, "app.log"), "ERROR database connection failed\n");
    fs.writeFileSync(path.join(tree, "logs", "a", "b", "deep.log"), "ERROR deep failure\n");
    if (processTable() === null) {
      check("fixture-37-no-process-outlives-the-hook", false, "`ps -A -ww -o pid=,pgid=,lstart=,command=` could not be read — the case cannot see survivors, so it does not pass");
    } else {
      const r = await runHookDetached(tree, { ...process.env, PATH: `${shim}:${process.env.PATH}` });
      survivors = (processTable() || []).filter((p) => p.pgid === r.pid);
      const shimCalls = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0;
      process.stdout.write(`  NOTE  fixture-37: hook pid=${r.pid} exit=${r.status}; find shim invoked ${shimCalls} time(s)\n`);
      check(
        "fixture-37-no-process-outlives-the-hook",
        r.status !== null && survivors.length === 0,
        `the hook exited (status=${r.status}) leaving ${survivors.length} process(es) in its group: ${JSON.stringify(survivors).slice(0, 600)}`,
      );
    }
  } finally {
    reapExact(survivors);
    fs.rmSync(shim, { recursive: true, force: true });
    fs.rmSync(tree, { recursive: true, force: true });
  }
}

// fixture-38: the enumeration does not depend on PATH. With every external
// tool unreachable the walk still FINDS the log (so nothing is reported as an
// enumeration failure) and the per-file grep is what is reported as unable to
// run. Against a shell enumeration this arm reds: no `find` ⇒ enumeration
// failed. It is the PATH-stripped arm fixture-34 used to be, now pinning the
// opposite pole.
withLogs({ "app.log": "ERROR database connection failed" }, {}, (dir) => {
  const r = runHookWithPath(dir, "/nonexistent-bin-dir-for-fixture-38");
  check(
    "fixture-38-enumeration-runs-without-any-external-tool",
    r.json !== null && r.json.continue === true && !r.msg.includes("enumeration failed") && r.msg.includes("1 file(s) could not be read"),
    `with PATH stripped the enumeration should still find app.log and only the grep should fail: status=${r.status} msg=${JSON.stringify(r.msg).slice(0, 300)}`,
  );
});

// ===========================================================================
// A DECLARED ROOT IS A DIRECTORY, AND STAYS THE ONE THAT WAS CHECKED
// ===========================================================================

/** A tree plus a separate OUTSIDE dir holding a recent ERROR log. */
function withOutside(fn) {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "logtriage-fx-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "logtriage-outside-"));
  try {
    fs.writeFileSync(path.join(outside, "evil.log"), "ERROR outside the declared surface\n");
    return fn(tree, outside);
  } finally {
    // rmSync does not follow a symlink, so the link in `tree` never reaches `outside`.
    fs.rmSync(tree, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

// fixture-39a (M1): a declared root that is a SYMLINK is a FAILED root, named,
// and is not followed. Before: find's -P semantics carried over — the symlink
// root was "neither a directory nor a file", so it enumerated as EMPTY and the
// hook reported the root clean. A declared log dir replaced by a link reads
// exactly like "no logs there". The top-level log is the other pole: the scan
// is not muted by the failed root.
withOutside((tree, outside) => {
  fs.writeFileSync(path.join(tree, "top.log"), "ERROR at the top level\n");
  fs.symlinkSync(outside, path.join(tree, "logs"));
  const r = runHook(tree);
  check(
    "fixture-39a-a-symlinked-declared-root-is-named-as-failed-and-not-followed",
    r.json !== null && r.msg.includes("declared root(s) (logs)") && !r.msg.includes("evil.log") && r.msg.includes("top.log"),
    `a symlinked declared root was read as clean (or followed): ${JSON.stringify(r.msg).slice(0, 400)}`,
  );
});

// fixture-39b (M1): a DANGLING symlink as a declared root. It exists (lstat
// succeeds), so it is not "declared-missing" — it is a root that cannot be
// enumerated. Before: `fs.existsSync` FOLLOWED the link, saw nothing, and the
// root was skipped as a true zero. Silence again.
withOutside((tree) => {
  fs.symlinkSync(path.join(tree, "no-such-target"), path.join(tree, "logs"));
  const r = runHook(tree);
  check(
    "fixture-39b-a-dangling-symlink-declared-root-is-named-as-failed",
    r.json !== null && r.json.continue === true && r.msg.includes("declared root(s) (logs)"),
    `a dangling-symlink declared root was skipped as missing: ${JSON.stringify(r.msg).slice(0, 400)}`,
  );
});

// fixture-39c: the OTHER pole of 39a — the session's OWN directory reached
// through a symlink is the subject, not a declared root, so it must NOT be
// refused. The hook resolves cwd once (realpath) and judges declared roots
// under the real directory. Without that, 39a's rule would name `.` as failed
// on every session started through a symlinked path — and on the pre-fix
// bytes the `.` root was silently enumerated as empty instead, so the
// top-level log here never surfaced at all.
withOutside((tree) => {
  fs.writeFileSync(path.join(tree, "top.log"), "ERROR at the top level\n");
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "logtriage-cwdlink-"));
  try {
    const link = path.join(linkDir, "session");
    fs.symlinkSync(tree, link);
    const r = runHook(link);
    check(
      "fixture-39c-a-session-cwd-reached-through-a-symlink-is-walked-not-refused",
      r.msg.includes("top.log") && !r.msg.includes("enumeration failed"),
      `a symlinked session cwd was refused or enumerated as empty: ${JSON.stringify(r.msg).slice(0, 400)}`,
    );
  } finally {
    fs.rmSync(linkDir, { recursive: true, force: true });
  }
});

// fixture-40 (L1): the dir→symlink SWAP RACE. A preload swaps <tree>/logs for a
// symlink to OUTSIDE at the instant the hook opens it — after the lstat that
// classified it as a directory. opendir follows links, so the old walk
// enumerated OUTSIDE and reported its log as this session's finding, with the
// root never named. The walk now re-checks the opened path's dev+ino against
// the classifying lstat; a mismatch closes the handle unread and fails the root.
withOutside((tree, outside) => {
  fs.mkdirSync(path.join(tree, "logs"));
  fs.writeFileSync(path.join(tree, "logs", "inside.log"), "INFO nothing wrong\n");
  const r = runHookWithPreload(tree, SWAP_LOGS_ON_OPEN, {
    LOGTRIAGE_FX_TREE: fs.realpathSync(tree),
    LOGTRIAGE_FX_OUTSIDE: outside,
  });
  check(
    "fixture-40-a-root-swapped-for-a-symlink-mid-walk-is-failed-not-followed",
    r.marks.includes("swapped") && r.msg.includes("declared root(s) (logs)") && !r.msg.includes("evil.log"),
    `marks=${JSON.stringify(r.marks)} — the swapped root was followed or reported clean: ${JSON.stringify(r.msg).slice(0, 400)}`,
  );
});

// ===========================================================================
// THE FILENAME IS THE ONE THE HOOK OPENED, AND NOTHING REACHES THE TERMINAL RAW
// ===========================================================================

/** Rendered per-entry lines (two-space indented, not the "… and" tail). */
function renderedLines(msg) {
  return msg.split("\n").filter((l) => /^ {2}\S/.test(l) && !l.includes("… and"));
}

// fixture-41a (L2): a log whose NAME contains `:<n>:`. The old `grep -H` output
// was re-parsed as `<file>:<n>:<text>`, so this file was attributed to a file
// called `decoy`, and its content was reported as `forged.log:1:ERROR …`. The
// match must be attributed to the file the hook actually opened.
withLogs({ "decoy:1:forged.log": "ERROR genuine failure" }, {}, (dir) => {
  const r = runHook(dir);
  const rows = renderedLines(r.msg);
  check(
    "fixture-41a-a-colon-bearing-filename-is-attributed-to-the-file-opened",
    rows.length === 1 && rows[0].endsWith("/decoy:1:forged.log: ERROR genuine failure"),
    `rows=${JSON.stringify(rows).slice(0, 400)}`,
  );
});

// fixture-41b (L2 + L4): a log whose NAME contains a newline. Under `grep -H`
// the name split into two output lines: one entry attributed to a file named
// `ERROR forged-entry.log` that does not exist, and one `unknown`. Exactly ONE
// finding exists, and it must render as ONE line naming the real file, with
// the newline made visible — and, since LOW-3, the name QUOTED: a control byte
// takes a path off the bare form, so the attribution ends at the closing quote
// rather than at the first `": "`.
withLogs({ "split\nERROR forged-entry.log": "ERROR genuine failure" }, {}, (dir) => {
  const r = runHook(dir);
  const rows = renderedLines(r.msg);
  check(
    "fixture-41b-a-newline-bearing-filename-forges-no-second-entry",
    reportedCount(r.msg) === 1 && rows.length === 1 && rows[0].startsWith('  "') &&
      rows[0].endsWith('/split\\x0aERROR forged-entry.log": ERROR genuine failure'),
    `count=${reportedCount(r.msg)} rows=${JSON.stringify(rows).slice(0, 400)}`,
  );
});

// fixture-42 (L4): terminal control bytes in BOTH the filename and the matched
// content — an OSC title write, a CSI screen clear, SGR colour, DEL, and the
// 8-bit C1 CSI (U+009B). JSON escapes C0 on the wire, but the host decodes it
// before display, so the old hook delivered every one of these RAW to the
// operator's terminal. No control byte other than TAB and the line separators
// may survive, and each must still be VISIBLE (escaped), not silently dropped.
withLogs(
  { "esc\u001b[2J.log": "ERROR \u001b]0;pwned\u0007 then \u001b[31mred\u001b[0m del\u007f c1\u009b2J end" },
  {},
  (dir) => {
    const r = runHook(dir);
    const raw = r.msg.match(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g) || [];
    check(
      "fixture-42-terminal-control-bytes-are-neutralised-in-filenames-and-content",
      r.msg !== "" && raw.length === 0 && r.msg.includes("esc\\x1b[2J.log") && r.msg.includes("\\x1b]0;pwned\\x07") && r.msg.includes("del\\x7f c1\\x9b2J"),
      `raw control chars surviving=${JSON.stringify(raw)} msg=${JSON.stringify(r.msg).slice(0, 400)}`,
    );
  },
);

// ===========================================================================
// THE HOOK FINISHES INSIDE THE DISPATCHER'S TIMEOUT — PROVABLY (L3)
// ===========================================================================

// fixture-43a: a SOURCE-TEXT PIN, not a behavioural witness. It re-derives the
// arithmetic from the two sources that must agree — the dispatcher's timeout for
// this row from dispatch-registry.json AND hook-registry.json, the budgets from
// the hook's own constants — and it pins the TEXT of the two deadline clamps. That
// last part is lexical: an edit that keeps the clamp text but stops using it (e.g.
// `triageLogs(cwd, Infinity)`) passes here. The behavioural witness of the clamp
// is fixture-43b, which measures the hook's wall time on the worst shape. Before:
// the enumeration budget was armed PER ROOT (4 x 1500 ms) on top of a 2500 ms
// scan and a 5000 ms stdin wait, with no constant tying any of it to the 7 s
// timeout.
{
  const REG = path.join(HERE, "..", "..", "hooks", "dispatch-registry.json");
  const HREG = path.join(HERE, "..", "..", "hook-registry.json");
  const src = fs.readFileSync(HOOK, "utf8");
  const num = (name) => {
    const m = src.match(new RegExp(`^const ${name} = (\\d+);$`, "m"));
    return m ? Number(m[1]) : null;
  };
  const rows = [];
  (function walk(v) {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      if (typeof v.command === "string" && v.command.includes("log-triage-gate.js")) rows.push(v.timeout);
      Object.values(v).forEach(walk);
    }
  })(JSON.parse(fs.readFileSync(REG, "utf8")));
  const hrows = (JSON.parse(fs.readFileSync(HREG, "utf8")).hooks || [])
    .filter((h) => h && h.file === ".claude/hooks/log-triage-gate.js")
    .map((h) => h.timeout);
  const c = {
    dispatch: num("DISPATCH_TIMEOUT_MS"),
    hook: num("HOOK_BUDGET_MS"),
    enumB: num("ENUM_BUDGET_MS"),
    scan: num("SCAN_BUDGET_MS"),
  };
  check(
    "fixture-43a-source-pin-budget-constants-and-clamp-text-fit-the-registered-dispatcher-timeout",
    rows.length === 1 && hrows.length === 1 && rows[0] === hrows[0] &&
      c.dispatch === rows[0] * 1000 && c.hook !== null && c.enumB !== null && c.scan !== null &&
      c.enumB + c.scan <= c.hook && c.dispatch - c.hook >= 1000 &&
      /Math\.min\(Date\.now\(\) \+ enumBudgetMs\(\), hookDeadline\)/.test(src) &&
      /Math\.min\(Date\.now\(\) \+ SCAN_BUDGET_MS, hookDeadline\)/.test(src),
    `registry=${JSON.stringify(rows)} hook-registry=${JSON.stringify(hrows)} constants=${JSON.stringify(c)} — the budgets no longer provably fit the dispatcher timeout`,
  );
}

// fixture-43b: the bound, MEASURED on the worst shape the hook can meet — stdin
// arriving 4.5 s late, every directory entry costing 100 ms (preload), all four
// declared roots populated past their budget, and a grep that never returns
// (shim). The whole hook must still exit inside the 7 s dispatcher timeout, and
// report `continue: true`. Before: stdin + 4 roots x 1.5 s + 2.5 s scan — killed
// by the dispatcher, output lost. WHY 4.5 s: it is the stdin delay at which the
// ONE hook deadline is what bounds the run. With it the hook ends near 5.5 s (the
// enumeration and scan get only what the 5500 ms hook deadline leaves); a hook
// that dropped the hook-deadline clamp but kept the per-phase budgets ends near
// 4.5 + 1.5 + 2.5 = 8.5 s. At the old 3 s delay that same mutant landed at
// ~7.02 s — a 19 ms red, too thin to be a witness.
{
  const kit = preloadKit(SLOW_DIR_READS);
  const shim = fs.mkdtempSync(path.join(os.tmpdir(), "logtriage-shim-"));
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "logtriage-fx-"));
  try {
    fs.writeFileSync(path.join(shim, "grep"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
    fs.writeFileSync(path.join(tree, "top.log"), "ERROR at the top level\n");
    for (const root of [".claude/logs", "logs", "workspaces"]) {
      for (let i = 0; i < 30; i++) fs.mkdirSync(path.join(tree, root, `d${i}`), { recursive: true });
    }
    const t0 = Date.now();
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["-r", kit.file, HOOK], {
        env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, LOGTRIAGE_FX_MARK: kit.mark },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.resume();
      const killer = setTimeout(() => child.kill("SIGKILL"), 30000);
      const feeder = setTimeout(() => child.stdin.end(JSON.stringify({ hook_event_name: "Stop", cwd: tree })), 4500);
      child.on("close", (status) => {
        clearTimeout(killer);
        clearTimeout(feeder);
        resolve({ status, stdout });
      });
    });
    const wall = Date.now() - t0;
    let parsed = null;
    try {
      parsed = JSON.parse(r.stdout.trim());
    } catch {
      /* left null — the assertion reports it */
    }
    process.stdout.write(`  NOTE  fixture-43b: wall=${wall}ms exit=${r.status}\n`);
    check(
      "fixture-43b-the-worst-case-run-exits-inside-the-dispatcher-timeout",
      kit.marks().includes("slowed") && wall < 7000 && parsed !== null && parsed.continue === true,
      `wall=${wall}ms (limit 7000) marks=${JSON.stringify(kit.marks())} stdout=${r.stdout.slice(0, 300)}`,
    );
  } finally {
    kit.cleanup();
    fs.rmSync(shim, { recursive: true, force: true });
    fs.rmSync(tree, { recursive: true, force: true });
  }
}

// ===========================================================================
// THE BYTES GREP READS ARE THE FILE THE WALK CLASSIFIED (MED-1)
// ===========================================================================
// The walk lstat'd each log, but the scan handed grep the PATH, and grep opens
// a path the ordinary way: it follows a symlink, and it resolves every ancestor
// directory afresh. Anything able to rename inside a scanned directory could
// therefore swap the entry — or one of its ancestor directories — between the
// walk's classification and grep's open, and the bytes of a file OUTSIDE the
// declared surface reached the systemMessage as this session's finding. A
// security review EXECUTED that with a racing swap loop (9 leaks in 40 runs).
//
// These cases make the race deterministic: a preload performs the swap at the
// exact boundary — the first moment the hook either opens `victim.log` or
// spawns a grep naming it, whichever comes first — so the same preload drives
// the old path-to-grep bytes and the fd-bound bytes alike. Each requires the
// preload's own record that it swapped, so a preload that stopped reaching the
// boundary reds instead of greening. The secret is a placeholder string.
const SECRET = "PLACEHOLDER-SECRET-0f3a outside the declared surface";

// Swap <tree>/logs/victim.log at the read boundary. LOGTRIAGE_FX_SWAP picks the
// replacement: `symlink` (a link to the outside file), `hardlink` (the outside
// file's own inode under the victim's name — no symlink anywhere, so only an
// identity check can see it), or `fifo` (a named pipe: an open without
// O_NONBLOCK would block the hook forever).
const SWAP_FILE_AT_READ = `
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
let swapped = false;
const isVictim = (p) => typeof p === "string" && path.basename(p) === "victim.log" &&
  path.dirname(p) === path.join(process.env.LOGTRIAGE_FX_TREE, "logs");
function swap(p) {
  if (swapped) return;
  swapped = true;
  fs.renameSync(p, p + ".real");
  const tmp = p + ".swap";
  const kind = process.env.LOGTRIAGE_FX_SWAP;
  if (kind === "symlink") fs.symlinkSync(process.env.LOGTRIAGE_FX_SECRET_FILE, tmp);
  else if (kind === "hardlink") fs.linkSync(process.env.LOGTRIAGE_FX_SECRET_FILE, tmp);
  else if (kind === "fifo") cp.spawnSync("mkfifo", [tmp]);
  fs.renameSync(tmp, p);
  fs.appendFileSync(process.env.LOGTRIAGE_FX_MARK, "swapped:" + kind + "\\n");
}
// LOGTRIAGE_FX_SWAP_AT=grep moves the swap to the FIRST grep spawn instead —
// after the hook has already opened the victim (fixture-44e).
const atGrep = process.env.LOGTRIAGE_FX_SWAP_AT === "grep";
const open = fs.openSync;
fs.openSync = function (p, ...rest) {
  if (!atGrep && isVictim(p)) swap(p);
  return open.call(this, p, ...rest);
};
const spawn = cp.spawnSync;
cp.spawnSync = function (cmd, args, ...rest) {
  if (cmd === "grep" && atGrep) swap(path.join(process.env.LOGTRIAGE_FX_TREE, "logs", "victim.log"));
  else if (cmd === "grep" && Array.isArray(args)) for (const a of args) if (isVictim(a)) swap(a);
  return spawn.call(this, cmd, args, ...rest);
};
`;

// Swap the victim's PARENT directory for a symlink to an outside directory
// holding a same-named log, at the instant the walk lstat's the victim. The
// walk's own lstat then classifies the OUTSIDE file, so a check that only binds
// the opened fd to that lstat agrees with it: only re-verifying the ancestor
// directories the walk entered can see the swap.
const SWAP_ANCESTOR_ON_LSTAT = `
const fs = require("fs");
const path = require("path");
let swapped = false;
const lstat = fs.lstatSync;
fs.lstatSync = function (p, ...rest) {
  const sub = path.join(process.env.LOGTRIAGE_FX_TREE, "logs", "sub");
  if (!swapped && typeof p === "string" && path.basename(p) === "victim.log" && path.dirname(p) === sub) {
    swapped = true;
    fs.renameSync(sub, sub + ".real");
    fs.symlinkSync(process.env.LOGTRIAGE_FX_OUTSIDE, sub);
    fs.appendFileSync(process.env.LOGTRIAGE_FX_MARK, "swapped:ancestor\\n");
  }
  return lstat.call(this, p, ...rest);
};
`;

/** A tree with logs/victim.log (benign) + logs/other.log (a real finding), and
 *  an OUTSIDE dir holding the secret both as secret.log and as victim.log. */
function withVictim(nested, fn) {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "logtriage-fx-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "logtriage-outside-"));
  try {
    const logs = path.join(tree, "logs", ...(nested ? ["sub"] : []));
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, "victim.log"), "INFO nothing wrong here\n");
    fs.writeFileSync(path.join(tree, "logs", "other.log"), "ERROR genuine sibling failure\n");
    fs.writeFileSync(path.join(outside, "secret.log"), `ERROR ${SECRET}\n`);
    fs.writeFileSync(path.join(outside, "victim.log"), `ERROR ${SECRET}\n`);
    return fn(fs.realpathSync(tree), outside);
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

// fixture-44a (MED-1): victim.log swapped for a SYMLINK to an outside file at
// the read boundary. Before: grep received the path and followed the link —
// the secret was reported as a finding of `logs/victim.log`. After: the hook
// opens with O_NOFOLLOW and binds the descriptor to the walk's lstat; the file
// is disclosed as unreadable and the sibling's genuine finding still surfaces.
withVictim(false, (tree, outside) => {
  const r = runHookWithPreload(tree, SWAP_FILE_AT_READ, {
    LOGTRIAGE_FX_TREE: tree,
    LOGTRIAGE_FX_SWAP: "symlink",
    LOGTRIAGE_FX_SECRET_FILE: path.join(outside, "secret.log"),
  });
  check(
    "fixture-44a-a-log-swapped-for-a-symlink-at-read-time-is-never-read",
    r.marks.includes("swapped:symlink") && !r.msg.includes("PLACEHOLDER-SECRET") &&
      r.msg.includes("1 file(s) could not be read") && r.msg.includes("genuine sibling failure"),
    `marks=${JSON.stringify(r.marks)} msg=${JSON.stringify(r.msg).slice(0, 500)}`,
  );
});

// fixture-44b (MED-1): the same swap with a HARD LINK — the outside file's own
// inode under the victim's name. There is no symlink anywhere, so O_NOFOLLOW
// cannot see it; only the dev+ino comparison against the walk's lstat can.
withVictim(false, (tree, outside) => {
  const r = runHookWithPreload(tree, SWAP_FILE_AT_READ, {
    LOGTRIAGE_FX_TREE: tree,
    LOGTRIAGE_FX_SWAP: "hardlink",
    LOGTRIAGE_FX_SECRET_FILE: path.join(outside, "secret.log"),
  });
  check(
    "fixture-44b-a-log-swapped-for-a-hard-link-at-read-time-is-never-read",
    r.marks.includes("swapped:hardlink") && !r.msg.includes("PLACEHOLDER-SECRET") &&
      r.msg.includes("1 file(s) could not be read") && r.msg.includes("genuine sibling failure"),
    `marks=${JSON.stringify(r.marks)} msg=${JSON.stringify(r.msg).slice(0, 500)}`,
  );
});

// fixture-44c (MED-1, the ancestor residual): the victim's PARENT directory is
// swapped for a symlink to an outside directory at the instant the walk lstat's
// the victim. Before: grep resolved the path through the swapped ancestor and
// read the outside log. After: the hook re-verifies every directory between the
// session root and the file against the identity recorded when the walk entered
// it, immediately before the open and again after it, and refuses on mismatch.
withVictim(true, (tree, outside) => {
  const r = runHookWithPreload(tree, SWAP_ANCESTOR_ON_LSTAT, {
    LOGTRIAGE_FX_TREE: tree,
    LOGTRIAGE_FX_OUTSIDE: outside,
  });
  check(
    "fixture-44c-an-ancestor-directory-swapped-before-the-read-is-never-followed",
    r.marks.includes("swapped:ancestor") && !r.msg.includes("PLACEHOLDER-SECRET") &&
      r.msg.includes("could not be read") && r.msg.includes("genuine sibling failure"),
    `marks=${JSON.stringify(r.marks)} msg=${JSON.stringify(r.msg).slice(0, 500)}`,
  );
});

// fixture-44d (MED-1, liveness): victim.log swapped for a FIFO at the read
// boundary. The hook must open WITHOUT blocking (O_NONBLOCK) and refuse the
// non-regular descriptor; an open that blocks on a writer-less pipe pins the
// hook's only thread until the dispatcher kills it and its output is lost.
withVictim(false, (tree, outside) => {
  const t0 = Date.now();
  const r = runHookWithPreload(tree, SWAP_FILE_AT_READ, {
    LOGTRIAGE_FX_TREE: tree,
    LOGTRIAGE_FX_SWAP: "fifo",
    LOGTRIAGE_FX_SECRET_FILE: path.join(outside, "secret.log"),
  }, { timeoutMs: 15000 });
  const wall = Date.now() - t0;
  check(
    "fixture-44d-a-log-swapped-for-a-fifo-is-refused-without-blocking",
    r.marks.includes("swapped:fifo") && r.status === 0 && wall < 7000 &&
      r.msg.includes("1 file(s) could not be read") && r.msg.includes("genuine sibling failure"),
    `wall=${wall}ms status=${r.status} marks=${JSON.stringify(r.marks)} msg=${JSON.stringify(r.msg).slice(0, 400)}`,
  );
});

// fixture-44e (MED-1): the swap lands at the grep SPAWN — after the hook has
// opened and bound the victim. The only log is logs/victim.log, plus a sibling
// under `workspaces/`, the LAST declared root, so the first grep spawned is the
// victim's. Before: grep was handed the path and opened the swapped-in link.
// After: grep reads the descriptor bound before the swap, so it sees the
// victim's ORIGINAL bytes — nothing leaks, AND nothing is reported unreadable,
// because the file the walk classified is exactly the file that was read.
{
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "logtriage-fx-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "logtriage-outside-"));
  try {
    fs.mkdirSync(path.join(tree, "logs"));
    fs.mkdirSync(path.join(tree, "workspaces"));
    fs.writeFileSync(path.join(tree, "logs", "victim.log"), "WARN the victim's own bytes\n");
    fs.writeFileSync(path.join(tree, "workspaces", "other.log"), "ERROR genuine sibling failure\n");
    fs.writeFileSync(path.join(outside, "secret.log"), `ERROR ${SECRET}\n`);
    const real = fs.realpathSync(tree);
    const r = runHookWithPreload(real, SWAP_FILE_AT_READ, {
      LOGTRIAGE_FX_TREE: real,
      LOGTRIAGE_FX_SWAP: "symlink",
      LOGTRIAGE_FX_SWAP_AT: "grep",
      LOGTRIAGE_FX_SECRET_FILE: path.join(outside, "secret.log"),
    });
    check(
      "fixture-44e-a-swap-after-the-open-cannot-change-what-grep-reads",
      r.marks.includes("swapped:symlink") && !r.msg.includes("PLACEHOLDER-SECRET") &&
        r.msg.includes("the victim's own bytes") && r.msg.includes("genuine sibling failure") &&
        !r.msg.includes("could not be read"),
      `marks=${JSON.stringify(r.marks)} msg=${JSON.stringify(r.msg).slice(0, 500)}`,
    );
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

// ===========================================================================
// POST-GREP WORK IS BOUNDED PER LINE, NOT BY THE LINE'S LENGTH (LOW-2)
// ===========================================================================

// Meter every call of the hook's control-byte neutraliser: the total number of
// characters it is handed is written to the mark at exit. A regex-identity
// match (the CONTROL_BYTES class, global) keeps unrelated replace() calls out.
const INERT_METER = `
const fs = require("fs");
const replace = String.prototype.replace;
let chars = 0;
let calls = 0;
String.prototype.replace = function (re, ...rest) {
  if (re instanceof RegExp && re.global && re.source.includes("\\\\u007f-\\\\u009f")) {
    chars += String(this).length;
    calls++;
  }
  return replace.call(this, re, ...rest);
};
process.on("exit", () => fs.appendFileSync(process.env.LOGTRIAGE_FX_MARK, "inert-calls=" + calls + " inert-chars=" + chars + "\\n"));
`;

// fixture-45 (LOW-2): 150 matched lines of `ERROR` followed by 40,000 control
// bytes. Before: each whole 40 kB line was run through the neutraliser BEFORE
// the 120-character display cut — ~6 M characters of per-byte callbacks, which
// took the scan past its own deadline with no deadline covering it. After: the
// line is cut first, neutralised, and cut again, so the work per line is a
// constant independent of the line's length. The bound asserted (100,000
// characters for the whole run) is ~60x under the old figure and ~5x over the
// most the cut can hand it (150 lines x 120 + names and roots).
{
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "logtriage-fx-"));
  try {
    fs.mkdirSync(path.join(tree, "logs"));
    const line = "ERROR flood " + "\u0001".repeat(40000);
    fs.writeFileSync(path.join(tree, "logs", "flood.log"), Array.from({ length: 150 }, () => line).join("\n") + "\n");
    const t0 = Date.now();
    const r = runHookWithPreload(tree, INERT_METER);
    const wall = Date.now() - t0;
    const m = r.marks.match(/inert-calls=(\d+) inert-chars=(\d+)/);
    const chars = m ? Number(m[2]) : null;
    process.stdout.write(`  NOTE  fixture-45: wall=${wall}ms inert-calls=${m ? m[1] : "?"} inert-chars=${chars}\n`);
    check(
      "fixture-45-post-grep-work-per-line-is-bounded-independent-of-line-length",
      m !== null && Number(m[1]) > 0 && chars <= 100000 && r.status === 0 && r.msg.includes("ERROR flood \\x01"),
      `inert-chars=${chars} (bound 100000) status=${r.status} msg=${JSON.stringify(r.msg).slice(0, 300)}`,
    );
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
}

// ===========================================================================
// AN ATTRIBUTION CANNOT BE FORGED BY A FILENAME (LOW-3)
// ===========================================================================

/**
 * Parse the attribution off a rendered row: a QUOTED path (`"…"`, with `\\`,
 * `\"`, `\xHH` and `\u{H…}` escapes) or a BARE path ending at the first `": "`.
 * Returns the decoded path, or null when the row has no parseable attribution.
 */
function attributionOf(row) {
  const s = row.slice(2);
  if (s.startsWith('"')) {
    let out = "";
    for (let i = 1; i < s.length; ) {
      const c = s[i];
      if (c === '"') return s.slice(i + 1).startsWith(": ") ? { path: out, quoted: true } : null;
      if (c === "\\") {
        const n = s[i + 1];
        if (n === "\\" || n === '"') { out += n; i += 2; continue; }
        if (n === "x") { out += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16)); i += 4; continue; }
        if (n === "u" && s[i + 2] === "{") { const j = s.indexOf("}", i); out += String.fromCodePoint(parseInt(s.slice(i + 3, j), 16)); i = j + 1; continue; }
        return null;
      }
      out += c;
      i++;
    }
    return null;
  }
  const k = s.indexOf(": ");
  return k < 0 ? null : { path: s.slice(0, k), quoted: false };
}

// fixture-46 (LOW-3): a log NAMED `a.log: FATAL db corrupted, run reset; z.log`
// beside a real, clean `a.log`. Before: it rendered as
//   …/logs/a.log: FATAL db corrupted, run reset; z.log: ERROR attacker line
// which reads as `a.log` reporting a FATAL. After: a name that could be misread
// is QUOTED, so the attribution parses back to the file that was opened. The
// other pole: an ordinary name still renders bare, exactly as before.
{
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "logtriage-fx-"));
  try {
    const logs = path.join(tree, "logs");
    fs.mkdirSync(logs);
    const forged = "a.log: FATAL db corrupted, run reset; z.log";
    fs.writeFileSync(path.join(logs, "a.log"), "INFO all fine\n");
    fs.writeFileSync(path.join(logs, forged), "ERROR attacker line\n");
    fs.writeFileSync(path.join(logs, "ok.log"), "ERROR ordinary failure\n");
    const real = fs.realpathSync(logs);
    const r = runHook(tree);
    const rows = renderedLines(r.msg);
    const parsed = rows.map((row) => ({ row, a: attributionOf(row) }));
    const forgedRow = parsed.find((p) => p.row.includes("attacker line"));
    const okRow = parsed.find((p) => p.row.includes("ordinary failure"));
    check(
      "fixture-46-a-separator-bearing-filename-cannot-forge-another-files-attribution",
      rows.length === 2 && forgedRow && forgedRow.a && forgedRow.a.path === path.join(real, forged) &&
        okRow && okRow.row === `  ${path.join(real, "ok.log")}: ERROR ordinary failure`,
      `rows=${JSON.stringify(rows).slice(0, 500)} parsed=${JSON.stringify(parsed.map((p) => p.a)).slice(0, 400)}`,
    );
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
}

// ===========================================================================
// CRLF LOGS, AND TWO BOUNDS THAT WERE PINNED FROM ONE SIDE ONLY
// ===========================================================================

// fixture-47 (CRLF): three IDENTICAL failures in a CRLF log. Before: grep's
// `<n>:` prefix was parsed with `/^\d+:(.*)$/`, which fails on a trailing `\r`
// (`.` does not match it), so the line number stayed in the rendered text and
// the dedupe key — three entries, `1:ERROR …`, `2:ERROR …`, `3:ERROR …`, each
// ending in a visible `\x0d`. After: one entry, no line number, no `\r`.
withLogs({ "win.log": "ERROR disk quota exceeded\r\nERROR disk quota exceeded\r\nERROR disk quota exceeded\r\n" }, {}, (dir) => {
  const r = runHook(dir);
  const rows = renderedLines(r.msg);
  check(
    "fixture-47-crlf-lines-collapse-and-render-without-line-number-or-cr",
    reportedCount(r.msg) === 1 && rows.length === 1 && rows[0].endsWith("/win.log: ERROR disk quota exceeded"),
    `count=${reportedCount(r.msg)} rows=${JSON.stringify(rows).slice(0, 400)}`,
  );
});

// fixture-48 (L3d): a grep that IGNORES SIGTERM. The HOOK_BUDGET_MS arithmetic
// assumes a grep straddling the scan deadline is GONE when its timeout fires,
// which only SIGKILL guarantees. The shim ignores TERM (`trap '' TERM`, which
// the exec'd sleep inherits) and sleeps 12 s: under SIGKILL the hook exits once
// the 2500 ms scan deadline fires; under SIGTERM spawnSync waits out the sleep.
// fixture-43b cannot see this — its shim's sleep dies on TERM as readily as on
// KILL.
{
  const shim = fs.mkdtempSync(path.join(os.tmpdir(), "logtriage-shim-"));
  try {
    fs.writeFileSync(path.join(shim, "grep"), "#!/bin/sh\ntrap '' TERM\nexec sleep 12\n", { mode: 0o755 });
    withLogs({ "app.log": "ERROR database connection failed" }, {}, (dir) => {
      const t0 = Date.now();
      const r = runHookWithPath(dir, `${shim}:${process.env.PATH}`);
      const wall = Date.now() - t0;
      process.stdout.write(`  NOTE  fixture-48: wall=${wall}ms exit=${r.status}\n`);
      check(
        "fixture-48-a-term-ignoring-grep-is-killed-at-the-scan-deadline",
        r.status === 0 && wall < 7000 && r.msg.includes("1 file(s) could not be read"),
        `wall=${wall}ms (limit 7000) status=${r.status} msg=${JSON.stringify(r.msg).slice(0, 300)}`,
      );
    });
  } finally {
    fs.rmSync(shim, { recursive: true, force: true });
  }
}

// fixture-49 (L3e): COC_LOG_TRIAGE_ENUM_BUDGET_MS may LOWER the enumeration
// budget, never RAISE it (fixture-34 pins only the lowering pole, "0"). With the
// override at 60000 and every directory entry costing 100 ms, a clamped hook
// gives up enumerating at ENUM_BUDGET_MS (1500 ms) and names the root failed; a
// hook that honoured the override walks on until the 5500 ms hook deadline.
{
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "logtriage-fx-"));
  try {
    for (let i = 0; i < 60; i++) fs.mkdirSync(path.join(tree, "logs", `d${i}`), { recursive: true });
    const t0 = Date.now();
    const r = runHookWithPreload(tree, SLOW_DIR_READS, { COC_LOG_TRIAGE_ENUM_BUDGET_MS: "60000" });
    const wall = Date.now() - t0;
    process.stdout.write(`  NOTE  fixture-49: wall=${wall}ms exit=${r.status}\n`);
    check(
      "fixture-49-the-enum-budget-override-cannot-raise-the-budget",
      r.marks.includes("slowed") && r.status === 0 && wall < 4000 &&
        r.msg.includes("enumeration failed or timed out for declared root(s)"),
      `wall=${wall}ms (limit 4000) marks=${JSON.stringify(r.marks)} msg=${JSON.stringify(r.msg).slice(0, 300)}`,
    );
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
}

// ===========================================================================
// A FILE IS READ AS TEXT, AND A MATCH THAT PRINTS NOTHING IS NOT CLEAN (HIGH-1)
// ===========================================================================

// fixture-50a (HIGH-1): one NUL byte, and one invalid UTF-8 byte (Latin-1 é),
// in two logs that each carry real failures. Before: grep ran without `-a`, so
// GNU grep exited 0 with an EMPTY stdout and "binary file matches" on stderr —
// the file counted as scanned and its failures vanished — and BSD grep printed
// "Binary file (standard input) matches" in place of the matches. After: both
// files are read as text and every failure renders, nothing unreadable.
{
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "logtriage-fx-"));
  try {
    fs.mkdirSync(path.join(tree, "logs"));
    fs.writeFileSync(path.join(tree, "logs", "nul.log"), Buffer.from("ERROR before-nul\n\0\nERROR after-nul\n", "latin1"));
    fs.writeFileSync(path.join(tree, "logs", "latin1.log"), Buffer.concat([
      Buffer.from("ERROR caf", "latin1"), Buffer.from([0xe9]), Buffer.from(" latin1 failure\n", "latin1"),
    ]));
    const r = runHook(tree);
    check(
      "fixture-50a-a-nul-or-invalid-utf8-byte-does-not-hide-a-files-findings",
      r.status === 0 && r.msg.includes("ERROR before-nul") && r.msg.includes("ERROR after-nul") &&
        r.msg.includes(" latin1 failure") && !/binary file/i.test(r.msg) && !r.msg.includes("could not be read"),
      `status=${r.status} msg=${JSON.stringify(r.msg).slice(0, 500)}`,
    );
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
}

// fixture-50b (HIGH-1): a grep that exits 0 — "matched" — and prints nothing.
// That is the shape `binary file matches` takes on GNU grep, isolated from any
// byte content so it pins the scan's own guard rather than `-a`. Before: the
// file counted as scanned and the session read clean. After: a match with no
// line to show is an answer that cannot be read, and is disclosed as such.
{
  const shim = fs.mkdtempSync(path.join(os.tmpdir(), "logtriage-shim-"));
  try {
    fs.writeFileSync(path.join(shim, "grep"), "#!/bin/sh\ncat >/dev/null\nexit 0\n", { mode: 0o755 });
    withLogs({ "app.log": "ERROR database connection failed" }, {}, (dir) => {
      const r = runHookWithPath(dir, `${shim}:${process.env.PATH}`);
      check(
        "fixture-50b-a-grep-that-matches-but-prints-nothing-is-unreadable-not-clean",
        r.status === 0 && r.msg.includes("1 file(s) could not be read"),
        `status=${r.status} msg=${JSON.stringify(r.msg).slice(0, 300)}`,
      );
    });
  } finally {
    fs.rmSync(shim, { recursive: true, force: true });
  }
}

// ===========================================================================
// A HARD LINK IS NOT PART OF THE DECLARED SURFACE (MED-2)
// ===========================================================================

// fixture-51a (MED-2): a hard link PLANTED in logs/ before the hook runs, whose
// other name is a file outside every declared root. Nothing is swapped, so the
// dev+ino binding agrees with the walk — the inode IS the one the walk saw.
// Before: its bytes were reported as a finding of logs/planted.log. After: a
// file with more than one link is refused and counted unreadable, and the
// sibling's genuine finding still surfaces.
{
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "logtriage-fx-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "logtriage-outside-"));
  try {
    fs.mkdirSync(path.join(tree, "logs"));
    fs.writeFileSync(path.join(outside, "secret.log"), `ERROR ${SECRET}\n`);
    fs.linkSync(path.join(outside, "secret.log"), path.join(tree, "logs", "planted.log"));
    fs.writeFileSync(path.join(tree, "logs", "other.log"), "ERROR genuine sibling failure\n");
    const r = runHook(tree);
    check(
      "fixture-51a-a-planted-hard-link-to-an-outside-file-is-never-read",
      !r.msg.includes("PLACEHOLDER-SECRET") && r.msg.includes("1 file(s) could not be read") &&
        r.msg.includes("genuine sibling failure"),
      `msg=${JSON.stringify(r.msg).slice(0, 500)}`,
    );
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

// The link count can change between the walk's lstat and the open. Just AFTER
// the walk's lstat of the victim has returned (the only lstat the hook takes of
// a file — the chain checks lstat directories), LOGTRIAGE_FX_LINK=add gives it
// a second name (the walk saw one link, the descriptor sees two); =drop removes
// the second name the tree was built with (the walk saw two, the descriptor
// would see one). Each pins ONE of the two checks: `add` only the
// descriptor's, `drop` only the walk's.
const RELINK_AFTER_LSTAT = `
const fs = require("fs");
const path = require("path");
let done = false;
const lstat = fs.lstatSync;
fs.lstatSync = function (p, ...rest) {
  const st = lstat.call(this, p, ...rest);
  if (!done && typeof p === "string" && path.basename(p) === "victim.log") {
    done = true;
    const extra = path.join(process.env.LOGTRIAGE_FX_TREE, "extra-name");
    if (process.env.LOGTRIAGE_FX_LINK === "add") fs.linkSync(p, extra);
    else fs.unlinkSync(extra);
    fs.appendFileSync(process.env.LOGTRIAGE_FX_MARK, "linked:" + process.env.LOGTRIAGE_FX_LINK + "\\n");
  }
  return st;
};
`;

for (const mode of ["add", "drop"]) {
  // fixture-51b (add) / fixture-51c (drop). Before: neither check existed, so
  // the file was read either way and nothing was disclosed.
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "logtriage-fx-"));
  try {
    fs.mkdirSync(path.join(tree, "logs"));
    fs.writeFileSync(path.join(tree, "logs", "victim.log"), "INFO nothing wrong here\n");
    fs.writeFileSync(path.join(tree, "logs", "other.log"), "ERROR genuine sibling failure\n");
    if (mode === "drop") fs.linkSync(path.join(tree, "logs", "victim.log"), path.join(tree, "extra-name"));
    const real = fs.realpathSync(tree);
    const r = runHookWithPreload(real, RELINK_AFTER_LSTAT, { LOGTRIAGE_FX_TREE: real, LOGTRIAGE_FX_LINK: mode });
    const label = mode === "add"
      ? "fixture-51b-a-link-added-after-the-walk-is-refused-by-the-descriptor-check"
      : "fixture-51c-a-link-seen-by-the-walk-is-refused-even-if-gone-at-the-open";
    check(
      label,
      r.marks.includes(`linked:${mode}`) && r.msg.includes("1 file(s) could not be read") &&
        r.msg.includes("genuine sibling failure"),
      `marks=${JSON.stringify(r.marks)} msg=${JSON.stringify(r.msg).slice(0, 400)}`,
    );
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
}

// ===========================================================================
// WHAT A MATCHED LINE RENDERS (LOW: leading whitespace, invisible characters)
// ===========================================================================

const NBSP = String.fromCharCode(0xa0);
const LS = String.fromCharCode(0x2028);
const RLO = String.fromCharCode(0x202e);
const BS = String.fromCharCode(92);

// fixture-52: a matched line led by MORE than the 4096-byte decode window of
// whitespace — 5000 spaces, and 3000 NO-BREAK SPACEs (6000 bytes, each one a
// two-byte UTF-8 form) — and one followed by 5000 trailing spaces. Before: the
// window was cut BEFORE the trim, so the first two rendered as "" and the third
// kept 106 trailing spaces. After: whitespace is skipped on bytes first, so each
// renders exactly as a whole-line trim would.
{
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "logtriage-fx-"));
  try {
    fs.mkdirSync(path.join(tree, "logs"));
    fs.writeFileSync(path.join(tree, "logs", "a.log"), " ".repeat(5000) + "ERROR deep indent\n");
    fs.writeFileSync(path.join(tree, "logs", "b.log"), NBSP.repeat(3000) + "ERROR wide indent\n");
    fs.writeFileSync(path.join(tree, "logs", "c.log"), "ERROR trailing pad" + " ".repeat(5000) + "\n");
    const real = fs.realpathSync(path.join(tree, "logs"));
    const rows = renderedLines(runHook(tree).msg);
    const want = [
      `  ${path.join(real, "a.log")}: ERROR deep indent`,
      `  ${path.join(real, "b.log")}: ERROR wide indent`,
      `  ${path.join(real, "c.log")}: ERROR trailing pad`,
    ];
    check(
      "fixture-52-a-line-led-or-trailed-by-more-than-the-window-of-whitespace-renders-its-text",
      rows.length === 3 && want.every((w) => rows.includes(w)),
      `rows=${JSON.stringify(rows).slice(0, 500)}`,
    );
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
}

// fixture-53: log CONTENT carrying U+2028 LINE SEPARATOR (one log line that
// renders as two rows, the second imitating another file's entry) and U+202E
// RIGHT-TO-LEFT OVERRIDE (reverses what follows it). Before: only FILENAMES had
// these escaped, so content delivered both raw. After: each renders as a
// visible `\u{H…}` and none survives raw.
withLogs(
  { "fmt.log": `ERROR a${LS}  /x/forged.log: FATAL forged-row\nERROR ${RLO}desrever` },
  {},
  (dir) => {
    const r = runHook(dir);
    const raw = r.msg.match(/[\u2028\u2029\u202a-\u202e\u2066-\u2069]/g) || [];
    check(
      "fixture-53-invisible-format-characters-in-log-content-are-made-visible",
      r.msg !== "" && raw.length === 0 && r.msg.includes(`ERROR a${BS}u{2028}  /x/forged.log`) &&
        r.msg.includes(`ERROR ${BS}u{202e}desrever`),
      `raw=${JSON.stringify(raw)} msg=${JSON.stringify(r.msg).slice(0, 400)}`,
    );
  },
);

// ===========================================================================
process.stdout.write(`\n${passed}/${passed + failed} fixtures pass\n`);
process.exit(failed === 0 ? 0 : 1);
