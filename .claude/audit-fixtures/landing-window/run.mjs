/**
 * landing-window fixture runner — T68.
 *
 * WHAT THIS PINS, AFTER THE 2026-10-01 CONVERSION. `.claude/hooks/
 * landing-window-guard.js` reports an ADVISORY — naming the window and its owner
 * — on a write to the PRIMARY's working tree while a `land-lane` /
 * `dev-preflight` window is open. It denies NOTHING, from anyone, on any arm.
 * Separately, `.claude/hooks/lib/append-sink.js` +
 * `.claude/hooks/lib/burndown-events.js` still REFUSE a HOOK append into a
 * tracked sink under the same window; that half is unchanged and is pinned here
 * too, as is the jurisdiction boundary that keeps the advisory off lanes.
 *
 * ⛔ WHY EVERY `[BLOCK]` ASSERTION IN THIS FILE BECAME `[ADVISORY]`. A suite that
 * asserts a deny the code no longer performs is a green suite certifying
 * behaviour that does not exist — and this item produced exactly that three
 * times running, the third being 71 passed / 0 failed with four bypasses live.
 * So the conversion is not cosmetic: each converted arm now asserts the verdict
 * the hook actually reaches, and the FLOOR in `.claude/test-harness/
 * ci-audit-fixtures.json` moves with the arm count in the same change.
 *
 * EVERY CASE NAMES ITS FALSIFIER (`instrument-discipline.md` MUST-1). A case
 * whose expected value could not differ under any input is not evidence, and
 * the reporter prints the falsifier on failure so a future reader can tell a red
 * from a case that could never have been green.
 *
 * PAIRED CONTROLS, not a green alone (MUST-2/MUST-3). Each advisory case is
 * paired with the SAME payload under ONE flipped element — the owner's session,
 * or the target's tree — so a passing suite proves the advisory is ATTRIBUTABLE
 * to the predicate under test rather than to a branch that fires on everything.
 * `07-read-only-git-allowed`, `06-sibling-write-allowed` and
 * `51-read-only-command-allowed` are the controls that would catch a hook that
 * simply warns about everything.
 *
 * A GREEN HERE IS WEAK EVIDENCE, AND THIS FILE SAYS SO. The suite ran green
 * while four bypasses were live; what closed them was the FLIPPED VERDICT on
 * arms driven by those exact payloads, not the green. Treat a pass as "these
 * arms still discriminate", never as "the detector is complete".
 *
 * THE MUTATION CONTRACT. This runner takes `--guard <path>` so a mutant can be
 * driven from the SAME directory (a copy at a different relative depth fails to
 * load, and that failure mimics the phenomenon under test). The mutation that
 * MUST go red is SILENCING the advisory in `landing-window-guard.js::evaluate`
 * (returning `null` where the finding object is returned), which must red the
 * arms that expect `[ADVISORY]` — and must NOT red the `(none)` controls, which
 * is what separates a silenced advisory from a broken runner.
 *
 * THE TRACKED / UNTRACKED ARMS (the 2026-09-30 correction). `dev-preflight`'s
 * `treeState()` runs `git status --porcelain=v1 -z --untracked-files=all`;
 * `land-lane`'s `trackedDirty()` runs `git status --porcelain
 * --untracked-files=no`. ONE WORD, TWO PREDICATES — and the measured defect was
 * a `--import-receipt` REFUSING on exactly one untracked scratch file while
 * `land-lane land` would have allowed it. So "frozen" must mean tracked AND
 * untracked: both arms are pinned, by running those two exact invocations.
 */
import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { makeReporter, cleanup, mkRepo, driveHook } from "../hook-fixture-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// `.claude/audit-fixtures/landing-window/` -> `.claude/`
const CLAUDE = path.resolve(HERE, "..", "..");
const DEFFAULT_GUARD = path.join(CLAUDE, "hooks", "landing-window-guard.js");
const guardArgIdx = process.argv.indexOf("--guard");
const GUARD = guardArgIdx >= 0 ? path.resolve(process.argv[guardArgIdx + 1]) : DEFFAULT_GUARD;

const require_ = createRequire(import.meta.url);
const LW = require_(path.join(CLAUDE, "hooks", "lib", "landing-window-read.js"));
const SINK = require_(path.join(CLAUDE, "hooks", "lib", "append-sink.js"));

// T10's SUBJECT — the one-shot availability lookup. Driven through `--oa` for the
// same reason the guard takes `--guard`: a mutant must be runnable, and the
// mutation contract is worthless if the only shape a suite can see is the
// correct one. The module is REQUIRED here (not spawned), so a mutant copy loads
// from anywhere; the depth trap that forces `--guard` to stay a sibling does not
// apply to this half.
const oaArgIdx = process.argv.indexOf("--oa");
const OA_PATH =
  oaArgIdx >= 0
    ? path.resolve(process.argv[oaArgIdx + 1])
    : path.join(CLAUDE, "hooks", "lib", "override-availability.js");
const OA = require_(OA_PATH);
// The verdict names its OWN bytes: trestle ships a SNAPSHOT of the tree, so the
// path alone cannot show WHICH content ran. Printed for the same reason the
// mutation contract is stated in this header — a green over a subject nobody
// pinned is a green about an unknown program.
const OA_DIGEST = createHash("sha256").update(fs.readFileSync(OA_PATH)).digest("hex").slice(0, 16);

const { check: emit, finish } = makeReporter();

// Every emitted check NAME, in order. The pole-coverage check at the END of this
// file is the only reader: it asserts that each pole declared in `POLES` is
// actually DRIVEN by a check bearing that pole's token, which no cardinality
// fence can show. Wrapping `check` here rather than threading a tally through 50
// call sites keeps the two halves (declaration, coverage) from drifting apart.
const CHECK_NAMES = [];
const check = (name, ...rest) => {
  CHECK_NAMES.push(name);
  return emit(name, ...rest);
};

const OWNER = "owner-session-0001";
const OTHER = "intruder-session-0002";
const ownerEnv = (pid) => ({ CLAUDE_CODE_SESSION_ID: OWNER, CLAUDE_PID: String(pid) });
const otherEnv = () => ({ CLAUDE_CODE_SESSION_ID: OTHER });

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "afx-lw-"));
const PRIMARY = mkRepo("lw-primary");
const SIBLING = path.join(tempRoot, "lw-sibling");
execFileSync("git", ["-C", PRIMARY, "worktree", "add", "-q", "--detach", SIBLING], { stdio: "ignore" });

const MARKER = path.join(LW.resolveCommonGitDir(PRIMARY), "land-lane", "landing-window.json");

/**
 * Write a HAND-BUILT marker — a stale one, a malformed one — into the window path.
 *
 * The parent `<git-common-dir>/land-lane/` directory is created here rather than
 * assumed. It is NOT durable state: `closeWindow` removes it once it is empty
 * (mirroring `land-lane.mjs::removeState`, which has always removed its own state
 * file "and the dir when it is then empty"), so any fixture that writes a raw
 * marker AFTER a close is racing a directory that is legitimately gone — measured,
 * this fixture's T5 failed with ENOENT the moment the close path stopped leaving
 * an empty directory behind. The precondition is stated here so it cannot be
 * inherited accidentally by the next raw write either.
 */
function writeMarkerRaw(text) {
  fs.mkdirSync(path.dirname(MARKER), { recursive: true });
  fs.writeFileSync(MARKER, text);
}
const WRITE_TARGET = path.join(PRIMARY, "a.txt");
const UNTRACKED_TARGET = path.join(PRIMARY, "scratch-untracked.txt");

console.log(`guard under test : ${GUARD}`);
console.log(`one-shot subject : ${OA_PATH}  sha256:${OA_DIGEST}`);
console.log(`primary          : ${PRIMARY}`);
console.log(`sibling          : ${SIBLING}`);
console.log(`marker           : ${MARKER}`);

function drive(payload, env) {
  return driveHook(GUARD, { stdinRaw: JSON.stringify(payload), cwd: PRIMARY, env });
}
const writeCall = (file, session, cwd) => ({
  tool_name: "Write",
  tool_input: { file_path: file },
  cwd: cwd || PRIMARY,
  session_id: session,
});
const bashCall = (command, session, cwd) => ({
  tool_name: "Bash",
  tool_input: { command },
  cwd: cwd || PRIMARY,
  session_id: session,
});

