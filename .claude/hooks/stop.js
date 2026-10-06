#!/usr/bin/env node

/**
 * Stop Hook - Graceful Shutdown Handler
 *
 * @hook-event: Stop (lifecycle) — the subject is durable on-disk state at session
 *   close: the checkpoint this hook writes, and the operator's own
 *   `.session-notes.d/<display_id>.md` stamp measured against HEAD. Stop is the
 *   moment a wrapup/reconcile would have been due, and it carries no tool axis,
 *   so a NARROW class (`guard`/`verification`) would claim a matcher this event
 *   cannot hold (`hook-event-selection.md` MUST-3).
 *
 * Purpose:
 * - Save final checkpoint before shutdown
 * - Clean up temporary resources
 * - Report a notes-vs-HEAD lag ONLY when a structural signal says one exists
 *
 * Exit Codes:
 * - 0: Success (allow graceful shutdown)
 *
 * Note: This hook should NEVER block shutdown - always return 0
 *
 * ── F90: the old reminder was a NON-DISCRIMINATING INSTRUMENT ───────────────
 *
 * Until 2026-08-20 the block below printed, unconditionally, on every Stop in
 * any repo carrying a `workspaces/` directory:
 *
 *     [WORKSPACE] Session ending for <ws>. Run /wrapup next time before closing
 *     to save session context.
 *
 * It performed NO check of whether a wrapup had happened — no fragment-mtime
 * test, no stamp-vs-HEAD compare, nothing. Measured in a prior session: the
 * identical string was emitted BOTH before AND after a completed wrapup. Its
 * output was therefore the same whether the proposition ("wrapup has not run")
 * was TRUE or FALSE, which carries zero information — the exact shape
 * `instrument-discipline.md` MUST-1 refuses as evidence. A reminder that fires
 * identically in both states trains the reader to ignore it, and the real
 * signal goes with it.
 *
 * THE FALSIFYING RESULT, named per MUST-1 before the check is relied on: when
 * the operator's own fragment is stamped AT HEAD, this hook now says NOTHING
 * about wrapup and emits the bare `{"continue":true}` payload. That is an
 * output the old code could not produce for any input whatsoever. Both poles
 * are executable and are pinned in `.claude/audit-fixtures/wrapup-verify/run.mjs`.
 *
 * ── WHAT THE SIGNAL IS, AND WHAT IT IS NOT ─────────────────────────────────
 *
 * Signal: `git rev-list --count <last_reconciled_sha>..HEAD`, run in the MAIN
 * checkout, where `last_reconciled_sha` is the frontmatter stamp of the
 * operator's OWN `.session-notes.d/<display_id>.md`. A git-object fact plus a
 * parsed frontmatter field — STRUCTURAL, not lexical — so
 * `hook-output-discipline.md` MUST-2 does not cap the severity at advisory.
 *
 * It is NOT a literal "did `/wrapup` run" oracle, and nothing here claims it is
 * (`instrument-bipolarity.md` MUST-4 — no prose guarantee the code does not
 * implement). `/wrapup` is memory-sourced under a 4-tool-call cap and cannot
 * run git, so it does not re-stamp; the stamp is written by
 * `session-notes-layout.js::writeReconciledFragment` (i.e. `/reconcile-notes`)
 * and once at split migration. What the check measures is exactly what the
 * message reports: the operator's notes trail HEAD by N commits. KNOWN
 * consequence, recorded rather than hidden — a wrapup whose own commit lands
 * after the last reconcile leaves N >= 1, so a small N is expected, and the
 * message says "your notes trail HEAD", never "you did not run /wrapup".
 *
 * ── WHAT A Stop-EVENT SEVERITY BUYS, AND WHAT IT DOES NOT ──────────────────
 *
 * `halt-and-report` records the finding's CLASS. It buys NO enforcement here.
 * `instruct-and-wait.js::instructAndWait` returns `{continue:true}` with exit
 * code 0 for EVERY severity at a STOP_LIKE event — including `block`, which is
 * why that file rewrites the block head to "NOT BLOCKED — this event cannot
 * block". The harness surfaces the `systemMessage` and the session closes
 * anyway: nothing is halted, nothing is retried, no tool call is denied. Do not
 * read this severity as teeth. The only thing it changes is how the finding is
 * ranked and reported.
 *
 * ── PER-TURN FIRING WAS ITSELF THE F90 DEFECT, IN THE OTHER DIRECTION ───────
 *
 * `Stop` is registered with NO matcher and fires at the end of EVERY agent
 * turn, not at session close. Notes lag is the NORMAL mid-session state —
 * measured 17 commits on this repo while this very fix was being written — so
 * a discriminating check with no throttle emits a correct finding dozens of
 * times per session. That trains the reader to ignore it, which is exactly the
 * failure F90 exists to fix; discrimination alone does not cure it.
 *
 * The throttle is a ONCE-PER-SESSION-PER-KIND latch (`claimWrapupLatch`), an
 * `O_CREAT|O_EXCL` file under `~/.claude/hook-state/stop-notes-lag/`. Keyed per
 * KIND rather than per session because collapsing the kinds re-opens a coverage
 * hole in the other direction: a turn-1 `unknown` (git momentarily slow) would
 * burn a single latch and silence the real `lag` for the rest of the session.
 * Ceiling is therefore 3 messages per session (lag/absent/unknown), not 1 per
 * turn. FAILS OPEN in every degraded direction — no session identity, an
 * unwritable state dir, any errno other than EEXIST — because a duplicate line
 * is cheap and self-evident while a permanently-swallowed finding is neither.
 *
 * BOUND, not a guarantee: "once per session" holds exactly as far as the
 * harness's `session_id` is stable across turns. That is the field's documented
 * contract and the fixture drives it explicitly, but this hook does not and
 * cannot verify it from inside one turn. If a harness ever supplied a fresh id
 * per turn the latch degrades to today's per-turn behaviour — the fail-open
 * direction — and never to silence.
 *
 * ── ON THE SIBLING PostToolUse GUARD: BOTH FIRING IS CORRECT, AND BOUNDED ───
 *
 * `session-notes-incorporation-guard.js` (PostToolUse|Bash) keys on the SAME
 * `last_reconciled_sha`-vs-HEAD anchor and shares `_revListCount` with this
 * file. That sharing is deliberate (`zero-tolerance.md` Rule 3e — one code
 * surface, so the two readers cannot drift on what a lag is) and is NOT the
 * duplication worth worrying about; the OVERLAP is.
 *
 * DEFERRAL WAS EVALUATED AND IS UNAVAILABLE, stated rather than assumed: the
 * guard emits through `instruct-and-wait.js::emit`, which writes stdout and
 * exits and leaves NO on-disk record of having fired — grep it — so there is
 * nothing this hook could read to defer to, and the guard is out of this
 * shard's scope to change.
 *
 * BOTH FIRING IS CORRECT ON THE MERITS, not merely tolerated. The guard's
 * precondition is `isIncorporationCommand` — it speaks only after a
 * `git merge|pull|rebase|checkout main` in THIS session, about work just
 * pulled in. Most sessions never run one, and in those sessions the guard is
 * structurally silent, so it cannot be this check's substitute. The two answer
 * different questions at different moments: "you just incorporated work your
 * notes predate" vs "this session is ending and your notes trail the branch".
 * With the latch above the worst case is ONE duplicate signal per session
 * instead of one per turn, which is the cost of keeping the Stop-time coverage.
 */

