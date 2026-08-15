#!/usr/bin/env node
/**
 * Hook: validate-prod-deploy
 * Event: PreToolUse
 * Matcher: Bash
 * @hook-event: PreToolUse:Bash (guard) — refuses ONE action (a production
 *   deploy with no verified staging marker) at the boundary that would run it.
 *   Bash is the only tool that can run one, so the matcher names it rather than
 *   `*` (hook-event-selection.md MUST-3). The subject — the command text — is
 *   supplied BY the event, so it exists when the hook fires; `SessionStart`
 *   would be the MUST-2 error, adjudicating a command not yet issued.
 *   This marker DECLARES the event a consumer opting in must register under;
 *   it does NOT register the hook (see @settings-registration below, which is
 *   deliberately `optional-consumer` and unchanged by loom#1596).
 * @settings-registration: optional-consumer — a prod-deploy gate a CONSUMER
 *   registers in its OWN .claude/settings.json under PreToolUse:Bash when it
 *   wants staging-before-prod gating (see Usage below). Not registered in
 *   loom's settings.json (loom is not a deploy target); the validate-emit
 *   `settings-hook-registration` check reads this marker (#771).
 * Purpose: Block direct production deployment commands unless staging has passed.
 *
 * Intercepts Bash commands that touch production Docker containers and
 * requires .staging-passed to exist with the current git HEAD commit.
 *
 * To use this hook, register it in .claude/settings.json under PreToolUse:Bash.
 * See deploy/scripts/ for the stage.sh and deploy.sh that write/read the marker.
 *
 * Exit Codes:
 *   0 = allow (command is safe, staging verified, or --skip-staging passed as a
 *       BARE argv token of the deploying invocation — loom#1551; a quoted or
 *       substring occurrence does NOT disable the gate)
 *   2 = block (direct production deploy without staging, stale staging marker,
 *       OR the staging gate could not run at all — see the fail-open note below)
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { instructAndWait } = require("./lib/instruct-and-wait");
const { readStdinBounded } = require("./lib/read-stdin-bounded.js");
const { resolveGitBinary, gitEnv } = require("./lib/git-subprocess-env.js");

/*
 * loom#1588 round 2 — BUDGET, AND WHY IT GREW FROM 5000.
 *
 * The reader below is given a real chance to FINISH before any fallback runs,
 * because a payload that is merely SLOW yields a FULL, precise verdict
 * (SAFE_PATTERNS, quote-aware splitting, the staging check) whereas a payload
 * that times out yields only the coarse raw-text fallback. Buying precision
 * with wall-clock is the right trade for a deploy gate, and it costs nothing in
 * the normal case: the reader resolves on EOF the instant stdin closes, so this
 * ceiling is only ever reached by a stdin that is genuinely stuck.
 *
 * WHY 5000 HAD TO GROW — corrected in round 3, because round 2 gave the right
 * answer for the wrong reason. It argued the outer timer "could fire mid-gate"
 * once the reader (2000) plus the two git calls (3000 each) exceeded it. That
 * cannot happen and never could: `execFileSync` blocks the event loop, and a
 * timer that comes due during synchronous work is not dispatched until that work
 * yields — which here it never does, because the path from the `await` to
 * `process.exit` is synchronous throughout. A slow gate does not trip this timer.
 *
 * THE REAL CONSTRAINT IS AN ORDERING INVARIANT, and it is documented at the
 * reader itself: the reader's budget MUST sit UNDER the caller's outer net
 * (`read-stdin-bounded.js` — "reader timer < outer fallback"), so the reader
 * hands back control and the caller adjudicates. Raising the reader to 6000
 * against an outer of 5000 INVERTS that, and the inversion is not cosmetic:
 * measured on a build differing only in those two numbers, with a production
 * deploy on the wire and EOF withheld, the outer net fired FIRST at 14519ms and
 * allowed the deploy at exit 0 — pre-empting the unreadable-stdin arm that
 * blocks the identical input at 6175ms. The outer budget grew because the reader
 * did. 14000 also matches fleet convention (worktree-forest-guard.js 14000,
 * session-end.js 15000).
 */
const STDIN_READ_TIMEOUT_MS = 6000;
const TIMEOUT_MS = 14000;

/*
 * The RAW stdin text, captured even when the payload could not be PARSED (see
 * § UNREADABLE STDIN). Module-scoped so the outer catch can still reach it after
 * a fault, which is what lets the pre-classification arm adjudicate a fault that
 * lands before the command text is in hand.
 *
 * NOT read by the backstop timer below, and round 2's claim that it was is what
 * this round removed: the assignment happens at the reader's settle, and the
 * timer can only fire while the reader has NOT settled. See the timer's note.
 */
let rawStdinText = "";

/*
 * Literal-token prescreen for the paths that have raw text but no parsed
 * command. MUST be a SUPERSET of the literal anchors in PROD_PATTERNS — today
 * every one of those eight patterns requires `docker`, and the ssh pattern
 * requires `ssh` AND `docker`, so `docker` alone is already complete; `deploy`
 * and `ssh` are carried as cheap headroom. ADD A TOKEN HERE WHEN ADDING A PROD
 * PATTERN WITH A NEW LITERAL ANCHOR.
 *
 * WHY A LITERAL ALTERNATION AND NOT PROD_PATTERNS ITSELF. PROD_PATTERNS[0..2]
 * are triple-nested `.*` and backtrack catastrophically: measured in this
 * worktree, 4 KiB of `compose prod ` filler costs 1233ms on PROD[0] alone and
 * grows superlinearly, so running that array over a buffer that may be 10 MiB
 * would hang the hook rather than gate it. A literal alternation has no
 * backtracking; measured, a linear scan of 10 MiB costs ~250ms. (The
 * backtracking of PROD_PATTERNS on the ALREADY-PARSED path is a separate,
 * pre-existing defect and is NOT addressed here — see the PR body residuals.)
 */
const DEPLOY_TOKENS = /docker|deploy|ssh/i;

/*
 * loom#1588 round 3 — THE BACKSTOP CANNOT DISCRIMINATE, SO IT NO LONGER PRETENDS TO.
 *
 * Round 2 gave this callback two branches: refuse when `rawStdinText` carries a
 * deploy token, otherwise allow loudly. The refusing branch could not execute,
 * and the reason is structural rather than a matter of timing luck.
 *
 * `rawStdinText` is written ONLY by the `onRawText` callback, which
 * `read-stdin-bounded.js` invokes inside `done()` — the same function that
 * resolves the reader's promise. So `rawStdinText !== ""` implies the reader has
 * already settled; and once it has, the path from the `await` in `main()`
 * through `process.exit` is synchronous end to end (`instructAndWait` is an
 * ordinary function, both git calls are `execFileSync`), so no timer is
 * dispatched anywhere along it. The two conditions are mutually exclusive:
 * whenever this callback CAN run, the text it would have judged is still "".
 *
 * MEASURED, NOT REASONED — the claim above is the kind that reads as obviously
 * true and is worth nothing unless a build is made to fire it. Against one whose
 * only change was lifting the reader budget ABOVE this one (60000 vs 14000) so
 * the timer genuinely fires, with a full production deploy written to stdin and
 * EOF withheld:
 *
 *   reader 60000 / outer 14000, deploy on the wire, no EOF
 *     -> timer FIRED at 14519ms, took the allow branch, exit 0
 *   reader  6000 / outer 14000 (shipped), identical stdin
 *     -> timer never fired; § UNREADABLE STDIN blocked at 6175ms, exit 2
 *
 * The deploy was on the wire in BOTH rows. Even in the row where the timer fired,
 * the refusing branch did not take — at 14000 the bytes had not been handed back.
 *
 * WHAT REMAINS IS DELIBERATE, ALL THREE PROPERTIES. The backstop still EXISTS
 * (`cc-artifacts.md` Rule 7; it is the only thing between a reader that never
 * settles and a hook that hangs forever). It ALLOWS, because it holds no evidence
 * on which to refuse, and refusing unconditionally would block every Bash call
 * whose hook is slow (`hook-output-discipline.md` MUST NOT § "Detectors that
 * block work the agent has been instructed to perform"). It is LOUD, because a
 * gate that did not run must not exit 0 in silence (`security.md`
 * § Secure-Default) — that half of round 2 was right and is kept.
 *
 * TO MAKE IT DISCRIMINATE, one change would do it: have the reader report raw
 * text INCREMENTALLY (per chunk) instead of once at settle, so text exists at the
 * only moment this callback can fire. That widens `read-stdin-bounded.js`'s
 * documented contract for every caller and belongs in its own review, not here.
 */
const timeout = setTimeout(() => {
  console.error(
    `[DEPLOY HOOK] NOTICE: the deploy gate timed out (${TIMEOUT_MS}ms) before ` +
      "reaching a verdict. The command was NOT classified and staging was NOT " +
      "verified — if this was a production deploy, nothing here says it was checked. " +
      "The gate holds no readable command text at this point, so it cannot tell a " +
      "deploy from an `ls` and allows rather than blocking every Bash call in the " +
      "session; re-run once the hook can complete.",
  );
  process.exit(0);
}, TIMEOUT_MS);

/*
 * loom#1471 shard 7 — AN UNANSWERABLE GATE REFUSES; IT DOES NOT WAVE THROUGH.
 *
 * Both git calls below used to `process.exit(0)` on failure, commented
 * "fail open". They resolve BOTH halves of the staging gate — the root the
 * `.staging-passed` marker is read from, and the HEAD it is compared against —
 * so a failure there does not mean "probably fine", it means the gate did not
 * run. The command then reached production with NO staging verification at all,
 * and nothing in the transcript said so.
 *
 * This sweep made that MORE reachable, not less. Those calls now carry
 * `env: gitEnv()`, which sets `GIT_CONFIG_NOSYSTEM=1` and
 * `GIT_CONFIG_GLOBAL=/dev/null` and therefore DISCARDS `safe.directory` —
 * so `rev-parse` is fatal on a differently-owned checkout: container
 * bind-mounts, CI runners, shared clones. Ordinary infrastructure, no attacker
 * required, and the failure was silent in the deploy direction.
 *
 * WHY `block` HERE AND `halt-and-report` IN integrity-guard, which faced the
 * same choice. `hook-output-discipline.md` MUST-2 permits either: the signal is
 * process state (a non-zero git exit), not a lexical match. The deciding
 * difference is the RECOVERY PATH. integrity-guard reasoned that a hard block on
 * an unresolvable-git host leaves the operator no way forward. This hook already
 * ships one, and it is checked ABOVE the git calls: `--skip-staging`, which
 * allows the deploy with a loud warning and a documentation requirement. So
 * blocking costs the operator one explicit, auditable flag rather than their
 * recovery path — and the alternative is a silent production deploy.
 */

/**
 * Emit a halting block via instructAndWait per hook-output-discipline.md MUST-1.
 * Structural evidence (file existence / git rev / non-zero exit) is the basis
 * for block severity per MUST-2 — never lexical regex alone.
 */
/**
 * A short, single-line rendering of a subprocess failure. git's own stderr is
 * preferred over the Error message because it names the actual cause
 * ("detected dubious ownership", "not a git repository", "ambiguous argument
 * 'HEAD'"), which is what the operator has to act on.
 */
function _reason(err) {
  const stderr = err && err.stderr ? String(err.stderr) : "";
  const text =
    stderr.trim() ||
    (err && err.message ? String(err.message) : "unknown error");
  return text.replace(/\s+/g, " ").slice(0, 300);
}

/**
 * Split a shell command into the individual commands it runs, on `&&`, `||`,
 * `;`, `|` and newline — but ONLY where those appear OUTSIDE quotes.
 *
 * QUOTE-AWARENESS IS LOAD-BEARING, NOT TIDINESS (loom#1471 round-4).
 *
 * The first version of this function split on the bare separators and argued
 * that was fail-closed, because an extra split can only produce more segments
 * and therefore more gating. That argument was WRONG, and the counter-example
 * is the canonical remote deploy:
 *
 *     ssh prod "cd /srv && docker compose up -d"
 *
 * `/ssh\s+.*docker\s+(compose|stack)/i` matches that WHOLE string. Split on the
 * quoted `&&` it becomes `ssh prod "cd /srv` and `docker compose up -d"`, and
 * NEITHER half matches any prod pattern — the first has no docker, the second
 * has no ssh and no `prod`. Measured, pre-fix vs post-fix classification:
 *
 *     ssh prod "cd /srv && docker compose up -d"     true -> FALSE
 *     ssh prod "cd /srv; docker compose up -d"       true -> FALSE
 *     ssh -t host "cd /a && docker compose up"       true -> FALSE
 *     ssh prod 'cd /srv && docker compose up -d'     true -> FALSE
 *
 * So a separator can SEVER a pattern whose match spans invocations, and the
 * exposure is specific: only the unbounded `.*` patterns are severable, and of
 * those only the `ssh` one describes a single logical command that legitimately
 * contains a separator. The ssh pattern is also the only prod pattern covering
 * remote deploys at all, which is where a separator ALWAYS appears.
 *
 * Splitting only outside quotes is not a patch for that case — it is what the
 * shell itself does. A separator inside quotes is part of the remote command
 * (one invocation, gate it); a separator outside is a real command boundary
 * (two invocations, judge them apart). Both round-3 and round-4 shapes fall out
 * of that one rule.
 *
 * WHY NOT "re-test the whole command against the ssh pattern, OR'd with the
 * per-segment verdict" — the narrower fix, and it costs a false positive.
 * Measured on the same corpus:
 *
 *     grep ssh /etc/ssh/config && docker compose -f docker-compose.dev.yml up
 *       quote-aware      -> not a deploy   (correct: a read, then a DEV compose)
 *       ssh-whole-OR     -> GATED          (the bare `ssh ` from an argument
 *                                           vouches for an unrelated segment)
 *
 * That re-introduces, on the ssh axis, the same whole-command bleed round-3
 * removed on the SAFE axis.
 *
 * TWO SCOPES, NAMED — because one word doing two jobs is what went wrong.
 *
 * Rounds 3, 4 and 5 each changed what "segment" MEANT and did not re-derive the
 * pattern anchoring against the new meaning. Segment semantics and pattern
 * scope are ONE invariant, and it was edited as two. So the two scopes now have
 * two names, and § PATTERN SCOPE below states which scope every pattern is
 * adjudicated over:
 *
 *   INVOCATION      — `_splitInvocations`, split at UNQUOTED separators. One
 *                     top-level command, INCLUDING any quoted payload it
 *                     carries. This is the scope the `ssh` PROD pattern needs,
 *                     because the payload is where the remote deploy lives.
 *   SUB-INVOCATION  — `_splitSubInvocations`, split at separators REGARDLESS of
 *                     quoting. One command inside that payload. This is the
 *                     scope SAFE must be adjudicated over, because a read
 *                     inside a payload must not vouch for a deploy beside it.
 *
 * DIRECTION OF ERROR, and THE AXIS IT DOES NOT COVER (stated because three of
 * the previous four claims here were false at exactly the unnamed axis).
 *
 * Covered: merging can no longer widen SAFE's reach, because an invocation is
 * vouched only when EVERY one of its sub-invocations is read-only. Splitting can
 * no longer sever a spanning PROD pattern, because PROD is tested at INVOCATION
 * scope, and sub-invocation text is a substring of it (the sub-splitter splits
 * and never strips), so an invocation-scope test subsumes a per-sub one.
 *
 * NOT covered, three named axes:
 *   1. Separators not enumerated here — `$(…)`, backticks, `;;`, process
 *      substitution. A payload joined by one of those stays a SINGLE
 *      sub-invocation, so an unanchored SAFE span can vouch for it.
 *   2. The five `docker.*` SAFE patterns still match a SPAN, not a command
 *      position. Unanimity bounds their reach to one sub-invocation and the
 *      SAFE VETO (§ below, loom#1550) stops them vouching for a sub-invocation
 *      that carries a mutating verb — but neither makes them command-anchored,
 *      and a verb reached through expansion (`… logs $VERB`) is not a literal
 *      token the veto can see.
 *   3. SAFE patterns are matched, not parsed, so one could fire from an
 *      ARGUMENT (`--label docker.logs=1`). Anchoring them was measured and
 *      rejected: it breaks `ssh prod "docker compose logs -f api"`, a legitimate
 *      remote read, which then gates on the ssh PROD pattern.
 */
/**
 * ONE model of shell quoting, annotated per character — the single scanner that
 * BOTH `_splitInvocations` and the `--skip-staging` argv check read (loom#1551).
 *
 * WHY THIS IS A SHARED FUNCTION AND NOT TWO LOOPS. `security.md`
 * § Enforcement-Surface Parity: `--skip-staging` DISABLES this gate, so the
 * question "is this text quoted?" is now asked at two surfaces. Two independent
 * quote scanners are two notions of quoting that drift, and a drift in the
 * permissive direction here is a SILENT ALLOW of an unstaged production deploy.
 * `_splitInvocations` was rewritten to consume these cells rather than re-scan,
 * so there is exactly one place where this file decides what "quoted" means.
 *
 * Each cell is 1:1 with a character of the input, in order, so `cells[j + 1]`
 * is `s[i + 1]` — the two-character `&&` / `||` lookahead is unchanged by the
 * refactor. THREE flags:
 *
 *   bare   — the character sits OUTSIDE any quoted span.
 *   inert  — the character cannot ACT: it is a quote delimiter, a backslash, or
 *            the character a backslash escaped. An inert character is still
 *            appended to the reconstructed text; it just never counts as a
 *            separator or a token boundary.
 *   drop   — the character is quoting SYNTAX, not content: an opening or
 *            closing quote, or a backslash that escapes the next character.
 *            Reconstructing a token from the `!drop` cells yields the argv word
 *            the shell would build, which is what the verb ALLOWLIST is
 *            adjudicated over (§ THE READ-ONLY ALLOWLIST). Without it `"up"`,
 *            `u"p"`, `up""` and `\up` are four different strings to a matcher
 *            and ONE argument to bash — the loom#1550 round-6 quoting class.
 *
 * `$'…'` (ANSI-C quoting) IS handled, and its handling is load-bearing. Bash
 * treats `\'` INSIDE that form as an escaped quote; a plain single-quote scan
 * closes the span at it, and the REMAINDER of a quoted string then reads as
 * BARE argv. That is exactly how `$'don\'t --skip-staging on friday'` fired the
 * escape hatch on text the shell never passed as an argument of its own.
 * `$"…"` needs no case: `$` is an ordinary bare character and the `"` that
 * follows opens a normal double-quoted span, which is already correct.
 */
function _scanCells(command) {
  const s = String(command);
  const cells = [];
  let quote = null; // "'" or '"' when inside a quoted span
  let ansiC = false; // the span was opened by `$'`, so backslash escapes
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote === null) {
      // ANSI-C quoting opens on the TWO characters `$'`, never a bare `$`.
      if (ch === "$" && s[i + 1] === "'") {
        cells.push({ ch, bare: false, inert: true, drop: true });
        cells.push({ ch: "'", bare: false, inert: true, drop: true });
        quote = "'";
        ansiC = true;
        i += 1;
        continue;
      }
      // Outside quotes: a backslash escapes the next character, so an escaped
      // separator is NOT a command boundary.
      if (ch === "\\") {
        cells.push({ ch, bare: true, inert: true, drop: true });
        if (s[i + 1] !== undefined) {
          cells.push({ ch: s[i + 1], bare: true, inert: true, drop: false });
        }
        i += 1;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        ansiC = false;
        cells.push({ ch, bare: false, inert: true, drop: true });
        continue;
      }
      cells.push({ ch, bare: true, inert: false, drop: false });
      continue;
    }
    // Inside quotes. Backslash escapes within DOUBLE quotes and within `$'…'`;
    // inside a PLAIN single-quoted span POSIX treats it literally, so a `\'`
    // there does not continue the span.
    if ((quote === '"' || ansiC) && ch === "\\") {
      cells.push({ ch, bare: false, inert: true, drop: true });
      if (s[i + 1] !== undefined) {
        cells.push({ ch: s[i + 1], bare: false, inert: true, drop: false });
      }
      i += 1;
      continue;
    }
    if (ch === quote) {
      quote = null;
      ansiC = false;
      cells.push({ ch, bare: false, inert: true, drop: true });
      continue;
    }
    cells.push({ ch, bare: false, inert: true, drop: false });
  }
  return cells;
}

