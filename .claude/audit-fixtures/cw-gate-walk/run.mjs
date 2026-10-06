#!/usr/bin/env node
/**
 * run.mjs — audit-fixture runner for `.claude/bin/cw-gate-walk.mjs`, the
 * Conformance Walk DELIVERED adapter whose units are GATES. Ships WITH the gate
 * per `cc-artifacts.md` Rule 9.
 *
 * THE FILE NAME IS `run.mjs` AND MUST STAY `run.mjs`. The accepted set is
 * `["run.mjs", "run.cjs"]` (`.claude/bin/lib/audit-fixture-runners.mjs:57`), and
 * any other `run.*` basename is REFUSED BY NAME rather than skipped. It also
 * lives at DEPTH 1 under `.claude/audit-fixtures/`: discovery does exactly one
 * `readdirSync` per directory, so a nested slug is neither executed nor reported
 * missing. The sibling `conformance-walk/run.mjs` still describes itself as
 * `floor-run.mjs` in its own docblock and `conformance-walk.md` copied that name
 * into its Detection row, where it resolves to nothing — this header states its
 * own filename correctly so the same rot cannot start here.
 *
 * NO LIVE REPO NEEDED, AND THAT IS THE POINT. The gate itself reads the
 * authorities declared in `cw-gate-walk.mjs::AUTHORITIES` off disk; these
 * fixtures drive its PURE PREDICATES against
 * SYNTHETIC worlds declared in each case file. So the poles are stable under any
 * corpus change, and a case can express a world this repo does not currently
 * contain — a suite bound to a step nobody declares, a runner with no
 * `--dedicated-only` mode — which is exactly where the measured failures lived.
 *
 * WHAT A GREEN RUN HERE SHOWS AND DOES NOT SHOW. It shows the oracle decides
 * correctly on known-answer worlds. It does NOT show the gate is IN FORCE — that
 * rests on the two `dev-preflight` CHECKS entries (`gate-walk`,
 * `gate-walk-selftest`) and the two workflow steps registered in the same change,
 * per `artifact-stranding.md` MUST-3. Green fixtures are not a producer.
 *
 * BIPOLAR BY CONSTRUCTION, per predicate AND per scope restriction
 * (`instrument-bipolarity.md` MUST-1/MUST-2). A set that only ever asserts firing
 * passes identically against a gate that fires on everything; a set that only
 * asserts silence passes identically against an INERT one. Both are live risks:
 * this gate's whole job is to notice absence, and absence is what an inert gate
 * also reports. The poles, paired — each pair separating on ONE fact:
 *
 *   ci-gate reach          flag-ci-gate-unreached      ⟷ clean-ci-gate-reached
 *                          (same tool, same workflow site; differ only on whether
 *                           a reach channel names it)
 *   declared-gap: SPAWN    flag-declared-gap-mention   ⟷ clean-declared-gap-spawn
 *                          (BYTE-IDENTICAL markers; the suite BODY differs, one
 *                           citing a real `execFileSync` line and one citing an
 *                           array element — the MEASURED false-positive shape from
 *                           `f1030d-fail-closed-bin.test.mjs:64`)
 *   declared-gap: LINE     flag-declared-gap-wrong-line ⟷ clean-declared-gap-spawn
 *   declared-gap: EXCLUDED flag-declared-gap-excluded  ⟷ clean-declared-gap-spawn
 *   suite runner mode      flag-suite-no-runner-mode   ⟷ clean-suite-dedicated-bound
 *                          (the 15-suite blindness, both poles)
 *   suite step binding     flag-suite-step-unbound     ⟷ clean-suite-dedicated-bound
 *   suite default mode     (none needed)               ⟷ clean-suite-bulk
 *   registry disposition   (a declared exclusion)      ⟷ clean-suite-excluded
 *   preflight↔CI parity    flag-preflight-orphan-tool  ⟷ clean-preflight-tool-in-ci
 *   provisioning           flag-provisioned-step       (NEVER has a Pass pole — see
 *                          the case file; a provisioned verdict is not derivable
 *                          offline, so `Blocked` is the only honest outcome and a
 *                          clean pole here would be the fabrication)
 *   ratchet + coverage     unit cases U1–U6 below
 *
 * FAILURE OUTPUT NAMES AN IDENTITY, never merely a non-zero exit: every mismatch
 * prints the case, the predicate family, and the expected-versus-observed
 * (verdict, rule_id) pair; the run closes with a named RED SET.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const G = await import(join(REPO, ".claude", "bin", "cw-gate-walk.mjs"));

/** Which predicate family each case exercises — printed on failure. */
const FAMILY = {
  "flag-ci-gate-unreached": "ci-gate reach (R6 preflight↔CI parity)",
  "clean-ci-gate-reached": "ci-gate reach (accept pole)",
  "flag-declared-gap-mention": "declared-gap verification — mention is not execution",
  "flag-declared-gap-wrong-line": "declared-gap verification — cited line",
  "flag-declared-gap-excluded": "declared-gap verification — excluded suite",
  "clean-declared-gap-spawn": "declared-gap verification (accept pole)",
  "flag-suite-no-runner-mode": "suite execution — no runner mode (the 15-suite blindness)",
  "flag-suite-step-unbound": "suite execution — step binding",
  "clean-suite-dedicated-bound": "suite execution (accept pole, dedicated)",
  "clean-suite-bulk": "suite execution (accept pole, default mode)",
  "clean-suite-excluded": "suite execution — declared exclusion",
  "flag-preflight-orphan-tool": "preflight↔CI parity (preflight side)",
  "clean-preflight-tool-in-ci": "preflight↔CI parity (accept pole)",
  "flag-provisioned-step": "provisioning — never Pass offline",
};

