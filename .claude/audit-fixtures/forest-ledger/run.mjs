#!/usr/bin/env node
/*
 * Fixture runner for validate-forest-ledger.mjs (journal/0089..0095).
 *
 * Tier-1 STRUCTURAL verification per probe-driven-verification.md MUST-3
 * (byte-equality on deterministic CLI stdout + exit-code assertion — NOT
 * lexical NLP; the validator checks document STRUCTURE, not semantic model
 * output). Every fixture is SYNTHETIC — no real client / org / operator
 * tokens anywhere under this directory (this tree is a synced artifact).
 *
 *   node .claude/audit-fixtures/forest-ledger/run.mjs
 *
 * Exit 0 = all behaved as expected; 1 = a regression.
 *
 * Option B (journal/0095): the ledger carries an explicit UNIQUE ID per
 * row; L4 reconciles on the exact ID set. The legacy prose-name-parsing
 * failure classes (substring-mask, normalization-collision, arrow-split,
 * receipt-token-in-name) are STRUCTURALLY IMPOSSIBLE here — there is no
 * name parser. The L4 class below proves: exact-ID conservation, that an
 * unrelated close cannot mask a vanish (no substring channel exists), and
 * that rewording an item's text never false-trips (ID is stable).
 *
 *   A. File fixtures — each `*.session-notes` asserts stdout == `.expected`
 *      AND exit code == `.exit`. Coverage per cc-artifacts.md Rule 9 — one
 *      fixture per scope-restriction predicate (L1 missing/vacuous/fence/
 *      unterminated/length/type-pairing, L2 anchorless/malformed/contradiction,
 *      L3 no-receipt/no-id/multiline/softwrap/leadin-prose/blank-block,
 *      L5 duplicate-id, empty-forest, header-sep skip, verbatim-template,
 *      heading-whitespace, last-section, CRLF, item-text-irrelevant).
 *   B. IO contract — validator on a nonexistent path exits 2.
 *   C. L4 ID-conservation (--git-prior) — the anti-vanish invariant.
 *   D. Snapshot portability — a history-dependent gate DECLARES, exit 3.
 *   E. The git envelope — an inherited GIT_DIR cannot answer the verdict read.
 *   F. Which committed file the ledger succeeds — aliases, case, subdirectories,
 *      symlink replacement, nested repos, shared form, and the tri-state probe.
 *   G. The harness's own git setup ignores an inherited GIT_DIR (hermetic-env.mjs).
 */

import "../_lib/no-ambient-git.cjs";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync, renameSync, unlinkSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VALIDATOR = path.resolve(HERE, "..", "..", "bin", "validate-forest-ledger.mjs");
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

// Hermetic git env: see hermetic-env.mjs (the constant lives there so it can be tested).
import { HERMETIC_ENV } from "./hermetic-env.mjs";

function invoke(args, cwd = REPO_ROOT) {
  try {
    const out = execFileSync("node", [VALIDATOR, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: HERMETIC_ENV,
      timeout: 15000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { out, code: 0 };
  } catch (e) {
    return {
      out: (e.stdout || "") + (e.stderr || ""),
      code: typeof e.status === "number" ? e.status : 99,
    };
  }
}

let failed = 0;
const fail = (name, detail) => {
  failed++;
  console.log(`FAIL  ${name}`);
  for (const l of detail.split("\n")) console.log(`        ${l}`);
};

// ---- Class A: file fixtures (stdout + exit code) ----
const fixtures = readdirSync(HERE)
  .filter((f) => f.endsWith(".session-notes"))
  .sort();

for (const f of fixtures) {
  const rel = path.relative(REPO_ROOT, path.join(HERE, f));
  const { out, code } = invoke([rel]);
  const base = path.join(HERE, f.replace(/\.session-notes$/, ""));
  const expOut = readFileSync(`${base}.expected`, "utf8").trimEnd();
  const expCode = parseInt(readFileSync(`${base}.exit`, "utf8").trim(), 10);
  const gotOut = out.trimEnd();
  if (gotOut === expOut && code === expCode) {
    console.log(`PASS  ${f}  (exit ${code})`);
  } else {
    const d = [];
    if (gotOut !== expOut)
      d.push(`stdout mismatch\n  expected: ${expOut}\n  got:      ${gotOut}`);
    if (code !== expCode) d.push(`exit ${code} (expected ${expCode})`);
    fail(f, d.join("\n"));
  }
}

// ---- Class B: IO contract — nonexistent path => exit 2 ----
{
  const { code } = invoke([".claude/audit-fixtures/forest-ledger/__nope__.session-notes"]);
  if (code === 2) console.log("PASS  io-missing-path  (exit 2)");
  else fail("io-missing-path", `exit ${code} (expected 2)`);
}

// ---- Class C: L4 ID-conservation via --git-prior ----
{
  const tmp = mkdtempSync(path.join(tmpdir(), "fl-l4-"));
  try {
    const NOTES = path.join(tmp, ".session-notes");
    const git = (...a) =>
      execFileSync("git", a, {
        cwd: tmp,
        stdio: "ignore",
        env: HERMETIC_ENV,
        timeout: 15000,
      });
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");

    const led = (rows, close) =>
      `# Session Notes\n\n## Outstanding ledger (forest)\n\n${rows}\n${close ? `\nClosed this session: ${close}\n` : ""}`;
    let seq = 0;
    const commit = (content, msg) => {
      // PREPEND a unique comment so every commit has a distinct tree (identical
      // ledger content across blocks would otherwise make `git commit` exit
      // non-zero "nothing to commit" and throw). It goes BEFORE the file's first
      // heading: appended, it landed INSIDE the ledger section (the file's last
      // section), which the strict ledger grammar rightly refuses.
      writeFileSync(NOTES, `<!-- seq:${++seq} -->\n${content}`);
      git("add", ".session-notes");
      git("commit", "-qm", msg);
    };
    const reset = () => git("checkout", "-q", "--", ".session-notes");

    // c1: prior F1,F2; current carries F1, F2 dropped + NOT closed => F2 L4.
    commit(led("| F1 | a | anchor | BLOCKED |\n| F2 | b | anchor | BLOCKED |"), "p1");
    writeFileSync(NOTES, led("| F1 | a | anchor | BLOCKED |"));
    let r = invoke(["--git-prior", ".session-notes"], tmp);
    if (r.code === 1 && /L4\].*"F2" vanished/.test(r.out))
      console.log("PASS  l4-vanish-flagged  (exit 1)");
    else fail("l4-vanish-flagged", `code ${r.code}\n${r.out}`);

    // c2: prior F1,F2; current carries F1, closes F2 with receipt => PASS.
    reset();
    commit(led("| F1 | a | anchor | BLOCKED |\n| F2 | b | anchor | BLOCKED |"), "p2");
    writeFileSync(NOTES, led("| F1 | a | anchor | BLOCKED |", "F2 → PR #270."));
    r = invoke(["--git-prior", ".session-notes"], tmp);
    if (r.code === 0) console.log("PASS  l4-carried-and-closed  (exit 0)");
    else fail("l4-carried-and-closed", `code ${r.code}\n${r.out}`);

    // c3 (Option B structural win — replaces every legacy substring/
    // collision/arrow test): prior F1 dropped + NOT closed; an UNRELATED
    // close references a DIFFERENT id F2 that contains "F1" as a substring
    // of nothing — exact-ID match means no substring/collision channel
    // can mask the F1 vanish. MUST flag F1.
    reset();
    commit(led("| F1 | the critical one | anchor | BLOCKED |"), "p3");
    writeFileSync(
      NOTES,
      led("| F2 | unrelated new work | anchor | BLOCKED |", "F2 → PR #5."),
    );
    r = invoke(["--git-prior", ".session-notes"], tmp);
    if (r.code === 1 && /L4\].*"F1" vanished/.test(r.out))
      console.log("PASS  l4-exact-id-no-collision-channel  (exit 1)");
    else fail("l4-exact-id-no-collision-channel", `code ${r.code}\n${r.out}`);

    // c4 (Option B value — kills the legacy reword-false-flag LOW): prior
    // F1 "item alpha"; current F1 with COMPLETELY DIFFERENT item text but
    // the SAME id. ID is stable => carried, NOT a false vanish => PASS.
    reset();
    commit(led("| F1 | item alpha original wording | anchor | BLOCKED |"), "p4");
    writeFileSync(
      NOTES,
      led("| F1 | totally reworded text nothing alike | anchor | BLOCKED |"),
    );
    r = invoke(["--git-prior", ".session-notes"], tmp);
    if (r.code === 0)
      console.log("PASS  l4-id-stable-across-reword  (exit 0)");
    else fail("l4-id-stable-across-reword", `code ${r.code}\n${r.out}`);

    // c5: prior committed .session-notes has NO ledger section => prior
    // ids = [] => nothing to conserve => a conformant current passes
    // (graceful, not a crash, not a false flag).
    reset();
    commit("# Session Notes\n\nNo ledger here at all.\n", "p5");
    writeFileSync(NOTES, led("| F1 | a | anchor | BLOCKED |"));
    r = invoke(["--git-prior", ".session-notes"], tmp);
    if (r.code === 0 && /no forest-ledger section/.test(r.out)) console.log("PASS  l4-prior-no-section-graceful  (exit 0)");
    else fail("l4-prior-no-section-graceful", `code ${r.code}\n${r.out}`);

    // c6 (journal/0097 HIGH-1): the CANONICAL wrapup.md:77 close form
    // uses a backtick-wrapped ID. prior F1,F2; current carries F1 and
    // closes F2 with the documented `F2` → receipt `PR #9` syntax.
    // normId strips the backticks symmetrically → MUST pass (exit 0).
    // Before the fix this false-vanish-flagged the validator's OWN
    // documented contract form.
    reset();
    commit(led("| F1 | a | anchor | BLOCKED |\n| F2 | b | anchor | BLOCKED |"), "p6");
    writeFileSync(
      NOTES,
      led("| F1 | a | anchor | BLOCKED |", "`F2` → receipt `PR #9`."),
    );
    r = invoke(["--git-prior", ".session-notes"], tmp);
    if (r.code === 0)
      console.log("PASS  l4-canonical-backtick-close  (exit 0)");
    else fail("l4-canonical-backtick-close", `code ${r.code}\n${r.out}`);

    // c7 (journal/0097 cc-arch MED): a prior committed ledger that was
    // NOT L5-clean (duplicate ID). Conservation is ambiguous — the gate
    // MUST surface it (transparency finding), not trust it silently.
    reset();
    commit(
      led("| F1 | one | anchor | BLOCKED |\n| F1 | two distinct | anchor | BLOCKED |"),
      "p7",
    );
    writeFileSync(NOTES, led("| F1 | one | anchor | BLOCKED |"));
    r = invoke(["--git-prior", ".session-notes"], tmp);
    if (r.code === 1 && /L4\].*prior committed ledger had duplicate ID "F1"/.test(r.out))
      console.log("PASS  l4-prior-duplicate-id-surfaced  (exit 1)");
    else fail("l4-prior-duplicate-id-surfaced", `code ${r.code}\n${r.out}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- Class D: SNAPSHOT PORTABILITY — a history-dependent gate must DECLARE ----
//
// BIPOLAR, and the two poles are built to converge at their most similar point: the
// SAME ledger content, the SAME vanished ID, the SAME argv, the SAME cwd. They differ
// in ONE fact — whether the prior commit is reachable. That is the only variable, so a
// checker that scores them alike is not reading the property under test.
//
//   pole 1 (FINDING)     history present, F2 genuinely vanished     -> exit 1
//   pole 2 (UNRUNNABLE)  history stripped, identical working tree   -> exit 3
//
// Before this fix pole 2 exited 0 and printed "OK forest-ledger conformant": the
// anti-vanish gate reported CLEAN on the exact tree where it could not see. A fixture
// set that cannot separate exit 1 from exit 3 here is not evidence about this property.
{
  const tmp = mkdtempSync(path.join(tmpdir(), "fl-snap-"));
  try {
    const NOTES = path.join(tmp, ".session-notes");
    const git = (...a) =>
      execFileSync("git", a, { cwd: tmp, stdio: "ignore", env: HERMETIC_ENV, timeout: 15000 });
    const led = (rows) => `# Session Notes\n\n## Outstanding ledger (forest)\n\n${rows}\n`;
    const PRIOR = led("| F1 | a | anchor | BLOCKED |\n| F2 | b | anchor | BLOCKED |");
    const CURRENT = led("| F1 | a | anchor | BLOCKED |"); // F2 dropped, not closed

    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(NOTES, PRIOR);
    git("add", ".session-notes");
    git("commit", "-qm", "prior");
    writeFileSync(NOTES, CURRENT);

    // POLE 1 — the anchor is present, so the comparison is meaningful and the vanish is real.
    let r = invoke(["--git-prior", ".session-notes"], tmp);
    if (r.code === 1 && /L4\].*"F2" vanished/.test(r.out))
      console.log("PASS  snapshot-pole1-history-present-reports-FINDING  (exit 1)");
    else fail("snapshot-pole1-history-present-reports-FINDING", `code ${r.code}\n${r.out}`);

    // POLE 2 — strip ONLY the history. The working tree is byte-identical to pole 1.
    // This is what an offload snapshot / `--depth=1` clone / re-init looks like.
    const before = readFileSync(NOTES, "utf8");
    rmSync(path.join(tmp, ".git"), { recursive: true, force: true });
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    if (readFileSync(NOTES, "utf8") !== before)
      fail("snapshot-pole2-setup", "the working tree changed between poles — poles differ by more than history");
    r = invoke(["--git-prior", ".session-notes"], tmp);
    if (r.code === 3 && /L4\].*DID NOT RUN/.test(r.out))
      console.log("PASS  snapshot-pole2-history-absent-reports-UNRUNNABLE  (exit 3)");
    else fail("snapshot-pole2-history-absent-reports-UNRUNNABLE", `code ${r.code}\n${r.out}`);

    // CONTROL — exit 3 must not be what this gate says about EVERY history-less tree.
    // A clean ledger with no prior commit is the genuine first-commit case and stays 0,
    // or "UNRUNNABLE" would just be a second name for "no history" and carry no
    // information about whether a comparison was owed.
    writeFileSync(NOTES, led("| F1 | a | anchor | BLOCKED |"));
    git("add", ".session-notes");
    git("commit", "-qm", "first");
    r = invoke(["--git-prior", ".session-notes"], tmp);
    if (r.code === 0)
      console.log("PASS  snapshot-control-genuine-first-commit-still-PASSES  (exit 0)");
    else fail("snapshot-control-genuine-first-commit-still-PASSES", `code ${r.code}\n${r.out}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- Class E: git-envelope regressions (named for their findings) ----
// No case in the suite ever SET GIT_DIR, so none could see a redirected read. That
// is how a fix that enveloped only the fallback probes went green while the
// verdict-deciding `git show` stayed bare. These cases CREATE the condition the
// suite never did — adding it on top of HERMETIC_ENV, which (since review-cor-MEDIUM-2)
// strips every inherited GIT_* variable.
{
  const tmp = mkdtempSync(path.join(tmpdir(), "fl-env-"));
  try {
    const REAL = path.join(tmp, "real");
    const DECOY = path.join(tmp, "decoy");
    const g = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "ignore", env: HERMETIC_ENV, timeout: 15000 });
    const led = (rows) => `# S\n\n## Outstanding ledger (forest)\n\n${rows}\n`;
    for (const d of [REAL, DECOY]) {
      mkdirSync(d, { recursive: true });
      g(d, "init", "-q");
      g(d, "config", "user.email", "t@t.t");
      g(d, "config", "user.name", "t");
    }
    // REAL: prior ledger carries F1+F2; the working copy drops F2 => a genuine vanish.
    writeFileSync(path.join(REAL, ".session-notes"), led("| F1 | a | anchor | BLOCKED |\n| F2 | b | anchor | BLOCKED |"));
    g(REAL, "add", ".session-notes");
    g(REAL, "commit", "-qm", "prior");
    writeFileSync(path.join(REAL, ".session-notes"), led("| F1 | a | anchor | BLOCKED |"));
    // DECOY: a repo whose committed ledger ALSO lacks F2, so reading it hides the vanish.
    writeFileSync(path.join(DECOY, ".session-notes"), led("| F1 | a | anchor | BLOCKED |"));
    g(DECOY, "add", ".session-notes");
    g(DECOY, "commit", "-qm", "decoy");

    const run = (args, extraEnv) => {
      try {
        const out = execFileSync("node", [VALIDATOR, ...args], {
          cwd: REAL, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
          env: { ...HERMETIC_ENV, ...extraEnv }, timeout: 15000, maxBuffer: 16 * 1024 * 1024,
        });
        return { out, code: 0 };
      } catch (e) {
        return { out: `${e.stdout || ""}${e.stderr || ""}`, code: e.status ?? -1 };
      }
    };

    // redteam-P2-H1: GIT_DIR pointed at the decoy MUST NOT redirect the verdict read.
    // Before the fix this exited 0 and printed "OK forest-ledger conformant".
    let r = run(["--git-prior", ".session-notes"], { GIT_DIR: path.join(DECOY, ".git") });
    if (r.code === 1 && /L4\].*"F2" vanished/.test(r.out)) console.log("PASS  redteam-P2-H1-gitdir-decoy-still-reds  (exit 1)");
    else fail("redteam-P2-H1-gitdir-decoy-still-reds", `code ${r.code} — the prior read was answered by the decoy\n${r.out}`);

    // Its POSITIVE CONTROL: without the redirect the same tree reds for the same reason,
    // so the case above is testing the redirect and not something else.
    r = run(["--git-prior", ".session-notes"], {});
    if (r.code === 1 && /L4\].*"F2" vanished/.test(r.out)) console.log("PASS  redteam-P2-H1-control-no-redirect  (exit 1)");
    else fail("redteam-P2-H1-control-no-redirect", `code ${r.code}\n${r.out}`);

  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- Class F: WHICH committed file the ledger succeeds (named for their findings) ----
