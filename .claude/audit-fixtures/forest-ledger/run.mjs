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
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VALIDATOR = path.resolve(HERE, "..", "..", "bin", "validate-forest-ledger.mjs");
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

// Hermetic git: neutralize operator/CI global+system git config so the
// throwaway L4 repo cannot inherit init.templateDir / core.hooksPath and
// execute external hooks (journal/0090 security M-2). Bounded exec
// (timeout + maxBuffer) per security M-1.
const HERMETIC_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

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
      // append a unique trailing comment so every commit has a distinct
      // tree (identical ledger content across blocks would otherwise make
      // `git commit` exit non-zero "nothing to commit" and throw). The
      // marker is inert prose after the section — invisible to the gate.
      writeFileSync(NOTES, `${content}\n<!-- seq:${++seq} -->\n`);
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
    if (r.code === 0) console.log("PASS  l4-prior-no-section-graceful  (exit 0)");
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

console.log("");
if (failed) {
  console.log(`${failed} check(s) FAILED — validator regressed`);
  process.exit(1);
}
console.log(
  `all checks passed (${fixtures.length} fixtures + IO + L4 ID-conservation: vanish + carried+closed + exact-id-no-collision + reword-stable + prior-no-section + canonical-backtick-close + prior-dup-surfaced)`,
);
process.exit(0);
