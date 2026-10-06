#!/usr/bin/env node
/**
 * Bipolar fixtures for `hooks/lib/todo-durable.js`.
 *
 * Per `instrument-bipolarity.md` MUST-1 every pair ships BOTH poles and the runner
 * asserts the two verdicts DIFFER — a pair whose poles agree is VACUOUS and fails
 * even when both individually "pass". Per MUST-2 each RED pole asserts a failure
 * IDENTITY (the reason string / the specific id), never merely "something failed":
 * an exit code is a quantity, and a quantity survives the obvious repair.
 */

import "../_lib/no-ambient-git.cjs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const M = require(path.join(HERE, "..", "..", "hooks", "lib", "todo-durable.js"));

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  let verdict;
  try {
    verdict = fn();
  } catch (e) {
    verdict = `threw ${(e && e.message) || e}`;
  }
  if (verdict === true) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    failures.push(`${name} — ${verdict}`);
    console.log(`FAIL ${name} — ${verdict}`);
  }
}

/** A pair is only meaningful if its poles DISAGREE. */
function pair(name, redFn, greenFn) {
  const red = redFn();
  const green = greenFn();
  check(`${name} · RED`, () => (red.ok === true ? true : red.why));
  check(`${name} · GREEN`, () => (green.ok === true ? true : green.why));
  check(`${name} · NON-VACUOUS — the poles produce DIFFERENT verdicts`, () =>
    red.observed !== green.observed ? true : `both poles observed '${red.observed}'`,
  );
}

// ---------------------------------------------------------------- PAIR 1
// A path outside the todo tree is MALFORMED with a NAMED reason; a lifecycle
// path classifies. Identity asserted, not just "did it fail".
pair(
  "classify/non-todo-path-REFUSED-with-reason",
  () => {
    const r = M.classifyTodoPath("src/index.js");
    return {
      ok: r.ok === false && /not under workspaces/.test(r.reason || ""),
      why: `expected refusal naming the shape, got ${JSON.stringify(r)}`,
      observed: r.ok === false ? `refused:${r.reason}` : "classified",
    };
  },
  () => {
    const r = M.classifyTodoPath("workspaces/ws/todos/active/foo.md");
    return {
      ok: r.ok === true && r.outcome === "declared" && r.state === "active",
      why: `expected declared/active, got ${JSON.stringify(r)}`,
      observed: r.ok === true ? `classified:${r.state}` : "refused",
    };
  },
);

// ---------------------------------------------------------------- PAIR 2
// THE LOAD-BEARING ONE: the id is STABLE across the lifecycle move, so
// active→completed is a TRANSITION and not delete+create.
pair(
  "identity/id-is-STABLE-across-the-move",
  () => {
    // RED pole: if the id ever included the lifecycle segment, these differ.
    const a = M.classifyTodoPath("workspaces/ws/todos/active/foo.md");
    const c = M.classifyTodoPath("workspaces/ws/todos/completed/foo.md");
    return {
      ok: a.id === c.id && a.id === "ws/foo",
      why: `ids diverged across the move: ${a.id} vs ${c.id}`,
      observed: a.id === c.id ? "stable" : "diverged",
    };
  },
  () => {
    // GREEN pole: the STATE does change, so the two are distinguishable.
    const a = M.classifyTodoPath("workspaces/ws/todos/active/foo.md");
    const c = M.classifyTodoPath("workspaces/ws/todos/completed/foo.md");
    return {
      ok: a.status === "todo:active" && c.status === "todo:completed" && a.status !== c.status,
      why: `states did not differ: ${a.status} vs ${c.status}`,
      observed: a.status !== c.status ? "states-differ" : "states-same",
    };
  },
);

// ---------------------------------------------------------------- PAIR 3
// UNDECLARED is REPORTED, never folded into "no items".
pair(
  "undeclared/a-todo-file-outside-a-lifecycle-dir-is-REPORTED",
  () => {
    const s = M.scanDurableTodos(["workspaces/ws/todos/backlog/foo.md"]);
    return {
      ok: s.ok === true && s.undeclared.length === 1 && s.declared.size === 0,
      why: `expected 1 undeclared + 0 declared, got ${JSON.stringify({ u: s.undeclared.length, d: s.declared.size })}`,
      observed: `undeclared:${s.undeclared.length}`,
    };
  },
  () => {
    const s = M.scanDurableTodos(["workspaces/ws/todos/active/foo.md"]);
    return {
      ok: s.ok === true && s.undeclared.length === 0 && s.declared.size === 1,
      why: `expected 0 undeclared + 1 declared, got ${JSON.stringify({ u: s.undeclared.length, d: s.declared.size })}`,
      observed: `undeclared:${s.undeclared.length}`,
    };
  },
);

