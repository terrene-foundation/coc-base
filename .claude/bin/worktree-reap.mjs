#!/usr/bin/env node
// worktree-reap.mjs — classify the git worktree forest by RECOVERABILITY and
// reap only the trees whose removal cannot lose work.
//
// The teardown counterpart to `/worktree` + `rules/worktree-isolation.md`
// Rule 8. Worktree CREATION is governed (Rules 1/5/6/7); before Rule 8 nothing
// carried a teardown obligation, so every parallel wave left its trees behind
// until the operator ran out of disk.
//
// SAFETY MODEL — two orthogonal axes, both must clear before a tree is reaped:
//
//   (1) DURABILITY — do the commits survive `git worktree remove`?
//       `remove` deletes the DIRECTORY, never the branch ref. So commits on a
//       named branch survive; a detached HEAD unreachable from any ref does not.
//       Where a named branch still has commits on no remote, the tree is ZERO-LOSS
//       only if that work has ALREADY LANDED on the trunk. That is asked of the
//       LANDING PROVENANCE first (Landed-From trailers, `decideTreeLanded`), and
//       of `git cherry` patch-ids only for a branch the provenance cannot own
//       (forked before recording began, or no config): a replayed landing gets new
//       commit ids and, after a conflict fix, new patch-ids too.
//   (2) OCCUPANCY — is someone working in this tree right now?
//       A tree can be perfectly durable AND still be a live session's floor.
//       Reaping it loses no commits but yanks the ground out from under it.
//
// Conflating these is the trap: "clean + all commits pushed" is durable but
// says NOTHING about occupancy. Both gates are evaluated independently.
//
// Default is REPORT-ONLY. `--apply` performs removals. `--force` is NOT
// implemented and never will be: a bare `git worktree remove` already REFUSES a
// dirty tree, and that loud refusal is the desired behavior, not an obstacle.
// Checking `git status` and then passing `--force` is the check-then-clobber
// TOCTOU that `worktree-orchestration.md` Rule 11's BLOCKED corpus names —
// the state can change between the check and the removal.
//
// SIZE is reported alongside the verdicts, because the verdict counts do not
// predict the failure this tool exists to prevent: a forest of thirty KEEP trees
// and a forest of thirty KEEP trees at 60 MB each are the same report and
// different amounts of remaining disk. Cost is measured, not assumed — see
// § disk usage below.
//
// SCOPE — `--only <path|name>` narrows which trees may be ACTED ON, so a wave
// that has just collected a lane's report and pushed its branch can reap that
// lane's tree at delivery, without touching a tree it does not own. Selection
// picks CANDIDATES, never OUTCOMES: a selected tree still runs the full verdict
// pipeline and a KEEP verdict still holds it. An `--only` that forced removal
// would be the `--force` this tool refuses, wearing a new name.
//
// Why the feature exists: the 12h default age floor is LONGER than the session
// that creates the trees, so same-day growth is invisible to it by construction.
// Measured at the moment a seven-lane wave had all delivered and pushed:
// `zero-loss: 0  tag-first: 0  keep: 25`, every tree held by
// `active 0.2h ago (< --min-age-hours 12)`; at `--min-age-hours 0`, 19 of the 25
// became ZERO-LOSS on real evidence. The floor is NOT lowered, because it guards
// a case no evidence here can see — ANOTHER LIVE SESSION'S worktree (the
// `is THIS session's own worktree` guard covers only this one). `--only` is the
// narrow instrument: the operator supplies the occupancy knowledge for ONE tree.
//
// Usage:
//   node .claude/bin/worktree-reap.mjs                  # classify, report, change nothing
//   node .claude/bin/worktree-reap.mjs --json           # machine-readable (for /sweep Sweep 6)
//   node .claude/bin/worktree-reap.mjs --apply          # reap ZERO-LOSS + TAG-FIRST trees
//   node .claude/bin/worktree-reap.mjs --apply --zero-loss-only
//   node .claude/bin/worktree-reap.mjs --min-age-hours 0
//   node .claude/bin/worktree-reap.mjs --only lane-a --only lane-b --apply
//   node .claude/bin/worktree-reap.mjs --no-size        # skip the disk-usage pass
//   node .claude/bin/worktree-reap.mjs --deadline-ms 12000   # degrade, never truncate
//   node .claude/bin/worktree-reap.mjs --help
//
// --deadline-ms — A SOFT, SELF-IMPOSED BUDGET, AND WHY IT IS NOT A TIMEOUT.
//
// A caller that bounds this script with an EXTERNAL kill (execFileSync's
// `timeout`, `timeout(1)`) gets nothing back when the budget expires: the child
// is killed mid-write, so stdout holds a truncated JSON document that parses to
// an error, and every tree this run DID classify is discarded. Measured on
// loom's own forest, that turned a 39-of-41 answer into a bare tree count and
// the caller had to report "reapability UNKNOWN" for the whole forest.
//
// A deadline the CHILD owns is a different mechanism. Before each tree, the
// clock is checked; once the budget is spent the remaining trees are recorded
// with the verdict UNKNOWN and the run finishes normally — one complete, valid
// JSON document carrying `partial: true`, the verdicts it actually reached, and
// the named remainder it did not. The process exits under its own control, so
// nothing is truncated.
//
// UNKNOWN IS NOT A VERDICT, IT IS THE ABSENCE OF ONE. It is never reapable, it
// is never counted toward zero_loss/tag_first/keep, and no caller may read it as
// safe to remove (`worktree-isolation.md` Rule 8). It sits in its own
// `counts.unknown` bucket precisely so it cannot be mistaken for KEEP — KEEP
// means "examined and held", UNKNOWN means "not examined".
//
// The external timeout stays, as a BACKSTOP for the case the deadline cannot
// cover: a single git call that itself hangs past the budget (a network-backed
// filesystem, an ambient lock). The deadline bounds the LOOP, not one syscall.
//
// Env: WORKTREE_REAP_DU overrides the `du` binary. Two real uses — pointing at a
// POSIX du on a host whose default is not one, and exercising the unmeasurable
// path in the suite (a degrade path that is never taken is a degrade path that
// was never verified).
//
// Env: WORKTREE_REAP_MAX_CLASSIFY=<N> classifies at most N trees and marks the
// rest UNKNOWN. FAULT INJECTION, on the same reasoning WORKTREE_REAP_DU is here.
// It is not a clock, and that is the entire point. `--deadline-ms` produces
// UNKNOWN trees only in runs where the deadline has ALSO stopped the removal
// loop, so the verdict-level rule "UNKNOWN is never reaped" is masked by the
// clock and cannot be tested through it — measured: mutating that rule away left
// the suite green. This variable decouples the two, letting the suite reach a
// run with UNKNOWN trees and a LIVE removal loop, which is the only place that
// rule is observable. It also produces the mixed partial (some classified, some
// not) that a wall-clock budget cannot produce deterministically.
//
// Exit codes: 0 = ran (findings are data, not failure); 1 = usage/git error,
//             INCLUDING an `--only` selector that matched nothing or matched
//             ambiguously (a selection that silently no-ops and reports success
//             is indistinguishable from a clean forest — it could not
//             discriminate the two, so it fails loud instead);
//             2 = --apply attempted a removal git REFUSED (loud, per above).

import { execFileSync } from "node:child_process";
import { statSync, existsSync, realpathSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
// Namespace import ONLY for statfsSync, which landed in node 18.15. A named
// import of a symbol the runtime lacks is a link-time SyntaxError that takes the
// whole reaper down — including the classification an old runtime could still
// have performed correctly. Reached through the namespace it is a runtime
// `undefined` this file degrades on, which is the honest failure for a number
// that is decoration on top of the verdicts, not part of them.
import * as fsmod from "node:fs";
import { join, basename, resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/entry-point.mjs";

// THE INTEGRATION TRUNK — the ONE shared resolver every landedness surface uses
// (`wip-discipline.md` MUST-4). The same import shape `remote-ref-reap.mjs` uses.
const { resolveTrunkForDeletion } = createRequire(import.meta.url)(
  join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "lib", "trunk-ref.js"),
);
// LANDING PROVENANCE — the recorded answer to "has this branch landed?", read BEFORE
// the patch-id comparison. See `decideTreeLanded` below.
const landedMap = createRequire(import.meta.url)(
  join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "lib", "landed-map.js"),
);
// THE ONE FLOOR VALIDATOR, shared with `.claude/bin/orphan-reap.mjs` and the
// orphan guard. `security.md` § Enforcement-Surface Parity: two restrictiveness
// predicates in one tree WILL disagree, and the second copy is where the weaker
// check lives. This tool's floor minimum is 0 — waiving the age floor is a
// documented mode here (`--min-age-hours 0`) — so it differs from the orphan
// reaper in its BOUND, never in its shape.
const { validateFloorValue } = createRequire(import.meta.url)(
  join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "lib", "orphan-forest.js"),
);

const DEFAULT_MIN_AGE_HOURS = 12;
const DU_BIN = process.env.WORKTREE_REAP_DU || "du";

// Monotonic base for --deadline-ms. Captured at module load rather than at the
// top of main() so the budget the caller granted covers node's own startup —
// the caller's clock starts when it spawns us, not when we reach main().
const T0 = Date.now();

// ── git plumbing ────────────────────────────────────────────────────────────

function git(args, opts = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", opts.quiet ? "ignore" : "pipe"],
    ...opts,
  }).trim();
}

function gitOk(args, opts = {}) {
  try {
    return { ok: true, out: git(args, { quiet: true, ...opts }) };
  } catch (e) {
    return { ok: false, out: "", err: (e.stderr || e.message || "").toString().trim() };
  }
}

/**
 * Parse `git worktree list --porcelain` into records.
 * Records are separated by blank lines; keys are space-delimited, and the
 * `bare` / `detached` / `locked` / `prunable` keys are VALUELESS flags.
 */
