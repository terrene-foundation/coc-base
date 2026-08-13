/**
 * severity-rank — order hook findings by SEVERITY, so POSITION stops determining
 * PRECEDENCE.
 *
 * ── THE DEFECT CLASS THIS EXISTS TO CLOSE (loom#1606, S22/S23)
 *
 * A multi-branch validator that returns from the FIRST branch to match is ordered
 * by TOPIC, not by SEVERITY. Every earlier, weaker verdict then suppresses every
 * later, stronger one — and because `instruct-and-wait.js` returns
 * `{continue: true}` / exit 0 for EVERY non-`block` severity, a weaker verdict is
 * not merely mis-labelled: the tool call RUNS.
 *
 * The class was first enumerated in `validate-bash-command.js`, where six
 * non-block returns sit above two irrecoverable `git reset --hard` /
 * `git clean -f` fences.
 *
 * THAT FILE IS NOT FIXED BY THIS MODULE, AND DOES NOT IMPORT IT. Stated here
 * because an adversarial review found the earlier wording ("the canonical
 * instance is validate-bash-command.js") readable as a claim that this module
 * had closed it — which would leave the next maintainer treating a fence as
 * built when it is not. Its repair is a separate lane (loom#1606 guard4 /
 * PR #1609). It also carries a POLARITY INVERSION this module does not address:
 * `detectRepoScopeDriftBash` returns null when an authorizing receipt EXISTS, so
 * an AUTHORIZED cross-repo command falls through and is fenced normally, while
 * an UNAUTHORIZED one short-circuits and disables every fence below it — the
 * less legitimate the command, the weaker the enforcement.
 *
 * The shape this module DOES fix was MEASURED in `detect-violations.js`, whose
 * PostToolUse Bash branch was a `a || b || c` chain:
 *
 *   git commit -m "removed the dead handler" && gh issue close 42 --reason not_planned
 *     detectCommitClaim                -> advisory          (evaluated FIRST)
 *     detectGhIssueCloseAsNotPlanned   -> halt-and-report   (never reached)
 *     chain emitted                    -> advisory
 *
 * Both detectors fire independently on that one string; neither regex excludes
 * the other's span. Only the weaker fired, and only ONE `violations.jsonl` row
 * was written — naming the WRONG rule, which also undercounts the
 * `trust-posture.md` MUST-4 cumulative window.
 *
 * ── THE SHAPE THAT FIXES IT
 *
 * Collect every finding, then select ONE severity at a SINGLE exit. Adding a
 * deferral variable to a positional chain is what produced the dead-code
 * advisory in `validate-bash-command.js`'s first repair attempt; ranking at one
 * exit is the only shape under which the invariant actually holds.
 *
 * `detect-violations.js`'s own Stop branch already used this shape — collect into
 * an array, log every finding, emit once. This module lifts that idiom out so the
 * PostToolUse branches (and any future guard) can share it.
 */

/**
 * Higher rank = more restrictive = wins selection.
 *
 * The ordering mirrors `instruct-and-wait.js`'s severity contract:
 *   block           tool call is DENIED (exit 2). Only meaningful at PreToolUse.
 *   halt-and-report tool RAN; agent must surface and wait.
 *   advisory        tool RAN; agent acknowledges and may proceed.
 *   post-mortem     forensic only (Stop-class events).
 */
const SEVERITY_RANK = Object.freeze({
  "post-mortem": 0,
  advisory: 1,
  "halt-and-report": 2,
  block: 3,
});

/**
 * An unrecognized severity string is a PROGRAMMING ERROR in a detector, and the
 * disposition is deliberately asymmetric — it is NOT `security.md`
 * § Enforcement-Surface Parity's "unrecognized ranks TIGHTEST", and the deviation
 * is named rather than left to be inferred:
 *
 *   - It must NOT rank at or below `advisory`, or a typo'd severity would be
 *     silently outranked and dropped — the very under-reporting this module
 *     exists to prevent.
 *   - It must NOT rank as `block`, because promoting an unknown string to a
 *     DENY would let a typo deny tool calls, and `hook-output-discipline.md`
 *     MUST-2 reserves `block` for structural signals a detector has actually
 *     established.
 *
 * So it ranks WITH `halt-and-report`: never dropped, never escalated to a deny.
 * Ties keep source order (see `mostRestrictive`), so a known `halt-and-report`
 * appearing earlier still wins and behaviour is unchanged for correct input.
 */
const UNKNOWN_RANK = SEVERITY_RANK["halt-and-report"];

/**
 * Rank of a severity string. Unknown/missing -> UNKNOWN_RANK (see above).
 */
function rankOf(severity) {
  return Object.prototype.hasOwnProperty.call(SEVERITY_RANK, severity)
    ? SEVERITY_RANK[severity]
    : UNKNOWN_RANK;
}

/**
 * Select the MOST RESTRICTIVE finding from a list.
 *
 * STABLE BY CONSTRUCTION: strictly-greater comparison means ties keep SOURCE
 * ORDER, so when every finding shares one severity the winner is the one the old
 * positional chain would have picked. That is what makes this a safe drop-in —
 * the behaviour only changes where the old order was actually inverted.
 *
 * @param {Array<{severity?: string}|null|undefined>} findings
 * @returns {object|null} the winning finding, or null when none are truthy
 */
function mostRestrictive(findings) {
  let best = null;
  let bestRank = -1;
  for (const f of Array.isArray(findings) ? findings : []) {
    if (!f) continue;
    const r = rankOf(f.severity);
    if (r > bestRank) {
      best = f;
      bestRank = r;
    }
  }
  return best;
}

/**
 * Compact a detector list to the findings that actually fired, preserving order.
 */
function compactFindings(findings) {
  return (Array.isArray(findings) ? findings : []).filter(Boolean);
}

/**
 * Coerce a severity to a value `instruct-and-wait.js` actually RECOGNIZES.
 *
 * RANKING AN UNKNOWN SEVERITY IS NOT ENOUGH, and the gap was found by an
 * adversarial review of this module: `instruct-and-wait.js`'s head ternary tests
 * `block` / `halt-and-report` / `post-mortem` and falls through to ADVISORY for
 * anything else. So a typo'd severity ranked at UNKNOWN_RANK here was still
 * DELIVERED to the agent as "ADVISORY — the action proceeded" — the exact
 * silent-weakening this module exists to prevent, one layer down. Ranking is
 * about SELECTION; this is about DELIVERY, and both halves are required.
 *
 * It also hardens the consumer against a crash: `instruct-and-wait.js` calls
 * `severity.toUpperCase()`, so a finding with a missing or non-string severity
 * threw a TypeError inside an async IIFE that has no `.catch()` — AFTER
 * `clearTimeout` had disarmed the 5s fallback. The hook died delivering NO
 * verdict at all, which is strictly worse than delivering a weak one.
 *
 * Not reachable from today's detectors (all six use recognized string literals),
 * so this is a contract being enforced rather than a live exploit being closed.
 */
function normalizeSeverity(severity) {
  return Object.prototype.hasOwnProperty.call(SEVERITY_RANK, severity)
    ? severity
    : "halt-and-report";
}

module.exports = {
  SEVERITY_RANK,
  UNKNOWN_RANK,
  rankOf,
  mostRestrictive,
  compactFindings,
  normalizeSeverity,
};
