#!/usr/bin/env node
/**
 * rebase-content-loss-guard.js — loom#1773.
 *
 * @hook-event: PreToolUse:Bash (guard) — the rebase IS the subject, and this is
 *   the last instant at which the branch still carries the merge commits the
 *   replay is about to drop. One moment later the count is 1 and the content is
 *   gone with no reflog entry that names what was lost. The matcher is exactly
 *   `Bash`, the only tool that can run git; a `*` matcher would pay a node spawn
 *   on every Read/Grep to reach an immediate passthrough, and
 *   `hook-event-selection.md` MUST-3 FAILs a narrow class registered without a
 *   matcher.
 *
 * SEVERITY: `block`, and the basis is stated rather than assumed.
 *   `hook-output-discipline.md` MUST-2 permits `block` only on a signal a
 *   surface rewrite cannot evade. This one has two halves and BOTH are
 *   structural:
 *     · WHICH command — the parsed subcommand POSITION and the ARGV TOKENS from
 *       `lib/git-command-parse.js`, never a regex over the joined string. So
 *       `echo "git rebase main"` is not an invocation, and `--rebase-merges`
 *       appearing inside an `--exec` message body is not the flag.
 *     · WHETHER it loses content — an INTEGER from
 *       `git rev-list --merges --count <base>..<tip>`, a git-object fact.
 *   If either half ever becomes a prose match, this hook loses the right to
 *   block and MUST drop to halt-and-report.
 *
 * FAILS OPEN ON EVERY UNRESOLVED CONDITION — missing git, non-zero exit,
 * timeout, detached HEAD, an unresolvable base ref, an unrecognised command
 * shape, a subcommand hidden behind command substitution. A guard that failed
 * closed on ambiguity would be disabled by the first operator it blocked
 * wrongly, which restores the bug it exists to prevent. Every fail-open path
 * that had something to say says it as an `advisory` rather than in silence
 * (`zero-tolerance.md` Rule 3).
 *
 * OVERRIDE: `COC_REBASE_FLATTEN_ACK="<reason>"`. It MUST NAME ITS REASON — a
 * bare `=1` does not clear the block, and an accepted override still emits an
 * advisory quoting the reason and the merge count, so it is recorded, not
 * hidden.
 *
 * ── SECOND MODE: `--verify <pre-rebase-ref>` ────────────────────────────────
 *
 *   node .claude/hooks/rebase-content-loss-guard.js --verify <ref> \
 *        [--head <ref>] [--cwd <dir>] [--json]
 *
 * Reports every commit on the pre-rebase ref whose CONTENT is absent from HEAD,
 * by forward and reverse patch-apply against a temporary index — NOT by sha
 * membership, because a rebased duplicate carries a different sha and identical
 * content, so sha membership reports loss for every commit a CORRECT rebase
 * rewrote. Distinguishes absent / present / diverged, which is the distinction
 * the issue's own author got wrong while writing the issue (ten reported
 * dropped fixes re-measured to four dropped, four never dropped, two diverged).
 *
 * EXIT CODES (verify mode)  0 = nothing absent · 1 = at least one commit's
 * content is ABSENT · 2 = the question could not be answered (UNKNOWN, which is
 * never an all-clear).
 *
 * Origin: loom#1773 — an integration lane assembled by merging feature branches
 * in was rebased four times; 47 commits → 25, merge commits 15 → 1, four
 * already-reviewed fixes stopped being present. The PR stayed green because the
 * tests covering the dropped fixes were dropped with them.
 */

"use strict";

const path = require("path");

const { emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js"));
const {
  OVERRIDE_ENV,
  VERDICT,
  readOverride,
  classifyRebaseCommand,
  countMergesToBeDropped,
  verifyContentPresence,
} = require(path.join(__dirname, "lib", "rebase-content-loss.js"));

const TIMEOUT_MS = 4500;

// ── verify mode ─────────────────────────────────────────────────────────────

function parseVerifyArgs(argv) {
  const out = { ref: null, head: "HEAD", cwd: process.cwd(), json: false };
  // A flag whose value is MISSING is a usage error, never a silent default: a
  // `--head` that quietly fell back to HEAD would answer a different question
  // than the one typed, and report it as if it were the same one.
  const value = (i, flag) => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} requires a value`);
    return v;
  };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--verify") out.ref = value(++i, a);
      else if (a === "--head") out.head = value(++i, a);
      else if (a === "--cwd") out.cwd = value(++i, a);
      else if (a === "--json") out.json = true;
      else return { error: `unknown argument: ${a}` };
    }
  } catch (e) {
    return { error: e.message };
  }
  if (!out.ref) return { error: "--verify requires a <ref>" };
  return out;
}

function runVerify(argv) {
  const args = parseVerifyArgs(argv);
  if (args.error) {
    process.stderr.write(
      `rebase-content-loss-guard: ${args.error}\n` +
        "usage: rebase-content-loss-guard.js --verify <ref> [--head <ref>] [--cwd <dir>] [--json]\n",
    );
    return 2;
  }
  const res = verifyContentPresence({
    cwd: args.cwd,
    ref: args.ref,
    headRef: args.head,
  });
  if (!res.resolved) {
    // UNKNOWN is not an all-clear. Exit 2 keeps it distinguishable from the
    // clean answer at exit 0 (`instrument-discipline.md` MUST-1).
    if (args.json) {
      process.stdout.write(JSON.stringify({ resolved: false, why: res.why, commits: [] }) + "\n");
    } else {
      process.stderr.write(`UNKNOWN — content presence could not be determined: ${res.why}\n`);
    }
    return 2;
  }
  const by = (v) => res.commits.filter((c) => c.verdict === v);
  const absent = by(VERDICT.ABSENT);
  if (args.json) {
    process.stdout.write(
      JSON.stringify({
        resolved: true,
        ref: res.ref,
        head: res.headRef,
        base: res.base,
        absent: absent.map((c) => ({ sha: c.sha, subject: c.subject })),
        commits: res.commits,
      }) + "\n",
    );
    return absent.length ? 1 : 0;
  }
  const lines = [];
  lines.push(`content-presence verify: ${res.ref} → ${res.headRef} (base ${res.base.slice(0, 12)})`);
  lines.push(
    `  ${res.commits.length} candidate commit(s): ` +
      [VERDICT.ABSENT, VERDICT.PRESENT, VERDICT.DIVERGED, VERDICT.INDETERMINATE, VERDICT.NO_CONTENT]
        .map((v) => `${by(v).length} ${v}`)
        .join(", "),
  );
  if (absent.length) {
    lines.push("");
    lines.push(`ABSENT — present on ${res.ref}, NOT present on ${res.headRef}:`);
    for (const c of absent) lines.push(`  ${c.sha.slice(0, 12)} ${c.subject}`);
  }
  const diverged = by(VERDICT.DIVERGED);
  if (diverged.length) {
    lines.push("");
    lines.push("DIVERGED — neither cleanly applies nor cleanly reverses (partially present):");
    for (const c of diverged) lines.push(`  ${c.sha.slice(0, 12)} ${c.subject}`);
  }
  const indet = by(VERDICT.INDETERMINATE);
  if (indet.length) {
    lines.push("");
    lines.push("INDETERMINATE — no verdict; treat as UNANSWERED, not as clean:");
    for (const c of indet) lines.push(`  ${c.sha.slice(0, 12)} ${c.subject}`);
  }
  if (!absent.length) {
    lines.push("");
    lines.push(`No commit's content is ABSENT from ${res.headRef}.`);
  }
  process.stdout.write(lines.join("\n") + "\n");
  return absent.length ? 1 : 0;
}

// ── hook mode ───────────────────────────────────────────────────────────────