function parseWorktrees(porcelain) {
  const out = [];
  let cur = null;
  for (const raw of porcelain.split("\n")) {
    const line = raw.trimEnd();
    if (line === "") {
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    const sp = line.indexOf(" ");
    const key = sp === -1 ? line : line.slice(0, sp);
    const val = sp === -1 ? true : line.slice(sp + 1);
    if (key === "worktree") cur = { path: val, detached: false, locked: false, prunable: false };
    else if (cur) cur[key] = val;
  }
  if (cur) out.push(cur);
  return out;
}

// ── session identity and worktree OWNERSHIP ─────────────────────────────────
//
// OWNERSHIP IS A THIRD AXIS, orthogonal to DURABILITY and OCCUPANCY.
//
// Durability asks "would removal lose commits?". Occupancy asks "is someone in
// there right now?". Neither asks "is this tree MINE to remove?" — and that is
// the question whose absence destroyed two review worktrees mid-round: every
// gate answered correctly, and the tree belonged to somebody else.
//
// The 12h age floor is a CLOCK PROXY for occupancy ("a tree touched less than
// 12h ago is probably live"). It is the wrong instrument for the unattended
// pass, because the sessions that create and spend trees live SHORTER than the
// floor: a session's own delivered tree is ~0h old by construction, so the floor
// holds the one class the pass exists to collect, and releasing the floor by
// hand is what lets it reach everyone else's. OWNERSHIP replaces the proxy with
// the fact: the creating session recorded itself, so "no other session is
// standing in this tree" is known rather than inferred.
//
// WHAT IS READ, EXACTLY — not a guess, and not the environment at reap time:
//
//   1. THE OWNER RECORD, `<per-worktree git dir>/coc-owner.json`. The per-worktree
//      git dir is resolved from the `gitdir:` line of `<path>/.git`, which for a
//      linked worktree is a FILE carrying the absolute admin-dir path — so the
//      read survives any layout, symlinked prefixes included, and it works from
//      ANY cwd because it is anchored on the worktree's own path rather than on
//      the reader's. The file is written at CREATION and is NOT removed by
//      `git worktree unlock`, which is what makes "spent but still mine"
//      readable; `git worktree remove` deletes the whole admin dir, so the record
//      cannot outlive its tree.
//   2. FALLBACK — the LOCK REASON, `coc-session=<id> …`, which git stores in
//      `<per-worktree git dir>/locked` and prints as `locked <reason>` in
//      `git worktree list --porcelain`. Used only when the owner record is
//      absent, and only to ACCEPT a tree as ours. A tree whose lock names
//      another session is still refused.
//
// ABSENT MEANS NOT OURS. There is no third state: a tree with no owner record
// and no session-bearing lock is REPORTED and never reaped by the unattended
// pass. That is the fail-closed direction, and it is deliberate — the trees this
// protects (another live session's, an operator's hand-made one) carry no record
// precisely because nothing in this repo ever made one.
const OWNER_FILE = "coc-owner.json";
const SESSION_REASON_RE = /(?:^|\s)coc-session=([^\s]+)/;

/** The session id this process can honestly claim, or null. Never invented. */
function resolveSessionId(env = process.env) {
  const v = (env && (env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID)) || "";
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** The operator name, for the record's prose field. Not an authority. */
function resolveOwnerName(env = process.env) {
  const v = (env && (env.COC_OPERATOR || env.USER || env.LOGNAME)) || "";
  return typeof v === "string" && v.trim() !== "" ? v.trim() : "(unrecorded)";
}

/**
 * The per-worktree git admin dir for `wtPath`, or null when it has none.
 *
 * `<path>/.git` is a FILE for a linked worktree and a DIRECTORY for the main
 * checkout. The file's `gitdir:` line is the resolver's answer, so nothing here
 * reconstructs a path from a basename — the basename form is only the fallback
 * for an unreadable file (a prunable tree whose directory is already gone).
 */
function adminDirFor(wtPath, gitCommonDir) {
  let dotGit = join(wtPath, ".git");
  try {
    if (!statSync(dotGit).isFile()) return null;
    const m = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+?)\s*$/m);
    if (m && m[1]) return m[1];
  } catch {
    /* unreadable — fall through to the derived path below */
  }
  return gitCommonDir ? join(gitCommonDir, "worktrees", basename(wtPath)) : null;
}

/**
 * The owner record for a tree, or null. NEVER throws: an unreadable or malformed
 * record reads as ABSENT, which is the refusal direction, never as "ours".
 */
function readOwnerRecord(wtPath, gitCommonDir) {
  const dir = adminDirFor(wtPath, gitCommonDir);
  if (!dir) return null;
  try {
    const rec = JSON.parse(readFileSync(join(dir, OWNER_FILE), "utf8"));
    if (!rec || typeof rec !== "object") return null;
    return {
      session: typeof rec.session === "string" && rec.session ? rec.session : null,
      owner: typeof rec.owner === "string" ? rec.owner : null,
      created: typeof rec.created === "string" ? rec.created : null,
      branch: typeof rec.branch === "string" ? rec.branch : null,
      source: OWNER_FILE,
    };
  } catch {
    return null;
  }
}

/** Write the owner record next to git's own per-worktree admin files. */
function writeOwnerRecord(wtPath, gitCommonDir, rec) {
  const dir = adminDirFor(wtPath, gitCommonDir);
  if (!dir || !existsSync(dir)) return { ok: false, err: `no per-worktree git dir for ${wtPath}` };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, OWNER_FILE), JSON.stringify(rec, null, 2) + "\n");
    return { ok: true, path: join(dir, OWNER_FILE) };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

/**
 * The session a LOCK names, from the reason string git reports. `locked true`
 * (no reason) yields null — a lock with no session in it names nobody, and
 * reading "unspecified" as "ours" is exactly the inference this gate exists to
 * refuse. Resolved through `decideTreeOwner` so the precedence lives in ONE
 * place rather than being restated at each call site.
 */
function sessionFromLock(wt) {
  if (!wt || typeof wt.locked !== "string") return null;
  const m = wt.locked.match(SESSION_REASON_RE);
  return m && m[1] ? m[1] : null;
}

/**
 * Decide who owns a tree. PURE except for the record already read.
 *
 * PRECEDENCE IS RECORD-FIRST, and that ordering is the whole point: the record
 * survives `unlock`, the lock reason does not. A tree that was delivered (and so
 * unlocked) must still read as owned, or the delivery path strands it.
 *
 * Returns { session, owner, created, branch, source } — `session` null means
 * UNOWNED, which every caller MUST read as "not mine".
 */
function decideTreeOwner(record, wt) {
  if (record) return record;
  const s = sessionFromLock(wt);
  if (s) return { session: s, owner: null, created: null, branch: null, source: "lock-reason" };
  return { session: null, owner: null, created: null, branch: null, source: null };
}

/** One-line description of an owner decision, for a report. Never blank. */
function describeOwner(owner) {
  if (!owner || !owner.session) {
    return owner && owner.source === null ? "no owner record — created before ownership was recorded" : "no owner record";
  }
  const who = owner.owner ? ` by ${owner.owner}` : "";
  return `created by session ${owner.session}${who}` + (owner.created ? ` at ${owner.created}` : "");
}

// ── selection (--only) ──────────────────────────────────────────────────────

/**
 * Resolve `--only` selectors against the parsed forest.
 *
 * MATCH ORDER, and it is total — there is no third fallback and no fuzzy tier:
 *   1. PATH. The selector is put through `realpathSync` (falling back to
 *      `resolve` when the directory is already gone, e.g. a prunable tree) and
 *      compared for EQUALITY against the worktree path. `git worktree list`
 *      reports resolved absolute paths, so a raw comparison would miss on any
 *      symlinked prefix — /var → /private/var on macOS being the everyday case.
 *   2. BASENAME, only if the path match found nothing. This is the ergonomic
 *      form (`--only lane-a`); it is second because a path is unambiguous by
 *      construction and a basename is not.
 *
 * Both failure modes are ERRORS, never a quiet skip:
 *   NO MATCH   — a typo that silently matched nothing, then reported a clean
 *                run, is a non-discriminating instrument: "your selector was
 *                wrong" and "that tree was already reaped" print identically.
 *   AMBIGUOUS  — two trees sharing a basename must not be resolved by
 *                first-wins. The candidates are listed so the operator can
 *                re-issue with a full path.
 *
 * Errors are collected across ALL selectors and returned together, so an
 * operator naming four lanes with two typos learns both in one run rather than
 * one per re-run. ANY error aborts the whole run (see main) — fail-closed: a
 * partial selection is not a selection the operator asked for.
 */
function resolveSelectors(selectors, worktrees) {
  const chosen = new Set();
  const errors = [];
  for (const sel of selectors) {
    const trimmed = sel.replace(/\/+$/, "");
    let asPath;
    try {
      asPath = realpathSync(trimmed);
    } catch {
      asPath = resolve(trimmed);
    }
    const base = basename(trimmed);

    let hits = worktrees.filter((w) => w.path === asPath);
    if (hits.length === 0) hits = worktrees.filter((w) => basename(w.path) === base);

    if (hits.length === 0) {
      errors.push(`--only '${sel}': no worktree matches (tried path '${asPath}', then basename '${base}')`);
    } else if (hits.length > 1) {
      errors.push(`--only '${sel}': ambiguous — ${hits.length} worktrees share the basename '${base}':\n` + hits.map((w) => `    ${w.path}`).join("\n") + "\n  Re-run with a full path.");
    } else {
      chosen.add(hits[0].path);
    }
  }
  return { chosen, errors };
}

// ── activity (the occupancy proxy) ──────────────────────────────────────────

/**
 * Hours since the tree was last touched. Uses the NEWEST of the worktree root
 * dir mtime and its per-worktree git `index` mtime — the index moves on any
 * git operation, which the root dir mtime alone can miss (a write deep in the
 * tree does not bump the root). Returns null when neither can be stat'ed.
 *
 * CLAMPED AT ZERO, and that clamp is load-bearing, not cosmetic. The two clocks
 * being subtracted have DIFFERENT resolutions: `statSync().mtimeMs` is a float
 * carrying sub-millisecond precision, while `Date.now()` is an integer
 * millisecond (floored). A tree touched at 1000.7ms read back at 1000ms yields
 * age = -0.7ms — NEGATIVE — and every negative age is unconditionally `<` any
 * floor, so `--min-age-hours 0` (age floor explicitly waived) silently held
 * trees ~50% of the time depending on where the sub-millisecond fraction landed.
 * A clock skew that puts an mtime in the FUTURE lands here too; the clamp reads
 * it as "touched now" (age 0), which every floor > 0 still holds, so the
 * fail-safe direction is preserved for every case except the waived floor.
 */
function hoursSinceActivity(wtPath, gitCommonDir) {
  const stamps = [];
  for (const p of [wtPath, join(gitCommonDir, "worktrees", basename(wtPath), "index")]) {
    try {
      stamps.push(statSync(p).mtimeMs);
    } catch {
      /* absent — not an error, just one fewer signal */
    }
  }
  if (stamps.length === 0) return null;
  return Math.max(0, (Date.now() - Math.max(...stamps)) / 3_600_000);
}

// ── disk usage ──────────────────────────────────────────────────────────────
//
// COST, measured on this operator's forest (30 trees, ~5,800 files each, APFS,
// node v25.9.0) rather than estimated. Baseline reaper: 4.48 / 3.14 / 3.22 s.
// One `du -s -k` per tree: 3.39 s cold, then 1.96 / 1.78 / 1.85 s warm. A single
// `du` invocation over all thirty paths at once measured 1.77 / 1.73 s — the
// fork cost is noise next to the filesystem walk, so the per-tree form is used
// for the property it buys: a per-tree exit code, which is what makes ONE
// unreadable tree report as unknown instead of poisoning the whole total.
//
// So sizing roughly doubles a ~3 s report to ~5 s. Default-ON at that price,
// with `--no-size` to opt out — the inverse default would satisfy the letter of
// "the reaper can report size" while leaving every actual sweep sizeless, which
// is the silent-no-op default `rules/security.md` § Secure-Default names.
//
// PORTABILITY: `du -s -k` is POSIX (XCU) — both BSD/macOS and GNU/Linux du
// implement `-s` and `-k`, and both print `<kbytes>\t<path>`. No GNU-only flag
// (`--apparent-size`, `-b`, `-c`) is used. On a host with no du at all the
// execFileSync throws and every tree reports unknown; the verdicts are
// unaffected. NOT measured on Linux in this session — the portability claim
// rests on the POSIX specification of the two flags, not on a run.

/**
 * Disk usage of one worktree in KiB.
 *
 * Returns { kb, note } where `kb === null` means COULD NOT MEASURE — never 0.
 * The distinction is the whole point: a 0 standing in for a failed measurement
 * reads identically to a genuinely empty tree, so it could not discriminate the
 * hypothesis it would be cited for (`rules/instrument-discipline.md` MUST-1).
 * A non-zero exit WITH a parseable total is a LOWER BOUND (du walked what it
 * could read), reported as `partial` rather than laundered into an exact figure.
 */
