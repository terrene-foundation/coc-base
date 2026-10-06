"use strict";
/**
 * dispatch-freshness — IS THE BASE THESE LANES ARE ABOUT TO BE CUT FROM STILL CURRENT?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE INCIDENT THIS ANSWERS, and why it is a DISPATCH-time question
 * ─────────────────────────────────────────────────────────────────────────────
 * MEASURED elsewhere, 2026-09-12/13: a 32-lane wave ran against a tree whose tip was dated
 * 2026-08-19 — 25 days and 3,850 commits stale. Of the 134 issues it triaged, 53 (40%) had
 * closed in the interim: 53 closed AFTER the snapshot date, 0 before. That clean 0/53 split
 * IS the diagnosis. The wave was perfectly consistent WITH ITS SNAPSHOT, so nothing inside it
 * looked wrong; one lane recommended closing an issue that had closed as COMPLETED three weeks
 * earlier, and ~40% of the wave's output was unactionable.
 *
 * EVERY LANE MEASURED ITS OWN TREE CORRECTLY. `git status` clean, `git log` real, files present
 * — and all of it superseded. Staleness is not a property of any lane, so no per-agent reminder
 * can reach it: the agent is the WRONG OBSERVER. It is a property of THE BASE they were all cut
 * from, and it is decided ONCE, before the first lane exists. That is why this predicate is
 * consumed by a PreToolUse guard on the delegation tools and never by anything inside an agent.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PREDICATE — one command, NO NETWORK
 * ─────────────────────────────────────────────────────────────────────────────
 *     git log -1 --format=%ct refs/remotes/origin/<trunk>
 *
 * A remote-tracking ref is only as fresh as the LAST FETCH, so its tip age measures OFFLINE how
 * stale a lane cut from it would be.
 *
 * THERE IS DELIBERATELY NO `git fetch` HERE, and that is a design decision rather than an
 * omission. A network call inside a dispatch hook can HANG EVERY DISPATCH, and a guard that makes
 * the common case slow is a guard the operator disables — after which it protects nothing.
 * Reading a purely local ref UNDER-reports and never over-reports, which is the safe direction:
 * a stale ref that has not been fetched reads AT LEAST as old as the truth, never younger.
 *
 * ONE LINEAGE, NOT TWO. The trunk is resolved by `lib/trunk-ref.js::resolveTrunk` and the git
 * binary + child environment come from `lib/git-subprocess-env.js`. Neither is re-implemented
 * here: two lineages that can disagree about which ref is the trunk is the enforcement-surface
 * parity defect (`rules/security.md` § Enforcement-Surface Parity) that this repo is actively
 * closing, one level down.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FOUR STATES, AND THE THIRD ONE IS THE WHOLE POINT
 * ─────────────────────────────────────────────────────────────────────────────
 *   "stale"         the tip is older than the threshold                  → the guard SPEAKS
 *   "fresh"         the tip is within the threshold                      → SILENT
 *   "undetermined"  the probe COULD NOT ANSWER (timeout, git missing,
 *                   unreadable ref, unparseable output)                  → the guard SPEAKS
 *   "absent"        there is no `refs/remotes/origin/<trunk>` at all     → SILENT, deliberately
 *
 * UNDETERMINED IS NEVER COLLAPSED INTO "fresh". An unanswerable probe and a current trunk are
 * byte-identical in a "proceed" response, and that is exactly how a guard stops guarding without
 * anyone noticing (`rules/instrument-discipline.md` MUST-1: a result consistent with both
 * branches of the hypothesis carries zero information).
 *
 * ABSENT IS SILENT, ALSO DELIBERATELY. A repository with no remote-tracking trunk — a fresh
 * `git init`, a fixture, a consumer that never added a remote — has nothing to be stale about,
 * and a guard that speaks on every dispatch trains the operator to skim past it. That silence is
 * the ABSENCE OF AN INSTRUMENT, not an all-clear (`instrument-discipline.md` MUST-3(a)), and the
 * header of the consuming hook says so where a reader will meet it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SEVERITY — `advisory`, and never `block`
 * ─────────────────────────────────────────────────────────────────────────────
 * The inputs are pure git PROCESS STATE — an integer from `git log --format=%ct` and a ref
 * probe — which `hook-output-discipline.md` MUST-2 would ordinarily permit to carry teeth. They
 * are not taken, because the READING is genuinely ambiguous: a quiet trunk and an unfetched ref
 * produce the SAME number, and only a human knows which one this is. Advisory suffices precisely
 * BECAUSE it fires before the decision — the cost of being right is one `git fetch`, and the cost
 * of being wrong (refusing a dispatch against a legitimately quiet trunk) is a guard that gets
 * turned off.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES NOT DO — carried openly, not quietly omitted
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. It does NOT detect a stale ISSUE LIST or tracker snapshot — only a stale TREE. The message
 *      tells the operator to re-derive; NOTHING here enforces it. The tree and the tracker go
 *      stale TOGETHER, which is what made the incident's 0/53 split read as internal consistency
 *      rather than as a warning.
 *   2. It UNDER-REPORTS BY CONSTRUCTION. A quiet trunk looks stale; a just-fetched trunk looks
 *      fresh even if the remote moved one second later. Offline is the trade, and it is the
 *      trade that keeps the guard fast enough to stay enabled.
 *   3. It measures the ORCHESTRATOR'S box — the repository the dispatching process sits in — not
 *      the base each lane actually receives. A lane handed an explicit older ref is invisible here.
 *   4. It CANNOT TELL "quiet" FROM "unfetched". That is precisely why it advises rather than
 *      refuses.
 *
 * Origin: co-owner-authorized, 2026-09-13. The rule_ids below are MECHANISM-LOCAL: no rule clause
 * in the corpus owns this contract yet, so they are deliberately namespaced to this detector
 * rather than attributed to a clause that would not be found if a reader went looking.
 */