let pass = 0;
const failures = [];

function check(name, predicate, ok, detail) {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}  [${predicate}]`);
  } else {
    failures.push({ name, predicate, detail });
    console.log(`FAIL  ${name}  [${predicate}] — ${detail}`);
  }
}

/** Parse the `# key: value` marker header; everything else is the suite BODY. */
function parseFixture(text) {
  const m = {};
  const body = [];
  for (const line of text.split("\n")) {
    const hit = /^#\s*([a-z_]+)\s*:\s*(.*)$/.exec(line);
    if (hit) {
      m[hit[1]] = hit[2].trim();
      continue;
    }
    if (/^#/.test(line)) continue; // narrative comment
    body.push(line);
  }
  return { m, body: body.join("\n") };
}

const list = (v) =>
  !v ? [] : v.split(/\s*,\s*/).filter(Boolean);

/** Build the synthetic unit + world a case declares. */
function buildCase(m, body) {
  const kind = m.kind;
  const world = {
    ciTools: new Map(list(m.ci_tools).map((t) => [t, "wf.yml:10"])),
    reach: new Map(list(m.reach).map((t) => [t, "direct:synthetic"])),
    declaredGaps: new Map(),
    suiteIndex: new Map(),
    workflowStepNames: new Set(list(m.workflow_steps)),
    dedicatedModeExists: m.dedicated_mode_exists !== "false",
  };
  if (m.declared_suite) {
    world.suiteIndex.set(m.declared_suite, { mode: m.suite_mode || "bulk", text: body });
  }

  let unit;
  if (kind === "ci-gate") {
    unit = {
      kind,
      id: `ci-gate::${m.tool}`,
      actual: { tool: m.tool, workflow_site: "wf.yml:10" },
    };
    if (m.declared_suite) {
      world.declaredGaps.set(`ci-gate::${m.tool}`, {
        covering_suite: m.declared_suite,
        execution_line: m.declared_line ? Number(m.declared_line) : undefined,
      });
    }
  } else if (kind === "preflight-check") {
    unit = {
      kind,
      id: `preflight-check::${m.check_id}`,
      actual: { tools: list(m.tools), cite: "synthetic" },
    };
  } else if (kind === "suite") {
    unit = {
      kind,
      id: `suite::synthetic::${m.name || "s.test.mjs"}`,
      actual: { mode: m.mode, step: m.step || null, registry: "synthetic" },
    };
  } else if (kind === "provisioned-step") {
    unit = {
      kind,
      id: "provisioned-step::wf.yml::synthetic",
      actual: { requires: list(m.requires), site: "wf.yml:70" },
    };
  } else {
    return null;
  }
  return { unit, world };
}

// ── fixture-driven cases ─────────────────────────────────────────────────────

const fixtures = readdirSync(HERE)
  .filter((f) => /^(?:flag|clean|skip)-.*\.txt$/.test(f))
  .sort();

if (fixtures.length === 0) {
  console.log("FAIL  <fixture-discovery>  [runner] — no flag-/clean-/skip-*.txt fixtures found");
  process.exit(1);
}

for (const f of fixtures) {
  const name = f.replace(/\.txt$/, "");
  const family = FAMILY[name] || "(unclassified)";
  const { m, body } = parseFixture(readFileSync(join(HERE, f), "utf8"));

  if (!m.kind || !m.expect_verdict) {
    check(name, "fixture-markers", false, "missing `# kind:` or `# expect_verdict:` marker");
    continue;
  }
  const built = buildCase(m, body);
  if (!built) {
    check(name, "fixture-markers", false, `unknown \`# kind: ${m.kind}\``);
    continue;
  }

  let got;
  try {
    const exp = G.freezeExpectation(built.unit);
    got = G.oracle(built.unit, exp, built.world);
  } catch (err) {
    check(name, family, false, `oracle THREW: ${err.message}`);
    continue;
  }

  const wantVerdict = m.expect_verdict;
  const wantRule = m.expect_rule || null;
  check(
    name,
    family,
    got.verdict === wantVerdict && (got.rule_id || null) === wantRule,
    `expected (${wantVerdict}, ${wantRule || "none"}) got (${got.verdict}, ${got.rule_id || "none"})` +
      ` :: ${got.evidence.detail || ""}`,
  );

  // Every verdict this gate reports must be a member of the discrete closed
  // taxonomy (`conformance-walk.md` MUST-4) and must carry its evidence.
  check(
    name,
    "verdict-in-discrete-taxonomy",
    G.VERDICTS.includes(got.verdict),
    `"${got.verdict}" is outside Pass|Fail|Blocked|Retest|Skipped|Not-Run`,
  );
  check(
    name,
    "evidence-present",
    typeof got.evidence.detail === "string" && got.evidence.detail.length > 0,
    "every verdict must carry a human-readable detail",
  );
}

// ── unit cases: the arms no fixture text can express ─────────────────────────

// U1 — the citation predicate's own poles. A MENTION must not verify as execution;
// this is the measured `f1030d-fail-closed-bin.test.mjs:64` shape.
const SPAWN = "x\nconst o = execFileSync('node', ['.claude/bin/check-x.mjs']);";
const MENTION = "const LIST = [\n  '.claude/bin/check-x.mjs',\n];";
check(
  "U1 citation-predicate-bipolar",
  "verifyExecutionCitation",
  G.verifyExecutionCitation(SPAWN, "check-x.mjs", 2).ok === true &&
    G.verifyExecutionCitation(MENTION, "check-x.mjs", 2).ok === false &&
    G.verifyExecutionCitation(SPAWN, "check-x.mjs", 1).ok === false &&
    G.verifyExecutionCitation(SPAWN, "check-x.mjs", 999).ok === false &&
    G.verifyExecutionCitation(SPAWN, "other.mjs", 2).ok === false &&
    G.verifyExecutionCitation(null, "check-x.mjs", 2).ok === false &&
    G.verifyExecutionCitation(SPAWN, "check-x.mjs", undefined).ok === false,
  "a cited spawn line accepts; a mention, a wrong line, a past-end line, a wrong tool and " +
    "absent input must all refuse",
);

// U2 — the RATCHET's new-gate tooth, both poles.
const recs = [{ unit_id: "a", verdict: "Pass", evidence: {} }];
check(
  "U2 ratchet-new-gate-bipolar",
  "ratchet/unwalked-new-gate",
  G.ratchet(recs, { frozen_units: [], ceilings: {} }).findings.some(
    (x) => x.rule_id === "cw-gate/unwalked-new-gate",
  ) && G.ratchet(recs, { frozen_units: ["a"], ceilings: {} }).findings.length === 0,
  "an unfrozen gate must red and a frozen one must not",
);

// U3 — the RATCHET's may-only-fall tooth, both poles, AND the at-ceiling boundary.
const two = [
  { unit_id: "a", verdict: "Not-Run", evidence: {} },
  { unit_id: "b", verdict: "Not-Run", evidence: {} },
];
const frozen2 = { frozen_units: ["a", "b"] };
check(
  "U3 ratchet-ceiling-bipolar",
  "ratchet/coverage-regression",
  G.ratchet(two, { ...frozen2, ceilings: { "Not-Run": 1 } }).findings.some(
    (x) => x.rule_id === "cw-gate/coverage-regression",
  ) &&
    G.ratchet(two, { ...frozen2, ceilings: { "Not-Run": 2 } }).findings.length === 0 &&
    G.ratchet(two, { ...frozen2, ceilings: { "Not-Run": 5 } }).findings.length === 0,
  "above the ceiling reds; at and below it does not",
);

// U4 — an ABSENT baseline is a refusal, never a green. A gate whose ratchet is
// unfrozen reports the same "no regression" as one that genuinely has none.
check(
  "U4 absent-baseline-reds",
  "ratchet/no-frozen-baseline",
  G.ratchet(recs, null).findings.some((x) => x.rule_id === "cw-gate/no-frozen-baseline") &&
    G.ratchet(recs, { frozen_units: ["a"], ceilings: {} }).findings.length === 0,
  "a missing baseline must red; a present one must not",
);

// U5 — coverage honesty: the no-vacuous guard, and coverage REPORTED SEPARATELY
// from pass-rate (`conformance-walk.md` MUST-3). 100% pass-rate over 50% coverage
// is the honest shape; one number would hide the unmeasured half.
const cov = G.coverage([
  { verdict: "Pass", evidence: { assertions: 1 } },
  { verdict: "Not-Run", evidence: {} },
]);
check(
  "U5 coverage-separate-and-no-vacuous",
  "coverage",
  cov.denominator === 2 &&
    cov.measured === 1 &&
    cov.coverage_pct === 50 &&
    cov.pass_rate_pct === 100 &&
    cov.by_verdict["Not-Run"] === 1,
  `got denominator=${cov.denominator} measured=${cov.measured} coverage=${cov.coverage_pct}% ` +
    `pass-rate=${cov.pass_rate_pct}%`,
);

// U6 — the DECLARED source level. Deliberately NOT a count: the earlier version
// asserted `length >= 5`, a FLOOR, which could never catch a count claim in prose
// drifting from the list — and one did, in this very file's header ("seven"),
// while that floor stayed green. It now asserts the SHAPE and the invariant that
// every declared authority is a repo-relative path, which is what a consumer
// actually relies on.
check(
  "U6 authorities-declared-and-well-formed",
  "AUTHORITIES",
  Array.isArray(G.AUTHORITIES) &&
    G.AUTHORITIES.length > 0 &&
    G.AUTHORITIES.every((a) => a.id && a.rel && !a.rel.startsWith("/") && !a.rel.includes("..")) &&
    new Set(G.AUTHORITIES.map((a) => a.id)).size === G.AUTHORITIES.length,
  `got ${Array.isArray(G.AUTHORITIES) ? G.AUTHORITIES.length : "non-array"} authorities; ` +
    "ids must be unique and every rel repo-relative",
);

// U7 — the freeze guard's own poles. "Run --freeze" is the obvious remediation
// for a red, so a freeze that silently re-pins a RISEN ceiling would let the fix
// instruction defeat the ratchet. An ABSENT prior ceiling must NOT read as a
// raise (or the first freeze is impossible), and a genuine rise MUST.
check(
  "U7 ceiling-raise-detection-bipolar",
  "detectCeilingRaise",
  G.detectCeilingRaise({ "Not-Run": 12, Blocked: 2 }, { "Not-Run": 11, Blocked: 2 }).length === 1 &&
    G.detectCeilingRaise({ "Not-Run": 12, Blocked: 2 }, { "Not-Run": 11, Blocked: 2 })[0].key ===
      "Not-Run" &&
    G.detectCeilingRaise({ "Not-Run": 11, Blocked: 2 }, { "Not-Run": 11, Blocked: 2 }).length === 0 &&
    G.detectCeilingRaise({ "Not-Run": 4, Blocked: 1 }, { "Not-Run": 11, Blocked: 2 }).length === 0 &&
    G.detectCeilingRaise({ "Not-Run": 12, Blocked: 3 }, { "Not-Run": 11, Blocked: 2 }).length === 2 &&
    G.detectCeilingRaise({ "Not-Run": 12 }, {}).length === 0 &&
    G.detectCeilingRaise({ "Not-Run": 12 }, null).length === 0,
  "a rise is detected and named; equal, FALLING, and absent-prior are all silent",
);

// U8 — the cite binding's poles, including the NO-CLAIM arm. Measured 2026-09-19,
// all ten line-bearing `cite:` values in dev-preflight's CHECKS table were wrong
// (offsets 2 to 366 lines), silently, because the field only surfaces on a
// failure. A cite that makes NO step claim must NOT be scored a failure, or the
// honest registry-field binding style becomes unusable.
check(
  "U8 cite-binding-bipolar",
  "resolveCiteBinding",
  G.resolveCiteBinding('wf.yml::step "Step A"', new Set(["Step A"])).ok === true &&
    G.resolveCiteBinding('wf.yml::step "Nope"', new Set(["Step A"])).ok === false &&
    G.resolveCiteBinding('wf.yml::step "Nope"', new Set(["Step A"])).step === "Nope" &&
    G.resolveCiteBinding("ci-suites.json::suites[mode=\"dedicated\"].step", new Set()) === null &&
    G.resolveCiteBinding(null, new Set()) === null &&
    G.resolveCiteBinding('wf.yml::step "Step A"', null).ok === false,
  "a resolvable binding accepts, an unresolvable one refuses BY NAME, a no-claim cite is null, " +
    "and an absent step-name set refuses rather than passing",
);

// U9 — THE REVERSE RATCHET TOOTH. A gate that VANISHES from the roster was
// invisible until 2026-09-19: the check only ever iterated records looking for
// unfrozen units, never the frozen set looking for absent ones — and a vanished
// gate LOWERS both ceilings, a direction the raise-guard and
// check-ratchet-monotonicity both read as improvement. So deleting a workflow
// step reported CLEAN with a better-looking number. Bipolar: a present roster
// must stay silent, or the tooth fires on every healthy run.
check(
  "U9 vanished-gate-bipolar",
  "ratchet/gate-vanished",
  (() => {
    const recs = [{ unit_id: "a", verdict: "Pass", evidence: {} }];
    const vanished = G.ratchet(recs, { frozen_units: ["a", "b"], ceilings: {} }).findings;
    const intact = G.ratchet(recs, { frozen_units: ["a"], ceilings: {} }).findings;
    const named = vanished.find((f) => f.rule_id === "cw-gate/gate-vanished");
    return Boolean(named) && named.unit_id === "b" && intact.length === 0;
  })(),
  "a frozen gate absent from the records must red BY NAME; an intact roster must stay silent",
);

// U10 — THE MODE-AWARE REACH POPULATION. `suite-self` reach was mode-BLIND and
// scored four `mode: "dedicated"` bin suites as reached when no preflight check
// executed that population, under-counting the frozen ceiling by four in the one
// direction that can never correct it. The population key is
// `<registry-basename>|<mode>`, derived from each check's ARGV.
check(
  "U10 preflight-population-derivation",
  "derivePreflightPopulations",
  (() => {
    const P = G.derivePreflightPopulations;
    // bulk of the DEFAULT registry when neither flag is present
    const a = P([{ id: "x", argv: [".claude/bin/run-harness-suites.mjs", "--json"] }], "ci-suites.json");
    // dedicated of the DEFAULT registry: --dedicated-only WITHOUT --registry
    const b = P(
      [{ id: "x", argv: [".claude/bin/run-harness-suites.mjs", "--dedicated-only", "--json"] }],
      "ci-suites.json",
    );
    // bulk of an EXPLICIT registry: --registry WITHOUT --dedicated-only
    const c = P(
      [
        {
          id: "x",
          argv: [
            ".claude/bin/run-harness-suites.mjs",
            "--registry",
            ".claude/test-harness/ci-suites-bin.json",
            "--json",
          ],
        },
      ],
      "ci-suites.json",
    );
    // a check that dispatches a DIFFERENT tool contributes no population
    const d = P([{ id: "x", argv: [".claude/bin/validate-emit.mjs"] }], "ci-suites.json");
    return (
      a.has("ci-suites.json|bulk") &&
      !a.has("ci-suites.json|dedicated") &&
      b.has("ci-suites.json|dedicated") &&
      !b.has("ci-suites.json|bulk") &&
      c.has("ci-suites-bin.json|bulk") &&
      !c.has("ci-suites-bin.json|dedicated") &&
      d.size === 0
    );
  })(),
  "each flag combination selects exactly its own (registry, mode) population, and a " +
    "non-runner check selects none",
);

// U11 — reach is MODE-AWARE end to end, and `excluded` is never coverage. The
// file used to accept an excluded suite as reach in one channel while REFUSING
// it as coverage in the declared-gap channel, which made it contradict itself.
check(
  "U11 suite-self-reach-mode-aware",
  "deriveReach",
  (() => {
    const suites = [
      { registry: "ci-suites-bin.json", name: "ded.test.mjs", mode: "dedicated" },
      { registry: "ci-suites-bin.json", name: "bulk.test.mjs", mode: "bulk" },
      { registry: "ci-suites-bin.json", name: "excl.test.mjs", mode: "excluded" },
    ];
    const pops = new Set(["ci-suites-bin.json|bulk"]);
    const r = G.deriveReach({ suites, populations: pops });
    const none = G.deriveReach({ suites, populations: new Set() });
    return (
      r.has("bulk.test.mjs") &&
      !r.has("ded.test.mjs") &&
      !r.has("excl.test.mjs") &&
      none.size === 0
    );
  })(),
  "only a suite whose (registry, mode) population the preflight runs counts; dedicated " +
    "outside a run population and excluded never do",
);

// U12 — THE GIT-HOOK TRIGGER BLIND CLASS, bipolar on the axis that decides it.
// The repo's highest-consequence gate — `.git/hooks/pre-push`, whose own line 16
// says "dev has no CI; this guard is the only check that exists" — ships its
// DELEGATE (tracked, rc=0) and not its TRIGGER (rc=1, control rc=0). The location
// is what decides deliverability, not anyone's diligence: a hooks dir inside the
// git dir carries nothing any commit can deliver, while a worktree path can.
check(
  "U12 hook-trigger-location-bipolar",
  "classifyHookTriggerLocation",
  (() => {
    const C = G.classifyHookTriggerLocation;
    const inside = C({ gitCommonDir: "/r/.git", entries: ["pre-push"] });
    const worktree = C({ gitCommonDir: "/r/.git", hooksPath: "/r/.githooks", entries: ["pre-push"] });
    const noEntries = C({ gitCommonDir: "/r/.git" });
    const noGit = C({});
    return (
      inside.inside_git_dir === true &&
      inside.deliverable_by_clone === false &&
      inside.status === "MEASURED" &&
      inside.triggers_present === 1 &&
      worktree.inside_git_dir === false &&
      worktree.deliverable_by_clone === true &&
      noEntries.status === "UNKNOWN" &&
      noGit.status === "UNKNOWN"
    );
  })(),
  "a git-dir hooks path is undeliverable, a worktree hooks path is deliverable, and an " +
    "unreadable dir or unresolvable git dir reports UNKNOWN rather than either verdict",
);

// U13 — the blind class is DISCLOSED, never counted. If it ever enters the
// denominator the roster becomes clone-dependent and the fail-closed refusal
// fires on a fresh checkout, which is the expected state in CI.
check(
  "U13 blind-class-outside-the-denominator",
  "resolveGitDirs + disclosure",
  (() => {
    const io = {
      existsSync: (p) => p.endsWith(".git") || p.endsWith("config"),
      statSync: () => ({ isDirectory: () => false }),
      readFileSync: (p) =>
        p.endsWith("config") ? "[core]\n\thooksPath = /r/.githooks\n" : "gitdir: /r/.git/worktrees/w\n",
    };
    const r = G.resolveGitDirs("/r", io);
    // the COMMON dir is two levels above a linked worktree's gitdir, which is why
    // a sibling worktree is governed by the same hooks file
    const okCommon = r.gitCommonDir === "/r/.git";
    const okHooks = r.hooksPath === "/r/.githooks";
    const absent = G.resolveGitDirs("/r", { existsSync: () => false, statSync: () => {}, readFileSync: () => "" });
    return okCommon && okHooks && absent.gitCommonDir === null;
  })(),
  "a linked worktree resolves to the COMMON dir and honours a configured hooksPath; an " +
    "absent .git resolves to null rather than guessing",
);

// U12 — THE ci-gate POPULATION'S LINE EXTRACTOR. MEASURED 2026-10-03: a workflow
// COMMENT naming a tool (`coc-artifact-eval.yml:2685`, a citation target quoting
// `.claude/bin/ci-parity.mjs:388`) minted a phantom ci-gate unit, which red the
// reach lens as Not-Run and tripped coverage-regression against a ceiling of 0 —
// a gate that does not run in CI, with a fix instruction that would have built a
// preflight channel for it. The poles separate on ONE fact: whether the line
// EXECUTES the tool. Bipolar, and the mixed arm pins the deliberate divergence
// from `ciArgSignaturesOfLine`'s anywhere-echo guard (a denominator must not
// silently drop a real gate).
check(
  "U12 ci-tool-line-extraction-bipolar",
  "ciToolSitesOfLine",
  G.ciToolSitesOfLine("        run: node .claude/bin/alpha.mjs --check").join(",") === "alpha.mjs" &&
    G.ciToolSitesOfLine("      # docket and `.claude/bin/ci-parity.mjs:388` all quote").length === 0 &&
    G.ciToolSitesOfLine("        echo run node .claude/bin/beta.mjs to reproduce").length === 0 &&
    G.ciToolSitesOfLine("").length === 0 &&
    G.ciToolSitesOfLine(null).length === 0 &&
    G.ciToolSitesOfLine('        run: node .claude/bin/alpha.mjs && echo "node .claude/bin/beta.mjs"')
      .join(",") === "alpha.mjs,beta.mjs",
  "a real run line names its tool(s); a comment or echo-ONLY line names none; empty/null is " +
    "silent; a MIXED line keeps every token (never silently drop a real gate)",
);

// ── verdict ──────────────────────────────────────────────────────────────────

console.log("");
if (failures.length) {
  console.log(`RED SET (${failures.length}) — case :: predicate :: identity mismatch:`);
  for (const f of failures) console.log(`  - ${f.name} :: ${f.predicate} :: ${f.detail}`);
  console.log(`\n${pass} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`${pass} passed, 0 failed — ${fixtures.length} fixtures + 13 unit cases`);
process.exit(0);