// ---------------------------------------------------------------- PAIR 4
// IDEMPOTENCE: an unchanged status yields NO event. This is what makes every
// trigger redundant rather than duplicative.
pair(
  "idempotence/unchanged-status-yields-NO-transition",
  () => {
    const s = M.scanDurableTodos(["workspaces/ws/todos/active/foo.md"]);
    const known = new Map([["ws/foo", "todo:active"]]);
    const d = M.diffTransitions(s, known);
    return {
      ok: d.ok === true && d.transitions.length === 0,
      why: `expected 0 transitions on a re-run, got ${d.transitions && d.transitions.length}`,
      observed: `transitions:${(d.transitions || []).length}`,
    };
  },
  () => {
    const s = M.scanDurableTodos(["workspaces/ws/todos/completed/foo.md"]);
    const known = new Map([["ws/foo", "todo:active"]]);
    const d = M.diffTransitions(s, known);
    return {
      ok:
        d.ok === true &&
        d.transitions.length === 1 &&
        d.transitions[0].item_id === "ws/foo" &&
        d.transitions[0].status === "todo:completed" &&
        d.transitions[0].prior === "todo:active",
      why: `expected 1 ws/foo active→completed transition, got ${JSON.stringify(d.transitions)}`,
      observed: `transitions:${(d.transitions || []).length}`,
    };
  },
);

// ---------------------------------------------------------------- PAIR 5
// A VANISHED file yields NO terminal event. Absence is not completion.
pair(
  "absence/a-vanished-item-yields-NO-invented-terminal-event",
  () => {
    const s = M.scanDurableTodos([]); // the file is gone from the tracked set
    const known = new Map([["ws/foo", "todo:active"]]);
    const d = M.diffTransitions(s, known);
    return {
      ok: d.ok === true && d.transitions.length === 0,
      why: `a vanished file invented ${JSON.stringify(d.transitions)}`,
      observed: `transitions:${(d.transitions || []).length}`,
    };
  },
  () => {
    const s = M.scanDurableTodos(["workspaces/ws/todos/completed/foo.md"]);
    const known = new Map([["ws/foo", "todo:active"]]);
    const d = M.diffTransitions(s, known);
    return {
      ok: d.ok === true && d.transitions.length === 1,
      why: `a REAL completion produced ${JSON.stringify(d.transitions)}`,
      observed: `transitions:${(d.transitions || []).length}`,
    };
  },
);

// ---------------------------------------------------------------- PAIR 6
// A duplicate id is REFUSED, not silently resolved by first/last-wins.
pair(
  "collision/two-files-claiming-one-id-are-REPORTED-not-resolved",
  () => {
    const s = M.scanDurableTodos([
      "workspaces/ws/todos/active/foo.md",
      "workspaces/ws/todos/completed/foo.md",
    ]);
    return {
      ok: s.ok === true && s.collisions.length === 1 && s.collisions[0].id === "ws/foo",
      why: `expected a reported ws/foo collision, got ${JSON.stringify(s.collisions)}`,
      observed: `collisions:${s.collisions.length}`,
    };
  },
  () => {
    const s = M.scanDurableTodos([
      "workspaces/ws/todos/active/foo.md",
      "workspaces/ws/todos/active/bar.md",
    ]);
    return {
      ok: s.ok === true && s.collisions.length === 0 && s.declared.size === 2,
      why: `distinct ids collided: ${JSON.stringify(s.collisions)}`,
      observed: `collisions:${s.collisions.length}`,
    };
  },
);

// ---------------------------------------------------------------- PAIR 7
// NAMED REGRESSION CASE (`coc-artifact-eval-coverage.md` MUST-2) for the finding
// measured against the real corpus: a NESTED workspace id
// (`workspaces/_archive/<name>/todos/...`) was reported MALFORMED by a classifier
// that assumed `todos` sat at a fixed index. 106 of 174 tracked files were
// condemned, and it read as a corpus problem rather than a reader problem.
pair(
  "nested-workspace/_archive-depth-does-NOT-read-as-malformed",
  () => {
    const s = M.scanDurableTodos(["workspaces/_archive/proj-2026-07-08/todos/active/00-plan.md"]);
    return {
      ok: s.ok === true && s.malformed.length === 0 && s.declared.size === 1,
      why: `nested workspace mis-classified: ${JSON.stringify(s.malformed)}`,
      observed: `malformed:${s.malformed.length}`,
    };
  },
  () => {
    // The GREEN pole proves the id CARRIES the nesting, so two same-named files in
    // different nested workspaces stay distinct rather than colliding.
    const s = M.scanDurableTodos([
      "workspaces/_archive/proj-a/todos/active/00-plan.md",
      "workspaces/_archive/proj-b/todos/active/00-plan.md",
    ]);
    return {
      ok: s.ok === true && s.declared.size === 2 && s.collisions.length === 0,
      why: `nested ids collapsed: declared=${s.declared.size} collisions=${JSON.stringify(s.collisions)}`,
      // Observes DECLARED, not malformed: the RED pole already observes
      // `malformed:0`, and a pole pair whose two poles read the same quantity is
      // vacuous by construction — it would pass whatever the code did. The
      // runner's own NON-VACUOUS check caught this, which is the check earning
      // its place rather than decorating the suite.
      observed: `declared:${s.declared.size}`,
    };
  },
);

