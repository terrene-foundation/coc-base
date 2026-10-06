#!/usr/bin/env node
/*
 * Audit-fixture runner for the declared-ratchet monotonicity gate
 * (`.claude/bin/check-ratchet-monotonicity.mjs`).
 *
 * ── WHAT THIS SUITE COVERS, AND WHAT IT DELIBERATELY DOES NOT ───────────────
 *
 * The checker already carries an IN-PROCESS self-control (`selfControl()`) over
 * `compareDirection` and `extractValues`: the four direction cases, the hold, and
 * the extractor's known-shape/ambiguous-shape pair. That control is good and this
 * suite does not duplicate it.
 *
 * What it cannot reach is everything BETWEEN the git plumbing and the exit code —
 * which ref the values are read from, whether a refusal is actually a refusal at
 * the process boundary, whether the override records or merely suppresses, and
 * whether an unanswerable run reports UNKNOWN instead of clean. A green
 * `selfControl()` is fully consistent with a checker that reads the wrong tree and
 * exits 0 on everything. That is `instrument-discipline.md` MUST-2(a) exactly: a
 * green reports on the behaviour it NAMES, and `selfControl` does not name these.
 *
 * So every case here runs the REAL binary as a subprocess against a REAL temporary
 * git repository. Nothing is injected and nothing is mocked.
 *
 * ── BIPOLAR PER ARM, AND THE HARNESS ASSERTS THE POLES DIFFER ───────────────
 *
 * `instrument-bipolarity.md` MUST-1: every arm ships an executable pole PAIR and
 * the harness itself asserts the two verdicts DIFFER. A pair whose poles agree is
 * VACUOUS and FAILS here rather than passing quietly — a checker wired to refuse
 * everything, or to clear everything, passes exactly one pole of every pair and is
 * caught by the NON-VACUOUS case.
 *
 * MUST-2: every RED pole names a failure IDENTITY — which ratchet, which values,
 * which direction — never a bare exit code. A suite reading only exit codes stays
 * green against a gate that refuses the wrong thing for the wrong reason.
 *
 * ── ARM C IS THE LOAD-BEARING ONE ──────────────────────────────────────────
 *
 * Arm C pins the merge-base semantics, and it exists because the tip-comparing
 * version of this checker SHIPPED and was wrong. Measured on PR #1954's branch (86
 * commits behind the trunk): three findings against a branch that had touched none
 * of them — one "loosening" and two "removed ratchets" — every one of them the
 * TRUNK's own movement rendered as the BRANCH's. A gate that reds for a condition
 * its author cannot fix is the gate that gets skip-listed, after which it protects
 * nothing. Arm C's two poles differ ONLY in whether the branch itself moved the
 * value, which is the whole property.
 *
 * Exits non-zero on the first mismatch, printing expected vs actual.
 */

import "../_lib/no-ambient-git.cjs";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const CHECKER = path.join(REPO_ROOT, ".claude", "bin", "check-ratchet-monotonicity.mjs");

let cases = 0;
const failures = [];
const tmpDirs = [];

// Emitting ONE `PASS <name>` / `FAIL <name>` line PER CASE is load-bearing, not
// cosmetic. `run-audit-fixtures.mjs` counts cases with `/^[ \t]*(?:PASS|ok)[ \t]+\S/`
// and deliberately does NOT count a summary line. A runner that prints only its
// summary is observed at ZERO cases against its declared `min_cases` — it exits 0
// while contributing NO coverage, which is the state `coc-artifact-eval-coverage.md`
// MUST-3 refuses to read as a pass. Do not "tidy" these lines away.
function check(name, verdict) {
  cases++;
  if (verdict === true) {
    console.log(`PASS ${name}`);
    return true;
  }
  failures.push(`  ${name}\n      ${verdict}`);
  console.log(`FAIL ${name} — ${verdict}`);
  return false;
}

/**
 * One bipolar arm: a RED pole, a GREEN pole, and the non-vacuity assertion.
 *
 * Each pole returns `true` for a pass or a STRING naming what went wrong. A pole
 * that passes returns its own identity string through `identity` so the harness can
 * assert the two poles did not produce the same verdict — which is what makes a
 * pair evidence rather than two independent green lights.
 */
function pair(name, redWhat, red, greenWhat, green) {
  const r = red();
  const g = green();
  check(`${name} · RED   · ${redWhat}`, r === true ? true : r);
  check(`${name} · GREEN · ${greenWhat}`, g === true ? true : g);
  check(
    `${name} · NON-VACUOUS · the two poles produce DIFFERENT verdicts`,
    r === true && g === true ? true : "a pole failed, so non-vacuity cannot be asserted from this run",
  );
}

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const TARGET_REL = "declared.json";
const REGISTRY_REL = "registry.json";

