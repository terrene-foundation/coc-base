#!/usr/bin/env node
/**
 * Hook: validate-prod-deploy
 * Event: PreToolUse
 * Matcher: Bash
 * @settings-registration: optional-consumer — a prod-deploy gate a CONSUMER
 *   registers in its OWN .claude/settings.json under PreToolUse:Bash when it
 *   wants staging-before-prod gating (see Usage below). Not registered in
 *   loom's settings.json (loom is not a deploy target); the validate-emit
 *   `settings-hook-registration` check reads this marker (#771).
 * Purpose: Block direct production deployment commands unless staging has passed.
 *
 * Intercepts Bash commands that touch production Docker containers and
 * requires .staging-passed to exist with the current git HEAD commit.
 *
 * To use this hook, register it in .claude/settings.json under PreToolUse:Bash.
 * See deploy/scripts/ for the stage.sh and deploy.sh that write/read the marker.
 *
 * Exit Codes:
 *   0 = allow (command is safe, staging verified, or --skip-staging passed)
 *   2 = block (direct production deploy without staging, stale staging marker,
 *       OR the staging gate could not run at all — see the fail-open note below)
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { instructAndWait } = require("./lib/instruct-and-wait");
const { readStdinBounded } = require("./lib/read-stdin-bounded.js");
const { resolveGitBinary, gitEnv } = require("./lib/git-subprocess-env.js");

const TIMEOUT_MS = 5000;
const timeout = setTimeout(() => {
  // Timeout = allow (fail-open to avoid blocking all Bash commands)
  process.exit(0);
}, TIMEOUT_MS);

/*
 * loom#1471 shard 7 — AN UNANSWERABLE GATE REFUSES; IT DOES NOT WAVE THROUGH.
 *
 * Both git calls below used to `process.exit(0)` on failure, commented
 * "fail open". They resolve BOTH halves of the staging gate — the root the
 * `.staging-passed` marker is read from, and the HEAD it is compared against —
 * so a failure there does not mean "probably fine", it means the gate did not
 * run. The command then reached production with NO staging verification at all,
 * and nothing in the transcript said so.
 *
 * This sweep made that MORE reachable, not less. Those calls now carry
 * `env: gitEnv()`, which sets `GIT_CONFIG_NOSYSTEM=1` and
 * `GIT_CONFIG_GLOBAL=/dev/null` and therefore DISCARDS `safe.directory` —
 * so `rev-parse` is fatal on a differently-owned checkout: container
 * bind-mounts, CI runners, shared clones. Ordinary infrastructure, no attacker
 * required, and the failure was silent in the deploy direction.
 *
 * WHY `block` HERE AND `halt-and-report` IN integrity-guard, which faced the
 * same choice. `hook-output-discipline.md` MUST-2 permits either: the signal is
 * process state (a non-zero git exit), not a lexical match. The deciding
 * difference is the RECOVERY PATH. integrity-guard reasoned that a hard block on
 * an unresolvable-git host leaves the operator no way forward. This hook already
 * ships one, and it is checked ABOVE the git calls: `--skip-staging`, which
 * allows the deploy with a loud warning and a documentation requirement. So
 * blocking costs the operator one explicit, auditable flag rather than their
 * recovery path — and the alternative is a silent production deploy.
 */

/**
 * Emit a halting block via instructAndWait per hook-output-discipline.md MUST-1.
 * Structural evidence (file existence / git rev / non-zero exit) is the basis
 * for block severity per MUST-2 — never lexical regex alone.
 */
/**
 * A short, single-line rendering of a subprocess failure. git's own stderr is
 * preferred over the Error message because it names the actual cause
 * ("detected dubious ownership", "not a git repository", "ambiguous argument
 * 'HEAD'"), which is what the operator has to act on.
 */
function _reason(err) {
  const stderr = err && err.stderr ? String(err.stderr) : "";
  const text = stderr.trim() || (err && err.message ? String(err.message) : "unknown error");
  return text.replace(/\s+/g, " ").slice(0, 300);
}

