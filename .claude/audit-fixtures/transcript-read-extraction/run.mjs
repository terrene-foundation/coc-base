#!/usr/bin/env node
/*
 * Audit fixture runner for the loom#1798 extraction of `readFinalAssistantText`
 * out of `.claude/hooks/detect-violations.js` into `.claude/hooks/lib/transcript-read.js`.
 *
 * WHAT THIS PINS, and what it deliberately does not:
 *   The sibling suite `stop-transcript-read/` drives the REAL hook over stdin and
 *   asserts a Stop detector fires — it answers "does the dispatch path see the
 *   final message". It is scoped to THAT question. It cannot answer "does the
 *   extracted reader return the SAME text the pre-extraction reader returned",
 *   because a detector either fires or does not: two readers returning different
 *   text that both contain the flag phrase are indistinguishable to it
 *   (`instrument-discipline.md` MUST-4 — an instrument is scoped to the question
 *   it was BUILT for). This suite answers the equality question directly.
 *
 * THE ORACLE IS NOT SELF-DERIVED (`evidence-first-claims.md` MUST-5). The
 * expected value is not computed by the code under test, and it is not a golden
 * string transcribed by hand from it either. It is produced by EXECUTING the
 * PRE-extraction implementation, read out of git at the pinned base SHA and
 * compiled in isolation. Oracle and subject are then run over identical inputs
 * and compared. A hand-copied golden would have been a second copy of exactly
 * the thing this change exists to de-duplicate.
 *
 * FAILS LOUD, NEVER OPEN. If the pinned blob is unreachable, or the slice does
 * not compile, or the oracle fails its own positive controls, this exits 1 with
 * the reason. An oracle that could not run is zero evidence, not a pass
 * (`evidence-first-claims.md` MUST-3).
 *
 * Structural probes only: string/JSON equality on `{ text, reason }`. No
 * semantic judgment (`rules/probe-driven-verification.md` MUST-3).
 *
 * Exit 0 = all checks pass. Exit 1 = >=1 check failed.
 */

import { execFileSync } from "node:child_process";
import {
  writeFileSync,
  readFileSync,
  mkdtempSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const require_ = createRequire(import.meta.url);

// The commit this extraction branched from — the last state in which
// `readFinalAssistantText` lived inside detect-violations.js. Pinned, not
// `HEAD~1`: the pin must survive rebases, squashes and later edits to either
// file, and a moving base would silently re-point the oracle at post-extraction
// code, at which point the comparison becomes a tautology.
const BASE_SHA = "f449c0e2c629101c9de1363fd646181bf8818532";
const PRE_PATH = ".claude/hooks/detect-violations.js";

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

function die(msg) {
  process.stderr.write(`\nFATAL: ${msg}\n`);
  process.stderr.write(
    "This suite reports UNRUN, not clean — a missing oracle is zero evidence.\n",
  );
  process.exit(1);
}

// --- the oracle: the PRE-extraction reader, executed --------------------

// The oracle has TWO sources and they are cross-checked against each other
// wherever both exist. In loom the pinned blob is reachable and is authoritative;
// the vendored snapshot is then asserted BYTE-IDENTICAL to it, so the snapshot
// can never quietly drift away from the truth it stands in for. In a consumer
// checkout this file ships (measured: `action: copy`, `reason: tier_match`) but
// loom's history does not, so the snapshot IS the oracle. What is NOT an option
// is skipping: a suite that exits 0 because its oracle was unavailable reports
// clean for a reason that has nothing to do with the code
// (`evidence-first-claims.md` MUST-3).
const SNAPSHOT = join(HERE, "assets", "pre-extraction-reader.js.txt");

function sliceFrom(blob, origin) {
  const lines = blob.split("\n");
  const start = lines.findIndex((l) =>
    l.startsWith("// --- Stop-event final-text recovery"),
  );
  const fnAt = lines.findIndex((l) =>
    l.startsWith("function readFinalAssistantText("),
  );
  if (start < 0 || fnAt < 0) die(`anchors not found in ${origin}`);
  let end = -1;
  for (let i = fnAt + 1; i < lines.length; i++) {
    if (lines[i] === "}") {
      end = i;
      break;
    }
  }
  if (end < 0)
    die(`closing brace of readFinalAssistantText not found in ${origin}`);
  return lines.slice(start, end + 1).join("\n");
}

function preExtractionSource() {
  let snapshot = null;
  try {
    snapshot = readFileSync(SNAPSHOT, "utf8");
  } catch {
    /* absent — only tolerable when the pinned blob is reachable instead */
  }
  let fromGit = null;
  try {
    fromGit = sliceFrom(
      execFileSync("git", ["show", `${BASE_SHA}:${PRE_PATH}`], {
        cwd: REPO,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        // git's own "not a git repository" chatter is EXPECTED on the snapshot
        // path and would otherwise read as a failure in the fixture's output.
        stdio: ["ignore", "pipe", "ignore"],
      }),
      `${PRE_PATH} at ${BASE_SHA.slice(0, 8)}`,
    );
  } catch {
    /* not a loom checkout, or the commit is unreachable — fall back below */
  }
  if (fromGit && snapshot !== null) {
    check(
      "control-vendored-snapshot-matches-the-pinned-git-blob",
      snapshot === fromGit,
      "the committed oracle snapshot has drifted from the pinned pre-extraction blob; " +
        "regenerate it rather than editing it by hand",
    );
    return fromGit;
  }
  if (fromGit) return fromGit;
  if (snapshot !== null) {
    process.stdout.write(
      `  NOTE  pinned blob ${BASE_SHA.slice(0, 8)} unreachable here — oracle read from the vendored snapshot\n`,
    );
    return snapshot;
  }
  die(
    `neither the pinned blob (${BASE_SHA.slice(0, 8)}:${PRE_PATH}) nor the vendored ` +
      "snapshot could be read. The oracle for this pin is one of those two; without " +
      "either, nothing here is measured.",
  );
}

function compileModule(src, label) {
  try {
    const factory = new Function(
      "require",
      "module",
      "exports",
      src +
        "\nmodule.exports = { readFinalAssistantText, TRANSCRIPT_TAIL_BYTES, TRANSCRIPT_MAX_ASSISTANT_ENTRIES };",
    );
    const mod = { exports: {} };
    factory(require_, mod, mod.exports);
    return mod.exports;
  } catch (e) {
    die(`${label} did not compile: ${(e && e.message) || e}`);
  }
}

const ORACLE_SRC = preExtractionSource();
const oracle = compileModule(ORACLE_SRC, "oracle (pre-extraction slice)");
const subject = require_(
  join(REPO, ".claude", "hooks", "lib", "transcript-read.js"),
);

// --- fixture transcripts ------------------------------------------------

const TMP = mkdtempSync(join(tmpdir(), "xread-pin-"));
let seq = 0;
function transcript(rows) {
  const p = join(TMP, `t${seq++}.jsonl`);
  writeFileSync(p, rows.join("\n") + "\n");
  return p;
}
const assistantText = (t) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: t }] },
  });
