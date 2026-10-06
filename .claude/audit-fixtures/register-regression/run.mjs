#!/usr/bin/env node
/**
 * register-regression — fixtures for `register-regression-guard.js` (PreToolUse)
 * and its predicate seam `hooks/lib/register-regression.js`.
 *
 * BIPOLAR PER PREDICATE. Every guard here has a pole that MUST fire and a pole
 * that MUST stay silent, because a guard shown only to fire has proved it can say
 * "no" and nothing else:
 *
 *   A-2  demotion with NO rebuttal        → fires `block`   | with an observation → silent
 *   A-1  demotion with an ABSENCE rebuttal → fires h-a-r     | with an observation → silent
 *        ...and NEVER escalates to block: the verdict reads the rebuttal's WORDS.
 *   B-0  transition INTO owed, no ask_ref  → fires h-a-r     | pre-existing owed row → silent
 *   B-1  ask_ref names a missing artifact  → fires h-a-r     | it resolves          → silent
 *   B-2  ask_ref declares itself superseded→ fires h-a-r     | live artifact        → silent
 *
 * THE MEASURED FALSE POSITIVE HAS ITS OWN SECTION, and it is the reason the scope
 * exclusion exists at all: guarding retired rows once REFUSED AN OWNER WHO WAS
 * REINSTATING A RETIRED ASK. That owner was right and the guard was wrong. The
 * reinstatement pole below is not decoration — deleting the `isSupersededRow`
 * exclusion must turn it RED, and that is asserted by mutation in-suite.
 *
 * NOT MOCKED. The hook is spawned as a REAL subprocess over REAL stdin payloads
 * against REAL temporary git repositories with REAL commits, so a case cannot pass
 * against a hook the harness would not actually run. The `git` dependency is the
 * point: the baseline this guard compares against is the COMMITTED record.
 */
import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const HOOKS = path.join(REPO_ROOT, ".claude", "hooks");
const GUARD = path.join(HOOKS, "register-regression-guard.js");
const LIB = path.join(HOOKS, "lib", "register-regression.js");
const lib = require(LIB);

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

const MANIFEST = {
  _schema: "burndown-manifest/v1",
  target: "BURNDOWN.md",
  pages: ["Alpha", "Beta"],
  sources: [{ path: "burndown/register.json", kind: "register", precedence: 0 }],
};

function register(items) {
  return {
    _note: "fixture",
    _generated: "2026-08-01",
    _authority: "owner",
    _id_convention: "R-NN",
    items,
  };
}

/**
 * A repo whose COMMITTED register carries `items`. `withManifest:false` gives a
 * repo with no tracker-source convention — the scoping pole.
 */