// ---------------------------------------------------------------- PAIRS 8-10
// NAMED REGRESSION CASE (`coc-artifact-eval-coverage.md` MUST-2): SessionStart printed
// "1 event-log line(s) were UNREADABLE and skipped by the fold" for `burndown/events.jsonl`
// line 635, which is a VALID proposal awaiting its owner countersignature. The guard
// counted `skipped.length`; the class of each skip is now set at the producer
// (`burndown-events.js::SKIP_KINDS` / `partitionSkips`) and rendered by
// `describeFoldSkips`. These pairs drive the REAL fold over synthetic on-disk records —
// no stubbed fold — and assert the MESSAGE identity each class produces.
const EV = require(path.join(HERE, "..", "..", "hooks", "lib", "burndown-events.js"));
const PROPOSAL_REC = "rec_FIXTURE_PROPOSAL_1";
const onDisk = (partial, over = {}) =>
  JSON.stringify({
    id: `rec_${Math.random().toString(36).slice(2)}`,
    timestamp: "2026-09-12T00:00:00.000Z",
    sig_alg: "openpgp",
    seq: 1,
    prev_hash: null,
    ...partial,
    ...over,
    sig: "FIXTURE",
  });
const anchor = (id) => `journal/0001-a.md#${id}`;
const GENESIS = (id) =>
  EV.buildEvent({ kind: "genesis", item_id: id, item: "an item", value_anchor: anchor(id), status: "In progress", authority: "agent", source: "fixture" });
const TRANSITION = (id) =>
  EV.buildEvent({ kind: "transition", item_id: id, item: "an item", value_anchor: anchor(id), status: "todo:completed", authority: "agent", source: "fixture" });
const PROPOSAL = (id) =>
  EV.buildEvent({ kind: "proposal", item_id: id, item: "an item", value_anchor: anchor(id), authority: "agent", source: "fixture", proposed_status: "Signed off", reason: "measured closed in session" });
const ACTIVATION = (id) =>
  EV.buildEvent({ kind: "activation", item_id: id, item: "an item", value_anchor: anchor(id), status: "Signed off", authority: "owner", source: "fixture", activates: PROPOSAL_REC, accepted_by: "fixture owner" });

const reportOf = (lines) => M.describeFoldSkips(EV.partitionSkips(EV.foldProjection(lines.join("\n"))));
/** The CLASS each rendered message names — the identity the pairs compare. */
const classOf = (msgs) =>
  msgs
    .map((m) =>
      /were UNREADABLE and skipped by the fold/.test(m)
        ? "unreadable"
        : /carry NO known class/.test(m)
          ? "unclassified"
          : /AWAITING OWNER ACTIVATION/.test(m)
            ? "awaiting"
            : /declined by a fold fence/.test(m)
              ? "fenced"
              : `unrecognized:${m}`,
    )
    .join("+") || "silent";

pair(
  "fold-skips/an-unparseable-line-reads-UNREADABLE-an-inert-proposal-does-NOT",
  () => {
    const msgs = reportOf([onDisk(GENESIS("T1")), "{not json"]);
    return {
      ok: classOf(msgs) === "unreadable" && /\(line 2\)/.test(msgs[0]) && !/AWAITING/.test(msgs[0]),
      why: `an unparseable line must read UNREADABLE naming line 2, got ${JSON.stringify(msgs)}`,
      observed: classOf(msgs),
    };
  },
  () => {
    const msgs = reportOf([onDisk(GENESIS("T1")), onDisk(PROPOSAL("T1"), { id: PROPOSAL_REC })]);
    return {
      ok:
        classOf(msgs) === "awaiting" &&
        msgs[0].includes("'T1'") &&
        msgs[0].includes(PROPOSAL_REC) &&
        msgs[0].includes("line 2") &&
        !/UNREADABLE/.test(msgs[0]),
      why: `an inert proposal must read AWAITING OWNER ACTIVATION naming T1 + its record, never UNREADABLE; got ${JSON.stringify(msgs)}`,
      observed: classOf(msgs),
    };
  },
);

