#!/usr/bin/env node
/**
 * adjacency-heartbeat — fixture runner (F51 residue; loom#2044 Group A).
 *
 * Three fixtures, three predicates, ONE guard: `.claude/hooks/adjacency-heartbeat.js`.
 *
 * FAMILY B — SIDE EFFECT, not disposition. Every fixture here pins `continue:true`
 * (the hook NEVER blocks), so a disposition-shaped assertion would be satisfied by
 * a guard that does nothing at all. What the `expected.txt` files actually pin is
 * what the hook WROTE: "MUST create cache + append heartbeat record", "log size
 * MUST be unchanged", "final heartbeat with session_end_intent=true". Those are the
 * assertions below. They share the scaffold in ../hook-fixture-runner.mjs (repo,
 * driving, env hygiene, coverage, SUMMARY) and supply their own predicates.
 *
 * WHAT WAS UNEXECUTED. This directory held three `input.json` + `expected.txt`
 * pairs and no `run.mjs`, so it sat outside run-audit-fixtures.mjs's closure.
 * `tests/integration/multi-operator/m5-b2-lifecycle-hooks.test.js` drives the hook
 * and is registered in ci-suites.json; THIS CORPUS was inert.
 *
 * THE `cache_state` FIELD IS A DECLARATION, NOT A FILE. Each `input.json` names the
 * cache state its predicate requires ("absent", "last_heartbeat_ms = (now - 5_000)")
 * in prose. The harness materializes it — including the `verified_id` field, which
 * is LOAD-BEARING: `readCache` rejects a cache belonging to a different operator, so
 * a cache written without it would be discarded and fixture 02 would append a
 * heartbeat and fail for a HARNESS reason rather than a guard one.
 *
 *   node .claude/audit-fixtures/adjacency-heartbeat/run.mjs
 *   HOOK=/abs/path/to/mutant.js node .../run.mjs     # red it against a mutant
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  makeReporter,
  mkRepo,
  driveHook,
  logPathOf,
  coverageChecks,
  readCase,
  cleanup,
} from "../hook-fixture-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const HOOK = process.env.HOOK || path.join(REPO, ".claude/hooks/adjacency-heartbeat.js");

const { check, finish } = makeReporter();

const FP = "SHA256:alice-test-fingerprint";
const PID = "p-alice";

const FIXTURES = ["01-coalesced", "02-post-coalesce", "03-stop-event"];

const SETUPS = {
  "01-coalesced": {
    cache: null,
    why: 'cache_state "absent" — the first heartbeat of a session. With no cache there is nothing to coalesce against, so the record MUST be appended and the cache created.',
  },
  "02-post-coalesce": {
    cache: () => ({ last_heartbeat_ms: Date.now() - 5_000, seq: 3, verified_id: FP }),
    why: 'cache_state "last_heartbeat_ms = (now - 5_000)" — 5s inside the 60s COALESCE_WINDOW_MS. `verified_id` is set to the operator under test because readCache REJECTS a foreign cache, which would silently un-coalesce this row.',
  },
  "03-stop-event": {
    cache: () => ({ last_heartbeat_ms: Date.now() - 5_000, seq: 3, verified_id: FP }),
    why: "Stop event staged against the SAME fresh cache that makes 02 coalesce, so the append here is attributable to the Stop bypass and not to an expired window.",
  },
};

function cachePathOf(repoDir) {
  return path.join(repoDir, ".claude", "learning", ".heartbeat-cache");
}

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

function stage(name) {
  const repoDir = mkRepo(name.slice(0, 2));
  fs.writeFileSync(logPathOf(repoDir), "");
  const c = SETUPS[name].cache;
  if (c) fs.writeFileSync(cachePathOf(repoDir), JSON.stringify(c()) + "\n");
  return repoDir;
}

function envFor(repoDir, extra = {}) {
  return {
    CLAUDE_PROJECT_DIR: repoDir,
    COC_TEST_FINGERPRINT: FP,
    COC_TEST_PERSON_ID: PID,
    COC_TEST_SKIP_SIGN: "1",
    ...extra,
  };
}

function drive(repoDir, payload, extraEnv) {
  return driveHook(HOOK, {
    stdinRaw: JSON.stringify(payload),
    cwd: repoDir,
    env: envFor(repoDir, extraEnv),
  });
}

console.log(`\nhook under test : ${HOOK}`);

// ---- T1: corpus coverage -----------------------------------------------------
console.log("\n=== T1: every fixture on disk is driven by this runner ===");
coverageChecks(check, HERE, FIXTURES, SETUPS);

// ---- T2: per-fixture SIDE EFFECT at the declared setup ------------------------
console.log("\n=== T2: drive each fixture against the REAL hook and read what it WROTE ===");
for (const name of FIXTURES) {
  const c = readCase(HERE, name);
  const setup = SETUPS[name];
  const repoDir = stage(name);
  const before = readLog(repoDir).length;
  const payload = {
    hook_event_name: c.input.hook_event_name,
    tool_name: c.input.tool_name,
    tool_input: c.input.tool_input || {},
    cwd: repoDir,
  };
  const r = drive(repoDir, payload);
  const after = readLog(repoDir);
  const appended = after.length - before;
  const hb = after.filter((x) => x.type === "heartbeat");

  console.log(`\n  -- ${name} [harness setup: ${setup.why}]`);

  // Every fixture pins `continue: true`. It is asserted, but it is NOT the
  // finding — the hook never blocks on any path, so this leg alone cannot
  // distinguish a working hook from an inert one.
  check(
    `${name}: continue=true (the hook NEVER blocks)`,
    r.code === 0 && r.json !== null && r.json.continue === true,
    `exit=${r.code} continue=${r.json ? r.json.continue : "<unparseable>"}`,
    "a refusal or an unparseable payload = a telemetry hook has started gating tool calls, which is outside its contract on every branch",
  );

  if (name === "02-post-coalesce") {
    check(
      `${name}: coalesced — coordination-log size UNCHANGED`,
      appended === 0,
      `records before=${before} after=${after.length}`,
      "an appended record = the 60s coalesce window is not being read, so every tool call in a session writes a heartbeat row and the coordination log grows without bound",
    );
    check(
      `${name}: cache still present and still inside the window`,
      fs.existsSync(cachePathOf(repoDir)) &&
        Date.now() - JSON.parse(fs.readFileSync(cachePathOf(repoDir), "utf8")).last_heartbeat_ms <
          60_000,
      "cache retained",
      "a cleared or advanced cache = the coalesced branch rewrote liveness state it was supposed to leave alone, and the NEXT call would append early",
    );
  } else {
    check(
      `${name}: exactly one heartbeat record appended`,
      appended === 1 && hb.length === 1,
      `appended=${appended} heartbeat records=${hb.length}`,
      "zero appended = the operator's liveness is never advertised, so rule-7 marks their session dead and siblings reap their claims; more than one = a single tool call writes duplicate liveness rows",
    );
    check(
      `${name}: appended record carries this operator's verified_id + person_id`,
      hb.length === 1 && hb[0].verified_id === FP && hb[0].person_id === PID,
      `verified_id=${hb[0] && hb[0].verified_id} person_id=${hb[0] && hb[0].person_id}`,
      "a different or absent identity = the heartbeat advertises liveness for the wrong chain, which is worse than no heartbeat: it keeps a dead operator's claims alive",
    );
    check(
      `${name}: cache written with last_heartbeat_ms + verified_id`,
      (() => {
        if (!fs.existsSync(cachePathOf(repoDir))) return false;
        const cache = JSON.parse(fs.readFileSync(cachePathOf(repoDir), "utf8"));
        return typeof cache.last_heartbeat_ms === "number" && cache.verified_id === FP;
      })(),
      "cache created/updated",
      "an unwritten cache = nothing to coalesce against, so the coalesce branch can never fire and every subsequent tool call appends; a cache without verified_id = readCache's cross-operator poisoning guard has nothing to compare",
    );
  }

  if (name === "03-stop-event") {
    check(
      `${name}: final heartbeat carries session_end_intent=true`,
      hb.length === 1 && hb[0].content && hb[0].content.session_end_intent === true,
      `session_end_intent=${hb[0] && hb[0].content && hb[0].content.session_end_intent}`,
      "false/absent = the turn-boundary heartbeat is indistinguishable from a mid-session one, so a sibling cannot tell a closed session from a merely-quiet one and waits out the full TTL before reaping",
    );
  }
  if (name === "01-coalesced") {
    check(
      `${name}: first heartbeat carries session_end_intent=false`,
      hb.length === 1 && hb[0].content && hb[0].content.session_end_intent === false,
      `session_end_intent=${hb[0] && hb[0].content && hb[0].content.session_end_intent}`,
      "true on a PreToolUse heartbeat = every tool call announces session end, and siblings reap an operator's claims mid-session",
    );
  }
}

// ---- T3: PAIRED CONTROLS ------------------------------------------------------
//
// Each row above is consistent with degenerate hooks: one that appends on EVERY
// invocation satisfies 01 and 03; one that appends on NONE satisfies 02. Each
// control flips exactly one element and requires the side effect to MOVE.
console.log("\n=== T3: paired controls — flip one setup element, require the side effect to move ===");

const preToolUse = (repoDir) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Read",
  tool_input: { file_path: "x.txt" },
  cwd: repoDir,
});

{
  // C1 — the coalesce decision is keyed on the cache, not on invocation count.
  const repoDir = stage("01-coalesced");
  const first = drive(repoDir, preToolUse(repoDir));
  const afterFirst = readLog(repoDir).length;
  const second = drive(repoDir, preToolUse(repoDir));
  const afterSecond = readLog(repoDir).length;
  check(
    "C1: two identical PreToolUse calls — first appends, second is COALESCED",
    afterFirst === 1 && afterSecond === 1 && first.code === 0 && second.code === 0,
    `after first=${afterFirst} after second=${afterSecond}`,
    "two appends = COALESCE_WINDOW_MS is not consulted and the log grows once per tool call; zero appends = liveness is never advertised at all and the first row above passes only because nothing ever writes",
  );
}

{
  // C2 — the window is a TIME bound, not mere cache presence. Same cache FILE
  // shape on both arms; only its timestamp moves across the 60s boundary.
  const repoDir = mkRepo("c2");
  fs.writeFileSync(logPathOf(repoDir), "");
  fs.writeFileSync(
    cachePathOf(repoDir),
    JSON.stringify({ last_heartbeat_ms: Date.now() - 5_000, seq: 1, verified_id: FP }) + "\n",
  );
  drive(repoDir, preToolUse(repoDir));
  const inside = readLog(repoDir).length;
  fs.writeFileSync(
    cachePathOf(repoDir),
    JSON.stringify({ last_heartbeat_ms: Date.now() - 120_000, seq: 1, verified_id: FP }) + "\n",
  );
  drive(repoDir, preToolUse(repoDir));
  const outside = readLog(repoDir).length;
  check(
    "C2: same cache file — last_heartbeat 5s ago ⇒ no append / 120s ago ⇒ append",
    inside === 0 && outside === 1,
    `inside-window appended=${inside} | outside-window appended=${outside - inside}`,
    "identical outcomes = the guard is keying on the cache's EXISTENCE rather than its age. Never appending after the first heartbeat means liveness goes stale and siblings reap live claims; always appending means the coalesce optimization does not exist.",
  );
}

{
  // C3 — Stop BYPASSES the coalesce window. Identical fresh cache on both arms;
  // only hook_event_name moves.
  const repoDir = mkRepo("c3");
  fs.writeFileSync(logPathOf(repoDir), "");
  const freshCache = () =>
    fs.writeFileSync(
      cachePathOf(repoDir),
      JSON.stringify({ last_heartbeat_ms: Date.now() - 5_000, seq: 1, verified_id: FP }) + "\n",
    );
  freshCache();
  drive(repoDir, preToolUse(repoDir));
  const afterPre = readLog(repoDir).length;
  freshCache();
  drive(repoDir, { hook_event_name: "Stop", cwd: repoDir });
  const rows = readLog(repoDir);
  check(
    "C3: identical fresh cache — PreToolUse ⇒ coalesced / Stop ⇒ appends a session_end_intent heartbeat",
    afterPre === 0 &&
      rows.length === 1 &&
      rows[0].type === "heartbeat" &&
      rows[0].content.session_end_intent === true,
    `PreToolUse appended=${afterPre} | Stop rows=${rows.length} session_end_intent=${rows[0] && rows[0].content && rows[0].content.session_end_intent}`,
    "a coalesced Stop = the session's FINAL heartbeat is dropped whenever the turn ends within 60s of the last tool call, which is the common case; siblings then never see the session-end intent and hold off reaping for the full TTL",
  );
}

{
  // C4 — the appended row's identity is attributable to the RESOLVED OPERATOR,
  // not a constant, AND readCache's cross-operator poisoning guard is live. Same
  // repo, same fresh cache inside the coalesce window; only WHO is running moves.
  //
  // Why this control and not an "identity UNRESOLVABLE" one: measured, that state
  // is not reachable through any env seam here. operator-id.js Tier 2 routes its
  // `user.signingkey` read through the CONFIG profile, which by design ignores
  // ambient GIT_CONFIG_GLOBAL/HOME (loom#1471), so on any machine whose user has
  // a signing key the hook resolves a real identity no matter what the harness
  // sets. Forcing that row would have made this suite pass on CI and fail on a
  // developer box — an instrument whose verdict is a property of the machine.
  const OTHER_FP = "SHA256:bob-test-fingerprint";
  const repoDir = mkRepo("c4");
  fs.writeFileSync(logPathOf(repoDir), "");
  fs.writeFileSync(
    cachePathOf(repoDir),
    JSON.stringify({ last_heartbeat_ms: Date.now() - 5_000, seq: 7, verified_id: FP }) + "\n",
  );
  // Alice's own fresh cache → coalesced, nothing written.
  drive(repoDir, preToolUse(repoDir));
  const afterAlice = readLog(repoDir).length;
  // Bob, same cache file on disk. readCache must REJECT it as foreign, so Bob
  // does NOT inherit Alice's coalesce window.
  drive(repoDir, preToolUse(repoDir), {
    COC_TEST_FINGERPRINT: OTHER_FP,
    COC_TEST_PERSON_ID: "p-bob",
  });
  const rows = readLog(repoDir);
  check(
    "C4: same fresh cache written by alice — alice ⇒ coalesced / bob ⇒ appends under HIS verified_id",
    afterAlice === 0 &&
      rows.length === 1 &&
      rows[0].verified_id === OTHER_FP &&
      rows[0].person_id === "p-bob",
    `alice appended=${afterAlice} | rows=${rows.length} verified_id=${rows[0] && rows[0].verified_id}`,
    "bob coalescing on alice's cache = readCache's identity guard is gone and one operator's liveness silently suppresses another's heartbeats (Sec-MED-A2); a row carrying alice's verified_id under bob = the heartbeat advertises liveness for the wrong chain, keeping a departed operator's claims alive",
  );
}

cleanup();
finish();
