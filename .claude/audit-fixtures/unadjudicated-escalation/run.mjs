#!/usr/bin/env node
/**
 * unadjudicated-escalation — fixtures for `sweep-completeness.md` MUST-4 and its
 * detector `.claude/bin/unadjudicated-escalation.mjs`.
 *
 * BIPOLAR BY CONSTRUCTION, and that is the point. A detector shown only to FIRE
 * proves it can say "escalate"; it does not prove it can say anything else. Half
 * the cases below are runs that MUST NOT escalate — streaks of 1 and 2, a streak
 * broken by an intervening clean run, a live disposition, prose that discusses
 * the verdict instead of emitting it, a quoted example inside a code fence, a
 * non-sweep report in the same directory. If the detector reds those, it is a
 * rubber stamp pointed the other way and is just as useless.
 *
 * HOW EACH CASE DISCRIMINATES. Every case builds a REAL temporary repository on
 * disk — real `workspaces/<ws>/04-validate/sweep-<date>.md` files with real
 * report text — and invokes the REAL binary as a subprocess, reading its EXIT
 * CODE and its `--json`. Nothing is mocked and no internal is reached around,
 * so a case cannot pass against an implementation the command line would not.
 *
 * THE LEVER IS THE REPORT SEQUENCE, not a flag: same binary, same arguments,
 * different committed history. That is what makes the pair meaningful — the two
 * poles differ ONLY in the thing MUST-4 is about (how many consecutive runs
 * carried the identical verdict, and whether anything adjudicated it).
 *
 * DATES ARE PINNED, NEVER `new Date()`. A fixture whose verdict depends on the
 * wall clock is a fixture that reds on a Tuesday; `--today` is passed explicitly
 * in every case so disposition expiry is a property of the CASE.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const TOOL =
  process.env.UNADJUDICATED_TOOL ||
  path.join(REPO_ROOT, ".claude", "bin", "unadjudicated-escalation.mjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "unadj-fixtures-"));

let pass = 0;
const failures = [];

function check(name, expectation, actualFn) {
  let ok;
  try {
    ok = actualFn();
  } catch (e) {
    ok = `threw: ${e && e.message}`;
  }
  if (ok === true) {
    pass++;
    // `PASS <name>` at column 0 is the shape run-audit-fixtures.mjs::CASE_PASS
    // counts. An indented or symbol-prefixed line is invisible to it.
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name}`);
    console.log(`     expected: ${expectation}`);
    console.log(`     actual:   ${ok}`);
  }
}

// ── fixture-repo construction ───────────────────────────────────────────────

let seq = 0;
function newRepo() {
  const root = path.join(TMP, `repo-${++seq}`);
  fs.mkdirSync(path.join(root, "workspaces", "ws", "04-validate"), { recursive: true });
  return root;
}

/** The real emission shape this corpus uses, lifted from a committed report. */
const VERDICT_ROW =
  "- **[MED][Sweep 5] `manual-supplement-required`** — `spec_count=0` AND `specs/` EXISTS.";
const CLEAN_ROW = "- **[Sweep 5]** ran clean against the repo-level tree. No findings.";

function writeReport(root, basename, body, { dir = "workspaces/ws/04-validate" } = {}) {
  const abs = path.join(root, dir, basename);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `# Sweep report\n\n## Findings\n\n${body}\n`, "utf8");
  return abs;
}

/** N consecutive runs each carrying the verdict, dated 2026-08-01 upward. */
function withStreak(n, extraNewest = "") {
  const root = newRepo();
  for (let i = 0; i < n; i++) {
    const day = String(1 + i).padStart(2, "0");
    const body = i === n - 1 ? `${VERDICT_ROW}\n${extraNewest}` : VERDICT_ROW;
    writeReport(root, `sweep-2026-08-${day}.md`, body);
  }
  return root;
}

