"use strict";
/**
 * THE INTEGRATION TRUNK — one resolver, every landedness surface.
 *
 * Directive 2026-09-10: lane work lands in `dev` continuously and for FREE;
 * `dev -> main` is a separate, deliberate promotion costing exactly one CI run.
 * "Landed" therefore means "in dev", and every landed/unlanded predicate must
 * measure against the same ref.
 *
 * ROOT CAUSE THIS FIXES. loom's gate fires on `pull_request` to main and on
 * `push: branches: [main]`, so the ONLY route to main cost a CI run on a shared
 * pool. While "landed" meant "on main", closing a branch always meant spending
 * CI, so every session rationally deferred and the WIP ceiling ratcheted. The
 * guards were not being ignored — they gated an exit with nowhere cheap to go.
 * Pointing them at a trunk reachable for free is what lets them TERMINATE.
 *
 * WHY A SHARED RESOLVER AND NOT N EDITS. Retargeting each predicate separately
 * is the enforcement-surface-parity defect (`security.md` § Enforcement-Surface
 * Parity): one surface learns the new trunk, a sibling does not, and they
 * disagree about what "landed" means. That disagreement is exactly the class
 * that produced the protected-ref deadlock earlier in this same session. One
 * predicate, imported — never copied.
 *
 * FAIL-SAFE FOR THE CASCADE. This ships downstream to build/use repos that have
 * NOT created `dev` yet. Resolution is therefore: explicit env override, else
 * `<remote>/dev` IF IT EXISTS, else `<remote>/main`. A repo without `dev` keeps
 * its current behaviour exactly — adoption is opt-in by creating the branch,
 * never by a flag day.
 *
 * BOUNDED WHEN THE CALLER IS. A probe is a git spawn, and a hook that calls this
 * inside a decision budget must be able to keep it inside that budget. Every
 * probing entry point takes an optional `timeoutMs`: absent, the probe is
 * unbounded exactly as before; a positive number bounds the spawn; zero or less
 * means the caller's budget is already spent, so NO spawn is made. A probe that
 * runs out of time is UNDETERMINED — never "absent", which would silently fall
 * the ladder through to main.
 */
const { execFileSync } = require("node:child_process");
const { resolveGitBinary, gitEnv } = require("./git-subprocess-env.js");

const ENV_KEY = "COC_TRUNK_REF";

/**
 * One probe, with the one extra bit a caller needs to NAME why it is undetermined:
 * whether the caller's time ran out. `{verdict, timedOut}`.
 */
function _probe(repoDir, ref, timeoutMs) {
  const bounded = typeof timeoutMs === "number" && Number.isFinite(timeoutMs);
  if (bounded && timeoutMs <= 0) return { verdict: "undetermined", timedOut: true };
  const gitBin = resolveGitBinary();
  if (!gitBin) return { verdict: "undetermined", timedOut: false };
  try {
    execFileSync(gitBin, ["rev-parse", "--verify", "--quiet", ref], {
      cwd: repoDir,
      stdio: ["ignore", "ignore", "ignore"],
      env: gitEnv(),
      ...(bounded
        ? { timeout: Math.max(1, Math.floor(timeoutMs)), killSignal: "SIGKILL" }
        : {}),
    });
    return { verdict: "present", timedOut: false };
  } catch (e) {
    if (e && e.code === "ENOENT") return { verdict: "undetermined", timedOut: false };
    if (e && e.status === 1) return { verdict: "absent", timedOut: false };
    // A bounded spawn killed by its timeout carries ETIMEDOUT (or a signal and no
    // exit status). Either way it is not an answer about the ref.
    const timedOut =
      bounded &&
      Boolean(e && (e.code === "ETIMEDOUT" || (e.signal && e.status === null)));
    return { verdict: "undetermined", timedOut };
  }
}