function openWindow(purpose) {
  return LW.openWindow(PRIMARY, { purpose, env: { ...process.env, ...ownerEnv(process.pid) } });
}
function closeWindow() {
  return LW.closeWindow(PRIMARY, { env: { ...process.env, ...ownerEnv(process.pid) } });
}

// ---------------------------------------------------------------------------
// T1 — coverage: the poles this suite CLAIMS to drive are all driven below.
// ---------------------------------------------------------------------------
console.log("\n=== T1: the declared pole set is driven (coverage) ===");
// A POLE IS A CLAIM, AND `checks` IS WHAT DISCHARGES IT. Each entry names the
// leading TOKEN of the check(s) below that drive it — the tokens are stable
// (`01`, `09a`, `30b`, …) while the reporter's own pass/fail index is not.
//
// WHY THE TOKENS ARE HERE RATHER THAN A BARE NAME LIST. The check that used to
// sit here asserted only `POLES.length === 28` while its name claimed the runner
// "drives every pole it declares" — a drift fence wearing a coverage claim, the
// same claim-outrunning-its-assertion class as the guard's `pid ? on ?`
// advisory body (T68 D2/D4). The assertion that discharges the name now lives at
// the END of the file, where every token has been emitted or not:
//   A pole whose declared token(s) never appeared in `CHECK_NAMES` IS UNDRIVEN.
// Falsifying result for that check: a pole list entry whose token was never
// emitted — e.g. delete the drive at `27` and the `compound-shell-mutating-git-
// advised` pole reds, naming itself. Verified by mutation, not asserted.
//
// `hostConditional` marks a pole whose arm cannot run everywhere: the H6
// case-variant arms require a case-INSENSITIVE volume, and on the fleet's Linux
// hosts they legitimately do not run. The flag does NOT excuse a missing token
// silently — the check reads `CASE_INSENSITIVE_VOLUME` and only excuses the pole
// when that precondition is FALSE on this host, which it states in its detail.
const POLES = [
  { pole: "primary-tracked-write-advised", checks: ["01"] },
  { pole: "advisory-names-window", checks: ["02"] },
  { pole: "advisory-names-owner", checks: ["03"] },
  { pole: "advisory-names-alternative", checks: ["04"] },
  // NO EXEMPTION (redesign clause (a), kept through the advisory conversion):
  // the owner's own tool call hears the same advisory as anyone else's, because
  // a window is held by a TOOL, not a session.
  { pole: "owner-write-advised-no-exemption", checks: ["05"] },
  { pole: "sibling-write-allowed", checks: ["06"] },
  { pole: "read-only-git-allowed", checks: ["07"] },
  { pole: "mutating-git-advised", checks: ["08"] },
  { pole: "mutating-git-via-C-from-sibling-advised", checks: ["09"] },
  { pole: "untracked-write-advised", checks: ["10"] },
  { pole: "dev-preflight-status-counts-untracked", checks: ["11"] },
  { pole: "land-lane-status-ignores-untracked", checks: ["12"] },
  // `not-advised` rather than `not-refused`: the arms below assert a REPORT, so
  // the competing branch they must exclude is the advisory, and a `!includes
  // ("[BLOCK]")` conjunct would now be trivially true on every path.
  { pole: "stale-marker-reported-not-advised", checks: ["13"] },
  { pole: "close-lifts-the-advisory", checks: ["14"] },
  // 15 and 16 are ONE pole, two claims: the sink refusal itself, and that it
  // names the marker. Both must run for `hook-append-refused` to be discharged.
  // THIS POLE IS UNCHANGED BY THE CONVERSION — it is the OTHER half of T68, a
  // predicate over the exact path being written, not the hook's advisory.
  { pole: "hook-append-refused", checks: ["15", "16"] },
  { pole: "burndown-append-site-wired", checks: ["17", "18"] },
  { pole: "hook-append-allowed-after-close", checks: ["19"] },
  { pole: "malformed-marker-reported-not-advised", checks: ["20"] },
  // T7 — the 2026-10-01 adversarial round. Every one of these was MEASURED
  // ALLOWED by the guard that passed the other 18.
  { pole: "owner-identity-disagreement-advised", checks: ["23", "24"] },
  // All four H1 arms advise, and the unanimity is the finding — identity carries
  // no exemption on any signal, and no nonce restores one.
  { pole: "owner-identity-carries-no-exemption", checks: ["25", "26"] },
  // T11 — the ONE-SHOT NONCE — HAS NO POLE HERE, AND ITS ABSENCE IS THE
  // CONVERSION. The nonce existed to name the single call that could cross a
  // DENY; with no deny there is nothing to cross, and the mint, the allow-file,
  // the spend ledger and the one-shot gate were removed rather than re-graded.
  // Its three poles dissolved with the mechanism (they are not "undriven" — they
  // are gone, and the coverage check below reads this table).
  { pole: "compound-shell-mutating-git-advised", checks: ["27"] },
  { pole: "compound-shell-without-git-allowed", checks: ["28"] },
  { pole: "cwd-outside-repo-git-C-advised", checks: ["29", "30c"] },
  { pole: "cwd-outside-repo-write-advised", checks: ["30", "30b"] },
  // 32b is UNCONDITIONAL (a string property of the predicate) while 31/32 need a
  // case-insensitive volume; `hostConditionalChecks` names exactly which tokens
  // the host precondition may excuse, so 32b can never be excused with them.
  {
    pole: "case-variant-primary-path-advised",
    checks: ["31", "32", "32b"],
    hostConditionalChecks: ["31", "32"],
  },
  { pole: "nested-worktree-allowed", checks: ["34", "35"] },
  { pole: "non-git-write-path-advised", checks: ["36"] },
  { pole: "non-git-write-outside-allowed", checks: ["37"] },
  // T12 — redesign clause (d): the writer denylist becomes a READ-ONLY allowlist,
  // and an unrecognised command ranks TIGHTEST. Two poles because a hook that
  // advises on everything satisfies neither meaningfully.
  { pole: "non-git-writer-unrecognised-advised", checks: ["50"] },
  { pole: "non-git-read-only-command-allowed", checks: ["51"] },
  // T10 — the one-shot override's AVAILABILITY lookup. RED and GREEN are two
  // poles because neither alone can show the answer TRACKS the ledger: the
  // spent arm passes against an always-`spent` lookup and the unspent arm
  // against an always-`available` one. 44 is folded into the RED pole because
  // it is that pole's PREMISE — a listing that could discriminate would make the
  // RED arm measure nothing.
  { pole: "one-shot-availability-ledger-derived", checks: ["42", "44"] },
  { pole: "one-shot-availability-unspent-pole", checks: ["43"] },
  { pole: "one-shot-availability-fail-closed", checks: ["45"] },
];
// T1 asserts the TABLE, not the coverage — the two are different claims and only
// the second was being made. Coverage is asserted at the end of the file.
check(
  "the declared pole table is cardinality-pinned and its check tokens are unique",
  POLES.length === 33 &&
    POLES.every(
      (p) =>
        typeof p.pole === "string" &&
        p.pole.length > 0 &&
        Array.isArray(p.checks) &&
        p.checks.length > 0 &&
        // An excusable token that is not one of this pole's own checks would be a
        // licence to excuse a token nothing was ever asked to emit.
        (p.hostConditionalChecks === undefined ||
          (Array.isArray(p.hostConditionalChecks) &&
            p.hostConditionalChecks.length > 0 &&
            p.hostConditionalChecks.every(
              (t) => typeof t === "string" && p.checks.includes(t),
            ))),
    ) &&
    new Set(POLES.flatMap((p) => p.checks)).size === POLES.flatMap((p) => p.checks).length,
  `${POLES.length} poles declared, ${POLES.flatMap((p) => p.checks).length} tokens, ` +
    `${POLES.filter((p) => p.hostConditionalChecks).flatMap((p) => p.hostConditionalChecks).length} host-conditional`,
  "a count other than the declared set, a malformed entry, or a token claimed by two poles = the declaration below is not the one this file means; the coverage check at the end of this file reads THIS table, so a broken table silently weakens it",
);

