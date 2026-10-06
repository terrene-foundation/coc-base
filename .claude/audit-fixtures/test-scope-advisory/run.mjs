#!/usr/bin/env node
/**
 * Audit-fixture runner for `.claude/hooks/lib/test-scope-advisory.js` — the
 * unscoped-test-run advisory, shipped WITH the detector per `cc-artifacts.md` Rule 9.
 *
 * SCOPE, stated because it is wider than the filename suggests: this set also pins the
 * FAN-OUT BOUND of `.claude/bin/owed-suites.mjs` (section 14). That is not filing
 * convenience. The advisory's entire second half is "run this tool", so the advisory is
 * only as good as that tool is at the repo it lands in — and the bound is exactly the
 * parameter that was calibrated on loom and does not transfer. An advisory that names a
 * mis-calibrated instrument is worse than one that names none, so the two are pinned
 * together.
 *
 * BIPOLAR BY CONSTRUCTION. Every predicate carries BOTH a FIRE pole and a SILENT pole.
 * A set that only ever asserts firing passes identically against a detector that fires
 * on everything; a set that only ever asserts silence passes identically against a
 * detector that is inert. Both are live risks here, and the second is the dangerous
 * one: this advisory is capped at ADVISORY, so an inert one is indistinguishable from
 * a well-behaved one — nothing ever goes red, and the whole surface quietly does
 * nothing. The silence poles are not politeness cases. They are the mute-resistance
 * contract: `hook-output-discipline.md` § MUST NOT names "fires on everything" as the
 * failure mode that gets a hook muted within a day, and each SILENT case pins one
 * juncture where a broad run is the RIGHT run.
 *
 * ESTABLISHED RED (`instrument-discipline.md` MUST-2). Each mutation below was RUN
 * against this file — MEASURED, not predicted — and each was (a) asserted to change
 * the module's bytes, (b) `node --check`-verified to still PARSE (a syntactically
 * invalid mutation tests nothing and its "red" is a module-load error wearing a
 * detector failure's clothes), and (c) reverted to a byte-identical restore with the
 * full set re-run green afterwards. The ACTUAL red-sets, as OBSERVED (not predicted):
 *
 *   M-a   drop the pytest invoke row                    -> 01 03 04 05 43 45 46 51 64 65
 *   M-b   remove the `python -m pytest` normalisation   -> 05
 *   M-g   swap the hyphen fence for `\b`                -> 13
 *   M-h   delete pytest's -k / -m scoped rows           -> 17 18 22 46 55
 *   M-i   delete pytest's --cov broad-by-intent rows    -> 31
 *   M-j   drop the `no diff` gate                       -> 38 56
 *   M-k   a FAILED probe reports a clean tree           -> 40
 *   M-l   invert alreadyAdvised (fire every time)       -> 44 54
 *   M-n   record delivery BEFORE the silence checks     -> 43 45 46 51
 *   M-o   drop the session-id path sanitizer            -> 47
 *   M-q   remove the owed-suites.mjs affordance         -> 49 67
 *   M-r   remove the HOOK call site (library stays green)-> 51
 *   M-t   delete the alreadyParallel gate               -> 32 57 58 59 60 61 62 63
 *   M-u   widen an alreadyParallel row to any flag      -> 65
 *   M-v   LEAD_LINE.pytest = null (lead with scoping)   -> 66 67 71
 *   M-w   SWAP lead and narrowing (ORDER only)          -> 67
 *   M-x   give cargo a parallelism LEAD_LINE            -> 68
 *   M-y   recommend `-n auto` instead of `-n 8`         -> 66 67 71
 *   M-aa  suggest a MARKER band in the lead line        -> 73
 *   M-ab  delete RUNNER_NOTE.cargo (the nextest trade)  -> 74
 *   M-ad  drop fanout provenance from the JSON          -> 76 77 78 79 80 81
 *   M-ae  restore `const FANOUT_MAX = 3`                -> 77 80 81
 *   M-af  drop the readability floor                    -> 79
 *   M-ag  ignore the --fanout-max flag                  -> 80
 *   M-ah  drop the OWED_SUITES_FANOUT_MAX env read      -> 81
 *   M-ai  remove the calibration POPULATION filter      -> 77 78
 *   M-aj  print the bound only inside the BROAD block   -> 82
 *
 * Twenty-seven mutations, twenty-seven NON-EMPTY red sets, every one with bytes asserted
 * changed, `node --check` clean, and a byte-identical SHA restore. No mutation
 * produced an empty red set on this pass, so there was no vacuous-case /
 * inert-mutation ambiguity to resolve. Three results are worth stating rather than
 * leaving to be re-derived:
 *
 *   M-i's red set SHRANK from {31,32} to {31}. That is not a regression: `-n auto`
 *   moved OUT of pytest's `broadByIntent` and INTO `alreadyParallel`, so case 32 is
 *   now pinned by M-t instead. Same silence, a different — and correct — reason, and
 *   the mutation table is what makes the hand-off visible.
 *
 *   M-w is the ONLY mutation that isolates ORDER. Its first draft DELETED the lead
 *   push and red 66/67/71, which is a presence mutation wearing an ordering label — it
 *   would have left case 67's actual claim unverified while looking verified. Rewritten
 *   to SWAP two adjacent lines with both contents intact, it reds EXACTLY {67}, and the
 *   reach was proven before reading the run: under the mutation the rendered text has
 *   `owed-suites.mjs` BEFORE `-n 8 --dist loadfile` while still containing both lines
 *   and the 4.97x figure. Ordering is the whole finding of this change, so the
 *   instrument that pins it had to be shown able to fail on ordering alone.
 *
 *   M-ai is the guard on the guard. Removing the calibration POPULATION filter reds
 *   {77,78} ONLY because the synthetic corpora carry realistic singleton NOISE tokens.
 *   Without that noise the mutation is INERT and the filter would have shipped
 *   unverified while every case stayed green — the exact two-hypotheses situation
 *   `instrument-discipline.md` MUST-2(b) forbids resolving as a verdict.
 *
 * Exit 0 = every case passes. Exit 1 = at least one case failed.
 */
