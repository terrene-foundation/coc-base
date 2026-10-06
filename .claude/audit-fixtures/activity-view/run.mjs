#!/usr/bin/env node
/*
 * activity-view — ACTIVITY (what is happening) is NOT the BURNDOWN (what we committed to).
 * (`.claude/bin/activity-build.mjs`)
 *
 * ── THE DECISION THIS PINS ─────────────────────────────────────────────────
 *
 * Emergent work — a todo written mid-session because a finding opened three follow-ups —
 * is ACTIVITY, not backlog. It becomes backlog only when a human promotes it, and
 * promotion is EXPLICIT-ONLY by ratified decision.
 *
 * The alternative (give emergent todos a burndown page) was rejected on measured
 * grounds: `max_rows` is 277 against a current 267 — TEN rows of headroom, and one
 * session generates more emergent todos than that. It would also inflate the
 * denominator, degrading every percentage in the report, and turn an adjudicated backlog
 * into a feed nobody drains.
 *
 * So the burndown total staying at 267 while real work happens is CORRECT, and this
 * suite's job is to keep it that way while making the activity visible.
 *
 * ── THE THREE-WAY PARTITION IS THE WHOLE INSTRUMENT ────────────────────────
 *
 * A log item is EMERGENT iff it is claimed by no declared source AND is not closed. Get
 * any of the three legs wrong and the view either double-counts the backlog, hides real
 * work, or accumulates history forever. Each leg has its own case, and they run against
 * ONE log so a mis-partition cannot hide behind a different fixture.
 */

import "../_lib/no-ambient-git.cjs";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const GEN = path.join(REPO_ROOT, ".claude", "bin", "activity-build.mjs");

let cases = 0;
const failures = [];
const tmpDirs = [];

function check(name, verdictOrFn) {
  cases++;
  let verdict;
  try {
    verdict = typeof verdictOrFn === "function" ? verdictOrFn() : verdictOrFn;
  } catch (e) {
    verdict = `threw: ${(e && e.message) || String(e)}`;
  }
  if (verdict === true) {
    console.log(`PASS ${name}`);
    return true;
  }
  failures.push(`  ${name}\n      ${verdict}`);
  console.log(`FAIL ${name} — ${verdict}`);
  return false;
}

function pair(name, redWhat, red, greenWhat, green) {
  const r = red();
  const g = green();
  check(`${name} · RED   · ${redWhat}`, r);
  check(`${name} · GREEN · ${greenWhat}`, g);
  check(
    `${name} · NON-VACUOUS · the two poles produce DIFFERENT verdicts`,
    r === true && g === true ? true : "a pole failed, so non-vacuity cannot be asserted from this run",
  );
}

const iso = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600000).toISOString();

/**
 * ONE repo carrying all three partition legs at once, so a mis-partition cannot hide
 * behind a fixture that only contains the leg it gets right.
 */
function mkRepo({ sources = true, extraLines = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "activity-fx-"));
  tmpDirs.push(dir);
  const g = (a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "fixture@example.invalid"]);
  g(["config", "user.name", "fixture"]);
  g(["config", "commit.gpgsign", "false"]);
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.symlinkSync(path.join(REPO_ROOT, ".claude", "hooks"), path.join(dir, ".claude", "hooks"));
  fs.mkdirSync(path.join(dir, "burndown"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "burndown-manifest.json"),
    JSON.stringify({
      _schema: "burndown-manifest/v1",
      target: "B.md",
      pages: ["P"],
      sources: sources ? [{ path: "burndown/register.json", kind: "register", precedence: 0 }] : [],
      tracker: { path: "burndown/events.jsonl", kind: "event-log", anchor_roots: ["workspaces/"] },
    }, null, 2),
  );
  if (sources) {
    fs.writeFileSync(path.join(dir, "burndown", "register.json"), JSON.stringify({ items: [{ id: "R1-TRACKED", page: "P", status: "Not started" }] }, null, 2));
  }
  const lines = [
    JSON.stringify({ item_id: "R1-TRACKED", kind: "genesis", status: "Not started", item: "a tracked thing", timestamp: iso(100) }),
    JSON.stringify({ item_id: "todo-aaaa1111-open", kind: "transition", status: "todo:in_progress", item: "an emergent thing nobody adjudicated", timestamp: iso(50) }),
    JSON.stringify({ item_id: "todo-bbbb2222-done", kind: "transition", status: "todo:completed", item: "already done", timestamp: iso(50) }),
    ...extraLines,
  ];
  fs.writeFileSync(path.join(dir, "burndown", "events.jsonl"), `${lines.join("\n")}\n`);
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "seed"]);
  return dir;
}

