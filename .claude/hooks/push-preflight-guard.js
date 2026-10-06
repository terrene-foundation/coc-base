#!/usr/bin/env node
"use strict";
/**
 * Push pre-flight guard — `ci-cost-discipline.md` MUST-1 at the moment it is
 * still actionable.
 *
 * @hook-event: PreToolUse:Bash (guard) — a `git push` to a branch the remote
 *   ALREADY carries is the act that cancels an in-flight run, and PreToolUse:Bash
 *   is the boundary attempting it. The subject exists at this instant and nowhere
 *   else: at SessionStart no push has been proposed, and by PostToolUse the run
 *   has already been bought and destroyed. Quoting the deferral row this
 *   graduates: "Nothing fires at push time, which is the only moment the cost is
 *   still avoidable — by the time /codify reviews it, the run has already been
 *   bought and destroyed. The measured waste this rule targets (474 of 483
 *   cancelled CI-minutes) accrues entirely in that unmonitored window."
 *
 * FINDING IDENTITY: `ci-cost-discipline/push-without-preflight`.
 *
 * ARMED 2026-09-18 — registered in `.claude/settings.json` at `PreToolUse`, matcher `Bash`, the
 *   event this file's own `@hook-event` declares. NO registration-state marker is carried,
 *   deliberately: every value in `reconcile-hook-surfaces.mjs::MARKER_VOCABULARY` asserts
 *   NON-REGISTRATION, so a registered hook carries none, and `detection-dispatch-check.mjs` reds
 *   `authored-unwired-marker-contradicted` on one that does. Co-owner-authorized.
 *
 *   ⛔ IT WAS ARMED ONLY AFTER THREE DERIVATION DEFECTS WERE FIXED. Two were carried as UNVERIFIED
 *   claims for weeks and are now CONFIRMED; the third nobody had noticed. All three are one class:
 *   the harvester and the recognizer disagreed about what a CI command IS.
 *     (1) THE DERIVER REFUSED TO EMIT WHAT THE RECOGNIZER LOOKS UP. The recognizer looked up
 *         `prog + words[1]` raw, flag or not; the deriver rejected any operand starting with `-`.
 *         So `node --test` — this repo's LARGEST gate family, 12 steps in `coc-artifact-eval.yml`
 *         — could never match. The decisive measurement: the BYTE-EXACT string CI runs at :2429
 *         scored MISS. Running verbatim what CI runs did not count as a parity run, so the
 *         advisory fired on sessions that had done the work.
 *     (2) THE OPERAND WAS COMPARED RAW while the program was basename-normalized, so
 *         `node ./x.mjs`, `node /abs/path/x.mjs` and `node "x.mjs"` all MISSED the signature for
 *         `node x.mjs`. The absolute-path form is the dominant one here, because agents in this
 *         repo are instructed to use absolute paths.
 *     (3) YAML FOLDED SCALARS WERE MISREAD. `run: >` joins its lines into ONE command; the
 *         harvester treated each continuation line as its own. That both LOST the real command and
 *         MINTED a bare-filename signature per suite path — which is where the over-match came
 *         from: `./budget-gate.test.mjs` scored PARITY against a signature that should not exist.
 *
 *   THE FIX THAT WAS REFUSED IS AS IMPORTANT AS THE ONES TAKEN. A blanket "admit any flag operand"
 *   would have minted `node -e` (a real code-eval step at :2209) and `python -m pip install`
 *   (:1567) as gate signatures — after which every ad-hoc `node -e` probe would score a session
 *   CLEAN. That is a false SILENCE, the one direction this detector must never fail in. A declared
 *   `CODE_DISPATCHING_FLAGS` set excludes them. The defensive addition would have been the defect.
 *
 *   SCOPE, UNCHANGED AND STATED SO IT IS NOT OVER-READ: this predicate does NOT enforce
 *   `git.md`'s four scoping properties. It never inspects `git diff --name-only` and has no
 *   opinion on scope; it asks only whether ANY parity command ran since the last push. The fix
 *   changed which CI commands it RECOGNIZES and nothing else.
 *
 *   KNOWN RESIDUE, declared rather than cleaned: ~15 junk signatures (`const`, `let`, `until`,
 *   `x86_64`) harvested from JS/shell embedded in `run: |` blocks. Exploiting one needs a local
 *   command whose FIRST word is literally `const` or `until`; a YAML-embedded-heredoc parser was
 *   judged scope creep with real defect risk. UNANSWERED whether any is reachable; the instrument
 *   that would settle it is a scan of transcript `tool_use` argv first-words against the derived
 *   set.
 *
 *   ARMED IS NOT PROVEN EFFECTIVE: registration is measured here, live firing is not.
 *
 * ─── SEVERITY: `pre-action`, CAPPED BELOW `block`. Argued, not asserted. ─────
 *
 * WHY NOT `block`. `hook-output-discipline.md` MUST-2 reserves `block` for a
 * structural signal a surface rewrite cannot evade. Two of this detector's three
 * predicates clear that bar — the push classification is `parseGitInvocations`
 * (parsed argv, the reference fencing-grade signal) and the remote-branch check
 * is a git-object read. The THIRD does not, and a detector is no stronger than
 * its weakest half:
 *
 *   1. The parity-set DERIVATION reads `run:` steps out of workflow YAML with a
 *      line regex. That is lexical.
 *   2. The remote-branch check is a PROXY for "has an open PR", and it is not
 *      one: a branch can exist on the remote with no PR at all, so a fired
 *      advisory can be speaking about a push whose in-flight run is not a PR run.
 *   3. ON THE MERITS, which is decisive on its own: the parity run may
 *      legitimately have happened in a PRIOR session, in a sibling worktree, or
 *      outside the transcript window this hook reads. A refusal would therefore
 *      be WRONG MORE OFTEN THAN IT WOULD BE RIGHT, and refusing work the agent
 *      was instructed to perform is MUST-2's own MUST NOT.
 *
 * WHY NOT LOWER. The transcript evidence is not the agent's PROSE about what it
 * ran — it is the harness's own `tool_use` record of an argv it dispatched, a
 * structural tool-call record. So the finding is reportable as a measurement
 * rather than an impression, and it deserves a register the agent must answer.
 *
 * WHY `pre-action` RATHER THAN `halt-and-report`. The push has NOT run.
 * `halt-and-report` renders "the action ALREADY RAN", which is FALSE before the
 * call; `pre-action` is the correct PreToolUse register for a non-block finding.
 * `instruct-and-wait.js` returns `continue:true` / exit 0 for every non-`block`
 * severity, so this preserves the fail-OPEN disposition end to end.
 *
 * ─── FAIL OPEN ON EVERY UNKNOWN (`cc-artifacts.md` Rule 7) ──────────────────
 * Unparseable payload, absent field, unreadable transcript, no workflows, a
 * thrown `existsSync`, a wedged `git`, timer expiry — all resolve to
 * `{continue:true}`. The fallback timer is armed BELOW the registered timeout
 * and `.unref()`d. NOTHING is written: no sink, no ledger, no receipt.
 *
 * NO NETWORK. The only subprocess is a LOCAL `git rev-parse`, which reads a ref
 * out of the object store and opens no connection. `lib/open-pr-surface.js`
 * records why a `gh` round-trip is unavailable here: "execFileSync blocks the
 * event loop, so the hook's own setTimeout cannot preempt them" — a Rule 7 timer
 * cannot bound a synchronous network call, so a live PR read would hang every
 * `git push` in the repo behind whatever GitHub is doing.
 */