const fs = require("fs");
const path = require("path");
// learning-utils no longer needed — stop observations removed
const { detectActiveWorkspace } = require("./lib/workspace-utils");
// SINGLE-SOURCE readers, not re-implementations (`zero-tolerance.md` Rule 3e):
//   fragmentPathFor      — the EXACT filename derivation the WRITER uses
//   readNotesFileGuarded — the one symlink/size-guarded chokepoint for tracked
//                          session-notes paths
//   parseLastReconciledSha — the block-scoped frontmatter parse the
//                          incorporation guard already owns (requiring that
//                          module is side-effect-free: its CLI arms only under
//                          `require.main === module`)
//   _revListCount        — that guard's own lag runner, reused rather than
//                          re-implemented, so the two readers of this anchor
//                          cannot drift on what a lag is
//   requireMainCheckout  — the fail-closed main-checkout accessor; a worktree
//                          session MUST read the main checkout's notes
//                          (`trust-posture.md` MUST-1), and this accessor has no
//                          silent `|| cwd` branch the way the legacy one does
//   MONOLITH_NAME        — the legacy pre-split `.session-notes` filename, read
//                          from the layout module rather than re-typed, so the
//                          "notes exist in legacy form" branch below cannot
//                          drift from the migrator's own notion of that file
const { fragmentPathFor, readNotesFileGuarded, MONOLITH_NAME } = require(
  path.join(__dirname, "lib", "session-notes-layout.js"),
);
const { parseLastReconciledSha, _revListCount } = require(
  path.join(__dirname, "session-notes-incorporation-guard.js"),
);
const { requireMainCheckout } = require(
  path.join(__dirname, "lib", "state-resolver.js"),
);

