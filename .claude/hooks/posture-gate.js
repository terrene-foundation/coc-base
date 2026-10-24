#!/usr/bin/env node
/**
 * Hook: posture-gate
 *
 * @coc-codex-edit-gate — STATELESS trust gate (posture-bound tool
 *   restriction); the policy extractor fans its CC edit-matcher
 *   registration out to the Codex `apply_patch` lane (mcp-guard,
 *   FF-AC6-1). At L5 it passes through; it bites only on a degraded
 *   posture, identically across CC / Codex-shell / Codex-apply_patch.
 *   Requires NO multi-operator coordination substrate — unlike the
 *   cc-only coordination guards (adjacency-leasecheck, journal-write-
 *   guard, integrity-guard), which deliberately omit this marker.
 *
 * @hook-event: SessionStart (lifecycle) — the subject is posture.json, durable
 *   state on disk before this session starts; the summary has to precede the
 *   first tool call to inform what the operator attempts.
 * @hook-event: PreToolUse:Bash (guard) — refuses ONE action (a non-read-only
 *   command / commit / push) at the boundary that would run it; Bash is the only
 *   tool that can run one, so the matcher names it rather than `*`.
 * @hook-event: PreToolUse:Edit|Write|NotebookEdit (guard) — same, for working-tree
 *   mutation: exactly the tools that can mutate (hook-event-selection.md MUST-3).
 *
 * Events:
 *   - SessionStart — emit stderr summary so user sees current posture
 *   - PreToolUse  — enforce posture-bound tool restrictions at L2/L3
 *
 * Posture allowances (per `rules/trust-posture.md` § Posture Ladder). "BLOCK"
 * below means exit-2 deny — the call does NOT run; "halt" means the call RAN
 * and the agent must surface it. The two are stated separately on purpose:
 *   L5_DELEGATED            full autonomy → passthrough always
 *   L4_CONTINUOUS_INSIGHT   full autonomy → passthrough (stricter at /redteam,
 *                           journal mandate; gate-level enforcement only)
 *   L3_SHARED_PLANNING      BLOCK the mutation verbs (git commit/push,
 *                           gh pr create|merge, gh release create);
 *                           Edit|Write permitted (the gate is per-shard plan
 *                           approval)
 *   L2_SUPERVISED           BLOCK all mutation tools + the L3 mutation verbs;
 *                           halt any other non-read-only Bash
 *   L1_PSEUDO_AGENT         BLOCK all working-tree mutations + the L3 verbs;
 *                           halt any other non-read-only Bash
 *
 * SEVERITY — split by SIGNAL TYPE, per `hook-output-discipline.md` MUST-2
 * ("block severity is for structural facts the agent cannot rationalize away";
 * lexical regex over a command string MUST NOT carry block). loom#1590:
 *
 *   block            The two branches whose signal is STRUCTURAL:
 *                    (a) the mutation-verb fence, dispatched on the parsed
 *                        SUBCOMMAND POSITION via lib/git-command-parse.js —
 *                        an AST-class signal, explicitly named admissible by
 *                        MUST-2, NOT a regex over the raw string;
 *                    (b) the mutation-TOOL fence, dispatched on `tool_name`
 *                        from the host payload — not a text match at all.
 *                    Both sit behind the same structural precondition: the
 *                    posture read from posture.json, a file the agent is
 *                    denied write access to by settings.json::permissions.deny.
 *
 *   halt-and-report  Unknown simple Bash commands retain the long-tail annotation.
 *                    Parsed dangerous forms deny at L1/L2; compounds are read-only
 *                    only when every component is admitted. The classifier is
 *                    .claude/hooks/lib/posture-read-only.js:200-256.
 *
 * Before loom#1590 EVERY branch here emitted halt-and-report while the comment
 * above said "block", so the file documented a fence and shipped an annotation:
 * an agent committed under it and the hook text arrived in the same tool result
 * as the successful exit. Genuine safety blocks (rm -rf, force-push to main,
 * secret leak) live in validate-bash-command.js / validate-deployment.js.
 *
 * R6-C-02 (shard C2): the primary enforcement of posture.json /
 * violations.jsonl write-deny is via settings.json::permissions.deny.
 * This hook MUST surface a clear halt-and-report payload as a
 * defense-in-depth fallback when a tool reaches PreToolUse with
 * Edit/Write target inside .claude/learning/ — settings.json is the
 * primary fence, the hook is the secondary.
 *
 * FAIL-CLOSED RUN (cc-artifacts.md Rule 7): the run is owned by
 * lib/guard-runner.js::runGuard — a throw, a hang past the budget, or an
 * unreadable payload REFUSES the call; this hook carries no timer of its own.
 */

/**
 * @hook-contract
 * {
 *   "side_effects": {
 *     "fs_writes": [
 *       ".coc-clone-init-witness",
 *       ".claude/learning/.coc-clone-init-witness"
 *     ],
 *     "network": false,
 *     "spawns": ["git"]
 *   },
 *   "idempotent": true,
 *   "may_rewrite_input": false,
 *   "notes": "This file itself writes only stdout/stderr. Its one fs capability is CONDITIONAL and delegated: lib/state-io.js::readPosture calls migrateWitnessIfPresent, which writes the F52 separate-location sentinel at <main checkout>/.coc-clone-init-witness and unlinks the legacy .claude/learning/.coc-clone-init-witness. That migration is documented idempotent (a no-op once the new location exists), which is why idempotent stays true: a repeat runs the same verdict and moves no state. spawns: the git rev-parse probes state-io uses to resolve the state dir and main checkout."
 * }
 */

// The out-of-engine run budget handed to runGuard (inside the dispatcher the row's own
// registered 20s is the bound). Raised 5000 -> 20000 (2026-10-08) with the registered
// budget (5s -> 20s): the two move together or the guard is cut mid-scan under load.
const TIMEOUT_MS = 20000;

const path = require("path");
const fs = require("fs");
const { runGuard } = require("./lib/guard-runner.js");
const isEngineExit = (() => {
  try {
    const classify = require("./lib/hook-engine.js").isEngineExit;
    if (typeof classify === "function") return classify;
  } catch {
    // Optional engine loader.
  }
  return () => false;
})();
const { readPosture, isPendingWithinGrace, enclosingCheckouts } = require(
  path.join(__dirname, "lib", "state-io.js"),
);
const { instructAndWait } = require(
  path.join(__dirname, "lib", "instruct-and-wait.js"),
);
const { isMutationTool } = require(
  path.join(__dirname, "lib", "tool-classes.js"),
);
// loom#1422 — this hook used to carry THREE inline protected-path regexes, the
// third of the four surfaces the case-insensitivity dimension had to be added
// to by hand. The predicate now lives in the shared registry; each row keeps
// its own anchor so the consolidation is behaviour-preserving.
const { isPostureGateProtectedPath } = require(
  path.join(__dirname, "lib", "guard-path-scope.js"),
);
// loom#1590 — THE shared structural command parser. The mutation-verb fence
// dispatches on the parsed subcommand POSITION rather than a regex over the raw
// string; that is what makes its signal structural enough to carry `block`
// under hook-output-discipline.md MUST-2. This hook's five inline regexes were
// the third lineage of the drift #1549 F3 extracted this module to end.
const {
  tokenize,
  parseGitInvocations,
  parseGhInvocations,
  resolveCdTrailDir,
  UNRESOLVABLE_COMMAND_IDENTITY,
} = require(path.join(__dirname, "lib", "git-command-parse.js"));
// HIGH-1(b): git's OWN target context (-C, --git-dir/--work-tree, the per-segment chdir trail).
// ZERO new modules: git-target-context.js was ALREADY loaded before this range, because
// git-command-parse.js requires it at its own line 39. What this site must still not do is pull
// the hook engine, and POSTURE-NO-ENGINE's loader census is the instrument for that.
const { resolveGitTargetContext } = require(
  path.join(__dirname, "lib", "git-target-context.js"),
);