pair(
  "fold-skips/a-pending-proposal-is-NAMED-a-countersigned-one-is-SILENT",
  () => {
    const msgs = reportOf([onDisk(GENESIS("T1")), onDisk(PROPOSAL("T1"), { id: PROPOSAL_REC })]);
    return {
      ok: classOf(msgs) === "awaiting",
      why: `a pending proposal must be reported as awaiting, got ${JSON.stringify(msgs)}`,
      observed: classOf(msgs),
    };
  },
  () => {
    // The proposal's skip entry is PERMANENT — it is recorded on every fold after the
    // activation too — so a guard that reports every proposal-inert skip would nag about
    // decisions already made. Countersigned is history, not outstanding work.
    const msgs = reportOf([
      onDisk(GENESIS("T1")),
      onDisk(PROPOSAL("T1"), { id: PROPOSAL_REC }),
      onDisk(ACTIVATION("T1")),
    ]);
    return {
      ok: msgs.length === 0,
      why: `a countersigned proposal must report nothing, got ${JSON.stringify(msgs)}`,
      observed: classOf(msgs),
    };
  },
);

pair(
  "fold-skips/a-kindless-skip-FAILS-CLOSED-a-fenced-record-reads-FENCED",
  () => {
    const msgs = M.describeFoldSkips(EV.partitionSkips({ skipped: [{ line: 4, why: "legacy entry" }], pendingProposals: [] }));
    return {
      ok: classOf(msgs) === "unclassified" && /treated as UNREADABLE/.test(msgs[0]) && /line 4/.test(msgs[0]),
      why: `a skip with no known kind must fail closed as UNREADABLE naming line 4, got ${JSON.stringify(msgs)}`,
      observed: classOf(msgs),
    };
  },
  () => {
    const msgs = reportOf([onDisk(TRANSITION("T1")), onDisk(GENESIS("T1"))]);
    return {
      ok: classOf(msgs) === "fenced" && /baseline-under-live \(line 2\)/.test(msgs[0]) && !/UNREADABLE/.test(msgs[0]),
      why: `a baseline genesis under a live row must read as a FENCE naming its kind + line, got ${JSON.stringify(msgs)}`,
      observed: classOf(msgs),
    };
  },
);

check("fold-skips/a-log-with-BOTH-classes-reports-BOTH — the unreadable line is never absorbed by the benign one", () => {
  const msgs = reportOf([onDisk(GENESIS("T1")), onDisk(PROPOSAL("T1"), { id: PROPOSAL_REC }), "{not json"]);
  return classOf(msgs) === "unreadable+awaiting" && /\(line 3\)/.test(msgs[0])
    ? true
    : `expected unreadable(line 3)+awaiting, got ${JSON.stringify(msgs)}`;
});

// ---------------------------------------------------------------- PAIR 11
// THE WIRING, not only the renderer. Pairs 8-10 pin `describeFoldSkips`; this spawns the
// SHIPPED `hooks/todo-durable-guard.js` over a throwaway repo so a guard that went back to
// printing `skipped.length` as UNREADABLE reds here even while the renderer stays correct.
//
// CONTAINMENT (worktree-isolation MUST-10): a fresh mkdtemp dir per run; the one git call
// is `git -C <absolute temp repo> init`; `fixtureGitEnv` neutralises global/system git
// config and HOME points into the temp dir, so no operator identity or signing key
// resolves. The repo carries NO todo files, so the guard has zero transitions to append —
// it can only REPORT — and the case asserts the log is byte-identical afterwards.
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const { fixtureGitEnv } = require(path.join(HERE, "..", "_lib", "fixture-git-env.cjs"));
const GUARD = path.join(HERE, "..", "..", "hooks", "todo-durable-guard.js");

function guardReportOver(logLines) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tdg-ingest-")));
  const home = path.join(tmp, "home");
  const repo = path.join(tmp, "repo");
  const body = `${logLines.join("\n")}\n`;
  try {
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(repo, path.dirname(EV.EVENTS_REL)), { recursive: true });
    fs.writeFileSync(path.join(repo, EV.EVENTS_REL), body);
    const env = fixtureGitEnv({ HOME: home, CLAUDE_PROJECT_DIR: repo });
    cp.execFileSync("git", ["-C", repo, "init", "-q"], { cwd: repo, env, stdio: "ignore" });
    const r = cp.spawnSync(process.execPath, [GUARD], {
      cwd: repo,
      env,
      input: JSON.stringify({ hook_event_name: "SessionStart", cwd: repo }),
      encoding: "utf8",
      timeout: 15000,
    });
    const last = String(r.stdout || "").trim().split("\n").pop() || "";
    let ctx;
    try {
      const j = JSON.parse(last);
      ctx = String((j.hookSpecificOutput && j.hookSpecificOutput.additionalContext) || j.additionalContext || "");
    } catch {
      ctx = `UNPARSEABLE-STDOUT:${last}`;
    }
    const logUnchanged = fs.readFileSync(path.join(repo, EV.EVENTS_REL), "utf8") === body;
    // `stderr` is ordered BEFORE `ctx`: a failing pole prints this object truncated, and the
    // child's stderr is where a crash — or a mutation's reach marker — shows up.
    return { status: r.status, stderr: String(r.stderr || "").slice(0, 300), logUnchanged, ctx };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const guardClass = (ctx) =>
  /were UNREADABLE/.test(ctx) ? "unreadable" : /AWAITING OWNER ACTIVATION/.test(ctx) ? "awaiting" : "other";

