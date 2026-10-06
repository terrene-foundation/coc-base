/**
 * rebase-content-loss.js — the two structural questions behind loom#1773.
 *
 *   (1) Is this command about to REPLAY a branch that carries merge commits,
 *       without asking git to preserve them?           → classifyRebaseCommand
 *   (2) Which commits on a pre-rebase ref have CONTENT that is no longer
 *       present on HEAD?                               → verifyContentPresence
 *
 * WHY THIS MODULE EXISTS
 * ──────────────────────
 * A branch ASSEMBLED by merging feature branches in has no stable identity under
 * `git rebase`. Plain rebase replays a LINEARISED commit list and drops merge
 * commits; across repeated passes, each with its own conflict resolution, the
 * content those merges carried stops being present — silently. Measured on one
 * integration lane: 47 commits → 25, merge commits 15 → 1, four already-reviewed
 * fixes gone. The PR stayed green because the tests covering the dropped fixes
 * were dropped alongside them.
 *
 * The landing-discipline guards in this family all answer "should this branch
 * reach CI or the trunk at all?" — open-PR count, PR head shape, push cadence.
 * None answers "does this branch still CONTAIN what it contained an hour ago?"
 *
 * WHY (2) IS PATCH-APPLY AND NOT SHA MEMBERSHIP
 * ─────────────────────────────────────────────
 * A rebased commit carries a DIFFERENT sha and IDENTICAL content, so
 * `git merge-base --is-ancestor` / `rev-list ^HEAD` report loss for every commit
 * a correct rebase rewrote — a false-positive rate of 100% on the successful
 * case. The issue's own author made exactly that error while writing it up: ten
 * "dropped" fixes re-measured to four dropped, four never dropped (sitting in an
 * open unmerged PR), two diverged. "Not on the trunk" is not "lost", and the
 * three-way verdict below is what separates them.
 *
 * Each commit's patch is applied against a TEMPORARY INDEX seeded from the
 * target ref, forward and reversed:
 *
 *   forward applies, reverse does not   → ABSENT   (the content is gone)
 *   reverse applies, forward does not   → PRESENT  (already there, any sha)
 *   neither applies                     → DIVERGED (partially there / conflicts)
 *   both apply                          → INDETERMINATE (reported, never scored)
 *   empty patch                         → NO-CONTENT (nothing to lose)
 *
 * Nothing here touches the working tree, the real index, or any ref: the
 * temporary index is written to a caller-owned scratch path and `--check` never
 * mutates. Verified empirically against a throwaway repo before this file was
 * written (see the suite's end-to-end case, which rebuilds that repo).
 *
 * Style: CommonJS, matching the rest of .claude/hooks/lib/. Pure functions over
 * an injectable `runGit`, so the suite drives them without stubbing modules.
 * NEVER throws — every failure becomes a typed, named, fail-OPEN result.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { parseGitInvocations, tokenize, stripRedirectionTokens } = require(
  path.join(__dirname, "git-command-parse.js"),
);
const { resolveGitBinary, gitEnv } = require(
  path.join(__dirname, "git-subprocess-env.js"),
);

/**
 * Does this command relocate the REPOSITORY with `--git-dir`?
 *
 * `parseGitInvocation` deliberately reports only the effective WORK TREE
 * (`-C` / `--work-tree`), because `--git-dir` relocates the repo and not the
 * tree — the right answer for the destructive-op fences it was built for. This
 * guard asks a different question: the merge count is a property of the REFS,
 * so a `--git-dir` pointing elsewhere means the tree we would measure is not
 * the branch git would replay. Measuring the session repo there would be
 * `instrument-discipline.md` MUST-4 exactly — a sound instrument read for a
 * question it was not built for.
 *
 * The check is a token scan over the WHOLE command and is therefore DELIBERATELY
 * OVER-BROAD: it will trip on a `--git-dir` in an unrelated segment. That is
 * sound because its ONLY consequence is FAIL-OPEN — this predicate can never
 * cause a block, so a false positive costs a missed measurement and never a
 * wrongly-refused command. Extending the shared parser to carry `--git-dir`
 * would change behaviour for every other consumer of it and is not this
 * change's to make.
 */
