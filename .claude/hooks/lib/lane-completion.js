/**
 * lane-completion.js — the predicate behind `lane-completion-guard.js`.
 *
 * ONE question, asked at the moment the agent goes idle: is there a lane of
 * MINE that is ALREADY FINISHED and merely un-landed?
 *
 * WHY THIS PREDICATE AND NOT "ARE THERE OPEN LANES". An open lane is not a
 * defect — `wip-discipline.md` bounds how many may be open, never that zero
 * may be. What IS a defect is a lane that has already passed every required
 * check, is mergeable, and is still open because the agent stopped to report
 * on it instead of landing it. That distinction is the whole design:
 *
 *   - it is STRUCTURAL — a check conclusion and a mergeable state are facts
 *     read off the forge, never an inference over prose;
 *   - it is AGENT-CLEARABLE — the remedy is one `gh pr merge`, inside the
 *     existing envelope, needing no human decision;
 *   - it is LOW-FALSE-POSITIVE — a green, mergeable, open PR authored by this
 *     operator has no legitimate "actually this should stay open" reading that
 *     the HELD list below does not already cover.
 *
 * Those three properties are exactly what `worktree-conservation-guard.js`'s
 * producer comment requires before a finding may refuse a Stop hand-back. A
 * finding failing any one of them MUST stay advisory: refusing a hand-back the
 * agent cannot clear spends the budget and hands back anyway, three rounds
 * later.
 *
 * THE SECOND ARM — CONFLICTING (loom#1990, added 2026-08-28).
 *
 * The predicate above covers exactly one state, and the measured problem is that
 * the backlog is almost never in it. Driven live against this repo with 6 open
 * lanes, `evaluateLaneCompletion` returned null — zero landable — while TWO of
 * those lanes (#1953, #1895, both this operator's) carried GitHub's own
 * `mergeable: "CONFLICTING"` / `mergeStateStatus: "DIRTY"` verdict and could not
 * merge at all. So the only drain refusal in the corpus covered a state the
 * queue was never in, and the queue did not drain.
 *
 * CONFLICTING passes the same three-part admission test, on its own evidence:
 *   - STRUCTURAL — `mergeable` and `mergeStateStatus` are GitHub's mergeability
 *     verdicts computed from the merge base, read under the PRODUCER's meaning
 *     (`instrument-discipline.md` MUST-4). Nothing is inferred from prose and
 *     nothing is evadable by rewording.
 *   - AGENT-CLEARABLE — the remedy is fixed and needs no human decision: merge
 *     the base branch into the lane, resolve the conflicted paths, push. It is
 *     ordinary in-envelope editing, not a disposition question.
 *   - LOW-FALSE-POSITIVE — a DIRTY lane cannot merge, full stop; there is no
 *     "actually this is fine" reading. Drafts, held lanes and every lane this
 *     operator cannot be shown to own are excluded BEFORE anything is reported.
 *
 * ORDERING IS LOAD-BEARING: the conflict test runs BEFORE `checksVerdict`. A
 * conflicted lane usually also has stale or red checks (#1895 was DIRTY *and*
 * red; #1953 was DIRTY with NO checks at all), so a checks-first classifier
 * buries it under `fail`/`unknown` and never reports the one fact that blocks
 * the merge. The conflict is orthogonal to CI: it must be resolved whatever the
 * checks say, and the report says nothing about the checks.
 *
 * ATTRIBUTION IS STRICTER ON THIS ARM THAN ON `landable`. A sibling's conflicted
 * lane is a false positive the agent cannot clear — resolving someone else's
 * conflict is not inside the envelope — so this arm reports ONLY when the
 * operator is RESOLVED and the author MATCHES. An unresolved operator (`gh api
 * user` failed) yields `conflicting-unattributable` and is silent, because
 * "cannot attribute" and "mine" are opposite meanings (`instrument-discipline.md`
 * MUST-1). The `landable` arm keeps its own, older behaviour unchanged.
 *
 * THE THIRD ARM — PROMOTION (R8, added 2026-09-20).
 *
 * The two arms above ask what STATE a lane is in. Neither asks what the lane
 * IS, and the predicate had no concept of a PR whose head is the integration
 * trunk. Measured against the shipped code with the real shape of a `dev` →
 * `main` promotion (MERGEABLE, CLEAN, checks green), `classifyLane` returned
 * `landable` and the report prescribed, verbatim:
 *
 *     gh pr merge 2160 --admin --merge --delete-branch
 *
 * `--delete-branch` DELETES the head branch, and the head branch of a promotion
 * PR IS `dev` — the integration trunk. `--admin` bypasses branch protection,
 * which on this repo (`enforce_admins: true`) is the mechanism the co-owner's
 * approval flows through, so it routes around the human gate rather than
 * satisfying it. The gate was RIGHT IN GENERAL — an open green lane really is
 * queue depth — and WRONG HERE, and it resolved the ambiguity in the one
 * direction that is unrecoverable.
 *
 * The consequence was not cosmetic: it refuses EVERY hand-back for as long as a
 * promotion PR is open, against a three-refusal budget, so each session that
 * opened one burned refusals on a non-answer. A guard that must be talked past
 * on every promotion teaches operators to talk past guards generally.
 *
 * The fix is to teach the predicate the SHAPE rather than the state: a head
 * equal to the trunk is a PROMOTION, classified `held` — the class this gate
 * already declines to touch. The trunk is resolved by the CALLER through the
 * shared `trunk-ref.js` resolver (this module stays pure), never by a second
 * copy of the trunk-naming logic and never by a hardcoded `dev`.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO:
 *   - it does NOT fire on a RED lane. "Fix the failure" is not bounded work —
 *     it can be a corpus-level decision (loom#1947's headroom overage is the
 *     live example), and a refusal the agent cannot clear is the wedge.
 *     MEASURED 2026-08-28 across four red lanes in one day: two were stale-base,
 *     one was an infra over-pin (a test pinning `actions/checkout@v4` while the
 *     invariant it guards still held), one was a genuine content defect — three
 *     different dispositions behind one red. Clearability there depends on the
 *     CAUSE, which is exactly what fails admission leg (b).
 *   - it does NOT fire on a PENDING lane. Waiting for CI is correct behaviour,
 *     not a defect, and refusing there would busy-wait the operator's session.
 *   - it does NOT fire on a BEHIND lane. Behind-but-clean is not a conflict:
 *     the forge can merge it, and `not-mergeable` already covers it.
 *   - it does NOT fire on a lane on the HELD list. An operator hold is a
 *     decision this guard has no standing to override.
 *
 * PURE. No I/O, no `require` beyond this file. The caller does the network read
 * and hands the parsed rows in, so every branch here is testable offline with
 * no forge and no clock.
 */

