#!/usr/bin/env node
/**
 * artifact-coverage-guard.js — the detector for
 * `coc-artifact-eval-coverage.md` MUST-1 / MUST-4: a `.claude/` prose artifact
 * edited with NO eval coverage landing for it.
 *
 * @hook-event: PostToolUse:Edit|Write (verification) — the edit is the subject,
 *   and it must have HAPPENED before the question can be asked. At `PreToolUse` the
 *   file's post-edit identity is not yet on disk and a NEW artifact does not
 *   exist at all, so the predicate would be reading the wrong tree. The matcher
 *   is `Edit|Write` and not `*` — `hook-event-selection.md` MUST-3 FAILs a
 *   narrow class registered without a matcher, and a `*` matcher would pay a
 *   node spawn on every Bash/Read/Grep call to reach an immediate passthrough.
 *   This is the event the rule's own Wiring registered for this detector.
 *
 * ARMED 2026-09-18 — registered as a DISPATCHER detector in `.claude/hooks/dispatch-registry.json`
 *   (`:382-386`, inside the `PostToolUse` block at `:238`, group matcher `Edit|Write` at `:360`),
 *   the event this file's own `@hook-event` declares — NOT directly in `.claude/settings.json`. NO registration-state marker is
 *   carried, deliberately: every value in `reconcile-hook-surfaces.mjs::MARKER_VOCABULARY` asserts
 *   NON-REGISTRATION, so a registered hook carries none, and `detection-dispatch-check.mjs` reds
 *   `authored-unwired-marker-contradicted` on one that does. Co-owner-authorized.
 *
 *   ⛔ THE PREDICATE WAS NEVER DEFECTIVE. IT WAS REFUSED REGISTRATION ON A MEASUREMENT ERROR,
 *   and that error is worth stating precisely because it is this repo's own named failure class.
 *   The refusal cited "fires on 576/669 in-scope prose artifacts (86.1%)" as the guard's noise
 *   rate (loom's arming adjudication of 2026-09-18, a workspace record that does not ship).
 *   That figure is a CENSUS — how much of the corpus is uncovered — and this guard fires on EDITS.
 *   Banking a census as a rate is `instrument-discipline.md` MUST-4: an instrument sound for one
 *   question read as the answer to a second.
 *
 *   THE RATE, MEASURED at arming, 2026-09-18 (STALE since — see § STATE + INPUT SET), per edit
 *   event from `git log --name-only --diff-filter=AM` over in-scope artifact paths (control: 159
 *   artifact touches in the 300-commit window, so a zero would have been readable):
 *     last  300 commits:  17 of 159 in-scope touch events fire = 10.7%
 *     last 1500 commits: 175 of 658                            = 26.6%
 *   Neither is 86.1%. Edits land disproportionately on COVERED artifacts, because those are the
 *   ones under active `/codify` work.
 *
 *   AND THE FIRINGS ARE TRUE. A systematic every-kth sample across all five strata (40 firings)
 *   read individually: 38 TRUE positives, 2 contested (frontmatter-less reference pages carrying
 *   zero MUSTs). Rules 8/8, agents 8/8, commands 8/8, SKILL.md 8/8, topic files 6/8.
 *
 *   NARROWING WAS REFUSED, AND THAT IS THE LOAD-BEARING DECISION. The one discriminator that
 *   looked real — skill frontmatter — is DEAD: at arming, 2026-09-18, the single skill this repo
 *   actually registered (`background-process-discipline`) had NO frontmatter, so narrowing on it
 *   would have excluded the corpus's own only positive example. As of 2026-09-27 a second
 *   `type:"skill"` row exists (`trinity`, which HAS frontmatter); the one no-frontmatter
 *   registered skill is still enough to make that discriminator unsound. Restricting to `SKILL.md` still left 177/260 = 68% at
 *   arming, 2026-09-18 (see § STATE + INPUT SET).
 *   Every available narrowing lowers the number without changing the truth, which is teaching the
 *   instrument to report the answer we want.
 *
 *   A SECOND DEFECT RUNS THE OPPOSITE WAY AND IS DELIBERATELY NOT FIXED HERE. The manifest id
 *   index is TYPE-BLIND — one flat id set across all rows — so a `type:"rule"` row SILENCES a
 *   same-stemmed SKILL. Measured at arming, 2026-09-18 (see § STATE + INPUT SET), over all 14
 *   quiet skill files: 1 genuine, 13 type-blind
 *   collisions (the 444-line skill `skills/12-testing-strategies/probe-driven-verification.md` is
 *   silenced by the rule row for `rules/probe-driven-verification.md`, a different artifact with
 *   different mandatory probe properties; the whole conformance-walk skill dir is silenced by one
 *   rule row). So at arming skills were ~99.8% uncovered and 86.1% UNDER-stated the gap. The fix makes this
 *   guard fire MORE, which is a behaviour change with real blast radius and is a decision, not a
 *   repair — it is recorded in the lib's § SCOPE OF SILENCE and owed to the co-owner.
 *
 *   ONE CONFIRMED FALSE-POSITIVE CLASS, left alone with reasons: MUST-1's same-codify plumbing
 *   carve-out. The verdict is a property of the FILE, never the diff, so the predicate cannot see
 *   it; the guard already routes it via `agent_must_report` item 4. Narrowing it would trade a
 *   false positive for a false NEGATIVE on a lexical MUST/BLOCKED scan and would not move the
 *   census at all.
 *
 *   ARMED IS NOT PROVEN EFFECTIVE: registration is measured here, live firing is not.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SEVERITY — `advisory`, which is the tier the rule registered, and the cap is
 * argued rather than inherited
 * ─────────────────────────────────────────────────────────────────────────────
 * Not `block`, and the honest reason is NOT "the signal is lexical" — it is not.
 * A manifest row's presence and a probe file's existence are a parsed-document
 * fact and a filesystem fact respectively, exactly the class
 * `hook-output-discipline.md` MUST-2 says MAY carry more. The cap is a
 * TIMING claim instead: the coverage a newly-added artifact owes may
 * legitimately land LATER IN THE SAME SESSION — MUST-1 binds the `/codify`, not
 * the keystroke — so at the instant of the edit an absent row is not yet a
 * violation, only a prediction of one. A detector that refused the write would
 * make the mandated authoring order impossible (you cannot register a row for a
 * file that does not exist). So the finding is a PROMPT, never a refusal, and
 * the enforcement that DOES red is `coc-eval-all.mjs` + `registration-preflight.mjs`
 * in CI, where the session is over and the prediction has become a fact.
 *
 * Not lower than advisory either: the surfaces it reads are real, so the finding
 * is a stated fact about this tree and not a guess, and `PostToolUse` has no
 * register beneath advisory that still reaches the agent.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS HOOK CANNOT SEE — read before citing its silence
 * ─────────────────────────────────────────────────────────────────────────────
 * It answers PRESENCE, never ADEQUACY. Silence over a registered artifact means
 * "a row exists", NOT "this artifact is probed well" — whether a probe set
 * actually covers the artifact's mandatory semantic properties is the
 * judgment-bearing question the rule leaves to gate-review, and no read of a
 * manifest key answers it (`instrument-discipline.md` MUST-4). It is also
 * deliberately silent on `.claude/hooks/**` and `.claude/bin/**`, whose mandated
 * tier is a structural fixture set `coc-eval-all.mjs` already reds in CI; firing
 * on those too would be the second finding `specs-authority.md` Rule 9 forbids.
 * The full scope-of-silence roster is `lib/artifact-coverage.js` § SCOPE OF
 * SILENCE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FIRING RATE — the census is NOT the rate, and conflating them is what got
 * this guard refused registration
 * ─────────────────────────────────────────────────────────────────────────────
 * A CORPUS CENSUS of this predicate — running it over every in-scope file as
 * though each had just been edited — returned 576 of 669 (86.1%) at graduation,
 * superseded by the 2026-09-27 re-run (578 of 683, 84.6% — § STATE + INPUT SET
 * below). Either figure is a census, NOT this guard's firing rate. It answers "how
 * much of the corpus is uncovered", a question about the CORPUS; the guard fires
 * on EDITS, and the edits this repo actually makes land disproportionately on
 * the covered artifacts, because those are the ones under active `/codify` work.
 * Reading the census as the noise rate is `instrument-discipline.md` MUST-4 — an
 * instrument sound for one question banked as the answer to a second.
 *
 * MEASURED at arming, 2026-09-18 (STALE since — not re-run; see § STATE + INPUT
 * SET), per EDIT EVENT, over `git log --name-only --diff-filter=AM` restricted
 * to in-scope artifact paths: 17 of 159 touch events (10.7%) over the last 300
 * commits, 175 of 658 (26.6%) over the last 1500. Neither was the census figure.
 *
 * The census firings are also TRUE ON THE MERITS, which is why the fix is NOT a
 * narrower predicate. At arming, 2026-09-18 (STALE since — not re-sampled),
 * 40 firings sampled (systematic every-kth over each sorted stratum): 38 true
 * positives, 2 contested. Re-measured 2026-09-27 (MUST
 * / BLOCKED counted as TOKENS, `grep -o`): all 32 firing rules are MUST-bearing
 * and none carries an IN-FILE Trust Posture Wiring section (one,
 * framework-first, keeps its wiring in `skills/32-trust-posture/wiring/`, and
 * several keep it in their rule EXTRACT — e.g.
 * `guides/rule-extracts/verify-resource-existence.md:166`,
 * `guides/rule-extracts/observability.md:58`,
 * `guides/rule-extracts/testing.md:148` — so "none in-file" is NOT "none
 * anywhere") —
 * `rules/cc-artifacts.md` (264 lines, 27 MUSTs) and `rules/testing.md` (302 lines, 39 MUSTs, 22 BLOCKEDs) are both in
 * the firing set with no row and no probe. ALL 39 agents fire; the manifest
 * holds ZERO `type:"agent"` rows. The 2 contested are reference PAGES
 * inside a skill (no frontmatter, no MUST) rather than artifacts in their own
 * right — and no path or frontmatter signal separates them from the normative
 * topic files a baseline rule delegates its BLOCKED corpus to, so narrowing on
 * one would ALSO drop `background-process-discipline` — at arming, 2026-09-18,
 * the single genuinely-registered skill, and itself a no-frontmatter topic
 * file (as of 2026-09-27, `trinity` is a second registered skill). Narrowing here would be teaching the instrument to
 * report the answer we want.
 *
 * STATE + INPUT SET (`instrument-discipline.md` MUST-6). The 576/669 (86.1%)
 * census above was the figure at graduation (93 non-`_` manifest rows). RE-RUN
 * 2026-09-27 with the same predicate and walk: `eval-manifest.json` 94 non-`_`
 * rows; 683 in-scope files DISCOVERED by walking `.claude/{rules,agents,
 * commands,skills}/**.md` (not a hand-typed list); census 578 of 683 = 84.6%.
 * The per-EDIT rates (10.7% / 26.6%) were NOT re-run by that recipe and are
 * STALE — not false, UNANSWERED until re-measured. CHEAP FRESHNESS PREDICATE —
 * re-derive rather than citing these figures if EITHER input moves:
 *   node -e 'const m=require("./.claude/test-harness/eval-manifest.json");
 *     console.log(Object.keys(m).filter(k=>!k.startsWith("_")).length)'   # 94
 *   node -e 'const f=require("fs"),p=require("path"),l=require("./.claude/hooks/lib/artifact-coverage.js");
 *     let n=0;const w=d=>{for(const e of f.readdirSync(d,{withFileTypes:true})){const q=p.join(d,e.name);
 *     if(e.isDirectory())w(q);else if(e.name.endsWith(".md")&&l.classifyArtifactPath(q).inScope)n++}};
 *     ["rules","agents","commands","skills"].forEach(s=>w(".claude/"+s));console.log(n)'  # 683
 * If either differs, the census figures are STALE — not false, UNANSWERED
 * until re-run.
 *
 * FAILS OPEN ON EVERY UNKNOWN (`cc-artifacts.md` Rule 7): unparseable payload,
 * missing `file_path`, an absent or unparseable `eval-manifest.json`, an
 * unreadable deferrals registry, a thrown `existsSync`, a thrown require, the
 * internal timer expiring — all return `{continue:true}`. The deliberate
 * degradations are both toward silence: an underivable probe-path shape
 * withholds the finding rather than guessing a path, and an unreadable
 * deferrals registry is treated as EMPTY only for the authorship arm while the
 * manifest's own two declaration arms still withdraw the match.
 *
 * WRITES NOTHING. The reads performed DIRECTLY in this file are one bounded
 * stdin read, realpaths of the edited file, the project dir and (step 1) the
 * edited file's DIRECTORY,
 * `isRegisteredCheckout`'s lstat of `<top>/.git` plus at most two 4 KiB
 * non-blocking fd reads (the gitfile and its back-link, each `fstat`-checked)
 * and one realpath, the eval-manifest and the phase2-deferrals registry (each
 * read WHOLE through `readWholeRegularFile`: symlinks followed as pre-lane, capped
 * at 64 MiB (`ZERO_SIZE_READ_CAP`), opened non-blocking and `fstat`-checked so a FIFO is refused), and
 * an `existsSync` per candidate probe path — the last three resolved against
 * the project dir when the edited path lies under it and is in scope there
 * (STEP 1, no git at all), else against the EDITED FILE's own git toplevel when
 * that toplevel is a REGISTERED checkout (the main worktree, or a linked
 * worktree whose `<common>/worktrees/<x>/gitdir` back-link names it — which
 * implies `treeIsCoherent`) of the project dir's repository (same git common
 * dir), and against `CLAUDE_PROJECT_DIR` otherwise; STEP 2 costs at most TWO
 * read-only `git rev-parse` calls (the shared
 * `lib/git-checkout-proof.js::gitTreeProof`, whose own git-binary resolution
 * probes and realpaths are that module's, not listed here), run only for a path that passes
 * BOTH the in-`.claude/` string pre-filter (`artifact-coverage-guard.js:629-635`)
 * and the prose-artifact scope filter (`artifact-coverage-guard.js:644-647`).
 * The manifest is READ-ONLY here and is owned elsewhere. No sink, no ledger,
 * no receipt, no network.
 *
 * Origin: graduated 2026-09-13 from `phase2-deferrals.json::deferrals`
 * ["coc-artifact-eval-coverage.md#artifact-edit-without-coverage"].
 */

