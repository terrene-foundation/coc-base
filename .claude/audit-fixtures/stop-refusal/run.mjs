#!/usr/bin/env node
/**
 * Audit-fixture runner for the opt-in `Stop` hand-back refusal —
 * `.claude/hooks/lib/instruct-and-wait.js` (`refuseHandback`) plus its budget module
 * `.claude/hooks/lib/stop-refusal.js` — shipped WITH the capability per `cc-artifacts.md` Rule 9.
 *
 * WHAT IS PINNED HERE, AND WHAT IS DELIBERATELY NOT.
 *
 *   The host behaviour this capability rests on was established by LIVE MEASUREMENT on 2026-08-20
 *   — a sandbox project with one `Stop` hook, driven three times through `claude -p` with the
 *   hook's output switched by an env var. That probe is COMMITTED, verbatim, at `./probe/`, with
 *   its recorded result at `./probe/measurement-2026-08-20.json`. It is NOT run by this runner and
 *   NOT run in CI, and the reason is stated rather than implied:
 *
 *     - it requires a live model and network, so it is not hermetic;
 *     - its verdict is a MODEL OUTPUT (`PROBE_CONTINUED` vs `BASELINE_OK`), so it is not
 *       deterministic in the way a fixture gate must be;
 *     - the loom↔csq boundary keeps CI LLM-FREE by design, and a fixture that quietly imports an
 *       LLM dependency into the audit gate would breach it.
 *
 *   SO THIS RUNNER PINS THE JSON SHAPES, NOT THE HOST. Every case below asserts what OUR code
 *   emits given a payload; none asserts what the host does with it. That distinction is the whole
 *   honesty of this file — `instrument-discipline.md` MUST-4 — because the defect being repaired
 *   was precisely a library reading an instrument sound for question A as though it had settled
 *   question B. The host contract is evidenced by the probe; the emitted shape is evidenced here;
 *   neither stands in for the other.
 *
 * COVERAGE SHAPE — ONE CASE PER SCOPE-RESTRICTION PREDICATE, BIPOLAR THROUGHOUT. Every predicate
 * carries BOTH a firing pole and a quiet pole, because this capability's two failure modes are
 * opposite and BOTH are silent: a refusal that never fires is indistinguishable from a clean
 * session, and a refusal that cannot stop is a WEDGE that consumes a human's session. A set that
 * only ever asserts firing passes against a library that refuses unconditionally; a set that only
 * ever asserts silence passes against one that is inert.
 *
 *   1  the DEFAULT is unchanged — no `refuseHandback`, no refusal, at every STOP_LIKE event
 *   2  refusal is NEVER inferred from `severity` (the `burndown-quote-stop-guard.js` invariant)
 *   3  an opted-in refusal emits the MEASURED shape and nothing else
 *   4  BOUND 1 — `stop_hook_active` suppresses the refire (THE WEDGE CASE)
 *   5  BOUND 2 — the per-session budget bounds a host that never sets the flag
 *   6  the cap is clamped strictly BELOW the host's own 8-block override
 *   7  the budget is keyed per guard, and `cleared` resets one key
 *   8  BOUND 3 — the kill switch, both poles
 *   9  BOUND 4 — fail-open on unwritable / unreadable / unloadable budget
 *  10  the shape gate THROWS; the safe shape does not
 *  11  refusal at an UNMEASURED event throws rather than guessing
 *  12  the REAL hook boundary — stdin in, `decision:"block"` out, exit 0
 *  13  isolation — nothing is written under the real `.claude/learning/`
 *
 * ESTABLISHED RED (`instrument-discipline.md` MUST-2). Every mutation below was RUN against this
 * file before it landed — MEASURED, not predicted — and each was confirmed to REACH the code under
 * test by asserting its anchor was PRESENT before the edit, so no green can be read as "the
 * mutation was inert". The unmutated baseline and the restored files both exit 0.
 *
 *   M-a  `refuseHandback` inferred from `severity === "block"` at STOP_LIKE   → 04, 05, 06, 07
 *   M-b  drop the `stop_hook_active === true` bound in `refusalVerdict`       → 14, 15, 27
 *   M-c  `countRefusals` returns `{ok:true,count:0}` unconditionally          → 17, 18, 22, 23
 *   M-d  record the refusal AFTER emitting instead of before                  → 21
 *   M-e  `resolveMaxRefusals` returns the request unclamped                   → 19, 20
 *   M-f  `assertRefusalShape` returns true instead of throwing                → 24a..24m, 26
 *   M-g  a torn ledger row is skipped rather than failing the read            → 23
 *   M-h  the refusal head reuses the `isUnblockableBlock` head                → 09
 *   M-i  `budgetKey` regex widened to `.+`                                    → 24i, 24j
 *
 * HERMETIC: temp trees under `os.tmpdir()` via `mkdtempSync`; no network; no git; no LLM. Case 30
 * asserts the isolation rather than assuming it.
 */

