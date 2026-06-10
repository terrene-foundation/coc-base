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
const { detectStateFileMutation } = require("./lib/violation-patterns");

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

// Command-wrappers that may precede a `git` invocation. Each may carry its
// own flags AND a bare flag-operand (e.g. `sudo -u root`, `nice -n 10`); the
// scan below skips a bare operand ONLY inside an established wrapper context.
const GIT_WRAPPERS = new Set([
  "sudo",
  "doas",
  "env",
  "command",
  "nice",
  "nohup",
  "time",
  "timeout",
  "ionice",
  "setsid",
  "stdbuf",
  "chrt",
  "taskset",
]);
// `git`, `/usr/bin/git`, `./git`, `\git` — a path-qualified, bare, or
// backslash-escaped git token. The optional leading `\` closes the
// MED-R3-1 alias-bypass form (`\git clean` runs the git binary at bash
// runtime; the backslash only skips alias/function lookup). The `$IFS`
// form (`git$IFS clean`) is NOT closable here — it requires shell
// expansion the hook MUST NOT perform (hook-output-discipline.md Rule 3 /
// security.md § no-eval) — and stays an accepted residual backed by the
// sync-tier-aware pre-write snapshot (the surface-agnostic forever-layer).
const isGitToken = (t) => /^\\?(?:[^\s]*\/)?git$/.test(t);

/**
 * Parse a shell segment as a git invocation, tolerant of command-prefixes
 * (sudo/doas/env/command/nice/… including their `-flag operand` forms, plus
 * `VAR=val` assignments and a path-qualified `git`) AND git global options
 * (`-C <dir>`, `-c <k=v>`, `--git-dir[=]`, `--work-tree[=]`, `-p`, `--bare`,
 * …) that sit BEFORE the subcommand. Returns { sub (lowercased), dir (the
 * effective work-tree for the structural check — `--work-tree` wins over
 * `-C`, else null=cwd), args (post-subcommand remainder) } or null when the
 * segment is not a git invocation.
 *
 * HIGH-1 (R1): the prior `^git\s+<sub>` anchors were bypassed by
 * `git -C <dir> <sub>` — the cross-tree form the #401 incident used.
 * HIGH-R2-1 (R2): the prefix-stripper regex was bypassed by `sudo -u root
 * git …` (the `-u` operand is not a dash-flag), `command git …`, and
 * `/usr/bin/git …`. This tokenize-and-skip scan closes that class.
 * MED-R2-1 (R2): `--work-tree=<dir>` attached form is now captured so the
 * porcelain check inspects the SAME tree the destructive op mutates.
 */
