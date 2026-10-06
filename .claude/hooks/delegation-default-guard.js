#!/usr/bin/env node
/**
 * delegation-default-guard.js — the detector for `orchestrator-context-economy.md` MUST-3
 * ("Delegation Is The DEFAULT, Not An Escalation The Human Requests"), loom#1752.
 *
 * @hook-event: Stop (lifecycle) — THE ONLY SURFACE THAT CAN FIRE ON THIS FAILURE. MUST-5 and
 *   MUST-6 are detected at `PreToolUse:Task|Agent` by `dispatch-contract-guard.js`, which fires
 *   only when a dispatch HAPPENS. MUST-3's failure is the ABSENCE of one: no PreToolUse hook on the
 *   delegation tool can fire on a call that is never made. `SubagentStop` — where the existing
 *   parallelism rider is read — is equally blind for the same reason: no subagent stops in a
 *   session that dispatched none. `Stop` fires at the end of the main agent's turn regardless, so
 *   it is the only event at which a zero-dispatch session is observable at all. Class is
 *   `lifecycle`, not `verification`: `Stop` carries no tool axis, and `hook-event-selection.md`
 *   MUST-3 FAILs a narrow class registered at an event that cannot carry a matcher.
 *
 *   The cost of choosing `Stop` is stated rather than hidden: it is LATE. It fires after the turn's
 *   serial work is already spent, so it recovers the NEXT turn, not this one. The sibling
 *   reconciler's header rejects `Stop` for the DELIVERY question on exactly that ground — and it is
 *   right to, because `SubagentStop` is available to that question. It is not available to this
 *   one. A late advisory on a session that is still running beats a gate-review finding at
 *   `/codify`, which is the only coverage MUST-3 had before this.
 *
 * A THIRD SUBJECT RIDES THE SAME EVENT — `rules/wip-discipline.md` MUST-9 (journal/0607 + 0608
 * item 6): `detectUnderPackedLane` reports a lane the work ledger (`wip-lanes.js::laneDepth`) marks
 * UNDER-PACKED while this session has no ATTRIBUTED dispatch for it. `Stop` is where both of its
 * inputs exist — the session's launch rows and the ledger. Its severity CEILING is `halt-and-report`
 * (a measured zero); an UNATTRIBUTED or UNMEASURED agent count is `advisory`. It composes into the
 * ONE response below and never restates the zero-dispatch fact another arm already states.
 *
 * ITS COST IS BOUNDED, because `laneDepth` spawns git with per-call timeouts longer than this hook's
 * whole budget. It runs in a CHILD of this same file (`--lane-depth-probe`) under a hard
 * `spawnSync` timeout carved from what remains of `TIMEOUT_MS`; a timeout, crash or unparseable
 * reply is a typed UNKNOWN that speaks once per session. It is NOT RUN — silently — when the checkout
 * did not resolve, on a `stop_hook_active` refire, or when no `workspaces/` directory exists (no
 * ledger item can then be bound or queued, so UNDER-PACKED is unreachable). NAMED RESIDUAL: a git
 * process the killed child had already started is reparented and runs to its own timeout.
 *
 * ADVISORY FOR THE DELEGATION ARMS, NEVER BLOCKING ON ANY ARM, AND THAT IS A CAP. The sub-part COUNT is structural — line-anchored
 * list markers, `dispatch-ledger.js::countDeclaredSubparts` — but the proposition ("those parts are
 * INDEPENDENT and should have gone to lanes") is judgment-bearing, so `hook-output-discipline.md`
 * MUST-2 caps the finding below `block`, and a blocking version would be wrong on its merits: the
 * detector cannot distinguish a genuinely-atomic 5-step task from a decomposable one and WILL
 * false-positive on legitimately serial work. `{continue:true}` and exit 0 on EVERY path, including
 * the timeout fallback — a Stop-family hook must never hold up shutdown.
 *
 * NO SECOND COUNT. The declared-vs-dispatched pair is read from `dispatch-ledger.js::reconcile`'s
 * existing `parallelism` rider, not re-derived here. See `lib/delegation-default.js` for why, and
 * for the CALIBRATION NOTE recording which constants are inherited, which is a boundary, and which
 * arm ships OBSERVING because its threshold is uncalibrated.
 *
 * TRI-STATE. ADVISE / OBSERVE / QUIET / UNKNOWN. An absent or unreadable ledger, or an unconfirmed
 * repo root, is UNKNOWN — never silently QUIET. UNKNOWN prints nothing (noise discipline, argued at
 * `formatDelegationAdvisory`) EXCEPT its corrupt/broken-instrument sub-state — a ledger that READ
 * successfully and yielded zero usable rows with `skipped > 0` speaks once per session, because a
 * silently broken detector is indistinguishable from a well-delegating one. That exception is not
 * a softening of the noise rule: no-ledger (fresh clone, CI, pre-first-prompt) stays silent, which
 * is the case the noise rule was written for. Pinned by fixture case 82.
 *
 * RECORDED, because the qualification was once missing and its correction was then BOTCHED. The
 * sentence read as an unqualified 'UNKNOWN prints nothing' and was FALSE from the moment the
 * corrupt state shipped; the edit that qualified it left the '(noise discipline, argued at
 * `formatDelegationAdvisory`)' parenthetical DUPLICATED and a trailing clause — 'but it is a
 * distinct state in the data and is pinned by a fixture' — attached to no subject. Both are
 * removed here; the qualified sentence above is the whole claim.
 *
 * FAILS OPEN ON EVERY UNKNOWN, and resolves the repo root FAIL-CLOSED — reading some other tree's
 * ledger would answer a question about a different session while appearing to answer this one.
 *
 * WRITES ONE THING: a per-session dedupe marker, so a persisting shortfall is surfaced once per
 * measured pair rather than once per assistant turn. Failing to write it costs a repeated line,
 * never a suppressed finding.
 *
 * Origin: loom#1752 — MUST-3 fired again in the session immediately after the rule landed, and the
 * human had to ask twice. See `orchestrator-context-economy.md` § Origin.
 */