// ---------------------------------------------------------------------------
// T2 — the live window, and the advisory poles
// ---------------------------------------------------------------------------
console.log("\n=== T2: live window — advisories, and their paired controls ===");
const opened = openWindow("audit-fixture");
check(
  "marker opens inside the PRIMARY's git dir (shared by the sibling)",
  opened.ok === true &&
    opened.path === path.join(LW.resolveCommonGitDir(PRIMARY), "land-lane", "landing-window.json"),
  `ok=${opened.ok} path=${opened.path}`,
  "a marker anywhere else is not visible to a sibling worktree, so the guard would be blind from every lane — the one place it must not be",
);
check(
  "the SAME marker resolves from the sibling worktree",
  LW.resolveCommonGitDir(SIBLING) === LW.resolveCommonGitDir(PRIMARY),
  `${LW.resolveCommonGitDir(SIBLING)} vs ${LW.resolveCommonGitDir(PRIMARY)}`,
  "different common dirs = the sibling reads a different marker (or none), so a lane cannot see the primary is busy",
);

const rTracked = drive(writeCall(WRITE_TARGET, OTHER), otherEnv());
check(
  "01  a write to a TRACKED primary path is ADVISED [ADVISORY] and NOT refused",
  rTracked.tag === "[ADVISORY]" && rTracked.code === 0,
  `exit=${rTracked.code} tag=${rTracked.tag}`,
  "no [ADVISORY] = the write proceeds with nobody told the window is open, which is the invisibility T68 exists for; [BLOCK] or exit 2 = the deny came back, and the conversion did not happen",
);
check(
  "02  the advisory NAMES THE WINDOW",
  /A LANDING WINDOW IS OPEN/.test(rTracked.combined) && rTracked.combined.includes(opened.path),
  "window line + marker path present",
  "absent = the agent is told a window is open with no way to learn where it lives or what opened it",
);
check(
  "03  the advisory NAMES THE OWNER",
  rTracked.combined.includes(OWNER),
  "owner session id present in the body",
  "absent = nobody can be asked about it; the window becomes an anonymous notice",
);
// 03 above passes on the session STRING alone, so it cannot see a body that
// prints `pid ? on ?` — the placeholder is in the same line and reads as
// satisfied. This arm reads the MARKER's own record and requires the advisory to
// reproduce it, which is the claim `describeWindow` already makes correctly.
const liveOwner = JSON.parse(fs.readFileSync(MARKER, "utf8")).owner;
check(
  "03b the advisory states the owner's REAL pid and host, matching the marker's own record",
  rTracked.combined.includes(`pid ${liveOwner.pid} on ${liveOwner.host}`),
  `marker record: pid ${liveOwner.pid} on ${liveOwner.host}; advisory line: ${(
    rTracked.combined.match(/owner\s*:\s*.*/) || ["<none>"]
  )[0].trim()}`,
  "`pid ? on ?` = the advisory asserts a pid and host it never supplies. MEASURED before this fix: the session id was bound to `owner` and then `owner.pid`/`owner.host` were read off that STRING, so the finding body contradicted describeWindow's report of the SAME marker — a claim-vs-code defect, not a cosmetic one, in a notice whose purpose is to say who to ask",
);
check(
  "04  the advisory NAMES THE ALTERNATIVE (a sibling worktree)",
  /SIBLING worktree/.test(rTracked.combined),
  "alternative present",
  "absent = the notice states a cost with no move attached, and an agent given no legitimate move finds one that is not",
);

// ⛔ INVERTED 2026-10-01 (T68 redesign clause (a)), AND THE INVERSION SURVIVED
// THE CONVERSION. This check used to read "the OWNER's write to the same path is
// ALLOWED", on the reasoning that naming the owner's own writes would make
// `dev-preflight` hear a notice about itself. A window is held by a TOOL, not a
// session, and the landing tool's
// own writes run inside its own process where PreToolUse never sees them — so no
// exemption is needed for them, and the owner's own TOOL CALLS are exactly the
// writes worth naming. The owner is told too.
//
// Kept as a CONTROL, with its polarity flipped: same payload, same path, only the
// identity differs from case 01. It now guards the opposite failure — that the
// exemption quietly comes back.
const rOwner = drive(writeCall(WRITE_TARGET, OWNER), ownerEnv(process.pid));
check(
  "05  CONTROL — the OWNER's write to the same path is ADVISED, not exempt (no owner exemption)",
  rOwner.tag === "[ADVISORY]",
  `exit=${rOwner.code} tag=${rOwner.tag}`,
  "a silent pass here = the owner exemption is back, and since subagents inherit the orchestrator's session id it exempts the owner's entire fan-out rather than the owner",
);

const rSibling = drive(writeCall(path.join(SIBLING, "a.txt"), OTHER, SIBLING), otherEnv());
check(
  "06  CONTROL — a write to a SIBLING worktree is SILENT",
  rSibling.tag === "(none)" && rSibling.code === 0,
  `exit=${rSibling.code} tag=${rSibling.tag}`,
  "a notice here = every lane is told a window is open whenever any window is open anywhere, in the one place lanes legitimately write; the hook is then worse than none",
);

const rReadOnly = drive(bashCall("git status --porcelain", OTHER), otherEnv());
check(
  "07  CONTROL — a READ-ONLY git command in the primary is SILENT",
  rReadOnly.tag === "(none)" && rReadOnly.code === 0,
  `exit=${rReadOnly.code} tag=${rReadOnly.tag}`,
  "a notice here = the hook reads a read as a write, and `git log` draws a warning for the length of every preflight",
);

const rGit = drive(bashCall("git commit -m x", OTHER), otherEnv());
check(
  "08  a MUTATING git command in the primary is ADVISED",
  rGit.tag === "[ADVISORY]" && rGit.code === 0,
  `exit=${rGit.code} tag=${rGit.tag}`,
  "no [ADVISORY] = a commit lands inside the window silently, by the very route that cost a full run on 2026-09-30 (instance 1)",
);

const rGitC = drive(bashCall(`git -C ${PRIMARY} commit -m x`, OTHER, SIBLING), otherEnv());
check(
  "09  a mutating git command aimed at the primary VIA -C from a sibling is ADVISED",
  rGitC.tag === "[ADVISORY]" && rGitC.code === 0,
  `exit=${rGitC.code} tag=${rGitC.tag}`,
  "no [ADVISORY] = the jurisdiction test keys on the CALLER's tree instead of the TARGET's, and every lane can write the primary through `git -C` unremarked",
);

// ---------------------------------------------------------------------------
// C1 (found 2026-10-01) — the SHELL `cd` TRAIL: TWO cases, both directions.
// ---------------------------------------------------------------------------
// The `-C` arm above (09) folds correctly. The `cd` trail did NOT: a comment in
// the guard claimed `inv.dir` arrived "with any `cd` trail folded in by the
// parser", while `parseGitInvocations` returns `workTree || cDir` — the `-C` /
// `--work-tree` operand ONLY. Against that guard, ONE `cd` was a complete bypass
// AND a `cd` out of the primary produced a finding for a write that never
// touched it.
//
// BOTH poles ship, because each closes a direction the other cannot see: a pole
// carrying only the bypass would have left the over-fire unobserved, and a hook
// that fires on out-of-tree work is how a notice stops being read.
console.log("\n=== C1: the shell `cd` trail — the bypass AND the over-fire ===");
const rCdInto = drive(bashCall(`cd ${PRIMARY} && git commit -m x`, OTHER, SIBLING), otherEnv());
check(
  "09a a mutating git command reaching the primary VIA a shell `cd` from a sibling is ADVISED",
  rCdInto.tag === "[ADVISORY]" && rCdInto.code === 0,
  `exit=${rCdInto.code} tag=${rCdInto.tag}`,
  "no [ADVISORY] = one `cd` silences this hook entirely, the same reach its `-C` sibling (09) already has",
);

const rCdAway = drive(bashCall(`cd ${tempRoot} && git commit -m x`, OTHER, PRIMARY), otherEnv());
check(
  "09b ...but a `cd` OUT of the primary produces NO advisory (the over-fire direction)",
  rCdAway.tag === "(none)" && rCdAway.code === 0,
  `exit=${rCdAway.code} tag=${rCdAway.tag}`,
  "an [ADVISORY] here = a write that lands OUTSIDE the primary is reported anyway, which is the over-fire a bypass-only pole misses",
);