/**
 * THE ONE ARGV MODEL (loom#1587). Every token of `text` the shell would
 * actually hand to a program, quote-STRIPPED, each tagged `bare`.
 *
 * Reads the SAME cells `_splitInvocations` does, so this file still has exactly
 * one notion of quoting — and now exactly one notion of "reachable as argv"
 * too. THAT UNIFICATION IS THE loom#1587 FIX. Round 6 taught this reachability
 * model to `_hasBareToken` ALONE, so the escape-hatch check knew a `#` comment
 * is not an argument while verb derivation and the target claim did not. A
 * comment could therefore no longer carry `--skip-staging`, yet could still
 * carry the filename that vouched for a production deploy:
 *
 *     docker restart api   # docker-compose.dev.yml        -> exit 0
 *
 * One model, read by all three surfaces, closes that seam everywhere at once
 * rather than one regex at a time.
 *
 * FOUR deliberate properties:
 *
 *   1. STRIPPED — `"up"`, `u"p"`, `up""` and `\up` all yield the token `up`,
 *      because the shell hands all four to the program as `up`. A veto that
 *      matched raw text saw four different strings and vouched for three of
 *      them. This is why `_scanCells` grew a `drop` flag rather than a second
 *      scanner being written beside it.
 *   2. SPLIT ON ALL WHITESPACE, quoted or not. Within one SUB-invocation the
 *      quoted payload of `ssh prod "docker compose logs -f api"` must be
 *      tokenised or `docker` never appears as a token at all and the command
 *      cannot be classified. Finer splitting only ever REVEALS tokens, so the
 *      token vetoes see more, never less. The cost is that a quoted argument
 *      containing whitespace splits into fragments, which can push verb
 *      derivation onto the wrong token — that direction is over-blocking, the
 *      fail-closed one.
 *   3. NOT ARGV AT ALL, so DROPPED — `#` comments (bash passes nothing after
 *      one) and command-substitution bodies (`$(…)`, `<(…)`, `>(…)`, backticks,
 *      which expand to their OUTPUT, not their text). Dropping a substitution
 *      body loses nothing: `_extractSubstitutions` re-adjudicates every body as
 *      its own invocation, and the raw-text `/docker/i` guard in `subIsVouched`
 *      keeps a sub whose body mentions docker from vouching on its wrapper.
 *   4. `bare` — the token carried NO quoting, escaping or substitution
 *      anywhere. Only a bare token may be the `--skip-staging` escape hatch.
 *      A fragment split OUT of a quoted span is never bare: every character
 *      inside the span, and both delimiters, are non-bare cells.
 */
function _argvTokenCells(text) {
  const cells = _scanCells(text);
  const tokens = [];
  let cur = "";
  let bareOnly = true;
  let wordStart = true;
  const flush = () => {
    if (cur.length > 0) tokens.push({ text: cur, bare: bareOnly });
    cur = "";
    bareOnly = true;
  };
  for (let i = 0; i < cells.length; i += 1) {
    const c = cells[i];
    if (c.bare && !c.inert) {
      // A `#` at word start begins a comment: bash passes NOTHING after it.
      if (c.ch === "#" && wordStart) {
        flush();
        while (
          i < cells.length &&
          !(cells[i].bare && !cells[i].inert && cells[i].ch === "\n")
        ) {
          i += 1;
        }
        wordStart = true;
        continue;
      }
      const next = cells[i + 1];
      const two = c.ch + (next ? next.ch : "");
      if (two === "$(" || two === "<(" || two === ">(") {
        i = _skipSubstitution(cells, i + 2, ")");
        bareOnly = false;
        wordStart = false;
        continue;
      }
      if (c.ch === "`") {
        i = _skipSubstitution(cells, i + 1, "`");
        bareOnly = false;
        wordStart = false;
        continue;
      }
      if (/\s/.test(c.ch)) {
        flush();
        wordStart = true;
        continue;
      }
      wordStart = false;
      cur += c.ch;
      continue;
    }
    // Quoted, escaped, or escape syntax. Content is kept (minus `drop` syntax),
    // but ANY of it disqualifies the token from counting as a BARE hatch.
    wordStart = false;
    if (!c.drop && /\s/.test(c.ch)) {
      // Property 2: split here too, but the fragments stay non-bare — they sit
      // inside a quoted span, so their own characters are non-bare cells.
      bareOnly = false;
      flush();
      bareOnly = false;
      continue;
    }
    bareOnly = false;
    if (!c.drop) cur += c.ch;
  }
  flush();
  return tokens;
}

/** The argv words of `text`, quote-stripped (§ `_argvTokenCells`). */
function _argvTokens(text) {
  return _argvTokenCells(text).map((t) => t.text);
}

/*
 * ── THE READ-ONLY ALLOWLIST (loom#1550 round 6) — POLARITY IS THE FIX ────────
 *
 * Round 5 shipped a DENYLIST: 21 mutating verbs that, when present, removed a
 * SAFE vouch. It closed every shape loom#1550 reported and left the CLASS open,
 * because the PROD pattern that catches these commands
 *
 *     /docker.*compose.*-f.*docker-compose\.prod/i
 *
 * requires NO VERB AT ALL. Coverage was therefore exactly {21 verbs} ∪ ¬SAFE:
 * any compose subcommand outside the 21 was waved through the moment any SAFE
 * substring appeared anywhere in the command. Measured on the shipped denylist,
 * against a positive control returning 2 on the same build:
 *
 *     docker compose -f docker-compose.prod.yml --profile logs watch   -> 0
 *     docker compose -f docker-compose.prod.yml watch apps             -> 0
 *
 * The second needs no adversary and no `--profile`: `ps` inside the SERVICE
 * NAME `apps` supplies the SAFE vouch. And `watch` is not exotic — it is a
 * shipped `docker compose` subcommand that syncs local files into running
 * containers, i.e. a deploy. EVERY VERB DOCKER SHIPS IN FUTURE IS A BYPASS BY
 * DEFAULT under a denylist, which is the wrong polarity for a fail-closed gate.
 *
 * INVERTED: a docker invocation may be vouched read-only ONLY IF the verb it
 * actually runs is on the allowlist below. `watch`, and every verb Docker has
 * not shipped yet, is not on it, so it cannot be vouched — no edit required.
 *
 * THE DENYLIST IS KEPT AS A SECOND CONJUNCT, not replaced. The two close
 * different holes and neither subsumes the other: the allowlist closes the
 * unknown-VERB class, the denylist closes PART of the unknown-FLAG class. If an
 * unrecognised value-taking flag shifts verb derivation onto its own value
 * (`docker compose --unknownflag logs -f prod.yml up -d` derives `logs`), the
 * allowlist alone would vouch — and the bare `up` token trips the denylist.
 *
 * "PART OF" IS ROUND 7, AND THE PREVIOUS SENTENCE OVERSTATED IT. The denylist
 * catches an unknown-flag shift only when the real verb is one of the 21 tokens
 * below. It is not, when the verb is outside them:
 *
 *   docker compose --unknownflag ps -f docker-compose.prod.yml watch   -> 0
 *
 * — derivation lands on `ps`, `watch` is on no denylist, and the sub vouches.
 * SCOPED HONESTLY: this needs a value-taking flag Docker has not shipped, and
 * it measures 0 at merge-base too, so it is not a regression and is NOT fixed
 * here. It is recorded because the claim above was written as though the two
 * conjuncts together were complete, and they are not.
 *
 * READ_ONLY_VERBS omits `exec` deliberately. `docker exec` runs an arbitrary
 * command inside a container and can mutate anything, so it is not read-only;
 * it was SAFE under the old `/docker\s+exec/i` pattern only because that pattern
 * predates any verb model. Measured cost of dropping it: NONE — no PROD pattern
 * matches a bare `docker exec`, so `docker exec api sh -c 'echo hi'` still
 * exits 0 (1471-R3-F2b), and `docker compose -f …prod.yml exec api ./deploy.sh`
 * blocked before this change and blocks after it.
 */
const READ_ONLY_VERBS = new Set([
  "config",
  "diff",
  "events",
  "history",
  "images",
  "info",
  "inspect",
  "logs",
  "ls",
  "port",
  "ps",
  "search",
  "stats",
  "top",
  "version",
  "wait",
]);

/*
 * The round-5 denylist, now a TOKEN set rather than a regex over raw text.
 * Token equality is what `(^|\s)…(\s|$)` was approximating, and it approximated
 * it on text the shell had not unquoted yet — so `"up"` was not the verb `up`.
 * As whole quote-stripped tokens, `db-up`, `status=up` and
 * `deploy/scripts/stage.sh` are still not the verbs `up` / `deploy`.
 */
const MUTATING_VERB_TOKENS = new Set([
  "up",
  "down",
  "start",
  "stop",
  "restart",
  "kill",
  "rm",
  "rmi",
  "create",
  "build",
  "deploy",
  "run",
  "cp",
  "scale",
  "pause",
  "unpause",
  "pull",
  "push",
  "prune",
  "commit",
  "update",
]);

/*
 * Docker MANAGEMENT COMMANDS — a group, not a verb. `docker compose up`,
 * `docker stack deploy`, `docker image ls`: the verb is the token AFTER the
 * group. Consumed exactly ONE level deep, which is all Docker's CLI nests, and
 * the reason `docker compose config` derives the verb `config` rather than
 * walking past it into the service name.
 */
const DOCKER_GROUPS = new Set([
  "builder",
  "buildx",
  "checkpoint",
  "compose",
  "config",
  "container",
  "context",
  "image",
  "manifest",
  "network",
  "node",
  "plugin",
  "secret",
  "service",
  "stack",
  "swarm",
  "system",
  "trust",
  "volume",
]);

/*
 * Flags whose NEXT token is a VALUE, not the verb. `-f docker-compose.prod.yml`
 * and `--profile logs` are the two that matter most: without them derivation
 * lands on `docker-compose.prod.yml` (harmless — not read-only, so it blocks)
 * and on `logs` (NOT harmless — it is read-only, so it vouches, and that IS
 * loom#1550's reported shape).
 *
 * An unlisted value-taking flag makes derivation land on its value, which is
 * almost never an allowlisted verb, so the sub is not vouched and the command
 * BLOCKS. Being wrong here over-blocks; the `=`-joined form needs no entry.
 */
const VALUE_FLAGS = new Set([
  "-c",
  "--compose-file",
  "--config",
  "--context",
  "-f",
  "--file",
  "-h",
  "--host",
  "-l",
  "--log-level",
  "--orchestrator",
  "-p",
  "--project-name",
  "--project-directory",
  "--profile",
  "--env-file",
  "--ansi",
  "--parallel",
  "--progress",
  "--tlscacert",
  "--tlscert",
  "--tlskey",
]);

/*
 * The subset of VALUE_FLAGS naming a COMPOSE FILE. Separated from VALUE_FLAGS
 * because the two answer different questions: VALUE_FLAGS is "does the next
 * token stop being the verb", this is "which files does this command read".
 */
const COMPOSE_FILE_FLAGS = new Set(["-c", "--compose-file", "-f", "--file"]);

/*
 * The subset of VALUE_FLAGS that REDIRECTS docker at a different daemon
 * (loom#1587). `--context` selects a named endpoint, `-H`/`--host` a raw one,
 * `--config` a client-config directory that can carry a `currentContext`. Note
 * `-h` is the lowercased spelling of `-H`; flags are compared case-folded.
 */
const DAEMON_REDIRECT_FLAGS = new Set([
  "--config",
  "--context",
  "-h",
  "--host",
]);

/*
 * ssh flags whose NEXT token is a VALUE, so `_commandTokens` does not mistake
 * one for the HOST. Being wrong here consumes one token too many or too few and
 * lands derivation on a word that is not an allowlisted command, which DENIES
 * the vouch — the fail-closed direction.
 */
const SSH_VALUE_FLAGS = new Set([
  "-b",
  "-c",
  "-d",
  "-e",
  "-f",
  "-i",
  "-j",
  "-l",
  "-m",
  "-o",
  "-p",
  "-q",
  "-r",
  "-s",
  "-w",
]);

/*
 * NON-DOCKER read-only commands, adjudicated POSITIONALLY as the first argv
 * word of a sub-invocation (loom#1587). Round 6 left this axis to three
 * anchored SAFE regexes, and every other utility fell through to "not vouched"
 * — which is why `ssh prod "cd /srv && docker compose ps"` blocked on the ssh
 * PROD pattern: the sub `ssh prod "cd /srv` names `cd`, and `cd` was on no list.
 *
 * EXCLUSIONS ARE THE LOAD-BEARING PART, and they are all one rule: nothing that
 * can EXECUTE another program or WRITE by design. `env`, `xargs`, `find`
 * (`-exec`/`-delete`), `sh`/`bash`, `sudo`, `nohup`, `timeout`, `nice`, `watch`,
 * `awk`, `sed`, `perl` and `python` are each deliberately absent — any of them
 * can carry a deploy as an argument, and a vouch is a claim about what the
 * command DOES.
 *
 * ROUND 7 REMOVED `curl` FROM THIS SET, and the reason is that the rule above
 * was stated correctly and then not applied. `curl` WRITES BY DESIGN — `-X
 * POST|PUT|DELETE`, `-T`, `-d`, `-o`, `-c` — so it never satisfied the sentence
 * two paragraphs up. Measured on the round-6 build, every one exit 0:
 *
 *   ssh prod "curl -X POST http://ci/trigger      && docker compose ps"
 *   ssh prod "curl -T ./app.tar http://srv/upload && docker compose ps"
 *   ssh prod "curl -X DELETE http://api/v1/prod/db && docker compose ps"
 *
 * Deleting it outright would take the ordinary remote health check with it
 * (`curl -sf http://localhost/health`), which is the over-block this file
 * rejects, so `curl` moved to an ARGUMENT MODEL instead (§
 * `_argumentsAreReadOnly`) — vouched only when every flag it carries is on a
 * read-only allowlist. Membership of THIS set is now the first of two
 * conjuncts, not the whole test.
 */
const READ_ONLY_COMMANDS = new Set([
  "cat",
  "cd",
  "curl",
  "cut",
  "date",
  "df",
  "du",
  "echo",
  "egrep",
  "false",
  "fgrep",
  "file",
  "free",
  "grep",
  "head",
  "hostname",
  "id",
  "less",
  "ls",
  "more",
  "printenv",
  "ps",
  "pwd",
  "sort",
  "stat",
  "tail",
  "top",
  "tr",
  "true",
  "uname",
  "uniq",
  "uptime",
  "wc",
  "whoami",
]);

/*
 * curl flags that keep it a READ (loom#1587 round 7) — an ALLOWLIST, for the
 * same reason READ_ONLY_VERBS is one: curl's writing surface is large, actively
 * grows, and a denylist of it would be a bypass by default on every flag curl
 * ships next. Short options are expanded from their CLUSTER (`-sfL` is `-s -f
 * -L`) because that is how curl reads them, and the cluster is exactly where a
 * writer hides: `-sfo out.txt` is `-s -f -o out.txt`, and `o` is not below.
 *
 * DELIBERATELY ABSENT, each a writer: `-o`/`--output`, `-O`/`--remote-name`,
 * `-T`/`--upload-file`, `-d`/`--data*`, `-F`/`--form`, `-X`/`--request`,
 * `-c`/`--cookie-jar`, `-D`/`--dump-header`, `-J`, `--stderr`, `--trace*`,
 * `-Q`/`--quote` (FTP commands — it can DELETE), and `-K`/`--config`, which
 * reads a file that may carry any of the others.
 *
 * `-X GET` is absent too. It is read-only in fact and redundant in practice, and
 * admitting `-X` at all would mean parsing its VALUE — a second model of what a
 * method does, for a flag nobody needs. Fail closed; `--skip-staging` recovers.
 */
const CURL_READ_ONLY_SHORT = new Set([
  "4",
  "6",
  "A",
  "H",
  "I",
  "L",
  "N",
  "S",
  "U",
  "V",
  "Y",
  "b",
  "e",
  "f",
  "g",
  "h",
  "i",
  "k",
  "m",
  "p",
  "q",
  "r",
  "s",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
  "#",
]);
const CURL_READ_ONLY_LONG = new Set([
  "--anyauth",
  "--basic",
  "--cacert",
  "--capath",
  "--cert",
  "--compressed",
  "--connect-timeout",
  "--digest",
  "--disable",
  "--fail",
  "--fail-early",
  "--globoff",
  "--head",
  "--header",
  "--help",
  "--http1.1",
  "--http2",
  "--include",
  "--insecure",
  "--interface",
  "--ipv4",
  "--ipv6",
  "--key",
  "--location",
  "--location-trusted",
  "--max-time",
  "--negotiate",
  "--netrc",
  "--netrc-file",
  "--no-buffer",
  "--no-progress-meter",
  "--ntlm",
  "--oauth2-bearer",
  "--parallel",
  "--proxy",
  "--proxy-user",
  "--range",
  "--referer",
  "--resolve",
  "--retry",
  "--retry-delay",
  "--retry-max-time",
  "--show-error",
  "--silent",
  "--speed-limit",
  "--speed-time",
  "--time-cond",
  "--tlsv1.2",
  "--url",
  "--user",
  "--user-agent",
  "--verbose",
  "--version",
  "--write-out",
]);

/**
 * The flag NAMES `args` carries — short CLUSTERS EXPANDED, and an ATTACHED
 * VALUE expanded with them (loom#1587 round 8).
 *
 * ROUND 7 WROTE THIS EXPANSION FOR `curl` ONLY, and stated the reason in the
 * `CURL_READ_ONLY_SHORT` header: "the cluster is exactly where a writer hides".
 * That reasoning was never carried across to the four siblings in the switch
 * below, which compared WHOLE TOKENS against `-o` / `-s` — so a writer hid in
 * the very place the file had already named. Measured against the round-7
 * predicate:
 *
 *   ["-o","--output"].includes("-o/etc/nginx/nginx.conf")   -> false
 *
 * `sort -o/path` therefore vouched as read-only while `sort -o /path` correctly
 * did not: the SAME write, allowed or blocked by a space. `less -o/tmp/log` and
 * `hostname -Fname` are the same shape. `date -s12:00` is worse — it also
 * leaves `operands` EMPTY, and `[].every(…)` is `true`, so BOTH conjuncts of
 * the `date` arm vouched for a command that sets the system clock.
 *
 * ONE HELPER, FOUR SITES PLUS `curl` (`security.md` § Enforcement-Surface
 * Parity: fixing one surface of a class means sweeping the siblings in the same
 * change — the file's own history here is that the class was named and then
 * applied to one member).
 *
 * A SINGLE-DASH TOKEN IS A CLUSTER, INCLUDING ITS VALUE. `-sfo out.txt` is
 * `-s -f -o`, and `-o/etc/passwd` is `-o` with the value attached — so every
 * character after the dash is emitted as its own `-<ch>`. That over-generates
 * (`-o/etc/x` also yields `-/`, `-e`, `-t`, `-c`, `-x`), and over-generation is
 * the fail-CLOSED direction here: an extra name can only make a writer-flag
 * test fire, never suppress one. A long `--flag=value` keeps round 7's
 * behaviour — the name is everything left of the `=`.
 */
function _flagNames(args) {
  const out = [];
  for (const a of args) {
    if (!a.startsWith("-") || a === "-" || a === "--") continue;
    const body = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (body.startsWith("--")) {
      out.push(body);
      continue;
    }
    for (const ch of body.slice(1)) out.push(`-${ch}`);
  }
  return out;
}

/**
 * Do `args` leave `cmd` read-only? (loom#1587 round 7.)
 *
 * MEMBERSHIP OF `READ_ONLY_COMMANDS` IS A CLAIM ABOUT THE PROGRAM; THIS IS THE
 * CLAIM ABOUT THE INVOCATION. Round 6 made only the first and vouched on it,
 * so a listed command WRITING BY DESIGN under a flag was waved through. `curl`
 * is the reported instance; it is not the only one, and the four below were
 * swept in the same change rather than left for the next round, because they
 * are one class (`security.md` § Enforcement-Surface Parity):
 *
 *   sort -o FILE / --output=FILE   writes FILE
 *   uniq INPUT OUTPUT              writes the SECOND operand
 *   less -o / -O / --log-file      writes an input log
 *   date -s / --set, and a bare
 *     operand on BSD `date`        sets the system clock
 *   hostname NAME / -F FILE        sets the hostname
 *
 * Every other member of `READ_ONLY_COMMANDS` returns `true` here by default,
 * which is the honest statement of scope: this models the write surfaces that
 * were FOUND, not a proof that none remain. The default is the permissive
 * direction on purpose — a command with an unmodelled write flag is a bypass
 * of exactly the shape above, and naming that is better than implying the sweep
 * was exhaustive.
 */
function _argumentsAreReadOnly(cmd, args) {
  const isFlag = (a) => a.startsWith("-") && a !== "-" && a !== "--";
  // Round 8: cluster-expanded, so an ATTACHED value cannot hide a writer
  // (§ `_flagNames`). `curl` read this expansion privately; now all five do.
  const flags = _flagNames(args);
  const operands = args.filter((a) => !isFlag(a));
  const hasFlag = (...names) => flags.some((f) => names.includes(f));
  switch (cmd) {
    case "curl":
      // Long flags stand alone; a short name is ONE letter of an expanded
      // cluster, so the per-letter test is now a lookup rather than a re-split.
      return flags.every((f) =>
        f.startsWith("--")
          ? CURL_READ_ONLY_LONG.has(f.toLowerCase())
          : CURL_READ_ONLY_SHORT.has(f.slice(1)),
      );
    case "sort":
      return !hasFlag("-o", "--output");
    case "less":
      return !hasFlag("-o", "-O", "--log-file");
    case "uniq":
      return operands.length <= 1;
    case "hostname":
      // `-F FILE` / `--file FILE` SETS the hostname from a file, and with the
      // value attached (`-Fname`) it leaves no operand for the count to see.
      return operands.length === 0 && !hasFlag("-F", "--file");
    case "date":
      // `date +%FORMAT` is a read; every other operand is a time to SET.
      return (
        !hasFlag("-s", "--set") && operands.every((o) => o.startsWith("+"))
      );
    default:
      return true;
  }
}