const assistantTool = () =>
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "t", name: "Bash", input: { command: "ls" } },
      ],
    },
  });
const userRow = (t) =>
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "text", text: t }] },
  });

const HAPPY = "the final assistant message, verbatim";
const BURIED = "buried behind three tool_use turns";
const MIDWINDOW = "sits ~64KB from EOF — inside 512KB, outside a small window";
const FARTEXT = "beyond the 512KB tail window";

// filler is `user` rows, not text-less assistant rows: assistant filler would
// trip the 60-entry walk-back cap and the case would then measure the CAP, not
// the WINDOW. Two independent bounds; a case must isolate one.
function filler(bytes) {
  const row = userRow("x".repeat(200));
  const out = [];
  let n = 0;
  while (n < bytes) {
    out.push(row);
    n += row.length + 1;
  }
  return out;
}

const missingPath = join(TMP, "does-not-exist.jsonl");
const linkTarget = transcript([assistantText("behind a symlink")]);
const linkPath = join(TMP, "link.jsonl");
symlinkSync(linkTarget, linkPath);

const cases = [
  {
    name: "happy-last-entry-has-text",
    arg: transcript([userRow("hi"), assistantText(HAPPY)]),
  },
  {
    name: "walk-back-past-tool_use-turns",
    arg: transcript([
      assistantText(BURIED),
      assistantTool(),
      assistantTool(),
      assistantTool(),
    ]),
  },
  {
    name: "walk-back-cap-exceeded",
    arg: transcript([
      assistantText("never reached"),
      ...Array.from({ length: 70 }, assistantTool),
    ]),
  },
  {
    name: "text-mid-window-64KB-from-EOF",
    arg: transcript([assistantText(MIDWINDOW), ...filler(64 * 1024)]),
  },
  {
    name: "text-beyond-512KB-window",
    arg: transcript([assistantText(FARTEXT), ...filler(600 * 1024)]),
  },
  {
    name: "multiple-text-blocks-joined",
    arg: transcript([
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      }),
    ]),
  },
  {
    name: "malformed-rows-skipped",
    arg: transcript([
      "{not json",
      assistantText("after the garbage"),
      "}{",
      "",
    ]),
  },
  {
    name: "user-rows-are-not-assistant-rows",
    arg: transcript([userRow("user text only")]),
  },
  { name: "empty-file", arg: transcript([]) },
  { name: "path-undefined", arg: undefined },
  { name: "path-null", arg: null },
  { name: "path-empty-string", arg: "" },
  { name: "path-number", arg: 42 },
  { name: "path-object-envelope", arg: { path: "/tmp/x.jsonl" } },
  { name: "path-nonexistent", arg: missingPath },
  { name: "path-symlink", arg: linkPath },
  { name: "path-directory", arg: TMP },
];

