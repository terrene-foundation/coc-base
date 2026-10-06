#!/usr/bin/env node
/**
 * stranded-artifact-guard.js — an authored artifact that reaches no default
 * branch governs nothing. This surfaces that state at the two moments it is
 * still cheap to act on.
 *
 * @hook-event: PreToolUse:Bash (guard) — the subject is the branch-ending
 *   command itself (`git branch -D`, `git worktree remove`, `git push
 *   --delete`), which exists only as the pending Bash invocation. No later
 *   event can see it before the branch stops being reachable, and no earlier
 *   one knows it is coming. Bash is the sole matcher because these are shell
 *   commands; an Edit/Write matcher would never see them. The SUBJECT of that
 *   assessment is the object NAMED IN THE COMMAND — every named object, not the
 *   first — never `HEAD` (`wip-discipline.md` MUST-5). See § THE SUBJECT IS THE
 *   COMMAND'S TARGET in `run()` for the measured silence that clause was
 *   written from.
 * @hook-event: SessionEnd (lifecycle) — the subject is the set of commits and
 *   refs on disk, which exists before the session's first tool call and is
 *   FINAL only once no further tool call will add to it. A session ending with
 *   governed artifacts committed to an unlanded branch is the visible edge of
 *   the leave-behind class, and this is the last moment it is observable from
 *   inside the session that caused it.
 *
 * NOT SessionStart, though the subject exists there too. The session-start
 * surface already reports unlanded branches generically; what it cannot say is
 * WHICH of them carry governed artifacts, and at session START the operator has
 * not yet authored the ones this session will strand. SessionEnd sees both.
 *
 * NOT Stop. Stop fires every turn, and a report that repeats after every commit
 * becomes noise — the reasoning `worktree-forest-guard.js` records verbatim for
 * rejecting Stop for its own trigger. The sweep also costs a `diff --name-only`
 * over the branch range, which is real per-turn cost for a signal that changes
 * at most a few times a session.
 *
 * SEVERITY — `pre-action` at PreToolUse, `advisory` at SessionEnd, NEVER
 * `block`, per `hook-output-discipline.md` MUST-2.
 *
 *   The two registers differ because the ACTION'S FATE differs, not because the
 *   finding matters more at one surface. At PreToolUse the branch-ending command
 *   has NOT run, so `pre-action` (`instruct-and-wait.js`, loom#1715 H-1) is the
 *   only head that is true — it renders "the action has NOT run yet. Read this,
 *   then decide," which is precisely the decision `agent_must_wait` below asks
 *   for. This surface shipped as `halt-and-report` and was measured rendering
 *   "the action ALREADY RAN" against a pending `git branch -D`. At SessionEnd
 *   the tool calls are done and `advisory` is the honest head; `pre-action` is
 *   gated to PreToolUse and would be a no-op there anyway.
 *
 *   The signal IS structural: `merge-base --is-ancestor` is reachability, the
 *   three-dot `diff --name-only` is a git-object fact, and the classification is
 *   a positive path allowlist. Nothing here reads prose, and no surface rewrite
 *   changes an answer. By MUST-2's letter a structural signal MAY carry `block`.
 *
 *   It does not, and the reason is MUST-2's own MUST NOT: "detectors that block
 *   work the agent has been instructed to perform". Deleting a branch whose
 *   artifacts were deliberately abandoned is legitimate and common; holding an
 *   artifact unlanded pending review is legitimate and common. Whether THIS
 *   branch should land is a judgment about the operator's plan, not a fact about
 *   the repo. So the structural signal buys CONFIDENCE IN THE NAMES (the report
 *   states the artifact paths as fact), not teeth.
 *
 * FAIL-OPEN. Every error path emits `{continue:true}` and exits 0/1
 * (`cc-artifacts.md` Rule 7). A detector that can wedge a session is worse than
 * the stranding it reports.
 */

