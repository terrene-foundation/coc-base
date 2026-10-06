#!/usr/bin/env node
/*
 * Fixture runner for the destination-divergence AUTHORSHIP PARTITION in
 * `.claude/bin/sync-tier-aware.mjs`.
 *
 *   node .claude/audit-fixtures/destination-divergence-authorship/run.mjs
 *
 * Exit 0 = every case behaved as expected; 1 = a regression.
 *
 * WHY THIS EXISTS. The fence's refusal list is a SYMPTOM REPORT: it names the
 * diverged paths and is IDENTICAL in shape whether canon is AHEAD of the target
 * (accepting is lossless) or BEHIND it (accepting destroys the destination's
 * work). Measured 2026-08-19, two targets hours apart: kailash-coc-rs flagged
 * 112 paths, 21 of them authored solely by prior loom deliveries; kailash-rs
 * flagged 71, ZERO of them. Same output shape, opposite correct response, one
 * day of content adjudication to tell them apart.
 *
 * WHAT THIS INSTRUMENT CAN AND CANNOT SAY (instrument-discipline.md MUST-1).
 * Every case drives the REAL `divergenceAuthorship` / `destinationDivergence` /
 * `destinationDivergenceMessage` against REAL temp git repositories with REAL
 * commits — never a lexical scan of the source for the string `chore(coc-sync)`,
 * which would pass on a build that imported the regex and never applied it. Each
 * case names the value it would print were its proposition FALSE.
 *
 * THE CONTROLS, all in this runner:
 *   A-1  BIPOLAR on the classifier: the SAME tree, SAME paths, SAME range yields
 *        `loom-origin` under a delivery subject and `locally-authored` under a
 *        destination subject. A classifier returning one bucket for both carries
 *        no information, and A-1 is the case that would say so.
 *   A-2  LEGACY-shape regression lock. `chore(coc-sync): …` is a real historical
 *        loom delivery subject (measured: 8 at kailash-coc-rs, 7 at
 *        kailash-coc-claude-rs, 3 at coc-base) that `isGate2DeliverySubject`
 *        does NOT match. A partition built on that predicate alone reports 18 of
 *        kailash-coc-rs's 40 real deliveries as locally-authored and cries
 *        BEHIND on a target canon is ahead of.
 *   A-3  NEGATIVE lock on the widening: `feat(sync):` / `fix(sync):` are
 *        DESTINATION-authored fixes to sync machinery and MUST stay
 *        locally-authored. Without this, "recognize more sync-ish subjects"
 *        silently swallows the destination's own work.
 *   A-4  the empty range does NOT fall through to the alarming branch.
 *   A-5  FAIL-SOFT: an injected `git log` failure reports UNAVAILABLE and the
 *        refusal still prints every path plus its escape hatch.
 *   A-6  the refusal is UNWEAKENED: status, refusal count, and the operator's
 *        two options are byte-identical to the pre-partition contract.
 *
 * Every token in every fixture is SYNTHETIC. No real operator display_id, org
 * slug, home path, or repo name appears anywhere under this directory.
 */

import "../_lib/no-ambient-git.cjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const ENGINE = path.join(REPO, ".claude", "bin", "sync-tier-aware.mjs");

const {
  divergenceAuthorship,
  destinationDivergence,
  destinationDivergenceMessage,
  isLoomDeliveryAuthorshipSubject,
  isGate2DeliverySubject,
  defaultGitRunner,
} = await import(ENGINE);

let passes = 0;
let failures = 0;
function ok(name, detail) {
  passes++;
  process.stdout.write(`PASS ${name}${detail ? ` — ${detail}` : ""}\n`);
}
function bad(name, detail) {
  failures++;
  process.stdout.write(`FAIL ${name}\n    ${detail}\n`);
}
function check(name, fn) {
  try {
    const detail = fn();
    ok(name, detail);
  } catch (e) {
    bad(name, e && e.message ? e.message : String(e));
  }
}

// --------------------------------------------------------------------------
// Synthetic destinations. Real git, real commits — the only shape that can
// falsify a claim about what `git log` attributes.
// --------------------------------------------------------------------------

function git(dir, args) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

const TMPDIRS = [];
function mkrepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dda-"));
  TMPDIRS.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "fixture@example.invalid"]);
  git(dir, ["config", "user.name", "Authorship Fixture"]);
  return dir;
}

