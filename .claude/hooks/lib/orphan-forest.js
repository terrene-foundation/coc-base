/**
 * orphan-forest.js — the classifier behind `orphan-forest-guard.js` and
 * `.claude/bin/orphan-reap.mjs`.
 *
 * THE PROBLEM, measured. On 2026-08-14 a CPU-saturation load test left 96
 * orphaned `/bin/zsh` processes on this host — two cohorts of 48, one per
 * worktree — running busy-loops at 7–15% CPU each for 22 hours, PPID 1, load
 * average peaking at 577 on 16 cores. The script's cleanup line
 * (`kill $BURNERS; echo "burners killed"`) was the last STATEMENT rather than a
 * `trap`, so it never executed in any invocation: zero task-output files on the
 * host contain the string it would have printed. They were found and killed by
 * hand a day and a half later. Full post-mortem:
 * `workspaces/runtime-enforcement-2026-08-14/01-analysis/03-burner-leak-postmortem.md`.
 *
 * WHY A CLASSIFIER AND NOT A RULE. The corpus already carries
 * `instrument-discipline.md` MUST-1, and the leaked script still shipped
 * `echo "burners killed"` — an unconditional success claim with no nameable
 * falsifying result. Prose did not prevent it. The cascadeable contract still
 * ships (`skills/30-claude-code-patterns/background-process-discipline.md`),
 * but it is documentation; THIS is the fence.
 *
 * THE DESIGN IS A COPY, NOT AN INVENTION. `worktree-forest.js` already solves
 * the identical shape — a resource that leaks, detected at a lifecycle
 * boundary, auto-reaped only when provably safe, with an age floor, per-item
 * KEEP verdicts carrying reasons, and a default-ON kill switch. Every structural
 * choice here is taken from it deliberately.
 *
 * PURE CORE, THIN COLLECTORS. Everything that decides is a pure function over a
 * SNAPSHOT BUNDLE (process table + per-pid open files). Nothing in the decision
 * path reads the live host, so the fixtures are fabricated process tables and
 * the tests never spawn a burner. A fixture coupled to live host state is the
 * defect loom#1650 recorded; this module is built so that coupling is not
 * expressible.
 *
 * FAIL-CLOSED ON MISSING EVIDENCE. ZERO-LOSS requires POSITIVE evidence of
 * inertness. Absent evidence — an unreadable process, open files that could not
 * be listed, an unparseable age — is a KEEP with that reason recorded, never a
 * reap. Absence of evidence is not evidence of absence, and the direction of
 * that default is the whole safety argument.
 *
 * AND IT APPLIES TO A PARTIAL ANSWER, NOT ONLY A MISSING ONE. Two shapes used to
 * slip past this paragraph while satisfying it on paper: a descriptor list that
 * was READ BUT CUT SHORT (a timed-out or overflowing `lsof`), and a descriptor
 * list lsof could not enumerate at all (a `NOFD` record). Both arrived looking
 * like a measurement — the first as a complete parse, the second as an empty list
 * — and both licensed a reap. The rule this module now enforces at both layers is
 * the one its own incident report taught: a MISSING answer must never be
 * spellable the same way as a complete one.
 */

"use strict";

const os = require("os");
const { execFileSync } = require("child_process");
const { readFileSync, existsSync } = require("fs");

/**
 * THE DEFAULT FILE READER — named, single-sourced, and reachable from a test.
 *
 * ⛔ IT IS NAMED BECAUSE THE UNNAMED FORM WAS A FREE VARIABLE. Both call sites wrote
 * `fs.readFileSync(...)` while this module binds only `{ readFileSync, existsSync }` from
 * `require("fs")` — there is no `fs` object in scope — so every call to the default reader
 * threw `ReferenceError: fs is not defined`. The throw landed inside a `catch` whose whole
 * job is to turn an unreadable file into a STATED UNKNOWN, so a defect in the READER was
 * reported as a fact about the FILE: "the file could not be read".
 *
 * MEASURED, not inferred: on linux `readCredentials()` returned
 * `{ok:false, reason:"/proc/self/status could not be read"}` while `/proc/<pid>/status`
 * read fine and carried `Uid:\t1000\t1000\t1000\t1000`, and the SAME function returned the
 * correct four-field reading the moment an explicit `readFile` was injected. The reader,
 * not the file.
 *
 * AND IT IS INVISIBLE ON darwin, which is why the case that would have caught it needs a
 * platform-neutral entry point rather than a re-run of an existing one: the darwin branch
 * of `readCredentials` spawns `ps` and never evaluates the default reader, and
 * `readProcUid`'s only production caller is the LINUX branch. The platform that never
 * executes the line is the platform that reports it healthy.
 */
function defaultFileReader(p) {
  return readFileSync(p, "utf8");
}

// ── verdicts ────────────────────────────────────────────────────────────────
//
// Two, not three. `worktree-forest.js` carries a middle TAG-FIRST verdict
// because a worktree can hold recoverable work that a tag would make durable.
// A process holds no such thing: it is either provably inert or it is somebody's.
const REAP = "ZERO-LOSS";
const KEEP = "KEEP";

// ── the orphan predicate ────────────────────────────────────────────────────
//
// PPID 1 AND a command line carrying the harness's own shell-snapshot preamble.
// Every leaked burner had it, because the harness sources a per-session snapshot
// into every shell it launches:
//
//   /bin/zsh -c source /Users/<u>/.claude/accounts/<acct>/shell-snapshots/\
//   snapshot-zsh-1786079788126-lk45dk.sh 2>/dev/null || true && …
//
// MEASURED AT BOTH POLES on the incident host (2026-08-14, re-measured in the
// implementing session rather than inherited):
//   - leak state:  96 matches — exactly the leak set, 48 per worktree.
//   - clean state:  0 matches, against 8 live harness shells (all with real
//                   parents) out of 1,358 processes.
// A predicate returning 96 in the leak state and 0 in the clean state, while
// never matching a live shell, is the opposite-verdict capability
// `evidence-first-claims.md` MUST-5 requires before a check is trusted.
//
// HOST-PORTABLE, WHICH IS WHY IT CASCADES. `shell-snapshots/snapshot-<shell>-`
// is a CLAUDE CODE convention, not a loom one — it contains no repo name, no
// user name and no absolute prefix. The leak bit other projects, so a
// loom-only predicate would not have closed it.
//
// The shell name is a character class rather than a literal `zsh` because the
// harness picks the operator's login shell; 13 of 13 snapshot shells on the
// incident host were zsh, but a bash operator gets `snapshot-bash-`.
const HARNESS_SNAPSHOT_RE = /shell-snapshots\/snapshot-[a-z]+-/;

function isHarnessShell(command) {
  if (typeof command !== "string" || command === "") return false;
  return HARNESS_SNAPSHOT_RE.test(command);
}

/**
 * An orphan CANDIDATE — the cheap predicate that selects who gets examined.
 * Being a candidate is NOT a licence to reap: it only decides who pays for the
 * expensive inertness evidence below.
 */
function isOrphanCandidate(proc) {
  return !!proc && proc.ppid === 1 && isHarnessShell(proc.command);
}

// ── the knobs ───────────────────────────────────────────────────────────────

// Why 2 hours. The incident ran 22 hours, so any floor under a day would have
// caught it. The floor exists for the opposite error: a session that is ALIVE
// and mid-wave has shells whose parent has legitimately exited moments ago
// (a finished orchestrator whose children are still draining). Two hours is far
// longer than any such drain and far shorter than the 22-hour window that made
// this expensive.
//
// "NOT WAIVABLE TO 0" IS NOW ENFORCED RATHER THAN ASSERTED, and the correction is
// recorded rather than smoothed because the sentence above stood for months with
// NOTHING under it: the resolver took `{ min: 0 }`, so `COC_ORPHAN_MIN_AGE_HOURS=0`
// was an ACCEPTED value and the unattended SessionEnd reap ran with a floor that
// is not a floor — any candidate of any age was eligible. A comment cannot fail;
// `MIN_AGE_HOURS_FLOOR` and `resolveStrictFloor` can.
const DEFAULT_MIN_AGE_HOURS = 2;

// The smallest idle floor that still IS a floor. Below 1h the number stops
// expressing "wait for the drain to finish" and starts expressing "reap now": a
// live session mid-wave can leave a shell whose parent exited seconds ago, which
// is precisely the process the floor exists to hold out. The refusal is on the
// VALUE, never on the variable being set — an operator who wants a tighter floor
// than the default can still have one, at or above this bound.
const MIN_AGE_HOURS_FLOOR = 1;

// Why a CPU floor at all, and why it makes the reaper SAFER rather than weaker.
// E10's acceptance sentence is scoped to "orphaned CPU-BURNING descendants",
// and that scope is a gift: a detached process sitting at 0% CPU is the exact
// shape of something a human parked on purpose (a dev server, a tunnel, a
// watcher). Requiring a live CPU burn before reaping excludes that entire class
// on a signal that is cheap and unambiguous. 5% is well above the noise floor
// of an idle process and far below the 7–15% each leaked burner sustained.
const DEFAULT_MIN_CPU_PCT = 5;

// The smallest burn floor that still REQUIRES a burn, for the same reason the age
// floor has one. `COC_ORPHAN_MIN_CPU_PCT=0` makes `pcpu < 0` false for every
// process, so the KEEP that holds out the deliberately-detached class stops firing
// and E10's stated scope — "orphaned CPU-BURNING descendants" — degrades to "any
// old orphan". That is one knob over from the same defect, so it takes the same
// bound.
const MIN_CPU_PCT_FLOOR = 1;

// ── the kill switch ─────────────────────────────────────────────────────────
//
// `COC_ORPHAN_AUTOREAP` turns the unattended SessionEnd reap OFF. Readable from
// the shell AND from `.claude/settings.json::env`, so an operator has both
// affordances without a second mechanism.
//
// DEFAULT ON, and the fail-direction is deliberate — the reasoning is
// `worktree-forest.js`'s verbatim and it applies unchanged. Only an explicitly
// RECOGNISED off-token disables the reap; every other value, including a typo,
// leaves it ENABLED and is REPORTED via `source: "default-unrecognized"`. The
// inverse (unrecognised ⇒ off) is how a safety feature ships inert: a
// `COC_ORPHAN_AUTOREAP=flase` in someone's profile would silently restore the
// exact leak this closes, and nothing would ever say so.
const AUTOREAP_OFF_TOKENS = new Set(["0", "off", "false", "no", "disabled"]);
const AUTOREAP_ON_TOKENS = new Set(["1", "on", "true", "yes", "enabled"]);

function resolveAutoReap(env) {
  const raw = (env || process.env).COC_ORPHAN_AUTOREAP;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { enabled: true, source: "default", raw: null };
  }
  const v = String(raw).trim().toLowerCase();
  if (AUTOREAP_OFF_TOKENS.has(v))
    return { enabled: false, source: "env", raw: String(raw) };
  if (AUTOREAP_ON_TOKENS.has(v))
    return { enabled: true, source: "env", raw: String(raw) };
  return { enabled: true, source: "default-unrecognized", raw: String(raw) };
}