pair(
  "guard-wiring/the-SHIPPED-hook-says-UNREADABLE-for-a-bad-line-and-AWAITING-for-a-proposal",
  () => {
    const g = guardReportOver([onDisk(GENESIS("T1")), "{not json"]);
    return {
      ok:
        g.status === 0 &&
        /were UNREADABLE and skipped by the fold \(line 2\)/.test(g.ctx) &&
        !/AWAITING/.test(g.ctx) &&
        g.logUnchanged,
      why: `the hook must report line 2 UNREADABLE and change nothing; got ${JSON.stringify(g).slice(0, 700)}`,
      observed: guardClass(g.ctx),
    };
  },
  () => {
    const g = guardReportOver([onDisk(GENESIS("T1")), onDisk(PROPOSAL("T1"), { id: PROPOSAL_REC })]);
    return {
      ok:
        g.status === 0 &&
        g.ctx.includes(`AWAITING OWNER ACTIVATION: 'T1' (record ${PROPOSAL_REC}, line 2)`) &&
        !/UNREADABLE/.test(g.ctx) &&
        g.logUnchanged,
      why: `the hook must name T1 as AWAITING OWNER ACTIVATION, never UNREADABLE; got ${JSON.stringify(g).slice(0, 700)}`,
      observed: guardClass(g.ctx),
    };
  },
);

// ---------------------------------------------------------------- PAIRS 12-15
// THE LANE BINDING (journal/0607 decision 3). An outstanding item declares the lane
// that carries it with a `lane: <branch>` frontmatter key. These pairs pin the
// parser's four outcomes by IDENTITY, and — pair 14 — that adding the key moves
// NOTHING the ledger already derived: the id, the scan and the transition fold.
const withLane = (lane) => `---\ntitle: an item\nlane: ${lane}\n---\n# body\n`;

pair(
  "lane-binding/a-key-declared-TWICE-is-MALFORMED-a-single-slashed-branch-is-BOUND",
  () => {
    const r = M.parseLaneBinding("---\nlane: feat/a\nlane: feat/b\n---\n");
    return {
      ok: r.outcome === "malformed" && /declared 2 times \(lines 2, 3\)/.test(r.reason || ""),
      why: `two lane keys must be refused naming both lines, never first-wins; got ${JSON.stringify(r)}`,
      observed: r.outcome,
    };
  },
  () => {
    // A branch name carrying `/` must round-trip byte-for-byte — that is the join key.
    const r = M.parseLaneBinding(withLane("codify/someoperator-2026-09-12-wip-ledger"));
    return {
      ok: r.outcome === "bound" && r.lane === "codify/someoperator-2026-09-12-wip-ledger" && r.line === 3,
      why: `expected bound to the exact slashed branch on line 3, got ${JSON.stringify(r)}`,
      observed: r.outcome,
    };
  },
);

pair(
  "lane-binding/an-INVALID-branch-value-is-MALFORMED-never-UNBOUND",
  () => {
    const r = M.parseLaneBinding('---\nlane: "feat/has space"\n---\n');
    return {
      ok: r.outcome === "malformed" && /not a valid branch name/.test(r.reason || ""),
      why: `a value git would refuse as a branch must be MALFORMED; got ${JSON.stringify(r)}`,
      observed: r.outcome,
    };
  },
  () => {
    const noFm = M.parseLaneBinding("# just a heading\nlane: feat/x\n");
    const noKey = M.parseLaneBinding("---\ntitle: t\n---\nlane: feat/x\n");
    return {
      // A `lane:` line OUTSIDE the frontmatter block is prose, and is not read.
      ok:
        noFm.outcome === "unbound" &&
        /no leading frontmatter/.test(noFm.reason) &&
        noKey.outcome === "unbound" &&
        /declares no `lane:` key/.test(noKey.reason),
      why: `absent binding must read UNBOUND with its reason; got ${JSON.stringify({ noFm, noKey })}`,
      observed: `${noFm.outcome}+${noKey.outcome}`,
    };
  },
);

