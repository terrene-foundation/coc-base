"use strict";
/*
 * landing-window-read.js — the READ HALF of the landing-window marker: schema,
 * location, resolution, and the ONE staleness classifier.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE WINDOW IS A FILE, AND WHY IT IS *THERE*
 * ─────────────────────────────────────────────────────────────────────────
 * T68. Three tracked-file edits voided or nearly voided an in-flight
 * `dev-preflight` in ONE day (2026-09-30), each by a different actor doing
 * something legitimate: a human commit, a HOOK (`todo-durable-guard` appending
 * to the tracked `burndown/events.jsonl`), and an agent editing the PRIMARY
 * mid-run. The common factor is not carelessness — it is that each actor was
 * inside a window that only the ORCHESTRATOR knew was open. The sharpest
 * instance: an agent checked the tree before starting, found it clean, and then
 * edited INSIDE A WINDOW THAT OPENED AFTER ITS CHECK. A check performed once
 * does not cover a window that opens later. Only the tree can say.
 *
 * So the window is written as a FILE, at
 *
 *     <git-common-dir>/land-lane/landing-window.json
 *
 * and the two properties that make that location the right one are both load
 * bearing:
 *
 *   1. `--git-common-dir` resolves to the SAME absolute path from the primary
 *      AND from every linked worktree (git's invariant: a linked worktree's
 *      `.git` is a FILE whose `gitdir:` target sits under the main checkout's
 *      `.git/worktrees/<id>`, and its `commondir` sidecar points back at the
 *      main `.git`). One marker is therefore visible to every tree without
 *      being copied into any of them — which is what lets a guard running IN A
 *      SIBLING still know the primary is busy.
 *   2. It is OUTSIDE every working tree. A marker inside the tree would dirty
 *      the very tree it exists to protect, and `dev-preflight` refuses a dirty
 *      tree — the guard would be the defect.
 *
 * The `land-lane/` subdirectory is not invented here: `land-lane.mjs` already
 * keeps its landing ledger at `<git-common-dir>/land-lane/landing-ledger.jsonl`
 * (see that file's § LANDING LEDGER), and the marker is the same class of
 * per-repo administrative state.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ONE CLASSIFIER, TWO CONSUMERS — why this module is CJS
 * ─────────────────────────────────────────────────────────────────────────
 * The writer is `.claude/bin/lib/landing-window.mjs` (ESM, because
 * `land-lane.mjs` is ESM); the reader is
 * `.claude/hooks/landing-window-guard.js` (CJS, because every hook under
 * `.claude/hooks/` is CJS). If each carried its own staleness predicate the
 * two would drift and the guard would enforce a rule the opener never wrote —
 * so the SCHEMA and the CLASSIFIER live here, once, and `.mjs` imports them
 * through `createRequire` (`rules/security.md` § Multi-Site Kwarg Plumbing:
 * dual halves of one contract must not be split across modules).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * STALENESS: the clause that stops the guard becoming the next outage
 * ─────────────────────────────────────────────────────────────────────────
 * "If the owner dies, the marker goes STALE after a bound — and a stale marker
 * is REPORTED, never silently honoured." A marker that outlives its owner and
 * keeps being honoured is the failure mode this clause exists to prevent; it is
 * the same shape as every "a control that cannot fail" finding in T66.
 *
 * A marker is STALE when EITHER:
 *   (a) TIME — `now - started_at` exceeds the bound. Always checked, and the
 *       only check available when the marker was written on another host.
 *   (b) DEATH — the marker names THIS host and a pid, and the PROCESS TABLE
 *       says that pid's owner is gone: no process holds the pid, or the one
 *       that does started at a different time than the owner the opener
 *       recorded (`owner.pid_start`), so the pid was reused. Read with `ps`,
 *       never with `process.kill`: the pid comes from a file any writer of the
 *       checkout can create, so even signal 0 would be a kill() aimed at a pid
 *       someone else chose — and an existence check cannot tell the owner from
 *       a later process holding its pid. See `processStartToken`.
 *       An owner whose identity CANNOT be verified — `ps` unavailable or
 *       failing, or a marker with no recorded start time — reads LIVE, until
 *       the time bound (fail-closed toward "the window is real"; the reason is
 *       at `classifyWindow`).
 *
 * The bound is a BACKSTOP, not the primary signal — a healthy `dev-preflight`
 * removes its own marker on exit, and the death check catches a kill long
 * before the bound expires.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

/** Marker filename, relative to the common git dir. */
const WINDOW_REL = path.join("land-lane", "landing-window.json");

/** Bumped on any incompatible change to the record shape below. */
const MARKER_SCHEMA = "landing-window/1";

/**
 * The stale bound. Deliberately GENEROUS: a false STALE honours a live window's
 * marker as advisory and lets a write through, which voids a run — expensive
 * but recoverable. A false LIVE puts a spurious notice in front of every lane
 * until someone investigates.
 * The bound is a backstop for a SIGKILLed owner, not a run-time budget; the
 * longest measured preflight leg is well inside it.
 */
const DEFAULT_STALE_BOUND_MS = 45 * 60 * 1000;

/**
 * The bound for a marker whose owner recorded NO pid — i.e. one for which the
 * death check is UNAVAILABLE and the time bound is the only instrument there is.
 *
 * SHORTER than `DEFAULT_STALE_BOUND_MS`, and the direction is deliberate. The
 * 45-minute default is justified as "a backstop for a SIGKILLed owner" because
 * the death check normally catches that case in seconds; where there is no pid
 * the backstop IS the instrument, so the bound it must be measured against is
 * the run's own length, not a crash's. 20 minutes matches the bound `land-lane`
 * already declares at its own call site. The trade is stated rather than hidden:
 * a pid-less window that outlives this bound reads STALE and stops being
 * honoured — the T68 harm, recoverable — while a longer bound buys a notice
 * nobody can retire without a human. MEASURED on this host: the CC host exports
 * `CLAUDE_PID` to tool children, so this arm is reachable only from a harness
 * that does not.
 */
const PIDLESS_STALE_BOUND_MS = 20 * 60 * 1000;

/**
 * Fields a record MUST carry as NON-EMPTY STRINGS to be classifiable at all.
 *
 * `owner` is deliberately NOT in this list. It is an OBJECT
 * (`{session_id, pid, host, display}`), and an earlier revision of this predicate
 * tested every required field with a string check — which made `owner` fail on
 * every record this module itself wrote, so a freshly opened window classified
 * MALFORMED and the guard reported malformed instead of reporting a live
 * window. MEASURED on the first smoke run, not reasoned: the guard emitted
 * `[HALT-AND-REPORT]` (marker-malformed) where the live-window arm was owed —
 * which in that revision rendered as `[BLOCK]`, the severity withdrawn below.
 * `owner` is validated structurally below.
 */
const REQUIRED_FIELDS = Object.freeze([
  "schema",
  "purpose",
  "head",
  "started_at",
]);

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

