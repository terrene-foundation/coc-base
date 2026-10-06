#!/usr/bin/env node
/**
 * Audit-fixture runner for the delegation-permission detector —
 * `.claude/hooks/lib/delegation-permission.js` plus the REAL
 * `.claude/hooks/delegation-permission-guard.js` stdin/transcript boundary, shipped WITH the
 * detector per `cc-artifacts.md` Rule 9.
 *
 * THE DETECTOR: at `Stop`, read the newest text-bearing assistant message and fire when the turn's
 * substance was ASKING FOR AUTHORIZATION TO DISPATCH SUBAGENTS — the ASK arm of
 * `orchestrator-context-economy.md` MUST-3, which `delegation-default-guard.js` reads from the
 * other side (the ABSENCE of a dispatch).
 *
 * COVERAGE SHAPE — ONE CASE PER SCOPE-RESTRICTION PREDICATE, the predicates a wrong edit would
 * silently widen or narrow:
 *
 *   1  REQUEST — a first-person-to-second-person permission construction is required
 *   2  OBJECT — the thing asked about must be subagent dispatch / parallel lanes
 *   3  PROXIMITY — REQUEST and OBJECT must land in the SAME sentence
 *   4  SUPPRESSOR A — non-assertive spans (fences, inline code, quotes, blockquotes) are stripped
 *   5  SUPPRESSOR B — a genuinely-gated topic drops the sentence
 *   6  SUPPRESSOR C — a citation / meta marker drops the sentence
 *   7  REPORT-NOT-REQUEST — past-tense dispatch reporting is not a request
 *   8  TRI-STATE — UNKNOWN is never QUIET
 *   9  RENDERING — which states speak, and the severity cap is stated in the emitted text
 *  10  SIGNATURE — the dedupe key discriminates
 *  11  MARKER — injective session mapping + fail-open read + round-trip
 *  12  THE REAL HOOK BOUNDARY — real child process, real transcript file, real exit code
 *
 * BIPOLAR BY CONSTRUCTION: every predicate carries BOTH a firing pole and a quiet pole. A set that
 * only ever asserts firing passes identically against a detector that fires on everything; a set
 * that only ever asserts silence passes identically against one that is INERT. Both are live risks
 * — the hook is capped below `block`, so an inert one is indistinguishable from a session that
 * never asked, which is precisely the non-discriminating instrument `instrument-discipline.md`
 * MUST-1 forbids citing as evidence.
 *
 * THE THREE NAMED FALSE-POSITIVE CLASSES each get their OWN compliant pole, because they are the
 * classes the detector was commissioned to avoid and a header claim is not a test:
 *   - quoting the constraint while explaining it   → 15, 16, 17, 18, 18b, 23c, 37 (control: 14)
 *   - asking about something genuinely gated       → 19, 20, 21, 23        (control: 22)
 *   - reporting that a dispatch happened           → 24, 25, 36            (control: 14)
 *   Each carries a CONTROL firing on the same sentence WITHOUT the suppressing property, so a
 *   green is caused by the suppressor and not by the sentence being unmatched anyway.
 *
 * ESTABLISHED RED (`instrument-discipline.md` MUST-2 + MUST-5): every mutation below was RUN
 * against these files before this set landed, and each mutation's REACH was proven before its
 * result was read (the mutated line was shown to execute). The sets are what each mutation
 * ACTUALLY reddened — MEASURED, not predicted — and the restored files exit 0:
 *   M-a  `hasRequestConstruction` → `true`                        → 02, 04, 10, 11, 24, 25, 31, 36
 *   M-b  `hasDispatchObject` → `true`                             → 06, 08, 10, 11
 *   M-c  `suppressorFor` → `null`                                 → 19, 20, 21, 23, 23b, 23c
 *   M-d  `stripNonAssertiveSpans` → identity                      → 15, 16, 17, 18, 37
 *   M-e  proximity: scan the joined text instead of per sentence  → 10, 11
 *   M-f  the UNKNOWN branch of `assessLiftRequest` → QUIET        → 26, 28
 *   M-g  `JSON.parse(await readStdinBounded())` in the HOOK       → 34, 35, 38, 39, 40b, 41
 *   M-h  `alreadySurfaced` → `false` unconditionally              → 41, 44b
 *
 * ONE MUTATION WAS RE-RUN RATHER THAN BANKED, and it is recorded because the first result would
 * have read as a clean pass. M-f's first spelling spliced a STATEMENT into a parenthesised
 * expression (`(probe(); "QUIET")`), which is a SyntaxError: the runner exited non-zero having
 * printed NO cases, its reach marker stayed at 0 bytes, and the red-set was EMPTY. That is a
 * BROKEN EDIT, not an inert mutation, and `instrument-discipline.md` MUST-5(b) forbids reading an
 * empty red-set as a vacuity verdict — so it was resolved (comma expression instead of a
 * statement), whereupon the marker showed 8 bytes of reach and cases 26 and 28 RED. This is why
 * every row above carries a measured REACH figure and not merely an exit code.
 *
 * Case 12 is deliberately NOT a regression lock and reds under none of the eight: it is the
 * POSITIVE CONTROL on the sentence splitter itself, asserting it can return more than one
 * sentence. Without it, the proximity poles' greens would be consistent with a splitter that
 * returns the whole message as one sentence — an instrument unable to produce the other answer
 * (`instrument-discipline.md` MUST-3(a)). Recorded here rather than left looking like a gap.
 *
 * Pure functions against in-memory strings, plus one throwaway git repo in tmp for the marker and
 * hook-boundary cases. No network, no live session, and NOTHING is written under the real
 * `.claude/learning/` — the hook resolves its sink from `CLAUDE_PROJECT_DIR`, which these cases
 * point at the tmp repo. Case 45 asserts that.
 */

