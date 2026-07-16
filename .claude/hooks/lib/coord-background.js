/**
 * coord-background.js — #857 background-execution helpers for the
 * multi-operator lifecycle hooks (multi-operator-sessionstart.js /
 * multi-operator-sessionend.js).
 *
 * #857 root cause: both lifecycle hooks performed SYNCHRONOUS GPG
 * signing/verification (via lib/coc-sign.js) on the session-lifecycle
 * critical path. Each ephemeral GPG homedir cold-starts a gpg-agent
 * (~300-700ms); a full coordination-log fold verifies ~hundreds of
 * signed records, so the hooks measured 6-8s wall-clock. SessionEnd's
 * 5s budget was ALWAYS exceeded ("Hook cancelled"); SessionStart at
 * 8s aborted the session before `system/init` on a contended machine.
 * The hooks' own setTimeout self-fallback CANNOT fire because the GPG
 * work is synchronous and blocks the event loop.
 *
 * This module decouples the HARNESS-VISIBLE hook latency from the GPG
 * work by running that work in a child process:
 *
 *   - spawnDetachedWorker  — SessionEnd: fire-and-forget teardown. The
 *     parent returns in <1s; the worker runs to completion detached.
 *   - runBoundedWorker     — SessionStart: hard-bounded banner build.
 *     The parent gets the full banner if the fold finishes within the
 *     budget, else a lightweight banner (caller's responsibility).
 *
 * Both workers re-invoke the SAME hook script with a `--coord-worker`
 * flag; the hook's worker branch runs the heavy body DIRECTLY (never
 * re-spawning — the flag guarantees no fork bomb).
 *
 * GPG homedir hygiene (requirement #857-3, #867): a bounded worker SIGTERM'd
 * mid-fold — OR the #866 detached, UNBUDGETED cache-rebuild fold killed by an
 * external shutdown — cannot run coc-sign's destroyVerifyHomedir `finally`, so
 * it leaks one gpg-agent + temp homedir. reapStaleGpgHomedirs() decides per
 * homedir by PID-LIVENESS, NOT by a time-window: each homedir-create site writes
 * a `<homedir>/coc-fold.pid` marker naming the owning process (pid + an immutable
 * process-start token). On reap — a homedir whose pid is ALIVE and whose start-
 * token still matches is SPARED regardless of age (a genuinely running fold: a
 * sibling operator's live fold OR this repo's own in-flight #866 detached
 * rebuild); a homedir whose pid is DEAD (ESRCH) or whose start-token no longer
 * matches (the PID was recycled to a different process) is reaped regardless of
 * age; a homedir with NO marker (a legacy pre-pidfile leak) falls back to the
 * mtime>cutoff guard. An OUTER mtime ceiling is the backstop for the rare case
 * where liveness reads "alive" but the start-token cannot be re-derived (no
 * `ps`). This replaces the former time-window-only heuristic, which could reap a
 * >5-min LIVE detached fold's homedir mid-use (#867). Isolating the homedirs
 * under a private nested TMPDIR is still NOT an option — nesting the homedir
 * deeper overflows the gpg-agent unix-socket path limit and hangs the fold.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync, execFileSync } = require("child_process");

const WORKER_FLAG = "--coord-worker";

// coc-sign.js temp-homedir prefixes (createVerifyHomedir / _verifyGpg /
// _signSsh / _verifySsh). A stale dir with one of these prefixes is a
// leaked GPG homedir whose gpg-agent must be killed before removal.
const COC_SIGN_TMP_PREFIXES = [
  "coc-sign-gpg-fold-",
  "coc-sign-gpg-vfy-",
  "coc-sign-ssh-in-",
  "coc-sign-ssh-vfy-",
];

// FALLBACK cutoff (pidfile-ABSENT homedirs only): a legacy pre-pidfile leak
// older than this is treated as orphaned. Homedirs that DO carry a coc-fold.pid
// marker are decided by PID-liveness (see reapStaleGpgHomedirs), NOT by this
// cutoff — so a genuinely live fold is spared regardless of age. 5 minutes stays
// a wide margin for the pidfile-less legacy path only.
const STALE_HOMEDIR_MS = 5 * 60 * 1000;

// Ownership marker each homedir-create site writes (pid + an immutable process-
// start token). Read by the reaper to decide liveness. NOT a secret — the token
// is an OS process start timestamp.
const FOLD_PID_FILENAME = "coc-fold.pid";

// OUTER PID-reuse backstop: a homedir whose pid reads "alive" but whose start-
// token could NOT be re-derived (e.g. `ps` unavailable) is reaped once older
// than this ceiling. Comfortably longer than any real fold OR an in-flight #866
// detached rebuild — both of which are spared by a VERIFIED live token
// regardless of age, so on a platform where `ps` works the ceiling never
// applies to them.
const PID_REUSE_CEILING_MS = 60 * 60 * 1000;

// #866 detached cache-rebuild flag — re-invokes the SessionStart lifecycle hook
// to rebuild the full banner off the critical path and rewrite the banner cache.
const CACHE_REBUILD_FLAG = "--coord-cache-rebuild";

// #866 banner cache: a precomputed full-banner file under .claude/learning/
// (per-repo local state — never synced, same class as posture.json). Read on the
// SessionStart critical path; written by the detached rebuild.
const BANNER_CACHE_FILE = ".ss-banner-cache.json";

// One-session staleness tolerance: the banner surfaces are advisory, so a
// recently-built cache is shown even when the coordination log changed since it
// was built (the detached rebuild refreshes it for the next session).
const BANNER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// #871 rebuild-dedup lock: a per-repo marker suppressing a SECOND concurrent
// detached rebuild spawn for the SAME coordination-log HEAD generation. Under a
// reconnect storm (many `claude -p` / a shell loop starting sessions at once)
// every SessionStart would otherwise spawn its own UNBUDGETED GPG fold →
// thundering herd rebuilding the same cache. The lock is keyed on the coord-log
// HEAD (coordinationLogKey) so a genuinely NEW coordination event always spawns a
// fresh rebuild; a crashed rebuild cannot wedge future rebuilds because the lock
// is reclaimed once older than STALE_REBUILD_LOCK_MS. Best-effort (last-writer-
// wins writeBannerCache means a lost race only wastes a fold, never corrupts) +
// per-clone local state, matched by the `.ss-banner-*` .gitignore glob (never
// synced; carries no secret — just a gen string + pid + timestamp). Mode 0600.
const REBUILD_LOCK_FILE = ".ss-banner-rebuild.lock";

// A detached rebuild's UNBUDGETED GPG fold on a loom-sized coordination log runs
// ~6-8s (the #857 synchronous-fold cost, now off the critical path); this ceiling
// is comfortably longer so a real in-flight rebuild is never pre-empted, yet short
// enough that a CRASHED rebuild's lock is reclaimed within one interactive gap.
const STALE_REBUILD_LOCK_MS = 2 * 60 * 1000;

/**
 * SessionEnd path: launch the heavy teardown in a DETACHED, unref'd child
 * in its OWN process group (detached:true) so it survives the parent's
 * immediate passthrough exit AND a harness SIGTERM to the parent's group.
 * stdio:"ignore" so nothing the harness reads is emitted. env inherited so
 * the worker keeps COC_OPERATOR_KEY_PATH (signing) + CLAUDE_PROJECT_DIR.
 *
 * @param {string} scriptPath - absolute path to the hook to re-invoke.
 * @returns {import('child_process').ChildProcess|null}
 */
