#!/usr/bin/env node
/**
 * Gate-1 ingest-surface scan — BIPOLAR pole pair.
 *
 * Contract under test: the Step-0 intake scan is scoped to the INGEST SURFACE
 * (the proposal manifest body + the NEW-or-MODIFIED diff set), NOT the
 * producer's whole synced surface.
 *
 * Both poles currently return the WRONG answer against the unscoped gate, which
 * is what makes this pair load-bearing rather than decorative: the fix is
 * provably what moves them.
 *
 *   RED  pole — a disclosure token in the PROPOSAL BODY. The gate MUST REJECT.
 *               Today the unscoped gate returns rc=0 / "Scanned: 0 files",
 *               because `.proposals/` is unconditionally excluded
 *               (scan-synced-disclosure.mjs::isNeverSynced, the `.proposals`
 *               branch). This is the UNDER-COVERING pole.
 *
 *   GREEN pole — a clean ingest surface beside a producer-hygiene finding that
 *               sits OUTSIDE it. The gate MUST ACCEPT. Today the unscoped gate
 *               returns rc=1 and halts Gate-1 on a file Gate-1 never ingests.
 *               This is the OVER-BLOCKING pole.
 *
 * Per instrument-bipolarity.md MUST-2 the RED pole asserts a failure IDENTITY
 * (the finding SHAPE tag and the mapped producer path), never a bare non-zero
 * exit. Per MUST-1 the harness asserts the two verdicts DIFFER.
 *
 * VACUITY GUARD (mandatory, both poles): assert `Scanned: N files` with N > 0.
 * A staging bug that produces an empty root yields `Scanned: 0 files` + rc=0
 * and would score the GREEN pole a pass having examined nothing — the exact
 * indistinguishability scan-synced-disclosure.mjs's own header records for a
 * disarmed surface. Without this guard the GREEN pole is not evidence.
 */

import "../_lib/no-ambient-git.cjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const SCANNER = path.join(REPO, ".claude", "bin", "scan-synced-disclosure.mjs");

// An operator-home-path shape built on `jdoe`, a member of
// `.claude/bin/lib/identity-scrub.mjs::SYNTHETIC_FIXTURE_USERS`.
//
// Both halves of that choice are load-bearing, and the discrimination is PATH-based,
// not token-based (scan-synced-disclosure.mjs:2148-2151):
//
//   - IN THIS FILE the token is SKIPPED, because `detectorFixtureFile =
//     isAuditFixtureFile(rel)` is true for anything under `audit-fixtures/<name>/`
//     and `jdoe` is in the synthetic set. So the repo's own Step-0 scan stays clean.
//   - IN THE TEMP TREES this fixture writes, the SAME token FIRES, because those
//     paths are not under `audit-fixtures/` — so `detectorFixtureFile` is false, the
//     skip does not apply, and the RED pole keeps its real `[SHAPE:operator-home-path]`
//     identity rather than going vacuous.
//
// MEASURED two-pole, not assumed: `/Users/jdoe/repos/kailash-py` at
// `.claude/rules/plain.md` exits 1 with one `[SHAPE:operator-home-path]` finding;
// the identical string at `.claude/audit-fixtures/demo/run.mjs` exits 0 with
// "Scanned: 1 files — 0 findings".
//
// Do NOT substitute a non-allowlisted username to "make the shape fire" — it fires
// either way, and a non-allowlisted one makes THIS FILE a disclosure finding. Do NOT
// add a new name to SYNTHETIC_FIXTURE_USERS to make a scan go green; that is the #264
// leak the scanner exists to prevent and it is BLOCKED.
const TOKEN = "/Users/jdoe/repos/kailash-py";

let failures = 0;
const log = (s) => process.stdout.write(s + "\n");

function fail(caseName, msg) {
  failures++;
  log(`  FAIL [${caseName}] ${msg}`);
}

function mktmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `gate1-${label}-`));
}

