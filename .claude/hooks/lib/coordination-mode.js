/**
 * coordination-mode — the single OPT-IN switch for the multi-operator
 * coordination substrate (MO-OPT W1-a, the keystone).
 *
 * workspaces/multi-operator-optional (receipt journal/0330).
 *
 * THE PROBLEM (analysis §A):
 *   `multi-operator-coordination.md`'s claim that the guard hooks are
 *   "no-ops without an operators.roster.json" is FALSE. Four PreToolUse
 *   guards (integrity-guard, journal-write-guard, signing-mutation-guard,
 *   codify-lease) + the operator-id forced-L2 identity path block/halt a
 *   fresh SOLO repo — keyed NOT on roster presence but on independent
 *   preconditions a never-enrolled repo cannot satisfy. There is no shared
 *   on/off switch; engagement is implicit, scattered, mostly fail-open.
 *
 * THE FIX:
 *   ONE shared predicate every gate consults. When it returns OFF, each
 *   gate selects its already-present dormant passthrough/early-return; the
 *   substrate degrades to a true no-op. When it returns ON, every gate
 *   behaves EXACTLY as today (the S6 byte-unchanged invariant — the
 *   predicate adds a single early branch on the OFF path only).
 *
 * PRECEDENCE (highest → lowest; first decisive tier wins):
 *   1. opts.enabled (strict boolean)      — programmatic/test injection.
 *   2. local override file                 — `.claude/learning/coordination-mode.json`
 *      `{ "enabled": <bool> }`. Never-synced state-class file (the SAME
 *      visibility class as posture.json). The ONLY explicit switch a
 *      downstream CONSUMER has — a consumer never receives ecosystem.json.
 *   3. ecosystem.json                      — `coordination.enabled` (strict
 *      boolean) in `.claude/bin/ecosystem.json` (honoring $LOOM_ECOSYSTEM_CONFIG,
 *      the same override the ESM ecosystem-config loader uses). The explicit
 *      switch for loom + a client fork (both carry an ecosystem.json). A
 *      RELOCATED tier-3 config (via $LOOM_ECOSYSTEM_CONFIG or opts) may force
 *      ON but may NOT disable an ENROLLED repo — see § ENROLLED-DISABLE FENCE.
 *   4. implicit                            — roster present AND genesis
 *      anchored (a non-empty `genesis.root_commit`). Back-compat: the ~12
 *      already-enrolled repos stay ON with NO config change, because
 *      "genesis anchored" already means someone deliberately turned this on.
 *   5. default                             — OFF.
 *
 * WHY SYNCHRONOUS + fs-direct (NOT the ESM ecosystem-config.mjs loader):
 *   The four guards are PreToolUse hooks; a synchronous predicate is callable
 *   from ANY guard regardless of whether its decision path is sync or async,
 *   needs no await-refactor (which would risk the S6 byte-unchanged
 *   invariant), and avoids the CJS→ESM `await import()` boundary. The loader's
 *   only unique contribution for THIS predicate is tier-3 (a single optional
 *   boolean), which a sync `fs.readFileSync` + `JSON.parse` reads directly.
 *   We deliberately do NOT replicate the loader's schema_version-fails-loud
 *   gate: the `coordination.enabled` toggle is a shape-stable boolean, and a
 *   predicate consulted inside a guard MUST NEVER throw into the guard
 *   (zero-tolerance.md Rule 3) — every fs/parse failure is caught and the
 *   tier is treated as inconclusive (fall through), with the reason attached
 *   to the result's `warning` field.
 *
 * OBSERVABILITY (G1 R2): the `warning` field rides the RICH result of
 *   coordinationMode(); the ergonomic isCoordinationEnabled() accessor returns
 *   only the boolean and DISCARDS it. The operator-facing surface for a
 *   security-relevant warning (a refused enrolled-disable tamper, or an
 *   indeterminate-enrollment OFF) is multi-operator-sessionstart.js, which calls
 *   coordinationMode() and emits an advisory banner line when result.warning is
 *   present — so the disposition is observable, not silent.
 *
 * RETURN SHAPE (typed so callers/tests can assert WHY, not just WHETHER):
 *   {
 *     enabled: boolean,
 *     source:  "opts" | "local-override" | "ecosystem-config"
 *            | "implicit-roster-genesis"
 *            | "implicit-corrupt-roster-failclosed"   // roster present but unparseable
 *            | "implicit-head-enrolled-failclosed"    // absent/degenerate here, ANCHORED at HEAD
 *            | "default-off",
 *     warning?: string   // present when a tier was skipped (read/parse error)
 *                        // OR a tier-2 / tier-3 enrolled-disable was refused;
 *                        // surfaced operator-side at session-start (see OBSERVABILITY).
 *   }
 *   (the two fail-closed `implicit-*` sources were previously undocumented here;
 *    `implicit-corrupt-roster-failclosed` has shipped since MO-OPT W2-c.)
 *
 * ENROLLED-DISABLE FENCE (#1429 — ONE predicate, BOTH file tiers):
 *   An ENROLLED repo (roster + anchored genesis) MUST NOT be disabled by a config
 *   an operator can write with NO commit / audit trail. Tier 2 has enforced this
 *   since W1 via _refuseEnrolledDisable; tier 3 did NOT, and $LOOM_ECOSYSTEM_CONFIG
 *   (an absolute path, settable from a settings.json/settings.local.json `env`
 *   block that reaches every hook subprocess) re-opened exactly that hole: one
 *   `{"coordination":{"enabled":false}}` file turned the substrate OFF at all 10
 *   gate call sites.
 *
 *   The discriminator is NOT which tier resolved the path — it is whether the
 *   config the predicate actually read is the AUDITABLE in-repo one. So tier 3
 *   routes a `false` through the SAME _refuseEnrolledDisable function tier 2 uses
 *   (rules/security.md § Enforcement-Surface Parity: one shared restrictiveness
 *   function, unrecognized/unresolvable ranked TIGHTEST) unless BOTH hold:
 *     LOCATION (#1429) — the bytes came from the canonical `<repoDir>/.claude/bin/
 *       ecosystem.json`, established from the READ's OWN fd identity (#1447 — see
 *       § SINK-PINNED READ; the prior form re-resolved the path string AFTER
 *       consuming the bytes, a deterministic check-after-use);
 *     COMMIT   (#1441) — the committed blob at HEAD carries the same
 *       `coordination.enabled:false` (see § COMMIT ATTESTATION). "Auditable" means
 *       there is an audit trail, and an uncommitted working-tree write has none.
 *   Both tiers stay ASYMMETRIC — a relocated `true` is still honored (escalating
 *   trust is harmless); only the DISABLE direction is fenced, and only on an
 *   ENROLLED (or indeterminate-enrollment) repo.
 *
 *   TWO EXTENSIONS (loom#1462), because a fence is only as good as the inputs it
 *   trusts and the surfaces that share its decision:
 *     ENV      (F1) — the COMMIT half runs a `git` subprocess, and that subprocess
 *       inherited the ambient environment, so `GIT_DIR` re-pointed the attestation at
 *       an attacker's repository and forged the "committed" blob. The subprocess now
 *       gets an EXPLICIT MINIMAL env and an absolute git path (§ GIT SUBPROCESS
 *       ALLOWLIST) — an allowlist, because the denylist that already carried
 *       `LOOM_ECOSYSTEM_CONFIG` for #1429 still missed the entire git family.
 *     ENROLLMENT (F2) — everything above is gated on "is this repo ENROLLED", and that
 *       question was answered from the WORKING TREE alone. A `{}` written over the
 *       roster made an enrolled repo read as never-enrolled and turned the substrate
 *       OFF with no commit, no config and no warning — cheaper than the vector the
 *       COMMIT half was built for, and reached by going AROUND this fence rather than
 *       through it. The enrollment predicate now carries the same COMMIT dimension
 *       (§ HEAD-ROSTER ATTESTATION), at BOTH surfaces that ask it.
 *
 *   A refused relocation then falls back to the CANONICAL in-repo config before
 *   dropping to tier 4, because the env override REPLACES the tier-3 path: without
 *   the fallback a planted env var could override an AUDITED {enabled:false} into ON.
 *   That direction is fail-safe, but it discards operator intent, so the committed
 *   config gets the last word.
 *
 * Style: CommonJS to match sibling lib/* guard modules. Pure node:fs, no deps.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
// THE shared git-subprocess allowlist (loom#1462 F1). One module, every guard that
// spawns git — per rules/security.md § Enforcement-Surface Parity, two copies of an
// env allowlist is exactly the shape that leaves one of them a variable behind.
const { resolveGitBinary, resetGitBinaryCache, gitEnv } = require("./git-subprocess-env.js");

// O_NOFOLLOW / O_NONBLOCK are POSIX-only; Node leaves them undefined on Windows.
// `| 0` degrades to a plain O_RDONLY there rather than producing NaN flags. The
// Windows residual is recorded at § SINK-PINNED READ.
const _O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const _O_NONBLOCK = fs.constants.O_NONBLOCK || 0;

// Memoize per resolved repoDir for the common (no-injected-opts) call so a
// guard invoking the predicate once per process pays a single read. Injected
// opts ALWAYS recompute (test seam). One-shot hook processes barely benefit
// from the cache; it exists mostly for in-process test ergonomics + any future
// caller that consults the predicate more than once.
let _cache = new Map(); // repoDir -> result

/**
 * Test/CLI hook — drop the memoized results so changed fixtures re-read.
 *
 * Invalidation contract (G1 R1 reviewer LOW-2): the per-repoDir cache holds the
 * FIRST resolved result for the process lifetime. This is correct for the
 * one-shot PreToolUse hook model (each invocation is a fresh process). A
 * long-lived IN-PROCESS caller (a test runner, or a future in-process
 * orchestrator) that resolves a repoDir as OFF and then ENROLLS it mid-process
 * (writes roster+genesis / ecosystem.json / the local override) MUST call
 * _resetCache() after the mutation, or it will be served the stale OFF result.
 */