/*
 * git subcommands that vouch. EXACTLY the four the SAFE array already declared
 * (`/^\s*git\s+(pull|log|status|diff)\b/i`) — this is the same claim moved onto
 * the positional model, not a widened one.
 *
 * `pull` is the loom#1587 dead-code finding: it sat in MUTATING_VERB_TOKENS,
 * and that veto ran as an unconditional FIRST conjunct, so the `pull`
 * alternative of the SAFE regex was UNREACHABLE. Measured: adding `git pull` to
 * an otherwise-allowed remote read took it 0 -> 2, while `git log|status|diff`
 * were unchanged. The veto is now scoped to docker subs (§ `subIsVouched`),
 * which is what its own rationale always said it was for — the unknown-FLAG
 * class in docker verb derivation.
 */
const GIT_READ_ONLY_VERBS = new Set(["diff", "log", "pull", "status"]);

/*
 * A basename naming PRODUCTION, as a whole dotted/dashed/underscored component.
 *
 * A BARE SUBSTRING WAS THE OVER-BLOCK (loom#1587): the fence read `/prod/i`
 * over the whole sub-invocation, so `/srv/product/docker-compose.dev.yml` was
 * fenced off its own dev claim by the letters inside `product` and the deploy
 * blocked. Applied to the BASENAME, `product/` in a directory cannot reach it.
 *
 * `(uction)?` is required and is not cosmetic: a component fence alone lets
 * `docker-compose.dev.production.yml` keep a dev claim, and a bare prefix fence
 * re-breaks `product-catalog.dev.yml`. Matching exactly `prod` and `production`
 * as components separates the two.
 */
const PROD_COMPONENT_RE = /(^|[.\-_])prod(uction)?([.\-_]|$)/i;

/*
 * A basename naming a NON-production target — a YAML file carrying a
 * dev/local/staging/test component. Deliberately not anchored to
 * `docker-compose*`: `-f stack.dev.yml` is an ordinary dev deploy and round 6's
 * `/docker.*compose.*dev.*up/i` span accepted it, so requiring the canonical
 * filename here would have been a new over-block.
 */
const NON_PROD_FILE_RE =
  /(^|[.\-_])(dev|development|local|staging|stage|test)([.\-_]|$)/i;
const YAML_FILE_RE = /\.ya?ml$/i;

/** The last path segment of `value` — what a target claim is adjudicated over. */
function _basename(value) {
  const s = String(value);
  return s.slice(s.lastIndexOf("/") + 1);
}

/**
 * The HOST an ENDPOINT value names, with every wrapper the URL grammar puts
 * around it stripped: `scheme://`, `user@` / `user:pass@`, a `/path` tail and a
 * `:port` suffix (loom#1587 round 8).
 *
 * `PROD_COMPONENT_RE` fences on `prod` as a whole dotted/dashed/underscored
 * COMPONENT, and EVERY one of those wrappers puts a character outside that class
 * hard against the word — so the fence answered `false` on the three spellings
 * an endpoint is actually written in. Measured against the live regex:
 *
 *   PROD_COMPONENT_RE.test("production")       -> true    (the fence works…)
 *   PROD_COMPONENT_RE.test("prod:2376")        -> false   (…until a port)
 *   PROD_COMPONENT_RE.test("tcp://prod:2376")  -> false   (…or a scheme)
 *   PROD_COMPONENT_RE.test("deploy@prod")      -> false   (…or a user)
 *
 * So `docker -H tcp://prod:2376 compose -f docker-compose.dev.yml up -d` carried
 * NO production signal at all: `_daemonRedirectValues` read the flag's value
 * correctly, `_prodDaemonRedirect` handed it to the fence, and the fence could
 * not see the word it exists to see. The deploy exited 0 — measured, against
 * `docker --context production …` returning 2 on the same build, which is the
 * SAME command with the endpoint spelled without a port.
 *
 * ORDER IS LOAD-BEARING. Scheme first (its `//` would otherwise read as the path
 * tail), then the LAST `@` (so `user:pass@host`, and a stray `@` in a username,
 * both degenerate to the rightmost authority), then the path, then the port. The
 * port cut takes ANY `:` suffix rather than `:\d+$` — a fence is not the place to
 * decide whether `prod:mirror` names a port, and cutting more can only expose the
 * component to the test, never hide it.
 */
function _endpointHost(value) {
  let s = String(value);
  const scheme = /^[a-z][a-z0-9+.\-]*:\/\//i.exec(s);
  if (scheme) s = s.slice(scheme[0].length);
  s = s.slice(s.lastIndexOf("@") + 1);
  const slash = s.indexOf("/");
  if (slash !== -1) s = s.slice(0, slash);
  const colon = s.indexOf(":");
  if (colon !== -1) s = s.slice(0, colon);
  return s;
}

/**
 * The names `value` can denote, for a fence that must not be evadable by
 * spelling: its PATH TAIL (§ `_basename` — what a compose FILENAME is) and its
 * ENDPOINT HOST (§ `_endpointHost` — what a `-H` / `--context` / `ssh` value is).
 * BOTH, because one token can be either and the fence cannot know which.
 *
 * ADDITIVE BY CONSTRUCTION. The basename is ALWAYS among the returned forms, so
 * no value that tripped a fence before stops tripping it — a caller `some()`s
 * over these, which makes reading this a strict TIGHTENING of every fence that
 * does. That property is why it is safe to apply to a path: `_endpointHost` of
 * `/srv/deploy/docker-compose.prod.yml` truncates at the leading `/` to the empty
 * string, and the basename form carries the verdict.
 *
 * THE INVERSE POLARITY MUST NOT READ THIS. A predicate that GRANTS a claim on a
 * match (§ `_isNonProdHost`) reads `_endpointHost` ALONE — OR-ing two forms there
 * would be two chances to be called non-production, which is fail-OPEN.
 */
function _targetNames(value) {
  const base = _basename(value);
  const host = _endpointHost(value);
  return host === base ? [base] : [base, host];
}

/** Strip shell punctuation a token may carry from `$(`, backticks or `)`. */
function _bareWord(token) {
  return String(token)
    .replace(/^[$(`<>{]+/, "")
    .replace(/[)}`]+$/, "");
}

/**
 * EVERY docker invocation in `tokens`, as `{ group, verb }` — `verb: null` for
 * one whose verb cannot be located. Multiple entries are ordinary: `docker logs
 * "$(docker ps -q)"` names two.
 *
 * `verb: null` is NOT "no docker here" (that is an empty array); it is "there is
 * a docker command and this hook cannot say what it runs", which every caller
 * treats as un-vouchable.
 *
 * `group` is the MANAGEMENT COMMAND (`compose`, `stack`, `service`, …) or
 * `null` for a top-level verb. loom#1587 needs it: the non-production TARGET
 * claim is derivable only for `compose`, whose blast radius is the compose
 * project the `-f` files name. `stack deploy` and `service update` address a
 * SWARM — a cluster the compose file does not name and may well be production.
 */
function _dockerInvocations(tokens) {
  const found = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const word = _bareWord(tokens[i]).toLowerCase();
    const base = word.slice(word.lastIndexOf("/") + 1);
    if (base !== "docker" && base !== "docker-compose") continue;
    let j = i + 1;
    const nextNonFlag = () => {
      while (j < tokens.length) {
        const raw = _bareWord(tokens[j]);
        if (raw.length === 0) {
          j += 1;
          continue;
        }
        if (raw.startsWith("-")) {
          const flag = raw.toLowerCase();
          j += 1;
          if (!flag.includes("=") && VALUE_FLAGS.has(flag)) j += 1;
          continue;
        }
        return raw.toLowerCase();
      }
      return null;
    };
    let group = base === "docker-compose" ? "compose" : null;
    let verb = nextNonFlag();
    // `docker-compose` (the legacy v1 binary) IS the group; `docker` needs the
    // group token consumed first, and only ever one of them.
    if (base === "docker" && verb !== null && DOCKER_GROUPS.has(verb)) {
      group = verb;
      j += 1;
      verb = nextNonFlag();
    }
    found.push({ group, verb });
  }
  return found;
}

/** The verbs of § `_dockerInvocations`, which is the single derivation. */
function _dockerVerbs(tokens) {
  return _dockerInvocations(tokens).map((d) => d.verb);
}

/**
 * The VALUES of the compose-file flags in `tokens`, in order — the files the
 * command actually reads. Positional, over argv words: a filename is only a
 * file when it is the value of `-f` / `--file` / `-c` / `--compose-file`, never
 * because it appeared somewhere in the text (loom#1587).
 *
 * Scanned across ALL tokens rather than only the pre-verb run, because
 * `docker stack deploy -c stack.yml app` puts the flag AFTER its verb.
 *
 * `docker compose logs -f api` makes this over-collect: there `-f` is
 * `--follow` and takes no value, so `api` is read as a file. That direction is
 * safe — an unrecognised "file" fails the non-prod test and DENIES the target
 * claim, which falls through to the read-only verb check that vouches `logs`
 * on its own merits.
 */
function _composeFileValues(tokens) {
  const files = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const raw = _bareWord(tokens[i]);
    const eq = raw.indexOf("=");
    if (eq !== -1) {
      if (COMPOSE_FILE_FLAGS.has(raw.slice(0, eq).toLowerCase())) {
        files.push(raw.slice(eq + 1));
      }
      continue;
    }
    if (!COMPOSE_FILE_FLAGS.has(raw.toLowerCase())) continue;
    const value = _bareWord(tokens[i + 1] || "");
    if (value.length > 0 && !value.startsWith("-")) files.push(value);
    i += 1;
  }
  return files;
}

/**
 * Does `tokens` REDIRECT docker at a different daemon? `--context`, `-H` /
 * `--host` and `--config` all do, and none of them is named by the compose
 * file — so a target claim derived from a FILENAME says nothing about the
 * endpoint the command will actually run against (loom#1587):
 *
 *     docker -H tcp://10.0.0.5:2376 stack deploy -c docker-compose.dev.yml app
 *
 * A redirect therefore DENIES the non-production claim. It does not by itself
 * block: the command still has to fail the read-only verb check and match a
 * PROD pattern, so `docker --context prod compose logs` stays allowed.
 */
function _hasDaemonRedirect(tokens) {
  return tokens.some((t) => {
    const raw = _bareWord(t).toLowerCase();
    const name = raw.includes("=") ? raw.slice(0, raw.indexOf("=")) : raw;
    return DAEMON_REDIRECT_FLAGS.has(name);
  });
}

/**
 * The VALUES of the daemon-redirect flags — the endpoint the command is aimed
 * at, which is the only thing in a remote invocation that names its target.
 */
function _daemonRedirectValues(tokens) {
  const values = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const raw = _bareWord(tokens[i]);
    const eq = raw.indexOf("=");
    if (eq !== -1) {
      if (DAEMON_REDIRECT_FLAGS.has(raw.slice(0, eq).toLowerCase())) {
        values.push(raw.slice(eq + 1));
      }
      continue;
    }
    if (!DAEMON_REDIRECT_FLAGS.has(raw.toLowerCase())) continue;
    const value = _bareWord(tokens[i + 1] || "");
    if (value.length > 0 && !value.startsWith("-")) values.push(value);
    i += 1;
  }
  return values;
}

/**
 * `tokens` with an `ssh <flags> <host>` TRANSPORT PREFIX consumed, so the
 * remainder is the command actually being RUN (loom#1587).
 *
 * `_splitSubInvocations` cuts a remote payload at its separators, so
 * `ssh prod "cd /srv && docker compose ps"` yields the sub `ssh prod "cd /srv`.
 * Its first argv word is `ssh`, and adjudicating THAT is why nine of eleven
 * ordinary remote reads blocked — including `ssh prod "cd /srv && docker
 * compose ps"`, the canonical "go look at production". An allowlist that blocks
 * routine work gets switched off wholesale, taking the protection with it
 * (`hook-output-discipline.md` MUST NOT, last clause).
 *
 * Consuming the prefix does not weaken anything: what follows is adjudicated by
 * the SAME rules a local command is, and unanimity across sub-invocations is
 * unchanged — so a read in the payload still cannot vouch for a deploy beside
 * it.
 */
function _commandTokens(tokens) {
  if (tokens.length === 0) return tokens;
  const first = _bareWord(tokens[0]).toLowerCase();
  if (first.slice(first.lastIndexOf("/") + 1) !== "ssh") return tokens;
  let j = 1;
  while (j < tokens.length) {
    const raw = _bareWord(tokens[j]);
    if (raw.length === 0) {
      j += 1;
      continue;
    }
    if (!raw.startsWith("-")) break;
    const flag = raw.toLowerCase();
    j += 1;
    if (!flag.includes("=") && SSH_VALUE_FLAGS.has(flag)) j += 1;
  }
  return tokens.slice(j + 1); // +1 consumes the HOST
}

/**
 * EVERY `ssh` invocation in `tokens`, as the HOST it addresses — or `null` for
 * one whose host could not be attributed (loom#1587 round 8). Consumes the same
 * flags `_commandTokens` does, so the two agree on where a host sits; they
 * differ only in which side of it they return.
 *
 * `null` IS NOT "no ssh here" (that is an empty array); it is "this sub invokes
 * ssh and this hook cannot say against what" — the same distinction
 * `_dockerInvocations` draws with `verb: null`, and conjunct 5 treats it the
 * same way: un-attributable means the non-production claim is DENIED.
 *
 * ── TWO FAIL-OPEN SEAMS, AND THEY COMPOUND (round 8) ─────────────────────────
 *
 * Round 7 returned a single host and required `ssh` at argv slot 0. Composed
 * with conjunct 5's `hosts.length > 0 &&` short-circuit and the caller's
 * `.filter(h => h !== null)`, the fence read "NO HOST FOUND ⇒ SKIP THE
 * QUESTION" — the opposite of what a fence is for. Either seam alone is enough,
 * and ONE PREFIX TOKEN opens both at once, because `env`/`sudo`/`nohup` are
 * deliberately absent from `READ_ONLY_COMMANDS` yet nothing consults that list
 * before the target claim is adjudicated. Measured on the round-7 build,
 * against `ssh 10.0.0.5 "docker compose -f docker-compose.dev.yml up -d"`
 * returning 2 — the SAME command with the prefix removed:
 *
 *   env ssh 10.0.0.5    "docker compose -f docker-compose.dev.yml up -d"  -> 0
 *   env ssh deploy@prod "docker compose -f docker-compose.dev.yml up -d"  -> 0
 *
 * A dev compose file vouching for a deploy onto an arbitrary machine is exactly
 * the exposure conjunct 5 was added to close; the prefix put it back.
 *
 * SO THE SCAN IS POSITION-INDEPENDENT: any token whose basename is `ssh`, at any
 * slot, starts a host attribution. That over-generates — `ls /etc/ssh` and
 * `grep ssh /etc/ssh/config` both name a "host" that is not demonstrably
 * non-production, so they lose the TARGET claim. Losing it is not a block: such
 * a command still earns its vouch the ordinary way, through
 * `READ_ONLY_COMMANDS` (measured: both still exit 0). Over-generation is the
 * fail-CLOSED direction and `--skip-staging` is the documented recovery.
 */
function _sshHosts(tokens) {
  const hosts = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const word = _bareWord(tokens[i]).toLowerCase();
    if (word.slice(word.lastIndexOf("/") + 1) !== "ssh") continue;
    let j = i + 1;
    while (j < tokens.length) {
      const raw = _bareWord(tokens[j]);
      if (raw.length === 0) {
        j += 1;
        continue;
      }
      if (!raw.startsWith("-")) break;
      const flag = raw.toLowerCase();
      j += 1;
      if (!flag.includes("=") && SSH_VALUE_FLAGS.has(flag)) j += 1;
    }
    const host = _bareWord(tokens[j] || "");
    hosts.push(host.length > 0 ? host : null);
  }
  return hosts;
}

/**
 * Is `host` DEMONSTRABLY non-production? Same component test the compose
 * filename gets (§ `NON_PROD_FILE_RE`), minus the `.yml` requirement, applied to
 * the NORMALISED endpoint. `dev`, `dev-01` and `web-dev.example.com` pass;
 * `10.0.0.5`, `buildbox` and `production-web-01` do not.
 *
 * Round 8 moved this from a hand-rolled `user@` strip onto `_endpointHost`, so
 * this predicate and the production fence read ONE model of what an endpoint
 * value denotes (`security.md` § Enforcement-Surface Parity — two notions of
 * "which host is this" drift, and a drift in the permissive direction here
 * grants a non-production claim to a production machine). The old strip handled
 * `user@` and nothing else, so `ssh://dev-01:22` was not recognised as `dev-01`.
 *
 * THE GRANT SIDE READS `_endpointHost` ALONE, never `_targetNames` — see that
 * function's closing note on polarity.
 */
function _isNonProdHost(host) {
  return NON_PROD_FILE_RE.test(_endpointHost(host));
}

/**
 * `command` with every LINE CONTINUATION removed, exactly as the shell removes
 * it — a backslash that is escape SYNTAX followed by the newline it escapes
 * (loom#1587 round 8). Read the same cells everything else here reads, so a
 * `\<newline>` inside PLAIN SINGLE QUOTES — where POSIX keeps the backslash
 * literal — is correctly left alone (`_scanCells` marks it content, not syntax).
 *
 * WHY THIS AND NOT THE `s` REGEX FLAG ALONE. Both were measured; only this one
 * is free of a false positive.
 *
 * A continued command is ONE command, and `_splitInvocations` already treats it
 * as one (the `\` marks itself and the newline inert, so the newline is not a
 * boundary). But TWO things then read the surviving newline as a boundary
 * anyway: JS `.` does not cross it, so every unanchored PROD span could only
 * match within a single LINE; and `_splitSubInvocations` splits on `\n`
 * unconditionally, so the command is shredded into fragments with no derivable
 * verb. Measured on the round-7 build, against the identical one-line command:
 *
 *   docker compose \ / -f \ / docker-compose.prod.yml \ / up -d     -> 0   BYPASS
 *
 * Adding `s` to the PROD patterns closes that. It does NOT close the second
 * half, and the second half is a FALSE POSITIVE — the shredded fragments cannot
 * be vouched either, so with `s` alone the READ blocks too. Measured, pre-fix
 * vs `s`-only:
 *
 *   docker compose \ / -f \ / docker-compose.prod.yml \ / logs     0 -> 2  REGRESSION
 *   docker compose \ / -f docker-compose.prod.yml \ / config       0 -> 2  REGRESSION
 *
 * Those two are rows C1/C2 of this gate's own must-allow set, written across
 * continuations — the loom#1550 false-positive class the file exists to avoid
 * re-creating. Joining the continuation first fixes BOTH halves at the source:
 * the PROD spans see one line, AND verb derivation sees `logs`, so the read is
 * vouched exactly as its one-line spelling is.
 *
 * THE `s` FLAGS ARE KEPT, AND THEY ARE LOAD-BEARING ON A DIFFERENT SHAPE —
 * measured, not assumed. Joining handles a BACKSLASH continuation; a newline
 * inside QUOTES survives into the invocation by design (it is one command), and
 * there only a newline-crossing `.` can match. Isolating that needs a shape
 * where no single LINE carries a whole pattern — an `ssh` on one line and the
 * `docker compose` on the next, with no `prod` text and no `-f` for a sibling
 * pattern to catch. Measured, live build vs the same build with the `s` flags
 * stripped and continuations still joined:
 *
 *   ssh 10.0.0.5 "cd /srv<newline>docker compose up -d"    2 -> 0   BYPASS
 *
 * (0 at merge-base too, so that one is a pre-existing hole this closes rather
 * than a regression guard.) The first probe written for this claim was NOT
 * discriminating — it put `ssh … "docker compose` on one line, where the ssh
 * pattern matches without crossing anything, and it returned 2 on every build
 * including pre-fix. Two mechanisms, two newline origins; neither subsumes the
 * other, and the redundant-looking one was confirmed by refutation, not by
 * reading a green.
 *
 * REMOVED, NOT REPLACED WITH A SPACE, because that is what bash does: `doc\<nl>ker`
 * is the single word `docker`. Substituting a space would split a token the
 * shell joins, and a token boundary this file invents is a token boundary the
 * verb allowlist adjudicates over.
 */
function _joinContinuations(command) {
  const cells = _scanCells(command);
  let out = "";
  for (let i = 0; i < cells.length; i += 1) {
    const c = cells[i];
    const next = cells[i + 1];
    if (
      c.ch === "\\" &&
      c.drop &&
      c.inert &&
      next &&
      next.ch === "\n" &&
      next.inert
    ) {
      i += 1; // drop the backslash AND the newline it escaped
      continue;
    }
    out += c.ch;
  }
  return out;
}

