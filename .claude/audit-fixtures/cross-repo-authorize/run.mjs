#!/usr/bin/env node
/*
 * Fixture runner for the cross-repo authorization ceremony tool
 * (`.claude/bin/cross-repo-authorize.mjs`) and its command doc.
 *
 *   node .claude/audit-fixtures/cross-repo-authorize/run.mjs
 *
 * Exit 0 = every case behaved as expected; 1 = a regression.
 *
 * WHAT THIS INSTRUMENT CAN AND CANNOT SAY (instrument-discipline.md MUST-1).
 * Each case below names the result it would print were its proposition FALSE.
 * The load-bearing ones drive the REAL guard — `violation-patterns.js::
 * hasCrossRepoAuthorizationReceipt` — against a real temp git repo, so a case
 * asserting "the write authorization survives" fails by printing `write-authorized
 * after read receipt: false`. It is NOT a lexical scan of the tool's source for
 * the strings `wx`/`sha256`: that would pass on a tool that imported the digest
 * and never used it.
 *
 * Every token in every fixture is SYNTHETIC. No real operator display_id, org
 * slug, home path, or repo name appears anywhere under this directory.
 *
 * REGRESSION CASE NAMING (coc-artifact-eval-coverage.md MUST-2): cases whose
 * name is a finding id (`RS-71-*`, `PY-3-C2-*`) are the named regression locks
 * for those findings. The remaining cases are the behavioural floor they sit on.
 */

import "../_lib/no-ambient-git.cjs";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const TOOL = path.join(REPO, ".claude", "bin", "cross-repo-authorize.mjs");
const CMD_DOC = path.join(REPO, ".claude", "commands", "cross-repo-authorize.md");
const GUARD_SRC = path.join(
  REPO,
  ".claude",
  "hooks",
  "lib",
  "violation-patterns.js",
);
const { hasCrossRepoAuthorizationReceipt } = require(GUARD_SRC);

const TARGET = "example-org/example-repo";
const REQUESTER = "fixture-operator";

let passes = 0;
let failures = 0;
function ok(name, detail) {
  passes++;
  process.stdout.write(`PASS ${name}${detail ? ` — ${detail}` : ""}\n`);
}
function bad(name, detail) {
  failures++;
  process.stdout.write(`FAIL ${name}\n`);
  process.stdout.write(`    ${detail}\n`);
}
function check(name, cond, detailOnFail, detailOnPass) {
  if (cond) ok(name, detailOnPass);
  else bad(name, detailOnFail);
}

/* ------------------------------------------------------------------ */
/* Temp-repo harness                                                   */
/* ------------------------------------------------------------------ */

function mkRepo(repoClass) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crauthz-fx-"));
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  if (repoClass !== null) {
    fs.writeFileSync(
      path.join(dir, ".claude", "VERSION"),
      JSON.stringify({ type: repoClass }, null, 2) + "\n",
    );
  }
  return dir;
}

// loom#1352 — HANG BOUND, not a performance budget. Nothing in this fixture asserts
// latency, so this number must never be the thing that fails a run.
//
// It was 20000ms and it FIRED anyway: inside a full parallel fixture sweep this
// runner's wall time inflated 10.8x (6.9s -> 74.6s) and it went 23 pass / 3 fail,
// while scoring 26/26 in isolation and 30/30 on re-run. Measured solo at loadavg 134
// the whole 19-spawn fixture costs 5.32s, i.e. ~280ms per invocation — so 20000ms
// looked like ~70x headroom and still was not enough, because a hang bound has to
// survive the WORST contention the suite can produce, not the average.
//
// So the bound is raised to a value chosen against a hang (120s, matching
// audit-fixture-runner-closure.test.mjs) rather than against the observed cost.
// Raising a bound is normally BLOCKED by `rules/testing.md` § "Complexity Bounds Use
// Self-Normalizing Ratios, Not Absolute Wall-Clock Thresholds" — that clause governs
// DISCRIMINATING thresholds, whose crossing is meant to carry information. This one
// carries none by construction: no check reads elapsed time. The ratio was checked
// first and there is nothing to normalize against.
const TOOL_HANG_BOUND_MS = 120000;

/**
 * Invoke the tool. Returns {status, stdout, stderr, json|null, timedOut}.
 *
 * A SIGTERM'd child writes nothing, so before this change a hang-bound crossing
 * arrived at the checks as an empty stdout with `json === null` — indistinguishable
 * from "the tool ran and emitted no verdict", which is a fault-in-the-tool diagnosis
 * for what is actually a starved subprocess. The timeout is now surfaced explicitly
 * and loudly (`instrument-discipline.md` MUST-1: an errored command is zero evidence,
 * never a verdict).
 */
function runTool(repoDir, args) {
  const r = spawnSync("node", [TOOL, "--repo-root", repoDir, ...args], {
    cwd: repoDir,
    encoding: "utf8",
    timeout: TOOL_HANG_BOUND_MS,
  });
  const timedOut = r.signal === "SIGTERM" || (r.error && r.error.code === "ETIMEDOUT");
  let stderr = r.stderr || "";
  if (timedOut) {
    const banner =
      `TIMEOUT: the tool hit the ${TOOL_HANG_BOUND_MS}ms HANG BOUND and was killed. ` +
      `This is a TIMEOUT, not a tool failure — it produced no verdict because it was ` +
      `SIGTERM'd mid-run, so any check below reporting "no JSON" is reporting the kill, ` +
      `not the tool's behaviour. Re-run on a quieter host before treating it as a defect.`;
    process.stdout.write(`    !! ${banner}\n`);
    stderr = stderr ? `${banner}\n${stderr}` : banner;
  }
  let json = null;
  if (r.stdout && r.stdout.trim().startsWith("{")) {
    try {
      json = JSON.parse(r.stdout);
    } catch {
      /* not json */
    }
  }
  return { status: r.status, stdout: r.stdout || "", stderr, json, timedOut };
}