// cc-artifacts.md Rule 7 — timeout fallback that never hangs the session. Armed
// ONLY inside `main()`, so a `require()` of this module (the fixture runner does
// exactly that) has ZERO side effects and leaves no self-exiting timer behind.
const TIMEOUT_MS = 5000;
let _timeout = null;

// Get home directory (cross-platform)
const HOME = process.env.HOME || process.env.USERPROFILE;

// Directory paths
const CLAUDE_DIR = path.join(HOME, ".claude");
const CHECKPOINTS_DIR = path.join(CLAUDE_DIR, "checkpoints");
// Latch home. `~/.claude/` is already this hook's own write surface (it writes a
// checkpoint there on every Stop), so the latch introduces no new writable
// location — it is a sibling of a directory this event demonstrably owns.
const LATCH_DIR = path.join(CLAUDE_DIR, "hook-state", "stop-notes-lag");
// Prune latch files older than this on each claim. One session leaves at most 3
// ~100-byte files; without a sweep the directory grows for the life of the
// machine, which is the "we'll clean it up later" shape `zero-tolerance.md`
// Rule 2 refuses. The sweep is bounded (see `claimWrapupLatch`).
const LATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LATCH_SWEEP_MAX_ENTRIES = 500;

/**
 * Ensure directory exists
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Save final checkpoint
 */
function saveCheckpoint(sessionId, cwd, pendingWork) {
  try {
    ensureDir(CHECKPOINTS_DIR);

    const checkpoint = {
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      cwd: cwd,
      type: "stop",
      pending_work: pendingWork || null,
      interrupted: true,
    };

    const checkpointPath = path.join(
      CHECKPOINTS_DIR,
      `stop_${sessionId}_${Date.now()}.json`,
    );
    fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));

    return checkpointPath;
  } catch (error) {
    // Don't fail on checkpoint error - allow graceful shutdown
    return null;
  }
}

// Stop observation logging removed — "stop" events were 49% of all observations
// with zero learning value. Session state is captured by saveCheckpoint().

/**
 * Clean up any temporary resources
 */
function cleanupResources(cwd) {
  try {
    // Clean up any .claude-tmp files in working directory
    if (cwd && fs.existsSync(cwd)) {
      const tmpPattern = /^\.claude-tmp/;
      const files = fs.readdirSync(cwd);

      for (const file of files) {
        if (tmpPattern.test(file)) {
          const filePath = path.join(cwd, file);
          try {
            fs.unlinkSync(filePath);
          } catch (e) {
            // Ignore cleanup errors
          }
        }
      }
    }
    return true;
  } catch (error) {
    return false;
  }
}

// ── Once-per-session-per-kind latch ─────────────────────────────────────────

/**
 * Claim the right to SPEAK ONCE this session about finding class `kind`.
 *
 * Mechanism: `O_CREAT|O_EXCL` on `<latchDir>/<session>.<kind>`. The kernel makes
 * first-writer-wins atomic, so two Stop processes racing on the same session
 * cannot both claim — no lockfile protocol, no read-then-write window. The
 * latch's meaning is carried entirely by the file's EXISTENCE; the JSON written
 * into it is a human breadcrumb with no consumer, which is why a failed content
 * write below does not un-claim the latch (`zero-tolerance.md` Rule 3 permits
 * the ignore only because nothing reads what was not written — that is stated
 * here rather than left as a bare empty catch).
 *
 * FAIL-OPEN IN EVERY DEGRADED DIRECTION (`cc-artifacts.md` Rule 7). It returns
 * `claimed:true` — i.e. SPEAK — when there is no usable session identity, when
 * the state directory cannot be created, and on any errno that is not EEXIST.
 * Only a genuine EEXIST suppresses. Rationale, and it is the same one
 * `emit-artifact-activation-session.js::alreadyAttestedThisSession` records for
 * its own degraded path: a duplicate line is cheap and self-evident, while a
 * permanently-swallowed finding is neither, and this hook must never convert a
 * broken latch into silence. Nothing here can throw into the caller, so a
 * broken latch also cannot break session close.
 *
 * NO SESSION IDENTITY ⇒ NO LATCH, said out loud. `main()` synthesises
 * `stop_<now>` for the checkpoint filename when `session_id` is absent; feeding
 * THAT to the latch would mint a fresh key every turn and produce a latch that
 * looks installed and never latches — a silent fallback. The raw field is
 * passed instead and an absent one returns `no-session-identity`.
 *
 * @param {string|undefined} rawSessionId - `data.session_id` VERBATIM, never the
 *   synthesised checkpoint id.
 * @param {string} kind - the finding class ("lag" | "absent" | "unknown").
 * @param {{dir?:string, now?:number}} [opts] - injectable for the fixtures.
 * @returns {{claimed:boolean, reason:string, path?:string}}
 */