function mkRepo(items, { withManifest = true, extraFiles = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reg-reg-"));
  fs.mkdirSync(path.join(dir, "burndown"), { recursive: true });
  fs.writeFileSync(path.join(dir, "burndown", "register.json"), JSON.stringify(register(items), null, 2));
  if (withManifest) {
    fs.writeFileSync(path.join(dir, "burndown-manifest.json"), JSON.stringify(MANIFEST, null, 2));
  }
  fs.writeFileSync(path.join(dir, "BURNDOWN.md"), "# Burndown\n");
  for (const [rel, body] of Object.entries(extraFiles)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  gitInitCommit(dir);
  return dir;
}

/**
 * ONE spawn, not five.
 *
 * Every case here needs a real committed HEAD (the guard's whole baseline), and
 * the naive form paid `init` + 2×`config` + `add` + `commit` as five separate
 * processes per case. Measured across the suite that was the dominant cost, and
 * this runner had become ~a third of the aggregate audit-fixture step's wall
 * clock. `-c` supplies identity inline so the config calls vanish, and `&&`
 * chaining collapses the rest into a single `sh`.
 *
 * The repos stay REAL — this is a spawn-count optimisation, not a move to a
 * mocked git. If any step fails the chain exits non-zero and `execFileSync`
 * throws, so a broken fixture repo still surfaces as a failure rather than as a
 * silently empty HEAD.
 */
function gitInitCommit(dir) {
  execFileSync(
    "sh",
    [
      "-c",
      'git init -q && git -c user.email=f@x.invalid -c user.name=f add -A && ' +
        'git -c user.email=f@x.invalid -c user.name=f commit -q -m fx',
    ],
    { cwd: dir, stdio: "ignore" },
  );
}

function runHook(dir, payload) {
  const r = spawnSync("node", [GUARD], {
    cwd: dir,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    timeout: 15000,
  });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

/** The PreToolUse payload for a `Write` of `items` over the declared register. */
function writePayload(dir, items) {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: {
      file_path: path.join(dir, "burndown", "register.json"),
      content: JSON.stringify(register(items), null, 2),
    },
  };
}

/** A hook "fired" iff it emitted a finding rather than a bare passthrough. */
function fired(res) {
  return /state-regression-integrity|DELIVERY CLAIM RETRACTED|OWED ROW WITH NO LIVE ASK/.test(res.out + res.err);
}
function blocked(res) {
  return res.code === 2 || /"continue"\s*:\s*false/.test(res.out);
}

const SIGNED = (extra = {}) => ({ id: "R1", page: "Alpha", status: "Signed off", ...extra });
const DEMOTED = (extra = {}) => ({ id: "R1", page: "Alpha", status: "In progress", ...extra });

// ── A-2 · demotion with NO rebuttal → block (STRUCTURAL) ────────────────────

check("A-2 FIRES at severity block on Signed off → In progress with no rebuttal", () => {
  const d = mkRepo([SIGNED()]);
  const res = runHook(d, writePayload(d, [DEMOTED()]));
  if (!fired(res)) return `did not fire. out=${(res.out + res.err).slice(0, 400)}`;
  return blocked(res) ? true : `fired but did not BLOCK (code=${res.code})`;
});

check("A-2 FIRES on the originating shape: Signed off → Built-not-walked", () => {
  const d = mkRepo([SIGNED()]);
  const res = runHook(d, writePayload(d, [{ id: "R1", page: "Alpha", status: "Built-not-walked" }]));
  return fired(res) && blocked(res) ? true : `did not block. code=${res.code}`;
});

check("A-2 FIRES on Built-not-walked → Not started (the lower delivered bucket)", () => {
  const d = mkRepo([{ id: "R1", page: "Alpha", status: "Built-not-walked" }]);
  const res = runHook(d, writePayload(d, [{ id: "R1", page: "Alpha", status: "Not started" }]));
  return fired(res) && blocked(res) ? true : `did not block. code=${res.code}`;
});

check("A-2 FIRES on Signed off → Blocked on you (retracting a delivery claim)", () => {
  const d = mkRepo([SIGNED()]);
  const res = runHook(d, writePayload(d, [{ id: "R1", page: "Alpha", status: "Blocked on you" }]));
  return fired(res) && blocked(res) ? true : `did not block. code=${res.code}`;
});

check("A-2 SILENT when the demotion carries an OBSERVATION rebuttal", () => {
  const d = mkRepo([SIGNED()]);
  const res = runHook(
    d,
    writePayload(d, [
      DEMOTED({
        regression_rebuttal:
          "Walked /reports on staging 2026-08-20: the page returns HTTP 502 and the nav entry is gone. Capture in journal/0590.",
      }),
    ]),
  );
  return !fired(res) ? true : `fired on a real observation: ${(res.out + res.err).slice(0, 400)}`;
});

// ── A-2 · the NO-FALSE-POSITIVE poles ───────────────────────────────────────

check("SILENT on a PROMOTION (In progress → Signed off)", () => {
  const d = mkRepo([DEMOTED()]);
  const res = runHook(d, writePayload(d, [SIGNED()]));
  return !fired(res) ? true : "fired on a promotion";
});

check("SILENT on a demotion that never entered a delivered bucket (In progress → Not started)", () => {
  const d = mkRepo([DEMOTED()]);
  const res = runHook(d, writePayload(d, [{ id: "R1", page: "Alpha", status: "Not started" }]));
  return !fired(res) ? true : "fired on a non-delivered demotion";
});

check("SILENT on an unchanged row", () => {
  const d = mkRepo([SIGNED()]);
  const res = runHook(d, writePayload(d, [SIGNED()]));
  return !fired(res) ? true : "fired on a no-op write";
});

check("SILENT on a BRAND-NEW row (no recorded status to contradict)", () => {
  const d = mkRepo([SIGNED()]);
  const res = runHook(d, writePayload(d, [SIGNED(), { id: "R9", page: "Beta", status: "Not started" }]));
  return !fired(res) ? true : "fired on a newly added row";
});

check("SURFACE REWRITE cannot evade the ladder: 'Signed off' → 'signed-off' is not a demotion", () => {
  const d = mkRepo([SIGNED()]);
  const res = runHook(d, writePayload(d, [{ id: "R1", page: "Alpha", status: "signed-off" }]));
  return !fired(res) ? true : "treated a case/hyphen rewrite as a demotion";
});

check("SURFACE REWRITE cannot evade the ladder: 'SIGNED OFF' still ranks as delivered", () => {
  const d = mkRepo([{ id: "R1", page: "Alpha", status: "SIGNED OFF" }]);
  const res = runHook(d, writePayload(d, [DEMOTED()]));
  return fired(res) && blocked(res) ? true : `a rewritten delivered status dodged the guard (code=${res.code})`;
});

// SUPERSEDES an earlier assertion that this case was SILENT. It was, and that was
// the bug: a status the ladder cannot read was step 1 of the invisible-character
// chain (park the row on an unreadable status, commit, demote from a rank the
// guard can no longer see). It now SURFACES at halt-and-report — not `block`,
// because the generator owns the refusal and will exit 2 on this source.
check("A-5 SURFACES an out-of-vocabulary status at halt-and-report, never silently", () => {
  const d = mkRepo([{ id: "R1", page: "Alpha", status: "Wibble" }]);
  const res = runHook(d, writePayload(d, [DEMOTED()]));
  if (!fired(res)) return "an unreadable status was skipped silently — the ladder-parking chain is open";
  return !blocked(res) ? true : "A-5 rendered as BLOCK; the generator owns that refusal";
});

// ── A-1 · the ABSENCE corpus, VERBATIM from the originating incidents ───────

const ABSENCE_CORPUS = [
  "this session did not verify it",
  "no lane walked it",
  "I could not confirm it",
  "nobody has walked it",
  "built, not walked",
  "merged is not rendered",
];

for (const phrase of ABSENCE_CORPUS) {
  check(`A-1 REJECTS the absence rebuttal ${JSON.stringify(phrase)}`, () => {
    const d = mkRepo([SIGNED()]);
    const res = runHook(d, writePayload(d, [DEMOTED({ regression_rebuttal: phrase })]));
    return fired(res) ? true : `accepted an ABSENCE as a rebuttal. out=${(res.out + res.err).slice(0, 300)}`;
  });

  check(`A-1 stays at halt-and-report (never block) for ${JSON.stringify(phrase)}`, () => {
    const d = mkRepo([SIGNED()]);
    const res = runHook(d, writePayload(d, [DEMOTED({ regression_rebuttal: phrase })]));
    if (!fired(res)) return "did not fire at all";
    // The verdict read the rebuttal's WORDS. hook-output-discipline MUST-2 caps a
    // lexical finding below `block`; escalating here would be the downgrade-proof
    // running in reverse.
    return !blocked(res) ? true : "a LEXICAL verdict rendered as BLOCK — MUST-2 forbids this";
  });
}

check("A-1 REJECTS an empty-string rebuttal as MISSING (structural, so block)", () => {
  const d = mkRepo([SIGNED()]);
  const res = runHook(d, writePayload(d, [DEMOTED({ regression_rebuttal: "   " })]));
  return fired(res) && blocked(res) ? true : `an empty rebuttal was accepted (code=${res.code})`;
});

check("A-1 REJECTS a non-string rebuttal as MISSING", () => {
  const d = mkRepo([SIGNED()]);
  const res = runHook(d, writePayload(d, [DEMOTED({ regression_rebuttal: true })]));
  return fired(res) && blocked(res) ? true : "a boolean rebuttal was accepted";
});

// ── A-1 · OBSERVATIONS that MUST pass (the noise floor) ─────────────────────
//
// These are the cases that decide whether the lexical arm is a guard or a
// nuisance. Each names something SEEN. If any of them reds, the patterns have
// widened from "absence" into "any sentence containing a negation".

const OBSERVATIONS = [
  "Opened the deployed page 2026-08-20 — it 404s; the route was removed in a8e737a.",
  "The signed-off build never ran the migration: `SELECT count(*) FROM audit` returns 0 rows.",
  "Owner walked it on 2026-08-19 and rejected the layout; see workspaces/x/04-validate/notes.md.",
  "The endpoint returns 500 with 'column does not exist' — captured in the run log.",
  "Re-ran the acceptance script: 3 of 7 assertions fail, transcript attached.",
];

for (const [i, obs] of OBSERVATIONS.entries()) {
  check(`A-1 SILENT on observation #${i + 1} (no-false-positive floor)`, () => {
    const d = mkRepo([SIGNED()]);
    const res = runHook(d, writePayload(d, [DEMOTED({ regression_rebuttal: obs })]));
    return !fired(res) ? true : `fired on an OBSERVATION: ${(res.out + res.err).slice(0, 300)}`;
  });
}

// ── THE MEASURED FALSE POSITIVE · reinstatement of a retired ask ────────────

check("REINSTATEMENT is NOT refused — a superseded row demoted out of a delivered bucket", () => {
  const d = mkRepo([SIGNED({ superseded_by: "R7" })]);
  // The owner brings a retired ask back. It still carried a delivered status from
  // before it was retired, so this is SHAPED exactly like a demotion.
  const res = runHook(d, writePayload(d, [{ id: "R1", page: "Alpha", status: "Not started" }]));
  return !fired(res)
    ? true
    : `REFUSED AN OWNER REINSTATING A RETIRED ASK — the measured false positive. out=${(res.out + res.err).slice(0, 400)}`;
});

for (const field of ["superseded", "retired", "withdrawn", "internal"]) {
  check(`REINSTATEMENT pole holds for the '${field}' marker`, () => {
    const d = mkRepo([SIGNED({ [field]: true })]);
    const res = runHook(d, writePayload(d, [{ id: "R1", page: "Alpha", status: "Not started" }]));
    return !fired(res) ? true : `refused a reinstatement marked with '${field}'`;
  });
}

check("the exclusion is SCOPED: a NON-superseded row in the same file still fires", () => {
  const d = mkRepo([SIGNED({ superseded_by: "R7" }), { id: "R2", page: "Beta", status: "Signed off" }]);
  const res = runHook(
    d,
    writePayload(d, [
      { id: "R1", page: "Alpha", status: "Not started" },
      { id: "R2", page: "Beta", status: "In progress" },
    ]),
  );
  if (!fired(res)) return "the exclusion swallowed a guarded row alongside a retired one";
  return /R2/.test(res.out + res.err) ? true : "fired but did not name the guarded row R2";
});

// MUTATION PROOF — the reinstatement pole is load-bearing, not decorative.
//
// AN EARLIER VERSION OF THIS CASE WAS A SELF-DERIVED ORACLE and is recorded here
// because the failure is instructive. It RE-IMPLEMENTED the predicate inline
// (`reachedDelivered && wouldDemote && classify(...) !== "observation"`) and
// asserted the re-implementation fired — never mutating `guardA` at all. It would
// have stayed green if a second, unrelated exclusion also suppressed the row, so
// it could not discriminate the thing its name claimed (`evidence-first-claims.md`
// MUST-5). It now mutates the REAL source and re-evaluates it.
function withMutatedLib(find, replace, fn) {
  const src = fs.readFileSync(LIB, "utf8");
  if (!src.includes(find)) throw new Error(`mutation target absent — the mutation would be INERT: ${find}`);
  const mutatedSrc = src.replace(find, replace);
  const mod = { exports: {} };
  // `require` must be scoped to the LIB's own directory, not this fixture's: the
  // lib resolves siblings like `./git-subprocess-env` relatively, and handing it
  // this file's require throws MODULE_NOT_FOUND — which the harness would report
  // as a mutation FAILURE when nothing about the predicate had changed.
  new Function("module", "exports", "require", "__dirname", mutatedSrc)(
    mod,
    mod.exports,
    createRequire(LIB),
    path.dirname(LIB),
  );
  return fn(mod.exports);
}

check("MUTATION: deleting the isSupersededRow exclusion turns the reinstatement pole RED", () => {
  const oldReg = JSON.stringify(register([SIGNED({ superseded_by: "R7" })]));
  const newReg = JSON.stringify(register([{ id: "R1", page: "Alpha", status: "Not started" }]));

  const live = lib.guardA(lib.parseRegister(oldReg), lib.parseRegister(newReg));
  if (live.length !== 0) return "the UNMUTATED predicate already fires — the pole is red before mutation";

  // The REAL mutation: delete the exclusion line from the source and re-evaluate.
  const mutated = withMutatedLib("    if (wasSuperseded) continue;", "    // MUTATED", (m) =>
    m.guardA(m.parseRegister(oldReg), m.parseRegister(newReg)),
  );
  if (mutated.length === 0) {
    return "WITHOUT the exclusion the case STILL does not fire — the pole is not testing the exclusion";
  }
  // Reachability control: the mutation must be inert OFF-target, or it is not
  // isolating the exclusion.
  const offTarget = withMutatedLib("    if (wasSuperseded) continue;", "    // MUTATED", (m) =>
    m.guardA(m.parseRegister(JSON.stringify(register([SIGNED()]))), m.parseRegister(newReg)),
  );
  return offTarget.length === 1 ? true : `mutation changed an off-target case too (${offTarget.length} findings)`;
});

// ── REVIEW ROUND 2 · false positives on the `block` arm ────────────────────
//
// The costliest direction: a `block` that refuses correct work gets the guard
// disabled. Each of these was MEASURED firing before the fix.

check("FP/C-1 a declared RENUMBER via `_renamed` is not read as a demotion or a removal", () => {
  const d = mkRepo([SIGNED(), { id: "R3", page: "Alpha", status: "In progress" }]);
  const p = writePayload(d, [SIGNED(), { id: "R2", page: "Alpha", status: "In progress" }]);
  const doc = JSON.parse(p.tool_input.content);
  doc._renamed = { R2: "R3" };
  p.tool_input.content = JSON.stringify(doc, null, 2);
  const res = runHook(d, p);
  return !fired(res) ? true : `refused a declared renumber: ${(res.out + res.err).slice(0, 300)}`;
});

check("FP/C-1 control: an UNDECLARED rename of a delivered row still fires", () => {
  const d = mkRepo([SIGNED()]);
  const res = runHook(d, writePayload(d, [{ id: "R1-new", page: "Alpha", status: "Signed off" }]));
  return fired(res) ? true : "the _renamed escape swallowed an undeclared rename";
});

for (const terse of ["HTTP 502 at /reports", "Query returns 0 rows.", "Build fails: exit 127"]) {
  check(`FP/C-2 the terse observation ${JSON.stringify(terse)} is NOT blocked`, () => {
    return lib.classifyRebuttal(terse).kind === "observation"
      ? true
      : `a genuine observation was rejected as ${lib.classifyRebuttal(terse).kind}`;
  });
}

check("FP/C-3 tagging a delivered row `internal` is NOT a retraction", () => {
  const d = mkRepo([SIGNED()]);
  const res = runHook(d, writePayload(d, [SIGNED({ internal: true })]));
  return !fired(res) ? true : "blocked an operator marking a delivered row unreportable";
});

check("FP/C-3 control: `superseded_by` on a delivered row IS still a retraction", () => {
  const d = mkRepo([SIGNED()]);
  const res = runHook(d, writePayload(d, [SIGNED({ superseded_by: "R9" })]));
  return fired(res) ? true : "the internal carve-out swallowed a real retirement";
});

// I-1 · the absence corpus fired on observations ABOUT THE SYSTEM. 8 of 8.
for (const obs of [
  "The upload path does not check the MIME type — I uploaded a .exe on 2026-08-19, accepted (HTTP 201).",
  "The form is not validated on submit: posted an empty payload, got 200 and an empty DB row.",
  "The endpoint never validates the bearer token — sent a garbage JWT, got 200.",
  "Users cannot find the export button: removed from the nav in a8e737a.",
  "Login returns 401 and no session cookie is set — captured in the run log.",
  "There is no record of the export in the audit table — I queried it 2026-08-20.",
  "The suite has no tests for the export path; coverage report attached, 0% on exporter.py.",
  "Owner reviewed it 2026-08-19; the acceptance checklist was not reviewed for page 3.",
]) {
  check(`FP/I-1 system-subject observation passes: ${JSON.stringify(obs.slice(0, 38))}…`, () => {
    const k = lib.classifyRebuttal(obs);
    return k.kind === "observation" ? true : `rejected as ${k.kind} via [${k.matched}]`;
  });
}

check("FP/I-1 control: the six verbatim absences STILL classify as absences", () => {
  for (const a of ABSENCE_CORPUS) {
    if (lib.classifyRebuttal(a).kind !== "absence") return `the subject anchor lost a verbatim phrase: ${a}`;
  }
  return true;
});

// I-2 · A-5 fired on untouched rows forever.
check("FP/I-2 A-5 does NOT fire on an UNTOUCHED out-of-vocabulary row", () => {
  const legacy = { id: "R9", page: "Beta", status: "Signed off (pending walk)" };
  const d = mkRepo([legacy, { id: "R2", page: "Alpha", status: "Not started" }]);
  const res = runHook(d, writePayload(d, [legacy, { id: "R2", page: "Alpha", status: "In progress" }]));
  return !fired(res) ? true : `halted on a pre-existing legacy status: ${(res.out + res.err).slice(0, 250)}`;
});

// I-3 · B-1 graded references that were never filesystem questions.
for (const ref of ["example-org/loom#1856", "see asks/live.md (owner reply pending)", "asks/live.md#L20"]) {
  check(`FP/I-3 B-1 does NOT grade the reference ${JSON.stringify(ref)}`, () => {
    const d = mkRepo([{ id: "R1", page: "Alpha", status: "Blocked on you", ask_ref: ref }], {
      extraFiles: { "asks/live.md": "# Confirm the FY26 rate\n\nStill open.\n" },
    });
    const res = runHook(d, writePayload(d, [{ id: "R1", page: "Alpha", status: "Blocked on you", ask_ref: ref }]));
    return !fired(res) ? true : `graded a non-path/anchored reference: ${(res.out + res.err).slice(0, 250)}`;
  });
}

// I-4 · a line-initial marker MODIFYING A NOUN is not a banner.
check("FP/I-4 'Deprecated fields: please confirm…' is a LIVE ask, not a supersession banner", () => {
  const live = "Deprecated fields: please confirm which of these we can drop.\n";
  return lib.declaresSuperseded(live) === null
    ? true
    : `a live ask was read as superseded ("${lib.declaresSuperseded(live)}")`;
});

check("FP/I-4 control: a real banner in the same position still fires", () => {
  return lib.declaresSuperseded("RETIRED — superseded by asks/final.md\n") !== null &&
    lib.declaresSuperseded("SUPERSEDED BY asks/final.md\n") !== null
    ? true
    : "the noun-modifier fix swallowed a genuine banner";
});

// I-5 · the non-block head told the agent its write had already run.
check("FP/I-5 a non-block finding renders the PRE-ACTION head, not 'ALREADY RAN'", () => {
  const d = mkRepo([{ id: "R1", page: "Alpha", status: "In progress" }]);
  const res = runHook(d, writePayload(d, [{ id: "R1", page: "Alpha", status: "Blocked on you" }]));
  if (!fired(res)) return "did not fire at all";
  const blob = res.out + res.err;
  if (/ALREADY RAN/.test(blob)) return "PreToolUse finding claims the write already ran (loom#1715 H-1)";
  return /has NOT run yet/.test(blob) ? true : `neither head present: ${blob.slice(0, 200)}`;
});

// I-6 · `git show HEAD:<rel>` resolves against the worktree TOP, not cwd.
check("FP/I-6 the HEAD lookup works when the project dir is NOT the git root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reg-nested-"));
  const proj = path.join(root, "proj");
  fs.mkdirSync(path.join(proj, "burndown"), { recursive: true });
  fs.writeFileSync(path.join(proj, "burndown", "register.json"), JSON.stringify(register([SIGNED()]), null, 2));
  fs.writeFileSync(path.join(proj, "burndown-manifest.json"), JSON.stringify(MANIFEST, null, 2));
  fs.writeFileSync(path.join(proj, "BURNDOWN.md"), "# B\n");
  gitInitCommit(root);
  const res = runHook(proj, {
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: {
      file_path: path.join(proj, "burndown", "register.json"),
      content: JSON.stringify(register([DEMOTED()]), null, 2),
    },
  });
  if (/UNKNOWN, not clean/.test(res.out)) return "degraded to permanent UNKNOWN in a nested project dir";
  return fired(res) ? true : `did not fire in a nested project dir: ${(res.out + res.err).slice(0, 200)}`;
});