function runAll(mod) {
  return cases.map((c) => {
    try {
      return { ok: true, v: mod.readFinalAssistantText(c.arg) };
    } catch (e) {
      return { ok: false, v: `THREW ${(e && e.message) || e}` };
    }
  });
}

const oracleResults = runAll(oracle);

// --- positive controls on the ORACLE (instrument-discipline.md MUST-3a) --
//
// Before the oracle is used to judge anything, it is fired at cases whose answer
// is known independently. An oracle that returned {text:"",reason:null} for
// every input would agree with a totally broken subject on every case and the
// suite would print all-green. These controls are what make the equality
// comparison below capable of the opposite verdict.

check(
  "control-oracle-constants-are-the-measured-ones",
  oracle.TRANSCRIPT_TAIL_BYTES === 512 * 1024 &&
    oracle.TRANSCRIPT_MAX_ASSISTANT_ENTRIES === 60,
  `got ${oracle.TRANSCRIPT_TAIL_BYTES} / ${oracle.TRANSCRIPT_MAX_ASSISTANT_ENTRIES}`,
);
check(
  "control-oracle-source-came-from-git-not-from-the-subject",
  ORACLE_SRC.includes("function readFinalAssistantText(") &&
    ORACLE_SRC.includes("O_NOFOLLOW") &&
    !ORACLE_SRC.includes("module.exports"),
  "sliced source lacks the expected pre-extraction anchors",
);
check(
  "control-oracle-recovers-text-at-all",
  oracleResults[0].v.text === HAPPY && oracleResults[0].v.reason === null,
  JSON.stringify(oracleResults[0].v),
);
check(
  "control-oracle-observes-the-walk-back",
  oracleResults[1].v.text === BURIED,
  JSON.stringify(oracleResults[1].v),
);
check(
  "control-oracle-observes-the-60-entry-cap",
  oracleResults[2].v.text === "" &&
    /60-entry walk-back cap/.test(oracleResults[2].v.reason || ""),
  JSON.stringify(oracleResults[2].v),
);
check(
  "control-oracle-observes-the-512KB-window-boundary",
  oracleResults[3].v.text === MIDWINDOW &&
    oracleResults[4].v.text === "" &&
    /tail/.test(oracleResults[4].v.reason || ""),
  `mid=${JSON.stringify(oracleResults[3].v)} far=${JSON.stringify(oracleResults[4].v)}`,
);
// Index 9 is `path-undefined` (the ordinary no-op: reason null, no WARN) and
// index 12 is `path-number` (offered-but-unusable: a detector blind spot the
// WARN exists to surface). Collapsing those two is the exact regression the
// pre-extraction comments call out, so the oracle is checked to tell them apart.
check(
  "control-oracle-distinguishes-absent-from-unusable-path",
  oracleResults[9].v.reason === null &&
    /unusable \(number\)/.test(oracleResults[12].v.reason || ""),
  `undefined=${JSON.stringify(oracleResults[9].v)} number=${JSON.stringify(oracleResults[12].v)}`,
);

// --- the pin: subject must equal oracle, case by case -------------------

function compare(label, results) {
  const mismatches = [];
  for (let i = 0; i < cases.length; i++) {
    const a = JSON.stringify(oracleResults[i]);
    const b = JSON.stringify(results[i]);
    if (a !== b) mismatches.push(`${cases[i].name}: oracle=${a} ${label}=${b}`);
  }
  return mismatches;
}

const subjectResults = runAll(subject);
for (let i = 0; i < cases.length; i++) {
  const a = JSON.stringify(oracleResults[i]);
  const b = JSON.stringify(subjectResults[i]);
  check(`pin-${cases[i].name}`, a === b, `oracle=${a}\n        subject=${b}`);
}

check(
  "pin-subject-exports-the-constants-by-name",
  subject.TRANSCRIPT_TAIL_BYTES === oracle.TRANSCRIPT_TAIL_BYTES &&
    subject.TRANSCRIPT_MAX_ASSISTANT_ENTRIES ===
      oracle.TRANSCRIPT_MAX_ASSISTANT_ENTRIES,
  `subject ${subject.TRANSCRIPT_TAIL_BYTES}/${subject.TRANSCRIPT_MAX_ASSISTANT_ENTRIES}`,
);