/**
 * The session identity AS THE OPENER SEES IT, from the ENVIRONMENT — never from
 * a parameter, so no caller can supply its own attribution.
 *
 * This is the WRITER's half of the identity contract, and it is env-only ON
 * PURPOSE: the opener is `dev-preflight` / `land-lane` running as a process, and
 * the value it stamps is the one a later Bash child of the same host will see.
 * The READER's half is `callerIdentity` below, which is deliberately NOT the
 * same function — see the ownership test's doc for why the two must not be
 * collapsed.
 *
 * `CLAUDE_CODE_SESSION_ID` FIRST. `state-io.js::resolveViolationSessionId`
 * documents that the environment a host-spawned hook receives carries
 * `CLAUDE_CODE_SESSION_ID` rather than the shorter name; the rung order is
 * copied from there so the two cannot drift. The shorter name stays as the
 * second rung so an operator or harness that sets it keeps working.
 *
 * ⛔ WHAT THIS FUNCTION DOES **NOT** CLAIM (corrected 2026-10-01, T68
 * remediation). An earlier header here asserted that "the host sets
 * `CLAUDE_CODE_SESSION_ID` from the same session id it puts in the payload, so
 * for a host-spawned hook the two agree" and derived the ownership test from
 * that equality. The claim is NOT established by the cited module —
 * `resolveViolationSessionId` is itself env-only and says nothing about the
 * payload — and MEASURED against a host that exports
 * `CLAUDE_CODE_CHILD_SESSION=1` to a dispatched subagent's tool children, the
 * env is INHERITED while the payload carries the calling session. A guard that
 * tested only the env therefore exempted every subagent dispatched by the window
 * owner, which is exactly the instance T68 exists to stop. The ownership test
 * now requires BOTH signals to agree — and that test (`sessionMatchesOwner`) was
 * itself DELETED once the deny-withdrawal removed every exemption: nothing decides
 * on identity any more, so the reader's identities are retained only to render
 * `your id` in the advisory. This function is the writer's stamp, not the
 * reader's verdict.
 */
function ownerIdentity(env) {
  const e = env || process.env;
  for (const raw of [e.CLAUDE_CODE_SESSION_ID, e.CLAUDE_SESSION_ID]) {
    if (typeof raw === "string" && raw.trim() !== "") return raw.slice(0, 128);
  }
  return null;
}

/**
 * The session identities a HOOK CALL presents — the READER's half of the
 * contract, and a DIFFERENT function from `ownerIdentity` because it answers a
 * different question over a different input.
 *
 * Two signals exist and they are produced by different mechanisms:
 *   - `payload.session_id` — the tool-event's own record of WHICH SESSION made
 *     the call. A dispatched subagent presents its own here.
 *   - `CLAUDE_CODE_SESSION_ID` — process env, INHERITED down the child-process
 *     tree, so a dispatched subagent presents its ORCHESTRATOR's here.
 *
 * Reading only the env made the owner test total: every identity that could
 * reach the comparison came from a variable the owner had already exported to
 * its children, so a dispatched lane was structurally indistinguishable from
 * the owner and passed. Reading only the payload would invert the error and
 * exempt a host that does not populate it. Both are returned, and the verdict
 * is the CONFLUENCE below.
 */
function callerIdentity(payload, env) {
  const p = payload && typeof payload === "object" ? payload : {};
  const e = env || process.env;
  const take = (v) =>
    typeof v === "string" && v.trim() !== "" ? v.slice(0, 128) : null;
  return {
    payload_session: take(p.session_id),
    env_session: take(e.CLAUDE_CODE_SESSION_ID) || take(e.CLAUDE_SESSION_ID),
  };
}