pair(
  "lane-binding/ADDITIVE-the-key-changes-no-id-no-scan-and-no-fold",
  () => {
    // RED pole: read the binding, then prove every pre-existing derivation is the SAME
    // value it was before the read and the SAME value an unbound file yields.
    const files = ["workspaces/ws/todos/completed/foo.md"];
    const known = new Map([["ws/foo", "todo:active"]]);
    const scan = M.scanDurableTodos(files);
    const before = JSON.stringify([...scan.declared]);
    const bound = M.bindOpenItems(M.scanDurableTodos(["workspaces/ws/todos/active/foo.md"]), () => withLane("feat/x"));
    const after = JSON.stringify([...scan.declared]);
    const d = M.diffTransitions(scan, known);
    const id = M.classifyTodoPath("workspaces/ws/todos/active/foo.md").id;
    const same =
      before === after &&
      id === "ws/foo" &&
      d.transitions.length === 1 &&
      d.transitions[0].item_id === "ws/foo" &&
      d.transitions[0].status === "todo:completed" &&
      d.transitions[0].prior === "todo:active" &&
      bound.ok === true;
    return {
      ok: same,
      why: `the binding moved an existing derivation: ${JSON.stringify({ before, after, id, d })}`,
      observed: `id:${id}|fold:${d.transitions.map((t) => `${t.prior}->${t.status}`).join(",")}`,
    };
  },
  () => {
    // GREEN pole: the binding IS read — so the RED pole is not trivially satisfied by a
    // reader that never looks at content.
    const scan = M.scanDurableTodos(["workspaces/ws/todos/active/foo.md"]);
    const snap = JSON.stringify([...scan.declared]);
    const b = M.bindOpenItems(scan, () => withLane("feat/x"));
    return {
      ok:
        b.ok === true &&
        b.items.length === 1 &&
        b.items[0].id === "ws/foo" &&
        b.items[0].outcome === "bound" &&
        b.items[0].lane === "feat/x" &&
        JSON.stringify([...scan.declared]) === snap,
      why: `expected ws/foo bound to feat/x with the scan unmutated, got ${JSON.stringify(b)}`,
      observed: `lane:${b.items && b.items[0] && b.items[0].lane}`,
    };
  },
);

pair(
  "lane-binding/a-COMPLETED-item-is-never-read-an-unreadable-OPEN-one-is-UNREADABLE",
  () => {
    const b = M.bindOpenItems(M.scanDurableTodos(["workspaces/ws/todos/active/foo.md"]), () => {
      throw new Error("EACCES fixture");
    });
    return {
      ok: b.ok === true && b.items.length === 1 && b.items[0].outcome === "unreadable" && /EACCES fixture/.test(b.items[0].reason),
      why: `a read that throws must be UNREADABLE naming the cause, never UNBOUND; got ${JSON.stringify(b)}`,
      observed: `items:${b.items.length}:${b.items[0] && b.items[0].outcome}`,
    };
  },
  () => {
    let reads = 0;
    const b = M.bindOpenItems(M.scanDurableTodos(["workspaces/ws/todos/completed/foo.md"]), () => {
      reads++;
      throw new Error("must not be read");
    });
    return {
      ok: b.ok === true && b.items.length === 0 && reads === 0,
      why: `a completed item carries no depth and must not be read; got ${JSON.stringify({ b, reads })}`,
      observed: `items:${b.items.length}`,
    };
  },
);

// ---------------------------------------------------------------- PAIR 16
// `done/` is a DECLARED closure directory, not an undeclared one.
//
// 49 tracked `.md` sit under `todos/done/` across eight LIVE workspaces, each
// arriving there by RENAME out of `active/`. Before `done` entered LIFECYCLE_DIRS
// they classified `undeclared`, so 49 items whose state was perfectly well known
// were reported as state nobody had measured. The RED pole pins that `done` now
// declares, and — the half that matters — that it declares the SAME work-state as
// `completed`, so one vocabulary reaches the log and a `done/` item reads CLOSED.
// The GREEN pole holds the allowlist's POSITIVE-allowlist property: a directory
// nobody declared is still UNDECLARED, never guessed at.
pair(
  "lifecycle/done-is-a-DECLARED-closure-dir-mapping-to-completed",
  () => {
    const r = M.classifyTodoPath("workspaces/ws/todos/done/foo.md");
    return {
      ok:
        r.ok === true &&
        r.outcome === "declared" &&
        r.state === "completed" &&
        r.status === "todo:completed" &&
        r.closed === true &&
        r.id === "ws/foo",
      why: `expected done/ to declare state 'completed' + closed + id ws/foo, got ${JSON.stringify(r)}`,
      observed: r.ok === true ? `${r.outcome}:${r.state}:closed=${r.closed}` : "refused",
    };
  },
  () => {
    const r = M.classifyTodoPath("workspaces/ws/todos/backlog/foo.md");
    return {
      ok: r.ok === true && r.outcome === "undeclared" && r.state === undefined,
      why: `a directory outside the allowlist must stay UNDECLARED, got ${JSON.stringify(r)}`,
      observed: r.ok === true ? `${r.outcome}:${r.state}:closed=${r.closed}` : "refused",
    };
  },
);