// --- mutation battery ---------------------------------------------------
//
// A green pin that cannot red is not evidence. Both mutants below are built by
// TEXTUAL transformation of the subject source, and each transformation asserts
// it actually APPLIED and actually REACHED the executed code before its result
// is read — a mutation that never landed leaves two hypotheses (vacuous pin OR
// inert mutation) and settles neither (`instrument-discipline.md` MUST-2b).

// The `module.exports` block is stripped and re-added by compileModule, so the
// mutants export the same surface as the oracle regardless of what the shipped
// module chooses to export.
const SUBJECT_SRC = readFileSync(
  join(REPO, ".claude", "hooks", "lib", "transcript-read.js"),
  "utf8",
).replace(/\nmodule\.exports = \{[\s\S]*?\};\n?$/, "\n");
check(
  "mutation-base-source-had-its-exports-stripped",
  !SUBJECT_SRC.includes("module.exports"),
  "the strip did not apply; both mutants would carry a duplicate export block",
);

// (1) EFFICACY mutation — shrink the tuned window. This is the exact drift the
// extraction exists to prevent: one guard on 512KB, another left on a stale
// smaller window, reading a truncated slice and reporting clean.
const NEEDLE = "const TRANSCRIPT_TAIL_BYTES = 512 * 1024;";
check(
  "mutation-window-needle-present",
  SUBJECT_SRC.includes(NEEDLE),
  "subject source shape changed; the window mutation would be inert",
);
const windowSrc = SUBJECT_SRC.replace(
  NEEDLE,
  "const TRANSCRIPT_TAIL_BYTES = 8 * 1024;",
);
const windowMutant = compileModule(windowSrc, "window mutant");
check(
  "mutation-window-reached-the-executed-code",
  windowMutant.TRANSCRIPT_TAIL_BYTES === 8 * 1024,
  `mutant still reports ${windowMutant.TRANSCRIPT_TAIL_BYTES} — the mutation did not land, so its result says nothing`,
);
const windowMismatches = compare("window-mutant", runAll(windowMutant));
check(
  "mutation-window-REDS-the-pin",
  windowMismatches.length > 0,
  "the shrunk window changed no case — this pin cannot detect the drift it exists for",
);
check(
  "mutation-window-reds-the-mid-window-case-specifically",
  windowMismatches.some((m) => m.startsWith("text-mid-window-64KB-from-EOF:")),
  `reds were: ${windowMismatches.join(" | ") || "(none)"}`,
);

// (2) SCOPE mutation — a DIFFERENT but equally correct way to walk the entries
// back. It must leave the pin GREEN. If it reds, the pin bans a refactor rather
// than the defect, and the first person it blocks will delete it.
const LOOP_NEEDLE = "for (let i = lines.length - 1; i >= 0; i--) {";
check(
  "mutation-scope-needle-present",
  SUBJECT_SRC.includes(LOOP_NEEDLE),
  "loop shape changed; the scope mutation would be inert",
);
let scopeSrc = SUBJECT_SRC.replace(
  LOOP_NEEDLE,
  "for (const __ln of lines.slice().reverse()) {",
);
const before = (scopeSrc.match(/lines\[i\]/g) || []).length;
scopeSrc = scopeSrc.split("lines[i]").join("__ln");
check(
  "mutation-scope-reached-the-executed-code",
  before === 2 && !scopeSrc.includes("lines[i]") && scopeSrc.includes("__ln"),
  `expected 2 lines[i] references, saw ${before}`,
);
const scopeMutant = compileModule(scopeSrc, "scope mutant");
check(
  "mutation-scope-mutant-still-recovers-text",
  scopeMutant.readFinalAssistantText(cases[0].arg).text === HAPPY,
  "the alternative implementation is broken, so its green says nothing about the pin",
);
const scopeMismatches = compare("scope-mutant", runAll(scopeMutant));
check(
  "mutation-scope-leaves-the-pin-GREEN",
  scopeMismatches.length === 0,
  `pin bans an equally-valid implementation: ${scopeMismatches.join(" | ")}`,
);

// --- teardown -----------------------------------------------------------

try {
  rmSync(TMP, { recursive: true, force: true });
} catch {
  /* temp cleanup only — never fail the suite on it */
}

process.stdout.write(`\n${passed}/${passed + failed} checks pass\n`);
process.exit(failed === 0 ? 0 : 1);
