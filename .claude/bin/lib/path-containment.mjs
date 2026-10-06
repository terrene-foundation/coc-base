/*
 * Shared path-containment primitives (loom#1797 canonicalisation + loom#1810
 * environment fence).
 *
 * ONE place decides three things, so every surface decides them the same way:
 *
 *   1. realpathForContainment — canonicalise a path for a containment decision.
 *   2. isWithinRoot           — is a canonical candidate at/under a boundary root.
 *   3. trustedTempRoots /     — WHICH temp roots may widen a write boundary, and
 *      isWithinTrustedTemp      where a tool may create its own scratch dir.
 *      trustedTmpdir
 *
 * (1) and (2) moved here VERBATIM from compose.mjs (#1797) when
 * sync-from-canon-objects.mjs became a second consumer; a second copy would
 * drift, and a drifted containment check is a silent hole.
 *
 * #1810 — WHY THE ENVIRONMENT IS NOT CONSULTED FOR (3):
 * compose.mjs built its --out temp allowlist from
 * `[os.tmpdir(), process.env.TMPDIR, "/tmp", "/var/folders"]`. The environment
 * is attacker-controlled anywhere argv is, so `TMPDIR=/Users` made every file
 * under /Users a legal write target — measured: exit 0, a victim outside both
 * the repo and temp overwritten, where the same command with a clean TMPDIR
 * exited 2. No symlink and no race were needed.
 *
 * Dropping `process.env.TMPDIR` alone would NOT have closed it: `os.tmpdir()`
 * itself reads $TMPDIR/$TMP/$TEMP on POSIX, so it carries the same poison.
 * The fence is therefore positive and STATIC — a temp root is trusted only if
 * it canonicalises at/under a system temp root that no environment variable can
 * move. Unrecognised values rank TIGHTEST: an unresolvable or non-system temp
 * root is DROPPED, never trusted (`rules/security.md` § Enforcement-Surface
 * Parity; `rules/zero-tolerance.md` Rule 3 — refuse, never degrade to a default).
 *
 * SCOPE — stated so it is not over-claimed. This closes the ENV-WIDENING class
 * (and, via realpathForContainment, the LEXICAL-BYPASS class). It does NOT
 * defeat check-to-use TOCTOU: a symlink swapped in between the check and the
 * open/write sink is not observable here, and needs fd-based / O_NOFOLLOW
 * enforcement AT the sink.
 *
 * PLATFORM SCOPE — the static fence is POSIX-only. Windows exposes no system
 * temp root that is not itself derived from an environment variable
 * (%TEMP%/%TMP%, and %LOCALAPPDATA% behind them), so there is nothing static to
 * anchor to; on win32 the canonicalised OS temp dir is returned unfenced and the
 * env-widening class remains OPEN there. Named rather than papered over: a
 * heuristic width-check would read as coverage while discriminating nothing.
 */

import fs from "node:fs";

// The OS resolver, NOT the JS one — a case-blind guard is not a guard.
//
// `fs.realpathSync` preserves the CASE of every component it does not itself rewrite.
// On a case-insensitive APFS volume it maps `/var` -> `/private/var` but returns
// `/private/var/FOLDERS/...` for an input of `/VAR/FOLDERS/...`, which never
// string-matches the lowercase trusted root — so the temp-root fence could be walked
// past by changing case. MEASURED on this host, same directory, one inode:
//   js      /VAR/FOLDERS/<XX>/… -> /private/var/FOLDERS/<XX>/…      (fence bypassed)
//   native  /VAR/FOLDERS/<XX>/… -> /private/var/folders/<xx>/…      (fence holds)
// `.native` asks the OS, which canonicalises case, so every spelling of one directory
// canonicalises to one form. Wrapped rather than aliased so the receiver is never
// detached. Used by BOTH the candidate side (`realpathForContainment`) and the boundary
// side (`trustedTempRoots`): a mixed-form comparison is the hazard this module's own
// header warns about, one layer down.
const realpathNative = (p) => fs.realpathSync.native(p);

import os from "node:os";
import path from "node:path";

// System temp roots on POSIX. NOT env-derived and not overridable by one: this
// list is the anchor the whole fence hangs on. The `/private/*` twins are the
// macOS realpath targets of `/tmp` and `/var/*`, kept so the set still holds if
// a root cannot be realpath'd. `/var/folders` is the Darwin per-user temp tree
// that BSD `mktemp` returns regardless of $TMPDIR (the #F89 false-positive
// class); on Linux it simply never exists and is dropped.
const STATIC_POSIX_TEMP_ROOTS = [
  "/tmp",
  "/private/tmp",
  "/var/tmp",
  "/private/var/tmp",
  "/var/folders",
  "/private/var/folders",
];