function run(root, args = []) {
  const r = spawnSync(process.execPath, [TOOL, "--root", root, "--json", ...args], {
    encoding: "utf8",
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

const TODAY = ["--today", "2026-08-16"];

// ── POLE A — runs that MUST NOT escalate ────────────────────────────────────

check(
  "streak-1/does-not-escalate",
  "one run carrying the verdict is the honest first emission MUST-2 mandates; exit 0",
  () => {
    const r = run(withStreak(1), TODAY);
    return (r.code === 0 && r.json.escalations_owed === 0) || `code=${r.code} owed=${r.json?.escalations_owed}`;
  },
);

check(
  "streak-2/does-not-escalate",
  "two runs can be a fix genuinely in flight; exit 0 with the streak recorded as 2",
  () => {
    const r = run(withStreak(2), TODAY);
    const s = r.json?.streaks?.find((x) => x.key === "manual-supplement-required");
    return (r.code === 0 && s?.streak === 2) || `code=${r.code} streak=${s?.streak}`;
  },
);

check(
  "streak-broken-by-newest-clean-run/does-not-escalate",
  "3 verdict runs followed by a clean newest run: the streak counts BACK from the newest, so it is 0",
  () => {
    const root = withStreak(3);
    writeReport(root, "sweep-2026-08-09.md", CLEAN_ROW);
    const r = run(root, TODAY);
    const s = r.json?.streaks?.find((x) => x.key === "manual-supplement-required");
    return (r.code === 0 && s?.streak === 0) || `code=${r.code} streak=${s?.streak}`;
  },
);

check(
  "streak-broken-mid-sequence/does-not-escalate",
  "V,V,clean,V,V — the clean run resets the consecutive count, leaving a live streak of 2",
  () => {
    const root = newRepo();
    writeReport(root, "sweep-2026-08-01.md", VERDICT_ROW);
    writeReport(root, "sweep-2026-08-02.md", VERDICT_ROW);
    writeReport(root, "sweep-2026-08-03.md", CLEAN_ROW);
    writeReport(root, "sweep-2026-08-04.md", VERDICT_ROW);
    writeReport(root, "sweep-2026-08-05.md", VERDICT_ROW);
    const r = run(root, TODAY);
    const s = r.json?.streaks?.find((x) => x.key === "manual-supplement-required");
    return (r.code === 0 && s?.streak === 2) || `code=${r.code} streak=${s?.streak}`;
  },
);

check(
  "live-disposition/suppresses-without-resetting",
  "a complete, unexpired disposition suppresses escalation while the streak keeps climbing",
  () => {
    const root = withStreak(4);
    fs.appendFileSync(
      path.join(root, "workspaces/ws/04-validate/sweep-2026-08-04.md"),
      '\n<!-- unadjudicated-disposition:v1 key="Sweep 5/manual-supplement-required" issue=1722 owner=someone until=2026-09-30 -->\n',
    );
    const r = run(root, TODAY);
    const f = r.json?.findings?.[0];
    return (
      (r.code === 0 && f?.escalation_owed === false && f?.streak === 4) ||
      `code=${r.code} owed=${f?.escalation_owed} streak=${f?.streak}`
    );
  },
);

check(
  "prose-about-a-verdict/is-not-an-emission",
  "'Sweep 5 ran clean; nothing was left unadjudicated' names the token but emits nothing; 0 hits",
  () => {
    const root = newRepo();
    for (const d of ["01", "02", "03"]) {
      writeReport(
        root,
        `sweep-2026-08-${d}.md`,
        "Sweep 5 ran clean against the repo-level tree; nothing was left unadjudicated.",
      );
    }
    const r = run(root, TODAY);
    return (r.code === 0 && r.json.hits.length === 0) || `code=${r.code} hits=${r.json?.hits?.length}`;
  },
);

check(
  "fenced-example-row/is-not-an-emission",
  "a verdict row QUOTED inside a code fence is skipped and counted as fenced, never as a run's emission",
  () => {
    const root = newRepo();
    for (const d of ["01", "02", "03"]) {
      writeReport(root, `sweep-2026-08-${d}.md`, "```markdown\n" + VERDICT_ROW + "\n```");
    }
    const r = run(root, TODAY);
    return (
      (r.code === 0 && r.json.hits.length === 0 && r.json.fenced_hits_skipped === 3) ||
      `code=${r.code} hits=${r.json?.hits?.length} fenced=${r.json?.fenced_hits_skipped}`
    );
  },
);

check(
  "non-sweep-report-in-04-validate/is-not-a-run",
  "a redteam-*.md sitting beside the sweep reports is not a /sweep run and contributes no streak",
  () => {
    const root = newRepo();
    for (const d of ["01", "02", "03"]) writeReport(root, `redteam-2026-08-${d}.md`, VERDICT_ROW);
    const r = run(root, TODAY);
    return (r.code === 0 && r.json.runs_scanned === 0) || `code=${r.code} runs=${r.json?.runs_scanned}`;
  },
);

check(
  "zero-reports/is-reported-as-zero-not-as-clean",
  "an empty root exits 0 but records runs_scanned=0 and says so in the human report",
  () => {
    const root = newRepo();
    const r = run(root, TODAY);
    const human = spawnSync(process.execPath, [TOOL, "--root", root, ...TODAY], { encoding: "utf8" });
    return (
      (r.code === 0 && r.json.runs_scanned === 0 && /NOT a clean bill/.test(human.stdout)) ||
      `code=${r.code} runs=${r.json?.runs_scanned} noted=${/NOT a clean bill/.test(human.stdout)}`
    );
  },
);

// ── POLE B — runs that MUST escalate ────────────────────────────────────────

check(
  "streak-3/escalates",
  "the threshold case: 3 consecutive identical verdicts, no disposition; exit 1 with one escalation owed",
  () => {
    const r = run(withStreak(3), TODAY);
    const f = r.json?.findings?.[0];
    return (
      (r.code === 1 &&
        r.json.escalations_owed === 1 &&
        f?.key === "manual-supplement-required" &&
        f?.escalation_owed === true) ||
      `code=${r.code} owed=${r.json?.escalations_owed} f=${JSON.stringify(f)}`
    );
  },
);

check(
  "streak-5/escalates",
  "the loom#1722 shape — five consecutive identical verdicts still escalates; exit 1",
  () => {
    const r = run(withStreak(5), TODAY);
    const f = r.json?.findings?.[0];
    return (r.code === 1 && f?.streak === 5) || `code=${r.code} streak=${f?.streak}`;
  },
);

check(
  "expired-disposition/escalation-returns",
  "a disposition whose `until` has passed no longer suppresses; the count never reset, so exit 1",
  () => {
    const root = withStreak(3);
    fs.appendFileSync(
      path.join(root, "workspaces/ws/04-validate/sweep-2026-08-03.md"),
      '\n<!-- unadjudicated-disposition:v1 key="Sweep 5/manual-supplement-required" issue=1722 owner=someone until=2026-08-10 -->\n',
    );
    const r = run(root, TODAY);
    const f = r.json?.findings?.[0];
    return (
      (r.code === 1 && f?.escalation_owed === true && f?.expired_dispositions?.length === 1) ||
      `code=${r.code} owed=${f?.escalation_owed} expired=${f?.expired_dispositions?.length}`
    );
  },
);

check(
  "disposition-missing-issue/is-malformed-not-honoured",
  "an incomplete sentinel is reported as MALFORMED and does not suppress; exit 1",
  () => {
    const root = withStreak(3);
    fs.appendFileSync(
      path.join(root, "workspaces/ws/04-validate/sweep-2026-08-03.md"),
      '\n<!-- unadjudicated-disposition:v1 key="Sweep 5/manual-supplement-required" owner=someone until=2026-09-30 -->\n',
    );
    const r = run(root, TODAY);
    return (
      (r.code === 1 &&
        r.json.malformed_dispositions.length === 1 &&
        r.json.malformed_dispositions[0].missing.includes("issue")) ||
      `code=${r.code} malformed=${JSON.stringify(r.json?.malformed_dispositions)}`
    );
  },
);

check(
  "disposition-missing-until/is-malformed-not-honoured",
  "a sentinel with no expiry is not a dated disposition; MALFORMED, exit 1",
  () => {
    const root = withStreak(3);
    fs.appendFileSync(
      path.join(root, "workspaces/ws/04-validate/sweep-2026-08-03.md"),
      '\n<!-- unadjudicated-disposition:v1 key="Sweep 5/manual-supplement-required" issue=1722 owner=someone -->\n',
    );
    const r = run(root, TODAY);
    return (
      (r.code === 1 && r.json.malformed_dispositions.length === 1) ||
      `code=${r.code} malformed=${JSON.stringify(r.json?.malformed_dispositions)}`
    );
  },
);

check(
  "disposition-for-a-different-key/does-not-suppress",
  "a live disposition naming `cannot-adjudicate` cannot adjudicate `manual-supplement-required`; exit 1",
  () => {
    const root = withStreak(3);
    fs.appendFileSync(
      path.join(root, "workspaces/ws/04-validate/sweep-2026-08-03.md"),
      '\n<!-- unadjudicated-disposition:v1 key="cannot-adjudicate" issue=1722 owner=someone until=2026-09-30 -->\n',
    );
    const r = run(root, TODAY);
    return (r.code === 1 && r.json.escalations_owed === 1) || `code=${r.code} owed=${r.json?.escalations_owed}`;
  },
);

// The DIFFERENT-key axis is now the VERDICT, not the step label. This case used
// to name `Sweep 8/manual-supplement-required` — the same verdict under another
// step — which a verdict-keyed disposition legitimately DOES cover, so keeping
// that shape would have asserted the split-key behaviour the fix removes. The
// case's intent ("a disposition cannot adjudicate what it does not name") is
// preserved by moving it onto the axis that now carries identity.

check(
  "section-label-dropped/streak-SURVIVES",
  "the loom#1748 regression: 3 labelled runs + a 4th with the label dropped is ONE key at 4, exit 1",
  () => {
    const root = withStreak(3);
    // The sweep-session34 shape, measured on main 2026-08-16: the same verdict
    // rendered without a `Sweep N` token. Under the shipped composite key this
    // minted `unattributed/…` and zeroed the live streak (exit 0, escalation
    // silently withdrawn). Falsifying result: a streak < 4, or exit 0.
    writeReport(
      root,
      "sweep-2026-08-04.md",
      "- **[MED]** `manual-supplement-required` — `spec_count=0` AND `specs/` EXISTS.",
    );
    const r = run(root, TODAY);
    const f = r.json?.findings?.[0];
    return (
      (r.code === 1 &&
        r.json.escalations_owed === 1 &&
        r.json.streaks.length === 1 &&
        f?.streak === 4 &&
        JSON.stringify(f?.steps) === JSON.stringify(["Sweep 5", "unattributed"])) ||
      `code=${r.code} keys=${JSON.stringify(r.json?.streaks)} f=${JSON.stringify(f)}`
    );
  },
);

check(
  "legacy-composite-disposition-key/still-resolves",
  "a sentinel written against the OLD `<step>/<verdict>` grammar still suppresses; exit 0",
  () => {
    const root = withStreak(3);
    fs.appendFileSync(
      path.join(root, "workspaces/ws/04-validate/sweep-2026-08-03.md"),
      '\n<!-- unadjudicated-disposition:v1 key="Sweep 5/manual-supplement-required" issue=1722 owner=someone until=2026-09-30 -->\n',
    );
    const r = run(root, TODAY);
    const f = r.json?.findings?.[0];
    return (
      (r.code === 0 && f?.escalation_owed === false && f?.suppressed_by?.key_raw === "Sweep 5/manual-supplement-required") ||
      `code=${r.code} owed=${f?.escalation_owed} raw=${f?.suppressed_by?.key_raw}`
    );
  },
);

check(
  "two-keys-one-at-threshold/escalates-exactly-one",
  "Sweep 5 at 3 and Sweep 8 at 1: precisely one escalation, so the detector is not a blanket alarm",
  () => {
    const root = withStreak(3);
    fs.appendFileSync(
      path.join(root, "workspaces/ws/04-validate/sweep-2026-08-03.md"),
      "\n- **[LOW][Sweep 8] `unadjudicated`** — first occurrence.\n",
    );
    const r = run(root, TODAY);
    const keys = r.json?.findings?.map((f) => f.key);
    return (
      (r.code === 1 && r.json.escalations_owed === 1 && JSON.stringify(keys) === JSON.stringify(["manual-supplement-required"])) ||
      `code=${r.code} owed=${r.json?.escalations_owed} keys=${JSON.stringify(keys)}`
    );
  },
);

check(
  "root-level-SWEEP-reports/are-discovered",
  "reports at the repo root (SWEEP-<date>.md) are runs too; 3 of them escalate",
  () => {
    const root = newRepo();
    for (const d of ["01", "02", "03"]) writeReport(root, `SWEEP-2026-08-${d}.md`, VERDICT_ROW, { dir: "." });
    const r = run(root, TODAY);
    return (r.code === 1 && r.json.runs_scanned === 3) || `code=${r.code} runs=${r.json?.runs_scanned}`;
  },
);

check(
  "same-date-suffixed-report/counts-as-a-separate-run",
  "sweep-2026-08-02b.md is a second run on one day; two dates plus the suffix reach the threshold",
  () => {
    const root = newRepo();
    writeReport(root, "sweep-2026-08-01.md", VERDICT_ROW);
    writeReport(root, "sweep-2026-08-02.md", VERDICT_ROW);
    writeReport(root, "sweep-2026-08-02b.md", VERDICT_ROW);
    const r = run(root, TODAY);
    return (r.code === 1 && r.json.runs_scanned === 3) || `code=${r.code} runs=${r.json?.runs_scanned}`;
  },
);

// ── instrument integrity ────────────────────────────────────────────────────

check(
  "undated-report/is-surfaced-never-silently-dropped",
  "a report with no date in its basename cannot be ordered, so it is listed under undated_reports",
  () => {
    const root = withStreak(3);
    writeReport(root, "sweep-final.md", VERDICT_ROW);
    const r = run(root, TODAY);
    return (
      (r.json?.undated_reports?.length === 1 && /sweep-final\.md$/.test(r.json.undated_reports[0])) ||
      `undated=${JSON.stringify(r.json?.undated_reports)}`
    );
  },
);

check(
  "threshold-is-not-tunable/unknown-flag-is-rejected",
  "there is deliberately no --threshold escape hatch; passing one exits 2 rather than weakening the gate",
  () => {
    const r = spawnSync(process.execPath, [TOOL, "--threshold", "99"], { encoding: "utf8" });
    return (r.status === 2 && /unknown argument/.test(r.stderr)) || `code=${r.status} stderr=${r.stderr.trim()}`;
  },
);

check(
  "self-check/refuses-to-report-when-the-matcher-cannot-discriminate",
  "the binary fires its own known-answer controls before reading any repo; a broken matcher exits 2, not 0",
  () => {
    const src = fs.readFileSync(TOOL, "utf8");
    const wired =
      /const selfCheckFailures = selfCheck\(\);/.test(src) &&
      /SELF-CHECK FAILED/.test(src) &&
      src.indexOf("const selfCheckFailures") < src.indexOf("= discoverReports(root)");

    // Discriminating half: break the matcher and require exit 2 rather than a
    // verdict. The mutation is asserted to have LANDED first — a replace() that
    // silently matched nothing would leave an INERT mutation whose green proves
    // nothing (`instrument-discipline.md` MUST-2(b)).
    const target = "const VERDICT_ALT = UNADJUDICATED_VERDICTS.join(\"|\");";
    const mutated = src.replace(target, 'const VERDICT_ALT = "zzz-no-such-verdict";');
    if (mutated === src) return `INERT MUTATION: anchor not found in ${TOOL}`;

    const broken = path.join(TMP, "broken-tool.mjs");
    fs.writeFileSync(broken, mutated, "utf8");
    const r = spawnSync(process.execPath, [broken, "--root", withStreak(3), ...TODAY], { encoding: "utf8" });
    return (
      (wired && r.status === 2 && /SELF-CHECK FAILED/.test(r.stderr)) ||
      `wired=${wired} mutatedExit=${r.status} stderr=${r.stderr.slice(0, 160)}`
    );
  },
);

check(
  "live-repository/the-instrument-runs-here",
  "fired against THIS checkout the binary reads real reports and returns a parseable verdict (0 or 1)",
  () => {
    const r = spawnSync(process.execPath, [TOOL, "--json", ...TODAY], { encoding: "utf8" });
    let j = null;
    try {
      j = JSON.parse(r.stdout);
    } catch {
      /* left null */
    }
    return (
      ((r.status === 0 || r.status === 1) && j && j.runs_scanned > 0 && j.threshold === 3) ||
      `code=${r.status} runs=${j?.runs_scanned} threshold=${j?.threshold}`
    );
  },
);

fs.rmSync(TMP, { recursive: true, force: true });

const total = pass + failures.length;
console.log(`\nunadjudicated-escalation: ${pass}/${total} PASS`);
if (failures.length > 0) {
  console.log(`FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