const run = (dir, a) => spawnSync(process.execPath, [GEN, "--repo", dir, ...a], { cwd: dir, encoding: "utf8", timeout: 60000 });
const asJson = (dir) => {
  const r = run(dir, ["--json"]);
  try {
    return { r, j: JSON.parse(r.stdout || "{}") };
  } catch {
    return { r, j: null };
  }
};

// ── ARM 1: the three-way partition ──────────────────────────────────────────

check("arm1/an-UNCLAIMED-open-item-is-EMERGENT", () => {
  const { j } = asJson(mkRepo());
  if (!j) return "the generator produced no JSON";
  return j.emergent === 1 ? true : `expected exactly 1 emergent item; got ${j.emergent}`;
});

check("arm1/a-BACKLOG-item-is-NOT-emergent", () => {
  // If the source-claimed id leaked in, the count would be 2 and the view would
  // double-count everything the burndown already owns.
  const { r } = asJson(mkRepo());
  const w = run(mkRepo(), ["--write"]);
  void r;
  const dir = mkRepo();
  run(dir, ["--write"]);
  const md = fs.readFileSync(path.join(dir, "ACTIVITY.md"), "utf8");
  void w;
  return md.includes("R1-TRACKED") ? "a source-claimed item appeared in the ACTIVITY view — it is backlog, the burndown owns it" : true;
});

check("arm1/a-CLOSED-emergent-item-is-history-not-in-flight", () => {
  const dir = mkRepo();
  run(dir, ["--write"]);
  const md = fs.readFileSync(path.join(dir, "ACTIVITY.md"), "utf8");
  return md.includes("todo-bbbb2222-done")
    ? "a COMPLETED emergent item is still listed — the view would accumulate history forever"
    : true;
});

pair(
  "emergent-detection-discriminates",
  "a log carrying an unclaimed OPEN item reports it",
  () => {
    const { j } = asJson(mkRepo());
    return j && j.emergent === 1 ? true : `expected 1; got ${j && j.emergent}`;
  },
  "a log whose ONLY unclaimed items are CLOSED reports zero — the detector is not counting everything",
  () => {
    const dir = mkRepo({ extraLines: [] });
    // Close the one open emergent item; nothing unclaimed remains open.
    const p = path.join(dir, "burndown", "events.jsonl");
    fs.appendFileSync(p, `${JSON.stringify({ item_id: "todo-aaaa1111-open", kind: "transition", status: "todo:completed", item: "now done", timestamp: iso(1) })}\n`);
    const r = spawnSync(process.execPath, [GEN, "--repo", dir, "--json"], { encoding: "utf8", timeout: 60000 });
    let j = null;
    try {
      j = JSON.parse(r.stdout || "{}");
    } catch {
      j = null;
    }
    return j && j.emergent === 0 ? true : `expected 0 after closing the only open item; got ${j && j.emergent}`;
  },
);

// THE SECOND CLOSED-STATUS SURFACE, instrumented rather than assumed.
//
// `activity-build.mjs::CLOSED` is an INDEPENDENT closed-status set with no callee
// shared with the durable-todo producer that mints the statuses. Anything absent
// from it falls through to `emergent`, i.e. reads as IN-FLIGHT — so a producer that
// adds a closure state and does not teach this set fails OPEN here, which is the
// surface-parity shape `security.md` § Enforcement-Surface Parity names.
//
// `todo:archived` is that producer's third closure state
// (`hooks/lib/todo-durable.js::LIFECYCLE_DIRS`, `_archive` → `archived`). Before
// this pair the suite exercised `todo:completed` ONLY, so removing `todo:archived`
// from the set produced an EMPTY red-set here — an absent instrument, never a
// vacuous case. The two poles append the SAME item one status apart, so the only
// thing separating them is whether this surface recognises the state as closed.
pair(
  "second-surface/the-durable-producers-ARCHIVED-state-CLOSES-here-too",
  "an unclaimed item left in a NON-closed state is still in-flight",
  () => {
    const dir = mkRepo();
    const p = path.join(dir, "burndown", "events.jsonl");
    fs.appendFileSync(p, `${JSON.stringify({ item_id: "todo-aaaa1111-open", kind: "transition", status: "todo:in_progress", item: "still going", timestamp: iso(1) })}\n`);
    const r = spawnSync(process.execPath, [GEN, "--repo", dir, "--json"], { encoding: "utf8", timeout: 60000 });
    let j = null;
    try {
      j = JSON.parse(r.stdout || "{}");
    } catch {
      j = null;
    }
    return j && j.emergent === 1 ? true : `expected 1 while the item is open; got ${j && j.emergent}`;
  },
  "the SAME item closed with todo:archived reports zero",
  () => {
    const dir = mkRepo();
    const p = path.join(dir, "burndown", "events.jsonl");
    fs.appendFileSync(p, `${JSON.stringify({ item_id: "todo-aaaa1111-open", kind: "transition", status: "todo:archived", item: "archived, superseded", timestamp: iso(1) })}\n`);
    const r = spawnSync(process.execPath, [GEN, "--repo", dir, "--json"], { encoding: "utf8", timeout: 60000 });
    let j = null;
    try {
      j = JSON.parse(r.stdout || "{}");
    } catch {
      j = null;
    }
    return j && j.emergent === 0 ? true : `expected 0 once the only open item is ARCHIVED; got ${j && j.emergent} — this surface does not recognise todo:archived as closed`;
  },
);

