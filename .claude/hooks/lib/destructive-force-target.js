/**
 * destructive-force-target.js — the ONE predicate answering
 * "this command FORCE-destroys a directory; what work is in THAT directory?"
 *
 * WHY THIS MODULE EXISTS (loom s60, Orchestration Integrity component 4).
 *
 * `validate-bash-command.js` already fences the two destructive working-tree ops
 * whose loss is irrecoverable — `git reset --hard` and `git clean -f[d]`. Both
 * were MEASURED closed, including the embedded forms (`bash -c "…"`, after
 * `&&`, `git -C <dir> …`). A third op was NOT fenced at all:
 *
 *     git worktree remove --force <path>
 *
 * `worktree-isolation.md` Rule 8 states this is BLOCKED, and states WHY in the
 * only terms that matter: a BARE `git worktree remove` REFUSES a dirty tree,
 * and that refusal IS the safety mechanism. `--force` exists precisely to
 * defeat it. There is no reflog for an unstaged modification and none for an
 * untracked-not-ignored file, so what `--force` removes is gone.
 *
 * MEASURED before this module existed, driving the shipped hook over a
 * synthetic sandbox carrying one modified tracked file and one untracked file:
 *
 *     git worktree remove --force <dirty-wt>              -> SILENT (exit 0)
 *     git worktree remove -f <dirty-wt>                   -> SILENT (exit 0)
 *     git status && git worktree remove --force <dirty>   -> SILENT (exit 0)
 *     bash -c "git worktree remove --force <dirty>"       -> SILENT (exit 0)
 *     git reset --hard HEAD          (same dirty tree)    -> BLOCK  (exit 2)
 *
 * The last row is the control: the hook CAN speak about that tree, so the
 * silence on the rows above is a real gap and not an inert instrument
 * (instrument-discipline.md MUST-3(a)).
 *
 * `rm -rf <path>` is the SAME hazard reached by a different verb — `git.md`
 * § "Destructive Working-Tree Ops" names it in the same breath as the other two
 * — and it measured SILENT for every non-root path. It is fenced HERE, through
 * THIS function, rather than in a second lineage, per `security.md`
 * § Enforcement-Surface Parity: a control promoted at one surface must be
 * learned by every independent surface through ONE shared function, or the
 * surfaces drift the next time one is hardened.
 *
 * TWO PROPERTIES THIS MODULE IS BUILT AROUND. Both are defects that were
 * MEASURED in this corpus before, not hypotheticals:
 *
 * (1) IT ASSESSES THE COMMAND'S TARGET, NEVER `HEAD` AND NEVER THE CWD.
 *     `git worktree remove --force <path>` destroys `<path>`; the session cwd
 *     and any `-C <dir>` name a DIFFERENT tree. The prior instance of getting
 *     this wrong swept `HEAD` while the command named another ref and returned
 *     18 bytes of silence while 11 unlanded artifacts were destroyed. The
 *     hook's existing `gitWorkingTreeStatus(g.dir, cwd)` is correct for
 *     `reset --hard`/`clean -f` — those DO act on `g.dir` — and would be
 *     exactly that defect if reused here, which is why this function takes the
 *     resolved OPERAND and nothing else.
 *
 * (2) IT SEPARATES EMPTY FROM DIRTY.
 *     A `--no-checkout` worktree has NO index, so `git status --porcelain`
 *     reports a STAGED DELETION for every path in HEAD. MEASURED on such a
 *     tree: `D  tracked.txt`, i.e. porcelain-non-empty. A predicate that reads
 *     porcelain-non-empty as "has work" therefore reports an EMPTY worktree as
 *     DIRTY — it cannot separate the two states, and a predicate that cannot
 *     separate them is not evidence (instrument-discipline.md MUST-1). The
 *     discriminator used here was measured on the same sandbox:
 *
 *       tree            porcelain            ls-files  HEAD tree
 *       wt-dirty        " M …" + "?? …"      1         1
 *       wt-clean        (empty)              1         1
 *       wt-nocheckout   "D  tracked.txt"     0         1
 *
 *     An EMPTY index against a NON-EMPTY HEAD is the no-checkout signature, and
 *     under it every `D `/`D` staged-deletion row is a phantom and is NOT
 *     counted as work. Genuinely untracked (`??`) rows in such a tree are still
 *     real and ARE counted.
 *
 * FAIL OPEN, LOUDLY. Anything this module cannot assess — an unresolvable path,
 * a shell substitution, a non-directory, a git that will not answer, a timeout —
 * returns `INDETERMINATE`. An indeterminate result is REPORTED as indeterminate
 * and never as clean, because "I could not look" and "I looked and it was
 * empty" are opposite meanings with identical-looking output
 * (evidence-first-claims.md MUST-3).
 *
 * Style: CommonJS, matching the rest of .claude/hooks/lib/. Pure-ish functions;
 * NEVER throws — every failure path returns a value so callers can use these as
 * predicates without try/catch boilerplate.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { resolveGitBinary, gitEnv } = require("./git-subprocess-env.js");
const {
  tokenize,
  stripRedirectionTokens,
  dequote,
  scanCommandPrefix,
} = require("./git-command-parse.js");

/**
 * Assessment states. `INDETERMINATE` is deliberately NOT a falsy/absent value:
 * it is a first-class verdict the caller must render, not a gap the caller can
 * accidentally read as "nothing found".
 */