import "../_lib/no-ambient-git.cjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const MOD = path.join(REPO, ".claude", "hooks", "lib", "test-scope-advisory.js");
const HOOK = path.join(REPO, ".claude", "hooks", "validate-bash-command.js");
const L = require(MOD);

const cases = [];
function check(id, name, pass, detail, redsUnder) {
  cases.push({ id, name, pass: !!pass, detail: String(detail), reds_under: redsUnder });
}
const fires = (c) => L.classifyUnscopedTestRun(c) !== null;
const runnerOf = (c) => (L.classifyUnscopedTestRun(c) || {}).runner || null;

/* ── 1. CONTROL — the module under test is the real one, and it can do BOTH ──────
 * Without this every "silent" assertion below is consistent with a module that
 * classifies nothing at all, and the whole silence half passes vacuously. */
check("01", "CONTROL: the classifier can return a NON-null verdict",
  fires("pytest"), `classifyUnscopedTestRun("pytest") -> ${JSON.stringify(L.classifyUnscopedTestRun("pytest"))}`,
  "any mutation that makes the classifier inert");
check("02", "CONTROL: the classifier can return NULL",
  !fires("echo hello"), 'classifyUnscopedTestRun("echo hello") -> null',
  "any mutation that makes the classifier fire unconditionally");

/* ── 2. RUNNER RECOGNITION — one FIRE + one SILENT per runner family ───────────── */
check("03", "pytest: a bare invocation fires", runnerOf("pytest") === "pytest", runnerOf("pytest"), "M-a drop the pytest invoke row");
check("04", "pytest: `py.test` fires", runnerOf("py.test") === "pytest", runnerOf("py.test"), "M-a");
check("05", "pytest: `python3 -m pytest` fires (the CI spelling)",
  runnerOf("python3 -m pytest") === "pytest", runnerOf("python3 -m pytest"),
  "M-b remove the `python -m pytest` normalisation — the interpreter's `-m` then reads as a marker filter and this goes permanently silent");
check("06", "cargo: `cargo test` fires", runnerOf("cargo test") === "cargo", runnerOf("cargo test"), "M-c drop the cargo invoke row");
check("07", "cargo: `cargo nextest run` fires", runnerOf("cargo nextest run") === "cargo", runnerOf("cargo nextest run"), "M-c");
check("08", "node: `node --test` fires", runnerOf("node --test") === "node", runnerOf("node --test"), "M-d drop the node invoke row");
check("09", "node: `npm test` fires", runnerOf("npm test") === "node", runnerOf("npm test"), "M-d");
check("10", "go: `go test` fires", runnerOf("go test") === "go", runnerOf("go test"), "M-e drop the go invoke row");
check("11", "SILENT: a non-runner command", !fires("git status --porcelain"), "null", "M-f widen any invoke row");
check("12", "SILENT: a command that merely READS a file named for a runner",
  !fires("cat tests/pytest.ini"), "null", "M-f");