const { execFileSync } = require("node:child_process");
const { resolveGitBinary, gitEnv } = require("./git-subprocess-env.js");
const { resolveTrunk, probeRef } = require("./trunk-ref.js");

/** The delegation tools. The dispatch IS the subject; nothing else is inspected. */
const DELEGATION_TOOLS = Object.freeze(["Task", "Agent"]);

/** 72 hours — three days of unfetched trunk is where the incident's class begins. */
const DEFAULT_THRESHOLD_HOURS = 72;

/**
 * INJECTABLE, and not as a convenience. A threshold no test can cross is a threshold nobody has
 * ever checked: with the bound hard-coded, the only way to exercise the firing arm is to wait
 * three days, so in practice it is exercised never. The fixtures drive both poles across an
 * injected bound (5d tip vs 3d ⇒ fires, 5d tip vs 10d ⇒ silent) on the SAME repository, which is
 * what makes the comparison itself — and not merely the repo — the thing under test.
 */
const THRESHOLD_ENV = "COC_DISPATCH_FRESHNESS_HOURS";

/** Total budget for BOTH git calls. Well under the consuming hook's own fallback timer. */
const DEFAULT_BUDGET_MS = 2500;

const SECONDS_PER_DAY = 86400;

/**
 * The threshold in hours, and WHERE it came from.
 *
 * A malformed, zero, negative or non-finite value falls back to the default rather than being
 * honoured: `COC_DISPATCH_FRESHNESS_HOURS=0` would make every dispatch stale and
 * `=-1` would make none of them stale, and silently accepting either is how an env typo disarms
 * or jams a guard. The SOURCE is returned so a report can say which bound it used.
 *
 * @returns {{hours:number, source:"env"|"default", raw:string|null}}
 */
function resolveThresholdHours(env = process.env) {
  const raw = env && typeof env[THRESHOLD_ENV] === "string" ? env[THRESHOLD_ENV] : null;
  if (raw !== null && raw.trim() !== "") {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n > 0) return { hours: n, source: "env", raw };
  }
  return { hours: DEFAULT_THRESHOLD_HOURS, source: "default", raw };
}