// ── the floor resolvers: STRICT, refusing rather than substituting ──────────
//
// WHAT THE PREVIOUS SHAPE GOT WRONG, measured on this module before the change.
// `resolveNumericFloor(…, { min: 0 })` CLAMPED and SUBSTITUTED, silently:
// `"0.5"` → 0.5 (accepted), `"-1"` → 2, `"abc"` → 2. The last two discard what an
// operator typed and say nothing, which is the FIRST defect — and `min: 0` made
// `"0"` a LEGAL value, which is the second and the dangerous one, because a floor
// of zero is not a floor. Raising `min` to 1 would have fixed the second and left
// the first: a value that is silently replaced is still a value the operator
// believes is in force. So the resolver REFUSES instead, and the caller decides
// what to do with a refusal — nothing here invents a number for an input it could
// not read.
//
// ONE validator, TWO consumers. `validateFloorValue` is the single place the
// accepted shape and the minimum are enforced; the env resolver below and the
// `--min-age-hours` / `--min-cpu-pct` flag paths in the reaper (`orphan-reap.mjs`,
// inside `parseArgs`) both route through it, so a shape this
// function accepts is accepted there and NOWHERE else. Two copies of this
// predicate would be two lists answering one question, which is the drift
// `security.md` § Enforcement-Surface Parity names. (The flag paths are named by
// the FUNCTION that holds them: the line range this used to cite had drifted ~30
// lines by the time it was checked.)

/**
 * The accepted shape of a floor value: a plain, unsigned decimal number.
 *
 * Deliberately NOT `Number(raw)`, which accepts far more than an operator means:
 * `Number("")` is 0, `Number("  ")` is 0, and `Number("0x10")`, `Number("1e3")`
 * and `Number("Infinity")` are all finite-or-not in ways nobody types on purpose.
 * A shape test is what makes "0" refusable by the floor check below rather than
 * quietly valid.
 */
const FLOOR_VALUE_RE = /^\d+(\.\d+)?$/;

/**
 * PURE. Validate ONE candidate floor value taken from TEXT.
 *
 * @returns {{ok: true, value: number} | {ok: false, reason: string}}
 *
 * It NEVER substitutes. A value that fails validation is REPORTED so the caller
 * can refuse; returning the default here would be the silent substitution this
 * function replaces, and there is no way for a reader to tell the two apart
 * afterwards.
 */
function validateFloorValue(text, { floor, label }) {
  const t = typeof text === "string" ? text.trim() : "";
  if (t === "")
    return {
      ok: false,
      reason: `${label} is empty — unset it, or give a number`,
    };
  // The EXAMPLES are derived from THIS floor, because a message that offers a
  // value the floor then refuses is an instruction the reader cannot follow: the
  // age floor (< 1 refused) used to be told 'such as "2" or "0.5"'.
  const example = floor <= 0.5 ? "0.5" : String(Math.ceil(Math.max(floor, 2)));
  if (!FLOOR_VALUE_RE.test(t)) {
    return {
      ok: false,
      reason: `${label} must be a plain decimal number such as "${example}", got ${JSON.stringify(text)}`,
    };
  }
  const n = Number(t);
  // OUT OF RANGE IS NOT A FLOOR. MEASURED before this check existed:
  // `validateFloorValue("1" + "0".repeat(309), {floor: 1})` returned
  // `{ok: true, value: Infinity}` — the shape test passes and the floor compare
  // cannot fail, because every comparison against Infinity is false. The old
  // `classifyOrphans` then read `!Number.isFinite(Infinity)` as "absent" and
  // SUBSTITUTED the 2h default, so an operator who typed an enormous floor got a
  // two-hour one and a report that printed `Infinityh` (and `null` in `--json`,
  // since JSON.stringify maps Infinity to null). Refused here, at the door.
  if (!Number.isFinite(n)) {
    return {
      ok: false,
      reason: `${label} is out of range — ${JSON.stringify(text)} overflows to a non-finite number`,
    };
  }
  if (n < floor) {
    return {
      ok: false,
      reason: `${label} must be at least ${floor}, got ${JSON.stringify(text)}`,
    };
  }
  return { ok: true, value: n };
}

/**
 * Resolve a floor from the environment, or REFUSE. Returns
 * `{ok: true, key, value, source, raw}` or `{ok: false, key, raw, reason}`.
 *
 * Unset / blank → the DOCUMENTED DEFAULT with `source: "default"`. That is the one
 * substitution that is not a substitution: nothing was typed, so nothing is
 * discarded. Any other input must pass `validateFloorValue`; on failure the caller
 * gets `ok: false` and MUST refuse to proceed. The two numbers a substituting
 * resolver could return instead are both wrong in a different direction — the
 * default hides the typo, and 0 disarms the floor — which is why there is no third
 * option here.
 */
function resolveStrictFloor(env, key, def, { floor }) {
  const raw = (env || process.env)[key];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { ok: true, key, value: def, source: "default", raw: null };
  }
  const v = validateFloorValue(String(raw), { floor, label: key });
  if (!v.ok) return { ok: false, key, raw: String(raw), reason: v.reason };
  return { ok: true, key, value: v.value, source: "env", raw: String(raw) };
}

// NAMED `…Strict` ON PURPOSE. A caller left on the old name would receive
// `{ok:true, value}` where it expected a number, and `Number.isFinite({…})` is
// false — so `classifyOrphans` would fall back to `DEFAULT_MIN_AGE_HOURS` and the
// stale call site would read as a working one, silently. Renaming makes that
// caller throw instead.
const resolveMinAgeHoursStrict = (env) =>
  resolveStrictFloor(env, "COC_ORPHAN_MIN_AGE_HOURS", DEFAULT_MIN_AGE_HOURS, {
    floor: MIN_AGE_HOURS_FLOOR,
  });
const resolveMinCpuPctStrict = (env) =>
  resolveStrictFloor(env, "COC_ORPHAN_MIN_CPU_PCT", DEFAULT_MIN_CPU_PCT, {
    floor: MIN_CPU_PCT_FLOOR,
  });

/**
 * PURE. Why must this pid NOT be signalled? Returns a reason string, or null when the
 * pid passes.
 *
 * INDEPENDENT OF ADMISSION, ON PURPOSE, and that is the whole point of a separate
 * predicate. Pid 1 and this process are excluded only IMPLICITLY by any admission
 * predicate — pid 1 fails the orphan predicate for unrelated reasons (its ppid is 0),
 * and `process.pid` could pass it the day someone's own shell is orphaned mid-sweep.
 * An implicit exclusion is ONE predicate edit away from gone; this one has to be
 * deleted deliberately.
 *
 * ONE PREDICATE FOR EVERY SIGNALLING SITE. Both callers — the orphan reaper and
 * `hook-dispatch-equivalence.mjs` — use THIS function, so a site cannot quietly keep
 * a weaker inline check; that is the whole reason it lives in the shared module.
 */
function signallablePidProblem(pid, selfPid) {
  if (!Number.isInteger(pid)) return `pid ${JSON.stringify(pid)} is not an integer`;
  if (pid <= 1) return `pid ${pid} is 1 or below (the kernel's init, or nonsense)`;
  if (pid === selfPid) return `pid ${pid} is THIS process — signalling it ends the reap mid-flight`;
  return null;
}

/**
 * PURE. Why must this process NOT reap as root? Returns a reason string, or null.
 *
 * WITHOUT AN FD-PINNED PID THERE IS NO SAFE REAP AS ROOT. The re-read → kill window
 * is the one hole a re-check cannot close: there is no `pidfd` on this platform, so
 * "the pid I checked" cannot be atomically bound to "the pid I signal", and as root
 * a lost race can signal ANY process on the host, including system ones. An
 * unattended reaper has no need for root: it only ever reaps harness shells owned by
 * the operator running it.
 *
 * ONE DEFINITION, TWO CALLERS — the reaper refuses `--apply` with this reason and the
 * SessionEnd guard refuses to SPAWN the reap with the same one. Two copies of a
 * refusal predicate in one tree is the parity defect `security.md` § Enforcement-
 * Surface Parity names, and the guard's copy is where a weaker check would hide.
 */
const EXIT_NOPERM = 77; // sysexits.h EX_NOPERM: refused for lack of privilege, distinct from usage
function rootRefusalReason(euid) {
  if (euid !== 0) return null;
  return ROOT_REFUSAL;
}
const ROOT_REFUSAL =
  "refusing to signal processes as root: without an fd-pinned pid (there is no pidfd here) a re-read→kill race can signal any process on the host, and an unattended reaper has no need for root — run it as the owner of the processes it reaps";

/**
 * PURE. Refuse when ANY credential is root, not only the effective uid.
 *
 * ROOT BY ANY ROUTE IS ROOT. A process can hold a NON-zero effective uid while its
 * SAVED or FS uid is 0 — a setuid binary that dropped privilege, or an fs-uid 0 used
 * for one operation — and the pid-reuse window the refusal exists for does not care
 * which of the family is 0. So every credential the platform reports is checked, and
 * on Linux `CapEff` is checked too: CAP_KILL (bit 5) is the capability that permits
 * signalling ANY process, which is the same power by a different name.
 *
 * AN UNREADABLE CREDENTIAL REFUSES. `cred.ok === false` means the read itself failed,
 * and "we could not tell whether we are root" is answered by not acting.
 *
 * A CREDENTIAL A PLATFORM CANNOT EXPRESS IS NOT UNREADABLE, and the distinction is
 * load-bearing rather than convenient: MEASURED on this host, macOS `ps` accepts `uid`,
 * `ruid` and `svuid` but has NO fs-uid keyword (`fsuid`, `sfsuid` and `suid` are all
 * rejected: "keyword not found"), so an fs uid there is `null` with a reason and is
 * NOT a refusal — treating it as one would refuse every reap on every Mac forever.
 */
function credentialsRefusalReason(cred) {
  if (!cred || cred.ok !== true) {
    return `refusing to signal: this process's own credentials could not be read (${(cred && cred.reason) || "no reading"}), so whether it is root is unknown`;
  }
  const named = [
    ["real uid", cred.real],
    ["effective uid", cred.effective],
    ["saved uid", cred.saved],
    ["fs uid", cred.fs],
  ];
  for (const [label, value] of named) {
    if (value === 0) return `${ROOT_REFUSAL} (its ${label} is 0)`;
  }
  if (Number.isInteger(cred.capEff) && (cred.capEff & (1 << 5)) !== 0) {
    return `${ROOT_REFUSAL} (its CapEff carries CAP_KILL, bit 5)`;
  }
  return null;
}

/**
 * THIN COLLECTOR. This process's own credentials, from the platform's own sources.
 *
 * darwin: real and effective from node; SAVED from `ps -o svuid=` (MEASURED: the
 * keyword exists and returns the numeric saved uid); fs uid NOT REPORTED by this
 * platform's ps, recorded as null WITH the reason so it cannot be mistaken for a read
 * that failed. linux: all four from /proc/self/status, plus CapEff from the same file.
 * Anything else: unreadable, which refuses.
 */
