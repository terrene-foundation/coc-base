#!/usr/bin/env node
/**
 * multi-operator-sessionend — fixture runner (F51 residue; loom#2044 Group A).
 *
 * Four fixtures, four teardown predicates, ONE hook:
 * `.claude/hooks/multi-operator-sessionend.js`.
 *
 * FAMILY B — SIDE EFFECT, not disposition. The README's own last line is "Hook
 * MUST NEVER block — all four cases emit {continue: true}", so a disposition
 * assertion is satisfied by a hook that does nothing. What the `expected.txt`
 * files pin is what the hook WROTE to the coordination log: a release record, a
 * checkpoint (or deliberately NOT one), the `.session-end-cache`. Those are the
 * assertions below, sharing the scaffold in ../hook-fixture-runner.mjs.
 *
 * THE TEARDOWN MUST RUN SYNCHRONOUSLY TO BE OBSERVABLE. In production the parent
 * detaches a worker and returns (#857 latency decoupling), so the effect is not on
 * disk when the parent exits. `COC_TEST_FORCE_RELEASE` / `COC_TEST_FORCE_CHECKPOINT`
 * — which the fixtures' own `env` blocks already declare — set SYNC_TEARDOWN, and
 * that is exactly why they are in the fixtures. This runner passes them through
 * from the fixture rather than inventing them.
 *
 * A DRIFT THIS RUNNER FOUND ON ITS FIRST EXECUTION (2026-08-30). Fixture 02's
 * `expected.txt` pinned "compaction-checkpoint emitted with co_signers=[{p-bob…}]".
 * The shipped hook does NOT do that and has not since M5 iter-6 (Sec-MED-A1 / R7):
 * when a cosigner exists it emits a `checkpoint-skipped` record and routes 2-of-N
 * cosig through a separate handoff path, because the cosigner's private key lives
 * on another machine and a placeholder cosig would be either rule-5-rejected or,
 * worse, a fake attestation. The fixture was pinned to the REMOVED placeholder
 * behaviour and nothing red, because nothing executed this directory — the exact
 * F51 condition. `expected.txt` has been corrected to the shipped disposition and
 * carries a `note:` recording the drift; the assertions below pin what SHIPS.
 *
 *   node .claude/audit-fixtures/multi-operator-sessionend/run.mjs
 *   HOOK=/abs/path/to/mutant.js node .../run.mjs     # red it against a mutant
 */
import "../_lib/no-ambient-git.cjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "node:os";
import vm from "node:vm";
import { createRequire } from "node:module";
import {
  makeReporter,
  mkRepo,
  writeRoster,
  writeLog,
  driveHook,
  logPathOf,
  coverageChecks,
  readCase,
  cleanup,
} from "../hook-fixture-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const HOOK = process.env.HOOK || path.join(REPO, ".claude/hooks/multi-operator-sessionend.js");

const { check, finish } = makeReporter();

// Tier 1: controlled providers with canonical stored un-rostered rows. Signing
// and detached processes are outside this instrument's scope. All assertions
// are structural: fields, row counts, ordering and error codes.
const requireHere = createRequire(import.meta.url);
const EFFECT = "a zero-byte lease in the create/write birth window is undetermined " +
  "and releases are deferred; only an unchanged lease beyond the birth-window " +
  "age floor is reap-eligible after the tombstone witness recheck, not proof of PID death";

function callerLayout() {
  const filename = path.join(REPO, ".claude/hooks/lib/session-notes-layout.js");
  const layout = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module: layout, exports: layout.exports, process: { pid: process.pid },
    require(specifier) {
      if (["fs", "path", "crypto"].includes(specifier)) return requireHere(specifier);
      if (specifier === "child_process") return {
        execFileSync() { throw new Error("F6_LAYOUT_SUBPROCESS_FORBIDDEN"); },
        spawnSync() { throw new Error("F6_LAYOUT_SUBPROCESS_FORBIDDEN"); },
      };
      if (["./git-subprocess-env.js", "./coc-ledger.js", "./burndown-events.js"]
        .includes(specifier)) return {};
      throw new Error(`F6_UNEXPECTED_LAYOUT_DEPENDENCY:${specifier}`);
    },
  }, { filename });
  return layout.exports;
}