// ── ARM 2: it reports an AGE DISTRIBUTION, never a bare count ───────────────

check("arm2/the-view-reports-an-AGE-DISTRIBUTION-not-a-bare-count", () => {
  // `wip-discipline.md` MUST-3: a count alone does not satisfy it. This view exists to
  // make a promotion decision informed, and "3 items" informs nothing.
  const dir = mkRepo();
  run(dir, ["--write"]);
  const md = fs.readFileSync(path.join(dir, "ACTIVITY.md"), "utf8");
  for (const tok of ["p50", "p90", "max"]) {
    if (!md.includes(tok)) return `the rendered view carries no ${tok} — that is a bare count`;
  }
  return /past the \d+h bound/.test(md) ? true : "the view does not name what is past the age bound";
});

check("arm2/it-NAMES-the-items-past-bound-not-just-how-many", () => {
  const dir = mkRepo();
  run(dir, ["--write"]);
  const md = fs.readFileSync(path.join(dir, "ACTIVITY.md"), "utf8");
  return md.includes("todo-aaaa1111-open")
    ? true
    : "an item 50h past first_seen is not NAMED — a count nobody can act on is the shape MUST-3 forbids";
});

check("arm2/the-view-states-that-promotion-is-EXPLICIT-ONLY", () => {
  // The ratified decision. If a later change makes promotion automatic, the surface that
  // told operators otherwise must fail rather than quietly lie.
  const dir = mkRepo();
  run(dir, ["--write"]);
  const md = fs.readFileSync(path.join(dir, "ACTIVITY.md"), "utf8");
  return /explicit-only/i.test(md) && /not backlog/i.test(md)
    ? true
    : "the view does not state that an emergent item is not backlog until explicitly promoted";
});

// ── ARM 3: staleness, and the refusals ──────────────────────────────────────

pair(
  "check-discriminates",
  "--check REDS when the view is absent",
  () => {
    const r = run(mkRepo(), ["--check"]);
    if (r.status !== 1) return `expected exit 1; got ${r.status}`;
    return /STALE/.test(r.stderr || "") ? true : `refused without naming STALE: ${(r.stderr || "").slice(0, 160)}`;
  },
  "--check is GREEN immediately after --write",
  () => {
    const dir = mkRepo();
    const w = run(dir, ["--write"]);
    if (w.status !== 0) return `--write failed: ${(w.stderr || "").slice(0, 160)}`;
    const c = run(dir, ["--check"]);
    return c.status === 0 ? true : `--check red after a fresh write: ${(c.stderr || "").slice(0, 200)}`;
  },
);

check("arm3/a-STALE-view-REDS-rather-than-being-silently-refreshed", () => {
  const dir = mkRepo();
  run(dir, ["--write"]);
  fs.appendFileSync(
    path.join(dir, "burndown", "events.jsonl"),
    `${JSON.stringify({ item_id: "todo-cccc3333-new", kind: "transition", status: "todo:pending", item: "another emergent thing", timestamp: iso(2) })}\n`,
  );
  const c = run(dir, ["--check"]);
  return c.status === 1 ? true : `a view that no longer matches its source exited ${c.status}`;
});

check("arm3/NO-declared-source-REFUSES-rather-than-calling-everything-emergent", () => {
  // The dangerous default. With no backlog set, every log item is "unclaimed" and the
  // view would report the ENTIRE ledger as emergent — a confident, catastrophic answer.
  const r = run(mkRepo({ sources: false }), ["--json"]);
  if (r.status !== 2) return `expected exit 2 (unrunnable); got ${r.status}`;
  return /EMERGENT/.test(r.stderr || "")
    ? true
    : `refused, but not on the claim this instrument cannot support: ${(r.stderr || "").slice(0, 200)}`;
});

for (const d of tmpDirs) {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

if (failures.length) {
  console.error(`\nactivity-view fixtures: ${failures.length} of ${cases} FAILED\n`);
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`\nactivity-view fixtures: ${cases}/${cases} passed`);