/** Write `rel`, commit it under `subject`, return the new HEAD sha. */
function commitFile(dir, rel, body, subject) {
  const abs = path.join(dir, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", subject]);
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

// The ONE current Gate-2 producer's subject (sync-gate2-worktree.mjs).
const DELIVERY = "chore(sync): Gate-2 use rs from loom 000000000000";
// A real LEGACY loom delivery subject, taken from destination history.
const LEGACY_DELIVERY = "chore(coc-sync): distribute loom 2.38.0 (Gate 2 distribute-only)";
// Genuine destination-authored work.
const LOCAL_WORK = "fix(security): lock the HIGH-1 regression the review found";
// Destination-authored work on the sync machinery itself — the near-miss.
const LOCAL_SYNCISH = "fix(sync): correct the emitted marker on the base lane";

const P1 = ".claude/rules/example-alpha.md";
const P2 = ".claude/rules/example-beta.md";

// --------------------------------------------------------------------------
// A-1 — BIPOLAR: the classifier returns DIFFERENT buckets for the two poles.
// Falsifying result: both poles print the same bucket.
// --------------------------------------------------------------------------
check("A-1a loom-origin pole (current producer subject)", () => {
  const dir = mkrepo();
  const base = commitFile(dir, P1, "v1\n", "chore: seed");
  commitFile(dir, P1, "v2\n", DELIVERY);
  const a = divergenceAuthorship({ dir, baseSha: base, relPaths: [P1] });
  assert.equal(a.status, "ok");
  assert.equal(a.byPath.get(P1), "loom-origin", `bucket was ${a.byPath.get(P1)}`);
  assert.equal(a.loom_origin, 1);
  assert.equal(a.locally_authored, 0);
  return "1 loom-origin, 0 locally-authored";
});

check("A-1b locally-authored pole (real destination work)", () => {
  const dir = mkrepo();
  const base = commitFile(dir, P1, "v1\n", "chore: seed");
  commitFile(dir, P1, "v2\n", LOCAL_WORK);
  const a = divergenceAuthorship({ dir, baseSha: base, relPaths: [P1] });
  assert.equal(a.byPath.get(P1), "locally-authored", `bucket was ${a.byPath.get(P1)}`);
  assert.equal(a.locally_authored, 1);
  assert.equal(a.loom_origin, 0);
  return "0 loom-origin, 1 locally-authored";
});

check("A-1c a path touched by BOTH is locally-authored (any non-delivery wins)", () => {
  const dir = mkrepo();
  const base = commitFile(dir, P1, "v1\n", "chore: seed");
  commitFile(dir, P1, "v2\n", DELIVERY);
  commitFile(dir, P1, "v3\n", LOCAL_WORK);
  const a = divergenceAuthorship({ dir, baseSha: base, relPaths: [P1] });
  assert.equal(a.byPath.get(P1), "locally-authored");
  return "delivery + local work => locally-authored";
});

// --------------------------------------------------------------------------
// A-2 — LEGACY-shape regression lock (the measured 2026-08-19 miss).
// Falsifying result: `chore(coc-sync)` lands in locally-authored.
// --------------------------------------------------------------------------
check("A-2 legacy chore(coc-sync) delivery is loom-origin", () => {
  const dir = mkrepo();
  const base = commitFile(dir, P1, "v1\n", "chore: seed");
  commitFile(dir, P1, "v2\n", LEGACY_DELIVERY);
  const a = divergenceAuthorship({ dir, baseSha: base, relPaths: [P1] });
  assert.equal(a.byPath.get(P1), "loom-origin", `bucket was ${a.byPath.get(P1)}`);
  // And the reason the wider predicate is REQUIRED, stated as a measurement:
  // the watermark predicate alone does not match this real subject.
  assert.equal(isGate2DeliverySubject(LEGACY_DELIVERY), false);
  assert.equal(isLoomDeliveryAuthorshipSubject(LEGACY_DELIVERY), true);
  return "isGate2DeliverySubject=false, isLoomDeliveryAuthorshipSubject=true";
});

// --------------------------------------------------------------------------
// A-3 — NEGATIVE lock: sync-adjacent DESTINATION work stays locally-authored.
// Falsifying result: `fix(sync):` reported loom-origin.
// --------------------------------------------------------------------------
check("A-3 fix(sync)/feat(sync) are destination work, NOT deliveries", () => {
  const dir = mkrepo();
  const base = commitFile(dir, P1, "v1\n", "chore: seed");
  commitFile(dir, P1, "v2\n", LOCAL_SYNCISH);
  const a = divergenceAuthorship({ dir, baseSha: base, relPaths: [P1] });
  assert.equal(a.byPath.get(P1), "locally-authored", `bucket was ${a.byPath.get(P1)}`);
  assert.equal(isLoomDeliveryAuthorshipSubject("feat(sync): add a lane"), false);
  assert.equal(isLoomDeliveryAuthorshipSubject("fix(sync-hygiene,schema): x"), false);
  return "fix(sync)/feat(sync) excluded";
});

// --------------------------------------------------------------------------
// A-4 — the DEGENERATE empty range does not fall through to the alarm.
// Falsifying result: a path with no commits reported locally-authored.
// --------------------------------------------------------------------------
check("A-4 empty commit range => unattributed, never locally-authored", () => {
  const dir = mkrepo();
  const head = commitFile(dir, P1, "v1\n", "chore: seed");
  const a = divergenceAuthorship({ dir, baseSha: head, relPaths: [P1] });
  assert.equal(a.status, "ok");
  assert.equal(a.byPath.get(P1), "unattributed", `bucket was ${a.byPath.get(P1)}`);
  assert.equal(a.locally_authored, 0, "an empty range must NOT reach the alarming branch");
  assert.equal(a.unattributed, 1);
  return "0 locally-authored, 1 unattributed";
});

check("A-4b no paths at all => ok with zero counts, never a crash", () => {
  const dir = mkrepo();
  const head = commitFile(dir, P1, "v1\n", "chore: seed");
  const a = divergenceAuthorship({ dir, baseSha: head, relPaths: [] });
  assert.equal(a.status, "ok");
  assert.equal(a.loom_origin + a.locally_authored + a.unattributed, 0);
  return "empty input handled";
});

// --------------------------------------------------------------------------
// A-5 — FAIL SOFT. Degenerate cases: unreachable baseline, bad runner, and a
// destination that is not a checkout. Falsifying result: a throw, or a refusal
// that lost its paths / its escape hatch.
// --------------------------------------------------------------------------
check("A-5a unreachable baseline => UNAVAILABLE, never a throw", () => {
  const dir = mkrepo();
  commitFile(dir, P1, "v1\n", "chore: seed");
  const a = divergenceAuthorship({ dir, baseSha: "0".repeat(40), relPaths: [P1] });
  assert.equal(a.status, "unavailable");
  assert.ok(a.reason && a.reason.length > 0, "UNAVAILABLE must carry a reason");
  return "status=unavailable";
});

check("A-5b missing baseline sha => UNAVAILABLE", () => {
  const dir = mkrepo();
  commitFile(dir, P1, "v1\n", "chore: seed");
  const a = divergenceAuthorship({ dir, baseSha: null, relPaths: [P1] });
  assert.equal(a.status, "unavailable");
  return "status=unavailable";
});

check("A-5c not-a-git-repo => fence says not-a-repo and carries no authorship", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dda-bare-"));
  TMPDIRS.push(dir);
  const v = destinationDivergence({ dir, plan: emptyPlan([P1]) });
  assert.equal(v.status, "not-a-repo");
  assert.equal(v.refusals.length, 0);
  assert.ok(!v.authorship, "a non-checkout must not fabricate a partition");
  return "status=not-a-repo";
});

check("A-5d injected git-log failure => UNAVAILABLE, refusal STILL prints every path", () => {
  const dir = mkrepo();
  commitFile(dir, P1, "v1\n", DELIVERY);
  commitFile(dir, P1, "v2\n", LOCAL_WORK);
  commitFile(dir, P2, "v2\n", LOCAL_WORK);
  // Boundary injection: everything works EXCEPT the authorship probe.
  const runGit = (args, opts) => {
    if (args.includes("--name-only") && args.includes("-z")) {
      throw new Error("injected: git log unavailable");
    }
    return defaultGitRunner(args, opts);
  };
  const v = destinationDivergence({ dir, plan: emptyPlan([P1, P2]), runGit });
  assert.equal(v.status, "diverged", "the refusal itself must be unaffected");
  assert.equal(v.refusals.length, 2);
  assert.equal(v.authorship.status, "unavailable");
  const msg = destinationDivergenceMessage(v, "example-target");
  assert.match(msg, /authorship partition: UNAVAILABLE/);
  assert.ok(msg.includes(P1) && msg.includes(P2), "both paths must still be listed");
  assert.match(msg, /--accept-divergence/, "the escape hatch must survive");
  return "UNAVAILABLE + 2 paths + escape hatch intact";
});

// --------------------------------------------------------------------------
// A-6 — the REFUSAL IS UNWEAKENED, and the summary discriminates end-to-end.
// Falsifying result: a BEHIND warning on the ahead pole, or none on the behind
// pole, or a lost refusal.
// --------------------------------------------------------------------------

/** A minimal plan that writes exactly `rels` — no manifest needed. */
function emptyPlan(rels) {
  return {
    files: rels.map((p) => ({ action: "copy", path: p })),
    variant_only: [],
    overlays: [],
    purge: [],
    target_owned: [],
  };
}

check("A-6a AHEAD pole: all loom-origin => no BEHIND warning, refusal intact", () => {
  const dir = mkrepo();
  commitFile(dir, P1, "v1\n", DELIVERY);
  commitFile(dir, P1, "v2\n", LEGACY_DELIVERY);
  commitFile(dir, P2, "v2\n", LEGACY_DELIVERY);
  const v = destinationDivergence({ dir, plan: emptyPlan([P1, P2]) });
  assert.equal(v.status, "diverged");
  assert.equal(v.refusals.length, 2);
  assert.equal(v.authorship.loom_origin, 2, "both paths are loom's own prior output");
  assert.equal(v.authorship.locally_authored, 0);
  const msg = destinationDivergenceMessage(v, "example-target");
  assert.match(msg, /2 divergent path\(s\): 2 loom-origin, 0 locally-authored/);
  assert.doesNotMatch(msg, /may be BEHIND/, "no BEHIND warning is owed on the ahead pole");
  assert.match(msg, /100% loom-origin/);
  assert.match(msg, /\[loom-origin — /, "the group header names the bucket");
  assert.match(msg, /refusing 2 lossy/);
  assert.match(msg, /--accept-divergence/);
  return "2 loom-origin, no BEHIND warning";
});

check("A-6b BEHIND pole: none loom-origin => BEHIND warning fires", () => {
  const dir = mkrepo();
  commitFile(dir, P1, "v1\n", DELIVERY);
  commitFile(dir, P1, "v2\n", LOCAL_WORK);
  commitFile(dir, P2, "v2\n", LOCAL_SYNCISH);
  const v = destinationDivergence({ dir, plan: emptyPlan([P1, P2]) });
  assert.equal(v.status, "diverged");
  assert.equal(v.refusals.length, 2);
  assert.equal(v.authorship.locally_authored, 2);
  const msg = destinationDivergenceMessage(v, "example-target");
  assert.match(msg, /2 divergent path\(s\): 0 loom-origin, 2 locally-authored/);
  assert.match(msg, /0% loom-origin: canon may be BEHIND this target/);
  assert.match(msg, /\[locally-authored — /);
  assert.match(msg, /refusing 2 lossy/, "the refusal is unchanged");
  return "0% loom-origin + BEHIND warning";
});

// --------------------------------------------------------------------------
// A-8 — REGRESSION LOCK for a defect this fixture set's sibling suite caught
// during development: an INLINE bucket tag on the path line
// (`    - <path>  [locally-authored]`) silently poisoned every path an operator
// copies into `--accept-divergence`, because the usage text says "copy the
// paths verbatim" and DD-10/DD-8 machine-parse `/^ {4}- (.+)$/`. The bucket is
// carried by a GROUP HEADER instead. Falsifying result: a `    - ` line whose
// captured text is not exactly a refused path.
// --------------------------------------------------------------------------
check("A-8 every `    - ` line is EXACTLY a refused path (copy-verbatim contract)", () => {
  const dir = mkrepo();
  commitFile(dir, P1, "v1\n", DELIVERY);
  commitFile(dir, P1, "v2\n", LOCAL_WORK);
  commitFile(dir, P2, "v2\n", LEGACY_DELIVERY);
  const v = destinationDivergence({ dir, plan: emptyPlan([P1, P2]) });
  assert.equal(v.authorship.status, "ok");
  assert.equal(v.authorship.loom_origin, 1);
  assert.equal(v.authorship.locally_authored, 1);
  const msg = destinationDivergenceMessage(v, "example-target");
  // The SAME extractor DD-10 uses. A tag on either side of the path reds here.
  const parsed = msg
    .split("\n")
    .map((l) => /^ {4}- (.+)$/.exec(l))
    .filter(Boolean)
    .map((m) => m[1]);
  const refused = v.refusals.map((r) => r.path).sort();
  assert.deepEqual(parsed.sort(), refused, "printed paths must round-trip unchanged");
  // And the buckets ARE still visible — grouped, not lost.
  assert.match(msg, /\[locally-authored — /);
  assert.match(msg, /\[loom-origin — /);
  return `${parsed.length} paths round-trip; both group headers present`;
});

check("A-6c MIXED: counts partition exactly, BEHIND warning still fires", () => {
  const dir = mkrepo();
  commitFile(dir, P1, "v1\n", DELIVERY);
  commitFile(dir, P1, "v2\n", LEGACY_DELIVERY);
  commitFile(dir, P2, "v2\n", LOCAL_WORK);
  const v = destinationDivergence({ dir, plan: emptyPlan([P1, P2]) });
  const a = v.authorship;
  assert.equal(a.loom_origin + a.locally_authored + a.unattributed, v.refusals.length);
  assert.equal(a.loom_origin, 1);
  assert.equal(a.locally_authored, 1);
  const msg = destinationDivergenceMessage(v, "example-target");
  assert.match(msg, /1 loom-origin, 1 locally-authored/);
  assert.match(msg, /may be BEHIND/, "any locally-authored path warrants the warning");
  return "1 + 1, warning fires";
});

check("A-6d the partition NEVER changes status or refusal count", () => {
  // Same tree, two runs: one with the authorship probe working, one with it
  // injected-broken. status and refusals must be identical.
  const dir = mkrepo();
  commitFile(dir, P1, "v1\n", DELIVERY);
  commitFile(dir, P1, "v2\n", LOCAL_WORK);
  const good = destinationDivergence({ dir, plan: emptyPlan([P1]) });
  const broken = destinationDivergence({
    dir,
    plan: emptyPlan([P1]),
    runGit: (args, opts) => {
      if (args.includes("--name-only") && args.includes("-z")) throw new Error("injected");
      return defaultGitRunner(args, opts);
    },
  });
  assert.equal(good.status, broken.status);
  assert.deepEqual(good.refusals, broken.refusals);
  assert.equal(good.status, "diverged");
  return "status + refusals identical with and without the diagnostic";
});

check("A-6e a CLEAN destination gets no partition and stays clean", () => {
  const dir = mkrepo();
  commitFile(dir, P1, "v1\n", DELIVERY);
  const v = destinationDivergence({ dir, plan: emptyPlan([P1]) });
  assert.equal(v.status, "clean");
  assert.equal(v.refusals.length, 0);
  assert.equal(v.authorship, null, "nothing to explain => no probe run");
  return "clean, no probe";
});

// --------------------------------------------------------------------------
// A-7 — batching correctness at scale (the cost claim's correctness half).
// Falsifying result: a chunked run mis-attributes or drops paths.
// --------------------------------------------------------------------------
check("A-7 450 paths across chunk boundaries partition exactly", () => {
  const dir = mkrepo();
  const rels = [];
  for (let i = 0; i < 450; i++) rels.push(`.claude/rules/gen-${String(i).padStart(3, "0")}.md`);
  for (const rel of rels) {
    const abs = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "v1\n");
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", DELIVERY]);
  const base = git(dir, ["rev-parse", "HEAD"]).trim();
  // Half get a delivery, half get destination work.
  for (const rel of rels.slice(0, 225)) fs.writeFileSync(path.join(dir, ...rel.split("/")), "v2\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", LEGACY_DELIVERY]);
  for (const rel of rels.slice(225)) fs.writeFileSync(path.join(dir, ...rel.split("/")), "v2\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", LOCAL_WORK]);
  const a = divergenceAuthorship({ dir, baseSha: base, relPaths: rels });
  assert.equal(a.status, "ok");
  assert.equal(a.loom_origin, 225, `loom_origin was ${a.loom_origin}`);
  assert.equal(a.locally_authored, 225, `locally_authored was ${a.locally_authored}`);
  assert.equal(a.unattributed, 0);
  return "225/225 across 3 chunks";
});

for (const d of TMPDIRS) {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch {
    /* temp cleanup is best-effort; a leaked tmpdir is not a regression */
  }
}

process.stdout.write(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
