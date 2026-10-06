#!/usr/bin/env node
/**
 * cross-repo-authorize — write the User-Authorized Exception receipt that
 * clears a bounded cross-repo action, in a location a NORMAL (non-codify)
 * session can write.
 *
 * Closes the RC6 deadlock (journal/0488): `repo-scope-discipline.md`
 * § User-Authorized Exception condition 4 requires a journaled receipt BEFORE
 * a cross-repo action, but `journal/` is `/codify`-gated by the integrity
 * guard — so the receipt the hook (`violation-patterns.js::
 * hasCrossRepoAuthorizationReceipt`) greps was structurally un-producible
 * outside a codify session, and the exception was unsatisfiable in exactly the
 * sessions (normal downstream work) where it is needed.
 *
 * The receipt lives at `.claude/cross-repo-authz/<date>-<slug>-<digest8>.md` — NOT
 * under `journal/`, NOT under the integrity-guarded `.claude/learning/`. It is a
 * working-tree file, greppable while it is INSIDE the guard's authorization
 * window (`violation-patterns.js::_receiptTimestampMs` parses the receipt's own
 * `timestamp:`/`date:` field; filesystem mtime is explicitly REPUDIATED there
 * because git rewrites it on checkout / worktree-add / clone, and the filename's
 * date carries no authorization weight either — see `readReaderWindows`, which
 * reads the window from the guard's declaration site rather than re-declaring
 * it here). ENFORCEMENT never consults git, so an uncommitted receipt clears
 * `repo-scope-discipline.md` condition 4 identically to a committed one.
 *
 * WHETHER to commit it is REPO-CLASS-dependent (2026-08-03, the LOCALITY axis —
 * see `readRepoClass` / `shouldCommitReceipt` below). At loom (`coc-source`) the
 * receipt is a durable forensic witness and committing is disclosure-safe: it is
 * in NO sync tier and is excluded-by-default from the positive-INCLUDE publish
 * allowlist, so it never cascades to a consumer. Those fences govern content
 * flowing OUT OF LOOM and cover NOTHING written into another repo, so at a BUILD
 * repo / USE template / downstream consumer the receipt stays LOCAL — loom's sync
 * gitignores the directory there (`sync-manifest.yaml::target_owned`,
 * `publish: local_only`). The pre-2026-08-03 tool printed and stamped
 * an unconditional "commit it", which is how kailash-py and kailash-rs came to
 * track operator-correlatable receipts in a public-fork-lane history.
 *
 * This tool ONLY writes the receipt (the un-typo-able marker + the five
 * conditions). The AGENT drives the restate→user-confirm ceremony in chat per
 * `.claude/commands/cross-repo-authorize.md`; the tool is invoked AFTER the
 * user confirms, so no receipt lands without a confirmed authorization.
 *
 * Tier semantics (D — journal/0488): a WRITE receipt carries all five
 * conditions (the receipt is the sole distinguisher between an authorized and
 * an unauthorized cross-repo WRITE — byte-identical in the target's history).
 * A user-directed READ carries conditions 1+2+3+5 with condition-4 downgraded
 * to this one-line affordance receipt (NOT eliminated) — a read leaves no
 * durable trace in the target, so condition 4 protects a failure mode reads do
 * not have.
 *
 * Usage:
 *   node .claude/bin/cross-repo-authorize.mjs \
 *     --target <owner/repo> --action "<bounded action>" \
 *     --instruction "<verbatim user instruction>" --mode <read|write> \
 *     [--requester <display_id>] [--repo-root <path>] [--json]
 *
 * Exit codes: 0 = receipt written; 1 = usage / validation error.
 */

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";

// The guard is CommonJS and this tool is ESM, so it is reached with
// `createRequire` — the same bridge `.claude/audit-fixtures/cross-repo-authorize/
// run.mjs` already uses to drive the real guard. See `loadReaderNormalizer`.
const require = createRequire(import.meta.url);

// This tool's own directory (`.claude/bin`). The guard whose window it must agree
// with is its SIBLING (`.claude/hooks/lib`) — they ship as one artifact set — so
// tool-relative resolution is the reliable way to reach it, independent of cwd.
const HERE = path.dirname(fileURLToPath(import.meta.url));

const TARGET_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MODES = new Set(["read", "write"]);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      out.json = true;
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = val;
        i++;
      }
    }
  }
  return out;
}

function fail(msg) {
  process.stderr.write(`cross-repo-authorize: ${msg}\n`);
  process.exit(1);
}

/**
 * The hardened git-subprocess shim (`hooks/lib/git-subprocess-env.js`), loaded
 * the same way as the guard itself: a resolved ABSOLUTE binary plus an env built
 * from constants, so neither PATH nor an ambient `GIT_DIR`/`GIT_CONFIG_*` can
 * steer a call made here at a different repository. Resolved ONCE and memoized —
 * `resolveGitBinary` caches internally, but this also avoids re-`require`ing.
 *
 * Falls back to PATH resolution when the shim is unavailable (a deployment that
 * ships this tool without its sibling hooks lib). The fallback is exactly the
 * behaviour every call site here had before, so it is a degradation to the
 * status quo, never a new hole — and the literal lives HERE, in one resolver,
 * rather than at each call site.
 */
let _gitShim;
function gitShim() {
  if (_gitShim !== undefined) return _gitShim;
  _gitShim = null;
  for (const f of [
    path.resolve(HERE, "..", "hooks", "lib", "git-subprocess-env.js"),
  ]) {
    try {
      const mod = require(f);
      if (mod && typeof mod.resolveGitBinary === "function" && typeof mod.gitEnv === "function") {
        _gitShim = mod;
        break;
      }
    } catch {
      /* shim absent — fall through to the PATH fallback below */
    }
  }
  return _gitShim;
}

function gitInvocation() {
  const shim = gitShim();
  const bin = shim ? shim.resolveGitBinary() : null;
  // `resolveGitBinary` returning null is a REAL answer (git not found), not an
  // error to swallow; the PATH-resolved name is the pre-shim behaviour and the
  // caller's try/catch still turns a genuine absence into a null result.
  return { bin: bin || "git", env: shim ? shim.gitEnv() : process.env };
}