"use strict";

// Bounded timer per `cc-artifacts.md` Rule 7, under the registered 5s timeout so this hook's own
// fallback fires first and shutdown is never held up.
const TIMEOUT_MS = 4000;
let fallback = null;

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

/** argv[2] that turns this file into the lane-depth CHILD probe rather than the Stop hook. */
const LANE_DEPTH_PROBE_FLAG = "--lane-depth-probe";
/** Ceiling on the lane-depth probe. The live budget is the SMALLER of this and what remains. */
const LANE_DEPTH_BUDGET_MS = 2500;
/** Held back from `TIMEOUT_MS` so composing and emitting still fit after the probe returns. */
const LANE_DEPTH_SAFETY_MS = 600;
/** Below this there is no honest attempt to make; the arm reports UNKNOWN (no-budget). */
const LANE_DEPTH_MIN_MS = 150;

/**
 * The live probe budget. `COC_LANE_DEPTH_BUDGET_MS` may LOWER the ceiling (an operator on a slow
 * disk, or a fixture driving the timeout pole) and can never raise it.
 */
function laneDepthBudgetMs(startedAt, env) {
  let cap = LANE_DEPTH_BUDGET_MS;
  const raw = env && env.COC_LANE_DEPTH_BUDGET_MS;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    if (n >= 1 && n < cap) cap = n;
  }
  return Math.min(cap, TIMEOUT_MS - (Date.now() - startedAt) - LANE_DEPTH_SAFETY_MS);
}

/**
 * `git worktree list --porcelain` as `{path: branch}`, keyed on both the listed and the resolved
 * path. Read ONLY when a launch row carries a path key, so today it costs nothing. `null` on any
 * failure — the attribution then reads such rows as UNIDENTIFIED, never as zero.
 */