const path = require("path");
const { execFileSync } = require("child_process");
const { resolveGitBinary, gitEnv } = require(
  path.join(__dirname, "lib", "git-subprocess-env.js"),
);
const { emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js"));
const { trunkRef } = require(path.join(__dirname, "lib", "trunk-ref.js"));
const {
  findStrandedArtifacts,
  explainSweepFailure,
  detectStrandingDestructiveCommand,
  resolveDestructiveTargets,
  assessDestructiveTargets,
  destructiveReportLines,
  summarizeDestructive,
  assessStranding,
  reportLines,
  summarize,
} = require(path.join(__dirname, "lib", "stranded-artifacts.js"));

// Bounds the WAIT FOR STDIN only. `run()` is synchronous, so a timer cannot
// interrupt an execFileSync once the stack is entered — the per-subprocess
// timeouts below are the real ceiling. Exit 1 so a fired timeout is
// distinguishable from a normal passthrough in exit-code logs.
const TIMEOUT_MS = 8000;
let _timeout = null;

function passthrough() {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

function makeExec(repoDir) {
  // loom#1471. This ran the LITERAL `git` with no `env:`, so the child got the
  // ambient environment — and `GIT_DIR` outranks repository DISCOVERY, so
  // neither `cwd:` nor a `-C` would pin WHICH repository answered. That is not
  // cosmetic for this guard specifically: every question it asks is a
  // reachability question (`merge-base --is-ancestor`, `diff --name-only
  // base...ref`), so an attacker-supplied GIT_DIR pointing at a decoy repo
  // where the branch IS an ancestor returns `reaches === true`, the sweep
  // reports zero stranded artifacts, and the guard silently never fires. The
  // steering makes the detector answer about the wrong repository while every
  // surface still reads clean. Absolute binary + env built from constants.
  //
  // gitEnv(), not gitNetEnv(): all five commands are LOCAL read-only object
  // queries against a repository already on disk and none of them talks to a
  // remote — which is the condition that keeps `lib/template-resolver.js`
  // (network) off this profile.
  //
  // WHAT THIS MUST NOT CLAIM, AND DID. An earlier revision of this comment gave
  // a second condition: "and none reads git CONFIG". That is literally false.
  // `gitEnv()` neutralises system and global config, but a repository's OWN
  // `.git/config` is always read and cannot be disabled — the wording the corpus
  // already uses at `lib/violation-patterns.js:4515-4516`, restated verbatim
  // here so the two sites agree instead of contradicting each other. The real
  // reason `lib/operator-id.js` stays off this profile is the opposite of the
  // one that was written down: it NEEDS config values (`user.signingkey`,
  // `user.name`) that `GIT_CONFIG_GLOBAL=/dev/null` makes invisible, so
  // `gitEnv()` would BREAK it rather than harden it.
  //
  // THE BOUND, stated precisely rather than waved at (the same shape as
  // `lib/violation-patterns.js:4518-4525`): repo-local config CAN name programs
  // git executes, but each such key needs a code path these five commands do not
  // take — `core.fsmonitor` needs an index refresh, `core.pager` needs a TTY and
  // a porcelain command (and `GIT_PAGER=cat` is set), `core.hooksPath` needs a
  // hook invocation, `core.sshCommand` and `credential.helper` need a transport.
  // What remains is FILE-PARSING exposure (packed-refs, commit-graph, pack idx)
  // under the hook's identity, not command execution. Small, and NOT nothing —
  // which is why it is now recorded as a residual rather than denied.
  const gitBin = resolveGitBinary();
  return (args) => {
    if (!gitBin) {
      // INDETERMINATE, never a clean negative. A non-zero code is what
      // `findStrandedArtifacts` already routes to `{ok:false, reason}` — "could
      // not answer, report nothing" — which is distinct from `{ok:true,
      // stranded:[]}`, the genuinely-clean pole. Reporting "no stranded
      // artifacts" because git never ran would be the non-discriminating
      // instrument this guard's own `isAncestor` null-arm exists to prevent.
      //
      // `unavailable` is what keeps the REASON honest as well as the verdict.
      // Every call returns -1 in this state, so without the flag the FIRST
      // check in the sweep attributes the failure to a missing base ref — a
      // claim about the REPOSITORY — when the real cause is that no git binary
      // resolved on this HOST, and the operator is sent to look in the wrong
      // place.
      return { code: -1, stdout: "", unavailable: true };
    }
    try {
      const stdout = execFileSync(gitBin, args, {
        cwd: repoDir,
        encoding: "utf8",
        timeout: 4000,
        stdio: ["ignore", "pipe", "ignore"],
        env: gitEnv(),
      });
      return { code: 0, stdout: stdout || "" };
    } catch (e) {
      return {
        code: typeof e.status === "number" ? e.status : -1,
        stdout: e.stdout || "",
      };
    }
  };
}

function run(payload) {
  const event = payload.hook_event_name || "";
  const repoDir =
    payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  let destructive = null;
  let surface;

  if (event === "PreToolUse") {
    const cmd = (payload.tool_input && payload.tool_input.command) || "";
    destructive = detectStrandingDestructiveCommand(cmd);
    // The overwhelmingly common case: this Bash call is not branch-ending, so
    // the sweep is never spawned and the hook costs one parse.
    if (!destructive) return passthrough();
    surface = "destructive";
  } else if (event === "SessionEnd") {
    surface = "session-close";
  } else {
    // Registered only on those two events; anything else is a mis-registration
    // and passes through rather than guessing what the caller meant.
    return passthrough();
  }

  const exec = makeExec(repoDir);
  // THE INTEGRATION TRUNK, not a hardcoded `origin/main`. Reachability is
  // measured against wherever finished work actually lands, and since
  // 2026-09-10 that is `dev`. Measuring against main here reported SEVEN
  // artifacts as governed-nowhere while every one of them was in the trunk —
  // a false strand, and the mirror of the false-clean this guard exists to
  // prevent. The explicit env override still wins, and `trunkRef` falls back
  // to `<remote>/main` where no trunk exists, so a repo that has not adopted
  // `dev` is unchanged.
  const baseRef =
    process.env.COC_STRANDED_BASE_REF || trunkRef({ repoDir });
  // The env is read HERE, not in the predicate, so the predicate stays pure and
  // the fixtures drive both poles by argument rather than by mutating process
  // state. Opting out costs one local `git diff` and buys back nothing but that
  // — the disabled pass degrades to the ancestry figure rendered as an explicit
  // UPPER BOUND, never to a clean zero.
  const contentCheck = process.env.COC_STRANDED_CONTENT_CHECK !== "0";

  // ── RECORDED LANDING PROVENANCE, ONE MAP PER INVOCATION ────────────────────
  // Built once against the SAME base the legacy ancestry/tree path measures
  // (`ref: baseRef`), so both instruments judge one tip, and handed to every
  // sweep below. A repository with no `.claude/bin/landing-provenance.json`
  // (every consumer) yields `no-config` ⇒ `fallback:true` ⇒ the legacy path,
  // unchanged. A throw here is a map that could not be built: every verdict is
  // then `unknown` and the target INDETERMINATE, never a stranding verdict.
  let landedVerdictFor = null;
  try {
    const LM = require(path.join(__dirname, "lib", "landed-map.js"));
    let map;
    try {
      map = LM.buildLandedMap({ repoDir, ref: baseRef, timeoutMs: 4000 });
    } catch (e) {
      map = { ok: false, why: `landed map threw: ${e && e.message}` };
    }
    landedVerdictFor = (ref, branchName) =>
      LM.landedVerdict({ repoDir, branchRef: ref, branchName, map, ref: baseRef, timeoutMs: 4000 });
  } catch {
    // landed-map.js absent from this tree (a partial copy): legacy path.
    landedVerdictFor = null;
  }

  // ── THE SUBJECT IS THE COMMAND'S TARGET, NOT `HEAD` ────────────────────────
  //
  // wip-discipline.md MUST-5. Until this arm existed, BOTH surfaces called
  // `findStrandedArtifacts` with its default `ref: "HEAD"` — so a destructive
  // command naming a branch the session was not sitting on was assessed against
  // the wrong branch entirely. MEASURED: `git branch -D
  // fix/s39-t1corr-gate2-correctness`, against a branch holding 11 unlanded
  // governed artifacts, returned `{"continue":true}` — 18 bytes, exit 0, fully
  // silent — because HEAD was clean. The guard's own header calls this surface
  // the one "no later event can see before the branch stops being reachable",
  // and it was the one surface that could not see it.
  //
  // The parse was never the defect: `detectStrandingDestructiveCommand`
  // recognised the shape and returned the targets correctly, and they were
  // carried only into the report WORDING ("the pending branch-delete targets
  // X") while the verdict came from somewhere else. A report naming the right
  // branch and computing on another is the shape `instrument-discipline.md`
  // MUST-4 names — a sound instrument read for a question it was not asked.
  //
  // EVERY target is assessed, not the first: `git branch -D a b c` ends three
  // lanes. And a target that cannot be resolved to a ref is UNKNOWN, surfaced
  // as such, never folded into the clean set — the whole defect being fixed is
  // silence that reads as clean.
  if (surface === "destructive") {
    const results = resolveDestructiveTargets({
      exec,
      destructive,
      cwd: repoDir,
    }).map((row) =>
      row.ref
        ? {
            ...row,
            sweep: findStrandedArtifacts({
              exec,
              baseRef,
              ref: row.ref,
              label: row.label,
              contentCheck,
              landedVerdictFor,
            }),
          }
        : { ...row, sweep: null },
    );

    const report = assessDestructiveTargets({ results, destructive });
    // Silent ONLY when every target resolved, swept, and stranded nothing.
    if (!report) return passthrough();

    const hasFindings = report.findings.length > 0;
    const byProvenance =
      hasFindings && report.findings.every((f) => f.decidedBy === "provenance");
    const clause = byProvenance
      ? `that are NOT landed on ${baseRef} according to the landing provenance recorded there (decided by provenance; no content comparison)`
      : report.contentVerified
        ? `whose content is NOT present at ${baseRef}${report.findings.some((f) => f.decidedBy === "provenance") ? " or that are NOT landed per recorded provenance (instrument named per target)" : ""}`
        : `that MAY not be in force at ${baseRef} (UPPER BOUND — reachability only; the content comparison did not run for at least one target)`;

    return emit({
      hookEvent: event,
      severity: report.severity,
      what_happened: hasFindings
        ? `A ${destructive.kind} was about to run while ${report.count} governed artifact(s) on its target(s) ${clause}.`
        : `A ${destructive.kind} was about to run and ${report.unknown.length} of its target(s) could NOT be assessed, so whether governed artifacts are stranded there is UNKNOWN. This is not a clean result.`,
      why: hasFindings
        ? "artifact-stranding/MUST-1 — an artifact whose content reaches no default branch is authored but governs nothing outside this tree"
        : "instrument-discipline.md MUST-1 — a check that could not answer is not evidence of a clean answer; reporting silence here makes 'nothing stranded' and 'the check never ran' indistinguishable",
      agent_must_report: destructiveReportLines(report),
      agent_must_wait:
        "Report the findings, then proceed with the command if that is still what the operator wants. This is a report, not a block.",
      user_summary: summarizeDestructive(report),
    });
  }

  // ── SESSION CLOSE — the subject IS `HEAD`, and that is correct ─────────────
  // At SessionEnd there is no command naming another object; the question is
  // what THIS session leaves behind on the tree it worked in. Unchanged.
  const sweep = findStrandedArtifacts({ exec, baseRef, contentCheck, landedVerdictFor });

  // INDETERMINATE IS NOT CLEAN — AND IT USED TO LOOK EXACTLY LIKE CLEAN.
  //
  // MEASURED before this arm existed, on three synthetic repos driving this same
  // binary at SessionEnd: a repo where origin/main resolves and HEAD reaches it
  // ("nothing stranded") and a repo where origin/main does not resolve at all
  // ("no verdict was reached") both produced the IDENTICAL 18 bytes
  // `{"continue":true}` and exit 0. The `reason` was computed by the sweep and
  // then discarded before any surface, so from the operator's seat the guard
  // answering cleanly and the guard never running were the same event. That is
  // the same observable outcome this guard's git-steering fix was written to
  // prevent, reached through a different door: there, an attacker made the
  // detector report clean about the wrong repository; here, the host made it
  // report clean about nothing at all.
  //
  // SCOPE, since the destructive arm above now handles its own: this is the
  // SESSION-CLOSE indeterminate case only. The destructive surface reaches its
  // equivalent through `assessDestructiveTargets`, which reports PER TARGET —
  // a whole-sweep verdict would have been the wrong shape there, since one
  // target of `git branch -D a b c` can be indeterminate while another holds a
  // real finding, and collapsing them loses exactly the distinction this arm
  // exists to preserve. It takes the same weakest severity for the same reason.
  //
  // SEVERITY IS DELIBERATELY THE WEAKEST ONE. `advisory` at BOTH surfaces —
  // strictly below the `halt-and-report` the destructive STRANDING finding
  // carries, so this arm cannot be read as the guard growing teeth. It stays
  // fail-OPEN in the continue sense by construction, not by intent:
  // `instruct-and-wait.js` returns `continue:true` + exit 0 for every severity
  // except `block`, and `block` is unreachable from here. Loud in the reporting
  // sense, silent in the blocking sense — which is the whole ask.
  //
  // NOISE CEILING, since an advisory that fires constantly is its own defect:
  // at PreToolUse this is already gated behind a pending branch-ending command,
  // and at SessionEnd the guard runs once per session (the header records why
  // Stop was rejected). So the worst case is one advisory per session close,
  // which is the correct price for not confusing "clean" with "never asked".
  if (!sweep || !sweep.ok) {
    const reason = (sweep && sweep.reason) || "no-sweep-result";
    return emit({
      hookEvent: event,
      severity: "advisory",
      what_happened:
        `The stranded-artifact sweep did NOT complete (${reason}), so whether governed ` +
        `artifacts are stranded on this branch is UNKNOWN. This is not a clean result.`,
      why: "instrument-discipline.md MUST-1 — a check that could not answer is not evidence of a clean answer; reporting silence here makes 'nothing stranded' and 'the check never ran' indistinguishable",
      agent_must_report: [
        `State that the stranded-artifact check did not run to completion. Reason: ${reason}.`,
        `State the cause in the operator's terms: ${explainSweepFailure(reason)}`,
        "State explicitly that this is INDETERMINATE and NOT a report of zero stranded artifacts — no verdict was reached in either direction.",
      ],
      agent_must_wait:
        "No action required in this session; the report is for the operator.",
      user_summary: `stranded-artifact sweep INDETERMINATE (${reason}) — stranding status unknown, NOT clean`,
    });
  }

  const finding = assessStranding({ sweep, surface, destructive });
  if (!finding) return passthrough();

  // THE HEADLINE TRACKS THE INSTRUMENT THAT PRODUCED IT. `reportLines` already
  // distinguishes a content-verified verdict from an ancestry upper bound; a
  // `what_happened` that asserted the same thing unconditionally would put a
  // claim in the first line the check may not support, and the operator reads
  // that line first. Under a degraded pass the wording drops to what
  // reachability alone establishes.
  const clause =
    finding.decidedBy === "provenance"
      ? `that are NOT landed on ${finding.baseRef} according to the landing provenance recorded there (decided by provenance; no content comparison)`
      : finding.contentVerified !== false
      ? `whose content is NOT present at ${finding.baseRef}`
      : `that MAY not be in force at ${finding.baseRef} (UPPER BOUND — reachability only; the content comparison did not run)`;

  return emit({
    hookEvent: event,
    severity: finding.severity,
    what_happened: `The session is ending with ${finding.count} governed artifact(s) committed on '${finding.branch}' ${clause}.`,
    why: "artifact-stranding/MUST-1 — an artifact whose content reaches no default branch is authored but governs nothing outside this tree",
    agent_must_report: reportLines(finding),
    agent_must_wait:
      "No action required in this session; the report is for the operator.",
    user_summary: summarize(finding),
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
  clearTimeout(_timeout);
  try {
    run(JSON.parse(input || "{}"));
  } catch (e) {
    process.stderr.write(
      `[stranded-artifact-guard] HOOK ERROR: ${e.message}\n`,
    );
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    process.exit(1);
  }
}

module.exports = { hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