function exerciseCaller(lease, {
  sinkFailure = false, emitThrows = false, teardown = false,
  acquireThrows = false, stderrThrows = false,
} = {}) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "f6-caller-observation-"));
  const learningDir = path.join(repoDir, ".claude", "learning");
  fs.mkdirSync(learningDir, { recursive: true });
  const events = [];
  const learningPath = path.join(REPO, ".claude/hooks/lib/learning-utils.js");
  const learningSource = fs.readFileSync(learningPath, "utf8");
  const append = requireHere(path.join(REPO, ".claude/hooks/lib/append-sink.js"));
  const learning = { exports: {} };
  vm.runInNewContext(learningSource, {
    module: learning, exports: learning.exports, __dirname: path.dirname(learningPath),
    process: { env: { KAILASH_LEARNING_DIR: learningDir }, cwd: () => repoDir,
      stderr: { write() {} } },
    require(specifier) {
      if (specifier.endsWith("append-sink.js")) return { ...append, mainCheckoutBoundaryRoots: () => [] };
      if (specifier.endsWith("operator-id.js")) return { resolveIdentity: () => null };
      if (specifier.endsWith("coc-append.js")) return { appendStamped() { throw new Error("F6_UNEXPECTED_SIGNING"); } };
      if (["fs", "path", "crypto", "os"].includes(specifier)) {
        return requireHere(specifier);
      }
      throw new Error(`F6_UNEXPECTED_LEARNING_DEPENDENCY:${specifier}`);
    },
  }, { filename: learningPath });
  const hook = { exports: {} };
  let source = fs.readFileSync(HOOK, "utf8");
  const mutants = {
    // The performTeardown site (6-space indent); recordDegradedLease has its own.
    continuation: [
      'if (!err || err.code !== "SESSIONEND_LEASE_OBSERVATION_FAILED") throw err;\n      try {',
      'console.log("F6_MUTANT_BRANCH_REACHED:continuation"); throw err;\n      try {',
    ],
    narrowness: [
      'if (!err || err.code !== "SESSIONEND_LEASE_OBSERVATION_FAILED") throw err;\n      try {',
      'console.log("F6_MUTANT_BRANCH_REACHED:narrowness"); if (false) throw err;\n      try {',
    ],
    held: [
      'lease.liveness.state === "undetermined" ||\n        lease.liveness.tombstoneHeld === true',
      '(console.log("F6_MUTANT_BRANCH_REACHED:held"), lease.liveness.state === "undetermined")',
    ],
    duplicate: [
      "recordReleaseLeaseObservation(repoDir, identity, data);",
      'console.log("F6_MUTANT_BRANCH_REACHED:duplicate");\n' +
        "recordReleaseLeaseObservation(repoDir, identity, data);\n" +
        "recordReleaseLeaseObservation(repoDir, identity, data);",
    ],
    observation: [
      "recordReleaseLeaseObservation(repoDir, identity, data);", "void data;",
    ],
    effect: [
      "a zero-byte lease in the create/write birth window is undetermined ",
      "corrupt => dead => reap-eligible ",
    ],
    failure: ["if (!recorded) {", "if (false) {"],
    custody: [
      "data.tombstoneHeld = lease.liveness.tombstoneHeld;",
      "data.tombstoneHeld = false;",
    ],
    release: [
      "releaseReleaseLease({ verifiedId: identity.verified_id, repoDir });",
      "void identity;",
    ],
    "r2-reasons": [
      '"unsafe-lease", "unbound-lease", "custody-unobservable",', "",
    ],
    "r2-restore": [
      '"restore-copy-failed", "restore-copy-unavailable", "custody-held",', "",
    ],
    "f3-degraded": [
      'if (!err || err.code !== "SESSIONEND_LEASE_OBSERVATION_FAILED") throw err;\n    try {\n      process.stderr.write(\n        "[sessionend] degraded',
      'throw err;\n    try {\n      process.stderr.write(\n        "[sessionend] degraded',
    ],
    "f5-restored": ['"restored", "newborn-present",', '"newborn-present",'],
    "f5-restored-by-copy": ['"reap-unlink-failed", "restored-by-copy",', '"reap-unlink-failed",'],
    "f5-restore-unlink-failed": ['"restore-unlink-failed", "reap-unlink-failed",', '"reap-unlink-failed",'],
    "f6-tombstone-cleared": ['"custody-held",\n          "tombstone-cleared",', '"custody-held",'],
  };
  const mutation = process.env.F6_CALLER_MUTANT;
  if (mutation) {
    const pair = mutants[mutation];
    if (!pair || source.split(pair[0]).length !== 2) {
      throw new Error("F6_MUTATION_NOT_REACHED");
    }
    source = source.replace(pair[0], pair[1]);
    console.log(`F6_SOURCE_COPY_MUTATION_REACHED:${mutation}`);
  }
  const continuation = `
    const checkpointOriginal = emitCheckpoint;
    emitCheckpoint = (...args) => {
      callerEvents.push("checkpoint"); return checkpointOriginal(...args);
    };
    const verificationOriginal = emitVerificationCheckpoint;
    emitVerificationCheckpoint = (...args) => {
      callerEvents.push("verification"); return verificationOriginal(...args);
    };
    const notesOriginal = writeSessionNotesAtomic;
    writeSessionNotesAtomic = (...args) => {
      callerEvents.push("notes"); return notesOriginal(...args);
    };
    module.exports.performTeardown = performTeardown;
  `;
  vm.runInNewContext(source + "\nmodule.exports.releaseOwnClaims = releaseOwnClaims;" +
    (teardown ? continuation : ""), {
    module: hook, exports: hook.exports, __dirname: path.dirname(HOOK), __filename: HOOK,
    callerEvents: events,
    process: { argv: [], env: {
      COC_TEST_SKIP_SIGN: "1", COC_TEST_WRITE_SESSION_NOTES: "1",
    }, stderr: { write() {
      if (stderrThrows) throw new Error("F6_STDERR_UNAVAILABLE");
    } } },
    require(specifier) {
      if (specifier === "fs") return fs;
      if (specifier === "path") return path;
      if (specifier.endsWith("append-sink.js")) return append;
      if (specifier.endsWith("coc-emit.js")) return { emitSignedRecord() {
        events.push("emit");
        if (emitThrows) throw new Error("F6_EMIT_FAILED");
        return { ok: true };
      } };
      if (specifier.endsWith("sessionend-release-lease.js")) return {
        acquireReleaseLease() {
          events.push("acquire");
          if (acquireThrows) throw new Error("F6_ACQUIRE_FAILED");
          return lease;
        },
        releaseReleaseLease() { events.push("release"); return { ok: true }; },
      };
      if (specifier.endsWith("learning-utils.js")) return { logObservation(...args) {
        events.push("observe");
        if (sinkFailure === "throw") throw new Error("F6_SINK_FAILED");
        return sinkFailure ? null : learning.exports.logObservation(...args);
      } };
      if (specifier.endsWith("coordination-log.js")) return {
        foldLog(records) { return { accepted: records, rejected: [] }; },
      };
      if (specifier.endsWith("fold-record-limits.js")) return requireHere(specifier);
      if (specifier.endsWith("checkpoint-emitter.js")) return {
        maybeEmitCheckpoint() { return { emitted: false, reason: "threshold is unmet" }; },
      };
      if (specifier.endsWith("coordination-mode.js")) return {
        isCoordinationEnabled() { return true; },
      };
      if (specifier.endsWith("session-notes-layout.js")) return callerLayout();
      throw new Error(`F6_UNEXPECTED_DEPENDENCY:${specifier}`);
    },
  }, { filename: HOOK });
  let error = null;
  try {
    const identity = { verified_id: "SHA256:fixture", person_id: "fixture" };
    if (teardown) {
      fs.writeFileSync(path.join(learningDir, "coordination-log.jsonl"),
        JSON.stringify({ type: "claim", verified_id: identity.verified_id,
          content: { claim_id: "fixture-claim" } }) + "\n");
      hook.exports.performTeardown(repoDir, identity);
    } else {
      hook.exports.releaseOwnClaims(repoDir, identity, [{ claim_id: "fixture-claim" }]);
    }
  } catch (err) { error = err; }
  const sink = path.join(learningDir, "observations.jsonl");
  const rows = fs.existsSync(sink) ? fs.readFileSync(sink, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  const read = relative => {
    const file = path.join(repoDir, relative);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  };
  const notes = read(".session-notes.d/fixture.md");
  const ledger = read(".session-notes.shared.md");
  fs.rmSync(repoDir, { recursive: true, force: true });
  return { events, error, rows, notes, ledger };
}