// ── B-0 · a row handed back to the owner must name its ask ─────────────────

check("B-0 FIRES when a row TRANSITIONS into Blocked on you with no ask_ref", () => {
  const d = mkRepo([DEMOTED()]);
  const res = runHook(d, writePayload(d, [{ id: "R1", page: "Alpha", status: "Blocked on you" }]));
  if (!fired(res)) return `did not fire. out=${(res.out + res.err).slice(0, 300)}`;
  return !blocked(res) ? true : "B-0 rendered as BLOCK — it is lexical/contingent and is capped at halt-and-report";
});

check("B-0 SILENT on a PRE-EXISTING owed row with no ask_ref (does not cry wolf on a legacy corpus)", () => {
  const d = mkRepo([{ id: "R1", page: "Alpha", status: "Blocked on you" }, { id: "R2", page: "Beta", status: "Not started" }]);
  const res = runHook(
    d,
    writePayload(d, [
      { id: "R1", page: "Alpha", status: "Blocked on you" },
      { id: "R2", page: "Beta", status: "In progress" },
    ]),
  );
  return !fired(res) ? true : `re-litigated a pre-existing owed row: ${(res.out + res.err).slice(0, 300)}`;
});

// ── B-1 · the ask must EXIST ───────────────────────────────────────────────

