/**
 * stash-collision.js — the predicate behind `worktree-isolation.md` Rule 9's
 * Phase-2 tripwire: does THIS `git stash` invocation mutate the SHARED stash
 * stack, and does THIS repository carry more than one working tree?
 *
 * WHY A SHARED STACK IS THE HAZARD. The stash stack is a ref (`refs/stash`)
 * plus a reflog in the COMMON `.git` directory. The index and `HEAD` are
 * per-worktree; the stash stack is NOT. So in a repo carrying any
 * `git worktree add` checkout — this corpus's default execution mode — a
 * sibling's `git stash pop` applies YOUR entry into ITS tree and drops it. You
 * are left a merely-clean tree; the sibling is left a mutation neither
 * authored. BOTH sides fail silently, which is why attention does not catch it
 * and why Rule 9 booked a structural tripwire rather than more prose.
 *
 * WHY THIS IS A MODULE AND NOT A REGEX IN THE HOOK. Two reasons, both measured
 * elsewhere in this corpus. (1) `security.md` § Multi-Site Kwarg Plumbing: a
 * predicate spelled inline is a lineage, and lineages drift — the whole reason
 * `git-command-parse.js` exists. (2) A predicate reachable only through a hook's
 * stdin cannot be exercised at a KNOWN-ANSWER case without standing up the whole
 * harness, and `instrument-discipline.md` MUST-3(a) requires exactly that firing.
 * Exported, it is table-testable; the hook keeps only the wiring.
 *
 * FAIL-OPEN, DELIBERATELY (`cc-artifacts.md` Rule 7). Every probe here returns
 * `{ ok: false }` rather than throwing, and the caller's contract is that
 * `ok:false` means SILENT — not "fire anyway". The finding's entire
 * discriminating claim is "this repository has linked worktrees"; emitting it
 * without that measurement would assert something unmeasured, and a
 * non-blocking guard that speaks on unmeasured grounds is noise, which is how a
 * guard gets deleted by the first person it interrupts.
 *
 * Style: CommonJS, matching the rest of .claude/hooks/lib/. Pure functions
 * except the two probes, which spawn a read-only git. NEVER throws.
 */

"use strict";

const path = require("path");
const { dequote } = require(path.join(__dirname, "git-command-parse.js"));
const { resolveGitBinary, gitEnv } = require(
  path.join(__dirname, "git-subprocess-env.js"),
);

// Read-only stash subcommands. A guard that trips on INSPECTING the stack is
// noise and gets switched off by the first person it interrupts, so these are
// enumerated POSITIVELY and checked FIRST.
const READ_ONLY_SUBCOMMANDS = new Set(["list", "show"]);

// Subcommands that write the shared stack, the working tree, or both.
//
//   push / save        add an entry (save is the deprecated spelling)
//   pop / apply        write the entry INTO a working tree — `pop` also drops it
//   drop / clear       delete entries other worktrees may be relying on
//   store              add a pre-made commit to the stack
//   branch             apply an entry into a new branch AND drop it
const MUTATING_SUBCOMMANDS = new Set([
  "push",
  "save",
  "pop",
  "apply",
  "drop",
  "clear",
  "store",
  "branch",
]);

// `git stash create` is deliberately NOT in either set as a MUTATION. It writes
// a dangling commit object and prints its SHA; it touches neither `refs/stash`
// nor the working tree, so no sibling can observe it and no collision is
// possible. Treating it as mutating would be a false positive on the one
// subcommand that is the SAFE way to snapshot in a shared-.git repo.
const NON_MUTATING_SUBCOMMANDS = new Set(["create"]);

// Flags that CONSUME the following token. Without this the message body of
// `git stash push -m "list"` would be read as the subcommand `list`, and the
// guard would fall silent on a real push — a mutating form misread as a read.
const VALUE_FLAGS = new Set(["-m", "--message"]);

// Help forms produce usage text and exit; nothing is written.
const HELP_FLAGS = new Set(["-h", "--help"]);

/**
 * Classify the post-`stash` argument tokens.
 *
 * @param {string[]} argv tokens AFTER the `stash` subcommand, as
 *   `parseGitInvocation(...).argv` supplies them (quoting already consumed by
 *   the tokenizer, one token = one shell word).
 * @returns {{mutating: boolean, form: string, why: string}}
 *   `form` is the resolved stash subcommand (`push` for the bare/flags-only
 *   spelling), for the finding text and for the fixture answer key.
 */
function classifyStashArgs(argv) {
  const toks = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < toks.length; i++) {
    const t = dequote(String(toks[i] ?? "")).trim();
    if (t === "") continue;
    if (HELP_FLAGS.has(t)) {
      return {
        mutating: false,
        form: "help",
        why: "help output only — nothing is written",
      };
    }
    if (VALUE_FLAGS.has(t)) {
      i++; // consume the message body so it cannot occupy the verb slot
      continue;
    }
    if (t === "--") {
      // Everything after `--` is a pathspec, which is the `push` form.
      break;
    }
    if (t.startsWith("-")) {
      // `-u`, `-a`, `-k`, `-S`, `--include-untracked`, `--message=x`, … Fused
      // `--message=x` carries its value in the same token, so no consume.
      continue;
    }
    if (READ_ONLY_SUBCOMMANDS.has(t)) {
      return {
        mutating: false,
        form: t,
        why: "read-only — inspects the stack without writing it",
      };
    }
    if (NON_MUTATING_SUBCOMMANDS.has(t)) {
      return {
        mutating: false,
        form: t,
        why: "writes a dangling commit object only — neither refs/stash nor the working tree",
      };
    }
    if (MUTATING_SUBCOMMANDS.has(t)) {
      return {
        mutating: true,
        form: t,
        why: "writes the shared stash stack and/or a working tree",
      };
    }
    // An unrecognised bare token. git itself rejects most of these, but the one
    // thing it is NOT is a read: `list` and `show` are enumerated above and this
    // is neither. Ranking it mutating fails toward SPEAKING, which for a
    // non-blocking finding costs one advisory line; ranking it read-only would
    // fail toward silence on the hazard the guard exists for.
    return {
      mutating: true,
      form: t,
      why: "unrecognised stash subcommand — ranked mutating (fails toward speaking, never toward silence)",
    };
  }
  // No bare token at all: `git stash`, `git stash -u`, `git stash -- src/`.
  // git's own default is `git stash push`.
  return {
    mutating: true,
    form: "push",
    why: "bare `git stash` is `git stash push` — it adds an entry to the shared stack",
  };
}

