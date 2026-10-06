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

import "../_lib/no-ambient-git.cjs";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireRepoClass } from "../_lib/repo-class.mjs";

// `.claude/codex-templates/` is loom-internal emitter SOURCE and is deliberately
// NOT distributed — `sync-manifest.yaml` lists the whole tree under `obsoleted:`
// ("loom-internal Codex emitter SOURCE tree … NEVER belongs on a consumer
// surface"), so every consumer is actively purged of it. The dispatcher is
// EMITTED from here into each USE template's `.codex/bin/coc` at Gate 2; no
// consumer repo hosts the source this suite exercises.
//
// Gated on repo CLASS, not on dispatcher existence — at loom, a missing
// dispatcher must still fail loudly rather than skip. (Unlike its sibling
// suites this one would not ERR_MODULE_NOT_FOUND: it spawns the dispatcher
// rather than importing it, so a consumer got eight bash-not-found FAILs — a
// false regression report, which is the same defect wearing a louder mask.)
requireRepoClass(
  ["coc-source"],
  "the Codex phase dispatcher lives in .claude/codex-templates/, loom-internal emitter source that is declared obsoleted for every consumer and never synced.",
);

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

// PATH the dispatcher runs under. Single definition: when this was built inline
// at each call site, the two sites were free to drift, and they did.
function stubEnv() {
  return { ...process.env, PATH: `${STUB_DIR}:${process.env.PATH}` };
}

/*
 * HERMETICITY GATE. The whole fixture rests on `codex` resolving to OUR stub,
 * and nothing checked that it did. A real OpenAI Codex CLI is a normal
 * developer install (`/opt/homebrew/bin/codex` on the machine this was written
 * on), so if the stub is ever not first on PATH — or is written non-executable,
 * or the temp dir is culled — the dispatcher reaches the REAL binary.
 *
 * MEASURED, with the stub deliberately made non-executable: the real CLI is
 * invoked and OPENS A LIVE API SESSION — `{"type":"thread.started",...}` then a
 * 400 from the model endpoint. So the un-hermetic path does not merely produce
 * a wrong verdict; it makes NETWORK CALLS UNDER THE DEVELOPER'S CREDENTIALS
 * from what is supposed to be an offline fixture, and would do so in CI on any
 * runner with the CLI installed.
 *
 * Its exit code is NOT reliably non-zero either: withholding the stub entirely
 * produced exit 0 with `Reading additional input from stdin...`, while the
 * non-executable-stub mutation produced exit 1. An exit-code assertion
 * therefore cannot be relied on to catch this, and a case with no
 * `expectStdoutMatch` would pass outright.
 *
 * So assert resolution BEFORE any case runs, and fail LOUD and attributed.
 */
function assertStubShadowsRealCodex() {
  const r = spawnSync("bash", ["-c", "command -v codex"], {
    env: stubEnv(),
    encoding: "utf-8",
    timeout: HANG_FENCE_MS,
  });
  const resolved = (r.stdout || "").trim();
  if (resolved !== STUB_PATH) {
    console.error(
      "FATAL: `codex` does not resolve to this fixture's stub.\n" +
        `        expected: ${STUB_PATH}\n` +
        `        resolved: ${resolved || "(nothing — no codex on PATH)"}\n` +
        "        Every forwarding case would then exercise whatever binary DID resolve.\n" +
        "        A real Codex CLI opens a live API session here, so this would surface as\n" +
        "        a confusing stdout mismatch rather than as the setup failure it is.",
    );
    teardownStub();
    process.exit(1);
  }
}

/*
 * SELF-NORMALIZING HANG FENCE (supersedes the absolute 5s, then 30s bound).
 *
 * The bound exists to stop a HANG, and no case here asserts anything about
 * duration — so it must not red on machine speed. An absolute cliff does
 * exactly that: at 5s it fired on a real run (`7p/1f 8c 5.6s` — the 5s firing
 * plus ~0.6s for the other seven cases).
 *
 * 30s is far safer but is still a fixed number chosen against one machine. This
 * calibrates instead: time a trivial `bash -c :` spawn — the same fork+exec
 * machinery every case pays — and scale from it, keeping 30s as a FLOOR so this
 * can never be TIGHTER than the bound it replaces. On a fast idle box the floor
 * governs; on a box slow enough that a bare spawn costs >300ms the fence widens
 * with it.
 *
 * A genuine hang is unbounded, so any finite multiple still catches it — which
 * is the property that makes this a fence and not a performance assertion. It
 * is legitimate here precisely because the workload is FIXED SIZE: 8 cases,
 * constant argv, constant schema. There is no input dimension along which a
 * super-linear regression could hide behind a wider bound.
 *
 * MEASURED on the authoring machine: a bare spawn costs ~5-10ms idle and ~100ms
 * at load average 174, against a per-case cost of ~26ms idle / ~140ms at that
 * same load — the absolute numbers move ~5x while the RATIO stays flat, which
 * is exactly why the ratio and not the absolute is the right bound.
 */