check("B-1 FIRES when an owed row's ask_ref names an artifact that does not exist", () => {
  const d = mkRepo([{ id: "R1", page: "Alpha", status: "Blocked on you", ask_ref: "asks/gone.md" }]);
  const res = runHook(
    d,
    writePayload(d, [{ id: "R1", page: "Alpha", status: "Blocked on you", ask_ref: "asks/gone.md" }]),
  );
  return fired(res) && !blocked(res) ? true : `did not fire at halt-and-report (code=${res.code})`;
});

check("B-1 SILENT when the ask_ref resolves to a live artifact", () => {
  const d = mkRepo([{ id: "R1", page: "Alpha", status: "Blocked on you", ask_ref: "asks/live.md" }], {
    extraFiles: { "asks/live.md": "# Please confirm the tax rate for FY26\n" },
  });
  const res = runHook(
    d,
    writePayload(d, [{ id: "R1", page: "Alpha", status: "Blocked on you", ask_ref: "asks/live.md" }]),
  );
  return !fired(res) ? true : `fired on a live ask: ${(res.out + res.err).slice(0, 300)}`;
});

check("B-1 SILENT on a NON-PATH reference (an issue number is not a filesystem question)", () => {
  const d = mkRepo([{ id: "R1", page: "Alpha", status: "Blocked on you", ask_ref: "#1856" }]);
  const res = runHook(d, writePayload(d, [{ id: "R1", page: "Alpha", status: "Blocked on you", ask_ref: "#1856" }]));
  return !fired(res) ? true : "graded an issue number as a missing file";
});