function claimWrapupLatch(rawSessionId, kind, opts) {
  const o = opts || {};
  const dir = o.dir || LATCH_DIR;
  const now = typeof o.now === "number" ? o.now : Date.now();

  if (typeof rawSessionId !== "string" || rawSessionId.trim() === "") {
    return { claimed: true, reason: "no-session-identity" };
  }
  // Same character class the checkpoint path uses, so a hostile session_id
  // cannot traverse out of the latch directory. Bounded so a pathological id
  // cannot exceed a filesystem's name limit and turn every claim into ENAMETOOLONG
  // (which fails open, but noisily and forever).
  const key = rawSessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
  const safeKind = String(kind || "unknown").replace(/[^a-z-]/g, "");
  const target = path.join(dir, `${key}.${safeKind}`);

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return {
      claimed: true,
      reason: `latch-dir-unwritable-${(e && e.code) || "error"}`,
    };
  }

  let fd = null;
  try {
    fd = fs.openSync(
      target,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
  } catch (e) {
    if (e && e.code === "EEXIST") {
      // EEXIST ALONE IS NOT PROOF OF A PRIOR CLAIM, and this was MEASURED, not
      // reasoned: `O_NOFOLLOW` does NOT yield ELOOP here. POSIX specifies that
      // under `O_CREAT|O_EXCL` a path naming a symbolic link fails EEXIST
      // regardless, and the fixture confirmed it on darwin — a planted symlink
      // came back indistinguishable from a real latch. Left there, anyone able
      // to create ONE file could permanently silence this finding for a session
      // whose id they can guess. So the entry is classified before EEXIST is
      // honoured: only a PLAIN REGULAR FILE is a latch. Anything else (symlink,
      // directory, FIFO, device) means no latch installed → speak.
      let st = null;
      try {
        st = fs.lstatSync(target);
      } catch {
        // Vanished between open and lstat: no latch is in place → speak.
      }
      if (st && st.isFile()) {
        return {
          claimed: false,
          reason: "already-reported-this-session",
          path: target,
        };
      }
      return {
        claimed: true,
        reason: `latch-not-a-regular-file-${st ? "irregular" : "vanished"}`,
        path: target,
      };
    }
    // EACCES, EROFS, ENAMETOOLONG, anything else: the latch did not install, so
    // it suppresses nothing.
    return {
      claimed: true,
      reason: `latch-unwritable-${(e && e.code) || "error"}`,
      path: target,
    };
  }
  try {
    fs.writeSync(
      fd,
      JSON.stringify({ session: key, kind: safeKind, at: now }) + "\n",
    );
  } catch {
    // Breadcrumb only — see the header. The claim is the inode, and it exists.
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // fd leak on close failure is bounded by process exit, milliseconds away.
    }
  }

  sweepStaleLatches(dir, now);
  return { claimed: true, reason: "first-report-this-session", path: target };
}

/**
 * Bounded TTL sweep of the latch directory. Best-effort hygiene ONLY: it never
 * throws, never affects a claim's verdict, and is capped at
 * `LATCH_SWEEP_MAX_ENTRIES` dirents so a directory that somehow grew huge cannot
 * make a Stop hook walk it (the synchronous walk would block the event loop the
 * Rule-7 timer lives on — the same bound this file records for `revListCount`).
 */
function sweepStaleLatches(dir, now) {
  try {
    const names = fs.readdirSync(dir);
    const limit = Math.min(names.length, LATCH_SWEEP_MAX_ENTRIES);
    for (let i = 0; i < limit; i++) {
      const p = path.join(dir, names[i]);
      try {
        const st = fs.lstatSync(p);
        if (!st.isFile()) continue;
        if (now - st.mtimeMs > LATCH_TTL_MS) fs.unlinkSync(p);
      } catch {
        // One unreadable/racing entry must not abandon the rest of the sweep.
      }
    }
  } catch {
    // No directory, or unreadable: nothing to sweep. Hygiene is not a gate.
  }
}

// ── Wrapup-lag verification (F90) ───────────────────────────────────────────

/**
 * `git rev-list --count <sha>..HEAD` in the MAIN checkout.
 *
 * NOT re-implemented here. This is the SAME exported runner
 * `session-notes-incorporation-guard.js` uses for the SAME stamp against the
 * SAME anchor (`zero-tolerance.md` Rule 3e — one code surface, so the two
 * readers cannot drift into disagreeing about what a lag is). It returns
 * `{status, count}`, `status` being the child's exit code (null on spawn error
 * or timeout) and `count` the parsed integer (NaN when unparseable), and it
 * never throws.
 *
 * BOUND, stated exactly: it caps the CHILD at 4s and that composes under
 * `requireMainCheckout`'s own per-probe bound. That is a bound on EACH child
 * and is NOT a total wall-clock ceiling — a synchronous spawn blocks the event
 * loop, so `main()`'s Rule-7 timer cannot interrupt one. Recorded rather than
 * dressed up as a guarantee (`instrument-bipolarity.md` MUST-4).
 */