/* ── 3. THE HYPHEN FENCE — the mute-fastest false positive, measured live ────────
 * The host hook's pre-existing `\bpytest\b` fires on any command CONTAINING the
 * string; that is how it fired on `grep -c 'pytest-layout'` during this change. */
check("13", "SILENT: `pytest-watch` is not pytest", !fires("pytest-watch src"), "null",
  "M-g replace the `(?![\\w.-])` fence with `\\b` — the shape the host's own isPytest still carries");
check("14", "SILENT: a grep whose PATTERN contains the runner name",
  !fires("grep -c 'pytest-layout' f.txt"), "null", "M-g");
check("15", "SILENT: `cargo test-fuzz` is not `cargo test`", !fires("cargo test-fuzz"), "null", "M-g");
check("16", "SILENT: `npm test-ci` is not `npm test`", !fires("npm test-ci"), "null", "M-g");

/* ── 4. SCOPED — the run already narrowed itself, so there is nothing to offer ── */
const scoped = [
  ["17", "pytest -k billing", "keyword filter"],
  ["18", "pytest -m slow", "marker filter"],
  ["19", "pytest tests/unit/test_billing.py", "explicit test file"],
  ["20", "pytest tests/unit", "explicit path under tests/"],
  ["21", "pytest --lf", "last-failed"],
  ["22", "python3 -m pytest -m slow", "marker filter behind the interpreter flag"],
  ["23", "cargo test -p engine", "package selector"],
  ["24", "cargo test --test resolver", "integration-test selector"],
  ["25", "cargo test --lib", "target selector"],
  ["26", "cargo nextest run -E 'test(billing)'", "nextest filter expression"],
  ["27", "node --test src/foo.test.mjs", "explicit suite file"],
  ["28", "node --test --test-name-pattern=billing", "test-name pattern"],
  ["29", "go test -run TestBilling", "run filter"],
  ["30", "go test ./internal/billing", "explicit package path"],
];
for (const [id, cmd, why] of scoped) {
  check(id, `SILENT (already scoped): ${why}`, !fires(cmd), `\`${cmd}\` -> ${JSON.stringify(L.classifyUnscopedTestRun(cmd))}`,
    "M-h delete that runner's `scoped` row — the advisory then nags a run that is ALREADY narrowed, which is the mute-within-a-day shape");
}

/* ── 5. BROAD BY INTENT — the operator SAID everything; do not second-guess ───── */
const broad = [
  ["31", "pytest --cov=src", "a coverage run is whole-corpus BY DEFINITION; scoping it defeats it"],
  ["32", "pytest -n auto", "an explicit parallel fan-out over the whole corpus"],
  ["33", "cargo test --workspace", "an explicit whole-workspace run"],
  ["34", "cargo test --all-features", "an explicit full feature matrix"],
  ["35", "cargo test --release", "a release gate"],
  ["36", "go test ./...", "the explicit whole-module spelling"],
  ["37", "node --test --experimental-test-coverage", "a coverage run"],
];
for (const [id, cmd, why] of broad) {
  check(id, `SILENT (deliberately broad): ${why}`, !fires(cmd), `\`${cmd}\``,
    "M-i delete that runner's `broadByIntent` row — the advisory then argues with an explicit instruction");
}

/* ── 6. THE DIFF GATE — no diff means no scoped run exists to offer ───────────── */
check("38", "SILENT: a clean tree yields no advisory",
  L.formatScopeAdvisory({ runner: "pytest", changed: { count: 0, sample: [] } }) === null,
  "formatScopeAdvisory(count:0) -> null",
  "M-j drop the `changed.count <= 0` gate");
check("39", "FIRES: a dirty tree yields text naming the count",
  (L.formatScopeAdvisory({ runner: "pytest", changed: { count: 3, sample: ["a.py"] } }) || "").includes("3 changed path(s)"),
  "advisory names the path count", "M-j");