function readCredentials(opts = {}) {
  const platform = opts.platform || process.platform;
  const run = opts.run || execFileSync;
  const read = opts.readFile || defaultFileReader;
  // ⛔ AN ABSENT `getuid`/`geteuid` IS A STATED REFUSAL, NOT A THROW. Windows exposes
  // neither, and calling through an undefined property raised a TypeError out of a
  // function whose entire contract is to REPORT what it could not read: a caller asking
  // "are we root?" got an exception instead of the answer "unknown", and
  // `credentialsRefusalReason` exists precisely so that unknown REFUSES. A throw here
  // escapes a signalling site's guard rather than closing it.
  //
  // AN EXPLICIT `null` MEANS "THIS PLATFORM HAS NO SUCH FUNCTION". The pole cannot
  // delete a method from `process`, so the seam carries the ABSENCE rather than a value,
  // and the check is on the function rather than on truthiness — `opts.getuid ?
  // opts.getuid() : process.getuid()` could not express this case at all.
  const uidFn = "getuid" in opts ? opts.getuid : process.getuid;
  const euidFn = "geteuid" in opts ? opts.geteuid : process.geteuid;
  if (typeof uidFn !== "function" || typeof euidFn !== "function") {
    return {
      ok: false,
      reason:
        "this platform exposes no getuid/geteuid, so this process's own uids cannot be read (win32)",
    };
  }
  const real = uidFn();
  const effective = euidFn();
  if (platform === "linux") {
    const uid = readProcUid(opts.selfPid || process.pid, { readFile: read });
    if (!uid) return { ok: false, reason: "/proc/self/status could not be read" };
    let capEff = null;
    try {
      const text = read("/proc/self/status");
      const m = /^CapEff:\s*([0-9a-fA-F]+)\s*$/m.exec(String(text));
      if (m) capEff = Number.parseInt(m[1], 16);
    } catch {
      return { ok: false, reason: "/proc/self/status CapEff could not be read" };
    }
    return { ok: true, platform, real: uid.real, effective: uid.effective, saved: uid.saved, fs: uid.fs, capEff };
  }
  if (platform === "darwin") {
    const tool = resolveTrustedTool("ps", opts);
    if (!tool) return { ok: false, reason: "no trusted ps to read the saved uid" };
    let out;
    try {
      out = run(tool, ["-o", "svuid=", "-p", String(opts.selfPid || process.pid)], {
        encoding: "utf8",
        timeout: opts.timeoutMs || PS_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
        env: TOOL_ENV,
      });
    } catch (e) {
      return { ok: false, reason: `the saved uid could not be read (${(e && e.code) || "ps failed"})` };
    }
    const saved = Number(String(out).trim());
    if (!Number.isInteger(saved)) {
      return { ok: false, reason: `the saved uid did not parse (${JSON.stringify(String(out).trim().slice(0, 40))})` };
    }
    return {
      ok: true,
      platform,
      real,
      effective,
      saved,
      fs: null,
      fsReason: "this platform's ps reports no fs-uid keyword (measured: fsuid/sfsuid/suid are all rejected)",
      capEff: null,
    };
  }
  return { ok: false, reason: `no credential source for platform ${JSON.stringify(platform)}` };
}

// ── ps parsing ──────────────────────────────────────────────────────────────

/**
 * Parse BSD `ps` elapsed time into seconds.
 *
 * MEASURED, NOT ASSUMED: macOS `ps` REJECTS the `etimes` keyword that GNU ps
 * provides ("ps: etimes: keyword not found" — the error lists the valid set,
 * which contains `etime` and not `etimes`). So the age floor must parse the
 * FORMATTED BSD field. Observed formats on the incident host:
 *   `00:00`         mm:ss           (a just-spawned process)
 *   `22:10:33`      hh:mm:ss
 *   `06-22:59:39`   dd-hh:mm:ss     (launchd, i.e. host uptime)
 *
 * Returns null — never 0 — for anything unparseable. A 0 here would read as
 * "brand new" and hold a genuine orphan out of the reap, which is the safe
 * direction, but null is honest and the caller records it as a KEEP reason.
 */
function parseEtime(s) {
  if (typeof s !== "string") return null;
  const t = s.trim();
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(t);
  if (!m) return null;
  const [, dd, hh, mm, ss] = m;
  const d = dd ? Number(dd) : 0;
  const h = hh ? Number(hh) : 0;
  const secs = d * 86400 + h * 3600 + Number(mm) * 60 + Number(ss);
  return Number.isFinite(secs) ? secs : null;
}

/**
 * Parse the output of the census's `ps` invocation — SEE `censusProcesses` FOR THE
 * FIELD LIST, which is the one copy in this tree and is not restated here (a second
 * enumeration in a comment is a claim that rots the next time the list changes).
 *
 * The command field is last and unquoted precisely because it contains spaces;
 * the fixed-width numerics are taken from the front and the remainder is
 * whatever follows, verbatim. ⚠ THAT REMAINDER IS NOT ALWAYS THE WHOLE COMMAND: a
 * field asked for AFTER `uid=` arrives as its PREFIX, which is why the census splits
 * its state column off in `withKernelState` rather than here — this parser cannot tell a
 * column the request added from a command that happens to contain a space, and guessing
 * would corrupt every caller whose text has no such column. A row whose leading fields
 * do not parse is
 * DROPPED rather than guessed at — a half-read row could otherwise become a reap
 * target with a mis-attributed pid.
 */
function parsePsTable(stdout, opts = {}) {
  if (typeof stdout !== "string") return [];
  // Rows parsed from text a caller supplied are NOT provably this process's own
  // measurement, so the default is the UNTRUSTED provenance: "unknown" makes
  // `reap()` demand an injected kill before it acts on them. Only the census, which
  // spawned the real trusted tool, stamps "live".
  const provenance = opts.provenance || "unknown";
  const rows = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    // THE FIELD LIST IS NOT RESTATED HERE. It lives in `censusProcesses`, and the copy
    // that used to sit on this line — "FIVE fields then the command, because the census
    // asks for `uid` too" — ROTTED the moment a sixth column was added to that request,
    // which is the same second-copy failure as a duplicated field list. What this parser
    // needs from the list is only that `uid` is the LAST of its fixed fields, so the
    // remainder is where the command starts. MEASURED on darwin: `uid` prints NUMERIC — 0
    // for root, 501 for this operator, 306/266/213 for system services — so the column is
    // populated and discriminating. The uid is parsed DIGITS-ONLY and anything else
    // becomes null, which the classifier reads as "cannot confirm ownership" ⇒ KEEP,
    // never as an absent gate.
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const etimeSec = parseEtime(m[3]);
    const pcpu = Number(m[4]);
    const uidToken = m[5];
    const command = m[6];
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    rows.push({
      pid,
      ppid,
      etimeSec,
      pcpu: Number.isFinite(pcpu) ? pcpu : null,
      uid: /^\d+$/.test(uidToken) ? Number(uidToken) : null,
      provenance,
      command,
    });
  }
  return rows;
}

// ── open-file parsing ───────────────────────────────────────────────────────

/**
 * Parse `lsof -p <pids> -Fpftn` field output into { pid: [{fd,type,name}] }.
 *
 * lsof field output is a stream of one-letter-tagged lines; `p` opens a new
 * process block and `f` opens a new file block within it.
 */
function parseLsof(stdout) {
  const out = {};
  if (typeof stdout !== "string") return out;
  let pid = null;
  let cur = null;
  const flush = () => {
    if (pid !== null && cur && cur.fd !== undefined) out[pid].push(cur);
    cur = null;
  };
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === "p") {
      flush();
      pid = Number(val);
      if (!Number.isInteger(pid)) {
        pid = null;
        continue;
      }
      if (!out[pid]) out[pid] = [];
    } else if (tag === "f") {
      flush();
      cur = { fd: val, type: null, name: null };
    } else if (tag === "t" && cur) {
      // A REPEATED field line inside ONE fd record means the record is AMBIGUOUS: the
      // field stream cannot say which of the two values belongs to the descriptor, so
      // the record is marked rather than last-write-wins-ed. MEASURED on this host:
      // real lsof -FpftnP -n emits NO repeated t/n for any process, so this rule costs
      // nothing here and exists for the shapes it has not seen.
      if (cur.type !== null) cur.ambiguous = true;
      cur.type = val;
    } else if (tag === "n" && cur) {
      if (cur.name !== null) cur.ambiguous = true;
      cur.name = val;
    }
  }
  flush();
  return out;
}

// WHICH OPEN FILES MEAN "SOMEBODY WANTS THIS ALIVE" — THREE-VALUED, and UNKNOWN IS KEEP.
//
// THE DEFECT THIS SHAPE CLOSES, stated sharply: a boolean here cannot tell "read
// and found nothing" from "could not read", and on this path that difference is
// REAP vs KEEP. `lsof` reports a process whose descriptor table it cannot
// enumerate with a pseudo-descriptor of `NOFD` (and `unknown`); the old predicate
// required a NUMERIC fd and returned `false` for anything else, so an UNREADABLE
// table came out as "holds nothing" and the pid cleared the gate that exists to
// hold it out. That is not a wrong answer — it is a MISSING answer wearing the
// grammar of a complete one, which is the same shape the floor resolver had when
// it substituted a value instead of refusing.
//
// MEASURED AT THREE POLES, because the obvious instrument does not discriminate.
// A raw count of non-standard descriptors returns 4 for a bare busy-loop
// subshell AND 4 for a process holding a listening socket — identical, so a
// count is a non-discriminating instrument in this rule's own sense and is NOT
// used. What separates them is the descriptor's TYPE and NUMBER:
//
//   burner subshell   f0 CHR /dev/null, f1/f2 REG (task output), f10 CHR /dev/null
//   listening socket  f0,f1,f2, and f3 IPv4                       ← a resource
//   open regular file f0,f1,f2, and f9 REG /tmp/…                 ← a resource
//
// So a HELD RESOURCE is a NUMERIC descriptor at 3 or above that is not simply
// pointing at a character device. The NON-NUMERIC pseudo-descriptors are the
// platform's business and are resolved from a MEASURED allowlist below — an
// earlier version of THIS comment named `cwd` / `txt` / `mem` / `rtd` from
// reasoning rather than measurement, and two of those four do not occur on the
// platform it was written on while a third that does was missing from it.
//
// /dev/null and tty character devices at fd ≥ 3 are benign: zsh dups its script
// descriptor to fd 10 on /dev/null, which every harness shell carries and which
// signifies nothing about intent.

// ── the descriptor verdict: held / not-held / UNKNOWN, in ONE place ─────────
//
// ONE predicate for ONE question, so both consumers inherit the same answer.
// Two call sites answering "does this pid hold a resource" with different shapes
// is the parity defect `security.md` § Enforcement-Surface Parity names, and it
// is how this gate came to have a hole in the first place.

const DESCRIPTOR_HELD = "held";
const DESCRIPTOR_NOT_HELD = "not-held";
const DESCRIPTOR_UNKNOWN = "unknown";