import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const REPO = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const L = require(path.join(REPO, ".claude/hooks/lib/delegation-permission.js"));

const cases = [];
function check(id, name, cond, detail, redsUnder) {
  cases.push({ id, name, pass: !!cond, detail, redsUnder });
}

/** Assess a bare message with no read failure. */
const A = (text) => L.assessLiftRequest(text);
const state = (text) => A(text).state;

// ── 1. REQUEST — a permission construction is REQUIRED ─────────────────────────────────────────
check(
  "01",
  "REQUEST firing pole: `Should I ...` + a subagent object ADVISES",
  state("Should I dispatch subagents to handle the three independent shards?") === "ADVISE",
  `→ ${state("Should I dispatch subagents to handle the three independent shards?")}`,
);
check(
  "02",
  "REQUEST quiet pole: the SAME object with NO permission construction is QUIET",
  state("I am dispatching subagents to handle the three independent shards.") === "QUIET",
  `→ ${state("I am dispatching subagents to handle the three independent shards.")}`,
  "M-a: hasRequestConstruction → true",
);
check(
  "03",
  "REQUEST firing pole: the whole idiom set is live, not just one entry",
  [
    "Would you like me to fan out across parallel lanes for this?",
    "Do you want me to spawn reviewers for each shard?",
    "Let me know if you'd like me to parallelize this across agents.",
    "With your approval I will launch four specialists on the remaining shards.",
    "Awaiting your go-ahead to dispatch the analysts.",
    "I need your permission to spawn subagents for this sweep.",
    "Am I allowed to launch parallel lanes here?",
    "Say the word and I will fan out the reviewers.",
  ].every((s) => state(s) === "ADVISE"),
  "all eight permission idioms fire against a dispatch object",
);
check(
  "04",
  "REQUEST quiet pole: THIRD-PERSON exposition about the class never fires",
  [
    "The agent asks whether it should dispatch subagents, which is the failure this detects.",
    "A turn whose substance is requesting authorization to use parallel lanes is the violation.",
    "Waiting to be told to parallelize caps throughput at the operator's attention.",
  ].every((s) => state(s) === "QUIET"),
  "no `I`/`you` permission frame → the form every DOCUMENT about this class takes stays quiet",
  "M-a: hasRequestConstruction → true",
);

