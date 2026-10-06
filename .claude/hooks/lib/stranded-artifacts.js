"use strict";
/**
 * stranded-artifacts.js — the pure predicate behind `stranded-artifact-guard.js`.
 *
 * THE FAILURE CLASS. A COC artifact (rule / agent / skill / command / hook) or a
 * global-guidance artifact (spec, session-notes, burndown, journal) is authored,
 * committed, and then LEFT on a branch that never reaches the default branch.
 * It exists. It is reflog-safe. It governs NOTHING outside the one working tree
 * that holds it. Measured instances that motivated this file, each found by a
 * different party and none by review:
 *
 *   - a guard at 27/27 fixtures that protected nothing, because it sat on an
 *     unmerged branch;
 *   - `worktree-isolation.md` Rule 4a, authored and committed the same day,
 *     present on ONE branch and absent from `origin/main` and from every lane
 *     worktree — so the lane that reported "there is no Rule 4a" was RIGHT;
 *   - a lifecycle mechanism shipped with `open`/`retire`/`gate`/`invariant` and
 *     no caller — "a correct mechanism with no producer".
 *
 * The shape is one shape: authored ≠ in force. This module answers the single
 * structural question that separates them.
 *
 * AND "IN FORCE" IS A CONTENT PROPERTY, NOT A REACHABILITY ONE (loom#1886).
 * This file decided stranding on `merge-base --is-ancestor` alone until
 * 2026-08-21. Ancestry answers "is this commit OBJECT on the trunk", which is
 * not the question: a branch that was rebased, squashed, cherry-picked, or
 * merged-only carries different commit objects and IDENTICAL bytes, so it reads
 * as unreachable and every artifact on it was reported as governing nothing.
 * MEASURED against loom's own 294 local branches: 214 of 530 reported paths
 * (40.4%) were byte-identical at `origin/main` at the moment the guard called
 * them "AUTHORED but NOT IN FORCE anywhere else". A surface wrong two times in
 * five teaches its reader to skip it, and then its true findings lose their
 * audience — which is the cost, since this guard never blocks.
 *
 * The verdict is therefore an INTERSECTION of two structural facts: the
 * three-dot range says this branch AUTHORED the path, and a tip-to-tip tree
 * comparison says the base does not already hold those bytes. See § CONTENT,
 * NOT ANCESTRY at the intersection site for why the two-dot form is correct for
 * the second question while remaining BLOCKED for the first.
 *
 * AND BOTH ARE SECOND TO RECORDED PROVENANCE (landing-provenance). A tree
 * comparison still misreports once landing rewrites content: a conflict-resolved
 * landing leaves bytes that differ from the branch's, and a plain cherry-pick
 * of a never-landed branch leaves identical ones. When the caller supplies
 * `landedVerdictFor` (the guard wires `landed-map.js::landedVerdict` over ONE
 * map per invocation), the verdict the lander RECORDED is asked first, and the
 * ancestry + tree path runs only where that verdict returns `fallback:true`.
 * See § RECORDED PROVENANCE FIRST in `findStrandedArtifacts`.
 *
 * WHY THIS IS A STRUCTURAL SIGNAL, NOT A LEXICAL ONE (hook-output-discipline.md
 * MUST-5). Every input is a git-object fact or a path membership test:
 * `merge-base --is-ancestor` is reachability, `diff --name-only base...HEAD` is
 * the three-dot authorship range (`evidence-first-claims.md` MUST-5 — the
 * two-dot form renders base's newer commits as reversions and is BLOCKED as an
 * authorship range), `diff --name-only base ref` is a tree comparison, and the
 * artifact classification is a path-prefix match against a POSITIVE allowlist
 * (`cc-artifacts.md` Rule 10 — an enumerable vocabulary, so a denylist would
 * never close the class). No regex reads prose; no surface rewrite changes an
 * answer.
 *
 * WHAT IT STILL CANNOT SEE, stated so no reader over-reads the verdict:
 *   - an artifact that landed on the base and was then EVOLVED there still
 *     reports, because its bytes genuinely are not in force (pinned as a
 *     KNOWN LIMIT case in the fixtures, not left to be rediscovered);
 *   - a defect fixed on the base by a DIFFERENT mechanism, where this branch's
 *     commit is both absent and unnecessary;
 *   - anything at all when the content pass could not run — that degrades to
 *     the ancestry figure, rendered as an explicit UPPER BOUND.
 *
 * BOTH RECOGNIZERS ARE SHARED, AND THIS MODULE OWNS NEITHER. The argv half
 * parses through `git-command-parse.js`; the path half classifies through
 * `guard-path-scope.js::classifyGovernedArtifactRel`, whose vocabulary is the
 * `governedArtifact` rows of the `PROTECTED_PATHS` registry (loom#1422). This
 * module holds NO path pattern of its own.
 *
 * BE PRECISE ABOUT WHAT THAT SENTENCE USED TO CLAIM. An earlier revision of
 * this header cited `security.md` § Enforcement-Surface Parity on the strength
 * of the argv half ALONE, while this file stood up its own twelve-row table of
 * path regexes — i.e. it asserted a guarantee for a surface the code did not
 * implement, which is the `instrument-bipolarity.md` MUST-4 defect and the
 * exact second-recognizer shape the sentence disclaimed.
 * `protected-path-predicate-1422.test.js` red on the `journal/` row and named
 * it. The claim is now true of both halves because both halves were made to
 * route; it was NOT made true by softening the claim.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not decide whether an artifact
 * SHOULD land — that is the operator's call and frequently the answer is "not
 * yet". It reports that the artifact is not in force and names it. Blocking the
 * work would be the `hook-output-discipline.md` MUST NOT case ("detectors that
 * block work the agent has been instructed to perform"), so the severity this
 * module recommends is never `block`.
 */

const path = require("path");
const { trunkRef } = require("./trunk-ref.js");
// Used ONLY to canonicalize a `git worktree remove <path>` argument against the
// paths `git worktree list --porcelain` reports, so the two sides of that
// identity match are resolved through the SAME resolver (`security.md` § Path
// Containment). Never used to decide a trust boundary here — an unresolvable
// path degrades to UNKNOWN, which fails open.
const fs = require("fs");

