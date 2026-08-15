#!/usr/bin/env node
/*
 * Fixture runner for .claude/codex-templates/bin/coc dispatcher.
 *
 * Exercises 8 fixture cases against the dispatcher with a stubbed `codex`
 * binary on PATH (so the dispatcher's forward to `codex exec --json ...`
 * does not require a real OpenAI Codex CLI install in CI). Asserts the
 * exit code and the first line of stderr/stdout against the expected
 * shape declared per-case.
 *
 *   node .claude/audit-fixtures/codex-dispatcher/run.mjs
 *
 * Exit 0 = all fixtures behaved as expected; 1 = a regression.
 *
 * Regression guards:
 * - 04-valid-phase-argv-nontty exercises CRIT H-1 (argv-first precedence
 *   in non-TTY contexts; was silently failing pre-R2 when stdin probe
 *   fired ahead of argv check).
 * - 08-traversal-rejected exercises HIGH S-1 (phase-name validation
 *   rejects path-separator + shell-meta before path construction).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const DISPATCHER = path.resolve(REPO_ROOT, ".claude/codex-templates/bin/coc");

// Build a stub `codex` binary into a temp dir we will prepend to PATH.
// The stub prints a deterministic marker line on stdout and exits 0, so
// every case that successfully reaches `exec codex exec ...` produces
// the marker and exits 0; cases that exit before exec produce the
// dispatcher's own error/usage text without the marker.
// PER-INVOCATION temp dir, NOT a fixed path under HERE. It was
// `path.join(HERE, ".tmp-stub")` — a single shared location that every
// concurrent invocation wrote to, while `setupStub()` unconditionally
// `rmSync`'d it and `teardownStub()` deleted it at exit. Two instances
// running at once therefore destroyed each other's stub: measured 6/6
// trials, exactly one of two concurrent runs failing every time, with
// the loser crashing at case 07 (`ln` hits EEXIST, the `cp` fallback
// then aborts with "are identical (not copied)" and throws out of
// `execFileSync`). Nothing in the tooling runs two instances today —
// `registration-preflight` uses `--closure-only`, which returns before
// the execution loop — so this was latent, not active. It is fixed
// because parallel gate work is the direction of travel.
//
// `mkdtempSync` rather than a pid suffix: pids collide across containers
// and are reused after wraparound, so a pid-named dir is only probably
// unique. `mkdtempSync` is collision-free by construction.
const STUB_DIR = mkdtempSync(path.join(tmpdir(), "coc-dispatcher-stub-"));
const STUB_PATH = path.join(STUB_DIR, "codex");

// Teardown MUST survive the abnormal-exit path. `teardownStub()` is called
// after the case loop, so any throw inside the loop skipped it and leaked
// the directory — a per-invocation dir that leaks is a slower version of
// the same problem. `exit` fires on normal return AND after an uncaught
// exception; the signal handlers cover Ctrl-C / SIGTERM, which do not.
let stubRemoved = false;
function removeStubDir() {
  if (stubRemoved) return;
  stubRemoved = true;
  try {
    rmSync(STUB_DIR, { recursive: true, force: true });
  } catch {
    // Best-effort: the dir is under the OS temp root, so a failure here
    // leaks one empty directory rather than corrupting the repo.
  }
}
process.on("exit", removeStubDir);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    removeStubDir();
    process.exit(130);
  });
}

function setupStub() {
  writeFileSync(
    STUB_PATH,
    [
      "#!/usr/bin/env bash",
      "echo \"STUB_CODEX_FORWARDED: $*\"",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(STUB_PATH, 0o755);
}
function teardownStub() {
  removeStubDir();
}

function run(args, { input, tty } = {}) {
  // We deliberately do NOT pipe stdin when input is undefined; spawnSync
  // inherits no tty in child processes by default, which is what we want
  // to reproduce the non-TTY context the H-1 fix addresses.
  const env = { ...process.env, PATH: `${STUB_DIR}:${process.env.PATH}` };
  const opts = {
    cwd: REPO_ROOT,
    env,
    encoding: "utf-8",
    timeout: 5_000,
  };
  if (input !== undefined) opts.input = input;
  const r = spawnSync("bash", [DISPATCHER, ...args], opts);
  return {
    status: r.status ?? -1,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
  };
}

// Each case: { name, args, input?, expectExit, expectStdoutMatch?,
//              expectStderrMatch?, description }
const CASES = [
  {
    name: "01-no-args",
    args: [],
    expectExit: 2,
    expectStderrMatch: /^Usage:/,
    description: "no args → exit 2 with usage on stderr",
  },
  {
    name: "02-invalid-phase",
    args: ["bogus", "test prompt"],
    expectExit: 3,
    expectStderrMatch: /^ERROR: schema file .* not found/,
    description: "valid-shape but unknown phase → exit 3 with schema-not-found",
  },
  {
    name: "03-valid-phase-argv-tty",
    args: ["analyze", "test prompt"],
    expectExit: 0,
    expectStdoutMatch: /^STUB_CODEX_FORWARDED: exec --json --output-schema=.*analyze\.schema\.json/,
    description: "valid phase + argv prompt → forwards to codex exec",
  },
  {
    name: "04-valid-phase-argv-nontty",
    args: ["analyze", "test prompt"],
    input: "", // empty stdin; reproduces non-TTY shape that surfaced H-1
    expectExit: 0,
    expectStdoutMatch: /^STUB_CODEX_FORWARDED: exec --json --output-schema=.*analyze\.schema\.json -c project_doc_max_bytes=65536 -- test prompt$/,
    description: "REGRESSION GUARD for H-1: argv wins over empty stdin in non-TTY context",
  },
  {
    name: "05-piped-stdin",
    args: ["analyze"],
    input: "piped prompt body",
    expectExit: 0,
    expectStdoutMatch: /^STUB_CODEX_FORWARDED: exec --json --output-schema=.*analyze\.schema\.json -c project_doc_max_bytes=65536 -- piped prompt body$/,
    description: "no argv + piped stdin → stdin used as prompt",
  },
  {
    name: "06-empty-prompt",
    args: ["analyze"],
    input: "   \n  ", // whitespace-only stdin
    expectExit: 2,
    expectStderrMatch: /^ERROR: prompt is empty/,
    description: "whitespace-only stdin → exit 2 'prompt is empty'",
  },
  {
    name: "07-phase-suffix-shim",
    // Simulate phase-suffix shim by invoking through a symlink-like
    // basename-resolving wrapper. We create a temp symlink to the
    // dispatcher named `coc-analyze` and invoke it; bash $0 carries the
    // symlink name, so SELF_NAME=coc-analyze triggers the basename branch.
    args: ["test prompt via shim"],
    via: "coc-analyze",
    expectExit: 0,
    expectStdoutMatch: /^STUB_CODEX_FORWARDED: exec --json --output-schema=.*analyze\.schema\.json -c project_doc_max_bytes=65536 -- test prompt via shim$/,
    description: "basename-driven phase via coc-analyze symlink",
  },
  {
    name: "08-traversal-rejected",
    args: ["../../foo", "test"],
    expectExit: 2,
    expectStderrMatch: /^ERROR: invalid phase '\.\.\/\.\.\/foo'/,
    description: "REGRESSION GUARD for S-1: phase-name path-traversal rejected before path construction",
  },
];

setupStub();

let failures = 0;
for (const c of CASES) {
  let result;
  if (c.via) {
    // Build a phase-suffix shim symlink (or copy on platforms without symlinks)
    const shim = path.join(STUB_DIR, c.via);
    if (existsSync(shim)) rmSync(shim);
    try {
      // Use a symlink so basename(argv[0]) == "coc-analyze"
      execFileSync("ln", ["-s", DISPATCHER, shim]);
    } catch {
      // Fallback: cp + chmod (still preserves basename)
      execFileSync("cp", [DISPATCHER, shim]);
      chmodSync(shim, 0o755);
    }
    const env = { ...process.env, PATH: `${STUB_DIR}:${process.env.PATH}` };
    const r = spawnSync(shim, c.args, {
      cwd: REPO_ROOT,
      env,
      encoding: "utf-8",
      timeout: 5_000,
    });
    result = {
      status: r.status ?? -1,
      stdout: (r.stdout || "").trim(),
      stderr: (r.stderr || "").trim(),
    };
    rmSync(shim);
  } else {
    result = run(c.args, { input: c.input });
  }

  const exitOk = result.status === c.expectExit;
  const stdoutOk = c.expectStdoutMatch ? c.expectStdoutMatch.test(result.stdout) : true;
  const stderrOk = c.expectStderrMatch ? c.expectStderrMatch.test(result.stderr) : true;

  if (exitOk && stdoutOk && stderrOk) {
    console.log(`  PASS  ${c.name} — ${c.description}`);
  } else {
    failures++;
    console.error(`  FAIL  ${c.name} — ${c.description}`);
    if (!exitOk) console.error(`        expected exit ${c.expectExit}, got ${result.status}`);
    if (!stdoutOk) console.error(`        stdout did not match ${c.expectStdoutMatch}\n        stdout: ${result.stdout}`);
    if (!stderrOk) console.error(`        stderr did not match ${c.expectStderrMatch}\n        stderr: ${result.stderr}`);
  }
}

teardownStub();

if (failures > 0) {
  console.error(`\n${failures} of ${CASES.length} cases FAILED`);
  process.exit(1);
} else {
  console.log(`\nAll ${CASES.length} cases PASSED`);
  process.exit(0);
}
