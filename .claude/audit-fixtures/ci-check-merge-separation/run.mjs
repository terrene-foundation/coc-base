#!/usr/bin/env node
/**
 * ci-check-merge-separation — fixture runner.
 *
 * Drives the PURE predicates in `.claude/hooks/lib/check-merge-separation.js` over the `.txt`
 * fixtures beside this file, one Bash command string per fixture, and asserts the expected verdict
 * per case.
 *
 *   node .claude/audit-fixtures/ci-check-merge-separation/run.mjs
 *   rc=$?        # 0 = all green
 *
 * Override the module under test (to RED the suite against a mutant) with:
 *   LIB=/abs/path/to/mutant.js node .claude/audit-fixtures/ci-check-merge-separation/run.mjs
 *
 * BIPOLAR ON EVERY SCOPE-RESTRICTION PREDICATE, because a one-poled set is worthless here: a set
 * that only asserts FIRING passes identically against a detector that fires on everything, and a
 * set that only asserts SILENCE passes identically against an INERT one. This guard is capped
 * below `block`, so an inert advisory is indistinguishable from a clean session — the silence
 * poles are the ones that can rot unnoticed. Each `clean-`/`skip-` case therefore ALSO pins WHY it
 * is silent (`classifyCommand`'s reader/merge counts), so a silence caused by the parser failing
 * to see the merge at all can never masquerade as the scope restriction under test.
 *
 * FAILURE IDENTITY (`instrument-bipolarity.md` MUST-2): a red case prints the case NAME, the
 * PREDICATE that failed, and the falsifier — never a bare non-zero exit.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const require_ = createRequire(import.meta.url);
const LIB_PATH =
  process.env.LIB || path.join(REPO, ".claude/hooks/lib/check-merge-separation.js");
const lib = require_(LIB_PATH);

let pass = 0;
let fail = 0;
function check(name, ok, detail, falsifier) {
  const idx = String(pass + fail + 1).padStart(2, "0");
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${idx}  ${name}`);
  if (detail) console.log(`      ${detail}`);
  if (!ok) console.log(`      FALSIFIER: ${falsifier}`);
}

/**
 * One row per fixture. `expect` is "flag" or "silent"; `readers`/`merges` pin the CAUSE of the
 * verdict; `watch` pins which evidence line the finding carries.
 */
const CASES = [
  {
    file: "flag-watch-then-merge.txt",
    expect: "flag",
    readers: 1,
    merges: 1,
    watch: true,
    predicate:
      "the rule's NAMED worst case — `gh pr checks --watch && gh pr merge`. The --watch may resolve green against the PRIOR commit's run; the && merges on that exit status. Carries the distinct blocking-watch evidence line.",
  },
  {
    file: "flag-checks-and-merge-bundled.txt",
    expect: "flag",
    readers: 1,
    merges: 1,
    watch: false,
    predicate:
      "CO-OCCURRENCE, not the separator — a non-blocking `gh pr checks --json` and the merge in ONE call, split by `;` rather than `&&`. Fires on the generic evidence line, proving the detector is not keyed on `&&` or on `--watch`.",
  },
  {
    file: "flag-run-watch-then-merge.txt",
    expect: "flag",
    readers: 1,
    merges: 1,
    watch: true,
    predicate:
      "the run-surface reader verb — `gh run watch <id> && gh pr merge`. Same race, different verb, and NO `--watch` flag to key on: the reader is recognised by parsed (group, sub) position, and hasWatchFlag reads the VERB so this form gets the blocking-watch line too rather than the milder one.",
  },
  {
    file: "clean-merge-alone.txt",
    expect: "silent",
    readers: 0,
    merges: 1,
    predicate:
      "THE MOST IMPORTANT CLEAN POLE — a bare `gh pr merge` is the COMPLIANT shape the rule prescribes once the pinned read happened in its own earlier call. A detector that fires on every merge is worse than none. The merge IS seen (merges=1), so the silence is attributable to the ABSENT reader and not to a parser that missed the merge.",
  },
  {
    file: "clean-checks-alone.txt",
    expect: "silent",
    readers: 1,
    merges: 0,
    predicate:
      "the mirror pole — a bare `gh pr checks --watch` is the (1) READ step done properly. The reader IS seen (readers=1), so the silence is attributable to the absent merge.",
  },
  {
    file: "clean-pinned-read-then-separate-merge.txt",
    expect: "silent",
    readers: 0,
    merges: 1,
    predicate:
      "the rule's own DO form — `head=$(gh pr view <N> --json headRefOid …)` pins the SHA, and the merge follows. `gh pr view` is a PIN read, not a CI-state read, so it is not in the reader class and this compliant shape stays silent even though a merge is present.",
  },
  {
    file: "clean-merge-help-withdrawn.txt",
    expect: "silent",
    readers: 0,
    merges: 0,
    predicate:
      "the WITHDRAW arm — `gh pr merge --help` parses as group=pr sub=merge but runs no merge, so isRealMerge withdraws it (merges=0). This is the command an operator runs when LEARNING the correct form; firing on it would be a pure false positive at the worst moment.",
  },
  {
    file: "skip-embedded-in-heredoc.txt",
    expect: "silent",
    readers: 0,
    merges: 0,
    predicate:
      "SEGMENT ANCHORING via `stripHeredocBodies` — the bundled form quoted inside a `<<'EOF'` body is DOCUMENTATION being written to a runbook, not a command. Both counts are 0 because the body never reaches command position.",
  },
  {
    file: "skip-embedded-in-comment.txt",
    expect: "silent",
    readers: 0,
    merges: 0,
    predicate:
      "`stripShellComments` — the bundled form after a `#` is a comment; the live line beneath it is a lone `gh pr view`. Both counts 0 proves the comment was blanked rather than parsed.",
  },
  {
    file: "skip-quoted-example.txt",
    expect: "silent",
    readers: 0,
    merges: 0,
    predicate:
      "quoted ARGUMENT — `echo \"gh pr checks … && gh pr merge …\"` mentions the form inside a single argument. Quote-aware segmentation keeps it one `echo` segment, so no gh invocation is parsed at all.",
  },
  {
    file: "clean-unresolvable-substitution.txt",
    expect: "silent",
    merges: 0,
    predicate:
      "FAIL-OPEN on an unresolved subcommand — `gh pr $(cat /tmp/verb2) … ` cannot be resolved to `merge`, so merges=0 and the detector stays silent rather than guessing. A guard that fired on what it cannot read would fire hardest on the commands it least understands.",
  },
];

