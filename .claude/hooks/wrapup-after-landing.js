#!/usr/bin/env node
/**
 * @hook-event: PostToolUse:Bash (guard) — the completed merge command is available to trigger a wrapup reminder; the agent still judges notes freshness.
 *
 * wrapup-after-landing.js — PostToolUse(Bash) backstop for the wrapup-on-landing
 * discipline (co-owner-directed, 2026-06-19).
 *
 * Problem it solves: `.session-notes` (the next session's entry point) is written
 * by the `/wrapup` contract, which is a SEPARATE manual step the operator has to
 * remember AFTER a commit/release. This hook removes the "remember to type it"
 * friction by firing on the precise landing signal — `gh pr merge` (a wave/
 * release just landed) — and nudging the agent to refresh `.session-notes` in
 * the SAME flow, so the wrapup happens at the same time as the landing.
 *
 * Why this trigger (not a Stop hook): the Stop event fires on EVERY turn, so an
 * instruction there would nag after every post-commit turn. `gh pr merge` is the
 * infrequent, unambiguous "a PR landed" event — the precise moment the operator
 * means by "after a commit or release".
 *
 * Why advisory (not block): per `hook-output-discipline.md` MUST-2 a lexical
 * command-string match MUST NOT carry `block`; and the freshness judgment (does
 * `.session-notes` ALREADY reflect this landing?) is semantic — it belongs to
 * the agent (`cc-artifacts.md` § "No semantic analysis in hooks"). The hook is
 * the structural TRIGGER; the agent is the semantic judge. The deterministic
 * primary lives in `commands/release.md` + `rules/wave-loop.md` G2; this hook is
 * the backstop that catches landings the high-ceremony commands don't cover.
 */

const path = require("path");

// cc-artifacts.md Rule 7 — timeout fallback that never hangs the session.
// Exit code 1 (NOT 0) is the canonical convention: it makes a timeout-FIRED
// passthrough distinguishable in exit-code logs from a normal exit-0 passthrough
// (matches the Rule-7 snippet + the sibling fold-amendment-paired-with-helper.js).
// .unref() so the pending timer never holds the event loop open on its own.
const TIMEOUT_MS = 5000;
let _timeout = null;

function passthrough() {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

// A `gh pr merge` that is a COMMAND — not the same text quoted, heredoc'd or
// commented — is the landing signal.
//
// WHY THIS IS NOW PARSED RATHER THAN MATCHED. Until 2026-09-13 this was a raw
// regex anchored on a shell separator, and the comment here ACCEPTED its
// over-fire on a `;`/`|`-preceded literal inside a quoted string, reasoning that
// an advisory over-fire costs "only one nudge". Measured, that reasoning did not
// hold: the hook fired FOUR times in one session on commands that merged nothing
// — twice inside a `node -e` argument carrying `gh pr checks 42 && gh pr merge 42`
// as TEST DATA, and twice on a commit-message heredoc quoting the same text in
// its verification notes. Each fire demanded a `.session-notes` refresh for a
// landing that never happened, and the correct response to each was to explain
// why the hook was wrong. An advisory that must be argued with on ordinary work
// is not a cheap nudge; it is training to skim past the channel, and it shares
// that channel with every other advisory.
//
// The separator anchor is also the thing that made it fire: quoted prose reaches
// it exactly when a `;` or `&&` precedes the token, which is what a QUOTED SHELL
// EXAMPLE looks like — so the anchor selected FOR the false-positive shape.
//
// ONE LINEAGE, not a second dialect. `dispatchSurface` strips heredoc bodies and
// shell comments, then `parseGhInvocations` splits quote-aware and tokenizes, so
// a `gh pr merge` inside quotes is DATA and never a command word. This is the
// same machinery `hooks/lib/check-merge-separation.js` already uses for the same
// token — it classified every one of these four cases correctly while this hook
// fired, which is the measurement that decided the fix. Two matchers for one
// token drift; the sibling was already right.
//
// Fails OPEN and stays advisory: if the parser cannot be loaded or throws, the
// old anchor answers, because a missed wrapup nudge is cheaper than a crash in a
// PostToolUse hook.
function isLandingCommand(cmd) {
  const raw = String(cmd == null ? "" : cmd);
  try {
    // `parseGhInvocations` NORMALIZES THROUGH `dispatchSurface` ITSELF — heredoc
    // bodies and shell comments are stripped inside it, and the quote-aware split
    // happens there too. It takes the RAW command, exactly as the sibling calls
    // it. An earlier revision of this fix destructured `dispatchSurface` and
    // pre-applied it; that helper is not exported, so the call threw and the
    // catch below silently answered with the very regex this change replaces —
    // the fix looked applied and never executed once.
    const { parseGhInvocations } = require("./lib/git-command-parse.js");
    const invs = parseGhInvocations(raw);
    return (invs || []).some(
      (inv) =>
        inv &&
        inv.group === "pr" &&
        inv.sub === "merge" &&
        !(Array.isArray(inv.argv)
          ? inv.argv.some((t) => t === "--help" || t === "-h")
          : false),
    );
  } catch {
    return /(^|[\n;&|]\s*)gh\s+pr\s+merge\b(?!\s+(?:--help|-h)\b)/.test(raw);
  }
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). Everything a standalone run
// did at load time happens here instead, so a require() has no side effects.
function hookMain() {
  _timeout = setTimeout(() => {
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    process.exit(1);
  }, TIMEOUT_MS);
  _timeout.unref?.();
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.on("error", passthrough); // stdin read error → immediate fail-open (not 5s timeout-delayed)
    process.stdin.on("data", (d) => (input += d));
    process.stdin.on("end", () => {
      try {
        onStdinEnd(input);
      } catch (e) {
        return reject(e);
      }
      resolve();
    });
  });
}

function onStdinEnd(input) {
  clearTimeout(_timeout);
  try {
    const payload = JSON.parse(input || "{}");
    const cmd =
      (payload && payload.tool_input && payload.tool_input.command) || "";
    if (!isLandingCommand(cmd)) return passthrough();

    const { emit } = require(
      path.join(__dirname, "lib", "instruct-and-wait.js"),
    );
    // emit() writes the canonical JSON to stdout and exits (advisory → exit 0,
    // continue:true, body delivered via hookSpecificOutput.additionalContext).
    emit({
      hookEvent: "PostToolUse",
      severity: "advisory",
      what_happened:
        "A pull request was just merged (gh pr merge) — a wave/release landed.",
      why: "wrapup-on-landing: .session-notes is the next session's entry point and MUST reflect this landing, so the wrapup happens WITH the landing rather than as a forgotten manual step.",
      agent_must_report: [
        "State whether .session-notes already reflects this landing (e.g. the merged PR updated it).",
        "If it does NOT, refresh .session-notes NOW per the /wrapup contract (priority-ordered Read-first, in-flight state, traps, forest-ledger reconciliation from memory) — do not defer it to a separate manual /wrapup.",
      ],
      agent_must_wait:
        "Skip ONLY if the merged PR already updated .session-notes; otherwise refresh it before continuing.",
      user_summary:
        "PR merged — ensure .session-notes reflects this landing (auto-wrapup nudge).",
    });
  } catch {
    return passthrough();
  }
}

module.exports = { hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