function spawnDetachedWorker(scriptPath) {
  try {
    const child = spawn(process.execPath, [scriptPath, WORKER_FLAG], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    return child;
  } catch {
    // best-effort: if spawn fails, the caller passthrough()s — never block.
    return null;
  }
}

/**
 * This process's immutable start token (its OS process start time). A process's
 * start time never changes, so it uniquely disambiguates a live PID from a
 * recycled one. Best-effort: returns null when `ps` is unavailable (the reaper
 * then treats liveness as unverified and relies on the OUTER mtime ceiling). NOT
 * a secret — a process start timestamp.
 *
 * @param {number} pid
 * @returns {string|null}
 */
function _processStartToken(pid) {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 2000,
    });
    const t = (out || "").trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

let _ownStartTokenCache; // memoized — own start time is immutable for process life
function _ownStartToken() {
  if (_ownStartTokenCache === undefined) {
    _ownStartTokenCache = _processStartToken(process.pid);
  }
  return _ownStartTokenCache;
}

/**
 * Write the ownership marker into a freshly-created homedir. Called by every
 * coc-sign homedir-create site (createVerifyHomedir / _verifyGpg's owned home /
 * the SSH temp dirs). Best-effort: a failure just leaves the reaper on the
 * pidfile-absent mtime fallback for that homedir. Mode 0600.
 *
 * @param {string} dir
 */