check("B-1 SILENT on a URL reference", () => {
  const d = mkRepo([{ id: "R1", page: "Alpha", status: "Blocked on you", ask_ref: "https://example.invalid/ask" }]);
  const res = runHook(
    d,
    writePayload(d, [{ id: "R1", page: "Alpha", status: "Blocked on you", ask_ref: "https://example.invalid/ask" }]),
  );
  return !fired(res) ? true : "graded a URL as a missing file";
});

// ── B-2 · the ask must not declare itself SUPERSEDED ───────────────────────

check("B-2 FIRES when the ask_ref target declares itself superseded", () => {
  const d = mkRepo([{ id: "R1", page: "Alpha", status: "Blocked on you", ask_ref: "asks/draft.md" }], {
    extraFiles: { "asks/draft.md": "# SUPERSEDED by asks/final.md\n\nDo not use this draft.\n" },
  });
  const res = runHook(
    d,
    writePayload(d, [{ id: "R1", page: "Alpha", status: "Blocked on you", ask_ref: "asks/draft.md" }]),
  );
  if (!fired(res)) return `did not fire. out=${(res.out + res.err).slice(0, 300)}`;
  return !blocked(res) ? true : "B-2 rendered as BLOCK — a text-marker verdict is lexical";
});

check("B-2 SILENT when the target carries no supersession marker", () => {
  const d = mkRepo([{ id: "R1", page: "Alpha", status: "Blocked on you", ask_ref: "asks/final.md" }], {
    extraFiles: { "asks/final.md": "# Confirm the FY26 rate\n\nStill open.\n" },
  });
  const res = runHook(
    d,
    writePayload(d, [{ id: "R1", page: "Alpha", status: "Blocked on you", ask_ref: "asks/final.md" }]),
  );
  return !fired(res) ? true : "fired on a live ask document";
});

check("B-2 marker detection is HEAD-SCOPED — a document merely DISCUSSING supersession is not superseded", () => {
  const body = "# Confirm the FY26 rate\n\nStill open.\n" + "filler\n".repeat(900) + "\nNote: the old draft was superseded.\n";
  const d = mkRepo([{ id: "R1", page: "Alpha", status: "Blocked on you", ask_ref: "asks/long.md" }], {
    extraFiles: { "asks/long.md": body },
  });
  const res = runHook(
    d,
    writePayload(d, [{ id: "R1", page: "Alpha", status: "Blocked on you", ask_ref: "asks/long.md" }]),
  );
  return !fired(res) ? true : "a passing mention deep in the body was read as a banner";
});

check("B SILENT on a SUPERSEDED owed row (a retired row owes nobody anything)", () => {
  const d = mkRepo([{ id: "R1", page: "Alpha", status: "Blocked on you", ask_ref: "asks/gone.md", retired: true }]);
  const res = runHook(
    d,
    writePayload(d, [{ id: "R1", page: "Alpha", status: "Blocked on you", ask_ref: "asks/gone.md", retired: true }]),
  );
  return !fired(res) ? true : "graded a retired row";
});

// ── SCOPING · the guard must protect nothing where there is nothing to key on ──

check("SCOPING: no burndown-manifest.json → SILENT on a blatant demotion", () => {
  const d = mkRepo([SIGNED()], { withManifest: false });
  const res = runHook(d, writePayload(d, [DEMOTED()]));
  if (res.code !== 0) return `exited ${res.code} in a repo with no manifest`;
  return !fired(res) ? true : "fired in a repo with no tracker-source convention";
});

check("SCOPING: a JSON file that is NOT a declared register → SILENT", () => {
  const d = mkRepo([SIGNED()]);
  const other = path.join(d, "burndown", "other.json");
  fs.writeFileSync(other, JSON.stringify(register([SIGNED()]), null, 2));
  const res = runHook(d, {
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: other, content: JSON.stringify(register([DEMOTED()]), null, 2) },
  });
  return !fired(res) ? true : "fired on an undeclared JSON file";
});

check("SCOPING: a non-JSON path → SILENT (the cheap bail)", () => {
  const d = mkRepo([SIGNED()]);
  const res = runHook(d, {
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: path.join(d, "BURNDOWN.md"), content: "Signed off → In progress\n" },
  });
  return !fired(res) ? true : "fired on a markdown file";
});