function _resetCache() {
  _cache = new Map();
  _headRosterCache = new Map(); // loom#1462 H2 — the HEAD-roster verdict memo
  resetGitBinaryCache(); // re-probe the absolute git candidates (loom#1462 F1)
}

// `_readJsonSafe` (a bare `fs.readFileSync` + JSON.parse) was REMOVED in loom#1447.
// Every tier now goes through `_readJsonPinned` below. Deleting it rather than
// leaving it unused is deliberate: an unpinned reader sitting in this module is the
// path of least resistance for the next edit, and it is precisely the shape that
// made the tier-3 fence check-after-use.

/**
 * § SINK-PINNED READ (loom#1447) — read the bytes and capture the file's IDENTITY
 * from the SAME open file descriptor.
 *
 * THE DEFECT THIS REPLACES was not "the check runs late", it was that the check
 * ran against a RE-RESOLUTION of the path string. Tier 3 consumed the config's
 * bytes at the read, then called `fs.realpathSync(candidate)` afterwards to decide
 * whether that path was canonical — two independent resolutions of one string at
 * two instants. A symlink repointed between them yielded a disable sourced from an
 * attacker-controlled file but ATTRIBUTED to the canonical, git-tracked one, with
 * no warning emitted. Measured deterministically (not raced) by parking the reader
 * in `open(2)` on a FIFO and repointing the symlink while it was parked:
 *
 *   CONTROL (symlink NOT repointed) -> enabled:true  + REFUSED warning   CONTROL-FIRED
 *   ATTACK  (repointed mid-read)    -> enabled:false + NO warning        BYPASS
 *
 * MERELY MOVING THE CHECK EARLIER DOES NOT FIX THIS. Check-then-use is the same
 * race with the operands swapped; `rules/security.md` § Path Containment says so
 * explicitly ("necessary-but-not-sufficient … that needs fd-based / `O_NOFOLLOW`
 * enforcement AT the sink"). So the check is not moved — it is BOUND to the read:
 *
 *   - `O_NOFOLLOW` refuses to open a symlink at the final component at all, so the
 *     symlink-swap vector cannot produce an fd in the first place.
 *   - `O_NONBLOCK` makes a FIFO candidate return from `open(2)` immediately instead
 *     of parking the whole PreToolUse hook until a writer appears (the parking WAS
 *     the exploit's timing primitive, and is independently a hang).
 *   - `fstat` on the fd rejects anything that is not a regular file, and yields the
 *     dev/ino of exactly what we are about to read.
 *   - the bytes come from that same fd.
 *
 * The returned `ident` therefore describes the file the decisive bytes came from,
 * not a string that may since have been repointed. Nothing downstream re-resolves
 * the candidate path.
 *
 * WINDOWS RESIDUAL (recorded, not closed): `O_NOFOLLOW` is undefined there, so a
 * directory-junction/symlink candidate is followed. The dev/ino identity check
 * still binds the bytes to the opened file, and the #1441 commit attestation below
 * is platform-independent, so the DISABLE direction stays fenced; what is lost on
 * Windows is only the early refusal of a symlinked candidate.
 *
 * Returns { ok:true, value, ident } | { ok:false, absent:true } | { ok:false, error }.
 */
function _readJsonPinned(p) {
  let fd;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | _O_NOFOLLOW | _O_NONBLOCK);
  } catch (e) {
    if (e && e.code === "ENOENT") return { ok: false, absent: true };
    if (e && (e.code === "ELOOP" || e.code === "EMLINK")) {
      return { ok: false, error: `symlinked config path refused (O_NOFOLLOW): ${p}` };
    }
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      return {
        ok: false,
        error: `not a regular file (${_describeStat(st)}) — refused before read`,
      };
    }
    const raw = fs.readFileSync(fd, "utf8");
    try {
      return {
        ok: true,
        value: JSON.parse(raw),
        ident: { dev: st.dev, ino: st.ino },
      };
    } catch (e) {
      return {
        ok: false,
        error: `parse error: ${e && e.message ? e.message : String(e)}`,
      };
    }
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* the fd is already gone; nothing to release */
    }
  }
}

function _describeStat(st) {
  if (st.isFIFO()) return "FIFO";
  if (st.isDirectory()) return "directory";
  if (st.isSocket()) return "socket";
  if (st.isCharacterDevice() || st.isBlockDevice()) return "device";
  return "not a regular file";
}

function _ecosystemConfigPath(repoDir, opts) {
  if (
    opts &&
    typeof opts.ecosystemConfigPath === "string" &&
    opts.ecosystemConfigPath
  ) {
    return opts.ecosystemConfigPath;
  }
  const env = process.env.LOOM_ECOSYSTEM_CONFIG;
  if (env && env.trim() !== "" && path.isAbsolute(env)) return env;
  return _canonicalEcosystemConfigPath(repoDir);
}

/** The ONE auditable tier-3 location: the git-tracked in-repo ecosystem.json. */
function _canonicalEcosystemConfigPath(repoDir) {
  return path.join(repoDir, ".claude", "bin", "ecosystem.json");
}

/**
 * The ONE canonical roster location. Distinct from `_rosterPath`, which honours the
 * `opts.rosterPath` test injection: an attestation against HEAD must always name the
 * repo's OWN roster, never an injected path that may sit outside the repo entirely.
 */
function _canonicalRosterPath(repoDir) {
  return path.join(repoDir, ".claude", "operators.roster.json");
}

/**
 * Repo-relative POSIX form of an absolute in-repo path, for `git show HEAD:<rel>`.
 *
 * Derived from the canonical-path helpers rather than written as a second inline
 * literal — loom#1422's fragmentation guard is right that a protected path spelled out
 * at N sites is how the NEXT fail-closed dimension gets remembered at N-1 of them, and
 * segment-wise construction is the shape that rule's own control blesses.
 */
function _repoRelPosix(repoDir, absPath) {
  return path.relative(repoDir, absPath).split(path.sep).join("/");
}

/**
 * Did tier-3 read the AUDITABLE in-repo config, or a RELOCATED one (#1429)?
 *
 * Returns true IFF `resolvedPath` is the REAL file sitting at
 * `<repoDir>/.claude/bin/ecosystem.json`. Per rules/security.md § Path Containment
 * BOTH sides go through the SAME resolver (`fs.realpathSync`) before comparison, so
 * a `/tmp`-style symlinked repoDir (macOS `/tmp` → `/private/tmp`,
 * `/var/folders/…` → `/private/var/folders/…`) compares equal instead of spuriously
 * reading as relocated.
 *
 * The candidate is FULLY resolved (final component included) — so a SYMLINK planted
 * at the canonical path whose target escapes the repo reads as RELOCATED (false),
 * which is the intended tightening: a symlinked config serves out-of-tree content
 * and is exactly as un-auditable as an env relocation. The canonical DIRECTORY is
 * additionally required to still resolve inside the repo, so a symlinked
 * `.claude/bin` cannot relocate the canonical location itself.
 *
 * Fails CLOSED: any resolution error (missing canonical dir, permission, race)
 * returns false → "relocated" → the tightest disposition, per § Enforcement-Surface
 * Parity's "unrecognized values ranked TIGHTEST". Never throws into a guard
 * (zero-tolerance.md Rule 3) — the catch converts the error into the SAFE answer,
 * it does not swallow a decision.
 */
function _isCanonicalEcosystemConfig(repoDir, ident) {
  try {
    if (!ident) return false;
    const realRepo = fs.realpathSync(repoDir);
    const realCanonicalDir = fs.realpathSync(
      path.dirname(_canonicalEcosystemConfigPath(repoDir)),
    );
    // CONTAINMENT (adversarial probe P3). Resolving only the DIRECTORY is not
    // enough: a symlinked `.claude/bin` (or `.claude`) pointing out of tree would
    // otherwise RELOCATE the canonical location itself, and a planted off-config
    // there would read as "canonical" and be honored. The resolved canonical dir
    // must therefore still sit at `<realRepo>/.claude/bin` — anything else means
    // the location was moved, which is the same un-auditable condition as an env
    // relocation.
    if (realCanonicalDir !== path.join(realRepo, ".claude", "bin")) return false;
    // IDENTITY, NOT PATH (loom#1447). `lstat` (never `stat`) on the canonical
    // location: a symlink there yields the LINK's own inode, which can never equal
    // the regular-file inode `_readJsonPinned` returns, so the symlinked-canonical
    // refusal #1429 established survives — now by inode disagreement rather than by
    // a realpath comparison of a string that could be repointed after the read.
    const st = fs.lstatSync(path.join(realCanonicalDir, "ecosystem.json"));
    if (!st.isFile()) return false;
    return st.dev === ident.dev && st.ino === ident.ino;
  } catch {
    return false;
  }
}

// § GIT SUBPROCESS ALLOWLIST (loom#1462 F1) — the attestation MUST NOT be steerable by
// the ambient environment. #1441 ran its `git` with no `env:` option, so the child
// inherited it; GIT_DIR outranks repository DISCOVERY (and `-C` only changes DIRECTORY),
// which let ONE ambient variable re-point the attestation at an attacker repository and
// forge the "committed blob at HEAD". Binary resolution + the explicit minimal env now
// live in ONE shared module used by every guard that spawns git — see
// ./git-subprocess-env.js for the measured evidence, for why it is an ALLOWLIST rather
// than another denylist entry, and for the recorded Windows residual.