import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const HOOKS = path.join(REPO, ".claude", "hooks");
const LIB = path.join(HOOKS, "lib", "instruct-and-wait.js");

const { instructAndWait, assertRefusalShape } = require_(LIB);
const SR = require_(path.join(HOOKS, "lib", "stop-refusal.js"));

/*
 * ISOLATION BASELINE — snapshot taken BEFORE any case runs (case 30 reads it).
 *
 * Case 30 asserts THIS RUN wrote nothing under the repo's real state dir. It used
 * to MEASURE "the directory is empty", which is a different proposition and could
 * not tell the two apart: the dir is written by ordinary sessions whenever the Stop
 * hook fires, so the case was GREEN only on a fresh checkout and RED in every
 * working clone — a verdict tracking the checkout's runtime detritus rather than
 * this runner's behaviour (`instrument-discipline.md` MUST-1: an empty dir is
 * consistent with "isolated" AND with "not isolated, but nobody used the hook").
 *
 * MEASURED at the repair: 6 pre-existing entries, mtimes spanning three days, none
 * of them written by this runner.
 *
 * The snapshot makes the case measure what it NAMES — entries that appeared DURING
 * this run — so it still fires on a genuine isolation break and no longer fires on
 * a colleague's session history.
 */
const REAL_STATE_DIR = path.join(REPO, ".claude", "learning", "stop-refusal");
const readStateDir = () => {
  try {
    return new Set(fs.readdirSync(REAL_STATE_DIR));
  } catch {
    return new Set();
  }
};
const STATE_DIR_BEFORE = readStateDir();

const cases = [];
function check(id, name, cond, detail, redsUnder) {
  cases.push({ id, name, pass: !!cond, detail, redsUnder });
}

const TMPS = [];
function mktmp(tag) {
  // `mkdtempSync`, never a hoped-unique name — see `audit-fixture-tempdir-uniqueness.test.mjs`.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), tag));
  TMPS.push(d);
  return d;
}
function freshRepo() {
  const d = mktmp("stop-refusal-fx-");
  fs.mkdirSync(path.join(d, ".claude"), { recursive: true });
  return d;
}

const args = (over) => ({
  hookEvent: "Stop",
  severity: "halt-and-report",
  what_happened: "the condition holds",
  why: "a rule",
  agent_must_report: ["report it"],
  agent_must_wait: false,
  ...over,
});
const req = (repoDir, over) => ({
  payload: { session_id: "sess-1" },
  repoDir,
  budgetKey: "fixture-guard",
  ...over,
});
const refused = (out) => "decision" in out.json;

// ── 1. the DEFAULT is unchanged ───────────────────────────────────────────────────────────────

for (const ev of ["Stop", "SessionEnd", "PreCompact"]) {
  const out = instructAndWait(args({ hookEvent: ev }));
  check(
    `01-${ev}`,
    `DEFAULT quiet pole: ${ev} with no opt-in emits {continue:true, systemMessage} at exit 0`,
    JSON.stringify(Object.keys(out.json).sort()) === '["continue","systemMessage"]' &&
      out.json.continue === true &&
      out.exitCode === 0,
    `keys=${Object.keys(out.json).join(",")} exit=${out.exitCode}`,
  );
}
{
  // The PreToolUse block branch writes the rendered body to stderr as its delivery channel. That
  // is correct behaviour and must stay exercised — but its output would otherwise land in this
  // runner's own stderr, where the gate's FAIL-marker scanner reads. Captured, not skipped.
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  let out;
  try {
    out = instructAndWait(args({ hookEvent: "PreToolUse", severity: "block" }));
  } finally {
    process.stderr.write = realWrite;
  }
  check(
    "02",
    "DEFAULT control: PreToolUse+block is STILL exit 2 + deny (never continue:false) — refusal changed nothing here",
    out.exitCode === 2 && out.json.hookSpecificOutput?.permissionDecision === "deny" && out.json.continue !== false,
    `exit=${out.exitCode}`,
  );
}