/**
 * Split a shell command into the individual commands it runs, on `&&`, `||`,
 * `;`, `|` and newline — but ONLY where those appear OUTSIDE quotes.
 *
 * QUOTE-AWARENESS IS LOAD-BEARING, NOT TIDINESS (loom#1471 round-4).
 *
 * The first version of this function split on the bare separators and argued
 * that was fail-closed, because an extra split can only produce more segments
 * and therefore more gating. That argument was WRONG, and the counter-example
 * is the canonical remote deploy:
 *
 *     ssh prod "cd /srv && docker compose up -d"
 *
 * `/ssh\s+.*docker\s+(compose|stack)/i` matches that WHOLE string. Split on the
 * quoted `&&` it becomes `ssh prod "cd /srv` and `docker compose up -d"`, and
 * NEITHER half matches any prod pattern — the first has no docker, the second
 * has no ssh and no `prod`. Measured, pre-fix vs post-fix classification:
 *
 *     ssh prod "cd /srv && docker compose up -d"     true -> FALSE
 *     ssh prod "cd /srv; docker compose up -d"       true -> FALSE
 *     ssh -t host "cd /a && docker compose up"       true -> FALSE
 *     ssh prod 'cd /srv && docker compose up -d'     true -> FALSE
 *
 * So a separator can SEVER a pattern whose match spans invocations, and the
 * exposure is specific: only the unbounded `.*` patterns are severable, and of
 * those only the `ssh` one describes a single logical command that legitimately
 * contains a separator. The ssh pattern is also the only prod pattern covering
 * remote deploys at all, which is where a separator ALWAYS appears.
 *
 * Splitting only outside quotes is not a patch for that case — it is what the
 * shell itself does. A separator inside quotes is part of the remote command
 * (one invocation, gate it); a separator outside is a real command boundary
 * (two invocations, judge them apart). Both round-3 and round-4 shapes fall out
 * of that one rule.
 *
 * WHY NOT "re-test the whole command against the ssh pattern, OR'd with the
 * per-segment verdict" — the narrower fix, and it costs a false positive.
 * Measured on the same corpus:
 *
 *     grep ssh /etc/ssh/config && docker compose -f docker-compose.dev.yml up
 *       quote-aware      -> not a deploy   (correct: a read, then a DEV compose)
 *       ssh-whole-OR     -> GATED          (the bare `ssh ` from an argument
 *                                           vouches for an unrelated segment)
 *
 * That re-introduces, on the ssh axis, the same whole-command bleed round-3
 * removed on the SAFE axis.
 *
 * TWO SCOPES, NAMED — because one word doing two jobs is what went wrong.
 *
 * Rounds 3, 4 and 5 each changed what "segment" MEANT and did not re-derive the
 * pattern anchoring against the new meaning. Segment semantics and pattern
 * scope are ONE invariant, and it was edited as two. So the two scopes now have
 * two names, and § PATTERN SCOPE below states which scope every pattern is
 * adjudicated over:
 *
 *   INVOCATION      — `_splitInvocations`, split at UNQUOTED separators. One
 *                     top-level command, INCLUDING any quoted payload it
 *                     carries. This is the scope the `ssh` PROD pattern needs,
 *                     because the payload is where the remote deploy lives.
 *   SUB-INVOCATION  — `_splitSubInvocations`, split at separators REGARDLESS of
 *                     quoting. One command inside that payload. This is the
 *                     scope SAFE must be adjudicated over, because a read
 *                     inside a payload must not vouch for a deploy beside it.
 *
 * DIRECTION OF ERROR, and THE AXIS IT DOES NOT COVER (stated because three of
 * the previous four claims here were false at exactly the unnamed axis).
 *
 * Covered: merging can no longer widen SAFE's reach, because an invocation is
 * vouched only when EVERY one of its sub-invocations is read-only. Splitting can
 * no longer sever a spanning PROD pattern, because PROD is tested at INVOCATION
 * scope, and sub-invocation text is a substring of it (the sub-splitter splits
 * and never strips), so an invocation-scope test subsumes a per-sub one.
 *
 * NOT covered, three named axes:
 *   1. Separators not enumerated here — `$(…)`, backticks, `;;`, process
 *      substitution. A payload joined by one of those stays a SINGLE
 *      sub-invocation, so an unanchored SAFE span can vouch for it.
 *   2. The five `docker.*` SAFE patterns still match a SPAN, not a command
 *      position. Unanimity bounds their reach to one sub-invocation; it does
 *      not make them command-anchored.
 *   3. SAFE patterns are matched, not parsed, so one could fire from an
 *      ARGUMENT (`--label docker.logs=1`). Anchoring them was measured and
 *      rejected: it breaks `ssh prod "docker compose logs -f api"`, a legitimate
 *      remote read, which then gates on the ssh PROD pattern.
 */
