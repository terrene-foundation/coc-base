#!/usr/bin/env node
/**
 * Bipolar fixtures for the session-load backstop (journal/0609 decision 2).
 *
 * EVERY process table here is FABRICATED. No case launches, reproduces or simulates CPU load:
 * a detector for synthetic load on a shared machine must be provable without generating any.
 * The only real subprocesses are ONE read-only `ps` (the readProcessTable smoke case) and ONE
 * spawn of the real hook for the end-to-end case, which itself reads the table read-only.
 *
 * TWO TIERS.
 *   Tier A — the backstop's OWN logic (ps parsing, etime, ancestry, root identification,
 *            scope, sustain floors, leaf folding, scrubbing, the report) against a STUB
 *            classifier, so each predicate is pinned independently of the classifier.
 *   Tier B — the SAME tables against the REAL synthetic-load classifier
 *            (`hooks/lib/synthetic-load.js`). If that library is absent, every Tier-B case
 *            FAILS by name: an integration that silently skips reads as covered.
 *
 * Every pair asserts IDENTITY (rule_id + kind + pid), not a count alone — a report naming the
 * wrong pid is the backstop telling an agent to stop someone else's process.
 */
import "../_lib/no-ambient-git.cjs";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const L = require_("../../hooks/lib/session-load-backstop.js");
const { instructAndWait } = require_("../../hooks/lib/instruct-and-wait.js");
const HOOK = path.resolve(__dirname, "../../hooks/session-load-backstop.js");
const W1_PATH = path.resolve(__dirname, "../../hooks/lib/synthetic-load.js");

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    failures.push(`${name}: ${detail}`);
    console.log(`FAIL ${name}`);
  }
}
function polesDiffer(name, a, b) {
  check(name, a !== b, `both poles returned ${JSON.stringify(a)} — the pair is VACUOUS and proves nothing`);
}
const J = (x) => JSON.stringify(x);
const RULE = "ci-cost-discipline/MUST-7";

// ── the stub classifier (Tier A) ─────────────────────────────────────────────
// Deliberately small and exact: it exists so the BACKSTOP's predicates are tested, not the
// classifier's. It classifies a stress tool at argv[0], and an interpreter/shell body that is
// an empty-bodied loop.
function stubClassify(argv, ctx) {
  const b = String(argv[0]).split("/").pop();
  if (b === "stress-ng" || b === "stress") {
    return { rule_id: RULE, kind: "load-tool", severity: "block", matched: b, evidence: "stub" };
  }
  // CONTEXT-DEPENDENT words, mirroring the real classifier's contract: `yes` is load only
  // where its output goes, so argv ALONE is null and only a `{stdoutDiscard:true}` reading
  // classifies. `gzip` stays null under BOTH readings — it is the no-false-positive control
  // for the re-classification path (the real classifier also needs an infinite source).
  if (b === "yes") {
    return ctx && ctx.stdoutDiscard
      ? { rule_id: RULE, kind: "load-tool", severity: "block", matched: "yes", evidence: "stub" }
      : null;
  }
  if (b === "gzip") return null;
  const body = argv.length >= 3 ? argv[argv.length - 1] : "";
  // MIRRORS the lib's `interpreterFamily`, including `bun`/`deno`/`pypy`: a stub that knows
  // fewer interpreters than the code under test reports a FAIL against correct argv, which
  // is what it did when these three were added.
  if (/^(node|nodejs|bun|deno|python\d*|pypy\d*|perl|ruby|sh|bash|zsh)$/.test(b)) {
    if (/stress-ng/.test(body)) {
      return { rule_id: RULE, kind: "load-tool", severity: "block", matched: "stress-ng", evidence: "stub" };
    }
    // `.*` not `[^)]*`: a condition like `Date.now()<e` contains its own parentheses.
    if (/while\s*\(.*\)\s*\{\s*\}/.test(body) || /while\s+True:\s*pass/.test(body) || /while\s*:\s*;\s*do\s*:\s*;\s*done/.test(body)) {
      return { rule_id: RULE, kind: "busy-loop", severity: "halt-and-report", matched: body.slice(0, 40), evidence: "stub" };
    }
  }
  return null;
}

// ── fabricated tables ────────────────────────────────────────────────────────
// Shape measured on a real machine (see the lib header), with every path genericized.
const HEADER = "  PID  PPID  %CPU  ELAPSED COMMAND";
const SELF = 9100;
const SELF_PARENT = 9099;
const ROOT = 5000;
const OTHER_ROOT = 5100;
const BASE = [
  "    1     0   0.5 2-02:00:00 /sbin/launchd",
  " 3000     1   0.1 02:00:00 tmux new -s work",
  " 4000  3000   0.0 01:59:00 -zsh",
  " 5000  4000  12.0 01:58:00 claude",
  " 4100  3000   0.0 01:00:00 -zsh",
  " 5100  4100   9.0 00:59:00 claude",
  " 6000  5000   0.3 01:50:00 node /opt/mcp/server.js --stdio",
  " 9099  5000   0.0    00:01 /bin/sh -c node /repo/.claude/hooks/session-load-backstop.js",
  " 9100  9099   3.0    00:01 node /repo/.claude/hooks/session-load-backstop.js",
];
const table = (...extra) => [HEADER, ...BASE, ...extra].join("\n");
const BUSY = "node -e const e=Date.now()+900*1000;while(Date.now()<e){}";
// The stub's context-dependent words. `gzip` is deliberately IN the set and never classified:
// membership opens the re-classification path, the classifier still refuses.
const STUB_CONDITIONAL = new Set(["yes", "gzip", "cat", "dd"]);
const assess = (text, classify = stubClassify, over = {}) =>
  L.assessSessionLoad({
    rows: L.parsePsTable(text),
    selfPid: SELF,
    selfPpid: SELF_PARENT,
    classify,
    conditionalWords: STUB_CONDITIONAL,
    ...over,
  });
const ids = (a) => a.findings.map((f) => `${f.rule_id}|${f.kind}|${f.pid}`);