// ── 2. refusal is NEVER inferred from severity ────────────────────────────────────────────────

for (const ev of ["Stop", "SessionEnd", "PreCompact"]) {
  const out = instructAndWait(args({ hookEvent: ev, severity: "block" }));
  check(
    `04-${ev}`,
    `SEVERITY-INDEPENDENCE: severity "block" at ${ev} WITHOUT opt-in stays non-refusing`,
    !refused(out) && out.json.continue === true,
    `keys=${Object.keys(out.json).join(",")}`,
    "M-a: infer refusal from severity",
  );
}
check(
  "05",
  "SEVERITY-INDEPENDENCE: the block-at-Stop head is UNCHANGED — the burndown guard's own invariant",
  instructAndWait(args({ hookEvent: "Stop", severity: "block" })).json.systemMessage.startsWith(
    "NOT BLOCKED — this event cannot block.",
  ),
  "burndown-integrity.md insists Stop severity is not teeth; that must remain true",
  "M-a",
);
{
  // FIRING POLE for the same predicate: opt-in DOES refuse at the very severity that must not
  // refuse on its own. Without this, case 04's green is consistent with a library that can never
  // refuse at all.
  const out = instructAndWait(args({ severity: "block", refuseHandback: req(freshRepo()) }));
  check(
    "06",
    "SEVERITY-INDEPENDENCE firing pole: the SAME severity DOES refuse once the caller opts in",
    refused(out),
    `keys=${Object.keys(out.json).join(",")}`,
    "M-a",
  );
}
{
  const out = instructAndWait(args({ severity: "advisory", refuseHandback: req(freshRepo()) }));
  check(
    "07",
    "SEVERITY-INDEPENDENCE: an ADVISORY finding refuses too — the axis is the opt-in, not the class",
    refused(out),
    `advisory + opt-in → ${Object.keys(out.json).join(",")}`,
    "M-a",
  );
}

// ── 3. the MEASURED refusal shape ─────────────────────────────────────────────────────────────

{
  const out = instructAndWait(args({ refuseHandback: req(freshRepo()) }));
  check(
    "08",
    "SHAPE: exactly {decision:'block', reason} at exit 0 — the arm the probe measured",
    JSON.stringify(Object.keys(out.json).sort()) === '["decision","reason"]' &&
      out.json.decision === "block" &&
      out.exitCode === 0,
    `keys=${Object.keys(out.json).join(",")} exit=${out.exitCode}`,
  );
  check(
    "08b",
    "SHAPE quiet pole: `continue` is ABSENT — the probe measured continue:false as INERT at Stop",
    !("continue" in out.json) && !("systemMessage" in out.json),
    "an unmeasured key must not ride along on a measured payload",
  );
  check(
    "09",
    "HEAD: a firing refusal states the TRUE fate and its own bound, not 'this event cannot block'",
    out.json.reason.startsWith("HAND-BACK REFUSED —") &&
      out.json.reason.includes("(Refusal 1/3 this session;") &&
      !out.json.reason.includes("this event cannot block"),
    out.json.reason.slice(0, 90),
    "M-h: reuse the isUnblockableBlock head",
  );
  check(
    "10",
    "BODY: the finding itself survives into the refusal — reason IS the rendered body",
    out.json.reason.includes("WHAT HAPPENED: the condition holds") && out.json.reason.includes("WHY: a rule"),
    "the refusal is a delivery channel, not a replacement for the report",
  );
}

// ── 4. BOUND 1 — stop_hook_active. THE WEDGE CASE. ────────────────────────────────────────────