function _splitInvocations(command) {
  const cells = _scanCells(command);
  const out = [];
  let cur = "";
  for (let j = 0; j < cells.length; j += 1) {
    const { ch, bare, inert } = cells[j];
    if (bare && !inert) {
      if (ch === "\n" || ch === ";") {
        out.push(cur);
        cur = "";
        continue;
      }
      const next = cells[j + 1];
      if (
        (ch === "&" && next && next.ch === "&") ||
        (ch === "|" && next && next.ch === "|")
      ) {
        out.push(cur);
        cur = "";
        j += 1;
        continue;
      }
      // A lone `|` (pipe) or `&` (background) is also a command boundary. `&`
      // was missing until round 5: `docker ps & docker compose … prod … up -d`
      // stayed one invocation, and `/docker.*ps/i` vouched for the deploy.
      if (ch === "|" || ch === "&") {
        out.push(cur);
        cur = "";
        continue;
      }
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x.length > 0);
}

/**
 * Index of the character that CLOSES a substitution opened just before
 * `start` — counting only characters the shell would ACT on (bare, non-inert),
 * so a `)` inside a quoted argument does not close the body early. Returns
 * `cells.length` when no closer is found, i.e. "the rest of the input".
 */
function _skipSubstitution(cells, start, closer) {
  let depth = 1;
  for (let i = start; i < cells.length; i += 1) {
    const c = cells[i];
    if (!c.bare || c.inert) continue;
    if (closer === "`") {
      if (c.ch === "`") return i;
      continue;
    }
    if (c.ch === "(") depth += 1;
    else if (c.ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return cells.length;
}

/**
 * Does `token` appear in `text` as a BARE argv token — whitespace-delimited,
 * with no quoting anywhere in it, and REACHABLE AS ARGV (loom#1551)?
 *
 * Reads the SAME cells `_splitInvocations` does, so "quoted" means one thing in
 * this file. STRICTER THAN BASH ON PURPOSE: bash would hand `"--skip-staging"`,
 * `--skip'-staging'` and `\-\-skip-staging` to the program as the argument
 * `--skip-staging`, and this returns false for all three. The asymmetry is
 * deliberate — a false negative costs the operator one pair of quotes and a
 * loud, actionable block; a false positive silently disables the staging gate,
 * which is the entire defect loom#1551 reports. Erring toward "not an escape
 * hatch" is the fail-closed direction.
 *
 * TWO SPANS ARE NOT ARGV AT ALL, and skipping them is loom#1550 round 6:
 *
 *   COMMENTS. `… up -d   # --skip-staging not used here` — the `#` begins a
 *   comment, so bash passes NOTHING after it. Pre-fix the hook read the comment
 *   as argv and DISABLED the staging gate on the strength of a sentence saying
 *   the operator was not skipping staging. That is loom#1551's own reported
 *   shape, one layer down.
 *
 *   SUBSTITUTION BODIES. `… up -d $(: --skip-staging )` runs `:` with that
 *   argument and expands to the EMPTY STRING, so again nothing reaches argv.
 *
 * Both are DROPPED rather than parsed, and the direction is what makes that
 * safe: dropping text can only make the hatch LESS likely to fire, and a hatch
 * that does not fire is a BLOCK. Over-dropping costs a block the operator can
 * clear by moving the flag; under-dropping is a silent unstaged prod deploy.
 * For the same reason an unterminated substitution drops to end of input, and
 * a token that CONTAINS a substitution can never be the hatch — the hook cannot
 * know what that token will expand to.
 *
 * loom#1587: the comment/substitution reachability model this function used to
 * own privately now lives in `_argvTokenCells`, so the target claim and verb
 * derivation read it too. This is a lookup over that shared model, not a second
 * scanner — which is the whole point (§ `_argvTokenCells`).
 */
function _hasBareToken(text, token) {
  return _argvTokenCells(text).some((t) => t.bare && t.text === token);
}

/*
 * Redirect targets that write NOTHING — the discards and the file-descriptor
 * dups. Everything else names a FILE, and `>` truncates it.
 */
const BENIGN_REDIRECT_TARGET_RE =
  /^(&\d+|&-|\/dev\/(null|stdout|stderr|tty|fd\/\d+))$/;

/**
 * `text` with an UNTERMINATED quote's opener removed, so the span it opened
 * reads as ordinary shell text.
 *
 * A sub-invocation is cut out of its invocation at separators REGARDLESS of
 * quoting (§ `_splitSubInvocations`), so the halves of `ssh prod "a > f && b"`
 * arrive here holding one quote character each and nothing to match it. That
 * unbalance is the SIGNAL: an unmatched quote in a sub is a transport-payload
 * delimiter, and the text it appears to quote is a command the REMOTE shell
 * will interpret — `>` included. Dropping the orphan opener is the same
 * departure from strict quoting `_splitSubInvocations` already makes, made for
 * the same reason and confined to the same scope.
 *
 * A BALANCED quote is untouched, so the LOCAL `grep ">" file` is still not a
 * redirect (measured: 0, on merge-base and here).
 *
 * WHAT THIS DOES NOT DO, stated because the obvious reading of the paragraph
 * above is wrong: dropping the orphan opener does NOT re-derive the payload's
 * OWN quoting, so an escaped inner quote inside a remote payload —
 * `ssh prod "grep \">\" /etc/hosts && …"` — presents a bare `>` and is read as
 * a redirect. That over-blocks. It is the fail-closed direction, it is what
 * merge-base 33cbe5bb already did (measured: 2 there, 2 here, 0 on the round-6
 * head), and `--skip-staging` is the recovery — so it is recorded rather than
 * fixed. Re-entrant payload parsing is a larger change than this defect wants.
 */
function _dropUnterminatedQuote(text) {
  const s = String(text);
  let quote = null;
  let openAt = -1;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote === null) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        openAt = i;
      }
      continue;
    }
    if (quote === '"' && ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === quote) {
      quote = null;
      openAt = -1;
    }
  }
  if (openAt === -1) return s;
  return `${s.slice(0, openAt)} ${s.slice(openAt + 1)}`;
}

/**
 * Does `text` REDIRECT OUTPUT INTO A FILE? (loom#1587 round 7.)
 *
 * REDIRECTION IS THE HOLE UNDER THE WHOLE READ-ONLY MODEL, because `>` is
 * SHELL syntax and every layer above reads ARGV. `_argvTokenCells` drops the
 * `>` (it is stripped by `_bareWord`), `_splitSubInvocations` does not cut on
 * it, and nothing else looked — so the vouch was adjudicated over a command
 * with its writing half invisible. Measured on the round-6 build:
 *
 *   ssh prod "echo bad > /etc/nginx/nginx.conf && docker compose ps"   -> 0
 *
 * `echo` is on `READ_ONLY_COMMANDS` and `echo` alone genuinely is read-only.
 * `>` makes EVERY member of that set a writer, which is why this is a guard on
 * the vouch rather than an edit to the list. The sibling
 * `cat /tmp/new.yml > /srv/docker-compose.yml && docker compose ps` blocked on
 * the same build — but only because the literal string `docker` appears in the
 * target path and sends the sub down the docker branch. That is coincidence,
 * not enforcement, and it is why this is stated as a measured hole rather than
 * a hypothetical one.
 *
 * READS CELLS, NOT TEXT, so a `>` inside quotes (`grep ">" file`) is not a
 * redirect. `2>&1` and `2>/dev/null` are dups/discards and stay vouched: they
 * are the reason this tests the TARGET instead of the operator, since blocking
 * every `>` would gate the ordinary `docker compose logs -f api 2>/dev/null`.
 *
 * An UNRECOGNISED target counts as a write — including `>(…)` process
 * substitution, whose target is a command. Fail-closed is the right direction
 * for a gate whose recovery is one documented flag.
 */
function _hasWriteRedirect(text) {
  const cells = _scanCells(_dropUnterminatedQuote(text));
  for (let i = 0; i < cells.length; i += 1) {
    const c = cells[i];
    if (!c.bare || c.inert || c.ch !== ">") continue;
    let j = i + 1;
    // `>>` (append) is the same claim as `>`; consume the second angle.
    if (cells[j] && cells[j].bare && !cells[j].inert && cells[j].ch === ">") {
      j += 1;
    }
    while (cells[j] && !cells[j].drop && /^[ \t]$/.test(cells[j].ch)) j += 1;
    let target = "";
    while (cells[j] && !(!cells[j].drop && /\s/.test(cells[j].ch))) {
      if (!cells[j].drop) target += cells[j].ch;
      j += 1;
    }
    if (!BENIGN_REDIRECT_TARGET_RE.test(target)) return true;
  }
  return false;
}

/**
 * The commands INSIDE one invocation — split at separators regardless of
 * quoting, which is the complement of `_splitInvocations`.
 *
 * SPLITS ONLY, NEVER STRIPS, and that is load-bearing: every sub-invocation is
 * therefore a SUBSTRING of its invocation, which is what makes the PROD test at
 * invocation scope subsume a per-sub-invocation one (all six PROD patterns are
 * unanchored spans). Stripping the quote characters would break that argument
 * and require a second PROD pass.
 *
 * An unterminated quote is handled by construction rather than by a special
 * case: `_splitInvocations` merges everything after it into one invocation, and
 * this function then splits that merged text on the very separators the open
 * quote hid. Round 5's `docker ps " && docker compose … prod … up -d` is that
 * shape — the merge is what made `/docker.*ps/i` reach the deploy, and
 * re-splitting here is what takes it back.
 */
