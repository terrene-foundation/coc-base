#!/usr/bin/env node
/**
 * Audit fixtures for `.claude/bin/check-coverage-ledger.mjs` — the mechanical arm
 * for `/redteam` Convergence Criterion 8 (an `attacked` coverage cell must
 * correspond to a real dispatch in the orchestration launch ledger).
 *
 * BIPOLAR BY CONSTRUCTION (`instrument-bipolarity.md` MUST-1/2, `cc-artifacts.md`
 * Rule 9). Every one of the three properties is exercised at BOTH poles: an input
 * that MUST red on that property, and a conformant input — as close to the
 * violating one as the property allows — that MUST stay green. A one-pole set
 * proves only that a detector can FIRE, never that it can tell the two cases
 * apart, and a detector that reds on everything is as useless as one that reds on
 * nothing.
 *
 * The no-false-positive poles carry real weight here, two in particular:
 *
 *   `same-role-across-phases-is-clean` — one attacker legitimately covering
 *   several phases MUST NOT trip non-reuse. Without this pole, "harden" the arm
 *   into `roles.size >= 1` and every honest round reds.
 *
 *   `absent-ledger-is-UNRUNNABLE-not-PASS` — the pole that pins the contract this
 *   whole change exists to establish. A checker that exits 0 when it found
 *   nothing to check is the non-discriminating instrument being eliminated, so
 *   this fixture asserts exit 3 AND `coverage_asserted: false`.
 *
 * Exit 0 = all fixtures pass; 1 = ≥1 fixture failed.
 */

import "../_lib/no-ambient-git.cjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCANNER = resolve(HERE, "..", "..", "bin", "check-coverage-ledger.mjs");
const REPO_ROOT = resolve(HERE, "..", "..", "..");

const { parseLedger, parseRound, validateCoverage, selfControl, classifyDisposition } =
  await import(SCANNER);

let pass = 0;
let fail = 0;