/**
 * HARD require, unlike the argv recognizer below — and the asymmetry is
 * deliberate. If `git-command-parse.js` is unavailable the destructive arm goes
 * quiet while the reachability arm keeps working, so failing open costs one
 * surface. If the protected-path predicate were unavailable there would be
 * nothing left to fail open TO: every classification would return null and the
 * detector would report nothing while every surface reported success. The only
 * fallback would be a private regex table, which is the defect this consolidation
 * removed. The five other consumers of this module require it the same way.
 */
const {
  GOVERNED_ARTIFACT_CLASSES,
  classifyGovernedArtifactRel,
} = require(path.join(__dirname, "guard-path-scope.js"));

let parseGitInvocations = null;
try {
  ({ parseGitInvocations } = require(
    path.join(__dirname, "git-command-parse.js"),
  ));
} catch {
  // Fail OPEN (cc-artifacts.md Rule 7). Without the shared recognizer the
  // destructive-command arm reports nothing; it never falls back to a regex,
  // because a lexical fallback here would be the exact MUST-5 defect this
  // module's header disclaims.
  parseGitInvocations = null;
}

/**
 * The governed-artifact vocabulary, RE-EXPORTED from the single registry.
 *
 * Not a table. `guard-path-scope.js` derives this from the `governedArtifact`
 * rows of `PROTECTED_PATHS`, so adding an artifact class is one registry row
 * and this module changes not at all. Kept on the exports because it was part
 * of this module's surface before the consolidation; its element shape is now
 * `{ id, kind, rx }`.
 */
const ARTIFACT_CLASSES = GOVERNED_ARTIFACT_CLASSES;

/**
 * Classify one repo-relative path. Returns the artifact kind, or null when the
 * path is not a governed artifact.
 *
 * A thin forward, deliberately: the KIND is read off the same registry row that
 * decided membership, so this file cannot drift from the fence corpus. Keeping
 * a private kind lookup here and calling the predicate only for the yes/no
 * would restore the two-table split with the second table invisible to
 * `protected-path-predicate-1422.test.js`.
 *
 * Normalization (backslashes, `//`, `/./`, a leading `./`) happens inside the
 * predicate. git reports forward slashes, but the fixtures and any direct
 * caller may not, and defence that depends on every caller normalizing first is
 * the shape of the original defect.
 */
function classifyArtifactPath(relpath) {
  if (typeof relpath !== "string" || !relpath) return null;
  return classifyGovernedArtifactRel(relpath);
}

/**
 * Group classified paths into a stable, reportable summary. Sorted by kind then
 * path so two runs over the same tree produce byte-identical output — the
 * report is quoted into durable surfaces, and an unstable order would make every
 * re-run look like a change.
 */
function summarizeByKind(artifacts) {
  const byKind = new Map();
  for (const a of artifacts) {
    if (!byKind.has(a.kind)) byKind.set(a.kind, []);
    byKind.get(a.kind).push(a.path);
  }
  return [...byKind.entries()]
    .map(([kind, paths]) => ({
      kind,
      count: paths.length,
      paths: paths.sort(),
    }))
    .sort((x, y) => (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : 0));
}

/**
 * Does `ref` reach `baseRef`? A git-object fact, and — until loom#1886 — the
 * whole discriminator. It is now the CHEAP FIRST PASS only; see
 * § CONTENT, NOT ANCESTRY below for why it cannot be the last word.
 *
 * Returns true / false / null, and the THIRD value is load-bearing: `null` means
 * the question could not be answered (unknown ref, no remote, git failure), and
 * the caller MUST treat it as "do not report", never as "reachable" and never as
 * "stranded". An unanswerable reachability question that defaulted either way
 * would be a non-discriminating instrument (`instrument-discipline.md` MUST-1).
 *
 * The asymmetry that makes it usable as a first pass: `true` is CONCLUSIVE (a
 * reachable ref's every byte is on the base), `false` is only a CANDIDATE.
 */
function isAncestor(exec, ref, baseRef) {
  const r = exec(["merge-base", "--is-ancestor", ref, baseRef]);
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  return null; // any other exit: git could not answer
}

/**
 * The core sweep. Returns:
 *   { ok: true, stranded: [...], branch, baseRef, changedCount }
 *   { ok: false, reason }        ← INDETERMINATE: no stranding verdict either way
 *
 * `ok:false` is fail-open in the CONTINUE sense — it never blocks and never
 * manufactures a finding — but it is NOT "report nothing", which is what an
 * earlier version of this line said and what the guard used to do. Silence made
 * "git resolved, nothing stranded" and "git never ran" byte-identical from the
 * operator's seat, so the caller now surfaces `reason` through
 * `explainSweepFailure` as an ADVISORY. See the caller's indeterminate arm.
 *
 * `exec` is injected so the fixtures drive this against real git repos without
 * this module ever choosing a spawn policy.
 *
 * `ref` IS THE SUBJECT, AND IT IS NOT ALWAYS `HEAD` (wip-discipline.md MUST-5).
 * This parameter existed from the first revision and no caller ever passed it,
 * so the destructive arm — the one surface where the subject is a branch the
 * session is NOT on — swept `HEAD` and returned 18 bytes of silence against
 * `git branch -D <X>` while X held eleven unlanded governed artifacts. The
 * parameter was the seam; nothing flowed into it. `resolveDestructiveTargets`
 * below is what now does.
 *
 * `label` names the ref in the REPORT. Without it the report line reads "on
 * '<current branch>'" for a sweep of some OTHER ref, which is a false statement
 * about which branch holds the artifacts — the same substitution of HEAD for the
 * subject, relocated from the verdict to the wording. It defaults to the current
 * branch only when `ref` genuinely is `HEAD`.
 */