"use strict";

/** Conclusions that mean "this check produced a terminal PASS". */
const PASSING = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/**
 * Conclusions that mean "this check produced NO verdict".
 *
 * `verification-gate-integrity.md` MUST-2: absence of a result is NOT a pass. A
 * cancelled or never-reported check contributes zero failures and would satisfy
 * a naive `failures === 0` gate having decided nothing — so these are treated
 * as NOT-passing, which makes this guard stay SILENT rather than claim a lane
 * is landable on a verdict nobody produced.
 */
const NO_VERDICT = new Set([
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STALE",
  "",
]);

/** Kill switch, `COC_FLEET_DRAIN`'s shape. DEFAULT ON. */
function resolveEnabled(env) {
  const raw = (env || {}).COC_LANE_COMPLETION;
  if (typeof raw !== "string" || raw.trim() === "") return true;
  return !/^(?:0|off|false|no|disabled)$/i.test(raw.trim());
}

/**
 * Operator-declared holds. A lane named here is NEVER reported, whatever its
 * CI says — the operator has already decided, and this guard does not relitigate
 * a decision it cannot see the reasoning for.
 *
 * Read from the environment so a hold needs no code change; the caller may also
 * pass `held` directly.
 */
function resolveHeld(env, explicit) {
  if (Array.isArray(explicit)) return new Set(explicit.map(String));
  const raw = (env || {}).COC_LANE_COMPLETION_HELD;
  if (typeof raw !== "string" || raw.trim() === "") return new Set();
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((s) => s.replace(/^#/, "").trim())
      .filter(Boolean),
  );
}

/**
 * Is every REQUIRED check terminal-and-passing?
 *
 * Returns a tri-state, never a boolean, because "no checks reported" and "all
 * checks passed" are opposite meanings that a boolean would collapse:
 *   "pass"    — at least one check, and every one terminal-passing
 *   "pending" — at least one check still running
 *   "unknown" — zero checks reported, or a check with no verdict
 */
function checksVerdict(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return "unknown";
  let sawPass = false;
  for (const c of checks) {
    const state = String(
      (c && (c.conclusion ?? c.state ?? c.bucket)) || "",
    ).toUpperCase();
    const status = String((c && c.status) || "").toUpperCase();
    if (status === "IN_PROGRESS" || status === "QUEUED" || status === "PENDING")
      return "pending";
    if (state === "PENDING" || state === "IN_PROGRESS" || state === "QUEUED")
      return "pending";
    if (NO_VERDICT.has(state)) return "unknown";
    if (!PASSING.has(state)) return "fail";
    sawPass = true;
  }
  return sawPass ? "pass" : "unknown";
}

/**
 * Does the FORGE say this lane cannot be merged because it conflicts?
 *
 * Two independent fields carry the same fact, and either alone is a positive
 * verdict: `mergeable: "CONFLICTING"` and `mergeStateStatus: "DIRTY"`. Anything
 * else — including `UNKNOWN`, which is GitHub still computing the merge — is
 * NOT a conflict here. That asymmetry is deliberate fail-open: an unresolved
 * mergeability is silence, never a refusal (`cc-artifacts.md` Rule 7).
 */
function isConflicting(row) {
  const mergeable = String((row && row.mergeable) || "").toUpperCase();
  const state = String((row && row.mergeStateStatus) || "").toUpperCase();
  return mergeable === "CONFLICTING" || state === "DIRTY";
}

/**
 * Is this PR a PROMOTION of the integration trunk, rather than a lane?
 *
 * A PR whose HEAD is the trunk itself (`dev` → `main`) is the promotion of the
 * whole trunk. It is not a disposable topic branch and it is not this agent's to
 * land: it needs CI *and* the co-owner. `trunkBranch` is the BARE branch name,
 * resolved by the caller from the SHARED `trunk-ref.js` resolver — this module
 * does no I/O and never guesses a trunk name.
 *
 * `trunkBranches` is the set of BARE branch names that are TRUNK RATHER THAN
 * LANE, which the caller derives from `trunk-ref.js::nonLaneBranches(ref)` —
 * the repo's existing answer to exactly this question, not a second copy. For a
 * resolved `origin/dev` it is `["dev", "main", "master"]`: the trunk itself, the
 * promotion target, and the legacy default. All three are catastrophic to hand
 * a branch-delete, and all three are DERIVED from the resolved ref rather than
 * hardcoded — a repo whose trunk is `main` still counts a branch called `dev`
 * as the lane it is.
 *
 * EXACT SET MEMBERSHIP, deliberately, and both halves of that are load-bearing:
 *
 *   - NOT a prefix/substring test. `develop` is a lane, not the trunk `dev`.
 *   - The HEAD IS NEVER NORMALIZED. It arrives from `gh pr list --json
 *     headRefName` already bare and COMPLETE, so the whole string is the branch
 *     name. Running it through the repo's shared `branchNameOfRef` — which
 *     strips the first path segment — would turn the ordinary lane `fix/dev`
 *     into `dev` and silence a real lane as a "promotion". Only the TRUNK side
 *     needs normalizing, because only it can arrive remote-qualified
 *     (`resolveTrunk` returns `origin/dev`, which `===` no head ever), and
 *     `nonLaneBranches` does that on the caller's side.
 *
 * FAIL-OPEN on an unresolved trunk (`cc-artifacts.md` Rule 7): with an empty or
 * absent set this returns false — "cannot tell" is not "is a promotion". The
 * REMEDY degrades to match, in `reportLines`; the danger of an unresolved trunk
 * is never carried by pretending this predicate answered.
 */
function isPromotionLane(row, trunkBranches) {
  const names =
    trunkBranches instanceof Set
      ? trunkBranches
      : Array.isArray(trunkBranches)
        ? new Set(
            trunkBranches
              .filter((n) => typeof n === "string" && n.trim())
              .map((n) => n.trim()),
          )
        : null;
  if (!names || names.size === 0) return false;
  const head = String((row && row.headRefName) || "").trim();
  if (!head) return false;
  return names.has(head);
}

/**
 * Classify one PR row.
 *
 * `row` is the shape `gh pr list --json` produces; only the fields named here
 * are read, and each is read under the PRODUCER's meaning (`instrument-discipline.md`
 * MUST-4) — `mergeStateStatus` is GitHub's mergeability verdict, not a claim
 * about review.
 */
function classifyLane(row, opts) {
  const o = opts || {};
  const number = String((row && row.number) != null ? row.number : "");
  const title = String((row && row.title) || "");
  const author = String((row && row.author && row.author.login) || "");
  const state = String((row && row.mergeStateStatus) || "").toUpperCase();
  const isDraft = !!(row && row.isDraft);

  if (o.held && o.held.has(number)) return { number, title, verdict: "held" };
  if (isDraft) return { number, title, verdict: "draft" };
  if (o.operator && author && author !== o.operator) {
    return { number, title, verdict: "not-mine" };
  }

  // ── THE PROMOTION ARM, tested BEFORE the conflict arm and the checks ───────
  // A PR whose HEAD is the trunk is a promotion, and NONE of the three states
  // below are the agent's to act on:
  //   `landable`    — the remedy said `--delete-branch`, which DELETES the
  //                   integration trunk, and `--admin`, which bypasses the
  //                   branch protection the co-owner's approval flows THROUGH.
  //   `conflicting` — the remedy would prescribe a merge INTO the trunk.
  //   checks        — irrelevant; green CI does not make a promotion agent-work.
  // It is reported as `held`, the gate's existing class for "an operator
  // decision this guard has no standing to override", which is exactly what a
  // promotion is. `held` is already SILENT and already counted in the
  // denominators, so the PR stays visible as a number without being reported
  // and without ever being given a remedy.
  //
  // WHY THIS ORDER. Placing it after the conflict arm would let a CONFLICTING
  // promotion fall through and be handed a "merge the base in and resolve"
  // remedy against the trunk. That silences this guard on a conflicted
  // promotion, which is DECLARED, not overlooked: the forge shows the conflict
  // on the PR itself, the co-owner is the actor, and refusing a hand-back over
  // work the agent must not do is the wedge this gate's own header forbids.
  if (isPromotionLane(row, o.trunkBranches)) {
    return {
      number,
      title,
      head: String((row && row.headRefName) || ""),
      verdict: "held",
      // THE DISCRIMINATOR. `held` alone cannot distinguish a STRUCTURAL
      // promotion from an operator's `COC_LANE_COMPLETION_HELD` suppression —
      // both read `held`, so a check keying on the verdict string alone would
      // score them identically (`instrument-bipolarity.md` MUST-2: a pole names
      // the failure IDENTITY). `detail` carries that identity, the way the
      // `not-mergeable` arm already pins `BLOCKED`, and `promotion: true` gives
      // it a structural form no prose change can drift.
      detail: "promotion — awaiting co-owner",
      promotion: true,
    };
  }

  // ── THE CONFLICT ARM, tested BEFORE the checks (see the header) ────────────
  // A conflicted lane is usually ALSO red or check-less, so a checks-first
  // classifier reports `fail`/`unknown` and never names the fact that actually
  // blocks the merge.
  if (isConflicting(row)) {
    const head = String((row && row.headRefName) || "");
    const detail =
      String((row && row.mergeStateStatus) || "").toUpperCase() || "CONFLICTING";
    // STRICTER ATTRIBUTION THAN `landable`. Reporting requires a RESOLVED
    // operator AND a matching author. Without both, the lane may be a
    // sibling's, whose conflict this agent cannot resolve inside its envelope.
    if (!o.operator || !author) {
      return { number, title, verdict: "conflicting-unattributable" };
    }
    // The PR's OWN base — the branch the forge computed the conflict AGAINST.
    // Empty when the row was fetched without `baseRefName`.
    const base = String((row && row.baseRefName) || "");
    return { number, title, head, base, verdict: "conflicting", detail };
  }

  const checks = checksVerdict(row && row.statusCheckRollup);
  if (checks !== "pass") return { number, title, verdict: checks };

  // BLOCKED here means branch protection is unsatisfied (review, etc.) — a
  // human gate, not agent-clearable. CLEAN / HAS_HOOKS / UNSTABLE are the
  // mergeable-now family.
  if (state === "DIRTY" || state === "BLOCKED" || state === "BEHIND") {
    return { number, title, verdict: "not-mergeable", detail: state };
  }
  return { number, title, verdict: "landable" };
}

/**
 * The finding. Returns null when nothing is landable — the COMMON case, and it
 * is SILENT. A gate that speaks every turn is a gate that gets turned off.
 */
function evaluateLaneCompletion(rows, opts) {
  const o = opts || {};
  if (!resolveEnabled(o.env)) return null;
  if (!Array.isArray(rows)) return null;
  const held = resolveHeld(o.env, o.held);
  const classified = rows.map((r) => classifyLane(r, { ...o, held }));
  const landable = classified.filter((c) => c.verdict === "landable");
  const conflicting = classified.filter((c) => c.verdict === "conflicting");
  // SILENT is still the common case, and it now needs BOTH arms empty.
  if (landable.length === 0 && conflicting.length === 0) return null;
  return {
    landable,
    conflicting,
    // The resolved integration trunk, supplied by the caller (this module does
    // no I/O). Used ONLY for a conflicting row that carries no base of its own.
    //
    // TWO FIELDS, NOT ONE, because they are two different things and collapsing
    // them would break one of the two callers (`instrument-discipline.md`
    // MUST-4 — a field's meaning is fixed by its producer):
    //   `trunk`       — REMOTE-QUALIFIED (`origin/dev`), because it is spliced
    //                   into a `git merge <ref>` remedy and must be a real ref.
    //   `trunkBranches` — the BARE names (`dev`/`main`/`master`), because they
    //                   are compared to `headRefName`, which the forge returns
    //                   bare.
    // Comparing a bare head to a remote-qualified ref matches NOTHING, which
    // would leave this fix silently inert — the whole defect, one level down.
    trunk: typeof o.trunk === "string" && o.trunk.trim() ? o.trunk.trim() : null,
    trunkBranches: Array.isArray(o.trunkBranches)
      ? o.trunkBranches.filter((n) => typeof n === "string" && n.trim())
      : [],
    // A promotion counts under its OWN key rather than swelling `held`. Both are
    // silent, but they are silent for DIFFERENT reasons, and a tally that reads
    // `held=2` for one operator hold plus one promotion has hidden exactly the
    // distinction this change exists to draw (`instrument-discipline.md`
    // MUST-3(b): read the hits, not the tally).
    counts: classified.reduce((a, c) => {
      const k = c.promotion ? "held-promotion" : c.verdict;
      a[k] = (a[k] || 0) + 1;
      return a;
    }, {}),
  };
}

/** Agent-facing report lines. One per landable lane, plus the denominators. */
function reportLines(finding) {
  if (!finding) return [];
  // THE LANDABLE REMEDY, and both flags it no longer prescribes unconditionally.
  //
  // `--admin` IS GONE ENTIRELY. It bypasses branch protection, and on a repo
  // with `enforce_admins: true` that protection IS the channel a human approval
  // flows through — so prescribing it routes around the gate rather than
  // satisfying it. It was never needed here either: `classifyLane` already
  // routes `BLOCKED` (protection unsatisfied) to `not-mergeable`, so a lane this
  // gate calls `landable` has ALREADY satisfied protection and merges without
  // it. If a merge does fail on protection, that is a finding to report, not a
  // flag to overpower it with.
  //
  // `--delete-branch` IS CONDITIONAL on the trunk having been RESOLVED. With a
  // resolved trunk, a row still classified `landable` is provably not the trunk
  // (the promotion arm consumed those), so deleting its branch is safe. With an
  // UNRESOLVED trunk the promotion arm could not run, so this gate cannot tell a
  // topic branch from the trunk — and "cannot tell" must not be spent on an
  // irreversible flag (`instrument-discipline.md` MUST-1: an unanswerable
  // question is reported as unanswered, never as the convenient answer).
  const lines = finding.landable.map((l) => {
    const head = `#${l.number} is GREEN and MERGEABLE right now — land it:`;
    return finding.trunkBranches && finding.trunkBranches.length
      ? `${head} \`gh pr merge ${l.number} --merge --delete-branch\`. Then remove its worktree and delete its branch (wip-discipline.md MUST-4: done means landed AND cleaned).`
      : `${head} \`gh pr merge ${l.number} --merge\`. The trunk ref could NOT be resolved this turn, so this gate cannot confirm the head branch is a lane rather than the trunk itself — merge WITHOUT any branch-deleting flag, and delete the branch only after you have confirmed by hand that it is not the trunk. Then remove its worktree (wip-discipline.md MUST-4: done means landed AND cleaned).`;
  });
  // THE CONFLICT ARM names the remedy, not the state. A refusal that says only
  // "this conflicts" spends a budget slot on something the agent already knew.
  //
  // WHICH BASE TO MERGE. The forge's `mergeable` / `mergeStateStatus` verdict is
  // computed against the PR's OWN `baseRefName` (`instrument-discipline.md`
  // MUST-4: the producer fixes a field's meaning). A hardcoded `origin/main`
  // told a lane targeting `dev` to merge main into itself; a hardcoded trunk
  // would tell a promotion PR targeting `main` to merge dev into it. So the
  // PR's base first; the resolved trunk only when the row carries none, and the
  // text SAYS it is the trunk; neither ⇒ no ref is fabricated.
  const tail =
    "fix the conflicted paths, commit, push. Do NOT open a replacement PR, and do NOT read this as a comment on its CI — the conflict blocks the merge whatever the checks say.";
  for (const l of finding.conflicting || []) {
    const on = l.head ? ` (branch \`${l.head}\`)` : "";
    const head = `#${l.number} is CONFLICTING with its base${on} — the forge reports \`${l.detail}\`, so it CANNOT merge in any state.`;
    if (l.base) {
      lines.push(
        `${head} Resolve it in that lane's worktree: \`git fetch origin && git merge origin/${l.base}\` (\`${l.base}\` is this PR's own base — the branch the conflict was computed against), ${tail}`,
      );
    } else if (finding.trunk) {
      lines.push(
        `${head} Resolve it in that lane's worktree: \`git fetch origin && git merge ${finding.trunk}\` (the resolved integration trunk — the forge row did not name this PR's base, so confirm it first with \`gh pr view ${l.number} --json baseRefName\`), ${tail}`,
      );
    } else {
      lines.push(
        `${head} Resolve it in that lane's worktree by merging the PR's base branch into it — neither the forge row nor the trunk resolver named that branch, so read it first with \`gh pr view ${l.number} --json baseRefName\` — then ${tail}`,
      );
    }
  }
  const c = finding.counts;
  const denom = Object.keys(c)
    .sort()
    .map((k) => `${k}=${c[k]}`)
    .join(" · ");
  lines.push(
    `State the denominators so the count is readable: ${denom}. Only the \`landable\` and \`conflicting\` ones are being reported; \`pending\` is normal, \`fail\` is a separate fix this gate deliberately says nothing about, \`held\` is a decision this gate does not touch — an operator hold OR a PROMOTION PR whose head is the trunk itself, which needs CI and the co-owner and is never an agent action — and \`conflicting-unattributable\` means the operator could not be resolved so ownership is UNKNOWN — not that the lane is fine.`,
  );
  return lines;
}

function summarize(finding) {
  if (!finding) return "";
  const parts = [];
  const nL = finding.landable.length;
  if (nL) {
    parts.push(
      `${nL} lane${nL === 1 ? "" : "s"} already green + mergeable, still open: ${finding.landable
        .map((l) => "#" + l.number)
        .join(", ")}`,
    );
  }
  const nC = (finding.conflicting || []).length;
  if (nC) {
    parts.push(
      `${nC} lane${nC === 1 ? "" : "s"} CONFLICTING with base and unmergeable until resolved: ${finding.conflicting
        .map((l) => "#" + l.number)
        .join(", ")}`,
    );
  }
  return parts.join("; ");
}

module.exports = {
  PASSING,
  NO_VERDICT,
  resolveEnabled,
  resolveHeld,
  checksVerdict,
  isConflicting,
  isPromotionLane,
  classifyLane,
  evaluateLaneCompletion,
  reportLines,
  summarize,
};
