#!/usr/bin/env node
/**
 * reap-on-landing-guard.js — PostToolUse(Bash) enforcement surface for
 * `wip-discipline.md` MUST-4 ("Done means LANDED AND CLEANED — And CLEANED
 * Includes The REMOTE Ref").
 *
 * @hook-event: PostToolUse:Bash (verification) — the subject is a branch that
 *   ALREADY became reapable, which exists only AFTER the merge command has run,
 *   so `PostToolUse` is the earliest event that can see it; `Bash` is the only
 *   tool that can execute `gh pr merge`. This is the instant at which a
 *   branch STOPS being work-in-progress and STARTS being garbage. MUST-4 has
 *   been in force for weeks and 89 remote refs stood on this repo when this was
 *   written (18 of them classified LANDED-CONTENT by `remote-ref-reap.mjs`), so
 *   the obligation existed with nothing firing at the moment it comes due.
 *   `wrapup-after-landing.js` already demonstrates this trigger works; it
 *   speaks only about `.session-notes`.
 *
 * WHY `halt-and-report` AND NOT `advisory`, reconciled with the rule that
 * bounds it. `hook-output-discipline.md` MUST-2 bars **`block`** on lexical
 * evidence and NOTHING MORE — the in-corpus reconciliation is
 * `agents.md` § Agent-Result-Delivery, which carries `halt-and-report` on a
 * predicate that is half lexical. The split here is the same and is the whole
 * design:
 *   the TRIGGER is lexical (a `gh pr merge` substring, segment-anchored) and so
 *     can over-fire on a quoted literal;
 *   the FINDING is STRUCTURAL — `git cherry` patch-ids and `git for-each-ref`
 *     are git-object facts, not an inference over prose, and a spurious trigger
 *     with nothing reapable produces SILENCE rather than a false refusal.
 * So the lexical half can only cost a wasted query, never a wrong report. That
 * is why `block` is still refused and `advisory` is still too weak: the corpus
 * has measured three cycles of advisory-and-ignored on the sibling class.
 *
 * WHY IT MAY REFUSE, against the producer test:
 *   STRUCTURAL — the local half reads the LANDING PROVENANCE recorded in the
 *     trailers on the base (`lib/landed-map.js::landedVerdict`) first, and
 *     falls back to content-reaches-the-base by PATCH-ID (`git cherry`) only
 *     where that verdict permits (`lib/reap-on-landing.js::measureLocalByProvenance`);
 *     both are read off git objects. NOT ancestry: `git branch --merged` is
 *     false-negative under squash merges and measured 0-of-18 here.
 *   AGENT-CLEARABLE — the exact commands are printed and are inside the
 *     envelope; no human decision is required to delete a landed branch.
 *   LOW-FALSE-POSITIVE — the base read is local, so staleness makes the guard
 *     UNDER-report; the current branch, every branch checked out in a worktree,
 *     the trunk branch itself and the protected names are excluded.
 *
 * THE BASE IS THE INTEGRATION TRUNK, via the ONE shared resolver
 * (`hooks/lib/trunk-ref.js`; `wip-discipline.md` MUST-4). It was a hardcoded
 * `origin/main`, so a branch that landed on `dev` read UNLANDED and was never
 * proposed. The DELETION-GRADE resolver, not the lenient `trunkRef` string and
 * not `resolveTrunk` either: `trunk-ref.js:139-155` records that `resolveTrunk`
 * accepts a `COC_TRUNK_REF` override on the sole evidence that it RESOLVES,
 * which is the right bar for READING landedness (a wrong base under-reports) and
 * the WRONG bar once the answer PROPOSES A DELETION (a base that merely CONTAINS
 * every lane's content makes every lane read landed). `resolveTrunkForDeletion`
 * adds the corroboration this guard needs, and its THIRD verdict `"unverified"`
 * is handled distinctly from `"undetermined"`: both withhold every delete
 * proposal, and NEITHER goes silent — the base is named UNVERIFIED and both
 * halves are reported NOT RUN, never silently measured against main.
 *
 * FAIL-OPEN, ALWAYS. Every error path and an unreadable git tree yield
 * `{continue:true}`. A cleanup nudge must never wedge a session. But a pass
 * that RAN and did not finish is not silent: it names what it did not measure.
 */

