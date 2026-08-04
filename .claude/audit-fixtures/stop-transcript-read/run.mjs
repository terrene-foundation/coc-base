#!/usr/bin/env node
/*
 * Audit fixture runner for the Stop-event final-text recovery in
 * .claude/hooks/detect-violations.js (readFinalAssistantText).
 *
 * WHY END-TO-END: detect-violations.js exports nothing, and the property under
 * test is "does a Stop-dispatched prose detector actually SEE the agent's final
 * message". Driving the real hook over stdin tests the dispatch path itself
 * rather than a helper in isolation — the distinction that let the previous
 * `transcript_path ? "" : ...` stub sit undetected behind correctly-registered
 * detectors.
 *
 * Structural probes per rules/probe-driven-verification.md MUST-3: exit codes
 * and presence/absence of an emitted rule_id. No semantic judgment.
 *
 * Exit 0 = all fixtures pass. Exit 1 = >=1 fixture failed.
 */

import { spawnSync, execFileSync } from "node:child_process";
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "..", "hooks", "detect-violations.js");

// Flag text lifted from the detectSelfConfession fixture corpus — a detector
// dispatched on the Stop event in the unmodified hook, so a firing here proves
// the TEXT reached the existing chain, not that this change added a detector.
const FLAG_TEXT =
  "I missed the integration test step earlier and should have verified the read-back before declaring the migration complete.";
const CLEAN_TEXT = "Landed the change and verified it against the harness.";
// detectSelfConfession emits this rule_id (violation-patterns.js) — NOT a name
// derived from the function. Asserting on a guessed id made every fixture pass
// or fail for the wrong reason on the first run of this suite.
const RULE_ID = "test-completeness/PROVISIONAL";

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

// Drive the real hook with a Stop payload. Returns { status, out, err }.
// `err` is kept SEPARATE from `out` because the recovery WARN (loom#1509 F1) is
// a stderr-only signal and stdout is the hook's structured protocol surface —
// folding them together would make a fixture unable to tell which stream it
// actually observed.
function runStop(payload, opts = {}) {
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 30000,
    killSignal: "SIGKILL",
    // Inherit the ambient env (the harness pins CLAUDE_TRUST_STATE_DIR through
    // it), then layer any per-fixture overrides on top.
    env: { ...process.env, ...(opts.env || {}) },
  });
  return {
    status: r.status ?? -1,
    out: r.stdout || "",
    err: r.stderr || "",
    timedOut: r.error !== undefined && r.error !== null,
    signal: r.signal || null,
  };
}

function assistantEntry(text) {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function toolUseEntry() {
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      ],
    },
  });
}