function probeRef(repoDir, ref, { timeoutMs } = {}) {
  // THREE-VALUED, and that is the whole point of this change.
  //
  // The first revision folded two DIFFERENT questions into one boolean: "is this
  // ref absent?" and "can I not tell?". Its own comment admitted it -- "A missing
  // ref and an unrunnable git are INDISTINGUISHABLE here" -- which is exactly the
  // non-discriminating instrument `instrument-discipline.md` MUST-1 forbids: the
  // result was consistent with both branches of the hypothesis, so a broken git
  // silently became "dev is absent" and the ladder fell through to main. That is
  // the "silent fallback to another trunk" the operating directive prohibits.
  //
  // The discriminator is the FAILURE SHAPE, not the exit code alone:
  //   no throw            -> present     (git ran, --verify --quiet succeeded)
  //   status === 1        -> absent      (git ran and the ref genuinely is not there)
  //   ENOENT / no binary  -> undetermined (cwd missing, or git unresolvable)
  //   status === 128      -> undetermined ("not a git repository", other fatals)
  //   timed out / no time -> undetermined (the caller's budget, never "absent")
  //   anything else       -> undetermined (fail toward not-knowing, never toward absent)
  return _probe(repoDir, ref, timeoutMs).verdict;
}

/**
 * BOOLEAN back-compat over `probeRef`. `undetermined` collapses to false here,
 * which is what lets a non-repo caller fall back rather than throw out of a hook
 * -- the contract `trunk-ref.test.mjs` pins deliberately. Callers that must not
 * confuse "absent" with "cannot tell" MUST use `probeRef` or `resolveTrunk`.
 */
function refExists(repoDir, ref) {
  return probeRef(repoDir, ref) === "present";
}

/**
 * THE STRICT RESOLVER -- decision-grade, and the one a landedness predicate MUST use.
 *
 * @param {{repoDir?:string, remote?:string, timeoutMs?:number}} [o] `timeoutMs`
 *   bounds each probe; absent ⇒ unbounded; `<= 0` ⇒ no probe runs (UNDETERMINED).
 * @returns {{status:"resolved"|"undetermined", ref:string|null, basis:string, reason:string|null}}
 *
 * `basis` names WHY this ref was chosen, so a caller can tell an operator's
 * declaration from a discovery from a fallback:
 *   "override"      -- COC_TRUNK_REF, probed and present
 *   "dev"           -- <remote>/dev exists
 *   "main-fallback" -- <remote>/dev is genuinely ABSENT (a repo that has not
 *                      adopted the trunk yet). DECLARED, not silent: the basis
 *                      says so, and adoption stays opt-in by creating the branch.
 *
 * UNDETERMINED is a THIRD verdict and is never collapsed into either of the other
 * two. An operator-declared override that does not resolve is the sharpest case:
 * it is not "fall back to main", it is "the operator declared something this repo
 * cannot honour", and reporting it as main would answer a question nobody asked.
 * An undetermined result whose probe ran out of the caller's time carries
 * `timedOut: true`, so the caller can say WHICH it was.
 */
function resolveTrunk({ repoDir = process.cwd(), remote = "origin", timeoutMs } = {}) {
  return _ladder((ref) => _probe(repoDir, ref, timeoutMs), remote, {
    override: (decl, p) =>
      p.timedOut
        ? `${decl} could not be probed within the caller's ${timeoutMs}ms budget — the trunk is UNMEASURED`
        : `${decl} could not be probed (git unrunnable or ${repoDir} is not a repository)`,
    ladder: (dev, p) =>
      p.timedOut
        ? `cannot probe ${dev} within the caller's ${timeoutMs}ms budget — the trunk is UNMEASURED`
        : `cannot probe ${dev} (git unrunnable or ${repoDir} is not a repository)`,
  });
}

/**
 * THE LADDER — ONE copy, whatever answers the probe. `resolveTrunk` probes git;
 * `resolveTrunkFromRefs` reads a ref set already in hand. Two copies of the ladder
 * would be the parity defect this module exists to prevent, one level down.
 * `say` supplies only the UNDETERMINED wording, which depends on the probe.
 */