/** The host pid the marker belongs to, when the host exports one. */
function ownerPid(env) {
  const e = env || process.env;
  const raw = e.CLAUDE_PID;
  const n = Number.parseInt(String(raw == null ? "" : raw), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// resolution — no subprocess on the hot path
// ---------------------------------------------------------------------------

/**
 * The COMMON git dir for the tree containing `cwd`, resolved by FILESYSTEM WALK
 * first and subprocess only as a fallback.
 *
 * Why not always a subprocess: this function is on the `PreToolUse` hot path of
 * every Bash/Write/Edit call in the repo. The walk is a handful of `lstat`
 * calls and is the same resolution `lib/pcf-category.js::checkoutOf` already
 * performs for the same reason.
 *
 * Why a subprocess fallback at all: the walk cannot see `GIT_DIR`-style
 * indirection, and a wrong answer here means the guard silently reads the
 * wrong repository. The fallback goes through `lib/git-subprocess-env.js`
 * `gitEnv()`, whose whole purpose is that "`GIT_DIR` outranks repository
 * DISCOVERY, and neither `-C <path>` nor `cwd:` pins which repository git
 * resolves" — the child therefore gets an explicit minimal env.
 *
 * Returns an absolute realpath, or `null`. Callers MUST treat `null` as
 * UNRESOLVED and never as "no window".
 */
function resolveCommonGitDir(cwd) {
  const start = safeRealpath(cwd || process.cwd());
  if (!start) return null;
  const walk = walkToCommonDetailed(start);
  // A `commondir` sidecar that exists but is not a readable regular file is NOT
  // handed to git: git reads that same file with a blocking open (a FIFO there
  // parks it until the subprocess timeout, on every call). It is UNRESOLVED here.
  if (walk === WALK_REFUSED) return null;
  if (walk) return walk;
  try {
    // THE BINARY IS RESOLVED, NOT SPELLED, for the same reason `gitEnv()` is passed
    // rather than the ambient env: a bare `"git"` is PATH-resolved, so which binary
    // runs is decided by an env var this module does not own. Both halves of the
    // contract route through `./git-subprocess-env.js` (loom#1471;
    // `rules/security.md` § Multi-Site Kwarg Plumbing).
    const { resolveGitBinary, gitEnv } = require("./git-subprocess-env.js");
    const { execFileSync } = require("child_process");
    const gitBin = resolveGitBinary();
    if (!gitBin) return null; // INDETERMINATE, never "no window" (see the docstring above)
    const out = execFileSync(
      gitBin,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd: start,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
        env: gitEnv(),
      },
    ).trim();
    if (!out) return null;
    return safeRealpath(out) || null;
  } catch {
    return null;
  }
}

/**
 * `realpathSync.NATIVE` — the OS's own resolver — with the JS implementation as
 * the fallback.
 *
 * THE DIFFERENCE IS CASE, AND IT WAS A MEASURED BYPASS. On darwin the JS
 * `fs.realpathSync` echoes back whatever spelling it was handed for an existing
 * path, while `fs.realpathSync.native` returns the ON-DISK case:
 *
 *   fs.realpathSync("/USERS/<OPERATOR>/…/.claude/hooks")        → "/USERS/<OPERATOR>/…"
 *   fs.realpathSync.native("/USERS/<OPERATOR>/…/.claude/hooks") → "/Users/<operator>/…"
 *
 * Both resolve — the volume is case-INSENSITIVE — so an upper-cased spelling of
 * the primary resolved "successfully" to a string that was not `isUnder` the
 * primary root, and the write reached the primary. MEASURED 2026-10-01 on this
 * host (darwin 25.6.0), not inferred. `security.md` § Path Containment requires
 * an OS-NORMALIZED comparison of both sides; this is the first of its two
 * halves, and `normalizePathForCompare` is the second.
 */
function safeRealpath(p) {
  const native = fs.realpathSync && fs.realpathSync.native;
  if (typeof native === "function") {
    try {
      return native(p);
    } catch {
      /* fall through to the JS implementation */
    }
  }
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * OS-NORMALIZE a path for COMPARISON — the second half of
 * `security.md` § Path Containment.
 *
 * On a case-INSENSITIVE volume two spellings denote one file, so a containment
 * test that compares them byte-for-byte reports "not contained" for a path the
 * filesystem will happily write. Folding case on exactly the platforms whose
 * default volume is case-insensitive is the normalisation the rule asks for.
 *
 * WHY NOT `realpathSync.native` ALONE: it canonicalises the case of the parts
 * that EXIST, and a containment target routinely does not (a `Write` of a new
 * file re-joins the unresolvable tail verbatim from the caller's input — see
 * `canonicalizeForContainment`). A caller who spells the tail in the wrong case
 * would then be compared verbatim. Folding both sides closes that half too.
 *
 * The residual is DECLARED: on a case-SENSITIVE volume on one of these
 * platforms, two genuinely different paths that differ only in case would be
 * compared equal and the guard would refuse a write outside the primary. That
 * is the false-positive direction, it costs one refused call naming its
 * alternative, and it is strictly preferable to the measured false negative —
 * `caseFold` is therefore applied per-platform by name, never as a blanket
 * `toLowerCase()` on every OS.
 */
function normalizePathForCompare(p) {
  const s = path.resolve(String(p));
  const caseInsensitive =
    process.platform === "darwin" || process.platform === "win32";
  return caseInsensitive ? s.toLowerCase() : s;
}

/**
 * The size bound for every file this module READS: the marker, a worktree's `.git`
 * pointer file and its `commondir` sidecar. Each is a few hundred bytes when honest
 * (`openWindow` writes the marker; git writes the other two), so the bound only
 * ever refuses a file nobody legitimate wrote.
 */
const MAX_READ_BYTES = 256 * 1024;

/**
 * Read a REGULAR file of at most `MAX_READ_BYTES` without ever blocking.
 *
 * WHY THIS EXISTS — A FIFO HUNG THE HOOK. These reads sit on the synchronous
 * path of `append-sink.js::appendSinkLine` (via `windowCovers`), which runs in
 * the hook dispatcher's own process. `fs.readFileSync` opens O_RDONLY with
 * O_NONBLOCK CLEAR, and per POSIX open(2) a read-only open of a FIFO with no
 * writer BLOCKS until one appears. A FIFO at `<common>/land-lane/landing-window.json`,
 * at a worktree's `.git`, or at its `commondir` — all under paths a session can
 * write (`.git/**` is writable outside `hooks/` and `config`) — therefore parked
 * the dispatcher in open(2), where its own deadline timers cannot fire, until the
 * host killed it.
 *
 * THE DECISION IS MADE ON THE OPENED FD, NEVER ON A PRIOR lstat:
 *   - `O_NONBLOCK` makes the open of a FIFO return at once instead of waiting
 *     for a writer (on a regular file it is a no-op);
 *   - `O_NOFOLLOW` refuses a symlink at the final component (ELOOP), so a planted
 *     link cannot redirect the read out of the tree, where a `malformed` result
 *     would echo the first bytes of the foreign file;
 *   - `fstatSync(fd)` then refuses anything that is not a regular file. The fd is
 *     bound to one inode, so swapping the PATH after the open changes nothing: an
 *     lstat-then-read pair had a window in which a FIFO could replace the file
 *     the lstat cleared, and the read then blocked on it.
 *   - the size is checked on the fd, and the read is bounded, so a file that grows
 *     between the fstat and the read is refused rather than read whole.
 * Both flags are `|| 0`-guarded so a platform lacking one degrades rather than
 * NaN-poisoning the mask (no FIFO exists on the platform that lacks them).
 *
 * SHARED, NOT COPIED. Every hook-path read of a session-writable git-layout or
 * marker file goes through this one function (git-checkout-proof `.git`,
 * pcf-category's checkout probe and `--body-file`, landed-map's ledger, config
 * and cache, the worktree owner/occupancy readers, the genesis enrollment marker,
 * the deploy staging marker, the sync-freshness marker), so the non-blocking,
 * fd-decided contract is held in one place.
 *
 * @param {string} p
 * @param {{maxBytes?: number}} [opts]  The size bound; default `MAX_READ_BYTES`.
 *   The read is CHUNKED, so a large bound costs no allocation up front.
 * @returns {{ok: true, text: string} | {ok: false, code: string, reason: string}}
 *   `code` is the errno for an open failure (ENOENT means absent), or one of
 *   `ENOTREG` (not a regular file) / `EFBIG` (over the bound). Never throws.
 */
function readRegularFileBounded(p, opts) {
  const max =
    opts && Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? Math.floor(opts.maxBytes) : MAX_READ_BYTES;
  const flags =
    fs.constants.O_RDONLY |
    (fs.constants.O_NONBLOCK || 0) |
    (fs.constants.O_NOFOLLOW || 0);
  let fd = null;
  try {
    try {
      fd = fs.openSync(p, flags);
    } catch (e) {
      const code = (e && e.code) || "EOPEN";
      return { ok: false, code, reason: code === "ELOOP" ? "ELOOP (a symlink; not followed)" : code };
    }
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      const kind = st.isFIFO()
        ? "fifo"
        : st.isDirectory()
          ? "directory"
          : st.isSocket()
            ? "socket"
            : st.isCharacterDevice() || st.isBlockDevice()
              ? "device"
              : "other";
      return { ok: false, code: "ENOTREG", reason: `not a regular file (${kind}); not read` };
    }
    if (st.size > max)
      return { ok: false, code: "EFBIG", reason: `${st.size} bytes, over the ${max}-byte read bound` };
    // Chunked, and counted past the bound, so growth after the fstat is SEEN
    // (refused) rather than truncated into a shorter, wrong text.
    const chunks = [];
    let got = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, max + 1 - got));
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      chunks.push(n === chunk.length ? chunk : chunk.subarray(0, n));
      got += n;
      if (got > max)
        return { ok: false, code: "EFBIG", reason: `grew past the ${max}-byte read bound while being read` };
    }
    return { ok: true, text: Buffer.concat(chunks, got).toString("utf8") };
  } catch (e) {
    const code = (e && e.code) || "EREAD";
    return { ok: false, code, reason: code };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* a failed close of a read-only fd cannot be acted on and must not mask the result */
      }
    }
  }
}

/**
 * Write `data` to a FRESH temp file at `tmp`, then rename it over `target`.
 *
 * THE WRITE-SIDE TWIN OF `readRegularFileBounded`. The writers that use it put
 * their temp file in a directory a session can write (`<git-common-dir>/land-lane/`,
 * the common dir itself, a per-worktree admin dir), under a name anyone can
 * predict (`<target>.tmp-<pid>`). A plain `fs.writeFileSync(tmp, …)` FOLLOWS a
 * symlink planted at that name and writes the trusted bytes wherever it points,
 * and opens a planted FIFO O_WRONLY with O_NONBLOCK clear, which blocks.
 *
 * `O_CREAT|O_EXCL` creates the file or fails EEXIST: it never opens what is
 * already there — a symlink (followed by neither flag), a FIFO or a file — so a
 * planted name is a loud refusal, never a redirected or blocked write.
 * `O_NOFOLLOW` is added where the platform has it. `rename(2)` replaces the
 * TARGET's directory entry and does not follow a symlink standing there.
 *
 * The temp file is removed on any failure AFTER this call created it, and never
 * otherwise: an EEXIST name belongs to someone else.
 *
 * @throws the underlying error (EEXIST for a planted name); callers already
 *   handle a failed write.
 */
function writeFreshThenRename(tmp, target, data, mode) {
  const exclusive = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const fd = fs.openSync(tmp, exclusive | noFollow, typeof mode === "number" ? mode : 0o600);
  let open = true;
  let renamed = false;
  try {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
    let off = 0;
    while (off < buf.length) {
      const n = fs.writeSync(fd, buf, off, buf.length - off);
      if (!(n > 0)) throw new Error(`short write to ${tmp} (${off}/${buf.length} bytes)`);
      off += n;
    }
    fs.closeSync(fd);
    open = false;
    fs.renameSync(tmp, target);
    renamed = true;
  } finally {
    if (open) {
      try {
        fs.closeSync(fd);
      } catch {
        /* the fd is discarded on every path out */
      }
    }
    if (!renamed) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* already gone: nothing of ours to remove */
      }
    }
  }
}

/**
 * `walkToCommonDetailed`'s answer when the walk found a `commondir` sidecar it must
 * not read (see there). Internal: the exported `_walkToCommon` maps it to null.
 */
