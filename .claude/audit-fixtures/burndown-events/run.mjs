#!/usr/bin/env node
/**
 * burndown-events — fixtures for the event log (`lib/burndown-events.js`) and its
 * producer (`todo-tracker-guard.js`).
 *
 * ── BIPOLAR PER ARM, AND THE HARNESS ASSERTS THE POLES DIFFER ────────────────
 *
 * `instrument-bipolarity.md` MUST-1: every arm ships an executable pole PAIR run by
 * THIS harness, and the harness itself asserts the two verdicts DIFFER. A pair whose
 * poles agree is VACUOUS and FAILS here rather than passing quietly — see `pair()`,
 * which is the only way an arm is registered.
 *
 * MUST-2: every RED pole names a failure IDENTITY — which criterion, which event or
 * item id — never a bare exit code or a count. A suite reading only exit codes stays
 * green against a producer that refuses the wrong thing for the wrong reason.
 *
 * ── ARMS ─────────────────────────────────────────────────────────────────────
 *
 *   A1  append succeeds and lands a READABLE event   | a refused append lands nothing
 *   C6  a refused append is LOUD (halt-and-report)   | a clean append is SILENT
 *   evt the WRONG event produces nothing             | the right event produces an event
 *   C5  genesis never overwrites live in the fold    | genesis alone folds normally
 *   open every error path FAILS OPEN ({continue:true})| ... and still says WHY
 *   A3  the budget check itself can say WITHIN and OVER
 *
 *   R1  an AGENT retraction is refused                | an OWNER retraction lands
 *   R2  losing a record SHRINKS the population        | a retraction does NOT
 *   R3  a transition wearing `retired` is refused     | an ordinary work-state is not
 *   R4  whitespace/case status VARIANTS are refused  | the legitimate values still pass
 *   AU1 a contributor claiming `owner` is refused     | a rostered owner is accepted
 *   AU2 an unreadable roster is INDETERMINATE         | a rostered contributor is INVALID
 *   AU3 an `owner` on a CI host is ineligible         | the same person on a human host is not
 *   AU4 the ABSENT-resolver default fails CLOSED      | an `agent` claim still appends
 *
 * The authority arms are `AU`-prefixed, not `A`: the pre-existing `A1` (append lands a
 * readable event) and `A3` (the budget instrument) already own those ids, and two arms
 * sharing a prefix makes this legend unreadable in a suite where arm ids trace to
 * architecture refs.
 *
 * R2 is the arm the retraction design turns on. `burndown-build.mjs`'s
 * `tracker.min_rows` gate is a LOG-INTEGRITY floor resting on the fold's population
 * being MONOTONIC; the RED pole shows the population CAN fall (so the floor is not
 * vacuous) and the GREEN pole shows a retraction does not make it fall (so a retirement
 * can never be mistaken for a loss, and the floor keeps its exact prior meaning).
 *
 * The A-arms drive the roster through the REAL `makeRosterSignerResolver` and its
 * injected reader rather than a stub, so `readCommittedRoster`'s parse and
 * `signerIndex`'s fingerprint→person mapping are under test too — a stub would leave
 * both untested while every case passed.
 *
 * ── NEGATIVE CONTROLS ────────────────────────────────────────────────────────
 *
 * Set `BURNDOWN_EVENTS_FIXTURE_MUTANT` to red the suite deliberately
 * (`instrument-discipline.md` MUST-2(b) — a mutation that does NOT red leaves TWO
 * live hypotheses, so each mutant below is asserted to REACH the code it mutates
 * before its result is read):
 *
 *   validate-passthrough  `validateEvent` always returns ok  → every refusal arm reds
 *   fold-nofence          the C5 weight fence is removed     → the C5 arm reds
 *   append-alwaysfail     the append helper always refuses   → every success arm reds
 *
 * The hook is invoked as a REAL subprocess over REAL stdin against REAL temporary
 * repositories. Nothing is mocked, so a case cannot pass against a producer the
 * harness would not actually run.
 */
import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const GUARD = path.join(REPO_ROOT, ".claude", "hooks", "todo-tracker-guard.js");
const LIB = path.join(REPO_ROOT, ".claude", "hooks", "lib", "burndown-events.js");
const GENERATOR = path.join(REPO_ROOT, ".claude", "bin", "burndown-build.mjs");

const MUTANT = process.env.BURNDOWN_EVENTS_FIXTURE_MUTANT || "";

let ev = require(LIB);

// ── mutants ────────────────────────────────────────────────────────────────
//
// Each mutant is applied to the LOADED module and then ASSERTED TO REACH the code
// under test before any verdict is read. An unreached mutation that fails to red is
// two live hypotheses (vacuous test / inert mutation), never a vacuity verdict.
if (MUTANT === "validate-passthrough") {
  const real = ev.validateEvent;
  ev = { ...ev, validateEvent: () => ({ ok: true }) };
  // reachability: the real function REFUSES this event; the mutant must accept it.
  const probe = { schema: "nope" };
  if (real(probe).ok || !ev.validateEvent(probe).ok) {
    console.log("MUTANT validate-passthrough did NOT reach validateEvent — result UNRESOLVED");
    process.exit(3);
  }
}
if (MUTANT === "fold-nofence") {
  // Re-implement the fold WITHOUT the migration_baseline-never-overwrites-live fence.
  ev = {
    ...ev,
    foldEvents(text) {
      const rows = new Map();
      const skipped = [];
      let considered = 0;
      const lines = String(text || "").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        let e;
        try {
          e = JSON.parse(lines[i]);
        } catch {
          skipped.push({ line: i + 1, why: "unparseable" });
          continue;
        }
        considered++;
        rows.set(e.item_id, { id: e.item_id, anchorRaw: e.value_anchor, item: e.item, line: i + 1 });
      }
      return { rows, skipped, considered };
    },
  };
}
let APPEND_ALWAYSFAIL = MUTANT === "append-alwaysfail";

let pass = 0;
const failures = [];

function check(name, fn) {
  let ok;
  try {
    ok = fn();
  } catch (e) {
    ok = `threw: ${e && e.message}`;
  }
  if (ok === true) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name}${typeof ok === "string" ? ` — ${ok}` : ""}`);
  }
}

/**
 * Register one bipolar ARM.
 *
 * Both poles run. Each returns a VERDICT STRING — not a boolean, because two
 * booleans can be equal for opposite reasons and the whole point is that the poles
 * are DISTINGUISHABLE. The harness then asserts, as its own case, that the two
 * verdicts DIFFER; identical verdicts is a VACUOUS pair and FAILS.
 */
function pair(arm, redName, redFn, greenName, greenFn) {
  let redV = null;
  let greenV = null;
  check(`${arm} · RED  · ${redName}`, () => {
    redV = redFn();
    return typeof redV === "string" && redV.startsWith("RED:") ? true : `expected a RED: verdict, got ${JSON.stringify(redV)}`;
  });
  check(`${arm} · GREEN · ${greenName}`, () => {
    greenV = greenFn();
    return typeof greenV === "string" && greenV.startsWith("GREEN:") ? true : `expected a GREEN: verdict, got ${JSON.stringify(greenV)}`;
  });
  check(`${arm} · NON-VACUOUS · the two poles produce DIFFERENT verdicts`, () => {
    if (redV === null || greenV === null) return "a pole did not produce a verdict";
    return redV !== greenV ? true : `VACUOUS PAIR: both poles returned ${JSON.stringify(redV)}`;
  });
}

// ── fixture repo ───────────────────────────────────────────────────────────

const MANIFEST = {
  _schema: "burndown-manifest/v1",
  target: "REGISTER.md",
  pages: ["Alpha"],
  sources: [{ path: "burndown/register.json", kind: "register", precedence: 0 }],
  tracker: { path: ".session-notes.shared.md", kind: "forest-ledger", anchor_roots: ["journal/", "workspaces/"] },
  // `appendEvent` resolves this through `signed-log.js::loadSuitePolicy` and REFUSES
  // fail-closed when it is absent — absent never reads as a default. A fixture repo
  // whose manifest omits it therefore cannot reach ANY append branch, so the
  // declaration is part of the minimal healthy repo, not part of a case's setup.
  // Mirrors the canonical `burndown-manifest.json` block; the `withSuite: false`
  // option below is what drives the absent-declaration refusal deliberately.
  //
  // The CURRENT generation is read from the library (`ev.SCHEMA`), never copied as a
  // literal. A hardcoded copy is what reded FOUR fixture suites at once on the
  // generation-2 roll — each declaring a generation `buildEvent` had already moved
  // past, so every append refused as `append to a closed generation` and no case in
  // the suite measured what it was written to measure. The PRIOR generations stay
  // literal: they are closed, so their identity cannot move.
  signature_suite: {
    generation: ev.SCHEMAS[ev.SCHEMA].generation,
    schema: ev.SCHEMA,
    suite: "openpgp",
    prior_generations: [{ generation: 0, schema: "burndown-event/v1", suite: "openpgp" }],
  },
};

function mkRepo({ withManifest = true, trackerKind = "forest-ledger", withSuite = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bd-events-"));
  fs.mkdirSync(path.join(dir, "burndown"), { recursive: true });
  fs.mkdirSync(path.join(dir, "journal"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "burndown", "register.json"),
    JSON.stringify({ _authority: "agent", items: [{ id: "R1-alpha-item", page: "Alpha", status: "In progress" }] }, null, 2),
  );
  if (withManifest) {
    const m = JSON.parse(JSON.stringify(MANIFEST));
    m.tracker.kind = trackerKind;
    if (!withSuite) delete m.signature_suite;
    fs.writeFileSync(path.join(dir, "burndown-manifest.json"), JSON.stringify(m, null, 2));
  }
  fs.writeFileSync(path.join(dir, ".session-notes.shared.md"), "| ID | item | value_anchor |\n| --- | --- | --- |\n");
  return dir;
}

function todoPayload(todos) {
  return { hook_event_name: "PostToolUse", tool_name: "TodoWrite", tool_input: { todos } };
}

function runHook(dir, payload, env = {}) {
  const r = spawnSync("node", [GUARD], {
    cwd: dir,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...env },
    timeout: 30000,
  });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

function hookJson(res) {
  const line = res.out.trim().split("\n").filter(Boolean).pop();
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function logLines(dir) {
  const p = path.join(dir, ev.EVENTS_REL);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim());
}

// A caller-injected append that stands in for `appendStamped`. It is the SAME
// injection point the production module exposes for exactly this, so the fixtures
// drive every refusal branch with no signing key and no repo state.
function fakeAppend(sinkOk) {
  return (repoDir, filePath, partial) => {
    if (APPEND_ALWAYSFAIL || !sinkOk) {
      return { ok: false, error: "record too large", reason: "serialized line exceeds MAX_LINE_BYTES (2048)" };
    }
    const line = JSON.stringify({ id: `rec_${Math.random().toString(36).slice(2)}`, timestamp: new Date().toISOString(), ...partial, sig: "FIXTURE" });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, line + "\n");
    return { ok: true, id: "rec_fixture", line };
  };
}

const IDENT = { verified_id: "FPR", person_id: "pid-fixture", display_id: "fixture" };

const GOOD = () =>
  ev.buildEvent({
    kind: "transition",
    item_id: "R1-alpha-item",
    item: "an alpha item",
    value_anchor: "journal/0001-a.md#R1-alpha-item",
    status: "todo:in_progress",
    authority: "agent",
    source: "fixture",
  });

// ── ARM A1 — an append lands a READABLE event ──────────────────────────────

pair(
  "A1-append-lands-readable-event",
  "a refused append lands NOTHING and names the refusal identity",
  () => {
    const dir = mkRepo();
    const r = ev.appendEvent(dir, GOOD(), { identity: IDENT, append: fakeAppend(false) });
    try {
      if (r.ok) return "expected a refusal";
      if (logLines(dir).length !== 0) return "a refused append still wrote to the log";
      // MUST-2: the RED pole names the IDENTITY, not a bare exit code.
      return `RED:A1 refused item_id=R1-alpha-item error=${r.error}`;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  "a successful append lands exactly one line that folds back to the item",
  () => {
    const dir = mkRepo();
    const r = ev.appendEvent(dir, GOOD(), { identity: IDENT, append: fakeAppend(true) });
    try {
      if (!r.ok) return `expected success, got ${r.error}: ${r.reason}`;
      const lines = logLines(dir);
      if (lines.length !== 1) return `expected 1 log line, got ${lines.length}`;
      const fold = ev.foldEvents(lines.join("\n"));
      const row = fold.rows.get("R1-alpha-item");
      if (!row) return "the appended event did not fold back to its item_id";
      // The projection SHAPE is the claim the whole design rests on.
      for (const k of ["id", "anchorRaw", "item", "line"]) {
        if (!(k in row)) return `folded row is missing '${k}' — not parseLedger's shape`;
      }
      if (row.id !== "R1-alpha-item") return `folded id is '${row.id}', not the item id verbatim`;
      return `GREEN:A1 appended item_id=R1-alpha-item folded line=${row.line}`;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ── ARM C6 — a refused append is LOUD at the producer ──────────────────────