/**
 * THE SINGLE GIT FRONT DOOR. Every git subprocess this module runs goes through
 * here, under the allowlisted env above. There is deliberately no second helper:
 * two entry points with different error semantics is the seam that produced the
 * #1462/#1475 regress, where one path classified a failure by stderr phrasing and
 * the other by exit code, and the two disagreed about what "not there" means.
 *
 * `_gitRun` RUNS a command and reports HOW IT ENDED. It does NOT decide what the
 * ending MEANS — that is the caller's, because the meaning differs per subcommand
 * (see § WHY STDERR CLASSIFICATION WAS REMOVED, and `_blobAtRef` step 2, which is
 * the one place a definite negative is read, from `ls-tree` exit-0-with-empty).
 *
 * Returns exactly one of:
 *   { ok:true,  stdout }            — git exited 0.
 *   { ok:false, unavailable:<why> } — git could not be RUN to completion (no binary,
 *                                     not executable, timed out / killed by signal).
 *                                     INDETERMINATE — never a negative answer.
 *   { ok:false, status, stderr }    — git RAN and exited non-zero. UNCLASSIFIED here.
 *                                     `stderr` is carried for operator-facing warning
 *                                     TEXT ONLY; nothing in this module may branch on
 *                                     it. Callers rank this tightest (indeterminate ⇒
 *                                     coordination stays ON) unless the specific
 *                                     subcommand makes it a structural answer.
 *
 * Note there is NO bare `{ok:false}` shape: a caller that treats a missing
 * `unavailable` as "git answered no" would reintroduce exactly the laundering the
 * structural replacement removed.
 */
function _gitRun(repoDir, args, opts) {
  const bin = resolveGitBinary(opts);
  if (!bin) {
    return { ok: false, unavailable: "no git binary found (candidates or PATH)" };
  }
  const r = spawnSync(bin, ["-C", repoDir, ...args], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: gitEnv(), // ← the whole point: NOTHING is inherited
  });
  if (r.error) {
    return {
      ok: false,
      unavailable: `git could not be executed (${r.error.code || r.error.message})`,
    };
  }
  if (r.signal) return { ok: false, unavailable: `git killed (${r.signal})` };
  if (r.status !== 0) {
    return { ok: false, status: r.status, stderr: String(r.stderr || "").trim() };
  }
  return { ok: true, stdout: r.stdout };
}

/**
 * Is there a `.git` at `repoDir`, and can it be resolved?
 *
 * Three outcomes, because "nothing is here" and "something is here that I cannot
 * resolve" are different answers (loom#1475 R2-3):
 *   { present:false }                     — genuinely absent. A definite negative,
 *                                           reached WITHOUT a subprocess.
 *   { present:true, unresolvable:reason }  — INDETERMINATE.
 *   { present:true }                       — proceed.
 *
 * USES lstat, NOT stat. `fs.statSync` FOLLOWS symlinks, so a DANGLING `.git`
 * symlink threw ENOENT and was read as ABSENCE — a definite negative — when
 * something demonstrably IS at that path. One `ln -s` produced a silent
 * substrate-OFF, the same shape as the §F6 dangling-roster-symlink finding one
 * layer up, here at the layer that decides whether git is consulted at all.
 *
 * The pre-filter also remains a CORRECTNESS fence, not just a saved subprocess:
 * without it git's repository DISCOVERY walks UP, and an ANCESTOR repository would
 * answer for a directory that is not itself a repo. (A linked worktree's `.git` is
 * a FILE, which lstat finds; repoDir is always the repo root per the @param
 * contract.)
 */
function _gitDirState(repoDir) {
  const p = path.join(repoDir, ".git");
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    if (e && e.code === "ENOENT") return { present: false };
    return {
      present: true,
      unresolvable: `.git at ${p} is not statable (${(e && e.code) || e})`,
    };
  }
  if (st.isSymbolicLink()) {
    try {
      fs.statSync(p); // resolve it; a dangling link throws here
    } catch (e) {
      return {
        present: true,
        unresolvable: `.git at ${p} is a symlink that does not resolve (${(e && e.code) || e})`,
      };
    }
  }
  return { present: true };
}

/** Parse `%(objectname) %(refname)` lines from for-each-ref. */
function _parseRefLines(stdout) {
  return String(stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(" ");
      return i < 0 ? null : { oid: l.slice(0, i), name: l.slice(i + 1) };
    })
    .filter(Boolean);
}

/**
 * § THE ATTESTATION BASE (loom#1475) — `HEAD` is a mutable LOCAL POINTER, not an
 * audit trail. That one sentence is what #1475 and R2-2 both reduce to.
 *
 * THE DEFECT. On a completely healthy enrolled repo:
 *
 *     git update-ref --no-deref HEAD <pre-enrollment-commit>
 *     rm .claude/operators.roster.json
 *
 * turned the substrate OFF at all 10 gate call sites, silently. No commit, no new
 * object, no branch touched, `git status` exit 0, fully reversible — and, measured,
 * `refs/remotes/origin/HEAD` and `refs/heads/main` BOTH still carried the anchored
 * roster throughout. It is indistinguishable from an operator inspecting an old
 * commit, which is why no amount of hardening AROUND a HEAD-based predicate could
 * have caught it: the predicate was answering a different question from the one the
 * fence needs answered. #1441 asked "is this committed?"; the fence needs "does the
 * repo the TEAM sees say this?".
 *
 * THE BASE — an ORDERED candidate list of refs a routine workflow maintains, never
 * HEAD. The first candidate that yields a DEFINITE answer wins:
 *   1. `refs/remotes/origin/HEAD` — the LOCAL record of the default branch, as of
 *      the last clone/fetch, or of the last local write to it (see § NOT THE REMOTE
 *      below the disable-ref function: nothing here contacts a remote).
 *   2. `@{upstream}` — the current branch's tracked remote branch, resolved through
 *      local `branch.<name>.remote`/`.merge` config to another such local record.
 *   3. other remote-tracking refs, then local branch heads (bounded, see CAP).
 *   - none answering => INDETERMINATE.
 *
 * WHY ORDERED-WITH-SHORT-CIRCUIT RATHER THAN ∃ OVER EVERY REF. The first cut of
 * this function read EVERY ref in the base, which is three subprocesses per ref.
 * On the common path — a plain non-COC repo with no working-tree roster and a few
 * hundred remote branches — that is several hundred subprocesses inside a
 * PreToolUse predicate. Measured as a ~17s regression on one session-start test,
 * which is a denial of service on the hook path, not a micro-optimisation.
 *
 * Short-circuiting costs nothing in security, because the ordering is by AUTHORITY
 * and a missing/unresolvable candidate does not end the search — it falls through
 * to the next one, and exhausting the list is INDETERMINATE (fail-closed ON), not
 * "not enrolled". So deleting `refs/remotes/origin/HEAD` to force a fence-off just
 * moves the question to the next candidate, and deleting ALL of them lands on the
 * object-count branch below, which is also indeterminate. There is no ref an
 * attacker can remove that turns the substrate OFF — which is the #1475 property
 * stated as an invariant rather than as a list of blocked commands.
 *
 * CAP: enumerated refs are capped. The cap can only ever cause MORE refs to go
 * unread, and unread refs push toward indeterminate ⇒ ON, so it cannot open a hole.
 *
 * Returns { kind, refs:[{name}] } | { indeterminate: reason }.
 */
const _REF_SCAN_CAP = 25;

function _attestationBaseSet(repoDir, opts) {
  const ordered = [];
  const seen = new Set();
  const push = (name) => {
    if (name && !seen.has(name)) {
      seen.add(name);
      ordered.push({ name });
    }
  };

  // 1 + 2 — the authoritative candidates, resolved directly (no enumeration).
  for (const ref of ["refs/remotes/origin/HEAD", "@{upstream}"]) {
    const r = _gitRun(
      repoDir,
      ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      opts,
    );
    if (r.unavailable) return { indeterminate: r.unavailable };
    if (r.ok && r.stdout.trim()) push(ref);
  }

  // 3 — the remaining refs, remote-tracking before local, capped.
  let anyRef = ordered.length > 0;
  for (const [glob, kind] of [
    ["refs/remotes", "remote-tracking"],
    ["refs/heads", "local-branch"],
  ]) {
    const r = _gitRun(
      repoDir,
      [
        "for-each-ref",
        `--count=${_REF_SCAN_CAP}`,
        "--format=%(objectname) %(refname)",
        glob,
      ],
      opts,
    );
    if (r.unavailable) return { indeterminate: r.unavailable };
    if (!r.ok) {
      return {
        indeterminate: `git could not enumerate ${glob} (${r.stderr || `exit ${r.status}`})`,
      };
    }
    const refs = _parseRefLines(r.stdout);
    if (refs.length) anyRef = true;
    for (const x of refs) push(x.name);
    void kind;
  }

  if (ordered.length) {
    return {
      kind: ordered[0].name.startsWith("refs/heads/")
        ? "local-branch"
        : "remote-tracking",
      refs: ordered,
    };
  }
  void anyRef;

  // NO REFS AT ALL. Two very different repos land here, and `for-each-ref` answers
  // both with the same exit-0-and-empty:
  //
  //   a genuinely EMPTY repo   `git init`, nothing ever committed  — an ANSWER
  //   an enrolled repo whose   `git update-ref -d refs/heads/main` — a REFUSAL
  //     refs were DELETED
  //
  // The second is #1475 in a different spelling: delete the refs instead of moving
  // HEAD and the base set vanishes, so treating no-refs as "not enrolled" would
  // reopen the exact hole under a new command. But treating it as indeterminate
  // unconditionally makes every freshly `git init`ed scratch directory
  // coordination-ON, which is precisely the fresh-solo-repo disruption the MO-OPT
  // W1-a fix exists to prevent.
  //
  // OBJECT COUNT separates them structurally, with no prose. A repo that never
  // committed anything holds ZERO objects; a repo whose refs were deleted still
  // holds its history, merely unreferenced. Measured: empty = 0, refs-deleted = 4.
  const co = _gitRun(repoDir, ["count-objects", "-v"], opts);
  if (co.unavailable) return { indeterminate: co.unavailable };
  if (!co.ok) {
    return {
      indeterminate: `git could not count objects (${co.stderr || `exit ${co.status}`})`,
    };
  }
  const loose = /^count:\s*(\d+)/m.exec(co.stdout);
  const packed = /^in-pack:\s*(\d+)/m.exec(co.stdout);
  const total = (loose ? +loose[1] : 0) + (packed ? +packed[1] : 0);
  if (total === 0) {
    // ANSWERED: nothing was ever committed here, so no committed roster can exist.
    return { kind: "empty-repo", refs: [] };
  }
  return {
    indeterminate:
      `no remote-tracking ref and no local branch head, but the repository still holds ` +
      `${total} object(s) — history exists that nothing references, so this repo's ` +
      `enrollment cannot be read (deleting refs is not a disable; HEAD alone is not an ` +
      `audit trail)`,
  };
}

