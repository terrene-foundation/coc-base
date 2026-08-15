#!/usr/bin/env node
/**
 * Audit-fixture runner for `.claude/hooks/lib/dispatch-ledger.js` +
 * `.claude/hooks/emit-dispatch-ledger.js::classifyDispatchEvent` — the dispatch↔delivery
 * reconciliation detector (T1).
 *
 * Per `cc-artifacts.md` Rule 9 the fixtures ship WITH the detector, and the coverage shape is ONE
 * CASE PER SCOPE-RESTRICTION PREDICATE — not one per clause. The predicates a wrong edit would
 * silently widen or narrow are:
 *
 *   1  which TOOLS produce a record at all
 *   2  what counts as a joinable dispatch NAME
 *   3  what counts as the firing GENERATION (subagent vs main agent)
 *   4  the generation-SET refusal that stops a nested delivery satisfying a parent
 *   5  launch-id UNIQUENESS — the dedupe key that lets the report name WHICH lane
 *   6  which of the three states an absent / unreadable / present ledger lands in
 *   7  what counts as a DECLARED sub-part
 *   8  which deliveries can satisfy a lane at all
 *   9  whether an UNRESOLVED verdict can ever render as a clean board
 *  10  the bound on how much one advisory prints
 *  11  the closed record-kind vocabulary at the sink
 *  12  the sink-path traversal fence
 *
 * BIPOLAR by construction: every predicate carries BOTH an accept pole and a reject pole. A fixture
 * set that only ever asserts acceptance passes identically against a detector that accepts
 * everything — which is precisely the M1-b/M1-c widening these cases exist to lock out.
 *
 * Every case exercises a PURE decision function against in-memory rows or a throwaway tmpdir. No
 * git, no network, no live sink — the live `.claude/learning/dispatch-reconcile/` sink is
 * session-scoped and gitignored, so a case pinned to it would assert against whatever this machine
 * happened to do.
 *
 * ESTABLISHED RED (`instrument-discipline.md` MUST-2): each case's `reds_under` names the mutation
 * that makes it FAIL. The four mutations the plan requires (M1-a delivery emit deleted, M1-b
 * type-only launch id, M1-c generation dropped from the launch record, M1-d ledger unreadable
 * degraded to empty) were RUN and their reddened sets recorded in the landing PR with a reach
 * proof — a fixture never shown to red is not a regression guard, and a mutation that fails to red
 * leaves two live hypotheses (vacuous case OR inert mutation).
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, resolve, sep } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const L = require(join(HERE, "..", "..", "hooks", "lib", "dispatch-ledger.js"));
const { classifyDispatchEvent } = require(join(HERE, "..", "..", "hooks", "emit-dispatch-ledger.js"));

const MAIN = L.MAIN_GENERATION;
const S = "fixture-session";

let clock = 0;
const ts = () => new Date(Date.UTC(2026, 7, 14, 0, 0, ++clock)).toISOString();
const launch = (generation, dispatchName, launchId, subagentType = "reviewer") =>
  L.buildLaunchRecord({ sessionId: S, generation, dispatchName, launchId, subagentType, nowIso: ts() });
const delivery = (generation) => L.buildDeliveryRecord({ sessionId: S, generation, nowIso: ts() });
const declared = (n) => L.buildDeclaredRecord({ sessionId: S, generation: MAIN, declaredSubparts: n, nowIso: ts() });
const laneNames = (lanes) => (lanes || []).map((l) => l.dispatch_name).sort();
const bucket = (v, g) => (v.generations || []).find((x) => x.generation === g) || null;

/** Run `fn` against a throwaway repo root; the tree never outlives the case. */
function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-fixture-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CASES = [
  // ── 1. which TOOLS produce a record ─────────────────────────────────────────
  {
    predicate: "tool-vocabulary-accept",
    name: "tools ACCEPT pole — every delegation and delivery tool yields its record kind",
    reds_under: "DELEGATION_TOOLS/DELIVERY_TOOLS: drop a member, or invert the membership test",
    run: () =>
      [
        classifyDispatchEvent({ tool_name: "Agent", tool_input: { name: "X" } }, L).kind,
        classifyDispatchEvent({ tool_name: "Task", tool_input: { name: "X" } }, L).kind,
        classifyDispatchEvent({ tool_name: "SendMessage", tool_input: { to: "main" } }, L).kind,
      ],
    expectDeep: ["launch", "launch", "delivery"],
  },
  {
    predicate: "tool-vocabulary-reject",
    name: "tools REJECT pole — no other tool writes a row, so a widened matcher cannot inject junk",
    reds_under: "classifyDispatchEvent(): replace the membership tests with a permissive pattern",
    run: () =>
      ["Read", "Bash", "Grep", "Edit", "Write", "Skill", "Glob", "WebFetch"].map((t) =>
        classifyDispatchEvent({ tool_name: t, tool_input: { name: "X" } }, L),
      ),
    expectDeep: [null, null, null, null, null, null, null, null],
  },
  {
    predicate: "prompt-event-accept",
    name: "prompt ACCEPT pole — UserPromptSubmit is recognized by event name AND by a bare prompt field",
    reds_under: "classifyDispatchEvent(): key the declared branch on the event name alone",
    run: () => [
      classifyDispatchEvent({ hook_event_name: "UserPromptSubmit", prompt: "1. a\n2. b" }, L).kind,
      classifyDispatchEvent({ prompt: "1. a\n2. b" }, L).kind,
    ],
    expectDeep: ["declared", "declared"],
  },

  // ── 2. what counts as a joinable dispatch NAME ──────────────────────────────
  {
    predicate: "dispatch-name-accept",
    name: "name ACCEPT pole — a non-empty `name` is the join key",
    reds_under: "dispatchNameOf(): read a different tool_input field, or drop the read",
    run: () => L.dispatchNameOf({ name: "LANE-A", subagent_type: "reviewer" }),
    expectDeep: "LANE-A",
  },
  {
    predicate: "dispatch-name-reject",
    name: "name REJECT pole — absent/empty/non-string names are null, never coerced into a fake key",
    reds_under: "dispatchNameOf(): fall back to subagent_type, or String()-coerce",
    run: () => [{}, { name: "" }, { name: 7 }, { name: null }, null].map((ti) => L.dispatchNameOf(ti)),
    expectDeep: [null, null, null, null, null],
  },
  {
    predicate: "unnamed-dispatch-is-unjoinable-not-clean",
    name: "an unnamed dispatch is UNJOINABLE — neither delivered nor accused of non-delivery",
    reds_under: "reconcile(): route a null dispatch_name into `delivered` or into `undelivered`",
    run: () => {
      const v = L.reconcile([launch(MAIN, null, "l1"), launch(MAIN, "X", "l2"), delivery("X")]);
      return { unjoinable: v.unjoinable.length, undelivered: laneNames(v.undelivered), delivered: laneNames(bucket(v, MAIN).delivered) };
    },
    expect: { unjoinable: 1, undelivered: [], delivered: ["X"] },
  },

  // ── 2b. the RUNTIME agent-id shape (the review-caught defect) ───────────────
  {
    predicate: "agent-id-normalize-accept",
    name: "agent-id ACCEPT pole — the MEASURED runtime shape resolves to its dispatch name",
    reds_under: "normalizeAgentId()/generationOf(): return the raw agent_id (M1-e)",
    // Values copied from the live activation sink: 39 distinct ids measured, 39/39 matching.
    run: () => ["aCONV-A-correctness-2-25ba2b48182a8868", "aE1-rule7-1c8067fd3c556d15", "aLANE-A-f5d85edb4c80324b"].map((id) => L.generationOf({ agent_id: id })),
    expectDeep: ["CONV-A-correctness-2", "E1-rule7", "LANE-A"],
  },
  {
    predicate: "agent-id-normalize-reject",
    name: "agent-id REJECT pole — an unnamed or unrecognized id is never coerced into a name",
    reds_under: "normalizeAgentId(): loosen the pattern so any string yields a name",
    run: () => [L.normalizeAgentId("a07ec646a2ce635bf"), L.normalizeAgentId("LANE-A"), L.normalizeAgentId("")].map((r) => [r.ok, r.name]),
    expectDeep: [[true, null], [false, null], [false, null]],
  },
  {
    predicate: "delivering-lane-not-accused-under-real-ids",
    name: "the regression lock — a lane delivering under its REAL agent_id is DELIVERED",
    reds_under: "generationOf(): join the raw agent_id against dispatch_name (M1-e)",
    run: () => {
      const v = L.reconcile([
        launch(MAIN, "X", "l1"),
        launch(MAIN, "Z", "l2"),
        L.buildDeliveryRecord({ sessionId: S, generation: L.generationOf({ agent_id: "aX-25ba2b48182a8868" }), nowIso: ts() }),
      ]);
      return { state: v.state, delivered: laneNames(bucket(v, MAIN).delivered), undelivered: laneNames(v.undelivered) };
    },
    expect: { state: "RESOLVED", delivered: ["X"], undelivered: ["Z"] },
  },
  {
    predicate: "unresolving-join-fails-safe",
    name: "fail-safe — an unresolving join reports UNRESOLVED instead of accusing every lane",
    reds_under: "reconcile(): drop the orphan+undelivered guard, restoring the false accusation",
    run: () => {
      const v = L.reconcile([launch(MAIN, "X", "l1"), launch(MAIN, "Z", "l2"), delivery("aX-25ba2b48182a8868")]);
      return { state: v.state, undelivered: v.undelivered, named: /have NOT called SendMessage/.test(L.formatReconcileAdvisory(v) || "") };
    },
    expect: { state: "UNRESOLVED", undelivered: null, named: false },
  },
  {
    predicate: "fail-safe-is-scoped-not-blanket",
    name: "fail-safe REJECT pole — orphans with NOTHING undelivered stay RESOLVED",
    reds_under: "reconcile(): degrade on ANY orphan, suppressing clean results",
    run: () => L.reconcile([launch(MAIN, "X", "l1"), delivery("X"), delivery("ghost")]).state,
    expectDeep: "RESOLVED",
  },

  // ── 3. what counts as the firing GENERATION ─────────────────────────────────
  {
    predicate: "generation-subagent",
    name: "generation ACCEPT pole — a populated agent_id IS the firing generation",
    reds_under: "generationOf(): ignore agent_id, or return the sentinel unconditionally (M1-c)",
    run: () => L.generationOf({ agent_id: "PARENT-LANE" }),
    expectDeep: "PARENT-LANE",
  },
  {
    predicate: "generation-main-sentinel",
    name: "generation REJECT pole — absent/empty/non-string agent_id is the MAIN sentinel",
    reds_under: "generationOf(): treat an empty string as a real generation",
    run: () => [{}, { agent_id: "" }, { agent_id: 5 }, null].map((p) => L.generationOf(p)),
    expectDeep: [MAIN, MAIN, MAIN, MAIN],
  },
  {
    predicate: "main-sentinel-is-uncollidable",
    name: "the MAIN sentinel cannot be a real dispatch name — no lane can impersonate the orchestrator",
    reds_under: 'MAIN_GENERATION: change it to a bare word such as "main"',
    run: () => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(MAIN),
    expectDeep: false,
  },

  // ── 4. the generation-SET refusal ───────────────────────────────────────────
  {
    predicate: "nested-delivery-does-not-inflate-parent",
    name: "generation ACCEPT pole — the parent generation's counts exclude a nested lane and its delivery",
    reds_under: "buildLaunchRecord(): drop the caller's generation (M1-c)",
    run: () => {
      const v = L.reconcile([launch(MAIN, "A", "l1"), launch(MAIN, "B", "l2"), launch("A", "N", "l3"), delivery("N")]);
      const p = bucket(v, MAIN);
      return { parentLaunched: p.launched.length, parentDelivered: laneNames(p.delivered), parentUndelivered: laneNames(p.undelivered) };
    },
    expect: { parentLaunched: 2, parentDelivered: [], parentUndelivered: ["A", "B"] },
  },
  {
    predicate: "cross-generation-name-is-unattributable",
    name: "generation REJECT pole — a name launched in TWO generations credits NEITHER lane",
    reds_under: "attributableGenerations()/reconcile(): attribute on the bare name, ignoring the generation set (M1-c)",
    run: () => {
      const v = L.reconcile([launch(MAIN, "reviewer", "l1"), launch(MAIN, "B", "l2"), launch("B", "reviewer", "l3"), delivery("reviewer")]);
      return { unattributable: v.unattributable, parentDelivered: laneNames(bucket(v, MAIN).delivered) };
    },
    expect: { unattributable: ["reviewer"], parentDelivered: [] },
  },
  {
    predicate: "same-generation-name-resolves-to-one",
    name: "generation ACCEPT pole — a name unique to one generation resolves and IS attributed",
    reds_under: "attributableGenerations(): key the map by (generation,name) so no name ever resolves",
    run: () => {
      const m = L.attributableGenerations([launch(MAIN, "r", "l1"), launch("B", "s", "l2")]);
      return { r: [...m.get("r")], s: [...m.get("s")] };
    },
    expect: { r: [MAIN], s: ["B"] },
  },

  // ── 5. launch-id uniqueness ─────────────────────────────────────────────────
  {
    predicate: "launch-id-unique-accept",
    name: "id ACCEPT pole — three dispatches of the SAME subagent type survive as three lanes",
    reds_under: "newLaunchId(): derive the id from the subagent type (M1-b)",
    run: () => {
      const v = L.reconcile([launch(MAIN, "X", L.newLaunchId()), launch(MAIN, "Y", L.newLaunchId()), launch(MAIN, "Z", L.newLaunchId()), delivery("X"), delivery("Y")]);
      return { launched: bucket(v, MAIN).launched.length, undelivered: laneNames(v.undelivered) };
    },
    expect: { launched: 3, undelivered: ["Z"] },
  },
  {
    predicate: "launch-id-collision-reject",
    name: "id REJECT pole — a type-derived id collapses three lanes to one and loses WHICH failed",
    reds_under: "reconcile(): stop keying launches by launch_id (the dedupe would silently vanish)",
    run: () => bucket(L.reconcile([launch(MAIN, "X", "reviewer"), launch(MAIN, "Y", "reviewer"), launch(MAIN, "Z", "reviewer")]), MAIN).launched.length,
    expectDeep: 1,
  },

  // ── 6. the ledger tri-state ─────────────────────────────────────────────────
  {
    predicate: "tristate-absent-is-unresolved",
    name: "tri-state REJECT pole — an ABSENT ledger is UNRESOLVED, never 0 undelivered (M1-d)",
    reds_under: "readLedger(): return {ok:true, rows:[]} on ENOENT",
    run: () =>
      withTmp((dir) => {
        const r = L.readLedger({ repoDir: dir, sessionId: "nothing-here" });
        const v = L.reconcile(r.ok ? r.rows : null, r);
        return { readOk: r.ok, state: v.state, undelivered: v.undelivered };
      }),
    expect: { readOk: false, state: "UNRESOLVED", undelivered: null },
  },
  {
    predicate: "tristate-present-is-resolved",
    name: "tri-state ACCEPT pole — a present ledger RESOLVES and reports the real lanes",
    reds_under: "readLedger(): fail closed on every path, so the surface can never resolve",
    run: () =>
      withTmp((dir) => {
        for (const rec of [launch(MAIN, "X", "l1"), launch(MAIN, "Z", "l2"), delivery("X")]) L.appendRecord({ repoDir: dir, record: rec });
        const r = L.readLedger({ repoDir: dir, sessionId: S });
        const v = L.reconcile(r.ok ? r.rows : null, r);
        return { readOk: r.ok, state: v.state, undelivered: laneNames(v.undelivered) };
      }),
    expect: { readOk: true, state: "RESOLVED", undelivered: ["Z"] },
  },
  {
    predicate: "tristate-torn-row-does-not-discard-the-file",
    name: "tri-state boundary — one malformed LINE is skipped and counted; the file is still readable",
    reds_under: "readLedger(): throw or fail the whole read on the first unparseable line",
    run: () =>
      withTmp((dir) => {
        const sink = L._sinkPath(dir, S);
        mkdirSync(dirname(sink), { recursive: true });
        writeFileSync(sink, JSON.stringify(launch(MAIN, "X", "l1")) + "\n{oops\n" + JSON.stringify(delivery("X")) + "\n");
        const r = L.readLedger({ repoDir: dir, sessionId: S });
        return { ok: r.ok, rows: r.rows.length, skipped: r.skipped };
      }),
    expect: { ok: true, rows: 2, skipped: 1 },
  },

  // ── 7. what counts as a DECLARED sub-part ───────────────────────────────────
  {
    predicate: "subpart-count-accept",
    name: "sub-parts ACCEPT pole — ordered and unordered list markers are counted, larger group wins",
    reds_under: "countDeclaredSubparts(): sum the two groups, or drop one marker shape",
    run: () => ["1. a\n2. b\n3. c", "- a\n- b", "1) a\n2) b\n- side note", "* a\n* b\n* c"].map((t) => L.countDeclaredSubparts(t)),
    expectDeep: [3, 2, 2, 3],
  },
  {
    predicate: "subpart-count-reject",
    name: "sub-parts REJECT pole — prose, fenced blocks, dangling hyphens and em-dashes count 0",
    reds_under: "countDeclaredSubparts(): drop the fence tracking, or loosen the marker anchors",
    run: () =>
      ["just do the thing", "```bash\n- not a subpart\n1. nor this\n```", "do it -\nand also -", "run gates — then push", "", null].map((t) =>
        L.countDeclaredSubparts(t),
      ),
    expectDeep: [0, 0, 0, 0, 0, 0],
  },
  {
    predicate: "declared-row-carries-no-prompt-text",
    name: "the declared row carries the COUNT and exactly six keys — never the operator's prompt",
    reds_under: "buildDeclaredRecord(): add the prompt text or any excerpt of it",
    run: () => Object.keys(declared(4)).sort(),
    expectDeep: ["declared_subparts", "generation", "kind", "session_id", "ts", "v"],
  },
  {
    predicate: "parallelism-shortfall-bipolar",
    name: "parallelism — declared 4/launched 1 is a shortfall; declared 4/launched 4 is not",
    reds_under: "reconcile(): count launches from the whole file instead of after the latest declaration",
    run: () => [
      L.reconcile([declared(4), launch(MAIN, "A", "l1")]).parallelism.shortfall,
      L.reconcile([declared(4), launch(MAIN, "A", "l1"), launch(MAIN, "B", "l2"), launch(MAIN, "C", "l3"), launch(MAIN, "D", "l4")]).parallelism.shortfall,
      L.reconcile([declared(2), launch(MAIN, "old", "l0"), declared(3), launch(MAIN, "new", "l1")]).parallelism.dispatched,
    ],
    expectDeep: [3, 0, 1],
  },

  // ── 8. which deliveries can satisfy a lane ──────────────────────────────────
  {
    predicate: "delivery-attribution-accept",
    name: "delivery ACCEPT pole — a lane's own SendMessage marks THAT lane delivered",
    reds_under: "reconcile(): stop reading the delivery row's generation (M1-a leaves this set empty)",
    run: () => laneNames(bucket(L.reconcile([launch(MAIN, "X", "l1"), launch(MAIN, "Z", "l2"), delivery("X")]), MAIN).delivered),
    expectDeep: ["X"],
  },
  {
    predicate: "delivery-attribution-reject-main",
    name: "delivery REJECT pole — the ORCHESTRATOR's own SendMessage satisfies no lane",
    reds_under: "reconcile(): drop the MAIN_GENERATION skip, so any message clears the board",
    run: () => laneNames(L.reconcile([launch(MAIN, "X", "l1"), delivery(MAIN)]).undelivered),
    expectDeep: ["X"],
  },
  {
    predicate: "delivery-attribution-reject-orphan",
    name: "delivery REJECT pole — a deliverer matching no dispatch is an ORPHAN, surfaced not swallowed",
    reds_under: "reconcile(): silently ignore unmatched deliverers",
    run: () => L.reconcile([launch(MAIN, "X", "l1"), delivery("X"), delivery("ghost")]).orphan_deliverers,
    expectDeep: ["ghost"],
  },
  {
    predicate: "no-delivery-rows-accuses-every-lane",
    name: "the M1-a consequence, pinned — with zero delivery rows EVERY lane is undelivered",
    reds_under: "reconcile(): default a lane to delivered when no delivery rows exist",
    run: () => laneNames(L.reconcile([launch(MAIN, "X", "l1"), launch(MAIN, "Y", "l2")]).undelivered),
    expectDeep: ["X", "Y"],
  },

  // ── 9. the advisory can never render UNRESOLVED as clean ────────────────────
  {
    predicate: "advisory-unresolved-never-clean",
    name: "advisory REJECT pole — an UNRESOLVED verdict says UNKNOWN and never prints a count",
    reds_under: "formatReconcileAdvisory(): render the UNRESOLVED branch as a zero-count summary",
    run: () => {
      const msg = L.formatReconcileAdvisory(L.reconcile(null, { reason: "ledger unreadable: EACCES" }));
      return { unresolved: /UNRESOLVED/.test(msg), disclaims: /NOT a clean result/.test(msg), noZeroCount: !/0 dispatched lane/.test(msg) };
    },
    expect: { unresolved: true, disclaims: true, noZeroCount: true },
  },
  {
    predicate: "advisory-silent-when-clean",
    name: "advisory ACCEPT pole — a genuinely clean board emits NOTHING, so the surface is not noise",
    reds_under: "formatReconcileAdvisory(): always return a block",
    run: () => L.formatReconcileAdvisory(L.reconcile([launch(MAIN, "X", "l1"), delivery("X")])),
    expectDeep: null,
  },
  {
    predicate: "advisory-names-the-lane",
    name: "advisory ACCEPT pole — the undelivered lane is NAMED, not merely counted",
    reds_under: "formatReconcileAdvisory(): report only a tally",
    run: () => {
      const msg = L.formatReconcileAdvisory(L.reconcile([launch(MAIN, "X", "l1"), launch(MAIN, "SILENT", "l2"), delivery("X")]));
      return { namesSilent: /SILENT/.test(msg), doesNotNameDeliverer: !/X \(gen/.test(msg) };
    },
    expect: { namesSilent: true, doesNotNameDeliverer: true },
  },

  // ── 10. the output bound ────────────────────────────────────────────────────
  {
    predicate: "advisory-output-is-bounded",
    name: "advisory bound — more lanes than the cap are truncated with an explicit remainder",
    reds_under: "MAX_REPORTED_LANES: remove the slice, letting one line flood a transcript",
    run: () => {
      const n = L.MAX_REPORTED_LANES + 5;
      const rows = Array.from({ length: n }, (_, i) => launch(MAIN, `L${i}`, `id${i}`));
      const msg = L.formatReconcileAdvisory(L.reconcile(rows));
      return { total: new RegExp(`${n} dispatched lane`).test(msg), truncated: /… and 5 more/.test(msg) };
    },
    expect: { total: true, truncated: true },
  },

  // ── 11. the closed record-kind vocabulary ───────────────────────────────────
  {
    predicate: "record-kind-accept",
    name: "sink ACCEPT pole — each declared record kind is written",
    reds_under: "appendRecord(): narrow the kind check so a legitimate row is dropped",
    run: () =>
      withTmp((dir) => [
        L.appendRecord({ repoDir: dir, record: launch(MAIN, "X", "l1") }).ok,
        L.appendRecord({ repoDir: dir, record: delivery("X") }).ok,
        L.appendRecord({ repoDir: dir, record: declared(2) }).ok,
      ]),
    expectDeep: [true, true, true],
  },
  {
    predicate: "record-kind-reject",
    name: "sink REJECT pole — an unknown kind, a non-object and null are all refused",
    reds_under: "appendRecord(): drop the RECORD_KINDS membership test",
    run: () =>
      withTmp((dir) => [
        L.appendRecord({ repoDir: dir, record: { kind: "whatever" } }).ok,
        L.appendRecord({ repoDir: dir, record: "a string" }).ok,
        L.appendRecord({ repoDir: dir, record: null }).ok,
      ]),
    expectDeep: [false, false, false],
  },
  {
    predicate: "reader-ignores-unknown-kinds",
    name: "reader REJECT pole — a row with an unknown kind is skipped, never guessed at",
    reds_under: "readLedger(): accept any parseable object as a row",
    run: () =>
      withTmp((dir) => {
        const sink = L._sinkPath(dir, S);
        mkdirSync(dirname(sink), { recursive: true });
        writeFileSync(sink, JSON.stringify({ kind: "gossip", generation: "X" }) + "\n" + JSON.stringify(launch(MAIN, "X", "l1")) + "\n");
        const r = L.readLedger({ repoDir: dir, sessionId: S });
        return { rows: r.rows.length, skipped: r.skipped };
      }),
    expect: { rows: 1, skipped: 1 },
  },

  // ── 12. the sink-path fence ─────────────────────────────────────────────────
  {
    predicate: "sink-path-no-traversal",
    name: "sink REJECT pole — a crafted session id cannot escape the sink directory",
    reds_under: "_sinkPath(): drop the sanitizing charclass, or interpolate the raw id",
    // The predicate is CONTAINMENT, not the absence of a `..` substring. The charclass keeps `.`
    // (real session ids carry them), so `../../etc/passwd` sanitizes to `.._.._etc_passwd` — a
    // filename that READS like a traversal and is not one, because every separator is gone and the
    // hash suffix is appended after it. Asserting on the substring would fail this correct
    // behaviour; asserting on the RESOLVED path is the check that discriminates.
    run: () => {
      const sinkDir = join("/repo", ".claude", "learning", "dispatch-reconcile");
      const p = L._sinkPath("/repo", "../../etc/passwd");
      return {
        dir: dirname(p),
        hasSeparator: /[\\/]/.test(basename(p)),
        containedAfterResolve: resolve(p).startsWith(resolve(sinkDir) + sep),
      };
    },
    expect: {
      dir: join("/repo", ".claude", "learning", "dispatch-reconcile"),
      hasSeparator: false,
      containedAfterResolve: true,
    },
  },
  {
    predicate: "sink-path-injective",
    name: "sink ACCEPT pole — two ids that sanitize alike still land on DISTINCT files",
    reds_under: "_sinkPath(): drop the sha256 suffix, keeping only the sanitized token",
    run: () => L._sinkPath("/r", "a/b") !== L._sinkPath("/r", "a:b"),
    expectDeep: true,
  },
];

// ── run ───────────────────────────────────────────────────────────────────────

/** Subset match on `expect`; `expectDeep` pins the WHOLE return (scalars and arrays need it). */
function matches(got, c) {
  if (Object.prototype.hasOwnProperty.call(c, "expectDeep")) return JSON.stringify(got) === JSON.stringify(c.expectDeep);
  const expect = c.expect;
  if (expect === null) return got === null;
  if (got === null || typeof got !== "object") return false;
  for (const [k, v] of Object.entries(expect)) if (JSON.stringify(got[k]) !== JSON.stringify(v)) return false;
  return true;
}

let failures = 0;
for (const c of CASES) {
  let got;
  try {
    got = c.run();
  } catch (err) {
    got = { threw: err && err.message ? err.message : String(err) };
  }
  if (matches(got, c)) {
    console.log(`PASS  [${c.predicate}] ${c.name}`);
  } else {
    failures++;
    const want = Object.prototype.hasOwnProperty.call(c, "expectDeep") ? c.expectDeep : c.expect;
    console.error(`FAIL  [${c.predicate}] ${c.name}\n      expected ${JSON.stringify(want)}\n      got      ${JSON.stringify(got)}`);
  }
}

console.log(`\n${CASES.length - failures}/${CASES.length} fixtures passed`);
process.exit(failures === 0 ? 0 : 1);