const path = require("path");
const { execFileSync } = require("child_process");
const { resolveGitBinary, gitEnv } = require(
  path.join(__dirname, "lib", "git-subprocess-env.js"),
);
const { resolveTrunkForDeletion } = require(
  path.join(__dirname, "lib", "trunk-ref.js"),
);

// cc-artifacts.md Rule 7 — timeout fallback that never hangs the session.
// Exit 1 (not 0) keeps a timeout-fired passthrough distinguishable in logs.
//
// It stays LIVE through the decision. It used to be cleared the moment stdin
// ended — before the first git call — so nothing internal bounded the loop
// that followed. HONEST LIMIT, stated so it is not over-read: the decision is
// synchronous (`execFileSync`), and a timer callback runs only when the stack
// is empty, so this timer cannot preempt a git call in progress. What bounds
// the decision is the BUDGET arithmetic below; every terminal path clears the
// timer immediately before it writes.
const TIMEOUT_MS = 5000;
let _timeout = null;

// THE BUDGET. The hook is registered with `"timeout": 5` seconds
// (`.claude/hooks/dispatch-registry.json:264-265`). DECISION_BUDGET_MS is the wall-clock share
// the local cherry loop and the remote scan draw from, in that order, each
// capped below; every git spawn gets at most the time it has left. A pass that
// runs out does NOT go silent — `coverageLines` names each branch or ref it did
// not measure. Residual, not hidden: `wip-lanes.js::landedRemoteRefs` runs its
// two `for-each-ref` reads under that module's own per-call timeout, which this
// budget does not reach.
const DECISION_BUDGET_MS = 4000;
const PRE_READ_TIMEOUT_MS = 1000;
const LOCAL_BUDGET_MS = 1500;
const CHERRY_CALL_CAP_MS = 1000;
const REMOTE_BUDGET_MS = 2000;
// THE ONE MAP BUILD gets its own per-spawn cap, NOT the cherry cap. Under the
// landed-map contract a map that times out is `no-map` — UNMEASURED for EVERY
// candidate (`landed-map.js::landedVerdicts`, `_mapFailureVerdict`) — so a cap
// sized for one `git cherry` would silently turn a normal repository's whole
// local half into UNMEASURED rows. The map's dominant spawn is ONE `git log`
// over every commit after the cutover. MEASURED 2026-09-28 on loom (worktree
// feat/landing-provenance, `buildLandedMap({ useCache: false })`, 5 runs each,
// read-only): 0 post-cutover commits 39-75 ms; a range of 4904 commits
// (cutover = origin/dev~1000 first-parent) 158-407 ms, and one earlier 5-run set
// over the same range peaked at 1004 ms — AT the 1000 ms cherry cap. 2500 ms is
// ~2.5x that worst observation and stays inside DECISION_BUDGET_MS (4000): the
// build is additionally clamped to what `remaining()` leaves, and whatever it
// spends is no longer available to the local verdicts and the remote half,
// which draw from the same `remaining()` afterwards.
const MAP_BUILD_CAP_MS = 2500;