/**
 * § REVIEW vs COMMIT (loom#1472) — the SINGLE authoritative ref for a DISABLE.
 *
 * #1441's attestation proved a commit OBJECT exists. It did not prove the change was
 * REVIEWED, and a local scratch commit satisfies "exists" completely: `git log` shows
 * it, nothing pushed it, no branch protection and no reviewer ever saw it.
 *
 * The remote-tracking re-cut narrows the disable surface, but only if that surface uses
 * a SINGLE ref rather than the base SET. Under "any ref in the set" an attacker could
 * push an unmerged side branch carrying `{enabled:false}` and attest against that. So
 * the disable attests against ONE ref — `refs/remotes/origin/HEAD`, falling back to the
 * current branch's upstream.
 *
 * § NOT THE REMOTE (loom#1480) — READ THIS BEFORE RELYING ON THE REF'S STRENGTH.
 * This function does NOT ask the remote anything, and neither does anything it calls.
 * The complete set of git subcommands this module ever runs is `rev-parse`,
 * `for-each-ref`, `count-objects`, `ls-tree` and `cat-file` (all via `_gitRun`) — every
 * one a read of the LOCAL ref store and the LOCAL object database. There is no `fetch`,
 * no `ls-remote`, no network of any kind.
 *
 * So `refs/remotes/origin/HEAD` is NOT "the default branch as the remote reports it".
 * It is an ordinary local ref — a loose file under `.git/refs/` (or a `packed-refs`
 * entry) — recording what a fetch last wrote, and it is writable by any process that
 * can write the repository, with no network, no push, no reviewer and no branch
 * protection:
 *
 *     git update-ref    refs/remotes/origin/main <local-commit>
 *     git symbolic-ref  refs/remotes/origin/HEAD refs/remotes/origin/main
 *
 * WHAT THE REF STILL BUYS, stated precisely, because it is not nothing: the disable must
 * live in a commit THE ATTESTED REF ACTUALLY RESOLVES TO — `_blobAtRef` resolves the ref
 * to a commit and reads the blob out of THAT commit's tree. So a working-tree-only or
 * staged-only disable is refused (nothing outside a commit is reachable this way — the
 * #1441 property), and so is a disable committed locally while the attested ref still
 * points somewhere else (the #1472 property — the CONTROL row of
 * `coordination-mode-forged-remote-tracking-ref.test.mjs` asserts exactly that case, and
 * passes today). What it does NOT establish is REVIEW, which is the property the
 * § REVIEW vs COMMIT framing above was reaching for: a locally-forged ref satisfies this
 * attestation and — unlike every earlier defeat in this family — does so with NO
 * `warning` on the result. That defeat is loom#1480; its RED rows are committed and
 * currently FAILING by design. Do not read the paragraphs above as evidence that the
 * fence is stronger than this.
 *
 * NOTE THE DELIBERATELY DIFFERENT QUANTIFIERS, and that both point the SAME way:
 *   ENROLLMENT uses ∃ over the base set — any ref showing enrollment keeps the
 *     substrate ON, so concluding "not enrolled" requires EVERY ref to answer no.
 *   DISABLE uses ONE ref — narrowing the surface to a single candidate, which bounds
 *     WHERE a disable may sit but does not establish that anyone reviewed it.
 * Each surface ranks its ambiguous case so the substrate stays ON, which is
 * `rules/security.md` § Enforcement-Surface Parity's unrecognized-ranked-TIGHTEST read
 * correctly: "tightest" is a DISPOSITION (more enforcement), not a quantifier.
 *
 * Returns { ref } | { indeterminate: reason }.
 */
function _authoritativeDisableRef(repoDir, opts) {
  for (const ref of ["refs/remotes/origin/HEAD", "@{upstream}"]) {
    const r = _gitRun(
      repoDir,
      ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      opts,
    );
    if (r.unavailable) return { indeterminate: r.unavailable };
    if (r.ok && r.stdout.trim()) return { ref };
  }
  return {
    indeterminate:
      "no refs/remotes/origin/HEAD and no upstream for the current branch — there is " +
      "no reviewed ref to attest a disable against (a local commit proves an object " +
      "exists, not that anyone reviewed it)",
  };
}

/**
 * The structural three-step blob read at `ref`. See § WHY STDERR CLASSIFICATION WAS
 * REMOVED for why every step is an exit code and never a phrase.
 *
 * Returns { text } | { absent:true } | { unavailable: reason }.
 */
function _blobAtRef(repoDir, ref, repoRelPath, opts) {
  // STEP 1 — does the ref name a commit? Failure here is unambiguously a refusal.
  const rp = _gitRun(
    repoDir,
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    opts,
  );
  if (rp.unavailable) return { unavailable: rp.unavailable };
  if (!rp.ok || !rp.stdout.trim()) {
    return { unavailable: `ref ${ref} does not resolve to a commit` };
  }
  const commit = rp.stdout.trim();

  // STEP 2 — the ONLY definite negative in this design: a tree read SUCCESSFULLY
  // that does not contain the path.
  const lt = _gitRun(
    repoDir,
    ["ls-tree", "--full-tree", "-z", commit, "--", repoRelPath],
    opts,
  );
  if (lt.unavailable) return { unavailable: lt.unavailable };
  if (!lt.ok) {
    return {
      unavailable: `git could not read the tree of ${ref} (${lt.stderr || `exit ${lt.status}`})`,
    };
  }
  const entry = String(lt.stdout || "")
    .replace(/\0/g, "")
    .trim();
  if (!entry) return { absent: true }; // ANSWERED: not tracked at this ref
  const m = /^\d+\s+blob\s+([0-9a-f]+)\s/.exec(entry);
  if (!m) {
    // A tree or a gitlink where a blob was expected. Not "absent" — something IS
    // there and it is not a shape we can read. Indeterminate, per
    // unrecognized-ranked-TIGHTEST.
    return {
      unavailable: `${repoRelPath} at ${ref} is not a blob (${entry.split("\n")[0]})`,
    };
  }

  // STEP 3 — read by OID, so nothing re-resolves the path or the ref.
  const cf = _gitRun(repoDir, ["cat-file", "blob", m[1]], opts);
  if (cf.unavailable) return { unavailable: cf.unavailable };
  if (!cf.ok) {
    return {
      unavailable: `git could not read blob ${m[1]} (${cf.stderr || `exit ${cf.status}`})`,
    };
  }
  return { text: cf.stdout };
}

/**
 * § WHY STDERR CLASSIFICATION WAS REMOVED (loom#1475 R2-2).
 *
 * #1462 H2-c classified a non-zero `git show` by matching its stderr against a
 * POSITIVE ALLOWLIST of phrasings that supposedly mean "git ANSWERED: nothing is
 * there". That allowlist could not be repaired, and the reason is an IMPOSSIBILITY
 * rather than a tuning problem. Measured on git 2.50.1 (Apple Git-155):
 *
 *   repo with no commits yet    `fatal: invalid object name 'HEAD'.`    an ANSWER
 *   HEAD -> unresolvable ref    `fatal: invalid object name 'HEAD'.`    a REFUSAL
 *
 * Byte-identical; semantically opposite. The first is the exact case #1462 H2's own
 * commit message cited to JUSTIFY the allowlist entry. The second is a repository
 * whose enrollment git flatly cannot report. No predicate over those bytes can
 * separate them, so the allowlist necessarily laundered one of the two — and it
 * laundered the dangerous one, silently, toward "not enrolled" and substrate OFF.
 * The same laundering is what made #1475 quiet: a detached pre-enrollment HEAD emits
 * `does not exist in 'HEAD'`, also on the allowlist, so the `indeterminate` branch
 * #1462 H2 had just added could never fire for it.
 *
 * `coordination-mode-head-recut-1475.test.mjs` re-measures BOTH states on the host
 * and asserts byte EQUALITY, so this claim reds loudly on a git that phrases them
 * differently instead of resting on a recorded observation.
 *
 * THE REPLACEMENT IS STRUCTURAL — three steps, exit codes only, zero prose:
 *
 *   1. `rev-parse --verify --quiet <ref>^{commit}`
 *        non-zero  => the ref does not name a commit. Unambiguously a REFUSAL.
 *   2. `ls-tree --full-tree -z <commit> -- <path>`
 *        non-zero            => the tree could not be read. REFUSAL.
 *        exit 0 + EMPTY      => ANSWERED: the path is genuinely not tracked here.
 *        exit 0 + blob entry => proceed, carrying the blob OID.
 *   3. `cat-file blob <oid>`
 *        non-zero  => REFUSAL.
 *
 * Step 2 is the load-bearing one. `ls-tree` is the only shape on this surface that
 * reports "absent from a tree I read successfully" as SUCCESS-with-empty-output
 * rather than as an error — which is exactly the ANSWERED-no / CANNOT-ANSWER
 * distinction the allowlist was trying, and failing, to reconstruct from prose.
 * Reading it collapses the whole locale / git-version / phrasing surface at once,
 * and it satisfies `rules/hook-output-discipline.md` MUST-2 structurally: the
 * decision is no longer a lexical signal at all.
 *
 * `_gitRun` still CARRIES stderr on its failure shape, for operator-facing warning
 * text only. Nothing in this module may branch on it.
 */

