#!/usr/bin/env node
/**
 * wip-discipline-guard.js — unlanded work is inventory, and inventory is waste.
 * This surfaces it at the two moments it is still cheap to act on: when a lane
 * is about to be OPENED, and when the session starts and the standing forest is
 * visible.
 *
 * @hook-event: PreToolUse:Bash (guard) — the door lanes actually come through,
 *   and the ONLY one this ceiling is registered at. Both axes (COUNT, MUST-2 and
 *   AGE, MUST-3) are decided here, on the SAME arm. `git worktree add`, `git
 *   switch -c`, `git checkout -b` and `git branch <name>` each open a lane, and
 *   none is a Task. The subject is the lane ABOUT to be opened, which exists
 *   only as the pending call: no later event can refuse it before it exists
 *   (PostToolUse would report an opening that already happened), and no earlier
 *   one knows it is coming.
 *
 *   A `PreToolUse:Task|Agent` arm was registered here until 2026-08-29 and is
 *   REMOVED — the REGISTRATION went then (`b77a71603`), and the CODE went on
 *   2026-09-14. Between those two dates this file still carried
 *   `if (tool === "Task" || tool === "Agent")` in `run()` while no matcher
 *   delivered either name, so the arm read as live enforcement and could not
 *   fire; `.claude/test-harness/tests/hook-matcher-coherence.test.mjs` is the
 *   detector that found it and now holds this file to the agreement. It predated
 *   the Bash arm and used agent-spawn as a PROXY for
 *   lane-opening; the proxy was measurably wrong. MEASURED: 33 worktrees and 43
 *   branches accumulated against a limit of 5 while the ceiling refused
 *   NOTHING, because essentially every lane was opened from Bash and the spawn
 *   arm was the only one registered. So that arm never once caught inventory —
 *   it only ever refused WORKERS.
 *
 *   That distinction is the reason for its removal, not merely its
 *   ineffectiveness. This ceiling bounds INVENTORY (unlanded branches and
 *   worktrees — what Little's Law bounds). An agent dispatch creates no branch,
 *   no worktree and no unlanded commit, so charging it against this counter
 *   throttled the delegate-first posture `agents.md` § Triad mandates, making
 *   the correct move cost the same as the costly one. A subagent that DOES open
 *   a lane does it through its own Bash call and is caught by this arm exactly
 *   as the orchestrator's is, wherever hooks propagate into subagent tool calls.
 * @hook-event: SessionStart (lifecycle) — the subject is the set of branches and
 *   worktrees on disk, which exists BEFORE the session's first tool call. That
 *   is what makes SessionStart correct here rather than the default-drift
 *   `hook-event-selection.md` MUST-2 blocks: this is not verification of work
 *   the session will produce, it is a report of durable state already present.
 *
 * NOT Stop. Stop fires every turn; a standing-inventory report that repeats
 * after every turn is the noise that taught the previous surface's reader to
 * ignore it (loom#1885, measured 63% noise). Once per session is the correct
 * cadence for a figure that changes a handful of times a day.
 *
 * SEVERITY — `block` at the SPAWN arm; `halt-and-report` at SessionStart.
 *
 *   THE SPAWN ARM CARRIES TWO AXES, NOT ONE (2026-09-06). COUNT (MUST-2) and AGE
 *   (MUST-3) are independent: a repo at TWO lanes and THREE DAYS passes every
 *   count this ceiling measures and is exactly the state MUST-3 — titled "AGE
 *   Governs, Not COUNT" — calls a defect. So the age door is evaluated BEFORE the
 *   count's under-limit early return, and refuses lane CREATION while any lane's
 *   MEASURED unlanded content is past the 24 h bound.
 *
 *   WHY IT GREW TEETH. Age was carried at SessionStart alone, at
 *   `halt-and-report`. MEASURED: `chore/handbook-authz-receipt` was named in that
 *   report at every session start for three days and dispositioned at none —
 *   the same "a ceiling that reports is not a ceiling" finding the count door
 *   recorded in 2026-08-23, now on the axis the rule says GOVERNS. Age was the
 *   one axis with a report and no door.
 *
 *   ITS `block` RESTS ON THE SAME CLASS OF FACT. `confirmAgedLane` fires only for
 *   a lane whose unlanded commits were MEASURED — by the recorded landing
 *   provenance (`Landed-From` trailers, `lib/landed-map.js`) FIRST, and by
 *   `git cherry` (patch-id absent at the base) only where that record falls
 *   back — AND whose oldest such commit carries a readable COMMITTER DATE. A
 *   committer date is a git-object fact, not a lexical inference — which is the
 *   narrow class `hook-output-discipline.md` MUST-2 reserves `block` for. It is
 *   deliberately NOT the tip date (a lower bound that would miss the very lane
 *   above) and NEVER directory mtime, whose only error direction is making rot
 *   look fresh (MUST-3: a 44 h tree read as 11.1 h).
 *
 *   ONE OVERRIDE CHANNEL COVERS BOTH DOORS. The age refusal routes through the
 *   SAME one-shot receipt and the SAME env var, so a bypass is recorded exactly
 *   once and in one place; minting a second channel for the second axis would
 *   have given the operator two ways out where the audit trail expects one.
 *
 *   AND IT FAILS OPEN ON EVERY UNKNOWN, exactly as the count door does: an
 *   unanswerable `git cherry`, an unreadable committer date, or an exhausted
 *   scan budget all yield no refusal. A guard that cannot answer must not
 *   manufacture a block.
 *
 *   THE SPAWN ARM HAS TEETH, and it did not until 2026-08-23. Every arm here
 *   returned `{continue:true}`; the surface NOTIFIED and never prevented.
 *   MEASURED against the most rule-aware actor in the system: an orchestrator
 *   opened six-plus lanes past the limit, acknowledged this guard's finding
 *   EVERY time, and proceeded — the open-lane count went 109 → 112 WHILE the
 *   guard was firing. Against the origination evidence (53 worktrees / 306
 *   branches accumulated against no limit at all), an advisory is the instrument
 *   that has now failed twice. MUST-2 of `wip-discipline.md` claims to be "the
 *   only one that stops it being created"; before this change that sentence was
 *   false, and a rule whose text over-claims its own mechanism is the
 *   `zero-tolerance.md` Rule 3e prose-vs-code drift class.
 *
 *   WHY `block` IS PERMITTED. `hook-output-discipline.md` MUST-2 reserves
 *   `block` for a structural fact a regex cannot misread and forbids it for
 *   lexical matches over prose. The lane count is derived from GIT REFS —
 *   `for-each-ref` output, the `Landed-From` trailers on the trunk's commits
 *   (landing provenance, consulted FIRST) and `git cherry` patch-ids (only
 *   where no provenance record applies). It is a git-object fact,
 *   not a lexical inference: there is no prose read, no shell string expanded,
 *   and no paraphrase of the dispatch that opens a lane while evading the count.
 *
 *   WHAT ANSWERS MUST-2'S OWN MUST NOT ("detectors that block work the agent has
 *   been instructed to perform"). The prior text refused teeth on the grounds
 *   that whether a lane should open is the operator's JUDGMENT. That objection
 *   is real and is RESOLVED, not dismissed, by the OVERRIDE RECEIPT below: the
 *   operator's judgment becomes an explicit, recorded, one-shot act instead of a
 *   silently-ignored banner. The cost asymmetry is one-directional — a false
 *   positive costs ONE receipt file written in the same turn; a false negative
 *   costs another lane on a forest already measured at 112.
 *
 *   THE BLOCK IS TAKEN ON A LOWER BOUND, NEVER THE UPPER ONE. `laneCountFast` is
 *   ancestry-unmerged and OVER-reports (a rebased branch reads open). That is
 *   fine for a report and unacceptable for a refusal, so the block requires
 *   `confirmAtLimit` — at least WIP_LIMIT lanes whose unlanded content `git
 *   cherry` MEASURED. Upper bound ≥ limit but content unconfirmed ⇒ the REPORT
 *   fires and the teeth do NOT. Over-blocking on the bound's slack is therefore
 *   impossible by construction.
 *
 *   OVERRIDE — two channels, both audited. The MECHANISM is not this file's: it
 *   is `lib/override-receipt.js`, the SHARED gate `nested-worktree-guard.js` and
 *   `dispatch-contract-guard.js` also consume. This guard shipped a hand-written
 *   copy of it on 2026-08-23 only because the lane that built it ran before the
 *   library existed; converged 2026-08-23 so the four audited-override properties
 *   have ONE implementation. Local here is CONFIG only — which receipt path,
 *   which env var, which roots to search, and what this guard's advisory says:
 *     1. RECEIPT (agent-reachable, ONE-SHOT). A non-empty reason written to
 *        `.claude/wip-authz/wip-limit-allow`, then re-issue the call. The hook
 *        CONSUMES (deletes) it as it honours it, so an override cannot silently
 *        disarm the gate for later calls, and the reason is echoed back.
 *     2. ENV `COC_ALLOW_WIP_OVERRUN=1` (operator / CI). NOT settable mid-session
 *        — a hook inherits the CLI parent's environment and a Bash `export` dies
 *        with the child shell — so it is for harnesses and whole-run operator
 *        intent. The RECEIPT is the channel that actually answers the MUST NOT.
 *   Both emit an `advisory` through the canonical `emit()` shape, so the notice
 *   lands in `hookSpecificOutput.additionalContext` — the only agent-visible
 *   channel at a non-blocking PreToolUse — and an override is never silent.
 *
 *   SessionStart keeps `halt-and-report` for an aged lane. Its subject is the
 *   STANDING forest, not a pending action; there is nothing there to refuse.
 *   Every session ALSO receives the lane contract and the per-lane depth report
 *   (`runSessionStart`) — at `advisory` when no lane is aged, riding inside the
 *   `halt-and-report` body when one is. Never `block`.
 *
 * THE MESSAGE CARRIES THE DISPOSITION, NOT JUST THE FINDING. `wip-discipline.md`
 * is path-scoped, so in a session editing only `src/` the rule TEXT is not
 * loaded and this hook is the only carrier. A report that names a problem
 * without naming the two legal outcomes (LAND or KILL) would leave the agent
 * knowing something is wrong and not what to do — which is how the previous
 * surface produced 99 branches nobody dispositioned.
 *
 * FAIL-OPEN. Every error path emits `{continue:true}` and exits 0/1
 * (`cc-artifacts.md` Rule 7). A detector that can wedge a session is worse than
 * the inventory it reports.
 */

"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

/** The wait-for-stdin bound. Fixed: no payload has arrived, so nothing is tunable yet. */
const TIMEOUT_MS = 8000;

/**
 * The accumulation bound for the OPTIONAL half of the SessionStart decision.
 *
 * SEPARATE FROM `TIMEOUT_MS` ON PURPOSE, and the two are not interchangeable: that
 * one bounds the wait for stdin (the only window a timer callback has, since
 * `run()` never unwinds the stack once it starts), this one bounds the git work
 * AFTER the payload is in hand. A single knob for both raced them — MEASURED: at a
 * shared 50 ms the process timer beat stdin delivery and the guard emitted a bare
 * `{continue:true}`, which is the silence this whole change removes.
 *
 * `COC_WIP_GUARD_TIMEOUT_MS` is a TEST SEAM, clamped to [50, 30000]. The branch it
 * governs is ADVISORY and emits `continue:true` on every path, so no value of it
 * unblocks a call the guard would otherwise refuse — the worst a hostile value
 * buys is a session that gets the lane contract WITHOUT the depth report, strictly
 * more conservative than the silence it replaced. Without a seam the branch is
 * unreachable from a fixture: `resolveGitBinary` prefers absolute candidates over
 * `PATH`, so no shim can make git hang.
 */
function _depthBudgetMs() {
  const raw = Number.parseInt(process.env.COC_WIP_GUARD_TIMEOUT_MS || "", 10);
  if (!Number.isFinite(raw)) return TIMEOUT_MS;
  return Math.min(30000, Math.max(50, raw));
}
const DEPTH_BUDGET_MS = _depthBudgetMs();

/**
 * FORCED-DEADLINE SEAM — the deterministic way to reach the timed-out branch.
 *
 * WHY THIS EXISTS RATHER THAN A TINY BUDGET. `COC_WIP_GUARD_TIMEOUT_MS` is
 * CLAMPED to a 50 ms floor, so a fixture asking for `1` gets 50, and the pole
 * then asserts "the lane survey takes longer than 50 ms ON THIS HOST". That is
 * a claim about the machine, not about the guard, and `testing.md` § "Never
 * Assert An UPPER Bound On Real Elapsed Time" blocks it by name: the prescribed
 * shapes are a virtual clock, an INJECTED clock, or poll-to-a-ceiling — never a
 * fixed budget raced against real work.
 *
 * MEASURED, which is how it was found: the pole passed on darwin (a local
 * checkout whose survey exceeds 50 ms) and FAILED on the CI runner, whose fresh
 * shallow checkout has almost nothing to enumerate and finishes inside the
 * floor, delivering the FULL report. Same code, same fixture, opposite verdict,
 * decided entirely by host speed.
 *
 * SAFETY IS UNCHANGED, and the argument is the same one `_depthBudgetMs` makes:
 * this seam only ever REMOVES the depth report from an ADVISORY response that
 * emits `continue:true` on every path, so no value of it unblocks a call the
 * guard would otherwise refuse. The worst a hostile value buys is a session that
 * gets the lane contract WITHOUT the depth report — strictly more conservative
 * than the silence it replaced.
 */
