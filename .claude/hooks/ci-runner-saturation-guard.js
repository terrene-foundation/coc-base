#!/usr/bin/env node
"use strict";
/**
 * CI runner-saturation guard.
 *
 * @hook-event: PreToolUse:Bash (guard) — a CI-triggering `git push` is the one
 *   action whose cost depends on pool state, and PreToolUse:Bash is the boundary
 *   attempting it. The subject (the pending command, and the pool's CURRENT
 *   occupancy) exists at this instant and nowhere else: at SessionStart no push
 *   has been proposed, and by PostToolUse the run is already queued and the
 *   choice is gone.
 *
 * Procedure (co-owner-directed; receipt loom#2016):
 *   1. is the local self-hosted pool saturated?
 *   2. if so, ask for approval — or honour a session blanket — to use
 *      GitHub-hosted runners
 *   3. proceed on yes; otherwise queue to local
 *
 * SEVERITY IS CAPPED AT halt-and-report. An earlier version of this comment said
 * the cap held "because 'does this command trigger CI' is lexical over argv".
 * THAT WAS FALSE and is withdrawn: `triggersCi` consumes `parseGitInvocations` +
 * `stripShellGroupDelimiters`, which is the PARSED-signal reference
 * `hook-output-discipline.md` MUST-5 names as fencing-grade — MUST-2 does not
 * bite there at all. Recorded rather than quietly replaced, because the false
 * version shipped in several places and would otherwise be quoted forward.
 *
 * The cap holds on three OTHER grounds, each sufficient on its own:
 *   1. `requestedSelfHostedLabelSets` reads `runs-on:` with a line regex over
 *      YAML. That IS lexical, and a detector is no stronger than its weakest half.
 *   2. Whether a push reaches a ref with workflows attached is not decidable
 *      from the argv at all, by any parser.
 *   3. On the merits: which pool to spend is the operator's call, so refusing
 *      would be MUST-2's own MUST NOT — a detector blocking work the agent was
 *      instructed to perform.
 *
 * EVERY unknown is silent. See the fail-open note in lib/ci-runner-saturation.js.
 */

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveGitBinary, gitEnv } = require(
  path.join(__dirname, "lib", "git-subprocess-env.js"),
);

const TIMEOUT_MS = 5000;
let _timeout = null;

