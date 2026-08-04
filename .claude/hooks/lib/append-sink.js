/**
 * append-sink — the ONE hardened JSONL-append primitive for every `.claude/` sink writer.
 *
 * loom#1349. Every JSONL sink under `.claude/hooks/` shared one unhardened idiom —
 * `fs.mkdirSync(dir,{recursive:true})` then `fs.appendFileSync(path, line)` — with no symlink
 * refusal and no explicit mode. Two consequences, both live before this module:
 *
 *   - A symlink pre-planted at the predictable sink DIRECTORY is FOLLOWED. Recursive `mkdirSync`
 *     no-ops when the path already resolves to a directory, and `appendFileSync` writes THROUGH
 *     the link — landing operator-correlatable content (verified_id, person_id, session ids)
 *     outside the gitignore fence. A trailing-slash gitignore pattern matches directories, not
 *     the symlink, so the escaped rows are not even ignored at the destination.
 *   - `appendFileSync` creates at `0o666 & ~umask` — typically world-readable `0o644`.
 *
 * The in-repo bar existed at `state-io.js` (F53(a): `O_NOFOLLOW` + `0o600`) and
 * `session-notes-layout.js` (lstat + `O_EXCL`), but only for tmp+rename writers — no append-only
 * sink reached it. `derives-from-ledger.js::_appendToSink` was the first that did; this module is
 * that shape extracted so every sink shares ONE implementation rather than N drifting copies
 * (`rules/security.md` § Multi-Site Kwarg Plumbing: encode and decode — here harden and append —
 * are dual halves of one contract; splitting them across modules guarantees drift).
 *
 * ## Scope — stated precisely, because the first version of this header overclaimed
 *
 * Every JSONL/append sink under `.claude/hooks/` routes here EXCEPT `state-io.js::appendViolation`,
 * which is owned by a sibling shard (loom#1338) and hardened there. An earlier revision of this
 * header claimed "every sink" while seven writers — including `coc-emit.js`, the canonical
 * signed-record emitter behind 11 modules — were still on the bare idiom, leaving
 * `coordination-log.jsonl` hardened at 2 of its 4 writers. If you add a sink, route it here; if you
 * cannot, say so in this block rather than leaving the claim broader than the code.
 *
 * ## The six defenses, and why each is necessary
 *
 * 1. **ANCESTOR symlink — containment BEFORE mkdir.** This is the ordering lesson from the #1228
 *    fix and the reason a post-mkdir check is not merely weaker but USELESS: checking containment
 *    AFTER `mkdirSync(…,{recursive:true})` is too late, because the mkdir ITSELF follows an
 *    ancestor symlink and creates the sink directory inside the link's target — outside the repo —
 *    before any check can refuse. Making `learning/` itself a symlink leaves the sink dir a REAL
 *    directory inside the attacker's target, so checking only `sinkDir`/`sinkPath` sees nothing
 *    wrong. So: resolve the DEEPEST EXISTING ancestor of the sink dir and require IT under the
 *    real repo root. A symlink anywhere on the ancestry then fails closed with nothing created.
 *    Both sides go through the same resolver (`rules/security.md` § Path Containment: resolving
 *    only the candidate and comparing against a RAW root is not a sound comparison).
 * 2. **HARD link — checked on the fd.** `lstat` cannot see a hard link; a second name for the
 *    same bytes is invisible to every path-based check. `fstatSync(fd).nlink > 1` refuses.
 * 3. **TOCTOU on the final component — `O_NOFOLLOW` at open time.** Check-then-append leaves a
 *    window, and `appendFileSync` follows symlinks. Doing the checks on the OPEN FD and writing
 *    through THAT fd closes it: `O_NOFOLLOW` raises ELOOP on a final-component symlink at open.
 * 4. **MODE on a PRE-EXISTING file — `fchmodSync` every append.** A mode passed to `open` applies
 *    only at CREATION, so an existing `0o644` sink keeps `0o644` forever. Explicit `fchmodSync`
 *    on every append REPAIRS it.
 * 5. **FIFO — `O_NONBLOCK`.** Per POSIX open(2), opening a FIFO `O_WRONLY` with `O_NONBLOCK` CLEAR
 *    blocks until a reader opens the other end — and `O_NOFOLLOW` refuses SYMLINKS, not FIFOs, so
 *    it does not cover this. `fs.openSync` is synchronous, so a FIFO planted at a sink path hangs
 *    the process FOREVER: the call never returns and never reaches a catch. Sink filenames are not
 *    secret (the directory is listable and session-derived names are predictable), so no prediction
 *    is required to plant one. Every sink routed here is on a hook's best-effort path, where a hang
 *    is strictly worse than a refusal.
 * 6. **INTERMEDIATE-COMPONENT TOCTOU — pin the sink DIRECTORY by identity, then reconcile the fd**
 *    (R1 F1; corrected by loom#1513). Defenses 1–3 validate the PATH; the open then RE-TRAVERSES
 *    it. An attacker who swaps the sink DIRECTORY in that window (not the final component — 3
 *    covers it; not an ancestor — 1 covers it) lands the fd outside the repo with every prior
 *    check passed. Node exposes no `openat`, so the directory is pinned by IDENTITY instead:
 *    `captureDirIdentity` opens `realSinkDir` with `O_RDONLY|O_DIRECTORY|O_NOFOLLOW` before the
 *    file open and records `fstat` (dev, ino); `reconcileFdIdentity` re-opens it the same way
 *    BOTH before and after comparing the fd against `lstat(realSinkDir/basename)`, refusing on
 *    ELOOP (swapped for a symlink) or a (dev, ino) mismatch (swapped for another directory).
 *
 *    **THE CLASS IS NARROWED, NOT CLOSED. Do not describe it as closed.** Every check here
 *    re-traverses a path STRING, and Node exposes no `openat`/`fstatat` to resolve relative to the
 *    pinned directory fd. The first loom#1513 arrangement (one dir check, then one path check) was
 *    defeated by a THREE-PHASE flip — swap for the open, revert past the dir check, re-swap so the
 *    path check's lstat follows the symlink onto the fd's own file (loom#1518 review, HIGH). The
 *    sandwich raises the cost of THAT sequence; a perfectly-synchronised attacker still wins.
 *    Per `rules/security.md` § Path Containment this is the necessary-but-not-sufficient case:
 *    closing it properly needs `openat`-class enforcement AT the sink, which Node lacks.
 *
 *    Do NOT quantify the achieved cost as a flip count. A previous revision of this block claimed
 *    the sandwich "raises the cost to four consecutive flips"; that was wrong, because a HARD LINK
 *    buys the attacker the same forgery with only TWO windows and no additional flip at all — see
 *    residual (d). A cost claim is a security claim and needs the same evidence as any other.
 *
 *    ## THE GUARANTEE, STATED CORRECTLY — it is NOT "the bytes stay inside the repository"
 *
 *    Residuals (a)–(d) below were each written as though byte-containment were achievable and
 *    merely had specific holes. IT IS NOT ACHIEVABLE AT ALL, and saying otherwise is the same
 *    over-claim this module keeps having to retract. An fd binds to an INODE, not a path. Every
 *    check here validates where that inode currently LIVES; `writeSync` then writes to the inode
 *    wherever it has since been MOVED. One `rename` of the sink file — on a COMPLETELY HONEST
 *    tree, no symlink, no hard link, no directory swap — relocates the bytes outside the repo with
 *    every check having passed legitimately (residual (e); measured: ok:true, 47 bytes, honest
 *    tree). No userspace program can hold byte-containment: `openat` does not help, and neither
 *    would the Linux `/proc/self/fd` check — they move the window, they do not close it.
 *
 *    What this module DOES guarantee: **the row is written to the inode that was the legitimate
 *    sink at validation time.** Every defense above serves THAT promise — they establish which
 *    inode is legitimate and refuse when the fd is not on it. Where the bytes physically reside at
 *    write time is not a property userspace can pin.
 *
 *    WHAT DEFENSE 6 DOES NOT COVER, stated because the previous revision of this block did not.
 *    (a) `O_CREAT` is part of the same `open(2)` the swap redirects, so a won race still CREATES a
 *        ZERO-BYTE file at the attacker's target before any post-open check can run. Node exposes
 *        no `openat`, so nothing here can prevent that; unlinking afterwards is worse (the path now
 *        resolves into the attacker's tree, and a revert in between would delete the REAL sink).
 *        An empty file may therefore land outside the repo.
 *    (b) The pin needs `O_NOFOLLOW`+`O_DIRECTORY`; without them it is not applied at all —
 *        surfaced as `dirIdentityEnforced:false`, never assumed away.
 *    (c) **The check-1 ↔ check-2 sliver.** Between the directory re-check and the path compare,
 *        and again between the path compare and the second directory re-check, the tree can be
 *        flipped. The attack does NOT redirect the already-open fd — it FORGES the path check's
 *        view of where the fd's file lives, by making the sink directory a symlink to the
 *        directory the fd is really in. "Cannot redirect an open fd" is therefore NOT a defence
 *        against it, and citing that argument here would be the same over-claim loom#1513 fixed.
 *    (d) **Hard-link aliasing — TWO distinct shapes; the second is a DISCLOSURE defect.**
 *        (d1) The fd is on the LEGITIMATE file and a second name appears elsewhere: a fence
 *             escape, since the bytes are reachable under another path.
 *        (d2) The fd is on the ATTACKER'S OWN file, and the link at the legitimate sink path is
 *             what FORGES the path compare — same inode, same device, honest directory at both
 *             directory checks, so the sandwich resists it not at all and it needs only TWO
 *             windows (loom#1518 round 2, measured: 47 bytes of signed row on the attacker's
 *             inode). Closed by the nlink re-check inside `reconcileFdIdentity` plus the one
 *             immediately before the write loop.
 *        An earlier revision of this residual claimed the impact was "not disclosure" because
 *        `fchmodSync(fd, 0o600)` and Linux `protected_hardlinks` bound it. BOTH BOUNDS ARE WRONG
 *        for (d2): `protected_hardlinks` permits linking a file you OWN, and the attacker owns
 *        theirs; and `fchmodSync` does not repair anything there — it FAILS `EPERM` on a file
 *        owned by someone else, which this module records as `modeEnforced:false` rather than
 *        treating as a refusal. (d2) is cross-UID disclosure of `verified_id` + `person_id` —
 *        DERIVED from file ownership, NOT measured: the probe that established the escape is
 *        same-UID, where `fchmodSync` SUCCEEDS and `modeEnforced` is `true`. The 47-byte escape is
 *        measured; the cross-UID consequence is inferred from who owns the inode.
 *        TWO RESIDUALS REMAIN, and the two nlink checks cover DIFFERENT windows — they are not
 *        redundant spares. The reconcile-level check sees a link that exists AT LSTAT TIME (the
 *        (d2) forgery, which requires the link to be present for the lstat to resolve through it);
 *        the pre-write check sees one created AFTER the reconcile returned (the (d1) shape, which
 *        the first cannot see because it has already run). They coincide only against an attacker
 *        who plants once and leaves it — which is what the regression probe does, so a probe-based
 *        reading UNDERSTATES their independence.
 *          - A link planted after the final pre-write `fstat`: one `writeSync` wide.
 *          - The UNLINK-TIMING variant: a link present at the lstat and removed before the very
 *            next `fstat`, so both nlink reads see 1. No victim syscall sits between them, but a
 *            concurrent attacker thread does not need one. Instruction-level, not closed.
 *        Neither closes without `openat`-class primitives.
 *    (e) **INODE RELOCATION — irreducible, and NOT a defect in this module.** One `rename` of the
 *        sink file on an honest tree moves the bytes out of the repo; see the guarantee section
 *        above. Distinguish it sharply from (d2): the relocated file is still the sink this module
 *        legitimately validated, so it stays `0600` and VICTIM-owned (measured), and the impact is
 *        GITIGNORE-FENCE ESCAPE, not disclosure — an attacker who can rename inside `.claude/`
 *        already has write access there. Do NOT "fix" this; there is nothing here to fix. It is
 *        recorded so no future revision re-states byte-containment as the promise.
 *
 * ## Contract
 *
 *   appendSinkLine({ repoDir, sinkPath, line })
 *     → { ok, sinkPath?, nofollowSupported, modeEnforced?, dirIdentityEnforced?, error?, reason? }
 *
 * NEVER throws — every failure path returns a typed result object (`rules/zero-tolerance.md`
 * Rule 3). `line` is the record WITHOUT its trailing newline; this module writes exactly one.
 *
 * NOT enforced here: the 2KB `MAX_LINE_BYTES` POSIX-atomic-append cap. Callers that sign their
 * records (`coc-append.js`, `capability-ledger.js`) MUST check the cap BEFORE signing so they can
 * refuse rather than truncate-after-sign; a cap check inside this module would fire too late to
 * give them that choice. Callers that do not sign inherit the same atomicity caveat they had.
 */