/**
 * F14 LOW-3: best-effort realpath normalization for file_path before regex
 * matching. Mirrors journal-write-guard.js:142-167 — walk up to the
 * first existing ancestor (the file we're about to Edit may not exist
 * yet) so .claude/foo/../learning/posture.json resolves to
 * .claude/learning/posture.json. Without this, a literal regex against
 * the raw file_path misses the traversal and the secondary fence
 * silently passes.
 */
function _bestEffortRealpath(filePath, anchor) {
  if (typeof filePath !== "string" || !filePath) return null;
  // Walk up ancestors until one exists; realpath that and re-join the
  // remaining segments. This handles both "the file doesn't exist yet"
  // and "intermediate dirs don't exist."
  //
  // It climbs ONLY past a genuinely ABSENT component (realpath ENOENT and lstat sees nothing).
  // A component that EXISTS but will not resolve — a dangling link, EACCES, ELOOP — returns NULL,
  // which the caller treats as "cannot be shown to be outside the protected set" and surfaces.
  // It used to climb past any error, so a write through a DANGLING link aimed at a not-yet-created
  // protected file read as the link's own (unprotected) path (train-8 R2: the corr F1 class, found by the widened path-containment detector (A3d)).
  // Absolute only, and WITHOUT lexical normalisation: a ".." after an existing component is the
  // kernel's to resolve (after links), never folded first (train-8 R2 security N6). A RELATIVE path
  // resolves against the SESSION's cwd from the payload — never process.cwd(), which in the engine
  // worker is the host's, not the session's — and with no absolute anchor it is unresolved: null,
  // surfaced by the caller. The join is concatenation so a ".." reaches the kernel, not path.join.
  const anchored = path.isAbsolute(filePath) || (typeof anchor === "string" && path.isAbsolute(anchor));
  if (!anchored) return null;
  let p = path.isAbsolute(filePath) ? filePath : `${anchor}${path.sep}${filePath}`;
  const segments = [];
  // Cap iterations defensively to avoid pathological inputs.
  for (let i = 0; i < 64; i++) {
    if (!p || p === "/" || p === ".") break;
    try {
      const real = fs.realpathSync(p);
      // Re-join the popped segments in original order.
      return segments.length ? path.join(real, ...segments.reverse()) : real;
    } catch (e) {
      if (!e || e.code !== "ENOENT") return null;
      try {
        fs.lstatSync(p);
        return null; // it exists but will not resolve: never guess where it points
      } catch {
        /* genuinely absent: climb */
      }
      // ancestor doesn't exist; pop one segment and retry.
      const base = path.basename(p);
      if (base === "." || base === "..") return null; // never fold a dot segment lexically (N6)
      const parent = path.dirname(p);
      if (parent === p) break;
      if (base !== "") segments.push(base);
      p = parent;
    }
  }
  // Could not resolve any ancestor: NULL, never a lexical guess — the caller surfaces it.
  return null;
}

function passthrough() {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

const { classifyReadOnlyBash, literalCommandArgs } = require("./lib/posture-read-only.js");

function isWorkhorsePreflight(cmd, cwd, input) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return false;
  const args = literalCommandArgs(cmd);
  if (!args || args.length !== 6) return false;
  if (args[1].startsWith("-")) return false;
  if (!path.isAbsolute(args[1])) return false;
  if (args[1].split(path.sep).includes("..")) return false;
  if (args[0] !== "node" || args[2] !== "--installed-root" || args[4] !== "--worktree"
      || !path.isAbsolute(args[3]) || !path.isAbsolute(args[5])) return false;
  try {
    const expected = fs.realpathSync.native(path.join(__dirname, "../bin/codex-workhorse-target.mjs"));
    return fs.realpathSync.native(path.resolve(cwd, args[1])) === expected;
  } catch { return false; }
}

function isTrustedReadOnlyScript(cmd, cwd, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some(key => key !== "command" && key !== "cmd")) return false;
  if (isWorkhorsePreflight(cmd, cwd, input)) return true;
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return false;
  const args = literalCommandArgs(cmd);
  if (!args || args[0] !== "node" || !args[1] || args[1].startsWith("-")
      || args[1].split(path.sep).includes("..")) return false;
  try {
    const expected = fs.realpathSync.native(path.join(__dirname, "../bin/ws-next.mjs"));
    if (fs.realpathSync.native(path.resolve(cwd, args[1])) !== expected) return false;
  } catch { return false; }
  const seen = new Set();
  for (let i = 2; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) return false;
    seen.add(flag);
    if (flag === "--json") continue;
    if (flag !== "--workspace" && flag !== "--as-of") return false;
    const value = args[++i];
    if (!value || value.startsWith("-") || (flag === "--as-of" && !/^(0|[1-9][0-9]*)$/.test(value))) return false;
  }
  return true;
}

// ---- The mutation-verb fence (L3 and below) --------------------------------
//
// loom#1590. These five verbs used to be five flat regexes over the RAW command
// string. That is a LEXICAL signal, which `hook-output-discipline.md` MUST-2
// forbids from carrying `block` — so the fence could only ever annotate, which
// is exactly what it did. Dispatching on the parsed SUBCOMMAND POSITION instead
// makes the signal STRUCTURAL (the AST class MUST-2 names as admissible), which
// is what licenses the block below. It is not a severity flip; it is a change of
// signal that makes the severity legitimate.
//
// The regexes were also wrong in BOTH directions, measured against the parser
// on this repo (12-case control, /tmp harness, loom#1590):
//   FALSE NEGATIVE  `git -C /other/repo commit`  — the `\bgit\s+commit` form
//                   cannot see a `-C` retarget, so the documented cross-tree
//                   spelling walked straight through the fence.
//   FALSE POSITIVE  `echo "git commit -m x"`     — a string literal fired it.
//                   Observed live: a scratch-harness command whose HEREDOC BODY
//                   contained the verb was flagged mid-session while running to
//                   completion, reproducing the heredoc FP class named in
//                   hook-output-discipline.md's own Origin.
// The `(?![\w-])` lookahead the regex needed to keep `commit-tree` /
// `commit-graph` out (loom#1368) is likewise unnecessary here: an exact match
// on the parsed subcommand distinguishes them structurally, which is the
// rationale git-command-parse.js was extracted on in the first place.
const FENCED_GIT_SUBCOMMANDS = new Set(["commit", "push"]);
// gh's grammar is `<group> <subcommand>`; both positions are matched exactly.
const FENCED_GH_VERBS = new Set(["pr create", "pr merge", "release create"]);