// The benign pseudo-descriptors, as a POSITIVE ALLOWLIST (`cc-artifacts.md`
// Rule 10), PER PLATFORM, each from its own measurement: they are mappings or
// working directories, every process carries them, and they hold nothing.
// Enumerating what IS benign means every other non-numeric token falls through to
// UNKNOWN rather than to "holds nothing".
//
// MEASURED — one read-only `lsof -F pf -n -P -w` over every process, 2026-09-29,
// nothing signalled. Each set carries its own provenance because the two barely
// overlap and a reader must be able to tell which host a value came from:
//
//   darwin — macOS 26.6.2, lsof revision 4.91, over all processes:
//     txt (18,412 records / 860 pids) · cwd (860 / 860) · twd (3 / 3).
//     Control on the same run: 13,774 NUMERIC fd records, so the filter is
//     selecting and not discarding. NOFD, rtd, mem and DEL do NOT occur.
//   linux — Linux 7.0.0-34-generic, lsof 4.95.0 (/usr/bin/lsof), same command
//     over all processes, on the SAMPLED HOST — whose hostname is deliberately
//     NOT recorded here: a hostname is an operator-identifying token, and this
//     file rides `.claude/hooks/lib/**` to EVERY consumer, where
//     `scan-synced-disclosure` flags it (SHAPE:operator-identity-token) and the
//     Gate-2 driver then refuses the whole sync at its fail-closed disclosure
//     gate. PROVENANCE IS THE OS, THE LSOF REVISION AND THE COUNTS — not which
//     machine produced them. Re-adding a hostname here re-opens #252; the
//     operator-local companion carries the identity (#255/#260 pattern).
//     mem (1,607 / 30) · txt (89 / 30) · rtd (89 / 30) · cwd (89 / 30) · DEL (9 / 1).
//     twd and NOFD do NOT occur.
//
// `mem` AND `rtd` ARE ON EVERY SAMPLED LINUX PID (30 of 30). That is the whole
// reason a single darwin-shaped set is not a smaller answer but a broken one: on
// Linux those two tokens would read UNKNOWN, every candidate would be KEEP, and the
// descriptor gate would reap NOTHING — fleet-wide, and looking exactly like a clean
// run. The dead-gate advisory makes that VISIBLE; only the per-platform set makes it
// WORK.
//
// `DEL` IS THE ONE TOKEN IN EITHER SET THAT IS NOT PLAINLY A MAPPING OR A DIRECTORY.
// lsof associates it with a file whose directory entry is gone, and it was supplied
// by the reviewer's measurement (9 records / 1 pid) rather than re-derived here, so
// it is allowlisted ON THAT MEASUREMENT while the question stays open: if a later
// sweep shows `DEL` carrying a held descriptor on Linux, it moves to UNKNOWN and
// this comment is the place that says so.
//
// WHY THEY STAY APART RATHER THAN UNIONED. `twd` is darwin-only; `mem`, `rtd` and
// `DEL` are linux-only. A union would allowlist `mem` on darwin, where it never
// occurs — which costs nothing TODAY and hides exactly the drift the next
// measurement exists to catch. And the drift is not hypothetical: a single set
// built from the old comment (`cwd/rtd/txt/mem`) omitted `twd` and `DEL`, which
// made their 3 + 1 real carriers un-reapable — a silent loss of function, in a
// patch whose whole purpose was closing silent failures.
//
// AN UNMEASURED PLATFORM GETS AN EMPTY SET, deliberately. Every pseudo-descriptor
// then reads UNKNOWN ⇒ KEEP, reaping is effectively disabled on that host, and the
// report SAYS so out loud (see `descriptorGateAdvisoryLine`). Fail-closed plus
// loud is the only honest answer to "this host has never been measured".
const BENIGN_PSEUDO_FDS_BY_PLATFORM = Object.freeze({
  darwin: Object.freeze(["txt", "cwd", "twd"]),
  linux: Object.freeze(["mem", "txt", "rtd", "cwd", "DEL"]),
});

/**
 * PURE. The uid fields from /proc/<pid>/status, or null when unreadable.
 *
 * THE CROSS-CHECK THAT MAKES A LINUX UID WORTH READING. On Linux the same fact is
 * available from a second, independent source, so the census's uid is verified
 * against the kernel's own file rather than trusted on its own. Disagreement OR an
 * unreadable file is UNKNOWN ⇒ KEEP — the same direction as every other unreadable
 * evidence here. The fields are real/effective/saved/fs, in that order.
 */
function readProcUid(pid, opts = {}) {
  const read = opts.readFile || defaultFileReader;
  try {
    const text = read(`/proc/${pid}/status`);
    const m = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(String(text));
    if (!m) return null;
    return { real: Number(m[1]), effective: Number(m[2]), saved: Number(m[3]), fs: Number(m[4]) };
  } catch {
    return null;
  }
}

/** PURE. The measured benign set for a PLATFORM ARGUMENT; empty when unmeasured. */
function benignPseudoFds(platform) {
  const p = platform || process.platform;
  const measured = BENIGN_PSEUDO_FDS_BY_PLATFORM[p];
  return new Set(measured || []);
}

// FAIL-CLOSED DEFAULT: a caller that passes no set gets an EMPTY one, so its
// evidence reads UNKNOWN rather than benign. The mistake direction is the safe one.
const NO_BENIGN_FDS = new Set();

/**
 * PURE. ONE descriptor record → one of three verdicts.
 *
 * `DESCRIPTOR_UNKNOWN` is returned for anything this function cannot read: a
 * malformed record, a non-numeric fd token outside the benign allowlist. It is
 * deliberately NOT folded into `DESCRIPTOR_NOT_HELD` — that fold is the defect.
 *
 * THE TOKEN `NOFD` IS lsof's documented FD-column value for "this process's
 * descriptors could not be enumerated", and it is the shape this predicate exists
 * to catch. MEASURED HONESTLY, WITH ITS BOUND: I could not PRODUCE one on this
 * host. `lsof -p 1 -FpftnP -n` as a non-root user returns rc=0 with an EMPTY
 * stream — macOS's shape for an unexaminable process is silence, not a partial
 * block — and silence lands on the absent-key fate, which is already KEEP. So the
 * NOFD arm is grounded in lsof's OWN vocabulary rather than in a live capture
 * here, and the allowlist below is deliberately written so that the TOKEN IS NOT
 * THE POINT: any non-numeric fd falls through to UNKNOWN, whether it is `NOFD`,
 * `unknown`, `DEL`, or a spelling lsof has not invented yet.
 */
function descriptorRecordVerdict(f, benign = NO_BENIGN_FDS) {
  if (!f || typeof f.fd !== "string") return DESCRIPTOR_UNKNOWN;
  // AN AMBIGUOUS RECORD IS NOT A MEASUREMENT. Two values for one descriptor means the
  // reader cannot say what it holds, and "cannot say" is UNKNOWN, never not-held.
  if (f.ambiguous === true) return DESCRIPTOR_UNKNOWN;
  if (benign.has(f.fd)) return DESCRIPTOR_NOT_HELD;
  if (!/^\d+$/.test(f.fd)) return DESCRIPTOR_UNKNOWN; // NOFD, unknown, DEL, …
  if (Number(f.fd) < 3) return DESCRIPTOR_NOT_HELD; // stdin/stdout/stderr
  if (f.type === "CHR") return DESCRIPTOR_NOT_HELD; // /dev/null, ttys — benign
  return DESCRIPTOR_HELD;
}

/**
 * PURE. ONE pid's descriptor records → `{held, unknown}`.
 *
 * THE CONTRACT, and it is the only licence to reap on this axis: a pid's
 * descriptor evidence is CLEAR **iff `held` AND `unknown` are BOTH empty**. There
 * is no third field restating that, on purpose — a `verdict` summary computed
 * alongside the lists would be a second representation of one answer, and the
 * two would eventually disagree (the parity defect this module already paid for
 * once).
 *
 * `benign` is the platform's MEASURED pseudo-fd set, passed in rather than read
 * from the host here: that keeps this function pure, and it is what lets one
 * machine exercise BOTH platforms' sets (`classifyOrphans` takes a `platform`).
 */
function descriptorVerdict(records, benign = NO_BENIGN_FDS) {
  if (!Array.isArray(records)) {
    return { held: [], unknown: ["<records are not a list>"] };
  }
  const held = [];
  const unknown = [];
  for (const f of records) {
    const v = descriptorRecordVerdict(f, benign);
    if (v === DESCRIPTOR_HELD) held.push(f);
    else if (v === DESCRIPTOR_UNKNOWN) {
      unknown.push(f && typeof f.fd === "string" ? f.fd : String(f && f.fd));
    }
  }
  return { held, unknown };
}

/**
 * PURE. The advisory line for a run the descriptor gate could not judge.
 *
 * WHY THIS EXISTS, and it is the load-bearing half of a MEASURED allowlist. Keyed
 * to two dated measurements, the allowlist is a snapshot of two hosts' `lsof`; a
 * later `lsof` that introduces a new pseudo-fd kind would silently disable reaping
 * on every host that emits it, with the KEEPs looking exactly like a clean run.
 * The advisory is the only thing that would say so. It names the count AND the
 * unrecognised kinds, because "some descriptors were unreadable" and "reaping is
 * off on this host" are different facts and the operator needs the second one.
 */
function descriptorGateAdvisoryLine(counts) {
  if (!descriptorGateWasDead(counts)) return null;
  const kinds = (counts.descriptor_unknown_kinds || []).join(", ") || "none recorded";
  return (
    `State that the descriptor gate kept ALL ${counts.candidates} of ${counts.candidates} eligible candidate(s) as UNKNOWN ` +
    `(unrecognised fd kinds: ${kinds}) — reaping is effectively DISABLED on this host until the allowlist covers them. ` +
    "Say the counts are real and the reaping is not."
  );
}

// ── classification (PURE) ───────────────────────────────────────────────────

/**
 * Classify a snapshot bundle. PURE — no host reads, no clock, no subprocess.
 *
 * @param {object} bundle
 * @param {Array}  bundle.processes  parsed `ps` rows (the WHOLE table; child
 *                                   detection needs every row, not just the
 *                                   candidates)
 * @param {object|null} bundle.openFiles  { pid: [{fd,type,name}] } for the
 *                                   candidates. `null` means the collector did
 *                                   not run; an ABSENT pid key inside a present
 *                                   object means lsof ran and returned nothing
 *                                   for it. Those are different facts and are
 *                                   treated differently below.
 * @param {number} bundle.minAgeHours
 * @param {number} bundle.minCpuPct
 *
 * @returns {{records: Array, counts: {candidates:number, zero_loss:number, keep:number}}}
 *
 * EVERY KEEP REASON IS RECORDED, not just the first. An operator reading the
 * report needs to know all of what is holding a process, because fixing one
 * reason and re-running only to hit the next is the loop that makes people
 * switch a gate off.
 */