function runTables(tier, classify, conditional = STUB_CONDITIONAL) {
  const assess = (text, cls = classify, over = {}) =>
    L.assessSessionLoad({
      rows: L.parsePsTable(text),
      selfPid: SELF,
      selfPpid: SELF_PARENT,
      classify: cls,
      conditionalWords: conditional,
      ...over,
    });
  // PAIR 1 — a session-descendant sustained busy loop reports; the SAME command under a
  // DIFFERENT session's root is silent. The whole scope contract in one pair.
  const mine = assess(
    table(
      ` 7001  5000   0.0    00:40 /bin/zsh -c ${BUSY} & wait`,
      ` 7002  7001  97.5    00:38 ${BUSY}`,
    ),
    classify,
  );
  const theirs = assess(
    table(
      ` 7001  5100   0.0    00:40 /bin/zsh -c ${BUSY} & wait`,
      ` 7002  7001  97.5    00:38 ${BUSY}`,
    ),
    classify,
  );
  check(
    `${tier}-pair1-red-session-descendant-busy-loop-REPORTS-by-identity`,
    mine.verdict === "report" && J(ids(mine)) === J([`${RULE}|busy-loop|7002`]),
    `expected exactly [${RULE}|busy-loop|7002]; got ${J(mine)}`,
  );
  check(
    `${tier}-pair1-green-same-command-under-ANOTHER-session-is-SILENT`,
    theirs.verdict === "silent" && theirs.findings.length === 0,
    `another session's process must never be reported — that tells an agent to kill work that is not its own; got ${J(theirs)}`,
  );
  polesDiffer(`${tier}-pair1-poles-differ`, mine.verdict, theirs.verdict);

  // PAIR 2 — legitimately heavy descendants the classifier does not recognise are SILENT,
  // while a busy loop at the SAME CPU and age reports. CPU alone is never the signal.
  const legit = assess(
    table(
      ` 7101  5000  39.0    03:10 node /repo/node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`,
      ` 7102  5000  33.0    12:00 python -u -c import sys;exec(eval(sys.stdin.readline()))`,
    ),
    classify,
  );
  const burner = assess(table(` 7103  5000  39.0    03:10 ${BUSY}`), classify);
  check(
    `${tier}-pair2-green-tsc-39pct-and-python-repl-33pct-are-SILENT`,
    legit.verdict === "silent",
    `a compiler and a REPL worker are the session's real work; got ${J(legit)}`,
  );
  check(
    `${tier}-pair2-red-busy-loop-at-the-same-cpu-and-age-REPORTS`,
    burner.verdict === "report" && J(ids(burner)) === J([`${RULE}|busy-loop|7103`]),
    `got ${J(burner)}`,
  );
  polesDiffer(`${tier}-pair2-poles-differ`, legit.verdict, burner.verdict);

  // PAIR 3 — the SUSTAIN floor applies to busy loops only. A young busy loop is silent; a
  // stress-ng of the same age reports, because a stress tool has no purpose but load.
  const youngLoop = assess(table(` 7201  5000  60.0    00:05 ${BUSY}`), classify);
  const youngStress = assess(table(` 7202  5000   0.0    00:05 stress-ng --cpu 4 --timeout 600`), classify);
  check(`${tier}-pair3-green-young-busy-loop-below-sustain-is-SILENT`, youngLoop.verdict === "silent", J(youngLoop));
  check(
    `${tier}-pair3-red-stress-ng-of-the-same-age-REPORTS-regardless-of-cpu`,
    youngStress.verdict === "report" && J(ids(youngStress)) === J([`${RULE}|load-tool|7202`]),
    J(youngStress),
  );
  polesDiffer(`${tier}-pair3-poles-differ`, youngLoop.verdict, youngStress.verdict);

  // PAIR 4 — the incident shape: three groups under three parents in one session → three
  // findings, one per burner, each naming its own parent; the wrapper shells are FOLDED.
  const incident = assess(
    table(
      ` 7301  5000   0.0    06:00 /bin/zsh -c node -e "const e=Date.now()+900*1000;while(Date.now()<e){}" & wait`,
      ` 7302  7301  31.0    05:58 node -e const e=Date.now()+900*1000;while(Date.now()<e){}`,
      ` 7311  5000   0.0    06:00 /bin/zsh -c node -e "const e=Date.now()+1500*1000;while(Date.now()<e){}" & wait`,
      ` 7312  7311  29.5    05:58 node -e const e=Date.now()+1500*1000;while(Date.now()<e){}`,
      ` 7321  5000   0.0    06:00 /bin/zsh -c node -e "const e=Date.now()+1800*1000;while(Date.now()<e){}" & wait`,
      ` 7322  7321  30.2    05:58 node -e const e=Date.now()+1800*1000;while(Date.now()<e){}`,
    ),
    classify,
  );
  check(
    `${tier}-pair4-red-three-incident-groups-yield-THREE-findings-by-identity`,
    incident.verdict === "report" &&
      J(ids(incident)) === J([`${RULE}|busy-loop|7302`, `${RULE}|busy-loop|7312`, `${RULE}|busy-loop|7322`]) &&
      J(incident.findings.map((f) => f.ppid)) === J([7301, 7311, 7321]),
    `got ${J(incident)}`,
  );
  const incidentOther = assess(
    table(
      ` 7301  5100   0.0    06:00 /bin/zsh -c node -e "const e=Date.now()+900*1000;while(Date.now()<e){}" & wait`,
      ` 7302  7301  31.0    05:58 node -e const e=Date.now()+900*1000;while(Date.now()<e){}`,
    ),
    classify,
  );
  check(`${tier}-pair4-green-incident-group-in-another-session-is-SILENT`, incidentOther.verdict === "silent", J(incidentOther));
  polesDiffer(`${tier}-pair4-poles-differ`, incident.findings.length, incidentOther.findings.length);

  // PAIR 16 — FOLDING HIDES A BURNING PARENT. Both poles are a parent/child pair whose
  // commands are IDENTICAL and whose child burns at the same 97%; they separate ONLY on the
  // PARENT's own CPU. A wrapper waiting at 0% is folded into its child (one finding); a
  // parent burning at 50% is its own finding and is listed ALONGSIDE the child (two) — the
  // agent that kills only the child otherwise leaves the parent burning, and the group advice
  // that says "stop the parent too" needs two flagged CHILDREN, so nothing names it.
  const burningParent = assess(
    table(` 7001  5000  50.0    05:00 ${BUSY}`, ` 7002  7001  97.0    04:58 ${BUSY}`),
  );
  const idleWrapper = assess(
    table(` 7011  5000   0.0    05:00 /bin/zsh -c ${BUSY} & wait`, ` 7012  7011  97.0    04:58 ${BUSY}`),
  );
  check(
    `${tier}-pair16-red-burning-PARENT-and-burning-child-are-BOTH-reported`,
    J(ids(burningParent)) === J([`${RULE}|busy-loop|7001`, `${RULE}|busy-loop|7002`]),
    `a parent at 50% CPU is burning in its own right and must not be folded away; got ${J(burningParent)}`,
  );
  check(
    `${tier}-pair16-green-idle-WRAPPER-below-the-cpu-floor-is-still-FOLDED`,
    J(ids(idleWrapper)) === J([`${RULE}|busy-loop|7012`]) && idleWrapper.findings[0].ppid === 7011,
    `a 0% wrapper is the same work as its child; got ${J(idleWrapper)}`,
  );
  polesDiffer(`${tier}-pair16-poles-differ`, burningParent.findings.length, idleWrapper.findings.length);

  // PAIR 17 — CONTEXT-DEPENDENT LOAD WORDS. `yes > /dev/null &` launched inside a script is
  // a `yes` row with no redirect recorded anywhere in the table, and argv alone classifies
  // null — so it was never reported however long it burned. Sustained CPU IS the missing
  // evidence (a `yes` feeding a live consumer blocks on the pipe at ~0%), so a row over both
  // floors is re-read as discarding its output. The green poles are the three ways that must
  // NOT fire: below the floors, a stream tool on a real file, and no word list at all.
  const yesBurning = assess(table(` 7021  5000  95.0    02:00 yes`));
  const yesYoung = assess(table(` 7022  5000  95.0    00:05 yes`));
  const yesBlocked = assess(table(` 7023  5000   0.0    02:00 yes`));
  const gzipReal = assess(table(` 7024  5000  90.0    02:00 gzip -9 /repo/big.tar`));
  const noWords = assess(table(` 7025  5000  95.0    02:00 yes`), classify, { conditionalWords: null });
  check(
    `${tier}-pair17-red-sustained-yes-REPORTS-as-a-load-tool`,
    J(ids(yesBurning)) === J([`${RULE}|load-tool|7021`]),
    `got ${J(yesBurning)}`,
  );
  check(`${tier}-pair17-green-yes-below-the-age-floor-is-SILENT`, yesYoung.verdict === "silent", J(yesYoung));
  check(`${tier}-pair17-green-yes-blocked-on-a-live-pipe-at-0pct-is-SILENT`, yesBlocked.verdict === "silent", J(yesBlocked));
  check(
    `${tier}-pair17-green-gzip-of-a-REAL-file-at-90pct-is-SILENT`,
    gzipReal.verdict === "silent",
    `compressing a real file is work, not synthetic load; got ${J(gzipReal)}`,
  );
  check(
    `${tier}-pair17-green-absent-word-list-re-classifies-NOTHING`,
    noWords.verdict === "silent",
    `an unavailable word list must fail open to silence; got ${J(noWords)}`,
  );
  polesDiffer(`${tier}-pair17-poles-differ`, yesBurning.verdict, yesYoung.verdict);

  // PAIR 18 — interpreter spellings `ps` shows as ONE glued token, and the interpreters the
  // family list missed. Every red pole is the SAME loop as PAIR 1's; only the spelling moves.
  for (const [name, cmd] of [
    ["node-pe", `node -pe while (true) {}`],
    ["node-eval-assigned", `node --eval=while (true) {}`],
    ["python-c-attached", `python3 -cwhile True: pass`],
    ["bun-e", `bun -e while (true) {}`],
    ["deno-eval", `deno eval while (true) {}`],
    ["pypy-c", `pypy3 -c while True: pass`],
  ]) {
    const a = assess(table(` 7031  5000  90.0    05:00 ${cmd}`));
    check(
      `${tier}-pair18-red-${name}-REPORTS`,
      J(ids(a)) === J([`${RULE}|busy-loop|7031`]),
      `argv=${J(L.commandToArgv(cmd))} got ${J(a)}`,
    );
  }
  // …and the green pole: a real script whose own argument merely LOOKS like an inline body.
  const scriptArg = assess(table(` 7032  5000  90.0    05:00 python3 /repo/train.py -cwhile True: pass`));
  check(
    `${tier}-pair18-green-a-script-argument-is-NOT-an-inline-body`,
    scriptArg.verdict === "silent",
    `got ${J(scriptArg)} argv=${J(L.commandToArgv("python3 /repo/train.py -cwhile True: pass"))}`,
  );
}