/**
 * § COMMIT ATTESTATION (loom#1441) — is the DISABLE we are about to honour actually
 * present in the COMMITTED config?
 *
 * The property that carries the security meaning here is NOT the config's location.
 * This module's own stated guarantee is that disabling an ENROLLED repo is possible
 * only via the "COMMITTED, auditable" ecosystem.json — and tier 2's
 * `_refuseLocalDisable` exists precisely because a file an operator can write with
 * NO commit / audit trail must not carry that authority. An UNCOMMITTED file at the
 * canonical path has exactly that property while receiving exactly that authority.
 * Location-checking admits it; only commit-state checking excludes it.
 *
 * So the audited-disable predicate is: the committed blob at HEAD must ITSELF say
 * `coordination.enabled === false`. Working-tree agreement with HEAD is the audit
 * trail — `git log` / `git show` can be asked who turned it off and when.
 *
 * WHY COMPARE THE DECISIVE VALUE, NOT THE BYTES. A byte-equality check against the
 * blob is defeated by `core.autocrlf` on Windows (working tree CRLF vs blob LF) and
 * by any whitespace-only reformat, both of which would produce a FALSE refusal
 * without adding security. The decisive value is what tier 3 acts on, so the
 * decisive value is what must be attested.
 *
 * NOT TOCTOU-ABLE. Both operands are values we already hold: the boolean parsed from
 * our pinned fd, and the boolean parsed from git's output. Swapping the file on disk
 * mid-flight cannot make an uncommitted `false` attest — the committed blob is
 * unaffected by working-tree writes.
 *
 * COST. The subprocess fires ONLY on the rare path: `enabled === false` AND the
 * candidate already identified as canonical AND (downstream) an enrolled repo. Every
 * ordinary resolution — force-ON, no `coordination` key (loom's own shape), a
 * non-enrolled consumer — never reaches it, and the result is memoized per repoDir.
 * That is what makes a git call affordable inside a sync PreToolUse predicate; the
 * module header previously ruled one out on a cost argument that assumed it would
 * run on every resolution.
 *
 * FAILS CLOSED. Not a git repo, no HEAD, path not tracked at HEAD, git absent,
 * timeout, unparseable blob — every one returns false ⇒ NOT attested ⇒ the disable
 * is refused for an enrolled repo, per § Enforcement-Surface Parity's "unrecognized
 * values ranked TIGHTEST". Never throws into a guard (zero-tolerance.md Rule 3).
 */
function _committedDisableAttested(repoDir, opts) {
  // UNAVAILABLE is reported separately from NOT-ATTESTED (loom#1462 F1). Both refuse
  // the disable; they differ in what the operator is told, and telling an operator
  // "not committed" when the real problem is a missing git sends them to fix the
  // wrong thing (rules/evidence-first-claims.md MUST-4 — do not state an inference
  // in the grammar of an observation).
  const gd = _gitDirState(repoDir);
  if (!gd.present) return { attested: false };
  if (gd.unresolvable) return { attested: false, unavailable: gd.unresolvable };

  // loom#1472 — a SINGLE authoritative ref, not HEAD and not the base set.
  const auth = _authoritativeDisableRef(repoDir, opts);
  if (auth.indeterminate) {
    return { attested: false, unavailable: auth.indeterminate };
  }

  const b = _blobAtRef(
    repoDir,
    auth.ref,
    _repoRelPosix(repoDir, _canonicalEcosystemConfigPath(repoDir)),
    opts,
  );
  if (b.unavailable) {
    return { attested: false, unavailable: b.unavailable, ref: auth.ref };
  }
  // ANSWERED: the attested ref carries no disable. ("attested", not "reviewed" —
  // resolving this ref establishes no review; see § NOT THE REMOTE, loom#1480.)
  if (b.absent) return { attested: false, ref: auth.ref };
  try {
    const committed = JSON.parse(b.text);
    return {
      attested: Boolean(
        committed &&
          committed.coordination &&
          committed.coordination.enabled === false,
      ),
      ref: auth.ref,
    };
  } catch {
    return { attested: false, ref: auth.ref };
  }
}

/**
 * § HEAD-ROSTER ATTESTATION (loom#1462 F2) — does the COMMITTED roster say this repo
 * is enrolled, even though the WORKING-TREE roster no longer does?
 *
 * THE DEFECT this closes is `rules/security.md` § Enforcement-Surface Parity in its
 * literal form. #1441 landed a fail-closed COMMIT dimension at the ecosystem-config
 * surface and left the SIBLING surface reaching the same decision — the ENROLLMENT
 * predicate — reading the raw working tree with no attestation at all. Overwriting
 * `.claude/operators.roster.json` with `{}` (valid JSON, an object, no `genesis`) makes
 * an enrolled repo read as never-enrolled: `_refuseEnrolledDisable` honours, tier 4
 * yields no result, tier 5 returns default-off. The substrate goes OFF with no
 * ecosystem.json, no commit, no git object and NO WARNING — strictly cheaper than the
 * vector #1441 was filed against, and it goes AROUND that fence rather than through it,
 * because the enrollment predicate gates BOTH the attestation and integrity-guard's
 * Edit fence (integrity-guard.js:328).
 *
 * So "tracked at HEAD with anchored genesis, absent-or-degenerate in the WORKING TREE"
 * is INDETERMINATE → fail-closed ON, symmetric with #1441's disposition for the config.
 *
 * TRI-STATE, because "no" and "cannot tell" are different answers (loom#1462 H2).
 *
 * The first cut of this function was EVIDENCE-POSITIVE (`if (!r.ok) return false`), and
 * that was wrong in a specific, load-bearing way: the SAME `{ok:false}` that
 * `_committedDisableAttested` ranks TIGHTEST, this ranked LOOSEST — fence off, substrate
 * OFF, and SILENT. One condition cannot be tightest at one surface and loosest at its
 * sibling; that is `rules/security.md` § Enforcement-Surface Parity applied to this
 * module's own two surfaces.
 *
 * THE PRIOR RATIONALE WAS ALSO FACTUALLY WRONG, and is corrected here rather than
 * softened (`rules/evidence-first-claims.md` MUST-4). It claimed "the residual is
 * bounded: an attacker who can also remove git from the box is already past this
 * module." NO REMOVAL IS REQUIRED. The host layout supplies the condition: nix, asdf,
 * conda, Homebrew-on-Linux, Scoop and GitHub Desktop all install git outside the
 * candidate list, so on those hosts the fence simply did not exist and the `{}`-roster
 * defeat worked as originally filed — no attacker, no tampering. That sentence asserted
 * an inference in the grammar of an observation.
 *
 * So: `"enrolled"` (HEAD carries an anchored roster) · `"not-enrolled"` (git ANSWERED —
 * nothing is there) · `"indeterminate"` (git could not answer). Callers fail CLOSED on
 * indeterminate and say so out loud.
 *
 * WHAT KEEPS THIS FROM DISRUPTING SOLO REPOS — the reason a blanket fail-closed is safe
 * here. "Indeterminate" is now genuinely rare, on two independent counts: binary
 * discovery falls back to a PATH search (`git-subprocess-env.js` stage 2), and a
 * directory with no `.git` at all is answered by the pre-filter WITHOUT git. A fresh
 * solo repo therefore reaches `"not-enrolled"` by a real answer and stays OFF — the
 * MO-OPT W1-a disruption fix is untouched, and the tests pin both halves.
 *
 * RESIDUAL — RESTATED to match the REACHABLE set (loom#1475 R2-5). The shipped
 * sentence read: "a directory that HAS a `.git` on a machine with NO reachable git
 * binary at all resolves indeterminate → ON". That named ONE member of the set and
 * presented it as the whole of it, so the documented fence was narrower than the real
 * one — and a residual that under-describes its own fence is how the next session
 * concludes a reachable state is unreachable. Every state below resolves indeterminate
 * → ON, and only the FIRST is about a missing binary:
 *
 *   (a) `.git` present, NO reachable git binary — the originally-documented case.
 *   (b) `.git` present but UNRESOLVABLE (a dangling symlink) — R2-3. git may be
 *       perfectly reachable.
 *   (c) refs exist but EVERY candidate fails to read (broken/missing objects) — the
 *       question was asked and could not be answered.
 *   (d) NO refs at all while the object store is NON-EMPTY — unreferenced history,
 *       i.e. `git update-ref -d` on every ref. git ran fine throughout.
 *   (e) a committed roster that EXISTS at a candidate but does not parse.
 *
 * (b)–(e) all occur with git fully reachable, which is precisely what the old sentence
 * denied. `coordination-mode-head-recut-1475.test.mjs` pins (b), (c), (d) and asserts
 * the emitted warning does NOT misattribute them to a missing binary.
 *
 * In every one of these a repo cannot then opt out via the local override either (the
 * refusal fence ranks it the same way, by design), so it is coordination-ON until the
 * underlying condition is fixed. That is the deliberate trade: a rare, loud, recoverable
 * false-block instead of a silent, host-supplied hole.
 *
 * NOT in the residual — the ANSWERED cases, which stay OFF with no disruption: a
 * directory with no `.git` (pre-filter, no subprocess); a candidate ref read
 * successfully that carries no roster; and an EMPTY repository (zero objects), which is
 * the fresh-`git init` scratch directory the MO-OPT W1-a disruption fix protects.
 *
 * COST. Fires only when the working-tree roster is absent-or-degenerate — an ENROLLED
 * repo (the common ON case) resolves at tier 4 without ever reaching it, and the `.git`
 * pre-filter in `_gitDirState` keeps non-git directories subprocess-free. The candidate
 * list SHORT-CIRCUITS on the first definite answer, so the ordinary cost is one ref's
 * worth of work (three subprocesses) and not one per branch — see § THE ATTESTATION
 * BASE for the measured regression that made that ordering load-bearing. The result is
 * memoized per repoDir, and hook processes are one-shot.
 *
 * Uses the SAME `_isGenesisAnchored` predicate as tier 4 and `_refuseEnrolledDisable`,
 * so a PLACEHOLDER genesis reads as not-anchored at the attestation ref exactly as it
 * does in the worktree — `/clean-instantiate` commits its cleared tree, so a
 * freshly-cleared client
 * still comes up OFF.
 */
