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
const { mostRestrictive, normalizeSeverity, rankOf } = require(
  path.join(__dirname, "lib", "severity-rank.js"),
);
const { isMutationTool } = require(
  path.join(__dirname, "lib", "tool-classes.js"),
);

// --- Stop-event final-text recovery -------------------------------------
//
// EXTRACTED to lib/transcript-read.js (loom#1798). It lived here as a private
// function in a file with zero exports, so the newer Stop guard could not
// import it and reimplemented the 512KB tail window and the 60-entry walk-back
// from scratch. Two copies of a measured constant drift silently, and the guard
// left on the stale window reads a truncated slice and reports CLEAN.
//
// The rationale for every guard in that reader (the single-resolution open, the
// O_NOFOLLOW/O_NONBLOCK pair, the fail-soft-but-never-silent WARN, and the
// measurements the two constants come from) moved WITH the code.
const { readFinalAssistantText, warnTranscriptRecovery } = require(
  path.join(__dirname, "lib", "transcript-read.js"),
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

// `logAndEmit` (single-finding) was deleted rather than kept as a shim: after
// both call sites moved to `logAllAndEmit` it had no caller, and an unreferenced
// helper is exactly the orphan `zero-tolerance.md` Rule 2 blocks. Single-finding
// callers pass a one-element array.

/**
 * Log EVERY finding, then emit ONE verdict at the MOST RESTRICTIVE severity.
 *
 * loom#1606 (S23/DP-3) — this replaces the `a || b || c` chains that used to sit
 * in the PostToolUse branches. Those were ordered by TOPIC, so the first detector
 * to fire decided both the emitted severity and the single logged row. MEASURED
 * on one command string that satisfies two detectors independently:
 *
 *   git commit -m "removed the dead handler" && gh issue close 42 --reason not_planned
 *     detectCommitClaim               advisory          (first in the chain)
 *     detectGhIssueCloseAsNotPlanned  halt-and-report   (never evaluated)
 *     emitted                         advisory
 *
 * Two independent defects followed from that one `||`:
 *   1. SEVERITY INVERSION — `halt-and-report` ("surface this and wait") was
 *      delivered as `advisory` ("acknowledge and proceed").
 *   2. UNDERCOUNTED POSTURE MATH — one row was written where two rules were
 *      violated, and it named the WRONG rule, so `trust-posture.md` MUST-4's
 *      cumulative window (3x same-rule / 5x total in 30d) counted neither
 *      correctly.
 *
 * Fixing (1) alone would have left (2), which is why every finding is logged
 * rather than only the winner. This mirrors the Stop branch below, which already
 * logged each finding and emitted once.
 *
 * THE DESCRIPTION TRAVELS WITH THE WINNER, and that is not cosmetic. The first
 * version of this function ranked the SEVERITY but took `what_happened` from
 * whichever detector happened to run last — re-introducing "position decides"
 * one field over. An adversarial review MEASURED the consequence on a `block`:
 *
 *   Write, worktree-pinned, to a main-checkout journal with an unverified ref
 *     emitted: [BLOCK] worktree-isolation/MUST-1, value-prioritization/MUST-6
 *     WHAT HAPPENED: MUST-6 verbatim-quote sweep on 0154-x.md   <- the ADVISORY's
 *
 * On a `block` the call is DENIED and `permissionDecisionReason` is the agent's
 * only channel, so it was told its write was blocked because of a quote sweep —
 * it would fix the quote and retry the drifted write. Each finding therefore
 * carries its OWN descriptor, and the emitted one is the WINNER's.
 *
 * @param entries [{finding, what}] — descriptor paired with the finding it describes
 */
/**
 * Neutralize a ledger-write error before it reaches the agent or the terminal.
 *
 * THE MESSAGE IS PARTIALLY ATTACKER-CHOSEN. `lib/state-io.js` interpolates
 * `fs.realpathSync(dir)` — a symlink TARGET — into its containment refusal, and a
 * POSIX filename may hold any byte but `/` and NUL, INCLUDING newlines and ANSI
 * escapes. Unsanitized it lands in `agent_must_report`, where a newline lets a
 * chosen path forge additional instruction bullets in the agent's context, and on
 * a `block` verdict `instruct-and-wait.js` writes that text RAW to stderr.
 *
 * Control characters collapse to spaces and the result is capped, which is the
 * discipline every sibling descriptor in this file already follows (`cmd.slice(0,
 * 80)`, `fp.slice(0, 80)`, `evidence.slice(0, 100)`).
 */
function sanitizeLedgerError(err) {
  // Codepoint test rather than a regex character class: the escape sequences a
  // control-character class needs are themselves fragile in transit, and a
  // literal control byte in this source would make ugrep classify the whole file
  // as binary and silently skip it (measured — that is how this line was caught).
  const raw = String((err && err.message) || String(err)).slice(0, 200);
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0);
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out;
}