// ═════════════════════════════ TIER A — stub classifier ═════════════════════
runTables("A", stubClassify);

// PAIR 5 — root unidentifiable ⇒ silent, NEVER a wider fallback. Control: the identical
// burner row reports when the root IS recognisable, so the silence is the root, not the row.
{
  const burnerRow = ` 7401  5000  90.0    10:00 ${BUSY}`;
  const noCli = [HEADER, ...BASE.map((l) => l.replace(/ claude$/, " some-other-wrapper")), burnerRow].join("\n");
  const unrooted = assess(noCli);
  const rooted = assess(table(burnerRow));
  check("A-pair5-green-no-CLI-ancestor-is-SILENT-not-widened", unrooted.verdict === "silent" && unrooted.why === "session-root-unidentified", J(unrooted));
  check("A-pair5-red-control-same-row-with-a-recognised-root-REPORTS", rooted.verdict === "report" && J(ids(rooted)) === J([`${RULE}|busy-loop|7401`]), J(rooted));
  polesDiffer("A-pair5-poles-differ", unrooted.verdict, rooted.verdict);

  // A chain that reaches pid 1 without a CLI must not adopt launchd as the root: every
  // process on the machine descends from it.
  const orphanChain = [HEADER, "    1     0   0.5 2-02:00:00 /sbin/launchd", ` 9100     1   3.0 00:01 node /repo/hook.js`, ` 7402     1  90.0 10:00 ${BUSY}`].join("\n");
  const viaLaunchd = assess(orphanChain, stubClassify, { selfPpid: 1 });
  check("A-pair5-green-pid1-is-NEVER-adopted-as-root", viaLaunchd.verdict === "silent" && viaLaunchd.why === "session-root-unidentified", J(viaLaunchd));

  // A cycle in a torn snapshot terminates silently.
  const cyc = [HEADER, " 9100  9099 3.0 00:01 node hook.js", " 9099  9098 0.0 00:01 sh -c x", " 9098  9099 0.0 00:01 sh -c y"].join("\n");
  check("A-pair5-green-ancestry-cycle-terminates-SILENT", assess(cyc).verdict === "silent", J(assess(cyc)));

  // The hook's own row missing from a racing snapshot: selfPpid still locates the root.
  const raced = [HEADER, ...BASE.filter((l) => !/^ 9100 /.test(l)), burnerRow].join("\n");
  check("A-pair5-red-self-row-absent-still-roots-via-selfPpid", assess(raced).verdict === "report", J(assess(raced)));
}