// Each case is named for the review finding it pins. Not every one reddened against the
// validator it followed — several were already right there (the genuinely-absent control,
// path-into-subdir, the case-variant after 047a7c246, and the two tri-state arms that already
// exited 3 under other wording). Those are pinned by MUTATION instead; each commit body lists
// which mutation reds which case, measured rather than assumed.
{
  const tmp = mkdtempSync(path.join(tmpdir(), "fl-real-"));
  try {
    const g = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "ignore", env: HERMETIC_ENV, timeout: 15000 });
    const gOut = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", env: HERMETIC_ENV, timeout: 15000 }).trim();
    const led = (rows) => `# S\n\n## Outstanding ledger (forest)\n\n${rows}\n`;
    const EMPTY = `# S\n\n## Outstanding ledger (forest)\n\nForest empty.\n`;
    const repo = (name) => {
      const d = path.join(tmp, name);
      mkdirSync(d, { recursive: true });
      g(d, "init", "-q");
      g(d, "config", "user.email", "t@t.t");
      g(d, "config", "user.name", "t");
      return d;
    };
    const run = (cwd, args) => {
      try {
        const out = execFileSync("node", [VALIDATOR, ...args], {
          cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
          env: HERMETIC_ENV, timeout: 60000, maxBuffer: 64 * 1024 * 1024,
        });
        return { out, code: 0 };
      } catch (e) {
        return { out: `${e.stdout || ""}${e.stderr || ""}`, code: e.status ?? -1 };
      }
    };
    const check = (name, r, code, re) => {
      if (r.code === code && re.test(r.out)) console.log(`PASS  ${name}  (exit ${code})`);
      else fail(name, `expected exit ${code} matching ${re}; got ${r.code}\n${r.out.slice(0, 600)}`);
    };
    // A vanish fixture: HEAD carries F1+F2, the working copy drops F2.
    const vanish = (d, file = ".session-notes") => {
      writeFileSync(path.join(d, file), led("| F1 | a | anchor | BLOCKED |\n| F2 | b | anchor | BLOCKED |"));
      g(d, "add", file);
      g(d, "commit", "-qm", "prior");
      writeFileSync(path.join(d, file), led("| F1 | a | anchor | BLOCKED |"));
    };

    // redteam-P2-M1: an ABSOLUTE path names the same file, so it gets the same verdict.
    // (It used to be refused as unanswerable; before that it read as "first commit".)
    let d = repo("abs");
    vanish(d);
    check("redteam-P2-M1-absolute-path-resolves-to-the-real-file", run(d, ["--git-prior", path.join(d, ".session-notes")]), 1, /L4\].*"F2" vanished/);

    // review-sec-MED-1: an ALIAS for the file (a symlink here; a case variant on a
    // case-insensitive disk is the same class) MUST be judged as the file it names.
    d = repo("alias");
    vanish(d);
    symlinkSync(".session-notes", path.join(d, "alias-notes"));
    check("review-sec-MED-1-alias-judged-as-the-real-file", run(d, ["--git-prior", "alias-notes"]), 1, /L4\].*"F2" vanished/);

    // review-sec-MED-1, the REPRODUCED form (review-cor-r2-M2): the ledger named in another
    // CASE. Reproduced exit 0 "OK … (first commit)" over F2's vanish. The verdict owed depends
    // on the disk, so the disk is MEASURED, not assumed: case-insensitive ⇒ it is the same file
    // and F2's vanish must be caught (exit 1 — the native realpath's on-disk spelling is what
    // gets there; the JS realpath degrades it to exit 3); case-sensitive ⇒ no such file (exit 2).
    // Neither may exit 0.
    d = repo("cased");
    vanish(d);
    {
      let insensitive = false;
      try {
        insensitive = statSync(path.join(d, ".SESSION-NOTES")).ino === statSync(path.join(d, ".session-notes")).ino;
      } catch {
        insensitive = false;
      }
      if (insensitive) check("review-sec-MED-1-case-variant-name-judged-as-the-real-file", run(d, ["--git-prior", ".SESSION-NOTES"]), 1, /L4\].*"F2" vanished/);
      else check("review-sec-MED-1-case-variant-name-judged-as-the-real-file", run(d, ["--git-prior", ".SESSION-NOTES"]), 2, /cannot read/);
    }

    // review-sec-MED-2: run from a SUBDIRECTORY, the workspace ledger is compared against
    // ITS OWN history — not the root ledger's. Root is "Forest empty", so reading the wrong
    // file made the workspace's vanished W1 pass silently.
    d = repo("subdir");
    mkdirSync(path.join(d, "ws"));
    writeFileSync(path.join(d, ".session-notes"), EMPTY);
    writeFileSync(path.join(d, "ws", ".session-notes"), led("| W1 | a | anchor | BLOCKED |"));
    g(d, "add", "-A");
    g(d, "commit", "-qm", "prior");
    writeFileSync(path.join(d, "ws", ".session-notes"), EMPTY);
    check("review-sec-MED-2-subdir-reads-its-own-ledger", run(path.join(d, "ws"), ["--git-prior", ".session-notes"]), 1, /L4\].*"W1" vanished/);
    // Its twin, where the tool's cwd and the file's directory DIFFER: run from the repo root
    // naming the workspace file. Git must be asked from the FILE's directory; asked from the
    // cwd, `HEAD:./.session-notes` is the ROOT ledger ("Forest empty") and W1's vanish passes.
    {
      // Two identities ask for the SAME blob here (the file from its own dir, and the path from
      // the root), so the run must not report an alias that is not there.
      const r = run(d, ["--git-prior", path.join("ws", ".session-notes")]);
      if (r.code === 1 && /L4\].*"W1" vanished/.test(r.out) && !/prior read through/.test(r.out))
        console.log("PASS  review-sec-MED-2-path-into-subdir-reads-that-ledger  (exit 1)");
      else fail("review-sec-MED-2-path-into-subdir-reads-that-ledger", `code ${r.code}\n${r.out.slice(0, 600)}`);
    }

    // review-sec-MED-1: present at HEAD only under a DIFFERENT SPELLING (a case-only rename
    // not yet committed). Not the first-commit case — UNRUNNABLE.
    d = repo("respelled");
    writeFileSync(path.join(d, ".SESSION-NOTES"), led("| F1 | a | anchor | BLOCKED |"));
    g(d, "add", ".SESSION-NOTES");
    g(d, "commit", "-qm", "prior");
    renameSync(path.join(d, ".SESSION-NOTES"), path.join(d, ".respell.tmp"));
    renameSync(path.join(d, ".respell.tmp"), path.join(d, ".session-notes"));
    check("review-sec-MED-1-other-spelling-at-HEAD-is-unrunnable", run(d, ["--git-prior", ".session-notes"]), 3, /only under a different spelling/);

    // review-sec-MED-3 (tri-state, "present" arm): the path IS in HEAD but its blob is gone
    // (a partial clone). UNRUNNABLE, never "first commit".
    d = repo("noblob");
    vanish(d);
    const blob = gOut(d, "rev-parse", "HEAD:.session-notes");
    unlinkSync(path.join(d, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    check("review-sec-MED-3-present-but-unreadable-is-unrunnable", run(d, ["--git-prior", ".session-notes"]), 3, /IS present at HEAD but its blob could not be read/);

    // redteam-P2-M1 (tri-state, "could not ask" arm): HEAD's TREE is gone, so git cannot
    // even list it. That is a failed question — UNRUNNABLE — never an answer of "absent".
    d = repo("notree");
    vanish(d);
    const tree = gOut(d, "rev-parse", "HEAD^{tree}");
    unlinkSync(path.join(d, ".git", "objects", tree.slice(0, 2), tree.slice(2)));
    check("redteam-P2-M1-unlistable-HEAD-is-unrunnable", run(d, ["--git-prior", ".session-notes"]), 3, /could not list HEAD/);

    // review-sec-MED-3 (tri-state, "absent" arm): the ONLY case the first-commit note is
    // true of. HEAD exists, the ledger was never committed under any spelling.
    d = repo("absent");
    writeFileSync(path.join(d, "other.txt"), "x\n");
    g(d, "add", "other.txt");
    g(d, "commit", "-qm", "other");
    writeFileSync(path.join(d, ".session-notes"), led("| F1 | a | anchor | BLOCKED |"));
    check("review-sec-MED-3-genuinely-absent-is-the-first-commit-note", run(d, ["--git-prior", ".session-notes"]), 0, /note: no prior committed \.session-notes \(first commit\)/);

    // review-cor-MEDIUM-1: a verdict read that cannot COMPLETE (here: the prior blob exceeds
    // the read's buffer) could not ask — exit 3. It used to be scored as a finding (exit 1).
    d = repo("huge");
    // A plain, pipe-free prose line: a comment here would be refused by the strict grammar
    // before the oversized read is ever reached.
    const pad = `\nPAD ${"x".repeat(17 * 1024 * 1024)}\n`;
    writeFileSync(path.join(d, ".session-notes"), led("| F1 | a | anchor | BLOCKED |") + pad);
    g(d, "add", ".session-notes");
    g(d, "commit", "-qm", "prior");
    check("review-cor-MEDIUM-1-incomplete-read-is-unrunnable-not-a-finding", run(d, ["--git-prior", ".session-notes"]), 3, /`git show` did not complete/);
    // ---- round 2 (security re-review of 047a7c246) ----
    // review-sec-r2-HIGH-1: a TRACKED ledger replaced by a symlink to an untracked file. Asking
    // only the real file moved the comparison to a path HEAD never held: exit 0 over F2's vanish.
    d = repo("relinked");
    vanish(d);
    mkdirSync(path.join(d, "ws"));
    writeFileSync(path.join(d, "ws", "new.md"), led("| F1 | a | anchor | BLOCKED |"));
    unlinkSync(path.join(d, ".session-notes"));
    symlinkSync(path.join("ws", "new.md"), path.join(d, ".session-notes"));
    check("review-sec-r2-HIGH-1-tracked-ledger-replaced-by-symlink-still-conserved", run(d, ["--git-prior", ".session-notes"]), 1, /L4\].*"F2" vanished/);

    // review-sec-r2-MED-1: a directory on the path turned into a NESTED repository with its own
    // (empty) HEAD. Asked only from the file's directory, the nested HEAD lacks the file: exit 0.
    d = repo("nested");
    mkdirSync(path.join(d, "ws"));
    writeFileSync(path.join(d, "ws", ".session-notes"), led("| W1 | a | anchor | BLOCKED |"));
    g(d, "add", "-A");
    g(d, "commit", "-qm", "prior");
    g(path.join(d, "ws"), "init", "-q");
    g(path.join(d, "ws"), "config", "user.email", "t@t.t");
    g(path.join(d, "ws"), "config", "user.name", "t");
    g(path.join(d, "ws"), "commit", "-q", "--allow-empty", "-m", "planted");
    writeFileSync(path.join(d, "ws", ".session-notes"), EMPTY);
    check("review-sec-r2-MED-1-planted-nested-repo-still-conserved", run(d, ["--git-prior", path.join("ws", ".session-notes")]), 1, /L4\].*"W1" vanished/);

    // review-sec-r2-HIGH-2: a whole-file SHARED-form prior. It merges closed rows out with no
    // close record, so it cannot be conserved; it used to read as "no section" and exit 0.
    d = repo("shared");
    const SH = ".session-notes.shared.md";
    const shared = (rows) => `# Forest Ledger\n\n| ID | Item | Anchor | Status |\n|----|------|--------|--------|\n${rows}\n`;
    writeFileSync(path.join(d, SH), shared("| F1 | a | anchor | BLOCKED |\n| F2 | b | anchor | BLOCKED |"));
    g(d, "add", SH);
    g(d, "commit", "-qm", "prior");
    writeFileSync(path.join(d, SH), shared("| F1 | a | anchor | BLOCKED |"));
    check("review-sec-r2-HIGH-2-shared-form-prior-is-unrunnable", run(d, ["--git-prior", SH]), 3, /whole-file shared form/);

    // The identity union must not cry wolf: an ordinary exact run reports no alias.
    d = repo("plain");
    vanish(d);
    {
      const r = run(d, ["--git-prior", ".session-notes"]);
      if (r.code === 1 && /"F2" vanished/.test(r.out) && !/prior read through/.test(r.out))
        console.log("PASS  review-sec-r2-ordinary-run-reports-no-alias  (exit 1)");
      else fail("review-sec-r2-ordinary-run-reports-no-alias", `code ${r.code}\n${r.out.slice(0, 600)}`);
    }

    // review-sec-r2-LOW-1: a directory whose name BEGINS with a space. Trimming git's output
    // dropped it, so a respelled ledger there read as genuinely absent (exit 0).
    d = repo("spaced");
    mkdirSync(path.join(d, " sp"));
    writeFileSync(path.join(d, " sp", ".SESSION-NOTES"), led("| F1 | a | anchor | BLOCKED |"));
    g(d, "add", "-A");
    g(d, "commit", "-qm", "prior");
    renameSync(path.join(d, " sp", ".SESSION-NOTES"), path.join(d, " sp", ".respell.tmp"));
    renameSync(path.join(d, " sp", ".respell.tmp"), path.join(d, " sp", ".session-notes"));
    check("review-sec-r2-LOW-1-leading-space-dir-respelling-is-unrunnable", run(d, ["--git-prior", path.join(" sp", ".session-notes")]), 3, /only under a different spelling/);

    // ---- round 3 (security re-review of 803bae71a) ----
    // review-sec-r3-HIGH-1: a DATA row that mentions "value-anchor" and a word containing
    // "id" ("valid") was skipped as a header — never conserved, so its vanish exited 0.
    d = repo("headerish");
    const HROW = "| F7 | add value-anchor check to sweep | valid anchor | OPEN |";
    const hled = (rows) => `# S\n\n## Outstanding ledger (forest)\n\n| ID | Item | Value-anchor | Status |\n|----|------|--------------|--------|\n${rows}\n`;
    writeFileSync(path.join(d, ".session-notes"), hled(`| F1 | a | anchor | BLOCKED |\n${HROW}`));
    g(d, "add", ".session-notes");
    g(d, "commit", "-qm", "prior");
    writeFileSync(path.join(d, ".session-notes"), hled("| F1 | a | anchor | BLOCKED |"));
    check("review-sec-r3-HIGH-1-row-mentioning-value-anchor-is-conserved", run(d, ["--git-prior", ".session-notes"]), 1, /L4\].*"F7" vanished/);

    // review-sec-r3-HIGH-2: the ledger committed as a SYMLINK. `git show` prints its link
    // target ("a.md"), which read as "no section" and exited 0 over F2's vanish.
    d = repo("linked-at-head");
    writeFileSync(path.join(d, "a.md"), led("| F1 | a | anchor | BLOCKED |\n| F2 | b | anchor | BLOCKED |"));
    symlinkSync("a.md", path.join(d, ".session-notes"));
    g(d, "add", "-A");
    g(d, "commit", "-qm", "prior");
    unlinkSync(path.join(d, ".session-notes"));
    writeFileSync(path.join(d, ".session-notes"), led("| F1 | a | anchor | BLOCKED |"));
    check("review-sec-r3-HIGH-2-symlink-committed-as-the-ledger-is-unrunnable", run(d, ["--git-prior", ".session-notes"]), 3, /is a SYMLINK in HEAD/);

    // review-sec-r3-MED-2: `lnk/../x` where lnk is a symlink. The kernel read ws/x; the
    // lexically-folded path conserved the ROOT x ("Forest empty"), so W2's vanish exited 0.
    d = repo("dotdot");
    mkdirSync(path.join(d, "ws", "inner"), { recursive: true });
    writeFileSync(path.join(d, ".session-notes"), EMPTY);
    writeFileSync(path.join(d, "ws", ".session-notes"), led("| W1 | a | anchor | BLOCKED |\n| W2 | b | anchor | BLOCKED |"));
    g(d, "add", "-A");
    g(d, "commit", "-qm", "prior");
    writeFileSync(path.join(d, "ws", ".session-notes"), led("| W1 | a | anchor | BLOCKED |"));
    symlinkSync(path.join("ws", "inner"), path.join(d, "lnk"));
    check("review-sec-r3-MED-2-dotdot-after-symlink-conserves-the-file-read", run(d, ["--git-prior", "lnk/../.session-notes"]), 1, /L4\].*"W2" vanished/);

    // review-sec-r3-MED-3: a prior the parser could read only PARTLY. Each used to drop the
    // unreadable rows from the comparison and exit 0 over F2's vanish.
    const partial = (name, priorText) => {
      const dd = repo(name);
      writeFileSync(path.join(dd, ".session-notes"), priorText);
      g(dd, "add", ".session-notes");
      g(dd, "commit", "-qm", "prior");
      writeFileSync(path.join(dd, ".session-notes"), led("| F1 | a | anchor | BLOCKED |"));
      return run(dd, ["--git-prior", ".session-notes"]);
    };
    check("review-sec-r3-MED-3-prior-heading-variant-is-unrunnable",
      partial("hvariant", `# S\n\n## Outstanding ledger (forest) — 2 open\n\n| F1 | a | anchor | BLOCKED |\n| F2 | b | anchor | BLOCKED |\n`), 3, /no ledger section but DOES hold a table/);
    check("review-sec-r3-MED-3-prior-unclosed-fence-is-unrunnable",
      partial("fence", `# S\n\n## Outstanding ledger (forest)\n\n| F1 | a | anchor | BLOCKED |\n\`\`\`\n| F2 | b | anchor | BLOCKED |\n`), 3, /unclosed code fence/);
    check("review-sec-r3-MED-3-prior-malformed-row-is-unrunnable",
      partial("malrow", `# S\n\n## Outstanding ledger (forest)\n\n| F1 | a | anchor | BLOCKED |\n| F2 | b |\n`), 3, /could not be parsed/);

    // review-sec-r3-LOW-3: a directory whose name contains a NEWLINE. One combined rev-parse
    // output split on newlines lost the prefix, so a respelled ledger there exited 0.
    d = repo("newline");
    const NL = "a\nb";
    mkdirSync(path.join(d, NL));
    writeFileSync(path.join(d, NL, ".SESSION-NOTES"), led("| F1 | a | anchor | BLOCKED |"));
    g(d, "add", "-A");
    g(d, "commit", "-qm", "prior");
    renameSync(path.join(d, NL, ".SESSION-NOTES"), path.join(d, NL, ".respell.tmp"));
    renameSync(path.join(d, NL, ".respell.tmp"), path.join(d, NL, ".session-notes"));
    check("review-sec-r3-LOW-3-newline-dir-respelling-is-unrunnable", run(d, ["--git-prior", path.join(NL, ".session-notes")]), 3, /only under a different spelling/);

    // ---- round 3 (correctness re-review of 803bae71a) ----
    // review-cor-r3-M1: the UNION itself. The root ledger (F1+F2) is replaced by a symlink
    // to a TRACKED workspace ledger (W1). The real identity finds W1's prior, the as-named one
    // finds F1+F2's; conserving against the first alone exits 0 over F1 and F2.
    d = repo("union");
    mkdirSync(path.join(d, "ws"));
    writeFileSync(path.join(d, ".session-notes"), led("| F1 | a | anchor | BLOCKED |\n| F2 | b | anchor | BLOCKED |"));
    writeFileSync(path.join(d, "ws", ".session-notes"), led("| W1 | a | anchor | BLOCKED |"));
    g(d, "add", "-A");
    g(d, "commit", "-qm", "prior");
    unlinkSync(path.join(d, ".session-notes"));
    symlinkSync(path.join("ws", ".session-notes"), path.join(d, ".session-notes"));
    check("review-cor-r3-M1-union-conserves-every-identity", run(d, ["--git-prior", ".session-notes"]), 1, /"F1" vanished[\s\S]*"F2" vanished|"F2" vanished[\s\S]*"F1" vanished/);

    // review-cor-r3-M2: the AS-NAMED identity alone. Run from a subdirectory as `../x`, so the
    // from-cwd question cannot be formed; the symlink-replaced ledger's own history is reachable
    // only through the name as typed.
    d = repo("asnamed");
    vanish(d);
    mkdirSync(path.join(d, "ws"));
    writeFileSync(path.join(d, "ws", "new.md"), led("| F1 | a | anchor | BLOCKED |"));
    unlinkSync(path.join(d, ".session-notes"));
    symlinkSync(path.join("ws", "new.md"), path.join(d, ".session-notes"));
    check("review-cor-r3-M2-as-named-identity-carries-the-history", run(path.join(d, "ws"), ["--git-prior", path.join("..", ".session-notes")]), 1, /L4\].*"F2" vanished/);

    // review-cor-r3-H1: TWO single cases combined — the symlink-replaced ledger typed in another
    // CASE, and a nested repo typed in another case. Each exited 0 over a real vanish; now no
    // identity can PROVE the path was never committed, so the verdict is UNRUNNABLE, never 0.
    // (Only constructible where the disk folds case; elsewhere the typed name does not exist.)
    {
      const probe = repo("foldprobe");
      writeFileSync(path.join(probe, "x"), "x");
      let folds = false;
      try {
        folds = statSync(path.join(probe, "X")).ino === statSync(path.join(probe, "x")).ino;
      } catch {
        folds = false;
      }
      d = repo("relinked-cased");
      vanish(d);
      mkdirSync(path.join(d, "ws"));
      writeFileSync(path.join(d, "ws", "new.md"), led("| F1 | a | anchor | BLOCKED |"));
      unlinkSync(path.join(d, ".session-notes"));
      symlinkSync(path.join("ws", "new.md"), path.join(d, ".session-notes"));
      const r1 = run(d, ["--git-prior", ".SESSION-NOTES"]);
      d = repo("nested-cased");
      mkdirSync(path.join(d, "ws"));
      writeFileSync(path.join(d, "ws", ".session-notes"), led("| W1 | a | anchor | BLOCKED |"));
      g(d, "add", "-A");
      g(d, "commit", "-qm", "prior");
      g(path.join(d, "ws"), "init", "-q");
      g(path.join(d, "ws"), "config", "user.email", "t@t.t");
      g(path.join(d, "ws"), "config", "user.name", "t");
      g(path.join(d, "ws"), "commit", "-q", "--allow-empty", "-m", "planted");
      writeFileSync(path.join(d, "ws", ".session-notes"), EMPTY);
      const r2 = run(d, ["--git-prior", path.join("WS", ".session-notes")]);
      const want = folds ? 3 : 2;
      if (r1.code === want && r2.code === want) console.log(`PASS  review-cor-r3-H1-cased-alias-combinations-never-exit-0  (exit ${want} x2)`);
      else fail("review-cor-r3-H1-cased-alias-combinations-never-exit-0", `folds=${folds}: expected ${want} twice; got ${r1.code}, ${r2.code}\n${r1.out.slice(0, 300)}\n${r2.out.slice(0, 300)}`);
    }

    // review-sec-r3-MED-1: the planted nested repo, asked from OUTSIDE the repository by an
    // absolute path. The as-typed question cannot be formed from there, so nothing can prove
    // the path was never committed: UNRUNNABLE. Before, both remaining identities asked the
    // planted repo, heard "absent", and the run exited 0 over W1's vanish.
    d = repo("nested-outside");
    mkdirSync(path.join(d, "ws"));
    writeFileSync(path.join(d, "ws", ".session-notes"), led("| W1 | a | anchor | BLOCKED |"));
    g(d, "add", "-A");
    g(d, "commit", "-qm", "prior");
    g(path.join(d, "ws"), "init", "-q");
    g(path.join(d, "ws"), "config", "user.email", "t@t.t");
    g(path.join(d, "ws"), "config", "user.name", "t");
    g(path.join(d, "ws"), "commit", "-q", "--allow-empty", "-m", "planted");
    writeFileSync(path.join(d, "ws", ".session-notes"), EMPTY);
    {
      const outside = path.join(tmp, "outside");
      mkdirSync(outside);
      check("review-sec-r3-MED-1-outside-the-repo-cannot-prove-absence", run(outside, ["--git-prior", path.join(d, "ws", ".session-notes")]), 3, /lies outside the directory this was run from/);
    }

    // ---- round 4 (accident-class; adversarial residuals are DECLARED in the validator header) ----
    // review-cor-r4-H1 (a regression d52984bb1 introduced): a blank `|  |  |  |  |` row, or a
    // stray `|----|` mid-table, promoted the data row ABOVE it to a header — dropped from
    // conservation and from the anchor check. af57c4839 caught both; d52984bb1 exited 0.
    {
      const withRows = (rows) => `# S\n\n## Outstanding ledger (forest)\n\n| ID | Item | Value-anchor | Status |\n|----|------|--------------|--------|\n${rows}\n`;
      d = repo("blankrow");
      writeFileSync(path.join(d, ".session-notes"), withRows("| F1 | a | anchor | BLOCKED |\n| F2 | b | anchor | BLOCKED |\n|  |  |  |  |"));
      g(d, "add", ".session-notes");
      g(d, "commit", "-qm", "prior");
      writeFileSync(path.join(d, ".session-notes"), withRows("| F1 | a | anchor | BLOCKED |\n| F3 | c | anchor | BLOCKED |\n|  |  |  |  |"));
      check("review-cor-r4-H1-blank-row-does-not-hide-the-row-above", run(d, ["--git-prior", ".session-notes"]), 1, /L4\].*"F2" vanished/);
      d = repo("straydelim");
      writeFileSync(path.join(d, ".session-notes"), withRows("| F1 | a | anchor | BLOCKED |\n| F2 | b |  | BLOCKED |\n|----|----|----|----|\n| F3 | c | anchor | BLOCKED |"));
      check("review-cor-r4-H1-stray-delimiter-does-not-hide-an-anchorless-row", run(d, [".session-notes"]), 1, /ledger row "F2" has no value-anchor/);
    }

    // review-cor-r4-M1: a GFM row WITHOUT its leading pipe was filtered out silently, so it was
    // never conserved. In a prior it makes the ledger unreadable (exit 3), never a pass.
    check("review-cor-r4-M1-prior-row-without-leading-pipe-is-unrunnable",
      partial("nopipe", `# S\n\n## Outstanding ledger (forest)\n\n| F1 | a | anchor | BLOCKED |\nF2 | b | anchor | BLOCKED\n`), 3, /outside the ledger grammar — first: a pipe outside a table row/);

    // review-sec-r4-M2: a commented-out template heading ABOVE the real section bound the parse
    // to the template, so the real rows were never compared; a second section likewise.
    check("review-sec-r4-M2-prior-with-two-ledger-headings-is-unrunnable",
      partial("twoheads", `# S\n\n<!--\n## Outstanding ledger (forest)\n\nForest empty.\n-->\n\n## Outstanding ledger (forest)\n\n| F1 | a | anchor | BLOCKED |\n| F2 | b | anchor | BLOCKED |\n`), 3, /2 ledger headings/);

    // review-cor-r4-L7: a prior that merely MENTIONS a ledger in prose (no table) is not
    // ledger-shaped — the first commit of the section passes with its note, not exit 3.
    check("review-cor-r4-L7-prose-mention-of-a-ledger-is-not-ledger-shaped",
      partial("prose", `# S\n\nThe Outstanding ledger (forest) moves here next session; every row keeps its value-anchor.\n`), 0, /no forest-ledger section/);

    // review-sec-r4-H2: a partial clone. The union's second identity (the root ledger, F1+F2,
    // replaced by a symlink to a tracked W1 ledger) lost its BLOB, so `git show` answered "no"
    // like a never-committed path and F1/F2 dropped out of the union: exit 0.
    d = repo("union-noblob");
    mkdirSync(path.join(d, "ws"));
    writeFileSync(path.join(d, ".session-notes"), led("| F1 | a | anchor | BLOCKED |\n| F2 | b | anchor | BLOCKED |"));
    writeFileSync(path.join(d, "ws", ".session-notes"), led("| W1 | a | anchor | BLOCKED |"));
    g(d, "add", "-A");
    g(d, "commit", "-qm", "prior");
    {
      const rootBlob = gOut(d, "rev-parse", "HEAD:.session-notes");
      unlinkSync(path.join(d, ".git", "objects", rootBlob.slice(0, 2), rootBlob.slice(2)));
    }
    unlinkSync(path.join(d, ".session-notes"));
    symlinkSync(path.join("ws", ".session-notes"), path.join(d, ".session-notes"));
    check("review-sec-r4-H2-union-member-with-missing-blob-is-unrunnable", run(d, ["--git-prior", ".session-notes"]), 3, /IS present at HEAD but its blob could not be read/);

    // review-sec-r4-L4: the ledger path was a DIRECTORY at HEAD. `git show` printed its
    // listing, which read as a ledger-less prior.
    d = repo("wasdir");
    mkdirSync(path.join(d, ".session-notes"));
    writeFileSync(path.join(d, ".session-notes", "x"), "x\n");
    g(d, "add", "-A");
    g(d, "commit", "-qm", "prior");
    rmSync(path.join(d, ".session-notes"), { recursive: true, force: true });
    writeFileSync(path.join(d, ".session-notes"), led("| F1 | a | anchor | BLOCKED |"));
    check("review-sec-r4-L4-directory-at-HEAD-is-not-a-prior", run(d, ["--git-prior", ".session-notes"]), 3, /not a regular file/);

    // review-cor-r4-M2: the committed-symlink check run FROM THE SUBDIRECTORY. From the root a
    // sibling identity hid the need for --full-tree; from here, dropping it read the link text.
    d = repo("linksub");
    mkdirSync(path.join(d, "ws"));
    writeFileSync(path.join(d, "ws", "a.md"), led("| W1 | a | anchor | BLOCKED |\n| W2 | b | anchor | BLOCKED |"));
    symlinkSync("a.md", path.join(d, "ws", ".session-notes"));
    g(d, "add", "-A");
    g(d, "commit", "-qm", "prior");
    unlinkSync(path.join(d, "ws", ".session-notes"));
    writeFileSync(path.join(d, "ws", ".session-notes"), led("| W1 | a | anchor | BLOCKED |"));
    check("review-cor-r4-M2-committed-symlink-from-its-own-directory-is-unrunnable", run(path.join(d, "ws"), ["--git-prior", ".session-notes"]), 3, /is a SYMLINK in HEAD/);

    // review-cor-r4-L1: the newline-directory respelling run from INSIDE that directory, where
    // no sibling identity catches it first — so the separate rev-parse calls are what decide.
    d = repo("newline-inside");
    mkdirSync(path.join(d, NL));
    writeFileSync(path.join(d, NL, ".SESSION-NOTES"), led("| F1 | a | anchor | BLOCKED |"));
    g(d, "add", "-A");
    g(d, "commit", "-qm", "prior");
    renameSync(path.join(d, NL, ".SESSION-NOTES"), path.join(d, NL, ".respell.tmp"));
    renameSync(path.join(d, NL, ".respell.tmp"), path.join(d, NL, ".session-notes"));
    check("review-cor-r4-L1-newline-dir-respelling-from-inside-is-unrunnable", run(path.join(d, NL), ["--git-prior", ".session-notes"]), 3, /only under a different spelling/);

    // ---- round 5 (4d839803c's fail-closed regressions, and one fail-open accident) ----
    // review-sec-r5-R1: pipes inside a code span, a one-line commented template row and a status
    // legend are prose, not a malformed row. 4d839803c flagged all three (exit 1 on a clean file).
    {
      const dd = repo("prosepipes");
      writeFileSync(path.join(dd, ".session-notes"),
        "# S\n\n## Outstanding ledger (forest)\n\n" +
        "Re-check: `gh pr list | jq .[] | sort | uniq`\n" +
        "<!-- | <id> | <workstream> | <why> | BLOCKED on X | -->\n" +
        "| F1 | a | anchor | BLOCKED |\n");
      // STRICT GRAMMAR (operator decision): prose with pipes or comments inside the section is
      // REFUSED with the exact line — never interpreted. r5-R1 once asked for it to pass.
      check("review-sec-r5-R1-pipes-and-comments-in-prose-are-refused-not-guessed", run(dd, [".session-notes"]), 1, /outside the ledger grammar/);
    }

    // review-sec-r5-R2: a prior from BEFORE the ledger existed, carrying an unrelated table,
    // is not "ledger-shaped" — the first commit of the section passes with its note.
    // STRICT GRAMMAR cost, accepted: a sectionless prior holding ANY table is refused until the
    // commit carrying the section lands — telling an unrelated table from a damaged ledger is the
    // guessing the grammar removed.
    check("review-sec-r5-R2-sectionless-prior-with-a-table-is-refused-once",
      partial("prtable", `# S\n\n## Open PRs\n\n| PR | branch | state | CI |\n|----|--------|-------|----|\n| 12 | x | open | green |\n`), 3, /no ledger section but DOES hold a table/);

    // review-sec-r5-R3: the heading QUOTED inside a fenced example is not a second section.
    {
      const dd = repo("fencedhead");
      writeFileSync(path.join(dd, ".session-notes"),
        led("| F1 | a | anchor | BLOCKED |\n| F2 | b | anchor | BLOCKED |") +
        "\n## Traps\n\n```\n## Outstanding ledger (forest)\n```\n");
      g(dd, "add", ".session-notes");
      g(dd, "commit", "-qm", "prior");
      writeFileSync(path.join(dd, ".session-notes"),
        led("| F1 | a | anchor | BLOCKED |") + "\n## Traps\n\n```\n## Outstanding ledger (forest)\n```\n");
      check("review-sec-r5-R3-heading-quoted-in-a-fence-is-not-a-second-section", run(dd, ["--git-prior", ".session-notes"]), 1, /L4\].*"F2" vanished/);
    }

    // review-sec-r5-R4: a symlink alias living OUTSIDE any repository. The real identity finds
    // the prior; the as-named identity has no repository at all, which is a real "no" for it.
    {
      const dd = repo("outsidealias");
      vanish(dd);
      const outside = path.join(tmp, "alias-home");
      mkdirSync(outside);
      symlinkSync(path.join(dd, ".session-notes"), path.join(outside, "notes"));
      check("review-sec-r5-R4-alias-outside-any-repo-still-conserves", run(dd, ["--git-prior", path.join(outside, "notes")]), 1, /L4\].*"F2" vanished/);
    }

    // review-sec-r5-R5: the /wrapup scaffold's own header cell, `Value-anchor (MUST-1 source)`,
    // is a header even where the table grammar cannot decide it; two such tables must not yield
    // a phantom duplicate row "ID".
    {
      const dd = repo("scaffoldhead");
      const H = "| ID | Item | Value-anchor (MUST-1 source) | Status |";
      writeFileSync(path.join(dd, ".session-notes"),
        `# S\n\n## Outstanding ledger (forest)\n\n${H}\n| F1 | a | anchor | BLOCKED |\n\n${H}\n| F2 | b | anchor | BLOCKED |\n`);
      check("review-sec-r5-R5-scaffold-header-cell-is-a-header", run(dd, [".session-notes"]), 0, /OK forest-ledger conformant/);
    }

    // review-sec-r5-A1 (fail-OPEN, older than this lane): the rows sit OUTSIDE the section — here
    // a table left under the next heading. (The review's original input, a commented template
    // whose "## " line ended the section, is now parsed THROUGH the comment and conserved; see
    // review-sec-r6-M5.) A prior section with no rows and no "Forest empty" read as an empty
    // ledger — exit 0 over F2's vanish.
    check("review-sec-r5-A1-rowless-prior-section-is-unrunnable",
      partial("templatecut", `# S\n\n## Outstanding ledger (forest)\n\n## Notes\n\n| F1 | a | anchor | BLOCKED |\n| F2 | b | anchor | BLOCKED |\n`), 3, /has no rows and does not say "Forest empty"/);

    // review-cor-r5-1: a SENTENCE with three pipes and a close bullet that mentions a table are
    // prose, not a malformed row. 4d839803c flagged both (exit 1 on a clean file).
    {
      const dd = repo("pipesentence");
      writeFileSync(path.join(dd, ".session-notes"),
        "# S\n\n## Outstanding ledger (forest)\n\n" +
        "Statuses are OPEN | BLOCKED | DEFERRED | DONE.\n" +
        "| F1 | a | anchor | BLOCKED |\n\n" +
        "Closed this session:\n- F0: fixed parsing of | a | b | c | rows (PR #9)\n");
      check("review-cor-r5-1-pipe-sentence-and-close-bullet-are-refused-not-guessed", run(dd, [".session-notes"]), 1, /outside the ledger grammar — a pipe outside a table row/);
    }

    // review-cor-r5-3: a second ledger heading is reported on the CURRENT file too, so bare
    // validation no longer passes a file that the next --git-prior run refuses.
    {
      const dd = repo("twoheads-current");
      writeFileSync(path.join(dd, ".session-notes"),
        led("| F1 | a | anchor | BLOCKED |") + "\n## Outstanding ledger (forest)\n\n| F2 | b | anchor | BLOCKED |\n");
      check("review-cor-r5-3-second-ledger-heading-is-an-L1-finding", run(dd, [".session-notes"]), 1, /\[L1\] 2 "## Outstanding ledger \(forest\)" headings/);
    }

    // ---- round 6 (fail-open regressions in 6e9a998a4/fb8492ad3, and one older sibling) ----
    // review-sec-r6-M1: a DAMAGED ledger heading (no space after the hashes) and NO header row —
    // only the loosened heading signal can say "this is a ledger"; not "no section", exit 0.
    check("review-sec-r6-M1-damaged-heading-prior-is-still-ledger-shaped",
      partial("damagedhead", `# S\n\n##Outstanding ledger (forest)\n\n| F1 | a | anchor | BLOCKED |\n| F2 | b | anchor | BLOCKED |\n`), 3, /no ledger section but DOES hold a table/);

    // review-sec-r6-M1, second signal: the ledger heading DELETED outright, rows left under an
    // unrelated heading. Only the value-anchor header row still says "this is a ledger".
    check("review-sec-r6-M1-deleted-heading-with-anchor-header-is-still-ledger-shaped",
      partial("noheading", `# S\n\n## Notes\n\n| ID | Item | Value-anchor | Status |\n|----|------|--------------|--------|\n| F1 | a | anchor | BLOCKED |\n| F2 | b | anchor | BLOCKED |\n`), 3, /no ledger section but DOES hold a table/);

    // review-sec-r6-M2: a row missing its leading pipe whose ID is BACKTICKED (a form normId
    // supports) is still a row in the wrong shape — flagged, never silently dropped.
    {
      const dd = repo("tickedid");
      writeFileSync(path.join(dd, ".session-notes"),
        "# S\n\n## Outstanding ledger (forest)\n\n| F1 | a | anchor | BLOCKED |\n`F2` | b | anchor | BLOCKED\n");
      check("review-sec-r6-M2-backticked-id-without-leading-pipe-is-flagged", run(dd, [".session-notes"]), 1, /outside the ledger grammar — a pipe outside a table row.*`F2`/);
    }

    // review-sec-r6-L4: a `<!--` INSIDE a code span is text; it must not silence the rest of the
    // section, so a following row without its leading pipe is still flagged.
    {
      const dd = repo("tickcomment");
      writeFileSync(path.join(dd, ".session-notes"),
        "# S\n\n## Outstanding ledger (forest)\n\nTip: write `<!--` to hide a row.\n| F1 | a | anchor | BLOCKED |\nF2 | b | anchor | BLOCKED\n");
      check("review-sec-r6-L4-comment-marker-in-the-section-is-refused", run(dd, [".session-notes"]), 1, /outside the ledger grammar — an HTML comment marker/);
    }

    // review-sec-r6-M5 (older sibling of r5-A1): a commented template with its own "## " heading
    // BELOW a real row used to end the section there, so F2 under it was never conserved.
    check("review-sec-r6-M5-commented-template-in-a-prior-is-refused",
      partial("tmplmid", `# S\n\n## Outstanding ledger (forest)\n\n| F1 | a | anchor | BLOCKED |\n<!-- template\n## Row format\n-->\n| F2 | b | anchor | BLOCKED |\n`), 3, /outside the ledger grammar — first: an HTML comment marker/);

    // ---- round 6, correctness (the shapes the security round's fixes still missed) ----
    // review-cor-r6-F1: IDs outside an ASCII pattern (`F2/a`, `W3:a`, `Fé2`) without a leading
    // pipe are still rows in the wrong shape — flagged, never silently dropped.
    {
      const dd = repo("wideids");
      writeFileSync(path.join(dd, ".session-notes"),
        "# S\n\n## Outstanding ledger (forest)\n\n| F1 | a | anchor | BLOCKED |\nF2/a | b | anchor | BLOCKED\nW3:a | c | anchor | BLOCKED\nFé2 | d | anchor | BLOCKED\n");
      const r = run(dd, [".session-notes"]);
      const n = (r.out.match(/outside the ledger grammar — a pipe outside a table row/g) || []).length;
      if (r.code === 1 && n === 3) console.log("PASS  review-cor-r6-F1-non-ascii-and-punctuated-ids-are-flagged  (exit 1, 3 rows)");
      else fail("review-cor-r6-F1-non-ascii-and-punctuated-ids-are-flagged", `code ${r.code}, ${n} flagged\n${r.out.slice(0, 600)}`);
    }

    // review-cor-r6-F2: a ledger title that is not an ATX heading — here a BOLD line — over rows
    // with no header row is still ledger-shaped.
    check("review-cor-r6-F2-bold-ledger-title-prior-is-still-ledger-shaped",
      partial("boldtitle", `# S\n\n**Outstanding ledger (forest)**\n\n| F1 | a | anchor | BLOCKED |\n| F2 | b | anchor | BLOCKED |\n`), 3, /no ledger section but DOES hold a table/);

    // review-cor-r6-F4: an odd backtick pairing ACROSS cells (it`s … `x`) must not erase the
    // row's pipes — a row without its leading pipe is still flagged.
    {
      const dd = repo("oddtick");
      writeFileSync(path.join(dd, ".session-notes"),
        "# S\n\n## Outstanding ledger (forest)\n\n| F1 | a | anchor | BLOCKED |\nF2 | it`s | `x` | BLOCKED\n");
      check("review-cor-r6-F4-odd-backticks-do-not-hide-a-row", run(dd, [".session-notes"]), 1, /outside the ledger grammar — a pipe outside a table row.*F2 \| it/);
    }

    // ---- round 7 — closed by the STRICT GRAMMAR (operator decision), not by another heuristic ----
    // review-sec-r7-R1 / review-cor-r7-H1: a stray `<!--` in a ledger item made the old comment
    // tracking swallow every later section, so a later table carried a vanished ID (exit 0). The
    // grammar refuses the marker itself; the section still ends at the next heading.
    {
      const dd = repo("straycomment");
      writeFileSync(path.join(dd, ".session-notes"),
        "# S\n\n## Outstanding ledger (forest)\n\n| F1 | handle <!-- in rows | anchor | OPEN |\n\n## Next session plan\n\n| F2 | finish x | unblocks y | NEXT |\n");
      check("review-sec-r7-R1-stray-comment-marker-in-a-row-is-refused", run(dd, [".session-notes"]), 1, /outside the ledger grammar — an HTML comment marker/);
    }

    // review-cor-r7-M1: a backticked status enum in the section is prose with pipes — refused
    // with its line, never counted as (or excused from being) a row.
    {
      const dd = repo("tickenum");
      writeFileSync(path.join(dd, ".session-notes"),
        "# S\n\n## Outstanding ledger (forest)\n\n`OPEN|BLOCKED|HELD|DONE` are the allowed statuses.\n| F1 | a | anchor | BLOCKED |\n");
      check("review-cor-r7-M1-backticked-enum-with-pipes-is-refused", run(dd, [".session-notes"]), 1, /outside the ledger grammar — a pipe outside a table row/);
    }

    // review-sec-r7 (older gap 2): a row typed with FULL-WIDTH pipes (U+FF5C) is invisible to the
    // table parser; accepted as prose it vanished. In a prior it is unrunnable.
    check("review-sec-r7-full-width-pipe-row-in-a-prior-is-unrunnable",
      partial("fullwidth", "# S\n\n## Outstanding ledger (forest)\n\n| F1 | a | anchor | BLOCKED |\n｜ F2 ｜ b ｜ anchor ｜ BLOCKED ｜\n"), 3, /outside the ledger grammar — first: a vertical-bar lookalike/);

    // ---- round 8 (review of the strict grammar c19f595de) ----
    // review-sec-rS-M1 (a): the close phrase matched ANYWHERE, so `Not closed this session: F2`
    // was a close of F2 and F2's later vanish exited 0.
    {
      const dd = repo("notclosed");
      writeFileSync(path.join(dd, ".session-notes"), led("| F1 | a | anchor | BLOCKED |\n| F2 | b | anchor | BLOCKED |"));
      g(dd, "add", ".session-notes");
      g(dd, "commit", "-qm", "prior");
      writeFileSync(path.join(dd, ".session-notes"), led("| F1 | a | anchor | BLOCKED |") + "\nNot closed this session: F2 (blocked on #45)\n");
      check("review-sec-rS-M1-unanchored-close-phrase-is-not-a-close", run(dd, ["--git-prior", ".session-notes"]), 1, /L4\].*"F2" vanished/);
    }

    // review-sec-rS-M1 (b): an UNINDENTED `Still open:` line after a close entry ended nothing, so
    // the bullets under it were filed as closes.
    {
      const dd = repo("stillopen");
      writeFileSync(path.join(dd, ".session-notes"), led("| F1 | a | anchor | BLOCKED |\n| F2 | b | anchor | BLOCKED |"));
      g(dd, "add", ".session-notes");
      g(dd, "commit", "-qm", "prior");
      writeFileSync(path.join(dd, ".session-notes"),
        led("| F3 | c | anchor | BLOCKED |") + "\nClosed this session:\n- F1 → PR #12\nStill open:\n- F2 → waiting on #45\n");
      check("review-sec-rS-M1-unindented-line-ends-the-close-block", run(dd, ["--git-prior", ".session-notes"]), 1, /L4\].*"F2" vanished/);
    }

    // review-sec-rS-M1 (c): an ID that is both an OPEN row and a close entry is refused while both
    // are visible — that contradiction is what later hides the row's vanish.
    {
      const dd = repo("openandclosed");
      writeFileSync(path.join(dd, ".session-notes"),
        led("| F1 | a | anchor | BLOCKED |\n| F2 | b | anchor | BLOCKED |") + "\nClosed this session:\n- F2 → PR #9\n");
      check("review-sec-rS-M1-id-both-open-and-closed-is-refused", run(dd, [".session-notes"]), 1, /ID "F2" is both an open ledger row and a "Closed this session" entry/);
    }

    // review-sec-rS-M2: a row drawn with BOX-DRAWING verticals (U+2502, e.g. copied from a terminal
    // renderer) is invisible to the table parser; accepted as prose it vanished.
    {
      const dd = repo("boxrow");
      writeFileSync(path.join(dd, ".session-notes"),
        "# S\n\n## Outstanding ledger (forest)\n\n| F1 | a | anchor | BLOCKED |\n│ F2 │ b │ anchor │ BLOCKED │\n");
      check("review-sec-rS-M2-box-drawing-row-is-refused", run(dd, [".session-notes"]), 1, /outside the ledger grammar — a vertical-bar lookalike/);
    }

    // review-sec-rS-L1: a CR-only (old-Mac) prior decoded as one line; it read as "no section",
    // a first commit, exit 0. Every reader now splits on CR too, so the prior is READ and F2's
    // vanish is reported (review-cor-r9-F1 moved this from a refusal to a read).
    check("review-sec-rS-L1-cr-only-prior-is-read",
      partial("cronly", "# S\r\r## Outstanding ledger (forest)\r\r| F1 | a | anchor | BLOCKED |\r| F2 | b | anchor | BLOCKED |\r"), 1, /L4\].*"F2" vanished/);

    // review-sec-rS-L3: a `# ` level-1 heading after the ledger once let a table under it join the
    // ledger and re-supply a vanished ID.
    {
      const dd = repo("h1ends");
      writeFileSync(path.join(dd, ".session-notes"), led("| F1 | a | anchor | BLOCKED |\n| F2 | b | anchor | BLOCKED |"));
      g(dd, "add", ".session-notes");
      g(dd, "commit", "-qm", "prior");
      writeFileSync(path.join(dd, ".session-notes"),
        led("| F1 | a | anchor | BLOCKED |") + "\n# Archive\n\n| F2 | old | anchor | DONE |\n");
      // A `# ` line inside the ledger is now REFUSED by the grammar rather than read as a boundary
      // (review-sec-r9-F2 showed the boundary reading hides rows); the table under it cannot
      // re-supply F2 unseen.
      check("review-sec-rS-L3-level-one-heading-in-the-section-is-refused", run(dd, ["--git-prior", ".session-notes"]), 1, /line outside the ledger grammar — a `# ` line/);
    }

    // review-sec-rS (regression list): the ledger heading QUOTED in a fenced example above the real
    // section bound the parse to the quoted copy, so the real ledger was never read.
    {
      const dd = repo("fencedabove");
      writeFileSync(path.join(dd, ".session-notes"),
        "# S\n\n## Template\n\n```\n## Outstanding ledger (forest)\n```\n\n## Outstanding ledger (forest)\n\n| F1 | a | anchor | BLOCKED |\n");
      check("review-sec-rS-heading-quoted-in-a-fence-above-is-not-the-section", run(dd, [".session-notes"]), 0, /OK forest-ledger conformant/);
    }

    // review-cor-rS-MED-2: a GENERATED shared ledger must always be inside the grammar. A todo
    // carrying `-->` / `<!--` reached the renderer verbatim and produced a row the grammar refuses
    // — one the operator cannot fix by hand, since regeneration rewrites it.
    {
      const dd = repo("generated");
      const { renderForestLedgerProjection } = require_(path.resolve(HERE, "..", "..", "hooks", "lib", "session-notes-layout.js"));
      const rows = new Map([
        ["F1", { id: "F1", owner: "o", item: "migrate A --> B", anchorRaw: "why <!-- not a comment", status: "OPEN" }],
        ["F2", { id: "F2", owner: "o", item: "plain item", anchorRaw: "why", status: "OPEN" }],
      ]);
      writeFileSync(path.join(dd, ".session-notes.shared.md"), renderForestLedgerProjection(rows, {}));
      check("review-cor-rS-MED-2-generated-row-with-comment-markers-is-in-grammar", run(dd, [".session-notes.shared.md"]), 0, /OK forest-ledger conformant/);
    }

    // review-cor-rS (lookalike scope): a pipe LOOKALIKE inside a real table row is cell text, not
    // a row delimiter — refusing it would reject any CJK item that uses a full-width bar.
    {
      const dd = repo("cellbar");
      writeFileSync(path.join(dd, ".session-notes"), "# S\n\n## Outstanding ledger (forest)\n\n| F1 | A\uFF5CB | anchor | OPEN |\n");
      check("review-cor-rS-lookalike-inside-a-table-cell-is-cell-text", run(dd, [".session-notes"]), 0, /OK forest-ledger conformant/);
    }

    // review-cor-rS-HIGH-1: --aggregate applies the SAME grammar. A commented template in a
    // workspace ledger used to hide a stranded row there (exit 0); it is now reported.
    {
      const dd = repo("aggregate");
      writeFileSync(path.join(dd, ".session-notes"), "# S\n\n## Outstanding ledger (forest)\n\nForest empty.\n");
      mkdirSync(path.join(dd, "workspaces", "ws1"), { recursive: true });
      writeFileSync(path.join(dd, "workspaces", "ws1", ".session-notes"),
        "# W\n\n## Outstanding ledger (forest)\n\nForest empty\n<!-- template\n## Row format\n-->\n| W1 | a | anchor | OPEN |\n");
      check("review-cor-rS-HIGH-1-aggregate-applies-the-grammar", run(dd, ["--aggregate", "--root", dd]), 1, /workspace ledger .* outside the ledger grammar/);
    }

    // The ROOT ledger is read under the same grammar on --aggregate: its IDs are what every
    // workspace row is reconciled against, so a line it cannot read exactly is reported too.
    {
      const dd = repo("aggregate-root");
      writeFileSync(path.join(dd, ".session-notes"),
        "# S\n\n## Outstanding ledger (forest)\n\n| R1 | a | anchor | OPEN |\nR2 | b | anchor | OPEN |\n");
      check("review-cor-rS-HIGH-1-aggregate-applies-the-grammar-to-the-root", run(dd, ["--aggregate", "--root", dd]), 1, /root ledger .* outside the ledger grammar/);
    }

    // ---- round 9 (review of 06d85b14c): ONE reader for every path ----
    const gp = (name, prior, current) => {
      const dd = repo(name);
      writeFileSync(path.join(dd, ".session-notes"), prior);
      g(dd, "add", ".session-notes");
      g(dd, "commit", "-qm", "prior");
      writeFileSync(path.join(dd, ".session-notes"), current);
      return run(dd, ["--git-prior", ".session-notes"]);
    };
    const agg = (name, rootText, wsText) => {
      const dd = repo(name);
      writeFileSync(path.join(dd, ".session-notes"), rootText);
      mkdirSync(path.join(dd, "workspaces", "ws1"), { recursive: true });
      writeFileSync(path.join(dd, "workspaces", "ws1", ".session-notes"), wsText);
      return run(dd, ["--aggregate", "--root", dd]);
    };
    const TWO = led("| F1 | a | anchor | BLOCKED |\n| F2 | b | anchor | BLOCKED |");
    const ONE = led("| F1 | a | anchor | BLOCKED |");
    const ROOT0 = led("| R1 | r | anchor | OPEN |");

    // review-cor-r9-F1: a CR-only workspace ledger read as empty on --aggregate, exit 0 over W1.
    check("review-r9-aggregate-reads-a-cr-only-workspace-ledger",
      agg("agg-cr", ROOT0, "# W\r\r## Outstanding ledger (forest)\r\r| W1 | w | anchor | OPEN |\r"), 1, /"W1" .* absent from root ledger/);

    // review-cor-r9-F2 / review-sec-r9-F3: a VALID U+FFFD and a stray CR outside the ledger are
    // text. They passed the bare check and then made every later --git-prior refuse.
    {
      const odd = TWO + "\n## Traps\n\nDownloading 10%\r50%\r100% and a literal � glyph\n";
      const dd = repo("valid-odd-text");
      writeFileSync(path.join(dd, ".session-notes"), odd);
      check("review-r9-valid-replacement-char-and-bare-cr-pass-bare", run(dd, [".session-notes"]), 0, /OK forest-ledger conformant/);
      g(dd, "add", ".session-notes");
      g(dd, "commit", "-qm", "prior");
      check("review-r9-valid-replacement-char-and-bare-cr-pass-as-prior", run(dd, ["--git-prior", ".session-notes"]), 0, /OK forest-ledger conformant/);
    }

    // Invalid UTF-8 is refused on EVERY path — the same decoder.
    {
      const dd = repo("bad-utf8");
      writeFileSync(path.join(dd, ".session-notes"), Buffer.concat([Buffer.from(ONE), Buffer.from([0xc3, 0x28, 0x0a])]));
      check("review-r9-invalid-utf8-is-refused-bare", run(dd, [".session-notes"]), 1, /cannot be read as a ledger — it is not valid UTF-8/);
    }
    {
      const dd = repo("utf16-prior");
      writeFileSync(path.join(dd, ".session-notes"), Buffer.from(TWO, "utf16le"));
      g(dd, "add", ".session-notes");
      g(dd, "commit", "-qm", "prior");
      writeFileSync(path.join(dd, ".session-notes"), ONE);
      check("review-r9-utf16-prior-is-unrunnable", run(dd, ["--git-prior", ".session-notes"]), 3, /prior committed file cannot be read — it holds NUL bytes/);
    }

    // review-cor-r9-F3: an INDENTED `Still open:` label ends the close list; F2 under it is open.
    check("review-r9-indented-list-label-ends-the-close-block",
      gp("indented-label", TWO, ONE + "\nClosed this session:\n- F3 → PR #12\n  Still open:\n- F2 → waiting on #45\n"), 1, /L4\].*"F2" vanished/);

    // review-sec-r9 (also noted): a blank line after an entry ends the close list.
    check("review-r9-blank-line-after-an-entry-ends-the-close-block",
      gp("blank-ends", TWO, ONE + "\nClosed this session:\n- F3 → PR #10\n\n- F2 — still blocked on #22\n"), 1, /L4\].*"F2" vanished/);

    // review-cor-r9-F4 / review-sec-r9-F5: the ordinary intro forms are accepted again.
    for (const [tag, intro] of [["h3", "### Closed this session"], ["bullet", "- Closed this session:"], ["bold-colon-inside", "**Closed this session:**"]]) {
      check(`review-r9-close-intro-form-${tag}-is-accepted`,
        gp(`intro-${tag}`, TWO, ONE + `\n${intro}\n- F2 → PR #45\n`), 0, /OK forest-ledger conformant/);
    }
    check("review-r9-close-intro-as-a-bullet-with-inline-entry",
      gp("intro-inline", TWO, ONE + "\n- Closed this session: F2 → PR #12\n"), 0, /OK forest-ledger conformant/);

    // review-sec-r9-F2: a `# ` line inside the ledger (a pasted shell comment) ended the section and
    // hid F2 from the prior, exit 0. It is now outside the grammar — refused on both sides.
    {
      const withHash = led("| F1 | a | anchor | BLOCKED |\n\n# rerun check: node x.mjs\n\n| F2 | b | brief 2 | OPEN |");
      check("review-r9-hash-line-in-prior-is-unrunnable", gp("hash-prior", withHash, ONE), 3, /outside the ledger grammar — first: a `# ` line/);
      const dd = repo("hash-bare");
      writeFileSync(path.join(dd, ".session-notes"), withHash);
      check("review-r9-hash-line-is-refused-bare", run(dd, [".session-notes"]), 1, /a `# ` line/);
    }

    // review-sec-r9-F1/F4: a line-start CODE SPAN is not a fence. Read as one, it put the heading
    // below it "inside a fence": the bare check said "missing section" and --aggregate exit 0.
    {
      const spanAbove = "# WS\n\n```npm test``` passed locally.\n\n## Outstanding ledger (forest)\n\n| W1 | w | anchor | OPEN |\n";
      const dd = repo("span-bare");
      writeFileSync(path.join(dd, ".session-notes"), spanAbove);
      check("review-r9-code-span-above-the-ledger-is-not-a-fence", run(dd, [".session-notes"]), 0, /OK forest-ledger conformant/);
      check("review-r9-aggregate-reads-past-a-code-span", agg("agg-span", ROOT0, spanAbove), 1, /"W1" .* absent from root ledger/);
    }
    // An UNCLOSED fence above the heading hides it; the table left behind is refused, not ignored.
    check("review-r9-aggregate-refuses-a-heading-inside-an-unclosed-fence",
      agg("agg-unclosed", ROOT0, "# WS\n\n```\nlog output\n\n## Outstanding ledger (forest)\n\n| W1 | w | anchor | OPEN |\n"), 1, /workspace ledger .* no ledger section but holds a table/);

    // review-sec-r9-F7: --aggregate refuses what the bare check refuses.
    check("review-r9-aggregate-refuses-a-malformed-row",
      agg("agg-3cell", ROOT0, led("| W0 | w | anchor | OPEN |\n| W1 | ws item | brief 2 |")), 1, /workspace ledger .* 1 row\(s\) could not be parsed/);
    check("review-r9-aggregate-refuses-two-headings",
      agg("agg-2head", ROOT0, "# W\n\n## Outstanding ledger (forest)\n\nForest empty.\n\n## Outstanding ledger (forest)\n\n| W1 | w | anchor | OPEN |\n"), 1, /workspace ledger .* 2 ledger headings/);
    check("review-r9-aggregate-refuses-a-damaged-heading",
      agg("agg-damaged", ROOT0, "# W\n\n## Outstanding ledger (forest) — 1 open\n\n| W1 | w | anchor | OPEN |\n"), 1, /workspace ledger .* no ledger section but holds a table/);

    // review-sec-r9-F6: lookalike rows drawn in LISTED characters (PIPE_LOOKALIKE).
    for (const [tag, c] of [["ffe4", "￤"], ["4e28", "丨"]]) {
      check(`review-r9-lookalike-row-${tag}-in-prior-is-unrunnable`,
        gp(`look-${tag}`, led(`| F1 | a | anchor | BLOCKED |\n${c} F2 ${c} b ${c} brief 2 ${c} OPEN ${c}`), ONE), 3, /outside the ledger grammar/);
    }
    // A listed character refuses the row unspaced too.
    check("review-r9-unspaced-listed-lookalike-row-in-prior-is-unrunnable",
      gp("look-unspaced", led("| F1 | a | anchor | BLOCKED |\n\uFFE4F2\uFFE4b\uFFE4brief 2\uFFE4OPEN\uFFE4"), ONE), 3, /a vertical-bar lookalike/);
    {
      const dd = repo("arrow-prose");
      writeFileSync(path.join(dd, ".session-notes"), led("| F1 | a | anchor | BLOCKED |\n\nOrder: F1 → F2 → F3 → F4 · then ship"));
      check("review-r9-arrow-prose-is-not-a-lookalike-row", run(dd, [".session-notes"]), 0, /OK forest-ledger conformant/);
    }

    // review-sec-r9 (also noted): an ESCAPED pipe is cell text, so an empty anchor after it is seen.
    {
      const dd = repo("escaped-pipe");
      writeFileSync(path.join(dd, ".session-notes"), led("| F4 | p\\|q |  | OPEN |"));
      check("review-r9-escaped-pipe-does-not-shift-the-anchor-column", run(dd, [".session-notes"]), 1, /"F4" has no value-anchor/);
    }

    // ---- round 10 (review of 9b13314ba): one PROBLEM LIST rendered by every path ----
    const THREE = led("| F1 | a | anchor | BLOCKED |\n| F2 | b | anchor | BLOCKED |\n| F3 | c | anchor | BLOCKED |");
    const SHARED = (rows) => `# Forest Ledger\n\n| ID | owner | item | value_anchor | status |\n| --- | --- | --- | --- | --- |\n${rows}\n`;
    const aggFiles = (name, rootText, files) => {
      const dd = repo(name);
      writeFileSync(path.join(dd, ".session-notes"), rootText);
      mkdirSync(path.join(dd, "workspaces", "ws1"), { recursive: true });
      for (const [f, t] of Object.entries(files)) writeFileSync(path.join(dd, "workspaces", "ws1", f), t);
      return run(dd, ["--aggregate", "--root", dd]);
    };

    // review-sec-r10-F1 / review-cor-r10-M2: a NESTED sub-bullet is part of its parent entry, never a
    // close of its own — "  - F3 … still open, tracked in #815" closed F3 and its vanish exited 0.
    check("review-r10-nested-sub-bullet-is-not-a-close",
      gp("nested-sub", THREE, ONE + "\nClosed this session:\n- F2 → PR #812\n  - F3 was scoped out; still open, tracked in #815\n"), 1, /L4\].*"F3" vanished/);
    check("review-r10-harmless-nested-sub-bullet-is-part-of-the-entry",
      gp("nested-ok", TWO, ONE + "\nClosed this session:\n- F2 → PR #12\n  - follow-up detail noted\n"), 0, /OK forest-ledger conformant/);
    check("review-r10-close-list-nested-under-a-bullet-intro",
      gp("nested-list", TWO, ONE + "\n- Closed this session:\n  - F2 → PR #12\n"), 0, /OK forest-ledger conformant/);
    // An intro carrying its own entry sets the list's indentation: a DEEPER bullet under it is part
    // of that entry, not a sibling close.
    check("review-r10-nested-bullet-under-an-inline-intro-entry-is-not-a-close",
      gp("nested-inline", THREE, ONE + "\n- Closed this session: F2 → PR #12\n  - F3 still open, tracked in #815\n"), 1, /L4\].*"F3" vanished/);
    // PRIOR_IGNORES: a prior's close list says nothing about the rows it held OPEN, so a bad close
    // or an open-and-closed ID in the PRIOR does not stop the comparison.
    check("review-r10-prior-with-a-bad-close-list-still-runs",
      gp("prior-badclose", TWO + "\nClosed this session:\n- F9 done, no receipt\n", TWO), 0, /OK forest-ledger conformant/);
    check("review-r10-prior-with-an-open-and-closed-id-still-runs",
      gp("prior-openclosed", TWO + "\nClosed this session:\n- F2 → PR #3\n", ONE), 1, /L4\].*"F2" vanished/);
    // review-cor-r10-M1: a lead-in LABEL ends the list (fail-closed by decision: "The following
    // landed:" cannot be told from "Still open:"); the close is reported as a vanish, loudly.
    check("review-r10-lead-in-label-ends-the-close-list",
      gp("leadin-label", TWO, ONE + "\nClosed this session:\nThe following landed:\n- F2 → PR #12\n"), 1, /L4\].*"F2" vanished/);

    // review-sec-r10-F2: --aggregate applies the close-list (L3) refusals.
    check("review-r10-aggregate-refuses-an-id-both-open-and-closed",
      agg("agg-openclosed", led("| W1 | r | anchor | OPEN |"), led("| W1 | w | anchor | OPEN |\n| W3 | w | anchor | OPEN |") + "\nClosed this session:\n- W3 → PR #812\n"), 1, /workspace ledger .* both an open row and a "Closed this session" entry/);
    check("review-r10-aggregate-refuses-a-receiptless-close",
      agg("agg-noreceipt", led("| W0 | r | anchor | OPEN |"), led("| W0 | w | anchor | OPEN |") + "\nClosed this session:\n- W4 reopened after review, still in progress\n"), 1, /workspace ledger .* lacks an ID or a receipt/);

    // review-sec-r10-F3: the shared form runs to EOF under the grammar; a heading inside it is refused.
    check("review-r10-aggregate-shared-hash-line-does-not-hide-rows",
      aggFiles("agg-shared-hash", led("| W1 | r | anchor | OPEN |"), { ".session-notes.shared.md": SHARED("| W1 | a | x | y | OPEN |\n# rerun: node .claude/bin/foo.mjs\n| W2 | a | x | y | OPEN |") }), 1, /workspace ledger .* a `# ` line/);
    {
      const dd = repo("shared-subheading");
      writeFileSync(path.join(dd, ".session-notes.shared.md"), SHARED("| W1 | a | x | y | OPEN |\n\n### Blocked on review\n\n| W2 | a | x | | OPEN |"));
      check("review-r10-shared-subheading-is-refused", run(dd, [".session-notes.shared.md"]), 1, /a heading inside the whole-file shared ledger/);
    }

    // review-sec-r10-F4: an empty shared file shadowing the workspace's notes is reported, not skipped.
    check("review-r10-aggregate-reports-a-sectionless-ledger-file",
      aggFiles("agg-empty-shared", led("Forest empty."), { ".session-notes.shared.md": "", ".session-notes": led("| W9 | w | anchor | OPEN |") }), 1, /workspace ledger .* it has no ledger section/);

    // review-sec-r10-F5: ordinary prose with repeated one-character words or symbols is NOT a row.
    {
      const dd = repo("prose-ok");
      writeFileSync(path.join(dd, ".session-notes"), led("| F1 | a | anchor | BLOCKED |\n\nя и ты и он и она\n猫 と 犬 と 鳥 と 魚\n3 × 4 × 5 × 6\n✅ W5 done ✅ W6 done ✅ W7 done\nSettings » Account » Security » Keys"));
      check("review-r10-repeated-words-and-symbols-in-prose-are-accepted", run(dd, [".session-notes"]), 0, /OK forest-ledger conformant/);
    }

    // review-sec-r10-F6: a row with FEWER cells than its header (an escaped pipe merged two) is
    // malformed, so an empty anchor cannot hide behind the status cell.
    {
      const dd = repo("short-row");
      writeFileSync(path.join(dd, ".session-notes.shared.md"), SHARED("| W1 | a | copy to C:\\| | OPEN |"));
      check("review-r10-row-shorter-than-its-header-is-malformed", run(dd, [".session-notes.shared.md"]), 1, /malformed ledger row/);
    }

    // review-sec-r10-F7: an indented `  ## ` heading ends the section, and a setext underline is
    // refused — either way a row moved under it is not silently read as open.
    check("review-r10-indented-heading-is-refused",
      gp("indented-h2", THREE, ONE + "\nClosed this session:\n- F2 → PR #9\n\n  ## Archive\n\n| F3 | x | y | ARCHIVED |\n"), 1, /an indented or empty `##` heading/);
    {
      const dd = repo("setext");
      writeFileSync(path.join(dd, ".session-notes"), ONE + "\nArchive\n-------\n\n| F3 | x | y | ARCHIVED |\n");
      check("review-r10-setext-underline-is-refused", run(dd, [".session-notes"]), 1, /a setext heading underline/);
    }

    // ---- round 11 (review of 18fd1dfa5) ----
    // review-cor-r11-M1: an INDENTED second ledger heading is counted like the first — it rendered as
    // a second heading while the count missed it, and the rows under it dropped unseen.
    {
      const dd = repo("indented-second-heading");
      writeFileSync(path.join(dd, ".session-notes"), ONE + "\n  ## Outstanding ledger (forest)\n\n| F2 | b |  | OPEN |\n");
      check("review-r11-indented-second-ledger-heading-is-counted", run(dd, [".session-notes"]), 1, /2 "## Outstanding ledger \(forest\)" headings/);
    }
    // review-cor-r11-M2: a ONE-dash setext underline makes a heading too.
    {
      const dd = repo("setext-one-dash");
      writeFileSync(path.join(dd, ".session-notes"), ONE + "\nArchive\n-\n\n| F3 | x | y | ARCHIVED |\n");
      check("review-r11-one-dash-setext-underline-is-refused", run(dd, [".session-notes"]), 1, /a setext heading underline/);
    }
    // review-cor-r11-L3: a tab advances to the next multiple of four, so "  \t-" and "    -" are one
    // list and F2's close is seen.
    check("review-r11-tab-indentation-uses-tab-stops",
      gp("tab-stops", TWO, ONE + "\nClosed this session:\n  \t- F9 → PR #1\n    - F2 → PR #2\n"), 0, /OK forest-ledger conformant/);

    // review-sec-r11-F1: a sub-bullet indented with a NON-BREAKING or FULL-WIDTH space read as a
    // sibling close (trim() strips it, the indent count did not see it). Refused by the grammar.
    for (const [tag, sp] of [["nbsp", "  "], ["ideographic", "　"]]) {
      check(`review-r11-${tag}-indented-sub-bullet-is-refused`,
        gp(`ws-${tag}`, THREE, ONE + `\nClosed this session:\n- F2 → PR #12\n${sp}- F3 still open, tracked in #815\n`), 1, /leading whitespace other than spaces or tabs/);
    }
    // review-sec-r11-F2: mixed tab/space indentation nests as CommonMark nests it.
    check("review-r11-mixed-tab-indent-nests-the-sub-bullet",
      gp("mixed-tab", THREE, ONE + "\n- Closed this session:\n  \t- F2 → PR #12\n      - F3 still open, tracked in #815\n"), 1, /L4\].*"F3" vanished/);
    // review-sec-r11-F4: an indented `##` in a PRIOR is refused, never a boundary that hides F3.
    check("review-r11-indented-h2-in-prior-is-unrunnable",
      gp("indented-prior", led("| F1 | a | anchor | BLOCKED |\n  ## rerun\n| F3 | c | anchor | BLOCKED |"), ONE), 3, /an indented or empty `##` heading/);
    {
      const dd = repo("empty-h2");
      writeFileSync(path.join(dd, ".session-notes"), ONE + "\n##\n\n| F3 | x | y | OPEN |\n");
      check("review-r11-empty-h2-is-refused", run(dd, [".session-notes"]), 1, /an indented or empty `##` heading/);
    }
    // review-sec-r11-F5: --aggregate reports a ledger it cannot read, and reads a symlinked workspace.
    {
      const dd = repo("agg-eisdir");
      writeFileSync(path.join(dd, ".session-notes"), led("Forest empty."));
      mkdirSync(path.join(dd, "workspaces", "ws1", ".session-notes.shared.md"), { recursive: true });
      writeFileSync(path.join(dd, "workspaces", "ws1", ".session-notes"), led("| W2 | w | anchor | OPEN |"));
      check("review-r11-aggregate-reports-an-unreadable-ledger", run(dd, ["--aggregate", "--root", dd]), 1, /workspace ledger .* it cannot be read \(EISDIR\)/);
    }
    {
      const dd = repo("agg-symlink-ws");
      writeFileSync(path.join(dd, ".session-notes"), led("| W0 | r | anchor | OPEN |"));
      mkdirSync(path.join(dd, "elsewhere", "ws"), { recursive: true });
      writeFileSync(path.join(dd, "elsewhere", "ws", ".session-notes"), led("| W2 | w | anchor | OPEN |"));
      mkdirSync(path.join(dd, "workspaces"), { recursive: true });
      symlinkSync(path.join("..", "elsewhere", "ws"), path.join(dd, "workspaces", "w9"));
      check("review-r11-aggregate-reads-a-symlinked-workspace", run(dd, ["--aggregate", "--root", dd]), 1, /"W2" .* absent from root ledger/);
    }
    // review-sec-r11-F6: --aggregate refuses duplicate IDs, as the bare check does.
    check("review-r11-aggregate-refuses-duplicate-ids",
      agg("agg-dupes", led("| W1 | r | anchor | OPEN |"), led("| W1 | a | anchor | OPEN |\n| W1 | b-different | anchor | OPEN |")), 1, /workspace ledger .* duplicate ID\(s\) "W1"/);
    // review-sec-r11-F7: a `---` rule after a blank line (before the next section) and a header with
    // a trailing empty cell are ordinary markdown, not refusals.
    {
      const dd = repo("hr-before-next");
      writeFileSync(path.join(dd, ".session-notes"), ONE + "\n---\n\n## Next\n\ntext\n");
      check("review-r11-thematic-break-before-the-next-section-is-accepted", run(dd, [".session-notes"]), 0, /OK forest-ledger conformant/);
    }
    {
      const dd = repo("header-trailing-empty");
      writeFileSync(path.join(dd, ".session-notes"), "# S\n\n## Outstanding ledger (forest)\n\n| ID | Item | Value-anchor | Status | |\n| --- | --- | --- | --- | --- |\n| F1 | a | anchor | OPEN |\n");
      check("review-r11-header-trailing-empty-cell-is-no-column", run(dd, [".session-notes"]), 0, /OK forest-ledger conformant/);
    }

    // ---- round 12 (review of d7f4dd69f; operator: simplify, then ship) ----
    // The structural lookalike rule is gone; ordinary prose in uncased scripts and with symbols is
    // accepted again (review-sec-r12-F3, review-cor-r12-F2).
    {
      const dd = repo("uncased-prose");
      writeFileSync(path.join(dd, ".session-notes"), led("| F1 | a | anchor | BLOCKED |\n\nالملف الأول الثاني ينتظر\n이 작업은 이미 이전에 끝났다\nהקובץ הראשון הושלם השבוע\n“F1” “F2” and “F3” were renamed\n§ 3 of the spec, § 4 and § 5 still apply\n× 3 × 4 × 5 later"));
      check("review-r12-uncased-script-and-symbol-prose-is-accepted", run(dd, [".session-notes"]), 0, /OK forest-ledger conformant/);
    }
    // review-cor-r12-F1: an NBSP-only line is not blank (CommonMark), so the `---` under the text
    // above it is still a setext underline; the NBSP line itself is refused.
    {
      const dd = repo("nbsp-blank");
      writeFileSync(path.join(dd, ".session-notes"), ONE + "\nSome note\n \n---\n\n| F2 | b | brief | OPEN |\n");
      check("review-r12-nbsp-only-line-is-not-blank", run(dd, [".session-notes"]), 1, /leading whitespace other than spaces or tabs[\s\S]*a setext heading underline/);
    }
    // review-cor-r12-F3 / review-sec-r12-F6: an empty `## ` (trailing space) is refused, not a boundary.
    check("review-r12-empty-h2-with-trailing-space-in-prior-is-unrunnable",
      gp("empty-h2-space", led("| F1 | a | anchor | BLOCKED |\n## \n| F3 | c | anchor | BLOCKED |"), ONE), 3, /an indented or empty `##` heading/);
    // review-sec-r13-1: a `## ` heading whose text starts with an IME / NBSP space still ends the
    // section — a row moved under it is not read as open, and the next section is not swallowed.
    check("review-r13-ideographic-space-heading-ends-the-section",
      gp("h2-ideographic", TWO, ONE + "\n## \u3000Archive\n\n| F2 | two | a2 | DONE |\n"), 1, /L4\].*"F2" vanished/);
    {
      const dd = repo("h2-ideographic-bare");
      writeFileSync(path.join(dd, ".session-notes"), ONE + "\n## \u3000\u30E1\u30E2\n\nrun `a | b` to check\n\n| x | y |\n");
      check("review-r13-ideographic-space-heading-next-section-is-not-swallowed", run(dd, [".session-notes"]), 0, /OK forest-ledger conformant/);
    }
    // review-sec-r12-F2: both ledger forms in one file are refused, bare and as a prior.
    {
      const both = "# Forest Ledger\n\n| ID | owner | item | value_anchor | status |\n| --- | --- | --- | --- | --- |\n| F1 | a | shared item | anchor1 | OPEN |\n\n## Outstanding ledger (forest)\n\n| F2 | x | anchor2 | OPEN |\n";
      const dd = repo("two-forms");
      writeFileSync(path.join(dd, ".session-notes.shared.md"), both);
      check("review-r12-both-ledger-forms-in-one-file-are-refused", run(dd, [".session-notes.shared.md"]), 1, /both an inline .* and a whole-file "# Forest Ledger" section/);
      g(dd, "add", ".session-notes.shared.md");
      g(dd, "commit", "-qm", "prior");
      writeFileSync(path.join(dd, ".session-notes.shared.md"), "## Outstanding ledger (forest)\n\n| F2 | x | anchor2 | OPEN |\n");
      check("review-r12-both-forms-prior-is-unrunnable", run(dd, ["--git-prior", ".session-notes.shared.md"]), 3, /holds both ledger forms/);
    }
    // review-sec-r12-F1: one workspace link that cannot be followed is REPORTED, and every other
    // workspace is still read.
    {
      const dd = repo("agg-loop");
      writeFileSync(path.join(dd, ".session-notes"), led("| R1 | r | anchor | OPEN |"));
      mkdirSync(path.join(dd, "workspaces", "a"), { recursive: true });
      writeFileSync(path.join(dd, "workspaces", "a", ".session-notes"), led("| W9 | w | anchor | OPEN |"));
      symlinkSync("loop", path.join(dd, "workspaces", "loop"));
      const r = run(dd, ["--aggregate", "--root", dd]);
      check("review-r12-aggregate-reads-past-a-looping-workspace-link", r, 1, /"W9" .* absent from root ledger/);
      check("review-r12-aggregate-reports-the-looping-workspace-link", r, 1, /workspace workspaces\/loop cannot be read \(ELOOP\)/);
    }
    // review-sec-r12-F4: a workspace holding BOTH ledger files has both read.
    check("review-r12-aggregate-reads-a-legacy-ledger-beside-the-shared-one",
      aggFiles("agg-both-files", led("| W1 | r | anchor | OPEN |"), { ".session-notes.shared.md": SHARED("| W1 | a | x | y | OPEN |"), ".session-notes": led("| W8 | w | anchor | OPEN |") }), 1, /"W8" .* absent from root ledger/);
    // review-sec-r12-F4: a workspace that cannot be LISTED is reported (skipped when run as root,
    // where permissions do not bind).
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      const dd = repo("agg-noperm");
      writeFileSync(path.join(dd, ".session-notes"), led("| R1 | r | anchor | OPEN |"));
      mkdirSync(path.join(dd, "workspaces", "a"), { recursive: true });
      writeFileSync(path.join(dd, "workspaces", "a", ".session-notes"), led("| W9 | w | anchor | OPEN |"));
      chmodSync(path.join(dd, "workspaces", "a"), 0o000);
      const r = run(dd, ["--aggregate", "--root", dd]);
      chmodSync(path.join(dd, "workspaces", "a"), 0o755);
      check("review-r12-aggregate-reports-an-unlistable-workspace", r, 1, /workspace workspaces\/a cannot be read \(EACCES\)/);
    } else {
      // Not a PASS: the check did not run. It does not count toward min_cases, so a root run lands
      // one short of the floor and says so, rather than reporting a result nobody measured.
      console.log("SKIP  review-r12-aggregate-reports-an-unlistable-workspace  (running as root: permissions do not bind)");
    }

    // review-cor-r3-M3: the Unicode fold. APFS keeps a name in the form it was CREATED in, so a
    // directory committed as NFC and recreated as NFD is a respelling git cannot see (with
    // precomposeunicode off). Without the NFC fold it read as a first commit, exit 0.
    d = repo("unicode");
    g(d, "config", "core.precomposeunicode", "false");
    const NFC = "café";
    const NFD = "café";
    mkdirSync(path.join(d, NFC));
    writeFileSync(path.join(d, NFC, ".session-notes"), led("| F1 | a | anchor | BLOCKED |"));
    g(d, "add", "-A");
    g(d, "commit", "-qm", "prior");
    rmSync(path.join(d, NFC), { recursive: true, force: true });
    mkdirSync(path.join(d, NFD));
    writeFileSync(path.join(d, NFD, ".session-notes"), led("| F1 | a | anchor | BLOCKED |"));
    {
      const r = run(d, ["--git-prior", path.join(NFD, ".session-notes")]);
      // Where the filesystem itself normalises (the NFD directory resolves back to the NFC
      // name), git finds the committed file directly and the run conserves it: exit 0 with no
      // first-commit note. Anywhere the forms stay distinct, it MUST be a respelling (exit 3).
      const ok = r.code === 3 ? /only under a different spelling/.test(r.out) : r.code === 0 && !/first commit/.test(r.out);
      if (ok) console.log(`PASS  review-cor-r3-M3-unicode-respelling-is-never-a-first-commit  (exit ${r.code})`);
      else fail("review-cor-r3-M3-unicode-respelling-is-never-a-first-commit", `code ${r.code}\n${r.out.slice(0, 600)}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- Class G: the harness's own git setup ----
// review-cor-MEDIUM-2: the harness's OWN git calls must not follow an inherited GIT_DIR.
// Measured before the fix: with GIT_DIR set, this suite's setup commits ("decoy", "prior",
// "p2".."p7") landed in whatever repository GIT_DIR named. The test runs the SETUP SHAPE in
// a child whose parent environment carries GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE aimed at a
// sentinel repo, using the very HERMETIC_ENV constant every setup call site imports — so
// restoring the old `{ ...process.env, … }` constant reds it (review-cor-r2-M1).
{
  const tmp = mkdtempSync(path.join(tmpdir(), "fl-herm-"));
  const NAME = "review-cor-MEDIUM-2-harness-git-ignores-inherited-GIT_DIR";
  try {
    // The oracle's environment is built WITHOUT the module under test.
    const clean = {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^git_/i.test(k))),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    };
    const SENT = path.join(tmp, "sentinel");
    const TGT = path.join(tmp, "target");
    for (const d of [SENT, TGT]) {
      mkdirSync(d);
      execFileSync("git", ["init", "-q"], { cwd: d, stdio: "ignore", env: clean });
      execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: d, stdio: "ignore", env: clean });
      execFileSync("git", ["config", "user.name", "t"], { cwd: d, stdio: "ignore", env: clean });
    }
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "sentinel-base"], { cwd: SENT, stdio: "ignore", env: clean });
    writeFileSync(path.join(TGT, "f"), "x\n");
    const child = [
      `import { execFileSync } from "node:child_process";`,
      `import { HERMETIC_ENV } from ${JSON.stringify(new URL("./hermetic-env.mjs", import.meta.url).href)};`,
      `const o = { cwd: ${JSON.stringify(TGT)}, stdio: "ignore", env: HERMETIC_ENV };`,
      `execFileSync("git", ["add", "f"], o);`,
      `execFileSync("git", ["commit", "-qm", "setup"], o);`,
    ].join("\n");
    let childErr = "";
    try {
      execFileSync("node", ["--input-type=module", "-e", child], {
        stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 15000,
        env: { ...clean, GIT_DIR: path.join(SENT, ".git"), GIT_WORK_TREE: SENT, GIT_INDEX_FILE: path.join(SENT, ".git", "index") },
      });
    } catch (e) {
      childErr = `child failed: ${(e.stderr || e.message || "").toString().slice(0, 300)}`;
    }
    const count = (d) => {
      try {
        return execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: d, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: clean }).trim();
      } catch {
        return "none";
      }
    };
    const sent = count(SENT);
    const tgt = count(TGT);
    if (!childErr && sent === "1" && tgt === "1") console.log(`PASS  ${NAME}  (sentinel 1, target 1)`);
    else fail(NAME, `sentinel ${sent} commit(s), target ${tgt} — setup followed the inherited GIT_DIR ${childErr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("");
if (failed) {
  console.log(`${failed} check(s) FAILED — validator regressed`);
  process.exit(1);
}
console.log(
  // THIS IS NOT A CASE COUNT, and it deliberately prints none. The harness counts every
  // `PASS <name>` line this runner emits, and that — from a real run of
  // `run-audit-fixtures.mjs --only forest-ledger` — is what
  // `ci-audit-fixtures.json::min_cases` is compared against. A count restated here goes
  // stale silently (it read "29 … versus 37" long after both had moved), and a floor
  // "corrected" down to a stale figure permits deleting cases with CI still green.
  `all checks passed (classes A–G; ${fixtures.length} file fixtures in class A)`,
);
process.exit(0);