function _ladder(probe, remote, say) {
  const raw = process.env[ENV_KEY];
  const override = raw && raw.trim() ? raw.trim() : null;
  if (override) {
    const p = probe(override);
    if (p.verdict === "present") {
      return { status: "resolved", ref: override, basis: "override", reason: null };
    }
    return {
      status: "undetermined",
      ref: null,
      // The ref we ASKED about, carried even though we could not resolve it, so a
      // caller reports WHAT it failed to measure rather than a bare failure.
      // Pinned by trunk-ref.test.mjs "an UNANSWERABLE gap is ok:false and carries
      // NO ahead", which caught this exact information loss in review.
      asked: override,
      basis: "override",
      ...(p.timedOut ? { timedOut: true } : {}),
      reason:
        p.verdict === "absent"
          ? `${ENV_KEY}=${override} does not resolve in this repository`
          : say.override(`${ENV_KEY}=${override}`, p),
    };
  }

  const dev = `${remote}/dev`;
  const pd = probe(dev);
  if (pd.verdict === "present") return { status: "resolved", ref: dev, basis: "dev", reason: null };
  if (pd.verdict === "absent") {
    return { status: "resolved", ref: `${remote}/${PROMOTION_BRANCH}`, basis: "main-fallback", reason: null };
  }
  return {
    status: "undetermined",
    ref: null,
    asked: dev,
    basis: "ladder",
    ...(pd.timedOut ? { timedOut: true } : {}),
    reason: say.ladder(dev, pd),
  };
}

/**
 * The full refname a short or full ref resolves to IN A REF SET, or null — git's
 * own DWIM order (git-rev-parse(1), SPECIFYING REVISIONS): `refs/<name>`,
 * `refs/tags/<name>`, `refs/heads/<name>`, `refs/remotes/<name>`,
 * `refs/remotes/<name>/HEAD`.
 */
function matchRefInSet(refnames, ref) {
  if (typeof ref !== "string" || !ref) return null;
  const candidates = ref.startsWith("refs/")
    ? [ref]
    : [`refs/${ref}`, `refs/tags/${ref}`, `refs/heads/${ref}`, `refs/remotes/${ref}`, `refs/remotes/${ref}/HEAD`];
  return candidates.find((c) => refnames.has(c)) || null;
}

/**
 * THE SAME LADDER over a ref set ALREADY READ — no spawn.
 *
 * For a caller holding an unfiltered `for-each-ref` (the census) that must not pay a
 * probe to learn which of those refs is the trunk. It answers exactly as
 * `resolveTrunk` wherever a ref set can decide — `<remote>/dev` is present or absent
 * by membership. It is UNDETERMINED, never "absent", for an override a ref set
 * cannot decide without git: an object name, a revision expression, or a pseudo-ref
 * such as `HEAD`. Reading those as absent would fall through to main in silence.
 *
 * @param {{refnames: Iterable<string>, remote?: string}} o full refnames (`refs/…`)
 */