// ---- Does the invocation actually MUTATE? -----------------------------------
//
// Identifying the SUBCOMMAND is necessary but NOT sufficient: `git commit
// --dry-run` and `git push --help` are the fenced verbs and mutate nothing.
// Blocking them is the same defect class as the one this fence fixes, merely
// inverted — and worse in practice, because a gate that refuses `--help` is a
// gate someone switches off. Measured before this clause landed: 8 such forms
// were denied at L3.
//
// Flags that CONSUME the next word. Load-bearing for correctness in the
// dangerous direction: without it, `git commit -m "fix the --dry-run bug"`
// reads its own MESSAGE as a dry-run flag and a real commit walks through. The
// separated form is the only one that consumes a following token; the attached
// form (`--message=x`) is a single token and needs no entry.
const VALUE_FLAGS = {
  commit: new Set([
    "-m",
    "--message",
    "-F",
    "--file",
    "-c",
    "--reedit-message",
    "-C",
    "--reuse-message",
    "--author",
    "--date",
    "--cleanup",
    "--fixup",
    "--squash",
    "-t",
    "--template",
    "--trailer",
    "--pathspec-from-file",
    // Added 2026-09-20 by the CLOSURE census below, not by the original probe.
    "--unified",
    "-U",
    "--inter-hunk-context",
  ]),
  push: new Set([
    "--repo",
    "--receive-pack",
    "--exec",
    "-o",
    "--push-option",
    // Same census. MEASURED CONSUMED: `git push --recurse-submodules --zzz`
    // reports "bad recurse-submodules argument", never "unknown option".
    "--recurse-submodules",
  ]),
};
// MEASURED, never copied. Six entries were removed from the sets above on
// 2026-09-20 — `commit -S`, `commit --gpg-sign`, `commit -u`,
// `commit --untracked-files`, `push --force-with-lease`, `push --signed`.
// Each takes an OPTIONAL value in the ATTACHED form only (`-Skeyid`,
// `--gpg-sign=keyid`, `--force-with-lease=main:abc`), which is a single token
// and so needs no entry here; written SEPARATED they consume NOTHING, and
// listing them made this walk skip the following word.
//
// The consequence was live and is reproduced by `.claude/audit-fixtures/
// posture-gate/run.mjs`: `git commit -S --dry-run` and the five siblings were
// BLOCKED at every degraded posture, because the skip swallowed the very
// `--dry-run` that proves the command mutates nothing. That is the inverted
// defect the header above calls "worse in practice, because a gate that
// refuses `--help` is a gate someone switches off".
//
// THAT IS THE MILDER HALF, AND AN EARLIER REVISION OF THIS COMMENT STOPPED
// THERE, calling the defect "an over-block, NOT a bypass, since isNonMutating
// fails closed". The second clause is true and the conclusion drawn from it was
// WRONG, so it is corrected here rather than softened: a wrong VALUE_FLAGS entry
// also opens a REAL BYPASS in this same hook, in the dangerous direction.
// `git commit -S -m "--dry-run"` made `-S` skip `-m`, which exposed the commit
// MESSAGE in a flag position, so `isNonMutating` returned TRUE and a genuine
// commit was ALLOWED at L3/L2/L1. Failing closed protects the walk from an
// UNKNOWN flag; it does not protect it from a KNOWN-WRONG one, because a wrong
// entry makes the walk skip a token it should have read. Pinned by
// `A-bypass/commit-S-m-dry-run-still-blocks` in the fixture runner.
//
// The direction flips in a fence of the OPPOSITE polarity. Copying this table
// into the `--no-verify` fence in validate-bash-command.js would make
// `git push --force-with-lease --no-verify origin main` go SILENT — a real
// bypass. That is why each entry below is probed rather than inherited:
//   git <sub> <flag> --zzz-not-a-flag
//   stderr carries "unknown option" ⇒ the flag did NOT consume it ⇒ BOOLEAN.
// Reading the literal token back is NOT a discriminator: it appears both when
// git rejects it as an option AND when git eats it as a value. Every entry
// remaining above returned CONSUMED under that probe, and all six removed ones
// returned BOOLEAN, on git 2.54.0 / 2.50.1 / 2.43.0 against seven controls
// (`-m`, `--file`, `--repo` value-taking; `--amend`, `--quiet`, `--all`,
// `--tags` boolean) that passed 7/7 on each version.
//
// THE PROBE ABOVE ANSWERS ONE DIRECTION ONLY, and the two directions are
// different propositions: it establishes "every LISTED entry is CONSUMED", and
// says NOTHING about "every CONSUMED flag is LISTED". A census run in the second
// direction on 2026-09-20 found FOUR consuming flags missing — `commit
// --unified`, `commit -U`, `commit --inter-hunk-context` (each "expects an
// integer value") and `push --recurse-submodules` ("bad recurse-submodules
// argument") — all four now added above. A missing entry is the OVER-BLOCK
// direction here (the walk reads a flag's VALUE as a flag), so none was
// exploitable, but `git push --recurse-submodules --dry-run origin main` was
// reaching the fence with `--dry-run` in a flag position.
//
// THE SET IS MEASURED, NOT PROVEN CLOSED, and the limit is the enumerator, not
// the probe. The census enumerates from `git <sub> -h`, which UNDER-REPORTS:
// its own control fired, showing `-h` omits `--message`, `--file`, `--author`
// and `--date` on commit and `--repo`, `--exec`, `--receive-pack` and
// `--push-option` on push. Those were folded back by hand, which means the
// census can only find flags someone already thought to control for —
// `--recurse-submodules` was missed by the census and caught by review. Treat
// this table as a LOWER BOUND on git's consuming flags. Re-run the census
// (both directions, with its control) when adopting a new git major.

// Markers meaning "this invocation does not mutate", PER SUBCOMMAND. The
// per-subcommand split is not decoration: `-n` is `--no-verify` on commit
// (which DOES commit, skipping hooks) and `--dry-run` on push. One shared list
// would either wave through `git commit -n` or block `git push -n`.
const NON_MUTATING_FLAGS = {
  commit: new Set(["--dry-run", "--help", "-h"]),
  push: new Set(["--dry-run", "-n", "--help", "-h"]),
};
const GH_NON_MUTATING_FLAGS = new Set(["--help", "-h"]);

/**
 * Walk argv, skipping words consumed as flag VALUES, and report whether a
 * genuine non-mutating flag appears in a real flag position.
 *
 * Fails CLOSED: anything not positively recognized as non-mutating is treated
 * as a mutation. An unknown value-flag can only cause this to MISS a
 * `--dry-run` (→ block, the safe error), never to invent one.
 */
function isNonMutating(argv, valueFlags, nonMutatingFlags) {
  if (!Array.isArray(argv)) return false;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (typeof t !== "string") continue;
    if (t === "--") break; // everything after is a pathspec, never a flag
    if (valueFlags && valueFlags.has(t)) {
      i++; // consume this flag's value so it is never read as a flag itself
      continue;
    }
    if (nonMutatingFlags.has(t)) return true;
  }
  return false;
}