/**
 * Pick the first invocation in a command that would MUTATE the shared stack.
 *
 * Takes ALREADY-PARSED invocations rather than a command string so the hook and
 * the fixture runner exercise ONE selection lineage. The hook feeds it the
 * segments it has already expanded (nested `sh -c` bodies included); the runner
 * feeds it `parseGitInvocations(command)`. Splitting this into "the hook's loop"
 * and "the runner's loop" is what would make a green fixture say nothing about
 * the shipped guard.
 *
 * @param {Array<object|null>} invocations
 * @returns {{form: string, why: string, dir: string|null}|null}
 */
function selectStashHazard(invocations) {
  for (const g of Array.isArray(invocations) ? invocations : []) {
    if (!g || g.sub !== "stash") continue;
    // An unresolvable `-C`/`--work-tree` value names a repository only the shell
    // can produce, so no probe could answer "does THAT repo have linked
    // worktrees?". Skipped rather than failed closed — see the hook's call site
    // for why this lane does not take the destructive-op fences' disposition.
    if (g.unresolvable === "dir") continue;
    const c = classifyStashArgs(g.argv);
    if (!c.mutating) continue;
    return { form: c.form, why: c.why, dir: g.dir || null };
  }
  return null;
}

/**
 * How many working trees does this repository have?
 *
 * `git worktree list --porcelain` emits one `worktree <path>` line per tree,
 * the main checkout first. Runs from ANY tree of the repo and reports the same
 * set, so the session cwd is a sufficient vantage point.
 *
 * @returns {{ok: boolean, count: number}} `ok:false` = not measured. The caller
 *   MUST treat that as silent, never as a hit.
 */
function countWorkingTrees(dir, cwd, spawn) {
  try {
    const spawnSync = spawn || require("child_process").spawnSync;
    const gitBin = resolveGitBinary();
    if (!gitBin) return { ok: false, count: 0 };
    const r = spawnSync(
      gitBin,
      ["-C", dir || cwd || ".", "worktree", "list", "--porcelain"],
      {
        // The SPAWN CWD, not just `-C`. A `-C` value may be RELATIVE
        // (`git -C . stash pop`, `git -C sub stash pop`), and git resolves it
        // against the process's own cwd — which for a hook is wherever the CLI
        // host happens to be, NOT the session's repo. Measured while writing
        // ARM 3 of this detector's fixtures: `git -C . stash pop` issued in a
        // ONE-worktree throwaway repo FIRED, because the probe answered about
        // the loom checkout the runner was launched from. Pinning the spawn cwd
        // to the session cwd makes the relative form resolve where the operator
        // meant it.
        cwd: cwd || undefined,
        encoding: "utf8",
        // Bounded well inside the hook's own 5000ms budget, and deliberately
        // below the 2500ms the destructive-op porcelain probe uses: this lane
        // is advisory, so a slow answer must cost the session nothing.
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
        env: gitEnv(),
      },
    );
    if (r.status !== 0 || typeof r.stdout !== "string") {
      return { ok: false, count: 0 };
    }
    const count = r.stdout
      .split("\n")
      .filter((l) => /^worktree /.test(l)).length;
    // Zero `worktree` lines from a zero-exit git is not a repo with no trees —
    // it is an output shape this parser does not understand. Report NOT
    // MEASURED rather than "one tree", which would read as a clean answer.
    if (count === 0) return { ok: false, count: 0 };
    return { ok: true, count };
  } catch {
    return { ok: false, count: 0 };
  }
}

/**
 * How many entries are on the shared stack right now?
 *
 * Reported as CONTEXT in the finding, never as part of the predicate: an EMPTY
 * stack is not safety. A `git stash push` onto an empty stack creates the very
 * entry a sibling can pop thirty seconds later, so gating the guard on depth
 * would go silent on exactly the near-miss shape that motivated it.
 *
 * @returns {{ok: boolean, depth: number}}
 */
function countStashEntries(dir, cwd, spawn) {
  try {
    const spawnSync = spawn || require("child_process").spawnSync;
    const gitBin = resolveGitBinary();
    if (!gitBin) return { ok: false, depth: 0 };
    const r = spawnSync(gitBin, ["-C", dir || cwd || ".", "stash", "list"], {
      // Same relative-`-C` resolution contract as countWorkingTrees above.
      cwd: cwd || undefined,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnv(),
    });
    if (r.status !== 0 || typeof r.stdout !== "string") {
      return { ok: false, depth: 0 };
    }
    return {
      ok: true,
      depth: r.stdout.split("\n").filter((l) => l.trim() !== "").length,
    };
  } catch {
    return { ok: false, depth: 0 };
  }
}

module.exports = {
  READ_ONLY_SUBCOMMANDS,
  MUTATING_SUBCOMMANDS,
  NON_MUTATING_SUBCOMMANDS,
  classifyStashArgs,
  selectStashHazard,
  countWorkingTrees,
  countStashEntries,
};