"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Whether `O_NOFOLLOW` is actually available on this platform. POSIX defines it (darwin + linux);
 * Windows lacks it. Surfaced on every return shape per `rules/observability.md` so a degraded
 * write is OBSERVABLE rather than a silent weakening — the same surfaced-capability pattern
 * `state-io.js` uses for its tmp writes.
 */
// `COC_TEST_FORCE_NO_NOFOLLOW=1` simulates a platform without the flag (Windows) so the degraded
// path and its warning are exercisable on darwin/linux, where the branch is otherwise unreachable.
// `fs.constants` is non-configurable, so it cannot be stubbed from a test — this env seam is the
// repo's established `COC_TEST_*` idiom (`COC_TEST_SKIP_SIGN`, `COC_TEST_FORCE_RELEASE`, …).
//
// IT IS NOT PURELY STRICTENING, AND AN EARLIER VERSION OF THIS COMMENT CLAIMED IT WAS (loom#1518
// review, MEDIUM). The claim was "it can only make the helper STRICTER … never weaker". That was
// already contested for the file-open path (a prior red team recorded "the file contradicts
// itself" — `workspaces/loom-waves-2026-07-26/25-env-redirect-class-enumeration.md:117`), and the
// loom#1513 directory pin made it outright false: routing this value into `captureDirIdentity`
// switched the NEW control OFF on a host that has the flags, restoring the single-flip escape.
// So the seam no longer reaches the pin at all — see `DIR_PIN_AVAILABLE` below, which is derived
// from `fs.constants` ONLY. The seam still simulates a flagless platform for the FILE OPEN, which
// is what it was added to exercise. Channel note, scoped honestly: the settings.json `env` surface
// denylists the `COC_` prefix (`settings-deny-guard-shape.js::DANGEROUS_ENV_PREFIX`, loom#1450), but a
// host/shell export is open by documented design. The entry is `COC_`, not `COC_TEST_` — this line said
// the latter, which understates the denylist's reach by implying a non-`TEST` `COC_*` key slips past it.
const NOFOLLOW_SUPPORTED =
  (fs.constants.O_NOFOLLOW || 0) !== 0 && process.env.COC_TEST_FORCE_NO_NOFOLLOW !== "1";