function findStrandedArtifacts({
  exec,
  baseRef = null, // resolved from the integration trunk when omitted
  ref = "HEAD",
  label = null,
  contentCheck = true,
  // Optional `(ref, branchName) => landedVerdict(...)` — see § RECORDED
  // PROVENANCE FIRST below. Absent ⇒ the legacy path, unchanged.
  landedVerdictFor = null,
}) {
  if (typeof exec !== "function") return { ok: false, reason: "no-exec" };
  // THE INTEGRATION TRUNK (directive 2026-09-10): reachability is measured
  // against dev, because dev is where finished work lands continuously and for
  // free. Shared resolver, never a copy.
  if (!baseRef) baseRef = trunkRef({ repoDir: process.cwd() });
  const nameOf = () =>
    label || (ref === "HEAD" ? currentBranch(exec) : ref);

  const base = exec(["rev-parse", "--verify", "--quiet", baseRef]);

  // AN UNRESOLVABLE GIT BINARY IS NOT AN UNRESOLVABLE BASE REF, and until this
  // arm existed it reported as one. The guard's exec returns `{code:-1}` for
  // EVERY call when no git resolved, so the first check below claimed the
  // ref was missing — a statement about the REPOSITORY — when the actual cause
  // was that nothing ran. That misattribution sends the reader to check their
  // remote for a defect that is on the host, and it is the same
  // non-discriminating shape (`instrument-discipline.md` MUST-1) the caller's
  // own null-arm comment says it exists to prevent. `unavailable` is set only
  // by that arm; any exec that does not set it is unaffected.
  if (base && base.unavailable === true) {
    return { ok: false, reason: "git-unavailable" };
  }

  if (base.code !== 0 || !base.stdout.trim()) {
    // No base ref (fresh clone, no remote, renamed default branch). Nothing is
    // knowable about reachability, so nothing is reported.
    return { ok: false, reason: `base-ref-unresolvable:${baseRef}` };
  }

  const headRef = exec(["rev-parse", "--verify", "--quiet", ref]);
  if (headRef.code !== 0 || !headRef.stdout.trim()) {
    return { ok: false, reason: `ref-unresolvable:${ref}` };
  }

  // ── RECORDED PROVENANCE FIRST (landing-provenance) ─────────────────────────
  // Ancestry and the tree comparison below are AFTER-THE-FACT instruments, and
  // once landing rewrites commits they misreport both ways: a conflict-resolved
  // landing leaves bytes that differ from the branch's (reported stranded
  // although landed), and a plain cherry-pick of a never-landed branch leaves
  // identical bytes (reported in force although never landed). The trailers
  // the lander wrote answer the question itself, so when the caller supplies
  // `landedVerdictFor` (`landed-map.js::landedVerdict`'s shape,
  // `landed-map.js::landedVerdict`) it is asked FIRST:
  //   decided:true, landed         → nothing stranded; no content comparison
  //   decided:true, not landed     → every governed artifact the branch AUTHORED
  //                                  (three-dot range; for `partial`, only the
  //                                  paths the OUTSTANDING commits touch) — no
  //                                  tree comparison, which would re-ask the
  //                                  after-the-fact question provenance answered
  //   decided:false, fallback:true → the legacy ancestry + tree path, unchanged
  //   decided:false, fallback:false→ `provenance-unknown`: INDETERMINATE, never
  //                                  a stranding verdict in either direction
  // Absent `landedVerdictFor`, behaviour is byte-for-byte the legacy path.
  let provenanceStatus = null;
  if (typeof landedVerdictFor === "function") {
    let v;
    try {
      v = landedVerdictFor(ref, provenanceBranchName(exec, ref));
    } catch (e) {
      v = { decided: false, fallback: false, status: "unknown", why: `verdict threw: ${e && e.message}` };
    }
    if (!v || typeof v !== "object") {
      v = { decided: false, fallback: false, status: "unknown", why: "no verdict was returned" };
    }
    if (v.decided === true) {
      if (v.landed === true) {
        return {
          ok: true,
          stranded: [],
          branch: nameOf(),
          baseRef,
          changedCount: 0,
          contentVerified: true,
          inForce: 0,
          decidedBy: "provenance",
          provenanceStatus: v.status || "landed",
        };
      }
      const authored = exec(["diff", "--name-only", `${baseRef}...${ref}`]);
      if (authored.code !== 0) return { ok: false, reason: "diff-failed" };
      let paths = authored.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (v.status === "partial" && Array.isArray(v.outstanding)) {
        const outPaths = new Set();
        for (const sha of v.outstanding) {
          // `--diff-merges=first-parent`: the core lists an own MERGE commit as
          // outstanding (it can never be replayed, `landed-map.js::branchStatus`),
          // and a bare `diff-tree <merge>` prints NO paths at all — so the merge's
          // content (what it brought onto the branch, incl. an evil-merge
          // resolution) would vanish from the stranded set. Diffing against the
          // FIRST parent lists every path the merge changed ON the branch. NOT
          // `-m --first-parent`: MEASURED on git 2.54, diff-tree ignores
          // `--first-parent` there and `-m` diffs against EVERY parent, which
          // re-lists the branch's own (possibly LANDED) paths via the second
          // parent. For a non-merge commit this is the ordinary single-parent
          // diff, and `--root` keeps a root commit.
          const t = exec(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", "--diff-merges=first-parent", sha]);
          if (t.code !== 0) return { ok: false, reason: "diff-failed" };
          for (const p of t.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) outPaths.add(p);
        }
        paths = paths.filter((p) => outPaths.has(p));
      }
      const stranded = [];
      for (const p of paths) {
        const kind = classifyArtifactPath(p);
        if (kind) stranded.push({ path: p, kind });
      }
      return {
        ok: true,
        stranded,
        branch: nameOf(),
        baseRef,
        changedCount: paths.length,
        // Not an upper bound: the verdict is exact about WHICH commits are
        // unlanded; the wording keyed on `decidedBy` says what it established.
        contentVerified: true,
        inForce: 0,
        decidedBy: "provenance",
        provenanceStatus: v.status || "not-landed",
      };
    }
    if (!(v.decided === false && v.fallback === true)) {
      return {
        ok: false,
        reason: "provenance-unknown",
        why: String(v.why || v.status || "unknown"),
      };
    }
    provenanceStatus = String(v.status || "fallback");
  }

  const reaches = isAncestor(exec, ref, baseRef);
  if (reaches === null) return { ok: false, reason: "reachability-unknown" };
  if (reaches === true) {
    // Everything on this ref is already on the base. Nothing stranded — and
    // this is the GREEN pole the fixtures assert, not an absence of evidence.
    // `contentVerified: true` because reachability answers this case EXACTLY:
    // a reachable ref's bytes are on the base by construction, with no second
    // question left to ask.
    return {
      ok: true,
      stranded: [],
      branch: nameOf(),
      baseRef,
      changedCount: 0,
      contentVerified: true,
      inForce: 0,
      decidedBy: "ancestry",
      provenanceStatus,
    };
  }

  // THREE-DOT, never two-dot (evidence-first-claims.md MUST-5). The two-dot
  // range on a branch BEHIND base renders base's newer commits as reversions,
  // which would report artifacts as stranded that are merely absent here.
  const diff = exec(["diff", "--name-only", `${baseRef}...${ref}`]);
  if (diff.code !== 0) return { ok: false, reason: "diff-failed" };

  const changed = diff.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  // ── CONTENT, NOT ANCESTRY ──────────────────────────────────────────────────
  // The authorship range above answers "did THIS branch touch this path". It
  // does NOT answer "is that artifact in force", and those come apart the
  // moment a branch is rebased, squashed, or cherry-picked: the content lands
  // on the base under DIFFERENT commit objects, ancestry says "not reachable",
  // and every path the branch ever touched is reported as governing nothing.
  // MEASURED on loom's own 294 local branches before this pass existed: 214 of
  // 530 reported paths (40.4%) were BYTE-IDENTICAL at origin/main while the
  // report called them "AUTHORED but NOT IN FORCE anywhere else".
  //
  // The second question is a TREE comparison: `diff --name-only <base> <ref>`
  // lists the paths whose content actually differs between the two tips. A
  // path absent from it is byte-identical on the base — in force, whatever
  // commit carried it there.
  //
  // THIS IS THE TWO-DOT FORM, AND THE HEADER STILL BLOCKS IT AS AN AUTHORSHIP
  // RANGE. Both statements hold, because they are about different questions.
  // As an authorship range the two-dot form is wrong exactly as
  // `evidence-first-claims.md` MUST-5 says: on a branch BEHIND base it renders
  // base's newer commits as reversions and would blame this branch for
  // artifacts that landed on the base without it. That failure is why the set
  // below is an INTERSECTION and not a substitution — a path is reported only
  // if the three-dot range says this branch AUTHORED it AND the two-dot
  // comparison says the base does not already hold those bytes. The two-dot
  // form never widens the set, only narrows it, so it cannot reintroduce the
  // trap `pair3` pins.
  //
  // WHY NOT SHARE `unlanded-work-surface.js::classifyByContent`: that predicate
  // answers a BRANCH-level question ("does this branch hold any commit whose
  // patch-id is absent from the base") for every branch at once, and reading
  // its verdict as a PATH-level one would be `instrument-discipline.md` MUST-4
  // — a sound instrument re-read for a question it was not built for. It also
  // carries a blind spot this one does not: patch-id compares commits, so a
  // multi-commit squash defeats it (measured there), while a tree comparison is
  // indifferent to how many commits carried the bytes.
  const differingSet = contentCheck ? changedPathsBetween(exec, baseRef, ref) : null;
  const contentVerified = differingSet !== null;

  const stranded = [];
  let inForce = 0;
  for (const p of changed) {
    const kind = classifyArtifactPath(p);
    if (!kind) continue;
    // TRI-STATE, never a partial verdict: when the content pass did not run,
    // `differingSet` is null and EVERY authored artifact stays in the set. The
    // number is then the ancestry figure and the caller labels it an UPPER
    // BOUND — it is never silently narrowed by a pass that half-ran.
    if (differingSet && !differingSet.has(p)) {
      inForce++;
      continue;
    }
    stranded.push({ path: p, kind });
  }

  return {
    ok: true,
    stranded,
    branch: nameOf(),
    baseRef,
    changedCount: changed.length,
    contentVerified,
    inForce,
    decidedBy: contentVerified ? "content" : "ancestry-upper-bound",
    provenanceStatus,
  };
}

/**
 * The SHORT branch name the landing trailers use for `ref`, or undefined when
 * `ref` names no branch (a detached sha) — `landedVerdict` then derives it from
 * the ref itself, and a sha matches no branch-keyed record. `HEAD` resolves to
 * the checked-out branch; `refs/heads/x` and `refs/remotes/<r>/x` to `x`.
 */
function provenanceBranchName(exec, ref) {
  if (ref === "HEAD") {
    const b = currentBranch(exec);
    return b && b !== "HEAD" && b !== "(unknown)" ? b : undefined;
  }
  const s = String(ref || "");
  if (/^[0-9a-f]{40}$/.test(s)) return undefined;
  return s.replace(/^refs\/(heads|remotes\/[^/]+)\//, "") || undefined;
}

/**
 * The paths whose CONTENT differs between two tips, or null when the question
 * could not be answered.
 *
 * Null is the tri-state, and it is the only failure mode: a content pass that
 * cannot run must degrade the verdict to an upper bound, never fail the sweep
 * (which would discard a real ancestry finding) and never silently return an
 * empty set (which would read as "everything is in force" and suppress every
 * finding — the exact inversion of the defect this closes, and a far worse one,
 * because the guard would go quiet while every surface reported success).
 */
function changedPathsBetween(exec, baseRef, ref) {
  const r = exec(["diff", "--name-only", baseRef, ref]);
  if (r.code !== 0) return null;
  return new Set(
    r.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Turn an `{ok:false, reason}` into a sentence an operator can act on.
 *
 * WHY THIS LIVES HERE AND NOT AT THE HOOK. This module MINTS the reason strings,
 * so a translation table anywhere else is a second vocabulary that drifts from
 * the first the moment a reason is added — the same two-table split the header
 * above records being removed for the path half. A reason with no row falls
 * through to a form that QUOTES the unrecognized value rather than swallowing
 * it, so adding a reason without a row degrades to less-specific advice, never
 * to silence.
 *
 * Every string is remedy-shaped on purpose: the finding this closes was that the
 * indeterminate case reached the operator as nothing at all, and an advisory
 * that says only "something failed" reproduces most of that defect.
 */
const SWEEP_FAILURE_REMEDIES = {
  "git-unavailable":
    "No git binary resolved — neither the absolute candidate list nor a PATH search found one. NOTHING was asked of the repository, so no reachability question was answered in either direction.",
  "no-exec":
    "The sweep was invoked with no exec function. That is a wiring defect in the caller, not a condition of this repository.",
  "reachability-unknown":
    "`git merge-base --is-ancestor` exited with neither 0 nor 1, so reachability is genuinely unknown — typically a corrupt ref or an unreadable object store.",
  "diff-failed":
    "Reachability resolved, but `git diff --name-only <base>...<ref>` failed, so the changed-path set — and therefore which artifacts are involved — is unknown.",
  // Pre-existing gap: the caller has minted this since the indeterminate arm
  // landed and there was no row, so it reached the operator as "Unrecognized
  // sweep-failure reason" — advice-shaped for nobody. `zero-tolerance.md` Rule 1.
  "no-sweep-result":
    "The sweep returned nothing at all — no result object was produced, which is a wiring defect in the caller rather than a condition of this repository.",
  "provenance-unknown":
    "Landing provenance is recorded in this repository, but it could not decide whether this ref was landed (the ref's commits could not be enumerated against the base, or git failed). Once recording is on, a content match is not evidence of landing, so no content comparison was run and the ref is UNMEASURED.",
  "worktree-list-failed":
    "`git worktree list --porcelain` failed, so which branch is checked out at the target path is unknown. Run it by hand to see the error; until then the removal's stranding impact cannot be assessed.",
};

/**
 * Reasons minted by `resolveDestructiveTargets`, keyed by prefix because each
 * carries the offending target inline. Kept in the SAME table-plus-prefix shape
 * as the sweep reasons above and in the SAME module for the reason the header
 * records: a translation table anywhere else is a second vocabulary that drifts
 * from the first the moment a reason is added.
 */
const TARGET_FAILURE_REMEDIES = [
  [
    "foreign-repo:",
    (v) =>
      `The command carries \`-C ${v}\`, so its targets are refs in ANOTHER repository. This guard's git calls are pinned to the session's repository, so answering from here would be a verdict about the wrong repo. Re-run the check from inside ${v} if the stranding status there matters.`,
  ],
  [
    "no-such-branch:",
    (v) =>
      `No local branch '${v}' resolves in this repository, so there is no ref to assess. Either the branch is already gone (in which case the command will fail too) or the name is misspelled.`,
  ],
  [
    "no-worktree-at:",
    (v) =>
      `No registered worktree has the path '${v}', so which branch would stop being checked out there is unknown. \`git worktree list\` shows the registered paths; note that a stale entry needs \`git worktree prune\` before it disappears.`,
  ],
  [
    "worktree-head-unknown:",
    (v) =>
      `A worktree is registered at '${v}' but \`git worktree list --porcelain\` reported neither a branch nor a HEAD for it — typically a half-created or corrupted entry. Nothing was assessed.`,
  ],
  [
    "no-such-remote-branch:",
    (v) =>
      `Neither the remote-tracking ref '${v}' nor a local branch of that name resolves here, so the content about to be deleted from the remote cannot be inspected locally. \`git fetch\` first if its stranding status matters.`,
  ],
  [
    "unrecognized-kind:",
    (v) =>
      `The destructive command was recognized as kind '${v}', for which this module has no target-resolution rule. That is a wiring defect here, not a condition of the repository; nothing was assessed.`,
  ],
];

function explainSweepFailure(reason) {
  if (typeof reason !== "string" || !reason) {
    return "The sweep failed without recording a reason.";
  }
  if (SWEEP_FAILURE_REMEDIES[reason]) return SWEEP_FAILURE_REMEDIES[reason];
  for (const [prefix, render] of TARGET_FAILURE_REMEDIES) {
    if (reason.startsWith(prefix)) return render(reason.slice(prefix.length));
  }
  if (reason.startsWith("base-ref-unresolvable:")) {
    const ref = reason.slice("base-ref-unresolvable:".length);
    return `The base ref '${ref}' does not resolve in this repository (no remote, a fresh clone that has not fetched, or a differently-named default branch). Set COC_STRANDED_BASE_REF to the branch this tree actually lands on.`;
  }
  if (reason.startsWith("ref-unresolvable:")) {
    const ref = reason.slice("ref-unresolvable:".length);
    return `The ref '${ref}' does not resolve — normally an unborn branch with no commits yet, in which case there is nothing to strand.`;
  }
  return `Unrecognized sweep-failure reason '${reason}'. Treat the stranding status as unknown.`;
}

function currentBranch(exec) {
  const r = exec(["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() : "(unknown)";
}

/**
 * The destructive-command arm. Recognizes the three shapes that END a branch's
 * existence as a reachable thing:
 *
 *   git branch -D|-d|--delete <name>...
 *   git worktree remove <path>
 *   git push <remote> --delete <branch>   (and the `:branch` refspec form)
 *
 * Dispatch is on the PARSED subcommand and argv POSITION via the shared
 * recognizer — never a regex over the joined string, which `git -C /other commit`
 * walks straight through and `echo "git branch -D x"` falsely fires
 * (`hook-output-discipline.md` MUST-5).
 *
 * Returns { kind, targets[], dir, remote } or null.
 *
 * `dir` carries the invocation's `-C <path>` when it had one. It is NOT
 * cosmetic: `git -C /other branch -D z` names a ref in a DIFFERENT repository,
 * and this module's `exec` is pinned to the session's repo. Assessing
 * `refs/heads/z` HERE would answer about the wrong repository while every
 * surface read clean — the same steering failure the guard's `gitEnv()` comment
 * records for `GIT_DIR`. The resolver below turns a non-null `dir` into UNKNOWN
 * instead, which fails open loudly rather than answering confidently and wrong.
 *
 * `remote` carries the push remote, which `targets` deliberately excludes
 * (`slice(1)` drops it) and which the resolver needs to reach
 * `refs/remotes/<remote>/<branch>`. Added alongside `targets` rather than folded
 * into it so no existing consumer of `targets` changes shape.
 */
function detectStrandingDestructiveCommand(command) {
  if (!parseGitInvocations || typeof command !== "string" || !command.trim()) {
    return null;
  }
  let invocations;
  try {
    invocations = parseGitInvocations(command) || [];
  } catch {
    return null; // fail open
  }

  for (const inv of invocations) {
    if (!inv || inv.unresolvable) {
      // A fused/unresolvable invocation hides its verb. Report nothing rather
      // than guess — the guard is advisory, so a miss costs a report, while a
      // guess would manufacture a finding against an unknown command.
      continue;
    }
    const argv = Array.isArray(inv.argv) ? inv.argv : [];
    const dir = inv.dir || null;

    if (inv.sub === "branch") {
      const deletes = argv.some(
        (a) => a === "-D" || a === "-d" || a === "--delete",
      );
      if (!deletes) continue;
      const targets = argv.filter((a) => !a.startsWith("-"));
      if (targets.length) {
        return { kind: "branch-delete", targets, dir, remote: null };
      }
    }

    if (inv.sub === "worktree") {
      // argv[0] is the worktree subcommand; `remove` is the destructive one.
      if (argv[0] !== "remove") continue;
      const targets = argv.slice(1).filter((a) => !a.startsWith("-"));
      if (targets.length) {
        return { kind: "worktree-remove", targets, dir, remote: null };
      }
    }

    if (inv.sub === "push") {
      const hasDelete = argv.some((a) => a === "--delete" || a === "-d");
      const colonRefspec = argv.find((a) => /^:.+/.test(a));
      const positional = argv.filter((a) => !a.startsWith("-"));
      if (hasDelete) {
        const targets = positional.slice(1);
        if (targets.length) {
          return {
            kind: "remote-branch-delete",
            targets,
            dir,
            remote: positional[0] || null,
          };
        }
      } else if (colonRefspec) {
        // `:branch` starts with `-`? No — but it IS positional, and it is the
        // refspec, not the remote. The remote is the first positional that is
        // not a refspec, which for `git push origin :foo` is `origin`.
        return {
          kind: "remote-branch-delete",
          targets: [colonRefspec.slice(1)],
          dir,
          remote: positional.find((a) => !a.startsWith(":")) || null,
        };
      }
    }
  }
  return null;
}

/**
 * Resolve each parsed TARGET of a destructive command to a git ref this
 * repository can actually be asked about. This is the seam
 * `wip-discipline.md` MUST-5 exists for: without it the caller had a parsed
 * target and swept `HEAD` anyway.
 *
 * Returns one row per target: `{ target, ref, label, unresolved }`.
 *   - `ref` non-null  ⇒ sweep THIS ref.
 *   - `ref` null      ⇒ UNKNOWN. `unresolved` names WHY, and the caller MUST
 *                       surface it rather than counting the target as clean
 *                       (`instrument-discipline.md` MUST-1 — a target the
 *                       instrument could not look at is not a target it found
 *                       nothing on).
 *
 * There is no third state and no silent drop: every target in `targets` yields
 * exactly one row, so a target can never vanish between parse and report.
 */
function resolveDestructiveTargets({ exec, destructive, cwd = null }) {
  if (typeof exec !== "function" || !destructive) return [];
  const targets = Array.isArray(destructive.targets) ? destructive.targets : [];

  // A `-C <dir>` invocation names refs in ANOTHER repository. Answering from
  // this one would be confidently wrong, so every target is UNKNOWN.
  if (destructive.dir) {
    return targets.map((t) => ({
      target: t,
      ref: null,
      label: t,
      unresolved: `foreign-repo:${destructive.dir}`,
    }));
  }

  const verify = (rev) => {
    const r = exec(["rev-parse", "--verify", "--quiet", rev]);
    return r.code === 0 && r.stdout.trim() ? rev : null;
  };

  if (destructive.kind === "branch-delete") {
    return targets.map((t) => {
      // ONLY the local-branch namespace, deliberately. Falling back to a bare
      // `rev-parse <name>` would happily resolve a TAG or a sha and sweep it,
      // reporting a verdict about an object the command was never going to
      // delete. Fail toward UNKNOWN instead.
      const ref = t.startsWith("refs/heads/")
        ? verify(t)
        : verify(`refs/heads/${t}`);
      return {
        target: t,
        ref,
        label: t,
        unresolved: ref ? null : `no-such-branch:${t}`,
      };
    });
  }

  if (destructive.kind === "worktree-remove") {
    const trees = listWorktrees(exec);
    if (trees === null) {
      return targets.map((t) => ({
        target: t,
        ref: null,
        label: t,
        unresolved: "worktree-list-failed",
      }));
    }
    return targets.map((t) => {
      const want = canonicalPath(cwd ? path.resolve(cwd, t) : t);
      const hit = trees.find((w) => canonicalPath(w.path) === want);
      if (!hit) {
        return {
          target: t,
          ref: null,
          label: t,
          unresolved: `no-worktree-at:${t}`,
        };
      }
      if (hit.branch) {
        const short = hit.branch.replace(/^refs\/heads\//, "");
        return { target: t, ref: hit.branch, label: short, unresolved: null };
      }
      // Detached. The commit IS the subject — a detached worktree's artifacts
      // are exactly as strandable, and the sha is a perfectly good ref for
      // `merge-base` and `diff`. Reporting it UNKNOWN would be the silence this
      // fix exists to remove.
      if (hit.head) {
        return {
          target: t,
          ref: hit.head,
          label: `${t} (detached at ${hit.head.slice(0, 7)})`,
          unresolved: null,
        };
      }
      return {
        target: t,
        ref: null,
        label: t,
        unresolved: `worktree-head-unknown:${t}`,
      };
    });
  }

  if (destructive.kind === "remote-branch-delete") {
    const remote = destructive.remote;
    return targets.map((t) => {
      const name = t.replace(/^refs\/heads\//, "");
      // The remote-tracking ref is the honest subject: it is what stops being
      // reachable when the remote branch is deleted. The local branch of the
      // same name is a DIFFERENT object, so when it is what got assessed the
      // label says so rather than letting the report imply otherwise.
      const tracking = remote ? verify(`refs/remotes/${remote}/${name}`) : null;
      if (tracking) {
        return {
          target: t,
          ref: tracking,
          label: `${remote}/${name}`,
          unresolved: null,
        };
      }
      const local = verify(`refs/heads/${name}`);
      if (local) {
        return {
          target: t,
          ref: local,
          label: `${name} (local branch; ${remote ? `${remote}/${name}` : "the remote-tracking ref"} does not resolve here)`,
          unresolved: null,
        };
      }
      return {
        target: t,
        ref: null,
        label: t,
        unresolved: `no-such-remote-branch:${remote ? `${remote}/` : ""}${name}`,
      };
    });
  }

  return targets.map((t) => ({
    target: t,
    ref: null,
    label: t,
    unresolved: `unrecognized-kind:${destructive.kind}`,
  }));
}

/**
 * `git worktree list --porcelain` as records, or null when it could not be read.
 * Null is the tri-state again: an empty array would read as "no worktree matches
 * this path", which is a VERDICT, while the question was never answered.
 */
function listWorktrees(exec) {
  const r = exec(["worktree", "list", "--porcelain"]);
  if (r.code !== 0) return null;
  const out = [];
  let cur = null;
  for (const raw of r.stdout.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("worktree ")) {
      if (cur) out.push(cur);
      cur = { path: line.slice("worktree ".length), head: null, branch: null };
    } else if (cur && line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length).trim();
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).trim();
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Canonicalize a filesystem path for an IDENTITY match against the paths git
 * reports. Both sides go through THIS function, so symlinked checkout roots
 * (`/tmp` → `/private/tmp` on macOS is the everyday case) compare equal instead
 * of silently missing. An unresolvable path degrades to a normalized lexical
 * form rather than throwing — the consequence of a miss here is UNKNOWN, which
 * fails open.
 */
function canonicalPath(p) {
  if (typeof p !== "string" || !p) return "";
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Assess a whole destructive command: every target's sweep, folded into ONE
 * report. Returns null ONLY when every target resolved, swept successfully, and
 * stranded nothing — the STAY-SILENT pole.
 *
 * `results` rows are `{ target, ref, label, unresolved, sweep }`.
 *
 * The severity split is deliberate and matches the two arms the caller already
 * had: a real stranding finding is `pre-action` (the command has not run and the
 * operator is being asked to decide), while a report consisting only of targets
 * that could not be assessed is `advisory` — strictly weaker, because "I could
 * not look" must never present with the weight of "I looked and found work".
 */
function assessDestructiveTargets({ results, destructive }) {
  const rows = Array.isArray(results) ? results : [];
  const findings = [];
  const unknown = [];
  const clean = [];

  for (const row of rows) {
    if (!row) continue;
    if (row.unresolved) {
      unknown.push({ target: row.target, reason: row.unresolved });
      continue;
    }
    if (!row.sweep || !row.sweep.ok) {
      unknown.push({
        target: row.label || row.target,
        reason: (row.sweep && row.sweep.reason) || "no-sweep-result",
        why: (row.sweep && row.sweep.why) || null,
      });
      continue;
    }
    // `destructive: null` on the per-target finding: the pending command is
    // named ONCE by `destructiveReportLines` below. Threading it into each
    // finding would repeat the same sentence per target.
    const finding = assessStranding({
      sweep: row.sweep,
      surface: "destructive",
      destructive: null,
    });
    if (finding) findings.push(finding);
    else clean.push((row.label || row.target) + instrumentSuffix(row.sweep));
  }

  if (!findings.length && !unknown.length) return null;

  return {
    rule_id: "artifact-stranding/MUST-1",
    severity: findings.length ? "pre-action" : "advisory",
    surface: "destructive",
    destructive,
    findings,
    unknown,
    clean,
    count: findings.reduce((n, f) => n + f.count, 0),
    // The aggregate claim is only as strong as its WEAKEST member: one target
    // whose content pass did not run makes the total an upper bound.
    contentVerified: findings.every((f) => f.contentVerified !== false),
  };
}

/**
 * The report lines for a destructive-command assessment.
 *
 * Every line names WHICH TARGET it is about. A report that aggregated counts
 * across targets without naming them would satisfy a count assertion and still
 * leave the operator unable to act — and would fail `instrument-bipolarity.md`
 * MUST-2, which is why the fixtures assert the target by name.
 */
function destructiveReportLines(report) {
  if (!report) return [];
  const lines = [];
  const kind = (report.destructive && report.destructive.kind) || "command";
  const targets =
    (report.destructive && report.destructive.targets) || [];

  for (const f of report.findings) {
    for (const l of reportLines(f)) lines.push(l);
  }

  for (const u of report.unknown) {
    lines.push(
      `State that the target '${u.target}' could NOT be assessed (${u.reason}${u.why ? `: ${u.why}` : ""}): ${explainSweepFailure(u.reason)} This is INDETERMINATE and is NOT a report of zero stranded artifacts for that target.`,
    );
  }

  if (report.clean.length) {
    lines.push(
      `State that these target(s) were assessed and strand NOTHING: ${report.clean.join(", ")}.`,
    );
  }

  lines.push(
    `State that the pending \`${kind}\` targets ${targets.join(", ")} — landing or preserving anything named above BEFORE that command is the operator's decision, not this hook's.`,
  );
  return lines;
}

function summarizeDestructive(report) {
  if (!report) return "";
  const kind = (report.destructive && report.destructive.kind) || "command";
  const parts = [];
  if (report.findings.length) {
    const bound = report.contentVerified ? "" : " — UPPER BOUND";
    const where = report.findings
      .map((f) => `${f.count} on '${f.branch}'`)
      .join(", ");
    parts.push(
      `${report.count} COC artifact(s) would be stranded by a pending ${kind}: ${where}${bound}`,
    );
  }
  if (report.unknown.length) {
    parts.push(
      `${report.unknown.length} target(s) INDETERMINATE (${report.unknown.map((u) => u.target).join(", ")}) — NOT clean`,
    );
  }
  return parts.join("; ");
}

/**
 * Turn a sweep result into a finding, or null when there is nothing to say.
 * Severity is fixed HERE so both hook surfaces cannot drift apart. Each surface
 * takes the register that is TRUE about the action's fate at its own lifecycle
 * moment — the severity names the FATE, not the finding's importance:
 *
 *   - `pre-action` at a destructive boundary. That surface is PreToolUse:Bash,
 *     and the branch-ending command has NOT run when this fires. The register
 *     was added for exactly this shape (`instruct-and-wait.js`, loom#1715 H-1)
 *     and is gated there on `severity === "pre-action" && hookEvent ===
 *     "PreToolUse"`, so it renders "the action has NOT run yet. Read this, then
 *     decide." `halt-and-report` renders "the action ALREADY RAN" and was
 *     MEASURED here doing so against a pending `git branch -D` — a false claim
 *     about the world, and one that contradicts this finding's own closing line
 *     ("proceed with the command if that is still what the operator wants": an
 *     action said to have already run has no proceed left in it).
 *   - `advisory` at session close. Correct and deliberately unchanged: SessionEnd
 *     is a STOP_LIKE event where `instruct-and-wait.js` returns `{continue:true}`
 *     for every severity, the session's tool calls are done, and "the action
 *     proceeded" is the honest head. `pre-action` would be WRONG there and is a
 *     strict no-op anyway — it is gated to PreToolUse and would fall through to
 *     the same advisory head.
 *
 * Never `block` at either surface — see the module header.
 *
 * `pre-action` ranks with `advisory` in `severity-rank.js` and is REGISTERED
 * there, so it is neither dropped in selection nor coerced back to
 * `halt-and-report` by `normalizeSeverity` on delivery.
 */
function assessStranding({ sweep, surface, destructive = null }) {
  // null means "no STRANDING finding", NOT "nothing to say". An unanswerable
  // sweep must never be turned into a stranding verdict in either direction
  // (that is the contract `fail-open-yields-no-finding` pins), but it is also
  // not silence: the caller reports it as an indeterminate ADVISORY before this
  // function is ever reached.
  if (!sweep || !sweep.ok) return null;
  if (!sweep.stranded.length) return null;

  return {
    rule_id: "artifact-stranding/MUST-1",
    severity: surface === "destructive" ? "pre-action" : "advisory",
    surface,
    branch: sweep.branch,
    baseRef: sweep.baseRef,
    count: sweep.stranded.length,
    groups: summarizeByKind(sweep.stranded),
    destructive,
    // Carried, not re-derived. `false` means the count is an ancestry figure
    // the content pass could not refine, and the report MUST say so — an
    // upper bound presented as a verdict is the over-reporting this whole
    // change exists to stop, merely relocated one layer up.
    //
    // STRICT `=== true`, so an ABSENT field degrades to the upper bound rather
    // than to the strong claim. Both of this module's own return paths set the
    // field, so no shipped caller changes; the direction matters for anything
    // that hands in a sweep shape this module did not build, where "the field
    // is missing" means the content question was never asked and asserting
    // "NOT IN FORCE" on it would claim more than any instrument established.
    contentVerified: sweep.contentVerified === true,
    inForce: sweep.inForce || 0,
    // Which instrument decided the verdict ("provenance" | "content" |
    // "ancestry-upper-bound"), carried so every report line can name it.
    decidedBy: sweep.decidedBy || null,
    provenanceStatus: sweep.provenanceStatus || null,
  };
}

/**
 * The instrument, as a report suffix. Empty for a sweep shape that carries no
 * `decidedBy` (built outside this module), so nothing is claimed for it.
 */
function instrumentSuffix(sweep) {
  const d = sweep && sweep.decidedBy;
  // A repository with no recording config (every consumer) keeps the legacy
  // wording: its lines already name their instrument (content, or an UPPER
  // BOUND from reachability), and a suffix about provenance would describe a
  // mechanism it does not have.
  if (d !== "provenance" && (!sweep.provenanceStatus || sweep.provenanceStatus === "no-config")) return "";
  if (d === "provenance") return ` (decided by recorded landing provenance: ${sweep.provenanceStatus || "landed"})`;
  if (d === "ancestry") return ` (decided by ancestry — reachable from the base${sweep.provenanceStatus ? `; provenance: ${sweep.provenanceStatus}` : ""})`;
  if (d === "content") return ` (decided by content — tree comparison${sweep.provenanceStatus ? `; provenance: ${sweep.provenanceStatus}` : ""})`;
  if (d === "ancestry-upper-bound") return ` (ancestry only — content comparison did not run${sweep.provenanceStatus ? `; provenance: ${sweep.provenanceStatus}` : ""})`;
  return "";
}

function summarize(finding) {
  if (!finding) return "";
  const kinds = finding.groups.map((g) => `${g.count} ${g.kind}`).join(", ");
  const bound = finding.contentVerified === false ? " — UPPER BOUND" : "";
  return `${finding.count} COC artifact(s) on '${finding.branch}' not on ${finding.baseRef} (${kinds})${bound}`;
}

function reportLines(finding) {
  if (!finding) return [];
  // WORDING TRACKS THE INSTRUMENT. When the content pass ran, the claim is
  // about CONTENT and is stated as fact. When it did not, the same number is
  // an ancestry figure that may include artifacts already in force under
  // different commit objects, and saying "NOT IN FORCE anywhere else" about it
  // would be a claim the check could not support.
  const lines =
    finding.decidedBy === "provenance"
      ? [
          `State that ${finding.count} governed artifact(s) are committed on '${finding.branch}' in commits that are NOT LANDED at ${finding.baseRef} (${finding.provenanceStatus || "not-landed"}) — decided by the landing provenance recorded on ${finding.baseRef} (no Landed-From / Landed-Partial trailer covers those commits). No content comparison was run: once recording is on, identical bytes on ${finding.baseRef} are not evidence that this branch was landed.`,
        ]
      : finding.contentVerified === false
      ? [
          `State that AT MOST ${finding.count} governed artifact(s) committed on '${finding.branch}' may not be in force at ${finding.baseRef}. This is an UPPER BOUND, not a verdict: the content comparison against ${finding.baseRef} did not run, so this count is reachability only and may include artifacts whose bytes already landed there under different commits (a rebase, squash, or cherry-pick).`,
        ]
      : [
          `State that ${finding.count} governed artifact(s) are committed on '${finding.branch}' and their content is NOT present at ${finding.baseRef} — they are AUTHORED but NOT IN FORCE anywhere else.`,
        ];
  if (
    finding.decidedBy &&
    finding.decidedBy !== "provenance" &&
    finding.provenanceStatus &&
    finding.provenanceStatus !== "no-config"
  ) {
    lines.push(
      `State the instrument that decided this: ${finding.decidedBy === "content" ? "CONTENT (a tree comparison against the base)" : "ANCESTRY (reachability; the content comparison did not run)"}` +
        `, because recorded landing provenance could not speak for this branch (${finding.provenanceStatus}).`,
    );
  }
  for (const g of finding.groups) {
    const shown = g.paths.slice(0, 6);
    const more = g.paths.length - shown.length;
    lines.push(
      `Name the ${g.kind}(s): ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`,
    );
  }
  if (finding.destructive) {
    lines.push(
      `State that the pending \`${finding.destructive.kind}\` targets ${finding.destructive.targets.join(", ")} — landing or preserving these artifacts BEFORE that command is the operator's decision, not this hook's.`,
    );
  }
  if (finding.inForce > 0) {
    // Disclosed, not hidden. These are the paths the branch authored whose
    // bytes ARE already at the base; naming the count is what distinguishes
    // "the sweep looked and excluded them" from "the sweep did not see them".
    lines.push(
      `State that a further ${finding.inForce} governed artifact(s) this branch touched are ALREADY byte-identical at ${finding.baseRef} and are deliberately excluded from the count above — they are in force.`,
    );
  }
  lines.push(
    "State the disposition explicitly: land them (PR to the default branch), or record WHY they are deliberately held. Silence is what makes an artifact governed-nowhere.",
  );
  return lines;
}

module.exports = {
  ARTIFACT_CLASSES,
  classifyArtifactPath,
  summarizeByKind,
  isAncestor,
  findStrandedArtifacts,
  explainSweepFailure,
  detectStrandingDestructiveCommand,
  resolveDestructiveTargets,
  assessDestructiveTargets,
  destructiveReportLines,
  summarizeDestructive,
  listWorktrees,
  assessStranding,
  summarize,
  reportLines,
};
