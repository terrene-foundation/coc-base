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

/** Invoke the tool. Returns {status, stdout, stderr, json|null}. */
function runTool(repoDir, args) {
  const r = spawnSync("node", [TOOL, "--repo-root", repoDir, ...args], {
    cwd: repoDir,
    encoding: "utf8",
    timeout: 20000,
  });
  let json = null;
  if (r.stdout && r.stdout.trim().startsWith("{")) {
    try {
      json = JSON.parse(r.stdout);
    } catch {
      /* not json */
    }
  }
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", json };
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

process.stdout.write(
  `\ncross-repo-authorize fixtures: ${passes} passed, ${failures} failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