// ── 2. OBJECT — the thing asked about must be dispatch / parallel lanes ────────────────────────
check(
  "05",
  "OBJECT firing pole: naming a subagent alone is unambiguous",
  L.hasDispatchObject("shall I use sub-agents") && L.hasDispatchObject("should I use the Task tool"),
  "sub-agent / task tool need no second token",
);
check(
  "06",
  "OBJECT quiet pole: a permission ask about something ELSE is QUIET",
  [
    "Should I read the remaining three files before I answer?",
    "Would you like me to summarise the findings instead?",
    "Do you want me to keep the original wording?",
  ].every((s) => state(s) === "QUIET"),
  "a permission construction with no dispatch object is not a lift request",
  "M-b: hasDispatchObject → true (also reds under M-a)",
);
check(
  "07",
  "OBJECT firing pole: an ambiguous verb PLUS an agent noun fires",
  L.hasDispatchObject("dispatch the reviewers") && L.hasDispatchObject("run the lanes in parallel"),
  "dispatch+reviewers and parallel+lanes both resolve",
);
check(
  "08",
  "OBJECT quiet pole: the ambiguous verb ALONE does not fire",
  !L.hasDispatchObject("shall I dispatch the release build") &&
    !L.hasDispatchObject("should I run these in parallel"),
  "a dispatch verb or a parallel adverb with NO agent noun is not a dispatch object",
  "M-b: hasDispatchObject → true",
);

// ── 3. PROXIMITY — REQUEST and OBJECT must be in ONE sentence ─────────────────────────────────
check(
  "09",
  "PROXIMITY firing pole: both conjuncts in one sentence ADVISES",
  state("Shall I dispatch four reviewers on the remaining shards?") === "ADVISE",
  "one sentence, both halves",
);
check(
  "10",
  "PROXIMITY quiet pole: the halves SPLIT across sentences stay QUIET",
  state("Should I keep going with the rewrite? I already dispatched four reviewers.") === "QUIET",
  `→ ${state("Should I keep going with the rewrite? I already dispatched four reviewers.")}`,
  "M-e: scan the joined text instead of per sentence",
);
check(
  "11",
  "PROXIMITY quiet pole: split across NEWLINES stays QUIET too",
  state("Should I keep the original wording?\nThe reviewers ran in parallel and returned clean.") ===
    "QUIET",
  "a newline ends a sentence as surely as a full stop does",
  "M-e: scan the whole text instead of per sentence",
);
check(
  "12",
  "SPLITTER positive control: the splitter CAN return more than one sentence",
  L.splitSentences("One. Two.\nThree").length === 3,
  `splitSentences → ${JSON.stringify(L.splitSentences("One. Two.\nThree"))}`,
);
check(
  "13",
  "SPLITTER: leading list markers are stripped so a bare bullet ask is still seen",
  state("- Shall I dispatch subagents for the remaining shards?") === "ADVISE",
  "an agent's closing ask is very often a bare bullet with no terminator",
);