const revListCount = _revListCount;

/**
 * Decide what — if anything — this Stop should say about the operator's notes.
 *
 * FOUR outcome classes, deliberately distinct (`zero-tolerance.md` Rule 3: an
 * unreadable fragment must never silently become "wrapup ran"):
 *
 *   kind "lag"     → fire, `halt-and-report`. The stamp is a real object and
 *                    HEAD is `ahead` commits past it.
 *   kind "absent"  → fire, `halt-and-report`. NO notes exist to be stale: the
 *                    operator has no fragment under an existing
 *                    `.session-notes.d/`, or the repo has neither the split dir
 *                    nor the legacy monolith. A file's non-existence is a
 *                    DEFINITE structural fact, not a failed measurement, which
 *                    is why this is its own class and not `unknown`.
 *   kind "unknown" → fire, `advisory`. The measurement did NOT run or did not
 *                    answer (indeterminate main checkout, no identity handle,
 *                    unreadable/symlinked/oversized fragment, corrupt stamp,
 *                    git errored or absent, stamped object unreachable).
 *                    Reported as UNKNOWN, never as coherent — an errored
 *                    instrument is zero evidence, not confirmation
 *                    (`evidence-first-claims.md` MUST-3).
 *   kind "silent"  → do not fire. Notes demonstrably EXIST and either measure
 *                    clean or are unmeasurable by contract: a lag count of
 *                    exactly 0, an absent/empty stamp (the documented I10
 *                    contract, stated in the fragment's own header comment), a
 *                    legacy-monolith layout — or there is no workspace at all,
 *                    which is this hook's scope precondition.
 *
 * ── THE SILENT-POLE DISPOSITION, PER POLE, ON ONE STATED RULE ──────────────
 *
 * F90 as first landed was SILENT on `no-own-fragment`, `no-split-layout`,
 * `no-identity-handle` and `unstamped-coherent`. The pre-F90 reminder fired in
 * all four, so the fix traded a useless reminder for one that said nothing to
 * the operator who never wrote notes at all — the case that most warranted it.
 * That was a real coverage regression and it is closed here, not re-described.
 *
 * The rule applied, uniformly: FIRE iff the ABSENCE is itself the fact this
 * check measured; stay SILENT iff notes demonstrably exist.
 *
 *   no-own-fragment      → FIRES (`absent`). `.session-notes.d/` exists, the
 *                          operator's file in it does not. Measured, definite,
 *                          actionable.
 *   no-split-layout      → SPLIT ON EVIDENCE. Neither the split dir nor the
 *                          legacy `.session-notes` monolith → FIRES (`absent`):
 *                          no session notes of any kind. Monolith present →
 *                          SILENT (`legacy-monolith-layout`): notes exist, and
 *                          the monolith carries no `last_reconciled_sha`, so
 *                          firing would assert staleness never measured.
 *   no-identity-handle   → FIRES (`unknown`). This is a FAILED MEASUREMENT —
 *                          we cannot say whether a fragment exists because we
 *                          could not name the operator. Classifying it silent
 *                          contradicted this file's own doctrine that a failed
 *                          measurement never becomes an all-clear.
 *   unstamped-coherent   → STAYS SILENT. The fragment EXISTS and the operator
 *                          demonstrably wrote notes; only the lag is
 *                          unmeasurable. I10 names this coherent by contract
 *                          and the sibling incorporation guard reads the same
 *                          anchor the same way — diverging here would fire at
 *                          every operator's first session and split a shared
 *                          contract across two readers. Silence emits no
 *                          string, so nothing here claims the notes are
 *                          current; the file header states the residual.
 *
 * `identity` is a PARAMETER, not resolved here — same shape as the sibling
 * `session-notes-incorporation-guard.js::decideIncorporationAdvisory`, so the
 * poles can be driven against a real git repo without a signing key.
 *
 * @param {{baseDir:string, identity:object,
 *          _revListCount?:function}} opts
 * @returns {{fire:boolean, kind:"lag"|"absent"|"unknown"|"silent",
 *            reason:string, ahead?:number, sha?:string, fragmentPath?:string,
 *            workspace?:string, repoDir?:string, detail?:string}}
 */