function classifyOrphans(bundle) {
  const processes = Array.isArray(bundle && bundle.processes)
    ? bundle.processes
    : [];
  const openFiles = bundle && bundle.openFiles;
  // A PROVIDED BUT UNUSABLE FLOOR IS REFUSED, NOT REPLACED — the module's own
  // promise, at its second site. "Absent" (undefined / null → the documented
  // default) and "provided but not a finite number" (Infinity out of an overflow,
  // NaN, a string) are DIFFERENT FACTS, and the previous single
  // `Number.isFinite(…) ? … : DEFAULT` test collapsed them, so an enormous floor
  // silently became the 2h default. Both are now their own refusal, and every
  // candidate is KEEP with that reason first.
  const ageProvided = !!(bundle && bundle.minAgeHours !== undefined && bundle.minAgeHours !== null);
  const cpuProvided = !!(bundle && bundle.minCpuPct !== undefined && bundle.minCpuPct !== null);
  const ageFloorUnusable = ageProvided && !Number.isFinite(bundle.minAgeHours);
  const cpuFloorUnusable = cpuProvided && !Number.isFinite(bundle.minCpuPct);
  const minAgeHours = ageProvided && !ageFloorUnusable ? bundle.minAgeHours : DEFAULT_MIN_AGE_HOURS;
  const minCpuPct = cpuProvided && !cpuFloorUnusable ? bundle.minCpuPct : DEFAULT_MIN_CPU_PCT;

  // THE OWNERSHIP GATE. `selfUid` is the caller's own effective uid, passed in
  // rather than read here, because this function is PURE — the same reason the
  // platform's benign-fd set is a parameter. `Number.isInteger` is the arming test:
  // a caller that forgets it does NOT get a gate that silently passes everything,
  // it gets one that KEEPs everything and says the gate is not armed.
  const selfUid = bundle && bundle.selfUid;
  const ownershipGateArmed = Number.isInteger(selfUid);
  // THE SECOND SOURCE FOR THE SAME FACT, on the platform that has one. `procUid` maps
  // pid → the uid fields from /proc/<pid>/status (or null when that file could not be
  // read); `procUidRequired` says whether the platform is one where the cross-check
  // applies. It is a map plus a flag rather than an absence convention because "this
  // platform does not have the file" and "this pid's file was unreadable" must not
  // collapse — the first is not a refusal, the second is.
  const procUid = (bundle && bundle.procUid) || null;
  const procUidRequired = !!(bundle && bundle.procUidRequired);

  // A FLOOR BELOW ITS DECLARED MINIMUM MAKES EVERY CANDIDATE KEEP, whoever
  // supplied it. The reaper and the guard both refuse such a value outright, and
  // this is the defence-in-depth sibling that does not depend on them: this
  // function is PURE with its own callers, so a resolver bypassed — or a future
  // caller that computes a floor itself — must not be able to turn a disarmed
  // floor into a ZERO-LOSS verdict. Both floors are checked, because both are
  // load-bearing: the age floor holds out a live session's draining shells and
  // the CPU floor holds out the deliberately-detached class.
  const ageFloorDisarmed =
    Number.isFinite(minAgeHours) && minAgeHours < MIN_AGE_HOURS_FLOOR;
  const cpuFloorDisarmed =
    Number.isFinite(minCpuPct) && minCpuPct < MIN_CPU_PCT_FLOOR;

  // Children are derived from the table itself — no extra syscall, and it stays
  // pure. A process with living children is never inert: killing the parent
  // orphans the children, which is the very failure being closed.
  const parents = new Set();
  for (const p of processes) parents.add(p.ppid);

  const records = [];
  // Counted, not inferred later from the reason strings: a report that keyed on
  // prose would be a lexical read of its own output (`probe-driven-verification.md`
  // MUST-1), and the count is what says whether the descriptor gate participated.
  let descriptorUnknown = 0;
  // The DISTINCT unrecognised fd kinds, capped: the advisory names them so an
  // operator can tell "lsof changed its vocabulary" from "something is odd about
  // one process", and a cap keeps a hostile or unusual token from bloating the
  // report. Sorted, so the line is stable run to run.
  const unknownKinds = new Set();
  // The PLATFORM's measured benign set. `bundle.platform` is injectable so ONE
  // machine can exercise both measured sets — the pure core decides, and the
  // caller says which host's vocabulary it is holding.
  const benign = benignPseudoFds(bundle && bundle.platform);
  for (const p of processes) {
    if (!isOrphanCandidate(p)) continue;

    const reasons = [];
    // OWNERSHIP FIRST — it is the one gate that disqualifies a process outright, and
    // it is the gate whose ABSENCE is least visible: a process belonging to another
    // user has every other property of a leaked burner (PPID 1, harness snapshot
    // preamble, CPU burn, no children, no descriptors), so without this the reaper's
    // every other signal says REAP about somebody else's process.
    //
    // FAIL-CLOSED IN BOTH DIRECTIONS, and both are tested: an ARM-able gate that is
    // absent (no `selfUid` in the bundle) KEEPs everything and says the gate is not
    // armed, and a row whose uid could not be parsed KEEPs and says so. Neither
    // collapses into "no gate, carry on" — that would be the silent-no-op default
    // `security.md` § Secure-Default forbids for exactly this shape.
    if (!ownershipGateArmed) {
      reasons.push(
        "OWNERSHIP GATE NOT ARMED — no own-uid was supplied, so no process's ownership can be confirmed, and every candidate is KEEP",
      );
    } else if (procUidRequired) {
      // THE CENSUS uid IS VERIFIED AGAINST THE KERNEL's OWN FILE before it is trusted.
      // A disagreement means one of the two sources is lying and there is no way to
      // tell which, so the pid is not a reaping candidate; an unreadable file is the
      // same direction as every other unreadable evidence here.
      const kernel = procUid && Object.prototype.hasOwnProperty.call(procUid, p.pid) ? procUid[p.pid] : undefined;
      if (kernel === undefined) {
        reasons.push("the kernel uid table was not collected for this pid — ownership UNVERIFIED");
      } else if (!kernel || !Number.isInteger(kernel.effective)) {
        reasons.push("/proc/<pid>/status was unreadable — ownership UNVERIFIED");
      } else if (kernel.effective !== p.uid) {
        reasons.push(
          `census uid ${p.uid} DISAGREES with the kernel's ${kernel.effective} — one of the two is wrong and the pid is not a candidate until that is resolved`,
        );
      }
    } else if (p.uid === null || p.uid === undefined) {
      reasons.push(
        "process uid unparseable — cannot confirm it belongs to us",
      );
    } else if (p.uid !== selfUid) {
      reasons.push(
        `owned by uid ${p.uid}, not ours (${selfUid}) — another user's process is never a reap target`,
      );
    }
    // FIRST, so the headline reason on every record is the one the operator has
    // to act on. A disarmed floor is not a property of any single process, and
    // reporting it per-record at the END would bury it under four per-process
    // reasons across 48 records.
    if (ageFloorUnusable) {
      reasons.push(
        "idle floor is NOT a finite number — refused rather than replaced by the default, so every candidate is KEEP",
      );
    } else if (ageFloorDisarmed) {
      reasons.push(
        `idle floor below the ${MIN_AGE_HOURS_FLOOR}h minimum — a floor that is not a floor holds NOTHING out, so every candidate is KEEP`,
      );
    }
    if (cpuFloorUnusable) {
      reasons.push(
        "burn floor is NOT a finite number — refused rather than replaced by the default, so every candidate is KEEP",
      );
    } else if (cpuFloorDisarmed) {
      reasons.push(
        `burn floor below the ${MIN_CPU_PCT_FLOOR}% minimum — the CPU-burn requirement is disarmed, so every candidate is KEEP`,
      );
    }

    const ageHours =
      p.etimeSec === null || p.etimeSec === undefined
        ? null
        : p.etimeSec / 3600;

    if (ageHours === null) {
      reasons.push(
        "elapsed time unparseable — age UNKNOWN, cannot clear the idle floor",
      );
    } else if (ageHours < minAgeHours) {
      reasons.push(`age ${ageHours.toFixed(1)}h < floor ${minAgeHours}h`);
    }

    if (parents.has(p.pid)) {
      reasons.push("has living child processes — killing it would orphan them");
    }

    if (p.pcpu === null) {
      reasons.push("CPU% unreadable — cannot confirm it is a live burner");
    } else if (p.pcpu < minCpuPct) {
      // NOT a burner. This is the deliberately-detached class — a dev server, a
      // tunnel, a watcher someone parked. E10 is scoped to CPU-burning orphans
      // and this is where that scope is enforced.
      reasons.push(
        `CPU ${p.pcpu.toFixed(1)}% < burn floor ${minCpuPct}% — idle, so not the CPU-burner class (may be deliberately detached)`,
      );
    }

    if (!openFiles || typeof openFiles !== "object") {
      // The collector did not run at all. FAIL-CLOSED: no inertness evidence
      // means no reap, however burner-shaped the process looks.
      reasons.push(
        "open files not collected — no positive evidence of inertness",
      );
    } else if (!Object.prototype.hasOwnProperty.call(openFiles, p.pid)) {
      // `hasOwnProperty`, not a truthiness check: an empty array is a REAL
      // measurement ("holds nothing") and must not read the same as an absent
      // key ("never measured"). Conflating them is exactly the non-discriminating
      // read this whole program exists to eliminate.
      reasons.push(
        "open files unreadable for this pid — no positive evidence of inertness",
      );
    } else if (openFiles[p.pid] === OPEN_FILES_UNREADABLE) {
      // The collector RAN and was CUT OFF. An unread answer, not an empty one —
      // and the only reason this fate is distinct from the absent-key fate above
      // is that the read was truncated AFTER this pid's block began.
      descriptorUnknown += 1;
      reasons.push(
        "open files UNREADABLE for this pid — the lsof read was cut short, so a descriptor may exist beyond the cut",
      );
    } else {
      const d = descriptorVerdict(openFiles[p.pid], benign);
      if (d.held.length) {
        const shown = d.held
          .slice(0, 3)
          .map((f) => `fd ${f.fd} ${f.type}${f.name ? ` ${f.name}` : ""}`)
          .join(", ");
        reasons.push(
          `holds ${d.held.length} open resource(s) — ${shown}${d.held.length > 3 ? ", …" : ""}`,
        );
      }
      if (d.unknown.length) {
        // THE HOLE THIS CLOSES. A `NOFD` record means lsof could not enumerate
        // this process's descriptors, so the list is UNKNOWN, not empty — and an
        // unknown list must never read as "holds nothing".
        descriptorUnknown += 1;
        for (const fd of d.unknown) {
          if (unknownKinds.size < 8) unknownKinds.add(fd);
        }
        const shown = d.unknown.slice(0, 3).join(", ");
        reasons.push(
          `descriptor(s) UNREADABLE (${shown}${d.unknown.length > 3 ? ", …" : ""}) — cannot tell what this pid holds, so no positive evidence of inertness`,
        );
      }
    }

    records.push({
      pid: p.pid,
      ppid: p.ppid,
      ageHours,
      // CARRIED FOR THE PRE-KILL RE-CHECK. The census-time owner is evidence only
      // until the kill (see `.claude/bin/orphan-reap.mjs::ownershipDrift`).
      uid: p.uid === undefined ? null : p.uid,
      // CARRIED FOR THE PRE-KILL IDENTITY CHECK. `ageHours` is rounded for
      // display; the kill path needs the raw seconds so it can prove the process
      // it is about to signal is the one that was classified (see
      // `.claude/bin/orphan-reap.mjs::identityDrift`).
      etimeSec: p.etimeSec === undefined ? null : p.etimeSec,
      pcpu: p.pcpu,
      command: p.command,
      verdict: reasons.length ? KEEP : REAP,
      reasons: reasons.length
        ? reasons
        : [
            `orphaned ${ageHours.toFixed(1)}h, burning ${p.pcpu.toFixed(1)}% CPU, no children, no open resources`,
          ],
    });
  }

  records.sort((a, b) => a.pid - b.pid);
  return {
    records,
    counts: {
      candidates: records.length,
      zero_loss: records.filter((r) => r.verdict === REAP).length,
      keep: records.filter((r) => r.verdict === KEEP).length,
      // HOW MANY CANDIDATES THE DESCRIPTOR GATE COULD NOT JUDGE. Carried so a
      // report can say the gate did not participate, instead of leaving a reader
      // to read its silence as coverage (`instrument-discipline.md` MUST-3): a
      // run where every candidate's descriptor list was UNREADABLE produces the
      // same KEEPs as a run where the gate worked and found nothing, and the two
      // mean opposite things.
      descriptor_unknown: descriptorUnknown,
      descriptor_unknown_kinds: [...unknownKinds].sort(),
      // WHICH PLATFORM'S VOCABULARY WAS APPLIED, so a reader can tell a measured
      // allowlist from an empty one: `benign_pseudo_fds` is the set actually used,
      // and an EMPTY list here means this host has no measurement and reaping is
      // disabled on it (see `descriptorGateAdvisoryLine`).
      platform: (bundle && bundle.platform) || process.platform,
      benign_pseudo_fds: [...benign].sort(),
    },
  };
}