const WALK_REFUSED = Symbol("landing-window-read:walk-refused");

/** Walk up for a `.git` entry; follow a `gitdir:` pointer + `commondir` sidecar. */
function walkToCommon(start) {
  const r = walkToCommonDetailed(start);
  return r === WALK_REFUSED ? null : r;
}

/**
 * The walk itself. Returns the common dir, `null` (the walk cannot answer; git may),
 * or `WALK_REFUSED` (the walk found a sidecar git would block on; nobody may answer).
 */
function walkToCommonDetailed(start) {
  let cur = start;
  for (;;) {
    const dotGit = path.join(cur, ".git");
    let st = null;
    try {
      st = fs.lstatSync(dotGit);
    } catch {
      st = null;
    }
    if (st) {
      if (st.isDirectory()) return safeRealpath(dotGit);
      // Anything else that EXISTS goes to the fd-checked reader, which decides on
      // the fstat of what it opened: the lstat above only routes, it never clears
      // a read (a FIFO swapped in after it is refused by the reader, not hung on).
      // A symlink, FIFO, socket or device is refused there, exactly as the lstat
      // `isFile()` gate refused it before.
      const dotGitRead = readRegularFileBounded(dotGit);
      // A `.git` that EXISTS (the lstat saw it) but is refused — a symlink (ELOOP), a
      // FIFO or socket, an oversized file — is NOT handed to the git fallback either.
      // git follows a symlinked `.git` to a gitfile and then reads its `commondir`
      // with a blocking open, so a FIFO sidecar behind a symlinked `.git` parked the
      // fallback until its 5 s timeout (the security seat measured resolveMs 5005).
      // Only ENOENT (the entry vanished after the lstat) still lets git answer.
      if (!dotGitRead.ok) return dotGitRead.code === "ENOENT" ? null : WALK_REFUSED;
      const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(dotGitRead.text);
      const gitdir = m ? safeRealpath(path.resolve(cur, m[1])) : null;
      if (!gitdir) return null;
      // A linked worktree's admin dir carries a `commondir` SIDECAR pointing
      // back at the main `.git`. Without it we would return
      // `<main>/.git/worktrees/<id>` and look for the marker in a directory
      // the opener never wrote to — a silent true-negative for every sibling.
      const side = readRegularFileBounded(path.join(gitdir, "commondir"));
      if (side.ok) {
        const rel = side.text.trim();
        if (rel) return safeRealpath(path.resolve(gitdir, rel));
        return gitdir;
      }
      // ABSENT is the one refusal that means "no sidecar: the pointer IS the common
      // dir". A sidecar that EXISTS but cannot be read (a FIFO, a symlink, oversized)
      // is NOT absence: answering `gitdir` there would look for the marker in the
      // per-worktree admin dir and silently miss a live window. Nor is it handed to
      // git, which reads the same file with a BLOCKING open (`strbuf_read_file`), so
      // a FIFO there would park every fallback probe until its timeout. UNRESOLVED:
      // `windowCovers` answers `covered:false` exactly as it does for an unreadable
      // marker, and `landing-window-guard.js::contextFor` drops the target, so no
      // caller enforces a window it could not read.
      if (side.code === "ENOENT") return gitdir;
      return WALK_REFUSED;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * The PRIMARY checkout's working tree, from the common git dir.
 *
 * `git rev-parse --git-common-dir` returns the SHARED git dir, so the primary
 * top-level is its parent when — and only when — the basename is `.git`. A
 * bare repo or a `--separate-git-dir` layout has some other shape, and there we
 * return `null` rather than guessing: a wrong "primary" would make the guard
 * refuse work in a tree that is not the primary, which is worse than no guard.
 */
function resolvePrimaryRoot(cwd) {
  const common = resolveCommonGitDir(cwd);
  if (!common) return null;
  if (path.basename(common) !== ".git") return null;
  return path.dirname(common);
}

function windowPath(commonDir) {
  return path.join(commonDir, "land-lane", "landing-window.json");
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

/**
 * Read the marker. THREE distinct outcomes, deliberately NOT collapsed:
 *
 *   { state: "absent" }                     — no file. The overwhelmingly common
 *                                             case; callers MUST take the cheap
 *                                             passthrough here.
 *   { state: "unreadable", reason }          — a file exists but could not be read.
 *   { state: "malformed", reason, raw }      — read, but not a classifiable record.
 *   { state: "record", record }              — a well-formed record; NOW classify it.
 *
 * `unreadable` and `malformed` are NOT collapsed into `absent`. That would be
 * the silent fallback `rules/zero-tolerance.md` Rule 3 forbids: "I could not
 * read the marker" and "there is no marker" have opposite meanings and the same
 * passthrough.
 */
function readWindowRecord(commonDir) {
  if (!commonDir)
    return { state: "unreadable", reason: "common git dir unresolved" };
  const p = windowPath(commonDir);
  // Through the fd-checked, non-blocking reader (see `readRegularFileBounded`): a
  // FIFO, socket, device, symlink or oversized file at the marker path is
  // `unreadable` — which every caller already treats as NOT a live window — and
  // never a read that blocks the hook calling it.
  const got = readRegularFileBounded(p);
  if (!got.ok) {
    if (got.code === "ENOENT") return { state: "absent", path: p };
    return {
      state: "unreadable",
      path: p,
      reason: got.reason || got.code || "read failed",
    };
  }
  const raw = got.text;
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return {
      state: "malformed",
      path: p,
      reason: "not JSON",
      raw: raw.slice(0, 200),
    };
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { state: "malformed", path: p, reason: "not an object", raw };
  }
  const missing = REQUIRED_FIELDS.filter((f) => {
    const v = record[f];
    return !(typeof v === "string" && v.trim() !== "");
  });
  if (missing.length) {
    return {
      state: "malformed",
      path: p,
      reason: `missing field(s): ${missing.join(", ")}`,
      raw,
    };
  }
  // `owner` is structural, not scalar. A record with no usable owner cannot be
  // attributed, and an unattributable live marker would refuse work nobody can
  // claim or clear — so a bad `owner` is MALFORMED (reported, not enforced),
  // never a live window owned by `undefined`.
  const ow = record.owner;
  if (!ow || typeof ow !== "object" || Array.isArray(ow)) {
    return {
      state: "malformed",
      path: p,
      reason: "owner is not an object",
      raw,
    };
  }
  if (!(typeof ow.session_id === "string" && ow.session_id.trim() !== "")) {
    return {
      state: "malformed",
      path: p,
      reason: "owner.session_id missing or empty",
      raw,
    };
  }
  return { state: "record", path: p, record };
}

// ---------------------------------------------------------------------------
// classification — THE staleness predicate
// ---------------------------------------------------------------------------

/**
 * Classify a well-formed record. Returns
 * `{ state: "live" | "stale", reason, matched }` where `matched` names WHICH
 * rule fired, so a report can say why rather than only what.
 *
 * `now` and `env` are injectable so a fixture can pin a clock and a host
 * without touching the real ones.
 */
function classifyWindow(record, opts) {
  const o = opts || {};
  const now = typeof o.now === "number" ? o.now : Date.now();
  // THE RECORD'S OWN BOUND IS HONOURED, and that is a correction rather than a
  // feature: `openWindow` has always written `record.bound_ms` — `land-lane`
  // passes an explicit `boundMs: 20 * 60 * 1000` at its call site — while this
  // classifier read only `opts.boundMs || DEFAULT`. The writer's declared bound
  // was therefore inert and every caller silently got 45 minutes. One contract,
  // two halves, disagreeing (`security.md` § Multi-Site Kwarg Plumbing). Order:
  // an explicit test-injected bound wins, then the record's, then the default.
  const boundFromRecord = Number(record && record.bound_ms);
  const boundMs =
    Number.isFinite(o.boundMs) && o.boundMs > 0
      ? o.boundMs
      : Number.isFinite(boundFromRecord) && boundFromRecord > 0
        ? boundFromRecord
        : DEFAULT_STALE_BOUND_MS;
  const env = o.env || process.env;
  const host = o.host || os.hostname();

  const startedMs = Date.parse(record.started_at);
  if (!Number.isFinite(startedMs)) {
    // A `started_at` we cannot parse is not a licence to honour the marker
    // forever; it is a marker whose time bound CANNOT be evaluated. Fall
    // through to the death check, and if that is also unavailable, STALE —
    // because the clause's whole point is that an un-ageable marker must not
    // keep refusing work.
    return {
      state: "stale",
      matched: "unparseable-started-at",
      reason: `started_at ${JSON.stringify(record.started_at)} is not a parseable timestamp, so the time bound cannot be evaluated`,
    };
  }
  const ageMs = now - startedMs;
  if (ageMs > boundMs) {
    return {
      state: "stale",
      matched: "time-bound",
      age_ms: ageMs,
      bound_ms: boundMs,
      reason: `age ${Math.round(ageMs / 60000)} min exceeds the ${Math.round(boundMs / 60000)} min bound`,
    };
  }

  const owner =
    record.owner && typeof record.owner === "object" ? record.owner : {};
  const pid = Number.parseInt(String(owner.pid), 10);
  const sameHost = typeof owner.host === "string" && owner.host === host;
  if (sameHost && Number.isInteger(pid) && pid > 0) {
    // UNVERIFIABLE READS LIVE, and the direction is set by what every caller
    // does with the answer. LIVE refuses a write into the primary (the guard's
    // advisory, `append-sink.js` and `burndown-events.js::appendEvent` freezing
    // their sinks, `openWindow` declining a second window); STALE lets it
    // through. A false STALE lands a tracked change inside a running preflight
    // and voids its receipt with nothing said; a false LIVE refuses loudly, by
    // name, and ends at this record's time bound. So when the owner can be
    // neither confirmed nor ruled out, the window holds until the clock retires it.
    const probe =
      typeof o.startTokenOf === "function" ? o.startTokenOf : processStartToken;
    const seen = probe(pid);
    if (seen && seen.state === "absent") {
      return {
        state: "stale",
        matched: "owner-dead",
        reason: `owner pid ${pid} no longer exists on ${host}`,
      };
    }
    const recorded =
      typeof owner.pid_start === "string" && owner.pid_start.trim() !== ""
        ? owner.pid_start.trim()
        : null;
    if (seen && seen.state === "present" && recorded) {
      if (seen.token === recorded) {
        return {
          state: "live",
          matched: "owner-alive",
          reason: `owner pid ${pid} is alive on ${host}, started ${recorded}`,
        };
      }
      return {
        state: "stale",
        matched: "owner-pid-reused",
        reason:
          `owner pid ${pid} on ${host} is now held by a process started ${seen.token}, ` +
          `not the owner started ${recorded}, so the owner is gone and its pid was reused`,
      };
    }
    return {
      state: "live",
      matched: "owner-unverified",
      reason:
        `owner pid ${pid} on ${host} cannot be verified (` +
        (seen && seen.state === "present"
          ? "the marker records no start time to compare"
          : `the process table could not be read: ${(seen && seen.reason) || "no answer"}`) +
        `), so the ${Math.round(boundMs / 60000)} min time bound is what retires this window`,
    };
  }

  // Cross-host, or the opener exported no pid: the time bound above is the only
  // instrument, and it did not fire, so the window is honoured — but which of
  // the two it is decides whether anything could EVER have ended this window
  // early, so the two are NAMED separately rather than collapsed. A same-host
  // marker with no pid is the one shape whose only exit is the clock, and the
  // report path renders `matched`, so an operator can see that.
  if (sameHost) {
    return {
      state: "live",
      matched: "owner-pid-absent",
      reason:
        `no owner pid recorded, so the death check is UNAVAILABLE and the ${Math.round(boundMs / 60000)} min ` +
        `time bound is the only instrument that can retire this window`,
    };
  }
  return {
    state: "live",
    matched: "time-bound-intact",
    reason: `owner is on ${owner.host || "an unrecorded host"}; age is inside the bound`,
  };
}

/**
 * What the process table says about `pid`, read with `ps -o lstart=` — the
 * pid + start-time identity `coord-background.js::_processStartToken`,
 * `sessionend-release-lease.js::_processStartToken` and
 * `dispatch-ledger.js::_hostStartToken` already use. No signal is sent.
 *
 *   { state: "present", token }   a process holds `pid`; `token` is its start time
 *   { state: "absent" }           `ps` ran cleanly and found no such process
 *   { state: "unverifiable", reason }   anything else
 *
 * `absent` is claimed ONLY on the one shape a clean miss produces — exit 1 with
 * nothing on stdout or stderr — so a `ps` that failed for another reason (an
 * out-of-range pid prints `process id too large` and also exits 1) is never read
 * as a death. The binary is taken from a fixed system path, never PATH, for the
 * reason the git probes here resolve theirs. `lstart` is 1-second granular: a
 * pid reused within the second its owner started is not told apart.
 */
const PS_CANDIDATES = Object.freeze(["/bin/ps", "/usr/bin/ps"]);
function processStartToken(pid) {
  if (!(Number.isInteger(pid) && pid > 0)) {
    return { state: "unverifiable", reason: `not a pid: ${JSON.stringify(pid)}` };
  }
  const bin = PS_CANDIDATES.find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
  if (!bin) return { state: "unverifiable", reason: "no ps at /bin/ps or /usr/bin/ps" };
  try {
    const { spawnSync } = require("child_process");
    const r = spawnSync(bin, ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 2000,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    });
    if (r.error) {
      return { state: "unverifiable", reason: `ps did not run (${r.error.code || r.error.message})` };
    }
    const out = String(r.stdout || "").trim();
    const err = String(r.stderr || "").trim();
    if (r.status === 0 && out !== "") return { state: "present", token: out };
    if (r.status === 1 && out === "" && err === "") return { state: "absent" };
    return {
      state: "unverifiable",
      reason: `ps exited ${r.status === null ? `on ${r.signal}` : r.status}${err ? `: ${err.slice(0, 120)}` : ""}`,
    };
  } catch (e) {
    return { state: "unverifiable", reason: `ps did not run (${(e && e.message) || e})` };
  }
}

// ---------------------------------------------------------------------------
// description — for the refusal body
// ---------------------------------------------------------------------------

/**
 * The window rendered so a refusal can NAME it. The clause requires the refusal
 * to name the window, its owner, and the alternative; this is the first two.
 */
function describeWindow(record, classification) {
  const owner =
    record.owner && typeof record.owner === "object" ? record.owner : {};
  const who = owner.session_id || owner.display || "(no session recorded)";
  const bits = [
    `purpose: ${record.purpose}`,
    `head: ${String(record.head).slice(0, 12)}`,
    `started: ${record.started_at}`,
  ];
  if (
    classification &&
    classification.state === "live" &&
    classification.age_ms !== undefined
  ) {
    bits.push(`age: ${Math.round(classification.age_ms / 60000)} min`);
  }
  return `owner ${who} (pid ${owner.pid == null ? "?" : owner.pid} on ${owner.host || "?"}) — ${bits.join(", ")}`;
}

// ---------------------------------------------------------------------------
// tree containment
// ---------------------------------------------------------------------------

/**
 * Canonicalize a path for CONTAINMENT, resolving the deepest EXISTING ancestor
 * and re-joining the remaining segments.
 *
 * REQUIRED, not tidiness. `resolvePrimaryRoot` returns a `realpathSync`'d path,
 * while a `tool_input.file_path` arrives as the caller typed it. On darwin
 * `/tmp` is a symlink to `/private/tmp`, so a target given as
 * `/tmp/lw-smoke/a.txt` is NOT `isUnder` a primary root resolved to
 * `/private/tmp/lw-smoke` — MEASURED on the first smoke run, where every
 * in-primary write fell outside jurisdiction and the guard passed it through.
 * `rules/security.md` § Path Containment: BOTH candidate and boundary root go
 * through the SAME resolver, or the comparison is not sound.
 *
 * The tail re-join is what makes this work for a path that does not exist yet —
 * which is the normal case for a `Write` of a new file. It climbs ONLY past a
 * genuinely ABSENT component (`lstat` sees nothing there). A component that EXISTS
 * but will not resolve — a dangling link, EACCES, ELOOP — returns NULL, and so does a
 * chain on which nothing resolves; the caller reports that as `unresolved`, never as
 * `out-of-tree`. It used to climb past any failure and fall back to `path.resolve`,
 * so a Write through a dangling link OUTSIDE the primary that points INSIDE it read
 * `out-of-tree` (train-8 R2 correctness ledger: the corr F1 class).
 */
function canonicalizeForContainment(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    const real = safeRealpath(cur);
    if (real) return tail.length ? path.join(real, ...tail.reverse()) : real;
    try {
      fs.lstatSync(cur);
      return null; // it exists but will not resolve: never guess where it points
    } catch (le) {
      if (!le || le.code !== "ENOENT") return null; // not provably absent: refuse
      /* genuinely absent: climb */
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    tail.push(path.basename(cur));
    cur = parent;
  }
}

/**
 * Is `child` at or under `parent`? Path-segment comparison, never a prefix test
 * — and on a case-insensitive volume, a CASE-INSENSITIVE one (see
 * `normalizePathForCompare` for the measured bypass that made this necessary).
 */
function isUnder(child, parent) {
  if (!child || !parent) return false;
  const a = normalizePathForCompare(child);
  const b = normalizePathForCompare(parent);
  if (a === b) return true;
  const rel = path.relative(b, a);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * The toplevels of LINKED worktrees registered against the same primary —
 * i.e. every worktree EXCEPT the primary itself.
 *
 * THE reason this exists: a nested worktree (`<primary>/.claude/worktrees/<id>`)
 * lives INSIDE the primary's path, so a pure `isUnder(target, primaryRoot)` test
 * would classify work happening in it as "writing to the primary" and refuse it.
 * That is exactly the false positive the hard constraint names — "a hook that
 * fires on the WRONG tree, or that refuses work in a SIBLING worktree, is worse
 * than none". Sibling worktrees created outside the repo are already excluded by
 * containment; this closes the nested case.
 *
 * ⛔ THE `-z` PARSE IS THE WHOLE FUNCTION, AND IT WAS WRONG UNTIL 2026-10-01.
 * Every line is NUL-terminated and the record separator is an EXTRA NUL, so a
 * record reads `worktree <path>\0HEAD <sha>\0branch <ref>` (MEASURED with
 * `od -c` on this repo, not inferred). The first cut split the output on `\0\0`
 * and then matched `/^worktree (.+)$/m` against the whole record — and in a
 * JavaScript regex `.` matches a NUL and `$` (multiline) has no `\n` to stop
 * at, so the capture swallowed the SHA and the ref as well. `safeRealpath` on
 * that string failed and EVERY record was skipped, on the real repo and on a
 * scratch repo alike: this function returned `[]` unconditionally, so the
 * nested-worktree exclusion never fired and a write into
 * `<primary>/.claude/worktrees/<id>` was BLOCKED whenever any window was live —
 * the sibling-refusal false positive the design calls worse than no guard.
 * Split on `\0` and take the FIELD that starts with `worktree `.
 *
 * Returns `[]` on any failure. That direction is deliberate: an unenumerable
 * worktree list leaves the primary test CONSERVATIVE (more paths read as
 * primary), and the stale/live classification still gates every refusal.
 */
function linkedWorktreeTops(cwd) {
  try {
    // Resolved binary + constants-built env: both halves, one helper (loom#1471).
    const { resolveGitBinary, gitEnv } = require("./git-subprocess-env.js");
    const { execFileSync } = require("child_process");
    const gitBin = resolveGitBinary();
    if (!gitBin) return [];
    const out = execFileSync(
      gitBin,
      ["-C", cwd || process.cwd(), "worktree", "list", "--porcelain", "-z"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
        env: gitEnv(),
      },
    );
    const primary = resolvePrimaryRoot(cwd || process.cwd());
    const primaryKey = primary ? normalizePathForCompare(primary) : null;
    const tops = [];
    for (const field of out.split("\0")) {
      if (!field.startsWith("worktree ")) continue;
      const real = safeRealpath(field.slice("worktree ".length).trim());
      if (!real) continue;
      // Case-normalized, same as `isUnder`: on a case-insensitive volume the
      // primary can come back spelled differently from the probe's own input.
      if (primaryKey && normalizePathForCompare(real) === primaryKey) continue;
      tops.push(real);
    }
    return tops;
  } catch {
    return [];
  }
}

/**
 * Does a LIVE window cover the tracked path `targetPath` under `repoRoot`?
 *
 * This is the HOOK-WRITE half of T68 (clause 3), and it exists because a
 * `PreToolUse` guard cannot reach a hook's own write: hooks write with
 * `fs.*` directly, never through the `Write` tool, so no tool-event hook ever
 * sees them. The observed voiding that forced the clause was exactly this — a
 * HOOK (`todo-durable-guard`) appending a signed transition to the TRACKED
 * `burndown/events.jsonl` because a `todos/` file was edited, costing a green
 * run (`dev-preflight --import-receipt: REFUSED — this clone's tree is DIRTY`).
 * The mover was a guard doing exactly what it is designed to do.
 *
 * ⛔ THERE IS NO OWNER EXEMPTION HERE, AND THAT IS THE CLAUSE. The owner of the
 * window IS the session whose hooks fire during its own preflight, so an
 * owner-exempt hook-write rule would exempt precisely the instance that forced
 * the clause. The agent-facing guard (`landing-window-guard.js`) DOES exempt the
 * owner, because the owner legitimately runs the commands that open and close
 * the window; a hook's background state append is never one of those.
 *
 * Returns `{ covered: boolean, state, reason?, record?, classification?, path? }`.
 * `covered: true` ONLY for a live marker over an in-primary path — every other
 * outcome is explicitly named, so a caller can report WHY it did not refuse
 * rather than collapsing four different situations into a boolean.
 */
function windowCovers(repoRoot, targetPath, opts) {
  const o = opts || {};
  if (!targetPath) return { covered: false, state: "no-target" };
  const common = resolveCommonGitDir(repoRoot);
  if (!common)
    return {
      covered: false,
      state: "unresolved",
      reason: "common git dir unresolved",
    };
  // A target whose containment cannot be DECIDED — no primary root to compare against, or a
  // target that will not canonicalize — is never treated as outside the primary: the marker
  // (located from the common dir alone) is still read, so `windowFreezes` refuses it under a
  // live window. Without this the freeze stopped firing for those paths and the refusal rested
  // on append-sink's own containment alone.
  const undecided = (reason) => {
    const r = readWindowRecord(common);
    const c = r.state === "record" ? classifyWindow(r.record, o) : null;
    const live = !!c && c.state === "live";
    return {
      covered: false,
      state: "unresolved",
      reason,
      targetUnresolved: true,
      windowLive: live,
      description: live ? describeWindow(r.record, c) : undefined,
      path: r.path,
    };
  };
  const primaryRoot = resolvePrimaryRoot(repoRoot);
  if (!primaryRoot) return undecided("primary root indeterminate");
  const target = canonicalizeForContainment(targetPath);
  if (target === null)
    return undecided("target path does not resolve (a component exists but will not canonicalize)");
  if (!isUnder(target, primaryRoot))
    return { covered: false, state: "out-of-tree" };
  const linked = linkedWorktreeTops(repoRoot);
  if (linked.some((lt) => isUnder(target, lt))) {
    return { covered: false, state: "linked-worktree" };
  }
  const read = readWindowRecord(common);
  if (read.state === "absent")
    return { covered: false, state: "absent", path: read.path };
  if (read.state !== "record") {
    // Unreadable/malformed: NOT evidence that a window is live, and refusing on
    // it would let one truncated byte halt every hook write in the repo. Named,
    // never silent.
    return {
      covered: false,
      state: read.state,
      reason: read.reason,
      path: read.path,
    };
  }
  const cls = classifyWindow(read.record, o);
  return {
    covered: cls.state === "live",
    state: cls.state,
    matched: cls.matched,
    reason: cls.reason,
    record: read.record,
    classification: cls,
    description: describeWindow(read.record, cls),
    path: read.path,
  };
}

/**
 * THE freeze decision every hook-side sink consumer reads off a `windowCovers` verdict —
 * one predicate, so `append-sink.js` and `burndown-events.js` cannot drift apart. Refuses a
 * covered in-primary path, AND an unresolvable target under a LIVE window: unresolved is at
 * least as strict as covered (fail-closed), never quietly "not covered".
 */
function windowFreezes(v) {
  return !!v && (v.covered === true || (v.targetUnresolved === true && v.windowLive === true));
}

// ---------------------------------------------------------------------------
// WRITE HALF — here, not in the ESM facade, so BOTH consumers reach it
// ---------------------------------------------------------------------------
//
// `scripts/ci/dev-preflight.mjs` is ESM but drives everything through
// `createRequire` (see its import block), and `land-lane.mjs` is ESM too, while
// every hook is CJS. Putting the writer in the `.mjs` would have forced
// `dev-preflight` into a dynamic `import()` — and its `main()` is SYNCHRONOUS and
// ends in `process.exit(main())`, so an await there is a re-entrant rewrite of
// the whole command. One CJS implementation reaches all three callers; the
// `.mjs` is a thin re-export facade and adds only `withWindow`.

/** The head the window is opened against — the value a receipt would bind to. */
function resolveHeadForWindow(repoDir) {
  try {
    // Resolved binary + constants-built env: both halves, one helper (loom#1471).
    const { resolveGitBinary, gitEnv } = require("./git-subprocess-env.js");
    const { spawnSync } = require("child_process");
    const gitBin = resolveGitBinary();
    if (!gitBin) return null;
    const r = spawnSync(gitBin, ["-C", repoDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      env: gitEnv(),
    });
    if (r.status !== 0) return null;
    const sha = String(r.stdout || "").trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Open the window. Returns `{ ok, path, record, replaced }` or
 * `{ ok: false, reason }` — it does NOT throw.
 *
 * `ok: false` is deliberate for the callers here: a `dev-preflight` must still
 * RUN when the marker cannot be written (a read-only `.git`, a permissions
 * oddity). The window is an OBSERVABILITY improvement, and a failed observation
 * must not become a failed run — but it must be SAID, which is why the failure
 * is returned rather than swallowed (`zero-tolerance.md` Rule 3).
 *
 * A STALE marker is REPLACED, loudly. Refusing to open over a crashed session's
 * marker would let that crash blockade the repo forever, which is the clause-1
 * failure mode; overwriting in silence would lose the fact that an owner died
 * mid-run, which is worth knowing.
 */
function openWindow(repoDir, opts) {
  const o = opts || {};
  const purpose = String(o.purpose || "unspecified");
  const common = resolveCommonGitDir(repoDir);
  if (!common) return { ok: false, reason: "common git dir unresolved" };
  const p = windowPath(common);
  const env = o.env || process.env;

  let replaced = null;
  const prior = readWindowRecord(common);
  if (prior.state === "record") {
    const c = classifyWindow(prior.record, { now: o.now, env });
    const same =
      prior.record.owner &&
      prior.record.owner.session_id === ownerIdentity(env);
    if (c.state === "live" && !same && !o.force) {
      // Two concurrent windows over one working tree would each believe it owns
      // the freeze, and the second close would lift the first's guard.
      return {
        ok: false,
        reason: "another owner's window is live",
        prior: prior.record,
        classification: c,
        path: p,
      };
    }
    replaced = { record: prior.record, classification: c };
  }

  // ⛔ NO SESSION IDENTITY ⇒ NO MARKER. A marker whose `owner.session_id` is
  // absent is MALFORMED by `readWindowRecord`'s own predicate, so the guard
  // would REPORT it (`halt-and-report`, exit 0) rather than enforce it: it is an
  // unenforceable marker that LOOKS like protection on disk and protects
  // nothing. Declining to write it is the fail-closed half of "make it
  // fail-closed or LOUD" — and it is LOUD, because `ok: false` is surfaced by
  // both openers (`dev-preflight` prints "landing window NOT OPEN", `land-lane`
  // warns on `!w.ok`). The run still proceeds: the window is an observation, and
  // a failed observation must not become a failed run.
  const session = ownerIdentity(env);
  if (!session) {
    process.stderr.write(
      "landing-window: NO session identity (CLAUDE_CODE_SESSION_ID / CLAUDE_SESSION_ID both unset) — " +
        "the marker is NOT being written, because an unattributable marker would be reported rather than " +
        "enforced. Writers to this tree are NOT being refused.\n",
    );
    return {
      ok: false,
      reason:
        "no session identity available (would write an unenforceable marker)",
    };
  }
  const pid = ownerPid(env);
  // The owner's start time, so a reader can tell the owner from a later process
  // that reused its pid. Unreadable here ⇒ not recorded, and a reader then holds
  // the window to its time bound (`classifyWindow`, `owner-unverified`).
  const started = pid ? processStartToken(pid) : null;
  const record = {
    schema: MARKER_SCHEMA,
    purpose,
    head: o.head || resolveHeadForWindow(repoDir) || "unresolved",
    started_at: new Date(
      typeof o.now === "number" ? o.now : Date.now(),
    ).toISOString(),
    // A pid-less marker has no death check, so it gets the SHORTER backstop and
    // the opener says so out loud. See `PIDLESS_STALE_BOUND_MS`.
    bound_ms:
      Number.isFinite(o.boundMs) && o.boundMs > 0
        ? o.boundMs
        : pid
          ? DEFAULT_STALE_BOUND_MS
          : PIDLESS_STALE_BOUND_MS,
    owner: {
      session_id: session,
      pid,
      pid_start: started && started.state === "present" ? started.token : null,
      host: os.hostname(),
      display: o.display || `session ${session.slice(0, 8)}`,
    },
  };
  if (!pid) {
    process.stderr.write(
      `landing-window: no CLAUDE_PID — the window cannot be retired by the owner's death, so it will read ` +
        `STALE after ${Math.round(record.bound_ms / 60000)} min instead of the usual ` +
        `${Math.round(DEFAULT_STALE_BOUND_MS / 60000)}.\n`,
    );
  }
  if (o.note) record.note = String(o.note);

  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // tmp + rename: a reader must never observe a half-written marker, because a
    // truncated one classifies MALFORMED and the guard would report on it. The
    // temp file is created EXCLUSIVELY (O_CREAT|O_EXCL|O_NOFOLLOW, 0600): it sits in
    // the session-writable `<common>/land-lane/` under a predictable name, and a
    // plain `writeFileSync` there followed a planted symlink and wrote the trusted
    // opener's marker wherever it pointed. See `writeFreshThenRename`.
    const tmp = `${p}.tmp-${process.pid}`;
    writeFreshThenRename(tmp, p, JSON.stringify(record, null, 2) + "\n", 0o600);
  } catch (e) {
    return {
      ok: false,
      reason: `could not write the marker: ${(e && e.message) || e}`,
      path: p,
    };
  }

  if (replaced) {
    process.stderr.write(
      `landing-window: replaced a ${replaced.classification.state} marker previously held by ` +
        `${describeWindow(replaced.record, replaced.classification)}\n`,
    );
  }
  return { ok: true, path: p, record, replaced };
}

/**
 * Close the window. Removes the marker only when the caller OWNS it, or when it
 * is already STALE. Without that check a second session that happened to exit
 * during someone else's preflight would silently reopen the primary mid-run —
 * the defect this whole item closes, reintroduced by the cleanup path.
 */
function closeWindow(repoDir, opts) {
  const o = opts || {};
  const common = resolveCommonGitDir(repoDir);
  if (!common)
    return { ok: false, removed: false, reason: "common git dir unresolved" };
  const p = windowPath(common);
  const cur = readWindowRecord(common);
  if (cur.state === "absent")
    return { ok: true, removed: false, reason: "no marker" };
  if (cur.state !== "record") {
    // Unattributable. Removing is the only alternative to a permanent blockade
    // from a corrupt file; the reason is returned so the caller can say so.
    try {
      fs.rmSync(p, { force: true });
      removeDirIfEmpty(path.dirname(p));
      return {
        ok: true,
        removed: true,
        reason: `removed an unclassifiable marker (${cur.reason})`,
      };
    } catch (e) {
      return {
        ok: false,
        removed: false,
        reason: `could not remove: ${(e && e.message) || e}`,
      };
    }
  }
  const cls = classifyWindow(cur.record, { now: o.now, env: o.env });
  const session = ownerIdentity(o.env || process.env);
  const isOwner =
    !!session && cur.record.owner && cur.record.owner.session_id === session;
  if (!isOwner && cls.state === "live" && !o.force) {
    return {
      ok: false,
      removed: false,
      reason: `marker belongs to another live window (${describeWindow(cur.record, cls)})`,
      path: p,
    };
  }
  try {
    fs.rmSync(p, { force: true });
    removeDirIfEmpty(path.dirname(p));
    return {
      ok: true,
      removed: true,
      path: p,
      owner: isOwner,
      stale_when_closed: cls.state === "stale",
    };
  } catch (e) {
    return {
      ok: false,
      removed: false,
      reason: `could not remove: ${(e && e.message) || e}`,
    };
  }
}

/**
 * Remove `dir` only when it is now EMPTY.
 *
 * THE `<git-common-dir>/land-lane/` DIRECTORY IS SHARED, so this is a predicate and
 * not a `rm -rf`: it holds `landing-ledger.jsonl` (land-lane.mjs's append-only
 * landing ledger) for the whole life of the repo, and erasing it alongside the
 * marker would destroy the evidence every `Landed-*` trailer is validated against.
 * Only an empty directory is litter the marker itself created.
 *
 * WHY IT IS HERE AT ALL. The marker is written into the SAME directory as
 * land-lane's `state.json`, so `land-lane.mjs::removeState` — which deletes the
 * state file and then the directory "when it is then empty" — now runs while the
 * marker still occupies that directory, skips the removal, and the exit backstop
 * then removes the marker and leaves the empty directory behind. The observable
 * end-state of a `land`/`abort`/`direct` therefore changed the moment T68 opened a
 * window: `abort` no longer restored the tree to the state it left in. Mirroring
 * `removeState`'s predicate at the other half of the same contract keeps the two
 * from disagreeing (land-lane.test.mjs "conflict on the 2nd commit -> abort
 * restores the original tip" is what pins it).
 */
function removeDirIfEmpty(dir) {
  try {
    // `rmdirSync` and NOT a `readdir` + `rm -r` pair, deliberately: rmdir refuses a
    // NON-EMPTY directory (ENOTEMPTY) as one atomic syscall, so "is it empty?" and
    // "remove it" cannot disagree. The two-step form has a check-to-use window in
    // which a concurrent `openWindow` writes its marker into the directory this
    // close is about to erase — it would then delete a LIVE window's marker and
    // lift a freeze it does not own, which is the exact defect `closeWindow`'s
    // ownership check above exists to prevent. Not `recursive: true` for the same
    // reason: recursion is what makes the window destructive.
    fs.rmdirSync(dir);
  } catch {
    /* absent, non-empty (the ledger is still there), or foreign — all "leave it" */
  }
}

/**
 * Open, and register the `process.on("exit")` backstop that closes it.
 *
 * THE SHAPE `dev-preflight` AND `land-lane` BOTH NEED. Their `main()` functions
 * have a dozen `return N` statements and end in `process.exit(main())`, so
 * wrapping the body would mean re-indenting the whole command. The exit listener
 * gives the same guarantee for a two-line call site: it runs exactly once, after
 * the event loop drains, for a normal return AND for a direct `process.exit()`.
 * It does NOT run for `SIGKILL` — the one case that legitimately leaves a marker
 * for the stale classification to catch.
 */
function openWindowForProcess(repoDir, opts) {
  const o = opts || {};
  const opened = openWindow(repoDir, o);
  if (!opened.ok) return Object.assign({}, opened, { closed: () => {} });
  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    const r = closeWindow(repoDir, { env: o.env, now: o.now });
    if (!r.ok)
      process.stderr.write(
        `landing-window: could not close the marker — ${r.reason}\n`,
      );
  };
  process.on("exit", close);
  return Object.assign({}, opened, { closed: close });
}

/** One-shot status, for callers that only want to report. */
function windowStatus(repoDir, opts) {
  const common = resolveCommonGitDir(repoDir);
  if (!common)
    return { state: "unresolved", reason: "common git dir unresolved" };
  const r = readWindowRecord(common);
  if (r.state === "absent")
    return { state: "absent", path: windowPath(common) };
  if (r.state !== "record")
    return { state: r.state, reason: r.reason, path: r.path };
  const c = classifyWindow(r.record, opts || {});
  return {
    state: c.state,
    matched: c.matched,
    reason: c.reason,
    record: r.record,
    path: r.path,
    description: describeWindow(r.record, c),
  };
}

module.exports = {
  WINDOW_REL,
  MARKER_SCHEMA,
  DEFAULT_STALE_BOUND_MS,
  PIDLESS_STALE_BOUND_MS,
  openWindow,
  closeWindow,
  openWindowForProcess,
  windowStatus,
  windowCovers,
  windowFreezes,
  REQUIRED_FIELDS,
  ownerIdentity,
  callerIdentity,
  normalizePathForCompare,
  ownerPid,
  resolveCommonGitDir,
  resolvePrimaryRoot,
  windowPath,
  readWindowRecord,
  classifyWindow,
  processStartToken,
  describeWindow,
  isUnder,
  canonicalizeForContainment,
  linkedWorktreeTops,
  // THE non-blocking, fd-checked read of a small regular file. Shared rather than
  // copied: `git-checkout-proof.js::dotGitTarget` reads `<top>/.git` through it, so
  // a FIFO on either read path is refused by ONE implementation.
  readRegularFileBounded,
  MAX_READ_BYTES,
  // ...and its write-side twin: exclusive temp create, then rename.
  writeFreshThenRename,
  // Exported for fixtures that need to prove the walk and the subprocess path
  // agree; not used by production callers.
  _walkToCommon: walkToCommon,
};
