#!/usr/bin/env node
/*
 * Audit-fixture runner for the F90 wrapup-freshness check in
 * `.claude/hooks/stop.js` (`decideWrapupReminder` + `buildWrapupPayload` + the
 * hook's own stdout contract).
 *
 * WHAT IS UNDER TEST, AND WHY IT NEEDS POLES
 *
 *   Before F90 the hook printed "Run /wrapup next time before closing"
 *   UNCONDITIONALLY. Measured in a prior session, the identical string appeared
 *   BOTH before AND after a completed wrapup — an instrument whose output is
 *   the same whether the proposition is true or false, i.e. zero information
 *   (`instrument-discipline.md` MUST-1). The fix is only worth anything if the
 *   new check produces a DIFFERENT result in the two states, so that is what
 *   this file measures rather than asserts.
 *
 *   POLE PAIR (`instrument-bipolarity.md` MUST-1/2): cases 01 and 02 build the
 *   SAME tree and differ in ONE byte-range — the fragment's
 *   `last_reconciled_sha`. Case 13 then asserts the two VERDICTS DIFFER, so a
 *   check that stopped discriminating reds here even if every other case still
 *   passes. The RED pole asserts a failure IDENTITY (`kind:"lag"` +
 *   `reason:"notes-lag"` + the exact `ahead` count), never merely "something
 *   fired" (MUST-2).
 *
 *   POSITIVE CONTROL (`instrument-discipline.md` MUST-3a): case 27 shows that
 *   `instructAndWait` CAN return a non-zero exit code on this machine, so case
 *   26's "exit 0 at Stop" is a measurement rather than a tool that never
 *   returns anything else.
 *
 * HERMETIC: every case builds a throwaway git repo under os.tmpdir() (realpath'd,
 * because macOS /var is a symlink and the resolver canonicalizes), runs real
 * `git rev-list`, and removes the tree afterwards. Node built-ins + git only.
 *
 * ORACLE HYGIENE: the e2e cases derive the fragment FILENAME by calling the same
 * `fragmentPathFor(resolveIdentity(...))` the hook uses. That is deliberate and
 * is NOT a self-derived oracle in the `evidence-first-claims.md` MUST-5 sense:
 * it fixes WHERE the fixture writes (setup), while the assertion is about
 * WHETHER the hook fires and WHAT COUNT it reports — and that count comes from
 * real git, independently. Setup asserts the path resolved at all, so a null
 * derivation reds loudly instead of silently converting a RED pole to a GREEN.
 *
 * Exit 0 = all cases pass. Exit 1 = >=1 case failed.
 */