"use strict";

// Bounded timer per `cc-artifacts.md` Rule 7, set under the registered 6s
// timeout (`.claude/hooks/dispatch-registry.json:384-385`). It can fire only
// BETWEEN synchronous steps: during a blocking call (each `spawnSync` git, each
// sync fs read) the event loop is stalled and this timer CANNOT run, so on a
// genuine overrun inside such a call it is the host/engine's kill at 6s that
// fires, not this passthrough. Every git call is therefore itself bounded (2s)
// and every read non-blocking, keeping the sum under the timer. The work is the
// manifest + deferrals reads, per-probe `existsSync`, `isRegisteredCheckout`'s
// lstat + two bounded 4 KiB reads + realpaths, step 1's realpath of the edited
// file's directory, and at most TWO bounded (2s each)
// `git rev-parse` calls —
// the edited file's repository and the project dir's — see resolveAuthorityRoot.
const TIMEOUT_MS = 5000;
let fallback = null;

const path = require("node:path");
const fs = require("node:fs");
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

function passthrough(context) {
  if (fallback) clearTimeout(fallback);
  try {
    const out = { continue: true };
    if (context) {
      out.hookSpecificOutput = {
        hookEventName: "PostToolUse",
        additionalContext: context,
      };
    }
    process.stdout.write(JSON.stringify(out) + "\n");
  } catch {}
  process.exit(0);
}