function namesAnotherGitDir(command) {
  // Routed for the same reason as the other `tokenize` call sites even though no
  // redirection token can currently change this answer (it only tests for
  // `--git-dir`). Stated rather than skipped: leaving ONE consumer on the raw
  // stream is how the next `--git-dir`-adjacent predicate added here inherits
  // the defect silently.
  return stripRedirectionTokens(tokenize(String(command || ""))).some(
    (t) => t.value === "--git-dir" || t.value.startsWith("--git-dir="),
  );
}

/**
 * Is a replay verb lexically present anywhere in this command?
 *
 * Used for ONE purpose and no other: deciding whether an UNREADABLE command
 * shape is worth telling the operator about. It gates an advisory, never a
 * refusal — see the call site for why that makes a lexical test the right
 * instrument here rather than a rule violation.
 */
function mentionsReplayVerb(command) {
  return /(?:^|[^\w-])(?:rebase|pull)(?![\w-])/.test(String(command || ""));
}

/**
 * POSITIVE ALLOWLIST 1 — `git rebase` modes that REPLAY NOTHING.
 *
 * Per `cc-artifacts.md` Rule 10: git-rebase(1)'s control vocabulary is
 * enumerable, so it is spelled out rather than inferred. These resume, abandon
 * or inspect an in-progress rebase; none of them replays a commit list, so none
 * can drop a merge.
 *
 * NAMED RESIDUAL: a control mode git adds AFTER this list is written falls
 * through to the replay path and, on a branch that really does carry merges,
 * produces a block the operator must clear with the override. That direction is
 * chosen deliberately — the opposite default would silently exempt whatever the
 * list has not learned yet, which is the bug class this guard exists to close.
 */
const NON_REPLAY_REBASE_MODES = new Set([
  "--abort",
  "--continue",
  "--skip",
  "--quit",
  "--edit-todo",
  "--show-current-patch",
]);

/**
 * POSITIVE ALLOWLIST 2 — the spellings that ask git to PRESERVE merges.
 *
 * `--rebase-merges` takes an OPTIONAL attached value
 * (`--rebase-merges=no-rebase-cousins`), so the attached form is matched by
 * prefix on the token, never by substring on a joined string. `-r` is its short
 * form. `-p` / `--preserve-merges` is the removed predecessor: still accepted
 * here because an operator on an older git who spells it is asking for exactly
 * the protection this guard checks for, and refusing them would train the
 * override into a reflex.
 */
const MERGE_PRESERVING_REBASE_FLAGS = new Set([
  "-r",
  "--rebase-merges",
  "-p",
  "--preserve-merges",
]);

/**
 * POSITIVE ALLOWLIST 3 — `git rebase` flags whose value is a SEPARATE word.
 *
 * Needed only to find the POSITIONAL arguments (`<upstream>` and `<branch>`).
 * SEPARATE-word values ONLY: `--strategy=ours`, `-Xtheirs`, `--empty=drop`,
 * `--whitespace=fix` and `-S<keyid>` all carry their value ATTACHED and are
 * already skipped by the generic dash-prefix branch, so listing them here would
 * swallow the following word — which is exactly the `<upstream>` positional.
 *
 * Getting an entry wrong cannot produce a wrong verdict in the dangerous
 * direction: a misread positional is handed to `git rev-parse --verify`, and
 * anything that does not resolve to a real commit takes the fail-OPEN path.
 */
const REBASE_VALUE_FLAGS = new Set([
  "--onto",
  "-s",
  "--strategy",
  "-X",
  "--strategy-option",
  "-x",
  "--exec",
]);

/** `git pull` spellings that rebase and FLATTEN. `merges`/`m` preserve. */
const PULL_FLATTENING_REBASE_VALUES = new Set([
  "true",
  "interactive",
  "i",
  "1",
  "yes",
]);
const PULL_PRESERVING_REBASE_VALUES = new Set(["merges", "m", "preserve", "p"]);

/**
 * The environment variable an operator sets to proceed anyway. It MUST NAME ITS
 * REASON: a bare `=1` is rejected, so the override cannot become a reflex the
 * next reader has to reverse-engineer. The threshold is deliberately low enough
 * that a real sentence clears it and high enough that a placeholder does not.
 */
const OVERRIDE_ENV = "COC_REBASE_FLATTEN_ACK";
const OVERRIDE_MIN_REASON_CHARS = 16;