const HANG_FENCE_FLOOR_MS = 30_000;
function calibrateHangFence() {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    spawnSync("bash", ["-c", ":"], { encoding: "utf-8", timeout: 60_000 });
    samples.push(Date.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  // 100x a bare spawn. The dispatcher does a handful of forks plus a git
  // rev-parse, measured at ~3-6x a bare spawn, so 100x leaves >15x headroom
  // over the observed worst case while still bounding a true hang.
  return { fence: Math.max(HANG_FENCE_FLOOR_MS, median * 100), median };
}
const { fence: HANG_FENCE_MS, median: SPAWN_BASELINE_MS } = calibrateHangFence();

/*
 * One bounded spawn for BOTH call sites, returning the full disposition.
 *
 * `status: r.status ?? -1` collapsed three distinct outcomes — clean non-zero
 * exit, killed by signal, and failed-to-spawn — into the single token `-1`, so
 * the fence firing reported only "expected exit 0, got -1" with empty stdout.
 * That is the message a reader gets at the exact moment they most need to know
 * WHETHER THE PROCESS WAS KILLED, and it is why the original occurrence could
 * not be diagnosed from its output. Keep the signal, the spawn error and the
 * elapsed time, and let the caller print them.
 */
function spawnBounded(cmd, args, extraOpts = {}) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    env: stubEnv(),
    encoding: "utf-8",
    timeout: HANG_FENCE_MS,
    ...extraOpts,
  });
  const elapsedMs = Date.now() - t0;
  // `error.code === "ETIMEDOUT"` is how node reports the fence firing; a signal
  // with no error is an external kill. They are different findings.
  const timedOut = Boolean(r.error && r.error.code === "ETIMEDOUT");
  return {
    status: r.status ?? -1,
    signal: r.signal || null,
    spawnError: r.error ? String(r.error.code || r.error.message) : null,
    timedOut,
    killed: r.status === null,
    elapsedMs,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
  };
}

/** Human-readable cause, printed only when a case fails. */
function describeDisposition(r) {
  if (r.timedOut) {
    return `KILLED BY THE HANG FENCE after ${r.elapsedMs}ms (fence ${HANG_FENCE_MS}ms, calibrated from a ${SPAWN_BASELINE_MS}ms bare spawn). The process did not exit on its own — this is NOT a dispatcher behaviour finding.`;
  }
  if (r.killed) {
    return `KILLED by signal ${r.signal || "(unknown)"} after ${r.elapsedMs}ms — not a non-zero exit.`;
  }
  if (r.spawnError) {
    return `FAILED TO SPAWN after ${r.elapsedMs}ms: ${r.spawnError}`;
  }
  return `exited ${r.status} after ${r.elapsedMs}ms`;
}

function run(args, { input } = {}) {
  // We deliberately do NOT pipe stdin when input is undefined; spawnSync
  // inherits no tty in child processes by default, which is what we want
  // to reproduce the non-TTY context the H-1 fix addresses.
  const extra = {};
  if (input !== undefined) extra.input = input;
  return spawnBounded("bash", [DISPATCHER, ...args], extra);
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
    expectStdoutMatch: /^STUB_CODEX_FORWARDED: exec --json --output-schema=.*analyze\.schema\.json -c project_doc_max_bytes=65536[\s\S]*## Task\n\ntest prompt$/,
    description: "REGRESSION GUARD for H-1: argv wins over empty stdin in non-TTY context",
  },
  {
    name: "05-piped-stdin",
    args: ["analyze"],
    input: "piped prompt body",
    expectExit: 0,
    expectStdoutMatch: /^STUB_CODEX_FORWARDED: exec --json --output-schema=.*analyze\.schema\.json -c project_doc_max_bytes=65536[\s\S]*## Task\n\npiped prompt body$/,
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
    expectStdoutMatch: /^STUB_CODEX_FORWARDED: exec --json --output-schema=.*analyze\.schema\.json -c project_doc_max_bytes=65536[\s\S]*## Task\n\ntest prompt via shim$/,
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
assertStubShadowsRealCodex();

let failures = 0;
for (const c of CASES) {
  let result;
  if (c.via) {
    // Build a phase-suffix shim symlink (or copy on platforms without symlinks)
    const shim = path.join(STUB_DIR, c.via);
    if (existsSync(shim)) rmSync(shim);
    try {
      // Use a symlink so basename(argv[0]) == "coc-analyze"
      execFileSync("ln", ["-s", DISPATCHER, shim], { timeout: HANG_FENCE_MS });
    } catch {
      // Fallback: cp + chmod (still preserves basename)
      execFileSync("cp", [DISPATCHER, shim], { timeout: HANG_FENCE_MS });
      chmodSync(shim, 0o755);
    }
    // Routed through the SAME bounded spawn as every other case.
    //
    // This branch does NOT go through `run()` — case 07 builds its own shim and
    // spawns it directly — so raising only the `run()` bound left THIS site on
    // exactly the cliff that site's own comment declared unsafe. Demonstrated,
    // not argued: under a deterministic stall injected at case 07, a tree with
    // only the `run()` bound raised still FAILS 07 while passing 03.
    //
    // loom#1777 fixed that by pinning the same literal at both sites. This goes
    // one step further and removes the DIVERGENCE rather than re-synchronising
    // it: one helper owns the fence, so a future change to it cannot leave a
    // sibling site behind (`security.md` § Multi-Site Kwarg Plumbing, in its
    // general form — the sibling left unqualified ships the exact failure mode
    // the fix exists to close). The two `execFileSync` calls above carried NO
    // timeout at all; they are fenced now too.
    result = spawnBounded(shim, c.args);
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
    // Print the DISPOSITION before the assertion deltas. When the fence fires,
    // "expected exit 0, got -1" is true but useless; the reader needs to know
    // the process was killed rather than that the dispatcher returned -1.
    console.error(`        disposition: ${describeDisposition(result)}`);
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