/* ── 7. THE PROBE IS NOT ITS OWN ANSWER (instrument-discipline.md MUST-1) ─────────
 * A FAILED git probe must not be readable as a clean tree. `changedPathCount`
 * returns null on failure and 0 on a genuinely clean tree, and those two must not
 * collapse — otherwise a broken git silences the advisory while LOOKING like a
 * clean-tree silence, and nothing distinguishes the two from the outside. */
{
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "tsa-notrepo-"));
  const probe = L.changedPathCount(notARepo);
  check("40", "a failed probe returns NULL, never 0", probe === null, `changedPathCount(non-repo) -> ${JSON.stringify(probe)}`,
    "M-k make changedPathCount return {count:0} on error — a broken git would then be indistinguishable from a clean tree");
  check("41", "SILENT on a failed probe (fail-open, never a fabricated advisory)",
    L.formatScopeAdvisory({ runner: "pytest", changed: null }) === null, "formatScopeAdvisory(null) -> null", "M-j");
  try { fs.rmdirSync(notARepo); } catch {}
}
{
  const clean = fs.mkdtempSync(path.join(os.tmpdir(), "tsa-clean-"));
  try {
    execFileSync("git", ["-C", clean, "init", "-q"], { stdio: "ignore" });
    const probe = L.changedPathCount(clean);
    check("42", "a CLEAN repo probes to 0, distinguishable from the null above",
      probe !== null && probe.count === 0, `changedPathCount(clean repo) -> ${JSON.stringify(probe)}`,
      "M-k — this is the CONTROL that makes case 40 informative rather than constant");
  } catch (e) {
    check("42", "a CLEAN repo probes to 0", false, `git unavailable: ${e.message}`, "M-k");
  }
  try { fs.rmSync(clean, { recursive: true, force: true }); } catch {}
}