function report(ok, name, detail) {
  if (ok) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── shared inputs ────────────────────────────────────────────────────────────
// A ledger shaped exactly like the real one: a wave WITH declared spawn times
// and a wave WITHOUT them, because that asymmetry is the true state of the
// evidence and the fixtures must assert it rather than assume it away.

const LEDGER = [
  "## Lanes",
  "",
  "| track | agent | scope | branch | status |",
  "| ----- | ----- | ----- | ------ | ------ |",
  "| tier1-correctness | reviewer | predicate | (read-only) | in-flight |",
  "| tier1-security | security-reviewer | arg-injection | (read-only) | in-flight |",
  "",
  "### WAVE 3",
  "",
  "| track | agent | worktree | branch | spawned_at | status |",
  "| ----- | ----- | -------- | ------ | ---------- | ------ |",
  "| ledger-arm | general-purpose | `.loom-wt/a` | `feat/a` | `2026-08-22T05:44:00Z` | in-flight |",
  "| guard-perf | general-purpose | `.loom-wt/b` | `fix/b` | `2026-08-22T05:52:00Z` | in-flight |",
  "",
  "### WAVE 3 OUTCOMES",
  "",
  "| lane | status | receipt |",
  "| ---- | ------ | ------- |",
  "| ledger-arm | delivered | 3 commits |",
].join("\n");

const LED = parseLedger(LEDGER);

function round(rows, extra = "") {
  return parseRound(
    [extra, "| role | phase | disposition | warrant |", "| - | - | - | - |", ...rows].join("\n"),
  );
}

/** Declared-tier times: wave 3 rows carry spawn times, wave 1 rows do not. */
const T = (roundWrittenAt = "2026-08-22T06:00:00Z") => ({
  roundWrittenAt,
  roundTier: "declared",
  rowTime: (id) => {
    const at = LED.rows.get(id)?.spawned_at || null;
    return { at, tier: at ? "declared" : "none" };
  },
});

const arms = (r) => r.findings.map((f) => f.arm);
const reasons = (r) => r.unrunnable.map((u) => u.reason);

/** VIOLATING pole: the named arm MUST appear. */
function expectArm(name, res, arm) {
  report(arms(res).includes(arm), name, `expected arm "${arm}", got [${arms(res).join(", ") || "none"}]`);
}
/** CONFORMANT pole: the named arm MUST NOT appear (no-false-positive). */
function expectNoArm(name, res, arm) {
  report(!arms(res).includes(arm), name, `arm "${arm}" fired on a conformant input`);
}

// ── 0. the instrument is shown to discriminate BEFORE any verdict is read ────
report(selfControl() === null, "self-control-discriminates", selfControl() ?? "");

report(
  LED.dispatchTables === 2 && LED.rows.size === 4,
  "ledger-parser-reads-dispatch-tables-only",
  `dispatchTables=${LED.dispatchTables} rows=${LED.rows.size} (the OUTCOMES table is keyed by lane but has no agent column and MUST be excluded)`,
);
report(
  LED.rows.get("ledger-arm")?.spawned_at === "2026-08-22T05:44:00Z" &&
    LED.rows.get("tier1-correctness")?.spawned_at === null,
  "ledger-parser-reads-spawned_at-where-present-and-null-where-absent",
  JSON.stringify([...LED.rows].map(([k, v]) => [k, v.spawned_at])),
);

{
  const clean = validateCoverage(
    LED,
    round(["| R1 | P1 | attacked | reviewer returned CLEAN — ledger:ledger-arm |"]),
    T(),
  );
  report(
    clean.findings.length === 0 && clean.unrunnable.length === 0,
    "baseline-conformant-round-is-clean",
    `${JSON.stringify(arms(clean))} / ${JSON.stringify(reasons(clean))}`,
  );
}

// ── 1. PROPERTY ONE — EXISTENCE ─────────────────────────────────────────────
expectArm(
  "cell-citing-nonexistent-row-reds",
  validateCoverage(LED, round(["| R1 | P1 | attacked | x — ledger:no-such-lane |"]), T()),
  "row-not-found",
);
{
  // ...and the finding NAMES the row id, not just "a citation failed".
  const r = validateCoverage(LED, round(["| R3 | P2 | attacked | x — ledger:no-such-lane |"]), T());
  const f = r.findings.find((x) => x.arm === "row-not-found");
  report(
    f && f.row === "no-such-lane" && f.cell === "R3×P2" && /no-such-lane/.test(f.message),
    "row-not-found-names-the-row-id-and-the-cell",
    JSON.stringify(f ?? null),
  );
}
expectArm(
  "attacked-cell-citing-nothing-reds",
  validateCoverage(LED, round(["| R1 | P1 | attacked | reviewer said it looks fine |"]), T()),
  "attacked-cell-cites-nothing",
);
expectNoArm(
  "cell-citing-a-real-row-is-clean",
  validateCoverage(LED, round(["| R1 | P1 | attacked | x — ledger:tier1-security |"]), T()),
  "row-not-found",
);
expectNoArm(
  "n/a-cell-citing-nothing-is-clean",
  validateCoverage(LED, round(["| R1 | P1 | n/a | no auth surface on this artefact |"]), T()),
  "attacked-cell-cites-nothing",
);
expectNoArm(
  "OPEN-cell-citing-nothing-is-clean",
  validateCoverage(LED, round(["| R1 | P1 | OPEN | attacker throttled, to re-run |"]), T()),
  "attacked-cell-cites-nothing",
);
{
  // A duplicate track id makes the citation ambiguous — first-match-wins would
  // be a guess, so it reds rather than resolving.
  const dup = parseLedger(
    [
      "| track | agent | status |",
      "| - | - | - |",
      "| twin | reviewer | in-flight |",
      "",
      "| track | agent | status |",
      "| - | - | - |",
      "| twin | analyst | in-flight |",
    ].join("\n"),
  );
  report(dup.duplicates.has("twin"), "ledger-parser-detects-duplicate-track-ids", [...dup.duplicates].join(","));
  expectArm(
    "cell-citing-an-ambiguous-row-reds",
    validateCoverage(dup, round(["| R1 | P1 | attacked | x — ledger:twin |"]), {
      roundWrittenAt: "2026-08-22T06:00:00Z",
      roundTier: "declared",
      rowTime: () => ({ at: "2026-08-22T01:00:00Z", tier: "declared" }),
    }),
    "ambiguous-row-id",
  );
}

// ── 2. PROPERTY TWO — ORDERING ──────────────────────────────────────────────
// The property that defeats back-filling.
expectArm(
  "row-spawned-AFTER-the-round-file-reds",
  validateCoverage(
    LED,
    round(["| R1 | P1 | attacked | x — ledger:guard-perf |"]),
    T("2026-08-22T05:00:00Z"), // round written 52 min BEFORE guard-perf was dispatched
  ),
  "spawned-after-round",
);
{
  const r = validateCoverage(
    LED,
    round(["| R4 | P6 | attacked | x — ledger:guard-perf |"]),
    T("2026-08-22T05:00:00Z"),
  );
  const f = r.findings.find((x) => x.arm === "spawned-after-round");
  report(
    f &&
      f.property === "ordering" &&
      f.row === "guard-perf" &&
      f.cell === "R4×P6" &&
      /2026-08-22T05:52:00Z/.test(f.message) &&
      /2026-08-22T05:00:00Z/.test(f.message),
    "ordering-finding-names-cell-row-and-BOTH-timestamps",
    JSON.stringify(f ?? null),
  );
}
expectNoArm(
  "row-spawned-BEFORE-the-round-file-is-clean",
  validateCoverage(LED, round(["| R1 | P1 | attacked | x — ledger:guard-perf |"]), T()),
  "spawned-after-round",
);
{
  // Exactly-equal timestamps are NOT a violation: the predicate is spawn > write,
  // and minute-precision declared times make equality ordinary rather than exotic.
  const r = validateCoverage(
    LED,
    round(["| R1 | P1 | attacked | x — ledger:guard-perf |"]),
    T("2026-08-22T05:52:00Z"),
  );
  report(
    !arms(r).includes("spawned-after-round"),
    "spawn-equal-to-write-is-not-a-violation",
    JSON.stringify(arms(r)),
  );
}
{
  // THE UNRUNNABLE POLE, and the honest state of the real ledger: waves 1–2
  // carry no spawn time, so ordering is UNANSWERED — reported, never passed.
  const r = validateCoverage(LED, round(["| R1 | P1 | attacked | x — ledger:tier1-security |"]), T());
  report(
    reasons(r).includes("ordering-unrunnable") && r.findings.length === 0,
    "row-with-no-spawned_at-is-UNRUNNABLE-not-clean-and-not-a-finding",
    `findings=${JSON.stringify(arms(r))} unrunnable=${JSON.stringify(reasons(r))}`,
  );
  report(
    r.unrunnable.some((u) => /UNRECORDED/.test(u.message) && /NOT a pass/.test(u.message)),
    "ordering-unrunnable-says-plainly-it-is-not-a-pass",
    JSON.stringify(r.unrunnable),
  );
}
{
  // An unestablished ROUND time is equally UNRUNNABLE — the asymmetry cuts both ways.
  const r = validateCoverage(LED, round(["| R1 | P1 | attacked | x — ledger:guard-perf |"]), {
    roundWrittenAt: null,
    roundTier: "none",
    rowTime: (id) => ({ at: LED.rows.get(id)?.spawned_at || null, tier: "declared" }),
  });
  report(
    reasons(r).includes("ordering-unrunnable") && r.findings.length === 0,
    "unestablished-round-write-time-is-UNRUNNABLE-not-clean",
    `findings=${JSON.stringify(arms(r))} unrunnable=${JSON.stringify(reasons(r))}`,
  );
}
{
  // The evidence TIER is reported, never conflated: a git-derived comparison
  // answers a weaker proposition than a declared one and must say so.
  const r = validateCoverage(LED, round(["| R1 | P1 | attacked | x — ledger:guard-perf |"]), {
    roundWrittenAt: "2026-08-22T05:00:00Z",
    roundTier: "git",
    rowTime: () => ({ at: "2026-08-22T05:52:00Z", tier: "git" }),
  });
  const f = r.findings.find((x) => x.arm === "spawned-after-round");
  report(
    f && f.evidence_tier === "git/git" && /evidence tier: row=git, round=git/.test(f.message),
    "ordering-finding-reports-its-evidence-tier",
    JSON.stringify(f ?? null),
  );
}

// ── 3. PROPERTY THREE — NON-REUSE ───────────────────────────────────────────
expectArm(
  "one-row-cited-by-two-DIFFERENT-roles-reds",
  validateCoverage(
    LED,
    round([
      "| R1 | P1 | attacked | x — ledger:ledger-arm |",
      "| R5 | P3 | attacked | x — ledger:ledger-arm |",
    ]),
    T(),
  ),
  "row-reused-across-roles",
);
{
  const r = validateCoverage(
    LED,
    round([
      "| R1 | P1 | attacked | x — ledger:ledger-arm |",
      "| R5 | P3 | attacked | x — ledger:ledger-arm |",
    ]),
    T(),
  );
  const f = r.findings.find((x) => x.arm === "row-reused-across-roles");
  report(
    f &&
      f.row === "ledger-arm" &&
      f.cells.length === 2 &&
      f.cells.some((c) => c.startsWith("R1×P1")) &&
      f.cells.some((c) => c.startsWith("R5×P3")) &&
      f.roles.length === 2,
    "non-reuse-finding-names-BOTH-cells-and-both-roles",
    JSON.stringify(f ?? null),
  );
}
expectArm(
  "three-roles-citing-one-row-reds",
  validateCoverage(
    LED,
    round([
      "| R1 | P1 | attacked | x — ledger:ledger-arm |",
      "| R2 | P1 | attacked | x — ledger:ledger-arm |",
      "| R7 | P4 | attacked | x — ledger:ledger-arm |",
    ]),
    T(),
  ),
  "row-reused-across-roles",
);
expectNoArm(
  "same-role-across-phases-is-clean",
  validateCoverage(
    LED,
    round([
      "| R1 | P1 | attacked | x — ledger:ledger-arm |",
      "| R1 | P2 | attacked | x — ledger:ledger-arm |",
      "| R1 | P3 | attacked | x — ledger:ledger-arm |",
    ]),
    T(),
  ),
  "row-reused-across-roles",
);
expectNoArm(
  "same-role-cased-differently-is-still-one-role",
  validateCoverage(
    LED,
    round([
      "| R1 | P1 | attacked | x — ledger:ledger-arm |",
      "| r1 | P2 | attacked | x — ledger:ledger-arm |",
    ]),
    T(),
  ),
  "row-reused-across-roles",
);
expectNoArm(
  "two-roles-citing-two-DISTINCT-rows-is-clean",
  validateCoverage(
    LED,
    round([
      "| R1 | P1 | attacked | x — ledger:ledger-arm |",
      "| R5 | P3 | attacked | x — ledger:guard-perf |",
    ]),
    T(),
  ),
  "row-reused-across-roles",
);
{
  // An n/a cell citing a row must not consume it: only `attacked` closures claim
  // a dispatch, so an n/a row alongside an attacked one is not reuse.
  const r = validateCoverage(
    LED,
    round([
      "| R1 | P1 | attacked | x — ledger:ledger-arm |",
      "| R5 | P3 | n/a | no surface — see ledger:ledger-arm for context |",
    ]),
    T(),
  );
  report(
    !arms(r).includes("row-reused-across-roles"),
    "n/a-cell-mentioning-a-row-does-not-consume-it",
    JSON.stringify(arms(r)),
  );
}

// ── 4. fail-closed parsing ──────────────────────────────────────────────────
{
  // A `ledger:` token the parser cannot resolve to an id is UNRUNNABLE, never
  // silently dropped — a dropped citation is the silent no-op being eliminated.
  const r = validateCoverage(LED, round(["| R1 | P1 | attacked | attacked per ledger: |"]), T());
  report(
    reasons(r).includes("unparseable-citation"),
    "bare-ledger-colon-token-is-UNRUNNABLE-not-silently-skipped",
    JSON.stringify(reasons(r)),
  );
}
{
  const r = validateCoverage(LED, round(["| R1 | P1 | probably fine | x — ledger:ledger-arm |"]), T());
  report(
    reasons(r).includes("unrecognised-disposition"),
    "unrecognised-disposition-fails-CLOSED",
    JSON.stringify(reasons(r)),
  );
}
report(
  classifyDisposition("`attacked`") === "attacked" &&
    classifyDisposition("**n/a**") === "n/a" &&
    classifyDisposition("OPEN") === "open" &&
    classifyDisposition("re-opened") === "open" &&
    classifyDisposition("") === "empty" &&
    classifyDisposition("mostly done") === "unknown",
  "disposition-classifier-handles-markdown-emphasis-and-unknowns",
);
{
  const r = validateCoverage(LED, parseRound("no tables here at all"), T());
  report(
    reasons(r).includes("no-coverage-table"),
    "round-file-with-no-coverage-table-is-UNRUNNABLE",
    JSON.stringify(reasons(r)),
  );
}
{
  const r = validateCoverage(parseLedger("| a | b |\n| - | - |\n| 1 | 2 |"), round(["| R1 | P1 | attacked | x — ledger:z |"]), T());
  report(
    reasons(r).includes("no-dispatch-table"),
    "ledger-with-no-dispatch-table-is-UNRUNNABLE",
    JSON.stringify(reasons(r)),
  );
}
{
  // A round with zero attacked cells is vacuously clean, and SAYS SO rather than
  // reporting a bare pass the reader would over-read.
  const r = validateCoverage(LED, round(["| R1 | P1 | n/a | no surface |"]), T());
  report(
    r.findings.length === 0 && r.notes.some((n) => /vacuously/.test(n)),
    "zero-attacked-cells-is-clean-and-says-it-is-vacuous",
    JSON.stringify(r.notes),
  );
}
{
  // FAIL dominates UNRUNNABLE: a named violation is a finding regardless of what
  // else could not be measured.
  const r = validateCoverage(
    LED,
    round([
      "| R1 | P1 | attacked | x — ledger:no-such-lane |",
      "| R2 | P1 | attacked | x — ledger:tier1-security |",
    ]),
    T(),
  );
  report(
    arms(r).includes("row-not-found") && reasons(r).includes("ordering-unrunnable"),
    "a-finding-and-an-unanswered-property-coexist-without-either-masking-the-other",
    `${JSON.stringify(arms(r))} / ${JSON.stringify(reasons(r))}`,
  );
}

// ── 5. CLI exit-code semantics (end-to-end, subprocess) ─────────────────────
const tmp = mkdtempSync(join(tmpdir(), "coverage-ledger-"));
try {
  const run = (args) => spawnSync(process.execPath, [SCANNER, ...args], { encoding: "utf8" });
  const w = (name, text) => {
    const p = join(tmp, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
    return p;
  };

  const ledgerPath = w("ledger.md", LEDGER);
  const head = ["round_started_at: 2026-08-22T06:00:00Z", "", "| role | phase | disposition | warrant |", "| - | - | - | - |"];

  const cleanRound = w(
    "round-clean.md",
    [...head, "| R1 | P1 | attacked | reviewer CLEAN — ledger:ledger-arm |"].join("\n"),
  );
  const clean = run(["--round", cleanRound, "--ledger", ledgerPath, "--json", "--no-git"]);
  report(clean.status === 0, "conformant-round-exits-0-PASS", `status ${clean.status}: ${clean.stdout.slice(0, 200)}`);
  {
    const j = JSON.parse(clean.stdout);
    report(j.coverage_asserted === true && j.status === "PASS", "PASS-asserts-coverage", clean.stdout.slice(0, 160));
    report(
      j.round_time_tier === "declared" && j.round_written_at === "2026-08-22T06:00:00Z",
      "round_started_at-is-read-as-the-Tier-1-declared-round-time",
      clean.stdout.slice(0, 200),
    );
  }

  const badRound = w(
    "round-ghost.md",
    [...head, "| R1 | P1 | attacked | x — ledger:no-such-lane |"].join("\n"),
  );
  const bad = run(["--round", badRound, "--ledger", ledgerPath, "--json", "--no-git"]);
  report(bad.status === 1, "violating-round-exits-1-FAIL", `status ${bad.status}`);
  {
    const j = JSON.parse(bad.stdout);
    report(
      j.status === "FAIL" &&
        j.coverage_asserted === false &&
        j.findings.length === 1 &&
        j.findings[0].row === "no-such-lane" &&
        j.findings[0].cell === "R1×P1",
      "FAIL-names-the-failure-identity-cell-row-and-property",
      bad.stdout.slice(0, 300),
    );
  }

  // THE CONTRACT POLE. An absent ledger is UNRUNNABLE, never PASS.
  const noLedger = run([
    "--round", cleanRound, "--ledger", join(tmp, "does-not-exist.md"), "--json", "--no-git",
  ]);
  report(noLedger.status === 3, "absent-ledger-is-UNRUNNABLE-not-PASS", `status ${noLedger.status}`);
  {
    const j = JSON.parse(noLedger.stdout);
    report(
      j.status === "UNRUNNABLE" && j.coverage_asserted === false,
      "UNRUNNABLE-asserts-no-coverage",
      noLedger.stdout.slice(0, 200),
    );
  }
  const noRound = run([
    "--round", join(tmp, "nope.md"), "--ledger", ledgerPath, "--json", "--no-git",
  ]);
  report(noRound.status === 3, "absent-round-file-is-UNRUNNABLE-not-PASS", `status ${noRound.status}`);

  // ...and exit 3 is DISTINCT from 0 and from 1. If these three ever collapse,
  // absence becomes readable as a pass and the checker is self-refuting.
  report(
    new Set([clean.status, bad.status, noLedger.status]).size === 3,
    "PASS-FAIL-UNRUNNABLE-are-three-DISTINCT-exit-codes",
    `${clean.status} / ${bad.status} / ${noLedger.status}`,
  );

  const unordered = w(
    "round-unordered.md",
    [...head, "| R1 | P1 | attacked | x — ledger:tier1-security |"].join("\n"),
  );
  const un = run(["--round", unordered, "--ledger", ledgerPath, "--json", "--no-git"]);
  report(un.status === 3, "citation-with-no-establishable-order-exits-3-not-0", `status ${un.status}`);
  {
    const j = JSON.parse(un.stdout);
    report(
      j.coverage_asserted === false && j.unrunnable.some((u) => u.reason === "ordering-unrunnable"),
      "unestablished-ordering-does-not-assert-coverage",
      un.stdout.slice(0, 240),
    );
  }

  const late = w(
    "round-late.md",
    [
      "round_started_at: 2026-08-22T05:00:00Z",
      "",
      "| role | phase | disposition | warrant |",
      "| - | - | - | - |",
      "| R1 | P1 | attacked | x — ledger:guard-perf |",
    ].join("\n"),
  );
  const l = run(["--round", late, "--ledger", ledgerPath, "--json", "--no-git"]);
  report(l.status === 1, "back-filled-citation-exits-1-FAIL", `status ${l.status}`);
  report(
    JSON.parse(l.stdout).findings.some((f) => f.arm === "spawned-after-round"),
    "back-filled-citation-names-the-ordering-property",
    l.stdout.slice(0, 240),
  );

  const usage = run(["--nonsense"]);
  report(usage.status === 2, "unknown-flag-exits-2", `status ${usage.status}`);
  const noArgs = run(["--json"]);
  report(noArgs.status === 2, "missing-required-args-exits-2", `status ${noArgs.status}`);

  // Human-readable output must carry the verdict too — a JSON-only report is
  // unreadable at the gate where this is actually consulted.
  const human = run(["--round", badRound, "--ledger", ledgerPath, "--no-git"]);
  report(
    /FAIL/.test(human.stdout) && /no-such-lane/.test(human.stdout),
    "human-readable-output-carries-verdict-and-failure-identity",
    human.stdout.slice(0, 200),
  );

  // ── DISTRIBUTION FATE, verified by EXECUTION not by reading the comment ────
  // `knowledge-cascade-routing.md` MUST-2. `.claude/bin/**` is fail-closed since
  // loom#1051/F1030d: the consumer-runtime surface is the explicit
  // ALWAYS_INCLUDE allowlist, and this tool is deliberately NOT on it.
  {
    const tier = resolve(REPO_ROOT, ".claude", "bin", "sync-tier-aware.mjs");
    const src = spawnSync("node", ["-e", `process.stdout.write(require("fs").readFileSync(${JSON.stringify(tier)},"utf8"))`], {
      encoding: "utf8",
    });
    const listed = /check-coverage-ledger\.mjs/.test(src.stdout || "");
    const control = /check-wave-corpus-ledger\.mjs/.test(src.stdout || "");
    report(
      src.stdout && src.stdout.length > 1000 && !listed && !control,
      "distribution-fate-is-loom-only",
      `read ${(src.stdout || "").length}B; this tool listed=${listed}; sibling check-wave-corpus-ledger listed=${control} (both must be false — the sibling is the control proving the grep can see this file's contents at all)`,
    );
  }
  // ── 6. THE JOIN — a round file citing a REAL ledger, through the shipped CLI ─
  //
  // Everything above tests each half. NOTHING above tests the JOIN: a round file
  // that actually writes `ledger:<track>` into its coverage table, run against a
  // real ledger, through the shipped checker. Without this the first `/redteam`
  // round to use the contract IS the integration test, and it discovers the
  // mismatch at round 2 instead of here.
  //
  // The ledger side is REAL, deliberately. `real-ledger.snapshot.md` is a
  // VERBATIM copy of `workspaces/runtime-enforcement-2026-08-14/s54-launch-ledger.md`
  // at `9650c968` — authored by the ORCHESTRATOR for its own purpose, not by this
  // lane for this parser. A join fixture built from a synthetic ledger this lane
  // wrote would agree with this lane's parser BY CONSTRUCTION, which is the
  // self-derived-oracle shape `evidence-first-claims.md` MUST-5 names.
  //
  // It is also the one input that exercises BOTH ordering paths in a single
  // file: wave 3 carries declared `spawned_at`, waves 1–2 are UNRECORDED.
  {
    const realLedger = resolve(HERE, "real-ledger.snapshot.md");
    const rl = parseLedger(readFileSync(realLedger, "utf8"));

    // The snapshot is the artifact we think it is — checked, not assumed.
    report(
      rl.dispatchTables === 3 && rl.rows.size === 13 && rl.duplicates.size === 0,
      "join-real-ledger-parses-3-dispatch-tables-13-rows-0-duplicates",
      `dispatchTables=${rl.dispatchTables} rows=${rl.rows.size} duplicates=[${[...rl.duplicates]}]`,
    );
    report(
      rl.rows.get("guard-perf")?.spawned_at === "2026-08-22T05:52:00Z" &&
        rl.rows.get("migration")?.spawned_at === null,
      "join-real-ledger-carries-BOTH-a-timed-wave-and-an-UNRECORDED-wave",
      JSON.stringify([...rl.rows].map(([k, v]) => [k, v.spawned_at])),
    );

    const realLedgerPath = realLedger;
    const cov = (rows, started = "2026-08-22T07:00:00Z") =>
      [
        `round_started_at: ${started}`,
        "",
        "| role | phase | disposition | warrant |",
        "| - | - | - | - |",
        ...rows,
      ].join("\n");

    // POLE A — citations naming REAL tracks, ordered, unreused → PASS.
    const joinClean = w(
      "join-clean.md",
      cov([
        "| R1 | P1 | attacked | general-purpose returned CLEAN — ledger:ledger-arm |",
        "| R2 | P3 | attacked | general-purpose found the porcelain regression — ledger:guard-perf |",
        "| R3 | P2 | attacked | cc-architect returned the removed-clause table — ledger:1904-fix-round |",
        "| R4 | P4 | n/a | no deployment surface on this artefact |",
      ]),
    );
    const jc = run(["--round", joinClean, "--ledger", realLedgerPath, "--json", "--no-git"]);
    report(jc.status === 0, "JOIN-real-tracks-cited-correctly-exits-0-PASS", `status ${jc.status}: ${jc.stdout.slice(0, 300)}`);
    {
      const j = JSON.parse(jc.stdout);
      report(
        j.coverage_asserted === true && j.attacked_cells === 3 && j.checked.ordering === 3,
        "JOIN-PASS-checked-all-three-orderings-via-declared-wave-3-spawn-times",
        jc.stdout.slice(0, 400),
      );
      report(
        j.role_correspondence.length === 3 &&
          j.role_correspondence.every((r) => r.verified === false) &&
          j.role_correspondence.some((r) => r.cell_role === "R3" && r.row_agent === "cc-architect"),
        "JOIN-reports-role-to-dispatch-pairs-marked-NOT-verified",
        JSON.stringify(j.role_correspondence),
      );
      report(
        /NOT VERIFIED/.test(j.role_correspondence_note) && /A PASS is NOT evidence/.test(j.role_correspondence_note),
        "JOIN-PASS-states-the-role-correspondence-non-guarantee",
        j.role_correspondence_note,
      );
    }

    // POLE B — a citation naming a track that does not exist → FAIL, named.
    const joinGhost = w(
      "join-ghost.md",
      cov([
        "| R1 | P1 | attacked | CLEAN — ledger:ledger-arm |",
        "| R2 | P3 | attacked | CLEAN — ledger:phantom-lane |",
      ]),
    );
    const jg = run(["--round", joinGhost, "--ledger", realLedgerPath, "--json", "--no-git"]);
    report(jg.status === 1, "JOIN-nonexistent-track-exits-1-FAIL", `status ${jg.status}`);
    {
      const f = JSON.parse(jg.stdout).findings.find((x) => x.arm === "row-not-found");
      report(
        f && f.row === "phantom-lane" && f.cell === "R2×P3" && /phantom-lane/.test(f.message),
        "JOIN-FAIL-names-the-token-and-the-cell",
        jg.stdout.slice(0, 400),
      );
    }

    // POLE C — the UNRECORDED-wave path: existence and non-reuse still CHECKED,
    // ordering honestly UNRUNNABLE. This is the real ledger's true asymmetry.
    const joinUnrecorded = w(
      "join-unrecorded.md",
      cov([
        "| R1 | P1 | attacked | reviewer CLEAN — ledger:tier1-correctness |",
        "| R2 | P1 | attacked | security-reviewer CLEAN — ledger:tier1-security |",
      ]),
    );
    const ju = run(["--round", joinUnrecorded, "--ledger", realLedgerPath, "--json", "--no-git"]);
    report(ju.status === 3, "JOIN-wave-without-spawned_at-exits-3-UNRUNNABLE-not-0", `status ${ju.status}`);
    {
      const j = JSON.parse(ju.stdout);
      report(
        j.coverage_asserted === false &&
          j.findings.length === 0 &&
          j.checked.existence === 2 &&
          j.checked.non_reuse === 2 &&
          j.checked.ordering === 0 &&
          j.unrunnable.every((u) => u.reason === "ordering-unrunnable"),
        "JOIN-UNRECORDED-existence-and-non-reuse-CHECKED-while-ordering-alone-is-UNANSWERED",
        ju.stdout.slice(0, 600),
      );
    }

    // POLE D — non-reuse across the join: one real track, two real roles.
    const joinReuse = w(
      "join-reuse.md",
      cov([
        "| R1 | P1 | attacked | CLEAN — ledger:guard-perf |",
        "| R6 | P5 | attacked | CLEAN — ledger:guard-perf |",
      ]),
    );
    const jr = run(["--round", joinReuse, "--ledger", realLedgerPath, "--json", "--no-git"]);
    report(jr.status === 1, "JOIN-one-real-track-two-roles-exits-1-FAIL", `status ${jr.status}`);
    report(
      JSON.parse(jr.stdout).findings.some(
        (f) => f.arm === "row-reused-across-roles" && f.row === "guard-perf" && f.cells.length === 2,
      ),
      "JOIN-non-reuse-FAIL-names-the-real-track-and-both-cells",
      jr.stdout.slice(0, 400),
    );

    // POLE E — the status arm across the join. A citation to a `stopped`
    // dispatch is not evidence of an attack, aligned with the sibling lane's
    // reading of a stopped track as OPEN.
    const stoppedLedger = w(
      "ledger-stopped.md",
      [
        "| track | agent | branch | spawned_at | status |",
        "| - | - | - | - | - |",
        "| stood-down | reviewer | feat/x | `2026-08-22T01:00:00Z` | stopped |",
        "| delivered | reviewer | feat/y | `2026-08-22T01:00:00Z` | landed |",
      ].join("\n"),
    );
    const jsStopped = run([
      "--round", w("join-stopped.md", cov(["| R1 | P1 | attacked | CLEAN — ledger:stood-down |"])),
      "--ledger", stoppedLedger, "--json", "--no-git",
    ]);
    report(jsStopped.status === 1, "JOIN-citation-to-a-STOPPED-dispatch-exits-1-FAIL", `status ${jsStopped.status}`);
    report(
      JSON.parse(jsStopped.stdout).findings.some((f) => f.arm === "cited-dispatch-was-stopped"),
      "JOIN-stopped-dispatch-names-the-status-arm",
      jsStopped.stdout.slice(0, 300),
    );
    const jsLanded = run([
      "--round", w("join-landed.md", cov(["| R1 | P1 | attacked | CLEAN — ledger:delivered |"])),
      "--ledger", stoppedLedger, "--json", "--no-git",
    ]);
    report(jsLanded.status === 0, "JOIN-citation-to-a-LANDED-dispatch-stays-clean", `status ${jsLanded.status}: ${jsLanded.stdout.slice(0, 200)}`);
    {
      // in-flight is REPORTED, never ruled — a stale row and an undelivered one
      // are indistinguishable, so an opinion here would be a guess.
      const inflight = run([
        "--round", w("join-inflight.md", cov(["| R1 | P1 | attacked | CLEAN — ledger:guard-perf |"])),
        "--ledger", realLedgerPath, "--json", "--no-git",
      ]);
      const j = JSON.parse(inflight.stdout);
      report(
        inflight.status === 0 && j.notes.some((n) => /in-flight/.test(n) && /REPORTED, not ruled/.test(n)),
        "JOIN-in-flight-dispatch-is-REPORTED-not-ruled",
        inflight.stdout.slice(0, 400),
      );
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} fixtures pass`);
process.exit(fail === 0 ? 0 : 1);