function readOverride(env) {
  const raw = env && env[OVERRIDE_ENV];
  if (raw === undefined || raw === null) {
    return { present: false, accepted: false, reason: null, rejected: null };
  }
  const reason = String(raw).trim();
  if (reason.replace(/\s+/g, "").length < OVERRIDE_MIN_REASON_CHARS) {
    return {
      present: true,
      accepted: false,
      reason,
      rejected: `${OVERRIDE_ENV} is set but names no reason (needs at least ${OVERRIDE_MIN_REASON_CHARS} non-whitespace characters; got ${reason.replace(/\s+/g, "").length}).`,
    };
  }
  return { present: true, accepted: true, reason, rejected: null };
}

// ── git subprocess seam ─────────────────────────────────────────────────────

/**
 * The default runner. Returns `{ ok, stdout, code, error }` and NEVER throws —
 * a missing binary, a non-zero exit and a timeout are all `ok: false` with a
 * named cause, which is what makes every caller's fail-OPEN branch reachable.
 *
 * Routed through `git-subprocess-env.js` (loom#1462/#1471), NOT a literal
 * `spawnSync("git", …)`. Two reasons, both load-bearing here rather than
 * inherited boilerplate:
 *
 *   · `resolveGitBinary()` returns an ABSOLUTE path, so which binary answered
 *     is a fact rather than a PATH inference — and this guard's whole warrant
 *     for refusing a call is that its count came from git.
 *   · `gitEnv()` builds an explicit MINIMAL environment. Nothing is inherited,
 *     so an ambient `GIT_DIR` cannot re-point the count at a repository the
 *     operator is not rebasing. Without it, `cwd` and `-C` choose a DIRECTORY
 *     while `GIT_DIR` chooses the REPOSITORY, and the two can disagree.
 *
 * `extraEnv` is MERGED ONTO that minimal env, never onto `process.env` — the
 * verifier needs `GIT_INDEX_FILE` and must get it without reopening the hole.
 */