/* ── 8. ONCE PER SESSION — the anti-nag property, and its per-repo scope ──────── */
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tsa-marker-"));
  const changed = { count: 2, sample: ["a.py", "b.py"] };
  const first = L.buildTestScopeAdvisory("pytest", repo, { sessionId: "S1", changed });
  const second = L.buildTestScopeAdvisory("pytest", repo, { sessionId: "S1", changed });
  const otherSession = L.buildTestScopeAdvisory("pytest", repo, { sessionId: "S2", changed });
  check("43", "FIRES: the first unscoped run in a session", typeof first === "string" && first.length > 0,
    `first -> ${typeof first}`, "M-l invert alreadyAdvised");
  check("44", "SILENT: the SECOND run in the same session", second === null, `second -> ${JSON.stringify(second)}`,
    "M-l — without this the advisory fires on every test invocation, which is the muted-within-a-day shape");
  check("45", "FIRES: a DIFFERENT session is told once too", typeof otherSession === "string",
    `otherSession -> ${typeof otherSession}`, "M-m make the marker session-independent");
  // A SILENCED invocation must not consume the session's one delivery.
  const repo2 = fs.mkdtempSync(path.join(os.tmpdir(), "tsa-marker2-"));
  const silenced = L.buildTestScopeAdvisory("pytest -k x", repo2, { sessionId: "S1", changed });
  const afterSilenced = L.buildTestScopeAdvisory("pytest", repo2, { sessionId: "S1", changed });
  check("46", "a SILENCED invocation does not burn the session's one delivery",
    silenced === null && typeof afterSilenced === "string", `silenced=${silenced}, after=${typeof afterSilenced}`,
    "M-n move recordAdvised above the silence checks");
  // Session ids are caller-supplied and must not traverse out of the marker directory.
  //
  // An earlier revision asserted `!fs.existsSync("/etc/pwn.marker")` and was VACUOUS,
  // found by running the mutation rather than by reading the case: with the sanitizer
  // removed the marker lands at `<repo>/.claude/learning/test-scope-advisory/
  // ../../../../etc/pwn.marker`, which resolves FOUR levels up from the marker dir —
  // i.e. beside the repo, never at the filesystem root. The old case therefore held
  // for a reason that had nothing to do with the sanitizer, and stayed green under
  // M-o. It now asserts the ACTUAL computed destination.
  const nested = fs.mkdtempSync(path.join(os.tmpdir(), "tsa-trav-"));
  const travRepo = path.join(nested, "a", "b", "repo");
  fs.mkdirSync(travRepo, { recursive: true });
  const escapeTarget = path.join(nested, "a", "b", "etc", "pwn.marker"); // 4 up from the marker dir
  L.recordAdvised(travRepo, "../../../../etc/pwn");
  const markerDir = path.join(travRepo, ".claude", "learning", "test-scope-advisory");
  const landedInside = fs.existsSync(markerDir) && fs.readdirSync(markerDir).length === 1;
  const escaped = fs.existsSync(escapeTarget);
  check("47", "a traversing session id is sanitized to ONE path segment",
    !escaped && landedInside,
    `escaped(${escapeTarget})=${escaped}; markerDir contents=${JSON.stringify(fs.existsSync(markerDir) ? fs.readdirSync(markerDir) : null)}`,
    "M-o drop the [^A-Za-z0-9._-] sanitizer in _markerPath");
  try { fs.rmSync(nested, { recursive: true, force: true }); } catch {}
  for (const d of [repo, repo2]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

/* ── 9. SEVERITY IS STRUCTURALLY CAPPED (hook-output-discipline.md MUST-2) ─────── */
check("48", "the module returns a STRING, never a severity-bearing finding",
  typeof L.formatScopeAdvisory({ runner: "pytest", changed: { count: 1, sample: ["a"] } }) === "string",
  "string, so it cannot carry `severity: block` or `halt-and-report`",
  "M-p return an object with a severity field — that would join the deferredFindings merge and promote to halt-and-report");
check("49", "the advisory NAMES the instrument that derives the scoped set",
  (L.formatScopeAdvisory({ runner: "pytest", changed: { count: 1, sample: ["a"] } }) || "").includes("owed-suites.mjs"),
  "names .claude/bin/owed-suites.mjs",
  "M-q remove the instrument reference — an advisory that says 'narrow it' without naming HOW is advice, not an affordance");
check("50", "the advisory disclaims having judged the run",
  /not a verdict/.test(L.formatScopeAdvisory({ runner: "pytest", changed: { count: 1, sample: ["a"] } }) || ""),
  "carries the not-a-verdict disclaimer", "M-q");

/* ── 10. END-TO-END through the REAL hook — the library being right is not enough ─
 * The dispatch-contract fixtures record a measured instance (M-e) where 42 green
 * library cases sat above a hook that never called them. These cases run the hook. */
function hook(cmd, cwd, sessionId) {
  const r = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", cwd, session_id: sessionId, tool_input: { command: cmd } }),
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(r);
}
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tsa-e2e-"));
  try {
    execFileSync("git", ["-C", repo, "init", "-q"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "user.email", "a@b.c"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
    fs.writeFileSync(path.join(repo, "mod.py"), "x = 1\n");
    execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "commit", "-qm", "i"], { stdio: "ignore" });
    fs.writeFileSync(path.join(repo, "mod.py"), "x = 2\n"); // now DIRTY

    const fired = hook("pytest", repo, "E2E-1");
    const ctx = fired?.hookSpecificOutput?.additionalContext || "";
    check("51", "END-TO-END: the hook DELIVERS the advisory", ctx.includes("SCOPE:") && ctx.includes("1 changed path(s)"),
      `additionalContext starts: ${ctx.slice(0, 60)}`,
      "M-r remove the buildTestScopeAdvisory call site in validate-bash-command.js — every library case above stays green");
    check("52", "END-TO-END: it rides an ALLOW, never a deny", fired.continue === true && !fired.hookSpecificOutput?.permissionDecision,
      `continue=${fired.continue}`, "M-p");
    check("53", "END-TO-END: `Validated` is preserved, not replaced", ctx.includes("Validated"),
      "the advisory composes ONTO the clean result", "M-s make withScopeAdvisory overwrite instead of prepend");

    const again = hook("pytest", repo, "E2E-1");
    check("54", "END-TO-END: SILENT on the second run of the same session",
      (again?.hookSpecificOutput?.additionalContext || "") === "Validated",
      `-> ${JSON.stringify(again?.hookSpecificOutput?.additionalContext)}`, "M-l");

    const scopedRun = hook("pytest -k mod", repo, "E2E-2");
    check("55", "END-TO-END: SILENT on an already-scoped run",
      (scopedRun?.hookSpecificOutput?.additionalContext || "") === "Validated",
      `-> ${JSON.stringify(scopedRun?.hookSpecificOutput?.additionalContext)}`, "M-h");

    execFileSync("git", ["-C", repo, "checkout", "--", "mod.py"], { stdio: "ignore" });
    const cleanRun = hook("pytest", repo, "E2E-3");
    check("56", "END-TO-END: SILENT on a clean tree",
      (cleanRun?.hookSpecificOutput?.additionalContext || "") === "Validated",
      `-> ${JSON.stringify(cleanRun?.hookSpecificOutput?.additionalContext)}`, "M-j");
  } catch (e) {
    for (const id of ["51", "52", "53", "54", "55", "56"]) check(id, "END-TO-END", false, `harness error: ${e.message}`, "-");
  }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}
}

/* ── 11. ALREADY PARALLEL — the silence the REORDERING made load-bearing ────────
 * The advisory now LEADS with parallelism. Firing it at an operator who has already
 * parallelised tells someone who did the right thing to do it, which is the fastest
 * possible route to the whole surface being ignored. Bipolar: each SILENT row below
 * is paired with case 64/65, which prove the gate did not simply swallow everything. */
