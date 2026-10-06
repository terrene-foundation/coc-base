/**
 * severity-rank — FIXTURE SOURCE, not a shipped module.
 *
 * A faithful-in-shape stand-in for `.claude/hooks/lib/severity-rank.js`, so the
 * canonical regression below can be pinned without depending on a live file
 * that another lane may be editing. The property that matters is the one the
 * real defect turned on: the register has FIVE entries and the lowest one comes
 * FIRST, so deleting it leaves a block that still parses and still looks whole.
 *
 * The ordering mirrors the delivery contract:
 *   block           tool call is DENIED (exit 2). Only meaningful at PreToolUse.
 *   halt-and-report tool RAN; agent must surface and wait.
 *   pre-action      PreToolUse only: NOT blocked and NOT yet run; agent decides.
 *   advisory        tool RAN; agent acknowledges and may proceed.
 *   post-mortem     forensic only (Stop-class events).
 */
const SEVERITY_RANK = Object.freeze({
  "post-mortem": 0,
  advisory: 1,
  "pre-action": 1,
  "halt-and-report": 2,
  block: 3,
});

export { SEVERITY_RANK };