// ── FAIL-OPEN / UNKNOWN · an UNKNOWN is surfaced, never rendered clean ──────

check("UNKNOWN: an uncommitted register (no HEAD blob) is SURFACED, not called clean, and does not block", () => {
  const d = mkRepo([SIGNED()]);
  // Identity passed with `-c`, not assumed. `mkRepo` no longer writes a local
  // git config (that was two spawns per case), so a bare `git commit` here would
  // depend on a GLOBAL identity — present on a dev box, absent on a fresh CI
  // runner, where it would throw and report as a fixture error rather than a
  // finding.
  const ID = ["-c", "user.email=f@x.invalid", "-c", "user.name=f"];
  execFileSync("git", ["rm", "-q", "--cached", "burndown/register.json"], { cwd: d, stdio: "ignore" });
  execFileSync("git", [...ID, "commit", "-q", "-m", "drop"], { cwd: d, stdio: "ignore" });
  const res = runHook(d, writePayload(d, [DEMOTED()]));
  if (res.code !== 0) return `blocked on an UNKNOWN (code=${res.code}); must fail open`;
  return /UNKNOWN, not clean/.test(res.out) ? true : `an UNKNOWN was rendered silently: ${res.out.slice(0, 300)}`;
});

check("UNKNOWN: unparseable incoming JSON is SURFACED, not clean", () => {
  const d = mkRepo([SIGNED()]);
  const res = runHook(d, {
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: path.join(d, "burndown", "register.json"), content: "{ not json" },
  });
  if (res.code !== 0) return `blocked on unparseable input (code=${res.code})`;
  return /UNKNOWN, not clean/.test(res.out) ? true : "unparseable input was passed silently";
});

check("FAIL-OPEN: a payload with no file_path exits 0 and is silent", () => {
  const d = mkRepo([SIGNED()]);
  const res = runHook(d, { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} });
  return res.code === 0 && !fired(res) ? true : `code=${res.code}`;
});

check("FAIL-OPEN: a non-write tool exits 0 and is silent", () => {
  const d = mkRepo([SIGNED()]);
  const res = runHook(d, {
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: path.join(d, "burndown", "register.json") },
  });
  return res.code === 0 && !fired(res) ? true : `code=${res.code}`;
});

// ── Edit reconstruction ────────────────────────────────────────────────────

check("EDIT: a demotion applied through Edit is caught before it lands", () => {
  const d = mkRepo([SIGNED()]);
  const res = runHook(d, {
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: {
      file_path: path.join(d, "burndown", "register.json"),
      old_string: '"status": "Signed off"',
      new_string: '"status": "In progress"',
    },
  });
  return fired(res) && blocked(res) ? true : `Edit path did not block (code=${res.code})`;
});

check("EDIT: an Edit carrying a valid rebuttal is SILENT", () => {
  const d = mkRepo([SIGNED()]);
  const res = runHook(d, {
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: {
      file_path: path.join(d, "burndown", "register.json"),
      old_string: '"status": "Signed off"',
      new_string: '"status": "In progress",\n      "regression_rebuttal": "Opened it 2026-08-20; the route 404s."',
    },
  });
  return !fired(res) ? true : `fired on a rebutted Edit: ${(res.out + res.err).slice(0, 300)}`;
});

check("EDIT: an old_string that does not occur is UNRECONSTRUCTIBLE → silent, never a guess", () => {
  const d = mkRepo([SIGNED()]);
  const res = runHook(d, {
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: {
      file_path: path.join(d, "burndown", "register.json"),
      old_string: "NOT PRESENT ANYWHERE",
      new_string: "x",
    },
  });
  return res.code === 0 && !fired(res) ? true : `code=${res.code}`;
});

check("EDIT: an ambiguous old_string without replace_all is UNRECONSTRUCTIBLE → silent", () => {
  const d = mkRepo([SIGNED(), { id: "R2", page: "Alpha", status: "Signed off" }]);
  const res = runHook(d, {
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: {
      file_path: path.join(d, "burndown", "register.json"),
      old_string: '"status": "Signed off"',
      new_string: '"status": "In progress"',
    },
  });
  return res.code === 0 && !fired(res) ? true : `code=${res.code}`;
});

check("EDIT: replace_all IS reconstructible and both demotions are caught", () => {
  const d = mkRepo([SIGNED(), { id: "R2", page: "Alpha", status: "Signed off" }]);
  const res = runHook(d, {
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: {
      file_path: path.join(d, "burndown", "register.json"),
      old_string: '"status": "Signed off"',
      new_string: '"status": "In progress"',
      replace_all: true,
    },
  });
  const blob = res.out + res.err;
  return fired(res) && /R1/.test(blob) && /R2/.test(blob) ? true : `did not catch both rows: ${blob.slice(0, 300)}`;
});

// ── the predicate seam, called directly ────────────────────────────────────

check("lib/rankOf returns null OUTSIDE the closed vocabulary (never a guessed rank)", () => {
  return lib.rankOf("Done") === null && lib.rankOf("complete") === null && lib.rankOf(undefined) === null
    ? true
    : "guessed a rank for an out-of-vocabulary status";
});

check("lib/rankOf ranks every member of the closed vocabulary", () => {
  const v = ["Signed off", "Built-not-walked", "In progress", "Not started", "Blocked on you"];
  return v.every((s) => lib.rankOf(s) !== null) ? true : "a vocabulary member has no rank";
});

check("lib/classifyRebuttal separates observation from absence across the whole corpus", () => {
  for (const a of ABSENCE_CORPUS) {
    if (lib.classifyRebuttal(a).kind !== "absence") return `absence read as non-absence: ${a}`;
  }
  for (const o of OBSERVATIONS) {
    if (lib.classifyRebuttal(o).kind !== "observation") return `observation read as absence: ${o}`;
  }
  return lib.classifyRebuttal(undefined).kind === "missing" ? true : "a missing key was not classified missing";
});

check("lib/evaluate reports ran:false rather than clean when it cannot run", () => {
  const d = mkRepo([SIGNED()], { withManifest: false });
  const res = lib.evaluate(d, "burndown/register.json", JSON.stringify(register([DEMOTED()])));
  return res.ran === false && res.findings.length === 0 ? true : "an unrunnable evaluation reported a verdict";
});