{
  const repo = freshRepo();
  const first = instructAndWait(args({ refuseHandback: req(repo) }));
  check("13", "WEDGE setup: the first refusal fires (otherwise there is nothing to wedge)", refused(first), "fire 1 refused");
  // THE REFIRE. Identical condition, identical key, identical repo — the ONLY change is the flag
  // the host sets on a re-invocation, exactly as measured.
  const second = instructAndWait(
    args({ refuseHandback: req(repo, { payload: { session_id: "sess-1", stop_hook_active: true } }) }),
  );
  check(
    "14",
    "WEDGE: a refusing guard WHOSE CONDITION IS STILL TRUE cannot refuse twice",
    !refused(second) && second.json.continue === true,
    `refire → ${Object.keys(second.json).join(",")}`,
    "M-b: drop the stop_hook_active bound",
  );
  check(
    "15",
    "WEDGE: the suppression is NAMED, so a quiet turn is legible rather than looking un-run",
    SR.refusalVerdict("Stop", req(repo, { payload: { session_id: "s", stop_hook_active: true } })).reason ===
      "stop-hook-active",
    "reason=stop-hook-active",
    "M-b",
  );
  check(
    "16",
    "WEDGE quiet pole: a NON-boolean truthy flag is not a signal — only `=== true` suppresses",
    SR.refusalVerdict("Stop", req(freshRepo(), { payload: { session_id: "s", stop_hook_active: "yes" } })).refuse ===
      true,
    "an absent or non-boolean flag is a first fire",
  );
  check(
    "27",
    "WEDGE: the finding is NOT lost on the suppressed refire — it rides systemMessage",
    typeof second.json.systemMessage === "string" && second.json.systemMessage.includes("WHAT HAPPENED: the condition holds"),
    "suppressing the refusal must not suppress the report",
    "M-b",
  );
}

// ── 5..6. BOUND 2 — the per-session budget, clamped below the host override ───────────────────

{
  const repo = freshRepo();
  const seq = [];
  for (let i = 0; i < 6; i++) seq.push(refused(instructAndWait(args({ refuseHandback: req(repo) }))));
  check(
    "17",
    "BUDGET: a host that NEVER sets stop_hook_active is still bounded — 3 refusals, then silence",
    JSON.stringify(seq) === "[true,true,true,false,false,false]",
    JSON.stringify(seq),
    "M-c: countRefusals always returns 0",
  );
  check(
    "18",
    "BUDGET: exhaustion is NAMED, and the finding still reaches the agent",
    SR.refusalVerdict("Stop", req(repo)).reason === "budget-exhausted" &&
      instructAndWait(args({ refuseHandback: req(repo) })).json.systemMessage.includes("WHAT HAPPENED:"),
    "reason=budget-exhausted; systemMessage intact",
    "M-c",
  );
}
check(
  "19",
  "CLAMP: a caller cannot raise the cap to or beyond the host's own 8-block override",
  SR.resolveMaxRefusals(99) === SR.HOST_OVERRIDE_AFTER - 1 &&
    SR.resolveMaxRefusals(8) === SR.HOST_OVERRIDE_AFTER - 1 &&
    SR.DEFAULT_MAX_REFUSALS < SR.HOST_OVERRIDE_AFTER,
  `clamp(99)=${SR.resolveMaxRefusals(99)} host=${SR.HOST_OVERRIDE_AFTER}`,
  "M-e: return the request unclamped",
);
check(
  "20",
  "CLAMP quiet pole: garbage and out-of-range values fall back rather than silently disarming",
  SR.resolveMaxRefusals(0) === 1 &&
    SR.resolveMaxRefusals(-5) === 1 &&
    SR.resolveMaxRefusals("3") === SR.DEFAULT_MAX_REFUSALS &&
    SR.resolveMaxRefusals(undefined) === SR.DEFAULT_MAX_REFUSALS &&
    SR.resolveMaxRefusals(2) === 2,
  "0→1, -5→1, '3'→default, undefined→default, 2→2",
  "M-e",
);
{
  const repo = freshRepo();
  let n = 0;
  for (let i = 0; i < 9; i++) if (refused(instructAndWait(args({ refuseHandback: req(repo, { maxRefusals: 99 }) })))) n++;
  check(
    "20b",
    "CLAMP reaches the public API: an over-ambitious caller still stops below the host override",
    n === SR.HOST_OVERRIDE_AFTER - 1,
    `refusals=${n} of a requested 99`,
    "M-e",
  );
}
check(
  "21",
  "ORDER: the budget is incremented BEFORE the refusal is returned, never after",
  (() => {
    const repo = freshRepo();
    instructAndWait(args({ refuseHandback: req(repo) }));
    return SR.countRefusals(repo, "sess-1", "fixture-guard").count === 1;
  })(),
  "a refusal that returned without being counted would be a refusal nothing bounds",
  "M-d: record after emitting",
);