/**
 * `O_DIRECTORY` — POSIX; absent on Windows. Needed to pin the sink DIRECTORY by identity
 * (loom#1513). `|| 0`-guarded per the F53 idiom so a platform lacking it degrades rather than
 * NaN-poisoning the bitmask; `captureDirIdentity` treats 0 as "cannot pin" and says so.
 */
const O_DIRECTORY = fs.constants.O_DIRECTORY || 0;

/**
 * Whether the directory pin can run — a PLATFORM capability, derived from `fs.constants` ONLY.
 *
 * Deliberately NOT `NOFOLLOW_SUPPORTED`: that value carries the `COC_TEST_FORCE_NO_NOFOLLOW` seam,
 * and feeding a test seam into a security control let an env var switch the control off on a host
 * that fully supports it (loom#1518 review, MEDIUM). A seam may simulate a weaker platform for the
 * behaviour it was built to exercise; it must not disarm a different control as a side effect.
 */
const DIR_PIN_AVAILABLE = (fs.constants.O_NOFOLLOW || 0) !== 0 && O_DIRECTORY !== 0;

/**
 * One-time loud WARN when the real platform lacks `O_NOFOLLOW` (R1 F6).
 *
 * `nofollowSupported` on the return shape is only actionable for a caller that INSPECTS the
 * result — and two of the routed sinks are best-effort hook paths that deliberately do not. On
 * such a platform EVERY routed sink silently takes the racier compensating-lstat path, so the
 * degradation was unobservable end-to-end. Per `security.md` § Secure-Default For A New Security
 * Feature, a protection that cannot be on by default MUST announce itself loudly once, naming the
 * OFF protection — not sit in a return field nobody reads. stderr only: a hook's stdout is its
 * protocol channel, so this can never reach the halting path.
 */
let _warnedNoNofollow = false;
function _warnDegradedOnce() {
  if (_warnedNoNofollow) return;
  _warnedNoNofollow = true;
  try {
    console.error(
      "[append-sink] WARNING: this platform lacks O_NOFOLLOW — JSONL sink appends fall back to a " +
        "compensating lstat that carries a TOCTOU window. Symlinked sinks are still REFUSED, never " +
        "followed, but the refusal is racier than on POSIX. (loom#1349) Additionally the sink " +
        "DIRECTORY cannot be pinned by identity, so a directory swapped between the containment " +
        "check and the open is NOT detected; `dirIdentityEnforced:false` is surfaced. (loom#1513)",
    );
  } catch {
    // A closed/failing stderr must never break an append.
  }
}

/**
 * Render UNTRUSTED text (an fs error message, a caller-supplied path) with every control
 * character escaped to a visible `\uXXXX`, so it can never be interpreted as a terminal
 * control sequence by whatever eventually PRINTS it.
 *
 * A refusal `reason` from this module travels: `coc-emit.js::_defaultAppend` ->
 * `emitSignedRecord` -> `sync-gate2-worktree.mjs::warnMissingTrackingRecord` -> stderr, verbatim.
 * An fs error message embeds the offending path RAW (`ENOTDIR: not a directory, mkdir '<path>'`),
 * so a sink path containing `ESC [ 2K CR` lets the attacker ERASE the warning line and overwrite
 * it with text of their choosing — defeating the whole point of a LOUD refusal.
 *
 * `JSON.stringify` is NOT a substitute, and the sibling `JSON.stringify(<path>)` messages here are
 * NOT already at this floor — a correction to what this comment previously claimed. Per ECMA-262
 * QuoteJSONString it escapes only the quote, the backslash, and code units below U+0020, so DEL
 * (U+007F), the whole C1 block (U+0080-U+009F, including CSI U+009B and OSC U+009D), U+2028/U+2029
 * and the bidi controls all survive it as RAW bytes. Measured: JSON.stringify of a lone U+009B
 * yields the bytes 22 c2 9b 22. That is why the quote-wrapped sites below ALSO route through here.
 *
 * IDEMPOTENT by construction: the output contains none of the escaped characters, so applying it
 * again at a downstream layer changes nothing — which lets producer AND print site both apply it.
 * The encoding is deliberately lossy, NOT injective: a literal backslash is left alone, so input
 * that already reads like an escape renders identically to a genuinely escaped one. That is safe
 * only because nothing in this tree ever DECODES the escaped form back — do not add an un-escaper.
 */