function decideWrapupReminder(opts) {
  const o = opts || {};
  const baseDir = o.baseDir || process.cwd();
  const revList =
    typeof o._revListCount === "function" ? o._revListCount : revListCount;

  // SCOPE PRECONDITION, carried over verbatim from the pre-F90 reminder. This
  // change adds DISCRIMINATION; it deliberately adds NO new firing surface. A
  // Stop fires on every turn, so widening the gate here would trade a useless
  // reminder for a noisier one.
  let ws = null;
  try {
    ws = detectActiveWorkspace(baseDir);
  } catch {
    ws = null;
  }
  if (!ws)
    return { fire: false, kind: "silent", reason: "no-active-workspace" };

  const main = requireMainCheckout(baseDir);
  if (!main.ok) {
    return {
      fire: true,
      kind: "unknown",
      reason: "main-checkout-indeterminate",
      detail: main.reason,
      workspace: ws.name,
    };
  }
  const repoDir = main.repoDir;
  const base = { workspace: ws.name, repoDir };

  // Cheap gate BEFORE any identity resolution (which spawns). Split on EVIDENCE
  // rather than assuming: a workspace repo with no `.session-notes.d/` either
  // still carries the legacy monolith (notes EXIST — stay silent, and do not
  // assert a staleness the monolith cannot express, having no
  // `last_reconciled_sha`) or carries no session notes of ANY kind, which is a
  // definite measured absence and fires.
  if (!fs.existsSync(path.join(repoDir, ".session-notes.d"))) {
    if (fs.existsSync(path.join(repoDir, MONOLITH_NAME))) {
      return {
        fire: false,
        kind: "silent",
        reason: "legacy-monolith-layout",
        ...base,
      };
    }
    return {
      fire: true,
      kind: "absent",
      reason: "no-session-notes-at-all",
      ...base,
    };
  }

  const fragPath = fragmentPathFor(repoDir, o.identity);
  if (!fragPath) {
    // No usable handle → we cannot even NAME the file whose existence is the
    // question, so nothing was measured. That is the UNKNOWN class, not
    // silence: this file's own doctrine is that a failed measurement never
    // becomes an all-clear (`evidence-first-claims.md` MUST-3).
    return {
      fire: true,
      kind: "unknown",
      reason: "no-identity-handle",
      ...base,
    };
  }

  const g = readNotesFileGuarded(fragPath);
  if (!g.ok) {
    if (g.kind === "stat-error" && g.err && g.err.code === "ENOENT") {
      // The split dir EXISTS and the operator's own file in it does not. That
      // non-existence is a definite structural fact, so it is reported as what
      // it is — an absent fragment — and NOT as a claim about `/wrapup`, which
      // this check still does not measure. Silence here was the F90 coverage
      // regression: it said nothing to the operator who wrote no notes at all.
      return {
        fire: true,
        kind: "absent",
        reason: "no-own-fragment",
        fragmentPath: fragPath,
        ...base,
      };
    }
    // Present but unreadable (symlink / non-regular / oversize / read error).
    // NOT a lag finding, and NOT coherent: a failed measurement, reported so.
    return {
      fire: true,
      kind: "unknown",
      reason: `fragment-${g.kind}`,
      fragmentPath: fragPath,
      ...base,
    };
  }

  const sha = parseLastReconciledSha(g.content);
  if (!sha) {
    // I10, documented in the fragment's own header comment: a missing or empty
    // `last_reconciled_sha` is COHERENT, not an error.
    return {
      fire: false,
      kind: "silent",
      reason: "unstamped-coherent",
      fragmentPath: fragPath,
      ...base,
    };
  }
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    // A non-sha-shaped stamp never becomes a git argument (defense in depth),
    // and a corrupt anchor is a broken instrument, not an all-clear.
    return {
      fire: true,
      kind: "unknown",
      reason: "stamp-not-sha-shaped",
      sha,
      fragmentPath: fragPath,
      ...base,
    };
  }

  const r = revList(repoDir, sha);
  if (r.status === 0) {
    if (Number.isFinite(r.count) && r.count > 0) {
      return {
        fire: true,
        kind: "lag",
        reason: "notes-lag",
        ahead: r.count,
        sha,
        fragmentPath: fragPath,
        ...base,
      };
    }
    if (Number.isFinite(r.count)) {
      return {
        fire: false,
        kind: "silent",
        reason: "coherent-count-zero",
        sha,
        fragmentPath: fragPath,
        ...base,
      };
    }
    // exit 0 with unparseable output — the instrument ran but did not answer.
    return {
      fire: true,
      kind: "unknown",
      reason: "count-unparseable",
      sha,
      fragmentPath: fragPath,
      ...base,
    };
  }
  if (r.status === 128) {
    // The stamped object is not reachable: rebased away, or a shallow clone
    // that never fetched it. The anchor is stale — say UNKNOWN, not clean.
    return {
      fire: true,
      kind: "unknown",
      reason: "bad-rev",
      sha,
      fragmentPath: fragPath,
      ...base,
    };
  }
  return {
    fire: true,
    kind: "unknown",
    reason: `git-exit-${r.status == null ? "error" : r.status}`,
    sha,
    fragmentPath: fragPath,
    ...base,
  };
}