function writeTarget(dir, value) {
  fs.writeFileSync(path.join(dir, TARGET_REL), `${JSON.stringify({ tracker: { limit: value } }, null, 2)}\n`);
}

/**
 * A repository carrying ONE declared ratchet.
 *
 * `trunkValue` is committed on `main`; the lane branches from there and commits
 * `headValue`. When `advanceTrunkTo` is set, `main` moves AFTER the branch point —
 * which is the stale-branch shape, and the ONLY configuration in which reading the
 * trunk TIP and reading the MERGE-BASE give different answers.
 */
function mkRepo({ direction, trunkValue, headValue, advanceTrunkTo = null, withRegistry = true, ratified = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-fx-"));
  tmpDirs.push(dir);
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "fixture@example.invalid"], dir);
  git(["config", "user.name", "fixture"], dir);
  git(["config", "commit.gpgsign", "false"], dir);

  if (withRegistry) {
    fs.writeFileSync(
      path.join(dir, REGISTRY_REL),
      `${JSON.stringify(
        {
          ratchets: {
            "fixture-limit": {
              file: TARGET_REL,
              selector: { kind: "json-scalar", path: ["tracker", "limit"] },
              direction,
              declared_by:
                "the fixture's own declaration: this value is pinned by DIRECTION, never by value, so a " +
                "legitimate tightening stays clean while any loosening refuses.",
              ...(ratified ? { ratified_movements: ratified } : {}),
            },
          },
        },
        null,
        2,
      )}\n`,
    );
  }
  writeTarget(dir, trunkValue);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "seed"], dir);

  git(["switch", "-q", "-c", "lane"], dir);
  writeTarget(dir, headValue);
  git(["add", "-A"], dir);
  // `--allow-empty`: Arm C's clean pole HOLDS the value, so the lane has no diff of
  // its own. Without this the fixture cannot express "a branch that moved nothing" —
  // which is exactly the case the merge-base fix exists to clear.
  git(["commit", "-q", "--allow-empty", "-m", "lane commit"], dir);

  if (advanceTrunkTo !== null) {
    git(["switch", "-q", "main"], dir);
    writeTarget(dir, advanceTrunkTo);
    git(["add", "-A"], dir);
    git(["commit", "-qm", "the TRUNK moves, after the lane branched"], dir);
    git(["switch", "-q", "lane"], dir);
  }
  return dir;
}

