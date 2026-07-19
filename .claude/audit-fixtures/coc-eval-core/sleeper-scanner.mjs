#!/usr/bin/env node
// Test stub for the `scanner-timeout` regression (F3). Sleeps SYNCHRONOUSLY well
// past the harness's (env-lowered) wall-clock budget, so execFileSync kills it
// with a non-numeric exit status + a signal. The harness MUST treat that as a
// HARD fail ("scanner did not exit cleanly"), never a false PASS on the pinned
// exit-1 expectation. Atomics.wait blocks without busy-spinning.
const sab = new Int32Array(new SharedArrayBuffer(4));
Atomics.wait(sab, 0, 0, 2000); // block ~2s
// Unreached under a lowered timeout; present so a clean run would exit 1.
process.exit(1);