// ---------------------------------------------------------------- PAIR 17
// `done/` and `completed/` share ONE id namespace, so the same item moving through
// either reads as a TRANSITION rather than a second identity. Guards against a
// future "fix" that maps `done` to a state string of its own.
pair(
  "lifecycle/done-and-completed-share-one-id-and-one-status",
  () => {
    const s = M.scanDurableTodos(["workspaces/ws/todos/done/foo.md"]);
    const d = M.diffTransitions(s, new Map([["ws/foo", "todo:active"]]));
    return {
      ok:
        d.ok === true &&
        d.transitions.length === 1 &&
        d.transitions[0].item_id === "ws/foo" &&
        d.transitions[0].status === "todo:completed" &&
        d.transitions[0].prior === "todo:active",
      why: `active→done must emit ONE ws/foo todo:completed transition, got ${JSON.stringify(d.transitions)}`,
      observed: `transitions:${(d.transitions || []).length}`,
    };
  },
  () => {
    // Already closed via `completed/`; re-reading it under `done/` must be a NO-OP.
    const s = M.scanDurableTodos(["workspaces/ws/todos/done/foo.md"]);
    const d = M.diffTransitions(s, new Map([["ws/foo", "todo:completed"]]));
    return {
      ok: d.ok === true && d.transitions.length === 0,
      why: `a completed item re-read under done/ must emit NOTHING, got ${JSON.stringify(d.transitions)}`,
      observed: `transitions:${(d.transitions || []).length}`,
    };
  },
);

// ---------------------------------------------------------------- PAIR 18
// `isMetaWorkspaceTodoPath` SCOPES A POPULATION; it does not reclassify a path.
//
// The predicate keys on the WORKSPACE ID — everything between `workspaces/` and the
// `todos` segment — because that is where `cc-artifacts.md:139-148` Rule 8 puts it.
// The GREEN pole is the discrimination that matters and is easy to get wrong: a
// `_archive` appearing UNDER `todos/` is a lifecycle question, not a workspace one,
// and a predicate that matched it would silence a LIVE workspace's real signal.
pair(
  "scope/meta-workspace-predicate-keys-on-the-WORKSPACE-id-only",
  () => {
    const hits = [
      "workspaces/_archive/dead-ws/todos/active/x.md",
      "workspaces/_template/todos/active/.gitkeep",
      "workspaces/_draft/ws/todos/done/x.md",
    ].map((p) => M.isMetaWorkspaceTodoPath(p));
    return {
      ok: hits.every((h) => h === true),
      why: `every workspace meta-dir must be detected, got ${JSON.stringify(hits)}`,
      observed: `meta:${hits.join(",")}`,
    };
  },
  () => {
    const hits = [
      "workspaces/multi-operator-coc/todos/_archive/00-todos.md",
      "workspaces/live-ws/todos/_archive-build-delegated/x.md",
      "workspaces/live-ws/todos/active/x.md",
    ].map((p) => M.isMetaWorkspaceTodoPath(p));
    return {
      ok: hits.every((h) => h === false),
      why: `a todos-level _archive is NOT a meta-workspace and must stay in the census, got ${JSON.stringify(hits)}`,
      observed: `meta:${hits.join(",")}`,
    };
  },
);

// ---------------------------------------------------------------- PAIR 19
// The scoping predicate did NOT change what a path MEANS. `classifyTodoPath` must
// still read an archived path as ORDINARY and DECLARED — the measured behaviour
// PAIR 7 defends. This pair exists so a future change that "simplifies" the two
// into one reclassification reds HERE, where the reason is written down.
pair(
  "scope/excluding-a-path-from-a-census-does-NOT-reclassify-it",
  () => {
    const rel = "workspaces/_archive/proj/todos/active/00-plan.md";
    const r = M.classifyTodoPath(rel);
    return {
      ok:
        M.isMetaWorkspaceTodoPath(rel) === true &&
        r.ok === true &&
        r.outcome === "declared" &&
        r.state === "active" &&
        r.closed === false,
      why: `archived path must be BOTH meta-scoped AND still declared/active, got ${JSON.stringify({ meta: M.isMetaWorkspaceTodoPath(rel), r })}`,
      observed: `meta=${M.isMetaWorkspaceTodoPath(rel)}:${r.outcome}`,
    };
  },
  () => {
    const rel = "workspaces/live/todos/active/00-plan.md";
    const r = M.classifyTodoPath(rel);
    return {
      ok:
        M.isMetaWorkspaceTodoPath(rel) === false &&
        r.ok === true &&
        r.outcome === "declared" &&
        r.state === "active",
      why: `a live path must classify identically and NOT be meta-scoped, got ${JSON.stringify({ meta: M.isMetaWorkspaceTodoPath(rel), r })}`,
      observed: `meta=${M.isMetaWorkspaceTodoPath(rel)}:${r.outcome}`,
    };
  },
);