// ── 4. SUPPRESSOR A — non-assertive spans (FALSE-POSITIVE CLASS 1: quoting the constraint) ────
check(
  "14",
  "QUOTE-CLASS firing pole (control): the SAME sentence UNQUOTED does fire",
  state("Shall I dispatch subagents for this?") === "ADVISE",
  "establishes that the quiet poles below are caused by the QUOTING, not by the sentence",
);
check(
  "15",
  "QUOTE-CLASS quiet pole: the ask inside DOUBLE QUOTES is a mention, not an assertion",
  state('The detector fires on a turn that says "Shall I dispatch subagents for this?" verbatim.') ===
    "QUIET",
  `→ ${state('The detector fires on a turn that says "Shall I dispatch subagents for this?" verbatim.')}`,
  "M-d: stripNonAssertiveSpans → identity",
);
check(
  "16",
  "QUOTE-CLASS quiet pole: the ask inside INLINE CODE is a mention",
  state("It should fire on `Shall I dispatch subagents for this?` and nothing else.") === "QUIET",
  "inline backtick spans are stripped before the scan",
  "M-d: stripNonAssertiveSpans → identity",
);
check(
  "17",
  "QUOTE-CLASS quiet pole: the ask inside a FENCED BLOCK is a mention",
  state("Example violation:\n```\nShall I dispatch subagents for this?\n```\nThat is the shape.") ===
    "QUIET",
  "fenced code is stripped first, before quotes and backticks",
  "M-d: stripNonAssertiveSpans → identity",
);
check(
  "18",
  "QUOTE-CLASS quiet pole: the ask inside a BLOCKQUOTE is a mention",
  state("The prior turn said:\n> Shall I dispatch subagents for this?\nThat was the violation.") ===
    "QUIET",
  "blockquote lines are stripped",
  "M-d: stripNonAssertiveSpans → identity",
);
check(
  "18b",
  "QUOTE-CLASS bound: an UNTERMINATED quote does NOT swallow the rest of the message",
  state('He said "unterminated and then\nShall I dispatch subagents for this?') === "ADVISE",
  "one stray double quote must not become a blanket suppressor (newline-excluded, length-capped)",
);

// ── 5. SUPPRESSOR B — genuinely-gated topics (FALSE-POSITIVE CLASS 2) ─────────────────────────
check(
  "19",
  "GATED quiet pole: a CROSS-REPO ask is mandated, not a violation",
  state("Should I dispatch a lane to file this cross-repo, or handle it here?") === "QUIET",
  "repo-scope-discipline.md § User-Authorized Exception REQUIRES the ask",
  "M-c: suppressorFor → null",
);
check(
  "20",
  "GATED quiet pole: a DESTRUCTIVE-op ask is mandated",
  [
    "Shall I dispatch a lane to delete the stale worktrees?",
    "Should I have the agents run git reset --hard on those trees?",
  ].every((s) => state(s) === "QUIET"),
  "git.md § Destructive Working-Tree Ops REQUIRES the ask",
  "M-c: suppressorFor → null",
);
check(
  "21",
  "GATED quiet pole: RELEASE authorization and PLAN approval asks are mandated",
  [
    "Shall I dispatch the release lanes and publish?",
    "Do you want me to spawn agents once you approve the plan?",
  ].every((s) => state(s) === "QUIET"),
  "autonomous-execution.md § Structural vs Execution Gates REQUIRES both asks",
  "M-c: suppressorFor → null",
);
check(
  "22",
  "GATED firing pole (control): the SAME shape WITHOUT a gated token fires",
  state("Shall I dispatch a lane to sweep the stale worktrees?") === "ADVISE",
  "establishes the quiet poles above are caused by the GATED TOKEN, not by the sentence shape",
);
check(
  "23",
  "SUPPRESSION is COUNTED, not silently dropped — a suppressed candidate is visible in the data",
  (() => {
    const v = A("Shall I dispatch a lane to push this branch?");
    return v.state === "QUIET" && v.suppressed === 1 && /suppressed/.test(v.reason || "");
  })(),
  `suppressed=${A("Shall I dispatch a lane to push this branch?").suppressed}`,
  "M-c: suppressorFor → null",
);

// ── 6. SUPPRESSOR C — citation / meta markers ─────────────────────────────────────────────────
check(
  "23b",
  "CITATION quiet pole: a sentence citing a rule file or a MUST number is exposition",
  [
    "Per agents.md § Triad, should I dispatch subagents by default here?",
    "Under MUST-3, may I spawn parallel lanes without being asked?",
  ].every((s) => state(s) === "QUIET"),
  "a rule citation, a MUST number, or a section sign marks exposition about the class",
);
check(
  "23c",
  "CITATION quiet pole: quoting the harness constraint verbatim is exposition",
  state("Should I dispatch subagents, given the rule says not to unless the user requested it?") ===
    "QUIET",
  "the verbatim constraint fragment is a mention marker",
);