// ---------------------------------------------------------------------------
// T3 — the TRACKED and UNTRACKED arms (the 2026-09-30 correction)
// ---------------------------------------------------------------------------
console.log("\n=== T3: `frozen` means TRACKED *and* UNTRACKED (two predicates, one word) ===");
const rUntracked = drive(writeCall(UNTRACKED_TARGET, OTHER), otherEnv());
check(
  "10  a write to a NEW, UNTRACKED path in the primary is ADVISED",
  rUntracked.tag === "[ADVISORY]" && rUntracked.code === 0,
  `exit=${rUntracked.code} tag=${rUntracked.tag}`,
  "no [ADVISORY] = the fixture set pins only the tracked arm, and the MEASURED defect (an untracked scratch file voiding an import) goes unremarked",
);

// The two predicates, RUN AS THEMSELVES. An untracked file is created; the two
// invocations below are byte-for-byte the ones the two call sites run.
fs.writeFileSync(UNTRACKED_TARGET, "scratch\n");
const deffStatus = execFileSync(
  "git",
  ["-C", PRIMARY, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
  { encoding: "utf8" },
);
const landStatus = execFileSync(
  "git",
  ["-C", PRIMARY, "status", "--porcelain", "--untracked-files=no"],
  { encoding: "utf8" },
);
fs.rmSync(UNTRACKED_TARGET, { force: true });
check(
  "11  dev-preflight's `treeState()` invocation COUNTS the untracked file as DIRTY",
  deffStatus.split("\0").some((e) => e.slice(3) === "scratch-untracked.txt"),
  `status --untracked-files=all listed ${deffStatus.split("\0").filter(Boolean).length} path(s)`,
  "absent = the premise of this whole item's correction is wrong on this tree, and the untracked arm would be pinning a phantom",
);
check(
  "12  land-lane's `trackedDirty()` invocation does NOT — SAME word, DIFFERENT predicate",
  landStatus.trim() === "",
  `status --untracked-files=no listed ${JSON.stringify(landStatus)}`,
  "a non-empty result here = the two predicates agree, so the measured `land` allows / `--import-receipt` refuses divergence is gone and this correction should be re-measured, not deleted",
);

// ---------------------------------------------------------------------------
// T4 — staleness, close, and the hook-write half (clause 3)
// ---------------------------------------------------------------------------
console.log("\n=== T4: stale, close, and the OWNER'S OWN HOOK WRITES ===");
const live = fs.readFileSync(MARKER, "utf8");
const staleRec = JSON.parse(live);
staleRec.started_at = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
staleRec.owner.pid = 0x7ffffffe; // certainly dead, and certainly not this process
writeMarkerRaw(JSON.stringify(staleRec));
const rStale = drive(writeCall(WRITE_TARGET, OTHER), otherEnv());
check(
  "13  a STALE marker is REPORTED ([HALT-AND-REPORT]) and NOT advised on",
  rStale.tag === "[HALT-AND-REPORT]" && !rStale.combined.includes("[ADVISORY]"),
  `exit=${rStale.code} tag=${rStale.tag} advised=${rStale.combined.includes("[ADVISORY]")}`,
  "an [ADVISORY] here = a marker that outlives its owner keeps being honoured — the exact failure mode clause 1 exists to prevent. (In [BLOCK] terms this arm is now UNFALSIFIABLE, since no arm denies anything; [ADVISORY] is the branch the stale handling must exclude.)",
);

writeMarkerRaw(JSON.stringify(JSON.parse(live)));
const closed = closeWindow();
const rAfterClose = drive(writeCall(WRITE_TARGET, OTHER), otherEnv());
check(
  "14  CLOSING the window LIFTS the advisory — the SAME call advised at 01 is now silent",
  closed.removed === true && rAfterClose.tag === "(none)" && rAfterClose.code === 0,
  `removed=${closed.removed} exit=${rAfterClose.code} tag=${rAfterClose.tag}`,
  "still [ADVISORY] = the hook latched on a marker nothing removes, so every future write draws a notice until a human deletes a file",
);

// Clause 3. INSTANCE 2 was a HOOK appending to the TRACKED `burndown/events.jsonl`.
openWindow("audit-fixture-hook-write");
const sIn = SINK.appendSinkLine({
  repoDir: PRIMARY,
  sinkPath: path.join(PRIMARY, ".claude", "learning", "fixture.jsonl"),
  line: '{"k":1}',
});
check(
  "15  a HOOK append into a tracked sink is REFUSED while the window is live",
  sIn.ok === false && sIn.error === "landing window",
  `ok=${sIn.ok} error=${sIn.error}`,
  "ok=true = the owner's own guard writes are uncovered, which is two thirds of the three observed instances and the exact one that cost a GREEN run",
);
check(
  "16  the hook-append refusal names the window and its marker",
  /LANDING WINDOW/.test(String(sIn.reason)) && String(sIn.reason).includes(MARKER),
  "window text + marker path present in the refusal reason",
  "absent = the refusal is indistinguishable from a containment failure and the operator debugs the wrong subsystem",
);

// The burndown path is the INSTANCE-2 sink specifically. Pinned at the predicate
// level against the EXACT path the append path consults, plus a source check
// that the call site is wired — an end-to-end drive would need a signing
// identity and a suite policy, which `todo-durable-ingest` already owns.
const eventsRel = require_(path.join(CLAUDE, "hooks", "lib", "burndown-events.js")).EVENTS_REL;
const cov = LW.windowCovers(PRIMARY, path.join(PRIMARY, eventsRel));
check(
  "17  the burndown log path is covered by the live window",
  cov.covered === true,
  `covered=${cov.covered} state=${cov.state} path=${eventsRel}`,
  "covered=false = the clause-3 check would be inert at the very sink whose append cost a green run (instance 2)",
);
const burndownSrc = fs.readFileSync(path.join(CLAUDE, "hooks", "lib", "burndown-events.js"), "utf8");
check(
  "18  `burndown-events.js::appendEvent` actually CONSULTS that predicate",
  /windowCovers\(\s*repoDir\s*,\s*abs\s*\)/.test(burndownSrc),
  "call site present in source",
  "absent = the predicate exists and is correct while the write path never asks it — a wired-looking detector on an unwired sink. LEXICAL instrument: it answers 'is the call present', NOT 'is it reached'; case 17 supplies the path and the suite's mutation supplies the reachability.",
);
const sOut = (() => {
  closeWindow();
  return SINK.appendSinkLine({
    repoDir: PRIMARY,
    sinkPath: path.join(PRIMARY, ".claude", "learning", "fixture.jsonl"),
    line: '{"k":1}',
  });
})();
check(
  "19  CONTROL — the same hook append is ALLOWED once the window closes",
  sOut.ok === true,
  `ok=${sOut.ok} error=${sOut.error || "-"}`,
  "still refused after close = the hook half latched, so every durable emit in the repo stops for as long as the marker survives",
);

console.log("\n=== T5: the unclassifiable marker — fail-closed DIRECTION, stated ===");
writeMarkerRaw('{"schema":"landing-window/1", "purpose": "trunc');
const rMalformed = drive(writeCall(WRITE_TARGET, OTHER), otherEnv());
check(
  "20  a MALFORMED marker is REPORTED ([HALT-AND-REPORT]) and NOT advised on",
  rMalformed.tag === "[HALT-AND-REPORT]" && !rMalformed.combined.includes("[ADVISORY]"),
  `exit=${rMalformed.code} tag=${rMalformed.tag} advised=${rMalformed.combined.includes("[ADVISORY]")}`,
  "an [ADVISORY] here = one truncated byte prints a window that is not there, and the hook's silence about WHY would be its own incident. This is the DOCUMENTED direction: unclassifiable is reported, never honoured.",
);
fs.rmSync(MARKER, { force: true });

console.log("\n=== T6: no-marker path — the hot path is a true no-op, for BOTH arms ===");
const rNoMarker = drive(writeCall(WRITE_TARGET, OTHER), otherEnv());
check(
  "21  with NO marker at all, a write proceeds silently (no marker, no work)",
  rNoMarker.tag === "(none)" && rNoMarker.code === 0,
  `exit=${rNoMarker.code} tag=${rNoMarker.tag}`,
  "a finding with no marker = the hook fires on the absence of its own subject, which is the always-warning shape the jurisdiction clause forbids",
);
// The BASH arm of the same property. Asserted separately because a guard whose
// write arm is a clean no-op can still emit a finding on EVERY Bash call — e.g.
// if a diagnostic were returned from the parser-load path, which runs before the
// marker is ever read. That shape is invisible to case 21 and is the one that
// would blast every command in every repo.
const rNoMarkerBash = drive(bashCall("git commit -m x", OTHER), otherEnv());
check(
  "22  with NO marker at all, a MUTATING git Bash call also proceeds silently",
  rNoMarkerBash.tag === "(none)" && rNoMarkerBash.code === 0,
  `exit=${rNoMarkerBash.code} tag=${rNoMarkerBash.tag}`,
  "any tag here = the hook surfaces a finding with no window to be wrong about, and since this arm runs on EVERY Bash call it would be the loudest possible false positive",
);

// ---------------------------------------------------------------------------
// T7 — THE ADVERSARIAL ROUND (2026-10-01). Every arm below is a payload a
// security refuter MEASURED as ALLOWED by the guard this suite certified 25/25
// green. That is the point of the section: the suite was green WHILE these holes
// were live, so a green is not what closes them — the FLIPPED VERDICT is. Each
// arm names the verdict it must produce and the pre-fix verdict is recorded in
// the falsifier text, so a reader can see the flip rather than trust it.
// ---------------------------------------------------------------------------
console.log("\n=== T7: the adversarial round's payloads (all measured ALLOWED before this fix) ===");
openWindow("t7-adversarial");

// --- H1: the owner test was env-only, so a dispatched subagent was exempt ----
const rH1a = drive(writeCall(WRITE_TARGET, OTHER), ownerEnv(process.pid));
check(
  "23  H1  env identity = OWNER but the PAYLOAD session is OTHER -> ADVISED",
  rH1a.tag === "[ADVISORY]" && rH1a.code === 0,
  `exit=${rH1a.code} tag=${rH1a.tag}`,
  "silence = the identity test never reads the payload, so every subagent the owner dispatched inherits the owner's env and is exempt — T68's own motivating instance",
);
const rH1b = drive(writeCall(WRITE_TARGET, OWNER), otherEnv());
check(
  "24  H1  payload session = OWNER but the ENV session is OTHER -> ADVISED (neither signal can carry it)",
  rH1b.tag === "[ADVISORY]" && rH1b.code === 0,
  `exit=${rH1b.code} tag=${rH1b.tag}`,
  "silence = the two signals disagree and the hook picked the one that exempts; a disagreement is two incompatible claims about who is calling and must not resolve to 'owner'",
);
// ⛔ 25 AND 26 INVERTED 2026-10-01 (T68 redesign clause (a)). They used to be the
// two "graceful arm" CONTROLS: an owner presenting only ONE of the two identity
// signals was ALLOWED, on the reasoning that a host exposing just one would
// otherwise refuse every owner write.
//
// That reasoning is retired with the exemption itself. The four H1 arms now
// agree — ALL FOUR ADVISE, NONE IS SILENT — and the agreement is the finding:
// identity plays NO part in the decision, so there is no signal to be graceful
// about. The arms are kept because a re-introduced identity test would have to
// break the unanimity to exist, and this is where that would show.
const rH1c = drive(writeCall(WRITE_TARGET, OWNER), { CLAUDE_PID: String(process.pid) });
check(
  "25  H1 payload session = OWNER, env session ABSENT -> ADVISED (identity carries no exemption)",
  rH1c.tag === "[ADVISORY]",
  `exit=${rH1c.code} tag=${rH1c.tag}`,
  "silence here = the owner test is back and reads the payload signal, which is the session id a dispatched subagent presents as its own",
);
const rH1d = drive(
  { tool_name: "Write", tool_input: { file_path: WRITE_TARGET }, cwd: PRIMARY },
  ownerEnv(process.pid),
);
check(
  "26  H1 env session = OWNER, payload session ABSENT -> ADVISED (identity carries no exemption)",
  rH1d.tag === "[ADVISORY]",
  `exit=${rH1d.code} tag=${rH1d.tag}`,
  "silence here = the owner test is back on the ENV signal, and every child process the owner spawned inherited that variable",
);

// --- H2: compound shell forms returned ZERO invocations to the parser -------
for (const [label, cmd] of [
  ["if/then/fi", "if true; then git commit -m x; fi"],
  ["for/do/done", "for i in 1; do git commit; done"],
  ["subshell parens", "(git commit -m x)"],
  ["brace group", "{ git commit -m x; }"],
]) {
  const r = drive(bashCall(cmd, OTHER), otherEnv());
  check(
    `27  H2  a mutating git inside ${label} -> ADVISED`,
    r.tag === "[ADVISORY]" && r.code === 0,
    `cmd=${cmd} exit=${r.code} tag=${r.tag}`,
    "silence = the parser returns ZERO invocations for this construct, `sawMutatingGit` stays false, and the hook returns BEFORE the marker is read — one shell wrapper is a complete blind spot (MEASURED pre-fix)",
  );
}
const rCompoundClean = drive(bashCall("if [ -f x ]; then echo hi; fi", OTHER), otherEnv());
check(
  "28  H2 CONTROL — a compound construct with NO git token in it -> SILENT",
  rCompoundClean.tag === "(none)" && rCompoundClean.code === 0,
  `exit=${rCompoundClean.code} tag=${rCompoundClean.tag}`,
  "a notice here = the completeness check fires on every compound shell form, so ordinary `if`/`for` work draws a warning for the length of every window (the false-positive direction the jurisdiction clause forbids)",
);

// --- H4: jurisdiction came from the CALLER's cwd ----------------------------
const rH4git = drive(bashCall(`git -C ${PRIMARY} commit -m x`, OTHER, tempRoot), otherEnv());
check(
  "29  H4  `git -C <primary> commit` from a cwd OUTSIDE any repository -> ADVISED",
  rH4git.tag === "[ADVISORY]" && rH4git.code === 0,
  `exit=${rH4git.code} tag=${rH4git.tag}`,
  "silence = jurisdiction is resolved from the caller's cwd, which is in no repository, so the hook returns null before reading the marker (MEASURED pre-fix)",
);
const rH4write = drive(writeCall(WRITE_TARGET, OTHER, tempRoot), otherEnv());
check(
  "30  H4  a WRITE to an absolute primary path from a cwd outside any repository -> ADVISED",
  rH4write.tag === "[ADVISORY]" && rH4write.code === 0,
  `exit=${rH4write.code} tag=${rH4write.tag}`,
  "silence = the same caller-cwd resolution, on the write axis; the target's own repository is never consulted",
);

// The MECHANISM, not only the verdict. Every arm above asserts a severity tag,
// and a severity tag is reachable by more than one branch — the first AFTER run
// of this suite proved it: the plain-write arms produced the right tag from the
// WRONG branch, the PARSE-FAILURE fallback, because the target's own repository
// resolved to null and the call fell through. Right verdict, wrong instrument,
// invisible to a tag-only assertion.
check(
  "30b the H4 write finding names `write-to-primary`, i.e. it came from the containment arm",
  /reason\s*:\s*write-to-primary/.test(rH4write.combined),
  `body reason line: ${(rH4write.combined.match(/reason\s*:\s*\S+/) || ["<none>"])[0]}`,
  "a different reason (e.g. git-command-parse-unavailable) = the target's own repository did not resolve and the call was caught by the fallback instead — the same trap that hid the missing anchor in this very fix",
);
check(
  "30c the H4 git finding names `mutating-git-in-primary`",
  /reason\s*:\s*mutating-git-in-primary/.test(rH4git.combined),
  `body reason line: ${(rH4git.combined.match(/reason\s*:\s*\S+/) || ["<none>"])[0]}`,
  "a different reason = the git arm is not the branch that fired, so the arm is not doing what its name claims",
);

// --- H6: case-variant containment (realpathSync does not fold case here) -----
const UPPER_PRIMARY = PRIMARY.toUpperCase();
const UPPER_TARGET = path.join(UPPER_PRIMARY, "a.txt");
// THE PRECONDITION IS A PROPERTY OF THE HOST, and it is stated rather than
// assumed — this arm is INERT on a case-sensitive filesystem, where the attack
// it pins cannot exist at all. MEASURED: the suite runs on the trestle fleet,
// whose Linux hosts are case-sensitive, and on darwin (the guard's target
// platform) they are not. A `check` that merely passes on both would be the
// vacuous-green shape; so the arm RUNS where it applies and SAYS SO where it
// does not, and the pole it covers is listed as host-conditional above.
const caseInsensitiveVolume = fs.existsSync(UPPER_PRIMARY);
if (caseInsensitiveVolume) {
  const rH6 = drive(writeCall(UPPER_TARGET, OTHER), otherEnv());
  check(
    "31  H6  a CASE-VARIANT spelling of a primary path -> ADVISED",
    rH6.tag === "[ADVISORY]" && rH6.code === 0,
    `exit=${rH6.code} tag=${rH6.tag} (volume is case-insensitive)`,
    "silence = the write reaches the primary and the hook never sees it (MEASURED pre-fix on darwin)",
  );
  // ⛔ WHAT ARM 31 DOES *NOT* COVER (MEASURED 2026-10-01, T68 D3). This arm was
  // briefly read as coverage for `normalizePathForCompare`'s case fold. It is
  // not, and the distinction is the whole of arm 32b below. Deleting the fold
  // left this arm BLOCKING and the suite 56/0; deleting the fold AND the
  // `realpathSync.native` preference left it blocking too. The reason is H4:
  // jurisdiction resolves BOTH sides of the containment test from ONE anchor —
  // `canonicalizeForContainment(t.path)` against `resolvePrimaryRoot(nearestExistingPath(t.path))`
  // — so a case-variant spelling is canonicalised into the SAME spelling on both
  // sides and the fold's effect cancels. What this arm pins is CANONICALISATION
  // (that the anchor resolves at all), which is genuinely load-bearing.
  // ...and the containment claim DRIVEN rather than asserted: the upper-cased
  // spelling reaches the very file the true-case path names.
  fs.writeFileSync(UPPER_TARGET, "case-variant probe\n");
  check(
    "32  H6  the case-variant path WRITES THE PRIMARY'S FILE (why the arm above matters)",
    fs.readFileSync(WRITE_TARGET, "utf8") === "case-variant probe\n",
    `read back via the true-case path: ${JSON.stringify(fs.readFileSync(WRITE_TARGET, "utf8"))}`,
    "a different content = the two spellings are genuinely different files on this volume, and the arm above is over-blocking rather than closing a hole",
  );
  fs.rmSync(WRITE_TARGET, { force: true });
} else {
  console.log(
    "      NOT RUN — H6 case-variant arms: this host's filesystem is CASE-SENSITIVE " +
      `(exists(${UPPER_PRIMARY}) === false), so a case-variant spelling names a different, ` +
      "nonexistent directory and the attack they pin cannot exist here. RUN ON DARWIN to exercise them.",
  );
}

// --- H6b: the FOLD itself, at the one seam where it is load-bearing ---------
// UNCONDITIONAL, unlike 31/32: this asserts a pure STRING property of the
// predicate, so it does not need a case-insensitive volume to be exercised.
//
// WHY A SEPARATE ARM. `normalizePathForCompare`'s fold is the SECOND half of the
// path-containment contract (`security.md` § Path Containment: both sides
// OS-NORMALIZED), and until now nothing pinned it — deleting it reddened NO
// check anywhere in this suite (MEASURED). The reason is that the guard builds
// each containment test from ONE anchor, so both sides share a spelling and the
// fold's effect cancels; the fold only decides anything when the two sides come
// from DIFFERENT producers, which happens at exactly one site:
// `linkedWorktreeTops` compares `safeRealpath(<path as git WORKTREE LIST prints
// it>)` against `resolvePrimaryRoot(<the caller's anchor>)`.
//
// The two arms below are the two halves of that statement, and they must
// DISAGREE: 32b requires the fold to be doing work, 32c requires it not to be
// doing too much. Fold deleted ⇒ 32b REDS; fold replaced by a blanket
// `toLowerCase()` on every OS ⇒ 32c is where that shows.
//
// 32b's no-fold term is `isUnder`'s OWN body with `normalizePathForCompare`
// replaced by `path.resolve` — a transcription, not an independent oracle. It is
// anchored by a MUTATION (delete the fold ⇒ 32b reds), which is what makes the
// transcription trustworthy; a transcription that agreed with a mutant would be
// the defect, not the proof.
const twoStrings = (c, p) => {
  const a = path.resolve(String(c));
  const b = path.resolve(String(p));
  if (a === b) return true;
  const rel = path.relative(b, a);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};
const UPPER_CHILD = path.join(UPPER_PRIMARY, "a.txt");
// THE EXPECTED VALUE IS THE PLATFORM'S OWN CONTRACT, not a constant — and that
// is a correction this arm made against ITSELF on the fleet's case-SENSITIVE
// Linux hosts (MEASURED: a first cut asserting `folded === true` unconditionally
// ran 55p/1f there). `normalizePathForCompare` folds BY PLATFORM NAME
// (`darwin`/`win32`), never as a blanket `toLowerCase()`, precisely so a
// case-SENSITIVE volume is not over-blocked. So there are two correct answers
// and the arm must demand the right one for the volume it is standing on:
//
//   case-insensitive volume (darwin/win32): unfolded MUST be false (or the fold
//     decides nothing) AND folded MUST be true (or the fold is gone)
//   case-SENSITIVE volume (linux):          folded MUST be false — the fold
//     must NOT be applied, or two genuinely different paths differing only in
//     case compare equal and an unrelated write is reported
//
// Both directions RED under the mutation that violates them: deleting the fold
// reds this on darwin; making it a blanket `toLowerCase()` reds it on linux.
const foldsHere = process.platform === "darwin" || process.platform === "win32";
check(
  `32b the case fold matches this volume's contract (platform ${process.platform})`,
  foldsHere
    ? twoStrings(UPPER_CHILD, PRIMARY) === false && LW.isUnder(UPPER_CHILD, PRIMARY) === true
    : LW.isUnder(UPPER_CHILD, PRIMARY) === false,
  `platform=${process.platform} foldsHere=${foldsHere} unfolded=${twoStrings(UPPER_CHILD, PRIMARY)} folded=${LW.isUnder(UPPER_CHILD, PRIMARY)} ` +
    `(child ${UPPER_CHILD} vs parent ${PRIMARY})`,
  "on a case-INSENSITIVE volume: `unfolded` true = these spellings compare equal without the fold, so the arm is not testing it; `folded` false = the fold is gone, and a case-variant spelling of the primary is no longer contained. On a case-SENSITIVE volume: `folded` true = the fold is applied where it must not be, so two different paths are read as one",
);
check(
  "32c CONTROL — the fold does NOT make an UNRELATED path contained",
  LW.isUnder(UPPER_CHILD, path.join(UPPER_PRIMARY, "..", "lw-somewhere-else")) === false,
  `folded=${LW.isUnder(UPPER_CHILD, path.join(UPPER_PRIMARY, "..", "lw-somewhere-else"))}`,
  "true here = the normalisation over-reaches past the containment test, so every write anywhere near the primary would draw a notice — the false-positive direction the jurisdiction clause forbids",
);

// --- H8: the linked-worktree enumeration returned [] unconditionally --------
const NESTED = path.join(PRIMARY, ".claude", "worktrees", "lw-nested");
execFileSync("git", ["-C", PRIMARY, "worktree", "add", "-q", "--detach", NESTED], { stdio: "ignore" });
const nestedTops = LW.linkedWorktreeTops(PRIMARY);
check(
  "34  H8  the linked-worktree enumeration FINDS the worktrees (it returned [] before)",
  nestedTops.some((t) => t === fs.realpathSync(NESTED)) && nestedTops.some((t) => t === fs.realpathSync(SIBLING)),
  `tops=${JSON.stringify(nestedTops.map((t) => path.basename(t)))}`,
  "an empty or partial list = the `--porcelain -z` parse swallows each record (`.` matches the NUL, so the capture runs past the path and realpath fails), the nested-worktree exclusion never fires, and every write inside a nested worktree draws a notice whenever a window is open",
);
const rH8 = drive(writeCall(path.join(NESTED, "a.txt"), OTHER, NESTED), otherEnv());
check(
  "35  H8  a write inside a NESTED worktree (under the primary's path) -> SILENT",
  rH8.tag === "(none)" && rH8.code === 0,
  `exit=${rH8.code} tag=${rH8.tag}`,
  "a notice here = a sibling/nested lane is told the primary is busy when it is not — the design's own words are that firing on a sibling worktree is worse than not firing at all",
);

// --- H5: the non-git write paths -------------------------------------------
for (const [label, cmd] of [
  ["output redirection", `echo x > ${path.join(PRIMARY, "redirected.txt")}`],
  ["tee", `printf x | tee ${path.join(PRIMARY, "teed.txt")}`],
  ["cp destination", `cp ${path.join(tempRoot, "lw-sibling")} ${path.join(PRIMARY, "copied.txt")}`],
  ["sed -i", `sed -i '' s/a/b/ ${path.join(PRIMARY, "a.txt")}`],
]) {
  const r = drive(bashCall(cmd, OTHER), otherEnv());
  check(
    `36  H5  a non-git write into the primary via ${label} -> ADVISED`,
    r.tag === "[ADVISORY]" && r.code === 0,
    `cmd=${cmd} exit=${r.code} tag=${r.tag}`,
    "silence = only `git` invocations are read as writes, so a redirection / tee / cp / sed -i into the primary voids the run by a route the hook does not model",
  );
}
const rH5clean = drive(bashCall(`echo x > ${path.join(tempRoot, "outside.txt")}`, OTHER), otherEnv());
check(
  "37  H5 CONTROL — a redirection to a path OUTSIDE the primary -> SILENT",
  rH5clean.tag === "(none)" && rH5clean.code === 0,
  `exit=${rH5clean.code} tag=${rH5clean.tag}`,
  "a notice here = the write-path arm fires on the MERE PRESENCE of a redirection instead of on where it lands, so every `cmd > /tmp/…` in a lane draws a warning",
);

// --- T11 HAS BEEN DELETED, AND THE DELETION IS THE CLAUSE --------------------
//
// T11 drove the ONE-SHOT NONCE: four arms (46-49) around "exactly one call may
// cross a live window, identified by an unguessable nonce". Its three poles are
// gone from `POLES` with it, and nothing here is a replacement for them.
//
// The nonce existed for exactly one reason: to name the single call permitted
// across a DENY. The deny was withdrawn (a write inside the window costs a
// RE-RUN — the receipt binds HEAD plus the tree digest and the import refuses a
// dirty tree, so the harm is a repeated run, never bad bytes), and with no deny
// there is nothing for an authorisation to authorise. So the mechanism was
// REMOVED rather than re-graded: the mint, the allow-file, the spend ledger, the
// one-shot gate and every consumer are gone from `landing-window-guard.js` and
// `hooks/lib/landing-window-read.js`. A fixture arm asserting a nonce still
// works would be asserting behaviour the hook no longer has — the exact class
// this suite has now certified green three times.

// --- T12: non-git writers are an ALLOWLIST, and the unknown ranks TIGHTEST ----
//
// The window is still live. The arm under test used to consult ONLY a six-member
// denylist of writers (`tee cp mv install truncate sed`), so every writer nobody
// listed produced NO target and the guard reported "nothing mutating here" — the
// "cannot see the construct ⇒ report nothing mutating" class, failing OPEN.
// MEASURED on a live window before the fix, cwd in the primary: `dd if=/dev/zero
// of=<primary>/s.txt`, `rsync -a …`, `patch -p1 < …` and
// `python3 -c "open(…,'w')…"` were ALL ALLOWED.
console.log("\n=== T12: non-git writers — the allowlist, with the names inside it allowed ===");
for (const [label, cmd] of [
  ["dd", "dd if=/dev/zero of=z.txt bs=1 count=1"],
  ["rsync", "rsync -a /tmp/ z.txt"],
  ["patch", "patch -p1 < x.diff"],
  ["python3 -c open(w)", `python3 -c "open('z.txt','w').write('x')"`],
]) {
  const r = drive(bashCall(cmd, OTHER), otherEnv());
  check(
    `50  T12 a non-git writer (${label}) into the primary -> ADVISED (ranked tightest)`,
    r.tag === "[ADVISORY]",
    `cmd=${cmd} exit=${r.code} tag=${r.tag}`,
    "silence = the command is absent from the writer denylist, so it produces no target and the hook reports nothing mutating — the fail-OPEN direction the allowlist replaces",
  );
}
// The CONTROL, and it is what keeps 50 from being satisfied by warning about
// everything: these ARE on the read-only allowlist and MUST stay silent.
for (const [label, cmd] of [
  ["ls", "ls -la"],
  ["cat", "cat a.txt"],
  ["echo", "echo hello"],
]) {
  const r = drive(bashCall(cmd, OTHER), otherEnv());
  check(
    `51  T12 CONTROL — a read-only command (${label}) -> SILENT`,
    r.tag === "(none)" && r.code === 0,
    `cmd=${cmd} exit=${r.code} tag=${r.tag}`,
    "a notice here = the arm fires on the MERE PRESENCE of an unlisted command rather than ranking it as a potential writer, so ordinary read-only work draws a warning for the length of every window",
  );
}

// ---------------------------------------------------------------------------
// T8 — the marker's own edges (the LOW items of the 2026-10-01 round). These
// drive the LIBRARY, not the guard process: the subject is the record and the
// classifier, and a hook spawn would add nothing but a layer of indirection
// between the assertion and the predicate.
// ---------------------------------------------------------------------------
console.log("\n=== T8: marker edges — a pid-less owner, and an opener with no identity ===");
closeWindow();
fs.rmSync(MARKER, { force: true });

const noPid = LW.openWindow(PRIMARY, {
  purpose: "t8-pidless",
  env: { CLAUDE_CODE_SESSION_ID: OWNER, CLAUDE_PID: "" },
});
check(
  "38  T8 a PID-LESS opener still opens, and the record carries the SHORTER bound",
  noPid.ok === true && noPid.record.bound_ms === LW.PIDLESS_STALE_BOUND_MS,
  `ok=${noPid.ok} bound_ms=${noPid.record && noPid.record.bound_ms} (pidless=${LW.PIDLESS_STALE_BOUND_MS})`,
  "DEFAULT bound on a pid-less record = the death check is unavailable AND the only remaining instrument is the long backstop, so a crashed pid-less owner blockades the primary for 45 minutes with nothing able to retire it early",
);
check(
  "39  T8 the classifier HONOURS the record's own bound (it used to ignore it)",
  LW.classifyWindow(noPid.record, { now: Date.now() + LW.PIDLESS_STALE_BOUND_MS + 60000 }).state === "stale" &&
    LW.classifyWindow(noPid.record, { now: Date.now() + 60000 }).state === "live",
  `@25min=${LW.classifyWindow(noPid.record, { now: Date.now() + LW.PIDLESS_STALE_BOUND_MS + 60000 }).matched} ` +
    `@1min=${LW.classifyWindow(noPid.record, { now: Date.now() + 60000 }).matched}`,
  "STATE unchanged at 25 minutes = `record.bound_ms` is written by the opener and ignored by the classifier, so `land-lane`'s own declared 20-minute bound is inert (one contract, two halves, disagreeing)",
);
const rPidless = drive(writeCall(WRITE_TARGET, OTHER), otherEnv());
check(
  "40a T8 CONTROL — the SAME pid-less marker, freshly opened, DOES advise",
  rPidless.tag === "[ADVISORY]" && rPidless.code === 0,
  `exit=${rPidless.code} tag=${rPidless.tag}`,
  "no [ADVISORY] = the pid-less arm stopped reporting at all, so the shorter bound bought its lack of a long notice by disabling the window it was supposed to keep",
);
writeMarkerRaw(
  JSON.stringify({
    ...JSON.parse(fs.readFileSync(MARKER, "utf8")),
    started_at: new Date(Date.now() - (LW.PIDLESS_STALE_BOUND_MS + 5 * 60 * 1000)).toISOString(),
  }),
);
const rPidlessOld = drive(writeCall(WRITE_TARGET, OTHER), otherEnv());
check(
  "40  T8 a pid-less marker past its own bound is REPORTED, not honoured",
  rPidlessOld.tag === "[HALT-AND-REPORT]" && !rPidlessOld.combined.includes("[ADVISORY]"),
  `live-just-opened=${rPidless.tag} 25-min-old=${rPidlessOld.tag}`,
  "an [ADVISORY] here = the pid-less arm falls through to the 45-minute default and keeps reporting long after its own opener said it would stop",
);

fs.rmSync(MARKER, { force: true });
const noSession = LW.openWindow(PRIMARY, { purpose: "t8-no-session", env: {} });
check(
  "41  T8 an opener with NO session identity writes NO marker (fail-closed, loudly)",
  noSession.ok === false && !fs.existsSync(MARKER),
  `ok=${noSession.ok} reason=${noSession.reason} markerExists=${fs.existsSync(MARKER)}`,
  "`ok:true` + a marker on disk = an unattributable record that `readWindowRecord` classifies MALFORMED, so the guard REPORTS it instead of enforcing it — protection that looks present on disk and protects nothing",
);

closeWindow();

// ---------------------------------------------------------------------------
// T10 — THE ONE-SHOT OVERRIDE, ASKED THE ONLY QUESTION AN OWNER CAN ACT ON:
// "is it still UNSPENT?" The LEDGER answers it; a directory listing cannot.
// ---------------------------------------------------------------------------
// THE MEASURED GAP. A dispatched agent spent a one-shot, human-authorised escape
// without its owner knowing. The instrument the owner reached for is the cheapest
// one to hand — a DIRECTORY LISTING of the override receipt directory — and it
// answers the SAME thing for "never spent" and "already spent", because the
// receipt is CONSUMED ON USE (`lib/override-receipt.js` UNLINKS it as it honours
// it, its own comment recording that "the unlink IS the one-shot property"). At
// rest the directory holds `README.md`, `override-ledger.jsonl` and
// `burndown-queue.jsonl` in BOTH states, so a listing's output is CONSTANT across
// the hypothesis — `instrument-discipline.md` MUST-1's exact refusal, whatever it
// printed.
//
// WHY THE TWO POLES ARE BOTH HERE. The spent arm alone passes identically
// against a lookup that answers `spent` unconditionally; the unspent arm alone
// passes against one that answers `available` unconditionally. Only the PAIR can
// show the answer TRACKS the ledger, which is the property the owner needs and
// the only one that distinguishes an instrument from a constant.
//
// THE MUTATION CONTRACT FOR THIS SECTION. `--oa <path>` replaces the subject. The
// mutation that MUST go red is deriving the verdict from the receipt DIRECTORY
// rather than the ledger — the wrong shape the owner already tried by hand.
console.log("\n=== T10: one-shot availability — the LEDGER discriminates, a listing cannot ===");

/**
 * A tree whose `.claude/wip-authz/` holds the REAL artifact set, with `ledger`
 * as the bytes of `override-ledger.jsonl`.
 */
function oaTree(label, ledger) {
  const root = path.join(tempRoot, `oa-${label}`);
  const dir = path.join(root, ".claude", "wip-authz");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "# WIP Authorization Receipts\n");
  fs.writeFileSync(path.join(dir, "burndown-queue.jsonl"), "");
  fs.writeFileSync(path.join(dir, "override-ledger.jsonl"), ledger);
  // NEITHER tree carries `wip-limit-allow`, and that IS the measured shape rather
  // than an omission: the receipt is absent AFTER a spend because it was unlinked,
  // and absent BEFORE one because it was never written. A listing sees one state.
  return root;
}