function defaultRunGit(args, { cwd, timeoutMs = 4000, extraEnv, input } = {}) {
  const bin = resolveGitBinary();
  if (!bin) {
    return { ok: false, stdout: "", code: null, error: "no git binary could be resolved" };
  }
  const res = spawnSync(bin, args, {
    cwd: cwd || process.cwd(),
    encoding: "utf8",
    timeout: timeoutMs,
    input,
    env: extraEnv ? { ...gitEnv(), ...extraEnv } : gitEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) {
    return { ok: false, stdout: "", code: null, error: res.error.message };
  }
  if (res.signal) {
    return {
      ok: false,
      stdout: res.stdout || "",
      code: null,
      error: `git ${args[0]} killed by ${res.signal} (timeout ${timeoutMs}ms)`,
    };
  }
  return {
    ok: res.status === 0,
    stdout: res.stdout || "",
    code: res.status,
    error: res.status === 0 ? null : (res.stderr || "").trim() || `exit ${res.status}`,
  };
}

// ── (1) command classification ──────────────────────────────────────────────

/**
 * Decide what a shell command is about to do to a branch's merge commits.
 *
 * Returns one of:
 *   { kind: "not-applicable" }              nothing here replays commits
 *   { kind: "unresolvable", why }           a git/pull/rebase invocation MIGHT be
 *                                           implicated but the shape cannot be
 *                                           read without evaluating shell
 *   { kind: "non-replay", flag }            `git rebase --abort` and friends
 *   { kind: "preserving", flag }            `--rebase-merges` / `--rebase=merges`
 *   { kind: "replaying", verb, dir,
 *     upstream, branch }                    the case this guard measures
 *
 * The dispatch is on the PARSED subcommand POSITION and on ARGV TOKENS from
 * `git-command-parse.js` — never a regex over the joined command string. That
 * is what `hook-output-discipline.md` MUST-5(a) requires before a finding may
 * carry `block`, and it is why `echo "git rebase main"` and
 * `git commit -m "revert the rebase"` are not invocations here.
 */
function classifyRebaseCommand(command) {
  const invocations = parseGitInvocations(String(command || ""));
  if (!invocations.length) return { kind: "not-applicable" };

  let sawUnresolvable = null;
  for (const g of invocations) {
    // A verb this parser could not resolve MIGHT be `rebase`. The acceptance
    // criteria put an unrecognised command shape on the fail-OPEN side, so the
    // caller passes through either way — the only question is whether the
    // operator hears about it.
    //
    // It is reported ONLY when a replay verb is lexically present somewhere in
    // the command. That gate is deliberately LEXICAL and is sound BECAUSE its
    // only consequence is whether a non-blocking advisory is emitted: it can
    // never cause a refusal, so `hook-output-discipline.md` MUST-2 is not in
    // play. Without it this branch would fire on EVERY substitution-headed git
    // command — `$(which git) status`, `sh -c "$CMD"` — and announce that "a
    // replaying invocation was seen" when no replay verb is anywhere in sight.
    // That is both noise on a hook that runs on every Bash call, and a
    // MISCHARACTERISATION of what fired, which is exactly the defect this
    // guard's own probe pair exists to catch.
    if (g.unresolvable === "subcommand" || g.unresolvable === "command") {
      if (mentionsReplayVerb(command)) {
        sawUnresolvable =
          sawUnresolvable ||
          "a replay verb (rebase / pull) appears in this command, but the subcommand cannot be read without evaluating shell, so it cannot be told apart from a non-replaying one";
      }
      continue;
    }
    if (g.unresolvable === "dir" && (g.sub === "rebase" || g.sub === "pull")) {
      sawUnresolvable =
        sawUnresolvable ||
        `git ${g.sub} names its working tree through a shell expansion, so the tree to measure cannot be resolved`;
      continue;
    }
    const argv = Array.isArray(g.argv) ? g.argv : [];

    if (g.sub === "rebase") {
      const control = argv.find((t) => NON_REPLAY_REBASE_MODES.has(t));
      if (control) return { kind: "non-replay", verb: "rebase", flag: control };
      const preserving = argv.find(
        (t) =>
          MERGE_PRESERVING_REBASE_FLAGS.has(t) ||
          t.startsWith("--rebase-merges="),
      );
      if (preserving)
        return { kind: "preserving", verb: "rebase", flag: preserving };
      if (namesAnotherGitDir(command)) {
        sawUnresolvable =
          sawUnresolvable ||
          "the command carries --git-dir, which relocates the repository whose refs would be replayed; the tree to measure cannot be resolved from the work-tree options alone";
        continue;
      }
      const { upstream, branch } = rebasePositionals(argv);
      return {
        kind: "replaying",
        verb: "rebase",
        dir: g.dir || null,
        upstream,
        branch,
      };
    }

    if (g.sub === "pull") {
      const disp = pullRebaseDisposition(argv);
      if (disp.kind === "none") continue;
      if (disp.kind === "preserving")
        return { kind: "preserving", verb: "pull", flag: disp.flag };
      if (namesAnotherGitDir(command)) {
        sawUnresolvable =
          sawUnresolvable ||
          "the command carries --git-dir, which relocates the repository whose refs would be replayed; the tree to measure cannot be resolved from the work-tree options alone";
        continue;
      }
      return {
        kind: "replaying",
        verb: "pull",
        dir: g.dir || null,
        upstream: null,
        branch: null,
        flag: disp.flag,
      };
    }
  }
  if (sawUnresolvable) return { kind: "unresolvable", why: sawUnresolvable };
  return { kind: "not-applicable" };
}

/** `<upstream>` and `<branch>` — the first two non-flag words after `rebase`. */
function rebasePositionals(argv) {
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--") {
      for (let j = i + 1; j < argv.length; j++) positional.push(argv[j]);
      break;
    }
    if (REBASE_VALUE_FLAGS.has(t)) {
      i++; // its value is the NEXT word, never a positional
      continue;
    }
    if (t.startsWith("-")) continue; // attached-value or boolean flag
    positional.push(t);
  }
  return { upstream: positional[0] || null, branch: positional[1] || null };
}

/**
 * Does this `git pull` rebase, and does it preserve merges while doing so?
 *
 * EXPLICIT argv forms only. The IMPLICIT form — a bare `git pull` under a
 * `pull.rebase=true` config — is a NAMED, DELIBERATE residual: reading it needs
 * a `git config` subprocess on every `git pull` in the session, and the config
 * is frequently a global default whose blast radius spans every repo on the
 * machine. It is stated here rather than left to be discovered.
 */