// PAIR 6 — ps null / empty / malformed ⇒ silent; a good row among malformed ones survives.
{
  check("A-pair6-parse-null-is-empty", J(L.parsePsTable(null)) === "[]", "");
  check("A-pair6-parse-empty-is-empty", J(L.parsePsTable("")) === "[]", "");
  check("A-pair6-parse-garbage-is-empty", J(L.parsePsTable("ps: illegal option\nusage: ps [-AaCcEefhjlMmrSTvwXx]")) === "[]", "");
  const noTable = L.assessSessionLoad({ rows: L.parsePsTable(null), selfPid: SELF, selfPpid: SELF_PARENT, classify: stubClassify });
  check("A-pair6-green-null-table-is-SILENT-named", noTable.verdict === "silent" && noTable.why === "no-process-table", J(noTable));
  const mixed = L.parsePsTable([HEADER, "garbage line", " 12 x 1.0 00:01 cmd", " 13 1 1.0 99:99 cmd", " 14 1 2,5 00:10 a b  c"].join("\n"));
  check(
    "A-pair6-malformed-rows-SKIPPED-good-row-KEPT-with-decimal-comma-and-spaces",
    mixed.length === 1 && mixed[0].pid === 14 && mixed[0].pcpu === 2.5 && mixed[0].etimeSec === 10 && mixed[0].command === "a b  c",
    J(mixed),
  );
  check("A-pair6-readProcessTable-missing-binary-is-NULL", L.readProcessTable({ psCandidates: ["/nonexistent/ps"] }) === null, "");
  check("A-pair6-readProcessTable-win32-is-NULL", L.readProcessTable({ platform: "win32" }) === null, "");
  check("A-pair6-readProcessTable-relative-candidate-REFUSED", L.readProcessTable({ psCandidates: ["ps"] }) === null, "a PATH-relative binary must not be run");
  // Failure branches driven through the spawn seam with FABRICATED results — no failing
  // process is launched. `process.execPath` only satisfies the absolute-executable check; the
  // fake spawn means it never runs.
  const TABLE_TEXT = "  PID  PPID %CPU ELAPSED COMMAND\n    1     0  0.0 00:01 x\n";
  const viaFake = (res) => L.readProcessTable({ psCandidates: [process.execPath], spawn: () => { if (res instanceof Error) throw res; return res; } });
  check("A-pair6-spawn-error-is-NULL", viaFake({ error: new Error("ENOENT"), status: null, stdout: TABLE_TEXT }) === null, "");
  check("A-pair6-spawn-timeout-signal-is-NULL-even-with-partial-stdout", viaFake({ signal: "SIGTERM", status: null, stdout: TABLE_TEXT }) === null, "a killed ps may have printed a PARTIAL table, which must not read as whole");
  check("A-pair6-spawn-nonzero-status-is-NULL", viaFake({ status: 1, stdout: TABLE_TEXT }) === null, "");
  check("A-pair6-spawn-empty-stdout-is-NULL", viaFake({ status: 0, stdout: "" }) === null, "an empty read is an unknown, not an empty machine");
  check("A-pair6-spawn-throw-is-NULL", viaFake(new Error("boom")) === null, "");
  check("A-pair6-control-spawn-success-returns-the-TEXT", viaFake({ status: 0, stdout: TABLE_TEXT }) === TABLE_TEXT, "the seam can return the other answer, so the NULLs above are not a constant");
  let seen = null;
  L.readProcessTable({ psCandidates: [process.execPath], spawn: (b, a, o) => { seen = { b, a, o }; return { status: 0, stdout: TABLE_TEXT }; } });
  check(
    "A-pair6-spawn-contract-absolute-binary-fixed-args-constant-env-bounded",
    seen && seen.b === process.execPath && J(seen.a) === J(L.PS_ARGS) && J(Object.keys(seen.o.env).sort()) === J(["LC_ALL", "PATH"]) &&
      seen.o.env.LC_ALL === "C" && seen.o.timeout === L.PS_TIMEOUT_MS && seen.o.maxBuffer === L.PS_MAX_BUFFER,
    J(seen && { b: seen.b, a: seen.a, env: seen.o.env, timeout: seen.o.timeout, maxBuffer: seen.o.maxBuffer }),
  );
  // A real read-only ps: the reader can return the OTHER answer, so its null above is not a
  // constant. RETRIED up to three times, because a null here is the FAIL-OPEN path (a `ps`
  // that overran its ceiling under contention), and reading one starved attempt as a defect
  // would make this control report on the machine's load rather than on the reader. Three
  // consecutive nulls stay a FAIL naming that reason — a control that skips itself when the
  // machine is busy reads as covered while never having run.
  let real = null;
  let attempts = 0;
  while (real === null && attempts < 3) {
    attempts++;
    real = L.readProcessTable();
  }
  const realRows = L.parsePsTable(real || "");
  check(
    "A-pair6-control-readProcessTable-REAL-returns-a-parseable-table-containing-this-process",
    process.platform === "win32" || (typeof real === "string" && realRows.some((r) => r.pid === process.pid)),
    real === null
      ? `ps returned NULL on all ${attempts} attempts — the fail-open path is live (ceiling ${L.PS_TIMEOUT_MS} ms); this control did NOT run`
      : `rows=${realRows.length}`,
  );
  // LIVE ancestry, read-only. The contract: `findSessionRoot` adopts a CLI root EXACTLY WHEN
  // the real ancestry above this process carries a recognised session CLI. Only pids and a
  // chain length are printed — never a command column from the real table.
  //
  // The BRANCH SELECTOR is derived from the PROCESS TABLE, never from `CLAUDECODE`. An env var
  // and the ancestry it stands in for can be stripped INDEPENDENTLY: a harness that pins a
  // clean environment to model CI (`.claude/bin/ci-parity.mjs` keeps eight vars — PATH, HOME,
  // LANG, LC_ALL, TERM, TMPDIR, SHELL, USER) removes `CLAUDECODE` while leaving this process
  // parented to the very CLI it denotes. The env then says "outside" while the tree says
  // "inside", and the old `else` arm asserted that no root is adopted from INSIDE a live CLI
  // tree. MEASURED on that shape: `rootPid=5528 chainLen=3` — a defect reported where none
  // exists, red under ci-parity and green on a direct run of the same commit. Real CI strips
  // BOTH signals together, so this only ever fired locally, which is where ci-parity is used.
  // It is the loom#2129 class named in `.claude/test-harness/tests/helpers/sun-path.mjs`: a
  // case asserting its HOST's shape instead of its subject's contract.
  //
  // `expectRoot` is an INDEPENDENT oracle, not a copy of the subject: it asks only whether SOME
  // CLI ancestor exists, while `findSessionRoot` must additionally select the OUTERMOST one and
  // survive cycles, broken chains and its own hop bound. The two can disagree, so this check
  // can still red — it is not made true by construction.
  if (process.platform !== "win32") {
    const liveByPid = new Map(realRows.map((r) => [r.pid, r]));
    const live = L.findSessionRoot(liveByPid, process.pid, process.ppid);
    let expectRoot = false;
    const seenAnc = new Set([process.pid]);
    let cur = process.ppid;
    while (Number.isSafeInteger(cur) && cur > 1 && !seenAnc.has(cur)) {
      seenAnc.add(cur);
      const row = liveByPid.get(cur);
      if (!row) break;
      if (L.isSessionCliCommand(row.command)) { expectRoot = true; break; }
      cur = row.ppid;
    }
    if (expectRoot) {
      check(
        "A-pair6-LIVE-ancestry-carries-a-session-CLI-so-a-CLI-root-is-adopted",
        live.rootPid !== null && live.rootPid > 1 && L.isSessionCliCommand(liveByPid.get(live.rootPid).command),
        `rootPid=${live.rootPid} chainLen=${live.chain.length}`,
      );
    } else {
      check("A-pair6-LIVE-ancestry-carries-no-session-CLI-so-no-root-is-adopted", live.rootPid === null, `rootPid=${live.rootPid} chainLen=${live.chain.length}`);
    }
  }
  const unclassified = L.assessSessionLoad({ rows: L.parsePsTable(table(` 7501 5000 90.0 10:00 ${BUSY}`)), selfPid: SELF, selfPpid: SELF_PARENT });
  check("A-pair6-green-absent-classifier-is-SILENT-named", unclassified.verdict === "silent" && unclassified.why === "classifier-unavailable", J(unclassified));
}