function escapeControlChars(s) {
  return String(s).replace(
    // C0 (incl. ESC 0x1b, CR 0x0d, BEL 0x07), DEL, and C1 (incl. CSI 0x9b, OSC 0x9d, DCS 0x90) —
    // every byte a terminal may act on as a CONTROL SEQUENCE. Beyond those, the bidi overrides and
    // invisible formatting characters cannot erase or overwrite, but U+202E does visually REORDER
    // the rest of the display line (the Trojan-Source class), so they are escaped too rather than
    // leaving the reader a warning whose text can be silently rearranged.
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

/**
 * Quote an UNTRUSTED path into a refusal message. `JSON.stringify` alone leaves DEL, the C1 block
 * (CSI/OSC/DCS), U+2028/U+2029 and the bidi controls as RAW bytes (see `escapeControlChars`), so
 * every quote-wrapped path in this module goes through BOTH: stringify for the readable quoting,
 * then the escaper for the floor. One helper so no call site can pick only half of it.
 */
function quotePath(p) {
  return escapeControlChars(JSON.stringify(p));
}

/**
 * Resolve the deepest EXISTING ancestor of `dir`. Used to run containment BEFORE any mkdir, so an
 * ancestor symlink fails closed with nothing created (defense 1 above).
 */
function _deepestExistingAncestor(dir) {
  let probe = dir;
  for (;;) {
    if (fs.existsSync(probe)) return probe;
    const parent = path.dirname(probe);
    if (parent === probe) return probe;
    probe = parent;
  }
}

/** True when `real` is the root itself or lies beneath it. Both sides MUST already be resolved. */
function _isContained(real, realRoot) {
  return real === realRoot || real.startsWith(realRoot + path.sep);
}

/**
 * Resolve the caller's declared containment roots, dropping any that will not resolve.
 *
 * MORE THAN ONE ROOT IS LEGITIMATE (R2 F1). Some sinks deliberately live OUTSIDE the session's
 * cwd: trust-posture state I/O resolves to the MAIN checkout on purpose, because a worktree's
 * `.claude/learning/` is auto-deleted on cleanup and would silently lose the rows
 * (`state-resolver.js` header, red-team CRIT-2). A single-root check keyed on the worktree
 * therefore REFUSES the designed path — which is a fail-OPEN outcome, not a safe one, because the
 * callers fall through to an unsigned legacy append when the stamped write is refused.
 *
 * Every root is still resolved and compared canonically, so widening to N roots does NOT weaken
 * the fence: an escape is refused unless it lands under a root the CALLER named. It bounds the
 * sink to a declared set instead of to one hard-coded assumption.
 */
function _resolveRoots(roots) {
  const out = [];
  for (const r of roots) {
    if (typeof r !== "string" || !r) continue;
    try {
      const real = fs.realpathSync(r);
      if (!out.includes(real)) out.push(real);
    } catch {
      // An unresolvable root contributes nothing; if NO root resolves the caller fails closed.
    }
  }
  return out;
}

/**
 * Capture the sink DIRECTORY's identity as an OPEN-FD fact, before the file open (loom#1513).
 *
 * `O_NOFOLLOW` here guards the FINAL component of `realSinkDir` — the sink directory itself — which
 * is precisely the component `lstat(realSinkDir/basename)` cannot guard, because lstat refuses to
 * follow only the LAST component of the path it is given. `O_DIRECTORY` refuses a non-directory.
 * `realSinkDir` is canonical at capture time, so no component of it is a symlink; an ELOOP here
 * therefore means a swap already landed between the containment check and this call, and it fails
 * CLOSED.
 *
 * Returns `enforced:false` (not a refusal) on a platform lacking either flag, so Windows keeps
 * appending rather than refusing every write; the degradation is surfaced on the result shape and
 * in the one-time WARN rather than being silent (`security.md` § Secure-Default For A New Security
 * Feature).
 *
 * `dirPinAvailable` defaults to `DIR_PIN_AVAILABLE` — a PLATFORM capability read from
 * `fs.constants`, deliberately not the seam-carrying `NOFOLLOW_SUPPORTED` (loom#1518 review,
 * MEDIUM). The parameter exists so a test can exercise the flagless branch on a POSIX host; it is
 * NOT wired to any env var.
 *
 * @returns {{ok: true, enforced: true, dev: number, ino: number}
 *          | {ok: true, enforced: false, reason: string}
 *          | {ok: false, reason: string}}
 */
function captureDirIdentity(realSinkDir, dirPinAvailable) {
  const supported = dirPinAvailable === undefined ? DIR_PIN_AVAILABLE : dirPinAvailable;
  if (!supported)
    return {
      ok: true,
      enforced: false,
      reason:
        "this platform lacks O_NOFOLLOW and/or O_DIRECTORY, so the sink directory cannot be pinned " +
        "by identity — a directory swap between the containment check and the open is NOT detected here",
    };
  let dfd = null;
  try {
    dfd = fs.openSync(realSinkDir, fs.constants.O_RDONLY | O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(dfd);
    return { ok: true, enforced: true, dev: st.dev, ino: st.ino };
  } catch (e) {
    return {
      ok: false,
      reason:
        `sink directory ${quotePath(realSinkDir)} did not open as a non-symlink directory ` +
        `(${e.code || "error"}: ${escapeControlChars(e.message)}) — it is a canonical path, so this means the component ` +
        `was swapped; refusing to append`,
    };
  } finally {
    if (dfd !== null) {
      try {
        fs.closeSync(dfd);
      } catch {
        // A failed close of a probe fd cannot be acted on and must not mask the identity result.
      }
    }
  }
}

/**
 * Reconcile an OPEN fd against the directory + path the caller MEANT to open (R1 F1 —
 * intermediate-component TOCTOU; corrected by loom#1513). Exported so the predicate can be tested
 * DETERMINISTICALLY without racing: the swap is performed synchronously inside the window and the
 * verdict is the same on every run and every platform.
 *
 * TWO checks, in this order, because the second cannot stand alone:
 *
 *   1. **The sink directory is still the one that passed containment.** `expectedDir` is the
 *      `captureDirIdentity` result taken BEFORE the file open. Re-opening `realSinkDir` with
 *      `O_NOFOLLOW|O_DIRECTORY` refuses a directory swapped for a SYMLINK (ELOOP), and the
 *      (dev, ino) compare refuses one swapped for ANOTHER DIRECTORY.
 *   2. **The fd is the file at the canonical path.** `lstatSync`, not `statSync`: lstat never
 *      follows, so a symlink planted at the legitimate FILE name cannot forge a match. Fails
 *      CLOSED on any stat error (ENOENT means the create landed in the attacker's directory).
 *
 * Check 2 alone is what this guard used to be, and it does NOT close the case it was documented as
 * closing: canonicalising a path yields a STRING, and every later syscall RE-TRAVERSES that string.
 * With the sink directory swapped for a symlink, `lstat(realSinkDir/basename)` follows it — the
 * refusal applies to the final component only — lands on the very file the raced fd holds, and the
 * (dev, ino) pair MATCHES. Check 2 returned ok:true on a won race.
 *
 * ## Check 1 is SANDWICHED around check 2, and the class is STILL NOT CLOSED
 *
 * Check 1 does not make check 2 stop re-traversing — it only removes the need for ONE flip. The
 * first shipped arrangement (check 1, then check 2, once each) was defeated by a THREE-PHASE flip
 * (loom#1518 review, HIGH): swap for the open so the fd lands outside; REVERT so check 1 sees the
 * honest directory and its (dev, ino) matches; RE-SWAP so check 2's lstat follows the symlink onto
 * the very file the fd holds and matches too. Both checks pass and the signed row lands outside.
 *
 * So check 1 now runs AGAIN after check 2, immediately before the caller writes. The attacker must
 * hold honest → swapped → honest → swapped across four consecutive syscall groups instead of two.
 *
 * **That is a NARROWER WINDOW, NOT A CLOSED CLASS.** A perfectly-synchronised attacker who can flip
 * between every one of our syscalls still defeats this, because every check here re-traverses a
 * path string and Node exposes no `openat`/`fstatat` to resolve relative to the pinned directory
 * fd. Under `security.md` § Path Containment the honest characterisation is **window narrowed,
 * class not closed** — the same standard that rule applies to a realpath re-check versus TOCTOU.
 * Do not read "narrow" as "closed"; that reading is what shipped the original defect.
 *
 * `expectedDir` is REQUIRED and a missing/failed one fails CLOSED — a caller that skips the
 * capture must not silently get the weaker guard back.
 *
 * @param {(phase: "after-dir-check"|"after-path-check") => void} [__windowHook]  TEST SEAM ONLY;
 *   see `appendSinkLine`'s `__testWindowHook`. Lets a test flip the tree BETWEEN the checks, which
 *   is the only way to exercise the three-phase sequence deterministically.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function reconcileFdIdentity(fd, realSinkDir, sinkPath, expectedDir, __windowHook) {
  if (!expectedDir || expectedDir.ok !== true)
    return {
      ok: false,
      reason:
        "no pre-open sink-directory identity was captured, so a directory swap cannot be ruled " +
        "out; refusing to append (call captureDirIdentity before the open)",
    };
  const hook = typeof __windowHook === "function" ? __windowHook : null;

  // Check 1, run BOTH before and after check 2 — see the sandwich note above. `when` names which
  // side reported, so a refusal says whether the swap was standing or was re-planted mid-reconcile.
  const dirStillPinned = (when) => {
    if (!expectedDir.enforced) return null;
    const now = captureDirIdentity(realSinkDir, true);
    if (!now.ok)
      return {
        ok: false,
        reason:
          `the sink directory no longer opens as the directory that passed containment (${when}): ` +
          `${now.reason} — an intermediate path component was swapped between the containment ` +
          `check and the open`,
      };
    if (now.dev !== expectedDir.dev || now.ino !== expectedDir.ino)
      return {
        ok: false,
        reason:
          `the directory at ${quotePath(realSinkDir)} is not the one that passed containment ` +
          `(${when}; dir dev/ino ${now.dev}/${now.ino} vs ${expectedDir.dev}/${expectedDir.ino}) — ` +
          `the sink directory was swapped between the containment check and the open; refusing to append`,
      };
    return null;
  };

  const before = dirStillPinned("before the path compare");
  if (before) return before;
  if (hook) hook("after-dir-check");

  const expectedPath = path.join(realSinkDir, path.basename(sinkPath));
  let expect;
  try {
    expect = fs.lstatSync(expectedPath);
  } catch (e) {
    return {
      ok: false,
      reason: `could not reconcile the opened sink against ${quotePath(expectedPath)}: ${escapeControlChars(e.message)}`,
    };
  }
  const st = fs.fstatSync(fd);
  // A HARD LINK CREATED AFTER THE PRE-RECONCILE nlink GATE FORGES THIS COMPARE (loom#1518 round 2).
  // The attacker gets the fd onto their OWN file via a directory swap, waits for the caller's
  // `nlink > 1` check to pass (still 1), then creates a second name for that inode AT THE
  // LEGITIMATE SINK PATH. The lstat below then resolves to the attacker's inode and matches the fd
  // HONESTLY — same inode, same device, honest directory at both directory checks, so the sandwich
  // contributes nothing. Re-checking nlink HERE NARROWS it to a window containing no intervening
  // victim syscall: the link must already exist for the lstat above to resolve through it, and
  // this `fstat` is the very next syscall.
  //
  // It does NOT close it, and saying "closes" here would be the flip-count over-claim one layer
  // down (see the header's note against quantifying cost). NO INTERVENING VICTIM SYSCALL IS NOT NO
  // ELAPSED TIME: a concurrent attacker thread on another core needs no preemption of this one, so
  // the unlink-timing variant — link present at the lstat, removed before this `fstat`, both nlink
  // reads then seeing 1 — lives in an instruction-level window rather than a closed one. Recorded
  // in the header's residual (d) rather than probed: constructing it deterministically would need
  // a seam between those two syscalls, and that seam would itself widen the window it demonstrates.
  if (st.nlink > 1)
    return {
      ok: false,
      reason:
        `the opened sink now has ${st.nlink} hard links — a second name was created after the ` +
        `pre-reconcile nlink check, which can forge the path compare below; refusing to append`,
    };
  if (expect.dev !== st.dev || expect.ino !== st.ino)
    return {
      ok: false,
      reason:
        `the opened sink is not the file at ${quotePath(expectedPath)} ` +
        `(fd dev/ino ${st.dev}/${st.ino} vs ${expect.dev}/${expect.ino}) — an intermediate path ` +
        `component was swapped between the containment check and the open; refusing to append`,
    };
  // A file created inside the pinned directory is necessarily on that directory's DEVICE. Free
  // constraint, and it rules out any cross-device target regardless of how the flips are timed.
  if (expectedDir.enforced && st.dev !== expectedDir.dev)
    return {
      ok: false,
      reason:
        `the opened sink is on device ${st.dev}, not the pinned sink directory's device ` +
        `${expectedDir.dev} — it cannot be a file inside that directory; refusing to append`,
    };

  if (hook) hook("after-path-check");
  const after = dirStillPinned("after the path compare");
  if (after) return after;

  return { ok: true };
}

/**
 * Append ONE line to a JSONL sink, hardened against symlinked ancestors, a symlinked sink
 * directory, a symlinked sink file, hard links, FIFOs, and world-readable modes.
 *
 * @param {object}  a
 * @param {string}  a.repoDir   Primary containment root. Resolved before comparison.
 * @param {string[]} [a.additionalRoots]  Further LEGITIMATE roots this sink may live under. The
 *   sink is contained if it resolves under ANY declared root. Required for sinks that escape cwd
 *   BY DESIGN — trust-posture state I/O resolves to the MAIN checkout, so a worktree session's
 *   `repoDir` is the wrong and only-apparently-safer boundary (R2 F1).
 * @param {string}  a.sinkPath  Absolute path of the JSONL sink. MUST resolve under a declared root.
 * @param {string}  a.line      One record, WITHOUT a trailing newline.
 * @param {boolean} [a.__simulateMissingNofollow]  TEST SEAM ONLY. Forces the platform-lacks-
 *   `O_NOFOLLOW` branch so the degraded path is exercisable on darwin/linux, where the flag is
 *   always present and the branch would otherwise be unreachable + untested. Production callers
 *   MUST NOT pass it. It weakens nothing that is not already weak on such a platform: the
 *   compensating `lstat` refusal below still fires, and `nofollowSupported:false` is surfaced.
 * @param {(phase: "before-open"|"after-open"|"after-dir-check"|"after-path-check") => void}
 *   [a.__testWindowHook]  TEST SEAM ONLY. Four phases, not two: this callback is ALSO forwarded to
 *   `reconcileFdIdentity`, which fires `"after-dir-check"` and `"after-path-check"`. Those two are
 *   the windows that matter most — a probe planted at `"after-open"` sits BEFORE the pre-reconcile
 *   nlink gate and gets refused for the WRONG REASON, reporting a false all-clear (that is exactly
 *   how the round-2 hard-link HIGH was nearly dismissed).
 *   Invoked synchronously at the two TOCTOU windows defense 6 guards, so a test can perform the
 *   directory swap AT the race point instead of racing for it. The end-to-end race is a
 *   two-syscall window that does not reproduce reliably on darwin/APFS, so a race-shaped test is a
 *   probe with no signal there (`evidence-first-claims.md` MUST-3); this seam makes the SAME
 *   end-to-end path deterministic on every platform. Production callers MUST NOT pass it. It
 *   weakens nothing: it adds a call, and cannot skip, reorder, or relax any check.
 * @returns {{ok: boolean, sinkPath?: string, nofollowSupported: boolean, modeEnforced?: boolean,
 *           dirIdentityEnforced?: boolean, error?: string, reason?: string}}
 */
function appendSinkLine(a) {
  const nofollowSupported = a && a.__simulateMissingNofollow ? false : NOFOLLOW_SUPPORTED;
  const fail = (error, reason) => ({ ok: false, error, reason, nofollowSupported });
  // Keyed on the REAL platform capability, never the test seam: the warning is about the host,
  // and firing it for a simulated run would train readers to ignore it.
  if (!NOFOLLOW_SUPPORTED) _warnDegradedOnce();

  if (!a || typeof a !== "object") return fail("bad arguments", "appendSinkLine requires an options object");
  const { repoDir, sinkPath, line } = a;
  if (typeof repoDir !== "string" || !repoDir)
    return fail("bad arguments", "repoDir MUST be a non-empty string (it is the containment boundary)");
  if (typeof sinkPath !== "string" || !sinkPath)
    return fail("bad arguments", "sinkPath MUST be a non-empty string");
  if (typeof line !== "string")
    return fail("bad arguments", `line MUST be a string (got ${typeof line})`);
  // A newline inside the record would split ONE row into two on read — a JSONL-injection shape.
  // JSON.stringify escapes newlines, so no honest caller trips this; a caller that does is
  // building the line by hand and needs to know.
  if (line.includes("\n"))
    return fail(
      "bad arguments",
      "line MUST NOT contain a newline (it would split one JSONL row into two); pass the record without its terminator",
    );

  // TEST SEAM ONLY (see the @param note). Called synchronously at the two named windows so a test
  // can perform the directory swap AT the race point and get a deterministic end-to-end verdict.
  const win = a && typeof a.__testWindowHook === "function" ? a.__testWindowHook : null;

  let fd = null;
  try {
    const declared = [repoDir, ...(Array.isArray(a.additionalRoots) ? a.additionalRoots : [])];
    const realRoots = _resolveRoots(declared);
    if (realRoots.length === 0)
      // Fail CLOSED: no declared root resolves, so there is no boundary to check against.
      return fail(
        "containment failed",
        `none of the declared containment roots resolve: ${quotePath(declared)}`,
      );
    const containedInAny = (p) => realRoots.some((r) => _isContained(p, r));

    const sinkDir = path.dirname(sinkPath);

    // (1) Containment BEFORE mkdir — see defense 1 in the module header.
    let realProbe;
    try {
      realProbe = fs.realpathSync(_deepestExistingAncestor(sinkDir));
    } catch (e) {
      return fail("containment failed", `sink ancestor does not resolve: ${escapeControlChars(e.message)}`);
    }
    if (!containedInAny(realProbe))
      return fail(
        "containment failed",
        `sink ancestor resolves to ${quotePath(realProbe)}, outside every declared root ` +
          `${quotePath(realRoots)} — refusing to append through a symlinked ancestor ` +
          `(the write would land outside the gitignore fence)`,
      );

    try {
      fs.mkdirSync(sinkDir, { recursive: true });
    } catch (e) {
      return fail("mkdir failed", `could not create sink directory ${quotePath(sinkDir)}: ${escapeControlChars(e.message)}`);
    }

    // Re-verify AFTER the mkdir. The ancestor check cleared the path that existed at probe time;
    // this confirms what was actually created is still contained, so a swap in that window fails
    // closed rather than silently writing out-of-tree. It also catches the plain symlinked-sink-
    // DIRECTORY case, where mkdir no-ops because the path already resolves to a directory.
    let realSinkDir;
    try {
      realSinkDir = fs.realpathSync(sinkDir);
    } catch (e) {
      return fail("containment failed", `sink directory does not resolve after mkdir: ${escapeControlChars(e.message)}`);
    }
    if (!containedInAny(realSinkDir))
      return fail(
        "containment failed",
        `sink directory resolves to ${quotePath(realSinkDir)}, outside every declared root ` +
          `${quotePath(realRoots)} — refusing to append`,
      );

    // (6a) PIN the sink directory by identity, BEFORE the open — see defense 6. This must sit
    // immediately after the containment check with nothing between: the pair only proves "the
    // directory that passed containment is the directory the fd landed in", and every statement
    // inserted here widens the sliver in which a swap could precede the capture itself.
    // Keyed on DIR_PIN_AVAILABLE (a real platform capability), NOT on `nofollowSupported` — that
    // value carries the COC_TEST_FORCE_NO_NOFOLLOW seam, and routing it here let an env var switch
    // this control off on a host that supports it (loom#1518 review, MEDIUM).
    const dirIdentity = captureDirIdentity(realSinkDir);
    if (!dirIdentity.ok) return fail("containment failed", dirIdentity.reason);

    // On a platform WITHOUT O_NOFOLLOW the open cannot refuse a final-component symlink, so a
    // compensating lstat runs instead. It carries a TOCTOU window O_NOFOLLOW does not — but the
    // alternative is silently FOLLOWING the link, which the acceptance for #1349 forbids. Paired
    // with `nofollowSupported:false` on the return shape, the degraded path is refused AND visible.
    if (!nofollowSupported) {
      try {
        const lst = fs.lstatSync(sinkPath);
        if (lst.isSymbolicLink())
          return fail(
            "symlink refused",
            `sink path ${quotePath(sinkPath)} is a symlink and this platform lacks O_NOFOLLOW — ` +
              `refusing to append through it (compensating lstat; carries a TOCTOU window O_NOFOLLOW would not)`,
          );
      } catch (e) {
        // ENOENT is the happy path — the sink does not exist yet and will be created below.
        if (e.code !== "ENOENT")
          return fail("lstat failed", `could not lstat sink path ${quotePath(sinkPath)}: ${escapeControlChars(e.message)}`);
      }
    }

    // (3) + (5) O_NOFOLLOW refuses a final-component symlink AT OPEN TIME; O_NONBLOCK keeps a
    // planted FIFO from hanging this synchronous open forever. Both `|| 0`-guarded per the F53
    // idiom so a platform lacking either degrades rather than NaN-poisoning the bitmask.
    const flags =
      fs.constants.O_WRONLY |
      fs.constants.O_APPEND |
      fs.constants.O_CREAT |
      (nofollowSupported ? fs.constants.O_NOFOLLOW : 0) |
      (fs.constants.O_NONBLOCK || 0);
    if (win) win("before-open");
    try {
      fd = fs.openSync(sinkPath, flags, 0o600);
    } catch (e) {
      // ELOOP is O_NOFOLLOW refusing a symlink at the final component — name it, because a bare
      // errno at a sink is otherwise indistinguishable from a transient FS fault.
      if (e.code === "ELOOP")
        return fail(
          "symlink refused",
          `sink path ${quotePath(sinkPath)} is a symlink — O_NOFOLLOW refused to open it ` +
            `(appending would write through the link, outside the gitignore fence)`,
        );
      // ENXIO is O_NONBLOCK refusing a FIFO with no reader on the other end — the planted-FIFO
      // case (defense 5). Without O_NONBLOCK this open would BLOCK FOREVER instead of raising, so
      // naming it distinguishes "the guard worked" from an unexplained errno at a sink path.
      if (e.code === "ENXIO")
        return fail(
          "not a regular file",
          `sink path ${quotePath(sinkPath)} is a FIFO with no reader — refusing to append ` +
            `(O_NONBLOCK turned what would be an unbounded blocking open into this refusal)`,
        );
      return fail("open failed", `could not open sink ${quotePath(sinkPath)}: ${escapeControlChars(e.message)}`);
    }

    if (win) win("after-open");

    const st = fs.fstatSync(fd);
    // (2) A hard link means a second name for these bytes — invisible to lstat, so it MUST be
    // checked on the fd. A sink with >1 link is not exclusively ours.
    if (st.nlink > 1)
      return fail(
        "hard link refused",
        `sink ${quotePath(sinkPath)} has ${st.nlink} hard links — refusing to append to a ` +
          `file reachable under another name`,
      );
    if (!st.isFile())
      return fail("not a regular file", `sink path ${quotePath(sinkPath)} is not a regular file`);

    // (6b) INTERMEDIATE-COMPONENT TOCTOU — the second half of defense 6 (loom#1513).
    //
    // Everything above validates the PATH; the open then RE-TRAVERSES it. Between the post-mkdir
    // `realpathSync(sinkDir)` and this `openSync`, an attacker who swaps the sink DIRECTORY (not
    // the final component, which O_NOFOLLOW covers, and not an ancestor, which the probe covers)
    // lands the fd on a file outside the repo — and every check so far passed, so the helper would
    // return ok:true having written a signed operator row (verified_id + person_id) out of tree.
    //
    // POSIX closes this with `openat` on a directory fd; Node exposes no `openat`, so the sink
    // directory is pinned by IDENTITY: `dirIdentity` above holds its (dev, ino) as read from an
    // `O_NOFOLLOW|O_DIRECTORY` fd, and this call re-reads it the same way — BOTH before and after
    // the path compare (the sandwich; see `reconcileFdIdentity`). A swap to a symlink ELOOPs; a
    // swap to another directory mismatches; a swap REVERTED before this runs is caught by the
    // fd-vs-`lstat(realSinkDir/basename)` compare. Refuse BEFORE writeSync, so the payload never
    // lands. This NARROWS the class; it does not close it — residual (c) in the header.
    //
    // WHAT WAS WRONG BEFORE: this call site passed no directory identity, and the fd-vs-lstat
    // compare was documented as sufficient because `realSinkDir` is "pre-open canonical, so it
    // cannot traverse the swap". That basis is false. Canonicalising yields a STRING, and a string
    // is re-traversed by every later syscall; `lstat` declines to follow the FINAL component only.
    // With the sink directory swapped for a symlink, the lstat followed it onto the very file the
    // raced fd held, the (dev, ino) pair MATCHED, and this returned ok:true with the row landing
    // outside the repository. See `reconcileFdIdentity`.
    //
    // This NARROWS the window; it does NOT eliminate the class. Residuals, in full, in the header:
    // (a) the zero-byte O_CREAT artifact, (b) no pin without O_NOFOLLOW/O_DIRECTORY — surfaced as
    // `dirIdentityEnforced:false`, (c) the check-1 ↔ check-2 sliver, (d) hard-link aliasing after
    // the nlink check. Note (c) is NOT answered by "a swap cannot redirect an already-open fd":
    // the three-phase attack does not redirect the fd, it forges the PATH CHECK's view of where
    // the fd's file lives. That argument was made here before and was wrong (loom#1518, HIGH).
    const ident = reconcileFdIdentity(fd, realSinkDir, sinkPath, dirIdentity, win);
    if (!ident.ok) return fail("sink identity mismatch", ident.reason);

    // (4) Enforce the mode on EVERY append, not just creation — repairs a pre-existing 0o644 sink.
    // A failure must not LOSE the record (the append below is still fd-bound and contained), but
    // it MUST NOT be silent either: `modeEnforced:false` on the return shape makes a sink left at
    // a wider mode observable to the caller, mirroring `nofollowSupported` (R1 F7).
    let modeEnforced = true;
    try {
      fs.fchmodSync(fd, 0o600);
    } catch {
      modeEnforced = false;
    }

    // R2 F2 — LOOP until every byte lands. `fs.writeSync` is a single `write(2)`; it may write
    // FEWER bytes than requested (ENOSPC is the realistic trigger) and returns the count. The
    // `appendFileSync` this module replaced looped internally, so a bare single call was a
    // REGRESSION against the idiom: a short write leaves a truncated, newline-less row, returns
    // ok:true, and the NEXT append concatenates onto it — one corrupt JSONL row silently becomes
    // two. O_APPEND keeps each write atomic w.r.t. other writers, so looping cannot interleave.
    // LAST nlink read before any byte lands — one syscall, and it is the tightest this module can
    // make the check-to-write window (residual (d)). A second name created after the reconcile but
    // before the write still reaches these bytes under another path; this catches the ones planted
    // up to the final instant rather than leaving the whole post-reconcile span unobserved.
    //
    // A DIFFERENT WINDOW from the reconcile-level nlink check, not a spare for it: that one sees a
    // link present at ITS lstat, this one sees a link created after it already returned. Do not
    // remove either believing the other covers it — a probe that plants once and leaves the link
    // trips both and makes them look interchangeable.
    try {
      const preWrite = fs.fstatSync(fd);
      if (preWrite.nlink > 1)
        return fail(
          "hard link refused",
          `sink ${quotePath(sinkPath)} gained a hard link (${preWrite.nlink} names) between ` +
            `the identity reconcile and the write — refusing to append to a file reachable under ` +
            `another name`,
        );
    } catch (e) {
      return fail("fstat failed", `could not re-check the sink before writing: ${escapeControlChars(e.message)}`);
    }

    const payload = Buffer.from(line + "\n", "utf8");
    let written = 0;
    while (written < payload.length) {
      const n = fs.writeSync(fd, payload, written, payload.length - written);
      // A zero-byte write with no error would spin forever; treat it as a hard failure. The row
      // is already partial at this point, so the caller MUST know rather than see ok:true.
      if (!(n > 0))
        return fail(
          "short write",
          `wrote ${written}/${payload.length} bytes to ${quotePath(sinkPath)} and the write ` +
            `stalled — the sink now holds a PARTIAL row`,
        );
      written += n;
    }
    return {
      ok: true,
      sinkPath,
      nofollowSupported,
      modeEnforced,
      dirIdentityEnforced: dirIdentity.enforced === true,
    };
  } catch (e) {
    return fail("append failed", e && e.message ? e.message : String(e));
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // The fd is discarded on every path out; a failed close cannot be acted on and must not
        // mask the result the caller needs.
      }
    }
  }
}

// `DIR_PIN_AVAILABLE` is exported so a test can gate on the REAL platform capability rather than
// on `NOFOLLOW_SUPPORTED` — gating the env-seam test on the env-influenced value made that test
// skip under the very condition it exists to check (caught while red-teaming this fix).
module.exports = {
  appendSinkLine,
  // The ONE control-character escaper for untrusted text that ends up on a terminal. Exported so
  // the PRINT sites downstream of a refusal (`sync-gate2-worktree.mjs::warnMissingTrackingRecord`)
  // apply the same floor to reasons reaching them from any producer, not just this module.
  escapeControlChars,
  NOFOLLOW_SUPPORTED,
  DIR_PIN_AVAILABLE,
  reconcileFdIdentity,
  captureDirIdentity,
};