// ── 7. per-guard keying + explicit reset ──────────────────────────────────────────────────────

{
  const repo = freshRepo();
  for (let i = 0; i < 3; i++) instructAndWait(args({ refuseHandback: req(repo, { budgetKey: "guard-a" }) }));
  check(
    "22",
    "KEYING: two guards do not spend each other's slots",
    SR.countRefusals(repo, "sess-1", "guard-a").count === 3 &&
      SR.countRefusals(repo, "sess-1", "guard-b").count === 0 &&
      refused(instructAndWait(args({ refuseHandback: req(repo, { budgetKey: "guard-b" }) }))),
    "guard-a spent, guard-b untouched",
    "M-c",
  );
  check(
    "22b",
    "KEYING: an explicit `cleared` row resets ONE key and refills its budget",
    (() => {
      SR.recordHandbackCleared(repo, "sess-1", "guard-a");
      return (
        SR.countRefusals(repo, "sess-1", "guard-a").count === 0 &&
        refused(instructAndWait(args({ refuseHandback: req(repo, { budgetKey: "guard-a" }) })))
      );
    })(),
    "cleared → count 0 → refusal available again",
  );
}

// ── 8. BOUND 3 — the kill switch, both poles ──────────────────────────────────────────────────

{
  const off = ["0", "off", "false", "no", "OFF", " False "];
  const on = ["", "1", "on", "true", "yes"];
  check(
    "25",
    "KILL SWITCH firing pole: 0|off|false|no (any case, trimmed) disables refusal",
    off.every((v) => {
      const r = SR.refusalVerdict("Stop", req(freshRepo(), { env: { COC_STOP_REFUSAL: v } }));
      return r.refuse === false && r.reason === "kill-switch";
    }),
    off.join(","),
  );
  check(
    "25b",
    "KILL SWITCH quiet pole: DEFAULT-ON — absent, empty, or any other value leaves refusal available",
    SR.refusalVerdict("Stop", req(freshRepo(), { env: {} })).refuse === true &&
      on.every((v) => SR.refusalVerdict("Stop", req(freshRepo(), { env: { COC_STOP_REFUSAL: v } })).refuse === true),
    "a deployment that never heard of this is unaffected — nothing opts in",
  );
  check(
    "25c",
    "KILL SWITCH reaches the public API",
    !refused(instructAndWait(args({ refuseHandback: req(freshRepo(), { env: { COC_STOP_REFUSAL: "0" } }) }))),
    "COC_STOP_REFUSAL=0 → {continue:true, systemMessage}",
  );
}

// ── 9. BOUND 4 — fail-open on every error path ────────────────────────────────────────────────

check(
  "23a",
  "FAIL-OPEN: a budget that cannot be WRITTEN degrades to today's payload, never to a refusal",
  !refused(instructAndWait(args({ refuseHandback: req(path.join(os.tmpdir(), "sr-absent-" + process.pid)) }))),
  "an uncountable refusal is exactly the wedge",
);
check(
  "23",
  "FAIL-OPEN: a TORN ledger row fails the read rather than being skipped (a skip would UNDERCOUNT)",
  (() => {
    const repo = freshRepo();
    const led = SR._ledgerPath(repo, "sess-1");
    fs.mkdirSync(path.dirname(led), { recursive: true });
    fs.writeFileSync(led, '{"v":1,"key":"fixture-guard","verdict":"refused"}\n{ not json\n');
    return SR.countRefusals(repo, "sess-1", "fixture-guard").ok === false && !refused(instructAndWait(args({ refuseHandback: req(repo) })));
  })(),
  "unreadable history ⇒ do not refuse",
  "M-g: skip torn rows",
);
check(
  "23b",
  "FAIL-OPEN quiet pole: a ledger that does not exist YET is a real zero, not a read failure",
  (() => {
    const r = SR.countRefusals(freshRepo(), "never-seen", "fixture-guard");
    return r.ok === true && r.count === 0;
  })(),
  "ENOENT is the first fire, not an error — otherwise nothing could ever refuse",
);
check(
  "23c",
  "FAIL-OPEN: a DIRECTORY where the ledger belongs is unreadable, not an empty count",
  (() => {
    const repo = freshRepo();
    fs.mkdirSync(SR._ledgerPath(repo, "sess-1"), { recursive: true });
    return SR.countRefusals(repo, "sess-1", "fixture-guard").ok === false;
  })(),
  "a non-file at the ledger path must not read as zero refusals",
);