// PAIR 7 — the hook's OWN chain is excluded; the identical row outside the chain reports.
{
  const chainBurner = [
    HEADER,
    ...BASE.filter((l) => !/^ 9(099|100) /.test(l)),
    ` 9099  5000  95.0    05:00 /bin/sh -c ${BUSY}`,
    ` 9100  9099  95.0    05:00 ${BUSY}`,
  ].join("\n");
  const inChain = assess(chainBurner);
  const outside = assess(table(` 7601  5000  95.0    05:00 ${BUSY}`));
  check("A-pair7-green-hook-own-chain-EXCLUDED", inChain.verdict === "silent", J(inChain));
  check("A-pair7-red-identical-row-outside-the-chain-REPORTS", outside.verdict === "report" && J(ids(outside)) === J([`${RULE}|busy-loop|7601`]), J(outside));
  polesDiffer("A-pair7-poles-differ", inChain.verdict, outside.verdict);
  // …and a CHILD of an excluded chain member is not hidden by the exclusion.
  const childOfChain = assess(table(` 7602  9099  95.0    05:00 ${BUSY}`));
  check("A-pair7-red-child-of-a-chain-member-is-NOT-hidden", childOfChain.verdict === "report" && childOfChain.findings[0].pid === 7602, J(childOfChain));
}

// PAIR 8 — sustain floors at their exact boundaries.
{
  const at = (pcpu, et) => assess(table(` 7701  5000  ${pcpu}    ${et} ${BUSY}`)).verdict;
  check("A-pair8-red-exactly-at-both-floors-REPORTS", at("2.0", "00:20") === "report", "");
  check("A-pair8-green-cpu-just-below-floor-SILENT", at("1.9", "10:00") === "silent", "");
  check("A-pair8-green-age-just-below-floor-SILENT", at("99.0", "00:19") === "silent", "");
  check("A-pair8-green-blocked-loop-at-0pct-for-an-hour-SILENT", at("0.0", "01:00:00") === "silent", "a lexical loop that is not burning CPU is not load");
  check("A-pair8-floors-are-the-exported-constants", L.BUSY_LOOP_MIN_PCPU === 2 && L.BUSY_LOOP_MIN_ETIME_SEC === 20, "");
}

// PAIR 9 — etime parsing.
{
  const cases = [
    ["00:00", 0], ["05:07", 307], ["1:02", 62], ["01:02:03", 3723], ["2-03:04:05", 183845],
    ["61:00", null], ["00:60", null], ["1-24:00:00", null], ["abc", null], ["", null], ["10", null], ["-1:00", null],
  ];
  for (const [s, want] of cases) check(`A-pair9-etime-${J(s)}-is-${want}`, L.parseEtime(s) === want, `got ${L.parseEtime(s)}`);
}