function repoToplevel(startDir) {
  const { bin, env } = gitInvocation();
  try {
    return execFileSync(bin, ["rev-parse", "--show-toplevel"], {
      cwd: startDir || process.cwd(),
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
  } catch {
    return null;
  }
}

// Deterministic date + slug — this is a normal node CLI (NOT a workflow
// script), so Date is available. The leading date is for HUMAN ordering and
// (with the digest) for collision discrimination ONLY; it carries NO
// authorization weight. The guard ages a receipt by its `timestamp:`
// FRONTMATTER, never by the filename and never by filesystem mtime
// (`violation-patterns.js::_receiptTimestampMs`).
//
// The two granularities DIFFER — filename is per-DAY, authorization is
// per-WINDOW (6h at time of writing) — and that mismatch is load-bearing: a
// same-UTC-day re-authorization after the window has expired needs a NEW receipt
// at a NEW path. `writeReceiptImmutable` is what reconciles them.
function isoDateUTC(d) {
  return d.toISOString().slice(0, 10);
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * 8-hex discriminator over the FULL, UNTRUNCATED `(target, action, mode)`
 * triple. Two properties, both load-bearing (loom RS-71):
 *
 *  1. `mode` IS IN THE TRIPLE, DELIBERATELY. Without it a `read` receipt and a
 *     `write` receipt for the same (target, action) resolve to ONE filename, so
 *     writing the cheap read receipt DESTROYS the write authorization —
 *     measured, not theorised: `hasCrossRepoAuthorizationReceipt(t, cwd,
 *     "write")` went `true` → `false`. That is the ceremony's central tier
 *     (repo-scope-discipline.md § Affordance, read/write tier D) defeated by the
 *     filename alone, with exit 0 and no warning. Any future edit that drops
 *     `mode` from this triple re-opens it; the fixture
 *     `RS-71-tier-defeat-measured` is the tripwire.
 *  2. It is computed over the UNTRUNCATED inputs, while `slugify` truncates at
 *     48 chars. Two distinct actions sharing a 48-char prefix collide in the
 *     slug and are separated only here. Truncation discards exactly the
 *     discriminating tail — every Step-7c action opens with the same words — so
 *     without this the second same-day authorization collapsed onto the first's
 *     filename.
 *
 * The join is LENGTH-PREFIXED so it is injective: no delimiter can be forged
 * from within a field (`a|b` and `a` + `|b` hash differently). This is the
 * property that is retained over the plain separator-join (`${target}\n${action}
 * \n${mode}`) the sibling USE-template lane carried: that form is injective ONLY
 * while every field is known free of the separator, which makes the digest's
 * correctness depend on a validator declared 300 lines away in `main`. Injective
 * BY CONSTRUCTION does not decay when a future edit relaxes that validator —
 * and a digest collision here silently merges two DISTINCT authorizations onto
 * one filename, which is the RS-71 defect class. `run.mjs`
 * `digest-injective-under-boundary-shift` is the tripwire.
 *
 * SCOPE — the digest discriminates FILENAMES by action. It does NOT scope
 * AUTHORITY by action, and nothing here does. The guard builds its marker regex
 * from (target, mode) ONLY (`violation-patterns.js::
 * hasCrossRepoAuthorizationReceipt`); the action text never enters the
 * authorization decision. So ONE live receipt for (target, write) clears ANY
 * cross-repo write against that target for the whole window, whatever action it
 * names. `repo-scope-discipline.md` § User-Authorized Exception condition 5
 * ("only the named action against only the named repo") is therefore ATTESTED in
 * every receipt and STRUCTURALLY UNENFORCED. Closing that is a reader-side change
 * (the marker would have to carry an action digest the guard also computes from
 * the intercepted command) and is deliberately NOT attempted here — do not read
 * this digest as if it already did it.
 *
 * 8 hex chars (32 bits) is sized for human-scannable filenames, not collision
 * resistance: this discriminates a handful of same-day receipts in one
 * directory, and a digest collision degrades to the pre-existing behaviour (a
 * loud `wx` miss handled by `writeReceiptImmutable`), never to a silent overwrite.
 */
function tripleDigest(target, action, mode) {
  const parts = [target, action, mode].map((v) => {
    const s = String(v);
    return `${s.length}:${s}`;
  });
  return createHash("sha256").update(parts.join("|"), "utf8").digest("hex").slice(0, 8);
}

/**
 * The guard's authorization window + clock-skew tolerance, read from the ONE
 * place they are declared: `violation-patterns.js`. That module is CommonJS and
 * does NOT export either constant, so this parses the declaration site rather
 * than re-declaring the numbers here. Re-declaring is the drift class this
 * ecosystem has been bitten by repeatedly: the writer and the reader would then
 * each own a copy of one invariant, and the failure mode of drift between them is
 * exactly the deadlock `writeReceiptImmutable` exists to prevent.
 *
 * Only sum-of-products of integer literals is accepted (`6 * 60 * 60 * 1000`);
 * anything else yields null. No eval — the character class is checked first, then
 * the terms are multiplied and added arithmetically.
 *
 * Returns null when EITHER constant cannot be read. Every caller treats null as
 * "cannot prove an existing receipt is live" and therefore writes a FRESH one.
 * That is the safe polarity: the cost of a wrong "write a fresh receipt" is one
 * extra file, while the cost of a wrong "an existing receipt covers you" is an
 * unauthorized cross-repo action taken in the belief that it was authorized.
 */
// Tool-relative FIRST (the guard is this file's shipped sibling), repo-root
// second (an unusual deployment where the tool runs from outside the tree).
// ONE list, shared by `readReaderWindows` (which PARSES the file for constants
// the guard does not export) and `loadReaderNormalizer` (which REQUIRES it for
// a function the guard now does export).
function guardCandidates(root) {
  return [
    path.resolve(HERE, "..", "hooks", "lib", "violation-patterns.js"),
    path.join(root, ".claude", "hooks", "lib", "violation-patterns.js"),
  ];
}

/**
 * The guard's OWN slug normalizer — `violation-patterns.js::normalizeRepoSlug`
 * — loaded, never re-implemented (F47).
 *
 * The writer used to validate `--target` with its private `TARGET_RE` and
 * interpolate the RAW value into the marker, while the reader normalized
 * independently. Two copies of one rule, and they diverged in two measured ways,
 * both fail-closed (the guard fired on an action a receipt had already
 * authorized): `owner/repo.git` passes `TARGET_RE` but the reader strips `.git`,
 * and neither side folded case on a slug GitHub treats case-insensitively.
 * Routing the writer through the reader's function makes the two markers equal
 * BY CONSTRUCTION rather than by two authors agreeing. A third copy of the rule
 * — here, or anywhere — re-opens the class, so do not add one.
 *
 * Returns the function, or null when the guard cannot be loaded (an unusual
 * deployment shipping the tool without its sibling). Null is handled by the
 * caller with a LOUD stderr warning + today's raw-target behaviour: degrading to
 * the pre-F47 marker is no worse than the status quo, whereas refusing to write
 * the receipt would deny an authorization the user has already confirmed.
 */
function loadReaderNormalizer() {
  // TOOL-RELATIVE ONLY — deliberately NOT `guardCandidates(root)`.
  //
  // `readReaderWindows` may safely consult the repo-root copy because it only
  // READS AND PARSES that file. This one `require`s it, which EXECUTES it, and
  // `root` comes from operator-supplied `--repo-root` (or cwd). Falling back to
  // `<root>/.claude/hooks/lib/violation-patterns.js` would therefore run
  // ARBITRARY code out of whatever repository the tool was pointed at, during a
  // ceremony whose entire job is to authorize an action against another repo.
  // The shipped sibling is the only trusted copy, so a missing sibling degrades
  // to the loud warning at the call site rather than to someone else's module.
  const f = path.resolve(HERE, "..", "hooks", "lib", "violation-patterns.js");
  try {
    const mod = require(f);
    if (mod && typeof mod.normalizeRepoSlug === "function")
      return mod.normalizeRepoSlug;
  } catch {
    /* sibling absent or unloadable — caller warns and uses the raw target */
  }
  return null;
}

function readReaderWindows(root) {
  const candidates = guardCandidates(root);
  const num = (src, name) => {
    const m = src.match(new RegExp(`^const ${name}\\s*=\\s*([0-9 *+]+);`, "m"));
    if (!m) return null;
    const v = m[1]
      .split("+")
      .reduce(
        (sum, term) =>
          sum + term.split("*").reduce((p, f) => p * Number(f.trim()), 1),
        0,
      );
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  for (const f of candidates) {
    let src;
    try {
      src = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const windowMs = num(src, "CROSS_REPO_RECEIPT_WINDOW_MS");
    const skewMs = num(src, "CROSS_REPO_RECEIPT_SKEW_MS");
    if (windowMs !== null && skewMs !== null) return { windowMs, skewMs };
  }
  return null;
}

// Mirror of `violation-patterns.js::_receiptTimestampMs`, INCLUDING the `date:`
// fallback: this predicate must answer the same question the guard answers, so a
// receipt the guard would reject as stale must not be reported here as live.
function receiptTimestampMs(content) {
  let m = content.match(/^timestamp:\s*(\S+)\s*$/m);
  if (!m) m = content.match(/^date:\s*(\S+)\s*$/m);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isNaN(t) ? null : t;
}

// `modeAlt` is a regex ALTERNATION, not necessarily a literal: a bare "write"
// or "read" (the exact-mode form `receiptLiveness` wants when it is deciding
// whether the file it is about to collide with is THIS receipt), or the guard's
// tier alternation `(?:read|write)` (what `originMainReceiptReachability` wants,
// because that question is "would the guard clear an action of this mode", and
// the guard clears a READ with either receipt). Both callers are in this file
// and both pass a value derived from the validated `MODES` set.
function markerRegex(target, modeAlt) {
  const esc = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^cross-repo-authorized:[ \\t]+${esc}[ \\t]+${modeAlt}[ \\t]*$`,
    // "mi", NOT "m". The reader's markerRe carries `i`; a writer that folds the
    // SLUG but not the MATCH is the same two-copies-of-one-rule divergence this
    // change exists to end — it would MISS a mixed-case receipt the guard HONOURS.
    // Both misses are fail-safe (a duplicate receipt; a spurious warning), which is
    // exactly why it would have survived review unnoticed.
    "mi",
  );
}

// Mirror of the guard's tier alternation (`violation-patterns.js::
// hasCrossRepoAuthorizationReceipt`): a WRITE action is cleared ONLY by a write
// receipt; a READ action accepts read OR write.
function guardModeAlt(mode) {
  return mode === "read" ? "(?:read|write)" : "write";
}

const ORIGIN_MAIN_REF = "origin/main";
const ORIGIN_MAIN_SCAN_BUDGET = 200;

function gitCapture(root, argv) {
  const { bin, env } = gitInvocation();
  try {
    return execFileSync(bin, argv, {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
      timeout: 5000,
    });
  } catch {
    return null;
  }
}

/**
 * F48 — would a consumer reading from `origin/main` see a receipt the guard
 * honours for this (target, mode) RIGHT NOW?
 *
 * WHY THIS EXISTS. Enforcement never consults git: the guard greps the WORKING
 * TREE, so an uncommitted receipt clears `repo-scope-discipline.md` condition 4
 * in the session that wrote it. That is correct, and it is also why this tool
 * printed an unconditional `✅ … receipt written` and told the operator to
 * `git add && git commit` — advice whose only effect at loom is a commit on
 * local `main`, which branch protection forbids pushing. The consumer that then
 * cannot see the receipt is `.claude/bin/sync-gate2-worktree.mjs`, which cuts
 * its scratch tree with `git worktree add --detach <scratch> origin/main`: a
 * receipt committed locally and never landed is simply ABSENT there, and the
 * lane halts with the operator holding a green checkmark that said otherwise.
 *
 * WHAT THIS INSTRUMENT CAN AND CANNOT SAY (instrument-discipline.md MUST-1/4).
 * It answers exactly one question — "is a LIVE marker for (target, mode) present
 * in the `origin/main` TREE at this instant" — and it would answer `false` by
 * finding no such blob, which is the result it prints when the proposition is
 * false. Four things it does NOT say, each of which would be a different
 * question:
 *   - it does NOT say the consumer lane will pass LATER. Authorization expires
 *     (the guard's window), so a receipt that lands by PR after the window has
 *     elapsed is reachable and dead. Hence the expiry note in the warning.
 *   - it reads the LOCAL remote-tracking ref and deliberately does NOT fetch (a
 *     confirmed-authorization ceremony must not block on the network). A stale
 *     ref biases toward `false` — it can miss a receipt landed remotely since
 *     the last fetch — which is the fail-LOUD direction: an unnecessary warning,
 *     never a false all-clear.
 *   - an unresolvable `origin/main` is reported `false` with the reason, not
 *     silently skipped.
 *   - it says nothing about the WORKING TREE, which is authorized regardless.
 */
function originMainReceiptReachability(root, target, mode, nowMs, windows) {
  const head = gitCapture(root, ["rev-parse", "--verify", `${ORIGIN_MAIN_REF}^{commit}`]);
  if (!head)
    return { reachable: false, reason: `'${ORIGIN_MAIN_REF}' does not resolve here (no such remote-tracking ref)` };
  if (!windows)
    return {
      reachable: false,
      reason:
        "the guard's authorization window could not be read from violation-patterns.js, so no committed receipt can be shown to be LIVE",
    };
  const listing = gitCapture(root, [
    "ls-tree", "-r", "--name-only", "-z", ORIGIN_MAIN_REF, "--",
    ".claude/cross-repo-authz/",
  ]);
  if (listing === null)
    return { reachable: false, reason: `could not list '.claude/cross-repo-authz/' in ${ORIGIN_MAIN_REF}` };
  // DESCENDING NAME ORDER — load-bearing, not a micro-optimisation. For the dated
  // receipts this IS newest-first; `README.md` sorts after `2026-*` ascending and so
  // lands at position 1 descending, costing one budget slot and matching nothing. `ls-tree -r` emits
  // entries sorted by NAME, and every receipt filename is `YYYY-MM-DD`-prefixed,
  // so the natural listing is chronologically ASCENDING. Scanning it in order
  // spends the budget on the OLDEST receipts and never reaches the newest. A LIVE
  // receipt is by definition <= the 6h window old, hence always among the newest,
  // hence NEVER examined once the directory exceeds the budget — measured at 279
  // receipts against a budget of 200, so `reachable` was deterministically false
  // at loom, the only repo that runs this. A check that cannot return its own
  // positive verdict is the instrument-discipline.md MUST-1 failure this
  // function's own docblock invokes.
  const paths = listing.split("\0").filter(Boolean).reverse();
  const re = markerRegex(target, guardModeAlt(mode));
  let scanned = 0;
  for (const p of paths) {
    if (scanned >= ORIGIN_MAIN_SCAN_BUDGET) break;
    scanned++;
    const blob = gitCapture(root, ["show", `${ORIGIN_MAIN_REF}:${p}`]);
    if (!blob || !re.test(blob)) continue;
    const ts = receiptTimestampMs(blob);
    if (ts === null) continue;
    if (nowMs - ts > windows.windowMs) continue; // committed but expired
    if (ts - nowMs > windows.skewMs) continue; // implausibly future-dated
    return { reachable: true, reason: `live receipt ${p} is already in ${ORIGIN_MAIN_REF}`, via: p };
  }
  return {
    reachable: false,
    reason:
      paths.length === 0
        ? `${ORIGIN_MAIN_REF} carries no '.claude/cross-repo-authz/' receipts at all`
        : scanned < paths.length
          ? // TRUNCATED: say what was examined, never what was not. Reporting a
            // property of `paths.length` on evidence from `scanned` is a tally
            // reported in place of the hits (instrument-discipline.md MUST-3b).
            `the ${scanned} NEWEST of ${paths.length} receipt(s) in ${ORIGIN_MAIN_REF} carry no LIVE marker for '${target} ${mode}' (scan budget ${ORIGIN_MAIN_SCAN_BUDGET} reached; older receipts unexamined, and a live receipt would be among the newest)`
          : `none of the ${paths.length} receipt(s) in ${ORIGIN_MAIN_REF} carries a LIVE marker for '${target} ${mode}'`,
  };
}

/**
 * Would the GUARD honour this on-disk receipt right now? Three ways to be dead,
 * and the EEXIST branch must distinguish all three from "live" before it can
 * tell a caller their action is already authorized:
 *   - unreadable / truncated (a partial write, or a hand-edited file);
 *   - no marker line for this (target, mode) — so the guard's grep misses it;
 *   - `timestamp:` outside the guard's window (stale) or beyond skew (future).
 * Returns the parsed timestamp on success so the refusal can cite it.
 */
function receiptLiveness(filePath, target, mode, nowMs, windows) {
  if (!windows) return null;
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  if (!markerRegex(target, mode).test(content)) return null;
  const ts = receiptTimestampMs(content);
  if (ts === null) return null;
  if (nowMs - ts > windows.windowMs) return null;
  if (ts - nowMs > windows.skewMs) return null;
  return { ts };
}

/**
 * Create a file that did not exist, and NEVER leave a truncated one behind.
 *
 * `wx` is O_CREAT|O_EXCL: the open either creates the file or fails EEXIST. The
 * two phases are separated deliberately — a failure at OPEN created nothing, so
 * there is nothing to clean up (and unlinking would risk removing a file another
 * process just created), whereas a failure at WRITE (ENOSPC, EIO) leaves an
 * empty-or-truncated file that this path's own `wx` will then refuse forever.
 * That truncated file carries no marker, so the guard correctly refuses to honour
 * it — permanently poisoning the path for every retry. Unlink on the write path
 * only. Returns true = created, false = already existed.
 */
function tryCreateExclusive(filePath, body) {
  let fd;
  try {
    fd = fs.openSync(filePath, "wx", 0o644);
  } catch (e) {
    if (e && e.code === "EEXIST") return false;
    throw e; // nothing was created — nothing to remove
  }
  try {
    fs.writeFileSync(fd, body, "utf8");
    fs.closeSync(fd);
  } catch (e) {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* nothing to remove */
    }
    throw e;
  }
  return true;
}

/**
 * Write the receipt, holding BOTH invariants at once.
 *
 * Immutability: an existing receipt is never opened for writing, truncated, or
 * removed. It is the sole distinguisher between an authorized cross-repo action
 * and an unauthorized one (`repo-scope-discipline.md` condition 4: "present =
 * in-scope, absent = critical L1"), and the directory is gitignored outside loom
 * — a clobbered receipt has no reflog to recover from. Silently destroying one is
 * the RS-71 defect.
 *
 * Refreshability: the filename is DATE-granular while authorization is
 * WINDOW-granular (6h). Refusing every same-day re-run therefore deadlocked the
 * ceremony for up to 18h per (target, action, mode) per UTC day: the guard had
 * already expired the receipt, the operator re-ran the ceremony, and the tool
 * refused with "already authorizes this action" — which was FALSE, because the
 * EEXIST branch never opened the file it was making claims about. The guard is
 * `halt-and-report`, not `block`, so the agent could then proceed on the tool's
 * own false assurance: an unauthorized cross-repo action believed to be
 * authorized.
 *
 * WITHDRAWN — the prior NAMED DEVIATION on this surface. This function replaces a
 * `wx` + numeric-`-N`-suffix writer whose doc recorded a named deviation from
 * RS-71's "create-or-fail", justified by "a hard failure would deadlock a
 * legitimate re-authorization after the 6-hour window expires". That premise is
 * now handled directly rather than worked around: the refusal is LIVENESS-AWARE,
 * so it fires only against a receipt read from disk and confirmed still live, and
 * an expired one is superseded by a fresh receipt at a time-suffixed path. The
 * deviation's goal (never deadlock, never clobber) is met with a STRONGER
 * guarantee — the numeric-suffix writer never deadlocked, but it also never told
 * the operator when a live authorization already covered them, and it wrote a new
 * receipt on every invocation. The old `-N` names remain matched by the family
 * scan below, so receipts written by that predecessor are still found. Do NOT
 * re-add a deviation note for a deadlock that no longer exists.
 *
 * Note the trap in the history. BEFORE `wx`, the colliding write destroyed the
 * audit record but incidentally REFRESHED its timestamp, so authorization kept
 * working; `wx` protects the record and creates the deadlock. Both halves are
 * needed, and they stop being in tension once the FILENAME carries more than day
 * granularity — which is the whole content of the time suffix below. Do NOT "fix"
 * a recurrence by widening the guard's window or by dropping `wx`.
 *
 * So: refuse ONLY against a receipt read from disk and confirmed LIVE; otherwise
 * write a fresh one at a non-colliding path.
 */
const RECEIPT_TIME_SUFFIX_BUDGET = 32;
function writeReceiptImmutable(dir, baseName, body, ctx) {
  const canonical = path.join(dir, `${baseName}.md`);
  if (tryCreateExclusive(canonical, body)) return { path: canonical };

  // Something already occupies the canonical path. Scan the whole family for
  // this (date, target, action, mode) — the canonical name, any time-suffixed
  // siblings from earlier expiries today, and any legacy `-N` siblings from the
  // predecessor writer — and refuse only if one is still live.
  //
  // REGULAR FILES ONLY, exactly as the guard scans (`violation-patterns.js`:
  // `readdirSync(d, {withFileTypes:true})` then `if (!f.isFile()) continue`).
  // This writer and that reader MUST agree about which directory entries are
  // receipts at all, and `receiptLiveness` uses `readFileSync`, which FOLLOWS
  // symlinks. Without the `isFile()` filter, a symlink named into this family and
  // pointing at a live receipt outside the directory makes `openSync(..,"wx")`
  // fail EEXIST, the scan read THROUGH the link and find it live, and this tool
  // print "it DOES authorize this action right now — re-run not needed" for an
  // entry the guard skips entirely. The guard is halt-and-report, not block, so
  // that assurance is exactly what an agent rationalizes past. Same divergence
  // shape as the defect this whole function exists to close, through another door.
  const esc = baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const familyRe = new RegExp(`^${esc}(?:-[0-9]+(?:-[0-9]+)?)?\\.md$`);
  let entries = [];
  try {
    entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  } catch {
    /* unreadable dir — fall through to the fresh-write attempt, which will fail loudly */
  }
  for (const f of entries) {
    if (!familyRe.test(f)) continue;
    const fp = path.join(dir, f);
    const live = receiptLiveness(fp, ctx.target, ctx.mode, ctx.nowMs, ctx.windows);
    if (live) return { refused: true, path: fp, ts: live.ts };
  }

  // Nothing on disk authorizes this action right now. Add a time component so the
  // new receipt lands beside the dead ones instead of colliding with them.
  const hhmmss = ctx.iso.slice(11, 19).replace(/:/g, "");
  for (let n = 1; n <= RECEIPT_TIME_SUFFIX_BUDGET; n++) {
    const cand = path.join(
      dir,
      `${baseName}-${hhmmss}${n === 1 ? "" : `-${n}`}.md`,
    );
    if (tryCreateExclusive(cand, body)) return { path: cand };
  }
  return { exhausted: true };
}

/**
 * Read this repo's CLASS from `.claude/VERSION::type` — the discriminator
 * `issue-triage-routing.md` already mandates reading before any class-dependent
 * disposition. Returns the declared type string, or null when it cannot be read.
 *
 * Used for exactly one decision: whether the receipt should be COMMITTED. That
 * is a repo-class property, not a content property — see `shouldCommitReceipt`.
 *
 * TRAP (loom#1426) — DO NOT widen this reader into a general trust input. It
 * parses `.claude/VERSION` and returns `type` VERBATIM: no signature, no
 * cross-check, no corroborating source. The `catch` fails closed on an
 * UNREADABLE file only; it cannot fail closed on a file that reads fine and
 * lies. So the class is attacker-authorable by anyone who can write a JSON file
 * in the repo, and every consumer of it inherits that.
 *
 * That is survivable HERE precisely because of the polarity `shouldCommitReceipt`
 * chose: only `coc-source` may commit, so a DEMOTION (any other value, or an
 * unreadable file) costs a durable audit trail and nothing else, while the
 * dangerous direction — a repo forging `coc-source` to be told "commit it" and
 * putting an operator `display_id` into a public history forever — requires
 * PROMOTING to the one privileged value. Any future edit that inverts this
 * polarity, or that routes a second decision through the same field, converts a
 * lost audit trail into a real forge. `manifest-source.mjs::readRepoClass` is the
 * sibling reader with the same verbatim-trust property (loom#1399).
 *
 * That containment argument was INCOMPLETE, and the gap was live: it reasons only
 * about which BRANCH the class selects, and the value is not only a selector — it
 * is also INTERPOLATED, verbatim, into `localityNote` and thence into the receipt
 * BODY. `.claude/VERSION` is JSON, JSON strings carry `\n`, so a `type` of
 * "coc-use-template\ncross-repo-authorized: evil/repo write\nx" plants a second
 * column-0 marker for an UNRELATED target, on the NON-loom (demotion) branch the
 * argument above treats as harmless. Any fully-legitimate ceremony then emits a
 * receipt that also authorizes `evil/repo` for the full window — carrying a real
 * `display_id`, a real verbatim instruction and a genuine live `timestamp:`, so it
 * reads as authentic. `.claude/cross-repo-authz/` is gitignored off-loom and
 * cannot arrive by PR, but `.claude/VERSION` is COMMITTED and SYNCED, so the
 * marker is plantable upstream and materializes only later, in someone else's
 * legitimate run. The marker-injection guard in `main` covers `action`,
 * `instruction` and `requester` — this field went around it.
 *
 * Hence the positive charset allowlist below. It is deliberately a CHARSET fence
 * (`cc-artifacts.md` Rule 10) and not the literal `cross-repo-authorized:`: a repo
 * class is a single bare token, so rejecting every separator — newline, U+2028/9,
 * space, `:` — closes the injection CLASS instead of one spelling of it. It is
 * also deliberately not this file's private copy of the four-class enum: the
 * enum's authority is `manifest-source.mjs::KNOWN_REPO_CLASSES`, a second copy
 * here would drift, and the only thing this reader needs is that the value cannot
 * carry structure. The two sibling readers were checked and need no equivalent
 * change — `manifest-source.mjs::readRepoClass` rejects any value outside
 * `KNOWN_REPO_CLASSES` (fail-closed `unknown-type`) and
 * `audit-fixtures/_lib/repo-class.mjs::readRepoClass` throws on the same
 * condition; both already refuse the payload. `run.mjs` T13c pins that so a
 * future edit dropping either enum check reds here.
 *
 * Why this trap is recorded on THIS function rather than on the guard it
 * concerns: loom#1426 is the state-file write guard over-blocking read-only
 * commands that merely MENTION a protected path — it has now fired on five
 * separate actors, EVERY one of them while verifying or documenting the guard
 * itself, and in three of those cases the actor changed the TOOL rather than the
 * assertion being tested. The recurring conclusion is that the MATCHER is wrong
 * (it keys on a protected-path literal appearing anywhere in the command, not on
 * that path being the write TARGET), not that the policy should be relaxed —
 * relaxing removes a real control to fix a semantics bug. The narrowing
 * direction the issue's residuals (k)/(l)/(m) leave open is destination-
 * awareness: decide on the redirect target. This function is where a maintainer
 * reaching for "make it repo-class-aware" would arrive, and it is exactly the
 * input that cannot carry that weight.
 */
function readRepoClass(root) {
  try {
    const raw = fs.readFileSync(path.join(root, ".claude", "VERSION"), "utf8");
    const t = JSON.parse(raw).type;
    // A repo class is a bare token. Anything carrying structure — a line
    // terminator, a space, a `:` — is refused outright (null => fail-closed
    // non-loom branch, and "unknown" in the trailer). See the TRAP note above for
    // why `typeof t === "string"` was a forged-authorization primitive.
    return typeof t === "string" && /^[A-Za-z0-9._-]+$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * Should this repo COMMIT its cross-repo authorization receipts?
 *
 * ONLY `coc-source` (loom) may. The ceremony's containment argument — that
 * `.claude/cross-repo-authz/` is never distributed, guaranteed by
 * `sync-tier-aware` no_tier_match + `edition-emit.mjs::CLIENT_TEMPLATE_REMOVE` +
 * `community-membership` EXCLUDE_WITHIN — describes fences on content flowing
 * OUT OF LOOM. A receipt committed INTO a BUILD repo or a USE template has THAT
 * repo's git history as its distribution channel, which no loom fence covers,
 * and the receipt carries the requester's operator display_id.
 *
 * FAIL-CLOSED on an unreadable/absent `.claude/VERSION`: an unknown class is
 * treated as NOT-loom, so the tool advises keeping the receipt local. The cost
 * of a wrong "keep local" is a lost durable audit trail; the cost of a wrong
 * "commit" is operator identity in a public repo's history forever. Enforcement
 * is identical either way — the guard greps the working tree, not git.
 */
function shouldCommitReceipt(repoClass) {
  return repoClass === "coc-source";
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const rawTarget = args.target;
  const action = args.action;
  const instruction = args.instruction;
  const mode = args.mode;
  const requester = args.requester || process.env.COC_DISPLAY_ID || "unknown";

  if (!rawTarget || rawTarget === true) fail("missing --target <owner/repo>");
  if (!TARGET_RE.test(rawTarget))
    fail(`--target ${rawTarget} is not a valid <owner/repo> slug`);
  if (!action || action === true) fail('missing --action "<bounded action>"');
  if (!mode || !MODES.has(mode))
    fail("missing/invalid --mode (must be read|write)");
  if (mode === "write" && (!instruction || instruction === true))
    fail('a WRITE receipt MUST carry --instruction "<verbatim user instruction>" (condition 1)');

  // Reject marker-injection: a line terminator or the literal
  // `cross-repo-authorized:` in any free-text field could forge a SECOND
  // authorization line (a receipt for target X that also clears target Y). The
  // hook matches the marker anchored per-line, so a smuggled
  // `\ncross-repo-authorized: victim/repo write` would otherwise authorize an
  // unrelated target. Reject at the source.
  //
  // U+2028 / U+2029 are in the class because ECMAScript counts them as
  // LineTerminators: an `m`-flagged `^`/`$` — which is what BOTH the guard's
  // marker regex and this file's `receiptTimestampMs` use — genuinely breaks on
  // them, while `\r\n` alone does not match them. Today they are unexploitable
  // for the marker itself (the literal is blocked case-insensitively on its own),
  // but `receiptLiveness` now reads an ANCHORED `^timestamp:` line back out of a
  // receipt, so a smuggled line terminator in `action:` is one edit away from
  // forging the field that decides whether a receipt is still live.
  for (const [name, val] of [
    ["action", action],
    ["instruction", instruction],
    ["requester", requester],
  ]) {
    if (typeof val === "string" && (/[\r\n\u2028\u2029]/.test(val) || /cross-repo-authorized:/i.test(val)))
      fail(`--${name} MUST NOT contain a line terminator or the literal "cross-repo-authorized:" (marker-injection guard)`);
  }

  const root = repoToplevel(args["repo-root"] || process.cwd());
  if (!root) fail("not inside a git working tree");

  // F47 — the marker slug is the READER's canonical form, produced by the
  // READER's own function. `TARGET_RE` above stays as the ACCEPT gate (it is
  // what keeps a URL form, a path traversal or a line terminator out of the
  // marker); this is the CANONICALIZE step that follows it. Everything derived
  // from the target downstream — the marker, the filename slug, the triple
  // digest, the receipt frontmatter — uses `target`, never `rawTarget`, so a
  // `.git` suffix or a case variant cannot reach the marker line.
  const normalizeSlug = loadReaderNormalizer();
  let target = rawTarget;
  if (normalizeSlug) {
    const canonical = normalizeSlug(rawTarget);
    // TARGET_RE accepts shapes the normalizer rejects (`owner/.git` strips to a
    // bare `owner`). Fail LOUD rather than fall back to the raw value: a target
    // that does not survive canonicalization is one the guard could never match.
    if (!canonical)
      fail(
        `--target ${rawTarget} does not normalize to an <owner/repo> slug ` +
          `(violation-patterns.js::normalizeRepoSlug returned null) — the guard could never match a marker built from it`,
      );
    target = canonical;
  } else {
    // NOT a silent fallback (zero-tolerance.md Rule 3): the degradation is
    // named on stderr so an operator sees that the two sides are unlinked here.
    process.stderr.write(
      "cross-repo-authorize: WARNING — could not load violation-patterns.js::normalizeRepoSlug; " +
        `using --target verbatim. A '.git' suffix or a case variant may not match the guard's marker regex.\n`,
    );
  }

  const dir = path.join(root, ".claude", "cross-repo-authz");
  fs.mkdirSync(dir, { recursive: true });

  // Repo class decides ONE thing: commit vs keep-local (see shouldCommitReceipt).
  const repoClass = readRepoClass(root);
  const commitReceipt = shouldCommitReceipt(repoClass);

  const now = new Date();
  const date = isoDateUTC(now);
  const ts = now.toISOString();
  const slug = slugify(`${target}-${action}`) || "cross-repo";
  // `mode` is in the digest DELIBERATELY — see tripleDigest. Without it a read
  // receipt and a write receipt for one (target, action) share a filename and
  // the read silently revokes the write.
  const baseName = `${date}-${slug}-${tripleDigest(target, action, mode)}`;

  // The marker line MUST match violation-patterns.js::
  // hasCrossRepoAuthorizationReceipt exactly: `cross-repo-authorized: <slug> <mode>`.
  // The <mode> qualifier is TIER-ENFORCING: a WRITE action is cleared ONLY by a
  // `write` receipt; a READ action accepts read OR write. Without it a cheap
  // read receipt would clear a write (the design's central tier defeated).
  const marker = `cross-repo-authorized: ${target} ${mode}`;
  const verbatim =
    instruction && instruction !== true ? instruction : "(read; verbatim instruction not required for a downgraded condition-4 read receipt)";

  // The conditions are OBLIGATIONS the ceremony (`.claude/commands/cross-repo-authorize.md`)
  // MUST have satisfied before this receipt was written — NOT facts this CLI can
  // itself verify (a Node process cannot read the session transcript). The
  // verbatim-instruction field below is the real forensic anchor; a gate-review
  // verifies these obligations against the session (evidence-first-claims.md).
  const conditionsBlock =
    mode === "write"
      ? [
          "condition_1_user_initiated: REQUIRED — a genuine user turn (see verbatim below)",
          "condition_2_explicit_specific: REQUIRED — names the target repo AND the exact bounded action",
          "condition_3_confirmed: REQUIRED — the ceremony restated action+target and the user confirmed yes/no BEFORE this write",
          "condition_4_receipt_before_acting: SATISFIED — THIS receipt is the durable witness, written BEFORE the command runs",
          "condition_5_scoped_exactly: REQUIRED — only the named action against only the named repo",
        ]
      : [
          "condition_1_user_initiated: REQUIRED — a genuine user turn",
          "condition_2_explicit_specific: REQUIRED — names the target repo AND the exact bounded READ",
          "condition_3_confirmed: REQUIRED — the ceremony restated action+target and the user confirmed yes/no BEFORE this write",
          "condition_4_receipt_before_acting: DOWNGRADED (READ tier) — one-line affordance receipt; a read leaves no durable trace in the target",
          "condition_5_scoped_exactly: REQUIRED — only the named read against only the named repo",
        ];

  // The trailer's locality guidance is REPO-CLASS-AWARE. The pre-2026-08-03
  // trailer stamped an unconditional "commit it for durable team audit" into
  // EVERY receipt at EVERY repo, carrying loom's containment argument to repos
  // that argument does not cover — which is how kailash-py and kailash-rs came
  // to track operator-correlatable receipts in a public-fork-lane history.
  const localityNote = commitReceipt
    ? "LOCALITY: this repo is `type: coc-source` (loom). COMMIT this receipt for\n" +
      "  durable team audit. Committing is disclosure-safe HERE because\n" +
      "  `.claude/cross-repo-authz/` never leaves loom: sync-tier-aware matches no\n" +
      "  tier (no_tier_match), edition-emit.mjs::CLIENT_TEMPLATE_REMOVE strips it,\n" +
      "  and community-membership EXCLUDE_WITHIN fences the public-fork publish."
    : `LOCALITY: this repo is \`type: ${repoClass || "unknown"}\` — NOT loom. DO NOT COMMIT\n` +
      "  this receipt; leave it on disk. The three fences that make committing safe at\n" +
      "  loom (sync-tier-aware no_tier_match, edition-emit CLIENT_TEMPLATE_REMOVE,\n" +
      "  community-membership EXCLUDE_WITHIN) all govern content flowing OUT OF LOOM\n" +
      "  and cover nothing written INTO this repo — whose own git history is its\n" +
      "  distribution channel, and this file carries the requester's display_id.\n" +
      "  loom's sync gitignores `.claude/cross-repo-authz/` here\n" +
      "  (sync-manifest.yaml::target_owned, publish: local_only); do not override it.\n" +
      "  That same declaration ALSO vetoes any loom purge of this directory — your\n" +
      "  receipts are yours, and loom must neither publish nor delete them.\n" +
      "  Only DURABLE MULTI-SESSION audit is traded away — the hook's working-tree\n" +
      "  grep above is unaffected.";

  const body = `---
type: cross-repo-authorization-receipt
date: ${date}
timestamp: ${ts}
requester: ${requester}
target: ${target}
action: ${action}
mode: ${mode}
---

# Cross-Repo Authorization Receipt

${marker}

## Bounded action

- **Target repo:** ${target}
- **Action (${mode}):** ${action}
- **Requester (display_id):** ${requester}
- **Authorized at:** ${ts}

## Verbatim user instruction

> ${verbatim.replace(/\n/g, "\n> ")}

## Five-condition attestation (repo-scope-discipline.md § User-Authorized Exception)

${conditionsBlock.map((l) => `- ${l}`).join("\n")}

<!--
  This receipt is the ONLY distinguisher between an authorized and an
  unauthorized cross-repo action. It is written by
  .claude/bin/cross-repo-authorize.mjs AFTER the user confirmed the restated
  action+target in chat, and BEFORE the action runs. The hook
  (violation-patterns.js::hasCrossRepoAuthorizationReceipt) greps this file's
  marker line in the WORKING TREE — not in git — so enforcement does not depend
  on whether this file is committed. Authorization EXPIRES: the guard bounds a
  receipt's age by the "timestamp:" field above — NOT by filesystem mtime (git
  rewrites mtime on checkout / worktree-add / clone) and NOT by the filename's
  date — so it stops clearing anything once that window elapses. Editing that
  timestamp: field is editing the authorization's expiry. Re-run the ceremony
  for a fresh one; it will not overwrite this record.

  ${localityNote}
-->
`;

  // Immutable, but refreshable — see `writeReceiptImmutable`. An existing receipt
  // is never clobbered; a re-run is refused ONLY when a receipt read from disk is
  // confirmed still LIVE (marker present for this target+mode, `timestamp:` inside
  // the guard's window). Otherwise a fresh receipt lands at a new path, because a
  // receipt the guard has already expired authorizes nothing and telling the
  // caller otherwise is how an unauthorized action gets taken believing it was
  // authorized.
  const windows = readReaderWindows(root);
  const written = writeReceiptImmutable(dir, baseName, body, {
    target,
    mode,
    nowMs: now.getTime(),
    iso: ts,
    windows,
  });

  if (written.refused) {
    const hrs = windows ? windows.windowMs / 3600000 : null;
    fail(
      `a LIVE receipt for this exact (date, target, action, mode) already exists: ${path.relative(root, written.path)}\n` +
        `       Authorized at ${new Date(written.ts).toISOString()}${hrs ? `, still inside the ${hrs}h authorization window` : ""}\n` +
        `       the guard enforces, so it DOES authorize this action right now — re-run not needed.\n` +
        `       (Once it expires, re-running the ceremony writes a NEW receipt; it does not deadlock.)\n` +
        `       For a genuinely DIFFERENT action, pass a different --action (the filename discriminates\n` +
        `       on the full action text — but note authority itself is scoped to target+mode, not action).`,
    );
  }
  if (written.exhausted) {
    fail(
      `could not find a free receipt filename under ${path.relative(root, dir)} for ${baseName} — ` +
        `${RECEIPT_TIME_SUFFIX_BUDGET + 1} candidates all exist and none is live. Investigate before ` +
        `proceeding; do NOT delete receipts to make room.`,
    );
  }
  const filePath = written.path;

  const rel = path.relative(root, filePath);

  // F48 — REACHABILITY, fail-LOUD. Only a repo that COMMITS its receipts has a
  // git-visible surface for a consumer to read, so the question is asked only
  // there; everywhere else the working-tree grep is the whole contract and the
  // answer is NOT-APPLICABLE rather than false (see the JSON note below).
  const reach = commitReceipt
    ? originMainReceiptReachability(root, target, mode, now.getTime(), windows)
    : null;
  const branch = commitReceipt
    ? (gitCapture(root, ["rev-parse", "--abbrev-ref", "HEAD"]) || "").trim() || null
    : null;
  const windowHrs = windows ? windows.windowMs / 3600000 : null;

  const result = {
    ok: true,
    receipt: rel,
    // `target` is the CANONICAL slug that went into the marker line; `target_input`
    // is what the caller passed. They differ whenever F47 canonicalization did
    // work (a `.git` suffix, a case variant), and a caller comparing the two sees
    // exactly what the guard will be matching.
    target,
    target_input: rawTarget,
    action,
    mode,
    marker,
    // Repo-class-aware locality disposition — consumed by the tests and by any
    // caller scripting the ceremony. `repo_class: null` means .claude/VERSION
    // was unreadable, which fails CLOSED to commit_receipt: false.
    repo_class: repoClass,
    commit_receipt: commitReceipt,
    // F48 — the structural half of the fail-loud warning, so a caller scripting
    // the ceremony CANNOT read `ok: true` as "the consumer lane will clear".
    // `ok` means the receipt was written; this means a consumer reading from
    // origin/main can see a LIVE one.
    //
    //   true  — a live receipt for (target, mode) is in origin/main NOW.
    //   false — it is not; anything reading from origin/main (notably
    //           sync-gate2-worktree's scratch tree) is NOT covered.
    //   null  — NOT APPLICABLE: this repo does not commit receipts, so no
    //           consumer reads them from git at all. Deliberately not `false`,
    //           which would read as an unmet obligation that does not exist
    //           here; a caller gating on `=== true` is correct in both cases.
    reachable_from_origin_main: reach ? reach.reachable : null,
    reachable_from_origin_main_reason: reach
      ? reach.reason
      : "not applicable — this repo does not commit receipts; the guard's working-tree grep is the whole contract",
    // The window bounding every statement above, so a caller can reason about
    // an authorization that is reachable now and expired by the time the lane runs.
    authorization_window_hours: windowHrs,
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    // Step 1 is REPO-CLASS-AWARE. The unconditional "commit the receipt" this
    // replaces is what operators followed verbatim at kailash-py / kailash-rs,
    // committing operator-correlatable receipts into a public-fork-lane history.
    const step1 = commitReceipt
      ? [
          `  1. Commit the receipt for durable team audit (this repo is type: ${repoClass}):`,
          `       git add ${rel} && git commit -m "chore(authz): cross-repo ${mode} authorization for ${target}"`,
          ...(reach && !reach.reachable
            ? [
                `       ...on a BRANCH, then land it via PR. HEAD is '${branch || "unknown"}'; a commit that`,
                `       stays local is invisible to every consumer that reads from ${ORIGIN_MAIN_REF}`,
                `       (see the reachability warning above). Pushing straight to a protected main is rejected.`,
              ]
            : []),
        ]
      : [
          `  1. DO NOT COMMIT this receipt — leave it on disk (this repo is type: ${repoClass || "unknown"}, not coc-source).`,
          `       loom's sync gitignores .claude/cross-repo-authz/ here; the guard greps the`,
          `       WORKING TREE (bounding age by the receipt's own timestamp:), so enforcement`,
          `       is unaffected. Committing would put the requester's display_id in this`,
          `       repo's history, which none of loom's three distribution fences covers.`,
        ];
    // F48 — the headline is REACHABILITY-AWARE. `✅` is reserved for the case
    // where nothing is left uncovered. When the receipt is written but a
    // consumer reading from origin/main cannot see it, the checkmark is
    // downgraded to a warning that names EXACTLY what is and is not covered —
    // fail-LOUD, never fail-closed: the receipt IS written and the local action
    // IS authorized, so refusing here would deny an authorization the user has
    // already confirmed in order to report a coverage gap.
    const headline =
      reach && !reach.reachable
        ? [
            `⚠️  Cross-repo authorization receipt written — but NOT reachable from ${ORIGIN_MAIN_REF}: ${rel}`,
            `   target: ${target}   action (${mode}): ${action}`,
            `   marker: ${marker}`,
            "",
            `   COVERED      this working tree. The guard greps the WORKING TREE, so the`,
            `                authorized ${mode} against ${target} may proceed HERE, now.`,
            `   NOT COVERED  anything that reads from ${ORIGIN_MAIN_REF}. Notably`,
            `                .claude/bin/sync-gate2-worktree.mjs cuts a DETACHED scratch`,
            `                tree from ${ORIGIN_MAIN_REF}, where this receipt is absent —`,
            `                so that lane will HALT until the receipt LANDS via PR.`,
            `   WHY          ${reach.reason}.`,
            ...(windowHrs
              ? [
                  `   EXPIRY       authorization is bounded to ${windowHrs}h from the receipt's own`,
                  `                'timestamp:'. Landing the PR after that window makes the receipt`,
                  `                reachable AND dead — re-run the ceremony instead.`,
                ]
              : []),
            "",
          ]
        : [
            `✅ Cross-repo authorization receipt written: ${rel}`,
            `   target: ${target}   action (${mode}): ${action}`,
            `   marker: ${marker}`,
            ...(reach
              ? [`   reachable from ${ORIGIN_MAIN_REF}: yes — ${reach.reason}.`]
              : [
                  `   ${ORIGIN_MAIN_REF} reachability: not applicable — this repo does not commit`,
                  `   receipts, so no consumer reads them from git; the guard's working-tree`,
                  `   grep is the whole contract here.`,
                ]),
            "",
          ];
    process.stdout.write(
      [
        ...headline,
        "Next steps:",
        ...step1,
        `  2. Proceed with ONLY the named ${mode} against ONLY ${target} — no incidental scope creep.`,
        "",
      ].join("\n") + "\n",
    );
  }
  process.exit(0);
}

main();