function parseGitInvocation(seg) {
  const raw = (seg || "").trim();
  if (!raw) return null;
  const toks = raw.split(/\s+/).filter(Boolean);

  // (1) Skip leading wrappers + their flags/operands + VAR=val until `git`.
  let i = 0;
  let sawWrapper = false;
  while (i < toks.length) {
    const t = toks[i];
    if (isGitToken(t)) break; // the git command token
    if (/^[A-Za-z_]\w*=/.test(t)) {
      i++;
      continue;
    } // VAR=val assignment
    if (GIT_WRAPPERS.has(t.replace(/^.*\//, ""))) {
      sawWrapper = true;
      i++;
      continue;
    } // wrapper command name (basename, so `/usr/bin/sudo` counts)
    if (t.startsWith("-")) {
      i++;
      continue;
    } // a flag (wrapper's or env's)
    if (sawWrapper) {
      i++;
      continue;
    } // bare flag-operand inside wrapper context (e.g. `-u root`)
    return null; // bare non-git command outside wrapper context → not git
  }
  if (i >= toks.length || !isGitToken(toks[i])) return null;
  i++; // consume the git token

  // (2) Skip git global options; capture the effective work-tree for the
  // structural porcelain check. A bare `--git-dir` does NOT set the target
  // (its work-tree defaults to cwd); only `--work-tree`/`-C` relocate it.
  let cDir = null;
  let workTree = null;
  while (i < toks.length) {
    const t = toks[i];
    if (t === "--") {
      i++;
      break;
    }
    if (t === "-C") {
      if (toks[i + 1]) cDir = toks[i + 1];
      i += 2;
      continue;
    }
    if (t === "--work-tree") {
      if (toks[i + 1]) workTree = toks[i + 1];
      i += 2;
      continue;
    }
    if (
      t === "-c" ||
      t === "--git-dir" ||
      t === "--namespace" ||
      t === "--super-prefix"
    ) {
      i += 2;
      continue;
    }
    const wt = t.match(/^--work-tree=(.+)$/);
    if (wt) {
      workTree = wt[1];
      i++;
      continue;
    }
    if (t.startsWith("-")) {
      i++; // --git-dir=X, -p, --paginate, --bare, --no-pager, etc.
      continue;
    }
    break; // first non-option token = the subcommand
  }
  if (i >= toks.length) return null;
  return {
    sub: toks[i].toLowerCase(),
    dir: workTree || cDir,
    args: toks.slice(i + 1).join(" "),
  };
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
    const r = spawnSync(
      "git",
      [
        "-C",
        dir || cwd || ".",
        "status",
        "--porcelain",
        "--untracked-files=all",
      ],
      { encoding: "utf8", timeout: 2500, stdio: ["ignore", "pipe", "ignore"] },
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

  // ADVISORY (loom #19 P3): branch-scope warn on `git commit` invocations.
  // Delegates to .claude/hooks/pre-commit-branch-scope.js which always
  // exits 0 and writes any out-of-scope advisory to stderr. Warn-only.
  if (/^\s*git\s+commit\b/.test(command)) {
    try {
      const { spawnSync } = require("child_process");
      const scopeScript = path.join(__dirname, "pre-commit-branch-scope.js");
      const r = spawnSync("node", [scopeScript], {
        cwd,
        encoding: "utf8",
        timeout: 4500,
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
  if (/^\s*git\s+commit\b/.test(command)) {
    try {
      const { spawnSync } = require("child_process");
      // Only run when the commit stages a synced-surface path. Cheap
      // pre-filter — avoids scanning on commits that touch only non-
      // `.claude/**` files (the scanner already excludes never-synced
      // subpaths internally, but skipping the spawn entirely is faster).
      const staged = spawnSync("git", ["diff", "--cached", "--name-only"], {
        cwd,
        encoding: "utf8",
        timeout: 3000,
      });
      const stagedFiles = (staged.stdout || "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const touchesSynced = stagedFiles.some(
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
        const r = spawnSync("node", [scanScript, "--check"], {
          cwd,
          encoding: "utf8",
          timeout: 4000,
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
  //   .claude/learning/coordination-log.jsonl   (iter-4 MED-R4-3)
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
  // bodies are documentation prose, not executable commands. Skip detection
  // entirely for those (segment-anchor isn't sufficient — the body can span
  // many lines containing arbitrary shell-like syntax as documentation).
  // M5 iter-6 Sec-MED-A2: extended to cover .heartbeat-cache and
  // .session-end-cache. Pre-iter-6 these two M5-substrate cache files
  // had no Layer-1 redirect-detector coverage AND no deny-matrix entry,
  // leaving the cross-operator cache-poisoning vector exposed: a
  // `cat > .claude/learning/.heartbeat-cache << EOF { "verified_id":
  // "<attacker>", "last_heartbeat_ms": Date.now(), "seq": 99 } EOF`
  // would coalesce future heartbeats under the attacker's seq number.
  // Paired with the readCache identity-guard in adjacency-heartbeat.js
  // (rejects cache whose verified_id ≠ current operator).
  const STATE_PATH_RX =
    /\.claude\/(?:learning\/(?:posture\.json(?:\.bak|\.tmp\.\d+)?|violations\.jsonl(?:\.[A-Za-z0-9_-]+)?|coordination-log\.jsonl|\.initialized|\.heartbeat-cache(?:[A-Za-z0-9_.-]*)?|\.session-end-cache(?:[A-Za-z0-9_.-]*)?)|operators\.roster\.json)\b/;
  const isGitCommitWithBody = /^\s*git\s+commit\b[^|;]*(?:\s-m\s|\s-F\s)/.test(
    command,
  );
  const stateFileMutation = isGitCommitWithBody
    ? null
    : detectStateFileMutation(command, STATE_PATH_RX);
  if (stateFileMutation) {
    try {
      logLearningObservation(cwd, "rule_violation", {
        rule: "trust-posture/state-file-mutation",
        layer: stateFileMutation.layer,
      });
    } catch {}
    return {
      severity: "block",
      what_happened: `Bash command attempts to mutate trust-posture state file (Layer ${stateFileMutation.layer}: ${stateFileMutation.kind}): ${command.slice(0, 120)}`,
      why: "trust-posture/state-file-mutation — state files (posture.json, violations.jsonl, .initialized) are owned by hooks; agent edits are BLOCKED",
      agent_must_report: [
        "Quote the exact bash command that was attempted",
        "State whether you intended to read, debug, or modify the state",
        "If reading: use `cat` (allowed); if modifying: use /posture command instead",
      ],
      agent_must_wait:
        "Do not retry. State-file mutations route through the /posture command (challenge-nonce gated), never directly.",
      user_summary: `state-file mutation blocked (Layer ${stateFileMutation.layer})`,
    };
  }

  // BLOCK: Dangerous commands (with evasion-resistant patterns)
  const dangerousPatterns = [
    {
      pattern: /rm\s+(-[rRf]+\s+)*\/($|\s|\*)/,
      message: "Blocked: rm on root filesystem",
    },
    {
      pattern: /rm\s+--(?:recursive|force)\b/,
      message: "Blocked: rm recursive/force with long flags",
    },
    { pattern: />\s*\/dev\/sd/, message: "Blocked: Writing to block device" },
    { pattern: /mkfs\./, message: "Blocked: Filesystem formatting" },
    { pattern: /dd\s+if=.*of=\/dev\/sd/, message: "Blocked: dd to disk" },
    { pattern: /:\(\)\{\s*:\|:&\s*\};:/, message: "Blocked: Fork bomb" },
    {
      pattern: /(\w+)\(\)\s*\{\s*\1\s*\|\s*\1\s*&\s*\}\s*;\s*\1/,
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
  const segments = command.split(/(?:\|\||&&|;|\|(?!\|))/);

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

  // WARN: Git commit - reminder for review
  if (/git\s+commit/.test(command)) {
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
 * Per issue #25 (esperie-enterprise/loom) — adopted from a downstream consumer's
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