console.log("=== fixture cases — bipolar on every scope-restriction predicate ===");
for (const c of CASES) {
  const p = path.join(HERE, c.file);
  let text;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch (e) {
    check(
      `${c.file} — fixture readable`,
      false,
      `read failed: ${e.message}`,
      "the fixture file is missing; the case asserted nothing.",
    );
    continue;
  }
  const cls = lib.classifyCommand(text);
  const finding = lib.detectBundledCheckAndMerge(text);
  const fired = finding !== null;
  const wantFire = c.expect === "flag";

  const causeOk =
    (c.readers === undefined || cls.readers.length === c.readers) &&
    (c.merges === undefined || cls.merges.length === c.merges);
  const watchOk = c.watch === undefined || cls.watch === c.watch;
  const idOk = !wantFire || (finding.rule_id === lib.RULE_ID && finding.severity === "halt-and-report");

  check(
    `${c.file} — MUST ${wantFire ? "FLAG" : "STAY SILENT"}`,
    fired === wantFire && causeOk && watchOk && idOk,
    `verdict=${fired ? "FLAG" : "silent"} readers=${cls.readers.length} merges=${cls.merges.length} watch=${cls.watch}` +
      (wantFire && finding ? ` id=${finding.rule_id} sev=${finding.severity}` : ""),
    `PREDICATE "${c.predicate}" — expected ${wantFire ? "a finding" : "silence"} with readers=${c.readers}, merges=${c.merges}` +
      (c.watch === undefined ? "" : `, watch=${c.watch}`) +
      `; got ${fired ? "a finding" : "silence"} with readers=${cls.readers.length}, merges=${cls.merges.length}, watch=${cls.watch}` +
      (wantFire && !idOk ? ` and identity ${finding ? `${finding.rule_id}/${finding.severity}` : "(none)"}` : "") +
      ". A mismatch here means this predicate no longer discriminates.",
  );
}

// ── the UNKNOWN / fail-open pole, driven at the tool-payload seam ─────────────────────────────
//
// Not a `.txt` fixture, because the input under test is an ABSENT or MALFORMED payload rather than
// a command string. Rule 7 requires every one of these to return [] — a guard that cannot measure
// must not speak.
console.log("\n=== fail-open pole — inspectBashCommand over unknown payloads ===");
const UNKNOWN = [
  ["absent tool_input", ["Bash", undefined]],
  ["null tool_input", ["Bash", null]],
  ["tool_input with no command", ["Bash", { file_path: "/tmp/x" }]],
  ["non-string command", ["Bash", { command: 42 }]],
  ["empty command", ["Bash", { command: "   " }]],
  [
    "non-Bash tool carrying the bundled text",
    ["Edit", { command: "gh pr checks 1 --watch && gh pr merge 1" }],
  ],
];
for (const [label, [tool, input]] of UNKNOWN) {
  let out;
  try {
    out = lib.inspectBashCommand(tool, input);
  } catch (e) {
    out = `THREW: ${e.message}`;
  }
  check(
    `fail-open: ${label} ⇒ []`,
    Array.isArray(out) && out.length === 0,
    `inspectBashCommand => ${JSON.stringify(out)}`,
    "PREDICATE \"unknown ⇒ fail open (cc-artifacts.md Rule 7)\" — an unreadable or off-matcher payload produced a finding or threw. A guard that guesses when it cannot see fires hardest on what it least understands, and a throw here would crash the hook instead of passing through.",
  );
}

// ── the POSITIVE CONTROL for the fail-open arm ────────────────────────────────────────────────
//
// Every row above is satisfied by an INERT module that returns [] for everything. This one case
// requires the same entry point to SPEAK on a well-formed bundled payload, so the silences above
// are attributable to the unknown-input arm and not to a dead detector
// (`instrument-discipline.md` MUST-3(a)).
{
  const out = lib.inspectBashCommand("Bash", {
    command: "gh pr checks 2119 --watch && gh pr merge 2119 --admin --merge",
  });
  check(
    "control: the SAME entry point FIRES on a well-formed bundled payload",
    Array.isArray(out) && out.length === 1 && out[0].rule_id === lib.RULE_ID,
    `inspectBashCommand => ${out.length} finding(s)${out[0] ? ` id=${out[0].rule_id}` : ""}`,
    "PREDICATE \"the fail-open silences are attributable to the INPUT, not to an inert module\" — without this control an entirely dead inspectBashCommand passes every fail-open row above.",
  );
}

console.log(
  `\n${"=".repeat(62)}\nSUMMARY: ${pass} passed, ${fail} failed\n${"=".repeat(62)}`,
);
process.exit(fail === 0 ? 0 : 1);