// The row schema is READ OFF canon's live ledger, not invented: one JSON object
// per line with `at` / `channel` / `land_first` / `reason`, written by
// `wip-discipline-guard.js::recordOverride` through `appendSinkLine`.
const OA_SPEND_ROW =
  JSON.stringify({
    at: "2026-10-01T00:00:00.000Z",
    channel: "receipt",
    land_first: "feat/oa-pole",
    reason: "one-shot override honoured — land-first: feat/oa-pole",
  }) + "\n";

const oaSpent = oaTree("spent", OA_SPEND_ROW);
const oaUnspent = oaTree("unspent", "");

const oaReading = (root) =>
  fs.readdirSync(path.join(root, ".claude", "wip-authz")).sort().join(",");
const oaSpentVerdict = OA.overrideAvailability({ root: oaSpent });
const oaUnspentVerdict = OA.overrideAvailability({ root: oaUnspent });

check(
  "42  T10 RED POLE — the LEDGER records the spend, so availability MUST read `spent`",
  oaSpentVerdict.state === "spent",
  `state=${oaSpentVerdict.state} ledger_rows=${oaSpentVerdict.ledger_rows}`,
  "`available` = the answer does not move when the ledger records the spend, so the lookup is reading something CONSTANT across the two states (a directory listing, or the receipt's mere presence) and will tell a dispatched agent its one-shot is intact AFTER it has been spent — the measured gap, unfixed",
);