/** One line per finding, each under its OWN severity class. */
function renderFindingLines(findings) {
  return findings
    .map((f) => `- [${f.severity}] ${f.rule_id}: ${f.evidence}`)
    .join("\n");
}

/**
 * The WHOLE of a regular file, or null — `readFileSync`'s semantics (symlinks
 * FOLLOWED; read to the size `fstat` reported at open, or to EOF when that size
 * is 0) with TWO deliberate differences: it is opened `O_NONBLOCK` and
 * `fstat`-checked, so a FIFO is refused BEFORE any read can block the event
 * loop past this hook's own timer (measured, case 21); and every read, sized or
 * size-0, is capped (`ZERO_SIZE_READ_CAP`), where `readFileSync` refuses only
 * ~2 GiB, because a synchronous read of a huge or ever-growing file would outlive
 * the host kill and no timer can interrupt it — over the cap is unreadable, which fails open like
 * any other unreadable authority. No `O_NOFOLLOW` here, on
 * purpose: a symlinked manifest was read pre-lane and still is (case 23). As in
 * `readBounded`, the `fstat` is the contract, not the measured defence: an
 * empty FIFO opened non-blocking reads as "" and fails to parse, so dropping
 * the fstat alone reds no case (measured); `O_NONBLOCK` is what case 21 pins.
 */