function worktreeBranchMap(repoDir) {
  try {
    const { resolveGitBinary, gitEnv } = require(path.join(__dirname, "lib", "git-subprocess-env.js"));
    const gitBin = resolveGitBinary();
    if (!gitBin) return null;
    const r = spawnSync(gitBin, ["--no-optional-locks", "worktree", "list", "--porcelain"], {
      cwd: repoDir,
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv(),
    });
    if (r.error || r.status !== 0) return null;
    const map = {};
    let wt = null;
    for (const line of String(r.stdout || "").split("\n")) {
      if (line.startsWith("worktree ")) wt = line.slice("worktree ".length);
      else if (line.startsWith("branch refs/heads/") && wt) {
        const b = line.slice("branch refs/heads/".length);
        map[wt] = b;
        try {
          map[fs.realpathSync(wt)] = b;
        } catch {}
      } else if (line === "") wt = null;
    }
    return map;
  } catch {
    return null;
  }
}

/** CHILD MODE: one JSON line `{depth, worktrees}` on stdout, exit 0 on every path. */
function probeMain(argv) {
  const repoDir = argv[3];
  let out;
  try {
    const W = require(path.join(__dirname, "lib", "wip-lanes.js"));
    out = {
      depth: W.laneDepth({ repoDir }),
      worktrees: argv[4] === "1" ? worktreeBranchMap(repoDir) : null,
    };
  } catch (e) {
    out = {
      depth: { ok: false, probe: "threw", reason: `lane-depth probe threw: ${e && e.message ? e.message : String(e)}` },
      worktrees: null,
    };
  }
  try {
    process.stdout.write(JSON.stringify(out) + "\n");
  } catch {}
  process.exit(0);
}

/**
 * The lane-depth arm for this turn. NEVER throws; every failure is a typed verdict.
 *
 * NOT-RUN (silent) when nothing was measured and nothing can be: unresolved checkout, a
 * `stop_hook_active` refire, or no `workspaces/` directory. This arm never refuses the hand-back, so
 * a refire cannot be a loop it drives; skipping it there keeps a refire from paying the probe twice
 * for the turn its first fire already measured.
 */