check(
  "43  T10 GREEN POLE — an EMPTY ledger reports the one-shot UNSPENT",
  oaUnspentVerdict.state === "available",
  `state=${oaUnspentVerdict.state} ledger_rows=${oaUnspentVerdict.ledger_rows} ledger_state=${oaUnspentVerdict.ledger_state}`,
  "anything but `available` = the lookup cannot report an unspent one-shot at all, so it is a CONSTANT — and check 42 would then pass against a lookup that simply always answers `spent`",
);

check(
  "44  T10 PREMISE — the two states ARE indistinguishable by a directory listing",
  oaReading(oaSpent) === oaReading(oaUnspent) &&
    fs.readFileSync(path.join(oaSpent, ".claude", "wip-authz", "override-ledger.jsonl"), "utf8") !==
      fs.readFileSync(path.join(oaUnspent, ".claude", "wip-authz", "override-ledger.jsonl"), "utf8"),
  `listing spent=${JSON.stringify(oaReading(oaSpent))} | unspent=${JSON.stringify(oaReading(oaUnspent))}`,
  "the readings DIFFER = the two states ARE separable by a listing, so checks 42/43 pin a phantom and this section's premise must be re-measured rather than trusted. (The second conjunct guards the other direction: identical LEDGER BYTES would mean the discriminator is absent, and 42/43 would be measuring nothing)",
);