const STATE = {
  DIRTY: "dirty",
  CLEAN: "clean",
  EMPTY: "empty",
  INDETERMINATE: "indeterminate",
};

// A token whose value depends on shell evaluation the hook MUST NOT perform
// (hook-output-discipline.md Rule 3 / security.md § no-eval). Not a security
// filter — a RESOLVABILITY test. Anything matching cannot be turned into a
// filesystem path without running the shell, so it ranks INDETERMINATE.
const SUBSTITUTION_RX = /[$`]|\$\(|\*|\?|\[/;

function isResolvableLiteral(tok) {
  if (typeof tok !== "string" || tok === "") return false;
  return !SUBSTITUTION_RX.test(tok);
}

/**
 * Does this parsed git invocation FORCE-remove a worktree, and which path?
 *
 * Consumes the shared `parseGitInvocation` result, so every wrapper form the
 * parser already normalises (`sudo`, `env`, `xargs`, `/usr/bin/git`, `\git`,
 * `bash -c "…"` via the caller's segment expansion, `git -C <dir> …`) is
 * covered here without a second lineage of that knowledge.
 *
 * FORCE spellings accepted, all measured against real git argv shapes:
 *   --force            long flag
 *   -f                 short flag
 *   -fq / -qf          BUNDLED short flags — git's own getopt accepts these,
 *                      so a guard matching only a bare `-f` is disarmed by one
 *                      extra character.
 *
 * `--force=…` is deliberately NOT treated as force: `git worktree remove` takes
 * no value for `--force`, so real git REJECTS that spelling and the command
 * destroys nothing. Matching it would be a false positive on a command that
 * cannot run.
 *
 * @param {{sub:string,argv:string[]}|null} g parseGitInvocation result
 * @returns {{target:string|null, force:boolean, unresolvableTarget:boolean}|null}
 */
function selectWorktreeRemoveForce(g) {
  if (!g || g.sub !== "worktree" || !Array.isArray(g.argv)) return null;
  const argv = g.argv.map((t) => String(t));
  // `remove` must be the worktree SUBcommand — the first non-flag word. This
  // keeps `git worktree list --porcelain` and `git worktree prune` out, and
  // keeps a path that merely happens to be spelled "remove" from promoting a
  // read-only invocation into a destructive one.
  const firstWord = argv.find((t) => !t.startsWith("-"));
  if (firstWord !== "remove") return null;

  let force = false;
  const operands = [];
  let sawTerminator = false;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "remove" && operands.length === 0 && !sawTerminator) continue;
    if (t === "--") {
      sawTerminator = true;
      continue;
    }
    if (!sawTerminator && t === "--force") {
      force = true;
      continue;
    }
    // Bundled short-flag group: `-f`, `-fq`, `-qf`. Explicitly NOT a match for
    // a long flag (`--foo`), which is why the second char is tested.
    if (!sawTerminator && /^-[A-Za-z]+$/.test(t)) {
      if (t.includes("f")) force = true;
      continue;
    }
    if (!sawTerminator && t.startsWith("-")) continue; // any other long flag
    operands.push(t);
  }
  const target = operands.length > 0 ? operands[0] : null;
  return {
    target,
    force,
    unresolvableTarget: target !== null && !isResolvableLiteral(target),
  };
}

/**
 * Does this shell segment invoke `rm` with BOTH recursive and force, and on
 * which paths?
 *
 * Scoped to recursive+force on purpose. `rm -f <file>` deletes one named file
 * the operator typed; `rm -rf <dir>` removes a TREE, which is the shape that
 * takes a whole worktree's unlanded work with it. Requiring both flags is what
 * keeps this fence off the everyday `rm -f /tmp/scratch` and on the op
 * `git.md` actually names ("`rm -rf` of untracked paths").
 *
 * @param {string} segment one shell segment
 * @returns {{targets:string[], unresolvable:boolean}|null}
 */
/** Basename equality, never substring: `/bin/rm` counts, `confirm` does not. */
const isRmToken = (v) => String(v).replace(/^.*\//, "") === "rm";

/**
 * A token that BEGINS with a complete `rm` word and runs straight into a shell
 * expansion: `rm$IFS`, `rm${IFS}-rf`. The mirror of
 * `git-command-parse.js::looksLikeFusedGitToken`, and positive evidence of rm
 * obtained without expanding anything. The negative lookahead rejects `rmdir`
 * and `rm-foo`, so only a token whose `rm` word ENDS at the expansion matches.
 */
const looksLikeFusedRmToken = (tok) =>
  !!tok &&
  tok.unexpandable === true &&
  /^\\?(?:[^\s]*\/)?rm(?![A-Za-z0-9_.-])/.test(tok.value);

function selectRmForce(segment) {
  if (typeof segment !== "string" || segment === "") return null;
  let toks;
  try {
    // Redirections are shell plumbing, never operands. Measured before this
    // routing: `rm -rf /tmp/scratch >/dev/null 2>&1` yielded targets
    // `["/tmp/scratch", ">/dev/null", "2>&1"]` — two phantom paths that resolve
    // to nothing and are then reported to the operator, which is the SAME defect
    // (an inflated target count on every redirected command) that the sibling
    // routing in `git-command-parse.js` was written to remove. Swept here in the
    // same change per `security.md` § Multi-Site Kwarg Plumbing: `tokenize` is
    // EXPORTED, so a call site outside that module is exactly the sibling left
    // on the unqualified signature.
    toks = stripRedirectionTokens(tokenize(segment));
  } catch {
    return null;
  }
  if (!Array.isArray(toks) || toks.length === 0) return null;

  // Find the command word via the SHARED prefix walk, never a private copy.
  //
  // This used to be a local `WRAPPERS` set of six. `GIT_WRAPPERS` carried
  // fourteen, and the two drifted the moment `xargs` was added there for
  // loom#1589 and not here — so `timeout rm -rf <path>` failed the literal
  // `!== "rm"` test below, `selectRmForce` returned null, and the fence went
  // SILENT on the exact catastrophic targets it exists to name. `nice`,
  // `ionice`, `setsid`, `stdbuf`, `chrt`, `taskset` and `xargs` were missing
  // too. That is `security.md` § Enforcement-Surface Parity: a control promoted
  // at one surface that an independent surface never learned. Consuming
  // `scanCommandPrefix` means the next wrapper added for the git path is
  // learned here in the same commit, with no second set to keep in step.
  //
  // The match predicate is still equality-on-basename, never substring, so
  // `confirm`, `perform` and `charm` do not match — the word-boundary hazard
  // the hook's own root-rm pattern documents.
  const scan = scanCommandPrefix(
    toks,
    (tok) => (!tok.unexpandable && isRmToken(tok.value)) || looksLikeFusedRmToken(tok),
  );

  let i;
  let unresolvable = false;
  if (scan.kind === "match") {
    i = scan.idx;
    // `rm$IFS-rf$IFS/path` is ONE token: the flags and the operand are fused
    // into the command word and never appear as tokens of their own. There is
    // nothing after it to parse, so reporting "no rm here" would be the silence
    // this fence exists to remove. Positive evidence of rm + an unreadable
    // operand list = INDETERMINATE, the same mark `rm -rf "$tmp"` already
    // carries.
    if (looksLikeFusedRmToken(toks[i])) return { targets: [], unresolvable: true };
  } else if (scan.unresolvedCommandSlot) {
    // The command NAME is produced by a construct this hook must not evaluate
    // (`$(echo rm) -rf /path`). Resume after that slot and keep parsing: the
    // `recursive && force` gate below is what keeps this from firing on every
    // substitution-named command, and an unknown command word means the operand
    // list cannot be trusted to be complete.
    i = scan.commandSlotIdx;
    unresolvable = true;
  } else {
    return null;
  }

  let recursive = false;
  let force = false;
  let sawTerminator = false;
  const targets = [];
  for (let j = i + 1; j < toks.length; j++) {
    const raw = String(toks[j].value);
    const unexpandable = toks[j].unexpandable === true;
    if (raw === "--") {
      sawTerminator = true;
      continue;
    }
    if (!sawTerminator && /^--[A-Za-z-]+$/.test(raw)) {
      if (raw === "--recursive") recursive = true;
      if (raw === "--force") force = true;
      continue;
    }
    if (!sawTerminator && /^-[A-Za-z]+$/.test(raw)) {
      if (/[rR]/.test(raw)) recursive = true;
      if (raw.includes("f")) force = true;
      continue;
    }
    // An operand. A substitution here means the DELETION TARGET is unknown,
    // which is the one thing this fence exists to name.
    if (unexpandable || !isResolvableLiteral(raw)) {
      unresolvable = true;
      continue;
    }
    targets.push(dequote(raw));
  }
  if (!recursive || !force) return null;
  // `echo <path> | xargs rm -rf` reaches here with an EMPTY operand list: the
  // target arrives on stdin, which is not in this segment at all. Empty targets
  // + no unresolvable mark would produce zero findings, i.e. silence on a live
  // recursive force-delete. Mark it INDETERMINATE instead.
  if (targets.length === 0) return { targets, unresolvable: true };
  return { targets, unresolvable };
}

/**
 * Resolve an operand to an absolute path WITHOUT evaluating shell.
 * Relative operands resolve against the segment's cwd, which is the session cwd
 * the hook was handed — never `process.cwd()`, which is the hook's own process
 * and is unrelated to the command's target.
 */
function resolveTargetPath(token, cwd) {
  if (!isResolvableLiteral(token)) return null;
  const t = dequote(String(token));
  if (t === "" || t.startsWith("~")) return null; // `~` needs shell expansion
  try {
    const abs = path.isAbsolute(t) ? t : path.resolve(cwd || ".", t);
    // realpath so a symlinked operand is assessed as the tree it ACTUALLY
    // names, not as the link (security.md § Path Containment). Falls back to
    // the lexical absolute form when the path does not exist — a non-existent
    // target destroys nothing and is reported as such.
    try {
      return fs.realpathSync(abs);
    } catch {
      return abs;
    }
  } catch {
    return null;
  }
}

/**
 * Run git and DISTINGUISH the two ways it can fail to answer, because they have
 * OPPOSITE meanings for this fence:
 *
 *   ran:true,  ok:false  — git executed and said NO (exit non-zero). For
 *                          `rev-parse --show-toplevel` that is a definite
 *                          answer: the path is NOT a git working tree.
 *   ran:false, ok:false  — git never produced a verdict (binary unresolvable,
 *                          spawn error, timeout, non-string stdout). NOTHING is
 *                          known.
 *
 * Collapsing these is the `evidence-first-claims.md` MUST-3 failure: "I could
 * not look" and "I looked and the answer was no" are indistinguishable in the
 * raw result yet opposite in meaning. The first cut of this module collapsed
 * them, and the MEASURED consequence was that `rm -rf /tmp/plain-dir` — an
 * ordinary non-repo directory with nothing git-tracked at stake — reported
 * INDETERMINATE and halted. A fence that halts on every build-directory
 * cleanup is noise, and noise is how a guard gets switched off.
 */
function runGit(args, timeout = 2500) {
  const gitBin = resolveGitBinary();
  if (!gitBin) return { ok: false, ran: false, stdout: "" };
  try {
    const { spawnSync } = require("child_process");
    const r = spawnSync(gitBin, args, {
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnv(),
    });
    // `error` is set for spawn failure AND for a timeout kill; `status` is null
    // when the child was signalled rather than exiting.
    if (r.error || r.status === null || typeof r.stdout !== "string") {
      return { ok: false, ran: false, stdout: "" };
    }
    if (r.status !== 0) return { ok: false, ran: true, stdout: "" };
    return { ok: true, ran: true, stdout: r.stdout };
  } catch {
    return { ok: false, ran: false, stdout: "" };
  }
}

/**
 * WHAT WOULD BE DESTROYED at this resolved path?
 *
 * @param {string|null} absPath resolved absolute path (the COMMAND'S TARGET)
 * @returns {{state:string, path:string|null, items:string[], detail:string}}
 *
 * Never throws. Every failure mode returns INDETERMINATE with a `detail` naming
 * WHICH failure it was, so the caller renders "could not assess, and here is
 * why" rather than a bare silence indistinguishable from a clean result.
 */
function assessTarget(absPath) {
  const none = (state, detail) => ({ state, path: absPath, items: [], detail });
  if (!absPath) {
    return none(
      STATE.INDETERMINATE,
      "the target path could not be resolved without evaluating shell",
    );
  }
  let st;
  try {
    st = fs.statSync(absPath);
  } catch {
    return none(
      STATE.EMPTY,
      "the target path does not exist on disk — nothing would be destroyed",
    );
  }
  if (!st.isDirectory()) {
    // A single FILE target. Tracked-vs-untracked still matters, but there is no
    // tree to enumerate; assess it via its containing directory below.
    const parent = path.dirname(absPath);
    const inside = runGit(["-C", parent, "status", "--porcelain", "--", absPath]);
    if (!inside.ok) {
      // Same ran-vs-answered split as the directory branch below: git saying
      // "not a repo" is a verdict (nothing git-tracked at stake → CLEAN); git
      // never answering is INDETERMINATE.
      if (inside.ran) {
        return none(
          STATE.CLEAN,
          "the file is not inside a git working tree — no unlanded work is at stake",
        );
      }
      return none(
        STATE.INDETERMINATE,
        "git could not be queried for the file's repository (binary unresolvable, spawn failure, or timeout)",
      );
    }
    const rows = inside.stdout.split("\n").filter(Boolean);
    if (rows.length === 0) return none(STATE.CLEAN, "the file is committed");
    return {
      state: STATE.DIRTY,
      path: absPath,
      items: rows,
      detail: "the file carries uncommitted or untracked content",
    };
  }

  // Is it inside a git working tree at all? The two failure modes are split
  // deliberately (see runGit): git ANSWERING "not a repo" is a definite verdict
  // and ranks CLEAN — a `rm -rf /tmp/scratch` outside any repo destroys no
  // git-tracked work, and silence there is correct, not a gap. git never
  // answering is INDETERMINATE, because nothing was learned.
  const top = runGit(["-C", absPath, "rev-parse", "--show-toplevel"]);
  if (!top.ok) {
    if (top.ran) {
      return none(
        STATE.CLEAN,
        "the target is not inside a git working tree — no git-tracked or untracked-but-unlanded work is at stake",
      );
    }
    return none(
      STATE.INDETERMINATE,
      "git could not be queried for the target (binary unresolvable, spawn failure, or timeout)",
    );
  }

  const porcelain = runGit([
    "-C",
    absPath,
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (!porcelain.ok) {
    return none(
      STATE.INDETERMINATE,
      "`git status --porcelain` did not answer for the target tree (timeout, or unreadable)",
    );
  }
  let rows = porcelain.stdout.split("\n").filter(Boolean);

  // EMPTY-vs-DIRTY separation. See the module header for the measured table.
  // An empty index against a non-empty HEAD is the `--no-checkout` signature;
  // under it the staged-deletion rows are phantoms of the missing index and are
  // NOT work. Both probes must SUCCEED to apply the correction — if either is
  // unreadable the tree's state is unknown and INDETERMINATE is the honest
  // verdict, not a silently-uncorrected DIRTY.
  const idx = runGit(["-C", absPath, "ls-files"]);
  const head = runGit(["-C", absPath, "ls-tree", "-r", "--name-only", "HEAD"]);
  if (idx.ok && head.ok) {
    const idxN = idx.stdout.split("\n").filter(Boolean).length;
    const headN = head.stdout.split("\n").filter(Boolean).length;
    if (idxN === 0 && headN > 0) {
      const real = rows.filter((r) => !/^D[ D]/.test(r));
      if (real.length === 0) {
        return none(
          STATE.EMPTY,
          `no checkout present (empty index against ${headN} path(s) in HEAD) — the ${rows.length} staged-deletion row(s) are artifacts of the missing index, not work`,
        );
      }
      rows = real;
    }
  } else if (rows.length > 0) {
    return none(
      STATE.INDETERMINATE,
      "the target tree reports changes, but the index/HEAD probes needed to tell an EMPTY no-checkout tree from a DIRTY one did not answer",
    );
  }

  if (rows.length === 0) {
    // A CLEAN WORKING TREE IS NOT A WORTHLESS ONE. Every probe above asks only
    // about UNCOMMITTED content, so a tree whose work was COMMITTED but never
    // pushed reported CLEAN and the call site's `state !== DIRTY` short-circuit
    // said nothing while the operator destroyed the only copy. Measured on a
    // live case: a worktree on a detached HEAD carrying 188 insertions, present
    // on no remote and on no branch, drew SILENCE.
    //
    // `--not --remotes` measures IRRECOVERABILITY, not unmergedness, and that
    // distinction is the whole point: a lane whose commits are pushed but not
    // yet merged reads 0 here (deleting it loses nothing — the commits live on
    // the remote), while a detached or never-pushed one reads > 0. Measured
    // both poles before this was written: 1 for the detached worktree, 0 for a
    // pushed branch, 0 for a synced main, and 0 for an unmerged-but-pushed
    // lane. Counting unmerged commits instead would fire on every open lane in
    // the forest, and noise is how a guard gets switched off.
    // GUARD THE PROBE'S OWN PRECONDITION. In a repo with NO remotes,
    // `--not --remotes` subtracts nothing, so it counts EVERY commit and
    // reports a pristine scratch repo as entirely unpushed. That answer is
    // identical whether or not any work is at risk, which makes it a
    // non-discriminating instrument (`instrument-discipline.md` MUST-1) and a
    // false-positive engine — measured: it fired on this suite's own clean
    // fixture worktree the first time it was written. Where there is no remote
    // there is no "unpushed" to speak of, so the question does not arise.
    const remotes = runGit(["-C", absPath, "remote"]);
    const hasRemote =
      remotes.ok && String(remotes.stdout).split("\n").filter(Boolean).length > 0;
    const unpushed = hasRemote
      ? runGit(["-C", absPath, "rev-list", "--count", "HEAD", "--not", "--remotes"])
      : { ok: false, ran: true, stdout: "", stderr: "" };
    if (!unpushed.ok && !unpushed.ran) {
      return none(
        STATE.INDETERMINATE,
        "the target tree is clean, but the unpushed-commit probe did not answer (spawn failure or timeout) — whether it holds work that exists nowhere else is UNKNOWN",
      );
    }
    // `!ok && ran` is git ANSWERING no — an unborn HEAD (fresh `git init`, no
    // commit yet). Nothing committed means nothing committed to lose, so that
    // falls through to CLEAN, the same ran-vs-answered split `runGit` documents.
    if (unpushed.ok) {
      const n = Number(String(unpushed.stdout).trim());
      if (Number.isFinite(n) && n > 0) {
        const listed = runGit([
          "-C",
          absPath,
          "log",
          "--oneline",
          "--max-count=12",
          "HEAD",
          "--not",
          "--remotes",
        ]);
        const items = listed.ok
          ? listed.stdout.split("\n").filter(Boolean)
          : [`${n} commit(s) — could not be listed`];
        return {
          state: STATE.DIRTY,
          path: absPath,
          items,
          detail: `has a CLEAN working tree but carries ${n} commit(s) that are on NO remote — destroying it destroys the only copy`,
        };
      }
    }
    return none(
      STATE.CLEAN,
      "the target tree has no uncommitted or untracked content, and every commit it carries is on a remote",
    );
  }
  return {
    state: STATE.DIRTY,
    path: absPath,
    items: rows,
    detail: `${rows.length} uncommitted or untracked path(s) would be destroyed with no reflog`,
  };
}

/**
 * ===========================================================================
 * PATH DANGER — the SECOND dimension, orthogonal to git content (loom s67).
 * ===========================================================================
 *
 * WHY THIS EXISTS. `assessTarget` above answers exactly ONE question:
 *
 *     "what unlanded GIT WORK is at this path?"
 *
 * The fence read its answer as though it answered a DIFFERENT question:
 *
 *     "is destroying this path safe?"
 *
 * Those are not the same question, and `instrument-discipline.md` MUST-4 is
 * explicit that soundness for A carries NO information about B. MEASURED on
 * this machine before this function existed, with both poles controlled:
 *
 *     assessTarget("/")                        -> clean   items=0
 *     assessTarget("/usr")                     -> clean   items=0
 *     assessTarget("/Users/<operator>")        -> clean   items=0   (HOME)
 *     assessTarget("/Users/<operator>/repos")  -> clean   items=0   (every repo)
 *     assessTarget("/private/var/folders")     -> clean   items=0   (TMPDIR root)
 *     assessTarget("<a dirty worktree>")       -> dirty   items=4   <- control
 *     assessTarget("<the dirty main repo>")    -> dirty   items=95  <- control
 *
 * The two controls fire, so the instrument DOES discriminate and those `clean`
 * verdicts are real answers, not an inert probe. The call site's fail-open was
 * one line — `if (a.state !== DIRTY) continue;` — so `clean` meant SILENCE.
 *
 * The consequence is an INVERTED danger model: the more catastrophic the
 * target, the cleaner it reads, because catastrophic targets are precisely the
 * ones that contain no git repository. `rm -rf /` was the safest command you
 * could hand this fence.
 *
 * ORIGIN, recorded rather than sanitised: an agent in session s67 ran
 * `rm -rf /private/var/folders` — the system per-user temp ROOT — intending to
 * clean one `mktemp -d` scratch directory. It ran for a full 2-minute timeout
 * before SIGTERM. This fence said nothing. The INDETERMINATE arm had fired
 * correctly on the preceding `rm -rf "$tmp"` and told the agent to "re-issue
 * with the path written literally"; the agent complied, and the literal form
 * was the catastrophic one. A fence whose remediation advice routes an
 * operator from a SAFE-but-unassessable form into an UNSAFE-but-assessable one
 * is worse than no fence, which is why this dimension is added HERE, in the
 * one shared module, rather than as a second lineage (`security.md`
 * § Enforcement-Surface Parity — `git worktree remove --force` learns it in
 * the same call).
 *
 * WHY ANCESTRY AND NOT A DENYLIST. A denylist of scary paths cannot enumerate
 * a filesystem, the same way `#1966`'s positive allowlist could not enumerate
 * a shell (13 fail-open holes, measured). Every CRITICAL rule below is an
 * ANCESTRY or DEPTH fact about resolved absolute paths — structural, decidable
 * without evaluating shell, and true on a machine whose layout nobody
 * anticipated. The one literal set (`SYSTEM_DIRS`) is a belt-and-braces
 * addition on top of the depth rule that already covers it, never the primary
 * mechanism.
 *
 * THIS IS A STRUCTURAL SIGNAL, SO `block` IS PERMITTED.
 * `hook-output-discipline.md` MUST-2 bars `block` on a LEXICAL signal and
 * nothing more. Nothing here matches prose: every input is a realpath-resolved
 * absolute path compared by ancestry against other realpath-resolved absolute
 * paths (`os.homedir()`, the session cwd, `os.tmpdir()`). That is the same
 * class of evidence as the existing dirty-tree `git status` read.
 */

const os = require("os");

const DANGER = {
  CRITICAL: "critical",
  ELEVATED: "elevated",
  ORDINARY: "ordinary",
  INDETERMINATE: "indeterminate",
};

// Belt-and-braces only. The depth rule below already covers every one of
// these; they are named so a reader can see the intent without deriving it,
// and so an unusual mount layout that defeats the depth rule still trips here.
const SYSTEM_DIRS = new Set([
  "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib64", "/opt", "/proc",
  "/root", "/sbin", "/srv", "/sys", "/usr", "/var", "/Applications",
  "/Library", "/System", "/Users", "/Volumes", "/private", "/net", "/cores",
]);

/** realpath if possible, else the lexical absolute form. Never throws. */
function canon(p) {
  if (typeof p !== "string" || p === "") return null;
  try {
    const abs = path.isAbsolute(p) ? p : path.resolve(p);
    try {
      return fs.realpathSync(abs);
    } catch {
      return abs;
    }
  } catch {
    return null;
  }
}

/**
 * Is `ancestor` the same directory as `descendant`, or above it?
 *
 * Uses path.relative rather than string prefixes, so a sibling directory whose
 * name merely extends the root's name (`root-backup` beside `root`) is NOT read
 * as inside the root — the prefix bug that would make this
 * both over- and under-block. Both sides must already be canonical.
 */
function isAncestorOrSame(ancestor, descendant) {
  if (!ancestor || !descendant) return false;
  if (ancestor === descendant) return true;
  const rel = path.relative(ancestor, descendant);
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  return !path.isAbsolute(rel);
}

/** Depth below the filesystem root: "/" -> 0, "/usr" -> 1, "/usr/local" -> 2. */
function rootDepth(abs) {
  const parts = String(abs).split(path.sep).filter(Boolean);
  return parts.length;
}

/**
 * The scratch roots a session may legitimately create and destroy trees under.
 * Being STRICTLY INSIDE one of these is ordinary; BEING one, or being an
 * ancestor of one, is catastrophic — that distinction is the whole difference
 * between the `mktemp -d` directory the s67 agent meant to remove and the
 * `/private/var/folders` it actually typed.
 */
function scratchRoots() {
  const out = [];
  for (const c of [
    (() => { try { return os.tmpdir(); } catch { return null; } })(),
    "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp",
  ]) {
    const r = canon(c);
    if (r) out.push(r);
  }
  return out;
}

/**
 * How dangerous is DESTROYING this path, independent of what git knows?
 *
 * @param {string|null} absPath resolved absolute target (the COMMAND'S TARGET)
 * @param {{cwd?:string}} [opts] session cwd, used for the ancestor-of-cwd rule
 * @returns {{tier:string, reason:string|null}}
 *
 * FAIL-CLOSED BY CONSTRUCTION. A path is only ORDINARY when it is PROVABLY
 * inside a scratch root or inside the session's own working tree. Everything
 * else lands at ELEVATED or above, so a case this function did not anticipate
 * degrades toward reporting rather than toward silence. Never throws.
 */
function classifyPathDanger(absPath, opts) {
  const abs = canon(absPath);
  if (!abs) {
    return {
      tier: DANGER.INDETERMINATE,
      reason: "the target path could not be resolved without evaluating shell",
    };
  }

  const home = canon((() => { try { return os.homedir(); } catch { return null; } })());
  const cwd = canon((opts && opts.cwd) || null);
  const scratch = scratchRoots();

  // ---- CRITICAL ---------------------------------------------------------
  if (abs === path.parse(abs).root) {
    return { tier: DANGER.CRITICAL, reason: "it is the filesystem root" };
  }
  if (home && abs === home) {
    return { tier: DANGER.CRITICAL, reason: "it is the operator's HOME directory" };
  }
  if (home && isAncestorOrSame(abs, home)) {
    return { tier: DANGER.CRITICAL, reason: `it CONTAINS the operator's HOME directory (${home})` };
  }
  if (cwd && isAncestorOrSame(abs, cwd)) {
    return {
      tier: DANGER.CRITICAL,
      reason: `it CONTAINS the directory this session is working in (${cwd}) — every repository and worktree beneath it goes with it`,
    };
  }
  for (const s of scratch) {
    if (isAncestorOrSame(abs, s)) {
      return {
        tier: DANGER.CRITICAL,
        reason: `it IS, or CONTAINS, the system scratch root ${s} — every process on this machine keeps live state there`,
      };
    }
  }
  if (SYSTEM_DIRS.has(abs)) {
    return { tier: DANGER.CRITICAL, reason: "it is a system directory" };
  }
  // The shallow-path rule, with ONE exemption. A target 1-2 levels below `/`
  // is normally catastrophic, but a machine whose repos live at `/work/repo`
  // (or any shallow mount) would have a legitimate whole-repo delete BLOCKED
  // with no escape hatch — and a block with no escape hatch is how a guard
  // gets switched off, the failure mode this module's header names. So a
  // shallow path that IS inside a git repository DE-ESCALATES to ELEVATED
  // (halt-and-report: the operator is told and may proceed) rather than
  // CRITICAL. Deliberately NOT to ORDINARY — deleting a whole repo is still a
  // hazard worth naming, it is just not one to refuse outright.
  //
  // Every rule ABOVE this point is unaffected: HOME, an ancestor of HOME, an
  // ancestor of the session cwd, a scratch root or its ancestor, and a named
  // system directory stay CRITICAL at ANY depth, repo or not.
  const shallow = rootDepth(abs) <= 2 && !scratch.some((s) => isAncestorOrSame(s, abs));
  const inRepo = (() => {
    const top = runGit(["-C", abs, "rev-parse", "--show-toplevel"]);
    return top.ok && String(top.stdout).trim() !== "";
  })();

  if (shallow && !inRepo) {
    return {
      tier: DANGER.CRITICAL,
      reason: `it sits ${rootDepth(abs)} level(s) below the filesystem root, is not inside any scratch root, and is not inside a git repository`,
    };
  }
  if (shallow && inRepo) {
    return {
      tier: DANGER.ELEVATED,
      reason: `it sits ${rootDepth(abs)} level(s) below the filesystem root — shallow enough to be a whole repository rather than a subdirectory of one`,
    };
  }

  // ---- ORDINARY (must be PROVEN, never assumed) -------------------------
  for (const s of scratch) {
    if (isAncestorOrSame(s, abs)) return { tier: DANGER.ORDINARY, reason: null };
  }
  if (cwd && isAncestorOrSame(cwd, abs)) return { tier: DANGER.ORDINARY, reason: null };

  // A tree inside SOME git repository is ordinary for this dimension; the
  // git-content dimension (`assessTarget`) is what speaks about it.
  if (inRepo) {
    return { tier: DANGER.ORDINARY, reason: null };
  }

  // ---- ELEVATED (the fail-closed default) -------------------------------
  return {
    tier: DANGER.ELEVATED,
    reason:
      "it is outside this session's working tree, outside every scratch root, and not inside any git repository",
  };
}

module.exports = {
  STATE,
  DANGER,
  isResolvableLiteral,
  selectWorktreeRemoveForce,
  selectRmForce,
  resolveTargetPath,
  assessTarget,
  classifyPathDanger,
  // exported for the test suite's ancestry/depth poles
  isAncestorOrSame,
};
