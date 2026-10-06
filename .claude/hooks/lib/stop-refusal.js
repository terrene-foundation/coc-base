#!/usr/bin/env node
/**
 * stop-refusal.js — the LOOP BUDGET behind `instruct-and-wait.js`'s opt-in Stop-handback refusal.
 *
 * WHAT THE HOST ACTUALLY DOES AT `Stop`, MEASURED 2026-08-20 (three arms, one tree, one sandbox
 * project driven by `claude -p` with a single Stop hook whose output was switched by an env var):
 *
 *   arm                                    model output        hook fires   stop_hook_active on refire
 *   ─────────────────────────────────────  ──────────────────  ──────────  ──────────────────────────
 *   control `{}`                           BASELINE_OK         1           —
 *   `{"decision":"block","reason":"…"}`    PROBE_CONTINUED     2           true
 *   `{"continue":false,"stopReason":"…"}`  BASELINE_OK         1           —
 *
 * Read three ways, and each reading is load-bearing here:
 *
 *   (a) `decision:"block"` + `reason` REFUSES THE HAND-BACK. The model emitted a token that
 *       existed ONLY inside `reason`, so `reason` reaches the model AS INSTRUCTION — it is not a
 *       transcript note, it is the next turn's prompt material.
 *   (b) `continue:false` is NOT a continuation mechanism at this event. Its output is
 *       byte-indistinguishable from the control and the hook fired ONCE. Anyone reaching for
 *       `continue:false` to hold a session open is reaching for the arm that measurably does
 *       nothing.
 *   (c) `stop_hook_active` is really in the `Stop` payload and is `true` on the re-invocation that
 *       follows a refusal. Full observed key set: `background_tasks, cwd, effort, hook_event_name,
 *       last_assistant_message, permission_mode, prompt_id, session_crons, session_id,
 *       stop_hook_active, transcript_path`.
 *
 * THE DEFECT THIS REPAIRS. `instruct-and-wait.js` hardcoded `{continue:true}` for every STOP_LIKE
 * event under the comment "these events cannot block tool calls". That sentence is TRUE and
 * ANSWERS A DIFFERENT QUESTION. `Stop` is not a tool call, so of course it cannot block one; it
 * does not follow that `Stop` cannot refuse the hand-back. The library's delivery contract was
 * verified in 2026-06 against the question "which field delivers agent-facing CONTEXT at each
 * event?" — correctly answering `systemMessage` for Stop — and `continue:true` was hardcoded
 * alongside it as though the same verification had settled refusal. It had not.
 * `instrument-discipline.md` MUST-4, inside our own library.
 *
 * WHY THE CAPABILITY IS OPT-IN AND NOT INFERRED FROM SEVERITY. `burndown-quote-stop-guard.js`
 * deliberately emits `severity: "block"` at `Stop`, and both its own header and
 * `burndown-integrity.md` § Trust Posture Wiring go to length insisting that severity is NOT
 * teeth — it records the finding's CLASS. Inferring refusal from `severity === "block"` would
 * silently convert that guard, and `fleet-drain-guard.js`'s "the severity cannot block" is one of
 * THREE things bounding a KNOWN false-positive class there. So refusal is a separate, explicit
 * parameter, defaulted OFF. (Read "and no shipped hook opts in" until 2026-08-27, when the
 *   first producer landed — worktree-conservation-guard.js. The adopter set is DECLARED and
 *   gated by stop-refusal-contract.test.mjs::REFUSAL_ADOPTERS; an undeclared adoption REDS.)
 *
 * FOUR INDEPENDENT LOOP BOUNDS, in the order they fire:
 *
 *   1. `stop_hook_active` — the host's own re-invocation flag. A refusing caller CANNOT construct
 *      the request without handing this module the raw payload it reads the flag from, because
 *      `assertRefusalShape` (in `instruct-and-wait.js`) refuses a caller-derived boolean. This is
 *      the bound that makes the wedge impossible: refuse once, and the refire is suppressed.
 *   2. A per-session, per-key REFUSAL BUDGET (`DEFAULT_MAX_REFUSALS` = 3, hard-capped strictly
 *      BELOW the host's own 8-consecutive-block override). This covers the case bound 1 does not:
 *      a host that resets `stop_hook_active` between turns while the condition persists.
 *   3. The kill switch `COC_STOP_REFUSAL=0|off|false|no`, same shape as `COC_FLEET_DRAIN`.
 *   4. FAIL-OPEN EVERYWHERE. If the budget cannot be READ, cannot be WRITTEN, or this module
 *      cannot be LOADED AT ALL, the answer is DO NOT REFUSE. A refusal we cannot account for is
 *      exactly the wedge, so an unbounded refusal is never preferred to a lost one
 *      (`cc-artifacts.md` Rule 7). The finding still reaches the agent — as today's
 *      `{continue:true, systemMessage}`.
 *
 * WHY WRITE-BEFORE-REFUSE, not refuse-then-record. The counter increment is the ONLY thing that
 * makes bound 2 real. Recording after emitting would mean a crash between the two produces an
 * unbounded refusal that nothing counted; recording first means a failed write degrades to
 * today's behaviour instead. The cost of the safe order is that a refusal which is written but
 * never emitted burns a budget slot. That is the right side to be wrong on.
 *
 * "CONSECUTIVE" IS NOT WHAT THIS COUNTS, and the name says so. `countRefusals` returns refusals
 * THIS SESSION for this key, not a consecutive run, because the library is only ever called on a
 * turn that HAS a finding — a turn where the condition cleared never calls in, so nothing would
 * ever reset the run. `recordHandbackCleared` is exported for a guard that wants to reset
 * explicitly when it observes its own condition clear; nothing in the corpus calls it yet.
 */

