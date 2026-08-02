#!/usr/bin/env node
/**
 * detect-violations — POC hook for the trust-posture system.
 *
 * Wired to multiple events; reads tool_event from stdin payload's hookEventName field.
 *   PostToolUse(Bash)         → repo-scope-bash, commit-claim
 *   PostToolUse(Edit|Write)   → worktree-drift
 *   Stop                      → pre-existing-no-SHA, sweep-substitution, self-confession
 *   UserPromptSubmit          → regression signal from user prompt
 *
 * Mitigates cc-artifacts.md Rule 7 (timeout fallback).
 */

const TIMEOUT_MS = 5000;
const fallback = setTimeout(() => {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(1);
}, TIMEOUT_MS);

const path = require("path");
const { emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js"));
const {
  appendViolation,
  readPosture,
  readRecentViolations,
  isPendingWithinGrace,
} = require(path.join(__dirname, "lib", "state-io.js"));
const { appendStamped } = require(path.join(__dirname, "lib", "coc-append.js"));
// M9.1 R7 Sec-R7-S-01 — route stamped-path file construction through the
// shared resolver so a worktree-isolated rostered agent writes to the
// MAIN checkout's `.claude/learning/violations.jsonl`, not the worktree's
// (which is auto-deleted on cleanup, dropping the row + corrupting the
// cumulative-violation downgrade math per `trust-posture.md` MUST-4).
const { ensureStateDir } = require(
  path.join(__dirname, "lib", "state-resolver.js"),
);
const { resolveIdentity } = require(
  path.join(__dirname, "lib", "operator-id.js"),
);
const P = require(path.join(__dirname, "lib", "violation-patterns.js"));
const { isMutationTool } = require(
  path.join(__dirname, "lib", "tool-classes.js"),
);

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) return resolve({});
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