// ── 10. the shape gate ────────────────────────────────────────────────────────────────────────

const UNSAFE = [
  ["24a", "a caller-derived boolean instead of the payload", { stopHookActive: false, repoDir: "/tmp", budgetKey: "k" }],
  ["24b", "a caller-derived snake_case flag", { stop_hook_active: false, payload: {}, repoDir: "/tmp", budgetKey: "k" }],
  ["24c", "no payload at all", { repoDir: "/tmp", budgetKey: "k" }],
  ["24d", "a non-object payload", { payload: "yes", repoDir: "/tmp", budgetKey: "k" }],
  ["24e", "an array payload", { payload: [], repoDir: "/tmp", budgetKey: "k" }],
  ["24f", "no repoDir", { payload: {}, budgetKey: "k" }],
  ["24g", "a whitespace-only repoDir", { payload: {}, repoDir: "   ", budgetKey: "k" }],
  ["24h", "no budgetKey", { payload: {}, repoDir: "/tmp" }],
  ["24i", "a path-traversing budgetKey", { payload: {}, repoDir: "/tmp", budgetKey: "../../etc/passwd" }],
  ["24j", "a slash in the budgetKey", { payload: {}, repoDir: "/tmp", budgetKey: "a/b" }],
  ["24k", "a non-integer maxRefusals", { payload: {}, repoDir: "/tmp", budgetKey: "k", maxRefusals: 2.5 }],
  ["24l", "the request itself as an array", []],
  ["24m", "the request itself as a string", "please refuse"],
];
for (const [id, name, shape] of UNSAFE) {
  let threw = false;
  let kind = "";
  try {
    instructAndWait(args({ refuseHandback: shape }));
  } catch (e) {
    threw = e instanceof TypeError;
    kind = e && e.constructor ? e.constructor.name : String(e);
  }
  check(
    id,
    `GATE firing pole: ${name} FAILS TO CONSTRUCT`,
    threw,
    threw ? "TypeError" : `constructed instead of throwing (${kind || "no throw"})`,
    "M-f: assertRefusalShape returns true; M-i: widen the budgetKey regex (24i/24j)",
  );
}
check(
  "26",
  "GATE quiet pole: the SAFE shape does NOT throw — a gate that rejects everything is also broken",
  (() => {
    const repo = freshRepo();
    try {
      instructAndWait(args({ refuseHandback: req(repo) }));
      return assertRefusalShape("Stop", req(repo)) === true;
    } catch {
      return false;
    }
  })(),
  "the control the firing poles above are worthless without",
  "M-f",
);

// ── 11. an UNMEASURED event throws rather than guessing ───────────────────────────────────────

for (const ev of ["SessionEnd", "PreCompact", "PostToolUse", "PreToolUse"]) {
  let msg = "";
  try {
    instructAndWait(args({ hookEvent: ev, refuseHandback: req(freshRepo()) }));
  } catch (e) {
    msg = e && e.message ? e.message : "";
  }
  check(
    `28-${ev}`,
    `SCOPE: opting into refusal at ${ev} THROWS — that arm was never measured`,
    /only supported at hookEvent "Stop"/.test(msg),
    msg ? msg.slice(0, 70) : "did not throw",
  );
}

// ── 12..13. the REAL hook boundary, and isolation ─────────────────────────────────────────────

