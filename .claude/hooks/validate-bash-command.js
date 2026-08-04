#!/usr/bin/env node
/**
 * Hook: validate-bash-command
 * Event: PreToolUse
 * Matcher: Bash
 * Purpose: Block dangerous commands, suggest tmux for long-running,
 *          ENFORCE .env loading for pytest/python commands
 *
 * Framework-agnostic — works with any Kailash project.
 *
 * Exit Codes:
 *   0 = success (continue)
 *   2 = blocking error (stop tool execution)
 *   other = non-blocking error (warn and continue)
 */

const fs = require("fs");
const path = require("path");
const {
  logObservation: logLearningObservation,
} = require("./lib/learning-utils");
const { instructAndWait } = require("./lib/instruct-and-wait");
const {
  detectStateFileMutationSegmentAware,
  detectGitConfigMutation,
  detectRepoScopeDriftBash,
  detectWorktreeStaleBaseRef,
  // Quote-aware segmentation + doc-carrier payload masking. Already exported and
  // already used by the state-path lane; reused here rather than re-derived, so
  // the two lanes cannot drift on what counts as prose (security.md
  // § Enforcement-Surface Parity).
  splitShellSegments,
  maskDocCarrierPayloads,
  // Heredoc BODIES are prose too — `cat > notes.md <<'EOF' … EOF` writes a file,
  // which no argument-masking pass covers.
  parseHeredocSpans,
} = require("./lib/violation-patterns");
// THE shared guard-git allowlist (loom#1462) — absolute binary + an env built
// from constants, so no ambient `GIT_DIR` can re-point a guard's git at another
// repository. Already required by guard-path-scope.js and coordination-mode.js.
const { resolveGitBinary, gitEnv } = require("./lib/git-subprocess-env.js");
const { isCoordinationEnabled } = require("./lib/coordination-mode");
const { resolveMainCheckout } = require("./lib/state-resolver");
/**
 * Environment for a NODE child this hook spawns (loom#1471 shard 6).
 *
 * Built from constants, same discipline as `gitEnv()`: nothing is inherited, so
 * `NODE_OPTIONS` (which can `--require` an arbitrary module into the child) and
 * `NODE_PATH` cannot reach it regardless of what the settings layer does.
 *
 * `COC_RUNTIME` is the one pass-through. It is the harness's runtime selector,
 * legitimately set by the CLI wrapper, and dropping it would change which
 * runtime the child believes it is under — a behaviour change, not a hardening.
 * It is additionally covered by the settings-layer blanket `COC_` prefix deny,
 * so the attacker-delivery path for it is fenced one layer up.
 */
function nodeChildEnv() {
  const env = { PATH: "/usr/bin:/bin", LC_ALL: "C" };
  if (typeof process.env.COC_RUNTIME === "string") {
    env.COC_RUNTIME = process.env.COC_RUNTIME;
  }
  if (process.platform === "win32") {
    const amb = process.env.SystemRoot || process.env.SYSTEMROOT;
    const sysRoot =
      typeof amb === "string" && path.isAbsolute(amb) ? amb : "C:\\Windows";
    env.SystemRoot = sysRoot;
    env.PATH = `${sysRoot}\\System32;${sysRoot}`;
    for (const k of ["COMSPEC", "PATHEXT", "TEMP", "TMP"]) {
      if (typeof process.env[k] === "string") env[k] = process.env[k];
    }
  }
  return env;
}
// loom#1422 — the THREE Bash-lane protected-path matchers are BUILT from the
// single registry in lib/guard-path-scope.js. They used to be three hand-kept
// regex literals here, and the case-insensitivity dimension had to be added to
// each one separately (plus ~7 more sites in three other hooks) — which is
// exactly the enumeration nobody produced and everybody missed. The rationale
// for each path's membership + severity class stays below, next to the code
// that routes it; only the PATTERN moved.
const {
  STATE_PATH_RX,
  LAYER3_BLOCK_RX,
  COORD_MODE_RX,
} = require("./lib/guard-path-scope.js");

// Timeout handling for PreToolUse hooks (5 second limit)
const TIMEOUT_MS = 5000;
const timeout = setTimeout(() => {
  console.error("[HOOK TIMEOUT] validate-bash-command exceeded 5s limit");
  console.log(JSON.stringify({ continue: true }));
  process.exit(1);
}, TIMEOUT_MS);

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  clearTimeout(timeout);
  try {
    const data = JSON.parse(input);
    const result = validateBashCommand(data);
    // If result is structured for instruct-and-wait, use canonical shape
    if (result.severity) {
      const out = instructAndWait({
        hookEvent: "PreToolUse",
        severity: result.severity,
        what_happened: result.what_happened,
        why: result.why,
        agent_must_report: result.agent_must_report,
        agent_must_wait: result.agent_must_wait,
        user_summary: result.user_summary,
      });
      console.log(JSON.stringify(out.json));
      process.exit(out.exitCode);
    }
    // Legacy advisory path. Non-blocking advisories reach the agent via
    // additionalContext — the delivered PreToolUse field; the prior
    // `validation` sibling was silently dropped (loom #466). Emit the context
    // block only when there's an advisory message.
    const advisory = { continue: result.continue };
    if (result.message) {
      advisory.hookSpecificOutput = {
        hookEventName: "PreToolUse",
        additionalContext: result.message,
      };
    }
    console.log(JSON.stringify(advisory));
    process.exit(result.exitCode);
  } catch (error) {
    console.error(`[HOOK ERROR] ${error.message}`);
    console.log(JSON.stringify({ continue: true }));
    process.exit(1);
  }
});

// loom#1549 F3 — the git-invocation parser moved to lib/git-command-parse.js.
// It used to live HERE and nowhere else, so the pairing guard
// (fold-amendment-paired-with-helper.js) grew its own `/\bcommit\b/` lineage
// instead of reusing it — the divergence kailash-rs rejected the Gate-2 sync
// over. One parser, every consumer, per security.md § Multi-Site Kwarg
// Plumbing; same shape as tool-classes.js for tool names.
const { parseGitInvocation, parseGitInvocations, stripShellComments } = require(
  path.join(__dirname, "lib", "git-command-parse.js"),
);

/**
 * The ONE commit-detection predicate for this hook (loom#1549 HIGH-3).
 *
 * Three sites each carried their own `git commit` regex — two `^`-anchored and
 * one `\b`-anchored — which is the same multi-lineage drift this whole issue is
 * about, reproduced INSIDE the file the shared parser was extracted from. The
 * `^` form was blind to `cd sub && git commit`, `git -C /repo commit`, `sudo git
 * commit`, and `env VAR=x git commit`; the `\b` form fired on `git log
 * --grep=commit`. Dispatching on the parsed SUBCOMMAND POSITION is the only
 * thing that separates those structurally.
 *
 * Returns the invocation (carrying `.dir` and `.unresolvable`) or null, so a
 * caller that needs the retargeted repository can have it rather than assuming
 * the session cwd.
 *
 * @param {string} command
 * @returns {{sub:string,dir:string|null,args:string,unresolvable:string|null}|null}
 */
function findCommitInvocation(command) {
  return parseGitInvocations(command).find((g) => g.sub === "commit") || null;
}

/**
 * Structural working-tree signal — the canonical example hook-output-
 * discipline.md MUST-2 names as the basis for `severity: "block"` ("git
 * status --porcelain non-empty before --hard"). Runs in the `-C` target dir
 * (or the session cwd). Returns { ok, dirty, untracked }; ok=false means git
 * could not be queried (not a repo, timeout) — the caller fails OPEN to
 * halt-and-report rather than hard-blocking on an unverifiable signal (the
 * MUST-2 anti-false-positive default).
 */
function gitWorkingTreeStatus(dir, cwd) {
  try {
    const { spawnSync } = require("child_process");
    // THE shared guard-git allowlist (loom#1462). This spawn pre-dates that
    // module and was still passing a bare binary name with NO `env:`, which is
    // exactly the defect the module exists for: `GIT_DIR` outranks repository
    // DISCOVERY, so neither `-C` nor `cwd:` pins WHICH repository answers.
    //
    // IT MATTERS MOST HERE, of every git a guard spawns in this repo. The two
    // consumers of this function are the only `severity: "block"` branches in
    // the hook (`git reset --hard` and `git clean -f`), and the failure is
    // fail-OPEN: an ambient `GIT_DIR` pointing at a CLEAN repo yields
    // `{ok:true, dirty:false}`, the block does not fire, and the destructive
    // command proceeds against the real dirty tree — irrecoverable, no reflog.
    //
    // Swept in with the ref-probe routing per security.md § Enforcement-Surface
    // Parity rather than left a version behind; `zero-tolerance.md` Rule 1a
    // forbids the "same on main, so not introduced here" disposition. The
    // ACCEPTED-RESIDUAL note at the ref probe used to cite THIS call as its
    // safety baseline, which was citing the weaker surface — that note now says
    // so explicitly.
    const gitBin = resolveGitBinary();
    // Unresolvable git ranks TIGHTEST here, per that module's caller contract:
    // this is a fail-closed destructive-op fence, NOT the advisory lane, so the
    // named deviation recorded at the ref probe does NOT transfer. `ok:false`
    // already routes the caller to halt-and-report rather than silent allow.
    if (!gitBin) return { ok: false, dirty: false, untracked: false };
    const r = spawnSync(
      gitBin,
      [
        "-C",
        dir || cwd || ".",
        "status",
        "--porcelain",
        "--untracked-files=all",
      ],
      {
        encoding: "utf8",
        timeout: 2500,
        stdio: ["ignore", "pipe", "ignore"],
        env: gitEnv(),
      },
    );
    if (r.status !== 0 || typeof r.stdout !== "string") {
      return { ok: false, dirty: false, untracked: false };
    }
    const lines = r.stdout.split("\n").filter(Boolean);
    return {
      ok: true,
      dirty: lines.length > 0,
      untracked: lines.some((l) => l.startsWith("??")),
    };
  } catch {
    return { ok: false, dirty: false, untracked: false };
  }
}