const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

// Registered timeout is 10000; the fallback sits below it (cc-artifacts Rule 7).
const TIMEOUT_MS = 7000;
let _timeout = null;

function passthrough() {
  clearTimeout(_timeout);
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

const GIT_TIMEOUT_MS = 1500;

/** Every git spawn routes through the shared env helper (`security.md` § Multi-Site Kwarg Plumbing). */
function gitOut(cwd, args) {
  try {
    const { resolveGitBinary, gitEnv } = require(
      path.join(__dirname, "lib", "git-subprocess-env.js"),
    );
    const bin = resolveGitBinary();
    if (!bin) return null;
    const r = spawnSync(bin, args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnv(),
    });
    if (r.error || r.status !== 0) return null;
    return String(r.stdout || "").trim();
  } catch {
    return null;
  }
}

/**
 * Tri-state: true / false / null=unknown. `null` is NEVER collapsed into
 * `false`, because "the ref is absent" and "I could not look" are opposite in
 * meaning and identical under a truthiness test.
 */
function remoteBranchExists(cwd, remote, branch) {
  let name = branch;
  if (!name) {
    name = gitOut(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!name || name === "HEAD") return null; // detached: nothing to resolve
  }
  if (!/^[A-Za-z0-9._\/-]+$/.test(name)) return null;
  const out = gitOut(cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/remotes/${remote}/${name}`,
  ]);
  if (out === null) {
    // `rev-parse --verify --quiet` exits 1 with empty stdout for a MISSING ref,
    // which `gitOut` also returns null for — so a second, discriminating read is
    // required before claiming absence. `show-ref` distinguishes "git ran and
    // found nothing" (status 1, but the binary resolved) from "git did not run".
    const probe = gitOut(cwd, ["rev-parse", "--git-dir"]);
    return probe === null ? null : false;
  }
  return true;
}

/** Workflow YAML contents; [] on any unknown. */
function readWorkflowTexts(cwd) {
  const out = [];
  try {
    const dir = path.join(cwd, ".github", "workflows");
    if (!fs.existsSync(dir)) return out;
    for (const f of fs.readdirSync(dir)) {
      if (!/\.ya?ml$/i.test(f)) continue;
      try {
        const p = path.join(dir, f);
        const st = fs.statSync(p);
        if (!st.isFile() || st.size > 512 * 1024) continue;
        out.push(fs.readFileSync(p, "utf8"));
      } catch {
        /* one unreadable workflow must not lose the others */
      }
    }
  } catch {
    return out;
  }
  return out;
}

// Bounded TAIL read. The same shape (and the same measured 512KB window) as
// `lib/transcript-read.js`, which reads the final ASSISTANT TEXT and therefore
// cannot answer this hook's question — it needs `tool_use` records, which that
// reader skips by construction. Bounded because this runs at every push.
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

function readTranscriptTail(p) {
  try {
    if (typeof p !== "string" || !p) return "";
    const c = fs.constants;
    const flags = c.O_RDONLY | (c.O_NOFOLLOW || 0) | (c.O_NONBLOCK || 0);
    let fd;
    try {
      fd = fs.openSync(p, flags);
    } catch {
      return "";
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size === 0) return "";
      const start = Math.max(0, st.size - TRANSCRIPT_TAIL_BYTES);
      const length = st.size - start;
      const buf = Buffer.alloc(length);
      const read = fs.readSync(fd, buf, 0, length, start);
      const lines = buf.subarray(0, read).toString("utf8").split("\n");
      if (start > 0) lines.shift(); // a sliced leading fragment is not JSON
      return lines.join("\n");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function run(payload) {
  if (!payload) return passthrough();
  // Gated on NEITHER `hook_event_name` NOR `tool_name` — the REGISTRATION does
  // the scoping, and it is spelled differently on every CLI lane (CC
  // `PreToolUse`/`Bash`, Codex `PreToolUse`/`shell`, Gemini
  // `BeforeTool`/`bash|run_shell_command`). Re-checking the CC literals here
  // would make this INERT on the other two while every surface reported the lane
  // covered — the pattern `ci-runner-saturation-guard.js` records.
  const command = (payload.tool_input && payload.tool_input.command) || "";
  if (!command) return passthrough();

  let L;
  try {
    L = require(path.join(__dirname, "lib", "push-preflight.js"));
  } catch {
    return passthrough();
  }

  // Cheapest discriminator first: most Bash calls are not pushes, and this arm
  // costs no subprocess and no file read.
  const cls = L.classifyPush(command);
  if (!cls.inScope) return passthrough();

  const cwd = payload.cwd || process.cwd();
  const exists = remoteBranchExists(cwd, cls.remote, cls.branch);
  const paritySignatures = L.deriveParitySignatures(readWorkflowTexts(cwd));
  const transcriptText = readTranscriptTail(payload.transcript_path);

  const { verdict, detail } = L.assessPushPreflight({
    command,
    remoteBranchExists: exists,
    transcriptText,
    paritySignatures,
  });
  if (verdict !== "flag") return passthrough();

  let emit;
  try {
    ({ emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js")));
  } catch {
    return passthrough();
  }

  const branch = detail.branch
    ? `\`${String(detail.branch).slice(0, 80)}\``
    : "this branch";
  clearTimeout(_timeout);
  emit({
    hookEvent: "PreToolUse",
    severity: "pre-action",
    what_happened:
      `This push targets ${branch}, which the remote ALREADY carries — so it is not a first push, ` +
      `and any run in flight on it will be CANCELLED and re-bought from zero. ` +
      `No CI-parity command from this project's derived gate set appears in this session's ` +
      `tool-call record since the last push (${detail.parityCandidates} command(s) examined in that window).`,
    why:
      "ci-cost-discipline MUST-1 — re-pushing to ask CI the question is the dominant measured waste: " +
      "1,165 of 1,208 destroyed wall-clock minutes (96.5%), across 78 re-pushes averaging 14.9 min each. " +
      "A local pre-flight answers the same question synchronously and at a bounded cost. " +
      "git.md § Pre-FIRST-Push CI Parity Discipline owns the command set and says it is SCOPED TO THE DIFF " +
      "by default — derived from `git diff --name-only`, not from judgment about which tests look relevant — " +
      "with the unscoped whole-repo run reserved for the five junctures that earn it. Scoping NARROWS the " +
      "gate's input and is the expected move; SKIPPING removes its output and is BLOCKED.",
    agent_must_report: [
      "State whether the diff-scoped CI-parity set was run locally for THIS push, and name the command.",
      "If it was not: run it now, scoped to the diff (`git diff --name-only` -> the gates those paths own; " +
        "`node .claude/bin/owed-suites.mjs` names the suites that own the change), then push once.",
      "If it WAS run — in a prior session, in a sibling worktree, or outside this transcript — say so " +
        "explicitly. This check reads only THIS session's tool-call record and cannot see those.",
      "This is an ADVISORY, not a verdict on your push: the remote-branch check is a PROXY for an open PR " +
        "and does not establish that one exists. The push is NOT blocked.",
    ],
    agent_must_wait:
      "None — this is informational. Decide, act, and report the decision in the same turn.",
    user_summary:
      `ci-cost-discipline — re-push to ${branch} with no CI-parity run recorded this session; ` +
      "an in-flight run would be cancelled and re-bought.",
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
  if (typeof _timeout.unref === "function") _timeout.unref();
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
    process.stderr.write(`[push-preflight-guard] HOOK ERROR: ${e.message}\n`);
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