console.log("\n=== F6: Tier-1 caller observations with canonical stored-row readback ===");
for (const reason of [
  "corrupt-lease", "unreadable-lease", "token-format-unverified",
  "unsafe-lease", "unbound-lease", "custody-unobservable",
]) {
  const r = exerciseCaller({ ok: false, reason: "contended", liveness: {
    state: "undetermined", reason, age_ms: 10, floor_ms: 900000,
    tombstoneHeld: true, restore_reason: "newborn-present",
  } });
  check(`F6_${reason}_DURABLE`, r.rows.length === 1 && r.rows[0].type === "coordination_degradation" &&
    r.rows[0].data.degradation === "release-lease-undetermined" && r.rows[0].data.reason === reason,
    `stored rows=${r.rows.length}`, "F6_UNDETERMINED_OBSERVATION_MISSING");
  check(`F6_${reason}_DEFER`, r.events.join(",") === "acquire,observe" && !r.error,
    r.events.join(","), "F6_UNDETERMINED_RELEASE_EMITTED");
  check(`F6_${reason}_AGE`, r.rows[0]?.data.age_ms === 10 && r.rows[0]?.data.floor_ms === 900000,
    JSON.stringify(r.rows[0]?.data), "F6_FINITE_AGE_METADATA_MISSING");
  check(`F6_${reason}_CUSTODY`, r.rows[0]?.data.tombstoneHeld === true &&
    r.rows[0]?.data.restore_reason === "newborn-present",
    JSON.stringify(r.rows[0]?.data), "F6_HELD_TOMBSTONE_TAGS_MISSING");
}
{
  const r = exerciseCaller({ ok: false, reason: "contended", liveness: { state: "alive", reason: "token-verified" } });
  check("F6_LIVE_NO_OBSERVATION", r.rows.length === 0 && r.events.join(",") === "acquire" && !r.error,
    r.events.join(","), "F6_HEALTHY_CONTENTION_FALSE_DEGRADATION");
}
{
  const r = exerciseCaller({ ok: false, reason: "contended", holder: { holder_pid: 123 }, liveness: {
    state: "undetermined", reason: "private-path", age_ms: Infinity, floor_ms: -1, heldTombstone: "/private/fixture",
  } });
  check("F6_BOUNDED_METADATA", r.rows.length === 1 && r.rows[0].data.reason === "unknown" &&
    !Object.hasOwn(r.rows[0].data, "age_ms") && !Object.hasOwn(r.rows[0].data, "floor_ms") &&
    !JSON.stringify(r.rows[0].data).includes("private"), JSON.stringify(r.rows[0]?.data), "F6_UNBOUNDED_PAYLOAD");
}
for (const sinkFailure of [true, "throw"]) {
  const r = exerciseCaller({ ok: false, reason: "contended", liveness: {
    state: "undetermined", reason: "corrupt-lease",
  } }, { sinkFailure });
  const label = sinkFailure === "throw" ? "THROW" : "NULL";
  check(`F6_${label}_SINK_SIGNAL`, r.error?.code === "SESSIONEND_LEASE_OBSERVATION_FAILED" &&
    r.events.join(",") === "acquire,observe", r.error?.code || "no-error", "F6_OBSERVATION_FAILURE_DISCARDED");
}
for (const sinkFailure of [false, true]) {
  const r = exerciseCaller({ ok: true, degraded: "no-hardlink-support" }, { sinkFailure });
  // The lease is HELD on a degraded filesystem, so a failed breadcrumb never
  // costs the releases (base behaviour): they are emitted either way.
  check(`F6_DEGRADED_${sinkFailure ? "FAILURE" : "EFFECT"}`, sinkFailure
    ? !r.error && r.rows.length === 0 && r.events.join(",") === "acquire,observe,emit,release"
    : r.rows.length === 1 && r.rows[0].data.effect === EFFECT && r.events.join(",") === "acquire,observe,emit,release",
    `events=${r.events.join(",")} effect=${r.rows[0]?.data.effect} error=${r.error?.code}`, "F6_DEGRADED_EFFECT_OR_RELEASE_WRONG");
}
{
  const r = exerciseCaller({ ok: true }, { emitThrows: true });
  check("F6_RELEASE_ON_EMIT_THROW", r.error?.message === "F6_EMIT_FAILED" && r.events.join(",") === "acquire,emit,release",
    r.events.join(","), "F6_ACQUIRED_LEASE_NOT_RELEASED");
}
for (const [state, restore_reason] of [
  ["alive", "restore-link-failed"], ["dead", "reap-unlink-failed"],
  ["alive", "restore-copy-failed"], ["alive", "restore-copy-unavailable"],
  ["alive", "custody-held"], ["alive", "restore-unlink-failed"],
]) {
  const r = exerciseCaller({ ok: false, reason: "contended", liveness: {
    state, reason: "token-verified", tombstoneHeld: true, restore_reason,
    heldTombstone: "/private/fixture-held-lease",
  } });
  check(`R2_S3_${state}_${restore_reason}_DURABLE`, r.rows.length === 1 &&
    r.rows[0].data.degradation === "release-lease-held-tombstone",
    `stored rows=${r.rows.length}`, "R2_HELD_CUSTODY_OBSERVATION_MISSING");
  check(`R2_S3_${state}_${restore_reason}_BOUNDED`, r.rows[0]?.data.reason === "unknown" &&
    r.rows[0]?.data.tombstoneHeld === true &&
    r.rows[0]?.data.restore_reason === restore_reason &&
    !JSON.stringify(r.rows).includes("fixture-held-lease"),
    JSON.stringify(r.rows[0]?.data), "R2_HELD_CUSTODY_PAYLOAD_WRONG");
  check(`R2_S3_${state}_${restore_reason}_DEFER`, !r.error && r.events.join(",") === "acquire,observe",
    r.events.join(","), "R2_HELD_CUSTODY_RELEASE_NOT_DEFERRED");
}
for (const restore_reason of ["restored", "restored-by-copy", "tombstone-cleared"]) {
  const r = exerciseCaller({ ok: false, reason: "contended", liveness: {
    state: "undetermined", reason: "unbound-lease", tombstoneHeld: false, restore_reason,
  } });
  check(`F5_undetermined_${restore_reason}_TAGGED`, r.rows.length === 1 &&
    r.rows[0].data.degradation === "release-lease-undetermined" &&
    r.rows[0].data.restore_reason === restore_reason && r.rows[0].data.tombstoneHeld === false,
    JSON.stringify(r.rows[0]?.data), "F5_RESTORE_REASON_DROPPED");
}
for (const degraded of [false, true]) {
  for (const sinkFailure of [true, "throw"]) {
    const label = `${degraded ? "DEGRADED" : "CONTENDED"}_${sinkFailure === true ? "NULL" : "THROW"}`;
    const lease = degraded ? { ok: true, degraded: "no-hardlink-support" } : {
      ok: false, reason: "contended", liveness: {
        state: "undetermined", reason: "corrupt-lease",
      },
    };
    const r = exerciseCaller(lease, { teardown: true, sinkFailure, stderrThrows: true });
    const expected = "acquire,observe," + (degraded ? "emit,release," : "") +
      "checkpoint,verification,notes";
    check(`R2_M2_${label}_CONTINUE`, !r.error && r.events.join(",") === expected,
      `${r.events.join(",")} error=${r.error?.code}`, "R2_TEARDOWN_CONTINUATION_MISSING");
    check(`R2_M2_${label}_NOTES`, r.notes?.startsWith("# Session Notes (fixture)") &&
      r.ledger?.includes("Forest Ledger"),
      `fragment=${r.notes !== null} ledger=${r.ledger !== null}`, "R2_ATOMIC_NOTES_MISSING");
    // Contended: releases deferred. Degraded: the lease is held, so they go out.
    check(`R2_M2_${label}_${degraded ? "EMIT" : "DEFER"}`,
      r.events.includes("emit") === degraded && r.rows.length === 0,
      r.events.join(","), "R2_FAILED_RELEASE_REPORTED_SUCCESS");
  }
}
{
  const r = exerciseCaller({ ok: true }, { teardown: true, acquireThrows: true });
  check("R2_M2_UNRELATED_ERROR_PROPAGATES", r.error?.message === "F6_ACQUIRE_FAILED" &&
    r.events.join(",") === "acquire" && r.notes === null && r.ledger === null,
    `${r.events.join(",")} error=${r.error?.message}`, "R2_BOUNDARY_CATCH_TOO_BROAD");
}
{
  const r = exerciseCaller({ ok: false, reason: "contended", liveness: {
    state: "dead", reason: "esrch", tombstoneHeld: false,
  } });
  check("R2_S3_NO_CUSTODY_QUIET", r.rows.length === 0 && !r.error &&
    r.events.join(",") === "acquire", r.events.join(","), "R2_FALSE_CUSTODY_OBSERVATION");
}
if (process.env.F6_CALLER_OBSERVATIONS_ONLY === "1") finish();