function validateBashCommand(data) {
  const command = data.tool_input?.command || "";
  const cwd = data.cwd || process.cwd();

  // GUIDE-FIRST cross-repo ceremony (B — journal/0488 RC1+RC3). This is the
  // PreToolUse Bash tripwire, so the guidance arrives BEFORE the cross-repo
  // command runs — the agent can honor the halt and run /cross-repo-authorize
  // instead of contaminating framing with a cross-repo read (vs the PostToolUse
  // advisory in detect-violations.js, which fires only AFTER). Hosted here (not
  // detect-violations.js) because this hook is already the mcp-guard Bash
  // tripwire — so the ceremony is CLI-neutral (mirrors to Codex shell) without
  // reclassifying the CC-only multi-event detect-violations.js. GUIDES, does not
  // block — lexical detection → halt-and-report (hook-output-discipline.md
  // MUST-2). The authoritative violation ROW is logged once, by the PostToolUse
  // detect-violations.js branch (no double-count). detectRepoScopeDriftBash
  // returns null when a same-tier authorizing receipt exists → authorized
  // re-runs pass straight through.
  const crossRepo = detectRepoScopeDriftBash(command, cwd);
  if (crossRepo) {
    const target = crossRepo.target || "<owner/repo>";
    const intent = crossRepo.intent || "write";
    const isRead = intent === "read";
    return {
      severity: "halt-and-report",
      what_happened: `Cross-repo ${intent} against ${target} attempted with no authorizing receipt (repo-scope-discipline.md § User-Authorized Exception).`,
      why: crossRepo.rule_id,
      agent_must_report: [
        `This is a cross-repo ${intent.toUpperCase()}. Do NOT self-authorize it — the agent never self-authorizes (repo-scope-discipline.md MUST-NOT).`,
        `Run the ceremony: /cross-repo-authorize ${target} "<the exact bounded action>" — it restates action+target for your yes/no, then writes the receipt so no condition is dropped.`,
        isRead
          ? `READ tier (D): conditions 1+2+3+5 apply; condition 4 is a one-line affordance receipt (still required) — the affordance writes it to .claude/cross-repo-authz/.`
          : `WRITE tier: ALL FIVE conditions apply — the affordance writes the receipt (verbatim user instruction + the cross-repo-authorized marker) to .claude/cross-repo-authz/ BEFORE the action runs.`,
        `The receipt is the ONLY distinguisher between an authorized and unauthorized cross-repo action (absent = critical L1, trust-posture.md MUST-4). Once written, re-run this command — the receipt clears the gate.`,
      ],
      agent_must_wait:
        "Do not run the cross-repo command until /cross-repo-authorize has written the receipt (or the user explicitly redirects).",
      user_summary: `${crossRepo.rule_id} — cross-repo ${intent} ${target}: run /cross-repo-authorize first`,
    };
  }

  // ADVISORY (loom #19 P3): branch-scope warn on `git commit` invocations.
  // Delegates to .claude/hooks/pre-commit-branch-scope.js which always
  // exits 0 and writes any out-of-scope advisory to stderr. Warn-only.
  // loom#1368: the `(?![\w-])` negative lookahead is load-bearing. A trailing
  // word-boundary escape admits the `commit-tree` and `commit-graph`
  // sub-commands, which spawned this scope delegation on a non-commit.
  // loom#1549 HIGH-3 — was `/^\s*git\s+commit(?![\w-])/`. The `^` anchor made
  // this blind to every commit that is not the FIRST thing in the command:
  // `cd sub && git commit`, `git -C /repo commit`, `sudo git commit`,
  // `env GIT_AUTHOR_NAME=x git commit`. The shared parser matches all four.
  if (findCommitInvocation(command)) {
    try {
      const { spawnSync } = require("child_process");
      const scopeScript = path.join(__dirname, "pre-commit-branch-scope.js");
      // loom#1471 shard 6. This file's GIT calls were hardened in shard 2 and
      // its NODE calls were not — the same sibling-blindness that left the py
      // overlay and guard-path-scope behind, and the regrowth guard cannot see
      // it because that guard greps for a literal `git`, never a `node`.
      // `process.execPath` removes the PATH lookup; the env is built from
      // constants so the child cannot be steered by NODE_OPTIONS/NODE_PATH.
      //
      // SEVERITY, stated honestly: PATH, NODE_OPTIONS and NODE_PATH are ALL
      // already in settings-deny-guard-shape.js::DANGEROUS_ENV_EXACT, so this
      // is defence-in-depth rather than an open hole. It is NOT the severity of
      // the template-resolver shim, whose LOOM_LINKS_CONFIG is genuinely
      // unfenced. Recorded so the site count does not inflate the risk.
      const r = spawnSync(process.execPath, [scopeScript], {
        cwd,
        encoding: "utf8",
        timeout: 4500,
        env: nodeChildEnv(),
      });
      const output = (r.stderr || "").trim();
      if (output) {
        return { continue: true, exitCode: 0, message: output };
      }
    } catch {
      // Advisory failure must never block the commit.
    }
  }

  // HALT-AND-REPORT (loom #263): synced-artifact disclosure scan on
  // `git commit` invocations that stage any `.claude/**` path. Mirrors
  // the pre-commit-branch-scope.js delegation above. The scanner-on-
  // content is content-regex, so per rules/hook-output-discipline.md
  // MUST-2 (lexical signals MUST NOT carry severity:block) this returns
  // `halt-and-report`, NOT `block`. Scanner-internal error MUST NOT
  // block the commit (advisory-fail-open on tool error, exactly like
  // the scope delegation above).
  // loom#1368: the `(?![\w-])` negative lookahead is load-bearing — see the
  // scope delegation above; a trailing word-boundary escape admits the
  // `commit-tree` and `commit-graph` sub-commands.
  // loom#1549 HIGH-3 — same `^`-anchor blindness as the scope delegation above,
  // and it matters MORE here: this gates the loom#263 synced-artifact disclosure
  // scan, the fence that stops an operator hostname / org slug / home path from
  // reaching 30+ consumers' PERMANENT git history. `cd sub && git commit`
  // skipped it entirely.
  //
  // An `unresolvable` target does NOT skip the scan. The safe disposition for a
  // disclosure fence is to scan anyway: the cost of scanning a commit we cannot
  // fully attribute is a wasted spawn, and the cost of skipping one is
  // unrecoverable once pushed.
  const commitInv = findCommitInvocation(command);
  if (commitInv) {
    try {
      const { spawnSync } = require("child_process");
      // Only run when the commit stages a synced-surface path. Cheap
      // pre-filter — avoids scanning on commits that touch only non-
      // `.claude/**` files (the scanner already excludes never-synced
      // subpaths internally, but skipping the spawn entirely is faster).
      // loom#1471 shard 2 — same class; `--cached` reads the INDEX, which
      // GIT_DIR relocates wholesale, so a decoy index would mask which synced
      // paths a commit actually stages.
      const gitBin = resolveGitBinary();
      // loom#1549 HIGH-3 second-order: this read the session `cwd` INDEX even
      // when the commit retargets with `-C`, so `git -C /other commit` scanned
      // the wrong repository's staged set — reporting "no synced paths" for a
      // commit that stages plenty. Only honour a target the parser could fully
      // resolve; an `unresolvable` one (`-C "$PWD"`, `-C $(…)`) falls back to
      // `cwd`, which is where an unexpanded value would most likely have
      // pointed anyway, and never to a path built from bytes we did not expand.
      const commitDir =
        commitInv.dir && !commitInv.unresolvable ? commitInv.dir : cwd;
      const staged = gitBin
        ? spawnSync(gitBin, ["diff", "--cached", "--name-only"], {
            cwd: commitDir,
            encoding: "utf8",
            timeout: 3000,
            env: gitEnv(),
          })
        : null;
      const stagedFiles = ((staged && staged.stdout) || "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      // Unresolvable git makes the pre-filter INDETERMINATE, not negative. An
      // empty list would silently SKIP the disclosure scan — fail-open, and the
      // exact shape this sweep exists to remove. Rank it tightest: scan.
      //
      // loom#1471 shard 4. The `!gitBin` arm alone was NOT the whole fail-open.
      // A git that RAN and FAILED — timeout, exit 128, a `safe.directory`
      // refusal — leaves `stdout` empty, so `stagedFiles` is `[]`, `.some()` is
      // false, and the loom#263 disclosure scan was silently SKIPPED on a real
      // `git commit`. The status was never inspected. Every non-zero/errored
      // outcome now ranks tightest and scans, matching the sibling
      // dirty-tree probe above, which already gates on
      // `r.status !== 0 || typeof r.stdout !== "string"`.
      const stagedIndeterminate =
        !gitBin || !staged || Boolean(staged.error) || staged.status !== 0;
      const touchesSynced =
        stagedIndeterminate ||
        stagedFiles.some(
          (f) =>
            f.startsWith(".claude/") || f === "AGENTS.md" || f === "GEMINI.md",
        );
      if (touchesSynced) {
        const scanScript = path.join(
          __dirname,
          "..",
          "bin",
          "scan-synced-disclosure.mjs",
        );
        // loom#1471 shard 6 — see the scope delegation above. This one is the
        // pointed case: it is the loom#263 disclosure scanner, i.e. the guard
        // the regrowth test exists to protect, spawned by a shape that test
        // structurally cannot detect.
        const r = spawnSync(process.execPath, [scanScript, "--check"], {
          cwd,
          encoding: "utf8",
          timeout: 4000,
          env: nodeChildEnv(),
        });
        // r.status === null on spawn failure/timeout → fail-open.
        // r.error set on ENOENT / timeout → fail-open.
        // Exit 2 is a scanner usage error → fail-open (tool error, not
        // a disclosure finding). Only a clean exit 1 (≥1 finding) halts.
        if (!r.error && r.status === 1) {
          const report = (r.stderr || r.stdout || "").trim();
          const sample = report.split("\n").slice(0, 12).join("\n");
          return {
            severity: "halt-and-report",
            what_happened:
              "scan-synced-disclosure.mjs --check found ≥1 structural " +
              "disclosure on the synced surface in the staged `.claude/**` " +
              "changes:\n" +
              sample,
            why:
              "loom #263 synced-artifact disclosure fence — a staged " +
              "synced artifact contains an operator hostname / non-" +
              "Foundation org slug / org-derived runner label / operator " +
              "home path / launchd|systemd service-label stem. Committing " +
              "it propagates the disclosure to 30+ downstream consumers " +
              "(the #252 class) where it is permanently in their git " +
              "history and correlatable across all of them.",
            agent_must_report: [
              "Quote the scanner's redacted path:line + [SHAPE:<id>] rows " +
                "(the «REDACTED» context — never reconstruct the raw token)",
              "For each finding: genericize the disclosure in the synced " +
                "artifact, and RELOCATE the operator-specific value into " +
                "the gitignored operator-local companion (the #255 / #260 " +
                "pattern — *.operator.local.* / *.local.json)",
              "Re-stage the genericized files and re-run " +
                "`node .claude/bin/scan-synced-disclosure.mjs --check` " +
                "(exit 0) before re-attempting the commit",
              "Do NOT allowlist a real operator/org token to force the " +
                "scan green — that IS the #264 leak the scanner prevents",
            ],
            agent_must_wait:
              "Do not retry the commit until the scanner exits 0 on the " +
              "re-staged tree. If a finding is a genuine shape over-match " +
              "on a Foundation-public token, surface it to the user — the " +
              "allowlist fix is a scoped scanner edit, not a commit bypass.",
            user_summary:
              "synced-disclosure scan blocked the commit (loom #263) — " +
              "genericize + relocate to the operator-local companion",
          };
        }
      }
    } catch {
      // Scanner-internal/spawn error MUST NOT block the commit.
      // Advisory-fail-open on tool error, identical to the branch-scope
      // delegation above. A real disclosure is still caught by the
      // fail-closed /sync Gate 2 backstop (sync-flow.md § Gate 2 step 0).
    }
  }

  // BLOCK: Three-layer Bash mutation detection against trust-posture state files.
  // This is the PRIMARY structural control for Bash-mediated state-file writes
  // (F123): settings.json's Bash(verb:path) deny-matrix was removed as
  // structurally incompletable — a verb-enumerating denylist can never cover
  // every write-capable shell verb (awk/dd/perl/printf>/sponge/...) nor the
  // redirect operator itself. This interceptor matches on the TARGET PATH
  // regardless of verb, so it supersedes the denylist instead of racing it.
  // Edit/Write tool writes remain fenced by the settings.json Edit/Write+path
  // deny rules + posture-gate + integrity-guard. Pattern adopted from a
  // downstream state-file-write-guard (issue #25, c0aeff73).
  //
  // Protected paths:
  //   .claude/learning/posture.json, posture.json.bak, posture.json.tmp.N
  //   .claude/learning/violations.jsonl, violations.jsonl.*
  //   .claude/learning/observations.jsonl, observations.jsonl.*
  //   .claude/learning/coordination-log.jsonl   (iter-4 MED-R4-3)
  //   .claude/learning/presence-mechanism.json  (#583 residual b)
  //   .claude/learning/.initialized
  //   .claude/operators.roster.json             (iter-4 MED-R4-3)
  //
  // F14 C2 iter-4 MED-R4-3: extended the regex to cover roster + coordination
  // log. Pre-iter-4 a `cat > .claude/operators.roster.json << EOF ... EOF`
  // heredoc bypassed BOTH the deny matrix (no cat: entry) AND the Layer-1
  // redirect detector — same Bash-redirect mutation vector that motivates
  // the three-layer detection in the first place. Coordination-log writes
  // are owned exclusively by transport-filesystem.js + sibling-porcelain.js
  // (signed, sequence-bound, integrity-guarded); direct Bash mutation
  // bypasses every coordination invariant.
  //
  // Commit-message exception: `git commit -m "..."` or `git commit -F path`
  // bodies are documentation prose, not executable commands. Detection is
  // skipped for the COMMIT SEGMENT ONLY, segment-awarely (#745): the command
  // is split on top-level UNQUOTED `&&`/`||`/`;`/`|`, the git-commit-body
  // exception applies per-segment, and mutation-detection runs on every
  // OTHER segment. This closes #745 Evasion 1 (`git commit -m x && rm
  // <state>`, which the prior whole-command skip let through because
  // `[^|;]*` did not exclude `&`) WITHOUT re-exposing the false positive a
  // naive split would (`git commit -m "… && rm <state>"` — the `&&` is
  // inside the quotes, so it is NOT a split point and the whole command
  // stays one skipped commit segment). See violation-patterns.js
  // ::detectStateFileMutationSegmentAware + state-file-write-guard.md Rule 5.
  // M5 iter-6 Sec-MED-A2: extended to cover .heartbeat-cache and
  // .session-end-cache. Pre-iter-6 these two M5-substrate cache files
  // had no Layer-1 redirect-detector coverage AND no deny-matrix entry,
  // leaving the cross-operator cache-poisoning vector exposed: a
  // `cat > .claude/learning/.heartbeat-cache << EOF { "verified_id":
  // "<attacker>", "last_heartbeat_ms": Date.now(), "seq": 99 } EOF`
  // would coalesce future heartbeats under the attacker's seq number.
  // Paired with the readCache identity-guard in adjacency-heartbeat.js
  // (rejects cache whose verified_id ≠ current operator).
  //
  // #583 residual (b): extended to cover presence-mechanism.json — the
  // provisioning-state signal (actuation-types.js::isPresenceMechanismConfigured).
  // Under the Shard-3a ALWAYS-ON model the presence requirement does NOT gate on
  // this file — the fold rejects an ABSENT actuation on static type-membership,
  // unconditionally. The file is the loom↔loom-command provisioning contract +
  // the AC-L15 defense-in-depth signal for any future conditional consumer, and
  // it stays write-guarded so an in-process/LLM caller cannot forge a
  // "provisioned" state a future conditional consumer would trust (nor downgrade
  // a provisioned gate) — the identity-≠-intent mintability class #583 closes,
  // one layer deeper. It is a human / out-of-band-only config. Hard-denied at
  // BOTH the file-tool layer (settings.json Edit/Write/NotebookEdit deny) AND
  // this Bash layer; NOT routed through integrity-guard's /codify-lease flow
  // (it is not codify-authored).
  //
  // observations.jsonl (Bash-layer parity with violations.jsonl): closes a
  // Bash-mutation gap surfaced empirically 2026-07-02. observations.jsonl and
  // violations.jsonl are declared SAME-CLASS by knowledge-convergence.md MUST-6
  // (both MUST route through appendStamped(); an unsigned line cannot be
  // attributed to a human), and integrity-guard.js watches BOTH for Edit/Write —
  // but this Bash-mutation guard protected only violations.jsonl, so a
  // `node -e "fs.appendFileSync('.claude/learning/observations.jsonl', <unsigned>)"`
  // bypassed the signing invariant and injected an unsigned, unattributable
  // observation — corrupting the attribution/posture signal (an unsigned line
  // cannot be attributed to a human). It ALSO feeds trust-posture.md Rule 5 #3
  // upgrade evidence ("logged as positive observation"), but that upgrade path is
  // AND-gated on a human challenge-nonce the agent cannot mint (Rule 5 #4), so the
  // durable harm is attribution-signal corruption, NOT self-promotion (R1
  // security-reviewer Finding 1). The legitimate writer (learning-utils.js::logObservation) is
  // an in-process fs.appendFileSync inside the hooks — NOT a Bash tool call — so
  // it is unaffected; the codify-backlog.mjs reader names the path in its script
  // BODY (residual (c) — not on the command line), so it is unaffected too.
  //
  // operators.roster.schema.json (Bash-layer parity with operators.roster.json):
  // closes a DIRECT-set↔STATE_PATH_RX asymmetry surfaced by reviewer LOW-1 during
  // the PR #758 redteam (#761). The schema is the roster VALIDATION contract —
  // integrity-guard.js watches it in DIRECT (Edit/Write layer, per F67), but this
  // Bash-mutation guard covered only operators.roster.json, so a
  // `node -e "fs.writeFileSync('.claude/operators.roster.schema.json', <weakened>)"`
  // bypassed the Bash layer and could silently relax the trust-root contract
  // (drop propertyNames prototype-pollution rejection, relax the GPG-fingerprint
  // constraint, add a host_role synonym). UNCONDITIONAL, exactly like its
  // operators.roster.json sibling: the schema's legitimate writers are /codify
  // Edit/Write (fenced by integrity-guard's codify-branch+lease) and /sync —
  // NEVER a Bash node -e — so a flat Bash block over-blocks nothing. (Distinct
  // from coordination-mode.json below, which DOES need enrolled-vs-solo gating.)
  //
  // settings.json (#1309 — the deny-list contract itself): .claude/settings.json
  // DEFINES the file-tool deny guards that protect every state file above, yet was
  // itself in NONE of the three protection layers. A silent Bash strip of its
  // `permissions.deny` array (`echo {} > .claude/settings.json`, `node -e
  // "fs.writeFileSync('.claude/settings.json',…)"`, `sed -i`, `tee`) removes the
  // file-tool layer for ALL state files at once, with no trace — the same shape as
  // the operators.roster.schema.json weakening one level up (the deny CONTRACT, not
  // a guarded file). UNCONDITIONAL flat add, empirically validated SAFE against
  // over-block (build-spec §L2): the ONLY legitimate Bash writer is
  // `node .claude/bin/reconcile-settings-deny.mjs --write .claude/settings.json`,
  // which passes the path as a POSITIONAL ARG with no redirect / no `-e` body —
  // `detectStateFileMutation` returns null for it (verified: --write → null,
  // --check → null), while the adversarial forms (`node -e` write, `>` redirect,
  // `tee`, `sed -i`) all FLAG. The L3 SessionStart drift-guard writes IN-PROCESS
  // (not a Bash tool call), like coc-append, so it is unaffected too. settings.json
  // KEEPS block at Layer 3 (LAYER3_BLOCK_RX below): on a coordination-OFF downstream
  // (the default) no fold re-derives a stripped deny array, so a forged strip would
  // STAND — an autonomy/security downgrade, not a fold-cache, exactly like
  // posture.json. Precedent: operators.roster.schema.json (#758/#761).
  //
  // VERSION (#1399 — the repo-CLASS root of trust): `.claude/VERSION::type` is read
  // by `lib/manifest-source.mjs::readRepoClass` (sole definition,
  // `.claude/bin/lib/manifest-source.mjs:242`) and from there gates Validator 15
  // ENTIRELY, Validator 17's half B, Validator 16's presence classifier, and the
  // owner-class absence throw. #1386 routed loom's manifest readers through that one
  // class-aware reader, so several previously-independent distribution gates now share
  // ONE input. Production call sites: 8 — `emit.mjs:1940`, `:2333`, `:2427`, `:2781`
  // and `lib/manifest-source.mjs:300`, `:426`, `:475`, `:509` (re-derive with
  // `grep -rn 'readRepoClass(' .claude/bin .claude/hooks | grep -v 'export function'`;
  // the total including tests + the one import line is 28, which is a DIFFERENT number
  // — name which you mean).
  //
  // SCOPE — what this fence does and does NOT close. It closes the BASH-LANE HALF of
  // the deliberate agent-write vector: an in-session Bash mutation of the class root.
  // TWO paths stay open, and neither is hypothetical:
  //
  //   (a) The EDIT-TOOL half of the SAME deliberate agent-write vector. The file-tool
  //       deny is DELIBERATELY DECLINED (see reconcile-settings-deny.mjs § "#1399"),
  //       so an `Edit(.claude/VERSION)` passes every file-tool PreToolUse hook —
  //       verified end-to-end, with `Edit(.claude/learning/posture.json)` as the
  //       control (it BLOCKS at integrity-guard, so the harness demonstrably has
  //       teeth). An Edit-tool write IS a deliberate agent write, and it is the EASIER
  //       path of the two. Do not read "deliberate agent-write vector" as closed.
  //   (b) The ACCIDENT vector #1399's prose motivates (a mis-merged / mis-synced
  //       VERSION). An accidental copy arrives via `git merge` or a sync script —
  //       NEITHER a Bash tool call NOR an Edit tool call — so no agent-write fence can
  //       see it, and BOTH fences #1399 prescribes are agent-write fences. That vector
  //       needs a CROSS-CHECK (class vs manifest), not a fence, and is tracked as
  //       #1402: `emit.mjs` already carries one (`_classifyManifestPresence` + the
  //       owner-class absence throw), but `emit-cli-artifacts.mjs` and `emit-coc.mjs`
  //       carry NEITHER — measured 0 / 0 against `emit.mjs`'s 3 / 3, so the greps are
  //       known-good.
  //
  // Worth doing regardless: against someone who can already write VERSION this is a
  // CONCENTRATION of trust rather than a new privilege (they could usually write
  // sync-manifest.yaml too), but a deliberate write here silently converts Validator 15,
  // V17's half B, and V16's presence classifier into no-ops and prints GREEN. Nothing
  // re-derives VERSION, so it is non-fold-derived authority state and KEEPS block at
  // Layer 3 (LAYER3_BLOCK_RX below), same disposition as posture.json / settings.json.
  //
  // PROSE-FP EXPOSURE — the ratified MUST-2 deviation's premise is WEAKEST here, and
  // this add makes it weaker. The Layer-3 `block` is permitted by the deviation recorded
  // in state-file-write-guard.md § "Severity by layer", whose stated justification is
  // that these paths carry "prose-FP risk ~0". That premise has ALREADY been found false
  // once (#1363) and repaired. VERSION is the most-mentioned of the protected set —
  // measured over `.claude/**/*.md` at this commit with
  // `grep -rF "<path>" .claude --include='*.md'` (count / distinct files):
  //
  //     .claude/VERSION                86 / 24      <- this add
  //     .claude/settings.json          63 / 28
  //     .claude/learning/posture.json  21 / 15
  //
  // (An earlier review reported 56/18, 23/14, 11/10 for the same three. The ORDER is
  // stable, the magnitudes are not — the two runs used different corpora and neither
  // stated its scope. Re-derive with the command above rather than trusting either set;
  // the point is the ordering, not the multiplier.)
  //
  // Consequence: the two OPEN over-block residuals now reach the most-documented path in
  // the corpus. Both are recorded in state-file-write-guard.md § "Known residuals" and
  // each is owed its OWN shard — do NOT attempt either here:
  //   (k) a write to a THROWAWAY sandbox path ending in this basename still flags
  //       (Layer 1 and Layer 3), because the detector has no notion of WHICH repo root
  //       a state path belongs to.
  //   (l) a heredoc report that merely QUOTES a write command as an EXAMPLE flags at
  //       Layer 1, because a file-util verb next to a literal state path inside a
  //       multi-command bundle is indistinguishable from the real thing.
  //
  // This is not theoretical and this shard's own review paid it twice: residual (l) is
  // recorded as having blocked three independent actors in ONE round, every one while
  // VERIFYING this guard — and the adversarial reviewer of THIS PR could not run its
  // symlink-containment attack at all, because (k) fenced the sandbox path it needed to
  // stage in. Extending (l) to a path with this prose frequency raises that self-sealing
  // cost, and argues for bumping (l)'s priority on the #1363 shard. Direction is
  // fail-CLOSED (over-block, never fail-open), which is why it is a disclosure and not a
  // blocker.
  //
  // OVER-BLOCK measured, then removed (the one legitimate Bash-lane writer class): a
  // 15-command legitimate corpus was run through the REAL detector under this regex
  // before/after. 13/15 unaffected — `cat`/`jq -r`/`grep`/`diff`/`shasum`/`git add`/
  // `git show`/a `:(exclude)` pathspec/a read-only `node -e`/prose in a `--body` or
  // `-m`/the `stamp-template-version.mjs --write --worktree <wt>` stamper (which never
  // puts the literal path on the command line, exactly like the sanctioned
  // `reconcile-settings-deny.mjs --write` writer). The 2 that DID newly flag are the
  // same shape: `/migrate`'s snapshot + `--rollback` restore both `cp` the file, which
  // fires Layer 2 (`cp`) because Layer 2 is DIRECTION-BLIND — `pathRx.test(line)` matches
  // the path in the SOURCE position identically to the DESTINATION, so even the snapshot
  // (a pure READ) blocks. That is a property of the shared Layer-2 branch for all 11
  // pre-existing paths, not something this add introduces; narrowing it to
  // destination-position would change the predicate for every protected path and owes its
  // own shard.
  //
  // Resolved at the CALLER, by DOMAIN not by instance: the two EXECUTABLE sites are in
  // `skills/30-claude-code-patterns/multi-cli-migration.md` — the Step-1 snapshot (~:162)
  // and the `--rollback` restore (~:567) — and both now hold the path in a VARIABLE on its
  // OWN line, so no single line carries both a Layer-2 verb and the literal path. That is
  // the licensed-writer idiom this guard's own rule doc blesses (`state-file-write-guard.md`
  // § "Known residuals" (a) var-indirect / (c) by-path ceremony — the mechanism
  // `/whoami --register` and `/certify` rely on BY DESIGN), and it is already the idiom the
  // rollback block's `$p` loop uses for its other 9 paths. `commands/migrate.md` Steps 1 +
  // --rollback carry PROSE only ("Copy … into `.pre-migrate.bak/`"); their prose now names
  // the variable form so an agent does not re-derive the blocking `cp`.
  // `bin/repin-downstream.mjs:479` stages via `shMaybe("git", ["add", …])` — an in-process
  // execFileSync, never a Bash tool call — so it is unaffected, as is the whole hook-writer
  // class (`version-utils.js` SessionStart auto-create ~:308 + type auto-correct ~:519).
  // All 13 adversarial write vectors (redirect/append/force-clobber/tee/sed -i/jq -i/
  // heredoc/rm/mv/truncate/node -e/python -c/perl -e) newly FLAG.
  //
  // NOT added to reconcile-settings-deny.mjs::CANONICAL_STATE_DENY — DELIBERATE, see the
  // § "#1399 — why VERSION is NOT in this list" block there. Unlike every entry in that
  // list, `.claude/VERSION` has TWO Edit/Write-TOOL writers on documented HAPPY paths
  // (`/sync-from-template` Step 6, which runs at every downstream consumer on every
  // pull and is dispositive alone; and `/migrate` Step 2), plus one on a HALT path
  // (`/codify` Step 7c's operator-facing self-service fix — listed for completeness,
  // not load-bearing). A flat `Edit()` deny would break the happy-path two — the same
  // reason settings.json's own L1 blanket deny is omitted. Exact verbatim citations
  // live at the declining site; do not re-derive them from memory.
  // The Bash lane (here) is the half that closes with no legitimate casualty.
  // CASE-INSENSITIVE (`i`) IS LOAD-BEARING, NOT COSMETIC — and the same flag is
  // required on LAYER3_BLOCK_RX and COORD_MODE_RX below (all three are independent
  // path matchers over the same protected-state concept; a new fail-closed dimension
  // MUST land at EVERY surface in the same change per security.md § Enforcement-Surface
  // Parity — fixing only this one would leave the Layer-3 block-set and the
  // coordination-mode fence still defeatable by the identical form).
  //
  // On a case-INSENSITIVE filesystem (APFS default on macOS — the default dev
  // platform for this corpus) `.claude/version` and `.claude/VERSION` are THE SAME
  // FILE, so a case-SENSITIVE matcher is defeated by a one-character change.
  // MEASURED against the real hook before this fix, canonical vs case-variant
  // (exit 2 = blocked, 0 = passed):
  //
  //     VERSION           canonical=2  variant=0     settings.json     canonical=2  variant=0
  //     posture.json      canonical=2  variant=0     violations.jsonl  canonical=2  variant=0
  //     operators.roster  canonical=2  variant=0     .CLAUDE/ dir-case canonical=2  variant=0
  //
  // 6/6 canonical controls blocked (anti-vacuity), 6/6 variants passed. FOUR of these
  // (settings/posture/violations/roster) reproduce on origin/main @ 91453fe2 and are
  // therefore PRE-EXISTING, not introduced by #1399 — owned here regardless per
  // zero-tolerance.md Rule 1a (a finding on a PR scan is treated identically to one on
  // a main scan; "same on main" is NOT a deferral). The forged writes this re-closes are
  // the ones this file's own § SCOPE calls non-fold-derived: a forged posture.json is a
  // trusted L5 grant, a wiped violations.jsonl evades cumulative downgrade.
  //
  // FALSE-POSITIVE COST, MEASURED not assumed — scope `.claude/**/*.md` at this commit,
  // as (count / distinct files): `.claude/VERSION` 97/24 and `.claude/settings.json`
  // 63/28 (canonical, already matched today) vs `.claude/version` 0/0, settings
  // case-variants 0/0, `.claude/` dir case-variants 0/0. The `i` flag therefore adds
  // ZERO new prose matches across the corpus — it does not widen the residual (l)
  // over-block that already blocked four independent actors verifying this guard.
  //
  // On a case-SENSITIVE filesystem (Linux CI) `.claude/version` IS a distinct file, so
  // there the flag is a pure (measured-zero) over-block rather than a fix. That
  // asymmetry is accepted deliberately: this hook SYNCS to consumers on mixed
  // platforms, and a guard whose protection depends on the host filesystem is worse
  // than one that over-blocks a path nobody writes.
  // STATE_PATH_RX is BUILT from the registry (see the module-scope require).
  // Its rows carry `surfaces.bash: true`; #1409's redundant-separator token and
  // the `i` flag are properties of the builder, so both apply to every surface
  // at once rather than needing three hand-edits.
  const stateFileMutation = detectStateFileMutationSegmentAware(
    command,
    STATE_PATH_RX,
  );
  if (stateFileMutation) {
    try {
      logLearningObservation(cwd, "rule_violation", {
        rule: "trust-posture/state-file-mutation",
        layer: stateFileMutation.layer,
      });
    } catch {}
    // #1293 (co-owner-ratified 2026-07-22, disposition "Option X" after the
    // security redteam refuted the initial broad carve-out): Layer 3 (a lexical
    // interpreter -c/-e/-m body scan) is DEMOTED to halt-and-report ONLY for state
    // whose forged write is genuinely NEUTRALIZED downstream WITHOUT relying on a
    // fold that may not run:
    //   - observations.jsonl — self-PROMOTION from a forged positive observation
    //     is AND-gated on the human challenge-nonce (trust-posture.md MUST-5), and
    //     a WIPE only harms the agent's OWN upgrade eligibility (self-harm, not
    //     escalation); this is the actual #1293 false-positive path (Class 2).
    //   - .heartbeat-cache / .session-end-cache — ephemeral, no autonomy grant.
    // Everything else in STATE_PATH_RX KEEPS severity:block at Layer 3 via
    // LAYER3_BLOCK_RX. The critical reason (security redteam): the severity router
    // does NOT (and MUST NOT be assumed to) run on a coordination-ENABLED repo —
    // coordination is OFF by DEFAULT on most downstream consumers of this synced
    // guard, and on an OFF repo there is NO coordination log and NO fold. So the
    // "re-derived away by the signed fold" defense is UNAVAILABLE there, and:
    //   - posture.json (+.bak/.tmp) is the primary autonomy grant with NO
    //     signature check at read (state-io.js::readPosture) — a schema-valid
    //     forged L5 would be trusted verbatim (autonomy escalation);
    //   - .initialized gates fresh-repo-vs-corrupt — deleting it + posture.json
    //     yields a fresh-repo L5 reset (trust-posture.md MUST-2 / CRIT-4);
    //   - violations.jsonl is the cumulative-downgrade counter — a wipe evades it;
    //   - presence-mechanism.json is a standalone provisioning contract (see the
    //     block rationale ~L452), not fold-derived;
    //   - operators.roster.* / coordination-log.jsonl are committed / append-
    //     authority sources (2-of-N quorum PR / signed hash-chain).
    //   - settings.json (#1309) is the file-tool DENY CONTRACT protecting every
    //     path above; a forged strip of its permissions.deny on an OFF repo is
    //     re-derived by NO fold — the L3 drift-guard self-heals at the NEXT
    //     session-start, not at the write, so an interpreter-body strip STANDS
    //     until then (an autonomy/security downgrade), so it keeps block.
    //   - VERSION (#1399) is the repo-CLASS root of trust: readRepoClass trusts
    //     `type` VERBATIM (no signature, no cross-check) and NOTHING re-derives the
    //     file, on an ON repo or an OFF one — so a forged class STANDS and silently
    //     no-ops Validator 15 entirely, Validator 17's half B, and V16's presence
    //     classifier. Same non-fold-derived disposition as posture.json, and the
    //     failure is SILENT-GREEN rather than loud, which is what earns block here.
    // None of these are re-derived away on an OFF repo, so their Layer-3 forgery
    // would STAND — they keep block. Prose-mentions of these paths are rare (the
    // #1292 gh/echo/printf mask already handles the doc-wrapper case), so the FP
    // cost of keeping block is ~0. Layers 1/2/4 are structural command-shape
    // signals → always block. NOTE (hook-output-discipline.md MUST-2): a Layer-3
    // block IS a lexical signal; keeping it for LAYER3_BLOCK_RX is a DELIBERATE,
    // ratified, fail-closed defense-in-depth deviation (over-blocks a rare real
    // write, never under-blocks) — documented in state-file-write-guard.md
    // § "Severity by layer".
    // LAYER3_BLOCK_RX is BUILT from the registry rows carrying
    // `surfaces.layer3: true` — the subset whose forged write is NOT re-derived
    // away by a fold. It was "surface 2 of 3" for the case-insensitivity
    // dimension; there is now ONE surface to teach.
    const isStructural =
      stateFileMutation.layer === 1 || stateFileMutation.layer === 2;
    const isLayer3BlockPath =
      stateFileMutation.layer === 3 && LAYER3_BLOCK_RX.test(command);
    if (isStructural || isLayer3BlockPath) {
      return {
        severity: "block",
        what_happened: isStructural
          ? `Bash command attempts to mutate trust-posture state file (Layer ${stateFileMutation.layer}: ${stateFileMutation.kind}): ${command.slice(0, 120)}`
          : `Bash command attempts to mutate trust-posture state file — an interpreter-body write to non-fold-derived autonomy/authority state (posture/.initialized/presence/violations/roster/coordination-log/settings.json/VERSION) (Layer 3: ${stateFileMutation.kind}): ${command.slice(0, 120)}`,
        why: isStructural
          ? "trust-posture/state-file-mutation — a redirect/file-util verb on a literal state path (posture.json, violations.jsonl, coordination-log.jsonl, .initialized) is a structurally-unambiguous mutation; state files are owned by hooks and agent edits are BLOCKED"
          : "trust-posture/state-file-mutation — this path is NOT re-derived away by the signed fold (coordination is OFF by default downstream, so no fold runs): a forged posture.json is a trusted L5 grant, deleting .initialized resets to fresh-repo L5, wiping violations.jsonl evades cumulative downgrade, presence-mechanism.json is a standalone provisioning contract, roster/coordination-log are committed/append-authority, settings.json is the file-tool deny CONTRACT protecting all of them (#1309), and .claude/VERSION is the repo-CLASS root of trust whose `type` readRepoClass trusts verbatim — a forged class silently no-ops Validator 15, Validator 17's half B, and V16's presence classifier while printing green (#1399). An interpreter-body WRITE to any of them stays BLOCKED at the Bash boundary (#1293 Option X; #635 guarantee)",
        agent_must_report: [
          "Quote the exact bash command that was attempted",
          "State whether you intended to read, debug, or modify the state",
          isStructural
            ? "If reading: use `cat` (allowed); if modifying: use /posture command instead"
            : "If reading: use `cat`, or an interpreter body with NO write token (a read-only `-e`/`-c` body passes the #1292 gate — this is how /codify Step 6b filters the violation records); posture routes through /posture, roster through /whoami --register, coordination-log through the canonical signed-append ceremony — never an inline interpreter write",
          // #1363: the WRITING-ABOUT-state-files case. A protected path quoted in
          // human prose is masked (quote-aware, every prose carrier), but a body
          // that genuinely EXECUTES — a live backtick or `$(…)` inside DOUBLE
          // quotes — still fires, correctly, because the shell would run it. The
          // fix is a quoting change, and it is not discoverable from a `cat`
          // suggestion, so name it explicitly.
          "If this command only DESCRIBES a state file (an issue body, PR description, commit message, release note): single-quote the body so markdown backticks stay literal, or pass it via `--body-file` / `-F <file>`; author a scratch file with the Write tool rather than a Bash heredoc",
        ],
        agent_must_wait:
          "Do not retry the same form. State-file mutations route through the canonical ceremony (challenge-nonce / quorum / signed-append gated), never directly. If the command was PROSE about a state file rather than a mutation, re-issue it in the quoted/`--body-file` form above rather than re-running it verbatim.",
        user_summary: `state-file mutation blocked (Layer ${stateFileMutation.layer}${isStructural ? "" : ", non-fold-derived"})`,
      };
    }
    // Layer 3 on a genuinely-bounded path (observations.jsonl / ephemeral caches)
    // — advisory (non-blocking): lexical body scan, and the forgery is neutralized
    // WITHOUT relying on a fold (nonce-gated promotion / self-harm-only wipe).
    return {
      severity: "halt-and-report",
      what_happened: `Bash command references a bounded trust-posture state file inside an interpreter body (Layer 3: ${stateFileMutation.kind}): ${command.slice(0, 120)}`,
      why: "trust-posture/state-file-mutation (Layer 3 on a bounded path — observations.jsonl / .heartbeat-cache / .session-end-cache — advisory per #1293 Option X + hook-output-discipline.md MUST-2) — a lexical scan of an interpreter -c/-e/-m body cannot tell an executed write from a read-only body or a write-example quoted as documentation, so block-severity here is the recurring false-positive class. This surfaces as advisory because the forgery is neutralized WITHOUT a fold: a forged positive observation cannot self-upgrade (challenge-nonce gated) and a wipe only harms the agent's own upgrade eligibility. Autonomy/authority state (posture, .initialized, presence, violations, roster, coordination-log) stays BLOCKED.",
      agent_must_report: [
        "Quote the exact bash command that was flagged",
        "Confirm whether it WRITES observations.jsonl / a cache file, or merely reads / quotes one as an example",
        "If it writes state directly: stop (positive observations are earned, not written); if it reads or quotes an example: proceed",
      ],
      agent_must_wait:
        "Advisory only — the command was NOT blocked. A forged positive observation cannot upgrade posture (challenge-nonce gated); do not rely on hand-written state.",
      user_summary: `state-file bounded interpreter-body reference flagged (Layer 3, advisory)`,
    };
  }

  // HALT-AND-REPORT: `git config` write to a security-load-bearing key of THIS
  // repository's own config (loom#1470 defeat 2).
  //
  // This sits beside the STATE_PATH_RX lane above because it closes that lane's
  // one structural blind spot rather than extending it. Every git-derived
  // security property in this repo — the #1441 commit attestation, the #1462
  // repo-family jurisdiction primitive, the #1464 subprocess-env allowlist —
  // reads its answer from git, and `git config core.repositoryformatversion 99`
  // mutates the file all of them rest on WITHOUT the string `.git/config`
  // appearing anywhere in the command. A path matcher cannot see it, so no
  // registry row could have carried this; and the write goes AROUND the #1464
  // env allowlist rather than through it (a repository's own config is always
  // read and has no off switch), so no env fix reaches it either.
  //
  // SEVERITY IS CAPPED AT halt-and-report, DELIBERATELY (hook-output-discipline
  // .md MUST-2): this is a LEXICAL regex over a command string, not a
  // structural command-shape signal. The ratified Layer-1/2 `block` deviation
  // recorded in state-file-write-guard.md § "Severity by layer" is scoped to
  // the PATH lane and is NOT extended here — a lexical scan cannot distinguish
  // an executed write from one quoted inside a construct it mis-parsed, which
  // is exactly the false-positive class #1363 documented.
  const gitConfigMutation = detectGitConfigMutation(command);
  if (gitConfigMutation) {
    try {
      logLearningObservation(cwd, "rule_violation", {
        rule: "trust-posture/git-config-mutation",
        key: gitConfigMutation.key,
      });
    } catch {}
    return {
      severity: "halt-and-report",
      what_happened: `Bash command writes a security-load-bearing key of this repository's own git config (${gitConfigMutation.kind}): ${command.slice(0, 120)}`,
      why: "loom#1470 defeat 2 — `.git/config` is the file every git-derived security property in this repo reads its answer from (commit attestation, repo-family jurisdiction, the subprocess-env allowlist). The fenced keys are the ones that carry authority rather than ergonomics: `core.repositoryformatversion` makes every git command in the repo refuse; `core.worktree`/`core.bare` repoint the working tree every path-scoped fence resolves against; `core.hooksPath`/`core.fsmonitor`/`core.sshCommand` each name a program git EXECUTES during ordinary operations; `include.path`/`includeIf.*.path` pull an attacker-chosen config file in and re-open all of the above indirectly; `extensions.*` is repository-format state. `GIT_CONFIG_NOSYSTEM` and `GIT_CONFIG_GLOBAL=/dev/null` cannot neutralise any of it — a repository's OWN config is always read — so the Bash boundary is the only place this is visible before it runs. Advisory per hook-output-discipline.md MUST-2: this is a lexical command-string match, so it reports rather than blocks.",
      agent_must_report: [
        "Quote the exact bash command that was flagged",
        `State why this session needs to write \`${gitConfigMutation.key}\` rather than read it (\`git config --get ${gitConfigMutation.key}\` is not flagged)`,
        "Confirm the write is operator-intended repository setup, not a step that widens what a later gate will accept",
      ],
      agent_must_wait:
        "Advisory only — the command was NOT blocked. Reads of these keys pass unflagged; `--global`/`--system` writes are out of scope by construction, and `git -c key=value <cmd>` is a per-invocation override that persists nothing. If you need a per-command setting, prefer that form over a persistent write.",
      user_summary: `git config write to ${gitConfigMutation.key} flagged (advisory)`,
    };
  }

  // BLOCK (conditional): coordination-mode.json Bash mutation on an ENROLLED repo.
  //
  // #761 (reviewer LOW-1, PR #758 redteam): coordination-mode.json is the opt-in
  // override. integrity-guard.js watches it in DIRECT (Edit/Write layer), but this
  // Bash guard did not — so on an enrolled repo a
  // `node -e "fs.writeFileSync('.claude/learning/coordination-mode.json','{\"enabled\":false}')"`
  // bypassed the Bash layer and could silently flip the substrate off.
  //
  // UNLIKE roster.schema.json above, a FLAT STATE_PATH_RX add here would OVER-BLOCK
  // a solo consumer's own Bash-lane write to coordination-mode.json (their opt-in
  // escape hatch). So THIS Bash guard is enrolled-vs-solo asymmetric, mirroring
  // integrity-guard's W1-b: block the Bash mutation ONLY when
  // isCoordinationEnabled(mainCheckout) is true; on a solo/OFF repo this guard passes
  // through (it does not block the Bash write). SCOPE NOTE: "passes through" is about
  // THIS Bash lane only — the Edit/Write file-tool lane is governed by integrity-guard's
  // DIRECT set (which is ITSELF enrolled-vs-solo asymmetric: it passes through on a
  // solo/OFF repo and blocks off-codify Edit/Write only when enrolled). #762 (2026-07-02,
  // option a) DROPPED coordination-mode.json from settings.json permissions.deny precisely
  // so the file-tool lane matches this Bash guard's conditional model: on a solo repo the
  // consumer may Edit/Write their opt-in escape hatch freely (integrity-guard passthrough,
  // no settings deny); on an enrolled repo integrity-guard's DIRECT set blocks the
  // off-codify write. Both lanes are now solo-writable / enrolled-gated — no unconditional
  // file-tool deny remains.
  //
  // The enrolled block here is DEFENSE-IN-DEPTH, not the load-bearing fence: even if a
  // `{enabled:false}` Bash write LANDS on an enrolled repo, the substrate stays ON
  // because coordination-mode.js's asymmetric-precedence predicate (_refuseLocalDisable)
  // REFUSES to honor a local {enabled:false} on an enrolled repo at resolution time.
  // This Bash guard just stops the write from landing at all. That is why fail-OPEN on
  // a resolution error is acceptable: the real fence (the precedence refusal) plus the
  // Edit/Write DIRECT-set fence both remain. We wrap isCoordinationEnabled in try/catch
  // defensively — integrity-guard asserts it "never throws" and calls it bare, but this
  // belt-and-suspenders Bash layer fails open regardless, so a future throw degrades
  // only this DEPTH layer, never the primary controls.
  let coordEnabled = false;
  try {
    const mainCwd = resolveMainCheckout(cwd) || cwd;
    coordEnabled = isCoordinationEnabled(mainCwd) === true;
  } catch {
    coordEnabled = false; // fail-open (aligned with integrity-guard passthrough)
  }
  if (coordEnabled) {
    // COORD_MODE_RX is BUILT from the registry row carrying
    // `surfaces.coordMode: true` — its own surface precisely because a FLAT add
    // to STATE_PATH_RX would over-block a solo consumer's opt-in escape hatch.
    const coordMutation = detectStateFileMutationSegmentAware(
      command,
      COORD_MODE_RX,
    );
    if (coordMutation) {
      try {
        logLearningObservation(cwd, "rule_violation", {
          rule: "multi-operator-coordination/coordination-mode-bash-mutation",
          layer: coordMutation.layer,
        });
      } catch {}
      return {
        severity: "block",
        what_happened: `Bash command attempts to mutate the coordination opt-in override on an ENROLLED repo (Layer ${coordMutation.layer}: ${coordMutation.kind}): ${command.slice(0, 120)}`,
        why: "multi-operator-coordination/coordination-mode — on an enrolled repo, .claude/learning/coordination-mode.json is owned by the /codify flow (integrity-guard DIRECT set); a Bash write off-codify could silently disable the substrate. Bash-layer parity with integrity-guard's Edit/Write coverage (#761). Solo repos are unaffected (this branch fires only when coordination is enabled).",
        agent_must_report: [
          "Quote the exact bash command that was attempted",
          "State whether you intended to read, debug, or change the coordination mode",
          "If reading: use `cat` (allowed); if changing: coordination-mode is a /codify-flow (codify-branch + lease) edit on an enrolled repo, never a direct Bash write",
        ],
        agent_must_wait:
          "Do not retry. On an enrolled repo, coordination-mode changes route through the /codify flow (integrity-guard codify-branch + covering lease), never a direct Bash write.",
        user_summary: `coordination-mode Bash mutation blocked on enrolled repo (Layer ${coordMutation.layer})`,
      };
    }
  }

  // BLOCK: Dangerous commands (with evasion-resistant patterns)
  const dangerousPatterns = [
    {
      // \b anchors rm to a command/path boundary so a word ENDING in "rm"
      // (confiRM, perfoRM, platfoRM, aRM) followed by " /" no longer matches.
      // `/` is a non-word char, so \b still fires for path-qualified `/bin/rm /`.
      pattern: /\brm\s+(-[rRf]+\s+)*\/($|\s|\*)/,
      message: "Blocked: rm on root filesystem",
    },
    {
      pattern: /\brm\s+--(?:recursive|force)\b/,
      message: "Blocked: rm recursive/force with long flags",
    },
    { pattern: />\s*\/dev\/sd/, message: "Blocked: Writing to block device" },
    { pattern: /mkfs\./, message: "Blocked: Filesystem formatting" },
    { pattern: /dd\s+if=.*of=\/dev\/sd/, message: "Blocked: dd to disk" },
    { pattern: /:\(\)\{\s*:\|:&\s*\};:/, message: "Blocked: Fork bomb" },
    {
      // The function-name capture is BOUNDED (`\w{1,64}`, not `\w+`) to prevent
      // catastrophic backtracking: an unbounded `\w+` followed by a required
      // `()` grinds O(n²) on a long word-char run with no `()` (a `perl
      // -eeee…<path>` adversarial input ran ~7s → hook timeout). A real
      // fork-bomb function name is a short shell identifier; 64 chars is far
      // past any legitimate name. Surfaced by #1292 (the read-vs-write gate lets
      // a read-only interpreter body PASS the state guard, so an adversarial
      // interpreter flag-run now flows to this downstream pattern instead of
      // being short-circuited by the state-file block — unmasking this
      // pre-existing ReDoS; fixed here per zero-tolerance.md Rule 1c).
      pattern: /(\w{1,64})\(\)\s*\{\s*\1\s*\|\s*\1\s*&\s*\}\s*;\s*\1/,
      message: "Blocked: Fork bomb variant",
    },
    { pattern: /chmod\s+-R\s+777\s+\//, message: "Blocked: chmod 777 on root" },
    {
      pattern: /curl.*\|\s*(ba)?sh/,
      message: "WARNING: Piping curl to shell is dangerous",
    },
    {
      pattern: /wget.*\|\s*(ba)?sh/,
      message: "WARNING: Piping wget to shell is dangerous",
    },
  ];

  for (const { pattern, message } of dangerousPatterns) {
    if (pattern.test(command)) {
      // Log dangerous command observation
      try {
        logLearningObservation(cwd, "rule_violation", {
          rule: "security-dangerous-command",
          message: message.substring(0, 200),
          blocked: message.startsWith("Blocked"),
        });
      } catch {}

      if (message.startsWith("Blocked")) {
        return {
          severity: "block",
          what_happened: `Bash command matched dangerous pattern: ${command.slice(0, 120)}`,
          why: `validate-bash-command/${message}`,
          agent_must_report: [
            "Quote the exact command that was attempted",
            "State why the dangerous pattern matched (which clause)",
            "If the user truly intended this, ask them to confirm in plain language; do NOT retry without confirmation",
          ],
          agent_must_wait:
            "Do not retry the command. Wait for explicit user instruction.",
          user_summary: message,
        };
      }
      return { continue: true, exitCode: 0, message };
    }
  }

  // Split on shell-segment separators so dangerous patterns inside quoted
  // commit-message bodies (e.g. `git commit -m "...git reset --hard..."`) do NOT
  // false-positive. Each segment's LEADING token determines the actual command.
  //
  // loom#1549 HIGH-2 — this was a RAW `command.split(/(?:\|\||&&|;|\|(?!\|))/)`
  // with no `\n` in the class, so a Bash call carrying two LINES was ONE
  // segment: `git status\ngit reset --hard HEAD` parsed as `sub:"status"`,
  // every fence below dispatched on that, and the destructive verb was never
  // seen. A newline is a command separator in every shell; omitting it from a
  // splitter whose whole job is "which command is this segment" made the three
  // fences below unreachable by adding one keystroke.
  //
  // The fix already existed TWICE in this tree and had not reached these lanes:
  // `parseGitInvocations` passes `newlineSeparates: true`, and so does the
  // worktree lane below.
  //
  // Comments are stripped BEFORE splitting, matching what `parseGitInvocations`
  // does with `cleaned`. Without it the splitter still fractures on a `;` inside
  // a trailing COMMENT, so `git status # x; git reset --hard` fires on a segment
  // the shell would never execute. Measured both ways: with the newline fix but
  // WITHOUT this strip, that input still reached BLOCK — the newline-aware split
  // alone does not close it, and asserting otherwise would be a comment its own
  // code could not back.
  //
  // HEREDOC BODIES ARE NOT COMMANDS, and making the split newline-aware is
  // exactly what made that bite here. Before, a `cat > f <<'EOF' … EOF` body sat
  // inside ONE segment whose leading token was `cat`, so prose was shielded by
  // accident; splitting on newlines promotes every prose LINE to a segment, and
  // a line that merely QUOTES a destructive command then parses as a real
  // invocation. Caught by this guard firing on the commit message describing
  // this very fix — the same shape the worktree lane below already documents
  // ("including a `git commit -F- <<'EOF'` commit message for this PR"). That
  // lane solved it and the solution had not reached these three; this is the
  // third such gap in this file, which is the point of #1549.
  //
  // `.structural` is the command with every heredoc BODY and close line removed.
  // On the parser's work-budget overflow it is absent, so the walk gets an empty
  // string and finds nothing — failing OPEN on an unverifiable signal, which is
  // the disposition MUST-2 requires over guessing.
  const heredocSpans =
    command.indexOf("<<") === -1
      ? { structural: command }
      : parseHeredocSpans(command);
  const segments = splitShellSegments(
    stripShellComments(maskDocCarrierPayloads(heredocSpans.structural || "")),
    { newlineSeparates: true },
  );

  // UNKNOWN SUBCOMMAND — fail CLOSED (loom#1549 F3 lock 8). A git invocation
  // whose VERB is produced by a construct the hook must not evaluate
  // (`git $(echo reset) --hard`, or a `$(a && b)` the raw splitter above cut in
  // half) could be ANY verb, including the two fenced destructive ones. Every
  // fence below dispatches on a literal `g.sub`, so an unknown verb matches
  // none of them and the segment would fall through to a silent allow — the
  // precise shape this fix exists to close.
  //
  // Disposition is copied, not invented: it is the one gitWorkingTreeStatus
  // already takes for an unresolvable git binary ("Unresolvable git ranks
  // TIGHTEST here … `ok:false` already routes the caller to halt-and-report
  // rather than silent allow"). halt-and-report, not block, per
  // hook-output-discipline.md MUST-2 — there is no structural dirty-tree
  // measurement to justify `block` when the tree cannot even be identified.
  for (const seg of segments) {
    const g = parseGitInvocation(seg);
    if (!g || g.unresolvable !== "subcommand") continue;
    return {
      severity: "halt-and-report",
      what_happened: `Bash invoked git with a subcommand this hook cannot resolve: ${command.slice(0, 120)}`,
      why: "git.md MUST 'Destructive Working-Tree Ops' — the subcommand is produced by a shell construct (command substitution, parameter expansion) the hook MUST NOT evaluate (hook-output-discipline.md Rule 3 / security.md § no-eval). The verb is therefore UNKNOWN and may be `reset --hard` or `clean -f`, so the destructive-op fence cannot clear it. Unresolvable ranks TIGHTEST at a fail-closed fence.",
      agent_must_report: [
        "State the literal git subcommand this command resolves to at runtime",
        "Re-issue it with the subcommand written literally (`git reset …`, not `git $(…) …`) so the destructive-op fence can measure the target tree",
      ],
      agent_must_wait:
        "Do not retry with the subcommand still hidden behind a substitution. Write the verb literally.",
      user_summary:
        "git subcommand hidden behind a shell substitution — cannot be fence-checked; write it literally",
    };
  }

  // git reset --hard — STRUCTURAL severity (hook-output-discipline.md MUST-2:
  // `git status --porcelain` non-empty is the canonical structural signal that
  // justifies `block`). BLOCK only when the resolved working tree is DIRTY (a
  // dirty-tree --hard silently discards unstaged mods + untracked files with no
  // reflog); a clean-tree --hard is safe and is ALLOWED (removes the prior
  // lexical-block false-positive). Anchor tolerates `git -C <dir>`/sudo/env
  // (HIGH-1 — the cross-tree form the #401 incident used). git-unverifiable →
  // fail-open to halt-and-report (do not hard-block on an unconfirmable signal).
  for (const seg of segments) {
    const g = parseGitInvocation(seg);
    if (!g || g.sub !== "reset" || !/(^|\s)--hard\b/.test(g.args)) continue;
    // UNRESOLVABLE TARGET TREE — fail CLOSED (loom#1549 F3 lock 8). The verb is
    // known and destructive, but `-C`/`--work-tree` names a directory only the
    // shell can produce. The porcelain probe below would spawn against the
    // LITERAL `$(…)` bytes, which name no directory: `ok:false`, and the
    // fail-OPEN contract then degrades this branch to a bare advisory. Halting
    // here makes that outcome DELIBERATE rather than an artefact of a spawn
    // that happened to fail — and it holds even if such a path ever resolved.
    if (g.unresolvable === "dir") {
      return {
        severity: "halt-and-report",
        what_happened: `Bash invoked \`git reset --hard\` against a target directory this hook cannot resolve: ${command.slice(0, 120)}`,
        why: "git.md MUST 'Destructive Working-Tree Ops MUST Verify Clean Working Tree' — the `-C`/`--work-tree` value comes from a shell construct the hook MUST NOT evaluate (hook-output-discipline.md Rule 3 / security.md § no-eval), so the tree `--hard` would discard cannot be measured. An unverifiable target ranks TIGHTEST at a fail-closed destructive-op fence.",
        agent_must_report: [
          "Name the directory the substitution resolves to, and show `git status --porcelain` for THAT directory",
          "Re-issue with the path written literally so the fence can measure the tree, OR use `git reset --keep <ref>` (aborts on a dirty tree by itself)",
        ],
        agent_must_wait:
          "Do not retry --hard while the target tree is unidentifiable. Write the path literally, or use --keep.",
        user_summary:
          "git reset --hard at a substituted -C path — target tree unverifiable (write the path literally or use --keep)",
      };
    }
    const st = gitWorkingTreeStatus(g.dir, cwd);
    if (st.ok && st.dirty) {
      return {
        severity: "block",
        what_happened: `Bash invoked \`git reset --hard\` against a DIRTY working tree: ${command.slice(0, 120)}`,
        why: "git.md MUST 'Destructive Working-Tree Ops MUST Verify Clean Working Tree' — a dirty-tree --hard discards unstaged modifications AND untracked files with no reflog. Structural signal (`git status --porcelain` non-empty), per hook-output-discipline.md MUST-2.",
        agent_must_report: [
          "The working tree is DIRTY — `git reset --hard` would discard the listed changes unrecoverably",
          "Use `git reset --keep <ref>` (aborts on a dirty tree) OR commit/stash the changes first",
          "If the loss is genuinely intended, confirm the user authorized it IN THIS CONVERSATION",
        ],
        agent_must_wait:
          "Do not retry --hard while the tree is dirty. Use --keep, or stash/commit first.",
        user_summary:
          "git reset --hard blocked — DIRTY working tree (use --keep or stash first)",
      };
    }
    return {
      severity: "halt-and-report",
      what_happened: `Bash invoked \`git reset --hard\`: ${command.slice(0, 120)}`,
      why: "git.md MUST 'Destructive Working-Tree Ops' — prefer `git reset --keep` (aborts on a dirty tree). Tree appears clean or is unverifiable; surfacing per hook-output-discipline.md MUST-2 (no structural dirty-tree signal → not block).",
      agent_must_report: [
        "Confirm `git status --porcelain` is empty before --hard, OR use `git reset --keep <ref>`",
        "Explain why --hard was chosen over --keep",
      ],
      agent_must_wait:
        "Prefer --keep; proceed with --hard only after confirming the tree is clean.",
      user_summary: "git reset --hard — verify clean tree or use --keep",
    };
  }

  // git clean -f[d] — STRUCTURAL severity. `git clean -f` deletes UNTRACKED-not-
  // ignored files irreversibly (#401 data-loss class — no git object, no
  // reflog). BLOCK only when the resolved tree HAS untracked-not-ignored files
  // (porcelain `??`) that a force-clean would delete; clean-of-nothing →
  // halt-and-report (surface, allow). `-n`/`--dry-run` exempt. Anchor tolerates
  // `git -C <dir>`/sudo/env (HIGH-1). The sync-tier-aware pre-write snapshot
  // covers the tool's own fs purge; this is the cross-tool tripwire for an
  // OPERATOR-typed destructive clean.
  for (const seg of segments) {
    const g = parseGitInvocation(seg);
    if (!g || g.sub !== "clean") continue;
    const a = g.args;
    // -n / --dry-run overrides force in git and only previews — exempt.
    if (/(^|\s)-[a-zA-Z]*n[a-zA-Z]*\b/.test(a) || /(^|\s)--dry-run\b/.test(a)) {
      continue;
    }
    const force =
      /(^|\s)-[a-zA-Z]*f[a-zA-Z]*\b/.test(a) || /(^|\s)--force\b/.test(a);
    if (!force) continue; // `git clean` without -f is a no-op
    // UNRESOLVABLE TARGET TREE — fail CLOSED, same disposition as the
    // `reset --hard` fence above (loom#1549 F3 lock 8). Sibling surface, swept
    // in the SAME change per security.md § Enforcement-Surface Parity: fixing
    // only the reset lane would leave `git -C $(…) clean -fd` reaching no
    // guard, which is the identical measured bypass.
    if (g.unresolvable === "dir") {
      return {
        severity: "halt-and-report",
        what_happened: `Bash invoked \`git clean\` with force against a target directory this hook cannot resolve: ${command.slice(0, 120)}`,
        why: "git.md MUST 'Destructive Working-Tree Ops' — the `-C`/`--work-tree` value comes from a shell construct the hook MUST NOT evaluate (hook-output-discipline.md Rule 3 / security.md § no-eval), so the untracked files `clean -f` would delete cannot be enumerated. An unverifiable target ranks TIGHTEST at a fail-closed destructive-op fence.",
        agent_must_report: [
          "Name the directory the substitution resolves to, and show `git clean -n` (dry-run) for THAT directory",
          "Re-issue with the path written literally so the fence can enumerate what would be deleted",
        ],
        agent_must_wait:
          "Do not retry the force-clean while the target tree is unidentifiable. Dry-run against the literal path first.",
        user_summary:
          "git clean -f at a substituted -C path — target tree unverifiable (write the path literally and dry-run first)",
      };
    }
    const st = gitWorkingTreeStatus(g.dir, cwd);
    if (st.ok && st.untracked) {
      return {
        severity: "block",
        what_happened: `Bash invoked \`git clean\` with force against a tree that HAS untracked files: ${command.slice(0, 120)}`,
        why: "git.md MUST 'Destructive Working-Tree Ops' — `git clean -f[d]` deletes untracked-not-ignored files irreversibly (no git object, no reflog; the #401 data-loss class). Structural signal (`git status --porcelain` shows `??` entries), per hook-output-discipline.md MUST-2.",
        agent_must_report: [
          "Untracked-not-ignored files EXIST — `git clean -f` would delete them unrecoverably",
          "Run `git clean -n` (dry-run) to see exactly what would be deleted; use `git stash -u` to preserve it",
          "If the deletion is genuinely intended, confirm the user authorized it IN THIS CONVERSATION",
        ],
        agent_must_wait:
          "Do not retry the clean while untracked work exists. Dry-run + stash first.",
        user_summary:
          "git clean -f blocked — untracked files present, would be deleted irreversibly",
      };
    }
    return {
      severity: "halt-and-report",
      what_happened: `Bash invoked \`git clean\` with force: ${command.slice(0, 120)}`,
      why: "git.md MUST 'Destructive Working-Tree Ops' — `git clean -f[d]` deletes untracked-not-ignored files. No untracked-not-ignored files detected (or unverifiable); surfacing per hook-output-discipline.md MUST-2.",
      agent_must_report: [
        "Confirm via `git clean -n` (dry-run) that nothing of value would be deleted",
        "Prefer `git stash -u` over a destructive clean when in doubt",
      ],
      agent_must_wait:
        "Dry-run first if there is any chance of untracked work.",
      user_summary:
        "git clean -f — verify with dry-run (no untracked detected)",
    };
  }

  // force-push to main/master — HALT-AND-REPORT (hook-output-discipline.md
  // MUST-2: lexical command-string signal → not block). GitHub branch
  // protection REJECTS direct/force push to main server-side (git.md § Branch
  // Protection) — the remote rejection is the structural backstop; the hook
  // surfaces the intent. Anchor tolerates `git -C <dir>`/sudo/env (HIGH-1).
  for (const seg of segments) {
    const g = parseGitInvocation(seg);
    if (!g || g.sub !== "push") continue;
    const force = /(^|\s)--force(?:-with-lease)?\b/.test(g.args);
    const toMain = /(^|\s)(main|master)\b/.test(g.args);
    if (!force || !toMain) continue;
    return {
      severity: "halt-and-report",
      what_happened: `Bash attempted force-push to a protected branch: ${command.slice(0, 120)}`,
      why: "git.md branch protection — main/master direct/force push is rejected server-side by GitHub; force-push rewrites history. Lexical signal → halt-and-report per hook-output-discipline.md MUST-2 (the server-side rejection is the structural defense).",
      agent_must_report: [
        "State which branch was being force-pushed and why (history rewrite? recovery?)",
        "Confirm the user explicitly authorized force-push to main/master IN THIS CONVERSATION",
      ],
      agent_must_wait:
        "Do not retry. Force-push to main requires explicit per-action user authorization.",
      user_summary:
        "force-push to main/master — requires explicit authorization",
    };
  }

  // HALT-AND-REPORT: --no-verify (segment-anchored)
  if (segments.some((s) => /(?:^|\s)--no-verify\b/.test(s.trim()))) {
    return {
      severity: "halt-and-report",
      what_happened: `Bash command uses --no-verify: ${command.slice(0, 120)}`,
      why: "git.md — pre-commit hooks exist for a reason; --no-verify requires explicit user instruction",
      agent_must_report: [
        "State which hook is being bypassed and why",
        "Explain the underlying issue you would otherwise have to fix",
        "Confirm whether the user authorized --no-verify IN THIS CONVERSATION",
      ],
      agent_must_wait:
        "Do not retry without explicit user instruction. Investigate hook failure root cause first.",
      user_summary: "--no-verify usage requires user authorization",
    };
  }

  // Hot-path bounds for the stale-base-ref lane below. TWO limits, because either
  // one alone is insufficient:
  //
  //   MAX_REF_PROBES              caps how many `git worktree add`s in one command
  //                               get probed at all. Without it a chain of N adds
  //                               costs N spawns.
  //   REF_PROBE_TOTAL_BUDGET_MS   caps the CUMULATIVE wall time. A count cap alone
  //                               bounds nothing real: 4 spawns × the 2500ms
  //                               per-spawn timeout is 10 SECONDS, on a path whose
  //                               own 5s watchdog is cleared before detection runs
  //                               (see the `clearTimeout` at the stdin handler).
  //                               So each spawn is given the REMAINING budget as
  //                               its timeout, not the full default.
  //
  // ~10.8ms measured per spawn on a warm local repo, so the typical chain costs
  // tens of ms and the budget is never approached; it exists for the pathological
  // case (a huge ref graph, a hung network mount), which the measured figure says
  // nothing about.
  const MAX_REF_PROBES = 4;
  const REF_PROBE_TOTAL_BUDGET_MS = 3000;

  // HALT-AND-REPORT: `git worktree add` from a STALE LOCAL base ref (loom#1501,
  // L4 of the enforcement-registration wave).
  //
  // Fast surface-presence guard FIRST. This hook runs on EVERY Bash call, and
  // the client-fork audit names that startup cost explicitly, so the whole
  // branch is behind one `indexOf` on a literal that is absent from essentially
  // every command. Only a command that actually mentions `worktree` pays the
  // segment walk, and only a real `git worktree add <path> <ref>` pays the
  // single git spawn — at most ONE per invocation (see the break below).
  //
  // Placed AFTER --no-verify and the destructive-op fences: this is the
  // lowest-severity branch in the file, so it must not pre-empt any of them.
  // `git commit --no-verify && git worktree add …` previously returned HERE and
  // the --no-verify halt never fired.
  //
  // SEGMENTATION IS QUOTE-AWARE, AND THAT IS LOAD-BEARING — NOT the shared
  // `segments` above. An earlier version of this block reused `segments` and
  // carried a comment claiming parseGitInvocation made it FP-resistant to prose.
  // That claim was FALSE and the code did not have the property: the split at
  // the top of this function is quote-UNAWARE, so a separator INSIDE a quoted
  // body fractures it and hands this branch a fragment whose leading token is
  // `git`. All three of these falsely fired, reproduced against a real repo:
  //
  //   gh issue create --body "step 1 && git worktree add ../wt wave/foo …"
  //   git commit -m     "fix: step && git worktree add ../wt wave/foo …"
  //   echo              "docs && git worktree add ../wt wave/foo …"
  //
  // i.e. exactly the commands this PR's own body and journal entries contain —
  // the loom#1363 prose-carrier class, re-opened in the file that closed it.
  // The repo already ships the primitives that fix it, and the state-path lane
  // already uses them: maskDocCarrierPayloads neutralises a doc-carrier's
  // argument payload, and splitShellSegments does not split inside quotes.
  //
  // The verdict is STRUCTURAL (a git rev-list count off the operator's own ref
  // database), which makes it block-eligible under hook-output-discipline.md
  // MUST-2 — and it is nonetheless capped at halt-and-report on PROPORTIONALITY
  // (the harm is recoverable; loom#1323 precedent). The full argument lives at
  // the detector in lib/violation-patterns.js; do not re-derive it here.
  if (command.indexOf("worktree") !== -1) {
    // WHICH REPOSITORY THE PROBE READS IS PART OF THE VERDICT, and reading the
    // SESSION cwd when the command targets another repo is wrong in BOTH
    // directions. `git -C <dir>` was already honoured; a `cd <dir> &&` prefix was
    // not, because splitShellSegments puts the git call in its OWN segment with
    // no `-C` to carry the directory. Reproduced against two scratch repos that
    // share a branch name, one 1-behind and one 0-behind:
    //
    //   cwd=<stale>  `cd <clean> && git worktree add ../wt wave/x`  → FIRED   ✗
    //   cwd=<clean>  `cd <stale> && git worktree add ../wt wave/x`  → silent  ✗
    //
    // The first is the worse half: a halt naming a repository the command never
    // touches is precisely the false positive hook-output-discipline.md MUST-2
    // forbids. So the walk tracks `cd`/`pushd` — and where it CANNOT track them
    // it declines to probe rather than guessing, because falling back to the
    // session cwd after an unresolved `cd` IS the false positive.
    let segDir = cwd;
    let dirKnown = true;
    let probesSpent = 0;
    let refProbeBudgetMs = REF_PROBE_TOTAL_BUDGET_MS;
    // A `cd` the shell might SKIP must not be applied. `A || cd <x>` runs the cd
    // only if A failed; `false && cd <x>` never runs it at all. Applying it
    // regardless produced a halt naming a repository the command never enters —
    // reproduced as `cd <clean> || cd <stale> ; git worktree add …` flagging from
    // a cwd where the ref is current. Deciding which side of a `||` executes
    // needs the exit status of a command that has not run, so the honest answer
    // is that the trail is unknowable: the whole walk declines rather than
    // guessing. `&&`-only chains are safe by construction — if an earlier link
    // fails the git call does not run either — but this hook cannot see WHICH
    // separator joined two segments, so the presence of `||` anywhere is the
    // conservative trigger.
    // HEREDOC BODIES ARE NOT COMMANDS. `maskDocCarrierPayloads` neutralises a
    // doc-carrier's quoted ARGUMENT and a `$(cat <<X)` substitution, but a plain
    // `cat > notes.md <<'EOF' … EOF` writes a FILE, so its body was never masked
    // and the `;`/`&&` inside the prose fractured it into a segment whose leading
    // token is `git`. Reproduced against the real repo: authoring a journal note
    // that MENTIONS `git worktree add … <ref>` produced a verdict byte-identical
    // to running it. That shape is this repo's own documented authoring pattern,
    // so the guard would have fired on the very notes describing it — including
    // a `git commit -F- <<'EOF'` commit message for this PR.
    //
    // `.structural` is the command with every heredoc BODY and close line
    // removed; opener lines survive, and an opener is only committed when its
    // close actually exists downstream, so a decoy `<<WORD` cannot swallow a real
    // command. On the parser's work-budget `overflow` `structural` is absent, so
    // the walk gets an EMPTY string and simply finds nothing — this whole
    // detector fails open on an unverifiable signal, and a pathological command
    // missing a stale-base warning is a miss, whereas guessing is the false
    // positive MUST-2 forbids. NOT `return null`: checks follow this block (the
    // pytest/.env enforcement below among them) and must not be disabled.
    //
    // GATED ON THE `<<` SUBSTRING. Every other caller of parseHeredocSpans
    // early-exits unless a PROTECTED PATH appears; this lane's gate is the far
    // more common `worktree`, so calling the parser unconditionally would expose
    // its O(unclosed-openers × downstream-lines) work budget to any command
    // containing that word. A command with no `<<` cannot contain a heredoc, so
    // skipping the parse is exact, not approximate.
    const spans =
      command.indexOf("<<") === -1
        ? { structural: command }
        : parseHeredocSpans(command);
    const masked = maskDocCarrierPayloads(spans.structural || "");
    // SEPARATOR HYGIENE — whether a `cd` actually took effect in the shell that
    // runs the git call depends on how the segments are JOINED, and three shapes
    // defeat a naive walk:
    //
    //   cd <B> | cat ; git worktree add …   the cd runs in a SUBSHELL; the git
    //                                       call runs in the ORIGINAL directory
    //   cd <A> || cd <B> ; git …            `||` short-circuits; only one ran
    //   git fetch && cd <B>                 MIXED: if fetch fails the cd does
    //   git worktree add …                  not run, but the git call still does
    //
    // All three were reproduced flagging a repository the command never enters —
    // the false positive hook-output-discipline.md MUST-2 forbids outright.
    //
    // A pure `&&` chain is sound (a failed link stops the git call too) and so is
    // a pure `;`/newline chain (every segment runs, and the statSync below catches
    // a `cd` that fails). MIXING them is not, and neither is any pipeline,
    // background, or subshell. Rather than reconstruct the shell's control flow,
    // the trail is trusted only for those two homogeneous shapes.
    //
    // Computed on the MASKED, heredoc-stripped surface so a separator inside
    // prose cannot silently disable the walk.
    const hasPipe = /\|/.test(masked); // covers `|` AND `||`
    const hasAmp = /&/.test(masked); // covers `&` AND `&&`
    const hasSeq = /[;\n]/.test(masked);
    const cdTrailTrustworthy =
      !hasPipe && !/[()]/.test(masked) && !(hasAmp && hasSeq);
    for (const seg of splitShellSegments(masked, {
      // A newline separates commands exactly as `;` does. Without this a
      // multi-line block collapsed into one segment whose leading token is the
      // FIRST command, so the canonical `git fetch origin <ref>` + newline +
      // `git worktree add … <ref>` shape — the very sequence Rule 7 prescribes —
      // was invisible to this guard. The sibling state-path lane already passes
      // this flag; omitting it here was an oversight, not a scoping decision.
      newlineSeparates: true,
    })) {
      const t = seg.trim();
      // A directory-changing segment we can resolve exactly: one literal operand,
      // no shell expansion. Anything else (bare `cd` → $HOME, `cd -` → OLDPWD,
      // `cd --` → $HOME, a `$VAR`/glob/`~` operand, an option form like `cd -P x`,
      // a `cd` nested in a subshell or wrapped so this pattern misses it) marks
      // the directory UNKNOWN and is never guessed at.
      if (/(?:^|[^\w./-])(?:cd|pushd|popd)(?=\s|$)/.test(t)) {
        const m = /^(?:cd|pushd)\s+(\S+)$/.exec(t);
        const arg = m ? m[1].replace(/^(['"])(.*)\1$/, "$2") : null;
        if (
          !arg ||
          !dirKnown ||
          !cdTrailTrustworthy ||
          /[$`*?~]/.test(arg) ||
          arg.startsWith("-")
        ) {
          dirKnown = false;
        } else {
          const next = path.resolve(segDir, arg);
          // A `cd` to a path that is not a directory FAILS, leaving the shell
          // where it was. Applying it anyway walked the probe to a nonexistent
          // directory and reported "clean" for a command that really did run in
          // the stale repo. Checked, not assumed — and an unreadable path is
          // UNKNOWN rather than either branch.
          let st = null;
          try {
            st = fs.statSync(next);
          } catch {
            st = null;
          }
          if (!st) dirKnown = false;
          else if (st.isDirectory()) segDir = next;
          // else: `cd <file>` fails; the shell stays put, so segDir is unchanged.
        }
        continue;
      }
      const g = parseGitInvocation(seg);
      if (!g || g.sub !== "worktree") continue;
      // An unresolvable `-C` is an UNKNOWN directory, so this lane takes the
      // disposition it already takes for one: do not probe (loom#1549 F3 lock
      // 8). Probing the literal `$(…)` bytes would resolve some other path and
      // report a CLEAN base ref for a tree never inspected — a false negative
      // worse than no signal. `continue`, not `break`: only THIS segment's
      // target is unknown, and the cd trail is still valid for later segments.
      if (g.unresolvable === "dir") continue;
      // `-C` is absolute → it alone pins the repo, whatever the cd trail did.
      // Otherwise the resolved cd trail must be trustworthy, or we do not probe.
      const cAbs = g.dir && path.isAbsolute(g.dir);
      if (!dirKnown && !cAbs) break;
      const probeDir = g.dir ? path.resolve(segDir, g.dir) : segDir;
      if (probesSpent >= MAX_REF_PROBES || refProbeBudgetMs <= 0) break;
      const stats = {};
      const t0 = Date.now();
      // The per-spawn timeout is the REMAINING budget, never the full default —
      // so N spawns cost at most REF_PROBE_TOTAL_BUDGET_MS in total, not N × the
      // per-spawn timeout. A count-only cap bounds nothing: 4 spawns × a 2500ms
      // timeout is 10s on a path whose own watchdog was already cleared.
      const stale = detectWorktreeStaleBaseRef(g.args, probeDir, {
        stats,
        timeoutMs: refProbeBudgetMs,
      });
      if (stats.probed) {
        probesSpent++;
        refProbeBudgetMs -= Date.now() - t0;
      }
      // A BOUNDED number of spawns per invocation, spent only when a spawn
      // actually happened. Two separate defects lived in the old `if (!stale)
      // break`:
      //
      //   1. The detector returns null both when it probed and found nothing AND
      //      when it never probed at all (`worktree list`/`remove`/`prune`, an
      //      `add` with no explicit base, a `$VAR` ref, an already-correct
      //      `origin/` ref). Breaking on the latter stopped the walk at the first
      //      harmless subcommand, so the documented `git worktree prune && git
      //      worktree add … <stale>` cleanup shape was never probed at all.
      //      `stats.probed` distinguishes them; a segment that cost nothing
      //      costs nothing.
      //   2. Even a REAL probe returning clean ended the walk, so
      //      `add ../a <current> && add ../b <stale>` missed the stale one. A
      //      hard cap bounds the hot path without that miss: MAX_REF_PROBES × the
      //      measured ~10.8ms spawn stays an order of magnitude inside the hook's
      //      own budget, and a chain longer than this is not a shape worth paying
      //      unbounded latency for.
      if (!stale) continue;
      try {
        logLearningObservation(cwd, "rule_violation", {
          rule: stale.rule_id, // worktree-orchestration/Rule-7
          behind: stale.behind,
          ahead: stale.ahead,
        });
      } catch {}
      return {
        severity: "halt-and-report",
        what_happened: `Bash invoked \`git worktree add\` from a STALE local base ref: ${stale.evidence}`,
        why:
          "worktree-orchestration Rule 7 (Pre-Flight Merge-Base Check Before Launch) — a lane worktree created from a local branch ref " +
          "that its origin/ counterpart has moved ahead of does good work on a base that can never " +
          "be pushed. Structural signal (`git rev-list --left-right --count refs/heads/<ref>..." +
          "refs/remotes/origin/<ref>` reports a non-zero behind-count), surfaced rather than blocked " +
          "per the proportionality cap recorded at the detector (the harm is recoverable; " +
          "hook-output-discipline.md MUST-2 permits block only where the verdict is structural AND " +
          "the harm warrants it).",
        agent_must_report: [
          `The local ref \`${stale.ref}\` is ${stale.behind} commit(s) behind \`origin/${stale.ref}\`${stale.diverged ? ` and ${stale.ahead} ahead (diverged)` : ""}`,
          `Re-issue as \`git worktree add … origin/${stale.ref}\` (fetch first: \`git fetch origin ${stale.ref}\`) unless you specifically need the stale base`,
          stale.diverged
            ? "The branch has DIVERGED — if the local-only commits are the point, say so explicitly; otherwise the remote tip is the base you want"
            : "The local ref carries NO commits the remote lacks, so branching from it gains nothing and loses the remote's commits",
        ],
        agent_must_wait:
          "Do not create the worktree from the stale local ref. Re-issue against origin/<ref>, or state explicitly why the stale base is intended.",
        user_summary: `git worktree add from stale local ref \`${stale.ref}\` (${stale.behind} behind origin) — use origin/${stale.ref}`,
      };
    }
  }

  // ====================================================================
  // ENFORCE: .env loading for pytest/python commands
  // ====================================================================
  const isPytest = /\bpytest\b/.test(command);
  const isPython = /\bpython\b/.test(command) || /\bpython3\b/.test(command);

  if (isPytest || isPython) {
    // Log enriched test pattern observation
    try {
      const testPathMatch = command.match(
        /(?:pytest|python3?\s+-m\s+pytest)\s+([^\s;|&]+)/,
      );
      const testPath = testPathMatch ? testPathMatch[1] : null;

      // Determine test tier from path
      let testTier = "unit";
      if (testPath) {
        if (/e2e|playwright|end.to.end/i.test(testPath)) testTier = "e2e";
        else if (/integrat/i.test(testPath)) testTier = "integration";
      }

      logLearningObservation(cwd, "test_pattern", {
        test_tier: testTier,
        test_path: testPath,
        is_pytest: isPytest,
        command_flags: extractTestFlags(command),
      });
    } catch {}

    // Check if .env exists
    let envExists = false;
    try {
      envExists = fs.existsSync(path.join(cwd, ".env"));
    } catch {}

    if (envExists) {
      // Check if command already loads .env (various patterns)
      const loadsEnv =
        /dotenv/.test(command) || // pytest-dotenv or dotenv CLI
        /\.env/.test(command) || // References .env explicitly
        /OPENAI_API_KEY=/.test(command) || // Explicit env var
        /--env-file/.test(command) || // Docker-style env file
        /source\s+\.env/.test(command) || // Shell sourcing
        /export\s+/.test(command) || // Export pattern
        /env\s+/.test(command); // env prefix

      if (!loadsEnv && isPytest) {
        return {
          continue: true,
          exitCode: 0,
          message:
            "REMINDER: .env exists but pytest may not load it. Consider: pytest-dotenv plugin OR prefix with env vars from .env. OPENAI_API_KEY and model settings are in .env!",
        };
      }
    }
  }

  // WARN: Long-running commands outside tmux/background
  const longRunningPatterns = [
    /npm\s+run\s+(dev|start|serve)/,
    /yarn\s+(dev|start|serve)/,
    /python\s+-m\s+http\.server/,
    /uvicorn/,
    /flask\s+run/,
    /node\s+.*server/,
    /docker\s+compose\s+up(?!\s+-d)/,
  ];

  const inTmux = process.env.TMUX || process.env.TERM_PROGRAM === "tmux";
  const isBackground =
    /&\s*$/.test(command) ||
    /--background/.test(command) ||
    /-d\s/.test(command);

  for (const pattern of longRunningPatterns) {
    if (pattern.test(command) && !inTmux && !isBackground) {
      return {
        continue: true,
        exitCode: 0,
        message:
          "WARNING: Long-running command. Consider using run_in_background or tmux.",
      };
    }
  }

  // WARN: Git push - reminder for security review
  if (/git\s+push/.test(command)) {
    return {
      continue: true,
      exitCode: 0,
      message: "REMINDER: Did you run security-reviewer before pushing?",
    };
  }

  // WARN: Git commit - reminder for review.
  // loom#1368: this site carried NO boundary at all, so it matched every
  // `git commit-*` sub-command (and `git commitfoo`). Anchored with the same
  // `(?![\w-])` negative lookahead as the two delegation sites above.
  // loom#1549 HIGH-3 — `\b`-anchored rather than `^`, so this one was not blind
  // to wrapped/retargeted commits, but it was still substring matching: it fires
  // on `git log --grep=commit` and on a `commit` inside a trailing shell comment.
  // The shared parser dispatches on the SUBCOMMAND POSITION, which is the only
  // thing that distinguishes those structurally.
  if (findCommitInvocation(command)) {
    return {
      continue: true,
      exitCode: 0,
      message:
        "REMINDER: Code review completed? Consider delegating to reviewer.",
    };
  }

  // Log cargo test / cargo clippy observations for Rust repos
  const isCargoTest = /\bcargo\s+test\b/.test(command);
  const isCargoClippy = /\bcargo\s+clippy\b/.test(command);
  const isCargoBuil = /\bcargo\s+build\b/.test(command);

  if (isCargoTest || isCargoClippy || isCargoBuil) {
    try {
      const crateMatch = command.match(/-p\s+(\S+)/);
      logLearningObservation(cwd, "test_pattern", {
        test_tier: isCargoTest
          ? "cargo_test"
          : isCargoClippy
            ? "clippy"
            : "cargo_build",
        test_path: crateMatch ? crateMatch[1] : "workspace",
        is_rust: true,
        command_flags: extractTestFlags(command),
      });
    } catch {}
  }

  return { continue: true, exitCode: 0, message: "Validated" };
}

/**
 * Extract test-relevant flags from command for learning.
 */
/**
 * Three-layer mutation detection for trust-posture state files.
 *
 * Per issue #25 — adopted from a downstream consumer's
 * state-file-write-guard (commit c0aeff73). Closes the bypass gap where
 * settings.json `permissions.deny` on Edit/Write does NOT cover bash-mediated
 * mutations (redirects, file utilities, interpreter -c/-e/-m bodies).
 *
 * Returns { layer, kind } if a mutation is detected against any path matching
 * `pathRx`, else null.
 *
 * Per-line scanning: matchers operate on `[^|\\n]*` so multi-line commands
 * cannot cross-match a verb on one line with a protected path on a later line.
 */
function extractTestFlags(command) {
  const flags = [];
  if (/-x\b/.test(command)) flags.push("fail-fast");
  if (/--tb=/.test(command)) flags.push("traceback");
  if (/-v\b|--verbose\b/.test(command)) flags.push("verbose");
  if (/--cov\b/.test(command)) flags.push("coverage");
  if (/-k\s/.test(command)) flags.push("keyword-filter");
  if (/--workspace\b/.test(command)) flags.push("workspace");
  if (/--release\b/.test(command)) flags.push("release");
  return flags;
}