/**
 * Stage an ingest surface into a scannable root.
 *
 * The proposal body is staged at `.claude/ingest/proposal-latest.yaml` rather
 * than its real `.claude/.proposals/latest.yaml` path — staging it at the real
 * path would re-trigger the very exclusion this scoping exists to bypass.
 * Diff-set artifact files keep their real relative path so any path-keyed shape
 * heuristic still sees what it would see at the producer.
 *
 * Returns a map from staged relative path -> producer relative path, so a
 * finding can be reported against the path the operator must actually fix.
 */
function stageIngestSurface({ proposalBody, diffSet }) {
  const root = mktmp("stage");
  const map = new Map();
  if (proposalBody !== undefined) {
    const rel = ".claude/ingest/proposal-latest.yaml";
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, proposalBody);
    map.set(rel, ".claude/.proposals/latest.yaml");
  }
  for (const [rel, content] of Object.entries(diffSet ?? {})) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    map.set(rel, rel);
  }
  return { root, map };
}

/** Run the scanner in --check mode. rc is captured directly, never through a pipe. */
function scan(root) {
  try {
    const stdout = execFileSync(process.execPath, [SCANNER, "--check", "--root", root], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { rc: 0, out: stdout };
  } catch (e) {
    // rc 1 = ran, found findings. rc 2 = DID NOT RUN. rc 3 = crashed.
    // These are NOT collapsed: 2 and 3 are surfaced as themselves.
    return { rc: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** Vacuity guard. Returns the scanned-file count, or null when unparseable. */
function scannedCount(out) {
  const m = out.match(/Scanned:\s+(\d+)\s+files?/);
  if (m) return Number(m[1]);
  // The findings path prints per-finding lines rather than a Scanned: trailer;
  // a finding is itself proof >=1 file was read.
  if (/\[SHAPE:/.test(out)) return 1;
  return null;
}

function assertRan(caseName, res) {
  if (res.rc === 2) {
    fail(caseName, `scanner DID NOT RUN (rc=2) — absence of a result, not a clean result:\n${res.out}`);
    return false;
  }
  if (res.rc === 3) {
    fail(caseName, `scanner CRASHED (rc=3) — findings discarded, status UNKNOWN:\n${res.out}`);
    return false;
  }
  if (res.rc !== 0 && res.rc !== 1) {
    fail(caseName, `unexpected exit ${res.rc}:\n${res.out}`);
    return false;
  }
  return true;
}

function assertNonVacuous(caseName, res) {
  const n = scannedCount(res.out);
  if (n === null) {
    fail(caseName, `VACUITY GUARD: could not parse a scanned-file count from:\n${res.out}`);
    return false;
  }
  if (n < 1) {
    fail(
      caseName,
      `VACUITY GUARD: Scanned: ${n} files — the scan examined NOTHING. ` +
        `rc=${res.rc} here is indistinguishable from a clean surface and is NOT evidence.`,
    );
    return false;
  }
  return true;
}

// ───────────────────────────────────────────────────────────────────────────
// RED POLE — a disclosure token in the proposal BODY. The gate MUST REJECT.
// ───────────────────────────────────────────────────────────────────────────
function redPole() {
  const name = "RED/proposal-body-token";
  const { root, map } = stageIngestSurface({
    proposalBody: `source_repo: kailash-coc-claude-py\norigin: use-template\nchanges:\n  - file: .claude/rules/some-rule.md\n    action: modified\n    reason: "seen while working in ${TOKEN}"\nstatus: pending_review\n`,
    diffSet: { ".claude/rules/some-rule.md": "a clean rule body, no tokens\n" },
  });

  const res = scan(root);
  if (!assertRan(name, res)) return null;
  if (!assertNonVacuous(name, res)) return null;

  // FAILURE IDENTITY, not a bare exit code (instrument-bipolarity MUST-2).
  if (res.rc !== 1) {
    fail(name, `expected REJECT (rc=1), got rc=${res.rc}. Output:\n${res.out}`);
    return res;
  }
  if (!/\[SHAPE:operator-home-path\]/.test(res.out)) {
    fail(name, `expected finding identity [SHAPE:operator-home-path]; output:\n${res.out}`);
    return res;
  }
  // The finding must be attributable to the PROPOSAL BODY, mapped back to the
  // path the operator has to fix at the producer.
  if (!/\.claude\/ingest\/proposal-latest\.yaml/.test(res.out)) {
    fail(name, `finding not attributed to the staged proposal body; output:\n${res.out}`);
    return res;
  }
  const producerPath = map.get(".claude/ingest/proposal-latest.yaml");
  if (producerPath !== ".claude/.proposals/latest.yaml") {
    fail(name, `path map does not resolve to the producer path (got ${producerPath})`);
    return res;
  }
  log(`  ok   [${name}] REJECTED with identity [SHAPE:operator-home-path] -> ${producerPath}`);
  return res;
}

// ───────────────────────────────────────────────────────────────────────────
// GREEN POLE — clean ingest surface, producer-hygiene finding OUTSIDE it.
// The gate MUST ACCEPT.
// ───────────────────────────────────────────────────────────────────────────
function greenPole() {
  const name = "GREEN/hygiene-finding-outside-ingest-surface";

  // The ingest surface: clean proposal body + clean diff set.
  const { root } = stageIngestSurface({
    proposalBody: `source_repo: kailash-coc-claude-py\norigin: use-template\nchanges:\n  - file: .claude/rules/some-rule.md\n    action: modified\n    reason: "genericized, no operator paths"\nstatus: pending_review\n`,
    diffSet: { ".claude/rules/some-rule.md": "a clean rule body, no tokens\n" },
  });

  const res = scan(root);
  if (!assertRan(name, res)) return null;
  if (!assertNonVacuous(name, res)) return null;
  if (res.rc !== 0) {
    fail(name, `expected ACCEPT (rc=0) on a clean ingest surface, got rc=${res.rc}:\n${res.out}`);
    return res;
  }

  // DISCRIMINATION CHECK — the green must not be vacuous in the other sense:
  // a producer-hygiene finding DOES exist outside the ingest surface, and the
  // UNSCOPED scan still sees it. Without this the GREEN pole would pass simply
  // because nothing was ever planted anywhere.
  const producer = mktmp("producer");
  for (const [rel, content] of Object.entries({
    ".claude/rules/some-rule.md": "a clean rule body, no tokens\n",
    // NOT in the diff set — pre-existing producer hygiene, outside the ingest surface.
    "scripts/operator-registry.mjs": `export const HOME = "${TOKEN}";\n`,
  })) {
    const abs = path.join(producer, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const unscoped = scan(producer);
  if (!assertRan(`${name}/control`, unscoped)) return res;
  if (unscoped.rc !== 1) {
    fail(
      `${name}/control`,
      `the out-of-surface hygiene finding was NOT detected by the unscoped scan ` +
        `(rc=${unscoped.rc}) — so this GREEN pole proves nothing: it would pass ` +
        `on an empty producer too. Output:\n${unscoped.out}`,
    );
    return res;
  }
  log(`  ok   [${name}] ACCEPTED; unscoped control still flags the out-of-surface finding (rc=1)`);
  return res;
}

// ───────────────────────────────────────────────────────────────────────────
// CONTRAST PIN — what the UNSCOPED `--check --root <producer>` gate does with
// the same two scenarios. This is what makes the pair load-bearing: it shows
// the fix is what moves the poles, rather than the poles having always passed.
//
// BOTH assertions here survive the fix, so this section does not rot:
//   - the `.proposals` exclusion is UNCONDITIONAL and Option-2 staging does not
//     touch it, so the unscoped scan will always be blind to the body; and
//   - the unscoped full-surface scan SURVIVES as the producer-hygiene report,
//     so its flagging behaviour is a live contract, not a legacy artifact.
// ───────────────────────────────────────────────────────────────────────────
function contrastPin() {
  const name = "CONTRAST/unscoped-gate";

  // (i) UNDER-COVERING: token ONLY in the proposal body at its real path.
  const p1 = mktmp("producer-under");
  const rel1 = ".claude/.proposals/latest.yaml";
  fs.mkdirSync(path.dirname(path.join(p1, rel1)), { recursive: true });
  fs.writeFileSync(path.join(p1, rel1), `changes:\n  - reason: "at ${TOKEN}"\n`);
  // A sibling artifact file so the root is a real synced surface, not an empty tree.
  fs.mkdirSync(path.join(p1, ".claude", "rules"), { recursive: true });
  fs.writeFileSync(path.join(p1, ".claude", "rules", "clean.md"), "clean\n");

  const under = scan(p1);
  if (!assertRan(`${name}/under-covering`, under)) return;
  if (under.rc !== 0) {
    fail(
      `${name}/under-covering`,
      `expected the unscoped gate to MISS the proposal body (rc=0) — if this now ` +
        `rejects, the .proposals exclusion changed and this pin must be re-derived. rc=${under.rc}:\n${under.out}`,
    );
  } else {
    log(`  ok   [${name}/under-covering] unscoped gate MISSES the proposal-body token (rc=0) — why staging is required`);
  }

  // (ii) OVER-BLOCKING: clean ingest surface, hygiene finding outside it.
  const p2 = mktmp("producer-over");
  for (const [rel, content] of Object.entries({
    ".claude/rules/some-rule.md": "a clean rule body, no tokens\n",
    "scripts/operator-registry.mjs": `export const HOME = "${TOKEN}";\n`,
  })) {
    const abs = path.join(p2, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const over = scan(p2);
  if (!assertRan(`${name}/over-blocking`, over)) return;
  if (over.rc !== 1) {
    fail(
      `${name}/over-blocking`,
      `expected the unscoped gate to HALT on the out-of-surface finding (rc=1); rc=${over.rc}:\n${over.out}`,
    );
  } else {
    log(`  ok   [${name}/over-blocking] unscoped gate HALTS Gate-1 on a file Gate-1 never ingests (rc=1)`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
log("gate1-ingest-surface: bipolar pole pair");
const red = redPole();
const green = greenPole();
contrastPin();

// instrument-bipolarity MUST-1: the harness MUST assert the verdicts DIFFER.
// Identical verdicts = a VACUOUS pair and MUST fail.
if (red && green) {
  if (red.rc === green.rc) {
    fail(
      "PAIR",
      `VACUOUS PAIR: both poles returned rc=${red.rc}. A pole pair whose verdicts ` +
        `agree measures nothing.`,
    );
  } else {
    log(`  ok   [PAIR] verdicts DIFFER (red rc=${red.rc}, green rc=${green.rc})`);
  }
} else {
  fail("PAIR", "one or both poles did not produce a readable verdict");
}

// The trailing summary MUST NOT match `run-audit-fixtures.mjs::CASE_PASS`
// (/^[ \t]*(?:PASS|ok)[ \t]+\S/), or it is counted as a CASE and inflates the
// tally by one — which would let `min_cases` sit one below the real floor and
// silently tolerate the deletion of a whole case. MEASURED: with a leading
// "PASS 5/5" the regex returned 6 against 5 real cases; this form returns 5.
// Same convention the `activity-view` registry entry records, where the
// runner's summary and an independent CASE_PASS count AGREE.
log(
  failures === 0
    ? `gate1-ingest-surface fixtures: ${5} cases, 5/5 passed`
    : `gate1-ingest-surface fixtures: FAILED ${failures} assertion(s)`,
);
process.exit(failures === 0 ? 0 : 1);