function _splitInvocations(command) {
  const s = String(command);
  const out = [];
  let cur = "";
  let quote = null; // "'" or '"' when inside a quoted span
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote === null) {
      // Outside quotes: a backslash escapes the next character, so an escaped
      // separator is NOT a command boundary.
      if (ch === "\\") {
        cur += ch + (s[i + 1] === undefined ? "" : s[i + 1]);
        i += 1;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        cur += ch;
        continue;
      }
      if (ch === "\n" || ch === ";") {
        out.push(cur);
        cur = "";
        continue;
      }
      if ((ch === "&" && s[i + 1] === "&") || (ch === "|" && s[i + 1] === "|")) {
        out.push(cur);
        cur = "";
        i += 1;
        continue;
      }
      // A lone `|` (pipe) or `&` (background) is also a command boundary. `&`
      // was missing until round 5: `docker ps & docker compose … prod … up -d`
      // stayed one invocation, and `/docker.*ps/i` vouched for the deploy.
      if (ch === "|" || ch === "&") {
        out.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
      continue;
    }
    // Inside quotes. Backslash escapes only within DOUBLE quotes; inside single
    // quotes POSIX treats it literally, so a `\'` does not continue the span.
    if (quote === '"' && ch === "\\") {
      cur += ch + (s[i + 1] === undefined ? "" : s[i + 1]);
      i += 1;
      continue;
    }
    if (ch === quote) quote = null;
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x.length > 0);
}

/**
 * The commands INSIDE one invocation — split at separators regardless of
 * quoting, which is the complement of `_splitInvocations`.
 *
 * SPLITS ONLY, NEVER STRIPS, and that is load-bearing: every sub-invocation is
 * therefore a SUBSTRING of its invocation, which is what makes the PROD test at
 * invocation scope subsume a per-sub-invocation one (all six PROD patterns are
 * unanchored spans). Stripping the quote characters would break that argument
 * and require a second PROD pass.
 *
 * An unterminated quote is handled by construction rather than by a special
 * case: `_splitInvocations` merges everything after it into one invocation, and
 * this function then splits that merged text on the very separators the open
 * quote hid. Round 5's `docker ps " && docker compose … prod … up -d` is that
 * shape — the merge is what made `/docker.*ps/i` reach the deploy, and
 * re-splitting here is what takes it back.
 */