function writeFoldPidFile(dir) {
  if (!dir || typeof dir !== "string") return;
  try {
    const body = JSON.stringify({
      pid: process.pid,
      token: _ownStartToken() || null,
    });
    fs.writeFileSync(path.join(dir, FOLD_PID_FILENAME), body, { mode: 0o600 });
  } catch {
    // best-effort — pidfile absence falls the reaper back to the mtime cutoff.
  }
}

/**
 * Classify a homedir's owner from its coc-fold.pid marker:
 *   "absent"           — no marker → mtime fallback.
 *   "dead"             — pid gone (ESRCH) OR corrupt marker OR start-token no
 *                        longer matches (PID recycled) → reap regardless of age.
 *   "alive-verified"   — pid alive AND start-token matches → spare regardless of age.
 *   "alive-unverified" — pid alive but token not re-derivable → spare within the
 *                        OUTER ceiling only.
 *
 * @param {string} dir
 * @returns {{state:string, reason?:string}}
 */
function _foldHomedirLiveness(dir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, FOLD_PID_FILENAME), "utf8");
  } catch {
    return { state: "absent" };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt marker — ownership cannot be established; safe to reap.
    return { state: "dead", reason: "corrupt-pidfile" };
  }
  const pid =
    parsed && Number.isInteger(parsed.pid) && parsed.pid > 0
      ? parsed.pid
      : null;
  if (pid === null) return { state: "dead", reason: "no-pid" };
  let alive;
  try {
    process.kill(pid, 0); // signal 0 = existence probe, delivers nothing
    alive = true;
  } catch (err) {
    // EPERM = the process exists but is owned by another uid → still alive.
    alive = !!(err && err.code === "EPERM");
  }
  if (!alive) return { state: "dead", reason: "esrch" };
  const storedToken = parsed.token || null;
  const liveToken = _processStartToken(pid);
  if (storedToken && liveToken) {
    return storedToken === liveToken
      ? { state: "alive-verified" }
      : { state: "dead", reason: "token-mismatch" }; // PID recycled
  }
  // Alive but the start-token could not be compared (no `ps`, or the writer
  // stored none) — spared only within the OUTER ceiling.
  return { state: "alive-unverified" };
}

/**
 * Reap leaked coc-sign GPG homedirs from os.tmpdir() by PID-LIVENESS: kill the
 * bound gpg-agent (gpgconf --homedir <h> --kill all) then remove the dir. A
 * homedir whose coc-fold.pid marker names a LIVE process (verified by an
 * immutable start-token) is SPARED regardless of age — safe against a concurrent
 * sibling operator's live fold AND this repo's own in-flight #866 detached
 * rebuild. A DEAD / token-mismatched marker is reaped regardless of age; a
 * marker-less legacy leak falls back to the mtime>cutoff guard; the OUTER mtime
 * ceiling backstops the token-unverifiable case. Best-effort + never throws.
 *
 * @param {number} [maxAgeMs=STALE_HOMEDIR_MS] fallback cutoff for marker-absent homedirs.
 */