{
  // The library cases above ALL pass against a hook that never runs — the exact defect that left
  // `dispatch-contract-guard.js` inert while 42 of its library fixtures stayed green. So these
  // drive a real script as a child process, through the real `emit()` (which writes stdout and
  // exits) rather than through `instructAndWait`'s return value.
  const proj = mktmp("stop-refusal-hook-");
  fs.mkdirSync(path.join(proj, ".claude", "hooks"), { recursive: true });
  fs.cpSync(path.join(HOOKS, "lib"), path.join(proj, ".claude", "hooks", "lib"), { recursive: true });
  const hookPath = path.join(proj, ".claude", "hooks", "refusing-guard.js");
  const write = (extra) =>
    fs.writeFileSync(
      hookPath,
      `const { emit } = require("./lib/instruct-and-wait.js");
       let p = {}; try { p = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch {}
       emit({ hookEvent: "Stop", severity: "halt-and-report", what_happened: "condition holds",
              why: "a rule", agent_must_report: ["r"], agent_must_wait: false,
              refuseHandback: { payload: p, repoDir: ${JSON.stringify(proj)}, budgetKey: "e2e" ${extra} } });`,
    );
  const fire = (payload, env) => {
    const r = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, ...(env || {}) },
      cwd: proj,
    });
    let json = null;
    try {
      json = JSON.parse((r.stdout || "").trim().split("\n").pop());
    } catch {}
    return { json, code: r.status, stderr: r.stderr || "" };
  };

  write("");
  const e1 = fire({ session_id: "e2e-1", stop_hook_active: false });
  check(
    "29",
    "E2E firing pole: the REAL hook emits {decision:'block'} on stdout at exit 0",
    e1.json && e1.json.decision === "block" && e1.code === 0 && /HAND-BACK REFUSED/.test(e1.json.reason),
    `exit=${e1.code} keys=${e1.json ? Object.keys(e1.json).join(",") : "PARSE FAILED"}`,
  );
  const e2 = fire({ session_id: "e2e-1", stop_hook_active: true });
  check(
    "29b",
    "E2E WEDGE: the same hook, same condition, refires with the flag set and CANNOT refuse again",
    e2.json && e2.json.continue === true && !("decision" in e2.json) && e2.code === 0,
    `exit=${e2.code} keys=${e2.json ? Object.keys(e2.json).join(",") : "PARSE FAILED"}`,
    "M-b",
  );
  const e3 = fire({ session_id: "e2e-2", stop_hook_active: false }, { COC_STOP_REFUSAL: "0" });
  check(
    "29c",
    "E2E kill switch: COC_STOP_REFUSAL=0 reaches a real child process",
    e3.json && e3.json.continue === true && !("decision" in e3.json),
    `keys=${e3.json ? Object.keys(e3.json).join(",") : "PARSE FAILED"}`,
  );
  // The budget module deleted from the hook's OWN lib copy: refusal is lost, the finding is not.
  fs.rmSync(path.join(proj, ".claude", "hooks", "lib", "stop-refusal.js"));
  const e4 = fire({ session_id: "e2e-3", stop_hook_active: false });
  check(
    "29d",
    "E2E FAIL-OPEN: an unloadable budget module loses the REFUSAL, never the FINDING, and never crashes",
    e4.json &&
      e4.code === 0 &&
      !("decision" in e4.json) &&
      e4.json.continue === true &&
      /WHAT HAPPENED: condition holds/.test(e4.json.systemMessage || ""),
    `exit=${e4.code} keys=${e4.json ? Object.keys(e4.json).join(",") : "PARSE FAILED"}`,
  );
}

{
  // Entries that appeared DURING this run — not entries that merely exist.
  const added = [...readStateDir()].filter((e) => !STATE_DIR_BEFORE.has(e)).sort();
  check(
    "30",
    "ISOLATION: this runner wrote nothing under the repo's real .claude/learning/stop-refusal/",
    added.length === 0,
    added.length
      ? `added during this run: ${added.join(", ")}`
      : `no new entries (${STATE_DIR_BEFORE.size} pre-existing, untouched)`,
  );
}

for (const d of TMPS) {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch {}
}

let failed = 0;
for (const c of cases) {
  const tag = c.pass ? "PASS" : "FAIL";
  if (!c.pass) failed++;
  const line = `${tag}  ${c.id}  ${c.name}  [${c.detail}]\n`;
  if (c.pass) process.stdout.write(line);
  else process.stderr.write(line);
}
process.stdout.write(`\n${cases.length - failed}/${cases.length} cases pass\n`);
process.exit(failed === 0 ? 0 : 1);