// PAIR 10 — argv reconstruction from a quote-stripped command column.
{
  const eq = (name, cmd, want) => check(`A-pair10-${name}`, J(L.commandToArgv(cmd)) === J(want), `got ${J(L.commandToArgv(cmd))}`);
  eq("node-e-body-rejoined", "node -e const e=Date.now()+1;while(Date.now()<e){ }", ["node", "-e", "const e=Date.now()+1;while(Date.now()<e){ }"]);
  eq("python-flags-then-c", "python3 -u -c import sys; exec(x)", ["python3", "-u", "-c", "import sys; exec(x)"]);
  eq("python-script-arg-c-is-NOT-a-body", "python3 script.py -c conf", ["python3", "script.py", "-c", "conf"]);
  eq("bash-combined-lc", "/bin/bash -lc while :; do :; done", ["/bin/bash", "-lc", "while :; do :; done"]);
  eq("node-require-value-then-e", "node -r ts-node/register -e a b", ["node", "-r", "ts-node/register", "-e", "a b"]);
  eq("non-interpreter-untouched", "stress-ng --cpu 4", ["stress-ng", "--cpu", "4"]);
  // ATTACHED spellings `ps` shows as one glued token, normalised to the detached shape the
  // classifier understands.
  eq("node-pe-body-rejoined", "node -pe while (true) {}", ["node", "-pe", "while (true) {}"]);
  eq("node-eval-assigned-split-at-equals", "node --eval=while (true) {}", ["node", "--eval", "while (true) {}"]);
  eq("python-c-attached-split", "python3 -cwhile True: pass", ["python3", "-c", "while True: pass"]);
  eq("python-uc-cluster-attached-split", "python3 -ucimport sys", ["python3", "-uc", "import sys"]);
  // The split is at the FIRST `c`: a greedy match would split `-cexec(x)` inside `exec`.
  eq("python-c-attached-body-containing-c", "python3 -cexec(x)", ["python3", "-c", "exec(x)"]);
  eq("bun-e-body-rejoined", "bun -e while (true) {}", ["bun", "-e", "while (true) {}"]);
  eq("deno-eval-subcommand-rejoined", "deno eval while (true) {}", ["deno", "eval", "while (true) {}"]);
  eq("pypy-c-body-rejoined", "pypy3 -c while True: pass", ["pypy3", "-c", "while True: pass"]);
  eq("deno-run-script-untouched", "deno run /repo/a.ts --flag x", ["deno", "run", "/repo/a.ts", "--flag", "x"]);
}

// PAIR 11 — session CLI recognition.
{
  check("A-pair11-red-bare-claude", L.isSessionCliCommand("claude") === true, "");
  check("A-pair11-red-absolute-claude-with-args", L.isSessionCliCommand("/opt/bin/claude --resume abc") === true, "");
  check("A-pair11-red-node-hosted-claude-code", L.isSessionCliCommand("node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js") === true, "");
  check("A-pair11-green-tmux-session-NAMED-claude", L.isSessionCliCommand("tmux new -s claude") === false, "a multiplexer hosts many sessions");
  check("A-pair11-green-shell-running-claude-p", L.isSessionCliCommand("/bin/zsh -c claude -p hi") === false, "");
  check("A-pair11-green-terminal-shell", L.isSessionCliCommand("-zsh") === false, "");
  // The NATIVE installer: `~/.local/bin/claude` is a symlink to
  // `~/.local/share/claude/versions/<semver>`, and THAT file's basename is the version, so a
  // root started by its real path carries no `claude` token at all (MEASURED on this machine).
  check("A-pair11-red-native-versioned-binary-path", L.isSessionCliCommand("/Users/op/.local/share/claude/versions/2.1.269") === true, "");
  check("A-pair11-red-native-versioned-binary-path-with-args", L.isSessionCliCommand("/Users/op/.local/share/claude/versions/2.1.269 --resume abc") === true, "");
  check("A-pair11-red-native-versioned-codex", L.isSessionCliCommand("/opt/share/codex/versions/v0.9.1") === true, "");
  check("A-pair11-red-codex-with-flags-MEASURED-bare-word", L.isSessionCliCommand("codex --dangerously-bypass-approvals-and-sandbox") === true, "");
  // …and the negatives that share the shape without being a CLI.
  check("A-pair11-green-versions-path-of-ANOTHER-tool", L.isSessionCliCommand("/opt/tools/versions/1.2.3") === false, "the CLI name must be in the path");
  check("A-pair11-green-helper-inside-the-versions-dir", L.isSessionCliCommand("/Users/op/.local/share/claude/versions/2.1.269/claude-helper") === false, "");
  check("A-pair11-green-claude-helper", L.isSessionCliCommand("claude-helper --serve") === false, "");
  check("A-pair11-green-claudette", L.isSessionCliCommand("/usr/bin/claudette") === false, "");
  // UNMEASURED shapes stay UNRECOGNISED rather than guessed: under those CLIs the hook is
  // silent, which the lib header records as a named residual.
  check("A-pair11-green-node-hosted-codex-is-UNMEASURED-and-unrecognised", L.isSessionCliCommand("node /opt/lib/@openai/codex/bin/codex.js") === false, "");
}

// PAIR 19 — the ROOT is the OUTERMOST CLI ancestor, not the nearest. Both poles carry the
// SAME burner as a direct child of the real root; they separate only on whether a process
// NAMED like a CLI sits between the hook and that root. Taking the nearest let that process
// narrow the scan to its own (empty) subtree and the burner vanished entirely.
{
  const evil = [
    HEADER,
    ...BASE.filter((l) => !/^ 9099 /.test(l)),
    " 6500  5000   0.1 01:00:00 claude",
    " 9099  6500   0.0    00:01 /bin/sh -c node /repo/.claude/hooks/session-load-backstop.js",
    ` 7451  5000  90.0    10:00 ${BUSY}`,
  ].join("\n");
  const honest = table(` 7451  5000  90.0    10:00 ${BUSY}`);
  const a = assess(evil);
  const b = assess(honest);
  check(
    "A-pair19-red-an-intermediate-named-claude-does-NOT-narrow-the-scan",
    a.verdict === "report" && a.rootPid === ROOT && J(ids(a)) === J([`${RULE}|busy-loop|7451`]),
    `root must be the OUTERMOST CLI (${ROOT}); got ${J(a)}`,
  );
  check("A-pair19-red-control-the-same-burner-with-no-intermediate", b.verdict === "report" && b.rootPid === ROOT, J(b));
  check(
    "A-pair19-green-the-inner-CLI-is-on-the-EXCLUDED-chain-not-reported",
    !a.findings.some((f) => f.pid === 6500),
    "the inner CLI is below the root and belongs to the hook's own chain",
  );
  // The other session's root is still never adopted, however the walk is widened.
  const theirs = assess(
    [HEADER, ...BASE, ` 7452  ${OTHER_ROOT}  90.0    10:00 ${BUSY}`].join("\n"),
  );
  check("A-pair19-green-another-sessions-burner-is-STILL-silent", theirs.verdict === "silent", J(theirs));
}