function pullRebaseDisposition(argv) {
  let found = { kind: "none" };
  for (const t of argv) {
    if (t === "--no-rebase") return { kind: "none" };
    if (t === "--rebase") found = { kind: "flattening", flag: t };
    else if (t.startsWith("--rebase=")) {
      const v = t.slice("--rebase=".length).toLowerCase();
      if (PULL_PRESERVING_REBASE_VALUES.has(v))
        found = { kind: "preserving", flag: t };
      else if (PULL_FLATTENING_REBASE_VALUES.has(v))
        found = { kind: "flattening", flag: t };
      else if (v === "false" || v === "no" || v === "0")
        return { kind: "none" };
      else found = { kind: "flattening", flag: t };
    }
  }
  return found;
}

// ── (1b) the structural measurement ─────────────────────────────────────────

/**
 * How many merge commits does the branch about to be replayed carry, relative
 * to the base it is being replayed onto?
 *
 * The answer is an INTEGER FROM `git rev-list --merges --count` — a git-object
 * fact, not a lexical match — which is what earns `block` under
 * `hook-output-discipline.md` MUST-2.
 *
 * Returns `{ resolved: false, why }` on EVERY unresolved condition: git
 * missing, a non-zero exit, a timeout, a detached HEAD, a base ref that does
 * not resolve to a commit, or output that is not an integer. A guard that
 * failed closed on ambiguity would be switched off by the first operator it
 * blocked wrongly, which restores the original bug.
 */
function countMergesToBeDropped({ cwd, upstream, branch, runGit = defaultRunGit, timeoutMs = 4000 }) {
  const git = (args) => runGit(args, { cwd, timeoutMs });

  const inTree = git(["rev-parse", "--is-inside-work-tree"]);
  if (!inTree.ok || inTree.stdout.trim() !== "true") {
    return { resolved: false, why: `not inside a git work tree (${inTree.error || inTree.stdout.trim() || "no answer"})` };
  }

  const tip = branch || "HEAD";
  if (!branch) {
    const head = git(["symbolic-ref", "--quiet", "HEAD"]);
    if (!head.ok || !head.stdout.trim()) {
      return { resolved: false, why: "HEAD is detached (or unreadable), so there is no branch identity to measure" };
    }
  }

  const base = resolveBase({ git, upstream });
  if (!base.resolved) return base;

  const count = git(["rev-list", "--merges", "--count", `${base.ref}..${tip}`]);
  if (!count.ok) {
    return { resolved: false, why: `git rev-list --merges --count ${base.ref}..${tip} failed: ${count.error}` };
  }
  const n = count.stdout.trim();
  if (!/^\d+$/.test(n)) {
    return { resolved: false, why: `git rev-list --merges --count returned a non-integer: ${JSON.stringify(n.slice(0, 60))}` };
  }
  return { resolved: true, count: Number(n), base: base.ref, baseSource: base.source, tip };
}

/**
 * The ref the replay is measured against: the explicit `<upstream>` argument
 * when one is given, otherwise the branch's configured upstream. Both are
 * confirmed to name a real commit before use — an unresolvable base is an
 * unresolved condition, not a reason to guess a default trunk name.
 */
function resolveBase({ git, upstream }) {
  const candidates = upstream
    ? [{ ref: upstream, source: "explicit <upstream> argument" }]
    : [{ ref: "@{upstream}", source: "the branch's configured upstream" }];
  for (const c of candidates) {
    const v = git(["rev-parse", "--verify", "--quiet", `${c.ref}^{commit}`]);
    if (v.ok && /^[0-9a-f]{7,64}$/.test(v.stdout.trim())) {
      return { resolved: true, ref: c.ref, source: c.source };
    }
  }
  return {
    resolved: false,
    why: upstream
      ? `the rebase base ${JSON.stringify(upstream)} does not resolve to a commit in this repo`
      : "no <upstream> argument was given and the branch has no configured upstream, so the base of the replay cannot be resolved",
  };
}

// ── (2) content verification ────────────────────────────────────────────────

const VERDICT = Object.freeze({
  ABSENT: "absent",
  PRESENT: "present",
  DIVERGED: "diverged",
  INDETERMINATE: "indeterminate",
  NO_CONTENT: "no-content",
});

/**
 * Every commit on `ref` whose CONTENT is absent from `headRef`.
 *
 * Returns `{ resolved, why, base, commits: [{ sha, subject, verdict }] }`.
 * `resolved: false` means the question was not answered — never that nothing
 * was lost. Callers MUST report UNKNOWN on it (`instrument-discipline.md`
 * MUST-1: a result consistent with both branches of the hypothesis carries no
 * information).
 */