/**
 * The full refname for a ref the trunk resolver named.
 *
 * The predicate is specified against `refs/remotes/origin/<trunk>`, so the short `origin/dev`
 * form the resolver returns is expanded here rather than left to git's DWIM: a LOCAL branch
 * literally named `origin/dev` would otherwise win the DWIM order and the probe would measure the
 * wrong object. A `COC_TRUNK_REF` override that is already fully qualified is passed through
 * untouched; one that is not gets the same remote expansion, so an override naming a purely local
 * branch resolves to a ref that does not exist and the verdict is ABSENT — silence, the
 * under-reporting direction, never a false stale.
 */
function fullRefName(ref) {
  if (typeof ref !== "string" || ref === "") return null;
  return ref.startsWith("refs/") ? ref : `refs/remotes/${ref}`;
}

/**
 * Read the tip commit time of `ref` as epoch seconds.
 *
 * @returns {{ok:true, epoch:number} | {ok:false, timedOut:boolean, noGit:boolean}}
 */
function readTipEpoch(repoDir, ref, timeoutMs, opts = {}) {
  const bounded = Number.isFinite(timeoutMs);
  if (bounded && timeoutMs <= 0) return { ok: false, timedOut: true, noGit: false };
  const gitBin = resolveGitBinary(opts.gitBin ? { gitBin: opts.gitBin } : undefined);
  if (!gitBin) return { ok: false, timedOut: false, noGit: true };
  try {
    const out = execFileSync(gitBin, ["log", "-1", "--format=%ct", ref], {
      cwd: repoDir,
      encoding: "utf8",
      env: gitEnv(),
      stdio: ["ignore", "pipe", "ignore"],
      ...(bounded ? { timeout: Math.max(1, Math.floor(timeoutMs)), killSignal: "SIGKILL" } : {}),
    });
    const n = Number.parseInt(String(out).trim(), 10);
    // An unparseable stdout is NOT a zero and NOT a "fresh" — it is an unanswered probe.
    if (!Number.isFinite(n)) return { ok: false, timedOut: false, noGit: false };
    return { ok: true, epoch: n };
  } catch (e) {
    // A bounded spawn killed by its timeout carries ETIMEDOUT, or a signal with no exit status.
    const timedOut =
      bounded && Boolean(e && (e.code === "ETIMEDOUT" || (e.signal && e.status === null)));
    return { ok: false, timedOut, noGit: Boolean(e && e.code === "ENOENT") };
  }
}

/**
 * THE MEASUREMENT. Offline, bounded, four-valued.
 *
 * @param {object} [o]
 * @param {string} [o.repoDir]      the ORCHESTRATOR's repository (never a lane's)
 * @param {number} [o.nowEpoch]     injectable clock, seconds
 * @param {number} [o.thresholdHours]
 * @param {number} [o.budgetMs]     total for BOTH git calls
 * @param {string} [o.gitBin]       test seam: an absolute git-shaped binary for the tip probe
 * @returns {{state:"stale"|"fresh"|"undetermined"|"absent", ref:string|null,
 *            tipEpoch:number|null, ageSeconds:number|null, ageDays:number|null,
 *            thresholdHours:number, reason:string|null}}
 */