// 64 MiB: over 300x the larger authority (180 KB on 2026-09-27), so it never
// truncates a real file; it bounds both a sized read and a size-0 EOF loop
// (the name predates the sized-read cap).
const ZERO_SIZE_READ_CAP = 64 * 1024 * 1024;

function readWholeRegularFile(file) {
  const c = fs.constants;
  const fd = fs.openSync(file, c.O_RDONLY | (c.O_NONBLOCK || 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    // Bounded at the size captured at open, as `readFileSync` is: a file being
    // appended to faster than it is read would otherwise never reach EOF, and
    // this synchronous loop would outlive the hook's own timer. NOT pinned by a
    // case: it needs a concurrent writer, which is not cheaply deterministic
    // (measured: replacing the bound with an EOF-only loop reds nothing).
    if (st.size === 0) {
      // A regular file may report size 0 yet have content (as `readFileSync`
      // allows for): read to EOF in chunks, capped — see the docblock. NOT
      // pinned by a case: no file this test harness can create reports size 0
      // with content on this platform (MEASURED: dropping this branch or its cap
      // reds nothing), so the branch rests on `readFileSync` parity alone.
      const chunks = [];
      const chunk = Buffer.alloc(64 * 1024);
      let seen = 0;
      for (;;) {
        const n = fs.readSync(fd, chunk, 0, chunk.length, null);
        if (n === 0) break;
        seen += n;
        if (seen > ZERO_SIZE_READ_CAP) return null;
        chunks.push(Buffer.from(chunk.subarray(0, n)));
      }
      return Buffer.concat(chunks).toString("utf8");
    }
    // Same cap for a sized file: `readFileSync` refuses ~2 GiB outright, and a
    // planted sparse file must not zero-fill and read synchronously past the
    // host kill. Over the cap is unreadable, which the callers treat as unknown.
    if (st.size > ZERO_SIZE_READ_CAP) return null;
    const buf = Buffer.alloc(st.size);
    let total = 0;
    while (total < st.size) {
      const n = fs.readSync(fd, buf, total, st.size - total, null);
      if (n === 0) break;
      total += n;
    }
    return buf.toString("utf8", 0, total);
  } finally {
    fs.closeSync(fd);
  }
}

function readJson(abs) {
  try {
    const text = readWholeRegularFile(abs);
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

/** The edited file's realpath, or null when it will not resolve. A syscall, no subprocess. */
function realFileOf(filePath) {
  try {
    return fs.realpathSync(path.resolve(PROJECT_DIR, filePath));
  } catch {
    return null;
  }
}

/**
 * Could ANY root make this path an in-scope artifact? Every `rel` the predicate
 * later sees is a suffix of the given or the real path starting at a `.claude/`
 * segment boundary (`toRepoRelative` either strips the root prefix or recovers
 * such a tail), so classifying every such tail is a superset of the final
 * classification: `false` here means `false` there, and the git spawn is skipped
 * for `.claude/hooks/**`, `.claude/bin/**` and every other non-prose subtree.
 */
function anyClaudeTailInScope(lib, candidates) {
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const p = c.replace(/\\/g, "/").trim();
    for (let i = p.indexOf(".claude/"); i !== -1; i = p.indexOf(".claude/", i + 1)) {
      if (i !== 0 && p[i - 1] !== "/") continue;
      if (lib.classifyArtifactPath(p.slice(i)).inScope) return true;
    }
  }
  return false;
}

/**
 * At most `max` bytes of a REGULAR file, read through an fd — never the whole
 * file — or null. Opened `O_NONBLOCK` so a FIFO at the path cannot block the
 * open: a synchronous blocked open stalls the event loop, so this hook's own fallback timer never fires and the
 * host timeout eats the finding (measured, case 16). The flags are absent on
 * Windows (`|| 0`), where a FIFO cannot sit at a plain path anyway. Both reads
 * in `isRegisteredCheckout` (gitfile AND back-link) go through here; the
 * manifest and deferrals JSON reads do NOT — they use `readWholeRegularFile`
 * (symlinks followed, whole file, case 21 / 23). The
 * `isFile` fstat and `O_NOFOLLOW` are the contract ("regular file only, never
 * through a symlink"), NOT measured defences: dropping either alone reds no
 * case. For fstat, a positional read on a non-blocking FIFO throws ESPIPE,
 * which the caller's catch turns into a fallback; for O_NOFOLLOW, the lstat in
 * `isRegisteredCheckout` already refuses a symlinked gitfile, and a symlinked
 * back-link lies outside the threat model. Both matter only in a check-to-open
 * race.
 */
function readBounded(file, max = 4096) {
  const c = fs.constants;
  const fd = fs.openSync(file, c.O_RDONLY | (c.O_NOFOLLOW || 0) | (c.O_NONBLOCK || 0));
  try {
    if (!fs.fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(max);
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, total, max - total, total);
      if (n === 0) break;
      total += n;
      if (total >= max) break;
    }
    return buf.toString("utf8", 0, total);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Is `top` (as git reported it, already realpath'd) a checkout git itself
 * REGISTERED for the repository whose common dir is `common`? Filesystem reads
 * only: an lstat of `<top>/.git`, at most two bounded reads (the gitfile and the
 * entry's back-link), and a realpath of the entry (or of `.git` in the main
 * arm). Either the MAIN worktree — `<top>/.git` is a real directory and IS the
 * common dir — or a LINKED worktree — `<top>/.git` is a gitfile naming an entry
 * DIRECTLY under `<common>/worktrees/`, whose back-link file `gitdir` names
 * `<top>/.git` LEXICALLY. git records the back-link RESOLVED even for a
 * worktree added through a symlinked parent — MEASURED on git 2.54.0, case 17
 * of `.claude/test-harness/tests/artifact-coverage-guard-root.test.mjs` — so a real worktree
 * matches, and a symlink planted where a stale worktree stood does not.
 * That lexical match already means the back-link passes through NO symlink —
 * `top` is realpath'd and `<top>/.git` was just lstat'd as a regular file — so
 * a separate realpath-equals-itself check is not repeated (MEASURED: it and the
 * lexical match each refuse case 13 alone; dropping both reds it).
 * ABSORBED GUARDS, disclosed: the `!st.isFile()` arm and `readBounded`'s
 * `O_NOFOLLOW` each refuse a `.git` SYMLINK to a regular gitfile on their own
 * (the arm by lstat; `O_NOFOLLOW` by an ELOOP throw that the caller's catch
 * turns into the fallback) — MEASURED: dropping either alone reds nothing,
 * dropping both reds case 18fo, so the PAIR is the defence and each is
 * contract-only alone. Likewise the `!m`, `!back`, `!tree.top || !tree.common`,
 * `!realFile`, `gitfile === null` and `backRaw === null` guards are absorbed
 * (MEASURED: dropping each alone reds nothing) — a null for `m`, `tree` or
 * `realFile` throws on its next use into the catch; a null gitfile makes the
 * regex find no match, so `!m` catches it; a null back-link makes `.trim()`
 * throw (TypeError) into the catch; and an empty back-link resolves to the
 * entry itself, which fails the lexical comparison. Every one fails toward the
 * pre-lane pair.
 * It implies `treeIsCoherent` (`lib/git-checkout-proof.js:164-195`), a strict
 * superset of these two shapes, so that check is not repeated.
 * THREAT MODEL: this fences PLANTED files — a `.git` file or directory written
 * into the tree. Any actor that can run `git worktree add` (which writes
 * `<common>/worktrees/`, the agent included) registers a real checkout and is
 * OUTSIDE the model. One residual is INSIDE it and accepted: it needs only
 * FILE writes, no `git worktree add` — a plain directory created at a stale,
 * unpruned worktree's recorded path, plus a `.git` file there naming that
 * still-existing `<common>/worktrees/<x>` entry, IS accepted (a symlink at that
 * path is not), which is what git itself does with that path. Its reach is
 * bounded to files INSIDE that planted directory, and to STEP 2 (it must lie
 * outside the project dir or out of scope there): only an edit landing there
 * is judged by the manifest planted beside it. Re-reading `<top>/.git` after git answered is the same
 * check-to-use TOCTOU class disclosed at `lib/git-checkout-proof.js:64-69`.
 * No lib export answers this — `pcf-category.js::checkoutOf` reads the `gitdir:`
 * pointer and `commondir` sidecar but never the back-link — so it lives here.
 */
function isRegisteredCheckout(top, common) {
  const dotGit = path.join(top, ".git");
  const st = fs.lstatSync(dotGit);
  if (st.isDirectory()) return fs.realpathSync(dotGit) === common;
  if (!st.isFile()) return false;
  const gitfile = readBounded(dotGit);
  if (gitfile === null) return false;
  const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(gitfile);
  if (!m) return false;
  const entry = fs.realpathSync(path.resolve(top, m[1]));
  if (path.dirname(entry) !== path.join(common, "worktrees")) return false;
  const backRaw = readBounded(path.join(entry, "gitdir"));
  if (backRaw === null) return false;
  const back = backRaw.trim();
  if (!back) return false;
  return path.resolve(entry, back) === dotGit;
}

/**
 * The edited path as given, made absolute against the REALPATH of the project
 * dir — the side `tree.top` is on — so an aliased project-dir path still lets
 * `rel` be taken from the given name. An absolute path outside the project dir
 * is left as it is.
 */
function givenAbsolute(filePath) {
  const realProject = fs.realpathSync(PROJECT_DIR);
  if (!path.isAbsolute(filePath)) return path.resolve(realProject, filePath);
  const under = path.relative(path.resolve(PROJECT_DIR), filePath);
  if (under && !under.startsWith("..") && !path.isAbsolute(under)) {
    return path.join(realProject, under);
  }
  return path.resolve(filePath);
}

/**
 * DESIGN — MONOTONE IN SCOPE. Let the PRE-LANE rel be
 * `toRepoRelative(filePath, CLAUDE_PROJECT_DIR)` (tail recovery included).
 * The ANCHORED path is the given path with `..` resolved, rebased onto the
 * project dir's realpath, and its DIRECTORY realpath'd — the final component is
 * never resolved, so a symlinked FILE keeps its own name (lexical if the
 * directory will not resolve). The LEXICAL path is the given path with `..`
 * resolved and rebased, no realpath at all. "Under the project dir" means the
 * ANCHORED path OR the LEXICAL path lies under it.
 * CLAIM, per branch: whenever the pre-lane rel is IN scope, the rel this hook
 * judges is in scope too, and the root differs from the project dir ONLY when
 * NEITHER the anchored NOR the lexical path lies under the project dir and the
 * file is inside a REGISTERED checkout of the SAME repository OTHER than the
 * project's own checkout (the one containing the project dir).
 * (a) Under the project dir, STEP 1 runs no git (one directory realpath): if
 * the RAW pre-lane rel is in scope ⇒ the pre-lane pair EXACTLY — same root,
 * same NAME, nothing re-read from the symlink structure (cases 19, 24, 25, 27,
 * 27b, S21, S22, A11; A2 by the PAIR — directory anchoring OR the own-checkout
 * guard, each alone; a `..`, a symlinked DIRECTORY or an alias cannot swap the
 * name); only if it is out of scope AND the anchored path is under the project
 * dir with its rel in scope ⇒ the project dir with the anchored rel (cases 25b,
 * 25c) — a finding the pre-lane hook did not make, never one it made removed.
 * So under the project dir an in-scope pre-lane rel is judged exactly as
 * pre-lane and never reaches step 2. (b) Otherwise STEP 2 may re-root to such a checkout; it
 * returns the pre-lane pair when the accepted checkout IS the project's own —
 * compared against the project's git TOPLEVEL, since the project dir may be a
 * subdirectory of it (re-rooting there only swaps the judged name or manifest:
 * cases A, A-sub, A-sub-plain) — and when the rel it would judge is OUT of
 * scope while the pre-lane rel was in (case 22). A step-2 re-root whose
 * manifest proves unreadable in `main()` also falls back to the pre-lane pair
 * and is judged by the project manifest (case 29). (c) Every refusal or
 * error ⇒ the pre-lane pair. A case-variant spelling of a path in the project's
 * own checkout is refused by exact-string registration and falls back (MEASURED
 * on this disk: git reports the canonical toplevel but the relative common dir
 * resolves against the variant cwd, so the strings differ — case A-sub-case).
 * What it does NOT claim: the same VERDICT —
 * re-rooting a sibling worktree's in-scope path to that worktree's manifest is
 * the fix itself (cases 1, 2, 26, 26r). `givenAbsolute`'s rebasing is now
 * absorbed by the directory realpath wherever the directory resolves
 * (MEASURED: replacing it alone reds nothing; together with lexical anchoring
 * it reds 24b and A11) and is kept for the case where it does not. The
 * `!project`, `!project.common` and `!project.top` guards are absorbed
 * (MEASURED: dropping each alone reds nothing) — a null `project` throws on
 * `.common` into the catch, an absent `common` fails the equality with
 * `tree.common`, and `gitTreeProof` never returns a non-null result without
 * `top`; each fails toward the pre-lane pair.
 * STEP 2 detail: the root is the file's git toplevel ONLY when it is a
 * REGISTERED checkout (`isRegisteredCheckout`) of the project dir's repository
 * (same common dir); `rel` is from the path as given when it lies under that
 * root, else from the realpath; the realpath is always git's cwd.
 * ACCEPTED CONSEQUENCES: every refusal, a path in no repository, a symlink into
 * ANOTHER repository, or any error falls back to `CLAUDE_PROJECT_DIR` and the
 * path as given — the pre-fix behaviour. A symlink in an out-of-scope subtree
 * that points at a rule in the SAME checkout classifies by its given name and
 * stays silent (the pre-lane verdict); pointing into ANOTHER checkout of this
 * repo, it is judged by that checkout (case 19c). Comparisons are exact
 * strings, so a case-variant spelling on a case-insensitive disk falls back —
 * toward firing, never toward silence. A `--separate-git-dir` main checkout or
 * a submodule is refused (its `.git` gitfile names the common dir with NO
 * back-link and NO `core.worktree` — measured, git 2.54.0 — byte-for-byte the
 * planted file case 11 refuses), so the original false positive RETURNS when
 * the project dir is a linked worktree of such a repository. STEP 2 trusts
 * whichever git `resolveGitBinary` finds — including its PATH fallback when no
 * fixed candidate exists (`lib/git-subprocess-env.js:184-209`, PATH walk
 * `:212-226`) — so a planted git earlier on PATH could invent `top`/`common`;
 * that reach is confined to STEP 2 (step 1 runs no git), and registration still
 * reads the claimed checkout's `.git` from the filesystem.
 * Both git calls bypass `lib/event-git.js` on purpose, because neither has a
 * sharer: one runs in the EDITED FILE's directory, which no other detector asks
 * about; the other asks `--show-toplevel --git-common-dir` in ONE call, while
 * `lib/state-resolver.js` asks them separately (`:528`, `:585`), so no cache
 * key could match.
 */
function resolveAuthorityRoot(lib, filePath, realFile) {
  const fallbackRoot = { root: PROJECT_DIR, file: filePath };
  try {
    const proof = require(path.join(__dirname, "lib", "git-checkout-proof.js"));
    const realProject = fs.realpathSync(PROJECT_DIR);
    const given = givenAbsolute(filePath);
    // STEP 1 — under the project dir, judged by the project dir with NO git (one
    // realpath of the edited file's directory is its only disk read). MEMBERSHIP
    // is the ANCHORED path (directory realpath + given final component, so an
    // alias of the project dir lands here: A2, A11, 27b) OR the LEXICAL path (so
    // an in-project DIRECTORY symlink into a sibling still does: S21, S22). The
    // NAME judged is the pre-lane (given) one whenever it is in scope — the
    // pre-lane pair exactly (25, 27) — and the anchored rel only when the given
    // name is out of scope (25b, 25c).
    let anchored = given;
    try {
      anchored = path.join(fs.realpathSync(path.dirname(given)), path.basename(given));
    } catch {
      anchored = given;
    }
    // Under the project dir EITHER by the anchored path OR by the LEXICAL
    // (rebased) given path: an in-project DIRECTORY symlink into a sibling makes
    // the anchored path leave the project while the given name stays in it, and
    // the pre-lane hook judged that given name (cases S21, S22).
    const anchoredUnder = proof.isAtOrUnder(anchored, realProject);
    const rawRel = lib.toRepoRelative(filePath, PROJECT_DIR);
    if (
      rawRel && lib.classifyArtifactPath(rawRel).inScope &&
      (anchoredUnder || proof.isAtOrUnder(given, realProject))
    ) {
      return fallbackRoot;
    }
    if (anchoredUnder) {
      const rel = lib.toRepoRelative(anchored, realProject);
      if (rel && lib.classifyArtifactPath(rel).inScope) return { root: realProject, file: anchored };
    }
    // STEP 2 — only when neither step-1 branch applied: the path is outside the
    // project dir by BOTH its anchored and its lexical form, or its pre-lane rel
    // and anchored rel are both out of scope (e.g. `.claude/worktrees/<wt>/...`).
    if (!realFile) return fallbackRoot;
    const tree = proof.gitTreeProof(path.dirname(realFile));
    if (!tree || !tree.top || !tree.common) return fallbackRoot;
    if (!isRegisteredCheckout(tree.top, tree.common)) return fallbackRoot;
    const project = proof.gitTreeProof(realProject);
    if (!project || !project.common || project.common !== tree.common) return fallbackRoot;
    // Re-rooting onto the project's OWN checkout adds nothing and can only swap
    // the judged NAME or MANIFEST (cases A, A-sub, A-sub-plain) ⇒ keep the
    // pre-lane pair. Compared against the project's git TOPLEVEL, not the project
    // dir, because the project dir may be a subdirectory of its checkout.
    if (!project.top || tree.top === project.top) return fallbackRoot;
    const file = proof.isAtOrUnder(given, tree.top) ? given : realFile;
    // MONOTONE GUARD — step 2 may re-root an in-scope path, never take it OUT of
    // scope: if the pre-lane verdict was in scope and this one is not, keep the
    // pre-lane verdict (case 22).
    const preLaneRel = lib.toRepoRelative(filePath, PROJECT_DIR);
    const chosenRel = lib.toRepoRelative(file, tree.top);
    if (
      preLaneRel && lib.classifyArtifactPath(preLaneRel).inScope &&
      !(chosenRel && lib.classifyArtifactPath(chosenRel).inScope)
    ) {
      return fallbackRoot;
    }
    return { root: tree.top, file, reRooted: true };
  } catch {
    return fallbackRoot;
  }
}

async function main() {
  // `readStdinBounded()` resolves the PARSED payload, NOT raw text — do not
  // JSON.parse its result (the seam that made a sibling hook silently inert).
  let payload;
  try {
    payload = await readStdinBounded();
  } catch {
    return passthrough(null);
  }
  const p = payload && typeof payload === "object" ? payload : {};
  const tool = p.tool_name || p.tool || "";
  // Exactly the matcher this hook is registered under (`Edit|Write`), and no
  // wider. A `MultiEdit` arm stood here and was REMOVED at arming: no matcher
  // group in this repo delivers that tool, so the branch could never fire while
  // reading as enforcement — `hook-matcher-coherence.test.mjs` calls that an
  // UNREACHABLE DISPATCH ARM and reds on it. Widening the accept list here
  // without widening the registration is the same defect in the other
  // direction; both sides move together or neither does.
  if (tool !== "Edit" && tool !== "Write") return passthrough(null);

  const filePath =
    p.tool_input && typeof p.tool_input.file_path === "string"
      ? p.tool_input.file_path
      : "";
  if (!filePath) return passthrough(null);

  // Cheap pre-filter BEFORE any module load or file read: the overwhelming
  // majority of edits are not to `.claude/` artifacts and must cost nothing.
  // Separators are normalized FIRST — a Windows client sends `.claude\rules\x.md`.
  const normalized = filePath.replace(/\\/g, "/");
  if (!normalized.includes("/.claude/") && !normalized.startsWith(".claude/")) {
    return passthrough(null);
  }

  let lib;
  try {
    lib = require(path.join(__dirname, "lib", "artifact-coverage.js"));
  } catch {
    return passthrough(null);
  }

  // Cheap second filter: leave BEFORE spawning git when no root could make the
  // path a prose artifact. Costs one realpath syscall, no subprocess.
  const realFile = realFileOf(filePath);
  if (!anyClaudeTailInScope(lib, [filePath, realFile])) return passthrough(null);

  // The AUTHORITY ROOT is the edited file's own checkout when it belongs to the
  // project dir's repository: a session rooted at the main checkout that edits a
  // linked worktree must read THAT worktree's manifest, or every worktree edit
  // draws a false "no row" (and a worktree artifact the main checkout happens to
  // register draws a false silence). `rel`, all three authorities and the
  // predicate's own relativization share this ONE root.
  let { root, file, reRooted } = resolveAuthorityRoot(lib, filePath, realFile);

  let rel = lib.toRepoRelative(file, root);
  if (!rel || !lib.classifyArtifactPath(rel).inScope) return passthrough(null);

  // ── Authority 1: the eval-manifest. READ-ONLY. An absent or unparseable
  // manifest is an UNKNOWN, not a violation ⇒ fail open — EXCEPT after a STEP-2
  // re-root: the re-rooted sibling's unreadable manifest must not silence what
  // the pre-lane hook judged against the project manifest, so fall back to the
  // pre-lane pair and judge there (case 29). Only the pre-lane manifest's own
  // absence fails open.
  const manifestAt = (r) => readJson(path.join(r, ".claude", "test-harness", "eval-manifest.json"));
  // A re-rooted manifest must also be able to PRODUCE a verdict: one that parses
  // but derives no probe-path shape (`{}`, `[]`, rows without `probes`) makes the
  // lib return [] before any row lookup (lib/artifact-coverage.js:322), which
  // is the same unknown as an unreadable file (case 29b).
  // Row bound: `deriveManifestIndex` is quadratic in distinct suffixes (MEASURED
  // 2026-09-27: 20k rows took 1.4 s), so a planted sibling manifest with ~10^5
  // rows would stall this synchronous step past the host kill. The real manifest
  // has ~95 rows; a re-rooted one over the bound is treated as unable to judge
  // and falls back to the pre-lane pair, toward firing (case 29c).
  const REROOT_MAX_ROWS = 5000;
  const canJudge = (m) => {
    if (!m || typeof m !== "object" || Array.isArray(m)) return false;
    if (Object.keys(m).length > REROOT_MAX_ROWS) return false;
    try {
      const { probeDir, probeSuffix } = lib.deriveManifestIndex(m);
      return Boolean(probeDir && probeSuffix);
    } catch {
      return false;
    }
  };
  let manifest = manifestAt(root);
  if (reRooted && !canJudge(manifest)) {
    root = PROJECT_DIR;
    file = filePath;
    rel = lib.toRepoRelative(file, root);
    if (!rel || !lib.classifyArtifactPath(rel).inScope) return passthrough(null);
    manifest = manifestAt(root);
  }
  if (!manifest || typeof manifest !== "object") return passthrough(null);

  // ── Authority 2: the probe-authorship deferrals registry. Unreadable ⇒ the
  // arm degrades to empty; the manifest's own two declaration arms still stand.
  const deferralsDoc = readJson(
    path.join(root, ".claude", "test-harness", "phase2-deferrals.json"),
  );
  const probeAuthorshipDeferrals =
    deferralsDoc && typeof deferralsDoc.probe_authorship_deferrals === "object"
      ? deferralsDoc.probe_authorship_deferrals
      : {};

  let findings = [];
  try {
    findings = lib.inspectArtifactCoverage({
      filePath: file,
      projectDir: root,
      manifest,
      probeAuthorshipDeferrals,
      // ── Authority 3: the on-disk probe inventory, resolved lazily per
      // candidate path so no directory is enumerated. A thrown existsSync is
      // caught inside the predicate and reads as absent-but-unknown.
      probeInventory: (rp) => fs.existsSync(path.join(root, rp)),
      now: new Date().toISOString(),
    });
  } catch {
    return passthrough(null);
  }
  if (findings.length === 0) return passthrough(null);

  let emit;
  try {
    ({ emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js")));
  } catch {
    return passthrough(
      [
        "⚠ coc-artifact-eval-coverage findings — NOT blocked (renderer unavailable).",
        "",
        renderFindingLines(findings),
      ].join("\n"),
    );
  }

  const ruleIds = [...new Set(findings.map((f) => f.rule_id))];
  if (fallback) clearTimeout(fallback);
  emit({
    hookEvent: "PostToolUse",
    severity: "advisory",
    what_happened:
      `This edit landed and drew ${findings.length} coc-artifact-eval-coverage finding(s):\n` +
      renderFindingLines(findings),
    why:
      "coc-artifact-eval-coverage.md MUST-1 — every COC artifact added or modified in a /codify " +
      "ships the eval coverage its TYPE mandates: a prose artifact (rule / command / skill / " +
      "agent) ships a probe set registered in eval-manifest.json, each mandatory property " +
      "carrying BOTH a violation scenario and a compliant one. MUST-4 additionally requires the " +
      "artifact's Detection block to NAME the binding. This finding is ADVISORY and did not stop " +
      "anything: the coverage may legitimately land later in this same session, so at the instant " +
      "of the edit an absent row is a prediction of a violation, not yet one. The gate that reds " +
      "is coc-eval-all.mjs + registration-preflight.mjs in CI, after the session is over.",
    agent_must_report: [
      "Name the artifact and state where its coverage will land in THIS session.",
      "Register it: an eval-manifest.json row (`type`, `scanner`, `fixturesDir`, `expected`, " +
        "`probes`) plus the probe suite at the path that row names — bipolar pairs, a violation " +
        "pole AND a compliant pole per mandatory property.",
      "If the coverage is legitimately deferred, land the SANCTIONED declaration instead — " +
        "`_deferred_probes` for a suite on disk but unregistered, or " +
        "`probe_authorship_deferrals` for one not yet written — with a real graduation " +
        "condition and a calendar expiry. Silent omission is the gap the rule blocks.",
      "If this edit is a same-codify cross-reference or allowlist-registration edit adding NO new " +
        "load-bearing MUST / MUST NOT / BLOCKED clause, say so in one line — MUST-1's plumbing " +
        "carve-out covers it and that stated line is the record for this tier.",
    ],
    agent_must_wait:
      "Land the coverage, land the sanctioned declaration, or state the plumbing carve-out — this is not a block.",
    user_summary: `coc-artifact-eval-coverage — ${ruleIds.join(", ")} on an artifact edit (not blocked)`,
  });
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). Everything a standalone run
// did at load time happens here instead, so a require() has no side effects.
function hookMain() {
  fallback = setTimeout(() => passthrough(null), TIMEOUT_MS);
  if (typeof fallback.unref === "function") fallback.unref();
  return main().catch(() => passthrough(null));
}

module.exports = { hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
