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
const { appendViolation, readPosture, readRecentViolations } = require(
  path.join(__dirname, "lib", "state-io.js"),
);
const P = require(path.join(__dirname, "lib", "violation-patterns.js"));

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

function logAndEmit(payload, event, finding, what_happened) {
  appendViolation(payload.cwd, {
    rule_id: finding.rule_id,
    severity: finding.severity,
    evidence: finding.evidence,
    posture_at_time: process.env.CLAUDE_CURRENT_POSTURE || "unknown",
    addressed_by: null,
  });

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
    return passthrough();
  }

  if (event === "PostToolUse") {
    const tool = payload.tool_name;
    const input = payload.tool_input || {};

    if (tool === "Bash") {
      const cmd = input.command || "";
      let f =
        P.detectRepoScopeDriftBash(cmd, payload.cwd) ||
        P.detectCommitClaim(cmd);
      if (f)
        return logAndEmit(
          payload,
          event,
          f,
          `Bash command flagged: ${cmd.slice(0, 80)}`,
        );
    } else if (tool === "Edit" || tool === "Write") {
      const fp = input.file_path || "";
      const f = P.detectWorktreeDrift(fp);
      if (f)
        return logAndEmit(
          payload,
          event,
          f,
          `Edit/Write to ${fp.slice(0, 80)}`,
        );
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
      const pending = (posture.pending_verification || []).filter(
        (e) => e && e.rule_id,
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
      ...ackFindings,
    ].filter(Boolean);

    if (findings.length === 0) return passthrough();

    // Stop hooks emit systemMessage (CRIT-1). Multiple findings → concatenate.
    for (const f of findings) {
      appendViolation(payload.cwd, {
        rule_id: f.rule_id,
        severity: f.severity === "block" ? "halt-and-report" : f.severity, // Stop can't truly block
        evidence: f.evidence,
        posture_at_time: process.env.CLAUDE_CURRENT_POSTURE || "unknown",
        type: "post-mortem",
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
    return passthrough();
  }

  return passthrough();
})();