/**
 * Does this command actually RUN one of the fenced mutation verbs? Returns a
 * human-readable verb name (for the halt payload) or null.
 *
 * Fails CLOSED on an unresolvable verb: when a substitution swallowed the verb
 * slot (`git $(f) …`), when the git token itself runs into an expansion
 * (`git$IFS commit`), or when a NESTED shell body exists whose content cannot be
 * known (`sh -c "$CMD"`), the parser says so explicitly rather than guessing, and
 * at a DEGRADED posture an unknown verb ranks as fenced. The remedy is stated in
 * the payload — spell the command literally — so the cost of the conservative
 * call is one edit, while the cost of guessing "probably benign" is the
 * unauthorized mutation this gate exists to stop.
 *
 * loom#1589 — the parser now also reaches inside command WRAPPERS (`eval`,
 * `sh -c`, `bash -c`, `xargs`, recursively) and reports a verb resolved next to
 * an opaque command name (`$(echo git) commit`). Both are handled by the SAME two
 * branches below, unchanged: the point of fixing this in the parser rather than
 * here is that a new evasion dimension is one edit there, not N across the hooks.
 *
 * `unresolvable: "command"` is deliberately NOT fenced — see
 * UNRESOLVABLE_COMMAND_IDENTITY for the measured reason (it marks every
 * `$VAR`-headed heredoc-body line, and fencing it would re-introduce the heredoc
 * false-positive class loom#1590 removed).
 */
function fencedMutationVerb(cmd) {
  for (const g of parseGitInvocations(cmd)) {
    if (g.sub && FENCED_GIT_SUBCOMMANDS.has(g.sub)) {
      // The subcommand is fenced — but only BLOCK if it actually mutates.
      if (
        isNonMutating(g.argv, VALUE_FLAGS[g.sub], NON_MUTATING_FLAGS[g.sub])
      ) {
        continue; // --dry-run / --help: inspect the next segment, do not block
      }
      return `git ${g.sub}`;
    }
    if (UNRESOLVABLE_COMMAND_IDENTITY.has(g.unresolvable)) {
      return "git <subcommand hidden by shell substitution>";
    }
  }
  for (const h of parseGhInvocations(cmd)) {
    if (h.group && h.sub && FENCED_GH_VERBS.has(`${h.group} ${h.sub}`)) {
      if (isNonMutating(h.argv, null, GH_NON_MUTATING_FLAGS)) continue;
      return `gh ${h.group} ${h.sub}`;
    }
    if (UNRESOLVABLE_COMMAND_IDENTITY.has(h.unresolvable)) {
      return "gh <subcommand hidden by shell substitution>";
    }
  }
  return null;
}

/**
 * The shared payload for the mutation-verb fence. Identical at L3/L2/L1 — the
 * fence is MONOTONIC by construction. Before loom#1590 it existed only on the
 * L3 branch, so at L2/L1 a commit fell through to the read-only-allowlist
 * branch and was merely ANNOTATED: the two STRICTER postures held the WEAKER
 * fence on the single most consequential action. Deriving all three from one
 * function is what stops that inversion recurring.
 */
function mutationVerbGate(posture, verb, cmd) {
  return {
    severity: "block",
    what_happened: `${verb} BLOCKED at ${posture}: ${cmd.slice(0, 80)}`,
    why: `trust-posture/${posture.split("_")[0]} — commits, pushes, PR creation and releases require explicit user instruction at this posture. The call did NOT run.`,
    agent_must_report: [
      `State the mutation that was blocked: ${verb}`,
      "State that the command did NOT execute — this is a deny, not a warning",
      "Ask the user to either run it themselves or raise the posture via /posture upgrade",
      "Do NOT retry, and do NOT reword the command to evade the gate",
    ],
    agent_must_wait:
      "The call was denied. Surface it and wait for the user; retrying or rewording is a gate-evasion attempt.",
    user_summary: `L3 blocked: ${cmd.slice(0, 60)}`,
  };
}

function gateAtPosture(posture, tool, input, cwd) {
  if (!["L1_PSEUDO_AGENT", "L2_SUPERVISED", "L3_SHARED_PLANNING",
    "L4_CONTINUOUS_INSIGHT", "L5_DELEGATED"].includes(posture)) {
    posture = "L1_PSEUDO_AGENT";
  }
  const cmd = (input.command || "").trim();
  // loom#1549 F4 (same class as the R6-C-02 fence below): NotebookEdit
  // carries `notebook_path`. The L1/L2 gates fire on isMutationTool(tool)
  // alone, so reading only `file_path` never defeated the GATE — but it
  // emitted an empty filename in every NotebookEdit halt message, which is
  // the diagnostic the operator is asked to act on.
  const filePath =
    input.file_path || input.filePath || input.notebook_path || "";

  // L5/L4: full passthrough (gate-level enforcement only at /redteam etc.)
  if (posture === "L5_DELEGATED" || posture === "L4_CONTINUOUS_INSIGHT") {
    return null;
  }

  // The mutation-verb fence applies at L3 AND BELOW — see mutationVerbGate for
  // why deriving all three from one call site is load-bearing.
  if (tool === "Bash") {
    const verb = fencedMutationVerb(cmd);
    if (verb) return mutationVerbGate(posture, verb, cmd);
  }

  // L3: mutation verbs are fenced above; Edit|Write are permitted here — the
  // L3 gate is per-shard PLAN approval, not per-edit approval.
  if (posture === "L3_SHARED_PLANNING") {
    return null;
  }

  const bash = tool === "Bash" ? classifyReadOnlyBash(cmd,
    segment => isTrustedReadOnlyScript(segment, cwd, input)) : null;
  if (bash?.state === "dangerous") {
    return {
      severity: "block",
      what_happened: `Bash BLOCKED at ${posture}: ${bash.reason}`,
      why: `trust-posture/read-only — parsed reason: ${bash.reason}. The call did NOT run.`,
      agent_must_report: [
        "State the parsed reason and the intended effect of the command",
        "Split the command into independently read-only calls, or ask the owner to raise posture through the sanctioned process",
      ],
      agent_must_wait: "Do not retry the dangerous form; use independently read-only commands or obtain the owner's posture decision.",
      user_summary: `Read-only Bash denied: ${bash.reason}`,
    };
  }

  // L2: block all mutation tools; block all non-read-only Bash
  // F14 LOW-2 (iter-1): include MultiEdit + NotebookEdit so the L2
  //   working-tree mutation fence does not silently pass on those tools.
  // F14 C2 iter-3 root-cause fix: route through isMutationTool() (SSOT
  //   from lib/tool-classes.js). Adding a new mutation tool requires
  //   ONE edit (the helper), not N edits across every hook.
  if (posture === "L2_SUPERVISED") {
    if (isMutationTool(tool)) {
      // STRUCTURAL signal: `tool_name` arrives from the host payload, so this
      // is not a text match at all and carries block cleanly under MUST-2.
      return {
        severity: "block",
        what_happened: `${tool} BLOCKED at L2_SUPERVISED: ${filePath.slice(0, 80)}`,
        why: "trust-posture/L2 — every Edit/Write requires user instruction in the immediate prior turn. The call did NOT run.",
        agent_must_report: [
          "State the file being modified and the change intent",
          "State that the edit did NOT execute — this is a deny, not a warning",
          "Propose the diff as a chat message for the user to approve",
        ],
        agent_must_wait:
          "The call was denied. Surface the proposed change and wait; do not retry.",
        user_summary: `L2 blocked: ${tool} ${filePath.split("/").pop()}`,
      };
    }
    if (tool === "Bash" && bash?.state !== "read-only") {
      // Unknown simple commands retain the long-tail annotation.
      return {
        severity: "halt-and-report",
        what_happened: `Mutating Bash RAN at L2_SUPERVISED: ${cmd.slice(0, 80)}`,
        why: "trust-posture/L2 — only read-only Bash is permitted; mutations require user instruction. This command was NOT recognized as read-only",
        agent_must_report: [
          "State the command and intended effect",
          "Quote the user's prior-turn instruction authorizing this command",
          "If the command was in fact read-only, say so — the allowlist is not exhaustive",
        ],
        agent_must_wait: "Wait for explicit user instruction.",
        user_summary: `L2 halted (command already ran): ${cmd.slice(0, 60)}`,
      };
    }
    return null;
  }

  // L1: block everything except read-only Bash
  // F14 LOW-2 (iter-1): include MultiEdit + NotebookEdit so the L1
  //   zero-mutation posture extends to all Anthropic-shipped edit tools.
  // F14 C2 iter-3 root-cause fix: route through isMutationTool() (SSOT).
  if (posture === "L1_PSEUDO_AGENT") {
    if (isMutationTool(tool)) {
      // STRUCTURAL (`tool_name`). L1 is documented as "zero working-tree
      // mutations" — a posture that cannot actually stop one is only a label.
      return {
        severity: "block",
        what_happened: `${tool} BLOCKED at L1_PSEUDO_AGENT: ${filePath.slice(0, 80)}`,
        why: "trust-posture/L1 — zero working-tree mutations; agent proposes only. The call did NOT run.",
        agent_must_report: [
          "Surface the proposed diff to the user as chat content",
          "State that the edit did NOT execute — this is a deny, not a warning",
          "Do NOT attempt the Edit/Write again",
        ],
        agent_must_wait:
          "L1 = propose only. The user runs commands; the agent advises.",
        user_summary: `L1 blocked: ${tool}`,
      };
    }
    if (tool === "Bash" && bash?.state !== "read-only") {
      // Unknown simple commands retain the long-tail annotation.
      return {
        severity: "halt-and-report",
        what_happened: `Bash RAN at L1_PSEUDO_AGENT: ${cmd.slice(0, 80)}`,
        why: "trust-posture/L1 — only read-only Bash permitted. This command was NOT recognized as read-only",
        agent_must_report: [
          "Surface the command for the user to run themselves",
          "If the command was in fact read-only, say so — the allowlist is not exhaustive",
        ],
        agent_must_wait: "L1 = advise only.",
        user_summary: `L1 halted (command already ran): ${cmd.slice(0, 60)}`,
      };
    }
    return null;
  }

  return null;
}

