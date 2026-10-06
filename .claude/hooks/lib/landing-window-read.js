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
 *   (b) DEATH — the marker names THIS host and a pid, and
 *       `process.kill(pid, 0)` throws ESRCH. `EPERM` is NOT death: the process
 *       exists and we simply may not signal it, so it reads LIVE (fail-closed
 *       toward "the window is real").
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
  const walk = walkToCommon(start);
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

/** Walk up for a `.git` entry; follow a `gitdir:` pointer + `commondir` sidecar. */
function walkToCommon(start) {
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
      if (st.isFile()) {
        let gitdir = null;
        try {
          const body = fs.readFileSync(dotGit, "utf8");
          const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(body);
          if (m) gitdir = safeRealpath(path.resolve(cur, m[1]));
        } catch {
          return null;
        }
        if (!gitdir) return null;
        // A linked worktree's admin dir carries a `commondir` SIDECAR pointing
        // back at the main `.git`. Without it we would return
        // `<main>/.git/worktrees/<id>` and look for the marker in a directory
        // the opener never wrote to — a silent true-negative for every sibling.
        try {
          const rel = fs
            .readFileSync(path.join(gitdir, "commondir"), "utf8")
            .trim();
          if (rel) return safeRealpath(path.resolve(gitdir, rel));
        } catch {
          /* no sidecar: the pointer IS the common dir */
        }
        return gitdir;
      }
      return null;
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
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return { state: "absent", path: p };
    return {
      state: "unreadable",
      path: p,
      reason: `${(e && e.code) || "read failed"}`,
    };
  }
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
    if (pidIsDead(pid)) {
      return {
        state: "stale",
        matched: "owner-dead",
        reason: `owner pid ${pid} no longer exists on ${host}`,
      };
    }
    return {
      state: "live",
      matched: "owner-alive",
      reason: `owner pid ${pid} is alive on ${host}`,
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

/** ESRCH is death. EPERM is NOT — the process exists and we may not signal it. */
function pidIsDead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return !!e && e.code === "ESRCH";
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
 * which is the normal case for a `Write` of a new file. Fails closed to
 * `path.resolve` when nothing on the chain resolves, so a caller never receives
 * a `null` it might read as "not contained".
 */
function canonicalizeForContainment(p) {
  const abs = path.resolve(p);
  let cur = abs;
  const tail = [];
  for (;;) {
    const real = safeRealpath(cur);
    if (real) return tail.length ? path.join(real, ...tail.reverse()) : real;
    const parent = path.dirname(cur);
    if (parent === cur) return abs;
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
  const primaryRoot = resolvePrimaryRoot(repoRoot);
  if (!primaryRoot)
    return {
      covered: false,
      state: "unresolved",
      reason: "primary root indeterminate",
    };
  const target = canonicalizeForContainment(targetPath);
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
    // truncated one classifies MALFORMED and the guard would report on it.
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", {
      mode: 0o600,
    });
    fs.renameSync(tmp, p);
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
  describeWindow,
  isUnder,
  canonicalizeForContainment,
  linkedWorktreeTops,
  // Exported for fixtures that need to prove the walk and the subprocess path
  // agree; not used by production callers.
  _walkToCommon: walkToCommon,
};