let _headRosterCache = new Map(); // repoDir -> verdict

function _committedRosterEnrolled(repoDir, opts) {
  // Memoized per repoDir: tier 4 and _refuseEnrolledDisable both consult this within
  // one resolution, and each consult is a subprocess. Injected opts always recompute
  // (test seam), mirroring coordinationMode's own cache discipline.
  const injected = Boolean(
    opts && (opts.rosterPath || opts.gitBin || opts.gitCandidates || opts.gitPath),
  );
  if (!injected && _headRosterCache.has(repoDir)) return _headRosterCache.get(repoDir);
  const verdict = _computeCommittedRosterEnrolled(repoDir, opts);
  if (!injected) _headRosterCache.set(repoDir, verdict);
  return verdict;
}

function _computeCommittedRosterEnrolled(repoDir, opts) {
  const gd = _gitDirState(repoDir);
  if (!gd.present) return { state: "not-enrolled" }; // answered without a subprocess
  if (gd.unresolvable) {
    return { state: "indeterminate", reason: gd.unresolvable };
  }

  // loom#1475 — the base is the REF SET a routine workflow maintains, never HEAD.
  const base = _attestationBaseSet(repoDir, opts);
  if (base.indeterminate) {
    return { state: "indeterminate", reason: base.indeterminate };
  }

  // ANSWERED WITHOUT READING A REF: the repository holds no objects at all, so no
  // committed roster can exist anywhere in it. This is the fresh-`git init` scratch
  // directory, and it must stay OFF (see § THE ATTESTATION BASE, object-count branch).
  if (base.kind === "empty-repo") return { state: "not-enrolled", kind: base.kind };

  const rel = _repoRelPosix(repoDir, _canonicalRosterPath(repoDir));
  const unanswered = [];
  // ORDERED, SHORT-CIRCUITING: the FIRST candidate that answers definitively decides.
  // A candidate that cannot be read is recorded and skipped — it never decides, so an
  // unreadable authoritative ref falls through to the next rather than resolving the
  // question the attacker's way. Exhausting the list without a definite answer is
  // INDETERMINATE, never "not enrolled".
  for (const ref of base.refs) {
    const b = _blobAtRef(repoDir, ref.name, rel, opts);
    if (b.unavailable) {
      unanswered.push(`${ref.name}: ${b.unavailable}`);
      continue;
    }
    if (b.absent) {
      // DEFINITE: this ref was read successfully and carries no roster.
      return { state: "not-enrolled", via: ref.name, kind: base.kind };
    }
    try {
      const v = JSON.parse(b.text);
      const anchored = Boolean(
        v &&
          typeof v === "object" &&
          !Array.isArray(v) &&
          v.genesis &&
          _isGenesisAnchored(v.genesis),
      );
      // DEFINITE either way: the blob was read and parsed.
      return {
        state: anchored ? "enrolled" : "not-enrolled",
        via: ref.name,
        kind: base.kind,
      };
    } catch (e) {
      // The blob EXISTS but does not parse. That is a corrupt committed roster, not
      // evidence of non-enrollment — the same reasoning tier 4 already applies to a
      // corrupt WORKING-TREE roster (W2-c). Indeterminate, not a clean negative, so
      // it does NOT decide; fall through to the next candidate.
      unanswered.push(
        `${ref.name}: committed roster is unparseable (${e && e.message ? e.message : String(e)})`,
      );
    }
  }

  // Every candidate failed to answer. The honest verdict is indeterminate — the same
  // ranking the disable surface applies to its own unavailable case
  // (rules/security.md § Enforcement-Surface Parity).
  return {
    state: "indeterminate",
    reason: `enrollment could not be read at any of ${base.refs.length} ${base.kind} ref(s) — ${unanswered.join("; ")}`,
  };
}

function _localOverridePath(repoDir, opts) {
  if (
    opts &&
    typeof opts.localOverridePath === "string" &&
    opts.localOverridePath
  ) {
    return opts.localOverridePath;
  }
  return path.join(repoDir, ".claude", "learning", "coordination-mode.json");
}

function _rosterPath(repoDir, opts) {
  if (opts && typeof opts.rosterPath === "string" && opts.rosterPath) {
    return opts.rosterPath;
  }
  return path.join(repoDir, ".claude", "operators.roster.json");
}

/**
 * Is the multi-operator coordination substrate enabled for `repoDir`?
 *
 * @param {string} repoDir - absolute repo root (the MAIN checkout; callers
 *   inside a worktree resolve via state-resolver first, mirroring the other
 *   guards' main-checkout discipline).
 * @param {object} [opts]
 * @param {boolean} [opts.enabled] - programmatic override (tier 1).
 * @param {string} [opts.ecosystemConfigPath] / [opts.localOverridePath] /
 *   [opts.rosterPath] - path injection (tests).
 * @returns {{enabled: boolean, source: string, warning?: string}}
 */