function passthrough() {
  clearTimeout(fallback);
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

function _logViolation(cwd, finding) {
  // M9.1 R3 Sec-R3-S-02 — route through appendStamped (signed identity
  // stamping) per `knowledge-convergence.md` MUST-6 when an identity is
  // resolvable. Falls back to legacy appendViolation when the operator
  // is un-rostered (loom's current state, pre-enrollment-ceremony): the
  // un-rostered path is the M9.x deferred-enrollment carve-out per
  // Bootstrap-1. The stamped path is the structural defense against
  // cross-operator attribution forgery the security review flagged.
  const partial = {
    rule_id: finding.rule_id,
    severity: finding.severity,
    evidence: finding.evidence,
    // Bounded at ingest. Unbounded, this env value is a lever for inflating the record
    // past `coc-append`'s pre-sign cap, and the oversize path below falls through to the
    // UNSIGNED appender and stamps the row `attribution: "un-rostered"` — so a large
    // enough env var strips verified_id / person_id / sig from a genuinely rostered
    // operator's violations and mislabels them as un-rostered. `session_id`, the other
    // env-derived lever, is bounded in both appenders. See the F5 note below.
    posture_at_time: String(
      process.env.CLAUDE_CURRENT_POSTURE || "unknown",
    ).slice(0, 64),
    addressed_by: null,
  };
  try {
    const id = resolveIdentity(cwd);
    if (id && id.verified_id && id.person_id) {
      // M9.1 R7 Sec-R7-S-01 — route through state-resolver SSOT so the
      // stamped row lands in the MAIN checkout's `.claude/learning/`,
      // not the worktree's auto-deleted directory. Mirrors the legacy
      // `appendViolation` path which routes via `ensureStateDir(cwd)`.
      const stateDir = ensureStateDir(cwd);
      const filePath = path.join(stateDir, "violations.jsonl");
      const result = appendStamped(cwd || process.cwd(), filePath, partial, {
        identity: {
          verified_id: id.verified_id,
          person_id: id.person_id,
          display_id: id.display_id,
        },
      });
      if (result && result.ok) return;
      // appendStamped failed (record too large, sign failed, etc.):
      // fall through to legacy path so the violation is still logged.
    }
  } catch {
    // resolveIdentity failure (missing key, broken roster) — fall through.
  }
  // Un-rostered or stamped-append failed: legacy unsigned path with
  // explicit marker so audit can distinguish stamped from un-stamped rows.
  appendViolation(cwd, {
    ...partial,
    attribution: "un-rostered",
  });
}

function logAndEmit(payload, event, finding, what_happened) {
  _logViolation(payload.cwd, finding);

  clearTimeout(fallback);
  emit({
    hookEvent: event,
    severity: finding.severity,
    what_happened,
    why: finding.rule_id,
    agent_must_report: [
      "Quote the exact text/command that triggered the detection",
      "State which rule was violated and its origin evidence date",
      "Propose remediation in this turn (do not file a follow-up issue)",
    ],
    agent_must_wait:
      "Do not retry or proceed with related work until the user instructs.",
    user_summary: `${finding.rule_id} — ${what_happened.slice(0, 60)}`,
  });
}

(async () => {
  const payload = await readStdin();
  const event = payload.hook_event_name || payload.hookEventName || "Unknown";

  // PreToolUse(Read): stale-record banner if reading session-notes /
  // observations.jsonl / journal/* file dated before most-recent
  // pending_verification rule was authored. Mitigates the compound failure
  // where agent inherits its own pre-rule "all-clear" record.
  if (event === "PreToolUse") {
    const tool = payload.tool_name;
    const input = payload.tool_input || {};
    if (tool === "Read") {
      const fp = input.file_path || "";
      const isStaleCandidate =
        /\.session-notes(?:$|\/)/.test(fp) ||
        /observations\.jsonl/.test(fp) ||
        /\/journal\//.test(fp);
      if (isStaleCandidate) {
        try {
          const fs = require("fs");
          const stat = fs.statSync(fp);
          const posture = readPosture(payload.cwd);
          // loom#875 — DELIBERATELY NOT grace-filtered. This is the STALE-RECORD
          // file-provenance surface: a session-notes / observations / journal
          // file that pre-dates ANY authored rule still holds "tests pass" /
          // "verified" claims that are unverified under that rule — grace
          // expiry does NOT restore their validity (a grace-expired-but-still-
          // enforced rule still invalidates a record older than it). Adding
          // isPendingWithinGrace() here in a future "consistency" pass would
          // wrongly stop flagging stale records once grace lapses. The
          // grace-filter belongs ONLY on the three ack/banner/count surfaces.
          const pending = (posture.pending_verification || []).filter(
            (e) => e && e.rule_id && e.since,
          );
          if (pending.length) {
            const newest = pending
              .map((e) => new Date(e.since).getTime())
              .sort((a, b) => b - a)[0];
            if (stat.mtime.getTime() < newest) {
              const ruleList = pending.map((e) => e.rule_id).join(", ");
              clearTimeout(fallback);
              process.stdout.write(
                JSON.stringify({
                  continue: true,
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    additionalContext: `⚠️ STALE RECORD — ${fp} pre-dates rule(s) ${ruleList}. Any "tests pass" / "complete" / "verified" claim within is UNVERIFIED under the new rule(s). Do not inherit conclusions; re-verify per rule before declaring readiness.`,
                  },
                }) + "\n",
              );
              process.exit(0);
            }
          }
        } catch {
          // file stat failed or no posture — fall through to passthrough
        }
      }
    }

    // NOTE: the guide-first cross-repo PreToolUse ceremony (B — journal/0488)
    // lives in validate-bash-command.js (the mcp-guard Bash tripwire), NOT here
    // — so it is CLI-neutral (mirrors to Codex shell) without reclassifying this
    // CC-only multi-event hook to mcp-guard. This hook keeps ONLY the PostToolUse
    // repo-scope advisory (below), which owns the authoritative violation row.
    return passthrough();
  }

  if (event === "PostToolUse") {
    const tool = payload.tool_name;
    const input = payload.tool_input || {};

    if (tool === "Bash") {
      const cmd = input.command || "";
      let f =
        P.detectRepoScopeDriftBash(cmd, payload.cwd) ||
        P.detectCommitClaim(cmd) ||
        // value-prioritization/MUST-4 (F-3): bash-time detection of
        // `gh issue close --reason not_planned/wontfix` — agent must
        // surface user-gate prose justification in the next response.
        P.detectGhIssueCloseAsNotPlanned(cmd);
      if (f)
        return logAndEmit(
          payload,
          event,
          f,
          `Bash command flagged: ${cmd.slice(0, 80)}`,
        );
    } else if (isMutationTool(tool)) {
      // F14 C2 iter-3 root-cause fix: route through isMutationTool() so
      // worktree-drift + probe-driven sweep also fire on MultiEdit and
      // NotebookEdit. Per autonomous-execution.md MUST Rule 4: a
      // worktree-drift bug bypassing the detector via a non-Edit/Write
      // mutation tool is the exact failure class iter-3 closes.
      const fp = input.file_path || input.filePath || input.notebook_path || "";
      const f = P.detectWorktreeDrift(fp);
      if (f)
        return logAndEmit(payload, event, f, `${tool} to ${fp.slice(0, 80)}`);
      // probe-driven-verification/MUST-1 — advisory lexical sweep on
      // test/harness file edits. Pairs with the Stop-event sweep on the
      // assistant's final report.
      const newSource =
        input.content || input.new_string || input.new_str || "";
      if (
        newSource &&
        /(\.test|tests?\/|test-harness|suites|audit-fixture)/.test(fp)
      ) {
        const probeFinding = P.detectRegexForSemanticAssertion(newSource, fp);
        if (probeFinding)
          return logAndEmit(
            payload,
            event,
            probeFinding,
            `probe-driven sweep on ${fp.slice(0, 80)}`,
          );
      }
      // F29 — value-prioritization MUST-6 verbatim-quote sweep on journal
      // entries. Fires when the edited file matches journal/NNNN-*.md. The
      // detector reads the journal from disk (reads its frontmatter +
      // body-quoted lines + cited journals' content) so this branch fires
      // post-tool, after the Edit/Write has landed on disk.
      // reviewer L2: anchor at (^|/) so journal/0154-foo.md and workspace
      // paths workspaces/x/journal/0154-foo.md both match, but a sibling
      // dir like not-a-journal/journal/0154-foo.md does NOT.
      if (fp && /(^|\/)journal\/\d{4}-.*\.md$/.test(fp)) {
        const must6Finding = P.detectMust6Paraphrase(fp);
        if (must6Finding)
          return logAndEmit(
            payload,
            event,
            must6Finding,
            `MUST-6 verbatim-quote sweep on ${fp.slice(0, 80)}`,
          );
      }
    }
    return passthrough();
  }

  if (event === "Stop") {
    const finalText = payload.transcript_path
      ? "" // POC: would read transcript; for now expect inlined text
      : payload.last_assistant_text || "";

    // Receipt token validation (Phase 2): if pending_verification non-empty
    // AND finalText lacks [ack: <rule_id>] for each pending rule
    // AND no prior acknowledgement_failure logged for this (session_id, rule_id),
    // log ack_failure (one per session per rule).
    const ackFindings = [];
    try {
      const sid =
        payload.session_id || process.env.CLAUDE_SESSION_ID || "unknown";
      const posture = readPosture(payload.cwd);
      // loom#875 — only entries still WITHIN grace drive the ack soft-gate; a
      // grace-EXPIRED entry must NOT keep emitting acknowledgement_failure on
      // every Stop event (the forever-nag this fixes). Post-grace the rule
      // stays fully enforced via the cumulative-downgrade math, which never
      // consults pending_verification.
      const pending = (posture.pending_verification || []).filter(
        (e) => e && e.rule_id && isPendingWithinGrace(e),
      );
      if (pending.length) {
        const recent = readRecentViolations(payload.cwd, { limit: 200 });
        for (const e of pending) {
          const ackPattern = new RegExp(
            "\\[ack:\\s*" +
              e.rule_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
              "\\s*\\]",
            "i",
          );
          if (ackPattern.test(finalText)) continue; // acknowledged
          const already = recent.some(
            (v) =>
              v.session_id === sid &&
              v.rule_id === `acknowledgement_failure/${e.rule_id}`,
          );
          if (already) continue;
          ackFindings.push({
            rule_id: `acknowledgement_failure/${e.rule_id}`,
            severity: "halt-and-report",
            evidence: `pending rule ${e.rule_id} not acknowledged via [ack: ${e.rule_id}] in agent response`,
          });
        }
      }
    } catch {
      // posture/violations read failed → skip ack check rather than blocking session
    }

    const findings = [
      P.detectPreExistingNoSha(finalText),
      P.detectSweepSubstitution(finalText),
      P.detectSelfConfession(finalText),
      P.detectRepoScopeDriftText(finalText),
      P.detectMenuWithoutPick(finalText),
      // probe-driven-verification/MUST-1 advisory: scan the final report for
      // test/harness code blocks the agent authored that pair regex APIs with
      // semantic-verification function names. Path argument is "Stop" (no
      // filesystem path); the detector's path filter is bypassed by passing
      // a synthetic test-shaped path so the in-prose snippets are still
      // reachable. Findings stay advisory per hook-output-discipline.md MUST-2.
      P.detectRegexForSemanticAssertion(finalText, "tests/inline-prose"),
      // time-pressure-discipline/MUST-2 advisory: scan agent's final report
      // for procedure-drop language NOT paired with a parallelization or
      // prioritization anchor. Cancels the finding when the response surfaces
      // the structural alternative the rule requires.
      P.detectTimePressureShortcut(finalText, { mode: "response" }),
      // value-prioritization MUST-1/MUST-2 advisory: the rule's Trust-Posture
      // Wiring claimed both ran on Stop, but neither was ever added to this
      // array — defined, exported and fixtured, then referenced only from
      // comments. Closed here rather than by walking the claim back, because
      // the detectors are real. A/B against the pre-edit hook, dispatched
      // through this array on a Stop payload: base emits NOTHING on all 13
      // fixtures; with these two lines all 7 flag fixtures fire and all 6
      // clean fixtures stay null.
      // SCOPE OF THAT A/B — it feeds `last_assistant_text`, so it proves the
      // DISPATCH and the detectors, and is NOT evidence about production.
      // Every Stop prose detector, these two included, sees only what the
      // handler above recovers into `finalText`: being dispatched is
      // NECESSARY for one to fire and never SUFFICIENT. Measured on this
      // branch at 48af413c, that recovery yielded "" whenever the payload
      // carried `transcript_path` (which Claude Code always sends), and the
      // 513-row violations sink held ZERO Stop-prose rows against 82
      // repo-scope-discipline/MUST-NOT-1 + 6 git/commit-message-claim-accuracy
      // from the Bash path. Recovering that text is SEPARATE work, tracked in
      // loom#1509 — read the handler above for current behaviour rather than
      // inferring it from here. Wiring these two is a prerequisite for that
      // recovery, never a substitute, which is why neither is unwired.
      // ~65us combined on a 4KB report, once per session at Stop (not per
      // tool call), so no surface-presence guard is warranted. Advisory only,
      // per hook-output-discipline.md MUST-2 (both are lexical prose scans).
      // FLAG RATE IS SELECTION-SENSITIVE — cite the selection or cite nothing.
      // Measured over journal/ on this tree: 40 MOST-RECENT entries (median
      // 7.1KB) -> 0/40 and 0/40; 40 LARGEST (median 15.1KB) -> 2/40 (5.0%)
      // streetlight and 5/40 (12.5%) deferral. Same detectors, same corpus,
      // 4/40 overlap. Longer documents give a lexical scan more surface, so
      // an unqualified "0/40" is a statement about the sample, not the
      // detectors. Both rates are advisory-only and neither gates anything.
      P.detectStreetlightSelection(finalText),
      P.detectDeferralWithoutValueAnchor(finalText),
      // value-prioritization/MUST-3 advisory (F-2): scan agent's final
      // report for deferred-item pickup language not paired with a
      // re-validation surface. Companion to detectStreetlightSelection
      // (MUST-1) and detectDeferralWithoutValueAnchor (MUST-2), both now
      // dispatched directly above; closes the silent-inheritance loophole.
      P.detectDeferredItemPickupWithoutRevalidation(finalText),
      ...ackFindings,
    ].filter(Boolean);

    if (findings.length === 0) return passthrough();

    // Stop hooks emit systemMessage (CRIT-1). Multiple findings → concatenate.
    for (const f of findings) {
      // M9.1 R3 Sec-R3-S-02 — Stop-event findings also route through
      // _logViolation for stamped-identity attribution; legacy-path
      // fallback preserved when un-rostered.
      _logViolation(payload.cwd, {
        rule_id: f.rule_id,
        severity: f.severity === "block" ? "halt-and-report" : f.severity, // Stop can't truly block
        evidence: f.evidence,
      });
    }

    clearTimeout(fallback);
    emit({
      hookEvent: "Stop",
      severity: "post-mortem",
      what_happened: `${findings.length} violation pattern(s) detected in final report`,
      why: findings.map((f) => f.rule_id).join(", "),
      agent_must_report: findings.map(
        (f) => `${f.rule_id}: ${f.evidence.slice(0, 100)}`,
      ),
      agent_must_wait: "Forensic record only — surfaced at next SessionStart.",
      user_summary: `${findings.length} post-mortem violation(s) recorded`,
    });
    return;
  }

  if (event === "UserPromptSubmit") {
    const prompt = payload.prompt || "";
    if (/\bwhy.*(broken|regress|still failing)/i.test(prompt)) {
      // Inject regression-signal context — does NOT log a violation, just primes the agent
      clearTimeout(fallback);
      process.stdout.write(
        JSON.stringify({
          continue: true,
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext:
              "USER REGRESSION SIGNAL DETECTED — before re-running, audit which test tiers actually ran in the last invocation and enumerate them explicitly in your response.",
          },
        }) + "\n",
      );
      process.exit(0);
    }
    // time-pressure-discipline/MUST-1: framing detection in user input.
    // PRIME-only (no violation log) per the rule's two-mode design — framing
    // is the trigger; the violation is the agent's procedure-drop response,
    // which is caught by the Stop-event detector with mode:"response".
    const pressureFinding = P.detectTimePressureShortcut(prompt, {
      mode: "input",
    });
    if (pressureFinding) {
      clearTimeout(fallback);
      process.stdout.write(
        JSON.stringify({
          continue: true,
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext:
              "USER TIME-PRESSURE FRAMING DETECTED (rules/time-pressure-discipline.md MUST-1) — your next response MUST: (a) acknowledge the framing in plain language, (b) propose a parallelization or prioritization-surfacing path (parallel worktree wave, parallel specialist delegation, prioritized list for human gate), NOT a procedure drop. Skipping /redteam, omitting Tier-2 regression tests, deferring in-shard same-class fixes, --no-verify, or any equivalent corner-cut is BLOCKED — even when the user explicitly authorizes the shortcut. The user's intent under pressure is throughput, not corner-cutting; satisfy it through structural means.",
          },
        }) + "\n",
      );
      process.exit(0);
    }
    return passthrough();
  }

  return passthrough();
})();