"use strict";

const fs = require("fs");
const path = require("path");

/**
 * The host overrides a Stop hook after this many consecutive blocks with no progress (per the
 * hooks guide, which instructs hooks to read `stop_hook_active` and exit early). Our own cap MUST
 * sit strictly below it, so our bound is the one that fires and the host's override is never the
 * thing that rescues a session.
 */
const HOST_OVERRIDE_AFTER = 8;

/** Refusals permitted per session per key before this module stops refusing. */
const DEFAULT_MAX_REFUSALS = 3;

/** Cap on the ledger read, so a runaway sink cannot turn a shutdown hook into an OOM. */
const MAX_LEDGER_BYTES = 256 * 1024;

/** Refusal is only MEASURED at `Stop`. SessionEnd and PreCompact were not probed — see below. */
const REFUSAL_EVENTS = new Set(["Stop"]);

function _isNonEmptyString(v) {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * Kill switch, DEFAULT-ON, `COC_FLEET_DRAIN`'s shape. Default-on is safe here precisely because
 * refusal is opt-in at the call site: "on" means "an opted-in caller may refuse", and no shipped
 * hook opts in.
 */
function resolveRefusalEnabled(env) {
  const e = env || process.env;
  const raw = e.COC_STOP_REFUSAL;
  if (!_isNonEmptyString(raw)) return true;
  return !/^(?:0|off|false|no)$/i.test(raw.trim());
}

/** Clamp a caller-supplied cap into 1..HOST_OVERRIDE_AFTER-1. Garbage falls back to the default. */
function resolveMaxRefusals(requested) {
  if (!Number.isInteger(requested)) return DEFAULT_MAX_REFUSALS;
  if (requested < 1) return 1;
  if (requested >= HOST_OVERRIDE_AFTER) return HOST_OVERRIDE_AFTER - 1;
  return requested;
}

// The ledger is per-REPO state. Adopters hand in `payload.cwd`, which is the
// caller's shell directory — measured: two ledgers written under
// `guides/handbook/.claude/` and under a generated send-bundle, because a
// session happened to be running commands there. Walk up to the nearest
// directory that IS a repo (`.claude/settings.json` or `.git`); fall back to
// the given dir only when no ancestor qualifies.
function _repoRootOf(dir) {
  let cur = path.resolve(String(dir || process.cwd()));
  for (let i = 0; i < 64; i++) {
    try {
      if (fs.existsSync(path.join(cur, ".claude", "settings.json")) || fs.existsSync(path.join(cur, ".git"))) return cur;
    } catch {
      /* unreadable ancestor: keep walking */
    }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return path.resolve(String(dir || process.cwd()));
}

function _ledgerPath(repoDir, sessionId) {
  const raw = _isNonEmptyString(sessionId) ? sessionId : "unknown-session";
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(_repoRootOf(repoDir), ".claude", "learning", "stop-refusal", `${safe}.jsonl`);
}

/**
 * Refusals recorded this session for this key, since the last explicit `cleared` row.
 *
 * FAIL-CLOSED-TO-SAFE, which at this surface means fail-open on the ENFORCEMENT axis: any read
 * failure returns `{ok:false}` and the caller must NOT refuse. An unreadable budget is an
 * UNBOUNDED refusal, which is the wedge itself — so "I could not count" and "the budget is spent"
 * take the same disposition.
 */
function countRefusals(repoDir, sessionId, key) {
  try {
    const p = _ledgerPath(repoDir, sessionId);
    let text = "";
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) return { ok: false, reason: "ledger path is not a file" };
      if (st.size > MAX_LEDGER_BYTES) return { ok: false, reason: "ledger exceeds read cap" };
      text = fs.readFileSync(p, "utf8");
    } catch (e) {
      // A ledger that does not exist yet is a real zero, NOT a read failure. Any other errno is.
      if (!e || e.code !== "ENOENT") {
        return { ok: false, reason: `ledger unreadable: ${e && e.message ? e.message : String(e)}` };
      }
      return { ok: true, count: 0 };
    }
    let count = 0;
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let r = null;
      try {
        r = JSON.parse(line);
      } catch {
        // A torn row cannot be counted and cannot be dismissed either — it may BE a refusal we
        // wrote. Refusing on an unreadable history is the wedge, so the whole read fails.
        return { ok: false, reason: "ledger contains a torn row" };
      }
      if (!r || r.key !== key) continue;
      if (r.verdict === "cleared") count = 0;
      else if (r.verdict === "refused") count += 1;
    }
    return { ok: true, count };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

function _append(repoDir, sessionId, record) {
  try {
    const { appendSinkLine } = require("./append-sink.js");
    const w = appendSinkLine({
      repoDir,
      sinkPath: _ledgerPath(repoDir, sessionId),
      line: JSON.stringify(record),
    });
    return w && w.ok
      ? { ok: true }
      : { ok: false, reason: (w && `${w.error} — ${w.reason}`) || "append failed" };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

/** Burn one budget slot. NEVER throws; a false return means the caller MUST NOT refuse. */
function recordRefusal(repoDir, sessionId, key, nowIso) {
  return _append(repoDir, sessionId, {
    v: 1,
    key,
    verdict: "refused",
    ts: _isNonEmptyString(nowIso) ? nowIso : new Date().toISOString(),
  });
}

/** Reset the budget for a key whose condition the caller has observed to clear. NEVER throws. */
function recordHandbackCleared(repoDir, sessionId, key, nowIso) {
  return _append(repoDir, sessionId, {
    v: 1,
    key,
    verdict: "cleared",
    ts: _isNonEmptyString(nowIso) ? nowIso : new Date().toISOString(),
  });
}

/**
 * The decision. Returns `{refuse, reason, count, max}` and NEVER throws — shape validation is the
 * caller's (`instruct-and-wait.js::assertRefusalShape`) and has already run by the time we are
 * here. `reason` names WHICH bound fired, so a suppressed refusal is legible in a transcript
 * rather than looking like the detector never ran.
 *
 * @param {string} hookEvent
 * @param {{payload: object, repoDir: string, budgetKey: string, maxRefusals?: number,
 *          env?: object, now?: string}} req
 */
function refusalVerdict(hookEvent, req) {
  try {
    if (!REFUSAL_EVENTS.has(hookEvent)) {
      return { refuse: false, reason: "event-not-refusable", count: 0, max: 0 };
    }
    if (!resolveRefusalEnabled(req.env)) {
      return { refuse: false, reason: "kill-switch", count: 0, max: 0 };
    }
    // BOUND 1 — the host's own re-invocation flag. Strict `=== true`: an absent field is a first
    // fire, and a truthy non-boolean is not a signal we will act on.
    if (req.payload.stop_hook_active === true) {
      return { refuse: false, reason: "stop-hook-active", count: 0, max: 0 };
    }
    const max = resolveMaxRefusals(req.maxRefusals);
    const sessionId = _isNonEmptyString(req.payload.session_id)
      ? req.payload.session_id
      : "unknown-session";

    // BOUND 2 — the per-session budget.
    const read = countRefusals(req.repoDir, sessionId, req.budgetKey);
    if (!read.ok) {
      return { refuse: false, reason: `budget-unreadable: ${read.reason}`, count: 0, max };
    }
    if (read.count >= max) {
      return { refuse: false, reason: "budget-exhausted", count: read.count, max };
    }

    // BOUND 4 — write BEFORE refusing (see the header). A budget we could not increment is a
    // refusal nothing bounds.
    const w = recordRefusal(req.repoDir, sessionId, req.budgetKey, req.now);
    if (!w.ok) {
      return { refuse: false, reason: `budget-unwritable: ${w.reason}`, count: read.count, max };
    }
    return { refuse: true, reason: "refused", count: read.count + 1, max };
  } catch (e) {
    // Any unforeseen failure degrades to TODAY'S behaviour, never to a wedge.
    return {
      refuse: false,
      reason: `error: ${e && e.message ? e.message : String(e)}`,
      count: 0,
      max: 0,
    };
  }
}

module.exports = {
  HOST_OVERRIDE_AFTER,
  DEFAULT_MAX_REFUSALS,
  REFUSAL_EVENTS,
  resolveRefusalEnabled,
  resolveMaxRefusals,
  countRefusals,
  recordRefusal,
  recordHandbackCleared,
  refusalVerdict,
  _ledgerPath,
  _repoRootOf,
};