function passthrough() {
  clearTimeout(_timeout);
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

/** Owner/org of `origin`, or null. Never hardcoded — clients clone anywhere. */
function resolveOrg(cwd) {
  try {
    // Every git a guard spawns routes through git-subprocess-env.js — an
    // ABSOLUTE binary plus a constants-built env — per `security.md`
    // § Multi-Site Kwarg Plumbing. A bare "git" resolves through PATH, so on a
    // host where PATH is attacker-influenced (or simply missing git) the guard
    // either runs the wrong binary or fails in a way that reads as "no origin".
    const r = spawnSync(resolveGitBinary(), ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv(),
    });
    if (r.error || r.status !== 0) return null;
    const url = (r.stdout || "").trim();
    // git@host:ORG/repo.git  |  https://host/ORG/repo(.git)
    const m = url.match(/[:/]([^/:]+)\/[^/]+?(?:\.git)?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function run(payload) {
  if (!payload) return passthrough();
  // DELIBERATELY gated on NEITHER `hook_event_name` NOR `tool_name`. The
  // REGISTRATION does all the scoping, and it is spelled differently on every
  // lane: CC registers `PreToolUse`/matcher `Bash`, Codex `PreToolUse`/matcher
  // `shell`, Gemini `BeforeTool`/matcher `bash`. Re-checking the CC-specific
  // literals here would make this hook INERT on the other two — registered,
  // shipped, and silently never firing, which is strictly WORSE than a declared
  // gap because every surface then reports the lane as covered.
  //
  // MEASURED, not assumed: `validate-bash-command.js` is the one Bash guard
  // already registered on all three lanes, and it contains zero references to
  // either field. That is why it works on all three, and it is the pattern this
  // follows.
  const command = (payload.tool_input && payload.tool_input.command) || "";
  if (!command) return passthrough();

  let L;
  try {
    L = require(path.join(__dirname, "lib", "ci-runner-saturation.js"));
  } catch {
    return passthrough();
  }

  // Cheapest discriminator first: most Bash calls are not pushes, and this
  // arm costs no network and no subprocess.
  if (!L.triggersCi(command)) return passthrough();

  const cwd = payload.cwd || process.cwd();
  const org = resolveOrg(cwd);
  // Scope the probe to the pools THIS repo's workflows actually request. An
  // org-wide count answers a different question and fails toward silence — see
  // the scope note in lib/ci-runner-saturation.js::probePool.
  const labelSets = L.requestedSelfHostedLabelSets(cwd);
  const pool = org ? L.probePool(org, labelSets) : null;
  const blanket = L.readBlanket(cwd);
  const { verdict, detail } = L.assessCiSaturation({ command, pool, blanket });

  if (verdict !== "ask" && verdict !== "notify") return passthrough();

  let emit;
  try {
    ({ emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js")));
  } catch {
    return passthrough();
  }

  if (verdict === "notify") {
    // UNSCHEDULABLE — a MEASURED misconfiguration, surfaced instead of the
    // silence it used to fall into. Every self-hosted set this repo's workflows
    // request matches ZERO registered runners, so those jobs queue forever
    // rather than merely queueing behind a full pool. `pre-action` because the
    // push has NOT run and is NOT being refused: there is nothing here for the
    // operator to authorize, only something to know. Non-blocking by
    // construction (`instruct-and-wait.js` returns `continue:true` / exit 0 for
    // every non-`block` severity), so this preserves the fail-OPEN disposition.
    clearTimeout(_timeout);
    return emit({
      hookEvent: "PreToolUse",
      severity: "pre-action",
      what_happened:
        `This push triggers CI, and every self-hosted runner set this repo's workflows request ` +
        `matches NO registered runner in \`${org}\`: ${detail.pool}. Those jobs cannot be scheduled at all.`,
      why:
        "ci-cost-discipline — an unschedulable set is a MISCONFIGURATION, not a full pool. Reporting it as " +
        "saturation would send the operator to buy capacity that already exists; reporting nothing (which is " +
        "what happened before this arm existed) hides a job that will never start. The most common cause is a " +
        "label that no longer exists, or one whose spelling drifted from the registered runner's.",
      agent_must_report: [
        `Measured: requested set(s) ${detail.pool} match 0 of ${detail.total} self-hosted runners in \`${org}\`.`,
        "State that this is a misconfiguration, NOT pool saturation — the fix is the label, not more capacity.",
        "Recommend a concrete next step: compare the workflow's `runs-on` labels against the registered " +
          "runner labels (`gh api orgs/<org>/actions/runners`), and name the likely drifted label.",
        "The push is NOT blocked and NOT waiting on the operator — say so, so this is not mistaken for a gate.",
      ],
      agent_must_wait:
        "None — this is informational. Proceed with the push; report the finding in the same turn.",
      user_summary: `ci-cost-discipline — requested runner set(s) ${detail.pool} match 0 registered runners; those jobs cannot be scheduled.`,
    });
  }

  clearTimeout(_timeout);
  emit({
    hookEvent: "PreToolUse",
    severity: "halt-and-report",
    what_happened:
      `This push triggers CI, and ALL ${detail.total} self-hosted runner(s) in \`${org}\` are BUSY ` +
      `(0 idle). The run will QUEUE rather than start.`,
    why:
      "ci-cost-discipline — queue wait, not execution time, is the dominant cost when the local pool is " +
      "full; a run that queues an hour and then executes in 45s spent the hour for nothing. GitHub-hosted " +
      "runners are a SEPARATE pool and do not compete for these slots. Which pool to spend is the " +
      "operator's decision, so this asks rather than refuses.",
    agent_must_report: [
      `Measured: 0 of ${detail.total} self-hosted runners idle in \`${org}\` — this run will queue, not start.`,
      "Ask the operator to choose, and say which you recommend:",
      "  (a) QUEUE TO LOCAL — accept the wait; nothing changes.",
      "  (b) USE GITHUB-HOSTED for this work — a separate pool, so it starts immediately.",
      "For (b), state the COST HONESTLY before it is chosen: GitHub-hosted runners bill minutes, and any " +
        "`runs-on` change is a shared-CI edit that lands on the default branch unless it is reverted — so it " +
        "needs its own revert obligation, tracked, not remembered.",
      "For (b), also state what is NOT known: a job pinned to a self-hosted pool may be pinned for a REASON " +
        "(a tracked platform divergence), and moving it can red suites that pass locally. Check the pin's " +
        "comment before proposing the switch.",
      "If the operator grants a SESSION-LEVEL BLANKET, write their stated reason to " +
        "`.claude/ci-authz/github-hosted-allow` (an empty file is NOT a grant) and this stops asking.",
    ],
    agent_must_wait:
      "Do not re-issue the push until the operator has chosen (a) or (b). Re-issuing unchanged just queues it.",
    user_summary: `ci-cost-discipline — 0/${detail.total} self-hosted runners idle; this push will QUEUE. Local or GitHub-hosted?`,
  });
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). Everything a standalone run
// did at load time happens here instead, so a require() has no side effects.
function hookMain() {
  _timeout = setTimeout(() => {
    // cc-artifacts.md Rule 7 — a hanging hook blocks the session; a bounded one
    // that says nothing is the correct degenerate outcome for an advisory.
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    process.exit(1);
  }, TIMEOUT_MS);
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
  try {
    run(JSON.parse(input || "{}"));
  } catch (e) {
    clearTimeout(_timeout);
    process.stderr.write(
      `[ci-runner-saturation-guard] HOOK ERROR: ${e.message}\n`,
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