function _forceDepthTimeout() {
  const raw = (process.env.COC_WIP_GUARD_FORCE_DEPTH_TIMEOUT || "").trim();
  return raw === "1" || raw.toLowerCase() === "true";
}
const FORCE_DEPTH_TIMEOUT = _forceDepthTimeout();

/**
 * THE STDIN-STALL FALLBACK. It is ONLY that, and the bound is enforced a second
 * time INSIDE the decision (`runSessionStart`) because — MEASURED on this tree,
 * not assumed — this timer CANNOT fire once `run()` has started.
 *
 * The correction that measurement forced: the note that used to sit at the stdin
 * handler claimed "`spawnSync` BLOCKS the event loop, so the timer cannot fire
 * DURING a git call — it fires in the gaps BETWEEN them". The second half is
 * false. `run()` is synchronous end to end, so the stack never unwinds between
 * git calls and no timer callback is ever scheduled; the falsifying run: three
 * SessionStart invocations at `COC_WIP_GUARD_TIMEOUT_MS` of 300 / 900 / 1500 ms
 * each took 4–5 s of wall clock and every one exited 0 with the FULL report, and
 * the same payload at 50 ms exited 1 with a bare `{continue:true}` — the timer
 * beating stdin, the only window it has. A slow survey therefore never reached
 * this callback at all; it ran to completion or was killed by the HOST, which
 * produces no output whatsoever. That is why the contract is delivered from the
 * DEADLINE CHECK in `runSessionStart` and not from here.
 */
let _timeout = null;