function _splitSubInvocations(invocation) {
  return String(invocation)
    .split(/\|\||&&|;|\||\n|&/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/*
 * ── AN INVOCATION IS NOT A MENTION (loom#1596 adversarial round, F4) ─────────
 *
 * The PROD patterns are `.*`-tolerant spans over raw invocation text. That is
 * what closes the ten wrapper classes (`sh -c`, `eval`, `xargs`, `$(echo
 * docker)` …): a wrapper does not REMOVE the text, so the span still matches.
 * It is also what makes the gate fire on text the shell never executes.
 * Measured on the pre-fix build, against a positive control returning 2:
 *
 *   git commit -m 'fix: docker compose prod up ordering bug'          -> exit 2
 *   gh issue create --title 'docker restart tools-api fails' --body x -> exit 2
 *   grep -rn 'docker compose -f docker-compose.prod.yml up' ./docs    -> exit 2
 *   echo 'to deploy run: docker compose -f … up -d'                   -> exit 2
 *   cat > README.md <<'EOF' … Run: docker compose -f … up -d … EOF    -> exit 2
 *
 * Writing the commit message ABOUT the deploy bug blocked the commit. That is
 * `hook-output-discipline.md` MUST NOT ("detectors that block work the agent
 * has been instructed to perform") by name, and its documented workaround
 * (`--skip-staging`) disables the gate wholesale for that command — so the
 * false positive does not merely annoy, it teaches operators to switch the
 * fence off.
 *
 * THE DISCRIMINATOR IS THE OUTER VERB, READ POSITIONALLY — never a tighter
 * span. `ssh` / `sh -c` / `eval` / `xargs` EXECUTE their quoted payload; `echo`
 * / `grep` / `git commit -m` / `gh --title` CONSUME it as data. The gate never
 * asked which, so it adjudicated both alike. Tightening the regex cannot fix
 * this (the two are byte-identical in the span) — only the parsed head can.
 *
 * FAIL-CLOSED BY CONSTRUCTION: only the ENUMERATED consumers below drop their
 * arguments. An executor keeps everything, and so does an UNKNOWN head — a new
 * or unrecognised program is treated as potentially executing its arguments,
 * which is the direction that preserves every true positive. A data consumer's
 * arguments are dropped WHOLESALE rather than only its quoted cells, because
 * `echo docker restart foo` is no more an invocation than the quoted form is;
 * the command substitution inside `cat "$(docker … up -d)"` is unaffected,
 * since `_extractSubstitutions` re-adjudicates every body as its own
 * invocation (§ `_extractSubstitutions`) — verified, that shape still DENIES.
 */
const EXECUTOR_COMMANDS = new Set([
  "ssh",
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "eval",
  "xargs",
  "env",
  "nohup",
  "time",
  "command",
  "exec",
  "timeout",
  "stdbuf",
  "sudo",
  "doas",
  "setsid",
  "script",
  "watch",
  "flock",
  "chroot",
  "unbuffer",
  "parallel",
  "make",
  "npm",
  "npx",
  "pnpm",
  "yarn",
]);

/*
 * Programs whose arguments are DATA, never a command they will run. `sed` and
 * `awk` are deliberately ABSENT: both carry their own scripting language and
 * `awk 'system("…")'` executes, so they stay on the fail-closed default.
 */
const DATA_CONSUMER_COMMANDS = new Set([
  "echo",
  "printf",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "jq",
  "yq",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "sort",
  "uniq",
  "diff",
  "comm",
  "tr",
]);

/*
 * ── A DISPATCHING HEAD IS NOT A DATA CONSUMER (loom#1601 adversarial round, F5) ──
 *
 * `git` and `gh` shipped as flat members of the set above, so `_prodScanText`
 * replaced their WHOLE segment with the bare head. Neither is a data consumer:
 * both dispatch on a subcommand, and several of those subcommands execute an
 * arbitrary payload. Measured on the pre-fix build, all ALLOW, and a
 * PATH-stubbed `docker` confirmed each really ran the prod deploy:
 *
 *   git submodule foreach 'docker compose -f docker-compose.prod.yml up -d'
 *   git rebase --exec 'docker compose … up -d' HEAD~2
 *   git bisect run ./deploy-prod.sh
 *   git filter-branch --tree-filter 'docker compose … up -d' HEAD~1..HEAD
 *   git difftool --extcmd='docker compose … up -d' HEAD~1 HEAD
 *   git -c alias.dep='!docker compose … up -d' dep
 *   gh codespace ssh -- 'docker compose … up -d'      (hook ALLOW; exec unverified)
 *
 * This is the SAME reasoning that already keeps `sed` and `awk` out of the set
 * (`awk 'system("…")'` executes) — it was simply not applied to `git`/`gh`.
 *
 * THE DISCRIMINATOR IS THE SUBCOMMAND, READ POSITIONALLY, AND IT IS AN
 * ALLOWLIST. Only the enumerated message-bearing subcommands drop their
 * arguments; every other subcommand — and any UNKNOWN one — stays on the
 * fail-closed default. Widening this set is a security decision: a subcommand
 * belongs here only if it cannot be made to execute an argument.
 *
 * A CONFIG-INJECTION GLOBAL FLAG DISQUALIFIES THE WHOLE INVOCATION, whatever
 * the subcommand: `git -c alias.x='!cmd' x`, `git -c core.pager='cmd' log` and
 * `--config-env` / `--exec-path` all reach execution through configuration
 * rather than through the subcommand, so the subcommand allowlist alone cannot
 * see them.
 */
const SUBCOMMAND_DATA_CONSUMERS = new Map([
  // `git commit -m '…'`, `git tag -m '…'`, `git notes add -m '…'` — the F4
  // false positive. None of the three can execute a message argument.
  ["git", new Set(["commit", "tag", "notes"])],
  // `gh issue create --title '…'` — the F4 false positive. `codespace`, `alias`,
  // `extension` and `run` are deliberately ABSENT: each can execute a payload.
  ["gh", new Set(["issue", "pr", "release"])],
  ["glab", new Set(["issue", "mr", "release"])],
]);

/** Global flags that reach execution through CONFIG, whatever the subcommand. */
const _CONFIG_INJECTION_FLAG_RE =
  /^(?:-c|--config-env(?:=.*)?|--exec-path(?:=.*)?)$/;

/**
 * The subcommand a dispatching head resolves to: the first bare token after the
 * head that is neither an assignment nor a flag. Returns `""` when the
 * invocation carries a config-injection global flag, which fails closed.
 */
function _dispatchSubcommand(text) {
  let seenHead = false;
  for (const token of _argvTokens(text)) {
    const bare = _bareWord(token);
    if (bare.length === 0) continue;
    if (_ASSIGN_RE.test(bare)) continue;
    if (!seenHead) {
      seenHead = true;
      continue;
    }
    // Any config-injection flag disqualifies the invocation outright.
    if (_CONFIG_INJECTION_FLAG_RE.test(bare)) return "";
    if (bare.startsWith("-")) continue;
    return bare.toLowerCase();
  }
  return "";
}

/**
 * Whether this segment's arguments are DATA the shell will never run — a flat
 * data consumer, or a dispatching head on an ALLOWLISTED subcommand.
 */
function _isDataConsumerSegment(part, head) {
  if (DATA_CONSUMER_COMMANDS.has(head)) return true;
  const allowed = SUBCOMMAND_DATA_CONSUMERS.get(head);
  if (!allowed) return false;
  const sub = _dispatchSubcommand(part);
  return sub.length > 0 && allowed.has(sub);
}

/** `$IFS` / `${IFS}` word-split back to the space the shell will produce. */
function _normalizeIFS(text) {
  return String(text).replace(/\$\{IFS\}|\$IFS(?![A-Za-z0-9_])/g, " ");
}

/*
 * `$(echo docker) restart tools-api` — a substitution in the COMMAND-NAME slot.
 *
 * `_argvTokenCells` DROPS every substitution body by design (§ its property 3:
 * a body expands to its OUTPUT, not its text), so the parsed predicates below
 * cannot see the `docker` at all — measured, `_dockerVerbs` returns `[]` — and
 * the raw spans miss it too because `docker)` is not `docker` followed by
 * whitespace. Neither layer sees it, which is why this resolves the ONE case
 * whose output is knowable without running anything: `echo`/`printf` of a
 * literal. `$(echo docker)` IS `docker`, so substituting it is faithful
 * resolution, not widening.
 *
 * BOUNDED exactly like the variable resolver: a body containing `$`, a
 * backtick, or nested parens is NOT a literal and is left untouched — so
 * `cat "$(docker compose … up -d)"` is unaffected here and stays closed by
 * `_extractSubstitutions`, which adjudicates that body as its own invocation.
 */
function _resolveTrivialSubstitutions(text) {
  return String(text).replace(
    /\$\(\s*(?:echo|printf)\s+([^()$`]*)\)|`\s*(?:echo|printf)\s+([^()$`]*)`/g,
    (whole, paren, tick) => {
      const body = paren !== undefined ? paren : tick;
      if (body === undefined) return whole;
      return ` ${body.replace(/['"]/g, "").trim()} `;
    },
  );
}

const _ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

/**
 * The program `text` actually RUNS, as a basename — skipping any leading
 * `VAR=value` environment-assignment prefix, which is shell syntax and not the
 * command. Empty when no such word exists.
 */
function _headCommand(text) {
  for (const token of _argvTokens(text)) {
    const bare = _bareWord(token);
    if (bare.length === 0) continue;
    if (_ASSIGN_RE.test(bare)) continue;
    return _basename(bare.toLowerCase());
  }
  return "";
}

/**
 * The text the PROD spans are adjudicated over: `invocation` with every DATA
 * CONSUMER's arguments dropped, separators and every other sub preserved
 * verbatim.
 *
 * Separators are kept (the split captures them) so a span may still cross subs
 * — `ssh prod "cd /srv && docker compose up -d"` splits at `&&`, and only the
 * joined text carries both `ssh` and `docker` for the ssh PROD pattern to see.
 * Dropping the separators, or testing each sub alone, would silently unmake
 * that pattern.
 */
function _prodScanText(invocation) {
  const parts = String(invocation).split(/(\|\||&&|;|\||\n|&)/);
  let out = "";
  for (const part of parts) {
    if (part.length === 0) continue;
    if (/^(?:\|\||&&|;|\||\n|&)$/.test(part) || part.trim().length === 0) {
      out += part;
      continue;
    }
    const head = _headCommand(part);
    if (_isDataConsumerSegment(part, head)) {
      out += ` ${head} `;
      continue;
    }
    out += part;
  }
  return out;
}

/**
 * `command` with the body of every QUOTED-delimiter heredoc aimed at a
 * NON-EXECUTOR blanked.
 *
 * Bash never parses such a body as commands — it is stdin data — so the gate
 * must not either; `cat > README.md <<'EOF' … EOF` documenting a deploy is the
 * measured false positive. TWO fail-closed fences: an UNQUOTED delimiter
 * (`<<EOF`) leaves the body subject to expansion, so a `$(…)` inside it really
 * can execute and the body is KEPT; and a heredoc fed to an executor
 * (`bash <<'EOF'`) is KEPT for the same reason. An unterminated heredoc masks
 * to end-of-command, which is what bash itself does with the remainder.
 */
function _maskHeredocBodies(command) {
  const lines = String(command).split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    out.push(line);
    i += 1;
    const m = line.match(/<<-?\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (!m) continue;
    if (EXECUTOR_COMMANDS.has(_headCommand(line))) continue;
    const delim = m[2];
    while (i < lines.length && lines[i].trim() !== delim) {
      out.push("");
      i += 1;
    }
    if (i < lines.length) {
      out.push(lines[i]);
      i += 1;
    }
  }
  return out.join("\n");
}

/*
 * ── THE PROD SIGNAL IS DERIVED, NOT ANCHORED (loom#1596, F1 + F2 + F3) ───────
 *
 * Two PROD patterns were anchored where every sibling is `.*`-tolerant:
 * `/docker\s+restart\s+\S+/` (no flags at all) and `/ssh\s+.*docker…/`. This
 * file's own comment eight lines above `stack deploy` records widening exactly
 * this shape in loom#1548 round 1 — `restart` was left behind. Measured on the
 * pre-fix build, all ALLOW, and a PATH-stubbed shell confirmed each really ran
 * `docker restart`:
 *
 *   DOCKER restart tools-api            (one shift key)
 *   docker "restart" tools-api          $(echo docker) restart tools-api
 *   docker${IFS}restart tools-api       D=docker; $D restart tools-api
 *   echo tools-api | xargs docker restart   (no trailing target for `\S+`)
 *
 * The predicates below read the PARSED verb through the same
 * `_dockerInvocations` machinery the vouch path already trusts, which
 * quote-strips and tolerates interposed global flags — closing case, quoting
 * and substitution in one move rather than one regex at a time. They are
 * ADDITIVE: the eight spans stay exactly as they are, so the wrapper classes
 * they close stay closed. This is deliberately NOT a switch to parsed-verb
 * DISPATCH, which would reopen them.
 */
/*
 * loom#1601 F6 — the restart signal is scoped to the invocation that CAN be a
 * production restart with no target claim.
 *
 * A BARE `docker restart <container>` still fires: that is F1's real vector,
 * and the `/docker\s+restart\s+\S+/` span above misses it the moment the case
 * or the spacing changes (`DOCKER restart`, `docker${IFS}restart`).
 *
 * A COMPOSE-GROUP restart carrying no prod signal does NOT fire.
 * `docker compose restart api` resolves to the cwd's OWN `docker-compose.yml`
 * and is among the most-typed local dev commands there is; blocking it is the
 * disable-bait class `hook-output-discipline.md` MUST NOT names — the operator
 * reaches for `--skip-staging`, which switches the whole gate off.
 *
 * A compose-group restart still DENIES on any POSITIVE prod signal:
 *   - a `-f` whose value names a production file — tested HERE rather than
 *     leaning on the `/docker.*compose.*prod.*restart/is` span, whose match
 *     depends on `prod` PRECEDING `restart` in the text;
 *   - a daemon redirect (`--context production` / `-H tcp://prod:2376`)
 *       -> `_prodDaemonRedirect`
 *   - an env-carried selection (COMPOSE_FILE / DOCKER_HOST / DOCKER_CONTEXT)
 *       -> `_prodEnvRedirect`
 *   - an `ssh … docker compose` wrapper  -> `_prodSshDocker`
 * Those three siblings read the SAME scan text as this predicate, so the
 * narrowing removes nothing they already cover.
 *
 * Scoped to `compose` ONLY — `group: null` (bare), `stack`, `service` and any
 * UNKNOWN group keep firing, because only compose has the local-default-file
 * semantics the narrowing rests on.
 *
 * ACCEPTED RESIDUAL, recorded so a later reader does not "improve" it away:
 * a `docker compose restart` run in a directory whose DEFAULT
 * `docker-compose.yml` IS production now ALLOWs. Co-owner-ratified: a knowing
 * trade for removing a block on everyday local dev.
 */
function _prodBareRestart(tokens) {
  return _dockerInvocations(tokens).some((d) => {
    if (d.verb !== "restart") return false;
    if (d.group !== "compose") return true;
    return _composeFileValues(tokens).some((f) =>
      _targetNames(f).some((n) => PROD_COMPONENT_RE.test(n)),
    );
  });
}

function _prodSshDocker(tokens) {
  if (_sshHosts(tokens).length === 0) return false;
  return _dockerInvocations(tokens).some(
    (d) => d.group === "compose" || d.group === "stack",
  );
}

/*
 * The gate is scoped per-invocation so a hatched invocation cannot vouch an
 * unhatched one (loom#1551 / #1587 round 6) — correct, and it left a shell
 * VARIABLE free to carry the prod token out of the invocation being tested.
 * The worst measured case is not an attack shape but ordinary usage:
 *
 *   export COMPOSE_FILE=docker-compose.prod.yml; docker compose up -d   -> ALLOW
 *   COMPOSE_FILE=docker-compose.prod.yml docker compose up -d           -> DENY
 *
 * The inline form denies and the split form allows: the gate is not blind to
 * COMPOSE_FILE, it is blind to the SPLIT. The same split defeats #1587's own
 * `--context` fence via `C=production; docker --context $C …`.
 *
 * BOUNDED resolver, deliberately not general dataflow: only `NAME=<literal>`
 * assignments are collected (a value containing `$` or a backtick is NOT a
 * literal and is skipped), and they are accumulated in invocation order so an
 * earlier assignment informs a later command. Two carriers are covered — a
 * `$NAME` REFERENCE, expanded before the spans run, and an ENVIRONMENT
 * selection (`COMPOSE_FILE` / `DOCKER_HOST` / `DOCKER_CONTEXT`) that names no
 * variable in the deploy at all.
 */
function _collectAssignments(invocation, env) {
  for (const cell of _argvTokenCells(invocation)) {
    const raw = cell.text;
    const m = raw.match(_ASSIGN_RE);
    if (!m) {
      const word = _bareWord(raw).toLowerCase();
      if (word.length === 0) continue;
      if (
        word === "export" ||
        word === "declare" ||
        word === "local" ||
        word === "readonly" ||
        word === "typeset"
      ) {
        continue;
      }
      break;
    }
    if (/[$`]/.test(m[2])) continue;
    env.set(m[1], m[2]);
  }
  return env;
}

function _expandVars(text, env) {
  return String(text).replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (whole, braced, fallback, bare) => {
      const name = braced || bare;
      if (env.has(name)) return env.get(name);
      if (fallback !== undefined) return fallback;
      return whole;
    },
  );
}

const ENV_TARGET_VARS = new Set([
  "compose_file",
  "docker_host",
  "docker_context",
]);

function _prodEnvRedirect(env, tokens) {
  if (_dockerInvocations(tokens).length === 0) return false;
  for (const [name, value] of env) {
    if (!ENV_TARGET_VARS.has(name.toLowerCase())) continue;
    if (_targetNames(value).some((n) => PROD_COMPONENT_RE.test(n))) return true;
  }
  return false;
}

/*
 * The DAEMON-redirect subset, which must also DENY the non-production TARGET
 * claim — the vouch runs BEFORE the PROD test, so without this a dev compose
 * file vouches the invocation and the prod signal is never reached:
 *
 *   export DOCKER_HOST=tcp://prod-swarm:2376; docker compose -f …dev.yml up -d
 *
 * `_hasDaemonRedirect` already denies the claim for the FLAG carrier
 * (`--context` / `-H`); the environment is the same signal by another carrier,
 * and `isNonProdTarget` could not see it. It denies only the TARGET claim, so
 * the read-only-verb vouch is untouched and `docker compose logs` against a
 * prod daemon stays allowed — the polarity `_hasDaemonRedirect` documents.
 *
 * `COMPOSE_FILE` is deliberately EXCLUDED: an explicit `-f` overrides it in
 * docker itself, so a dev `-f` beside a prod `COMPOSE_FILE` genuinely IS a dev
 * deploy and vouching it is correct. It stays in `_prodEnvRedirect`, which
 * only fires where no `-f` proved the target.
 */
const ENV_DAEMON_VARS = new Set(["docker_host", "docker_context"]);

function _prodEnvDaemon(env) {
  for (const [name, value] of env) {
    if (!ENV_DAEMON_VARS.has(name.toLowerCase())) continue;
    if (_targetNames(value).some((n) => PROD_COMPONENT_RE.test(n))) return true;
  }
  return false;
}

/*
 * loom#1484 — A COMMAND SUBSTITUTION IS A COMMAND, AND IT MUST BE ADJUDICATED AS ONE.
 *
 * Neither splitter above looks INSIDE `$( … )` or a backtick span, so the
 * substituted command was never adjudicated on its own and the outer reader
 * vouched for the entire string:
 *
 *   cat "$(docker compose -f docker-compose.prod.yml up -d)"
 *     _splitInvocations    -> ONE invocation (the `$( … )` sits inside double quotes)
 *     _splitSubInvocations -> ONE sub (no separators outside the substitution)
 *     that sub starts with `cat ` -> /^\s*(cat|grep|head|tail|ls)\b/ matches
 *     -> SAFE unanimity holds -> `continue` -> the PROD test NEVER RUNS.
 *
 * The deploy still executes. The shell runs the substitution FIRST, precisely so
 * its output can be handed to the outer command — so the one command in that
 * string guaranteed to run was the one the gate never looked at.
 *
 * NOTE the issue's own wording ("the outer command matches an unanchored SAFE
 * pattern") is not quite the mechanism: `/^\s*(cat|grep|head|tail|ls)\b/` IS
 * anchored. It matches because the substitution was never split into its own
 * sub-invocation, so `cat ` sits at the start of the only sub there is. The bug
 * is missing EXTRACTION, not missing anchoring — which matters, because
 * tightening the anchor would not have fixed it.
 *
 * THE FIX adjudicates every substitution body as its OWN invocation, IN ADDITION
 * to the outer one. Fail-closed in the same sense round 3 recorded for the extra
 * split: more candidate invocations can only produce MORE prod matches, never
 * fewer, and the outer command's own SAFE verdict is left untouched.
 *
 * SINGLE QUOTES SUPPRESS. `echo '$(docker compose … up -d)'` is literal text the
 * shell never expands, so extracting it would be a false positive. Double quotes
 * do NOT suppress — `$( … )` and backticks expand inside them, which is exactly
 * the reported shape, so the quote tracking here is load-bearing and asymmetric.
 *
 * `${ … }` is parameter expansion, not command substitution: the trigger is the
 * two-character `$(`, never a bare `$`.
 *
 * `$(( … ))` (arithmetic) is deliberately NOT special-cased. Its body extracts as
 * `(1+2)`, which matches no PROD pattern and is therefore harmless — whereas
 * skipping every `$((` would blind the gate to `$( (docker compose … up -d) )`,
 * a real subshell deploy. Extracting too much is safe here; extracting too little
 * is the bug being fixed.
 *
 * ── WHY THIS NO LONGER TRIES TO FIND THE CLOSING DELIMITER (loom#1548 round 1)
 *
 * The first version of this extractor tracked shell quoting to locate the exact
 * matching `)`. An adversarial round broke it in two moves, both confirmed by
 * measurement against a blocking positive control:
 *
 *   cat "$(MSG=')' docker compose -f docker-compose.prod.yml up -d)"   -> exit 0
 *   cat $(true ')' )$(docker compose -f docker-compose.prod.yml up -d) -> exit 0
 *
 * `_matchClosingParen` counted parens WITHOUT quote state, so a `)` inside a
 * quoted argument closed the body early. The extracted "body" was the fragment
 * `MSG='`, the deploy fell outside it, and in the second shape the desynced
 * quote state then swallowed a whole second substitution. The bug the extractor
 * was added to fix had been reopened BY the extractor.
 *
 * The lesson is not "track quotes more carefully". Shell quoting has `$'…'`,
 * `$"…"`, backslash rules that differ inside single vs double quotes, heredocs,
 * and nesting — every added case is another chance for this file's notion of
 * quoting to diverge from the shell's, and a divergence here is a SILENT ALLOW.
 * A guard must not depend on out-parsing the thing it guards against.
 *
 * So it no longer tries. For each opener we adjudicate the ENTIRE REMAINDER of
 * the command as a candidate. That is quote-semantics-INDEPENDENT: whatever the
 * shell decides the substitution contains, the deploy text is somewhere in the
 * remainder, and the PROD patterns match as substrings. The balanced body is
 * still extracted when it can be found, but only as PRECISION (finer invocation
 * splitting) — never as the correctness argument.
 *
 * Over-extraction remains safe for the reason already stated: extra candidates
 * can only produce MORE prod matches, never fewer, and a candidate is only ever
 * VOUCHED FOR by SAFE unanimity over its own sub-invocations.
 */
/*
 * BOUNDS (loom#1548 round 1, H1 — confirmed by measurement, not inherited).
 *
 * The reviewer filed deep nesting as an unverified hypothesis. Measured: a
 * 20,000-deep `$(` nest did NOT crash — it ran past 2 MINUTES without
 * returning, because each opener pushes a remainder slice of O(n) and the
 * recursion then re-scans them. Superlinear, and introduced by the remainder
 * strategy above.
 *
 * A hang is not benign here. The 5s timer at the top of this file cannot save
 * it: the parse is fully synchronous, so the timer never gets to fire (the same
 * reason the reviewer correctly REFUTED the timeout-by-CPU-burn angle). A
 * PreToolUse hook that never returns stalls the session, and whatever the
 * runtime does on its own timeout is not a decision this gate made.
 *
 * Both caps are safe against a crafted input because THE FIRST OPENER'S
 * REMAINDER CONTAINS EVERY LATER CHARACTER. Hiding a deploy behind opener 33,
 * or at nesting depth 7, leaves it inside the remainder taken at opener 1 —
 * so truncating the scan cannot hide deploy text from the PROD patterns. The
 * caps trade only the finer sub-invocation SPLITTING of deeply nested shapes,
 * which is precision, never the block decision.
 */
const MAX_SUBSTITUTION_OPENERS = 32;
const MAX_SUBSTITUTION_CANDIDATES = 256;

// Every opener that hands a SUBSTRING of the command to the shell as its own
// command. `<(` and `>(` are process substitution — loom#1548 R1 F1: they are the
// reported `$(` bypass with one character changed, and the § PATTERN SCOPE note
// above had already listed them as an uncovered separator.
const SUBSTITUTION_OPENERS = [
  { tok: "$(", skip: 2 },
  { tok: "<(", skip: 2 },
  { tok: ">(", skip: 2 },
  { tok: "`", skip: 1 },
];

function _extractSubstitutions(command) {
  const root = String(command);
  const out = [];
  const seen = new Set([root]);
  // ITERATIVE, NOT RECURSIVE — a work queue with ONE GLOBAL BUDGET.
  //
  // The first attempt at bounding this used a per-level opener cap plus a depth
  // cap. MEASURED: that is exponential, not bounded — 32 openers each pushing 2
  // bodies, six levels deep, is 64^6 candidates. Against a 1000-deep `$(` nest it
  // threw a RangeError in ~841ms, which the fail-open catch swallowed SILENTLY
  // (exit 0, empty stderr) — turning a pathological input into an ALLOW. The
  // per-level caps made the bug harder to see without making it smaller.
  //
  // A single global budget over a queue is bounded by construction: total work is
  // O(MAX_SUBSTITUTION_CANDIDATES) regardless of nesting depth or input shape,
  // and there is no recursion to overflow. `seen` also stops a body that equals
  // an already-queued string from re-expanding.
  const queue = [root];
  while (queue.length > 0 && out.length < MAX_SUBSTITUTION_CANDIDATES) {
    const s = queue.shift();
    let openersSeen = 0;
    for (let i = 0; i < s.length; i += 1) {
      if (
        openersSeen >= MAX_SUBSTITUTION_OPENERS ||
        out.length >= MAX_SUBSTITUTION_CANDIDATES
      ) {
        break;
      }
      for (const { tok, skip } of SUBSTITUTION_OPENERS) {
        if (!s.startsWith(tok, i)) continue;
        // THE REMAINDER IS THE LOAD-BEARING CANDIDATE. Everything after the
        // opener, to end of string — see the header note on why this replaced
        // balanced matching.
        const remainder = s.slice(i + skip);
        // The balanced body too, when found: finer invocation splitting, so a
        // separator INSIDE the substitution yields its own invocation.
        // PRECISION ONLY — the block decision never depends on it.
        const end =
          tok === "`"
            ? _matchClosingBacktick(s, i + 1)
            : _matchClosingParen(s, i + skip - 1);
        const balanced = end === -1 ? null : s.slice(i + skip, end);
        for (const body of [remainder, balanced]) {
          if (body === null || body.length === 0 || seen.has(body)) continue;
          seen.add(body);
          out.push(body);
          // Nested substitutions are found by re-queueing, not by recursing.
          if (body.length < s.length) queue.push(body);
        }
        openersSeen += 1;
        break;
      }
    }
  }
  return out;
}

function _matchClosingParen(s, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function _matchClosingBacktick(s, startIdx) {
  for (let i = startIdx; i < s.length; i += 1) {
    if (s[i] === "\\") {
      i += 1;
      continue;
    }
    if (s[i] === "`") return i;
  }
  return -1;
}

function emitBlock({
  what_happened,
  why,
  agent_must_report,
  agent_must_wait,
  user_summary,
}) {
  const out = instructAndWait({
    hookEvent: "PreToolUse",
    severity: "block",
    what_happened,
    why,
    agent_must_report,
    agent_must_wait,
    user_summary,
  });
  clearTimeout(timeout);
  console.log(JSON.stringify(out.json));
  process.exit(out.exitCode);
}

// Patterns that indicate production deployment
// Projects should add their own container name patterns below.
/*
 * MODULE SCOPE IS LOAD-BEARING (loom#1588 round 1). The outer catch re-tests the
 * RAW command against this array after a parser fault, and that catch lives
 * outside the handler — a handler-local `const` would be out of scope there, and
 * a SECOND copy declared inside the handler would shadow this one, so the
 * classifier and the fault-path re-test would silently drift apart on the next
 * edit to either. One declaration, both readers.
 *
 * EVERY `.*` HERE CARRIES THE `s` FLAG — loom#1587 round 8, and it is the
 * difference between a match and a bypass, not a style choice.
 *
 * JS `.` does not match `\n` without `s`. `_splitInvocations` correctly
 * keeps a BACKSLASH-CONTINUED newline inside ONE invocation (the `\` marks
 * both itself and the newline inert, so the newline is not a command
 * boundary) — which is right, because that IS one command to the shell. The
 * two facts compose into a hole: an unanchored `.*` span can only match
 * within a single LINE of an invocation that legitimately spans several.
 * Measured on the round-7 build, against the identical command written on
 * one line returning 2:
 *
 *   docker compose \
 *     -f \
 *     docker-compose.prod.yml \
 *     up -d                                                    -> 0
 *
 * That is not an adversarial spelling; it is how a long deploy line is
 * ordinarily written. `--skip-staging` was never passed and the gate never
 * ran.
 *
 * `s` IS SOUND HERE BECAUSE A BARE NEWLINE CANNOT SURVIVE INTO AN
 * INVOCATION. `_splitInvocations` cuts on every newline the shell would ACT
 * on, so any newline still inside an invocation is either backslash-escaped
 * or quoted — in both cases part of one command, which is exactly the scope
 * these patterns are adjudicated over (§ PATTERN SCOPE). Letting `.` cross
 * it restores the intended span; it does not widen the scope.
 *
 * `/docker\s+restart\s+\S+/` needs no flag: it contains no `.`, and `\s`
 * already matches a newline.
 *
 * The `s` flag reaches the fault-path re-test too, precisely BECAUSE there is
 * one declaration: a backslash-continued deploy that faults the parser is
 * adjudicated on the same spans the classifier would have used.
 */
const PROD_PATTERNS = [
  // Generic docker compose prod file patterns
  /docker.*compose.*prod.*up/is,
  /docker.*compose.*prod.*build/is,
  /docker.*compose.*prod.*restart/is,
  /docker.*compose.*-f.*docker-compose\.prod/is,
  // bare docker restart (single container restarts bypass compose)
  /docker\s+restart\s+\S+/,
  /*
   * bare `docker stack deploy` (swarm). loom#1484, found while reproducing
   * the command-substitution bypass and NOT part of that report.
   *
   * `docker stack` appeared in exactly one PROD pattern — the `ssh` one
   * below — so it was gated only when reached THROUGH ssh. A LOCAL swarm
   * deploy, which is the ordinary case, matched no PROD pattern at all and
   * was allowed with no wrapper and no substitution needed.
   *
   * This is why the issue's third repro (`head "$(docker stack deploy …)"`)
   * cannot be closed by the substitution fix alone: extraction hands the
   * body to a PROD set that never recognised it. Both halves are required.
   */
  /*
   * loom#1548 round 1 F4: this shipped as `/docker\s+stack\s+deploy\b/i`,
   * which requires `stack` to follow `docker` IMMEDIATELY. That is narrower
   * than every sibling pattern here, all of which use `docker.*` precisely
   * to tolerate interposed global flags — and it let through
   *
   *   docker --context prod stack deploy -c stack.yml app        -> exit 0
   *
   * which is THE canonical remote-swarm deploy (`-H tcp://prod:2376` is the
   * same shape). Widened to match the file's own convention.
   */
  /docker.*stack\s+deploy\b/is,
  /*
   * The rolling-update siblings of `stack deploy`, ungated for the same
   * reason `stack deploy` was: `docker stack` appeared only in the ssh
   * pattern below, so the whole swarm surface was reachable only through
   * ssh. Both of these mutate a running production service.
   */
  /docker.*service\s+(update|scale)\b/is,
  // SSH to production server running docker compose
  /ssh\s+.*docker\s+(compose|stack)/is,
];

// Set once the command is KNOWN to be a production deploy with no
// `--skip-staging`. It gates the outer catch below: an unexpected failure while
// gating a prod deploy must refuse, but an unexpected failure BEFORE we can even
// tell what the command is must not block every Bash call in the session.
let gatingProdDeploy = false;

/*
 * The RAW command text, hoisted OUT of the try so the outer catch can still see
 * it after a fault. Empty until stdin has been read and parsed — which is
 * exactly right: a fault that far out means there is no command to judge, and
 * the empty string matches no PROD pattern, so the pre-classification arm
 * exits 0 as before.
 */
let rawCommand = "";

/*
 * § UNREADABLE STDIN — loom#1588 round 2.
 *
 * A distinct sentinel, so "I could not read my input" is not silently spelled
 * the same way as "I read an empty object". `readStdinBounded` RESOLVES its
 * fallback on every unhappy path (over-ceiling, timeout, parse error, stream
 * error) — it does not throw — and with the default `{}` fallback the result is
 * indistinguishable from a parsed payload with no fields.
 *
 * THAT INDISTINGUISHABILITY IS THE DEFECT THIS ROUND FIXES, and it defeated the
 * previous round's own headline guarantee. With `{}`, `input.tool_name` is
 * `undefined`, so the `toolName !== "Bash"` early return below exited 0 BEFORE
 * `rawCommand` was ever assigned — which put the raw-text re-test in the outer
 * catch structurally out of reach on this path. Measured on the pre-fix build,
 * a real deploy plus a shell-comment pad:
 *
 *   pad  9 MiB  (payload  9437281 B)  EXIT=2  stdout=955  stderr=1085   blocked
 *   pad 10 MiB  (payload 10485857 B)  EXIT=0  stdout=0    stderr=0      SILENT
 *   stdin delayed 0.2s                EXIT=2  stdout=955  stderr=1085   blocked
 *   stdin delayed 3s                  EXIT=0  stdout=0    stderr=0      SILENT
 *
 * A production deploy allowed at exit 0 with no stdout and no stderr — the exact
 * signature the previous round set out to eliminate.
 */
const STDIN_UNREADABLE = Symbol("stdin-unreadable");

async function main() {
  try {
    const input = await readStdinBounded({
      fallback: STDIN_UNREADABLE,
      timeoutMs: STDIN_READ_TIMEOUT_MS,
      onRawText: (text) => {
        rawStdinText = text || "";
      },
    });

    /*
     * ADJUDICATED BEFORE THE `toolName` CHECK, AND THAT ORDER IS THE FIX.
     *
     * On this path there is no `tool_name` to read, so the early return below
     * would answer "not a Bash command" to a question that was never asked. The
     * honest reading of an unparseable payload is "unknown tool, unknown
     * command" — which for a deploy gate is not the same as "safe".
     *
     * The verdict is taken on the raw bytes that DID arrive (`onRawText` above
     * hands back the buffer the reader would otherwise drop), using the linear
     * token prescreen rather than PROD_PATTERNS — see DEPLOY_TOKENS for why
     * regex here would hang instead of gate.
     *
     * BOTH POLARITIES ARE PRESERVED, WHICH IS THE POINT. Deploy text present ->
     * refuse. No deploy text -> exit 0, so a stdin hiccup still cannot block
     * every Bash call in the session (hook-output-discipline.md MUST NOT
     * § "Detectors that block work the agent has been instructed to perform").
     * Because the prescreen is coarser than the classifier it can refuse a
     * command the classifier would have allowed — correct direction for a deploy
     * gate, and it fires ONLY when the payload could not be USED at all.
     *
     * TWO DEFECTS REACH THIS ARM, NOT ONE (round 3). "Could not be read" is the
     * loud case: the reader gave back its sentinel. The quiet case is a payload
     * that PARSES but is not a tool event — a bare JSON string, number, boolean,
     * `null`, or an array. Round 2 tested `input === STDIN_UNREADABLE` alone, so
     * every one of those slipped past to the `toolName !== "Bash"` return below
     * and exited 0 in silence. Measured on the round-2 build, stdin holding the
     * JSON string "docker compose -f docker-compose.prod.yml up -d":
     *
     *   json-string carrying a real deploy   EXIT=0  stdout=0  stderr=0  SILENT
     *   json-array  carrying a real deploy   EXIT=0  stdout=0  stderr=0  SILENT
     *   json-null / number / boolean         EXIT=0  stdout=0  stderr=0  SILENT
     *
     * `null` is the one that throws (`null.tool_name`), and it lands in the outer
     * catch with `rawCommand` still "" — so it too exited 0, just by a longer
     * route. Same signature, same verdict: a payload the gate cannot classify is
     * "unknown command", never "safe".
     *
     * ARRAYS ARE INCLUDED DELIBERATELY. `typeof [] === "object"` and an array is
     * not null, so a `typeof`/null guard alone still lets one through — and the
     * row above shows an array carrying a deploy taking the silent exit. No
     * legitimate tool event is an array.
     *
     * Reachability is LOW: this shape is not attacker-supplied on the normal
     * path, it is whatever the CLI serialises. It is fixed because the direction
     * was wrong, not because a live exploit needs it.
     */
    const payloadFault =
      input === STDIN_UNREADABLE
        ? "the read hit the size ceiling, timed out before EOF, or was not valid JSON"
        : input === null
          ? "parsed as JSON null, which is not a tool event"
          : typeof input !== "object"
            ? `parsed as a JSON ${typeof input}, which is not a tool event`
            : Array.isArray(input)
              ? "parsed as a JSON array, which is not a tool event"
              : null;

    /*
     * "read" for the reader's sentinel, "used" for a payload that parsed into the
     * wrong shape — the two are not the same failure and the operator-facing text
     * should not blur them. The unreadable wording is also load-bearing: the
     * zero-byte row of the regression suite pins `/could not be read/i` as the
     * proof that an aborted gate announces itself.
     */
    const payloadVerb = input === STDIN_UNREADABLE ? "read" : "used";

    if (payloadFault !== null) {
      if (!DEPLOY_TOKENS.test(rawStdinText)) {
        // Nothing deploy-shaped on the wire (commonly: nothing on the wire at
        // all). Allow — but never silently; the gate did not run.
        console.error(
          `[DEPLOY HOOK] NOTICE: the tool payload could not be ${payloadVerb} ` +
            `(${rawStdinText.length} bytes received, ${payloadFault}). ` +
            "No production-deploy token was present, so the command is allowed — " +
            "but staging was NOT verified.",
        );
        clearTimeout(timeout);
        process.exit(0);
        return;
      }
      emitBlock({
        what_happened:
          `A production-deploy token is present in the tool payload, but the payload could not be ${payloadVerb}, ` +
          `so the deploy gate never classified the command (${rawStdinText.length} bytes received; ${payloadFault}).`,
        why: "deploy-hygiene.md — an aborted gate is not a passed gate. The staging verification did not run, so nothing here says this deploy was verified. security.md § Enforcement-Surface Parity: a check that cannot answer ranks TIGHTEST, never a clean negative.",
        agent_must_report: [
          "Quote the exact command that was attempted",
          `State that the deploy gate could not ${payloadVerb.toUpperCase()} its input — the command was never classified and the deploy is unverified`,
          `Report that ${rawStdinText.length} bytes of tool payload were received (${payloadFault})`,
          "Re-issue the command in a smaller/simpler form so the gate can read and classify it, OR ask the user to authorise `--skip-staging` with a documented reason in deploy/deployment-config.md",
        ],
        agent_must_wait:
          "Do not retry until the payload can be read and the gate reaches a verdict, OR the user authorises proceeding unverified.",
        user_summary:
          "Production deploy blocked — the deploy gate could not read the command and never checked staging",
      });
      return;
    }

    const toolName = input.tool_name;
    const toolInput = input.tool_input || {};
    /*
     * Line continuations are joined BEFORE anything classifies, so every layer
     * below — invocation splitting, sub-invocation splitting, verb derivation,
     * the PROD spans and the `--skip-staging` argv check — sees the ONE command
     * the shell sees (§ `_joinContinuations`). Doing it here rather than at each
     * reader is the same single-model argument `_argvTokenCells` makes: round 6
     * taught argv reachability to one surface and left two others behind, and
     * that seam is what loom#1587 spent a round closing.
     */
    const command = _joinContinuations(toolInput.command || "");

    // Only check Bash commands
    if (toolName !== "Bash") {
      clearTimeout(timeout);
      process.exit(0);
      return;
    }

    /*
     * Published to the outer catch ONLY once the tool is known to be Bash, so a
     * non-Bash payload can never reach the raw-text fallback below.
     */
    rawCommand = command;

    /*
     * PROD_PATTERNS is declared at MODULE scope (see above) so the outer catch
     * can re-test the RAW command after a parser fault, and so the classifier
     * and that re-test read ONE array. The handler-local copy loom#1587 carried
     * was deleted here rather than kept: as a handler-local `const` it SHADOWED
     * the module declaration inside this function, which would have left the
     * classifier on the `s`-flagged spans while the fault path re-tested on the
     * un-flagged ones. The `s` flags and their rationale moved up with it.
     */

    /*
     * Patterns that are always allowed (read-only, logs, status, dev scripts).
     *
     * loom#1471 round-3 F-2. Two of these were UNANCHORED substring matches, and
     * SAFE was adjudicated against the WHOLE command BEFORE prod classification,
     * so either one short-circuited the gate. Measured against the live arrays:
     *
     *   SAFE-EXIT(/cat|grep|head|tail|ls/) prod=true :: docker restart tools-api
     *   SAFE-EXIT(/cat|grep|head|tail|ls/) prod=true :: docker restart catalog-svc
     *   SAFE-EXIT(/git\s+(pull|…)/i)       prod=true :: git pull && docker compose -f docker-compose.prod.yml up -d
     *   SAFE-EXIT(/curl/i)                 prod=true :: docker compose … up -d && curl -sf localhost:8080/health
     *
     * Any service or container whose NAME contains ls / cat / head / tail / grep
     * — tools, controls, catalog, analytics, headless — took that exit. So did
     * every compound deploy, which is how deploys are actually written.
     *
     * TWO CHANGES, AND BOTH ARE NEEDED.
     *
     * 1. The bare-utility patterns are anchored to COMMAND POSITION. `cat`,
     *    `grep`, `head`, `tail`, `ls`, `curl` and `git pull` are safe when they
     *    are the thing being RUN, not when they appear inside an argument.
     * 2. Adjudication is decomposed rather than whole-command
     *    (§ _splitInvocations / _splitSubInvocations, and § PATTERN SCOPE
     *    below), so a read can no longer vouch for a deploy beside it.
     *
     * WHY NOT SIMPLY CHECK PROD FIRST — the obvious fix, and it is wrong. SAFE
     * genuinely must be able to override PROD within one command: measured,
     * `docker compose -f docker-compose.prod.yml logs` matches the PROD pattern
     * `/docker.*compose.*-f.*docker-compose\.prod/i`, and reading logs is not a
     * deploy. Reordering would start blocking it. The defect was never the
     * precedence; it was the SCOPE the precedence was applied over.
     */
    /*
     * The five span-matching `docker.*` patterns are GONE — not narrowed,
     * removed. `/docker.*logs/i`, `/docker.*ps/i`, `/docker.*inspect/i`,
     * `/docker.*images/i` and `/docker\s+exec/i` asked "does a read-only WORD
     * appear anywhere in this text", which is not a question about what the
     * command DOES; that is the whole of loom#1550. A docker sub-invocation is
     * now classified by the VERB IT RUNS (§ THE READ-ONLY ALLOWLIST), so these
     * patterns had no remaining job and leaving them would give this file two
     * disagreeing notions of "read-only docker" — the drift shape
     * `security.md` § Enforcement-Surface Parity names.
     *
     * loom#1587 finished that move. The six remaining anchored regexes were
     * asking POSITIONALLY ("is this the command being run?") in regex form, and
     * three of them could only ever see position ZERO of the sub — so the same
     * `cat` that vouched locally did not vouch as `ssh host "cat …"`, where
     * `_splitSubInvocations` leaves the transport prefix in front of it. The
     * command-position question is now answered by reading argv position 0
     * directly (§ `subIsVouched`, § READ_ONLY_COMMANDS, § GIT_READ_ONLY_VERBS),
     * which is the same single-model argument that removed the five `docker.*`
     * spans above.
     *
     * WHAT IS LEFT IS NOT EXPRESSIBLE POSITIONALLY. These three are project
     * deploy SCRIPTS identified by PATH, and a path is a genuine span: the
     * script may be invoked as `./deploy/scripts/dev.sh`, `bash
     * deploy/scripts/dev.sh` or through an absolute path, so there is no fixed
     * argv slot to read. They stay spans on purpose, and they are narrow enough
     * that the loom#1550 accident class cannot reach them.
     */
    const SAFE_PATTERNS = [
      /deploy\/scripts\/stage\.sh/,
      /deploy\/scripts\/promote\.sh/,
      /deploy\/scripts\/dev\.sh/,
    ];

    /*
     * NON-PRODUCTION TARGETS — "not prod" is not the same claim as "read-only",
     * and conflating them is what broke remote dev/staging deploys.
     *
     * `/docker.*compose.*{dev,staging}.*up/i` shipped inside SAFE_PATTERNS, so
     * the round-5 mutating-verb veto — correctly seeing `up` — stripped their
     * vouch. Locally that was invisible (the PROD patterns then decline and the
     * command is allowed anyway). Remotely it is not, because
     * `/ssh\s+.*docker\s+(compose|stack)/i` matches ANY remote compose command
     * whatever it targets. Measured on the round-5 build:
     *
     *   ssh staging "docker compose -f docker-compose.staging.yml up -d"  -> 2
     *   ssh dev     "docker compose -f docker-compose.dev.yml up -d"      -> 2
     *
     * Two ordinary non-production deploys, blocked by a PRODUCTION gate. That
     * is not conservatism; over-blocking legitimate work is its own failure
     * mode (`hook-output-discipline.md` MUST NOT, last clause).
     *
     * So the dev/staging carve-out is stated as what it is — a claim about the
     * TARGET, exempt from the read-only requirement because a dev deploy is a
     * mutation and is meant to be.
     *
     * loom#1587: THE THREE SPAN PATTERNS THAT USED TO LIVE HERE ARE GONE, for
     * the identical reason the five `docker.*` SAFE spans above are gone. They
     * asked "does a dev-ish word appear anywhere in this text", which is not a
     * question about what the command TARGETS — and being evaluated one conjunct
     * EARLIER than the SAFE spans, they short-circuited the allowlist that had
     * just been built to replace exactly this shape. Leaving them was the file
     * keeping two disagreeing notions of "non-production", the drift
     * `security.md` § Enforcement-Surface Parity names — the same argument the
     * SAFE deletion made, applied to the conjunct it missed.
     *
     * The claim is now DERIVED (§ `isNonProdTarget`, below `main`'s pattern
     * tables) from the compose files the command actually names, the group of
     * the verb it actually runs, and the endpoint it is actually aimed at.
     * Its fence is unchanged in intent and stricter in fact: naming a
     * production target anywhere revokes the exemption, because compose MERGES
     * `-f` files and a dev file beside a prod override IS a production deploy.
     */

    /*
     * THE SAFE VETO (loom#1550) — A READ-ONLY WORD DOES NOT MAKE A MUTATION A READ.
     *
     * Round 3 bounded the five span-matching `docker.*` SAFE patterns with
     * UNANIMITY: vouch only when EVERY sub-invocation is read-only. That is
     * correct for the class it addressed — a read BESIDE a deploy — and it does
     * nothing for the class below, because
     *
     *     docker compose -f docker-compose.prod.yml --profile logs up -d
     *
     * is ONE sub-invocation that contains BOTH a read-only word and a mutating
     * verb. Unanimity over a single element is trivially satisfied,
     * `/docker.*logs/i` matches the span `docker` … `logs`, the SAFE arm fires,
     * and the PROD test never runs. Measured: exit 0, against a positive control
     * returning 2 on the same build. `--profile logs`, and any service or
     * profile named `logstash` / `images-api` / anything containing `ps`, does
     * the same.
     *
     * ROUND 5 ANSWERED THIS WITH A DENYLIST of 21 mutating verbs. ROUND 6
     * REPLACED THE POLARITY: a docker sub-invocation is vouched only by naming
     * an ALLOWLISTED read-only verb, derived POSITIONALLY from quote-stripped
     * argv tokens (§ THE READ-ONLY ALLOWLIST, above `main`). The denylist is
     * retained as a second conjunct because the two close different holes. Read
     * that section for why the denylist alone left `watch`, every future compose
     * verb, and every quoted spelling of `up` reachable.
     *
     * Unanimity across sub-invocations is UNCHANGED and still required — the
     * multi-command shapes round 5 pinned depend on it.
     *
     * WHY NOT ANCHOR THE FIVE PATTERNS — measured and REJECTED twice
     * independently, and it is the obvious fix. Anchoring gates
     * `ssh prod "docker compose logs -f api"` on the ssh PROD pattern: it starts
     * with `ssh`, so an anchored SAFE no longer matches, and a legitimate remote
     * read starts blocking. That is loom#1484's own AC-2 and the R4b
     * false-positive family. Do not re-propose it.
     *
     * WHY NOT "CHECK PROD FIRST" — also wrong, and for a different reason:
     * `/docker.*compose.*-f.*docker-compose\.prod/i` requires no mutating verb,
     * so PROD-first gates `docker compose -f docker-compose.prod.yml logs`, a
     * read. The two over-broad patterns currently CANCEL each other out; the
     * veto removes the SAFE side of that accident without touching the PROD
     * side. Nothing here reorders the precedence.
     *
     * WHY THE VERB SET IS THIS WIDE. The design that produced this veto listed
     * seven verbs (`up build restart down create start deploy`), which closes
     * every shape loom#1550 reports. Sweeping all 30 compose verbs through the
     * reported shape then measured that ALL THIRTY exit 0 pre-fix — the bleed is
     * verb-INDEPENDENT, because it is `--profile logs` that matches, not the
     * verb. Closing seven would have left `stop`, `kill`, `rm`, `scale` and
     * `run` reachable by the identical shape: the same defect surviving a fix
     * correct for the class it named, which is exactly how loom#1550 outlived
     * round 3. Every verb below was confirmed to exit 0 before the veto.
     *
     * TOKEN BOUNDARIES ARE LOAD-BEARING. A container named `db-up`, a filter
     * `status=up`, or the path `deploy/scripts/stage.sh` must NOT read as the
     * verbs `up` / `deploy`. Whole-token equality over quote-stripped argv words
     * gives that exactly, where the previous `(^|\s)…(\s|$)` regex gave it only
     * approximately and gave it over text the shell had not unquoted.
     *
     * DIRECTION OF ERROR, AND THE AXES IT DOES NOT COVER (stated because
     * loom#1484 AC-5 requires it, and because three of four previous claims here
     * were false at exactly their unnamed axis):
     *
     *   Covered: vouching is now POSITIVE — a docker sub-invocation is vouched
     *   only by naming an allowlisted read-only verb, so an unrecognised verb,
     *   an unparseable command, and a verb Docker ships next year all fail to
     *   vouch and fall through to the PROD test. Quoting no longer helps: the
     *   allowlist reads quote-STRIPPED tokens, so `"up"`, `u"p"`, `up""` and
     *   `\up` are all the token `up`.
     *
     *   NOT covered, three named axes:
     *     1. A verb reached through EXPANSION — `docker compose … logs $VERB`,
     *        `${V}`, `$(printf up)` — is not a literal token. Derivation lands
     *        on `$VERB`, which is not on the allowlist, so the sub is NOT
     *        vouched: under the inverted polarity this axis now fails CLOSED
     *        rather than open, which is the one substantive difference from the
     *        round-5 denylist. What remains uncovered is the reverse — an
     *        expansion that resolves to a READ-ONLY verb over-blocks.
     *     2. `docker exec` is no longer vouched at all (see § THE READ-ONLY
     *        ALLOWLIST). It is still ALLOWED wherever no PROD pattern matches,
     *        which is every shape 1471-R3-F2b pins; the change is that it can no
     *        longer vouch for anything.
     *     3. Classification is LEXICAL over sub-invocation text, so a mutating
     *        word appearing as DATA over-blocks: `ssh prod "docker compose logs
     *        -f api | grep -i start"` gates on the ssh PROD pattern.
     *        Over-blocking is the fail-closed direction for a deploy gate and
     *        `--skip-staging` is the documented recovery.
     */

    /*
     * A dev/staging TARGET, and demonstrably not a production one — DERIVED
     * POSITIONALLY (loom#1587).
     *
     * THIS PREDICATE SHIPPED AS A RAW-TEXT SPAN, AND IT OPENED `subIsVouched`,
     * ahead of the denylist and ahead of verb derivation. So a vouch could be
     * had from any text anywhere in the sub that happened to look dev-ish,
     * skipping the PROD test entirely. Measured on the round-6 build, against
     * the positive control `docker stack deploy -c stack.yml app` -> 2:
     *
     *   ssh 10.0.0.7 "docker compose --profile devices up -d"          -> 0
     *   docker restart api   # docker-compose.dev.yml                  -> 0
     *   docker stack deploy -c docker-compose.dev.yml app              -> 0
     *   ssh 10.0.0.5 "docker stack deploy -c docker-compose.dev.yml app" -> 0
     *
     * The first needs no adversary: `dev` inside the profile name `devices`
     * satisfied `/docker.*compose.*dev.*up/i`. That is the SAME accident this
     * PR exists to fix — `ps` inside the service name `apps` — surviving in the
     * conjunct evaluated one step EARLIER than the one that was fixed. The
     * remote-deploy lane was fully exposed, because a production host addressed
     * by IP names no `prod` at all.
     *
     * FOUR CONJUNCTS, each closing one of those:
     *
     *   1. FILES, NOT TEXT. At least one compose file must be NAMED as the
     *      value of `-f`/`--file`/`-c`/`--compose-file`, and EVERY named file
     *      must be non-production. "Some token somewhere looks like a dev yml"
     *      is not a claim about what the command reads; the `--profile devices`
     *      and `# comment` shapes are both refused here.
     *   2. COMPOSE ONLY. The verb's group must be `compose`. `stack deploy` and
     *      `service update` address a SWARM — the cluster is chosen by context,
     *      not by the file, so a dev filename says nothing about the target.
     *   3. NO DAEMON REDIRECT. `--context` / `-H` / `--config` re-aim the
     *      command at an endpoint the file does not name (§ `_hasDaemonRedirect`).
     *   4. NO PRODUCTION COMPONENT in any token's BASENAME — so `--profile prod`
     *      and `ssh prod` revoke the claim, while `/srv/product/` cannot
     *      (§ `PROD_COMPONENT_RE`). ADJUDICATED OVER THE WHOLE INVOCATION
     *      (`fenceTokens`), which is round 7 and is explained below.
     *
     * A DENIED CLAIM IS NOT A BLOCK. It only means this sub must earn its vouch
     * the ordinary way, through the read-only verb allowlist below.
     *
     * ── CONJUNCT 4 IS INVOCATION-SCOPED, AND SUB-SCOPING IT WAS THE DEFECT ──
     *
     * Round 6 tested conjunct 4 over the SUB's own tokens, and the sentence
     * above claiming "`ssh prod` revokes the exemption" was FALSE the moment the
     * payload held a separator. Minimal falsifying pair, differing only by
     * inserting `cd /srv && `:
     *
     *   ssh prod "docker compose -f docker-compose.dev.yml up -d"            -> 2
     *   ssh prod "cd /srv && docker compose -f docker-compose.dev.yml up -d" -> 0
     *
     * `_splitSubInvocations` cuts the payload at `&&`, so `prod` and the deploy
     * land in DIFFERENT subs. Sub 1 (`ssh prod "cd /srv`) vouches through `cd`,
     * a path that never consults this fence at all; sub 2 then reports
     * `nonProd = true` because `prod` is not among ITS tokens. Unanimity holds
     * over two subs each of which is individually defensible, and the deploy is
     * never adjudicated. The vouching command is irrelevant — `true &&` does it,
     * and so does an IP or a hostname the fence would otherwise catch:
     *
     *   ssh production-web-01 "cd /srv && docker compose -f …dev.yml up -d" -> 0
     *   ssh 10.0.0.5          "cd /srv && docker compose -f …dev.yml up -d" -> 0
     *
     * THIS IS loom#1550's OWN CLASS — a claim adjudicated over a scope that
     * excludes the disqualifying evidence — reproduced inside the model built to
     * replace it. So the fence now reads the union of every sub's tokens.
     *
     * ONLY CONJUNCT 4 WIDENS, and the other three stay sub-local deliberately.
     * Conjuncts 1–3 read a FLAG's value (`-f`, `--context`) and a flag binds to
     * the command it sits on, so widening them would import a sibling's flags:
     * `-h` is `--host` to docker and `--human-readable` to `df`, and
     * `ssh dev "df -h && docker compose -f …dev.yml up -d"` would start
     * blocking. Conjunct 4 is different in kind — it reads the TARGET, and the
     * target of a remote invocation is named once, in the transport prefix, for
     * every command in the payload.
     *
     * ── CONJUNCT 5: `ssh` IS A DAEMON REDIRECT ──────────────────────────────
     *
     * Conjunct 3 already holds that `--context` / `-H` / `--config` DENY the
     * non-production claim, because they re-aim the command at an endpoint the
     * compose file does not name. `ssh <host>` does exactly that and was not
     * modelled, so a dev compose file vouched for a deploy onto ANY machine:
     *
     *   ssh 10.0.0.5 "cd /srv && docker compose -f …dev.yml up -d"
     *     merge-base 33cbe5bb -> 2       round 6 -> 0       REGRESSION
     *
     * The regression is round 6's own: at merge-base `cd` was on no list, so
     * sub 1 did not vouch and the ssh PROD pattern fired. Round 6 added `cd` —
     * correctly, to fix a real over-block — and that relaxation is what exposed
     * the missing conjunct. The one-sub spelling of the same command was
     * allowed at merge-base TOO (`-> 0`), so this is not only a regression fix:
     * it closes an asymmetry in which the identical deploy blocked or allowed
     * depending on whether the payload happened to contain a separator.
     *
     * SO A REMOTE COMPOSE DEPLOY MUST NAME ITS HOST AS NON-PRODUCTION. `ssh dev`
     * and `ssh staging` keep their claim; `ssh 10.0.0.5` and `ssh buildbox` do
     * not, and must use `--skip-staging`. STATED PLAINLY BECAUSE IT IS A
     * TIGHTENING BEYOND THE REPORTED SHAPE: `ssh buildbox "docker compose -f
     * docker-compose.dev.yml up -d"` was ALLOWED at merge-base and BLOCKS here.
     * The alternative was to keep an unrecognised host reading as
     * non-production, which is the fail-OPEN direction on the one axis — the
     * ENDPOINT — that a compose filename provably cannot speak to.
     */
    const isNonProdTarget = (tokens, scope) => {
      const fence = (scope && scope.tokens) || tokens;
      // Round 8: BOTH the path tail and the endpoint host of every token, so a
      // `scheme://`, a `user@` or a `:port` can no longer spell `prod` past the
      // component fence (§ `_targetNames`, § `_endpointHost`).
      if (
        fence.some((t) =>
          _targetNames(_bareWord(t)).some((n) => PROD_COMPONENT_RE.test(n)),
        )
      ) {
        return false;
      }
      /*
       * Round 8: a `null` entry is an `ssh` whose host could not be attributed,
       * and it DENIES. Round 7 filtered nulls away at the caller and guarded on
       * `hosts.length > 0`, so an unattributable host — or an `ssh` that simply
       * was not at argv slot 0 — made this conjunct a NO-OP. A fence that skips
       * the question when it cannot answer it is not a fence
       * (`security.md` § Secure-Default: fail CLOSED, never silently).
       */
      const hosts = (scope && scope.sshHosts) || [];
      if (hosts.some((h) => h === null || !_isNonProdHost(h))) return false;
      if (_hasDaemonRedirect(tokens)) return false;
      // loom#1596 F2: the ENV carrier of the same redirect (§ `_prodEnvDaemon`).
      // The flag form is denied one line above; an exported `DOCKER_HOST` /
      // `DOCKER_CONTEXT` naming production aims this invocation at the same
      // daemon while carrying no flag for that check to see.
      if (scope && scope.envDaemonProd) return false;
      const files = _composeFileValues(tokens);
      if (files.length === 0) return false;
      if (
        !files.every((f) => {
          const base = _basename(f);
          return YAML_FILE_RE.test(base) && NON_PROD_FILE_RE.test(base);
        })
      ) {
        return false;
      }
      const dockers = _dockerInvocations(tokens);
      if (dockers.length === 0) return false;
      return dockers.every((d) => d.verb !== null && d.group === "compose");
    };

    /**
     * May this sub-invocation vouch for the invocation it belongs to?
     *
     * Order is deliberate. The non-prod TARGET claim is independent of the
     * read-only one and must be tested first, because a dev deploy carries a
     * mutating verb by design and would otherwise be rejected by the very veto
     * that exists to catch production mutations. What changed in loom#1587 is
     * not the order but the CLAIM: it is now derived from argv positions rather
     * than matched against raw text, so testing it first no longer skips the
     * gate on a coincidence.
     *
     * `scope` describes the whole INVOCATION and is read ONLY by the target
     * claim: `scope.tokens` (the union of every sub's tokens) by conjunct 4,
     * `scope.sshHosts` by conjunct 5. Omitting it falls back to the sub's own
     * tokens and no hosts, so the predicate remains callable on one sub in
     * isolation.
     *
     * ROUND 7 ADDED THE WRITE GUARD, and it sits on both READ-ONLY grounds and
     * on NEITHER target ground. A read-only vouch is a claim that the command
     * does not mutate, and `>` falsifies it (§ `_hasWriteRedirect`); the
     * non-prod TARGET claim is a claim about WHERE, and a dev deploy is a
     * mutation by design — gating it on redirection would block
     * `docker compose -f docker-compose.dev.yml up -d > /tmp/deploy.log`, an
     * over-block with no security content.
     */
    const subIsVouched = (sub, scope) => {
      const tokens = _argvTokens(sub);
      if (isNonProdTarget(tokens, scope)) return true;
      // Redirection is shell syntax, invisible to every argv model below it.
      if (_hasWriteRedirect(sub)) return false;
      if (/docker/i.test(sub)) {
        /*
         * The round-5 denylist, SCOPED TO DOCKER (loom#1587). Its own rationale
         * (§ THE READ-ONLY ALLOWLIST) says it exists for the unknown-FLAG class
         * in docker verb derivation, but it shipped as an unconditional first
         * conjunct — which made the `pull` alternative of the git SAFE pattern
         * unreachable dead code and blocked `… && git pull` on a remote read.
         * Scoping it to the branch it was written for restores that, and takes
         * nothing away: a non-docker sub must still earn a POSITIVE vouch below.
         */
        if (
          tokens.some((t) =>
            MUTATING_VERB_TOKENS.has(_bareWord(t).toLowerCase()),
          )
        ) {
          return false;
        }
        // Docker text this hook could not resolve to a verb is NOT vouched.
        // Under the old denylist an unclassifiable docker command fell through
        // to a span match and was waved; here it fails closed. The guard is
        // deliberately RAW TEXT: a sub whose substitution body mentions docker
        // cannot vouch on its wrapper, independent of extraction limits.
        const verbs = _dockerVerbs(tokens);
        if (verbs.length === 0) return false;
        return verbs.every((v) => v !== null && READ_ONLY_VERBS.has(v));
      }
      /*
       * NON-DOCKER, positionally: the first argv word of the command actually
       * being run, with any `ssh <host>` transport prefix consumed.
       */
      const cmdTokens = _commandTokens(tokens);
      const head = _bareWord(cmdTokens[0] || "").toLowerCase();
      const cmd = _basename(head);
      if (cmd === "git") {
        const verb = cmdTokens
          .slice(1)
          .map((t) => _bareWord(t))
          .find((t) => t.length > 0 && !t.startsWith("-"));
        return (
          verb !== undefined && GIT_READ_ONLY_VERBS.has(verb.toLowerCase())
        );
      }
      // TWO conjuncts, not one: the program must be read-only AND the arguments
      // must leave it that way (§ `_argumentsAreReadOnly`).
      if (READ_ONLY_COMMANDS.has(cmd)) {
        return _argumentsAreReadOnly(
          cmd,
          cmdTokens.slice(1).map((t) => _bareWord(t)),
        );
      }
      /*
       * THE LAST RAW-TEXT MATCH IN THE VOUCH PATH, MOVED ONTO ARGV (round 8).
       *
       * These three are deploy SCRIPTS identified by PATH, and a path is a
       * genuine span — but `sub` is the raw text, which includes spans bash
       * never passes to any program. `_argvTokenCells` already knows a `#`
       * comment is not an argument; this arm did not read it, so the same seam
       * loom#1587 closed for verb derivation and the target claim stayed open
       * here, one arm further down:
       *
       *   docker restart api   # deploy/scripts/dev.sh
       *
       * — a comment vouching for an arbitrary prod-matching sibling, which is
       * `_hasBareToken`'s reported shape with the polarity flipped from "the
       * hatch fires" to "the vouch fires". Testing the joined argv words keeps
       * every real invocation (`bash deploy/scripts/dev.sh`,
       * `./deploy/scripts/dev.sh`, an absolute path, and the same inside an
       * `ssh` payload — all of them ARE argv tokens) and drops the spans that
       * were never argv.
       */
      return SAFE_PATTERNS.some((safe) => safe.test(tokens.join(" ")));
    };

    /*
     * PATTERN SCOPE — every pattern above, and the scope it is adjudicated over
     * (loom#1471 round-5). This table exists because the previous three fixes
     * each changed what a segment meant WITHOUT re-deriving the patterns
     * against the new meaning, and that seam produced a finding every round.
     *
     * A vouch now has THREE possible grounds, all adjudicated over a
     * SUB-INVOCATION and all required UNANIMOUSLY across the sub-invocations of
     * one invocation (`subIsVouched`).
     *
     * THIS TABLE IS HAND-MAINTAINED. It has now been wrong THREE TIMES — "SAFE
     * — all 13" / "PROD — all 6" before round 6, and after round 6 a "count
     * mechanically derived from the live arrays, not recalled" claim that was
     * itself recalled: it listed 6 SAFE patterns against a live array of 3, and
     * a `NON_PROD_TARGET_PATTERNS` array that round 6 had DELETED (0 references
     * repo-wide). The self-description was the worst part — a table asserting
     * its own derivation while hand-written is worse than no table, because it
     * tells the next reader not to check.
     *
     * SO THE CLAIM IS GONE AND A TEST STANDS IN ITS PLACE. `#1587-R7: the
     * PATTERN SCOPE table matches the live arrays` (in the substitution suite)
     * parses the array literals out of this file and asserts the counts below.
     * Edit an array without editing this table and that test goes red. The
     * ARRAYS remain authoritative; this is a reader's index to them, mechanically
     * PINNED rather than mechanically GENERATED.
     *
     * 1. READ-ONLY DOCKER — no pattern; the VERB the command runs must be in
     *    READ_ONLY_VERBS (§ THE READ-ONLY ALLOWLIST, above `main`), derived
     *    positionally from quote-stripped argv tokens. Applies to every sub
     *    whose text mentions `docker`; docker text with no derivable verb is
     *    NOT vouched (fail-closed).
     *
     * 2. NON-PROD TARGET — NO PATTERNS. Round 6 deleted the three span regexes
     *    this entry used to list; the claim is DERIVED (§ `isNonProdTarget`)
     *    from five conjuncts — the `-f` file values, the docker group, the
     *    absence of a daemon redirect, no production component in any token
     *    basename across the invocation, and a non-production `ssh` host.
     *
     * 3. SAFE — 3, all script PATHS (`SAFE_PATTERNS`):
     *      deploy/scripts/{stage,promote,dev}.sh
     *    The `git` / `curl` / `cat|grep|head|tail|ls` regexes this entry used to
     *    list are GONE. Those commands are now adjudicated POSITIONALLY at argv
     *    slot 0 (§ READ_ONLY_COMMANDS, § GIT_READ_ONLY_VERBS), and their
     *    arguments must leave them read-only (§ `_argumentsAreReadOnly`).
     *
     * PROD — 8 regexes (`PROD_PATTERNS`) PLUS one derived signal,
     * `_prodDaemonRedirect` (round 7 counts it here; round 6 added it and left
     * it out of this table). All adjudicated over the whole INVOCATION:
     *   /docker.*compose.*prod.*up/i
     *   /docker.*compose.*prod.*build/i
     *   /docker.*compose.*prod.*restart/i
     *   /docker.*compose.*-f.*docker-compose\.prod/i
     *   /docker\s+restart\s+\S+/             unanchored spans, so an
     *   /docker.*stack\s+deploy\b/i          invocation-scope test subsumes a
     *   /docker.*service\s+(update|scale)\b/i  per-sub one; the ssh pattern
     *   /ssh\s+.*docker\s+(compose|stack)/i  REQUIRES this scope, since the
     *                                        deploy lives in the quoted payload
     *
     * WHY UNANIMITY IS THE FIX. Before quote-awareness a segment held ONE
     * command, so an unanchored SAFE pattern could only vouch for the command it
     * was in. Merging a quoted payload into its invocation — the round-4 ssh fix
     * — made a segment hold SEVERAL, and the five span-matching SAFE patterns
     * silently became load-bearing over a multi-command scope again. Measured:
     *
     *   ssh prod "docker compose ps && docker compose -f …prod.yml up -d"
     *   bash -c  "docker compose -f …prod.yml up -d && docker compose ps"
     *   docker ps " && docker compose -f …prod.yml up -d      (unterminated)
     *   docker ps & docker compose -f …prod.yml up -d          (background &)
     *
     * all exited 0: one `/docker.*ps/i` or `/docker.*logs/i` hit, `continue`,
     * loop ends false. For a command whose separators are ALL quoted, round 5
     * reproduced pre-round-3 behaviour exactly.
     *
     * Requiring EVERY sub-invocation to be read-only keeps the legitimate remote
     * read working — `ssh prod "docker compose logs -f api"`, and even
     * `ssh prod "docker compose ps && docker compose logs -f api"`, are all-read
     * and stay ungated — while a read beside a deploy no longer vouches for it.
     * Anchoring the five patterns instead was measured and REJECTED: it gates
     * both of those reads on the ssh PROD pattern, the false-positive family
     * R4b exists to prevent, and it still misses the unterminated-quote and
     * background-`&` shapes.
     */
    let isProductionDeploy = false;
    /*
     * loom#1484: adjudicate the outer command AND every command-substitution
     * body. Each body is re-split, so separators inside a substitution still
     * produce their own invocations. Append-only — the outer invocations are
     * unchanged, so no previously-blocked command becomes allowed.
     */
    /*
     * loom#1596 F4: heredoc bodies fed to a NON-executor under a QUOTED
     * delimiter are stdin DATA — bash never parses them as commands — so they
     * are blanked before the command is split into candidates
     * (§ `_maskHeredocBodies`, which keeps the unquoted and executor cases).
     * Applied HERE rather than at `command` so `rawCommand` — the outer
     * catch's raw-text re-test after a parser fault — stays deliberately
     * coarse and fail-closed on the text it could not parse.
     */
    const _gateCommand = _maskHeredocBodies(command);
    const _candidateInvocations = _splitInvocations(_gateCommand);
    for (const body of _extractSubstitutions(_gateCommand)) {
      /*
       * PUSH ONE AT A TIME — `push(...arr)` passes every element as a separate
       * ARGUMENT, and past roughly 1.2e5 arguments V8 throws
       * `RangeError: Maximum call stack size exceeded`. That is an ENGINE
       * argument-count limit, not heap, so MAX_SUBSTITUTION_CANDIDATES does not
       * bound it: that cap limits the number of BODIES, while this overflow is
       * driven by the number of INVOCATIONS WITHIN A SINGLE body. One body of
       * `a;` repeated 500k times is one candidate and 500k invocations.
       *
       * Measured on the pre-fix build: the throw landed BEFORE
       * `gatingProdDeploy = true`, so the pre-classification arm of the outer
       * catch exited 0 with EMPTY stdout and stderr — a production deploy
       * allowed silently. The loop cannot overflow this way.
       *
       * This is the INSTANCE fix. The CLASS fix is the raw-text re-test in the
       * outer catch, which refuses whatever else may fault in here later.
       */
      for (const inv of _splitInvocations(body)) {
        _candidateInvocations.push(inv);
      }
    }
    /*
     * EVERY PROD-MATCHING INVOCATION MUST CARRY THE HATCH — loom#1550 round 6.
     *
     * This loop used to `break` at the FIRST invocation matching a PROD pattern
     * and then test `--skip-staging` against that one. Which invocation that is
     * depends only on typing ORDER, and an operator does not choose it — so a
     * DECOY does:
     *
     *   docker restart canary --skip-staging && docker compose -f docker-compose.prod.yml up -d
     *
     * The first invocation is a real (trivial) prod command carrying a real
     * hatch; the second is the actual deploy and carries none. Measured on the
     * round-5 build: exit 0, with the deploy never adjudicated at all.
     *
     * The rule is now unanimity in the same sense SAFE already uses: the hatch
     * ALLOWS only if EVERY prod-matching invocation carries it. So a hatch can
     * never vouch for a deploy beside it, which is the identical defect
     * loom#1471 round-3 closed on the SAFE axis and round-5 closed on the
     * span axis. The alternative — declaring in prose that the hatch is
     * whole-command by construction — is not available: it is precisely the
     * whole-command scope this file's ~200 lines of rationale exist to reject,
     * and it would make the decoy correct behaviour rather than a bug.
     *
     * The scan short-circuits on the FIRST UNHATCHED prod invocation, because
     * from there the verdict is GATE whatever the rest hold. That keeps the
     * cost of the common (blocking) case identical to the old `break`.
     */
    /*
     * THE DAEMON-REDIRECT PROD SIGNAL (loom#1587) — positional, not a span.
     *
     * The eight PROD_PATTERNS above all read the command's own words, and none
     * of them reads the ENDPOINT. So a deploy re-aimed at production by flag
     * rather than by filename matched nothing at all:
     *
     *   docker --context production compose -f docker-compose.dev.yml up -d
     *
     * — a dev compose file, deployed to the `production` context. Adding this
     * as a regex over the raw text would reintroduce the very span class this
     * file has spent six rounds removing (`--profile production-notes` would
     * match), so it is derived: read the VALUE of `--context`/`-H`/`--host`,
     * take its basename, and test the same production-COMPONENT fence the
     * target claim uses.
     *
     * This does NOT block reads against production. It only makes such an
     * invocation eligible for the PROD test, which still runs AFTER the vouch:
     * `docker --context prod compose logs` derives the read-only verb `logs`,
     * is vouched, and never reaches here.
     */
    const _prodDaemonRedirect = (tokens) =>
      _daemonRedirectValues(tokens).some((v) =>
        // Round 8: the endpoint form too, or `-H tcp://prod:2376` names a
        // production daemon that this fence cannot see (§ `_endpointHost`).
        _targetNames(v).some((n) => PROD_COMPONENT_RE.test(n)),
      );

    let unhatchedDeploy = null;
    let hatchedDeploy = "";
    /*
     * Literal `NAME=value` assignments seen SO FAR, in invocation order
     * (§ `_collectAssignments`). Populated before the vouch check so an
     * assignment in a vouched or skipped invocation still informs later ones —
     * `export COMPOSE_FILE=…prod.yml` is itself perfectly ordinary and would
     * otherwise never be recorded.
     */
    const _shellEnv = new Map();
    for (const invocation of _candidateInvocations) {
      _collectAssignments(invocation, _shellEnv);
      const subs = _splitSubInvocations(invocation);
      /*
       * The INVOCATION-scoped facts the target claim needs (loom#1587 round 7,
       * § `isNonProdTarget` conjuncts 4 and 5): every sub's tokens, and every
       * `ssh` host addressed anywhere in the invocation.
       *
       * Built from the subs rather than from `_argvTokens(invocation)` because
       * the latter tokenises a quoted payload as one blob, and `_basename` of a
       * blob is whatever follows its last `/` — which would make the fence
       * depend on where the slashes fell. Re-tokenising each sub is the SAME
       * model every other predicate here reads.
       */
      const subTokens = subs.map((s) => _argvTokens(s));
      const scope = {
        tokens: subTokens.flat(),
        // EVERY ssh in the invocation, nulls INCLUDED — an un-attributable host
        // is the signal conjunct 5 fails closed on (§ `_sshHosts`). Round 7
        // filtered them out here, which is where that fence lost its teeth.
        sshHosts: subTokens.flatMap((t) => _sshHosts(t)),
        // loom#1596 F2: an env-carried daemon redirect denies the target claim
        // exactly as the flag form does (§ `_prodEnvDaemon`).
        envDaemonProd: _prodEnvDaemon(_shellEnv),
      };
      // Vouched ONLY if EVERY command inside this invocation is a non-prod
      // target or a genuinely read-only one (§ THE READ-ONLY ALLOWLIST).
      if (subs.every((sub) => subIsVouched(sub, scope))) continue;
      /*
       * THE TEXT THE PROD SIGNALS ARE ADJUDICATED OVER (loom#1596).
       *
       * Three transforms, in this order, and the order is load-bearing:
       *   1. `_normalizeIFS` — before the head is read, or `ssh${IFS}host …`
       *      parses its head as `ssh${IFS}host` and matches no executor.
       *   2. `_prodScanText`  — drop each DATA CONSUMER's arguments, so a
       *      commit message or `--title` about a deploy is not a deploy.
       *   3. `_expandVars`    — resolve literal `$NAME` references, so the
       *      split-invocation carrier reaches the spans as the text the shell
       *      will actually run.
       *
       * EVERY prod signal reads this same text — the eight spans AND the four
       * derived predicates. Running a derived predicate on the RAW invocation
       * instead would re-open F4 through the back door: `gh issue create
       * --title 'docker restart tools-api fails'` tokenises to a `docker`
       * token followed by `restart`, so a parsed-verb predicate would fire on
       * the very mention the scan text exists to discount.
       */
      const _scanText = _expandVars(
        _prodScanText(_resolveTrivialSubstitutions(_normalizeIFS(invocation))),
        _shellEnv,
      );
      const _scanTokens = _argvTokens(_scanText);
      if (
        !PROD_PATTERNS.some((prod) => prod.test(_scanText)) &&
        !_prodDaemonRedirect(_scanTokens) &&
        !_prodBareRestart(_scanTokens) &&
        !_prodSshDocker(_scanTokens) &&
        !_prodEnvRedirect(_shellEnv, _scanTokens)
      ) {
        continue;
      }
      isProductionDeploy = true;
      if (_hasBareToken(invocation, "--skip-staging")) {
        hatchedDeploy = invocation;
        continue;
      }
      unhatchedDeploy = invocation;
      break;
    }

    if (!isProductionDeploy) {
      clearTimeout(timeout);
      process.exit(0);
      return;
    }

    // The invocation the PROD patterns matched and the operator did NOT hatch.
    // `--skip-staging` is honoured ONLY as a bare token of a prod-matching
    // invocation, never of the whole command (loom#1551).
    const deployInvocation = unhatchedDeploy;

    /*
     * Skip-staging escape hatch — allow, but LOUDLY, and only when the operator
     * actually asked for it (loom#1551).
     *
     * This shipped as `command.includes("--skip-staging")`: a quote-unaware
     * substring of the WHOLE command, in a file whose entire ~200-line design
     * rationale exists to reject whole-command scope. The adjudication loop
     * below was rebuilt three times specifically to move SAFE and PROD off
     * whole-command matching; this one check was left behind. Measured, against
     * a positive control returning 2 on the same build:
     *
     *   echo 'deploying without --skip-staging' ; docker compose … prod … up -d   -> 0
     *   echo "--skip-staging" && docker compose … prod … up -d                    -> 0
     *   git commit -m "--skip-staging" ; docker restart tools-api                 -> 0
     *   docker compose … prod … up -d --skip-staging-not                          -> 0
     *
     * Note the first: the sentence that DISABLES the gate says the operator is
     * not skipping staging. The fourth needs no quoting at all — a substring
     * match honours a flag nobody passed.
     *
     * THREE SCOPES TIGHTENED, all required:
     *   1. The text searched is the invocation the PROD patterns MATCHED, not
     *      the whole command — so a flag in an unrelated command beside the
     *      deploy no longer reaches it. Round 6 strengthened this from "the
     *      first prod match" to "EVERY prod match" (§ above the loop): one
     *      hatched invocation must not wave an un-adjudicated one beside it.
     *   2. The match is a BARE argv token via `_hasBareToken`, reading the same
     *      quote cells `_splitInvocations` does — so quoted data never counts,
     *      and `--skip-staging-not` is a different token.
     *   3. The token must be REACHABLE as argv: round 6 excluded `#` comments
     *      and command-substitution bodies, neither of which bash passes to the
     *      program at all (see `_hasBareToken`).
     *
     * BEHAVIOUR CHANGE, stated because loom#1551 anticipates it: a flag INSIDE a
     * quoted payload — `ssh prod "docker compose … up -d --skip-staging"` — no
     * longer honours the hatch. It was never an argument to this hook; the
     * recovery is to put it outside the quotes, where it reads as a bare token
     * of the same invocation. Fail-closed with a loud, documented recovery.
     */
    if (deployInvocation === null) {
      /*
       * loom#1551 second defect — THE WARNING WAS EMITTED ON AN EXIT-0 PATH.
       * A `console.error` immediately followed by `process.exit(0)` is not
       * reliably surfaced by a PreToolUse host: on a non-block verdict the
       * agent's delivery channel is `hookSpecificOutput.additionalContext`, not
       * stderr. So the gate was disabled AND said nothing the operator saw —
       * the silent-disablement failure mode `security.md` § "Secure-Default For
       * A New Security Feature" exists to block.
       *
       * `halt-and-report`, not `block`: the operator explicitly asked to skip,
       * and the signal is a lexical token match, which `hook-output-discipline.md`
       * MUST-2 forbids grounding `block` on. Exit code stays 0 — the deploy
       * proceeds — but the agent MUST surface it.
       */
      const out = instructAndWait({
        hookEvent: "PreToolUse",
        severity: "halt-and-report",
        what_happened:
          "Production deploy ALLOWED with the staging gate DISABLED — `--skip-staging` " +
          `was passed as a bare argument of: ${hatchedDeploy.slice(0, 160)}`,
        why: "deploy-hygiene.md — --skip-staging is the documented emergency hatch, and it deliberately skips the .staging-passed verification entirely. Nothing about this deploy has been staged. security.md § Secure-Default For A New Security Feature: a protection whose disablement is silent is the failure mode; this disablement must be loud.",
        agent_must_report: [
          "Quote the exact deploy command that was allowed",
          "State plainly that staging verification did NOT run — this deploy is UNVERIFIED",
          "Document the reason for the bypass in deploy/deployment-config.md, in this turn",
          "Confirm with the user that an unstaged production deploy was intended",
        ],
        agent_must_wait:
          "Surface this to the user before reporting the deploy as successful. Do not treat a --skip-staging deploy as a verified one.",
        user_summary:
          "Production deploy allowed WITHOUT staging verification (--skip-staging)",
      });
      clearTimeout(timeout);
      console.log(JSON.stringify(out.json));
      process.exit(out.exitCode);
      return;
    }

    // From here the command IS a production deploy and the operator did NOT
    // pass the escape hatch, so every remaining exit is a gate verdict.
    gatingProdDeploy = true;

    // Locate repo root by walking up from cwd or script location
    let repoRoot;
    try {
      // loom#1471 shard 3. This resolves the root the `.staging-passed` marker is
      // read from, and the next call resolves the HEAD that marker is compared
      // against — i.e. BOTH halves of the staging gate. Inheriting the ambient
      // environment let `GIT_DIR`/`GIT_WORK_TREE` point both at a decoy repo the
      // attacker prepared with a matching marker, satisfying the gate without
      // staging ever running. Absolute binary + constants-built env closes it.
      const gitBin = resolveGitBinary();
      if (!gitBin) throw new Error("git binary unresolved");
      repoRoot = execFileSync(gitBin, ["rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        timeout: 3000,
        env: gitEnv(),
      }).trim();
    } catch (err) {
      // INDETERMINATE — the staging gate could not run. Refuse; see the
      // fail-open note above the emitBlock helper.
      emitBlock({
        what_happened:
          "Production deploy attempted, but the repository root could not be resolved " +
          `(git rev-parse --show-toplevel failed: ${_reason(err)}). The staging gate did not run.`,
        why: "deploy-hygiene.md — the repo root is where .staging-passed is read from, so an unresolvable root means the staging check was SKIPPED, not passed. security.md § Enforcement-Surface Parity: git that cannot answer ranks TIGHTEST, never a clean negative.",
        agent_must_report: [
          "Quote the exact deploy command that was attempted",
          "State that staging verification did NOT run — this is not a staging failure, it is an unverified deploy",
          "Report the git error verbatim. Common cause: a differently-owned checkout (container bind-mount, CI runner, shared clone). `safe.directory` does NOT apply here — this hook runs git with GIT_CONFIG_GLOBAL=/dev/null, so global config is deliberately not read",
          "Run the deploy from a checkout git can read, OR re-issue with `--skip-staging` AND document the reason in deploy/deployment-config.md",
        ],
        agent_must_wait:
          "Do not retry until git can resolve the repository root, OR the user authorises `--skip-staging` with a documented reason.",
        user_summary:
          "Production deploy blocked — staging could not be verified (git cannot resolve the repo root)",
      });
      return;
    }

    const markerPath = path.join(repoRoot, ".staging-passed");

    // Check that .staging-passed exists.
    // Structural signal per hook-output-discipline.md MUST-2: file existence
    // (fs.existsSync) — not a lexical regex. Block severity is grounded.
    if (!fs.existsSync(markerPath)) {
      emitBlock({
        what_happened: `Production deploy attempted without staging verification (no .staging-passed marker at ${markerPath})`,
        why: "deploy-hygiene.md — staging MUST pass before production deploy; .staging-passed is the structural verification marker written by deploy/scripts/stage.sh",
        agent_must_report: [
          "Quote the exact deploy command that was attempted",
          "State whether staging has been run (run `bash deploy/scripts/promote.sh` or staging+deploy step-by-step)",
          "If emergency bypass is needed, re-issue the command with `--skip-staging` AND document the reason in deploy/deployment-config.md",
        ],
        agent_must_wait:
          "Do not retry until staging has produced .staging-passed at the current commit, OR --skip-staging is passed with a documented reason.",
        user_summary:
          "Production deploy blocked — staging verification missing",
      });
      return;
    }

    // Verify that .staging-passed contains the current commit
    const marker = fs.readFileSync(markerPath, "utf8").trim();
    let currentCommit;
    try {
      // loom#1471 shard 3 — the other half of the gate; see the comment above.
      const gitBin = resolveGitBinary();
      if (!gitBin) throw new Error("git binary unresolved");
      currentCommit = execFileSync(gitBin, ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 3000,
        env: gitEnv(),
      }).trim();
    } catch (err) {
      // INDETERMINATE — the marker exists but there is no HEAD to compare it
      // against, so "staging is current" is unknowable. A marker that cannot be
      // checked for staleness is not a passing gate.
      emitBlock({
        what_happened:
          "Production deploy attempted with a .staging-passed marker that could not be checked for staleness " +
          `(git rev-parse HEAD failed in ${repoRoot}: ${_reason(err)}).`,
        why: "deploy-hygiene.md — the marker is only evidence when it matches the CURRENT commit. With HEAD unresolvable the marker may predate any number of changes, so treating it as a pass verifies nothing. security.md § Enforcement-Surface Parity: git that cannot answer ranks TIGHTEST.",
        agent_must_report: [
          "Quote the exact deploy command that was attempted",
          `State that the staleness check did NOT run against ${repoRoot} — the marker was found but not verified`,
          "Report the git error verbatim (a checkout with no commits, a differently-owned checkout, or a corrupt repository all produce this)",
          "Re-run `bash deploy/scripts/promote.sh` from a checkout git can read, OR re-issue with `--skip-staging` AND document the reason in deploy/deployment-config.md",
        ],
        agent_must_wait:
          "Do not retry until git can resolve HEAD and staging has been re-run at that commit, OR the user authorises `--skip-staging` with a documented reason.",
        user_summary:
          "Production deploy blocked — staging marker present but unverifiable (git cannot resolve HEAD)",
      });
      return;
    }

    const shortHash = currentCommit.substring(0, 7);
    // Structural signal per hook-output-discipline.md MUST-2: process state
    // (git rev-parse) compared against a file content (.staging-passed marker).
    // Mismatch is structural evidence that staging is stale; block is grounded.
    if (!marker.includes(shortHash)) {
      emitBlock({
        what_happened: `Production deploy attempted with stale staging marker (HEAD=${shortHash}, marker contains ${marker.substring(0, 7)})`,
        why: "deploy-hygiene.md — code has changed since staging last passed; staging MUST be re-run against the current commit before production deploy",
        agent_must_report: [
          "Quote the deploy command",
          `State the current HEAD (${shortHash}) and the stale marker (${marker.substring(0, 7)})`,
          "Re-run `bash deploy/scripts/promote.sh` to refresh staging at HEAD before retrying",
        ],
        agent_must_wait:
          "Do not retry until staging has been re-run at the current commit and .staging-passed contains the current HEAD short hash.",
        user_summary: `Production deploy blocked — staging stale (HEAD=${shortHash}, marker=${marker.substring(0, 7)})`,
      });
      return;
    }

    // Staging verified and current — allow production deploy
    console.error(
      `[DEPLOY HOOK] Staging verified (${shortHash}). Allowing production deploy.`,
    );
    clearTimeout(timeout);
    process.exit(0);
  } catch (err) {
    // Unexpected failure. The disposition SPLITS, because the two cases are not
    // alike. Once `gatingProdDeploy` is set the command is known to be a
    // production deploy with no escape hatch, so an unexpected failure is still
    // a gate that did not run — refuse. Before that point the hook cannot even
    // tell what the command is (a malformed or oversized stdin payload gets
    // here), and blocking there would block EVERY Bash call in the session on a
    // parse bug — a worse failure mode than the one being closed, per
    // hook-output-discipline.md MUST NOT § "Detectors that block work the agent
    // has been instructed to perform".
    if (gatingProdDeploy) {
      emitBlock({
        what_happened: `Production deploy attempted, but the staging gate failed unexpectedly: ${_reason(err)}`,
        why: "deploy-hygiene.md — an aborted gate is not a passed gate. The staging verification did not complete, so nothing here says this deploy was verified.",
        agent_must_report: [
          "Quote the exact deploy command that was attempted",
          "State that the staging gate ABORTED — the deploy is unverified",
          `Report the underlying error verbatim: ${_reason(err)}`,
          "Re-issue with `--skip-staging` AND document the reason in deploy/deployment-config.md only if the user authorises proceeding unverified",
        ],
        agent_must_wait:
          "Do not retry until the cause of the hook failure is understood, OR the user authorises `--skip-staging` with a documented reason.",
        user_summary:
          "Production deploy blocked — staging gate aborted before it could verify",
      });
      return;
    }
    /*
     * Pre-classification failure: the classifier never reached a verdict, so
     * `gatingProdDeploy` is still false and the command may be anything at all.
     *
     * BEFORE FALLING OPEN, RE-TEST THE RAW COMMAND TEXT. This is the CLASS fix,
     * not a fix for one crash. Everything above this line — substitution
     * extraction, invocation splitting, quote-state tracking — is a parser, and
     * a parser can fault on a crafted input in ways not yet enumerated. Each
     * time it does, the pre-classification arm cannot tell "the parser died on a
     * production deploy" from "this was not a deploy", and answers ALLOW.
     *
     * A raw-string regex over PROD_PATTERNS needs no parser, so it cannot die
     * the way the parser can. If the deploy text is present anywhere in the
     * command, this refuses.
     *
     * WHAT THAT DOES AND DOES NOT COVER — corrected in round 3, because round 2
     * claimed it converted "every present and future parser-fault-on-a-deploy
     * into a loud block", and that is broader than the truth. `rawCommand` is
     * assigned only AFTER the tool is known to be Bash (see the assignment
     * below), so a fault BEFORE that line arrives here with `rawCommand` still
     * "", which matches no pattern, and this arm exits 0. The first conjunct
     * covers faults AFTER the command text is in hand — which is the classifier,
     * i.e. the parser this was written for — and nothing earlier.
     *
     * THE SECOND CONJUNCT IS WHY THE EARLIER WINDOW IS NOT SIMPLY OPEN. On a
     * fault before the assignment, `rawStdinText` is nonetheless in scope and
     * usually holds the whole payload, command included; round 2 held that
     * evidence and never consulted it. Testing it too is the same asymmetry this
     * PR closed one layer up (§ UNREADABLE STDIN), applied to the layer below.
     * It uses the linear token prescreen, not PROD_PATTERNS, for the reason given
     * at DEPLOY_TOKENS: the payload may be megabytes and those patterns
     * backtrack catastrophically.
     *
     * Its trigger set in THIS build is, as far as could be constructed, empty —
     * the concrete shapes that once faulted early (a bare JSON string, array,
     * number, boolean, `null`) are now caught above by § UNREADABLE STDIN before
     * they can throw. It is kept because this arm exists precisely for faults
     * "not yet enumerated", and an unenumerated fault has no reason to respect
     * the boundary that makes the first conjunct sufficient today.
     *
     * SCOPE, STATED PLAINLY. This is deliberately COARSER than the classifier:
     * it has no SAFE_PATTERNS, no invocation splitting and no quote awareness,
     * so on a fault it can refuse a command the classifier would have allowed
     * (a `docker compose -f docker-compose.prod.yml logs`, say). That is the
     * correct direction for a deploy gate and it fires ONLY on the fault path —
     * the non-faulting path is completely unchanged. `--skip-staging` is NOT
     * honoured here either: the escape hatch is a decision, and nothing on this
     * path is in a position to make one.
     *
     * A command that is NOT a prod deploy still exits 0, so a parse bug still
     * cannot block every Bash call in the session — the property the original
     * fail-open note was protecting (hook-output-discipline.md MUST NOT
     * § "Detectors that block work the agent has been instructed to perform").
     */
    if (
      PROD_PATTERNS.some((prod) => prod.test(rawCommand)) ||
      DEPLOY_TOKENS.test(rawStdinText)
    ) {
      emitBlock({
        what_happened: `The deploy gate FAULTED before it could classify the command, and production-deploy text is present in the command or in the raw tool payload: ${_reason(err)}`,
        why: "deploy-hygiene.md — an aborted gate is not a passed gate. The command parser did not complete, so nothing here says this deploy was verified against staging. A fault while a production deploy is on the wire is refused, never allowed.",
        agent_must_report: [
          "Quote the exact command that was attempted",
          "State that the deploy gate ABORTED before classification — the deploy is unverified",
          `Report the underlying error verbatim: ${_reason(err)}`,
          "Report that production-deploy text was found on the raw command or, if the fault preceded classification, in the raw tool payload",
          "Re-issue the command in a simpler form so the gate can classify it, OR ask the user to authorise `--skip-staging` with a documented reason in deploy/deployment-config.md",
        ],
        agent_must_wait:
          "Do not retry until the cause of the hook failure is understood, OR the user authorises proceeding unverified.",
        user_summary:
          "Production deploy blocked — the deploy gate crashed before it could check staging",
      });
      return;
    }
    clearTimeout(timeout);
    process.exit(0);
  }
}

main();