/** PURE. Did the descriptor gate fail to judge ANY candidate it was asked about? */
function descriptorGateWasDead(counts) {
  return (
    !!counts &&
    counts.candidates > 0 &&
    counts.descriptor_unknown === counts.candidates
  );
}

// ── collectors (impure, deliberately thin) ──────────────────────────────────

// SUBPROCESS BUDGETS. `ps -axo` on the incident host enumerated 1,358 processes
// in well under a second; 3s is a hang ceiling, not a cost. The lsof call is
// scoped to the CANDIDATE pids only — measured 0.048s for one pid — and in the
// overwhelmingly common case there are ZERO candidates, so it is never spawned
// at all. That is the same cheap-short-circuit shape `worktree-forest.js` uses.
const PS_TIMEOUT_MS = 3000;
const LSOF_TIMEOUT_MS = 5000;

// ── TRUSTED TOOL RESOLUTION ─────────────────────────────────────────────────
//
// THE GATE NEEDS AN UNTAINTED INSTRUMENT. A uid read from a `ps` the caller's PATH
// resolves gates NOTHING: the same user can put a `ps` earlier on their own PATH that
// prints any uid it likes, so a same-user shim would make the ownership gate read as
// armed while returning whatever the shim chose. So `ps` and `lsof` are resolved by
// ABSOLUTE PATH within this fixed list — never the caller's PATH — and spawned with a
// FIXED environment (`LC_ALL=C`/`LANG=C` because a locale changes `ps` output shape),
// which also drops any `PS_*` / `CMD_ENV` the caller had set.
//
// MEASURED on this host: `ps` resolves to /bin/ps, `lsof` to /usr/sbin/lsof, `sysctl`
// to /usr/sbin/sysctl.
//
// `sysctl` IS DELIBERATELY NOT RESOLVED THIS WAY, and that is a stated verdict rather
// than an omission: it feeds ONLY the advisory swap line, which gates no signal, so a
// hostile same-user `sysctl` can at worst silence a warning — the same exposure every
// other tool this corpus spawns has, and one this repo answers with trust-posture
// rather than per-tool absolute paths. The kill gates (`ps` for the census and the
// uid, `lsof` for the descriptor evidence) are the ones resolved here.
const TRUSTED_PATH = "/usr/sbin:/usr/bin:/sbin:/bin";
const TOOL_ENV = Object.freeze({ PATH: TRUSTED_PATH, LC_ALL: "C", LANG: "C" });

/**
 * PURE. The absolute path of `name` inside the TRUSTED path list, or null.
 *
 * The name is shape-checked first (`^[a-z][a-z0-9_-]*$`) so a caller cannot smuggle a
 * path, a flag or a shell metacharacter into the join, and the search NEVER consults
 * the process's own PATH.
 */
function resolveTrustedTool(name, opts = {}) {
  const exists = opts.exists || ((p) => existsSync(p));
  if (typeof name !== "string" || !/^[a-z][a-z0-9_-]*$/.test(name)) return null;
  for (const dir of TRUSTED_PATH.split(":")) {
    const candidate = `${dir}/${name}`;
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // an unreadable dir is skipped, not fatal: the next one may resolve
    }
  }
  return null;
}

/**
 * Read the process table. Returns parsed rows, or null when ps could not be
 * consulted. NULL IS NOT AN EMPTY TABLE — callers must treat it as "unmeasured"
 * and must not report "0 orphans" from it.
 *
 * ⚠ THE FIELD LIST LIVES HERE AND NOWHERE ELSE, and `stat=` is in it because the
 * kernel STATE is the one liveness signal a process cannot forge: its command line is
 * its own to choose, so any reader that decides "is this process dead?" from argv text
 * can be answered with an argument. The harness runner's descendant walk reads its
 * census from HERE for that reason — it used to carry its own copy of this list, which
 * is a second string free to drift from this one (`security.md` § Enforcement-Surface
 * Parity), and it was deleted when this column moved in.
 *
 * THE COLUMN IS SPLIT OFF IN `withKernelState`, immediately below, so `command` keeps
 * meaning "the command line" for every existing reader.
 */
function censusProcesses(opts = {}) {
  const run = opts.exec || execFileSync;
  // AN INJECTED EXEC IS A SEAM: its rows are NOT this process's own measurement, and
  // they are stamped so `reap()` refuses to act on them with a real kill.
  const provenance = opts.exec ? "injected" : "live";
  const tool = resolveTrustedTool("ps", opts);
  if (!tool) return null; // no trusted ps ⇒ UNMEASURED, never "no orphans"
  let out;
  try {
    out = run(tool, ["-axo", "pid=,ppid=,etime=,pcpu=,uid=,stat=,command="], {
      encoding: "utf8",
      timeout: opts.timeoutMs || PS_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
      env: TOOL_ENV,
    });
  } catch {
    return null;
  }
  if (typeof out !== "string") return null;
  return withKernelState(parsePsTable(out, { provenance }));
}

/**
 * PURE. Split the census's KERNEL-STATE column off the remainder `parsePsTable`
 * returns, and hand back the same rows. The column is named, never counted by position:
 * `censusProcesses` owns where it sits, and a comment that said "sixth" would rot the
 * moment a column is added before it.
 *
 * WHY A SPLIT IS NEEDED AT ALL: `parsePsTable` reads its fixed leading fields and takes
 * the REST of the line as `command`, which is the only
 * shape that works for a field containing spaces. A field added after `uid=` therefore
 * arrives as a PREFIX of `command` — `"Z    <defunct>"` — and this is the one place that
 * knows the column is there. The state is a single non-empty word on every platform, so
 * the cut at the first space is unambiguous.
 *
 * ⚠ AND THE PADDING AFTER THAT CUT IS STRIPPED, which is a CORRECTION rather than a
 * tidy-up: the first version of this helper kept it, on the reasoning that ps's spacing
 * was stable across censuses. It is stable per row and NOT across a state-length change,
 * and keeping it broke an adjacent guard outright. Both consequences are measured at the
 * strip itself, below.
 *
 * ⚠ IT ASSUMES THE TEXT ANSWERS THE REQUEST, and the failure mode is worth stating
 * because it is silent: a text MISSING that column — a fixture fabricating a table
 * instead of running `ps` — puts the whole command line in `state` and leaves `command`
 * EMPTY. A fixture that injects `exec` must therefore model the columns the census asks
 * for, or it is describing a `ps` that ignored the request.
 */
function withKernelState(rows) {
  for (const r of rows) {
    const cut = r.command.indexOf(" ");
    r.state = cut === -1 ? r.command : r.command.slice(0, cut);
    // ⛔ LEADING WHITESPACE IS ps's COLUMN PADDING, NOT PART OF THE COMMAND, and leaving
    // it on is not cosmetic — it was, and it broke two things at once:
    //   (a) AN EXACT-COMMAND EXCLUSION STOPS MATCHING. The descendant walk skips the
    //       census's own `ps` row by comparing `command` to the tool path; a padded
    //       command equals neither the path nor `path + " "`, so the row the exclusion
    //       exists for sails straight through it.
    //   (b) THE IDENTITY COMPARISON BECOMES A FUNCTION OF THE STATE FIELD'S LENGTH.
    //       MEASURED on this host: `ps` sizes the stat column to a FIXED width, so the
    //       gap it leaves plus the state's length is 5 on EVERY row (1-char states ⇒
    //       gap 4 over 598 rows, 2-char ⇒ gap 3 over 586, 3-char ⇒ gap 2). The padding
    //       this line strips is therefore `4 - (stateLength - 1)` spaces — it CHANGES
    //       when the state's length changes, and one process can do that between two
    //       censuses (a sleeping `S` that starts running as `Ss`, or the reverse). Two
    //       censuses of the SAME process would then differ by whitespace and be refused
    //       as "a DIFFERENT process", which stops the walk from killing a live
    //       descendant and reports it as a survivor instead.
    r.command = (cut === -1 ? "" : r.command.slice(cut + 1)).replace(/^\s+/, "");
  }
  return rows;
}

/**
 * The READ-WAS-CUT-OFF marker, for ONE pid. A fourth fate alongside the three the
 * classifier already distinguished, and it exists because the collector could
 * previously express only two:
 *
 *   absent key       — lsof was never consulted for this pid, or said nothing
 *   `[]`             — MEASURED, and it holds nothing      ← the ONLY reap licence
 *   records          — measured, and these are what it holds
 *   THIS SENTINEL    — the read was truncated mid-stream, so the list is UNKNOWN
 *
 * The defect it closes: a truncated read produced a parsed map whose cut pid
 * looked exactly like a measured-inert one, and that pid then cleared the gate
 * that exists to hold it out.
 */
const OPEN_FILES_UNREADABLE = Symbol("orphan-forest.open-files-unreadable");

/**
 * PURE. Was this exec failure a COMPLETE answer, or a FRAGMENT of one?
 *
 * MEASURED on this host (Node v25.9.0), not assumed from documentation — the
 * five shapes a `lsof` spawn can fail with, and what each carries:
 *
 *   exit 1      status=1     signal=null      stdout COMPLETE  ← the control
 *   ETIMEDOUT   status=null  signal=SIGTERM   stdout FRAGMENT
 *   ENOBUFS     status=null  signal=SIGTERM   stdout FRAGMENT (65536 B in the probe)
 *   SIGKILL     status=null  signal=SIGKILL   stdout FRAGMENT
 *   ENOENT      status=null  signal=null      stdout absent
 *
 * So the discriminator is the EXIT STATUS, and `stdout` being present says
 * nothing: four of the five arms carry a usable-looking string, which is exactly
 * why the old catch arm read every one of them as an answer. A plain non-zero
 * exit is the ONE case where the child finished writing before it reported
 * failure — `lsof` exits 1 when a pid vanished between the ps snapshot and this
 * call, and its output is then complete and valid for the pids that remain.
 *
 * The status is also required to be BELOW 128, because 128+N is how a shell
 * encodes a signal death: a child that died from a signal was interrupted, and
 * its output is a fragment however the status is spelled.
 */