function reapStaleGpgHomedirs(maxAgeMs) {
  const now = Date.now();
  const cutoff =
    now - (typeof maxAgeMs === "number" ? maxAgeMs : STALE_HOMEDIR_MS);
  const ceiling = now - PID_REUSE_CEILING_MS;
  let entries;
  try {
    entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (!COC_SIGN_TMP_PREFIXES.some((p) => ent.name.startsWith(p))) continue;
    const dir = path.join(os.tmpdir(), ent.name);
    let st;
    try {
      st = fs.statSync(dir);
    } catch {
      continue;
    }
    const live = _foldHomedirLiveness(dir);
    if (live.state === "alive-verified") {
      continue; // genuinely running fold — spare regardless of age
    }
    if (live.state === "alive-unverified") {
      if (st.mtimeMs > ceiling) continue; // within the OUTER backstop — spare
      // older than the ceiling AND unverifiable → fall through to reap.
    } else if (live.state === "absent") {
      if (st.mtimeMs > cutoff) continue; // too fresh, no marker — may be live; skip
      // older than the fallback cutoff → fall through to reap.
    }
    // live.state === "dead", OR an unverified/absent homedir past its bound → reap.
    try {
      execFileSync("gpgconf", ["--homedir", dir, "--kill", "all"], {
        stdio: "ignore",
      });
    } catch {
      // gpgconf may be absent / dir may hold no agent; rm still proceeds.
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
}

// Env var naming the file the SessionStart worker writes its banner to. The
// worker MUST write here (not stdout) so the bounded child can run with
// stdio:"ignore" — see the deadlock note in runBoundedWorker.
const BANNER_OUT_ENV = "COC_SS_BANNER_OUT";

/**
 * SessionStart path: run the heavy fold-dependent banner build in a HARD-
 * BOUNDED child. Returns {ok, stdout, timedOut, status}. On timeout the
 * child is SIGTERM'd; the caller falls back to a lightweight banner.
 *
 * DEADLOCK NOTE (why a file, not a stdout pipe): the fold starts a gpg-agent
 * DAEMON that inherits the child's stdio fds. If we captured the worker's
 * stdout via a pipe (encoding:"utf8"), the agent keeps the write-end open, so
 * the pipe never reaches EOF and spawnSync BLOCKS PAST its own timeout waiting
 * to drain it (observed: >2min hang). Running the child with stdio:"ignore"
 * makes the timeout kill clean (spawnSync only waits on the child PID, not a
 * daemon-held pipe); the worker writes its banner to a temp file we then read.
 *
 * Sweeps stale leaked GPG homedirs (reapStaleGpgHomedirs) BEFORE spawning, so
 * each SessionStart reaps the previous session's kill-path leak.
 *
 * @param {string} scriptPath - absolute path to the hook to re-invoke.
 * @param {number} budgetMs - hard wall-clock bound for the worker.
 * @returns {{ok:boolean, timedOut:boolean, stdout:string, status:number|null}}
 */
function runBoundedWorker(scriptPath, budgetMs) {
  reapStaleGpgHomedirs();
  // #857 security MED-1: the banner file carries operator + sibling identities
  // (display_id/person_id/verified_id, gate-approval requester info). A world-
  // readable 0644 file at a PREDICTABLE name in a shared /tmp is a disclosure +
  // symlink-TOCTOU surface (CWE-377). Create a PRIVATE per-invocation dir via
  // mkdtempSync (mode 0700, unpredictable suffix) and put the banner inside it;
  // the worker writes with {mode:0o600, flag:"wx"} (O_CREAT|O_EXCL) so a planted
  // symlink at the path fails the write closed. The dir is per-invocation and
  // reaped in this same call's cleanup (fs.rmSync of the WHOLE dir), so no
  // reapStaleGpgHomedirs-style time-window sweep is needed here.
  let bannerDir = null;
  let outFile = null;
  try {
    bannerDir = fs.mkdtempSync(path.join(os.tmpdir(), "coc-ss-banner-"));
    outFile = path.join(bannerDir, "banner.txt");
  } catch {
    bannerDir = null;
    outFile = null;
  }
  const env = Object.assign({}, process.env);
  if (outFile) env[BANNER_OUT_ENV] = outFile;
  let r;
  try {
    r = spawnSync(process.execPath, [scriptPath, WORKER_FLAG], {
      timeout: budgetMs,
      stdio: "ignore", // no inherited pipe → clean timeout kill (see note above)
      env,
    });
  } catch (err) {
    r = { status: null, error: err };
  }
  const timedOut = !!(r && r.error && r.error.code === "ETIMEDOUT");
  let stdout = "";
  let ok = false;
  if (r && r.status === 0 && outFile) {
    try {
      const content = fs.readFileSync(outFile, "utf8");
      if (content && content.trim().length > 0) {
        stdout = content.replace(/\s+$/, "");
        ok = true;
      }
    } catch {
      // banner file absent/unreadable → treat as worker failure (lightweight).
    }
  }
  if (bannerDir) {
    try {
      // Remove the WHOLE per-invocation mkdtemp dir (banner file + dir), not
      // just the file — the dir was created for this call and dies with it.
      fs.rmSync(bannerDir, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
  return { ok, timedOut, stdout, status: r ? r.status : null };
}

// ---- #866 banner cache + detached rebuild -----------------------------------

function _learningDir(repoDir) {
  return path.join(repoDir, ".claude", "learning");
}

/** Absolute path to the banner cache file for a repo. */
function bannerCachePath(repoDir) {
  return path.join(_learningDir(repoDir), BANNER_CACHE_FILE);
}

/**
 * Cheap coordination-log tip key (mtime+size) — NO fold, NO GPG. Used to decide
 * whether the cache still reflects the current log. "absent" when the log is
 * missing.
 *
 * @param {string} repoDir
 * @returns {string}
 */
function coordinationLogKey(repoDir) {
  try {
    const st = fs.statSync(
      path.join(_learningDir(repoDir), "coordination-log.jsonl"),
    );
    return `${Math.round(st.mtimeMs)}:${st.size}`;
  } catch {
    return "absent";
  }
}

/**
 * Cheap `mtime:size` stamp for a single path (file OR directory) — NO content
 * read. "absent" when the path is missing/unstat-able. For a directory the
 * mtime advances on entry add/remove/rename, which is exactly the granularity
 * the team-memory banner surface reflects (it lists filenames + a count, never
 * file contents).
 *
 * @param {string} p
 * @returns {string}
 */
function _statStamp(p) {
  try {
    const st = fs.statSync(p);
    return `${Math.round(st.mtimeMs)}:${st.size}`;
  } catch {
    return "absent";
  }
}

/**
 * #872 composite banner-freshness key. The rendered banner reflects MORE than the
 * coordination log — it also folds roster, operative posture, working-tree drift,
 * and the team-memory index. A cache keyed on the coord-log ALONE reports "current"
 * while showing stale posture/roster/drift/team-memory. This composite stamps every
 * input the banner reads, CHEAPLY (mtime+size stats only, no content reads on the
 * critical path):
 *
 *   coord-log ⊕ roster ⊕ posture ⊕ team-memory-dir ⊕ drift-proxy
 *
 * - coord-log:   .claude/learning/coordination-log.jsonl (the #866 key; FIRST so
 *                readFreshBannerCache can detect the log-absent case by prefix).
 * - roster:      .claude/operators.roster.json (sibling claims / identity surface).
 * - posture:     .claude/learning/posture.json (operative-posture surface).
 * - team-memory: .claude/team-memory/ dir mtime (the index count + slug surface).
 * - drift proxy: .git/index mtime+size — a CHEAP proxy for working-tree drift.
 *                It captures staged changes and the many working-tree operations
 *                that touch the index, but NOT every unstaged edit; running the
 *                actual `git status` porcelain on the critical path is the cost the
 *                #857 architecture exists to avoid. Residual drift-staleness is
 *                bounded by the TTL + the per-session rebuild (advisory surface).
 *
 * Returns "absent" for any missing component, so a fresh repo yields
 * "absent:absent:absent:absent:absent" — readFreshBannerCache treats a coord-log-
 * absent key as NON-authoritative (TTL-only) so `"absent" === "absent"` can no
 * longer permanently defeat the TTL (the #872 log-absent defeat).
 *
 * @param {string} repoDir
 * @returns {string}
 */
function bannerFreshnessKey(repoDir) {
  const learning = _learningDir(repoDir);
  const coordLog = coordinationLogKey(repoDir);
  const roster = _statStamp(
    path.join(repoDir, ".claude", "operators.roster.json"),
  );
  const posture = _statStamp(path.join(learning, "posture.json"));
  const teamMem = _statStamp(path.join(repoDir, ".claude", "team-memory"));
  const drift = _statStamp(path.join(repoDir, ".git", "index"));
  return `${coordLog}|${roster}|${posture}|${teamMem}|${drift}`;
}

/**
 * Read the cached full banner if FRESH. Fresh = the cache exists, carries a
 * non-empty banner, and EITHER its recorded freshness key still matches the
 * current composite key (bannerFreshnessKey — coord-log ⊕ roster ⊕ posture ⊕
 * team-memory ⊕ drift; #872) AND the coord-log is present (definitively current)
 * OR it was built within BANNER_CACHE_TTL_MS (advisory surfaces tolerate one-
 * session staleness). Returns {ok:false} on missing / corrupt / empty / stale.
 *
 * #872 log-absent handling: when the coord-log is absent the key is NON-
 * authoritative — a "definitely current" verdict off an all-absent key would let
 * `"absent…" === "absent…"` permanently defeat the TTL (the finding). So a coord-
 * log-absent key never sets keyMatches; freshness falls back to the TTL alone.
 *
 * @param {string} repoDir
 * @returns {{ok:true, banner:string} | {ok:false, reason:string}}
 */
function readFreshBannerCache(repoDir) {
  let raw;
  try {
    raw = fs.readFileSync(bannerCachePath(repoDir), "utf8");
  } catch {
    return { ok: false, reason: "no-cache" };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "corrupt" };
  }
  if (
    !obj ||
    typeof obj.banner !== "string" ||
    obj.banner.trim().length === 0
  ) {
    return { ok: false, reason: "empty" };
  }
  const currentKey = bannerFreshnessKey(repoDir);
  // The coord-log is the FIRST composite component; absent → non-authoritative.
  const coordLogAbsent = currentKey.startsWith("absent|");
  const keyMatches =
    !coordLogAbsent && !!obj.log_key && obj.log_key === currentKey;
  const builtAt = typeof obj.built_at === "number" ? obj.built_at : 0;
  const withinTtl = builtAt > 0 && Date.now() - builtAt < BANNER_CACHE_TTL_MS;
  if (keyMatches || withinTtl) return { ok: true, banner: obj.banner };
  return { ok: false, reason: "stale" };
}

/**
 * Write the banner cache atomically + privately (0600). #857 MED-1: the banner
 * carries operator + sibling identities, so the write goes through a private
 * mkdtemp dir (0700, unpredictable suffix) + rename, so a planted symlink at the
 * cache path cannot capture it and no reader ever sees a partial file. Best-
 * effort — never throws.
 *
 * @param {string} repoDir
 * @param {string} banner
 * @param {string} logKey
 * @returns {boolean}
 */
function writeBannerCache(repoDir, banner, logKey) {
  if (typeof banner !== "string" || banner.length === 0) return false;
  let tdir = null;
  try {
    const dir = _learningDir(repoDir);
    fs.mkdirSync(dir, { recursive: true });
    tdir = fs.mkdtempSync(path.join(dir, ".ss-banner-tmp-"));
    const tmp = path.join(tdir, "cache.json");
    const body = JSON.stringify({
      log_key: logKey,
      built_at: Date.now(),
      banner,
    });
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, bannerCachePath(repoDir));
    return true;
  } catch {
    return false;
  } finally {
    if (tdir) {
      try {
        fs.rmSync(tdir, { recursive: true, force: true });
      } catch {
        // best-effort temp cleanup
      }
    }
  }
}

/** Absolute path to the #871 rebuild-dedup lock for a repo. */
function rebuildLockPath(repoDir) {
  return path.join(_learningDir(repoDir), REBUILD_LOCK_FILE);
}

/**
 * #871 rebuild-dedup: try to claim the right to spawn a detached rebuild for the
 * CURRENT coordination-log HEAD generation. Returns true when the caller MAY
 * spawn (lock freshly claimed / reclaimed), false when a FRESH rebuild for the
 * SAME generation is already in flight (skip the spawn — thundering-herd guard).
 *
 * The lock body records {gen, pid, ts}. A caller SKIPS only when an existing lock
 * is BOTH fresh (age < STALE_REBUILD_LOCK_MS) AND names the same coord-log gen —
 * so a NEW coordination event (different gen) always spawns a fresh rebuild, and a
 * CRASHED rebuild's lock is reclaimed once stale (never wedges future rebuilds).
 *
 * Best-effort + never throws: the lock is a spawn OPTIMIZATION, not a correctness
 * gate (writeBannerCache is last-writer-wins atomic), so on ANY error the caller
 * proceeds to spawn (fail-open). Per-clone local state; mode 0600.
 *
 * @param {string} repoDir
 * @returns {boolean} true → spawn; false → a fresh same-gen rebuild is in flight
 */
function tryAcquireRebuildLock(repoDir) {
  const gen = coordinationLogKey(repoDir);
  const lockPath = rebuildLockPath(repoDir);
  const body = JSON.stringify({ gen, pid: process.pid, ts: Date.now() });
  try {
    fs.mkdirSync(_learningDir(repoDir), { recursive: true });
    try {
      // O_CREAT|O_EXCL — atomic against a concurrent claimant; exactly one winner.
      fs.writeFileSync(lockPath, body, { flag: "wx", mode: 0o600 });
      return true; // we created the lock — proceed to spawn
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err; // unexpected → fail-open below
    }
    // A lock exists — age by FILE mtime (set atomically at create, so it does NOT
    // depend on the body having been written yet) + gen by the body (best-effort).
    let st = null;
    try {
      st = fs.statSync(lockPath);
    } catch {
      st = null;
    }
    const fresh = !!st && Date.now() - st.mtimeMs < STALE_REBUILD_LOCK_MS;
    let prevGen = null;
    try {
      prevGen = JSON.parse(fs.readFileSync(lockPath, "utf8")).gen;
    } catch {
      prevGen = null; // unreadable (corrupt OR a winner mid-write)
    }
    // Fresh AND (same generation OR gen-unreadable) → a concurrent/in-flight same-
    // gen rebuild → skip. Treating "unreadable-but-fresh" as skip closes the race
    // where a loser observes the winner's just-created, not-yet-written lock as
    // empty and would otherwise wrongly reclaim it (spawning a duplicate herd).
    if (fresh && (prevGen === gen || prevGen === null)) {
      return false;
    }
    // Stale (crashed rebuild) OR a genuinely different generation → reclaim so a
    // new coordination event / a wedged lock never blocks the next rebuild.
    try {
      fs.rmSync(lockPath, { force: true });
      fs.writeFileSync(lockPath, body, { flag: "wx", mode: 0o600 });
    } catch {
      // A racing reclaimer may have won the re-create; proceed anyway (fail-open).
    }
    return true;
  } catch {
    // Any unexpected FS error → fail-open (spawn); dedup is an optimization only.
    return true;
  }
}

/**
 * SessionStart #866: spawn a DETACHED, UNBUDGETED child that rebuilds the full
 * fold-dependent banner off the critical path and rewrites the banner cache.
 * Modeled on spawnDetachedWorker — own process group, stdio:"ignore", unref'd.
 * The child's fold creates a GPG homedir the pid-liveness reaper SPARES while
 * the rebuild is in flight (the #866↔#867 coupling).
 *
 * #871: guarded by tryAcquireRebuildLock — under a reconnect storm a SECOND
 * concurrent SessionStart that finds a fresh in-progress lock for the same coord-
 * log generation skips its own spawn (returns null) instead of piling on a
 * duplicate UNBUDGETED GPG fold. When repoDir is omitted the guard is skipped
 * (legacy callers / direct invocation), preserving the prior unconditional spawn.
 *
 * @param {string} scriptPath absolute path to the lifecycle hook to re-invoke.
 * @param {string} [repoDir] repo root for the dedup lock (omit to skip the guard).
 * @returns {import('child_process').ChildProcess|null}
 */
function spawnDetachedCacheRebuild(scriptPath, repoDir) {
  try {
    if (repoDir && !tryAcquireRebuildLock(repoDir)) {
      return null; // #871: a fresh same-gen rebuild is already in flight — skip
    }
    const child = spawn(process.execPath, [scriptPath, CACHE_REBUILD_FLAG], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    return child;
  } catch {
    // best-effort: if spawn fails, the caller already emitted a banner — never block.
    return null;
  }
}

module.exports = {
  WORKER_FLAG,
  BANNER_OUT_ENV,
  FOLD_PID_FILENAME,
  CACHE_REBUILD_FLAG,
  spawnDetachedWorker,
  runBoundedWorker,
  reapStaleGpgHomedirs,
  writeFoldPidFile,
  spawnDetachedCacheRebuild,
  tryAcquireRebuildLock,
  rebuildLockPath,
  readFreshBannerCache,
  writeBannerCache,
  coordinationLogKey,
  bannerFreshnessKey,
  bannerCachePath,
};