// ---- posture ANCHOR -------------------------------------------------------
// EVERY posture verdict is computed from the STRICTEST of the postures the call is
// anchored to. The session cwd is one anchor, never the privileged one: before this
// shard the sole PreToolUse source was `readPosture(data.cwd)`, so an agent that
// chose its own cwd (the Codex lane's pre-existing HIGH) chose its own posture.
//
// The ladder is LOCAL on purpose — POSTURE-NO-ENGINE counts loaders, and promoting
// a lib require here would change that count. Unknown values normalise to L1, the
// same normalisation gateAtPosture applies at its own entry.
const _POSTURE_LADDER = [
  "L1_PSEUDO_AGENT",
  "L2_SUPERVISED",
  "L3_SHARED_PLANNING",
  "L4_CONTINUOUS_INSIGHT",
  "L5_DELEGATED",
];
const _POSTURE_L1 = _POSTURE_LADDER[0];

function _postureRank(p) {
  const i = _POSTURE_LADDER.indexOf(p);
  return i === -1 ? 0 : i;
}
function _strictestPosture(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return _postureRank(a) <= _postureRank(b) ? a : b;
}

/**
 * The postures this event is ANCHORED to.
 *  - `data.cwd` MUST be a non-empty ABSOLUTE string; otherwise the anchor is L1 with
 *    NO read, because `readPosture(undefined)` falls back to `process.cwd()` inside
 *    state-resolver — the host's cwd, which is the read this anchor exists to remove.
 *  - In the Codex lane the SERVER stamps `CLAUDE_PROJECT_DIR` into the replayed
 *    hook's env and the agent cannot pass it, so it is an ADDITIONAL anchor
 *    (stricter-only, D1) — never the sole one.
 * Reads are READ-ONLY (`{migrate:false}`): the posture of a repo this session does
 * not own must not be nudged by having been consulted.
 */
function _postureAnchors(data) {
  const out = [];
  const cwd = data && data.cwd;
  if (typeof cwd === "string" && cwd && path.isAbsolute(cwd)) {
    // The session's OWN anchor: migrate is LEFT ON here (LOW-3). This is the directory the
    // session actually runs in, so the F52 witness migration is the same housekeeping every
    // other reader performs; only FOREIGN repos are read read-only.
    out.push(readPosture(cwd).posture);
  } else {
    out.push(_POSTURE_L1);
  }
  if (process.env.COC_RUNTIME === "codex") {
    const proj = process.env.CLAUDE_PROJECT_DIR;
    if (typeof proj === "string" && proj && path.isAbsolute(proj)) {
      out.push(readPosture(proj).posture);
    }
    // The SHELL tool's `workdir` is a third anchor the agent chooses, and it is the directory
    // the command actually runs in — so it can never be ignored. It is NOT the session's own
    // anchor (the agent picked it, possibly a foreign repo), so it is read READ-ONLY.
    const wd = data && data.tool_input && data.tool_input.workdir;
    if (typeof wd === "string" && wd) {
      // Item 3: the Codex workdir may be RELATIVE, resolved against the session cwd. One that
      // cannot be resolved at all is an unknown anchor, and an unknown anchor is L1.
      const absWd = path.isAbsolute(wd)
        ? wd
        : typeof cwd === "string" && path.isAbsolute(cwd)
          ? path.resolve(cwd, wd)
          : null;
      out.push(
        absWd ? readPosture(absWd, { migrate: false }).posture : _POSTURE_L1,
      );
    } else if (wd !== undefined) {
      out.push(_POSTURE_L1);
    }
  }
  return out;
}

/**
 * Every directory a BASH command is shown to act on (HIGH-1 / 1b). Two sources, both from the
 * EXISTING exported parse: the `cd`/`pushd` trail for ANY command (`resolveCdTrailDir`), and
 * git's own target context for each parsed invocation (`resolveGitTargetContext`, which carries
 * `-C`, --git-dir/--work-tree and the per-segment chdir trail).
 *
 * `unknown` is the DECLARED RESIDUAL for an ordinary command: it keeps the anchor-only verdict.
 * It is NOT a licence to pass a FENCED verb — `_effectivePosture` folds L1 when the command is
 * unknown AND carries one (HIGH-1) — and over `_MAX_TARGET_DIRS` distinct directories the arm
 * also contributes L1. The OS-sandbox lane is what closes the residual class itself; this
 * function must not pretend to.
 */