const parallel = [
  ["57", "pytest -n 8", "xdist worker count"],
  ["58", "pytest -n auto", "xdist auto — already parallel, and NOT 'broad by intent' as it was first filed"],
  ["59", "pytest --dist loadfile", "an xdist distribution mode"],
  ["60", "pytest -p xdist", "the plugin loaded explicitly"],
  ["61", "cargo test --jobs 4", "an explicit cargo job count"],
  ["62", "go test -parallel 4", "go's own parallelism flag"],
  ["63", "node --test --test-concurrency=8", "node's own concurrency flag"],
];
for (const [id, cmd, why] of parallel) {
  check(id, `SILENT (already parallel): ${why}`, !fires(cmd), `\`${cmd}\` -> ${JSON.stringify(L.classifyUnscopedTestRun(cmd))}`,
    "M-t delete the `alreadyParallel` gate in classifyUnscopedTestRun — the advisory then recommends `-n 8` to someone already running `-n 8`");
}
check("64", "FIRE: the alreadyParallel gate did NOT swallow the bare invocation",
  runnerOf("pytest") === "pytest", `bare pytest -> ${runnerOf("pytest")}`,
  "M-u widen an alreadyParallel row until it matches everything — this is the pole that makes 57-63 informative rather than constant");
check("65", "FIRE: a non-parallel flag is not mistaken for one",
  runnerOf("pytest -x") === "pytest", `\`pytest -x\` -> ${runnerOf("pytest -x")}`,
  "M-u — an unanchored `-n` row would swallow `-x`, `-q`, `-v` and go permanently silent");

/* ── 12. THE LEAD IS PARALLELISM, AND ONLY WHERE IT IS TRUE ────────────────────
 * MEASURED on a reference gate: 324.10s serial -> 65.23s at `-n 8 --dist loadfile`,
 * a 4.97x with xdist already installed. That dominates any subset a diff-derived
 * scope could pick, so it leads. The SILENT poles are the other half of the contract:
 * three of the four runners already parallelise by default, so a parallelism line for
 * them would be a confident wrong thing, and none is emitted. */