//
// Driven end-to-end through the REAL hook subprocess. The refusal is forced by the
// absent-precondition path (no signing key discoverable), which is the branch a
// deployment actually hits.

pair(
  "C6-refused-append-is-loud",
  "a producer that cannot record SURFACES it, naming rule_id and criterion",
  () => {
    const dir = mkRepo();
    try {
      // `gitConfigSigningKey: null` is not reachable from the hook, so the key is
      // suppressed the way a real un-enrolled repo suppresses it: an empty HOME and
      // an empty repo git config, so `git config --get user.signingkey` finds none.
      const res = runHook(dir, todoPayload([{ content: "a fixture todo with enough content", status: "pending" }]), {
        HOME: dir,
        XDG_CONFIG_HOME: dir,
        GIT_CONFIG_GLOBAL: path.join(dir, "no-such-gitconfig"),
        GIT_CONFIG_SYSTEM: path.join(dir, "no-such-gitconfig"),
      });
      const j = hookJson(res);
      if (!j) return `no JSON on stdout (code=${res.code})`;
      const blob = JSON.stringify(j);
      if (!/burndown-traceability\/todos-to-index/.test(blob)) return "the finding does not name its rule_id";
      if (!/C3-unknown-not-clean|C6-refused-append-is-loud/.test(blob)) return "the finding does not name a criterion";
      if (/"continue"\s*:\s*false|"permissionDecision"\s*:\s*"deny"/.test(blob)) return "the producer did not fail open";
      const crit = /C6-refused-append-is-loud/.test(blob) ? "C6-refused-append-is-loud" : "C3-unknown-not-clean";
      return `RED:C6 surfaced criterion=${crit} rule_id=burndown-traceability/todos-to-index`;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  "a repo with no burndown manifest is SILENT — no finding at all",
  () => {
    const dir = mkRepo({ withManifest: false });
    try {
      const res = runHook(dir, todoPayload([{ content: "a fixture todo with enough content", status: "pending" }]));
      const j = hookJson(res);
      if (!j) return `no JSON on stdout (code=${res.code})`;
      if (j.hookSpecificOutput) return "a repo with no burndown still produced a finding";
      if (j.continue !== true) return "expected a bare {continue:true}";
      return "GREEN:C6 silent — no manifest, no finding";
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ── ARM evt — the WRONG event produces nothing ─────────────────────────────

pair(
  "evt-matcher-is-load-bearing",
  "a non-TodoWrite payload produces NO event and NO finding",
  () => {
    const dir = mkRepo();
    try {
      const res = runHook(dir, { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "x" } });
      const j = hookJson(res);
      if (!j) return `no JSON on stdout (code=${res.code})`;
      if (j.hookSpecificOutput) return "a non-TodoWrite payload produced a finding";
      if (logLines(dir).length !== 0) return "a non-TodoWrite payload wrote to the event log";
      return "RED:evt wrong-event → 0 events, 0 findings";
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  "a TodoWrite payload IS recognised — it reaches the projection and reports",
  () => {
    const dir = mkRepo({ trackerKind: "not-a-forest-ledger" });
    try {
      // An unrecognised tracker kind makes the producer report UNKNOWN, which proves
      // the TodoWrite REACHED the projection. Using the scoping branch keeps this pole
      // independent of whether a signing key exists on the machine running the suite.
      const res = runHook(dir, todoPayload([{ content: "a fixture todo with enough content", status: "pending" }]));
      const j = hookJson(res);
      if (!j) return `no JSON on stdout (code=${res.code})`;
      if (!j.hookSpecificOutput) return "a TodoWrite payload produced no finding — it never reached the projection";
      return "GREEN:evt right-event → reached the projection and reported";
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ── ARM C5 — genesis and transition do not collide ─────────────────────────

/**
 * `buildEvent` returns the CALLER half — the shape `validateEvent` governs. The C5
 * cases below serialize their events STRAIGHT TO TEXT and hand them to `foldEvents`,
 * so what the fold sees is an ON-DISK RECORD, governed by the strictly stricter
 * `validateRecord`: a `burndown-event/v2` record MUST carry `sig_alg`, an integer
 * `seq >= 1`, and a `prev_hash` that is 64-hex or null (null iff `seq === 1`). A
 * record missing them is SKIPPED as malformed, which is why both C5 poles reported
 * the item as absent from the fold rather than reporting the fence they exist to test.
 *
 * `onDisk` stamps that envelope. `seq: 1` / `prev_hash: null` is a well-formed shape
 * per line: `validateRecord` is documented SHAPE-ONLY, and whole-log chain
 * consistency belongs to `signed-log.js::verifyChain`, which `foldEvents` never runs.
 */
function onDisk(partial, over = {}) {
  return JSON.stringify({
    id: `rec_${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    sig_alg: "openpgp",
    seq: 1,
    prev_hash: null,
    ...partial,
    ...over,
    sig: "FIXTURE",
  });
}

function genesisFor(id, anchor) {
  return ev.buildEvent({
    kind: "genesis",
    item_id: id,
    item: "the BACKFILLED text",
    value_anchor: anchor,
    status: "In progress",
    authority: "agent",
    source: "burndown-genesis",
  });
}
function transitionFor(id, anchor) {
  return ev.buildEvent({
    kind: "transition",
    item_id: id,
    item: "the LIVE text",
    value_anchor: anchor,
    status: "todo:completed",
    authority: "agent",
    source: "todo-tracker-guard",
  });
}

pair(
  "C5-genesis-never-overwrites-live",
  "a genesis appended AFTER a live transition is fenced OUT of the fold",
  () => {
    const text = [onDisk(transitionFor("R1-alpha-item", "journal/live.md#R1-alpha-item")), onDisk(genesisFor("R1-alpha-item", "journal/backfill.md#R1-alpha-item"))].join("\n");
    const fold = ev.foldEvents(text);
    const row = fold.rows.get("R1-alpha-item");
    if (!row) return "the item vanished from the fold entirely";
    if (row.item !== "the LIVE text") {
      return `the genesis OVERWROTE the live transition (item is '${row.item}') — migration_baseline weight took live authority`;
    }
    const s = fold.skipped.find((x) => /R1-alpha-item/.test(x.why));
    if (!s) return "the genesis was fenced out but not RECORDED — a silent drop";
    return `RED:C5 genesis fenced item_id=R1-alpha-item at line=${s.line} live text preserved`;
  },
  "a genesis with no live transition folds normally",
  () => {
    const fold = ev.foldEvents(onDisk(genesisFor("R2-alpha-item", "journal/backfill.md#R2-alpha-item")));
    const row = fold.rows.get("R2-alpha-item");
    if (!row) return "a lone genesis did not fold";
    if (row.item !== "the BACKFILLED text") return `folded the wrong text: '${row.item}'`;
    if (fold.skipped.length !== 0) return `a lone genesis was skipped: ${JSON.stringify(fold.skipped)}`;
    return `GREEN:C5 lone genesis folded item_id=R2-alpha-item line=${row.line}`;
  },
);

// ── ARM open — every error path FAILS OPEN, and still says why ─────────────

pair(
  "open-fail-open-on-every-error-path",
  "an unreadable payload still returns {continue:true} and claims NOTHING",
  () => {
    const dir = mkRepo();
    try {
      const r = spawnSync("node", [GUARD], {
        cwd: dir,
        input: "}{ not json",
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
        timeout: 30000,
      });
      const j = hookJson({ out: r.stdout || "" });
      if (r.status !== 0) return `exited ${r.status}, not 0 — it did not fail open`;
      if (!j || j.continue !== true) return "did not emit {continue:true}";
      if (j.hookSpecificOutput) return "a timeout/parse failure FABRICATED a claim";
      return "RED:open unreadable-payload → continue:true, no claim";
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  "an UNKNOWN scope fails open but DOES say why",
  () => {
    const dir = mkRepo({ trackerKind: "not-a-forest-ledger" });
    try {
      const res = runHook(dir, todoPayload([{ content: "a fixture todo with enough content", status: "pending" }]));
      const j = hookJson(res);
      if (res.code !== 0 && res.code !== 2) return `unexpected exit ${res.code}`;
      if (!j) return "no JSON on stdout";
      if (/"continue"\s*:\s*false|"permissionDecision"\s*:\s*"deny"/.test(JSON.stringify(j))) return "did not fail open";
      const blob = JSON.stringify(j);
      if (!/C3-unknown-not-clean/.test(blob)) return "failed open SILENTLY — 'could not project' rendered as clean";
      return "GREEN:open unknown-scope → continue, and NAMES C3-unknown-not-clean";
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ── ARM A3 — the budget instrument can return BOTH verdicts ────────────────
//
// The budget check is itself an instrument, so it is held to `instrument-discipline.md`
// MUST-1: it must be shown able to print the OTHER answer. A pair that only ever
// prints WITHIN cannot certify anything about a producer that got slower.

const BUDGET_MS = 45;
function budgetVerdict(ms) {
  return ms <= BUDGET_MS ? "WITHIN" : "OVER";
}

pair(
  "A3-budget-instrument-discriminates",
  "a deliberately slow append is scored OVER the 45 ms budget",
  () => {
    const t0 = process.hrtime.bigint();
    const slow = () => {
      const end = Date.now() + 60; // 60 ms > 45 ms budget, by construction
      while (Date.now() < end) {
        /* busy */
      }
    };
    slow();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const v = budgetVerdict(ms);
    if (v !== "OVER") return `a 60 ms operation scored ${v} against a ${BUDGET_MS} ms budget — the instrument cannot say OVER`;
    return `RED:A3 verdict=OVER measured=${ms.toFixed(0)}ms budget=${BUDGET_MS}ms`;
  },
  "the no-transition regime is scored WITHIN the 45 ms budget",
  () => {
    const dir = mkRepo();
    try {
      // The dominant case: a TodoWrite restating an unchanged list. Measured over the
      // pure transition-selection the producer runs before it touches identity.
      const todos = [];
      for (let i = 0; i < 5; i++) todos.push({ id: `todo-${i}`, status: "pending", content: `c${i}` });
      const prev = new Map(todos.map((t) => [t.id, { first_seen: "x", status: t.status, todo: t.content }]));
      const t0 = process.hrtime.bigint();
      const transitions = todos.filter((t) => {
        const b = prev.get(t.id);
        return !(b && b.status === t.status && b.todo === t.content);
      });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (transitions.length !== 0) return "the no-op regime produced transitions — the fast path is dead code";
      const v = budgetVerdict(ms);
      if (v !== "WITHIN") return `the no-transition regime scored ${v} at ${ms.toFixed(2)}ms`;
      return `GREEN:A3 verdict=WITHIN measured=${ms.toFixed(2)}ms budget=${BUDGET_MS}ms appends=0`;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// COMPONENT 11 — RETRACTION IS RETIRE-IN-PLACE, AND OWNER-ONLY
// COMPONENT 12 — `authority` IS BOUND TO A ROSTERED SIGNER ROLE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A committed roster, driven through the REAL `makeRosterSignerResolver` via its
 * injected reader rather than a hand-made stub.
 *
 * That choice is the arm's own instrument discipline: a stub resolver would test
 * `verifyAuthorityClaim`'s branching and NOTHING about `readCommittedRoster`'s parse or
 * `signerIndex`'s fingerprint→person mapping, so a defect in either would pass every
 * case here while the production path was broken.
 */
// `omitRole` / `omitHostRole` are explicit FLAGS rather than `role: undefined`, and
// that is not style: a destructuring default fires on `undefined`, so passing
// `role: undefined` silently restored the default and the "no declared role" case
// asserted the OPPOSITE of what it reads as — a fixture that measured nothing while
// passing. Caught here by its own arm going green for the wrong reason.
function rosterDoc({ role = "owner", host_role = "human", pid = "pid-fixture", fpr = "FPR", omitRole = false, omitHostRole = false } = {}) {
  const person = { display_id: "fixture", keys: [{ type: "ssh", fingerprint: fpr, pubkey: "ssh-ed25519 AAAAfixture" }] };
  if (!omitRole) person.role = role;
  if (!omitHostRole) person.host_role = host_role;
  return { persons: { [pid]: person } };
}

function rosterResolver(opts) {
  // The repoDir is never reached: the injected reader answers first. Passing a path
  // that does not exist is deliberate — if the injection were ever dropped, the case
  // would refuse loudly rather than silently reading some real repository's roster.
  const doc = rosterDoc(opts);
  return ev.makeRosterSignerResolver("/nonexistent-fixture-repo", { readRoster: () => JSON.stringify(doc) });
}

const RETRACTION = (over = {}) => ({
  ...ev.buildEvent({
    kind: "retraction",
    item_id: "R1-alpha-item",
    item: "an alpha item",
    value_anchor: "journal/0001-a.md#R1-alpha-item",
    status: "ignored — the terminal status is DERIVED",
    authority: "owner",
    source: "fixture",
    reason: "superseded by a later item; retired by the owner",
  }),
  ...over,
});

// ── ARM R1 — a retraction is OWNER-ONLY ────────────────────────────────────

pair(
  "R1-retraction-is-owner-only",
  "an AGENT-authored retraction is REFUSED, naming the adjudication it would have laundered",
  () => {
    const dir = mkRepo();
    try {
      const r = ev.appendEvent(dir, RETRACTION({ authority: "agent" }), {
        identity: IDENT,
        append: fakeAppend(true),
        resolveSigner: rosterResolver({ role: "owner" }),
      });
      if (r.ok) return "an agent retracted an item — the MUST-4 owner adjudication was laundered through a new kind";
      if (r.error !== "retraction requires owner authority") return `refused for another reason: ${r.error}`;
      if (logLines(dir).length !== 0) return "a refused retraction still wrote to the log";
      return `RED:R1 refused item_id=R1-alpha-item error=${r.error} authority=agent`;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  "an OWNER-authored retraction whose signer is rostered `owner` lands, and folds RETIRED",
  () => {
    const dir = mkRepo();
    try {
      const r = ev.appendEvent(dir, RETRACTION(), {
        identity: IDENT,
        append: fakeAppend(true),
        resolveSigner: rosterResolver({ role: "owner", host_role: "human" }),
      });
      if (!r.ok) return `expected success, got ${r.error}: ${r.reason}`;
      const lines = logLines(dir);
      if (lines.length !== 1) return `expected 1 log line, got ${lines.length}`;
      const rec = JSON.parse(lines[0]);
      if (rec.status !== ev.RETIRED_STATUS) return `the terminal status was not DERIVED: status is ${JSON.stringify(rec.status)}`;
      if (rec.weight !== "live") return `a retraction carries weight ${JSON.stringify(rec.weight)}, not live`;
      if (rec.reason !== "superseded by a later item; retired by the owner") return "the recorded cause did not reach disk";
      return `GREEN:R1 appended item_id=R1-alpha-item authority=owner status=${rec.status} weight=${rec.weight}`;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ── ARM R2 — RETIRE-IN-PLACE: the population does NOT shrink ───────────────
//
// THE ARM THE WHOLE DESIGN TURNS ON. `burndown-build.mjs`'s `tracker.min_rows` gate is
// a LOG-INTEGRITY floor and it rests on the fold's population being MONOTONIC. This
// pair is what makes that claim falsifiable at the fold layer: the RED pole shows the
// population CAN fall (so the floor is not vacuous), and the GREEN pole shows a
// retraction does not make it fall (so retirement cannot be mistaken for a loss).

pair(
  "R2-retraction-retires-in-place",
  "LOSING a record DOES shrink the folded population — the floor's premise is live, not decorative",
  () => {
    const both = [
      onDisk(transitionFor("R1-alpha-item", "journal/live.md#R1-alpha-item")),
      onDisk(transitionFor("R2-beta-item", "journal/live.md#R2-beta-item")),
    ];
    const full = ev.foldEvents(both.join("\n"));
    const truncated = ev.foldEvents(both[0]);
    if (full.rows.size !== 2) return `the intact log folded to ${full.rows.size} item(s), not 2`;
    if (truncated.rows.size !== 1) return `a truncated log folded to ${truncated.rows.size} item(s), not 1`;
    return `RED:R2 truncation shrank the population 2 → 1 lost=R2-beta-item`;
  },
  "RETRACTING an item leaves the population UNCHANGED and reports the item as retired",
  () => {
    const base = [
      onDisk(transitionFor("R1-alpha-item", "journal/live.md#R1-alpha-item")),
      onDisk(transitionFor("R2-beta-item", "journal/live.md#R2-beta-item")),
    ];
    const before = ev.foldEvents(base.join("\n"));
    const after = ev.foldEvents([...base, onDisk(RETRACTION({ item_id: "R2-beta-item" }))].join("\n"));
    if (before.rows.size !== 2) return `the pre-retraction log folded to ${before.rows.size} item(s), not 2`;
    if (after.rows.size !== before.rows.size) {
      return `a retraction shrank the population ${before.rows.size} → ${after.rows.size} — retire-in-place is not in place, and the min_rows floor would now fire on ordinary work`;
    }
    if (!after.rows.has("R2-beta-item")) return "the retracted item lost its row — its LINK legs go with it";
    // The row is REPLACED wholesale, not merged: the fold is last-wins per item, so the
    // anchor that survives is the one the RETRACTION carries. Asserted because the
    // header used to claim the item "keeps its value_anchor", which the fold does not do
    // — it keeps whatever the retraction restates, and that distinction decides whether
    // a retracted item's LINK legs still resolve.
    if (after.rows.get("R2-beta-item").anchorRaw !== "journal/0001-a.md#R1-alpha-item") {
      return `the retraction's own anchor did not land: ${after.rows.get("R2-beta-item").anchorRaw}`;
    }
    if (after.retired.join(",") !== "R2-beta-item") return `the fold reported retired=${JSON.stringify(after.retired)}`;
    if (before.retired.length !== 0) return "the pre-retraction fold already reported a retirement";
    return `GREEN:R2 retraction held the population at ${after.rows.size} retired=${after.retired.join(",")}`;
  },
);

// ── ARM R3 — the terminal status cannot be laundered onto another kind ─────

// The literal, NOT `ev.RETIRED_STATUS`, and the two are asserted equal below. Reading
// the constant off the library under test makes the case UNRUNNABLE against a library
// that lacks it — which reds for the wrong reason (`undefined` is a missing field, not
// a laundered status) and would have hidden the behavioural defect this pair exists to
// show. The literal keeps the RED behavioural; the mirror check keeps it honest.
const TERMINAL_STATUS_LITERAL = "retired";

pair(
  "R3-terminal-status-is-kind-bound",
  "a TRANSITION carrying the terminal status is REFUSED — it would retire an item with no owner in sight",
  () => {
    const r = ev.validateEvent({ ...GOOD(), status: TERMINAL_STATUS_LITERAL });
    if (r.ok) return `a transition carrying '${TERMINAL_STATUS_LITERAL}' was ACCEPTED — the owner fence is bypassable one field over`;
    if (r.error !== "terminal status outside a retraction") return `refused for another reason: ${r.error}`;
    return `RED:R3 refused kind=transition status=${TERMINAL_STATUS_LITERAL} error=${r.error}`;
  },
  "a TRANSITION carrying an ordinary work-state is accepted",
  () => {
    const r = ev.validateEvent({ ...GOOD(), status: "todo:in_progress" });
    if (!r.ok) return `a normal transition was refused: ${r.error}: ${r.reason}`;
    return `GREEN:R3 accepted kind=transition status=todo:in_progress`;
  },
);

// ── ARM R5 — UN-RETIRING is an owner adjudication too ─────────────────────
//
// The retraction fence was ONE-DIRECTIONAL: retiring was owner-only, reversing it was
// unfenced, and `todo-tracker-guard.js` emits an `authority: "agent"` transition on
// every `PostToolUse:TodoWrite` — so a retired item reappearing in a todo list silently
// deleted an owner's ruling. The pair drives the same log twice, differing ONLY in the
// authority of the event that follows the retraction.

pair(
  "R5-un-retiring-is-owner-only",
  "an AGENT transition CANNOT take a retired item back out of retirement, and the attempt is RECORDED",
  () => {
    const text = [
      onDisk(transitionFor("R1-alpha-item", "journal/live.md#R1-alpha-item")),
      onDisk(RETRACTION({ item_id: "R1-alpha-item" })),
      onDisk(transitionFor("R1-alpha-item", "context.md#R1-alpha-item")), // authority: agent
    ].join("\n");
    const fold = ev.foldEvents(text);
    if (fold.retired.join(",") !== "R1-alpha-item") {
      return `an agent transition UN-RETIRED an owner's retraction — retired=${JSON.stringify(fold.retired)}`;
    }
    const row = fold.rows.get("R1-alpha-item");
    if (row.anchorRaw === "context.md#R1-alpha-item") return "the agent event lost the fence but still rewrote the row's anchor";
    const s = fold.skipped.find((x) => /RETIRED/.test(x.why));
    if (!s) return "the un-retire attempt was fenced but not RECORDED — a silent drop";
    return `RED:R5 fenced item_id=R1-alpha-item at line=${s.line} retired=preserved`;
  },
  "an OWNER transition DOES re-open it — no new kind needed — and the reversal is visible as a supersession",
  () => {
    const text = [
      onDisk(transitionFor("R1-alpha-item", "journal/live.md#R1-alpha-item")),
      onDisk(RETRACTION({ item_id: "R1-alpha-item" })),
      onDisk({ ...transitionFor("R1-alpha-item", "journal/reopen.md#R1-alpha-item"), authority: "owner" }),
    ].join("\n");
    const fold = ev.foldEvents(text);
    if (fold.retired.length !== 0) return `an OWNER could not re-open a retired item — retired=${JSON.stringify(fold.retired)}`;
    if (fold.rows.get("R1-alpha-item").anchorRaw !== "journal/reopen.md#R1-alpha-item") return "the owner's re-open did not win the fold";
    if (fold.rows.size !== 1) return `the population moved to ${fold.rows.size}`;
    if (!fold.superseded.some((x) => x.item_id === "R1-alpha-item")) {
      return "the reversal is legal but INVISIBLE — nothing records that a retraction was overridden";
    }
    return `GREEN:R5 owner re-opened item_id=R1-alpha-item retired=none superseded=recorded`;
  },
);

// ── ARM R4 — the status fences are ALLOWLISTS, not exact-match denylists ───
//
// The defect this pair pins was found by an adversarial review of the R3 arm above:
// R3 drives the EXACT literal, and both fences were exact string equality, so
// `"retired "` with a trailing space and `"Signed off "` slipped past BOTH — and a GFM
// table cell renders either exactly as the value it is impersonating. R3 was green
// against that. This pair drives the VARIANTS, which is the only shape that reds.

const LAUNDERING_VARIANTS = ["retired ", " retired", "Retired", "RETIRED", "re­tired"];
const OWNER_VARIANTS = ["Signed off ", " Signed off", "signed off", "SIGNED OFF"];

pair(
  "R4-status-fences-are-allowlists",
  "whitespace/case VARIANTS of the terminal and owner statuses are REFUSED, not just the exact literals",
  () => {
    const leaked = [];
    // The terminal-status variants are driven on an OWNER transition. That ISOLATES the
    // fence under test: an owner may carry any status, so the non-owner allowlist below
    // cannot be what refuses them, and a refusal here can only be the terminal fence.
    for (const v of LAUNDERING_VARIANTS) {
      // `re­tired` carries a SOFT HYPHEN, which NFKC does NOT remove — it is a genuinely
      // different string and SHOULD be accepted. It is the fence's negative control: a
      // normalizer aggressive enough to fold it would be refusing legitimate text, and a
      // pole where everything is refused certifies nothing.
      const expectRefusal = v !== "re­tired";
      const r = ev.validateEvent({ ...GOOD(), authority: "owner", status: v });
      if (expectRefusal && r.ok) leaked.push(`owner transition status=${JSON.stringify(v)} ACCEPTED — it retires an item outside a retraction`);
      if (expectRefusal && !r.ok && r.error !== "terminal status outside a retraction") {
        leaked.push(`${JSON.stringify(v)} refused by the WRONG fence (${r.error})`);
      }
      if (!expectRefusal && !r.ok) leaked.push(`the soft-hyphen control was REFUSED (${r.error}) — the normalizer over-reaches`);
    }
    for (const v of OWNER_VARIANTS) {
      const r = ev.validateEvent({ ...GOOD(), status: v });
      if (r.ok) leaked.push(`agent transition status=${JSON.stringify(v)} ACCEPTED — an owner adjudication no owner made`);
      // The RENDER fence has to hold independently: it sees ON-DISK records, including
      // hand-written ones the producer never validated.
      const projected = ev.projectStatus({ status: v, authority: "agent" });
      if (projected !== ev.SEE_BURNDOWN) leaked.push(`projectStatus rendered ${JSON.stringify(v)} verbatim from an agent event`);
    }
    if (leaked.length) return `the fences are still exact-match denylists: ${leaked.join("; ")}`;
    return `RED:R4 refused ${LAUNDERING_VARIANTS.length - 1} terminal + ${OWNER_VARIANTS.length} owner variant(s), soft-hyphen control accepted`;
  },
  "an OWNER may still carry an owner status, and an agent may still carry its own namespace",
  () => {
    const owner = ev.validateEvent({ ...GOOD(), authority: "owner", status: "Signed off" });
    if (!owner.ok) return `an owner's own owner-status transition was refused: ${owner.error}`;
    const agent = ev.validateEvent({ ...GOOD(), status: "todo:completed" });
    if (!agent.ok) return `an agent's todo-namespaced transition was refused: ${agent.error}`;
    const pass = ev.validateEvent({ ...GOOD(), status: ev.SEE_BURNDOWN });
    if (!pass.ok) return `the neutral passthrough was refused: ${pass.error}`;
    const projected = ev.projectStatus({ status: "Signed off", authority: "owner" });
    if (projected !== "Signed off") return `projectStatus neutralised an OWNER's own owner status: ${projected}`;
    return `GREEN:R4 accepted owner=Signed off, agent=todo:completed, agent=${ev.SEE_BURNDOWN}`;
  },
);

// ── ARM A1 — an `owner` claim is checked against the roster ROLE ───────────

pair(
  "AU1-owner-authority-is-role-bound",
  "a CONTRIBUTOR signing `authority: owner` is REFUSED and lands NOTHING",
  () => {
    const dir = mkRepo();
    try {
      const r = ev.appendEvent(dir, { ...GOOD(), authority: "owner", status: "Signed off" }, {
        identity: IDENT,
        append: fakeAppend(true),
        resolveSigner: rosterResolver({ role: "contributor" }),
      });
      if (r.ok) return "a contributor minted owner authority — the field is still self-declared";
      if (r.error !== "authority not backed by role") return `refused for another reason: ${r.error}`;
      if (logLines(dir).length !== 0) return "a refused owner claim still wrote to the log";
      return `RED:AU1 refused verified_id=FPR claimed=owner rostered_role=contributor error=${r.error}`;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  "the SAME event from a signer the committed roster rosters as `owner` is accepted",
  () => {
    const dir = mkRepo();
    try {
      const r = ev.appendEvent(dir, { ...GOOD(), authority: "owner", status: "Signed off" }, {
        identity: IDENT,
        append: fakeAppend(true),
        resolveSigner: rosterResolver({ role: "owner", host_role: "human" }),
      });
      if (!r.ok) return `an owner's own owner-authority event was refused: ${r.error}: ${r.reason}`;
      if (logLines(dir).length !== 1) return `expected 1 log line, got ${logLines(dir).length}`;
      return `GREEN:AU1 appended verified_id=FPR claimed=owner rostered_role=owner`;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ── ARM A2 — an OUTAGE is not a FORGERY ────────────────────────────────────
//
// Both poles REFUSE. What discriminates them is the THIRD state: an unreadable roster
// is `indeterminate`, a rostered contributor is not. Reporting a verification outage as
// a forgery sends the operator hunting an adversary who is not there and leaves the
// real fault — the unreadable roster — unrepaired.

pair(
  "AU2-outage-is-indeterminate-not-forgery",
  "an UNREADABLE roster refuses as INDETERMINATE and says the roster could not be read",
  () => {
    const dir = mkRepo();
    try {
      const resolve = ev.makeRosterSignerResolver(dir, {
        readRoster: () => {
          const e = new Error("fixture: the roster blob is unavailable");
          throw e;
        },
      });
      const r = ev.appendEvent(dir, { ...GOOD(), authority: "owner", status: "Signed off" }, {
        identity: IDENT,
        append: fakeAppend(true),
        resolveSigner: resolve,
      });
      if (r.ok) return "an unreadable roster ACCEPTED an owner claim — the fence fails OPEN";
      // READ OFF THE INSTRUMENT UNDER TEST. An earlier revision of this pole asserted
      // `indeterminate` from a SEPARATE `verifyAuthorityClaim` call and then reported
      // `state=INDETERMINATE` about `appendEvent` — a verdict claiming a property the
      // instrument under test never reported (`instrument-discipline.md` MUST-4), inside
      // a fixture written to enforce instrument discipline. It also concealed that
      // `appendEvent` was flattening three states to two.
      if (r.indeterminate !== true) return "appendEvent's OWN refusal does not carry the third state — an outage is indistinguishable from a rejected claim on the only write path";
      if (!/roster/i.test(r.reason)) return `the refusal does not name the roster: ${r.reason.slice(0, 120)}`;
      if (logLines(dir).length !== 0) return "a refused owner claim still wrote to the log";
      return `RED:AU2 refused state=INDETERMINATE error=${r.error}`;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  "a READABLE roster that rosters the signer as contributor refuses as a POSITIVE finding, not an outage",
  () => {
    const resolve = rosterResolver({ role: "contributor" });
    const claim = ev.verifyAuthorityClaim({ authority: "owner", verified_id: "FPR", person_id: "pid-fixture" }, resolve);
    if (claim.ok) return "a contributor's owner claim was accepted";
    if (claim.indeterminate) return "a decidable, FALSE claim was reported as an outage — the operator is sent to fix a roster that is fine";
    return `GREEN:AU2 refused state=INVALID error=${claim.error}`;
  },
);

// ── ARM A3 — an audit-only CI host is NEVER eligible ───────────────────────

pair(
  "AU3-ci-host-is-audit-only",
  "a person rostered `owner` on a CI host is REFUSED, naming R5-S-04",
  () => {
    const claim = ev.verifyAuthorityClaim(
      { authority: "owner", verified_id: "FPR", person_id: "pid-fixture" },
      rosterResolver({ role: "owner", host_role: "ci" }),
    );
    if (claim.ok) return "a deploy key asserted owner authority — R5-S-04 is not enforced here";
    if (claim.indeterminate) return "an INELIGIBLE host was reported as an outage rather than as a decided refusal";
    // The IDENTITY is asserted on the REASON, not on a distinct error code. The CI
    // exclusion is decided by `eligibility.js::isEligibleSigner` (the SSOT) rather than
    // by an inlined `host_role === "ci"`, so it surfaces under the delegate's single
    // error with the delegate's own R5-S-04 wording — which is what a reader needs and
    // what a fourth inlined copy of the predicate would have cost.
    if (!/R5-S-04/.test(claim.reason)) return `refused without naming R5-S-04: ${claim.reason.slice(0, 160)}`;
    if (!/audit-only/.test(claim.reason)) return `refused without naming the audit-only class: ${claim.reason.slice(0, 160)}`;
    return `RED:AU3 refused host_role=ci role=owner via=eligibility.js/R5-S-04`;
  },
  "the same person on a HUMAN host is eligible",
  () => {
    const claim = ev.verifyAuthorityClaim(
      { authority: "owner", verified_id: "FPR", person_id: "pid-fixture" },
      rosterResolver({ role: "owner", host_role: "human" }),
    );
    if (!claim.ok) return `a human owner was refused: ${claim.error}: ${claim.reason}`;
    if (claim.bound !== true) return "the claim was accepted WITHOUT being bound — a pass that checked nothing";
    return `GREEN:AU3 accepted host_role=human role=owner person_id=${claim.person_id}`;
  },
);

// ── ARM A4 — the DEFAULT is the real roster read, and it fails CLOSED ──────
//
// The one property no injected-resolver case can establish: that a caller who supplies
// NO resolver gets the committed-roster read rather than a permissive default. The
// fixture repo is a bare temp directory with no git history, so the real read CANNOT
// succeed — and the arm asserts it refuses rather than falling back.

pair(
  "AU4-absent-resolver-fails-closed",
  "with NO resolver injected and no committed roster reachable, an `owner` claim REFUSES",
  () => {
    const dir = mkRepo();
    try {
      const r = ev.appendEvent(dir, { ...GOOD(), authority: "owner", status: "Signed off" }, {
        identity: IDENT,
        append: fakeAppend(true),
      });
      if (r.ok) return "the DEFAULT path accepted a self-declared owner claim — the binding is opt-in, which is no binding";
      if (logLines(dir).length !== 0) return "a refused owner claim still wrote to the log";
      if (!/roster/i.test(r.reason)) return `refused, but not on the roster: ${r.error}: ${r.reason.slice(0, 160)}`;
      return `RED:AU4 refused default-path error=${r.error}`;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  "an `agent` claim on the SAME repo, with the SAME absent resolver, still appends",
  () => {
    const dir = mkRepo();
    try {
      const r = ev.appendEvent(dir, GOOD(), { identity: IDENT, append: fakeAppend(true) });
      if (!r.ok) return `an agent transition was refused: ${r.error}: ${r.reason}`;
      if (logLines(dir).length !== 1) return `expected 1 log line, got ${logLines(dir).length}`;
      return `GREEN:AU4 appended default-path authority=agent`;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ── standalone: the remaining refusal branches of the binding ──────────────

check("retraction · a retraction for an UNKNOWN item_id folds to NOTHING, and is recorded", () => {
  // Without the fence it would CREATE a row — already retired, never linked, counted in
  // both the ROW FLOOR and the RETIRED denominator. It never shrinks the population, so
  // the min_rows premise survives either way; what it does is inflate the board with a
  // phantom nobody can trace.
  const text = [onDisk(transitionFor("R1-alpha-item", "journal/live.md#R1-alpha-item")), onDisk(RETRACTION({ item_id: "R9-never-existed" }))].join("\n");
  const fold = ev.foldEvents(text);
  if (fold.rows.has("R9-never-existed")) return "a retraction CREATED a row for an item no event ever held";
  if (fold.rows.size !== 1) return `the population moved to ${fold.rows.size}, not 1`;
  if (fold.retired.length !== 0) return `the phantom was counted as retired: ${JSON.stringify(fold.retired)}`;
  const s = fold.skipped.find((x) => /R9-never-existed/.test(x.why));
  if (!s) return "the phantom retraction was dropped SILENTLY rather than recorded in skipped[]";
  return true;
});

check("append · a caller half carrying a STAMPED field is REFUSED before anything is written", () => {
  // `appendStamped` pins the envelope after the partial (2026-09-27), but an injected
  // appender (`o.append`, as here) may not: a caller `verified_id` could then land a
  // record whose signer is not the identity the authority fence adjudicated. `validateEvent` cannot host this check — it is shared with
  // `validateRecord`, where those fields are REQUIRED.
  const dir = mkRepo();
  try {
    for (const f of ["verified_id", "person_id", "sig", "seq", "id"]) {
      const r = ev.appendEvent(dir, { ...GOOD(), [f]: "attacker-supplied" }, { identity: IDENT, append: fakeAppend(true) });
      if (r.ok) return `a caller half carrying '${f}' was APPENDED — the stamped envelope is caller-overridable`;
      if (r.error !== "caller half carries a stamped field") return `'${f}' refused for another reason: ${r.error}`;
    }
    if (logLines(dir).length !== 0) return "a refused append still wrote to the log";
    return true;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("authority · a MIXED finding set reports BOTH counts, never all-as-unbacked", () => {
  const resolve = rosterResolver({ role: "contributor" });
  const text = [
    // rostered, but as `contributor` → a DECIDED refusal
    onDisk({ ...GOOD(), authority: "owner", status: "Signed off" }, { verified_id: "FPR", person_id: "pid-fixture" }),
    // absent from the roster entirely → INDETERMINATE, an outage rather than a claim
    onDisk({ ...GOOD(), authority: "owner", status: "Signed off" }, { verified_id: "NOT-IN-THE-ROSTER", person_id: "pid-fixture" }),
  ].join("\n");
  const r = ev.verifyAuthorityBindings(text, resolve);
  if (r.ok) return "a mixed set produced no findings";
  if (r.checked !== 2) return `expected checked=2, got ${r.checked}`;
  if (r.unbackedCount !== 1 || r.indeterminateCount !== 1) {
    return `the counts collapsed: unbacked=${r.unbackedCount} indeterminate=${r.indeterminateCount}`;
  }
  if (r.indeterminate !== false) return "a set containing a DECIDED finding was flagged wholly indeterminate";
  return true;
});

check("mirror · ROSTER_ROLES / ROSTER_HOST_ROLES match operators.roster.schema.json", () => {
  // A third hardcoded copy of these enums (after `eligibility.js` and
  // `business-roles.js`) with NOTHING asserting it: adding a role to the schema would
  // silently turn every legitimate signer of that role INDETERMINATE and nothing would
  // red. Same disposition the OWNER_STATUSES mirror takes against the generator.
  const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".claude", "operators.roster.schema.json"), "utf8"));
  const person = schema.properties.persons.additionalProperties || schema.properties.persons.patternProperties;
  const roles = person && person.properties && person.properties.role && person.properties.role.enum;
  const hosts = person && person.properties && person.properties.host_role && person.properties.host_role.enum;
  if (!Array.isArray(roles) || !Array.isArray(hosts)) return "could not locate the role/host_role enums in the schema — the mirror is unverifiable";
  if (JSON.stringify(roles) !== JSON.stringify([...ev.ROSTER_ROLES])) {
    return `role mirror DRIFTED: schema=${JSON.stringify(roles)} lib=${JSON.stringify([...ev.ROSTER_ROLES])}`;
  }
  if (JSON.stringify(hosts) !== JSON.stringify([...ev.ROSTER_HOST_ROLES])) {
    return `host_role mirror DRIFTED: schema=${JSON.stringify(hosts)} lib=${JSON.stringify([...ev.ROSTER_HOST_ROLES])}`;
  }
  return true;
});

check("mirror · the ledger-authority signing context is DECLARED in the eligibility SSOT", () => {
  // `verifyAuthorityClaim` delegates the CI exclusion + role floor to
  // `eligibility.js::isEligibleSigner` under this context. An unknown context there
  // returns `eligible:false` for EVERY signer — fail-closed, but it would refuse every
  // legitimate owner too, and the failure would read as a roster problem.
  const elig = require(path.join(REPO_ROOT, ".claude", "hooks", "lib", "eligibility.js"));
  const ctx = ev.SIGNING_CONTEXT_FOR_AUTHORITY.owner;
  if (!elig.CI_FOREVER_INELIGIBLE_CONTEXTS.includes(ctx)) return `'${ctx}' is not declared CI-forever-ineligible in eligibility.js`;
  const ci = elig.isEligibleSigner({ role: "owner", host_role: "ci" }, ctx);
  if (ci.eligible) return `'${ctx}' admits an owner on a CI host — R5-S-04 is not enforced for it`;
  const senior = elig.isEligibleSigner({ role: "senior", host_role: "human" }, ctx);
  if (senior.eligible) return `'${ctx}' admits a SENIOR — the ledger authority floor has widened past owner`;
  const owner = elig.isEligibleSigner({ role: "owner", host_role: "human" }, ctx);
  if (!owner.eligible) return `'${ctx}' refuses a human owner: ${owner.reason}`;
  return true;
});

check("mirror · the terminal-status literal this suite drives matches RETIRED_STATUS", () => {
  if (ev.RETIRED_STATUS !== TERMINAL_STATUS_LITERAL) {
    return `the suite drives '${TERMINAL_STATUS_LITERAL}' while the library exports ${JSON.stringify(ev.RETIRED_STATUS)} — every R3 case is now testing a status the library does not recognise`;
  }
  return true;
});

check("authority · a stamped person_id that disagrees with the roster is a POSITIVE finding", () => {
  const claim = ev.verifyAuthorityClaim(
    { authority: "owner", verified_id: "FPR", person_id: "pid-someone-else" },
    rosterResolver({ role: "owner", host_role: "human", pid: "pid-fixture" }),
  );
  if (claim.ok) return "an event signed by one person and attributed to another was accepted";
  if (claim.error !== "authority person_id mismatch") return `refused for another reason: ${claim.error}`;
  if (claim.indeterminate) return "a decided mismatch was reported as an outage";
  return true;
});

check("authority · a roster entry with NO declared role is INDETERMINATE, never a pass", () => {
  const claim = ev.verifyAuthorityClaim(
    { authority: "owner", verified_id: "FPR", person_id: "pid-fixture" },
    rosterResolver({ omitRole: true, host_role: "human" }),
  );
  if (claim.ok) return "a person with no declared role carried owner authority";
  if (claim.indeterminate !== true) return "an undeclared role was reported as a decided refusal rather than as an outage";
  if (claim.error !== "unrecognized roster role") return `refused for another reason: ${claim.error}`;
  return true;
});

check("authority · a roster entry with NO declared host_role is INDETERMINATE, never a pass", () => {
  const claim = ev.verifyAuthorityClaim(
    { authority: "owner", verified_id: "FPR", person_id: "pid-fixture" },
    rosterResolver({ role: "owner", omitHostRole: true }),
  );
  if (claim.ok) return "a person with no declared host_role carried owner authority — an audit-only CI host would pass here";
  if (claim.indeterminate !== true) return "an undeclared host_role was reported as a decided refusal rather than as an outage";
  if (claim.error !== "unrecognized roster host_role") return `refused for another reason: ${claim.error}`;
  return true;
});

check("authority · a signer absent from the roster is INDETERMINATE, never a pass", () => {
  const claim = ev.verifyAuthorityClaim(
    { authority: "owner", verified_id: "SOME-OTHER-FPR", person_id: "pid-fixture" },
    rosterResolver({ role: "owner", host_role: "human" }),
  );
  if (claim.ok) return "an unrostered signer carried owner authority";
  if (claim.indeterminate !== true) return "an unrostered signer was reported as a forgery rather than as an outage";
  return true;
});

check("authority · a HALF-DECLARED roster key entry resolves no role — INDETERMINATE, not a pass", () => {
  // The same admission predicate the SIGNATURE path uses. An entry carrying a
  // fingerprint but no pubkey/type is skipped there, so admitting it here would make a
  // signer `unrostered-signer` for signatures and role-resolvable for authority — the
  // asymmetry an attacker looks for.
  const doc = rosterDoc({ role: "owner", host_role: "human" });
  delete doc.persons["pid-fixture"].keys[0].pubkey;
  const resolve = ev.makeRosterSignerResolver("/nonexistent-fixture-repo", { readRoster: () => JSON.stringify(doc) });
  const claim = ev.verifyAuthorityClaim({ authority: "owner", verified_id: "FPR", person_id: "pid-fixture" }, resolve);
  if (claim.ok) return "a half-declared key entry carried owner authority — looser than the signature path";
  if (claim.indeterminate !== true) return "a roster gap was reported as a decided refusal rather than as an outage";
  if (claim.error !== "unrostered signer") return `refused for another reason: ${claim.error}`;
  return true;
});

check("authority · an `agent` claim needs no backing, and SAYS it was not bound", () => {
  const claim = ev.verifyAuthorityClaim({ authority: "agent", verified_id: "FPR" }, rosterResolver({ role: "contributor" }));
  if (!claim.ok) return `an agent claim was refused: ${claim.error}`;
  if (claim.bound !== false) return "an agent claim reported itself as ROLE-BOUND — a pass that claims a check it never made";
  return true;
});

check("authority · verifyAuthorityBindings counts ONLY role-bound claims, and reds on an unbacked one", () => {
  const resolve = rosterResolver({ role: "contributor" });
  const agentOnly = ev.verifyAuthorityBindings(onDisk(GOOD()), resolve);
  if (!agentOnly.ok) return `an agent-only log produced findings: ${JSON.stringify(agentOnly.findings)}`;
  if (agentOnly.checked !== 0) return `an agent-only log reported checked=${agentOnly.checked}, not 0`;
  const withOwner = ev.verifyAuthorityBindings(onDisk({ ...GOOD(), authority: "owner", status: "Signed off" }), resolve);
  if (withOwner.ok) return "an unbacked owner claim passed the read-gate sweep";
  if (withOwner.checked !== 1) return `expected checked=1, got ${withOwner.checked}`;
  if (withOwner.findings[0].kind !== "authority-unbacked") return `finding kind is ${withOwner.findings[0].kind}`;
  if (withOwner.indeterminate) return "a decided refusal was reported as an outage";
  return true;
});

// ── standalone: the mirrored constants have not drifted ────────────────────
//
// `burndown-events.js` MIRRORS the generator's closed status vocabulary rather than
// importing it (the generator is an ESM bin entrypoint with no export surface, and
// requiring it would execute its CLI). A mirror is a drift risk, so it is ASSERTED
// against the generator here rather than assumed there.
// ── ARMS CS — THE COUNTERSIGNED TRANSITION (component 13) ──────────────────
//
// The mechanism's whole claim is a DISCRIMINATION: the fold does NOT honour an
// unactivated proposal and DOES honour an activated one. CS1 runs exactly that, on
// ONE log differing by ONE line, so neither pole can be explained by anything else.
// The falsifying result is nameable in advance and is what the RED pole asserts does
// NOT occur: were a proposal honoured, `foldProjection` would project the PROPOSED
// owner status from a record declaring `authority: "agent"`.
//
// The remaining arms close the ways the countersignature could be made to say
// something nobody countersigned — an agent activating its own proposal (CS2), an
// agent naming ITSELF as the acceptor (CS3), and an activation landing a status other
// than the one proposed (CS4). CS5 asserts the `AGENT_ACCEPTORS` mirror against
// `check-archive-adjudication.mjs`, which is where this shape was taken from.

const PROPOSAL_REC = "rec_FIXTURE_PROPOSAL_1";

const PROPOSAL = (over = {}) => ({
  ...ev.buildEvent({
    kind: "proposal",
    item_id: "R1-alpha-item",
    item: "an alpha item",
    value_anchor: "journal/0001-a.md#R1-alpha-item",
    authority: "agent",
    source: "fixture",
    proposed_status: "Signed off",
    reason: "the owner approved closing this in session; measured closed",
  }),
  ...over,
});

const ACTIVATION = (over = {}) => ({
  ...ev.buildEvent({
    kind: "activation",
    item_id: "R1-alpha-item",
    item: "an alpha item",
    value_anchor: "journal/0001-a.md#R1-alpha-item",
    status: "Signed off",
    authority: "owner",
    source: "fixture",
    activates: PROPOSAL_REC,
    accepted_by: "someoperator (co-owner)",
  }),
  ...over,
});

// The genesis this item enters the fold with. Its projected status is the NEUTRAL
// passthrough, because `projectStatus` neutralises an owner-vocabulary status carried
// by a non-owner event — so "the proposal was not honoured" and "the genesis still
// holds the row" are the SAME observation, which is what makes the RED pole readable.
const CS_GENESIS = () => onDisk(genesisFor("R1-alpha-item", "journal/0001-a.md#R1-alpha-item"));

pair(
  "CS1-a-proposal-is-inert-until-countersigned",
  "an UNACTIVATED proposal changes NOTHING — the fold refuses to honour it, and says so",
  () => {
    const text = [CS_GENESIS(), onDisk(PROPOSAL(), { id: PROPOSAL_REC })].join("\n");
    const fold = ev.foldProjection(text);
    const row = fold.rows.get("R1-alpha-item");
    if (!row) return "the item vanished from the fold entirely";
    if (row.status === "Signed off") {
      return `THE FALSIFYING RESULT OCCURRED: an unactivated proposal was HONOURED — the row projects 'Signed off' from a record declaring authority 'agent', which is the laundering channel this component must not build`;
    }
    // NOT-FOLDED IS ASSERTED AS A MECHANISM, NOT INFERRED FROM THE STATUS — and this
    // is a measured correction, not belt-and-braces. Dropping the fold's `continue`
    // and running this pole as it FIRST stood left it GREEN: the proposal fell through
    // into `rows.set` and the row still read 'see burndown', because a proposal's own
    // `status` is DERIVED to the neutral passthrough and `projectStatus` passes that
    // verbatim. A real defense-in-depth SIBLING was absorbing the mutation, so the
    // status check alone could not tell inert from folded-but-harmless.
    //
    // These two can: a folded proposal WINS its item, so it supersedes the event that
    // held the row and becomes the winning ordinal. Both are observable whatever
    // status it carries.
    if (fold.superseded.length !== 0) {
      return `the proposal SUPERSEDED the event holding the row (${JSON.stringify(fold.superseded)}) — it was folded, and only the neutral derived status is hiding it`;
    }
    if (row.line !== 1) {
      return `the winning ordinal moved to line ${row.line} — the proposal (line 2) took the row from the genesis (line 1), so it was folded`;
    }
    if (fold.pendingProposals.length !== 1) {
      return `the proposal folded to nothing AND reported nothing: pendingProposals=${JSON.stringify(fold.pendingProposals)} — an invisible inert record reproduces the failure this mechanism closes`;
    }
    const s = fold.skipped.find((x) => /INERT/.test(x.why));
    if (!s) return "the proposal was fenced out but not RECORDED in skipped[] — a silent drop";
    // ── THE DIRECT PIN: "CHANGES NOTHING" IS ASSERTED AS EQUALITY ───────────
    //
    // Everything above tests PROPERTIES a folded proposal would violate — the
    // status, the supersession, the winning ordinal. A property list is only ever
    // as complete as its author's imagination, and "the fold ignores it" is the
    // claim a future author will most want to relax. So the pin is EQUALITY: fold
    // the SAME log with the proposal line and without it, and require the two
    // projections to be INDISTINGUISHABLE.
    //
    // That is the whole claim, not a proxy for it. Any cell a proposal touched —
    // a status, an anchor, an item text, an ordinal, a row appearing or vanishing
    // — makes the two objects differ, including cells nobody thought to enumerate.
    // The bookkeeping the mechanism is REQUIRED to move (`skipped`,
    // `pendingProposals`, `considered`) is deliberately outside this comparison
    // and is asserted separately above; those are the record OF the proposal, not
    // an effect of it.
    const withoutProposal = ev.foldProjection(CS_GENESIS());
    const a = JSON.stringify([...withoutProposal.rows.entries()]);
    const b = JSON.stringify([...fold.rows.entries()]);
    if (a !== b) {
      return `THE PROJECTION MOVED. Folding the same log WITHOUT the proposal line gives ${a}; WITH it gives ${b}. A proposal changed a cell, which is the one thing it must never do`;
    }
    return `RED:CS1 proposal INERT item=R1-alpha-item status=${row.status} pending=${fold.pendingProposals[0].record_id} skippedLine=${s.line} projection IDENTICAL with and without the line`;
  },
  "the SAME log plus ONE activation line lands the proposed status",
  () => {
    const text = [CS_GENESIS(), onDisk(PROPOSAL(), { id: PROPOSAL_REC }), onDisk(ACTIVATION())].join("\n");
    const fold = ev.foldProjection(text);
    const row = fold.rows.get("R1-alpha-item");
    if (!row) return "the item vanished from the fold entirely";
    if (row.status !== "Signed off") {
      return `an ACTIVATED proposal was NOT honoured — the row projects '${row.status}'; the mechanism cannot land a decision at all, so its inertness proves nothing`;
    }
    if (fold.pendingProposals.length !== 0) {
      return `the activated proposal is STILL reported pending: ${JSON.stringify(fold.pendingProposals)}`;
    }
    if (fold.proposals.length !== 1) return `the proposal left the record: proposals=${JSON.stringify(fold.proposals)}`;
    return `GREEN:CS1 activation HONOURED item=R1-alpha-item status=${row.status} pending=0`;
  },
);

pair(
  "CS2-an-agent-cannot-activate",
  "an activation declaring `authority: agent` is REFUSED — the proposing party cannot activate",
  () => {
    const r = ev.validateEvent(ACTIVATION({ authority: "agent" }));
    if (r.ok) return "an AGENT activation was ACCEPTED — the agent-cannot-assign-an-owner-status fence is bypassable through the new kind, which is the one thing this component must not do";
    if (r.error !== "activation requires owner authority") return `refused for another reason: ${r.error}`;
    return `RED:CS2 refused kind=activation authority=agent error=${r.error}`;
  },
  "the same activation under OWNER authority validates",
  () => {
    const r = ev.validateEvent(ACTIVATION());
    if (!r.ok) return `an owner activation was refused: ${r.error}: ${r.reason}`;
    return `GREEN:CS2 accepted kind=activation authority=owner`;
  },
);

pair(
  "CS3-the-acceptor-must-be-a-human",
  "an activation naming an AGENT as `accepted_by` is REFUSED — MUST-6, inside the signed bytes",
  () => {
    // Every refused word, including a whitespace/case variant, because `accepted_by`
    // is rendered to a human reviewer and `" Claude "` reads as a name.
    const tried = [...ev.AGENT_ACCEPTORS, "  Claude  ", "ASSISTANT"];
    const accepted = tried.filter((w) => ev.validateEvent(ACTIVATION({ accepted_by: w })).ok);
    if (accepted.length) {
      return `ACCEPTED an agent acceptor: ${JSON.stringify(accepted)} — the party proposing would be accepting its own residual (completion-criterion.md MUST-6)`;
    }
    const r = ev.validateEvent(ACTIVATION({ accepted_by: "claude" }));
    if (r.error !== "activation accepted by an agent") return `refused for another reason: ${r.error}`;
    return `RED:CS3 refused ${tried.length} agent acceptor(s) error=${r.error}`;
  },
  "an activation naming a HUMAN acceptor validates",
  () => {
    const r = ev.validateEvent(ACTIVATION({ accepted_by: "someoperator (co-owner)" }));
    if (!r.ok) return `a human acceptor was refused: ${r.error}: ${r.reason}`;
    return `GREEN:CS3 accepted accepted_by='someoperator (co-owner)'`;
  },
);

pair(
  "CS4-an-activation-lands-what-was-PROPOSED",
  "an activation carrying a status the proposal did NOT propose is fenced OUT of the fold",
  () => {
    // The activation is WELL-FORMED — `validateEvent` accepts it, because agreement
    // with the proposal is a whole-log fact one line cannot decide. So this pole is
    // the FOLD's fence, not the producer's, and a check that only ran the validator
    // would score it clean.
    const bumped = ACTIVATION({ status: "Blocked on you" });
    if (!ev.validateEvent(bumped).ok) return "the mismatched activation was refused by validateEvent — this pole no longer tests the FOLD fence it exists to test";
    const text = [CS_GENESIS(), onDisk(PROPOSAL(), { id: PROPOSAL_REC }), onDisk(bumped)].join("\n");
    const fold = ev.foldProjection(text);
    const row = fold.rows.get("R1-alpha-item");
    if (row.status === "Blocked on you") {
      return `the fold HONOURED a status nobody proposed — the ceremony authorised 'Signed off' and landed 'Blocked on you'`;
    }
    if (fold.pendingProposals.length !== 1) return `the proposal stopped reading as pending after a REFUSED activation: ${JSON.stringify(fold.pendingProposals)}`;
    const s = fold.skipped.find((x) => /proposes 'Signed off' but this activation carries/.test(x.why));
    if (!s) return "the mismatch was fenced out but not RECORDED in skipped[] — a silent drop";
    return `RED:CS4 mismatch fenced line=${s.line} status stayed ${row.status} pending=1`;
  },
  "an activation carrying the PROPOSED status folds",
  () => {
    const text = [CS_GENESIS(), onDisk(PROPOSAL(), { id: PROPOSAL_REC }), onDisk(ACTIVATION())].join("\n");
    const fold = ev.foldProjection(text);
    const row = fold.rows.get("R1-alpha-item");
    if (row.status !== "Signed off") return `the matching activation did not fold: '${row.status}'`;
    return `GREEN:CS4 matching activation folded status=${row.status} pending=0`;
  },
);

pair(
  "CS5-an-activation-needs-a-counterparty",
  "an activation naming NO proposal in this log is fenced OUT — a countersignature with no counterparty",
  () => {
    const orphan = ACTIVATION({ activates: "rec_NOT_IN_THIS_LOG" });
    if (!ev.validateEvent(orphan).ok) return "the orphan activation was refused by validateEvent — this pole no longer tests the FOLD fence";
    const text = [CS_GENESIS(), onDisk(orphan)].join("\n");
    const fold = ev.foldProjection(text);
    const row = fold.rows.get("R1-alpha-item");
    if (row.status === "Signed off") {
      return `an activation with NO proposal was HONOURED — it is just an owner transition wearing a ceremony that never happened`;
    }
    const s = fold.skipped.find((x) => /no proposal with that record id/.test(x.why));
    if (!s) return "the orphan was fenced out but not RECORDED in skipped[] — a silent drop";
    return `RED:CS5 orphan activation fenced line=${s.line} status stayed ${row.status}`;
  },
  "the same activation WITH its proposal present folds",
  () => {
    const text = [CS_GENESIS(), onDisk(PROPOSAL(), { id: PROPOSAL_REC }), onDisk(ACTIVATION())].join("\n");
    const fold = ev.foldProjection(text);
    const row = fold.rows.get("R1-alpha-item");
    if (row.status !== "Signed off") return `the activation with its proposal present did not fold: '${row.status}'`;
    return `GREEN:CS5 activation with counterparty folded status=${row.status}`;
  },
);

pair(
  "CS6-the-population-and-the-gate-arithmetic-are-unmoved",
  "LOSING the proposal line is invisible to the population — which is why the fold must REPORT it, not merely not-fold it",
  () => {
    const full = [CS_GENESIS(), onDisk(PROPOSAL(), { id: PROPOSAL_REC })];
    const withP = ev.foldEvents(full.join("\n"));
    const without = ev.foldEvents(full[0]);
    if (withP.rows.size !== without.rows.size) {
      return `a proposal MOVED the folded population ${without.rows.size} → ${withP.rows.size}; the tracker.min_rows floor rests on that population and would now fire on an inert record`;
    }
    if (withP.pendingProposals.length !== 1 || without.pendingProposals.length !== 0) {
      return `the ONLY observable difference vanished: with=${withP.pendingProposals.length} without=${without.pendingProposals.length}`;
    }
    return `RED:CS6 population unmoved at ${withP.rows.size}; the proposal is visible ONLY via pendingProposals (${withP.pendingProposals.length} vs ${without.pendingProposals.length})`;
  },
  "the read gate's two arithmetic cross-checks still balance with a proposal AND an activation present",
  () => {
    // The exact derivations `burndown-build.mjs::foldLedgerEvents` refuses on. A
    // proposal is `considered` and lands in `skipped[]` but never in `rows`, so both
    // identities must still hold or the READ GATE refuses every build.
    const text = [CS_GENESIS(), onDisk(PROPOSAL(), { id: PROPOSAL_REC }), onDisk(ACTIVATION())];
    const fold = ev.foldEvents(text.join("\n"));
    const malformed = fold.skipped.filter((s) => {
      try {
        return !ev.validateEvent(JSON.parse(text[s.line - 1])).ok;
      } catch {
        return true;
      }
    });
    const derivedSuperseded = fold.considered - fold.rows.size - (fold.skipped.length - malformed.length);
    if (derivedSuperseded !== fold.superseded.length) {
      return `SUPERSESSION ARITHMETIC BROKEN: the gate derives ${derivedSuperseded} and the fold reports ${fold.superseded.length} — burndown-build.mjs refuses on exactly this disagreement, so every build would fail`;
    }
    if (text.length - fold.considered !== malformed.length) {
      return `MALFORMED ARITHMETIC BROKEN: nonBlank-considered=${text.length - fold.considered} malformed=${malformed.length}`;
    }
    return `GREEN:CS6 both gate identities balance superseded=${derivedSuperseded}=${fold.superseded.length} malformed=${malformed.length}`;
  },
);

check("mirror · AGENT_ACCEPTORS matches check-archive-adjudication.mjs", () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, ".claude", "bin", "check-archive-adjudication.mjs"), "utf8");
  const m = src.match(/const AGENT_ACCEPTORS = new Set\(\[([\s\S]*?)\]\)/);
  if (!m) return "could not locate AGENT_ACCEPTORS in check-archive-adjudication.mjs — the mirror is unverifiable";
  const theirs = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  const mine = [...ev.AGENT_ACCEPTORS];
  if (JSON.stringify(theirs) !== JSON.stringify(mine)) {
    return `mirror DRIFTED: checker=${JSON.stringify(theirs)} lib=${JSON.stringify(mine)}`;
  }
  return true;
});

check("standalone · a proposal's own status is DERIVED, so no surface renders its claim", () => {
  // `projectStatus` is the render-time fence. A proposal never reaches it (the fold
  // drops the record), so this asserts the SECOND line of defence: even read directly,
  // the record's `status` field carries no owner claim.
  const p = PROPOSAL();
  if (p.status !== ev.PROPOSAL_STATUS) return `buildEvent did not derive the status: '${p.status}'`;
  if (ev.OWNER_STATUSES.some((s) => ev.statusKey(s) === ev.statusKey(p.status))) {
    return `a proposal's own status '${p.status}' is IN the owner vocabulary — any reader of 'status' would render an owner adjudication`;
  }
  const forced = ev.validateEvent({ ...p, status: "Signed off" });
  if (forced.ok) return "a proposal carrying an owner status in its OWN status field was ACCEPTED";
  return true;
});

check("mirror · OWNER_STATUSES matches burndown-build.mjs::ASSIGNABLE", () => {
  const src = fs.readFileSync(GENERATOR, "utf8");
  const m = src.match(/const ASSIGNABLE = Object\.freeze\(\[([\s\S]*?)\]\)/);
  if (!m) return "could not locate ASSIGNABLE in burndown-build.mjs — the mirror is unverifiable";
  const generator = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  const mine = [...ev.OWNER_STATUSES];
  if (JSON.stringify(generator) !== JSON.stringify(mine)) {
    return `mirror DRIFTED: generator=${JSON.stringify(generator)} lib=${JSON.stringify(mine)}`;
  }
  return true;
});

// ── standalone: every skip carries its PRODUCER class ──────────────────────
//
// `skipped[]` holds lines the fold could not READ and well-formed records a fence
// declined. Consumers that counted `skipped.length` as "unreadable" reported a pending
// proposal as corruption (the durable-todo guard) and refused the shared ledger over a
// clean log (`session-notes-layout.js::regenerateForestLedger`). The class is now set
// at each `skipped.push` site; this pins all nine against one log, by line, and pins
// `partitionSkips`' grouping — including that a kindless entry FAILS CLOSED.
check("skip kinds · every skipped[] entry carries its producer class, and partitionSkips groups by it", () => {
  const text = [
    "{not json", // 1 unparseable
    onDisk({ ...GOOD(), schema: "burndown-event/v99" }), // 2 invalid-record
    onDisk(genesisFor("R2-beta-item", "journal/0001-a.md#R2-beta-item")), // 3 folds
    onDisk(transitionFor("R2-beta-item", "journal/live.md#R2-beta-item")), // 4 live, supersedes
    onDisk(genesisFor("R2-beta-item", "journal/0001-a.md#R2-beta-item")), // 5 baseline-under-live
    onDisk(PROPOSAL(), { id: PROPOSAL_REC }), // 6 proposal-inert, pending
    onDisk(ACTIVATION({ activates: "rec_FIXTURE_NO_SUCH_PROPOSAL" })), // 7 activation-orphan
    onDisk(ACTIVATION({ item_id: "R2-beta-item" })), // 8 activation-item-mismatch
    onDisk(ACTIVATION({ status: "In progress" })), // 9 activation-status-mismatch
    onDisk(transitionFor("R1-alpha-item", "journal/live.md#R1-alpha-item")), // 10 folds
    onDisk(RETRACTION({ item_id: "R1-alpha-item" })), // 11 retires
    onDisk(transitionFor("R1-alpha-item", "context.md#R1-alpha-item")), // 12 retired-non-owner
    onDisk(RETRACTION({ item_id: "R9-never-existed" })), // 13 retraction-phantom
  ].join("\n");
  const fold = ev.foldEvents(text);
  const got = fold.skipped.map((s) => `${s.line}:${s.kind}`).join(" ");
  const want =
    "1:unparseable 2:invalid-record 5:baseline-under-live 6:proposal-inert 7:activation-orphan " +
    "8:activation-item-mismatch 9:activation-status-mismatch 12:retired-non-owner 13:retraction-phantom";
  if (got !== want) return `skip kinds drifted: got "${got}", want "${want}"`;
  const inert = fold.skipped.find((s) => s.kind === "proposal-inert");
  if (inert.item_id !== "R1-alpha-item" || inert.record_id !== PROPOSAL_REC) {
    return `the inert proposal's skip does not NAME what is outstanding: ${JSON.stringify(inert)}`;
  }
  const p = ev.partitionSkips(fold);
  const shape = Object.entries(p)
    .map(([k, v]) => `${k}=${v.map((s) => s.line).join(",")}`)
    .join(" ");
  const wantShape = "unreadable=1,2 unclassified= awaitingActivation=6 resolvedProposals= fenced=5,7,8,9,12,13";
  if (shape !== wantShape) return `partition drifted: got "${shape}", want "${wantShape}"`;
  if (ev.partitionSkips({ skipped: [{ line: 1, why: "no kind" }] }).unclassified.length !== 1) {
    return "a kindless skip was not FAIL-CLOSED into unclassified";
  }
  return true;
});

// ── standalone: the refusal vocabulary is CLOSED ───────────────────────────
for (const [name, mutate] of [
  ["an unknown kind", (e) => ({ ...e, kind: "invented" })],
  ["a genesis wearing live weight", (e) => ({ ...e, kind: "genesis", weight: "live" })],
  ["a genesis claiming owner authority", (e) => ({ ...e, kind: "genesis", weight: "migration_baseline", authority: "owner" })],
  ["an agent assigning an owner status", (e) => ({ ...e, status: "Signed off" })],
  ["an unknown schema", (e) => ({ ...e, schema: "burndown-event/v99" })],
]) {
  check(`refusal · ${name} is REFUSED with a named error`, () => {
    const r = ev.validateEvent(mutate(GOOD()));
    if (r.ok) return `ACCEPTED — the vocabulary is not closed`;
    if (!r.error || !r.reason) return "refused without naming an error/reason";
    return true;
  });
}

console.log("");
console.log(`burndown-events fixtures: ${pass} passed, ${failures.length} failed${MUTANT ? ` (mutant=${MUTANT})` : ""}`);
if (failures.length) {
  console.log(`failing: ${failures.join(", ")}`);
  process.exit(1);
}