function passthrough(fallback) {
  clearTimeout(fallback);
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

function advisory(fallback, { what_happened, why, agent_must_report, agent_must_wait, user_summary }) {
  clearTimeout(fallback);
  emit({
    hookEvent: "PreToolUse",
    severity: "advisory",
    what_happened,
    why,
    agent_must_report,
    agent_must_wait,
    user_summary,
  });
}

function decide({ command, cwd, env }) {
  const cls = classifyRebaseCommand(command);
  if (cls.kind === "not-applicable") return { action: "allow", reason: "no replaying git invocation in this command" };
  if (cls.kind === "non-replay")
    return { action: "allow", reason: `git ${cls.verb} ${cls.flag} replays no commits` };
  if (cls.kind === "preserving")
    return { action: "allow", reason: `${cls.flag} preserves merge commits` };
  if (cls.kind === "unresolvable")
    return { action: "fail-open", reason: cls.why };

  const measured = countMergesToBeDropped({
    cwd: cls.dir ? path.resolve(cwd || process.cwd(), cls.dir) : cwd,
    upstream: cls.upstream,
    branch: cls.branch,
  });
  if (!measured.resolved) return { action: "fail-open", reason: measured.why, cls };
  if (measured.count === 0)
    return { action: "allow", reason: `0 merge commits on ${measured.tip} since ${measured.base}`, measured, cls };

  const override = readOverride(env);
  if (override.present && override.accepted) {
    return { action: "override", reason: override.reason, measured, cls };
  }
  return { action: "block", measured, cls, override };
}

function runHook(payload, fallback) {
  if (!payload || payload.tool_name !== "Bash") return passthrough(fallback);
  const command = (payload.tool_input && payload.tool_input.command) || "";
  if (!command.trim()) return passthrough(fallback);

  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  const d = decide({ command, cwd, env: process.env });

  if (d.action === "allow") return passthrough(fallback);

  if (d.action === "fail-open") {
    return advisory(fallback, {
      what_happened: `A git invocation that may replay commits could NOT be measured for content loss: ${d.reason}`,
      why: "rebase-content-loss-guard (loom#1773) — a rebase of a branch assembled by merging feature branches in drops its merge commits and, with them, the content those merges carried. This guard fails OPEN on every unresolved condition, so the command is NOT blocked; but an unmeasured risk is not an absent one (instrument-discipline.md MUST-1).",
      agent_must_report: [
        "State that the rebase content-loss check did NOT run — the risk is UNKNOWN, not absent.",
        `Why it could not answer: ${d.reason}`,
        "Before rebasing, record the pre-rebase tip: `git rev-parse HEAD` (or `git branch pre-rebase-<name>`).",
        "After rebasing, run: node .claude/hooks/rebase-content-loss-guard.js --verify <pre-rebase-ref>",
      ],
      agent_must_wait: "You may proceed; report that the check did not run before claiming the rebase preserved content.",
      user_summary: "rebase-content-loss-guard — content-loss check did not run (UNKNOWN, not clean)",
    });
  }

  if (d.action === "override") {
    return advisory(fallback, {
      what_happened: `A flattening rebase is proceeding under ${OVERRIDE_ENV} on a branch carrying ${d.measured.count} merge commit(s) since ${d.measured.base}.`,
      why: `rebase-content-loss-guard (loom#1773) — the override was ACCEPTED because it names a reason: ${JSON.stringify(d.reason)}. It is recorded here rather than applied silently, so the decision is auditable and the operator's stated reason travels with it.`,
      agent_must_report: [
        `Operator reason for flattening: ${d.reason}`,
        `Merge commits that will be dropped: ${d.measured.count} (${d.measured.base}..${d.measured.tip})`,
        "Capture the pre-rebase tip NOW so the loss is measurable afterwards.",
        "After the rebase, run `--verify <pre-rebase-ref>` and report the absent-commit list.",
      ],
      agent_must_wait: "Proceed, then report the post-rebase --verify result before calling the rebase done.",
      user_summary: `rebase-content-loss-guard — flattening ${d.measured.count} merge(s) under an explicit override`,
    });
  }

  // BLOCK. Both halves of the signal are structural; see the header.
  clearTimeout(fallback);
  const m = d.measured;
  const rejected = d.override && d.override.rejected;
  emit({
    hookEvent: "PreToolUse",
    severity: "block",
    what_happened: `git ${d.cls.verb} would replay ${m.tip} onto ${m.base} WITHOUT --rebase-merges, and ${m.tip} carries ${m.count} merge commit(s) since ${m.base}.`,
    why:
      "rebase-content-loss-guard (loom#1773) — a plain rebase replays a LINEARISED commit list and drops merge commits. On a branch assembled by merging feature branches in, the content those merges carried stops being present, silently: measured on one lane, 47 commits → 25, merge commits 15 → 1, four already-reviewed fixes gone, with the PR still green because the tests covering them were dropped too. " +
      `The signal is structural, not lexical — the verb comes from a parsed subcommand position and the count is an integer from \`git rev-list --merges --count ${m.base}..${m.tip}\` — which is what permits block severity under hook-output-discipline.md MUST-2.` +
      (rejected ? ` ${rejected}` : ""),
    agent_must_report: [
      `Merge commits at risk: ${m.count}, measured as \`git rev-list --merges --count ${m.base}..${m.tip}\` (base source: ${m.baseSource}).`,
      "Preferred fix: re-run with `--rebase-merges`, which replays the merge structure instead of flattening it.",
      "Alternative: `git merge` the base into the lane instead of rebasing — an assembled lane has no stable identity under replay.",
      "If flattening is genuinely intended, record the pre-rebase tip first (`git branch pre-rebase-<name>`), then re-run with " +
        `${OVERRIDE_ENV}="<the reason>" set — the override MUST name its reason, and it is reported, not hidden.` +
        (rejected ? ` (Current value rejected: ${rejected})` : ""),
      "After ANY flattening rebase, run `node .claude/hooks/rebase-content-loss-guard.js --verify <pre-rebase-ref>` and report the absent-commit list.",
    ],
    agent_must_wait:
      "Do not re-run this rebase until you have either added --rebase-merges, switched to a merge, or set the override with a stated reason. Report the choice to the user first.",
    user_summary: `rebase-content-loss-guard — BLOCKED a flattening git ${d.cls.verb}; ${m.count} merge commit(s) would be dropped`,
  });
}

// ── entry ───────────────────────────────────────────────────────────────────

// hookMain — the ONE entry for the HOOK mode, run by the CLI guard at the bottom
// of this file AND in-process by lib/hook-engine.js (dispatch.js). The
// `--verify` CLI mode stays in the guard itself, ahead of it.
function hookMain() {
  // Hard timeout fallback per cc-artifacts.md Rule 7. This is the ONE legitimate
  // raw-exit path in this file, and it emits `{continue: true}` FIRST so a hung
  // git subprocess degrades to a passthrough rather than wedging the session.
  const fallback = setTimeout(() => {
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    process.exit(0);
  }, TIMEOUT_MS);

  const { readStdinBounded } = require(path.join(__dirname, "lib", "read-stdin-bounded.js"));

  return (async () => {
    // Resolves the PARSED payload (or its `{}` fallback) — never raw text — and
    // never rejects: every non-happy path (no TTY, empty, parse error, timeout)
    // resolves the fallback, which `runHook` reads as "not a Bash call" and
    // passes through. That IS this guard's fail-open contract for stdin.
    let payload = {};
    try {
      payload = await readStdinBounded();
    } catch {
      return passthrough(fallback);
    }
    try {
      runHook(payload, fallback);
    } catch (err) {
      process.stderr.write(
        `[ADVISORY] rebase-content-loss-guard internal error: ${err && err.message ? err.message : String(err)}\n`,
      );
      passthrough(fallback);
    }
  })();
}

module.exports = { decide, runVerify, parseVerifyArgs, runHook, hookMain };

// `require.main === module` gates BOTH modes. Without it, the suite's `require`
// of this file for `decide()` would start reading stdin and hang — the suite
// would then be measuring a process it accidentally started, not the function
// it meant to call.
if (require.main === module) {
  if (process.argv.includes("--verify")) {
    process.exit(runVerify(process.argv.slice(2)));
  } else if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") {
    require("./lib/hook-engine.js").runCli(hookMain, __filename);
  } else hookMain();
}