// ── 7. REPORT-NOT-REQUEST (FALSE-POSITIVE CLASS 3) ────────────────────────────────────────────
check(
  "24",
  "REPORT quiet pole: past-tense dispatch reporting is not a request",
  [
    "I dispatched four reviewers; three returned clean and one found a stale path.",
    "Launched six parallel lanes; all six delivered.",
    "The subagents have all reported back with their findings.",
  ].every((s) => state(s) === "QUIET"),
  "reporting a dispatch carries no permission construction",
  "M-a: hasRequestConstruction → true",
);
check(
  "25",
  "REPORT quiet pole: a FORWARD-LOOKING statement of intent is not a request either",
  [
    "I will dispatch four reviewers next.",
    "Next I am going to fan out across three parallel lanes.",
  ].every((s) => state(s) === "QUIET"),
  "announcing a dispatch is the compliant behaviour, not the violation",
  "M-a: hasRequestConstruction → true",
);

// ── 8. TRI-STATE — UNKNOWN is never QUIET ─────────────────────────────────────────────────────
check(
  "26",
  "UNKNOWN firing pole: a typed read failure is UNKNOWN, never QUIET",
  L.assessLiftRequest("", { reason: "transcript could not be opened (ENOENT)" }).state === "UNKNOWN",
  `→ ${L.assessLiftRequest("", { reason: "transcript could not be opened (ENOENT)" }).state}`,
  "M-f: the UNKNOWN branch → QUIET",
);
check(
  "27",
  "UNKNOWN carries the typed reason from the failed read, not a generic one",
  L.assessLiftRequest("", { reason: "transcript is not a regular file" }).reason.includes(
    "not a regular file",
  ),
  "the caller's typed reason survives into the verdict",
);
check(
  "28",
  "UNKNOWN firing pole: an EMPTY or non-string reply is UNKNOWN, and SAYS it is not clean",
  ["", "   ", null, undefined, 42].every((t) => L.assessLiftRequest(t).state === "UNKNOWN") &&
    /NOT a clean result/.test(L.assessLiftRequest("").reason),
  "absence of text is absence of evidence, not evidence of absence",
  "M-f: the UNKNOWN branch → QUIET",
);
check(
  "29",
  "UNKNOWN quiet pole: real text with no ask is QUIET, and is DISTINCT from UNKNOWN",
  state("I finished the sweep and committed the result.") === "QUIET",
  "a read that succeeded and found nothing is a different state from a read that did not happen",
);

// ── 9. RENDERING ──────────────────────────────────────────────────────────────────────────────
check(
  "30",
  "RENDER firing pole: ADVISE renders a non-empty block naming MUST-3 and QUOTING the sentence",
  (() => {
    const body = L.formatLiftAdvisory(A("Shall I dispatch subagents for the three shards?")) || "";
    return body.includes("MUST-3") && body.includes("Shall I dispatch subagents");
  })(),
  `chars=${(L.formatLiftAdvisory(A("Shall I dispatch subagents for the three shards?")) || "").length}`,
);
check(
  "31",
  "RENDER quiet pole: QUIET and UNKNOWN render NOTHING",
  L.formatLiftAdvisory(A("I dispatched four reviewers.")) === null &&
    L.formatLiftAdvisory(L.assessLiftRequest("")) === null,
  "silence in the transcript; the STATE is still distinct in the data (cases 26–29)",
  "M-a: hasRequestConstruction → true",
);
check(
  "32",
  "RENDER: a malformed verdict renders nothing rather than throwing",
  L.formatLiftAdvisory(undefined) === null &&
    L.formatLiftAdvisory("x") === null &&
    L.formatLiftAdvisory({ state: "ADVISE" }) !== undefined,
  "fail open at the render seam too",
);
check(
  "32b",
  "SEVERITY: the advisory states it is not a block, and never emits a block severity",
  (() => {
    const body = L.formatLiftAdvisory(A("Shall I spawn subagents for this?")) || "";
    return (
      body.includes("never a block") &&
      body.includes("MUST-2") &&
      !body.includes('severity: "block"')
    );
  })(),
  "hook-output-discipline.md MUST-2 — a lexical finding is capped below block, and says so in-band",
);
check(
  "32c",
  "SEVERITY: the advisory carries its OWN false-positive bound, not only the docs'",
  (L.formatLiftAdvisory(A("Shall I spawn subagents for this?")) || "").includes(
    "cannot see whether the human",
  ),
  "the honest bound travels with the finding",
);