function measureTrunkFreshness(o = {}) {
  const repoDir = o.repoDir || process.cwd();
  const nowEpoch = Number.isFinite(o.nowEpoch) ? o.nowEpoch : Math.floor(Date.now() / 1000);
  const thresholdHours = Number.isFinite(o.thresholdHours) && o.thresholdHours > 0
    ? o.thresholdHours
    : resolveThresholdHours(o.env).hours;
  const budgetMs = Number.isFinite(o.budgetMs) ? o.budgetMs : DEFAULT_BUDGET_MS;
  const startedAt = Date.now();
  const left = () => budgetMs - (Date.now() - startedAt);

  const base = {
    state: "undetermined",
    ref: null,
    tipEpoch: null,
    ageSeconds: null,
    ageDays: null,
    thresholdHours,
    reason: null,
  };

  // ── 1. WHICH ref is the trunk. The shared resolver, never a second ladder.
  let t;
  try {
    t = resolveTrunk({ repoDir, timeoutMs: left() });
  } catch (e) {
    return { ...base, reason: `the trunk resolver threw (${e && e.message})` };
  }
  if (!t || t.status !== "resolved") {
    // The resolver's own THIRD verdict, carried through rather than flattened: it could not
    // measure, so neither can this.
    return { ...base, ref: (t && t.asked) || null, reason: (t && t.reason) || "the trunk could not be resolved" };
  }
  const ref = fullRefName(t.ref);
  if (!ref) return { ...base, reason: "the resolved trunk has no usable ref name" };

  // ── 2. HOW OLD its tip is.
  const tip = readTipEpoch(repoDir, ref, left(), o);
  if (tip.ok) {
    const ageSeconds = nowEpoch - tip.epoch;
    const ageDays = Math.round((ageSeconds / SECONDS_PER_DAY) * 10) / 10;
    // A tip in the FUTURE (clock skew, a backdated fixture, a rewritten date) is not stale.
    const stale = ageSeconds >= thresholdHours * 3600;
    return {
      state: stale ? "stale" : "fresh",
      ref,
      tipEpoch: tip.epoch,
      ageSeconds,
      ageDays,
      thresholdHours,
      reason: null,
    };
  }

  // ── 3. The probe failed. DISAMBIGUATE — this is the discriminator the whole design rests on.
  // A timeout or a missing git binary is UNDETERMINED and must never be re-probed: the second
  // probe would answer a question the first one already showed we have no budget or binary for.
  if (tip.timedOut) {
    return { ...base, ref, reason: `the ${budgetMs}ms probe budget was spent before the tip of ${ref} could be read` };
  }
  if (tip.noGit) {
    return { ...base, ref, reason: "git could not be resolved or run in this repository" };
  }
  // Everything else: ask the shared three-valued ref probe whether the ref is GENUINELY ABSENT
  // (a repository with no remote-tracking trunk — silence) or merely unreadable (UNDETERMINED).
  let verdict;
  try {
    verdict = probeRef(repoDir, ref, { timeoutMs: left() });
  } catch {
    verdict = "undetermined";
  }
  if (verdict === "absent") {
    return { ...base, state: "absent", ref, reason: `${ref} does not exist in this repository` };
  }
  return { ...base, ref, reason: `the tip of ${ref} could not be read` };
}

/** Bound evidence so an advisory never carries an unbounded string. */
const EVIDENCE_MAX = 300;
function clip(s) {
  const flat = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return flat.length > EVIDENCE_MAX ? flat.slice(0, EVIDENCE_MAX) + "…" : flat;
}

/** ISO date (UTC, day precision) for an epoch — what the operator compares against. */
function tipDateOf(epoch) {
  if (!Number.isFinite(epoch)) return "unknown";
  return new Date(epoch * 1000).toISOString().slice(0, 10);
}

/**
 * THE FOUR THINGS THE MESSAGE SAYS. Built here, not in the hook, so the fixtures can assert each
 * one independently of the renderer.
 *
 *   (a) the ref, its tip date, and its age in days
 *   (b) `git fetch origin` and re-check before dispatching
 *   (c) an explicit OUT — if the trunk really is quiet and the age is correct, say so
 *   (d) ⚠️ RE-DERIVE any issue list or tracker snapshot feeding the wave
 *
 * (d) IS THE MOST DROPPABLE AND COST THE MOST. The tree and the tracker go stale TOGETHER; that
 * is what made the incident's 0/53 split read as internal consistency rather than as a warning.
 * A reader tempted to trim this list should trim (c) before (d), and neither.
 */
