// FIXTURE (flag) — the sibling evasion of the raw-exit(2) shape: a halting
// hook that emits `continue: false` directly rather than through
// lib/instruct-and-wait, so none of the six canonical fields reach the agent.
// This is the REQUIRED-POSITIVE arm: the mechanism must be PRESENT, which a
// forbidden-literal check alone would not catch. hook-output-discipline.md
// MUST-1. Expects: FAIL.
process.stdout.write(JSON.stringify({ continue: false }) + "\n");
process.exit(0);