function passthrough() {
  clearTimeout(_timeout);
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

// Segment-anchored, and deliberately IDENTICAL to the proven matcher in
// `wrapup-after-landing.js` rather than a second dialect of the same intent:
// two matchers for one event is how the pair drifts. The `--help`/`-h`
// lookahead excludes the common non-landing invocation.
function isLandingCommand(cmd) {
  return /(^|[\n;&|]\s*)gh\s+pr\s+merge\b(?!\s+(?:--help|-h)\b)/.test(
    String(cmd),
  );
}

// Every git a guard spawns routes through git-subprocess-env.js — an ABSOLUTE
// binary plus a constants-built env — per `security.md` § Multi-Site Kwarg
// Plumbing. A bare "git" resolves through PATH, so on a host where PATH is
// attacker-influenced (or simply missing git) the guard either runs the wrong
// binary or fails in a way that reads here as "no branches are reapable" —
// silence indistinguishable from a clean forest, which is the whole class this
// guard exists to make visible.
function git(args, cwd, timeout = PRE_READ_TIMEOUT_MS) {
  return execFileSync(resolveGitBinary(), args, {
    cwd,
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"],
    env: gitEnv(),
  });
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). Everything a standalone run
// did at load time happens here instead, so a require() has no side effects.
function hookMain() {
  _timeout = setTimeout(() => {
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    process.exit(1);
  }, TIMEOUT_MS);
  _timeout.unref?.();
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
  const started = Date.now();
  const remaining = () => DECISION_BUDGET_MS - (Date.now() - started);
  try {
    const payload = JSON.parse(input || "{}");
    const cmd =
      (payload && payload.tool_input && payload.tool_input.command) || "";
    if (!isLandingCommand(cmd)) return passthrough();

    const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const lib = require(path.join(__dirname, "lib", "reap-on-landing.js"));
    const lanes = require(path.join(__dirname, "lib", "wip-lanes.js"));

    let current, allLocal, held, remotes;
    try {
      current = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).trim();
      allLocal = lib.parseBranchList(
        git(["branch", "--format=%(refname:short)"], cwd),
      );
      held = lib.parseWorktreeBranches(
        git(["worktree", "list", "--porcelain"], cwd),
      );
      remotes = lib.parseRemoteRefs(
        git(
          ["for-each-ref", "refs/remotes/origin", "--format=%(refname:short)"],
          cwd,
        ),
        "origin",
      );
    } catch {
      // No git, a detached or unreadable tree — UNMEASURED, which is silence.
      // An unmeasured tree is never reported as clean, and never as reapable.
      return passthrough();
    }

    // ── THE REMOTE'S DECLARED DEFAULT BRANCH, fenced on BOTH arms ─────────────
    //
    // `NEVER_REAP` fences the names a trunk is CONVENTIONALLY given — `main`,
    // `master`, `dev` — and the trunk-branch fence below covers the branch the
    // resolved base names. Neither covers a repository whose default branch is
    // called something else. `refs/remotes/origin/HEAD` → `release-2` clears
    // `NEVER_REAP`, clears every protected prefix, and reads LANDED against any
    // trunk that contains it, so without this read it is proposed for deletion
    // LOCALLY AND ON THE REMOTE. `remote-ref-reap.mjs` already refuses exactly
    // this from the same `symbolic-ref` read (`branch === DEFAULT_BRANCH`); this
    // is that fence reaching the other consumer through the SHARED parser rather
    // than a third copy of the prefix arithmetic (`security.md` § Enforcement-
    // Surface Parity).
    //
    // SEPARATE try/catch, and it fails SAFE in the direction that PROTECTS. The
    // read goes through the same allowlisted git spawn as every other call in
    // this file — an ABSOLUTE binary and a constants-built env, never a bare
    // `git` off an ambient PATH. `symbolic-ref -q` exits 1 when the ref is absent
    // (a clone that never ran `remote set-head`), which `git()` raises, so the
    // catch is the ORDINARY path and not an exceptional one. Unresolvable ⇒ null
    // ⇒ the existing fences stand exactly as before; "cannot tell" is never read
    // as "not the default", because the only thing a null does is decline to ADD
    // a name to the protected set.
    let defaultBranch = null;
    try {
      defaultBranch = lib.parseDefaultBranch(
        git(["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], cwd),
        "origin",
      );
    } catch {
      defaultBranch = null;
    }

    // ── THE LOCAL HALF, measured against the resolved trunk ───────────────────
    //
    // Landedness is CONTENT, not ancestry. `git branch --merged` was the first
    // cut and is false-negative by construction here — loom SQUASH-merges,
    // which re-authors commits, so a fully-landed branch is not an ancestor of
    // the base (measured: 18 landed refs, 0 ancestry-visible). `git cherry`
    // compares PATCH-IDs, which survives the re-authoring.
    //
    // FENCED before measuring: the current branch, every branch checked out in
    // a worktree (a lane cut from the trunk a moment ago is trivially landed,
    // and `git branch -d` refuses it anyway), the protected floor, the remote's
    // DECLARED default branch (read above), and the trunk branch the base names
    // — measured against itself it is always "landed", and proposing to delete
    // it is the worst output this guard has.
    const trunk = resolveTrunkForDeletion({ repoDir: cwd, remote: "origin" });
    // THE ONE PREDICATE both halves gate on. `resolved` AND `verified` together,
    // never either alone: `resolved` is true of an override this repository has
    // not corroborated as its trunk, and `verified` is what `resolveTrunk` could
    // not tell us. Anything else — `unverified` (a ref that resolves but is not
    // shown to be the trunk) or `undetermined` (no usable ref at all) — is a base
    // this guard will REPORT about and will not DELETE against.
    const deletionGrade =
      trunk.status === "resolved" && trunk.verified === true;
    const knob = lib.resolveLocalBudget(
      process.env.COC_REAP_BUDGET_MS,
      LOCAL_BUDGET_MS,
    );
    const fence = [...held];
    if (defaultBranch) fence.push(defaultBranch);
    let local;
    if (deletionGrade) {
      const base = trunk.ref;
      const trunkBranch = lib.branchNameOfRef(base);
      if (trunkBranch) fence.push(trunkBranch);
      const candidates = allLocal.filter(
        (b) => b !== current && !lib.isProtectedName(b, fence),
      );
      // ── PROVENANCE FIRST, CONTENT ONLY WHERE PROVENANCE CANNOT SPEAK ───────
      //
      // The landed map is built ONCE per invocation, against the SAME base the
      // cherry fallback measures (`ref: base`), so the two instruments judge
      // one tip. A repository with no `.claude/bin/landing-provenance.json`
      // (every consumer) gets `no-config` ⇒ fallback ⇒ the cherry below runs
      // exactly as before. A map that fails or times out where the config
      // EXISTS is `no-map`, never a verdict: every branch is then UNMEASURED
      // (`fallback:false`), never handed to the cherry. So the map build has
      // its OWN per-spawn cap (MAP_BUILD_CAP_MS, see its declaration for the
      // measurement), clamped to the same wall-clock `remaining()` budget.
      //
      // BULK: `landedVerdicts` reads every candidate's tip in ONE for-each-ref
      // and memoises the fork test, and it is handed THIS pass's budget so a
      // slow forest turns into named UNMEASURED rows, never an overrun. Every
      // per-branch spawn it makes is capped at the per-call cap the cherry uses.
      const LM = require(path.join(__dirname, "lib", "landed-map.js"));
      let map;
      const mapCapMs = mapBuildCapMs(remaining());
      if (mapCapMs <= 0) {
        // Nothing left to build with. A repository with NO config keeps its
        // legacy fallback (`no-config`, a filesystem read when cwd is the
        // toplevel); one WITH a config gets `no-map` (UNMEASURED), never a guess
        // and never a spawn the hook's own timeout would have to kill.
        let absent = false;
        try {
          absent = LM.loadConfig(cwd, { timeoutMs: 200 }).absent === true;
        } catch {
          absent = false;
        }
        map = absent
          ? { ok: false, noConfig: true, why: "no landing-provenance config" }
          : {
              ok: false,
              noConfig: false,
              why: `decision budget ${DECISION_BUDGET_MS}ms exhausted before the landed map could be built`,
            };
      } else {
        try {
          map = LM.buildLandedMap({
            repoDir: cwd,
            ref: base,
            timeoutMs: mapCapMs,
          });
        } catch (e) {
          map = {
            ok: false,
            noConfig: false,
            why: `landed map threw: ${e && e.message}`,
          };
        }
      }
      const measured = lib.measureLocalByProvenance({
        candidates,
        verdictsFor: (names, budgetMs) =>
          LM.landedVerdicts({
            repoDir: cwd,
            branches: names.map((b) => ({ ref: `refs/heads/${b}`, name: b })),
            map,
            ref: base,
            timeoutMs: CHERRY_CALL_CAP_MS,
            budgetMs,
          }),
        runCherry: (b, timeoutMs) => git(["cherry", base, b], cwd, timeoutMs),
        budgetMs: Math.max(0, Math.min(knob.budgetMs, remaining())),
        perCallCapMs: CHERRY_CALL_CAP_MS,
      });
      // `provenanceOn` is false ONLY for a repository with no recording config
      // (every consumer): there the report keeps its legacy all-content wording,
      // because a sentence about "0 decided by provenance" would describe a
      // mechanism that repository does not have.
      local = {
        status: "measured",
        base,
        provenanceOn: !(map && map.noConfig),
        ...measured,
      };
    } else {
      local = {
        status: "undetermined",
        base: null,
        // `unverified` and `undetermined` BOTH land here, and the reason is what
        // tells them apart in the report — `resolveTrunkForDeletion` writes a
        // distinct sentence for each. Carrying it verbatim is what keeps the
        // empty outcome distinguishable from a successful one
        // (`conservation-gate.md` MUST-4).
        reason:
          trunk.reason ||
          "the base was not shown to be this repository's trunk, so no landedness was measured against it",
        landed: [],
        examined: [],
      };
    }

    // ── THE REMOTE-ONLY POPULATION ─────────────────────────────────────────
    //
    // The local candidate set above can only ever see a branch that still has
    // a LOCAL ref. MEASURED on this repo 2026-09-10: of 88 refs on origin, 18
    // are landed by content and ALL 18 have no local branch — so the loop
    // above reported 0 of 18, every time, until this arm existed.
    //
    // The scan is DELEGATED to `wip-lanes.js::landedRemoteRefs` rather than
    // repeated here: one collector, one predicate, one place to be wrong
    // (`security.md` § Enforcement-Surface Parity). It resolves its base through
    // the same trunk resolver, composing the remote's declared default where no
    // trunk exists — so its base is REPORTED separately, never assumed equal to
    // the local half's. Refs are examined NEWEST-FIRST, so the ref that JUST
    // merged — this hook's whole subject — is the first one measured.
    //
    // GATED ON THE SAME PREDICATE as the local half, and that is not belt-and-
    // braces. `landedRemoteRefs` resolves its own base through `_trunkFor` →
    // `resolveTrunk` (`wip-lanes.js:888`), which is the resolver that ACCEPTS an uncorroborated
    // override — so under a `COC_TRUNK_REF` pointed at a content superset this
    // arm would return every remote ref as landed, and those names become the
    // REMOTE DELETION proposals below. Fencing only the local half would leave
    // the more destructive half open. Not asking is reported as NOT RUN by
    // `coverageLines`, and the sentence appended to the report names WHY, so the
    // skip is announced rather than silent.
    let remote;
    if (!deletionGrade) {
      remote = { ok: false };
    } else {
      try {
        remote = lanes.landedRemoteRefs({
          repoDir: cwd,
          budgetMs: Math.max(0, Math.min(REMOTE_BUDGET_MS, remaining())),
        });
      } catch {
        remote = { ok: false };
      }
    }
    const localNames = new Set(allLocal);
    const remoteOnly =
      remote && remote.ok ? remote.names.filter((b) => !localNames.has(b)) : []; // UNDERIVABLE ⇒ nothing added, never a guess — and named below

    const result = lib.classify({
      merged: local.landed,
      remoteRefs: remotes,
      remoteOnly,
      current,
      protectedNames: fence,
      // Passed as well as pushed into `fence` above, deliberately. The `fence`
      // entry keeps the name out of the LOCAL candidate set before a cherry is
      // ever spawned; this argument is the fence `classify` applies to BOTH arms,
      // and the remote-only arm has no other route to it.
      defaultBranch,
      examined:
        local.examined.length + (remote && remote.ok ? remote.examined : 0),
    });
    const summary = lib.summarize(result);
    const gaps = lib.coverageLines({ local, remote });
    // The silent, common case — and it is EARNED only when both halves measured
    // everything. A partial pass with nothing found is not "nothing reapable".
    if (!summary && gaps.length === 0) return passthrough();

    const shown = result.reapable.slice(0, 8);
    const cmds = lib.reapCommands(shown);
    const bases = lib.basesSentence({
      localBase: local.base,
      remoteBase: remote && remote.ok ? remote.base : null,
      instruments: local.provenanceOn ? local.instruments || null : null,
    });
    // WHICH INSTRUMENT decided each proposed row. A local row carries the
    // instrument `measureLocalByProvenance` recorded; a remote-only row was
    // decided by `wip-lanes.js::landedRemoteRefs`, which is patch-id content.
    const decidedBy = local.decidedBy || {};
    const instrumentOf = (r) =>
      !local.provenanceOn
        ? ""
        : !r.local
          ? "by content"
          : decidedBy[r.branch] === "provenance"
            ? "by provenance"
            : decidedBy[r.branch] === "content"
              ? `by content — ${(local.fallbackStatus && local.fallbackStatus[r.branch]) || "fallback"}`
              : "by content";
    const report = [];
    if (summary) {
      report.push(
        `Report the ${result.counts.reapable} reapable branch(es) of ${result.counts.examined} examined: ${shown
          .map((r) => {
            const i = instrumentOf(r) ? `; ${instrumentOf(r)}` : "";
            return (
              r.branch +
              (!r.local
                ? ` (remote only — no local branch${i})`
                : r.remote
                  ? ` (local+remote${i})`
                  : ` (local only${i})`)
            );
          })
          .join(
            ", ",
          )}${result.reapable.length > shown.length ? `, +${result.reapable.length - shown.length} more` : ""}.`,
      );
      report.push(
        `Reap them now, or state per branch why it is deliberately held: ${cmds.join(" ; ")}`,
      );
    }
    // The skip is ANNOUNCED WITH ITS CONSEQUENCE, never left to read as a clean
    // forest (`conservation-gate.md` MUST-4). `coverageLines` says both halves
    // did not run; only this line says the base is the reason and that NO
    // deletion was proposed on purpose.
    if (!deletionGrade) {
      report.push(
        `NO reap was proposed, and that is a REFUSAL rather than a clean result: the base is not usable for a DELETION decision — ${local.reason} ` +
          "Landedness measured against such a base is REPORTABLE but is not grounds for deleting a ref, so both halves were withheld. " +
          "Re-run with the override removed, or point `COC_TRUNK_REF` at a ref this repository corroborates as its trunk (`refs/remotes/origin/HEAD`, `origin/dev`, or `origin/main`), then reap.",
      );
    }
    for (const g of gaps) report.push(g);
    if (knob.problem) report.push(knob.problem);
    report.push(
      "Do NOT rely on `git branch -d` to be self-fencing — MEASURED on this repo, it deletes a branch merged only to its UPSTREAM while NOT merged to the trunk. The landedness test above (recorded provenance, or content where provenance cannot speak) is the safety, not the `-d`.",
    );

    const { emit } = require(
      path.join(__dirname, "lib", "instruct-and-wait.js"),
    );
    clearTimeout(_timeout);
    emit({
      hookEvent: "PostToolUse",
      severity: "halt-and-report",
      what_happened: summary
        ? `A pull request just landed, and ${summary}. ${bases}`
        : `A pull request just landed, but the reap check did NOT finish measuring, so its silence would not have meant "nothing reapable". ${bases}`,
      why:
        "wip-discipline.md MUST-4: done means LANDED AND CLEANED, and CLEANED includes the REMOTE ref. " +
        "The moment a PR merges is when reaping becomes free and loses nothing; deferred to memory it does not happen — " +
        "89 remote refs stood on this repo when this guard was written, 18 of them already landed.",
      agent_must_report: report,
      agent_must_wait: summary
        ? "Reap the landed branches, or record why each is held. This is free cleanup at the only moment it costs nothing."
        : "Measure the branches and refs named as not measured, then reap any that are landed — or record why they are held.",
      user_summary: summary
        ? `PR merged — ${summary}.`
        : `PR merged — reap check INCOMPLETE (${gaps.length} gap(s) named).`,
    });
  } catch {
    return passthrough();
  }
}

/**
 * The per-spawn timeout the ONE landed-map build gets: its own cap
 * (MAP_BUILD_CAP_MS), clamped to what the decision budget has left, never
 * negative. Pure; exported so the cap and its clamp are testable without a
 * clock.
 */
function mapBuildCapMs(remainingMs) {
  const r = Number.isFinite(remainingMs) ? Math.floor(remainingMs) : 0;
  return Math.max(0, Math.min(MAP_BUILD_CAP_MS, r));
}

module.exports = {
  hookMain,
  mapBuildCapMs,
  MAP_BUILD_CAP_MS,
  CHERRY_CALL_CAP_MS,
  DECISION_BUDGET_MS,
};

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1")
    require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
