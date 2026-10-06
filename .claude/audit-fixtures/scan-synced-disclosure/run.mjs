#!/usr/bin/env node
/*
 * Fixture runner for scan-synced-disclosure.mjs (issue #263).
 *
 * Invokes the scanner with --root pointed at each fixture tree and
 * asserts the expected disposition. Every token in every fixture is
 * SYNTHETIC and invented for this fixture — there are NO real operator
 * hostnames, org slugs, runner labels, home paths, or service labels
 * anywhere under this directory.
 *
 *   node .claude/audit-fixtures/scan-synced-disclosure/run.mjs
 *
 * Exit 0 = all fixtures behaved as expected; 1 = a regression; 130 = interrupted;
 * 3 = CANNOT EXECUTE — a precondition about where this checkout sits was not met, so
 * nothing here ran and the result is not a verdict about the scanner. See § CANNOT-EXECUTE
 * OUTCOME below for why 3 is distinct from 1.
 *
 * PLACEMENT LIMITATION — REFUSES FROM A NESTED WORKTREE, by design and at no cost.
 * The source pole materializes HEAD into a SIBLING of the checkout, so from a nested
 * worktree that sibling would land inside the ENCLOSING work tree. `materializeSourceTree`
 * therefore refuses (`assertSiblingParentOutsideWorkTree`). This narrows NO SUPPORTED
 * LAYOUT: nested worktrees are refused by `rules/worktree-isolation.md` anyway — the
 * `isolation: "worktree"` / `EnterWorktree({name})` flags are RETIRED and BLOCKED by
 * Rule 1(a) because both place a
 * worktree nested under the repo's own `.claude/`, Rule 7 requires a sibling for anything
 * a session roots into, and the placement half SHIPS as a structural guard
 * (`.claude/hooks/nested-worktree-guard.js`, `PreToolUse`, `severity: block`). So this
 * refuses the same runs that policy already refuses, one layer earlier and with a reason
 * about the fixture rather than about the agent's call.
 *
 * WHY THIS PARAGRAPH EXISTS: the natural repair for that refusal is to normalize the
 * parent through `git rev-parse --git-common-dir`, which returns one path from the
 * primary and from a linked worktree alike. It was considered and REJECTED — it
 * reintroduces exactly the resolution the sibling placement exists to avoid, and it
 * would buy coverage of a layout the repo disallows. If you are reading this because you
 * are about to write that normalization: the coverage it recovers is nil.
 */

import "../_lib/no-ambient-git.cjs";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orgSets, privateOrgSlugs } from "../../bin/lib/strip-build-internal.mjs";

// Tier-1 (2026-10-04): the private-slug set is now DERIVED from
// `.claude/canon-identity-values.json` (lazy; EMPTY at a config-less consumer —
// indexing it there would throw or render `repos/undefined/…`). The fixtures
// below compose the slug from the derivation and fall back to a synthetic; AT
// LOOM the derived values drive every assertion.
const FIXTURE_ORG = privateOrgSlugs()[0] || "northwind-labs";
// A PUBLIC org (the one the templates live in) — the scanner allowlists it
// statically, so it is the right stand-in for "an org the allowlist vouches
// for" without pinning a private value.
const FIXTURE_ALLOWLISTED_ORG = orgSets().public[0] || "terrene-foundation";
import {
  assertCheckoutOutsideTrustedTemp,
  CHECKOUT_UNDER_TRUSTED_TEMP,
  isWithinRoot,
  realpathForContainment,
} from "../../bin/lib/path-containment.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── CONFIG-ARMED / IDENTITY-COHERENT gates (r4-v4 item 8) ───────────────────
//
// Declared AFTER `HERE` on purpose: a version of this block placed above it
// threw a temporal-dead-zone ReferenceError into its own catch and read as
// "not coherent" — the whole tree skipped the four scenarios below and the
// run reported green over a question it never asked (`instrument-discipline.md`
// MUST-3: silence from an instrument that could not run is not a verdict).
// The roster read's catch is therefore NARROW: ENOENT means "no roster, so no
// identity to agree with"; any OTHER read error rethrows rather than
// masquerading as incoherence (zero-tolerance.md Rule 3).
//
// This runner SHIPS. In a tree with no `.claude/canon-identity-values.json`
// (a consumer, or an ecosystem fork before /ecosystem-init) the derived
// private-slug set is EMPTY, and scenarios whose SUBJECT is that set cannot
// run there. A scenario that cannot run must SAY SO by name; reporting the
// mismatch as a scanner regression is the mis-attribution this file's own
// summary text forbids. Two different conditions, deliberately not collapsed
// into one flag:
//
//   CONFIG_ARMED      — the tree declares a non-empty private set. The
//                       delivery-engine scenario needs this: the engine's
//                       private-slug gate is armed BY CONFIG and correctly
//                       REFUSES to distribute a tree whose gate would be
//                       vacuous, so `--out` cannot be produced without it.
//   IDENTITY_COHERENT — the derived org is a token of THIS tree's own roster,
//                       i.e. the config and the roster describe the same
//                       identity. The count-locked scrubber scenarios below
//                       were MEASURED at loom, where the roster's genesis
//                       owner IS the private org, so the private literal
//                       fires the operator-identity shapes their counts
//                       include. In a tree where the two disagree (config-less,
//                       or a mismatched declaration) the derived org cannot
//                       fire that half of the count, and the deficit is a
//                       property of the TREE, not of the scanner. Best-effort
//                       raw-text test on purpose: the roster is a JSON object
//                       whose token fields are exactly what the scanner's own
//                       roster reader harvests, and a false NEGATIVE here
//                       degrades to "run the scenario" (its normal behaviour),
//                       never to a silent pass.
const CONFIG_ARMED = privateOrgSlugs().length > 0;
const IDENTITY_COHERENT = (() => {
  const slug = privateOrgSlugs()[0];
  if (!slug) return false;
  let rosterText;
  try {
    rosterText = fs.readFileSync(
      path.resolve(HERE, "..", "..", "..", ".claude", "operators.roster.json"),
      "utf8",
    );
  } catch (e) {
    if (e && e.code === "ENOENT") return false; // no roster → no identity to agree with
    throw e; // any OTHER read error is NOT "incoherent" — never a silent skip
  }
  return rosterText.toLowerCase().includes(slug.toLowerCase());
})();
const NO_CONFIG_SKIP =
  "no .claude/canon-identity-values.json in this tree — the private-slug set this scenario " +
  "drives is EMPTY, so its subject does not exist here; NOT RUN, not a pass";
const NOT_COHERENT_SKIP =
  "this tree's derived private org is not a token of its own roster (config and roster " +
  "describe different identities) — the count this scenario locks was measured where they " +
  "agree; NOT RUN, not a pass";
// ── CANNOT-EXECUTE OUTCOME (loom#F6) ────────────────────────────────────────
//
// A PRECONDITION failure — this checkout is under a trusted temp root, or the sibling
// scan tree would land inside another repo — is not a verdict about the scanner. While
// it exited 1 it was indistinguishable from a fixture regression, so a consumer whose
// checkout sits under a temp root would chase a disclosure failure that does not exist.
// It gets its own exit code and a banner naming the reason, mirroring the outcome the
// sibling suites produce via `path-containment.mjs::assertCheckoutOutsideTrustedTemp`.
//
// THE REASON STRING IS IMPORTED, NEVER TYPED. `CHECKOUT_UNDER_TRUSTED_TEMP` is the same
// constant the suites report, so a rename cannot drift this banner from theirs — the
// failure the sibling guard's hand-typed literals already demonstrate in this lane.
//
// Codes: 0 = every fixture behaved; 1 = a real fixture regression; 130 = interrupted;
// 3 = NEVER RAN. 3 is deliberately outside both numberings.
const CANNOT_EXECUTE_EXIT = 3;

// The placement precondition's OWN identities, so the banner names which one failed.
// Two, not one: "the parent is inside a repo" and "git could not tell us" are different
// facts, and collapsing them would put a wrong reason on the banner — the defect F6 is
// about, one layer in.
const SIBLING_PARENT_INSIDE_WORK_TREE = "sibling-parent-inside-work-tree";
const SIBLING_PARENT_UNVERIFIABLE = "sibling-parent-unverifiable";

function cannotExecute(err) {
  console.error("");
  console.error(err && err.message ? err.message : String(err));
  console.error(
    `cannot-execute: ${(err && err.reason) || CHECKOUT_UNDER_TRUSTED_TEMP} — this fixture ` +
      `NEVER RAN, so its result is NOT a verdict about scan-synced-disclosure.mjs. ` +
      `Exit ${CANNOT_EXECUTE_EXIT} is deliberately distinct from 1 (a real fixture regression).`,
  );
  process.exit(CANNOT_EXECUTE_EXIT);
}

const SCANNER = path.resolve(
  HERE,
  "..",
  "..",
  "bin",
  "scan-synced-disclosure.mjs",
);

// ── Orphaned-control reaping ────────────────────────────────────────────────
//
// The source pole plants a DISCRIMINATION CONTROL at
// `<repo>/.claude/rules/zz-disclosure-fixture-<pid>-control.md` carrying a
// synthetic operator-home leak, and removes it a few hundred ms later. It cannot
// live anywhere safer: its whole job is to prove the scanner still emits findings
// on the SOURCE surface, and the source scan SKIPS gitignored+untracked files, so
// a `.gitignore` covering this path would DISARM the control rather than protect
// it. That is why the hazard is closed by REAPING, not by ignoring.
//
// REAPING COVERS TWO RESIDUAL CLASSES, and an earlier revision of this comment named
// only the first while the fix that landed had created the second:
//   1. an in-repo control orphaned by a SIGKILL (swept below, in `.claude/`);
//   2. the MATERIALIZED source tree `materializeSourceTree` mints as a SIBLING of the
//      checkout (`.‹repo›-scan-fixture-<pid>` + `.index`, a full HEAD copy) — outside
//      the repo by construction, so class 1's sweep cannot see it (`loom#D1`).
//
// MEASURED: `git check-ignore` on that path returns rc=1 (NOT ignored), unlike the
// sibling probe dir which self-ignores with `*`. So while the file exists, a
// `git add -A` would commit a synthetic leak into the LIVE rule corpus, and a
// SIGKILL between the plant and the removal orphans it permanently — neither the
// explicit rm nor the `finally` runs.
//
// PID-LIVENESS IS LOAD-BEARING, not caution. The per-PID naming exists because a
// concurrent runner was OBSERVED deleting a fixed-path probe mid-review (see the
// source pole's own header). Reaping another LIVE run's control would recreate
// exactly that race, and in the FALSE-GREEN direction: the victim's "was it
// skipped?" assertion would pass because the file was gone, not because the skip
// worked. So a control whose PID is still alive is left strictly alone.
const CONTROL_RE = /^zz-disclosure-fixture-(\d+)-control\.md$/;
function pidAlive(pid) {
  try {
    // Signal 0 performs the permission/existence check WITHOUT delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = the process EXISTS but belongs to another user. Alive. Treating it
    // as dead would reap a live run's control — fail SAFE toward "leave it".
    return e && e.code === "EPERM";
  }
}
// TWO locations, deliberately. `.claude/<tag>-control/` is where the control lives
// NOW. `.claude/rules/<tag>-control.md` is where it lived BEFORE the relocation, and
// that arm is not dead code: orphans from a pre-relocation run may already be sitting
// in the rule corpus on any machine that ran this suite, and those are exactly the
// ones that charge all 8 session profiles and red a concurrent budget check. The
// legacy arm reaps them; it can be deleted once no such orphan can remain.
const CONTROL_DIR_RE = /^zz-disclosure-fixture-(\d+)-control$/;

// A RECURSIVE removal whose target is computed rather than literal is a loaded gun,
// and this one FIRED: while testing a mutation that pointed `controlDir` back at
// `.claude/rules`, the source pole's `finally` recursively deleted the ENTIRE rule
// corpus — 106 tracked files — out of a worktree shared with six other agents. They
// were clean-at-HEAD and were restored byte-identically from the HEAD tree, but the
// lesson is the code's, not the operator's: every rmSync in this file now goes
// through a fence that REFUSES any path whose basename is not a control artifact.
// A mis-pointed constant now throws instead of destroying a directory.
// The probe DIRECTORY (`.claude/zz-disclosure-fixture-<pid>`) is computed from
// REPO_ROOT too, so it carries the same risk and goes through the same fence.
// Temp dirs from `mkdtempSync` do NOT: they are rooted in os.tmpdir() and cannot
// resolve to a repo path.
const PROBE_DIR_RE = /^zz-disclosure-fixture-(\d+)$/;
// The MATERIALIZED source tree (see materializeSourceTree below) is the one family
// that must live OUTSIDE the repo, so its arm carries a location check as well as a
// basename check: a mis-point that dragged the recursive rm back onto the corpus is
// exactly the direction that fired here once already.
// TWO shapes, because `materializeSourceTree` mints two: the tree directory and its
// `<tree>.index` file. A fence that knew only the directory would refuse the index on
// teardown — and the index is the half that survives a partial cleanup.
const SCAN_TREE_RE = /^\..+-scan-fixture-(\d+)(\.index)?$/;
function rmControlPath(target, opts = {}) {
  const base = path.basename(target);
  if (SCAN_TREE_RE.test(base)) {
    const repoRoot = path.resolve(HERE, "..", "..", "..");
    if (isWithinRoot(realpathForContainment(target), repoRoot)) {
      throw new Error(
        `refusing to remove ${target}: the materialized scan tree must live OUTSIDE ` +
          `the repo, and this path resolves inside it. Fix the constant; do NOT relax ` +
          `this fence.`,
      );
    }
    fs.rmSync(target, opts);
    return;
  }
  if (!CONTROL_DIR_RE.test(base) && !CONTROL_RE.test(base) && !PROBE_DIR_RE.test(base)) {
    throw new Error(
      `refusing to remove ${target}: basename ${JSON.stringify(base)} is not a ` +
        `zz-disclosure-fixture-<pid>-control artifact. A control path that no longer ` +
        `matches has been mis-pointed — fix the constant; do NOT relax this fence.`,
    );
  }
  fs.rmSync(target, opts);
}
function reapOrphanedControls() {
  const claudeDir = path.resolve(HERE, "..", "..");
  const rulesDir = path.join(claudeDir, "rules");
  const reaped = [];
  const skippedLive = [];
  // `label` is what gets REPORTED, so an operator reading the line knows which
  // location an orphan came from without inferring it.
  const sweep = (dir, re, label, rmOpts) => {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return; // directory absent: nothing to reap here
    }
    for (const name of entries) {
      const m = re.exec(name);
      if (!m) continue;
      const pid = Number(m[1]);
      if (pid === process.pid || pidAlive(pid)) {
        skippedLive.push(`${label}${name}`);
        continue;
      }
      try {
        rmControlPath(path.join(dir, name), rmOpts);
        reaped.push(`${label}${name}`);
      } catch {
        skippedLive.push(`${label}${name}`); // could not remove: report, never claim success
      }
    }
  };
  sweep(claudeDir, CONTROL_DIR_RE, ".claude/", { recursive: true, force: true });
  sweep(rulesDir, CONTROL_RE, ".claude/rules/", { force: true });
  return { reaped, skippedLive };
}

// ── MATERIALIZED-TREE REAPING (loom#D1) ─────────────────────────────────────
//
// `materializeSourceTree` mints `.<repo>-scan-fixture-<pid>` as a SIBLING of the
// checkout, plus its `.index` — a full HEAD tree, ~94 MB. The reaper above cannot see
// either: it sweeps `.claude/`, and these live OUTSIDE the repo by construction. So a
// SIGKILL between the mint and the `finally` orphans both, and the claim that the
// start-of-run reap absorbs the SIGKILL residual was true of the control and false of
// everything that fix added.
//
// Keyed on the SAME two conditions `_lib/test-temp.mjs` applies to its own run dirs,
// rather than a second policy invented here: owner pid DEAD **and** mtime past a floor.
// The floor is the second condition on purpose — a pid can be recycled onto an
// unrelated live process, and a tree being written right now has a fresh mtime, so a
// dead-looking pid alone must never be enough to delete a live run's tree.
const SCAN_TREE_SIBLING_RE = /^\.(.+)-scan-fixture-(\d+)$/;
const SCAN_TREE_INDEX_RE = /^\.(.+)-scan-fixture-(\d+)\.index$/;
const SCAN_TREE_FLOOR_MS = 6 * 60 * 60 * 1000;

function reapOrphanedScanTrees({ floorMs = SCAN_TREE_FLOOR_MS, now = Date.now() } = {}) {
  const repoRoot = path.resolve(HERE, "..", "..", "..");
  const parent = path.dirname(repoRoot);
  const reaped = [];
  const skippedLive = [];
  const keptYoung = [];
  let entries;
  try {
    entries = fs.readdirSync(parent);
  } catch {
    return { reaped, skippedLive, keptYoung }; // unreadable parent: nothing to report
  }
  for (const name of entries) {
    const m = SCAN_TREE_SIBLING_RE.exec(name) || SCAN_TREE_INDEX_RE.exec(name);
    if (!m) continue;
    const pid = Number(m[2]);
    const full = path.join(parent, name);
    // PID-LIVENESS FIRST, then the floor. A live owner is never touched, whatever its
    // age — the same order the helper uses, and the same reason.
    if (pid === process.pid || pidAlive(pid)) {
      skippedLive.push(`../${name}`);
      continue;
    }
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue; // vanished between readdir and stat — nothing to decide
    }
    if (now - st.mtimeMs < floorMs) {
      keptYoung.push(`../${name}`);
      continue;
    }
    try {
      rmControlPath(full, st.isDirectory() ? { recursive: true, force: true } : { force: true });
      reaped.push(`../${name}`);
    } catch {
      skippedLive.push(`../${name}`); // could not remove: report, never claim success
    }
  }
  return { reaped, skippedLive, keptYoung };
}
{
  const { reaped, skippedLive } = reapOrphanedControls();
  const trees = reapOrphanedScanTrees();
  // LOUD, not silent: an orphan means a previous run died between the plant and
  // the removal, so a synthetic leak was sitting in the tree until now. Reaping it
  // quietly would hide that it had ever been there. The path each entry carries is
  // its OWN, so a legacy `.claude/rules/` orphan is distinguishable at a glance
  // from a current `.claude/` one.
  for (const n of reaped) {
    console.log(`REAPED orphaned disclosure control from a dead run: ${n}`);
  }
  for (const n of skippedLive) {
    console.log(`left in place (owning PID still alive, or not removable): ${n}`);
  }
  for (const n of trees.reaped) {
    console.log(`REAPED orphaned scan tree from a dead run: ${n}`);
  }
  for (const n of trees.skippedLive) {
    console.log(`left in place (owning PID still alive, or not removable): ${n}`);
  }
  for (const n of trees.keptYoung) {
    console.log(`left in place (younger than the ${Math.round(SCAN_TREE_FLOOR_MS / 3600000)}h floor): ${n}`);
  }
}
// Second belt: remove THIS run's control on ordinary termination too, not only on
// the happy path. Covers Ctrl-C and a `kill` — NOT SIGKILL, which no handler can
// catch. The start-of-run reap above absorbs it — for the CONTROLS. The materialized
// scan tree is the second class and is absorbed by `reapOrphanedScanTrees`, which runs
// in the same block; an earlier revision of this comment claimed the control reap
// covered the residual, which stopped being true the moment that tree existed.
// Both locations, for the same reason the reaper sweeps both.
const OWN_CONTROLS = [
  path.resolve(HERE, "..", "..", `zz-disclosure-fixture-${process.pid}-control`),
  path.resolve(HERE, "..", "..", "rules", `zz-disclosure-fixture-${process.pid}-control.md`),
];
const dropOwnControl = () => {
  try {
    for (const p of OWN_CONTROLS) rmControlPath(p, { recursive: true, force: true });
  } catch {
    /* best-effort teardown; the start-of-run reap is the durable guarantee */
  }
};
process.on("exit", dropOwnControl);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    dropOwnControl();
    process.exit(130);
  });
}