// FAIL-CLOSED. A ledger the lookup cannot READ must not be reported as an
// available one-shot: "unknown" read as "available" is a spent one-shot reading
// as an armed one, the same failure direction as the RED pole by another route.
const oaUnknown = oaTree("unknown", "");
fs.rmSync(path.join(oaUnknown, ".claude", "wip-authz", "override-ledger.jsonl"));
fs.mkdirSync(path.join(oaUnknown, ".claude", "wip-authz", "override-ledger.jsonl"));
const oaUnknownVerdict = OA.overrideAvailability({ root: oaUnknown });
check(
  "45  T10 a ledger that occupies the path but cannot be READ is `unknown`, never `available`",
  oaUnknownVerdict.state === "unknown" && oaUnknownVerdict.state !== "available",
  `state=${oaUnknownVerdict.state} ledger_state=${oaUnknownVerdict.ledger_state}`,
  "`available` = an unreadable ledger is read as an unspent one-shot, so the state a caller most needs to be told is the one it is most confident about",
);

// ---------------------------------------------------------------------------
// T9 — POLE COVERAGE, asserted where it can be. This is the check T1's
// cardinality fence used to claim by name.
// ---------------------------------------------------------------------------
console.log("\n=== T9: every declared pole was DRIVEN (not merely declared) ===");
const tokenSeen = (tok) =>
  CHECK_NAMES.some((n) => new RegExp(`^\\s*${tok}\\s`).test(n));