function run(dir, { env = null } = {}) {
  const r = spawnSync(
    "node",
    [CHECKER, "--repo", dir, "--registry", path.join(dir, REGISTRY_REL), "--trunk", "main"],
    { cwd: dir, encoding: "utf8", timeout: 60000, ...(env ? { env: { ...process.env, ...env } } : {}) },
  );
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

// ═══════════════════════════════════════════════════════════════════════════
// ARM A — a CEILING (may-only-fall): rising REFUSES, falling is clean
// ═══════════════════════════════════════════════════════════════════════════

pair(
  "ceiling-direction",
  "a RISING may-only-fall ceiling REFUSES, naming the ratchet, both values and the direction",
  () => {
    const r = run(mkRepo({ direction: "may-only-fall", trunkValue: 10, headValue: 12 }));
    if (r.code !== 1) return `a rising ceiling exited ${r.code}; a loosening must be exit 1 (FINDINGS)`;
    const all = r.out + r.err;
    if (!/LOOSENED/.test(all)) return `refused, but not on the loosening predicate: ${all.slice(0, 240)}`;
    if (!/fixture-limit/.test(all)) return "the refusal does not name WHICH ratchet loosened";
    if (!/10 -> 12/.test(all)) return `the refusal does not name BOTH values: ${all.slice(0, 240)}`;
    if (!/may-only-fall/.test(all)) return "the refusal does not name the declared direction";
    if (/\bOK\b/.test(r.out)) return "a refusal carried the clean-summary token OK";
    return true;
  },
  "a FALLING ceiling is the TIGHTENING direction and exits 0, reported as clean",
  () => {
    const r = run(mkRepo({ direction: "may-only-fall", trunkValue: 10, headValue: 8 }));
    if (r.code !== 0) return `a falling ceiling exited ${r.code}: ${(r.out + r.err).slice(0, 240)}`;
    if (!/TIGHTENED/.test(r.out)) return `a tightening was not reported as such: ${r.out.slice(0, 240)}`;
    if (!/10 -> 8/.test(r.out)) return "the tightening does not name both values";
    if (/LOOSENED/.test(r.out + r.err)) return "a tightening was scored as a loosening";
    return true;
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// ARM B — a FLOOR (may-only-rise): the MIRROR, and it is not decorative
//
// The registry carries both directions in ONE file — `min_cases` is a floor while
// the byte ceilings above it are ceilings — so a checker that hardcoded one
// direction would pass every case in Arm A and silently clear every loosened
// floor. This arm is what makes Arm A's green mean "direction is read" rather than
// "falling is clean".
// ═══════════════════════════════════════════════════════════════════════════

pair(
  "floor-direction",
  "a FALLING may-only-rise floor REFUSES — the OPPOSITE movement from Arm A's red",
  () => {
    const r = run(mkRepo({ direction: "may-only-rise", trunkValue: 60, headValue: 59 }));
    if (r.code !== 1) return `a falling floor exited ${r.code}; a loosening must be exit 1 (FINDINGS)`;
    const all = r.out + r.err;
    if (!/LOOSENED/.test(all)) return `refused, but not on the loosening predicate: ${all.slice(0, 240)}`;
    if (!/60 -> 59/.test(all)) return `the refusal does not name BOTH values: ${all.slice(0, 240)}`;
    if (!/may-only-rise/.test(all)) return "the refusal does not name the declared direction";
    return true;
  },
  "a RISING floor is the TIGHTENING direction and exits 0 — the same movement Arm A REFUSED",
  () => {
    const r = run(mkRepo({ direction: "may-only-rise", trunkValue: 60, headValue: 61 }));
    if (r.code !== 0) return `a rising floor exited ${r.code}: ${(r.out + r.err).slice(0, 240)}`;
    if (!/TIGHTENED/.test(r.out)) return `a tightening was not reported as such: ${r.out.slice(0, 240)}`;
    if (/LOOSENED/.test(r.out + r.err)) return "a rising floor was scored as a loosening";
    return true;
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// ARM C — VALUES ARE READ FROM THE MERGE-BASE, NEVER THE TRUNK TIP
//
// THE REGRESSION PIN. The tip-comparing version of this checker shipped and
// reported three findings on a branch that had moved none of the values — the
// trunk had tightened one ratchet and added two after the branch point, and all
// three rendered as the branch's loosenings.
//
// BOTH poles are stale branches behind a MOVED trunk. They differ in ONE thing:
// whether the LANE itself moved the value. That is the only difference the gate is
// entitled to score on, so a checker reading the tip fails the GREEN pole while a
// checker that simply stopped comparing fails the RED pole.
// ═══════════════════════════════════════════════════════════════════════════

pair(
  "merge-base-not-tip",
  "a stale branch that GENUINELY loosens still REFUSES — the fix did not disable the gate",
  () => {
    // Lane 10 -> 12 (a real rise on a may-only-fall ceiling) while the trunk
    // independently tightened to 8. Against the merge-base value of 10 this is a
    // loosening and must red.
    const r = run(mkRepo({ direction: "may-only-fall", trunkValue: 10, headValue: 12, advanceTrunkTo: 8 }));
    if (r.code !== 1) return `a genuine loosening on a stale branch exited ${r.code}; it must be exit 1`;
    const all = r.out + r.err;
    if (!/LOOSENED/.test(all)) return `refused, but not on the loosening predicate: ${all.slice(0, 240)}`;
    // Measured FROM THE MERGE-BASE (10), not from the trunk tip (8). A tip read
    // would render this as "8 -> 12" and overstate the movement.
    if (!/10 -> 12/.test(all)) return `the movement was not measured from the merge-base: ${all.slice(0, 240)}`;
    if (/8 -> 12/.test(all)) return "the movement was measured from the trunk TIP, not the merge-base";
    return true;
  },
  "a stale branch that moved NOTHING is CLEAN even though the TRUNK tightened past it",
  () => {
    // The lane holds at 10; the trunk moved to 8 after the branch point. Reading
    // the tip renders the trunk's own tightening as an 8 -> 10 RISE by the lane —
    // a finding against an author who changed nothing, which is the whole defect.
    const r = run(mkRepo({ direction: "may-only-fall", trunkValue: 10, headValue: 10, advanceTrunkTo: 8 }));
    if (r.code !== 0) {
      return `a branch that moved nothing exited ${r.code} — the trunk's own movement was scored as the branch's: ${(r.out + r.err).slice(0, 300)}`;
    }
    const all = r.out + r.err;
    if (/LOOSENED/.test(all)) return `the trunk's tightening was reported as the branch loosening: ${all.slice(0, 300)}`;
    if (/8 -> 10/.test(all)) return "the comparison was made against the trunk TIP";
    // The report must SAY which ref the values came from — emitting only one of
    // tip and merge-base is how a reader ends up believing it compared the tip.
    if (!/merge-base/.test(r.out)) return `the report does not name the comparison basis: ${r.out.slice(0, 300)}`;
    return true;
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// ARM D — THE OVERRIDE RECORDS, IT DOES NOT SUPPRESS
//
// An override that silently cleared would be indistinguishable from no gate at
// all, and a token reason that excused would make the substantive-reason
// requirement decorative. Both poles are the SAME loosening; only the reason
// differs.
// ═══════════════════════════════════════════════════════════════════════════

pair(
  "override-is-loud",
  "a TOKEN override reason does NOT excuse — the run still refuses",
  () => {
    const r = run(mkRepo({ direction: "may-only-fall", trunkValue: 10, headValue: 12 }), {
      env: { RATCHET_RAISE_OVERRIDE: "  " },
    });
    if (r.code !== 1) return `a whitespace-only override reason exited ${r.code}; it must not excuse`;
    if (!/LOOSENED/.test(r.out + r.err)) return "the refusal is not the loosening finding";
    return true;
  },
  "a SUBSTANTIVE override permits the loosening AND prints the reason under a fixed marker",
  () => {
    const reason = "the ceiling was re-anchored against a measured emission recorded in this same diff";
    const r = run(mkRepo({ direction: "may-only-fall", trunkValue: 10, headValue: 12 }), {
      env: { RATCHET_RAISE_OVERRIDE: reason },
    });
    if (r.code !== 0) return `a substantive override exited ${r.code}: ${(r.out + r.err).slice(0, 240)}`;
    const all = r.out + r.err;
    if (!/RATCHET-RAISE-OVERRIDE/.test(all)) return "the excused movement carries no greppable marker";
    if (!all.includes(reason)) return "the excused movement does not print the REASON verbatim";
    // An excused loosening must not read as "nothing loosened".
    if (/OK  no registered ratchet loosened/.test(all)) {
      return "an excused loosening was summarised as though nothing had loosened";
    }
    return true;
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// ARM E — UNANSWERABLE IS UNKNOWN, AND UNKNOWN IS NOT A PASS
//
// The fail-open design is deliberate: a checker that blocks because it could not
// parse something gets disabled within a week. But fail-open must be LOUD, or a
// run that compared nothing is indistinguishable from a run that cleared
// everything — which is this rule's own failure mode applied to itself.
// ═══════════════════════════════════════════════════════════════════════════

pair(
  "unknown-is-not-clean",
  "no registry at all is UNKNOWN (exit 3) and SAYS nothing was cleared",
  () => {
    const r = run(mkRepo({ direction: "may-only-fall", trunkValue: 10, headValue: 12, withRegistry: false }));
    if (r.code !== 3) return `an absent registry exited ${r.code}; nothing-comparable must be exit 3 (UNKNOWN)`;
    const all = r.out + r.err;
    if (!/UNKNOWN/.test(all)) return "the run does not report UNKNOWN";
    if (!/NOT a pass/.test(all)) return "an UNKNOWN run does not say it is NOT a pass";
    if (/\bOK\b/.test(r.out)) return "an UNKNOWN run carried the clean-summary token OK";
    return true;
  },
  "the SAME movement WITH a registry is comparable and reaches a real verdict",
  () => {
    // Byte-identical repo shape minus the missing registry. Without this pole a
    // checker that returned UNKNOWN for everything would pass the RED pole.
    const r = run(mkRepo({ direction: "may-only-fall", trunkValue: 10, headValue: 12 }));
    if (r.code === 3) return "a fully comparable run still reported UNKNOWN";
    if (r.code !== 1) return `expected the loosening verdict (exit 1), got ${r.code}`;
    if (!/LOOSENED/.test(r.out + r.err)) return "the comparable run reached no loosening verdict";
    return true;
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// ARM F — THE REFUSAL STEERS TOWARD THE AUDITABLE PATH, NOT THE TRACELESS ONE
//
// This arm exists because its absence was MEASURED, not supposed. A mutation that
// reverted the REFUSED block to the original env-var-only remediation left this
// suite at 15/15 green and the checker's own in-process `selfControl()` clean: the
// old text was emitted verbatim and NOTHING observed it. That is vacuity in the
// `instrument-discipline.md` MUST-5(b) sense, established by double mutation and
// closed here.
//
// What it pins is not "the message mentions both paths" but the ORDER and the
// LABEL. Two ways past a refusal exist and they are not equivalent: a
// `ratified_movements` record lands IN THE TREE, is reviewable in the diff, and CI
// can honour it; `RATCHET_RAISE_OVERRIDE` is an env var whose reason survives only
// in one run's stdout, and CI cannot set it at all. A refusal naming only the env
// var — or naming it first — steers every operator who hits it onto the untraceable
// path, which is the drift this whole tool exists to catch. An instrument that
// regenerates its own failure mode in its output is not a working instrument.
//
// `selfControl()` already asserts the ORDER inside `renderRefusalRemediation`. It
// cannot assert the renderer is WIRED to the output, and that unwiring is exactly
// the mutation that went undetected — so this arm reads the EMITTED bytes at the
// process boundary instead.
// ═══════════════════════════════════════════════════════════════════════════

const RATIFIED_FIELD = "ratified_movements";
const OVERRIDE_VAR = "RATCHET_RAISE_OVERRIDE";

pair(
  "refusal-steers-to-the-auditable-path",
  `a REFUSAL names \`${RATIFIED_FIELD}\` BEFORE ${OVERRIDE_VAR} and labels the env var traceless`,
  () => {
    const r = run(mkRepo({ direction: "may-only-fall", trunkValue: 10, headValue: 12 }));
    if (r.code !== 1) return `expected the loosening refusal (exit 1), got ${r.code}`;
    const all = r.out + r.err;
    if (!/REFUSED/.test(all)) return "this pole did not reach the refusal branch at all";
    const auditableAt = all.indexOf(RATIFIED_FIELD);
    const tracelessAt = all.indexOf(OVERRIDE_VAR);
    if (auditableAt < 0) {
      return `the refusal never names the AUDITABLE path (\`${RATIFIED_FIELD}\`) — it offers only the env var`;
    }
    if (tracelessAt < 0) return `the refusal never names ${OVERRIDE_VAR}`;
    if (auditableAt > tracelessAt) {
      return `the refusal names ${OVERRIDE_VAR} first (at ${tracelessAt}) and \`${RATIFIED_FIELD}\` second (at ${auditableAt}) — it steers to the traceless path`;
    }
    if (!/NO AUDIT RECORD/.test(all)) {
      return `the refusal does not tell the operator that ${OVERRIDE_VAR} leaves no audit record`;
    }
    // The record it prints must be COPYABLE — the endpoints of THIS movement, not a
    // generic placeholder the operator has to guess at.
    for (const frag of ['entry: "tracker.limit"', "from: 10", "to: 12"]) {
      if (!all.includes(frag)) return `the suggested ratification record omits ${frag}`;
    }
    return true;
  },
  "the SAME movement WITH a recorded ratification CLEARS, and prints no remediation",
  () => {
    // The record below is the one the RED pole's own message tells the operator to
    // write. If this pole fails, the refusal is giving advice that does not work.
    const r = run(
      mkRepo({
        direction: "may-only-fall",
        trunkValue: 10,
        headValue: 12,
        ratified: [
          {
            entry: "tracker.limit",
            from: 10,
            to: 12,
            ratified_by: "the fixture's named acceptor",
            reason: "the fixture ratifies exactly this movement, and no other value",
            date: "2026-09-14",
          },
        ],
      }),
    );
    if (r.code !== 0) return `a recorded ratification exited ${r.code}: ${(r.out + r.err).slice(0, 240)}`;
    const all = r.out + r.err;
    if (!/RATCHET-RATIFIED/.test(all)) return "the ratified movement carries no greppable marker";
    if (!/LOOSENED, ratified/.test(all)) return "a ratified loosening was not reported AS a loosening";
    if (/OK {2}no registered ratchet loosened/.test(all)) {
      return "a ratified loosening was summarised as though nothing had loosened";
    }
    if (/REFUSED/.test(all)) return "a ratified movement still emitted a refusal";
    // No env var was set, and none was needed — which is the whole claim the RED
    // pole's message makes.
    if (new RegExp(`re-run with ${OVERRIDE_VAR}`).test(all)) {
      return "a CLEARED run still steered the operator toward the traceless override";
    }
    return true;
  },
);

// ── teardown ────────────────────────────────────────────────────────────────

for (const d of tmpDirs) {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch {
    /* best effort — a leftover temp dir is not a test failure */
  }
}

if (failures.length) {
  console.error(`\nratchet-monotonicity fixtures: ${failures.length} of ${cases} FAILED\n`);
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`\nratchet-monotonicity fixtures: ${cases}/${cases} passed`);