// Canonicalise an existing path for a CONTAINMENT decision.
//
// path.resolve() only normalises "." / ".." lexically — it does NOT follow
// symlinks, so a symlinked component whose target escapes the boundary is
// lexically indistinguishable from a real in-tree path. Every component that
// EXISTS is therefore resolved through the OS realpath (`realpathNative`, above); a
// not-yet-existing
// remainder (a fresh --out target) is re-appended lexically, which is what
// lets this run before the file is created.
//
// Fails CLOSED: any resolution failure other than a genuinely-absent
// component — EACCES, ELOOP, ENOTDIR — propagates to the caller, as does a
// DANGLING symlink (the component exists via lstat but will not resolve), so
// an unresolvable path is refused rather than silently treated as lexical.
export function realpathForContainment(p) {
  let current = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return tail.length === 0
        ? realpathNative(current)
        : path.join(realpathNative(current), ...tail);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      // ENOENT on something lstat CAN see is a dangling symlink, not an
      // absent component — refuse rather than fall back to the lexical form.
      let componentExists = false;
      try {
        fs.lstatSync(current);
        componentExists = true;
      } catch {
        /* genuinely absent — keep walking up */
      }
      if (componentExists) throw e;
      const parent = path.dirname(current);
      if (parent === current) throw e; // reached the filesystem root
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

// True when the candidate IS the boundary root or lies beneath it.
//
// `canonicalCandidate` MUST already have come from realpathForContainment, and
// `root` is canonicalised here through that SAME resolver, so the two sides are
// always compared in one form. A MIXED-form comparison — one side realpath'd,
// the other merely path.resolve'd — rejects paths genuinely inside the root.
// Passing a merely path.resolve'd candidate reintroduces the lexical bypass.
//
// SCOPE — this closes the LEXICAL-BYPASS class only. It does NOT by itself
// defeat check-to-use TOCTOU: a symlink swapped in between this check and the
// open/write sink is not observable here. Defeating that needs fd-based /
// O_NOFOLLOW enforcement AT the sink.
export function isWithinRoot(canonicalCandidate, root) {
  const resolvedRoot = realpathForContainment(root);
  return (
    canonicalCandidate === resolvedRoot ||
    canonicalCandidate.startsWith(resolvedRoot + path.sep)
  );
}

// The temp roots this repo's tools will trust, canonical and deduplicated.
//
// On POSIX this is EXACTLY the subset of STATIC_POSIX_TEMP_ROOTS that exists
// and resolves here — the environment contributes nothing, because an
// env-supplied root would have to canonicalise under one of these to be
// trusted, and would then already be covered by it. A root that will not
// resolve is DROPPED (tightest), never trusted lexically.
// A TypeError is a fact about the INSTRUMENT, not about the PATH, and the two must not
// share a catch. "This root will not resolve" is safely dropped (the fence tightens).
// "The resolver's own API is gone" is not a resolution outcome at all — and dropping it
// is the OPPOSITE of tight: MEASURED, a tracer that replaced `fs.realpathSync` with a
// plain function dropped its `.native`, every root threw, and this function returned an
// EMPTY list — a fence with no roots, which contains nothing and reports clean. The
// silent branch is the dangerous one, so the API error is rethrown loud and only the
// genuinely-unresolvable path stays dropped.
function rethrowIfApiError(e) {
  if (e instanceof TypeError) throw e;
}

// A FENCE WHOSE ROOT LIST IS EMPTY CONTAINS NOTHING, whatever emptied it. Every
// consumer here asks "is this path under a trusted temp root?" and every one of them
// answers FALSE against an empty list — `isWithinTrustedTemp` is a `.some` over these
// roots. So an empty list does not TIGHTEN the fence, it DELETES it, and it does so
// while reporting clean. Refusing to judge is the only safe answer, and it is
// deliberately the SAME refusal whatever the cause: a platform with no temp root, a
// resolver that failed, or an allowlist edited down to nothing. Guarding the cause
// instead would leave the next cause unguarded — this one already arrived once from a
// direction nobody predicted, and the trigger is fixed separately at the tracer.
function assertRootsResolved(roots) {
  if (roots.length === 0) {
    throw new Error(
      "no trusted temp root resolved; refusing to judge containment — an empty root " +
        "list accepts every path, so it cannot decide whether one is contained",
    );
  }
  return roots;
}

export function trustedTempRoots() {
  if (process.platform === "win32") {
    // No static anchor exists on Windows (see PLATFORM SCOPE in the header).
    try {
      return assertRootsResolved([realpathNative(path.resolve(os.tmpdir()))]);
    } catch (e) {
      rethrowIfApiError(e);
      // The root did not resolve: fall through to the SAME refusal as the POSIX path,
      // so there is one message and the two branches cannot drift.
      return assertRootsResolved([]);
    }
  }
  const roots = [];
  for (const r of STATIC_POSIX_TEMP_ROOTS) {
    try {
      roots.push(realpathNative(r));
    } catch (e) {
      rethrowIfApiError(e);
      /* absent on this OS / unresolvable — DROP, never trust lexically */
    }
  }
  return assertRootsResolved([...new Set(roots)]);
}

// True when a CANONICAL candidate lies at/under a trusted temp root.
// `canonicalCandidate` MUST already have come from realpathForContainment —
// passing a merely path.resolve'd path reintroduces the lexical bypass.
export function isWithinTrustedTemp(canonicalCandidate) {
  return trustedTempRoots().some(
    (root) =>
      canonicalCandidate === root ||
      canonicalCandidate.startsWith(root + path.sep),
  );
}

// ── A RUNNER PRECONDITION, NOT A CONTAINMENT DECISION ───────────────────────
//
// A suite that validates the temp carve-out builds its ESCAPE target OUTSIDE
// every trusted temp root and asserts the guard REFUSES it. That discriminates
// only while the suite's own sandbox is outside those roots too. A checkout
// that resolves UNDER one puts every such target INSIDE the carve-out: the
// guard then legitimately ACCEPTS what the suite expects refused, and the suite
// reds with escapes that are not escapes — a failure reporting a product defect
// that is really a property of where the checkout sits.
//
// So this refuses, and never skips: a suite that cannot execute MUST say so at
// a non-zero status with its reason. A passing skip would report unrun pins as
// pinned (`probe-driven-verification.md` MUST-7 — unrunnable is not a verdict).
//
// `checkoutPath` is resolved through realpathForContainment and tested with
// isWithinTrustedTemp — the SAME resolver and the SAME predicate as every other
// containment decision here, so this cannot drift from the boundary it names.
export const CHECKOUT_UNDER_TRUSTED_TEMP = "checkout-under-trusted-temp-root";

export class CheckoutUnderTrustedTempError extends Error {
  constructor(canonicalCheckout, roots, suite) {
    super(
      `${suite ?? "This suite"} CANNOT EXECUTE FROM THIS CHECKOUT.\n` +
        `  reason: ${CHECKOUT_UNDER_TRUSTED_TEMP}\n` +
        `  checkout: ${canonicalCheckout}\n` +
        `  resolves under a TRUSTED TEMP ROOT: ${roots.join(", ")}\n` +
        `  The escape poles in this suite build targets OUTSIDE the temp carve-out and assert the\n` +
        `  guard REFUSES them. From here those targets are INSIDE it, so the guard correctly\n` +
        `  ACCEPTS them and the escape poles cannot discriminate: the suite would report a\n` +
        `  product defect that is really a property of where this checkout sits.\n` +
        `  Re-run from a checkout that resolves outside every root listed above.`,
    );
    this.name = "CheckoutUnderTrustedTempError";
    this.reason = CHECKOUT_UNDER_TRUSTED_TEMP;
    this.checkout = canonicalCheckout;
    this.roots = roots;
  }
}

// Returns the canonical form on success; throws CheckoutUnderTrustedTempError
// when the candidate resolves under a trusted temp root. Resolution failures
// propagate (fail closed) exactly as they do through realpathForContainment.
export function assertCheckoutOutsideTrustedTemp(checkoutPath, { suite } = {}) {
  const canonical = realpathForContainment(checkoutPath);
  if (isWithinTrustedTemp(canonical)) {
    throw new CheckoutUnderTrustedTempError(canonical, trustedTempRoots(), suite);
  }
  return canonical;
}

let warnedUntrustedTmpdir = false;

// The directory a tool may create its OWN scratch under.
//
// Returns os.tmpdir() unchanged when it is trusted (the overwhelmingly common
// case, and returning it VERBATIM keeps callers' own `startsWith(os.tmpdir())`
// invariants intact on macOS, where os.tmpdir() is the unresolved
// /var/folders/… form). When the environment has moved os.tmpdir() somewhere
// this fence does not trust, the value is IGNORED — loudly, once — in favour of
// a static system temp root. Never silently: an ignored TMPDIR is a real
// behaviour change for whoever set it.
//
// Throws when no trusted temp root exists at all, rather than picking one that
// cannot be shown safe (`rules/zero-tolerance.md` Rule 3 — raise, never degrade).
export function trustedTmpdir() {
  const raw = os.tmpdir();
  let canonical = null;
  try {
    canonical = realpathForContainment(path.resolve(raw));
  } catch {
    canonical = null;
  }
  if (canonical !== null && isWithinTrustedTemp(canonical)) return raw;

  const fallback = trustedTempRoots()[0];
  if (fallback === undefined) {
    throw new Error(
      `path-containment: no trusted system temp root is available (os.tmpdir()=${JSON.stringify(raw)}); refusing to pick one`,
    );
  }
  if (!warnedUntrustedTmpdir) {
    warnedUntrustedTmpdir = true;
    process.emitWarning(
      `os.tmpdir() resolves to ${JSON.stringify(raw)}, which is not under a system temp root — ` +
        `ignoring it and using ${JSON.stringify(fallback)}. Set TMPDIR to a path under ${STATIC_POSIX_TEMP_ROOTS[0]} to control this.`,
      "TrustedTmpdirWarning",
    );
  }
  return fallback;
}

// Test seam: reset the once-only warning latch.
export const _internal = {
  STATIC_POSIX_TEMP_ROOTS,
  resetWarnLatch() {
    warnedUntrustedTmpdir = false;
  },
};