// Each case: { dir, expectExit, expectShapes:[ids], expectFindingCount }
const CASES = [
  {
    name: "flag-each-shape",
    dir: "flag-each-shape",
    expectExit: 1,
    // Every structural shape this fixture plants must be caught at least once.
    // `operator-temp-path` (2026-10-03) is the PLANTED-VALUE CONTROL for the
    // macOS per-user temp hash — the security-review residual: its value in
    // `planted.md` is synthetic and this row is what proves the shape FIRES.
    expectShapes: [
      "operator-hostname",
      "nonfoundation-org-slug",
      "org-derived-runner-label",
      "operator-home-path",
      "operator-service-label",
      "operator-temp-path",
    ],
  },
  {
    name: "clean-foundation-placeholder",
    dir: "clean-foundation-placeholder",
    expectExit: 0,
    expectShapes: [],
  },
  {
    // F404 Shard 3 (2026-07-15): container-internal devcontainer user homes
    // (`/home/dev/` py + `/home/vscode/` rs) are the fixed base-image users,
    // NOT host operator homes — the allowlist suppresses both. This locks the
    // `/home/vscode/` entry added for the rs compose.override.yml.example mounts
    // (and retroactively the pre-existing `/home/dev/` sibling, previously
    // fixture-less). A real operator home still flags (see flag-each-shape /
    // nonown-still-flagged).
    name: "container-internal-home-allowlisted",
    dir: "container-internal-home-allowlisted",
    expectExit: 0,
    expectShapes: [],
  },
  {
    name: "excluded-accepted-history",
    dir: "excluded-accepted-history",
    expectExit: 0,
    expectShapes: [],
  },
  {
    // REPLACES the retired `own-org-allowed` case (2026-09-25). The Option-1
    // own-coordinate exemption (#263) is gone: the scanned repo's OWN operator
    // identity is now a FINDING, derived at runtime from its roster through
    // identity-scrub.mjs::deriveDynamicTokens. The fixture carries a SYNTHETIC
    // roster and six lines in the exact forms that shipped undetected — a
    // `codify/<operator>-<date>` branch, a `.session-notes.d/<operator>.md`
    // path, the genesis owner inside a clone URL, an underscore-joined name, a
    // login, and a home path — plus two GLUED forms (`not<op>`, `<op>x`) that must
    // flag, since a 7+-character token matches unbounded (2026-09-25 review round).
    // 10 findings: 8 operator-identity-token, 1 nonfoundation-org-slug (the
    // `-enterprise` owner in the URL), 1 operator-home-path. With the identity
    // shape removed only the last two survive, so the count lock reds on it.
    name: "own-identity-flagged",
    dir: "own-identity-flagged",
    expectExit: 1,
    expectShapes: ["operator-identity-token", "nonfoundation-org-slug", "operator-home-path"],
    expectFindingCount: 10,
  },
  {
    // F1 (security review of the Option-1 retirement) → Tier-1 round 2
    // (2026-10-04): the scrubber tolerance is DELETED. The strip file no longer
    // carries any private literal (its patterns derive at runtime; the identity
    // declaration is double-fenced out of delivery), so at THIS path a private
    // literal now FLAGS like anywhere else — which is the point: the file is
    // scanned with no suppression, and its clean scan in the real tree is
    // evidence rather than a skip. EXPECTED COUNT, derived and MEASURED (12):
    //   • 4 unchanged — two third-party orgs (acme-corp, globex-inc) and two
    //     person tokens on the last line;
    //   • 4 slug SPANS (this file's header comment, the bare regex literal,
    //     `gh api orgs/`, and `gh api repos/`), each reporting TWO shapes — the
    //     private slug as nonfoundation-org-slug AND as operator-identity-token,
    //     because the scanner loads [scan-root, REPO_ROOT] rosters by design
    //     (Gate-1 intake), and at loom the REPO_ROOT roster's own genesis owner
    //     IS the private org. `terrene-foundation` (public) stays allowed.
    name: "scrubber-token-scoped",
    dir: "scrubber-token-scoped",
    // The slug must be one the REAL scrubber derives, and committing that literal
    // here would be the leak itself — so it is substituted from the imported list
    // into a temp copy at scan time.
    materialize: { __CANON_ORG__: FIXTURE_ORG },
    expectExit: 1,
    expectShapes: ["nonfoundation-org-slug", "operator-identity-token"],
    expectFindingCount: 12,
    // r4-v4 item 8: the 12 includes the operator-identity half of the private
    // literal, which fires only when the derived org is also a token of THIS
    // tree's roster (see IDENTITY_COHERENT) — the measurement was taken at loom,
    // where the roster's genesis owner IS the private org.
    needsCoherence: true,
    // The two person tokens share one line, so each finding's ±20-char context
    // window holds the OTHER token. Neither may appear in clear anywhere in the
    // output.
    expectNoRaw: ["canonop"],
  },
  {
    // F3/M2: the scanner's OWN source and its fixture corpus are scanned IDENTITY-ONLY,
    // not excluded. Two stand-ins at those paths each carry one roster token AND
    // synthetic structural shapes. Exactly 2 findings, both operator-identity-token:
    // restoring the old exclusion gives 0; dropping the identity-only restriction adds
    // the structural findings; either breaks the count lock.
    name: "identity-only-self-and-corpus",
    dir: "identity-only-self-and-corpus",
    expectExit: 1,
    expectShapes: ["operator-identity-token"],
    expectFindingCount: 2,
  },
  {
    // F3/M5: placeholder SENTINELS (the client-template roster's `placeholder-owner`,
    // `PLACEHOLDER-owner`, DEADBEEF fingerprint, all-zero root) are not identity. One
    // invented operator on the same roster proves the shape is live: exactly 1 finding.
    // Dropping the placeholder filter makes the sentinel lines flag too.
    name: "identity-placeholder-sentinel",
    dir: "identity-placeholder-sentinel",
    expectExit: 1,
    expectShapes: ["operator-identity-token"],
    expectFindingCount: 1,
  },
  {
    // F4: a 40-hex identity token (a roster/trust-root/git root commit, or a key
    // fingerprint) is also caught in its SHORT citation forms — any 7+-digit prefix and
    // the 16/8-digit key-ID suffixes — and, once 12+ digits long, a prefix glued inside a
    // longer hex run (the form a pasted measurement took at 9e5d6c1b7). NOT when it merely
    // shares a 7-digit prefix, nor for an 11-digit prefix mid-run (declared bounds).
    // Exactly 6: restoring the hex-delimited-only matcher drops the two mid-run lines.
    name: "identity-short-hash",
    dir: "identity-short-hash",
    expectExit: 1,
    expectShapes: ["operator-identity-token"],
    expectFindingCount: 6,
    // A mid-run span must be masked in full, not only its first 12 digits: the second
    // entry is the TAIL of the glued key prefix, past its first 12.
    expectNoRaw: ["a1b2c3d4e5f6", "69788796A5B4"],
  },
  // F2: a roster that is present but structurally empty makes the scan REFUSE to start
  // (exit 2), never read as clean. Measured before the fix: each of these exited 0 with
  // 0 findings, byte-identical to a clean scan.
  ...[
    ["roster-malformed-empty-object", /carries no non-empty persons\/operators collection/],
    ["roster-malformed-null", /carries no non-empty persons\/operators collection/],
    ["roster-malformed-persons-string", /carries no non-empty persons\/operators collection/],
    ["roster-malformed-wrong-key", /carries no non-empty persons\/operators collection/],
    ["roster-zero-tokens", /yields ZERO identity tokens/],
    // M1: PER PERSON. The genesis owner kept the old whole-roster count above zero, so an
    // array-form person with no harvestable field passed and their planted name read clean.
    // N3: the refusal names the fields the harvest ACTUALLY reads (PERSON_ID_FIELDS).
    ["roster-person-no-tokens", /person entry #0 \(0-based\) yields ZERO identity tokens — no map-key id, display_id \/ github_login \/ person_id \/ principal value/],
  ].map(([dir, expectOutput]) => ({
    name: dir,
    dir,
    expectExit: 2,
    expectShapes: [],
    expectOutput,
    // L3: a refusal names the roster by ROLE (<scan-root>/…), never by absolute path.
    expectNoAbsRoot: true,
  })),
  {
    // L1: a user-owned repo whose owner IS the person's login, and that login equals a slug
    // the real scrubber derives. A span equal to a PERSON-derived token is always a person
    // identity (and the scrubber-path tolerance is gone entirely, Tier-1 round 2): exactly
    // 1 operator-identity-token finding.
    name: "scrubber-person-equals-org",
    dir: "scrubber-person-equals-org",
    expectExit: 1,
    expectShapes: ["operator-identity-token"],
    expectFindingCount: 1,
  },
  {
    // L2: four flagged tokens from THREE shapes (2 org slugs, 1 runner label, 1 hostname) on one line. Each finding's context
    // window holds the others; none may print in clear.
    name: "context-mask-all-shapes",
    dir: "context-mask-all-shapes",
    expectExit: 1,
    expectShapes: ["nonfoundation-org-slug", "org-derived-runner-label", "operator-hostname"],
    expectFindingCount: 4,
    expectNoRaw: ["acme-corp", "globex-inc", "bob-linux", "Fakename"],
    // N4: four findings on ONE line print near-identical masked contexts; each must still
    // be locatable, so every finding carries a distinct path:line:COLUMN.
    expectDistinctLocations: true,
  },
  {
    // L4: a directory merely NAMED like the scanner's corpus (`scan-synced-disclosure-notes`)
    // is not the corpus and gets the full shape set: exactly 2.
    name: "identity-only-segment-lookalike",
    dir: "identity-only-segment-lookalike",
    expectExit: 1,
    expectShapes: ["nonfoundation-org-slug", "operator-home-path"],
    expectFindingCount: 2,
  },
  {
    // N2: the corpus is identity-only ONLY at its real location. The same directory names
    // nested deeper (`.claude/skills/zz/audit-fixtures/scan-synced-disclosure/sub/`), and a
    // file merely NAMED `scan-synced-disclosure.mjs` outside `.claude/bin/`, get the full
    // shape set: 2 findings each, exactly 4.
    name: "identity-only-deep-lookalike",
    dir: "identity-only-deep-lookalike",
    expectExit: 1,
    expectShapes: ["nonfoundation-org-slug", "operator-home-path"],
    expectFindingCount: 4,
  },
  {
    // Proves the Foundation + placeholder allowlist does NOT neuter genuine
    // detection: a non-own / 3rd-party org slug (acme-corp/loom) and a
    // different operator's home path MUST still flag even when allowlisted
    // coordinates appear on the same surface.
    name: "nonown-still-flagged",
    dir: "nonown-still-flagged",
    expectExit: 1,
    expectShapes: ["nonfoundation-org-slug", "operator-home-path"],
  },
  {
    // R2 must-fix #1 (issue #263): the nonfoundation-org-slug shape MUST
    // detect a non-own, non-Foundation org in ALL forms — SSH-clone,
    // `gh api orgs/`, bare `<org>/<repo>`, issue-ref `<org>/<repo>#N`,
    // `<org>/kailash-*`, `<org>/coc-*`. Exactly 6 synthetic findings;
    // the Foundation/own coordinates on the same surface MUST NOT flag
    // (asserted via expectFindingCount: 6).
    name: "r2-org-forms",
    dir: "r2-org-forms",
    expectExit: 1,
    expectShapes: ["nonfoundation-org-slug"],
    expectFindingCount: 6,
  },
  {
    // R2 must-fix #2 (issue #263): the Foundation registry-org /
    // `<sdk>-enterprise` allowlist entries are anchored — a typosquat that
    // merely PREFIXES an allowlisted org (`terrenefoundation-evil/loom`,
    // `gh api repos/terrenefoundation-evil/kailash-py`,
    // `nexus-enterprise-evil/loom`) MUST flag. Exactly 3 synthetic
    // findings; the EXACT Foundation org + EXACT public SDK compounds MUST
    // stay clean (asserted via expectFindingCount: 3).
    name: "r2-allowlist-anchor",
    dir: "r2-allowlist-anchor",
    expectExit: 1,
    expectShapes: ["nonfoundation-org-slug"],
    expectFindingCount: 3,
  },
  {
    // R2 must-fix #3 + #4 + R3 must-fix #A (issue #263): runner-label
    // arch suffixes (`arm64`/`aarch64`/`x86_64`) + lowercase
    // `<op>-mini` + real Mac products flag; the R3 single-uppercase
    // stem `X-MacBook-Pro` now ALSO flags (prior stem `[A-Z][a-z]+s?`
    // required ≥1 lowercase, so a 1-char/all-caps stem evaded all
    // three `-Mac` arms); `Proc-Macro` (rust proc-macro) MUST NOT
    // flag. expectFindingCount: 8 (was 7; +1 for the R3
    // `X-MacBook-Pro` single-uppercase-stem case) locks the
    // Proc-Macro negative — a 9th finding would be a `Proc-Macro`
    // false-positive regression.
    name: "r2-hostname-runner",
    dir: "r2-hostname-runner",
    expectExit: 1,
    expectShapes: ["org-derived-runner-label", "operator-hostname"],
    expectFindingCount: 8,
  },
  {
    // bsdtar's `--no-mac-metadata` flag is a public tool flag, not a host
    // name; its `no-mac` span is allowlisted. The synthetic hostname beside
    // it still flags, so the count is exactly 1: the flag contributes nothing.
    name: "bsdtar-flag-not-hostname",
    dir: "bsdtar-flag-not-hostname",
    expectExit: 1,
    expectShapes: ["operator-hostname"],
    expectFindingCount: 1,
  },
  {
    // R2 must-fix #5 (issue #263): the prior `isExcluded` journal
    // predicate over-excluded any synced file whose basename merely
    // STARTS with `journal` (`journaling-guide.md` → 0-scanned). The
    // fix scopes the exclusion to the `journal/` DIRECTORY only.
    // `rules/journaling-guide.md` (basename starts with `journal`) IS
    // now scanned and its synthetic leak flags (2 findings); the
    // genuine `journal/0001-note.md` directory file stays excluded —
    // expectFindingCount: 2 locks BOTH halves (over-exclusion gone AND
    // accepted-history journal/ exclusion intact).
    name: "r2-exclusion-scoping",
    dir: "r2-exclusion-scoping",
    expectExit: 1,
    expectShapes: ["operator-hostname", "operator-home-path"],
    expectFindingCount: 2,
  },
  {
    // R3 must-fix #B (issue #263): the prior scanner blanket-excluded
    // `variants/**` as never-synced — scope-evasion, since the
    // language overlays COMPOSE INTO the USE-template synced surface
    // at emit time. Fix: stop excluding `variants/` as never-synced;
    // `variants/rs/rules/leakrule.md` (committed overlay) carries a
    // synthetic leak that MUST be scanned + flagged (2 findings:
    // org-slug + runner-label).
    //
    // UPDATED for the `*.operator.local.md` #352 parity (loom Gate-1
    // ingest of the kailash-py re-convergence-#9 disclosure flag): the
    // `*.operator.local.md` suffix exclusion is now loom-source-only
    // (mirrors the `*.local.json` / `*.test.mjs` flips). This runner
    // scans at DESTINATION (`--root`), so the sibling
    // `ci-runners.operator.local.md` — a committed operator-local file
    // that shipped past the never-sync skip — IS now the disclosure
    // event and flags its 3 synthetic operator tokens (operator-hostname
    // + operator-home-path + operator-service-label). Total 5 findings:
    // 2 from leakrule.md + 3 from the operator-local companion. The
    // isolated destination-flip regression lock is
    // `operator-local-md-destination-flip` below. A count below 5 = the
    // #352 parity regressed (operator.local re-blinded, e.g. the generic
    // `*.local.md` catch-all re-swallowing the superset-suffix).
    name: "r3-variant-surface",
    dir: "r3-variant-surface",
    expectExit: 1,
    expectShapes: [
      "nonfoundation-org-slug",
      "org-derived-runner-label",
      "operator-hostname",
      "operator-home-path",
      "operator-service-label",
    ],
    expectFindingCount: 5,
  },
  {
    // `*.operator.local.md` #352 parity — now keyed on git-TRACKING status,
    // not the `REPO_ROOT_ACTIVE === REPO_ROOT` source/destination proxy. The
    // `isExcluded()` skip now fires ONLY for a file git confirms is UNTRACKED
    // (the gitignored per-operator companion); a TRACKED `*.operator.local.md`
    // is public-distributable and MUST be scanned (TRACKED WINS over the name
    // pattern). This committed fixture's `ci-runners.operator.local.md` is
    // TRACKED in loom's enclosing git tree, so `isGitTracked` returns true and
    // it is scanned — its synthetic `/Users/fakeuser/...` home-path MUST flag.
    // The isolated gitignored-vs-tracked distinction (a committed fixture can
    // only ever be TRACKED) is proven deterministically by the temp-git
    // scenario `runTrackingScenario()` below. If the skip ever regresses to
    // unconditional — or the generic `*.local.md` catch-all re-swallows the
    // `*.operator.local.md` superset-suffix — this case flips to exit 0.
    name: "operator-local-md-destination-flip",
    dir: "operator-local-md-destination-flip",
    expectExit: 1,
    expectShapes: ["operator-home-path"],
  },
  {
    // R3 must-fix #D (issue #263): the 4th-alt anti-flood
    // negative-lookbehind let a 3rd-party org ride a `/` after a
    // git-branch prefix or URL scheme past detection
    // (`chore/acme-corp/loom`, `postgres://acme-corp/loom`). CLOSED
    // by a 5th alternative requiring a closed-set branch prefix OR
    // `<scheme>://` immediately before `<org>/<repo-family>`, reusing
    // the SAME internal-dir / repo-family negative-lookahead so it
    // does NOT flood. `smuggle.md` plants 4 smuggle forms (MUST all
    // flag); `cleanlocks.md` plants 9 flood vectors — real branch
    // names, internal paths, public SDK URLs, DB strings, own-org
    // (MUST all stay clean). expectFindingCount: 4 locks BOTH halves
    // — the close fires AND does not flood. A 5th finding = the
    // close over-extended into a prose-path flood.
    name: "r3-smuggle-closed",
    dir: "r3-smuggle-closed",
    expectExit: 1,
    expectShapes: ["nonfoundation-org-slug"],
    // 4 -> 5 on 2026-09-15: the branch-prefix closed set gained `codify/`,
    // `lane/` and `wip/`, and the payload gained ONE MUST-flag line for the
    // `codify/` form. MEASURED as a delta rather than re-counted from scratch:
    // the suite RED at "finding count 5 (expected 4)" BEFORE this bump, which
    // is the proof the new case actually fires. The three lines added to the
    // clean-locks payload in the same change contributed ZERO findings — that
    // is the other half of the measurement, and it is what says the widening
    // did not flood.
    expectFindingCount: 5,
  },
  {
    // R4 single-HIGH (issue #263 Round-4): the R3-added `kailash-sdk`
    // allowlist entry was LEFT-UNANCHORED (only `\b`) — a genuine
    // 3rd-party `github.com/<org>/kailash-sdk` (or bare
    // `<org>/kailash-sdk`) org-slug span had its inner `kailash-sdk`
    // token match the WHOLE span via allowlistCovers(), SUPPRESSING the
    // `<org>` leak (false clean) — the R2 must-fix #2 failure class
    // reintroduced by the R3 broadener. Fix: position-aware entry —
    // `github.com[:/]kailash-sdk/<repo>` (Foundation Go ORG, first
    // segment) + bare-token form stay covered; `<org>/kailash-sdk`
    // (3rd-party REPO, last segment) is flagged. The fixture plants 2
    // synthetic 3rd-party forms (MUST flag) + 4 Foundation/Go-org/bare
    // forms (`go get github.com/kailash-sdk/kailash-go`,
    // `git@github.com:kailash-sdk/kailash-go.git`,
    // `terrene-foundation/kailash-sdk`, bare `kailash-sdk` — MUST stay
    // clean). expectFindingCount: 2 locks BOTH halves — the anchor
    // un-suppresses the 3rd-party leak AND the legit Foundation
    // Go-module install line is NOT newly-flagged. A 3rd finding = the
    // Foundation Go-org form regressed into a false-positive; a count
    // of 0/1 = the anchor failed to un-suppress the 3rd-party leak.
    name: "r4-sdk-allowlist-anchor",
    dir: "r4-sdk-allowlist-anchor",
    expectExit: 1,
    expectShapes: ["nonfoundation-org-slug"],
    expectFindingCount: 2,
  },
  {
    // R5 (issue-followup #336): `refs` git-namespace allowlist anchor.
    // Locks the `refs(?=/)` slash-anchored allowlisting in the
    // nonfoundation-org-slug SHAPE so that:
    //  (a) substrate ref names (`refs/coc/coordination-genN`,
    //      `refs/coc/archive-genN`, `refs/coc/**`, `refs/heads/main`,
    //      `refs/tags/v1.0`) stay CLEAN.
    //  (b) smuggle patterns where `refs-` prefixes a non-Foundation org
    //      slug (`refs-acme-corp/loom`, `chore/refs-customer-corp/coc-x`)
    //      STILL flag. Without the slash-anchor on `refs`, `refs\b` would
    //      match `refs` followed by `-` (a word boundary), suppressing
    //      legitimate smuggle detection.
    //  (c) bare third-party org slugs (`customer-acme/loom`) STILL flag
    //      as before — the `refs` allowlist doesn't touch the broader
    //      4th-alt behavior.
    // Expected findings: 4 (3 explicit FLAG cases + 1 in the explanatory
    // prose line 25 that contains a literal `refs-acme-corp/loom`).
    name: "r5-refs-allowlist",
    dir: "r5-refs-allowlist",
    expectExit: 1,
    expectShapes: ["nonfoundation-org-slug"],
    expectFindingCount: 4,
  },
  {
    // Issue #352 destination-mode `.local.json` scan-on (R1 security
    // LOW-S2): the `*.local.json` exclusion in `isExcluded()` now scopes
    // to `REPO_ROOT_ACTIVE === REPO_ROOT` (loom-source-scan only). When
    // `--root <dir>` points at a destination, committed `.local.json`
    // files ARE scanned because their presence at a sync destination IS
    // the disclosure event. The fixture plants a synthetic
    // `loom-links.local.json` carrying `/Users/fakeuser/fake-repos`
    // home-path shapes — these MUST flag at the destination scan. At
    // loom-source the same predicate path is excluded; the predicate's
    // destination-mode flip is what this fixture pins.
    name: "destination-local-json",
    dir: "destination-local-json",
    expectExit: 1,
    expectShapes: ["operator-home-path"],
  },
  {
    // 2026-07-01 bin/*.test.mjs disclosure-leak fix: the `*.test.mjs`
    // exclusion in `isExcluded()` scopes to `REPO_ROOT_ACTIVE === REPO_ROOT`
    // (loom-source-scan only), mirroring the `.local.json` flip above. loom's
    // own bin unit tests legitimately embed synthetic disclosure shapes; at
    // source they are skipped (and never-synced per `**/*.test.mjs`), but a
    // `*.test.mjs` that LEAKS to a consumer IS the disclosure event — so a
    // destination scan MUST flag it. The fixture plants a synthetic
    // `bin/sample.test.mjs` carrying a `/Users/fakeuser/...` home-path; it
    // MUST flag at the destination scan. If the skip ever becomes
    // unconditional, this case flips to exit 0 and the suite goes red.
    name: "test-mjs-destination-flip",
    dir: "test-mjs-destination-flip",
    expectExit: 1,
    expectShapes: ["operator-home-path"],
  },
  {
    // F77 good (#386): a synced .claude/settings.json with NO operator-PII
    // paths in permissions.allow/deny — every tool-call matcher uses a
    // relative or $CLAUDE_PROJECT_DIR-rooted path. The new
    // settings-permission-absolute-path SHAPE MUST NOT fire AND the
    // existing operator-home-path SHAPE MUST NOT fire (settings.json
    // is now in the walk surface per the F77 isNeverSynced narrowing).
    name: "f77-settings-good",
    dir: "f77-settings-good",
    expectExit: 0,
    expectShapes: [],
  },
  {
    // F77 bad (#386): a synced .claude/settings.json carrying SYNTHETIC
    // operator-PII paths inside permissions.allow tool-call matchers.
    // The fixture plants 3 Edit/Write/Read(/Users/fakeuser/...) entries
    // + 1 Bash(/home/fakebuilder/...) entry — 4 settings-permission-
    // absolute-path findings expected (one per matcher). The /Users/
    // and /home/ tokens additionally trigger the operator-home-path
    // shape, but the fixture's count lock is on the new shape only —
    // a count delta would surface a regression in either the new
    // shape's regex or the per-line tokenization (settings.json is
    // single-line-per-matcher JSON, so each matcher is its own line
    // for the line-by-line scanner).
    name: "f77-settings-bad",
    dir: "f77-settings-bad",
    expectExit: 1,
    expectShapes: ["settings-permission-absolute-path"],
  },
  {
    // F77 own-coords-still-flagged (#386): proves the new SHAPE skips
    // the allowlist. The `/Users/me/` placeholder home is allowlisted
    // for PROSE; the tool-call matcher form is intrinsically wrong
    // regardless of which path appears inside. The fixture plants 2
    // Edit/Read(/Users/me/...) matchers — both MUST flag as
    // settings-permission-absolute-path. The operator-home-path SHAPE
    // suppresses these via the `/Users/me/` allowlist entry, but the
    // new SHAPE's allowlist-skip carve-out fires here. A 0 finding count
    // = the allowlist-skip regressed; a 3rd finding = the skip leaked
    // into the operator-home-path SHAPE (which MUST continue honoring
    // the allowlist for prose). (Until 2026-09-25 the planted home was
    // the maintainer's own, allowlisted under the now-retired Option-1
    // own-coordinate ruling; the placeholder carries the same property.)
    name: "f77-settings-own-coords-still-flagged",
    dir: "f77-settings-own-coords-still-flagged",
    expectExit: 1,
    expectShapes: ["settings-permission-absolute-path"],
  },
  {
    // journal/0214 (loom#411): the customer-identity-token shape is driven
    // by a LOOM-ONLY tenant denylist (`.claude/disclosure-tenant-denylist.json`,
    // never synced) the scanner reads RELATIVE TO THE SCANNED ROOT. This
    // fixture proves the mechanism without committing a real customer token
    // to the (synced) fixture surface: the fixture provides its OWN denylist
    // with the SYNTHETIC token "Faketenant"; leaky.js names it in LOWERCASE
    // ("faketenant") and MUST flag (locks the case-insensitive `i` flag);
    // clean.md uses the generic "works-council / co-determination" terms and
    // MUST NOT flag (locks the deliberate non-tokenization of generic
    // vocabulary). expectFindingCount: 1 locks BOTH halves — a 2nd finding
    // = clean.md's generic terms regressed into a token; a 0 count = the
    // tenant-denylist read or the `i` flag regressed. The other fixtures
    // (no denylist file) implicitly lock the INERT-when-absent property:
    // customer-identity-token never appears in their expectShapes.
    name: "customer-identity-token",
    dir: "customer-identity-token",
    expectExit: 1,
    expectShapes: ["customer-identity-token"],
    expectFindingCount: 1,
  },
  {
    // GAP-C regression case (2026-08-16). Named for the finding it pins, per
    // `coc-artifact-eval-coverage.md` MUST-2: a /redteam finding against a COC
    // artifact lands a NAMED regression case, so the class fails loudly if a
    // future edit re-opens it.
    //
    // The class: a NON-PUBLIC sibling system named inside a DISTRIBUTED
    // rule-depth extract, together with its security-posture history. That
    // shipped to consumers undetected because the token was first suppressed by
    // a false positive-allowlist entry (GAP B) and then, after that entry was
    // removed, simply unmatched by any shape — an allowlist REMOVAL un-suppresses
    // but does not DETECT. This fixture locks the detector half.
    //
    // Bipolar by construction, and the poles are load-bearing in opposite
    // directions: `leaky-extract.md` names the synthetic system alongside a
    // fail-open→fail-closed history and MUST flag (efficacy); `clean-extract.md`
    // carries the SAME lesson genericized and MUST NOT flag (no-false-positive,
    // which is what stops a future "fix" from over-matching the generic
    // vocabulary the scrub is supposed to leave behind).
    //
    // expectFindingCount: 1 locks BOTH poles at once — 2 findings means the
    // genericized pole regressed into a token; 0 means the fixture-local
    // denylist read or the shape itself regressed. The token `Synthguard` is
    // SYNTHETIC and declared in this fixture's OWN denylist, so no real system
    // name is committed to this (synced) fixture surface.
    name: "gapc-guide-security-history",
    dir: "gapc-guide-security-history",
    expectExit: 1,
    expectShapes: ["customer-identity-token"],
    expectFindingCount: 1,
  },
  {
    // scenario-11 (sync-upflow Wave 2b todo 10): the consumer-owned half of the
    // sanctioned-local-preserve pair (`sync-preserve.local.yaml`) is never
    // synced — `isNeverSynced` skips it unconditionally, same class as
    // `settings.local.json`. The fixture plants an operator-home-path token
    // inside the skipped file; the scan MUST stay clean (the file is never
    // walked). A non-zero exit = the skip predicate regressed.
    name: "sync-preserve-local-skipped",
    dir: "sync-preserve-local-skipped",
    expectExit: 0,
    expectShapes: [],
  },
  {
    // #1324 SOURCE-ONLY GUARD: the `.claude/cross-repo-authz/` exclusion is
    // SOURCE-ONLY (isExcluded, `&& REPO_ROOT_ACTIVE === REPO_ROOT`, mirroring the
    // org-slug-bearing `ecosystem.json` entry): it self-excludes ONLY at the
    // loom-source self-scan (unblocking the operator's commit — #1324). Driven via
    // `--root` this is a DESTINATION scan (REPO_ROOT_ACTIVE !== REPO_ROOT), so the
    // guard does NOT fire and the receipt is SCANNED. The synthetic org is
    // `acme-enterprise` — chosen because it matches the `*-enterprise` alternative
    // of the nonfoundation-org-slug shape — so it flags → exit 1. Make the exclusion
    // UNCONDITIONAL and it flips 1 → 0: the destination scan goes blind (the R1
    // security MEDIUM this fixture guards). The loom-SOURCE self-exclusion (the
    // #1324 fix itself) is exercised by loom's own clean self-scan over its 100+
    // real receipts. COVERAGE BOUND: this proves the guard is source-only, NOT that
    // destination detection is complete — an arbitrary client `<org>/<repo>` whose
    // org matches no shape would NOT flag (the receipt payload has no dedicated
    // content shape); non-distribution is guaranteed by the THREE distribution
    // fences, not this scan. See the fixture receipt's COVERAGE BOUND note.
    name: "cross-repo-authz-guard-source-only",
    dir: "cross-repo-authz-guard-source-only",
    expectExit: 1,
    expectShapes: ["nonfoundation-org-slug"],
  },
  {
    // #1330 DESTINATION-COMPLETENESS: the source-only guard above proves a
    // leaked receipt is SCANNED at a destination, but the pre-#1330 scanner
    // only FLAGGED it when its target org matched ANOTHER shape (there
    // `acme-enterprise` → `*-enterprise`). An arbitrary client `<org>/<repo>`
    // (a plain `slug/slug` matching NO other shape) sailed through. The
    // `cross-repo-authz-receipt-payload` content shape closes that gap. This
    // fixture plants TWO receipts + a fork `ecosystem.json` (own orgs
    // `harbor-co`/`harborreg`):
    //  • `nimbus-labs/parts-store` (FOREIGN, repo NOT a repo-family, no
    //    `-enterprise`, no git context) → MUST flag, caught ONLY by the new
    //    shape (2 payload lines: `cross-repo-authorized:` + `**Target repo:**`).
    //  • `harbor-co/ledger-svc` (OWN org per ecosystem.json, repo NOT a
    //    repo-family) → MUST NOT flag: own-org-allowlisted by the new shape
    //    AND repo-family-silent for `nonfoundation-org-slug`.
    // The fork `ecosystem.json` contributes 2 `ecosystem-bare-org-slug`
    // findings (registry.org + remote_links.org bare slugs at a destination
    // scan — expected D6 behavior).
    //
    // #1330 L1 (frontmatter `target:` marker) adds two more receipts:
    //  • `2026-01-04-frontmatter-only-leak.md` — BODY markers genericized to
    //    metavariables (the partial-scrub evasion) but a CONCRETE FOREIGN
    //    frontmatter `target: vertex-systems/payments-core` (matches no other
    //    shape) → MUST flag via the `target:` marker ONLY (1 finding). Drop
    //    the `target:` alternative from the shape and this file goes silent.
    //  • `2026-01-05-frontmatter-own-suppressed.md` — frontmatter
    //    `target: harbor-co/settings-svc` (OWN org) → the L1 marker's own-org
    //    lookahead SUPPRESSES it → 0 findings.
    //
    // Findings: 2 (nimbus body) + 1 (vertex frontmatter) + 2 (ecosystem bare
    // slugs) + 0 (harbor-co body + both harbor-co own frontmatter/body) = 5.
    // expectFindingCount: 5 locks ALL directions non-vacuously: a 7th finding
    // = an own-org allowlist regression (harbor-co body OR frontmatter leaked
    // 2); a count of 4 = the L1 frontmatter marker regressed (vertex-systems
    // frontmatter went silent); a count below 4 = the foreign body detection
    // or the ecosystem-bare-org-slug shape regressed.
    name: "cross-repo-authz-arbitrary-org",
    dir: "cross-repo-authz-arbitrary-org",
    expectExit: 1,
    expectShapes: ["cross-repo-authz-receipt-payload", "ecosystem-bare-org-slug"],
    expectFindingCount: 5,
  },
  {
    // scenario-11 narrowness complement: the template-carried carrier
    // `sync-preserve.yaml` (NO `.local`) IS synced template→consumer and MUST
    // be scanned like any other synced artifact. The same operator-home-path
    // token MUST flag here. A 0-finding result = the `.local.yaml` skip
    // over-broadened to swallow the synced template-carried carrier.
    name: "sync-preserve-yaml-scanned",
    dir: "sync-preserve-yaml-scanned",
    expectExit: 1,
    expectShapes: ["operator-home-path"],
  },
  {
    // D6-1 (ECO-IMPL W1-S3): the nonfoundation-org-slug shape is BLIND to a
    // BARE JSON value (`"org": "acme-corp"` — no `/`, no repo-family, no git
    // context). The file-scoped ecosystem-bare-org-slug shape closes that
    // blindness for ecosystem* files ONLY. The fixture plants 2 bare slugs
    // (`"org": "acme-corp"` + `"host": "privatereg"` — MUST flag) alongside
    // synthetic `example-*` / `<org>` values + a dotted `docker.io` host (MUST
    // stay clean). expectFindingCount: 2 locks BOTH halves — the shape fires on
    // the real bare slug AND the allowlist/dot-host values do not flag. A 3rd
    // finding = the allowlist-skip regressed; a 0/1 count = the shape failed.
    name: "ecosystem-bare-org-slug",
    dir: "ecosystem-bare-org-slug",
    expectExit: 1,
    expectShapes: ["ecosystem-bare-org-slug"],
    expectFindingCount: 2,
  },
  {
    // D6-1 negative complement: the committed ecosystem.example.json carries
    // ONLY synthetic example-* / <org> placeholders + dotted public hosts. The
    // file-scoped shape APPLIES (basename matches) but produces ZERO findings —
    // proving it does not false-positive on the public-fork example vocabulary.
    name: "ecosystem-example-clean",
    dir: "ecosystem-example-clean",
    expectExit: 0,
    expectShapes: [],
  },
  {
    // PRIVATE-KEY MATERIAL — efficacy pole. `runIdentityTokenGate` (the literal
    // identity gate on the seeding/publish lanes) checks this class; THIS scanner,
    // which is what the Gate-2 distribution fence actually runs, did not. Measured
    // before the shape landed: a planted PEM exited 0 with zero findings, while a
    // control shape on the same synthetic tree exited 1 — so the pass was a true
    // negative, not a disarmed scan. The fixture body is an all-`A` synthetic block
    // invented here; it is not a key.
    //
    // expectFindingCount: 1 is load-bearing. The shape consumes to end of line, so a
    // multi-line PEM must produce exactly ONE finding (on its BEGIN marker) — a second
    // would mean the END marker or body was matching too, which would put key bytes in
    // the redacted context window.
    name: "private-key-material",
    dir: "private-key-material",
    // The marker is materialized, never committed: this corpus is scanned identity-only
    // WITH `private-key-material` at loom, so a committed marker would self-flag. Built by
    // concatenation so this file carries no marker line either.
    materialize: { __PEM_BEGIN__: "-----BEGIN RSA " + "PRIVATE KEY-----" },
    expectExit: 1,
    expectShapes: ["private-key-material"],
    expectFindingCount: 1,
  },
  {
    // PRIVATE-KEY MATERIAL — no-false-positive pole, and the shape's ONLY carve-out.
    // A marker followed immediately by `...` is the documentation-placeholder form.
    // Measured at loom root: exactly 2 such hits in synced `variants/py/skills/03-nexus/`
    // prose, so an uncarved shape would have refused the Gate-2 SOURCE fence on every
    // run. A valid PEM never has `...` adjacent to its BEGIN marker, so the carve-out
    // cannot hide a real key — the sibling case above is what proves that non-vacuously.
    name: "private-key-doc-placeholder",
    dir: "private-key-doc-placeholder",
    expectExit: 0,
    expectShapes: [],
  },
  {
    // JOURNAL-CITATION display_id (loom#1495 Class B) — efficacy pole. The journal
    // FILES do not distribute; the CITATIONS do, and the tier-aware sync lane copies
    // them verbatim, so a full-filename citation in a cascading artifact ships an
    // operator handle to every consumer. Measured before the shape landed: the same
    // four citations planted on the synced surface exited 0 with zero findings, while
    // a control shape on the SAME tree exited 1 — so the pass was a true negative and
    // not a disarmed scan.
    //
    // expectFindingCount: 4 is load-bearing on the third and fourth payload lines. The
    // third proves the shape does not require the citation to sit at a path root (a
    // `workspaces/<w>/journal/NNNN-` form flags identically). The fourth is `alicent`,
    // a NEAR-MISS of the `alice` member of SYNTHETIC_FIXTURE_USERS: the exemption is
    // anchored with a trailing hyphen, so a handle that merely BEGINS with a
    // placeholder name still flags. An unanchored exemption would silently swallow
    // that whole family — the same anchoring defect the r2-allowlist-anchor case locks
    // for org slugs.
    name: "journal-citation-display-id",
    dir: "journal-citation-display-id",
    expectExit: 1,
    expectShapes: ["journal-citation-display-id"],
    expectFindingCount: 4,
  },
  {
    // JOURNAL-CITATION display_id — no-false-positive pole. Three forms that carry no
    // operator handle MUST stay clean, and each is a distinct way the shape could have
    // over-matched:
    //   (a) the CONVENTION form `journal/NNNN` this issue's Class-B decision adopted —
    //       reddening it would price the fix itself as a violation;
    //   (b) the LEGACY display_id-less `journal/NNNN-TYPE-slug.md`, whose segment-2 is
    //       the ALL-CAPS TYPE. This is what the lowercase discriminator buys, and it is
    //       why the shape does NOT restate a `DECISION|DISCOVERY|…` list: the case
    //       covers `TRADE-OFF` — a TYPE carrying an internal hyphen — without the shape
    //       knowing any type name at all;
    //   (c) the TEACHING-PLACEHOLDER form whose display_id is a member of the shared
    //       SYNTHETIC_FIXTURE_USERS set, which is how the format is illustrated in
    //       `guides/rule-extracts/knowledge-convergence-examples.md` and
    //       `hooks/lib/journal-reserve.js`.
    // The sibling case above is what keeps this green non-vacuous.
    name: "journal-citation-number-only",
    dir: "journal-citation-number-only",
    expectExit: 0,
    expectShapes: [],
  },
];

// ── Fixture-INPUT inventory ──────────────────────────────────────────────
// Per-case count of the payload files the case's directory MUST contain
// (everything except README.md, recursively). Checked BEFORE the scanner is
// invoked for that case.
//
// WHY A COUNT, AND WHY BEFORE THE SCAN. This guards a measured incident: a
// commit deleted two fixture input payloads, the two affected cases scanned an
// emptied directory, found nothing, and reported CLEAN — and the suite's
// failure message blamed the SCANNER, which had not changed by a byte. The
// session then went looking for a detector regression that did not exist.
//
// A missing payload and a broken detector are indistinguishable from the
// scanner's output alone: both produce zero findings. So the discrimination
// has to happen upstream of the verdict, on the INPUT, and the two outcomes
// have to be reported in different words. `[FIXTURE INPUT MISSING]` is that
// word.
//
// It is an EQUALITY check, not a floor, and deliberately so: an ADDED payload
// is also a corpus change that silently shifts every `expectFindingCount` lock
// in that case. Either direction is a reviewed registry edit, not a drift.
//
// Counts MEASURED against this tree — they are not inherited from the origin
// repo, whose corpus is a subset of this one.
const EXPECTED_PAYLOADS = {
  "flag-each-shape": 1,
  "clean-foundation-placeholder": 1,
  "container-internal-home-allowlisted": 1,
  "excluded-accepted-history": 2,
  "own-identity-flagged": 2,
  "scrubber-token-scoped": 2,
  "identity-only-self-and-corpus": 3,
  "identity-placeholder-sentinel": 2,
  "identity-short-hash": 2,
  "roster-malformed-empty-object": 2,
  "roster-malformed-null": 2,
  "roster-malformed-persons-string": 2,
  "roster-malformed-wrong-key": 2,
  "roster-zero-tokens": 2,
  "roster-person-no-tokens": 2,
  "scrubber-person-equals-org": 2,
  "context-mask-all-shapes": 1,
  "identity-only-segment-lookalike": 1,
  "identity-only-deep-lookalike": 2,
  "nonown-still-flagged": 1,
  "r2-org-forms": 1,
  "r2-allowlist-anchor": 1,
  "r2-hostname-runner": 1,
  "bsdtar-flag-not-hostname": 1,
  "r2-exclusion-scoping": 2,
  "r3-variant-surface": 2,
  "operator-local-md-destination-flip": 1,
  "r3-smuggle-closed": 2,
  "r4-sdk-allowlist-anchor": 1,
  "r5-refs-allowlist": 1,
  "destination-local-json": 1,
  "test-mjs-destination-flip": 1,
  "f77-settings-good": 1,
  "f77-settings-bad": 1,
  "f77-settings-own-coords-still-flagged": 1,
  "customer-identity-token": 3,
  "gapc-guide-security-history": 3,
  "sync-preserve-local-skipped": 1,
  "cross-repo-authz-guard-source-only": 1,
  "cross-repo-authz-arbitrary-org": 5,
  "sync-preserve-yaml-scanned": 1,
  "ecosystem-bare-org-slug": 1,
  "ecosystem-example-clean": 1,
  "private-key-material": 1,
  "private-key-doc-placeholder": 1,
  "journal-citation-display-id": 1,
  "journal-citation-number-only": 1,
};

/** Recursively count payload files (everything but README.md) under a dir. */
function countPayloads(dir) {
  let n = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return -1; // the directory itself is gone
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const sub = countPayloads(path.join(dir, e.name));
      if (sub > 0) n += sub;
    } else if (e.name !== "README.md") {
      n++;
    }
  }
  return n;
}