// ── 10. SIGNATURE ─────────────────────────────────────────────────────────────────────────────
check(
  "33b",
  "SIGNATURE firing pole: a DIFFERENT matched sentence produces a different signature",
  L.signatureOf(A("Shall I dispatch subagents for shard A?")) !==
    L.signatureOf(A("Shall I dispatch subagents for shard B?")),
  "a new ask speaks again",
);
check(
  "33c",
  "SIGNATURE quiet pole: the SAME sentence (any casing/spacing) produces the SAME signature",
  L.signatureOf(A("Shall I dispatch subagents for shard A?")) ===
    L.signatureOf(A("shall  i   dispatch SUBAGENTS for shard A?")) &&
    L.signatureOf(A("nothing here")) === "" &&
    L.signatureOf(null) === "",
  "a persisting ask is surfaced once, not once per turn; non-ADVISE states have no signature",
);

// ── 11/12. MARKER + THE REAL HOOK BOUNDARY ────────────────────────────────────────────────────
// Every case above exercises pure functions. They would ALL PASS against a hook that never runs —
// which is what happened to `dispatch-contract-guard.js`, inert on every input while 42 library
// fixtures stayed green. These cases drive the hook as the runtime does: real child process, real
// stdin, real transcript file on disk, real stdout and exit code.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "delegation-permission-fixture-"));
  const q = { cwd: tmp, stdio: "ignore" };
  execFileSync("git", ["init", "-q"], q);
  execFileSync(
    "git",
    ["-c", "user.email=f@x", "-c", "user.name=f", "commit", "-q", "--allow-empty", "-m", "init"],
    q,
  );

  const HOOK = path.join(REPO, ".claude/hooks/delegation-permission-guard.js");

  /** Write a transcript JSONL whose newest text-bearing assistant entry carries `text`. */
  function transcript(name, text, { trailingToolTurn = false } = {}) {
    const p = path.join(tmp, `${name}.jsonl`);
    const rows = [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "go" }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } },
    ];
    if (trailingToolTurn) {
      rows.push({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      });
    }
    fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return p;
  }

  const fire = (session, payload) => {
    const r = spawnSync("node", [HOOK], {
      input: typeof payload === "string" ? payload : JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmp },
    });
    return { stdout: r.stdout || "", stderr: r.stderr || "", code: r.status == null ? -1 : r.status };
  };
  const lastJson = (r) => {
    try {
      return JSON.parse(r.stdout.trim().split("\n").pop() || "{}");
    } catch {
      return null;
    }
  };

  const askPath = transcript("ask", "I have three independent shards.\nShall I dispatch subagents for them?");
  const cleanPath = transcript("clean", "I dispatched three subagents; all three returned clean.");
  const quotedPath = transcript(
    "quoted",
    'The failure looks like "Shall I dispatch subagents for them?" — that is what fires.',
  );
  const toolTailPath = transcript(
    "tooltail",
    "Shall I dispatch subagents for the remaining shards?",
    { trailingToolTurn: true },
  );

  const firing = fire("s-fire", {
    hook_event_name: "Stop",
    session_id: "s-fire",
    transcript_path: askPath,
  });
  const quiet = fire("s-quiet", {
    hook_event_name: "Stop",
    session_id: "s-quiet",
    transcript_path: cleanPath,
  });
  const quoted = fire("s-quoted", {
    hook_event_name: "Stop",
    session_id: "s-quoted",
    transcript_path: quotedPath,
  });
  const toolTail = fire("s-tooltail", {
    hook_event_name: "Stop",
    session_id: "s-tooltail",
    transcript_path: toolTailPath,
  });
  const inline = fire("s-inline", {
    hook_event_name: "Stop",
    session_id: "s-inline",
    last_assistant_text: "Would you like me to spawn parallel lanes for the remaining shards?",
  });
  const malformed = fire("s-malformed", "not json at all {{{");
  const noPath = fire("s-nopath", { hook_event_name: "Stop", session_id: "s-nopath" });
  const badPath = fire("s-badpath", {
    hook_event_name: "Stop",
    session_id: "s-badpath",
    transcript_path: path.join(tmp, "definitely-not-here.jsonl"),
  });
  const dedupe1 = fire("s-dedupe", {
    hook_event_name: "Stop",
    session_id: "s-dedupe",
    transcript_path: askPath,
  });
  const dedupe2 = fire("s-dedupe", {
    hook_event_name: "Stop",
    session_id: "s-dedupe",
    transcript_path: askPath,
  });

  check(
    "34",
    "END-TO-END firing pole: a lift-request transcript reaches the AGENT as systemMessage",
    (() => {
      const j = lastJson(firing);
      return (
        j &&
        j.continue === true &&
        typeof j.systemMessage === "string" &&
        j.systemMessage.includes("delegation-permission") &&
        j.systemMessage.includes("Shall I dispatch subagents")
      );
    })(),
    `stdout=${JSON.stringify(firing.stdout.slice(0, 100))}`,
    "M-g: JSON.parse the already-parsed payload in the hook (the inert-hook bug)",
  );
  check(
    "35",
    "END-TO-END firing pole: the HUMAN channel (stderr) also carries the finding",
    firing.stderr.includes("delegation-permission"),
    `stderr chars=${firing.stderr.length}`,
    "M-g: JSON.parse the already-parsed payload in the hook",
  );
  check(
    "36",
    "END-TO-END quiet pole: a dispatch-REPORT transcript carries NO systemMessage on either channel",
    (() => {
      const j = lastJson(quiet);
      return j && j.continue === true && j.systemMessage === undefined && quiet.stderr.trim() === "";
    })(),
    `stdout=${JSON.stringify(quiet.stdout.slice(0, 80))} stderr=${JSON.stringify(quiet.stderr.slice(0, 60))}`,
    "M-g: JSON.parse the already-parsed payload in the hook",
  );
  check(
    "37",
    "END-TO-END quiet pole: the QUOTED ask transcript stays silent (false-positive class 1, end to end)",
    (() => {
      const j = lastJson(quoted);
      return j && j.continue === true && j.systemMessage === undefined;
    })(),
    "the strip runs on the REAL recovered text, not only on an in-memory string",
    "M-d: stripNonAssertiveSpans → identity",
  );
  check(
    "38",
    "END-TO-END: a trailing TOOL-ONLY assistant turn does not hide the ask (measured 17.3% of sessions)",
    (() => {
      const j = lastJson(toolTail);
      return j && typeof j.systemMessage === "string" && j.systemMessage.includes("Shall I dispatch");
    })(),
    "the reader walks back to the newest TEXT-BEARING entry",
    "M-g: JSON.parse the already-parsed payload in the hook",
  );
  check(
    "39",
    "END-TO-END: the INLINE payload shape (`last_assistant_text`) is read when present",
    (() => {
      const j = lastJson(inline);
      return j && typeof j.systemMessage === "string" && j.systemMessage.includes("spawn parallel lanes");
    })(),
    "correct under BOTH payload shapes without knowing which the host emits",
    "M-g: JSON.parse the already-parsed payload in the hook",
  );
  check(
    "40",
    "ROBUSTNESS: malformed stdin, missing transcript_path, and a NON-EXISTENT path all pass through",
    [malformed, noPath, badPath].every((r) => {
      const j = lastJson(r);
      return r.code === 0 && j && j.continue === true && j.systemMessage === undefined;
    }),
    `codes=${[malformed, noPath, badPath].map((r) => r.code).join(",")}`,
  );
  check(
    "40b",
    "ROBUSTNESS: an OFFERED-but-unreadable transcript is LOUD (one-time WARN), not silent",
    badPath.stderr.includes("stop-transcript-recovery"),
    `stderr=${JSON.stringify(badPath.stderr.slice(0, 90))}`,
    "M-g: JSON.parse the already-parsed payload in the hook",
  );
  check(
    "40c",
    "ROBUSTNESS quiet pole: a payload offering NO transcript at all does NOT warn",
    noPath.stderr.trim() === "",
    "warning on the ordinary no-op is what trains a reader to ignore the channel",
  );
  check(
    "41",
    "END-TO-END dedupe: the SAME ask is surfaced once, not once per turn",
    (() => {
      const j1 = lastJson(dedupe1);
      const j2 = lastJson(dedupe2);
      return (
        j1 && typeof j1.systemMessage === "string" && j2 && j2.systemMessage === undefined && j2.continue === true
      );
    })(),
    `first=${dedupe1.stdout.length} chars, second=${dedupe2.stdout.length} chars`,
    "M-h: alreadySurfaced() returns false unconditionally",
  );
  check(
    "42",
    "END-TO-END: EVERY path emits continue:true on stdout and exits 0",
    [firing, quiet, quoted, toolTail, inline, malformed, noPath, badPath, dedupe1, dedupe2].every(
      (r) => r.code === 0 && (lastJson(r) || {}).continue === true,
    ),
    "never blocks, never holds up shutdown — hook-output-discipline.md MUST-2 + cc-artifacts.md Rule 7",
  );
  check(
    "43",
    "MARKER: the session→file mapping is injective across sanitizing collisions",
    L.markerPath(tmp, "a/b") !== L.markerPath(tmp, "a_b"),
    "two raw ids that sanitize alike still land on distinct files",
  );
  check(
    "44",
    "MARKER quiet pole: an unread/absent marker fails OPEN (advisory still emitted)",
    L.alreadySurfaced(tmp, "never-seen-session", "ADVISE:deadbeefcafe") === false,
    "a lost dedupe costs a repeated line; a wrong suppression costs the finding",
  );
  check(
    "44b",
    "MARKER firing pole: a written signature IS seen on the next read, a DIFFERENT one is not",
    (() => {
      L.markSurfaced(tmp, "marker-rt", "ADVISE:aaaaaaaaaaaa");
      return (
        L.alreadySurfaced(tmp, "marker-rt", "ADVISE:aaaaaaaaaaaa") === true &&
        L.alreadySurfaced(tmp, "marker-rt", "ADVISE:bbbbbbbbbbbb") === false
      );
    })(),
    "the round-trip resolves — the dedupe read can return the other answer",
    "M-h: alreadySurfaced() returns false unconditionally",
  );
  check(
    "45",
    "ISOLATION: nothing was written under the real repo's .claude/learning",
    !fs.existsSync(path.join(REPO, ".claude/learning/delegation-permission")) ||
      fs
        .readdirSync(path.join(REPO, ".claude/learning/delegation-permission"))
        .every((f) => !f.startsWith("s-") && !f.startsWith("marker-rt")),
    "the fixtures point CLAUDE_PROJECT_DIR at a throwaway repo",
  );

  fs.rmSync(tmp, { recursive: true, force: true });
}

let failed = 0;
for (const c of cases) {
  const tag = c.pass ? "PASS" : "FAIL";
  if (!c.pass) failed++;
  process.stdout.write(`${tag}  ${c.id}  ${c.name}  [${c.detail}]\n`);
}
process.stdout.write(`\n${cases.length - failed}/${cases.length} cases pass\n`);
process.exit(failed === 0 ? 0 : 1);