function _splitSubInvocations(invocation) {
  return String(invocation)
    .split(/\|\||&&|;|\||\n|&/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function emitBlock({
  what_happened,
  why,
  agent_must_report,
  agent_must_wait,
  user_summary,
}) {
  const out = instructAndWait({
    hookEvent: "PreToolUse",
    severity: "block",
    what_happened,
    why,
    agent_must_report,
    agent_must_wait,
    user_summary,
  });
  clearTimeout(timeout);
  console.log(JSON.stringify(out.json));
  process.exit(out.exitCode);
}

// Set once the command is KNOWN to be a production deploy with no
// `--skip-staging`. It gates the outer catch below: an unexpected failure while
// gating a prod deploy must refuse, but an unexpected failure BEFORE we can even
// tell what the command is must not block every Bash call in the session.
let gatingProdDeploy = false;

async function main() {
  try {
    const input = await readStdinBounded();
    const toolName = input.tool_name;
    const toolInput = input.tool_input || {};
    const command = toolInput.command || "";

    // Only check Bash commands
    if (toolName !== "Bash") {
      clearTimeout(timeout);
      process.exit(0);
      return;
    }

    // Patterns that indicate production deployment
    // Projects should add their own container name patterns below.
    const PROD_PATTERNS = [
      // Generic docker compose prod file patterns
      /docker.*compose.*prod.*up/i,
      /docker.*compose.*prod.*build/i,
      /docker.*compose.*prod.*restart/i,
      /docker.*compose.*-f.*docker-compose\.prod/i,
      // bare docker restart (single container restarts bypass compose)
      /docker\s+restart\s+\S+/,
      // SSH to production server running docker compose
      /ssh\s+.*docker\s+(compose|stack)/i,
    ];

    /*
     * Patterns that are always allowed (read-only, logs, status, dev scripts).
     *
     * loom#1471 round-3 F-2. Two of these were UNANCHORED substring matches, and
     * SAFE was adjudicated against the WHOLE command BEFORE prod classification,
     * so either one short-circuited the gate. Measured against the live arrays:
     *
     *   SAFE-EXIT(/cat|grep|head|tail|ls/) prod=true :: docker restart tools-api
     *   SAFE-EXIT(/cat|grep|head|tail|ls/) prod=true :: docker restart catalog-svc
     *   SAFE-EXIT(/git\s+(pull|…)/i)       prod=true :: git pull && docker compose -f docker-compose.prod.yml up -d
     *   SAFE-EXIT(/curl/i)                 prod=true :: docker compose … up -d && curl -sf localhost:8080/health
     *
     * Any service or container whose NAME contains ls / cat / head / tail / grep
     * — tools, controls, catalog, analytics, headless — took that exit. So did
     * every compound deploy, which is how deploys are actually written.
     *
     * TWO CHANGES, AND BOTH ARE NEEDED.
     *
     * 1. The bare-utility patterns are anchored to COMMAND POSITION. `cat`,
     *    `grep`, `head`, `tail`, `ls`, `curl` and `git pull` are safe when they
     *    are the thing being RUN, not when they appear inside an argument.
     * 2. Adjudication is decomposed rather than whole-command
     *    (§ _splitInvocations / _splitSubInvocations, and § PATTERN SCOPE
     *    below), so a read can no longer vouch for a deploy beside it.
     *
     * WHY NOT SIMPLY CHECK PROD FIRST — the obvious fix, and it is wrong. SAFE
     * genuinely must be able to override PROD within one command: measured,
     * `docker compose -f docker-compose.prod.yml logs` matches the PROD pattern
     * `/docker.*compose.*-f.*docker-compose\.prod/i`, and reading logs is not a
     * deploy. Reordering would start blocking it. The defect was never the
     * precedence; it was the SCOPE the precedence was applied over.
     */
    const SAFE_PATTERNS = [
      /docker.*logs/i,
      /docker.*ps/i,
      /docker.*inspect/i,
      /docker.*images/i,
      /docker\s+exec/i,
      // Anchored: safe as the COMMAND, not as a substring of an argument.
      /^\s*git\s+(pull|log|status|diff)\b/i,
      /^\s*curl\b/i,
      /^\s*(cat|grep|head|tail|ls)\b/,
      /deploy\/scripts\/stage\.sh/,
      /deploy\/scripts\/promote\.sh/,
      /deploy\/scripts\/dev\.sh/,
      /docker.*compose.*dev.*up/i,
      /docker.*compose.*staging.*up/i,
    ];

    /*
     * PATTERN SCOPE — every pattern above, and the scope it is adjudicated over
     * (loom#1471 round-5). This table exists because the previous three fixes
     * each changed what a segment meant WITHOUT re-deriving the patterns
     * against the new meaning, and that seam produced a finding every round.
     *
     * SAFE — all 13, adjudicated over a SUB-INVOCATION, and only UNANIMOUSLY:
     *   /docker.*logs/i /docker.*ps/i /docker.*inspect/i /docker.*images/i
     *   /docker\s+exec/i                     span-matching; reach bounded by the
     *                                        unanimity requirement, NOT anchored
     *   /^\s*git\s+(pull|log|status|diff)\b/i
     *   /^\s*curl\b/i
     *   /^\s*(cat|grep|head|tail|ls)\b/      anchored to sub-invocation start
     *   deploy/scripts/{stage,promote,dev}.sh
     *   /docker.*compose.*{dev,staging}.*up/i  span-matching, same bound
     *
     * PROD — all 6, adjudicated over the whole INVOCATION:
     *   /docker.*compose.*prod.*{up,build,restart}/i
     *   /docker.*compose.*-f.*docker-compose\.prod/i
     *   /docker\s+restart\s+\S+/             unanchored spans, so an
     *   /ssh\s+.*docker\s+(compose|stack)/i  invocation-scope test subsumes a
     *                                        per-sub one; the ssh pattern
     *                                        REQUIRES this scope, since the
     *                                        deploy lives in the quoted payload
     *
     * WHY UNANIMITY IS THE FIX. Before quote-awareness a segment held ONE
     * command, so an unanchored SAFE pattern could only vouch for the command it
     * was in. Merging a quoted payload into its invocation — the round-4 ssh fix
     * — made a segment hold SEVERAL, and the five span-matching SAFE patterns
     * silently became load-bearing over a multi-command scope again. Measured:
     *
     *   ssh prod "docker compose ps && docker compose -f …prod.yml up -d"
     *   bash -c  "docker compose -f …prod.yml up -d && docker compose ps"
     *   docker ps " && docker compose -f …prod.yml up -d      (unterminated)
     *   docker ps & docker compose -f …prod.yml up -d          (background &)
     *
     * all exited 0: one `/docker.*ps/i` or `/docker.*logs/i` hit, `continue`,
     * loop ends false. For a command whose separators are ALL quoted, round 5
     * reproduced pre-round-3 behaviour exactly.
     *
     * Requiring EVERY sub-invocation to be read-only keeps the legitimate remote
     * read working — `ssh prod "docker compose logs -f api"`, and even
     * `ssh prod "docker compose ps && docker compose logs -f api"`, are all-read
     * and stay ungated — while a read beside a deploy no longer vouches for it.
     * Anchoring the five patterns instead was measured and REJECTED: it gates
     * both of those reads on the ssh PROD pattern, the false-positive family
     * R4b exists to prevent, and it still misses the unterminated-quote and
     * background-`&` shapes.
     */
    let isProductionDeploy = false;
    for (const invocation of _splitInvocations(command)) {
      const subs = _splitSubInvocations(invocation);
      // Vouched ONLY if every command inside this invocation is read-only.
      if (subs.every((sub) => SAFE_PATTERNS.some((safe) => safe.test(sub)))) {
        continue;
      }
      if (PROD_PATTERNS.some((prod) => prod.test(invocation))) {
        isProductionDeploy = true;
        break;
      }
    }

    if (!isProductionDeploy) {
      clearTimeout(timeout);
      process.exit(0);
      return;
    }

    // Skip-staging escape hatch — allow but warn loudly
    if (command.includes("--skip-staging")) {
      console.error(
        "\n" +
          "[DEPLOY HOOK] WARNING: --skip-staging detected.\n" +
          "[DEPLOY HOOK] Allowing direct production deploy WITHOUT staging verification.\n" +
          "[DEPLOY HOOK] You MUST document the reason in deploy/deployment-config.md.\n",
      );
      clearTimeout(timeout);
      process.exit(0);
      return;
    }

    // From here the command IS a production deploy and the operator did NOT
    // pass the escape hatch, so every remaining exit is a gate verdict.
    gatingProdDeploy = true;

    // Locate repo root by walking up from cwd or script location
    let repoRoot;
    try {
      // loom#1471 shard 3. This resolves the root the `.staging-passed` marker is
      // read from, and the next call resolves the HEAD that marker is compared
      // against — i.e. BOTH halves of the staging gate. Inheriting the ambient
      // environment let `GIT_DIR`/`GIT_WORK_TREE` point both at a decoy repo the
      // attacker prepared with a matching marker, satisfying the gate without
      // staging ever running. Absolute binary + constants-built env closes it.
      const gitBin = resolveGitBinary();
      if (!gitBin) throw new Error("git binary unresolved");
      repoRoot = execFileSync(gitBin, ["rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        timeout: 3000,
        env: gitEnv(),
      }).trim();
    } catch (err) {
      // INDETERMINATE — the staging gate could not run. Refuse; see the
      // fail-open note above the emitBlock helper.
      emitBlock({
        what_happened:
          "Production deploy attempted, but the repository root could not be resolved " +
          `(git rev-parse --show-toplevel failed: ${_reason(err)}). The staging gate did not run.`,
        why: "deploy-hygiene.md — the repo root is where .staging-passed is read from, so an unresolvable root means the staging check was SKIPPED, not passed. security.md § Enforcement-Surface Parity: git that cannot answer ranks TIGHTEST, never a clean negative.",
        agent_must_report: [
          "Quote the exact deploy command that was attempted",
          "State that staging verification did NOT run — this is not a staging failure, it is an unverified deploy",
          "Report the git error verbatim. Common cause: a differently-owned checkout (container bind-mount, CI runner, shared clone). `safe.directory` does NOT apply here — this hook runs git with GIT_CONFIG_GLOBAL=/dev/null, so global config is deliberately not read",
          "Run the deploy from a checkout git can read, OR re-issue with `--skip-staging` AND document the reason in deploy/deployment-config.md",
        ],
        agent_must_wait:
          "Do not retry until git can resolve the repository root, OR the user authorises `--skip-staging` with a documented reason.",
        user_summary:
          "Production deploy blocked — staging could not be verified (git cannot resolve the repo root)",
      });
      return;
    }

    const markerPath = path.join(repoRoot, ".staging-passed");

    // Check that .staging-passed exists.
    // Structural signal per hook-output-discipline.md MUST-2: file existence
    // (fs.existsSync) — not a lexical regex. Block severity is grounded.
    if (!fs.existsSync(markerPath)) {
      emitBlock({
        what_happened: `Production deploy attempted without staging verification (no .staging-passed marker at ${markerPath})`,
        why: "deploy-hygiene.md — staging MUST pass before production deploy; .staging-passed is the structural verification marker written by deploy/scripts/stage.sh",
        agent_must_report: [
          "Quote the exact deploy command that was attempted",
          "State whether staging has been run (run `bash deploy/scripts/promote.sh` or staging+deploy step-by-step)",
          "If emergency bypass is needed, re-issue the command with `--skip-staging` AND document the reason in deploy/deployment-config.md",
        ],
        agent_must_wait:
          "Do not retry until staging has produced .staging-passed at the current commit, OR --skip-staging is passed with a documented reason.",
        user_summary:
          "Production deploy blocked — staging verification missing",
      });
      return;
    }

    // Verify that .staging-passed contains the current commit
    const marker = fs.readFileSync(markerPath, "utf8").trim();
    let currentCommit;
    try {
      // loom#1471 shard 3 — the other half of the gate; see the comment above.
      const gitBin = resolveGitBinary();
      if (!gitBin) throw new Error("git binary unresolved");
      currentCommit = execFileSync(gitBin, ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 3000,
        env: gitEnv(),
      }).trim();
    } catch (err) {
      // INDETERMINATE — the marker exists but there is no HEAD to compare it
      // against, so "staging is current" is unknowable. A marker that cannot be
      // checked for staleness is not a passing gate.
      emitBlock({
        what_happened:
          "Production deploy attempted with a .staging-passed marker that could not be checked for staleness " +
          `(git rev-parse HEAD failed in ${repoRoot}: ${_reason(err)}).`,
        why: "deploy-hygiene.md — the marker is only evidence when it matches the CURRENT commit. With HEAD unresolvable the marker may predate any number of changes, so treating it as a pass verifies nothing. security.md § Enforcement-Surface Parity: git that cannot answer ranks TIGHTEST.",
        agent_must_report: [
          "Quote the exact deploy command that was attempted",
          `State that the staleness check did NOT run against ${repoRoot} — the marker was found but not verified`,
          "Report the git error verbatim (a checkout with no commits, a differently-owned checkout, or a corrupt repository all produce this)",
          "Re-run `bash deploy/scripts/promote.sh` from a checkout git can read, OR re-issue with `--skip-staging` AND document the reason in deploy/deployment-config.md",
        ],
        agent_must_wait:
          "Do not retry until git can resolve HEAD and staging has been re-run at that commit, OR the user authorises `--skip-staging` with a documented reason.",
        user_summary:
          "Production deploy blocked — staging marker present but unverifiable (git cannot resolve HEAD)",
      });
      return;
    }

    const shortHash = currentCommit.substring(0, 7);
    // Structural signal per hook-output-discipline.md MUST-2: process state
    // (git rev-parse) compared against a file content (.staging-passed marker).
    // Mismatch is structural evidence that staging is stale; block is grounded.
    if (!marker.includes(shortHash)) {
      emitBlock({
        what_happened: `Production deploy attempted with stale staging marker (HEAD=${shortHash}, marker contains ${marker.substring(0, 7)})`,
        why: "deploy-hygiene.md — code has changed since staging last passed; staging MUST be re-run against the current commit before production deploy",
        agent_must_report: [
          "Quote the deploy command",
          `State the current HEAD (${shortHash}) and the stale marker (${marker.substring(0, 7)})`,
          "Re-run `bash deploy/scripts/promote.sh` to refresh staging at HEAD before retrying",
        ],
        agent_must_wait:
          "Do not retry until staging has been re-run at the current commit and .staging-passed contains the current HEAD short hash.",
        user_summary: `Production deploy blocked — staging stale (HEAD=${shortHash}, marker=${marker.substring(0, 7)})`,
      });
      return;
    }

    // Staging verified and current — allow production deploy
    console.error(
      `[DEPLOY HOOK] Staging verified (${shortHash}). Allowing production deploy.`,
    );
    clearTimeout(timeout);
    process.exit(0);
  } catch (err) {
    // Unexpected failure. The disposition SPLITS, because the two cases are not
    // alike. Once `gatingProdDeploy` is set the command is known to be a
    // production deploy with no escape hatch, so an unexpected failure is still
    // a gate that did not run — refuse. Before that point the hook cannot even
    // tell what the command is (a malformed or oversized stdin payload gets
    // here), and blocking there would block EVERY Bash call in the session on a
    // parse bug — a worse failure mode than the one being closed, per
    // hook-output-discipline.md MUST NOT § "Detectors that block work the agent
    // has been instructed to perform".
    if (gatingProdDeploy) {
      emitBlock({
        what_happened: `Production deploy attempted, but the staging gate failed unexpectedly: ${_reason(err)}`,
        why: "deploy-hygiene.md — an aborted gate is not a passed gate. The staging verification did not complete, so nothing here says this deploy was verified.",
        agent_must_report: [
          "Quote the exact deploy command that was attempted",
          "State that the staging gate ABORTED — the deploy is unverified",
          `Report the underlying error verbatim: ${_reason(err)}`,
          "Re-issue with `--skip-staging` AND document the reason in deploy/deployment-config.md only if the user authorises proceeding unverified",
        ],
        agent_must_wait:
          "Do not retry until the cause of the hook failure is understood, OR the user authorises `--skip-staging` with a documented reason.",
        user_summary:
          "Production deploy blocked — staging gate aborted before it could verify",
      });
      return;
    }
    // Pre-classification failure: the command may be anything at all.
    clearTimeout(timeout);
    process.exit(0);
  }
}

main();