// ── SECURITY-REVIEW REGRESSIONS ────────────────────────────────────────────
//
// Every case below pins a finding from the adversarial review of revision 1.
// Each was CONFIRMED to fire against that revision before the fix landed, so
// these are regression pins, not speculative hardening.

// CRITICAL · id-rename was the cheapest exit and was completely open.
check("SEC/A-3 FIRES when a delivered row's id is RENAMED (the row leaves Signed off)", () => {
  const d = mkRepo([{ id: "F80", page: "Alpha", status: "Signed off" }]);
  const res = runHook(d, writePayload(d, [{ id: "F80-r2", page: "Alpha", status: "Not started" }]));
  return fired(res) && blocked(res) ? true : `id-rename evasion still open (code=${res.code})`;
});

check("SEC/A-3 FIRES when a delivered row is DELETED outright", () => {
  const d = mkRepo([SIGNED(), { id: "R2", page: "Beta", status: "In progress" }]);
  const res = runHook(d, writePayload(d, [{ id: "R2", page: "Beta", status: "In progress" }]));
  return fired(res) && blocked(res) ? true : `delivered-row deletion not caught (code=${res.code})`;
});

check("SEC/A-3 SILENT when the removal carries a `_removed` observation", () => {
  const d = mkRepo([SIGNED()]);
  const p = writePayload(d, []);
  const doc = JSON.parse(p.tool_input.content);
  doc._removed = { R1: "Superseded by R9 on 2026-08-20; the original page was deleted in a8e737a." };
  p.tool_input.content = JSON.stringify(doc, null, 2);
  const res = runHook(d, p);
  return !fired(res) ? true : `fired despite a _removed observation: ${(res.out + res.err).slice(0, 300)}`;
});

check("SEC/A-3 SILENT when a NON-delivered row is removed", () => {
  const d = mkRepo([{ id: "R1", page: "Alpha", status: "Not started" }, { id: "R2", page: "Beta", status: "In progress" }]);
  const res = runHook(d, writePayload(d, [{ id: "R2", page: "Beta", status: "In progress" }]));
  return !fired(res) ? true : "fired on removal of a row that never claimed delivery";
});

check("SEC/A-3 SILENT when an ALREADY-RETIRED delivered row is tidied away", () => {
  const d = mkRepo([SIGNED({ superseded_by: "R9" }), { id: "R2", page: "Beta", status: "In progress" }]);
  const res = runHook(d, writePayload(d, [{ id: "R2", page: "Beta", status: "In progress" }]));
  return !fired(res) ? true : "fired on tidying a row retired at HEAD";
});

// HIGH-1 · the two-write retirement chain. Step 1 was silent on every surface.
// Uses a RETIREMENT field, not `internal`: `internal` is a visibility flag and
// A-4 deliberately no longer treats it as a retraction (see FP/C-3).
check("SEC/A-4 FIRES when a retirement marker is ADDED to a delivered row (chain step 1)", () => {
  const d = mkRepo([SIGNED()]);
  const res = runHook(d, writePayload(d, [SIGNED({ retired: true })]));
  return fired(res) && blocked(res) ? true : `marker-addition chain still silent (code=${res.code})`;
});

check("SEC/A-4 SILENT when the retirement carries an observation", () => {
  const d = mkRepo([SIGNED()]);
  const res = runHook(
    d,
    writePayload(d, [
      SIGNED({
        superseded_by: "R9",
        regression_rebuttal: "Owner folded this into R9 on 2026-08-20; the standalone page is gone.",
      }),
    ]),
  );
  return !fired(res) ? true : `fired on a rebutted retirement: ${(res.out + res.err).slice(0, 300)}`;
});

check("SEC/A-4 does NOT re-fire on a row already retired at HEAD (reinstatement stays clean)", () => {
  const d = mkRepo([SIGNED({ superseded_by: "R9" })]);
  const res = runHook(d, writePayload(d, [SIGNED({ superseded_by: "R9" })]));
  return !fired(res) ? true : "re-fired on a marker that was already committed";
});

// HIGH-2 · the substance floor. Each of these passed a `block` silently before.
for (const placeholder of ["n/a", "-", "TBD", "x", "none", ".", "?", "todo"]) {
  check(`SEC/A-2 REJECTS the placeholder rebuttal ${JSON.stringify(placeholder)}`, () => {
    const d = mkRepo([SIGNED()]);
    const res = runHook(d, writePayload(d, [DEMOTED({ regression_rebuttal: placeholder })]));
    return fired(res) && blocked(res) ? true : `placeholder accepted as an observation (code=${res.code})`;
  });
}

// HIGH-3 · curly apostrophes are the DEFAULT output of ordinary writing.
for (const [ascii, curly] of [
  ["wasn't verified", "wasn’t verified"],
  ["couldn't confirm it was live", "couldn’t confirm it was live"],
  ["hasn't been walked by anyone", "hasn’t been walked by anyone"],
]) {
  check(`SEC/A-1 treats ${JSON.stringify(curly)} the same as its ASCII form`, () => {
    const a = lib.classifyRebuttal(ascii).kind;
    const c = lib.classifyRebuttal(curly).kind;
    if (a !== "absence") return `the ASCII control did not classify as absence (got ${a})`;
    return c === "absence" ? true : `curly-apostrophe form classified as ${c} — the evasion is open`;
  });
}

check("SEC/A-1 REJECTS the hyphenated 'no-one has walked it'", () => {
  return lib.classifyRebuttal("no-one has walked it, so I am marking it down").kind === "absence"
    ? true
    : "hyphenated no-one passed as an observation";
});

for (const phrase of [
  "We have yet to walk it on staging.",
  "The walkthrough is missing for this row.",
  "Verification remains outstanding for this item.",
  // "Nothing in the transcript shows it working." is a KNOWN RECALL BOUND, not an
  // oversight. Separating it from "There is no record of the export in the audit
  // table" — a genuine observation from a query — is not reliably doable
  // lexically, and the corpus resolves that tie toward NOT refusing real
  // rebuttals. Recorded here so the gap is visible rather than assumed covered.
  "There is zero evidence that it shipped.",
  "This row is unsubstantiated at the moment.",
]) {
  check(`SEC/A-1 REJECTS the deferral/absence phrasing ${JSON.stringify(phrase.slice(0, 34))}…`, () => {
    return lib.classifyRebuttal(phrase).kind === "absence" ? true : "passed as an observation";
  });
}