const undriven = [];
const excused = [];
for (const p of POLES) {
  const missing = p.checks.filter((t) => !tokenSeen(t));
  if (!missing.length) continue;
  // PER TOKEN, not per pole. A pole may carry a host-conditional token beside an
  // unconditional one (31/32 beside 32b), and excusing the whole pole would then
  // hide the unconditional token going missing — a coverage hole behind a
  // legitimate excuse. Only a token the pole itself declares host-conditional is
  // excusable, and only when the precondition its own arm states did not hold —
  // read from the suite's own measurement above, never inferred.
  const excusable = p.hostConditionalChecks || [];
  const hard = missing.filter((t) => !excusable.includes(t));
  if (!hard.length && !caseInsensitiveVolume) {
    excused.push(`${p.pole} (case-SENSITIVE host, excused: ${missing.join(",")})`);
  } else {
    undriven.push(`${p.pole} [missing ${JSON.stringify(hard.length ? hard : missing)}]`);
  }
}
check(
  "the runner drives every pole it declares",
  undriven.length === 0,
  `${POLES.length} poles: ${POLES.length - undriven.length - excused.length} driven` +
    (excused.length ? `, ${excused.length} excused by host precondition (${excused.join("; ")})` : "") +
    (undriven.length ? `, UNDRIVEN: ${undriven.join("; ")}` : ""),
  "a pole whose declared token(s) never appear in this run's check names = the header's coverage claim is broader than the code below it. This is the assertion the cardinality fence at T1 made by NAME only; a green here means each pole's proof actually ran",
);

cleanup();
fs.rmSync(tempRoot, { recursive: true, force: true });
finish();