// ---------------------------------------------------------------- PAIR 20
// `_archive` is on the lifecycle allowlist and declares its OWN state; a DIFFERENT
// underscore directory under `todos/` is not, and stays UNDECLARED.
//
// The pair exists because the tempting repair is a PREFIX rule (`_`-anything means
// archived), and that rule would declare live work closed: the corpus's second
// underscore directory holds work delegated to another BUILD repo, not finished
// work. So the RED pole asserts the failure IDENTITY — `undeclared`, with the
// lifecycle segment NAMED — for exactly the sibling a prefix rule would swallow.
//
// The GREEN pole also pins the state VALUE: `archived`, not `completed`. Folding it
// into `completed` would write a completion nobody declared into the durable ledger,
// and would pass any assertion that only checked `closed === true`.
pair(
  "lifecycle/_archive-DECLARES-archived-while-a-sibling-underscore-dir-stays-UNDECLARED",
  () => {
    const rel = "workspaces/_archive/terrene-stack-gaps/todos/_archive-build-delegated/TSG-600.md";
    const r = M.classifyTodoPath(rel);
    const s = M.scanDurableTodos([rel]);
    return {
      ok:
        r.ok === true &&
        r.outcome === "undeclared" &&
        r.lifecycle === "_archive-build-delegated" &&
        r.state === undefined &&
        s.ok === true &&
        s.declared.size === 0 &&
        s.undeclared.length === 1 &&
        s.undeclared[0].lifecycle === "_archive-build-delegated",
      why: `a non-allowlisted underscore dir must stay UNDECLARED with its lifecycle named, got ${JSON.stringify({ r, undeclared: s.undeclared })}`,
      observed: `${r.outcome}:${r.lifecycle}:state=${String(r.state)}`,
    };
  },
  () => {
    const rel = "workspaces/multi-operator-coc/todos/_archive/00-todos.md";
    const r = M.classifyTodoPath(rel);
    const s = M.scanDurableTodos([rel]);
    return {
      ok:
        r.ok === true &&
        r.outcome === "declared" &&
        r.lifecycle === "_archive" &&
        r.state === "archived" &&
        r.status === "todo:archived" &&
        r.closed === true &&
        r.id === "multi-operator-coc/00-todos" &&
        s.ok === true &&
        s.undeclared.length === 0 &&
        s.declared.size === 1,
      why: `todos/_archive/ must DECLARE state 'archived' and be CLOSED, got ${JSON.stringify({ r, undeclared: s.undeclared })}`,
      observed: `${r.outcome}:${r.lifecycle}:state=${String(r.state)}`,
    };
  },
);

// ---------------------------------------------------------------- PAIR 21
// The consequence the census actually reads: an ARCHIVED item is CLOSED, so
// `bindOpenItems` never asks it for a lane, so it reaches NEITHER the `unbound`
// class NOR the `lifecycle-undeclared` UNKNOWN. An un-bound `active/` item, by
// contrast, MUST still surface as `unbound` — the fix must not have silenced that.
//
// Both poles read the SAME file text — a frontmatter block carrying no `lane:` key,
// so the RED pole reaches the SPECIFIC unbound reason rather than the generic
// "no leading frontmatter block" — and the only difference is the lifecycle
// directory. A repair that made archived items merely `unbound` instead
// of absent would pass the RED pole and fail here.
pair(
  "lifecycle/an-ARCHIVED-item-is-never-asked-for-a-lane-while-an-active-one-still-is",
  () => {
    const rel = "workspaces/live-ws/todos/active/00-plan.md";
    const s = M.scanDurableTodos([rel]);
    const b = M.bindOpenItems(s, () => "---\ntitle: a todo with no lane key\n---\n# body\n");
    return {
      ok:
        b.ok === true &&
        b.items.length === 1 &&
        b.items[0].outcome === "unbound" &&
        /declares no `lane:` key/.test(b.items[0].reason || ""),
      why: `an un-bound ACTIVE item must still report unbound with its reason, got ${JSON.stringify(b)}`,
      observed: `items=${(b.items || []).length}:${(b.items[0] || {}).outcome}`,
    };
  },
  () => {
    const rel = "workspaces/live-ws/todos/_archive/00-plan.md";
    const s = M.scanDurableTodos([rel]);
    const b = M.bindOpenItems(s, () => "---\ntitle: a todo with no lane key\n---\n# body\n");
    return {
      ok:
        s.ok === true &&
        s.undeclared.length === 0 &&
        b.ok === true &&
        b.items.length === 0,
      why: `an ARCHIVED item must be neither undeclared nor asked for a lane, got ${JSON.stringify({ undeclared: s.undeclared, items: b.items })}`,
      observed: `items=${(b.items || []).length}:${(b.items[0] || {}).outcome}`,
    };
  },
);

console.log("");
console.log(`todo-durable-ingest fixtures: ${pass} passed, ${fail} failed`);
if (fail) {
  for (const f of failures) console.log(`  failing: ${f}`);
  process.exitCode = 1;
}