// `extraArgs` exists for the ONE opt-in flag the scanner exposes
// (`--allow-synthetic-fixture-homes`). Default `[]`, so every pre-existing
// caller's invocation is byte-identical.
// `scannerPath` exists for the SOURCE pole only, which must run the MATERIALIZED
// COPY's scanner against the copy (see materializeSourceTree). Default `SCANNER`,
// so every pre-existing caller's invocation stays byte-identical.
function runScanner(root, extraArgs = [], scannerPath = SCANNER) {
  try {
    const out = execFileSync(
      "node",
      [scannerPath, "--check", "--root", root, ...extraArgs],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return { exit: 0, out };
  } catch (e) {
    return {
      exit: typeof e.status === "number" ? e.status : 99,
      out: (e.stdout || "") + (e.stderr || ""),
    };
  }
}

// ────────────────────────────────────────────────────────────────
// Temp-git scenario: git-TRACKING is the operator-local skip predicate.
// ────────────────────────────────────────────────────────────────
//
// A committed fixture under this directory is ALWAYS git-tracked in loom's
// enclosing tree, so it can only ever exercise the TRACKED→SCAN half. The
// GITIGNORED→SKIP half needs a file git reports as UNTRACKED, which cannot be
// a committed fixture. This scenario builds a throwaway git repo and plants
// BOTH polarities so the tracked-vs-gitignored distinction is proven
// deterministically, via genuine git-tracking status — NOT a path heuristic:
//   • a TRACKED `*.operator.local.md` (force-added despite matching the repo's
//     own `.gitignore` — TRACKED WINS over the name pattern) → MUST be scanned
//     → its synthetic leak MUST flag.
//   • a GITIGNORED, UNTRACKED `*.operator.local.md` → MUST be skipped → its
//     synthetic leak MUST NOT appear in findings.
function runTrackingScenario() {
  const problems = [];
  let tmp;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-disclosure-track-"));
    const rulesDir = path.join(tmp, ".claude", "rules");
    fs.mkdirSync(rulesDir, { recursive: true });
    // The repo gitignores every operator-local companion by name pattern.
    fs.writeFileSync(path.join(tmp, ".gitignore"), "*.operator.local.md\n");
    // Both carry a synthetic operator-home-path leak (SHAPE:operator-home-path).
    fs.writeFileSync(
      path.join(rulesDir, "tracked-companion.operator.local.md"),
      "runbook value: /Users/fakeuser/tracked-secret/repos\n",
    );
    fs.writeFileSync(
      path.join(rulesDir, "ignored-companion.operator.local.md"),
      "runbook value: /Users/fakeuser/ignored-secret/repos\n",
    );
    execFileSync("git", ["-C", tmp, "init", "-q"], { stdio: "ignore" });
    // Force-add the TRACKED companion despite the `.gitignore` pattern — this
    // is the exact "TRACKED WINS over the name pattern" case the fix asserts.
    execFileSync(
      "git",
      [
        "-C",
        tmp,
        "add",
        "-f",
        ".gitignore",
        ".claude/rules/tracked-companion.operator.local.md",
      ],
      { stdio: "ignore" },
    );
    execFileSync(
      "git",
      [
        "-c",
        "user.email=fixture@example.com",
        "-c",
        "user.name=fixture",
        "-C",
        tmp,
        "commit",
        "-qm",
        "init",
      ],
      { stdio: "ignore" },
    );
    // `ignored-companion.operator.local.md` is left UNTRACKED (gitignored).
    const { exit, out } = runScanner(tmp);
    if (exit !== 1) {
      problems.push(`exit ${exit} (expected 1 — tracked leak must flag)`);
    }
    if (!out.includes("tracked-companion.operator.local.md")) {
      problems.push(
        "tracked operator-local was NOT scanned (its leak is missing from findings)",
      );
    }
    if (out.includes("ignored-companion.operator.local.md")) {
      problems.push(
        "gitignored/untracked operator-local was scanned (it MUST be skipped)",
      );
    }
  } catch (e) {
    problems.push(`scenario error: ${e.message}`);
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
  return problems;
}

// ────────────────────────────────────────────────────────────────
// Temp-git scenario: GITIGNORED generated payload is not on the synced surface.
// ────────────────────────────────────────────────────────────────
//
// The GENERAL form of the scenario above. That one keys on a FILENAME pattern
// (`*.operator.local.md`); this one keys on nothing but git state, so it covers
// any generated payload whatever its name or location.
//
// Why the class matters: this scanner walks the FILESYSTEM, so it sees bytes no
// push can carry. MEASURED on this repo — 492 generated files under a gitignored
// path were reported as NOTHING by `git status --porcelain --untracked-files=all`
// while a shape-matching file among them still moved the scan 119 -> 120 and was
// NAMED in the refusal, sending a reader bisecting commits for a cause absent
// from the history.
//
// The skip is SOURCE-ONLY, so this scenario has to exercise BOTH roots. At a
// DESTINATION an ignored+untracked file is a leak that ALREADY ARRIVED, and the
// consumer's own `.gitignore` says nothing about whether loom leaked it — that half
// is `cross-repo-authz.test.mjs::SCAN-4`, and the destination pole below pins the
// same invariant from this side so the fence cannot be widened by editing one file.
//
// DESTINATION POLE (`--root <tmp>`): FOUR sub-poles, all planting the IDENTICAL
// synthetic leak so the ONLY variable is git state. Every one MUST be scanned here.
//   • TRACKED, ordinary path                              → SCANNED → MUST flag
//   • IGNORED + UNTRACKED generated file                  → SCANNED → MUST flag
//   • UNTRACKED but NOT ignored                           → SCANNED → MUST flag
//   • STAGED under an ignored dir (force-added ⇒ TRACKED) → SCANNED → MUST flag
//
// SOURCE POLE (`--root <materialized copy>`, below): the one place the skip applies.
// An ignored+untracked file planted under an already-ignored transient scratch path
// MUST NOT appear in findings, while a control proves the same bytes DO flag when the
// scanner can see them — otherwise a scanner that had simply stopped working would
// score as a pass.
//
// ── THE MATERIALIZED SOURCE TREE ────────────────────────────────────────────
//
// The source pole used to plant its control at
// `<repo>/.claude/zz-disclosure-fixture-<pid>-control/` and scan the LIVE root, so
// for a few hundred milliseconds the real checkout held a synthetic leak. That is
// not merely untidy: it REDS any concurrently-running gate that enumerates
// `.claude/` — `registration-preflight` reports the control as an UNDECLARED
// population while it exists — and that red is the gate being CORRECT, so it must
// not be "fixed" in the gate. In a shared worktree it also confounds every other
// agent's measurements. A materialized copy removes the window entirely.
//
// TWO CONSTRAINTS PIN THE DESIGN, both MEASURED against the copy this builds:
//
//   1. It must run the COPY's scanner against the COPY. The scanner decides
//      source-vs-destination from `REPO_ROOT_ACTIVE === REPO_ROOT`, and REPO_ROOT is
//      derived from the SCANNER'S OWN location — so this checkout's scanner with
//      `--root <copy>` is a DESTINATION scan, where the skip does NOT apply, and the
//      pole would red on a working scanner.
//   2. It must be a git work tree carrying an INDEX, because the skip predicate
//      calls `git -C <root> ls-files --error-unmatch`.
//
// MEASURED on the result: `ls-files --error-unmatch` rc=0 on a tracked path and rc=1
// on an untracked one; the probe answers ignored+untracked and the control
// not-ignored+untracked; and the COPY's scanner over the COPY reports
// `control FLAGGED=true | probe FLAGGED=false` — the discrimination the live root
// gave, with the live checkout never touched.
//
// OUTSIDE TEMP ROOTS is a REQUIREMENT, not a preference: a scan root under a trusted
// temp root is an unrelated, MEASURED failure mode in this repo, and a pole that
// greens or reds for a reason it is not about is worse than no pole. The scratch root
// is a SIBLING of the checkout, so it inherits that property; when the checkout
// itself resolves under a trusted temp root the sibling cannot satisfy it and this
// REFUSES loudly rather than running.
// ── SIBLING PLACEMENT (loom#D2) ─────────────────────────────────────────────
//
// The materialized tree is a SIBLING of the checkout. In a NESTED worktree — a checkout
// living inside another checkout — that sibling lands INSIDE the enclosing repo, which
// is the one thing the location exists to prevent: a full HEAD copy inside another
// repo's working tree, where that repo's gates and agents would see it.
//
// The discriminator is git's OWN answer about the parent, not a path heuristic:
// `git -C <parent> rev-parse --show-toplevel` exits 128 when the parent is outside
// every work tree and 0 when it is inside one. MEASURED: the primary's parent, the
// `.loom-wt` root and a scratch dir all return rc=128, while a checkout root returns
// rc=0 naming itself. Refuses rather than relocating — a fallback that silently picked
// a different parent would mint the tree somewhere nobody chose, which is the class
// this whole fixture was fixed for.
function assertSiblingParentOutsideWorkTree(parent) {
  let top;
  try {
    top = execFileSync("git", ["-C", parent, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    const stderr = String((e && e.stderr) || "");
    // ONLY "not a repository" means outside. Any other failure (no git, a broken
    // checkout, a permission error) leaves the question UNANSWERED, and an unanswered
    // containment question must refuse rather than pass by default.
    if (e && e.status === 128 && /not a git repository/i.test(stderr)) return;
    const unanswerable = new Error(
      `could not determine whether ${parent} is inside a git work tree, so the sibling ` +
        `scan tree cannot be placed safely: ${stderr.trim() || (e && e.message)}`,
    );
    unanswerable.reason = SIBLING_PARENT_UNVERIFIABLE;
    throw unanswerable;
  }
  const inside = new Error(
    `refusing to place the scan tree: its parent ${parent} is inside the git work tree ` +
      `${top}, so a full HEAD copy would be minted INSIDE that repo. Run this fixture ` +
      `from a checkout whose parent is outside every work tree.`,
  );
  inside.reason = SIBLING_PARENT_INSIDE_WORK_TREE;
  throw inside;
}

function materializeSourceTree() {
  const repoRoot = path.resolve(HERE, "..", "..", "..");
  try {
    assertCheckoutOutsideTrustedTemp(repoRoot, {
      suite: "scan-synced-disclosure/run.mjs (source pole)",
    });
  } catch (e) {
    if (e && e.reason === CHECKOUT_UNDER_TRUSTED_TEMP) cannotExecute(e);
    throw e;
  }
  const parent = path.dirname(repoRoot);
  // Both preconditions route through the SAME named outcome: each is a fact about where
  // the checkout sits, not about the scanner, and neither may read as a regression.
  try {
    assertSiblingParentOutsideWorkTree(parent);
  } catch (e) {
    if (e && (e.reason === SIBLING_PARENT_INSIDE_WORK_TREE || e.reason === SIBLING_PARENT_UNVERIFIABLE))
      cannotExecute(e);
    throw e;
  }
  const scratchRoot = path.join(parent, `.${path.basename(repoRoot)}-scan-fixture-${process.pid}`);
  const indexFile = `${scratchRoot}.index`;
  const git = (args, env) =>
    execFileSync("git", args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });

  fs.mkdirSync(scratchRoot, { recursive: true });
  try {
    // A PRIVATE index built from HEAD — never the live, mutable index.
    const env = { ...process.env, GIT_INDEX_FILE: indexFile };
    git(["-C", repoRoot, "read-tree", "HEAD"], env);
    git(["-C", repoRoot, `--work-tree=${scratchRoot}`, "checkout-index", "-a", "-f"], env);

    // The copy needs its OWN git dir: `isGitTracked` runs `git -C <copy> ls-files`,
    // and `ls-files` answers off the index. The live `info/exclude` is carried too,
    // because it governs what the skip predicate calls ignored — without it the walk
    // is NOT identical and the pole would be measuring a different tree.
    git(["-C", scratchRoot, "init", "-q"], process.env);
    fs.copyFileSync(indexFile, path.join(scratchRoot, ".git", "index"));
    const liveExclude = path.join(repoRoot, ".git", "info", "exclude");
    if (fs.existsSync(liveExclude)) {
      fs.copyFileSync(liveExclude, path.join(scratchRoot, ".git", "info", "exclude"));
    }
  } catch (e) {
    rmControlPath(scratchRoot, { recursive: true, force: true });
    fs.rmSync(indexFile, { force: true });
    throw new Error(`could not materialize the source tree for the source pole: ${e.message}`);
  }
  // ── OVERLAY THE WORKING-TREE SCANNER (loom#C2) ─────────────────────────────
  // `checkout-index` materialises HEAD, so without this the copy carries HEAD's scanner
  // and the source pole validates COMMITTED code while every other pole in this file
  // runs `SCANNER` — the working tree. An uncommitted scanner edit was therefore
  // unmeasured by that pole, which is a green about a file nobody was changing.
  //
  // The overlay is safe precisely BECAUSE the scanner derives `REPO_ROOT` from its own
  // LOCATION: the file moves, the location does not, so the copy still scans the copy.
  // That is the same coupling measured when this pole was first built, from the other
  // side.
  //
  // SCOPE, named rather than implied: only the scanner file is overlaid. Its two
  // in-tree imports (`./lib/strip-build-internal.mjs`, `./lib/fixture-corpus.mjs`) still
  // come from HEAD, so an uncommitted edit to THOSE is still unmeasured here.
  const workingScanner = SCANNER; // the working tree's copy — see the header's SCANNER derivation
  if (fs.existsSync(workingScanner)) {
    fs.copyFileSync(workingScanner, path.join(scratchRoot, ".claude", "bin", "scan-synced-disclosure.mjs"));
  }
  return {
    root: scratchRoot,
    // The COPY's scanner, so REPO_ROOT_ACTIVE === REPO_ROOT inside it — now carrying the
    // working tree's bytes.
    scanner: path.join(scratchRoot, ".claude", "bin", "scan-synced-disclosure.mjs"),
    cleanup() {
      rmControlPath(scratchRoot, { recursive: true, force: true });
      fs.rmSync(indexFile, { force: true });
    },
  };
}

function runGitignoredPayloadScenario() {
  const problems = [];
  let tmp;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-disclosure-ignored-"));
    const rulesDir = path.join(tmp, ".claude", "rules");
    const outDir = path.join(tmp, ".claude", "generated-out");
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    // A whole generated-output DIRECTORY is ignored — the real-world shape.
    fs.writeFileSync(path.join(tmp, ".gitignore"), ".claude/generated-out/\n");

    const leak = (who) => `runbook value: /Users/fakeuser/${who}-secret/repos\n`;
    fs.writeFileSync(path.join(rulesDir, "tracked-rule.md"), leak("tracked"));
    fs.writeFileSync(path.join(outDir, "ignored-payload.md"), leak("ignoredpayload"));
    fs.writeFileSync(path.join(outDir, "staged-payload.md"), leak("stagedpayload"));
    fs.writeFileSync(path.join(rulesDir, "untracked-rule.md"), leak("untrackedplain"));

    execFileSync("git", ["-C", tmp, "init", "-q"], { stdio: "ignore" });
    // `-f` on the payload under the ignored dir: it becomes TRACKED, so it MUST
    // stay scanned. `untracked-rule.md` is deliberately left out of the index.
    execFileSync(
      "git",
      ["-C", tmp, "add", "-f", ".gitignore", ".claude/rules/tracked-rule.md", ".claude/generated-out/staged-payload.md"],
      { stdio: "ignore" },
    );
    execFileSync(
      "git",
      ["-c", "user.email=fixture@example.com", "-c", "user.name=fixture", "-C", tmp, "commit", "-qm", "init"],
      { stdio: "ignore" },
    );

    // ── DESTINATION pole: every polarity MUST be scanned ──
    const { exit, out } = runScanner(tmp);
    if (exit !== 1) problems.push(`destination: exit ${exit} (expected 1 — the leaks must flag)`);
    for (const [file, why] of [
      ["tracked-rule.md", "tracked rule"],
      ["untracked-rule.md", "untracked-but-NOT-ignored file"],
      ["staged-payload.md", "force-added (TRACKED) payload under an ignored dir"],
      ["ignored-payload.md", "gitignored/untracked payload AT A DESTINATION"],
    ]) {
      if (!out.includes(file)) {
        problems.push(
          `destination: ${why} was NOT scanned — at a destination the skip MUST NOT apply; an ` +
            "ignored+untracked file there is a leak that already arrived (see SCAN-4)",
        );
      }
    }
  } catch (e) {
    problems.push(`scenario error: ${e.message}`);
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ── SOURCE pole: the skip applies ONLY here ──
  //
  // The probe dir carries its OWN `.gitignore` containing `*`, which ignores the
  // probe AND the `.gitignore` itself. That makes the pole SELF-CONTAINED: it needs
  // no edit to the repo's `.gitignore`, names no other feature's directory, and
  // leaves git seeing nothing at any point.
  //
  // The location is load-bearing and was chosen by MEASUREMENT, not convenience. An
  // earlier draft planted under `.claude/.scratch/`, which `isExcluded` drops
  // LEXICALLY (`pSegs[0] === ".scratch"`) before this filter is ever consulted — so
  // that pole passed whether or not the fix worked, and a mutation neutering the
  // filter left it GREEN. The discrimination control below is what caught that, and
  // it is why the control runs FIRST: a `0` here reads identically for "correctly
  // skipped", "lexically excluded" and "scanner silently broken".
  // PER-RUN UNIQUE paths, not fixed ones. The pole plants into the MATERIALIZED copy
  // (that is what makes it a SOURCE scan without touching the live checkout), and the
  // copy is per-PID, so two live runs cannot collide on it. PID-uniqueness is retained
  // inside the copy for the same reason it was introduced: the assertion must not be
  // satisfiable by a concurrent run having removed this run's files. OBSERVED, not
  // hypothesised — a concurrent runner deleted a probe at a fixed path during review,
  // and the "was it skipped?" assertion then passed because the file was GONE rather
  // than because the skip worked. The discrimination control cannot catch that, since
  // it is removed before the probe scan.
  const tag = `zz-disclosure-fixture-${process.pid}`;
  const sourceTree = materializeSourceTree();
  const REPO_ROOT = sourceTree.root;
  const probeDir = path.join(REPO_ROOT, ".claude", tag);
  const planted = path.join(probeDir, "probe.md");
  // The control sits in its OWN directory under `.claude/`, NOT in `.claude/rules/`.
  // MEASURED: a synthetic leak here still FLAGS at source (exit 1,
  // `[SHAPE:operator-home-path]`), so the control keeps every bit of its
  // discriminating power; and `check-rule-injection-budget.mjs` cannot see it,
  // because that checker reads exactly one directory — `RULES_DIR = ".claude/rules"`
  // (`.claude/bin/check-rule-injection-budget.mjs:172`).
  //
  // WHY THAT MATTERS, and it is not hygiene. While this file lived in
  // `.claude/rules/` it was an always-on rule with no `paths:`, so it charged all
  // 8 session profiles for as long as it existed. OBSERVED: a concurrent
  // `check-rule-injection-budget` run went RED with three failures — UNLEDGERED_RULE,
  // NEW_BROAD_LOAD, and a PROFILE_OVER_LEVEL breach naming a real profile and a
  // plausible 50 B of growth. Nothing in that output hinted at a fixture race, and
  // it does not reproduce on re-run: a fixture writing into the corpus another
  // instrument MEASURES produces the worst diagnostic shape there is.
  //
  // The materialized copy moots that hazard at the ROOT — the control now lands in a
  // scratch tree, so no live instrument can observe it at all. The placement is kept
  // as it stands rather than moved into `.claude/rules/`, because the pole's job is to
  // prove the scanner emits findings on a NON-ignored path, and that job is unchanged
  // by where the copy lives. The copy also discharges the concern CO-EXTENSIVELY: a
  // `check-rule-injection-budget` run racing this pole can no longer red, because
  // there is nothing to see.
  //
  // A `.gitignore` is NOT the alternative and would be actively harmful: the source
  // scan SKIPS gitignored+untracked files, so ignoring the control would make it
  // invisible to the scan it exists to control — a permanently-green control.
  // Relocation has no such inversion, because the skip predicate never applies to a
  // non-ignored path.
  const controlDir = path.join(REPO_ROOT, ".claude", `${tag}-control`);
  const control = path.join(controlDir, "control.md");
  const leakLine = "see /Users/fakeuser/source-pole-secret/repos for details\n";
  try {
    fs.mkdirSync(probeDir, { recursive: true });
    fs.writeFileSync(path.join(probeDir, ".gitignore"), "*\n");
    fs.writeFileSync(planted, leakLine);

    // DISCRIMINATION CONTROL, run FIRST: the SAME bytes at a NON-ignored path MUST
    // flag. Without it this pole cannot tell a working skip from a dead scanner.
    fs.mkdirSync(controlDir, { recursive: true });
    fs.writeFileSync(control, leakLine);
    const withControl = runScanner(REPO_ROOT, [], sourceTree.scanner);
    // Keys on the control's PATH (`<tag>-control/control.md`), not on a bare
    // `<tag>-control.md` filename — the relocation moved the tag into the DIRECTORY
    // name, so the old substring would never match again and this control would
    // report "did NOT flag" on a perfectly working scanner.
    // PID-MASK TOLERANCE (2026-10-03). The scanner masks identity spans IN THE
    // RENDERED PATH (`maskIdentitySpans`, `«REDACTED»`), and a pid of 7+ digits is a
    // 7+-hex run that rule masks. MEASURED on a host with pid 3357213: the control
    // DID flag, but printed as `zz-disclosure-fixture-«REDACTED»-control/control.md`,
    // so the literal-pid `.includes()` read it as "did NOT flag". Host-dependent by
    // construction: pids ≤ 6 digits (the usual macOS range) never mask. The
    // assertion's identity is the tag prefix plus the unique `-control/control.md`
    // suffix, never the raw digits — accept either rendering.
    const controlRendered = new RegExp(
      `zz-disclosure-fixture-(?:${process.pid}|«REDACTED»)-control/control\\.md`,
    );
    if (!controlRendered.test(withControl.out)) {
      problems.push(
        "source: the discrimination control did NOT flag, so this pole proves nothing — a " +
          "scanner that had stopped emitting findings entirely would satisfy the skip assertion. " +
          "Fix the control before trusting the assertion below",
      );
    }
    rmControlPath(controlDir, { recursive: true, force: true });

    const src = runScanner(REPO_ROOT, [], sourceTree.scanner);
    // Match the probe PATH, not the bare tag: the control's filename also carries the
    // tag, and keying on the tag alone would make this assertion depend on the
    // control having been removed first rather than on the skip working.
    // Same pid-mask tolerance as the control check above — a REGRESSED skip would
    // render this finding's path with the pid masked too, and a literal-pid
    // `.includes()` would then miss the very regression this assertion exists to catch.
    const probeRendered = new RegExp(
      `zz-disclosure-fixture-(?:${process.pid}|«REDACTED»)/probe\\.md`,
    );
    if (probeRendered.test(src.out)) {
      problems.push(
        "source: gitignored+untracked payload was SCANNED at loom-source — the distribution " +
          "engines cannot carry it (sync-tier-aware's filterSourceIgnored / git archive HEAD), " +
          "so flagging it refuses on bytes no push can carry",
      );
    }
  } catch (e) {
    problems.push(`source-pole error: ${e.message}`);
  } finally {
    rmControlPath(controlDir, { recursive: true, force: true });
    rmControlPath(probeDir, { recursive: true, force: true });
    // Last: the whole materialized tree, probe and control included. Its own
    // removal is fenced too (see rmControlPath) and the fence refuses a target
    // that resolves inside the repo — the mis-pointing direction.
    sourceTree.cleanup();
  }
  return problems;
}

// New walk roots (2026-10-03, disclosure-review finding d): `tests/` and `.github/` are
// BOTH published and were never walked. Each root now carries a PLANTED-VALUE CONTROL — a
// synthetic leak written under it in the materialized source tree MUST be found. A root
// added to TOP_LEVEL_SYNCED_DIRS without a control is a claim, not a measurement: if the
// walk silently fails to reach it (an exclusion, a bad relative path), the negative
// assertion alone would read identical to a working root.
function runNewWalkRootsScenario() {
  const problems = [];
  const leakLine = "see /Users/fakeuser/root-widening-secret/repos for details\n";
  const tag = `zz-walkroot-${process.pid}`;
  const tree = materializeSourceTree();
  try {
    for (const root of ["tests", ".github"]) {
      const dir = path.join(tree.root, root, tag);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "control.md"), leakLine);
    }
    const r = runScanner(tree.root, [], tree.scanner);
    for (const root of ["tests", ".github"]) {
      // Same pid-mask tolerance as the source pole: a 7+-digit pid is a 7+-hex run the
      // rendered path masks, so accept `<pid>` or `«REDACTED»` at the tag position.
      const rendered = new RegExp(`${root}/zz-walkroot-(?:${process.pid}|«REDACTED»)/control\\.md`);
      if (!rendered.test(r.out)) {
        problems.push(
          `no finding under the newly-walked ${root}/ root — the root is in ` +
            `TOP_LEVEL_SYNCED_DIRS but the walk never reaches it (or the finding was ` +
            `suppressed). Expected a [SHAPE:operator-home-path] finding for ${root}/<tag>/control.md`,
        );
      }
    }
    if (!/\[SHAPE:operator-home-path\]/.test(r.out)) {
      problems.push(
        "the planted leaks flagged with NO shape id — the control cannot say WHICH detector fired",
      );
    }
    if (r.exit === 0) {
      problems.push("the planted leaks produced exit 0 — findings were not counted");
    }
  } catch (e) {
    problems.push(`new-walk-roots error: ${e.message}`);
  } finally {
    // The planted dirs live INSIDE the materialized tree, so `tree.cleanup()` (which
    // goes through rmControlPath's SCAN_TREE arm and its outside-the-repo fence)
    // removes them with it. They deliberately do NOT go through rmControlPath
    // individually: that function's CONTROL_DIR arm accepts only
    // `zz-disclosure-fixture-<pid>-control` basenames, and MIS-MATCHING that fence is
    // precisely the refusal it is built to make — the first draft of this scenario
    // tripped it, which is the fence working.
    tree.cleanup();
  }
  return problems;
}