function readWasComplete(e) {
  if (!e) return false;
  if (e.signal) return false;
  return Number.isInteger(e.status) && e.status > 0 && e.status < 128;
}

/**
 * PURE. The pid whose block is at RISK of being cut, read off the RAW TEXT.
 *
 * WHY THE RAW TEXT AND NOT THE PARSED MAP: JS objects order integer-like keys
 * ASCENDING NUMERICALLY, so the parsed map's key order has nothing to do with
 * lsof's write order, and "the last one" cannot be recovered from it.
 *
 * WHY ONLY ONE BLOCK IS AT RISK: a pipe's accumulated bytes are a PREFIX of what
 * the child wrote. Every block before the cut is therefore complete and its
 * evidence is usable as-is; only the block the cut lands inside can be missing
 * descriptors. A cut landing exactly ON a block boundary marks one pid
 * unnecessarily — one extra KEEP, which is the safe direction, and the honest
 * cost of not being able to see where the cut fell.
 *
 * A partial `p` line at the very end (`p900` cut from `p9000`) becomes the last
 * match here and is a PHANTOM: it is not among the requested pids, so marking it
 * unreadable is inert, and its real counterpart never appeared in the stream and
 * so keeps the absent-key fate. Both directions stay fail-closed.
 */
function lastProcessBlockPid(stdout) {
  if (typeof stdout !== "string") return null;
  let last = null;
  for (const line of stdout.split("\n")) {
    if (line[0] !== "p") continue;
    const rest = line.slice(1);
    if (!/^\d+$/.test(rest)) continue;
    last = Number(rest);
  }
  return last;
}

/**
 * Collect open files for the given pids. Returns a map, or null when lsof could
 * not be consulted at all — which the classifier reads as "no evidence" and
 * therefore KEEP, never as "holds nothing". A pid whose block was cut off maps to
 * `OPEN_FILES_UNREADABLE`, which is a THIRD fate and is also KEEP.
 *
 * lsof exits non-zero when SOME pid has vanished between the ps snapshot and
 * this call, which is routine on a churning host; its stdout is still valid for
 * the pids that remain, so a non-zero exit with usable output is honoured rather
 * than discarded — and that arm is the control that keeps this fix from
 * over-correcting into "never trust any lsof output".
 */
function collectOpenFiles(pids, opts = {}) {
  if (!Array.isArray(pids) || pids.length === 0) return {};
  const run = opts.exec || execFileSync;
  const tool = resolveTrustedTool("lsof", opts);
  if (!tool) return null; // no trusted lsof ⇒ UNMEASURED, never "holds nothing"
  const args = ["-p", pids.join(","), "-FpftnP", "-n"];
  let out;
  let complete = true;
  try {
    out = run(tool, args, {
      encoding: "utf8",
      timeout: opts.timeoutMs || LSOF_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
      // LC_ALL=C so the field stream is locale-invariant, per the discipline above.
      env: TOOL_ENV,
    });
  } catch (e) {
    // The ONLY change from the previous arm: whether `e.stdout` is an ANSWER or a
    // FRAGMENT is now decided by the failure, not by the string being present.
    complete = readWasComplete(e);
    out = e && typeof e.stdout === "string" ? e.stdout : null;
    if (out === null) return null;
  }
  if (typeof out !== "string") return null;
  const parsed = parseLsof(out);
  if (complete) return parsed;
  const atRisk = lastProcessBlockPid(out);
  if (!Number.isInteger(atRisk)) {
    // Not even one pid header survived the cut: nothing was read, and the
    // requested pids keep the absent-key fate (KEEP).
    return {};
  }
  return { ...parsed, [atRisk]: OPEN_FILES_UNREADABLE };
}

/**
 * One-line host health. `os.loadavg()` is a libuv call — microseconds, no
 * subprocess — so this is free enough to run at every session start.
 *
 * A boundary reaper structurally CANNOT see a leak that is live right now; the
 * 22-hour invisibility is what made the incident expensive rather than the leak
 * itself. This is the half that closes that.
 */
function hostLoad() {
  try {
    const [one, five, fifteen] = os.loadavg();
    const cpus = os.cpus()?.length || null;
    if (!Number.isFinite(one)) return null;
    return { one, five, fifteen, cpus };
  } catch {
    return null;
  }
}

/**
 * Host MEMORY health — the axis `hostLoad()` structurally cannot see.
 *
 * THE GAP, measured. On 2026-09-09 this host sat at load 44.7 (2.8x cores)
 * while swap was 96% EXHAUSTED — 32,545 MB used of 33,792 MB, 1.2 GB left,
 * ~45 GB resident in the compressor. Every lane that ran a broad suite
 * disclosed the load figure correctly. The swap figure appeared in NO report
 * anywhere, because nothing under `.claude/hooks/` or `.claude/bin/` measured
 * memory at all: a grep for `memory_pressure|vm_stat|swapusage|freemem|memsize`
 * returned 0 files against 2 for the load tokens, and the control fired on the
 * load tokens, so that 0 is a true negative rather than a broken matcher.
 *
 * WHY IT MATTERS THAT IT IS A SEPARATE AXIS. Load measures RUNNABLE-QUEUE
 * depth: it says work is SLOW. Swap exhaustion says the kernel is out of places
 * to put pages, and it is what KILLS a process — it killed a watcher mid-gate
 * on the host above. The two are independent: this host was NOT short of RAM
 * (128 GB, load a survivable 2.8x) and was one page-out from an OOM kill. A
 * contention control keyed on load alone reports the survivable axis and stays
 * silent on the fatal one, which is why an unexplained mid-gate process death
 * had no corroborating figure in any report.
 *
 * WHY NOT `os.freemem()`. It is a libuv call and free, and on macOS it is
 * NON-DISCRIMINATING: measured on this 128 GB host it returned 0.32 GB free
 * (0.25%) while the machine was serving work normally, because macOS holds
 * everything it can in cache and in the compressor. It reads the same on a
 * healthy Mac as on a dying one, so no value it could return would falsify
 * "the host is fine" — `instrument-discipline.md` MUST-1. It is deliberately
 * NOT used here, and that is the whole reason this needs a sysctl at all.
 *
 * `kern.memorystatus_level` is deliberately NOT collected: this repo has no
 * authority for its units or direction, and MUST-4 fixes a field's semantics at
 * its PRODUCER, not at the reader's convenience. Reporting a number we cannot
 * interpret would be the wrong-question instrument that clause exists to bar.
 *
 * COST, measured, because this runs at every session start: the single
 * three-key `sysctl` spawn has a median wall time of 2.1 ms over 10 runs
 * (min 1.9, max 3.0) on the host above. `hostLoad()`'s `os.loadavg()` is ~0.4 us.
 * 2 ms at a lifecycle boundary is affordable; a per-tool-call fence would not be,
 * and this is deliberately not registered on one.
 *
 * PURE CORE, THIN COLLECTOR — the module's existing contract. Every parser
 * below is a pure function over TEXT, so the fixtures are captured command
 * output and the tests never read the live host. Only `hostMemory()` touches
 * the machine.
 */

const SYSCTL_TIMEOUT_MS = 1000;

/** Byte multipliers for the suffix macOS prints in `vm.swapusage`. */
const SWAP_UNIT = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/**
 * PURE. Parses the value of macOS `vm.swapusage`, e.g.
 * `total = 33792.00M  used = 32545.56M  free = 1246.44M  (encrypted)`.
 * Returns bytes, or null if any of the three fields is missing — a partial
 * swap reading is not a swap reading, and a missing `used` must never be
 * defaulted to 0 (that is the fail-OPEN direction: it would read an exhausted
 * host as an idle one).
 */
function parseSwapusage(value) {
  if (typeof value !== "string") return null;
  const found = {};
  const re = /\b(total|used|free)\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGT])?/gi;
  let m;
  while ((m = re.exec(value)) !== null) {
    const mult = SWAP_UNIT[(m[3] || "").toUpperCase()];
    if (mult === undefined) return null;
    found[m[1].toLowerCase()] = Math.round(parseFloat(m[2]) * mult);
  }
  if (!Number.isFinite(found.total) || !Number.isFinite(found.used))
    return null;
  return {
    swapTotalBytes: found.total,
    swapUsedBytes: found.used,
    swapFreeBytes: Number.isFinite(found.free)
      ? found.free
      : found.total - found.used,
  };
}

/**
 * PURE. Parses LABELED `sysctl` output (`key: value` per line). The labeled
 * form is used rather than `sysctl -n` on purpose: when a key is absent —
 * `vm.compressor_bytes_used` does not exist on every macOS/arch — sysctl writes
 * `unknown oid` to STDERR, exits 1, and still prints the keys that DID resolve.
 * A positional `-n` parse would silently shift every remaining field up one row.
 * Measured, both branches, on this host.
 */
function parseSysctlMemory(text) {
  if (typeof text !== "string") return null;
  const kv = new Map();
  for (const line of text.split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const swap = parseSwapusage(kv.get("vm.swapusage"));
  if (!swap) return null;
  const totalBytes = Number(kv.get("hw.memsize"));
  const compressor = Number(kv.get("vm.compressor_bytes_used"));
  return {
    ...swap,
    totalBytes:
      Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : null,
    compressorBytes:
      Number.isFinite(compressor) && compressor >= 0 ? compressor : null,
  };
}

/**
 * PURE. Parses Linux `/proc/meminfo`. Values are kB by kernel contract.
 * `SwapTotal: 0` is a REAL reading (swap disabled), not a missing one, and
 * `deriveMemory` turns it into a null RATIO rather than a 0% "healthy" — a
 * host with no swap cannot be scored on swap exhaustion at all.
 */
function parseMeminfo(text) {
  if (typeof text !== "string") return null;
  const kb = new Map();
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z_()]+):\s+([0-9]+)\s*kB/.exec(line.trim());
    if (m) kb.set(m[1], Number(m[2]) * 1024);
  }
  const swapTotal = kb.get("SwapTotal");
  const swapFree = kb.get("SwapFree");
  if (!Number.isFinite(swapTotal) || !Number.isFinite(swapFree)) return null;
  return {
    swapTotalBytes: swapTotal,
    swapFreeBytes: swapFree,
    swapUsedBytes: swapTotal - swapFree,
    totalBytes: Number.isFinite(kb.get("MemTotal")) ? kb.get("MemTotal") : null,
    availableBytes: Number.isFinite(kb.get("MemAvailable"))
      ? kb.get("MemAvailable")
      : null,
    compressorBytes: null,
  };
}

/**
 * PURE. Adds the derived ratio. Returns null rather than a ratio when there is
 * no swap configured: 0/0 is not 0% used, it is UNMEASURABLE on this axis, and
 * `memoryIsNotable` must not read an unmeasurable host as a healthy one.
 */