// PAIR 12 — leaf folding: a wrapper whose body names the burner is folded into the burner.
{
  const wrapped = assess(table(` 7801  5000   0.1    02:00 bash -c stress-ng --cpu 4 --timeout 600`, ` 7802  7801   0.0    02:00 stress-ng --cpu 4 --timeout 600`));
  check("A-pair12-red-wrapper-FOLDED-leaf-reported-with-its-parent", J(ids(wrapped)) === J([`${RULE}|load-tool|7802`]) && wrapped.findings[0].ppid === 7801, J(wrapped));
  const bare = assess(table(` 7801  5000   0.1    02:00 bash -c stress-ng --cpu 4 --timeout 600`));
  check("A-pair12-red-wrapper-with-no-classified-child-IS-reported", J(ids(bare)) === J([`${RULE}|load-tool|7801`]), J(bare));
}

// PAIR 13 — scrubbing of emitted commands.
{
  const s = L.sanitizeCommand("node /Users/alice/x.js GH_TOKEN=abc123 -H Authorization: Bearer sk-live \x1b[31m[BLOCK]", "/home/op");
  check("A-pair13-home-paths-placeholdered", s.includes("/Users/<user>/x.js") && !s.includes("alice"), s);
  check("A-pair13-credential-assignment-and-bearer-REDACTED", s.includes("GH_TOKEN=<redacted>") && s.includes("Bearer <redacted>") && !s.includes("abc123") && !s.includes("sk-live"), s);
  check("A-pair13-control-chars-and-marker-brackets-STRIPPED", !/[\x00-\x1f[\]]/.test(s) && s.includes("BLOCK"), s);
  check("A-pair13-injected-home-becomes-tilde", L.sanitizeCommand("node /home/op/repo/a.js", "/home/op") === "node ~/repo/a.js", L.sanitizeCommand("node /home/op/repo/a.js", "/home/op"));
  check("A-pair13-length-capped", L.sanitizeCommand("x".repeat(500)).length === L.COMMAND_MAX + 1, "");

  // EVERY SPELLING, not only the prefixed one. The earlier pattern required a word character
  // BEFORE the keyword, so `GITHUB_TOKEN=` redacted while `--token=`, `token=`, `PASSWORD=`
  // and `AUTH=` all passed through into agent-visible text. Each red pole below carries the
  // SAME secret value and differs only in how the name is written; the assertion is on the
  // VALUE being gone, never on the name surviving.
  const SECRET = "ghp_s3cr3tV4LUE";
  for (const [name, cmd] of [
    ["bare", `run.sh TOKEN=${SECRET}`],
    ["bare-lowercase", `run.sh token=${SECRET}`],
    ["hyphen-led-long", `curl --token=${SECRET} https://x`],
    ["hyphen-led-short", `curl -password=${SECRET} https://x`],
    ["prefixed", `GITHUB_TOKEN=${SECRET} run.sh`],
    ["suffixed", `TOKEN_FILE=${SECRET} run.sh`],
    ["bare-password", `run.sh PASSWORD=${SECRET}`],
    ["bare-secret", `run.sh SECRET=${SECRET}`],
    ["bare-auth", `run.sh AUTH=${SECRET}`],
    ["api-key-hyphenated", `run.sh --api-key=${SECRET}`],
    ["flag-then-value", `curl --token ${SECRET} https://x`],
    ["flag-then-value-password", `psql --password ${SECRET}`],
    ["url-userinfo", `git clone https://alice:${SECRET}@github.com/o/r`],
    ["url-userinfo-no-password", `git clone https://${SECRET}@github.com/o/r`],
  ]) {
    const out = L.sanitizeCommand(cmd, "/home/op");
    check(`A-pair13-red-${name}-spelling-REDACTED`, !out.includes(SECRET) && /redacted/.test(out), `${J(cmd)} -> ${J(out)}`);
  }
  // GREEN poles — ordinary command text is NOT mangled, so the scrub is discriminating
  // rather than a blanket eraser.
  for (const [name, cmd] of [
    ["plain-node-run", "node /repo/scripts/build.mjs --watch=true"],
    ["verbose-flag", "cargo test --verbose --jobs=4"],
    ["path-assignment", "PATH=/usr/bin:/bin make -j4"],
    ["url-no-userinfo", "git clone https://github.com/o/r"],
  ]) {
    const out = L.sanitizeCommand(cmd, "/home/op");
    check(`A-pair13-green-${name}-UNCHANGED`, out === cmd, `${J(cmd)} -> ${J(out)}`);
  }
  // The OVER-REDACTION decision, pinned rather than left to be rediscovered: `AUTH` is a
  // substring of `author`, so `--author=alice` redacts. DELIBERATE — losing an author name
  // costs a diagnostic detail; narrowing the pattern until `--auth=<token>` escapes costs a
  // credential, in text that is quoted into transcripts, journals and PRs.
  check(
    "A-pair13-DECISION-author-flag-is-DELIBERATELY-over-redacted",
    L.sanitizeCommand("git log --author=alice") === "git log --author=<redacted>",
    L.sanitizeCommand("git log --author=alice"),
  );
  // …and a flag value is only swallowed when it is a VALUE: a following flag survives.
  check(
    "A-pair13-flag-value-redaction-does-NOT-swallow-a-following-flag",
    L.sanitizeCommand("curl --token --verbose https://x") === "curl --token --verbose https://x",
    L.sanitizeCommand("curl --token --verbose https://x"),
  );
}