const FIXTURES = [
  "01-release-claims",
  "02-checkpoint-cosigner",
  "03-degenerate-genuine-genesis",
  "04-blocked-R9-S-02",
];

const SETUPS = {
  "01-release-claims": {
    why: "coord_log_seed carries ONE own active claim (verified_id == the operator under test). COC_TEST_FORCE_RELEASE makes the teardown synchronous so the appended release is on disk when this runner reads it.",
  },
  "02-checkpoint-cosigner": {
    why: "roster with TWO human owners → derived-N=2, so the N>=2 ladder short-circuits eligibility AND findOwnerCosigner resolves p-bob. The shipped disposition is checkpoint-SKIPPED with a forensic record, not a self-signed checkpoint carrying a placeholder cosig.",
  },
  "03-degenerate-genuine-genesis": {
    why: "roster with ONE human owner and an EMPTY log → no attestation history for the R9-S-02 fence to trace, and no cosigner to coordinate with, so the degenerate self-sign is permitted.",
  },
  "04-blocked-R9-S-02": {
    why: "the SAME single-owner roster as 03; only the log moves — a settled attestation→revocation pair. The fence must trace that history and refuse the self-sign, so this pair isolates the fence from the roster shape.",
  },
};

const FP = "SHA256:alice-test-fingerprint";
const PID = "p-alice";