function cmdOf(data) {
  const c = data && data.tool_input && data.tool_input.command;
  return typeof c === "string" ? c : "";
}

// Item 4: the number of directories this arm will consult. Each one costs a git resolution and a
// posture read, and a command can name many; over the cap the arm contributes L1 rather than
// letting one call buy unbounded work on the fault path. Deduplicated so a repeated `cd` is free.
const _MAX_TARGET_DIRS = 8;

// Item 4 (R2 MED): ONE shared deadline across every read this arm performs. Each target
// directory costs a git resolution plus a posture read, and the readers carry no deadline of
// their own; without this bound a single call can buy work up to the row's 20 s hook budget,
// which runGuard answers as a timeout (a refusal for a deny row) — not a decision. Over the budget the arm contributes L1
// and stops: an arm that ran out of time cannot be shown to have judged the call. The value
// is the shipped hook budget (adapters.md: 2 s / 4 MiB input); the gate and the emission
// itself stay outside it.
const _MAX_TARGET_ARM_MS = 2000;

function _bashTargetDirs(data) {
  const cmd = data && data.tool_input && data.tool_input.command;
  const rawCwd = data && data.cwd;
  // Item 3: retargets are resolved against the WORKDIR when the lane supplies one — that is the
  // directory the command actually runs in — and only fall back to the payload cwd.
  const wd = data && data.tool_input && data.tool_input.workdir;
  const cwd =
    typeof wd === "string" && wd && typeof rawCwd === "string" && path.isAbsolute(rawCwd) && !path.isAbsolute(wd)
      ? path.resolve(rawCwd, wd)
      : typeof wd === "string" && wd && path.isAbsolute(wd)
        ? wd
        : rawCwd;
  if (typeof cmd !== "string" || !cmd) return { dirs: [], unknown: true };
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return { dirs: [], unknown: true };
  const dirs = [];
  let unknown = false;
  try {
    const cd = resolveCdTrailDir(cmd, cwd);
    if (cd && cd.known && typeof cd.dir === "string") dirs.push(cd.dir);
    else unknown = true;
  } catch {
    unknown = true;
  }
  // M-B: a gh segment acts on the repo ITS OWN trail points at, not on wherever the command
  // ENDS. `cd <L1> && gh pr merge … && cd <L5>` resolved its final dir to L5, so a mutation
  // in a locked repo was judged by the wrong location. `stopWhen` stops the trail AT the
  // acting segment; each fenced gh segment gets its own prefix dir. Only FENCED verbs are
  // consulted: a read-only gh commits no mutation for the anchor to judge, and folding an
  // unrelated gh read would widen this arm past its purpose.
  const _fencedGh = (h) => h && h.group && h.sub && FENCED_GH_VERBS.has(`${h.group} ${h.sub}`);
  let ghFenced = false;
  try {
    ghFenced = (parseGhInvocations(cmd) || []).some(_fencedGh);
  } catch {
    ghFenced = false;
  }
  if (ghFenced) {
    for (let k = 1; k <= _MAX_TARGET_DIRS; k++) {
      let seen = 0;
      let stopped = false;
      let trail = null;
      try {
        trail = resolveCdTrailDir(cmd, cwd, {
          stopWhen: (t) => {
            let fenced = false;
            try {
              fenced = (parseGhInvocations(t) || []).some(_fencedGh);
            } catch {
              fenced = false;
            }
            if (!fenced) return false;
            seen += 1;
            if (seen === k) {
              stopped = true;
              return true;
            }
            return false;
          },
        });
      } catch {
        unknown = true;
        break;
      }
      if (!stopped) break; // there is no Kth fenced gh segment
      if (trail && trail.known && typeof trail.dir === "string") dirs.push(trail.dir);
      else unknown = true;
    }
  }
  let parsed = [];
  try {
    parsed = parseGitInvocations(cmd) || [];
  } catch {
    return { dirs, unknown: true };
  }
  for (const g of parsed) {
    let r;
    try {
      r = resolveGitTargetContext(g, cwd);
    } catch {
      unknown = true;
      continue;
    }
    if (!r || !r.known) {
      unknown = true;
      // A DIR selector can be readable even when the whole context is not — `--git-dir` and
      // `--work-tree` name a repository outright, so they are folded BEFORE the known check.
      // Dropping them here let `GIT_DIR=<L1>/.git git commit` read as unknown-and-ignorable.
      for (const d of [r && r.workTree, r && r.gitDir]) {
        if (typeof d === "string" && path.isAbsolute(d)) dirs.push(d);
      }
      continue;
    }
    for (const d of [r.cwd, r.target, r.workTree, r.gitDir]) {
      if (typeof d === "string" && path.isAbsolute(d)) dirs.push(d);
    }
  }
  return { dirs, unknown };
}