function resolveTrunkFromRefs({ refnames, remote = "origin" } = {}) {
  const set = refnames instanceof Set ? refnames : new Set(refnames || []);
  const verdict = (ref) => {
    if (matchRefInSet(set, ref)) return "present";
    if (/^[0-9a-f]{4,64}$/i.test(ref) || /[~^:@{}\\\s*?[]/.test(ref) || /^[A-Z_]+$/.test(ref)) {
      return "undetermined";
    }
    return "absent";
  };
  return _ladder((ref) => ({ verdict: verdict(ref), timedOut: false }), remote, {
    override: (decl) =>
      `${decl} is not a ref name a ref set can decide without asking git (an object name, a revision expression, or a pseudo-ref)`,
    ladder: (dev) => `cannot decide ${dev} from the ref set`,
  });
}

/** The promotion target — the branch `promotionGap` measures the trunk against. */
const PROMOTION_BRANCH = "main";

/**
 * Pre-existing, MOVED here rather than invented: every lane enumerator in
 * `wip-lanes.js` excluded `master` beside `main` before the trunk moved to dev.
 */
const LEGACY_DEFAULT_BRANCHES = Object.freeze(["master"]);

/**
 * The branch NAMES that are trunk, not lanes, for a RESOLVED trunk ref — the
 * trunk's own branch, the promotion target, and the legacy default.
 *
 * DERIVED from the ref the resolver named, never a list of `dev` literals: a repo
 * whose trunk is `main` still counts a local branch called `dev` as the lane it is.
 * The branch name comes from `reap-on-landing.js::branchNameOfRef`, the derivation
 * the reap guard already fences the trunk with, so the two surfaces cannot
 * disagree about which branch a base ref names.
 */
function nonLaneBranches(trunk) {
  const { branchNameOfRef } = require("./reap-on-landing.js");
  const own = typeof trunk === "string" ? branchNameOfRef(trunk) : null;
  return [...new Set([own, PROMOTION_BRANCH, ...LEGACY_DEFAULT_BRANCHES].filter(Boolean))];
}

/**
 * LENIENT STRING API -- back-compat, and NOT decision-grade.
 *
 * @returns {string} e.g. "origin/dev" or "origin/main" -- never null, so no hook
 * has to handle an unresolved trunk mid-session.
 *
 * Deliberately preserves two pinned behaviours the strict resolver does not:
 * an override is returned AS DECLARED without probing (the short-circuit case),
 * and an undetermined ladder yields `<remote>/main` rather than throwing. Those
 * keep hooks alive on a broken checkout. The cost is that this function CANNOT
 * distinguish a real trunk from a guess, so any caller deciding what has LANDED
 * must use `resolveTrunk` and handle `undetermined` -- which `promotionGap`
 * below and every predicate in `wip-lanes.js` now do.
 */
function trunkRef({ repoDir = process.cwd(), remote = "origin" } = {}) {
  const raw = process.env[ENV_KEY];
  if (raw && raw.trim()) return raw.trim();
  return probeRef(repoDir, `${remote}/dev`) === "present"
    ? `${remote}/dev`
    : `${remote}/main`;
}

/** The promotion gap: commits on the trunk not yet on main. */
function promotionGap({ repoDir = process.cwd(), remote = "origin", timeoutMs = 0 } = {}) {
  const main = `${remote}/main`;
  // `timeoutMs` BOUNDS THE WHOLE MEASUREMENT for a caller that runs inside a hook
  // budget (the SessionStart surface): the trunk probe and the count share it, and
  // each receives only what is LEFT. Before, only the count was bounded and the
  // probe could spend unbounded time first. `0` keeps the unbounded contract.
  const bounded = Number.isInteger(timeoutMs) && timeoutMs > 0;
  const startedAt = Date.now();
  const left = () => timeoutMs - (Date.now() - startedAt);
  // STRICT resolver here, deliberately. This is a LANDEDNESS DECISION, and a
  // number measured against a trunk we could not resolve is worse than no number:
  // it reads as current and is unfalsifiable from the caller's side.
  const r = resolveTrunk({ repoDir, remote, ...(bounded ? { timeoutMs: left() } : {}) });
  if (r.status === "undetermined") {
    return { ok: false, undetermined: true, trunk: r.asked ?? null, main, reason: r.reason, basis: r.basis };
  }
  const trunk = r.ref;
  if (trunk === main) {
    return { ok: true, ahead: 0, trunk, main, sameRef: true, basis: r.basis };
  }
  try {
    const gitBin = resolveGitBinary();
    if (!gitBin) return { ok: false, undetermined: true, trunk, main, reason: "git unresolvable", basis: r.basis };
    // An expiry throws, which lands in the catch below as `ok:false` with NO
    // `ahead` — a bound is never reported as a number.
    const remaining = bounded ? left() : 0;
    if (bounded && remaining <= 0) {
      return { ok: false, trunk, main, basis: r.basis, reason: `the ${timeoutMs}ms budget was spent resolving the trunk` };
    }
    const bound = bounded ? { timeout: remaining, killSignal: "SIGKILL" } : {};
    const out = execFileSync(gitBin, ["rev-list", "--count", `${main}..${trunk}`], {
      cwd: repoDir,
      encoding: "utf8",
      env: gitEnv(),
      stdio: ["ignore", "pipe", "ignore"],
      ...bound,
    }).trim();
    const n = Number.parseInt(out, 10);
    if (!Number.isFinite(n)) return { ok: false, trunk, main, basis: r.basis };
    return { ok: true, ahead: n, trunk, main, sameRef: false, basis: r.basis };
  } catch {
    return { ok: false, trunk, main, basis: r.basis };
  }
}

/**
 * THE DELETION-GRADE RESOLVER -- `resolveTrunk` plus the one question it does
 * not ask: is this ref actually the TRUNK?
 *
 * ── THE GAP, and why `resolveTrunk` is nevertheless correct as it stands ────
 *
 * `resolveTrunk` accepts a `COC_TRUNK_REF` override on the sole evidence that it
 * RESOLVES (`probeRef === "present"`). That is the right bar for the question it
 * was built for: READING landedness, where the whole safety argument is
 * direction of error -- a stale or wrong base makes FEWER branches look landed,
 * so the surface under-reports and stays quiet. Silence is cheap.
 *
 * It is NOT the right bar once the answer PROPOSES A DELETION. There the error
 * direction inverts: a base that is a CONTENT SUPERSET of every lane -- any
 * long-lived integration ref, a release branch, a personal fork's tip, or simply
 * an older ref that happens to contain everything -- makes every lane branch read
 * LANDED, and the consumer proposes `git branch -d` / `git push origin --delete`
 * against work that is on no trunk at all. The module's own "stale trunk
 * under-reports" argument holds ONLY while the base IS the trunk; nothing in the
 * override path establishes that.
 *
 * ── THE CHOICE: VALIDATE, rather than refuse overrides outright ────────────
 *
 * Refusing every override for deletion consumers would be simpler and was
 * rejected: a repo whose trunk is legitimately named something else (`develop`,
 * `release-2`, `trunk`) would lose deletion support entirely, and an operator
 * who cannot declare their trunk will point the tool at the wrong base some
 * other way. So an override is ACCEPTED when it is corroborated by a source the
 * operator does not control through this one variable:
 *
 *   - the remote's DECLARED default branch (`refs/remotes/<remote>/HEAD`), which
 *     is the same source `remote-ref-reap.mjs` already treats as authoritative;
 *   - `<remote>/dev`, the trunk this ecosystem's directive names;
 *   - `<remote>/main`, the fallback every non-adopting repo still lands on.
 *
 * Anything else resolves but is NOT corroborated, and comes back with
 * `verified:false` and status `"unverified"` -- a THIRD verdict, deliberately
 * distinct from `"undetermined"`. Undetermined means "I could not measure";
 * unverified means "I measured, and it is not shown to be the trunk". A consumer
 * must be able to keep REPORTING against an unverified base (it is still the
 * base the operator asked for) while emitting no DELETE proposals against it,
 * and collapsing the two would force it to choose between over-refusing and
 * over-deleting.
 *
 * NEW EXPORT, not a change to `resolveTrunk`. Every existing caller keeps the
 * exact `{status, ref, basis, reason, asked}` shape it pins; this adds `verified`
 * on top for the callers that delete. The non-override paths are pass-through and
 * VERIFIED by construction -- `dev` and `main-fallback` are discoveries, not
 * declarations, so `COC_TRUNK_REF` cannot reach them.
 *
 * @returns {{status:"resolved"|"unverified"|"undetermined", ref:string|null,
 *            basis:string, reason:string|null, verified:boolean}}
 */
function resolveTrunkForDeletion({ repoDir = process.cwd(), remote = "origin" } = {}) {
  const r = resolveTrunk({ repoDir, remote });
  if (r.status !== "resolved") return { ...r, verified: false };
  if (r.basis !== "override") return { ...r, verified: true };

  const corroborated = new Set([`${remote}/dev`, `${remote}/main`]);
  const gitBin = resolveGitBinary();
  if (gitBin) {
    try {
      const head = execFileSync(
        gitBin,
        ["symbolic-ref", "-q", `refs/remotes/${remote}/HEAD`],
        { cwd: repoDir, encoding: "utf8", env: gitEnv(), stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      if (head.startsWith("refs/remotes/")) corroborated.add(head.slice("refs/remotes/".length));
    } catch {
      // No `origin/HEAD` in this repository (never cloned, or never set). That
      // narrows the corroborating set; it does not license the override. The
      // remaining two members still corroborate, and anything else stays
      // unverified -- which is the fail-closed direction for a deletion.
    }
  }
  if (corroborated.has(r.ref)) return { ...r, verified: true };
  return {
    status: "unverified",
    ref: r.ref,
    basis: "override",
    verified: false,
    reason:
      `${ENV_KEY}=${r.ref} resolves, but is not shown to be this repository's trunk ` +
      `(it is not \`refs/remotes/${remote}/HEAD\`, \`${remote}/dev\`, or \`${remote}/main\`). ` +
      `Landedness measured against it is REPORTABLE but is NOT grounds for deleting a ref: ` +
      `a base that merely CONTAINS every lane's content makes every lane read landed.`,
  };
}


module.exports = {
  trunkRef,
  resolveTrunk,
  resolveTrunkForDeletion,
  resolveTrunkFromRefs,
  matchRefInSet,
  nonLaneBranches,
  PROMOTION_BRANCH,
  promotionGap,
  refExists,
  probeRef,
  ENV_KEY,
};