import "../_lib/no-ambient-git.cjs";
import { spawnSync, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  realpathSync,
  existsSync,
  readdirSync,
  utimesSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(HERE, "..", "..", "hooks");
const HOOK = join(HOOKS, "stop.js");

const require_ = createRequire(import.meta.url);
const {
  decideWrapupReminder,
  buildWrapupPayload,
  claimWrapupLatch,
  LATCH_TTL_MS,
} = require_(HOOK);
const { instructAndWait } = require_(
  join(HOOKS, "lib", "instruct-and-wait.js"),
);
const { fragmentPathFor } = require_(
  join(HOOKS, "lib", "session-notes-layout.js"),
);
const { resolveIdentity } = require_(join(HOOKS, "lib", "operator-id.js"));

let passed = 0;
let failed = 0;

function check(name, condition, details) {
  if (condition) {
    passed++;
    process.stdout.write(`  PASS  ${name}\n`);
  } else {
    failed++;
    process.stderr.write(`  FAIL  ${name}\n`);
    if (details) process.stderr.write(`        ${details}\n`);
  }
}

const IDENTITY = { display_id: "fixture-operator" };

/** Build a throwaway git repo with `n` commits; returns its realpath. */
function makeRepo(tag, { commits = 3, workspace = true, split = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `f90-${tag}-`)));
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture Operator");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  for (let i = 0; i < commits; i++) {
    writeFileSync(join(root, `f${i}.txt`), `c${i}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", `commit ${i}`);
  }
  if (workspace)
    mkdirSync(join(root, "workspaces", "demo"), { recursive: true });
  if (split) mkdirSync(join(root, ".session-notes.d"), { recursive: true });
  return { root, git };
}

/** Write a fragment with the given frontmatter stamp text (null = no block). */
function writeFragment(root, handle, stampLine, body = "# Session Notes\n") {
  const p = join(root, ".session-notes.d", `${handle}.md`);
  const meta =
    stampLine === null
      ? "<!-- banner, no frontmatter -->\n"
      : `<!-- banner: last_reconciled_sha is the lag anchor -->\n---\n${stampLine}\n---\n`;
  writeFileSync(p, meta + "\n" + body);
  return p;
}

function withRepo(tag, opts, fn) {
  const r = makeRepo(tag, opts);
  try {
    return fn(r);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// A. PREDICATE POLES — real git, real fragment, injected identity
// ───────────────────────────────────────────────────────────────────────────

let redVerdict = null;
let greenVerdict = null;

// case-01 RED POLE: stamp two commits behind HEAD → FIRES, names the lag.
withRepo("01", {}, ({ root, git }) => {
  const behind = git("rev-parse", "HEAD~2").trim();
  writeFragment(root, "fixture-operator", `last_reconciled_sha: ${behind}`);
  const d = decideWrapupReminder({ baseDir: root, identity: IDENTITY });
  redVerdict = d;
  check(
    "case-01-red-pole-lag-fires-with-identity",
    d.fire === true &&
      d.kind === "lag" &&
      d.reason === "notes-lag" &&
      d.ahead === 2 &&
      d.sha === behind,
    `got ${JSON.stringify(d)}`,
  );
});

// case-02 GREEN POLE: same tree, stamp == HEAD → SILENT.
withRepo("02", {}, ({ root, git }) => {
  const head = git("rev-parse", "HEAD").trim();
  writeFragment(root, "fixture-operator", `last_reconciled_sha: ${head}`);
  const d = decideWrapupReminder({ baseDir: root, identity: IDENTITY });
  greenVerdict = d;
  check(
    "case-02-green-pole-at-head-does-not-fire",
    d.fire === false &&
      d.kind === "silent" &&
      d.reason === "coherent-count-zero",
    `got ${JSON.stringify(d)}`,
  );
});

// case-03 lag of exactly 1 — the count is READ, not merely thresholded.
withRepo("03", {}, ({ root, git }) => {
  const behind = git("rev-parse", "HEAD~1").trim();
  writeFragment(root, "fixture-operator", `last_reconciled_sha: ${behind}`);
  const d = decideWrapupReminder({ baseDir: root, identity: IDENTITY });
  check(
    "case-03-lag-count-is-read-not-thresholded",
    d.fire === true && d.kind === "lag" && d.ahead === 1,
    `got ${JSON.stringify(d)}`,
  );
});

// case-04 abbreviated (7-char) stamp is accepted by the shape guard and resolves.
withRepo("04", {}, ({ root, git }) => {
  const behind = git("rev-parse", "--short=8", "HEAD~2").trim();
  writeFragment(root, "fixture-operator", `last_reconciled_sha: ${behind}`);
  const d = decideWrapupReminder({ baseDir: root, identity: IDENTITY });
  check(
    "case-04-abbreviated-stamp-resolves-to-lag",
    d.fire === true && d.kind === "lag" && d.ahead === 2,
    `got ${JSON.stringify(d)}`,
  );
});

// case-05 EMPTY stamp → I10 coherent, MUST NOT become a finding.
withRepo("05", {}, ({ root }) => {
  writeFragment(root, "fixture-operator", "last_reconciled_sha:");
  const d = decideWrapupReminder({ baseDir: root, identity: IDENTITY });
  check(
    "case-05-empty-stamp-is-coherent-not-a-finding",
    d.fire === false && d.reason === "unstamped-coherent",
    `got ${JSON.stringify(d)}`,
  );
});

// case-06 NO frontmatter block at all → I10 coherent.
withRepo("06", {}, ({ root }) => {
  writeFragment(root, "fixture-operator", null);
  const d = decideWrapupReminder({ baseDir: root, identity: IDENTITY });
  check(
    "case-06-no-frontmatter-is-coherent",
    d.fire === false && d.reason === "unstamped-coherent",
    `got ${JSON.stringify(d)}`,
  );
});

// case-07 frontmatter present but carrying no stamp KEY → coherent.
withRepo("07", {}, ({ root }) => {
  writeFragment(root, "fixture-operator", "some_other_key: value");
  const d = decideWrapupReminder({ baseDir: root, identity: IDENTITY });
  check(
    "case-07-frontmatter-without-the-key-is-coherent",
    d.fire === false && d.reason === "unstamped-coherent",
    `got ${JSON.stringify(d)}`,
  );
});

// case-08 fragment ABSENT (dir exists, someone else's file present) → FIRES as
// `absent`. F90 as first landed was SILENT here, which is the coverage the old
// unconditional reminder had and the discriminating one lost — the operator who
// wrote no notes at all heard nothing. The file's NON-EXISTENCE is a definite
// structural fact, so it is reported as exactly that (see case-33 for the string
// discipline: it must not become a claim about /wrapup).
withRepo("08", {}, ({ root }) => {
  writeFragment(root, "someone-else", "last_reconciled_sha: deadbee");
  const d = decideWrapupReminder({ baseDir: root, identity: IDENTITY });
  check(
    "case-08-missing-own-fragment-FIRES-as-absent",
    d.fire === true && d.kind === "absent" && d.reason === "no-own-fragment",
    `got ${JSON.stringify(d)}`,
  );
});

// case-09 no `.session-notes.d` AND no legacy monolith → FIRES as `absent`:
// this repo carries no session-notes surface of any kind.
withRepo("09", { split: false }, ({ root }) => {
  const d = decideWrapupReminder({ baseDir: root, identity: IDENTITY });
  check(
    "case-09-no-notes-surface-at-all-FIRES-as-absent",
    d.fire === true &&
      d.kind === "absent" &&
      d.reason === "no-session-notes-at-all",
    `got ${JSON.stringify(d)}`,
  );
});

// case-09b THE COMPLIANT POLE FOR case-09 (`instrument-bipolarity.md` MUST-1):
// same tree, one added file — the legacy `.session-notes` monolith. Notes now
// demonstrably EXIST, and the monolith carries no `last_reconciled_sha`, so
// firing would assert a staleness never measured. SILENT. If this ever coincides
// with case-09's verdict the split-on-evidence branch has stopped discriminating.
withRepo("09b", { split: false }, ({ root }) => {
  writeFileSync(join(root, ".session-notes"), "# legacy monolith notes\n");
  const d = decideWrapupReminder({ baseDir: root, identity: IDENTITY });
  check(
    "case-09b-legacy-monolith-present-is-SILENT",
    d.fire === false &&
      d.kind === "silent" &&
      d.reason === "legacy-monolith-layout",
    `got ${JSON.stringify(d)}`,
  );
});

// case-10 no `workspaces/` → SILENT. The scope precondition is UNCHANGED from
// the pre-F90 reminder; this change adds discrimination, not firing surface.
withRepo("10", { workspace: false }, ({ root, git }) => {
  const behind = git("rev-parse", "HEAD~2").trim();
  writeFragment(root, "fixture-operator", `last_reconciled_sha: ${behind}`);
  const d = decideWrapupReminder({ baseDir: root, identity: IDENTITY });
  check(
    "case-10-no-workspace-is-silent-even-with-real-lag",
    d.fire === false && d.reason === "no-active-workspace",
    `got ${JSON.stringify(d)}`,
  );
});

// case-11 identity with no usable handle → UNKNOWN (fires, advisory), never a
// throw and never silence. We cannot even NAME the file whose existence is the
// question, so nothing was measured — and this file's own doctrine is that a
// failed measurement never becomes an all-clear. Note the fixture writes a REAL
// lagging fragment first: the point is that the handle failure, not the absence
// of data, is what makes this UNKNOWN rather than `lag`.
withRepo("11", {}, ({ root, git }) => {
  const behind = git("rev-parse", "HEAD~2").trim();
  writeFragment(root, "fixture-operator", `last_reconciled_sha: ${behind}`);
  const d = decideWrapupReminder({ baseDir: root, identity: {} });
  check(
    "case-11-no-identity-handle-is-UNKNOWN-not-silent",
    d.fire === true &&
      d.kind === "unknown" &&
      d.reason === "no-identity-handle",
    `got ${JSON.stringify(d)}`,
  );
});

// case-12 person_id fallback resolves the same fragment the writer would use.
withRepo("12", {}, ({ root, git }) => {
  const behind = git("rev-parse", "HEAD~2").trim();
  writeFragment(root, "fallback-person", `last_reconciled_sha: ${behind}`);
  const d = decideWrapupReminder({
    baseDir: root,
    identity: { person_id: "fallback-person" },
  });
  check(
    "case-12-person-id-fallback-locates-the-fragment",
    d.fire === true && d.kind === "lag" && d.ahead === 2,
    `got ${JSON.stringify(d)}`,
  );
});

// ───────────────────────────────────────────────────────────────────────────
// case-13 THE VACUITY GATE (instrument-bipolarity MUST-1): the two poles above
// were built from the same tree and differ only in the stamp. If their verdicts
// ever coincide, the check has stopped discriminating and this reds — which is
// the single assertion the whole shard exists to make.
// ───────────────────────────────────────────────────────────────────────────
check(
  "case-13-poles-produce-DIFFERENT-verdicts",
  redVerdict &&
    greenVerdict &&
    redVerdict.fire === true &&
    greenVerdict.fire === false &&
    redVerdict.kind !== greenVerdict.kind &&
    redVerdict.reason !== greenVerdict.reason,
  `red=${JSON.stringify(redVerdict)} green=${JSON.stringify(greenVerdict)}`,
);

// ───────────────────────────────────────────────────────────────────────────
// B. FAILED-MEASUREMENT CLASS — must never read as "the notes are current"
//    (zero-tolerance.md Rule 3 / evidence-first-claims.md MUST-3)
// ───────────────────────────────────────────────────────────────────────────

// case-14 stamp that is not sha-shaped → UNKNOWN, and never reaches git.
withRepo("14", {}, ({ root }) => {
  writeFragment(root, "fixture-operator", "last_reconciled_sha: not-a-sha!!");
  const d = decideWrapupReminder({ baseDir: root, identity: IDENTITY });
  check(
    "case-14-corrupt-stamp-is-UNKNOWN-not-coherent",
    d.fire === true &&
      d.kind === "unknown" &&
      d.reason === "stamp-not-sha-shaped",
    `got ${JSON.stringify(d)}`,
  );
});

// case-15 well-shaped stamp naming an object git cannot reach → UNKNOWN.
withRepo("15", {}, ({ root }) => {
  writeFragment(
    root,
    "fixture-operator",
    "last_reconciled_sha: 0123456789abcdef0123456789abcdef01234567",
  );
  const d = decideWrapupReminder({ baseDir: root, identity: IDENTITY });
  check(
    "case-15-unreachable-stamp-is-UNKNOWN-not-coherent",
    d.fire === true && d.kind === "unknown" && d.reason === "bad-rev",
    `got ${JSON.stringify(d)}`,
  );
});

// case-16 SYMLINKED fragment → refused by the guarded chokepoint → UNKNOWN.
withRepo("16", {}, ({ root, git }) => {
  const behind = git("rev-parse", "HEAD~2").trim();
  const real = join(root, "elsewhere.md");
  writeFileSync(real, `---\nlast_reconciled_sha: ${behind}\n---\n`);
  symlinkSync(real, join(root, ".session-notes.d", "fixture-operator.md"));
  const d = decideWrapupReminder({ baseDir: root, identity: IDENTITY });
  check(
    "case-16-symlinked-fragment-is-UNKNOWN-never-followed",
    d.fire === true && d.kind === "unknown" && d.reason === "fragment-symlink",
    `got ${JSON.stringify(d)}`,
  );
});

// case-17 OVERSIZE fragment (>1 MB cap) → refused → UNKNOWN.
withRepo("17", {}, ({ root }) => {
  writeFileSync(
    join(root, ".session-notes.d", "fixture-operator.md"),
    "x".repeat(1024 * 1024 + 64),
  );
  const d = decideWrapupReminder({ baseDir: root, identity: IDENTITY });
  check(
    "case-17-oversize-fragment-is-UNKNOWN",
    d.fire === true && d.kind === "unknown" && d.reason === "fragment-oversize",
    `got ${JSON.stringify(d)}`,
  );
});

// case-18 git absent / spawn error → UNKNOWN, never silence.
withRepo("18", {}, ({ root, git }) => {
  const behind = git("rev-parse", "HEAD~2").trim();
  writeFragment(root, "fixture-operator", `last_reconciled_sha: ${behind}`);
  const d = decideWrapupReminder({
    baseDir: root,
    identity: IDENTITY,
    _revListCount: () => ({ status: null, count: NaN }),
  });
  check(
    "case-18-git-spawn-error-is-UNKNOWN",
    d.fire === true && d.kind === "unknown" && d.reason === "git-exit-error",
    `got ${JSON.stringify(d)}`,
  );
});

// case-19 exit 0 with unparseable output → UNKNOWN, not "count zero".
withRepo("19", {}, ({ root, git }) => {
  const behind = git("rev-parse", "HEAD~2").trim();
  writeFragment(root, "fixture-operator", `last_reconciled_sha: ${behind}`);
  const d = decideWrapupReminder({
    baseDir: root,
    identity: IDENTITY,
    _revListCount: () => ({ status: 0, count: NaN }),
  });
  check(
    "case-19-unparseable-count-is-UNKNOWN-not-coherent",
    d.fire === true && d.kind === "unknown" && d.reason === "count-unparseable",
    `got ${JSON.stringify(d)}`,
  );
});

// case-20 a non-git baseDir cannot be resolved to a main checkout → UNKNOWN.
{
  const bare = realpathSync(mkdtempSync(join(tmpdir(), "f90-20-")));
  try {
    mkdirSync(join(bare, "workspaces", "demo"), { recursive: true });
    const d = decideWrapupReminder({ baseDir: bare, identity: IDENTITY });
    check(
      "case-20-indeterminate-main-checkout-is-UNKNOWN",
      d.fire === true &&
        d.kind === "unknown" &&
        d.reason === "main-checkout-indeterminate",
      `got ${JSON.stringify(d)}`,
    );
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// C. PAYLOAD SHAPE + THE CEILING (what a Stop severity does NOT buy)
// ───────────────────────────────────────────────────────────────────────────

{
  const p = buildWrapupPayload({
    fire: true,
    kind: "lag",
    reason: "notes-lag",
    ahead: 4,
    sha: "abc1234",
    workspace: "demo",
  });
  // hook-output-discipline.md MUST-1 — all six fields of the instruct-and-wait
  // shape, emitted through the shared lib. A raw process.exit(2) is BLOCKED.
  check(
    "case-21-lag-payload-carries-the-full-six-field-shape",
    p &&
      p.hookEvent === "Stop" &&
      p.severity === "halt-and-report" &&
      typeof p.what_happened === "string" &&
      typeof p.why === "string" &&
      Array.isArray(p.agent_must_report) &&
      p.agent_must_report.length >= 1 &&
      typeof p.agent_must_wait === "string" &&
      typeof p.user_summary === "string",
    `got ${JSON.stringify(p)}`,
  );
  check(
    "case-22-lag-payload-names-the-count-and-the-stamp",
    p &&
      /\b4 commit\(s\)/.test(p.what_happened) &&
      p.what_happened.includes("abc1234"),
    `got ${p && p.what_happened}`,
  );
  // The message must NOT over-claim that /wrapup was skipped — the check does
  // not measure that (instrument-bipolarity.md MUST-4).
  check(
    "case-23-lag-payload-does-not-claim-wrapup-was-skipped",
    p && !/Run \/wrapup next time/.test(p.what_happened + p.why),
    `got ${p && p.what_happened}`,
  );
  // case-23b THE user_summary OVER-CLAIM POLE (`instrument-bipolarity.md`
  // MUST-4). `user_summary` is the one line most likely to be read ALONE, and it
  // previously ended "— reconcile due", an ACTION claim the instrument cannot
  // support: the hook's own header records that a wrapup commit landing after
  // the last reconcile leaves N >= 1 with nothing owed. This asserts BOTH poles
  // of the fix — the banned phrasing is gone AND the hedge is present — so
  // deleting the hedge reds here rather than passing on the absence alone.
  check(
    "case-23b-lag-user_summary-does-not-assert-a-duty-it-cannot-measure",
    p &&
      !/reconcile due/i.test(p.user_summary) &&
      /NOT established/.test(p.user_summary) &&
      /trails HEAD by 4 commit\(s\)/.test(p.user_summary),
    `got ${p && p.user_summary}`,
  );
}

// ── The `absent` class: fires, six-field, and never converts an absence into a
//    claim about /wrapup (`instrument-bipolarity.md` MUST-4).
{
  const p = buildWrapupPayload({
    fire: true,
    kind: "absent",
    reason: "no-own-fragment",
    fragmentPath: "/repo/.session-notes.d/op.md",
    workspace: "demo",
  });
  check(
    "case-23c-absent-payload-carries-the-full-six-field-shape",
    p &&
      p.hookEvent === "Stop" &&
      p.severity === "halt-and-report" &&
      typeof p.what_happened === "string" &&
      typeof p.why === "string" &&
      Array.isArray(p.agent_must_report) &&
      p.agent_must_report.length >= 1 &&
      typeof p.agent_must_wait === "string" &&
      typeof p.user_summary === "string",
    `got ${JSON.stringify(p)}`,
  );
  check(
    "case-23d-absent-payload-names-the-path-and-claims-only-absence",
    p &&
      p.what_happened.includes("/repo/.session-notes.d/op.md") &&
      /ABSENCE/.test(p.why) &&
      !/did not run \/wrapup|you skipped|never wrapped/i.test(
        p.what_happened + p.why + p.user_summary,
      ),
    `got ${JSON.stringify(p)}`,
  );
  const q = buildWrapupPayload({
    fire: true,
    kind: "absent",
    reason: "no-session-notes-at-all",
    workspace: "demo",
  });
  check(
    "case-23e-absent-payload-without-a-path-still-renders-a-full-shape",
    q &&
      q.severity === "halt-and-report" &&
      /neither a \.session-notes\.d/.test(q.what_happened) &&
      !/undefined/.test(
        q.what_happened + q.user_summary + q.agent_must_report.join(" "),
      ),
    `got ${JSON.stringify(q)}`,
  );
}

{
  const p = buildWrapupPayload({
    fire: true,
    kind: "unknown",
    reason: "bad-rev",
    fragmentPath: "/tmp/x.md",
  });
  check(
    "case-24-unknown-payload-is-advisory-and-says-UNKNOWN",
    p &&
      p.severity === "advisory" &&
      /UNKNOWN/.test(p.agent_must_report.join(" ")) &&
      /bad-rev/.test(p.user_summary),
    `got ${JSON.stringify(p)}`,
  );
}

check(
  "case-25-silent-decision-builds-NO-payload",
  buildWrapupPayload({
    fire: false,
    kind: "silent",
    reason: "coherent-count-zero",
  }) === null,
  "expected null",
);

// case-26 THE CEILING, measured not asserted: at a Stop event the canonical
// emitter returns continue:true and exit 0 for `halt-and-report`.
{
  const out = instructAndWait({
    hookEvent: "Stop",
    severity: "halt-and-report",
    what_happened: "x",
    why: "y",
    agent_must_report: ["z"],
    agent_must_wait: "w",
  });
  check(
    "case-26-Stop-halt-and-report-cannot-block-continue-true-exit-0",
    out.exitCode === 0 &&
      out.json.continue === true &&
      typeof out.json.systemMessage === "string",
    `got ${JSON.stringify(out)}`,
  );
}

// case-27 POSITIVE CONTROL for case-26 (instrument-discipline.md MUST-3a): the
// same function DOES return a non-zero exit on this machine, at the one event
// that can block. Without this, "exit 0" is consistent with an emitter that
// never returns anything else.
{
  const out = instructAndWait({
    hookEvent: "PreToolUse",
    severity: "block",
    what_happened: "x",
    why: "y",
    agent_must_report: ["z"],
    agent_must_wait: "w",
  });
  check(
    "case-27-CONTROL-emitter-can-return-exit-2-elsewhere",
    out.exitCode === 2 && out.json?.hookSpecificOutput?.permissionDecision === "deny" && out.json.continue !== false,
    `got ${JSON.stringify(out)}`,
  );
}

// ───────────────────────────────────────────────────────────────────────────
// CL. THE ONCE-PER-SESSION-PER-KIND LATCH
//
//   `Stop` carries no matcher and fires at the end of EVERY agent turn. Notes
//   lag is the normal mid-session state, so a discriminating check with no
//   throttle emits a correct finding dozens of times per session — retraining
//   the reader to ignore it, which is the failure F90 exists to fix. These
//   cases measure the throttle in BOTH directions: it must suppress a repeat,
//   and it must NOT suppress anything on any degraded path.
// ───────────────────────────────────────────────────────────────────────────

/** Throwaway latch directory; returns its realpath. */
function withLatchDir(tag, fn) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `f90-latch-${tag}-`)));
  try {
    return fn(join(d, "latches"));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

// case-33 THE HEADLINE POLE PAIR: same session, same kind, twice. First claims,
// second is refused. This is the assertion the whole latch exists to make.
withLatchDir("33", (dir) => {
  const a = claimWrapupLatch("sess-A", "lag", { dir });
  const b = claimWrapupLatch("sess-A", "lag", { dir });
  check(
    "case-33-second-claim-same-session-same-kind-is-REFUSED",
    a.claimed === true &&
      a.reason === "first-report-this-session" &&
      b.claimed === false &&
      b.reason === "already-reported-this-session",
    `a=${JSON.stringify(a)} b=${JSON.stringify(b)}`,
  );
});

// case-34 COMPLIANT POLE for case-33: a DIFFERENT session claims freely. Without
// this, case-33 is consistent with a latch that simply never claims twice for
// anyone — i.e. one that would silence every session after the first.
withLatchDir("34", (dir) => {
  const a = claimWrapupLatch("sess-A", "lag", { dir });
  const b = claimWrapupLatch("sess-B", "lag", { dir });
  check(
    "case-34-a-DIFFERENT-session-still-claims",
    a.claimed === true && b.claimed === true,
    `a=${JSON.stringify(a)} b=${JSON.stringify(b)}`,
  );
});

// case-35 PER-KIND, not per-session. A turn-1 `unknown` must not burn the latch
// that a turn-20 `lag` needs — collapsing the kinds re-opens the coverage hole
// in the other direction.
withLatchDir("35", (dir) => {
  const u = claimWrapupLatch("sess-A", "unknown", { dir });
  const l = claimWrapupLatch("sess-A", "lag", { dir });
  const l2 = claimWrapupLatch("sess-A", "lag", { dir });
  check(
    "case-35-kinds-latch-independently-lag-survives-a-prior-unknown",
    u.claimed === true && l.claimed === true && l2.claimed === false,
    `u=${JSON.stringify(u)} l=${JSON.stringify(l)} l2=${JSON.stringify(l2)}`,
  );
});

// case-36 FAIL OPEN — no session identity. `main()` synthesises `stop_<now>` for
// the checkpoint filename; feeding THAT here would mint a fresh key every turn
// and produce a latch that looks installed and never latches. The raw field is
// passed instead, and an absent one SPEAKS rather than silently mis-latching.
withLatchDir("36", (dir) => {
  const missing = claimWrapupLatch(undefined, "lag", { dir });
  const empty = claimWrapupLatch("   ", "lag", { dir });
  check(
    "case-36-no-session-identity-FAILS-OPEN-and-says-so",
    missing.claimed === true &&
      missing.reason === "no-session-identity" &&
      empty.claimed === true &&
      empty.reason === "no-session-identity",
    `missing=${JSON.stringify(missing)} empty=${JSON.stringify(empty)}`,
  );
});

// case-37 FAIL OPEN — the state directory cannot be created (a regular file sits
// where the latch dir must go). A broken latch must never become silence, and
// must never throw into the caller: the caller is the session-close path.
withLatchDir("37", (dir) => {
  mkdirSync(join(dir, ".."), { recursive: true });
  writeFileSync(dir, "not a directory\n");
  let threw = null;
  let r = null;
  try {
    r = claimWrapupLatch("sess-A", "lag", { dir });
  } catch (e) {
    threw = e;
  }
  check(
    "case-37-unwritable-latch-dir-FAILS-OPEN-without-throwing",
    threw === null &&
      r &&
      r.claimed === true &&
      /latch-dir-unwritable/.test(r.reason),
    `threw=${threw} r=${JSON.stringify(r)}`,
  );
});

// case-38 FAIL OPEN — a symlink planted at the latch path. THIS CASE FOUND A
// REAL DEFECT and is kept as its regression pin: `O_NOFOLLOW` does NOT produce
// ELOOP under `O_CREAT|O_EXCL` — POSIX makes a symlink fail EEXIST regardless,
// measured here on darwin — so the first implementation read a planted symlink
// as a prior claim and suppressed. Anyone able to create ONE file could then
// silence this finding for a session whose id they can guess. The claim now
// classifies the entry and honours EEXIST only for a plain regular file.
withLatchDir("38", (dir) => {
  mkdirSync(dir, { recursive: true });
  const decoy = join(dir, "decoy-target");
  writeFileSync(decoy, "x\n");
  symlinkSync(decoy, join(dir, "sess-A.lag"));
  const r = claimWrapupLatch("sess-A", "lag", { dir });
  check(
    "case-38-symlinked-latch-path-FAILS-OPEN-not-suppressed",
    r.claimed === true && /latch-not-a-regular-file/.test(r.reason),
    `got ${JSON.stringify(r)}`,
  );
});

// case-38b COMPLIANT POLE for case-38: a plain REGULAR file at the same path IS
// a real latch and DOES suppress. Without it, case-38 is consistent with a
// classifier that rejects every existing entry — i.e. no latch at all.
withLatchDir("38b", (dir) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sess-A.lag"), "{}\n");
  const r = claimWrapupLatch("sess-A", "lag", { dir });
  check(
    "case-38b-a-real-regular-file-latch-DOES-suppress",
    r.claimed === false && r.reason === "already-reported-this-session",
    `got ${JSON.stringify(r)}`,
  );
});

// case-38c FAIL OPEN — a DIRECTORY at the latch path (the same irregular-entry
// class as the symlink, reached by a different errno path).
withLatchDir("38c", (dir) => {
  mkdirSync(join(dir, "sess-A.lag"), { recursive: true });
  const r = claimWrapupLatch("sess-A", "lag", { dir });
  check(
    "case-38c-directory-at-the-latch-path-FAILS-OPEN",
    r.claimed === true && /latch-/.test(r.reason),
    `got ${JSON.stringify(r)}`,
  );
});

// case-39 TTL sweep: a latch older than LATCH_TTL_MS is removed, and a fresh one
// is NOT. Both poles, because a sweep that deletes everything would silently
// convert the latch back into per-turn firing.
withLatchDir("39", (dir) => {
  mkdirSync(dir, { recursive: true });
  const stale = join(dir, "old-session.lag");
  writeFileSync(stale, "{}\n");
  const oldSecs = (Date.now() - LATCH_TTL_MS - 60_000) / 1000;
  utimesSync(stale, oldSecs, oldSecs);
  const fresh = join(dir, "recent-session.lag");
  writeFileSync(fresh, "{}\n");
  claimWrapupLatch("sess-A", "lag", { dir });
  check(
    "case-39-ttl-sweep-removes-stale-and-keeps-fresh",
    !existsSync(stale) &&
      existsSync(fresh) &&
      existsSync(join(dir, "sess-A.lag")),
    `entries=${JSON.stringify(readdirSync(dir))}`,
  );
});

// case-40 a hostile session_id cannot escape the latch directory.
withLatchDir("40", (dir) => {
  const r = claimWrapupLatch("../../../../etc/pwned", "lag", { dir });
  check(
    "case-40-hostile-session-id-stays-inside-the-latch-dir",
    r.claimed === true &&
      typeof r.path === "string" &&
      r.path.startsWith(dir + "/") &&
      !r.path.includes(".."),
    `got ${JSON.stringify(r)}`,
  );
});

// ───────────────────────────────────────────────────────────────────────────
// D. END-TO-END — drive the real hook process over stdin
// ───────────────────────────────────────────────────────────────────────────

function runHook(root, sessionId = "fx", extraEnv = {}) {
  const home = join(root, ".fixture-home");
  mkdirSync(home, { recursive: true });
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({
      hook_event_name: "Stop",
      session_id: sessionId,
      cwd: root,
    }),
    encoding: "utf8",
    timeout: 30000,
    cwd: root,
    // HOME is redirected so the checkpoint write — and the once-per-session
    // latch, which lives beside it under ~/.claude/hook-state/ — land in the
    // throwaway tree rather than the operator's real home. Two runHook calls on
    // the SAME root therefore share a latch dir, which is what case-41 needs.
    env: { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv },
  });
  let json = null;
  try {
    json = JSON.parse((r.stdout || "").trim().split("\n").pop());
  } catch {
    json = null;
  }
  return { status: r.status, out: r.stdout || "", err: r.stderr || "", json };
}

// Resolve the fragment filename the way the WRITER does, so the e2e poles put
// the file where the hook will look for it on ANY host. Setup-only; see the
// header's oracle-hygiene note.
function ownFragmentHandle(root) {
  const id = resolveIdentity(root, {});
  const p = fragmentPathFor(root, id);
  return p ? p.replace(/^.*\//, "").replace(/\.md$/, "") : null;
}

// case-28 E2E RED POLE: real hook, real repo, stamp behind HEAD → emits a
// systemMessage naming the lag, and STILL exits 0 with continue:true.
withRepo("28", {}, ({ root, git }) => {
  const handle = ownFragmentHandle(root);
  check(
    "case-28a-setup-resolved-a-fragment-handle",
    !!handle,
    "handle was null",
  );
  if (!handle) return;
  const behind = git("rev-parse", "HEAD~2").trim();
  writeFragment(root, handle, `last_reconciled_sha: ${behind}`);
  const r = runHook(root);
  check(
    "case-28b-e2e-red-pole-emits-systemMessage-naming-the-lag",
    r.status === 0 &&
      r.json &&
      r.json.continue === true &&
      typeof r.json.systemMessage === "string" &&
      /2 commit\(s\)/.test(r.json.systemMessage),
    `status=${r.status} json=${JSON.stringify(r.json)} err=${r.err}`,
  );
  check(
    "case-28c-e2e-red-pole-surfaces-a-user-visible-stderr-line",
    /HALT-AND-REPORT/.test(r.err) && /trails HEAD/.test(r.err),
    `err=${r.err}`,
  );
});

// case-29 E2E GREEN POLE: identical tree, stamp == HEAD → the hook says
// NOTHING about wrapup. This is the output the pre-F90 code could not produce.
withRepo("29", {}, ({ root, git }) => {
  const handle = ownFragmentHandle(root);
  if (!handle) {
    check("case-29-setup-resolved-a-fragment-handle", false, "handle was null");
    return;
  }
  const head = git("rev-parse", "HEAD").trim();
  writeFragment(root, handle, `last_reconciled_sha: ${head}`);
  const r = runHook(root);
  check(
    "case-29-e2e-green-pole-emits-bare-continue-and-no-systemMessage",
    r.status === 0 &&
      r.json &&
      r.json.continue === true &&
      r.json.systemMessage === undefined &&
      !/wrapup/i.test(r.err),
    `status=${r.status} json=${JSON.stringify(r.json)} err=${r.err}`,
  );
});

// case-30 E2E: no workspaces dir → silent, exit 0.
withRepo("30", { workspace: false }, ({ root, git }) => {
  const handle = ownFragmentHandle(root);
  if (handle) {
    writeFragment(
      root,
      handle,
      `last_reconciled_sha: ${git("rev-parse", "HEAD~2").trim()}`,
    );
  }
  const r = runHook(root);
  check(
    "case-30-e2e-no-workspace-stays-silent",
    r.status === 0 && r.json && r.json.systemMessage === undefined,
    `status=${r.status} json=${JSON.stringify(r.json)}`,
  );
});

// case-31 E2E: malformed stdin must never take the session close down
// (cc-artifacts.md Rule 7 — fail OPEN).
withRepo("31", {}, ({ root }) => {
  const home = join(root, ".fixture-home");
  mkdirSync(home, { recursive: true });
  const r = spawnSync("node", [HOOK], {
    input: "}{ not json",
    encoding: "utf8",
    timeout: 30000,
    cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  let json = null;
  try {
    json = JSON.parse((r.stdout || "").trim().split("\n").pop());
  } catch {
    json = null;
  }
  check(
    "case-31-e2e-malformed-stdin-fails-open-exit-0",
    r.status === 0 && json && json.continue === true,
    `status=${r.status} out=${r.stdout} err=${r.stderr}`,
  );
});

// case-32 E2E: an ABSENT own fragment now SPEAKS — the coverage F90 lost — and
// says only what absence establishes. The negative half is load-bearing: the
// message must not become the "you did not run /wrapup" claim the check cannot
// make (`instrument-bipolarity.md` MUST-4).
withRepo("32", {}, ({ root }) => {
  const r = runHook(root);
  check(
    "case-32-e2e-absent-fragment-SPEAKS-about-absence-only",
    r.status === 0 &&
      r.json &&
      r.json.continue === true &&
      typeof r.json.systemMessage === "string" &&
      /no session-notes fragment exists|no \.session-notes\.d fragment/i.test(
        r.json.systemMessage,
      ) &&
      !/did not run \/wrapup|Run \/wrapup next time/i.test(
        r.json.systemMessage,
      ),
    `status=${r.status} json=${JSON.stringify(r.json)} err=${r.err}`,
  );
});

// ───────────────────────────────────────────────────────────────────────────
// case-41 THE FREQUENCY POLE PAIR, END TO END: the real hook process, twice, on
// the SAME tree with the SAME session_id and SAME HOME — i.e. sustained lag
// across two turns. Turn 1 speaks; turn 2 is silent. Before the latch this was
// two identical messages, and it would have been one per turn for the life of
// the session. Both runs must still exit 0 with continue:true — throttling the
// message must never touch the session-close contract.
// ───────────────────────────────────────────────────────────────────────────
withRepo("41", {}, ({ root, git }) => {
  const handle = ownFragmentHandle(root);
  if (!handle) {
    check("case-41-setup-resolved-a-fragment-handle", false, "handle was null");
    return;
  }
  writeFragment(
    root,
    handle,
    `last_reconciled_sha: ${git("rev-parse", "HEAD~2").trim()}`,
  );
  const t1 = runHook(root, "sustained-lag-session");
  const t2 = runHook(root, "sustained-lag-session");
  check(
    "case-41-sustained-lag-fires-ONCE-per-session-not-once-per-turn",
    t1.status === 0 &&
      t1.json &&
      typeof t1.json.systemMessage === "string" &&
      /2 commit\(s\)/.test(t1.json.systemMessage) &&
      t2.status === 0 &&
      t2.json &&
      t2.json.continue === true &&
      t2.json.systemMessage === undefined,
    `t1=${JSON.stringify(t1.json)} t2=${JSON.stringify(t2.json)}`,
  );
  // COMPLIANT POLE: a NEW session on the same unchanged tree speaks again.
  // Without it, case-41 is consistent with a latch that silences the finding
  // permanently after its first ever emission.
  const t3 = runHook(root, "a-different-session");
  check(
    "case-41b-a-NEW-session-on-the-same-tree-speaks-again",
    t3.status === 0 &&
      t3.json &&
      typeof t3.json.systemMessage === "string" &&
      /2 commit\(s\)/.test(t3.json.systemMessage),
    `t3=${JSON.stringify(t3.json)} err=${t3.err}`,
  );
});

// case-42 E2E FAIL-OPEN: HOME points at a path where `~/.claude/hook-state/`
// cannot be created (a regular file sits at `~/.claude`). The latch cannot
// install, so the finding is NOT suppressed — twice — and the session still
// closes cleanly both times. This is the `cc-artifacts.md` Rule 7 requirement
// measured rather than asserted: a broken latch degrades to the old firing
// frequency, never to silence and never to a broken close.
withRepo("42", {}, ({ root, git }) => {
  const handle = ownFragmentHandle(root);
  if (!handle) {
    check("case-42-setup-resolved-a-fragment-handle", false, "handle was null");
    return;
  }
  writeFragment(
    root,
    handle,
    `last_reconciled_sha: ${git("rev-parse", "HEAD~2").trim()}`,
  );
  const brokenHome = join(root, ".broken-home");
  mkdirSync(brokenHome, { recursive: true });
  writeFileSync(join(brokenHome, ".claude"), "not a directory\n");
  const one = runHook(root, "broken-latch-session", {
    HOME: brokenHome,
    USERPROFILE: brokenHome,
  });
  const two = runHook(root, "broken-latch-session", {
    HOME: brokenHome,
    USERPROFILE: brokenHome,
  });
  check(
    "case-42-e2e-unwritable-latch-fails-OPEN-and-never-blocks-close",
    one.status === 0 &&
      one.json &&
      one.json.continue === true &&
      /2 commit\(s\)/.test(String(one.json.systemMessage)) &&
      two.status === 0 &&
      two.json &&
      two.json.continue === true &&
      /2 commit\(s\)/.test(String(two.json.systemMessage)),
    `one=${JSON.stringify(one.json)} two=${JSON.stringify(two.json)} err=${one.err}`,
  );
});

// ───────────────────────────────────────────────────────────────────────────
process.stdout.write(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
