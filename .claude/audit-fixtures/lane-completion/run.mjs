#!/usr/bin/env node
/**
 * lane-completion fixtures — bipolar per predicate arm.
 *
 * `instrument-bipolarity.md` MUST-1: every arm ships BOTH poles, and the
 * harness asserts the verdicts DIFFER. MUST-2: each RED pole names the failure
 * IDENTITY (the verdict string), never merely "something was reported".
 *
 * The whole point of this guard is that it stays SILENT except on a lane that
 * is finished. So the GREEN poles here are the load-bearing half: each is a
 * state that LOOKS reportable and must not be, and each corresponds to a real
 * way the earlier design would have over-fired.
 */

import "../_lib/no-ambient-git.cjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, "..", "..", "hooks", "lib", "lane-completion.js");
const GUARD = path.join(HERE, "..", "..", "hooks", "lane-completion-guard.js");
const L = require(LIB);

let pass = 0;
let fail = 0;
const results = [];

function check(name, fn) {
  try {
    fn();
    pass++;
    results.push(`PASS ${name}`);
  } catch (e) {
    fail++;
    results.push(`FAIL ${name} — ${e && e.message}`);
  }
}

const okCheck = [{ name: "CI", conclusion: "SUCCESS" }];
const lane = (o) => ({
  number: o.n,
  title: o.t || "a lane",
  isDraft: !!o.draft,
  author: { login: o.author || "me" },
  mergeable: o.mergeable || "MERGEABLE",
  mergeStateStatus: o.merge || "CLEAN",
  headRefName: o.head || "fix/some-lane",
  baseRefName: o.base,
  statusCheckRollup: o.checks === undefined ? okCheck : o.checks,
});
const verdictOf = (row, opts) =>
  L.classifyLane(row, { operator: "me", held: new Set(), ...(opts || {}) }).verdict;

// ── PAIR 1 — the firing pole vs the pending pole ─────────────────────────────
check("RED  · a green + mergeable lane of mine is LANDABLE", () => {
  assert.equal(verdictOf(lane({ n: 1 })), "landable");
});
check("GREEN · a lane whose checks are still running is NOT reported", () => {
  assert.equal(verdictOf(lane({ n: 2, checks: [{ name: "CI", status: "IN_PROGRESS" }] })), "pending");
});

// ── PAIR 2 — failing checks are a DIFFERENT problem, not this gate's ─────────
check("RED  · identity: a failing lane classifies `fail`, never `landable`", () => {
  assert.equal(verdictOf(lane({ n: 3, checks: [{ name: "CI", conclusion: "FAILURE" }] })), "fail");
});
check("GREEN · a failing lane produces NO finding", () => {
  assert.equal(
    L.evaluateLaneCompletion([lane({ n: 3, checks: [{ name: "CI", conclusion: "FAILURE" }] })], {
      operator: "me",
    }),
    null,
  );
});

// ── PAIR 3 — absence of a verdict is NOT a pass ──────────────────────────────
// verification-gate-integrity.md MUST-2. Both arms must read `unknown`, because
// a cancelled check and a never-reported check contribute zero failures and
// would satisfy a naive `failures === 0` gate having decided nothing.
check("RED  · identity: zero checks reported reads `unknown`, not `pass`", () => {
  assert.equal(L.checksVerdict([]), "unknown");
});
check("GREEN · a CANCELLED check reads `unknown`, so the lane is not landable", () => {
  assert.equal(verdictOf(lane({ n: 5, checks: [{ name: "CI", conclusion: "CANCELLED" }] })), "unknown");
});

// ── PAIR 4 — ownership and draft state ───────────────────────────────────────
check("RED  · identity: another human's lane is `not-mine`", () => {
  assert.equal(verdictOf(lane({ n: 7, author: "someone-else" })), "not-mine");
});
check("GREEN · a draft lane is never reported", () => {
  assert.equal(verdictOf(lane({ n: 6, draft: true })), "draft");
});

// ── PAIR 5 — mergeability states that are human gates, not agent work ────────
check("RED  · identity: BLOCKED (branch protection) is `not-mergeable`", () => {
  const c = L.classifyLane(lane({ n: 8, merge: "BLOCKED" }), { operator: "me", held: new Set() });
  assert.equal(c.verdict, "not-mergeable");
  assert.equal(c.detail, "BLOCKED");
});
check("GREEN · BEHIND is `not-mergeable` too — it needs a merge first, not a land", () => {
  assert.equal(verdictOf(lane({ n: 9, merge: "BEHIND" })), "not-mergeable");
});

// ── PAIR 6 — the operator's own controls ─────────────────────────────────────
check("RED  · identity: a HELD lane is suppressed even when landable", () => {
  assert.equal(verdictOf(lane({ n: 1 }), { held: new Set(["1"]) }), "held");
  assert.equal(L.evaluateLaneCompletion([lane({ n: 1 })], { operator: "me", held: ["1"] }), null);
});
check("GREEN · the kill switch silences a genuinely landable lane", () => {
  assert.equal(
    L.evaluateLaneCompletion([lane({ n: 1 })], {
      operator: "me",
      env: { COC_LANE_COMPLETION: "off" },
    }),
    null,
  );
  // …and an UNRECOGNISED value stays ON (security.md § Secure-Default).
  assert.ok(
    L.evaluateLaneCompletion([lane({ n: 1 })], {
      operator: "me",
      env: { COC_LANE_COMPLETION: "banana" },
    }),
  );
});