function withTmp(tag, fn) {
  const tmp = join(tmpdir(), `stop-fix-${tag}-${Date.now()}`);
  try {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    return fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-01-inline-text-present
// ------------------------------------------------------------------
// The payload carries the final message inline. Unchanged behaviour, pinned so
// the transcript fallback cannot regress the shape that already worked.
withTmp("01", (tmp) => {
  const r = runStop({
    hook_event_name: "Stop",
    cwd: tmp,
    session_id: "fx01",
    last_assistant_text: FLAG_TEXT,
  });
  check(
    "fixture-01-inline-text-present-fires",
    r.out.includes(RULE_ID),
    `status=${r.status} out=${r.out.slice(0, 200)}`,
  );
});

// ------------------------------------------------------------------
// fixture-02-transcript-path-only
// ------------------------------------------------------------------
// THE regression this change exists to close. Before it, this branch returned
// "" and the detector could never fire however correctly it was dispatched.
withTmp("02", (tmp) => {
  const tp = join(tmp, "transcript.jsonl");
  writeFileSync(
    tp,
    [assistantEntry("earlier turn"), assistantEntry(FLAG_TEXT)].join("\n") +
      "\n",
  );
  const r = runStop({
    hook_event_name: "Stop",
    cwd: tmp,
    session_id: "fx02",
    transcript_path: tp,
  });
  check(
    "fixture-02-transcript-path-only-fires",
    r.out.includes(RULE_ID),
    `status=${r.status} out=${r.out.slice(0, 200)}`,
  );
});

// ------------------------------------------------------------------
// fixture-03-last-entry-is-tool-use-walks-back
// ------------------------------------------------------------------
// Measured over 400 real transcripts: the LAST assistant entry carries no text
// block in 17.3% of sessions. Reading only the last entry would yield "" in
// roughly one session in six, so the walk-back is load-bearing, not defensive.
withTmp("03", (tmp) => {
  const tp = join(tmp, "transcript.jsonl");
  writeFileSync(
    tp,
    [assistantEntry(FLAG_TEXT), toolUseEntry(), toolUseEntry()].join("\n") +
      "\n",
  );
  const r = runStop({
    hook_event_name: "Stop",
    cwd: tmp,
    session_id: "fx03",
    transcript_path: tp,
  });
  check(
    "fixture-03-last-entry-is-tool-use-walks-back",
    r.out.includes(RULE_ID),
    `status=${r.status} out=${r.out.slice(0, 200)}`,
  );
});

// ------------------------------------------------------------------
// fixture-04-inline-preferred-over-transcript
// ------------------------------------------------------------------
// Both shapes present: the inline text wins. Pinned because the ordering is
// what makes the fix correct without knowing which shape the CLI emits.
withTmp("04", (tmp) => {
  const tp = join(tmp, "transcript.jsonl");
  writeFileSync(tp, assistantEntry(FLAG_TEXT) + "\n");
  const r = runStop({
    hook_event_name: "Stop",
    cwd: tmp,
    session_id: "fx04",
    last_assistant_text: CLEAN_TEXT,
    transcript_path: tp,
  });
  check(
    "fixture-04-inline-preferred-over-transcript",
    !r.out.includes(RULE_ID),
    `inline CLEAN text should win over flagging transcript; out=${r.out.slice(0, 200)}`,
  );
});

// ------------------------------------------------------------------
// fixture-05-both-absent-passthrough
// ------------------------------------------------------------------
withTmp("05", (tmp) => {
  const r = runStop({ hook_event_name: "Stop", cwd: tmp, session_id: "fx05" });
  check(
    "fixture-05-both-absent-passthrough",
    r.status === 0 && !r.out.includes(RULE_ID),
    `status=${r.status} out=${r.out.slice(0, 200)}`,
  );
});

// ------------------------------------------------------------------
// fixture-06-transcript-unreadable-fails-soft
// ------------------------------------------------------------------
// FAIL-SOFT is the load-bearing property: the findings array has no try/catch,
// so a throw here would abort the chain and silently disable EVERY Stop
// detector — strictly worse than the stub this replaces.
withTmp("06", (tmp) => {
  const r = runStop({
    hook_event_name: "Stop",
    cwd: tmp,
    session_id: "fx06",
    transcript_path: join(tmp, "does-not-exist.jsonl"),
  });
  check(
    "fixture-06-transcript-unreadable-fails-soft",
    r.status === 0 && !r.out.includes(RULE_ID),
    `status=${r.status} out=${r.out.slice(0, 300)}`,
  );
});

// ------------------------------------------------------------------
// fixture-07-transcript-malformed-fails-soft
// ------------------------------------------------------------------
// Truncated and non-JSON rows must be skipped, never thrown on. The last row
// is deliberately a half-written JSON object, the shape a live transcript has
// while the CLI is mid-write.
withTmp("07", (tmp) => {
  const tp = join(tmp, "transcript.jsonl");
  writeFileSync(
    tp,
    ["not json at all", "{}", '{"type":"assistant","mess'].join("\n") + "\n",
  );
  const r = runStop({
    hook_event_name: "Stop",
    cwd: tmp,
    session_id: "fx07",
    transcript_path: tp,
  });
  check(
    "fixture-07-transcript-malformed-fails-soft",
    r.status === 0 && !r.out.includes(RULE_ID),
    `status=${r.status} out=${r.out.slice(0, 300)}`,
  );
});

// ------------------------------------------------------------------
// fixture-08-transcript-is-a-directory-fails-soft
// ------------------------------------------------------------------
// statSync succeeds on a directory; only the isFile() guard rejects it.
withTmp("08", (tmp) => {
  const dir = join(tmp, "adir");
  mkdirSync(dir, { recursive: true });
  const r = runStop({
    hook_event_name: "Stop",
    cwd: tmp,
    session_id: "fx08",
    transcript_path: dir,
  });
  check(
    "fixture-08-transcript-is-a-directory-fails-soft",
    r.status === 0 && !r.out.includes(RULE_ID),
    `status=${r.status} out=${r.out.slice(0, 300)}`,
  );
});

// ------------------------------------------------------------------
// fixture-09-large-transcript-tail-bounded
// ------------------------------------------------------------------
// The read is a bounded TAIL, not a slurp: a transcript far larger than the
// 512KB window still resolves, because the text-bearing entry is near EOF —
// where the measurement (p99=92KB from EOF) says it lives.
withTmp("09", (tmp) => {
  const tp = join(tmp, "transcript.jsonl");
  const filler = assistantEntry("x".repeat(4000));
  const rows = [];
  for (let i = 0; i < 800; i++) rows.push(filler); // ~3.2MB of preceding turns
  rows.push(assistantEntry(FLAG_TEXT));
  writeFileSync(tp, rows.join("\n") + "\n");
  const started = Date.now();
  const r = runStop({
    hook_event_name: "Stop",
    cwd: tmp,
    session_id: "fx09",
    transcript_path: tp,
  });
  const ms = Date.now() - started;
  check(
    "fixture-09-large-transcript-tail-bounded",
    r.out.includes(RULE_ID),
    `status=${r.status} ms=${ms} out=${r.out.slice(0, 200)}`,
  );
});

// ------------------------------------------------------------------
// fixture-10-text-beyond-walkback-cap-not-scanned
// ------------------------------------------------------------------
// The walk-back is CAPPED (60 assistant entries; measured max was 48). Text
// older than the cap is deliberately NOT recovered — pinning the bound so a
// future edit cannot silently turn this into an unbounded backwards scan.
withTmp("10", (tmp) => {
  const tp = join(tmp, "transcript.jsonl");
  const rows = [assistantEntry(FLAG_TEXT)];
  for (let i = 0; i < 120; i++) rows.push(toolUseEntry());
  writeFileSync(tp, rows.join("\n") + "\n");
  const r = runStop({
    hook_event_name: "Stop",
    cwd: tmp,
    session_id: "fx10",
    transcript_path: tp,
  });
  check(
    "fixture-10-text-beyond-walkback-cap-not-scanned",
    r.status === 0 && !r.out.includes(RULE_ID),
    `status=${r.status} out=${r.out.slice(0, 300)}`,
  );
});

// ------------------------------------------------------------------
// fixture-11-real-captured-transcript-schema
// ------------------------------------------------------------------
// CLAIM-4 CLOSURE. Fixtures 01-10 all build their input with `assistantEntry()`
// above, which encodes the SAME schema assumption the parser makes. That makes
// the suite self-confirming: it cannot discriminate "the parser matches the real
// CC transcript schema" from "the parser matches this runner's invented schema"
// — the property that most determines whether the fix works in production.
//
// This fixture is built from a REAL captured transcript (content fully redacted,
// shape retained verbatim in assets/real-transcript-shape.jsonl): 14 top-level
// keys where the helper emits 2, a 9-key `message` object where the helper emits
// 2, `thinking` / `tool_use` / `tool_result` content blocks, sibling entry types
// (`user`, `attachment`, `queue-operation`, `last-prompt`) the helper never
// produces, and a NON-assistant row after the text-bearing one.
//
// WHAT THIS FIXTURE DOES AND DOES NOT CATCH — stated precisely, because the
// obvious claim is wrong. It catches a PARSER REGRESSION: an edit that narrows
// the parser away from the real shape reds here and nowhere else in the suite
// (proven — over-fitting the parser to the synthetic helper's 2-key shape reds
// fixture-11 alone and leaves 01-10 green).
//
// It does NOT catch a CC SCHEMA CHANGE. The asset is a committed static capture
// pinned to `"version": "2.1.203"`; if CC moves the text (say `message.content[]`
// becomes `message.blocks[]`), the asset does not move with it, the parser still
// parses the old shape, and THIS FIXTURE STAYS GREEN while production goes blind.
// Schema drift is caught in PRODUCTION by F1's recovery WARN, not in CI here.
// The two are complementary and neither substitutes for the other.
//
// Consequence: the asset needs periodic RE-CAPTURE against a current transcript,
// or it silently pins an ever-staler shape.
withTmp("11", (tmp) => {
  const asset = join(HERE, "assets", "real-transcript-shape.jsonl");
  const tp = join(tmp, "transcript.jsonl");
  // Substitute the flag text into the real entry, JSON-escaped so the row stays
  // valid regardless of the text's punctuation.
  const raw = readFileSync(asset, "utf8");
  const escaped = JSON.stringify(FLAG_TEXT).slice(1, -1);
  writeFileSync(tp, raw.replace("__FLAG_TEXT__", escaped));
  const r = runStop({
    hook_event_name: "Stop",
    cwd: tmp,
    session_id: "fx11",
    transcript_path: tp,
  });
  check(
    "fixture-11-real-captured-transcript-schema",
    r.out.includes(RULE_ID),
    `real-schema transcript did not reach the detectors — the parser's schema ` +
      `assumption no longer matches a captured CC transcript. status=${r.status} out=${r.out.slice(0, 200)}`,
  );
});

// ------------------------------------------------------------------
// fixture-12-fifo-transcript-does-not-hang
// ------------------------------------------------------------------
// loom#1509 F3. `openSync(p, "r")` on a FIFO BLOCKS until a writer appears, and
// the hook's 5s setTimeout fallback cannot rescue it: Node timers need the event
// loop, which a synchronous open holds. The recovery therefore opens with
// O_NONBLOCK and derives every guard from fstatSync(fd).
//
// The bound is asserted in WALL CLOCK, not just by exit status: a fixture that
// only checked `status === 0` would pass just as well on a hook that blocked for
// 29s and was then killed by the runner's own timeout.
withTmp("12", (tmp) => {
  const fifo = join(tmp, "transcript.jsonl");
  execFileSync("mkfifo", [fifo]);
  const started = Date.now();
  const r = runStop(
    {
      hook_event_name: "Stop",
      cwd: tmp,
      session_id: "fx12",
      transcript_path: fifo,
    },
    { timeoutMs: 15000 },
  );
  const ms = Date.now() - started;
  check(
    "fixture-12-fifo-transcript-does-not-hang",
    r.status === 0 && !r.timedOut && ms < 10000,
    `FIFO transcript blocked the hook: status=${r.status} timedOut=${r.timedOut} signal=${r.signal} ms=${ms}`,
  );
});

// ------------------------------------------------------------------
// fixture-13-symlinked-transcript-refused
// ------------------------------------------------------------------
// O_NOFOLLOW: the final path component may not be a symlink, so the path cannot
// be re-pointed between resolutions. Measured cost of this restriction: 0 of
// 32,957 real transcripts on the reference machine are symlinks. Refusal must
// FAIL SOFT (exit 0, no detector aborted) and be LOUD (fixture-14 covers the
// warning channel itself).
withTmp("13", (tmp) => {
  const real = join(tmp, "real.jsonl");
  const link = join(tmp, "transcript.jsonl");
  writeFileSync(real, assistantEntry(FLAG_TEXT) + "\n");
  symlinkSync(real, link);
  const r = runStop({
    hook_event_name: "Stop",
    cwd: tmp,
    session_id: "fx13",
    transcript_path: link,
  });
  check(
    "fixture-13-symlinked-transcript-refused-fails-soft",
    r.status === 0 && !r.out.includes(RULE_ID),
    `status=${r.status} out=${r.out.slice(0, 300)}`,
  );
  check(
    "fixture-13-symlinked-transcript-refusal-is-loud",
    r.err.includes("stop-transcript-recovery") && r.err.includes("symlink"),
    `refusal was SILENT — err=${r.err.slice(0, 300)}`,
  );
});

// ------------------------------------------------------------------
// fixture-14-silent-blindness-warns
// ------------------------------------------------------------------
// loom#1509 F1, THE finding this fixture exists for. When a transcript is
// offered but yields no text, every Stop prose detector scans "" and the turn is
// indistinguishable from clean. rules/security.md § "Secure-Default For A New
// Security Feature" requires fail-closed OR a loud one-time WARN; fail-closed is
// infeasible (a throw aborts the un-guarded `findings` array and disables every
// Stop detector), so the WARN branch is mandatory.
//
// The scenario modelled here is the concrete one: a final message LARGER than
// the 512KB tail window. Measured max-from-EOF was 436KB against that window —
// a 76KB margin — and a long /redteam report is both the most likely message to
// exceed it and the most likely to carry a violation.
withTmp("14", (tmp) => {
  const tp = join(tmp, "transcript.jsonl");
  // One assistant row whose text alone far exceeds the 512KB window, so the tail
  // holds only an unparseable fragment of a single JSON line.
  writeFileSync(tp, assistantEntry("y".repeat(900 * 1024)) + "\n");
  const r = runStop({
    hook_event_name: "Stop",
    cwd: tmp,
    session_id: "fx14",
    transcript_path: tp,
  });
  check(
    "fixture-14-oversized-final-message-fails-soft",
    r.status === 0,
    `status=${r.status} out=${r.out.slice(0, 200)}`,
  );
  check(
    "fixture-14-oversized-final-message-warns",
    r.err.includes("stop-transcript-recovery") &&
      r.err.includes("no text-bearing assistant entry"),
    `detector blindness was SILENT — this is the failure mode of the stub the ` +
      `fix replaces. err=${r.err.slice(0, 300)}`,
  );
});

// ------------------------------------------------------------------
// fixture-15-no-transcript-offered-does-not-warn
// ------------------------------------------------------------------
// The WARN's no-false-positive arm. A Stop payload carrying neither shape is the
// ordinary no-op, not a detector blind spot; warning there would train the
// operator to ignore the channel, which is how a loud signal becomes a silent
// one. Paired with fixture-14 this makes the suite BIPOLAR on the warning:
// fires when blind, silent when merely idle.
withTmp("15", (tmp) => {
  const r = runStop({ hook_event_name: "Stop", cwd: tmp, session_id: "fx15" });
  check(
    "fixture-15-no-transcript-offered-does-not-warn",
    r.status === 0 && !r.err.includes("stop-transcript-recovery"),
    `spurious recovery warning on an ordinary no-transcript Stop: err=${r.err.slice(0, 300)}`,
  );
  check(
    "fixture-15-inline-text-path-does-not-warn",
    !runStop({
      hook_event_name: "Stop",
      cwd: tmp,
      session_id: "fx15b",
      last_assistant_text: CLEAN_TEXT,
    }).err.includes("stop-transcript-recovery"),
    "spurious recovery warning on the inline-text path",
  );
});

// ------------------------------------------------------------------
// fixture-16-degraded-platform-open-guards
// ------------------------------------------------------------------
// THE WINDOWS PATH. Node leaves O_NOFOLLOW and O_NONBLOCK UNDEFINED on Windows,
// and `X | undefined` coerces through ToInt32 to `X | 0` — so writing the
// constants inline collapses the whole expression to a plain O_RDONLY with no
// throw, no errno and no warning: BOTH protections vanish silently. loom targets
// Windows/ADO client layouts, so the branch is reachable in production.
//
// Every other fixture in this suite runs on darwin/linux, where both constants
// always exist — so without the COC_TEST_FORCE_NO_OPEN_GUARDS seam this branch
// is UNREACHABLE FROM CI and would ship untested. The seam is not an escape
// hatch: unset is the hardened state, and turning it on is LOUD (the warning
// names the run as SIMULATED), so a production misuse cannot be silent.
withTmp("16", (tmp) => {
  const tp = join(tmp, "transcript.jsonl");
  writeFileSync(tp, assistantEntry(FLAG_TEXT) + "\n");
  const r = runStop(
    {
      hook_event_name: "Stop",
      cwd: tmp,
      session_id: "fx16",
      transcript_path: tp,
    },
    { env: { COC_TEST_FORCE_NO_OPEN_GUARDS: "1" } },
  );
  // The degrade must WARN — this is the whole point; a silent degrade is the
  // Secure-Default violation the fix exists to close.
  check(
    "fixture-16-degraded-platform-warns",
    r.err.includes("guards are INACTIVE"),
    `degraded open was SILENT — err=${r.err.slice(0, 300)}`,
  );
  check(
    "fixture-16-degraded-platform-names-simulation",
    r.err.includes("SIMULATED"),
    `degraded warning did not distinguish the test seam from a real platform; err=${r.err.slice(0, 300)}`,
  );
  // ...and must still WORK. A degraded platform loses the symlink/FIFO guards,
  // NOT the detector: a plain regular-file transcript must still reach the chain.
  check(
    "fixture-16-degraded-platform-still-reads",
    r.status === 0 && r.out.includes(RULE_ID),
    `degraded platform broke ordinary recovery: status=${r.status} out=${r.out.slice(0, 200)}`,
  );
});

// ------------------------------------------------------------------
// fixture-17-hardened-platform-does-not-warn
// ------------------------------------------------------------------
// fixture-16's no-false-positive arm. On a platform that HAS both flags and with
// the seam unset, the degraded warning MUST NOT fire — otherwise the channel
// cries wolf on every ordinary run and operators learn to ignore the one signal
// that means their guards are off.
withTmp("17", (tmp) => {
  const tp = join(tmp, "transcript.jsonl");
  writeFileSync(tp, assistantEntry(FLAG_TEXT) + "\n");
  const r = runStop({
    hook_event_name: "Stop",
    cwd: tmp,
    session_id: "fx17",
    transcript_path: tp,
  });
  check(
    "fixture-17-hardened-platform-does-not-warn",
    !r.err.includes("guards are INACTIVE"),
    `spurious degraded-platform warning on a platform that has both flags: err=${r.err.slice(0, 300)}`,
  );
});

// ------------------------------------------------------------------
// fixture-18-transcript-path-present-but-unusable-warns
// ------------------------------------------------------------------
// The Q3 residual. `!transcriptPath || typeof !== "string"` collapsed TWO
// different situations into one silent return: nothing offered (correct no-op)
// and offered-but-unusable. The second is reachable exactly when it matters
// most — if CC ever wraps the field in an envelope (`{path: …}`) or emits an
// empty string, the hook reverts to the original stub's behaviour (every Stop
// detector scans "") with NO signal. Neither fixture-14 nor fixture-15 covers it.
for (const [tag, value, label] of [
  ["18a", { path: "/tmp/x.jsonl" }, "envelope-object"],
  ["18b", "", "empty-string"],
  ["18c", 42, "number"],
]) {
  withTmp(tag, (tmp) => {
    const r = runStop({
      hook_event_name: "Stop",
      cwd: tmp,
      session_id: `fx${tag}`,
      transcript_path: value,
    });
    check(
      `fixture-${tag}-unusable-transcript-path-${label}-warns`,
      r.status === 0 && r.err.includes("present but unusable"),
      `unusable transcript_path was SILENT — status=${r.status} err=${r.err.slice(0, 300)}`,
    );
  });
}

// ------------------------------------------------------------------
// fixture-19-both-warnings-coexist
// ------------------------------------------------------------------
// The two warnings are one-time each and MUST hold SEPARATE budgets. Sharing a
// single flag is an easy and invisible "simplification": the platform warning
// fires first (before the open), consumes the budget, and silently suppresses
// the recovery warning that says the detectors went blind — reintroducing the
// exact silence F1 exists to remove, on the platform that has the fewest guards.
//
// Only a run where BOTH fire can catch it: a degraded platform (warning 1)
// reading a transcript whose final message overflows the tail window (warning 2).
// Every other fixture triggers at most one, which is why this case is separate.
withTmp("19", (tmp) => {
  const tp = join(tmp, "transcript.jsonl");
  writeFileSync(tp, assistantEntry("z".repeat(900 * 1024)) + "\n");
  const r = runStop(
    {
      hook_event_name: "Stop",
      cwd: tmp,
      session_id: "fx19",
      transcript_path: tp,
    },
    { env: { COC_TEST_FORCE_NO_OPEN_GUARDS: "1" } },
  );
  check(
    "fixture-19-degraded-platform-warning-present",
    r.err.includes("guards are INACTIVE"),
    `platform warning missing; err=${r.err.slice(0, 400)}`,
  );
  check(
    "fixture-19-recovery-warning-not-suppressed",
    r.err.includes("no text-bearing assistant entry"),
    `the recovery warning was SUPPRESSED by the platform warning — the two ` +
      `one-time budgets are shared. err=${r.err.slice(0, 400)}`,
  );
});

// ------------------------------------------------------------------
process.stdout.write(`\n${passed}/${passed + failed} fixtures pass\n`);
process.exit(failed === 0 ? 0 : 1);