function measureSizeKb(path) {
  if (!existsSync(path)) return { kb: 0, note: "directory absent" };

  let out = "";
  let failure = null;
  try {
    out = execFileSync(DU_BIN, ["-s", "-k", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    out = (e.stdout || "").toString();
    failure = ((e.stderr || "").toString().trim().split("\n").filter(Boolean).pop() || e.message || "du failed").trim();
  }

  let kb = null;
  for (const line of out.split("\n").map((l) => l.trim()).filter(Boolean).reverse()) {
    const m = /^(\d+)\s/.exec(line);
    if (m) {
      kb = Number(m[1]);
      break;
    }
  }

  if (kb === null) return { kb: null, note: `unmeasured — ${failure || "du printed no total"}` };
  if (failure) return { kb, note: `partial (lower bound) — ${failure}` };
  return { kb, note: null };
}

/** Free space in KiB on the volume holding `path`, or null when unreadable. */
function volumeFreeKb(path) {
  try {
    if (typeof fsmod.statfsSync !== "function") return null;
    const s = fsmod.statfsSync(path);
    return Math.floor((s.bavail * s.bsize) / 1024);
  } catch {
    return null;
  }
}

/**
 * Roll per-tree sizes into the forest-level numbers.
 *
 * The median is taken over LINKED worktrees ONLY. A new worktree is a fresh
 * linked checkout, not a copy of the main checkout — measured on this forest,
 * main is 339 MiB (it accumulates build output and node_modules) against ~58 MiB
 * per linked tree, so folding it in inflates the median and UNDERSTATES how many
 * more trees fit. The median rather than the mean for the same reason: one fat
 * tree should not move the estimate for the next ordinary one.
 */
function sizeRollup(records, mainTop) {
  const measured = records.filter((r) => typeof r.sizeKb === "number");
  const partial = measured.filter((r) => r.sizeNote && r.sizeNote.startsWith("partial")).length;
  const totalKb = measured.length > 0 ? measured.reduce((a, r) => a + r.sizeKb, 0) : null;

  const linked = measured.filter((r) => r.path !== mainTop).map((r) => r.sizeKb).sort((a, b) => a - b);
  const medianKb = linked.length === 0 ? null : linked.length % 2 ? linked[(linked.length - 1) / 2] : Math.round((linked[linked.length / 2 - 1] + linked[linked.length / 2]) / 2);

  const freeKb = volumeFreeKb(mainTop);
  // Trees of median size the volume still has room for. This is a DERIVED
  // measurement, not a tuned threshold: no constant is chosen anywhere in it.
  const headroom = medianKb !== null && medianKb > 0 && freeKb !== null ? Math.floor(freeKb / medianKb) : null;

  return {
    total_kb: totalKb,
    total_is_lower_bound: totalKb !== null && (partial > 0 || measured.length < records.length),
    measured: measured.length,
    unknown: records.length - measured.length,
    partial,
    median_tree_kb: medianKb,
    volume_free_kb: freeKb,
    headroom_trees: headroom,
  };
}

/** KiB → the largest binary unit that keeps the number readable; null → "unknown". */
function fmtKb(kb) {
  if (kb === null || kb === undefined) return "unknown";
  if (kb < 1024) return `${kb} KiB`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MiB`;
  return `${(kb / 1024 / 1024).toFixed(2)} GiB`;
}

// ── classification ──────────────────────────────────────────────────────────

// THE SHARED REMOVAL-SAFETY VOCABULARY. These words are not local to this file:
// `.claude/hooks/lib/wip-lanes.js::classifyTree` and
// `.claude/bin/worktree-triage.mjs::withSharedVerdict` emit the SAME `verdict`
// field with the SAME spelling, so three reports over one forest collate. Only
// this tool mints TAG-FIRST, because only a tool that REMOVES a tree can act on
// "tag it first"; the other two fail closed to KEEP there. Changing a spelling
// here without changing it in both siblings re-opens the two-vocabularies defect
// consolidated 2026-08-22 (`guides/rule-extracts/wip-discipline.md`
// § Consolidation record).
const REAP = "ZERO-LOSS";
const TAG_FIRST = "TAG-FIRST";
const KEEP = "KEEP";
// NOT a verdict — the absence of one. See the --deadline-ms header note. Kept
// distinct from KEEP so no reader can collapse "not examined" into "examined
// and held": the two are opposite claims about how much is known.
const UNKNOWN = "UNKNOWN";

/**
 * The record for a tree the deadline stopped us reaching. Carries only what
 * `git worktree list --porcelain` already told us — path, branch, sha — and
 * NOTHING derived, because nothing was derived. Every occupancy/durability
 * field is null rather than 0: a 0 dirty-count would read as "verified clean",
 * which is exactly the claim this record exists to withhold.
 */
function unclassified(wt, ctx, reason) {
  return {
    path: wt.path,
    branch: wt.branch ? wt.branch.replace(/^refs\/heads\//, "") : null,
    sha: wt.HEAD || null,
    verdict: UNKNOWN,
    reasons: [reason],
    dirty: null,
    unpushed: null,
    ageHours: null,
    patchesUpstream: null,
    // `selected` answers "is this tree IN SCOPE", which the selector set already
    // decided before any classification ran — so it is knowable here and is
    // reported. Setting it false would make `counts.selected` shrink as the
    // deadline bites, rendering a full-forest run's sentinel as `scope=all
    // selected=14` — indistinguishable from a scoped `--only` pass, which is
    // exactly the whole-forest-vs-subset confusion the sentinel exists to
    // prevent. Being in scope grants nothing on its own: eligibility ALSO
    // requires a REAP/TAG-FIRST verdict, and UNKNOWN is neither.
    selected: ctx.selected === null || ctx.selected.has(wt.path),
    ageFloorWaived: false,
    ageFloorWaivedBy: null,
    // NOT READ, and null is the honest value. `unclassified` is the record for a
    // tree the deadline never examined; reading its owner file here would make a
    // record that claims to carry "nothing derived" carry one derived field, and
    // `heldNotOwned: false` would then assert "not refused for ownership" about a
    // tree no ownership question was ever asked of.
    owner: null,
    heldNotOwned: false,
  };
}

/**
 * "Are this branch's unpushed commits already landed on the trunk?" — the landed-map
 * policy applied (`landedVerdict`, hooks/lib/landed-map.js, symbol `landedVerdict`). Pure.
 *
 * `v` is the verdict (null when no map was consulted); `legacy` is a thunk running the
 * pre-provenance `git cherry` patch-id comparison and returning `{ landed, by }`.
 *
 *   decided   -> the RECORD answers and `legacy` is NEVER called: a conflict-resolved
 *                landing (patch-ids differ) is landed; a post-cutover branch whose patch
 *                was cherry-picked without a trailer is NOT.
 *   fallback  -> (predates / ancestry / no-config) the patch-id comparison runs.
 *   neither   -> (unknown, or no-map: the config exists but its map could not be built)
 *                `{ landed: null, by: "unmeasured" }`: never landed, never resolved by
 *                content — null holds the tree exactly as an unreadable cherry did.
 */
export function decideTreeLanded(v, legacy) {
  if (v && v.decided) return { landed: v.landed === true, by: "provenance" };
  if (!v || v.fallback) return legacy();
  return { landed: null, by: "unmeasured" };
}

/** The instrument behind a landedness answer, in words (recorded vs reconstructed). */
function landedLabel(d, v, trunkRef) {
  const tip = v && v.mapTip ? v.mapTip.slice(0, 12) : "?";
  if (d.by === "provenance") {
    return d.landed
      ? `provenance: Landed-From trailers on ${trunkRef}@${tip}`
      : `provenance: ${v.status}, ${(v.outstanding || []).length} commit(s) with no landing trailer on ${trunkRef}@${tip}`;
  }
  if (d.by === "unmeasured") return `landedness UNMEASURED — provenance could not answer (${(v && (v.why || v.status)) || "unknown"}); not resolved by content`;
  const why = !v ? "no provenance consulted"
    : v.status === "predates" ? "branch predates recording"
      : v.status === "ancestry" ? "no commit of its own beyond the trunk"
        : v.status === "no-config" ? "landing provenance not recorded in this repository"
          : `provenance map UNAVAILABLE: ${v.why || v.status}`;
  return `content: git cherry patch-ids (${why})`;
}

/**
 * Classify one worktree. Returns { verdict, reasons[], ... }.
 *
 * Every KEEP reason is recorded, not just the first — an operator reading the
 * report needs to know ALL of what is holding a tree, or they fix one signal,
 * re-run, and are surprised by the next.
 */
function classify(wt, ctx) {
  const reasons = [];
  const path = wt.path;
  const branch = wt.branch ? wt.branch.replace(/^refs\/heads\//, "") : null;
  const sha = wt.HEAD || null;

  // SELECTION IS A CANDIDATE FILTER. It reaches exactly ONE thing inside the
  // classifier — the age floor, below — and nothing else. Every other signal
  // (main checkout, own worktree, bare, locked, dirty, unpushed, unreadable
  // status) is evaluated identically whether or not the tree was named.
  const selected = ctx.selected === null || ctx.selected.has(path);

  // ── ownership, read BEFORE any verdict is formed ──
  // Not a gate on the report — every run reports ownership — but it is read here
  // because it decides the age-floor waiver below as well as the guard under it.
  const owner = decideTreeOwner(readOwnerRecord(path, ctx.gitCommonDir), wt);
  const ownedByReaper = ctx.reapOwnedBy !== null && owner.session !== null && owner.session === ctx.reapOwnedBy;
  // A tree the unattended pass may NOT touch. Set below, and set NARROWLY — see
  // the note at the point of assignment.
  let heldNotOwned = false;

  // AGE-FLOOR WAIVER, and the reasoning, because this is the one judgment call
  // in the feature. The floor is a CLOCK PROXY for a question the tool cannot
  // answer directly: is another live session working here? Naming an exact path
  // is the operator ASSERTING that knowledge for that one tree — the same
  // substitution `--min-age-hours 0` already permits, but scoped to one tree
  // instead of the whole forest, which is strictly the safer of the two.
  //
  // OWNERSHIP IS THE SAME SUBSTITUTION, MADE BY EVIDENCE RATHER THAN BY HAND.
  // When `--reap-owned-by <id>` names this tree's recorded creator, the session
  // that created it is the one asking to reap it, so the clock's question ("is
  // another live session here?") is answered by the record — and answered
  // better than the clock could, since a session's own delivered tree is ~0h old
  // by construction and the floor would hold every one of them forever.
  //
  // It is bounded three ways, so a careless `--only` cannot become a `--force`:
  //   (1) ONLY the age floor is waived. Dirty, unpushed, locked, bare, main, and
  //       own-session all still hold the tree — so the residual exposure is a
  //       tree that is clean AND fully pushed, where removal loses no commits by
  //       construction (that is what ZERO-LOSS means).
  //   (2) ONLY the DEFAULT floor. An explicitly passed `--min-age-hours` is an
  //       INSTRUCTION, not a default, and outranks the waiver — otherwise
  //       `--only X --min-age-hours 24` would silently ignore the number typed.
  //   (3) ONLY the selected trees. An unselected tree in the same run keeps the
  //       floor it would have had.
  // The waiver is also REPORTED per tree (`ageFloorWaived`, and a line in the
  // human report) rather than being an invisible semantic of the flag.
  const waivedByOnly = selected && ctx.selected !== null && !ctx.ageExplicit;
  const waivedByOwnership = ownedByReaper && !ctx.ageExplicit;
  const ageFloorWaived = waivedByOnly || waivedByOwnership;
  const ageFloorWaivedBy = waivedByOnly ? "only" : waivedByOwnership ? "ownership" : null;
  const effectiveFloor = ageFloorWaived ? 0 : ctx.minAgeHours;
  const stamp = (rec) => ({ ...rec, selected, ageFloorWaived, ageFloorWaivedBy, owner, heldNotOwned });

  // ── hard guards: never reap, regardless of durability ──
  if (path === ctx.mainTop) reasons.push("is the MAIN checkout");
  if (ctx.selfTop && path === ctx.selfTop) reasons.push("is THIS session's own worktree");
  if (wt.bare) reasons.push("bare repository");
  if (wt.locked) reasons.push(`locked${typeof wt.locked === "string" ? ` (${wt.locked})` : ""}`);

  // ── OWNERSHIP — THE GUARD THE TWO DESTROYED REVIEW TREES DIED FOR ──
  //
  // NOT-MINE IS A REFUSAL, and it is a HARD one: the verdict it produces is KEEP
  // and nothing downstream can lift it. It is applied HERE, at the eligibility
  // points rather than with main/self/bare/locked, for a reason about the REPORT
  // rather than the strength. `reasons` is supposed to be the full list of what
  // holds a tree; appending ownership to every unowned tree would bury the
  // actionable fact (a dirty tree's dirt) and make the unattended pass report on
  // EVERY forest — a real one is almost entirely unowned today, so the pass would
  // nag at every session end with a finding that changes nothing. That is the
  // cry-wolf failure the `evaluateForest` floor exists to prevent, arriving
  // through a different door.
  //
  // So the flag is NARROW: set only for a tree nothing else holds, i.e. one this
  // pass would otherwise have removed. `held_not_owned` therefore means "refused
  // DESPITE being eligible" — the only version of that claim an operator must act
  // on, and the only one whose absence would be undetectable
  // (`conservation-gate.md` MUST-4: an empty outcome in the grammar of a
  // completed one prints the same as success).
  //
  // IT MUST BE CALLED AT EVERY ELIGIBILITY POINT, and the prunable return below
  // is why: a tree whose directory is already gone classifies REAP before any
  // occupancy signal is consulted, so a gate installed only at the final return
  // would leave the one genuinely-reapable-against-a-real-forest shape ungated.
  const ownershipRefused = ctx.reapOwnedBy !== null && !ownedByReaper;
  const refuseIfNotOurs = () => {
    if (!ownershipRefused || reasons.length !== 0) return false; // held for a reason worth reading
    reasons.push(
      `NOT created by this session — this pass may remove only the trees it created (${describeOwner(owner)})`,
    );
    return true;
  };
  refuseIfNotOurs();

  const missing = !existsSync(path);
  if (missing && reasons.length === 0) {
    // Directory already gone — `git worktree prune` is the correct tool, not remove.
    return stamp({ path, branch, sha, verdict: REAP, prunable: true, reasons: ["directory absent — prunable"], dirty: 0, unpushed: null, ageHours: null });
  }

  // ── occupancy signals ──
  // `--no-optional-locks` — NOT a speed flag, and deliberately not defended as
  // one. Measured across 42 trees on a quiet machine: 3.07 s without it, 2.98 s
  // with — a 3% delta that is inside this measurement's own run-to-run spread,
  // so no speed claim is made. What it buys is a SIDE EFFECT this tool should
  // never have had: a plain `git status` refreshes the index and WRITES IT BACK,
  // taking `index.lock` in each worktree it inspects. A report-only auditor that
  // sweeps the whole forest was therefore writing into the index of every tree —
  // including trees other live lanes are working in right now, which is when
  // this hook fires. `--no-optional-locks` makes the read a read. The porcelain
  // OUTPUT is unchanged (git documents the flag as skipping optional index
  // writes, not as changing what status reports), so no verdict moves.
  // The untracked/submodule flags are PINNED, and the pin is load-bearing rather than
  // stylistic. MEASURED four-pole on one scratch repo holding a single untracked file:
  // with `status.showUntrackedFiles=no` set repo-locally, the unpinned `--porcelain`
  // form returns ZERO BYTES at exit 0, while `--untracked-files` pinned returns the
  // `?? ` row. The file was on disk throughout. Unpinned, `dirty` is 0, no reason
  // fires, the KEEP gate below falls through, and a tree whose ONLY copy of its work is
  // untracked is classified ZERO-LOSS — which under `--apply` is a `worktree remove` of
  // content that has no reflog to recover it. A repo-local config must not be able to
  // blank the very entries that make a tree worth keeping.
  // `=all` rather than `normal` because `normal` collapses a whole new directory to one
  // `?? dir/` row: the verdict would still be KEEP, but the COUNT the operator reads
  // would under-state the rescue by every file but one.
  // Both siblings already pin this — `lane-status.mjs` and `worktree-triage.mjs`, each
  // with a comment naming this same hazard. This tool is the one that DELETES, and it
  // was the one left on the blindable form.
  const dirtyRes = missing
    ? { ok: true, out: "" }
    : gitOk([
        "--no-optional-locks",
        "-C",
        path,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ]);
  const dirty = dirtyRes.ok && dirtyRes.out ? dirtyRes.out.split("\n").filter(Boolean).length : 0;
  if (!dirtyRes.ok) reasons.push(`status unreadable — failing closed (${dirtyRes.err.split("\n")[0]})`);
  if (dirty > 0) reasons.push(`dirty tree (${dirty} path${dirty === 1 ? "" : "s"}; unstaged + untracked have NO reflog)`);

  const ageHours = missing ? null : hoursSinceActivity(path, ctx.gitCommonDir);
  if (ageHours !== null && ageHours < effectiveFloor) {
    reasons.push(`active ${ageHours.toFixed(1)}h ago (< --min-age-hours ${effectiveFloor})`);
  }

  // ── durability ──
  // `rev-list <ref> --not --remotes` = commits on this ref absent from EVERY
  // remote-tracking ref. This is the durability question. It is NOT the same as
  // `git cherry <trunk> <branch>`, which answers "is this PATCH already
  // upstream (possibly under another SHA / another branch name)" by patch-id
  // against ONE upstream. Measured divergence on a real branch: cherry printed
  // 5 `+` lines while --not --remotes counted 4, because one commit was
  // reachable from a different remote ref. Use both; do not substitute either.
  let unpushed = null;
  if (sha) {
    const ref = branch || sha;
    const r = gitOk(["rev-list", "--count", ref, "--not", "--remotes"]);
    unpushed = r.ok ? Number(r.out) : null;
    if (!r.ok) reasons.push("unpushed-commit count unreadable — failing closed");
  }

  // Has the in-flight work already LANDED on the trunk? PROVENANCE FIRST
  // (`decideTreeLanded` above): the patch-id comparison below runs ONLY when the
  // recorded answer says `fallback`. `patchesUpstream` keeps its name and its three
  // values (true / false / null = could not tell) for every reader of the JSON.
  let patchesUpstream = null;
  let landedBy = null;
  let landedProvenance = null;
  if (branch && unpushed > 0 && ctx.defaultRemoteRef) {
    const v = ctx.landedVerdictFor(branch, sha);
    const d = decideTreeLanded(v, () => {
      // Does the patch already exist upstream under another name? `-` = present
      // upstream (equivalent patch found), `+` = absent.
      const r = gitOk(["cherry", ctx.defaultRemoteRef, branch]);
      if (!r.ok) return { landed: null, by: "content" };
      const lines = r.out ? r.out.split("\n").filter(Boolean) : [];
      return { landed: lines.length > 0 && lines.every((l) => l.startsWith("-")), by: "content" };
    });
    patchesUpstream = d.landed;
    landedBy = landedLabel(d, v, ctx.defaultRemoteRef);
    landedProvenance = v ? { status: v.status, decided: Boolean(v.decided), landedCommits: v.landedCommits || [], outstanding: v.outstanding || [], why: v.why || null } : null;
  }

  // A detached HEAD carrying commits on no ref is NOT a KEEP — it is the
  // TAG-FIRST case, and routing it to KEEP is what made that verdict dead code
  // (caught by the per-verdict fixture, not by any run against a real forest,
  // where the verdict simply never occurs). Only a NAMED branch's unpushed
  // commits are an occupancy signal: the branch ref already makes them durable,
  // so what holds the tree is that the work is in flight, not that it is at risk.
  //
  // REACHABILITY IS ITS OWN QUESTION, ASKED WITH ITS OWN INSTRUMENT.
  //
  // `unpushed` above comes from `rev-list --not --remotes`, which answers "is
  // this on a REMOTE". Reading it as "is this reachable from ANY ref" is the
  // `instrument-discipline.md` MUST-4 failure — a sound instrument for question
  // A re-read for question B — and it shipped a WRONG REASON STRING: measured
  // 2026-08-20 on this repo's forest, two TAG-FIRST trees were reachable from
  // real branches (2 and 7 refs respectively) while the report said
  // "unreachable from any ref". The verdict erred SAFE (a needless tag), but a
  // reason string that is false is what makes an operator stop trusting the
  // tool, and TAG-FIRST is the verdict the unattended SessionEnd pass
  // deliberately declines — so the false reason is what an operator has to
  // adjudicate by hand.
  //
  // `for-each-ref --contains <sha>` asks the reachability question DIRECTLY,
  // across EVERY ref namespace (heads, remotes, tags, and the recovery refs
  // this module's sibling writes). It DISCRIMINATES: a genuinely orphaned SHA
  // returns nothing, a branch-tip SHA returns the branch. A failed query
  // returns null and is NOT read as "unreachable" — an errored command is zero
  // evidence (`evidence-first-claims.md` MUST-3), and reading it as unreachable
  // would tag every tree in a repo whose git refused the query.
  let containingRefs = null;
  if (sha) {
    const r = gitOk(["for-each-ref", "--contains", sha, "--format=%(refname)", "--count", "8"]);
    if (r.ok) containingRefs = r.out ? r.out.split("\n").filter(Boolean) : [];
    else reasons.push("ref-reachability query unreadable — failing closed");
  }

  let detachedUnreachable = false;
  if (unpushed !== null && unpushed > 0 && !patchesUpstream) {
    if (branch) reasons.push(`${unpushed} commit(s) on '${branch}' absent from every remote (work in flight)${landedBy ? ` — not landed per ${landedBy}` : ""}`);
    else if (containingRefs === null) reasons.push("detached HEAD whose reachability could not be determined — failing closed");
    else if (containingRefs.length === 0) detachedUnreachable = true;
    // else: detached but a real ref holds the commit — durable, and the
    // ZERO-LOSS reason below names WHICH ref, so the claim is checkable.
  }

  // The SECOND eligibility point — see `refuseIfNotOurs` above for why the call
  // appears at more than one place.
  refuseIfNotOurs();

  if (reasons.length > 0) {
    // SET HERE, NEVER AT THE CALL SITE, and `reasons.length === 1` is the whole
    // test. The early call runs BEFORE the occupancy and durability signals are
    // computed — it has to, or the prunable return below would bypass the gate
    // entirely — so at that moment an unowned tree's `reasons` is empty whether
    // it is clean or filthy. Flagging it there would mark every unowned tree in
    // the forest as "refused despite being eligible", which is both false and the
    // cry-wolf regression this flag was narrowed to avoid. By this line the other
    // signals have all had their say, so exactly one reason means exactly one
    // thing held the tree, and that thing was ownership.
    heldNotOwned = ownershipRefused && reasons.length === 1;
    return stamp({ path, branch, sha, verdict: KEEP, reasons, dirty, unpushed, ageHours, patchesUpstream, landedBy, landedProvenance, containingRefs });
  }

  // Nothing holds it. Does a ref preserve the commits after removal?
  if (!detachedUnreachable) {
    // The reason NAMES the ref that makes the removal lossless, so the claim is
    // checkable by the reader rather than asserted. The old detached wording
    // ("HEAD reachable from a remote ref") named a remote even when what held
    // the commit was a local branch — the same conflation the reachability
    // query above exists to end.
    const held = containingRefs && containingRefs.length > 0 ? containingRefs.slice(0, 3).join(", ") : null;
    const why = branch
      ? `clean; branch '${branch}' persists after removal${unpushed === 0 ? " and is fully pushed" : ` (${patchesUpstream && landedBy && landedBy.startsWith("provenance:") ? "already landed on" : "patches already on"} ${ctx.defaultRemoteRef} — ${landedBy})`}`
      : held
        ? `clean; detached HEAD is reachable from ${containingRefs.length} ref(s) — ${held} — which persist after removal`
        : "clean; HEAD carries no commit absent from every remote";
    return stamp({ path, branch, sha, verdict: REAP, reasons: [why], dirty, unpushed, ageHours, patchesUpstream, landedBy, landedProvenance, containingRefs });
  }

  // Clean, idle, detached, and MEASURED unreachable — `for-each-ref --contains`
  // returned the empty set, so removal would orphan the SHA.
  return stamp({
    path,
    branch,
    sha,
    verdict: TAG_FIRST,
    reasons: ["clean but DETACHED, and `git for-each-ref --contains` finds NO ref holding this commit — tag before removing"],
    dirty,
    unpushed,
    ageHours,
    patchesUpstream,
    landedBy,
    landedProvenance,
    containingRefs,
  });
}

// ── reap ────────────────────────────────────────────────────────────────────

function reap(rec, ctx) {
  const actions = [];
  if (rec.prunable) {
    // SCOPED, AND IT USED TO NOT BE. This branch ran `git worktree prune`, which
    // takes NO path argument: it clears the admin record of EVERY prunable
    // worktree in the repository, not just the one being classified. Measured on
    // a scratch (git 2.54.0): two prunable trees, `prune` de-registered both. So
    // classifying one prunable tree and pruning removed a SIBLING this pass had
    // explicitly refused — the forest-wide destructive act wearing the costume of
    // a per-tree verdict, and the exact shape the ownership gate exists to stop.
    // (`git worktree prune` does honour a LOCK, which is why the collateral went
    // unnoticed: an owned tree is locked, and a locked tree survives. An unowned
    // one is precisely the tree with no lock to save it.)
    //
    // `git worktree remove <path>` is measured to work on a directory-absent tree
    // and takes the path, so it retires THIS record and nothing else.
    if (!ctx.apply) return [`would: git worktree remove ${rec.path}`];
    const r = gitOk(["worktree", "remove", rec.path]);
    return [r.ok ? "pruned" : `PRUNE REFUSED: ${r.err.split("\n")[0]}`];
  }
  if (rec.verdict === TAG_FIRST) {
    const tag = `reaped/${basename(rec.path)}-${(rec.sha || "").slice(0, 8)}`;
    if (!ctx.apply) {
      actions.push(`would: git tag ${tag} ${(rec.sha || "").slice(0, 8)}`);
    } else {
      const t = gitOk(["tag", tag, rec.sha]);
      if (!t.ok && !/already exists/i.test(t.err)) {
        return [`TAG FAILED, NOT REMOVING: ${t.err.split("\n")[0]}`];
      }
      actions.push(`tagged ${tag}`);
    }
  }
  // NOTE: no --force, ever. A refusal here is the safety net working.
  if (!ctx.apply) {
    actions.push(`would: git worktree remove ${rec.path}`);
    return actions;
  }
  const r = gitOk(["worktree", "remove", rec.path]);
  actions.push(r.ok ? "removed" : `REMOVE REFUSED (not escalating to --force): ${r.err.split("\n")[0]}`);
  if (!r.ok) ctx.refusals.push({ path: rec.path, err: r.err.split("\n")[0] });
  return actions;
}

// ── creation / delivery ─────────────────────────────────────────────────────
//
// THE CREATION HALF OF THE LIFECYCLE. Rule 8 already said "creation owns
// teardown"; what it never said is that creation must LEAVE A RECORD, so the
// unattended teardown could tell one session's tree from another's. It could not,
// and it did not ask — three gates (durability, occupancy, age) all cleared on a
// tree that belonged to somebody else, and the removal was correct on every axis
// except the one nobody was measuring.
//
// The reason string and the owner record are written in ONE place, here, for the
// reason `hooks/lib/worktree-forest.js` gives for delegating to this script at
// all: a second writer would be a second lineage that drifts. A drift between
// what creation records and what the reap gate reads is INVISIBLE — the gate
// would simply stop matching, and "no tree is mine" reads exactly like "I made
// no trees".

/** Absolute, symlink-resolved path for something that need not exist yet. */
function resolveForCreate(rawPath) {
  const abs = resolve(rawPath);
  const parent = dirname(abs);
  let parentReal;
  try {
    parentReal = realpathSync(parent);
  } catch {
    return { ok: false, err: `parent directory does not exist: ${parent}` };
  }
  return { ok: true, path: join(parentReal, basename(abs)) };
}

/** The lock reason. Registry-less: git stores it in the per-worktree admin dir. */
function ownerReason(session, ownerName, created, extra = "") {
  // NO `coc-session=` TOKEN WHEN THERE IS NO SESSION. Writing
  // `coc-session=UNRECORDED` would mint a session id that every future reader
  // compares against and that no real session can ever present — a name that
  // matches nothing is quieter than an error, which is the failure mode this
  // whole change is about. `coc-unowned` is a DIFFERENT token, so the parser
  // cannot mistake it for one.
  const core = session
    ? `coc-session=${session} owner=${ownerName} created=${created}`
    : `coc-unowned owner=${ownerName} created=${created} reason=no-session-id-in-env`;
  return (core + (extra ? ` ${extra}` : "")).trim();
}

/**
 * The canonical SIBLING placement for a lane name, derived from the SHARED .git
 * and never from the caller's idea of where the repo is.
 *
 * `--show-toplevel` is the wrong instrument here and the reason is measured:
 * from inside a LINKED worktree it returns THAT worktree's top, so `dirname()`
 * of it would place the new sibling beside the worktree rather than beside the
 * repo — a doubly-nested tree, which is the Rule 7 trap. The SHARED git dir's
 * parent is the MAIN checkout under every layout, symlinked prefixes included.
 *
 * This is the ONE derivation. `--create` with a bare NAME resolves here; an
 * explicit path is taken as given and still refused if it lands inside the repo.
 * Writing it once is the point: the command and its skill each carried a
 * hand-rolled copy of these three lines, which is a drift waiting for the first
 * person to fix one of them.
 */
function deriveSiblingPath(name, cwd) {
  const mainTop = dirname(git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd }));
  const url = gitOk(["remote", "get-url", "origin"], { cwd });
  const slug = url.ok && url.out ? basename(url.out).replace(/\.git$/, "") : basename(mainTop);
  const wtParent = join(dirname(mainTop), `.${slug}-wt`);
  return join(wtParent, name);
}

