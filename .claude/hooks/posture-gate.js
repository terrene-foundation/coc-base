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
 *   halt-and-report  The one branch whose signal is LEXICAL: the L2/L1
 *                    read-only Bash ALLOWLIST. It is deny-by-default over a
 *                    15-pattern list, so `rg`, `sed -n`, `awk`, `jq -r`,
 *                    `git worktree list` and every other safe-but-unlisted
 *                    read are non-matches. Promoting THAT to block would hard-
 *                    block arbitrary legitimate read-only work — precisely the
 *                    false-positive class MUST-2 exists to prevent. It stays an
 *                    annotation deliberately; see the Origin note in
 *                    hook-output-discipline.md MUST-2.
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
 * Mitigates cc-artifacts.md Rule 7 (timeout fallback).
 */

const TIMEOUT_MS = 5000;
const fallback = setTimeout(() => {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(1);
}, TIMEOUT_MS);

const path = require("path");
const fs = require("fs");
const { readPosture, isPendingWithinGrace } = require(
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
  parseGitInvocations,
  parseGhInvocations,
  UNRESOLVABLE_COMMAND_IDENTITY,
} = require(path.join(__dirname, "lib", "git-command-parse.js"));

/**
 * F14 LOW-3: best-effort realpath normalization for file_path before regex
 * matching. Mirrors journal-write-guard.js:142-167 — walk up to the
 * first existing ancestor (the file we're about to Edit may not exist
 * yet) so .claude/foo/../learning/posture.json resolves to
 * .claude/learning/posture.json. Without this, a literal regex against
 * the raw file_path misses the traversal and the secondary fence
 * silently passes.
 */
function _bestEffortRealpath(filePath) {
  if (typeof filePath !== "string" || !filePath) return filePath;
  // Walk up ancestors until one exists; realpath that and re-join the
  // remaining segments. This handles both "the file doesn't exist yet"
  // and "intermediate dirs don't exist."
  let p = filePath;
  const segments = [];
  // Cap iterations defensively to avoid pathological inputs.
  for (let i = 0; i < 64; i++) {
    if (!p || p === "/" || p === ".") break;
    try {
      const real = fs.realpathSync(p);
      // Re-join the popped segments in original order.
      return segments.length ? path.join(real, ...segments.reverse()) : real;
    } catch {
      // ancestor doesn't exist; pop one segment and retry.
      const base = path.basename(p);
      const parent = path.dirname(p);
      if (parent === p) break;
      segments.push(base);
      p = parent;
    }
  }
  // Could not resolve any ancestor; fall back to path.normalize so at
  // least "..foo/../learning" collapses textually.
  return path.normalize(filePath);
}

function passthrough() {
  clearTimeout(fallback);
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

// Read-only Bash commands permitted at L2 (the most restrictive working-tree posture)
const READ_ONLY_BASH = [
  /^\s*ls\b/,
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*git\s+(status|diff|log|show|branch|blame|reflog|rev-parse|merge-base|ls-files)\b/,
  /^\s*gh\s+(pr|issue|release|run)\s+(view|list|status)/,
  /^\s*node\s+--version\b/,
  /^\s*python3?\s+--version\b/,
  /^\s*which\s+/,
  /^\s*echo\s+/,
  /^\s*pwd\b/,
  /^\s*wc\b/,
  /^\s*jq\b/,
];

function isReadOnlyBash(cmd) {
  return READ_ONLY_BASH.some((p) => p.test(cmd));
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
    "-S",
    "--gpg-sign",
    "-u",
    "--untracked-files",
    "--pathspec-from-file",
  ]),
  push: new Set([
    "--repo",
    "--receive-pack",
    "--exec",
    "-o",
    "--push-option",
    "--force-with-lease",
    "--signed",
  ]),
};

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

function gateAtPosture(posture, tool, input) {
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
    if (tool === "Bash" && !isReadOnlyBash(cmd)) {
      // LEXICAL signal (a 15-pattern read-only ALLOWLIST). Stays halt-and-
      // report per MUST-2: every safe-but-unlisted read (`rg`, `sed -n`, `awk`,
      // `git worktree list`) is a non-match, so blocking here would hard-block
      // legitimate work. The consequential verbs are already BLOCKED above by
      // the structural fence, so this branch guards only the long tail.
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
    if (tool === "Bash" && !isReadOnlyBash(cmd)) {
      // LEXICAL allowlist — halt-and-report, same rationale as the L2 twin.
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

let input = "";
if (process.stdin.isTTY) {
  passthrough();
} else {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (input += c));
  process.stdin.on("end", () => {
    let data = {};
    try {
      data = JSON.parse(input);
    } catch {
      return passthrough();
    }
    const event = data.hook_event_name || data.hookEventName || "";

    if (event === "SessionStart") {
      try {
        const posture = readPosture(data.cwd);
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
          `[posture-gate] ${posture.posture} (${tag})` +
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
      if (isMutationTool(tool) && typeof mutationPath === "string") {
        const fp = _bestEffortRealpath(mutationPath);
        // The case-insensitivity dimension (and now #1409's redundant-separator
        // dimension) reaches this surface because the predicate is BUILT from
        // the one registry — not because someone remembered this file.
        if (isPostureGateProtectedPath(fp)) {
          clearTimeout(fallback);
          const out = instructAndWait({
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
          process.stdout.write(JSON.stringify(out.json) + "\n");
          process.exit(out.exitCode);
          return;
        }
      }

      try {
        const posture = readPosture(data.cwd);
        const gate = gateAtPosture(posture.posture, tool, toolInput);
        if (gate) {
          clearTimeout(fallback);
          // loom#1590: the severity is the BRANCH's, not a constant. This site
          // hardcoded "halt-and-report" and so overrode every branch — which is
          // why a file whose comment said "block" shipped as an annotation.
          const out = instructAndWait({
            hookEvent: "PreToolUse",
            severity: gate.severity || "halt-and-report",
            ...gate,
          });
          process.stdout.write(JSON.stringify(out.json) + "\n");
          process.exit(out.exitCode);
          return;
        }
      } catch {
        // posture read failed → passthrough; corrupt-state already handled
        // by readPosture's fail-closed-to-L1 default which would block
        // here — we explicitly choose passthrough to avoid double-failure.
      }
      return passthrough();
    }

    return passthrough();
  });
}