// PAIR 14 — the report: six fields, every pid named with its stop command, the non-stopping
// statement, group advice never pointed at the session root, and the rendered channel.
{
  const grouped = assess(table(` 7901  5000   0.0    06:00 /bin/zsh -c x & y & wait`, ` 7902  7901  31.0    05:58 ${BUSY}`, ` 7903  7901  30.0    05:58 ${BUSY}`, ` 7904  5000  30.0    05:58 ${BUSY}`));
  const p = L.buildEmitPayload(grouped);
  const report = p.agent_must_report.join("\n");
  check("A-pair14-six-fields-populated", p.severity === "halt-and-report" && p.hookEvent === "PostToolUse" && [p.what_happened, p.why, p.agent_must_wait, p.user_summary].every((x) => typeof x === "string" && x.length > 0) && p.agent_must_report.length > 0, J(p));
  check("A-pair14-every-pid-named-with-kill", [7902, 7903, 7904].every((pid) => report.includes(`pid ${pid} `) && report.includes(`kill ${pid}`)), report);
  check("A-pair14-states-the-hook-did-NOT-stop-anything", /did NOT stop, signal or kill anything/.test(report), report);
  check("A-pair14-group-advice-for-the-throwaway-parent", report.includes("pkill -P 7901") && report.includes("kill 7902 7903"), report);
  check("A-pair14-group-advice-NEVER-targets-the-session-root", !report.includes(`pkill -P ${ROOT}`), report);
  check("A-pair14-forbids-name-wide-kills-and-names-the-orphan-residual", report.includes("killall node") && /reparented outside the session/.test(report), report);
  check("A-pair14-why-cites-the-rule-and-the-receipt", p.why.includes(RULE) && p.why.includes("journal/0609"), p.why);
  const rendered = instructAndWait(p);
  check("A-pair14-renders-NON-blocking-with-the-delivery-channel", rendered.exitCode === 0 && rendered.json.continue === true && /SendMessage/.test(rendered.json.hookSpecificOutput.additionalContext) && /ALREADY RAN/.test(rendered.json.hookSpecificOutput.additionalContext), J(rendered.json));
  const many = assess(table(...Array.from({ length: 15 }, (_, i) => ` ${8000 + i}  5000  30.0    05:00 ${BUSY}`)));
  const pm = L.buildEmitPayload(many).agent_must_report.join("\n");
  check("A-pair14-overflow-is-COUNTED-not-dropped", many.findings.length === 15 && pm.includes("and 3 more") && pm.includes("8014"), pm);
}

// PAIR 15 — classifier loading fails open.
{
  check("A-pair15-throwing-require-yields-null", L.loadClassifier(() => { throw new Error("absent"); }) === null, "");
  check("A-pair15-module-without-classifyArgv-yields-null", L.loadClassifier(() => ({})) === null, "");
  const fn = L.loadClassifier(() => ({ classifyArgv: (a) => ({ kind: "load-tool", argv: a }) }));
  check("A-pair15-module-with-classifyArgv-yields-a-forwarding-function", typeof fn === "function" && fn(["x"]).argv[0] === "x", "");
  check("A-pair15-throwing-classifier-is-silent-per-row", L.classifyRow({ pid: 1, ppid: 0, pcpu: 99, etimeSec: 99, command: "stress-ng" }, () => { throw new Error("x"); }) === null, "");
  check("A-pair15-fan-out-kind-is-silent-at-process-level", L.classifyRow({ pid: 1, ppid: 0, pcpu: 99, etimeSec: 99, command: "xargs -P 16 x" }, () => ({ kind: "fan-out", rule_id: RULE })) === null, "");
}

// ═════════════════════════════ TIER B — real classifier ═════════════════════
if (!fs.existsSync(W1_PATH)) {
  check("B-integration-OWED-synthetic-load.js-absent", false, `${W1_PATH} does not exist; Tier-B pairs 1-4 and the classifier contract checks were NOT run`);
} else {
  const W = require_(W1_PATH);
  const real = L.loadClassifier((spec) => require_(path.resolve(__dirname, "../../hooks/lib", spec)));
  check("B-contract-classifyArgv-is-exported", typeof W.classifyArgv === "function" && typeof real === "function", `exports: ${Object.keys(W).join(",")}`);
  check("B-contract-RULE_ID-is-the-backstop-fallback", W.RULE_ID === L.FALLBACK_RULE_ID, `W1 RULE_ID=${W.RULE_ID}`);
  // The CONTEXT-DEPENDENT word list is read from the classifier, never copied: a second copy
  // would drift, and the drift direction is silence.
  const words = L.loadConditionalLoadWords((spec) => require_(path.resolve(__dirname, "../../hooks/lib", spec)));
  check(
    "B-contract-CONDITIONAL_LOAD_TOOL_WORDS-is-exported-and-contains-yes",
    words !== null && words.has("yes") && words.has("dd"),
    `loadConditionalLoadWords returned ${J(words && [...words].slice(0, 5))}`,
  );
  // The loaded classifier must FORWARD its context: dropping it makes the whole
  // re-classification path structurally dead, which is how `yes` went unreported.
  check(
    "B-contract-loadClassifier-FORWARDS-the-context-argument",
    typeof real === "function" && real(["yes"]) === null && real(["yes"], { stdoutDiscard: true }) !== null,
    `no-ctx=${J(real && real(["yes"]))} ctx=${J(real && real(["yes"], { stdoutDiscard: true }))}`,
  );
  if (typeof real === "function") runTables("B", real, words || STUB_CONDITIONAL);
}

// ═════════════════════════════ END-TO-END — the real hook ═══════════════════
// Reads the REAL process table read-only. Positive paths are proven above with injected
// tables; this proves the hook is wired, fail-open, bounded and well-formed.
{
  const payload = J({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "echo hi" }, tool_response: { stdout: "hi" } });
  for (const [name, input] of [["well-formed-payload", payload], ["malformed-payload", "{not json"]]) {
    const r = spawnSync(process.execPath, [HOOK], { input, encoding: "utf8", timeout: 15000 });
    let out = null;
    try {
      out = JSON.parse(String(r.stdout).trim().split("\n").pop());
    } catch {}
    const verdict = out && out.hookSpecificOutput ? "report" : "silent";
    check(
      `E2E-${name}-rc0-continue-true`,
      r.status === 0 && out && out.continue === true && (!out.hookSpecificOutput || out.hookSpecificOutput.hookEventName === "PostToolUse"),
      `status=${r.status} signal=${r.signal} err=${r.error && r.error.message} stdout=${String(r.stdout).slice(0, 300)} stderr=${String(r.stderr).slice(0, 300)}`,
    );
    console.log(`     (E2E ${name}: live verdict=${verdict})`);
  }
}

console.log(`session-load-backstop fixtures: ${pass} pass, ${failures.length} fail`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
process.exit(0);