function coordinationMode(repoDir, opts) {
  const o = opts || {};
  const rd = repoDir || process.cwd();

  // G1 R1 reviewer LOW-1: the `enabled` clause requires a BOOLEAN, symmetric
  // with tier-1 below — a non-boolean `enabled` (e.g. {enabled:"yes"}) is NOT a
  // valid programmatic override, so it neither bypasses the cache here nor fires
  // tier-1; it is uniformly ignored and resolution falls through to the file
  // tiers. Path injections always bypass the cache (tests).
  const injected =
    (Object.prototype.hasOwnProperty.call(o, "enabled") &&
      typeof o.enabled === "boolean") ||
    o.ecosystemConfigPath ||
    o.localOverridePath ||
    o.rosterPath ||
    o.gitBin ||
    o.gitCandidates ||
    typeof o.gitPath === "string";

  if (!injected && _cache.has(rd)) return _cache.get(rd);

  const warnings = [];
  let result;

  // Tier 1 — programmatic override.
  if (
    Object.prototype.hasOwnProperty.call(o, "enabled") &&
    typeof o.enabled === "boolean"
  ) {
    result = { enabled: o.enabled, source: "opts" };
  }

  // Tier 2 — local override file (the consumer escape hatch; never-synced).
  //
  // SECURITY — ASYMMETRIC PRECEDENCE (G1 R1 security-reviewer HIGH). The local
  // override is gitignored state an operator can write with NO commit / audit
  // trail. If it could force OFF, a malicious operator on an ENROLLED repo could
  // write {enabled:false}, silently disable the WHOLE substrate (integrity-guard
  // codify-branch enforcement included), then edit operators.roster.json
  // off-codify to add themselves as owner — an escalation the pre-W1 substrate
  // did not permit. So the local override may:
  //   - FORCE ON (enabled:true) — always honored (harmless escalation of trust);
  //   - set the mode on a genuinely NON-enrolled repo — the consumer opt-in/out;
  // but a {enabled:false} is REFUSED when the repo is ENROLLED (roster + anchored
  // genesis) OR its enrollment is INDETERMINATE (roster present-but-unreadable —
  // fail-safe toward keeping the substrate ON; G1 R2 reviewer + cc-architect LOW).
  // The refusal attaches result.warning — the LOAD-BEARING guarantee is the ON
  // disposition; the warning is surfaced operator-side at session-start
  // (multi-operator-sessionstart.js, G1 R2) so a planted-override tamper is NOT
  // silent.
  //
  // WHAT THIS MODULE ACTUALLY GUARANTEES (#1429 — corrected; the prior wording
  // claimed tier 3 was inherently "the COMMITTED, auditable ecosystem.json", which
  // was FALSE while $LOOM_ECOSYSTEM_CONFIG could relocate tier 3 to any absolute
  // path with no refusal). Disabling an ENROLLED repo now requires ONE of:
  //   (a) `<repoDir>/.claude/bin/ecosystem.json` — the canonical in-repo path, which
  //       is git-TRACKED, so any change to it shows up in `git status` / `git diff`
  //       and is reviewable. A config reached by relocation (env or opts) is REFUSED;
  //       so is a SYMLINK at the canonical path pointing out of tree.
  //   (b) a genesis teardown ceremony (de-anchor / remove the roster).
  //   (c) the in-process tier-1 `opts.enabled` seam — reachable ONLY by code already
  //       executing inside the guard process, NOT by settings.json `env`, the shell
  //       environment, or any on-disk config.
  // COMMIT STATE IS NOW VERIFIED AT RUNTIME (loom#1441 — this paragraph previously
  // recorded the opposite as an accepted residual). Clause (a) means BOTH properties,
  // and a disable that satisfies only the first is REFUSED:
  //   LOCATION — the bytes came from the canonical in-repo file (#1429, and since
  //     #1447 established by the read's own fd identity rather than by re-resolving
  //     the path string afterwards);
  //   COMMIT   — `HEAD:.claude/bin/ecosystem.json` ITSELF carries
  //     `coordination.enabled:false` (§ COMMIT ATTESTATION). An uncommitted or
  //     working-tree-only disable has no audit trail, which is the exact property
  //     tier 2's refusal exists to exclude, so it is now excluded here too.
  //   The two agent-write lanes remain fenced independently: `.claude/bin/
  //   ecosystem.json` is a row in the shared protected-path registry
  //   (lib/guard-path-scope.js), covering Bash (STATE_PATH_RX incl. the Layer-3
  //   interpreter-body form) and Edit/Write (integrity-guard's DIRECT set,
  //   enrolled-gated so /ecosystem-init on a fresh fork is unaffected). That fence
  //   stops the AGENT vector; the attestation above stops the NON-agent one (a plain
  //   editor, an operator-run script, any process outside the tool boundary), which
  //   the fence alone could not reach.
  // RESIDUAL, stated precisely: attestation proves the disable is COMMITTED, not that
  //   the commit was legitimate. An operator who can commit AND push can still disable
  //   the repo — by design; that is the audited route, and it leaves the `git log`
  //   entry the whole guarantee is built on. What is no longer possible is a disable
  //   that leaves NO trace in git.
  // And editing THIS module's
  // own source defeats every tier — the standard "a guard cannot guard its own
  // source" boundary (settings-deny-guard-shape.js § TRUST BOUNDARY), covered at
  // design time by the self-referential-codify gate + git history, not at runtime.
  if (!result) {
    const lp = _localOverridePath(rd, o);
    // Sink-pinned like every other tier (loom#1447). Nothing about tier 2 needs a
    // laxer read, and leaving one unpinned reader in the module is how the next
    // edit re-adopts the fail-open shape.
    const r = _readJsonPinned(lp);
    if (r.ok && r.value && typeof r.value.enabled === "boolean") {
      const refuseReason =
        r.value.enabled === false ? _refuseEnrolledDisable(rd, o) : null;
      if (refuseReason) {
        warnings.push(
          `local-override {enabled:false} REFUSED — ${refuseReason}; ` +
            "disable an enrolled repo via committed ecosystem.json instead",
        );
      } else {
        result = { enabled: r.value.enabled, source: "local-override" };
      }
    } else if (!r.ok && r.error) {
      warnings.push(`local-override unreadable (${lp}): ${r.error}`);
    }
  }

  // Tier 3 — ecosystem.json explicit switch.
  //
  // SECURITY — RELOCATED-DISABLE FENCE (#1429). Structurally identical to tier-2's
  // asymmetric precedence above, and routed through the SAME _refuseEnrolledDisable
  // function (§ ENROLLED-DISABLE FENCE in the header). $LOOM_ECOSYSTEM_CONFIG — or an
  // injected opts.ecosystemConfigPath — can point tier 3 at ANY absolute path; such a
  // file is NOT committed and carries NO audit trail, so honoring a `false` from it
  // was the master-switch bypass (one write → OFF at all 10 gate call sites). A
  // relocated config may still force ON; only the DISABLE direction is fenced, and
  // only on an ENROLLED (or indeterminate-enrollment) repo — a genuinely un-enrolled
  // consumer keeps its opt-out from wherever the config lives (no false block).
  // CANDIDATE ORDER: the RESOLVED path first (so the documented $LOOM_ECOSYSTEM_CONFIG
  // / opts override keeps working), then the CANONICAL in-repo config as a fallback.
  // The fallback matters because the env override REPLACES the tier-3 path outright —
  // without it, a refused relocation would skip the repo's own committed config and
  // land on tier-4, letting a planted env var override an AUDITED {enabled:false} into
  // ON. That direction is fail-safe (more enforcement, not less) but it discards
  // operator intent, so the audited config gets the last word. ONE uniform rule runs
  // over BOTH candidates, so a SYMLINKED canonical config is refused in the fallback
  // exactly as it is in the primary read (no second, laxer path).
  if (!result) {
    const seen = new Set();
    for (const cand of [
      _ecosystemConfigPath(rd, o),
      _canonicalEcosystemConfigPath(rd),
    ]) {
      if (result) break;
      if (seen.has(cand)) continue; // no relocation ⇒ both candidates are the same file
      seen.add(cand);

      // SINK-PINNED (loom#1447): bytes AND identity from one fd. Nothing below
      // re-resolves `cand` — it is used only for operator-facing warning text.
      const r = _readJsonPinned(cand);
      if (!r.ok) {
        if (r.error) warnings.push(`ecosystem-config unreadable (${cand}): ${r.error}`);
        continue;
      }
      if (
        !r.value ||
        !r.value.coordination ||
        typeof r.value.coordination.enabled !== "boolean"
      ) {
        continue; // no decisive boolean at this candidate
      }

      const enabled = r.value.coordination.enabled;

      // ASYMMETRY PRESERVED: only the DISABLE direction is gated. A `true` from
      // anywhere is still honoured with no warning (escalating trust is harmless).
      let refuseReason = null;
      let refuseKind = null;
      // Declared at the SAME scope as refuseKind because the warning that consumes
      // it is emitted OUTSIDE the `enabled === false` block below.
      let attRef = null;
      if (enabled === false) {
        // TWO independent properties, BOTH required for a disable to be auditable:
        //   LOCATION  (#1429) — the bytes came from the canonical in-repo file;
        //   COMMIT    (#1441) — that file's committed blob says the same thing.
        // Location alone admitted an uncommitted working-tree write, which is the
        // no-audit-trail condition tier 2's refusal was built to exclude.
        // Evaluated in that order so the git subprocess never runs for a relocated
        // candidate, which is already refused on the cheaper test.
        const canonical = _isCanonicalEcosystemConfig(rd, r.ident);
        let unavailable;
        if (!canonical) {
          refuseKind = "relocated";
        } else {
          const att = _committedDisableAttested(rd, o);
          attRef = att.ref;
          if (!att.attested) {
            // loom#1462 F1: an attestation that could not RUN is indeterminate, not a
            // clean negative. Same refusal, honest warning.
            unavailable = att.unavailable;
            refuseKind = unavailable ? "unattestable" : "uncommitted";
          }
        }
        if (refuseKind) refuseReason = _refuseEnrolledDisable(rd, o);
        if (refuseReason && refuseKind === "unattestable") {
          // The REMEDY must match the REASON. "Make git reachable" is actively
          // misleading when git ran fine and the repo simply has no reviewed ref
          // (rules/evidence-first-claims.md MUST-4 — do not state an inference in
          // the grammar of an observation, and do not send an operator to fix the
          // wrong thing).
          const remedy = /no git binary|could not be executed|git killed/i.test(
            String(unavailable),
          )
            ? "Make git reachable, then retry"
            : "Push the disable to the repository's default branch (or set an upstream) " +
              "so it sits on a reviewed ref, then retry";
          warnings.push(
            `ecosystem-config {coordination.enabled:false} at the canonical path (${cand}) ` +
              `could not be verified — disable attestation UNAVAILABLE (${unavailable}) — ` +
              `REFUSED — ${refuseReason}; attestation is ranked TIGHTEST when it cannot ` +
              `run, so the substrate stays ON. ${remedy}`,
          );
          continue;
        }
      }
      if (refuseReason) {
        warnings.push(
          refuseKind === "relocated"
            ? `ecosystem-config {coordination.enabled:false} from a RELOCATED path (${cand}) ` +
                `REFUSED — ${refuseReason}; disable an enrolled repo via the committed ` +
                "in-repo .claude/bin/ecosystem.json instead"
            : `ecosystem-config {coordination.enabled:false} at the canonical path (${cand}) ` +
                `is NOT COMMITTED on the reviewed ref — REFUSED — ${refuseReason}; the blob at ` +
                `${attRef || "the attestation ref"}:.claude/bin/ecosystem.json does not carry ` +
                "coordination.enabled:false, so this disable has no reviewed audit trail. " +
                "Commit the change AND push it to the default branch to disable an enrolled repo",
        );
        continue;
      }
      result = { enabled, source: "ecosystem-config" };
    }
  }

  // Tier 4 — implicit: roster present AND genesis anchored.
  if (!result) {
    const rp = _rosterPath(rd, o);
    // Same sink-pinned read + same non-object classification as
    // _refuseEnrolledDisable, so the implicit tier and the refusal fence can never
    // disagree about who is enrolled (loom#1447 §F6/§F7). A `null`-parsing or
    // symlinked roster previously fell through here to tier-5 default-OFF — the
    // OPPOSITE disposition from the corrupt-roster case one branch below.
    const r = _readJsonPinned(rp);
    const malformed =
      r.ok && (!r.value || typeof r.value !== "object" || Array.isArray(r.value));
    if (
      r.ok &&
      !malformed &&
      r.value.genesis &&
      _isGenesisAnchored(r.value.genesis)
    ) {
      result = { enabled: true, source: "implicit-roster-genesis" };
    } else if (malformed) {
      warnings.push(
        `roster present but not an object (${rp}) — fail-closed toward ON (indeterminate enrollment)`,
      );
      result = { enabled: true, source: "implicit-corrupt-roster-failclosed" };
    } else if (!r.ok && r.error) {
      // MO-OPT W2-c (raw-clone residual 2): a PRESENT-but-UNREADABLE roster is
      // an INDETERMINATE-enrollment repo — a roster file EXISTS (someone set this
      // up), it just cannot be parsed. Fail-closed toward ON (the substrate's
      // enforcement stays UP) rather than silently disabling every guard on a
      // possibly-enrolled repo whose roster got corrupted. Symmetric with the
      // shared _refuseEnrolledDisable "indeterminate enrollment → keep ON" fence.
      // A genuinely fresh solo repo has NO roster (ENOENT → r.absent) and stays
      // OFF via tier-5; only a corrupt-but-present roster flips to fail-closed ON.
      warnings.push(
        `roster unreadable (${rp}): ${r.error} — fail-closed toward ON (indeterminate enrollment)`,
      );
      result = { enabled: true, source: "implicit-corrupt-roster-failclosed" };
    } else if (_committedRosterEnrolled(rd, o).state === "indeterminate") {
      // loom#1462 H2 — git could not ANSWER whether this repo is enrolled at HEAD.
      // Ranked TIGHTEST, exactly as the disable attestation ranks its own unavailable
      // (§ Enforcement-Surface Parity), and LOUD: the prior behaviour was a silent OFF,
      // which is the one disposition that must never be reachable by a git failure.
      warnings.push(
        `enrollment attestation UNAVAILABLE (${_committedRosterEnrolled(rd, o).reason}) — ` +
          "cannot determine whether HEAD carries an anchored roster; fail-closed toward " +
          "ON. Make git reachable to resolve this repo's real enrollment state",
      );
      result = { enabled: true, source: "implicit-head-indeterminate-failclosed" };
    } else if (_committedRosterEnrolled(rd, o).state === "enrolled") {
      // loom#1462 F2 — the ONLY branch left here is "the working-tree roster is ABSENT
      // or carries no anchored genesis". Both spellings erase the sole evidence tier 4
      // reads, and either can be produced by one ordinary file write. If HEAD says the
      // repo IS enrolled, the working tree disagreeing with it is INDETERMINATE, not
      // proof of non-enrollment — the exact disposition #1441 reached for the config.
      // See § HEAD-ROSTER ATTESTATION for why this is evidence-POSITIVE.
      warnings.push(
        `roster at ${rp} is absent-or-degenerate in the WORKING TREE but HEAD carries an ` +
          "ANCHORED roster — enrolled at HEAD, so this repo cannot be disabled by a " +
          "working-tree roster write; fail-closed toward ON (indeterminate enrollment). " +
          "Commit the roster change (a genesis teardown) to disable an enrolled repo",
      );
      result = { enabled: true, source: "implicit-head-enrolled-failclosed" };
    }
  }

  // Tier 5 — default OFF.
  if (!result) result = { enabled: false, source: "default-off" };

  if (warnings.length) result.warning = warnings.join("; ");

  if (!injected) _cache.set(rd, result);
  return result;
}