function laneArm({ lib, ledger, payload, resolved, read, sessionId, startedAt }) {
  try {
    if (!resolved.ok)
      return lib.laneArmNotRun("the main checkout did not resolve, so no ledger was read");
    if (payload && payload.stop_hook_active === true)
      return lib.laneArmNotRun(
        "a stop_hook_active refire — this turn's first Stop fire already evaluated the lanes",
      );
    if (!fs.existsSync(path.join(resolved.repoDir, "workspaces")))
      return lib.laneArmNotRun(
        "no workspaces/ directory, so no ledger item can be bound or queued — UNDER-PACKED is unreachable",
      );
    const rows = read.ok ? read.rows : null;
    const needPaths =
      Array.isArray(rows) &&
      rows.some(
        (r) =>
          r &&
          r.kind === "launch" &&
          lib.LANE_PATH_KEYS.some((k) => typeof r[k] === "string" && r[k].length > 0),
      );
    const budget = laneDepthBudgetMs(startedAt, process.env);
    let depth;
    let worktrees = null;
    if (budget < LANE_DEPTH_MIN_MS) {
      depth = {
        ok: false,
        probe: "no-budget",
        reason: `no-budget: ${Math.max(0, budget)} ms left of this hook's ${TIMEOUT_MS} ms, below the ${LANE_DEPTH_MIN_MS} ms floor`,
      };
    } else {
      const r = spawnSync(
        process.execPath,
        [__filename, LANE_DEPTH_PROBE_FLAG, resolved.repoDir, needPaths ? "1" : "0"],
        {
          encoding: "utf8",
          timeout: budget,
          killSignal: "SIGKILL",
          maxBuffer: 4 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      if (r.error && r.error.code === "ETIMEDOUT") {
        depth = { ok: false, probe: "timeout", reason: `timeout: the lane-depth probe exceeded its ${budget} ms budget and was killed` };
      } else if (r.error) {
        depth = { ok: false, probe: "spawn-failed", reason: `spawn-failed: ${r.error.message || String(r.error)}` };
      } else if (r.status !== 0) {
        depth = { ok: false, probe: "exited", reason: `exited: the lane-depth probe exited ${r.status === null ? `on ${r.signal}` : r.status}` };
      } else {
        try {
          const parsed = JSON.parse(String(r.stdout || "").trim().split("\n").pop());
          depth = parsed && parsed.depth;
          worktrees = parsed && parsed.worktrees ? parsed.worktrees : null;
          if (!depth || typeof depth !== "object")
            depth = { ok: false, probe: "unparseable", reason: "unparseable: the lane-depth probe returned no depth report" };
        } catch {
          depth = { ok: false, probe: "unparseable", reason: "unparseable: the lane-depth probe's reply was not JSON" };
        }
      }
    }
    return lib.detectUnderPackedLane({
      depth,
      rows,
      failure: read.ok ? undefined : read,
      skipped: read.ok ? read.skipped : 0,
      sessionId,
      worktreeLanes: worktrees,
    });
  } catch (e) {
    return lib.detectUnderPackedLane({
      depth: { ok: false, probe: "threw", reason: `threw: ${e && e.message ? e.message : String(e)}` },
      rows: null,
    });
  }
}

function finish() {
  if (fallback) clearTimeout(fallback);
  try {
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  } catch {}
  process.exit(0);
}

/**
 * Resolve the main checkout FAIL-CLOSED, the same discipline `reconcile-dispatch-delivery.js`
 * applies: an indeterminate resolution yields UNKNOWN without reading anything, because a verdict
 * derived from a tree we could not confirm is a confident wrong answer.
 */
function requireMainCheckoutSafely(repoDir) {
  try {
    const { requireMainCheckout } = require(
      path.join(__dirname, "lib", "state-resolver.js"),
    );
    return requireMainCheckout(repoDir);
  } catch (e) {
    return {
      ok: false,
      reason: `state-resolver unavailable: ${e && e.message ? e.message : String(e)}`,
    };
  }
}

async function main() {
  const startedAt = Date.now();
  fallback = setTimeout(() => {
    try {
      process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    } catch {}
    process.exit(0);
  }, TIMEOUT_MS);

  try {
    // `readStdinBounded()` resolves the PARSED payload — NOT raw text. Calling JSON.parse() on it
    // is the bug that made `dispatch-contract-guard.js` silently inert while all 42 of its library
    // fixtures stayed green; the end-to-end cases in this detector's fixture set exist so the same
    // seam cannot regress here unobserved.
    const payload = await readStdinBounded();
    const ledger = require(path.join(__dirname, "lib", "dispatch-ledger.js"));
    const lib = require(path.join(__dirname, "lib", "delegation-default.js"));

    // ONE derivation, shared with the producer and with both path mappers
    // (`dispatch-ledger.js::resolveSessionId`). The consumer MUST resolve exactly what the
    // producer resolved or it reads a file that was never written.
    const sessionId = ledger.resolveSessionId(payload && payload.session_id);
    const resolved = requireMainCheckoutSafely(PROJECT_DIR);

    const read = resolved.ok
      ? ledger.readLedger({ repoDir: resolved.repoDir, sessionId })
      : {
          ok: false,
          reason:
            `the main checkout could not be resolved (${resolved.reason}), so no ledger was read — ` +
            "delegation status is UNKNOWN for this session, not clean.",
        };

    // BACKWARD COMPATIBILITY BREADCRUMB — the pre-fix POOLED sink, named rather than orphaned.
    //
    // Before 2026-09-01 every id-less session wrote into one `unknown-session-<hash>.jsonl`. Those
    // rows are a POOL of one or more sessions, indistinguishable by construction, so no derived
    // identity adopts them: attributing them to whichever session runs next would import another
    // session's history — the same defect wearing a new name. They stay READABLE at the unchanged
    // path (`ledger.legacyAnonSinkPath(repoDir)`), and this line makes the non-adoption VISIBLE,
    // because a silent orphan and a correctly-empty ledger render identically.
    //
    // Gated twice so it cannot become wallpaper: only on the derived-anonymous rung (rare — every
    // live sink on this checkout carries a real session UUID), and once per session through the
    // SAME dedupe marker the advisories use.
    if (resolved.ok && sessionId.startsWith(`${ledger.ANON_SESSION_PREFIX}-`)) {
      try {
        const legacy = ledger.legacyAnonSinkPath(resolved.repoDir);
        const sig = "legacy-anon-sink";
        if (fs.existsSync(legacy) && !lib.alreadySurfaced(resolved.repoDir, sessionId, sig)) {
          lib.markSurfaced(resolved.repoDir, sessionId, sig);
          process.stderr.write(
            `delegation-default.legacy-anon-sink retained=${legacy} adopted=no ` +
              `reason=pre-2026-09-01 rows pool multiple sessions and cannot be attributed\n`,
          );
        }
      } catch {}
    }

    // TWO ORTHOGONAL ARMS, read from ONE ledger read.
    //
    //   PER-PROMPT   `assessFromLedger` — the last prompt's enumerated sub-parts vs the lanes that
    //                followed it. QUIET at `declared: 0`, by its own contract.
    //   SESSION      `assessSessionVolume` — consecutive prompts with no lane at all, regardless of
    //                whether any prompt enumerated anything. This is the arm that sees the
    //                open-ended-directive case the per-prompt arm is structurally silent on; the
    //                library header carries its calibration.
    //
    // They are combined, not chosen between: a session can be BOTH one lane short on this prompt and
    // twelve prompts into a serial stretch, and suppressing either would hide a real finding. Each
    // dedupes on its OWN signature, so one arm re-speaking never re-emits the other.
    const verdict = lib.assessFromLedger(
      read.ok ? read.rows : null,
      read.ok ? undefined : read,
      ledger.reconcile,
    );
    // `read.skipped` is threaded IN rather than re-derived: `readLedger` already counts the lines
    // that did not parse into a usable record, and it is the only signal that separates "the ledger
    // was never written" (silent, by noise discipline) from "the ledger was read and NOTHING in it
    // parsed" (a broken detector, which must speak — otherwise its output is byte-identical to a
    // well-delegating session). Nothing is re-read here; this is the same single ledger read.
    const volume = lib.assessSessionVolume(
      read.ok ? read.rows : null,
      read.ok ? undefined : read,
      read.ok ? read.skipped : 0,
      // The session fence, WIRED here because this is its only production call site — an unwired
      // 4th argument makes the fence inert while every library fixture that supplies its own stays
      // green (fixture case 89, mutation M-y).
      //
      // WHAT IT DOES, restated 2026-09-01 when the pooling hazard was CLOSED at the producer.
      // The two prior revisions of this comment are both superseded, and the sequence is kept
      // because it is the whole argument: it first claimed passing the fence made the docblock
      // "TRUE rather than aspirational" (false — the fence could not see the only reachable
      // pooling shape), then correctly WITHDREW that. Neither is the current state. The literal
      // `"unknown-session"` is gone from every one of the five sites that carried it, so two
      // id-less sessions now resolve to DIFFERENT ids (`dispatch-ledger.js::resolveSessionId`)
      // and land in different sinks. The fence is therefore load-bearing here in the ordinary
      // way: any foreign row it sees is genuinely another session's and is genuinely dropped.
      // Bounded honestly — the fence is the SECOND line, not the first. The first is that the
      // sinks no longer collide at all; the fence still cannot rescue a file whose rows are
      // byte-identical in the only field that identifies them, and that is now unreachable rather
      // than merely unlikely.
      sessionId,
    );

    const surfaceable = (f) =>
      f.text && f.sig && !(resolved.ok && lib.alreadySurfaced(resolved.repoDir, sessionId, f.sig));
    const findings = [
      { arm: "per-prompt", text: lib.formatDelegationAdvisory(verdict), sig: lib.signatureOf(verdict) },
      { arm: "session-volume", text: lib.formatSessionVolumeAdvisory(volume), sig: lib.sessionVolumeSignatureOf(volume) },
    ].filter(surfaceable);

    // THE LANE-DEPTH ARM, composed LAST so it can refer to what is already in this response. Its
    // zero-dispatch fact is the SAME fact the per-prompt and session-volume arms state when either
    // fires on zero dispatches, so it is handed WHICH arm (if any) is stating it in THIS emission —
    // a deduped arm states nothing now and cannot be referred to.
    const laneVerdict = laneArm({ lib, ledger, payload, resolved, read, sessionId, startedAt });
    const zeroDispatchStatedBy =
      findings.some((f) => f.arm === "per-prompt") && verdict.state === "ADVISE" && verdict.dispatched === 0
        ? "per-prompt"
        : findings.some((f) => f.arm === "session-volume") && volume.state === "ADVISE" && volume.dispatched === 0
          ? "session-volume"
          : null;
    const laneFinding = {
      arm: "lane-depth",
      text: lib.formatUnderPackedLaneFinding(laneVerdict, { zeroDispatchStatedBy }),
      sig: lib.underPackedSignatureOf(laneVerdict),
    };
    if (surfaceable(laneFinding)) findings.push(laneFinding);

    if (findings.length > 0) {
      const advisory = findings.map((f) => f.text).join("\n\n");

      // ORDERING IS LOAD-BEARING, corrected 2026-08-31 after an adversarial round measured the
      // inversion. `markSurfaced` used to run HERE, before the emitter was known to be loadable.
      // `emit()` owns stdout and EXITS, so nothing can run after it — which is why marking was
      // hoisted above it in the first place. But that made a `require` failure consume the dedupe:
      // the advisory fell back to stderr (which this file argues below "reaches the terminal ONLY"
      // and so "has never once reached the party that could act on it"), while both signatures were
      // already marked, suppressing the finding for the REST OF THE SESSION even once the module
      // became readable again. That is the exact opposite of the direction the library states at
      // `delegation-default.js::markSurfaced` — "FAILS OPEN ... a lost dedupe costs one repeated
      // line, a wrongly-suppressed advisory costs the whole finding".
      //
      // Resolving the emitter FIRST closes it: the require either succeeds (and marking is
      // immediately followed by an emit that cannot fail-and-return, because it exits) or it throws
      // BEFORE anything is marked, so the stderr fallback leaves the finding live for the next turn.
      // The residual window is the emit call itself, which does not return.
      let emit = null;
      try {
        ({ emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js")));
      } catch {
        emit = null;
      }

      if (resolved.ok && emit)
        for (const f of findings)
          lib.markSurfaced(
            resolved.repoDir,
            sessionId,
            f.sig,
            new Date().toISOString(),
          );
      // SUPERSEDED 2026-08-27 — this branch was stderr-ONLY, under the comment "a Stop-family
      // hook's stdout carries the protocol payload; the advisory is a breadcrumb". The first
      // clause is true and the conclusion does not follow: at `Stop` the protocol payload IS the
      // agent-facing channel (`instruct-and-wait.js` delivery contract — top-level
      // `systemMessage`), and stderr reaches the terminal ONLY. So the finding was written where
      // the agent could never read it, which for a guard whose whole subject is "you did not
      // delegate" means it has never once reached the party that could act on it.
      //
      // Routed through the SHARED emitter, which serves BOTH readers from one call: `user_summary`
      // to stderr for the human, and the structured body to stdout for the agent. That also earns
      // the delivery-channel block `hook-output-discipline.md` MUST-7 mandates, which a hand-rolled
      // write does not carry.
      //
      // `advisory`, NOT a hand-back refusal, and the reason is this guard's own recorded limit:
      // `orchestrator-context-economy.md` states its independence judgment false-positives on
      // legitimately serial work. On a false positive the agent CANNOT clear the finding, so a
      // refusal would spend the budget and hand back anyway — the case the refusal producer test
      // in `worktree-conservation-guard.js` explicitly bars. It therefore passes NO refusal
      // parameter at all, and `stop-refusal-contract.test.mjs::REFUSAL_BARRED` pins that.
      // (The literal parameter name is deliberately NOT written anywhere in this file: that
      // suite's barred arm greps for the token, and it is literal ON PURPOSE — a matcher
      // clever enough to tell a USE from a MENTION would be the lexical-detector trap
      // `hook-output-discipline.md` MUST-5 forbids. Naming it here would red the gate.)
      // COMPOSITION. When only the delegation arms speak, every field below is BYTE-IDENTICAL to what
      // this guard emitted before the lane-depth arm existed. The lane arm adds its own `why`,
      // report items and wait line, and raises severity to `halt-and-report` ONLY for a measured
      // zero — still no refusal, on any arm, for the reason recorded above.
      const hasDelegation = findings.some((f) => f.arm !== "lane-depth");
      const hasLane = findings.some((f) => f.arm === "lane-depth");
      const DELEGATION_WHY =
        "orchestrator-context-economy.md MUST-3 — delegation is the DEFAULT, not an escalation the human requests; " +
        "a decomposable input executed inline caps throughput at the operator's attention";
      const LANE_WHY =
        "rules/wip-discipline.md MUST-9 — a lane is a mini-orchestrator: the WIP ceiling counts worktrees and branches, " +
        "never agents, so a lane run as one serial worker while items queue spends a whole slot on one agent";
      const DELEGATION_WAIT =
        "This is advisory and can false-positive on legitimately serial work — say which it is rather than silently accepting it.";
      const LANE_WAIT =
        "The hand-back is NOT refused. Report the lane finding before re-planning; a lane driven by another session, or whose work is genuinely serial, is a legitimate answer — say which.";
      try {
        if (!emit) throw new Error("emitter unavailable");
        emit({
          hookEvent: "Stop",
          severity:
            hasLane && laneVerdict.state === "REPORT" && laneVerdict.severity === "halt-and-report"
              ? "halt-and-report"
              : "advisory",
          what_happened: advisory,
          why: [hasDelegation ? DELEGATION_WHY : null, hasLane ? LANE_WHY : null].filter(Boolean).join(" · ALSO: "),
          agent_must_report: [
            ...(hasDelegation
              ? [
                  "State which arm fired and its measured figures (the declared-vs-dispatched pair, and/or the count of consecutive prompts with zero lanes), then either dispatch the independent work or say in one line why it is genuinely serial.",
                  "If your session instructions forbid spawning agents, say so explicitly to the operator in this turn — that constraint conflicts with this repo's delegate-first posture and the operator may not know it is in force.",
                ]
              : []),
            ...(hasLane
              ? laneVerdict.state === "UNKNOWN"
                ? [
                    "State that lane depth was UNKNOWN at turn end and why — never that no lane is under-packed.",
                  ]
                : [
                    "Name each UNDER-PACKED lane, its item count, the QUEUED count, and whether this session's agent count for it was a measured zero, UNATTRIBUTED or UNMEASURED.",
                    "Then dispatch agents inside that lane under the partition contract, bind queued items to it, or say in one line why it is genuinely serial or driven by another session.",
                  ]
              : []),
          ],
          agent_must_wait: [hasDelegation ? DELEGATION_WAIT : null, hasLane ? LANE_WAIT : null]
            .filter(Boolean)
            .join(" "),
          user_summary: advisory.split("\n")[0].slice(0, 160),
        });
        return; // emit() owns stdout and exits; never also call finish().
      } catch {
        // Fail OPEN to the pre-existing behaviour rather than losing the finding entirely.
        try {
          process.stderr.write(advisory + "\n");
        } catch {}
      }
    }

    finish();
  } catch {
    finish();
  }
}

/**
 * Detector entry — the Stop hook run. Exported so the hook engine can run it in-process
 * (`lib/hook-engine.js`); the CLI entry below calls the same function.
 *
 * ENGINE RESIDUAL, swept: in-engine `process.exit()` throws, so a catch enclosing an exit runs.
 * The ones in `main()` that can — around `emit()` and the outer one — only write output and call
 * `finish()` (clearTimeout + output + exit). Every dedupe-marker write happens BEFORE `emit()`,
 * outside any catch an exit can reach. `probeMain`'s exit is enclosed by no catch.
 */
function hookMain() {
  return main();
}

module.exports = { hookMain };

// CLI entry. The lane-depth CHILD (`--lane-depth-probe`) is not a hook run: it is this file
// spawned by `laneArm` with its own argv and no hook payload, so it is dispatched FIRST and never
// replayed through the engine (whose `process.argv` is `[execPath, file]`, which would drop the
// flag and run the Stop hook inside the probe). Otherwise the default path is exactly hookMain() —
// no engine dependency — and the selftest path replays the run through the in-process engine
// (hook-engine.js::runCli).
if (require.main === module) {
  if (process.argv[2] === LANE_DEPTH_PROBE_FLAG) probeMain(process.argv);
  else if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