// ── PAIR 7 — the report names the action, and the denominators ───────────────
check("RED  · the report names the lane AND the exact command to land it", () => {
  const f = L.evaluateLaneCompletion([lane({ n: 42 })], { operator: "me" });
  const lines = L.reportLines(f).join("\n");
  assert.match(lines, /#42/);
  assert.match(lines, /gh pr merge 42/);
  assert.match(lines, /landed AND cleaned/);
});
check("GREEN · no finding produces no report lines at all", () => {
  assert.deepEqual(L.reportLines(null), []);
  assert.equal(L.summarize(null), "");
});

// ── PAIR 8 — anti-vacuity: the classifier is not a constant ──────────────────
check("RED  · the arms produce DIFFERENT verdicts (the pair is not vacuous)", () => {
  const seen = new Set([
    verdictOf(lane({ n: 1 })),
    verdictOf(lane({ n: 2, checks: [{ name: "CI", status: "QUEUED" }] })),
    verdictOf(lane({ n: 3, checks: [{ name: "CI", conclusion: "FAILURE" }] })),
    verdictOf(lane({ n: 6, draft: true })),
  ]);
  assert.ok(seen.size >= 4, `expected >=4 distinct verdicts, got ${[...seen].join(",")}`);
});
check("GREEN · a malformed row set yields null rather than throwing", () => {
  assert.equal(L.evaluateLaneCompletion(null, { operator: "me" }), null);
  assert.equal(L.evaluateLaneCompletion(undefined, { operator: "me" }), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// THE CONFLICTING ARM (loom#1990)
// ═══════════════════════════════════════════════════════════════════════════

// ── PAIR 9 — the arm fires, and ownership is what bounds it ──────────────────
check("RED  · identity: an OWN conflicting lane classifies `conflicting`", () => {
  const c = L.classifyLane(lane({ n: 100, merge: "DIRTY", mergeable: "CONFLICTING" }), {
    operator: "me",
    held: new Set(),
  });
  assert.equal(c.verdict, "conflicting");
  assert.equal(c.detail, "DIRTY");
});
check("GREEN · a SIBLING's conflicting lane is `not-mine`, never reported", () => {
  const rows = [lane({ n: 101, author: "someone-else", merge: "DIRTY", mergeable: "CONFLICTING" })];
  assert.equal(verdictOf(rows[0]), "not-mine");
  assert.equal(L.evaluateLaneCompletion(rows, { operator: "me" }), null);
});

// ── PAIR 10 — ordering: the conflict is read BEFORE the checks ───────────────
// This is the pair that pins the whole design. #1895 was DIRTY *and* red; a
// checks-first classifier calls it `fail` and never names the merge blocker.
check("RED  · identity: DIRTY + FAILING checks reads `conflicting`, not `fail`", () => {
  assert.equal(
    verdictOf(lane({ n: 1895, merge: "DIRTY", mergeable: "CONFLICTING", checks: [{ name: "CI", conclusion: "FAILURE" }] })),
    "conflicting",
  );
  // …and with NO checks at all (#1953's real shape) it is still `conflicting`,
  // not `unknown`.
  assert.equal(verdictOf(lane({ n: 1953, merge: "DIRTY", mergeable: "CONFLICTING", checks: [] })), "conflicting");
});
check("GREEN · a BEHIND-but-clean lane is NOT a conflict — it stays `not-mergeable`", () => {
  assert.equal(L.isConflicting({ mergeStateStatus: "BEHIND", mergeable: "MERGEABLE" }), false);
  assert.equal(verdictOf(lane({ n: 102, merge: "BEHIND" })), "not-mergeable");
});

// ── PAIR 11 — attribution must be POSITIVE, not merely non-contradicted ──────
check("RED  · the report names the CONFLICT and the exact remedy, not just the state", () => {
  const f = L.evaluateLaneCompletion(
    [lane({ n: 1953, merge: "DIRTY", mergeable: "CONFLICTING", head: "fix/thing", base: "dev", checks: [] })],
    { operator: "me" },
  );
  assert.ok(f, "no finding produced for an own conflicting lane");
  assert.equal(f.conflicting.length, 1);
  const lines = L.reportLines(f).join("\n");
  assert.match(lines, /#1953/);
  assert.match(lines, /CONFLICTING/);
  assert.match(lines, /git merge origin\/dev/);
  assert.match(lines, /fix\/thing/);
  assert.match(L.summarize(f), /CONFLICTING with base/);
});

// ── PAIR 11b — the remedy merges the base the CONFLICT was computed against ──
// `mergeable` / `mergeStateStatus` are the forge's verdict against the PR's OWN
// `baseRefName` (instrument-discipline.md MUST-4: the producer fixes a field's
// meaning). A hardcoded `git merge origin/main` told a lane targeting `dev` to
// pull un-promoted main-vs-dev drift into itself; a hardcoded trunk would tell a
// promotion PR targeting `main` to merge dev into it. So: the PR's base first;
// the resolved trunk only when the row does not carry one, and SAID so; and
// neither ⇒ no ref is fabricated.
check("RED  · identity: the remedy merges the PR's OWN base, not a hardcoded main", () => {
  const onMain = L.reportLines(
    L.evaluateLaneCompletion([lane({ n: 301, merge: "DIRTY", mergeable: "CONFLICTING", base: "main", checks: [] })], { operator: "me", trunk: "origin/dev" }),
  ).join("\n");
  assert.match(onMain, /git merge origin\/main/, "a PR targeting main merges main, even when the trunk is dev");
  assert.doesNotMatch(onMain, /git merge origin\/dev/);
  const onDev = L.reportLines(
    L.evaluateLaneCompletion([lane({ n: 302, merge: "DIRTY", mergeable: "CONFLICTING", base: "dev", checks: [] })], { operator: "me" }),
  ).join("\n");
  assert.match(onDev, /git merge origin\/dev/);
  assert.doesNotMatch(onDev, /git merge origin\/main/);
});
check("RED  · a row carrying NO base names the RESOLVED trunk, and says it is the trunk", () => {
  const text = L.reportLines(
    L.evaluateLaneCompletion([lane({ n: 303, merge: "DIRTY", mergeable: "CONFLICTING", checks: [] })], { operator: "me", trunk: "origin/dev" }),
  ).join("\n");
  assert.match(text, /git merge origin\/dev/);
  assert.match(text, /trunk/);
});
check("GREEN · neither a base nor a trunk ⇒ NO merge ref is fabricated; the read command is named", () => {
  const text = L.reportLines(
    L.evaluateLaneCompletion([lane({ n: 304, merge: "DIRTY", mergeable: "CONFLICTING", checks: [] })], { operator: "me" }),
  ).join("\n");
  assert.doesNotMatch(text, /git merge origin\//);
  assert.match(text, /gh pr view 304 --json baseRefName/);
});
check("GREEN · an UNRESOLVED operator makes a conflicting lane unattributable, so SILENT", () => {
  const rows = [lane({ n: 103, merge: "DIRTY", mergeable: "CONFLICTING" })];
  // `gh api user` failed ⇒ operator null. "Cannot attribute" is not "mine".
  assert.equal(L.classifyLane(rows[0], { held: new Set() }).verdict, "conflicting-unattributable");
  assert.equal(L.evaluateLaneCompletion(rows, {}), null);
});

// ── PAIR 12 — either forge field alone is a verdict; UNKNOWN is not ──────────
check("RED  · identity: `mergeable:CONFLICTING` alone fires, without DIRTY", () => {
  assert.equal(L.isConflicting({ mergeable: "CONFLICTING", mergeStateStatus: "UNSTABLE" }), true);
  assert.equal(L.isConflicting({ mergeStateStatus: "DIRTY" }), true);
  assert.equal(verdictOf(lane({ n: 104, merge: "UNSTABLE", mergeable: "CONFLICTING" })), "conflicting");
});
check("GREEN · `mergeable:UNKNOWN` (the forge still computing) is NOT a conflict", () => {
  assert.equal(L.isConflicting({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }), false);
  assert.equal(L.isConflicting({}), false);
  assert.equal(L.evaluateLaneCompletion([lane({ n: 105, merge: "UNKNOWN", mergeable: "UNKNOWN", checks: [{ name: "CI", status: "QUEUED" }] })], { operator: "me" }), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// THE PROMOTION ARM (R8) — a PR whose HEAD IS the integration trunk
//
// `dev → main` is a PROMOTION of the whole integration trunk to the release
// branch, not a disposable lane. Measured against the shipped predicate with
// head=`dev`, base=`main`, mergeable=`MERGEABLE`, mergeStateStatus=`CLEAN` and
// green checks, the verdict was `landable` and the remedy read verbatim:
//
//     gh pr merge 2160 --admin --merge --delete-branch
//
// `--delete-branch` DELETES the integration trunk `dev`; `--admin` bypasses the
// branch protection the co-owner's approval flows THROUGH. Promoting is a human
// decision, so the gate must go SILENT on it — `held`, the existing silent class
// — and must never hand the agent a remedy for it.
//
// The near-miss poles below are the load-bearing half in the other direction:
// the predicate must key on EXACT equality with the bare trunk branch name, so a
// lane called `develop` (prefix), `fix/dev` (which the repo's shared
// `branchNameOfRef` helper would normalise straight to `dev`) or `dev-notes`
// must all stay `landable`. A gate that silences those has been disabled, not
// fixed.
// ═══════════════════════════════════════════════════════════════════════════

/** Keys whose values differ between two rows. JSON-compared, so objects count. */
const differingKeys = (a, b) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .sort();

// The set the GUARD derives from `trunk-ref.js::nonLaneBranches(origin/dev)`:
// the trunk, the promotion target, and the legacy default. All three are
// catastrophic to hand a branch-delete, and all three are DERIVED from the
// resolved ref rather than hardcoded here — this constant mirrors that output,
// it does not define it.
const TRUNKS = ["dev", "main", "master"];

// The exact `detail` the promotion arm emits. Pinned as a constant so a drift in
// the prose reds ONE assertion with a readable diff rather than silently
// widening a regex. The dash is a real em-dash (U+2014).
const PROMOTION_DETAIL = "promotion — awaiting co-owner";

// Both poles below are spread from ONE row object, so the ONLY difference is the
// head. That is ASSERTED rather than eyeballed: without the `differingKeys`
// assertion a later edit could drift a second field and the pair would quietly
// stop separating on `headRefName` at all while still reading green.
const promoBase = lane({ n: 2160, t: "promote dev to main", base: "main" });
const topicPole = { ...promoBase, headRefName: "fix/some-lane" };
const trunkPole = { ...promoBase, headRefName: "dev" };

// ── PAIR 17 — ONE row, ONE key, OPPOSITE verdicts ────────────────────────────
// The RED pole does NOT assert on the verdict string alone. `held` is ALREADY
// produced by the operator-hold path (`COC_LANE_COMPLETION_HELD`), so
// `verdict === "held"` cannot tell a STRUCTURAL promotion from an operator's
// manual suppression — it would read identically with the promotion arm deleted
// and the number pasted into the hold list. The discriminator is the STRUCTURAL
// `promotion: true` flag, which no prose edit can drift; the `detail` string is
// pinned alongside it, not instead of it (`instrument-bipolarity.md` MUST-2).
check("RED  · identity: a trunk-headed PR is `held` AND carries `promotion: true`", () => {
  assert.deepEqual(
    differingKeys(topicPole, trunkPole),
    ["headRefName"],
    "the poles must differ in EXACTLY one key, or the pair does not separate on the head",
  );
  assert.equal(L.isPromotionLane(trunkPole, TRUNKS), true);
  const c = L.classifyLane(trunkPole, { operator: "me", held: new Set(), trunkBranches: TRUNKS });
  assert.equal(c.verdict, "held", `a promotion classified ${c.verdict}`);
  assert.equal(c.promotion, true, "the structural discriminator is missing");
  assert.equal(c.detail, PROMOTION_DETAIL);
  assert.match(String(c.detail || ""), /promotion/i, "the silent class must SAY why it is silent");
  // AND the discriminator must actually DISCRIMINATE: an OPERATOR hold on the
  // very same row reaches the same `held` verdict WITHOUT the flag. Without this
  // line the assertions above are satisfied by a predicate that flags every
  // `held` lane as a promotion.
  const h = L.classifyLane(topicPole, { operator: "me", held: new Set(["2160"]), trunkBranches: TRUNKS });
  assert.equal(h.verdict, "held", "the control must reach the SAME verdict, or it separates on the wrong thing");
  assert.notEqual(h.promotion, true, "an operator hold was flagged as a structural promotion");
});
check("GREEN · the SAME row with a topic head is still `landable` — the gate was not disabled", () => {
  assert.deepEqual(differingKeys(topicPole, trunkPole), ["headRefName"]);
  assert.equal(L.isPromotionLane(topicPole, TRUNKS), false);
  assert.equal(verdictOf(topicPole, { trunkBranches: TRUNKS }), "landable");
});

// ── PAIR 18 — EXACT equality: not a prefix, and never path-normalised ────────
check("RED  · control: a head of EXACTLY `dev` fires the arm (the near-miss pole is not vacuous)", () => {
  assert.equal(L.isPromotionLane(lane({ n: 401, head: "dev" }), TRUNKS), true);
  assert.equal(verdictOf(lane({ n: 401, head: "dev", base: "main" }), { trunkBranches: TRUNKS }), "held");
  // Every member of the derived set is protected, not just the first: `main` and
  // `master` as a HEAD are the same catastrophe as `dev`.
  for (const head of TRUNKS) {
    assert.equal(L.isPromotionLane(lane({ n: 401, head }), TRUNKS), true, `head \`${head}\` was not protected`);
  }
});
check("GREEN · `develop`, `fix/dev` and `dev-notes` are NOT promotions and stay `landable`", () => {
  // `fix/dev` is the real trap: the repo's shared `branchNameOfRef` helper takes
  // the last path segment, so a predicate reusing it would silence a genuine lane
  // whose name merely ENDS in the trunk's name.
  for (const head of ["develop", "fix/dev", "dev-notes", "feat/main", "mastering"]) {
    assert.equal(
      L.isPromotionLane(lane({ n: 402, head }), TRUNKS),
      false,
      `head \`${head}\` was read as a promotion`,
    );
    assert.equal(
      verdictOf(lane({ n: 402, head, base: "main" }), { trunkBranches: TRUNKS }),
      "landable",
      `head \`${head}\` was silenced`,
    );
  }
  // An UNRESOLVED trunk can never make a promotion: comparing two empties is not
  // a match (`instrument-discipline.md` MUST-1 — "cannot resolve" and "is the
  // trunk" are opposite meanings). Every shape an unresolved set arrives in:
  for (const set of [[], undefined, null, [""], ["   "]]) {
    assert.equal(
      L.isPromotionLane(lane({ n: 403, head: "dev" }), set),
      false,
      `an unresolved trunk set ${JSON.stringify(set)} answered "is a promotion"`,
    );
  }
  assert.equal(L.isPromotionLane(lane({ n: 404, head: "" }), TRUNKS), false);
});

// ── PAIR 18b — EVERY member of the derived set, not just the first ──────────
// `nonLaneBranches("origin/dev")` returns `["dev","main","master"]`: the trunk,
// the promotion target, and the legacy default. A head of `main` or `master` is
// the same catastrophe as a head of `dev` — `--delete-branch` does not care
// which one it deletes. This pair exists to stop the set being "simplified" back
// to a single name: do that and these two poles red, where PAIR 17 alone would
// stay green because its row happens to be headed `dev`.
check("RED  · identity: heads `main` and `master` are promotions too, not just `dev`", () => {
  for (const head of ["main", "master"]) {
    const c = L.classifyLane(lane({ n: 409, head, base: "main" }), {
      operator: "me",
      held: new Set(),
      trunkBranches: TRUNKS,
    });
    assert.equal(c.verdict, "held", `head \`${head}\` classified ${c.verdict}`);
    assert.equal(c.promotion, true, `head \`${head}\` lost the structural discriminator`);
    assert.equal(c.detail, PROMOTION_DETAIL);
  }
  // …and a lone `main`-headed row is silent end to end, exactly like `dev`.
  assert.equal(
    L.evaluateLaneCompletion([lane({ n: 409, head: "main", base: "main" })], {
      operator: "me",
      trunkBranches: TRUNKS,
    }),
    null,
  );
});
check("GREEN · a TIGHTER set containing only `dev` leaves `main` and `master` landable", () => {
  // The predicate reads the set it is GIVEN — it does not carry its own idea of
  // which names are trunks. That is what keeps the naming decision in
  // `trunk-ref.js` instead of being duplicated here, and it is why the RED pole
  // above is evidence about the SET rather than about hardcoded strings.
  for (const head of ["main", "master"]) {
    assert.equal(L.isPromotionLane(lane({ n: 410, head }), ["dev"]), false);
    assert.equal(verdictOf(lane({ n: 410, head, base: "main" }), { trunkBranches: ["dev"] }), "landable");
  }
  assert.equal(L.isPromotionLane(lane({ n: 410, head: "dev" }), ["dev"]), true);
});

// ── PAIR 19 — the key is `headRefName`, not the base / state / number ────────
check("RED  · identity: head `dev` is `held` whatever the number or the merge state says", () => {
  for (const row of [
    lane({ n: 1, head: "dev", base: "main" }),
    lane({ n: 99999, head: "dev", base: "main" }),
    lane({ n: 405, head: "dev", base: "main", merge: "UNSTABLE" }),
  ]) {
    const c = L.classifyLane(row, { operator: "me", held: new Set(), trunkBranches: TRUNKS });
    assert.equal(c.verdict, "held", `#${c.number} classified ${c.verdict}`);
    assert.equal(c.promotion, true, `#${c.number} lost the structural discriminator`);
  }
});
check("GREEN · `baseRefName: main` ALONE is not a promotion — every lane targets main eventually", () => {
  assert.equal(verdictOf(lane({ n: 406, head: "fix/some-lane", base: "main" }), { trunkBranches: TRUNKS }), "landable");
  assert.equal(verdictOf(lane({ n: 407, head: "fix/some-lane", base: "dev" }), { trunkBranches: TRUNKS }), "landable");
  assert.equal(L.isPromotionLane(lane({ n: 408, head: "fix/some-lane", base: "main" }), TRUNKS), false);
});

// ── PAIR 20 — THE REMEDY: a promotion is never reported, only COUNTED ────────
check("RED  · control: the identical row with a topic head DOES produce a reported finding", () => {
  const f = L.evaluateLaneCompletion([topicPole], { operator: "me", trunkBranches: TRUNKS });
  assert.ok(f, "the control pole produced no finding — the GREEN pole below would then prove nothing");
  assert.match(L.reportLines(f).join("\n"), /#2160/);
});
check("GREEN · a lone promotion yields NULL — no line names it, no flag is emitted", () => {
  const f = L.evaluateLaneCompletion([trunkPole], { operator: "me", trunkBranches: TRUNKS });
  assert.equal(f, null, `a lone promotion produced a finding: ${JSON.stringify(f)}`);
  const text = L.reportLines(f).join("\n");
  assert.equal(text, "");
  assert.doesNotMatch(text, /#2160/);
  assert.doesNotMatch(text, /--delete-branch/);
  assert.doesNotMatch(text, /--admin/);
  // …and in a MIXED set the promotion is still COUNTED in the denominators while
  // never being reported: silence about it must not become absence from the census.
  const mixed = L.evaluateLaneCompletion([trunkPole, lane({ n: 43 })], {
    operator: "me",
    trunkBranches: TRUNKS,
  });
  assert.ok(mixed, "the mixed set produced no finding at all");
  const mixedText = L.reportLines(mixed).join("\n");
  assert.match(mixedText, /#43/);
  assert.match(mixedText, /held-promotion=1/, "the promotion must appear in the denominators");
  assert.doesNotMatch(mixedText, /#2160/, "the promotion was REPORTED, not merely counted");
});

// ── PAIR 20b — the promotion gets its OWN denominator key ────────────────────
// `held=2` for one operator hold plus one promotion hides exactly the row this
// arm exists to make visible: the census would read as two manual suppressions
// and the structural silence would be indistinguishable from an operator's.
check("RED  · identity: a hold and a promotion read `held=1 · held-promotion=1`, never `held=2`", () => {
  const f = L.evaluateLaneCompletion(
    [lane({ n: 7 }), { ...promoBase, number: 2160, headRefName: "dev" }, lane({ n: 8 })],
    { operator: "me", held: ["7"], trunkBranches: TRUNKS },
  );
  assert.ok(f, "no finding — #8 should still be landable and reported");
  assert.equal(f.counts.held, 1, `counts.held was ${f.counts.held}`);
  assert.equal(f.counts["held-promotion"], 1, `counts["held-promotion"] was ${f.counts["held-promotion"]}`);
  const text = L.reportLines(f).join("\n");
  assert.match(text, /held=1 · held-promotion=1/);
  assert.doesNotMatch(text, /held=2/, "the promotion was folded into the operator-hold count");
});
check("GREEN · with NO promotion present the `held-promotion` key is ABSENT, not zero", () => {
  const f = L.evaluateLaneCompletion([lane({ n: 7 }), lane({ n: 8 })], {
    operator: "me",
    held: ["7"],
    trunkBranches: TRUNKS,
  });
  assert.ok(f);
  assert.equal(f.counts.held, 1);
  assert.equal("held-promotion" in f.counts, false, "an empty key would report a promotion that is not there");
  assert.doesNotMatch(L.reportLines(f).join("\n"), /held-promotion/);
});

// ── PAIR 21 — the two flags: `--admin` is gone, `--delete-branch` is CONDITIONAL
// A lane this guard calls `landable` has already satisfied branch protection —
// `BLOCKED` routes to `not-mergeable` — so `--admin` buys nothing and bypasses
// the mechanism a human approval flows through. `--delete-branch` stays, but only
// when the trunk was RESOLVED: an unresolved trunk means the guard cannot prove
// the head is not the trunk, and a delete it cannot justify is not emitted.
// THIS PAIR ASSERTS ONLY ON THE FLAGS, NEVER ON THE PROSE AROUND THEM. An
// earlier revision pinned the producer's sentence wording, and it reds on every
// copy-edit while saying nothing about behaviour — worse, the sentence it pinned
// was itself reworded BECAUSE it named the flag it was forbidding. The flag is
// the thing that can delete someone's trunk; the sentence is not. So: the
// command shape, the presence or absence of `--delete-branch`, and the absence
// of `--admin`. Nothing else.
check("RED  · identity: with a RESOLVED trunk the landable remedy DOES carry --delete-branch", () => {
  const f = L.evaluateLaneCompletion([lane({ n: 44 })], { operator: "me", trunkBranches: TRUNKS });
  assert.ok(f);
  assert.deepEqual(f.trunkBranches, TRUNKS, "the resolved trunk set must be exposed on the finding");
  const text = L.reportLines(f).join("\n");
  assert.match(text, /gh pr merge \d+ --merge --delete-branch/, "the flag is conditional, not deleted");
  assert.doesNotMatch(text, /--admin/, "--admin bypasses branch protection and must never be emitted");
});
check("GREEN · with the trunk UNRESOLVED the remedy carries NO branch-deleting flag at all", () => {
  const f = L.evaluateLaneCompletion([lane({ n: 45 })], { operator: "me" });
  assert.ok(f);
  const text = L.reportLines(f).join("\n");
  assert.match(text, /gh pr merge \d+ --merge/, "the remedy must still exist — degrade, do not blank");
  assert.doesNotMatch(text, /--delete-branch/, "an unresolved trunk cannot justify a branch delete");
  assert.doesNotMatch(text, /--admin/);
  // CONTROL — the `doesNotMatch` above must be shown able to FIRE here, or its
  // silence is indistinguishable from a matcher that cannot match (MUST-3(a)).
  // The mutation is keyed to the COMMAND, not to any sentence, so it survives a
  // reword exactly as the assertions do.
  const mutated = text.replace(/(gh pr merge \d+ --merge)/, "$1 --delete-branch");
  assert.notEqual(mutated, text, "the mutation did not reach the command — the control proves nothing");
  assert.match(mutated, /--delete-branch/, "the matcher cannot fire, so its silence above proves nothing");
});

// ═══════════════════════════════════════════════════════════════════════════
// END-TO-END, THROUGH THE REAL GUARD PROCESS
//
// The lib pairs above pin the PREDICATE. They cannot pin the REFUSAL, which is
// the thing that actually changes the agent's behaviour — a predicate that
// classifies perfectly while the guard emits `{continue:true}` is precisely the
// gap this change exists to close, and it would read GREEN on every pair above.
// So these arms drive the shipped hook as a child process against a stubbed
// `gh`, and read the FAILURE IDENTITY (`decision:"block"` + the named remedy),
// never merely that something was emitted (`instrument-bipolarity.md` MUST-2).
// ═══════════════════════════════════════════════════════════════════════════

const TMPS = [];
function mktmp(p) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  TMPS.push(d);
  return d;
}
process.on("exit", () => {
  for (const d of TMPS) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

/**
 * Drive the SHIPPED guard with a fake `gh` first on PATH.
 *
 * `prs` null ⇒ the stub EXITS NON-ZERO for `pr list` (the unavailable-forge
 * arm). `login` null ⇒ `gh api user` exits non-zero (the unattributable arm).
 */
function driveGuard({ prs, login, trunkRepo = false }, tag) {
  const proj = mktmp(`lc-proj-${tag}-`);
  fs.mkdirSync(path.join(proj, ".claude"), { recursive: true });
  const bin = mktmp(`lc-bin-${tag}-`);
  const prsPath = path.join(bin, "prs.json");
  // The forge only returns a field the caller ASKED for. The stub honours that:
  // unless the guard's `--json` list names `baseRefName`, the rows arrive without
  // it — so a guard that forgets to request the field reds the base-naming pole
  // below instead of passing on data it never fetched.
  const prsNoBasePath = path.join(bin, "prs-nobase.json");
  if (prs !== null) {
    fs.writeFileSync(prsPath, JSON.stringify(prs));
    fs.writeFileSync(
      prsNoBasePath,
      JSON.stringify(prs.map(({ baseRefName, ...rest }) => rest)),
    );
  }
  const gh = path.join(bin, "gh");
  fs.writeFileSync(
    gh,
    `#!/bin/sh
if [ "$1" = "api" ]; then
  ${login === null ? 'echo "gh: not authenticated" >&2; exit 1' : `printf '%s\\n' ${JSON.stringify(login)}`}
fi
if [ "$1" = "pr" ]; then
  ${
    prs === null
      ? 'echo "gh: could not resolve repository" >&2; exit 1'
      : `case "$*" in *baseRefName*) cat ${JSON.stringify(prsPath)} ;; *) cat ${JSON.stringify(prsNoBasePath)} ;; esac`
  }
fi
exit 0
`,
  );
  fs.chmodSync(gh, 0o755);
  const home = mktmp(`lc-home-${tag}-`);
  // Hermetic: an operator's trunk override or ambient repo pointer must not
  // steer which trunk the guard resolves.
  const gitEnvForFixture = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "COC_TRUNK_REF"]) delete gitEnvForFixture[k];
  if (trunkRepo) {
    // The project dir becomes a real repository whose bare "origin" (in its own
    // temp dir) carries `main` and `dev`, so the guard's trunk resolver answers
    // `origin/dev`. Every git write names its target with `-C <absolute>`.
    const bare = path.join(mktmp(`lc-origin-${tag}-`), "origin.git");
    const g = (...a) => {
      const res = spawnSync("git", ["-C", proj, ...a], { encoding: "utf8", env: gitEnvForFixture });
      if (res.status !== 0) throw new Error(`fixture git ${a.join(" ")} failed: ${res.stderr}`);
    };
    const init = spawnSync("git", ["init", "-q", "--bare", bare], { encoding: "utf8", env: gitEnvForFixture });
    if (init.status !== 0) throw new Error(`fixture bare init failed: ${init.stderr}`);
    g("init", "-q", "-b", "main");
    g("config", "user.email", "t@example.invalid");
    g("config", "user.name", "t");
    g("config", "commit.gpgsign", "false");
    fs.writeFileSync(path.join(proj, "seed.txt"), "seed\n");
    g("add", "seed.txt");
    g("commit", "-qm", "seed");
    g("remote", "add", "origin", bare);
    g("push", "-q", "origin", "main");
    g("push", "-q", "origin", "main:dev");
    g("fetch", "-q", "origin");
  }
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({
      hook_event_name: "Stop",
      session_id: `lc-${tag}-${Math.random().toString(36).slice(2)}`,
      cwd: proj,
      stop_hook_active: false,
    }),
    encoding: "utf8",
    env: { ...gitEnvForFixture, PATH: `${bin}:${process.env.PATH}`, HOME: home, USERPROFILE: home },
    cwd: proj,
    timeout: 30000,
  });
  let json = null;
  try {
    json = JSON.parse((r.stdout || "").trim().split("\n").pop() || "");
  } catch {}
  return { json, stdout: r.stdout, stderr: r.stderr, code: r.status };
}

const ghLane = (o) => ({
  number: o.n,
  title: o.t || "a lane",
  isDraft: !!o.draft,
  author: { login: o.author || "me" },
  mergeable: o.mergeable || "MERGEABLE",
  mergeStateStatus: o.merge || "CLEAN",
  headRefName: o.head || "fix/some-lane",
  baseRefName: o.base,
  statusCheckRollup: o.checks === undefined ? okCheck : o.checks,
});

// ── PAIR 13 — THE REFUSAL ITSELF ─────────────────────────────────────────────
check("RED  · an OWN conflicting lane REFUSES the hand-back, naming the remedy", () => {
  const r = driveGuard(
    { prs: [ghLane({ n: 1953, mergeable: "CONFLICTING", merge: "DIRTY", head: "fix/conflicted", base: "dev", checks: [] })], login: "me" },
    "red-refuse",
  );
  // IDENTITY, not "something was emitted": the block decision, the lane, and the
  // exact remedy the agent is expected to execute.
  assert.ok(r.json, `guard emitted no parseable JSON: ${r.stdout} / ${r.stderr}`);
  assert.equal(r.json.decision, "block", `expected a refusal, got ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /HAND-BACK REFUSED/);
  assert.match(r.json.reason, /#1953/);
  assert.match(r.json.reason, /CONFLICTING/);
  assert.match(r.json.reason, /git merge origin\/dev/, "the guard must REQUEST baseRefName and merge that base");
  assert.doesNotMatch(r.json.reason, /git merge origin\/main/);
  assert.match(r.json.reason, /fix\/conflicted/);
  assert.equal(r.code, 0);
});
check("RED  · a base-less conflicting row in a repo WITH origin/dev names the RESOLVED trunk, end to end", () => {
  // The forge row carries no `baseRefName`, so the guard must resolve the trunk
  // itself — and in this repository the trunk is `origin/dev`.
  const r = driveGuard(
    { prs: [ghLane({ n: 1954, mergeable: "CONFLICTING", merge: "DIRTY", head: "fix/nobase", checks: [] })], login: "me", trunkRepo: true },
    "red-trunk-nobase",
  );
  assert.ok(r.json, `guard emitted no parseable JSON: ${r.stdout} / ${r.stderr}`);
  assert.equal(r.json.decision, "block", `expected a refusal, got ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /git merge origin\/dev/, "the guard resolved the trunk for a row with no base");
  assert.match(r.json.reason, /integration trunk/);
  assert.doesNotMatch(r.json.reason, /git merge origin\/main/);
});
check("GREEN · a MERGEABLE (non-conflicting) lane stays SILENT on this arm", () => {
  // Pending checks, so the pre-existing `landable` arm is also silent — what is
  // being asserted is that nothing in the CONFLICTING path fires here.
  const r = driveGuard(
    { prs: [ghLane({ n: 200, mergeable: "MERGEABLE", merge: "CLEAN", checks: [{ name: "CI", status: "IN_PROGRESS" }] })], login: "me" },
    "green-mergeable",
  );
  assert.deepEqual(r.json, { continue: true }, `expected silence, got ${JSON.stringify(r.json)}`);
});

// ── PAIR 14 — ownership, end to end ──────────────────────────────────────────
check("RED  · control: the same row set WITH my login does refuse (the pair is not vacuous)", () => {
  const rows = [ghLane({ n: 201, author: "me", mergeable: "CONFLICTING", merge: "DIRTY", checks: [] })];
  const r = driveGuard({ prs: rows, login: "me" }, "red-own");
  assert.equal(r.json && r.json.decision, "block", JSON.stringify(r.json));
});
check("GREEN · a SIBLING's conflicting lane produces NO refusal", () => {
  const rows = [ghLane({ n: 201, author: "someone-else", mergeable: "CONFLICTING", merge: "DIRTY", checks: [] })];
  const r = driveGuard({ prs: rows, login: "me" }, "green-sibling");
  assert.deepEqual(r.json, { continue: true }, `a sibling's conflict refused: ${JSON.stringify(r.json)}`);
});

// ── PAIR 15 — the forge is ZERO EVIDENCE when it does not answer ─────────────
check("RED  · control: the SAME lane refuses when `gh` answers normally", () => {
  const rows = [ghLane({ n: 202, mergeable: "CONFLICTING", merge: "DIRTY", checks: [] })];
  const r = driveGuard({ prs: rows, login: "me" }, "red-ghok");
  assert.equal(r.json && r.json.decision, "block", JSON.stringify(r.json));
});
check("GREEN · an ERRORED `gh pr list` is silence, never a refusal and never an all-clear", () => {
  const r = driveGuard({ prs: null, login: "me" }, "green-gherr");
  assert.deepEqual(r.json, { continue: true }, `an unreadable forge produced ${JSON.stringify(r.json)}`);
  // …and an UNAUTHENTICATED `gh api user` makes ownership unknown, so the
  // conflicting arm cannot attribute the lane and stays silent too.
  const rows = [ghLane({ n: 203, mergeable: "CONFLICTING", merge: "DIRTY", checks: [] })];
  const r2 = driveGuard({ prs: rows, login: null }, "green-noauth");
  assert.deepEqual(r2.json, { continue: true }, `an unattributable conflict refused: ${JSON.stringify(r2.json)}`);
});

// ── PAIR 16 — the bounds survive the new arm ─────────────────────────────────
check("RED  · control: with the kill switch OFF the conflicting lane refuses", () => {
  const rows = [ghLane({ n: 204, mergeable: "CONFLICTING", merge: "DIRTY", checks: [] })];
  assert.equal(driveGuard({ prs: rows, login: "me" }, "red-ks").json.decision, "block");
});
check("GREEN · COC_LANE_COMPLETION=0 and COC_STOP_REFUSAL=off each remove the refusal", () => {
  const rows = [ghLane({ n: 205, mergeable: "CONFLICTING", merge: "DIRTY", checks: [] })];
  // The predicate-level switch silences the finding entirely.
  assert.equal(L.evaluateLaneCompletion(rows, { operator: "me", env: { COC_LANE_COMPLETION: "0" } }), null);
  // The refusal-level switch leaves the finding but removes the teeth.
  const saved = process.env.COC_STOP_REFUSAL;
  process.env.COC_STOP_REFUSAL = "off";
  try {
    const r = driveGuard({ prs: rows, login: "me" }, "green-ks");
    assert.ok(r.json && !("decision" in r.json), `refused with the kill switch off: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.continue, true);
  } finally {
    if (saved === undefined) delete process.env.COC_STOP_REFUSAL;
    else process.env.COC_STOP_REFUSAL = saved;
  }
});

// ── PAIR 22 — THE PROMOTION, END TO END THROUGH THE REAL GUARD ──────────────
// `trunkRepo: true` builds a repository whose origin carries BOTH `main` and
// `dev`, so the guard's OWN resolver answers `origin/dev` and derives the bare
// trunk branch itself. Nothing here hands the guard the answer.
//
// WHY THE CONTROL IS NOT OPTIONAL. The green pole alone proves nothing:
// `{continue:true}` is byte-identical to what a guard that crashed, timed out,
// never reached the forge, or was silenced by an unrelated bound emits, and a
// stdout containing no `--delete-branch` is satisfied trivially by silence
// (`instrument-discipline.md` MUST-3(a) — an instrument never shown to fire
// here). The control fires the SAME guard, in the SAME repo, against the SAME
// stub, with the SAME row differing only in `headRefName`, and must REFUSE while
// carrying `--delete-branch` — so the green pole's absence is a separation on the
// head, not a guard that had nothing to say.
//
// THE ORDERING THIS PAIR PINS IS LOAD-BEARING — do not tidy it away. The control
// asserts the refusal carries `--delete-branch`, which is only true if the guard
// resolved the trunk set BEFORE calling `evaluateLaneCompletion`. That ordering
// is required by the fix rather than incidental to it: `classifyLane` cannot
// recognise a promotion without `trunkBranches`, so a refactor back to resolving
// the trunk lazily (only when a conflicting row lacks a base, as the pre-R8 guard
// did) silently kills promotion detection — and EVERY lib-level pair above would
// stay green while it did, because they are handed the set directly.
check("RED  · control: the same row with a topic head REFUSES and carries --delete-branch, never --admin", () => {
  const r = driveGuard(
    {
      prs: [ghLane({ n: 2160, t: "promote dev to main", head: "fix/some-lane", base: "main" })],
      login: "me",
      trunkRepo: true,
    },
    "red-promo-control",
  );
  assert.ok(r.json, `guard emitted no parseable JSON: ${r.stdout} / ${r.stderr}`);
  assert.equal(r.json.decision, "block", `expected a refusal, got ${JSON.stringify(r.json)}`);
  assert.match(r.json.reason, /#2160/);
  assert.match(
    r.json.reason,
    /--delete-branch/,
    "the guard resolved the trunk branch, so a genuine lane's remedy still cleans up",
  );
  assert.doesNotMatch(r.json.reason, /--admin/, "--admin bypasses branch protection and must never be emitted");
});
check("GREEN · a trunk-headed promotion produces NO refusal and NO destructive flag", () => {
  const r = driveGuard(
    {
      prs: [ghLane({ n: 2160, t: "promote dev to main", head: "dev", base: "main" })],
      login: "me",
      trunkRepo: true,
    },
    "green-promo",
  );
  assert.deepEqual(r.json, { continue: true }, `a promotion of the trunk was refused: ${JSON.stringify(r.json)}`);
  assert.doesNotMatch(r.stdout || "", /--delete-branch/, "the trunk `dev` was handed a delete command");
  assert.doesNotMatch(r.stdout || "", /--admin/);
});

for (const r of results) console.log(r);
console.log(`\nlane-completion fixtures: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