/**
 * Render a firing decision into the canonical `instruct-and-wait` payload
 * (`hook-output-discipline.md` MUST-1 — all six fields, emitted through the
 * shared `emit()`; a raw `process.exit(2)` would be BLOCKED, and is impossible
 * at this event anyway).
 *
 * Returns null for a non-firing decision, so the caller has exactly one branch.
 */
function buildWrapupPayload(decision) {
  const d = decision || {};
  if (!d.fire) return null;
  const wsName = d.workspace ? ` for ${d.workspace}` : "";

  if (d.kind === "lag") {
    const n = d.ahead;
    return {
      hookEvent: "Stop",
      // STRUCTURAL evidence (a git-object fact + a parsed frontmatter field), so
      // MUST-2's lexical cap does not apply. It still buys no enforcement at a
      // Stop event — see the file header.
      severity: "halt-and-report",
      what_happened: `Session ending${wsName}. Your .session-notes.d fragment is stamped ${d.sha}, which HEAD is ${n} commit(s) past — the notes trail the branch.`,
      why: "session-notes-coherence: last_reconciled_sha is the lag anchor the next session inherits. This check measures notes-vs-HEAD, NOT whether /wrapup was typed — a wrapup whose own commit landed after the last reconcile leaves a small lag, and that is expected.",
      agent_must_report: [
        `State that the session-notes fragment trails HEAD by ${n} commit(s) since ${d.sha}.`,
        "Name whether this session produced work the next session needs and the fragment does not yet carry.",
        "Reconcile and re-stamp before closing if so (/reconcile-notes stamps last_reconciled_sha=HEAD); otherwise say the lag is the wrapup commit itself and no action is due.",
      ],
      agent_must_wait:
        "Nothing is blocked — the Stop event cannot block. Report the lag and let the session close.",
      // Says ONLY what `git rev-list` established. The prior wording ended
      // "— reconcile due", an ACTION claim this check cannot support: the
      // header records that a wrapup whose own commit lands after the last
      // reconcile leaves N >= 1 with nothing owed. Asserting a duty the
      // instrument never measured is exactly `instrument-bipolarity.md`
      // MUST-4's prohibition, at the one line most likely to be read alone.
      user_summary: `session-notes fragment trails HEAD by ${n} commit(s) since ${d.sha}; whether a reconcile is owed is NOT established by this check (F90).`,
    };
  }

  if (d.kind === "absent") {
    const where = d.fragmentPath
      ? `No session-notes fragment exists for you at ${d.fragmentPath}.`
      : "This repo has neither a .session-notes.d/ directory nor a legacy .session-notes file.";
    return {
      hookEvent: "Stop",
      // A file's non-existence is as structural as a git-object fact, so
      // MUST-2's lexical cap does not apply. It still buys no enforcement at a
      // Stop event — see the file header.
      severity: "halt-and-report",
      what_happened: `Session ending${wsName}. ${where} There is no notes surface for the next session to read first.`,
      why: "session-notes-coherence: the per-operator fragment is what the next session inherits. What was measured is the FILE'S ABSENCE and nothing more — this does NOT establish that /wrapup was skipped, and does not claim to.",
      agent_must_report: [
        d.fragmentPath
          ? `State that no .session-notes.d fragment exists for this operator (${d.fragmentPath}).`
          : "State that this repo carries no session-notes surface at all (no .session-notes.d/, no legacy .session-notes).",
        "Name whether this session produced work the next session needs.",
        "Write the notes before closing if so (/wrapup drafts them; /reconcile-notes stamps last_reconciled_sha=HEAD); otherwise say the session left nothing worth carrying.",
      ],
      agent_must_wait:
        "Nothing is blocked — the Stop event cannot block. Report the absence and let the session close.",
      user_summary: d.fragmentPath
        ? `no .session-notes.d fragment exists for this operator — the next session inherits none (F90).`
        : `no session-notes surface exists in this repo — the next session inherits none (F90).`,
    };
  }

  // kind === "unknown" — the measurement did not answer.
  return {
    hookEvent: "Stop",
    // A failed measurement is reported, never ranked as a finding about the
    // notes: nothing structural was established, so this stays advisory.
    severity: "advisory",
    what_happened: `Session ending${wsName}. The session-notes freshness check did NOT run to a verdict (${d.reason}${d.detail ? `: ${d.detail}` : ""}).`,
    why: "evidence-first-claims.md MUST-3: an errored, unreadable or unanswerable check is ZERO evidence — it is reported as UNKNOWN rather than silently read as 'the notes are current'.",
    agent_must_report: [
      `State that session-notes freshness is UNKNOWN this session (${d.reason}), not verified-clean.`,
      d.fragmentPath
        ? `Name the fragment the check could not read to a verdict: ${d.fragmentPath}`
        : "Name that no fragment path could be resolved for the check.",
    ],
    agent_must_wait:
      "Nothing is blocked. Acknowledge the UNKNOWN status; re-run the check by hand if the notes matter for the next session.",
    user_summary: `session-notes freshness UNKNOWN (${d.reason}) — not verified clean.`,
  };
}