function cmdCreate(rawPath, opts) {
  const emit = (payload, lines) => {
    if (opts.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    else process.stdout.write(lines.join("\n") + "\n");
  };
  // PLACEMENT ASSERT. `rules/worktree-isolation.md` Rule 7 — a nested tree
  // double-loads the path-scoped corpus and lands inside the repo's own
  // `.claude/**` glob range.
  //
  // RUN TWICE, LEXICALLY AND ON THE RESOLVED PATH, and the order is not
  // ceremony. A parent that does not exist yet has no realpath, so a
  // resolve-first form answers `.claude/worktrees/w1` with "parent directory
  // does not exist" — TRUE, and the wrong message: it reads as a typo rather
  // than as the placement trap this refusal exists to name. The lexical pass
  // fires the right refusal for a path that does not exist; the resolved pass
  // then catches a symlinked parent that points INSIDE the repo, which the
  // lexical form cannot see. Both are needed, and neither substitutes for the
  // other.
  // A BARE NAME IS PLACED FOR YOU; a path is taken as given. Deriving the
  // canonical sibling location from the shared .git is the default because the
  // placement is a quota requirement (Rule 7), not a preference — and because a
  // caller that has to compute it is a caller that can compute it wrong.
  const isBareName = !rawPath.includes("/") && !rawPath.includes("\\");
  const requested = isBareName ? deriveSiblingPath(rawPath, opts.mainTop) : rawPath;
  if (isBareName) {
    try {
      mkdirSync(dirname(resolve(requested)), { recursive: true });
    } catch (e) {
      process.stderr.write(`worktree-reap: cannot create the sibling parent for '${rawPath}': ${e.message}\n`);
      return 1;
    }
  }

  const refuseInside = (p) =>
    p === opts.mainTop || p.startsWith(opts.mainTop + "/")
      ? `REFUSED — ${p} is inside the main checkout (${opts.mainTop}). A worktree MUST be a SIBLING outside the repo (worktree-isolation.md Rule 7).`
      : p.includes("/.claude/worktrees/")
        ? `REFUSED — ${p} is nested under the repo's own .claude/ (worktree-isolation.md Rules 1 + 7).`
        : null;
  const lexicalRefusal = refuseInside(resolve(requested));
  if (lexicalRefusal) {
    process.stderr.write(`worktree-reap: ${lexicalRefusal}\n`);
    return 1;
  }
  const resolved = resolveForCreate(requested);
  if (!resolved.ok) {
    process.stderr.write(`worktree-reap: ${resolved.err}\n`);
    return 1;
  }
  const absPath = resolved.path;
  const resolvedRefusal = refuseInside(absPath);
  if (resolvedRefusal) {
    process.stderr.write(`worktree-reap: ${resolvedRefusal}\n`);
    return 1;
  }

  const session = resolveSessionId();
  const ownerName = opts.ownerName || resolveOwnerName();
  const created = new Date().toISOString();
  const branch = opts.branch || basename(absPath);
  const reason = ownerReason(session, ownerName, created, "via=worktree-reap.mjs");
  // The base is explicit or the remote default; never "whatever HEAD happens to
  // be" (Rule 5 — a stale local tip is the silent drift the base argument
  // exists to close).
  const base = opts.base || (gitOk(["rev-parse", "--verify", "--quiet", "origin/HEAD"], { cwd: opts.mainTop }).ok ? "origin/HEAD" : "HEAD");
  const addArgs = opts.existing ? ["worktree", "add", "--lock", "--reason", reason, absPath, branch] : ["worktree", "add", "--lock", "--reason", reason, "-b", branch, absPath, base];
  const added = gitOk(addArgs, { cwd: opts.mainTop });
  if (!added.ok) {
    process.stderr.write(`worktree-reap: git refused the creation: ${added.err.split("\n")[0]}\n`);
    return 1;
  }

  const record = { session, owner: ownerName, created, branch, base: opts.existing ? null : base, reason, creator: "worktree-reap.mjs --create" };
  const wrote = writeOwnerRecord(absPath, opts.gitCommonDir, record);
  const report = [
    `Created ${absPath} on '${branch}' from ${opts.existing ? "(existing branch)" : base}.`,
    `LOCKED. Reason: ${reason}`,
    wrote.ok
      ? `Owner recorded at ${wrote.path}`
      : `WARNING: the owner record could NOT be written (${wrote.err}). The lock reason still names the session, so the unattended pass can still recognise this tree.`,
    session
      ? "Deliver with: node .claude/bin/worktree-reap.mjs --deliver " + absPath
      : "WARNING: no session id in the environment, so this tree is recorded as UNOWNED and the unattended pass will NEVER reap it. Retire it by hand.",
  ];
  emit({ ok: true, path: absPath, branch, reason, owner: record, owner_file: wrote.ok ? wrote.path : null, lines: report }, report);
  return 0;
}

function cmdDeliver(rawPath, opts) {
  const absPath = (() => {
    try {
      return realpathSync(rawPath);
    } catch {
      return resolve(rawPath);
    }
  })();
  const fail = (msg) => {
    process.stderr.write(`worktree-reap: --deliver REFUSED — ${msg}\n`);
    return 1;
  };
  if (!existsSync(absPath)) return fail(`no directory at ${absPath}`);

  const wt = parseWorktrees(opts.listOut).find((w) => w.path === absPath);
  if (!wt) return fail(`${absPath} is not a registered worktree of this repository`);

  const session = resolveSessionId();
  if (!session) {
    return fail("no session id in the environment, so ownership of this tree cannot be proved. Set CLAUDE_CODE_SESSION_ID, or retire the tree by hand.");
  }
  const owner = decideTreeOwner(readOwnerRecord(absPath, opts.gitCommonDir), wt);
  if (!owner.session) {
    return fail(`no owner record for ${absPath} and its lock names no session (${describeOwner(owner)}). Ownership cannot be proved, so this never unlocks it; an operator retires it by hand.`);
  }
  if (owner.session !== session) {
    return fail(`${absPath} was ${describeOwner(owner)}, not this session (${session}). NOT MINE is a refusal.`);
  }

  // UNLOCK, THEN REAP — the order is the whole point: the lock is what makes the
  // tree un-reapable, so "reap on delivery" cannot run while it is held.
  const unlocked = gitOk(["worktree", "unlock", absPath], { cwd: opts.mainTop });
  if (!unlocked.ok) {
    // `unlock` fails on a tree that is not locked. That is not an error for this
    // caller — the post-condition it wants (unlocked) already holds.
    if (!/not locked/i.test(unlocked.err)) return fail(`git worktree unlock failed: ${unlocked.err.split("\n")[0]}`);
  }

  const reapArgs = ["--apply", "--zero-loss-only", "--only", absPath, "--reap-owned-by", session];
  if (opts.json) reapArgs.push("--json");
  const rc = main(reapArgs);

  // RE-LOCK ON SURVIVAL. `--apply` only removes trees that are provably
  // lossless; a dirty or unpushed tree is KEPT, which means it still holds work
  // and must go back under the lock rather than sitting unlocked where the next
  // pass would find it. The end state is always exactly one of: GONE, or LOCKED.
  if (existsSync(absPath)) {
    const reason = ownerReason(owner.session, owner.owner, owner.created, "undelivered=1 via=worktree-reap.mjs");
    const relock = gitOk(["worktree", "lock", "--reason", reason, absPath], { cwd: opts.mainTop });
    process.stderr.write(
      relock.ok
        ? `worktree-reap: ${basename(absPath)} was KEPT by the reap (it still holds work — see the report above) and has been RE-LOCKED.\n`
        : `worktree-reap: WARNING — ${basename(absPath)} was KEPT by the reap and RE-LOCKING IT FAILED (${relock.err.split("\n")[0]}). It is unlocked.\n`,
    );
  }
  return rc;
}

// ── main ────────────────────────────────────────────────────────────────────

function help() {
  return [
    "worktree-reap.mjs — classify the worktree forest and reap only what cannot lose work.",
    "",
    "  (no flags)            classify + report; changes NOTHING (default)",
    "  --apply               perform removals for ZERO-LOSS + TAG-FIRST verdicts",
    "  --zero-loss-only      with --apply, skip TAG-FIRST (reap only provably-pushed trees)",
    "  --min-age-hours <N>   idle floor before a tree is reapable (default " + DEFAULT_MIN_AGE_HOURS + ")",
    "  --only <path|name>    act on ONLY this worktree; repeatable, one selector each",
    "  --no-size             skip the per-tree `du` pass (~2s per 30 trees, measured)",
    "  --deadline-ms <N>     soft budget: past N ms, remaining trees report UNKNOWN",
    "                        and the run finishes normally. Absent = no deadline.",
    "  --reap-owned-by <id>  remove ONLY trees recorded as created by this session;",
    "                        every other tree is REPORTED and held. The unattended",
    "                        SessionEnd pass always passes this; a hand run does not.",
    "  --json                machine-readable output",
    "  --help",
    "",
    "  --create <name|path>  create a SIBLING worktree, LOCKED, with this session",
    "                        recorded as its owner. --branch <name> (default: the",
    "                        path basename), --base <ref> (default: origin/HEAD),",
    "                        --existing to enter an existing branch, --owner <name>.",
    "                        A bare NAME is placed at the canonical sibling path",
    "                        <main-parent>/.<repo-slug>-wt/<name>, derived from the",
    "                        SHARED .git (never --show-toplevel, which from inside",
    "                        a linked worktree returns that worktree's own top and",
    "                        would nest the new tree one level too deep).",
    "  --deliver <path>      unlock a tree THIS session created, reap it on evidence,",
    "                        and re-lock it if the reap keeps it.",
    "",
    "OWNERSHIP — THE THIRD AXIS, alongside DURABILITY and OCCUPANCY.",
    "  Durability asks whether removal loses commits. Occupancy asks whether anyone",
    "  is in the tree now. Neither asks whether the tree is YOURS to remove, and a",
    "  pass that answers only the first two removes other sessions' live work",
    "  correctly. So `--create` LOCKS every tree it makes and records the creating",
    "  session; the unattended pass reaps only what that session created, and",
    "  REPORTS everything else.",
    "  OWNERSHIP IS READ, NOT GUESSED: `<path>/.git` names the per-worktree git dir",
    "  and `coc-owner.json` inside it carries the record — anchored on the tree, so",
    "  it survives any layout, and untouched by `unlock`, so a delivered tree still",
    "  reads as yours. When that file is absent the LOCK REASON (`coc-session=<id>`)",
    "  is read instead. ABSENT MEANS NOT-YOURS: no record and no session in the",
    "  lock is a REFUSAL, never a vacancy.",
    "  The 12h age floor is WAIVED for a tree this session created, and only for",
    "  that tree (an explicit --min-age-hours still outranks it, and every other",
    "  guard still holds). The floor is a clock PROXY for occupancy, and a session's",
    "  own delivered tree is ~0h old by construction — the floor would hold exactly",
    "  the class the unattended pass exists to collect.",
    "",
    "--deadline-ms — degrade, never truncate. An EXTERNAL kill at N ms leaves a",
    "  truncated JSON document and discards every tree already classified. This",
    "  deadline is checked BETWEEN trees, so the run ends under its own control",
    "  with a complete document: partial=true, the verdicts it reached, and the",
    "  remainder marked UNKNOWN. UNKNOWN is NOT KEEP — it means not examined, it",
    "  is never reaped, and it is never safe to remove (Rule 8). Removals also",
    "  stop starting once the budget is spent, so `actions` stays exact.",
    "",
    "--only — path-scoped reaping, for reaping a lane's tree at delivery.",
    "  MATCHING   full path first (resolved through symlinks), then basename. A",
    "             selector matching NOTHING, or matching two trees that share a",
    "             basename, is an ERROR (exit 1) naming the candidates — nothing",
    "             is inspected or removed. It is never a quiet no-op.",
    "  SELECTS CANDIDATES, NOT OUTCOMES   a named tree still runs the full verdict",
    "             pipeline; a KEEP verdict (dirty / unpushed / locked / main /",
    "             this session's own tree) still holds it. There is no --force.",
    "  AGE FLOOR  --only WAIVES the DEFAULT " + DEFAULT_MIN_AGE_HOURS + "h floor for the selected trees, and",
    "             says so per tree in the report. Naming an exact path IS the",
    "             occupancy assertion the clock was standing in for. An explicitly",
    "             passed --min-age-hours is an instruction and OUTRANKS the waiver;",
    "             unselected trees keep the floor. No other signal is waived.",
    "  SCOPE      a scoped run reports scope=selected in its sentinel so it cannot",
    "             be read as a full-forest audit.",
    "",
    "Size is reported per tree and for the forest, with free space and a headroom",
    "estimate (free ÷ median LINKED tree). A tree whose size cannot be determined",
    "reports `unknown`, never 0. Env WORKTREE_REAP_DU overrides the `du` binary.",
    "",
    "Never implements --force: `git worktree remove` already refuses a dirty tree,",
    "and that refusal is the desired behavior. See rules/worktree-isolation.md Rule 8.",
  ].join("\n");
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(help() + "\n");
    return 0;
  }
  const apply = argv.includes("--apply");
  const zeroLossOnly = argv.includes("--zero-loss-only");
  const json = argv.includes("--json");
  const measureSize = !argv.includes("--no-size");
  // `--min-age-hours <N>` AND `--min-age-hours=<N>` ARE THE SAME FLAG. MEASURED
  // before this: `argv.indexOf("--min-age-hours")` misses the `=` spelling, so
  // `--min-age-hours=24` was worse than unparsed — it did not read as EXPLICIT,
  // which also silently demoted it below the `--only` waiver (see classify), and
  // the default floor applied to a tree the operator had asked to hold.
  const ageIdx = argv.findIndex(
    (a) => a === "--min-age-hours" || a.startsWith("--min-age-hours="),
  );
  // Whether the floor was TYPED matters, not only its value: an explicit floor
  // outranks the --only waiver (see classify). `--min-age-hours 12` and the
  // default 12 are the same number and different instructions.
  const ageExplicit = ageIdx !== -1;
  let minAgeHours = DEFAULT_MIN_AGE_HOURS;
  if (ageExplicit) {
    const token = argv[ageIdx];
    const inline = token.includes("=") ? token.slice(token.indexOf("=") + 1) : undefined;
    const raw = inline !== undefined ? inline : argv[ageIdx + 1];
    // THE SHARED VALIDATOR, not a second copy. MEASURED on the old `Number(raw)`
    // arm: `--min-age-hours ""` became 0 (a full waiver from an empty string),
    // `0x1f` became 31 and `1e3` became 1000 — and a trailing flag with no value
    // silently kept the default. 0 stays LEGAL here; what is refused now is a
    // value the parser could not read, and a flag with no value at all.
    const v = validateFloorValue(raw === undefined ? "" : String(raw), {
      floor: 0,
      label: "--min-age-hours",
    });
    if (!v.ok) {
      process.stderr.write(`worktree-reap: ${v.reason}\n`);
      return 1;
    }
    minAgeHours = v.value;
  }

  // `--only` is REPEATABLE and takes exactly one selector each. It deliberately
  // does NOT split on commas: a path may legally contain one, and silently
  // splitting it would turn a valid selector into two that match nothing.
  // `--deadline-ms N` — soft budget, measured from process start (T0). Absent,
  // 0, or malformed all mean NO deadline, which is the pre-existing behaviour:
  // an operator running this by hand should never have a clock imposed on them,
  // and a caller that wants one passes a number. A malformed value falls back to
  // "no deadline" rather than to some default, because inventing a budget nobody
  // asked for would silently truncate an interactive run.
  const dlIdx = argv.indexOf("--deadline-ms");
  const deadlineRaw = dlIdx !== -1 && argv[dlIdx + 1] != null ? Number(argv[dlIdx + 1]) : 0;
  const deadlineMs = Number.isFinite(deadlineRaw) && deadlineRaw > 0 ? deadlineRaw : 0;
  const expired = () => deadlineMs > 0 && Date.now() - T0 >= deadlineMs;

  const onlySelectors = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--only") continue;
    const v = argv[i + 1];
    if (v == null || v.startsWith("--")) {
      process.stderr.write("worktree-reap: --only requires a worktree path or name\n");
      return 1;
    }
    onlySelectors.push(v);
    i++;
  }

  // `--reap-owned-by <session>` — THE UNATTENDED PASS'S OWNERSHIP GATE, and the
  // only flag that may open it. Absent, ownership is reported but not enforced,
  // which is the pre-existing hand-run contract (`/sweep` Sweep 6, the operator
  // affordance). Present, the pass may remove ONLY trees whose recorded creator
  // is this session; everything else is reported and held.
  const ownedIdx = argv.indexOf("--reap-owned-by");
  const reapOwnedBy = ownedIdx !== -1 && argv[ownedIdx + 1] != null && !argv[ownedIdx + 1].startsWith("--") ? argv[ownedIdx + 1] : null;
  if (ownedIdx !== -1 && reapOwnedBy === null) {
    process.stderr.write("worktree-reap: --reap-owned-by requires a session id\n");
    return 1;
  }
  // `--create <path>` / `--deliver <path>` — the CREATION half of the lifecycle.
  // Value-taking, one each; both are dispatched after the repo prologue below.
  const valOf = (flag) => {
    const i = argv.indexOf(flag);
    if (i === -1) return null;
    const v = argv[i + 1];
    return v == null || v.startsWith("--") ? "" : v;
  };
  const createPath = valOf("--create");
  const deliverPath = valOf("--deliver");
  const createBranch = valOf("--branch");
  const createBase = valOf("--base");
  const createOwner = valOf("--owner");
  const createExisting = argv.includes("--existing");
  if ((createPath === "" || deliverPath === "")) {
    process.stderr.write("worktree-reap: --create and --deliver each require a path\n");
    return 1;
  }
  if (createPath !== null && deliverPath !== null) {
    process.stderr.write("worktree-reap: --create and --deliver are separate runs; pass one\n");
    return 1;
  }
  if ((createPath !== null || deliverPath !== null) && apply) {
    process.stderr.write("worktree-reap: --create/--deliver do not take --apply\n");
    return 1;
  }

  // TWO PATHS, TWO NAMES, ONE READ EACH — and the naming is load-bearing rather
  // than tidiness. `--show-toplevel` answers "which checkout am I standing in",
  // which is a DIFFERENT question from "where is the main checkout", and from
  // inside a linked worktree the first answer is the linked tree's own top. That
  // value used to be read into `mainTop` and reassigned two lines later, so for
  // two lines a placement-named variable held a toplevel value — and a placement
  // audit that reads a file statically cannot tell a transient binding from the
  // final one. It reported the reassigned read as `--show-toplevel`-derived
  // placement. That report was FALSE about this file, and the fix is to stop
  // naming the value something it is not: `selfTop` is what the read means, and
  // `mainTop` is derived from the SHARED git dir and nothing else.
  let gitCommonDir, mainTop, selfTop, listOut;
  try {
    gitCommonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    selfTop = git(["rev-parse", "--path-format=absolute", "--show-toplevel"]);
    listOut = git(["worktree", "list", "--porcelain"]);
  } catch (e) {
    process.stderr.write(`worktree-reap: not a git repository, or git failed: ${e.message}\n`);
    return 1;
  }
  // The MAIN checkout is the parent of the SHARED `.git` dir — never the parent
  // of `selfTop`, which doubly-nests when this process runs from a worktree.
  mainTop = gitCommonDir.replace(/\/\.git\/?$/, "");

  // ── the creation / delivery modes ──
  // Dispatched HERE, after the prologue (both need the repo's real paths) and
  // before the trunk resolution (neither classifies the forest, so neither
  // should pay for a provenance map it will not read).
  if (createPath !== null) {
    return cmdCreate(createPath, { branch: createBranch, base: createBase, ownerName: createOwner, existing: createExisting, json, gitCommonDir, mainTop });
  }
  if (deliverPath !== null) {
    return cmdDeliver(deliverPath, { json, gitCommonDir, mainTop, selfTop, listOut });
  }

  // The base the patch-id test (`patchesUpstream`) measures against. It was
  // `origin/HEAD` else `origin/main`, so a tree whose commits had landed on
  // `dev` was judged "not upstream" and held as work in flight. Now the trunk,
  // via the STRICT resolver: `origin/dev` where it exists; where it does not,
  // the pre-existing remote-default read still decides, so a repo without a
  // trunk behaves exactly as before (the composition in `landedRemoteRefs`'s no-`baseRef` arm, `.claude/hooks/lib/wip-lanes.js:880-888`). An
  // UNDETERMINED trunk — e.g. a `COC_TRUNK_REF` that does not resolve — yields
  // null, which leaves `patchesUpstream` null, which never counts as upstream:
  // the fail-closed direction for a tool that can remove a worktree.
  //
  // THE DELETION-GRADE RESOLVER, not the reading one. This tool REMOVES
  // DIRECTORIES under `--apply`, and the base decides which trees read ZERO-LOSS.
  // `resolveTrunk` accepts any `COC_TRUNK_REF` that merely RESOLVES, which is the
  // right bar for a read-only landedness report (a wrong base under-reports) and
  // the wrong one here: point it at any ref whose content is a SUPERSET of the
  // forest and every tree reads "fully upstream", which is the verdict that
  // authorizes removal. `resolveTrunkForDeletion` adds the one question that
  // closes it — is this ref corroborated as the trunk by something other than the
  // variable itself — and returns `unverified` when it is not. Unverified is NOT
  // undetermined: the base is real and still worth REPORTING against, so it is
  // kept for the report and the REAP is refused separately below.
  const trunk = resolveTrunkForDeletion({ repoDir: selfTop, remote: "origin" });
  const defaultRemoteRef = (() => {
    if (trunk.status === "undetermined") return null;
    if (trunk.basis !== "main-fallback") return trunk.ref;
    const r = gitOk(["symbolic-ref", "refs/remotes/origin/HEAD"]);
    if (r.ok && r.out) return r.out.replace(/^refs\/remotes\//, "");
    return gitOk(["rev-parse", "--verify", "--quiet", "origin/main"]).ok ? "origin/main" : null;
  })();
  // An UNVERIFIED base disarms `--apply` and says so. Refusing the whole run was
  // rejected: the classification is still the honest answer to "what is upstream
  // of the ref you named", and withholding it would push the operator toward
  // `--force`. What it is not is grounds for deleting anything.
  const baseUnverified = trunk.status === "unverified";
  const applyAllowed = apply && !baseUnverified;
  const baseRefusal =
    baseUnverified && apply
      ? {
          path: selfTop,
          err:
            `--apply REFUSED for the whole run: ${trunk.reason} ` +
            "Re-run without `COC_TRUNK_REF`, or set it to the ref `refs/remotes/origin/HEAD` names, to reap.",
        }
      : null;

  const parsed = parseWorktrees(listOut);

  // Resolve the selection BEFORE anything is classified, measured or removed.
  // Any unresolvable selector aborts the whole run: a partial selection is not
  // the selection the operator asked for, and reaping the subset that happened
  // to resolve would act on a set nobody named.
  let selected = null;
  if (onlySelectors.length > 0) {
    const { chosen, errors } = resolveSelectors(onlySelectors, parsed);
    if (errors.length > 0) {
      process.stderr.write(errors.map((e) => `worktree-reap: ${e}`).join("\n") + "\nworktree-reap: nothing was inspected and nothing was removed.\n");
      return 1;
    }
    selected = chosen;
  }

  // `apply: applyAllowed`, never the raw flag — an unverified base disarms the
  // removal for every tree in the run, and the refusal is seeded so the report
  // SAYS the run was disarmed rather than silently reporting zero removals
  // (`conservation-gate.md` MUST-4).
  // THE PROVENANCE MAP — built at most ONCE per run, lazily (only a tree with unpushed
  // commits asks), against the SAME ref the patch-id comparison uses. `!ok` is never an
  // empty map: with NO config `landedVerdict` returns `no-config` (fallback) and the
  // comparison runs; with a config whose map cannot be built it returns `no-map`
  // (fallback:false) and every such tree is UNMEASURED — held, never reaped on content.
  //
  // `useCache: false` — this run can DELETE a worktree on a `landed` answer, so it
  // reads the trailers from the object store, never from the on-disk map cache
  // (`<git-common-dir>/landed-map-cache.json`), a file any local process can write.
  let provenanceMap = null;
  const landedVerdictFor = (branch, tip) => {
    if (!provenanceMap) provenanceMap = landedMap.buildLandedMap({ repoDir: selfTop, ref: defaultRemoteRef, useCache: false });
    const v = landedMap.landedVerdict({ repoDir: selfTop, branchRef: `refs/heads/${branch}`, branchName: branch, tip, map: provenanceMap, ref: defaultRemoteRef });
    return { ...v, mapTip: provenanceMap.ok ? provenanceMap.tip : null };
  };
  const ctx = { mainTop, selfTop, gitCommonDir, minAgeHours, ageExplicit, apply: applyAllowed, defaultRemoteRef, selected, refusals: [], landedVerdictFor, reapOwnedBy };
  if (baseRefusal) ctx.refusals.push(baseRefusal);
  // The WHOLE forest is classified even under --only. Two reasons: the size
  // rollup (median over LINKED trees, headroom) is only meaningful over the
  // whole forest, and a scoped run that hid the rest would make the report look
  // like a small forest rather than a partial pass. What --only narrows is what
  // may be ACTED ON.
  //
  // THE DEADLINE CHECKPOINT SITS BETWEEN TREES, NOT INSIDE ONE. Each tree's
  // classification is 2–3 git calls that must all land for the verdict to mean
  // anything; abandoning one halfway would produce a record with a dirty count
  // and no durability check, which is worse than no record. So a tree is either
  // fully classified or fully UNKNOWN.
  const maxClassifyRaw = Number(process.env.WORKTREE_REAP_MAX_CLASSIFY);
  const maxClassify =
    Number.isInteger(maxClassifyRaw) && maxClassifyRaw >= 0 ? maxClassifyRaw : null;

  const records = [];
  let stoppedAt = null;
  for (const wt of parsed) {
    const capHit = maxClassify !== null && records.length >= maxClassify;
    if (capHit || expired()) {
      if (stoppedAt === null) stoppedAt = records.length;
      records.push(
        unclassified(
          wt,
          ctx,
          capHit
            ? `not classified — WORKTREE_REAP_MAX_CLASSIFY=${maxClassify} reached`
            : `not classified — ${deadlineMs}ms classify deadline reached`,
        ),
      );
      continue;
    }
    records.push(classify(wt, ctx));
  }
  const classifiedCount = stoppedAt === null ? records.length : stoppedAt;

  // BEFORE the reap loop, always: --apply deletes directories, and a tree
  // measured after its own removal would report 0 — the exact zero-that-means-
  // nothing this measurement is built to avoid.
  for (const rec of records) {
    if (measureSize && expired()) {
      // Size is decoration on top of the verdicts; it never gets to consume
      // budget the verdicts still need, and an unmeasured tree already has an
      // honest representation (`kb: null`, never 0).
      rec.sizeKb = null;
      rec.sizeNote = "not measured (deadline reached)";
    } else if (measureSize) {
      const { kb, note } = measureSizeKb(rec.path);
      rec.sizeKb = kb;
      rec.sizeNote = note;
    } else {
      rec.sizeKb = null;
      rec.sizeNote = "not measured (--no-size)";
    }
  }
  const size = sizeRollup(records, mainTop);

  // Which instrument COULD answer landedness in this run, reported once: a recorded
  // landing and a reconstructed one are different grades of evidence.
  const provenanceSummary = () => {
    if (!provenanceMap) return { status: "not-consulted", ref: defaultRemoteRef, tip: null, why: "no tree had unpushed commits to judge" };
    if (provenanceMap.ok) return { status: "ok", ref: defaultRemoteRef, tip: provenanceMap.tip, cutover: provenanceMap.cutover, cached: provenanceMap.cached, why: null };
    return { status: provenanceMap.noConfig ? "no-config" : "no-map", ref: defaultRemoteRef, tip: null, why: provenanceMap.why };
  };
  if (provenanceMap && !provenanceMap.ok && !provenanceMap.noConfig) {
    process.stderr.write(`worktree-reap: LANDING PROVENANCE UNAVAILABLE — ${provenanceMap.why}. This repository records landings, so landedness below is UNMEASURED for every tree with unpushed commits (never resolved by git cherry patch-ids) and no such tree is reaped as landed.\n`);
  }

  let reapStoppedEarly = false;
  for (const rec of records) {
    // `rec.selected` is the CANDIDATE gate; the verdict is still the OUTCOME
    // gate, and it is evaluated first-class here. A selected KEEP tree gets no
    // action, which is what makes --only a selector rather than a --force.
    //
    // UNKNOWN IS EXCLUDED EXPLICITLY, not merely by falling off the end of the
    // verdict list. Written out because it is the single line standing between
    // "we ran out of budget" and "we removed a tree we never examined", and
    // because the implicit form was measured to be UNTESTABLE: every run that
    // produces UNKNOWN via the clock has ALSO stopped the removal loop on the
    // same clock, so mutating the implicit exclusion away left the suite green.
    // The exclusion is now stated once, and `WORKTREE_REAP_MAX_CLASSIFY` gives
    // the suite a run where it is the only thing holding the tree.
    const eligible =
      rec.selected &&
      rec.verdict !== UNKNOWN &&
      (rec.verdict === REAP || (rec.verdict === TAG_FIRST && !zeroLossOnly));
    if (eligible && expired()) {
      // Stop STARTING removals once the budget is spent. Each removal is ~0.6 s
      // (measured), so beginning one here is what previously left the caller
      // unable to say how many trees had gone. Stopping between removals keeps
      // `actions` an exact record of what happened.
      reapStoppedEarly = true;
      rec.actions = [];
      continue;
    }
    rec.actions = eligible ? reap(rec, ctx) : [];
  }

  const scoped = selected !== null;
  const counts = {
    total: records.length,
    selected: records.filter((r) => r.selected).length,
    zero_loss: records.filter((r) => r.verdict === REAP).length,
    tag_first: records.filter((r) => r.verdict === TAG_FIRST).length,
    keep: records.filter((r) => r.verdict === KEEP).length,
    // Its own bucket, never folded into keep. zero_loss + tag_first + keep +
    // unknown === total, and a test pins that identity so a future verdict
    // cannot go missing from the tally.
    unknown: records.filter((r) => r.verdict === UNKNOWN).length,
    // Its own bucket. A tree held for OWNERSHIP is not "kept" by evidence about
    // the tree — it is refused because this pass may not act on it — and rolling
    // the two together would let a pass that refused the entire forest render as
    // a forest with nothing to give up.
    held_not_owned: records.filter((r) => r.heldNotOwned).length,
  };
  const partial = counts.unknown > 0 || reapStoppedEarly;

  if (json) {
    process.stdout.write(
      JSON.stringify(
        { applied: applyAllowed, partial, classified: classifiedCount, provenance: provenanceSummary(), deadline_ms: deadlineMs || null, reap_stopped_early: reapStoppedEarly, scope: scoped ? "selected" : "all", only: onlySelectors, min_age_hours: minAgeHours, min_age_hours_explicit: ageExplicit, reap_owned_by: reapOwnedBy, default_remote_ref: defaultRemoteRef, main_checkout: mainTop, counts, size, refusals: ctx.refusals, worktrees: records },
        null,
        2,
      ) + "\n",
    );
  } else {
    const lines = [];
    lines.push(`Worktree forest — ${counts.total} tree(s); reap floor --min-age-hours ${minAgeHours}` + (applyAllowed ? "  [APPLYING]" : "  [report only]"));
    // The gate is stated where an operator reads the run: a scoped pass and a
    // whole-forest pass differ ONLY by this line, and "it removed nothing" must
    // not read the same for both (`conservation-gate.md` MUST-4).
    lines.push(
      reapOwnedBy !== null
        ? `  ownership gate: only trees recorded as created by session ${reapOwnedBy} may be removed; every other tree is REPORTED and held.`
        : "  ownership gate: OFF (no --reap-owned-by) — ownership is reported per tree but does not hold anything.",
    );
    // The instrument behind every "already landed" below, stated once up front; each
    // tree's reason line names it again for that tree.
    const ps = provenanceSummary();
    if (ps.status === "ok") lines.push(`  landedness: Landed-From trailers on ${ps.ref}@${ps.tip.slice(0, 12)} decide branches forked after the cutover; git cherry patch-ids only what predates it.`);
    else if (ps.status === "no-config") lines.push(`  landedness: landing provenance not recorded in this repository — git cherry patch-ids (reconstructed).`);
    else if (ps.status === "no-map") lines.push(`  landedness: provenance UNAVAILABLE (${ps.why}) — UNMEASURED; not resolved by git cherry patch-ids, so no tree is reaped as landed.`);
    if (scoped) {
      lines.push(`  scope: --only — ${counts.selected} of ${counts.total} tree(s) selected (${onlySelectors.join(", ")}).`);
      lines.push(`         the other ${counts.total - counts.selected} were classified but are NOT eligible for reap in this run.`);
    }
    lines.push("");
    if (partial) {
      lines.push(
        `  PARTIAL: ${classifiedCount} of ${counts.total} tree(s) classified` +
          (deadlineMs > 0 ? ` before the ${deadlineMs}ms deadline` : "") +
          `; ${counts.unknown} are UNKNOWN.`,
      );
      lines.push(
        "           UNKNOWN means NOT EXAMINED — not KEEP, and never safe to remove. Re-run without --deadline-ms for a full audit.",
      );
      lines.push("");
    }
    for (const r of records) {
      const tag = r.verdict === REAP ? "ZERO-LOSS" : r.verdict === TAG_FIRST ? "TAG-FIRST" : r.verdict === UNKNOWN ? "UNKNOWN  " : "KEEP     ";
      const sz = r.sizeKb === null ? "unknown" : (r.sizeNote && r.sizeNote.startsWith("partial") ? "≥" : "") + fmtKb(r.sizeKb);
      const mark = scoped ? (r.selected ? "  [selected]" : "  [out of scope]") : "";
      lines.push(`  [${tag}] ${basename(r.path)}${r.branch ? `  (${r.branch})` : "  (detached)"}  —  ${sz}${mark}`);
      // Printed, not silent: a waived floor is a rule that did NOT run, and the
      // operator should see the age it would have been measured against. The
      // CAUSE is printed too — "--only" and "ownership" are different evidence
      // for the same waiver, and a reader who cannot tell them apart cannot tell
      // an operator's assertion from the creating session's own record.
      if (r.ageFloorWaived) {
        const cause = r.ageFloorWaivedBy === "ownership"
          ? "ownership: this session created it"
          : "explicit --only selection";
        lines.push(`             · default --min-age-hours ${DEFAULT_MIN_AGE_HOURS} waived by ${cause}` + (r.ageHours === null ? "" : ` (last active ${r.ageHours.toFixed(1)}h ago)`));
      }
      // OWNERSHIP, on every tree, in every run. The unattended pass needs it to
      // decide; an operator reading a hand-run needs it to know whether the tree
      // in front of them is theirs to remove at all.
      if (r.owner) {
        // `read`/`lock-reason` says WHICH structural surface answered — a
        // distinction an operator needs, because the record survives `unlock`
        // and the lock reason does not.
        lines.push(`             · owner: ${describeOwner(r.owner)} [via ${r.owner.source || "nothing"}]`);
      } else if (r.verdict !== UNKNOWN) {
        lines.push("             · owner: NO RECORD — created before ownership was recorded, or by hand; the unattended pass will never reap it");
      }
      for (const why of r.reasons) lines.push(`             · ${why}`);
      if (r.sizeNote && r.sizeKb === null) lines.push(`             · size ${r.sizeNote}`);
      for (const a of r.actions) lines.push(`             → ${a}`);
    }
    lines.push("");
    lines.push(
      `  zero-loss: ${counts.zero_loss}   tag-first: ${counts.tag_first}   keep: ${counts.keep}` +
        (counts.unknown > 0 ? `   unknown: ${counts.unknown}` : "") +
        (counts.held_not_owned > 0 ? `   held-not-owned: ${counts.held_not_owned}` : ""),
    );
    if (counts.held_not_owned > 0) {
      const named = records.filter((r) => r.heldNotOwned).map((r) => basename(r.path)).join(", ");
      lines.push(
        `  REPORTED, NOT REAPED: ${counts.held_not_owned} tree(s) were not created by session ${reapOwnedBy} and this pass may not remove them: ${named}.`,
      );
    }
    lines.push(
      `  forest size: ${size.total_is_lower_bound && size.total_kb !== null ? "≥" : ""}${fmtKb(size.total_kb)}` +
        ` across ${size.measured} measured tree(s)` +
        (size.unknown > 0 ? `   [${size.unknown} unknown]` : "") +
        (size.partial > 0 ? `   [${size.partial} partial]` : ""),
    );
    lines.push(`  volume free: ${fmtKb(size.volume_free_kb)}   median linked tree: ${fmtKb(size.median_tree_kb)}   headroom: ${size.headroom_trees === null ? "unknown" : `~${size.headroom_trees} more tree(s)`}`);
    // The ONLY size threshold this tool asserts, and it is definitional rather
    // than tuned: below one median tree, the next `git worktree add` cannot fit.
    // No "looks about right" constant is introduced; the headroom figure above
    // is printed on EVERY run so the trend is visible long before it reaches 1.
    if (size.headroom_trees !== null && size.headroom_trees < 1) {
      lines.push(`  WARNING: free space is under one median worktree — the next worktree creation will not fit.`);
    }
    // The base refusal is rendered HERE as well as in the JSON envelope. It is
    // the only channel a text-mode operator has: `ctx.refusals` is serialized
    // under --json and nowhere else, so a disarmed run would otherwise print a
    // normal report with no removals — byte-identical to a forest that had
    // nothing to give up (`conservation-gate.md` MUST-4).
    if (baseRefusal) {
      lines.push(`  ${baseRefusal.err}`);
    } else if (!applyAllowed && counts.zero_loss + counts.tag_first > 0) {
      lines.push("  Re-run with --apply to reap. KEEP trees are never touched.");
    }
    // SENTINEL. /sweep reads this as evidence the forest audit ran, so a run
    // that acted on a SUBSET must not render like one that swept everything —
    // otherwise a partial pass silently clears a whole-forest gate, which is a
    // real gate turned into a false one. `scope=` carries that distinction, and
    // `selected=` the size of the subset.
    lines.push(
      `  <!-- worktree-reap:v1:total=${counts.total} scope=${scoped ? "selected" : "all"} selected=${counts.selected}` +
        ` zero_loss=${counts.zero_loss} tag_first=${counts.tag_first} keep=${counts.keep} unknown=${counts.unknown}` +
        ` partial=${partial} classified=${classifiedCount} applied=${applyAllowed}` +
        ` owned_by=${reapOwnedBy === null ? "none" : reapOwnedBy} held_not_owned=${counts.held_not_owned}` +
        ` size_kb=${size.total_kb === null ? "unknown" : size.total_kb} size_unknown=${size.unknown} size_partial=${size.partial}` +
        ` free_kb=${size.volume_free_kb === null ? "unknown" : size.volume_free_kb} headroom_trees=${size.headroom_trees === null ? "unknown" : size.headroom_trees} -->`,
    );
    process.stdout.write(lines.join("\n") + "\n");
  }

  return ctx.refusals.length > 0 ? 2 : 0;
}

// Entry-point check: .claude/bin/lib/entry-point.mjs (symlink-safe). Importing this
// module — as its unit tests do for `decideTreeLanded` — runs nothing.
if (isMainModule(import.meta.url)) process.exit(main(process.argv.slice(2)));