function deriveMemory(raw) {
  if (
    !raw ||
    !Number.isFinite(raw.swapTotalBytes) ||
    !Number.isFinite(raw.swapUsedBytes)
  ) {
    return null;
  }
  const ratio =
    raw.swapTotalBytes > 0 ? raw.swapUsedBytes / raw.swapTotalBytes : null;
  return { ...raw, swapUsedRatio: ratio };
}

/**
 * THIN COLLECTOR. One spawn on darwin, one file read on linux, null elsewhere.
 * Non-zero exit is NOT fatal: sysctl exits 1 on an unknown oid while still
 * printing the resolved keys, so stdout is parsed from the thrown error too.
 */
function hostMemory(opts = {}) {
  const platform = opts.platform || process.platform;
  try {
    if (platform === "darwin") {
      let out;
      try {
        out = (opts.run || execFileSync)(
          "sysctl",
          ["hw.memsize", "vm.swapusage", "vm.compressor_bytes_used"],
          {
            encoding: "utf8",
            timeout: opts.timeoutMs || SYSCTL_TIMEOUT_MS,
            stdio: ["ignore", "pipe", "ignore"],
          },
        );
      } catch (e) {
        out = e && typeof e.stdout === "string" ? e.stdout : null;
      }
      return typeof out === "string"
        ? deriveMemory(parseSysctlMemory(out))
        : null;
    }
    if (platform === "linux") {
      const text = (
        opts.readMeminfo || (() => readFileSync("/proc/meminfo", "utf8"))
      )();
      return deriveMemory(parseMeminfo(text));
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Is swap exhausted enough to be worth a line? Expressed as a RATIO so it means
 * the same thing on a 2 GB swap file and a 33 GB one.
 *
 * THE FLOOR IS EVIDENCE-SET, not conventional. At 0.963 the host above killed a
 * watcher process mid-gate with 1.2 GB of swap left. 0.85 is the same condition
 * with headroom to still act — roughly 5 GB on that host's swap. It gates on
 * the ratio ALONE: an absolute free-bytes floor was considered and rejected,
 * because macOS grows the swap file lazily, so an idle Mac with a small swap
 * would sit permanently under any fixed byte floor and the line would become
 * noise the operator learns to skip.
 */
const SWAP_USED_FLOOR = 0.85;

function memoryIsNotable(mem) {
  if (!mem || !Number.isFinite(mem.swapUsedRatio)) return false;
  return mem.swapUsedRatio >= SWAP_USED_FLOOR;
}

/** PURE. Bytes to a short human string. GiB base, matching what sysctl reports. */
function formatBytes(n) {
  if (!Number.isFinite(n)) return "?";
  const gib = n / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(1)} GB`;
  return `${(n / 1024 ** 2).toFixed(0)} MB`;
}

/** PURE. The memory half of the one-line host health, or null when unmeasured. */
function memoryHealthLine(mem) {
  if (!mem || !Number.isFinite(mem.swapUsedRatio)) return null;
  const pct = (mem.swapUsedRatio * 100).toFixed(0);
  const parts = [
    `swap ${pct}% (${formatBytes(mem.swapUsedBytes)} of ${formatBytes(mem.swapTotalBytes)}, ${formatBytes(mem.swapFreeBytes)} free)`,
  ];
  if (Number.isFinite(mem.compressorBytes)) {
    parts.push(`compressor ${formatBytes(mem.compressorBytes)}`);
  }
  return parts.join(", ");
}

// ── reporting ───────────────────────────────────────────────────────────────

/**
 * Is the host load high enough to be worth a line? Expressed as a MULTIPLE of
 * core count so it means the same thing on a 4-core laptop and a 16-core
 * workstation. 2.0 is the conventional "meaningfully oversubscribed" mark; the
 * incident sat at roughly 36x.
 */
const LOAD_RATIO_FLOOR = 2.0;

function loadIsNotable(load) {
  if (!load || !Number.isFinite(load.one) || !load.cpus) return false;
  return load.one / load.cpus >= LOAD_RATIO_FLOOR;
}

function hostHealthLine(load, counts, mem) {
  const parts = [];
  if (load && Number.isFinite(load.one)) {
    const ratio = load.cpus
      ? ` (${(load.one / load.cpus).toFixed(1)}x ${load.cpus} cores)`
      : "";
    parts.push(`load ${load.one.toFixed(2)}${ratio}`);
  }
  const memLine = memoryHealthLine(mem);
  if (memLine) parts.push(memLine);
  if (counts) {
    parts.push(
      `${counts.candidates} orphaned harness shell(s): ${counts.zero_loss} reapable, ${counts.keep} KEEP`,
    );
  }
  return parts.length ? parts.join(" · ") : null;
}

/**
 * PURE. The HOST-HEALTH lines alone — load and swap — with NO census claim.
 *
 * WHY THEY ARE THEIR OWN FUNCTION. These two axes are independent of the orphan
 * census and of the floors: they are read from the host, not from the process
 * table. They used to exist only inside `reportLines`, whose FIRST line asserts
 * how many orphans were found — so a caller that had not run the census could not
 * emit the health report without also asserting a count it never measured. The
 * floor-refusal path in the guard is exactly that caller, and it was silencing the
 * swap-exhaustion warning as a side effect of refusing a bad floor (MEASURED: with
 * an exhausted-swap host, an unset floor produced the swap line and a refused
 * floor produced no health line at all). One source, two callers.
 */
function hostHealthReportLines(load, mem) {
  const lines = [];
  if (load) {
    lines.push(
      `State the host load: ${load.one.toFixed(2)} over ${load.cpus || "?"} cores.`,
    );
  }
  if (memoryIsNotable(mem)) {
    // Swap exhaustion KILLS; load only slows. This line exists because on
    // 2026-09-09 a watcher died mid-gate at 96% swap and no report on the host
    // carried the figure — the lanes disclosed load 2.8x and nothing else.
    lines.push(
      `State that host SWAP is ${(mem.swapUsedRatio * 100).toFixed(0)}% exhausted (${formatBytes(mem.swapFreeBytes)} free of ${formatBytes(mem.swapTotalBytes)})` +
        `${Number.isFinite(mem.compressorBytes) ? `, with ${formatBytes(mem.compressorBytes)} held in the compressor` : ""}` +
        `. This is the axis that KILLS a process rather than slowing it: treat any process that died without a diagnosable cause as a candidate OOM kill, and do not start another broad suite until it drains.`,
    );
  }
  return lines;
}

function reportLines(finding) {
  const lines = [];
  const { counts, records } = finding;
  lines.push(
    `State that ${counts.candidates} orphaned harness shell(s) were found (PPID 1, carrying the Claude Code shell-snapshot signature): ${counts.zero_loss} classified ZERO-LOSS, ${counts.keep} KEEP.`,
  );
  for (const r of records.slice(0, 8)) {
    lines.push(
      `Report pid ${r.pid} — ${r.verdict}: ${r.reasons.join("; ")}${r.command ? ` [${r.command.slice(0, 80)}]` : ""}`,
    );
  }
  if (records.length > 8) {
    lines.push(
      `Report that ${records.length - 8} further orphan(s) were omitted from this list.`,
    );
  }
  lines.push(...hostHealthReportLines(finding.load, finding.mem));
  // THE DEAD-GATE LINE. A gate that judged nothing is indistinguishable, to a
  // reader, from a gate that judged everything and found nothing — so when the
  // descriptor axis returned UNKNOWN for every candidate, say that it did not
  // participate rather than letting its silence read as a clean result.
  const deadGate = descriptorGateAdvisoryLine(counts);
  if (deadGate) lines.push(deadGate);
  return lines;
}

function reapReportLines(finding) {
  const lines = [];
  lines.push(
    `State that an unattended reap ran at session end: ${finding.killed.length} orphaned CPU-burning shell(s) terminated, ${finding.counts.keep} KEEP left untouched.`,
  );
  if (finding.killed.length) {
    lines.push(`Report the terminated pids: ${finding.killed.join(", ")}.`);
  }
  if (finding.failed && finding.failed.length) {
    lines.push(
      `Report that ${finding.failed.length} pid(s) could NOT be terminated: ${finding.failed.map((f) => `${f.pid} (${f.reason})`).join(", ")}.`,
    );
  }
  // THE HEALTH AXIS BELONGS HERE TOO, measured absent before this: a successful
  // reap reported its pids and nothing about the host. Swap exhaustion is the axis
  // that KILLS rather than slows, and the reap is the one moment this tool is
  // signalling processes — so a reap report that omits it is the same silence the
  // refusal path was creating, on the path where the tool actually acts.
  lines.push(...hostHealthReportLines(finding.load, finding.mem));
  const deadGateReap = descriptorGateAdvisoryLine(finding.counts);
  if (deadGateReap) lines.push(deadGateReap);
  for (const r of finding.records
    .filter((r) => r.verdict === KEEP)
    .slice(0, 5)) {
    lines.push(`Report KEEP pid ${r.pid}: ${r.reasons.join("; ")}`);
  }
  return lines;
}

function summarize(finding) {
  if (finding.killed) {
    return `Reaped ${finding.killed.length} orphaned CPU-burning shell(s); ${finding.counts.keep} kept.`;
  }
  return `${finding.counts.candidates} orphaned harness shell(s): ${finding.counts.zero_loss} reapable, ${finding.counts.keep} kept.`;
}

module.exports = {
  REAP,
  KEEP,
  DEFAULT_MIN_AGE_HOURS,
  DEFAULT_MIN_CPU_PCT,
  MIN_AGE_HOURS_FLOOR,
  MIN_CPU_PCT_FLOOR,
  LOAD_RATIO_FLOOR,
  HARNESS_SNAPSHOT_RE,
  isHarnessShell,
  isOrphanCandidate,
  DESCRIPTOR_HELD,
  DESCRIPTOR_NOT_HELD,
  DESCRIPTOR_UNKNOWN,
  descriptorRecordVerdict,
  descriptorVerdict,
  OPEN_FILES_UNREADABLE,
  readWasComplete,
  lastProcessBlockPid,
  resolveAutoReap,
  validateFloorValue,
  resolveStrictFloor,
  resolveMinAgeHoursStrict,
  resolveMinCpuPctStrict,
  parseEtime,
  parsePsTable,
  parseLsof,
  classifyOrphans,
  descriptorGateWasDead,
  descriptorGateAdvisoryLine,
  BENIGN_PSEUDO_FDS_BY_PLATFORM,
  rootRefusalReason,
  credentialsRefusalReason,
  readCredentials,
  readProcUid,
  defaultFileReader,
  signallablePidProblem,
  resolveTrustedTool,
  TRUSTED_PATH,
  TOOL_ENV,
  EXIT_NOPERM,
  benignPseudoFds,
  censusProcesses,
  collectOpenFiles,
  hostLoad,
  loadIsNotable,
  hostHealthLine,
  hostHealthReportLines,
  SWAP_USED_FLOOR,
  parseSwapusage,
  parseSysctlMemory,
  parseMeminfo,
  deriveMemory,
  hostMemory,
  memoryIsNotable,
  memoryHealthLine,
  formatBytes,
  reportLines,
  reapReportLines,
  summarize,
};