function logAllAndEmit(payload, event, entries) {
  const live = (Array.isArray(entries) ? entries : []).filter(
    (e) => e && e.finding,
  );
  if (live.length === 0) return passthrough();

  // Every finding gets its own row — one violated rule, one record.
  //
  // EACH ROW IS WRITTEN IN ISOLATION, AND A FAILED WRITE NEVER SUPPRESSES THE
  // VERDICT. This guard is required BY the collect-then-emit shape above it, not
  // incidental to it: `_logViolation` ends in a bare `appendViolation` call that
  // sits OUTSIDE its own try/catch (the catch closes on the `resolveIdentity`
  // path above), `appendViolation` throws on a containment refusal, ENOTREGULAR,
  // or a short write (`lib/state-io.js`), and the async IIFE driving this hook
  // has no `.catch()`. Logging N findings before ONE emit therefore turned one
  // throw opportunity ahead of the verdict into N — so a ledger write for an
  // ADVISORY could kill the process before a `block` was ever delivered, and the
  // agent would see no verdict at all. That is strictly worse than the severity
  // inversion this function exists to fix: it is the same fail-open, one layer
  // down, reached by a WEAKER finding suppressing a STRONGER one.
  //
  // The failure is carried INTO the emit rather than swallowed — `zero-tolerance.md`
  // Rule 3 — because a missing `violations.jsonl` row silently undercounts
  // `trust-posture.md` MUST-4's cumulative window.
  const findings = live.map((e) => e.finding);
  const ledgerFailures = [];
  for (const f of findings) {
    try {
      _logViolation(payload.cwd, f);
    } catch (err) {
      ledgerFailures.push(`${f.rule_id}: ${sanitizeLedgerError(err)}`);
    }
  }

  // ONE verdict, selected by severity rather than by position. Ties keep source
  // order, so a single-finding call is byte-identical to the old behaviour.
  const winner = mostRestrictive(findings);
  const winnerEntry = live.find((e) => e.finding === winner) || live[0];
  const what_happened = winnerEntry.what;
  const ruleIds = findings.map((f) => f.rule_id).join(", ");
  // Normalized so an unrecognized severity cannot be silently rendered as
  // ADVISORY by instruct-and-wait's fall-through, nor crash it on a non-string.
  let severity = normalizeSeverity(winner.severity);

  // A FAILED LEDGER WRITE IS ITSELF A FINDING, AND IT FLOORS THE VERDICT.
  // The throws `appendViolation` raises are not I/O noise: a containment refusal
  // (a symlinked ancestor on the state dir), ENOTREGULAR, and ELOOP each mean
  // something is PLANTED at the audit sink (`lib/state-io.js`). That is
  // deterministic process/filesystem state — the class
  // `hook-output-discipline.md` MUST-2 names as strong-signal — and delivering it
  // under an ADVISORY head ("the action proceeded; acknowledge in next message")
  // would reproduce THIS function's own defect one layer down: the weakest
  // verdict in the room suppressing the strongest signal. An attacker who can
  // divert the trust ledger must not also choose how loudly that is announced.
  //
  // FLOOR, never a ceiling: it only ever raises, and it stops at
  // `halt-and-report` rather than `block` because PostToolUse has ALREADY run the
  // tool — a deny would withhold nothing and `hook-output-discipline.md` MUST-2
  // reserves `block` for a structural signal about the call being gated.
  if (
    ledgerFailures.length > 0 &&
    rankOf(severity) < rankOf("halt-and-report")
  ) {
    severity = "halt-and-report";
  }

  clearTimeout(fallback);
  emit({
    hookEvent: event,
    severity,
    what_happened,
    why: ruleIds,
    agent_must_report: [
      "Quote the exact text/command that triggered the detection",
      "State which rule was violated and its origin evidence date",
      "Propose remediation in this turn (do not file a follow-up issue)",
      ...(live.length > 1
        ? [
            `${live.length} rules fired on this one action. The severity and description above belong to the MOST RESTRICTIVE (${winner.rule_id}); the others also fired and MUST be reported: ` +
              live
                .filter((e) => e.finding !== winner)
                .map((e) => `${e.finding.rule_id} (${e.what})`)
                .join("; "),
          ]
        : []),
      ...(ledgerFailures.length
        ? [
            `LEDGER WRITE FAILED for ${ledgerFailures.length} of ${findings.length} finding(s) — the violations.jsonl row(s) are MISSING, so \`trust-posture.md\` MUST-4's cumulative window will UNDERCOUNT until they are reconstructed. The verdict above still stands. Report verbatim: ${ledgerFailures.join("; ")}`,
          ]
        : []),
    ],
    agent_must_wait:
      "Do not retry or proceed with related work until the user instructs.",
    user_summary: `${ruleIds} — ${String(what_happened).slice(0, 60)}`,
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
      // COLLECT, then rank — never `||`. One command can satisfy several of
      // these independently (none of the patterns excludes another's span), and
      // under the old chain the earliest-listed detector silenced the rest.
      const what = `Bash command flagged: ${cmd.slice(0, 80)}`;
      const bashEntries = [
        { finding: P.detectRepoScopeDriftBash(cmd, payload.cwd), what },
        { finding: P.detectCommitClaim(cmd), what },
        // value-prioritization/MUST-4 (F-3): bash-time detection of
        // `gh issue close --reason not_planned/wontfix` — agent must
        // surface user-gate prose justification in the next response.
        { finding: P.detectGhIssueCloseAsNotPlanned(cmd), what },
        // git.md § Discipline: a `gh issue close` claiming COMPLETED must cite
        // a commit SHA / PR number / merged-PR link in its comment. Sibling of
        // the row above — that one asks whether a NOT-completed disposition was
        // justified, this one whether a completed one carries any evidence.
        { finding: P.detectGhIssueCloseWithoutEvidence(cmd), what },
      ];
      if (bashEntries.some((e) => e.finding))
        return logAllAndEmit(payload, event, bashEntries);
    } else if (isMutationTool(tool)) {
      // F14 C2 iter-3 root-cause fix: route through isMutationTool() so
      // worktree-drift + probe-driven sweep also fire on MultiEdit and
      // NotebookEdit. Per autonomous-execution.md MUST Rule 4: a
      // worktree-drift bug bypassing the detector via a non-Edit/Write
      // mutation tool is the exact failure class iter-3 closes.
      const fp = input.file_path || input.filePath || input.notebook_path || "";
      // COLLECT, then rank (loom#1606 S23/DP-3). `detectWorktreeDrift` is the
      // only `block` here and happened to be listed first, so this branch had no
      // live SEVERITY inversion — but it returned on the first hit, so a drifted
      // write to a test file logged the drift row and SILENTLY DISCARDED the
      // probe row. Same undercount as the Bash branch, one topic over. Ranking
      // makes the ordering correct BY CONSTRUCTION rather than by the accident
      // of which detector was listed first.
      // Each entry carries the descriptor for ITS OWN finding, so the emitted
      // `what_happened` is the winner's rather than the last writer's.
      const mutationEntries = [
        {
          finding: P.detectWorktreeDrift(fp),
          what: `${tool} to ${fp.slice(0, 80)}`,
        },
      ];
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
          mutationEntries.push({
            finding: probeFinding,
            what: `probe-driven sweep on ${fp.slice(0, 80)}`,
          });
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
          mutationEntries.push({
            finding: must6Finding,
            what: `MUST-6 verbatim-quote sweep on ${fp.slice(0, 80)}`,
          });
      }
      // deploy-hygiene/9a — whole-context `COPY` in a Dockerfile. Gated on the
      // BASENAME inside the detector (structural, read off this tool call), so
      // no path pre-filter is duplicated here: one owner for the predicate.
      if (newSource) {
        const copyFinding = P.detectDockerfileWholeContextCopy(fp, newSource);
        if (copyFinding)
          mutationEntries.push({
            finding: copyFinding,
            what: `positive-COPY sweep on ${fp.slice(0, 80)}`,
          });
      }
      if (mutationEntries.some((e) => e.finding))
        return logAllAndEmit(payload, event, mutationEntries);
    }
    return passthrough();
  }

  if (event === "Stop") {
    // Prefer the payload's inline text when present; otherwise recover it from
    // the transcript. This ordering is correct under BOTH payload shapes, so it
    // needs no knowledge of which one the CLI actually emits.
    let finalText =
      (typeof payload.last_assistant_text === "string" &&
        payload.last_assistant_text) ||
      "";
    if (!finalText) {
      const recovered = readFinalAssistantText(payload.transcript_path);
      finalText = recovered.text;
      // Only warn when a transcript was actually OFFERED and yielded nothing —
      // a Stop payload carrying neither shape is the ordinary no-op, not a
      // detector blind spot.
      if (!recovered.text && recovered.reason) {
        warnTranscriptRecovery(recovered.reason);
      }
    }

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
    //
    // GUARDED PER ROW FOR THE SAME REASON `logAllAndEmit` IS. This loop is the
    // idiom that function was lifted from, and it carries the identical hazard:
    // N unguarded `_logViolation` calls ahead of ONE emit, in an async IIFE with
    // no `.catch()`, where `_logViolation` ends in a bare `appendViolation` that
    // throws on a containment refusal, ENOTREGULAR, or a short write. A symlink
    // planted at `violations.jsonl` would delete the ENTIRE post-mortem verdict
    // for the session — every finding, not just the unwritable one. Hardening one
    // copy and leaving its twin is exactly the enforcement-surface asymmetry
    // `security.md` § Enforcement-Surface Parity blocks.
    const stopLedgerFailures = [];
    for (const f of findings) {
      // M9.1 R3 Sec-R3-S-02 — Stop-event findings also route through
      // _logViolation for stamped-identity attribution; legacy-path
      // fallback preserved when un-rostered.
      try {
        _logViolation(payload.cwd, {
          rule_id: f.rule_id,
          severity: f.severity === "block" ? "halt-and-report" : f.severity, // Stop can't truly block
          evidence: f.evidence,
        });
      } catch (err) {
        stopLedgerFailures.push(`${f.rule_id}: ${sanitizeLedgerError(err)}`);
      }
    }

    clearTimeout(fallback);
    emit({
      hookEvent: "Stop",
      severity: "post-mortem",
      what_happened: `${findings.length} violation pattern(s) detected in final report`,
      why: findings.map((f) => f.rule_id).join(", "),
      agent_must_report: [
        ...findings.map((f) => `${f.rule_id}: ${f.evidence.slice(0, 100)}`),
        // Severity stays `post-mortem` — Stop withholds nothing, so there is no
        // verdict to floor (unlike `logAllAndEmit`). The failure is still
        // surfaced: an unwritable audit sink means the next SessionStart replay
        // is INCOMPLETE, not clean.
        ...(stopLedgerFailures.length
          ? [
              `LEDGER WRITE FAILED for ${stopLedgerFailures.length} of ${findings.length} finding(s) — those rows are MISSING from violations.jsonl, so the next SessionStart replay and \`trust-posture.md\` MUST-4's cumulative window will UNDERCOUNT. Report verbatim: ${stopLedgerFailures.join("; ")}`,
            ]
          : []),
      ],
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