function _nearestExistingDir(p) {
  let cur = p;
  for (;;) {
    try {
      if (fs.statSync(cur).isDirectory()) return cur;
    } catch {
      // not there — climb
    }
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

// Is this path inside ANY git checkout? A `.git` at or above it is the cheap,
// non-spawning answer. Used only to decide whether the target arm contributes at
// all (D2a): a scratch path under /tmp is judged on its ANCHORS, not forced to a
// posture by a repo it is not in. The authoritative posture still comes from git
// through readPosture, which fails closed to L1 when git cannot identify a main
// checkout for a path that IS in one (D2b, I4).
function _insideAnyCheckout(dir) {
  let cur = dir;
  for (;;) {
    try {
      fs.lstatSync(path.join(cur, ".git"));
      return true;
    } catch {
      // keep climbing
    }
    const up = path.dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
}

/**
 * The posture of the repo CONTAINING the resolved target path, or null when the
 * arm contributes nothing.
 *  - `resolvedFp === null` (an unresolvable component, ELOOP, EACCES, ENOTDIR, or a
 *    relative path with no absolute anchor) ⇒ L1 (I4).
 *  - Resolves OUTSIDE any checkout ⇒ null: contributes nothing (D2a).
 *  - Resolves INSIDE a checkout ⇒ that checkout's posture; git cannot identify the
 *    main checkout ⇒ readPosture already fails closed to L1 (D2b).
 */
function _targetPosture(resolvedFp, deadlineAt) {
  if (resolvedFp === null) return _POSTURE_L1;
  const dir = _nearestExistingDir(resolvedFp);
  if (!dir) return _POSTURE_L1;
  // EVERY enclosing checkout, not just the innermost (MED-1): a nested or submodule repo can
  // never loosen its parent's floor, so the strictest of the whole set is the target's posture.
  // The enumeration is state-io's `enclosingCheckouts`, which rides the EXISTING bounded git
  // resolution — no ad-hoc spawn per ancestor here (LOW-2).
  const enc = enclosingCheckouts(dir, { deadline: deadlineAt });
  if (!enc.ok) {
    // git could not answer. Inside a checkout ⇒ INDETERMINATE ⇒ fail closed (D2b); inside none
    // ⇒ contributes nothing (D2a), which is the only reading that keeps a scratch write legal.
    return _insideAnyCheckout(dir) ? _POSTURE_L1 : null;
  }
  if (enc.roots.length === 0) return null; // inside no checkout at all
  let p = null;
  for (const root of enc.roots) {
    p = _strictestPosture(p, readPosture(root, { migrate: false }).posture);
  }
  return p;
}

/** One posture decision for the whole event: strictest(anchors, target). */
function _effectivePosture(data, isMutation, resolvedFp) {
  const startedAt = Date.now();
  const deadlineAt = startedAt + _MAX_TARGET_ARM_MS;
  const spent = () => Date.now() - startedAt > _MAX_TARGET_ARM_MS;
  const anchors = spent() ? [_POSTURE_L1] : _postureAnchors(data);
  let p = null;
  for (const a of anchors) p = _strictestPosture(p, a);
  if (isMutation) {
    // Over the shared deadline the target arm contributes L1 WITHOUT reading.
    if (spent()) {
      p = _strictestPosture(p, _POSTURE_L1);
    } else {
      const tp = _targetPosture(resolvedFp, deadlineAt);
      if (tp !== null) p = _strictestPosture(p, tp);
    }
  }
  // HIGH-1(b): a Bash command is judged by the directories it is shown to RETARGET into, as well
  // as by its anchors. An unresolvable command contributes nothing here — the anchor-only verdict
  // is the declared residual.
  const bashTargets = _bashTargetDirs(data);
  // Item 4: dedupe, then CAP. Over the cap the retarget arm contributes L1 — a command that names
  // more directories than this will not have them silently ignored.
  const seenDirs = new Set();
  for (const d of bashTargets.dirs) seenDirs.add(d);
  if (seenDirs.size > _MAX_TARGET_DIRS) p = _strictestPosture(p, _POSTURE_L1);
  // R2 LOW: fold the DEDUPED set, not the raw list. One plain command yields the same
  // directory from three sources (the cd-trail base, r.cwd, r.target), and every fold costs
  // a git resolution plus a posture read. De-duplication is the memoization here: a set is
  // per-event, and a directory outside it is a different repo by definition.
  for (const d of seenDirs) {
    if (spent()) {
      // Out of budget: stop reading and fail closed (fold to L1) instead of deciding on a
      // partial read. There is no fallback path to spend — the row's hook budget is the
      // whole of it and runGuard answers a timeout as a refusal, not a decision.
      p = _strictestPosture(p, _POSTURE_L1);
      break;
    }
    const tp = _targetPosture(d, deadlineAt);
    if (tp !== null) p = _strictestPosture(p, tp);
  }
  if (spent()) p = _strictestPosture(p, _POSTURE_L1);
  // HIGH-1 (R2): an UNPARSEABLE retarget in front of a FENCED verb is not an ignorable residual.
  // The declared residual is that we cannot tell where an ordinary command acts; it is NOT a
  // licence to run `cd $X && git commit` at a permissive anchor when $X is unknowable. A fenced
  // verb plus an unknown retarget fails closed to L1.
  if (bashTargets.unknown && fencedMutationVerb(cmdOf(data))) {
    p = _strictestPosture(p, _POSTURE_L1);
  }
  return p === null ? _POSTURE_L1 : p;
}

// main — the decision over the PARSED payload. guard-runner.js reads and parses
// stdin (an empty, unparseable or non-object payload REFUSES there and never reaches
// here) and owns the budget, so this body carries no reader and no timer.
function main(data) {
  const event = data.hook_event_name || data.hookEventName || "";

  if (event === "SessionStart") {
    try {
      // The banner reports the SAME effective posture the gate will use, so the
      // number a session reads at start is the number it is governed by. An
      // unusable cwd skips the read entirely rather than falling back to the
      // host's cwd (I3).
      const cwdUsable =
        typeof data.cwd === "string" && data.cwd && path.isAbsolute(data.cwd);
      const posture = cwdUsable
        ? readPosture(data.cwd, { migrate: false })
        : { posture: _POSTURE_L1, pending_verification: [] };
      const effectivePosture = _effectivePosture(data, false, null);
      // loom#875 — count only entries still WITHIN grace; a grace-expired
      // entry must not inflate the "N pending verification(s)" diagnostic.
      const pvCount = (posture.pending_verification || []).filter(
        (e) => e && e.rule_id && isPendingWithinGrace(e),
      ).length;
      const tag = posture._fail_closed
        ? "FAIL-CLOSED"
        : posture._fresh
          ? "FRESH"
          : "OK";
      process.stderr.write(
        `[posture-gate] ${effectivePosture} (${tag})` +
          (pvCount ? ` — ${pvCount} pending verification(s)` : "") +
          "\n",
      );
    } catch (e) {
      process.stderr.write(`[posture-gate] read failed: ${e.message}\n`);
    }
    return passthrough();
  }

  if (event === "PreToolUse") {
    const tool = data.tool_name;
    const toolInput = data.tool_input || {};

    // ---- R6-C-02 defense-in-depth -----------------------------------
    // Primary fence: settings.json::permissions.deny blocks Edit/Write/
    // MultiEdit/NotebookEdit on .claude/learning/{posture.json,
    // violations.jsonl, .initialized}.
    // Secondary fence (this hook): if the deny rule somehow doesn't fire
    // (settings malformed / override / out-of-tree write), surface a
    // clear halt-and-report citing rules/trust-posture.md MUST NOT.
    //
    // F14 LOW-2: include MultiEdit + NotebookEdit. Anthropic added
    // these tools after the original Edit/Write fence shipped; without
    // coverage the secondary fence silently passes on those tools.
    // F14 LOW-3: realpath-normalize file_path BEFORE regex match so
    // path traversal (../) cannot bypass the literal-string regex.
    // F14 C2 iter-3 root-cause fix: route through isMutationTool() (SSOT
    // from lib/tool-classes.js) — adding a new mutation tool requires
    // one edit, not N edits across every hook.
    // loom#1549 F4: the tool-name half routed through the SSOT, but the
    // PAYLOAD half still read `file_path` ONLY. NotebookEdit carries
    // `notebook_path` (tool-classes.js says so in its own JSDoc), so the
    // conjunct was false and a NotebookEdit write to posture.json passed
    // through UNFENCED — the SSOT made the tool recognized and the payload
    // read made it unreachable. Six sibling hooks (signing-mutation-guard,
    // genesis-anchor-guard, journal-write-guard, adjacency-leasecheck,
    // detect-violations, settings-deny-edit-guard) already read all three
    // keys; this site and integrity-guard.js were the two that did not.
    const mutationPath =
      toolInput.file_path || toolInput.filePath || toolInput.notebook_path;
    // R6-C-02 BOTH arms DEFER to the posture gate now (posture anchor shard): the gate is
    // computed FIRST, so a BLOCK outranks this surface (I6) and the event emits exactly once
    // (I9). A PROTECTED path still SURFACES wherever the gate does not block — the cross-CLI
    // contract (codex-mcp-guard/test-server.mjs asserts the "surface" verdict on a non-first
    // target) is preserved from L3 up. An UNRESOLVABLE path (relative with no payload anchor,
    // dangling link, EACCES, ELOOP) is L1 through the target arm (I4), which blocks every
    // mutation tool, so it never reaches the surface either; returning here instead admitted
    // every relative-path Write at L1/L2 (POSTURE-ENGINE-EXIT / POSTURE-NO-ENGINE).
    const isMutation = isMutationTool(tool) && typeof mutationPath === "string";
    // null: a component exists but will not resolve, so the path cannot be shown to be
    // OUTSIDE the protected set — judged on its lexical form for the message only.
    const resolvedFp = isMutation
      ? _bestEffortRealpath(mutationPath, data.cwd)
      : null;
    const fp = !isMutation
      ? null
      : resolvedFp === null
        ? path.normalize(mutationPath)
        : resolvedFp;
    // The case-insensitivity dimension (and now #1409's redundant-separator
    // dimension) reaches this surface because the predicate is BUILT from
    // the one registry — not because someone remembered this file.
    const protectedPath = isMutation ? isPostureGateProtectedPath(fp) : false;
    // BOTH arms DEFER now (posture anchor shard): the gate is computed FIRST, so a
    // BLOCK outranks this surface (I6) and an event emits exactly once (I9). The
    // surface still fires wherever the gate does not block, which is why the Codex
    // fixture asserting "surface" at L5 stays green — the gate is null at L5.
    const defenseMatched = isMutation && (protectedPath || resolvedFp === null);
    let emitDefense = null;
    if (defenseMatched) {
        emitDefense = () => instructAndWait({
          escalate: "security",
          hookEvent: "PreToolUse",
          // loom#1590 — DELIBERATELY LEFT AT halt-and-report, and this is a
          // recommendation surfaced rather than a change made.
          //
          // The signal here IS structural (a realpath-normalized path against
          // the shared registry), so MUST-2 would permit `block`, and the
          // argument for it is real: this is the SECONDARY fence for
          // trust-state self-modification, existing precisely for the case
          // where the PRIMARY fence (settings.json::permissions.deny) is
          // malformed or overridden — and a secondary fence that only
          // annotates leaves exactly that case unfenced.
          //
          // It is NOT promoted here because promoting it measurably broke the
          // Codex lane, which forwards-and-SURFACES this branch by design:
          // codex-mcp-guard/test-server.mjs asserts "posture-gate's
          // learning-path fence MUST fire on the non-first target (surface)".
          // That is a deliberate cross-CLI contract, not a stale fixture, so
          // flipping it is a decision for the owner of that contract rather
          // than a side effect of this fence. The primary settings.json deny
          // remains a REAL block (verified: a write to posture.json returns a
          // tool error and does not execute), so the protection is not resting
          // on this branch alone.
          severity: "halt-and-report",
          // The uncanonicalizable WORDING that used to live here was dead: an unresolvable
          // path is L1 (I4), so the gate blocks it and this surface is never emitted for one.
          // The block's extra reporting row still names it (see the block emission below).
          what_happened: `Defense-in-depth: ${tool} attempted on protected state file ${fp.slice(-80)}`,
          why: "trust-posture/MUST-NOT — posture.json / violations.jsonl writes are reserved for hooks (R6-C-02). settings.json::permissions.deny is the primary fence; this hook is the secondary fence in case settings is malformed or overridden",
          agent_must_report: [
            `State the protected path attempted: ${fp}`,
            "Cite rules/trust-posture.md MUST NOT (state self-modification BLOCKED)",
            "Surface the user-visible reason: trust state is hook-owned, never tool-owned",
            "Do not retry the Edit/Write against this path",
          ],
          agent_must_wait:
            "The user must adjudicate. If the intent was legitimate (corrupt-state recovery), the user runs /posture override; do not bypass.",
          user_summary: `posture-gate R6-C-02 halted ${tool} on ${fp.split("/").pop()}`,
        });
    }

    // ---- ONE posture decision, THEN the ordered emission (I6, I9) -------------
    // block  >  R6-C-02 surface  >  non-block gate  >  passthrough.
    let gate = null;
    try {
      const effective = _effectivePosture(data, isMutation, resolvedFp);
      gate = gateAtPosture(effective, tool, toolInput, data.cwd);
    } catch (e) {
      if (isEngineExit(e)) throw e;
      const out = instructAndWait({
        escalate: "security",
        hookEvent: "PreToolUse",
        severity: "block",
        what_happened: "POSTURE_GATE_EVALUATION_FAILED: the posture gate could not evaluate this tool call",
        why: "POSTURE_GATE_EVALUATION_FAILED — posture reading or tool-policy evaluation threw; the call has no completed authorization decision",
        agent_must_report: [
          "Report POSTURE_GATE_EVALUATION_FAILED and state that the tool call was denied",
          "Resolve the posture evaluation failure before retrying the tool call",
          "Do not bypass the posture gate or treat the missing decision as permission",
        ],
        agent_must_wait: "The call was denied. Repair the evaluation failure before retrying.",
        user_summary: "POSTURE_GATE_EVALUATION_FAILED — tool call denied because posture evaluation failed",
      });
      process.stdout.write(JSON.stringify(out.json) + "\n");
      process.exit(out.exitCode);
      return;
    }
    if (gate && gate.severity === "block") {
      // A block OUTRANKS the R6-C-02 surface (I6). When the defense arm ALSO
      // matched, the block carries one extra reporting line naming what this call
      // targeted, so the adjudication sees both facts in the single message the
      // agent gets (I9: exactly one instructAndWait per event).
      const out = instructAndWait({
        hookEvent: "PreToolUse",
        severity: gate.severity,
        ...gate,
        escalate: "security",
        agent_must_report: [
          ...(defenseMatched
            ? [
                protectedPath
                  ? `State the protected path this call targeted: ${fp}`
                  : `State the uncanonicalizable path this call targeted: ${fp}`,
              ]
            : []),
          ...(gate.agent_must_report || []),
        ],
      });
      process.stdout.write(JSON.stringify(out.json) + "\n");
      process.exit(out.exitCode);
      return;
    }
    if (defenseMatched) {
      // The surface verdict its cross-CLI contract asserts
      // (codex-mcp-guard/test-server.mjs: posture-gate's learning-path fence fires on
      // the non-first target as "surface") — emitted wherever the gate does NOT block.
      const out = emitDefense();
      process.stdout.write(JSON.stringify(out.json) + "\n");
      process.exit(out.exitCode);
      return;
    }
    if (gate) {
      // loom#1590: the severity is the BRANCH's, not a constant. This site
      // hardcoded "halt-and-report" and so overrode every branch — which is
      // why a file whose comment said "block" shipped as an annotation.
      const out = instructAndWait({
        hookEvent: "PreToolUse",
        severity: gate.severity || "halt-and-report",
        ...gate,
        escalate: "security",
      });
      process.stdout.write(JSON.stringify(out.json) + "\n");
      process.exit(out.exitCode);
      return;
    }
    return passthrough();
  }

  return passthrough();
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). A require() has no side effects.
const hookMain = runGuard("posture-gate", main, { budgetMs: TIMEOUT_MS });

module.exports = { hookMain };

// CLI entry.
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1")
    require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else {
    // FW-TIER2 — a STANDALONE invocation is one hook event, so it opens the same
    // one-answer-per-question scope the dispatch worker opens. Without it every
    // asker in this process pays its own `git rev-parse --git-common-dir`.
    require("./lib/event-git.js").installStandaloneEventScope();
    hookMain();
  }
}