/**
 * Main stop handler
 */
async function main() {
  _timeout = setTimeout(() => {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0); // Stop hooks always exit 0 to allow shutdown
  }, TIMEOUT_MS);
  _timeout.unref?.();

  let input = "";

  // Read input from stdin
  process.stdin.setEncoding("utf8");

  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let data = {};
  try {
    data = JSON.parse(input);
  } catch (e) {
    // If no JSON input, use defaults
  }

  // Sanitize session_id to prevent path traversal
  const sessionId = (data.session_id || `stop_${Date.now()}`).replace(
    /[^a-zA-Z0-9_-]/g,
    "_",
  );
  const cwd = data.cwd || process.cwd();
  const pendingWork = data.pending_work || null;

  // Perform graceful shutdown tasks FIRST — they must happen whether or not the
  // freshness check has anything to say, and `emit()` below exits the process.
  saveCheckpoint(sessionId, cwd, pendingWork);
  cleanupResources(cwd);

  // ── Workspace: notes-vs-HEAD freshness (F90) ─────────────────────────────
  // Every path fails OPEN: an exception here degrades to the bare
  // `{"continue":true}` payload and never takes the session close down
  // (`cc-artifacts.md` Rule 7, `zero-tolerance.md` Rule 3 — the catch records
  // nothing as verified, it just declines to speak).
  let payload = null;
  try {
    // Identity resolves against `cwd`, not a second main-checkout probe: the
    // roster (`.claude/operators.roster.json`) and `user.signingkey` are the
    // SAME tracked/shared inputs from a linked worktree, so the answer is
    // identical and one git probe is saved on a hook that runs every turn.
    const { resolveIdentity } = require(
      path.join(__dirname, "lib", "operator-id.js"),
    );
    const identity = resolveIdentity(cwd, {});
    const decision = decideWrapupReminder({ baseDir: cwd, identity });
    // THROTTLE AFTER THE DECISION, NEVER BEFORE. Claiming on every Stop would
    // burn the latch on the first (silent) turn and suppress a lag that only
    // appears at turn 20. The latch is claimed ONLY when there is something to
    // say, so "once per session" means once per finding, not once per process.
    // `data.session_id` is passed VERBATIM — see `claimWrapupLatch` on why the
    // synthesised checkpoint id must not be used here.
    if (decision && decision.fire) {
      const latch = claimWrapupLatch(data.session_id, decision.kind);
      if (latch.claimed) payload = buildWrapupPayload(decision);
    }
  } catch {
    payload = null;
  }

  if (_timeout) clearTimeout(_timeout);

  if (payload) {
    // emit() writes the canonical JSON to stdout and exits. At a STOP_LIKE event
    // instructAndWait returns `{continue:true}` with exit code 0 for EVERY
    // severity, so this cannot block shutdown.
    const { emit } = require(
      path.join(__dirname, "lib", "instruct-and-wait.js"),
    );
    emit(payload);
    return;
  }

  // Output result - Stop hooks only support basic schema (no hookSpecificOutput)
  // The schema only defines hookSpecificOutput for PreToolUse, UserPromptSubmit, PostToolUse
  console.log(JSON.stringify({ continue: true }));
  process.exit(0); // Always exit 0 - never block shutdown
}

/**
 * Detector entry — everything this script does when run. Exported so the hook
 * engine can run it in-process (`lib/hook-engine.js`); the CLI entry below calls
 * the same function. The `.catch` only writes output and exits (the engine's
 * catch/finally residual: nothing else may run after an exit).
 */
function hookMain() {
  return main().catch(() => {
    // Even on error, output valid JSON and exit 0
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  });
}

module.exports = {
  decideWrapupReminder,
  buildWrapupPayload,
  claimWrapupLatch,
  revListCount,
  LATCH_TTL_MS,
  hookMain,
};

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
