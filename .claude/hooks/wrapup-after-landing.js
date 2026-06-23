#!/usr/bin/env node
/**
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
const _timeout = setTimeout(() => {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(1);
}, TIMEOUT_MS);
_timeout.unref?.();

function passthrough() {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

// A `gh pr merge` at command start or after a shell separator (`;`, `&&`, `|`)
// is the landing signal. The negative lookahead excludes `gh pr merge --help`/
// `-h` (the common non-landing invocation). The anchor is SEGMENT-based, not a
// shell parser, so it cannot see quoting — a `;`/`|`-preceded `gh pr merge`
// LITERAL inside a quoted string (e.g. `echo 'a; gh pr merge'`) over-fires. That
// residual is ACCEPTED: the hook is advisory + fail-open, so an over-fire costs
// only one nudge the agent acknowledges (the false-positive carve-out of
// hook-output-discipline.md MUST-4) — never a block. A space-preceded substring
// (`echo 'run gh pr merge later'`) is correctly excluded by the separator anchor.
function isLandingCommand(cmd) {
  return /(^|[\n;&|]\s*)gh\s+pr\s+merge\b(?!\s+(?:--help|-h)\b)/.test(
    String(cmd),
  );
}

let input = "";
process.stdin.on("error", passthrough); // stdin read error → immediate fail-open (not 5s timeout-delayed)
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
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
});