function verifyContentPresence({
  cwd,
  ref,
  headRef = "HEAD",
  runGit = defaultRunGit,
  timeoutMs = 20000,
  scratchDir,
}) {
  const git = (args, extra) => runGit(args, { cwd, timeoutMs, ...extra });

  const refOk = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!refOk.ok || !refOk.stdout.trim()) {
    return { resolved: false, why: `pre-rebase ref ${JSON.stringify(ref)} does not resolve to a commit`, commits: [] };
  }
  const headOk = git(["rev-parse", "--verify", "--quiet", `${headRef}^{commit}`]);
  if (!headOk.ok || !headOk.stdout.trim()) {
    return { resolved: false, why: `target ref ${JSON.stringify(headRef)} does not resolve to a commit`, commits: [] };
  }

  const mb = git(["merge-base", ref, headRef]);
  if (!mb.ok || !mb.stdout.trim()) {
    return { resolved: false, why: `no merge base between ${ref} and ${headRef} (${mb.error || "empty output"}) — the candidate set cannot be bounded`, commits: [] };
  }
  const base = mb.stdout.trim();

  // Merge commits are excluded from the CANDIDATE set, not from the answer:
  // a merge carries no patch of its own, and every commit it brought in is
  // already reachable from `ref` and therefore already in this list.
  const list = git(["rev-list", "--no-merges", "--reverse", `${base}..${ref}`]);
  if (!list.ok) {
    return { resolved: false, why: `git rev-list ${base}..${ref} failed: ${list.error}`, commits: [] };
  }
  const shas = list.stdout.split("\n").map((s) => s.trim()).filter(Boolean);

  const dir = scratchDir || fs.mkdtempSync(path.join(os.tmpdir(), "rebase-verify-"));
  const ownScratch = !scratchDir;
  const indexFile = path.join(dir, "index");
  try {
    const seed = git(["read-tree", headOk.stdout.trim()], {
      extraEnv: { GIT_INDEX_FILE: indexFile },
    });
    if (!seed.ok) {
      return { resolved: false, why: `could not seed a temporary index from ${headRef}: ${seed.error}`, commits: [] };
    }
    const commits = [];
    for (const sha of shas) {
      const subjectRes = git(["log", "-1", "--format=%s", sha]);
      const subject = subjectRes.ok ? subjectRes.stdout.trim() : "<subject unreadable>";
      const patch = git(["diff-tree", "-p", "--binary", "--root", "--no-commit-id", sha]);
      if (!patch.ok) {
        commits.push({ sha, subject, verdict: VERDICT.INDETERMINATE, why: `patch could not be produced: ${patch.error}` });
        continue;
      }
      if (!patch.stdout.trim()) {
        commits.push({ sha, subject, verdict: VERDICT.NO_CONTENT });
        continue;
      }
      const applyEnv = { GIT_INDEX_FILE: indexFile };
      const fwd = git(["apply", "--cached", "--check", "-"], { extraEnv: applyEnv, input: patch.stdout });
      const rev = git(["apply", "--cached", "--check", "--reverse", "-"], { extraEnv: applyEnv, input: patch.stdout });
      let verdict;
      if (fwd.ok && !rev.ok) verdict = VERDICT.ABSENT;
      else if (!fwd.ok && rev.ok) verdict = VERDICT.PRESENT;
      else if (!fwd.ok && !rev.ok) verdict = VERDICT.DIVERGED;
      else verdict = VERDICT.INDETERMINATE;
      commits.push({ sha, subject, verdict });
    }
    return { resolved: true, why: null, base, ref, headRef, commits };
  } finally {
    if (ownScratch) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort: a leftover scratch dir is harmless and must never mask
        // the verdict the caller came for.
      }
    }
  }
}

module.exports = {
  NON_REPLAY_REBASE_MODES,
  MERGE_PRESERVING_REBASE_FLAGS,
  REBASE_VALUE_FLAGS,
  OVERRIDE_ENV,
  OVERRIDE_MIN_REASON_CHARS,
  VERDICT,
  readOverride,
  defaultRunGit,
  namesAnotherGitDir,
  mentionsReplayVerb,
  classifyRebaseCommand,
  rebasePositionals,
  pullRebaseDisposition,
  resolveBase,
  countMergesToBeDropped,
  verifyContentPresence,
};