/**
 * Genesis is "anchored" when the roster's genesis block carries a non-empty
 * root_commit — the trust root is established. A roster with NO genesis block
 * (or an empty root_commit) is NOT enrolled: it falls through to default-OFF,
 * the conservative disposition.
 */
function _isGenesisAnchored(genesis) {
  if (!genesis || typeof genesis !== "object") return false;
  const rc = genesis.root_commit;
  if (typeof rc !== "string" || rc.trim().length === 0) return false;
  // MO-OPT W2-c (raw-clone residual 1 / S2 explicit-enablement): a PLACEHOLDER-
  // genesis is RESERVED-but-unverified, NOT anchored. The clean-instantiate
  // ceremony resets a client clone to a placeholder roster (repo_owner
  // "PLACEHOLDER-…", all-zero root_commit sentinel) precisely so the cleared
  // client stays coordination-OFF until /ecosystem-init re-anchors with a REAL
  // owner + root_commit. Without this, the schema-required non-empty root_commit
  // ("0000000") would read as "anchored" and a freshly-cleared client would be
  // disruptively coordination-ON by inheritance. The ~12 real-enrolled repos
  // carry a real repo_owner + real root_commit, so they stay anchored (no
  // regression — the S6 enabled-path baseline holds).
  if (
    typeof genesis.repo_owner === "string" &&
    genesis.repo_owner.startsWith("PLACEHOLDER-")
  )
    return false;
  if (/^0+$/.test(rc.trim())) return false;
  return true;
}

/**
 * Should a NON-AUDITABLE {enabled:false} be REFUSED for `repoDir`?
 *
 * THE single shared restrictiveness function for the enrolled-disable decision —
 * consulted by tier 2 (the gitignored local override) AND, since #1429, by tier 3
 * whenever the resolved ecosystem config is RELOCATED off the canonical in-repo
 * path. One function, both surfaces (rules/security.md § Enforcement-Surface
 * Parity), so the two can never drift into disagreeing about who is enrolled.
 *
 * Named `_refuseLocalDisable` until #1429; `validate-bash-command.js` (~line 654)
 * still cites the OLD name in a prose cross-reference. Its CLAIM is unaffected and
 * remains true — a local {enabled:false} on an enrolled repo is still refused at
 * resolution time — but the parenthetical identifier is stale. That file carries the
 * shared state-path regex and is being rewritten by a concurrent PR, so the one-word
 * touch is deliberately DEFERRED to that sequencing rather than taken here (a grep
 * for the old name lands on this docblock).
 *
 * Returns a human reason STRING when refusal is required, else null (honor).
 *
 * The roster read has THREE outcomes (G1 R2 reviewer + cc-architect LOW —
 * distinguish ABSENT from UNREADABLE so an ambiguous-enrollment OFF is never
 * silent):
 *   - ABSENT (ENOENT)                         → null (honor; genuinely no roster,
 *                                                a clearly non-enrolled consumer)
 *                                                UNLESS HEAD carries an anchored
 *                                                roster → "enrolled at HEAD (...)"
 *                                                (REFUSE — loom#1462 F2).
 *   - PRESENT + readable + anchored genesis   → "enrolled repo (...)" (REFUSE —
 *                                                the enrolled-disable escalation).
 *   - PRESENT + readable + NOT anchored       → null (honor; genuinely un-enrolled
 *                                                — a roster without a trust root)
 *                                                UNLESS HEAD carries an anchored
 *                                                roster → "enrolled at HEAD (...)"
 *                                                (REFUSE — loom#1462 F2; the
 *                                                working tree disagreeing with a
 *                                                committed enrollment is
 *                                                INDETERMINATE, not proof).
 *   - PRESENT + UNREADABLE/corrupt            → "indeterminate enrollment (...)"
 *                                                (REFUSE — fail-safe toward ON; the
 *                                                returned reason becomes a surfaced
 *                                                warning, so the OFF disposition on
 *                                                an unknown-enrollment repo is loud).
 * Uses the SAME _isGenesisAnchored predicate as tier-4 so there is no
 * enrollment-classification drift between the refusal fence and the implicit tier.
 */
function _refuseEnrolledDisable(repoDir, opts) {
  // ROSTER READ IS SINK-PINNED TOO (loom#1447 §F6/§F7 — the folded findings).
  // The enrollment side had the SAME fail-open shape the config side did, and it
  // is the cheaper attack: this predicate decides WHETHER to refuse at all, so
  // making the repo look un-enrolled defeats the fence without touching it.
  //
  //   §F6 — the roster read had no canonicality check at all, asymmetric with
  //   _isCanonicalEcosystemConfig. A DANGLING SYMLINK at the roster path read as
  //   ENOENT → "absent" → "a clearly non-enrolled consumer" → disable HONOURED.
  //   `_readJsonPinned`'s O_NOFOLLOW makes a symlink at this path fail ELOOP
  //   (dangling or not), so it now classifies as PRESENT-but-unreadable →
  //   indeterminate → REFUSE. A genuinely absent roster still returns ENOENT from
  //   `open` and is still honoured, so the no-false-block case is untouched.
  //
  //   §F7 — a roster whose content parses to `null` (or to any non-object) took
  //   the `r.value && …` short-circuit and read as "genuinely un-enrolled" →
  //   HONOUR, while a parse ERROR on the same file read as indeterminate →
  //   REFUSE. A malformed roster is malformed either way; `null` is not evidence
  //   of non-enrollment. Both now classify as indeterminate.
  //
  //   loom#1462 §F2 — the two branches that returned null ("genuinely no roster" and
  //   "a roster without a trust root") each rested ENTIRELY on the working tree, which
  //   is one ordinary file write away from saying anything. This function and tier 4
  //   are the two surfaces reaching the SAME enrollment decision, so BOTH consult HEAD
  //   (rules/security.md § Enforcement-Surface Parity — a new fail-closed dimension
  //   lands at every surface, in the same change, through ONE shared function). Without
  //   the parity, the cheapest disable was a `{}` roster PLUS a gitignored local
  //   override: tier 4's new fence would keep the substrate ON, but this one would have
  //   honoured the override and short-circuited before tier 4 ever ran.
  const r = _readJsonPinned(_rosterPath(repoDir, opts));
  if (r.absent) {
    // Genuinely no roster — UNLESS HEAD still carries an anchored one, in which case
    // the roster was REMOVED from the working tree without committing the removal.
    return _headVerdictRefusal(
      repoDir,
      opts,
      "enrolled at HEAD (roster absent from the working tree, removal not committed)",
    );
  }
  if (!r.ok) return "indeterminate enrollment (roster present but unreadable)";
  if (!r.value || typeof r.value !== "object" || Array.isArray(r.value)) {
    return "indeterminate enrollment (roster present but not an object)";
  }
  if (r.value.genesis && _isGenesisAnchored(r.value.genesis)) {
    return "enrolled repo (roster + anchored genesis)";
  }
  return _headVerdictRefusal(
    repoDir,
    opts,
    "enrolled at HEAD (working-tree roster carries no anchored genesis, change not committed)",
  );
}

/**
 * Map the HEAD-roster tri-state onto a refusal reason (loom#1462 H2).
 *
 * The whole point of the tri-state is that this surface and tier 4 rank the SAME
 * condition the SAME way. An `indeterminate` here MUST refuse: if it honoured instead,
 * the cheapest disable on a host where git cannot answer would be a `{}` roster plus a
 * gitignored local override — tier 4 would hold the substrate ON, but this fence would
 * honour the override and short-circuit before tier 4 ever ran.
 */
function _headVerdictRefusal(repoDir, opts, enrolledReason) {
  const v = _committedRosterEnrolled(repoDir, opts);
  if (v.state === "enrolled") return enrolledReason;
  if (v.state === "indeterminate") {
    return `enrollment attestation UNAVAILABLE (${v.reason}) — cannot confirm this repo is NOT enrolled at HEAD`;
  }
  return null;
}

/** Ergonomic boolean accessor for guard call sites: `if (!isCoordinationEnabled(repoDir)) passthrough();` */
function isCoordinationEnabled(repoDir, opts) {
  return coordinationMode(repoDir, opts).enabled;
}

module.exports = {
  coordinationMode,
  isCoordinationEnabled,
  _resetCache,
  // Test-only — NOT part of the supported API.
  _test_isGenesisAnchored: _isGenesisAnchored,
};