const adv = (runner) => L.formatScopeAdvisory({ runner, changed: { count: 2, sample: ["a", "b"] } }) || "";
{
  const py = adv("pytest");
  check("66", "FIRES: the pytest advisory names the measured parallel shape",
    py.includes("pytest -n 8 --dist loadfile") && py.includes("4.97x"), `pytest lead present: ${py.includes("4.97x")}`,
    "M-v set LEAD_LINE.pytest = null — the advisory reverts to leading with scoping, the ordering this change exists to fix");
  check("67", "the PARALLELISM line comes BEFORE the narrowing line",
    py.indexOf("-n 8 --dist loadfile") >= 0 && py.indexOf("-n 8 --dist loadfile") < py.indexOf("owed-suites.mjs"),
    `parallel@${py.indexOf("-n 8 --dist loadfile")} < scope@${py.indexOf("owed-suites.mjs")}`,
    "M-w swap the two pushes in formatScopeAdvisory — ORDER is the whole finding, and a set that only checks PRESENCE passes either way");
  check("68", "SILENT pole: cargo is offered NO parallelism line (`cargo test` already threads)",
    !adv("cargo").includes("-n 8") && !adv("cargo").includes("Parallelism first"), `cargo lead: ${JSON.stringify(adv("cargo").split("\n")[1])}`,
    "M-x give cargo a LEAD_LINE — a parallelism recommendation to a runner that already threads is the confident-wrong-thing this set exists to stop");
  check("69", "SILENT pole: node is offered NO parallelism line",
    !adv("node").includes("Parallelism first"), "no lead line", "M-x");
  check("70", "SILENT pole: go is offered NO parallelism line",
    !adv("go").includes("Parallelism first"), "no lead line", "M-x");

  /* ── 13. THE MEASURED REFINEMENTS, respected rather than smoothed ─────────── */
  check("71", "`-n auto` is never RECOMMENDED — it measured SLOWER than `-n 8`",
    !/pytest -n auto/.test(py) && /-n auto.*SLOWER|SLOWER.*-n auto/s.test(py),
    `recommends -n auto: ${/pytest -n auto/.test(py)}; names it slower: ${/SLOWER/.test(py)}`,
    "M-y rewrite LEAD_LINE.pytest to suggest `-n auto` — 16 workers measured 39/45s against 33/40s at 8");
  check("72", "it does NOT tell anyone that dropping coverage is a big win",
    !/(drop|remove|disable|skip)[^.\n]{0,24}(--cov|coverage)/i.test(py + adv("cargo") + adv("node") + adv("go")),
    "no drop-coverage claim in any runner's text",
    "M-z add a `drop --cov` suggestion — MEASURED, --cov under -n 8 cost only 1.48x (31s of 96s), so that advice would be wrong at the gate");
  const allText = [py, adv("cargo"), adv("node"), adv("go")].join("\n");
  check("73", "MARKERS are never suggested as a band selector",
    !/-m\s+(e2e|conformance|performance|unit|integration|slow|not\b)/.test(allText) && !/\bmarker/i.test(allText),
    "no `-m <band>` recommendation in any runner's text",
    "M-aa add `-m unit` to LEAD_LINE.pytest — MEASURED, 62.6% of the reference gate carried no tier marker and -m e2e / -m conformance / -m performance each selected ZERO; the module only RECOGNISES -m as already-scoped, which is a different act");
  const cg = adv("cargo");
  check("74", "cargo gets the HONEST nextest trade, named as NOT a drop-in",
    /NOT a drop-in/.test(cg) && /process-isolat/.test(cg) && /doctest/.test(cg),
    `not-a-drop-in: ${/NOT a drop-in/.test(cg)}; isolation: ${/process-isolat/.test(cg)}; doctests: ${/doctest/.test(cg)}`,
    "M-ab delete RUNNER_NOTE.cargo — the reader reaches for nextest next and silently loses the cross-test interaction class and doctests");
  check("75", "cargo is NOT told to switch to nextest",
    !/(use|switch to|prefer|try)\s+`?cargo nextest/i.test(cg), "no switch-to recommendation",
    "M-ac soften RUNNER_NOTE.cargo into a recommendation — at kailash-rs nextest is DELIBERATELY not the gate runner");
}

/* ── 14. THE FAN-OUT BOUND IS DERIVED FROM THE CONSUMER'S CORPUS ───────────────
 * This section is about `.claude/bin/owed-suites.mjs`, which is the instrument this
 * advisory NAMES. It is in scope here for a reason that is not filing convenience: an
 * advisory whose whole second half is "run this tool" is only as good as that tool is
 * at the repo it lands in, and the bound this tests is exactly the parameter that was
 * calibrated on loom. MEASURED: loom's p90 is 10 and its max 135; a second, larger
 * corpus measured p90 15 / max 160, where loom's old constant of 3 marks 44.3% of
 * source modules BROAD — i.e. refuses to name an owner for nearly half the tree, and
 * does it while printing a plausible-looking answer.
 *
 * BIPOLAR AND DISCRIMINATING. Two synthetic corpora with deliberately different
 * fan-out distributions are built and the SAME tool is run against both. A constant
 * returns the same bound for both; a derivation does not. That difference IS the
 * instrument (`instrument-discipline.md` MUST-1 — name the result that would appear
 * if the proposition were false: identical bounds at both corpora). */
{
  const TOOL = path.join(REPO, ".claude", "bin", "owed-suites.mjs");
  const mkRepo = (refsFor) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tsa-fanout-"));
    const N = 20;
    for (let i = 0; i < N; i++) {
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", `mod${i}.mjs`), `export const v${i} = ${i};\n`);
    }
    fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
    for (let i = 0; i < N; i++) {
      const body = refsFor(i, N).map((j) => `// covers mod${j}.mjs\n`).join("");
      /* NOISE, and it is load-bearing rather than decoration. Real suites are full of
       * filename-shaped tokens that name NOTHING in the repo — scratch fixtures,
       * tmpfile stems, files from other trees — and each appears in exactly one suite.
       * If the calibration index counts those, that singleton tail drags every
       * percentile to the floor at EVERY corpus, and the "derivation" silently becomes
       * the constant it replaced wearing a percentile. With this noise present, case 77
       * reds when the population filter is removed; without it the mutation is INERT
       * and the filter would ship unverified. */
      const noise = Array.from({ length: 30 }, (_, k) => `// scratch-${i}-${k}.json\n`).join("");
      fs.writeFileSync(path.join(dir, "tests", `s${i}.test.mjs`), `${body}${noise}export const t = ${i};\n`);
    }
    execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "config", "user.email", "a@b.c"], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "config", "user.name", "t"], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "add", "-A"], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "commit", "-qm", "i"], { stdio: "ignore" });
    return dir;
  };
  const run = (repo, extraArgs = [], extraEnv = {}) =>
    JSON.parse(
      execFileSync(process.execPath, [TOOL, "--repo-root", repo, "--files", "src/mod0.mjs", "--json", ...extraArgs], {
        encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...extraEnv },
      }),
    );

  // LOW: each module named by exactly ONE suite.   HIGH: each named by TWELVE.
  const lowRepo = mkRepo((i) => [i]);
  const highRepo = mkRepo((i, N) => Array.from({ length: 12 }, (_, k) => (i + k) % N));
  try {
    const lo = run(lowRepo);
    const hi = run(highRepo);
    check("76", "the bound is REPORTED with its provenance, never as a bare number",
      typeof lo.fanout_max_source === "string" && lo.fanout_max_source.length > 0 && lo.fanout_percentiles != null,
      `source=${JSON.stringify(lo.fanout_max_source)} percentiles=${JSON.stringify(lo.fanout_percentiles)}`,
      "M-ad drop fanout_max_source/fanout_percentiles from the JSON — a consumer then cannot tell a derived bound from a pinned one, which is the whole calibration affordance");
    check("77", "DISCRIMINATION: a higher-fan-out corpus DERIVES a higher bound",
      hi.fanout_max > lo.fanout_max,
      `low(p70=${lo.fanout_percentiles.p70 ?? "-"}) -> ${lo.fanout_max}; high -> ${hi.fanout_max}; ` +
        `low pct=${JSON.stringify(lo.fanout_percentiles)}, high pct=${JSON.stringify(hi.fanout_percentiles)}`,
      "M-ae restore `const FANOUT_MAX = 3` — BOTH corpora then report 3, which is the exact result this case exists to make impossible");
    check("78", "the HIGH corpus's bound is DERIVED, not the floor",
      /^derived p\d+/.test(hi.fanout_max_source), `high source: ${JSON.stringify(hi.fanout_max_source)}`, "M-ae");
    check("79", "the LOW corpus falls back to the READABILITY FLOOR, and says which",
      lo.fanout_max === 3 && /readability-floor/.test(lo.fanout_max_source), `low source: ${JSON.stringify(lo.fanout_max_source)}`,
      "M-af drop the floor — a corpus whose suites barely cross-reference collapses to a bound of 1 and starts refusing files named by two suites");
    const over = run(highRepo, ["--fanout-max", "2"]);
    check("80", "an explicit --fanout-max WINS and is labelled an override, never measured",
      over.fanout_max === 2 && /override via --fanout-max/.test(over.fanout_max_source),
      `-> ${over.fanout_max} / ${JSON.stringify(over.fanout_max_source)}`,
      "M-ag ignore the flag, or label an override as derived — a pinned bound reported as measured is a fabricated measurement");
    const text = execFileSync(process.execPath, [TOOL, "--repo-root", lowRepo, "--files", "src/mod0.mjs"], {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    check("82", "the bound is reported in TEXT mode even when nothing is BROAD",
      /Fan-out bound: 3 —/.test(text) && /readability-floor/.test(text) && !/BROADLY REFERENCED/.test(text),
      `broad band present: ${/BROADLY REFERENCED/.test(text)}; bound line: ${JSON.stringify((text.match(/Fan-out bound:.*/) || [null])[0])}`,
      "M-aj print the bound only inside the BROAD block — a reader calibrating it would then have to provoke a BROAD row to find out what it was, and this LOW corpus never produces one");
    const envOver = run(highRepo, [], { OWED_SUITES_FANOUT_MAX: "9" });
    check("81", "OWED_SUITES_FANOUT_MAX pins the bound in a consumer's own CI, and is labelled",
      envOver.fanout_max === 9 && /OWED_SUITES_FANOUT_MAX/.test(envOver.fanout_max_source),
      `-> ${envOver.fanout_max} / ${JSON.stringify(envOver.fanout_max_source)}`,
      "M-ah drop the env read — the documented calibration path for a consumer that cannot edit the tool then does not exist");
  } catch (e) {
    for (const id of ["76", "77", "78", "79", "80", "81", "82"]) check(id, "FAN-OUT DERIVATION", false, `harness error: ${e.message}`, "-");
  }
  for (const d of [lowRepo, highRepo]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

let failed = 0;
for (const c of cases) {
  if (!c.pass) failed++;
  process.stdout.write(`${c.pass ? "PASS" : "FAIL"}  ${c.id}  ${c.name}  [${c.detail}]\n`);
}
process.stdout.write(`\n${cases.length - failed}/${cases.length} cases pass\n`);
process.exit(failed === 0 ? 0 : 1);