function readLog(repoDir) {
  const p = logPathOf(repoDir);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function envFrom(fixtureEnv) {
  // The fixture's own `env` block IS the seam declaration; pass it through rather
  // than re-deriving which flags this path needs.
  return { COC_TEST_FINGERPRINT: FP, COC_TEST_PERSON_ID: PID, ...(fixtureEnv || {}) };
}

function stage(label, { roster, seed }) {
  const repoDir = mkRepo(label);
  requireHere("node:child_process").execFileSync("git", [
    "-C", repoDir, "config", "--local", "user.signingkey", "",
  ]);
  if (roster) writeRoster(repoDir, roster);
  writeLog(repoDir, seed || []);
  return repoDir;
}

function drive(repoDir, env) {
  return driveHook(HOOK, {
    stdinRaw: JSON.stringify({ hook_event_name: "Stop", cwd: repoDir }),
    cwd: repoDir,
    env: { CLAUDE_PROJECT_DIR: repoDir, ...env },
  });
}

console.log(`\nhook under test : ${HOOK}`);

{
  const repoDir = stage("key-config-control", { seed: [] });
  const childProcess = requireHere("node:child_process");
  const gitEnv = requireHere(path.join(
    REPO, ".claude/hooks/lib/git-subprocess-env.js",
  ));
  const gitBin = gitEnv.resolveGitBinary();
  if (!gitBin) throw new Error("F6_CONFIG_GIT_UNAVAILABLE");
  const readKeyConfig = () => {
    const inv = gitEnv.gitConfigInvocation([
      "-C", repoDir, "config", "--get", "user.signingkey",
    ]);
    return childProcess.execFileSync(gitBin, inv.args, {
      env: inv.env, encoding: "utf8",
    }).trim();
  };
  check("F6_CONFIG_PROFILE_EMPTY", readKeyConfig() === "", "local key empty",
    "F6_AMBIENT_KEY_FALLBACK_REACHED");
  childProcess.execFileSync(gitBin, [
    "-C", repoDir, "config", "--local", "user.signingkey", "fixture-selector",
  ]);
  check("F6_CONFIG_PROFILE_OPPOSITE", readKeyConfig() === "fixture-selector",
    "private nonempty control", "F6_CONFIG_CONTROL_DID_NOT_DISCRIMINATE");
  childProcess.execFileSync(gitBin, [
    "-C", repoDir, "config", "--local", "user.signingkey", "",
  ]);
  check("F6_CONFIG_PROFILE_RESTORED", readKeyConfig() === "", "local key empty",
    "F6_KEY_NEUTRALIZATION_NOT_RESTORED");
}
if (process.env.F6_CALLER_CONFIG_ONLY === "1") {
  cleanup();
  finish();
}

console.log("\n=== T1: every fixture on disk is driven by this runner ===");
coverageChecks(check, HERE, FIXTURES, SETUPS);

console.log("\n=== T2: drive each fixture against the REAL hook and read what it WROTE ===");
for (const name of FIXTURES) {
  const c = readCase(HERE, name);
  const seed = c.input.coord_log_seed || [];
  const repoDir = stage(name.slice(0, 2), { roster: c.input.roster, seed });
  const r = drive(repoDir, envFrom(c.input.env));
  const rows = readLog(repoDir);
  const added = rows.slice(seed.length);

  console.log(`\n  -- ${name} [harness setup: ${SETUPS[name].why}]`);

  check(
    `${name}: continue=true (the hook NEVER blocks)`,
    r.code === 0 && r.json !== null && r.json.continue === true,
    `exit=${r.code} continue=${r.json ? r.json.continue : "<unparseable>"}`,
    "a refusal = a Stop-event teardown has started gating the session, which the README declares out of contract on all four branches",
  );

  if (name === "01-release-claims") {
    const rel = added.filter((x) => x.type === "release");
    check(
      `${name}: exactly one release record for claim_id=my-claim-1`,
      rel.length === 1 && rel[0].content.claim_id === "my-claim-1",
      `release rows=${rel.length} claim_id=${rel[0] && rel[0].content && rel[0].content.claim_id}`,
      "no release = the operator's claims linger to TTL and every sibling is blocked on paths nobody is working; a release for the wrong claim_id releases work still in flight",
    );
    check(
      `${name}: release is chained onto the operator's OWN chain (seq advances, prev_hash set)`,
      rel.length === 1 && rel[0].seq === 1 && typeof rel[0].prev_hash === "string" && rel[0].prev_hash.length > 0,
      `seq=${rel[0] && rel[0].seq} prev_hash=${rel[0] && String(rel[0].prev_hash).slice(0, 12)}`,
      "a reused seq or null prev_hash = the per-emitter chain forks and fold rule-3 frames the operator as an equivocator (the #868 equivocation class); an unchained release is rule-2-rejected and the claim is never actually released",
    );
    const cachePath = path.join(repoDir, ".claude", "learning", ".session-end-cache");
    check(
      `${name}: .session-end-cache caches the released claim_id list`,
      fs.existsSync(cachePath) &&
        JSON.parse(fs.readFileSync(cachePath, "utf8")).released_claim_ids.includes("my-claim-1"),
      fs.existsSync(cachePath) ? fs.readFileSync(cachePath, "utf8").trim() : "(absent)",
      "an absent cache = next session cannot reconcile a release whose record failed to append, so a claim released in intent stays active in the log with nothing recording that it should not be",
    );
  }

  if (name === "02-checkpoint-cosigner") {
    const skipped = added.filter((x) => x.type === "checkpoint-skipped");
    check(
      `${name}: NO self-signed compaction-checkpoint is emitted when a cosigner exists`,
      added.filter((x) => x.type === "compaction-checkpoint").length === 0,
      `compaction-checkpoint rows=${added.filter((x) => x.type === "compaction-checkpoint").length}`,
      "an emitted checkpoint here = a one-sided hook signed a 2-of-N attestation whose second key lives on another machine — either rule-5-rejected at fold, or worse, a checkpoint that READS as cosigned and is not (the Sec-MED-A1 / R7 defect whose removal this row pins)",
    );
    check(
      `${name}: a checkpoint-skipped record names the reason and the cosigner`,
      skipped.length === 1 &&
        skipped[0].content.reason === "cosigner-coordination-required" &&
        skipped[0].content.cosigner_person_id === "p-bob",
      `skipped rows=${skipped.length} reason=${skipped[0] && skipped[0].content.reason} cosigner=${skipped[0] && skipped[0].content.cosigner_person_id}`,
      "a SILENT skip = the operator sees neither a checkpoint nor any signal one was skipped, which is indistinguishable from the hook never running (R8-LOW-1); a wrong cosigner_person_id sends the handoff to the wrong owner",
    );
    check(
      `${name}: the skip is also surfaced on stderr for the operator`,
      /cosigner coordination required/.test(r.stderr),
      `stderr names the skip`,
      "absent = the forensic record exists but nothing tells the operator at the time; observability.md Rule 7 is the general form",
    );
  }

  if (name === "03-degenerate-genuine-genesis") {
    const cps = added.filter((x) => x.type === "compaction-checkpoint");
    check(
      `${name}: exactly one compaction-checkpoint, marked degenerate="single-owner"`,
      cps.length === 1 && cps[0].content.degenerate === "single-owner",
      `checkpoint rows=${cps.length} degenerate=${cps[0] && cps[0].content.degenerate}`,
      "no checkpoint = a genuine single-owner genesis can never compact its log, so every fold re-verifies every signature forever; a checkpoint WITHOUT the degenerate marker is a self-signed attestation that does not declare itself self-signed",
    );
    check(
      `${name}: the degenerate checkpoint carries NO co_signers`,
      cps.length === 1 && Array.isArray(cps[0].content.co_signers) && cps[0].content.co_signers.length === 0,
      `co_signers=${JSON.stringify(cps[0] && cps[0].content.co_signers)}`,
      "a populated co_signers on a single-owner roster is a fabricated attestation — it names a cosigner who did not sign and could not have",
    );
  }

  if (name === "04-blocked-R9-S-02") {
    check(
      `${name}: NO new checkpoint record of any kind is appended`,
      added.filter((x) => String(x.type).includes("checkpoint")).length === 0,
      `new rows=${added.length} (${added.map((x) => x.type).join(",") || "none"})`,
      "an emitted checkpoint = the R9-S-02 fence did not trace the settled distinctness revocation, so a roster that LOOKS single-owner because its second collaborator was revoked can self-sign its own compaction — the sock-puppet path the fence exists to close",
    );
  }
}

// ---- T3: PAIRED CONTROLS ------------------------------------------------------
//
// Every row above is consistent with degenerate hooks: one that writes nothing
// satisfies 02 and 04; one that always writes a checkpoint satisfies 03. Each
// control flips exactly one element and requires the side effect to MOVE.
console.log("\n=== T3: paired controls — flip one setup element, require the side effect to move ===");

const OWNER = (fp) => ({ role: "owner", host_role: "human", keys: [{ fingerprint: fp }] });
const ONE_OWNER = { persons: { "p-alice": OWNER("SHA256:alice") } };
const TWO_OWNERS = {
  persons: { "p-alice": OWNER("SHA256:alice"), "p-bob": OWNER("SHA256:bob") },
};
const RELEASE_ENV = { COC_TEST_SKIP_SIGN: "1", COC_TEST_FORCE_RELEASE: "1" };
const CHECKPOINT_ENV = { COC_TEST_SKIP_SIGN: "1", COC_TEST_FORCE_CHECKPOINT: "1" };
const CLAIM = {
  type: "claim",
  verified_id: FP,
  person_id: PID,
  seq: 0,
  ts: "2026-05-20T11:00:00Z",
  content: { claim_id: "my-claim-1", path: "src/foo.js" },
  sig: "stub",
};

{
  // C1 — 01's release is attributable to the CLAIM in the log, not to the Stop
  // event. Same env on both arms; only the seed moves.
  const empty = stage("c1a", { seed: [] });
  drive(empty, envFrom(RELEASE_ENV));
  const noClaim = readLog(empty).filter((x) => x.type === "release").length;
  const seeded = stage("c1b", { seed: [CLAIM] });
  drive(seeded, envFrom(RELEASE_ENV));
  const withClaim = readLog(seeded).filter((x) => x.type === "release").length;
  check(
    "C1: same Stop + same env — no own claim ⇒ 0 releases / one own claim ⇒ 1 release",
    noClaim === 0 && withClaim === 1,
    `empty-log releases=${noClaim} | seeded releases=${withClaim}`,
    "identical counts = findOwnActiveClaims carries no information. Always releasing writes release records for claims that do not exist; never releasing leaves every session's claims to expire on TTL and blocks siblings for the full window.",
  );
}

{
  // C2 — 02's SKIP is attributable to the SECOND OWNER in the roster. Same empty
  // log, same env; only the roster's person count moves.
  const one = stage("c2a", { roster: ONE_OWNER, seed: [] });
  drive(one, envFrom(CHECKPOINT_ENV));
  const oneRows = readLog(one);
  const two = stage("c2b", { roster: TWO_OWNERS, seed: [] });
  drive(two, envFrom(CHECKPOINT_ENV));
  const twoRows = readLog(two);
  check(
    "C2: same empty log — ONE owner ⇒ compaction-checkpoint / TWO owners ⇒ checkpoint-skipped",
    oneRows.filter((x) => x.type === "compaction-checkpoint").length === 1 &&
      oneRows.filter((x) => x.type === "checkpoint-skipped").length === 0 &&
      twoRows.filter((x) => x.type === "compaction-checkpoint").length === 0 &&
      twoRows.filter((x) => x.type === "checkpoint-skipped").length === 1,
    `one-owner: ${oneRows.map((x) => x.type).join(",") || "none"} | two-owner: ${twoRows.map((x) => x.type).join(",") || "none"}`,
    "identical outcomes = findOwnerCosigner is not consulted. Self-signing on the TWO-owner arm is a one-sided hook attesting a 2-of-N checkpoint; skipping on the ONE-owner arm means a genuine solo genesis can never compact.",
  );
}

{
  // C3 — 04's REFUSAL is attributable to the ATTESTATION HISTORY. Same single-owner
  // roster on both arms; only the log's distinctness records move.
  const clean = stage("c3a", { roster: ONE_OWNER, seed: [] });
  drive(clean, envFrom(CHECKPOINT_ENV));
  const cleanCps = readLog(clean).filter((x) => x.type === "compaction-checkpoint").length;
  const history = [
    {
      type: "collaborator-distinctness-attestation",
      verified_id: "SHA256:alice",
      person_id: PID,
      seq: 0,
      ts: "2026-01-01T00:00:00Z",
      content: { github_login: "bob" },
      sig: "stub",
    },
    {
      type: "collaborator-distinctness-revocation",
      verified_id: "SHA256:alice",
      person_id: PID,
      seq: 1,
      ts: "2026-02-01T00:00:00Z",
      content: { github_login: "bob" },
      sig: "stub",
    },
  ];
  const fenced = stage("c3b", { roster: ONE_OWNER, seed: history });
  drive(fenced, envFrom(CHECKPOINT_ENV));
  const fencedCps = readLog(fenced).slice(history.length).filter((x) => x.type === "compaction-checkpoint").length;
  check(
    "C3: same single-owner roster — no attestation history ⇒ checkpoint / settled revocation in the log ⇒ NO checkpoint",
    cleanCps === 1 && fencedCps === 0,
    `clean checkpoints=${cleanCps} | with-history checkpoints=${fencedCps}`,
    "identical outcomes = the R9-S-02 fence never reads the log. Emitting on the HISTORY arm lets an operator who attested then revoked a collaborator self-sign their own compaction as though they were a genuine solo genesis; refusing on the CLEAN arm blocks every legitimate single-owner repo.",
  );
}

{
  // C4 — every side effect above is gated on the FORCE flag, i.e. on the teardown
  // path this hook actually runs. Without this row, an unconditional writer and a
  // correctly-gated one are indistinguishable, and the whole suite could be green
  // against a hook that writes a checkpoint on every Stop regardless of eligibility.
  const repoDir = stage("c4", { roster: ONE_OWNER, seed: [CLAIM] });
  const r = drive(repoDir, envFrom({ COC_TEST_SKIP_SIGN: "1" }));
  const rows = readLog(repoDir).slice(1);
  check(
    "C4: neither FORCE flag set ⇒ Stop returns continue:true having appended NOTHING",
    r.code === 0 && r.json?.continue === true && rows.length === 0,
    `exit=${r.code} new rows=${rows.length} (${rows.map((x) => x.type).join(",") || "none"})`,
    "records appended here = the teardown is unconditional and the other rows' greens are attributable to the Stop event rather than to the eligibility ladder each fixture names",
  );
}

cleanup();
finish();