function authzDir(repoDir) {
  return path.join(repoDir, ".claude", "cross-repo-authz");
}
function listReceipts(repoDir) {
  try {
    return fs.readdirSync(authzDir(repoDir)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
}
function rmRepo(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/* ------------------------------------------------------------------ */
/* 0. Positive control — the instrument fires HERE                     */
/*    (instrument-discipline.md MUST-3(a))                             */
/* ------------------------------------------------------------------ */
{
  const repo = mkRepo("coc-project");
  const r = runTool(repo, [
    "--target", TARGET,
    "--action", "control probe: prove the harness writes and the guard reads",
    "--mode", "write",
    "--instruction", "control",
    "--requester", REQUESTER,
    "--json",
  ]);
  const wrote = listReceipts(repo).length === 1;
  const guardSees = hasCrossRepoAuthorizationReceipt(TARGET, repo, "write");
  check(
    "control-harness-writes-and-guard-reads",
    r.status === 0 && wrote && guardSees === true,
    `exit=${r.status} receipts=${listReceipts(repo).length} guardSeesWrite=${guardSees}. ` +
      `If this case fails, EVERY result below is uninterpretable — the harness could not ` +
      `produce a receipt the real guard accepts, so a later "no receipt" is indistinguishable ` +
      `from a broken harness.`,
    "known-answer case: receipt written, real guard returns true",
  );
  // Falsifying result if the guard were NOT wired to this dir: guardSeesWrite=false here.
  rmRepo(repo);
}

/* ------------------------------------------------------------------ */
/* 1. RS-71 — silent receipt overwrite / PROVEN TIER DEFEAT            */
/* ------------------------------------------------------------------ */
{
  // RS-71-tier-defeat-measured: the exact defeat RECON-C measured —
  // a cheap `--mode read` receipt destroying an existing `write` authorization.
  const repo = mkRepo("coc-project");
  const ACTION = "file an issue about the null-bind on the shared path";

  runTool(repo, [
    "--target", TARGET, "--action", ACTION, "--mode", "write",
    "--instruction", "please file that issue", "--requester", REQUESTER, "--json",
  ]);
  const beforeWrite = hasCrossRepoAuthorizationReceipt(TARGET, repo, "write");

  runTool(repo, [
    "--target", TARGET, "--action", ACTION, "--mode", "read",
    "--requester", REQUESTER, "--json",
  ]);
  const afterWrite = hasCrossRepoAuthorizationReceipt(TARGET, repo, "write");

  check(
    "RS-71-tier-defeat-measured",
    beforeWrite === true && afterWrite === true,
    `write-authorized before read receipt: ${beforeWrite}; after: ${afterWrite}. ` +
      `A read receipt MUST NOT revoke an existing write authorization. ` +
      `(RECON-C measured exactly true→false here against the pre-fix tool.)`,
    "write authorization survives a same-(target,action) read receipt",
  );

  // ISOLATES the digest property, NOT the wx-retry that also happens to keep
  // both files. A mutant dropping `mode` from the triple still yields two files
  // — `<base>.md` and `<base>-2.md` — because the no-clobber retry catches it.
  // (Measured: replacing `mode` with a constant left this case green when it
  // only counted files.) Requiring two files whose BASE names differ, and
  // neither of which is the other's `-N` sibling, is what makes a mode-dropout
  // red HERE rather than silently leaning on the second mechanism.
  const files = listReceipts(repo);
  const bases = files.map((f) => f.replace(/(?:-\d+)?\.md$/, ""));
  const distinctBases = new Set(bases).size === 2;
  check(
    "RS-71-mode-in-filename-digest",
    files.length === 2 && distinctBases,
    `receipts on disk: ${JSON.stringify(files)} (base names: ${JSON.stringify(bases)}). ` +
      `Expected 2 files with DISTINCT base names — the write and read receipts must be ` +
      `separated by the filename digest itself (mode is in the triple), not merely kept ` +
      `apart by the no-clobber \`-N\` retry. One file, or two \`-N\` siblings of one base, ` +
      `means the digest does not discriminate on mode.`,
    "write and read receipts carry DISTINCT filename digests (mode is in the triple)",
  );
  rmRepo(repo);
}

{
  // RS-71-no-silent-clobber: the SAME triple twice must never silently destroy
  // the first receipt. Either both survive, or the second write is refused LOUDLY.
  const repo = mkRepo("coc-project");
  const ACTION = "read the methodology specs for alignment";
  const first = runTool(repo, [
    "--target", TARGET, "--action", ACTION, "--mode", "read",
    "--requester", REQUESTER, "--json",
  ]);
  const firstFile = first.json && first.json.receipt;
  const firstBody = firstFile
    ? fs.readFileSync(path.join(repo, firstFile), "utf8")
    : null;

  const second = runTool(repo, [
    "--target", TARGET, "--action", ACTION, "--mode", "read",
    "--requester", REQUESTER, "--json",
  ]);
  const firstStillIntact =
    firstBody !== null &&
    fs.existsSync(path.join(repo, firstFile)) &&
    fs.readFileSync(path.join(repo, firstFile), "utf8") === firstBody;
  const refusedLoudly = second.status !== 0;

  check(
    "RS-71-no-silent-clobber",
    firstStillIntact || refusedLoudly,
    `second invocation exit=${second.status}; first receipt intact=${firstStillIntact}. ` +
      `The pre-fix tool rewrote the same path with a new timestamp — a silent destruction ` +
      `of the prior forensic witness, with exit 0 and no warning.`,
    firstStillIntact
      ? "first receipt byte-identical after a second same-triple run"
      : "second same-triple write refused loudly (non-zero exit)",
  );
  rmRepo(repo);
}

{
  // RS-71-truncation-collision: the pre-fix filename slug is truncated at 48
  // chars, so two DISTINCT actions sharing a 48-char prefix collide on one file.
  const repo = mkRepo("coc-project");
  const PREFIX = "read the deeply nested configuration directory tree under";
  const a = runTool(repo, [
    "--target", TARGET, "--action", `${PREFIX} alpha`, "--mode", "read",
    "--requester", REQUESTER, "--json",
  ]);
  const b = runTool(repo, [
    "--target", TARGET, "--action", `${PREFIX} bravo`, "--mode", "read",
    "--requester", REQUESTER, "--json",
  ]);
  const files = listReceipts(repo);
  const distinct =
    files.length === 2 ||
    // A loud refusal on the second is also acceptable (never silent).
    b.status !== 0;
  check(
    "RS-71-truncation-collision",
    distinct,
    `two DISTINCT actions sharing a 48-char slug prefix produced ${files.length} ` +
      `receipt file(s): ${JSON.stringify(files)} (second exit=${b.status}). ` +
      `A truncated slug cannot discriminate the actions, so one authorization ` +
      `silently replaced the other.`,
    "distinct actions with a shared 48-char prefix land in distinct files",
  );
  void a;
  rmRepo(repo);
}

{
  // RS-71-read-receipt-never-clears-write: the tier invariant at the GUARD, not
  // the filename. A read-only repo state must never clear a write action.
  const repo = mkRepo("coc-project");
  runTool(repo, [
    "--target", TARGET, "--action", "read one file", "--mode", "read",
    "--requester", REQUESTER, "--json",
  ]);
  const clearsWrite = hasCrossRepoAuthorizationReceipt(TARGET, repo, "write");
  const clearsRead = hasCrossRepoAuthorizationReceipt(TARGET, repo, "read");
  check(
    "RS-71-read-receipt-never-clears-write",
    clearsWrite === false && clearsRead === true,
    `read receipt cleared write=${clearsWrite} (MUST be false), read=${clearsRead} (MUST be true)`,
    "read receipt clears a read action and does not clear a write action",
  );
  rmRepo(repo);
}

/* ------------------------------------------------------------------ */
/* 2. Fail-closed defaults (must survive any edit to this surface)     */
/* ------------------------------------------------------------------ */
{
  const repo = mkRepo("coc-project");
  const noMode = runTool(repo, [
    "--target", TARGET, "--action", "do a thing", "--requester", REQUESTER,
  ]);
  check(
    "fail-closed-mode-required",
    noMode.status === 1 && /mode/.test(noMode.stderr),
    `omitted --mode: exit=${noMode.status} stderr=${JSON.stringify(noMode.stderr.trim())} ` +
      `— an absent mode MUST NOT default to anything; it must be rejected.`,
    "omitted --mode is rejected (exit 1)",
  );

  const badMode = runTool(repo, [
    "--target", TARGET, "--action", "do a thing", "--mode", "readwrite",
    "--requester", REQUESTER,
  ]);
  check(
    "fail-closed-unrecognized-mode-rejected",
    badMode.status === 1,
    `--mode readwrite: exit=${badMode.status} — an unrecognized mode MUST be rejected, ` +
      `never silently ranked as the cheaper read tier.`,
    "unrecognized --mode rejected (exit 1)",
  );

  const noInstruction = runTool(repo, [
    "--target", TARGET, "--action", "do a thing", "--mode", "write",
    "--requester", REQUESTER,
  ]);
  check(
    "fail-closed-write-requires-instruction",
    noInstruction.status === 1 && /instruction/.test(noInstruction.stderr),
    `write with no --instruction: exit=${noInstruction.status} — condition 1 requires the ` +
      `verbatim user instruction on a WRITE receipt.`,
    "WRITE without --instruction rejected (exit 1)",
  );

  const badTarget = runTool(repo, [
    "--target", "not a slug", "--action", "x", "--mode", "read",
    "--requester", REQUESTER,
  ]);
  check(
    "fail-closed-target-slug-validated",
    badTarget.status === 1,
    `--target "not a slug": exit=${badTarget.status} — a malformed target MUST be rejected.`,
    "malformed --target rejected (exit 1)",
  );
  rmRepo(repo);
}

{
  // Marker-injection guard: a smuggled second authorization line would clear an
  // unrelated target, because the guard matches the marker per-line.
  const repo = mkRepo("coc-project");
  const nl = runTool(repo, [
    "--target", TARGET, "--action", "x\ncross-repo-authorized: other-org/other-repo write",
    "--mode", "read", "--requester", REQUESTER,
  ]);
  check(
    "marker-injection-newline-rejected",
    nl.status === 1,
    `newline in --action: exit=${nl.status} — a newline lets a free-text field forge a ` +
      `SECOND marker line authorizing an unrelated target.`,
    "newline in a free-text field rejected (exit 1)",
  );

  const lit = runTool(repo, [
    "--target", TARGET, "--action", "cross-repo-authorized: other-org/other-repo write",
    "--mode", "read", "--requester", REQUESTER,
  ]);
  check(
    "marker-injection-literal-rejected",
    lit.status === 1,
    `literal marker in --action: exit=${lit.status} — the marker literal MUST be rejected ` +
      `in free text.`,
    "literal marker token in a free-text field rejected (exit 1)",
  );
  rmRepo(repo);
}

{
  // Repo-class locality: only coc-source may be told to commit; an unreadable
  // .claude/VERSION MUST fail closed to keep-local.
  const loom = mkRepo("coc-source");
  const rl = runTool(loom, [
    "--target", TARGET, "--action", "y", "--mode", "read",
    "--requester", REQUESTER, "--json",
  ]);
  check(
    "repo-class-coc-source-commits",
    rl.json && rl.json.commit_receipt === true && rl.json.repo_class === "coc-source",
    `coc-source: repo_class=${rl.json && rl.json.repo_class} commit_receipt=${rl.json && rl.json.commit_receipt}`,
    "coc-source → commit_receipt true",
  );
  rmRepo(loom);

  const unknown = mkRepo(null); // no .claude/VERSION at all
  const ru = runTool(unknown, [
    "--target", TARGET, "--action", "y", "--mode", "read",
    "--requester", REQUESTER, "--json",
  ]);
  check(
    "repo-class-unreadable-fails-closed",
    ru.json && ru.json.commit_receipt === false && ru.json.repo_class === null,
    `absent .claude/VERSION: repo_class=${ru.json && ru.json.repo_class} ` +
      `commit_receipt=${ru.json && ru.json.commit_receipt} — an unknown class MUST fail closed ` +
      `to keep-local; the cost of a wrong "commit" is an operator display_id in a public history.`,
    "absent .claude/VERSION → commit_receipt false (fail-closed)",
  );
  rmRepo(unknown);

  const build = mkRepo("coc-build");
  const rb = runTool(build, [
    "--target", TARGET, "--action", "y", "--mode", "read",
    "--requester", REQUESTER, "--json",
  ]);
  check(
    "repo-class-coc-build-keeps-local",
    rb.json && rb.json.commit_receipt === false,
    `coc-build: commit_receipt=${rb.json && rb.json.commit_receipt} — MUST be false.`,
    "coc-build → commit_receipt false",
  );
  rmRepo(build);
}

{
  // The receipt MUST carry the frontmatter `timestamp:` the guard ages it by.
  // Without it `_receiptTimestampMs` returns null and the receipt is treated as
  // stale — the ceremony would write a receipt that authorizes nothing.
  const repo = mkRepo("coc-project");
  const r = runTool(repo, [
    "--target", TARGET, "--action", "z", "--mode", "read",
    "--requester", REQUESTER, "--json",
  ]);
  const body = r.json ? fs.readFileSync(path.join(repo, r.json.receipt), "utf8") : "";
  check(
    "receipt-carries-frontmatter-timestamp",
    /^timestamp:\s*\S+$/m.test(body),
    `no line-anchored \`timestamp:\` in the receipt frontmatter — the guard ages receipts ` +
      `by this field (violation-patterns.js::_receiptTimestampMs), so its absence makes ` +
      `every receipt read as stale.`,
    "receipt frontmatter carries a line-anchored timestamp:",
  );
  check(
    "receipt-marker-is-tier-qualified",
    new RegExp(`^cross-repo-authorized:[ \\t]+example-org/example-repo[ \\t]+read[ \\t]*$`, "m").test(body),
    `the marker line does not match the guard's anchored matcher ` +
      `\`^cross-repo-authorized:[ \\t]+<slug>[ \\t]+(read|write)[ \\t]*$\`; a two-token marker ` +
      `without the mode does NOT clear the guard.`,
    "marker line matches the guard's anchored tier-qualified matcher",
  );
  rmRepo(repo);
}

/* ------------------------------------------------------------------ */
/* 3. PY-3-C2 — doc/code accuracy: mtime vs frontmatter timestamp      */
/* ------------------------------------------------------------------ */
{
  const toolSrc = fs.readFileSync(TOOL, "utf8");
  const docSrc = fs.readFileSync(CMD_DOC, "utf8");

  // Control: prove the matcher fires HERE, on a string known to be present.
  const controlFires = /cross-repo-authorized/.test(toolSrc);
  check(
    "control-doc-matcher-fires-here",
    controlFires,
    `the /cross-repo-authorized/ control did not match ${TOOL} — the doc matchers below ` +
      `cannot be read as evidence.`,
    "control string matched: the doc matchers can emit a hit here",
  );

  // The matcher targets the false CLAIM shape, not the token. A correction
  // necessarily NAMES mtime in order to repudiate it ("ages by frontmatter,
  // NOT by mtime"), so a bare /mtime/ scan cannot tell a fixed file from a
  // broken one — it would flag both. Its four top-level alternatives are the
  // pre-fix claim forms; the control below proves each one fires, per-alternative
  // and in isolation, on a sample that exercises it. It does NOT read the
  // historical file — see the control's own note for why that dependency was
  // removed and what the isolation buys.
  const FALSE_MTIME_CLAIM =
    /mtime window|matches on file mtime|within (?:an|its|the) mtime|greppable within the hook's mtime/gi;

  // POSITIVE CONTROL (instrument-discipline.md MUST-3(a)): fire the matcher at
  // a known-answer case. Without it, the two checks below are worthless — their
  // silence would be indistinguishable from a matcher that cannot match.
  //
  // The known-answer case is an INLINE LITERAL, deliberately. Two earlier shapes
  // were both wrong, and the second is why this one is inline:
  //
  //   `git show HEAD:<tool>` — correct only while the fix was UNCOMMITTED
  //   (working tree fixed, HEAD still pre-fix). The moment the fix committed,
  //   HEAD BECAME the fixed file, so the control found 0 and reddened ON SUCCESS.
  //
  //   `git show <PRE_FIX_SHA>:<tool>` — fixed that, but introduced a git-history
  //   dependency this fixture family does not have. MEASURED in a `--depth=1`
  //   clone: `git show` fails, controlHits stays -1, the runner reds with
  //   "matcher found -1 hits" — a message that mis-diagnoses an absent object as
  //   an unfirable matcher. CI's `actions/checkout@v4` carries no `fetch-depth`,
  //   so it defaults to 1, and this was the ONLY fixture in the family naming a
  //   historical SHA (its siblings use `HEAD:`, which is depth-1-safe). The CI
  //   step's own comment declares this family "Hermetic: node built-ins + the
  //   runners' own temp trees" — a pinned-SHA read contradicted that.
  //
  // PER-ALTERNATIVE ISOLATION, not a joint tally. A joint count over one blob is
  // a LOSSY PROJECTION: the alternatives mask each other, so the number stays 4
  // while the matched SET changes. Measured on the previous shape (deletion
  // matrix, with DELETE-A2 → 3 as the positive control proving mutations reach
  // the counter): deleting A1, A3 or A4 ALL still totalled 4 and passed. `mtime
  // window` never fired at all — A3/A4 match leftmost and consume "mtime", so
  // three lines that contain "mtime window" were attributed elsewhere, A3 was
  // counted twice, and A1 was dead. An exact joint count caught 1 of 4 deletions
  // while its own comment claimed it caught all of them.
  //
  // So each alternative is matched against its OWN single-alternative regex over
  // a sample that exercises it. Scope this arm honestly: it is a SAMPLE-INTEGRITY
  // check, not a matcher check — measured, it fires on NONE of the five union
  // mutations, because the isolated regex is a COPY and the copy survives a
  // deletion from the union. What catches union mutations is the set pin below.
  //
  // Each entry declares the union `fragment` it covers, and EXPECTED is DERIVED
  // from that — one declaration, not two. An earlier shape kept a separate
  // EXPECTED list with no asserted relation to the samples, and adding an
  // alternative to BOTH the union and EXPECTED while shipping NO sample passed
  // the gate with zero coverage.
  //
  // The first four samples are the ACTUAL pre-fix lines from cd69f75c6346
  // (verbatim, including the surrounding comment/string punctuation — real prose
  // has leading `* ` / `// ` and trailing text, and a matcher edit sensitive to
  // adjacent characters must fail here rather than pass on cleaner synthetic
  // lines). The last two cover sub-forms the real file never exercised: the bare
  // `mtime window` alternative, and A3's `the` branch.
  const CLAIM_ALTERNATIVES = [
    {
      name: "A4 greppable-within-the-hooks-mtime",
      fragment: "greppable within the hook's mtime",
      re: /greppable within the hook's mtime/i,
      sample:
        "* working-tree file, greppable within the hook's mtime window; ENFORCEMENT never",
    },
    {
      name: "A2 matches-on-file-mtime",
      fragment: "matches on file mtime",
      re: /matches on file mtime/i,
      sample:
        "// human ordering, but the hook matches on file mtime, not the filename date.",
    },
    {
      name: "A3-its within-its-mtime",
      fragment: "within (?:an|its|the) mtime",
      re: /within its mtime/i,
      sample:
        "marker line in the WORKING TREE within its mtime window — not in git — so",
    },
    {
      name: "A3-an within-an-mtime",
      fragment: "within (?:an|its|the) mtime",
      re: /within an mtime/i,
      sample:
        "`       WORKING TREE within an mtime window, so enforcement is unaffected. Committing`,",
    },
    {
      name: "A3-the within-the-mtime",
      fragment: "within (?:an|its|the) mtime",
      re: /within the mtime/i,
      sample: "a receipt is treated as live within the mtime it was written in",
    },
    {
      name: "A1 bare-mtime-window",
      fragment: "mtime window",
      re: /mtime window/i,
      // Deliberately carries NO other claim form, so A1 is the only alternative
      // that can match it. This is the sample the previous shape lacked entirely.
      sample: "the receipt is live inside the mtime window",
    },
  ];
  const uncovered = CLAIM_ALTERNATIVES.filter((a) => !a.re.test(a.sample)).map(
    (a) => a.name,
  );

  // ALTERNATIVE-SET PIN. The isolation check above proves each SAMPLE exercises
  // its alternative's PATTERN — but it matches a hand-written copy of that
  // pattern, NOT the alternative as it exists in FALSE_MTIME_CLAIM. Measured:
  // deleting A4 from the union still PASSED, because the copy kept matching and
  // the A4 sample fell through to A1 (`mtime window`) in the joint count. Same
  // shadowing, one level up.
  //
  // So pin the union's top-level alternatives, DERIVED from the live regex
  // source, against the fragments CLAIM_ALTERNATIVES declares. Deleting or
  // corrupting any alternative changes the set and reds immediately, independent
  // of what any sample happens to match. Verified by deletion matrix: all four
  // deletions and a one-character corruption red; baseline passes.
  //
  // EXPECTED is derived from the samples' own `fragment` fields — ONE declaration.
  // A separate hand-kept list let an alternative be added to both the union and
  // the list with NO sample, passing the gate with zero coverage.
  const EXPECTED_ALTERNATIVES = [
    ...new Set(CLAIM_ALTERNATIVES.map((a) => a.fragment)),
  ];
  const parsed = FALSE_MTIME_CLAIM.source.split("|").reduce(
    (acc, part) => {
      // `(?:an|its|the)` contains bare `|`, so a naive split fragments it.
      // Re-join fragments until parens balance.
      const open = (acc.pending + part).split("(").length - 1;
      const close = (acc.pending + part).split(")").length - 1;
      acc.pending = acc.pending ? `${acc.pending}|${part}` : part;
      if (open === close) {
        acc.out.push(acc.pending);
        acc.pending = "";
      }
      return acc;
    },
    { out: [], pending: "" },
  );
  const actualAlternatives = parsed.out;
  // LOSSLESS-PARSE ASSERTION. A TRAILING alternative whose parens never balance
  // leaves `pending` unflushed and is silently DROPPED — the derived set still
  // equalled EXPECTED and the gate passed, while the added alternative genuinely
  // matched text. Measured: `|mtime \(window`, `|mtime [(] window` and
  // `|aged \(by mtime` all passed; a balanced `|aged by mtime` control reddened,
  // proving the harness discriminates. Round-tripping the parse makes a dropped
  // fragment impossible rather than invisible.
  const parseLossy = actualAlternatives.join("|") !== FALSE_MTIME_CLAIM.source;
  // Every parsed fragment must be claimed by >=1 sample entry, and vice versa.
  // Set equality alone does not give this — see the EXPECTED note above.
  const unclaimed = actualAlternatives.filter(
    (f) => !CLAIM_ALTERNATIVES.some((a) => a.fragment === f),
  );
  const setDrift = parseLossy
    ? `matcher source did not round-trip through the alternative parse — a fragment was dropped (unflushed: "${parsed.pending}"). Derived [${actualAlternatives.join(" ][ ")}] rejoins to "${actualAlternatives.join("|")}" but source is "${FALSE_MTIME_CLAIM.source}"`
    : unclaimed.length
      ? `matcher alternative(s) [${unclaimed.join(" ][ ")}] have no sample in CLAIM_ALTERNATIVES — they would ship with zero coverage`
      : JSON.stringify([...actualAlternatives].sort()) !==
          JSON.stringify([...EXPECTED_ALTERNATIVES].sort())
        ? `matcher alternatives are [${actualAlternatives.join(" ][ ")}], samples declare [${EXPECTED_ALTERNATIVES.join(" ][ ")}]`
        : "";
  // The joint count is a SAMPLE-SIDE arm, and its rationale is stated narrowly
  // because two earlier versions of this comment claimed cases the bytes refute.
  // Measured attribution over the union mutations: the set pin catches all five;
  // the joint count adds nothing on any of them, and is SILENT on DELETE-A4 —
  // which an earlier comment cited as its motivating example. It earns its keep
  // on exactly one case the set pin cannot see: a SAMPLE gaining a second claim
  // form, which reads 7 against 6 samples and reds here alone.
  const controlHits = (
    CLAIM_ALTERNATIVES.map((a) => a.sample)
      .join("\n")
      .match(FALSE_MTIME_CLAIM) || []
  ).length;
  check(
    "control-mtime-claim-matcher-fires-on-prefix-bytes",
    uncovered.length === 0 &&
      controlHits === CLAIM_ALTERNATIVES.length &&
      setDrift === "",
    `FALSE_MTIME_CLAIM coverage FAILED. ${setDrift ? `ALTERNATIVE-SET DRIFT: ${setDrift}. ` : ""}` +
      `Uncovered alternative(s): ` +
      `[${uncovered.join(", ") || "none"}] — each is matched in ISOLATION against its own ` +
      `single-alternative regex, so a name here means THAT alternative stopped firing on a ` +
      `sample that exercises it. Joint hits ${controlHits}, expected ` +
      `${CLAIM_ALTERNATIVES.length} (one per sample). A matcher never shown to fire HERE ` +
      `cannot have its empty result read as "the claim is gone", so the two checks below are ` +
      `unreadable until this passes. No git object is consulted — a failure means the matcher ` +
      `and these samples have drifted apart, nothing else. Do NOT "fix" it by relaxing the ` +
      `count: a joint tally masks deletions (A1/A3/A4 shadow each other), which is why this ` +
      `asserts per-alternative isolation.`,
    `all ${CLAIM_ALTERNATIVES.length} claim alternatives fire in isolation (joint hits ${controlHits}) — the silence below is readable`,
  );

  const toolHits = toolSrc.match(FALSE_MTIME_CLAIM) || [];
  const docHits = docSrc.match(FALSE_MTIME_CLAIM) || [];

  check(
    "PY-3-C2-tool-drops-mtime-claim",
    toolHits.length === 0,
    `${toolHits.length} mtime-as-age-mechanism claim(s) remain in ${path.relative(REPO, TOOL)}: ` +
      `${JSON.stringify(toolHits)}. ` +
      `The guard repudiates mtime (violation-patterns.js:126-133 — "Age is derived from the ` +
      `receipt's own timestamp:/date: FRONTMATTER, NOT filesystem mtime"). A doc claiming an ` +
      `mtime window caused a real misdiagnosis: a receipt believed live had expired two days ` +
      `earlier, making an "enforcement preserved" check true but VACUOUS.`,
    "no mtime claim remains in the tool",
  );
  check(
    "PY-3-C2-cmd-doc-drops-mtime-claim",
    docHits.length === 0,
    `${docHits.length} mtime-as-age-mechanism claim(s) remain in ` +
      `${path.relative(REPO, CMD_DOC)}: ${JSON.stringify(docHits)}.`,
    "no mtime-as-age-mechanism claim remains in the command doc",
  );
  check(
    "PY-3-C2-tool-names-frontmatter-window",
    /frontmatter/i.test(toolSrc) && /timestamp/i.test(toolSrc),
    `the tool does not name the FRONTMATTER-timestamp mechanism the guard actually uses; ` +
      `deleting the wrong claim without stating the right one leaves the reader with nothing.`,
    "tool names the frontmatter-timestamp window",
  );
  check(
    "PY-3-C2-cmd-doc-names-frontmatter-window",
    /frontmatter/i.test(docSrc),
    `the command doc does not name the FRONTMATTER-timestamp mechanism.`,
    "command doc names the frontmatter-timestamp window",
  );

  // The stale line anchors. `symbol-anchored-citations` — a bare <path>:<line>
  // never stands alone; both cited anchors pointed at unrelated content.
  const staleAnchors = [
    ["cross-repo-authorize.mjs:158", /cross-repo-authorize\.mjs:158/],
    ["violation-patterns.js:139-142", /violation-patterns\.js:139-142/],
  ];
  for (const [label, re] of staleAnchors) {
    check(
      `PY-3-C2-stale-anchor-${label.replace(/[^a-z0-9]+/gi, "-")}`,
      !re.test(docSrc),
      `the command doc still cites \`${label}\`, which resolves to unrelated content ` +
        `(measured: \`sed -n '158p'\` prints the readRepoClass readFileSync line; ` +
        `\`sed -n '139,142p'\` prints the SKEW constant). A bare line anchor drifts the ` +
        `moment the cited file is edited — cite a grep-stable symbol.`,
      `stale anchor ${label} removed`,
    );
  }
  check(
    "PY-3-C2-cmd-doc-uses-symbol-anchors",
    /violation-patterns\.js::hasCrossRepoAuthorizationReceipt/.test(docSrc),
    `the command doc no longer carries a grep-stable \`::symbol\` anchor for the guard.`,
    "command doc cites the guard by grep-stable ::symbol anchor",
  );
}

/* ------------------------------------------------------------------ */
/* 4. INGESTED FROM THE USE-TEMPLATE LANE (T7–T14)                     */
/*                                                                     */
/* These lock the capabilities merged in from `kailash-coc-rs`'s copy   */
/* of this tool: `readReaderWindows` (the writer PARSES the guard's     */
/* window instead of re-declaring it), `receiptLiveness` +              */
/* `writeReceiptImmutable` (refuse only against a receipt confirmed     */
/* LIVE; otherwise write a time-suffixed fresh one), the `isFile()`     */
/* dirent fence (writer and guard must agree on WHICH entries are       */
/* receipts), the U+2028/U+2029 LineTerminator class, and the           */
/* `.claude/VERSION::type` charset fence.                              */
/*                                                                     */
/* A capability without its lock is unlocked: each case below names     */
/* the result it prints when its proposition is FALSE.                  */
/* ------------------------------------------------------------------ */

// Rewrite a receipt's `timestamp:` to simulate the passage of time. This is the
// field the guard bounds age by (violation-patterns.js::_receiptTimestampMs), so
// backdating it is behaviorally identical to waiting. The FILENAME is untouched,
// which is exactly the date-vs-window collision these cases are about.
function backdate(repo, file, msAgo) {
  const fp = path.join(authzDir(repo), file);
  const iso = new Date(Date.now() - msAgo).toISOString();
  const s = fs
    .readFileSync(fp, "utf8")
    .replace(/^timestamp: .*$/m, `timestamp: ${iso}`);
  fs.writeFileSync(fp, s);
  return iso;
}

const utcDate = () => new Date().toISOString().slice(0, 10);

// The guard's window, read from its declaration site — used ONLY to pick
// interesting ages for T11. The assertion there is tool-vs-guard AGREEMENT,
// which stands whatever this parses to.
const WINDOW_MS = (() => {
  const m = fs
    .readFileSync(GUARD_SRC, "utf8")
    .match(/^const CROSS_REPO_RECEIPT_WINDOW_MS\s*=\s*([0-9 *+]+);/m);
  return m
    ? m[1]
        .split("+")
        .reduce(
          (s, t) => s + t.split("*").reduce((p, f) => p * Number(f.trim()), 1),
          0,
        )
    : 6 * 60 * 60 * 1000;
})();

const A_ACT =
  "file a Step-7c upflow proposal PR to the template inbox for the scanner defect";
const WARGS = (act) => [
  "--target", "acme/one", "--mode", "write",
  "--action", act || A_ACT, "--instruction", "do A",
];

/* T7 — same-UTC-day re-authorization AFTER the window (the expiry deadlock). */
{
  const repo = mkRepo("coc-project");
  const d0 = utcDate();
  runTool(repo, WARGS());
  const firstName = listReceipts(repo)[0];
  // 7h elapsed: past the 6h window, same UTC date-slot ⇒ same base filename.
  const backdated = backdate(repo, firstName, 7 * 60 * 60 * 1000);

  // The RED state, established BEFORE anything is claimed about it: the guard has
  // already expired this receipt, so at this instant NOTHING authorizes the action.
  check(
    "T7-precondition-aged-receipt-authorizes-nothing",
    hasCrossRepoAuthorizationReceipt("acme/one", repo, "write") === false,
    `guard still returns true for a receipt aged ${7}h past a ${WINDOW_MS / 3600000}h window — ` +
      `the receipt was not actually aged, so the scenario below did not reproduce and its ` +
      `result is uninterpretable.`,
    `timestamp backdated to ${backdated} → guard false (red established)`,
  );

  const second = runTool(repo, WARGS());
  const files = listReceipts(repo);

  if (utcDate() !== d0) {
    check(
      "T7-SCENARIO-DID-NOT-REPRODUCE-utc-date-rolled-over",
      false,
      "the UTC date rolled over mid-test, so the two runs no longer share a base filename — re-run the suite",
      "",
    );
  } else {
    check(
      "T7-reauthorization-after-expiry-succeeds",
      second.status === 0,
      `exit=${second.status} :: ${(second.stderr || "").trim().split("\n")[0]}. ` +
        `exit 1 = the expiry deadlock: the tool refuses, claiming an authorization the guard ` +
        `has ALREADY expired. Up to 18h/day per (target, action, mode) with no way to ` +
        `re-authorize, and the operator's escape is \`rm\` — destroying a receipt.`,
      "expired receipt is superseded, not deadlocked (exit 0)",
    );
    check(
      "T7-fresh-receipt-lands-at-non-colliding-path",
      files.length === 2,
      `${files.length} file(s): ${JSON.stringify(files)} — expected 2. One file means no fresh ` +
        `receipt was written despite the old one being dead.`,
      `second receipt written beside the dead one: ${JSON.stringify(files)}`,
    );
    check(
      "T7-guard-honours-the-refreshed-authorization",
      hasCrossRepoAuthorizationReceipt("acme/one", repo, "write") === true,
      `guard returns false after the refresh — the tool exited 0 but produced nothing the ` +
        `guard will honour, which is WORSE than the refusal it replaced.`,
      "guard finds a live authorization after the refresh",
    );
  }
  check(
    "T7-original-receipt-survives-untouched",
    fs
      .readFileSync(path.join(authzDir(repo), firstName), "utf8")
      .includes(`timestamp: ${backdated}`),
    `the original receipt's timestamp changed or the file is gone — the refresh CLOBBERED the ` +
      `audit record that \`wx\` exists to protect.`,
    "original receipt byte-preserved across the refresh (immutability holds)",
  );
  rmRepo(repo);
}

/* T8 — the refusal's CLAIM must be TRUE: refuse only against a LIVE receipt. */
{
  const repo = mkRepo("coc-project");
  runTool(repo, WARGS());
  const again = runTool(repo, WARGS());
  check(
    "T8-fresh-duplicate-is-refused-no-receipt-spam",
    again.status === 1 && listReceipts(repo).length === 1,
    `exit=${again.status}, receipts=${listReceipts(repo).length}. exit 0 = the liveness fix ` +
      `over-corrected into writing a receipt per invocation, so the directory fills with ` +
      `duplicates and the "refuse" half of the invariant is gone.`,
    "a still-live duplicate is refused (exit 1) and no second receipt is written",
  );
  check(
    "T8-refusal-claim-is-true-at-that-moment",
    hasCrossRepoAuthorizationReceipt("acme/one", repo, "write") === true,
    `the tool said "already authorizes this action" while the guard returns FALSE — the tool ` +
      `asserted an authorization the guard does not honour, and the guard is halt-and-report, ` +
      `so an agent proceeds on that false assurance.`,
    "tool says 'already authorizes' AND the guard independently agrees",
  );
  rmRepo(repo);
}

/* T9 — a truncated receipt must not poison the path permanently. */
{
  const repo = mkRepo("coc-project");
  runTool(repo, WARGS());
  const name = listReceipts(repo)[0];
  // Exactly what an ENOSPC/EIO mid-write leaves behind: the file exists, so `wx`
  // refuses forever, but it carries no marker so the guard refuses it too.
  fs.writeFileSync(path.join(authzDir(repo), name), "");
  check(
    "T9-precondition-truncated-receipt-authorizes-nothing",
    hasCrossRepoAuthorizationReceipt("acme/one", repo, "write") === false,
    `the guard honoured an EMPTY file — the precondition failed and the retry below proves nothing.`,
    "truncated receipt authorizes nothing (red established)",
  );
  const retry = runTool(repo, WARGS());
  check(
    "T9-retry-over-truncated-receipt-succeeds",
    retry.status === 0,
    `exit=${retry.status} — the path is poisoned for the rest of the UTC day: a file exists so ` +
      `\`wx\` refuses, and it carries no marker so nothing authorizes the action.`,
    "retry over a truncated receipt succeeds",
  );
  check(
    "T9-retry-produces-an-authorization-the-guard-honours",
    hasCrossRepoAuthorizationReceipt("acme/one", repo, "write") === true,
    `guard returns false — the retry wrote nothing usable.`,
    "retry produced a receipt the real guard honours",
  );
  check(
    "T9-truncated-file-is-not-deleted",
    fs.existsSync(path.join(authzDir(repo), name)),
    `the truncated file is gone — the tool deleted a file it did not create in this run, which ` +
      `is how a real prior receipt gets destroyed by a retry.`,
    "the tool never removes files it did not create",
  );
  rmRepo(repo);
}

/* T10 — a mid-write failure must not leave a truncated receipt behind. */
{
  const repo = mkRepo("coc-project");
  // `ulimit -f 0` makes the open succeed (creating the file) and the subsequent
  // write fail — a real ENOSPC/EIO-class mid-write failure, portably induced.
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const cmd =
    `ulimit -f 0; exec node ${q(TOOL)} --repo-root ${q(repo)} --target acme/one ` +
    `--mode write --action ${q(A_ACT)} --instruction ${q("do A")}`;
  let code;
  try {
    execFileSync("bash", ["-c", cmd], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    code = 0;
  } catch (e) {
    code = e.status ?? -1;
  }
  check(
    "T10-failed-write-leaves-no-file-behind",
    listReceipts(repo).length === 0,
    `exit=${code}, receipts=${JSON.stringify(listReceipts(repo))} — a file present means the ` +
      `truncated receipt poisons this path for every retry that UTC day.`,
    `mid-write failure (exit=${code}) left no partial receipt`,
  );
  const retry = runTool(repo, WARGS());
  check(
    "T10-normal-retry-after-failed-write-succeeds",
    retry.status === 0 &&
      hasCrossRepoAuthorizationReceipt("acme/one", repo, "write") === true,
    `exit=${retry.status}, guard=${hasCrossRepoAuthorizationReceipt("acme/one", repo, "write")} — ` +
      `the aborted write permanently blocked authorization for this action.`,
    "a normal retry after the aborted write succeeds and the guard honours it",
  );
  rmRepo(repo);
}

/* T11 — ANTI-DRIFT: the tool's window must AGREE with the guard's at both edges.
 *
 * This is the instrument that catches the writer's and reader's copies of one
 * invariant drifting apart. `readReaderWindows` exists so there is only ONE copy;
 * for each age, "tool refuses" and "guard honours" must be the SAME answer. */
{
  const cases = [
    ["1-minute-old", 60 * 1000, true],
    ["just-INSIDE-the-window", WINDOW_MS - 60 * 1000, true],
    ["just-OUTSIDE-the-window", WINDOW_MS + 60 * 1000, false],
    ["7-hours-old", 7 * 60 * 60 * 1000, false],
    ["future-dated-beyond-skew", -60 * 60 * 1000, false],
  ];
  for (const [label, msAgo, expectLive] of cases) {
    const repo = mkRepo("coc-project");
    runTool(repo, WARGS());
    backdate(repo, listReceipts(repo)[0], msAgo);
    const guardLive = hasCrossRepoAuthorizationReceipt("acme/one", repo, "write");
    const again = runTool(repo, WARGS());
    const toolLive = again.status === 1; // refused == "a live receipt already covers you"
    check(
      `T11-window-agreement-${label}`,
      guardLive === expectLive && toolLive === expectLive,
      `guard=${guardLive} tool=${toolLive} expected=${expectLive}. Disagreement = the writer's ` +
        `window has DRIFTED from the guard's, so a refusal now claims an authorization the guard ` +
        `will not honour (or the tool writes over a window the guard still honours).`,
      `guard and tool agree (both ${expectLive ? "LIVE" : "EXPIRED"})`,
    );
    rmRepo(repo);
  }
}

/* T12 — U+2028/U+2029 are ECMAScript LineTerminators and must be rejected too. */
{
  const repo = mkRepo("coc-project");
  // No `cross-repo-authorized:` literal here — that is blocked independently and
  // would make this case pass for the wrong reason.
  const bad1 = runTool(repo, [
    "--target", "acme/one", "--mode", "write",
    "--action", "harmless\u2028timestamp: 2099-01-01T00:00:00.000Z",
    "--instruction", "i",
  ]);
  check(
    "T12-u2028-in-action-refused",
    bad1.status === 1 && listReceipts(repo).length === 0,
    `exit=${bad1.status}, receipts=${listReceipts(repo).length} — a LineTerminator that ` +
      `ECMAScript's \`m\`-flagged ^/$ honours reached the receipt body, where receiptLiveness ` +
      `reads an ANCHORED \`^timestamp:\` back out.`,
    "U+2028 in --action refused (exit 1, no receipt)",
  );
  const bad2 = runTool(repo, [
    "--target", "acme/one", "--mode", "write",
    "--action", "harmless\u2029more", "--instruction", "i",
  ]);
  check(
    "T12-u2029-in-action-refused",
    bad2.status === 1 && listReceipts(repo).length === 0,
    `exit=${bad2.status}, receipts=${listReceipts(repo).length} — same class as U+2028.`,
    "U+2029 in --action refused (exit 1, no receipt)",
  );
  rmRepo(repo);
}

/* T13 — `.claude/VERSION::type` is NOT a marker-injection channel.
 *
 * The repo class is read verbatim from a COMMITTED, SYNCED JSON file and
 * interpolated into the receipt body's LOCALITY trailer. JSON strings carry `\n`,
 * and the marker-injection guard covers action/instruction/requester ONLY — so
 * `type` was a way to plant a second, column-0 marker for an unrelated target
 * inside a receipt an entirely legitimate ceremony for a DIFFERENT target
 * produced. Both polarities are exercised. */
{
  const writeVersion = (r, type) => {
    fs.mkdirSync(path.join(r, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(r, ".claude", "VERSION"), JSON.stringify({ type }));
  };
  const PAYLOAD = "coc-use-template\ncross-repo-authorized: evil/repo write\nx";

  // (a) NO-FALSE-POSITIVE polarity: an ordinary class still resolves and is named.
  {
    const repo = mkRepo("coc-project");
    const r = runTool(repo, WARGS());
    const body = fs.readFileSync(
      path.join(authzDir(repo), listReceipts(repo)[0]),
      "utf8",
    );
    check(
      "T13a-legitimate-class-accepted-and-named",
      r.status === 0 && body.includes("`type: coc-project`"),
      `exit=${r.status}, trailer names coc-project: ${body.includes("`type: coc-project`")} — ` +
        `an over-broad allowlist would reject VALID classes and degrade every receipt to ` +
        `\`type: unknown\`, which is a fence that fires on everything and discriminates nothing.`,
      "a legitimate class is accepted and named verbatim in the trailer",
    );
    rmRepo(repo);
  }

  // (b) EFFICACY polarity: the injected class must not forge authority.
  {
    const repo = mkRepo("coc-project");
    writeVersion(repo, PAYLOAD);
    const r = runTool(repo, WARGS());
    const files = listReceipts(repo);
    const body = files.length
      ? fs.readFileSync(path.join(authzDir(repo), files[0]), "utf8")
      : "";
    const forged = hasCrossRepoAuthorizationReceipt("evil/repo", repo, "write");
    const genuine = hasCrossRepoAuthorizationReceipt("acme/one", repo, "write");
    check(
      "T13b-receipt-does-not-also-authorize-an-unrelated-target",
      forged === false,
      `guard(evil/repo, write) → ${forged}. TRUE = a fully legitimate ceremony for acme/one ` +
        `silently minted write authority over evil/repo for the whole window, in a receipt ` +
        `carrying a real display_id, a real verbatim instruction and a live timestamp.`,
      "guard(evil/repo, write) → false: no forged authority",
    );
    check(
      "T13b-no-column-0-marker-for-the-injected-target",
      !/^cross-repo-authorized:[ \t]+evil\/repo\b/m.test(body),
      `the class string reached the receipt body verbatim. The guard's matcher is \`m\`-flagged ` +
        `over RAW content and does NOT parse markdown, so an HTML-comment wrapper does not ` +
        `contain it.`,
      "no column-0 marker for the injected target in the receipt body",
    );
    check(
      "T13b-ceremony-still-completes-for-its-own-target",
      r.status === 0 && genuine === true,
      `exit=${r.status}, guard(acme/one, write) → ${genuine}. Failing closed on the WHOLE ` +
        `ceremony would trade a forge for a denial of service; the fence belongs on the FIELD, ` +
        `not the run.`,
      "the ceremony still completes for its own target",
    );
    rmRepo(repo);
  }

  // (c) The two SIBLING readers of the same field. Both are already fail-closed
  // via the four-class enum, which is WHY the merged tool does not touch them —
  // pinned here so a future edit dropping either enum check reds in THIS suite
  // rather than silently reopening the channel elsewhere.
  {
    const repo = mkRepo("coc-project");
    writeVersion(repo, PAYLOAD);
    const manifestSource = await import(
      path.join(REPO, ".claude", "bin", "lib", "manifest-source.mjs")
    );
    const fixtureLib = await import(
      path.join(REPO, ".claude", "audit-fixtures", "_lib", "repo-class.mjs")
    );
    const msResult = manifestSource.readRepoClass(repo);
    let fixtureThrew = false;
    try {
      fixtureLib.readRepoClass(repo);
    } catch {
      fixtureThrew = true;
    }
    check(
      "T13c-manifest-source-readRepoClass-rejects-the-payload",
      msResult.type === null && msResult.reason === "unknown-type",
      `type=${JSON.stringify(msResult.type)} reason=${msResult.reason} — a non-null type means ` +
        `the enum check was dropped and the sibling reader now carries the same injection channel.`,
      "manifest-source.mjs::readRepoClass fails closed (unknown-type)",
    );
    check(
      "T13c-fixture-repo-class-reader-throws-on-the-payload",
      fixtureThrew,
      `it RETURNED instead of throwing — the second sibling reader now trusts a structured ` +
        `class verbatim.`,
      "audit-fixtures/_lib/repo-class.mjs::readRepoClass throws as designed",
    );
    rmRepo(repo);
  }
}

/* T14 — writer and guard must agree on WHICH directory entries are receipts.
 *
 * The guard filters to regular files (`readdirSync(d,{withFileTypes:true})` then
 * `if (!f.isFile()) continue`). `receiptLiveness` uses `readFileSync`, which
 * FOLLOWS symlinks. Without the matching `isFile()` filter in the writer's family
 * scan, a symlink named into the family and pointing at a live receipt OUTSIDE the
 * directory makes the tool announce "it DOES authorize this action right now" for
 * an entry the guard skips entirely. The guard is halt-and-report, not block, so
 * that assurance is what gets rationalized past. */
{
  // (a) EFFICACY polarity: symlink-shadowed family entry.
  {
    const repo = mkRepo("coc-project");
    runTool(repo, WARGS());
    const name = listReceipts(repo)[0];
    const outside = path.join(repo, "elsewhere.md");
    fs.renameSync(path.join(authzDir(repo), name), outside);
    fs.symlinkSync(outside, path.join(authzDir(repo), name));
    const guardLive = hasCrossRepoAuthorizationReceipt("acme/one", repo, "write");
    const again = runTool(repo, WARGS());
    check(
      "T14a-guard-does-not-honour-a-symlinked-family-entry",
      guardLive === false,
      `guard → ${guardLive}. TRUE = the guard changed and this case no longer tests a ` +
        `divergence; re-derive the baseline before reading the writer-side case below.`,
      "reader baseline: the guard skips a symlinked entry (red established)",
    );
    check(
      "T14a-writer-does-not-refuse-on-it-either",
      again.status === 0,
      `exit=${again.status}. exit 1 = the tool told the operator a LIVE receipt already ` +
        `authorizes them, while the guard skips that entry entirely — the exact writer/reader ` +
        `divergence the isFile() fence exists to close, through a different door.`,
      "writer agrees with the reader: the symlink is not a receipt (exit 0)",
    );
    check(
      "T14a-fresh-receipt-it-wrote-is-honoured",
      hasCrossRepoAuthorizationReceipt("acme/one", repo, "write") === true,
      `guard after re-run → false: the re-run produced something the guard still will not accept.`,
      "the fresh receipt written past the symlink IS honoured",
    );
    rmRepo(repo);
  }

  // (b) NO-FALSE-POSITIVE polarity: a REGULAR live receipt must still refuse, so
  // (a) cannot be satisfied by a writer that simply stopped refusing.
  {
    const repo = mkRepo("coc-project");
    runTool(repo, WARGS());
    const again = runTool(repo, WARGS());
    check(
      "T14b-regular-live-receipt-still-refuses",
      again.status === 1 && listReceipts(repo).length === 1,
      `exit=${again.status}, receipts=${listReceipts(repo).length}. exit 0 = the isFile() filter ` +
        `was written so broadly that it skips REAL receipts too, reopening the silent-overwrite ` +
        `defect.`,
      "a regular live receipt still refuses the re-run",
    );
    rmRepo(repo);
  }
}

/* ------------------------------------------------------------------ */
/* 5. DIGEST INJECTIVITY — the property loom contributes to the merge   */
/*                                                                     */
/* `tripleDigest` length-prefixes each field before joining, so the     */
/* map from (target, action, mode) to digest is INJECTIVE BY            */
/* CONSTRUCTION. A separator-join is injective only while every field   */
/* is known free of the separator — a property owned by a validator     */
/* declared elsewhere in the file. A collision here silently merges two */
/* DISTINCT authorizations onto ONE filename, which is the             */
/* silent-overwrite defect class.                                       */
/*                                                                     */
/* Both poles are asserted: distinct triples MUST differ (efficacy),    */
/* and equal triples MUST match (no-false-positive) — without the       */
/* second, `() => Math.random()` would pass the first.                  */
/* ------------------------------------------------------------------ */
{
  const toolSrc = fs.readFileSync(TOOL, "utf8");
  // Extract and evaluate the REAL function from the shipped source, so this case
  // tests the tool's digest and not a re-implementation that could agree with a
  // broken original by construction (evidence-first-claims.md MUST-5).
  const m = toolSrc.match(/function tripleDigest\([\s\S]*?\n}/);
  const digest = m
    ? new Function(
        "createHash",
        `${m[0]}; return tripleDigest;`,
      )(require("node:crypto").createHash)
    : null;

  check(
    "digest-extracted-from-shipped-source",
    typeof digest === "function" &&
      /^[0-9a-f]{8}$/.test(digest("a/b", "act", "write")),
    `could not extract a working \`tripleDigest\` from ${path.basename(TOOL)} — every ` +
      `injectivity result below would be uninterpretable (it would be testing nothing).`,
    `extracted; sample digest = ${m ? digest("a/b", "act", "write") : "n/a"}`,
  );

  if (typeof digest === "function") {
    // EFFICACY POLE — boundary-shifted concatenations. A digest over the plain
    // concatenation of the fields maps BOTH of these to "a/b" + "abc" + "write",
    // so they would collide and two distinct authorizations would share a
    // filename. Length-prefixing separates them: "2:ab" vs "1:a".
    const shiftA = digest("a/b", "abc", "write");
    const shiftB = digest("a/babc", "", "write");
    check(
      "digest-injective-under-boundary-shift",
      shiftA !== shiftB,
      `("a/b","abc","write") and ("a/babc","","write") produced the SAME digest ${shiftA}. ` +
        `The field boundary was shifted without changing the concatenation, so the join is not ` +
        `injective and two DISTINCT (target, action, mode) triples now share one receipt filename.`,
      `boundary-shifted triples differ: ${shiftA} != ${shiftB}`,
    );

    // The separator-join form the merge deliberately did NOT take, shown to
    // COLLIDE on a pair the length-prefixed form separates. This is the
    // known-answer control: it proves the case above can distinguish the two
    // constructions rather than passing for any pair at all.
    const naive = (t, a, mo) =>
      require("node:crypto")
        .createHash("sha256")
        .update(`${t}\n${a}\n${mo}`, "utf8")
        .digest("hex")
        .slice(0, 8);
    const nA = naive("a/b", "x\nread", "write");
    const nB = naive("a/b", "x", "read\nwrite");
    const tA = digest("a/b", "x\nread", "write");
    const tB = digest("a/b", "x", "read\nwrite");
    check(
      "control-separator-join-collides-where-length-prefix-does-not",
      nA === nB && tA !== tB,
      `separator-join collided=${nA === nB} (${nA} vs ${nB}); length-prefixed differ=${tA !== tB} ` +
        `(${tA} vs ${tB}). If the separator-join did NOT collide here, this control does not ` +
        `demonstrate the hazard and the injectivity case above is unmotivated.`,
      `separator-join collides (${nA}) where the shipped length-prefixed digest does not ` +
        `(${tA} != ${tB})`,
    );

    // NO-FALSE-POSITIVE POLE — equal triples MUST produce equal digests.
    // Without this, a digest of `Math.random()` would satisfy every case above.
    const same1 = digest("acme/one", A_ACT, "write");
    const same2 = digest("acme/one", A_ACT, "write");
    check(
      "digest-stable-for-identical-triples",
      same1 === same2 && same1.length === 8,
      `identical triples produced ${same1} and ${same2} — a non-deterministic digest would ` +
        `satisfy every injectivity case above while making the EEXIST/liveness path unreachable ` +
        `(every re-run would land at a new filename and no duplicate would ever be refused).`,
      `identical triples agree: ${same1} === ${same2}`,
    );

    // And mode STILL discriminates (the RS-71 tier property, at digest level).
    check(
      "digest-discriminates-mode",
      digest("acme/one", A_ACT, "read") !== digest("acme/one", A_ACT, "write"),
      `read and write digests are EQUAL — the read/write tier is defeated by the filename alone.`,
      "read and write triples produce distinct digests",
    );
  }
}

/* ------------------------------------------------------------------ */
/* F-A / F-B regression rows — both defects were found by adversarial review     */
/* AFTER the feature shipped, and BOTH would have been caught by a fixture.      */
/* They are pinned here so the next revision cannot silently reintroduce either. */
/* ------------------------------------------------------------------ */
{
  const toolSrc = fs.readFileSync(TOOL, "utf8");

  // F-A. The reachability scan carries a budget. `ls-tree -r` emits NAME-sorted
  // entries and every receipt is `YYYY-MM-DD`-prefixed, so the natural listing is
  // chronologically ASCENDING — spending the budget on the OLDEST receipts and
  // never reaching the newest. A LIVE receipt is <= the window old, hence always
  // among the newest, hence NEVER examined once the directory exceeds the budget.
  // MEASURED at the time of the fix: 279 receipts against a budget of 200, so the
  // check was deterministically false at loom, the only repo that runs it.
  //
  // This asserts the ORDER REVERSAL, which is the whole fix. A control on the same
  // source keeps it from passing against a file that merely mentions the budget.
  check(
    "F-A-listing-reversed-before-scan",
    /\.split\("\\0"\)\.filter\(Boolean\)\.reverse\(\)/.test(toolSrc),
    "the origin/main receipt listing is NOT reversed before the budgeted scan — the budget " +
      "is spent on the OLDEST receipts and a LIVE one (always newest) is never examined, " +
      "so `reachable` can never be true where the directory exceeds the budget.",
    "the listing is reversed before scanning, so the newest receipts are examined first",
  );
  check(
    "F-A-control-budget-constant-present",
    /ORIGIN_MAIN_SCAN_BUDGET\s*=\s*\d+/.test(toolSrc),
    "control failed: the budget constant is absent, so the row above proves nothing about " +
      "a budgeted scan and must not be read as coverage.",
    "control: the budget constant is present, so the reversal row is about a real budget",
  );
  check(
    "F-A-truncated-reason-does-not-overclaim",
    /scanned\s*<\s*paths\.length/.test(toolSrc),
    "the not-reachable reason reports a property of ALL receipts even when the budget " +
      "truncated the scan — a tally reported in place of the hits.",
    "a truncated scan reports what it EXAMINED, not what it did not",
  );

  // F-B. The reader's markerRe folds case (`mi`). A writer that folds the SLUG but
  // not the MATCH misses a mixed-case receipt the guard HONOURS — the same
  // two-copies-of-one-rule divergence this tool exists to end. Both misses are
  // fail-SAFE (a duplicate receipt; a spurious warning), which is precisely why it
  // survived review: nothing breaks loudly.
  // COMMENT-STRIPPED, and that is load-bearing. The first revision of this row
  // matched the raw source, where the explanatory comment above the flag contains
  // the literal `"mi", NOT "m".` — so the COMMENT satisfied the check and the row
  // passed with the fix mutated out. Caught only by mutating; a green here proved
  // nothing. Strip line comments before asking the question.
  const srcNoComments = toolSrc.replace(/^\s*\/\/.*$/gm, "");
  const writerFolds = /`\^cross-repo-authorized:[\s\S]{0,200}?"mi"/.test(srcNoComments);
  check(
    "F-B-writer-marker-regex-folds-case",
    writerFolds,
    'the writer\'s markerRegex does not carry the `i` flag while the reader\'s does — it ' +
      "will MISS a mixed-case receipt the guard honours (two live examples exist in " +
      ".claude/cross-repo-authz/).",
    "the writer's markerRegex folds case, matching the reader",
  );
  // Behavioural control: the folded form matches a REAL mixed-case marker and the
  // unfolded form does not. Without this, the source check above could pass against
  // an `mi` that never sees a mixed-case input.
  {
    const body = "cross-repo-authorized: Integrum-Global/tpc_backend read";
    const folded = new RegExp(
      "^cross-repo-authorized:[ \\t]+integrum-global/tpc_backend[ \\t]+(?:read|write)[ \\t]*$",
      "mi",
    );
    const unfolded = new RegExp(
      "^cross-repo-authorized:[ \\t]+integrum-global/tpc_backend[ \\t]+(?:read|write)[ \\t]*$",
      "m",
    );
    check(
      "F-B-control-fold-discriminates",
      folded.test(body) && !unfolded.test(body),
      `control failed: folded=${folded.test(body)} unfolded=${unfolded.test(body)} — the two ` +
        "forms do not disagree on this input, so the F-B row above cannot discriminate.",
      "folded matches the mixed-case marker and unfolded does not — the row discriminates",
    );
  }
}

/* ------------------------------------------------------------------ */

process.stdout.write(
  `\ncross-repo-authorize fixtures: ${passes} passed, ${failures} failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