function remediationLines(m) {
  return [
    `(a) BASE MEASURED: ${m.ref} tip is dated ${tipDateOf(m.tipEpoch)} — ${m.ageDays} days old, ` +
      `against a ${m.thresholdHours}h threshold. Every lane you are about to dispatch is cut from that base.`,
    "(b) RE-CHECK FIRST: run `git fetch origin` and re-read the tip before dispatching. This guard " +
      "is deliberately offline — it read a local remote-tracking ref and made no network call — so " +
      "the number above is a LOWER BOUND on how stale the base is.",
    "(c) THE OUT: if the trunk genuinely is quiet and that age is correct, say so in one line and " +
      "proceed. An old tip and an unfetched ref are indistinguishable from here, and only you can " +
      "tell which this is — that stated line is the record for this tier.",
    "(d) ⚠️ RE-DERIVE THE INPUTS: any issue list, tracker snapshot, search result or burndown page " +
      "feeding this wave was gathered against the SAME stale view and is stale WITH it. Re-derive " +
      "it now. This guard measures the TREE only and enforces nothing about the list — in the " +
      "incident this exists for, 53 of 134 triaged issues had already closed, 53 after the snapshot " +
      "date and 0 before, and that perfect consistency is exactly why nothing inside the wave " +
      "looked wrong.",
  ];
}

/** The same four points, in the shape an UNDETERMINED probe can honestly make. */
function undeterminedLines(m) {
  return [
    `(a) BASE NOT MEASURED: ${m.ref ? `${m.ref} — ` : ""}${clip(m.reason || "the probe could not answer")}. ` +
      "This is UNDETERMINED, not fresh: no reading here supports treating the base as up to date.",
    "(b) RE-CHECK FIRST: run `git fetch origin` and read the trunk tip yourself before dispatching.",
    "(c) THE OUT: if you have just fetched and know the base is current, say so in one line and " +
      "proceed — that stated line is the record for this tier.",
    "(d) ⚠️ RE-DERIVE THE INPUTS: any issue list or tracker snapshot feeding this wave goes stale " +
      "with the tree. An unanswerable freshness probe is the absence of an instrument, never an " +
      "all-clear, so treat the inputs as unverified rather than as checked.",
  ];
}

const RULE_ID_STALE = "dispatch-freshness/base-tip-age";
const RULE_ID_UNDETERMINED = "dispatch-freshness/probe-undetermined";

/**
 * THE AGGREGATOR the hook consumes. A predicate no aggregator calls is inert.
 *
 * @param {string} tool  the dispatching tool name
 * @param {object} m     a `measureTrunkFreshness` result
 * @returns {Array<{rule_id:string, severity:"advisory", state:string, evidence:string, lines:string[]}>}
 */
function inspectDispatchFreshness(tool, m) {
  // THE DISPATCH-TOOL GATE. Belt to the matcher's suspenders: a registration mistake that points
  // this hook at `*` must not make it fire on every Read and Bash.
  if (!DELEGATION_TOOLS.includes(tool)) return [];
  if (!m || typeof m !== "object") return [];

  if (m.state === "stale") {
    return [{
      rule_id: RULE_ID_STALE,
      severity: "advisory",
      state: "stale",
      evidence: clip(
        `${m.ref} tip dated ${tipDateOf(m.tipEpoch)} is ${m.ageDays}d old, over the ` +
          `${m.thresholdHours}h threshold — the base every lane in this wave is cut from`,
      ),
      lines: remediationLines(m),
    }];
  }
  if (m.state === "undetermined") {
    return [{
      rule_id: RULE_ID_UNDETERMINED,
      severity: "advisory",
      state: "undetermined",
      evidence: clip(
        `the trunk tip could not be measured (${m.reason || "no reason recorded"}) — UNDETERMINED, not fresh`,
      ),
      lines: undeterminedLines(m),
    }];
  }
  // "fresh" and "absent" are both SILENT. They are NOT the same thing and the distinction is kept
  // in `m.state` for a caller that wants it: one is a measurement, the other is the absence of an
  // instrument.
  return [];
}

module.exports = {
  DELEGATION_TOOLS,
  DEFAULT_THRESHOLD_HOURS,
  DEFAULT_BUDGET_MS,
  THRESHOLD_ENV,
  RULE_ID_STALE,
  RULE_ID_UNDETERMINED,
  EVIDENCE_MAX,
  resolveThresholdHours,
  fullRefName,
  readTipEpoch,
  measureTrunkFreshness,
  inspectDispatchFreshness,
  remediationLines,
  undeterminedLines,
  tipDateOf,
  clip,
};