function passthrough() {
  clearTimeout(_timeout);
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

let _libLoadFailed = false;
let emit,
  L,
  resolveGitBinary,
  gitEnv,
  safeField,
  createOverrideGate,
  readReceiptText;
try {
  ({ emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js")));
  L = require(path.join(__dirname, "lib", "wip-lanes.js"));
  ({ resolveGitBinary, gitEnv } = require(
    path.join(__dirname, "lib", "git-subprocess-env.js"),
  ));
  // The two-channel audited override is SHARED, not local. This guard shipped its own
  // hand-written copy of the mechanism — candidate resolution, the literal-"1" env read,
  // the read/trim/unlink consumption, the reason sanitizer — because the lane that built
  // it ran BEFORE `lib/override-receipt.js` existed to consume. Two copies of a gate's
  // ESCAPE HATCH is worse than two copies of a parser: when they drift, one gate's
  // override behaves differently from the other's and the divergence is invisible until
  // someone relies on the wrong one. What stays local below is CONFIG (which receipt path,
  // which env var, which roots to search, what the advisory says) — never mechanism.
  // `readReceiptText` comes from the SAME module for the same reason: the non-destructive
  // PEEK and the destructive CONSUME must read a receipt identically, or the hardening
  // holds at one end only.
  ({ safeField, createOverrideGate, readReceiptText } = require(
    path.join(__dirname, "lib", "override-receipt.js"),
  ));
} catch {
  // Deferred to hookMain(): a require() of this file must have no side effects,
  // so the load failure is recorded here and the passthrough() it used to run at
  // load time runs as hookMain()'s first act after the fallback timer is armed —
  // the same position it held in the old top-to-bottom load order.
  _libLoadFailed = true;
}

// ── THE HARDENED APPEND PRIMITIVE ───────────────────────────────────────────
//
// REQUIRED SEPARATELY from the block above, and the separation is load-bearing in
// BOTH directions.
//
// Not in that block, because it ends in `passthrough()`: a bookkeeping dependency
// failing to load would then disable the WIP ceiling entirely for every dispatch.
// The override LEDGER is audit-only; the GATE is not. A missing sink writer must
// never be a wider gate than a present one — the same asymmetry the capability
// predicate below is separated for.
//
// Not tolerated by falling back to `fs.appendFileSync` either. That bare idiom is
// exactly what loom#1349 extracted this module to delete, and a "temporary"
// fallback would re-introduce the symlink-followed, world-readable write on the
// one path least likely to be exercised. On a load failure the primitive is null
// and `recordOverride` SKIPS the row — which is precisely the failure direction
// that function already had (`a failed write costs an audit row, never a session`).
let appendSinkLine = null;
try {
  ({ appendSinkLine } = require(path.join(__dirname, "lib", "append-sink.js")));
} catch {
  appendSinkLine = null;
}

// THE LANE-OPENING CAPABILITY PREDICATE IS GONE, WITH THE ARM IT SERVED.
//
// `lib/lane-opening-capability.js` existed to answer "can THIS DISPATCH open a
// lane?" for the `PreToolUse:Task|Agent` arm. That arm was deregistered on
// 2026-08-29 (`b77a71603`, "the ceiling counts INVENTORY, not WORKERS") and the
// arm's code is removed here; the predicate had no other consumer, so it is
// deleted rather than left orphaned. A dispatch reaches this ceiling only by the
// route every other actor takes — its own `Bash` call — and is counted there.
//
// ── OVERRIDE CHANNEL CONFIG (mechanism: lib/override-receipt.js) ─────────────
//
// Channel 2 — operator / CI env. NOT settable mid-session.
const ESCAPE_ENV = "COC_ALLOW_WIP_OVERRUN";
// Channel 1 — agent-reachable, ONE-SHOT. A SIBLING of `.claude/cross-repo-authz/`
// and `.claude/worktree-authz/`, so the audited override surfaces sit together
// rather than each inventing a location. Consumed when honoured.
const RECEIPT_REL = path.join(".claude", "wip-authz", "wip-limit-allow");
// The receipt reason is the AUDIT RECORD, not an incidental payload fragment, so it
// carries a longer budget than the library's 80-char default for quoted-back values.
const REASON_MAX = 200;

/**
 * The MAIN checkout top, from the SHARED `.git` (`--git-common-dir`), never
 * `--show-toplevel` — a call issued from inside a linked worktree must still
 * find an operator's receipt written in the main checkout.
 *
 * Routed through the shared envelope for the reason `wip-lanes.js::_git`
 * records: `GIT_DIR` OUTRANKS repository discovery, so `cwd:` alone does not pin
 * WHICH repository answers, and a planted variable would re-point the receipt
 * search at a directory of the attacker's choosing.
 *
 * Returns null when git is unavailable; the caller then searches the invoking
 * tree alone. Null NEVER manufactures a block — it only narrows the escape, and
 * the block itself already required a MEASURED over-limit count.
 */
function mainCheckoutTop(repoDir) {
  try {
    const gitBin = resolveGitBinary();
    if (!gitBin) return null;
    const r = spawnSync(
      gitBin,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd: repoDir,
        encoding: "utf8",
        timeout: 1500,
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "ignore"],
        env: gitEnv(),
      },
    );
    if (r.error || r.status !== 0) return null;
    const line = String(r.stdout || "")
      .trim()
      .split("\n")[0];
    return line ? path.dirname(line) : null;
  } catch {
    return null;
  }
}

/**
 * The gate — the SHARED two-channel audited override, configured for this guard.
 *
 * Everything the four audited-override properties depend on (agent-reachable
 * candidate resolution, the non-empty REASON price, one-shot consumption by
 * delete, and echoing the reason back) is `lib/override-receipt.js`'s, so this
 * guard cannot drift from `nested-worktree-guard.js` or `dispatch-contract-guard.js`
 * on any of them. Only the three CONFIG values are local.
 *
 * Built PER CALL rather than memoized at module scope because the invoking tree
 * arrives on the PAYLOAD (`payload.cwd`), not from `process.cwd()` — the fixture
 * harness drives this hook against a synthetic repo, and a gate pinned at require
 * time would search the wrong tree. Construction is a few closures; the git spawn
 * that finds the main checkout is behind `extraRoots`, so it is paid only on the
 * path that actually looks for a receipt.
 */
function overrideGate(repoDir) {
  return createOverrideGate({
    receiptRel: RECEIPT_REL,
    envVar: ESCAPE_ENV,
    cwd: repoDir,
    // The invoking tree is searched first by the library; this adds the MAIN
    // checkout, so a call issued from inside a linked worktree still finds an
    // operator's receipt. Resolving only one side would make the override
    // unreachable for whichever party wrote the other.
    extraRoots: () => {
      const top = mainCheckoutTop(repoDir);
      return top ? [top] : [];
    },
  });
}

// ── THE PULL HALF (loom s67, wip-discipline MUST-7) ──────────────────────────
//
// A pull system has TWO halves: bound WIP, and pull when capacity frees. This
// guard shipped a rigorous version of the bound and NONE of the pull, and that
// single absence produces BOTH observed pathologies — push-on-discovery (no queue
// to enqueue into, so "fix it now" is the only expressible action) and
// stall-on-completion (no queue to pull from, so a freed lane yields no next
// action). They look opposite; they are one defect.
//
// These helpers are the durable surface the pull half needs. Everything here
// FAILS OPEN: an unreadable or malformed ledger returns "no debt" and honours the
// receipt exactly as before. This mechanism prices a bypass; it must never become
// a second way to lose one.

const OVERRIDE_LEDGER_REL = path.join(
  ".claude",
  "wip-authz",
  "override-ledger.jsonl",
);
const QUEUE_REL = path.join(".claude", "wip-authz", "burndown-queue.jsonl");

/** The MAIN checkout, so every linked worktree reads and writes ONE ledger. */
function ledgerRoot(repoDir) {
  const top = mainCheckoutTop(repoDir);
  return top || repoDir;
}

function readJsonl(abs) {
  try {
    const fs = require("node:fs");
    return fs
      .readFileSync(abs, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Is `ref` still an open lane? Unknown ⇒ treated as LANDED (fail-open). */
function laneStillOpen(repoDir, ref) {
  if (!ref) return false;
  try {
    const survey = L.laneSurvey({ repoDir, classifyTop: 0 });
    if (!survey || !survey.ok || !Array.isArray(survey.lanes)) return false;
    return survey.lanes.some((l) => l.name === ref);
  } catch {
    return false;
  }
}

/**
 * The DEBT an earlier override left behind, or null.
 *
 * Each honoured override records the lane the operator named as the one they
 * would land FIRST (`land-first: <ref>` in the receipt body). While that lane is
 * still open, the NEXT override is refused. The escape is not another line of
 * prose — it is landing the lane already promised, which is also the thing that
 * removes the need to override.
 *
 * A receipt that names NO lane records `landFirst: null` and creates NO debt, so
 * the FIRST override in a session stays exactly as cheap as it is today. The cost
 * appears on the SECOND, which is the point at which the pattern starts.
 */
function unpaidOverrideDebt(repoDir) {
  try {
    const rows = readJsonl(path.join(ledgerRoot(repoDir), OVERRIDE_LEDGER_REL));
    if (rows.length === 0) return null;
    // ENV ROWS ARE AUDIT-ONLY AND MUST NOT SETTLE A PROMISE THEY NEVER MADE.
    //
    // This read takes the LAST row, and an env row carries `land_first: null` BY
    // CONSTRUCTION — so once the env channel became audited (s96), a single
    // `COC_ALLOW_WIP_OVERRUN=1` call appended a row that this function then read
    // as "no debt". Net effect: a receipt promising `land-first: X` was paid off
    // by an env var instead of by landing X, which is the exact inversion MUST-7
    // exists to prevent — the cheapest way to keep overriding stopped being the
    // cheapest way to stop needing to. Found by adversarial review of the change
    // that introduced it, reproduced by execution, pinned by PAIR 25.
    //
    // Filtering by CHANNEL rather than by null-ness is deliberate: a RECEIPT row
    // with no `land-first:` token still clears its own debt exactly as before.
    // That is a separate, pre-existing question about what the override should
    // COST, and it is an operator-workflow decision — not this regression's to
    // settle silently while fixing something else.
    const promises = rows.filter((r) => r && r.channel !== "env");
    if (promises.length === 0) return null;
    const last = promises[promises.length - 1];
    if (!last || !last.land_first) return null;
    if (!laneStillOpen(repoDir, last.land_first)) return null;
    return { landFirst: String(last.land_first), count: rows.length };
  } catch {
    return null;
  }
}

/**
 * Record an honoured override. Never throws; a failed write costs an audit row, never a session.
 *
 * `channel` is "receipt" or "env". BOTH are recorded, because this file's header
 * says "OVERRIDE — two channels, both audited" and until 2026-09-07 that was
 * false: `recordOverride` was reachable only from the receipt paths, so
 * `COC_ALLOW_WIP_OVERRUN=1` was honoured and wrote nothing. The audit gap was the
 * lesser half. The larger one is that `unpaidOverrideDebt` READS this ledger, so
 * the MUST-7 debt mechanism could not see env overrides at all — the receipt
 * channel accrued a debt that refuses the next override while the env channel
 * accrued nothing, which made the CHEAPER bypass the UNAUDITED one.
 *
 * An env row is AUDIT-ONLY and carries `land_first: null` by construction: it has
 * no receipt body to name a lane in. That is deliberate rather than incidental —
 * arming a debt from the env channel would dead-end CI, which cannot write a
 * promise into an env var. Recording it makes the header true; it does not price
 * the channel, and PAIR 24 pins that distinction so a later change cannot quietly
 * convert this audit row into enforcement.
 */
function recordOverride(repoDir, reason, channel = "receipt") {
  try {
    if (!appendSinkLine) return; // primitive unavailable — skip the row, never the bare idiom
    // The ledger lives under the MAIN checkout so every linked worktree reads and
    // writes ONE ledger, and the sink is under `ledgerRoot` BY CONSTRUCTION. That
    // root is therefore the containment boundary, NOT `repoDir`: measured from a
    // linked worktree, `repoDir` is `<parent>/.loom-wt/<lane>` while the sink
    // resolves under `<parent>/loom` — disjoint paths, so declaring `repoDir`
    // would refuse every honest override write from a worktree session. This is
    // the case `appendSinkLine`'s `additionalRoots` note calls R2 F1: a worktree
    // session's `repoDir` is the wrong and only-apparently-safer boundary.
    const root = ledgerRoot(repoDir);
    const abs = path.join(root, OVERRIDE_LEDGER_REL);
    // `land-first: <ref>` anywhere in the receipt body names the promised lane.
    const m = LAND_FIRST_RE.exec(String(reason || ""));
    // `reason` is OPERATOR-SUPPLIED and reaches a JSONL sink, so the row is built
    // with `JSON.stringify` and handed over WITHOUT its terminator — the primitive
    // writes exactly one. `JSON.stringify` escapes every C0 control character, so
    // an embedded newline leaves as the two-character `\n` escape and cannot split
    // one JSONL row into two; measured byte-identical to the `appendFileSync` line
    // this replaced, on LF/CRLF/NUL/ESC/lone-surrogate/`land-first:`-injection
    // inputs. The primitive's own raw-newline refusal therefore never fires for
    // the code as written — but it is NOT dead weight: MEASURED by mutation, a
    // maintainer who hand-builds this line instead gets the write REFUSED (the
    // ledger is absent) rather than a forged second row bearing an attacker's
    // `land_first`. Do not "simplify" the JSON.stringify away; the two layers
    // close the row-forging class between them.
    appendSinkLine({
      repoDir: root,
      sinkPath: abs,
      line: JSON.stringify({
        at: new Date().toISOString(),
        channel,
        land_first: m ? m[1] : null,
        reason: String(reason || "").slice(0, 400),
      }),
    });
    // The `{ok:false}` result is DELIBERATELY not propagated. This preserves the
    // failure direction the bare version had and the caller depends on: the
    // override has already been HONOURED by the time this runs, and the emit that
    // follows is advisory. A refused or failed ledger write costs an audit row,
    // never the operator's override. Do not convert this into a block — that would
    // hand anyone who can plant a symlink at the sink a way to VETO overrides.
  } catch {
    /* audit-only; never block on bookkeeping */
  }
}

/**
 * Is a CHEAPER CLOSE available than the open the caller is attempting?
 *
 * MUST-7(a): while a lane sits one push / one green check / one merge from
 * LANDED, opening a new one is BLOCKED. "Cheaper" is MEASURED, not felt — a lane
 * whose remaining work is a single mechanical step beats any lane not yet begun.
 *
 * Conservative by construction: it reports a candidate ONLY for a lane whose tip
 * is already on a remote (so the remaining step really is a check or a merge, not
 * unpushed work). Anything it cannot establish returns null and the open proceeds
 * on the existing rules — this clause adds a refusal, so it must never fire on an
 * inference.
 */
function cheaperCloseAvailable(repoDir) {
  try {
    const survey = L.laneSurvey({ repoDir, classifyTop: 0 });
    if (!survey || !survey.ok || !Array.isArray(survey.lanes)) return null;
    const pushed = survey.lanes.filter(
      (l) => l && l.name && l.localOnly === false,
    );
    if (pushed.length === 0) return null;
    pushed.sort((a, b) => (b.ageHours || 0) - (a.ageHours || 0));
    return {
      name: pushed[0].name,
      ageHours: pushed[0].ageHours,
      count: pushed.length,
    };
  } catch {
    return null;
  }
}

/**
 * Is a receipt PRESENT, without consuming it?
 *
 * The debt gate must know whether the caller is attempting an override before it
 * decides to refuse, but it must NOT spend the one shot on a call it then
 * refuses — a refusal that destroys the receipt it tells you is still available
 * is worse than no refusal. `consumeReceipt()` reads-and-unlinks, so this is a
 * separate non-destructive existence check over the same candidate roots.
 */
/**
 * The ONE definition of what naming a lane looks like.
 *
 * Hoisted from `recordOverride`'s body so the gate that REFUSES a receipt without
 * a lane and the writer that RECORDS the lane cannot drift: two copies of this
 * pattern would mean a receipt could be accepted by one and read as null by the
 * other, which is `security.md` § Enforcement-Surface Parity inside one file.
 */
const LAND_FIRST_RE = /land-first:\s*([^\s,;]+)/i;

/**
 * The receipt's TEXT, or null. `peekReceipt` answers only "is one present" and is
 * deliberately left alone — several call sites want the boolean — so this is the
 * non-destructive READ the land-first validation needs.
 */
function peekReceiptText(repoDir) {
  try {
    // The HARDENED read, shared with `consumeReceipt` rather than re-derived. Both peeks
    // previously did `readFileSync` by path, which follows symlinks — the same read
    // primitive the consume path had, in a second copy: `ln -s ~/.aws/credentials
    // .claude/wip-authz/wip-limit-allow` made that file's first bytes the receipt "reason",
    // echoed into the agent-visible advisory and the user-visible line. Hardening one call
    // site and leaving its sibling naive is no defense at all, because the attacker picks
    // the weaker end (`security.md` § Enforcement-Surface Parity), so all three readers now
    // route through `readReceiptText`.
    const roots = [
      { root: repoDir, label: "invoking tree" },
      { root: mainCheckoutTop(repoDir), label: "main checkout" },
    ].filter((r) => Boolean(r.root));
    for (const r of roots) {
      const t = readReceiptText(r.root, RECEIPT_REL, r.label);
      if (t) return t;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Is a receipt present AND does it pay the price? Returns null when it does, or a
 * typed reason when it does not: `"absent"`, `"no-token"`, `"not-a-lane"`.
 *
 * ONE PREDICATE, EVERY SITE — and that is the fix, not a tidy-up. The first cut of
 * the price gate sat at exactly ONE of the four places a receipt is consumed, so a
 * tokenless receipt was still honoured on the landed-remote-ref path via
 * `spendRemoteHold()`, which then wrote a `{channel:"receipt", land_first:null}`
 * row — and `unpaidOverrideDebt` reads the LAST non-env row, so that row ERASED an
 * armed promise. That is byte-for-byte the regression PAIR 25 pins for the env
 * channel, re-opened through the receipt channel by a gate that guarded one door
 * of four. Found by adversarial review of the change that introduced it.
 *
 * `"not-a-lane"` is the second half, and it is what makes the price real rather
 * than lexical. `laneStillOpen` fails open on an unknown ref, so `unpaidOverrideDebt`
 * returns null for a promise naming nothing — meaning `land-first: no-such-lane`
 * satisfied a FORM check and armed ZERO debt, permanently. Worse, the refusal text
 * handed the agent the literal `land-first: <ref>` to paste, and `<ref>` matches
 * `[^\s,;]+`: the message TAUGHT the bypass. Verified by execution before this fix.
 */
/** Up to three REAL open lane names, for a remedy that cannot be pasted into a bypass. */
function openLaneExamples(repoDir) {
  try {
    const survey = L.laneSurvey({ repoDir, classifyTop: 0 });
    const names = (
      survey && survey.ok && Array.isArray(survey.lanes) ? survey.lanes : []
    )
      .map((l) => l.name)
      .filter(Boolean)
      .slice(0, 3);
    return names.length
      ? names.join(", ")
      : "(no open lane resolved — run `git branch` and name one)";
  } catch {
    return "(no open lane resolved — run `git branch` and name one)";
  }
}

/** Is ANY lane open? Fails OPEN (true) on an underivable survey: an unanswerable
 *  question must not silently waive a price, only a MEASURED zero may. */
function hasAnyOpenLane(repoDir) {
  try {
    const survey = L.laneSurvey({ repoDir, classifyTop: 0 });
    if (!survey || !survey.ok || !Array.isArray(survey.lanes)) return true;
    return survey.lanes.length > 0;
  } catch {
    return true;
  }
}

function receiptPriceViolation(repoDir) {
  const text = peekReceiptText(repoDir);
  if (!text) return "absent";
  // THE PRICE IS WAIVED WHEN IT CANNOT BE PAID, and this is not a softening — it is
  // what keeps the gate from being the dead end `hook-output-discipline.md` MUST NOT
  // forbids. The landed-remote-ref door fires on un-reaped refs, which is a condition
  // that can hold with ZERO open lanes. In that state there is no lane to promise, so
  // requiring one makes the block unescapable: the operator is told to name something
  // that does not exist. The debt exists to make you LAND an open lane; with none open
  // there is nothing to land and no promise is meaningful.
  //
  // Found by a suite that drives exactly that shape (`repo({landed: 1})` — one landed
  // lane, none open), not by reasoning about it. The first cut of this price would have
  // shipped an unpayable gate on that path.
  if (!hasAnyOpenLane(repoDir)) return null;
  const m = LAND_FIRST_RE.exec(text);
  if (!m) return "no-token";
  return laneStillOpen(repoDir, m[1]) ? null : "not-a-lane";
}

/** The named lane, or null. Only meaningful when `receiptPriceViolation` returns null. */
function receiptNamedLane(repoDir) {
  const text = peekReceiptText(repoDir);
  const m = text ? LAND_FIRST_RE.exec(text) : null;
  return m ? m[1] : null;
}

function peekReceipt(repoDir) {
  // Deliberately expressed in terms of `peekReceiptText` rather than repeating the loop:
  // "is one present" is exactly "does the hardened read yield a non-empty reason", and two
  // copies of that predicate could disagree about a refused candidate — one reporting a
  // receipt present that the other would never honour.
  try {
    return peekReceiptText(repoDir) !== null;
  } catch {
    return false;
  }
}

/** The burn-down QUEUE — the surface MUST-7(b) enqueues into and (c) pulls from. */
function queueRows(repoDir) {
  return readJsonl(path.join(ledgerRoot(repoDir), QUEUE_REL)).filter(
    (r) => r && !r.done,
  );
}

function fmtAge(h) {
  if (h === null || h === undefined) return "age UNKNOWN";
  if (h < 48) return `${h.toFixed(0)}h`;
  return `${(h / 24).toFixed(0)}d`;
}

/**
 * WHICH INSTRUMENT DECIDED, in words. Since landing provenance was recorded, a
 * lane's landedness is decided by the `Landed-From` trailers written at landing
 * time FIRST, and by `git cherry` patch-ids ONLY where that record falls back
 * (no config, a branch predating the cutover, ancestry) — `lib/wip-lanes.js`
 * `_laneContent`. A message that still said "measured by git cherry" would name
 * an instrument that did not decide. `counts` maps instrument → number of lanes
 * (or refs) it decided; zero entries are omitted.
 */
function instrumentPhrase(counts) {
  const c = counts && typeof counts === "object" ? counts : {};
  const parts = [];
  if (c.provenance)
    parts.push(
      `${c.provenance} by recorded landing provenance (Landed-From trailers)`,
    );
  if (c.content)
    parts.push(
      `${c.content} by git cherry patch-ids (fallback: no provenance record applies)`,
    );
  if (c.ancestry)
    parts.push(`${c.ancestry} by ancestry (tip reachable from the base)`);
  return parts.length ? parts.join("; ") : "no instrument decided any";
}

/** One lane's deciding instrument, in words. */
function oneInstrument(decidedBy) {
  return decidedBy === "provenance"
    ? "recorded landing provenance (Landed-From trailers)"
    : decidedBy === "content"
      ? "git cherry patch-ids (fallback: no provenance record applies)"
      : "an UNNAMED instrument";
}

/** The two legal outcomes, stated every time. This is the disposition half. */
const DISPOSITION =
  "Every lane has exactly TWO terminal states: LAND it (merge, then delete the " +
  "branch AND remove its worktree) or KILL it (record why, then delete both). " +
  '"Leave it for now" is not one of them — it is the state that produced this backlog.';

/** How the agent gets out from under the block, stated in the block itself. A
 *  refusal that does not name its own escape is the dead-end
 *  `hook-output-discipline.md` MUST NOT warns about.
 *
 *  The MECHANISM half is the library's sentence, so the escape an agent is told
 *  about here is described in the same words as the one it is told about at the
 *  worktree and dispatch-contract gates — a divergence in the INSTRUCTION is how
 *  an agent learns a wrong override procedure. The second sentence is this
 *  guard's own: it names the WIP-specific rationalization (file an issue instead
 *  of dispositioning the lane) that no other gate has. */
function overrideInstruction(gate) {
  return (
    gate.formatOverrideInstruction() +
    ` Do NOT file a follow-up issue instead of dispositioning a lane ` +
    `(autonomous-execution.md § Per-Session Capacity Budget Rule 4).`
  );
}

function oldestLines(repoDir) {
  const survey = L.laneSurvey({ repoDir, classifyTop: 5 });
  return survey && survey.ok
    ? survey.lanes
        .slice(0, 5)
        .map(
          (l) =>
            `  - ${l.name} — ${fmtAge(l.ageHours)}${l.localOnly ? ", LOCAL-ONLY" : ""}`,
        )
    : ["  (lane detail unavailable — the count above still holds)"];
}

/**
 * @param {string} repoDir
 * @param {{noun: string, how: string|null, remoteDoor: boolean}} [origin] what is
 *   about to open the lane.
 *
 *   THE "dispatch" WORDING IS GONE WITH THE ARM THAT NEEDED IT. This parameter
 *   used to default to an agent-spawn noun because the `PreToolUse:Task|Agent`
 *   arm called in with no origin at all. That arm is deleted, leaving exactly ONE
 *   caller — the Bash lane-creation path — which always passes
 *   `{noun:"command", how:"git worktree add", remoteDoor:true}`. Every
 *   `creates:true` return of `laneCreationIntent` carries a non-null `how`
 *   (`lib/wip-lanes.js`, nine return sites), so the old `"This dispatch"` fallback
 *   was unreachable the moment the arm went; it is removed rather than left to
 *   read as a live wording this guard can still emit. The `how`-less fallback
 *   below stays narrow and honest: it names a command without inventing a form.
 */
function runSpawnGuard(repoDir, origin) {
  const NOUN = (origin && origin.noun) || "command";
  const HOW = (origin && origin.how) || null;
  const ACTOR = HOW ? `This command (\`${HOW}\`)` : "This command";
  // ── THE THIRD DOOR: LANDED REMOTE REFS (loom s91) ───────────────────────────
  //
  // Local drainage was real and measured (branches 10 → 3, worktrees 8 → 2) and
  // left 97% of the ref population untouched, because that population was REMOTE
  // refs and nothing reaps one: `gh pr merge --delete-branch` reaps only a branch
  // that had a PR, `git branch -d` reaps only the local ref, and the CI doctrine
  // that makes a wave affordable — a pushed branch with no open PR fires zero CI
  // and is free — is exactly what manufactures pushed-and-never-PR'd refs.
  // Measured on loom the day this landed: 616 remote refs, 526 already ON main.
  //
  // So the ceiling now refuses creation WHILE LANDED REMOTE REFS EXIST — keyed on
  // CONTENT, never on age — so drainage is FORCED rather than remembered.
  //
  // CORRECTED 2026-09-10. This comment used to gloss CONTENT as "(tip is an
  // ancestor of the base)", which is self-contradictory — ancestry is precisely
  // what content-identity is NOT — and the code implemented the ancestry half,
  // so the gloss described the defect rather than the intent. `--merged` is
  // false-negative by construction under a SQUASH merge, which re-authors every
  // commit under a new sha; measured on this repo, 18 remote refs were landed
  // by content and 0 were ancestry-visible, so this door had never once fired.
  // SUPERSEDED IN PART by landing provenance: landedness is now decided FIRST by
  // the `Landed-From` trailers recorded at landing time (`lib/landed-map.js`
  // `landedVerdict`, consulted in `lib/wip-lanes.js::landedRemoteRefs`), and the
  // patch-id test below runs only where that verdict falls back. Before that,
  // landedness was decided by PATCH-ID (`git cherry`) via the one shared
  // predicate at `.claude/hooks/lib/reap-on-landing.js:163-181`, spawned by the
  // cherry loop in `lib/wip-lanes.js::landedRemoteRefs`
  // (`.claude/hooks/lib/wip-lanes.js:1104-1135`). Ancestry is still consulted there
  // as a sound SUBSET (one spawn, certain hits), never as the test. The remedy is one command, report-only by
  // default, that archives every tip to `refs/archive/remote/<date>/<branch>`
  // before deleting on the remote and never touches an open PR's head. This
  // gate runs BEFORE the local count: a clean local forest with 500 landed
  // remote refs is the failure mode, not a pass. FAIL OPEN on an underivable
  // answer (no remote, no base, no git), the same disposition as the count.
  // Residuals, stated so a reader does not infer more than the gate can see: a
  // remote-tracking ref already deleted on the remote still counts until
  // `git fetch --prune` (the reaper prunes first), and a landed ref that is the
  // head of an OPEN PR is counted here but never reaped — close or update that
  // PR. Both overrides are the ones MUST-2 already names: the env channel, and
  // the one-shot receipt, consumed ONLY on a call this gate would refuse.
  // The door is consulted for the Bash lane-creation arm ONLY. `runSpawnGuard`
  // also serves the Task|Agent arm, and a WORKER is not inventory (MUST-2:
  // "the ceiling counts INVENTORY, never WORKERS"): reviewed, the first draft
  // sat above both arms and refused every lane-capable specialist dispatch —
  // including the review round mandated for the change itself.
  const REAP = "node .claude/bin/remote-ref-reap.mjs";
  const landed =
    origin && origin.remoteDoor ? L.landedRemoteRefs({ repoDir }) : null;
  const BASE_NAME = (landed && landed.base) || "origin/main";
  // `remoteHeld` is set when this door WOULD refuse but an override stands. The
  // door then FALLS THROUGH to the local ceiling instead of returning, so ONE
  // receipt never buys a bypass of TWO gates on one call: reviewed, the first
  // draft consumed the receipt here, returned, and the local count never ran on
  // that call. Now the receipt is spent by whichever gate is the LAST to need it
  // on this call — the local ceiling when it fires, `settleRemote()` below when
  // nothing else does — and always exactly once.
  let remoteHeld = null;
  if (landed && landed.ok && landed.count > L.REMOTE_LANDED_FLOOR) {
    const shown =
      landed.names.slice(0, 5).join(", ") +
      (landed.count > 5 ? `, … (+${landed.count - 5} more)` : "");
    const gateR = overrideGate(repoDir);
    if (gateR.envOverride())
      remoteHeld = { via: "env", count: landed.count, shown };
    // PRICED, not merely PRESENT. Holding this door on an unpriced receipt is how a
    // tokenless receipt reached `spendRemoteHold()` and erased an armed debt: the door
    // consulted presence, the consume path asked no question, and the price gate sat at
    // a different door entirely.
    else if (receiptPriceViolation(repoDir) === null)
      remoteHeld = { via: "receipt", count: landed.count, shown };
    else {
      clearTimeout(_timeout);
      return emit({
        hookEvent: "PreToolUse",
        severity: "block",
        what_happened:
          `${ACTOR} would open a NEW lane while ${landed.truncated ? "at least " : ""}${landed.count} remote ref(s) whose content is ALREADY on ` +
          `${BASE_NAME} have not been reaped: ${shown}.`,
        why: "wip-discipline/MUST-4 — done means LANDED AND CLEANED, and CLEANED includes the remote ref: a pushed branch nobody PR'd is reaped by no merge. The forest of landed remote refs grew to hundreds because nothing refused creation while it stood; this door refuses, keyed on LANDEDNESS — decided FIRST by the landing provenance recorded at landing time (a `Landed-From` trailer naming the ref's commits, which survives any rebase, squash or conflict fix), and only where no record applies by CONTENT (every commit's PATCH-ID already present at the base, `git cherry`) — never on age, with NO count threshold — a clean local forest beside hundreds of landed remote refs is the failure mode, not a pass. Refs held by the protection floor are DEMOTED out of this count (the reaper refuses them by design, so a door keyed on them could never clear) but are still COUNTED and reported — demoting is a reason to classify differently, never a reason to stop counting.",
        agent_must_report: [
          `State the count: ${landed.truncated ? "AT LEAST " : ""}${landed.count} remote ref(s) on origin already LANDED on ${BASE_NAME}, un-reaped. Instruments that decided the landed set: ${instrumentPhrase(landed.landedBy)}${landed.truncated ? ` — the scan examined ${landed.examined} of ${landed.candidates} refs within its time budget, so this is a LOWER bound, never the total` : ` (all ${landed.candidates} refs examined)`}.`,
          `REMEDIATION — run \`${REAP}\` and READ the report (a verdict per ref; open-PR heads marked; UNKNOWN and CONTENT-UNMEASURED are never reaped), THEN \`${REAP} --include-content-landed --apply\` (the bare \`--apply\` reaps only LANDED-ANCESTOR refs, and a squash merge re-authors every commit so a landed ref is NOT an ancestor — without this flag the command cannot clear this door) (writes a LOCAL recovery ref refs/archive/remote/<stamp>/<branch> in THIS clone only — never pushed, no reflog on the remote — then deletes on the remote; never an open PR's head, never the remote's default branch; refuses when the PR list cannot be read). Then re-issue this ${NOUN}.`,
          `If the report shows every landed ref as an open-PR head, close or update those PRs; if a ref was already deleted on the remote, the reaper's fetch --prune clears it; if you cannot delete on this remote, that is the case for the override below — say so in the receipt.`,
          overrideInstruction(gateR),
        ],
        agent_must_wait: `Do not retry this ${NOUN} unmodified. Reap the landed remote refs (preferred) or write the one-shot receipt and retry.`,
        user_summary: `Landed remote refs UN-REAPED: ${landed.truncated ? "at least " : ""}${landed.count} branch(es) already on ${BASE_NAME} — creation blocked; run ${REAP}, read it, then --apply`,
      });
    }
  }
  // Appended to whatever the LOCAL ceiling says on this call, so the operator
  // learns both gates were held open by the one receipt / env run.
  const remoteNote = () =>
    remoteHeld
      ? ` The landed-remote-ref door was ALSO held open on this call (${remoteHeld.count} remote ref(s) already on ${BASE_NAME} un-reaped: ${remoteHeld.shown}) — run \`${REAP}\`, read it, then \`${REAP} --apply\`.`
      : "";
  // The door held on an override and no other gate spoke: spend the receipt
  // (one-shot — a lingering receipt would hold the door open for every later
  // call) and say so. With no override held, this IS the plain passthrough.
  // SPENDING THE HOLD IS IDEMPOTENT, AND THAT IS THE FIX FOR A CLASS, NOT A PATH.
  //
  // The invariant above ("spent by whichever gate is the LAST to need it, always
  // exactly once") was enforced by every exit REMEMBERING to route through
  // `settleRemote()`. The s95 hand-merge added a third exit between the age door
  // and the count teeth that did not, and the receipt was then spent by nobody:
  // it held the remote door open again on the next call, and every call after,
  // with no ledger row. That is a defect the shape invites — "N exits must each
  // remember" is a rule no reviewer can check by looking at one hunk.
  //
  // So the spend is now a self-guarding operation any PROCEEDING path may call
  // unconditionally. Calling it twice is a no-op; calling it once is mandatory.
  // A future exit added between these doors is correct if it calls this, and the
  // failure mode of forgetting is the same visible one PAIR 22 pins.
  //
  // It is NOT called on a path that REFUSES: the debt refusal below says in its
  // own report that the receipt was not consumed, and spending it there would
  // destroy the very receipt the refusal tells the operator is still available.
  let _remoteHoldSpent = false;
  const spendRemoteHold = () => {
    if (_remoteHoldSpent || !remoteHeld) return null;
    _remoteHoldSpent = true;
    if (remoteHeld.via !== "receipt") {
      // The env channel spends no RECEIPT, but it is still an honoured override
      // and this file's header says both channels are audited — so it still
      // records. Reached when the remote door was the only door that fired.
      recordOverride(
        repoDir,
        `${ESCAPE_ENV}=1 (landed-remote-ref door)`,
        "env",
      );
      return null;
    }
    const c = overrideGate(repoDir).consumeReceipt();
    const r = c ? c.reason : null;
    recordOverride(repoDir, r);
    return r;
  };
  // The local ceiling consumes the SAME one receipt when it fires (one receipt
  // covers whichever doors are open on this call), so that path marks the hold
  // spent rather than consuming a second time.
  const markRemoteHoldSpent = () => {
    _remoteHoldSpent = true;
  };

  const settleRemote = () => {
    if (!remoteHeld) return passthrough();
    const reason = spendRemoteHold();
    clearTimeout(_timeout);
    const via =
      remoteHeld.via === "env"
        ? `${ESCAPE_ENV}=1`
        : `the one-shot receipt ${RECEIPT_REL} (consumed, deleted)`;
    return emit({
      hookEvent: "PreToolUse",
      severity: "advisory",
      what_happened:
        `Landed-remote-ref door OVERRIDDEN via ${via} — ${remoteHeld.count} remote ref(s) already on ${BASE_NAME} ` +
        `are still un-reaped (${remoteHeld.shown}).` +
        (reason
          ? ` Stated reason: ${safeField(reason, "(none)", REASON_MAX)}`
          : ""),
      why: "wip-discipline/MUST-4 — the override was honoured, not the door. The local ceiling was consulted on this same call and did not refuse; the next creation past this door blocks again.",
      agent_must_report: [
        `State in your next message that the landed-remote-ref door was overridden via ${remoteHeld.via === "env" ? ESCAPE_ENV : "the one-shot receipt"}${reason ? ", and quote the reason you wrote" : ""}.`,
        `Run \`${REAP}\`, read the report, then \`${REAP} --apply\`.`,
      ],
      agent_must_wait:
        "You may proceed — this is advisory, not a block. Surface the override in your report.",
      user_summary: `Landed-remote-ref door OVERRIDDEN via ${remoteHeld.via} — ${remoteHeld.count} landed remote ref(s) un-reaped`,
    });
  };

  // ── AN UNDECIDED DOOR NEVER DECIDES A RECEIPT'S FATE IN SILENCE ────────────
  //
  // Every refinement below is bounded by a WALL-CLOCK budget or a per-call git
  // timeout, and each fails OPEN. That is right for the VERDICT — a guard that
  // cannot measure must not refuse — and it was wrong for the RECEIPT, whose
  // disposition rode on the same outcome. Measured by injecting an expired
  // `confirmAtLimit` budget (reported first as a load flake): a lane-opening
  // dispatch at 6 lanes against a limit of 5 took the report exit with the
  // receipt still on disk and a report that never named it, so the one-shot
  // survived to be spent by a LATER call — one receipt, two lanes past the
  // ceiling, one ledger row. A budget measures the HOST, not the repository, so
  // it must not decide what happens to the operator's override.
  //
  // Where a door has a repository-state upper bound — the count door's
  // `fast.count >= LIMIT` — an undecided refinement HONOURS a priced receipt
  // (the report exit below). Where it has none — an unreadable count, an age scan
  // that did not finish under the limit — a present receipt is NAMED LIVE.
  const liveReceiptLine = (why) =>
    peekReceipt(repoDir)
      ? `Your one-shot receipt ${RECEIPT_REL} was NOT consumed and is still LIVE on disk (${why}). The next ${NOUN} a door refuses will spend it — delete it now if this ${NOUN} is the one you wrote it for.`
      : null;
  const settleUndecided = (whatRaw) => {
    const what = safeField(String(whatRaw), "?", 300);
    // A remote hold taken on the RECEIPT spends it in `settleRemote()`, so nothing
    // is left live. A hold taken on the ENV channel spends no receipt, so a receipt
    // on disk beside it is still armed and is named like any other — keying this
    // on `remoteHeld` alone would leave exactly that receipt silent.
    const live =
      remoteHeld && remoteHeld.via === "receipt"
        ? null
        : liveReceiptLine(`${what}, so no door decided this ${NOUN}`);
    if (!live) return settleRemote();
    spendRemoteHold(); // env channel: records its audit row; spends no receipt
    clearTimeout(_timeout);
    return emit({
      hookEvent: "PreToolUse",
      severity: "advisory",
      what_happened:
        `WIP gate UNDECIDED — ${what}. This ${NOUN} proceeds, because a guard that cannot measure must not refuse, and it did NOT spend the one-shot receipt that is present.` +
        remoteNote(),
      why: "wip-discipline/MUST-2 + MUST-7 — a one-shot override is either spent by the call it was written for or reported LIVE; a time budget or an unreadable count must never leave it silently armed for a later call.",
      agent_must_report: [live, DISPOSITION],
      agent_must_wait:
        "You may proceed — this is advisory, not a block. Surface the live receipt in your report.",
      user_summary: `WIP gate undecided — one-shot receipt ${RECEIPT_REL} still LIVE`,
    });
  };

  const fast = L.laneCountFast({ repoDir });
  // UNKNOWN is not a violation, and it is CERTAINLY not a block: a guard that
  // cannot count must not refuse (`cc-artifacts.md` Rule 7). It is not silent
  // about a receipt either — § AN UNDECIDED DOOR above.
  if (!fast || !fast.ok)
    return settleUndecided(
      `the lane count could not be read (${(fast && fast.reason) || "no result"}${fast && fast.trunkReason ? `: ${fast.trunkReason}` : ""})`,
    );

  // ── THE AGE DOOR (wip-discipline MUST-3) ───────────────────────────────────
  //
  // IT IS EVALUATED BEFORE THE COUNT'S UNDER-LIMIT EARLY RETURN, and that
  // placement is the whole clause. MUST-3 is titled "AGE Governs, Not COUNT":
  // a repo sitting at TWO lanes and THREE WEEKS is under every count the ceiling
  // measures and is exactly the state the rule calls a defect. Behind the count
  // check this door would be unreachable in precisely the population it exists
  // for.
  //
  // WHY THIS AXIS ONLY REPORTED UNTIL NOW, and why that stopped being tenable.
  // Age was carried at `SessionStart` alone, at `halt-and-report`. MEASURED:
  // `chore/handbook-authz-receipt` was named in that report at every session
  // start for three days and dispositioned at none. The rule's own Wiring had
  // already recorded, twice, that "a ceiling that reports is not a ceiling" —
  // once for the count door in 2026-08-23, and this is the same finding on the
  // axis the rule says GOVERNS.
  //
  // WHY `block` IS PERMITTED HERE, on the SAME ground the count door takes it.
  // `hook-output-discipline.md` MUST-2 reserves `block` for a structural fact a
  // regex cannot misread and forbids it on a lexical signal. The lexical match
  // (`laneCreationIntent`, over the shared `git-command-parse.js`) selects only
  // WHICH QUESTION to ask; the ANSWER is the recorded landing provenance (or,
  // only where no record applies, `git cherry` patch-ids) plus committer
  // dates read off the commit objects. A committer date is a git-object fact —
  // no prose is read, no shell string is expanded, and no paraphrase of a
  // lane-opening command can evade it.
  //
  // AND IT IS TAKEN ON MEASURED CONTENT, never on ancestry or a timestamp alone.
  // `confirmAgedLane` fires only for a lane that BOTH carries provenance- or
  // (fallback only) `git cherry`-
  // confirmed unlanded commits AND has a readable committer date on the oldest
  // of them. A rebased-and-landed branch confirms nothing; an underivable age
  // confirms nothing; an exhausted budget returns `decided:false`. Every unknown
  // lowers the chance of a refusal, which is the only direction that cannot
  // refuse work the operator is entitled to start — the same asymmetry
  // `confirmAtLimit` is built on.
  const aged = L.confirmAgedLane({ repoDir, lanes: fast.lanes || [] });
  const ageBlocks = Boolean(aged && aged.decided && aged.aged);

  // The count is an UPPER bound, so `count < LIMIT` proves the true count is
  // under the limit. No refinement is needed on this side, and it is the hot
  // path — two O(1) git spawns and out. The age door is the second condition
  // rather than a second early return: under the count limit WITH an aged lane
  // is a state that must still refuse.
  //
  // An age scan that ran out of budget, or skipped a lane git could not answer,
  // DECIDED NOTHING — a lane it did not measure may be the aged one. Under the
  // count limit the age door has no repository-state upper bound to spend a
  // receipt on, so a present receipt is NAMED LIVE (§ AN UNDECIDED DOOR above).
  if (fast.count < L.WIP_LIMIT && !ageBlocks) {
    const ageUndecided = !aged || !aged.decided || aged.unanswerable > 0;
    if (!ageUndecided) return settleRemote();
    return settleUndecided(
      !aged
        ? "the age scan did not run"
        : !aged.decided
          ? `the age scan did not finish (${aged.reason || "undecided"}${aged.trunkReason ? `: ${aged.trunkReason}` : ""}; ${aged.scanned} of ${aged.candidates} lane(s) measured)`
          : `the age scan could not measure ${aged.unanswerable} of ${aged.candidates} lane(s)`,
    );
  }

  const gate = overrideGate(repoDir);

  /** The confirmed-count sentence, or the honest absence of one. `confirm` is
   *  null when the AGE door alone brought us here (count under the limit), and a
   *  message that asserted a confirmed count in that state would be reporting a
   *  measurement nobody took. */
  const confirmedLine = (confirm) =>
    confirm
      ? `State the confirmed count: ${confirm.confirmed} lane(s) with MEASURED unlanded content against a limit of ${L.WIP_LIMIT} (decided: ${instrumentPhrase(confirm.decidedBy)}).`
      : `State the count: ${fast.count} open lane(s) against a limit of ${L.WIP_LIMIT} — UNDER the limit. The COUNT is not what refused this; the AGE bound is.`;

  /** The age finding as one reportable line, or null when the age door is silent. */
  const agedLine = () =>
    ageBlocks
      ? `AGE (wip-discipline MUST-3): '${aged.name}' has carried ${aged.uniqueCommits} MEASURED unlanded commit(s) for ${fmtAge(aged.ageHours)} — past the ${L.AGE_BOUND_HOURS}h bound. Unlanded decided by ${oneInstrument(aged.decidedBy)}. Age basis: OLDEST UNLANDED COMMIT (committer date), never directory mtime.`
      : null;

  // Channel 2 first: it is a free env read, and honouring it early skips the
  // confirmation spawns entirely. `gate.envOverride()` tests the LITERAL "1", so
  // an accidental `VAR=0` or `VAR=` cannot disarm the gate — the same test the
  // sibling guards apply, which is the point of taking it from the library.
  if (gate.envOverride()) {
    // AUDITED, per this file's header. The remote hold (if any) is settled on the
    // same call by the same channel, so it is marked rather than double-recorded.
    recordOverride(repoDir, `${ESCAPE_ENV}=1`, "env");
    markRemoteHoldSpent();
    clearTimeout(_timeout);
    return emit({
      hookEvent: "PreToolUse",
      severity: "advisory",
      what_happened:
        `WIP gate OVERRIDDEN by ${ESCAPE_ENV}=1 — a new lane is opening while ` +
        `${fast.count} are already open (limit ${L.WIP_LIMIT})` +
        (ageBlocks
          ? ` and '${aged.name}' is ${fmtAge(aged.ageHours)} past-bound.`
          : `.`) +
        remoteNote(),
      why: "wip-discipline/MUST-2 + MUST-3 — the override was honoured, not the gate. This notice exists so the overrun is visible rather than silent.",
      agent_must_report: [
        `State in your next message that the WIP gate was overridden via ${ESCAPE_ENV}=1, and why.`,
        `State the count: ${fast.count} open lanes against a limit of ${L.WIP_LIMIT} (UPPER BOUND, ancestry-unmerged).`,
        ...(agedLine() ? [agedLine()] : []),
        DISPOSITION,
      ],
      agent_must_wait:
        "You may proceed — this is advisory, not a block. Surface the override in your report.",
      user_summary: `WIP gate OVERRIDDEN via ${ESCAPE_ENV}=1 — ${fast.count}/${L.WIP_LIMIT} lanes open${ageBlocks ? `, oldest ${fmtAge(aged.ageHours)}` : ""}`,
    });
  }

  // THE BLOCK DECISION IS TAKEN ON A LOWER BOUND. `fast.count` over-reports; a
  // refusal built on it would refuse work on lanes whose content already
  // landed. `confirmAtLimit` counts only lanes whose unlanded content git
  // MEASURED, and stops at the limit — so the common case is WIP_LIMIT spawns
  // however large the forest.
  //
  // SKIPPED ENTIRELY when the count is under the limit: the question it answers
  // ("are there at least LIMIT lanes") is already settled by the upper bound, and
  // paying its spawns to re-answer it would be spending budget the age door's
  // scan has already spent.
  const confirm =
    fast.count >= L.WIP_LIMIT
      ? L.confirmAtLimit({
          repoDir,
          names: fast.names,
          limit: L.WIP_LIMIT,
        })
      : null;
  const countBlocks = Boolean(
    confirm && confirm.decided && confirm.atLeastLimit,
  );

  // Undecided (budget exhausted) or decided-under: the COUNT teeth do NOT fire.
  // The REPORT still does, because the upper bound is genuinely at the limit and
  // over-reporting a report costs one operator glance. Reachable only with the
  // count at/over the limit — under it, `ageBlocks` is the sole reason we are
  // here and it routes to the teeth below.
  if (!countBlocks && !ageBlocks) {
    const why = !confirm
      ? "the confirmation pass did not run"
      : confirm.trunkReason
        ? `the confirmation pass could not resolve the integration trunk (${confirm.trunkReason})`
        : !confirm.decided
          ? `the confirmation pass ran out of budget after ${confirm.scanned} of ${confirm.candidates} candidate(s)`
          : `only ${confirm.confirmed} of ${confirm.candidates} candidate(s) carry MEASURED unlanded content`;
    // THE COUNT DOOR HAS A REPOSITORY-STATE UPPER BOUND, so an UNDECIDED
    // confirmation does not get to decide the receipt (§ AN UNDECIDED DOOR above).
    // `fast.count >= LIMIT` is the fact a refusal is taken against; a lane-opener
    // presenting a PRICED receipt on it spends that receipt whether
    // `confirmAtLimit` finished or ran out of host time. UNDECIDED includes a pass
    // that "decided" while starved by unanswerable lanes — a per-call git timeout
    // returns `unanswerable`, never `decided:false` — so the test is whether the
    // lanes it could NOT measure could still reach the limit. Only a MEASURED
    // under-limit leaves the receipt untouched, and that exit names it LIVE.
    //
    // WHY SPEND RATHER THAN ONLY NAME (wip-discipline MUST-2: a receipt is
    // "honoured ONCE (consumed on use)"). This call proceeds either way. Leaving
    // the receipt armed lets a LATER over-limit call ride it — one receipt, two
    // lanes past the ceiling, one ledger row, and no debt armed for the lane THIS
    // call opens. Spending records the override and its `land-first:` promise.
    // The debt and price gates still apply; on this fail-open exit they WITHHOLD
    // the spend rather than refuse the call, and the unspent receipt is named.
    const countUndecided = Boolean(
      confirm &&
      (!confirm.decided ||
        confirm.confirmed + confirm.unanswerable >= L.WIP_LIMIT),
    );
    const debtNow = countUndecided ? unpaidOverrideDebt(repoDir) : null;
    const priceNow = countUndecided ? receiptPriceViolation(repoDir) : null;
    if (countUndecided && !debtNow && priceNow === null) {
      const spent = gate.consumeReceipt();
      if (spent) {
        markRemoteHoldSpent();
        recordOverride(repoDir, spent.reason);
        clearTimeout(_timeout);
        return emit({
          hookEvent: "PreToolUse",
          severity: "advisory",
          what_happened:
            `WIP gate OVERRIDDEN by the one-shot receipt ${RECEIPT_REL} (consumed, deleted) — ` +
            `${fast.count} lanes open against a limit of ${L.WIP_LIMIT}, confirmation UNDECIDED because ${why}. ` +
            `Stated reason: ${safeField(spent.reason, "(none)", REASON_MAX)}` +
            remoteNote(),
          why: "wip-discipline/MUST-2 + MUST-7 — the override was honoured, not the gate. The receipt is spent on the UPPER BOUND it was written against, never on whether a time budget finished; the next lane-opening call past a door blocks again.",
          agent_must_report: [
            `State in your next message that the WIP gate was overridden via the one-shot receipt, and quote the reason you wrote.`,
            `State the count: ${fast.count} open lanes against a limit of ${L.WIP_LIMIT} — an UPPER BOUND; the content confirmation was UNDECIDED (${why}).`,
            DISPOSITION,
          ],
          agent_must_wait:
            "You may proceed — this is advisory, not a block. Surface the override in your report.",
          user_summary: `WIP gate OVERRIDDEN via one-shot receipt — ${fast.count}/${L.WIP_LIMIT} lanes open (confirmation undecided)`,
        });
      }
    }
    // THIS CALL PROCEEDS, so the hold must be spent here — see § SPENDING THE
    // HOLD IS IDEMPOTENT. Before loom s96 this exit returned past `settleRemote()`
    // and the receipt survived to hold the remote door open on every later call.
    const heldReason = spendRemoteHold();
    // Read AFTER the hold is spent: a receipt the remote door just consumed is not live.
    const liveLine = liveReceiptLine(
      !countUndecided
        ? `the ceiling MEASURED only ${confirm ? confirm.confirmed : 0} of ${confirm ? confirm.candidates : 0} lane(s) with unlanded content, so no door refused this ${NOUN}`
        : debtNow
          ? `the confirmation was undecided and an unpaid override debt on '${safeField(debtNow.landFirst, "(none)", 60)}' withholds the spend`
          : `the confirmation was undecided and the receipt does not pay the price (${priceNow})`,
    );
    clearTimeout(_timeout);
    return emit({
      hookEvent: "PreToolUse",
      // `pre-action`, NOT `halt-and-report`. The dispatch has NOT run yet, and
      // `halt-and-report` renders "the action ALREADY RAN" — measured, on this
      // hook, against a pending Task. That head is FALSE here and it contradicts
      // the agent_must_wait below, which asks the agent to decide whether to
      // proceed: an action said to have already run has no proceed left in it.
      // Same correction `stranded-artifact-guard.js` records for its own
      // destructive surface.
      severity: "pre-action",
      what_happened:
        `A new lane is about to open while ${fast.count} are already open ` +
        `(WIP limit ${L.WIP_LIMIT}). NOT BLOCKED because ${why}.` +
        remoteNote(),
      why: "wip-discipline/MUST-2 — the WIP limit is a PULL signal: finish a lane to start a lane. Cycle time = WIP / throughput, so an unbounded lane count guarantees lanes older than anyone's memory.",
      agent_must_report: [
        `State the count: ${fast.count} open lanes against a limit of ${L.WIP_LIMIT}. This count is an UPPER BOUND (ancestry-unmerged; a rebased branch can read open when its content has landed), and the block withheld itself precisely because that bound was not confirmed.`,
        "Name the oldest open lanes:\n" + oldestLines(repoDir).join("\n"),
        DISPOSITION,
        `Recommend which existing lane to land or kill BEFORE opening this one, or state why this ${NOUN} does not open a lane (a read-only review lane opens none).`,
        ...(liveLine ? [liveLine] : []),
        ...(remoteHeld
          ? [
              `The landed-remote-ref door was held open on this call via ${
                remoteHeld.via === "env"
                  ? `${ESCAPE_ENV}=1`
                  : `the one-shot receipt ${RECEIPT_REL} (now CONSUMED, deleted)`
              } — state that in your next message${
                heldReason ? ", and quote the reason you wrote" : ""
              }. The next ${NOUN} past that door blocks again.`,
            ]
          : []),
      ],
      agent_must_wait:
        "Report the limit and your recommendation, then proceed if that is still what the operator wants. This is a report, not a block.",
      user_summary: `WIP limit: ${fast.count}/${L.WIP_LIMIT} lanes open (unconfirmed) — land or kill one before opening another`,
    });
  }

  // Channel 1 — the agent-reachable one-shot receipt. `gate.consumeReceipt()` is
  // called here, on a call that would otherwise be refused, and on the UNDECIDED
  // count exit above, whose upper bound is the same refusal the receipt was
  // written against — so a MEASURED would-not-have-blocked dispatch never spends
  // the operator's one shot. That
  // ORDERING is this guard's, not the library's: `gate.resolveOverride()` would
  // resolve both channels in one step, which is right for a guard whose verdict
  // is already settled, and wrong here — the verdict is not settled until
  // `confirmAtLimit` and `confirmAgedLane` have run above.
  //
  // ONE RECEIPT COVERS WHICHEVER DOORS ARE OPEN ON THIS CALL, and that is the
  // brief's "route through the EXISTING override channel", not a softening. The
  // receipt is still ONE-SHOT and still consumed: the NEXT lane-opening call
  // meets whichever doors still stand with no receipt in hand. Minting a second
  // channel for the age axis would have given the operator two ways to bypass
  // where the audit trail expects one.
  // ── OVERRIDE ESCALATION (loom s67, wip-discipline MUST-7) ──────────────────
  //
  // The DEBT CHECK RUNS BEFORE `consumeReceipt()`, and the ordering is
  // load-bearing rather than stylistic: consuming first would spend the
  // operator's one shot on a call this branch then refuses, so the refusal would
  // destroy the very receipt it tells them is still available. The same reasoning
  // the surrounding code already applies one level up — the receipt is spent ONLY
  // on a call that would otherwise be refused — applied to this gate's own
  // refusal.
  const debt = unpaidOverrideDebt(repoDir);
  if (debt && peekReceipt(repoDir)) {
    clearTimeout(_timeout);
    return emit({
      hookEvent: "PreToolUse",
      severity: "block",
      what_happened:
        `WIP override REFUSED — the previous override named '${debt.landFirst}' as the lane it ` +
        `would land FIRST, and that lane is still OPEN. Overrides taken so far: ${debt.count}.`,
      why:
        "wip-discipline/MUST-7 — burn-down takes precedence, and an override is a DEBT, not a " +
        "toll. The receipt is honoured once per landed promise: the way to override again is to " +
        "land the lane you already named, which is also the way to stop needing to.",
      agent_must_report: [
        `Land or kill '${debt.landFirst}' — the lane your previous override named. Then re-issue.`,
        confirmedLine(confirm),
        ...(agedLine() ? [agedLine()] : []),
        `Your receipt was NOT consumed — it is still on disk and will be honoured once the debt is paid.`,
        DISPOSITION,
      ],
      agent_must_wait:
        "Do not re-issue this call until the named lane reaches a terminal state. Writing a new receipt does not clear the debt.",
      user_summary: `WIP override REFUSED — '${debt.landFirst}' promised and still open (${debt.count} override(s) taken)`,
    });
  }

  // NAMING A LANE IS PART OF THE PRICE (MUST-7).
  //
  // The debt priced only whoever VOLUNTEERED a promise: `recordOverride` reads
  // `land-first:` by regex out of operator free text, so a receipt omitting the
  // token recorded `land_first: null`, `unpaidOverrideDebt` returned null, and the
  // next override was free. The cheapest way to override forever was to write one
  // line LESS — and a guard whose bypass is cheaper than its remediation is a
  // suggestion, which is the sentence the debt mechanism was built on in the first
  // place.
  //
  // PEEK, VALIDATE, THEN CONSUME — the ordering is load-bearing and mirrors the
  // debt refusal above. Consuming first would spend the operator's one shot on a
  // call this branch then refuses, destroying the receipt the message tells them
  // is still there. The escape is ONE LINE and the refusal names it, so this is
  // not the dead end `hook-output-discipline.md` MUST NOT forbids.
  const priceViolation = receiptPriceViolation(repoDir);
  if (priceViolation === "no-token" || priceViolation === "not-a-lane") {
    const namedLane = receiptNamedLane(repoDir);
    clearTimeout(_timeout);
    return emit({
      hookEvent: "PreToolUse",
      severity: "block",
      what_happened:
        priceViolation === "not-a-lane"
          ? `WIP override REFUSED — the receipt ${RECEIPT_REL} names ` +
            `'${safeField(namedLane, "(none)", 60)}' as the lane it would land FIRST, but that is ` +
            `not an OPEN lane in this repo, so it would arm no debt and the next override would be free.`
          : `WIP override REFUSED — the receipt ${RECEIPT_REL} states a reason but names no lane ` +
            `to land FIRST, so it would arm no debt and the next override would be free.`,
      why:
        "wip-discipline/MUST-7 — an override is a DEBT, not a toll. The debt is what makes the " +
        "cheapest way to keep overriding identical to the cheapest way to stop needing to; a " +
        "receipt that names no lane opts out of it, which is why omitting the token was the " +
        "cheapest bypass in the mechanism.",
      agent_must_report: [
        // The remedy names a REAL lane from this repo rather than a placeholder. The
        // first cut printed a literal `<ref>`, which matches `[^\s,;]+` and names no
        // open lane — so an agent pasting the message verbatim satisfied the FORM check
        // and armed ZERO debt. The refusal was teaching the bypass.
        `Add a \`land-first:\` line to ${RECEIPT_REL} naming an OPEN lane you will land FIRST — one of: ${openLaneExamples(repoDir)}. Then re-issue.`,
        `The lane must be one that is actually open: a name matching no open lane is REFUSED, because it would arm no debt at all. Naming a real lane you then do not land does not escape the price either — the NEXT override stays refused while it is still open.`,
        confirmedLine(confirm),
        ...(agedLine() ? [agedLine()] : []),
        `Your receipt was NOT consumed — it is still on disk and will be honoured as soon as it names a lane.`,
        DISPOSITION,
      ],
      agent_must_wait:
        "Do not re-issue until the receipt names a lane. Deleting and rewriting the receipt without the token changes nothing.",
      user_summary:
        priceViolation === "not-a-lane"
          ? `WIP override REFUSED — receipt's \`land-first:\` names no OPEN lane (${RECEIPT_REL})`
          : `WIP override REFUSED — receipt names no \`land-first:\` lane (${RECEIPT_REL})`,
    });
  }

  const consumed = gate.consumeReceipt();
  const reason = consumed ? consumed.reason : null;
  // ONE receipt covers whichever doors are open on this call. The local ceiling
  // has just spent it, so the remote hold is settled too — mark it rather than
  // consuming a second time (the file is already gone; a second consume would be
  // a no-op that still wrote a duplicate ledger row).
  if (consumed) markRemoteHoldSpent();
  // The override used to cost the same on its fourth use as on its first: a
  // one-line receipt, always available, never accumulating. At the moment of
  // maximum motivation to proceed, the COMPLIANT path (land a lane — unbounded,
  // needs a CI cycle) was strictly MORE EXPENSIVE than the BYPASS (one line,
  // instant). A guard whose bypass is cheaper than its remediation is a
  // suggestion, and it was used as one: four overrides in a single session while
  // the forest went 19 -> 21.
  //
  // So an override now creates a DEBT. Each honoured receipt records the lane the
  // operator named as the one they will land FIRST (`land-first: <ref>` in the
  // receipt body). The NEXT override is refused while that named lane is still
  // open. The escape is not another line of prose — it is landing the lane you
  // already promised. That makes the cheapest way to keep overriding identical to
  // the cheapest way to stop needing to.
  //
  // FAIL-OPEN, deliberately and narrowly: an unreadable, absent or malformed
  // ledger honours the receipt exactly as before. This mechanism exists to price
  // a bypass, not to become a second way to lose one — a guard that refuses on
  // its own bookkeeping failure is the dead end `hook-output-discipline.md`
  // forbids, and the WIP limit itself already fails OPEN on an underivable count.
  if (reason) {
    recordOverride(repoDir, reason);
    clearTimeout(_timeout);
    return emit({
      hookEvent: "PreToolUse",
      severity: "advisory",
      what_happened:
        `WIP gate OVERRIDDEN by the one-shot receipt ${RECEIPT_REL} (consumed, deleted). ` +
        `Stated reason: ${safeField(reason, "(none)", REASON_MAX)}` +
        remoteNote(),
      why: "wip-discipline/MUST-2 + MUST-3 — the override was honoured, not the gate. The receipt is spent; the next lane-opening call past a door blocks again.",
      agent_must_report: [
        `State in your next message that the WIP gate was overridden via the one-shot receipt, and quote the reason you wrote.`,
        confirmedLine(confirm),
        ...(agedLine() ? [agedLine()] : []),
        DISPOSITION,
      ],
      agent_must_wait:
        "You may proceed — this is advisory, not a block. Surface the override in your report.",
      user_summary: `WIP gate OVERRIDDEN via one-shot receipt — ${confirm ? `${confirm.confirmed}/${L.WIP_LIMIT} confirmed lanes open` : `age bound breached`}`,
    });
  }

  // TEETH — AGE (wip-discipline MUST-3). Taken when the count door is silent, so
  // the refusal names the axis that actually fired rather than a limit that is
  // not reached. When BOTH fire the COUNT block below carries the age line too,
  // because the count is the coarser and more familiar figure to lead with.
  if (!countBlocks) {
    clearTimeout(_timeout);
    return emit({
      hookEvent: "PreToolUse",
      severity: "block",
      what_happened:
        `${ACTOR} would open a NEW lane while '${aged.name}' has carried ` +
        `${aged.uniqueCommits} MEASURED unlanded commit(s) for ${fmtAge(aged.ageHours)} — ` +
        `past the ${L.AGE_BOUND_HOURS}h age bound. Open lanes: ${fast.count} (limit ${L.WIP_LIMIT}, not reached).`,
      why: "wip-discipline/MUST-3 — AGE governs, not COUNT. A lane past 24h is a DEFECT requiring a land-or-kill disposition, not a status to carry forward: lanes opened and closed within a session are healthy flow, lanes at days are rot. This axis REPORTED at SessionStart and did not prevent until now; measured, the aged lane was named at every session start for three days and dispositioned at none, which is the same 'a ceiling that reports is not a ceiling' finding the count door recorded in 2026-08-23.",
      agent_must_report: [
        `Name the lane and its age: '${aged.name}', ${fmtAge(aged.ageHours)} past the ${L.AGE_BOUND_HOURS}h bound, ${aged.uniqueCommits} unlanded commit(s).`,
        `State the age BASIS: the committer date of the OLDEST commit not yet landed on the trunk — decided by ${oneInstrument(aged.decidedBy)}, dated by git show — NOT the tip date and NOT directory mtime — mtime can only make rot look fresh (MUST-3 measured a 44h tree reading as 11.1h).`,
        `State the count for contrast: ${fast.count} open lane(s) against a limit of ${L.WIP_LIMIT}. The COUNT did not refuse this; the AGE bound did. That is MUST-3's whole claim — a repo can sit under every count and still be rotting.`,
        // The ages on THESE lines are TIP dates, a DIFFERENT and always-smaller
        // figure than the content age above — a lane touched a minute ago can
        // carry three-day-old unlanded work, which is the exact pair measured on
        // this tree when the age door was built. Labelled rather than silently
        // printed beside "3d", because two ages under one heading with no basis
        // named is the reader-confusion `wip-discipline.md` MUST-3 forbids.
        "Open lanes, with TIP age (time since LAST TOUCHED — not the content age above, which is what the bound is measured on):\n" +
          oldestLines(repoDir).join("\n"),
        DISPOSITION,
        `REMEDIATION (preferred) — LAND or KILL '${aged.name}', then re-issue this ${NOUN}. Landing means merge, then delete the branch AND remove its worktree; killing means record why, then delete both.`,
        overrideInstruction(gate),
      ],
      agent_must_wait: `Do not retry this ${NOUN} unmodified. Either disposition the past-bound lane (preferred) or write the one-shot receipt and retry.`,
      user_summary: `WIP AGE bound BREACHED: '${aged.name}' at ${fmtAge(aged.ageHours)} (bound ${L.AGE_BOUND_HOURS}h) — lane creation blocked; land or kill it, or write ${RECEIPT_REL}`,
    });
  }

  // TEETH — COUNT (wip-discipline MUST-2). The count is MEASURED, no override
  // was presented, and the dispatch has not run.
  clearTimeout(_timeout);
  return emit({
    hookEvent: "PreToolUse",
    severity: "block",
    what_happened:
      `${ACTOR} would open a NEW lane while ${confirm.confirmed} lane(s) already carry ` +
      `MEASURED unlanded content, at a WIP limit of ${L.WIP_LIMIT}. Confirmed lanes: ` +
      confirm.confirmedNames.join(", ") +
      `.`,
    why: "wip-discipline/MUST-2 — the WIP limit is a PULL signal: finish a lane to start a lane. Cycle time = WIP / throughput, so an unbounded lane count guarantees lanes older than anyone's memory. This surface NOTIFIED and did not prevent until 2026-08-23; measured, an orchestrator acknowledged the notice every time and took the forest 109 → 112 while it was firing, which is why it now refuses.",
    agent_must_report: [
      `State the confirmed count: ${confirm.confirmed} open lanes against a limit of ${L.WIP_LIMIT}, each with MEASURED unlanded content. Instruments that decided the scanned lanes: ${instrumentPhrase(confirm.decidedBy)}. This is a LOWER BOUND — the ancestry-unmerged UPPER BOUND is ${fast.count} — so the limit is genuinely reached, not an artefact of a rebased branch reading open.`,
      "Name the oldest open lanes:\n" + oldestLines(repoDir).join("\n"),
      ...(agedLine() ? [agedLine()] : []),
      DISPOSITION,
      `REMEDIATION (preferred) — LAND or KILL one existing lane, then re-issue this ${NOUN}. Landing means merge, then delete the branch AND remove its worktree; killing means record why, then delete both.`,
      overrideInstruction(gate),
    ],
    agent_must_wait: `Do not retry this ${NOUN} unmodified. Either disposition an existing lane (preferred) or write the one-shot receipt and retry.`,
    user_summary: `WIP limit REACHED: ${confirm.confirmed}/${L.WIP_LIMIT} confirmed lanes — dispatch blocked; land or kill one, or write ${RECEIPT_REL}`,
  });
}

// ── THE LANE CONTRACT + PER-LANE DEPTH AT SESSION START ─────────────────────
//
// journal/0607 decision 3 + journal/0608 item 6. A contract living only in rule
// prose reaches a session only if a path-scoped rule happens to load; in the
// session that received the directive the orchestrator had MUST-2 available and
// still briefed every lane as a single serial worker. Session start is where the
// subject exists — the ledger and the lanes are on disk before the first tool call
// (`hook-event-selection.md`) — so every session receives the contract here, with
// the depth report that makes an under-packed lane visible.
//
// ADVISORY and NEVER `block`: whether a lane can take more work is a judgment, and
// this reports ledger facts. When an aged lane ALSO exists, the MUST-3 report keeps
// its own verdict and `halt-and-report` severity; the contract rides along in it.

/** Three lines, citing the clause. */
const LANE_CONTRACT = [
  "LANE CONTRACT (wip-discipline/MUST-9): a lane is a MINI-ORCHESTRATOR, not a serial worker — it dispatches as many agents as its items support, in parallel, inside its one worktree.",
  "PACK BEFORE OPENING: fill open lanes with items and agents before any new worktree or branch is opened; bind a todo to its lane with `lane: <branch>` in its frontmatter.",
  "CEILINGS BIND WORKTREES AND BRANCHES, NEVER AGENTS: the WIP limit counts inventory, so another agent inside a lane costs no lane.",
];

/** A ledger-sourced value bounded for a context line (the shared sanitizer). */
function cleanField(v) {
  return safeField(String(v == null ? "" : v), "?", 160);
}

/** `a, b, c (+N more)` */
function nameList(arr, cap, fmt) {
  const shown = arr.slice(0, cap).map(fmt).join(", ");
  return arr.length > cap ? `${shown} (+${arr.length - cap} more)` : shown;
}

/**
 * The narrowing `laneDepth` performed, rendered BESIDE the figures it qualifies.
 *
 * `laneDepth` scopes its population to LIVE workspaces and carries what it set
 * aside in `counts.excludedMetaWorkspace` — DERIVED by the `const
 * excludedMetaWorkspace` narrowing inside `laneDepth`, RETURNED as that key on
 * its `counts` object, and DECLARED in prose in its `basis.items` string. Grep
 * those three symbols in `.claude/hooks/lib/wip-lanes.js`; the paired line
 * numbers are disposable hints (`:2938-2939`, `:3087`, `:3093`) and were
 * already stale once — a lane added ~446 lines above them — which is why the
 * SYMBOL is the anchor and the number is not. That declaration reaches a
 * READER of the object; it reached no reader of the RENDERED report, so "0
 * UNBOUND" read identically whether nothing was outstanding or a whole class had
 * been narrowed away — the absence-reads-as-clean shape `conservation-gate.md`
 * MUST-3 names, one layer above the lib that already fixed it.
 *
 * NAMES THE CLASS, NOT ONLY THE NUMBER: a bare count tells the reader something
 * was withheld without telling them what, which is an alarm rather than a
 * disclosure. EMPTY WHEN ZERO: an exclusion that did not happen is not a blind
 * spot, and a line every session carries is one the reader learns to skip.
 */
function excludedNote(counts) {
  const n = (counts && counts.excludedMetaWorkspace) || 0;
  return n
    ? `, EXCLUDED ${n} item(s) under a workspace META-directory (\`_archive\`, \`_template\`, \`_draft\`) — counted in NO class here`
    : "";
}

/** Render `wip-lanes.js::laneDepth` — UNDER-PACKED and UNBOUND always NAMED. */
function depthLines(d) {
  if (!d || d.ok !== true) {
    return [
      `LANE DEPTH UNKNOWN — ${cleanField((d && d.reason) || "not reported")}. This is NOT "no under-packed lanes": the lane set or the work ledger could not be read.`,
    ];
  }
  const c = d.counts;
  const rows = d.lanes
    .slice(0, 8)
    .map(
      (l) =>
        `    ${l.verdict} ${cleanField(l.lane)} — ${l.itemCount} item(s)` +
        (l.items.length ? `: ${nameList(l.items, 4, cleanField)}` : "") +
        `; agents ${l.agents === null ? "UNATTRIBUTED" : l.agents}`,
    );
  const out = [
    `LANE DEPTH — ${c.lanes} open lane(s), ${c.bound} bound item(s), ${c.queued} QUEUED, ${c.orphaned || 0} ORPHANED, ${c.unbound} UNBOUND${excludedNote(c)}` +
      (rows.length
        ? `:\n${rows.join("\n")}${d.lanes.length > 8 ? `\n    …and ${d.lanes.length - 8} more` : ""}`
        : "."),
  ];
  if (d.underPacked.length) {
    out.push(
      `UNDER-PACKED: ${nameList(d.underPacked, 8, cleanField)} — each carries at most one item while ${c.queued} item(s) are QUEUED. Pack queued items into these lanes before opening another worktree or branch.`,
    );
  }
  if (d.queued.length) {
    out.push(
      `QUEUED (${c.queued}) — outstanding items whose declared lane exists NOWHERE in this repository, so they are waiting for a lane to be opened: ${nameList(d.queued, 5, (q) => `${cleanField(q.id)} -> ${cleanField(q.lane)}`)}.`,
    );
  }
  if (Array.isArray(d.orphaned) && d.orphaned.length) {
    // ORPHANED IS REPORTED BUT DRIVES NOTHING. The item's lane LANDED, so no open
    // lane can absorb it — counting it as queued is what marked every serial lane
    // UNDER-PACKED. Named anyway: a stale binding is a disposition the operator
    // owes, and demoting a finding must never suppress it.
    out.push(
      `ORPHANED (${c.orphaned}) — outstanding items bound to a lane that LANDED; no open lane can absorb them, so they do NOT make any lane UNDER-PACKED. Re-bind or complete them: ${nameList(d.orphaned, 5, (q) => `${cleanField(q.id)} -> ${cleanField(q.lane)}`)}.`,
    );
  }
  if (d.unbound.length) {
    out.push(
      `UNBOUND (${c.unbound}) — outstanding items declaring no lane, counted in NO lane; which lane carries them is UNMEASURED: ${nameList(d.unbound, 5, (u) => cleanField(u.id))}.`,
    );
  }
  if (d.unknown.length) {
    const detail = (u) =>
      u.reason
        ? safeField(String(u.reason), "?", 400)
        : nameList(u.items || [], 3, (i) =>
            cleanField(
              `${i.id || i.rel || ""}${i.reason ? ` (${i.reason})` : ""}`,
            ),
          );
    out.push(
      `UNKNOWN — ${d.unknown.map((u) => `${u.class}${u.count === null ? "" : ` ${u.count}`}: ${detail(u)}`).join("; ")}.`,
    );
  }
  return out;
}

function runSessionStart(repoDir, sessionId) {
  // THE BOUND BINDS THE OPTIONAL HALF, WHICH IS THE ONLY HALF IT CAN BIND.
  //
  // The three contract lines are CONSTANTS — no git spawn, no ledger read — so no
  // amount of slowness is a reason to drop them, and the old code dropped them
  // anyway: depth was computed INSIDE `laneSurvey`, so an overrunning survey took
  // the contract down with it (or ran past the host's own kill, which emits
  // nothing at all). Splitting the two lets the expensive, OPTIONAL half sit
  // behind a deadline the cheap, MANDATORY half never waits on.
  const startedAt = Date.now();
  const survey = L.laneSurvey({ repoDir, classifyTop: 8, depth: false });
  const surveyed = Boolean(survey && survey.ok);
  const spent = Date.now() - startedAt;
  // FAIL OPEN WITH A TYPED UNKNOWN. An unanswerable survey used to pass through
  // silently; the contract is still owed, and the depth line says UNKNOWN.
  let depth;
  if (!surveyed) {
    depth = {
      ok: false,
      reason: `lane survey failed (${(survey && survey.reason) || "unknown"}${survey && survey.trunkReason ? `: ${survey.trunkReason}` : ""})`,
    };
  } else if (FORCE_DEPTH_TIMEOUT || spent >= DEPTH_BUDGET_MS) {
    depth = {
      ok: false,
      timedOut: true,
      // The forced arm states that it was FORCED rather than borrowing the
      // measured-overrun sentence. Reporting a real elapsed comparison that
      // never happened would make the fixture's own evidence a fiction.
      reason: FORCE_DEPTH_TIMEOUT
        ? `timed out — the deadline branch was FORCED via COC_WIP_GUARD_FORCE_DEPTH_TIMEOUT (test seam), so the work ledger was NOT read and the depth report was skipped to deliver the contract`
        : `timed out — the lane survey spent ${spent} ms against this guard's ${DEPTH_BUDGET_MS} ms bound, so the work ledger was NOT read and the depth report was skipped to deliver the contract`,
    };
  } else {
    // THE AGENT JOIN IS FENCED TO THIS SESSION. `laneDepth` counts dispatches
    // from the per-session dispatch ledger; handing it the harness's own session
    // id is what makes "0 agents" a MEASURED zero for THIS session rather than a
    // read of whichever sink an env var happened to name.
    try {
      depth = L.laneDepth({
        repoDir,
        openLanes: survey.lanes.map((l) => l.name),
        sessionId:
          typeof sessionId === "string" && sessionId ? sessionId : null,
      });
    } catch (e) {
      depth = {
        ok: false,
        reason: `lane-depth-threw: ${(e && e.message) || e}`,
      };
    }
  }
  const laneReport = [...LANE_CONTRACT, ...depthLines(depth)];

  const aged = surveyed ? L.agedLanes(survey.lanes, L.AGE_BOUND_HOURS) : [];
  if (aged.length === 0) {
    const under = depth.ok ? depth.underPacked : [];
    clearTimeout(_timeout);
    return emit({
      hookEvent: "SessionStart",
      severity: "advisory",
      what_happened: depth.ok
        ? `Lane contract delivered. Lane depth: ${depth.counts.lanes} open lane(s), ${under.length} UNDER-PACKED, ${depth.counts.queued} QUEUED, ${depth.counts.unbound} UNBOUND item(s)${excludedNote(depth.counts)}.`
        : `Lane contract delivered. Lane depth UNKNOWN: ${cleanField(depth.reason)}.`,
      why: "wip-discipline/MUST-9 — lanes are mini-orchestrators: the WIP ceiling counts worktrees and branches, never agents, so depth is packed into the open lanes before another opens (journal/0607 decision 3, delivered at session start per journal/0608). Advisory: whether a lane can take more work is a judgment; this reports ledger facts and never blocks.",
      agent_must_report: laneReport,
      agent_must_wait:
        "Before opening any new worktree or branch this session, pack the lanes named UNDER-PACKED — bind queued items to them and dispatch agents inside them — and bind the UNBOUND items you plan to work.",
      ...(under.length
        ? {
            user_summary: `WIP lanes: ${under.length} UNDER-PACKED (${nameList(under, 3, cleanField)}) — pack them before opening another lane`,
          }
        : {}),
    });
  }

  const dist = L.ageDistribution(survey.lanes);
  const worst = aged
    .slice(0, 8)
    .map(
      (l) =>
        `  - ${l.name} — ${fmtAge(l.ageHours)}${
          l.uniqueCommits !== null
            ? `, ${l.uniqueCommits} unlanded commit(s)`
            : ""
        }${l.localOnly ? ", LOCAL-ONLY (exists in this clone only)" : ""}`,
    );

  clearTimeout(_timeout);
  return emit({
    hookEvent: "SessionStart",
    severity: "halt-and-report",
    what_happened:
      `${aged.length} lane(s) are past the ${L.AGE_BOUND_HOURS}h age bound` +
      (dist
        ? ` (p50 ${fmtAge(dist.p50)}, max ${fmtAge(dist.max)}, ${survey.localOnly} LOCAL-ONLY).`
        : "."),
    why: "wip-discipline/MUST-3 — a lane past the age bound is a DEFECT requiring a land-or-kill disposition, not a status to carry forward. Age governs, not count: lanes opened and closed within a session are healthy flow; lanes at weeks are rot.",
    agent_must_report: [
      `State the age distribution, NOT a bare count — p50 ${dist ? fmtAge(dist.p50) : "?"}, p90 ${dist ? fmtAge(dist.p90) : "?"}, max ${dist ? fmtAge(dist.max) : "?"}; ${aged.length} past ${L.AGE_BOUND_HOURS}h.`,
      "Name the oldest lanes:\n" + worst.join("\n"),
      DISPOSITION,
      `Bounds, stated so the operator can act on the right number: the count is an UPPER BOUND (ancestry-unmerged), age is the TIP committer date (time since last touched, not time open), and LOCAL-ONLY is decided by tip-SHA membership in the remote set — a branch pushed then advanced locally reads LOCAL-ONLY. Only ${survey.classified} lane(s) carry exact unlanded-commit counts.`,
      "Ask the operator to disposition the aged lanes, or propose a land-or-kill split for their approval. Do NOT delete any branch or worktree carrying unique unpushed content to reduce the number.",
      ...laneReport,
    ],
    agent_must_wait:
      "Surface this at the start of the session so it is acted on rather than carried. The operator decides; you propose.",
    user_summary: `WIP: ${aged.length} lane(s) past ${L.AGE_BOUND_HOURS}h (max ${dist ? fmtAge(dist.max) : "?"}, ${survey.localOnly} local-only) — land or kill`,
  });
}

function run(payload) {
  const event = payload.hook_event_name || payload.hookEventName || "";
  const repoDir = payload.cwd || process.cwd();

  if (event === "SessionStart")
    return runSessionStart(
      repoDir,
      payload.session_id || payload.sessionId || null,
    );

  // THE EVENT IS GATED EXPLICITLY, not inferred from the tool name.
  //
  // Measured defect, caught by the stay-silent pole: without this check the
  // dispatch fell through to the tool test for EVERY non-SessionStart event, so
  // `PostToolUse:Task` fired the spawn guard — a report that the lane "is about
  // to open" delivered AFTER it had already opened. The guard is registered at
  // PreToolUse only, but a hook must not depend on its registration to be
  // correct: `hook-event-selection.md` MUST-4 requires the marker and the
  // registration to agree, and this makes the code agree with both.
  if (event !== "PreToolUse") return passthrough();

  const tool = payload.tool_name || "";

  // THE ONLY DOOR, and the only one it ever needed to be. MUST-2 says "Opening
  // at the limit is REFUSED", unqualified, and this guard once implemented it for
  // agent spawns ALONE — so the ceiling was consulted only when an AGENT opened a
  // lane and never when a human or an agent opened one with git directly.
  // Measured on this repo: 33 worktrees and 43 branches against a limit of 5,
  // with the ceiling refusing nothing, because essentially every lane was created
  // from Bash. That is `security.md` § Enforcement-Surface Parity — a control
  // promoted at one surface that an independent surface never learned — and it is
  // why the rule's own MUST read as satisfied while the forest grew unbounded.
  // The spawn arm that produced that reading is GONE — the file-header
  // hook-event declaration for PreToolUse:Bash (top of this file) records its
  // removal, both dates, and why. This is the whole ceiling. (That reference
  // deliberately omits the marker sigil: this comment MENTIONS the token, it
  // does not DECLARE one, and `validate-emit.mjs::checkHookEventDeclaration`
  // scans the WHOLE file, so a sigil-bearing prose mention parses as a third,
  // malformed declaration.)
  //
  // The lexical match only selects WHICH QUESTION to ask; the answer still comes
  // from measured git process state in `runSpawnGuard`. That is what lets this
  // path carry `block` under `hook-output-discipline.md` MUST-2 — a command that
  // merely MENTIONS `git worktree add` inside a string cannot trip it, and a
  // session under the limit is never refused either way.
  if (tool === "Bash") {
    const intent = L.laneCreationIntent(
      (payload.tool_input && payload.tool_input.command) || "",
    );
    if (!intent.creates) return passthrough();
    // INVENTORY, never WORKERS. `git worktree add <path> <existing-branch>`
    // attaches a worker to a branch that already exists; it changes no branch's
    // content, so the count of branches-carrying-unlanded-content is identical
    // before and after. Refusing it made the ceiling block its own drain — the
    // guard's own refusal text listed the target branch among the counted lanes
    // while refusing to let a worker be attached to it.
    //
    // FAILS CLOSED, deliberately: `_git` returns null on a missing ref, a
    // missing git binary, a timeout, or any non-zero exit, and every one of
    // those falls through to the guard. Only a POSITIVE resolution to an
    // existing LOCAL branch (`refs/heads/`) skips it — a tag, a bare SHA, or an
    // unresolvable name is treated as creating.
    if (intent.attachTo) {
      const resolved = L._git(
        ["rev-parse", "--verify", "--quiet", `refs/heads/${intent.attachTo}`],
        { cwd: repoDir },
      );
      if (resolved) return passthrough();
    }
    return runSpawnGuard(repoDir, {
      noun: "command",
      how: intent.how,
      remoteDoor: true,
    });
  }

  return passthrough();
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). Everything a standalone run
// did at load time happens here instead, so a require() has no side effects.
function hookMain() {
  _timeout = setTimeout(() => {
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    process.exit(1);
  }, TIMEOUT_MS);
  if (_libLoadFailed) return Promise.resolve(passthrough());
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.on("error", passthrough);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (input += d));
    process.stdin.on("end", () => {
      try {
        onStdinEnd(input);
      } catch (e) {
        return reject(e);
      }
      resolve();
    });
  });
}

function onStdinEnd(input) {
  // THE FALLBACK TIMER STAYS LIVE THROUGH THE DECISION. It used to be cleared
  // HERE, before `run()` — so every git spawn below ran with no internal
  // fail-open at all, and an overrun was left to the host's own kill, which
  // produces NO output rather than `{continue:true}`. Now each terminal path
  // clears it immediately before emitting. THE HONEST BOUND, CORRECTED: this
  // note used to say the timer "fires in the gaps between" git calls. It does
  // not. `spawnSync` blocks the event loop AND `run()` is synchronous end to
  // end, so the stack never unwinds between calls and no timer callback is ever
  // scheduled once `run()` starts — measured, three invocations at 300/900/1500
  // ms bounds each ran 4–5 s to a full report. This timer bounds the wait for
  // STDIN. The per-call `timeout:` values in `wip-lanes.js` bound each git call,
  // and the deadline check in `runSessionStart` bounds their accumulation.
  try {
    run(JSON.parse(input || "{}"));
  } catch (e) {
    clearTimeout(_timeout);
    process.stderr.write(`[wip-discipline-guard] HOOK ERROR: ${e.message}\n`);
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    process.exit(1);
  }
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