// tests/** convention-arm poles (2026-10-03, security review of the new arm). The arm is
// an ALLOWANCE inside a disclosure gate, so each of its axes gets a pole: the USERNAME
// axis (synthetic clears / real flags / traversal chain flags / spaced-Windows
// non-synthetic first word flags) and the PATH axis (a non-test file under tests/ takes
// no tolerance). The traversal and spaced-Windows poles exist because the arm's FIRST
// implementation re-extracted the username with `[\w.-]+` and suppressed prefixes
// (review HIGH); a pole that only plants `jdoe` would pass over that defect.
function runTestsTreeArmScenario() {
  const problems = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-disclosure-testsarm-"));
  try {
    const testsDir = path.join(tmp, "tests", "integration");
    fs.mkdirSync(testsDir, { recursive: true });
    const w = (rel, body) => fs.writeFileSync(path.join(tmp, rel), body);
    w("tests/integration/synthetic-home.test.js", 'const h = "/Users/jdoe/repos/app";\n');
    w("tests/integration/real-home.test.js", 'const h = "/Users/realcontributor/repos/app";\n');
    w("tests/integration/traversal.test.js", 'const h = "/Users/jdoe/../realcontributor/repos/app";\n');
    w("tests/integration/spaced-win.test.js", 'const h = "C:\\\\Users\\\\jdoe realcontributor\\\\repos\\\\app";\n');
    // Name-FORM poles (security review, 2026-10-03): the arm's username gate must
    // FLAG chains the shape's own name class covers but a naive re-extract misses —
    // an 8.3 short name, a non-ASCII name, and an apostrophe name. None is a set
    // member, so each must survive to a finding.
    w("tests/integration/win83.test.js", 'const h = "/Users/JDOEZQ~1/repos/app";\n');
    w("tests/integration/unicode.test.js", 'const h = "/Users/josé/repos/app";\n');
    w("tests/integration/apostrophe.test.js", "const h = \"/Users/o'brien/repos/app\";\n");
    w("tests/integration/non-test-payload.md", "see /Users/jdoe/repos/app\n");
    const r = runScanner(tmp);
    const named = (frag) => String(r.out || "").includes(frag);
    for (const [frag, want, why] of [
      ["synthetic-home.test.js", false, "a SYNTHETIC username in a tests/ suite must be tolerated"],
      ["real-home.test.js", true, "a REAL-looking username in a tests/ suite must FLAG"],
      ["traversal.test.js", true, "a traversal chain past a synthetic name must FLAG (the HIGH regression pole)"],
      ["spaced-win.test.js", true, "a spaced Windows chain whose first word is synthetic must FLAG"],
      ["win83.test.js", true, "an 8.3 short name (JDOEZQ~1) must FLAG — not a set member"],
      ["unicode.test.js", true, "a non-ASCII name (josé) must FLAG — not a set member"],
      ["apostrophe.test.js", true, "an apostrophe name (o'brien) must FLAG — not a set member"],
      ["non-test-payload.md", true, "a NON-test file under tests/ takes no tolerance"],
    ]) {
      if (named(frag) !== want) problems.push(`${frag}: ${want ? "did NOT flag" : "was flagged"} — ${why}`);
    }
    // IDENTITY, not just the file name: the red pole's line must carry the
    // operator-home-path FINDING ID, so a future change that flags the file via a
    // DIFFERENT shape (or a bare context line) cannot satisfy this case by accident.
    if (!/real-home\.test\.js:\d+:\d+\s+\[SHAPE:operator-home-path\]/.test(String(r.out || ""))) {
      problems.push(
        "the red pole's finding does not carry the operator-home-path FINDING ID " +
          "(name-only presence is not evidence the home-path shape fired)",
      );
    }
  } catch (e) {
    problems.push(`tests-tree-arm error: ${e.message}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return problems;
}

let failed = 0;
let inputsMissing = 0;
for (const c of CASES) {
  const root = path.join(HERE, c.dir);

  // Precondition: the case's own INPUT must be present before any verdict is
  // read off the scanner. A missing payload is a fixture-corpus defect, not a
  // detector regression, and must never be reported as one.
  const expectedPayloads = EXPECTED_PAYLOADS[c.name];
  if (typeof expectedPayloads !== "number") {
    failed++;
    console.log(`FAIL  ${c.name}`);
    console.log(
      `        - no EXPECTED_PAYLOADS entry — every case must declare its input inventory`,
    );
    continue;
  }
  const actualPayloads = countPayloads(root);
  if (actualPayloads !== expectedPayloads) {
    failed++;
    inputsMissing++;
    console.log(`FAIL  ${c.name}  [FIXTURE INPUT MISSING]`);
    console.log(
      `        - payload files: ${actualPayloads === -1 ? "directory absent" : actualPayloads} ` +
        `(expected ${expectedPayloads})`,
    );
    console.log(
      `        - this is a MISSING-INPUT defect, NOT a scanner regression: the ` +
        `scanner cannot flag what it was never given. Restore the payload ` +
        `(git log --diff-filter=D -- ${path.posix.join(".claude/audit-fixtures/scan-synced-disclosure", c.dir)}) ` +
        `before drawing any conclusion about the detector.`,
    );
    continue;
  }

  // r4-v4 item 8: a count-locked case whose expectation includes the
  // operator-identity half of the derived private literal cannot run where the
  // tree's config and roster describe different identities — its subject does
  // not exist there. NAMED skip, never a failure and never a pass.
  if (c.needsCoherence && !IDENTITY_COHERENT) {
    console.log(`SKIP  ${c.name}  (${NOT_COHERENT_SKIP})`);
    continue;
  }

  let scanRoot = root;
  if (c.materialize) {
    scanRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scan-disclosure-materialize-"));
    const copy = (src, dst) => {
      for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        const a = path.join(src, e.name);
        const b = path.join(dst, e.name);
        if (e.isDirectory()) {
          fs.mkdirSync(b, { recursive: true });
          copy(a, b);
        } else {
          let t = fs.readFileSync(a, "utf8");
          for (const [k, v] of Object.entries(c.materialize)) t = t.split(k).join(v);
          fs.writeFileSync(b, t);
        }
      }
    };
    copy(root, scanRoot);
  }
  const { exit, out } = runScanner(scanRoot);
  if (c.materialize) fs.rmSync(scanRoot, { recursive: true, force: true });
  const findingMatches = [...out.matchAll(/\[SHAPE:([a-z-]+)\]/g)];
  const shapesSeen = new Set(findingMatches.map((m) => m[1]));
  const findingCount = findingMatches.length;

  const problems = [];
  if (c.expectDistinctLocations) {
    const locs = [...out.matchAll(/^\s*(\S+:\d+:\d+)\s+\[SHAPE:/gm)].map((m) => m[1]);
    if (locs.length !== findingCount || new Set(locs).size !== locs.length) {
      problems.push(`finding locations not distinct path:line:col (${locs.length} located, ${new Set(locs).size} distinct, ${findingCount} findings)`);
    }
  }
  for (const raw of c.expectNoRaw || []) {
    if (out.toLowerCase().includes(raw.toLowerCase())) {
      problems.push(`output prints identity token '${raw}' in clear — findings must redact every flagged span`);
    }
  }
  if (c.expectNoAbsRoot && (out.includes(scanRoot) || out.includes(path.resolve(HERE, "..", "..", "..")))) {
    problems.push("output prints an ABSOLUTE root path — the /Users/<operator>/ class this scanner flags");
  }
  if (c.expectOutput && !c.expectOutput.test(out)) {
    problems.push(`output does not match ${c.expectOutput} — the refusal must NAME its cause`);
  }
  if (exit !== c.expectExit) {
    problems.push(`exit ${exit} (expected ${c.expectExit})`);
  }
  for (const s of c.expectShapes) {
    if (!shapesSeen.has(s)) problems.push(`missing expected SHAPE:${s}`);
  }
  if (c.expectShapes.length === 0 && shapesSeen.size > 0) {
    problems.push(`unexpected findings: ${[...shapesSeen].join(", ")}`);
  }
  // Exact finding-count lock — a count delta is a false-positive (extra
  // finding, e.g. Proc-Macro) or false-negative (missing form)
  // regression even when the shape-set still matches.
  if (
    typeof c.expectFindingCount === "number" &&
    findingCount !== c.expectFindingCount
  ) {
    problems.push(
      `finding count ${findingCount} (expected ${c.expectFindingCount}) — ` +
        `a delta is a false-positive or false-negative regression`,
    );
  }

  if (problems.length) {
    failed++;
    console.log(`FAIL  ${c.name}`);
    for (const p of problems) console.log(`        - ${p}`);
  } else {
    console.log(
      `PASS  ${c.name}  (exit ${exit}` +
        (c.expectShapes.length
          ? `, shapes: ${[...shapesSeen].sort().join(", ")}`
          : ", clean") +
        ")",
    );
  }
}

// F2 inert-notice scenario: with NO roster reachable at any root, the operator-identity
// shape cannot run, and the scanner must SAY so rather than return a silent clean. The
// scanner is copied (with its three local imports, plus lib/entry-point.mjs, which
// strip-build-internal.mjs imports in turn) into a temp tree that has no roster,
// so REPO_ROOT — the second root it unions — has none either.
{
  const problems = [];
  let tmp;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-disclosure-inert-"));
    const src = path.resolve(HERE, "..", "..");
    for (const rel of [
      "bin/scan-synced-disclosure.mjs",
      "bin/lib/identity-scrub.mjs",
      "bin/lib/fixture-corpus.mjs",
      "bin/lib/strip-build-internal.mjs",
      "bin/lib/entry-point.mjs",
      "hooks/lib/git-subprocess-env.js",
    ]) {
      const dst = path.join(tmp, ".claude", rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(src, rel), dst);
    }
    fs.mkdirSync(path.join(tmp, ".claude", "rules"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".claude", "rules", "neutral.md"), "# neutral\n");
    const r = spawnSync("node", [path.join(tmp, ".claude", "bin", "scan-synced-disclosure.mjs"), "--check"], {
      encoding: "utf8",
    });
    if (r.status !== 0) problems.push(`exit ${r.status} (expected 0 — no roster is not a refusal)`);
    if (!/operator-identity shape INERT/.test(r.stderr || "")) {
      problems.push("no INERT notice on stderr — an unchecked class read as a clean scan");
    }
    if ((r.stderr || "").includes(tmp)) {
      problems.push("INERT notice prints the ABSOLUTE root path — the /Users/<operator>/ class");
    }
  } catch (e) {
    problems.push(`scenario error: ${e.message}`);
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (problems.length) {
    failed++;
    console.log("FAIL  identity-shape-inert-notice-when-no-roster");
    for (const p of problems) console.log(`        - ${p}`);
  } else {
    console.log("PASS  identity-shape-inert-notice-when-no-roster  (exit 0 + loud INERT line on stderr)");
  }
}

// item 6 (Tier-1 round 2, cc-architect): a CORRUPT `.claude/VERSION` must THROW,
// never read as "not loom". CORRECTED (security read): the class marker no
// longer decides whether the private-armed rows RUN or SKIP, and neither does it
// arm any distribution entrypoint — those arm on the CONFIG (the arm-by-config
// ruling); what reads the class at all is the workspace-name derivation inside
// this module. The corrupt-marker refusal still matters for THOSE readers, so a
// corrupt marker must never be silently read as "not loom". MEASURED shape: the
// throw lands AT IMPORT — the module derives the workspace set (which reads the
// class) at load — so the assertion accepts EITHER an import-time throw (rc=3,
// message on stderr) or a call-time throw; what it forbids is a RETURNED verdict.
{
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "strip-version-"));
    fs.mkdirSync(path.join(dir, ".claude", "bin", "lib"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".claude", "VERSION"), "{ not json");
    fs.cpSync(path.resolve(HERE, "..", "..", "bin", "lib"), path.join(dir, ".claude", "bin", "lib"), { recursive: true });
    const r = spawnSync(
      "node",
      [
        "-e",
        `import(${JSON.stringify(path.join(dir, ".claude", "bin", "lib", "strip-build-internal.mjs"))}).then((m) => {` +
          `  try { console.log("RETURNED " + m.isLoomSourceTree()); }` +
          `  catch (e) { console.log("THREW " + e.message); }` +
          `}).catch((e) => { console.error("IMPORT THREW " + e.message); process.exit(3); });`,
      ],
      { encoding: "utf8" },
    );
    const out = (r.stdout || "") + (r.stderr || "");
    const threwAtImport = r.status === 3 && /IMPORT THREW .*unparseable/.test(out);
    const threwOnCall = /THREW .*unparseable/.test(out);
    if (/RETURNED/.test(out) || !(threwAtImport || threwOnCall)) {
      failed++;
      console.log("FAIL  corrupt-version-throws");
      console.log(`        - expected a throw naming unparseable (import- or call-time), got rc=${r.status} out=${out.slice(0, 160)}`);
    } else {
      console.log("PASS  corrupt-version-throws  (a corrupt class marker is NOT \"not loom\" — refused at " + (threwAtImport ? "import" : "call") + " time)");
    }
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// H1 delivered-tree scenario: the scanner a CONSUMER receives, run in place on the tree it
// arrived in, must be clean. That tree carries the scrubber (`always_include`) but neither
// the roster nor `bin/ecosystem.json`, which is exactly what a roster-keyed tolerance got
// wrong (measured: rc=1, 10 findings in strip-build-internal.mjs, halting /codify Step 7c
// and /migrate at every consumer). Built by the REAL distribution engine, never by hand.
// The engine is loom-only, so where it is absent this scenario says SKIPPED — it cannot run
// there, and it never reports a pass it did not measure.
{
  const problems = [];
  const engine = path.resolve(HERE, "..", "..", "bin", "sync-tier-aware.mjs");
  if (!fs.existsSync(engine)) {
    console.log("SKIP  delivered-tree-scanner-clean-in-place  (sync-tier-aware.mjs absent — loom-only engine; NOT RUN, not a pass)");
  } else if (!CONFIG_ARMED) {
    // r4-v4 (correctness item 8): the engine's private-slug gate is ARMED BY
    // CONFIG and REFUSES to distribute a tree whose gate would be vacuous
    // (measured in the fork-shaped tree: `delivery failed rc=2: … the PRIVATE
    // org-slug set is EMPTY at distribution time`). That refusal is the engine
    // working as designed, not a scanner verdict — a tree with no declaration
    // cannot mint the delivered tree this scenario exists to judge, so it
    // reports a NAMED skip rather than a failure it never measured.
    console.log(`SKIP  delivered-tree-scanner-clean-in-place  (${NO_CONFIG_SKIP})`);
  } else {
    let tmp;
    try {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-disclosure-delivered-"));
      const d = spawnSync(
        "node",
        [engine, "--target", "py", "--template", "kailash-coc-claude-py", "--out", tmp],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      );
      if (d.status !== 0) problems.push(`delivery failed rc=${d.status}: ${(d.stderr || "").slice(0, 300)}`);
      const delivered = path.join(tmp, ".claude", "bin", "scan-synced-disclosure.mjs");
      if (!fs.existsSync(delivered)) problems.push("delivered tree carries no scanner");
      if (!fs.existsSync(path.join(tmp, ".claude", "bin", "lib", "strip-build-internal.mjs"))) {
        problems.push("delivered tree carries no scrubber — the case would be vacuous");
      }
      if (fs.existsSync(path.join(tmp, ".claude", "operators.roster.json"))) {
        problems.push("delivered tree carries a roster — the case no longer models a consumer");
      }
      if (!problems.length) {
        const r = spawnSync("node", [delivered, "--check"], { encoding: "utf8", cwd: tmp });
        const n = ((r.stdout || "") + (r.stderr || "")).match(/\[SHAPE:/g)?.length ?? 0;
        if (r.status !== 0 || n !== 0) {
          problems.push(`delivered scanner in place: rc=${r.status}, ${n} finding(s) (expected 0 and 0)`);
        }
        if (!/Scanned: \d+ files/.test(r.stdout || "")) problems.push("no scan receipt — the scan did not run");
      }
    } catch (e) {
      problems.push(`scenario error: ${e.message}`);
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    }
    if (problems.length) {
      failed++;
      console.log("FAIL  delivered-tree-scanner-clean-in-place");
      for (const p of problems) console.log(`        - ${p}`);
    } else {
      console.log("PASS  delivered-tree-scanner-clean-in-place  (real --target py delivery, no roster; delivered scanner rc=0, 0 findings)");
    }
  }
}

// Shared: copy the scanner and its sibling libraries into `<dst>/.claude/`, so a scan run
// there is IN PLACE (REPO_ROOT === scan root) — the mode a consumer's /codify and /migrate use.
function copyScannerInto(dst) {
  const src = path.resolve(HERE, "..", "..");
  for (const rel of [
    "bin/scan-synced-disclosure.mjs",
    "bin/lib/identity-scrub.mjs",
    "bin/lib/fixture-corpus.mjs",
    "bin/lib/strip-build-internal.mjs",
    "bin/lib/entry-point.mjs",
    "hooks/lib/git-subprocess-env.js",
  ]) {
    const d = path.join(dst, ".claude", rel);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(path.join(src, rel), d);
  }
  return path.join(dst, ".claude", "bin", "scan-synced-disclosure.mjs");
}

// N1: a COMMITTED `*.local.json` at a consumer ships to that consumer's clones and MUST be
// scanned in place; an UNTRACKED one (the gitignored per-operator companion) is still skipped.
// Before the fix the root-identity proxy skipped both in place (rc=0), while Gate 2 from
// loom flagged the tracked one — the same bytes, two verdicts.
{
  const problems = [];
  let tmp;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-disclosure-localjson-"));
    const bin = copyScannerInto(tmp);
    fs.writeFileSync(
      path.join(tmp, ".claude", "bin", "repo-links.local.json"),
      '{"loom":{"path":"/Users/realoperator/repos/loom"}}\n',
    );
    fs.writeFileSync(
      path.join(tmp, ".claude", "bin", "scratch.local.json"),
      '{"loom":{"path":"/Users/otheroperator/repos/loom"}}\n',
    );
    execFileSync("git", ["-C", tmp, "init", "-q"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmp, "add", ".claude/bin/repo-links.local.json"], { stdio: "ignore" });
    const r = spawnSync("node", [bin, "--check"], { encoding: "utf8", cwd: tmp });
    const out = (r.stdout || "") + (r.stderr || "");
    const hits = [...out.matchAll(/^\s*(\S+?):\d+:\d+\s+\[SHAPE:([a-z-]+)\]/gm)].map((m) => `${m[1]} ${m[2]}`);
    if (r.status !== 1) problems.push(`exit ${r.status} (expected 1 — the tracked file carries a real home path)`);
    if (!hits.includes(".claude/bin/repo-links.local.json operator-home-path")) {
      problems.push("the TRACKED *.local.json was not flagged in place");
    }
    if (hits.some((h) => h.startsWith(".claude/bin/scratch.local.json"))) {
      problems.push("the UNTRACKED *.local.json was scanned — the gitignored companion must stay skipped");
    }
  } catch (e) {
    problems.push(`scenario error: ${e.message}`);
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (problems.length) {
    failed++;
    console.log("FAIL  local-json-tracked-flagged-untracked-skipped-in-place");
    for (const p of problems) console.log(`        - ${p}`);
  } else {
    console.log("PASS  local-json-tracked-flagged-untracked-skipped-in-place  (tracked → operator-home-path, untracked → skipped, rc=1)");
  }
}

// N4: no absolute path in report mode or in the --root refusal.
{
  const problems = [];
  const fixture = path.join(HERE, "flag-each-shape");
  const rep = spawnSync("node", [SCANNER, "--root", fixture], { encoding: "utf8" });
  const repOut = (rep.stdout || "") + (rep.stderr || "");
  if (!/^Root:\s+<scan-root>$/m.test(repOut)) problems.push("report mode does not print Root: <scan-root>");
  if (repOut.includes(fixture) || repOut.includes(os.homedir())) problems.push("report mode prints an ABSOLUTE path");
  // A path that cannot exist: a fresh private dir's child that is never created (a pid-named tmp
  // path is not collision-free — audit-fixture-tempdir-uniqueness).
  const missingParent = fs.mkdtempSync(path.join(os.tmpdir(), "scan-disclosure-"));
  const missing = path.join(missingParent, "no-such-root");
  const bad = spawnSync("node", [SCANNER, "--check", "--root", missing], { encoding: "utf8" });
  const badOut = (bad.stdout || "") + (bad.stderr || "");
  if (bad.status !== 2) problems.push(`missing --root exited ${bad.status} (expected 2)`);
  if (badOut.includes(missing)) problems.push("the --root refusal echoes the ABSOLUTE path");
  fs.rmSync(missingParent, { recursive: true, force: true });
  if (problems.length) {
    failed++;
    console.log("FAIL  report-and-refusal-print-no-absolute-path");
    for (const p of problems) console.log(`        - ${p}`);
  } else {
    console.log("PASS  report-and-refusal-print-no-absolute-path  (Root: <scan-root>; --root refusal exit 2 without the path)");
  }
}

// git-tracking scenario (temp repo; tracked→scan + gitignored→skip polarities).
{
  const problems = runTrackingScenario();
  if (problems.length) {
    failed++;
    console.log(`FAIL  operator-local-git-tracking-scenario`);
    for (const p of problems) console.log(`        - ${p}`);
  } else {
    console.log(
      `PASS  operator-local-git-tracking-scenario  ` +
        `(tracked→scanned+flagged, gitignored/untracked→skipped)`,
    );
  }
}

// Only COMMITTED ignore rules may shrink the scan.
//
// `.git/info/exclude` is per-clone, never committed, covered by no review, and
// writable by any process running as the operator — including an agent. If it could
// shrink this gate, one unreviewed line would silently narrow a disclosure scan with
// nothing in the tree to show for it. Its sibling, the global `core.excludesFile`,
// is already fenced by `gitEnv()` (GIT_CONFIG_GLOBAL=/dev/null).
//
// This is a SOURCE-SHAPE guard, not a behavioural one, and the reason is worth
// stating so nobody "upgrades" it into a vacuous test: the filter runs ONLY when the
// scan root IS the repo root, so exercising it behaviourally would mean writing to
// the live clone's `.git/info/exclude` — shared mutable state, the exact race this
// file was just fixed for. The MEASURED behaviour backing it: under
// `--exclude-standard` a file named only in `.git/info/exclude` enters the drop set
// and goes unscanned; under `--exclude-per-directory=.gitignore` it does not.
// Same shape as the porcelain re-regression guard in sync-gate2-worktree.test.mjs.
{
  const problems = [];
  const scannerSrc = fs.readFileSync(SCANNER, "utf8");
  // Match the ARGV STRING-LITERAL form, not a bare token. A bare token over-matches
  // the prose that EXPLAINS the choice — measured: the first draft of this guard red
  // on the scanner's own comment, which is a lexical false positive, not a finding.
  const GOOD = /["']--exclude-per-directory=\.gitignore["']/;
  const BANNED = /["']--exclude-standard["']/;
  if (!GOOD.test(scannerSrc)) {
    problems.push(
      "the ignore surface is no longer pinned to committed .gitignore files — an uncommitted, " +
        "unreviewable, agent-writable .git/info/exclude can now silently shrink this scan",
    );
  }
  if (BANNED.test(scannerSrc)) {
    problems.push(
      "the exclude-standard flag is back in argv: it honours .git/info/exclude and the global " +
        "core.excludesFile, so unreviewed per-clone state can narrow a disclosure gate",
    );
  }
  // Positive controls: each matcher must be shown able to fire, or its silence is
  // not evidence. Both are exercised against a known-answer string.
  if (!BANNED.test('git("ls-files", "--exclude-standard")')) {
    problems.push("the banned-flag matcher cannot fire, so its silence is not evidence");
  }
  if (BANNED.test("prose mentioning --exclude-standard in backticks")) {
    problems.push("the banned-flag matcher over-matches prose, so it would red on a comment");
  }
  if (problems.length) {
    failed++;
    console.log(`FAIL  only-committed-ignore-rules-shrink-the-scan`);
    for (const p of problems) console.log(`        - ${p}`);
  } else {
    console.log(
      `PASS  only-committed-ignore-rules-shrink-the-scan  ` +
        `(--exclude-per-directory=.gitignore pinned; --exclude-standard absent; matcher fires)`,
    );
  }
}

// gitignored generated payload scenario (temp repo; four git-state polarities).
{
  const problems = runGitignoredPayloadScenario();
  if (problems.length) {
    failed++;
    console.log(`FAIL  gitignored-payload-not-on-synced-surface`);
    for (const p of problems) console.log(`        - ${p}`);
  } else {
    console.log(
      `PASS  gitignored-payload-not-on-synced-surface  ` +
        `(destination: all four polarities scanned; source: ignored+untracked skipped, control flagged)`,
    );
  }
}

// new-walk-roots planted controls (2026-10-03, disclosure-review finding d).
{
  const problems = runNewWalkRootsScenario();
  if (problems.length) {
    failed++;
    console.log(`FAIL  new-walk-roots-planted-controls`);
    for (const p of problems) console.log(`        - ${p}`);
  } else {
    console.log(
      `PASS  new-walk-roots-planted-controls  ` +
        `(a planted leak under tests/ AND under .github/ is found by the widened walk)`,
    );
  }
}

// tests/** convention-arm poles (security review of the arm, 2026-10-03).
{
  const problems = runTestsTreeArmScenario();
  if (problems.length) {
    failed++;
    console.log(`FAIL  tests-tree-username-gate-bypass-poles`);
    for (const p of problems) console.log(`        - ${p}`);
  } else {
    console.log(
      `PASS  tests-tree-username-gate-bypass-poles  ` +
        `(synthetic clears; real, traversal-chain, spaced-Windows and non-test-path all FLAG)`,
    );
  }
}

// ── Named regression cases (case name = finding id, per
//    `coc-artifact-eval-coverage.md` MUST-2) ────────────────────────────────
//
// These do not need a fixture TREE — they assert properties of the scanner's
// own run-shape, which is why they live here rather than as sibling dirs.
{
  // `os`, `fs`, `path` are imported at module top.
  const named = [];
  const add = (id, fn) => named.push({ id, fn });

  // RS-16 / GAP B — the allowlist entry annotated "public PACT product" was
  // FALSE (co-owner correction 2026-07-26: that product is NOT public) and
  // suppressed the token on every scanned surface in every repo shipping the
  // scanner. Entry removed. This case locks the removal: plant the token on a
  // synthetic synced surface and require a finding. If someone re-adds the
  // allowlist entry, this case reds.
  add("RS-16-false-public-product-allowlist-entry-absent", () => {
    // GAP B: the allowlist entry annotated "public PACT product" was FALSE
    // (co-owner correction 2026-07-26 — that product is NOT public; the public
    // one is the PACT *reference platform*). It is removed.
    //
    // This case asserts the SOURCE fact (the entry is gone), NOT a behavioural
    // one, and that is deliberate. The first draft asserted "the token now
    // flags" and RED-ed at exit 0 — which measured something worth recording:
    // removing the allowlist is NECESSARY BUT NOT SUFFICIENT, because NO shape
    // detects a bare product name in the first place. The allowlist entry was
    // pre-empting a detector that does not exist. Detection would come from a
    // `.claude/disclosure-tenant-denylist.json` entry (the customer-identity
    // shape loads its denylist from the scanned root) — a ratification call
    // that names a real internal product, deliberately NOT made here.
    //
    // Asserting the true property keeps the suite honest; asserting the
    // behavioural one would have forced either a red suite or a re-added false
    // allowlist entry, and both are worse than a recorded residual.
    const src = fs.readFileSync(SCANNER, "utf8");
    const rx = new RegExp(String.raw`/\\b` + ["Ae", "gis"].join("") + String.raw`\\b/i`);
    return {
      pass: !rx.test(src),
      got: rx.test(src) ? "entry still present in the allowlist" : "entry absent",
      want: "the false public-product allowlist entry is absent",
    };
  });

  // MEASURED DEFECT 2026-08-10 — a `--root` at a NONEXISTENT path returned
  // exit 0 with ZERO output, byte-identical to a clean scan, so a mistyped
  // path silently PASSED the Gate-1 intake gate and /ecosystem-init's
  // pre-write gate. Now exit 2 ("did not run").
  add("root-nonexistent-is-2-not-0", () => {
    const r = runScanner("/nonexistent/path/that/cannot/exist");
    return { pass: r.exit === 2, got: `exit ${r.exit}`, want: "exit 2" };
  });

  add("root-without-synced-surface-is-2-not-0", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nosurface-"));
    fs.writeFileSync(path.join(dir, "README.md"), "not a coc checkout\n");
    const r = runScanner(dir);
    return { pass: r.exit === 2, got: `exit ${r.exit}`, want: "exit 2" };
  });

  // The companion property: a clean exit 0 must now carry its own
  // discriminating receipt, so 0-with-output and 0-with-nothing-scanned are
  // no longer the same observation.
  add("clean-check-emits-scanned-count", () => {
    const dir = path.join(HERE, "clean-foundation-placeholder");
    const r = runScanner(dir);
    const out = String(r.out || "");
    return {
      pass: r.exit === 0 && /^Scanned: \d+ files/m.test(out),
      got: `exit ${r.exit} :: ${out.trim().split("\n")[0] || "(no output)"}`,
      want: "exit 0 with a 'Scanned: N files' line",
    };
  });

  // MEASURED DEFECT — the `--allow-synthetic-fixture-homes` exemption was keyed on a
  // BASENAME convention (`*.test.(mjs|js)`) while a newer generation of loom's own
  // detector fixtures uses a DIRECTORY convention (`audit-fixtures/<name>/run.mjs` plus
  // sibling `.txt`/`.md`/`.json` payloads). No file written to the second convention can
  // end `.test.mjs`, so for those fixtures the exemption was STRUCTURALLY UNREACHABLE —
  // never "evaluated and declined". On the tree that surfaced it, 16 operator-home-path
  // findings stood in two such fixture directories, every username (`op`, `x`, `alice`)
  // already a member of SYNTHETIC_FIXTURE_USERS.
  //
  // The case is deliberately BIPOLAR and hermetic, so it discriminates rather than merely
  // agreeing with the fix: it plants SIX homes on one temp tree and reads the SAME tree
  // twice.
  //
  // AMENDED 2026-09-13 — the OFF pole expected SIX and was RED at HEAD. Not a renumber:
  // `b1515d06b` (the gate-red merge) deliberately made the DIRECTORY arm UNCONDITIONAL on
  // the opt-in flag, because the Gate-2 preflight passes no flag and the USERNAME gate is
  // the real discriminator (`scan-synced-disclosure.mjs`'s `scanLines`, which binds
  // `detectorFixtureFile = isAuditFixtureFile(rel)` — the line that stood here, `:1711`, is
  // `allowlistCovers` on this tree — and whose own comment records the decision). The fixture
  // authored at `19985f5ad` still asserted
  // the older flag-gated contract, so its OFF pole was measuring a behaviour HEAD no longer
  // has. The two corpus plants are therefore tolerated under BOTH poles, and the pole is
  // re-instrumented rather than relaxed — a control that can no longer move for those two
  // plants must not keep being cited as if it could:
  //   · the FLAG's opposite-verdict control is now the OFF→ON DELTA, which must be EXACTLY
  //     `demo-detector.test.mjs` — the BASENAME arm is still flag-gated
  //     (`testFixtureFile = allowSyntheticFixtureHomes && fixtureCorpusFile`), so that one
  //     plant flips and nothing else does;
  //   · the DIRECTORY arm's discriminator is the USERNAME gate, asserted on BOTH poles:
  //     `real-home.txt` flags in each while the two synthetic corpus plants clear in each.
  //     That is what keeps an unconditional arm from being a blanket directory EXCLUSION.
  // Flag ON must flag EXACTLY the three that are not covered by the exemption:
  //   · an ORDINARY shipped file (`.claude/rules/ordinary.md`) — the tolerance is scoped
  //     to the fixture corpus, so a synthetic-looking home outside it still flags;
  //   · a NON-synthetic username INSIDE the fixture corpus — the tolerance is scoped to
  //     SYNTHETIC_FIXTURE_USERS, so a real operator home still flags;
  //   · a file merely NAMED for the corpus (`rules/my-audit-fixtures-notes.md`) — the
  //     directory arm is segment-anchored, not a substring test.
  // Each of the four ways to get this wrong reds a DIFFERENT assertion below, MEASURED by
  // mutation rather than assumed: drop the audit-fixtures arm and the run.mjs + .txt poles
  // reappear; drop the tolerance entirely and the `.test.mjs` pole joins them; drop the
  // SYNTHETIC_FIXTURE_USERS membership gate and the real-username pole goes silent; swap
  // the anchored regex for `includes("audit-fixtures")` and the merely-named pole does.
  //
  // The non-synthetic username is ASSEMBLED at runtime rather than written literally: this
  // file ships to the client-template edition, whose scrubber rewrites a real-looking
  // `/Users/<name>/` span, which would quietly turn the plant into a token that cannot
  // flag and leave the assertion passing for the wrong reason.
  add("audit-fixture-runner-convention-reaches-synthetic-home-exemption", () => {
    const SYNTH = "/Users/op/repos/demo/checkout";
    const REALISH = `/Users/${["real", "contributor"].join("")}/repos/demo/checkout`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-disclosure-fixhome-"));
    try {
      const fx = path.join(tmp, ".claude", "audit-fixtures", "demo-detector");
      fs.mkdirSync(fx, { recursive: true });
      fs.mkdirSync(path.join(tmp, ".claude", "bin"), { recursive: true });
      fs.mkdirSync(path.join(tmp, ".claude", "rules"), { recursive: true });
      // (1)+(2) the DIRECTORY convention — runner and a sibling candidate payload.
      fs.writeFileSync(path.join(fx, "run.mjs"), `const home = "${SYNTH}";\n`);
      fs.writeFileSync(path.join(fx, "lane-brief.txt"), `STEP 0: cd ${SYNTH}\n`);
      // (3) the pre-existing BASENAME convention — the arm that already worked.
      fs.writeFileSync(
        path.join(tmp, ".claude", "bin", "demo-detector.test.mjs"),
        `const home = "${SYNTH}";\n`,
      );
      // (4) an ORDINARY shipped file — outside the fixture corpus, MUST still flag.
      fs.writeFileSync(
        path.join(tmp, ".claude", "rules", "ordinary.md"),
        `The runbook lives at ${SYNTH}.\n`,
      );
      // (5) a NON-synthetic username INSIDE the corpus — MUST still flag.
      fs.writeFileSync(path.join(fx, "real-home.txt"), `cd ${REALISH}\n`);
      // (6) a file merely NAMED for the corpus — the directory arm is segment-anchored,
      //     so an `includes("audit-fixtures")` widening would silently swallow this.
      fs.writeFileSync(
        path.join(tmp, ".claude", "rules", "my-audit-fixtures-notes.md"),
        `The runbook lives at ${SYNTH}.\n`,
      );

      const off = runScanner(tmp);
      const on = runScanner(tmp, ["--allow-synthetic-fixture-homes"]);
      const count = (r) => [...String(r.out || "").matchAll(/\[SHAPE:/g)].length;
      const named = (r, frag) => String(r.out || "").includes(frag);

      const problems = [];
      if (off.exit !== 1 || count(off) !== 4) {
        problems.push(`flag OFF: exit ${off.exit}, ${count(off)} finding(s) (want exit 1, 4)`);
      }
      if (on.exit !== 1 || count(on) !== 3) {
        problems.push(`flag ON: exit ${on.exit}, ${count(on)} finding(s) (want exit 1, 3)`);
      }
      // OPPOSITE-VERDICT CONTROL for the FLAG: the BASENAME arm is still flag-gated, so
      // `demo-detector.test.mjs` MUST flag with the opt-in OFF and clear with it ON. If it
      // never moves, the flag-ON run below is a blind instrument and its silence proves
      // nothing about the opt-in.
      if (!named(off, "demo-detector.test.mjs")) {
        problems.push("flag OFF did NOT flag demo-detector.test.mjs — the opt-in has no opposite verdict left");
      }
      if (named(on, "demo-detector.test.mjs")) {
        problems.push("flag ON still flagged demo-detector.test.mjs — the basename arm is not firing");
      }
      // The DIRECTORY arm is UNCONDITIONAL, so the flag cannot be its control. Its
      // discriminator is the USERNAME gate, and it is read on BOTH poles: the synthetic
      // corpus plants clear in each while a REAL username in the SAME directory flags in
      // each. Without this pair the unconditional arm would be indistinguishable from a
      // blanket directory EXCLUSION, which is the regression `isExcluded` records.
      for (const [pole, r] of [["OFF", off], ["ON", on]]) {
        for (const frag of ["demo-detector/run.mjs", "demo-detector/lane-brief.txt"]) {
          if (named(r, frag)) problems.push(`flag ${pole} still flagged the synthetic fixture home in ${frag}`);
        }
        if (!named(r, "demo-detector/real-home.txt")) {
          problems.push(`flag ${pole} suppressed demo-detector/real-home.txt — the tolerance is per-DIRECTORY, not per-username`);
        }
      }
      for (const frag of ["rules/ordinary.md", "demo-detector/real-home.txt", "rules/my-audit-fixtures-notes.md"]) {
        if (!named(on, frag)) problems.push(`flag ON suppressed ${frag} — the tolerance is a blanket`);
      }
      return {
        pass: problems.length === 0,
        got: problems.length
          ? problems.join(" | ")
          : `OFF 4 findings, ON 3 (delta = demo-detector.test.mjs; ordinary file, non-synthetic home in the fixture dir, merely-named file flag in both)`,
        want:
          "the exemption reaches the audit-fixtures/<name>/ runner convention AND its sibling payloads, " +
          "while an ordinary shipped file and a non-synthetic username inside the corpus still flag",
      };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // MEASURED DEFECT — an exception thrown DURING the scan exited 1, the code
  // `--check` uses to ASSERT a disclosure finding. Measured on a fixture with
  // ZERO findings: a `TypeError` inside `scanFile` produced exit 1, so "the
  // scanner found a leak" and "the scanner died" were the same observation to
  // every caller that keys on the exit code. The scan loop is now fenced and a
  // crash exits 3 (`instrument-discipline.md` MUST-1 — an instrument whose
  // output is consistent with both branches is not evidence).
  //
  // WHY THIS CASE MUTATES A COPY. No INPUT reaches the crash path: `scanFile`
  // catches its own read errors, so a dangling symlink / unreadable file is
  // silently skipped (MEASURED: exit 0, `Scanned: 2 files`) rather than
  // throwing. The only way to exercise the fence is to inject the fault, so the
  // case builds a faithful copy of the scanner in a temp dir with its three
  // relative specifiers repointed at the real `.claude/bin`, and injects a throw.
  //
  // BIPOLAR, so the case discriminates rather than agreeing with itself: the
  // SAME copy harness is run WITHOUT the injected throw and must still exit 0
  // on the clean fixture. A copy that always exited 3 would pass a one-pole
  // check while proving nothing.
  add("crash-during-scan-is-3-not-1", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-crash-"));
    try {
      const binDir = path.dirname(SCANNER);
      const base = fs
        .readFileSync(SCANNER, "utf8")
        // EVERY sibling-lib import, not a named list: a list silently missed the scanner's
        // strip-build-internal import when it was added and made this harness unfaithful.
        .replaceAll('from "./lib/', `from "${binDir}/lib/`)
        .replace(
          '("../hooks/lib/git-subprocess-env.js")',
          `("${binDir}/../hooks/lib/git-subprocess-env.js")`,
        );
      const m = /function scanFile\([^)]*\)\s*\{/.exec(base);
      if (!m) {
        return {
          pass: false,
          got: "scanFile declaration not found — the copy harness could not locate its injection point",
          want: "a locatable scanFile declaration",
        };
      }
      const control = path.join(tmp, "control.mjs");
      const crashed = path.join(tmp, "crashed.mjs");
      fs.writeFileSync(control, base);
      fs.writeFileSync(
        crashed,
        base.slice(0, m.index + m[0].length) +
          '\n  throw new TypeError("INDUCED CRASH: fault injected inside scanFile");' +
          base.slice(m.index + m[0].length),
      );

      const cleanDir = path.join(HERE, "clean-foundation-placeholder");
      const flagDir = path.join(HERE, "flag-each-shape");
      const run = (bin, root) => {
        try {
          const out = execFileSync("node", [bin, "--check", "--root", root], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          });
          return { exit: 0, out };
        } catch (e) {
          return {
            exit: typeof e.status === "number" ? e.status : 99,
            out: (e.stdout || "") + (e.stderr || ""),
          };
        }
      };

      // Pole 1 — the copy is FAITHFUL: unmutated, it reproduces both real verdicts.
      const ctlClean = run(control, cleanDir);
      const ctlFlag = run(control, flagDir);
      // Pole 2 — with the fault injected, the SAME clean root must no longer
      // answer 0 (false clean) and must no longer answer 1 (false finding).
      const crash = run(crashed, cleanDir);

      const problems = [];
      if (ctlClean.exit !== 0) problems.push(`copy harness unfaithful: clean root exited ${ctlClean.exit}, want 0`);
      if (ctlFlag.exit !== 1) problems.push(`copy harness unfaithful: findings root exited ${ctlFlag.exit}, want 1`);
      if (crash.exit === 1) problems.push("crash exited 1 — INDISTINGUISHABLE from a disclosure finding");
      if (crash.exit === 0) problems.push("crash exited 0 — a dead scan read as CLEAN");
      if (crash.exit !== 3) problems.push(`crash exited ${crash.exit}, want 3`);
      if (!/DID NOT COMPLETE/.test(crash.out)) problems.push("crash output does not say the scan DID NOT COMPLETE");
      if (!/UNKNOWN/.test(crash.out)) problems.push("crash output does not name the disclosure status as UNKNOWN");
      // A `[SHAPE:` token in the crash output would re-forge the collision at
      // `clean-instantiate.mjs`, which greps for exactly that marker to tell a
      // finding from a did-not-complete.
      if (/\[SHAPE:/.test(crash.out)) problems.push("crash output carries a [SHAPE:] marker — callers will read it as a finding");
      // N4: the crash trace names paths by role — an absolute path is /Users/<operator>/.
      if (crash.out.includes(tmp) || crash.out.includes(os.homedir())) {
        problems.push("crash output prints an ABSOLUTE path (temp root or home directory)");
      }

      return {
        pass: problems.length === 0,
        got: problems.length
          ? problems.join(" | ")
          : `control clean=0 / findings=1; injected fault=3 with the DID-NOT-COMPLETE + UNKNOWN diagnostic and no [SHAPE:] marker`,
        want: "a crash during the scan exits 3 with a loud did-not-complete diagnostic, never 1 (finding) or 0 (clean)",
      };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // MEASURED DEFECT — the `Scanned: N` receipt counted files it had COLLECTED,
  // not files it had EXAMINED. `scanFile` catches its own read errors and returns
  // silently, so an unreadable file was counted as scanned: a root with one
  // readable file and one dangling symlink exited 0 and printed "Scanned: 2
  // files", vouching for bytes nothing had opened. At the limit a root of
  // entirely unreadable files printed a confident clean. The count is now
  // EXAMINED and the unread files are NAMED (`instrument-discipline.md` MUST-3(b)
  // — name the class the instrument could not see, never absorb it into the
  // tally). This is deliberately NOT an exit-code change: whether an unreadable
  // file is a FINDING is a separate design question, left open.
  //
  // BIPOLAR, and the compliant pole is what stops this passing vacuously: an
  // all-readable root must print NO unread line and count every file, so a build
  // that emitted the UNREAD receipt unconditionally fails the control.
  add("unread-files-excluded-from-the-scanned-count", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-unread-"));
    try {
      const rules = path.join(tmp, ".claude", "rules");
      fs.mkdirSync(rules, { recursive: true });
      fs.writeFileSync(path.join(rules, "readable.md"), "harmless content\n");

      // CONTROL POLE FIRST — everything readable. Establishes both that the
      // scanner counts what it reads and that the UNREAD receipt is conditional.
      const ctl = runScanner(tmp);
      const ctlScanned = /Scanned:\s+(\d+)\s+files/.exec(ctl.out);

      // VIOLATION POLE — add a file that collects but cannot be read. (A DANGLING LINK used to
      // be the instance; a link is now examined as its target string, which is what ships, so
      // an unreadable regular file stands in.)
      fs.writeFileSync(path.join(rules, "unreadable.md"), "x\n");
      fs.chmodSync(path.join(rules, "unreadable.md"), 0o000);
      const r = runScanner(tmp);
      fs.chmodSync(path.join(rules, "unreadable.md"), 0o644);
      const scanned = /Scanned:\s+(\d+)\s+files/.exec(r.out);

      const problems = [];
      if (ctl.exit !== 0) problems.push(`control: all-readable root exited ${ctl.exit}, want 0`);
      if (!ctlScanned || ctlScanned[1] !== "1") problems.push(`control: want "Scanned: 1 files", got ${ctlScanned ? ctlScanned[1] : "(no count)"}`);
      if (/UNREAD:/.test(ctl.out)) problems.push("control: an all-readable root emitted an UNREAD receipt — the receipt is unconditional, so the violation pole proves nothing");
      if (r.exit !== 0) problems.push(`unread root exited ${r.exit}, want 0 (this case must NOT change the exit vocabulary)`);
      if (!scanned) problems.push("no 'Scanned: N files' receipt at all");
      else if (scanned[1] === "2") problems.push("Scanned counted the UNREADABLE file — the receipt vouches for bytes nothing opened");
      else if (scanned[1] !== "1") problems.push(`want "Scanned: 1 files" (examined), got ${scanned[1]}`);
      if (!/UNREAD: 1 collected file\(s\)/.test(r.out)) problems.push("the unread file was not NAMED — a blind class absorbed into silence");
      if (!/unreadable\.md/.test(r.out)) problems.push("the UNREAD receipt does not name WHICH file went unexamined");

      return {
        pass: problems.length === 0,
        got: problems.length
          ? problems.join(" | ")
          : "control: 1 readable -> Scanned: 1, no UNREAD line; +1 unreadable (mode 000) file -> still Scanned: 1, exit 0, UNREAD names unreadable.md",
        want: "the scanned count reports EXAMINED files only, with unread files named separately and the exit vocabulary unchanged",
      };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // A symlinked DIRECTORY is a different blind class from the dangling symlink
  // above, and a worse one. `readdirSync(…, { withFileTypes: true })` types
  // entries by LSTAT, so a symlink pointing at a DIRECTORY reports
  // `isDirectory() === false` / `isSymbolicLink() === true`. The walk used to
  // push it into the FILE accumulator, `readFileSync` then hit EISDIR, and the
  // whole subtree behind it was never collected — while the receipt called it
  // ONE unreadable FILE. The count of files it stood in for was not merely
  // unexamined, it was unknown.
  //
  // BIPOLAR on the property that matters, which is NOT "does the walk follow
  // symlinks" but "does it follow them ONLY where containment holds". Following
  // unconditionally would pull content from OUTSIDE the scan root into a verdict
  // about the synced surface; refusing unconditionally restores the silent hole.
  // So the contained pole must FIND the planted leak, and the escaping pole must
  // NOT report the outside leak while NAMING the subtree it declined to walk
  // (instrument-discipline.md MUST-3(a), security.md § Path Containment).
  add("symlinked-directories-walked-when-contained-and-NAMED-when-escaping", () => {
    const leak = "see /Users/fakeuser/symlinked-subtree-secret/repos for details\n";
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-symdir-"));
    const away = fs.mkdtempSync(path.join(os.tmpdir(), "scan-symdir-away-"));
    // Declared out here so `finally` can remove it: it is deliberately OUTSIDE
    // both roots above (that is the whole point of the escaping pole), so
    // neither of their recursive removals would reach it.
    const away2 = fs.mkdtempSync(path.join(os.tmpdir(), "scan-symdir-esc-"));
    try {
      // ── CONTAINED POLE ──────────────────────────────────────────────
      // The leak lives inside the scan root but is reachable ONLY through a
      // symlinked directory. Pre-fix this was invisible and the link was
      // reported as an unreadable file.
      const claude = path.join(tmp, ".claude");
      fs.mkdirSync(path.join(claude, "rules"), { recursive: true });
      fs.writeFileSync(path.join(claude, "rules", "plain.md"), "harmless content\n");
      const nested = path.join(tmp, "inside", "nested");
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, "hidden.md"), leak);
      // RELATIVE target (2026-10-03): an ABSOLUTE target embeds the running machine's
      // os.tmpdir() — `/var/folders/<two-char>/<per-user-hash>/T/…` on macOS — and the
      // scanner scans a symlink's target STRING, so the `operator-temp-path` shape
      // (added the same day) flags THIS MACHINE'S OWN hash inside the scenario and the
      // pole reds on macOS while passing on Linux. Relative resolves to the same
      // subtree (containment is preserved: both live under `tmp`) and keeps the
      // fixture host-independent. The same fix, same reason, at the escaping pole
      // below and in `r6-file-link-content-is-never-read`.
      fs.symlinkSync(path.relative(claude, nested), path.join(claude, "linkdir"));
      const inside = runScanner(tmp);

      // ── ESCAPING POLE ───────────────────────────────────────────────
      // Same shape of link, but the target resolves OUTSIDE the scan root.
      const claude2 = path.join(away, ".claude");
      fs.mkdirSync(path.join(claude2, "rules"), { recursive: true });
      fs.writeFileSync(path.join(claude2, "rules", "plain.md"), "harmless content\n");
      fs.writeFileSync(path.join(away2, "escaped.md"), leak);
      // RELATIVE target — see the contained pole's note: an absolute target would
      // embed the running machine's temp hash in the scanned target string and red
      // this pole on macOS (`[SHAPE:operator-temp-path]`) while passing on Linux.
      fs.symlinkSync(path.relative(claude2, away2), path.join(claude2, "outlink"));
      const escaping = runScanner(away);

      const problems = [];
      // contained: the previously-unreachable leak must now be a finding
      if (inside.exit !== 1) problems.push(`contained: exit ${inside.exit}, want 1 (the leak behind the symlinked dir must be FOUND)`);
      if (!/linkdir\/hidden\.md/.test(inside.out)) problems.push("contained: the finding does not name the file behind the symlinked directory — the subtree was not walked");
      if (/UNREAD:/.test(inside.out)) problems.push("contained: the symlinked directory was still collected as an unreadable FILE");
      if (/UNDESCENDED:/.test(inside.out)) problems.push("contained: a link INSIDE the scan root was refused — containment is too strict");
      // escaping: refused, named, and nothing from outside leaked into the verdict
      if (/escaped\.md/.test(escaping.out)) problems.push("escaping: content from OUTSIDE the scan root entered a verdict about the synced surface");
      if (/\[SHAPE:/.test(escaping.out)) problems.push("escaping: a finding was reported from a subtree outside the scan root");
      if (!/UNDESCENDED: 1 symlinked director/.test(escaping.out)) problems.push("escaping: the unwalked subtree was NOT named — a blind class absorbed into silence");
      if (!/outlink/.test(escaping.out)) problems.push("escaping: the UNDESCENDED receipt does not name WHICH link went unwalked");
      if (!/resolves OUTSIDE the scan root/.test(escaping.out)) problems.push("escaping: the receipt does not say WHY the subtree was not walked");

      return {
        pass: problems.length === 0,
        got: problems.length
          ? problems.join(" | ")
          : "contained link -> leak behind it FOUND, no UNREAD, no UNDESCENDED; escaping link -> no finding, no outside content, UNDESCENDED names the link and the reason",
        want: "a symlinked directory is walked when it resolves inside the scan root, and NAMED as unwalked when it does not",
      };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(away, { recursive: true, force: true });
      fs.rmSync(away2, { recursive: true, force: true });
    }
  });

  // ── Round-1 review of the fail-closed claim (2026-09-27) ────────────────────
  // Each case below was an EXECUTED escape before its fix: the planted identity read
  // clean (rc 0), or a malformed input read as absent, or identity bytes printed in a
  // finding's context. Trees are built in a temp dir; every token is synthetic, and the
  // canon org is taken from the imported list so no literal is committed here.
  const r1Tree = (files) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scan-r1-"));
    for (const [rel, body] of Object.entries(files)) {
      const f = path.join(root, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      if (body && typeof body === "object" && body.symlinkTo) {
        // `symlinkTo` may be a FUNCTION of the root (2026-10-03) so a scenario can
        // build a RELATIVE target: an absolute target embeds the running machine's
        // os.tmpdir() hash in the scanned target string, which the
        // `operator-temp-path` shape correctly flags — turning a host-independent
        // fixture into a macOS-only red.
        const target = typeof body.symlinkTo === "function" ? body.symlinkTo(root) : body.symlinkTo;
        fs.symlinkSync(target, f);
      } else fs.writeFileSync(f, body);
    }
    return root;
  };
  const R1_ROSTER = ".claude/operators.roster.json";
  const R1_RULE = ".claude/rules/x.md";
  const R1_GOOD = '{"persons":{"zzqprobeuser":{}}}';
  const r1Case = (id, files, want) =>
    add(id, () => {
      // r4-v4 item 8: a count-locked case whose expected count includes the
      // operator-identity half of the derived private literal can only run in
      // an identity-coherent tree (see IDENTITY_COHERENT). Anywhere else its
      // subject does not exist and it reports a NAMED skip.
      if (want.needsCoherence && !IDENTITY_COHERENT) return { skip: NOT_COHERENT_SKIP };
      const root = r1Tree(files);
      try {
        const { exit, out } = runScanner(root);
        const shapes = [...out.matchAll(/\[SHAPE:([a-z-]+)\]/g)].map((m) => m[1]);
        const problems = [];
        if (exit !== want.exit) problems.push(`exit ${exit}, want ${want.exit}`);
        if (want.count !== undefined && shapes.length !== want.count)
          problems.push(`${shapes.length} finding(s), want ${want.count}`);
        for (const s of want.shapes || []) if (!shapes.includes(s)) problems.push(`no ${s} finding`);
        if (want.output && !want.output.test(out)) problems.push(`output lacks ${want.output}`);
        for (const raw of want.noRaw || [])
          if (out.toLowerCase().includes(raw.toLowerCase())) problems.push(`'${raw}' printed in clear`);
        return {
          pass: problems.length === 0,
          got: problems.length ? problems.join(" | ") : `exit ${exit}, ${shapes.length} finding(s) [${[...new Set(shapes)].join(",")}]`,
          want: want.why,
        };
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

  r1Case(
    "r1-denylist-padded-token-still-flags",
    {
      [R1_ROSTER]: R1_GOOD,
      ".claude/disclosure-tenant-denylist.json": '{"tokens":["  acmecorpq  "]}',
      [R1_RULE]: "Deployed for acmecorpq last week.\n",
    },
    { exit: 1, count: 1, shapes: ["customer-identity-token"], why: "a whitespace-padded denylist entry is trimmed, so it matches ordinary prose" },
  );
  r1Case(
    "r1-roster-whitespace-field-refused",
    { [R1_ROSTER]: '{"persons":[{"display_id":"   ","nick":"carolxyz"}]}', [R1_RULE]: "carolxyz wrote this\n" },
    { exit: 2, output: /yields ZERO identity tokens/, why: "a whitespace-only field is not an identity token, so the per-person check refuses" },
  );
  r1Case(
    "r1-roster-dangling-symlink-refused",
    { [R1_ROSTER]: { symlinkTo: "/nonexistent-scan-r1-target/roster.json" }, [R1_RULE]: "zzqprobeuser\n" },
    { exit: 2, output: /present but unreadable or unparseable/, why: "a dangling-symlink roster is present-but-unreadable (exit 2), never absent" },
  );
  r1Case(
    "r1-denylist-dangling-symlink-refused",
    {
      [R1_ROSTER]: R1_GOOD,
      ".claude/disclosure-tenant-denylist.json": { symlinkTo: "/nonexistent-scan-r1-target/deny.json" },
      [R1_RULE]: "hello\n",
    },
    { exit: 2, output: /present but unreadable or unparseable/, why: "a dangling-symlink denylist is refused, never read as absent" },
  );
  r1Case(
    "r1-roster-persons-and-operators-merged",
    {
      [R1_ROSTER]: '{"persons":{"otherbobq":{}},"operators":{"zqxalphaq":{}}}',
      [R1_RULE]: "zqxalphaq wrote this\n",
    },
    { exit: 1, count: 1, shapes: ["operator-identity-token"], why: "a roster carrying both collections has BOTH harvested" },
  );
  for (const login of ["placeholder-ops", "DeadBeef"]) {
    r1Case(
      `r1-sentinel-lookalike-login-flags-${login.toLowerCase()}`,
      { [R1_ROSTER]: `{"persons":{"xyq":{"github_login":"${login}"}}}`, [R1_RULE]: `${login} wrote this\n` },
      { exit: 1, shapes: ["operator-identity-token"], why: "only the emitters' exact sentinel vocabulary is filtered; a real login shaped like one flags" },
    );
  }
  {
    // Two DIFFERENT fingerprints, one per roster form, each cited compact on its own line, so
    // each form is pinned separately (round 2: with one shared fingerprint the 0x path could
    // be removed and the case stayed green).
    const fpA = "0F1E2D3C4B5A69788796A5B4C3D2E1F09A8B7C6D";
    const fpB = "1A2B3C4D5E6F708192A3B4C5D6E7F8091A2B3C4D";
    const spaced = fpA.match(/.{4}/g).join(" ");
    for (const [id, roster, cite] of [
      ["spaced", `{"persons":{"zzqprobeuser":{"keys":[{"fingerprint":"${spaced}"}]}}}`, fpA],
      ["0x", `{"persons":{"yyqprobeuser":{"keys":[{"fingerprint":"0x${fpB.toLowerCase()}"}]}}}`, fpB],
    ]) {
      r1Case(
        `r1-fingerprint-${id}-roster-form-yields-compact`,
        { [R1_ROSTER]: roster, [R1_RULE]: `key ${cite}\n` },
        { exit: 1, count: 1, shapes: ["operator-identity-token"], noRaw: [cite.slice(-16)], why: `a ${id} roster fingerprint yields its compact hex form` },
      );
    }
  }
  {
    const root64 = "ab12cd34ef56".repeat(5) + "ab12";
    r1Case(
      "r1-sha256-root-commit-prefix-flags",
      { [R1_ROSTER]: `{"genesis":{"root_commit":"${root64}"},"persons":{"zzqprobeuser":{}}}`, [R1_RULE]: `root is ${root64.slice(0, 9)}\n` },
      { exit: 1, count: 1, shapes: ["operator-identity-token"], why: "a 64-hex (SHA-256) root commit is a hex identity with prefix forms" },
    );
  }
  r1Case(
    "r1-private-key-on-identity-only-path-no-roster",
    { ".claude/audit-fixtures/scan-synced-disclosure/newcase/leak.md": "-----BEGIN OPENSSH " + "PRIVATE KEY-----\n" },
    { exit: 1, count: 1, shapes: ["private-key-material"], why: "private-key-material runs on the identity-only corpus path, with or without a roster" },
  );
  {
    const canon = FIXTURE_ORG;
    const tail = canon.split("-").slice(1).join("-");
    r1Case(
      "r1-scrubber-genesis-value-starting-with-canon-org-flags",
      {
        [R1_ROSTER]: `{"genesis":{"repo_owner":"${canon}","ado_project":"${canon} Payrollq"},"persons":{"zzqprobeuser":{}}}`,
        ".claude/bin/lib/strip-build-internal.mjs": `// ${canon} Payrollq\n`,
      },
      { exit: 1, shapes: ["operator-identity-token"], why: "the roster's genesis multi-word value is an identity token, at the scrubber path like anywhere else — the tolerance that once exempted parts of this line is DELETED (Tier-1 round 2)" },
    );
    r1Case(
      "r1-scrubber-person-token-inside-canon-span-flags",
      {
        [R1_ROSTER]: `{"genesis":{"repo_owner":"${canon}"},"persons":{"zzqprobeuser":{"display_id":"${tail}-opsq"}}}`,
        ".claude/bin/lib/strip-build-internal.mjs": `// ${canon}-opsq\n`,
      },
      { exit: 1, shapes: ["operator-identity-token"], why: "a person token starting INSIDE a private-org-shaped span is still found — no scrubber tolerance shields either token (Tier-1 round 2)" },
    );
  }
  {
    const H = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const H2 = "9f8e7d6c5b4a39281706" + "a" + "5e4d3c2b1a0ffeeddcc";
    r1Case(
      "r1-glued-hashes-both-found-none-in-clear",
      {
        [R1_ROSTER]: `{"genesis":{"root_commit":"${H}"},"persons":{"zzqprobeuser":{"keys":[{"fingerprint":"${H2.toUpperCase()}"}]}}}`,
        [R1_RULE]: `x ${H2.slice(0, 20)}${H}\n`,
      },
      { exit: 1, count: 2, noRaw: [H.slice(1, 13)], why: "a hash glued after another whose greedy match takes its first digit is still found and masked" },
    );
    r1Case(
      "r1-declared-bound-hex-masked-in-context",
      { [R1_ROSTER]: `{"genesis":{"root_commit":"${H}"},"persons":{"zzqprobeuser":{}}}`, [R1_RULE]: `zzqprobeuser ff${H.slice(0, 11)} y\n` },
      { exit: 1, count: 1, noRaw: [H.slice(0, 11)], why: "an identity hash in a declared-bound form beside a real finding is masked, not printed" },
    );
  }
  r1Case(
    "r1-context-mask-is-a-union-not-a-sequence",
    {
      [R1_ROSTER]: '{"persons":{"zzqprobeuser":{"github_login":"mac-alicejonesq"}}}',
      [R1_RULE]: "host dev-mac-alicejonesq.internal.corp\n",
    },
    { exit: 1, shapes: ["operator-identity-token"], noRaw: ["alicejonesq"], why: "an earlier shape's mask cannot cut a later token so that its remainder prints" },
  );


  // ── Round-2 review (2026-09-27): each was an executed escape at 6d917fc5e ───────────
  for (const [label, body] of [
    ["string-tokens", '{"tokens":"acmecorpq"}'],
    ["array-root", '["acmecorpq"]'],
    ["wrong-key", '{"Tokens":["acmecorpq"]}'],
    ["non-string-entry", '{"tokens":[42]}'],
  ]) {
    r1Case(
      `r2-denylist-wrong-shape-refused-${label}`,
      // No roster in the tree: the scanner's own denylist read is then the ONLY reader of this
      // file (with a roster, identity-scrub's derive reads it too and would absorb a regression).
      { ".claude/disclosure-tenant-denylist.json": body, [R1_RULE]: "acmecorpq here\n" },
      { exit: 2, output: /wrong shape/, noRaw: ["acmecorpq"], why: "a readable denylist of the wrong shape refuses (exit 2), never reads as empty" },
    );
  }
  r1Case(
    "r2-denylist-empty-list-is-legitimate",
    { [R1_ROSTER]: R1_GOOD, ".claude/disclosure-tenant-denylist.json": '{"tokens":[]}', [R1_RULE]: "hello\n" },
    { exit: 0, count: 0, why: "an explicitly empty denylist is a declaration, not a malformation" },
  );
  for (const [label, tok, line] of [
    ["accent", "Acmé", "Acmé signed"],
    ["trailing-dot", "Acme Incq.", "Acme Incq. signed"],
    ["leading-at", "@globexq", "see @globexq now"],
  ]) {
    r1Case(
      `r2-customer-token-non-word-edge-flags-${label}`,
      { [R1_ROSTER]: R1_GOOD, ".claude/disclosure-tenant-denylist.json": JSON.stringify({ tokens: [tok] }), [R1_RULE]: line + "\n" },
      { exit: 1, count: 1, shapes: ["customer-identity-token"], why: "a tenant token whose edge is not an ASCII word character still matches" },
    );
  }
  r1Case(
    "r2-person-token-also-on-denylist-still-flags-glued",
    {
      [R1_ROSTER]: '{"persons":{"zzqalicelong":{}}}',
      ".claude/disclosure-tenant-denylist.json": '{"tokens":["zzqalicelong"]}',
      [R1_RULE]: "xzzqalicelongy\n",
    },
    { exit: 1, count: 1, shapes: ["operator-identity-token"], noRaw: ["zzqalicelong"], why: "denylisting a person's own token never narrows what the operator shape catches" },
  );
  {
    const canon = FIXTURE_ORG;
    r1Case(
      "r2-scrubber-third-party-org-inside-canon-repo-span-flags",
      { ".claude/bin/lib/strip-build-internal.mjs": `// gh api repos/${canon}/kailash-globexq-enterprise\n` },
      { exit: 1, count: 2, shapes: ["nonfoundation-org-slug"], needsCoherence: true, why: "no scrubber tolerance: the PRIVATE org in the span AND the third-party org riding in its repo part BOTH flag (measured 2 since the tolerance's removal, Tier-1 round 2)" },
    );
  }
  for (const [label, roster] of [
    ["array-principal", '{"persons":{"alicexyzq":{"principal":["bobq@corp.example"]}}}'],
    ["string-key-entry", '{"persons":{"alicexyzq":{"keys":["0F1E2D3C4B5A69788796A5B4C3D2E1F09A8B7C6D"]}}}'],
    ["short-fingerprint", '{"persons":{"alicexyzq":{"keys":[{"fingerprint":"ABCD1234"}]}}}'],
  ]) {
    r1Case(
      `r2-roster-field-wrong-shape-refused-${label}`,
      { [R1_ROSTER]: roster, [R1_RULE]: "bobq@corp.example\n" },
      { exit: 2, output: /wrong shape/, why: "a declared field of the wrong type refuses instead of being dropped" },
    );
  }
  {
    const fp = "0F1E2D3C4B5A69788796A5B4C3D2E1F09A8B7C6D";
    const g = fp.match(/.{4}/g);
    const gpg = g.slice(0, 5).join(" ") + "  " + g.slice(5).join(" ");
    const fpRoster = `{"persons":{"zzqprobeuser":{"keys":[{"fingerprint":"${fp}"}]}}}`;
    r1Case(
      "r2-fingerprint-cited-in-gpg-grouped-form-flags",
      { [R1_ROSTER]: fpRoster, [R1_RULE]: `key ${gpg}\n` },
      { exit: 1, count: 1, shapes: ["operator-identity-token"], noRaw: [g[3] + " " + g[4]], why: "a fingerprint pasted from gpg --fingerprint (grouped) is matched and masked" },
    );
    r1Case(
      "r2-key-id-glued-to-hex-flags",
      { [R1_ROSTER]: fpRoster, [R1_RULE]: `x ff${fp.slice(-16)} and ${fp.slice(-16)}ee\n` },
      { exit: 1, count: 2, shapes: ["operator-identity-token"], noRaw: [fp.slice(-16)], why: "a 16-digit key ID glued inside a hex run is matched" },
    );
    const body = "Qz9xW2vB7nM4kL1pR8sT6yU3iO5aE0dF2gH4jK6lZ8c";
    r1Case(
      "r2-ssh-fingerprint-body-without-prefix-flags",
      { [R1_ROSTER]: `{"persons":{"zzqprobeuser":{"keys":[{"fingerprint":"SHA256:${body}"}]}}}`, [R1_RULE]: `key ${body}\n` },
      { exit: 1, count: 1, shapes: ["operator-identity-token"], noRaw: [body.slice(4, 24)], why: "an SSH fingerprint cited by its base64 body alone is matched" },
    );
  }
  r1Case(
    "r2-glued-short-token-masked-in-context",
    { [R1_ROSTER]: '{"persons":{"zzqprobeuser":{"display_id":"bobq"}}}', [R1_RULE]: "zzqprobeuser and xbobqx here\n" },
    { exit: 1, count: 1, noRaw: ["bobq"], why: "a declared-bound glued short token beside a real finding is masked, not printed" },
  );
  r1Case(
    "r2-periodic-token-reported-once",
    { [R1_ROSTER]: '{"persons":{"xyxyxyxy":{}}}', [R1_RULE]: "q xyxyxyxyxyxyxyxy q\n" },
    { exit: 1, count: 2, why: "distinct citations report once each; overlapping repeats of one token do not multiply" },
  );

  // ── Round-3 review (2026-09-27): each was an executed or traced escape at 33a580968 ────
  r1Case(
    "r3-identity-in-file-path-flags-and-is-masked",
    { [R1_ROSTER]: '{"persons":{"zqoperatorx":{}}}', ".claude/skills/demo/zqoperatorx-notes.md": "hello /Users/realpersonq/x\n" },
    { exit: 1, count: 2, shapes: ["operator-identity-token", "operator-home-path"], noRaw: ["zqoperatorx"], why: "a file NAME is scanned for identity, and every printed path is masked" },
  );
  for (const [label, files] of [
    ["kelvin-sign-login", { [R1_ROSTER]: '{"persons":{"zqkelvinlogin":{}}}', [R1_RULE]: "by zq\u212Aelvinlogin\n" }],
    ["dotted-capital-i-tenant", { [R1_ROSTER]: R1_GOOD, ".claude/disclosure-tenant-denylist.json": '{"tokens":["zqkaixcorp"]}', [R1_RULE]: "zqka\u0130xcorp\n" }],
    ["nfd-tenant", { [R1_ROSTER]: R1_GOOD, ".claude/disclosure-tenant-denylist.json": '{"tokens":["Zqacm\u00e9"]}', [R1_RULE]: "Zqacme\u0301 signed\n" }],
  ]) {
    r1Case(`r3-folded-identity-flags-${label}`, files, { exit: 1, count: 1, why: "identity is matched through the publish gate's fold (NFKD, marks stripped, lower-cased)" });
  }
  r1Case(
    "r3-genesis-owner-on-denylist-still-flags-glued",
    {
      [R1_ROSTER]: '{"genesis":{"repo_owner":"zqowner-labs"},"persons":{"zzqprobeuser":{}}}',
      ".claude/disclosure-tenant-denylist.json": '{"tokens":["zqowner-labs"]}',
      [R1_RULE]: "see zqowner-labs2 and zqowner-labs_notes\n",
    },
    { exit: 1, count: 2, shapes: ["operator-identity-token"], why: "no roster-declared token (genesis included) is handed to the bounded customer match" },
  );
  {
    const fp = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
    const roster = `{"persons":{"zzqprobeuser":{"keys":[{"fingerprint":"${fp}"}]}}}`;
    for (const [label, cited, raw] of [
      ["colon", fp.match(/.{2}/g).join(":"), fp.match(/.{2}/g).slice(2, 6).join(":")],
      ["dash", fp.match(/.{4}/g).join("-"), fp.match(/.{4}/g).slice(1, 3).join("-")],
    ]) {
      r1Case(`r3-fingerprint-${label}-separated-flags-and-masked`, { [R1_ROSTER]: roster, [R1_RULE]: `fp ${cited}\n` },
        { exit: 1, count: 1, shapes: ["operator-identity-token"], noRaw: [raw], why: "a punctuation-grouped fingerprint is matched and masked whole" });
    }
    const body = "Qz9xW2vB7nM4kL1pR8sT6yU3iO5aE0dF2gH4jK6lZ8c";
    const ssh = `{"persons":{"zzqprobeuser":{"keys":[{"fingerprint":"SHA256:${body}"}]}}}`;
    r1Case("r3-ssh-truncated-body-without-prefix-flags", { [R1_ROSTER]: ssh, [R1_RULE]: `key ${body.slice(0, 20)}…\n` },
      { exit: 1, count: 1, noRaw: [body.slice(0, 20)], why: "a 16+-character prefix of an SSH fingerprint body is matched" });
    r1Case("r3-ssh-prose-prefix-masks-its-continuation", { [R1_ROSTER]: ssh, [R1_RULE]: `fp SHA256:${body.slice(0, 26)}…\n` },
      { exit: 1, count: 1, noRaw: [body.slice(8, 26)], why: "the SHA256:<pre> span runs over the base64 that follows it" });
  }
  r1Case(
    "r3-allowlisted-org-does-not-carry-a-riding-org",
    { [R1_RULE]: `gh api repos/${FIXTURE_ALLOWLISTED_ORG}/kailash-zqthird-enterprise\n` },
    { exit: 1, count: 1, shapes: ["nonfoundation-org-slug"], why: "the allowlist vouches for the org a span names, not a second org riding in it" },
  );
  r1Case(
    "r3-bare-placeholder-login-is-not-a-sentinel",
    { [R1_ROSTER]: '{"persons":{"xyq":{"display_id":"Placeholder"}}}', [R1_RULE]: "Placeholder wrote\n" },
    { exit: 1, count: 1, why: "only placeholder-owner is a sentinel login" },
  );
  for (const [label, body] of [["corrupt", "{ not json"], ["wrong-type", '{"root_commit":42}']]) {
    r1Case(`r3-trust-root-${label}-refused`, { [R1_ROSTER]: R1_GOOD, ".claude/trust-root.json": body, [R1_RULE]: "hi\n" },
      { exit: 2, output: /trust-root\.json/, why: "a present trust root must parse and carry a 7-64 hex root_commit" });
  }
  r1Case(
    "r3-denylist-parse-error-does-not-echo-bytes",
    { [R1_ROSTER]: R1_GOOD, ".claude/disclosure-tenant-denylist.json": '{"tokens":["Zqglobx",]}', [R1_RULE]: "hi\n" },
    { exit: 2, output: /position/, noRaw: ["Zqglobx"], why: "a parse refusal names a position, never an excerpt of the input" },
  );
  r1Case(
    "r3-roster-parse-error-does-not-echo-bytes",
    // This syntax error is one V8 reports by QUOTING the input around it (a trailing-comma
    // error is reported by position only and could not show an echo).
    { [R1_ROSTER]: '{"persons":{"zzqglobxq":x}}', [R1_RULE]: "hi\n" },
    { exit: 2, output: /position/, noRaw: ["zzqglobxq"], why: "a parse refusal names a position, never an excerpt of the input" },
  );

  // ── Round-4 review (2026-09-27): each was an executed or traced escape at 51f5f769b ────
  r1Case("r4-ascii-spelling-of-accented-tenant-flags",
    { [R1_ROSTER]: R1_GOOD, ".claude/disclosure-tenant-denylist.json": '{"tokens":["Soci\u00e9t\u00e9 Acmeq"]}', [R1_RULE]: "Contract with Societe Acmeq renewed\n" },
    { exit: 1, count: 1, shapes: ["customer-identity-token"], why: "an accented token's ASCII spelling matches once both sides are folded, as at the publish gate" });
  r1Case("r4-ascii-spelling-of-accented-login-flags",
    { [R1_ROSTER]: '{"persons":{"xq":{"display_id":"Zo\u00ebq Examplq"}}}', [R1_RULE]: "by Zoeq Examplq\n" },
    { exit: 1, count: 1, shapes: ["operator-identity-token"], why: "an accented roster value's ASCII spelling matches once both sides are folded" });
  for (const span of ["consumer-labs/loom#3", "downstream-io/kailash-rs", "acme-kailash/loom", "kailash-enterprise-evil/loom", "github.com/consumer-bank/loom"]) {
    r1Case(`r4-allowlist-word-inside-org-does-not-cover-it-${span.replace(/[^a-z0-9]+/g, "-")}`, { [R1_RULE]: span + "\n" },
      { exit: 1, count: 1, shapes: ["nonfoundation-org-slug"], why: "the allowlist must match the ORG whole, never a word inside it" });
  }
  r1Case("r4-allowlist-whole-org-and-exact-span-still-clean",
    { [R1_RULE]: "nexus-enterprise and include/kailash.h and example-org/loom\n" },
    { exit: 0, count: 0, why: "a wholly-allowlisted org, and an exact allowlisted span, stay clean" });
  {
    const canon = FIXTURE_ORG;
    r1Case("r4-scrubber-folded-identity-beside-private-org-span-flags",
      { [R1_ROSTER]: `{"genesis":{"repo_owner":"${canon}"},"persons":{"zqpersonx":{}}}`, ".claude/bin/lib/strip-build-internal.mjs": `// ${canon} maintained by zqpe\u0301rsonx\n` },
      { exit: 1, count: 2, shapes: ["nonfoundation-org-slug", "operator-identity-token"], needsCoherence: true, why: "a raw match on the line does not stand in for a folded identity \u2014 and with the scrubber tolerance gone the private org flags beside it (measured 2 since Tier-1 round 2)" });
  }
  r1Case("r4-folded-identity-in-path-is-withheld",
    { [R1_ROSTER]: '{"persons":{"zqpersonx":{}}}', ".claude/notes/zqpe\u0301rsonx.md": "hi /Users/realpersonq/x\n" },
    { exit: 1, count: 2, noRaw: ["zqpe\u0301rsonx", "zqp\u00e9rsonx"], why: "a folded identity in a printed path is withheld" });
  r1Case("r4-folded-identity-in-context-is-withheld",
    // The folded token sits INSIDE the raw finding's ±20-character window, so an unmasked one
    // would print; the noRaw fragment is its tail, which survives any partial masking.
    { [R1_ROSTER]: '{"persons":{"zqpersonx":{},"zqotherx":{}}}', [R1_RULE]: "zqotherx zqpe\u0301rsonx\n" },
    { exit: 1, noRaw: ["rsonx"], why: "a folded identity beside a raw finding is withheld from its context" });
  r1Case("r4-symlink-target-string-is-scanned",
    { [R1_ROSTER]: R1_GOOD, ".claude/rules/y.md": { symlinkTo: "/Users/zqlinkperson/notes/y.md" } },
    { exit: 1, shapes: ["operator-home-path"], noRaw: ["zqlinkperson"], why: "a symlink ships as its target string, which is scanned" });
  r1Case("r4-directory-link-name-is-scanned-when-undescended",
    { [R1_ROSTER]: '{"persons":{"zqpersonx":{}}}', ".claude/skills/zqpersonx": { symlinkTo: os.tmpdir() } },
    { exit: 1, shapes: ["operator-identity-token"], noRaw: ["zqpersonx"], why: "a symlinked directory's NAME is scanned whether or not it is descended" });
  {
    const fp64 = "0a1b2c3d4e5f60718293a4b5c6d7e8f9012345670a1b2c3d4e5f607182930a1b";
    r1Case("r4-sha256-fingerprint-separated-flags",
      { [R1_ROSTER]: `{"persons":{"zzqprobeuser":{"keys":[{"fingerprint":"${fp64}"}]}}}`, [R1_RULE]: "fp " + fp64.toUpperCase().match(/.{4}/g).join(" ") + "\n" },
      { exit: 1, count: 1, why: "a 64-hex fingerprint is matched in separated form too" });
  }
  r1Case("r4-trust-root-non-object-refused",
    { [R1_ROSTER]: R1_GOOD, ".claude/trust-root.json": '["9f8e7d6c5b4a39281706f5e4d3c2b1a098765432"]', [R1_RULE]: "hi\n" },
    { exit: 2, output: /not a JSON object/, why: "a trust root must be an object" });
  r1Case("r4-trust-root-signer-identity-flags",
    { [R1_ROSTER]: R1_GOOD, ".claude/trust-root.json": '{"root_commit":null,"signers":{"ABCDEF0123456789ABCD":{"person_id":"zqsignerxy","pubkey":"x"}}}', [R1_RULE]: "signed by zqsignerxy\n" },
    { exit: 1, count: 1, shapes: ["operator-identity-token"], why: "the trust root's signers are declared identities" });
  r1Case("r4-sha256-prose-token-on-denylist-still-flags-glued",
    {
      [R1_ROSTER]: '{"persons":{"zzqprobeuser":{"keys":[{"fingerprint":"SHA256:Qz9xW2vB7nM4kL1pR8sT6yU3iO5aE0dF2gH4jK6lZ8c"}]}}}',
      ".claude/disclosure-tenant-denylist.json": '{"tokens":["SHA256:Qz9xW2"]}',
      [R1_RULE]: "fp SHA256:Qz9xW2vB7nQ\n",
    },
    { exit: 1, count: 1, shapes: ["operator-identity-token"], why: "a derived SSH prose token is roster-declared and never handed to the bounded tenant match" });
  add("r4-root-argument-must-name-something", () => {
    const got = [["--root", ""], ["--root"]].map((a) => {
      const r = spawnSync(process.execPath, [SCANNER, "--check", ...a], { encoding: "utf8" });
      return r.status;
    });
    return { pass: got.every((x) => x === 2), got: `exits ${got.join(",")}`, want: "an empty or missing --root value exits 2, never scans the checkout" };
  });

  // ── Round-5 review (2026-09-27): each was an executed or traced escape at 75d168a34 ────
  r1Case("r5-trust-root-without-roster-is-read",
    {
      ".claude/trust-root.json": '{"root_commit":"9f8e7d6c5b4a39281706f5e4d3c2b1a098765432","signers":{"ABCDEF0123456789ABCD":{"person_id":"zqsignerone","pubkey":"x"}}}',
      [R1_RULE]: "signed by zqsignerone at 9f8e7d6c5b4a\n",
    },
    { exit: 1, count: 2, shapes: ["operator-identity-token"], why: "a trust root is read at a root with no roster (a consumer's inbound tree)" });
  for (const [label, signer, cite] of [
    ["null-fingerprint", '{"person_id":"zqsigner2","fingerprint":null,"pubkey":"x"}', "C0FFEE110123456789ABCDEF0123456789ABCDEF"],
  ]) {
    r1Case(`r5-trust-root-signer-${label}-uses-map-key`,
      { ".claude/trust-root.json": `{"root_commit":null,"signers":{"C0FFEE110123456789ABCDEF0123456789ABCDEF":${signer}}}`, [R1_RULE]: `key ${cite}\n` },
      { exit: 1, count: 1, why: "a null signer fingerprint does not shadow the map-key fingerprint" });
  }
  r1Case("r5-trust-root-signer-array-pubkey-refused",
    { ".claude/trust-root.json": '{"root_commit":null,"signers":{"C0FFEE110123456789ABCDEF0123456789ABCDEF":{"person_id":"zqsigner3","pubkey":["a","b"]}}}', [R1_RULE]: "hi\n" },
    { exit: 2, output: /wrong shape/, why: "a signer field of the wrong type refuses instead of being dropped" });
  // A trust root NEUTRALIZE-scrubbed IN PLACE carries the scrubber's own replacement
  // vocabulary (`identity-scrub.mjs::SCRUB_PLACEHOLDER`) where the signer identity was. Read back
  // as a declared identity it flagged every file containing the English word — 219 findings on
  // the client-template edition. BOTH directions in one case: (a) a placeholder-only signer
  // leaves prose using the vocabulary clean; (b) the SAME tree with a real-looking synthetic
  // signer id flags that id and ONLY that id — the vocabulary on the same line stays clean, so
  // the shape is live and the exemption is exact-match, never a hole.
  add("r6-scrub-vocabulary-in-trust-root-is-not-an-identity", () => {
    const PH_ROSTER = JSON.stringify({
      genesis: { repo_owner: "PLACEHOLDER-owner", repo_owner_kind: "user", root_commit: "0000000", genesis_generation: 0 },
      persons: { "PLACEHOLDER-owner": { display_id: "placeholder-owner", role: "owner", host_role: "human", github_login: "PLACEHOLDER-owner",
        keys: [{ type: "gpg", fingerprint: "DEADBEEF".repeat(5), pubkey: "PLACEHOLDER" }] } },
    });
    const trustRoot = (pid) => JSON.stringify({ root_commit: null, signers: { ["DEADBEEF".repeat(5)]: {
      person_id: pid, display_id: "maintainer", email: "maintainer@example.com", name: "Example Maintainer",
      pubkey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDEADBEEF maintainer" } } });
    const prose = "Ask the maintainer (maintainer@example.com, Example Maintainer, example-maintainer) on example-host.\n";
    const run = (pid, body) => {
      const root = r1Tree({ [R1_ROSTER]: PH_ROSTER, ".claude/trust-root.json": trustRoot(pid), [R1_RULE]: body });
      try {
        const { exit, out } = runScanner(root);
        return { exit, n: [...out.matchAll(/\[SHAPE:([a-z-]+)\]/g)].length, out };
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    };
    const a = run("maintainer", prose);
    const b = run("pid-zqxw-test-7731", prose + "Signed off by pid-zqxw-test-7731.\n");
    const problems = [];
    if (a.exit !== 0 || a.n !== 0) problems.push(`placeholder signer: exit ${a.exit}, ${a.n} finding(s), want exit 0 and 0`);
    if (b.exit !== 1 || b.n !== 1) problems.push(`real-looking signer: exit ${b.exit}, ${b.n} finding(s), want exit 1 and exactly 1`);
    if (!/x\.md:2:\d+\s+\[SHAPE:operator-identity-token\]/.test(b.out)) problems.push("real-looking signer: the one finding is not the id's line (line 2)");
    if (/zqxw-test-7731/i.test(b.out)) problems.push("real-looking signer: the id printed in clear");
    return {
      pass: problems.length === 0,
      got: problems.length ? problems.join(" | ") : `placeholder: exit ${a.exit}/${a.n}; real-looking: exit ${b.exit}/${b.n} on line 2`,
      want: "the scrub's replacement vocabulary is not an operator identity; a real signer id beside it still flags",
    };
  });
  r1Case("r5-structural-shape-in-file-name-flags",
    { [R1_ROSTER]: R1_GOOD, ".claude/rules/zorkcorp-enterprise-notes.md": "clean content\n" },
    { exit: 1, count: 1, shapes: ["nonfoundation-org-slug"], noRaw: ["zorkcorp"], why: "structural shapes run over file names through the same allowlist as content" });
  r1Case("r5-allowlisted-file-names-stay-clean",
    { [R1_ROSTER]: R1_GOOD, ".claude/skills/03-nexus/nexus-enterprise-features.md": "clean\n" },
    { exit: 0, count: 0, why: "an allowlisted name in a path stays clean" });
  add("r5-unreadable-directory-does-not-corrupt-the-count", () => {
    const root = r1Tree({ [R1_ROSTER]: R1_GOOD, [R1_RULE]: "hello\n", ".claude/rules/locked/a.md": "x\n" });
    try {
      fs.chmodSync(path.join(root, ".claude/rules/locked"), 0o000);
      const { exit, out } = runScanner(root);
      const m = /Scanned: (-?\d+) files/.exec(out);
      const n = m ? Number(m[1]) : NaN;
      const named = /UNREAD: \d+ collected file\(s\) and 1 director/.test(out);
      return { pass: exit === 0 && n >= 0 && named, got: `exit ${exit}, scanned ${n}, dir named: ${named}`, want: "an unreadable directory is named under UNREAD and never subtracted from the file count" };
    } finally {
      fs.chmodSync(path.join(root, ".claude/rules/locked"), 0o755);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  r1Case("r5-top-level-dangling-link-is-scanned",
    { [R1_ROSTER]: R1_GOOD, [R1_RULE]: "hi\n", "AGENTS.md": { symlinkTo: "/Users/zqtoplevelx/notes/AGENTS.md" } },
    { exit: 1, shapes: ["operator-home-path"], noRaw: ["zqtoplevelx"], why: "a dangling top-level link is collected, its target string scanned" });
  r1Case("r5-top-level-root-link-outside-is-not-walked-and-its-target-is-scanned",
    { [R1_ROSTER]: R1_GOOD, [R1_RULE]: "hi\n", ".codex-mcp-guard": { symlinkTo: "/Users/zqguardowner/guard" } },
    { exit: 1, shapes: ["operator-home-path"], noRaw: ["zqguardowner"], why: "a top-level synced root that is a link is handled like any directory link" });

  // ── Round-6 review (2026-09-27) ─────────────────────────────────────────────────────
  {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "scan-r6-outside-"));
    fs.writeFileSync(path.join(outside, "secret.md"), "https://zqcredowner:zqsecrettoken@example.org /Users/zqoutsider/x\n");
    r1Case("r6-file-link-content-is-never-read",
      {
        [R1_ROSTER]: R1_GOOD,
        [R1_RULE]: "hi\n",
        // RELATIVE target — see the r1Tree note: absolute would embed this machine's
        // temp hash in the scanned target string and red the count-0 expectation on macOS.
        ".claude/rules/notes.md": {
          symlinkTo: (root) => path.relative(path.join(root, ".claude", "rules"), path.join(outside, "secret.md")),
        },
      },
      { exit: 0, count: 0, noRaw: ["zqsecrettoken", "zqoutsider"], why: "a file symlink ships as its target string; the bytes behind it are never read" });
  }
  r1Case("r6-top-level-dir-name-that-is-a-file-is-scanned",
    { [R1_ROSTER]: R1_GOOD, [R1_RULE]: "hi\n", "scripts": "see /Users/zqscriptsowner/x\n" },
    { exit: 1, count: 1, shapes: ["operator-home-path"], why: "a regular file at a top-level synced directory name is scanned, not reported as an unreadable directory" });
  // Run IN PLACE from a copied scanner, so the scanner checkout has no roster either (a
  // --root scan would also read this checkout's roster and legitimately stay quiet).
  add("r6-no-roster-notice-is-loud-even-when-trust-tokens-keep-the-shape", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-r6-partial-"));
    try {
      const bin = copyScannerInto(tmp);
      fs.writeFileSync(path.join(tmp, ".claude", "trust-root.json"), '{"root_commit":"9f8e7d6c5b4a39281706f5e4d3c2b1a098765432"}');
      fs.mkdirSync(path.join(tmp, ".claude", "rules"), { recursive: true });
      fs.writeFileSync(path.join(tmp, ".claude", "rules", "x.md"), "anchored at 9f8e7d6c5b4a\n");
      const r = spawnSync(process.execPath, [bin, "--check"], { encoding: "utf8" });
      const loud = /operator-identity shape PARTIAL/.test(r.stderr || "");
      return { pass: r.status === 1 && loud, got: `exit ${r.status}, PARTIAL notice: ${loud}`, want: "the trust-root token still flags AND the missing roster is announced" };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  r1Case("r6-signer-map-key-and-record-fingerprint-both-harvested",
    { ".claude/trust-root.json": '{"root_commit":null,"signers":{"C0FFEE110123456789ABCDEF0123456789ABCDEF":{"person_id":"zqsigner6","fingerprint":"0A1B2C3D4E5F60718293A4B5C6D7E8F901234567","pubkey":"x"}}}', [R1_RULE]: "key C0FFEE110123456789ABCDEF0123456789ABCDEF\n" },
    { exit: 1, count: 1, why: "a record's own fingerprint does not shadow the map-key fingerprint" });
  r1Case("r6-non-object-person-record-refused",
    { [R1_ROSTER]: '{"persons":{"zqoprevsix":"Qwyx Brandlemore"}}', [R1_RULE]: "reviewed by Qwyx Brandlemore\n" },
    { exit: 2, output: /not an object/, why: "a person record that is not an object refuses instead of being dropped" });

  // ── Gap lane (2026-09-27): each was an executed escape (rc=0 or clear-text context) ─────
  // G1 — org forms the nonfoundation-org-slug shape did not recognise, and a mixed-case org.
  for (const [label, line] of [
    ["api-github-repos", "see https://api.github.com/repos/zqacmecorp/loom/pulls"],
    ["raw-githubusercontent", "curl https://raw.githubusercontent.com/zqacmecorp/kailash-py/main/x"],
    ["gitlab", "clone https://gitlab.com/zqacmecorp/loom.git"],
    ["ado-repo", "remote https://dev.azure.com/zqacmecorp/Platform/_git/loom"],
    ["ado-org-only", "az devops configure --defaults organization=https://dev.azure.com/zqacmecorp"],
    ["ado-ssh", "remote git@ssh.dev.azure.com:v3/zqacmecorp/Platform/coc-rs"],
    ["visualstudio-host", "remote https://zqacmecorp.visualstudio.com/Platform/_git/loom"],
    ["gh-api-leading-slash", "gh api /repos/zqacmecorp/loom/pulls"],
    ["gh-api-flags-repos", "gh api -X GET --paginate repos/zqacmecorp/loom/pulls"],
    ["gh-api-flags-orgs", "gh api --paginate orgs/zqacmecorp/members"],
    ["github-orgs-page", "see https://github.com/orgs/zqacmecorp/people"],
    ["mixed-case-org", "see https://github.com/ZqAcmeCorp/loom"],
    ["mixed-case-repo-flag", "gh pr list --repo ZqAcmeCorp/Kailash-Py"],
  ]) {
    r1Case(`g1-org-form-${label}-flags`, { [R1_ROSTER]: R1_GOOD, [R1_RULE]: line + "\n" },
      { exit: 1, count: 1, shapes: ["nonfoundation-org-slug"], noRaw: ["zqacmecorp"], why: "every host / API form of a third-party org naming a repo-family repo, and every org-level form, flags — case-blind" });
  }
  r1Case("g1-foundation-placeholder-and-third-party-urls-stay-clean",
    {
      [R1_ROSTER]: R1_GOOD,
      [R1_RULE]: [
        "https://api.github.com/repos/terrene-foundation/loom/pulls and https://github.com/orgs/Terrene-Foundation/projects/1",
        "gh api --paginate /repos/terrene-foundation/kailash-py/pulls",
        "origin=git@github.com:Org/loom.git and --repo Org/loom and https://github.com/ORG/loom",
        "https://gitlab.com/gitlab-org/cli and https://raw.githubusercontent.com/devcontainers/spec/main/x.json",
        "https://dev.azure.com/acme/core/_git/widget and https://someorg.visualstudio.com/Proj/_git/Repo-Fork",
        "organization=https://dev.azure.com/<org> and https://github.com/orgs/<your-org>/projects/<n>",
        "https://dev.azure.com/contoso/platform/_git/coc-rs and https://contoso.visualstudio.com/p/_git/loom",
      ].join("\n") + "\n",
    },
    { exit: 0, count: 0, why: "Foundation orgs, the Org/ORG placeholder, third-party non-family URLs and placeholder ADO orgs stay clean" });
  r1Case("g1-org-riding-behind-an-api-prefix-flags",
    { [R1_ROSTER]: R1_GOOD, [R1_RULE]: "https://api.github.com/repos/terrene-foundation/kailash-zqx-enterprise\n" },
    { exit: 1, count: 1, shapes: ["nonfoundation-org-slug"], noRaw: ["zqx-enterprise"], why: "the allowlisted first org does not carry a second org riding in the span, whatever the prefix" });
  // G2 — Windows home paths.
  for (const [label, rel, body] of [
    ["backslash", R1_RULE, "path C:\\Users\\zqwinop\\repos\\loom\n"],
    ["json-escaped", ".claude/rules/x.json", '{"p":"C:\\\\Users\\\\zqwinop\\\\repos"}\n'],
    ["forward-slash-capitalised", R1_RULE, "path C:/Users/Zqwinop/repos\n"],
    ["lower-case-root", R1_RULE, "path c:\\users\\zqwinop\\repos\n"],
    ["name-with-space", R1_RULE, "path C:\\Users\\Zqwin Opname\\repos\n"],
  ]) {
    r1Case(`g2-windows-home-${label}-flags`, { [R1_ROSTER]: R1_GOOD, [rel]: body },
      { exit: 1, count: 1, shapes: ["operator-home-path"], noRaw: ["zqwin"], why: "a Windows home in any separator form is an operator home path" });
  }
  r1Case("g2-windows-runner-and-placeholder-homes-stay-clean",
    { [R1_ROSTER]: R1_GOOD, [R1_RULE]: "C:\\Users\\runneradmin\\work and C:\\\\Users\\\\runneradmin\\\\w and C:\\Users\\<name>\\x and C:\\Users\\x\\y\n" },
    { exit: 0, count: 0, why: "the hosted Windows runner home, a <placeholder> and a one-character name stay clean, as on POSIX" });
  // G4 — a partially grouped fingerprint beside a real finding.
  {
    const fpRoster = '{"persons":{"zzqprobeuser":{"keys":[{"fingerprint":"0A1B2C3D4E5F60718293A4B5C6D7E8F901234567"}]}}}';
    for (const [label, cite, raw] of [
      ["spaced-groups", "0A1B 2C3D 4E5F 6071", ["2C3D", "4E5F"]],
      ["mixed-separators", "0A1B2C.3D4E5F_607182", ["0A1B2C", "3D4E5F"]],
      ["colon-pairs", "0A:1B:2C:3D:4E:5F", ["2C:3D", "4E:5F"]],
    ]) {
      r1Case(`g4-partial-fingerprint-${label}-masked-in-context`,
        { [R1_ROSTER]: fpRoster, [R1_RULE]: `/Users/zqrealop/x key ${cite} end\n` },
        { exit: 1, count: 1, shapes: ["operator-home-path"], noRaw: raw, why: "fingerprint groups beside a real finding are masked, not printed" });
    }
  }
  // G5 — a registry org's CASE decided whether the leaked registry was flagged.
  r1Case("g5-mixed-case-registry-org-is-flagged",
    {
      [R1_ROSTER]: R1_GOOD,
      ".claude/bin/ecosystem.json": '{"registry":{"org":"ZqOwnOrg"}}\n',
      ".claude/cross-repo-authz/2026-09-27-x.md": "cross-repo-authorized: zqownorg/widget read\n",
    },
    { exit: 1, count: 1, shapes: ["ecosystem-bare-org-slug"], noRaw: ["zqownorg"], why: "every org the registry can exempt as own is itself flagged when the registry leaks" });
  // G7 — a trust-root signer is a person, and since Tier-1 round 2 there is no
  // scrubber-path tolerance for the private org beside it either.
  r1Case("g7-signer-equal-to-private-org-flags-in-scrubber",
    {
      ".claude/trust-root.json": JSON.stringify({ root_commit: null, signers: { C0FFEE110123456789ABCDEF0123456789ABCDEF: { person_id: FIXTURE_ORG, pubkey: "x" } } }),
      ".claude/bin/lib/strip-build-internal.mjs": `// signed by ${FIXTURE_ORG}\n`,
    },
    { exit: 1, count: 2, shapes: ["nonfoundation-org-slug", "operator-identity-token"], needsCoherence: true, why: "a signer's tokens are person tokens AND the private literal beside them flags — no scrubber tolerance (measured 2 since Tier-1 round 2)" });
  // G9 — an unbounded SSH fingerprint body built a pattern V8 could not compile (SIGSEGV).
  {
    const b64 = "Qz9xW2vB7nM4kL1pR8sT6yU3iO5aE0dF2gH4jK6lZ8c";
    const body = b64.repeat(Math.ceil(6000 / b64.length)).slice(0, 6000);
    const roster = JSON.stringify({ persons: { zzqprobeuser: { keys: [{ fingerprint: `SHA256:${body}` }] } } });
    r1Case("g9-long-ssh-fingerprint-scan-completes-and-flags",
      { [R1_ROSTER]: roster, [R1_RULE]: `key ${body.slice(0, 24)} end\n` },
      { exit: 1, count: 1, shapes: ["operator-identity-token"], noRaw: [body.slice(8, 24)], why: "a long roster fingerprint neither crashes the scan nor goes unmatched" });
    r1Case("g9-long-ssh-fingerprint-clean-scan-completes",
      { [R1_ROSTER]: roster, [R1_RULE]: "hi\n" },
      { exit: 0, count: 0, output: /Scanned: 1 files/, why: "a long roster fingerprint does not crash a clean scan" });
    // At 200,000 characters the roster value is too large for V8 to compile into ANY pattern
    // ("Regular expression too large", thrown at first exec, its message quoting the whole
    // pattern). That is the crash fence's job: exit 3, message withheld — never a SIGSEGV with
    // no output, and never the token on stderr.
    const huge = b64.repeat(Math.ceil(200000 / b64.length)).slice(0, 200000);
    r1Case("g9-oversized-ssh-fingerprint-exits-3-and-withholds",
      { [R1_ROSTER]: JSON.stringify({ persons: { zzqprobeuser: { keys: [{ fingerprint: `SHA256:${huge}` }] } } }), [R1_RULE]: "hi\n" },
      { exit: 3, count: 0, output: /message withheld/, noRaw: [huge.slice(0, 16)], why: "an uncompilable identity pattern is a crashed scan (exit 3), and its message is withheld" });
  }

  // ── Re-review items (2026-09-27, second pass) ──────────────────────────────────────────
  // A scanner run with an optional PRELOAD and a hard timeout: a FIFO config read used to
  // HANG the scan, and a runner without a timeout would hang with it.
  const runScannerPlus = (root, { preload = null, env = {}, inPlaceBin = null } = {}) => {
    const argv = [...(preload ? [`--import=${preload}`] : []), inPlaceBin || SCANNER, "--check", ...(inPlaceBin ? [] : ["--root", root])];
    const r = spawnSync(process.execPath, argv, { encoding: "utf8", timeout: 30000, env: { ...process.env, ...env } });
    return { exit: r.status === null ? `killed(${r.signal})` : r.status, out: (r.stdout || "") + (r.stderr || "") };
  };
  const addPlus = (id, build, check) =>
    add(id, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "scan-n-"));
      try {
        const opts = build(root) || {};
        const res = runScannerPlus(root, opts);
        const problems = check(res, root);
        return { pass: problems.length === 0, got: problems.length ? problems.join(" | ") : `exit ${res.exit}`, want: opts.why || id };
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  const plant = (root, rel, body) => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (body && body.fifo) spawnSync("mkfifo", [f]);
    else if (body && body.symlinkTo) fs.symlinkSync(body.symlinkTo, f);
    else fs.writeFileSync(f, body);
  };
  // Item 1 — config files are read without following a link and without blocking on a FIFO.
  for (const [label, rel] of [
    ["roster", R1_ROSTER],
    ["tenant-denylist", ".claude/disclosure-tenant-denylist.json"],
    ["trust-root", ".claude/trust-root.json"],
    ["ecosystem", ".claude/bin/ecosystem.json"],
  ]) {
    addPlus(`n1-fifo-${label}-refused-not-hung`,
      (root) => { plant(root, rel, { fifo: true }); plant(root, R1_RULE, "hi\n"); return { why: "a FIFO config file refuses (exit 2), never hangs the scan" }; },
      (res) => [...(res.exit !== 2 ? [`exit ${res.exit}, want 2`] : []), ...(!/refused to read it: fifo/.test(res.out) ? ["refusal does not name the fifo kind"] : [])]);
  }
  {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "scan-n1-outside-"));
    fs.writeFileSync(path.join(outside, "deny.json"), '{"tokens":["Zqoutsidetenant"]}');
    fs.writeFileSync(path.join(outside, "trust.json"), '{"root_commit":null,"signers":{"C0FFEE110123456789ABCDEF0123456789ABCDEF":{"person_id":"zqoutsidesigner","pubkey":"x"}}}');
    fs.writeFileSync(path.join(outside, "eco.json"), '{"registry":{"org":"zqforeignorg"}}');
    for (const [label, rel, target, line] of [
      ["tenant-denylist", ".claude/disclosure-tenant-denylist.json", "deny.json", "hi Zqoutsidetenant\n"],
      ["trust-root", ".claude/trust-root.json", "trust.json", "hi zqoutsidesigner\n"],
      ["ecosystem", ".claude/bin/ecosystem.json", "eco.json", "hi\n"],
    ]) {
      r1Case(`n1-linked-${label}-refused-not-followed`,
        { [R1_ROSTER]: R1_GOOD, [rel]: { symlinkTo: path.join(outside, target) }, [R1_RULE]: line, ".claude/cross-repo-authz/2026-09-27-x.md": "cross-repo-authorized: zqforeignorg/widget read\n" },
        { exit: 2, count: 0, output: /refused to read it: symlink/, noRaw: ["zqforeignorg"], why: "a linked config file is refused, never read through the link" });
    }
    r1Case("n1-dangling-ecosystem-link-refused-not-absent",
      { [R1_ROSTER]: R1_GOOD, ".claude/bin/ecosystem.json": { symlinkTo: path.join(outside, "missing.json") }, [R1_RULE]: "hi\n" },
      { exit: 2, output: /ecosystem\.json present but unreadable/, why: "a dangling registry link is present-and-refused, not absent" });
  }
  // Item 2 — the check-then-read race. A preload replaces the file with a link to an
  // out-of-tree file at the last moment before the read (after its 2nd lstat, or at its first
  // open — whichever the scanner reaches). The out-of-tree bytes must never be read; the link's
  // TARGET STRING (which carries a synthetic home path here) is what is scanned.
  {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "scan-n2-outside-"));
    const secretDir = path.join(outside, "Users", "zqlinkowner");
    fs.mkdirSync(secretDir, { recursive: true });
    fs.writeFileSync(path.join(secretDir, "secret.md"), "zqsecretleakvalue /Users/zqoutsider/x\n");
    const preload = path.join(outside, "race.mjs");
    fs.writeFileSync(preload, [
      'import fs from "node:fs";',
      "const victim = process.env.RACE_VICTIM, target = process.env.RACE_TARGET;",
      "let lstats = 0, swapped = false;",
      "const swap = (p) => { if (swapped) return; swapped = true; fs.unlinkSync(p); fs.symlinkSync(target, p); process.stderr.write('RACE-SWAPPED\\n'); };",
      "const L = fs.lstatSync; fs.lstatSync = function (p, ...r) { const s = L.call(this, p, ...r); if (String(p).endsWith(victim) && ++lstats === 2) swap(p); return s; };",
      "const O = fs.openSync; fs.openSync = function (p, ...r) { if (String(p).endsWith(victim)) swap(p); return O.call(this, p, ...r); };",
      "",
    ].join("\n"));
    addPlus("n2-file-swapped-for-a-link-mid-scan-is-never-followed",
      (root) => {
        plant(root, R1_ROSTER, R1_GOOD);
        plant(root, ".claude/rules/victim.md", "clean text here\n");
        return { preload, env: { RACE_VICTIM: "rules/victim.md", RACE_TARGET: path.join(secretDir, "secret.md") }, why: "the bytes read are those of the object checked; a swapped-in link is scanned as its target string" };
      },
      (res) => [
        ...(!/RACE-SWAPPED/.test(res.out) ? ["the preload never swapped — the probe did not reach the read"] : []),
        ...(/zqsecretleakvalue|zqoutsider/i.test(res.out) ? ["OUT-OF-TREE bytes printed — the swapped link was followed"] : []),
        ...(res.exit !== 1 || !/\[SHAPE:operator-home-path\]/.test(res.out) ? [`exit ${res.exit}: the link's target string (a /Users/<name>/ path) was not scanned`] : []),
      ]);
  }
  // Item 3 — a scrubbed roster is announced even when trust-root tokens keep the shape alive.
  add("n3-placeholder-roster-notice-survives-trust-root-tokens", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-n3-"));
    try {
      const bin = copyScannerInto(tmp);
      plant(tmp, R1_ROSTER, '{"genesis":{"repo_owner":"PLACEHOLDER-owner"},"persons":{"PLACEHOLDER-owner":{"github_login":"PLACEHOLDER-owner"}}}');
      plant(tmp, ".claude/trust-root.json", '{"root_commit":"9f8e7d6c5b4a39281706f5e4d3c2b1a098765432"}');
      plant(tmp, R1_RULE, "hi\n");
      const r = runScannerPlus(tmp, { inPlaceBin: bin });
      const loud = /carries only PLACEHOLDER sentinels/.test(r.out);
      return { pass: r.exit === 0 && loud, got: `exit ${r.exit}, notice: ${loud}`, want: "a placeholder-only roster is announced whatever other tokens exist" };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  // Item 4 — the denylist / collision-registry skip is anchored to the path each is READ from.
  for (const rel of [".claude/rules/x/disclosure-tenant-denylist.json", ".claude/skills/z/disclosure-benign-collisions.json"]) {
    r1Case(`n4-nested-${path.basename(rel, ".json")}-is-scanned`,
      { [R1_ROSTER]: R1_GOOD, [rel]: '{"note":"/Users/zqnestedop/x"}\n' },
      { exit: 1, count: 1, shapes: ["operator-home-path"], noRaw: ["zqnestedop"], why: "a file merely NAMED like a declaration is tree content" });
  }
  r1Case("n4-root-declarations-stay-unscanned",
    { [R1_ROSTER]: R1_GOOD, ".claude/disclosure-tenant-denylist.json": '{"tokens":["Zqtenantq"]}\n', ".claude/disclosure-benign-collisions.json": '{"note":"/Users/zqnestedop/x"}\n', [R1_RULE]: "hi\n" },
    { exit: 0, count: 0, why: "the parsed declarations at the scan root are inputs, not content" });
  // Item 5 — a scrubbed trust root's placeholder signer is not an identity.
  r1Case("n5-placeholder-signer-is-not-an-identity",
    { [R1_ROSTER]: R1_GOOD, ".claude/trust-root.json": '{"root_commit":null,"signers":{"C0FFEE110123456789ABCDEF0123456789ABCDEF":{"person_id":"maintainer","pubkey":"PLACEHOLDER"}}}', [R1_RULE]: "the maintainers review it; ask a maintainer\n" },
    { exit: 0, count: 0, why: "neutralize placeholder words written into a signer are not identity tokens" });
  r1Case("n5-real-signer-still-flags",
    { [R1_ROSTER]: R1_GOOD, ".claude/trust-root.json": '{"root_commit":null,"signers":{"C0FFEE110123456789ABCDEF0123456789ABCDEF":{"person_id":"zqrealsigner","pubkey":"PLACEHOLDER"}}}', [R1_RULE]: "signed by zqrealsigner\n" },
    { exit: 1, count: 1, shapes: ["operator-identity-token"], why: "the placeholder filter does not drop a real signer" });
  // Item 6 — FIFOs in the walk are NAMED; a top-level link to a file is a file.
  addPlus("n6-fifo-in-walk-is-named-unread",
    (root) => { plant(root, R1_ROSTER, R1_GOOD); plant(root, R1_RULE, "hi\n"); plant(root, ".claude/rules/pipe.md", { fifo: true }); return { why: "a FIFO under the walk is named under UNREAD, never dropped" }; },
    (res) => [...(res.exit !== 0 ? [`exit ${res.exit}, want 0`] : []), ...(!/UNREAD: 1 collected file\(s\)[\s\S]*pipe\.md/.test(res.out) ? ["the FIFO is not named under UNREAD"] : [])]);
  addPlus("n6-top-level-link-to-a-file-is-scanned-as-a-file",
    (root) => {
      plant(root, R1_ROSTER, R1_GOOD); plant(root, R1_RULE, "hi\n");
      plant(root, "Users/zqtoplink/real.sh", "echo hi\n");
      plant(root, "scripts", { symlinkTo: path.join(root, "Users", "zqtoplink", "real.sh") });
      return { why: "a top-level synced name that links to a file is scanned as its target string, not reported as a directory" };
    },
    (res) => [
      ...(res.exit !== 1 || !/\[SHAPE:operator-home-path\]/.test(res.out) ? [`exit ${res.exit}: the link's target string was not scanned`] : []),
      ...(/and [1-9]\d* director\(y\/ies\) could NOT/.test(res.out) ? ["reported as an unreadable directory"] : []),
      ...(/zqtoplink/i.test(res.out) ? ["target string printed in clear"] : []),
    ]);
  r1Case("n6-signer-record-fingerprint-cited-flags",
    { ".claude/trust-root.json": '{"root_commit":null,"signers":{"C0FFEE110123456789ABCDEF0123456789ABCDEF":{"person_id":"zqsigner6","fingerprint":"0A1B2C3D4E5F60718293A4B5C6D7E8F901234567","pubkey":"x"}}}', [R1_RULE]: "key 0A1B2C3D4E5F60718293A4B5C6D7E8F901234567\n" },
    { exit: 1, count: 1, why: "a record's own fingerprint is harvested beside the map-key fingerprint (r6 X4, other half)" });
  // Item 7 — a regular-expression error raised during SHAPE LOADING is withheld too. The preload
  // raises one, quoting a tenant token, from `foldForGate`'s normalize() on that token.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-n7-"));
    const preload = path.join(dir, "regex-err.mjs");
    fs.writeFileSync(preload, [
      "const marker = 'Zqwithheldtok';",
      "const N = String.prototype.normalize;",
      "String.prototype.normalize = function (...a) { if (String(this).includes(marker)) throw new SyntaxError(`Invalid regular expression: /(?:${marker})/giu: Regular expression too large`); return N.apply(this, a); };",
      "",
    ].join("\n"));
    addPlus("n7-regexp-error-while-loading-shapes-is-withheld",
      (root) => { plant(root, R1_ROSTER, R1_GOOD); plant(root, ".claude/disclosure-tenant-denylist.json", '{"tokens":["Zqwithheldtok"]}'); plant(root, R1_RULE, "hi\n"); return { preload, why: "a config-phase regular-expression error prints its kind, never its pattern" }; },
      (res) => [
        ...(res.exit !== 2 ? [`exit ${res.exit}, want 2`] : []),
        ...(/zqwithheldtok/i.test(res.out) ? ["the token printed in the error message"] : []),
        ...(!/message withheld/.test(res.out) ? ["no withheld-message line — the preload did not reach shape loading"] : []),
      ]);
  }
  // Item 8 — a Windows absolute path in a settings matcher.
  for (const [label, entry] of [["json-escaped", "Edit(C:\\\\Users\\\\runneradmin\\\\x\\\\**)"], ["forward-slash", "Read(C:/Users/runneradmin/x/**)"]]) {
    r1Case(`n8-settings-windows-matcher-${label}-flags`,
      { [R1_ROSTER]: R1_GOOD, ".claude/settings.json": `{"permissions":{"allow":["${entry}"]}}\n` },
      { exit: 1, count: 1, shapes: ["settings-permission-absolute-path"], why: "an absolute Windows home in a permissions matcher is intrinsically wrong, whoever's it is" });
  }
  // ── Round-1 review of f5b74694a (M3/F1/F7, M4/F6, L3/L4, L5, F5) ──────────────────────────
  // Home paths now share the publish gate's definition (`makeHomepathRe`).
  for (const [label, rel, body] of [
    ["json-end-of-value", ".claude/rules/x.json", '{"home": "C:\\\\Users\\\\jdoezq"}\n'],
    ["windows-end-of-line", R1_RULE, "path C:\\Users\\jdoezq\n"],
    ["userprofile-assignment", R1_RULE, "USERPROFILE=C:\\Users\\Zqxqalice\n"],
    ["unc-share", R1_RULE, "\\\\zqserver\\c$\\Users\\jdoezq\\x\n"],
    ["short-8-3-name", R1_RULE, "C:\\Users\\JDOEZQ~1\\AppData\\Local\\Temp\\\n"],
    ["non-ascii-name", R1_RULE, "C:\\Users\\Jos\u00e9zq\\x\n"],
    ["apostrophe-name", R1_RULE, "C:\\Users\\O'Zqbrien\\x\n"],
    ["posix-end-of-line", R1_RULE, "at /Users/zqxqalice\n"],
    ["traversal-past-runner", R1_RULE, "C:\\Users\\runneradmin\\..\\Zqxqalice\\x\n"],
  ]) {
    r1Case(`r1b-home-${label}-flags`, { [R1_ROSTER]: R1_GOOD, [rel]: body },
      { exit: 1, count: 1, shapes: ["operator-home-path"], noRaw: ["jdoezq", "zqxqalice", "zqbrien", "jos\u00e9zq"], why: "every home form the publish gate recognises is a finding here too" });
  }
  r1Case("r1b-home-container-shared-and-placeholder-forms-stay-clean",
    {
      [R1_ROSTER]: R1_GOOD,
      [R1_RULE]: [
        "C:\\Users\\runneradmin\\w and C:\\Users\\<name>\\x and C:\\Users\\x\\y and C:\\Users\\Public\\x",
        "/home/dev/.cache and /home/vscode/.claude and /home/linuxbrew/.linuxbrew and /Users/me/x and the /home/ directory",
        "HOME=/home/dev and mockData/Users/Items/Records and `/Users/Shared` (macOS)",
        "      - uv-cache:/home/dev/.cache/uv",
        "    #   - ${HOME}/.claude:/home/vscode/.claude",
      ].join("\n") + "\n",
    },
    { exit: 0, count: 0, why: "container homes (incl. after a `name:` volume prefix), runner/Public/placeholder/one-character names and the PascalCase field-path form stay clean" });
  r1Case("r1b-home-container-name-does-not-cover-traversal",
    { [R1_ROSTER]: R1_GOOD, [R1_RULE]: "/home/dev/../zqxqalice/x\n" },
    { exit: 1, count: 1, shapes: ["operator-home-path"], why: "an allowlisted container home does not vouch for a traversal to another home" });
  // Quoted gh api endpoints, gh repo / -R / --repo= forms, enterprises, ADO DefaultCollection,
  // GitLab subgroups.
  for (const [label, line] of [
    ["gh-api-single-quoted-flags", "gh api --paginate 'repos/zqacmecorp/loom/issues'"],
    ["gh-api-double-quoted-slash", 'gh api "/repos/zqacmecorp/loom"'],
    ["gh-api-quoted-orgs", "gh api 'orgs/zqacmecorp/members'"],
    ["gh-repo-view-mixed-case", "gh repo view ZqAcmeCorp/Loom"],
    ["gh-R-mixed-case", "gh pr list -R ZqAcmeCorp/loom"],
    ["github-enterprises", "see https://github.com/enterprises/zqacmecorp/settings"],
    ["ado-default-collection", "https://zqacmecorp.visualstudio.com/DefaultCollection/Platform/_git/loom"],
    ["gitlab-subgroup", "https://gitlab.com/zqacmecorp/platform/loom.git"],
    ["gitlab-two-subgroups-ssh", "git@gitlab.com:zqacmecorp/platform/core/kailash-py.git"],
  ]) {
    r1Case(`r1b-org-form-${label}-flags`, { [R1_ROSTER]: R1_GOOD, [R1_RULE]: line + "\n" },
      { exit: 1, count: 1, shapes: ["nonfoundation-org-slug"], noRaw: ["zqacmecorp"], why: "each repo- or org-naming CLI / URL form flags" });
  }
  r1Case("r1b-org-forms-foundation-and-non-gh-R-stay-clean",
    { [R1_ROSTER]: R1_GOOD, [R1_RULE]: "gh api 'repos/terrene-foundation/loom' and gh repo clone terrene-foundation/kailash-py and https://gitlab.com/terrene-foundation/sub/loom and https://github.com/enterprises/terrene-foundation\ncp -R src/loom dist/\n" },
    { exit: 0, count: 0, why: "Foundation orgs in the new forms, and a non-gh `-R`, stay clean" });
  // L5 — a calendar date-time beside a finding stays readable; a fingerprint glued on still masks.
  r1Case("r1b-date-time-readable-in-context",
    { [R1_ROSTER]: R1_GOOD, [R1_RULE]: "/Users/zqrealop/ 2026-09-27 12:30\n" },
    { exit: 1, count: 1, output: /2026-09-27 12:30/, why: "a date-time beside a finding is not hex-group masked" });
  // F5 — the org-slug shape and the hex-group mask are linear on one very long line. 300k
  // characters: the quadratic forms measured ~3 s at 60k, so they would take well over this
  // runner's 30 s timeout here; the linear forms take well under a second.
  for (const [label, unit] of [["dashes", "ab-cd-"], ["hex", "a1b2c3d4e5f6"]]) {
    addPlus(`r1b-long-${label}-line-scans-in-linear-time`,
      (root) => { plant(root, R1_ROSTER, R1_GOOD); plant(root, R1_RULE, "/Users/zqrealop/x " + unit.repeat(Math.ceil(300000 / unit.length)) + "\n"); return { why: "a 300k-character line completes (linear shapes and mask)" }; },
      (res) => (res.exit === 1 ? [] : [`exit ${res.exit} — the scan did not complete within the timeout`]));
  }
  // ── Round-2 review of 22bd10531 ──────────────────────────────────────────────────────────
  // Item 1 — a symlinked ANCESTOR of a config file refuses the read.
  {
    const outBin = fs.mkdtempSync(path.join(os.tmpdir(), "scan-r2b-outbin-"));
    fs.writeFileSync(path.join(outBin, "ecosystem.json"), '{"registry":{"org":"zqforeign"}}');
    r1Case("r2b-linked-bin-ancestor-of-ecosystem-refused",
      { [R1_ROSTER]: R1_GOOD, ".claude/bin": { symlinkTo: outBin }, ".claude/cross-repo-authz/2026-09-28-x.md": "cross-repo-authorized: zqforeign/zqrepo read\n" },
      { exit: 2, output: /symlinked-ancestor/, why: "an out-of-tree registry reached through a linked ancestor never declares an org own" });
  }
  addPlus("r2b-linked-claude-ancestor-of-roster-refused",
    (root) => {
      plant(root, "real-claude/operators.roster.json", R1_GOOD);
      plant(root, "real-claude/rules/x.md", "hi\n");
      plant(root, ".claude", { symlinkTo: path.join(root, "real-claude") });
      return { why: "a roster reached through a linked `.claude` is refused" };
    },
    (res) => [...(res.exit !== 2 ? [`exit ${res.exit}, want 2`] : []), ...(!/symlinked-ancestor/.test(res.out) ? ["refusal does not name the linked ancestor"] : [])]);
  // Item 2 — only a regular FILE at the collision-registry path is skipped.
  r1Case("r2b-collisions-path-as-directory-is-walked",
    { [R1_ROSTER]: R1_GOOD, ".claude/disclosure-benign-collisions.json/x.md": "see /home/jdoezq/x\n", [R1_RULE]: "hi\n" },
    { exit: 1, count: 1, shapes: ["operator-home-path"], noRaw: ["jdoezq"], why: "a directory at the declaration path is tree content" });
  r1Case("r2b-collisions-path-as-link-is-scanned-as-target",
    { [R1_ROSTER]: R1_GOOD, ".claude/disclosure-benign-collisions.json": { symlinkTo: "/home/jdoezq/notes.json" }, [R1_RULE]: "hi\n" },
    { exit: 1, count: 1, shapes: ["operator-home-path"], noRaw: ["jdoezq"], why: "a link at the declaration path is scanned as its target string" });
  // Item 3 — quoted gh flag values holding a blank or a shell separator.
  for (const [label, line] of [
    ["jq-pipe", "gh api --jq '.[] | .name' repos/zqacmecorp/loom"],
    ["f-semicolon", "gh api -X PATCH -f 'body=a;b' repos/ZqAcmeCorp/loom/issues/1"],
    ["f-ampersand-orgs", "gh api -f 'q=a&b' orgs/zqacmecorp"],
    ["jq-double-quoted-orgs", 'gh api --jq ".[] | .x" orgs/ZqAcmeCorp'],
    ["repo-view-flag-value", 'gh repo view --json name "ZqAcmeCorp/loom"'],
  ]) {
    r1Case(`r2b-gh-${label}-flags`, { [R1_ROSTER]: R1_GOOD, [R1_RULE]: line + "\n" },
      { exit: 1, count: 1, shapes: ["nonfoundation-org-slug"], noRaw: ["zqacmecorp"], why: "a quoted flag value does not hide the endpoint after it" });
  }
  r1Case("r2b-gh-foundation-after-flag-values-stays-clean",
    { [R1_ROSTER]: R1_GOOD, [R1_RULE]: "gh repo view --json name terrene-foundation/loom and gh api --jq '.[] | .name' repos/terrene-foundation/loom\n" },
    { exit: 0, count: 0, why: "the org is read after the flag values, not from them" });
  addPlus("r2b-many-gh-commands-on-one-line-scan-in-linear-time",
    (root) => { plant(root, R1_ROSTER, R1_GOOD); plant(root, R1_RULE, "/Users/zqrealop/x " + "gh pr ".repeat(50000) + "\n"); return { why: "a 300k line of repeated gh commands completes" }; },
    (res) => (res.exit === 1 ? [] : [`exit ${res.exit} — the scan did not complete within the timeout`]));
  // Item 4 — a drive-shaped prefix never lets the PascalCase entry vouch for a capitalised name.
  for (const [label, line] of [["underscore", "x_C:/Users/Jdoezq/file"], ["alnum", "vol1D:/Users/Jdoezq/file"]]) {
    r1Case(`r2b-drive-prefix-after-${label}-flags`, { [R1_ROSTER]: R1_GOOD, [R1_RULE]: line + "\n" },
      { exit: 1, count: 1, shapes: ["operator-home-path"], noRaw: ["jdoezq"], why: "a capitalised name after a drive-shaped prefix is a home" });
  }
  // Round-2 security — a spaced home name is masked whole in context.
  for (const [label, line, raw] of [
    ["comma", "profile at C:\\Users\\Zqjohn Zqdoe, then", "zqdoe"],
    ["path-list", "PATH=C:\\Users\\Zqjohn Zqdoe;C:\\Windows", "zqdoe"],
    ["particles", "at C:\\Users\\Zqmaria de la Zqcruz Zqlopez, ok", "zqcruz"],
    // The lib (528ee01f7) now takes a spaced WINDOWS name whole, which absorbs the three cases
    // above; the POSIX arm never takes a space, so only the scanner's context-mask extension
    // hides the words after an unterminated POSIX home. This is the case that discriminates it.
    ["posix-following-words", "at /Users/zqjohn zqdoe more words here", "zqdoe"],
  ]) {
    r1Case(`r2b-spaced-home-${label}-masked-whole`, { [R1_ROSTER]: R1_GOOD, [R1_RULE]: line + "\n" },
      { exit: 1, count: 1, shapes: ["operator-home-path"], noRaw: [raw], why: "the words after an unterminated spaced home are masked" });
  }
  r1Case("n8-settings-relative-matchers-stay-clean",
    { [R1_ROSTER]: R1_GOOD, ".claude/settings.json": '{"permissions":{"allow":["Edit($CLAUDE_PROJECT_DIR/x/**)","Edit(./src/**)"]}}\n' },
    { exit: 0, count: 0, why: "relative and project-rooted matchers stay clean" });
  // The orphaned-control reaper (see § Orphaned-control reaping at the top). The
  // source pole plants a synthetic operator-home leak at a NON-gitignored path in
  // the live rule corpus and removes it ~ms later; a SIGKILL in that window orphans
  // it, where a `git add -A` would commit it. A `.gitignore` cannot fix this — the
  // source scan SKIPS gitignored+untracked files, so ignoring the control DISARMS
  // it — hence reaping.
  //
  // BIPOLAR on the property that actually matters, which is NOT "does rm work" but
  // "does it reap ONLY dead runs". Reaping a LIVE run's control would recreate the
  // fixed-path race the per-PID naming was introduced to kill, in the false-green
  // direction. PID 1 is the live pole: it always exists and is owned by another
  // user, so it exercises the EPERM arm of `pidAlive` — the arm that would return
  // "dead" if someone simplified the catch to a bare `return false`.
  // The relocation itself. The source pole's control used to be planted at
  // `.claude/rules/<tag>-control.md`, which made it an always-on rule with no
  // `paths:` for as long as it existed — so `check-rule-injection-budget.mjs`
  // counted it across all 8 session profiles. OBSERVED: a concurrent budget check
  // went RED with three failures (UNLEDGERED_RULE, NEW_BROAD_LOAD, and a
  // PROFILE_OVER_LEVEL naming a real profile and a plausible 50 B of growth), none
  // of which hinted at a fixture race, and none of which reproduced on re-run.
  //
  // THIS IS A SOURCE ASSERTION, and deliberately so — the same disposition, for the
  // same reason, as `RS-16-false-public-product-allowlist-entry-absent` above. The
  // property is "the plant never lands in the corpus another instrument MEASURES",
  // and the plant is transient WITHIN the source pole, so a before/after listing of
  // `.claude/rules/` taken from out here cannot observe it: the window opens and
  // closes inside one function call. Polling for it would make this case racy and
  // its failure non-deterministic — the very diagnostic shape the relocation exists
  // to remove. The BEHAVIOURAL halves are covered elsewhere and are what make this
  // safe to assert structurally: `gitignored-payload-not-on-synced-surface` proves
  // the control still FLAGS at the new path (so relocating did not disarm it), and
  // `orphaned-controls-reaped-only-when-their-pid-is-dead` proves both locations are
  // swept.
  add("source-pole-control-is-not-planted-in-the-rule-corpus", () => {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
    // The exact shape the defect had: a control path joined under "rules".
    const inRules = /const\s+control\s*=\s*path\.join\(\s*REPO_ROOT\s*,\s*"\.claude"\s*,\s*"rules"/.test(src);
    // The shape it must have: a control DIRECTORY under `.claude/`, not under rules.
    const controlDirOutsideRules =
      /const\s+controlDir\s*=\s*path\.join\(\s*REPO_ROOT\s*,\s*"\.claude"\s*,\s*`\$\{tag\}-control`\s*\)/.test(src);
    const problems = [];
    if (inRules) problems.push("the source pole plants its control INTO .claude/rules/ — it charges all 8 session profiles while it exists and can red a concurrent check-rule-injection-budget run with a failure that does not reproduce");
    if (!controlDirOutsideRules) problems.push("the control is no longer planted at `.claude/<tag>-control/` — if it moved again, re-derive which instruments measure the new location before trusting this case");
    return {
      pass: problems.length === 0,
      got: problems.length ? problems.join(" | ") : "control planted at .claude/<tag>-control/, outside the rule corpus check-rule-injection-budget measures",
      want: "the source pole never writes into .claude/rules/",
    };
  });

  add("scan-tree-sibling-refuses-inside-a-work-tree", () => {
    // loom#D2 — BIPOLAR on the placement predicate: it must ACCEPT a parent outside
    // every work tree and REFUSE one inside, naming the enclosing top. Only the second
    // half is interesting to a reviewer, but a predicate that refuses everything would
    // satisfy it alone, so both are exercised in one case.
    const repoRoot = path.resolve(HERE, "..", "..", "..");
    const problems = [];

    // GREEN pole — the real parent, which every normal run has.
    try {
      assertSiblingParentOutsideWorkTree(path.dirname(repoRoot));
    } catch (e) {
      problems.push(`the real parent ${path.dirname(repoRoot)} was refused, so the fixture can never run from here: ${e.message}`);
    }

    // RED pole — a directory INSIDE this checkout, which is exactly what a nested
    // worktree's parent is.
    const inside = path.join(repoRoot, ".claude");
    let threw = null;
    try {
      assertSiblingParentOutsideWorkTree(inside);
    } catch (e) {
      threw = e;
    }
    if (!threw) {
      problems.push("a parent INSIDE a work tree was accepted — in a nested worktree the scan tree would be minted inside the enclosing repo");
    } else if (!threw.message.includes(repoRoot)) {
      problems.push(`the refusal does not NAME the enclosing work tree, so a reader cannot tell where it would have landed: ${threw.message}`);
    }

    return {
      pass: problems.length === 0,
      got: problems.length ? problems.join(" | ") : "outside-every-work-tree parent accepted; inside-a-work-tree parent refused naming the enclosing top",
      want: "the sibling is placed only where no repo can see it",
    };
  });

  add("orphaned-scan-trees-reaped-only-when-dead-and-past-the-floor", () => {
    // loom#D1 — the materialized source tree is a SECOND residual class, minted as a
    // SIBLING of the checkout where the control reaper cannot see it. BIPOLAR on ALL
    // THREE conditions of the policy it inherits from `_lib/test-temp.mjs`, because a
    // pair that tested only "does rm work" would be satisfied by a reaper that deletes
    // live runs and young trees alike — the failure direction that destroys another
    // process's work.
    const repoRoot = path.resolve(HERE, "..", "..", "..");
    const parent = path.dirname(repoRoot);
    const base = `zz-d1-${process.pid}`;
    // Synthetic ages rather than waiting six hours — the same technique the helper's
    // own sweep documents for exercising its two conditions.
    const old = (Date.now() - SCAN_TREE_FLOOR_MS - 3600_000) / 1000;
    const deadOld = path.join(parent, `.${base}-scan-fixture-99999999`);
    const deadOldIndex = path.join(parent, `.${base}-scan-fixture-99999999.index`);
    const deadYoung = path.join(parent, `.${base}-scan-fixture-99999998`);
    const liveOld = path.join(parent, `.${base}-scan-fixture-1`);
    const planted = [deadOld, deadOldIndex, deadYoung, liveOld];
    try {
      if (pidAlive(99999999) || pidAlive(99999998)) return { pass: false, got: "a supposedly-dead PID is alive on this host", want: "reliably-dead PIDs for the orphan poles" };
      if (!pidAlive(1)) return { pass: false, got: "PID 1 reported dead — pidAlive's EPERM arm is broken", want: "PID 1 recognised as alive" };

      fs.mkdirSync(deadOld, { recursive: true });
      fs.writeFileSync(deadOldIndex, "x");
      fs.mkdirSync(deadYoung, { recursive: true });
      fs.mkdirSync(liveOld, { recursive: true });
      // Backdate all but `deadYoung`, whose FRESH mtime is the floor pole.
      for (const p of [deadOld, deadOldIndex, liveOld]) fs.utimesSync(p, old, old);

      const r = reapOrphanedScanTrees();

      const problems = [];
      if (fs.existsSync(deadOld)) problems.push("the DEAD run's orphaned scan TREE survived — this is the SIGKILL leak the case exists for");
      if (fs.existsSync(deadOldIndex)) problems.push("the DEAD run's orphaned `.index` survived — a fence that knows only the directory leaves this half behind");
      if (!r.reaped.some((n) => n.includes("99999999"))) problems.push("the orphan was removed but not REPORTED at its own path");
      if (!fs.existsSync(deadYoung)) problems.push("a tree YOUNGER than the floor was reaped — a pid can be recycled onto a live process, so age is the second condition, not decoration");
      if (!r.keptYoung.some((n) => n.includes("99999998"))) problems.push("the young tree was kept but not reported as kept-young");
      if (!fs.existsSync(liveOld)) problems.push("a LIVE run's tree was reaped — the false-green race, in the direction that deletes another process's work");
      if (!r.skippedLive.some((n) => n.endsWith("-scan-fixture-1"))) problems.push("the live tree was spared but not reported");

      return {
        pass: problems.length === 0,
        got: problems.length ? problems.join(" | ") : "dead+old tree AND its .index reaped; dead+young and live+old both kept, each reported in its own bucket",
        want: "ownership AND age together — never either alone, and never a live or young tree",
      };
    } finally {
      for (const p of planted) {
        try {
          fs.rmSync(p, { recursive: true, force: true });
        } catch {
          /* best-effort teardown */
        }
      }
    }
  });

  add("orphaned-controls-reaped-only-when-their-pid-is-dead", () => {
    const claudeDir = path.resolve(HERE, "..", "..");
    const rulesDir = path.join(claudeDir, "rules");
    const deadName = "zz-disclosure-fixture-99999999-control.md";
    const liveName = "zz-disclosure-fixture-1-control.md";
    const dead = path.join(rulesDir, deadName);
    const live = path.join(rulesDir, liveName);
    // The CURRENT location, which the legacy-only reaper would miss entirely.
    const deadDir = path.join(claudeDir, "zz-disclosure-fixture-99999999-control");
    const leak = "see /Users/fakeuser/reaper-case-secret/repos for details\n";
    try {
      // Precondition: 99999999 must really be dead and 1 really alive, or this
      // case proves nothing about the predicate.
      if (pidAlive(99999999)) return { pass: false, got: "PID 99999999 is alive on this host", want: "a reliably-dead PID for the orphan pole" };
      if (!pidAlive(1)) return { pass: false, got: "PID 1 reported dead — pidAlive's EPERM arm is broken", want: "PID 1 recognised as alive" };

      fs.writeFileSync(dead, leak);
      fs.writeFileSync(live, leak);
      fs.mkdirSync(deadDir, { recursive: true });
      fs.writeFileSync(path.join(deadDir, "control.md"), leak);
      const r = reapOrphanedControls();

      const problems = [];
      // CURRENT location — the one the relocation moved the control to.
      if (fs.existsSync(deadDir)) problems.push("the DEAD run's orphan at the CURRENT location survived — the reaper is still only sweeping the legacy path");
      if (!r.reaped.includes(`.claude/zz-disclosure-fixture-99999999-control`)) problems.push("the current-location orphan was removed but not REPORTED at its own path");
      // LEGACY location — orphans predating the relocation still sit in the rule
      // corpus, and those are the ones that charge all 8 session profiles.
      if (fs.existsSync(dead)) problems.push("the DEAD run's LEGACY orphan survived in .claude/rules/ — it still charges every session profile and can red a concurrent budget check");
      if (!r.reaped.includes(`.claude/rules/${deadName}`)) problems.push("the legacy orphan was removed but not REPORTED at its own path");
      // The race guard, in both sweeps.
      if (!fs.existsSync(live)) problems.push("a LIVE run's control was reaped — this reintroduces the fixed-path race the per-PID naming exists to kill, in the false-green direction");
      if (!r.skippedLive.includes(`.claude/rules/${liveName}`)) problems.push("the live control was spared but not reported");

      return {
        pass: problems.length === 0,
        got: problems.length
          ? problems.join(" | ")
          : "dead-PID orphans REAPED and reported at BOTH the current (.claude/) and legacy (.claude/rules/) locations; live-PID control left untouched and reported",
        want: "orphaned controls from dead runs are reaped and announced at both locations; a live run's control is never touched",
      };
    } finally {
      // This case owns all three paths; remove them whatever happened.
      rmControlPath(dead, { force: true });
      rmControlPath(live, { force: true });
      rmControlPath(deadDir, { recursive: true, force: true });
    }
  });

  for (const c of named) {
    let res;
    try {
      res = c.fn();
    } catch (e) {
      res = { pass: false, got: `threw: ${e.message}`, want: "no throw" };
    }
    if (res && res.skip) {
      // A scenario whose SUBJECT cannot exist in this tree says so by name —
      // an empty/not-run outcome must never borrow the grammar of a pass
      // (`conservation-gate.md` MUST-4), and must not count as a failure
      // either (`evidence-first-claims.md` MUST-3: an instrument that could
      // not run is not a verdict about the scanner).
      console.log(`SKIP  ${c.id}  (${res.skip})`);
    } else if (res.pass) {
      console.log(`PASS  ${c.id}  (${res.got})`);
    } else {
      failed++;
      console.log(`FAIL  ${c.id}`);
      console.log(`        - want: ${res.want}`);
      console.log(`        - got:  ${res.got}`);
    }
  }
}

// Cross-check the inventory in the other direction: a case dir present on disk
// but absent from CASES is an orphan that no assertion covers. The
// EXPECTED_PAYLOADS check above closes "declared but gone"; this closes
// "present but undeclared" — without it the corpus can grow surface that looks
// covered and is not.
let orphanDirs = 0;
{
  const declaredDirs = new Set(CASES.map((c) => c.dir));
  for (const entry of fs.readdirSync(HERE, { withFileTypes: true })) {
    if (!entry.isDirectory() || declaredDirs.has(entry.name)) continue;
    failed++;
    orphanDirs++;
    console.log(`FAIL  ${entry.name}  [ORPHAN FIXTURE DIR]`);
    console.log(
      `        - present on disk but declared in no CASES entry — it asserts nothing`,
    );
  }
}

// STRIP-SEC-1 (Tier-1, 2026-10-04 round 2): the LOUD-config contract, restated
// for the LAZY design (F1/F4/L1). What must hold:
//   • IMPORT NEVER THROWS — at loom, at a config-less coc-source fork, at a
//     consumer: the scanner and coc-manifest imports must resolve so
//     `/ecosystem-init` can run in a tree with no canon identity yet.
//   • orgSets() THROWS (on first USE) for a present-but-UNREADABLE declaration
//     (malformed JSON, non-string entry, invalid org value) — never a silent [].
//     A MISSING file is the benign EMPTY case (a fork before init).
//   • assertPrivateOrgConfig() THROWS at DISTRIBUTION TIME when the private set
//     is empty, whatever the cause — the one place the guarantee may not
//     silently degrade.
//   • M1 arms: `a` (1 char), `is` and `to` (short words) are REJECTED values —
//     measured on the frozen bytes, these loaded and turned "This is a test"
//     into "This is <org> test".
// Rendered in scratch LOOM-SHAPED copies (`.claude/VERSION::type = coc-source`
// + a chosen canon-identity declaration + the lib copied in); every temp tree is
// removed at the end of its probe (L4: the runner used to leak six of them).
{
  const problems = [];
  const srcLib = path.resolve(HERE, "..", "..", "bin", "lib");
  const mkTree = (identityText, versionText) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strip-sec1-"));
    fs.mkdirSync(path.join(dir, ".claude", "bin", "lib"), { recursive: true });
    if (versionText !== null) {
      fs.writeFileSync(path.join(dir, ".claude", "VERSION"), versionText);
    }
    if (identityText !== null) {
      fs.writeFileSync(path.join(dir, ".claude", "canon-identity-values.json"), identityText);
    }
    fs.cpSync(srcLib, path.join(dir, ".claude", "bin", "lib"), { recursive: true });
    // The scanner entry itself, for the fork import regression (item 4): both
    // shipped readers must resolve in a config-less coc-source tree. It pulls
    // one module from outside bin/lib at load (`../hooks/lib/git-subprocess-env.js`
    // via createRequire), so the fork shape needs that file too.
    fs.mkdirSync(path.join(dir, ".claude", "hooks", "lib"), { recursive: true });
    fs.copyFileSync(
      path.resolve(HERE, "..", "..", "hooks", "lib", "git-subprocess-env.js"),
      path.join(dir, ".claude", "hooks", "lib", "git-subprocess-env.js"),
    );
    fs.copyFileSync(
      path.resolve(HERE, "..", "..", "bin", "scan-synced-disclosure.mjs"),
      path.join(dir, ".claude", "bin", "scan-synced-disclosure.mjs"),
    );
    return dir;
  };
  const probeTree = (identityText, versionText) => {
    const dir = mkTree(identityText, versionText);
    const r = spawnSync(
      "node",
      [
        "-e",
        `import(${JSON.stringify(path.join(dir, ".claude", "bin", "lib", "strip-build-internal.mjs"))})` +
          `.then((m) => {` +
          `  const out = ["LOADED"];` +
          `  try { out.push("sets=" + JSON.stringify(m.orgSets())); } catch (e) { out.push("orgSets THREW: " + e.message); }` +
          `  try { out.push("assert=" + JSON.stringify(m.assertPrivateOrgConfig())); } catch (e) { out.push("assert THREW: " + e.message); }` +
          `  console.log(out.join(" | "));` +
          `}).catch((e) => { console.error("IMPORT THREW " + e.message); process.exit(3); });`,
      ],
      { encoding: "utf8" },
    );
    fs.rmSync(dir, { recursive: true, force: true });
    return r;
  };
  const loomVersion = JSON.stringify({ type: "coc-source" });
  const valid = '{"private_org_slugs":["northwind-labs"],"public_org_slugs":["terrene-foundation"]}';
  const expect = (label, r, fn) => {
    const out = (r.stdout || "") + (r.stderr || "");
    const why = fn(out, r.status);
    if (why) problems.push(`loom/${label}: ${why} out=${out.slice(0, 200)}`);
  };
  // 1. Valid config: loads, derives, asserts — the happy pole.
  expect("valid", probeTree(valid, loomVersion), (out, rc) =>
    rc === 0 && /LOADED/.test(out) && out.includes('"northwind-labs"') && /assert=\["northwind-labs"\]/.test(out)
      ? ""
      : `expected LOADED + the derived set + a passing assert, got rc=${rc}`,
  );
  // 2. MISSING config at loom: import succeeds (F1), sets empty, ASSERT throws.
  expect("missing-config", probeTree(null, loomVersion), (out, rc) =>
    rc === 0 && /LOADED/.test(out) && /"private":\[\]/.test(out) && /assert THREW: .*EMPTY/.test(out)
      ? ""
      : `expected LOADED + empty sets + an assert throw, got rc=${rc}`,
  );
  // 3. Malformed JSON: import succeeds; orgSets() throws naming "unparseable".
  expect("malformed-config", probeTree("{ not json", loomVersion), (out, rc) =>
    rc === 0 && /LOADED/.test(out) && /orgSets THREW: .*unparseable/.test(out)
      ? ""
      : `expected LOADED + an orgSets throw naming unparseable, got rc=${rc}`,
  );
  // 4. Non-string entry: throws (F4), never skipped silently.
  expect("non-string-entry", probeTree('{"private_org_slugs":["ok-slug",5]}', loomVersion), (out, rc) =>
    rc === 0 && /LOADED/.test(out) && /orgSets THREW: .*NON-STRING/.test(out)
      ? ""
      : `expected LOADED + a NON-STRING throw, got rc=${rc}`,
  );
  // 5. M1 arms — the measured short-word offenders must each be REJECTED.
  for (const [label, value] of [["one-char", "a"], ["stopword-is", "is"], ["stopword-to", "to"]]) {
    expect(label, probeTree(`{"private_org_slugs":["${value}"]}`, loomVersion), (out, rc) =>
      rc === 0 && /LOADED/.test(out) && /orgSets THREW: .*INVALID org value/.test(out)
        ? ""
        : `expected LOADED + an INVALID-org-value throw, got rc=${rc}`,
    );
  }
  // 6. Consumer shape (no VERSION) with no config: loads with EMPTY sets — the
  //    /ecosystem-init fork shape; the scanner must START there (import only —
  //    orgSets on the absent file is the benign empty case).
  expect("consumer-fork", probeTree(null, null), (out, rc) =>
    rc === 0 && /LOADED/.test(out) && /"private":\[\]/.test(out)
      ? ""
      : `expected LOADED + empty sets, got rc=${rc}`,
  );
  // 7. THE FORK REGRESSION (item 4): in the config-less coc-source fork shape
  //    the strip reader IMPORTS cleanly and the SCANNER STARTS. The two are
  //    probed differently on purpose: importing the scanner module EXECUTES its
  //    main under `node -e` (no resolvable argv[1] for the isMainModule guard),
  //    so the scanner half runs it as a CLI and asserts a real scan RECEIPT —
  //    a run, not a bare import, is what `/ecosystem-init` needs to observe.
  {
    const dir = mkTree(null, loomVersion);
    const stripProbe = spawnSync(
      "node",
      [
        "-e",
        `import(${JSON.stringify(path.join(dir, ".claude", "bin", "lib", "strip-build-internal.mjs"))})` +
          `.then(() => console.log("STRIP-LOADED"))` +
          `.catch((e) => { console.error("IMPORT THREW " + e.message); process.exit(3); });`,
      ],
      { encoding: "utf8" },
    );
    const scanProbe = spawnSync(
      "node",
      [path.join(dir, ".claude", "bin", "scan-synced-disclosure.mjs"), "--check", "--root", dir],
      { encoding: "utf8" },
    );
    fs.rmSync(dir, { recursive: true, force: true });
    if (stripProbe.status !== 0 || !/STRIP-LOADED/.test(stripProbe.stdout || "")) {
      problems.push(
        `fork-shaped strip import: expected STRIP-LOADED, got rc=${stripProbe.status} out=${((stripProbe.stdout || "") + (stripProbe.stderr || "")).slice(0, 160)}`,
      );
    }
    // A REAL VERDICT, not a crash: rc 0 or 1 (the scratch tree contains the
    // copied lib fixtures, so findings are legitimate here) WITH the RAN-signal
    // appropriate to ITS OWN polarity. Exit 2/3 would mean the scanner failed to
    // start, which is the failure this regression exists to catch. The receipt
    // is polarity-keyed on purpose: `Scanned: N files … 0 findings` IS the clean
    // line and is printed ONLY on rc=0, so a findings-bearing run proves it ran
    // through the findings header instead (an earlier revision required the
    // clean-line receipt on BOTH polarities, which no rc=1 run can satisfy).
    const scanOut = (scanProbe.stdout || "") + (scanProbe.stderr || "");
    const ranSignal =
      scanProbe.status === 0
        ? /Scanned: \d+ files/.test(scanOut)
        : /\d+ disclosure finding\(s\) on the synced surface/.test(scanOut);
    if ((scanProbe.status !== 0 && scanProbe.status !== 1) || !ranSignal) {
      problems.push(`fork-shaped scanner start: expected rc∈{0,1} with its ran-signal, got rc=${scanProbe.status} out=${scanOut.slice(0, 160)}`);
    }
  }
  if (problems.length) {
    failed++;
    console.log("FAIL  STRIP-SEC-1 loom-loud-config");
    for (const p of problems) console.log(`        - ${p}`);
  } else {
    console.log("PASS  STRIP-SEC-1 loom-loud-config  (lazy contract: import never throws; 1 happy + missing/malformed/non-string/3 M1 arms + consumer fork + both-imports regression)");
  }
}

console.log("");
if (failed) {
  // Attribute precisely. Reporting a corpus defect as "scanner regressed" is
  // the exact mis-attribution the EXPECTED_PAYLOADS inventory exists to remove,
  // so the summary must not re-introduce it one line further down.
  const corpus = inputsMissing + orphanDirs;
  if (corpus) {
    const parts = [];
    if (inputsMissing) parts.push(`${inputsMissing} for MISSING INPUT`);
    if (orphanDirs) parts.push(`${orphanDirs} for an ORPHAN FIXTURE DIR`);
    console.log(
      `${failed} fixture(s) FAILED — ${parts.join(" and ")}, i.e. a FIXTURE-CORPUS ` +
        `defect, NOT a scanner regression. Fix the corpus first, then re-read the rest.`,
    );
  } else {
    console.log(`${failed} fixture(s) FAILED — scanner regressed`);
  }
  process.exit(1);
}
console.log("all fixtures passed");
process.exit(0);