// M1 · invisible characters bought a silent pass through the ladder.
for (const [label, status] of [
  ["SOFT HYPHEN", "Signed­off"],
  ["ZERO-WIDTH SPACE", "Signed​off"],
  ["NON-BREAKING HYPHEN", "Signed‑off"],
]) {
  check(`SEC/ladder folds ${label} back onto 'Signed off'`, () => {
    return lib.rankOf(status) === 3 ? true : `rank was ${lib.rankOf(status)} — the invisible-character evasion is open`;
  });
}

check("SEC/A-5 SURFACES a status outside the closed vocabulary instead of skipping silently", () => {
  const d = mkRepo([SIGNED()]);
  const res = runHook(d, writePayload(d, [{ id: "R1", page: "Alpha", status: "Ѕigned off" }]));
  if (!fired(res)) return "an out-of-vocabulary status was skipped silently";
  return !blocked(res) ? true : "A-5 rendered as BLOCK — the generator owns that refusal";
});

// M3 · a field whose VALUE denies the state switched the state on.
for (const [field, value] of [
  ["retired", "no"],
  ["superseded", "false"],
  ["internal", "none"],
]) {
  check(`SEC/marker '${field}: ${value}' is NOT read as a supersession declaration`, () => {
    return lib.isSupersededRow({ [field]: value }) === false
      ? true
      : `a negating value switched the marker ON, disabling the guard`;
  });
}

check("SEC/a genuine marker value is still read as set", () => {
  return lib.isSupersededRow({ superseded_by: "R9" }) === true && lib.isSupersededRow({ retired: true }) === true
    ? true
    : "a real marker stopped registering";
});

// HIGH-1b · Guard B's exclusion must read the OLD row.
check("SEC/B same-write `internal` marker does NOT bypass Guard B", () => {
  const d = mkRepo([{ id: "R1", page: "Alpha", status: "In progress" }]);
  const res = runHook(
    d,
    writePayload(d, [{ id: "R1", page: "Alpha", status: "Blocked on you", ask_ref: "asks/gone.md", internal: "x" }]),
  );
  return fired(res) ? true : "a same-write marker skipped Guard B entirely";
});

// HIGH-4 · path containment must resolve BOTH sides (security.md § Path Containment).
check("SEC/B-2 does NOT follow a symlink whose target escapes the repo", () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "reg-outside-"));
  fs.writeFileSync(path.join(outside, "secret.md"), "# SUPERSEDED BY something\n");
  const d = mkRepo([{ id: "R1", page: "Alpha", status: "Blocked on you", ask_ref: "asks/link.md" }]);
  fs.mkdirSync(path.join(d, "asks"), { recursive: true });
  try {
    fs.symlinkSync(path.join(outside, "secret.md"), path.join(d, "asks", "link.md"));
  } catch {
    return true; // no symlink support on this platform; nothing to test
  }
  const res = runHook(
    d,
    writePayload(d, [{ id: "R1", page: "Alpha", status: "Blocked on you", ask_ref: "asks/link.md" }]),
  );
  const blob = res.out + res.err;
  return !/SUPERSEDED BY/.test(blob)
    ? true
    : "read out-of-tree content through a lexically-contained symlink (read oracle)";
});

check("SEC/resolveContained rejects an escaping ref and accepts an in-tree one", () => {
  const d = mkRepo([SIGNED()], { extraFiles: { "asks/live.md": "ask\n" } });
  const inTree = lib.resolveContained(d, "asks/live.md");
  const escaping = lib.resolveContained(d, "../../../etc/hosts");
  return inTree && inTree.contained === true && escaping === null
    ? true
    : `containment wrong: inTree=${JSON.stringify(inTree)} escaping=${JSON.stringify(escaping)}`;
});

// L1 · the marker regex misfired on this repo's own LIVE rule text.
// The shape that misfired was a CURRENT rule whose opening paragraph says some
// FLAG or OPTION "is RETIRED" — loom's house style puts exactly those words near
// the top, so the head is where the false positives live, not where they are
// avoided. The wording below is a neutral stand-in for that shape: quoting the
// real sentence would drag this fixture into the pinned-mentions guard that
// polices where the actual retired flag may appear.
check("SEC/declaresSuperseded does NOT fire on prose merely mentioning retirement", () => {
  const live = "# Cache Policy\n\nThe `--legacy-cache` option is RETIRED and must not be used in new work.\n";
  const second = "# Ask\n\nWe withdrew the earlier draft, so use this one.\n";
  if (lib.declaresSuperseded(live) !== null) {
    return `a live document was read as superseded via mid-sentence prose ("${lib.declaresSuperseded(live)}")`;
  }
  return lib.declaresSuperseded(second) === null
    ? true
    : `a live document was read as superseded via mid-sentence prose ("${lib.declaresSuperseded(second)}")`;
});

check("SEC/declaresSuperseded still fires on a real banner", () => {
  return lib.declaresSuperseded("# SUPERSEDED BY asks/final.md\n") !== null &&
    lib.declaresSuperseded("> RETIRED — do not use\n") !== null
    ? true
    : "a genuine supersession banner stopped registering";
});

// M2 · case-insensitive filesystems routed writes past the declared-source check.
check("SEC/a case-variant path resolving to the SAME file is still guarded", () => {
  const d = mkRepo([SIGNED()]);
  const variant = path.join(d, "burndown", "Register.json");
  let sameFile = false;
  try {
    sameFile = fs.realpathSync(variant) === fs.realpathSync(path.join(d, "burndown", "register.json"));
  } catch {
    sameFile = false;
  }
  if (!sameFile) return true; // case-sensitive filesystem: they are genuinely different files
  const res = runHook(d, {
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: variant, content: JSON.stringify(register([DEMOTED()]), null, 2) },
  });
  return fired(res) ? true : "a case-variant path bypassed the declared-register check";
});

// M4 · UNKNOWN must be surfaced on EVERY path once the file is a declared register.
check("SEC/an unreconstructible Edit on a DECLARED register surfaces UNKNOWN, not silence", () => {
  const d = mkRepo([SIGNED(), { id: "R2", page: "Alpha", status: "Signed off" }]);
  const res = runHook(d, {
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: {
      file_path: path.join(d, "burndown", "register.json"),
      old_string: '"status": "Signed off"',
      new_string: '"status": "In progress"',
    },
  });
  if (res.code !== 0) return `blocked on an UNKNOWN (code=${res.code}); must fail open`;
  return /UNKNOWN, not clean/.test(res.out) ? true : `an UNKNOWN was rendered silently: ${res.out.slice(0, 200)}`;
});

console.log("");
console.log(`register-regression fixtures: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failing: ${failures.join(", ")}`);
  process.exit(1);
}
